const http = require('http');
const net = require('net');
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.end('ok ' + u.pathname);
});
srv.listen(0, () => {
  const port = srv.address().port;
  const s = net.connect(port, '127.0.0.1', () => {
    s.write('GET //localhost:99999/ HTTP/1.1\r\nHost: x\r\n\r\n');
  });
  s.on('data', d => console.log('resp:', d.toString().split('\r\n')[0]));
});
process.on('exit', (c) => console.log('exit code', c));
