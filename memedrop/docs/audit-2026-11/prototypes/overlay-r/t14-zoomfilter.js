const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'test.html')); await sleep(200);
  for (const effect of ['zoom', 'glitch']) {
    const out = await page.evaluate(async (effect) => {
      window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'a' }, effect, settings: { duration: 5, soundOnArrival: false } });
      const d = [...document.querySelectorAll('.drop')].pop(); const t0 = performance.now(); const res = [];
      await new Promise(r => { const f = () => { const t = performance.now() - t0; res.push(`${Math.round(t)}ms:${getComputedStyle(d).filter.slice(0, 22)}`); if (t < 1300) requestAnimationFrame(f); else r(); }; f(); });
      return res.filter((_, i) => i % 6 === 0).join(' | ');
    }, effect);
    console.log(effect, '->', out);
  }
  await browser.close();
})();
