'use strict';
// Runs the behaviour scenarios (Electron mode and Android mode) and returns
// normalised transcripts.

const fs = require('fs');
const path = require('path');
const { Driver, ELECTRON_GET_SETTINGS } = require('./driver');

const BEHAVIOUR_ARGS = [
  '--disable-gpu', '--disable-gpu-compositing',
  // Electron's default autoplayPolicy is 'no-user-gesture-required'; the
  // Android WebView sets mediaPlaybackRequiresUserGesture = false.
  '--autoplay-policy=no-user-gesture-required',
  '--font-render-hinting=none',
];

const SHIM_TAG_FROM = '<script src="./overlay.js"></script>';
const SHIM_TAG_TO = '<script src="./android-shim.js"></script><script src="./overlay.js"></script>';

// Emulates android/app/build.gradle.kts → syncWebAssets (line filter).
function buildAndroidWebAssets(root, dir) {
  const src = path.join(root, 'overlay', 'src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['overlay.js', 'styles.css']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  const html = fs.readFileSync(path.join(src, 'overlay.html'), 'utf8');
  let replaced = 0;
  const out = html.split('\n').map((line) => {
    if (line.includes(SHIM_TAG_FROM)) replaced++;
    return line.split(SHIM_TAG_FROM).join(SHIM_TAG_TO);
  }).join('\n');
  fs.writeFileSync(path.join(dir, 'overlay.html'), out);
  fs.copyFileSync(path.join(root, 'android', 'app', 'src', 'main', 'assets', 'android-shim.js'), path.join(dir, 'android-shim.js'));
  return { shimInjected: replaced > 0, replacements: replaced };
}

async function runScenario(browser, def, common) {
  const d = new Driver({ browser, name: def.name, ...common });
  const started = Date.now();
  let error = null;
  try {
    await d.open({ settings: def.settings ? { ...ELECTRON_GET_SETTINGS, ...def.settings } : undefined });
    if (common.mode === 'electron') await d.check('load', { computed: false });
    else await d.check('load', { computed: false });
    await def.run(d);
  } catch (e) {
    error = String(e && e.message || e).split('\n')[0];
  }
  const res = { desc: def.desc, steps: d.transcript() };
  if (error) res.error = error;
  const debug = d.debug.slice();
  await d.close();
  return { res, ms: Date.now() - started, debug };
}

async function runBehaviour({ chromium, root, mode, scenarios, assets, workDir, filter, log }) {
  const browser = await chromium.launch({ args: BEHAVIOUR_ARGS });
  const out = { meta: {}, scenarios: {} };
  try {
    let pageUrl, viewport, dsf;
    if (mode === 'electron') {
      pageUrl = 'file://' + path.join(root, 'overlay', 'src', 'overlay.html');
      viewport = { width: 1600, height: 900 };
      dsf = 1;
      out.meta = { mode, viewport, deviceScaleFactor: dsf };
    } else {
      const dir = path.join(workDir, 'android-webassets');
      const info = buildAndroidWebAssets(root, dir);
      pageUrl = 'file://' + path.join(dir, 'overlay.html');
      viewport = { width: 412, height: 915 };
      dsf = 2.625;
      out.meta = { mode, viewport, deviceScaleFactor: dsf, ...info };
    }
    for (const def of scenarios) {
      if (filter && !filter.some((f) => def.name.includes(f))) continue;
      const { res, ms, debug } = await runScenario(browser, def, { mode, root, assets, pageUrl, viewport, deviceScaleFactor: dsf });
      out.scenarios[def.name] = res;
      if (log) log(`  ${mode} ${def.name}: ${res.steps.length} steps, ${ms} ms${res.error ? ' ERROR ' + res.error : ''}${debug.length ? ' pageerror: ' + debug.join(' | ') : ''}`);
    }
  } finally {
    await browser.close();
  }
  return out;
}

module.exports = { runBehaviour, buildAndroidWebAssets, BEHAVIOUR_ARGS };
