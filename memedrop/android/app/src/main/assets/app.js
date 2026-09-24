// app.js — écran de réglages Android. Lit l'état via le pont natif `MD`
// (MainActivity.Bridge) et le redessine à chaque window.onNativeState().
const $ = (s) => document.querySelector(s);

function readState() {
  try { return JSON.parse(MD.getState()); } catch { return null; }
}
function lsGet(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

let S = null;
let settingsLoaded = false;

// ── Onglets ────────────────────────────────────────────────────────────
const tabs = [...document.querySelectorAll('.tab')];
const panels = [...document.querySelectorAll('.tab-panel')];
let currentTab = 'home';
function showTab(name) {
  if (!panels.some(p => p.dataset.panel === name)) name = 'home';
  currentTab = name;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  lsSet('memedrop.tab', name);
  if (name === 'history') markHistorySeen();
  window.scrollTo(0, 0);
}
tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ── Rendu principal ────────────────────────────────────────────────────
function render() {
  renderPermissions();
  renderConnection();
  renderMute();
  renderHistory();
  if (!settingsLoaded) loadSettings();
  renderUpdate();
  $('#app-version').textContent = `v${S.version}`;
  $('#settings-version').textContent = `v${S.version}`;
}

// ── Mise à jour de l'APK ───────────────────────────────────────────────
function renderUpdate() {
  const u = S.update || { state: 'idle' };
  const card = $('#update-card');
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  card.classList.toggle('hidden', u.state === 'idle');
  show('#update-download', u.state === 'available');
  show('#update-install', u.state === 'downloaded');
  show('#update-check', u.state === 'error' || u.state === 'up-to-date');
  show('#update-progress', u.state === 'downloading');
  $('#update-progress-fill').style.width = `${u.progress || 0}%`;
  const latest = u.latest ? `v${u.latest}` : 'nouvelle version';
  const [eyebrow, title, msg] = {
    checking:     ['mise à jour', 'Vérification…', 'Recherche d\'une nouvelle version.'],
    'up-to-date': ['à jour', 'Tout est à jour ✓', `Tu as la dernière version (v${u.current}).`],
    available:    ['nouveauté', `Mise à jour disponible — ${latest}`, `Tu as la v${u.current}. Télécharge la nouvelle, elle s'installe par-dessus.`],
    downloading:  ['téléchargement', 'Téléchargement…', `${u.progress || 0}% — reste sur l'appli.`],
    downloaded:   ['prêt', `${latest} prête à installer`, 'Si Android le demande, autorise MemeDrop à installer des applis, puis reviens toucher « installer ».'],
    error:        ['erreur', 'Mise à jour impossible', u.error || 'Réessaie plus tard.'],
  }[u.state] || ['', '', ''];
  $('#update-eyebrow').textContent = eyebrow;
  $('#update-title').textContent = title;
  $('#update-msg').textContent = msg;
}
$('#update-download').addEventListener('click', () => MD.downloadUpdate());
$('#update-install').addEventListener('click', () => MD.installUpdate());
$('#update-check').addEventListener('click', () => MD.checkUpdate());
$('#settings-check-update').addEventListener('click', () => { MD.checkUpdate(); showTab('home'); });

function renderPermissions() {
  const p = S.perm || {};
  $('#perm-card').classList.toggle('hidden', !!(p.overlay && p.notif && p.battery));
  for (const k of ['overlay', 'notif', 'battery']) {
    const row = $(`#perm-${k}`);
    const btn = row.querySelector('button');
    let ok = row.querySelector('.perm-ok');
    btn.classList.toggle('hidden', !!p[k]);
    if (p[k] && !ok) {
      ok = document.createElement('span');
      ok.className = 'perm-ok';
      ok.textContent = '✓';
      row.appendChild(ok);
    } else if (!p[k] && ok) ok.remove();
  }
}
document.querySelectorAll('[data-perm]').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.perm;
  if (k === 'overlay') MD.requestOverlay();
  else if (k === 'notif') MD.requestNotif();
  else MD.requestBattery();
}));

const pill = $('#conn-pill');
function status(kind, icon, title, msg) {
  const c = $('#status-card');
  c.classList.remove('hidden', 'is-down', 'is-paused', 'is-connecting');
  c.classList.add(`is-${kind}`);
  $('#status-icon').textContent = icon;
  $('#status-title').textContent = title;
  $('#status-msg').textContent = msg;
  $('#status-resume').classList.toggle('hidden', kind !== 'paused');
  $('#status-retry').classList.toggle('hidden', kind !== 'down');
  $('#status-start').classList.toggle('hidden', kind !== 'stopped');
}

