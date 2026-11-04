const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route('http://hang.test/**', () => { /* never answers: server stalled / network dropped */ });
  await page.goto('file://' + path.join(__dirname, process.argv[2] || 'test.html')); await sleep(200);
  for (let i = 0; i < 6; i++) await page.evaluate((i) => window.__drop({ media: { kind: 'audio', url: `http://hang.test/a${i}.mp3` }, from: { username: 'x' + i }, settings: { soundOnArrival: false } }), i);
  await page.evaluate(() => window.__drop({ media: { kind: 'test', url: 'x' }, from: { username: 'visual' }, settings: { duration: 4, soundOnArrival: false } }));
  for (const t of [1, 27]) {
    await sleep(t === 1 ? 1000 : 26000);
    console.log(`t=${t}s: audio toasts=${await page.evaluate(() => document.querySelectorAll('.audio-toast').length)} visual drops rendered=${await page.evaluate(() => document.querySelectorAll('.anchor').length)} active=${await page.evaluate(() => active)} queue=${await page.evaluate(() => dropQueue.length)}`);
  }
  await browser.close();
})();
