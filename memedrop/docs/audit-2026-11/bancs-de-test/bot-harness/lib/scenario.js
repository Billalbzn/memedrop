'use strict';
// The behaviour scenario. Only observable inputs/outputs are used: slash
// commands, overlay WebSocket messages, HTTP requests, the virtual clock, the
// DATA_DIR on disk and process signals.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { U, ATT, EPOCH, LINK_SECRET, WORLD } = require('./driver');

const { USERS, GUILDS, UNKNOWN_GUILD_ID } = WORLD;
const G1 = GUILDS.G1.id;
const G2 = GUILDS.G2.id;
const hmac = (userId) => crypto.createHmac('sha256', LINK_SECRET).update(String(userId)).digest('hex');
const enc = encodeURIComponent;

// ── Attachments (shape of discord.js Attachment) ──
let attSeq = 0;
function att(name, contentType, size, extra = {}) {
  const id = String(600000000000000000n + BigInt(++attSeq));
  return ATT({ id, url: `https://cdn.discordapp.com/attachments/310000000000000001/${id}/${name}`, name, contentType, size, ...extra });
}
const IMG = att('cat.png', 'image/png', 48213, { width: 640, height: 480 });
const JPG = att('photo.jpg', 'image/jpeg', 91234, { width: 1024, height: 768 });
const WEBP = att('sticker.webp', 'image/webp', 20480, { width: 256, height: 256 });
const GIF = att('dance.gif', 'image/gif', 1048576, { width: 320, height: 240 });
const MP4 = att('clip.mp4', 'video/mp4', 5242880, { width: 1280, height: 720 });
const MOV = att('iphone.mov', 'video/quicktime', 7340032, { width: 1920, height: 1080 });
const MP3 = att('song.mp3', 'audio/mpeg', 3145728);
const WEBM_MUSIC = att('track.webm', 'video/webm', 2097152, { width: 640, height: 360 });
const TXT = att('notes.txt', 'text/plain; charset=utf-8', 1200);
const NOMIME = att('mystery.bin', null, 100);
const BIG = att('huge.png', 'image/png', 30 * 1024 * 1024, { width: 8000, height: 8000 });
const BIGMP3 = att('long.mp3', 'audio/mpeg', 26 * 1024 * 1024);

function dropsOf(o) { return o.messages.filter((m) => m && m.type === 'drop'); }

