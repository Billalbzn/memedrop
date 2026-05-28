// index.js — MemeDrop bot
require('dotenv').config();

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.env.WS_PORT || 8765);

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MemeDrop bot online');
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

function generatePairingCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  } while (pendingOverlays.has(code));
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

// Can a user, viewed from a given guild, be targeted by /drop here?
function isReachable(userId, fromGuildId) {
  const link = userLinks.get(userId);
  if (!link || link.ws.readyState !== link.ws.OPEN) return false;
  if (link.scope === 'global') return true;
  return link.guildIds.has(fromGuildId);
}

// Build the guild-list payload sent to overlays — they use it to render the
// "Linked servers" toggle panel.
function buildLinksSnapshot(userId) {
  const link = userLinks.get(userId);
  if (!link) return { scope: 'none', guilds: [] };
  if (link.scope === 'global') return { scope: 'global', guilds: [] };
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
  return { scope: 'guild', guilds };
}

function pushLinksUpdate(userId) {
  const link = userLinks.get(userId);
  if (!link) return;
  sendJson(link.ws, {
    type: 'links_update',
    links: buildLinksSnapshot(userId),
  });
}

wss.on('connection', (ws) => {
  const code = generatePairingCode();
  pendingOverlays.set(code, ws);
  wsMeta.set(ws, { code, userId: null });

  sendJson(ws, { type: 'pairing_code', code });
  console.log(`[ws] overlay connected, pairing code = ${code}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'pong') return;

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
        pushLinksUpdate(meta.userId);
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

const lastDropAt = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const prev = lastDropAt.get(userId) || 0;
  if (now - prev < 2000) return true;
  lastDropAt.set(userId, now);
  return false;
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

function buildDropPayload(att, caption, fromUser) {
  return {
    type: 'drop',
    media: {
      url: att.url,
      kind: classifyMedia(att.contentType),
      mime: att.contentType,
      name: att.name,
      size: att.size,
      width: att.width || null,
      height: att.height || null,
    },
    caption: caption ? String(caption).slice(0, 80) : null,
    from: {
      id: fromUser.id,
      username: fromUser.username,
      avatar: fromUser.displayAvatarURL({ size: 128, extension: 'png' }),
    },
    ts: Date.now(),
  };
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
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      // ── /link — now per-guild ──────────────────────────────────────────
      case 'link': {
        const code = interaction.options.getString('code', true);
        const ws = pendingOverlays.get(code);

        // If already linked: this /link in a new guild ADDS that guild to
        // the set (or upgrades a global link's display, but global stays global
        // until the user explicitly unlinks).
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
          const link = {
            ws,
            scope: 'guild',
            guildIds: new Set(interaction.guildId ? [interaction.guildId] : []),
          };
          userLinks.set(interaction.user.id, link);
          wsMeta.set(ws, { code: null, userId: interaction.user.id });
          sendJson(ws, {
            type: 'linked',
            user: { id: interaction.user.id, username: interaction.user.username },
            links: buildLinksSnapshot(interaction.user.id),
          });
          return interaction.reply({
            content: `✅ Linked on **${interaction.guild?.name || 'this server'}**. To be reachable from other servers, run \`/link\` there too.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Code didn't match a pending overlay — maybe the user is already linked
        // and is trying to add this guild to their existing link? That's the
        // case if the code is also blank/expired and they have an active link.
        if (!existing) {
          return interaction.reply({
            content: '❌ Invalid or expired code. Open the overlay (it shows a fresh code) and try again.',
            flags: MessageFlags.Ephemeral,
          });
        }
        // Shouldn't typically happen: the existing link still uses a valid code.
        // Fall through to "invalid code" message.
        return interaction.reply({
          content: '❌ Invalid or expired code. Open the overlay and try again.',
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
          if (!isReachable(userId, guildId)) continue;
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

        if (rateLimited(interaction.user.id)) {
          return safeReply(interaction, '⏱️ Slow down — one drop every 2 seconds.');
        }

        const targets = [];
        const seen = new Set();
        for (const optName of ['target', 'target2', 'target3', 'target4', 'target5']) {
          const u = interaction.options.getUser(optName, optName === 'target');
          if (!u || u.bot || seen.has(u.id)) continue;
          seen.add(u.id);
          targets.push(u);
        }
        if (targets.length === 0) {
          return safeReply(interaction, '🤖 No valid targets (bots and duplicates filtered out).');
        }

        const att = interaction.options.getAttachment('media', true);
        const caption = interaction.options.getString('caption', false);
        const err = validateAttachment(att);
        if (err) return safeReply(interaction, `❌ ${err}`);

        const payload = buildDropPayload(att, caption, interaction.user);
        const delivered = [];
        const notReachable = [];

        for (const t of targets) {
          if (isReachable(t.id, interaction.guildId)) {
            sendJson(userLinks.get(t.id).ws, payload);
            delivered.push(t.username);
          } else {
            notReachable.push(t.username);
          }
        }

        let msg;
        if (delivered.length && notReachable.length) {
          msg = `✅ Dropped on **${delivered.join('**, **')}**.\n⚠️ Not reachable from this server: ${notReachable.map(o => `**${o}**`).join(', ')}`;
        } else if (delivered.length) {
          msg = `✅ Dropped on **${delivered.join('**, **')}**!`;
        } else {
          msg = `❌ Nobody was reachable from this server. They need to \`/link\` here too, or check their overlay's server toggles.`;
        }
        return safeReply(interaction, msg);
      }

      // ── /dropall — only reachable users in this guild ──────────────────
      case 'dropall': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (rateLimited(interaction.user.id)) {
          return safeReply(interaction, '⏱️ Slow down — one drop every 2 seconds.');
        }

        const att = interaction.options.getAttachment('media', true);
        const caption = interaction.options.getString('caption', false);
        const err = validateAttachment(att);
        if (err) return safeReply(interaction, `❌ ${err}`);

        const recipients = [];
        for (const [userId, link] of userLinks) {
          if (link.ws.readyState !== link.ws.OPEN) continue;
          if (!isReachable(userId, interaction.guildId)) continue;
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) recipients.push({ userId, ws: link.ws, username: member.user.username });
        }
        if (recipients.length === 0) {
          return safeReply(interaction, 'Nobody is reachable from this server right now. 😴');
        }

        const payload = buildDropPayload(att, caption, interaction.user);
        const names = [];
        for (const r of recipients) {
          sendJson(r.ws, payload);
          names.push(r.username);
        }
        return safeReply(interaction,
          `💥 Dropped on **${names.length}** people: ${names.map(n => `**${n}**`).join(', ')}`);
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
