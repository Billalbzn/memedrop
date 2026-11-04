const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  for (const f of ['test.html', 'test-z0.html']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(__dirname, f)); await sleep(200);
    await page.addStyleTag({ content: 'body{background:#7a9 !important} .drop{animation: drop-in 420ms forwards !important}' });
    const url = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 420; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, 420, 300); g.fillStyle = '#c33'; g.font = 'bold 48px sans-serif'; g.fillText('MEME', 140, 170); return c.toDataURL(); });
    await page.evaluate((url) => window.__drop({ media: { kind: 'image', url }, from: { username: 'bob' }, settings: { duration: 30, spotlightOnDrop: true, soundOnArrival: false } }), url);
    await page.evaluate(() => { const a = document.querySelector('.anchor'); a.style.left = '50%'; a.style.top = '50%'; });
    await sleep(1300);
    await page.screenshot({ path: path.join(__dirname, `spot-${f.replace('.html', '')}.png`) });
    await page.close();
  }
  await browser.close();
})();
