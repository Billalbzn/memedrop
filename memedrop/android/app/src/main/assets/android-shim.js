// android-shim.js — remplace l'API Electron `window.memedrop` pour que
// overlay.js (le renderer Windows) tourne tel quel dans la WebView Android.
// Le service Kotlin pousse les drops via window.__mdDrop(payload) et les
// réglages via window.__mdSettings(patch).
(function () {
  const dropListeners = [];
  const settingsListeners = [];
  let settings = {};
  const noop = () => {};

  window.memedrop = {
    onDrop(cb) { dropListeners.push(cb); return noop; },
    onSettingsUpdate(cb) { settingsListeners.push(cb); return noop; },
    getSettings() { return Promise.resolve(settings); },
    // Sur mobile l'overlay ne capte jamais le toucher (sinon le jeu dessous
    // ne recevrait plus rien) : pas de drag, de croix ni de réactions.
    onCursor() { return noop; },
    watchCursor: noop,
    unwatchCursor: noop,
    setIgnoreMouse: noop,
    stageEmpty: noop,
    reactDrop: noop,
  };

  window.__mdDrop = (payload) => { for (const cb of dropListeners) cb(payload); };
  window.__mdSettings = (patch) => {
    settings = Object.assign({}, settings, patch);
    for (const cb of settingsListeners) cb(patch);
  };

  // Tailles adaptées à un écran de téléphone
  const st = document.createElement('style');
  st.textContent = `
    .drop img, .drop video, .media-box > div > svg {
      max-width: 78vw !important;
      max-height: 42vh !important;
    }
    .drop-close, .react-bar { display: none !important; }
    .avatar-bubble { width: 44px !important; height: 44px !important; }
  `;
  document.head.appendChild(st);
})();
