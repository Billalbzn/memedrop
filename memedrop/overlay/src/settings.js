// settings.js — logique de la fenêtre de réglages
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

// Tranquillité / connexion / bloqués / historique
const connectionToggle = $('#connection-toggle');
const muteStatus   = $('#mute-status');
const mute30Btn    = $('#mute-30');
const mute120Btn   = $('#mute-120');
const muteForeverBtn = $('#mute-forever');
const muteOffBtn  = $('#mute-off');
const blockedCard = $('#blocked-card');
const blockedList = $('#blocked-list');
const historyList  = $('#history-list');
const historyEmpty = $('#history-empty');
const historyClearBtn = $('#history-clear');

// Carte mise à jour
const updateCard         = $('#update-card');
const updateEyebrow      = $('#update-eyebrow');
const updateTitle        = $('#update-title');
const updateMsg          = $('#update-msg');
const updateProgress     = $('#update-progress');
const updateProgressFill = $('#update-progress-fill');
const updateCheckBtn     = $('#update-check-btn');
const updateDownloadBtn  = $('#update-download-btn');
const updateInstallBtn   = $('#update-install-btn');

let lastConnState = null;

// ── Panel serveurs liés ────────────────────────────────────────────────
function renderServersPanel(links) {
  serverList.innerHTML = '';

  if (!links || links.scope === 'none') {
    serversCard.classList.add('hidden');
    return;
  }

  serversCard.classList.remove('hidden');

  if (links.scope === 'global') {
    serversTitle.textContent = 'Accessible partout';
    serversHint.innerHTML    = 'Ton lien utilise le mode <strong>global</strong> (ancienne version) — n\'importe quel serveur où le bot est présent peut t\'envoyer des drops.';
    serversTip.innerHTML     = 'Pour passer en mode par serveur, utilise <code>/unlink</code> sur Discord, puis <code>/link &lt;code&gt;</code> sur chaque serveur de ton choix.';

    const row = document.createElement('div');
    row.className = 'server-row legacy';
    row.innerHTML = `
      <div class="server-row-pic legacy-pic">∞</div>
      <div class="server-row-name">
        <strong>Tous les serveurs</strong>
        <div class="server-row-sub">Lien global (ancien mode)</div>
      </div>
    `;
    serverList.appendChild(row);
    return;
  }

  // Mode par serveur
  serversTitle.textContent = 'Sources autorisées';
  serversHint.textContent  = 'Désactive un serveur dont tu ne veux plus recevoir de drops.';

  const code = lastConnState?.code;
  if (code) {
    serversTip.innerHTML = `Pour ajouter un serveur, tape <code>/link ${code}</code> dessus.`;
  } else {
    serversTip.innerHTML = 'Pour ajouter un serveur, tape <code>/link &lt;code&gt;</code> dessus.';
  }

  if (!links.guilds || links.guilds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'server-empty';
    empty.textContent = 'Aucun serveur. Utilise /link sur Discord pour en ajouter un.';
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
    name.querySelector('strong').textContent = g.name || 'Serveur inconnu';

    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = g.enabled !== false;
    sw.title = sw.checked ? 'Cliquer pour désactiver ce serveur' : '';
    sw.addEventListener('change', async () => {
      if (!sw.checked) {
        const ok = confirm(`Désactiver les drops venant de « ${g.name} » ? Tu pourras le réactiver en tapant /link sur ce serveur.`);
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

// ── Panel utilisateurs bloqués ──────────────────────────────────────────
function renderBlockedPanel(blocked) {
  blockedList.innerHTML = '';
  if (!blocked || blocked.length === 0) {
    blockedCard.classList.add('hidden');
    return;
  }
  blockedCard.classList.remove('hidden');

  for (const b of blocked) {
    const row = document.createElement('div');
    row.className = 'server-row';

    const pic = document.createElement('div');
    pic.className = 'server-row-pic initial';
    pic.textContent = (b.username || '?').trim().charAt(0).toUpperCase() || '?';

    const name = document.createElement('div');
    name.className = 'server-row-name';
    name.innerHTML = `<strong></strong><div class="server-row-sub">ID ${b.id}</div>`;
    name.querySelector('strong').textContent = b.username || 'Inconnu';

    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = 'débloquer';
    btn.addEventListener('click', async () => {
      await window.memedrop.unblockUser(b.id);
    });

    row.appendChild(pic);
    row.appendChild(name);
    row.appendChild(btn);
    blockedList.appendChild(row);
  }
}

// ── Mode tranquille ──────────────────────────────────────────────────────
function applyMuteState(muteUntil) {
  const muted = muteUntil && (muteUntil === -1 || muteUntil > Date.now());
  pill.classList.remove('pill--muted');
  [mute30Btn, mute120Btn, muteForeverBtn].forEach(b => b.classList.toggle('hidden', !!muted));
  muteOffBtn.classList.toggle('hidden', !muted);

  if (!muted) {
    muteStatus.textContent = 'Les drops s\'affichent normalement sur ton écran.';
    return;
  }
  pill.classList.add('pill--muted');
  if (muteUntil === -1) {
    muteStatus.textContent = '🔇 Mode tranquille activé — jusqu\'à ce que tu le désactives.';
  } else {
    const mins = Math.max(1, Math.round((muteUntil - Date.now()) / 60000));
    muteStatus.textContent = `🔇 Mode tranquille activé — encore ~${mins} min.`;
  }
}

mute30Btn.addEventListener('click', async () => applyMuteState(await window.memedrop.setMute(30)));
mute120Btn.addEventListener('click', async () => applyMuteState(await window.memedrop.setMute(120)));
muteForeverBtn.addEventListener('click', async () => applyMuteState(await window.memedrop.setMute(-1)));
muteOffBtn.addEventListener('click', async () => applyMuteState(await window.memedrop.setMute(null)));

// Rafraîchit le compte à rebours pendant qu'un mute temporisé est actif
setInterval(() => {
  if (lastConnState?.muteUntil && lastConnState.muteUntil !== -1) applyMuteState(lastConnState.muteUntil);
}, 30_000);

// ── Pause de connexion ───────────────────────────────────────────────────
connectionToggle.addEventListener('change', (e) => {
  window.memedrop.setSettings({ paused: !e.target.checked });
});

// ── Historique des drops ──────────────────────────────────────────────────
const HISTORY_KIND_ICON = { image: '🖼️', gif: '🎞️', video: '🎬', audio: '🎵', rain: '🌧️', test: '🧪', unknown: '❓' };

function renderHistory(history) {
  historyList.innerHTML = '';
  if (!history || history.length === 0) {
    historyEmpty.classList.remove('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');

  for (const h of history) {
    const row = document.createElement('div');
    row.className = 'server-row';

    const pic = document.createElement('div');
    pic.className = 'server-row-pic initial';
    pic.textContent = HISTORY_KIND_ICON[h.kind] || '❓';

    const name = document.createElement('div');
    name.className = 'server-row-name';
    const when = new Date(h.ts);
    const time = when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    name.innerHTML = `<strong></strong><div class="server-row-sub"></div>`;
    name.querySelector('strong').textContent = h.from;
    name.querySelector('.server-row-sub').textContent = h.caption ? `"${h.caption}" — ${time}` : time;

    row.appendChild(pic);
    row.appendChild(name);
    historyList.appendChild(row);
  }
}

window.memedrop.onHistory(renderHistory);
window.memedrop.getHistory().then(renderHistory);
historyClearBtn.addEventListener('click', async () => {
  await window.memedrop.clearHistory();
  renderHistory([]);
});

// ── État de connexion ──────────────────────────────────────────────────
function applyConnState(state) {
  lastConnState = state;
  pill.className = 'pill';
  pairingCard.classList.add('hidden');
  linkedCard.classList.add('hidden');
  serversCard.classList.add('hidden');

  switch (state.status) {
    case 'connecting':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connexion…';
      break;
    case 'awaiting_link':
      pill.classList.add('pill--awaiting');
      pillLabel.textContent = 'en attente';
      pairingCard.classList.remove('hidden');
      pairingCode.textContent = state.code || '------';
      break;
    case 'linked':
      pill.classList.add('pill--linked');
      pillLabel.textContent = 'connecté';
      linkedCard.classList.remove('hidden');
      linkedUser.textContent = state.user?.username || '—';
      renderServersPanel(state.links);
      renderBlockedPanel(state.links?.blocked);
      break;
    case 'connected':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connecté';
      break;
    case 'paused':
      pill.classList.add('pill--paused');
      pillLabel.textContent = 'en pause';
      break;
    case 'disconnected':
    default:
      pill.classList.add('pill--down');
      pillLabel.textContent = 'hors ligne';
      break;
  }

  connectionToggle.checked = state.status !== 'paused';
  applyMuteState(state.muteUntil);
}

window.memedrop.onConnection(applyConnState);
window.memedrop.getConnection().then(applyConnState);

// ── Carte mise à jour ──────────────────────────────────────────────────
function applyUpdateState(state) {
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
      updateEyebrow.textContent = 'mise à jour';
      updateTitle.textContent   = 'Vérification…';
      updateMsg.textContent     = 'Recherche de nouvelles versions sur GitHub.';
      break;
    case 'up-to-date':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'à jour';
      updateTitle.textContent   = 'Tout est à jour ✓';
      updateMsg.textContent     = 'MemeDrop est dans sa dernière version.';
      updateCheckBtn.classList.remove('hidden');
      setTimeout(() => {
        if (updateCard.dataset.lastStatus === 'up-to-date') updateCard.classList.add('hidden');
      }, 4000);
      break;
    case 'available':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'nouveauté';
      updateTitle.textContent   = `Mise à jour disponible — v${state.version}`;
      updateMsg.textContent     = 'Clique pour la télécharger maintenant.';
      updateDownloadBtn.classList.remove('hidden');
      break;
    case 'downloading':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'téléchargement';
      updateTitle.textContent   = 'Téléchargement…';
      updateMsg.textContent     = `${state.progress ?? 0}% — reste tranquille, ça arrive`;
      updateProgress.classList.remove('hidden');
      updateProgressFill.style.width = `${state.progress ?? 0}%`;
      break;
    case 'downloaded':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'prêt';
      updateTitle.textContent   = `v${state.version} prête à installer`;
      updateMsg.textContent     = 'Clique pour installer et relancer MemeDrop.';
      updateInstallBtn.classList.remove('hidden');
      break;
    case 'error':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'erreur';
      updateTitle.textContent   = 'Mise à jour impossible';
      updateMsg.textContent     = state.error || 'Réessaie plus tard.';
      updateCheckBtn.classList.remove('hidden');
      break;
    case 'dev-mode':
      updateCard.classList.remove('hidden');
      updateEyebrow.textContent = 'dev';
      updateTitle.textContent   = 'Mode développement';
      updateMsg.textContent     = 'L\'auto-update ne fonctionne que dans la version packagée.';
      updateCheckBtn.classList.remove('hidden');
      setTimeout(() => updateCard.classList.add('hidden'), 4000);
      break;
  }
  updateCard.dataset.lastStatus = state.status;
}

window.memedrop.onUpdateState(applyUpdateState);
window.memedrop.getUpdateState().then(applyUpdateState);

updateCheckBtn.addEventListener('click',    () => window.memedrop.checkForUpdate());
updateDownloadBtn.addEventListener('click', () => window.memedrop.downloadUpdate());
updateInstallBtn.addEventListener('click',  () => window.memedrop.installUpdate());

// ── Copier le code d'appairage ─────────────────────────────────────────
$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent);
    const btn = $('#copy-code');
    const original = btn.innerHTML;
    btn.textContent = 'copié ✓';
    setTimeout(() => { btn.innerHTML = original; }, 1200);
  } catch {}
});

$('#reconnect-btn').addEventListener('click', () => window.memedrop.reconnect());
$('#test-btn').addEventListener('click',      () => window.memedrop.testDrop());

// ── Écriture des réglages (debounce) ───────────────────────────────────
//
// On copie `_pending` dans un objet séparé avant de le vider pour éviter
// que la référence partagée ne s'efface avant l'envoi.
const _pending = {};
let _flushTimer = null;

function queueSetting(key, value) {
  _pending[key] = value;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    const patch = { ..._pending };
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
bindRange('opacity',        'opacity-out',         v => `${v}%`, 'opacity',       100);
bindRange('duration',       'duration-out',        v => `${v}s`, 'duration',      1);
bindRange('video-duration', 'video-duration-out',  v => `${v}s`, 'videoDuration', 1);

$('#sound').addEventListener('change',      (e) => queueSetting('soundOnArrival', e.target.checked));
$('#spotlight').addEventListener('change', (e) => queueSetting('spotlightOnDrop', e.target.checked));
$('#theme').addEventListener('change',     (e) => queueSetting('theme', e.target.value));
$('#autostart').addEventListener('change', (e) => queueSetting('autostart', e.target.checked));
$('#server').addEventListener('change',    (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  queueSetting('serverUrl', v);
});
$('#display').addEventListener('change',   (e) => {
  const id = e.target.value === 'primary' ? null : Number(e.target.value);
  queueSetting('overlayDisplayId', id);
});

// ── Initialisation ─────────────────────────────────────────────────────
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

  $('#sound').checked      = !!s.soundOnArrival;
  $('#spotlight').checked  = s.spotlightOnDrop !== false; // true par défaut
  $('#theme').value        = s.theme || 'classic';
  $('#autostart').checked  = !!s.autostart;
  $('#server').value      = s.serverUrl || 'wss://memedrop-production-3106.up.railway.app';

  const displays = await window.memedrop.listDisplays();
  const sel = $('#display');
  sel.innerHTML = '';
  const primOpt = document.createElement('option');
  primOpt.value = 'primary';
  primOpt.textContent = '◇  Écran principal (auto)';
  sel.appendChild(primOpt);
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = `${d.primary ? '★' : '·'}  ${d.label} — ${d.bounds.width}×${d.bounds.height}`;
    sel.appendChild(o);
  }
  sel.value = s.overlayDisplayId == null ? 'primary' : String(s.overlayDisplayId);

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
