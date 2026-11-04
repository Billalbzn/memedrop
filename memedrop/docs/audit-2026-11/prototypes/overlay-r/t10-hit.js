const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-gpu-compositing'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, 'test.html')); await sleep(200);
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'a' }, settings: { duration: 30, soundOnArrival: false, spotlightOnDrop: false } }));
  await sleep(1000);
  const r = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 16));
      const t = performance.now(); window.__cursor(1, 1); times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { median_us: Math.round(times[60] * 1000), p95_us: Math.round(times[114] * 1000), max_us: Math.round(times[119] * 1000) };
  });
  console.log('onCursor -> findDropAt with 6 drops (miss):', JSON.stringify(r));
  await browser.close();
})();
