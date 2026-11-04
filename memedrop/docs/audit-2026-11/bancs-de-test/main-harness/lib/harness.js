'use strict';
// Harness core for ONE scenario process: wires the virtual clock, the fs
// probe, the stub modules, the fake bot and the simulated renderers around
// the code under test, records everything observable per step, and
// serializes a normalized transcript.

const fs = require('fs');
const path = require('path');
const util = require('util');
const Module = require('module');

const { FakeClock, REAL } = require('./clock');
const { FsProbe, ORIG, zero } = require('./fsprobe');
const { canon, normalizeStrings } = require('./canon');
const { Net, createWsModule, FakeBot, tokenFor } = require('./net');
const { createElectron, makeEvent } = require('./electron');
const { createStoreModule } = require('./store');
const { createUpdaterModule } = require('./updater');

const EPOCH = Date.UTC(2026, 0, 15, 12, 0, 0); // Thu 2026-01-15 12:00:00 UTC (TZ=UTC)
const APP_VERSION = '1.0.0-harness';

// What each renderer page does when it loads (mirrors src/overlay.js and
// src/settings.js of the reference code). Subscriptions are additionally
// discovered by scanning the page's scripts for `memedrop.onXxx`.
const PAGE_INIT_CALLS = {
  overlay: ['getSettings'],
  settings: ['getHistory', 'getConnection', 'getUpdateState', 'getSettings', 'isQuietHoursActive', 'listDisplays', 'getVersion'],
};
const PAGE_SUBS_FALLBACK = {
  overlay: ['onCursor', 'onDrop', 'onSettingsUpdate'],
  settings: ['onHistory', 'onConnection', 'onUpdateState'],
};

const realNow = () => REAL.perfNow();
const realImmediate = () => new Promise((r) => REAL.setImmediate(r));
const realSleep = (ms) => new Promise((r) => REAL.setTimeout(r, ms));

function pageBase(p) {
  if (!p) return 'window';
  return path.basename(String(p).split('?')[0]).replace(/\.html?$/i, '');
}

