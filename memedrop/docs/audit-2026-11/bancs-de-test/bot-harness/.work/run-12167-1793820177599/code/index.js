// index.js — MemeDrop bot
require('dotenv').config();

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

const PORT = Number(process.env.PORT || process.env.WS_PORT || 8765);
const MAX_TTS_CHARS = 200;

// ── TTS servi par le bot ─────────────────────────────────────────────────────
// La synthèse vocale du renderer Electron (speechSynthesis) est muette sur la
// plupart des PC : Chromium n'embarque aucune voix. Le bot expose donc
// GET /tts?text=... qui relaie le MP3 généré par Google Translate TTS ;
// l'overlay le joue dans un simple élément <audio>.
//
// L'endpoint est public : on limite le débit par IP (sinon n'importe qui peut
// s'en servir comme relais TTS gratuit) et on garde un petit cache mémoire.
// Les requêtes identiques simultanées partagent un seul appel Google, lancé
// dès la livraison du drop (préchauffage) : un /dropall lu par 6 overlays ne
// génère qu'une seule requête Google.
const TTS_RATE_WINDOW_MS = 60_000;
const TTS_RATE_MAX       = 30;
const TTS_CACHE_MAX      = 50;
// Plafond d'appels Google par minute, toutes IP confondues : changer d'IP
// est facile, et c'est le quota du bot (partagé par tous) qui est en jeu.
const TTS_UPSTREAM_MAX   = 120;
const ttsHits  = new Map();   // ip -> { count, since }
const ttsCache = new Map();   // `${lang}|${text}` -> Buffer (ordre = LRU)
const ttsInflight = new Map();   // `${lang}|${text}` -> Promise<Buffer> (appel Google en cours)
let ttsUpstream = { count: 0, since: 0 };   // fenêtre fixe du plafond global

function ttsRateLimited(ip) {
  const now = Date.now();
  const e = ttsHits.get(ip);
  if (!e || now - e.since > TTS_RATE_WINDOW_MS) {
    ttsHits.set(ip, { count: 1, since: now });
    return false;
  }
  e.count++;
  return e.count > TTS_RATE_MAX;
}

setInterval(() => {
  const cutoff = Date.now() - TTS_RATE_WINDOW_MS;
  for (const [ip, e] of ttsHits) if (e.since < cutoff) ttsHits.delete(ip);
  // Même balayage pour les échecs de /link expirés (voir linkLocked)
  const linkCutoff = Date.now() - LINK_FAIL_WINDOW_MS;
  for (const [uid, f] of linkFails) if (f.since < linkCutoff) linkFails.delete(uid);
}, 5 * 60_000).unref();

function ttsUpstreamBusy() {
  const now = Date.now();
  if (now - ttsUpstream.since > TTS_RATE_WINDOW_MS) ttsUpstream = { count: 0, since: now };
  return ++ttsUpstream.count > TTS_UPSTREAM_MAX;
}

// Coupe à `max` unités UTF-16 sans laisser un demi-emoji (paire de
// substitution) : encodeURIComponent lève une exception dessus.
function clip(text, max) {
  const s = String(text).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

// Texte effectivement lu. Même normalisation pour /tts et pour le
// préchauffage des drops, sinon les deux ne tombent pas sur la même clé.
function normTtsText(raw) {
  return clip(String(raw || '').trim(), MAX_TTS_CHARS);
}

// IP du client pour la limite par IP. Le premier élément de X-Forwarded-For
// est choisi par le client : sur Fly on lit Fly-Client-IP (posé par le proxy,
// mais forgeable hors de Fly), ailleurs le dernier saut, ajouté par le proxy.
function clientIp(req) {
  const fly = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : null;
  if (fly) return String(fly).trim();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return xff || req.socket.remoteAddress || '';
}

// Clé de limite : une IPv6 compte par /64 (un client en détient en général
// un /64 entier) ; une IPv4 mappée (::ffff:a.b.c.d) redevient une IPv4.
function ipKey(ip) {
  ip = String(ip).toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

// Audio d'un texte : cache LRU, sinon un seul appel Google par clé à la fois
// (les requêtes simultanées le partagent). Erreur `busy` si le plafond global
// est atteint.
function getTtsAudio(lang, text) {
  const key = `${lang}|${text}`;
  const cached = ttsCache.get(key);
  if (cached) {
    ttsCache.delete(key);
    ttsCache.set(key, cached);
    return Promise.resolve(cached);
  }
  if (ttsInflight.has(key)) return ttsInflight.get(key);
  if (ttsUpstreamBusy()) return Promise.reject(Object.assign(new Error('tts busy'), { busy: true }));
  const p = (async () => {
    const g = await fetch(
      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${lang}&q=${encodeURIComponent(text)}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        // Sans délai, un Google bloqué faisait attendre l'<audio> jusqu'à 5 min
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!g.ok) throw new Error(`upstream ${g.status}`);
    const buf = Buffer.from(await g.arrayBuffer());
    ttsCache.set(key, buf);
    if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    return buf;
  })().finally(() => ttsInflight.delete(key));
  ttsInflight.set(key, p);
  return p;
}

function sendTtsAudio(res, buf) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buf);
}

async function handleTts(req, u, res) {
  const text = normTtsText(u.searchParams.get('text'));
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing text');
    return;
  }
  const rawLang = u.searchParams.get('lang') || '';
  const lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(rawLang) ? rawLang : 'fr';
  const cacheKey = `${lang}|${text}`;
  // Déjà en cache ou déjà demandé à Google : ne coûte rien, pas de limite.
  if (!ttsCache.has(cacheKey) && !ttsInflight.has(cacheKey) && ttsRateLimited(ipKey(clientIp(req)))) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('too many requests');
    return;
  }
  try {
    sendTtsAudio(res, await getTtsAudio(lang, text));
  } catch (e) {
    if (e.busy) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('tts busy');
      return;
    }
    console.error('[tts] failed:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('tts failed');
  }
}

