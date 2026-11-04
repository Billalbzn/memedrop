'use strict';
// Real loopback WebSockets between the code under test and a scripted fake
// bot, plus the bookkeeping that lets the harness know when the network is
// quiet (every handshake finished, every frame delivered, every close seen
// by both ends) so that a step can end deterministically.
//
// The 'ws' module seen by the code under test is a thin subclass of the
// ws@8.21.0 client bundled with Playwright (same version as the overlay's
// package-lock). It tags each connection with an `x-harness-conn` header so
// the bot can pair server-side sockets with client-side ones, and maps any
// host other than the fake bot to a path the bot answers with HTTP 503
// (no real network access ever happens).

const http = require('http');
// ws@8.21.0 + WebSocketServer as bundled by playwright-core (no npm here).
// Override with MEMEDROP_WS_BUNDLE=<path to a module exporting {ws, wsServer}>.
const u = (() => {
  const candidates = [process.env.MEMEDROP_WS_BUNDLE, '/opt/node-tools/node_modules/playwright-core/lib/utilsBundle'];
  try { candidates.push(require('path').join(require.resolve('playwright-core/package.json'), '..', 'lib', 'utilsBundle')); } catch {}
  for (const c of candidates) {
    if (!c) continue;
    try { const m = require(c); if (m && m.ws && m.wsServer) return m; } catch {}
  }
  throw new Error('cannot load a ws implementation (set MEMEDROP_WS_BUNDLE)');
})();

const RealWS = u.ws;
const WSServer = u.wsServer;

function parseFrame(data) {
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : String(data);
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : { $raw: s };
  } catch {
    return { $raw: s };
  }
}

class Net {
  constructor(H) {
    this.H = H;
    this.conns = new Map();
    this.bySock = new WeakMap();
    this.nextId = 1;
    this.raw = new Set();
    this.botPort = null;
  }

  mapUrl(address) {
    let url;
    try { url = new URL(String(address)); } catch { return address; }
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (local && Number(url.port) === this.botPort && (url.protocol === 'ws:' || url.protocol === 'http:')) return address;
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) return address; // let ws reject the scheme
    return `ws://127.0.0.1:${this.botPort}/__unreachable__/${url.host}${url.pathname}`;
  }

  // ---- client side (called from the ws subclass) ----
  onConstructError(address, err) {
    this.H.netConstructError(String(address), err);
  }
  onCreate(sock, id, address, target) {
    const conn = {
      id, url: String(address), redirected: target !== address, client: sock,
      cState: 'connecting', sState: 'none',
      c2sSent: 0, c2sRecv: 0, s2cSent: 0, s2cRecv: 0,
      server: null, path: null, isAlive: true, user: null,
    };
    this.conns.set(id, conn);
    this.bySock.set(sock, conn);
    this.H.netEv(conn, 'client', 'attempt', conn.redirected ? { unreachable: true } : {});
  }
  onClientEvent(sock, event, args) {
    const conn = this.bySock.get(sock);
    if (!conn) return;
    switch (event) {
      case 'open':
        conn.cState = 'open';
        this.H.netEv(conn, 'client', 'open', {});
        break;
      case 'message':
        conn.s2cRecv++;
        this.H.netFrame(conn, 's2c', parseFrame(args[0]));
        break;
      case 'error':
        this.H.netEv(conn, 'client', 'error', { message: args[0] && args[0].message });
        break;
      case 'close':
        conn.cState = 'closed';
        this.H.netEv(conn, 'client', 'close', { code: args[0] });
        break;
      default:
        break;
    }
  }
  onClientSend(sock) {
    const conn = this.bySock.get(sock);
    if (conn && sock.readyState === RealWS.OPEN) conn.c2sSent++;
  }
  onClientClosing(sock) {
    const conn = this.bySock.get(sock);
    if (conn && (conn.cState === 'connecting' || conn.cState === 'open')) conn.cState = 'closing';
  }

  pending() {
    if (this.raw.size > 0) return 'raw-socket';
    for (const c of this.conns.values()) {
      if (c.cState === 'connecting') return `conn${c.id}:connecting`;
      if (c.cState === 'closing') return `conn${c.id}:client-closing`;
      if (c.sState === 'closing') return `conn${c.id}:server-closing`;
      if (c.cState === 'open') {
        if (c.sState !== 'open') return `conn${c.id}:server-not-open(${c.sState})`;
        if (c.c2sSent !== c.c2sRecv) return `conn${c.id}:c2s ${c.c2sRecv}/${c.c2sSent}`;
        if (c.s2cSent !== c.s2cRecv) return `conn${c.id}:s2c ${c.s2cRecv}/${c.s2cSent}`;
      }
      if (c.cState === 'closed' && c.sState === 'open') return `conn${c.id}:server-not-closed`;
    }
    return null;
  }

  openConns() {
    return [...this.conns.values()].filter((c) => c.sState === 'open' && c.cState === 'open');
  }
}

