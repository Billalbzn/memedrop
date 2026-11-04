#!/usr/bin/env node
'use strict';
// MemeDrop overlay renderer — behaviour + performance regression harness.
//
//   node run.js <root> <out-dir> [options]
//
//   <root>     the memedrop/ directory (contains overlay/ and android/)
//   <out-dir>  where behavior.json, behavior-android.json, perf.json go
//
// Options
//   --only=behavior,android,perf   run a subset (default: all three)
//   --filter=a,b                   only scenarios whose name contains a or b
//   --perf-reps=N                  repetitions per perf scenario (default 3)
//   --perf-window=MS               measurement window (default 4000)
//   --perf-headless                run perf headless instead of headed under Xvfb
//   --no-trace                     skip the CDP trace pass of the perf probe
//
//   --list                         print every scenario with its description
//
// Behaviour transcripts are deterministic (fake clock, seeded Math.random,
// settled CSS animations): two runs on the same code give byte-identical
// files. Compare two output dirs with:  node compare.js <dirA> <dirB>
// Read one transcript with:             node show.js <dir>/behavior.json [scenario]
//
// How a behaviour scenario runs
//   * fresh browser context per scenario; Playwright fake clock paused at a
//     fixed epoch (t = 0 at load), advanced only by the scenario (t values in
//     the transcript are fake milliseconds); Math.random seeded per scenario;
//   * CSS animations are pinned at their settled state (t = 12 s: entry
//     animations done, "bob" at rest) and transitions are instant, so every
//     getBoundingClientRect() the renderer does is wall-clock independent;
//   * media load/error/ended/timeupdate happen in real time: the scenario
//     waits for them (clock paused) before advancing fake time;
//   * remote URLs are stubbed: unreachable.test (connection refused),
//     media.test/404, avatar.test/404 (404), hang.test (never answers),
//     tts.test (WAV); no request leaves the machine.
//
// Transcript format (behavior.json / behavior-android.json)
//   scenarios.<name>.steps[] = { step, t, actions?, events?, dom?, extra? }
//   events: bridge (window.memedrop.* calls with fake time + args),
//           subscriptions, speech (speechSynthesis.speak), mediaPlay
//           (HTMLMediaElement.play), pops (arrival sound oscillators),
//           audioContextsTotal, errors (uncaught), rects (Android
//           MDOverlay.rects), notes (harness timeouts / clock errors)
//   dom:    theme, body classes, spotlight (inline vars + which drop the hole
//           is centred on), stage (anchor/drop trees: tag, classes, attrs,
//           inline style, text, offset box, img/media state, computed styles
//           at some checkpoints), overlays (audio/TTS toasts), rain summary,
//           trackedMedia (every element play()'d), idleTimers (pending fake
//           timers once nothing is on screen)
//   keys starting with "~" depend on Math.random (positions, rain mix): they
//   are reported as "soft" differences by compare.js.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const A = require('./lib/assets');
const { runBehaviour, BEHAVIOUR_ARGS } = require('./lib/behavior');
const electronScenarios = require('./lib/scenarios-electron').scenarios;
const androidScenarios = require('./lib/scenarios-android').scenarios;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opt[k] = v === undefined ? true : v;
    } else pos.push(a);
  }
  return { pos, opt };
}

// Fingerprint of the harness itself: transcripts are only comparable when
// produced by the same harness version (compare.js warns otherwise).
function harnessFingerprint() {
  const h = require('crypto').createHash('sha1');
  const files = ['run.js', ...fs.readdirSync(path.join(__dirname, 'lib')).sort().map((f) => path.join('lib', f))];
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(__dirname, f)));
  return h.digest('hex').slice(0, 12);
}

function stableStringify(obj) {
  return JSON.stringify(obj, null, 1) + '\n';
}