const httpServer = http.createServer((req, res) => {
  let u;
  // Le parseur HTTP de Node accepte des cibles que new URL() refuse
  // (`GET //[`) : l'exception non rattrapée arrêtait le bot.
  try { u = new URL(req.url, 'http://localhost'); } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (u.pathname === '/health' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MemeDrop bot online');
    return;
  }
  if (u.pathname === '/tts' && req.method === 'GET') {
    handleTts(req, u, res).catch((e) => console.error('[tts] handler failed:', e.message));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Les overlays n'envoient que de petits messages JSON : on refuse tout ce qui
// dépasse 64 Ko (par défaut `ws` accepte jusqu'à 100 Mo par message).
const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

// ─────────────────────────────────────────────────────────────────────────────
// Linkage model
//
// pendingOverlays : code (string)      -> ws
// userLinks       : discordUserId      -> { sockets: Set<ws>, scope: 'global' | 'guild',
//                                           guildIds: Set<string>, blockedUsers: Set<string> }
//
// `scope: 'global'` is the legacy mode (pre-v7). One link = reachable from
// anywhere. Set when an overlay /link was done before this version.
//
// `scope: 'guild'` is the new mode: the user is reachable only from servers
// whose ID is in `guildIds`. Each /link adds the current server to the set.
//
// Plusieurs appareils d'un même compte (PC + téléphone) partagent son lien :
// chacun a sa socket dans `sockets` et reçoit les drops. Le lien vivant reste
// la source de vérité : un appareil qui se ré-enregistre le rejoint tel quel
// (on ne fusionne jamais les listes qu'il rejoue, peut-être périmées) et le
// lien ne disparaît qu'avec son dernier appareil.
//
// wsMeta is a back-pointer used during disconnect cleanup.
// ─────────────────────────────────────────────────────────────────────────────
const pendingOverlays = new Map();
const userLinks       = new Map();
const wsMeta          = new WeakMap();

// ─────────────────────────────────────────────────────────────────────────────
// Favoris & groupes cibles — persistés sur disque (voir store.js) car ils
// n'ont aucune copie côté overlay, contrairement aux liens.
//
// favorites : discordUserId -> [{ name, url, mime, kind, size, caption, savedAt }]
// groups    : discordUserId -> { groupName: [discordUserId, ...] }
// ─────────────────────────────────────────────────────────────────────────────
const persisted = store.load();
const favorites = new Map(Object.entries(persisted.favorites).map(([k, v]) => [k, v]));
const groups    = new Map(Object.entries(persisted.groups).map(([k, v]) => [k, new Map(Object.entries(v))]));
// stats : discordUserId -> { sent, received } — compteurs pour /stats
const stats     = persisted.stats || {};

const MAX_FAVORITES     = 10;
const MAX_GROUPS        = 10;
const MAX_GROUP_MEMBERS = 5;

function persistStore() {
  // Construit au moment de l'écriture, pas à chaque appel
  store.save(() => ({
    favorites: Object.fromEntries(favorites),
    groups: Object.fromEntries([...groups].map(([k, v]) => [k, Object.fromEntries(v)])),
    stats,
  }));
}

// Ne sauvegarde pas : deliverDrop le fait une fois pour tous les destinataires.
function bumpStats(fromId, toId) {
  const f = stats[fromId] || (stats[fromId] = { sent: 0, received: 0 });
  const t = stats[toId]   || (stats[toId]   = { sent: 0, received: 0 });
  f.sent++;
  t.received++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Réactions aux drops
//
// Chaque drop délivré est mémorisé (dropId -> expéditeur + canal d'origine
// + destinataires) pendant 15 min. Le receveur peut cliquer un emoji sur le
// drop dans son overlay ; l'overlay renvoie { type:'react', dropId, emoji } et
// le bot poste la réaction dans le canal d'où venait le /drop. Une réaction
// max par personne et par drop, et seulement de la part de ses destinataires.
// ─────────────────────────────────────────────────────────────────────────────
const recentDrops     = new Map();
const REACTION_EMOJIS = new Set(['😂', '💀', '🔥', '😭', '🖕']);

function registerDropForReactions(payload, senderId, channelId, recipients) {
  if (!payload.dropId || !channelId) return;
  recentDrops.set(payload.dropId, { senderId, channelId, recipients, reacted: new Set(), ts: Date.now() });
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, entry] of recentDrops) {
    if (entry.ts < cutoff) recentDrops.delete(id);
  }
}, 5 * 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Re-link tokens
//
// `register` lets an overlay reconnect without /link by replaying its stored
// identity. Without a secret, that identity is just a Discord user ID — public
// information — so anyone could impersonate any user. To prevent that, every
// successful /link issues a token = HMAC(LINK_SECRET, userId). The overlay
// stores it and must present it on every future `register`. The bot verifies
// it by recomputing the HMAC — no server-side storage needed, so it survives
// redeploys as long as LINK_SECRET stays the same.
//
// If LINK_SECRET isn't set, we generate an ephemeral one at boot. Re-links
// then only survive until the next restart (same as before this change), but
// at least within a single run, identities can't be forged.
// ─────────────────────────────────────────────────────────────────────────────
const LINK_SECRET = process.env.LINK_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.LINK_SECRET && process.env.FLY_APP_NAME) {
  // En production, chaque redéploiement invaliderait tous les liens : chaque
  // ami devrait refaire /link sur chacun de ses appareils.
  console.error('[security] LINK_SECRET is NOT set on Fly — using an ephemeral secret: EVERY link ' +
    'will be invalidated at the next restart or deploy, and every overlay will have to run /link again. ' +
    'Set it once and for all: fly secrets set LINK_SECRET=<long random string>');
} else if (!process.env.LINK_SECRET) {
  console.warn('[security] LINK_SECRET not set — using an ephemeral secret. ' +
    'Zero-touch re-link will require a fresh /link after every restart. ' +
    'Set LINK_SECRET to a long random string in your environment to persist links across redeploys.');
}
function tokenFor(userId) {
  return crypto.createHmac('sha256', LINK_SECRET).update(String(userId)).digest('hex');
}

// Vérifie un token de register en temps constant (timingSafeEqual exige deux
// tampons de même taille, d'où la comparaison des longueurs avant).
function tokenMatches(token, userId) {
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(tokenFor(userId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// While an overlay is linked, the bot keeps issuing single-use "extension"
// codes so the user can /link on additional servers without restarting the
// app. extensionCodes maps code (string) -> userId.
const extensionCodes  = new Map();

// Les codes n'ont que 6 chiffres : après 5 /link ratés en 10 min, /link est
// refusé jusqu'à la fin de la fenêtre (sinon on peut les essayer en boucle).
const LINK_FAIL_WINDOW_MS = 10 * 60_000;
const LINK_FAIL_MAX       = 5;
const linkFails = new Map();   // userId -> { count, since }

function linkLocked(userId) {
  const f = linkFails.get(userId);
  return !!f && Date.now() - f.since < LINK_FAIL_WINDOW_MS && f.count >= LINK_FAIL_MAX;
}

function noteLinkFail(userId) {
  const f = linkFails.get(userId);
  if (!f || Date.now() - f.since >= LINK_FAIL_WINDOW_MS) linkFails.set(userId, { count: 1, since: Date.now() });
  else f.count++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-touch re-link
//
// The link state (which Discord user + which servers) is stored CLIENT-SIDE in
// the overlay. On every connect the overlay replays its identity via a
// `register` message and the bot rebuilds the live link from it. Because the
// source of truth lives on the user's PC (not in the bot's memory), the link
// survives bot redeploys, reconnections and reboots — the user runs /link only
// once ever, just to capture their identity the first time.
// ─────────────────────────────────────────────────────────────────────────────

function generatePairingCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  } while (pendingOverlays.has(code) || extensionCodes.has(code));
  return code;
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function reissuePairingCode(ws) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const code = generatePairingCode();
  pendingOverlays.set(code, ws);
  wsMeta.set(ws, { code, userId: null });
  sendJson(ws, { type: 'pairing_code', code });
  console.log(`[ws] reissued pairing code = ${code}`);
}

// Sockets encore ouvertes d'un lien (une socket fermée y reste jusqu'à son
// événement 'close').
function openSockets(link) {
  return link ? [...link.sockets].filter(s => s.readyState === s.OPEN) : [];
}

function hasOpen(link) {
  if (link) for (const s of link.sockets) if (s.readyState === s.OPEN) return true;
  return false;
}

// Envoie un message à tous les appareils ouverts d'un utilisateur, sérialisé
// une seule fois (`payload` peut déjà être une chaîne JSON).
function sendToUser(userId, payload) {
  const socks = openSockets(userLinks.get(userId));
  if (!socks.length) return;
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const s of socks) s.send(raw);
}

function clearExtensionCodes(userId) {
  for (const [c, uid] of extensionCodes) {
    if (uid === userId) extensionCodes.delete(c);
  }
}

// Retire une socket du lien de son utilisateur (fermeture, ou socket qui
// passe à un autre compte). Le lien et ses codes d'extension ne disparaissent
// qu'avec le dernier appareil.
function detachSocket(ws) {
  const userId = wsMeta.get(ws)?.userId;
  const link = userId ? userLinks.get(userId) : null;
  if (link && link.sockets.delete(ws) && link.sockets.size === 0) {
    userLinks.delete(userId);
    clearExtensionCodes(userId);
  }
}

// Délie l'utilisateur sur tous ses appareils : chacun repasse en appairage.
function unlinkUser(userId, reason) {
  const link = userLinks.get(userId);
  if (!link) return;
  for (const s of link.sockets) {
    sendJson(s, { type: 'unlinked', reason });
    reissuePairingCode(s);
  }
  userLinks.delete(userId);
  clearExtensionCodes(userId);
}

// Issue a single-use code that, when used in a Discord /link command, adds the
// current guild to the already-linked user's allowed sources. Un seul code
// valide par utilisateur, affiché par tous ses appareils.
function issueExtensionCode(userId) {
  if (!hasOpen(userLinks.get(userId))) return;
  clearExtensionCodes(userId);
  const code = generatePairingCode();
  extensionCodes.set(code, userId);
  // Reuse the pairing_code message type so the overlay UI shows it naturally
  sendToUser(userId, { type: 'pairing_code', code });
  console.log(`[ws] extension code ${code} for user ${userId}`);
}

// Can a user, viewed from a given guild, be targeted by /drop here?
function isReachable(userId, fromGuildId) {
  const link = userLinks.get(userId);
  if (!hasOpen(link)) return false;
  if (link.scope === 'global') return true;
  return link.guildIds.has(fromGuildId);
}

// Same as isReachable, but also respects the target's per-sender blocklist.
function canDrop(fromUserId, targetUserId, fromGuildId) {
  const link = userLinks.get(targetUserId);
  if (link?.blockedUsers?.has(fromUserId)) return false;
  return isReachable(targetUserId, fromGuildId);
}

// Resolve the usernames of users this person has blocked, for display in the
// overlay's "blocked senders" panel. `blockedIds` stays the authoritative,
// persisted list; `blocked` (with usernames) is display-only.
// Les ID viennent du client et chaque fetch passe par la file REST /users/:id :
// cache discord.js d'abord, au plus 10 appels par snapshot, et les ID
// inconnus de Discord (404) ne sont plus redemandés. Sinon : l'ID brut.
const MAX_SNAPSHOT_FETCHES = 10;
const MAX_UNKNOWN_USERS    = 1000;
const unknownUsers = new Set();   // ID en 404, bornés (le plus ancien sort)

async function buildBlockedSnapshot(userId) {
  const link = userLinks.get(userId);
  if (!link || !link.blockedUsers || link.blockedUsers.size === 0) return [];
  const out = [];
  let fetches = 0;
  for (const id of link.blockedUsers) {
    let username = client.users.cache.get(id)?.username;
    if (!username && !unknownUsers.has(id) && fetches < MAX_SNAPSHOT_FETCHES) {
      fetches++;
      try {
        username = (await client.users.fetch(id)).username;
      } catch (e) {
        if (e.status === 404) {
          unknownUsers.add(id);
          if (unknownUsers.size > MAX_UNKNOWN_USERS) unknownUsers.delete(unknownUsers.values().next().value);
        }
      }
    }
    out.push({ id, username: username || id });
  }
  return out;
}

// Build the guild-list payload sent to overlays — they use it to render the
// "Linked servers" and "blocked senders" toggle panels.
async function buildLinksSnapshot(userId) {
  const link = userLinks.get(userId);
  const blocked = await buildBlockedSnapshot(userId);
  const blockedIds = link ? [...(link.blockedUsers || [])] : [];
  if (!link) return { scope: 'none', guilds: [], guildIds: [], blocked, blockedIds };
  if (link.scope === 'global') return { scope: 'global', guilds: [], guildIds: [], blocked, blockedIds };
  const guilds = [];
  for (const gid of link.guildIds) {
    const g = client.guilds.cache.get(gid);
    if (g) {
      guilds.push({
        id: g.id,
        name: g.name,
        icon: g.iconURL({ extension: 'png', size: 64 }) || null,
        enabled: true,
      });
    }
  }
  // `guildIds` is the authoritative, complete list of IDs (some may not be in
  // the cache yet right after boot, so `guilds` can be a subset). The overlay
  // persists from `guildIds` and only displays from `guilds`.
  return { scope: 'guild', guilds, guildIds: [...link.guildIds], blocked, blockedIds };
}

async function pushLinksUpdate(userId) {
  if (!userLinks.has(userId)) return;
  const links = await buildLinksSnapshot(userId);
  // Aux appareils liés au moment de l'envoi, pas à ceux d'avant l'await
  sendToUser(userId, { type: 'links_update', links });
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages des overlays
//
// Tout ce qui arrive ici vient d'un client non fiable : jamais de String()
// sur ses valeurs (un objet comme {"toString":1} lève une exception) et les
// ID Discord sont validés et bornés (ils finissent dans des URL REST
// /users/:id et dans des boucles d'appels).
// ─────────────────────────────────────────────────────────────────────────────
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const SNOWFLAKE = /^\d{17,20}$/;
const sid = (v) => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : null);
const ids = (a, max) => (Array.isArray(a) ? a : []).map(sid).filter(Boolean).slice(0, max);
const MAX_LINK_GUILDS = 200;   // nombre max de serveurs d'un compte (Nitro)
const MAX_BLOCKED     = 100;
// Un overlay normal envoie un pong par ping et quelques clics : au-delà de
// ce budget par socket, les messages sont ignorés (certains coûtent du REST).
const WS_MSG_WINDOW_MS = 10_000;
const WS_MSG_MAX       = 30;

async function onWsMessage(ws, raw) {
  ws.isAlive = true;
  const now = Date.now();
  if (now - (ws.rlSince || 0) > WS_MSG_WINDOW_MS) { ws.rlSince = now; ws.rlCount = 0; }
  if (++ws.rlCount > WS_MSG_MAX) return;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pong') return;

  // Zero-touch re-link: the overlay replays its stored identity so the bot
  // rebuilds the live link with no /link needed. Survives bot redeploys
  // because the identity lives on the user's PC, not in bot memory.
  if (msg.type === 'register') {
    const id       = msg.identity || {};
    const userId   = sid(id.userId);
    const username = str(id.username) || 'unknown';
    const scope    = id.scope === 'global' ? 'global' : 'guild';
    const guildIds = new Set(ids(id.guildIds, MAX_LINK_GUILDS));
    const blockedUsers = new Set(ids(id.blockedIds, MAX_BLOCKED));
    // Need a usable identity with at least one reachable source
    if (!userId || (scope === 'guild' && guildIds.size === 0)) {
      sendJson(ws, { type: 'register_failed' });
      return;
    }
    // Verify the re-link token. Without a valid token (e.g. an overlay
    // linked before this check existed, or a forged identity), force a
    // fresh /link instead of trusting the claimed userId.
    if (!tokenMatches(id.token, userId)) {
      sendJson(ws, { type: 'register_failed' });
      return;
    }
    // Drop the pending pairing code this ws was handed on connect
    const meta = wsMeta.get(ws);
    if (meta?.code) pendingOverlays.delete(meta.code);
    // Socket déjà liée à un AUTRE compte : elle quitte d'abord ce lien (sinon
    // elle recevait les drops des deux identités).
    if (meta?.userId && meta.userId !== userId) detachSocket(ws);
    // Un autre appareil de l'utilisateur est connecté (PC + téléphone) : on
    // rejoint son lien tel quel, sans 'unlinked' pour personne (les clients
    // effacent leur identité dessus). Les listes rejouées ici sont ignorées.
    const existing = userLinks.get(userId);
    if (hasOpen(existing)) existing.sockets.add(ws);
    else userLinks.set(userId, { sockets: new Set([ws]), scope, guildIds, blockedUsers });
    wsMeta.set(ws, { code: null, userId });
    const links = await buildLinksSnapshot(userId);
    // L'état a pu changer pendant l'await (/unlink, fermeture, autre
    // register) : on vérifie le lien courant, pas celui d'avant.
    const cur = userLinks.get(userId);
    if (!cur || !cur.sockets.has(ws) || wsMeta.get(ws)?.userId !== userId) return;
    sendJson(ws, {
      type: 'linked',
      user: { id: userId, username },
      token: tokenFor(userId),
      links,
    });
    issueExtensionCode(userId);
    console.log(`[ws] auto-registered user ${userId} (${cur.scope}, ${cur.guildIds.size} guild(s), ${cur.sockets.size} device(s))`);
    return;
  }

  // The overlay can ask the bot to revoke a specific guild link
  if (msg.type === 'unlink_guild') {
    const meta = wsMeta.get(ws);
    if (!meta?.userId) return;
    const link = userLinks.get(meta.userId);
    if (!link || link.scope !== 'guild') return;
    const guildId = str(msg.guildId);
    if (!guildId) return;
    link.guildIds.delete(guildId);
    // If no guilds remain, drop the user fully (they'll need to /link again)
    if (link.guildIds.size === 0) {
      unlinkUser(meta.userId, 'no_guilds_left');
    } else {
      await pushLinksUpdate(meta.userId);
    }
    return;
  }

  // The overlay can ask the bot to unblock a sender it previously blocked
  if (msg.type === 'unblock_user') {
    const meta = wsMeta.get(ws);
    if (!meta?.userId) return;
    const link = userLinks.get(meta.userId);
    if (!link) return;
    const targetId = str(msg.userId);
    if (!targetId || !link.blockedUsers) return;
    link.blockedUsers.delete(targetId);
    await pushLinksUpdate(meta.userId);
    return;
  }

  // Le receveur a cliqué un emoji sur un drop → on poste la réaction dans
  // le canal Discord d'où venait le /drop.
  if (msg.type === 'react') {
    const meta = wsMeta.get(ws);
    if (!meta?.userId) return;
    const entry = recentDrops.get(str(msg.dropId));
    if (!entry) return;
    if (!entry.recipients.has(meta.userId)) return;   // seuls ses destinataires
    const emoji = str(msg.emoji);
    if (!REACTION_EMOJIS.has(emoji)) return;
    if (entry.reacted.has(meta.userId)) return;   // une réaction max par drop
    entry.reacted.add(meta.userId);
    if (meta.userId === entry.senderId) return;    // pas de réaction à soi-même
    let reactorName = meta.userId;
    try { reactorName = (await client.users.fetch(meta.userId)).username; } catch {}
    try {
      const ch = await client.channels.fetch(entry.channelId);
      if (ch?.isTextBased()) {
        await ch.send(`${emoji} **${reactorName}** a réagi au drop de <@${entry.senderId}> !`);
      }
    } catch (e) {
      console.error('[react] failed to post reaction:', e.message);
    }
  }
}

wss.on('connection', (ws) => {
  const code = generatePairingCode();
  pendingOverlays.set(code, ws);
  wsMeta.set(ws, { code, userId: null });

  sendJson(ws, { type: 'pairing_code', code });
  console.log(`[ws] overlay connected, pairing code = ${code}`);

  // Heartbeat : voir l'intervalle plus bas. Tout message reçu prouve que
  // l'overlay est vivant.
  ws.isAlive = true;

  // `ws` ignore la promesse du handler : un rejet (message malformé, bug)
  // devenait un rejet non géré qui arrêtait le process.
  ws.on('message', (raw) => {
    onWsMessage(ws, raw).catch((e) => console.error('[ws] message handler failed:', e.message));
  });

  ws.on('close', () => {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    if (meta.code) pendingOverlays.delete(meta.code);
    // Le lien et ses codes d'extension survivent tant qu'un autre appareil
    // de l'utilisateur reste connecté.
    detachSocket(ws);
    console.log(`[ws] overlay disconnected (user=${meta.userId || 'unlinked'})`);
  });

  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

// Heartbeat applicatif : un overlay qui n'a rien renvoyé (pas même un pong)
// depuis le dernier ping est considéré mort (PC en veille, Wi-Fi coupé…).
// Sans ça, la connexion TCP à moitié ouverte restait "OPEN" pendant des
// minutes : /who l'affichait et les drops partaient dans le vide.
// Toutes les 45 s (chaque ping réveille la radio des téléphones) :
// < 75 s : délai codé en dur dans les overlays/APK installés.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[ws] terminating unresponsive overlay');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    sendJson(ws, { type: 'ping' });
  });
}, 45_000);

