// main.js — MemeDrop overlay (Electron main process)
const { app, BrowserWindow, screen, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const DEFAULT_SERVER =
  process.env.DEFAULT_SERVER || 'wss://memedrop-bot.fly.dev';

// Le bot a quitté Railway (coupé) pour Fly.io. electron-store ne réapplique
// jamais une valeur par défaut sur une clé déjà enregistrée : on migre donc
// explicitement toute ancienne URL Railway vers le serveur actuel.
function isLegacyServerUrl(url) {
  return /\.up\.railway\.app/i.test(String(url || ''));
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const store = new Store({
  defaults: {
    serverUrl: DEFAULT_SERVER,
    volume: 0.75,
    musicVolume: 0.75,
    opacity: 1.0,
    duration: 4,
    videoDuration: 30,
    soundOnArrival: true,
    spotlightOnDrop: true,
    autostart: true,
    overlayDisplayId: null,
    // Identité de lien stockée localement → ré-enregistrement auto à chaque
    // connexion, plus jamais besoin de /link (survit aux redeploys du bot).
    //   { userId, username, scope:'guild'|'global', guildIds:[...], token,
    //     blockedUsers:[...] }
    linkIdentity: null,
    // Pause manuelle : l'utilisateur a coupé la connexion lui-même depuis les
    // réglages. L'app reste lancée (tray) mais ne se connecte pas au bot.
    paused: false,
    // Mode tranquille : timestamp jusqu'auquel on ignore les drops entrants
    // (-1 = jusqu'à réactivation manuelle, null = désactivé).
    muteUntil: null,
    // Historique local des derniers drops reçus (pour les réglages).
    dropHistory: [],
    // Thème visuel de l'overlay : 'classic' | 'neon' | 'fire' | 'mono'.
    theme: 'classic',
    // Heures calmes : mute automatique sur un créneau horaire quotidien
    // (ex. 22:00 → 08:00). Indépendant du mode tranquille manuel.
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    // Zone de l'écran où les drops n'apparaissent jamais :
    // 'none' | 'center' | 'top' | 'bottom'.
    avoidZone: 'none',
  },
});

if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);

const MAX_HISTORY = 20;

// muteUntil: null = pas de mode tranquille, -1 = jusqu'à réactivation
// manuelle, sinon un timestamp (ms) jusqu'auquel les drops sont coupés.
// (-1 plutôt qu'Infinity car electron-store sérialise en JSON, qui ne
// supporte pas Infinity.)
function isMuted() {
  return quietHoursActive() || isManuallyMuted();
}

// Mode tranquille manuel uniquement (sans les heures calmes) — c'est ce que
// le menu du tray peut activer/désactiver.
function isManuallyMuted() {
  const until = store.get('muteUntil');
  if (!until) return false;
  if (until === -1 || until > Date.now()) return true;
  store.set('muteUntil', null);
  return false;
}

// Heures calmes : vrai si l'heure locale est dans le créneau configuré.
// Gère les créneaux qui traversent minuit (ex. 22:00 → 08:00).
function quietHoursActive() {
  const qh = store.get('quietHours');
  if (!qh || !qh.enabled) return false;
  const toMin = (s, fallback) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || fallback));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const start = toMin(qh.start, '22:00');
  const end   = toMin(qh.end, '08:00');
  if (start == null || end == null || start === end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

function recordHistory(payload) {
  const entry = {
    from: payload.from?.username || 'inconnu',
    avatar: payload.from?.avatar || null,
    kind: payload.media?.kind || (payload.tts ? 'tts' : (payload.rain ? 'rain' : 'unknown')),
    caption: payload.caption || null,
    ts: payload.ts || Date.now(),
    // Contenu conservé pour le bouton "revoir" des réglages. Les URLs
    // Discord expirent après ~24 h : le replay peut donc échouer sur les
    // vieux drops, c'est assumé.
    media: payload.media ? {
      url: payload.media.url, kind: payload.media.kind, mime: payload.media.mime,
    } : null,
    music: payload.music ? { url: payload.music.url, mime: payload.music.mime } : null,
    rain: payload.rain || null,
    tts: payload.tts || null,
    ttsUrl: payload.ttsUrl || null,
    effect: payload.effect || null,
  };
  const history = [entry, ...store.get('dropHistory')].slice(0, MAX_HISTORY);
  store.set('dropHistory', history);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('history-update', history);
  }
}

