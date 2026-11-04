# Banc de test main

## harness_dir
/tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness

## run_command
node /tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/run.js <overlay-dir> <out.json>    (example: node /tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/run.js /home/user/memedrop/memedrop/overlay /tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/new.json ; options: --only=a,b  --jobs=N  --list ; about 4 s for 37 scenarios; it loads the package.json "main" of <overlay-dir> plus the preload of each window)

## compare_command
node /tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/compare.js /tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/baseline.json <out.json>    (exit 0 = no FAIL, 1 = behaviour differs, 2 = usage error; options: --strict (WARN also fails), --max=N, --quiet, --only=a,b, --t-tol=MS. Output: differences classed FAIL/WARN/INFO, a disk-access table A→B and a verdict per scenario. Readable dump: node .../main-harness/view.js <out.json> <scenario> [from] [to] [--state] [--io]. Self-test of the harness: node .../main-harness/selftest.js /home/user/memedrop/memedrop/overlay .../main-harness/baseline.json)

## baseline_path
/tmp/claude-0/-home-user-memedrop/065ca17e-4939-5472-b348-276c03e80469/scratchpad/main-harness/baseline.json

## scenarios
[
 "boot-fresh: first launch with no config.json. Covers window creation and options, tray menu and tooltip, setLoginItemSettings, setAppUserModelId, switches, global shortcuts, connection to DEFAULT_SERVER, the pairing_code broadcast and the renderer init calls of both pages",
 "boot-hidden: start with '--hidden'. Only the overlay and the tray are created, no settings window",
 "boot-existing-identity: stored identity and custom settings. Covers the automatic register, the linked state, persisted settings and a drop carrying those settings",
 "boot-legacy-railway: a stored Railway URL is migrated to DEFAULT_SERVER",
 "boot-partial-store: config file with missing keys and an unknown key; defaults are merged once",
 "boot-corrupt-store [edge]: a corrupt config.json makes startup throw",
 "boot-paused: paused=true at launch, so no connection is made",
 "drop-before-overlay-ready: a drop arrives right after the automatic re-link, before the overlay page has loaded",
 "second-instance-denied: the single-instance lock is refused and the process quits",
 "second-instance-event: a 'second-instance' event creates the settings window, then re-shows it after it was closed",
 "pairing-link-flow: pairing_code → awaiting_link; /link → linked with links and token, linkIdentity saved; extension code while linked; links_update for guild, global and missing links",
 "register-failed: a stored identity with a bad token fails silently on register, is cleared, falls back to pairing, then a fresh /link works",
 "register-failed-direct [edge]",
 "linked-without-token [edge]: 'linked' without token, links or user",
 "unlinked: identity cleared, state 'connecting', then a new pairing code",
 "drops: image, video+music+effect, tts, rain, empty, music-only with no ts. Covers 'drop'+settings to the overlay, history-update, history:get, a 16-drop burst and the 20-entry cap",
 "mute-manual: mute:set 30/-1/null/0 and the tray mute entries. Muted drops are recorded but not shown; covers expiry on the 30 s refresh, tray and tooltip, and a drop between expiry and the next tick",
 "quiet-hours: active window and exact boundaries 12:29:59 / 12:30:00; cross-midnight window and its boundaries; start==end; malformed times; interaction with manual mute; tray badge and tooltip",
 "settings-roundtrip: settings:get; settings:set of one, six and non-live keys; live settings-update to the overlay; autostart → setLoginItemSettings; a drop carries the new settings; getVersion, listDisplays",
 "settings-server-url: rejected URLs (http, ftp, spaces, empty, 'wss://'); reconnect to a new URL with register; an unreachable host with backoff; a URL that passes the regex but cannot be parsed; back to DEFAULT; same URL again",
 "settings-paused: paused true → disconnect, no reconnect for 2 min, reconnect blocked while paused; paused false → reconnect and re-register; paused false again",
 "settings-unusual [edge]: payloads that are null, a string, an array, an unknown key, a dotted key, an undefined value, muteUntil, linkIdentity or dropHistory set through settings:set",
 "display-select: displays:list, overlayDisplayId set to display 2 / invalid / null, display removed, added and resolution changed → reposition and enforceTop",
 "history-replay: replay by ts (image, tts), music-only → false, unknown or missing ts → false, replay while muted, clear and history-update",
 "react-unlink-unblock: drop:react (valid / missing args) → WS frame; unlink-guild and unblock-user frames with the bot's links_update / unlinked answers; calls while disconnected return false and send nothing",
 "reconnect-backoff: bot closes → retry at exactly 1600 ms with register; bot down for 3 min → full backoff schedule (1.6/2.56/4.096/6.553/10.485/16.777/26.843/30/30 s); recovery; manual reconnect",
 "ping-heartbeat: ping→pong; a garbage frame re-arms the heartbeat; timeout at exactly 75 s of silence → terminate and reconnect after 1.6 s; 5 min of bot pings keeps the link",
 "malformed-frames [edge]: non-JSON, array, null, number, string, {}, unknown type, null type, pairing_code without a code",
 "test-drop-open-external: test-drop, including while muted; open-external with https, http, upper case, ftp, javascript:, file:, mailto:, a leading space, one slash, a number, null, an object",
 "cursor-watch: 16 ms poll sends overlay:cursor only on change, relative to the overlay bounds (display 1 and 2); re-watch forces a resend; unwatch stops; set-ignore-mouse true/false/0",
 "stage-empty-topguard: after a drop the 2 s guard restores always-on-top; stage-empty stops it; the blur handler restores it; the next drop restarts it",
 "tray-actions: tray click (create, then show+focus); hide/show the overlay; a drop while the overlay is hidden; force on top; DevTools; closing the settings window hides it; update check (dev); disabled item; Ctrl+Alt+S/M; activate; window-all-closed; Quitter → quit sequence",
 "updater-packaged: silent check at 4 s; manual check → checking/up-to-date; silent background error; manual error; periodic 30 min check finds 9.9.9; download progress 12/57/100 → downloaded; no check while downloading or downloaded; install → quitAndInstall(true,true)",
 "updater-download-error: the download fails → error state; download is a no-op afterwards",
 "updater-tray-check-hidden: the tray update check runs while no settings window exists",
 "updater-dev: unpackaged → dev-mode; download and install are no-ops; no background check",
 "idle-metrics: 10 min idle while linked; 10 min with the settings page polling every 30 s; 10 min with the top guard running"
]