httpServer.listen(PORT, () => {
  console.log(`[http+ws] listening on port ${PORT}`);
});

// Guilds suffit : aucun événement de message n'est lu, et GuildMessages
// faisait recevoir et mettre en cache tous les messages de tous les serveurs.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  // Les overlays revenus avant READY ont reçu une liste de serveurs vide
  // (cache des serveurs pas encore rempli) : on la leur renvoie.
  for (const userId of userLinks.keys()) {
    pushLinksUpdate(userId).catch((e) => console.error('[ws] links_update failed:', e.message));
  }
});

// Sans écouteur, un événement 'error' du client arrêtait le process
client.on(Events.Error, (e) => console.error('[bot] client error:', e.message));
client.on(Events.ShardError, (e) => console.error('[bot] shard error:', e.message));

// Re-emit links snapshot when guild data changes, so overlays show fresh names/icons
client.on(Events.GuildUpdate, (oldG, newG) => {
  // Seuls le nom et l'icône sont affichés : un boost ou un réglage ne doit
  // pas faire ré-enregistrer leur identité à tous les overlays du serveur.
  if (oldG.name === newG.name && oldG.icon === newG.icon) return;
  for (const [userId, link] of userLinks) {
    if (link.scope === 'guild' && link.guildIds.has(newG.id)) {
      pushLinksUpdate(userId).catch((e) => console.error('[ws] links_update failed:', e.message));
    }
  }
});