let overlayWin = null;
let settingsWin = null;
let tray = null;
let topGuardTimer = null;
let displayListenersBound = false;

function iconPath() {
  return path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function getTargetDisplay() {
  const displays = screen.getAllDisplays();
  const wantedId = store.get('overlayDisplayId');
  if (wantedId != null) {
    const found = displays.find(d => d.id === wantedId);
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

function enforceTop() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    if (!overlayWin.isAlwaysOnTop()) overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.moveTop();
  } catch (e) {}
}

function startTopGuard() {
  if (topGuardTimer) return;
  topGuardTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (!overlayWin.isAlwaysOnTop()) {
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
      overlayWin.moveTop();
    }
  }, 2000);
}

function stopTopGuard() {
  if (topGuardTimer) { clearInterval(topGuardTimer); topGuardTimer = null; }
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  const display = getTargetDisplay();
  const { x, y, width, height } = display.bounds;

  overlayWin = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  overlayWin.on('blur', () => {
    if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isAlwaysOnTop()) enforceTop();
  });

  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlayWin.once('ready-to-show', () => { overlayWin.show(); enforceTop(); });

  // Écouteurs globaux : enregistrés une seule fois, même si la fenêtre est
  // recréée (sinon ils s'accumulaient à chaque recréation).
  if (!displayListenersBound) {
    displayListenersBound = true;
    const onDisplayChange = () => { repositionOverlay(); enforceTop(); };
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-added',   onDisplayChange);
    screen.on('display-removed', onDisplayChange);
  }

  return overlayWin;
}

function repositionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setBounds(getTargetDisplay().bounds);
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 460,
    height: 820,
    minWidth: 420,
    minHeight: 600,
    title: 'MemeDrop',
    backgroundColor: '#0e0a1f',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'));

  settingsWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });

  return settingsWin;
}

// `minutes`: falsy → désactive, -1 → jusqu'à réactivation, sinon durée en minutes.
function setMute(minutes) {
  const until = !minutes ? null : (minutes === -1 ? -1 : Date.now() + minutes * 60_000);
  store.set('muteUntil', until);
  setState({ muteUntil: until });
  rebuildTrayMenu();
}

