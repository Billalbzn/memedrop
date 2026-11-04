#!/usr/bin/env node
'use strict';
// Evidence for timing-dependent defects that cannot live in the deterministic
// transcripts (they depend on real CSS animation progress or on media
// re-buffering). Prints JSON to stdout.
//
//   node probe-bugs.js <memedrop-root> [--runs=6]

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const A = require('./lib/assets');
const { pageInit } = require('./lib/page-init');
const { BEHAVIOUR_ARGS } = require('./lib/behavior');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(process.argv[2] || '.');
const RUNS = Number((process.argv.find((a) => a.startsWith('--runs=')) || '--runs=6').split('=')[1]);
const url = 'file://' + path.join(root, 'overlay', 'src', 'overlay.html');

async function newPage(browser, seed = 7) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  // real time, real CSS animations (no settle), seeded Math.random
  await ctx.addInitScript(pageInit, { mode: 'electron', seed, t0: null, settings: { theme: 'classic' }, settle: false, hooks: true });
  const page = await ctx.newPage();
  await page.goto(url);
  return { ctx, page };
}
const drop = (page, p) => page.evaluate((p) => window.__H.fireDrop(p), p);
const S = { volume: 0.75, musicVolume: 0.75, duration: 30, videoDuration: 30, soundOnArrival: false, spotlightOnDrop: false };

async function captionProbe(browser, assets, clips) {
  const out = {};
  const { ctx, page } = await newPage(browser);
  const img = assets.png400x300;
  const cap = async (key) => page.evaluate((k) => {
    const a = document.querySelector(`#stage .anchor[data-key="${k}"]`);
    const c = a && a.querySelector('.caption-bar');
    const m = a && a.querySelector('img, video');
    return { fontSize: c && c.style.fontSize, mediaLayoutWidth: m && m.offsetWidth };
  }, key);
  // 1st drop: image not in cache yet → measured on 'load', mid entry animation
  await drop(page, { media: { url: img, kind: 'image' }, caption: 'premier', from: { username: 'a' }, settings: S });
  await sleep(700);
  out.firstDrop_uncached = await cap(1);
  // 2nd drop of the same image: decoded already → measured synchronously at
  // insertion, when the drop-in keyframe 0% (scale .6) applies
  await drop(page, { media: { url: img, kind: 'image' }, caption: 'deuxième', from: { username: 'a' }, settings: S });
  await sleep(700);
  out.secondDrop_cached = await cap(2);
  await drop(page, { media: { url: img, kind: 'image' }, caption: 'zoom', effect: 'zoom', from: { username: 'a' }, settings: S });
  await sleep(700);
  out.cached_effectZoom = await cap(3);
  await drop(page, { media: { url: img, kind: 'image' }, caption: 'tornade', effect: 'tornade', from: { username: 'a' }, settings: S });
  await sleep(900);
  out.cached_effectTornade = await cap(4);
  out.expected = { fontSize: `${Math.round(400 * 0.09)}px`, rule: 'round(displayed media width × 0.09), clamped 13..40' };
  await ctx.close();
  // video: the <video> is measured before its metadata (300×150 placeholder)
  const v = await newPage(browser);
  const vurl = await v.page.evaluate((b64) => {
    const s = atob(b64); const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: 'video/webm' }));
  }, clips.long8000.toString('base64'));
  await drop(v.page, { media: { url: vurl, kind: 'video' }, caption: 'vidéo 320x240', from: { username: 'a' }, settings: S });
  await sleep(1200);
  out.video320x240 = await v.page.evaluate(() => {
    const c = document.querySelector('.caption-bar'); const m = document.querySelector('video');
    return { fontSize: c.style.fontSize, mediaLayoutWidth: m.offsetWidth, expected: `${Math.round(m.offsetWidth * 0.09)}px` };
  });
  await v.ctx.close();
  return out;
}

