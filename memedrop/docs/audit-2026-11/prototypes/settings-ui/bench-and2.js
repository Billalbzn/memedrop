(async () => {
  const N = 200;
  const bench = (f) => { const t0 = performance.now(); for (let i = 0; i < N; i++) f(); return +((performance.now() - t0) / N).toFixed(3); };
  // Historique réaliste : 20 drops étalés sur 10 jours (libellés de jour via toLocaleDateString)
  const now = Date.now();
  window.__state.history.forEach((h, i) => { h.ts = now - i * 12 * 3600000; });
  window.onNativeState();
  const r = {};
  r.renderHistory_before = bench(() => renderHistory());
  r.onNativeState_before = bench(() => window.onNativeState());
  const sameOut = [...document.querySelectorAll('#history-list')].map(e => e.textContent).join('|');
  // Après : formateurs Intl mis en cache (même locale/options => même texte)
  const T = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const DL = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const DS = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const origT = Date.prototype.toLocaleTimeString, origD = Date.prototype.toLocaleDateString;
  Date.prototype.toLocaleTimeString = function () { return T.format(this); };
  Date.prototype.toLocaleDateString = function (l, o) { return (o && o.weekday ? DL : DS).format(this); };
  r.renderHistory_cachedIntl = bench(() => renderHistory());
  r.onNativeState_cachedIntl = bench(() => window.onNativeState());
  const after = [...document.querySelectorAll('#history-list')].map(e => e.textContent).join('|');
  r.identicalText = sameOut === after;
  Date.prototype.toLocaleTimeString = origT; Date.prototype.toLocaleDateString = origD;
  r.sample = document.querySelector('#history-list').textContent.slice(0, 160);
  return r;
})()
