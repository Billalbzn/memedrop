'use strict';
// Behaviour scenarios — Electron mode (overlay.html + fake window.memedrop).
// Viewport 1600x900. Every scenario runs in a fresh page whose fake clock is
// paused at t = 0; time only moves through d.advance(). Real-time waits are
// used only for media events (load / error / ended / timeupdate).

const SIZES = {
  png400x300: [400, 300], png200x500: [200, 500], png1200x900: [1200, 900], png100x80: [100, 80],
};
const ALICE = { id: '1001', username: 'alice' };
const BOB = { id: '1002', username: 'bob' };

function image(d, name = 'png400x300', extra = {}) {
  const [w, h] = SIZES[name] || [null, null];
  return {
    media: { url: d.asset(name), kind: 'image', mime: 'image/png', name: `${name}.png`, size: 4321, width: w, height: h },
    caption: null, from: { ...ALICE }, ...extra,
  };
}
function withAvatar(from, d) { return { ...from, avatar: d.asset('avatar64') }; }

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const r2 = (v) => Math.round(v * 100) / 100;

// Point inside drop `key`'s box that no earlier drop (DOM order) would claim
// through findDropAt-like margins — so a cursor there targets `key` itself.
async function freePointIn(d, key) {
  return d.eval((key) => {
    const anchors = [...document.querySelectorAll('#stage .anchor')];
    const idx = anchors.findIndex((a) => a.dataset.key === String(key));
    if (idx < 0) return null;
    const r = anchors[idx].querySelector('.drop').getBoundingClientRect();
    const earlier = anchors.slice(0, idx).map((a) => a.querySelector('.drop').getBoundingClientRect());
    const claimed = (x, y) => earlier.some((e) => x >= e.left - 16 && x <= e.right + 16 && y >= e.top - 16 && y <= e.bottom + 42);
    for (let fy = 0.5, i = 0; i < 9; i++) {
      for (let fx = 0.5, j = 0; j < 9; j++) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (!claimed(x, y)) return { x, y };
        fx = 0.5 + (j % 2 ? -1 : 1) * Math.ceil((j + 1) / 2) * 0.1;
      }
      fy = 0.5 + (i % 2 ? -1 : 1) * Math.ceil((i + 1) / 2) * 0.1;
    }
    return null;
  }, key);
}

// Hover a drop through the cursor IPC (what main.js does every 16 ms).
async function hover(d, key, label) {
  const p = await freePointIn(d, key);
  if (!p) { d.action(`${label}: no free point`); return null; }
  await d.page.mouse.move(p.x, p.y);
  const ipc = await d.cursorIpc(p.x, p.y);
  d.action(`${label}: cursor over drop ${key} (ipc ${ipc})`);
  return p;
}
async function hoveredKeys(d) {
  return d.eval(() => [...document.querySelectorAll('#stage .drop.hover')].map((x) => x.parentElement.dataset.key));
}

