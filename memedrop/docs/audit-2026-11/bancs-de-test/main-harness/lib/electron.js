'use strict';
// Stand-in for the 'electron' module (main process) plus a simulated
// renderer per BrowserWindow. Each renderer runs the REAL preload.js of the
// code under test (sandboxed-preload rules: only electron/events/timers/url
// can be required) and talks to the main process only through what the
// preload exposes on `window.memedrop` — exactly like overlay.js and
// settings.js do. Every IPC payload crosses a structuredClone, like
// Electron's IPC.
//
// Everything observable is reported to the harness (H): window creation and
// method calls, webContents.send traffic, tray/menu content, shell, login
// items, shortcuts, dialogs, notifications, app lifecycle.

const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { ORIG } = require('./fsprobe');

function makeEvent(extra = {}) {
  const ev = { defaultPrevented: false, ...extra };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  return ev;
}

const DEFAULT_DISPLAYS = [
  { id: 2528732444, label: 'DELL U2419H', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
  { id: 2779098405, label: 'LG 27GL850', bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, scaleFactor: 1 },
];

function fullDisplay(d) {
  return {
    id: d.id, label: d.label,
    bounds: { ...d.bounds }, workArea: { ...d.workArea },
    size: { width: d.bounds.width, height: d.bounds.height },
    workAreaSize: { width: d.workArea.width, height: d.workArea.height },
    scaleFactor: d.scaleFactor, rotation: 0, internal: false, monochrome: false,
    accelerometerSupport: 'unknown', touchSupport: 'unknown', colorDepth: 24,
    colorSpace: '{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}',
    depthPerComponent: 8, displayFrequency: 60, detected: true,
  };
}

function createElectron(H) {
  const windows = [];
  let nextWinId = 1;
  const destroyedError = () => new TypeError('Object has been destroyed');

  // ------------------------------------------------------------------ app
  class App extends EventEmitter {
    constructor() {
      super();
      this._login = { openAtLogin: false, openAsHidden: false, args: [] };
      this._quitState = null;
      this._lock = null;
      this._readyPromise = Promise.resolve();
      this.commandLine = {
        appendSwitch: (name, value) => H.rec('app', 'commandLine.appendSwitch', value === undefined ? [name] : [name, value]),
        appendArgument: (a) => H.rec('app', 'commandLine.appendArgument', [a]),
        hasSwitch: () => false,
        getSwitchValue: () => '',
        removeSwitch: (n) => H.rec('app', 'commandLine.removeSwitch', [n]),
      };
    }
    whenReady() { return this._readyPromise; }
    isReady() { return true; }
    get isPackaged() { return !!H.opts.packaged; }
    getVersion() { return H.appVersion; }
    getName() { return 'MemeDrop'; }
    setName(n) { H.rec('app', 'setName', [n]); }
    getLocale() { return 'fr-FR'; }
    getSystemLocale() { return 'fr-FR'; }
    getPreferredSystemLanguages() { return ['fr-FR']; }
    getAppPath() { return H.appDir; }
    getPath(name) {
      const map = {
        userData: H.userData, appData: path.dirname(H.userData), temp: H.tmpDir, home: H.homeDir,
        logs: path.join(H.userData, 'logs'), sessionData: H.userData, crashDumps: path.join(H.userData, 'Crashpad'),
        exe: path.join(H.homeDir, 'MemeDrop', 'MemeDrop.exe'), module: path.join(H.homeDir, 'MemeDrop', 'MemeDrop.exe'),
        desktop: path.join(H.homeDir, 'Desktop'), documents: path.join(H.homeDir, 'Documents'),
        downloads: path.join(H.homeDir, 'Downloads'), pictures: path.join(H.homeDir, 'Pictures'),
        videos: path.join(H.homeDir, 'Videos'), music: path.join(H.homeDir, 'Music'),
      };
      if (!(name in map)) throw new Error(`Failed to get '${name}' path`);
      return map[name];
    }
    setPath(name, p) { H.rec('app', 'setPath', [name, p]); }
    setAppUserModelId(id) { H.rec('app', 'setAppUserModelId', [id]); }
    disableHardwareAcceleration() { H.rec('app', 'disableHardwareAcceleration', []); }
    disableDomainBlockingFor3DAPIs() { H.rec('app', 'disableDomainBlockingFor3DAPIs', []); }
    requestSingleInstanceLock(data) {
      H.rec('app', 'requestSingleInstanceLock', data === undefined ? [] : [data]);
      this._lock = H.opts.lock !== false;
      return this._lock;
    }
    hasSingleInstanceLock() { return !!this._lock; }
    releaseSingleInstanceLock() { H.rec('app', 'releaseSingleInstanceLock', []); this._lock = false; }
    setLoginItemSettings(s) {
      H.rec('app', 'setLoginItemSettings', [s]);
      this._login = { ...this._login, ...(s || {}) };
    }
    getLoginItemSettings() {
      return {
        openAtLogin: !!this._login.openAtLogin, openAsHidden: false,
        wasOpenedAtLogin: !!H.opts.wasOpenedAtLogin, wasOpenedAsHidden: false, restoreState: false,
        executableWillLaunchAtLogin: !!this._login.openAtLogin, launchItems: [],
      };
    }
    setAsDefaultProtocolClient(p) { H.rec('app', 'setAsDefaultProtocolClient', [p]); return true; }
    removeAsDefaultProtocolClient(p) { H.rec('app', 'removeAsDefaultProtocolClient', [p]); return true; }
    isDefaultProtocolClient() { return false; }
    focus(o) { H.rec('app', 'focus', o === undefined ? [] : [o]); }
    hide() { H.rec('app', 'hide', []); }
    show() { H.rec('app', 'show', []); }
    setBadgeCount(n) { H.rec('app', 'setBadgeCount', [n]); return true; }
    getBadgeCount() { return 0; }
    setUserTasks(t) { H.rec('app', 'setUserTasks', [t]); return true; }
    setJumpList(j) { H.rec('app', 'setJumpList', [j]); }
    addRecentDocument(p) { H.rec('app', 'addRecentDocument', [p]); }
    clearRecentDocuments() { H.rec('app', 'clearRecentDocuments', []); }
    getGPUFeatureStatus() { return {}; }
    getAppMetrics() { return []; }
    setAccessibilitySupportEnabled(v) { H.rec('app', 'setAccessibilitySupportEnabled', [v]); }
    exit(code) { H.rec('app', 'exit', [code]); this._quitState = 'quit'; H.appExited('exit'); }
    // Electron: with no 'window-all-closed' listener the app quits by itself.
    _allClosed() {
      if (this.listenerCount('window-all-closed') === 0) { H.rec('lifecycle', 'default-quit-on-window-all-closed', []); this.quit(); return; }
      this.emit('window-all-closed', makeEvent());
    }
    relaunch(o) { H.rec('app', 'relaunch', o === undefined ? [] : [o]); }
    quit() {
      H.rec('app', 'quit', []);
      if (this._quitState) return;
      this._quitState = 'quitting';
      const ev = makeEvent();
      this.emit('before-quit', ev);
      if (ev.defaultPrevented) { this._quitState = null; H.rec('lifecycle', 'quit-cancelled', ['before-quit']); return; }
      for (const w of BrowserWindow.getAllWindows()) {
        w._requestClose();
        if (!w.isDestroyed()) { this._quitState = null; H.rec('lifecycle', 'quit-cancelled', ['window-close'], w); return; }
      }
      const ev2 = makeEvent();
      this.emit('will-quit', ev2);
      if (ev2.defaultPrevented) { this._quitState = null; H.rec('lifecycle', 'quit-cancelled', ['will-quit']); return; }
      this._quitState = 'quit';
      this.emit('quit', makeEvent(), 0);
      H.appExited('quit');
    }
  }
  const app = new App();

  // ----------------------------------------------------------- nativeImage
  class NativeImage {
    constructor(desc) { this._d = desc; }
    isEmpty() { return !!this._d.empty; }
    getSize() { return { ...(this._d.size || { width: 0, height: 0 }) }; }
    resize(o = {}) {
      const s = this._d.empty ? { width: 0, height: 0 } : { width: o.width || o.height || 0, height: o.height || o.width || 0 };
      return new NativeImage({ ...this._d, size: s, resized: { ...o } });
    }
    crop() { return new NativeImage({ ...this._d }); }
    toPNG() { return Buffer.alloc(0); }
    toJPEG() { return Buffer.alloc(0); }
    toBitmap() { return Buffer.alloc(0); }
    toDataURL() { return 'data:image/png;base64,'; }
    getAspectRatio() { const s = this.getSize(); return s.height ? s.width / s.height : 1; }
    setTemplateImage() {}
    isTemplateImage() { return false; }
    addRepresentation() {}
    describe() { return { path: this._d.path || null, empty: !!this._d.empty, size: this.getSize() }; }
  }
  const nativeImage = {
    createFromPath(p) {
      const exists = typeof p === 'string' && p.length > 0 && ORIG.existsSync(p);
      return new NativeImage({ path: p, empty: !exists, size: exists ? { width: 256, height: 256 } : { width: 0, height: 0 } });
    },
    createEmpty() { return new NativeImage({ empty: true }); },
    createFromBuffer(b) { return new NativeImage({ path: '<buffer>', empty: !b || !b.length, size: { width: 16, height: 16 } }); },
    createFromDataURL(u) { return new NativeImage({ path: '<dataurl>', empty: !u, size: { width: 16, height: 16 } }); },
    createFromBitmap() { return new NativeImage({ path: '<bitmap>', empty: false, size: { width: 16, height: 16 } }); },
    createThumbnailFromPath: async (p) => nativeImage.createFromPath(p),
  };
  const describeImage = (img) => (img instanceof NativeImage ? img.describe() : (typeof img === 'string' ? { path: img } : img == null ? null : { type: typeof img }));

  // ---------------------------------------------------------------- screen
  const screen = new EventEmitter();
  const displays = () => (H.opts.displays || DEFAULT_DISPLAYS);
  const primaryId = () => (H.opts.primaryDisplayId != null ? H.opts.primaryDisplayId : displays()[0].id);
  screen.getAllDisplays = () => displays().map(fullDisplay);
  screen.getPrimaryDisplay = () => fullDisplay(displays().find((d) => d.id === primaryId()) || displays()[0]);
  screen.getCursorScreenPoint = () => { H.counters.cursorReads++; const c = H.cursorNow(); return { x: c.x, y: c.y }; };
  screen.getDisplayNearestPoint = (pt) => {
    const d = displays().find((x) => pt.x >= x.bounds.x && pt.x < x.bounds.x + x.bounds.width && pt.y >= x.bounds.y && pt.y < x.bounds.y + x.bounds.height);
    return fullDisplay(d || displays()[0]);
  };
  screen.getDisplayMatching = (r) => screen.getDisplayNearestPoint({ x: r.x, y: r.y });
  screen.dipToScreenPoint = (p) => ({ ...p });
  screen.screenToDipPoint = (p) => ({ ...p });
  screen.dipToScreenRect = (w, r) => ({ ...r });
  screen.screenToDipRect = (w, r) => ({ ...r });

  // --------------------------------------------------------------- webContents
  class WebContents extends EventEmitter {
    constructor(win) {
      super();
      this._win = win;
      this.id = win.id;
      this._devtools = false;
      this._windowOpenHandler = null;
      this.session = { setPermissionRequestHandler: (h) => H.rec('win', 'session.setPermissionRequestHandler', [h ? '<fn>' : null], win), setPermissionCheckHandler: (h) => H.rec('win', 'session.setPermissionCheckHandler', [h ? '<fn>' : null], win), webRequest: { onBeforeRequest() {}, onHeadersReceived() {} } };
    }
    _check() { if (this._win._destroyed) throw destroyedError(); }
    send(channel, ...args) { this._check(); H.mainToRenderer(this._win, channel, args); }
    postMessage(channel, message) { this._check(); H.mainToRenderer(this._win, channel, [message]); }
    sendToFrame(frameId, channel, ...args) { this._check(); H.mainToRenderer(this._win, channel, args); }
    openDevTools(o) { this._check(); H.rec('win', 'webContents.openDevTools', o === undefined ? [] : [o], this._win); this._devtools = true; }
    closeDevTools() { this._check(); H.rec('win', 'webContents.closeDevTools', [], this._win); this._devtools = false; }
    toggleDevTools() { this._check(); H.rec('win', 'webContents.toggleDevTools', [], this._win); this._devtools = !this._devtools; }
    isDevToolsOpened() { return this._devtools; }
    setWindowOpenHandler(h) { this._check(); H.rec('win', 'webContents.setWindowOpenHandler', [typeof h], this._win); this._windowOpenHandler = h; }
    isDestroyed() { return this._win._destroyed; }
    isLoading() { return !!this._win._page && !this._win._renderer.loaded; }
    getURL() { return this._win._pageUrl || ''; }
    getTitle() { return this._win._opts.title || 'MemeDrop'; }
    getOSProcessId() { return 1000 + this._win.id; }
    getProcessId() { return 100 + this._win.id; }
    executeJavaScript(code) { H.rec('win', 'webContents.executeJavaScript', [String(code).slice(0, 200)], this._win); return Promise.resolve(undefined); }
    insertCSS(css) { H.rec('win', 'webContents.insertCSS', [String(css).slice(0, 200)], this._win); return Promise.resolve('css-key'); }
    setBackgroundThrottling(v) { H.rec('win', 'webContents.setBackgroundThrottling', [v], this._win); }
    getBackgroundThrottling() { return false; }
    setAudioMuted(v) { H.rec('win', 'webContents.setAudioMuted', [v], this._win); }
    isAudioMuted() { return false; }
    setFrameRate(v) { H.rec('win', 'webContents.setFrameRate', [v], this._win); }
    invalidate() { H.rec('win', 'webContents.invalidate', [], this._win); }
    setZoomFactor(v) { H.rec('win', 'webContents.setZoomFactor', [v], this._win); }
    getZoomFactor() { return 1; }
    setVisualZoomLevelLimits() { return Promise.resolve(); }
    reload() { H.rec('win', 'webContents.reload', [], this._win); }
    focus() { H.rec('win', 'webContents.focus', [], this._win); }
    setIgnoreMenuShortcuts(v) { H.rec('win', 'webContents.setIgnoreMenuShortcuts', [v], this._win); }
  }

  // ---------------------------------------------------------------- BrowserWindow
  class BrowserWindow extends EventEmitter {
    constructor(opts = {}) {
      super();
      this.id = nextWinId++;
      this._opts = opts;
      this._destroyed = false;
      this._visible = opts.show !== false;
      this._focusable = opts.focusable !== false;
      this._focused = this._visible && this._focusable;
      this._alwaysOnTop = !!opts.alwaysOnTop;
      this._aotLevel = opts.alwaysOnTop ? 'floating' : null;
      this._ignoreMouse = { ignore: false, forward: false };
      this._allWorkspaces = null;
      this._opacity = opts.opacity != null ? opts.opacity : 1;
      const prim = displays().find((d) => d.id === primaryId()) || displays()[0];
      const width = opts.width != null ? opts.width : 800;
      const height = opts.height != null ? opts.height : 600;
      this._bounds = {
        x: opts.x != null ? opts.x : Math.round(prim.workArea.x + (prim.workArea.width - width) / 2),
        y: opts.y != null ? opts.y : Math.round(prim.workArea.y + (prim.workArea.height - height) / 2),
        width, height,
      };
      this._page = null;
      this._pageUrl = null;
      this._loadResolvers = [];
      this.webContents = new WebContents(this);
      this._renderer = new RendererSim(H, this);
      windows.push(this);
      H.windowCreated(this, opts);
    }
    static getAllWindows() { return windows.filter((w) => !w._destroyed); }
    static getFocusedWindow() { return windows.find((w) => !w._destroyed && w._focused) || null; }
    static fromWebContents(wc) { return (wc && wc._win && !wc._win._destroyed) ? wc._win : null; }
    static fromId(id) { return windows.find((w) => w.id === id && !w._destroyed) || null; }

    _check() { if (this._destroyed) throw destroyedError(); }
    _rec(m, args) { H.rec('win', m, args, this); }

    loadFile(file, options) {
      this._check();
      this._rec('loadFile', options === undefined ? [file] : [file, options]);
      const abs = path.resolve(H.appDir, String(file));
      this._page = path.relative(H.appDir, abs).split(path.sep).join('/');
      this._pageUrl = `file://${abs}`;
      H.pageRequested(this);
      return new Promise((resolve) => this._loadResolvers.push(resolve));
    }
    loadURL(url, options) {
      this._check();
      this._rec('loadURL', options === undefined ? [url] : [url, options]);
      let page = String(url);
      if (page.startsWith('file://')) page = path.relative(H.appDir, decodeURIComponent(page.slice(7)).split('?')[0].split('#')[0]).split(path.sep).join('/');
      this._page = page;
      this._pageUrl = String(url);
      H.pageRequested(this);
      return new Promise((resolve) => this._loadResolvers.push(resolve));
    }
    _finishLoad() {
      for (const r of this._loadResolvers.splice(0)) r();
    }

    show() {
      this._check();
      this._rec('show', []);
      const was = this._visible;
      this._visible = true;
      if (this._focusable) this._focused = true;
      if (!was) this.emit('show');
    }
    showInactive() {
      this._check();
      this._rec('showInactive', []);
      const was = this._visible;
      this._visible = true;
      if (!was) this.emit('show');
    }
    hide() {
      this._check();
      this._rec('hide', []);
      const was = this._visible;
      this._visible = false;
      this._focused = false;
      if (was) this.emit('hide');
    }
    isVisible() { this._check(); return this._visible; }
    isDestroyed() { return this._destroyed; }
    focus() { this._check(); this._rec('focus', []); if (this._focusable) { this._focused = true; this.emit('focus'); } }
    blur() { this._check(); this._rec('blur', []); if (this._focused) { this._focused = false; this.emit('blur'); } }
    isFocused() { this._check(); return this._focused; }
    isFocusable() { this._check(); return this._focusable; }
    setFocusable(v) { this._check(); this._rec('setFocusable', [v]); this._focusable = !!v; }
    close() {
      this._check();
      this._rec('close', []);
      this._requestClose();
    }
    _requestClose() {
      if (this._destroyed) return true;
      const ev = makeEvent();
      this.emit('close', ev);
      if (ev.defaultPrevented) return false;
      this._destroy();
      return true;
    }
    destroy() { if (this._destroyed) return; this._rec('destroy', []); this._destroy(); }
    _destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._visible = false;
      this._focused = false;
      this.emit('closed');
      this.webContents.emit('destroyed');
      if (BrowserWindow.getAllWindows().length === 0 && !app._quitState) app._allClosed();
    }
    setAlwaysOnTop(flag, level, relativeLevel) {
      this._check();
      const args = [flag];
      if (level !== undefined) args.push(level);
      if (relativeLevel !== undefined) args.push(relativeLevel);
      this._rec('setAlwaysOnTop', args);
      this._alwaysOnTop = !!flag;
      this._aotLevel = flag ? (level || 'floating') : null;
    }
    isAlwaysOnTop() { this._check(); return this._alwaysOnTop; }
    moveTop() { this._check(); this._rec('moveTop', []); }
    moveAbove(id) { this._check(); this._rec('moveAbove', [id]); }
    setVisibleOnAllWorkspaces(flag, o) { this._check(); this._rec('setVisibleOnAllWorkspaces', o === undefined ? [flag] : [flag, o]); this._allWorkspaces = { flag: !!flag, ...(o || {}) }; }
    isVisibleOnAllWorkspaces() { return !!(this._allWorkspaces && this._allWorkspaces.flag); }
    setIgnoreMouseEvents(ignore, o) {
      this._check();
      this._rec('setIgnoreMouseEvents', o === undefined ? [ignore] : [ignore, o]);
      this._ignoreMouse = { ignore: !!ignore, forward: !!(ignore && o && o.forward) };
    }
    setBounds(b, animate) {
      this._check();
      this._rec('setBounds', animate === undefined ? [b] : [b, animate]);
      const nb = { ...this._bounds };
      for (const k of ['x', 'y', 'width', 'height']) if (b && typeof b[k] === 'number') nb[k] = Math.round(b[k]);
      const moved = nb.x !== this._bounds.x || nb.y !== this._bounds.y;
      const resized = nb.width !== this._bounds.width || nb.height !== this._bounds.height;
      this._bounds = nb;
      if (resized) this.emit('resize');
      if (moved) this.emit('move');
    }
    getBounds() { this._check(); H.counters.getBounds++; return { ...this._bounds }; }
    getContentBounds() { this._check(); return { ...this._bounds }; }
    setContentBounds(b) { this.setBounds(b); }
    getNormalBounds() { this._check(); return { ...this._bounds }; }
    setPosition(x, y) { this._check(); this._rec('setPosition', [x, y]); this._bounds = { ...this._bounds, x, y }; }
    getPosition() { this._check(); return [this._bounds.x, this._bounds.y]; }
    setSize(w, h) { this._check(); this._rec('setSize', [w, h]); this._bounds = { ...this._bounds, width: w, height: h }; }
    getSize() { this._check(); return [this._bounds.width, this._bounds.height]; }
    getContentSize() { return this.getSize(); }
    center() { this._check(); this._rec('center', []); }
    setOpacity(v) { this._check(); this._rec('setOpacity', [v]); this._opacity = v; }
    getOpacity() { this._check(); return this._opacity; }
    getTitle() { return this._opts.title || 'MemeDrop'; }
    getNativeWindowHandle() { return Buffer.alloc(8); }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    isNormal() { return true; }
    isModal() { return false; }
    isResizable() { return this._opts.resizable !== false; }
    isMovable() { return this._opts.movable !== false; }
    isKiosk() { return false; }
    getParentWindow() { return null; }
    getChildWindows() { return []; }
    getMediaSourceId() { return `window:${this.id}:0`; }
  }
  // Remaining BrowserWindow setters: record and ignore.
  for (const m of ['setTitle', 'setSkipTaskbar', 'setResizable', 'setMovable', 'setMinimizable', 'setMaximizable',
    'setClosable', 'setFullScreenable', 'setMenuBarVisibility', 'setAutoHideMenuBar', 'removeMenu', 'setMenu',
    'setBackgroundColor', 'setHasShadow', 'setContentProtection', 'setIcon', 'flashFrame', 'setProgressBar',
    'setOverlayIcon', 'setThumbarButtons', 'setAppDetails', 'setShape', 'setKiosk', 'setFullScreen', 'minimize',
    'maximize', 'unmaximize', 'restore', 'setMinimumSize', 'setMaximumSize', 'setAspectRatio', 'setEnabled',
    'setThumbnailClip', 'setThumbnailToolTip', 'setVibrancy', 'setBackgroundMaterial', 'setTitleBarOverlay',
    'setParentWindow', 'setSimpleFullScreen', 'setWindowButtonVisibility', 'setFocusable']) {
    if (BrowserWindow.prototype[m]) continue;
    BrowserWindow.prototype[m] = function (...args) { this._check(); this._rec(m, args); };
  }

  // ---------------------------------------------------------------- Menu
  class MenuItem {
    constructor(o = {}) {
      if (o.label === undefined && o.role === undefined && o.type === undefined && o.submenu === undefined) {
        throw new Error('Invalid template for MenuItem: must have at least one of label, role or type');
      }
      Object.assign(this, o);
      this.type = o.type || (o.submenu ? 'submenu' : 'normal');
      this.label = o.label !== undefined ? o.label : '';
      this.enabled = o.enabled !== undefined ? !!o.enabled : true;
      this.visible = o.visible !== undefined ? !!o.visible : true;
      this.checked = !!o.checked;
      if (o.submenu && !(o.submenu instanceof Menu)) this.submenu = Menu._build(o.submenu);
    }
  }
  class Menu extends EventEmitter {
    constructor() { super(); this.items = []; }
    static _build(tpl) {
      if (!Array.isArray(tpl)) throw new TypeError('Invalid template for Menu: Menu template must be an array');
      const m = new Menu();
      for (const t of tpl) m.append(t instanceof MenuItem ? t : new MenuItem(t));
      return m;
    }
    static buildFromTemplate(tpl) { H.counters.menuBuilds++; return Menu._build(tpl); }
    static setApplicationMenu(m) { H.rec('app', 'Menu.setApplicationMenu', [m ? describeMenu(m) : null]); Menu._app = m; }
    static getApplicationMenu() { return Menu._app || null; }
    append(item) { this.items.push(item instanceof MenuItem ? item : new MenuItem(item)); }
    insert(pos, item) { this.items.splice(pos, 0, item instanceof MenuItem ? item : new MenuItem(item)); }
    getMenuItemById(id) {
      for (const it of this.items) {
        if (it.id === id) return it;
        if (it.submenu) { const r = it.submenu.getMenuItemById(id); if (r) return r; }
      }
      return null;
    }
    popup(o) { H.rec('tray', 'menu.popup', []); }
    closePopup() {}
  }
  function describeMenu(menu) {
    if (!menu) return null;
    const items = Array.isArray(menu) ? menu : menu.items;
    if (!Array.isArray(items)) return { type: typeof menu };
    return items.map((it) => {
      if (it.type === 'separator') return { type: 'separator', ...(it.visible === false ? { visible: false } : {}) };
      const d = { label: it.label, type: it.type };
      if (it.enabled === false) d.enabled = false;
      if (it.visible === false) d.visible = false;
      if (it.type === 'checkbox' || it.type === 'radio') d.checked = !!it.checked;
      if (it.role) d.role = it.role;
      if (it.accelerator) d.accelerator = it.accelerator;
      if (it.submenu) d.submenu = describeMenu(it.submenu);
      return d;
    });
  }
  function findMenuItem(menu, label) {
    const items = menu ? (Array.isArray(menu) ? menu : menu.items) : [];
    for (const it of items || []) {
      if (it.label === label) return { item: it, parent: items };
      if (it.submenu) { const r = findMenuItem(it.submenu, label); if (r) return r; }
    }
    return null;
  }
  function clickMenuItem(menu, label) {
    const found = findMenuItem(menu, label);
    if (!found) return { error: `no menu item labelled ${JSON.stringify(label)}` };
    const it = found.item;
    if (it.enabled === false || it.visible === false) return { error: 'item disabled or hidden' };
    if (it.type === 'checkbox') it.checked = !it.checked;
    if (it.type === 'radio') { for (const s of found.parent) if (s.type === 'radio') s.checked = false; it.checked = true; }
    const focused = BrowserWindow.getFocusedWindow();
    if (typeof it.click === 'function') it.click(it, focused || undefined, { triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    else if (it.role === 'quit') app.quit();
    else if (it.role) H.rec('tray', 'menu.role', [it.role]);
    return { ok: true };
  }

  // ---------------------------------------------------------------- Tray
  class Tray extends EventEmitter {
    constructor(image, guid) {
      super();
      this._image = image;
      this._menu = null;
      this._tooltip = '';
      this._title = '';
      this._destroyed = false;
      H.rec('tray', 'new Tray', [describeImage(image)]);
      H.trays.push(this);
    }
    // What the user can see (menu content, tooltip) is recorded as a
    // timestamped event whenever it actually changes; the number of
    // rebuild calls is only a counter. Calls made in the same tick are
    // coalesced (a menu+tooltip update is one visible change, whatever the
    // call order).
    _changed() {
      if (this._pendingSnap) return;
      this._pendingSnap = true;
      queueMicrotask(() => {
        this._pendingSnap = false;
        const snap = JSON.stringify({ tooltip: this._tooltip, menu: describeMenu(this._menu) });
        if (snap === this._lastSnap) return;
        this._lastSnap = snap;
        H.trayChanged(this, JSON.parse(snap));
      });
    }
    setContextMenu(menu) { H.counters.traySetContextMenu++; this._menu = menu; this._changed(); }
    setToolTip(t) { H.counters.traySetToolTip++; this._tooltip = t; this._changed(); }
    setImage(img) { H.rec('tray', 'setImage', [describeImage(img)]); this._image = img; }
    setPressedImage(img) { H.rec('tray', 'setPressedImage', [describeImage(img)]); }
    setTitle(t) { this._title = t; }
    getTitle() { return this._title; }
    setIgnoreDoubleClickEvents(v) { H.rec('tray', 'setIgnoreDoubleClickEvents', [v]); }
    displayBalloon(o) { H.rec('tray', 'displayBalloon', [o]); }
    removeBalloon() { H.rec('tray', 'removeBalloon', []); }
    focus() {}
    popUpContextMenu(m) { H.rec('tray', 'popUpContextMenu', [m ? describeMenu(m) : null]); }
    closeContextMenu() {}
    getBounds() { return { x: 1800, y: 1040, width: 24, height: 40 }; }
    isDestroyed() { return this._destroyed; }
    destroy() { H.rec('tray', 'destroy', []); this._destroyed = true; }
    snapshot() {
      return { image: describeImage(this._image), tooltip: this._tooltip, menu: describeMenu(this._menu), destroyed: this._destroyed, ...(this._title ? { title: this._title } : {}) };
    }
  }

  // ---------------------------------------------------------------- ipcMain
  class IpcMain extends EventEmitter {
    constructor() { super(); this._handlers = new Map(); }
    handle(ch, fn) {
      if (this._handlers.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
      if (typeof fn !== 'function') throw new TypeError(`Expected handler to be a function, but found type '${typeof fn}'`);
      this._handlers.set(ch, fn);
    }
    handleOnce(ch, fn) {
      this.handle(ch, (...a) => { this._handlers.delete(ch); return fn(...a); });
    }
    removeHandler(ch) { this._handlers.delete(ch); }
  }
  const ipcMain = new IpcMain();

  // ---------------------------------------------------------------- misc
  const shell = {
    openExternal: (url, o) => { H.rec('shell', 'openExternal', o === undefined ? [url] : [url, o]); return Promise.resolve(); },
    openPath: (p) => { H.rec('shell', 'openPath', [p]); return Promise.resolve(''); },
    showItemInFolder: (p) => { H.rec('shell', 'showItemInFolder', [p]); },
    beep: () => { H.rec('shell', 'beep', []); },
    trashItem: (p) => { H.rec('shell', 'trashItem', [p]); return Promise.resolve(); },
  };
  const shortcuts = new Map();
  const globalShortcut = {
    register: (acc, cb) => { H.rec('shortcut', 'register', [acc]); shortcuts.set(acc, cb); return true; },
    registerAll: (accs, cb) => { H.rec('shortcut', 'registerAll', [accs]); for (const a of accs) shortcuts.set(a, cb); },
    isRegistered: (acc) => shortcuts.has(acc),
    unregister: (acc) => { H.rec('shortcut', 'unregister', [acc]); shortcuts.delete(acc); },
    unregisterAll: () => { H.rec('shortcut', 'unregisterAll', []); shortcuts.clear(); },
    _trigger: (acc) => { const cb = shortcuts.get(acc); if (!cb) return false; cb(); return true; },
  };
  const powerMonitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => 'active', getSystemIdleTime: () => 0, isOnBatteryPower: () => false,
    onBatteryPower: false, getCurrentThermalState: () => 'nominal',
  });
  const dialog = {
    showMessageBox: (...a) => { H.rec('dialog', 'showMessageBox', a.filter((x) => !(x instanceof BrowserWindow))); return Promise.resolve({ response: 0, checkboxChecked: false }); },
    showMessageBoxSync: (...a) => { H.rec('dialog', 'showMessageBoxSync', a.filter((x) => !(x instanceof BrowserWindow))); return 0; },
    showErrorBox: (title, content) => { H.rec('dialog', 'showErrorBox', [title, content]); },
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showOpenDialogSync: () => undefined,
    showSaveDialog: () => Promise.resolve({ canceled: true }),
    showSaveDialogSync: () => undefined,
  };
  class Notification extends EventEmitter {
    constructor(o = {}) { super(); this._o = o; H.rec('notification', 'new Notification', [o]); }
    static isSupported() { return true; }
    show() { H.rec('notification', 'show', [this._o.title || null]); }
    close() { H.rec('notification', 'close', []); }
  }
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system', shouldUseHighContrastColors: false });
  const session = { defaultSession: { setPermissionRequestHandler: (h) => H.rec('app', 'session.setPermissionRequestHandler', [h ? '<fn>' : null]), setPermissionCheckHandler: (h) => H.rec('app', 'session.setPermissionCheckHandler', [h ? '<fn>' : null]), webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, clearCache: () => Promise.resolve(), setProxy: () => Promise.resolve(), on() {} }, fromPartition: () => session.defaultSession };
  const netModule = {
    isOnline: () => true, online: true,
    request: () => { throw new Error('electron.net is disabled in the harness'); },
    fetch: () => Promise.reject(new Error('electron.net is disabled in the harness')),
  };
  const webContentsModule = {
    getAllWebContents: () => BrowserWindow.getAllWindows().map((w) => w.webContents),
    getFocusedWebContents: () => { const w = BrowserWindow.getFocusedWindow(); return w ? w.webContents : null; },
    fromId: (id) => { const w = BrowserWindow.fromId(id); return w ? w.webContents : null; },
  };
  const systemPreferences = Object.assign(new EventEmitter(), { getAccentColor: () => '0078d7ff', getColor: () => '#000000', isAeroGlassEnabled: () => true, getAnimationSettings: () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false }) });
  const crashReporter = { start: (o) => H.rec('app', 'crashReporter.start', [o]), getLastCrashReport: () => null, getUploadedReports: () => [] };
  const protocol = { registerSchemesAsPrivileged: (s) => H.rec('app', 'protocol.registerSchemesAsPrivileged', [s]), handle: (s) => H.rec('app', 'protocol.handle', [s]), registerFileProtocol: (s) => H.rec('app', 'protocol.registerFileProtocol', [s]) };
  const clipboard = { writeText: (t) => H.rec('app', 'clipboard.writeText', [t]), readText: () => '' };

  const mainModule = {
    app, BrowserWindow, screen, ipcMain, shell, Tray, Menu, MenuItem, nativeImage, globalShortcut,
    powerMonitor, dialog, Notification, nativeTheme, session, net: netModule, webContents: webContentsModule,
    systemPreferences, crashReporter, protocol, clipboard,
    powerSaveBlocker: { start: (t) => { H.rec('app', 'powerSaveBlocker.start', [t]); return 1; }, stop: () => {}, isStarted: () => false },
  };
  const IGNORED = new Set(['__esModule', 'default', 'then', 'inspect', 'constructor', 'toJSON', 'valueOf', 'toString', 'asymmetricMatch', '$$typeof', 'nodeType']);
  const proxied = new Proxy(mainModule, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && !IGNORED.has(prop)) H.recUnknownApi(`electron.${prop}`);
      return target[prop];
    },
  });

  // ---------------------------------------------------------------- renderer side
  class RendererSim {
    constructor(H_, win) {
      this.win = win;
      this.loaded = false;
      this.listeners = new Map();
      this.world = {};
      this.subscribed = [];
      this.currentChannel = null;
      const sim = this;
      const ipcRenderer = Object.assign(new EventEmitter(), {
        invoke: (ch, ...args) => H.rendererInvoke(win, ch, args),
        send: (ch, ...args) => { H.rendererSend(win, ch, args); },
        sendSync: (ch, ...args) => H.rendererSendSync(win, ch, args),
        sendToHost: (ch, ...args) => H.rec('win', 'ipcRenderer.sendToHost', [ch, ...args], win),
        postMessage: (ch, msg) => { H.rendererSend(win, ch, [msg]); },
      });
      // listeners are kept in our own map so delivery is fully controlled
      ipcRenderer.on = ipcRenderer.addListener = (ch, l) => { sim._add(ch, l, false); return ipcRenderer; };
      ipcRenderer.once = (ch, l) => { sim._add(ch, l, true); return ipcRenderer; };
      ipcRenderer.removeListener = ipcRenderer.off = (ch, l) => { sim._remove(ch, l); return ipcRenderer; };
      ipcRenderer.removeAllListeners = (ch) => { if (ch === undefined) sim.listeners.clear(); else sim.listeners.delete(ch); return ipcRenderer; };
      ipcRenderer.listenerCount = (ch) => (sim.listeners.get(ch) || []).length;
      this.ipcRenderer = ipcRenderer;
      this.electron = {
        contextBridge: {
          exposeInMainWorld: (key, api) => { sim.world[key] = api; },
          exposeInIsolatedWorld: (id, key, api) => { sim.world[key] = api; },
        },
        ipcRenderer,
        webFrame: { setZoomFactor() {}, getZoomFactor: () => 1, setZoomLevel() {}, getZoomLevel: () => 0, setVisualZoomLevelLimits: () => Promise.resolve(), insertCSS: () => 'key', removeInsertedCSS() {}, executeJavaScript: () => Promise.resolve() },
        webUtils: { getPathForFile: () => '' },
        crashReporter: { addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}) },
        nativeImage,
      };
    }
    _add(ch, l, once) {
      if (!this.listeners.has(ch)) this.listeners.set(ch, []);
      this.listeners.get(ch).push({ l, once });
    }
    _remove(ch, l) {
      const arr = this.listeners.get(ch);
      if (!arr) return;
      const i = arr.findIndex((x) => x.l === l);
      if (i >= 0) arr.splice(i, 1);
    }
    // returns number of listeners that received the message
    deliver(ch, clonedArgs) {
      const arr = (this.listeners.get(ch) || []).slice();
      if (!arr.length) return 0;
      const ev = { sender: this.ipcRenderer, senderId: 0, ports: [] };
      this.currentChannel = ch;
      try {
        for (const x of arr) {
          if (x.once) this._remove(ch, x.l);
          try { x.l(ev, ...clonedArgs); } catch (e) { H.recError(`renderer listener (${ch})`, e, this.win); }
        }
      } finally {
        this.currentChannel = null;
      }
      return arr.length;
    }
    load() {
      const preload = this.win._opts && this.win._opts.webPreferences && this.win._opts.webPreferences.preload;
      if (preload) this._runPreload(String(preload));
      this.loaded = true;
    }
    _runPreload(file) {
      let src;
      try { src = ORIG.readFileSync(file, 'utf8'); } catch (e) { H.recError('preload (read)', e, this.win); return; }
      const sim = this;
      const fakeWindow = Object.assign(new EventEmitter(), { location: { href: this.win._pageUrl || '' } });
      fakeWindow.addEventListener = (n, l) => fakeWindow.on(n, l);
      fakeWindow.removeEventListener = (n, l) => fakeWindow.removeListener(n, l);
      const fakeDocument = Object.assign(new EventEmitter(), { readyState: 'complete' });
      fakeDocument.addEventListener = (n, l) => fakeDocument.on(n, l);
      fakeDocument.removeEventListener = (n, l) => fakeDocument.removeListener(n, l);
      const fakeProcess = { type: 'renderer', platform: 'win32', arch: 'x64', versions: { ...process.versions, electron: '33.4.11', chrome: '130.0.6723.191' }, env: {}, argv: [], contextIsolated: true, sandboxed: true, isMainFrame: true, on() {}, once() {}, removeListener() {} };
      const req = (id) => {
        const bare = String(id).replace(/^node:/, '');
        if (bare === 'electron' || bare === 'electron/renderer' || bare === 'electron/common') return sim.electron;
        if (bare === 'events' || bare === 'timers' || bare === 'url') return require(bare);
        const e = new Error(`module not found: ${id}`);
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      };
      const mod = { exports: {} };
      try {
        const fn = vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname', 'process', 'Buffer', 'global', 'window', 'document'], { filename: file });
        fn.call(fakeWindow, mod.exports, req, mod, file, path.dirname(file), fakeProcess, Buffer, fakeWindow, fakeWindow, fakeDocument);
      } catch (e) {
        H.recError('preload', e, this.win);
      }
    }
  }

  return { main: proxied, raw: mainModule, BrowserWindow, Tray, describeMenu, clickMenuItem, globalShortcut, screen, ipcMain, app, windows };
}

module.exports = { createElectron, DEFAULT_DISPLAYS, makeEvent };
