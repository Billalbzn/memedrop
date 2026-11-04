'use strict';
// Scenarios. Each one runs in its own process against a fresh userData dir
// and a fresh fake bot. Steps are driven only through observable surfaces:
// the fake bot's WebSocket frames, the renderer API exposed by preload.js
// (window.memedrop.*), tray menu clicks, OS-level events (screen, shortcuts,
// app events) and virtual time.
//
// `metric` tags mark the steps used for the disk-access summary.

const T = require('./harness');

const SEC = 1000;
const MIN = 60 * SEC;

// identity as the overlay stores it after a /link (token = fake bot's tokenFor)
const IDENTITY = { userId: 'u1', username: 'alice', scope: 'guild', guildIds: ['g100', 'g200'], token: 'tok-u1', blockedIds: ['u900'] };

async function bootLinked(h, extra = {}) {
  await h.boot({ store: { linkIdentity: IDENTITY, ...(extra.store || {}) }, ...extra.boot });
}

const scenarios = [];
const S = (name, desc, run, opts = {}) => scenarios.push({ name, desc, run, edge: !!opts.edge });
// Edge-case scenarios feed inputs the shipped renderers / bot never send
// (malformed frames, arbitrary settings keys, corrupt config...). A
// difference there is still a behaviour change, but compare.js labels it
// [edge] so it can be accepted consciously.
const EDGE = { edge: true };

// ───────────────────────────────────────────────────────────── boot
S('boot-fresh', 'First launch (no config): windows, tray, login item, shortcuts, connection to DEFAULT_SERVER, pairing code, renderer init calls', async (h) => {
  await h.boot();
  await h.invoke('settings', 'getConnection');
  await h.invoke('overlay', 'getSettings');
});

S('boot-hidden', 'Autostart launch with --hidden: overlay + tray only, no settings window', async (h) => {
  await h.boot({ hidden: true });
  await h.invoke('overlay', 'getSettings');
  await h.botSend({ type: 'pairing_code', code: '555555' });
});

S('boot-existing-identity', 'Launch with a stored identity and custom settings: auto re-register, linked state, persisted settings', async (h) => {
  await h.boot({
    store: {
      linkIdentity: IDENTITY, volume: 0.3, musicVolume: 0.2, opacity: 0.9, duration: 7, videoDuration: 12,
      soundOnArrival: false, spotlightOnDrop: false, autostart: false, theme: 'neon', avoidZone: 'bottom',
      quietHours: { enabled: false, start: '23:00', end: '07:00' },
    },
  });
  await h.invoke('settings', 'getConnection');
  await h.botSend(h.bot.drop({ caption: 'hello' }));
});

S('boot-legacy-railway', 'Stored Railway serverUrl is migrated to DEFAULT_SERVER at startup', async (h) => {
  await h.boot({ store: { serverUrl: 'wss://memedrop-production.up.railway.app', volume: 0.5 } });
  await h.invoke('settings', 'getSettings');
});

S('boot-partial-store', 'Config file missing keys plus an unknown key: defaults merged once', async (h) => {
  await h.boot({ store: { volume: 0.6, customKey: 'kept', quietHours: { enabled: true, start: '01:00', end: '02:00' } } });
  await h.invoke('settings', 'getSettings');
});

S('boot-corrupt-store', 'Corrupt config.json (conf clearInvalidConfig=false): startup throws', async (h) => {
  await h.boot({ storeRaw: '{"volume": 0.5,' });
}, EDGE);

S('boot-paused', 'Launch with paused=true: no connection attempt, paused state', async (h) => {
  await h.boot({ store: { paused: true } });
  await h.invoke('settings', 'getConnection');
  await h.advance(2 * MIN);
});

S('drop-before-overlay-ready', 'A friend drops right after the automatic re-link at launch, before the overlay page has loaded', async (h) => {
  h.bot.onRegistered = (conn) => { h.bot.onRegistered = null; h.bot.sendTo(conn, h.bot.drop({ caption: 'welcome back' })); };
  await h.boot({ hidden: true, store: { linkIdentity: IDENTITY } });
  await h.invoke('overlay', 'getSettings');
  await h.trayEvent('click');
  await h.invoke('settings', 'getHistory');
});

