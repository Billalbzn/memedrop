const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'overlay-opt.html')); await sleep(200);
  const st = () => page.evaluate(() => `${popCtx?.state} t=${popCtx?.currentTime.toFixed(3)}`);
  await page.evaluate(() => playPop(0.5)); await sleep(300); console.log('300ms after pop #1 :', await st());
  await sleep(1200); console.log('1.5s after pop #1  :', await st());
  const t1 = await page.evaluate(() => popCtx.currentTime);
  await page.evaluate(() => playPop(0.5)); await sleep(400); console.log('400ms after pop #2 :', await st());
  console.log('context time advanced during pop #2:', (await page.evaluate(() => popCtx.currentTime) - t1).toFixed(3), 's (>= 0.16 means the pop could play)');
  await sleep(1200); console.log('1.6s after pop #2  :', await st());
  await browser.close();
})();