const ACCEPTED_MIME =
  /^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp3))$/i;
const MAX_BYTES = 25 * 1024 * 1024;

const DROP_COOLDOWN_MS    = 2_000;
const DROPALL_COOLDOWN_MS = 15_000;

const lastDropAt    = new Map();
const lastDropAllAt = new Map();

// Le cooldown ne joue qu'à la programmation d'un drop différé : sans plafond,
// des dizaines de drops pouvaient être réglés pour tomber la même minute.
const MAX_PENDING_DELAYED = 3;
const pendingDelayed = new Map();   // senderId -> drops différés en attente

// Retourne le temps restant (ms) avant que `userId` puisse réutiliser `map`,
// ou 0 si c'est bon. N'enregistre rien — voir `markCooldown`.
function cooldownRemaining(map, userId, cooldownMs) {
  const now = Date.now();
  const prev = map.get(userId) || 0;
  const remaining = cooldownMs - (now - prev);
  return remaining > 0 ? remaining : 0;
}

function markCooldown(map, userId) {
  map.set(userId, Date.now());
}

// Marque le cooldown avant des await (deux commandes lancées au même instant
// passaient sinon toutes les deux le contrôle) ; renvoie de quoi l'annuler si
// finalement rien n'est envoyé.
function reserveCooldown(map, userId) {
  const prev = map.get(userId);
  markCooldown(map, userId);
  return () => {
    if (prev === undefined) map.delete(userId);
    else map.set(userId, prev);
  };
}

function formatCooldown(ms) {
  // Au dixième supérieur : il restait 1 à 49 ms, le message disait « 0s »
  return (Math.ceil(ms / 100) / 10).toFixed(1).replace(/\.0$/, '');
}

function validateAttachment(att) {
  if (att.size > MAX_BYTES) {
    return `File too large (${(att.size / 1024 / 1024).toFixed(1)} MB). Limit is 25 MB.`;
  }
  if (!att.contentType || !ACCEPTED_MIME.test(att.contentType)) {
    return `Unsupported type: \`${att.contentType || 'unknown'}\`. Use PNG / JPG / GIF / WEBP / MP4 / WEBM / MP3.`;
  }
  return null;
}

function classifyMedia(mime) {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'image/gif')      return 'gif';
  return 'image';
}

// Extrait jusqu'à 5 emojis visuels distincts d'une chaîne (option "pluie") —
// permet de faire pleuvoir une combinaison d'emojis plutôt qu'un seul.
const MAX_RAIN_EMOJIS = 5;
function extractEmojis(str) {
  if (!str) return null;
  const matches = String(str).match(/\p{Extended_Pictographic}/gu);
  if (!matches) return null;
  const unique = [...new Set(matches)].slice(0, MAX_RAIN_EMOJIS);
  return unique.length ? unique : null;
}

// Effets d'apparition autorisés (validés aussi par les `choices` Discord,
// mais on re-filtre côté serveur au cas où).
const EFFECTS = new Set(['zoom', 'tornade', 'glitch', 'shake']);

