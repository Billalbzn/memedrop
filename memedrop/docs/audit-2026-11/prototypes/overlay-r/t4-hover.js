const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const URL = 'file://' + path.join(__dirname, process.argv[2] || 'test.html');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(URL); await sleep(300);
  const S = { duration: 30, spotlightOnDrop: false, soundOnArrival: false };
  // two overlapping drops at the same spot
  await page.evaluate((S) => { window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'old' }, settings: S }); }, S);
  await page.evaluate((S) => { window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'new' }, settings: S }); }, S);
  await page.evaluate(() => document.querySelectorAll('.anchor').forEach(a => { a.style.left = '50%'; a.style.top = '50%'; }));
  await sleep(1000);
  // count class mutations on drops
  await page.evaluate(() => {
    window.__mut = 0;
    new MutationObserver((l) => { window.__mut += l.length; }).observe(document.getElementById('stage'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.evaluate(() => window.__cursor(960, 540));   // phase 1 -> capture
  const hovered = await page.evaluate(() => [...document.querySelectorAll('.drop.hover')].map(d => d.querySelector('.avatar-bubble').dataset.username));
  console.log('F. after cursor over overlapping drops, hovered =', hovered, ' (DOM order: old, new; new is painted on top)');
  const top = await page.evaluate(() => document.elementFromPoint(960, 540)?.closest('.drop')?.querySelector('.avatar-bubble')?.dataset.username);
  console.log('F. elementFromPoint (topmost) =', top);
  const m0 = await page.evaluate(() => window.__mut);
  for (let i = 0; i < 10; i++) await page.mouse.move(960 + i, 540);   // capture mode -> DOM mousemove
  const m1 = await page.evaluate(() => window.__mut);
  console.log(`G. class mutations caused by 10 mousemoves while staying on the same drop: ${m1 - m0}`);
  // drag then removal while dragging
  await page.mouse.down();
  await page.mouse.move(900, 500);
  await page.evaluate(() => { const d = document.querySelector('.drop.hover'); window.__dragged = d; });
  await page.evaluate(() => window.__mdDropCtl.close(window.__dragged.closest('.anchor').dataset.key));
  await sleep(30);
  console.log('H. drop closed mid-drag: inline animationPlayState =', await page.evaluate(() => window.__dragged.style.animationPlayState), ' computed =', await page.evaluate(() => getComputedStyle(window.__dragged).animationPlayState));
  await page.mouse.up();
  console.log('calls', JSON.stringify(await page.evaluate(() => window.__calls)));
  await browser.close();
})();
