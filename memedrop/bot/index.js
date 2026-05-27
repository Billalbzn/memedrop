// index.js — MemeDrop bot
// Owns the Discord side AND a WebSocket server that overlay clients connect to.
require('dotenv').config();

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server
//
// Why HTTP wrapping the WS server?
//   1) Railway / most PaaS only give us ONE port (process.env.PORT) and that
//      port must speak HTTP for healthchecks. We multiplex WS upgrades on it.
//   2) A simple GET / returns 200 so the platform sees the service as healthy.
// ─────────────────────────────────────────────────────────────────────────────
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

// pairingCode (string) -> ws (waiting for /link)
const pendingOverlays = new Map();
// discordUserId -> ws (linked & active)
const linkedOverlays = new Map();
// ws -> { code, userId, guildIds:Set }
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

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) sendJson(ws, { type: 'ping' });
  });
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`[http+ws] listening on port ${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Discord client
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
});

const ACCEPTED_MIME = /^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|quicktime))$/i;
const MAX_BYTES = 25 * 1024 * 1024;

// Lightweight rate limit: max 1 drop / 2s per sender
const lastDropAt = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const prev = lastDropAt.get(userId) || 0;
  if (now - prev < 2000) return true;
  lastDropAt.set(userId, now);
  return false;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      // ── /link ───────────────────────────────────────────────────────────
      case 'link': {
        const code = interaction.options.getString('code', true);
        const ws = pendingOverlays.get(code);
        if (!ws) {
          return interaction.reply({
            content: '❌ Invalid or expired code. Open the overlay and try again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const previous = linkedOverlays.get(interaction.user.id);
        if (previous && previous !== ws) {
          sendJson(previous, { type: 'unlinked', reason: 'replaced' });
          previous.close();
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

      // ── /unlink ─────────────────────────────────────────────────────────
      case 'unlink': {
        const ws = linkedOverlays.get(interaction.user.id);
        if (!ws) {
          return interaction.reply({
            content: 'You have no linked overlay.',
            flags: MessageFlags.Ephemeral,
          });
        }
        sendJson(ws, { type: 'unlinked', reason: 'user' });
        linkedOverlays.delete(interaction.user.id);
        return interaction.reply({
          content: '✅ Unlinked.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /status ─────────────────────────────────────────────────────────
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

      // ── /who ────────────────────────────────────────────────────────────
      case 'who': {
        if (linkedOverlays.size === 0) {
          return interaction.reply({
            content: 'Nobody has a linked overlay right now. 😴',
            flags: MessageFlags.Ephemeral,
          });
        }
        const list = [];
        for (const [userId, ws] of linkedOverlays) {
          if (ws.readyState !== ws.OPEN) continue;
          // Only show users that share at least one guild with the requester
          try {
            const member = await interaction.guild?.members.fetch(userId).catch(() => null);
            if (member) list.push(`• <@${userId}>`);
          } catch {}
        }
        return interaction.reply({
          content: list.length
            ? `**Potential drop targets in this server:**\n${list.join('\n')}`
            : 'No drop targets in this server right now. 😴',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /drop ───────────────────────────────────────────────────────────
      case 'drop': {
        const target = interaction.options.getUser('target', true);
        const att = interaction.options.getAttachment('media', true);

        if (target.bot) {
          return interaction.reply({
            content: '🤖 Bots don\'t have screens to drop memes on.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (rateLimited(interaction.user.id)) {
          return interaction.reply({
            content: '⏱️ Slow down — one drop every 2 seconds.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const ws = linkedOverlays.get(target.id);
        if (!ws || ws.readyState !== ws.OPEN) {
          return interaction.reply({
            content: `❌ **${target.username}** has no linked overlay running. Tell them to launch MemeDrop and \`/link\`.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (att.size > MAX_BYTES) {
          return interaction.reply({
            content: `❌ File too large (${(att.size / 1024 / 1024).toFixed(1)} MB). Limit is 25 MB.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        if (!att.contentType || !ACCEPTED_MIME.test(att.contentType)) {
          return interaction.reply({
            content: `❌ Unsupported type: \`${att.contentType || 'unknown'}\`. Use PNG / JPG / GIF / WEBP / MP4 / WEBM.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const kind = att.contentType.startsWith('video/') ? 'video'
                   : att.contentType === 'image/gif'      ? 'gif'
                   : 'image';

        sendJson(ws, {
          type: 'drop',
          media: {
            url: att.url,
            kind,
            mime: att.contentType,
            name: att.name,
            size: att.size,
            width: att.width || null,
            height: att.height || null,
          },
          from: {
            id: interaction.user.id,
            username: interaction.user.username,
          },
          ts: Date.now(),
        });

        return interaction.reply({
          content: `✅ Dropped on **${target.username}**!`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (err) {
    console.error('[bot] interaction error:', err);
    if (!interaction.replied) {
      try {
        await interaction.reply({
          content: '⚠️ Internal error. Try again.',
          flags: MessageFlags.Ephemeral,
        });
      } catch {}
    }
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