S('second-instance-denied', 'Single-instance lock refused: the second process quits at once', async (h) => {
  await h.boot({ lock: false });
});

S('second-instance-event', 'Hidden instance receives second-instance: settings window created, then re-shown', async (h) => {
  await h.boot({ hidden: true });
  await h.appEvent('second-instance', ['MemeDrop.exe'], 'C:\\');
  await h.userClosesWindow('settings');
  await h.appEvent('second-instance', ['MemeDrop.exe'], 'C:\\');
});

// ───────────────────────────────────────────────────────────── pairing / link
S('pairing-link-flow', 'pairing_code -> awaiting_link, /link -> linked + identity saved, extension code, links_update', async (h) => {
  await h.boot();
  await h.botSend({ type: 'pairing_code', code: '424242' });
  await h.botLink({ userId: 'u1', username: 'alice', guildIds: ['g100'] });
  await h.invoke('settings', 'getConnection');
  await h.botSend({ type: 'pairing_code', code: '777777' }, { label: 'bot→ pairing_code while linked (extension)' });
  await h.botSend({ type: 'links_update', links: h.bot.links({ scope: 'guild', guildIds: ['g100', 'g200'], blockedIds: ['u900'] }) });
  await h.botSend({ type: 'links_update', links: { scope: 'global', guilds: [], guildIds: [], blocked: [], blockedIds: [] } }, { label: 'bot→ links_update (global)' });
  await h.botSend({ type: 'links_update' }, { label: 'bot→ links_update without links' });
  await h.invoke('settings', 'getConnection');
});

S('register-failed', 'Stored identity with a bad token: silent re-register fails, identity cleared, back to pairing, then fresh /link', async (h) => {
  await h.boot({ store: { linkIdentity: { ...IDENTITY, token: 'stale-token' } } });
  await h.invoke('settings', 'getConnection');
  await h.botLink({ userId: 'u1', username: 'alice', guildIds: ['g100'] });
  await h.invoke('settings', 'getConnection');
});

S('register-failed-direct', 'register_failed received while connected and awaiting (no stored code)', async (h) => {
  h.bot.auto.pairing = false;
  await h.boot();
  await h.botSend({ type: 'register_failed' });
}, EDGE);

S('linked-without-token', 'linked message without token/links: identity stored with token null and default links', async (h) => {
  await h.boot();
  await h.botSend({ type: 'linked', user: { id: 'u7', username: 'zoe' } }, { label: 'bot→ linked (no token, no links)' });
  await h.botSend({ type: 'linked', user: null, links: { scope: 'guild', guilds: [], guildIds: ['g1'], blocked: [], blockedIds: [] } }, { label: 'bot→ linked (no user)' });
  await h.invoke('settings', 'getConnection');
}, EDGE);

S('unlinked', 'Bot sends unlinked: identity cleared, state connecting, then a new pairing code', async (h) => {
  await bootLinked(h);
  await h.botSend({ type: 'unlinked', reason: 'user' });
  await h.botSend({ type: 'pairing_code', code: '313131' });
  await h.invoke('settings', 'getConnection');
});

// ───────────────────────────────────────────────────────────── drops
S('drops', 'Drops of every kind: overlay receives drop+settings, history updated, history cap', async (h) => {
  await bootLinked(h);
  await h.botSend(h.bot.drop({ caption: 'image drop' }), { label: 'bot→ drop image', metric: 'drop' });
  await h.botSend(h.bot.drop({ caption: 'image drop 2' }), { label: 'bot→ drop image 2', metric: 'drop' });
  await h.botSend(h.bot.drop({
    media: { url: 'https://cdn.discordapp.com/attachments/1/v/clip.mp4', kind: 'video', mime: 'video/mp4', name: 'clip.mp4', size: 4000000, width: 1280, height: 720 },
    music: { url: 'https://cdn.discordapp.com/attachments/1/m/song.mp3', mime: 'audio/mpeg', name: 'song.mp3', size: 300000 },
    effect: 'tornade', caption: null,
  }), { label: 'bot→ drop video+music+effect', metric: 'drop' });
  await h.botSend(h.bot.drop({ media: null, tts: 'bonjour à toi', ttsUrl: 'https://memedrop-bot.fly.dev/tts?text=bonjour', caption: null }), { label: 'bot→ drop tts' });
  await h.botSend(h.bot.drop({ media: null, rain: ['🔥', '😂'], caption: 'pluie' }), { label: 'bot→ drop rain' });
  await h.botSend({ type: 'drop' }, { label: 'bot→ drop with no fields' });
  await h.botSend(h.bot.drop({ from: { id: 'u3' }, ts: undefined, music: { url: 'https://cdn.discordapp.com/x.mp3', mime: 'audio/mpeg' }, media: null, caption: '' }), { label: 'bot→ drop music-only, no username, no ts' });
  await h.invoke('settings', 'getHistory', { $meta: { metric: 'history:get' } });
  await h.step('bot→ 16 drops in a burst', () => { for (let i = 0; i < 16; i++) h.bot.sendTo(null, h.bot.drop({ caption: `burst ${i}` })); });
  await h.invoke('settings', 'getHistory');
});