// Base publique du bot, utilisée pour construire les URL /tts envoyées aux
// overlays. Fly.io fournit FLY_APP_NAME et Railway RAILWAY_PUBLIC_DOMAIN ;
// sinon on retombe sur le domaine prod connu (même serveur que le
// DEFAULT_SERVER de l'overlay).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
  (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '') ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
  'https://memedrop-bot.fly.dev'
).replace(/\/+$/, '');

function ttsUrlFor(text) {
  if (!text) return null;
  return `${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}`;
}

function buildDropPayload(att, caption, fromUser, musicAtt = null, rain = null, extra = {}) {
  const ttsText = extra.tts ? clip(extra.tts, MAX_TTS_CHARS) : null;
  return {
    type: 'drop',
    // Identifiant du drop — permet au receveur de réagir depuis l'overlay
    dropId: crypto.randomBytes(8).toString('hex'),
    // Texte lu à voix haute chez le receveur (optionnel) + URL de l'audio
    // généré côté serveur (voir handleTts) que l'overlay joue directement
    tts: ttsText,
    ttsUrl: ttsUrlFor(ttsText),
    // Effet d'apparition spécial (zoom / tornade / glitch / shake)
    effect: EFFECTS.has(extra.effect) ? extra.effect : null,
    media: att ? {
      url: att.url,
      kind: classifyMedia(att.contentType),
      mime: att.contentType,
      name: att.name,
      size: att.size,
      width: att.width || null,
      height: att.height || null,
    } : null,
    // Emoji en pluie sur l'écran (optionnel, envoyé par le bot)
    rain,
    // Musique optionnelle jouée en même temps qu'une photo/GIF
    music: musicAtt ? {
      url:  musicAtt.url,
      mime: musicAtt.contentType,
      name: musicAtt.name,
      size: musicAtt.size,
    } : null,
    caption: caption ? clip(caption, 80) : null,
    from: {
      id: fromUser.id,
      username: fromUser.username,
      avatar: fromUser.displayAvatarURL({ size: 128, extension: 'png' }),
    },
    ts: Date.now(),
  };
}

// Récupère jusqu'à 5 utilisateurs depuis les options target/target2..target5,
// filtre les bots et les doublons. Réutilisé par /drop, /dropfav, /dropgroup.
function resolveTargets(interaction, { required = true } = {}) {
  const targets = [];
  const seen = new Set();
  for (const optName of ['target', 'target2', 'target3', 'target4', 'target5']) {
    const u = interaction.options.getUser(optName, required && optName === 'target');
    if (!u || u.bot || seen.has(u.id)) continue;
    seen.add(u.id);
    targets.push(u);
  }
  return targets;
}

// Livre `payload` aux cibles atteignables (sur tous leurs appareils) ; seul
// chemin de livraison, pour /drop, /dropfav, /dropgroup, /dropall et les
// drops différés. Renvoie les noms livrés / non atteignables.
function deliverDrop(senderId, guildId, channelId, targets, payload) {
  const delivered = [];
  const notReachable = [];
  const recipients = new Set();
  let raw = null;
  for (const t of targets) {
    if (!canDrop(senderId, t.id, guildId)) {
      notReachable.push(t.username);
      continue;
    }
    raw ??= JSON.stringify(payload);
    sendToUser(t.id, raw);
    delivered.push(t.username);
    recipients.add(t.id);
    bumpStats(senderId, t.id);
  }
  if (delivered.length) {
    persistStore();
    registerDropForReactions(payload, senderId, channelId, recipients);
    // Préchauffage : la synthèse part dès maintenant (même clé que /tts), les
    // overlays qui demandent ttsUrl la trouvent prête ou en cours.
    const text = payload.tts ? normTtsText(payload.tts) : '';
    if (text) getTtsAudio('fr', text).catch(() => {});
  }
  return { delivered, notReachable };
}

// Envoie `payload` aux cibles atteignables et renvoie un message récapitulatif.
function dispatchToTargets(interaction, targets, payload, musicAtt) {
  const { delivered, notReachable } =
    deliverDrop(interaction.user.id, interaction.guildId, interaction.channelId, targets, payload);
  if (delivered.length && notReachable.length) {
    return `✅ Drop envoyé sur **${delivered.join('**, **')}**.\n⚠️ Pas atteignables depuis ce serveur : ${notReachable.map(o => `**${o}**`).join(', ')}`;
  } else if (delivered.length) {
    return `✅ Drop envoyé sur **${delivered.join('**, **')}** !${musicAtt ? ' 🎵' : ''}`;
  }
  return `❌ Personne n'est atteignable depuis ce serveur. Ils doivent faire \`/link\` ici aussi.`;
}

// Valide une pièce jointe pour l'option "musique". Les vidéos (MP4/WEBM/MOV)
// sont acceptées : l'overlay les joue dans un élément <audio>, qui ne décode
// que la piste son — la vidéo n'est jamais affichée.
const MUSIC_MIME = /^(audio\/|video\/(mp4|webm|quicktime))/i;
function validateMusic(att) {
  if (!att) return null;
  if (att.size > MAX_BYTES) {
    return `Fichier audio trop lourd (${(att.size / 1024 / 1024).toFixed(1)} MB). Limite : 25 MB.`;
  }
  if (!att.contentType || !MUSIC_MIME.test(att.contentType)) {
    return `Le fichier \`musique\` doit être un audio (MP3) ou une vidéo (MP4/WEBM — seul le son est joué). Type reçu : \`${att.contentType || 'inconnu'}\`.`;
  }
  return null;
}

// Lit et valide les options communes à /drop, /dropall et /dropgroup.
// Renvoie { error } ou { att, caption, musicAtt, rain, tts, effect }.
function readDropOptions(interaction) {
  const att      = interaction.options.getAttachment('media', false);
  const caption  = interaction.options.getString('caption', false);
  const musicAtt = interaction.options.getAttachment('musique', false);
  const rain     = extractEmojis(interaction.options.getString('pluie', false));
  const tts      = (interaction.options.getString('tts', false) || '').trim() || null;
  const effect   = interaction.options.getString('effet', false);

  // Il faut au moins un média, une pluie ou un texte à lire
  if (!att && !rain && !tts) {
    return { error: '❌ Mets au moins un média (`media`), un emoji (`pluie`) ou un texte (`tts`).' };
  }
  if (att) {
    const err = validateAttachment(att);
    if (err) return { error: `❌ ${err}` };
  }
  const musicErr = validateMusic(musicAtt);
  if (musicErr) return { error: `❌ ${musicErr}` };
  if (musicAtt && !att) {
    return { error: '❌ L\'option `musique` nécessite un média (image ou GIF).' };
  }
  if (musicAtt && !att.contentType.startsWith('image/')) {
    return { error: '❌ L\'option `musique` ne fonctionne qu\'avec une image ou un GIF (pas une vidéo).' };
  }
  return { att, caption, musicAtt, rain, tts, effect };
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error('[bot] reply failed:', e.message);
  }
}

// Discord refuse les messages de plus de 2000 caractères (la réponse n'était
// alors jamais affichée) : la liste est coupée avec « … et N autres ».
const MAX_MESSAGE_CHARS = 2000;
function capLines(header, lines) {
  const full = [header, ...lines].join('\n');
  if (full.length <= MAX_MESSAGE_CHARS) return full;
  const room = MAX_MESSAGE_CHARS - `\n… et ${lines.length} autres`.length;
  let out = header;
  let n = 0;
  while (n < lines.length && out.length + 1 + lines[n].length <= room) out += `\n${lines[n++]}`;
  const rest = lines.length - n;
  return `${out}\n… et ${rest} autre${rest > 1 ? 's' : ''}`;
}

