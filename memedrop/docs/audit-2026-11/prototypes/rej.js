const { EventEmitter } = require('events');
const e = new EventEmitter();
e.on('message', async (raw) => { const msg = JSON.parse(raw); String(msg.identity.userId || ''); });
e.emit('message', '{"type":"register","identity":{"userId":{"toString":1}}}');
setTimeout(() => console.log('still alive'), 200);
process.on('exit', (c) => console.log('exit code', c));
