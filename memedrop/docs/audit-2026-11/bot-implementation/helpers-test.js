'use strict';
// Unit checks of the pure helpers added to bot/index.js. The functions are
// extracted from the source text (the bot cannot be required here without
// discord.js) and evaluated in a sandbox.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
function grab(re) {
  const m = src.match(re);
  if (!m) throw new Error(`not found: ${re}`);
  return m[0];
}
const code = [
  'const MAX_TTS_CHARS = 200;',
  grab(/function clip\([\s\S]*?\n}\n/),
  grab(/function normTtsText\([\s\S]*?\n}\n/),
  grab(/function ipKey\([\s\S]*?\n}\n/),
  grab(/function clientIp\([\s\S]*?\n}\n/),
  grab(/const MAX_MESSAGE_CHARS = 2000;\nfunction capLines\([\s\S]*?\n}\n/),
  grab(/function markCooldown\([\s\S]*?\n}\n/),
  grab(/function reserveCooldown\([\s\S]*?\n}\n/),
  grab(/function formatCooldown\([\s\S]*?\n}\n/),
  grab(/const str = .*\n/),
  grab(/const SNOWFLAKE = .*\n/),
  grab(/const sid = .*\n/),
  grab(/const ids = .*\n/),
  'module.exports = { clip, normTtsText, ipKey, clientIp, capLines, reserveCooldown, formatCooldown, str, sid, ids };',
].join('\n');
const sandbox = { module: {}, process: { env: {} }, Date, String, Math, Array, parseInt };
vm.runInNewContext(code, sandbox);
const h = sandbox.module.exports;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

