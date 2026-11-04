#!/usr/bin/env node
'use strict';
// Harness self-test: proves the harness (1) stays quiet on behaviour-
// preserving optimizations of the kind planned for main.js and (2) catches
// behaviour changes.
//
//   node selftest.js <overlay-dir> <baseline.json> [--only=name,...]
//
// Each variant copies <overlay-dir>, applies text patches written against
// TODAY's main.js / preload.js (a patch that no longer applies is reported
// as "patch-failed"), runs run.js on the copy and compare.js against the
// baseline. Expectation per variant: 'pass' = no FAIL, 'fail' = at least
// one FAIL (optionally in given scenarios).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HERE = __dirname;
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
if (pos.length !== 2) { process.stderr.write('usage: node selftest.js <overlay-dir> <baseline.json> [--only=a,b]\n'); process.exit(2); }
const [srcDir, baseline] = pos.map((p) => path.resolve(p));
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;

const V = [];
const variant = (name, expect, patches, why, scenarios) => V.push({ name, expect, patches, why, scenarios });

// ---------------------------------------------------------------- refactors (must PASS)
variant('opt-store-cache', 'pass', [['main.js',
  "if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);",
  `{
  // in-memory mirror of the store: reads never touch the disk; writes go
  // through electron-store (dot-notation keys refresh the mirror)
  let __cache = store.store;
  const __set = store.set.bind(store);
  const __clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  store.get = (k) => __clone(__cache[k]);
  store.set = (k, v) => { __set(k, v); if (String(k).includes('.')) __cache = store.store; else __cache[k] = __clone(v); };
}
if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);`]],
'in-memory cache of electron-store (reads served from memory, dot-notation kept)');

variant('near-miss-naive-store-cache', 'fail', [['main.js',
  "if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);",
  `{
  const __cache = store.store;
  const __set = store.set.bind(store);
  const __clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  store.get = (k) => __clone(__cache[k]);
  store.set = (k, v) => { __set(k, v); __cache[k] = __clone(v); };
}
if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);`]],
'naive cache: a dotted settings key ({"quietHours.enabled":true}) is cached as a literal key — must be caught (edge-case scenario only)', ['settings-unusual']);

variant('opt-drop-settings-one-read', 'pass', [['main.js',
  `  return {
    volume: store.get('volume'),
    musicVolume: store.get('musicVolume'),
    opacity: store.get('opacity'),
    duration: store.get('duration'),
    videoDuration: store.get('videoDuration'),
    soundOnArrival: store.get('soundOnArrival'),
    spotlightOnDrop: store.get('spotlightOnDrop'),
    avoidZone: store.get('avoidZone'),
  };`,
  `  const s = store.store;
  return {
    volume: s.volume, musicVolume: s.musicVolume, opacity: s.opacity, duration: s.duration,
    videoDuration: s.videoDuration, soundOnArrival: s.soundOnArrival, spotlightOnDrop: s.spotlightOnDrop,
    avoidZone: s.avoidZone,
  };`]],
'currentDropSettings reads the file once instead of 8 times');

variant('opt-broadcast-settings-only', 'pass', [
  ['main.js', `  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('history-update', history);
  }`, `  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('history-update', history);`],
  ['main.js', `  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('connection-state', connState);
  }`, `  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('connection-state', connState);`],
  ['main.js', `  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-state', updateState);
  }`, `  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-state', updateState);`],
], 'state broadcasts sent only to the settings window (the overlay never listens)');

variant('opt-cursor-bounds-cache', 'pass', [['main.js',
  `    const b = overlayWin.getBounds();`,
  `    const b = (startCursorPoll.__b && startCursorPoll.__bt === _cursorPollTimer) ? startCursorPoll.__b : (startCursorPoll.__bt = _cursorPollTimer, startCursorPoll.__b = overlayWin.getBounds());`],
['main.js', `function repositionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;`, `function repositionOverlay() {
  startCursorPoll.__b = null;
  if (!overlayWin || overlayWin.isDestroyed()) return;`]],
'cursor poll caches the overlay bounds (invalidated on reposition)');

