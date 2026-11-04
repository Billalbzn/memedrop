const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, 'test.html')); await sleep(200);
  const url = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; c.getContext('2d').fillRect(0, 0, 1600, 1200); return c.toDataURL(); });
  for (const [label, rnd] of [['top-left extreme (Math.random=0)', 0], ['bottom-right extreme (Math.random=0.999)', 0.999]]) {
    await page.evaluate(([url, rnd]) => { const R = Math.random; Math.random = () => rnd; window.__drop({ media: { kind: 'image', url }, from: { username: 'x' }, settings: { duration: 30, soundOnArrival: false } }); Math.random = R; }, [url, rnd]);
    await sleep(1200);
    const r = await page.evaluate(() => { const a = [...document.querySelectorAll('.anchor')].pop(); const m = a.querySelector('img').getBoundingClientRect(); const c = a.querySelector('.drop-close').getBoundingClientRect(); return { media: [m.left, m.top, m.right, m.bottom].map(Math.round), closeBtn: [c.left, c.top, c.right, c.bottom].map(Math.round) }; });
    console.log(label, JSON.stringify(r), '(viewport 1920x1080)');
  }
  await browser.close();
})();