## baseline_metrics
Disk counters are the fs calls under userData, made by any library. The electron-store 8.2 / conf 10.2 stand-in re-reads and parses config.json on every get(). Every set() rewrites the whole file atomically: 2 mkdir + realpath + open + write + fsync + close + rename. Current code:
- Received drop (not muted): 12 reads + 1 write (1 fsync).
- Muted drop: 4 reads + 1 write.
- settings:get: 15 reads.
- settings:set: 1 read + 1 write per key. A 6-key patch costs 6 reads / 6 writes / 6 fsync. A paused or serverUrl change costs 6 reads + 2 writes, because the reconnect re-registers and rewrites linkIdentity.
- Other calls: mute:set 4r/1w; history:get 1r; history:replay 9r; test-drop 8r; 'linked' 1r/1w.
- Boot: 11 reads + 1 write on first launch, 12r/2w with a stored identity. The renderer init calls of both pages add 32 more reads (settings:get ×2 = 30).
- Idle while linked, bot pinging every 30 s: 4 reads/min (2 per 30 s refresh tick), 0 writes.
- Idle with the settings page loaded (its 30 s isQuietHoursActive poll): 6 reads/min.
- Idle with the top guard running: 4 reads/min.
- 16-drop burst: 192 reads, 16 writes, 16 fsync.
Machine-readable values are in baseline.json under metrics.byMetric (perSample, perMinute for the idle tags), plus `io` on every step and `ioTotal` per scenario. baseline.json sha256 = 60e582236e885a19a6a5e3a35910993a56f4658a6eaf61cc393b5db2e7bccdc3. The file was byte-identical across 7 runs: jobs=1/2/4/8, three runs in parallel next to a busy-loop CPU hog, before and after the defer-window change.

## observed_bugs
[
 "URL accepted by validation but not parseable leaves the app stuck on 'connecting' forever (settings-server-url). The settings:set regex /^wss?:\\/\\/\\S+$/ accepts 'wss://memedrop-bot.fly.dev:99999' (port > 65535). The new WebSocket() call throws 'SyntaxError: Invalid URL', and the catch only schedules a retry. Expected: status 'disconnected' (UI 'Bot injoignable') or the URL rejected. Actual: 'settings.getConnection() #3' (t=10 s) and '#4' (t=70 s) both return status 'connecting'. Constructor errors repeat at 20.485 s, 37.262 s and 64.105 s with no connection-state change, so the settings UI keeps showing 'Connexion au bot…'.",
 "settings:set accepts any key, including internal ones (settings-unusual, edge). After {dropHistory:null}, every later drop throws inside the WS message handler: step 'bot→ drop with dropHistory=null' records uncaughtException 'TypeError: store.get is not a function or its return value is not iterable'. The drop is neither shown nor recorded, history:get returns null, and history:replay rejects 'Cannot read properties of null (reading 'find')'. {muteUntil:-1} mutes drops without any tray or connection-state update. {linkIdentity:null} silently forgets the identity. Expected: unknown or internal keys rejected. Any renderer can send these; the shipped UI does not.",
 "Patch with an undefined value is half-applied (settings-unusual, edge). setSettings({volume:0.2, opacity:undefined, theme:'neon'}) — IPC structured clone keeps the undefined — rejects with 'Use `delete()` to clear values'. A later getSettings shows volume 0.2 persisted but theme still 'classic'. No settings-update reaches the overlay although volume changed, because the per-key store.set loop aborts mid-patch.",
 "Drop arriving before the overlay page has loaded is lost (drop-before-overlay-ready). In step 'boot' the 'drop' IPC goes to the overlay window with reason page-not-loaded (no renderer listener yet), yet settings.getHistory shows the 'welcome back' drop. main.js sends drops without waiting for the overlay renderer to be ready. Real-world chance is low: it is a race between the fast automatic re-link at login and the overlay page load.",
 "Tray 'Vérifier les mises à jour…' gives no feedback when the settings window is not open (updater-tray-check-hidden). The update-state messages 'checking' and 'up-to-date', and later 'available 3.0.0', go only to the overlay window, which has no listener. There is no dialog, notification or tray change. The result only appears once the settings window is opened.",
 "Needs product confirmation (tray-actions). After 'Afficher / masquer l'overlay' hides the overlay, drops are still delivered to the hidden renderer: onDrop is delivered while state.overlay.visible=false. The drop is invisible (its sound may still play, since background throttling is off), it is not treated as muted, and main.js never re-shows the window.",
 "Corrupt config.json blocks startup (boot-corrupt-store, edge; depends on conf@10 defaulting clearInvalidConfig to false, as emulated). new Store() throws 'SyntaxError: Expected double-quoted property name in JSON at position 15' while main.js loads. No window, tray or connection is created, and the app cannot start until the file is deleted.",
 "Minor, a side effect of the 30 s refresh (mute-manual). When a timed quiet mode expires, drops show again at once, but the tray tooltip stays 'MemeDrop — mode tranquille 🔇' and connection:get still returns the expired muteUntil until the next tick. Example: a drop is shown at t=3975 s while the tray still says muted; tray and state are fixed at 3990 s.",
 "Dead code (observation). The paused check in the socket 'close' handler (if (store.get('paused')) {...}) can never run: removing it changes no scenario (equivalent mutant in selftest.js), because pausing always goes through connectWS() → dropSocket(), which detaches that handler first."
]