S('mute-manual', 'Quiet mode via mute:set and tray: drops recorded but not shown, expiry, tray/tooltip updates', async (h) => {
  await bootLinked(h);
  await h.invoke('settings', 'setMute', 30, { $meta: { metric: 'mute:set' } });
  await h.invoke('settings', 'getMute');
  await h.botSend(h.bot.drop({ caption: 'muted drop' }), { label: 'bot→ drop while muted', metric: 'drop-muted' });
  await h.advance(29 * MIN, 'advance 29 min (still muted)');
  await h.invoke('settings', 'getConnection');
  await h.advance(2 * MIN, 'advance 2 min (mute expires)');
  await h.invoke('settings', 'getMute');
  await h.botSend(h.bot.drop({ caption: 'after expiry' }), { label: 'bot→ drop after expiry' });
  await h.trayClick('🔇 Mode tranquille — 2 h');
  await h.botSend(h.bot.drop({ caption: 'muted by tray' }), { label: 'bot→ drop while muted (tray 2 h)' });
  await h.trayClick('🔊 Réactiver les drops');
  await h.invoke('settings', 'setMute', -1);
  await h.botSend(h.bot.drop({ caption: 'muted forever' }), { label: 'bot→ drop while muted forever' });
  await h.advance(5 * MIN);
  await h.invoke('settings', 'setMute', null);
  await h.invoke('settings', 'setMute', 0);
  await h.botSend(h.bot.drop({ caption: 'unmuted' }), { label: 'bot→ drop unmuted' });
  await h.trayClick('🔇 Mode tranquille — jusqu\'à réactivation');
  await h.trayClick('🔊 Réactiver les drops');
  await h.advance(10 * SEC, 'advance 10 s (off the 30 s refresh grid)');
  await h.trayClick('🔇 Mode tranquille — 30 min');
  await h.botSend(h.bot.drop({ caption: 'muted by tray 30 min' }), { label: 'bot→ drop while muted (tray 30 min)' });
  await h.advance(30 * MIN + 5 * SEC, 'advance 30 min 5 s (expired, before the next refresh tick)');
  await h.botSend(h.bot.drop({ caption: 'expired before refresh tick' }), { label: 'bot→ drop after expiry, before refresh tick' });
  await h.invoke('settings', 'getConnection');
  await h.advance(15 * SEC, 'advance 15 s (refresh tick)');
  await h.invoke('settings', 'getConnection');
});

