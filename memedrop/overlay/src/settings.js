// settings.js — renderer logic for the settings window
const $ = (sel) => document.querySelector(sel);

const pill         = $('#conn-pill');
const pillLabel    = pill.querySelector('.label');
const pairingCard  = $('#pairing-card');
const linkedCard   = $('#linked-card');
const serversCard  = $('#servers-card');
const pairingCode  = $('#pairing-code');
const linkedUser   = $('#linked-user');
const serverList   = $('#server-list');
const serversTitle = $('#servers-title');
const serversHint  = $('#servers-hint');
const serversTip   = $('#servers-tip');

// Update card
const updateCard       = $('#update-card');
const updateEyebrow    = $('#update-eyebrow');
const updateTitle      = $('#update-title');
const updateMsg        = $('#update-msg');
const updateProgress   = $('#update-progress');
const updateProgressFill = $('#update-progress-fill');
const updateCheckBtn   = $('#update-check-btn');
const updateDownloadBtn= $('#update-download-btn');
const updateInstallBtn = $('#update-install-btn');

let lastConnState = null;

function renderServersPanel(links) {
  serverList.innerHTML = '';

  if (!links || links.scope === 'none') {
    serversCard.classList.add('hidden');
    return;
  }

  serversCard.classList.remove('hidden');

  if (links.scope === 'global') {
    serversTitle.textContent = 'Reachable everywhere';
    serversHint.innerHTML = 'Your link uses the legacy <strong>global</strong> mode — any server the bot is in can drop memes on you.';
    serversTip.innerHTML = 'To switch to per-server mode, use <code>/unlink</code> on Discord, then <code>/link &lt;code&gt;</code> on each server where you want to be reachable.';

    const row = document.createElement('div');
    row.className = 'server-row legacy';
    row.innerHTML = `
      <div class="server-row-pic legacy-pic">∞</div>
      <div class="server-row-name">
        <strong>All servers</strong>
        <div class="server-row-sub">Legacy global link</div>
      </div>
    `;
    serverList.appendChild(row);
    return;
  }

  // Per-guild mode — show current servers + tip showing the add-server code
  serversTitle.textContent = 'Allowed sources';
  serversHint.textContent  = 'Toggle off any server you don\'t want to receive drops from.';

  // Show the current pairing code (kept alive by the bot for adding new guilds)
  const code = lastConnState?.code;
  if (code) {
    serversTip.innerHTML = `To add another server, run <code>/link ${code}</code> on it.`;
  } else {
    serversTip.innerHTML = 'To add another server, run <code>/link &lt;code&gt;</code> on it.';
  }

  if (!links.guilds || links.guilds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'server-empty';
    empty.textContent = 'No servers yet. Use /link on a Discord server to add it.';
    serverList.appendChild(empty);
    return;
  }

  for (const g of links.guilds) {
    const row = document.createElement('div');
    row.className = 'server-row';
    row.dataset.guildId = g.id;

    const pic = document.createElement('div');
    pic.className = 'server-row-pic';
    if (g.icon) {
      const img = document.createElement('img');
      img.src = g.icon;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      pic.appendChild(img);
    } else {
      pic.textContent = (g.name || '?').trim().charAt(0).toUpperCase() || '?';
      pic.classList.add('initial');
    }

    const name = document.createElement('div');
    name.className = 'server-row-name';
    name.innerHTML = `
      <strong></strong>
      <div class="server-row-sub">ID ${g.id}</div>
    `;
    name.querySelector('strong').textContent = g.name || 'Unknown server';

    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = g.enabled !== false;
    sw.title = sw.checked ? 'Click to disable this server' : '';
    sw.addEventListener('change', async () => {
      if (!sw.checked) {
        const ok = confirm(`Disable drops from "${g.name}"? You can re-add it by running /link on that server again.`);
        if (!ok) { sw.checked = true; return; }
        await window.memedrop.unlinkGuild(g.id);
      }
    });

    row.appendChild(pic);
    row.appendChild(name);
    row.appendChild(sw);
    serverList.appendChild(row);
  }
}

