'use strict';
// Virtual clock for a scenario process.
//
// Replaces the global timer functions, Date, performance.now and the
// `timers` / `timers/promises` modules. Virtual time only moves when the
// harness calls advance(); every timer callback runs at its exact due time,
// and the harness lets the network/IPC settle after each callback, so a run
// is a pure function of the code under test.
//
// setImmediate / process.nextTick / queueMicrotask stay real: they never
// depend on time and the harness uses them to drain asynchronous work.

const REAL = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  Date: globalThis.Date,
  perfNow: performance.now.bind(performance),
  mathRandom: Math.random,
};

const TIMEOUT_MAX = 2 ** 31 - 1;

// Same coercion as Node: non-numbers / <1 / >TIMEOUT_MAX become 1 ms, and
// the delay is truncated to whole milliseconds.
function coerceDelay(d) {
  d = Number(d);
  if (!(d >= 1 && d <= TIMEOUT_MAX)) d = 1;
  return Math.trunc(d);
}

class FakeTimer {
  constructor(clock, cb, delay, args, repeat) {
    this._clock = clock;
    this._cb = cb;
    this._args = args;
    this._delay = delay;
    this._repeat = repeat ? delay : null;
    this._id = clock._nextId++;
    this._ref = true;
    this._owner = clock.owner;
    this._due = clock.now + delay;
    this._seq = clock._seq++;
    this._active = true;
    this._stepId = clock.stepId;
  }
  ref() { this._ref = true; return this; }
  unref() { this._ref = false; return this; }
  hasRef() { return this._ref; }
  refresh() {
    this._due = this._clock.now + this._delay;
    this._seq = this._clock._seq++;
    if (!this._active) { this._active = true; this._clock._timers.set(this._id, this); }
    return this;
  }
  close() { this._clock.clear(this); return this; }
  [Symbol.toPrimitive]() { return this._id; }
}

class FakeClock {
  constructor(epochMs) {
    this.epoch = epochMs;
    this.now = epochMs;
    this._timers = new Map();
    this._nextId = 1;
    this._seq = 0;
    this.owner = 'app';          // 'harness' while harness code creates timers
    this.stepId = 0;             // set by the harness at each step start
    this.onTimerError = null;    // (err, timer) => void
    this.fired = { app: 0, harness: 0 };
    this.installed = false;
  }

  rel() { return this.now - this.epoch; }

  _add(cb, delay, args, repeat) {
    if (typeof cb !== 'function') {
      const e = new TypeError(`The "callback" argument must be of type function. Received ${cb === null ? 'null' : typeof cb}`);
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    const t = new FakeTimer(this, cb, coerceDelay(delay), args, repeat);
    this._timers.set(t._id, t);
    return t;
  }

  clear(t) {
    if (t == null) return;
    const id = typeof t === 'object' ? t._id : Number(t);
    const timer = this._timers.get(id);
    if (timer) { timer._active = false; this._timers.delete(id); }
  }

  // Harness-owned timer (fake bot pings, scripted updater progress...).
  harnessTimeout(cb, delay) {
    const prev = this.owner; this.owner = 'harness';
    try { return this._add(cb, delay, [], false); } finally { this.owner = prev; }
  }
  harnessInterval(cb, delay) {
    const prev = this.owner; this.owner = 'harness';
    try { return this._add(cb, delay, [], true); } finally { this.owner = prev; }
  }

  pending(owner) {
    let n = 0;
    for (const t of this._timers.values()) if (!owner || t._owner === owner) n++;
    return n;
  }

  describePending(owner) {
    const out = [];
    for (const t of this._timers.values()) {
      if (owner && t._owner !== owner) continue;
      out.push({ in: t._due - this.now, every: t._repeat });
    }
    out.sort((a, b) => a.in - b.in || (a.every || 0) - (b.every || 0));
    return out;
  }

  _next(limit) {
    let best = null;
    for (const t of this._timers.values()) {
      if (t._due > limit) continue;
      if (!best || t._due < best._due || (t._due === best._due && t._seq < best._seq)) best = t;
    }
    return best;
  }

  // Fire every timer due within `ms`, in (due time, creation order). After
  // each callback `afterEach` (async) lets the rest of the world settle.
  async advance(ms, afterEach) {
    const target = this.now + Math.max(0, Math.trunc(ms));
    for (;;) {
      const t = this._next(target);
      if (!t) break;
      if (t._due > this.now) this.now = t._due;
      if (t._repeat != null) {
        t._due = this.now + t._repeat;
        t._seq = this._seq++;
      } else {
        t._active = false;
        this._timers.delete(t._id);
      }
      this.fired[t._owner] = (this.fired[t._owner] || 0) + 1;
      try {
        t._cb.apply(t, t._args);
      } catch (e) {
        if (this.onTimerError) this.onTimerError(e, t); else throw e;
      }
      if (afterEach) await afterEach(t);
    }
    this.now = target;
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const clock = this;
    const setTimeoutF = function setTimeout(cb, delay, ...args) { return clock._add(cb, delay, args, false); };
    const setIntervalF = function setInterval(cb, delay, ...args) { return clock._add(cb, delay, args, true); };
    const clearF = function clearTimeout(t) { clock.clear(t); };
    globalThis.setTimeout = setTimeoutF;
    globalThis.setInterval = setIntervalF;
    globalThis.clearTimeout = clearF;
    globalThis.clearInterval = clearF;

    const RealDate = REAL.Date;
    function Date(...args) {
      if (!new.target) return new RealDate(clock.now).toString();
      return args.length === 0 ? new RealDate(clock.now) : new RealDate(...args);
    }
    Date.prototype = RealDate.prototype;
    Date.now = () => clock.now;
    Date.parse = RealDate.parse;
    Date.UTC = RealDate.UTC;
    globalThis.Date = Date;

    const perfBase = 1000;
    try {
      performance.now = () => perfBase + (clock.now - clock.epoch);
    } catch {}

    // Deterministic Math.random (mulberry32) — code that adds jitter stays
    // reproducible; the number of draws is reported as a metric.
    let seed = 0x9e3779b9 >>> 0;
    clock.randomDraws = 0;
    Math.random = function random() {
      clock.randomDraws++;
      seed = (seed + 0x6d2b79f5) >>> 0;
      let r = seed;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };

    const timers = require('timers');
    timers.setTimeout = setTimeoutF;
    timers.setInterval = setIntervalF;
    timers.clearTimeout = clearF;
    timers.clearInterval = clearF;
    try {
      const tp = require('timers/promises');
      tp.setTimeout = (delay, value, opts) => new Promise((resolve, reject) => {
        const t = clock._add(() => resolve(value), delay, [], false);
        const signal = opts && opts.signal;
        if (signal) {
          if (signal.aborted) { clock.clear(t); reject(signal.reason || new Error('The operation was aborted')); return; }
          signal.addEventListener('abort', () => { clock.clear(t); reject(signal.reason || new Error('The operation was aborted')); }, { once: true });
        }
      });
      if (tp.scheduler) tp.scheduler.wait = (delay, opts) => tp.setTimeout(delay, undefined, opts);
    } catch {}
  }
}

module.exports = { FakeClock, REAL, coerceDelay };
