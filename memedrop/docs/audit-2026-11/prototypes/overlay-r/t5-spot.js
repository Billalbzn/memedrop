const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('file://' + path.join(__dirname, process.argv[2] || 'overlay-opt.html')); await sleep(300);
  const vars = () => page.evaluate(() => { const s = document.getElementById('spotlight').style; return ['--cx', '--cy', '--rx', '--ry'].map(k => s.getPropertyValue(k)).join(' ') + ' op=' + s.opacity; });
  const geom = () => page.evaluate(() => { const a = document.querySelector('.anchor'); const d = a.querySelector('.drop'); return `anchor=(${a.offsetLeft},${a.offsetTop}) drop=${d.offsetWidth}x${d.offsetHeight}`; });
  // image served slowly: route a fake http URL with a delay
  await page.route('http://slow.test/*', async (route) => { await sleep(700); const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 500; c.height = 300; c.getContext('2d').fillRect(0, 0, 500, 300); return c.toDataURL('image/png').split(',')[1]; }), 'base64'); route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
  await page.evaluate(() => window.__drop({ media: { kind: 'image', url: 'http://slow.test/a.png' }, from: { username: 'x' }, settings: { duration: 30, spotlightOnDrop: true, soundOnArrival: false } }));
  await sleep(100);
  console.log('before media load :', await vars(), '|', await geom());
  await sleep(1200);
  console.log('after media load  :', await vars(), '|', await geom());
  // drag via cursor + DOM events
  const c = await page.evaluate(() => { const a = document.querySelector('.anchor'); return [a.offsetLeft, a.offsetTop]; });
  await page.evaluate(([x, y]) => window.__cursor(x, y), c);
  await page.mouse.move(c[0], c[1]); await page.mouse.down(); await page.mouse.move(c[0] - 200, c[1] + 100, { steps: 5 }); await page.mouse.up();
  console.log('after drag        :', await vars(), '|', await geom());
  await page.evaluate(() => window.__mdDropCtl.move(document.querySelector('.anchor').dataset.key, 10, 10));
  console.log('after ctl.move(10,10):', await vars(), '|', await geom());
  await page.setViewportSize({ width: 1280, height: 720 }); await sleep(200);
  console.log('after resize      :', await vars(), '|', await geom());
  await page.evaluate(() => window.__mdDropCtl.close(document.querySelector('.anchor').dataset.key)); await sleep(400);
  console.log('after close       :', await vars());
  await browser.close();
})();
