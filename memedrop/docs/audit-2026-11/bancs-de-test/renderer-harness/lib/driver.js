'use strict';
// Scenario driver: one fresh browser context + page per scenario, fake clock
// paused at a fixed epoch, fake bridge, transcript of checkpoints.

const { pageInit } = require('./page-init');

const T1 = Date.UTC(2026, 0, 1, 12, 0, 0);   // fake-clock epoch (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Defaults sent by overlay/main.js (currentDropSettings) with every drop.
const ELECTRON_DROP_SETTINGS = {
  volume: 0.75, musicVolume: 0.75, opacity: 1, duration: 4, videoDuration: 30,
  soundOnArrival: true, spotlightOnDrop: true, avoidZone: 'none',
};
// What settings:get returns (subset relevant to the renderer + a few others).
const ELECTRON_GET_SETTINGS = {
  serverUrl: 'wss://memedrop-bot.fly.dev', ...ELECTRON_DROP_SETTINGS, autostart: true,
  overlayDisplayId: null, paused: false, muteUntil: null, theme: 'classic',
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
};
// Android: Prefs.dropSettings() defaults (spotlight off, theme included).
const ANDROID_DROP_SETTINGS = {
  volume: 0.75, musicVolume: 0.75, opacity: 1, duration: 4, videoDuration: 30,
  soundOnArrival: true, spotlightOnDrop: false, avoidZone: 'none', theme: 'classic',
};

function hashSeed(name) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

