#!/usr/bin/env node
'use strict';
// MemeDrop overlay — Electron MAIN PROCESS behaviour harness (no Electron).
//
//   node run.js <overlay-dir> <out.json> [--only=a,b,c] [--jobs=N] [--list]
//
// Runs <overlay-dir>/main.js (the package.json "main") and the windows'
// preload.js under plain Node 22 with stand-ins for electron,
// electron-store (conf@10 semantics, disk access counted), electron-updater
// and ws (real loopback WebSockets to a scripted fake bot). Every scenario
// runs in its own process, under a virtual clock, and is driven only through
// observable surfaces (bot frames, the window.memedrop renderer API, tray,
// OS events, time). The result is a normalized, deterministic JSON
// transcript: per-window renderer-visible IPC, WS frames seen by the bot,
// window/tray/app/updater/shell effects, store file content, disk-access
// counters per step, plus a metrics summary.
//
//   node compare.js <a.json> <b.json> [--strict] [--max=N]
//       categorized diff (FAIL = behaviour, WARN = review, INFO = metrics);
//       exit 1 if any FAIL (or WARN with --strict)
//   node view.js <out.json> <scenario> [fromStep] [toStep] [--state] [--io]
//       readable dump of one scenario
//   node selftest.js <overlay-dir> <baseline.json>
//       proves the harness: behaviour-preserving optimizations of today's
//       main.js compare without FAIL, behaviour mutations are caught
//
// Determinism: virtual clock (timers, Date, performance.now, seeded
// Math.random), TZ=UTC, per-scenario process, network settle based on
// frame/handshake bookkeeping, normalized ports/paths, sorted keys. One-shot
// timers <= 50 ms created during a step run before the step ends (defer
// window), and compare.js tolerates +-50 ms on virtual timestamps, so
// deferring work by a tick is not reported as a behaviour change.
//
// The scenario list (lib/scenarios.js) is part of the contract: step labels
// are the alignment keys, so editing a scenario requires regenerating the
// baseline from the reference code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { scenarios } = require('./lib/scenarios');
const { stableStringify } = require('./lib/canon');

const HERE = __dirname;

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write('usage: node run.js <overlay-dir> <out.json> [--only=a,b] [--jobs=N] [--list]\n');
  process.exit(2);
}

function runChild(appDir, name, workRoot) {
  return new Promise((resolve) => {
    const tmpOut = path.join(workRoot, `${name}.result.json`);
    const env = { ...process.env, TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
    delete env.NODE_OPTIONS;
    delete env.DEFAULT_SERVER;
    delete env.SNAP;
    const child = spawn(process.execPath, [path.join(HERE, 'lib', 'child.js'), appDir, name, tmpOut, workRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (d) => { stderr += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let result;
      try { result = JSON.parse(fs.readFileSync(tmpOut, 'utf8')); } catch (e) { result = { fatal: `no result (exit ${code})` }; }
      try { fs.rmSync(tmpOut, { force: true }); } catch {}
      resolve({ name, code, result, stderr });
    });
  });
}

function sumIo(steps, filter) {
  const tot = {};
  let n = 0;
  for (const s of steps) {
    if (!filter(s)) continue;
    n++;
    for (const [k, v] of Object.entries(s.io || {})) tot[k] = (tot[k] || 0) + v;
  }
  return { n, tot };
}

// Disk-access summary from the steps tagged with a `metric`.
function metrics(results) {
  const per = {};
  for (const [, sc] of Object.entries(results)) {
    for (const s of sc.steps || []) {
      if (!s.metric) continue;
      const m = (per[s.metric] = per[s.metric] || { samples: 0, io: {} });
      m.samples++;
      for (const [k, v] of Object.entries(s.io || {})) m.io[k] = (m.io[k] || 0) + v;
    }
  }
  const out = {};
  for (const [k, m] of Object.entries(per)) {
    const avg = {};
    for (const [kk, v] of Object.entries(m.io)) if (v) avg[kk] = Math.round((v / m.samples) * 100) / 100;
    out[k] = { samples: m.samples, perSample: avg };
  }
  // idle metrics are 10-minute windows -> per minute
  for (const k of Object.keys(out)) {
    const mm = /^idle-(\d+)min/.exec(k) || /-(\d+)min$/.exec(k);
    if (mm) {
      const mins = Number(mm[1]);
      const perMin = {};
      for (const [kk, v] of Object.entries(out[k].perSample)) perMin[kk] = Math.round((v / mins) * 100) / 100;
      out[k].perMinute = perMin;
    }
  }
  const totals = {};
  for (const [name, sc] of Object.entries(results)) totals[name] = sc.ioTotal || null;
  return { byMetric: out, ioTotalByScenario: totals };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const s of scenarios) process.stdout.write(`${s.name.padEnd(28)} ${s.desc}\n`);
    return;
  }
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length !== 2) usage();
  const appDir = path.resolve(pos[0]);
  const outPath = path.resolve(pos[1]);
  let pkgMain = 'index.js';
  try { pkgMain = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).main || 'index.js'; } catch { usage(`cannot read ${appDir}/package.json`); }
  if (!fs.existsSync(path.join(appDir, pkgMain))) usage(`missing ${path.join(appDir, pkgMain)}`);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',').filter(Boolean)) : null;
  const jobsArg = args.find((a) => a.startsWith('--jobs='));
  const jobs = Math.max(1, jobsArg ? Number(jobsArg.slice(7)) : Math.min(4, os.cpus().length || 1));
  const list = scenarios.filter((s) => !only || only.has(s.name));
  if (only) for (const n of only) if (!scenarios.some((s) => s.name === n)) usage(`unknown scenario ${n}`);

  const workRoot = fs.mkdtempSync(path.join(HERE, '.work-'));
  const t0 = Date.now();
  const results = {};
  const logs = [];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const sc = list[idx++];
      const r = await runChild(appDir, sc.name, workRoot);
      results[sc.name] = r.result;
      if (r.stderr.trim()) logs.push(`--- ${sc.name} (exit ${r.code})\n${r.stderr}`);
      const steps = (r.result.steps || []).length;
      const errs = (r.result.steps || []).reduce((n, s) => n + (s.errors ? s.errors.length : 0), 0);
      const io = r.result.ioTotal || {};
      process.stderr.write(`${r.result.fatal ? 'FATAL' : 'ok   '} ${sc.name.padEnd(28)} steps=${String(steps).padStart(3)} errors=${errs} reads=${io.read || 0} writes=${io.write || 0}${r.result.fatal ? `  (${r.result.fatal})` : ''}\n`);
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch {}

  const ordered = {};
  for (const s of list) ordered[s.name] = results[s.name];
  const out = {
    harness: 'memedrop-overlay-main-harness',
    format: 1,
    scenarios: ordered,
    metrics: metrics(ordered),
  };
  if (only) out.partial = true;
  fs.writeFileSync(outPath, `${stableStringify(out, 1)}\n`);
  fs.writeFileSync(`${outPath}.log`, logs.join('\n'));
  process.stderr.write(`wrote ${outPath} (${list.length} scenarios, ${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
