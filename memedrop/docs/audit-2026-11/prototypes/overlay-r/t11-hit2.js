const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-gpu-compositing'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, 'test.html')); await sleep(200);
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'a' }, settings: { duration: 30, soundOnArrival: false, spotlightOnDrop: false } }));
  await sleep(1000);
  for (const variant of ['gbcr', 'offset', 'cached']) {
    const r = await page.evaluate(async (variant) => {
      const cache = [...stage.children].map(a => { const d = a.querySelector('.drop'); return { l: a.offsetLeft - d.offsetWidth / 2, t: a.offsetTop - d.offsetHeight / 2, r: a.offsetLeft + d.offsetWidth / 2, b: a.offsetTop + d.offsetHeight / 2 }; });
      const f = {
        gbcr: () => { for (const a of stage.querySelectorAll('.anchor')) { const r = a.querySelector('.drop').getBoundingClientRect(); if (1 >= r.left - 14 && 1 <= r.right + 14) return a; } return null; },
        offset: () => { for (let i = stage.children.length - 1; i >= 0; i--) { const a = stage.children[i]; const d = a.querySelector('.drop'); const hw = d.offsetWidth / 2; if (1 >= a.offsetLeft - hw - 14 && 1 <= a.offsetLeft + hw + 14) return a; } return null; },
        cached: () => { for (let i = cache.length - 1; i >= 0; i--) { const c = cache[i]; if (1 >= c.l - 14 && 1 <= c.r + 14) return c; } return null; },
      }[variant];
      const times = [];
      for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 16)); const t = performance.now(); f(); times.push(performance.now() - t); }
      times.sort((a, b) => a - b);
      return { median_us: Math.round(times[60] * 1000), p95_us: Math.round(times[114] * 1000) };
    }, variant);
    console.log(variant.padEnd(7), JSON.stringify(r));
  }
  await browser.close();
})();
