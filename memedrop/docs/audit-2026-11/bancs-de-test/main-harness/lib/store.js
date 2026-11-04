'use strict';
// Stand-in for electron-store@8.2.0 on top of conf@10.2.0 (+ dot-prop@6 and
// atomically@1.7), the versions pinned by overlay/package-lock.json.
//
// Semantics reproduced on purpose (they drive the disk-access metrics):
//   * every read of `.store` re-reads and JSON-parses the whole file:
//     get(), has(), size, iteration and the first half of set()/delete();
//   * every set()/delete()/`.store =` rewrites the whole file through an
//     atomic write (mkdir parent, open temp, write, fsync, close, rename —
//     the win32 code path of atomically, no stat/chown);
//   * defaults are merged into the file once, in the constructor, and only
//     written when the file lacks a key (assert.deepEqual, loose);
//   * get() never consults defaults afterwards (a deleted key reads as
//     undefined); clear() resets only keys whose default is not null;
//   * set(key, undefined) throws "Use `delete()` to clear values",
//     set({k: undefined}) throws the JSON type error before writing;
//   * clearInvalidConfig defaults to false: a corrupt file makes the
//     constructor throw the SyntaxError.
// All I/O goes through the public fs API, so the fs probe counts it.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');
const { isDeepStrictEqual } = require('util');

const INTERNAL_KEY = '__internal__';
const createPlainObject = () => Object.create(null);
const isExist = (d) => d !== undefined && d !== null;
const isObj = (v) => { const t = typeof v; return v !== null && (t === 'object' || t === 'function'); };

// ---- dot-prop@6 -----------------------------------------------------------
const disallowedKeys = new Set(['__proto__', 'prototype', 'constructor']);
function getPathSegments(p) {
  const pathArray = p.split('.');
  const parts = [];
  for (let i = 0; i < pathArray.length; i++) {
    let s = pathArray[i];
    while (s[s.length - 1] === '\\' && pathArray[i + 1] !== undefined) {
      s = s.slice(0, -1) + '.';
      s += pathArray[++i];
    }
    parts.push(s);
  }
  if (parts.some((s) => disallowedKeys.has(s))) return [];
  return parts;
}
const dotProp = {
  get(object, p, value) {
    if (!isObj(object) || typeof p !== 'string') return value === undefined ? object : value;
    const pathArray = getPathSegments(p);
    if (pathArray.length === 0) return undefined;
    for (let i = 0; i < pathArray.length; i++) {
      object = object[pathArray[i]];
      if (object === undefined || object === null) {
        if (i !== pathArray.length - 1) return value;
        break;
      }
    }
    return object === undefined ? value : object;
  },
  set(object, p, value) {
    if (!isObj(object) || typeof p !== 'string') return object;
    const root = object;
    const pathArray = getPathSegments(p);
    for (let i = 0; i < pathArray.length; i++) {
      const s = pathArray[i];
      if (!isObj(object[s])) object[s] = {};
      if (i === pathArray.length - 1) object[s] = value;
      object = object[s];
    }
    return root;
  },
  delete(object, p) {
    if (!isObj(object) || typeof p !== 'string') return false;
    const pathArray = getPathSegments(p);
    for (let i = 0; i < pathArray.length; i++) {
      const s = pathArray[i];
      if (i === pathArray.length - 1) { delete object[s]; return true; }
      object = object[s];
      if (!isObj(object)) return false;
    }
    return false;
  },
  has(object, p) {
    if (!isObj(object) || typeof p !== 'string') return false;
    const pathArray = getPathSegments(p);
    if (pathArray.length === 0) return false;
    for (let i = 0; i < pathArray.length; i++) {
      if (isObj(object)) {
        if (!(pathArray[i] in object)) return false;
        object = object[pathArray[i]];
      } else {
        return false;
      }
    }
    return true;
  },
};

