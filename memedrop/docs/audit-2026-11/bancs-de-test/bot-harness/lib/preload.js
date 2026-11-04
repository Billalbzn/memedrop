'use strict';
// Loaded with `node --require` into the bot process. It:
//   1. redirects require('discord.js' | 'ws' | 'dotenv') to harness stand-ins;
//   2. installs a virtual wall clock (Date, Date.now, performance.now) that
//      only moves when the harness says so;
//   3. virtualizes LONG timers created by the bot's own code (>= 10 s:
//      heartbeat, cleanup intervals, delayed drops) so the harness can fire
//      them deterministically, and tracks SHORT bot timers (< 250 ms) so the
//      harness knows when the bot is idle;
//   4. replaces global fetch with a deterministic Google-TTS upstream;
//   5. talks to the harness over the fork() IPC channel.
// Nothing here knows about the bot's internal function names.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const util = require('util');
const timersMod = require('timers');
const timersPromises = require('timers/promises');
const { performance } = require('perf_hooks');
const { fileURLToPath } = require('url');

const LIB = __dirname;
const BOT_DIR = fs.realpathSync(process.env.HARNESS_BOT_DIR);
const EPOCH = Number(process.env.HARNESS_EPOCH);
const VIRTUAL_MIN_MS = Number(process.env.HARNESS_VIRTUAL_MIN_MS || 10_000);
const TRACK_MAX_MS = Number(process.env.HARNESS_TRACK_MAX_MS || 250);

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  tpSetTimeout: timersPromises.setTimeout,
  fetch: globalThis.fetch,
};

function send(msg) {
  try { if (process.connected) process.send(msg); } catch { /* channel closing */ }
}

// ───────────────────────── shared harness state ───────────────────────────
const clock = { now: EPOCH };
const H = globalThis.__mdHarness = {
  world: JSON.parse(fs.readFileSync(process.env.HARNESS_WORLD, 'utf8')),
  clock,
  send,
  latencyMs: Number(process.env.HARNESS_LATENCY_MS || 5),
  upstreamLatencyMs: 10,
  realSetTimeout: real.setTimeout,
  pendingOps: 0,
  pendingFetch: 0,
  pendingTimers: 0,
  chanSeq: 0,
  clients: [],
  channelObjects: new Map(),
  counters: {},
  count(name) { this.counters[name] = (this.counters[name] || 0) + 1; },
  delay(ms) { return new Promise((resolve) => real.setTimeout(resolve, ms)); },
  async op(fn) {
    this.pendingOps++;
    try { return await fn(); } finally { this.pendingOps--; }
  },
};

// ───────────────────────── module redirection ─────────────────────────────
const REDIRECT = {
  'discord.js': path.join(LIB, 'fake-discord.js'),
  ws: path.join(LIB, 'stub-ws.js'),
  dotenv: path.join(LIB, 'stub-dotenv.js'),
  'dotenv/config': path.join(LIB, 'stub-dotenv.js'),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithHarness(request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(REDIRECT, request)) return REDIRECT[request];
  return origResolve.call(this, request, parent, isMain, options);
};

// ───────────────────────── virtual wall clock ─────────────────────────────
const RealDate = Date;
function FakeDate(...args) {
  if (!new.target) return new RealDate(clock.now).toString();
  return args.length === 0 ? Reflect.construct(RealDate, [clock.now], new.target) : Reflect.construct(RealDate, args, new.target);
}
Object.setPrototypeOf(FakeDate, RealDate);
FakeDate.prototype = RealDate.prototype;
FakeDate.now = function now() { return clock.now; };
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
globalThis.Date = FakeDate;

const perfBase = performance.now();
Object.defineProperty(performance, 'now', {
  configurable: true, writable: true,
  value: function now() { return perfBase + (clock.now - EPOCH); },
});

