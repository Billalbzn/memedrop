// Simule ws.on('message', async ...) : EventEmitter par défaut (captureRejections false)
const { EventEmitter } = require('events');
const mode = process.argv[2];
if (mode === 'ws') {
  const ws = new EventEmitter();
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'register') {
      const id = msg.identity || {};
      const userId = String(id.userId || '');   // index.js:359
      console.log('userId', userId);
    }
  });
  ws.emit('message', '{"type":"register","identity":{"userId":{"toString":1}}}');
  setTimeout(() => console.log('still alive (ws)'), 200);
}
if (mode === 'djs-capture' || mode === 'djs-nocapture') {
  // Simule client.on(InteractionCreate, async ...) avec `return interaction.reply()` dans un try
  const client = new EventEmitter({ captureRejections: mode === 'djs-capture' });
  const reply = () => Promise.reject(new Error('DiscordAPIError[10062]: Unknown interaction'));
  client.on('interactionCreate', async () => {
    try {
      return reply();               // index.js : return interaction.reply({...})
    } catch (err) {
      console.log('caught by try/catch (not expected)');
    }
  });
  client.emit('interactionCreate', {});
  setTimeout(() => console.log('still alive (' + mode + ')'), 200);
}
