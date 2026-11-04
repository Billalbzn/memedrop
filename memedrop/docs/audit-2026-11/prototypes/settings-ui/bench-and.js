(async () => {
  const N = 200;
  const bench = (f) => { const t0 = performance.now(); for (let i = 0; i < N; i++) f(); return +((performance.now() - t0) / N).toFixed(3); };
  window.onNativeState();
  const r = {};
  r.readState = bench(() => readState());
  r.renderPermissions = bench(() => renderPermissions());
  r.renderConnection = bench(() => renderConnection());
  r.renderMute = bench(() => renderMute());
  r.renderHistory = bench(() => renderHistory());
  r.renderUpdate = bench(() => renderUpdate());
  const ts = Date.now() - 3 * 86400000;
  r.toLocaleTimeString = bench(() => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
  r.dayLabel_old = bench(() => dayLabel(ts));
  const fmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  r.cachedIntlFormat = bench(() => fmt.format(ts));
  r.historyRows = document.querySelectorAll('#history-list .server-row').length;
  return r;
})()