// ───────────────────────── timers ─────────────────────────────────────────
function callerFile(skip) {
  const prevPrep = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  let file = '';
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_e, cs) => cs;
    const holder = {};
    Error.captureStackTrace(holder, skip);
    const cs = holder.stack;
    if (Array.isArray(cs) && cs[0]) file = cs[0].getFileName() || '';
  } catch { /* ignore */ } finally {
    Error.prepareStackTrace = prevPrep;
    Error.stackTraceLimit = prevLimit;
  }
  if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { /* ignore */ } }
  return file;
}
function fromBot(skip) {
  const f = callerFile(skip);
  return f.startsWith(BOT_DIR + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`);
}
function coerceDelay(delay) {
  const d = Number(delay);
  return d >= 1 && d <= 2147483647 ? d : 1;
}

const vtimers = new Map();
let vseq = 0;
let vid = 9e12;
class VirtualTimeout {
  constructor(fn, args, delay, repeat) {
    this._id = ++vid;
    this._fn = fn;
    this._args = args;
    this._delay = delay;
    this._repeat = repeat;
    this._due = clock.now + delay;
    this._seq = ++vseq;
    this._active = true;
    vtimers.set(this._id, this);
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  refresh() {
    if (this._active) { this._due = clock.now + this._delay; this._seq = ++vseq; }
    return this;
  }
  close() { clearVirtual(this); return this; }
  [Symbol.toPrimitive]() { return this._id; }
}
function clearVirtual(t) {
  if (t && t._active) { t._active = false; vtimers.delete(t._id); }
}

const trackedReal = new Map(); // primitive id -> Timeout
function untrack(t) {
  if (t === null || t === undefined) return;
  let key;
  if (typeof t === 'object' && typeof t[Symbol.toPrimitive] === 'function') key = t[Symbol.toPrimitive]();
  else if (typeof t === 'number' || typeof t === 'string') key = Number(t);
  if (key !== undefined && trackedReal.delete(key)) H.pendingTimers--;
}
function trackedTimeout(fn, delay, args) {
  let key;
  const t = real.setTimeout(function trackedTimerFired(...a) {
    if (trackedReal.delete(key)) H.pendingTimers--;
    return fn.apply(this, a);
  }, delay, ...args);
  key = t[Symbol.toPrimitive]();
  trackedReal.set(key, t);
  H.pendingTimers++;
  return t;
}

function hSetTimeout(fn, delay, ...args) {
  if (typeof fn === 'function') {
    const d = coerceDelay(delay);
    if (d >= VIRTUAL_MIN_MS) {
      if (fromBot(hSetTimeout)) return new VirtualTimeout(fn, args, d, false);
    } else if (d < TRACK_MAX_MS && fromBot(hSetTimeout)) {
      return trackedTimeout(fn, delay, args);
    }
  }
  return real.setTimeout(fn, delay, ...args);
}
function hSetInterval(fn, delay, ...args) {
  if (typeof fn === 'function' && coerceDelay(delay) >= VIRTUAL_MIN_MS && fromBot(hSetInterval)) {
    return new VirtualTimeout(fn, args, coerceDelay(delay), true);
  }
  return real.setInterval(fn, delay, ...args);
}
function hClearTimeout(t) {
  if (t instanceof VirtualTimeout) return clearVirtual(t);
  if ((typeof t === 'number' || typeof t === 'string') && vtimers.has(Number(t))) return clearVirtual(vtimers.get(Number(t)));
  untrack(t);
  return real.clearTimeout(t);
}
function abortError(signal) {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  e.cause = signal?.reason;
  return e;
}
function hPromiseTimeout(delay, value, options = {}) {
  const d = coerceDelay(delay);
  if (d >= VIRTUAL_MIN_MS && fromBot(hPromiseTimeout)) {
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) { reject(abortError(signal)); return; }
      const vt = new VirtualTimeout(() => resolve(value), [], d, false);
      if (signal) signal.addEventListener('abort', () => { clearVirtual(vt); reject(abortError(signal)); }, { once: true });
    });
  }
  if (d < TRACK_MAX_MS && fromBot(hPromiseTimeout)) {
    H.pendingTimers++;
    return real.tpSetTimeout(delay, value, options).finally(() => { H.pendingTimers--; });
  }
  return real.tpSetTimeout(delay, value, options);
}
hSetTimeout[util.promisify.custom] = hPromiseTimeout;

globalThis.setTimeout = hSetTimeout;
globalThis.setInterval = hSetInterval;
globalThis.clearTimeout = hClearTimeout;
globalThis.clearInterval = hClearTimeout;
timersMod.setTimeout = hSetTimeout;
timersMod.setInterval = hSetInterval;
timersMod.clearTimeout = hClearTimeout;
timersMod.clearInterval = hClearTimeout;
timersPromises.setTimeout = hPromiseTimeout;
try { Module.syncBuiltinESMExports(); } catch { /* older node */ }

function nextVirtual() {
  let best = null;
  for (const t of vtimers.values()) {
    if (!t._active) continue;
    if (!best || t._due < best._due || (t._due === best._due && t._seq < best._seq)) best = t;
  }
  return best;
}

// ───────────────────────── Google TTS upstream ────────────────────────────
// Response bytes are a deterministic function of (tl, q) so the harness can
// tell which upstream audio an HTTP response carries.
function fakeAudio(tl, q) {
  const tag = Buffer.from(`${tl}|${q}`, 'utf8');
  const digest = crypto.createHash('sha256').update(tag).digest();
  return Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000', 'latin1'), tag, digest]);
}
globalThis.fetch = async function harnessFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
  H.pendingFetch++;
  try {
    let parsed = null;
    try { parsed = new URL(url); } catch { /* invalid */ }
    let ua = null;
    try { ua = new Headers(init.headers || (input && input.headers) || {}).get('user-agent'); } catch { /* ignore */ }
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (parsed && parsed.hostname === 'translate.google.com' && parsed.pathname === '/translate_tts') {
      const q = parsed.searchParams.get('q');
      const tl = parsed.searchParams.get('tl');
      const other = [...parsed.searchParams].filter(([k]) => k !== 'q' && k !== 'tl').map(([k, v]) => `${k}=${v}`).sort().join('&');
      send({ op: 'ev', ev: { k: 'upstream', method, tl, q, params: other, ua } });
      await H.delay(H.upstreamLatencyMs);
      if (q && q.includes('[neterr]')) throw new TypeError('fetch failed');
      if (q && q.includes('[503]')) return new Response('upstream unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
      return new Response(fakeAudio(tl, q), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    send({ op: 'ev', ev: { k: 'upstream', unexpected: true, method, url } });
    await H.delay(H.upstreamLatencyMs);
    throw new TypeError('fetch failed');
  } finally {
    H.pendingFetch--;
  }
};

// ───────────────────────── IPC from the harness ───────────────────────────
function reply(msg, data) { send({ op: 'reply', rid: msg.rid, ...data }); }

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.op) {
    case 'idle':
      real.setImmediate(() => reply(msg, {
        pending: H.pendingOps + H.pendingFetch + H.pendingTimers,
        detail: { ops: H.pendingOps, fetch: H.pendingFetch, timers: H.pendingTimers },
      }));
      break;
    case 'interaction':
    case 'interactions': {
      // Several specs are dispatched synchronously in the same tick, which
      // makes "two commands at the same instant" races reproducible.
      const specs = msg.op === 'interaction' ? [msg.spec] : msg.specs;
      if (!H.discord) { send({ op: 'ev', ev: { k: 'note', note: 'interaction dropped: discord.js not loaded by the bot' } }); reply(msg, {}); break; }
      for (const spec of specs) H.discord.dispatchInteraction(spec);
      reply(msg, {});
      break;
    }
    case 'world':
      if (H.discord && typeof H.discord[msg.action] === 'function') H.discord[msg.action](...(msg.args || []));
      reply(msg, {});
      break;
    case 'clock.next': {
      const t = nextVirtual();
      reply(msg, { now: clock.now, due: t ? t._due : null });
      break;
    }
    case 'clock.fire': {
      const t = nextVirtual();
      if (!t || t._due > msg.limit) { reply(msg, { fired: false, now: clock.now }); break; }
      if (t._due > clock.now) clock.now = t._due;
      if (t._repeat) { t._due = clock.now + t._delay; t._seq = ++vseq; } else clearVirtual(t);
      try {
        t._fn.apply(t, t._args);
      } catch (e) {
        process.nextTick(() => { throw e; });
      }
      reply(msg, { fired: true, now: clock.now });
      break;
    }
    case 'clock.set':
      if (msg.at > clock.now) clock.now = msg.at;
      reply(msg, { now: clock.now });
      break;
    case 'upstream.latency':
      H.upstreamLatencyMs = msg.ms;
      reply(msg, {});
      break;
    case 'counters':
      reply(msg, { counters: H.counters });
      break;
    default:
      reply(msg, { error: `unknown op ${msg.op}` });
  }
});
