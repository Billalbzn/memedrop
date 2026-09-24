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
    // Sur mobile, le toucher est géré côté natif (OverlayController) : des
    // zones tactiles sont posées pile sur chaque drop (voir reportRects).
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

  // Tailles adaptées à un écran de téléphone. Pas de survol sur mobile : la
  // croix de fermeture est toujours visible, et plus grosse pour le doigt.
  const st = document.createElement('style');
  st.textContent = `
    .drop img, .drop video, .media-box > div > svg {
      max-width: 78vw !important;
      max-height: 42vh !important;
    }
    .drop .drop-close {
      opacity: 1 !important;
      transform: none !important;
      width: 34px !important;
      height: 34px !important;
      top: -14px !important;
      right: -14px !important;
      font-size: 16px !important;
    }
    .react-bar { display: none !important; }
    .avatar-bubble { width: 44px !important; height: 44px !important; }
  `;
  document.head.appendChild(st);

  // Signale au natif la position de chaque drop (px physiques) pour qu'il y
  // place une zone tactile : glisser = déplacer, toucher la croix = fermer.
  // On mesure depuis l'ancre (offsetLeft/Top + taille de mise en page) et non
  // getBoundingClientRect : l'animation de flottement bougerait la zone en
  // permanence.
  const MARGIN = 18;   // px CSS autour du drop (croix qui dépasse, doigt)
  let lastSent = '';
  function reportRects() {
    if (!window.MDOverlay) return;
    const dpr = window.devicePixelRatio || 1;
    const rects = [];
    document.querySelectorAll('#stage .anchor').forEach((a) => {
      const d = a.querySelector('.drop');
      if (!d || d.classList.contains('leaving') || d.classList.contains('closing')) return;
      const w = d.offsetWidth;
      const h = d.offsetHeight;
      if (!w || !h) return;
      // Le média vient peut-être de charger : on le recale s'il déborde
      if (window.__mdDropCtl) window.__mdDropCtl.fit(a.dataset.key);
      rects.push({
        key: a.dataset.key,
        x: Math.round((a.offsetLeft - w / 2 - MARGIN) * dpr),
        y: Math.round((a.offsetTop - h / 2 - MARGIN) * dpr),
        w: Math.round((w + MARGIN * 2) * dpr),
        h: Math.round((h + MARGIN * 2) * dpr),
        cx: a.offsetLeft,
        cy: a.offsetTop,
      });
    });
    const json = JSON.stringify({ dpr, rects });
    if (json !== lastSent) {
      lastSent = json;
      window.MDOverlay.rects(json);
    }
  }
  setInterval(reportRects, 120);
})();