S('quiet-hours', 'Quiet hours: active window hides drops, tray badge/tooltip, cross-midnight window, expiry by time', async (h) => {
  await bootLinked(h);
  await h.invoke('settings', 'setSettings', { quietHours: { enabled: true, start: '11:30', end: '12:30' } });
  await h.invoke('settings', 'isQuietHoursActive');
  await h.botSend(h.bot.drop({ caption: 'during quiet hours' }), { label: 'bot→ drop during quiet hours' });
  await h.advance(30 * MIN - 1 * SEC, 'advance to 12:29:59');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(1 * SEC, 'advance to 12:30:00 (end boundary, refresh tick)');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(1 * MIN, 'advance to 12:31');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.botSend(h.bot.drop({ caption: 'after quiet hours' }), { label: 'bot→ drop after quiet hours' });
  await h.invoke('settings', 'setSettings', { quietHours: { enabled: true, start: '12:45', end: '12:40' } });
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(9 * MIN, 'advance to 12:40 (end boundary of the cross-midnight window)');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(4 * MIN + 59 * SEC, 'advance to 12:44:59');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(1 * SEC, 'advance to 12:45:00 (start boundary)');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.advance(1 * MIN, 'advance to 12:46');
  await h.invoke('settings', 'isQuietHoursActive');
  await h.invoke('settings', 'setMute', 30);
  await h.invoke('settings', 'setSettings', { quietHours: { enabled: true, start: '10:00', end: '10:00' } });
  await h.invoke('settings', 'isQuietHoursActive');
  await h.invoke('settings', 'setSettings', { quietHours: { enabled: true, start: '7h', end: '25:99' } });
  await h.invoke('settings', 'isQuietHoursActive');
  await h.invoke('settings', 'setSettings', { quietHours: { enabled: false, start: '00:00', end: '23:59' } });
  await h.invoke('settings', 'isQuietHoursActive');
});

// ───────────────────────────────────────────────────────────── settings
S('settings-roundtrip', 'settings:get / settings:set of each key, live patch to the overlay, drop carries the new settings, autostart', async (h) => {
  await bootLinked(h);
  await h.invoke('settings', 'getSettings', { $meta: { metric: 'settings:get' } });
  await h.invoke('settings', 'setSettings', { volume: 0.4 }, { $meta: { metric: 'settings:set-1key' } });
  await h.invoke('settings', 'setSettings', { musicVolume: 0.1, opacity: 0.8, duration: 9, videoDuration: 25, spotlightOnDrop: false, theme: 'fire' }, { $meta: { metric: 'settings:set-6keys' } });
  await h.invoke('settings', 'setSettings', { soundOnArrival: false, avoidZone: 'center' });
  await h.invoke('settings', 'setSettings', { theme: 'mono' });
  await h.invoke('settings', 'setSettings', { autostart: false });
  await h.invoke('settings', 'setSettings', { autostart: true });
  await h.invoke('settings', 'getSettings');
  await h.invoke('overlay', 'getSettings');
  await h.botSend(h.bot.drop({ caption: 'with new settings' }), { label: 'bot→ drop after settings change' });
  await h.invoke('settings', 'getVersion');
  await h.invoke('settings', 'listDisplays');
});

S('settings-server-url', 'serverUrl validation, reconnect to a new URL, unreachable URL, URL that passes validation but cannot be parsed', async (h) => {
  await bootLinked(h);
  for (const bad of ['http://example.com', 'ftp://x', 'ws://has space', '', 'wss://']) {
    await h.invoke('settings', 'setSettings', { serverUrl: bad, volume: 0.5 });
  }
  await h.invoke('settings', 'getSettings');
  await h.invoke('settings', 'setSettings', { serverUrl: `${h.bot.url}/alt` });
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { serverUrl: 'wss://bot.example.invalid' });
  await h.advance(10 * SEC);
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { serverUrl: 'wss://memedrop-bot.fly.dev:99999' });
  await h.invoke('settings', 'getConnection');
  await h.advance(60 * SEC, 'advance 60 s (unparseable URL: retries, status stays connecting)');
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { serverUrl: h.bot.url });
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { serverUrl: h.bot.url }, { $meta: { metric: 'settings:set-same-serverUrl' } });
});

S('settings-paused', 'paused true/false: clean disconnect, no reconnect while paused, reconnect + re-register on resume', async (h) => {
  await bootLinked(h);
  await h.invoke('settings', 'setSettings', { paused: true });
  await h.advance(2 * MIN);
  await h.invoke('settings', 'reconnect');
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { paused: false });
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'setSettings', { paused: false }, { $meta: { metric: 'settings:set-paused-noop' } });
});