function createWsModule(net) {
  class WebSocket extends RealWS {
    constructor(address, protocols, options) {
      if (protocols === undefined) protocols = [];
      else if (!Array.isArray(protocols)) {
        if (typeof protocols === 'object' && protocols !== null) { options = protocols; protocols = []; }
        else protocols = [protocols];
      }
      const id = net.nextId;
      const target = net.mapUrl(address);
      const opts = { ...(options || {}) };
      opts.headers = { ...(opts.headers || {}), 'x-harness-conn': String(id) };
      try {
        super(target, protocols, opts);
      } catch (e) {
        net.onConstructError(address, e);
        throw e;
      }
      net.nextId++;
      net.onCreate(this, id, address, target);
    }
    emit(event, ...args) {
      net.onClientEvent(this, event, args);
      return super.emit(event, ...args);
    }
    send(data, options, cb) {
      net.onClientSend(this, data);
      return super.send(data, options, cb);
    }
    terminate() {
      net.onClientClosing(this);
      return super.terminate();
    }
    close(code, reason) {
      net.onClientClosing(this);
      return super.close(code, reason);
    }
  }
  WebSocket.WebSocket = WebSocket;
  WebSocket.WebSocketServer = WSServer;
  WebSocket.Server = WSServer;
  WebSocket.Receiver = u.wsReceiver;
  WebSocket.Sender = u.wsSender;
  return WebSocket;
}

// ---------------------------------------------------------------------------
// Fake bot. Mirrors the real bot's protocol (bot/index.js): pairing code on
// connect, `register` -> `linked` + extension code (or `register_failed`),
// `unlink_guild` / `unblock_user` -> `links_update` / `unlinked` + new code,
// application ping every 30 s (virtual) with termination of overlays that
// did not answer the previous ping. Each auto-behaviour can be switched off.
const GUILD_NAMES = { g100: 'Les Potes', g200: 'Gaming FR', g300: 'Taf' };
const USER_NAMES = { u900: 'spammeur', u901: 'relou', u1: 'alice', u2: 'bob' };
const tokenFor = (userId) => `tok-${userId}`;

class FakeBot {
  constructor(H, net) {
    this.H = H;
    this.net = net;
    this.server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    this.wss = new WSServer({ noServer: true });
    this.down = false;
    this.auto = { pairing: true, register: true, ping: true, linkOps: true };
    this.codeSeq = 0;
    this.dropSeq = 0;
    this.server.on('connection', (sock) => {
      this.net.raw.add(sock);
      sock.once('close', () => this.net.raw.delete(sock));
    });
    this.server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    this.net.botPort = this.port;
    this.url = `ws://127.0.0.1:${this.port}`;
    this.pingTimer = this.H.clock.harnessInterval(() => this._pingAll(), 30_000);
  }

  stop() {
    for (const c of this.net.conns.values()) { try { c.server && c.server.terminate(); } catch {} }
    for (const s of this.net.raw) { try { s.destroy(); } catch {} }
    try { this.server.close(); } catch {}
  }

  nextCode() { this.codeSeq++; return String(100000 + this.codeSeq); }

  _onUpgrade(req, socket, head) {
    this.net.raw.delete(socket);
    const id = Number(req.headers['x-harness-conn']) || 0;
    const conn = this.net.conns.get(id);
    const reqPath = req.url || '/';
    if (this.down || reqPath.startsWith('/__unreachable__') || !conn) {
      if (conn) {
        conn.sState = 'rejected';
        this.H.netEv(conn, 'server', 'reject', { status: 503, reason: this.down ? 'bot-down' : 'unreachable-host' });
      }
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(conn, ws, reqPath));
  }

  _onConnection(conn, ws, reqPath) {
    conn.sState = 'open';
    conn.server = ws;
    conn.path = reqPath;
    conn.isAlive = true;
    this.H.netEv(conn, 'server', 'accept', { path: reqPath });
    ws.on('message', (data) => {
      conn.c2sRecv++;
      conn.isAlive = true;
      const msg = parseFrame(data);
      this.H.netFrame(conn, 'c2s', msg);
      this._auto(conn, msg);
    });
    ws.on('close', (code) => {
      conn.sState = 'closed';
      this.H.netEv(conn, 'server', 'close', { code });
    });
    ws.on('error', (e) => this.H.netEv(conn, 'server', 'error', { message: e.message }));
    if (this.auto.pairing) this.sendTo(conn, { type: 'pairing_code', code: this.nextCode() });
  }

  latest() {
    const open = this.net.openConns();
    return open.length ? open[open.length - 1] : null;
  }

  sendTo(conn, msg) {
    conn = conn || this.latest();
    if (!conn || !conn.server || conn.server.readyState !== RealWS.OPEN) return false;
    conn.s2cSent++;
    conn.server.send(msg && msg.$raw !== undefined ? String(msg.$raw) : JSON.stringify(msg));
    return true;
  }

