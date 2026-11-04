(async () => {
  const PATCH = true;
  const now = Date.now();
  const hist = historyEntries.map((h, i) => ({ ...h, ts: now - i * 12 * 3600000 }));
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
    for (let i = 0; i < 100; i++) renderHistory(hist);
    runs.push((performance.now() - t0) / 100);
    await new Promise(r => setTimeout(r, 50));
  }
  runs.sort((a, b) => a - b);
  return { patch: PATCH, median_ms_renderHistory: runs[3].toFixed(3), rows: document.querySelectorAll('#history-list .server-row').length, text: document.querySelector('#history-list').textContent.length };
})()