const checkValueType = (key, value) => {
  const nonJsonTypes = new Set(['undefined', 'symbol', 'function']);
  const type = typeof value;
  if (nonJsonTypes.has(type)) {
    throw new TypeError(`Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`);
  }
};

function createStoreModule(H) {
  let isInitialized = false;
  let tmpCounter = 0;

  // atomically.writeFileSync, win32 path (IS_POSIX false: no stat/chown;
  // mode 0o666 equals the default: no chmod).
  function atomicWriteFileSync(filePath, data, mode) {
    let real = null;
    try { real = fs.realpathSync(filePath); } catch {}
    filePath = real || filePath;
    const tempPath = `${filePath}.tmp-${String(++tmpCounter).padStart(10, '0')}000000`;
    try { fs.mkdirSync(path.dirname(filePath), { mode: 0o777, recursive: true }); } catch {}
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'w', mode || 0o666);
      fs.writeSync(fd, data, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, filePath);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
    }
  }

  function initDataListener() {
    const { app, ipcMain } = H.electronMain;
    if (!ipcMain || !app) throw new Error('Electron Store: You need to call `.initRenderer()` from the main process.');
    const appData = { defaultCwd: app.getPath('userData'), appVersion: app.getVersion() };
    if (isInitialized) return appData;
    ipcMain.on('electron-store-get-data', (event) => { event.returnValue = appData; });
    isInitialized = true;
    return appData;
  }

  class Conf {
    #options;
    #defaultValues = {};
    #encryptionKey;
    _deserialize = (value) => JSON.parse(value);
    _serialize = (value) => JSON.stringify(value, undefined, '\t');

    constructor(partialOptions = {}) {
      const options = {
        configName: 'config',
        fileExtension: 'json',
        projectSuffix: 'nodejs',
        clearInvalidConfig: false,
        accessPropertiesByDotNotation: true,
        configFileMode: 0o666,
        ...partialOptions,
      };
      if (!options.cwd) {
        if (!options.projectName) throw new Error('Please specify the `projectName` option.');
        options.cwd = path.join(H.electronMain.app.getPath('appData'), `${options.projectName}-${options.projectSuffix}`);
      }
      this.#options = options;
      for (const k of ['schema', 'migrations', 'watch', 'encryptionKey']) {
        if (options[k]) H.note(`electron-store option "${k}" used by the code under test is not emulated`);
      }
      if (options.defaults) this.#defaultValues = { ...this.#defaultValues, ...options.defaults };
      if (options.serialize) this._serialize = options.serialize;
      if (options.deserialize) this._deserialize = options.deserialize;
      this.events = new EventEmitter();
      this.#encryptionKey = options.encryptionKey;
      const fileExtension = options.fileExtension ? `.${options.fileExtension}` : '';
      this.path = path.resolve(options.cwd, `${options.configName ?? 'config'}${fileExtension}`);
      const fileStore = this.store;
      const store = Object.assign(createPlainObject(), options.defaults, fileStore);
      try {
        assert.deepEqual(fileStore, store);
      } catch {
        this.store = store;
      }
    }

    get(key, defaultValue) {
      if (this.#options.accessPropertiesByDotNotation) return this._get(key, defaultValue);
      const { store } = this;
      return key in store ? store[key] : defaultValue;
    }

    set(key, value) {
      if (typeof key !== 'string' && typeof key !== 'object') {
        throw new TypeError(`Expected \`key\` to be of type \`string\` or \`object\`, got ${typeof key}`);
      }
      if (typeof key !== 'object' && value === undefined) throw new TypeError('Use `delete()` to clear values');
      if (this._containsReservedKey(key)) {
        throw new TypeError(`Please don't use the ${INTERNAL_KEY} key, as it's used to manage this module internal operations.`);
      }
      const { store } = this;
      const set = (k, v) => {
        checkValueType(k, v);
        if (this.#options.accessPropertiesByDotNotation) dotProp.set(store, k, v);
        else store[k] = v;
      };
      if (typeof key === 'object') {
        for (const [k, v] of Object.entries(key)) set(k, v);
      } else {
        set(key, value);
      }
      this.store = store;
    }

    has(key) {
      if (this.#options.accessPropertiesByDotNotation) return dotProp.has(this.store, key);
      return key in this.store;
    }

    reset(...keys) {
      for (const key of keys) {
        if (isExist(this.#defaultValues[key])) this.set(key, this.#defaultValues[key]);
      }
    }

    delete(key) {
      const { store } = this;
      if (this.#options.accessPropertiesByDotNotation) dotProp.delete(store, key);
      else delete store[key];
      this.store = store;
    }

    clear() {
      this.store = createPlainObject();
      for (const key of Object.keys(this.#defaultValues)) this.reset(key);
    }

    onDidChange(key, callback) {
      if (typeof key !== 'string') throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
      if (typeof callback !== 'function') throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
      return this._handleChange(() => this.get(key), callback);
    }

    onDidAnyChange(callback) {
      if (typeof callback !== 'function') throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
      return this._handleChange(() => this.store, callback);
    }

    get size() { return Object.keys(this.store).length; }

    get store() {
      try {
        const data = fs.readFileSync(this.path, this.#encryptionKey ? null : 'utf8');
        const deserialized = this._deserialize(typeof data === 'string' ? data : data.toString());
        return Object.assign(createPlainObject(), deserialized);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          this._ensureDirectory();
          return createPlainObject();
        }
        if (this.#options.clearInvalidConfig && error && error.name === 'SyntaxError') return createPlainObject();
        throw error;
      }
    }

    set store(value) {
      this._ensureDirectory();
      this._write(value);
      this.events.emit('change');
    }

    * [Symbol.iterator]() {
      for (const [key, value] of Object.entries(this.store)) yield [key, value];
    }

    _handleChange(getter, callback) {
      let currentValue = getter();
      const onChange = () => {
        const oldValue = currentValue;
        const newValue = getter();
        if (isDeepStrictEqual(newValue, oldValue)) return;
        currentValue = newValue;
        callback.call(this, newValue, oldValue);
      };
      this.events.on('change', onChange);
      return () => this.events.removeListener('change', onChange);
    }

    _ensureDirectory() { fs.mkdirSync(path.dirname(this.path), { recursive: true }); }

    _write(value) {
      const data = this._serialize(value);
      if (process.env.SNAP) {
        fs.writeFileSync(this.path, data, { mode: this.#options.configFileMode });
        return;
      }
      atomicWriteFileSync(this.path, data, this.#options.configFileMode);
    }

    _containsReservedKey(key) {
      if (typeof key === 'object') {
        const firstKey = Object.keys(key)[0];
        if (firstKey === INTERNAL_KEY) return true;
      }
      if (typeof key !== 'string') return false;
      if (this.#options.accessPropertiesByDotNotation) return key.startsWith(`${INTERNAL_KEY}.`);
      return false;
    }

    _get(key, defaultValue) { return dotProp.get(this.store, key, defaultValue); }
  }

  class ElectronStore extends Conf {
    constructor(options) {
      let defaultCwd;
      let appVersion;
      const { app, ipcMain } = H.electronMain;
      if (ipcMain && app) ({ defaultCwd, appVersion } = initDataListener());
      options = { name: 'config', ...options };
      if (!options.projectVersion) options.projectVersion = appVersion;
      if (options.cwd) options.cwd = path.isAbsolute(options.cwd) ? options.cwd : path.join(defaultCwd, options.cwd);
      else options.cwd = defaultCwd;
      options.configName = options.name;
      delete options.name;
      super(options);
      H.storeInstances.push(this);
    }
    static initRenderer() { initDataListener(); }
    async openInEditor() {
      const error = await H.electronMain.shell.openPath(this.path);
      if (error) throw new Error(error);
    }
  }

  return ElectronStore;
}

module.exports = { createStoreModule, dotProp };