S('settings-unusual', 'Unusual settings:set payloads (non-object, arrays, unknown keys, dotted keys, undefined values, overwriting internal keys)', async (h) => {
  await bootLinked(h);
  await h.invoke('settings', 'setSettings', null);
  await h.invoke('settings', 'setSettings', 'volume');
  await h.invoke('settings', 'setSettings', []);
  await h.invoke('settings', 'setSettings', { foo: 'bar' });
  await h.invoke('settings', 'setSettings', { 'quietHours.enabled': true });
  await h.invoke('settings', 'setSettings', { volume: 0.2, opacity: undefined, theme: 'neon' });
  await h.invoke('settings', 'getSettings');
  await h.invoke('settings', 'setSettings', { muteUntil: -1 });
  await h.invoke('settings', 'getMute');
  await h.botSend(h.bot.drop({ caption: 'muteUntil set via settings' }), { label: 'bot→ drop after muteUntil via settings:set' });
  await h.invoke('settings', 'setSettings', { muteUntil: null, linkIdentity: null });
  await h.invoke('settings', 'setSettings', { dropHistory: null });
  await h.botSend(h.bot.drop({ caption: 'history is null' }), { label: 'bot→ drop with dropHistory=null' });
  await h.invoke('settings', 'getHistory');
  await h.invoke('settings', 'replayDrop', 123);
}, EDGE);

S('display-select', 'Overlay display selection, displays:list, display removal/metrics change fallback', async (h) => {
  await bootLinked(h, { boot: { hidden: true } });
  await h.trayEvent('click');
  await h.invoke('settings', 'listDisplays');
  await h.invoke('settings', 'setSettings', { overlayDisplayId: 2779098405 });
  await h.invoke('settings', 'setSettings', { overlayDisplayId: 12345 });
  await h.invoke('settings', 'setSettings', { overlayDisplayId: 2779098405 });
  const { DEFAULT_DISPLAYS } = require('./electron');
  await h.displaysChange([DEFAULT_DISPLAYS[0]], 'display-removed', 'screen: second display unplugged');
  await h.displaysChange([DEFAULT_DISPLAYS[0], DEFAULT_DISPLAYS[1]], 'display-added', 'screen: second display plugged back');
  const resized = [{ ...DEFAULT_DISPLAYS[0] }, { ...DEFAULT_DISPLAYS[1], bounds: { x: 1920, y: 0, width: 3840, height: 2160 }, workArea: { x: 1920, y: 0, width: 3840, height: 2120 } }];
  await h.displaysChange(resized, 'display-metrics-changed', 'screen: second display resolution change');
  await h.invoke('settings', 'setSettings', { overlayDisplayId: null });
  await h.invoke('settings', 'listDisplays');
});

// ───────────────────────────────────────────────────────────── history / react / links
S('history-replay', 'history:get / history:replay (by ts, missing, music-only) / history:clear', async (h) => {
  await bootLinked(h);
  await h.botSend(h.bot.drop({ caption: 'replay me', effect: 'zoom' }), { label: 'bot→ drop image (replayable)' });
  const tImage = h.clock.now;
  await h.advance(5 * SEC);
  await h.botSend(h.bot.drop({ media: null, music: { url: 'https://cdn.discordapp.com/only.mp3', mime: 'audio/mpeg' }, caption: 'music only' }), { label: 'bot→ drop music-only' });
  const tMusic = h.clock.now;
  await h.advance(5 * SEC);
  await h.botSend(h.bot.drop({ media: null, tts: 'coucou', ttsUrl: 'https://memedrop-bot.fly.dev/tts?text=coucou', caption: null }), { label: 'bot→ drop tts' });
  const tTts = h.clock.now;
  await h.invoke('settings', 'getHistory');
  await h.advance(1 * MIN);
  await h.invoke('settings', 'replayDrop', tImage);
  await h.invoke('settings', 'replayDrop', tTts);
  await h.invoke('settings', 'replayDrop', tMusic);
  await h.invoke('settings', 'replayDrop', 42);
  await h.invoke('settings', 'replayDrop');
  await h.invoke('settings', 'setMute', -1);
  await h.invoke('settings', 'replayDrop', tImage, { $meta: { metric: 'history:replay' } });
  await h.invoke('settings', 'clearHistory');
  await h.invoke('settings', 'getHistory');
  await h.invoke('settings', 'replayDrop', tImage);
});