async function volumeProbe(browser, assets, clips) {
  const out = { syntheticCanplay: null, natural: [] };
  const b64 = clips.long8000.toString('base64');
  const mkBlob = (page, b64, type) => page.evaluate(({ b64, type }) => {
    const s = atob(b64); const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type }));
  }, { b64, type });
  // (a) the logic: a 'canplay' after a live change restores the drop's volume
  {
    const { ctx, page } = await newPage(browser);
    const vurl = await mkBlob(page, b64, 'video/webm');
    await drop(page, { media: { url: vurl, kind: 'video' }, from: { username: 'a' }, settings: S });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 3 && !v.paused; });
    await sleep(200);
    await page.evaluate(() => window.__H.fireSettings({ volume: 0 }));
    const afterLive = await page.evaluate(() => { const v = document.querySelector('video'); return { volume: v.volume, muted: v.muted }; });
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('canplay')));
    const afterCanplay = await page.evaluate(() => { const v = document.querySelector('video'); return { volume: v.volume, muted: v.muted }; });
    out.syntheticCanplay = { dropVolume: 0.75, afterLiveVolume0: afterLive, afterCanplayEvent: afterCanplay };
    await ctx.close();
  }
  // (b) natural occurrence, in the same page setup as the behaviour harness
  // (fake clock paused, settled CSS): video + image music + audio drop + TTS
  // audio start together; live {volume: 0}; does the video stay muted?
  const { Driver } = require('./lib/driver');
  for (let i = 0; i < RUNS; i++) {
    const d = new Driver({ browser, mode: 'electron', root, assets: { static: assets, clips }, name: `vol-${i}`, pageUrl: url, viewport: { width: 1600, height: 900 } });
    await d.open();
    await d.eval(() => {
      window.__vev = [];
      new MutationObserver(() => {
        const v = document.querySelector('video');
        if (v && !v.__l) {
          v.__l = 1;
          for (const n of ['waiting', 'canplay', 'play', 'volumechange']) v.addEventListener(n, () => window.__vev.push(`${n}(vol=${v.muted ? 'muted' : v.volume})`));
        }
      }).observe(document.body, { subtree: true, childList: true });
    });
    const vurl = await d.blobUrl('v', clips.long8000, 'video/webm');
    const murl = await d.blobUrl('m', assets.wavMusic, 'audio/wav');
    const surl = await d.blobUrl('s', assets.wavLong, 'audio/wav');
    const s2 = { spotlightOnDrop: false, soundOnArrival: false };
    await d.drop({ media: { url: vurl, kind: 'video' }, from: { username: 'a' } }, s2);
    await d.drop({ media: { url: assets.png400x300, kind: 'image' }, music: { url: murl }, from: { username: 'a' } }, s2);
    await d.drop({ media: { url: surl, kind: 'audio' }, from: { username: 'b' } }, s2);
    await d.drop({ tts: 'x', ttsUrl: 'http://tts.test/long', from: { username: 'b' } }, s2);
    await d.settle();
    const n0 = await d.eval(() => window.__vev.length);
    await d.settings({ volume: 0 });
    await sleep(600);
    const r = await d.eval((n0) => { const v = document.querySelector('video'); return { volume: v.volume, muted: v.muted, eventsAfterLiveChange: window.__vev.slice(n0) }; }, n0);
    out.natural.push({ run: i + 1, muteKept: r.muted && r.volume === 0, ...r });
    await d.close();
  }
  out.naturalSummary = `${out.natural.filter((x) => !x.muteKept).length}/${out.natural.length} runs lost the live mute within 600 ms`;
  return out;
}

(async () => {
  const assets = A.buildStaticAssets();
  const browser = await chromium.launch({ args: BEHAVIOUR_ARGS });
  try {
    const rp = await browser.newPage();
    const blank = path.join(os.tmpdir(), `md-probe-${process.pid}.html`);
    fs.writeFileSync(blank, '<!doctype html><body></body>');
    await rp.goto('file://' + blank);
    const raw = await A.recordWebmClips(rp, [{ name: 'long', ms: 6600 }]);
    await rp.close();
    fs.rmSync(blank, { force: true });
    const clips = { long8000: A.patchWebmDuration(raw.long, 8000) };
    const res = {
      captionFit: await captionProbe(browser, assets, clips),
      liveVideoVolume: await volumeProbe(browser, assets, clips),
    };
    console.log(JSON.stringify(res, null, 1));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
