#!/usr/bin/env node
'use strict';
// Extra scenario for the G1 bot changes, built on the bot harness library
// (driver + normalize), with assertions instead of a baseline.
//
//   node extra-scenario.js <bot-dir> <out.json>
//
// m1: multi-device linking (PC + phone of the same user), races around the
//     register snapshot await, unlink paths, one socket switching identity.
// m2: decisions the main scenario does not exercise: delayed-drop cap,
//     /dropgroup same-tick race, /link lock + unlock, global TTS budget,
//     TTS warm-up key + in-flight join, snowflake validation, per-socket
//     message budget, GuildUpdate filter, store write throttle.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const HARNESS = '/tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/bot-harness';
const { Harness, U, ATT, EPOCH, LINK_SECRET, WORLD, sleep, abbrev } = require(path.join(HARNESS, 'lib/driver'));
const { normalize } = require(path.join(HARNESS, 'lib/normalize'));

const { USERS, GUILDS, UNKNOWN_GUILD_ID } = WORLD;
const G1 = GUILDS.G1.id;
const G2 = GUILDS.G2.id;
const hmac = (id) => crypto.createHmac('sha256', LINK_SECRET).update(String(id)).digest('hex');

let attSeq = 0;
function att(name, contentType, size, extra = {}) {
  const id = String(700000000000000000n + BigInt(++attSeq));
  return ATT({ id, url: `https://cdn.discordapp.com/attachments/310000000000000001/${id}/${name}`, name, contentType, size, ...extra });
}
const IMG = att('cat.png', 'image/png', 48213, { width: 640, height: 480 });

const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: Boolean(cond), detail: cond ? undefined : detail });
}

