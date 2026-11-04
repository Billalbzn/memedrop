'use strict';
// Stand-in for electron-updater@6 (autoUpdater). Every call is recorded;
// outcomes are scripted per scenario through H.updaterScript:
//   check:    array consumed per checkForUpdates() call, items
//             {type:'available', version} | {type:'not-available'} |
//             {type:'error', message}; default 'not-available'
//   download: {progress:[percent...], stepMs, version} | {error, afterMs}
// Event order mirrors AppUpdater: 'checking-for-update' is emitted
// synchronously inside checkForUpdates(); the outcome follows a microtask
// later; a failed check emits 'error' and then rejects the promise.
// Download progress events are spaced in virtual time (stepMs).

const { EventEmitter } = require('events');

// Errors carry no harness stack frames (they would leak into console text).
function cleanError(message) {
  const e = new Error(message);
  e.stack = `Error: ${message}`;
  return e;
}

function createUpdaterModule(H) {
  class AppUpdater extends EventEmitter {
    constructor() {
      super();
      this._cfg = { autoDownload: true, autoInstallOnAppQuit: true, logger: null, allowPrerelease: false, allowDowngrade: false, forceDevUpdateConfig: false, fullChangelog: false, channel: null };
      this._checkPromise = null;
      this._available = null;
      this._downloadPromise = null;
      this.currentVersion = { version: H.appVersion };
    }
    get autoDownload() { return this._cfg.autoDownload; }
    set autoDownload(v) { this._cfg.autoDownload = v; }
    get autoInstallOnAppQuit() { return this._cfg.autoInstallOnAppQuit; }
    set autoInstallOnAppQuit(v) { this._cfg.autoInstallOnAppQuit = v; }
    get logger() { return this._cfg.logger; }
    set logger(v) { this._cfg.logger = v; }
    get allowPrerelease() { return this._cfg.allowPrerelease; }
    set allowPrerelease(v) { this._cfg.allowPrerelease = v; }
    get allowDowngrade() { return this._cfg.allowDowngrade; }
    set allowDowngrade(v) { this._cfg.allowDowngrade = v; }
    get forceDevUpdateConfig() { return this._cfg.forceDevUpdateConfig; }
    set forceDevUpdateConfig(v) { this._cfg.forceDevUpdateConfig = v; }
    get channel() { return this._cfg.channel; }
    set channel(v) { this._cfg.channel = v; }

    snapshot() {
      return {
        autoDownload: this._cfg.autoDownload,
        autoInstallOnAppQuit: this._cfg.autoInstallOnAppQuit,
        logger: this._cfg.logger == null ? null : (this._cfg.logger === H.realConsole || this._cfg.logger === console ? 'console' : 'custom'),
        allowPrerelease: this._cfg.allowPrerelease,
        allowDowngrade: this._cfg.allowDowngrade,
        forceDevUpdateConfig: this._cfg.forceDevUpdateConfig,
        channel: this._cfg.channel,
      };
    }

    _active() {
      return H.electronMain.app.isPackaged || this._cfg.forceDevUpdateConfig;
    }

    checkForUpdates() {
      H.rec('updater', 'checkForUpdates', []);
      if (!this._active()) return Promise.resolve(null);
      if (this._checkPromise) return this._checkPromise;
      const outcome = (H.updaterScript.check && H.updaterScript.check.length) ? H.updaterScript.check.shift() : { type: 'not-available' };
      this.emit('checking-for-update');
      const p = Promise.resolve().then(() => {
        if (outcome.type === 'error') throw cleanError(outcome.message || 'net::ERR_INTERNET_DISCONNECTED');
        const info = { version: outcome.version || H.appVersion, files: [], path: 'x.exe', sha512: 'x', releaseDate: '2026-01-15T00:00:00.000Z' };
        if (outcome.type === 'available') {
          this._available = info;
          this.emit('update-available', info);
          return { isUpdateAvailable: true, updateInfo: info, versionInfo: info };
        }
        this.emit('update-not-available', info);
        return { isUpdateAvailable: false, updateInfo: info, versionInfo: info };
      });
      this._checkPromise = p.then((r) => { this._checkPromise = null; return r; }, (e) => {
        this._checkPromise = null;
        this.emit('error', e, `Cannot check for updates: ${(e.stack || e).toString()}`);
        throw e;
      });
      return this._checkPromise;
    }

    checkForUpdatesAndNotify() {
      H.rec('updater', 'checkForUpdatesAndNotify', []);
      return this.checkForUpdates();
    }

    downloadUpdate() {
      H.rec('updater', 'downloadUpdate', []);
      if (!this._available) {
        const e = cleanError('Please check update first');
        this.emit('error', e);
        return Promise.reject(e);
      }
      if (this._downloadPromise) return this._downloadPromise;
      const script = H.updaterScript.download || { progress: [25, 50, 75, 100], stepMs: 1000 };
      const info = this._available;
      this._downloadPromise = new Promise((resolve, reject) => {
        const steps = script.error ? [] : (script.progress || [100]);
        let i = 0;
        const tick = () => {
          if (script.error && i === 0) {
            const e = cleanError(script.error);
            this._downloadPromise = null;
            this.emit('error', e);
            reject(e);
            return;
          }
          if (i < steps.length) {
            const percent = steps[i++];
            this.emit('download-progress', { percent, bytesPerSecond: 1000000, total: 80000000, transferred: Math.round(800000 * percent), delta: 1 });
            H.clock.harnessTimeout(tick, script.stepMs || 1000);
            return;
          }
          this._downloadPromise = null;
          this.emit('update-downloaded', { ...info, downloadedFile: 'MemeDrop-Setup.exe' });
          resolve(['MemeDrop-Setup.exe']);
        };
        H.clock.harnessTimeout(tick, script.error ? (script.afterMs || 1000) : (script.stepMs || 1000));
      });
      return this._downloadPromise;
    }

    quitAndInstall(isSilent, isForceRunAfter) {
      H.rec('updater', 'quitAndInstall', [isSilent, isForceRunAfter]);
    }

    setFeedURL(opts) { H.rec('updater', 'setFeedURL', [opts]); }
    getFeedURL() { return null; }
    addAuthHeader(token) { H.rec('updater', 'addAuthHeader', ['<token>']); }
    isUpdaterActive() { return this._active(); }
  }

  const autoUpdater = new AppUpdater();
  H.autoUpdater = autoUpdater;
  return {
    autoUpdater,
    AppUpdater,
    NsisUpdater: AppUpdater,
    CancellationToken: class CancellationToken { cancel() {} },
    UpdaterSignal: class UpdaterSignal {},
  };
}

module.exports = { createUpdaterModule };
