// Génère une petite vidéo WebM (MediaRecorder) pour les tests réseau
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; document.body.appendChild(c);
    const g = c.getContext('2d'); let f = 0;
    const draw = () => { f++; for (let i = 0; i < 40; i++) { g.fillStyle = `hsl(${(f * 7 + i * 31) % 360},80%,50%)`; g.fillRect(Math.random() * 640, Math.random() * 360, 80, 80); } };
    const iv = setInterval(draw, 33);
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4_000_000 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(); await new Promise(r => setTimeout(r, 6000)); rec.stop(); await new Promise(r => rec.onstop = r); clearInterval(iv);
    const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
  });
  fs.writeFileSync(path.join(__dirname, 'v.webm'), Buffer.from(b64, 'base64'));
  console.log('v.webm bytes', Buffer.from(b64, 'base64').length);
  await browser.close();
})();