async function onInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // Tout le modèle de liens est par serveur : en MP, /link créait un lien
  // sans serveur (inutilisable) et /drop ne pouvait joindre personne.
  if (!interaction.inGuild()) {
    return safeReply(interaction, '❌ Les commandes MemeDrop s\'utilisent sur un serveur, pas en message privé.');
  }

  try {
    switch (interaction.commandName) {
      // ── /link — now per-guild ──────────────────────────────────────────
      case 'link': {
        if (linkLocked(interaction.user.id)) {
          return interaction.reply({
            content: '⏱️ Trop de codes invalides — réessaie dans quelques minutes.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const code = interaction.options.getString('code', true);
        const ws = pendingOverlays.get(code);

        // If already linked: the user is adding the current server to an
        // existing link. The overlay continues to advertise a fresh code for
        // this exact purpose, so any of those codes can be used here.
        const existing = userLinks.get(interaction.user.id);

        // If the code maps to a fresh, unlinked overlay → start a brand-new link
        if (ws) {
          const userId = interaction.user.id;
          pendingOverlays.delete(code);
          // Socket encore rattachée à un autre compte : elle le quitte d'abord
          const prevUser = wsMeta.get(ws)?.userId;
          if (prevUser && prevUser !== userId) detachSocket(ws);
          if (hasOpen(existing)) {
            // Appareil de plus (PC + téléphone) : il rejoint le lien existant,
            // qui gagne le serveur courant, au lieu d'en chasser l'autre.
            existing.sockets.add(ws);
            if (existing.scope !== 'global' && interaction.guildId) existing.guildIds.add(interaction.guildId);
          } else {
            // Preserve any existing blocklist if this user already had a link
            // (e.g. re-linking after the overlay lost its token)
            const blockedUsers = existing?.blockedUsers || new Set();
            const link = {
              sockets: new Set([ws]),
              scope: 'guild',
              guildIds: new Set(interaction.guildId ? [interaction.guildId] : []),
              blockedUsers,
            };
            userLinks.set(userId, link);
          }
          wsMeta.set(ws, { code: null, userId });
          // Réponse d'abord, sans l'attendre : le snapshot peut demander des
          // appels REST et Discord n'accorde que 3 s pour répondre.
          const replied = interaction.reply({
            content: `✅ Linked on **${interaction.guild?.name || 'this server'}**. To be reachable from other servers, run \`/link\` there too — your overlay shows the code.`,
            flags: MessageFlags.Ephemeral,
          }).catch((e) => console.error('[bot] reply failed:', e.message));
          const links = await buildLinksSnapshot(userId);
          // L'état a pu changer pendant l'await (/unlink, fermeture…) : on
          // vérifie le lien courant, pas celui d'avant.
          const cur = userLinks.get(userId);
          if (cur && cur.sockets.has(ws) && wsMeta.get(ws)?.userId === userId) {
            sendJson(ws, {
              type: 'linked',
              user: { id: userId, username: interaction.user.username },
              token: tokenFor(userId),
              links,
            });
            // Les autres appareils affichent aussi le serveur ajouté
            for (const s of openSockets(cur)) if (s !== ws) sendJson(s, { type: 'links_update', links });
            // Immediately issue a NEW pairing code attached to this linked
            // overlay. The overlay shows it so the user can /link on additional
            // servers without restarting the app.
            issueExtensionCode(userId);
          }
          return replied;
        }

        // Code is from a linked overlay's "extension" code — add this guild
        // to the existing link.
        const targetUserId = extensionCodes.get(code);
        if (targetUserId) {
          if (targetUserId !== interaction.user.id) {
            noteLinkFail(interaction.user.id);
            return interaction.reply({
              content: '❌ This code belongs to another user.',
              flags: MessageFlags.Ephemeral,
            });
          }
          const link = userLinks.get(targetUserId);
          if (!hasOpen(link)) {
            extensionCodes.delete(code);
            return interaction.reply({
              content: '❌ The overlay for that code is no longer connected.',
              flags: MessageFlags.Ephemeral,
            });
          }
          // Don't allow adding a guild to a legacy global link (no need)
          if (link.scope === 'global') {
            return interaction.reply({
              content: '✅ Your overlay is in legacy global mode — already reachable from every server.',
              flags: MessageFlags.Ephemeral,
            });
          }
          if (interaction.guildId) link.guildIds.add(interaction.guildId);
          // Rotate the extension code so each one is single-use
          extensionCodes.delete(code);
          issueExtensionCode(targetUserId);
          // Réponse d'abord : le snapshot (noms des bloqués) peut demander des
          // appels REST et Discord n'accorde que 3 s pour répondre.
          const replied = interaction.reply({
            content: `✅ Added **${interaction.guild?.name || 'this server'}** to your linked sources (${link.guildIds.size} total).`,
            flags: MessageFlags.Ephemeral,
          });
          pushLinksUpdate(targetUserId).catch((e) => console.error('[ws] links_update failed:', e.message));
          return replied;
        }

        noteLinkFail(interaction.user.id);
        if (!existing) {
          return interaction.reply({
            content: '❌ Invalid or expired code. Open the overlay (it shows a fresh code) and try again.',
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          content: '❌ Invalid or expired code. Check the code in your overlay app and try again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /unlink — fully unlinks the user (all guilds at once) ──────────
      case 'unlink': {
        const link = userLinks.get(interaction.user.id);
        if (!link) {
          return interaction.reply({
            content: 'You have no linked overlay.',
            flags: MessageFlags.Ephemeral,
          });
        }
        // Tous ses appareils, et ses codes d'extension avec
        unlinkUser(interaction.user.id, 'user');
        return interaction.reply({
          content: '✅ Unlinked from every server. Your overlay shows a new pairing code.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /status ─────────────────────────────────────────────────────────
      case 'status': {
        const link = userLinks.get(interaction.user.id);
        if (!hasOpen(link)) {
          return interaction.reply({
            content: '🔴 No overlay linked. Launch the app and use `/link <code>`.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (link.scope === 'global') {
          return interaction.reply({
            content: '🟢 Overlay linked (legacy global mode — reachable from any server).',
            flags: MessageFlags.Ephemeral,
          });
        }
        const here = interaction.guildId && link.guildIds.has(interaction.guildId);
        return interaction.reply({
          content: here
            ? `🟢 Linked on **${interaction.guild?.name || 'this server'}** (${link.guildIds.size} server${link.guildIds.size > 1 ? 's' : ''} total).`
            : `🟡 You have an overlay, but not linked on **${interaction.guild?.name || 'this server'}**. Run \`/link <code>\` here too.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /who ────────────────────────────────────────────────────────────
      case 'who': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guildId = interaction.guildId;
        const list = [];
        for (const [userId, link] of userLinks) {
          if (!hasOpen(link)) continue;
          if (!canDrop(interaction.user.id, userId, guildId)) continue;
          // Filter to actual members of this guild
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) list.push(`• <@${userId}>`);
        }
        return safeReply(interaction,
          list.length
            ? `**Drop targets reachable from this server:**\n${list.join('\n')}`
            : 'No drop targets in this server right now. 😴');
      }

      // ── /drop ───────────────────────────────────────────────────────────
      case 'drop': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const remain = cooldownRemaining(lastDropAt, interaction.user.id, DROP_COOLDOWN_MS);
        if (remain > 0) {
          return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/drop\`.`);
        }

        const targets = resolveTargets(interaction);
        if (targets.length === 0) {
          return safeReply(interaction, '🤖 Aucune cible valide (bots et doublons filtrés).');
        }

        // Le cooldown n'est consommé qu'une fois les options validées : une
        // faute de frappe ne doit pas coûter l'attente.
        const opts = readDropOptions(interaction);
        if (opts.error) return safeReply(interaction, opts.error);
        const delayMin = interaction.options.getInteger('delai', false);
        if (delayMin > 0 && (pendingDelayed.get(interaction.user.id) || 0) >= MAX_PENDING_DELAYED) {
          return safeReply(interaction, `⏳ Tu as déjà ${MAX_PENDING_DELAYED} drops programmés — attends qu'ils partent.`);
        }
        markCooldown(lastDropAt, interaction.user.id);

        const { att, caption, musicAtt, rain, tts, effect } = opts;
        const payload = buildDropPayload(att, caption, interaction.user, musicAtt || null, rain, { tts, effect });

        // Drop différé : on programme l'envoi et on répond tout de suite.
        // (Perdu si le bot redémarre entre-temps — assumé pour un troll.)
        if (delayMin && delayMin > 0) {
          const minutes   = Math.min(delayMin, 60);
          const senderId  = interaction.user.id;
          const guildId   = interaction.guildId;
          const channelId = interaction.channelId;
          pendingDelayed.set(senderId, (pendingDelayed.get(senderId) || 0) + 1);
          setTimeout(() => {
            const left = (pendingDelayed.get(senderId) || 1) - 1;
            if (left > 0) pendingDelayed.set(senderId, left);
            else pendingDelayed.delete(senderId);
            payload.ts = Date.now();
            const { delivered } = deliverDrop(senderId, guildId, channelId, targets, payload);
            console.log(`[drop] delayed drop fired (${delivered.length}/${targets.length} delivered)`);
          }, minutes * 60_000);
          return safeReply(interaction,
            `⏳ Drop programmé dans **${minutes} min** pour ${targets.map(t => `**${t.username}**`).join(', ')}. 😈`);
        }

        return safeReply(interaction, dispatchToTargets(interaction, targets, payload, musicAtt));
      }

      // ── /dropall — only reachable users in this guild ──────────────────
      case 'dropall': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const remain = cooldownRemaining(lastDropAllAt, interaction.user.id, DROPALL_COOLDOWN_MS);
        if (remain > 0) {
          return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/dropall\`.`);
        }

        const opts = readDropOptions(interaction);
        if (opts.error) return safeReply(interaction, opts.error);
        const { att, caption, musicAtt, rain, tts, effect } = opts;
        // Réservé avant les await ci-dessous (voir reserveCooldown)
        const undoCooldown = reserveCooldown(lastDropAllAt, interaction.user.id);

        const recipients = [];
        for (const [userId, link] of userLinks) {
          if (!hasOpen(link)) continue;
          if (!canDrop(interaction.user.id, userId, interaction.guildId)) continue;
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) recipients.push({ id: userId, username: member.user.username });
        }
        if (recipients.length === 0) {
          undoCooldown();
          return safeReply(interaction, 'Personne n\'est atteignable sur ce serveur pour l\'instant. 😴');
        }

        const payload = buildDropPayload(att, caption, interaction.user, musicAtt || null, rain, { tts, effect });
        // deliverDrop revérifie chaque destinataire : il a pu se déconnecter
        // ou bloquer l'expéditeur pendant les await.
        const { delivered: names } =
          deliverDrop(interaction.user.id, interaction.guildId, interaction.channelId, recipients, payload);
        if (names.length === 0) {
          undoCooldown();
          return safeReply(interaction, 'Personne n\'est atteignable sur ce serveur pour l\'instant. 😴');
        }
        return safeReply(interaction,
          `💥 Drop envoyé à **${names.length}** personne${names.length > 1 ? 's' : ''} : ${names.map(n => `**${n}**`).join(', ')}${musicAtt ? ' 🎵' : ''}`);
      }

      // ── /block — stop a specific user from being able to /drop you ─────
      case 'block': {
        const link = userLinks.get(interaction.user.id);
        if (!link) {
          return interaction.reply({
            content: '❌ Lance ton overlay et fais `/link <code>` avant de bloquer quelqu\'un.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const target = interaction.options.getUser('user', true);
        if (target.id === interaction.user.id) {
          return interaction.reply({ content: '🤔 Tu ne peux pas te bloquer toi-même.', flags: MessageFlags.Ephemeral });
        }
        link.blockedUsers.add(target.id);
        // Réponse d'abord : le snapshot peut demander des appels REST (3 s max)
        const replied = interaction.reply({
          content: `🔇 **${target.username}** ne pourra plus t'envoyer de drops.`,
          flags: MessageFlags.Ephemeral,
        });
        pushLinksUpdate(interaction.user.id).catch((e) => console.error('[ws] links_update failed:', e.message));
        return replied;
      }

      // ── /unblock — re-allow a previously blocked user ───────────────────
      case 'unblock': {
        const link = userLinks.get(interaction.user.id);
        const target = interaction.options.getUser('user', true);
        if (!link || !link.blockedUsers.has(target.id)) {
          return interaction.reply({
            content: `**${target.username}** n'est pas bloqué.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        link.blockedUsers.delete(target.id);
        const replied = interaction.reply({
          content: `🔊 **${target.username}** peut à nouveau t'envoyer des drops.`,
          flags: MessageFlags.Ephemeral,
        });
        pushLinksUpdate(interaction.user.id).catch((e) => console.error('[ws] links_update failed:', e.message));
        return replied;
      }

      // ── /blocklist — list who you've blocked ────────────────────────────
      case 'blocklist': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const link = userLinks.get(interaction.user.id);
        if (!link || link.blockedUsers.size === 0) {
          return safeReply(interaction, 'Tu n\'as bloqué personne. 🕊️');
        }
        const blocked = await buildBlockedSnapshot(interaction.user.id);
        return safeReply(interaction,
          capLines('**Utilisateurs bloqués :**', blocked.map(b => `• ${b.username} (\`${b.id}\`)`)));
      }

      // ── /fav — gérer ses médias favoris ─────────────────────────────────
      case 'fav': {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        if (sub === 'add') {
          const name = interaction.options.getString('name', true).trim();
          const att = interaction.options.getAttachment('media', true);
          const caption = interaction.options.getString('caption', false);
          if (!name) {
            return interaction.reply({ content: '❌ Nom invalide.', flags: MessageFlags.Ephemeral });
          }
          const err = validateAttachment(att);
          if (err) return interaction.reply({ content: `❌ ${err}`, flags: MessageFlags.Ephemeral });

          const list = favorites.get(userId) || [];
          const idx = list.findIndex(f => f.name.toLowerCase() === name.toLowerCase());
          const entry = {
            name,
            url: att.url,
            mime: att.contentType,
            kind: classifyMedia(att.contentType),
            size: att.size,
            caption: caption ? clip(caption, 80) : null,
            savedAt: Date.now(),
          };
          if (idx !== -1) {
            list[idx] = entry;
          } else {
            if (list.length >= MAX_FAVORITES) {
              return interaction.reply({
                content: `❌ Limite de ${MAX_FAVORITES} favoris atteinte. Supprime-en un avec \`/fav remove\`.`,
                flags: MessageFlags.Ephemeral,
              });
            }
            list.push(entry);
          }
          favorites.set(userId, list);
          persistStore();
          return interaction.reply({
            content: `⭐ Favori **${name}** enregistré ! Utilise \`/dropfav ${name}\` pour le renvoyer.\n⚠️ Les liens Discord expirent après ~24h : si le drop ne s'affiche plus, refais \`/fav add ${name}\`.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (sub === 'list') {
          const list = favorites.get(userId) || [];
          if (list.length === 0) {
            return interaction.reply({ content: 'Tu n\'as aucun favori. Ajoute-en avec `/fav add`.', flags: MessageFlags.Ephemeral });
          }
          const lines = list.map(f => `• **${f.name}** (${f.kind})${f.caption ? ` — _${f.caption}_` : ''}`);
          return interaction.reply({ content: `**Tes favoris :**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'remove') {
          const name = interaction.options.getString('name', true).trim();
          const list = favorites.get(userId) || [];
          const idx = list.findIndex(f => f.name.toLowerCase() === name.toLowerCase());
          if (idx === -1) {
            return interaction.reply({ content: `❌ Aucun favori nommé **${name}**.`, flags: MessageFlags.Ephemeral });
          }
          list.splice(idx, 1);
          favorites.set(userId, list);
          persistStore();
          return interaction.reply({ content: `🗑️ Favori **${name}** supprimé.`, flags: MessageFlags.Ephemeral });
        }
        break;
      }

      // ── /dropfav — renvoyer un favori enregistré ────────────────────────
      case 'dropfav': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const remain = cooldownRemaining(lastDropAt, interaction.user.id, DROP_COOLDOWN_MS);
        if (remain > 0) {
          return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/drop\`.`);
        }

        const name = interaction.options.getString('name', true).trim();
        const list = favorites.get(interaction.user.id) || [];
        const fav = list.find(f => f.name.toLowerCase() === name.toLowerCase());
        if (!fav) {
          return safeReply(interaction, `❌ Aucun favori nommé **${name}**. Vois \`/fav list\`.`);
        }

        const targets = resolveTargets(interaction);
        if (targets.length === 0) {
          return safeReply(interaction, '🤖 Aucune cible valide (bots et doublons filtrés).');
        }
        markCooldown(lastDropAt, interaction.user.id);

        const rain   = extractEmojis(interaction.options.getString('pluie', false));
        const effect = interaction.options.getString('effet', false);
        const att = { url: fav.url, contentType: fav.mime, name: fav.name, size: fav.size, width: null, height: null };
        const payload = buildDropPayload(att, fav.caption, interaction.user, null, rain, { effect });
        return safeReply(interaction, dispatchToTargets(interaction, targets, payload, null));
      }

      // ── /group — gérer des groupes de cibles ────────────────────────────
      case 'group': {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const userGroups = groups.get(userId) || new Map();

        if (sub === 'set') {
          const name = interaction.options.getString('name', true).trim();
          if (!name) {
            return interaction.reply({ content: '❌ Nom invalide.', flags: MessageFlags.Ephemeral });
          }
          const members = resolveTargets(interaction).map(u => u.id);
          if (members.length === 0) {
            return interaction.reply({ content: '🤖 Aucun membre valide (bots et doublons filtrés).', flags: MessageFlags.Ephemeral });
          }
          const existingKey = [...userGroups.keys()].find(k => k.toLowerCase() === name.toLowerCase());
          if (!existingKey && userGroups.size >= MAX_GROUPS) {
            return interaction.reply({
              content: `❌ Limite de ${MAX_GROUPS} groupes atteinte. Supprime-en un avec \`/group delete\`.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          if (existingKey) userGroups.delete(existingKey);
          userGroups.set(name, members);
          groups.set(userId, userGroups);
          persistStore();
          return interaction.reply({
            content: `📁 Groupe **${name}** enregistré avec ${members.length} membre${members.length > 1 ? 's' : ''}. Utilise \`/dropgroup ${name}\` pour leur envoyer un mème.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (sub === 'list') {
          if (userGroups.size === 0) {
            return interaction.reply({ content: 'Tu n\'as aucun groupe. Crée-en un avec `/group set`.', flags: MessageFlags.Ephemeral });
          }
          const lines = [...userGroups].map(([gName, ids]) => `• **${gName}** — ${ids.map(id => `<@${id}>`).join(', ')}`);
          return interaction.reply({ content: `**Tes groupes :**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'delete') {
          const name = interaction.options.getString('name', true).trim();
          const existingKey = [...userGroups.keys()].find(k => k.toLowerCase() === name.toLowerCase());
          if (!existingKey) {
            return interaction.reply({ content: `❌ Aucun groupe nommé **${name}**.`, flags: MessageFlags.Ephemeral });
          }
          userGroups.delete(existingKey);
          groups.set(userId, userGroups);
          persistStore();
          return interaction.reply({ content: `🗑️ Groupe **${existingKey}** supprimé.`, flags: MessageFlags.Ephemeral });
        }
        break;
      }

      // ── /dropgroup — envoyer un mème à un groupe de cibles ──────────────
      case 'dropgroup': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const remain = cooldownRemaining(lastDropAt, interaction.user.id, DROP_COOLDOWN_MS);
        if (remain > 0) {
          return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/drop\`.`);
        }

        const name = interaction.options.getString('name', true).trim();
        const userGroups = groups.get(interaction.user.id) || new Map();
        const groupKey = [...userGroups.keys()].find(k => k.toLowerCase() === name.toLowerCase());
        if (!groupKey) {
          return safeReply(interaction, `❌ Aucun groupe nommé **${name}**. Vois \`/group list\`.`);
        }

        const opts = readDropOptions(interaction);
        if (opts.error) return safeReply(interaction, opts.error);
        const { att, caption, musicAtt, rain, tts, effect } = opts;
        // Réservé avant les await ci-dessous (voir reserveCooldown)
        const undoCooldown = reserveCooldown(lastDropAt, interaction.user.id);

        const memberIds = userGroups.get(groupKey);
        const targets = [];
        for (const id of memberIds) {
          const u = await client.users.fetch(id).catch(() => null);
          if (u && !u.bot) targets.push(u);
        }
        if (targets.length === 0) {
          undoCooldown();
          return safeReply(interaction, `❌ Aucun membre du groupe **${groupKey}** n'est joignable (utilisateurs introuvables).`);
        }

        const payload = buildDropPayload(att, caption, interaction.user, musicAtt || null, rain, { tts, effect });
        return safeReply(interaction, dispatchToTargets(interaction, targets, payload, musicAtt));
      }

      // ── /stats — compteurs de drops envoyés / reçus ─────────────────────
      case 'stats': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const mine = stats[interaction.user.id] || { sent: 0, received: 0 };

        const top = (key) => Object.entries(stats)
          .filter(([, v]) => (v[key] || 0) > 0)
          .sort((a, b) => (b[1][key] || 0) - (a[1][key] || 0))
          .slice(0, 5);

        const fmt = async (rows, key) => {
          const lines = [];
          for (const [id, v] of rows) {
            let name = id;
            try { name = (await client.users.fetch(id)).username; } catch {}
            const medal = ['🥇', '🥈', '🥉'][lines.length] || '▫️';
            lines.push(`${medal} **${name}** — ${v[key]}`);
          }
          return lines.length ? lines.join('\n') : '_personne pour l\'instant_';
        };

        return safeReply(interaction,
          `📊 **Tes stats** : ${mine.sent} drop${mine.sent > 1 ? 's' : ''} envoyé${mine.sent > 1 ? 's' : ''} · ${mine.received} reçu${mine.received > 1 ? 's' : ''}\n\n` +
          `**🏆 Top droppeurs**\n${await fmt(top('sent'), 'sent')}\n\n` +
          `**🎯 Top victimes**\n${await fmt(top('received'), 'received')}`);
      }
    }
  } catch (err) {
    console.error('[bot] interaction error:', err);
    await safeReply(interaction, '⚠️ Internal error. Try again.');
  }
}

client.on(Events.InteractionCreate, (interaction) => {
  // Un `return interaction.reply(...)` refusé par Discord (10062, 5xx…)
  // échappe au try/catch ; ré-émis en 'error' sur le client, il arrêtait le bot.
  onInteraction(interaction).catch((e) => console.error('[bot] interaction failed:', e.message));
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  // Sinon le serveur WebSocket restait debout sans Discord : un bot à moitié
  // vivant que l'hébergeur ne relançait pas.
  console.error('[bot] login failed:', e.message);
  process.exit(1);
});

// Filets de sécurité : un rejet oublié est journalisé et le bot continue ;
// une exception synchrone laisse un état douteux, donc on sauve le store et on
// sort (l'hébergeur relance le process).
process.on('unhandledRejection', (e) => console.error('[bot] unhandled rejection:', e));
process.on('uncaughtException', (e) => {
  console.error('[bot] uncaught exception:', e);
  try { store.flush(); } catch {}
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[bot] shutting down…');
  store.flush();
  // Pas de trame de fermeture : les APK Android ≤ 1.6.0 n'achèvent pas la
  // poignée de main et ne se reconnecteraient jamais. On coupe le TCP.
  wss.clients.forEach(ws => ws.terminate());
  wss.close();
  httpServer.close();
  client.destroy().finally(() => process.exit(0));
});
process.on('SIGTERM', () => process.emit('SIGINT'));
