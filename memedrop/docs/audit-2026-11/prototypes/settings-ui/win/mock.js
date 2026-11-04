// mock.js — remplace preload.js (window.memedrop) pour tester settings.js dans Chrome.
(function () {
  const q = new URLSearchParams(location.search);
  const status = q.get('status') || 'linked';
  const tab = q.get('tab');
  if (tab) try { localStorage.setItem('memedrop.tab', tab); } catch {}

  // Variantes CSS injectées
  const css = [];
  if (q.has('nograin'))  css.push('.grain{display:none!important}');
  if (q.has('nopillbf')) css.push('.pill{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  if (q.has('notopbf'))  css.push('.topbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  if (q.has('noblur'))   css.push('body::before{filter:none!important}');
  if (q.has('altbg'))    css.push(`body::before{filter:none!important;inset:0!important;background:
    radial-gradient(55% 45% at 15% 0%,   rgba(255,94,138,.16), transparent 65%),
    radial-gradient(45% 35% at 95% 15%,  rgba(255,180,94,.13), transparent 65%),
    radial-gradient(55% 45% at 50% 110%, rgba(106,255,224,.08), transparent 65%) !important}`);
  if (q.has('noanim'))   css.push('*,*::before,*::after{animation:none!important;transition:none!important}');
  if (css.length) {
    const st = document.createElement('style');
    st.textContent = css.join('\n');
    document.head.appendChild(st);
  }

  const now = Date.now();
  const nHist = Number(q.get('hist') ?? 20);
  const history = [];
  for (let i = 0; i < nHist; i++) {
    history.push({
      from: 'pote' + i, avatar: null, kind: ['image', 'gif', 'video', 'audio'][i % 4],
      caption: i % 3 ? null : 'caption ' + i, ts: now - i * 3_600_000,
      media: { url: 'https://cdn.discordapp.com/attachments/1/2/x.png', kind: 'image', mime: 'image/png' },
      music: null, rain: null, tts: null, ttsUrl: null, effect: null,
    });
  }
  const code = q.get('code') ?? '123456';
  const gid = q.get('gid') ?? '111111111111111111';
  const links = {
    scope: 'guild',
    guilds: [
      { id: gid, name: 'Serveur A', icon: null, enabled: true },
      { id: '222222222222222222', name: 'Serveur B', icon: null, enabled: true },
    ],
    guildIds: [gid, '222222222222222222'],
    blocked: [{ id: q.get('bid') ?? '333', username: 'relou' }],
    blockedIds: ['333'],
  };
  let conn = { status, code: status === 'awaiting_link' || status === 'linked' ? code : null,
    user: status === 'linked' ? { id: '1', username: 'moi' } : null,
    links: status === 'linked' ? links : null, muteUntil: null };

  window.__calls = [];
  const ok = (v) => Promise.resolve(v);
  window.memedrop = {
    getSettings: () => ok({
      serverUrl: 'wss://memedrop-bot.fly.dev', volume: 0.75, musicVolume: 0.75,
      opacity: Number(q.get('opacity') ?? 1), duration: 4, videoDuration: 30,
      soundOnArrival: true, spotlightOnDrop: true, autostart: true, overlayDisplayId: q.has('did') ? Number(q.get('did')) : null,
      paused: status === 'paused', muteUntil: null, theme: 'classic',
      quietHours: { enabled: false, start: '22:00', end: '08:00' }, avoidZone: 'none',
    }),
    setSettings: (p) => { window.__calls.push(['setSettings', p]); return ok(true); },
    listDisplays: () => ok([{ id: 1, label: 'Display 1', bounds: { width: 1920, height: 1080 }, primary: true }]),
    getConnection: () => ok(conn),
    reconnect: () => ok(true),
    unlinkGuild: (id) => { window.__calls.push(['unlinkGuild', id]); return ok(false); },
    unblockUser: (id) => { window.__calls.push(['unblockUser', id]); return ok(false); },
    onConnection: (cb) => { window.__pushConn = (s) => { conn = s; cb(s); }; return () => {}; },
    setMute: (m) => ok(m),
    getMute: () => ok(null),
    isQuietHoursActive: () => { window.__calls.push(['isQuietHoursActive']); return ok(false); },
    getHistory: () => ok(history),
    clearHistory: () => ok(true),
    replayDrop: () => ok(true),
    reactDrop() {},
    onHistory: (cb) => { window.__pushHistory = cb; return () => {}; },
    onDrop: () => () => {},
    onSettingsUpdate: () => () => {},
    getVersion: () => ok('1.5.1'),
    getUpdateState: () => ok({ status: q.get('update') || 'idle', version: '1.6.0', progress: 40 }),
    checkForUpdate: () => ok(true), downloadUpdate: () => ok(true), installUpdate: () => ok(true),
    onUpdateState: (cb) => { window.__pushUpdate = cb; return () => {}; },
    testDrop() {}, openExternal() {}, stageEmpty() {},
  };
})();