function renderConnection() {
  const label = pill.querySelector('.label');
  pill.className = 'pill';
  ['#status-card', '#pairing-card', '#linked-card', '#servers-card'].forEach(s => $(s).classList.add('hidden'));

  switch (S.status) {
    case 'connecting':
      pill.classList.add('pill--connecting'); label.textContent = 'connexion…';
      status('connecting', '📡', 'Connexion au bot…', 'Ça ne devrait prendre que quelques secondes.');
      break;
    case 'awaiting_link':
      pill.classList.add('pill--awaiting'); label.textContent = 'en attente';
      $('#pairing-card').classList.remove('hidden');
      $('#pairing-code').textContent = S.code || '------';
      break;
    case 'linked':
      pill.classList.add('pill--linked'); label.textContent = 'connecté';
      $('#linked-card').classList.remove('hidden');
      $('#linked-user').textContent = S.user?.username || '—';
      renderServers();
      break;
    case 'paused':
      pill.classList.add('pill--paused'); label.textContent = 'en pause';
      status('paused', '⏸️', 'Connexion en pause', 'Personne ne peut t\'envoyer de drop tant que la connexion est coupée.');
      break;
    case 'stopped':
      pill.classList.add('pill--down'); label.textContent = 'arrêté';
      status('stopped', '⏹️', 'MemeDrop est arrêté', 'Démarre-le pour recevoir à nouveau des drops.');
      break;
    default:
      pill.classList.add('pill--down'); label.textContent = 'hors ligne';
      status('down', '🔌', 'Bot injoignable', 'Nouvelle tentative automatique. Vérifie ta connexion internet ou l\'URL du serveur.');
  }
  $('#connection-toggle').checked = !S.paused;
  renderBlocked();
}

function row(picContent, title, sub, button) {
  const r = document.createElement('div');
  r.className = 'server-row';
  const pic = document.createElement('div');
  pic.className = 'server-row-pic';
  if (picContent instanceof Node) pic.appendChild(picContent); else pic.textContent = picContent;
  const name = document.createElement('div');
  name.className = 'server-row-name';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const s = document.createElement('div');
  s.className = 'server-row-sub';
  s.textContent = sub;
  name.append(strong, s);
  r.append(pic, name);
  if (button) r.appendChild(button);
  return { r, pic };
}

function renderServers() {
  const links = S.links;
  const list = $('#server-list');
  list.innerHTML = '';
  if (!links || links.scope === 'none') return;
  $('#servers-card').classList.remove('hidden');
  $('#servers-tip').innerHTML = '';
  const tip = document.createElement('span');
  tip.textContent = S.code ? `Pour ajouter un serveur, tape /link ${S.code} dessus.` : 'Pour ajouter un serveur, tape /link <code> dessus.';
  $('#servers-tip').appendChild(tip);

  if (links.scope === 'global') {
    list.appendChild(row('∞', 'Tous les serveurs', 'lien global (ancien mode)').r);
    return;
  }
  const guilds = links.guilds || [];
  if (!guilds.length) {
    const e = document.createElement('div');
    e.className = 'server-empty';
    e.textContent = 'Aucun serveur. Utilise /link sur Discord pour en ajouter un.';
    list.appendChild(e);
    return;
  }
  for (const g of guilds) {
    const btn = document.createElement('button');
    btn.className = 'ghost danger';
    btn.textContent = 'retirer';
    btn.addEventListener('click', () => {
      if (confirm(`Ne plus recevoir de drops venant de « ${g.name} » ?`)) MD.unlinkGuild(g.id);
    });
    let pic = (g.name || '?').charAt(0).toUpperCase();
    if (g.icon) { pic = document.createElement('img'); pic.src = g.icon; pic.referrerPolicy = 'no-referrer'; }
    list.appendChild(row(pic, g.name || 'Serveur inconnu', `ID ${g.id}`, btn).r);
  }
}

function renderBlocked() {
  const blocked = S.links?.blocked || [];
  $('#blocked-card').classList.toggle('hidden', blocked.length === 0);
  const list = $('#blocked-list');
  list.innerHTML = '';
  for (const b of blocked) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = 'débloquer';
    btn.addEventListener('click', () => MD.unblockUser(b.id));
    list.appendChild(row((b.username || '?').charAt(0).toUpperCase(), b.username || 'Inconnu', `ID ${b.id}`, btn).r);
  }
}

