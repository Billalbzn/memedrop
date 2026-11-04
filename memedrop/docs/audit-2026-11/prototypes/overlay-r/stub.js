// Stub Electron bridge for tests (not part of the project)
(function () {
  const dropL = [], setL = [], curL = [];
  window.__calls = { watch: 0, unwatch: 0, stageEmpty: 0, ignore: [] };
  window.memedrop = {
    onDrop(cb) { dropL.push(cb); return () => {}; },
    onSettingsUpdate(cb) { setL.push(cb); return () => {}; },
    getSettings() { return Promise.resolve({ theme: 'classic' }); },
    onCursor(cb) { curL.push(cb); return () => {}; },
    watchCursor() { window.__calls.watch++; },
    unwatchCursor() { window.__calls.unwatch++; },
    setIgnoreMouse(v) { window.__calls.ignore.push(v); },
    stageEmpty() { window.__calls.stageEmpty++; },
    reactDrop() {},
  };
  window.__drop = (p) => dropL.forEach(cb => cb(p));
  window.__settings = (p) => setL.forEach(cb => cb(p));
  window.__cursor = (x, y) => curL.forEach(cb => cb({ x, y }));
})();
