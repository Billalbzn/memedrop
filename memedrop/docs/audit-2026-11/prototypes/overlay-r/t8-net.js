// Un drop vidéo fermé tôt continue-t-il à télécharger ? (ORIG vs OPT)
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FILE = fs.readFileSync(path.join(__dirname, 'v.webm'));
const log = {};
const server = http.createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  const L = (log[id] ||= { reqs: 0, bytes: 0, closedAt: null, t0: Date.now() }); L.reqs++;
  let start = 0; const m = /bytes=(\d+)-/.exec(req.headers.range || ''); if (m) start = +m[1];
  res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': FILE.length - start, ...(m ? { 'Content-Range': `bytes ${start}-${FILE.length - 1}/${FILE.length}` } : {}) });
  let pos = start; let done = false;
  const pump = () => { if (done) return; if (pos >= FILE.length) { res.end(); return; } const chunk = FILE.subarray(pos, pos + 16 * 1024); pos += chunk.length; L.bytes += chunk.length; const ok = res.write(chunk); setTimeout(() => ok ? pump() : res.once('drain', pump), 50); };
  res.on('close', () => { done = true; if (pos < FILE.length) L.closedAt = Date.now() - L.t0; });
  pump();
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const f of ['test.html', 'overlay-opt.html']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(__dirname, f)); await sleep(200);
    await page.evaluate(([port, id]) => window.__drop({ media: { kind: 'video', url: `http://127.0.0.1:${port}/v.webm?id=${id}` }, from: { username: 'x' }, settings: { videoDuration: 30, volume: 0, soundOnArrival: false } }), [port, f]);
    await sleep(1500);
    const at = () => `${(log[f].bytes / 1024).toFixed(0)} KB sent, conn ${log[f].closedAt != null ? 'closed by client at ' + log[f].closedAt + 'ms' : 'open'}`;
    console.log(`${f}: before close: ${at()}; video readyState=${await page.evaluate(() => document.querySelector('video')?.readyState)}`);
    await page.evaluate(() => window.__mdDropCtl.close(document.querySelector('.anchor').dataset.key));
    for (const t of [1000, 3000, 6000]) { await sleep(t === 1000 ? 1000 : t === 3000 ? 2000 : 3000); console.log(`  +${t / 1000}s after close: ${at()}`); }
    await page.close();
  }
  console.log(`file size ${(FILE.length / 1024).toFixed(0)} KB`);
  await browser.close(); server.close();
})();
