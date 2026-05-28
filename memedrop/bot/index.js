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

const pendingOverlays = new Map();
const linkedOverlays = new Map();
const wsMeta = new WeakMap();

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
  });

  ws.on('close', () => {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    if (meta.code) pendingOverlays.delete(meta.code);
    if (meta.userId && linkedOverlays.get(meta.userId) === ws) {
      linkedOverlays.delete(meta.userId);
    }
    console.log(`[ws] overlay disconnected (user=${meta.userId || 'unlinked'})`);
  });

  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

// Heartbeat — also drops dead sockets so /drop never targets a zombie
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

const ACCEPTED_MIME = /^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|quicktime))$/i;
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
    return `Unsupported type: \`${att.contentType || 'unknown'}\`. Use PNG / JPG / GIF / WEBP / MP4 / WEBM.`;
  }
  return null;
}

function classifyMedia(mime) {
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
    from: { id: fromUser.id, username: fromUser.username },
    ts: Date.now(),
  };
}

// Safe reply helper: works whether or not we've deferred.
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
      // ── /link — must be FAST (no awaits before reply) so it never times out
      case 'link': {
        const code = interaction.options.getString('code', true);
        const ws = pendingOverlays.get(code);
        if (!ws) {
          return interaction.reply({
            content: '❌ Invalid or expired code. Open the overlay (it shows a fresh code) and try again.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const previous = linkedOverlays.get(interaction.user.id);
        if (previous && previous !== ws) {
          sendJson(previous, { type: 'unlinked', reason: 'replaced' });
          linkedOverlays.delete(interaction.user.id);
          reissuePairingCode(previous);
        }
        pendingOverlays.delete(code);
        linkedOverlays.set(interaction.user.id, ws);
        wsMeta.set(ws, { code: null, userId: interaction.user.id });
        sendJson(ws, {
          type: 'linked',
          user: { id: interaction.user.id, username: interaction.user.username },
        });
        return interaction.reply({
          content: `✅ Linked! Your friends can now drop memes on you with \`/drop target:@${interaction.user.username}\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      case 'unlink': {
        const ws = linkedOverlays.get(interaction.user.id);
        if (!ws) {
          return interaction.reply({
            content: 'You have no linked overlay.',
            flags: MessageFlags.Ephemeral,
          });
        }
        linkedOverlays.delete(interaction.user.id);
        sendJson(ws, { type: 'unlinked', reason: 'user' });
        reissuePairingCode(ws);
        return interaction.reply({
          content: '✅ Unlinked. Your overlay is back to "awaiting link" with a new code.',
          flags: MessageFlags.Ephemeral,
        });
      }

      case 'status': {
        const ws = linkedOverlays.get(interaction.user.id);
        const connected = ws && ws.readyState === ws.OPEN;
        return interaction.reply({
          content: connected
            ? '🟢 Your overlay is linked and connected.'
            : '🔴 No overlay linked. Launch the app and use `/link <code>`.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /who — does guild member fetches, so DEFER first (anti-timeout)
      case 'who': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (linkedOverlays.size === 0) {
          return safeReply(interaction, 'Nobody has a linked overlay right now. 😴');
        }
        const list = [];
        for (const [userId, ws] of linkedOverlays) {
          if (ws.readyState !== ws.OPEN) continue;
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) list.push(`• <@${userId}>`);
        }
        return safeReply(interaction,
          list.length
            ? `**Potential drop targets in this server:**\n${list.join('\n')}`
            : 'No drop targets in this server right now. 😴');
      }

      // ── /drop — DEFER first (fetches/validation can exceed 3s under load)
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
        const offline = [];
        for (const t of targets) {
          const ws = linkedOverlays.get(t.id);
          if (ws && ws.readyState === ws.OPEN) {
            sendJson(ws, payload);
            delivered.push(t.username);
          } else {
            offline.push(t.username);
          }
        }

        let msg;
        if (delivered.length && offline.length) {
          msg = `✅ Dropped on **${delivered.join('**, **')}**.\n⚠️ Offline (skipped): ${offline.map(o => `**${o}**`).join(', ')}`;
        } else if (delivered.length) {
          msg = `✅ Dropped on **${delivered.join('**, **')}**!`;
        } else {
          msg = `❌ Nobody received it — none of them have a linked overlay running. They need to open MemeDrop and \`/link\`.`;
        }
        return safeReply(interaction, msg);
      }

      // ── /dropall — DEFER first (iterates guild members)
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
        for (const [userId, ws] of linkedOverlays) {
          if (ws.readyState !== ws.OPEN) continue;
          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (member) recipients.push({ userId, ws, username: member.user.username });
        }
        if (recipients.length === 0) {
          return safeReply(interaction, 'Nobody in this server has a linked overlay right now. 😴');
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