$('#status-resume').addEventListener('click', () => MD.setPaused(false));
$('#status-start').addEventListener('click', () => MD.start());
$('#status-retry').addEventListener('click', () => MD.reconnect());
$('#reconnect-btn').addEventListener('click', () => MD.reconnect());
$('#test-btn').addEventListener('click', () => MD.testDrop());
$('#connection-toggle').addEventListener('change', (e) => MD.setPaused(!e.target.checked));

const copyBtn = $('#copy-code');
copyBtn.addEventListener('click', () => {
  MD.copy(`/link ${$('#pairing-code').textContent}`);
  copyBtn.textContent = 'copié ✓ — colle-le sur Discord';
  setTimeout(() => { copyBtn.textContent = 'copier « /link code »'; }, 1600);
});

// ── Mode tranquille ────────────────────────────────────────────────────
function renderMute() {
  const m = S.muteUntil;
  const muted = m === -1 || m > Date.now();
  document.querySelectorAll('[data-mute]').forEach(b => b.classList.toggle('hidden', muted));
  $('#mute-off').classList.toggle('hidden', !muted);
  const st = $('#mute-status');
  st.classList.toggle('is-muted', muted);
  st.textContent = !muted ? 'Les drops s\'affichent normalement.'
    : m === -1 ? '🔇 Mode tranquille activé — jusqu\'à ce que tu le désactives.'
    : `🔇 Mode tranquille activé — encore ~${Math.max(1, Math.round((m - Date.now()) / 60000))} min.`;
  $('#quiet-now').classList.toggle('hidden', !S.quietActive);
  if (muted || S.quietActive) pill.classList.add('pill--muted');
}
document.querySelectorAll('[data-mute]').forEach(b => b.addEventListener('click', () => MD.setMute(Number(b.dataset.mute))));
$('#mute-off').addEventListener('click', () => MD.setMute(0));

