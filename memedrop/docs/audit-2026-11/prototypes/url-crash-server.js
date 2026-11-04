// Reproduces bot/index.js:95-108 request handler (minimal) to test malformed request targets.
const http = require('http');
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health' || u.pathname === '/') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
srv.listen(0, () => { process.stdout.write(String(srv.address().port) + '\n'); });
