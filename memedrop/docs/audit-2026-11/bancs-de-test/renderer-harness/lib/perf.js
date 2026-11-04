'use strict';
// Performance probe — real time, no fake clock, CSS animations untouched,
// GPU disabled (software raster + software compositing, like Electron with
// app.disableHardwareAcceleration()). Headed under Xvfb by default.
//
// For each scenario and repetition, two passes on a fresh page:
//   1. clean pass  — CDP Performance.getMetrics deltas (renderer main thread)
//                    + per-process CPU time (SystemInfo.getProcessInfo)
//   2. trace pass  — CDP trace (devtools.timeline, cc, viz…): counts and total
//                    durations of paint / raster / style / layout / rAF / JS
//                    and compositor frames (Display::DrawAndSwap)
// Medians over the repetitions are the numbers to compare.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pageInit } = require('./page-init');

const PERF_ARGS = [
  '--disable-gpu', '--disable-gpu-compositing',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
const VIEWPORT = { width: 1600, height: 900 };
const TRACE_CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'cc', 'viz', 'gpu', 'toplevel', 'blink',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FROM = { id: '1001', username: 'alice' };
function imageDrop(assets, name, settings, extra = {}) {
  return {
    type: 'drop', dropId: 'perf', media: { url: assets.static[name], kind: 'image', mime: 'image/png' },
    caption: 'quand le build passe', from: { ...FROM, avatar: assets.static.avatar64 },
    settings: { volume: 0.75, musicVolume: 0.75, opacity: 1, duration: 30, videoDuration: 30, soundOnArrival: false, spotlightOnDrop: true, avoidZone: 'none', ...settings },
    ...extra,
  };
}
async function fire(page, payload) { await page.evaluate((p) => window.__H.fireDrop(p), payload); }

// Scenario: setup(page, ctx) runs before the window; start/stop wrap it.
const SCENARIOS = [
  {
    name: 'idle',
    desc: 'Overlay loaded, nothing on screen.',
    async setup() {},
  },
  {
    name: 'idle-after-drops',
    desc: 'Leak check: an image (spotlight on), an audio-less TTS toast and a rain came and went; window starts once all are gone.',
    async setup(page, { assets }) {
      await fire(page, imageDrop(assets, 'png400x300', { spotlightOnDrop: true, duration: 1 }));
      await fire(page, { type: 'drop', tts: 'ok', ttsUrl: null, rain: ['🎉'], from: { ...FROM }, settings: { soundOnArrival: false } });
      await sleep(6000);
    },
  },
  {
    name: 'image-spotlight',
    desc: 'One 400x300 image drop (caption, avatar, reactions) on screen, spotlight ON (default).',
    async setup(page, { assets }) { await fire(page, imageDrop(assets, 'png400x300', { spotlightOnDrop: true })); await sleep(1200); },
  },
  {
    name: 'image-no-spotlight',
    desc: 'Same image drop, spotlight OFF.',
    async setup(page, { assets }) { await fire(page, imageDrop(assets, 'png400x300', { spotlightOnDrop: false })); await sleep(1200); },
  },
  {
    name: 'three-images',
    desc: 'Three image drops on screen, spotlight ON (default settings).',
    async setup(page, { assets }) {
      await fire(page, imageDrop(assets, 'png400x300', {}));
      await fire(page, imageDrop(assets, 'png200x500', {}, { caption: 'portrait' }));
      await fire(page, imageDrop(assets, 'png1200x900', {}, { caption: 'grande' }));
      await sleep(1200);
    },
  },
  {
    name: 'cursor-60hz',
    desc: 'One image drop (spotlight OFF) + cursor IPC at 60 Hz sweeping the screen away from the drop (hover hit-testing, no capture).',
    async setup(page, { assets }) { await fire(page, imageDrop(assets, 'png400x300', { spotlightOnDrop: false })); await sleep(1200); },
    async start(page) {
      await page.evaluate(() => {
        const d = document.querySelector('#stage .drop').getBoundingClientRect();
        const y = (d.top + d.bottom) / 2 < innerHeight / 2 ? innerHeight - 8 : 8;   // stay far from the drop
        let i = 0;
        window.__cursorTimer = setInterval(() => {
          i++;
          const x = Math.round((Math.sin(i / 30) * 0.5 + 0.5) * (innerWidth - 1));
          window.__H.fireCursor(x, y + (i % 2));
        }, 16);
      });
    },
    async stop(page) { await page.evaluate(() => clearInterval(window.__cursorTimer)); },
  },
  {
    name: 'emoji-rain',
    desc: 'Emoji rain (38 particles, 3 emojis) starting with the window, no media.',
    async setup() {},
    async start(page) {
      await fire(page, { type: 'drop', rain: ['🎉', '🔥', '💀'], from: { ...FROM }, settings: { soundOnArrival: false, spotlightOnDrop: true } });
    },
  },
  {
    name: 'video-playing',
    desc: 'Extra: one 320x240 WebM video drop playing, spotlight OFF.',
    needsClips: true,
    async setup(page, { assets }) {
      const url = await page.evaluate((b64) => {
        const s = atob(b64); const u8 = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
        return URL.createObjectURL(new Blob([u8], { type: 'video/webm' }));
      }, assets.clips.long8000.toString('base64'));
      await fire(page, { type: 'drop', media: { url, kind: 'video', mime: 'video/webm' }, caption: 'vidéo', from: { ...FROM },
        settings: { volume: 0.75, duration: 30, videoDuration: 30, soundOnArrival: false, spotlightOnDrop: false } });
      await sleep(1000);
    },
  },
  {
    name: 'gif-animated',
    desc: 'Extra: one animated 240x180 GIF drop, spotlight OFF.',
    async setup(page, { assets }) {
      await fire(page, { type: 'drop', media: { url: assets.static.gif240x180, kind: 'gif', mime: 'image/gif' }, caption: 'boucle', from: { ...FROM },
        settings: { duration: 30, soundOnArrival: false, spotlightOnDrop: false } });
      await sleep(1200);
    },
  },
];

function median(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (v) => Math.round(v * 10) / 10;

function cpuByType(info) {
  const o = { browser: 0, renderer: 0, gpu: 0, other: 0 };
  for (const p of info) {
    const t = p.type === 'browser' ? 'browser' : p.type === 'renderer' ? 'renderer' : p.type === 'GPU' ? 'gpu' : 'other';
    o[t] += p.cpuTime;
  }
  return o;
}
function cpuDelta(a, b) {
  const o = {};
  let total = 0;
  for (const k of Object.keys(b)) { o[`cpu.${k}_ms`] = r1((b[k] - (a[k] || 0)) * 1000); total += b[k] - (a[k] || 0); }
  o['cpu.total_ms'] = r1(total * 1000);
  return o;
}

function analyseTrace(json) {
  const evs = json.traceEvents || json;
  const threads = {};
  for (const e of evs) if (e.ph === 'M' && e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args && e.args.name;
  const agg = {};
  const add = (k, dur) => { const a = (agg[k] = agg[k] || { n: 0, us: 0 }); a.n++; a.us += dur || 0; };
  for (const e of evs) {
    if (e.ph !== 'X') continue;
    const th = threads[`${e.pid}:${e.tid}`] || '';
    switch (e.name) {
      case 'Display::DrawAndSwap': add('frames', e.dur); break;
      case 'SoftwareRenderer::DoDrawQuad': add('drawQuads', e.dur); break;
      case 'RasterTask': add('raster', e.dur); break;
      case 'Paint': if (th === 'CrRendererMain') add('paint', e.dur); break;
      case 'UpdateLayoutTree': if (th === 'CrRendererMain') add('style', e.dur); break;
      case 'Layout': if (th === 'CrRendererMain') add('layout', e.dur); break;
      case 'PrePaint': if (th === 'CrRendererMain') add('prePaint', e.dur); break;
      case 'Layerize': if (th === 'CrRendererMain') add('layerize', e.dur); break;
      case 'Commit': if (th === 'CrRendererMain') add('commit', e.dur); break;
      case 'FireAnimationFrame': add('raf', e.dur); break;
      case 'FunctionCall': if (th === 'CrRendererMain') add('js', e.dur); break;
      case 'TimerFire': add('timers', e.dur); break;
      case 'ProxyMain::BeginMainFrame': add('mainFrames', e.dur); break;
      case 'ThreadControllerImpl::RunTask': if (th === 'CrRendererMain') add('mainTasks', e.dur); break;
      default: break;
    }
  }
  const g = (k) => agg[k] || { n: 0, us: 0 };
  const ms = (k) => r1(g(k).us / 1000);
  const out = {
    'trace.frames': g('frames').n,
    'trace.vizDraw_ms': ms('frames'),
    'trace.vizPerFrame_ms': g('frames').n ? Math.round(g('frames').us / g('frames').n) / 1000 : 0,
    'trace.drawQuads': g('drawQuads').n,
    'trace.rasterTasks': g('raster').n,
    'trace.raster_ms': ms('raster'),
    'trace.paints': g('paint').n,
    'trace.paint_ms': ms('paint'),
    'trace.prePaints': g('prePaint').n,
    'trace.layerizes': g('layerize').n,
    'trace.commits': g('commit').n,
    'trace.styleRecalcs': g('style').n,
    'trace.style_ms': ms('style'),
    'trace.layouts': g('layout').n,
    'trace.layout_ms': ms('layout'),
    'trace.mainFrames': g('mainFrames').n,
    'trace.rafCallbacks': g('raf').n,
    'trace.raf_ms': ms('raf'),
    'trace.timers': g('timers').n,
    'trace.jsCalls': g('js').n,
    'trace.js_ms': ms('js'),
    'trace.mainTasks_ms': ms('mainTasks'),
  };
  return out;
}

async function newPerfPage(browser, root, settings) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  // hooks: speechSynthesis stubbed (TTS toasts), media play() recorded (cheap)
  await ctx.addInitScript(pageInit, { mode: 'perf', seed: 0x5EED, t0: null, settings, settle: false, hooks: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  // Electron's overlay window is transparent: no opaque base background.
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.goto('file://' + path.join(root, 'overlay', 'src', 'overlay.html'));
  await sleep(600);
  return { ctx, page, cdp };
}

async function measureOnce(browser, bcdp, sc, opts, traced) {
  const { root, assets, windowMs } = opts;
  const { ctx, page, cdp } = await newPerfPage(browser, root, { theme: 'classic' });
  try {
    await sc.setup(page, { assets });
    await cdp.send('Performance.enable');
    const gm = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    if (traced) await browser.startTracing(page, { categories: TRACE_CATEGORIES });
    const m0 = await gm();
    const p0 = cpuByType((await bcdp.send('SystemInfo.getProcessInfo')).processInfo);
    if (sc.start) await sc.start(page);
    await sleep(windowMs);
    if (sc.stop) await sc.stop(page);
    const m1 = await gm();
    const p1 = cpuByType((await bcdp.send('SystemInfo.getProcessInfo')).processInfo);
    let trace = null;
    if (traced) trace = analyseTrace(JSON.parse((await browser.stopTracing()).toString('utf8')));
    const d = (k) => m1[k] - m0[k];
    const res = {};
    if (!traced) {
      Object.assign(res, {
        'main.TaskDuration_ms': r1(d('TaskDuration') * 1000),
        'main.ScriptDuration_ms': r1(d('ScriptDuration') * 1000),
        'main.LayoutCount': d('LayoutCount'),
        'main.RecalcStyleCount': d('RecalcStyleCount'),
        'main.LayoutDuration_ms': r1(d('LayoutDuration') * 1000),
        'main.RecalcStyleDuration_ms': r1(d('RecalcStyleDuration') * 1000),
        'main.ThreadTime_ms': r1(d('ThreadTime') * 1000),
        'renderer.ProcessTime_ms': r1(d('ProcessTime') * 1000),
        ...cpuDelta(p0, p1),
      });
    } else {
      Object.assign(res, trace);
      const c = cpuDelta(p0, p1);
      res['trace.cpu.total_ms'] = c['cpu.total_ms'];
      res['trace.framesPerSec'] = r1(trace['trace.frames'] / (windowMs / 1000));
    }
    return res;
  } finally {
    await ctx.close();
  }
}

async function startXvfb(log) {
  for (let n = 90; n < 99; n++) {
    if (fs.existsSync(`/tmp/.X${n}-lock`)) continue;
    const proc = spawn('Xvfb', [`:${n}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    await sleep(700);
    if (proc.exitCode === null) {
      if (log) log(`  Xvfb on :${n}`);
      // never leave an Xvfb behind, even when the harness is interrupted
      process.once('exit', () => { try { proc.kill(); } catch (e) {} });
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(130));
      return { proc, display: `:${n}` };
    }
  }
  throw new Error('could not start Xvfb');
}

async function runPerf({ chromium, root, assets, log, reps = 3, windowMs = 4000, headless = false, trace = true, filter }) {
  let xvfb = null;
  const env = { ...process.env };
  if (!headless && !process.env.DISPLAY) {
    xvfb = await startXvfb(log);
    env.DISPLAY = xvfb.display;
  }
  const browser = await chromium.launch({ headless, env, args: PERF_ARGS });
  const bcdp = await browser.newBrowserCDPSession();
  const scenarios = SCENARIOS.filter((s) => !filter || filter.some((f) => s.name.includes(f)))
    .filter((s) => !s.needsClips || (assets.clips && assets.clips.long8000));
  const out = {
    meta: {
      windowMs, reps, headless, trace, viewport: VIEWPORT, chromium: browser.version(), args: PERF_ARGS,
      cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, loadavg: os.loadavg().map(r1),
    },
    scenarios: {},
  };
  try {
    for (const sc of scenarios) out.scenarios[sc.name] = { desc: sc.desc, runs: [] };
    // interleave repetitions so slow drifts of the machine hit every scenario
    for (let rep = 0; rep < reps; rep++) {
      for (const sc of scenarios) {
        const t0 = Date.now();
        const clean = await measureOnce(browser, bcdp, sc, { root, assets, windowMs }, false);
        const traced = trace ? await measureOnce(browser, bcdp, sc, { root, assets, windowMs }, true) : {};
        const run = { ...clean, ...traced };
        if (trace) {
          // per-frame costs: comparable even when the frame rate changes
          // (a saturated software compositor drops frames)
          const f = traced['trace.frames'];
          run['trace.cpuPerFrame_ms'] = f ? r1(clean['cpu.total_ms'] / f) : null;
          run['trace.rasterPerFrame_ms'] = f ? Math.round((traced['trace.raster_ms'] / f) * 100) / 100 : null;
          run['trace.mainTaskPerFrame_ms'] = traced['trace.mainFrames'] ? Math.round((traced['trace.mainTasks_ms'] / traced['trace.mainFrames']) * 100) / 100 : null;
        }
        out.scenarios[sc.name].runs.push(run);
        if (log) log(`  perf ${sc.name} rep ${rep + 1}/${reps}: cpu.total ${clean['cpu.total_ms']} ms (gpu ${clean['cpu.gpu_ms']}, renderer ${clean['cpu.renderer_ms']}), main task ${clean['main.TaskDuration_ms']} ms${trace ? `, ${traced['trace.frames']} frames` : ''} [${Date.now() - t0} ms]`);
      }
    }
    for (const sc of Object.values(out.scenarios)) {
      const keys = Object.keys(sc.runs[0] || {});
      sc.median = {}; sc.min = {}; sc.max = {};
      for (const k of keys) {
        const xs = sc.runs.map((r) => r[k]).filter((x) => typeof x === 'number' && Number.isFinite(x));
        sc.median[k] = median(xs);
        sc.min[k] = xs.length ? Math.min(...xs) : null;
        sc.max[k] = xs.length ? Math.max(...xs) : null;
      }
    }
  } finally {
    out.meta.loadavgEnd = os.loadavg().map(r1);
    await browser.close();
    if (xvfb) xvfb.proc.kill();
  }
  return out;
}

module.exports = { runPerf, SCENARIOS, analyseTrace };
