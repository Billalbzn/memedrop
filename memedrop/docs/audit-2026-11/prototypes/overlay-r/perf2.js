const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function tree(root) {
  const kids = {}; for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; (kids[pp] ||= []).push(+d); } catch {} }
  const out = []; const q = [root]; while (q.length) { const p = q.shift(); out.push(p); q.push(...(kids[p] || [])); } return out;
}
function cpu(pids) { let t = 0; for (const p of pids) { try { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); t += (+f[11]) + (+f[12]); } catch {} } return t * 10; }
async function run(pageFile, css, drop, win = 5000) {
  const server = await chromium.launchServer({ args: ['--disable-gpu', '--disable-gpu-compositing', '--autoplay-policy=no-user-gesture-required'] });
  const pid = server.process().pid; const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, pageFile)); await sleep(400);
  if (css) await page.addStyleTag({ content: css });
  const url = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 700; c.height = 500; const g = c.getContext('2d');
    const im = g.createImageData(700, 500); for (let i = 0; i < im.data.length; i += 4) { im.data[i] = (i * 7) & 255; im.data[i + 1] = (i * 13) & 255; im.data[i + 2] = (i >> 5) & 255; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0); const u = c.toDataURL('image/png');
    await new Promise(r => { const i = new Image(); i.onload = r; i.src = u; window.__k = i; }); return u;
  });
  await page.evaluate(([url, drop]) => window.__drop({ media: { kind: 'image', url }, caption: 'PERF TEST', from: { username: 'x' }, settings: { duration: 30, soundOnArrival: false, opacity: 1, ...drop } }), [url, drop]);
  await sleep(1500);
  const c0 = cpu(tree(pid)); const t0 = Date.now(); await sleep(win); const c1 = cpu(tree(pid)); const dt = Date.now() - t0;
  await browser.close(); await server.close();
  return Math.round((c1 - c0) / dt * 1000);
}
const NOBOB = `.drop { animation: drop-in 420ms cubic-bezier(.18,1.2,.4,1) forwards !important; }`;
const NOLIFE = `.life-bar { display: none !important; }`;
(async () => {
  const sc = [
    ['ORIG  bob+life', 'test.html', '', {}],
    ['ORIG  bob only (no life-bar)', 'test.html', NOLIFE, {}],
    ['ORIG  life-bar only (no bob)', 'test.html', NOBOB, {}],
    ['ORIG  static (no bob, no life)', 'test.html', NOBOB + NOLIFE, {}],
    ['OPT   bob+life', 'overlay-opt.html', '', {}],
    ['OPT   bob only', 'overlay-opt.html', NOLIFE, {}],
    ['OPT   life-bar only', 'overlay-opt.html', NOBOB, {}],
    ['OPT   static', 'overlay-opt.html', NOBOB + NOLIFE, {}],
    ['ORIG  static + spotlight(rAF)', 'test.html', NOBOB + NOLIFE, { spotlightOnDrop: true }],
  ];
  for (const [n, p, css, d] of sc) console.log(`${n.padEnd(32)} ${String(await run(p, css, d)).padStart(5)} ms CPU/s`);
})();
