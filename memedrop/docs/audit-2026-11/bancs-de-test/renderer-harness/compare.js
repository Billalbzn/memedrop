#!/usr/bin/env node
'use strict';
// Compare two harness output directories.
//
//   node compare.js <dirA> <dirB> [--show-soft] [--max=40] [--threshold=10] [--all-metrics]
//
// Behaviour: deep diff of behavior.json and behavior-android.json, step by
// step. Differences are classified as
//   HARD — anything observable (DOM structure/classes/inline styles/sizes,
//          bridge calls and their timing, speech, media, rect reports, …)
//   soft — values derived from Math.random (keys prefixed with "~": drop
//          positions, rain particle mix), or bridge calls emitted at the same
//          fake millisecond in a different order.
// Exit code 1 when there is at least one HARD difference.
//
// Performance: table of medians (A → B) per perf scenario for the key metrics
// (CPU per process, main-thread task/script/style/layout, compositor frames
// and per-frame cost, paint/raster, rAF); --all-metrics shows everything.
// In software compositing the GPU process is often saturated (~1 core):
// then an improvement shows as more frames / lower trace.vizPerFrame_ms
// rather than lower cpu.gpu_ms.
// Δ% beyond ±threshold (default 10 %) is flagged (only informative: real-time
// numbers are noisy, re-run when in doubt).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
if (pos.length < 2) {
  console.error('usage: node compare.js <dirA> <dirB> [--show-soft] [--max=40] [--threshold=10] [--all-metrics]');
  process.exit(2);
}
const [dirA, dirB] = pos.map((p) => path.resolve(p));
const MAX = Number(opt.max || 40);
const THRESH = Number(opt.threshold || 10);

function load(dir, f) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const short = (v) => {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
};

// Deep diff → [{ path, a, b, soft }]
function diff(a, b, p, soft, out) {
  if (a === b) return out;
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || a === null || b === null || ta !== 'object' && ta !== 'array') {
    out.push({ path: p, a, b, soft });
    return out;
  }
  if (ta === 'array') {
    // bridge calls: same multiset at the same timestamps, different order → soft
    if (/\.bridge$/.test(p) && a.length === b.length && JSON.stringify(a) !== JSON.stringify(b)) {
      const key = (x) => JSON.stringify(x);
      const sa = a.map(key).sort().join('\n');
      const sb = b.map(key).sort().join('\n');
      if (sa === sb) { out.push({ path: p, a, b, soft: true, note: 'same calls, different order' }); return out; }
    }
    const n = Math.max(a.length, b.length);
    if (a.length !== b.length) out.push({ path: `${p}.length`, a: a.length, b: b.length, soft });
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) continue;
      diff(a[i], b[i], `${p}[${i}]`, soft, out);
    }
    return out;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const s = soft || k.startsWith('~');
    if (!(k in a)) out.push({ path: `${p}.${k}`, a: undefined, b: b[k], soft: s });
    else if (!(k in b)) out.push({ path: `${p}.${k}`, a: a[k], b: undefined, soft: s });
    else diff(a[k], b[k], `${p}.${k}`, s, out);
  }
  return out;
}

let hardTotal = 0;
function compareBehaviour(file) {
  const A = load(dirA, file);
  const B = load(dirB, file);
  console.log(`\n━━ ${file}`);
  if (!A || !B) {
    console.log(`  (missing in ${!A ? dirA : dirB}) — skipped`);
    return;
  }
  const metaDiff = diff(A.meta, B.meta, 'meta', false, []);
  for (const d of metaDiff) console.log(`  meta ${d.path}: ${short(d.a)} → ${short(d.b)}`);
  const names = [...new Set([...Object.keys(A.scenarios), ...Object.keys(B.scenarios)])];
  let same = 0;
  for (const name of names) {
    const sa = A.scenarios[name];
    const sb = B.scenarios[name];
    if (!sa || !sb) {
      console.log(`  ✗ ${name}: only in ${sa ? 'A' : 'B'}`);
      hardTotal++;
      continue;
    }
    const out = [];
    if ((sa.error || null) !== (sb.error || null)) out.push({ path: 'error', a: sa.error, b: sb.error, soft: false });
    const n = Math.max(sa.steps.length, sb.steps.length);
    if (sa.steps.length !== sb.steps.length) out.push({ path: 'steps.length', a: sa.steps.length, b: sb.steps.length, soft: false });
    for (let i = 0; i < n; i++) {
      const x = sa.steps[i], y = sb.steps[i];
      if (!x || !y) continue;
      const label = `#${i} "${x.step}"${x.step !== y.step ? ` / "${y.step}"` : ''}`;
      diff(x, y, label, false, out);
    }
    const hard = out.filter((d) => !d.soft);
    const soft = out.filter((d) => d.soft);
    if (!hard.length && !soft.length) { same++; continue; }
    hardTotal += hard.length;
    console.log(`  ${hard.length ? '✗' : '~'} ${name}: ${hard.length} hard, ${soft.length} soft difference(s)`);
    for (const d of hard.slice(0, MAX)) console.log(`      HARD ${d.path}\n           A: ${short(d.a)}\n           B: ${short(d.b)}`);
    if (hard.length > MAX) console.log(`      … ${hard.length - MAX} more hard differences`);
    if (opt['show-soft']) for (const d of soft.slice(0, MAX)) console.log(`      soft ${d.path}${d.note ? ' (' + d.note + ')' : ''}\n           A: ${short(d.a)}\n           B: ${short(d.b)}`);
  }
  console.log(`  ${same}/${names.length} scenarios identical`);
}

