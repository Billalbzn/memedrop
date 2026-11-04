// Compare le rendu ORIG (filter: drop-shadow) vs OPT (box-shadow) au repos.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOBOB = `.drop { animation: drop-in 420ms cubic-bezier(.18,1.2,.4,1) forwards !important; } .life-bar{display:none!important}`;
async function shot(browser, file, kind, w, h, extra = {}) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, file)); await sleep(300);
  await page.addStyleTag({ content: NOBOB });
  const url = await page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    g.fillStyle = '#3b82f6'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText('MEME', 40, 120);
    return c.toDataURL('image/png');
  }, [w, h]);
  await page.evaluate(([url, kind, extra]) => window.__drop({ media: { kind, url }, caption: 'LE TEXTE', from: { username: 'bob' }, settings: { duration: 30, soundOnArrival: false, spotlightOnDrop: false }, ...extra }), [url, kind, extra]);
  await page.evaluate(() => document.querySelectorAll('.anchor').forEach(a => { a.style.left = '50%'; a.style.top = '50%'; }));
  await sleep(1200);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 960 - 600, y: 540 - 450, width: 1200, height: 900 } });
  await page.close();
  return buf.toString('base64');
}
(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-gpu-compositing'] });
  for (const [w, h] of [[700, 500], [400, 520]]) {
    const a = await shot(browser, 'test.html', 'image', w, h);
    const b = await shot(browser, 'overlay-opt.html', 'image', w, h);
    fs.writeFileSync(path.join(__dirname, `vis-orig-${w}.png`), Buffer.from(a, 'base64'));
    fs.writeFileSync(path.join(__dirname, `vis-opt-${w}.png`), Buffer.from(b, 'base64'));
    const page = await browser.newPage();
    const res = await page.evaluate(async ([a, b]) => {
      const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const A = await load(a), B = await load(b); let max = 0, sum = 0, n = 0, over8 = 0;
      for (let i = 0; i < A.length; i += 4) { const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i+1] - B[i+1]), Math.abs(A[i+2] - B[i+2]), Math.abs(A[i+3] - B[i+3])); if (d > max) max = d; sum += d; n++; if (d > 8) over8++; }
      return { maxDiff: max, meanDiff: +(sum / n).toFixed(3), pctPixelsOver8: +(100 * over8 / n).toFixed(2) };
    }, [a, b]);
    console.log(`media ${w}x${h}: ORIG vs OPT`, JSON.stringify(res));
    await page.close();
  }
  await browser.close();
})();
