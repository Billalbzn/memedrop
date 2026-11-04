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

// localStorage peut être indisponible/effacé : chaque accès est protégé.
function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

// ── Onglets ────────────────────────────────────────────────────────────
const tabs   = [...document.querySelectorAll('.tab')];
const panels = [...document.querySelectorAll('.tab-panel')];
let currentTab = 'home';

function showTab(name) {
  if (!panels.some(p => p.dataset.panel === name)) name = 'home';
  currentTab = name;
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const p of panels) p.classList.toggle('active', p.dataset.panel === name);
  lsSet('memedrop.tab', name);
  if (name === 'history') markHistorySeen();
  window.scrollTo({ top: 0 });
}
for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

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
let quietActive = false;
const quietNow = $('#quiet-now');

function applyMuteState(muteUntil) {
  const muted = muteUntil && (muteUntil === -1 || muteUntil > Date.now());
  pill.classList.toggle('pill--muted', !!muted || quietActive);
  [mute30Btn, mute120Btn, muteForeverBtn].forEach(b => b.classList.toggle('hidden', !!muted));
  muteOffBtn.classList.toggle('hidden', !muted);
  muteStatus.classList.toggle('is-muted', !!muted);
  quietNow.classList.toggle('hidden', !quietActive);

  if (!muted) {
    muteStatus.textContent = 'Les drops s\'affichent normalement sur ton écran.';
    return;
  }
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

// Rafraîchit le compte à rebours du mute temporisé et l'état des heures calmes
async function refreshQuietHours() {
  try { quietActive = !!(await window.memedrop.isQuietHoursActive()); } catch { quietActive = false; }
  applyMuteState(lastConnState?.muteUntil ?? null);
}
setInterval(refreshQuietHours, 30_000);

// ── Pause de connexion ───────────────────────────────────────────────────
connectionToggle.addEventListener('change', (e) => {
  window.memedrop.setSettings({ paused: !e.target.checked });
});

// ── Historique des drops ──────────────────────────────────────────────────
// Liste complète (onglet dédié), groupée par jour, avec l'avatar de
// l'expéditeur. Un badge sur l'onglet compte les drops pas encore vus.
const HISTORY_KIND_ICON = { image: '🖼️', gif: '🎞️', video: '🎬', audio: '🎵', rain: '🌧️', tts: '🗣️', test: '🧪', unknown: '❓' };
const historyBadge = $('#history-badge');
const lastDropBox  = $('#last-drop');
const lastDropText = $('#last-drop-text');
let historyEntries = [];

function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.round(diff / 60_000);
  if (min < 1)  return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24)   return `il y a ${h} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86_400_000);
  if (days === 0) return 'aujourd\'hui';
  if (days === 1) return 'hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function describeDrop(h) {
  if (h.caption) return `« ${h.caption} »`;
  if (h.tts) return `🗣️ ${h.tts}`;
  if (h.rain) return `pluie ${[].concat(h.rain).join('')}`;
  return { image: 'une image', gif: 'un GIF', video: 'une vidéo', audio: 'un son', test: 'drop de test' }[h.kind] || 'un drop';
}

function markHistorySeen() {
  if (historyEntries[0]) lsSet('memedrop.historySeen', historyEntries[0].ts);
  updateHistoryBadge();
}

function updateHistoryBadge() {
  const seen = Number(lsGet('memedrop.historySeen', 0)) || 0;
  const unseen = historyEntries.filter(h => h.ts > seen).length;
  historyBadge.textContent = unseen > 9 ? '9+' : String(unseen);
  historyBadge.classList.toggle('hidden', unseen === 0 || currentTab === 'history');
}

function renderHistory(history) {
  historyEntries = history || [];
  historyList.innerHTML = '';

  // Résumé "dernier drop" sur la carte de l'accueil
  const last = historyEntries[0];
  lastDropBox.classList.toggle('hidden', !last);
  if (last) lastDropText.textContent = `${last.from} · ${describeDrop(last)} · ${relativeTime(last.ts)}`;

  if (currentTab === 'history') markHistorySeen(); else updateHistoryBadge();

  historyEmpty.classList.toggle('hidden', historyEntries.length > 0);
  historyClearBtn.classList.toggle('hidden', historyEntries.length === 0);

  let lastDay = null;
  for (const h of historyEntries) {
    const day = dayLabel(h.ts);
    if (day !== lastDay) {
      lastDay = day;
      const g = document.createElement('div');
      g.className = 'history-group';
      g.textContent = day;
      historyList.appendChild(g);
    }

    const row = document.createElement('div');
    row.className = 'server-row';

    const pic = document.createElement('div');
    pic.className = 'server-row-pic history-pic';
    if (h.avatar && /^https:\/\/cdn\.discordapp\.com\//.test(h.avatar)) {
      const img = document.createElement('img');
      img.src = h.avatar;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); pic.prepend((h.from || '?').charAt(0).toUpperCase()); });
      pic.appendChild(img);
    } else {
      pic.textContent = (h.from || '?').trim().charAt(0).toUpperCase() || '?';
    }
    const kind = document.createElement('span');
    kind.className = 'history-kind';
    kind.textContent = HISTORY_KIND_ICON[h.kind] || '❓';
    pic.appendChild(kind);

    const name = document.createElement('div');
    name.className = 'server-row-name';
    const time = new Date(h.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    name.innerHTML = `<strong></strong><div class="server-row-sub"></div>`;
    name.querySelector('strong').textContent = h.from;
    name.querySelector('.server-row-sub').textContent = `${time} · ${describeDrop(h)}`;
    name.title = describeDrop(h);

    row.appendChild(pic);
    row.appendChild(name);

    // "revoir" — rejoue le drop sur l'overlay (les URLs Discord expirent
    // après ~24 h, le bouton peut donc ne rien afficher sur un vieux drop).
    if (h.media || h.rain || h.tts) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'revoir';
      btn.addEventListener('click', () => window.memedrop.replayDrop(h.ts));
      row.appendChild(btn);
    }

    historyList.appendChild(row);
  }
}

window.memedrop.onHistory(renderHistory);
window.memedrop.getHistory().then(renderHistory);
historyClearBtn.addEventListener('click', async () => {
  if (!confirm('Vider tout l\'historique des drops reçus ?')) return;
  await window.memedrop.clearHistory();
  renderHistory([]);
});
// Les "il y a X min" vieillissent : on rafraîchit l'affichage chaque minute
setInterval(() => renderHistory(historyEntries), 60_000);

// ── État de connexion ──────────────────────────────────────────────────
const statusCard  = $('#status-card');
const statusIcon  = $('#status-icon');
const statusTitle = $('#status-title');
const statusMsg   = $('#status-msg');
const statusResumeBtn = $('#status-resume-btn');
const statusRetryBtn  = $('#status-retry-btn');

function showStatusCard(kind, icon, title, msg) {
  statusCard.classList.remove('hidden', 'is-down', 'is-paused', 'is-connecting');
  statusCard.classList.add(`is-${kind}`);
  statusIcon.textContent  = icon;
  statusTitle.textContent = title;
  statusMsg.textContent   = msg;
  statusResumeBtn.classList.toggle('hidden', kind !== 'paused');
  statusRetryBtn.classList.toggle('hidden', kind !== 'down');
}

statusResumeBtn.addEventListener('click', () => window.memedrop.setSettings({ paused: false }));
statusRetryBtn.addEventListener('click',  () => window.memedrop.reconnect());

function applyConnState(state) {
  lastConnState = state;
  pill.className = 'pill';
  pairingCard.classList.add('hidden');
  linkedCard.classList.add('hidden');
  serversCard.classList.add('hidden');
  statusCard.classList.add('hidden');

  switch (state.status) {
    case 'connecting':
      pill.classList.add('pill--connecting');
      pillLabel.textContent = 'connexion…';
      showStatusCard('connecting', '📡', 'Connexion au bot…', 'Ça ne devrait prendre que quelques secondes.');
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
      showStatusCard('paused', '⏸️', 'Connexion en pause',
        'Personne ne peut t\'envoyer de drop tant que la connexion est coupée.');
      break;
    case 'disconnected':
    default:
      pill.classList.add('pill--down');
      pillLabel.textContent = 'hors ligne';
      showStatusCard('down', '🔌', 'Bot injoignable',
        'Nouvelle tentative automatique en cours. Vérifie ta connexion internet ou l\'URL du serveur dans les réglages.');
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
const copyBtn = $('#copy-code');
const copyBtnHtml = copyBtn.innerHTML;   // capturé une fois : un double-clic ne l'écrase plus
let copyTimer = null;
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`/link ${pairingCode.textContent}`);
    copyBtn.textContent = 'copié ✓ — colle-le sur Discord';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyBtn.innerHTML = copyBtnHtml; }, 1600);
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

// ── Heures calmes ──────────────────────────────────────────────────────
const qhToggle = $('#quiet-hours');
const qhStart  = $('#quiet-start');
const qhEnd    = $('#quiet-end');

function pushQuietHours() {
  queueSetting('quietHours', {
    enabled: qhToggle.checked,
    start: qhStart.value || '22:00',
    end:   qhEnd.value   || '08:00',
  });
}
// Après enregistrement (debounce 150 ms), on relit l'état "heures calmes en cours"
function onQuietHoursChange() {
  pushQuietHours();
  setTimeout(refreshQuietHours, 400);
}
qhToggle.addEventListener('change', onQuietHoursChange);
qhStart.addEventListener('change', onQuietHoursChange);
qhEnd.addEventListener('change', onQuietHoursChange);

$('#avoid-zone').addEventListener('change', (e) => queueSetting('avoidZone', e.target.value));

$('#sound').addEventListener('change',      (e) => queueSetting('soundOnArrival', e.target.checked));
$('#spotlight').addEventListener('change', (e) => queueSetting('spotlightOnDrop', e.target.checked));
$('#theme').addEventListener('change',     (e) => queueSetting('theme', e.target.value));
$('#autostart').addEventListener('change', (e) => queueSetting('autostart', e.target.checked));
const serverInput = $('#server');
const serverError = $('#server-error');
serverInput.addEventListener('input', () => {
  serverInput.classList.remove('invalid');
  serverError.classList.add('hidden');
});
serverInput.addEventListener('change', () => {
  const v = serverInput.value.trim();
  if (!v) return;
  const ok = /^wss?:\/\/\S+$/i.test(v);
  serverInput.classList.toggle('invalid', !ok);
  serverError.classList.toggle('hidden', ok);
  if (ok) queueSetting('serverUrl', v);
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
  $('#avoid-zone').value   = s.avoidZone || 'none';
  qhToggle.checked         = !!s.quietHours?.enabled;
  qhStart.value            = s.quietHours?.start || '22:00';
  qhEnd.value              = s.quietHours?.end   || '08:00';
  refreshQuietHours();
  $('#autostart').checked  = !!s.autostart;
  serverInput.value        = s.serverUrl || '';

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

// Onglet mémorisé — appelé en dernier, une fois tout le module initialisé
showTab(lsGet('memedrop.tab', 'home'));
