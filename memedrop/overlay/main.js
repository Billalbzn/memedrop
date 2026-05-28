// main.js — MemeDrop overlay (Electron main process)
const { app, BrowserWindow, screen, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');

const DEFAULT_SERVER =
  process.env.DEFAULT_SERVER || 'wss://memedrop-production-3106.up.railway.app';

// ─────────────────────────────────────────────────────────────────────────────
// GPU / Chromium flags
//
// On a "stay on top of a game" overlay, both choices have tradeoffs:
//   - Hardware accel ON: smooth animations but the GPU shares cycles with the
//     game, which can cause perceived stutter.
//   - Hardware accel OFF: zero GPU contention with the game, but our
//     transparent compositor work falls onto the CPU.
//
// For most users a game-friendly default is HW-accel OFF on the overlay app:
// memes are small, simple, and rendered briefly; the win from not competing
// with the GPU is bigger than the loss from CPU rendering.
//
// `disable-background-timer-throttling` is added back because we DO want our
// reconnect timers to run when the user is in a game (Electron pauses bg
// timers by default after focus loss).
// ─────────────────────────────────────────────────────────────────────────────
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const store = new Store({
  defaults: {
    serverUrl: DEFAULT_SERVER,
    volume: 0.75,
    opacity: 1.0,
    duration: 4,
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
let hasActiveDrop = false;     // is at least one meme on screen right now?

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

// ─────────────────────────────────────────────────────────────────────────────
// Top-guard: check that we ARE on top, only re-assert if we slipped.
// This avoids the periodic moveTop() flicker that the previous version had.
// ─────────────────────────────────────────────────────────────────────────────
function enforceTop() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    if (!overlayWin.isAlwaysOnTop()) {
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
    }
    overlayWin.moveTop();
  } catch (e) { /* ignore */ }
}

// Polling cadence: only run when there's actually something to display.
function startTopGuard() {
  if (topGuardTimer) return;
  topGuardTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    // Only re-assert if we lost the "on top" state — no spamming moveTop.
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
      // The overlay renders nothing 99% of the time, but Chromium still pumps
      // frames. Limiting offscreen frame rate doesn't apply to visible windows,
      // but `paintWhenInitiallyHidden:false` keeps boot cheap.
      paintWhenInitiallyHidden: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  overlayWin.on('blur', () => {
    // Quick re-check on focus loss — don't call moveTop unconditionally.
    if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isAlwaysOnTop()) {
      enforceTop();
    }
  });

  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    overlayWin.show();
    enforceTop();
    // Don't start the guard immediately; we'll start it on first drop and
    // stop it when the stage clears (lower idle CPU usage).
  });

  screen.on('display-metrics-changed', () => { repositionOverlay(); enforceTop(); });
  screen.on('display-added',   () => { repositionOverlay(); enforceTop(); });
  screen.on('display-removed', () => { repositionOverlay(); enforceTop(); });

  return overlayWin;
}

function repositionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const d = getTargetDisplay();
  overlayWin.setBounds(d.bounds);
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 460,
    height: 780,
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
let connState = { status: 'disconnected', code: null, user: null };

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
  setState({ status: 'connecting', code: null, user: null });

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[ws] construct error:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log('[ws] connected to', url);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'pairing_code':
        setState({ status: 'awaiting_link', code: msg.code, user: null });
        break;
      case 'linked':
        setState({ status: 'linked', code: null, user: msg.user });
        break;
      case 'unlinked':
        // We don't immediately go to 'connected' — the bot is going to send
        // a fresh `pairing_code` right after. We keep current state until then.
        setState({ status: 'connecting', code: null, user: null });
        break;
      case 'drop':
        if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
        hasActiveDrop = true;
        startTopGuard(); // ensure z-order while something is visible
        enforceTop();
        overlayWin.webContents.send('drop', {
          ...msg,
          settings: {
            volume:         store.get('volume'),
            opacity:        store.get('opacity'),
            duration:       store.get('duration'),
            soundOnArrival: store.get('soundOnArrival'),
          },
        });
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    setState({ status: 'disconnected', code: null });
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
// IPC
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => ({
  serverUrl:      store.get('serverUrl'),
  volume:         store.get('volume'),
  opacity:        store.get('opacity'),
  duration:       store.get('duration'),
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
  if ('overlayDisplayId' in patch) {
    repositionOverlay();
    enforceTop();
  }
  // Live-push relevant settings to the overlay so on-screen videos can react
  // to volume/opacity changes in real time.
  if (overlayWin && !overlayWin.isDestroyed() &&
      ('volume' in patch || 'opacity' in patch)) {
    const livePatch = {};
    if ('volume'  in patch) livePatch.volume  = patch.volume;
    if ('opacity' in patch) livePatch.opacity = patch.opacity;
    overlayWin.webContents.send('settings-update', livePatch);
  }
  return true;
});

ipcMain.handle('displays:list', () => {
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
});

ipcMain.handle('connection:get', () => connState);

ipcMain.handle('connection:reconnect', () => {
  try { ws && ws.close(); } catch {}
  connectWS();
  return true;
});

ipcMain.on('test-drop', () => {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
  hasActiveDrop = true;
  startTopGuard();
  enforceTop();
  overlayWin.webContents.send('drop', {
    type: 'drop',
    media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
    caption: 'TEST DROP',
    from: { id: '0', username: 'You (test)' },
    ts: Date.now(),
    settings: {
      volume:         store.get('volume'),
      opacity:        store.get('opacity'),
      duration:       store.get('duration'),
      soundOnArrival: store.get('soundOnArrival'),
    },
  });
});

// Renderer tells us when the stage becomes empty — we can stop the top guard
// to spare CPU until the next drop arrives.
ipcMain.on('stage-empty', () => {
  hasActiveDrop = false;
  stopTopGuard();
});

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