## limitations
Scope: only overlay/main.js and preload.js are tested, without Electron. Nothing under /home/user/memedrop was modified (git status clean).

1) Electron is replaced by stand-ins written from the Electron 33 API: windows, webContents, tray and menus (Menu objects with items, roles, disabled items), ipcMain handle/on with structuredClone on every crossing, sandboxed-preload require rules, the quit sequence, and the default quit on 'window-all-closed' when no listener is registered. Window "state" is the stand-in's own bookkeeping; real OS behaviour (z-order, focus, rendering, DPI) is not exercised.

2) Renderers are simulated. The real preload.js runs, and windows are driven only through window.memedrop.*. Which `memedrop.onXxx` events each page subscribes to comes from a static scan of the page's scripts, so new subscriptions in optimized renderers are picked up. The calls each page makes when it loads are hard-coded from today's overlay.js and settings.js. A page "loads" right after the step that called loadFile — an idealized, deterministic page-load timing. Messages sent before that, or on events no listener handles, are INFO only.

3) electron-store, conf and atomically are emulated from knowledge of conf@10.2.0 (dot-prop 6, atomically 1.7 on the win32 path). Schema, migrations, watch and encryption are not emulated; their use is noted in the transcript. Disk counters count fs calls under userData whatever library makes them; FileHandle operations are only partly counted.

4) WebSockets are real loopback connections using Playwright's bundled ws@8.21.0, the same version as package-lock (override with MEMEDROP_WS_BUNDLE). Any non-local host is redirected to an HTTP 503 endpoint: no DNS, TLS or real-network failure modes. The fake bot mirrors bot/index.js: pairing code on connect, register → linked or register_failed, unlink/unblock answers, a 30 s ping, and termination of overlays that did not answer.

5) Time is virtual: timers, Date, performance.now, timers/promises, and a seeded Math.random, so jitter stays reproducible. process.hrtime is not faked. Network and IPC complete instantly between timer firings. Other fixed settings: TZ=UTC, process.platform='win32', app.getVersion()='1.0.0-harness' (a version bump is not a diff). electron-updater outcomes are scripted.

6) Comparison policy:
- Renderer messages are compared by preload API name, not by IPC channel name.
- Connection, history and update-state messages are compared as the last value per instant.
- Timestamps get ±50 ms tolerance (exact for onCursor).
- One-shot timers of 50 ms or less created during a step run before the step ends, so deferring work by a tick is not a FAIL.
- Longer debounces show up as WARN (store content before the final idle). The store must still match after a 10 s idle and after quit.
- Intended timing changes, such as reconnect jitter, will FAIL and must be reviewed.
- Window method-call sequences (moveTop, setWindowOpenHandler…) are WARN; window, tray and login-item state are FAIL.

7) Five edge-case scenarios feed inputs the shipped UI and bot never send; FAILs there are labelled [edge].

8) Step labels are the alignment keys: editing lib/scenarios.js requires regenerating baseline.json from the reference code.

9) Harness check: selftest.js applies 25 text patches to today's code and all behave as expected. 7 behaviour-preserving variants report 0 FAIL: in-memory store cache, single read for drop settings, broadcasts to the settings window only, cursor bounds cache, debounced writes flushed on quit, deferred startup with coalesced broadcasts, and removal of the dead paused branch. 18 behaviour changes are caught, including a naive cache that loses dot-notation (edge), reconnect jitter, heartbeat/backoff/history-cap/quiet-hours boundary changes, preload payload changes and tray text.

The patches target today's main.js; once the code changes, failing patches are reported as PATCH-FAILED.