function applyConnState(state) {
  lastConnState = state;
  pill.className = 'pill';
  pairingCard.classList.add('hidden');
  linkedCard.classList.add('hidden');
  serversCard.classList.add('hidden');

  switch (state.status) {
    case 'connecting':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connecting';
      break;
    case 'awaiting_link':
      pill.classList.add('pill--awaiting');
      pillLabel.textContent = 'awaiting link';
      pairingCard.classList.remove('hidden');
      pairingCode.textContent = state.code || '------';
      break;
    case 'linked':
      pill.classList.add('pill--linked');
      pillLabel.textContent = 'linked';
      linkedCard.classList.remove('hidden');
      linkedUser.textContent = state.user?.username || '—';
      renderServersPanel(state.links);
      break;
    case 'connected':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connected';
      break;
    case 'disconnected':
    default:
      pill.classList.add('pill--down');
      pillLabel.textContent = 'offline';
      break;
  }
}

window.memedrop.onConnection(applyConnState);
window.memedrop.getConnection().then(applyConnState);

// ── Update card ────────────────────────────────────────────────────────────
function applyUpdateState(state) {
  // Reset visibility of action buttons + progress
  updateCheckBtn.classList.add('hidden');
  updateDownloadBtn.classList.add('hidden');
  updateInstallBtn.classList.add('hidden');
  updateProgress.classList.add('hidden');

  switch (state.status) {
    case 'idle':
      updateCard.classList.add('hidden');
      break;
    case 'checking':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'update';
      updateTitle.textContent = 'Vérification…';
      updateMsg.textContent = 'Recherche de nouvelles versions sur GitHub.';
      break;
    case 'up-to-date':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'à jour';
      updateTitle.textContent = 'Vous êtes à jour ✓';
      updateMsg.textContent = 'MemeDrop est dans sa dernière version.';
      updateCheckBtn.classList.remove('hidden');
      // Auto-hide after 4 seconds
      setTimeout(() => { if (updateCard.dataset.lastStatus === 'up-to-date') updateCard.classList.add('hidden'); }, 4000);
      break;
    case 'available':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'nouveauté';
      updateTitle.textContent = `Mise à jour disponible — v${state.version}`;
      updateMsg.textContent = 'Cliquez pour la télécharger maintenant.';
      updateDownloadBtn.classList.remove('hidden');
      break;
    case 'downloading':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'téléchargement';
      updateTitle.textContent = `Téléchargement…`;
      updateMsg.textContent = `${state.progress ?? 0}% — restez tranquille, ça arrive`;
      updateProgress.classList.remove('hidden');
      updateProgressFill.style.width = `${state.progress ?? 0}%`;
      break;
    case 'downloaded':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'prêt';
      updateTitle.textContent = `v${state.version} prête à installer`;
      updateMsg.textContent = 'Cliquez pour installer et redémarrer MemeDrop.';
      updateInstallBtn.classList.remove('hidden');
      break;
    case 'error':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'erreur';
      updateTitle.textContent = 'Mise à jour impossible';
      updateMsg.textContent = state.error || 'Réessayez plus tard.';
      updateCheckBtn.classList.remove('hidden');
      break;
    case 'dev-mode':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'dev';
      updateTitle.textContent = 'Mode développement';
      updateMsg.textContent = 'L\'auto-update ne fonctionne que dans la version packagée.';
      updateCheckBtn.classList.remove('hidden');
      setTimeout(() => updateCard.classList.add('hidden'), 4000);
      break;
  }
  updateCard.dataset.lastStatus = state.status;
}

window.memedrop.onUpdateState(applyUpdateState);
window.memedrop.getUpdateState().then(applyUpdateState);

updateCheckBtn.addEventListener('click', () => window.memedrop.checkForUpdate());
updateDownloadBtn.addEventListener('click', () => window.memedrop.downloadUpdate());
updateInstallBtn.addEventListener('click', () => window.memedrop.installUpdate());

// ── Pairing code copy ───────────────────────────────────────────────────────
$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent);
    const btn = $('#copy-code');
    const original = btn.textContent;
    btn.textContent = 'copied ✓';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch {}
});

$('#reconnect-btn').addEventListener('click', () => window.memedrop.reconnect());
$('#test-btn').addEventListener('click', () => window.memedrop.testDrop());