class Driver {
  constructor({ browser, mode, root, assets, name, pageUrl, viewport, deviceScaleFactor }) {
    this.browser = browser;
    this.mode = mode;            // 'electron' | 'android'
    this.root = root;
    this.assets = assets;        // { static: {...}, clips: {name: Buffer} }
    this.name = name;
    this.pageUrl = pageUrl;
    this.viewport = viewport;
    this.dsf = deviceScaleFactor || 1;
    this.steps = [];
    this.registry = new Map();   // url -> label
    for (const [k, v] of Object.entries(assets.static)) if (typeof v === 'string') this.registry.set(v, `asset:${k}`);
    this.debug = [];
    this.pendingNotes = [];      // things that happened outside the page (timeouts, clock errors)
    this.lastAudioContexts = 0;
    this.lastActions = [];
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  async open({ settings, seed } = {}) {
    const ctx = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: this.dsf,
      isMobile: false,
    });
    this.ctx = ctx;
    // Network stubs for "remote" media. Nothing ever leaves the machine.
    await ctx.route('http://unreachable.test/**', (r) => r.abort('connectionrefused'));
    await ctx.route('http://media.test/404/**', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }));
    await ctx.route('http://hang.test/**', () => { /* never answers */ });
    // TTS server stub: /long → 6 s of audio, anything else → 1.5 s
    await ctx.route('http://tts.test/**', (r) => r.fulfill({
      status: 200, contentType: 'audio/wav',
      body: /\/long/.test(r.request().url()) ? this.assets.static.wavLong : this.assets.static.wavMid,
    }));
    await ctx.route('http://avatar.test/404/**', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }));
    await ctx.clock.pauseAt(T1);
    await ctx.addInitScript(pageInit, {
      mode: this.mode,
      seed: seed != null ? seed : hashSeed(this.name),
      t0: T1,
      settings: settings || ELECTRON_GET_SETTINGS,
      settle: true,
      hooks: true,
    });
    const page = await ctx.newPage();
    this.page = page;
    // (network requests and 'pageerror' are reported asynchronously to Node,
    // so they are NOT part of the transcript: uncaught errors are recorded
    // in-page instead, synchronously, see page-init.js)
    page.on('pageerror', (err) => { this.debug.push(String(err && err.message || err)); });
    await page.goto(this.pageUrl, { waitUntil: 'load' });
    await this.realWait(50);
  }

  async close() {
    try { await this.ctx.close(); } catch (e) {}
  }

  // ── helpers ────────────────────────────────────────────────────────────
  eval(fn, arg) { return this.page.evaluate(fn, arg); }
  async realWait(ms) { await sleep(ms); }

  async blobUrl(label, buf, mime) {
    const url = await this.page.evaluate(({ b64, mime }) => {
      const s = atob(b64);
      const u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return URL.createObjectURL(new Blob([u8], { type: mime }));
    }, { b64: Buffer.from(buf).toString('base64'), mime });
    this.registry.set(url, `asset:${label}`);
    return url;
  }

  asset(name) { return this.assets.static[name]; }

  // Electron: IPC 'drop' with the settings main.js attaches.
  // Android: OverlayController.show() → window.__mdDrop(payload + settings)
  async drop(payload, settings) {
    if (this.mode === 'electron') {
      const p = { type: 'drop', ts: T1, ...payload, settings: { ...ELECTRON_DROP_SETTINGS, ...(settings || {}) } };
      return this.page.evaluate((p) => window.__H.fireDrop(p), p);
    }
    const p = { type: 'drop', ts: T1, ...payload, settings: { ...ANDROID_DROP_SETTINGS, ...(settings || {}) } };
    return this.page.evaluate((p) => window.__mdDrop(p), p);
  }
  async rawDrop(payload) {
    if (this.mode === 'electron') return this.page.evaluate((p) => window.__H.fireDrop(p), payload);
    return this.page.evaluate((p) => window.__mdDrop(p), payload);
  }
  async settings(patch) {
    if (this.mode === 'electron') return this.page.evaluate((p) => window.__H.fireSettings(p), patch);
    return this.page.evaluate((p) => window.__mdSettings(p), patch);
  }

  async advance(ms) {
    try {
      await this.page.clock.runFor(ms);
    } catch (e) {
      this.pendingNotes.push({ clockError: String(e && e.message || e).split('\n')[0] });
    }
  }

  // Real-time polling (the fake clock stays paused while we wait).
  async waitFor(fn, arg, { timeout = 10000, label = 'condition', interval = 20 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      let ok = false;
      try { ok = await this.page.evaluate(fn, arg); } catch (e) { ok = false; }
      if (ok) return true;
      if (Date.now() > end) {
        this.pendingNotes.push({ waitTimeout: label });
        return false;
      }
      await sleep(interval);
    }
  }

  // Waits until media elements finished loading/failing and the DOM has been
  // quiet for `quietMs` of real time.
  async settle({ media = true, quietMs = 120, readyMs = 80, timeout = 12000, label = 'settle' } = {}) {
    const end = Date.now() + timeout;
    let lastMut = -1;
    let quietSince = Date.now();
    let readySince = null;
    for (;;) {
      const st = await this.page.evaluate((media) => {
        const H = window.__H;
        // A media element is settled once it failed, ended, was paused by the
        // page, or is actually playing (readyState >= 3 and not paused: its
        // 'canplay' / 'play' events have been queued).
        const ok = (v) => !!(v.error || v.networkState === 3 || v.ended || v.__hPaused || (v.readyState >= 3 && !v.paused));
        let ready = true;
        if (media) {
          for (const img of document.images) if (!img.complete) ready = false;
          for (const v of document.querySelectorAll('video, audio')) if (!ok(v)) ready = false;
          for (const v of H.mediaEls) if (!ok(v)) ready = false;
        }
        return { ready, mut: H.mutations };
      }, media);
      const now = Date.now();
      if (st.mut !== lastMut) { lastMut = st.mut; quietSince = now; }
      if (st.ready) { if (readySince === null) readySince = now; } else readySince = null;
      if (readySince !== null && now - readySince >= readyMs && now - quietSince >= quietMs) return true;
      if (now > end) { this.pendingNotes.push({ settleTimeout: label }); return false; }
      await sleep(20);
    }
  }

  // ── mouse / cursor (Electron semantics) ───────────────────────────────
  // The overlay window is click-through until the renderer calls
  // setIgnoreMouse(false); mouse *moves* are always forwarded (forward:true),
  // buttons only reach the page when not ignored. The main process polls the
  // cursor every 16 ms while watching and sends it over IPC when it moved.
  async moveTo(x, y, { steps = 1, ipc = true } = {}) {
    await this.page.mouse.move(x, y, { steps });
    let ipcRes = null;
    if (ipc && this.mode === 'electron') {
      ipcRes = await this.page.evaluate(({ x, y }) => window.__H.fireCursor(Math.round(x), Math.round(y)), { x, y });
    }
    return ipcRes;
  }
  async cursorIpc(x, y) {
    return this.page.evaluate(({ x, y }) => window.__H.fireCursor(Math.round(x), Math.round(y)), { x, y });
  }
  async ignoring() {
    if (this.mode !== 'electron') return false;
    return this.page.evaluate(() => window.__H.bridge.ignoreMouse);
  }
  async mouseDown() {
    if (await this.ignoring()) return 'click-through';
    await this.page.mouse.down();
    return 'delivered';
  }
  async mouseUp() {
    if (await this.ignoring()) return 'click-through';
    await this.page.mouse.up();
    return 'delivered';
  }
  async click(x, y) {
    await this.moveTo(x, y);
    const d = await this.mouseDown();
    const u = await this.mouseUp();
    return d === 'delivered' && u === 'delivered' ? 'delivered' : d;
  }
  // Centre (viewport px) of the first element matching `sel` inside the
  // anchor with data-key `key` (or of the anchor's .drop when sel is null).
  async centerOf(key, sel) {
    return this.page.evaluate(({ key, sel }) => {
      const a = document.querySelector(`#stage .anchor[data-key="${key}"]`);
      if (!a) return null;
      const el = sel ? a.querySelector(sel) : a.querySelector('.drop');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    }, { key, sel });
  }
  async anchorPos(key) {
    return this.page.evaluate((key) => {
      const a = document.querySelector(`#stage .anchor[data-key="${key}"]`);
      if (!a) return null;
      return {
        leftPct: parseFloat(a.style.left), topPct: parseFloat(a.style.top),
        x: parseFloat(a.style.left) / 100 * window.innerWidth, y: parseFloat(a.style.top) / 100 * window.innerHeight,
      };
    }, key);
  }

  // Fake ms elapsed since the page was loaded (clock epoch T1).
  async now() { return (await this.page.evaluate(() => Date.now())) - T1; }
  async advanceTo(t) {
    const n = await this.now();
    if (t > n) await this.advance(t - n);
  }

  note(obj) { this.pendingNotes.push(obj); }
  action(desc) { this.lastActions.push(desc); }

  // ── checkpoint ─────────────────────────────────────────────────────────
  async check(label, opts = {}) {
    const ev = await this.page.evaluate(() => window.__H.drain());
    const t = await this.page.evaluate(() => Date.now()) - T1;
    const step = { step: label, t };
    if (this.lastActions.length) step.actions = this.lastActions.splice(0);
    const events = {};
    if (ev.subs.length) events.subscriptions = [...new Set(ev.subs)].sort();
    if (ev.bridge.length) events.bridge = ev.bridge;
    if (ev.speech.length) events.speech = ev.speech;
    if (ev.media.length) events.mediaPlay = ev.media;
    if (ev.pops.length) events.pops = ev.pops;
    if (ev.audioContexts !== this.lastAudioContexts) {
      events.audioContextsTotal = ev.audioContexts;
      this.lastAudioContexts = ev.audioContexts;
    }
    if (ev.errors.length) events.errors = ev.errors;
    if (ev.rects.length) {
      events.rects = ev.rects.map((r) => {
        let j;
        try { j = JSON.parse(r.json); } catch (e) { return { t: r.t, invalid: r.json }; }
        return {
          t: r.t, dpr: j.dpr,
          rects: (j.rects || []).map((x) => ({
            key: x.key, w: x.w, h: x.h, '~x': x.x, '~y': x.y, '~cx': x.cx, '~cy': x.cy,
            inScreen: x.x >= -1 && x.y >= -1 && x.x + x.w <= Math.round(this.viewport.width * j.dpr) + 1 && x.y + x.h <= Math.round(this.viewport.height * j.dpr) + 1,
          })),
        };
      });
    }
    if (this.pendingNotes.length) events.notes = this.pendingNotes.splice(0);
    if (Object.keys(events).length) step.events = events;
    if (opts.dom !== false) {
      step.dom = await this.page.evaluate((o) => window.__H.snapshot(o), {
        computed: !!opts.computed, rainPool: opts.rainPool || null, rainSoft: !!opts.rainSoft,
      });
    }
    if (opts.extra) step.extra = opts.extra;
    const norm = this.normalize(step);
    this.steps.push(norm);
    return norm;
  }

  normalize(obj) {
    const reg = this.registry;
    const rootUrl = 'file://' + this.root;
    const pageDir = this.pageUrl.slice(0, this.pageUrl.lastIndexOf('/') + 1);   // differs between output dirs in android mode
    const fix = (s) => {
      if (reg.has(s)) return reg.get(s);
      if (s.includes(pageDir)) s = s.split(pageDir).join('page:/');
      if (s.startsWith('data:')) {
        const m = /^data:([^;,]*)/.exec(s);
        return `data:${m ? m[1] : '?'};len=${s.length}`;
      }
      if (s.startsWith('blob:')) return 'blob:<unregistered>';
      if (s.startsWith(rootUrl)) return 'root:' + s.slice(rootUrl.length);
      return s;
    };
    const walk = (v) => {
      if (typeof v === 'string') return fix(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = walk(v[k]);
        return o;
      }
      return v;
    };
    return walk(obj);
  }

  transcript() { return this.steps; }
}

module.exports = {
  Driver, T1, ELECTRON_DROP_SETTINGS, ELECTRON_GET_SETTINGS, ANDROID_DROP_SETTINGS, hashSeed, sleep,
};
