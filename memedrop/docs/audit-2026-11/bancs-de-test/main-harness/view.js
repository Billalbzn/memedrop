#!/usr/bin/env node
'use strict';
// Compact, human-readable dump of one scenario of a run.js transcript.
//   node view.js <out.json> <scenario> [fromStep] [toStep] [--state] [--io]

const fs = require('fs');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.filter((a) => !a.startsWith('--'));
if (pos.length < 1) {
  process.stderr.write('usage: node view.js <out.json> [scenario] [fromStep] [toStep] [--state] [--io]\n');
  process.exit(2);
}
const doc = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
if (pos.length < 2) {
  for (const [n, s] of Object.entries(doc.scenarios)) process.stdout.write(`${n.padEnd(28)} ${(s.steps || []).length} steps  ${s.description || ''}\n`);
  process.exit(0);
}
const sc = doc.scenarios[pos[1]];
if (!sc) { process.stderr.write(`no scenario ${pos[1]}\n`); process.exit(2); }
const from = pos[2] ? Number(pos[2]) : 0;
const to = pos[3] ? Number(pos[3]) : Infinity;
const j = (v) => { const s = JSON.stringify(v); return s.length > 400 ? `${s.slice(0, 400)}…` : s; };
const ms = (t) => `${(t / 1000).toFixed(3)}s`;

if (sc.fatal) process.stdout.write(`FATAL: ${sc.fatal}\n`);
(sc.steps || []).forEach((s, i) => {
  if (i < from || i > to) return;
  process.stdout.write(`\n#${i} [${ms(s.t)}${s.tEnd !== undefined ? ` → ${ms(s.tEnd)}` : ''}] ${s.label}${s.metric ? `  {metric:${s.metric}}` : ''}\n`);
  if (s.result !== undefined) process.stdout.write(`   result: ${j(s.result)}\n`);
  for (const [w, arr] of Object.entries(s.ipc || {})) for (const e of arr) process.stdout.write(`   ipc→${w} ${ms(e.t)} ${e.api}(${e.ch}) ${j(e.payload)}\n`);
  for (const [w, arr] of Object.entries(s.unobserved || {})) process.stdout.write(`   (unobserved→${w}: ${arr.map((e) => `${e.ch}/${e.reason}`).join(', ')})\n`);
  for (const e of s.winCreated || []) process.stdout.write(`   new window ${e.win} ${j(e.options)}\n`);
  for (const [w, arr] of Object.entries(s.winCalls || {})) process.stdout.write(`   ${w}: ${arr.map((e) => `${e.m}${e.args.length ? j(e.args) : '()'}@${ms(e.t)}`).join('  ')}\n`);
  for (const [c, r] of Object.entries(s.net || {})) {
    process.stdout.write(`   ${c} ${r.url}\n`);
    for (const e of r.life || []) { const { t, side, ev, ...rest } = e; process.stdout.write(`      ${ms(t)} ${side} ${ev} ${Object.keys(rest).length ? j(rest) : ''}\n`); }
    for (const f of r.c2s || []) process.stdout.write(`      ${ms(f.t)} overlay→bot ${j(f.frame)}\n`);
    for (const f of r.s2c || []) process.stdout.write(`      ${ms(f.t)} bot→overlay ${j(f.frame)}\n`);
  }
  for (const e of s.netErrors || []) process.stdout.write(`   ws construct error ${e.url}: ${e.error}\n`);
  for (const e of s.trayChanges || []) process.stdout.write(`   tray now @${ms(e.t)}: tooltip ${JSON.stringify(e.tooltip)} menu ${j((e.menu || []).map((m) => m.label || '—'))}\n`);
  for (const cat of ['app', 'tray', 'shell', 'updater', 'shortcut', 'dialog', 'notification', 'lifecycle']) {
    for (const e of s[cat] || []) process.stdout.write(`   ${cat}.${e.m}(${e.args.map((a) => j(a)).join(', ')})${e.win ? ` [${e.win}]` : ''} @${ms(e.t)}\n`);
  }
  for (const e of s.console || []) process.stdout.write(`   console.${e.level} ${ms(e.t)} ${e.text}\n`);
  for (const e of s.errors || []) process.stdout.write(`   ERROR ${e.where}: ${e.error}\n`);
  for (const n of s.notes || []) process.stdout.write(`   note: ${n}\n`);
  for (const n of s.unknownApi || []) process.stdout.write(`   unknown electron API: ${n}\n`);
  if (s.orphans) process.stdout.write(`   orphans: ${j(s.orphans)}\n`);
  if (flags.has('--io')) process.stdout.write(`   io ${j(s.io)} counters ${j(s.counters || {})}\n`);
  else if (s.io && (s.io.read || s.io.write)) process.stdout.write(`   io: ${s.io.read} reads, ${s.io.write} writes\n`);
  if (flags.has('--state')) {
    process.stdout.write(`   state.trays ${j((s.state.trays || []).map((t) => ({ tooltip: t.tooltip, menu: (t.menu || []).map((m) => m.label || '—') })))}\n`);
    for (const [w, st] of Object.entries(s.state.windows || {})) process.stdout.write(`   state.${w} ${j(st)}\n`);
    process.stdout.write(`   timers ${j(s.timers)}\n`);
  }
});
if (to === Infinity) process.stdout.write(`\nfinal: ${j(sc.final)}\nioTotal: ${j(sc.ioTotal)}\n`);
