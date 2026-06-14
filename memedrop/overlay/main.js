// main.js — MemeDrop overlay (Electron main process)
const { app, BrowserWindow, screen, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const DEFAULT_SERVER =
  process.env.DEFAULT_SERVER || 'wss://memedrop-production-3106.up.railway.app';

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
  },
});

const MAX_HISTORY = 20;

// muteUntil: null = pas de mode tranquille, -1 = jusqu'à réactivation
// manuelle, sinon un timestamp (ms) jusqu'auquel les drops sont coupés.
// (-1 plutôt qu'Infinity car electron-store sérialise en JSON, qui ne
// supporte pas Infinity.)
function isMuted() {
  const until = store.get('muteUntil');
  if (!until) return false;
  if (until === -1 || until > Date.now()) return true;
  store.set('muteUntil', null);
  return false;
}

function recordHistory(payload) {
  const entry = {
    from: payload.from?.username || 'inconnu',
    kind: payload.media?.kind || (payload.rain ? 'rain' : 'unknown'),
    caption: payload.caption || null,
    ts: payload.ts || Date.now(),
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

  screen.on('display-metrics-changed', () => { repositionOverlay(); enforceTop(); });
  screen.on('display-added',   () => { repositionOverlay(); enforceTop(); });
  screen.on('display-removed', () => { repositionOverlay(); enforceTop(); });

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

function rebuildTrayMenu() {
  if (!tray) return;
  const muted = isMuted();
  const muteSubmenu = muted
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
  tray.setToolTip(muted ? 'MemeDrop — mode tranquille 🔇' : 'MemeDrop');
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
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
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
  if (store.get('paused')) {
    setState({ status: 'paused', code: null, user: null, links: null });
    return;
  }
  const url = store.get('serverUrl');
  setState({ status: 'connecting', code: null, user: null, links: null });

  try { ws = new WebSocket(url); }
  catch (err) { console.error('[ws] construct error:', err.message); scheduleReconnect(); return; }

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log('[ws] connected to', url);
    // Ré-enregistrement automatique : on rejoue notre identité stockée (avec
    // son token de sécurité) pour que le bot rebuild le lien sans /link.
    // Marche même après un redeploy (tant que le token reste valide).
    const identity = store.get('linkIdentity');
    if (identity && identity.userId) {
      try { ws.send(JSON.stringify({ type: 'register', identity })); } catch {}
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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
        if (isMuted()) break; // mode tranquille : on note le drop mais on ne l'affiche pas
        if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
        startTopGuard(); enforceTop();
        overlayWin.webContents.send('drop', {
          ...msg,
          settings: {
            volume: store.get('volume'),
            musicVolume: store.get('musicVolume'),
            opacity: store.get('opacity'),
            duration: store.get('duration'),
            videoDuration: store.get('videoDuration'),
            soundOnArrival: store.get('soundOnArrival'),
            spotlightOnDrop: store.get('spotlightOnDrop'),
          },
        });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' })); break;
    }
  });

  ws.on('close', () => {
    if (store.get('paused')) { setState({ status: 'paused', code: null, user: null, links: null }); return; }
    setState({ status: 'disconnected', code: null, links: null });
    scheduleReconnect();
  });
  ws.on('error', (err) => console.error('[ws] error:', err.message));
}

function scheduleReconnect() {
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
  setUpdateState({ status: 'checking', error: null });
});

autoUpdater.on('update-available', (info) => {
  console.log('[updater] update available:', info.version);
  setUpdateState({ status: 'available', version: info.version, error: null });
});

autoUpdater.on('update-not-available', () => {
  setUpdateState({ status: 'up-to-date', error: null });
});

autoUpdater.on('error', (err) => {
  console.error('[updater] error:', err);
  setUpdateState({ status: 'error', error: err?.message || String(err) });
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
  try {
    autoUpdater.checkForUpdates().catch(err => {
      setUpdateState({ status: 'error', error: err?.message || String(err) });
    });
  } catch (err) {
    setUpdateState({ status: 'error', error: err?.message || String(err) });
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
}));

ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  if ('autostart' in patch) {
    // openAsHidden = macOS; args ['--hidden'] = Windows (start to tray, no
    // settings window) so the app boots silently and connects on its own.
    app.setLoginItemSettings({ openAtLogin: !!patch.autostart, openAsHidden: true, args: ['--hidden'] });
  }
  if ('serverUrl' in patch) {
    try { ws && ws.close(); } catch {}
    connectWS();
  }
  if ('paused' in patch) {
    if (patch.paused) {
      try { ws && ws.close(); } catch {}
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      setState({ status: 'paused', code: null, user: null, links: null });
    } else {
      connectWS();
    }
  }
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
  try { ws && ws.close(); } catch {}
  connectWS(); return true;
});
ipcMain.handle('connection:unlink-guild', (_e, guildId) => {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try { ws.send(JSON.stringify({ type: 'unlink_guild', guildId })); return true; }
  catch { return false; }
});
ipcMain.handle('connection:unblock-user', (_e, userId) => {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try { ws.send(JSON.stringify({ type: 'unblock_user', userId })); return true; }
  catch { return false; }
});

// ── Mode tranquille ────────────────────────────────────────────────────
// `minutes` null/0 → désactive. -1 → tranquille jusqu'à réactivation.
ipcMain.handle('mute:set', (_e, minutes) => {
  setMute(minutes);
  return store.get('muteUntil');
});
ipcMain.handle('mute:get', () => (isMuted() ? store.get('muteUntil') : null));

// ── Historique des drops ──────────────────────────────────────────────
ipcMain.handle('history:get', () => store.get('dropHistory'));
ipcMain.handle('history:clear', () => { store.set('dropHistory', []); return true; });

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
  if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
  startTopGuard(); enforceTop();
  overlayWin.webContents.send('drop', {
    type: 'drop',
    media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
    caption: 'TEST DROP',
    from: { id: '0', username: 'You (test)' },
    ts: Date.now(),
    settings: {
      volume: store.get('volume'),
      musicVolume: store.get('musicVolume'),
      opacity: store.get('opacity'),
      duration: store.get('duration'),
      videoDuration: store.get('videoDuration'),
      soundOnArrival: store.get('soundOnArrival'),
    },
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

function startCursorPoll() {
  if (_cursorPollTimer) return;
  _cursorPollTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const pt  = screen.getCursorScreenPoint();
    const b   = overlayWin.getBounds();
    overlayWin.webContents.send('overlay:cursor', { x: pt.x - b.x, y: pt.y - b.y });
  }, 16);
}

function stopCursorPoll() {
  if (_cursorPollTimer) { clearInterval(_cursorPollTimer); _cursorPollTimer = null; }
}

ipcMain.on('overlay:watch-cursor',   () => startCursorPoll());
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