let lastTrayMuteKey = null;
function rebuildTrayMenu() {
  if (!tray) return;
  const manual = isManuallyMuted();
  const quiet  = quietHoursActive();
  lastTrayMuteKey = `${manual}|${quiet}`;
  const muteSubmenu = manual
    ? [{ label: '🔊 Réactiver les drops', click: () => setMute(null) }]
    : [
        { label: '🔇 Mode tranquille — 30 min', click: () => setMute(30) },
        { label: '🔇 Mode tranquille — 2 h',    click: () => setMute(120) },
        { label: '🔇 Mode tranquille — jusqu\'à réactivation', click: () => setMute(-1) },
      ];

  const menu = Menu.buildFromTemplate([
    { label: 'MemeDrop',         enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir les réglages…', click: () => createSettingsWindow() },
    { label: 'Afficher / masquer l\'overlay',
      click: () => {
        if (overlayWin && overlayWin.isVisible()) overlayWin.hide();
        else { createOverlayWindow(); overlayWin.show(); }
      } },
    { label: 'Forcer au premier plan', click: enforceTop },
    { type: 'separator' },
    ...(quiet ? [{ label: '🌙 Heures calmes en cours', enabled: false }] : []),
    ...muteSubmenu,
    { type: 'separator' },
    { label: 'Vérifier les mises à jour…', click: () => checkForUpdates(true) },
    { label: 'Ouvrir les DevTools (overlay)',
      click: () => {
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.openDevTools({ mode: 'detach' });
        }
      } },
    { type: 'separator' },
    { label: 'Quitter',
      click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(manual ? 'MemeDrop — mode tranquille 🔇'
    : quiet ? 'MemeDrop — heures calmes 🌙' : 'MemeDrop');
}

// Le mode tranquille temporisé et les heures calmes expirent tout seuls :
// on resynchronise le tray (et les réglages) quand l'état change.
function refreshMuteState() {
  const manual = isManuallyMuted();
  const key = `${manual}|${quietHoursActive()}`;
  if (key === lastTrayMuteKey) return;
  if (!manual && connState.muteUntil) setState({ muteUntil: null });
  rebuildTrayMenu();
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  rebuildTrayMenu();
  tray.on('click', () => createSettingsWindow());
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket client
// ─────────────────────────────────────────────────────────────────────────────
// Réglages joints à chaque drop envoyé au renderer de l'overlay.
function currentDropSettings() {
  return {
    volume: store.get('volume'),
    musicVolume: store.get('musicVolume'),
    opacity: store.get('opacity'),
    duration: store.get('duration'),
    videoDuration: store.get('videoDuration'),
    soundOnArrival: store.get('soundOnArrival'),
    spotlightOnDrop: store.get('spotlightOnDrop'),
    avoidZone: store.get('avoidZone'),
  };
}

// Affiche un payload de drop sur l'overlay (création de la fenêtre au besoin).
function showDropOnOverlay(payload) {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
  startTopGuard(); enforceTop();
  overlayWin.webContents.send('drop', { ...payload, settings: currentDropSettings() });
}

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;

// Le bot envoie un ping toutes les 30 s. Sans nouvelles pendant 75 s, la
// connexion est considérée morte (veille, changement de Wi-Fi…) : on la
// coupe pour déclencher la reconnexion au lieu d'attendre indéfiniment.
const HEARTBEAT_TIMEOUT_MS = 75_000;
function armHeartbeat(sock) {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    console.warn('[ws] no ping from bot — dropping dead connection');
    try { sock.terminate(); } catch {}
  }, HEARTBEAT_TIMEOUT_MS);
}

// Ferme la socket courante SANS déclencher la reconnexion automatique de son
// handler 'close'. Avant, fermer puis rappeler connectWS() (changement d'URL,
// bouton "reconnecter", fin de pause) laissait l'ancien 'close' planifier une
// 2e connexion : deux sockets ouvertes vers le bot pour un seul overlay.
function dropSocket() {
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  const old = ws;
  ws = null;
  if (!old) return;
  old.removeAllListeners();
  old.on('error', () => {});
  try { old.terminate(); } catch {}
}

function wsSend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
}
let connState = { status: 'disconnected', code: null, user: null, links: null, muteUntil: store.get('muteUntil') };

function broadcastState() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('connection-state', connState);
  }
}

function setState(patch) {
  connState = { ...connState, ...patch };
  broadcastState();
}