S('react-unlink-unblock', 'drop:react, connection:unlink-guild, connection:unblock-user -> WS frames; bot answers; disconnected sends', async (h) => {
  await bootLinked(h);
  await h.botSend(h.bot.drop({ dropId: 'abc123' }), { label: 'bot→ drop abc123' });
  await h.send('overlay', 'reactDrop', 'abc123', '😂');
  await h.send('overlay', 'reactDrop', 'abc123');
  await h.send('overlay', 'reactDrop', null, '🔥');
  await h.send('overlay', 'reactDrop', 777, 42);
  await h.invoke('settings', 'unblockUser', 'u900');
  await h.invoke('settings', 'unlinkGuild', 'g200');
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'unlinkGuild', 123);
  await h.invoke('settings', 'unlinkGuild');
  await h.invoke('settings', 'unblockUser', null);
  await h.invoke('settings', 'unlinkGuild', 'g100');
  await h.invoke('settings', 'getConnection');
  h.setBotDown(true);
  await h.botTerminate();
  await h.invoke('settings', 'unlinkGuild', 'g100');
  await h.invoke('settings', 'unblockUser', 'u900');
  await h.send('overlay', 'reactDrop', 'abc123', '👍');
});

// ───────────────────────────────────────────────────────────── connection lifecycle
S('reconnect-backoff', 'Bot closes: reconnect after backoff with register replay; bot down: backoff schedule; manual reconnect', async (h) => {
  await bootLinked(h);
  await h.botClose(1000, 'bot closes connection (redeploy)');
  await h.advance(1599, 'advance 1599 ms (before first retry)');
  await h.advance(1, 'advance 1 ms (first retry)');
  await h.invoke('settings', 'getConnection');
  h.setBotDown(true);
  await h.botTerminate('bot crashes (terminate) and stays down');
  await h.advance(3 * MIN, 'advance 3 min with bot down');
  await h.invoke('settings', 'getConnection');
  h.setBotDown(false);
  await h.advance(30 * SEC, 'advance 30 s (bot back up)');
  await h.invoke('settings', 'getConnection');
  h.setBotDown(true);
  await h.botTerminate('bot down again');
  await h.advance(10 * SEC);
  h.setBotDown(false);
  await h.invoke('settings', 'reconnect');
  await h.invoke('settings', 'reconnect');
  await h.invoke('settings', 'getConnection');
});

S('ping-heartbeat', 'Application ping -> pong; heartbeat timeout after 75 s of silence; any frame re-arms the heartbeat; regular pings keep the link', async (h) => {
  h.bot.auto.ping = false;
  await bootLinked(h);
  await h.botSend({ type: 'ping' });
  await h.advance(74 * SEC, 'advance 74 s of silence');
  await h.botSend({ $raw: 'garbage' }, { label: 'bot→ garbage frame at 74 s' });
  await h.advance(74 * SEC + 999, 'advance 74.999 s');
  await h.advance(1, 'advance 1 ms (heartbeat deadline)');
  await h.advance(1600, 'advance 1.6 s (reconnect)');
  await h.invoke('settings', 'getConnection');
  h.bot.auto.ping = true;
  await h.advance(5 * MIN, 'advance 5 min with bot pings', { metric: 'idle-linked-5min' });
});

S('malformed-frames', 'Malformed / unknown frames are ignored without crashing', async (h) => {
  await bootLinked(h);
  for (const raw of ['not json', '[1,2]', 'null', '42', '"str"', '{}', '{"type":"unknown_type"}', '{"type":null}', '{"type":"pairing_code"}']) {
    await h.botSend({ $raw: raw }, { label: `bot→ raw ${raw}` });
  }
  await h.invoke('settings', 'getConnection');
  await h.invoke('settings', 'getHistory');
}, EDGE);

