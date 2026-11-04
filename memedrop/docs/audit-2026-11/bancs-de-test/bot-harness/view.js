#!/usr/bin/env node
'use strict';
// Compact human-readable view of a transcript: node view.js out.json [fromStep] [toStep]
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const from = process.argv[3], to = process.argv[4];
let on = !from;
const short = (v, n = 260) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
for (const s of d.steps) {
  if (s.id === from) on = true;
  if (!on) continue;
  console.log(`\n${s.id} [t=${s.t}${s.t_end !== undefined ? '→' + s.t_end : ''}] ${s.do}`);
  for (const [k, v] of Object.entries(s)) {
    if (['id', 'do', 't', 't_end'].includes(k)) continue;
    if (k === 'ws') { for (const [o, msgs] of Object.entries(v)) for (const m of msgs) console.log(`   ws.${o}: ${short(m)}`); continue; }
    if (k === 'ix') { for (const [who, calls] of Object.entries(v)) for (const c of calls) console.log(`   ix.${who}: ${short(c)}`); continue; }
    for (const e of (Array.isArray(v) ? v : [v])) console.log(`   ${k}: ${short(e)}`);
  }
  if (s.id === to) break;
}