function connectWS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  dropSocket();
  if (store.get('paused')) {
    setState({ status: 'paused', code: null, user: null, links: null });
    return;
  }
  const url = store.get('serverUrl');
  setState({ status: 'connecting', code: null, user: null, links: null });

  let sock;
  try { sock = new WebSocket(url); }
  catch (err) { console.error('[ws] construct error:', err.message); scheduleReconnect(); return; }
  ws = sock;

  sock.on('open', () => {
    reconnectAttempts = 0;
    armHeartbeat(sock);
    console.log('[ws] connected to', url);
    // Ré-enregistrement automatique : on rejoue notre identité stockée (avec
    // son token de sécurité) pour que le bot rebuild le lien sans /link.
    // Marche même après un redeploy (tant que le token reste valide).
    const identity = store.get('linkIdentity');
    if (identity && identity.userId) wsSend({ type: 'register', identity });
  });

  sock.on('message', (raw) => {
    armHeartbeat(sock);
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'pairing_code':
        // If we're already linked, this is an extension code for adding more
        // guilds. Don't drop the linked state — just update the visible code.
        if (connState.status === 'linked') {
          setState({ code: msg.code });
        } else if (store.get('linkIdentity')) {
          // On a une identité et on tente un ré-enregistrement silencieux —
          // on garde le code prêt mais on reste "connexion…" plutôt que de
          // flasher "en attente". Si ça échoue, le bot envoie register_failed.
          setState({ status: 'connecting', code: msg.code, user: null, links: null });
        } else {
          setState({ status: 'awaiting_link', code: msg.code, user: null, links: null });
        }
        break;
      case 'linked': {
        // Mémorise l'identité (depuis l'utilisateur + le snapshot serveurs)
        // pour le ré-enregistrement automatique des prochaines connexions.
        const links = msg.links || { scope: 'guild', guilds: [], guildIds: [], blocked: [], blockedIds: [] };
        if (msg.user?.id) {
          store.set('linkIdentity', {
            userId:   msg.user.id,
            username: msg.user.username,
            scope:    links.scope === 'global' ? 'global' : 'guild',
            guildIds: Array.isArray(links.guildIds) ? links.guildIds : [],
            token:    msg.token || null,
            blockedIds: Array.isArray(links.blockedIds) ? links.blockedIds : [],
          });
        }
        setState({ status: 'linked', code: null, user: msg.user, links });
        break;
      }
      case 'register_failed':
        // Identité invalide/obsolète — on l'oublie et on repasse en appairage.
        store.set('linkIdentity', null);
        setState({ status: 'awaiting_link', code: connState.code || null, user: null, links: null });
        break;
      case 'links_update': {
        // Mise à jour autoritaire des serveurs/blocages (ajout/retrait) → on
        // persiste les IDs côté overlay pour le prochain ré-enregistrement.
        const cur = store.get('linkIdentity');
        if (cur && msg.links) {
          cur.scope      = msg.links.scope === 'global' ? 'global' : 'guild';
          cur.guildIds   = Array.isArray(msg.links.guildIds) ? msg.links.guildIds : cur.guildIds;
          cur.blockedIds = Array.isArray(msg.links.blockedIds) ? msg.links.blockedIds : cur.blockedIds;
          store.set('linkIdentity', cur);
        }
        setState({ links: msg.links });
        break;
      }
      case 'unlinked':
        store.set('linkIdentity', null);   // this overlay is no longer linked
        setState({ status: 'connecting', code: null, user: null, links: null }); break;
      case 'drop':
        recordHistory(msg);
        if (isMuted()) break; // mode tranquille / heures calmes : on note le drop mais on ne l'affiche pas
        showDropOnOverlay(msg);
        break;
      case 'ping':
        wsSend({ type: 'pong' }); break;
    }
  });

  sock.on('close', () => {
    if (sock !== ws) return;   // socket déjà remplacée par une plus récente
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    ws = null;
    if (store.get('paused')) { setState({ status: 'paused', code: null, user: null, links: null }); return; }
    setState({ status: 'disconnected', code: null, user: null, links: null });
    scheduleReconnect();
  });
  sock.on('error', (err) => console.error('[ws] error:', err.message));
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(30_000, 1000 * Math.pow(1.6, Math.min(reconnectAttempts, 8)));
  reconnectTimer = setTimeout(connectWS, delay);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-updater (GitHub Releases)
//
// Flow:
//   - Check 4 seconds after launch (give the UI time to settle).
//   - On `update-available` we DON'T auto-download. We let the user click
//     "Install & restart" from the settings window — feels less intrusive
//     than a forced background download.
//   - Periodic re-check every 30 min while the app is open.
// ─────────────────────────────────────────────────────────────────────────────
let updateState = { status: 'idle', version: null, error: null, progress: null };
// Les vérifications automatiques (toutes les 30 min) restent silencieuses :
// seule une vérification manuelle affiche "Vérification…" / "À jour" /
// les erreurs réseau. Une mise à jour trouvée est toujours signalée.
let manualUpdateCheck = false;

