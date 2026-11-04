#!/usr/bin/env node
'use strict';
// Compare two transcripts produced by run.js.
//
//   node compare.js <a.json> <b.json> [--strict] [--max=N] [--quiet] [--only=a,b] [--t-tol=MS]
//
// Differences are classified:
//   FAIL  observable behaviour changed: what a renderer receives (per window,
//         per preload API), IPC results, WS frames/connection lifecycle seen
//         by the bot, windows created + window/tray/login-item/updater state,
//         shell/app/updater/shortcut calls, errors, final store file content.
//   WARN  needs a human look: window method call sequences (e.g. extra or
//         missing moveTop), duplicate state messages, cross-API ordering,
//         pending timers, unknown Electron APIs, store content before the
//         final idle/quit (persistence latency), extra files in userData.
//   INFO  expected to move with optimizations: disk-access counters, IPC
//         messages no renderer listens to, console output, counters.
// FAILs inside edge-case scenarios (inputs the shipped renderers/bot never
// send) are labelled [edge]; they still count as FAIL.
// When one side was produced with run.js --only (partial run), only the
// scenarios present on both sides are compared and the metrics table is
// skipped.
// Exit code: 0 = no FAIL (and no WARN with --strict), 1 = differences,
// 2 = usage error.
//
// Notes on the renderer-visible IPC comparison (section `ipc`):
//   - the IPC channel name is ignored (preload maps channels to APIs);
//   - for state-like APIs (onConnection, onHistory, onUpdateState) the
//     renderer only ever paints the last value of a virtual instant, so the
//     compared sequence is: last value per timestamp, then consecutive
//     duplicates removed. Differences in the raw sequence (intermediate
//     same-instant states, repeated identical messages) are WARN;
//   - everything else (onDrop, onSettingsUpdate, onCursor...) must match
//     message for message.
// Virtual timestamps (`t`) everywhere are compared with a tolerance of
// --t-tol=MS (default 50 ms, the harness defer window), so a deferral such
// as setTimeout(fn, 0) is not a difference; onCursor timestamps are exact
// (the poll rate is behaviour).

const fs = require('fs');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const maxArg = argv.find((a) => a.startsWith('--max='));
const MAX = maxArg ? Number(maxArg.split('=')[1]) : 60;
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length !== 2) {
  process.stderr.write('usage: node compare.js <a.json> <b.json> [--strict] [--max=N] [--quiet] [--only=a,b]\n');
  process.exit(2);
}
let A;
let B;
try {
  A = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  B = JSON.parse(fs.readFileSync(files[1], 'utf8'));
} catch (e) {
  process.stderr.write(`cannot read transcripts: ${e.message}\n`);
  process.exit(2);
}

const STATE_APIS = new Set(['onConnection', 'onHistory', 'onUpdateState']);
const STEP_SEVERITY = {
  result: 'FAIL', ipc: 'SPECIAL', unobserved: 'INFO', winCreated: 'FAIL', winCalls: 'WARN',
  net: 'FAIL', netErrors: 'FAIL', app: 'FAIL', tray: 'FAIL', trayChanges: 'FAIL', shell: 'FAIL', updater: 'FAIL', shortcut: 'FAIL',
  dialog: 'FAIL', notification: 'FAIL', lifecycle: 'FAIL', console: 'INFO', errors: 'FAIL', notes: 'WARN',
  unknownApi: 'WARN', orphans: 'WARN', state: 'FAIL', io: 'INFO', counters: 'INFO', timers: 'WARN',
  t: 'WARN', tEnd: 'WARN', metric: 'INFO', label: 'INFO',
};
const FINAL_SEVERITY = { storeAfterIdle: 'FAIL', storeAfterQuit: 'FAIL', storeNow: 'WARN', files: 'WARN', randomDraws: 'INFO' };
const SCENARIO_SEVERITY = { fatal: 'FAIL', skippedAfterExit: 'FAIL', trailingOrphans: 'WARN', ioTotal: 'INFO', timersFired: 'INFO', description: 'INFO' };

