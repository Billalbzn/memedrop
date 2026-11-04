// Mesure le CPU (tous processus Chromium) pendant qu'un drop image est affiché.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TCK = 100;
function tree(root) {
  const kids = {}; for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; (kids[pp] ||= []).push(+d); } catch {} }
  const out = []; const q = [root]; while (q.length) { const p = q.shift(); out.push(p); q.push(...(kids[p] || [])); } return out;
}
function cpu(pids) { let t = 0; for (const p of pids) { try { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); t += (+f[11]) + (+f[12]); } catch {} } return t * 1000 / TCK; }
async function run(page_, spot, sw, win = 6000) {
  const server = await chromium.launchServer({ args: ['--disable-gpu', '--disable-gpu-compositing', '--autoplay-policy=no-user-gesture-required', ...(sw || [])] });
  const pid = server.process().pid;
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, page_)); await sleep(500);
  const url = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 700; c.height = 500; const g = c.getContext('2d');
    const im = g.createImageData(700, 500); for (let i = 0; i < im.data.length; i += 4) { im.data[i] = (i * 7) & 255; im.data[i + 1] = (i * 13) & 255; im.data[i + 2] = (i >> 5) & 255; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0); const u = c.toDataURL('image/png');
    await new Promise(r => { const i = new Image(); i.onload = r; i.src = u; window.__k = i; }); return u;
  });
  if (spot !== 'idle') await page.evaluate(([url, spot]) => window.__drop({ media: { kind: 'image', url }, caption: 'PERF TEST', from: { username: 'x' }, settings: { duration: 30, spotlightOnDrop: spot, soundOnArrival: false, opacity: 1 } }), [url, spot]);
  await sleep(1500);
  const pids = tree(pid); const c0 = cpu(pids); const t0 = Date.now();
  await sleep(win);
  const c1 = cpu(tree(pid)); const dt = Date.now() - t0;
  await browser.close(); await server.close();
  return Math.round((c1 - c0) / dt * 1000);   // ms CPU per second
}
(async () => {
  const sc = [
    ['idle (no drop)', 'test.html', 'idle'],
    ['ORIG drop, spotlight off', 'test.html', false],
    ['ORIG drop, spotlight on', 'test.html', true],
    ['OPT  drop, spotlight off', 'overlay-opt.html', false],
    ['OPT  drop, spotlight on', 'overlay-opt.html', true],
  ];
  for (let rep = 0; rep < 2; rep++) for (const [n, p, s] of sc) console.log(`${n.padEnd(28)} ${String(await run(p, s)).padStart(5)} ms CPU/s`);
})();
