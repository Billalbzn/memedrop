#!/usr/bin/env node
'use strict';
// Compact, human-readable view of a behaviour transcript.
//   node show.js <behavior.json> [scenario-substring ...] [--dom]
// Without --dom only a one-line summary of the DOM is printed per step.

const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const filters = args.filter((a) => !a.startsWith('--') && a !== file);
const fullDom = args.includes('--dom');
if (!file) { console.error('usage: node show.js <behavior.json> [scenario ...] [--dom]'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

function find(n, pred, out = []) {
  if (!n) return out;
  if (pred(n)) out.push(n);
  for (const k of n.kids || []) find(k, pred, out);
  return out;
}
function summarizeDom(dom) {
  if (!dom) return '';
  const parts = [];
  if (dom.theme) parts.push(`theme=${dom.theme}`);
  if (dom.bodyClass && dom.bodyClass.length) parts.push(`body.${dom.bodyClass.join('.')}`);
  const sp = dom.spotlight;
  if (sp && (sp.style.opacity || sp.target)) parts.push(`spot(op=${sp.style.opacity || '-'},target=${sp.target}${sp.holeMatchesSize === false ? ',SIZE-MISMATCH' : ''})`);
  for (const a of dom.stage || []) {
    const drop = (a.kids || [])[0];
    const cls = drop && drop.cls ? drop.cls.filter((c) => c !== 'drop').join('.') : '';
    const media = find(a, (n) => ['img', 'video', 'svg'].includes(n.tag) && !find({ kids: [] }, () => false).length)
      .filter((n) => n.tag !== 'img' || !(n.attrs && n.attrs.src && String(n.attrs.src).includes('avatar')));
    const m = media[media.length - 1];
    const cap = find(a, (n) => n.cls && n.cls.includes('caption-bar'))[0];
    const life = find(a, (n) => n.cls && n.cls.includes('life-bar'))[0];
    const vid = find(a, (n) => n.tag === 'video')[0];
    let s = `#${a.attrs && a.attrs['data-key']}${cls ? '.' + cls : ''}`;
    if (a.style && a.style.opacity && a.style.opacity !== '1') s += ` op=${a.style.opacity}`;
    if (m) s += ` ${m.tag}${m.box ? ' ' + m.box[2] + 'x' + m.box[3] : ''}`;
    if (cap) s += ` cap(${cap.style && cap.style['font-size'] || 'css'})`;
    if (life && life.style) s += ` life=${life.style['transition-duration'] || '-'}`;
    if (vid) s += ` vol=${vid.mediaState.muted ? 'muted' : vid.mediaState.volume}${vid.mediaState.paused ? ' paused' : ''}`;
    parts.push(s);
  }
  for (const o of dom.overlays || []) parts.push(`${o.tag}.${(o.cls || []).join('.')}${o.style && o.style['--op'] ? ' --op=' + o.style['--op'] : ''}`);
  const rc = dom.rain ? (dom.rain.count !== undefined ? dom.rain.count : dom.rain['~count']) : 0;
  if (rc) parts.push(`rain=${rc}${dom.rain.violationCount ? ' VIOLATIONS=' + dom.rain.violationCount : ''}`);
  if (dom.idleTimers) parts.push(`idleTimers=${dom.idleTimers}`);
  for (const t of dom.trackedMedia || []) parts.push(`media(${t.src} ${t.muted ? 'muted' : t.volume}${t.paused ? ' paused' : ''}${t.error ? ' err' + t.error : ''})`);
  return parts.join(' | ');
}

for (const [name, sc] of Object.entries(data.scenarios)) {
  if (filters.length && !filters.some((f) => name.includes(f))) continue;
  console.log(`\n=== ${name}${sc.error ? '  ERROR: ' + sc.error : ''}`);
  for (const st of sc.steps) {
    console.log(`  [t=${st.t}] ${st.step}`);
    if (st.actions) for (const a of st.actions) console.log(`      action: ${a}`);
    const ev = st.events || {};
    if (ev.bridge) console.log(`      bridge: ${ev.bridge.map((b) => `${b.t}:${b.call}${b.args ? '(' + b.args.map((x) => JSON.stringify(x)).join(',') + ')' : ''}`).join(' ')}`);
    if (ev.subscriptions) console.log(`      subs: ${ev.subscriptions.join(',')}`);
    if (ev.speech) console.log(`      speech: ${ev.speech.map((s) => JSON.stringify(s)).join(' ')}`);
    if (ev.mediaPlay) console.log(`      play(): ${ev.mediaPlay.map((m) => `${m.tag}<${m.src}> vol=${m.muted ? 'muted' : m.volume}`).join(' ')}`);
    if (ev.pops) console.log(`      pops: ${ev.pops.length}${ev.audioContextsTotal !== undefined ? ' (AudioContexts total ' + ev.audioContextsTotal + ')' : ''}`);
    if (ev.errors) console.log(`      ERRORS: ${JSON.stringify(ev.errors)}`);
    if (ev.notes) console.log(`      notes: ${JSON.stringify(ev.notes)}`);
    if (ev.rects) for (const r of ev.rects) console.log(`      rects@${r.t}: ${JSON.stringify(r.rects.map((x) => `${x.key}:${x.w}x${x.h}${x.inScreen ? '' : ' OFFSCREEN'}`))}`);
    if (st.extra !== undefined) console.log(`      extra: ${JSON.stringify(st.extra)}`);
    if (st.dom) console.log(`      dom: ${summarizeDom(st.dom)}`);
    if (fullDom && st.dom) console.log(JSON.stringify(st.dom, null, 1).split('\n').map((l) => '        ' + l).join('\n'));
  }
}