const tolArg = argv.find((a) => a.startsWith('--t-tol='));
const TOL = tolArg ? Number(tolArg.slice(8)) : 50;
let curTol = TOL;
// deep equality; numbers under a key named `t` may differ by <= curTol
function eqT(a, b, key) {
  if (a === b) return true;
  if (key === 't' && typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= curTol;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqT(a[i], b[i], null)) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !eqT(a[k], b[k], k)) return false;
    return true;
  }
  return false;
}
const eq = (a, b) => eqT(a, b, null);
const show = (v) => {
  if (v === undefined) return '(absent)';
  const s = JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
};

// Value diff with LCS alignment for arrays -> list of {path, a, b}.
function diff(a, b, path, out, limit = 12, key = null) {
  if (out.length >= limit || eqT(a, b, key)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = a.length; const m = b.length;
    const same = (i, j) => eqT(a[i], b[j], null);
    if (n * m > 250000) {
      for (let i = 0; i < Math.max(n, m) && out.length < limit; i++) diff(a[i], b[i], `${path}[${i}]`, out, limit);
      return;
    }
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = same(i, j) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    const rem = []; const add = [];
    const flush = () => {
      const k = Math.min(rem.length, add.length);
      for (let x = 0; x < k && out.length < limit; x++) diff(a[rem[x]], b[add[x]], `${path}[${rem[x]}${rem[x] === add[x] ? '' : `→${add[x]}`}]`, out, limit);
      for (let x = k; x < rem.length && out.length < limit; x++) out.push({ path: `${path}[${rem[x]}]`, a: a[rem[x]], b: undefined, kind: 'missing in B' });
      for (let x = k; x < add.length && out.length < limit; x++) out.push({ path: `${path}[${add[x]}]`, a: undefined, b: b[add[x]], kind: 'extra in B' });
      rem.length = 0; add.length = 0;
    };
    while (i < n || j < m) {
      if (i < n && j < m && same(i, j)) { flush(); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) add.push(j++);
      else rem.push(i++);
    }
    flush();
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diff(a[k], b[k], path ? `${path}.${k}` : k, out, limit, k);
    return;
  }
  out.push({ path, a, b });
}

const report = [];
const counts = { FAIL: 0, WARN: 0, INFO: 0 };
let edgeFails = 0;
let curEdge = false;
function add(sev, where, msg, details) {
  counts[sev]++;
  if (sev === 'FAIL' && curEdge) edgeFails++;
  report.push({ sev, where, msg, details, edge: curEdge });
}
function addDiffs(sev, where, a, b, what) {
  const d = [];
  diff(a, b, what, d);
  if (!d.length) return;
  add(sev, where, `${what} differs`, d);
}

// state APIs: last value per virtual instant, then drop consecutive repeats
function dedup(seq) {
  const perInstant = [];
  for (const e of seq) {
    if (perInstant.length && perInstant[perInstant.length - 1].t === e.t) perInstant[perInstant.length - 1] = e;
    else perInstant.push(e);
  }
  const out = [];
  for (const e of perInstant) if (!out.length || !eq(out[out.length - 1].payload, e.payload)) out.push(e);
  return out;
}

