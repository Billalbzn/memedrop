const http = require('http');
const net = require('net');
const target = process.argv[2];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');   // index.js:96
  res.writeHead(200); res.end(u.pathname);
});
srv.listen(0, () => {
  const { port } = srv.address();
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  s.on('data', d => { console.log('response:', String(d).split('\r\n')[0]); process.exit(0); });
  s.on('error', () => {});
});
