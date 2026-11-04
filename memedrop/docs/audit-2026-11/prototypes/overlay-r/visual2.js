// Recherche des rayons de box-shadow qui reproduisent drop-shadow(0 30px 60px) drop-shadow(0 6px 12px)
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOBOB = `.drop { animation: drop-in 420ms cubic-bezier(.18,1.2,.4,1) forwards !important; } .life-bar{display:none!important}`;
async function shot(browser, file, css, w, h) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, file)); await sleep(200);
  await page.addStyleTag({ content: NOBOB + (css || '') });
  const url = await page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    g.fillStyle = '#3b82f6'; g.fillRect(0, 0, w, h); return c.toDataURL('image/png');
  }, [w, h]);
  await page.evaluate((url) => window.__drop({ media: { kind: 'image', url }, from: { username: 'bob' }, settings: { duration: 30, soundOnArrival: false, spotlightOnDrop: false } }), url);
  await page.evaluate(() => document.querySelectorAll('.anchor').forEach(a => { a.style.left = '50%'; a.style.top = '50%'; }));
  await sleep(900);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 960 - 600, y: 540 - 450, width: 1200, height: 900 } });
  await page.close();
  return buf.toString('base64');
}
(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-gpu-compositing'] });
  const diffPage = await browser.newPage();
  const diff = (a, b) => diffPage.evaluate(async ([a, b]) => {
    const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const A = await load(a), B = await load(b); let max = 0, sum = 0, n = 0, over8 = 0;
    let at = 0; for (let i = 3; i < A.length; i += 4) { const d = Math.abs(A[i] - B[i]); if (d > max) { max = d; at = (i - 3) / 4; } sum += d; n++; if (d > 8) over8++; }
    return `alpha maxDiff=${max} at(x=${at % 1200},y=${Math.floor(at / 1200)}) mean=${(sum / n).toFixed(2)} >8: ${(100 * over8 / n).toFixed(1)}%`;
  }, [a, b]);
  const ref = await shot(browser, 'test.html', '', 700, 500);
  for (const [b1, b2] of [[130, 26], [140, 24], [140, 28], [150, 30], [160, 32], [170, 34]]) {
    const css = `.media-box { box-shadow: 0 30px ${b1}px rgba(0,0,0,.55), 0 6px ${b2}px rgba(0,0,0,.4) !important; }`;
    const s = await shot(browser, 'overlay-opt.html', css, 700, 500);
    console.log(`box-shadow blur ${b1}/${b2}:`, await diff(ref, s));
    if (b1 === 140 && b2 === 28) fs.writeFileSync(path.join(__dirname, 'vis-opt-140.png'), Buffer.from(s, 'base64'));
  }
  fs.writeFileSync(path.join(__dirname, 'vis-ref.png'), Buffer.from(ref, 'base64'));
  await browser.close();
})();