// ── Debounced settings writer ──────────────────────────────────────────────
//
// IMPORTANT: `patch = _pending` previously created a shared reference, then
// clearing `_pending` also wiped `patch` before it was sent. That meant every
// slider move was sending an empty object to the store — sliders moved on
// screen but nothing was ever persisted. We now copy the pending dict into a
// fresh object before clearing.
const _pending = {};
let _flushTimer = null;
function queueSetting(key, value) {
  _pending[key] = value;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    const patch = { ..._pending };          // copy, don't share reference
    Object.keys(_pending).forEach(k => delete _pending[k]);
    _flushTimer = null;
    window.memedrop.setSettings(patch);
  }, 150);
}

function bindRange(id, outId, fmt, key, scale = 1) {
  const input = document.getElementById(id);
  const out   = document.getElementById(outId);
  input.addEventListener('input', () => {
    out.textContent = fmt(input.value);
    input.style.setProperty('--value', `${(input.value - input.min) * 100 / (input.max - input.min)}%`);
    queueSetting(key, Number(input.value) / scale);
  });
}

bindRange('volume',         'volume-out',         v => `${v}%`, 'volume',        100);
bindRange('music-volume',   'music-volume-out',   v => `${v}%`, 'musicVolume',   100);
bindRange('opacity',        'opacity-out',        v => `${v}%`, 'opacity',       100);
bindRange('duration',       'duration-out',       v => `${v}s`, 'duration',      1);
bindRange('video-duration', 'video-duration-out', v => `${v}s`, 'videoDuration', 1);

$('#sound').addEventListener('change', (e) => queueSetting('soundOnArrival', e.target.checked));
$('#autostart').addEventListener('change', (e) => queueSetting('autostart', e.target.checked));
$('#server').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  queueSetting('serverUrl', v);
});
$('#display').addEventListener('change', (e) => {
  const id = e.target.value === 'primary' ? null : Number(e.target.value);
  queueSetting('overlayDisplayId', id);
});

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const s = await window.memedrop.getSettings();

  const volEl = $('#volume');
  volEl.value = Math.round((s.volume ?? .75) * 100);
  $('#volume-out').textContent = `${volEl.value}%`;
  volEl.style.setProperty('--value', `${volEl.value}%`);

  const musicVolEl = $('#music-volume');
  musicVolEl.value = Math.round((s.musicVolume ?? .75) * 100);
  $('#music-volume-out').textContent = `${musicVolEl.value}%`;
  musicVolEl.style.setProperty('--value', `${musicVolEl.value}%`);

  const opEl = $('#opacity');
  opEl.value = Math.round((s.opacity ?? 1) * 100);
  $('#opacity-out').textContent = `${opEl.value}%`;
  opEl.style.setProperty('--value', `${opEl.value}%`);

  const durEl = $('#duration');
  durEl.value = s.duration ?? 4;
  $('#duration-out').textContent = `${durEl.value}s`;
  durEl.style.setProperty('--value', `${(durEl.value - 1) * 100 / 29}%`);

  const vidDurEl = $('#video-duration');
  vidDurEl.value = s.videoDuration ?? 30;
  $('#video-duration-out').textContent = `${vidDurEl.value}s`;
  vidDurEl.style.setProperty('--value', `${(vidDurEl.value - 1) * 100 / 29}%`);

  $('#sound').checked     = !!s.soundOnArrival;
  $('#autostart').checked = !!s.autostart;
  $('#server').value      = s.serverUrl || 'wss://memedrop-production-3106.up.railway.app';

  const displays = await window.memedrop.listDisplays();
  const sel = $('#display');
  sel.innerHTML = '';
  const primOpt = document.createElement('option');
  primOpt.value = 'primary';
  primOpt.textContent = '◇  Primary display (auto)';
  sel.appendChild(primOpt);
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = `${d.primary ? '★' : '·'}  ${d.label} — ${d.bounds.width}×${d.bounds.height}`;
    sel.appendChild(o);
  }
  sel.value = s.overlayDisplayId == null ? 'primary' : String(s.overlayDisplayId);

  // Show real app version in footer
  try {
    const v = await window.memedrop.getVersion();
    $('#app-version').textContent = `v${v}`;
  } catch {}
}
init();

$('#open-discord').addEventListener('click', (e) => {
  e.preventDefault();
  window.memedrop.openExternal('https://github.com/Billalbzn/memedrop');
});