function errText(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function newStep(label, t, meta) {
  return {
    label, t, meta: meta || {},
    result: undefined,
    ipc: [], unobserved: [],
    win: [], winCreated: [],
    app: [], tray: [], shell: [], updater: [], shortcut: [], dialog: [], notification: [], lifecycle: [],
    net: new Map(), netErrors: [],
    console: [], errors: [], notes: [], unknownApi: [],
  };
}

class Harness {
  constructor({ appDir, workDir, scenario }) {
    this.appDir = path.resolve(appDir);
    this.workDir = workDir;
    this.scenarioName = scenario;
    this.homeDir = path.join(workDir, 'home');
    this.userData = path.join(this.homeDir, 'AppData', 'Roaming', 'MemeDrop');
    this.tmpDir = path.join(workDir, 'tmp');
    this.appVersion = APP_VERSION;
    this.opts = { packaged: false, lock: true, wasOpenedAtLogin: false };
    this.cursor = { x: 500, y: 400 };
    this.updaterScript = { check: [], download: null };
    this.counters = { cursorReads: 0, getBounds: 0, menuBuilds: 0, traySetContextMenu: 0, traySetToolTip: 0, ipcSends: 0, ipcInvokes: 0, ipcRendererSends: 0, deferredTimersRun: 0 };
    // One-shot timers created during a step with a delay <= this window are
    // run before the step ends, at the same virtual instant: a deferral like
    // setTimeout(fn, 0) then behaves like setImmediate instead of landing in
    // whichever later step happens to move the clock. (The reference code
    // creates no such timer, so this never changes its transcript.)
    this.deferWindowMs = 50;
    this.trays = [];
    this.storeInstances = [];
    this.steps = [];
    this.cur = null;
    this.orphans = [];
    this.labelCount = new Map();
    this.pageQueue = [];
    this.pageInfoCache = new Map();
    this.exited = null;
    this.skipped = [];
    this.notesSeen = new Set();
    this.unknownSeen = new Set();
    this.booted = false;
    this.final = {};
  }

  // ------------------------------------------------------------------ setup
  async init() {
    for (const d of [this.homeDir, this.tmpDir, path.dirname(this.userData)]) fs.mkdirSync(d, { recursive: true });
    process.env.TZ = 'UTC';
    this.clock = new FakeClock(EPOCH);
    this.clock.install();
    this.clock.onTimerError = (e) => this.recError('timer callback', e);
    this.fs = new FsProbe();
    this.fs.addRoot(this.userData);
    this.fs.install();
    this.net = new Net(this);
    this.bot = new FakeBot(this, this.net);
    await this.bot.start();
    this.port = this.bot.port;

    this.electron = createElectron(this);
    this.electronMain = this.electron.raw;
    this.StoreClass = createStoreModule(this);
    this.updaterModule = createUpdaterModule(this);
    this.WsClass = createWsModule(this.net);

    const stubs = {
      electron: this.electron.main, 'electron/main': this.electron.main, 'electron/common': this.electron.main,
      'electron-store': this.StoreClass, 'electron-updater': this.updaterModule, ws: this.WsClass,
    };
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return `harness-stub:${request}`;
      return origResolve.call(this, request, parent, isMain, options);
    };
    for (const [name, exp] of Object.entries(stubs)) {
      const id = `harness-stub:${name}`;
      const m = new Module(id, null);
      m.filename = id;
      m.loaded = true;
      m.exports = exp;
      m.paths = [];
      Module._cache[id] = m;
    }

    // console capture (the harness itself writes to process.stderr)
    this.realConsole = { ...console };
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      // stack frames are dropped: they point into the harness/stubs and
      // would make the transcript depend on the harness's own location
      console[level] = (...args) => this.rec('console', level, [util.format(...args).split('\n').filter((l) => !/^\s+at\s/.test(l)).join('\n')]);
    }
    process.on('uncaughtException', (e) => this.recError('uncaughtException', e));
    process.on('unhandledRejection', (e) => this.recError('unhandledRejection', e));
  }

  t() { return this.clock.now - this.clock.epoch; }

  // --------------------------------------------------------------- recording
  _step() {
    if (this.cur) return this.cur;
    const o = newStep('(between steps)', this.t());
    this.orphans.push(o);
    return o;
  }
  rec(cat, m, args, win) {
    const s = this._step();
    const e = { t: this.t(), m, args: args || [] };
    if (win) e.win = win;
    if (cat === 'console') { s.console.push({ t: e.t, level: m, text: args[0] }); return; }
    if (!s[cat]) s[cat] = [];
    s[cat].push(e);
  }
  recError(where, err, win) {
    const s = this._step();
    const e = { t: this.t(), where, error: errText(err) };
    if (win) e.win = win;
    s.errors.push(e);
  }
  recUnknownApi(name) {
    if (this.unknownSeen.has(name)) return;
    this.unknownSeen.add(name);
    this._step().unknownApi.push(name);
  }
  note(msg) {
    if (this.notesSeen.has(msg)) return;
    this.notesSeen.add(msg);
    this._step().notes.push(msg);
  }
  connRec(conn) {
    const s = this._step();
    let r = s.net.get(conn.id);
    if (!r) { r = { url: conn.url, life: [], c2s: [], s2c: [] }; s.net.set(conn.id, r); }
    return r;
  }
  netEv(conn, side, ev, data) { this.connRec(conn).life.push({ t: this.t(), side, ev, ...data }); }
  netFrame(conn, dir, frame) { this.connRec(conn)[dir].push({ t: this.t(), frame }); }
  netConstructError(url, err) { this._step().netErrors.push({ t: this.t(), url, error: errText(err) }); }

  windowCreated(win, opts) {
    this._step().winCreated.push({ t: this.t(), win, options: canon(opts) });
  }
  trayChanged(tray, snap) {
    const s = this._step();
    (s.trayChanges = s.trayChanges || []).push({ t: this.t(), ...snap });
  }
  pageRequested(win) {
    if (!this.pageQueue.includes(win)) this.pageQueue.push(win);
  }
  appExited(how) {
    this.exited = how;
    this.rec('lifecycle', `app-${how}`, []);
  }

  // ------------------------------------------------------------- IPC plumbing
  ipcEvent(win) {
    const wc = win.webContents;
    const ev = makeEvent({
      sender: wc,
      senderFrame: { url: wc.getURL(), routingId: 1, processId: 100 + win.id, frameTreeNodeId: 1, isDestroyed: () => false, send: (ch, ...a) => wc.send(ch, ...a) },
      frameId: 1, processId: 100 + win.id, ports: [], returnValue: undefined,
    });
    ev.reply = (ch, ...a) => wc.send(ch, ...a);
    return ev;
  }
  mainToRenderer(win, ch, args) {
    let cloned;
    try { cloned = structuredClone(args); } catch (e) {
      const err = new Error('An object could not be cloned.');
      this.recError(`webContents.send(${ch})`, err, win);
      throw err;
    }
    this.counters.ipcSends++;
    const s = this._step();
    const sim = win._renderer;
    const payload = cloned.length === 1 ? cloned[0] : cloned;
    if (!sim.loaded) { s.unobserved.push({ t: this.t(), win, ch, reason: 'page-not-loaded', payload: canon(payload) }); return; }
    const before = this._observedCount || 0;
    sim.deliver(ch, cloned);
    if ((this._observedCount || 0) === before) s.unobserved.push({ t: this.t(), win, ch, reason: 'no-listener', payload: canon(payload) });
  }
  observe(win, api, args) {
    this._observedCount = (this._observedCount || 0) + 1;
    const ch = win._renderer.currentChannel;
    this._step().ipc.push({ t: this.t(), win, api, ch, payload: canon(args.length === 1 ? args[0] : args) });
  }
  rendererInvoke(win, ch, args) {
    this.counters.ipcInvokes++;
    let cloned;
    try { cloned = structuredClone(args); } catch { return Promise.reject(new Error('An object could not be cloned.')); }
    const handler = this.electron.ipcMain._handlers.get(ch);
    if (!handler) return Promise.reject(new Error(`Error invoking remote method '${ch}': Error: No handler registered for '${ch}'`));
    const event = this.ipcEvent(win);
    return new Promise((resolve, reject) => {
      let r;
      try { r = handler(event, ...cloned); } catch (e) { reject(new Error(`Error invoking remote method '${ch}': ${errText(e)}`)); return; }
      Promise.resolve(r).then((v) => {
        try { resolve(structuredClone(v)); } catch { reject(new Error(`Error invoking remote method '${ch}': Error: An object could not be cloned.`)); }
      }, (e) => reject(new Error(`Error invoking remote method '${ch}': ${errText(e)}`)));
    });
  }
  rendererSend(win, ch, args) {
    this.counters.ipcRendererSends++;
    let cloned;
    try { cloned = structuredClone(args); } catch { throw new Error('An object could not be cloned.'); }
    const event = this.ipcEvent(win);
    try { this.electron.ipcMain.emit(ch, event, ...cloned); } catch (e) { this.recError(`ipcMain listener (${ch})`, e, win); }
  }
  rendererSendSync(win, ch, args) {
    this.counters.ipcRendererSends++;
    const cloned = structuredClone(args);
    const event = this.ipcEvent(win);
    try { this.electron.ipcMain.emit(ch, event, ...cloned); } catch (e) { this.recError(`ipcMain listener (${ch})`, e, win); }
    return structuredClone(event.returnValue);
  }

  // ------------------------------------------------------------- pages
  pageInfo(win) {
    const page = win._page || '';
    if (this.pageInfoCache.has(page)) return this.pageInfoCache.get(page);
    const base = pageBase(page);
    let subs = [];
    try {
      const htmlPath = path.resolve(this.appDir, page);
      const html = ORIG.readFileSync(htmlPath, 'utf8');
      let text = html;
      const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        try { text += '\n' + ORIG.readFileSync(path.resolve(path.dirname(htmlPath), m[1]), 'utf8'); } catch {}
      }
      const found = new Set();
      const re2 = /\bmemedrop\s*(?:\?\.|\.)\s*(on[A-Z]\w*)/g;
      while ((m = re2.exec(text))) found.add(m[1]);
      subs = [...found].sort();
    } catch {}
    if (!subs.length && PAGE_SUBS_FALLBACK[base]) subs = PAGE_SUBS_FALLBACK[base];
    const info = { base, subs, init: PAGE_INIT_CALLS[base] || [] };
    this.pageInfoCache.set(page, info);
    return info;
  }
  api(win) { return (win._renderer.world && win._renderer.world.memedrop) || null; }

  async processPageLoads() {
    if (this._inPageLoads) return;
    this._inPageLoads = true;
    try {
      while (this.pageQueue.length && !this.exited) {
        const win = this.pageQueue.shift();
        if (win._destroyed || win._renderer.loaded) continue;
        const info = this.pageInfo(win);
        await this.step(`page-load:${info.base}`, async () => {
          win._renderer.load();
          const api = this.api(win);
          this.cur.result = { exposed: api ? Object.keys(api).sort() : null, subscribed: info.subs.filter((n) => api && typeof api[n] === 'function') };
          for (const n of info.subs) {
            if (api && typeof api[n] === 'function') {
              try { api[n]((...args) => this.observe(win, n, args)); } catch (e) { this.recError(`subscribe ${n}`, e, win); }
            }
          }
          win.webContents.emit('dom-ready', makeEvent());
          win.webContents.emit('did-finish-load', makeEvent());
          win._finishLoad();
          win.emit('ready-to-show', makeEvent());
        });
        for (const call of info.init) {
          await this.invokeWin(win, call, [], `init:${info.base}.${call}()`);
        }
      }
    } finally {
      this._inPageLoads = false;
    }
  }

  findWin(name) {
    const ws = this.electron.windows.filter((w) => !w._destroyed && pageBase(w._page) === name);
    return ws.length ? ws[ws.length - 1] : null;
  }

  // ------------------------------------------------------------- steps
  uniqueLabel(label) {
    const n = (this.labelCount.get(label) || 0) + 1;
    this.labelCount.set(label, n);
    return n === 1 ? label : `${label} #${n}`;
  }
  beginStep(label, meta) {
    this.clock.stepId = (this.clock.stepId || 0) + 1;
    this.cur = newStep(this.uniqueLabel(label), this.t(), meta);
    this.fs.resetStep();
    this._counterBase = { ...this.counters };
    if (this.orphans.length) { this.cur.orphans = this.orphans; this.orphans = []; }
  }
  endStep() {
    const s = this.cur;
    s.tEnd = this.t();
    s.io = this.fs.resetStep();
    const c = {};
    for (const k of Object.keys(this.counters)) { const d = this.counters[k] - this._counterBase[k]; if (d) c[k] = d; }
    s.counters = c;
    s.state = this.snapshotState();
    // repeating timers only: they are the background activity (one-shot
    // timeouts such as debounces would only add noise)
    s.timers = this.clock.describePending('app').filter((t) => t.every != null);
    this.steps.push(s);
    this.cur = null;
  }
  async step(label, fn, meta) {
    if (this.exited) { this.skipped.push(label); return undefined; }
    this.beginStep(label, meta);
    let out;
    try { out = await fn(); } catch (e) { this.recError('step', e); }
    await this.settle();
    await this.runDeferred();
    this.endStep();
    await this.processPageLoads();
    return out;
  }

  async settle({ quiet = 4, timeoutMs = 15000 } = {}) {
    const start = realNow();
    let q = 0;
    let spins = 0;
    for (;;) {
      await realImmediate();
      const p = this.net.pending() || (this.fs.pendingAsync > 0 ? `fs:${this.fs.pendingAsync}` : null);
      if (p) {
        q = 0;
        spins++;
        if (spins > 100) await realSleep(1);
      } else if (++q >= quiet) {
        return;
      }
      if (realNow() - start > timeoutMs) {
        this.recError('settle', new Error(`did not settle: ${p}`));
        return;
      }
    }
  }

  async runDeferred() {
    const W = this.deferWindowMs;
    if (!W) return;
    for (let i = 0; i < 1000; i++) {
      let best = null;
      for (const t of this.clock._timers.values()) {
        if (t._owner !== 'app' || t._repeat != null || t._delay > W || t._stepId !== this.clock.stepId) continue;
        if (!best || t._due < best._due || (t._due === best._due && t._seq < best._seq)) best = t;
      }
      if (!best) return;
      this.clock._timers.delete(best._id);
      best._active = false;
      this.counters.deferredTimersRun++;
      try { best._cb.apply(best, best._args); } catch (e) { this.recError('timer callback', e); }
      await this.settle({ quiet: 2 });
    }
    this.recError('defer window', new Error('more than 1000 short timers in one step'));
  }

  async advanceClock(ms) {
    await this.clock.advance(ms, async () => { await this.settle({ quiet: 2 }); });
  }

  snapshotState() {
    const wins = {};
    for (const w of this.electron.windows) {
      wins[w.id] = {
        win: w,
        page: w._page, loaded: w._renderer.loaded, destroyed: w._destroyed,
        visible: w._visible, focused: w._focused,
        alwaysOnTop: w._alwaysOnTop, level: w._aotLevel,
        bounds: { ...w._bounds }, ignoreMouse: { ...w._ignoreMouse },
        allWorkspaces: w._allWorkspaces ? { ...w._allWorkspaces } : null,
        devtools: w.webContents._devtools,
      };
    }
    return {
      windows: wins,
      trays: this.trays.map((t) => canon(t.snapshot())),
      updater: this.autoUpdater ? canon(this.autoUpdater.snapshot()) : null,
      loginItem: canon(this.electron.app._login),
      app: { quit: this.electron.app._quitState || null },
    };
  }

  storeFile() {
    const p = path.join(this.userData, 'config.json');
    let text;
    try { text = ORIG.readFileSync(p, 'utf8'); } catch { return null; }
    try { return canon(JSON.parse(text)); } catch { return { $raw: text }; }
  }
  userDataFiles() {
    const out = [];
    const walk = (d, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
      }
    };
    walk(this.userData, '');
    return out.sort();
  }

  // ------------------------------------------------------------- DSL
  async boot({ hidden = false, argv = [], packaged = false, lock = true, store, storeRaw, displays, wasOpenedAtLogin = false, label = 'boot' } = {}) {
    Object.assign(this.opts, { packaged, lock, wasOpenedAtLogin });
    if (displays) this.opts.displays = displays;
    fs.mkdirSync(this.userData, { recursive: true });
    const cfg = path.join(this.userData, 'config.json');
    if (storeRaw !== undefined) ORIG.writeFileSync(cfg, storeRaw);
    else if (store) ORIG.writeFileSync(cfg, JSON.stringify(store, undefined, '\t'));
    process.argv = [process.execPath, this.appDir, ...(hidden ? ['--hidden'] : []), ...argv];
    process.env.DEFAULT_SERVER = this.bot.url;
    process.type = 'browser';
    try { Object.defineProperty(process.versions, 'electron', { value: '33.4.11', enumerable: true, configurable: true }); } catch {}
    process.resourcesPath = path.join(this.homeDir, 'MemeDrop', 'resources');
    if (!packaged) process.defaultApp = true;
    // The overlay ships for Windows only: run the code under test as win32
    // (icon.ico, setAppUserModelId...). Node's own modules captured the real
    // platform when they loaded, so only code reading process.platform at
    // call time sees this.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, enumerable: true, writable: false });
    this.booted = true;
    const pkg = (() => { try { return JSON.parse(ORIG.readFileSync(path.join(this.appDir, 'package.json'), 'utf8')); } catch { return {}; } })();
    const mainFile = path.resolve(this.appDir, pkg.main || 'index.js');
    return this.step(label, () => { require(mainFile); }, { metric: 'boot' });
  }

  botConn(n) { return n == null ? this.bot.latest() : this.net.conns.get(n); }
  async botSend(msg, { conn, label, metric } = {}) {
    const short = msg && msg.$raw !== undefined ? `raw ${JSON.stringify(String(msg.$raw).slice(0, 24))}` : (msg && msg.type) || typeof msg;
    return this.step(label || `bot→ ${short}`, () => {
      if (!this.bot.sendTo(this.botConn(conn), msg)) this.note('bot had no open connection to send on');
    }, { metric });
  }
  async botLink(opts = {}, label = 'bot: /link (linked + extension code)') {
    return this.step(label, () => this.bot.link(this.botConn(opts.conn), opts), { metric: 'linked' });
  }
  async botClose(code = 1000, label) {
    return this.step(label || `bot closes connection (${code})`, () => this.bot.close(this.botConn(), code));
  }
  async botTerminate(label = 'bot terminates connection') {
    return this.step(label, () => this.bot.terminate(this.botConn()));
  }
  setBotDown(v) { this.bot.down = !!v; }

  async invokeWin(win, api, args, label, meta) {
    return this.step(label, async () => {
      const a = this.api(win);
      if (!a || typeof a[api] !== 'function') throw new Error(`renderer API window.memedrop.${api} is not available`);
      let res;
      try { res = { ok: canon(await a[api](...args)) }; } catch (e) { res = { error: String(e && e.message || e) }; }
      this.cur.result = res;
      return res;
    }, meta);
  }
  argText(args) {
    const rep = (k, v) => (v === undefined ? '<undefined>' : v);
    return args.map((a) => { const s = JSON.stringify(a, rep); return s === undefined ? 'undefined' : (s.length > 60 ? `${s.slice(0, 57)}...` : s); }).join(', ');
  }
  async invoke(winName, api, ...args) {
    let meta;
    if (args.length && args[args.length - 1] && args[args.length - 1].$meta) meta = args.pop().$meta;
    const win = this.findWin(winName);
    const label = `${winName}.${api}(${this.argText(args)})`;
    if (!win) return this.step(label, () => { throw new Error(`no live ${winName} window`); }, meta);
    return this.invokeWin(win, api, args, label, meta);
  }
  // fire-and-forget renderer API (ipcRenderer.send based): no result recorded
  async send(winName, api, ...args) {
    let meta;
    if (args.length && args[args.length - 1] && args[args.length - 1].$meta) meta = args.pop().$meta;
    const win = this.findWin(winName);
    const label = `${winName}.${api}(${this.argText(args)})`;
    return this.step(label, () => {
      if (!win) throw new Error(`no live ${winName} window`);
      const a = this.api(win);
      if (!a || typeof a[api] !== 'function') throw new Error(`renderer API window.memedrop.${api} is not available`);
      const r = a[api](...args);
      if (r && typeof r.then === 'function') r.then(() => {}, () => {});
    }, meta);
  }
  async advance(ms, label, meta) {
    return this.step(label || `advance ${fmtMs(ms)}`, () => this.advanceClock(ms), meta);
  }
  async trayClick(label) {
    return this.step(`tray menu: ${label}`, () => {
      const tray = this.trays[this.trays.length - 1];
      if (!tray) throw new Error('no tray');
      const r = this.electron.clickMenuItem(tray._menu, label);
      this.cur.result = r.error ? { error: r.error } : { ok: true };
    });
  }
  async trayEvent(name) {
    return this.step(`tray event: ${name}`, () => {
      const tray = this.trays[this.trays.length - 1];
      if (!tray) throw new Error('no tray');
      tray.emit(name, makeEvent(), { x: 1810, y: 1050, width: 24, height: 40 });
    });
  }
  async userClosesWindow(winName) {
    return this.step(`user closes ${winName} window`, () => {
      const w = this.findWin(winName);
      if (!w) throw new Error(`no live ${winName} window`);
      w._requestClose();
    });
  }
  async osDemotesWindow(winName, { blur = false } = {}) {
    return this.step(`OS drops always-on-top of ${winName}${blur ? ' (+blur)' : ''}`, () => {
      const w = this.findWin(winName);
      if (!w) throw new Error(`no live ${winName} window`);
      w._alwaysOnTop = false;
      w._aotLevel = null;
      if (blur) w.emit('blur', makeEvent());
    });
  }
  async shortcut(acc) {
    return this.step(`shortcut ${acc}`, () => {
      if (!this.electron.globalShortcut._trigger(acc)) this.cur.result = { error: 'not registered' };
    });
  }
  async appEvent(name, ...args) {
    return this.step(`app event: ${name}`, () => {
      if (name === 'window-all-closed') this.electron.app._allClosed();
      else this.electron.app.emit(name, makeEvent(), ...args);
    });
  }
  async displaysChange(displays, event, label) {
    return this.step(label || `screen: ${event}`, () => {
      this.opts.displays = displays;
      this.electron.screen.emit(event, makeEvent(), displays[0]);
    });
  }
  async quit(label = 'app.quit() (OS shutdown / quit)') {
    return this.step(label, () => this.electron.app.quit());
  }
  async check(label, fn) {
    return this.step(label, async () => { this.cur.result = { ok: canon(await fn()) }; });
  }
  // Scripted mouse position: points [{at: relative ms, x, y}], the latest
  // point whose `at` is <= now wins.
  setCursorPath(points) { this.cursorPath = points.slice().sort((a, b) => a.at - b.at); }
  cursorNow() {
    if (!this.cursorPath || !this.cursorPath.length) return this.cursor;
    const now = this.t();
    let cur = this.cursorPath[0];
    for (const p of this.cursorPath) if (p.at <= now) cur = p;
    return cur;
  }
  // Periodic renderer-side call (e.g. settings.js polls isQuietHoursActive
  // every 30 s while its page is loaded, visible or not).
  startRendererPoll(winName, api, everyMs) {
    this.stopRendererPoll();
    this.pollTimer = this.clock.harnessInterval(() => {
      const w = this.findWin(winName);
      const a = w && this.api(w);
      if (!a || typeof a[api] !== 'function') return;
      try { const r = a[api](); if (r && r.then) r.then(() => {}, (e) => this.recError(`renderer poll ${api}`, e, w)); } catch (e) { this.recError(`renderer poll ${api}`, e, w); }
    }, everyMs);
  }
  stopRendererPoll() { if (this.pollTimer) { this.clock.clear(this.pollTimer); this.pollTimer = null; } }

  // ------------------------------------------------------------- finish
  async finish() {
    if (!this.booted) return;
    this.final.storeNow = this.storeFile();
    if (!this.exited) {
      await this.advance(10_000, 'final: idle 10 s');
      this.final.storeAfterIdle = this.storeFile();
      await this.quit('final: app.quit()');
      this.final.storeAfterQuit = this.storeFile();
    }
    this.final.files = this.userDataFiles();
    this.final.randomDraws = this.clock.randomDraws || 0;
  }

  serialize() {
    const nameOf = (w) => {
      if (!w) return null;
      const base = pageBase(w._page);
      const same = this.electron.windows.filter((x) => pageBase(x._page) === base);
      const i = same.indexOf(w);
      return i <= 0 ? base : `${base}#${i + 1}`;
    };
    const RANK = { attempt: 0, reject: 1, accept: 1, open: 2, error: 3, close: 4 };
    const groupByWin = (arr, strip) => {
      if (!arr.length) return undefined;
      const out = {};
      for (const e of arr) {
        const n = nameOf(e.win);
        const { win, ...rest } = e;
        if (strip) for (const k of strip) delete rest[k];
        (out[n] = out[n] || []).push(rest);
      }
      return out;
    };
    const plain = (arr) => (arr.length ? arr.map((e) => {
      const { win, ...rest } = e;
      const o = { ...rest, args: canon(rest.args) };
      if (win) o.win = nameOf(win);
      return o;
    }) : undefined);
    const stepOut = (s) => {
      const o = { label: s.label, t: s.t };
      if (s.tEnd !== undefined && s.tEnd !== s.t) o.tEnd = s.tEnd;
      if (s.meta && s.meta.metric) o.metric = s.meta.metric;
      if (s.result !== undefined) o.result = canon(s.result);
      o.ipc = groupByWin(s.ipc);
      o.unobserved = groupByWin(s.unobserved);
      if (s.winCreated.length) o.winCreated = s.winCreated.map((e) => ({ t: e.t, win: nameOf(e.win), options: e.options }));
      o.winCalls = (() => {
        if (!s.win.length) return undefined;
        const out = {};
        for (const e of s.win) { const n = nameOf(e.win); (out[n] = out[n] || []).push({ t: e.t, m: e.m, args: canon(e.args) }); }
        return out;
      })();
      if (s.net.size) {
        o.net = {};
        for (const id of [...s.net.keys()].sort((a, b) => a - b)) {
          const r = s.net.get(id);
          const life = r.life.map((e, i) => ({ ...e, _i: i }))
            .sort((a, b) => a.t - b.t || RANK[a.ev] - RANK[b.ev] || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) || a._i - b._i)
            .map(({ _i, ...e }) => e);
          const c = { url: r.url };
          if (life.length) c.life = life;
          if (r.c2s.length) c.c2s = r.c2s.map((f) => ({ t: f.t, frame: canon(f.frame) }));
          if (r.s2c.length) c.s2c = r.s2c.map((f) => ({ t: f.t, frame: canon(f.frame) }));
          o.net[`conn${String(id).padStart(3, '0')}`] = c;
        }
      }
      if (s.netErrors.length) o.netErrors = s.netErrors;
      if (s.trayChanges && s.trayChanges.length) o.trayChanges = s.trayChanges;
      for (const cat of ['app', 'tray', 'shell', 'updater', 'shortcut', 'dialog', 'notification', 'lifecycle']) {
        if (s[cat] && s[cat].length) o[cat] = plain(s[cat]);
      }
      if (s.console.length) o.console = s.console;
      if (s.errors.length) o.errors = s.errors.map((e) => ({ t: e.t, where: e.where, error: e.error, ...(e.win ? { win: nameOf(e.win) } : {}) }));
      if (s.notes.length) o.notes = s.notes;
      if (s.unknownApi.length) o.unknownApi = s.unknownApi;
      if (s.orphans) o.orphans = s.orphans.map(stepOut);
      if (s.state) {
        const wins = {};
        for (const w of Object.values(s.state.windows)) {
          const { win, ...rest } = w;
          wins[nameOf(win)] = canon(rest);
        }
        o.state = { ...s.state, windows: wins };
      }
      if (s.io) o.io = s.io;
      if (s.counters && Object.keys(s.counters).length) o.counters = s.counters;
      if (s.timers) o.timers = s.timers;
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      return o;
    };
    const steps = this.steps.map(stepOut);
    const total = zero();
    for (const s of this.steps) for (const k of Object.keys(total)) total[k] += (s.io && s.io[k]) || 0;
    const out = {
      steps,
      final: canon(this.final),
      ioTotal: total,
      timersFired: { ...this.clock.fired },
    };
    if (this.orphans.length) out.trailingOrphans = this.orphans.map(stepOut);
    if (this.skipped.length) out.skippedAfterExit = this.skipped;
    const replacers = [
      [this.userData, '<USERDATA>'],
      [this.homeDir, '<HOME>'],
      [this.tmpDir, '<TMP>'],
      [this.workDir, '<WORK>'],
      [this.appDir, '<APP>'],
      [`127.0.0.1:${this.port}`, '127.0.0.1:<PORT>'],
      [`localhost:${this.port}`, 'localhost:<PORT>'],
    ].sort((a, b) => b[0].length - a[0].length);
    return normalizeStrings(out, replacers);
  }

  shutdown() {
    try { this.bot.stop(); } catch {}
  }
}

function fmtMs(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

module.exports = { Harness, EPOCH, APP_VERSION, tokenFor, fmtMs };