// ── Historique ─────────────────────────────────────────────────────────
const KIND = { image: '🖼️', gif: '🎞️', video: '🎬', audio: '🎵', rain: '🌧️', tts: '🗣️', test: '🧪', unknown: '❓' };
function relTime(ts) {
  const min = Math.round(Math.max(0, Date.now() - ts) / 60000);
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((t - d) / 86400000);
  if (days === 0) return 'aujourd\'hui';
  if (days === 1) return 'hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function describe(h) {
  if (h.caption) return `« ${h.caption} »`;
  if (h.tts) return `🗣️ ${h.tts}`;
  if (h.rain) return `pluie ${[].concat(h.rain).join('')}`;
  return { image: 'une image', gif: 'un GIF', video: 'une vidéo', audio: 'un son' }[h.kind] || 'un drop';
}
function markHistorySeen() {
  const h = S?.history || [];
  if (h[0]) lsSet('memedrop.historySeen', h[0].ts);
  updateBadge();
}
function updateBadge() {
  const seen = Number(lsGet('memedrop.historySeen', 0)) || 0;
  const n = (S?.history || []).filter(h => h.ts > seen).length;
  const b = $('#history-badge');
  b.textContent = n > 9 ? '9+' : String(n);
  b.classList.toggle('hidden', n === 0 || currentTab === 'history');
}
function renderHistory() {
  const hist = S.history || [];
  const last = hist[0];
  $('#last-drop').classList.toggle('hidden', !last);
  if (last) $('#last-drop-text').textContent = `${last.from} · ${describe(last)} · ${relTime(last.ts)}`;
  if (currentTab === 'history') markHistorySeen(); else updateBadge();

  $('#history-empty').classList.toggle('hidden', hist.length > 0);
  $('#history-clear').classList.toggle('hidden', hist.length === 0);
  const list = $('#history-list');
  list.innerHTML = '';
  let lastDay = null;
  for (const h of hist) {
    const day = dayLabel(h.ts);
    if (day !== lastDay) {
      lastDay = day;
      const g = document.createElement('div');
      g.className = 'history-group';
      g.textContent = day;
      list.appendChild(g);
    }
    let btn = null;
    if (h.media || h.rain || h.tts) {
      btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'revoir';
      btn.addEventListener('click', () => MD.replay(String(h.ts)));
    }
    const time = new Date(h.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const { r, pic } = row((h.from || '?').charAt(0).toUpperCase(), h.from, `${time} · ${describe(h)}`, btn);
    pic.classList.add('history-pic');
    if (h.avatar) {
      const img = document.createElement('img');
      img.src = h.avatar;
      img.referrerPolicy = 'no-referrer';
      img.onload = () => { pic.firstChild && pic.firstChild.nodeType === 3 && pic.firstChild.remove(); };
      img.onerror = () => img.remove();
      pic.appendChild(img);
    }
    const kind = document.createElement('span');
    kind.className = 'history-kind';
    kind.textContent = KIND[h.kind] || '❓';
    pic.appendChild(kind);
    list.appendChild(r);
  }
}
$('#history-clear').addEventListener('click', () => {
  if (confirm('Vider tout l\'historique des drops reçus ?')) MD.clearHistory();
});

// ── Réglages ───────────────────────────────────────────────────────────
function setSetting(key, value) { MD.setSetting(key, JSON.stringify(value)); }

const RANGES = [
  // id, facteur (valeur stockée = slider / facteur), format
  ['volume', 100, v => `${v}%`],
  ['musicVolume', 100, v => `${v}%`],
  ['opacity', 100, v => `${v}%`],
  ['duration', 1, v => `${v}s`],
  ['videoDuration', 1, v => `${v}s`],
];
function paintRange(el) {
  el.style.setProperty('--value', `${(el.value - el.min) * 100 / (el.max - el.min)}%`);
}
const timers = {};
for (const [id, scale, fmt] of RANGES) {
  const el = $(`#${id}`);
  el.addEventListener('input', () => {
    $(`#${id}-out`).textContent = fmt(el.value);
    paintRange(el);
    clearTimeout(timers[id]);
    timers[id] = setTimeout(() => setSetting(id, Number(el.value) / scale), 150);
  });
}
for (const id of ['soundOnArrival', 'spotlightOnDrop', 'autostart']) {
  $(`#${id}`).addEventListener('change', (e) => setSetting(id, e.target.checked));
}
for (const id of ['theme', 'avoidZone']) {
  $(`#${id}`).addEventListener('change', (e) => setSetting(id, e.target.value));
}
function pushQuietHours() {
  setSetting('quietHours', {
    enabled: $('#quiet-hours').checked,
    start: $('#quiet-start').value || '22:00',
    end: $('#quiet-end').value || '08:00',
  });
}
['#quiet-hours', '#quiet-start', '#quiet-end'].forEach(s => $(s).addEventListener('change', pushQuietHours));

const server = $('#server');
server.addEventListener('input', () => { server.classList.remove('invalid'); $('#server-error').classList.add('hidden'); });
server.addEventListener('change', () => {
  const v = server.value.trim();
  const ok = /^wss?:\/\/\S+$/i.test(v);
  server.classList.toggle('invalid', !ok);
  $('#server-error').classList.toggle('hidden', ok);
  if (ok) setSetting('serverUrl', v);
});

function loadSettings() {
  settingsLoaded = true;
  const s = S.settings || {};
  for (const [id, scale, fmt] of RANGES) {
    const el = $(`#${id}`);
    el.value = Math.round((s[id] ?? 0) * scale);
    $(`#${id}-out`).textContent = fmt(el.value);
    paintRange(el);
  }
  $('#soundOnArrival').checked = !!s.soundOnArrival;
  $('#spotlightOnDrop').checked = !!s.spotlightOnDrop;
  $('#autostart').checked = s.autostart !== false;
  $('#theme').value = s.theme || 'classic';
  $('#avoidZone').value = s.avoidZone || 'none';
  $('#quiet-hours').checked = !!s.quietHours?.enabled;
  $('#quiet-start').value = s.quietHours?.start || '22:00';
  $('#quiet-end').value = s.quietHours?.end || '08:00';
  server.value = S.serverUrl || '';
}

$('#open-github').addEventListener('click', (e) => {
  e.preventDefault();
  MD.openUrl('https://github.com/Billalbzn/memedrop');
});

// ── Démarrage ──────────────────────────────────────────────────────────
window.onNativeState = () => {
  const next = readState();
  if (!next) return;
  S = next;
  render();
};
showTab(lsGet('memedrop.tab', 'home'));
window.onNativeState();
// Compte à rebours du mode tranquille / "il y a X min"
setInterval(() => window.onNativeState(), 30000);
