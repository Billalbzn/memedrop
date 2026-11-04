#!/usr/bin/env node
'use strict';
// Validates the harness itself against the CURRENT bot code (the edits below
// are text patches of today's index.js/store.js; they will stop applying once
// the code is refactored, which the script reports).
//
//   node selftest.js <bot-dir> <baseline.json> [--jobs=4] [--only=name,...] [--keep]
//   (--keep leaves each variant's patched code and transcript in .work/selftest/)
//
// "same" variants are behaviour-preserving refactors: the harness must report
// IDENTICAL (counters may differ). "diff" variants change behaviour: the
// harness must report DIFFERENT. "partial" variants are intended changes whose
// diff must be limited to the listed sections: a pattern matches a changed
// section by exact id ("summary"), by process prefix ("p5.") or by a
// substring of the step description ("x5 concurrently").

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
if (pos.length !== 2) { console.error('usage: node selftest.js <bot-dir> <baseline.json> [--jobs=4] [--only=a,b]'); process.exit(2); }
const [botDir, baseline] = pos.map((p) => path.resolve(p));
const jobs = Number((argv.find((a) => a.startsWith('--jobs=')) || '--jobs=4').split('=')[1]);
const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const keep = argv.includes('--keep');

const V = [];
const variant = (name, expect, edits, extraFiles = {}, steps = null) => V.push({ name, expect, edits, extraFiles, steps });

// ── behaviour-preserving refactors ──
variant('split-modules', 'same', [
  ['index.js', "const store = require('./store');", "const store = require('./store');\nconst { extractEmojis, classifyMedia } = require('./lib/media');\nconst startHeartbeat = require('./lib/heartbeat');"],
  ['index.js', 'function classifyMedia(mime) {', 'function classifyMediaUnused(mime) {'],
  ['index.js', 'function extractEmojis(str) {', 'function extractEmojisUnused(str) {'],
  ['index.js', "setInterval(() => {\n  wss.clients.forEach((ws) => {\n    if (ws.isAlive === false) {\n      console.log('[ws] terminating unresponsive overlay');\n      ws.terminate();\n      return;\n    }\n    ws.isAlive = false;\n    sendJson(ws, { type: 'ping' });\n  });\n}, 30_000);", 'startHeartbeat(wss, sendJson);'],
], {
  'lib/media.js': "'use strict';\nfunction classifyMedia(mime) {\n  if (mime.startsWith('audio/')) return 'audio';\n  if (mime.startsWith('video/')) return 'video';\n  if (mime === 'image/gif') return 'gif';\n  return 'image';\n}\nfunction extractEmojis(str) {\n  if (!str) return null;\n  const m = String(str).match(/\\p{Extended_Pictographic}/gu);\n  if (!m) return null;\n  const u = [...new Set(m)].slice(0, 5);\n  return u.length ? u : null;\n}\nmodule.exports = { classifyMedia, extractEmojis };\n",
  'lib/heartbeat.js': "'use strict';\nmodule.exports = function startHeartbeat(wss, sendJson) {\n  return setInterval(() => {\n    for (const ws of wss.clients) {\n      if (ws.isAlive === false) { ws.terminate(); continue; }\n      ws.isAlive = false;\n      sendJson(ws, { type: 'ping' });\n    }\n  }, 30_000);\n};\n",
});
variant('who-promise-all', 'same', [
  ['index.js', "        for (const [userId, link] of userLinks) {\n          if (link.ws.readyState !== link.ws.OPEN) continue;\n          if (!canDrop(interaction.user.id, userId, guildId)) continue;\n          // Filter to actual members of this guild\n          const member = await interaction.guild?.members.fetch(userId).catch(() => null);\n          if (member) list.push(`• <@${userId}>`);\n        }",
    "        const cands = [...userLinks].filter(([userId, link]) => link.ws.readyState === link.ws.OPEN && canDrop(interaction.user.id, userId, guildId)).map(([userId]) => userId);\n        const members = await Promise.all(cands.map((id) => interaction.guild?.members.fetch(id).catch(() => null)));\n        cands.forEach((userId, i) => { if (members[i]) list.push(`• <@${userId}>`); });"],
]);
variant('dropall-batch-fetch', 'same', [
  ['index.js', "        const recipients = [];\n        for (const [userId, link] of userLinks) {\n          if (link.ws.readyState !== link.ws.OPEN) continue;\n          if (!canDrop(interaction.user.id, userId, interaction.guildId)) continue;\n          const member = await interaction.guild?.members.fetch(userId).catch(() => null);\n          if (member) recipients.push({ userId, ws: link.ws, username: member.user.username });\n        }",
    "        const recipients = [];\n        const cands = [...userLinks].filter(([userId, link]) => link.ws.readyState === link.ws.OPEN && canDrop(interaction.user.id, userId, interaction.guildId));\n        const fetched = cands.length && interaction.guild ? await interaction.guild.members.fetch({ user: cands.map(([id]) => id) }).catch(() => null) : null;\n        for (const [userId, link] of cands) {\n          const member = fetched?.get(userId);\n          if (member) recipients.push({ userId, ws: link.ws, username: member.user.username });\n        }"],
]);
variant('users-cache-first', 'same', [
  ['index.js', 'try { reactorName = (await client.users.fetch(meta.userId)).username; } catch {}', 'try { reactorName = (client.users.cache.get(meta.userId) ?? await client.users.fetch(meta.userId)).username; } catch {}'],
]);
variant('delayed-drop-timers-promises', 'same', [
  ['index.js', "          setTimeout(() => {\n            payload.ts = Date.now();", "          require('timers/promises').setTimeout(minutes * 60_000).then(() => {\n            payload.ts = Date.now();"],
  ['index.js', "          }, minutes * 60_000);\n          return safeReply(interaction,", "          });\n          return safeReply(interaction,"],
]);
variant('ephemeral-boolean', 'same', [
  ['index.js', "      await interaction.reply({ content, flags: MessageFlags.Ephemeral });", "      await interaction.reply({ content, ephemeral: true });"],
]);