  close(conn, code = 1000) {
    conn = conn || this.latest();
    if (!conn || !conn.server) return false;
    if (conn.sState === 'open') conn.sState = 'closing';
    conn.server.close(code);
    return true;
  }

  terminate(conn) {
    conn = conn || this.latest();
    if (!conn || !conn.server) return false;
    if (conn.sState === 'open') conn.sState = 'closing';
    conn.server.terminate();
    return true;
  }

  links(user) {
    if (!user) return { scope: 'none', guilds: [], guildIds: [], blocked: [], blockedIds: [] };
    const blocked = user.blockedIds.map((id) => ({ id, username: USER_NAMES[id] || id }));
    if (user.scope === 'global') return { scope: 'global', guilds: [], guildIds: [], blocked, blockedIds: [...user.blockedIds] };
    const guilds = user.guildIds.filter((id) => GUILD_NAMES[id]).map((id) => ({
      id, name: GUILD_NAMES[id], icon: `https://cdn.discordapp.com/icons/${id}/icon.png`, enabled: true,
    }));
    return { scope: 'guild', guilds, guildIds: [...user.guildIds], blocked, blockedIds: [...user.blockedIds] };
  }

  // Simulates "/link <code>" typed on Discord for the given connection.
  link(conn, { userId = 'u1', username = 'alice', guildIds = ['g100'], blockedIds = [], scope = 'guild', token } = {}) {
    conn = conn || this.latest();
    conn.user = { id: userId, username, scope, guildIds: [...guildIds], blockedIds: [...blockedIds] };
    this.sendTo(conn, { type: 'linked', user: { id: userId, username }, token: token === undefined ? tokenFor(userId) : token, links: this.links(conn.user) });
    this.sendTo(conn, { type: 'pairing_code', code: this.nextCode() });
  }

  drop(fields = {}) {
    this.dropSeq++;
    const base = {
      type: 'drop',
      dropId: `d${String(this.dropSeq).padStart(4, '0')}`,
      tts: null, ttsUrl: null, effect: null,
      media: { url: `https://cdn.discordapp.com/attachments/1/${this.dropSeq}/meme.png`, kind: 'image', mime: 'image/png', name: 'meme.png', size: 123456, width: 800, height: 600 },
      rain: null, music: null,
      caption: `drop ${this.dropSeq}`,
      from: { id: 'u2', username: 'bob', avatar: 'https://cdn.discordapp.com/avatars/u2/a.png' },
      ts: this.H.clock.now,
    };
    return { ...base, ...fields };
  }

  _auto(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'register' && this.auto.register) {
      const id = msg.identity || {};
      const userId = String(id.userId || '');
      const username = String(id.username || 'unknown');
      const scope = id.scope === 'global' ? 'global' : 'guild';
      const guildIds = Array.isArray(id.guildIds) ? id.guildIds.map(String) : [];
      const blockedIds = Array.isArray(id.blockedIds) ? id.blockedIds.map(String) : [];
      if (!userId || (scope === 'guild' && guildIds.length === 0) || String(id.token || '') !== tokenFor(userId)) {
        this.sendTo(conn, { type: 'register_failed' });
        return;
      }
      conn.user = { id: userId, username, scope, guildIds, blockedIds };
      this.sendTo(conn, { type: 'linked', user: { id: userId, username }, token: tokenFor(userId), links: this.links(conn.user) });
      this.sendTo(conn, { type: 'pairing_code', code: this.nextCode() });
      if (this.onRegistered) this.onRegistered(conn);
      return;
    }
    if (!this.auto.linkOps || !conn.user) return;
    if (msg.type === 'unlink_guild') {
      const gid = String(msg.guildId || '');
      if (!gid || conn.user.scope !== 'guild') return;
      conn.user.guildIds = conn.user.guildIds.filter((g) => g !== gid);
      if (conn.user.guildIds.length === 0) {
        conn.user = null;
        this.sendTo(conn, { type: 'unlinked', reason: 'no_guilds_left' });
        this.sendTo(conn, { type: 'pairing_code', code: this.nextCode() });
      } else {
        this.sendTo(conn, { type: 'links_update', links: this.links(conn.user) });
      }
      return;
    }
    if (msg.type === 'unblock_user') {
      const uid = String(msg.userId || '');
      if (!uid) return;
      conn.user.blockedIds = conn.user.blockedIds.filter((b) => b !== uid);
      this.sendTo(conn, { type: 'links_update', links: this.links(conn.user) });
    }
  }

  _pingAll() {
    if (!this.auto.ping) return;
    for (const c of this.net.conns.values()) {
      if (c.sState !== 'open') continue;
      if (c.isAlive === false) { this.terminate(c); continue; }
      c.isAlive = false;
      this.sendTo(c, { type: 'ping' });
    }
  }
}

module.exports = { Net, createWsModule, FakeBot, tokenFor, parseFrame, RealWS };
