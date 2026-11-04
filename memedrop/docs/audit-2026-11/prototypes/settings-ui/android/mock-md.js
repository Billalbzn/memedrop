// mock-md.js — remplace le pont natif MD (MainActivity.Bridge) pour tester app.js dans Chrome.
(function () {
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab');
  if (tab) try { localStorage.setItem('memedrop.tab', tab); } catch {}
  const css = [];
  if (q.has('nograin'))  css.push('.grain{display:none!important}');
  if (q.has('nopillbf')) css.push('.pill{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  if (q.has('notopbf'))  css.push('.topbar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  if (q.has('noblur'))   css.push('body::before{filter:none!important}');
  if (q.has('noanim'))   css.push('*,*::before,*::after{animation:none!important;transition:none!important}');
  if (css.length) { const st = document.createElement('style'); st.textContent = css.join('\n'); document.head.appendChild(st); }

  const now = Date.now();
  const nHist = Number(q.get('hist') ?? 20);
  const history = [];
  for (let i = 0; i < nHist; i++) {
    history.push({
      from: 'pote' + i,
      avatar: q.has('avatars') ? `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='%23${(i * 123456 % 0xffffff).toString(16).padStart(6, '0')}'/></svg>` : null,
      kind: ['image', 'gif', 'video', 'audio'][i % 4], ts: now - i * 3_600_000,
      caption: i % 3 ? null : 'caption ' + i,
      media: { url: `https://cdn.discordapp.com/attachments/1234567890123456789/1234567890123456789/meme_${i}.png?ex=6712a3b4&is=671152e4&hm=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&`, kind: 'image', mime: 'image/png', name: `meme_${i}.png`, size: 123456, width: 800, height: 600 },
      music: null, rain: null, tts: null, ttsUrl: null, effect: null,
    });
  }
  const status = q.get('status') || 'linked';
  window.__state = {
    status, code: '123456', user: status === 'linked' ? { id: '1', username: 'moi' } : null,
    links: status === 'linked' ? { scope: 'guild', guilds: [
      { id: '111111111111111111', name: 'Serveur A', icon: null, enabled: true },
      { id: '222222222222222222', name: 'Serveur B', icon: null, enabled: true }],
      guildIds: ['111111111111111111', '222222222222222222'], blocked: [{ id: '333', username: 'relou' }], blockedIds: ['333'] } : null,
    muteUntil: 0, quietActive: false, paused: false, serverUrl: 'wss://memedrop-bot.fly.dev',
    settings: { volume: 0.75, musicVolume: 0.75, opacity: 1, duration: 4, videoDuration: 30, soundOnArrival: true,
      spotlightOnDrop: false, theme: 'classic', avoidZone: 'none', autostart: true,
      quietHours: { enabled: false, start: '22:00', end: '08:00' } },
    history, perm: { overlay: true, notif: true, battery: true }, version: '1.6.0',
    update: { state: q.get('update') || 'idle', latest: '1.6.1', current: '1.6.0', progress: 0, error: null },
  };
  window.__calls = [];
  window.__getStateCalls = 0;
  const rec = (name) => (...a) => { window.__calls.push([name, ...a]); };
  window.MD = {
    getState: () => { window.__getStateCalls++; return JSON.stringify(window.__state); },
    setSetting: rec('setSetting'), setMute: rec('setMute'), setPaused: rec('setPaused'), start: rec('start'),
    reconnect: rec('reconnect'), testDrop: rec('testDrop'), replay: rec('replay'), clearHistory: rec('clearHistory'),
    unlinkGuild: rec('unlinkGuild'), unblockUser: rec('unblockUser'), checkUpdate: rec('checkUpdate'),
    downloadUpdate: rec('downloadUpdate'), installUpdate: rec('installUpdate'), requestOverlay: rec('requestOverlay'),
    requestNotif: rec('requestNotif'), requestBattery: rec('requestBattery'), copy: rec('copy'), openUrl: rec('openUrl'),
  };
})();