// ── intended change with a targeted diff ──
variant('tts-inflight-dedup', 'partial', [
  ['index.js', 'const ttsCache = new Map();', 'const ttsCache = new Map();\nconst ttsInflight = new Map();'],
  ['index.js', "  const ip = String(req.headers['x-forwarded-for']", "  const inflight = ttsInflight.get(cacheKey);\n  if (inflight) {\n    const b = await inflight.catch(() => null);\n    if (b) sendTtsAudio(res, b); else { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('tts failed'); }\n    return;\n  }\n  const ip = String(req.headers['x-forwarded-for']"],
  ['index.js', "    const g = await fetch(\n      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +\n      `&tl=${lang}&q=${encodeURIComponent(text)}`,\n      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },\n    );\n    if (!g.ok) throw new Error(`upstream ${g.status}`);\n    const buf = Buffer.from(await g.arrayBuffer());",
    "    const p = (async () => {\n      const g = await fetch(\n        'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +\n        `&tl=${lang}&q=${encodeURIComponent(text)}`,\n        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },\n      );\n      if (!g.ok) throw new Error(`upstream ${g.status}`);\n      return Buffer.from(await g.arrayBuffer());\n    })();\n    ttsInflight.set(cacheKey, p);\n    p.catch(() => {}).finally(() => ttsInflight.delete(cacheKey));\n    const buf = await p;"],
], {}, ['x5 concurrently', 'summary']);
variant('await-interaction-replies', 'partial', [
  ['index.js', 'return interaction.reply(', 'return await interaction.reply(', { all: true }],
], {}, ['p6.', 'summary']);
variant('url-crash-fix', 'partial', [
  ['index.js', "  const u = new URL(req.url, 'http://localhost');", "  let u;\n  try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }"],
], {}, ['p5.', 'summary']);

