'use strict';
// Harness side: runs the bot in a child process, drives it through fake
// Discord interactions, fake overlays (real WebSocket clients) and HTTP, and
// records every observable effect into ordered steps.

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const WORLD = require('./world');

const HARNESS_DIR = path.resolve(__dirname, '..');
const CANONICAL_UPSTREAM_VIA = 'GET client=tw-ob&ie=UTF-8 ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const LINK_SECRET = 'memedrop-harness-link-secret-6f1d2c3b4a5e';
const EPOCH = 1_800_000_000_000; // 2027-01-15T08:00:00.000Z, T+0 in the transcript

class BotDied extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findUtilsBundle() {
  const cands = [process.env.HARNESS_UTILS_BUNDLE, '/opt/node-tools/node_modules/playwright-core/lib/utilsBundle.js'];
  try { cands.push(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib', 'utilsBundle.js')); } catch { /* not resolvable */ }
  try {
    const pw = path.dirname(require.resolve('playwright'));
    cands.push(path.join(pw, '..', 'playwright-core', 'lib', 'utilsBundle.js'));
    cands.push(path.join(pw, 'node_modules', 'playwright-core', 'lib', 'utilsBundle.js'));
  } catch { /* not resolvable */ }
  for (const c of cands) if (c && fs.existsSync(c)) return fs.realpathSync(c);
  throw new Error('Cannot locate playwright-core/lib/utilsBundle.js (set HARNESS_UTILS_BUNDLE)');
}
const UTILS_BUNDLE = findUtilsBundle();
const WS = require(UTILS_BUNDLE).ws;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', '.env'].includes(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function abbrev(s, max = 48) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  const h = crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, 24)}…[${s.length} chars, sha1:${h}]`;
}

function describeAudio(buf) {
  if (buf.length >= 6 + 32 && buf.slice(0, 3).toString('latin1') === 'ID3') {
    const tag = buf.slice(6, buf.length - 32);
    const digest = crypto.createHash('sha256').update(tag).digest();
    if (digest.equals(buf.slice(buf.length - 32))) return `audio<${abbrev(tag.toString('utf8'), 60)}>`;
  }
  return `bytes<sha1:${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)}>`;
}

// ───────────────────────────── Bot process ────────────────────────────────
class BotProcess {
  constructor(h, label, { env = {}, dataDir, epoch }) {
    this.h = h;
    this.label = label;
    this.env = env;
    this.dataDir = dataDir;
    this.epoch = epoch;
    this.now = epoch;
    this.alive = false;
    this.rid = 0;
    this.waiters = new Map();
    this.exitInfo = null;
    this.loggedIn = false;
  }

  async start() {
    const h = this.h;
    this.port = await freePort();
    const entry = h.entryFile;
    const env = {
      PATH: process.env.PATH,
      HOME: h.workDir,
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      NODE_ENV: 'production',
      PORT: String(this.port),
      DATA_DIR: this.dataDir,
      DISCORD_TOKEN: 'x',
      HARNESS_BOT_DIR: h.codeDir,
      HARNESS_WORLD: h.worldFile,
      HARNESS_EPOCH: String(this.epoch),
      HARNESS_UTILS_BUNDLE: UTILS_BUNDLE,
      ...this.env,
    };
    for (const [k, v] of Object.entries(env)) if (v === undefined || v === null) delete env[k];
    this.logStream = fs.createWriteStream(h.logFile, { flags: 'a' });
    this.logStream.write(`\n===== bot ${this.label} start (port ${this.port}) =====\n`);
    this.child = fork(entry, [], {
      cwd: h.codeDir,
      env,
      execArgv: ['--require', path.join(__dirname, 'preload.js')],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.alive = true;
    this.stderrHead = '';
    this.child.stdout.on('data', (d) => this.logStream.write(d));
    this.child.stderr.on('data', (d) => {
      this.logStream.write(d);
      if (this.stderrHead.length < 8192) this.stderrHead += d.toString();
    });
    this.child.on('message', (m) => this.onMessage(m));
    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.alive = false;
        this.exitInfo = { code, signal };
        this.logStream.write(`===== bot ${this.label} exit code=${code} signal=${signal} =====\n`);
        for (const w of this.waiters.values()) w.reject(new BotDied(`bot ${this.label} exited`));
        this.waiters.clear();
        resolve(this.exitInfo);
      });
    });
    // Ready = discord login happened and the HTTP port answers.
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (!this.alive) throw new BotDied(`bot ${this.label} exited during startup`);
      if (this.loggedIn && await this.httpReady()) return;
      await sleep(20);
    }
    throw new BotDied(`bot ${this.label} did not become ready (login=${this.loggedIn})`);
  }

  httpReady() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', agent: false, timeout: 1000 }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'reply') {
      const w = this.waiters.get(m.rid);
      if (w) { this.waiters.delete(m.rid); clearTimeout(w.timer); w.resolve(m); }
      return;
    }
    if (m.op === 'login') { this.loggedIn = true; return; }
    if (m.op === 'ev') this.h.onChildEvent(this, m.ev);
  }

  request(op, payload = {}, timeoutMs = 5000) {
    if (!this.alive) return Promise.reject(new BotDied(`bot ${this.label} is not running`));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(rid); reject(new Error(`IPC ${op} timed out`)); }, timeoutMs);
      this.waiters.set(rid, { resolve, reject, timer });
      try { this.child.send({ op, rid, ...payload }); } catch (e) { clearTimeout(timer); this.waiters.delete(rid); reject(new BotDied(e.message)); }
    });
  }
}