const scenarios = [
  // ────────────────────────────────────────────────────────────────────────
  {
    name: 'load-idle',
    desc: 'Page load: listeners registered, getSettings() theme applied, nothing scheduled while idle.',
    settings: { theme: 'mono' },
    async run(d) {
      await d.check('loaded', { computed: true });
      await d.advance(10000);
      await d.check('idle +10s');
    },
  },
  {
    name: 'image-basic',
    desc: 'Image drop (avatar, dropId → reactions): appears, spotlight, pop, life bar, leaves at 4 s, removed at 4.4 s, stageEmpty.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { from: withAvatar(ALICE, d), dropId: 'img-1' }));
      await d.settle();
      await d.check('shown', { computed: true });
      await d.advance(16);
      await d.check('first spotlight frame');
      await d.advance(3983);
      await d.check('t=3999 still shown', { dom: false });
      await d.advance(1);
      await d.check('t=4000 leaving', { computed: true });
      await d.advance(399);
      await d.check('t=4399 still in DOM', { dom: false });
      await d.advance(1);
      await d.check('t=4400 removed');
      await d.advance(2000);
      await d.check('idle after removal');
    },
  },
  {
    name: 'caption-fit',
    desc: 'Caption font size fitted to the displayed media width (13..40 px), trimming / 80-char truncation.',
    async run(d) {
      const s = { duration: 30, spotlightOnDrop: false, soundOnArrival: false };
      await d.drop(image(d, 'png400x300', { caption: '  quand le build passe du premier coup  ' }), s);
      await d.drop(image(d, 'png200x500', { caption: 'portrait étroit' }), s);
      await d.drop(image(d, 'png1200x900', { caption: 'grande image redimensionnée' }), s);
      await d.drop(image(d, 'png100x80', { caption: 'mini' }), s);
      await d.drop(image(d, 'png400x300', { caption: 'MOT'.repeat(40) }), s);
      await d.drop(image(d, 'png400x300', { caption: '   ' }), s);
      await d.settle();
      await d.check('captions fitted', { computed: true });
      await d.advance(32);
      await d.check('after rAF retries', { dom: false });
    },
  },
  {
    name: 'test-drop',
    desc: 'Settings "test" drop (media.kind = test, SVG placeholder, no avatar image → initial).',
    async run(d) {
      await d.drop({
        media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
        caption: 'TEST DROP', from: { id: '0', username: 'You (test)' },
      });
      await d.settle();
      await d.check('shown', { computed: true });
      await d.advance(4000);
      await d.check('t=4000 leaving', { dom: false });
      await d.advance(400);
      await d.check('removed');
    },
  },
  {
    name: 'gif-drop',
    desc: 'Animated GIF drop with caption; kind "gif" is shown like an image.',
    async run(d) {
      await d.drop({
        media: { url: d.asset('gif240x180'), kind: 'gif', mime: 'image/gif', name: 'loop.gif', size: 999, width: 240, height: 180 },
        caption: 'boucle', from: { ...BOB }, dropId: 'gif-1',
      }, { duration: 6 });
      await d.settle();
      await d.check('shown', { computed: true });
      await d.advance(6000);
      await d.check('t=6000 leaving', { dom: false });
      await d.advance(400);
      await d.check('removed', { dom: false });
    },
  },
  {
    name: 'music-with-image',
    desc: 'Image + music: music plays at musicVolume, is paused when the image leaves; music is ignored for non image/gif media.',
    async run(d) {
      const music = await d.blobUrl('wavMusic', d.asset('wavMusic'), 'audio/wav');
      const music2 = await d.blobUrl('wavMusic#2', d.asset('wavMusic'), 'audio/wav');
      await d.drop({ ...image(d), music: { url: music, mime: 'audio/wav', name: 'song.wav', size: 1 } },
        { musicVolume: 0.4, volume: 0.9, spotlightOnDrop: false });
      await d.drop({
        media: { url: 'about:blank', kind: 'test', mime: 'test/test', name: 'test.png', size: 0 },
        music: { url: music2, mime: 'audio/wav', name: 'ignored.wav', size: 1 }, from: { ...BOB },
      }, { spotlightOnDrop: false, duration: 2 });
      await d.settle();
      await d.check('image + music playing', { computed: false });
      await d.advance(2000);
      await d.check('t=2000 test drop leaving', { dom: false });
      await d.advance(2000);
      await d.check('t=4000 image leaving, music paused');
      await d.advance(400);
      await d.check('removed');
    },
  },
  {
    name: 'rain-only',
    desc: 'Emoji rain without media: 38 particles, random but bounded parameters, all removed by 5.3 s; no slot, no stageEmpty.',
    async run(d) {
      const pool = ['🎉', '🔥', '💀'];
      await d.drop({ rain: pool, from: { ...ALICE } });
      await d.check('rain started', { rainPool: pool, computed: true });
      await d.advance(1699);
      await d.check('t=1699 (before earliest possible removal)', { rainPool: pool });
      await d.advance(1801);
      await d.check('t=3500 (particles left depend on the random timings)', { rainPool: pool, rainSoft: true });
      await d.advance(1800);
      await d.check('t=5300 all removed');
      await d.advance(2000);
      await d.check('idle', { dom: false });
    },
  },
  {
    name: 'rain-variants',
    desc: 'Rain as a single string (legacy), as an empty array, and together with an image drop.',
    async run(d) {
      await d.drop({ rain: '🥳', from: { ...ALICE } }, { soundOnArrival: false });
      await d.check('string rain', { rainPool: ['🥳'] });
      await d.advance(5400);
      await d.check('string rain gone', { dom: false });
      await d.drop({ rain: [], from: { ...ALICE } });
      await d.check('empty array rain');
      await d.drop({ ...image(d), rain: ['😂'] }, { spotlightOnDrop: false });
      await d.settle();
      await d.check('image + rain', { rainPool: ['😂'] });
      await d.advance(5400);
      await d.check('all gone');
    },
  },
  {
    name: 'tts-unreachable',
    desc: 'TTS only, ttsUrl unreachable → speechSynthesis fallback spoken exactly once; toast 3 s; no slot.',
    async run(d) {
      await d.drop({ tts: 'Salut tout le monde', ttsUrl: 'http://unreachable.test/tts?text=Salut', from: { ...BOB } });
      await d.settle();
      await d.waitFor(() => window.__H.speech.length > 0, null, { timeout: 5000, label: 'speech fallback' });
      await d.realWait(400);   // a duplicate (error + play() rejection) would land here
      await d.check('fallback spoken, toast shown', { computed: true });
      await d.advance(2999);
      await d.check('t=2999', { dom: false });
      await d.advance(1);
      await d.check('t=3000 toast leaving');
      await d.advance(300);
      await d.check('t=3300 toast removed');
    },
  },
  {
    name: 'tts-no-url-long',
    desc: 'TTS without ttsUrl → speechSynthesis immediately; text sliced (200 spoken / 120 shown); toast 12 s cap.',
    async run(d) {
      const text = 'Bla '.repeat(70).trim();
      await d.drop({ tts: text, ttsUrl: null, from: { ...ALICE } }, { volume: 0.4 });
      await d.check('spoken immediately', { computed: true });
      await d.advance(11999);
      await d.check('t=11999', { dom: false });
      await d.advance(1);
      await d.check('t=12000 leaving', { dom: false });
      await d.advance(300);
      await d.check('removed');
    },
  },
  {
    name: 'tts-reachable',
    desc: 'TTS with a working ttsUrl: server audio played at volume, no speechSynthesis fallback.',
    async run(d) {
      await d.drop({ tts: 'ok', ttsUrl: 'http://tts.test/tts?text=ok', from: { ...BOB } }, { volume: 0.5 });   // 1.5 s of audio
      await d.settle();
      await d.check('audio playing');
      await d.waitFor(() => window.__H.mediaEls.every((m) => m.ended || m.error), null, { timeout: 6000, label: 'tts audio ended' });
      await d.realWait(100);
      await d.check('audio ended, still no fallback', { dom: false });
    },
  },
  {
    name: 'audio-drop',
    desc: 'Audio drop (blob WAV): top toast with avatar + caption, plays at musicVolume, no cursor watch; on end → toast leaves, slot released → stageEmpty.',
    async run(d) {
      const url = await d.blobUrl('wavMid', d.asset('wavMid'), 'audio/wav');
      await d.drop({
        media: { url, kind: 'audio', mime: 'audio/wav', name: 'son.wav', size: 1 },
        caption: '  écoute ça  ', from: withAvatar(ALICE, d),
      }, { musicVolume: 0.6, volume: 0.9 });
      await d.settle();
      await d.check('playing', { computed: true });
      await d.waitFor(() => !!document.querySelector('.audio-toast.leaving'), null, { timeout: 8000, label: 'audio ended' });
      await d.check('ended → toast leaving');
      await d.advance(299);
      await d.check('t+299', { dom: false });
      await d.advance(1);
      await d.check('t+300 removed, stageEmpty');
    },
  },
  {
    name: 'audio-drop-error',
    desc: 'Audio drop with unreachable URL: error → toast leaves → released once.',
    async run(d) {
      await d.drop({
        media: { url: 'http://unreachable.test/son.mp3', kind: 'audio', mime: 'audio/mpeg', name: 'son.mp3', size: 1 },
        caption: null, from: { ...BOB },
      }, { soundOnArrival: false });
      await d.settle();
      await d.realWait(200);
      await d.check('error → leaving');
      await d.advance(300);
      await d.check('removed');
      await d.advance(1000);
      await d.check('idle', { dom: false });
    },
  },
  {
    name: 'video-ends',
    desc: 'Video (WebM declaring 2 s, content ~1.6 s): life bar = duration + 300 ms, caption size, removed when playback ends.',
    async run(d) {
      const url = await d.blobUrl('webm2000', d.assets.clips.short2000, 'video/webm');
      await d.drop({
        media: { url, kind: 'video', mime: 'video/webm', name: 'clip.webm', size: 1 },
        caption: 'regarde ça', from: { ...BOB }, dropId: 'vid-1',
      }, { spotlightOnDrop: false, volume: 0.65 });
      await d.settle();
      await d.check('metadata loaded, playing', { computed: true });
      await d.waitFor(() => !!document.querySelector('.drop.leaving'), null, { timeout: 8000, label: 'video ended' });
      await d.check('ended → leaving');
      await d.advance(399);
      await d.check('t+399', { dom: false });
      await d.advance(1);
      await d.check('t+400 removed');
    },
  },
  {
    name: 'video-no-duration',
    desc: 'Video straight from MediaRecorder (no Duration element → duration Infinity at loadedmetadata): lifetime = cap + 300 ms, removed at end.',
    async run(d) {
      const url = await d.blobUrl('webmRaw', d.assets.clips.rawMed, 'video/webm');
      await d.drop({ media: { url, kind: 'video', mime: 'video/webm', name: 'rec.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, videoDuration: 20 });
      await d.settle();
      await d.check('metadata loaded');
      await d.waitFor(() => !!document.querySelector('.drop.leaving'), null, { timeout: 8000, label: 'video ended' });
      await d.check('ended → leaving', { dom: false });
      await d.advance(400);
      await d.check('removed', { dom: false });
    },
  },
  {
    name: 'video-cap-playback',
    desc: 'Video longer than videoDuration (8 s file, cap 2 s): stopped by the playback-time check (timeupdate) and removed.',
    async run(d) {
      const url = await d.blobUrl('webm8000', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url, kind: 'video', mime: 'video/webm', name: 'long.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, videoDuration: 2 });
      await d.settle();
      await d.check('metadata loaded (lifetime 2300 ms on the paused clock)');
      await d.waitFor(() => !!document.querySelector('.drop.leaving'), null, { timeout: 8000, label: 'video capped' });
      await d.check('capped by playback time → leaving, paused');
      await d.advance(400);
      await d.check('removed', { dom: false });
    },
  },
  {
    name: 'video-cap-timer',
    desc: 'Video capped by the removal timer (4 s file, cap 2 s → lifetime 2300 ms on the fake clock).',
    async run(d) {
      const url = await d.blobUrl('webm4000', d.assets.clips.med4000, 'video/webm');
      await d.drop({ media: { url, kind: 'video', mime: 'video/webm', name: 'long.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, videoDuration: 2, soundOnArrival: false });
      await d.settle();
      await d.check('metadata loaded', { dom: false });
      await d.advance(2299);
      await d.check('t=2299 still shown');
      await d.advance(1);
      await d.check('t=2300 leaving, paused');
      await d.advance(400);
      await d.check('removed', { dom: false });
    },
  },
  {
    name: 'video-unreachable',
    desc: 'Video with an unreachable URL: error → smooth close (220 ms) → removed, slot released.',
    async run(d) {
      await d.drop({ media: { url: 'http://unreachable.test/clip.mp4', kind: 'video', mime: 'video/mp4', name: 'clip.mp4', size: 1 }, from: { ...ALICE } });
      await d.settle();
      await d.check('error → closing', { computed: true });
      await d.advance(219);
      await d.check('t+219', { dom: false });
      await d.advance(1);
      await d.check('t+220 removed');
    },
  },
  {
    name: 'video-stalled',
    desc: 'Video whose server never answers: removed by the 15 s load watchdog.',
    async run(d) {
      await d.drop({ media: { url: 'http://hang.test/clip.mp4', kind: 'video', mime: 'video/mp4', name: 'clip.mp4', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false });
      await d.settle({ media: false });
      await d.check('loading');
      await d.advance(14999);
      await d.check('t=14999 still there', { dom: false });
      await d.advance(1);
      await d.check('t=15000 closing');
      await d.advance(220);
      await d.check('removed', { dom: false });
    },
  },
  {
    name: 'image-bad-url',
    desc: 'Image whose URL answers 404: error → smooth close → removed.',
    async run(d) {
      await d.drop({ media: { url: 'http://media.test/404/meme.png', kind: 'image', mime: 'image/png', name: 'meme.png', size: 1 }, caption: 'perdu', from: { ...ALICE } });
      await d.settle();
      await d.check('error → closing');
      await d.advance(220);
      await d.check('removed');
    },
  },
  {
    name: 'rapid-8',
    desc: '8 drops at once: 6 shown (MAX_CONCURRENT), 2 queued and shown as slots free up; one stageEmpty at the very end.',
    async run(d) {
      for (let i = 0; i < 8; i++) await d.drop(image(d, 'png400x300', { caption: `#${i + 1}` }), { soundOnArrival: i === 0 });
      await d.settle();
      await d.check('6 shown, 2 queued');
      await d.advance(4000);
      await d.check('t=4000 six leaving', { dom: false });
      await d.advance(400);
      await d.settle();
      await d.check('t=4400 queued drops shown');
      await d.advance(4400);
      await d.check('t=8800 all removed');
    },
  },
  {
    name: 'queue-overflow-20',
    desc: '20 drops at once: 6 shown, 12 queued (MAX_QUEUE), 2 discarded; 18 anchors in total.',
    async run(d) {
      for (let i = 0; i < 20; i++) await d.drop(image(d, 'png100x80', { caption: `${i + 1}` }), { soundOnArrival: false, spotlightOnDrop: false });
      await d.settle();
      await d.check('t=0', { dom: false, extra: await d.eval(() => ({ keys: [...document.querySelectorAll('#stage .anchor')].map((a) => a.dataset.key) })) });
      for (const t of [4400, 8800, 13200]) {
        await d.advance(4400);
        await d.settle();
        await d.check(`t=${t}`, { dom: false, extra: await d.eval(() => ({ keys: [...document.querySelectorAll('#stage .anchor')].map((a) => a.dataset.key), captions: [...document.querySelectorAll('.caption-bar')].map((c) => c.textContent) })) });
      }
    },
  },
  {
    name: 'queue-tts-deferred',
    desc: 'A queued drop carrying TTS only speaks when it is actually shown (not when queued).',
    async run(d) {
      for (let i = 0; i < 6; i++) await d.drop(image(d), { soundOnArrival: false, spotlightOnDrop: false });
      await d.drop({ ...image(d), tts: 'mon tour', ttsUrl: null }, { soundOnArrival: false, spotlightOnDrop: false });
      await d.drop({ rain: ['⭐'], from: { ...BOB } }, { soundOnArrival: false });
      await d.settle();
      await d.check('7th queued, rain not queued', { dom: false, extra: await d.eval(() => ({ anchors: document.querySelectorAll('#stage .anchor').length, rain: document.querySelectorAll('.rain-emoji').length })) });
      await d.advance(4400);
      await d.settle();
      await d.check('slot freed → queued drop shown and spoken', { dom: false });
    },
  },
  {
    name: 'close-button',
    desc: 'Close button: click-through while not captured; hover → capture; mousedown on ✕ → smooth close, capture released, stageEmpty.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { dropId: 'cl-1', from: withAvatar(BOB, d) }), { duration: 30 });
      await d.settle();
      await d.advance(16);
      await d.check('shown', { dom: false });
      const x0 = await d.centerOf(1, '.drop-close');
      // the pointer reaches the ✕ but the 16 ms cursor poll has not reported it yet
      await d.page.mouse.move(x0.x, x0.y);
      d.action(`mousedown on ✕ before the cursor poll: ${await d.mouseDown()}`);
      d.action(`mouseup: ${await d.mouseUp()}`);
      await d.check('not captured → click went through', { dom: false, extra: { anchors: await d.eval(() => document.querySelectorAll('#stage .anchor').length), hovered: await hoveredKeys(d) } });
      d.action(`cursor poll over ✕: ${await d.cursorIpc(x0.x, x0.y)}`);
      await d.check('hovered → capture, ✕ visible', { computed: true });
      d.action(`mousedown on ✕: ${await d.mouseDown()}`);
      d.action(`mouseup: ${await d.mouseUp()}`);
      await d.check('closing', { computed: true });
      await d.advance(219);
      await d.check('t+219', { dom: false });
      await d.advance(1);
      await d.check('t+220 removed');
    },
  },
  {
    name: 'reaction',
    desc: 'Reaction bar: one reactDrop(dropId, emoji) per drop, later clicks ignored; no bar without dropId.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { dropId: 'drop-42', from: withAvatar(ALICE, d) }), { duration: 30, spotlightOnDrop: false });
      await d.settle();
      await hover(d, 1, 'hover');
      const b1 = await d.centerOf(1, '.react-btn:nth-child(1)');
      await d.page.mouse.move(b1.x, b1.y);
      d.action(`hit-test keeps capture over the bar: ${JSON.stringify(await hoveredKeys(d))}`);
      d.action(`mousedown 😂: ${await d.mouseDown()}`);
      await d.mouseUp();
      await d.check('reacted once', { computed: true });
      const b3 = await d.centerOf(1, '.react-btn:nth-child(3)');
      await d.page.mouse.move(b3.x, b3.y);
      d.action(`mousedown 🔥: ${await d.mouseDown()}`);
      await d.mouseUp();
      await d.check('second reaction ignored', { computed: true });
      await d.drop(image(d, 'png100x80', { from: { ...BOB } }), { duration: 30, spotlightOnDrop: false });
      await d.settle();
      await d.check('drop without dropId has no bar', { dom: false, extra: await d.eval(() => [...document.querySelectorAll('#stage .anchor')].map((a) => ({ key: a.dataset.key, bar: !!a.querySelector('.react-bar') }))) });
    },
  },
  {
    name: 'live-settings-visual',
    desc: 'Live settings: opacity (clamped 0.2..1) on drops and toasts, theme, spotlight off/on.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { from: withAvatar(ALICE, d) }), { duration: 30 });
      await d.drop(image(d, 'png200x500', { from: { ...BOB } }), { duration: 30 });
      await d.drop({ tts: 'coucou', ttsUrl: null, from: { ...BOB } }, { soundOnArrival: false });
      await d.settle();
      await d.advance(16);
      await d.check('initial', { computed: true });
      await d.settings({ opacity: 0.5 });
      await d.check('opacity 0.5', { computed: true });
      await d.settings({ opacity: 0.05 });
      await d.check('opacity 0.05 → clamped 0.2', { dom: true });
      await d.settings({ opacity: '0.7' });
      await d.check('opacity as string → ignored', { dom: true });
      await d.settings({ theme: 'fire' });
      await d.check('theme fire', { computed: true });
      await d.settings({ spotlightOnDrop: false });
      await d.check('spotlight off');
      await d.advance(100);
      await d.check('spotlight stays off', { dom: true });
      await d.settings({ spotlightOnDrop: true });
      await d.advance(100);
      await d.check('spotlight true → no live effect', { dom: true });
      await d.drop(image(d, 'png100x80', { from: { ...ALICE } }), { duration: 30, spotlightOnDrop: true });
      await d.settle();
      await d.advance(16);
      await d.check('new drop brings the spotlight back');
    },
  },
  {
    name: 'spotlight-stack',
    desc: 'Spotlight follows the newest drop, falls back to the previous one when it leaves, switches off (rAF stopped) when none is left.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { caption: 'A' }), { duration: 10, soundOnArrival: false });
      await d.drop(image(d, 'png100x80', { caption: 'B' }), { duration: 2, soundOnArrival: false });
      await d.drop(image(d, 'png200x500', { caption: 'C (no spotlight)' }), { duration: 4, spotlightOnDrop: false, soundOnArrival: false });
      await d.settle();
      await d.advance(16);
      await d.check('B (newest with spotlight) is lit');
      await d.advance(2400 - 16);
      await d.advance(16);
      await d.check('B removed → A lit');
      await d.advance(10400 - 2416);
      await d.check('A removed → spotlight off, nothing scheduled');
    },
  },
  {
    name: 'live-settings-duration',
    desc: 'Live "Image duration": images rescheduled from their start time, removed at once when already past.',
    async run(d) {
      const s = { spotlightOnDrop: false, soundOnArrival: false };
      await d.drop(image(d, 'png400x300', { caption: 'A' }), s);
      await d.advance(1000);
      await d.drop(image(d, 'png200x500', { caption: 'B' }), s);
      await d.settle();
      await d.advance(1000);
      await d.settings({ duration: 3 });
      await d.check('t=2000 duration→3 (A: 1000 left, B: 2000 left)');
      await d.advance(999);
      await d.check('t=2999', { dom: false });
      await d.advance(1);
      await d.check('t=3000 A leaving');
      await d.settings({ duration: 1 });
      await d.check('t=3000 duration→1: B already past → leaving now');
      await d.advance(400);
      await d.check('t=3400 all removed');
      await d.drop(image(d, 'png100x80', { caption: 'C' }), { ...s, duration: 2 });
      await d.settle();
      await d.settings({ duration: 10 });
      await d.check('C extended to 10 s');
      await d.advance(9999);
      await d.check('C t+9999', { dom: false });
      await d.advance(1);
      await d.check('C t+10000 leaving', { dom: false });
    },
  },
  {
    name: 'live-settings-volume',
    desc: 'Live volume: "volume" → videos only; "musicVolume" → audio drops + image music; TTS audio untouched; 0 → muted. ' +
      '(The video here never receives data: a playing video re-applies its initial volume on every canplay/play event, ' +
      'which makes a playing video racy — see the bug report.)',
    async run(d) {
      const music = await d.blobUrl('wavMusic', d.asset('wavMusic'), 'audio/wav');
      const song = await d.blobUrl('wavLong', d.asset('wavLong'), 'audio/wav');
      const s = { spotlightOnDrop: false, soundOnArrival: false };
      await d.drop({ media: { url: 'http://hang.test/v.mp4', kind: 'video', mime: 'video/mp4', name: 'v.mp4', size: 1 }, from: { ...ALICE } }, s);
      await d.drop({ ...image(d), music: { url: music, mime: 'audio/wav', name: 'm.wav', size: 1 } }, s);
      await d.drop({ media: { url: song, kind: 'audio', mime: 'audio/wav', name: 's.wav', size: 1 }, from: { ...BOB } }, s);
      await d.drop({ tts: 'test volume', ttsUrl: 'http://tts.test/long?text=v', from: { ...BOB } }, s);
      await d.waitFor(() => [...document.images].every((i) => i.complete) &&
        window.__H.mediaEls.length === 3 && window.__H.mediaEls.every((m) => !m.paused && m.readyState >= 3), null, { timeout: 8000, label: 'audio playing' });
      await d.realWait(150);
      await d.check('initial volumes');
      await d.settings({ volume: 0.3 });
      await d.check('volume 0.3');
      await d.settings({ volume: 0 });
      await d.check('volume 0 → video muted');
      await d.settings({ musicVolume: 0.2 });
      await d.check('musicVolume 0.2');
      await d.settings({ musicVolume: 0, volume: 1 });
      await d.check('musicVolume 0, volume 1');
    },
  },
  {
    name: 'video-volume-initial',
    desc: 'A playing video gets the "volume" of its drop settings (no live change here).',
    async run(d) {
      const vid = await d.blobUrl('webm8000', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url: vid, kind: 'video', mime: 'video/webm', name: 'v.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, soundOnArrival: false, volume: 0.35 });
      await d.settle();
      await d.check('playing at 0.35');
      const vid0 = await d.blobUrl('webm8000#2', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url: vid0, kind: 'video', mime: 'video/webm', name: 'v0.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, soundOnArrival: false, volume: 0 });
      await d.settle();
      await d.check('second video with volume 0 → muted');
    },
  },
  {
    name: 'live-settings-videoDuration',
    desc: 'Live "Video max duration": shorter than elapsed → stop now; longer → rescheduled (min(natural, cap)).',
    async run(d) {
      const s = { spotlightOnDrop: false, soundOnArrival: false };
      const vid = await d.blobUrl('webm8000', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url: vid, kind: 'video', mime: 'video/webm', name: 'v.webm', size: 1 }, from: { ...ALICE } }, s);
      await d.settle();
      await d.check('video 1 loaded (lifetime 8300)');
      await d.advance(2000);
      await d.settings({ videoDuration: 1 });
      await d.check('t=2000 cap→1 s: stopped now');
      await d.advance(400);
      await d.check('removed', { dom: false });
      const vid2 = await d.blobUrl('webm8000#2', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url: vid2, kind: 'video', mime: 'video/webm', name: 'v2.webm', size: 1 }, from: { ...ALICE } }, s);
      await d.settle();
      await d.advance(1000);
      await d.settings({ videoDuration: 3 });
      await d.check('video 2: cap→3 s at 1 s → 2000 ms left');
      await d.advance(1999);
      await d.check('t+1999', { dom: false });
      await d.advance(1);
      await d.check('t+2000 leaving');
      await d.settings({ videoDuration: 30, duration: 1 });
      await d.check('later updates do not touch a leaving drop', { dom: false });
    },
  },
  {
    name: 'live-videoDuration-increase',
    desc: 'Raising "Video max duration" live (2 s → 30 s) while a ~6.6 s video plays: does the video keep playing past 2 s?',
    async run(d) {
      const url = await d.blobUrl('webm8000', d.assets.clips.long8000, 'video/webm');
      await d.drop({ media: { url, kind: 'video', mime: 'video/webm', name: 'v.webm', size: 1 }, from: { ...ALICE } },
        { spotlightOnDrop: false, soundOnArrival: false, videoDuration: 2 });
      await d.settle();
      await d.settings({ videoDuration: 30 });
      await d.check('cap raised to 30 s (timer → min(8 s, 30 s))');
      await d.waitFor(() => !!document.querySelector('.drop.leaving'), null, { timeout: 9000, label: 'video left' });
      await d.check('video left the screen', { dom: false, extra: await d.eval(() => {
        const v = document.querySelector('video');
        return { stoppedAt: v ? (v.currentTime < 3 ? 'before 3 s (old 2 s cap)' : 'after 3 s') : 'no video' };
      }) });
    },
  },
  {
    name: 'stage-empty-with-toast',
    desc: 'stageEmpty is sent when the last slot drop leaves, even if a TTS toast / rain is still on screen.',
    async run(d) {
      await d.drop({ tts: 'un message assez long pour durer'.repeat(4), ttsUrl: null, from: { ...BOB } }, { soundOnArrival: false });
      await d.drop(image(d, 'png100x80'), { duration: 1, spotlightOnDrop: false, soundOnArrival: false });
      await d.settle();
      await d.advance(1400);
      await d.check('image gone, toast still visible');
      await d.advanceTo(7980);
      await d.check('t=7980 toast removed (7680 ms + 300), no further stageEmpty');
    },
  },
  {
    name: 'effects',
    desc: 'Entry effects: zoom / tornade / glitch classes, shake on <body> for 700 ms, unknown effect ignored.',
    async run(d) {
      const s = { spotlightOnDrop: false, soundOnArrival: false, duration: 30 };
      for (const effect of ['zoom', 'tornade', 'glitch', 'explode']) {
        await d.drop(image(d, 'png100x80', { effect, caption: effect }), s);
      }
      await d.drop(image(d, 'png100x80', { effect: 'shake', caption: 'shake' }), s);
      await d.settle();
      await d.check('effects applied', { computed: true });
      await d.advance(699);
      await d.check('t=699 still shaking', { dom: false, extra: await d.eval(() => [...document.body.classList]) });
      await d.advance(1);
      await d.check('t=700 shake removed', { dom: false, extra: await d.eval(() => [...document.body.classList]) });
    },
  },
  {
    name: 'avoid-zone',
    desc: 'avoidZone none/center/top/bottom: drop centres stay in the 14..86 % × 20..80 % box and out of the excluded zone.',
    async run(d) {
      for (const zone of ['none', 'center', 'top', 'bottom']) {
        for (let i = 0; i < 6; i++) await d.drop(image(d, 'png100x80'), { avoidZone: zone, duration: 1, spotlightOnDrop: false, soundOnArrival: false });
        const pos = await d.eval(() => [...document.querySelectorAll('#stage .anchor')].map((a) => [parseFloat(a.style.left), parseFloat(a.style.top)]));
        const bad = pos.filter(([x, y]) => {
          if (!(x >= 14 && x <= 86 && y >= 20 && y <= 80)) return true;
          if (zone === 'center') return x > 28 && x < 72 && y > 28 && y < 72;
          if (zone === 'top') return y < 45;
          if (zone === 'bottom') return y > 55;
          return false;
        });
        await d.check(`zone=${zone}`, { dom: false, extra: { count: pos.length, violations: bad.length, '~positions': pos.map(([x, y]) => [r2(x), r2(y)]) } });
        await d.advance(1400);
      }
    },
  },
  {
    name: 'drag-flow',
    desc: 'Hover detection from cursor IPC (margins), capture, drag (anchor follows the mouse, bob paused), release, exit capture, edge clamp, removal during drag.',
    async run(d) {
      await d.drop(image(d, 'png400x300', { dropId: 'drag-1', from: withAvatar(ALICE, d) }), { duration: 6 });
      await d.settle();
      await d.advance(16);
      const c = await d.centerOf(1);
      await d.check('shown', { dom: false });
      const far = { x: c.x < 800 ? 1550 : 50, y: c.y < 450 ? 880 : 20 };
      d.action(`ipc far away: ${await d.cursorIpc(far.x, far.y)}`);
      d.action(`ipc 20 px right of the drop (outside 14 px margin): ${await d.cursorIpc(c.right + 20, c.y)}`);
      d.action(`ipc 45 px below the drop (outside 40 px margin): ${await d.cursorIpc(c.x, c.bottom + 45)}`);
      await d.check('outside margins → no capture', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      d.action(`ipc 35 px below the drop (inside bottom margin): ${await d.cursorIpc(c.x, c.bottom + 35)}`);
      await d.check('bottom margin → capture', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      // leave, then come back through the right margin
      await d.page.mouse.move(far.x, far.y);
      await d.check('DOM move away → exit capture', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      d.action(`ipc 10 px right of the drop: ${await d.cursorIpc(c.right + 10, c.y)}`);
      await d.check('right margin → capture', { computed: true });
      const start = await d.anchorPos(1);
      await d.page.mouse.move(c.x, c.y);
      d.action(`mousedown on drop: ${await d.mouseDown()}`);
      await d.check('drag started', { computed: true });
      const dx = c.x < 800 ? 200 : -200, dy = c.y < 450 ? 100 : -100;
      await d.page.mouse.move(c.x + dx, c.y + dy, { steps: 5 });
      const moved = await d.anchorPos(1);
      await d.check('dragging', { extra: { anchorMovedBy: [Math.abs(r2(moved.x - start.x)), Math.abs(r2(moved.y - start.y))], followsMouse: near(moved.x - start.x, dx) && near(moved.y - start.y, dy) } });
      await d.advance(16);
      await d.check('spotlight follows the moved drop', { dom: false, extra: await d.eval(() => window.__H.snapshot({}).spotlight) });
      d.action(`mouseup: ${await d.mouseUp()}`);
      await d.check('released', { computed: true });
      await d.page.mouse.move(far.x, far.y);
      await d.check('moved away → pass-through again', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      // edge clamp: grab off-centre, throw to the top-left corner
      const c2 = await d.centerOf(1);
      d.action(`ipc on drop: ${await d.cursorIpc(c2.x, c2.y)}`);
      await d.page.mouse.move(c2.x + 150, c2.y + 100);
      d.action(`mousedown off-centre: ${await d.mouseDown()}`);
      await d.page.mouse.move(10, 10, { steps: 3 });
      await d.check('dragged past the top-left edge → clamped to 0 %', { extra: await d.anchorPos(1) });
      d.action(`mouseup: ${await d.mouseUp()}`);
      // grab again and let the drop expire mid-drag
      await d.page.mouse.move(100, 100);
      d.action(`mousedown: ${await d.mouseDown()}`);
      await d.page.mouse.move(120, 110);
      await d.check('dragging again', { dom: false });
      await d.advanceTo(6000);
      await d.check('expired mid-drag → capture released', { computed: true });
      d.action(`mouseup: ${await d.mouseUp()}`);
      await d.advance(400);
      await d.check('removed');
    },
  },
  {
    name: 'hover-overlap',
    desc: 'Two overlapping drops: which one gets the hover / is dragged when the cursor is over the newer (top-most) one.',
    async run(d) {
      const s = { duration: 30, spotlightOnDrop: false, soundOnArrival: false };
      await d.drop(image(d, 'png400x300', { dropId: 'o-1' }), s);
      await d.drop(image(d, 'png200x500', { dropId: 'o-2' }), s);
      await d.settle();
      const p2 = await hover(d, 2, 'hover drop 2');
      await d.check('hover drop 2 (free point)', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      const c1 = await d.centerOf(1);
      // drag drop 2 so its centre lands on drop 1's centre
      if (p2) {
        d.action(`mousedown: ${await d.mouseDown()}`);
        const c2 = await d.centerOf(2);
        await d.page.mouse.move(p2.x + (c1.x - c2.x), p2.y + (c1.y - c2.y), { steps: 4 });
        d.action(`mouseup: ${await d.mouseUp()}`);
      }
      await d.page.mouse.move(5, 5);
      const same = await d.eval(() => {
        const r = [...document.querySelectorAll('#stage .drop')].map((x) => x.getBoundingClientRect());
        return Math.abs((r[0].left + r[0].right) / 2 - (r[1].left + r[1].right) / 2) < 2 && Math.abs((r[0].top + r[0].bottom) / 2 - (r[1].top + r[1].bottom) / 2) < 2;
      });
      await d.check('drop 2 stacked on drop 1', { dom: false, extra: { centred: same, topMost: await d.eval(({ x, y }) => document.elementFromPoint(x, y)?.closest('.anchor')?.dataset.key, { x: c1.x, y: c1.y }) } });
      d.action(`ipc at the shared centre: ${await d.cursorIpc(c1.x, c1.y)}`);
      await d.page.mouse.move(c1.x, c1.y);
      await d.check('hover at shared centre', { dom: false, extra: { hovered: await hoveredKeys(d) } });
      const before = { a1: await d.anchorPos(1), a2: await d.anchorPos(2) };
      d.action(`mousedown: ${await d.mouseDown()}`);
      await d.page.mouse.move(c1.x + 50, c1.y + 30, { steps: 2 });
      d.action(`mouseup: ${await d.mouseUp()}`);
      const after = { a1: await d.anchorPos(1), a2: await d.anchorPos(2) };
      await d.check('which drop was dragged', { dom: false, extra: {
        moved1: !(near(before.a1.x, after.a1.x) && near(before.a1.y, after.a1.y)),
        moved2: !(near(before.a2.x, after.a2.x) && near(before.a2.y, after.a2.y)),
      } });
    },
  },
  {
    name: 'cursor-watch',
    desc: 'Cursor IPC only flows while the renderer watches (first visual drop → watchCursor, last removed → unwatchCursor); unchanged positions are not resent.',
    async run(d) {
      d.action(`ipc before any drop: ${await d.cursorIpc(10, 10)}`);
      await d.check('no drop → not watching', { dom: false });
      await d.drop({ tts: 'pas visuel', ttsUrl: null, from: { ...BOB } }, { soundOnArrival: false });
      d.action(`ipc after a TTS-only drop: ${await d.cursorIpc(11, 10)}`);
      await d.check('TTS toast does not watch', { dom: false });
      await d.drop(image(d), { spotlightOnDrop: false, soundOnArrival: false });
      await d.settle();
      d.action(`ipc: ${await d.cursorIpc(12, 10)}`);
      d.action(`same position again: ${await d.cursorIpc(12, 10)}`);
      await d.check('visual drop → watching', { dom: false });
      await d.advance(4400);
      d.action(`ipc after removal: ${await d.cursorIpc(13, 10)}`);
      await d.check('removed → unwatched', { dom: false });
    },
  },
  {
    name: 'avatar-variants',
    desc: 'Avatar bubble: image, no avatar (initial), broken avatar URL (falls back to initial), empty username (?), no sender (no bubble).',
    async run(d) {
      const s = { duration: 30, spotlightOnDrop: false, soundOnArrival: false };
      await d.drop(image(d, 'png100x80', { from: withAvatar({ id: '1', username: 'zoé' }, d) }), s);
      await d.drop(image(d, 'png100x80', { from: { id: '2', username: 'marc' } }), s);
      await d.drop(image(d, 'png100x80', { from: { id: '3', username: 'lina', avatar: 'http://avatar.test/404/a.png' } }), s);
      await d.drop(image(d, 'png100x80', { from: { id: '4', username: '  ' } }), s);
      await d.drop(image(d, 'png100x80', { from: null }), s);
      await d.settle();
      await d.check('avatars', { computed: true });
    },
  },
  {
    name: 'drop-guards',
    desc: 'Payloads with nothing to show are ignored (null, {}, empty fields); settings defaults when the payload has none.',
    async run(d) {
      await d.rawDrop(null);
      await d.rawDrop({});
      await d.rawDrop({ media: null, rain: null, tts: '' });
      await d.check('ignored', { dom: true });
      await d.rawDrop({ media: { url: d.asset('png100x80'), kind: 'image' } });
      await d.settle();
      await d.check('no settings in payload → defaults', { computed: true });
      await d.advance(3999);
      await d.check('t=3999', { dom: false });
      await d.advance(1);
      await d.check('t=4000 leaving (default 4 s)', { dom: false });
    },
  },
  {
    name: 'duration-bounds',
    desc: 'Image duration bounds: 0.5 → 1 s, 100 → 30 s, 0 → 4 s default; initial opacity clamp.',
    async run(d) {
      const s = { spotlightOnDrop: false, soundOnArrival: false };
      await d.drop(image(d, 'png100x80', { caption: 'half' }), { ...s, duration: 0.5, opacity: 0.1 });
      await d.drop(image(d, 'png100x80', { caption: 'hundred' }), { ...s, duration: 100, opacity: 3 });
      await d.drop(image(d, 'png100x80', { caption: 'zero' }), { ...s, duration: 0, opacity: 0 });
      await d.settle();
      await d.check('shown');
      for (const t of [999, 1000, 3999, 4000, 29999, 30000]) {
        await d.advanceTo(t);
        await d.check(`t=${t}`, { dom: false, extra: await d.eval(() => [...document.querySelectorAll('#stage .anchor')].map((a) => `${a.querySelector('.caption-bar').textContent}:${a.querySelector('.drop').classList.contains('leaving') ? 'leaving' : 'shown'}`)) });
      }
    },
  },
  {
    name: 'everything-at-once',
    desc: 'Image + rain + TTS (no URL) + shake effect + music in a single payload.',
    async run(d) {
      const music = await d.blobUrl('wavMusic', d.asset('wavMusic'), 'audio/wav');
      await d.drop({
        ...image(d, 'png400x300', { caption: 'tout en même temps', dropId: 'all-1', from: withAvatar(BOB, d) }),
        rain: ['🎉', '💥'], tts: 'attention', ttsUrl: null, effect: 'shake',
        music: { url: music, mime: 'audio/wav', name: 'm.wav', size: 1 },
      });
      await d.settle();
      await d.check('all effects', { computed: true, rainPool: ['🎉', '💥'] });
      await d.advance(5400);
      await d.check('t=5400 everything gone');
    },
  },
];

module.exports = { scenarios };