module.exports = async function scenario(h) {
  const dataMain = path.join(h.workDir, 'data-main');
  let p1End = EPOCH;

  // ═════════════════════════ p1: main lifecycle ═══════════════════════════
  await h.runProcess('p1', { dataDir: dataMain, epoch: EPOCH, env: { LINK_SECRET }, title: 'fresh DATA_DIR, LINK_SECRET set' }, async (bot) => {
    const cooldown = () => h.advance(2000, 'advance +2000 ms (lets a /drop cooldown expire)');

    // ── HTTP basics ──
    await h.get('/health');
    await h.get('/');
    await h.get('/health?probe=1');
    await h.get('/health/');
    await h.get('/nope');
    await h.get('/health', { method: 'HEAD' });
    await h.get('/health', { method: 'POST' });
    await h.get('/tts?text=Bonjour', { method: 'POST' });
    await h.get('/tts?text=Bonjour', { method: 'HEAD' });
    await h.get('/tts');
    await h.get('/tts?text=');
    await h.get('/tts?text=%20%20%20');

    // ── /tts happy path + cache ──
    await h.get('/tts?text=Bonjour');
    await h.get('/tts?text=Bonjour', { desc: 'HTTP GET /tts?text=Bonjour again (cache)' });
    await h.get('/tts?text=%20Bonjour%20');
    await h.get('/tts?text=Bonjour&lang=en');
    await h.get('/tts?text=Bonjour&lang=EN');
    await h.get('/tts?text=Bonjour&lang=pt-BR');
    await h.get('/tts?text=Bonjour&lang=pt-br');
    await h.get('/tts?text=Bonjour&lang=../x');
    await h.get(`/tts?text=${'a'.repeat(250)}`);
    await h.get(`/tts?text=${'a'.repeat(200)}`);
    await h.get(`/tts?text=${enc('Ça va ? 😂 & co')}`);
    // 200th UTF-16 unit is the high half of an emoji: truncation splits the pair.
    await h.get(`/tts?text=${enc(`${'b'.repeat(199)}😂`)}`);

    // ── /tts: 5 concurrent requests for the same new text ──
    await h.setUpstreamLatency(300);
    await h.getConcurrent(5, `/tts?text=${enc('cinq requêtes en même temps')}`, { headers: { 'x-forwarded-for': '198.51.100.20' } });
    await h.setUpstreamLatency(10);
    await h.get(`/tts?text=${enc('cinq requêtes en même temps')}`, { headers: { 'x-forwarded-for': '198.51.100.20' } });

    // ── /tts: upstream failures are not cached ──
    await h.get(`/tts?text=${enc('boom [503]')}`);
    await h.get(`/tts?text=${enc('boom [503]')}`, { desc: 'HTTP GET /tts?text=boom [503] again (failure not cached?)' });
    await h.get(`/tts?text=${enc('cut [neterr]')}`);

    // ── /tts: rate limiting per client IP (30 uncached requests / 60 s) ──
    const ip7 = { 'x-forwarded-for': '198.51.100.7' };
    await h.httpSeries('31 distinct uncached /tts texts from 198.51.100.7',
      Array.from({ length: 31 }, (_, i) => ({ path: `/tts?text=rl-${String(i + 1).padStart(2, '0')}`, headers: ip7 })));
    await h.get('/tts?text=rl-01', { headers: ip7, desc: 'HTTP GET cached text rl-01 from the rate-limited IP' });
    await h.get('/tts?text=rl-32', { headers: ip7 });
    await h.get('/tts?text=other-ip', { headers: { 'x-forwarded-for': '198.51.100.8' } });
    await h.get('/tts?text=rl-33', { headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } });
    await h.get('/tts?text=rl-34', { headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.7' } });
    await h.httpSeries('31 uncached /tts texts, each with a different spoofed X-Forwarded-For',
      Array.from({ length: 31 }, (_, i) => ({ path: `/tts?text=spoof-${String(i + 1).padStart(2, '0')}`, headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } })));
    await h.advance(60_000, 'advance +60000 ms (exactly one rate-limit window)');
    await h.get('/tts?text=rl-35', { headers: ip7 });
    await h.advance(1, 'advance +1 ms (window elapsed)');
    await h.get('/tts?text=rl-36', { headers: ip7 });

    // ── /tts: LRU cache of 50 entries ──
    await h.httpSeries('fill the cache with 50 new texts lru-00..lru-49 (3 client IPs)',
      Array.from({ length: 50 }, (_, i) => ({ path: `/tts?text=lru-${String(i).padStart(2, '0')}`, headers: { 'x-forwarded-for': `192.0.2.${1 + Math.floor(i / 20)}` } })));
    await h.get('/tts?text=lru-00', { headers: { 'x-forwarded-for': '192.0.2.9' }, desc: 'HTTP GET lru-00 (touch: most recently used)' });
    await h.get('/tts?text=lru-50', { headers: { 'x-forwarded-for': '192.0.2.9' }, desc: 'HTTP GET lru-50 (51st entry: evicts one)' });
    await h.get('/tts?text=lru-00', { headers: { 'x-forwarded-for': '192.0.2.9' }, desc: 'HTTP GET lru-00 (still cached?)' });
    await h.get('/tts?text=lru-01', { headers: { 'x-forwarded-for': '192.0.2.9' }, desc: 'HTTP GET lru-01 (evicted?)' });
    await h.get('/tts?text=Bonjour', { headers: { 'x-forwarded-for': '192.0.2.9' }, desc: 'HTTP GET Bonjour (old entry, evicted?)' });

    // ── Overlay A + /link ──
    const A = await h.connect('A');
    await h.cmd('alice', 'G1#general', 'link', { code: 'ABC123' });
    const unissued = (() => { for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (!h.norm.codes.has(c)) return c; } })();
    h.norm.fixed.set(unissued, '<UNISSUED_CODE>');
    await h.cmd('alice', 'G1#general', 'link', { code: unissued });
    const codeA1 = A.code;
    await h.cmd('alice', 'G1#general', 'link', { code: codeA1 });
    const tokenAlice = A.last('linked')?.token;
    await h.cmd('bob', 'G1#general', 'link', { code: codeA1 }, { desc: '/link with the code A already consumed — by bob' });
    await h.cmd('bob', 'G1#general', 'link', { code: A.code }, { desc: "/link with alice's extension code — by bob" });
    await h.cmd('alice', 'G1#general', 'status');
    await h.cmd('alice', 'G2#memes', 'status');
    await h.cmd('bob', 'G1#general', 'status');
    await h.cmd('alice', 'G1#general', 'who');

    const B = await h.connect('B');
    await h.cmd('bob', 'G1#general', 'link', { code: B.code });
    await h.cmd('carol', 'G1#general', 'who');
    await h.cmd('carol', 'G2#memes', 'who');

    // Overlays that re-link with a stored identity (token = HMAC of the user id).
    const F = await h.connect('F');
    await h.wsSend('F', { type: 'register', identity: { userId: USERS.frank.id, username: 'frank', scope: 'guild', guildIds: [G1], token: hmac(USERS.frank.id), blockedIds: [] } });
    const E = await h.connect('E');
    await h.wsSend('E', { type: 'register', identity: { userId: USERS.erin.id, username: 'erin', scope: 'guild', guildIds: [G1, UNKNOWN_GUILD_ID], token: hmac(USERS.erin.id) } });
    await h.cmd('carol', 'G1#general', 'who', {}, { desc: '/who — by carol @G1#general (frank: member never seen; erin: not a member)' });

    // ── /drop basics + cooldown ──
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG, caption: 'lol' });
    const dropBob1 = dropsOf(A).at(-1)?.dropId;
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop again immediately — by bob' });
    await h.advance(500);
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop 500 ms later — by bob' });
    await h.advance(1499);
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop 1999 ms later — by bob' });
    await h.advance(1);
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: GIF, effet: 'glitch' }, { desc: '/drop exactly 2000 ms later (gif, effet glitch) — by bob' });

    // ── /drop validation (errors must not consume the cooldown) ──
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: TXT });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: NOMIME });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: BIG });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice') });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), pluie: 'pas d emoji' });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), tts: '   ' });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: MP4, musique: MP3 });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), pluie: '🔥', musique: MP3 });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: IMG, musique: IMG });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: IMG, musique: BIGMP3 });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('memebot'), media: IMG });
    await h.cmd('carol', 'G1#general', 'drop', {
      target: U('alice'), target2: U('bob'), target3: U('memebot'), target4: U('alice'), target5: U('dave'),
      media: IMG, musique: MP3, caption: `${'x'.repeat(79)}😂😂`, pluie: '🔥💀🔥', tts: 'salut toi', effet: 'tornade',
    }, { desc: '/drop to alice,bob,memebot,alice,dave with image+musique+caption+pluie+tts+effet — by carol (right after the errors)' });
    const dropMulti = dropsOf(A).at(-1)?.dropId;
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), pluie: '👍🏽👨‍👩‍👧😂😂🎉🚀🌈' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), tts: `${'t'.repeat(250)}` });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), tts: `${'a'.repeat(199)}😂` }, { desc: '/drop tts = 199×"a" + 😂 (truncation at 200 splits the emoji) — by carol' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: MP4, effet: 'nope' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: MOV, tts: 'Ça va & toi ?', effet: 'shake' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: MP3, effet: 'zoom' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: JPG, musique: WEBM_MUSIC });
    await h.cmd('alice', 'G1#general', 'drop', { target: U('alice'), media: WEBP }, { desc: '/drop on herself — by alice' });
    const dropSelf = dropsOf(A).at(-1)?.dropId;
    await h.cmd('bob', 'G2#memes', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop from G2 where alice is not linked — by bob' });
    await cooldown();
    await h.cmd('frank', 'G1#general', 'drop', { target: U('erin'), media: IMG }, { desc: '/drop to erin (linked on G1 but not a member) — by frank' });
    await h.cmd('bob', 'G1#old-memes', 'drop', { target: U('alice'), media: JPG }, { desc: '/drop from #old-memes — by bob' });
    const dropOldChannel = dropsOf(A).at(-1)?.dropId;

    // ── /drop delai ──
    await cooldown();
    const delayedAt = bot.now;
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), target2: U('frank'), media: IMG, caption: 'surprise', delai: 1 });
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop right after scheduling — by bob' });
    await cooldown();
    const delayed60At = bot.now;
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: GIF, delai: 90 });
    await cooldown();
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG, delai: 0 });
    await h.wsClose('F', 'overlay F (frank) disconnects before the delayed drop fires');
    await h.advanceTo(delayedAt + 60_000 - 1, 'advance to 1 ms before the 1-minute delayed drop');
    await h.advance(1, 'advance +1 ms (delayed drop due)');
    const dropDelayed = dropsOf(A).at(-1)?.dropId;

    // ── /dropall ──
    await h.cmd('carol', 'G1#general', 'dropall', { media: IMG, caption: 'pour tous' });
    const dropAll = dropsOf(A).at(-1)?.dropId;
    await h.cmd('carol', 'G1#general', 'dropall', { media: IMG }, { desc: '/dropall again immediately — by carol' });
    await h.advance(5000);
    await h.cmd('carol', 'G2#memes', 'dropall', { media: IMG }, { desc: '/dropall 5 s later from G2 — by carol' });
    await h.cmd('alice', 'G2#memes', 'dropall', { media: IMG }, { desc: '/dropall from G2 where nobody is linked — by alice' });
    await h.cmd('alice', 'G1#general', 'dropall', {}, { desc: '/dropall without media/pluie/tts — by alice' });
    await h.cmd('alice', 'G1#general', 'dropall', { tts: 'coucou tout le monde', pluie: '🎉', effet: 'zoom' });
    await h.cmdBurst('/dropall twice in the same instant — by bob', [
      ['bob', 'G1#general', 'dropall', { media: IMG }],
      ['bob', 'G1#general', 'dropall', { media: GIF }],
    ]);

    // ── reactions ──
    await h.wsSend('A', { type: 'react', dropId: dropBob1, emoji: '😂' });
    await h.wsSend('A', { type: 'react', dropId: dropBob1, emoji: '🔥' }, { desc: 'overlay A reacts 🔥 to the same drop again' });
    await h.wsSend('B', { type: 'react', dropId: dropMulti, emoji: '💀' });
    await h.wsSend('A', { type: 'react', dropId: dropMulti, emoji: '👍' });
    await h.wsSend('A', { type: 'react', dropId: dropMulti, emoji: '🖕' });
    await h.wsSend('A', { type: 'react', dropId: dropSelf, emoji: '😭' }, { desc: 'overlay A reacts to its own self-drop' });
    await h.wsSend('A', { type: 'react', dropId: 'deadbeefdeadbeef', emoji: '😂' });
    await h.wsSend('A', { type: 'react', dropId: dropAll, emoji: 42 });
    await h.wsSend('A', { type: 'react', dropId: dropAll, emoji: '🔥' });
    await h.wsSend('A', { type: 'react', dropId: dropDelayed, emoji: '💀' }, { desc: 'overlay A reacts to the delayed drop' });
    await h.wsSend('E', { type: 'react', dropId: dropAll, emoji: '😂' }, { desc: 'overlay E (erin, linked) reacts to a /dropall drop she never received' });
    const P = await h.connect('P', { desc: 'overlay P connects (stays unlinked)' });
    await h.wsSend('P', { type: 'react', dropId: dropAll, emoji: '😂' }, { desc: 'unlinked overlay P reacts' });
    await h.world('deleteChannel', [WORLD.CHANNELS['G1#old-memes'].id], 'world: channel #old-memes is deleted');
    await h.wsSend('A', { type: 'react', dropId: dropOldChannel, emoji: '😂' }, { desc: 'overlay A reacts to the drop sent from the deleted channel' });

    // ── block / unblock ──
    await h.cmd('alice', 'G1#general', 'block', { user: U('bob') });
    await cooldown();
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice who blocked bob — by bob' });
    await h.cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop again immediately (was the cooldown consumed?) — by bob' });
    await h.cmd('bob', 'G1#general', 'who');
    await h.advance(15_000, 'advance +15 s (lets the /dropall cooldown expire)');
    await h.cmd('bob', 'G1#general', 'dropall', { media: IMG, musique: MP3 }, { desc: '/dropall with musique after alice blocked bob — by bob' });
    await h.cmd('alice', 'G1#general', 'blocklist');
    await h.cmd('alice', 'G1#general', 'block', { user: U('alice') });
    await h.cmd('carol', 'G1#general', 'block', { user: U('bob') });
    await h.cmd('alice', 'G1#general', 'block', { user: U('ghost') });
    await h.cmd('alice', 'G1#general', 'blocklist');
    await h.wsSend('A', { type: 'unblock_user', userId: USERS.bob.id });
    await h.wsSend('A', { type: 'unblock_user', userId: '' });
    await h.wsSend('P', { type: 'unblock_user', userId: USERS.ghost.id }, { desc: 'unlinked overlay P sends unblock_user' });
    await h.cmd('alice', 'G1#general', 'unblock', { user: U('bob') });
    await h.cmd('alice', 'G1#general', 'unblock', { user: U('ghost') });
    await h.cmd('carol', 'G1#general', 'unblock', { user: U('bob') });
    await h.cmd('alice', 'G1#general', 'blocklist');
    await h.cmd('alice', 'G1#general', 'block', { user: U('bob') }, { desc: '/block @bob again — by alice' });

    // ── favorites ──
    await h.cmd('alice', 'G1#general', 'fav', {}, { sub: 'list' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'Tomato', media: GIF, caption: 'splat' }, { sub: 'add' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'tomato', media: IMG }, { sub: 'add' });
    await h.cmd('alice', 'G1#general', 'fav', { name: '   ', media: IMG }, { sub: 'add' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'doc', media: TXT }, { sub: 'add' });
    const favMedia = [IMG, MP4, MP3, GIF, JPG, WEBP, MOV, IMG, IMG];
    for (let i = 2; i <= 10; i++) {
      await h.cmd('alice', 'G1#general', 'fav', { name: `f${i}`, media: favMedia[i - 2], caption: i === 3 ? `${'c'.repeat(90)}` : undefined }, { sub: 'add' });
    }
    await h.cmd('alice', 'G1#general', 'fav', { name: 'f11', media: IMG }, { sub: 'add' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'TOMATO', media: GIF, caption: 'at the limit' }, { sub: 'add' });
    await h.cmd('alice', 'G1#general', 'fav', {}, { sub: 'list' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'F2' }, { sub: 'remove' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'nope' }, { sub: 'remove' });
    await h.cmd('bob', 'G1#general', 'fav', {}, { sub: 'list' });
    await cooldown();
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'tomato', target: U('bob'), pluie: '🍅', effet: 'zoom' });
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'f3', target: U('bob') }, { desc: '/dropfav right after — by alice' });
    await cooldown();
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'nope', target: U('bob') });
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'f3', target: U('memebot') });
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'F3', target: U('bob'), target2: U('erin'), target3: U('dave') });
    await cooldown();
    await h.cmd('alice', 'G1#general', 'drop', { target: U('bob'), media: IMG }, { desc: '/drop right after /dropfav cooldown expired — by alice' });

    // ── groups ──
    await h.cmd('carol', 'G1#general', 'group', {}, { sub: 'list' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'Squad', target: U('alice'), target2: U('bob'), target3: U('memebot'), target4: U('bob') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'squad', target: U('frank') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: '  ', target: U('bob') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'bots', target: U('memebot') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'ghosts', target: U('ghost') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'duo', target: U('bob'), target2: U('alice') }, { sub: 'set' });
    for (let i = 1; i <= 7; i++) {
      await h.cmd('carol', 'G1#general', 'group', { name: `g${i}`, target: U('alice') }, { sub: 'set' });
    }
    await h.cmd('carol', 'G1#general', 'group', { name: 'g8', target: U('bob') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'G1', target: U('bob') }, { sub: 'set' });
    await h.cmd('carol', 'G1#general', 'group', {}, { sub: 'list' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'SQUAD' }, { sub: 'delete' });
    await h.cmd('carol', 'G1#general', 'group', { name: 'nope' }, { sub: 'delete' });
    await h.cmd('alice', 'G1#general', 'group', {}, { sub: 'list' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'DUO', media: IMG, tts: 'surprise' });
    const dropDuo = dropsOf(A).at(-1)?.dropId;
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'duo', media: IMG }, { desc: '/dropgroup right after — by carol' });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'nope', media: IMG });
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'g1', media: TXT });
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'ghosts', media: IMG });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'G1', pluie: '💀', musique: MP3 });
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'G1', media: GIF, musique: MP3, effet: 'tornade' });

    // ── stats ──
    await h.cmd('alice', 'G1#general', 'stats');
    await h.cmd('dave', 'G1#general', 'stats');

    // ── multi-guild: extension code, guild updates, unlink_guild ──
    const extCode1 = A.code;
    await h.cmd('alice', 'G2#memes', 'link', { code: extCode1 }, { desc: "/link with A's extension code — by alice @G2#memes" });
    await h.cmd('alice', 'G2#memes', 'link', { code: extCode1 }, { desc: '/link with the same (rotated) extension code again — by alice @G2#memes' });
    await h.cmd('alice', 'G2#memes', 'status');
    await cooldown();
    await h.cmd('carol', 'G2#memes', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice from G2 now that she linked there — by carol' });
    await h.cmd('carol', 'G2#memes', 'who');
    await h.world('guildUpdate', [G2, { name: 'Gaming Squad ⚡', icon: 'a_9a3e0000000000000000000000000002' }], 'world: guild G2 renamed + animated icon (guildUpdate)');
    await h.world('guildUpdate', [G1, { name: 'Les Potes' }], 'world: guild G1 updated with the same name (guildUpdate)');
    await h.wsSend('A', { type: 'unlink_guild', guildId: G2 });
    await h.wsSend('A', { type: 'unlink_guild', guildId: '999' });
    await h.wsSend('A', { type: 'unlink_guild' });
    await h.wsSend('P', { type: 'unlink_guild', guildId: G1 }, { desc: 'unlinked overlay P sends unlink_guild' });
    await h.wsSend('E', { type: 'unlink_guild', guildId: UNKNOWN_GUILD_ID });
    await h.wsSend('E', { type: 'unlink_guild', guildId: G1 }, { desc: 'overlay E unlinks its last guild' });
    await h.cmd('carol', 'G1#general', 'who');

    // ── legacy global scope (register) ──
    const D = await h.connect('D');
    await h.wsSend('D', { type: 'register', identity: { userId: USERS.dave.id, username: 'dave', scope: 'global', token: hmac(USERS.dave.id) } });
    await h.cmd('dave', 'G1#general', 'status');
    await h.cmd('dave', 'G1#general', 'link', { code: D.code }, { desc: "/link with D's extension code (global link) — by dave" });
    await cooldown();
    await h.cmd('carol', 'G2#memes', 'drop', { target: U('dave'), media: IMG }, { desc: '/drop to dave (global link) from G2 — by carol' });
    await h.cmd('carol', 'G2#memes', 'who');
    await h.wsSend('D', { type: 'unlink_guild', guildId: G1 });

    // ── register failures ──
    const X = await h.connect('X');
    await h.wsSend('X', { type: 'register' });
    await h.wsSend('X', { type: 'register', identity: 'garbage' });
    await h.wsSend('X', { type: 'register', identity: { userId: USERS.bob.id, username: 'bob', scope: 'guild', guildIds: [G1], token: 'f'.repeat(64) } }, { desc: 'overlay X registers as bob with a forged token' });
    await h.wsSend('X', { type: 'register', identity: { userId: USERS.bob.id, username: 'bob', scope: 'guild', guildIds: [G1] } }, { desc: 'overlay X registers as bob without a token' });
    await h.wsSend('X', { type: 'register', identity: { userId: USERS.bob.id, username: 'bob', scope: 'guild', guildIds: [], token: hmac(USERS.bob.id) } }, { desc: 'overlay X registers as bob (valid token) with no guild' });
    await h.cmd('carol', 'G1#general', 'link', { code: X.code }, { desc: "/link with X's pairing code after its failed registers — by carol" });
    await h.cmd('carol', 'G1#general', 'unlink');
    await h.wsClose('X');
    await h.wsClose('P', 'overlay P (unlinked) disconnects');
    await h.cmd('carol', 'G1#general', 'link', { code: P.code }, { desc: "/link with P's code after P disconnected — by carol" });

    // ── reconnect, register, replacement ──
    await h.wsClose('A', 'overlay A (alice) disconnects');
    await h.cmd('alice', 'G1#general', 'status');
    await h.cmd('alice', 'G1#general', 'link', { code: A.code }, { desc: "/link with A's last extension code after A disconnected — by alice" });
    await cooldown();
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice while her overlay is gone — by carol' });
    const C = await h.connect('C', { desc: 'overlay C connects (alice reconnects)' });
    await h.wsSend('C', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: tokenAlice, blockedIds: [USERS.bob.id] } }, { desc: 'overlay C registers as alice with the token from her /link' });
    await h.wsSend('C', { type: 'register', identity: { userId: USERS.alice.id, username: 'Alice!', scope: 'guild', guildIds: [G1], token: tokenAlice, blockedIds: [USERS.bob.id] } }, { desc: 'overlay C sends the same register again (already linked, other username)' });
    await h.cmd('alice', 'G1#general', 'status');
    await h.cmd('alice', 'G1#general', 'blocklist');
    const C2 = await h.connect('C2', { desc: 'overlay C2 connects (alice on a second PC)' });
    await h.wsSend('C2', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1, G2], token: hmac(USERS.alice.id), blockedIds: [] } }, { desc: 'overlay C2 registers as alice (HMAC token) while C holds the link' });
    await h.wsSend('C', { type: 'unblock_user', userId: USERS.bob.id }, { desc: 'replaced overlay C sends unblock_user' });
    await h.wsSend('C', { type: 'react', dropId: dropAll, emoji: '😭' }, { desc: 'replaced overlay C reacts' });
    await h.cmd('alice', 'G1#general', 'block', { user: U('carol') });
    await h.cmd('alice', 'G1#general', 'link', { code: C.code }, { desc: "/link with C's fresh pairing code while C2 holds the link — by alice" });
    await h.cmd('alice', 'G1#general', 'blocklist');
    await h.wsClose('C2');

    // ── /unlink ──
    const extBeforeUnlink = C.code;
    await h.cmd('alice', 'G1#general', 'unlink');
    await h.cmd('alice', 'G1#general', 'unlink', {}, { desc: '/unlink again — by alice' });
    await h.cmd('alice', 'G1#general', 'link', { code: extBeforeUnlink }, { desc: '/link with the extension code shown before /unlink — by alice' });
    await h.cmd('alice', 'G1#general', 'link', { code: C.code }, { desc: "/link with C's new pairing code — by alice" });

    // ── DM, non-command interactions, unknown command ──
    await h.cmd('alice', 'DM', 'drop', { target: U('bob'), media: IMG });
    await h.cmd('alice', 'DM', 'status');
    await h.cmd('alice', 'G1#general', 'drop', {}, { kind: 'button', desc: 'button interaction (not a slash command) — by alice' });
    await h.cmd('alice', 'G1#general', 'ping');

    // ── garbage & oversized WebSocket messages ──
    for (const g of ['not json', '{', 'null', '42', '"str"', '[]', '{"type":"unknown"}', '{"type":"react"}', '{"type":"pong"}', '{"type":"unblock_user","userId":{"x":1}}']) {
      await h.wsSend('B', g);
    }
    await h.wsSend('B', Buffer.from(JSON.stringify({ type: 'unblock_user', userId: USERS.carol.id })), { binary: true, desc: 'overlay B sends a binary frame containing unblock_user JSON' });
    const exact = JSON.stringify({ type: 'noise', pad: '' });
    await h.wsSend('B', JSON.stringify({ type: 'noise', pad: 'p'.repeat(64 * 1024 - exact.length) }), { desc: 'overlay B sends a 65536-byte message' });
    await h.cmd('bob', 'G1#general', 'status');
    await h.wsSend('B', JSON.stringify({ type: 'noise', pad: 'p'.repeat(64 * 1024 - exact.length + 1) }), { desc: 'overlay B sends a 65537-byte message' });
    await h.cmd('bob', 'G1#general', 'status');

    // ── heartbeat ──
    const Z = await h.connect('Z', { autoPong: false });
    void Z;
    const nextBeat = EPOCH + Math.ceil((bot.now - EPOCH + 1) / 30_000) * 30_000;
    await h.advanceTo(nextBeat, 'advance to the next 30 s heartbeat');
    await h.advance(30_000, 'advance +30 s (second heartbeat: Z never answered)');
    await h.cmd('carol', 'G1#general', 'who');

    // ── reactions are accepted for 15 min (positive and negative control) ──
    await cooldown();
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice (reaction window probe R1) — by frank' });
    const r1 = dropsOf(C).at(-1)?.dropId;
    const r1At = bot.now;
    await cooldown();
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: JPG }, { desc: '/drop to alice (reaction window probe R2) — by frank' });
    const r2 = dropsOf(C).at(-1)?.dropId;
    const r2At = bot.now;
    await h.advanceTo(r1At + 14 * 60_000, 'advance to 14 min after R1');
    await h.wsSend('C', { type: 'react', dropId: r1, emoji: '😭' }, { desc: 'overlay C reacts to R1 (14 min old)' });
    await h.advanceTo(r2At + 21 * 60_000, 'advance to 21 min after R2');
    await h.wsSend('C', { type: 'react', dropId: r2, emoji: '😭' }, { desc: 'overlay C reacts to R2 (21 min old)' });
    await h.wsSend('C', { type: 'react', dropId: dropDuo, emoji: '😂' }, { desc: 'overlay C (alice) reacts to the /dropgroup drop she got > 15 min ago' });

    // ── delayed drop clamped to 60 min ──
    await h.advanceTo(delayed60At + 60 * 60_000 - 1, 'advance to 1 ms before the 60-minute (clamped from 90) delayed drop');
    await h.advance(1, 'advance +1 ms (clamped delayed drop due)');
    await cooldown();
    await h.cmd('bob', 'G1#general', 'drop', { target: U('carol'), media: IMG }, { desc: '/drop to carol (no overlay) — by bob' });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice (blocked carol before /unlink + /link) — by carol' });
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice — by frank' });
    const fresh = dropsOf(C).at(-1)?.dropId;
    await h.wsSend('C', { type: 'react', dropId: fresh, emoji: '🔥' }, { desc: "overlay C reacts to frank's fresh drop" });
    await h.cmd('alice', 'G1#general', 'stats');

    // ── persistence ──
    await h.realWait(1000, 'wait 1000 ms of real time (store save debounce)');
    await h.snapshotStore('read DATA_DIR after the save debounce');
    await h.cmd('alice', 'G1#general', 'fav', { name: 'last-minute', media: IMG, caption: 'saved right before shutdown' }, { sub: 'add' });
    await h.signal('SIGINT');
    await h.snapshotStore('read DATA_DIR after SIGINT');
    p1End = bot.now;
  });

  // ═════════════════════════ p2: restart, same DATA_DIR ═══════════════════
  const p2Epoch = p1End + 3_600_000;
  await h.runProcess('p2', { dataDir: dataMain, epoch: p2Epoch, env: { LINK_SECRET, FLY_APP_NAME: 'memedrop-test', RAILWAY_PUBLIC_DOMAIN: 'rw.example.test' }, title: 'restart on the same DATA_DIR, FLY_APP_NAME + RAILWAY_PUBLIC_DOMAIN set' }, async () => {
    await h.connect('A');
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1, G2], token: hmac(USERS.alice.id), blockedIds: [USERS.bob.id, USERS.ghost.id] } }, { desc: 'overlay A registers as alice (blocked: bob, ghost) after the restart' });
    await h.connect('B');
    await h.wsSend('B', { type: 'register', identity: { userId: USERS.bob.id, username: 'bob', scope: 'guild', guildIds: [G1], token: hmac(USERS.bob.id) } });
    await h.cmd('alice', 'G1#general', 'fav', {}, { sub: 'list' });
    await h.cmd('carol', 'G1#general', 'group', {}, { sub: 'list' });
    await h.cmd('alice', 'G1#general', 'stats');
    await h.cmd('carol', 'G1#general', 'dropgroup', { name: 'ghosts', media: IMG });
    await h.cmd('alice', 'G1#general', 'dropfav', { name: 'last-minute', target: U('bob') });
    await h.cmd('carol', 'G2#memes', 'drop', { target: U('alice'), tts: 'après le redémarrage', media: IMG });
    await h.cmd('alice', 'G1#general', 'blocklist');
    await h.cmd('carol', 'G1#general', 'group', { name: 'g2' }, { sub: 'delete' });
    // One socket presenting a second identity (needs both valid tokens).
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.bob.id, username: 'bob', scope: 'guild', guildIds: [G1], token: hmac(USERS.bob.id) } }, { desc: 'overlay A (linked as alice) registers as bob' });
    await h.advance(2000, 'advance +2000 ms (lets a /drop cooldown expire)');
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: '/drop to alice after her socket re-registered as bob — by frank' });
    await h.cmd('alice', 'G1#general', 'status');
    await h.wsClose('A');
    await h.cmd('alice', 'G1#general', 'status', {}, { desc: '/status after overlay A closed — by alice' });
    await h.cmd('bob', 'G1#general', 'status', {}, { desc: '/status after overlay A closed — by bob' });
    await h.signal('SIGTERM');
    await h.snapshotStore('read DATA_DIR after SIGTERM');
  });

  // ═════════════════════════ p3: partial store + PUBLIC_BASE_URL ══════════
  const dataPartial = path.join(h.workDir, 'data-partial');
  fs.mkdirSync(dataPartial, { recursive: true });
  fs.writeFileSync(path.join(dataPartial, 'store.json'), JSON.stringify({
    favorites: { [USERS.alice.id]: [{ name: 'Vieux', url: 'https://cdn.discordapp.com/attachments/1/2/old.png', mime: 'image/png', kind: 'image', size: 1234, caption: null, savedAt: EPOCH - 86_400_000 }] },
  }));
  await h.runProcess('p3', { dataDir: dataPartial, epoch: p2Epoch + 3_600_000, env: { LINK_SECRET, PUBLIC_BASE_URL: 'https://memedrop.example.test///', FLY_APP_NAME: 'ignored-app' }, title: 'store.json with favorites only, PUBLIC_BASE_URL with trailing slashes' }, async () => {
    await h.cmd('alice', 'G1#general', 'fav', {}, { sub: 'list' });
    await h.cmd('carol', 'G1#general', 'group', {}, { sub: 'list' });
    await h.cmd('alice', 'G1#general', 'stats');
    await h.connect('A');
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: hmac(USERS.alice.id) } });
    await h.cmd('carol', 'G1#general', 'drop', { target: U('alice'), tts: 'base publique', pluie: '🎈' });
    await h.cmd('carol', 'G1#general', 'dropall', { tts: 'à tous' });

    // Discord rejects messages over 2000 characters.
    const many = Array.from({ length: 60 }, (_, i) => `2999999999999999${String(i).padStart(2, '0')}`);
    await h.connect('F');
    await h.wsSend('F', { type: 'register', identity: { userId: USERS.frank.id, username: 'frank', scope: 'guild', guildIds: [G1], token: hmac(USERS.frank.id), blockedIds: many } }, { desc: 'overlay F registers as frank with 60 blocked ids unknown to Discord' });
    await h.cmd('frank', 'G1#general', 'blocklist', {}, { desc: '/blocklist (60 entries) — by frank' });
    await h.realWait(1000, 'wait 1000 ms of real time (store save debounce)');
    await h.snapshotStore('read DATA_DIR after the save debounce');
  });

  // ═════════════════════════ p4: corrupt store, no LINK_SECRET ════════════
  const dataCorrupt = path.join(h.workDir, 'data-corrupt');
  fs.mkdirSync(dataCorrupt, { recursive: true });
  fs.writeFileSync(path.join(dataCorrupt, 'store.json'), '{"favorites": {"oops"');
  await h.runProcess('p4', { dataDir: dataCorrupt, epoch: p2Epoch + 7_200_000, env: {}, title: 'unparsable store.json, LINK_SECRET unset' }, async () => {
    await h.cmd('alice', 'G1#general', 'fav', {}, { sub: 'list' });
    const A = await h.connect('A');
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: hmac(USERS.alice.id) } }, { desc: 'overlay A registers with the HMAC token of the configured secret' });
    await h.cmd('alice', 'G1#general', 'link', { code: A.code });
    const tok = A.last('linked')?.token;
    await h.wsClose('A');
    await h.connect('A2');
    await h.wsSend('A2', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: tok } }, { desc: 'overlay A2 registers with the token this process issued' });
    await h.cmd('alice', 'G1#general', 'fav', { name: 'neuf', media: IMG }, { sub: 'add' });
    await h.realWait(1000, 'wait 1000 ms of real time (store save debounce)');
    await h.snapshotStore('read DATA_DIR after the save debounce');
  });

  // ═════════════════════════ p5: malformed HTTP request-target ════════════
  const dataCrash = path.join(h.workDir, 'data-crash');
  await h.runProcess('p5', { dataDir: dataCrash, epoch: p2Epoch + 10_800_000, env: { LINK_SECRET }, title: 'malformed HTTP request-target' }, async () => {
    await h.connect('A');
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: hmac(USERS.alice.id) } });
    await h.rawHttp('GET * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await h.rawHttp('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await h.get('/health', { desc: 'HTTP GET /health after the malformed request' });
    await h.cmd('alice', 'G1#general', 'status');
  });

  // ═════════════════════════ p6: Discord API failures ═════════════════════
  // The interaction token is already expired (bot too slow, Discord hiccup):
  // every interaction callback fails with 10062 Unknown interaction.
  const dataExpired = path.join(h.workDir, 'data-expired');
  await h.runProcess('p6', { dataDir: dataExpired, epoch: p2Epoch + 14_400_000, env: { LINK_SECRET }, title: 'interaction callbacks rejected by Discord' }, async () => {
    await h.connect('A');
    await h.wsSend('A', { type: 'register', identity: { userId: USERS.alice.id, username: 'alice', scope: 'guild', guildIds: [G1], token: hmac(USERS.alice.id) } });
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { expired: true });
    await h.cmd('frank', 'G1#general', 'drop', { target: U('alice'), media: GIF }, { desc: '/drop right after the expired one — by frank' });
    await h.cmd('carol', 'G1#general', 'who', {}, { expired: true });
    const B = await h.connect('B');
    await h.cmd('bob', 'G1#general', 'link', { code: B.code }, { expired: true });
    await h.cmd('bob', 'G1#general', 'status', {}, { desc: '/status after the expired /link — by bob' });
    await h.cmd('alice', 'G1#general', 'status', {}, { expired: true });
    await h.cmd('alice', 'G1#general', 'status', {}, { desc: '/status after the expired /status — by alice' });
  });
};