// ───────────────────────────── Fake overlay ───────────────────────────────
class Overlay {
  constructor(h, name, { autoPong = true } = {}) {
    this.h = h;
    this.name = name;
    this.autoPong = autoPong;
    this.messages = [];
    this.closed = false;
    this.closeCode = null;
  }

  connect(port) {
    return new Promise((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${port}/`, { maxPayload: 1 << 30 });
      this.ws = ws;
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      ws.on('open', () => done(true));
      ws.on('message', (data, isBinary) => { if (!this.detached) this.onMessage(data, isBinary); });
      ws.on('close', (code) => {
        this.closed = true;
        this.closeCode = code;
        if (!this.detached) this.h.record(`ws.${this.name}`, { _closed: code });
        done(false);
      });
      ws.on('error', (e) => {
        if (!settled && !this.detached) this.h.record(`ws.${this.name}`, { _error: e.message });
        done(false);
      });
    });
  }

  onMessage(data, isBinary) {
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch { msg = { _raw: abbrev(text, 80), _binary: Boolean(isBinary) }; }
    this.messages.push(msg);
    if (msg && typeof msg === 'object') {
      if (msg.type === 'pairing_code' && typeof msg.code === 'string') this.h.norm.codes.add(msg.code);
      if (msg.type === 'drop' && typeof msg.dropId === 'string') this.h.norm.dropIds.add(msg.dropId);
      if (typeof msg.token === 'string') this.h.norm.tokens.add(msg.token);
    }
    this.h.record(`ws.${this.name}`, msg);
    if (this.autoPong && msg && msg.type === 'ping' && this.ws.readyState === WS.OPEN) this.ws.send(JSON.stringify({ type: 'pong' }));
  }

  get open() { return this.ws && this.ws.readyState === WS.OPEN; }

  last(type) {
    for (let i = this.messages.length - 1; i >= 0; i--) if (!type || this.messages[i]?.type === type) return this.messages[i];
    return null;
  }

  get code() { return this.last('pairing_code')?.code ?? null; }

  // Round-trip a WebSocket control ping: once the pong is back, every message
  // the bot sent before it, and every message we sent before the ping, has
  // been delivered/processed (TCP ordering).
  sync(timeoutMs = 2000) {
    if (!this.open) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.ws.off('pong', done);
        this.ws.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.ws.once('pong', done);
      this.ws.once('close', done);
      try { this.ws.ping(); } catch { done(); }
    });
  }

  sendRaw(data, binary = false) {
    if (!this.open) return false;
    this.ws.send(data, { binary });
    return true;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.closed) { resolve(); return; }
      this.ws.once('close', () => resolve());
      this.ws.close();
      setTimeout(resolve, 3000);
    });
  }
}

// ───────────────────────────── Harness ────────────────────────────────────
class Harness {
  constructor({ botDir, outPath, keep = false }) {
    this.srcBotDir = path.resolve(botDir);
    this.outPath = path.resolve(outPath);
    this.keep = keep;
    this.workDir = path.join(HARNESS_DIR, '.work', `run-${process.pid}-${Date.now()}`);
    this.codeDir = path.join(this.workDir, 'code');
    this.logFile = `${this.outPath}.log`;
    this.steps = [];
    this.cur = null;
    this.stepSeq = 0;
    this.procLabel = 'h';
    this.bot = null;
    this.overlays = new Map();
    this.eventCount = 0;
    this.groupDepth = 0;
    this.iidSeq = 0;
    this.iidMap = new Map();
    this.chanSeqMap = new Map();
    this.norm = { codes: new Set(), dropIds: new Set(), tokens: new Set(), fixed: new Map() };
    this.processes = {};
    this.counters = {};
    this.upstream = { total: 0, byProcess: {} };
    this.timing = { started: Date.now(), processes: {} };
  }

  async init() {
    if (!fs.existsSync(this.srcBotDir)) throw new Error(`bot dir not found: ${this.srcBotDir}`);
    fs.mkdirSync(this.workDir, { recursive: true });
    copyDir(this.srcBotDir, this.codeDir);
    let main = 'index.js';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.codeDir, 'package.json'), 'utf8'));
      if (pkg.main) main = pkg.main;
    } catch { /* default */ }
    this.entryFile = path.resolve(this.codeDir, main);
    if (!fs.existsSync(this.entryFile) && fs.existsSync(`${this.entryFile}.js`)) this.entryFile += '.js';
    this.worldFile = path.join(this.workDir, 'world.json');
    fs.writeFileSync(this.worldFile, JSON.stringify(WORLD.snapshot(), null, 2));
    fs.writeFileSync(this.logFile, `harness run ${new Date().toISOString()} bot=${this.srcBotDir}\n`);
  }

  cleanup() {
    if (!this.keep) fs.rmSync(this.workDir, { recursive: true, force: true });
  }

  // ───────────── steps & recording ─────────────
  vt() { return this.bot ? this.bot.now - EPOCH : null; }

  beginStep(desc) {
    const id = `${this.procLabel}.${String(++this.stepSeq).padStart(3, '0')}`;
    this.cur = { id, do: desc, t: this.vt(), ev: {} };
    this.steps.push(this.cur);
    return this.cur;
  }

  record(channel, entry, step = this.cur) {
    if (!step) step = this.beginStep('(events outside any step)');
    (step.ev[channel] ||= []).push(entry);
    this.eventCount++;
  }

  async step(desc, fn) {
    if (this.groupDepth > 0) return fn();
    this.beginStep(desc);
    this.groupDepth++;
    try {
      const r = await fn();
      await this.settle();
      return r;
    } finally {
      this.groupDepth--;
    }
  }

  onChildEvent(bot, ev) {
    switch (ev.k) {
      case 'ix': {
        const m = this.iidMap.get(ev.iid);
        const step = m ? m.step : this.cur;
        const label = m ? m.label : '?';
        const ix = (step.ev.ix ||= {});
        const calls = (ix[label] ||= []);
        calls.push({ m: ev.m, ...ev.a });
        if (m) m.calls.set(ev.n, calls[calls.length - 1]);
        this.eventCount++;
        break;
      }
      case 'ixerr': {
        const m = this.iidMap.get(ev.iid);
        const call = m && m.calls.get(ev.n);
        if (call) call.error = ev.err;
        else this.record('note', { ixerr: ev.err });
        this.eventCount++;
        break;
      }
      case 'chan': {
        const entry = { ch: this.channelName(ev.ch) };
        for (const [k, v] of Object.entries(ev)) if (!['k', 'seq', 'ch'].includes(k)) entry[k] = v;
        this.chanSeqMap.set(ev.seq, entry);
        this.record('chan', entry);
        break;
      }
      case 'chanerr': {
        const entry = this.chanSeqMap.get(ev.seq);
        if (entry) entry.error = ev.err;
        this.eventCount++;
        break;
      }
      case 'dm': {
        const { k, ...rest } = ev;
        this.record('dm', rest);
        break;
      }
      case 'upstream': {
        this.upstream.total++;
        this.upstream.byProcess[bot.label] = (this.upstream.byProcess[bot.label] || 0) + 1;
        let entry;
        if (ev.unexpected) entry = { unexpected: ev.url, method: ev.method };
        else {
          entry = { tl: ev.tl, q: abbrev(ev.q) };
          // Request shape other than tl/q; only shown when it differs from
          // what the current bot sends, to keep the transcript readable.
          const via = `${ev.method} ${ev.params} ua=${ev.ua}`;
          if (via !== CANONICAL_UPSTREAM_VIA) entry.via = via;
        }
        this.record('upstream', entry);
        break;
      }
      case 'discord': {
        const { k, ...rest } = ev;
        this.record('discord', rest);
        break;
      }
      case 'note':
        this.record('note', ev.note);
        break;
      default:
        this.record('note', { unknownEvent: ev });
    }
  }

  channelName(id) {
    for (const [key, c] of Object.entries(WORLD.CHANNELS)) if (c.id === id) return key;
    return id;
  }

  // Record a bot process exit once, after the overlays saw their sockets close.
  async reportExit(bot, unexpected) {
    if (bot.exitReported) return;
    bot.exitReported = true;
    const info = await bot.exitPromise;
    await this.waitOverlaysClosed();
    this.record('exit', { code: info.code, signal: info.signal, ...(unexpected ? { unexpected: true } : {}) });
  }

  async settle({ maxMs = 10000 } = {}) {
    const t0 = Date.now();
    let stable = 0;
    let lastCount = -1;
    for (;;) {
      if (this.bot && !this.bot.alive && this.bot.exitInfo && !this.bot.exitReported) await this.reportExit(this.bot, true);
      let pending = 0;
      if (this.bot && this.bot.alive) {
        try { pending = (await this.bot.request('idle', {}, 4000)).pending; } catch { pending = this.bot.alive ? -1 : 0; }
      }
      await Promise.all([...this.overlays.values()].map((o) => o.sync()));
      const count = this.eventCount;
      if (pending === 0 && count === lastCount) {
        if (++stable >= 2) return;
      } else stable = 0;
      lastCount = count;
      if (Date.now() - t0 > maxMs) { this.record('harness', 'settle timeout'); return; }
      await sleep(8);
    }
  }

  requireBot() {
    if (!this.bot || !this.bot.alive) throw new BotDied(`bot ${this.procLabel} is not running`);
    return this.bot;
  }

  // ───────────── processes ─────────────
  async runProcess(label, { env = {}, dataDir, epoch, title }, body) {
    this.procLabel = label;
    this.stepSeq = 0;
    fs.mkdirSync(dataDir, { recursive: true });
    const bot = new BotProcess(this, label, { env, dataDir, epoch });
    this.bot = bot;
    this.lastDataDir = dataDir;
    this.processes[label] = { exit: null };
    const t0 = Date.now();
    const startStep = this.beginStep(`start bot ${label}${title ? ` — ${title}` : ''}`);
    try {
      // The free port is picked before the bot binds it; if something else
      // grabbed it meanwhile, start again on a new port with a clean record.
      for (let attempt = 1; ; attempt++) {
        try {
          await bot.start();
          break;
        } catch (e) {
          if (!(e instanceof BotDied) || attempt >= 3 || !/EADDRINUSE/.test(bot.stderrHead || '')) throw e;
          startStep.ev = {};
          bot.loggedIn = false;
        }
      }
      await this.settle();
      await body(bot);
    } catch (e) {
      if (!(e instanceof BotDied)) throw e;
      this.record('harness', `aborted: ${e.message.replace(/ \(port \d+\)/, '')}`);
    } finally {
      if (bot.alive) {
        try { await this.fetchCounters(); } catch { /* ignore */ }
        this.beginStep(`stop bot ${label} with SIGKILL (end of block)`);
        bot.exitReported = true;
        bot.child.kill('SIGKILL');
        const info = await bot.exitPromise;
        await this.waitOverlaysClosed();
        this.record('exit', { code: info.code, signal: info.signal });
      } else if (!bot.exitReported && bot.exitInfo) {
        await this.reportExit(bot, true);
      }
      if (bot.exitInfo) this.processes[label].exit = bot.exitInfo;
      for (const o of this.overlays.values()) {
        o.detached = true;
        try { o.ws.terminate(); } catch { /* ignore */ }
      }
      this.overlays.clear();
      this.counters[label] = bot.counters || null;
      this.timing.processes[label] = Date.now() - t0;
      this.bot = null;
      this.cur = null;
    }
  }

  waitOverlaysClosed(timeoutMs = 3000) {
    return Promise.all([...this.overlays.values()].map((o) => (o.closed || !o.ws ? null : new Promise((r) => {
      o.ws.once('close', () => setImmediate(r));
      setTimeout(r, timeoutMs);
    }))));
  }

  async fetchCounters() {
    const bot = this.requireBot();
    const r = await bot.request('counters');
    bot.counters = Object.fromEntries(Object.entries(r.counters).sort(([a], [b]) => a.localeCompare(b)));
  }

  async signal(sig) {
    return this.step(`send ${sig} to bot ${this.procLabel}`, async () => {
      const bot = this.requireBot();
      await this.fetchCounters();
      bot.exitReported = true;
      bot.child.kill(sig);
      let forced = false;
      const timer = setTimeout(() => { if (bot.alive) { forced = true; bot.child.kill('SIGKILL'); } }, 8000);
      const info = await bot.exitPromise;
      clearTimeout(timer);
      await this.waitOverlaysClosed();
      this.record('exit', { code: info.code, signal: info.signal, ...(forced ? { note: 'did not exit within 8 s, SIGKILLed' } : {}) });
      return info;
    });
  }

  // ───────────── virtual time ─────────────
  async advance(ms, desc) {
    return this.step(desc || `advance virtual clock +${ms} ms`, async () => {
      const bot = this.requireBot();
      const target = bot.now + ms;
      for (;;) {
        const nx = await bot.request('clock.next');
        if (nx.due === null || nx.due > target) break;
        const r = await bot.request('clock.fire', { limit: target });
        bot.now = r.now;
        if (!r.fired) break;
        await this.settle();
      }
      const r = await bot.request('clock.set', { at: target });
      bot.now = r.now;
      this.cur.t_end = bot.now - EPOCH;
    });
  }

  async advanceTo(at, desc) {
    return this.step(desc || `advance virtual clock to T+${at - EPOCH}`, async () => {
      const bot = this.requireBot();
      if (at <= bot.now) throw new Error(`advanceTo(${at}) is not in the future (now ${bot.now})`);
      await this.advance(at - bot.now);
    });
  }

  async realWait(ms, desc) {
    return this.step(desc || `wait ${ms} ms (real time)`, async () => { await sleep(ms); });
  }

  // ───────────── interactions ─────────────
  buildSpec(actor, where, commandName, options = {}, extra = {}) {
    const user = WORLD.userByName(actor);
    const ch = where ? WORLD.CHANNELS[where] : null;
    if (where && !ch) throw new Error(`unknown channel ${where}`);
    const guildId = ch && ch.guild ? WORLD.GUILDS[ch.guild].id : null;
    if (ch && ch.guild && !WORLD.GUILDS[ch.guild].members.includes(actor)) {
      throw new Error(`scenario error: ${actor} is not a member of ${ch.guild} and cannot use commands there`);
    }
    const iid = String(500000000000000000n + BigInt(++this.iidSeq));
    const opts = [];
    const shown = [];
    for (const [name, v] of Object.entries(options)) {
      if (v === undefined) continue;
      if (v && v.__user) {
        opts.push({ name, type: 6, value: WORLD.userByName(v.__user).id });
        shown.push(`${name}:@${v.__user}`);
      } else if (v && v.__att) {
        opts.push({ name, type: 11, attachment: v.__att });
        shown.push(`${name}:[${v.__att.name} ${v.__att.contentType}]`);
      } else if (typeof v === 'number') {
        opts.push({ name, type: 4, value: v });
        shown.push(`${name}:${v}`);
      } else {
        opts.push({ name, type: 3, value: String(v) });
        shown.push(`${name}:${JSON.stringify(abbrev(String(v), 40))}`);
      }
    }
    const spec = {
      iid, kind: extra.kind || 'chat', commandName, userId: user.id, guildId,
      channelId: ch ? ch.id : null, subcommand: extra.sub || null, options: opts,
      expired: Boolean(extra.expired),
    };
    const desc = extra.kind === 'button'
      ? `[button ${commandName}] by ${actor} @${where || 'none'}`
      : `/${commandName}${extra.sub ? ` ${extra.sub}` : ''}${shown.length ? ` ${shown.join(' ')}` : ''} — by ${actor} @${where || 'none'}${extra.expired ? ' (interaction token already expired)' : ''}`;
    return { spec, desc, label: actor };
  }

  async cmd(actor, where, commandName, options = {}, extra = {}) {
    const { spec, desc, label } = this.buildSpec(actor, where, commandName, options, extra);
    return this.step(extra.desc || desc, async () => {
      const bot = this.requireBot();
      this.iidMap.set(spec.iid, { step: this.cur, label, calls: new Map() });
      await bot.request('interaction', { spec });
      await this.settle();
    });
  }

  // Several interactions dispatched back-to-back (same tick), one step.
  async cmdBurst(desc, list) {
    return this.step(desc, async () => {
      const bot = this.requireBot();
      const built = list.map(([actor, where, name, options, extra], i) => {
        const b = this.buildSpec(actor, where, name, options, extra || {});
        b.label = `#${i + 1} ${actor}`;
        return b;
      });
      for (const b of built) this.iidMap.set(b.spec.iid, { step: this.cur, label: b.label, calls: new Map() });
      await bot.request('interactions', { specs: built.map((b) => b.spec) });
      await this.settle();
    });
  }

  async world(action, args, desc) {
    return this.step(desc || `world: ${action} ${JSON.stringify(args)}`, async () => {
      const bot = this.requireBot();
      await bot.request('world', { action, args });
      await this.settle();
    });
  }

  // ───────────── overlays ─────────────
  async connect(name, opts = {}) {
    if (this.overlays.has(name)) throw new Error(`overlay ${name} already exists`);
    const o = new Overlay(this, name, opts);
    this.overlays.set(name, o);
    await this.step(opts.desc || `overlay ${name} connects${opts.autoPong === false ? ' (does not answer pings)' : ''}`, async () => {
      const bot = this.requireBot();
      await o.connect(bot.port);
      await this.settle();
    });
    return o;
  }

  async wsSend(name, payload, { binary = false, desc } = {}) {
    const o = this.overlays.get(name);
    const text = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    const shown = desc || `overlay ${name} sends ${binary ? '(binary) ' : ''}${abbrev(Buffer.isBuffer(text) ? `<${text.length} bytes>` : text, 400)}`;
    return this.step(shown, async () => {
      if (!o || !o.sendRaw(text, binary)) this.record('harness', `overlay ${name} not open, nothing sent`);
      await o?.sync();
      await this.settle();
    });
  }

  async wsClose(name, desc) {
    const o = this.overlays.get(name);
    return this.step(desc || `overlay ${name} disconnects`, async () => {
      await o.close();
      this.overlays.delete(name);
      await this.settle();
    });
  }

  // ───────────── HTTP ─────────────
  httpRequest(method, urlPath, headers = {}) {
    const bot = this.requireBot();
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: bot.port, method, path: urlPath, headers, agent: false, timeout: 10000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const rec = { req: `${method} ${abbrev(urlPath, 90)}`, status: res.statusCode };
          if (headers['x-forwarded-for']) rec.xff = headers['x-forwarded-for'];
          for (const hname of ['content-type', 'content-length', 'cache-control']) {
            if (res.headers[hname] !== undefined) rec[hname] = res.headers[hname];
          }
          rec.bodyLen = body.length;
          const ct = String(res.headers['content-type'] || '');
          if (ct.startsWith('audio/')) rec.body = describeAudio(body);
          else if (body.length) rec.body = abbrev(body.toString('utf8'), 120);
          resolve(rec);
        });
      });
      req.on('error', (e) => resolve({ req: `${method} ${abbrev(urlPath, 90)}`, error: e.code || e.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  async get(urlPath, { headers = {}, method = 'GET', desc } = {}) {
    return this.step(desc || `HTTP ${method} ${abbrev(urlPath, 90)}${headers['x-forwarded-for'] ? ` [XFF ${headers['x-forwarded-for']}]` : ''}`, async () => {
      const rec = await this.httpRequest(method, urlPath, headers);
      this.record('http', rec);
      return rec;
    });
  }

  async getConcurrent(n, urlPath, { headers = {}, desc } = {}) {
    return this.step(desc || `HTTP GET ${abbrev(urlPath, 90)} x${n} concurrently`, async () => {
      const recs = await Promise.all(Array.from({ length: n }, () => this.httpRequest('GET', urlPath, headers)));
      const groups = new Map();
      for (const r of recs) {
        const key = JSON.stringify(r);
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      for (const [key, count] of [...groups.entries()].sort()) this.record('http', { ...JSON.parse(key), count });
      return recs;
    });
  }

  // Sequential requests in one step, recorded compactly (status + body).
  async httpSeries(desc, requests) {
    return this.step(desc, async () => {
      const out = [];
      for (const r of requests) {
        const rec = await this.httpRequest('GET', r.path, r.headers || {});
        const compact = { req: rec.req };
        if (rec.xff) compact.xff = rec.xff;
        compact.status = rec.status;
        if (rec.error) compact.error = rec.error;
        if (rec.body !== undefined) compact.body = rec.body;
        this.record('http', compact);
        out.push(rec);
      }
      return out;
    });
  }

  async rawHttp(requestText, desc) {
    return this.step(desc || `raw HTTP ${JSON.stringify(abbrev(requestText.split('\r\n')[0], 80))}`, async () => {
      const bot = this.requireBot();
      const res = await new Promise((resolve) => {
        const s = net.connect(bot.port, '127.0.0.1', () => s.write(requestText));
        let data = '';
        const timer = setTimeout(() => s.destroy(), 1500);
        s.on('data', (d) => { data += d.toString('latin1'); });
        s.on('close', () => { clearTimeout(timer); resolve(data); });
        s.on('error', () => { /* close follows */ });
      });
      const statusLine = res.split('\r\n')[0];
      this.record('http', { raw: abbrev(requestText.split('\r\n')[0], 80), response: statusLine || '<connection closed without response>' });
      await sleep(150);
      if (!bot.alive) await this.reportExit(bot, true);
    });
  }

  async setUpstreamLatency(ms) {
    await this.requireBot().request('upstream.latency', { ms });
  }

  // ───────────── store ─────────────
  async snapshotStore(desc) {
    const bot = this.bot;
    const dataDir = bot ? bot.dataDir : this.lastDataDir;
    return this.step(desc || 'snapshot DATA_DIR', async () => {
      this.record('store', this.readStore(dataDir));
    });
  }

  readStore(dataDir) {
    const out = { files: fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : null };
    const file = path.join(dataDir, 'store.json');
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      try { out.json = JSON.parse(raw); } catch { out.unparsable = abbrev(raw, 80); }
    }
    return out;
  }

  // ───────────── output ─────────────
  finalizeSteps() {
    const order = ['ix', 'ws', 'chan', 'dm', 'http', 'upstream', 'discord', 'store', 'exit', 'note', 'harness'];
    return this.steps.map((s) => {
      const out = { id: s.id, do: s.do, t: s.t };
      if (s.t_end !== undefined) out.t_end = s.t_end;
      const keys = Object.keys(s.ev);
      const ws = keys.filter((k) => k.startsWith('ws.')).sort();
      for (const group of order) {
        if (group === 'ws') {
          if (ws.length) {
            out.ws = {};
            for (const k of ws) out.ws[k.slice(3)] = rle(s.ev[k]);
          }
          continue;
        }
        if (group === 'ix' && s.ev.ix) {
          const labels = Object.keys(s.ev.ix).sort();
          out.ix = labels.length === 1 && !labels[0].startsWith('#') ? { [labels[0]]: s.ev.ix[labels[0]] } : Object.fromEntries(labels.map((l) => [l, s.ev.ix[l]]));
          continue;
        }
        if (s.ev[group]) out[group] = group === 'upstream' ? sortByJson(s.ev[group]) : s.ev[group];
      }
      for (const k of keys) if (!k.startsWith('ws.') && !order.includes(k)) out[k] = s.ev[k];
      return out;
    });
  }
}

function rle(list) {
  const out = [];
  for (const item of list) {
    const prev = out[out.length - 1];
    const key = JSON.stringify(item);
    if (prev && prev.key === key) prev.n++;
    else out.push({ key, item, n: 1 });
  }
  return out.map(({ item, n }) => (n > 1 ? { _repeat: n, ...item } : item));
}

function sortByJson(list) {
  return [...list].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
}

const U = (name) => ({ __user: name });
const ATT = (a) => ({ __att: a });

module.exports = { Harness, BotDied, U, ATT, EPOCH, LINK_SECRET, sleep, abbrev, WORLD };
