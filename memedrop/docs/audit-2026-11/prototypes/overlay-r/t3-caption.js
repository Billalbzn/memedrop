const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const URL = 'file://' + path.join(__dirname, process.argv[2] || 'test.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(URL); await sleep(300);
  const S = { duration: 30, spotlightOnDrop: false, soundOnArrival: false };
  for (const [w, h] of [[300, 400], [200, 300]]) {
    const url = await page.evaluate(async ([w, h]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, w, h);
      const u = c.toDataURL('image/png');
      await new Promise(r => { const i = new Image(); i.onload = r; i.src = u; (window.__keep ||= []).push(i); });
      return u;
    }, [w, h]);
    for (const effect of [null, 'zoom', 'tornade', 'glitch']) {
      await page.evaluate(([S, url, effect]) => window.__drop({ media: { kind: 'image', url }, caption: 'HELLO WORLD', effect, settings: S }), [S, url, effect]);
      await sleep(1000);
      const res = await page.evaluate(() => {
        const a = [...document.querySelectorAll('.anchor')].pop();
        const img = a.querySelector('img'); const cap = a.querySelector('.caption-bar');
        const lw = img.offsetWidth; const expected = Math.max(13, Math.min(40, Math.round(lw * 0.09)));
        return `layoutW=${lw} got=${cap.style.fontSize} expected=${expected}px`;
      });
      console.log(`img ${w}x${h} effect=${effect}: ${res}`);
      await page.evaluate(() => document.querySelectorAll('.anchor').forEach(a => a.remove()));
    }
  }
  await browser.close();
})();