function broadcastUpdate() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-state', updateState);
  }
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  broadcastUpdate();
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

autoUpdater.on('checking-for-update', () => {
  if (manualUpdateCheck) setUpdateState({ status: 'checking', error: null });
});

autoUpdater.on('update-available', (info) => {
  console.log('[updater] update available:', info.version);
  setUpdateState({ status: 'available', version: info.version, error: null });
});

autoUpdater.on('update-not-available', () => {
  if (manualUpdateCheck) setUpdateState({ status: 'up-to-date', error: null });
  manualUpdateCheck = false;
});

autoUpdater.on('error', (err) => {
  console.error('[updater] error:', err);
  // Une erreur pendant un téléchargement lancé par l'utilisateur est toujours
  // montrée ; celle d'une vérification de fond (hors-ligne…) est ignorée.
  if (manualUpdateCheck || updateState.status === 'downloading') {
    setUpdateState({ status: 'error', error: err?.message || String(err) });
  }
  manualUpdateCheck = false;
});

autoUpdater.on('download-progress', (p) => {
  setUpdateState({ status: 'downloading', progress: Math.round(p.percent) });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[updater] downloaded:', info.version);
  setUpdateState({ status: 'downloaded', version: info.version });
});

function checkForUpdates(manual = false) {
  // Auto-updater only works in packaged builds. During dev (`npm start`) we
  // skip the check to avoid noise — but show a friendly message if the user
  // clicked manually.
  if (!app.isPackaged) {
    if (manual) {
      setUpdateState({ status: 'dev-mode', error: null });
    }
    return;
  }
  // Pas de nouvelle vérification pendant un téléchargement ou si une MAJ
  // attend déjà d'être installée.
  if (['downloading', 'downloaded'].includes(updateState.status)) return;
  if (manual) manualUpdateCheck = true;
  try {
    autoUpdater.checkForUpdates().catch(err => {
      if (manual) setUpdateState({ status: 'error', error: err?.message || String(err) });
    });
  } catch (err) {
    if (manual) setUpdateState({ status: 'error', error: err?.message || String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => ({
  serverUrl:      store.get('serverUrl'),
  volume:         store.get('volume'),
  musicVolume:    store.get('musicVolume'),
  opacity:        store.get('opacity'),
  duration:       store.get('duration'),
  videoDuration:  store.get('videoDuration'),
  soundOnArrival:  store.get('soundOnArrival'),
  spotlightOnDrop: store.get('spotlightOnDrop'),
  autostart:      store.get('autostart'),
  overlayDisplayId: store.get('overlayDisplayId'),
  paused:         store.get('paused'),
  muteUntil:      store.get('muteUntil'),
  theme:          store.get('theme'),
  quietHours:     store.get('quietHours'),
  avoidZone:      store.get('avoidZone'),
}));

ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return false;
  if ('serverUrl' in patch && !/^wss?:\/\/\S+$/i.test(String(patch.serverUrl))) {
    delete patch.serverUrl;   // URL invalide : ignorée (validée aussi côté UI)
  }
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  if ('autostart' in patch) {
    // openAsHidden = macOS; args ['--hidden'] = Windows (start to tray, no
    // settings window) so the app boots silently and connects on its own.
    app.setLoginItemSettings({ openAtLogin: !!patch.autostart, openAsHidden: true, args: ['--hidden'] });
  }
  if ('paused' in patch) {
    // connectWS() coupe proprement l'ancienne socket et, en pause, s'arrête là.
    connectWS();
  } else if ('serverUrl' in patch) {
    connectWS();
  }
  if ('quietHours' in patch) refreshMuteState();
  if ('overlayDisplayId' in patch) { repositionOverlay(); enforceTop(); }
  if (overlayWin && !overlayWin.isDestroyed() &&
      ('volume' in patch || 'musicVolume' in patch || 'opacity' in patch ||
       'duration' in patch || 'videoDuration' in patch || 'spotlightOnDrop' in patch ||
       'theme' in patch)) {
    const livePatch = {};
    if ('volume'          in patch) livePatch.volume          = patch.volume;
    if ('musicVolume'     in patch) livePatch.musicVolume     = patch.musicVolume;
    if ('opacity'         in patch) livePatch.opacity         = patch.opacity;
    if ('duration'        in patch) livePatch.duration        = patch.duration;
    if ('videoDuration'   in patch) livePatch.videoDuration   = patch.videoDuration;
    if ('spotlightOnDrop' in patch) livePatch.spotlightOnDrop = patch.spotlightOnDrop;
    if ('theme'           in patch) livePatch.theme           = patch.theme;
    overlayWin.webContents.send('settings-update', livePatch);
  }
  return true;
});

ipcMain.handle('displays:list', () => screen.getAllDisplays().map(d => ({
  id: d.id,
  label: d.label || `Display ${d.id}`,
  bounds: d.bounds,
  primary: d.id === screen.getPrimaryDisplay().id,
})));

ipcMain.handle('connection:get', () => connState);
ipcMain.handle('connection:reconnect', () => {
  reconnectAttempts = 0;
  connectWS(); return true;
});
ipcMain.handle('connection:unlink-guild', (_e, guildId) =>
  wsSend({ type: 'unlink_guild', guildId: String(guildId || '') }));
ipcMain.handle('connection:unblock-user', (_e, userId) =>
  wsSend({ type: 'unblock_user', userId: String(userId || '') }));

// ── Mode tranquille ────────────────────────────────────────────────────
// `minutes` null/0 → désactive. -1 → tranquille jusqu'à réactivation.
ipcMain.handle('mute:set', (_e, minutes) => {
  setMute(minutes);
  return store.get('muteUntil');
});
ipcMain.handle('mute:get', () => (isManuallyMuted() ? store.get('muteUntil') : null));
ipcMain.handle('quiet-hours:active', () => quietHoursActive());

// ── Historique des drops ──────────────────────────────────────────────
ipcMain.handle('history:get', () => store.get('dropHistory'));
ipcMain.handle('history:clear', () => {
  store.set('dropHistory', []);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('history-update', []);
  }
  return true;
});

