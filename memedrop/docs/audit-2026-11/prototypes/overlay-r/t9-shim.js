const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  for (const f of ['android-orig.html', 'android-opt.html']) {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto('file://' + path.join(__dirname, f)); await sleep(100);
    await page.evaluate(() => window.__mdSettings({ volume: 0.5, duration: 2, spotlightOnDrop: false, soundOnArrival: false, opacity: 1, theme: 'classic' }));
    await sleep(2000);
    const idle0 = await page.evaluate(() => window.__ticks);
    await page.evaluate(() => window.__mdDrop({ media: { kind: 'test', url: 'x' }, from: { username: 'a' }, settings: { duration: 2, soundOnArrival: false } }));
    await sleep(700);
    const during = await page.evaluate(() => window.__rects.at(-1));
    await sleep(2500);
    const after = await page.evaluate(() => window.__rects.at(-1));
    const t1 = await page.evaluate(() => window.__ticks);
    await sleep(5000);
    const t2 = await page.evaluate(() => window.__ticks);
    console.log(`${f}: ticks during 2s idle before any drop=${idle0}; rects while visible=${during}; last rects after removal=${after}; ticks during 5s idle after=${t2 - t1}; total bridge calls=${await page.evaluate(() => window.__rects.length)}`);
    await page.close();
  }
  await browser.close();
})();
