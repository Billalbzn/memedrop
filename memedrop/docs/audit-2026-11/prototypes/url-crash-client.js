const { spawn } = require('child_process');
const net = require('net');
const target = process.argv[2];
const child = spawn(process.execPath, [__dirname + '/url-crash-server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => stderr += d);
child.on('exit', (code, sig) => { console.log(`target=${JSON.stringify(target)} -> server EXITED code=${code} sig=${sig}`); console.log(stderr.split('\n').slice(0, 6).join('\n')); process.exit(0); });
child.stdout.once('data', (d) => {
  const port = Number(String(d).trim());
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  let resp = '';
  s.on('data', x => resp += x);
  s.on('error', () => {});
  setTimeout(() => { console.log(`target=${JSON.stringify(target)} -> server alive; response: ${JSON.stringify(resp.split('\r\n')[0])}`); child.kill(); }, 800);
});
