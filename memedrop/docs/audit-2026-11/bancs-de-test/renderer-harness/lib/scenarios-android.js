'use strict';
// Behaviour scenarios — Android mode: overlay.html rebuilt like the Gradle
// task syncWebAssets (android-shim.js injected before overlay.js), fake
// window.MDOverlay.rects() recorder, driven through window.__mdDrop /
// __mdSettings / __mdDropCtl like OverlayController.kt. Phone viewport
// 412x915 @ 2.625.

const { ANDROID_DROP_SETTINGS } = require('./driver');

const ALICE = { id: '1001', username: 'alice' };

function image(d, name = 'png400x300', extra = {}) {
  return { media: { url: d.asset(name), kind: 'image', mime: 'image/png', name: `${name}.png`, size: 1 }, from: { ...ALICE }, ...extra };
}

// Hard geometry facts: is each drop (layout box) fully on screen with the
// paddings clampCenter() promises (20 px sides, 48 px top, 20 px bottom)?
async function fitFacts(d) {
  return d.eval(() => [...document.querySelectorAll('#stage .anchor')].map((a) => {
    const dr = a.querySelector('.drop');
    const hw = dr.offsetWidth / 2, hh = dr.offsetHeight / 2;
    const x = a.offsetLeft, y = a.offsetTop;
    const W = window.innerWidth, H = window.innerHeight;
    return {
      key: a.dataset.key,
      size: [dr.offsetWidth, dr.offsetHeight],
      insideX: x - hw >= 20 - 1 && x + hw <= W - 20 + 1,
      insideY: y - hh >= 48 - 1 && y + hh <= H - 20 + 1,
    };
  }));
}
async function anchorStyle(d) {
  return d.eval(() => Object.fromEntries([...document.querySelectorAll('#stage .anchor')].map((a) => [a.dataset.key, [a.style.left, a.style.top]])));
}

// OverlayController.onPageFinished(): __mdSettings(Prefs.dropSettings()) first.
async function boot(d, settings) {
  await d.settings({ ...ANDROID_DROP_SETTINGS, ...(settings || {}) });
}