async function main() {
  const [botDir, outPath] = process.argv.slice(2);
  if (!botDir || !outPath) { console.error('usage: node extra-scenario.js <bot-dir> <out.json>'); process.exit(2); }
  const h = new Harness({ botDir, outPath, keep: false });
  await h.init();

  const got = (name) => h.cur.ev[`ws.${name}`] || [];
  const types = (name) => got(name).map((m) => m.type || (m._closed !== undefined ? `closed:${m._closed}` : '?'));
  const reply = (actor) => {
    const calls = h.cur.ev.ix?.[actor] || [];
    const last = [...calls].reverse().find((c) => c.content !== undefined);
    return last ? last.content : null;
  };
  const cmd = async (actor, where, name, opts = {}, extra = {}) => {
    await h.cmd(actor, where, name, opts, extra);
    return reply(actor);
  };
  // Dispatch an interaction inside the current step, without settling.
  const dispatch = async (actor, where, name, opts = {}, extra = {}) => {
    const { spec, label } = h.buildSpec(actor, where, name, opts, extra);
    h.iidMap.set(spec.iid, { step: h.cur, label, calls: new Map() });
    await h.bot.request('interaction', { spec });
  };
  const reg = (userId, username, guildIds, blockedIds = [], scope = 'guild', token = hmac(userId)) =>
    ({ type: 'register', identity: { userId, username, scope, guildIds, token, blockedIds } });
  const unknownIds = (base) => Array.from({ length: 10 }, (_, i) => `${base}${String(i).padStart(2, '0')}`);

  try {
    // ═══════════════════════════ m1: multi-device ════════════════════════
    if (process.env.ONLY !== 'm2') await h.runProcess('m1', { dataDir: path.join(h.workDir, 'data-m1'), epoch: EPOCH, env: { LINK_SECRET }, title: 'multi-device' }, async () => {
      // PC links on G1, then the phone links on G2 while the PC is linked.
      const PC = await h.connect('PC');
      let r = await cmd('alice', 'G1#general', 'link', { code: PC.code });
      check('PC /link: linked + code', r && r.startsWith('✅ Linked on **Les Potes**') && types('PC').join() === 'linked,pairing_code', { r, pc: types('PC') });
      const PH = await h.connect('PH', { desc: 'phone PH connects' });
      r = await cmd('alice', 'G2#memes', 'link', { code: PH.code }, { desc: 'phone: /link @G2 while the PC is linked' });
      check('phone /link while PC linked: reply', r && r.startsWith('✅ Linked on **Gaming Squad**'), r);
      check('phone /link: no unlinked anywhere', !types('PC').includes('unlinked') && !types('PH').includes('unlinked'), { pc: types('PC'), ph: types('PH') });
      check('phone gets linked with G1+G2', JSON.stringify(PH.last('linked')?.links?.guildIds) === JSON.stringify([G1, G2]), PH.last('linked')?.links);
      check('PC gets links_update with G1+G2', JSON.stringify(got('PC').find((m) => m.type === 'links_update')?.links?.guildIds) === JSON.stringify([G1, G2]), got('PC'));
      check('one shared extension code on both devices', PC.code && PC.code === PH.code, { pc: PC.code, ph: PH.code });
      check('phone: linked before pairing_code', types('PH').join() === 'linked,pairing_code', types('PH'));
      r = await cmd('alice', 'G1#general', 'status');
      check('/status counts 2 servers', r === '🟢 Linked on **Les Potes** (2 servers total).', r);

      // Drops reach both devices; reactions count once per user; stats once per user.
      r = await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG });
      const d1 = got('PC').find((m) => m.type === 'drop');
      check('drop reaches PC and phone (same dropId)', r === '✅ Drop envoyé sur **alice** !' && d1 && got('PH').find((m) => m.type === 'drop')?.dropId === d1.dropId, { r, pc: types('PC'), ph: types('PH') });
      await h.wsSend('PH', { type: 'react', dropId: d1.dropId, emoji: '😂' }, { desc: 'phone reacts' });
      check('reaction from the phone is posted', (h.cur.ev.chan || []).length === 1, h.cur.ev.chan);
      await h.wsSend('PC', { type: 'react', dropId: d1.dropId, emoji: '🔥' }, { desc: 'PC reacts to the same drop' });
      check('second device reaction ignored (one per user)', !(h.cur.ev.chan || []).length, h.cur.ev.chan);
      r = await cmd('carol', 'G1#general', 'dropall', { media: IMG });
      check('/dropall counts alice once, both devices get it', r === '💥 Drop envoyé à **1** personne : **alice**' && types('PC').includes('drop') && types('PH').includes('drop'), { r, pc: types('PC'), ph: types('PH') });
      r = await cmd('alice', 'G1#general', 'stats');
      check('/stats: alice received 2 (not 4)', r && r.includes('0 drop envoyé · 2 reçus'), r);

      // Shared extension code used from either device.
      const ext1 = PH.code;
      r = await cmd('alice', 'G1#general', 'link', { code: ext1 }, { desc: '/link with the shared extension code @G1' });
      check('shared ext code accepted, rotated on both', r === '✅ Added **Les Potes** to your linked sources (2 total).' && PC.code === PH.code && PC.code !== ext1, { r, pc: PC.code, ph: PH.code });

      // One device closing keeps the other linked.
      await h.wsClose('PC', 'PC disconnects');
      r = await cmd('alice', 'G1#general', 'status', {}, { desc: '/status after the PC closed' });
      check('phone still linked after PC closed', r === '🟢 Linked on **Les Potes** (2 servers total).', r);
      await h.advance(2000);
      r = await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: 'bob drops to alice (phone only)' });
      check('drop still delivered to the phone', r === '✅ Drop envoyé sur **alice** !' && types('PH').includes('drop'), { r, ph: types('PH') });
      r = await cmd('alice', 'G1#general', 'link', { code: PH.code }, { desc: '/link with the extension code after the PC closed' });
      check('extension code still valid with one device left', r === '✅ Added **Les Potes** to your linked sources (2 total).', r);

      // The PC comes back with a stale identity: it must get the live state.
      const PC2 = await h.connect('PC2', { desc: 'PC reconnects as PC2' });
      await h.wsSend('PC2', reg(USERS.alice.id, 'alice', [G1], [USERS.carol.id]), { desc: 'PC2 registers with a stale identity (G1 only, carol blocked)' });
      const l2 = PC2.last('linked')?.links;
      check('stale register gets the live lists (not merged)', l2 && JSON.stringify(l2.guildIds) === JSON.stringify([G1, G2]) && l2.blockedIds.length === 0, l2);
      check('stale register: phone only gets the rotated code', types('PH').join() === 'pairing_code' && PH.code === PC2.code, { ph: types('PH'), codes: [PH.code, PC2.code] });
      await h.advance(2000);
      r = await cmd('carol', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: 'carol drops to alice (stale identity had carol blocked)' });
      check('live blocklist wins: carol delivered to both', r === '✅ Drop envoyé sur **alice** !' && types('PH').includes('drop') && types('PC2').includes('drop'), { r });

      // Race A: two devices of frank register at the same instant; the
      // snapshot awaits 10 REST lookups of unknown blocked ids (~50 ms).
      const FA = await h.connect('FA');
      const FB = await h.connect('FB');
      const regF = reg(USERS.frank.id, 'frank', [G1], unknownIds('29999999999999900'));
      await h.step('race A: FA and FB register as frank at the same instant (slow snapshot)', async () => {
        FA.sendRaw(JSON.stringify(regF));
        FB.sendRaw(JSON.stringify(regF));
      });
      check('race A: both linked, nobody unlinked', types('FA').includes('linked') && types('FB').includes('linked') && !types('FA').includes('unlinked') && !types('FB').includes('unlinked'), { fa: types('FA'), fb: types('FB') });
      check('race A: same final code on both', FA.code && FA.code === FB.code, { fa: got('FA'), fb: got('FB') });
      const raceCodes = [...new Set([...got('FA'), ...got('FB')].filter((m) => m.type === 'pairing_code').map((m) => m.code))];
      r = await cmd('frank', 'G1#general', 'status');
      check('race A: frank linked', r === '🟢 Linked on **Les Potes** (1 server total).', r);
      await h.advance(2000);
      r = await cmd('dave', 'G1#general', 'drop', { target: U('frank'), media: IMG }, { desc: 'dave drops to frank (both devices)' });
      check('race A: drop reaches both of frank\'s devices', types('FA').includes('drop') && types('FB').includes('drop'), { r });
      const oldRaceCode = raceCodes.find((c) => c !== FA.code);
      if (oldRaceCode) {
        r = await cmd('frank', 'G1#general', 'link', { code: oldRaceCode }, { desc: 'frank /link with the superseded race code' });
        check('race A: superseded code rejected', r === '❌ Invalid or expired code. Check the code in your overlay app and try again.', r);
      }
      r = await cmd('frank', 'G1#general', 'link', { code: FA.code }, { desc: 'frank /link with the final shared code' });
      check('race A: final code valid', r === '✅ Added **Les Potes** to your linked sources (1 total).', r);

      // Race B: dave's register is awaiting its snapshot when /unlink lands.
      const DV = await h.connect('DV');
      await h.step('race B: DV registers as dave, /unlink by dave lands during the snapshot await', async () => {
        DV.sendRaw(JSON.stringify(reg(USERS.dave.id, 'dave', [G1], unknownIds('29999999999999910'))));
        await sleep(15);
        await dispatch('dave', 'G1#general', 'unlink');
      });
      check('race B: /unlink found the link', reply('dave') === '✅ Unlinked from every server. Your overlay shows a new pairing code.', reply('dave'));
      check('race B: unlinked + pairing code, no stale linked', types('DV').join() === 'unlinked,pairing_code', got('DV'));
      r = await cmd('dave', 'G1#general', 'status');
      check('race B: dave not linked', r === '🔴 No overlay linked. Launch the app and use `/link <code>`.', r);

      // /unlink with two devices: both unlinked, codes gone.
      const extBefore = PH.code;
      r = await cmd('alice', 'G1#general', 'unlink');
      check('/unlink: both devices unlinked + new pairing codes', types('PH').join() === 'unlinked,pairing_code' && types('PC2').join() === 'unlinked,pairing_code' && PH.code !== PC2.code, { ph: got('PH'), pc2: got('PC2') });
      r = await cmd('alice', 'G1#general', 'link', { code: extBefore }, { desc: '/link with the extension code shown before /unlink' });
      check('/unlink deleted the extension code', r === '❌ Invalid or expired code. Open the overlay (it shows a fresh code) and try again.', r);

      // unlink_guild emptying a shared link unlinks every device.
      await cmd('alice', 'G1#general', 'link', { code: PC2.code }, { desc: 're-link PC2 @G1' });
      r = await cmd('alice', 'G1#general', 'link', { code: PH.code }, { desc: 're-link phone @G1 (joins PC2)' });
      check('re-link phone joins PC2 (links_update to PC2)', types('PH').join() === 'linked,pairing_code' && types('PC2').join() === 'links_update,pairing_code', { ph: types('PH'), pc2: types('PC2') });
      await h.wsSend('PH', { type: 'unlink_guild', guildId: G1 }, { desc: 'phone unlinks the last guild' });
      check('unlink_guild → every device unlinked', got('PH')[0]?.reason === 'no_guilds_left' && got('PC2')[0]?.reason === 'no_guilds_left' && types('PC2').join() === 'unlinked,pairing_code', { ph: got('PH'), pc2: got('PC2') });

      // One socket switching identity releases the old one.
      const X = await h.connect('X');
      await cmd('bob', 'G1#general', 'link', { code: X.code }, { desc: 'bob links X' });
      await h.wsSend('X', reg(USERS.carol.id, 'carol', [G1]), { desc: 'X (bob) registers as carol' });
      check('X switches to carol', X.last('linked')?.user?.id === USERS.carol.id, X.last('linked'));
      r = await cmd('bob', 'G1#general', 'status');
      check('bob released by X', r === '🔴 No overlay linked. Launch the app and use `/link <code>`.', r);
      r = await cmd('carol', 'G1#general', 'status');
      check('carol linked through X', r === '🟢 Linked on **Les Potes** (1 server total).', r);
      await h.advance(2000);
      r = await cmd('dave', 'G1#general', 'drop', { target: U('bob'), media: IMG }, { desc: 'dave drops to bob (X now carol)' });
      check('no drop to bob through X', r === '❌ Personne n\'est atteignable depuis ce serveur. Ils doivent faire `/link` ici aussi.' && !types('X').includes('drop'), { r, x: types('X') });

      // GuildUpdate: icon-only change pushes, other changes do not.
      const Y = await h.connect('Y');
      await h.wsSend('Y', reg(USERS.erin.id, 'erin', [G1]), { desc: 'Y registers as erin (G1)' });
      await h.world('guildUpdate', [G1, { icon: '1c0n0000000000000000000000000077' }], 'world: G1 icon changes');
      check('GuildUpdate icon change → links_update', types('Y').join() === 'links_update', got('Y'));
      await h.world('guildUpdate', [G1, { description: 'new description' }], 'world: G1 description changes');
      check('GuildUpdate other change → nothing', got('Y').length === 0, got('Y'));
    });

    // ════════════════ m2: limits, races, TTS, validation, store ══════════
    const dataM2 = path.join(h.workDir, 'data-m2');
    fs.mkdirSync(dataM2, { recursive: true });
    fs.writeFileSync(path.join(dataM2, 'store.json'), JSON.stringify({
      groups: { [USERS.carol.id]: { duo: [USERS.alice.id, USERS.bob.id] } },
    }));
    await h.runProcess('m2', { dataDir: dataM2, epoch: EPOCH + 86_400_000, env: { LINK_SECRET }, title: 'limits and races' }, async (bot) => {
      const AL = await h.connect('AL');
      await h.wsSend('AL', reg(USERS.alice.id, 'alice', [G1]));
      const BO = await h.connect('BO');
      await h.wsSend('BO', reg(USERS.bob.id, 'bob', [G1]));

      // /dropgroup same-tick race (group loaded from disk: members not cached,
      // so users.fetch goes to REST and the window is real).
      await h.cmdBurst('/dropgroup duo twice in the same instant — by carol', [
        ['carol', 'G1#general', 'dropgroup', { name: 'duo', media: IMG }],
        ['carol', 'G1#general', 'dropgroup', { name: 'duo', media: IMG }],
      ]);
      const ix = h.cur.ev.ix || {};
      const finals = ['#1 carol', '#2 carol'].map((k) => [...(ix[k] || [])].reverse().find((c) => c.content)?.content);
      check('/dropgroup race: one sent, one cooldown', finals.filter((c) => c && c.startsWith('✅ Drop envoyé')).length === 1 && finals.filter((c) => c && c.startsWith('⏱️ Doucement')).length === 1, finals);
      check('/dropgroup race: one drop per overlay', types('AL').filter((t) => t === 'drop').length === 1 && types('BO').filter((t) => t === 'drop').length === 1, { al: types('AL'), bo: types('BO') });

      // Delayed-drop cap (3 pending per sender), checked before the cooldown.
      const delayed = [];
      for (const n of [1, 2, 3]) {
        await h.advance(2000);
        delayed.push(await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG, delai: n }));
      }
      check('3 delayed drops accepted', delayed.every((c) => c && c.startsWith('⏳ Drop programmé')), delayed);
      await h.advance(2000);
      let r = await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG, delai: 4 }, { desc: '4th delayed drop' });
      check('4th delayed drop refused', r === '⏳ Tu as déjà 3 drops programmés — attends qu\'ils partent.', r);
      r = await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG }, { desc: 'immediate /drop right after the refusal' });
      check('refusal did not consume the cooldown', r === '✅ Drop envoyé sur **alice** !', r);
      await h.advance(60_000, 'advance 60 s (first delayed drop fires)');
      check('first delayed drop fired', types('AL').includes('drop'), types('AL'));
      r = await cmd('bob', 'G1#general', 'drop', { target: U('alice'), media: IMG, delai: 5 }, { desc: 'new delayed drop once one has fired' });
      check('slot freed after firing', r && r.startsWith('⏳ Drop programmé dans **5 min**'), r);

      // /link lock: 5 failures in 10 min, then unlock.
      const FR = await h.connect('FR');
      for (let i = 0; i < 5; i++) await cmd('frank', 'G1#general', 'link', { code: 'ZZZZZ' + i }, { desc: `frank invalid /link #${i + 1}` });
      r = await cmd('frank', 'G1#general', 'link', { code: FR.code }, { desc: 'frank valid code after 5 failures' });
      check('6th /link refused while locked', r === '⏱️ Trop de codes invalides — réessaie dans quelques minutes.' && !types('FR').includes('linked'), r);
      r = await cmd('bob', 'G1#general', 'link', { code: 'ZZZZZZ' }, { desc: 'another user is not locked' });
      check('lock is per user', r && r.startsWith('❌ Invalid or expired code'), r);
      await h.advance(600_000, 'advance 10 min (lock window over)');
      r = await cmd('frank', 'G1#general', 'link', { code: FR.code }, { desc: 'frank valid code after the window' });
      check('unlocked after 10 min', r && r.startsWith('✅ Linked on **Les Potes**'), r);

      // TTS warm-up key: tts whose 200-unit cut ends with a space.
      await h.advance(2000);
      const ttsOpt = `${'a'.repeat(199)} bcd`;
      r = await cmd('carol', 'G1#general', 'drop', { target: U('alice'), tts: ttsOpt }, { desc: 'drop with tts cut right after a space' });
      const warm = h.cur.ev.upstream || [];
      const ttsUrl = got('AL').find((m) => m.type === 'drop')?.ttsUrl;
      check('warm-up fetched the trimmed text', warm.length === 1 && warm[0].q === abbrev('a'.repeat(199)), warm);
      await h.get(new URL(ttsUrl).pathname + new URL(ttsUrl).search, { desc: 'overlay fetches the drop ttsUrl' });
      check('ttsUrl served from the warmed cache', h.cur.ev.http?.[0]?.status === 200 && !(h.cur.ev.upstream || []).length, { http: h.cur.ev.http, up: h.cur.ev.upstream });

      // In-flight join: the overlay asks while the warm-up is still running.
      await h.setUpstreamLatency(300);
      await h.advance(2000);
      await h.step('drop with tts, overlay fetches ttsUrl while the warm-up is in flight', async () => {
        await dispatch('carol', 'G1#general', 'drop', { target: U('alice'), tts: 'en vol' });
        await sleep(80);
        const rec = await h.httpRequest('GET', `/tts?text=${encodeURIComponent('en vol')}`, { 'x-forwarded-for': '192.0.2.200' });
        h.record('http', rec);
      });
      check('in-flight join: one upstream call, 200', (h.cur.ev.upstream || []).length === 1 && h.cur.ev.http?.[0]?.status === 200, { up: h.cur.ev.upstream, http: h.cur.ev.http });
      await h.setUpstreamLatency(10);

      // Global upstream budget: 150 distinct texts from 5 IPs (30 each).
      await h.advance(61_000, 'advance 61 s (fresh TTS windows)');
      const reqs = Array.from({ length: 150 }, (_, i) => ({ path: `/tts?text=budget-${i}`, headers: { 'x-forwarded-for': `198.18.0.${1 + Math.floor(i / 30)}` } }));
      const recs = await h.httpSeries('150 distinct uncached /tts from 5 IPs', reqs);
      const st = recs.map((x) => x.status);
      check('budget: 120 × 200 then 503 tts busy', st.slice(0, 120).every((s) => s === 200) && st.slice(120).every((s) => s === 503) && recs[149].body === 'tts busy', { counts: st.reduce((o, s) => ((o[s] = (o[s] || 0) + 1), o), {}) });
      check('budget: 120 upstream calls', (h.cur.ev.upstream || []).length === 120, (h.cur.ev.upstream || []).length);
      await h.advance(60_001, 'advance 60.001 s (budget window over)');
      await h.get('/tts?text=after-budget', { headers: { 'x-forwarded-for': '198.18.0.9' } });
      check('budget resets after the window', h.cur.ev.http?.[0]?.status === 200, h.cur.ev.http);

      // Validation without String(): never crashes, invalid ids rejected.
      const V = await h.connect('V');
      if (process.env.SKIP_CRASH !== '1') {
      await h.wsSend('V', '{"type":"register","identity":{"userId":{"toString":1}}}', { desc: 'register with an object userId' });
      check('object userId → register_failed', types('V').join() === 'register_failed', got('V'));
      await h.wsSend('V', reg(12345, 'n', [G1]), { desc: 'register with a numeric userId' });
      check('numeric userId → register_failed', types('V').join() === 'register_failed', got('V'));
      await h.wsSend('V', reg(USERS.dave.id, 'dave', ['abc', 42, { x: 1 }]), { desc: 'register with only invalid guild ids' });
      check('invalid guild ids → register_failed', types('V').join() === 'register_failed', got('V'));
      await h.wsSend('V', { type: 'register', identity: { userId: USERS.dave.id, username: { toString: 1 }, scope: 'guild', guildIds: [G1], token: hmac(USERS.dave.id), blockedIds: ['../channels/1', USERS.bob.id] } }, { desc: 'register: object username, path-like blocked id' });
      const lv = V.last('linked');
      check('object username → unknown; non-snowflake blocked id dropped', lv?.user?.username === 'unknown' && JSON.stringify(lv?.links?.blockedIds) === JSON.stringify([USERS.bob.id]), lv);
      await h.wsSend('V', '{"type":"react","dropId":{"toString":1},"emoji":{"toString":1}}', { desc: 'react with object fields' });
      await h.wsSend('V', '{"type":"unlink_guild","guildId":{"toString":1}}', { desc: 'unlink_guild with an object id' });
      await h.get('/health', { desc: 'bot still alive' });
      check('still alive after malformed fields', h.cur.ev.http?.[0]?.status === 200, h.cur.ev.http);
      }

      // Per-socket budget: 30 messages / 10 s.
      await h.advance(10_001, 'advance 10 s (fresh message window)');
      await h.step('AL sends 35 unblock_user at once', async () => {
        for (let i = 0; i < 35; i++) AL.sendRaw(JSON.stringify({ type: 'unblock_user', userId: USERS.carol.id }));
      });
      const n = types('AL').filter((t) => t === 'links_update').length;
      check('per-socket budget caps processing (≤ 30 of 35)', n >= 29 && n <= 30, n);
      await h.advance(10_001, 'advance 10 s (window over)');
      await h.wsSend('AL', { type: 'unblock_user', userId: USERS.carol.id }, { desc: 'one more message after the window' });
      check('budget resets after 10 s', types('AL').filter((t) => t === 'links_update').length === 1, types('AL'));

      // Store write at most 500 ms after the FIRST change (real time).
      await h.step('fav add at +0, +350, +700 ms (real), store read at +900 ms', async () => {
        await dispatch('dave', 'G1#general', 'fav', { name: 'x1', media: IMG }, { sub: 'add' });
        await sleep(350);
        await dispatch('dave', 'G1#general', 'fav', { name: 'x2', media: IMG }, { sub: 'add' });
        await sleep(350);
        await dispatch('dave', 'G1#general', 'fav', { name: 'x3', media: IMG }, { sub: 'add' });
        await sleep(200);
        h.record('store', h.readStore(dataM2));
      });
      const favs = (h.cur.ev.store?.[0]?.json?.favorites?.[USERS.dave.id] || []).map((f) => f.name);
      check('throttled write: x1,x2 written while saves keep coming', JSON.stringify(favs) === JSON.stringify(['x1', 'x2']), favs);
      await h.realWait(700, 'wait 700 ms');
      await h.snapshotStore('store after the second write');
      const favs2 = (h.cur.ev.store?.[0]?.json?.favorites?.[USERS.dave.id] || []).map((f) => f.name);
      check('second write has x3', JSON.stringify(favs2) === JSON.stringify(['x1', 'x2', 'x3']), favs2);
      void bot;
    });
  } catch (e) {
    check('scenario ran to completion', false, e.stack || e.message);
  }

  const knownTokens = new Map();
  for (const [name, u] of Object.entries(WORLD.USERS)) knownTokens.set(hmac(u.id), `<TOKEN hmac(${name})>`);
  const steps = normalize(h.finalizeSteps(), { codes: h.norm.codes, dropIds: h.norm.dropIds, tokens: h.norm.tokens, knownTokens, fixed: h.norm.fixed, epoch: EPOCH });
  fs.writeFileSync(outPath, `${JSON.stringify({ steps, results, processes: h.processes }, null, 2)}\n`);
  h.cleanup();
  let fails = 0;
  for (const res of results) {
    if (!res.ok) fails++;
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${res.label}${res.ok ? '' : `\n      ${JSON.stringify(res.detail).slice(0, 600)}`}`);
  }
  const exits = Object.entries(h.processes).map(([k, v]) => `${k}=${JSON.stringify(v.exit)}`).join(' ');
  console.log(`\n${results.length - fails}/${results.length} checks passed; process exits: ${exits}; transcript: ${outPath}`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
