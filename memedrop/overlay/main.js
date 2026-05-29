// main.js — MemeDrop overlay (Electron main process)
const { app, BrowserWindow, screen, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
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
    opacity: 1.0,
    duration: 4,
    videoDuration: 30,
    soundOnArrival: true,
    language: 'en',
    autostart: false,
    overlayDisplayId: null,
  },
});

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

function createTray() {
  const icon = nativeImage.createFromPath(iconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));

  const menu = Menu.buildFromTemplate([
    { label: 'MemeDrop',         enabled: false },
    { type: 'separator' },
    { label: 'Open settings…',   click: () => createSettingsWindow() },
    { label: 'Toggle overlay',
      click: () => {
        if (overlayWin && overlayWin.isVisible()) overlayWin.hide();
        else { createOverlayWindow(); overlayWin.show(); }
      } },
    { label: 'Force on top',     click: enforceTop },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('MemeDrop');
  tray.on('click', () => createSettingsWindow());
  tray.setContextMenu(menu);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket client
// ─────────────────────────────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connState = { status: 'disconnected', code: null, user: null, links: null };

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
  const url = store.get('serverUrl');
  setState({ status: 'connecting', code: null, user: null, links: null });

  try { ws = new WebSocket(url); }
  catch (err) { console.error('[ws] construct error:', err.message); scheduleReconnect(); return; }

  ws.on('open', () => { reconnectAttempts = 0; console.log('[ws] connected to', url); });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'pairing_code':
        // If we're already linked, this is an extension code for adding more
        // guilds. Don't drop the linked state — just update the visible code.
        if (connState.status === 'linked') {
          setState({ code: msg.code });
        } else {
          setState({ status: 'awaiting_link', code: msg.code, user: null, links: null });
        }
        break;
      case 'linked':
        setState({ status: 'linked', code: null, user: msg.user, links: msg.links || { scope: 'guild', guilds: [] } }); break;
      case 'links_update':
        setState({ links: msg.links }); break;
      case 'unlinked':
        setState({ status: 'connecting', code: null, user: null, links: null }); break;
      case 'drop':
        if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
        startTopGuard(); enforceTop();
        overlayWin.webContents.send('drop', {
          ...msg,
          settings: {
            volume: store.get('volume'),
            opacity: store.get('opacity'),
            duration: store.get('duration'),
            videoDuration: store.get('videoDuration'),
            soundOnArrival: store.get('soundOnArrival'),
          },
        });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' })); break;
    }
  });

  ws.on('close', () => { setState({ status: 'disconnected', code: null, links: null }); scheduleReconnect(); });
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
  opacity:        store.get('opacity'),
  duration:       store.get('duration'),
  videoDuration:  store.get('videoDuration'),
  soundOnArrival: store.get('soundOnArrival'),
  language:       store.get('language'),
  autostart:      store.get('autostart'),
  overlayDisplayId: store.get('overlayDisplayId'),
}));

ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  if ('autostart' in patch) {
    app.setLoginItemSettings({ openAtLogin: !!patch.autostart, openAsHidden: true });
  }
  if ('serverUrl' in patch) {
    try { ws && ws.close(); } catch {}
    connectWS();
  }
  if ('overlayDisplayId' in patch) { repositionOverlay(); enforceTop(); }
  if (overlayWin && !overlayWin.isDestroyed() &&
      ('volume' in patch || 'opacity' in patch)) {
    const livePatch = {};
    if ('volume'  in patch) livePatch.volume  = patch.volume;
    if ('opacity' in patch) livePatch.opacity = patch.opacity;
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

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createSettingsWindow());

  if (process.platform === 'win32') app.setAppUserModelId('com.memedrop.overlay');

  app.whenReady().then(() => {
    createOverlayWindow();
    createSettingsWindow();
    createTray();
    connectWS();

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
  app.on('before-quit', () => { app.isQuitting = true; stopTopGuard(); });
}