variant('opt-debounced-writes-flush-on-quit', 'pass', [['main.js',
  "if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);",
  `{
  const __cache = store.store;
  const __clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let __timer = null;
  const __flush = () => { if (__timer) { clearTimeout(__timer); __timer = null; } store.store = __cache; };
  const __dot = (o, k, v) => { const p = String(k).split('.'); let x = o; for (let i = 0; i < p.length - 1; i++) { if (x[p[i]] === null || typeof x[p[i]] !== 'object') x[p[i]] = {}; x = x[p[i]]; } x[p[p.length - 1]] = v; };
  store.get = (k) => __clone(__cache[k]);
  store.set = (k, v) => { if (v === undefined) throw new TypeError('Use \`delete()\` to clear values'); __dot(__cache, k, __clone(v)); if (__timer) clearTimeout(__timer); __timer = setTimeout(__flush, 500); };
  app.on('before-quit', __flush);
}
if (isLegacyServerUrl(store.get('serverUrl'))) store.set('serverUrl', DEFAULT_SERVER);`]],
'writes coalesced (500 ms debounce) and flushed on quit — expect only WARN (store content before the final idle) and INFO');

variant('opt-deferred-startup-coalesced-state', 'pass', [
  ['main.js', `    createTray();
    connectWS();`, `    setTimeout(createTray, 0);
    setTimeout(connectWS, 10);`],
  ['main.js', `function broadcastState() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('connection-state', connState);
  }
}`, `let __bt = null;
function broadcastState() {
  if (__bt) return;
  __bt = setTimeout(() => {
    __bt = null;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('connection-state', connState);
    }
  }, 0);
}`],
], 'startup work deferred with setTimeout(0/10 ms) and connection-state broadcasts coalesced per tick — expect WARN only (invisible intermediate states)');

// ---------------------------------------------------------------- behaviour changes (must FAIL)
variant('change-reconnect-jitter', 'fail', [['main.js', 'Math.pow(1.6, Math.min(reconnectAttempts, 8)))', 'Math.pow(1.6, Math.min(reconnectAttempts, 8)) * (0.8 + Math.random() * 0.4))']],
  'reconnect jitter (an intended change): the retry schedule moves by more than the 50 ms tolerance, so it must be reviewed', ['reconnect-backoff']);

variant('bug-muted-drop-not-in-history', 'fail', [['main.js',
  `        recordHistory(msg);
        if (isMuted()) break;`,
  `        if (isMuted()) break;
        recordHistory(msg);`]], 'muted drops no longer recorded in history', ['mute-manual', 'quiet-hours']);

variant('bug-backoff-base', 'fail', [['main.js', 'Math.pow(1.6, Math.min(reconnectAttempts, 8))', 'Math.pow(2, Math.min(reconnectAttempts, 8))']], 'reconnect backoff schedule changed', ['reconnect-backoff']);

variant('bug-drop-settings-missing-key', 'fail', [['main.js', `    avoidZone: store.get('avoidZone'),
  };`, `  };`]], 'avoidZone missing from the settings attached to drops', ['drops']);

variant('bug-heartbeat-60s', 'fail', [['main.js', 'const HEARTBEAT_TIMEOUT_MS = 75_000;', 'const HEARTBEAT_TIMEOUT_MS = 60_000;']], 'heartbeat timeout 75 s -> 60 s', ['ping-heartbeat']);

variant('bug-no-register-replay', 'fail', [['main.js', `    if (identity && identity.userId) wsSend({ type: 'register', identity });`, `    void identity;`]], 'stored identity not replayed on connect', ['reconnect-backoff', 'boot-existing-identity']);

variant('bug-open-any-scheme', 'fail', [['main.js', `  if (/^https?:\\/\\//i.test(url)) shell.openExternal(url);`, `  if (typeof url === 'string') shell.openExternal(url);`]], 'open-external no longer restricted to http(s)', ['test-drop-open-external']);

variant('bug-cursor-always-sends', 'fail', [['main.js', `    if (_lastCursor && _lastCursor.x === pt.x && _lastCursor.y === pt.y) return;`, ``]], 'cursor poll sends even when the mouse did not move', ['cursor-watch']);

variant('bug-tray-tooltip', 'fail', [['main.js', `: quiet ? 'MemeDrop — heures calmes 🌙' : 'MemeDrop');`, `: quiet ? 'MemeDrop — heures calmes' : 'MemeDrop');`]], 'tray tooltip text changed', ['quiet-hours']);

variant('bug-live-patch-no-theme', 'fail', [['main.js', `    if ('theme'           in patch) livePatch.theme           = patch.theme;`, ``]], 'theme no longer pushed live to the overlay', ['settings-roundtrip']);

variant('bug-stage-empty-ignored', 'fail', [['main.js', `ipcMain.on('stage-empty', () => stopTopGuard());`, `ipcMain.on('stage-empty', () => {});`]], 'top guard never stopped', ['stage-empty-topguard']);

variant('bug-preload-ondrop-strips-settings', 'fail', [['preload.js', `    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('drop', handler);`, `    const handler = (_e, payload) => { const { settings, ...rest } = payload || {}; cb(rest); };
    ipcRenderer.on('drop', handler);`]], 'preload strips the settings from drops', ['drops']);