// Rejoue un drop de l'historique sur l'overlay (sans le ré-enregistrer).
// `ts` identifie l'entrée — plus robuste qu'un index si l'historique bouge
// entre l'affichage et le clic.
ipcMain.handle('history:replay', (_e, ts) => {
  const h = store.get('dropHistory').find(x => x.ts === ts);
  if (!h || (!h.media && !h.rain && !h.tts)) return false;
  showDropOnOverlay({
    media: h.media || null,
    music: h.music || null,
    rain: h.rain || null,
    tts: h.tts || null,
    ttsUrl: h.ttsUrl || null,
    effect: h.effect || null,
    caption: h.caption || null,
    from: { username: h.from, avatar: h.avatar || null },
    ts: Date.now(),
  });
  return true;
});

// ── Réactions aux drops ───────────────────────────────────────────────
// Le renderer de l'overlay relaie le clic emoji ; on le transmet au bot.
ipcMain.on('drop:react', (_e, { dropId, emoji } = {}) => {
  if (!dropId || !emoji) return;
  wsSend({ type: 'react', dropId: String(dropId), emoji: String(emoji) });
});

// App version + update IPC
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('update:get-state', () => updateState);
ipcMain.handle('update:check',     () => { checkForUpdates(true); return true; });
ipcMain.handle('update:download',  () => {
  if (updateState.status === 'available') {
    autoUpdater.downloadUpdate().catch(err =>
      setUpdateState({ status: 'error', error: err?.message || String(err) }));
  }
  return true;
});
ipcMain.handle('update:install',   () => {
  if (updateState.status === 'downloaded') {
    // isSilent=true, isForceRunAfter=true → installs cleanly and relaunches
    autoUpdater.quitAndInstall(true, true);
  }
  return true;
});

