'use strict';
// Init script injected in every page before the overlay code runs.
// It must stay self-contained: Playwright serialises the function source.
//
// cfg = {
//   mode: 'electron' | 'android' | 'perf',
//   seed: number|null      — seeded Math.random (mulberry32)
//   t0: number|null        — fake-clock epoch (ms); event times are Date.now() - t0
//   settings: object       — what window.memedrop.getSettings() resolves to (electron)
//   settle: bool           — freeze CSS animations at their settled state
//   hooks: bool            — record speechSynthesis / media / Web Audio usage
// }
function pageInit(cfg) {
  const H = (window.__H = {
    calls: [],      // bridge calls (window.memedrop.*), in order
    subs: [],       // listener registrations (onDrop, onCursor, ...)
    speech: [],     // speechSynthesis.speak()
    media: [],      // HTMLMediaElement.play()
    pops: [],       // OscillatorNode.start() (arrival "pop")
    audioContexts: 0,
    errors: [],     // uncaught errors / unhandled rejections
    rects: [],      // android: MDOverlay.rects(json)
    mediaEls: [],   // every media element play()'d, for state snapshots
    mutations: 0,
  });
  // First use of the (possibly fake) clock right now: makes Playwright replay
  // its pauseAt() log immediately, so fake ticks start at exactly 0.
  try { Date.now(); } catch (e) {}
  const now = () => (cfg.t0 != null ? Date.now() - cfg.t0 : Math.round(performance.now()));

  // ── Deterministic Math.random ──────────────────────────────────────────
  if (cfg.seed != null) {
    let s = cfg.seed >>> 0;
    Math.random = function random() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  window.addEventListener('error', (e) => {
    H.errors.push({ t: now(), type: 'error', message: String(e.message || (e.error && e.error.message) || 'error') });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    H.errors.push({ t: now(), type: 'unhandledrejection', message: String((r && (r.name ? r.name + ': ' : '') + (r.message || '')) || r) });
  });

  // ── Side-effect recorders ──────────────────────────────────────────────
  const trackMedia = (el) => {
    if (!H.mediaEls.includes(el)) H.mediaEls.push(el);
  };
  H.trackMedia = trackMedia;
  if (cfg.hooks) {
    try {
      const SP = window.SpeechSynthesis && window.SpeechSynthesis.prototype;
      if (SP) {
        SP.speak = function speak(u) {
          H.speech.push({
            t: now(), text: String(u && u.text), lang: u && u.lang,
            rate: u && Math.round(u.rate * 1000) / 1000, volume: u && Math.round(u.volume * 1000) / 1000,
          });
        };
        SP.cancel = function cancel() { H.speech.push({ t: now(), op: 'cancel' }); };
      }
    } catch (e) {}
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function pause() {
      this.__hPaused = true;
      return origPause.apply(this, arguments);
    };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      trackMedia(this);
      H.media.push({
        t: now(), op: 'play', tag: this.tagName.toLowerCase(), src: this.getAttribute('src') || this.src || '',
        volume: Math.round(this.volume * 1000) / 1000, muted: this.muted, connected: this.isConnected,
      });
      return origPlay.apply(this, arguments);
    };
    const AC = window.AudioContext;
    if (AC) {
      const Wrapped = function AudioContext(...args) { H.audioContexts++; return new AC(...args); };
      Wrapped.prototype = AC.prototype;
      window.AudioContext = Wrapped;
      const origStart = AudioScheduledSourceNode.prototype.start;
      AudioScheduledSourceNode.prototype.start = function start(...a) {
        if (typeof OscillatorNode !== 'undefined' && this instanceof OscillatorNode) {
          H.pops.push({ t: now(), type: this.type });
        }
        return origStart.apply(this, a);
      };
    }
  }

  // ── Electron bridge (window.memedrop, see overlay/preload.js) ──────────
  if (cfg.mode === 'electron' || cfg.mode === 'perf') {
    const L = { drop: [], settings: [], cursor: [], connection: [], history: [], update: [] };
    const st = (H.bridge = { ignoreMouse: true, watching: false, lastCursor: null });
    const rec = (call, args) => {
      const e = { t: now(), call };
      if (args && args.length) e.args = JSON.parse(JSON.stringify(args));
      H.calls.push(e);
    };
    const sub = (k, name) => (cb) => {
      H.subs.push(name);
      L[k].push(cb);
      return () => { const i = L[k].indexOf(cb); if (i >= 0) L[k].splice(i, 1); };
    };
    const inv = (name, val) => (...args) => {
      rec(name, args);
      return Promise.resolve(typeof val === 'function' ? val(...args) : val);
    };
    const snd = (name, fn) => (...args) => { rec(name, args); if (fn) fn(...args); };
    const api = {
      getSettings: inv('getSettings', () => JSON.parse(JSON.stringify(cfg.settings || {}))),
      setSettings: inv('setSettings', true),
      listDisplays: inv('listDisplays', []),
      getConnection: inv('getConnection', { status: 'connected' }),
      reconnect: inv('reconnect', true),
      unlinkGuild: inv('unlinkGuild', true),
      unblockUser: inv('unblockUser', true),
      onConnection: sub('connection', 'onConnection'),
      setMute: inv('setMute', null),
      getMute: inv('getMute', null),
      isQuietHoursActive: inv('isQuietHoursActive', false),
      getHistory: inv('getHistory', []),
      clearHistory: inv('clearHistory', true),
      replayDrop: inv('replayDrop', false),
      reactDrop: snd('reactDrop'),
      onHistory: sub('history', 'onHistory'),
      onDrop: sub('drop', 'onDrop'),
      onSettingsUpdate: sub('settings', 'onSettingsUpdate'),
      getVersion: inv('getVersion', '0.0.0-harness'),
      getUpdateState: inv('getUpdateState', { status: 'idle' }),
      checkForUpdate: inv('checkForUpdate', true),
      downloadUpdate: inv('downloadUpdate', true),
      installUpdate: inv('installUpdate', true),
      onUpdateState: sub('update', 'onUpdateState'),
      testDrop: snd('testDrop'),
      openExternal: snd('openExternal'),
      stageEmpty: snd('stageEmpty'),
      watchCursor: snd('watchCursor', () => { st.watching = true; st.lastCursor = null; }),
      unwatchCursor: snd('unwatchCursor', () => { st.watching = false; }),
      setIgnoreMouse: snd('setIgnoreMouse', (v) => { st.ignoreMouse = !!v; }),
      onCursor: sub('cursor', 'onCursor'),
    };
    // contextBridge exposes a frozen copy
    Object.defineProperty(window, 'memedrop', { value: Object.freeze(api), writable: false, configurable: false });
    // IPC payloads are structured-cloned by Electron
    H.fireDrop = (p) => { for (const cb of L.drop.slice()) cb(structuredClone(p)); return L.drop.length; };
    H.fireSettings = (p) => { for (const cb of L.settings.slice()) cb(structuredClone(p)); return L.settings.length; };
    // Emulates main.js startCursorPoll(): positions are only sent while the
    // renderer asked to watch, and only when the cursor actually moved.
    H.fireCursor = (x, y) => {
      if (!st.watching) return 'not-watching';
      if (st.lastCursor && st.lastCursor.x === x && st.lastCursor.y === y) return 'unchanged';
      st.lastCursor = { x, y };
      for (const cb of L.cursor.slice()) cb({ x, y });
      return 'delivered';
    };
    H.forceCursor = (x, y) => { for (const cb of L.cursor.slice()) cb({ x, y }); };
  }

  // ── Android bridge (window.MDOverlay, see OverlayController.kt) ────────
  if (cfg.mode === 'android') {
    window.MDOverlay = {
      rects(json) { H.rects.push({ t: now(), json: String(json) }); },
    };
  }

  // ── Settled CSS animations (behaviour mode only) ───────────────────────
  // Every CSS animation is paused at t = 12 s (entry animations finished,
  // the 3 s "bob" back at its rest pose) and transitions are instant: all
  // geometry the renderer measures with getBoundingClientRect() is then a
  // pure function of the DOM, independent of wall-clock timing.
  if (cfg.settle) {
    const install = () => {
      if (document.getElementById('__harness_settle')) return;
      const s = document.createElement('style');
      s.id = '__harness_settle';
      s.setAttribute('data-harness', '1');
      s.textContent = '*, *::before, *::after {' +
        ' animation-delay: -12s !important; animation-play-state: paused !important;' +
        ' transition-duration: 0s !important; transition-delay: 0s !important; }';
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
  }

  // Mutation counter (quiescence detection) — not in perf mode, where it would
  // add a callback to every DOM write being measured.
  const startObserver = () => {
    if (cfg.mode === 'perf') return;
    try {
      new MutationObserver((list) => { H.mutations += list.length; })
        .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
  };
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // ── Event drain (called by the harness at each checkpoint) ─────────────
  H.drain = () => {
    const out = {
      bridge: H.calls.splice(0),
      speech: H.speech.splice(0),
      media: H.media.splice(0),
      pops: H.pops.splice(0),
      errors: H.errors.splice(0),
      rects: H.rects.splice(0),
      subs: H.subs.splice(0),
      audioContexts: H.audioContexts,
    };
    return out;
  };

  // ── DOM snapshot ───────────────────────────────────────────────────────
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const normNumbers = (s) => String(s).replace(/-?\d+\.\d+/g, (m) => String(r3(parseFloat(m))));
  const inlineStyle = (el) => {
    const out = {};
    const st = el.style;
    if (!st) return out;
    const names = [];
    for (let i = 0; i < st.length; i++) names.push(st[i]);
    names.sort();
    for (const n of names) out[n] = normNumbers(st.getPropertyValue(n).trim());
    return out;
  };
  // Computed properties recorded per element class, only when asked (opts.computed).
  const COMPUTED = [
    ['.anchor', ['opacity']],
    ['.drop', ['opacity', 'transform', 'filter', 'cursor', 'animation-name', 'pointer-events']],
    ['.avatar-bubble', ['width', 'height', 'background-image']],
    ['.drop-close', ['opacity', 'transform', 'width', 'height', 'display', 'pointer-events']],
    ['.react-bar', ['opacity', 'display']],
    ['.react-btn', ['opacity', 'transform']],
    ['.caption-bar', ['font-size', '-webkit-text-stroke-width', 'line-height']],
    ['.life-bar', ['transform', 'background-image']],
    ['.media-box img, .media-box video, .media-box svg', ['width', 'height', 'border-radius']],
    ['.audio-toast', ['opacity', 'transform', 'top', 'z-index']],
    ['.audio-toast > *', ['opacity']],
    ['.audio-caption', ['font-size']],
  ];
  const computedFor = (el) => {
    let props = null;
    for (const [sel, list] of COMPUTED) {
      let m = false;
      try { m = el.matches(sel); } catch (e) {}
      if (m) { props = props || new Set(); list.forEach((p) => props.add(p)); }
    }
    if (!props) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of [...props].sort()) out[p] = normNumbers(cs.getPropertyValue(p));
    return out;
  };
  const directText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  };
  const isHarness = (el) => el.hasAttribute && el.hasAttribute('data-harness');
  function node(el, opts, soft) {
    const tag = el.tagName.toLowerCase();
    const o = { tag };
    if (el.id) o.id = el.id;
    const cls = [...el.classList].sort();
    if (cls.length) o.cls = cls;
    const attrs = {};
    for (const a of [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (a.name === 'class' || a.name === 'style' || a.name === 'id') continue;
      attrs[a.name] = a.value;
    }
    if (Object.keys(attrs).length) o.attrs = attrs;
    const style = inlineStyle(el);
    if (soft && soft.style) {
      for (const k of soft.style) if (k in style) { style['~' + k] = style[k]; delete style[k]; }
    }
    if (Object.keys(style).length) o.style = style;
    const text = directText(el);
    if (text) o.text = text;
    if (el instanceof HTMLElement && opts.boxes !== false) {
      const box = [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight];
      if (soft && soft.box) { o['~pos'] = box.slice(0, 2); o.size = box.slice(2); } else o.box = box;
    }
    if (tag === 'img') {
      o.img = { complete: el.complete, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight };
    }
    if (tag === 'video' || tag === 'audio') o.mediaState = mediaState(el);
    if (opts.computed) {
      const c = computedFor(el);
      if (c) o.computed = c;
    }
    const kids = [];
    for (const k of el.children) {
      if (isHarness(k) || k.tagName === 'SCRIPT' || k.tagName === 'STYLE') continue;
      kids.push(node(k, opts, null));
    }
    if (kids.length) o.kids = kids;
    return o;
  }
  function mediaState(el) {
    const s = {
      paused: el.paused, muted: el.muted, volume: r3(el.volume),
      autoplay: el.autoplay, loop: el.loop, preload: el.preload,
      hasMetadata: el.readyState >= 1, error: el.error ? el.error.code : null,
    };
    if (el.tagName === 'VIDEO') s.playsInline = el.playsInline;
    return s;
  }
  function parseNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  function rainSummary(els, pool, soft) {
    const viol = [];
    const emojis = {};
    let hash = 2166136261 >>> 0;
    const feed = (s) => { for (let i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; } };
    els.forEach((el, i) => {
      const st = el.style;
      const left = parseNum(st.left), fs = parseNum(st.fontSize);
      const delay = parseNum(st.animationDelay), dur = parseNum(st.animationDuration);
      const sway = parseNum(st.getPropertyValue('--sway')), rot = parseNum(st.getPropertyValue('--rot'));
      const txt = el.textContent;
      emojis[txt] = (emojis[txt] || 0) + 1;
      const chk = (ok, what) => { if (!ok) viol.push(`#${i} ${what}`); };
      chk(left !== null && left >= 0 && left < 98 && /%$/.test(st.left), `left=${st.left}`);
      chk(fs !== null && fs >= 22 && fs < 52, `font-size=${st.fontSize}`);
      chk(delay !== null && delay >= 0 && delay < 2200, `delay=${st.animationDelay}`);
      chk(dur !== null && dur >= 1600 && dur < 3000, `duration=${st.animationDuration}`);
      chk(sway !== null && Math.abs(sway) <= 40, `sway=${st.getPropertyValue('--sway')}`);
      chk(rot !== null && Math.abs(rot) <= 270, `rot=${st.getPropertyValue('--rot')}`);
      if (pool) chk(pool.includes(txt), `emoji=${txt}`);
      feed([txt, r3(left), r3(fs), r3(delay), r3(dur), sway, rot].join('|') + ';');
    });
    // mid-rain the number of particles still falling depends on the random
    // delays/durations: soft when the scenario says so
    const o = soft ? { '~count': els.length } : { count: els.length };
    o.violations = viol.slice(0, 10);
    o.violationCount = viol.length;
    if (els.length) {
      o['~emojis'] = Object.keys(emojis).sort().map((k) => `${k}x${emojis[k]}`);
      o['~hash'] = hash.toString(16);
    }
    if (els.length) {
      const cs = getComputedStyle(els[0]);
      o.computedFirst = { position: cs.position, 'z-index': cs.zIndex, 'pointer-events': cs.pointerEvents, 'animation-name': cs.animationName };
    }
    return o;
  }
  function spotlightInfo() {
    const sp = document.getElementById('spotlight');
    if (!sp) return null;
    const style = inlineStyle(sp);
    const o = { style: {} };
    for (const k of Object.keys(style)) {
      if (k === '--cx' || k === '--cy') o.style['~' + k] = style[k];
      else o.style[k] = style[k];
    }
    o.computedOpacity = getComputedStyle(sp).opacity;
    const cx = parseNum(style['--cx']), cy = parseNum(style['--cy']);
    const rx = parseNum(style['--rx']), ry = parseNum(style['--ry']);
    if (cx === null) { o.target = null; return o; }
    // Which drop is the hole centred on (bounding-box centre, 1.5 px tolerance)?
    o.target = 'none';
    for (const a of document.querySelectorAll('#stage .anchor')) {
      const d = a.querySelector('.drop');
      if (!d) continue;
      const r = d.getBoundingClientRect();
      if (Math.abs(r.left + r.width / 2 - cx) <= 1.5 && Math.abs(r.top + r.height / 2 - cy) <= 1.5) {
        o.target = a.dataset.key || '?';
        o.holeMatchesSize = Math.abs(r.width / 2 + 70 - rx) <= 1.5 && Math.abs(r.height / 2 + 70 - ry) <= 1.5;
        break;
      }
    }
    return o;
  }
  H.snapshot = (opts) => {
    opts = opts || {};
    const html = document.documentElement;
    const snap = {
      theme: html.getAttribute('data-theme'),
      bodyClass: [...document.body.classList].sort(),
      bodyStyle: inlineStyle(document.body),
    };
    if (opts.computed) {
      const bcs = getComputedStyle(document.body);
      snap.bodyComputed = { 'animation-name': bcs.animationName, transform: bcs.transform };
    }
    snap.spotlight = spotlightInfo();
    const stage = document.getElementById('stage');
    snap.stage = stage ? [...stage.children].map((a) => node(a, opts, a.classList.contains('anchor') ? { style: ['left', 'top'], box: true } : null)) : null;
    const others = [];
    const rain = [];
    for (const el of document.body.children) {
      if (el === stage || el.id === 'spotlight' || isHarness(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      if (el.classList.contains('rain-emoji')) { rain.push(el); continue; }
      others.push(node(el, opts, null));
    }
    snap.overlays = others;
    snap.rain = rainSummary(rain, opts.rainPool || null, !!opts.rainSoft);
    // Pending fake timers / rAF callbacks once nothing is on screen any more
    // (a leak shows up here: a rAF loop or interval still scheduled while idle).
    if (stage && !stage.children.length && !others.length && !rain.length && window.__pwClock) {
      try { snap.idleTimers = window.__pwClock.controller.countTimers(); } catch (e) {}
    }
    snap.trackedMedia = H.mediaEls.map((el) => ({
      tag: el.tagName.toLowerCase(), src: el.getAttribute('src') || '', connected: el.isConnected, ...mediaState(el),
    }));
    return snap;
  };
}

module.exports = { pageInit };