// ───────────────────────────────────────────────────────────── overlay renderer channels
S('test-drop-open-external', 'test-drop to overlay; open-external only for http(s) URLs', async (h) => {
  await bootLinked(h);
  await h.send('settings', 'testDrop');
  await h.invoke('settings', 'setMute', -1);
  await h.send('settings', 'testDrop', { $meta: { metric: 'test-drop' } });
  for (const u of ['https://github.com/Billalbzn/memedrop', 'http://example.com/a?b=c', 'HTTPS://EXAMPLE.COM', 'ftp://example.com', 'javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'mailto:x@y.z', ' https://leading.space', 'https:/one-slash', 123, null, { href: 'https://obj' }]) {
    await h.send('settings', 'openExternal', u);
  }
});

S('cursor-watch', 'overlay:watch-cursor polling sends overlay:cursor only on change (relative to the overlay), re-watch forces a resend, unwatch stops; set-ignore-mouse', async (h) => {
  await bootLinked(h);
  await h.botSend(h.bot.drop({ caption: 'hover me' }), { label: 'bot→ drop' });
  h.setCursorPath([{ at: h.t(), x: 500, y: 400 }, { at: h.t() + 50, x: 520, y: 410 }, { at: h.t() + 120, x: 521, y: 410 }, { at: h.t() + 300, x: 1000, y: 700 }]);
  await h.send('overlay', 'watchCursor');
  await h.advance(100, 'advance 100 ms');
  await h.send('overlay', 'watchCursor');
  await h.advance(100, 'advance 100 ms #2');
  await h.send('overlay', 'setIgnoreMouse', false);
  await h.send('overlay', 'setIgnoreMouse', true);
  await h.send('overlay', 'setIgnoreMouse', 0);
  await h.advance(200, 'advance 200 ms');
  await h.send('overlay', 'unwatchCursor');
  h.setCursorPath([{ at: h.t(), x: 1, y: 1 }]);
  await h.advance(1 * SEC, 'advance 1 s after unwatch');
  await h.invoke('settings', 'setSettings', { overlayDisplayId: 2779098405 });
  h.setCursorPath([{ at: h.t(), x: 2000, y: 100 }, { at: h.t() + 40, x: 2010, y: 110 }]);
  await h.send('overlay', 'watchCursor');
  await h.advance(64, 'advance 64 ms on display 2', { metric: 'cursor-poll-64ms' });
  await h.send('overlay', 'unwatchCursor');
  await h.send('overlay', 'unwatchCursor');
});

S('stage-empty-topguard', 'Top guard after a drop restores always-on-top every 2 s; stage-empty stops it; blur handler; next drop restarts it', async (h) => {
  await bootLinked(h);
  await h.botSend(h.bot.drop({ caption: 'guard' }), { label: 'bot→ drop' });
  await h.osDemotesWindow('overlay');
  await h.advance(2 * SEC, 'advance 2 s (guard tick)');
  await h.send('overlay', 'stageEmpty');
  await h.osDemotesWindow('overlay');
  await h.advance(10 * SEC, 'advance 10 s (no guard)');
  await h.osDemotesWindow('overlay', { blur: true });
  await h.osDemotesWindow('overlay');
  await h.botSend(h.bot.drop({ caption: 'guard again' }), { label: 'bot→ drop (restarts guard)' });
  await h.advance(4 * SEC, 'advance 4 s');
  await h.send('overlay', 'stageEmpty');
  await h.send('overlay', 'stageEmpty');
});

// ───────────────────────────────────────────────────────────── tray / windows / shortcuts
S('tray-actions', 'Tray click and every menu entry, shortcuts, closing the settings window hides it, Quitter quits', async (h) => {
  await h.boot({ hidden: true });
  await h.trayEvent('click');
  await h.trayEvent('click');
  await h.trayClick('Afficher / masquer l\'overlay');
  await h.botSend(h.bot.drop({ caption: 'while overlay hidden' }), { label: 'bot→ drop while the overlay is hidden' });
  await h.trayClick('Afficher / masquer l\'overlay');
  await h.osDemotesWindow('overlay');
  await h.trayClick('Forcer au premier plan');
  await h.trayClick('Ouvrir les DevTools (overlay)');
  await h.userClosesWindow('settings');
  await h.trayClick('Ouvrir les réglages…');
  await h.trayClick('Vérifier les mises à jour…');
  await h.trayClick('MemeDrop');
  await h.shortcut('Control+Alt+S');
  await h.shortcut('Control+Alt+M');
  await h.appEvent('activate');
  await h.appEvent('window-all-closed');
  await h.trayClick('Quitter');
});

// ───────────────────────────────────────────────────────────── updater
S('updater-packaged', 'Packaged app: silent check at 4 s, manual check, periodic check finds an update, download progress, install', async (h) => {
  h.updaterScript.check = [{ type: 'not-available' }, { type: 'not-available' }, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }, { type: 'error', message: 'HttpError: 404' }, { type: 'available', version: '9.9.9' }];
  h.updaterScript.download = { progress: [12.34, 56.78, 100], stepMs: 1000 };
  await h.boot({ packaged: true });
  await h.advance(4 * SEC, 'advance 4 s (startup check)');
  await h.invoke('settings', 'checkForUpdate');
  await h.advance(30 * MIN - 4 * SEC, 'advance to 30 min (periodic check fails silently)');
  await h.invoke('settings', 'checkForUpdate');
  await h.invoke('settings', 'installUpdate');
  await h.advance(30 * MIN, 'advance 30 min (periodic check finds 9.9.9)');
  await h.invoke('settings', 'getUpdateState');
  await h.invoke('settings', 'downloadUpdate');
  await h.advance(1 * SEC, 'advance 1 s (download)');
  await h.invoke('settings', 'checkForUpdate');
  await h.advance(3 * SEC, 'advance 3 s (download done)');
  await h.advance(30 * MIN, 'advance 30 min (no check once downloaded)');
  await h.invoke('settings', 'downloadUpdate');
  await h.invoke('settings', 'installUpdate');
});