function compareIpc(where, a = {}, b = {}) {
  const wins = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const w of wins) {
    const ea = (a[w] || []).map(({ t, api, payload }) => ({ t, api, payload }));
    const eb = (b[w] || []).map(({ t, api, payload }) => ({ t, api, payload }));
    const apis = [...new Set([...ea.map((e) => e.api), ...eb.map((e) => e.api)])].sort();
    let anyFail = false;
    for (const api of apis) {
      const sa = ea.filter((e) => e.api === api).map(({ t, payload }) => ({ t, payload }));
      const sb = eb.filter((e) => e.api === api).map(({ t, payload }) => ({ t, payload }));
      curTol = api === 'onCursor' ? 0 : TOL;
      try {
        if (eq(sa, sb)) continue;
        if (STATE_APIS.has(api)) {
          const da = dedup(sa); const db = dedup(sb);
          if (!eq(da, db)) { anyFail = true; addDiffs('FAIL', where, da, db, `ipc.${w}.${api} (last value per instant)`); }
          else add('WARN', where, `ipc.${w}.${api}: same visible states, different intermediate/repeated messages (${sa.length} vs ${sb.length})`);
        } else {
          anyFail = true;
          addDiffs('FAIL', where, sa, sb, `ipc.${w}.${api}`);
        }
      } finally {
        curTol = TOL;
      }
    }
    if (!anyFail) {
      const oa = dedupApiOrder(ea); const ob = dedupApiOrder(eb);
      if (!eq(oa, ob)) addDiffs('WARN', where, oa, ob, `ipc.${w} (cross-API order)`);
    }
  }
}
// interleaving of event-like APIs within one window (state APIs excluded:
// their visible effect is order-independent and already compared above)
function dedupApiOrder(seq) {
  return seq.filter((e) => !STATE_APIS.has(e.api)).map((e) => e.api);
}

function compareStep(scn, sa, sb) {
  const where = `${scn} › ${sa ? sa.label : sb.label}`;
  const keys = [...new Set([...Object.keys(sa || {}), ...Object.keys(sb || {})])].sort();
  for (const k of keys) {
    if (k === 'label') continue;
    const va = sa[k]; const vb = sb[k];
    if (eq(va, vb)) continue;
    const sev = STEP_SEVERITY[k] || 'FAIL';
    if (sev === 'SPECIAL') { compareIpc(where, va, vb); continue; }
    if (k === 'io') { add('INFO', where, `disk access: ${ioText(va)} → ${ioText(vb)}`); continue; }
    if (k === 'unobserved') {
      add('INFO', where, `IPC messages nobody listens to: ${unobsText(va)} → ${unobsText(vb)}`);
      continue;
    }
    if (k === 'console' || k === 'counters') { addDiffs('INFO', where, va, vb, k); continue; }
    addDiffs(sev, where, va, vb, k);
  }
}
const ioText = (io) => (io ? `${io.read || 0}r/${io.write || 0}w (fsync ${io.fsync || 0}, mkdir ${io.mkdir || 0})` : '0r/0w');
function unobsText(u) {
  if (!u) return '0';
  return Object.entries(u).map(([w, arr]) => `${w}:${arr.length}`).join(' ');
}

function compareScenario(name, a, b) {
  if (!a || !b) { add('FAIL', name, `scenario only in ${a ? 'A' : 'B'}`); return; }
  for (const k of Object.keys(SCENARIO_SEVERITY)) {
    if (k === 'ioTotal') {
      if (!eq(a.ioTotal, b.ioTotal)) add('INFO', name, `scenario disk access: ${ioText(a.ioTotal)} → ${ioText(b.ioTotal)}`);
      continue;
    }
    if (!eq(a[k], b[k])) addDiffs(SCENARIO_SEVERITY[k], name, a[k], b[k], k);
  }
  const fa = a.final || {}; const fb = b.final || {};
  for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    if (!eq(fa[k], fb[k])) addDiffs(FINAL_SEVERITY[k] || 'FAIL', `${name} › final`, fa[k], fb[k], `final.${k}`);
  }
  const la = (a.steps || []).map((s) => s.label);
  const lb = (b.steps || []).map((s) => s.label);
  const mapB = new Map((b.steps || []).map((s) => [s.label, s]));
  const setA = new Set(la);
  for (const s of a.steps || []) {
    const sb = mapB.get(s.label);
    if (!sb) { add('FAIL', `${name} › ${s.label}`, 'step missing in B (behaviour created/removed a step, e.g. a window page load)'); continue; }
    compareStep(name, s, sb);
  }
  for (const l of lb) if (!setA.has(l)) add('FAIL', `${name} › ${l}`, 'step only in B');
  const common = la.filter((l) => mapB.has(l));
  const commonB = lb.filter((l) => setA.has(l));
  if (!eq(common, commonB)) add('FAIL', name, 'step order differs');
}

