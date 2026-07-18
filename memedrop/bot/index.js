// index.js — MemeDrop bot
require('dotenv').config();

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

const PORT = Number(process.env.PORT || process.env.WS_PORT || 8765);

// ── TTS servi par le bot ─────────────────────────────────────────────────────
// La synthèse vocale du renderer Electron (speechSynthesis) est muette sur la
// plupart des PC : Chromium n'embarque aucune voix. Le bot expose donc
// GET /tts?text=... qui relaie le MP3 généré par Google Translate TTS ;
// l'overlay le joue dans un simple élément <audio>.
async function handleTts(u, res) {
  const text = (u.searchParams.get('text') || '').trim().slice(0, MAX_TTS_CHARS);
  if (!text) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing text');
    return;
  }
  const rawLang = u.searchParams.get('lang') || '';
  const lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(rawLang) ? rawLang : 'fr';
  try {
    const g = await fetch(
      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${lang}&q=${encodeURIComponent(text)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
    );
    if (!g.ok) throw new Error(`upstream ${g.status}`);
    const buf = Buffer.from(await g.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(buf);
  } catch (e) {
    console.error('[tts] failed:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('tts failed');
  }
}

const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MemeDrop bot online');
    return;
  }
  if (u.pathname === '/tts' && req.method === 'GET') {
    handleTts(u, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

// ─────────────────────────────────────────────────────────────────────────────
// Linkage model
//
// pendingOverlays : code (string)      -> ws
// userLinks       : discordUserId      -> { ws, scope: 'global' | 'guild',
//                                           guildIds: Set<string> }
//
// `scope: 'global'` is the legacy mode (pre-v7). One link = reachable from
// anywhere. Set when an overlay /link was done before this version.
//
// `scope: 'guild'` is the new mode: the user is reachable only from servers
// whose ID is in `guildIds`. Each /link adds the current server to the set.
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
  store.save({
    favorites: Object.fromEntries(favorites),
    groups: Object.fromEntries([...groups].map(([k, v]) => [k, Object.fromEntries(v)])),
    stats,
  });
}

function bumpStats(fromId, toId) {
  const f = stats[fromId] || (stats[fromId] = { sent: 0, received: 0 });
  const t = stats[toId]   || (stats[toId]   = { sent: 0, received: 0 });
  f.sent++;
  t.received++;
  persistStore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Réactions aux drops
//
// Chaque drop délivré est mémorisé (dropId -> expéditeur + canal d'origine)
// pendant 15 min. Le receveur peut cliquer un emoji sur le drop dans son
// overlay ; l'overlay renvoie { type:'react', dropId, emoji } et le bot
// poste la réaction dans le canal d'où venait le /drop. Une réaction max
// par personne et par drop.
// ─────────────────────────────────────────────────────────────────────────────
const recentDrops     = new Map();
const REACTION_EMOJIS = new Set(['😂', '💀', '🔥', '😭', '🖕']);

function registerDropForReactions(payload, senderId, channelId) {
  if (!payload.dropId || !channelId) return;
  recentDrops.set(payload.dropId, { senderId, channelId, reacted: new Set(), ts: Date.now() });
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
if (!process.env.LINK_SECRET) {
  console.warn('[security] LINK_SECRET not set — using an ephemeral secret. ' +
    'Zero-touch re-link will require a fresh /link after every restart. ' +
    'Set LINK_SECRET to a long random string in your environment to persist links across redeploys.');
}
function tokenFor(userId) {
  return crypto.createHmac('sha256', LINK_SECRET).update(String(userId)).digest('hex');
}

// While an overlay is linked, the bot keeps issuing single-use "extension"
// codes so the user can /link on additional servers without restarting the
// app. extensionCodes maps code (string) -> userId.
const extensionCodes  = new Map();

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

// Issue a single-use code that, when used in a Discord /link command, adds the
// current guild to the already-linked user's allowed sources.
function issueExtensionCode(ws, userId) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  // Clean any old extension code for this ws
  for (const [c, uid] of extensionCodes) {
    if (uid === userId) extensionCodes.delete(c);
  }
  const code = generatePairingCode();
  extensionCodes.set(code, userId);
  // Reuse the pairing_code message type so the overlay UI shows it naturally
  sendJson(ws, { type: 'pairing_code', code });
  console.log(`[ws] extension code ${code} for user ${userId}`);
}

// Can a user, viewed from a given guild, be targeted by /drop here?
function isReachable(userId, fromGuildId) {
  const link = userLinks.get(userId);
  if (!link || link.ws.readyState !== link.ws.OPEN) return false;
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
async function buildBlockedSnapshot(userId) {
  const link = userLinks.get(userId);
  if (!link || !link.blockedUsers || link.blockedUsers.size === 0) return [];
  const out = [];
  for (const id of link.blockedUsers) {
    let username = id;
    try {
      const u = await client.users.fetch(id);
      username = u.username;
    } catch {}
    out.push({ id, username });
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
  const link = userLinks.get(userId);
  if (!link) return;
  sendJson(link.ws, {
    type: 'links_update',
    links: await buildLinksSnapshot(userId),
  });
}

wss.on('connection', (ws) => {
  const code = generatePairingCode();
  pendingOverlays.set(code, ws);
  wsMeta.set(ws, { code, userId: null });

  sendJson(ws, { type: 'pairing_code', code });
  console.log(`[ws] overlay connected, pairing code = ${code}`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'pong') return;

    // Zero-touch re-link: the overlay replays its stored identity so the bot
    // rebuilds the live link with no /link needed. Survives bot redeploys
    // because the identity lives on the user's PC, not in bot memory.
    if (msg.type === 'register') {
      const id       = msg.identity || {};
      const userId   = String(id.userId || '');
      const username = String(id.username || 'unknown');
      const scope    = id.scope === 'global' ? 'global' : 'guild';
      const guildIds = new Set(Array.isArray(id.guildIds) ? id.guildIds.map(String) : []);
      const blockedUsers = new Set(Array.isArray(id.blockedIds) ? id.blockedIds.map(String) : []);
      // Need a usable identity with at least one reachable source
      if (!userId || (scope === 'guild' && guildIds.size === 0)) {
        sendJson(ws, { type: 'register_failed' });
        return;
      }
      // Verify the re-link token. Without a valid token (e.g. an overlay
      // linked before this check existed, or a forged identity), force a
      // fresh /link instead of trusting the claimed userId.
      if (String(id.token || '') !== tokenFor(userId)) {
        sendJson(ws, { type: 'register_failed' });
        return;
      }
      // Drop the pending pairing code this ws was handed on connect
      const meta = wsMeta.get(ws);
      if (meta?.code) pendingOverlays.delete(meta.code);
      // Kick any other live overlay currently bound to this user
      const existing = userLinks.get(userId);
      if (existing && existing.ws !== ws) {
        sendJson(existing.ws, { type: 'unlinked', reason: 'replaced' });
      }
      userLinks.set(userId, { ws, scope, guildIds, blockedUsers });
      wsMeta.set(ws, { code: null, userId });
      sendJson(ws, {
        type: 'linked',
        user: { id: userId, username },
        token: tokenFor(userId),
        links: await buildLinksSnapshot(userId),
      });
      issueExtensionCode(ws, userId);
      console.log(`[ws] auto-registered user ${userId} (${scope}, ${guildIds.size} guild(s))`);
      return;
    }

    // The overlay can ask the bot to revoke a specific guild link
    if (msg.type === 'unlink_guild') {
      const meta = wsMeta.get(ws);
      if (!meta?.userId) return;
      const link = userLinks.get(meta.userId);
      if (!link || link.scope !== 'guild') return;
      const guildId = String(msg.guildId || '');
      if (!guildId) return;
      link.guildIds.delete(guildId);
      // If no guilds remain, drop the user fully (they'll need to /link again)
      if (link.guildIds.size === 0) {
        userLinks.delete(meta.userId);
        sendJson(ws, { type: 'unlinked', reason: 'no_guilds_left' });
        reissuePairingCode(ws);
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
      const targetId = String(msg.userId || '');
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
      const entry = recentDrops.get(String(msg.dropId || ''));
      if (!entry) return;
      const emoji = String(msg.emoji || '');
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
  });

  ws.on('close', () => {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    if (meta.code) pendingOverlays.delete(meta.code);
    if (meta.userId) {
      const link = userLinks.get(meta.userId);
      if (link && link.ws === ws) userLinks.delete(meta.userId);
      // Clean up any extension codes for this user
      for (const [c, uid] of extensionCodes) {
        if (uid === meta.userId) extensionCodes.delete(c);
      }
    }
    console.log(`[ws] overlay disconnected (user=${meta.userId || 'unlinked'})`);
  });

  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) sendJson(ws, { type: 'ping' });
  });
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`[http+ws] listening on port ${PORT}`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
});

// Re-emit links snapshot when guild data changes, so overlays show fresh names/icons
client.on(Events.GuildUpdate, (oldG, newG) => {
  for (const [userId, link] of userLinks) {
    if (link.scope === 'guild' && link.guildIds.has(newG.id)) {
      pushLinksUpdate(userId);
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

function formatCooldown(ms) {
  return (ms / 1000).toFixed(1).replace(/\.0$/, '');
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

// ─────────────────────────────────────────────────────────────────────────────
// Recherche de GIF (Tenor) — alternative à l'upload d'un fichier pour /drop,
// /dropall et /dropgroup. Un choix d'autocomplete Discord ne peut renvoyer
// qu'une valeur de 100 caractères max (trop court pour une URL Tenor), donc
// l'autocomplete ne renvoie que l'id du GIF et on garde l'URL/taille en cache
// le temps que l'utilisateur valide la commande.
// ─────────────────────────────────────────────────────────────────────────────
const TENOR_API_KEY = process.env.TENOR_API_KEY || '';
const gifCache = new Map(); // `${userId}:${tenorId}` -> { url, size, width, height, ts }

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, entry] of gifCache) {
    if (entry.ts < cutoff) gifCache.delete(key);
  }
}, 5 * 60_000);

async function searchTenor(query) {
  if (!TENOR_API_KEY || !query) return [];
  const u = new URL('https://tenor.googleapis.com/v2/search');
  u.searchParams.set('q', query);
  u.searchParams.set('key', TENOR_API_KEY);
  u.searchParams.set('client_key', 'memedrop');
  u.searchParams.set('limit', '10');
  u.searchParams.set('media_filter', 'gif');
  u.searchParams.set('contentfilter', 'medium');
  const res = await fetch(u);
  if (!res.ok) throw new Error(`tenor ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .map(r => {
      const media = r.media_formats?.gif;
      if (!media?.url) return null;
      return {
        id: r.id,
        label: String(r.content_description || r.title || 'gif').slice(0, 100),
        url: media.url,
        size: media.size || 0,
        width: media.dims?.[0] || null,
        height: media.dims?.[1] || null,
      };
    })
    .filter(Boolean);
}

async function handleGifAutocomplete(interaction) {
  const query = String(interaction.options.getFocused() || '').trim();
  if (!query) return interaction.respond([]);
  try {
    const results = await searchTenor(query);
    const now = Date.now();
    for (const r of results) {
      gifCache.set(`${interaction.user.id}:${r.id}`, { url: r.url, size: r.size, width: r.width, height: r.height, ts: now });
    }
    await interaction.respond(results.map(r => ({ name: r.label, value: r.id })));
  } catch (e) {
    console.error('[gif] autocomplete failed:', e.message);
    try { await interaction.respond([]); } catch {}
  }
}

// Résout l'option `gif` (id Tenor choisi via autocomplete) en un objet avec
// les mêmes champs qu'un attachement Discord, pour rester compatible avec
// validateAttachment/buildDropPayload sans dupliquer leur logique.
function resolveGifOption(interaction) {
  const gifId = interaction.options.getString('gif', false);
  if (!gifId) return { att: null, error: null };
  const cached = gifCache.get(`${interaction.user.id}:${gifId}`);
  if (!cached) {
    return { att: null, error: '❌ GIF introuvable ou expiré — relance la recherche `gif` et choisis une suggestion dans la liste.' };
  }
  return {
    att: {
      url: cached.url,
      contentType: 'image/gif',
      name: `tenor-${gifId}.gif`,
      size: cached.size,
      width: cached.width,
      height: cached.height,
    },
    error: null,
  };
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
const MAX_TTS_CHARS = 200;

// Base publique du bot, utilisée pour construire les URL /tts envoyées aux
// overlays. Sur Fly.io, FLY_APP_NAME est fourni automatiquement ; sinon on
// retombe sur le domaine prod connu (même fallback codé en dur que dans le
// main.js de l'overlay).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
  (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '') ||
  'https://memedrop-bot.fly.dev'
).replace(/\/+$/, '');

function ttsUrlFor(text) {
  if (!text) return null;
  return `${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}`;
}

function buildDropPayload(att, caption, fromUser, musicAtt = null, rain = null, extra = {}) {
  const ttsText = extra.tts ? String(extra.tts).slice(0, MAX_TTS_CHARS) : null;
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
    caption: caption ? String(caption).slice(0, 80) : null,
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

// Envoie `payload` aux cibles atteignables et renvoie un message récapitulatif.
function dispatchToTargets(interaction, targets, payload, musicAtt) {
  const delivered = [];
  const notReachable = [];
  for (const t of targets) {
    if (canDrop(interaction.user.id, t.id, interaction.guildId)) {
      sendJson(userLinks.get(t.id).ws, payload);
      delivered.push(t.username);
      bumpStats(interaction.user.id, t.id);
    } else {
      notReachable.push(t.username);
    }
  }
  if (delivered.length) {
    registerDropForReactions(payload, interaction.user.id, interaction.channelId);
  }
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.options.getFocused(true).name === 'gif') {
      await handleGifAutocomplete(interaction);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      // ── /link — now per-guild ──────────────────────────────────────────
      case 'link': {
        const code = interaction.options.getString('code', true);
        const ws = pendingOverlays.get(code);

        // If already linked: the user is adding the current server to an
        // existing link. The overlay continues to advertise a fresh code for
        // this exact purpose, so any of those codes can be used here.
        const existing = userLinks.get(interaction.user.id);

        // If the code maps to a fresh, unlinked overlay → start a brand-new link
        if (ws) {
          // If the user had a previous overlay linked, kick it cleanly
          if (existing && existing.ws !== ws) {
            sendJson(existing.ws, { type: 'unlinked', reason: 'replaced' });
            userLinks.delete(interaction.user.id);
            reissuePairingCode(existing.ws);
          }
          pendingOverlays.delete(code);
          // Preserve any existing blocklist if this user already had a link
          // (e.g. re-linking after the overlay lost its token)
          const blockedUsers = existing?.blockedUsers || new Set();
          const link = {
            ws,
            scope: 'guild',
            guildIds: new Set(interaction.guildId ? [interaction.guildId] : []),
            blockedUsers,
          };
          userLinks.set(interaction.user.id, link);
          wsMeta.set(ws, { code: null, userId: interaction.user.id });
          sendJson(ws, {
            type: 'linked',
            user: { id: interaction.user.id, username: interaction.user.username },
            token: tokenFor(interaction.user.id),
            links: await buildLinksSnapshot(interaction.user.id),
          });
          // Immediately issue a NEW pairing code attached to this linked
          // overlay. The overlay shows it so the user can /link on additional
          // servers without restarting the app.
          issueExtensionCode(ws, interaction.user.id);
          return interaction.reply({
            content: `✅ Linked on **${interaction.guild?.name || 'this server'}**. To be reachable from other servers, run \`/link\` there too — your overlay shows the code.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Code is from a linked overlay's "extension" code — add this guild
        // to the existing link.
        const targetUserId = extensionCodes.get(code);
        if (targetUserId) {
          if (targetUserId !== interaction.user.id) {
            return interaction.reply({
              content: '❌ This code belongs to another user.',
              flags: MessageFlags.Ephemeral,
            });
          }
          const link = userLinks.get(targetUserId);
          if (!link || link.ws.readyState !== link.ws.OPEN) {
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
          if (interaction.guildId) {
            link.guildIds.add(interaction.guildId);
            await pushLinksUpdate(targetUserId);
          }
          // Rotate the extension code so each one is single-use
          extensionCodes.delete(code);
          issueExtensionCode(link.ws, targetUserId);
          return interaction.reply({
            content: `✅ Added **${interaction.guild?.name || 'this server'}** to your linked sources (${link.guildIds.size} total).`,
            flags: MessageFlags.Ephemeral,
          });
        }

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
        const { ws } = link;
        userLinks.delete(interaction.user.id);
        sendJson(ws, { type: 'unlinked', reason: 'user' });
        reissuePairingCode(ws);
        return interaction.reply({
          content: '✅ Unlinked from every server. Your overlay shows a new pairing code.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /status ─────────────────────────────────────────────────────────
      case 'status': {
        const link = userLinks.get(interaction.user.id);
        if (!link || link.ws.readyState !== link.ws.OPEN) {
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
          if (link.ws.readyState !== link.ws.OPEN) continue;
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

        {
          const remain = cooldownRemaining(lastDropAt, interaction.user.id, DROP_COOLDOWN_MS);
          if (remain > 0) {
            return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/drop\`.`);
          }
          markCooldown(lastDropAt, interaction.user.id);
        }

        const targets = resolveTargets(interaction);
        if (targets.length === 0) {
          return safeReply(interaction, '🤖 Aucune cible valide (bots et doublons filtrés).');
        }

        const fileAtt  = interaction.options.getAttachment('media', false);
        const caption  = interaction.options.getString('caption', false);
        const musicAtt = interaction.options.getAttachment('musique', false);
        const rain     = extractEmojis(interaction.options.getString('pluie', false));
        const tts      = (interaction.options.getString('tts', false) || '').trim() || null;
        const effect   = interaction.options.getString('effet', false);
        const delayMin = interaction.options.getInteger('delai', false);

        if (fileAtt && interaction.options.getString('gif', false)) {
          return safeReply(interaction, '❌ Choisis soit `media` soit `gif`, pas les deux.');
        }
        const { att: gifAtt, error: gifError } = resolveGifOption(interaction);
        if (gifError) return safeReply(interaction, gifError);
        const att = fileAtt || gifAtt;

        // Il faut au moins un média, une pluie ou un texte à lire
        if (!att && !rain && !tts) {
          return safeReply(interaction, '❌ Mets au moins un média (`media`/`gif`), un emoji (`pluie`) ou un texte (`tts`).');
        }

        if (att) {
          const err = validateAttachment(att);
          if (err) return safeReply(interaction, `❌ ${err}`);
        }

        const musicErr = validateMusic(musicAtt);
        if (musicErr) return safeReply(interaction, `❌ ${musicErr}`);

        if (musicAtt && !att) {
          return safeReply(interaction, '❌ L\'option `musique` nécessite un média (image ou GIF).');
        }
        if (musicAtt && att && !att.contentType.startsWith('image/')) {
          return safeReply(interaction, '❌ L\'option `musique` ne fonctionne qu\'avec une image ou un GIF (pas une vidéo).');
        }

        const payload = buildDropPayload(att, caption, interaction.user, musicAtt || null, rain, { tts, effect });

        // Drop différé : on programme l'envoi et on répond tout de suite.
        // (Perdu si le bot redémarre entre-temps — assumé pour un troll.)
        if (delayMin && delayMin > 0) {
          const senderId  = interaction.user.id;
          const guildId   = interaction.guildId;
          const channelId = interaction.channelId;
          setTimeout(() => {
            const delivered = [];
            for (const t of targets) {
              if (canDrop(senderId, t.id, guildId)) {
                sendJson(userLinks.get(t.id).ws, payload);
                delivered.push(t.username);
                bumpStats(senderId, t.id);
              }
            }
            if (delivered.length) registerDropForReactions(payload, senderId, channelId);
            console.log(`[drop] delayed drop fired (${delivered.length}/${targets.length} delivered)`);
          }, Math.min(delayMin, 60) * 60_000);
          return safeReply(interaction,
            `⏳ Drop programmé dans **${Math.min(delayMin, 60)} min** pour ${targets.map(t => `**${t.username}**`).join(', ')}. 😈`);
        }

        return safeReply(interaction, dispatchToTargets(interaction, targets, payload, musicAtt));
      }

      // ── /dropall — only reachable users in this guild ──────────────────
      case 'dropall': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        {
          const remain = cooldownRemaining(lastDropAllAt, interaction.user.id, DROPALL_COOLDOWN_MS);
          if (remain > 0) {
            return safeReply(interaction, `⏱️ Doucement — encore ${formatCooldown(remain)}s avant le prochain \`/dropall\`.`);
          }
          markCooldown(lastDropAllAt, interaction.user.id);
        }

        const fileAtt  = interaction.options.getAttachment('media', false);
        const caption  = interaction.options.getString('caption', false);
        const musicAtt = interaction.options.getAttachment('musique', false);
        const rain     = extractEmojis(interaction.options.getString('pluie', false));
        const tts      = (interaction.options.getString('tts', false) || '').trim() || null;
        const effect   = interaction.options.getString('effet', false);

        if (fileAtt && interaction.options.getString('gif', false)) {
          return safeReply(interaction, '❌ Choisis soit `media` soit `gif`, pas les deux.');
        }
        const { att: gifAtt, error: gifError } = resolveGifOption(interaction);
        if (gifError) return safeReply(interaction, gifError);
        const att = fileAtt || gifAtt;

        if (!att && !rain && !tts) {
          return safeReply(interaction, '❌ Mets au moins un média (`media`/`gif`), un emoji (`pluie`) ou un texte (`tts`).');
        }

        if (att) {
          const err = validateAttachment(att);
          if (err) return safeReply(interaction, `❌ ${err}`);
        }

        const musicErr = validateMusic(musicAtt);
        if (musicErr) return safeReply(interaction, `❌ ${musicErr}`);

        if (musicAtt && !att) {
          return safeReply(interaction, '❌ L\'option `musique` nécessite un média (image ou GIF).');
        }
        if (musicAtt && att && !att.contentType.startsWith('image/')) {
          return safeReply(interaction, '❌ L\'option `musique` ne fonctionne qu\'avec une image ou un GIF (pas une vidéo).');
        }

        const recipients = [];
        for (const [userId, link] of userLinks) {
          if (link.ws.readyState !== link.ws.OPEN) continue;
          if (!canDrop(interaction.user.id, userId, interaction.guildId)) continue;
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) recipients.push({ userId, ws: link.ws, username: member.user.username });
        }
        if (recipients.length === 0) {
          return safeReply(interaction, 'Personne n\'est atteignable sur ce serveur pour l\'instant. 😴');
        }

        const payload = buildDropPayload(att, caption, interaction.user, musicAtt || null, rain, { tts, effect });
        const names = [];
        for (const r of recipients) {
          sendJson(r.ws, payload);
          names.push(r.username);
          bumpStats(interaction.user.id, r.userId);
        }
        registerDropForReactions(payload, interaction.user.id, interaction.channelId);
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
        await pushLinksUpdate(interaction.user.id);
        return interaction.reply({
          content: `🔇 **${target.username}** ne pourra plus t'envoyer de drops.`,
          flags: MessageFlags.Ephemeral,
        });
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
        await pushLinksUpdate(interaction.user.id);
        return interaction.reply({
          content: `🔊 **${target.username}** peut à nouveau t'envoyer des drops.`,
          flags: MessageFlags.Ephemeral,
        });
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
          `**Utilisateurs bloqués :**\n${blocked.map(b => `• ${b.username} (\`${b.id}\`)`).join('\n')}`);
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
            caption: caption ? String(caption).slice(0, 80) : null,
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
        markCooldown(lastDropAt, interaction.user.id);

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
        markCooldown(lastDropAt, interaction.user.id);

        const name = interaction.options.getString('name', true).trim();
        const userGroups = groups.get(interaction.user.id) || new Map();
        const groupKey = [...userGroups.keys()].find(k => k.toLowerCase() === name.toLowerCase());
        if (!groupKey) {
          return safeReply(interaction, `❌ Aucun groupe nommé **${name}**. Vois \`/group list\`.`);
        }

        const memberIds = userGroups.get(groupKey);
        const targets = [];
        for (const id of memberIds) {
          const u = await client.users.fetch(id).catch(() => null);
          if (u && !u.bot) targets.push(u);
        }
        if (targets.length === 0) {
          return safeReply(interaction, `❌ Aucun membre du groupe **${groupKey}** n'est joignable (utilisateurs introuvables).`);
        }

        const fileAtt  = interaction.options.getAttachment('media', false);
        const caption  = interaction.options.getString('caption', false);
        const musicAtt = interaction.options.getAttachment('musique', false);
        const rain     = extractEmojis(interaction.options.getString('pluie', false));
        const tts      = (interaction.options.getString('tts', false) || '').trim() || null;
        const effect   = interaction.options.getString('effet', false);

        if (fileAtt && interaction.options.getString('gif', false)) {
          return safeReply(interaction, '❌ Choisis soit `media` soit `gif`, pas les deux.');
        }
        const { att: gifAtt, error: gifError } = resolveGifOption(interaction);
        if (gifError) return safeReply(interaction, gifError);
        const att = fileAtt || gifAtt;

        if (!att && !rain && !tts) {
          return safeReply(interaction, '❌ Mets au moins un média (`media`/`gif`), un emoji (`pluie`) ou un texte (`tts`).');
        }
        if (att) {
          const err = validateAttachment(att);
          if (err) return safeReply(interaction, `❌ ${err}`);
        }
        const musicErr = validateMusic(musicAtt);
        if (musicErr) return safeReply(interaction, `❌ ${musicErr}`);
        if (musicAtt && !att) {
          return safeReply(interaction, '❌ L\'option `musique` nécessite un média (image ou GIF).');
        }
        if (musicAtt && att && !att.contentType.startsWith('image/')) {
          return safeReply(interaction, '❌ L\'option `musique` ne fonctionne qu\'avec une image ou un GIF (pas une vidéo).');
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
});

client.login(process.env.DISCORD_TOKEN);

process.on('SIGINT', () => {
  console.log('\n[bot] shutting down…');
  wss.clients.forEach(ws => ws.close());
  wss.close();
  httpServer.close();
  client.destroy().finally(() => process.exit(0));
});
process.on('SIGTERM', () => process.emit('SIGINT'));