t('clip keeps whole emoji pairs', () => {
  assert.strictEqual(h.clip(`${'a'.repeat(199)}😂`, 200), 'a'.repeat(199));
  assert.strictEqual(h.clip(`${'a'.repeat(198)}😂`, 200), `${'a'.repeat(198)}😂`);
  assert.strictEqual(h.clip('😂'.repeat(150), 200), '😂'.repeat(100));
  assert.strictEqual(h.clip(`${'x'.repeat(79)}😂😂`, 80), 'x'.repeat(79));
  assert.doesNotThrow(() => encodeURIComponent(h.clip(`a${'🔥'.repeat(199)}`, 200)));
});
t('normTtsText trims then clips (same key as the warm-up)', () => {
  assert.strictEqual(h.normTtsText(null), '');
  assert.strictEqual(h.normTtsText('  Bonjour '), 'Bonjour');
  const payloadTts = h.clip(`${'a'.repeat(199)} bcd`, 200);   // what buildDropPayload stores
  assert.strictEqual(payloadTts, `${'a'.repeat(199)} `);
  const fromUrl = new URL(`http://x/tts?text=${encodeURIComponent(payloadTts)}`).searchParams.get('text');
  assert.strictEqual(h.normTtsText(fromUrl), h.normTtsText(payloadTts));
});
t('ipKey: IPv4, mapped IPv4, IPv6 /64', () => {
  assert.strictEqual(h.ipKey('198.51.100.7'), '198.51.100.7');
  assert.strictEqual(h.ipKey('::ffff:127.0.0.1'), '127.0.0.1');
  assert.strictEqual(h.ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.strictEqual(h.ipKey('2001:DB8:1:2::9'), '2001:db8:1:2::/64');
  assert.strictEqual(h.ipKey('2001:0db8:0001:0002:ffff::1'), '2001:db8:1:2::/64');
  assert.strictEqual(h.ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.strictEqual(h.ipKey('::1'), '0:0:0:0::/64');
  assert.strictEqual(h.ipKey(''), '');
});
t('clientIp: last XFF hop; Fly-Client-IP only on Fly', () => {
  const req = (headers, remote = '::ffff:10.1.1.1') => ({ headers, socket: { remoteAddress: remote } });
  assert.strictEqual(h.clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), '2.2.2.2');
  assert.strictEqual(h.clientIp(req({ 'x-forwarded-for': '2.2.2.2' })), '2.2.2.2');
  assert.strictEqual(h.clientIp(req({})), '::ffff:10.1.1.1');
  assert.strictEqual(h.clientIp(req({ 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })), '1.1.1.1');
  sandbox.process.env.FLY_APP_NAME = 'app';
  assert.strictEqual(h.clientIp(req({ 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })), '9.9.9.9');
  assert.strictEqual(h.clientIp(req({ 'x-forwarded-for': '1.1.1.1, 3.3.3.3' })), '3.3.3.3');
  delete sandbox.process.env.FLY_APP_NAME;
});
t('capLines stays within 2000 chars and counts the rest', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `• 2999999999999999${String(i).padStart(2, '0')} (\`2999999999999999${String(i).padStart(2, '0')}\`)`);
  const out = h.capLines('**Utilisateurs bloqués :**', lines);
  assert.ok(out.length <= 2000, out.length);
  const shown = out.split('\n').filter((l) => l.startsWith('• ')).length;
  assert.ok(out.endsWith(`… et ${60 - shown} autres`));
  assert.strictEqual(h.capLines('H', ['a', 'b']), 'H\na\nb');
  const one = h.capLines('H', ['x'.repeat(1900), 'y'.repeat(200)]);
  assert.ok(one.length <= 2000 && one.endsWith('… et 1 autre') && one.includes('x'.repeat(1900)), one.slice(-20));
  const two = h.capLines('H', ['x'.repeat(1990), 'y'.repeat(20)]);   // even "… et 1 autre" would not fit
  assert.ok(two.length <= 2000 && two === 'H\n… et 2 autres', two.slice(-20));
  const huge = h.capLines('H', ['z'.repeat(5000)]);
  assert.ok(huge.length <= 2000 && huge.endsWith('… et 1 autre'));
});
t('formatCooldown rounds up to the tenth', () => {
  assert.strictEqual(h.formatCooldown(1), '0.1');
  assert.strictEqual(h.formatCooldown(49), '0.1');
  assert.strictEqual(h.formatCooldown(1500), '1.5');
  assert.strictEqual(h.formatCooldown(1501), '1.6');
  assert.strictEqual(h.formatCooldown(2000), '2');
  assert.strictEqual(h.formatCooldown(15000), '15');
});
t('reserveCooldown restores the previous state', () => {
  const m = new Map();
  const undo = h.reserveCooldown(m, 'u');
  assert.ok(m.has('u'));
  undo();
  assert.ok(!m.has('u'));
  m.set('v', 123);
  const undo2 = h.reserveCooldown(m, 'v');
  assert.notStrictEqual(m.get('v'), 123);
  undo2();
  assert.strictEqual(m.get('v'), 123);
});
t('str/sid/ids never call String() on objects', () => {
  const evil = { toString: 1 };
  assert.strictEqual(h.str(evil), '');
  assert.strictEqual(h.str(42), '42');
  assert.strictEqual(h.str('x'), 'x');
  assert.strictEqual(h.str(null), '');
  assert.strictEqual(h.sid(evil), null);
  assert.strictEqual(h.sid(210000000000000001), null);
  assert.strictEqual(h.sid('210000000000000001'), '210000000000000001');
  assert.strictEqual(h.sid('../channels/1'), null);
  assert.strictEqual(h.sid('1234567890123456'), null);           // 16 digits
  assert.strictEqual(h.sid('123456789012345678901'), null);      // 21 digits
  assert.deepStrictEqual([...h.ids(['210000000000000001', evil, 'abc', '110000000000000001'], 200)], ['210000000000000001', '110000000000000001']);
  assert.deepStrictEqual([...h.ids('garbage', 5)], []);
  assert.strictEqual(h.ids(Array.from({ length: 300 }, (_, i) => String(110000000000000000n + BigInt(i))), 200).length, 200);
});
console.log(`\n${n} helper groups OK`);
