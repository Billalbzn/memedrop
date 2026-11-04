#!/usr/bin/env node
'use strict';
// MemeDrop bot behaviour-capture harness.
//
//   node run.js <bot-dir> <out.json> [--keep]
//
// Copies <bot-dir> (index.js, store.js, package.json, ...) to a private work
// dir, runs it in child processes with stand-ins for discord.js / ws / dotenv,
// drives it through a fixed scenario (slash commands, overlay WebSockets,
// HTTP, virtual time, restarts, signals) and writes a normalized, determin-
// istic JSON transcript of everything observable to <out.json>.
// Side files: <out.json>.log (bot stdout/stderr), <out.json>.metrics.json
// (wall-clock timings; not deterministic, not meant to be compared).
//
// Other tools in this directory:
//   node compare.js baseline.json out.json [--loose-acks] [--strict-counters]
//       readable per-step diff, exit 1 when observable behaviour differs
//   node view.js out.json [fromStep] [toStep]     compact human-readable dump
//   node selftest.js <bot-dir> baseline.json      checks the harness itself
//       (behaviour-preserving refactors must compare IDENTICAL, behaviour
//       mutations must be caught; patches target today's code)
//
// Layout: lib/preload.js runs inside the bot process (module redirection,
// virtual clock + long-timer control, Google TTS fetch mock, IPC);
// lib/fake-discord.js is the discord.js stand-in; lib/driver.js drives the
// bot (fake overlays, HTTP, interactions, settle logic); lib/scenario.js is
// the scenario; lib/normalize.js makes the transcript deterministic.
//
// The scenario is part of the contract: if it is edited, step ids shift and
// the baseline must be regenerated from the reference code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Harness, EPOCH, LINK_SECRET, WORLD } = require('./lib/driver');
const { normalize } = require('./lib/normalize');
const scenario = require('./lib/scenario');

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length !== 2) {
    console.error('usage: node run.js <bot-dir> <out.json> [--keep]');
    process.exit(2);
  }
  const [botDir, outPath] = pos;
  const t0 = Date.now();
  const h = new Harness({ botDir, outPath, keep });
  await h.init();

  let fatal = null;
  try {
    await scenario(h);
  } catch (e) {
    fatal = e;
    if (!h.cur) h.beginStep('(harness failure)');
    h.record('harness', `scenario error: ${e.message}`);
  }

  const knownTokens = new Map();
  for (const [name, u] of Object.entries(WORLD.USERS)) {
    knownTokens.set(crypto.createHmac('sha256', LINK_SECRET).update(u.id).digest('hex'), `<TOKEN hmac(${name})>`);
  }
  const steps = normalize(h.finalizeSteps(), {
    codes: h.norm.codes, dropIds: h.norm.dropIds, tokens: h.norm.tokens,
    knownTokens, fixed: h.norm.fixed, epoch: EPOCH,
  });

  const legend = {
    clock: `virtual wall clock; "T+<ms>" and step "t" are ms after ${new Date(EPOCH).toISOString()}`,
    users: Object.fromEntries(Object.entries(WORLD.USERS).map(([n, u]) => [u.id, n + (u.bot ? ' (bot)' : '') + (u.deleted ? ' (unknown to the API)' : '')])),
    self: WORLD.SELF.id,
    guilds: Object.fromEntries(Object.entries(WORLD.GUILDS).map(([k, g]) => [g.id, `${k} "${g.name}" members: ${g.members.join(', ')}`])),
    unknownGuild: WORLD.UNKNOWN_GUILD_ID,
    channels: Object.fromEntries(Object.entries(WORLD.CHANNELS).map(([k, c]) => [c.id, k])),
    placeholders: '<CODE@step#n> pairing codes, <DROP@step#n> drop ids, <TOKEN@step#n> random tokens, <TOKEN hmac(user)> = HMAC-SHA256(LINK_SECRET, user id); named after the step where the value first appears',
    channelsPerStep: 'ix = interaction calls per actor, ws.<overlay> = messages received by that fake overlay (_closed = close code), chan = messages posted in Discord channels, http, upstream = calls to Google TTS, discord = gateway-level actions, store = DATA_DIR content, exit = process exit',
  };

  const doc = {
    harness: { name: 'memedrop-bot-behaviour', version: 1 },
    legend,
    steps,
    summary: {
      processes: h.processes,
      upstreamCalls: h.upstream,
      stepCount: steps.length,
    },
    // Discord API usage of the fake client (cache hits vs API calls).
    // Informational: compare.js reports differences but does not fail on them.
    counters: h.counters,
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(`${outPath}.metrics.json`, `${JSON.stringify({
    wallMs: Date.now() - t0,
    processWallMs: h.timing.processes,
    steps: steps.length,
    upstreamCalls: h.upstream,
    discordApiCounters: h.counters,
  }, null, 2)}\n`);
  h.cleanup();
  console.log(`wrote ${outPath} (${steps.length} steps, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (fatal) {
    console.error(fatal);
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