ipcMain.on('test-drop', () => {
  showDropOnOverlay({
    type: 'drop',
    media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
    caption: 'TEST DROP',
    from: { id: '0', username: 'You (test)' },
    ts: Date.now(),
  });
});

ipcMain.on('stage-empty', () => stopTopGuard());
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ── Drag : sondage du curseur + bascule setIgnoreMouseEvents ─────────────
//
// Le renderer ne peut pas détecter le survol des drops via forward:true de
// façon fiable sur Windows. On sonde donc screen.getCursorScreenPoint() dans
// le main process (~60 fps) et on envoie la position au renderer.
// Le renderer demande à démarrer/arrêter le sondage selon qu'il y a des
// drops visuels à l'écran.
let _cursorPollTimer = null;
let _lastCursor = null;

function startCursorPoll() {
  if (_cursorPollTimer) return;
  _lastCursor = null;
  _cursorPollTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    // Souris immobile → rien à signaler, on économise ~60 IPC/s pendant
    // qu'un drop est affiché (le renderer ne réagit qu'aux mouvements).
    if (_lastCursor && _lastCursor.x === pt.x && _lastCursor.y === pt.y) return;
    _lastCursor = pt;
    const b = overlayWin.getBounds();
    overlayWin.webContents.send('overlay:cursor', { x: pt.x - b.x, y: pt.y - b.y });
  }, 16);
}

function stopCursorPoll() {
  if (_cursorPollTimer) { clearInterval(_cursorPollTimer); _cursorPollTimer = null; }
}

// Un nouveau drop peut apparaître sous un curseur immobile : on force le
// renvoi de la position au prochain tick pour que le survol soit détecté.
ipcMain.on('overlay:watch-cursor',   () => { _lastCursor = null; startCursorPoll(); });
ipcMain.on('overlay:unwatch-cursor', () => stopCursorPoll());

// Bascule setIgnoreMouseEvents à la demande du renderer.
//   ignore = true  → événements vers le jeu  (mode normal)
//   ignore = false → overlay capture la souris (mode drag)
ipcMain.on('overlay:set-ignore-mouse', (_e, ignore) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (ignore) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWin.setIgnoreMouseEvents(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createSettingsWindow());

  if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.overlay');

  // The OS launches us with --hidden when starting at login (see the args we
  // register below). In that case we boot straight to the tray + overlay and
  // skip the settings window so the user can troll immediately, no clicks.
  const startedHidden =
    process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;

  app.whenReady().then(() => {
    // Reconcile the OS login item with the stored setting on every launch, so
    // autostart actually takes effect even if the user never opened settings.
    app.setLoginItemSettings({
      openAtLogin: !!store.get('autostart'),
      openAsHidden: true,
      args: ['--hidden'],
    });

    createOverlayWindow();
    if (!startedHidden) createSettingsWindow();
    createTray();
    connectWS();

    // Debug shortcuts — work even when the overlay (which is non-focusable)
    // can't receive keyboard events normally. We use Ctrl+Alt+X combos so we
    // don't collide with GPU monitor overlays (NZXT CAM, MSI Afterburner, etc.)
    // which often grab Ctrl+Shift+X.
    //   Ctrl+Alt+S → DevTools on the Settings window
    //   Ctrl+Alt+M → DevTools on the overlay window (the transparent one
    //                that actually plays the videos)
    globalShortcut.register('Control+Alt+S', () => {
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.openDevTools({ mode: 'detach' });
      }
    });
    globalShortcut.register('Control+Alt+M', () => {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.openDevTools({ mode: 'detach' });
      }
    });

    // Expiration du mode tranquille / début-fin des heures calmes
    setInterval(refreshMuteState, 30_000);

    // Auto-update: check shortly after launch + every 30 min
    setTimeout(() => checkForUpdates(false), 4000);
    setInterval(() => checkForUpdates(false), 30 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createSettingsWindow();
        createOverlayWindow();
      }
    });
  });

  app.on('window-all-closed', (e) => { e.preventDefault?.(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => { app.isQuitting = true; stopTopGuard(); });
}
