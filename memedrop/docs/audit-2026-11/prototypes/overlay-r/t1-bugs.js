const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const URL = 'file://' + path.join(__dirname, process.argv[2] || 'test.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(URL);
  await sleep(300);
  const S = { duration: 1, spotlightOnDrop: false, soundOnArrival: false, opacity: 1, volume: 0 };

  // Sampler: records computed opacity of `sel` every frame for `ms` once `cls` appears
  await page.evaluate(() => {
    window.__sampleWhen = (sel, cls, ms) => new Promise((resolve) => {
      const out = [];
      const check = () => {
        const el = document.querySelector(sel);
        if (el && el.classList.contains(cls)) {
          const t0 = performance.now();
          const tick = () => {
            if (!el.isConnected) { out.push({ t: Math.round(performance.now() - t0), removed: true }); return resolve(out); }
            const cs = getComputedStyle(el);
            out.push({ t: Math.round(performance.now() - t0), op: Number(cs.opacity).toFixed(2), tf: cs.transform.slice(0, 40), ps: cs.animationPlayState });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(out);
          };
          tick();
        } else requestAnimationFrame(check);
      };
      check();
    });
  });

  // A. natural end-of-life (.leaving)
  await page.evaluate((S) => window.__drop({ media: { kind: 'test', url: 'about:blank' }, caption: 'T', from: { username: 'a' }, settings: S }), S);
  await sleep(700);
  console.log('A. before leaving opacity =', await page.evaluate(() => getComputedStyle(document.querySelector('.drop')).opacity));
  console.log('A. .leaving samples:', JSON.stringify(await page.evaluate(() => window.__sampleWhen('.drop', 'leaving', 450))));
  await sleep(600);

  // B. manual close (.closing)
  await page.evaluate((S) => window.__drop({ media: { kind: 'test', url: 'about:blank' }, from: { username: 'a' }, settings: { ...S, duration: 10 } }), S);
  await sleep(700);
  const p = page.evaluate(() => window.__sampleWhen('.drop', 'closing', 260));
  await page.evaluate(() => window.__mdDropCtl.close(document.querySelector('.anchor').dataset.key));
  console.log('B. .closing samples:', JSON.stringify(await p));
  await sleep(500);

  // C. audio toast (.leaving) via TTS-only drop (no ttsUrl -> local speech, toast 3 s)
  await page.evaluate((S) => window.__drop({ tts: 'salut', from: { username: 'a' }, settings: S }), S);
  await sleep(800);
  console.log('C. toast opacity before leaving =', await page.evaluate(() => getComputedStyle(document.querySelector('.audio-toast')).opacity));
  console.log('C. toast .leaving samples:', JSON.stringify(await page.evaluate(() => window.__sampleWhen('.audio-toast', 'leaving', 300))));
  await sleep(500);
  console.log('calls', JSON.stringify(await page.evaluate(() => window.__calls)));
  await browser.close();
})();