// ── behaviour changes that must be caught ──
variant('cooldown-2500', 'diff', [['index.js', 'const DROP_COOLDOWN_MS    = 2_000;', 'const DROP_COOLDOWN_MS    = 2_500;']]);
variant('tts-cache-49', 'diff', [['index.js', 'const TTS_CACHE_MAX      = 50;', 'const TTS_CACHE_MAX      = 49;']]);
variant('caption-no-truncate', 'diff', [['index.js', "    caption: caption ? String(caption).slice(0, 80) : null,\n    from: {", "    caption: caption ? String(caption) : null,\n    from: {"]]);
variant('store-debounce-5s', 'diff', [['store.js', 'saveTimer = setTimeout(flush, 500);', 'saveTimer = setTimeout(flush, 5000);']]);
variant('heartbeat-25s', 'diff', [['index.js', '}, 30_000);', '}, 25_000);']]);
variant('no-sigterm-handler', 'diff', [['index.js', "process.on('SIGTERM', () => process.emit('SIGINT'));", '']]);
variant('multi-reactions', 'diff', [['index.js', '      if (entry.reacted.has(meta.userId)) return;   // une réaction max par drop', '']]);
variant('no-extension-code-on-register', 'diff', [['index.js', "      issueExtensionCode(ws, userId);\n      console.log(`[ws] auto-registered", "      console.log(`[ws] auto-registered"]]);
variant('token-derivation-v2', 'diff', [['index.js', '.update(String(userId))', '.update(`v2:${userId}`)']]);

function prepare(v, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(botDir, dir, { recursive: true, filter: (src) => !/node_modules|[\\/]data$|\.env$/.test(src) });
  for (const [file, find, repl, opts = {}] of v.edits) {
    const p = path.join(dir, file);
    const src = fs.readFileSync(p, 'utf8');
    const n = src.split(find).length - 1;
    if (opts.all ? n < 1 : n !== 1) throw new Error(`${v.name}: patch for ${file} matches ${n} times (code changed?)`);
    fs.writeFileSync(p, opts.all ? src.split(find).join(repl) : src.replace(find, () => repl));
  }
  for (const [file, content] of Object.entries(v.extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: HERE });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function check(v) {
  const root = path.join(HERE, '.work', 'selftest');
  const dir = path.join(root, v.name, 'bot');
  const out = path.join(root, v.name, 'out.json');
  try { prepare(v, dir); } catch (e) { return { v, ok: false, detail: e.message }; }
  const r = await run(process.execPath, [path.join(HERE, 'run.js'), dir, out]);
  if (r.code !== 0) return { v, ok: false, detail: `run.js failed (${r.code}): ${r.out.slice(-300)}` };
  const c = await run(process.execPath, [path.join(HERE, 'compare.js'), baseline, out, '--max=2000']);
  const changedFull = [...c.out.matchAll(/^■ (\S+) {2}(.*)$/gm)].map((m) => ({ id: m[1], ctx: m[2] }));
  const changed = changedFull.map((x) => x.id);
  const allowed = (x) => (v.steps || []).some((p) => x.id === p || (p.endsWith('.') && x.id.startsWith(p)) || x.ctx.includes(p));
  let ok;
  if (v.expect === 'same') ok = c.code === 0;
  else if (v.expect === 'diff') ok = c.code === 1;
  else ok = c.code === 1 && changedFull.every(allowed);
  if (!keep) fs.rmSync(path.join(root, v.name), { recursive: true, force: true });
  const detail = c.code === 0 ? 'IDENTICAL' : `DIFFERENT in ${changed.length} step(s): ${changed.slice(0, 8).join(' ')}${changed.length > 8 ? ' …' : ''}`;
  return { v, ok, detail };
}

(async () => {
  const todo = V.filter((v) => !only || only.split(',').includes(v.name));
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (i < todo.length) {
      const v = todo[i++];
      const r = await check(v);
      results.push(r);
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${v.name.padEnd(30)} expect=${v.expect.padEnd(7)} ${r.detail}`);
    }
  }));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} self-test variants behaved as expected.`);
  process.exit(failed.length ? 1 : 0);
})();