const scenarios = [
  {
    name: 'android-load-idle',
    desc: 'Boot: settings pushed, the 120 ms reporter sends one empty rect list, then nothing while idle.',
    async run(d) {
      await boot(d);
      await d.check('booted', { computed: true });
      await d.advance(120);
      await d.check('first report (empty)', { dom: false });
      await d.advance(5000);
      await d.check('idle: no more reports', { dom: false });
    },
  },
  {
    name: 'android-image',
    desc: 'Image drop on a phone: mobile CSS (close always visible, no reaction bar), rect reported with key/x/y/w/h, removed after 4 s, reports stop.',
    async run(d) {
      await boot(d);
      await d.drop(image(d, 'png400x300', { caption: 'sur le téléphone', dropId: 'a-1', from: { ...ALICE, avatar: d.asset('avatar64') } }));
      await d.settle();
      await d.check('shown', { computed: true });
      await d.advance(120);
      await d.check('rect reported, drop fitted on screen', { extra: await fitFacts(d) });
      await d.advance(240);
      await d.check('unchanged → not re-sent', { dom: false });
      await d.advance(3640);
      await d.check('t=4000 leaving', { dom: false });
      await d.advance(120);
      await d.check('leaving drop no longer reported', { dom: false });
      await d.advance(280);
      await d.check('t=4400 removed', { dom: false });
      await d.advance(3000);
      await d.check('idle: no reports', { dom: false });
    },
  },
  {
    name: 'android-move-close',
    desc: '__mdDropCtl.move (clamped to the screen), close (smooth), unknown keys ignored; rects follow.',
    async run(d) {
      await boot(d);
      await d.drop(image(d, 'png200x500'), { duration: 30 });
      await d.drop(image(d, 'png100x80'), { duration: 30 });
      await d.settle();
      await d.advance(120);
      await d.check('two rects', { dom: false, extra: await fitFacts(d) });
      await d.eval(() => window.__mdDropCtl.move('1', 100, 200));
      await d.advance(120);
      await d.check('move 1 → (100,200) clamped', { dom: false, extra: await anchorStyle(d) });
      await d.eval(() => window.__mdDropCtl.move('1', -1000, 5000));
      await d.advance(120);
      await d.check('move 1 far off-screen → clamped to bottom-left', { dom: false, extra: await anchorStyle(d) });
      await d.eval(() => window.__mdDropCtl.move('2', 206, 457.5));
      await d.advance(120);
      await d.check('move 2 → centre', { extra: await anchorStyle(d) });
      await d.eval(() => window.__mdDropCtl.close('2'));
      await d.check('close 2 → closing', { dom: false, extra: await d.eval(() => [...document.querySelectorAll('#stage .drop')].map((x) => [...x.classList].sort().join(' '))) });
      await d.advance(120);
      await d.check('closing drop dropped from the report', { dom: false });
      await d.advance(100);
      await d.check('t+220 removed');
      await d.eval(() => { window.__mdDropCtl.close('99'); window.__mdDropCtl.move('99', 1, 1); window.__mdDropCtl.close(2); window.__mdDropCtl.fit('1'); });
      await d.advance(120);
      await d.check('unknown / removed keys ignored, fit idempotent', { dom: false, extra: await anchorStyle(d) });
    },
  },
  {
    name: 'android-fit-large',
    desc: 'Large image (1200x900 → 78vw) and portrait image: re-fitted on screen once loaded; video rect after metadata, removed at end.',
    async run(d) {
      await boot(d);
      await d.drop(image(d, 'png1200x900', { caption: 'grande' }), { duration: 30 });
      await d.drop(image(d, 'png200x500', { caption: 'haute' }), { duration: 30 });
      await d.settle();
      await d.advance(120);
      await d.check('fitted', { extra: await fitFacts(d), computed: true });
      const url = await d.blobUrl('webm2000', d.assets.clips.short2000, 'video/webm');
      await d.drop({ media: { url, kind: 'video', mime: 'video/webm', name: 'v.webm', size: 1 }, from: { ...ALICE } });
      await d.settle();
      await d.advance(120);
      await d.check('video rect', { dom: false, extra: await fitFacts(d) });
      await d.waitFor(() => !!document.querySelector('.anchor[data-key="3"] .drop.leaving'), null, { timeout: 8000, label: 'video ended' });
      await d.advance(120);
      await d.check('video ended → not reported', { dom: false });
      await d.advance(400);
      await d.check('video removed', { dom: false });
    },
  },
  {
    name: 'android-test-drop',
    desc: 'Test drop from MemeDropService.testDrop() (SVG placeholder) on a phone.',
    async run(d) {
      await boot(d);
      await d.drop({
        media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
        caption: 'TEST DROP', from: { id: '0', username: 'Toi (test)' },
      });
      await d.settle();
      await d.advance(120);
      await d.check('shown + reported', { computed: true, extra: await fitFacts(d) });
    },
  },
  {
    name: 'android-settings-live',
    desc: '__mdSettings patch: opacity / theme / volume applied live; spotlight off by default on Android.',
    async run(d) {
      await boot(d);
      await d.drop(image(d), { duration: 30 });
      await d.settle();
      await d.advance(120);
      await d.check('default (no spotlight)', { dom: true });
      await d.settings({ opacity: 0.5, theme: 'neon' });
      await d.check('opacity + theme', { computed: true });
      await d.settings({ duration: 1 });
      await d.check('t=120 duration→1 s: rescheduled, 880 ms left');
      await d.advanceTo(1000);
      await d.check('t=1000 leaving', { dom: false });
      await d.advanceTo(1440);
      await d.check('t=1440 removed, empty report', { dom: false });
    },
  },
  {
    name: 'android-tts-rain',
    desc: 'TTS-only + rain on Android: speech fallback once, rain particles, no rect.',
    async run(d) {
      await boot(d);
      await d.drop({ tts: 'bonjour', ttsUrl: 'http://unreachable.test/tts?text=bonjour', rain: ['🎉'], from: { ...ALICE } });
      await d.settle();
      await d.waitFor(() => window.__H.speech.length > 0, null, { timeout: 5000, label: 'speech fallback' });
      await d.realWait(400);
      await d.check('spoken once, rain, toast', { rainPool: ['🎉'] });
      await d.advance(120);
      await d.check('no rect for non-visual drops', { dom: false });
      await d.advance(5400);
      await d.check('all gone', { dom: false });
    },
  },
  {
    name: 'android-rapid',
    desc: '8 drops at once on Android: 6 rects, queued drops get new keys when slots free up.',
    async run(d) {
      await boot(d);
      for (let i = 0; i < 8; i++) await d.drop(image(d, 'png100x80', { caption: `#${i + 1}` }));
      await d.settle();
      await d.advance(120);
      await d.check('6 rects', { dom: false });
      await d.advance(4280);
      await d.settle();
      await d.advance(120);
      await d.check('queued drops reported (keys 7, 8)', { dom: false });
      await d.advance(4400);
      await d.check('all removed', { dom: false });
    },
  },
];

module.exports = { scenarios };
