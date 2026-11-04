(async () => {
  const PATCH = true;
  const now = Date.now();
  window.__state.history.forEach((h, i) => { h.ts = now - i * 12 * 3600000; });
  if (PATCH) {
    const T = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const DL = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const DS = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
    Date.prototype.toLocaleTimeString = function () { return T.format(this); };
    Date.prototype.toLocaleDateString = function (l, o) { return (o && o.weekday ? DL : DS).format(this); };
  }
  const runs = [];
  for (let k = 0; k < 7; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) window.onNativeState();
    runs.push((performance.now() - t0) / 100);
    await new Promise(r => setTimeout(r, 50));
  }
  runs.sort((a, b) => a - b);
  const lay = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) { window.onNativeState(); document.body.offsetHeight; }
    lay.push((performance.now() - t0) / 50);
    await new Promise(r => setTimeout(r, 50));
  }
  lay.sort((a, b) => a - b);
  return { patch: PATCH, median_ms_per_push: runs[3].toFixed(3), median_ms_with_layout: lay[2].toFixed(3), text: document.querySelector('#history-list').textContent.length };
})()