S('updater-download-error', 'Packaged app: download error is shown; update:download when nothing is available is a no-op', async (h) => {
  h.updaterScript.check = [{ type: 'available', version: '2.0.0' }];
  h.updaterScript.download = { error: 'net::ERR_CONNECTION_RESET', afterMs: 1500 };
  await h.boot({ packaged: true, hidden: true });
  await h.trayEvent('click');
  await h.advance(4 * SEC, 'advance 4 s (startup check finds 2.0.0)');
  await h.invoke('settings', 'downloadUpdate');
  await h.advance(2 * SEC, 'advance 2 s (download fails)');
  await h.invoke('settings', 'getUpdateState');
  await h.invoke('settings', 'downloadUpdate');
});

S('updater-tray-check-hidden', 'Packaged app started hidden: "Vérifier les mises à jour…" from the tray while no settings window exists', async (h) => {
  h.updaterScript.check = [{ type: 'not-available' }, { type: 'available', version: '3.0.0' }];
  await h.boot({ packaged: true, hidden: true });
  await h.trayClick('Vérifier les mises à jour…');
  await h.advance(4 * SEC, 'advance 4 s (startup check finds 3.0.0)');
  await h.trayEvent('click');
});

S('updater-dev', 'Unpackaged app: manual check reports dev-mode, download/install are no-ops, no background check', async (h) => {
  await h.boot();
  await h.advance(5 * SEC, 'advance 5 s');
  await h.invoke('settings', 'getUpdateState');
  await h.invoke('settings', 'checkForUpdate');
  await h.invoke('settings', 'downloadUpdate');
  await h.invoke('settings', 'installUpdate');
  await h.trayClick('Vérifier les mises à jour…');
  await h.advance(31 * MIN, 'advance 31 min');
});

// ───────────────────────────────────────────────────────────── metrics
S('idle-metrics', 'Disk access while idle: linked, bot pings every 30 s; then with the settings page polling isQuietHoursActive every 30 s; then with the top guard running', async (h) => {
  await bootLinked(h);
  await h.advance(10 * MIN, 'idle 10 min (main process only)', { metric: 'idle-10min' });
  h.startRendererPoll('settings', 'isQuietHoursActive', 30 * SEC);
  await h.advance(10 * MIN, 'idle 10 min (+settings page 30 s poll)', { metric: 'idle-10min-with-settings-poll' });
  h.stopRendererPoll();
  await h.botSend(h.bot.drop({ caption: 'start guard' }), { label: 'bot→ drop (top guard starts)' });
  await h.advance(10 * MIN, 'idle 10 min (top guard running)', { metric: 'idle-10min-topguard' });
});

module.exports = { scenarios, IDENTITY, SEC, MIN, T };