// WebM clips recorded once per run (MediaRecorder needs real time).
async function recordClips(workDir) {
  const browser = await chromium.launch({ args: BEHAVIOUR_ARGS });
  try {
    const page = await browser.newPage();
    const blank = path.join(workDir, 'blank.html');
    fs.writeFileSync(blank, '<!doctype html><html><body></body></html>');
    await page.goto('file://' + blank);
    const raw = await A.recordWebmClips(page, [
      { name: 'short', ms: 1600 }, { name: 'med', ms: 3300 }, { name: 'long', ms: 6600 },
    ]);
    // Declared durations are longer than the recorded content (~1.6 / 3.3 /
    // 6.6 s): Chromium never revises a declared duration downwards before the
    // end, whereas a shorter one is extended as soon as the demuxer sees later
    // frames — racing the renderer's 'loadedmetadata' handler.
    return {
      rawMed: raw.med,                                    // no Duration element (Infinity at 'loadedmetadata')
      short2000: A.patchWebmDuration(raw.short, 2000),    // duration 2 s, ends after ~1.6 s
      med4000: A.patchWebmDuration(raw.med, 4000),        // duration 4 s, ends after ~3.3 s
      long8000: A.patchWebmDuration(raw.long, 8000),      // duration 8 s, ends after ~6.6 s
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  if (opt.list) {
    for (const [mode, list] of [['electron', electronScenarios], ['android', androidScenarios]]) {
      console.log(`\n${mode} behaviour scenarios:`);
      for (const sc of list) console.log(`  ${sc.name.padEnd(30)} ${sc.desc}`);
    }
    console.log('\nperformance scenarios:');
    for (const sc of require('./lib/perf').SCENARIOS) console.log(`  ${sc.name.padEnd(30)} ${sc.desc}`);
    return;
  }
  if (pos.length < 2 || opt.help) {
    console.error('usage: node run.js <memedrop-root> <out-dir> [--only=behavior,android,perf] [--filter=name] [--perf-reps=3] [--perf-window=4000] [--perf-headless] [--no-trace]');
    process.exit(2);
  }
  const root = path.resolve(pos[0]);
  const outDir = path.resolve(pos[1]);
  if (!fs.existsSync(path.join(root, 'overlay', 'src', 'overlay.html'))) {
    console.error(`not a memedrop root (overlay/src/overlay.html missing): ${root}`);
    process.exit(2);
  }
  const only = new Set(String(opt.only || 'behavior,android,perf').split(',').map((s) => s.trim()));
  const filter = opt.filter ? String(opt.filter).split(',') : null;
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, '.work');
  fs.mkdirSync(workDir, { recursive: true });
  const log = (m) => console.log(m);
  const t0 = Date.now();

  const assets = { static: A.buildStaticAssets(), clips: {} };
  log('recording WebM clips (canvas.captureStream + MediaRecorder, ~7 s)…');
  assets.clips = await recordClips(workDir);

  if (only.has('behavior')) {
    log('behaviour — electron mode');
    const res = await runBehaviour({ chromium, root, mode: 'electron', scenarios: electronScenarios, assets, workDir, filter, log });
    res.meta = { harness: harnessFingerprint(), ...res.meta };
    fs.writeFileSync(path.join(outDir, 'behavior.json'), stableStringify(res));
  }
  if (only.has('android')) {
    log('behaviour — android mode');
    const res = await runBehaviour({ chromium, root, mode: 'android', scenarios: androidScenarios, assets, workDir, filter, log });
    res.meta = { harness: harnessFingerprint(), ...res.meta };
    fs.writeFileSync(path.join(outDir, 'behavior-android.json'), stableStringify(res));
  }
  if (only.has('perf')) {
    const { runPerf } = require('./lib/perf');
    log('performance probe');
    const res = await runPerf({
      chromium, root, assets, workDir, log,
      reps: Number(opt['perf-reps'] || 3),
      windowMs: Number(opt['perf-window'] || 4000),
      headless: !!opt['perf-headless'],
      trace: !opt['no-trace'],
      filter,
    });
    res.meta = { harness: harnessFingerprint(), ...res.meta };
    fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(res, null, 1) + '\n');
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