variant('bug-unlink-no-identity-clear', 'fail', [['main.js', `        store.set('linkIdentity', null);   // this overlay is no longer linked`, `        // identity kept`]], 'unlinked no longer clears the stored identity', ['unlinked']);

variant('equiv-dead-paused-branch', 'pass', [['main.js', `    if (store.get('paused')) { setState({ status: 'paused', code: null, user: null, links: null }); return; }
    setState({ status: 'disconnected'`, `    setState({ status: 'disconnected'`]], 'equivalent mutant: the paused check in the socket close handler is unreachable (pausing always goes through connectWS -> dropSocket, which detaches the handler)');

variant('bug-paused-ignored', 'fail', [['main.js', `  if (store.get('paused')) {
    setState({ status: 'paused', code: null, user: null, links: null });
    return;
  }
  const url = store.get('serverUrl');`, `  const url = store.get('serverUrl');`]], 'pause no longer prevents connecting', ['settings-paused', 'boot-paused']);

variant('bug-quiet-hours-end-inclusive', 'fail', [['main.js', `(cur >= start && cur < end)`, `(cur >= start && cur <= end)`]], 'quiet hours end minute now inclusive', ['quiet-hours']);

variant('bug-history-cap-10', 'fail', [['main.js', 'const MAX_HISTORY = 20;', 'const MAX_HISTORY = 10;']], 'history capped at 10', ['drops']);

variant('bug-settings-window-destroyed-on-close', 'fail', [['main.js', `    if (!app.isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }`, `    void e;`]], 'closing the settings window destroys it instead of hiding', ['tray-actions', 'second-instance-event']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const work = fs.mkdtempSync(path.join(HERE, '.selftest-'));
let bad = 0;
const lines = [];
for (const v of V) {
  if (only && !only.has(v.name)) continue;
  const dir = path.join(work, v.name, 'overlay');
  copyDir(srcDir, dir);
  let patchErr = null;
  for (const [file, from, to] of v.patches) {
    const p = path.join(dir, file);
    const s = fs.readFileSync(p, 'utf8');
    if (!s.includes(from)) { patchErr = `patch does not apply to ${file}: ${JSON.stringify(from.slice(0, 60))}`; break; }
    fs.writeFileSync(p, s.replace(from, to));
  }
  if (patchErr) { lines.push(`PATCH-FAILED ${v.name}: ${patchErr}`); bad++; continue; }
  const out = path.join(work, v.name, 'out.json');
  const r = spawnSync(process.execPath, [path.join(HERE, 'run.js'), dir, out], { encoding: 'utf8' });
  if (r.status !== 0) { lines.push(`RUN-FAILED ${v.name}: ${r.stderr.slice(-400)}`); bad++; continue; }
  const c = spawnSync(process.execPath, [path.join(HERE, 'compare.js'), baseline, out, '--max=400'], { encoding: 'utf8' });
  const verdictLine = c.stdout.trim().split('\n').pop();
  const failScen = [...c.stdout.matchAll(/^ {2}FAIL\s+(\S+)/gm)].map((m) => m[1]);
  const warnScen = [...c.stdout.matchAll(/^ {2}WARN\s+(\S+)/gm)].map((m) => m[1]);
  const hasFail = c.status === 1 && /\d+ FAIL/.test(verdictLine) && !/^IDENTICAL|^no behaviour/.test(verdictLine);
  const edgeOnly = /\((\d+) in edge-case scenarios\)/.exec(verdictLine);
  const failCount = Number((/(\d+) FAIL/.exec(verdictLine) || [0, 0])[1]);
  let ok;
  if (v.expect === 'pass') ok = !hasFail || (v.allowEdge && edgeOnly && Number(edgeOnly[1]) === failCount);
  else ok = hasFail && (!v.scenarios || v.scenarios.some((s) => failScen.includes(s)));
  if (!ok) bad++;
  lines.push(`${ok ? 'OK  ' : 'BAD '} ${v.name.padEnd(40)} expect=${v.expect.padEnd(4)} → ${verdictLine}\n       ${v.why}\n       FAIL in: ${failScen.join(', ') || '-'}${warnScen.length ? `\n       WARN in: ${warnScen.join(', ')}` : ''}`);
  process.stderr.write(`${lines[lines.length - 1]}\n`);
}
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
process.stdout.write(`\n${lines.join('\n')}\n\n${bad ? `${bad} variant(s) did not behave as expected` : 'all variants behaved as expected'}\n`);
process.exit(bad ? 1 : 0);
