const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function tree(root) { const kids = {}; for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; (kids[pp] ||= []).push(+d); } catch {} } const out = []; const q = [root]; while (q.length) { const p = q.shift(); out.push(p); q.push(...(kids[p] || [])); } return out; }
function stat(pids) { let t = 0, cs = 0; for (const p of pids) { try { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); t += (+f[11]) + (+f[12]); for (const tid of fs.readdirSync(`/proc/${p}/task`)) { const s = fs.readFileSync(`/proc/${p}/task/${tid}/status`, 'utf8'); cs += +/voluntary_ctxt_switches:\s+(\d+)/.exec(s)[1]; } } catch {} } return { ms: t * 10, cs }; }
async function run(mode, win = 10000) {
  const server = await chromium.launchServer({ args: ['--disable-gpu', '--disable-gpu-compositing', '--autoplay-policy=no-user-gesture-required'] });
  const pid = server.process().pid; const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, 'test.html')); await sleep(400);
  if (mode !== 'none') {
    // TTS-only drop with soundOnArrival: no visual slot, just the pop + toast (toast leaves after 3 s)
    await page.evaluate(() => window.__drop({ rain: null, tts: 'a', from: { username: 'x' }, settings: { soundOnArrival: true, volume: 0.5 } }));

    await sleep(4000);
    if (mode === 'suspend') await page.evaluate(() => popCtx && popCtx.suspend());
    console.log('   ctx state:', await page.evaluate(() => popCtx && popCtx.state));
  } else await sleep(4000);
  await sleep(1000);
  const a = stat(tree(pid)); const t0 = Date.now(); await sleep(win); const b = stat(tree(pid)); const dt = Date.now() - t0;
  await browser.close(); await server.close();
  return `${((b.ms - a.ms) / dt * 1000).toFixed(1)} ms CPU/s, ${((b.cs - a.cs) / dt * 1000).toFixed(0)} voluntary ctx switches/s`;
}
(async () => {
  for (const m of ['running', 'suspend']) console.log(`${m.padEnd(8)} idle after pop: ${await run(m)}`);
})();