function comparePerf() {
  const A = load(dirA, 'perf.json');
  const B = load(dirB, 'perf.json');
  console.log('\n━━ perf.json (medians; Δ% flagged beyond ±' + THRESH + '%)');
  if (!A || !B) { console.log(`  (missing in ${!A ? dirA : dirB}) — skipped`); return; }
  if (A.meta && B.meta) {
    for (const k of ['harness', 'windowMs', 'reps', 'headless', 'chromium']) {
      if (JSON.stringify(A.meta[k]) !== JSON.stringify(B.meta[k])) console.log(`  ! meta.${k} differs: ${short(A.meta[k])} vs ${short(B.meta[k])}`);
    }
  }
  const rows = [];
  for (const [name, sa] of Object.entries(A.scenarios || {})) {
    const sb = (B.scenarios || {})[name];
    if (!sb) { rows.push([name, '(missing in B)', '', '', '', '']); continue; }
    let metrics = [...new Set([...Object.keys(sa.median || {}), ...Object.keys(sb.median || {})])];
    if (!opt['all-metrics']) metrics = KEY_METRICS.filter((m) => metrics.includes(m));
    for (const m of metrics) {
      const a = sa.median[m], b = sb.median[m];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const delta = b - a;
      const pct = a === 0 ? (b === 0 ? 0 : Infinity) : (delta / Math.abs(a)) * 100;
      const floor = /PerFrame_ms$/.test(m) ? 0.2 : 2;   // ignore tiny absolute moves (2 ms / 2 events / 0.2 ms per frame)
      let flag = '';
      if (INFO_METRICS.has(m)) flag = Math.abs(pct) >= THRESH && Math.abs(delta) > floor ? '(info)' : '';
      else if (Math.abs(delta) > floor && Number.isFinite(pct) && Math.abs(pct) >= THRESH) flag = pct < 0 ? 'better' : 'WORSE';
      else if (!Number.isFinite(pct) && Math.abs(delta) > floor) flag = 'WORSE';
      rows.push([name, m, fmt(a), fmt(b), (delta >= 0 ? '+' : '') + fmt(delta), Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'n/a', flag]);
    }
  }
  const head = ['scenario', 'metric', 'A', 'B', 'Δ', 'Δ%', ''];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => (i >= 2 && i <= 5 ? String(c ?? '').padStart(w[i]) : String(c ?? '').padEnd(w[i]))).join('  ');
  console.log('  Per-window counts (paints, raster tasks, rAF, style recalcs…) grow with the frame rate: when');
  console.log('  trace.frames moves a lot, judge with the *PerFrame_ms rows and cpu.total_ms.\n');
  console.log('  ' + line(head));
  console.log('  ' + w.map((x) => '─'.repeat(x)).join('  '));
  let prev = null;
  for (const r of rows) {
    if (prev !== null && r[0] !== prev) console.log('');
    console.log('  ' + line(r));
    prev = r[0];
  }
}
// Default perf table (use --all-metrics for every recorded metric)
const KEY_METRICS = [
  'cpu.total_ms', 'cpu.gpu_ms', 'cpu.renderer_ms',
  'main.TaskDuration_ms', 'main.ScriptDuration_ms', 'main.LayoutCount', 'main.LayoutDuration_ms',
  'main.RecalcStyleCount', 'main.RecalcStyleDuration_ms',
  'trace.frames', 'trace.cpuPerFrame_ms', 'trace.vizPerFrame_ms', 'trace.mainTaskPerFrame_ms',
  'trace.paints', 'trace.rasterTasks', 'trace.raster_ms', 'trace.rasterPerFrame_ms', 'trace.rafCallbacks',
];
// Frame counts are informational: more frames is smoother but costs CPU.
const INFO_METRICS = new Set(['trace.frames', 'trace.framesPerSec', 'trace.mainFrames']);
function fmt(v) {
  if (typeof v !== 'number') return String(v);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

console.log(`A = ${dirA}\nB = ${dirB}`);
compareBehaviour('behavior.json');
compareBehaviour('behavior-android.json');
comparePerf();
console.log(`\n${hardTotal ? `✗ ${hardTotal} hard behaviour difference(s)` : '✓ no hard behaviour difference'}`);
process.exit(hardTotal ? 1 : 0);
