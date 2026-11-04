const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const URL = 'file://' + path.join(__dirname, process.argv[2] || 'test.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(URL);
  await sleep(300);
  const S = { duration: 30, spotlightOnDrop: false, soundOnArrival: false, opacity: 1, volume: 0 };
  // Make a 700x500 solid-ish image (light grey) as data URL and preload it (cache)
  const url = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 700; c.height = 500;
    const g = c.getContext('2d'); g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, 700, 500);
    const u = c.toDataURL('image/png');
    await new Promise(r => { const i = new Image(); i.onload = r; i.src = u; window.__keep = i; });
    return u;
  });
  // ---- D. spotlight stacking: pixel near the media corner, spotlight off vs on
  async function cornerPixel(spot) {
    await page.evaluate(() => { document.querySelectorAll('.anchor').forEach(a => a.remove()); });
    await page.evaluate(([S, url, spot]) => window.__drop({ media: { kind: 'image', url }, settings: { ...S, spotlightOnDrop: spot } }), [S, url, spot]);
    await sleep(1500);
    const r = await page.evaluate(() => { const b = document.querySelector('.drop img').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    const buf = await page.screenshot({ clip: { x: Math.round(r.x + 30), y: Math.round(r.y + 30), width: 1, height: 1 } });
    const buf2 = await page.screenshot({ clip: { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), width: 1, height: 1 } });
    const buf3 = await page.screenshot({ clip: { x: Math.round(r.x + 30), y: Math.round(r.y + r.h / 2), width: 1, height: 1 } });
    const { PNG } = await import('data:text/javascript,export const PNG=null');
    return { rect: r, corner: buf.toString('base64'), center: buf2.toString('base64'), leftEdge: buf3.toString('base64') };
  }
  const decode = async (b64) => page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = 1; c.height = 1; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, 1, 1).data);
  }, b64);
  for (const spot of [false, true]) {
    const p = await cornerPixel(spot);
    console.log(`D. spotlight=${spot} media rect=${JSON.stringify(p.rect)} corner+30px=${await decode(p.corner)} leftEdge+30px=${await decode(p.leftEdge)} center=${await decode(p.center)}`);
  }
  await page.evaluate(() => { document.querySelectorAll('.anchor').forEach(a => a.remove()); });

  // ---- E. fitCaption with a cached image, various effects
  for (const effect of [null, 'zoom', 'tornade']) {
    await page.evaluate(([S, url, effect]) => window.__drop({ media: { kind: 'image', url }, caption: 'HELLO WORLD', effect, settings: S }), [S, url, effect]);
    await sleep(1200);
    const res = await page.evaluate(() => {
      const a = [...document.querySelectorAll('.anchor')].pop();
      const img = a.querySelector('img'); const cap = a.querySelector('.caption-bar');
      const w = img.offsetWidth; const expected = Math.max(13, Math.min(40, Math.round(w * 0.09)));
      return { layoutW: w, fontSize: cap.style.fontSize, expected: expected + 'px' };
    });
    console.log(`E. fitCaption effect=${effect}:`, JSON.stringify(res));
  }
  await page.evaluate(() => { document.querySelectorAll('.anchor').forEach(a => a.remove()); });
  await browser.close();
})();