const partial = !!(A.partial || B.partial);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',').filter(Boolean)) : null;
let names = [...new Set([...Object.keys(A.scenarios || {}), ...Object.keys(B.scenarios || {})])];
if (partial) names = names.filter((n) => (A.scenarios || {})[n] && (B.scenarios || {})[n]);
if (only) names = names.filter((n) => only.has(n));
const perScenario = {};
for (const n of names) {
  const before = { ...counts };
  const sa = (A.scenarios || {})[n]; const sb = (B.scenarios || {})[n];
  curEdge = !!((sa && sa.edge) || (sb && sb.edge));
  compareScenario(n, sa, sb);
  perScenario[n] = { FAIL: counts.FAIL - before.FAIL, WARN: counts.WARN - before.WARN, INFO: counts.INFO - before.INFO };
}

// ---- output
const out = [];
let shown = 0;
for (const sev of ['FAIL', 'WARN', 'INFO']) {
  const items = report.filter((r) => r.sev === sev);
  if (!items.length) continue;
  if (flags.has('--quiet') && sev === 'INFO') continue;
  out.push(`\n=== ${sev} (${items.length}) ===`);
  for (const r of items) {
    if (shown >= MAX) { out.push(`… (${report.length - shown} more, use --max=N)`); break; }
    shown++;
    out.push(`[${sev}]${r.edge && sev === 'FAIL' ? '[edge]' : ''} ${r.where}: ${r.msg}`);
    for (const d of r.details || []) {
      const label = d.kind ? ` (${d.kind})` : '';
      out.push(`        ${d.path}${label}\n           A: ${show(d.a)}\n           B: ${show(d.b)}`);
    }
  }
}

// metrics table
const ma = (A.metrics && A.metrics.byMetric) || {};
const mb = (B.metrics && B.metrics.byMetric) || {};
const mk = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort();
if (partial || only) out.push('\n(partial comparison: metrics table skipped)');
else if (mk.length) {
  out.push('\n=== disk access per tagged step (A → B), reads/writes/fsync ===');
  for (const k of mk) {
    const x = ma[k] || { perSample: {} }; const y = mb[k] || { perSample: {} };
    const fmt = (m) => `${m.perSample.read || 0}/${m.perSample.write || 0}/${m.perSample.fsync || 0}`;
    const pm = (m) => (m.perMinute ? ` per-min ${m.perMinute.read || 0}/${m.perMinute.write || 0}` : '');
    out.push(`  ${k.padEnd(34)} ${fmt(x).padEnd(14)} → ${fmt(y).padEnd(14)}${pm(x)}${(x.perMinute || y.perMinute) ? ` →${pm(y).replace(' per-min', '')}` : ''}`);
  }
}

out.push('\n=== per scenario ===');
for (const n of names) {
  const c = perScenario[n];
  const tag = c.FAIL ? 'FAIL' : c.WARN ? 'WARN' : 'same';
  const edge = ((A.scenarios || {})[n] || {}).edge || ((B.scenarios || {})[n] || {}).edge;
  out.push(`  ${tag.padEnd(5)} ${n.padEnd(28)} fail=${c.FAIL} warn=${c.WARN} info=${c.INFO}${edge ? '  (edge-case scenario)' : ''}`);
}
const verdict = counts.FAIL ? 'BEHAVIOUR DIFFERS' : counts.WARN ? 'no behaviour difference (warnings to review)' : (counts.INFO ? 'IDENTICAL behaviour (metrics/info differ)' : 'IDENTICAL');
out.push(`\n${verdict}: ${counts.FAIL} FAIL${edgeFails ? ` (${edgeFails} in edge-case scenarios)` : ''}, ${counts.WARN} WARN, ${counts.INFO} INFO across ${names.length} scenarios`);
process.stdout.write(`${out.join('\n')}\n`);
process.exit(counts.FAIL || (flags.has('--strict') && counts.WARN) ? 1 : 0);
