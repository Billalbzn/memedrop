#!/usr/bin/env node
'use strict';
// Compare two transcripts produced by run.js.
//
//   node compare.js <a.json> <b.json> [--loose-acks] [--strict-counters] [--max=N]
//
// Exit 0: identical observable behaviour. Exit 1: differences (printed per
// step with context). Exit 2: usage / unreadable input.
//   --loose-acks       compare only the final visible reply of each
//                      interaction (content + ephemeral) instead of the exact
//                      deferReply/reply/editReply call sequence
//   --strict-counters  also fail on Discord API usage counter changes
//                      (cache hits vs API calls; informational by default)
//   --max=N            print at most N differences (default 200)

const fs = require('fs');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const maxArg = argv.find((a) => a.startsWith('--max='));
const MAX = maxArg ? Number(maxArg.split('=')[1]) : 200;
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length !== 2) {
  console.error('usage: node compare.js <a.json> <b.json> [--loose-acks] [--strict-counters] [--max=N]');
  process.exit(2);
}
let A;
let B;
try {
  A = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  B = JSON.parse(fs.readFileSync(files[1], 'utf8'));
} catch (e) {
  console.error(`cannot read transcripts: ${e.message}`);
  process.exit(2);
}

const show = (v) => {
  if (v === undefined) return '(absent)';
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

// Final visible state of each interaction (for --loose-acks).
function finalView(calls) {
  let ephemeral = null;
  let visible = null;
  const followUps = [];
  const errors = [];
  for (const c of calls) {
    const { m, error, ...rest } = c;
    if (error) { errors.push(`${m}: ${error}`); continue; }
    if ((m === 'deferReply' || m === 'reply') && ephemeral === null) ephemeral = rest.ephemeral ?? false;
    if (m === 'reply' || m === 'editReply') {
      const { ephemeral: _e, ...content } = rest;
      visible = content;
    }
    if (m === 'followUp') followUps.push(rest);
  }
  const out = { ephemeral, visible };
  if (followUps.length) out.followUps = followUps;
  if (errors.length) out.errors = errors;
  return out;
}

function prepStep(s) {
  if (!s || !flags.has('--loose-acks') || !s.ix) return s;
  const ix = {};
  for (const [k, calls] of Object.entries(s.ix)) ix[k] = finalView(calls);
  return { ...s, ix };
}

// LCS alignment for arrays so an inserted/removed element does not cascade.
function lcsAlign(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) return null;
  const ka = a.map((x) => JSON.stringify(x));
  const kb = b.map((x) => JSON.stringify(x));
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { ops.push(['=', i++, j++]); continue; }
    // On ties emit the deletion first so a replaced element pairs up as a
    // modification ('~') and gets a field-level diff.
    if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', i++, null]);
    else ops.push(['+', null, j++]);
  }
  // Pair adjacent -/+ runs as modifications so nested diffs stay readable.
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === '-') {
      const dels = [];
      while (k < ops.length && ops[k][0] === '-') dels.push(ops[k++]);
      const adds = [];
      while (k < ops.length && ops[k][0] === '+') adds.push(ops[k++]);
      k--;
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) out.push(['~', dels[p][1], adds[p][2]]);
      for (let p = pairs; p < dels.length; p++) out.push(dels[p]);
      for (let p = pairs; p < adds.length; p++) out.push(adds[p]);
    } else out.push(ops[k]);
  }
  return out;
}

function diff(a, b, pathStr, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const ops = lcsAlign(a, b);
    if (!ops) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) diff(a[i], b[i], `${pathStr}[${i}]`, out);
      return;
    }
    for (const [op, i, j] of ops) {
      if (op === '=') continue;
      if (op === '~') diff(a[i], b[j], `${pathStr}[${i}]`, out);
      else if (op === '-') out.push({ path: `${pathStr}[${i}]`, a: a[i], b: undefined, kind: 'removed' });
      else out.push({ path: `${pathStr}[+${j}]`, a: undefined, b: b[j], kind: 'added' });
    }
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) diff(a[k], b[k], pathStr ? `${pathStr}.${k}` : k, out);
    return;
  }
  out.push({ path: pathStr, a, b, kind: 'changed' });
}

const behaviour = [];
const info = [];

if (JSON.stringify(A.harness) !== JSON.stringify(B.harness)) {
  info.push(`harness version differs: ${show(A.harness)} vs ${show(B.harness)}`);
}

// Steps, aligned by id.
const stepsA = new Map((A.steps || []).map((s) => [s.id, s]));
const stepsB = new Map((B.steps || []).map((s) => [s.id, s]));
const ids = [];
const seen = new Set();
for (const s of [...(A.steps || []), ...(B.steps || [])]) if (!seen.has(s.id)) { seen.add(s.id); ids.push(s.id); }
for (const id of ids) {
  const sa = prepStep(stepsA.get(id));
  const sb = prepStep(stepsB.get(id));
  if (!sa || !sb) {
    behaviour.push({ step: id, ctx: (sa || sb).do, lines: [`step only in ${sa ? 'A' : 'B'}: ${show(sa || sb)}`] });
    continue;
  }
  const d = [];
  diff(sa, sb, '', d);
  if (d.length) {
    behaviour.push({
      step: id,
      ctx: sa.do === sb.do ? sa.do : `${sa.do}  ⟶  ${sb.do}`,
      lines: d.map((x) => (x.kind === 'added' ? `+ ${x.path}: ${show(x.b)}` : x.kind === 'removed' ? `- ${x.path}: ${show(x.a)}` : `~ ${x.path}: ${show(x.a)}  ⟶  ${show(x.b)}`)),
    });
  }
}

// Summary (process exits, upstream call counts).
{
  const d = [];
  diff(A.summary, B.summary, 'summary', d);
  if (d.length) behaviour.push({ step: 'summary', ctx: 'process exits / upstream call totals', lines: d.map((x) => `~ ${x.path}: ${show(x.a)}  ⟶  ${show(x.b)}`) });
}

// Counters (informational unless --strict-counters).
{
  const d = [];
  diff(A.counters, B.counters, 'counters', d);
  if (d.length) {
    const entry = { step: 'counters', ctx: 'Discord API usage (users.fetch = calls, api.* = calls that missed the cache)', lines: d.map((x) => `~ ${x.path}: ${show(x.a)}  ⟶  ${show(x.b)}`) };
    if (flags.has('--strict-counters')) behaviour.push(entry); else info.push(entry);
  }
}

let printed = 0;
for (const e of behaviour) {
  if (printed >= MAX) break;
  console.log(`\n■ ${e.step}  ${e.ctx}`);
  for (const l of e.lines) {
    if (printed >= MAX) break;
    console.log(`    ${l}`);
    printed++;
  }
}
const totalLines = behaviour.reduce((n, e) => n + e.lines.length, 0);
if (printed < totalLines) console.log(`\n… ${totalLines - printed} more difference(s) not shown (use --max=N)`);
for (const e of info) {
  if (typeof e === 'string') { console.log(`\nℹ ${e}`); continue; }
  console.log(`\nℹ ${e.step} (informational)  ${e.ctx}`);
  for (const l of e.lines.slice(0, 40)) console.log(`    ${l}`);
}

if (behaviour.length) {
  console.log(`\nDIFFERENT: ${behaviour.length} step(s)/section(s) with ${totalLines} difference(s).`);
  process.exit(1);
}
console.log(`\nIDENTICAL observable behaviour (${(A.steps || []).length} steps)${info.length ? ', informational differences listed above' : ''}.`);
process.exit(0);
