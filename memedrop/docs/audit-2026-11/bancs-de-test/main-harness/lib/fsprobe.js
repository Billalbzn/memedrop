'use strict';
// Disk-access probe. Wraps the public `fs` / `fs.promises` API and counts
// every operation that touches the app's userData directory (where the
// electron-store file lives), whatever library performs it. Counting at the
// fs level keeps the metric meaningful even if the optimized code replaces
// electron-store or adds its own caching/debouncing on top of it.
//
// Counter kinds:
//   read    file content reads (readFile*, read on a tracked fd, read streams)
//   write   file content writes (writeFile*, appendFile*, write on a tracked fd)
//   open/close/fsync/rename/mkdir/stat/unlink/readdir/other  other syscalls
// `pendingAsync` lets the harness wait for in-flight async fs work.

const fs = require('fs');
const path = require('path');

const ORIG = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  rmSync: fs.rmSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
};

const KINDS = ['read', 'write', 'open', 'close', 'fsync', 'rename', 'mkdir', 'stat', 'unlink', 'readdir', 'other'];
function zero() { const o = {}; for (const k of KINDS) o[k] = 0; return o; }

class FsProbe {
  constructor() {
    this.roots = [];
    this.total = zero();
    this.step = zero();
    this.fds = new Set();
    this.handles = new WeakSet();
    this.pendingAsync = 0;
    this.installed = false;
  }

  addRoot(dir) { this.roots.push(path.resolve(dir)); }

  resetStep() { const s = this.step; this.step = zero(); return s; }

  tracked(p) {
    if (p == null) return false;
    let s;
    if (typeof p === 'string') s = p;
    else if (Buffer.isBuffer(p)) s = p.toString();
    else if (p instanceof URL) { if (p.protocol !== 'file:') return false; s = decodeURIComponent(p.pathname); }
    else return false;
    const abs = path.resolve(s);
    return this.roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  }

  count(kind) { this.total[kind]++; this.step[kind]++; }

  install() {
    if (this.installed) return;
    this.installed = true;
    const probe = this;

    const byPath = (name, kind, opts = {}) => {
      const orig = fs[name];
      if (typeof orig !== 'function') return;
      fs[name] = function (...args) {
        const hit = probe.tracked(args[0]) || (opts.second && probe.tracked(args[1]));
        if (hit) probe.count(kind);
        const r = orig.apply(this, args);
        if (hit && opts.fdResult && typeof r === 'number') probe.fds.add(r);
        return r;
      };
      if (orig.native) fs[name].native = orig.native;
    };
    const byFd = (name, kind, opts = {}) => {
      const orig = fs[name];
      if (typeof orig !== 'function') return;
      fs[name] = function (fd, ...rest) {
        const hit = probe.fds.has(fd);
        if (hit) probe.count(kind);
        const r = orig.call(this, fd, ...rest);
        if (hit && opts.release) probe.fds.delete(fd);
        return r;
      };
    };
    // callback-style async: count at call time, track completion
    const asyncByPath = (name, kind, opts = {}) => {
      const orig = fs[name];
      if (typeof orig !== 'function') return;
      const wrapped = function (...args) {
        const hit = probe.tracked(args[0]) || (opts.second && probe.tracked(args[1]));
        const cbIdx = args.length - 1;
        if (!hit || typeof args[cbIdx] !== 'function') return orig.apply(this, args);
        probe.count(kind);
        probe.pendingAsync++;
        const cb = args[cbIdx];
        args[cbIdx] = function (err, res, ...more) {
          probe.pendingAsync--;
          if (!err && opts.fdResult && typeof res === 'number') probe.fds.add(res);
          return cb.call(this, err, res, ...more);
        };
        return orig.apply(this, args);
      };
      if (orig.native) wrapped.native = orig.native;
      if (orig[require('util').promisify.custom]) wrapped[require('util').promisify.custom] = orig[require('util').promisify.custom];
      fs[name] = wrapped;
    };
    const asyncByFd = (name, kind, opts = {}) => {
      const orig = fs[name];
      if (typeof orig !== 'function') return;
      fs[name] = function (fd, ...args) {
        const hit = probe.fds.has(fd);
        const cbIdx = args.length - 1;
        if (!hit || typeof args[cbIdx] !== 'function') return orig.call(this, fd, ...args);
        probe.count(kind);
        probe.pendingAsync++;
        const cb = args[cbIdx];
        args[cbIdx] = function (...r) {
          probe.pendingAsync--;
          if (opts.release) probe.fds.delete(fd);
          return cb.apply(this, r);
        };
        return orig.call(this, fd, ...args);
      };
    };

    // ---- sync, by path
    byPath('readFileSync', 'read');
    byPath('writeFileSync', 'write');
    byPath('appendFileSync', 'write');
    byPath('openSync', 'open', { fdResult: true });
    byPath('renameSync', 'rename', { second: true });
    byPath('mkdirSync', 'mkdir');
    for (const n of ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync']) byPath(n, 'stat');
    for (const n of ['unlinkSync', 'rmSync', 'rmdirSync']) byPath(n, 'unlink');
    byPath('readdirSync', 'readdir');
    for (const n of ['copyFileSync', 'cpSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync', 'symlinkSync', 'linkSync', 'mkdtempSync']) byPath(n, 'other', { second: true });
    // ---- sync, by fd
    byFd('readSync', 'read');
    byFd('writeSync', 'write');
    byFd('writevSync', 'write');
    byFd('fsyncSync', 'fsync');
    byFd('fdatasyncSync', 'fsync');
    byFd('closeSync', 'close', { release: true });
    byFd('fstatSync', 'stat');
    byFd('ftruncateSync', 'other');
    // ---- async callback, by path
    asyncByPath('readFile', 'read');
    asyncByPath('writeFile', 'write');
    asyncByPath('appendFile', 'write');
    asyncByPath('open', 'open', { fdResult: true });
    asyncByPath('rename', 'rename', { second: true });
    asyncByPath('mkdir', 'mkdir');
    for (const n of ['stat', 'lstat', 'access', 'realpath', 'exists']) asyncByPath(n, 'stat');
    for (const n of ['unlink', 'rm', 'rmdir']) asyncByPath(n, 'unlink');
    asyncByPath('readdir', 'readdir');
    for (const n of ['copyFile', 'cp', 'truncate', 'chmod', 'chown', 'utimes']) asyncByPath(n, 'other', { second: true });
    // ---- async callback, by fd
    asyncByFd('read', 'read');
    asyncByFd('write', 'write');
    asyncByFd('writev', 'write');
    asyncByFd('fsync', 'fsync');
    asyncByFd('fdatasync', 'fsync');
    asyncByFd('close', 'close', { release: true });
    asyncByFd('fstat', 'stat');

    // ---- streams
    for (const [n, kind] of [['createReadStream', 'read'], ['createWriteStream', 'write']]) {
      const orig = fs[n];
      fs[n] = function (p, ...rest) {
        if (probe.tracked(p)) { probe.count('open'); probe.count(kind); }
        return orig.call(this, p, ...rest);
      };
    }

    // ---- promises
    const P = fs.promises;
    const promByPath = (name, kind, opts = {}) => {
      const orig = P[name];
      if (typeof orig !== 'function') return;
      P[name] = function (...args) {
        const hit = probe.tracked(args[0]) || (opts.second && probe.tracked(args[1]));
        if (!hit) return orig.apply(this, args);
        probe.count(kind);
        probe.pendingAsync++;
        let p;
        try { p = orig.apply(this, args); } catch (e) { probe.pendingAsync--; throw e; }
        return p.then((r) => {
          probe.pendingAsync--;
          if (opts.handle && r && typeof r === 'object') probe.wrapHandle(r);
          return r;
        }, (e) => { probe.pendingAsync--; throw e; });
      };
    };
    promByPath('readFile', 'read');
    promByPath('writeFile', 'write');
    promByPath('appendFile', 'write');
    promByPath('open', 'open', { handle: true });
    promByPath('rename', 'rename', { second: true });
    promByPath('mkdir', 'mkdir');
    for (const n of ['stat', 'lstat', 'access', 'realpath']) promByPath(n, 'stat');
    for (const n of ['unlink', 'rm', 'rmdir']) promByPath(n, 'unlink');
    promByPath('readdir', 'readdir');
    for (const n of ['copyFile', 'cp', 'truncate', 'chmod', 'chown', 'utimes']) promByPath(n, 'other', { second: true });
  }

  // FileHandle from fs.promises.open on a tracked path: count its operations.
  wrapHandle(h) {
    const probe = this;
    const map = { read: 'read', readFile: 'read', write: 'write', writeFile: 'write', appendFile: 'write', writev: 'write', sync: 'fsync', datasync: 'fsync', close: 'close', stat: 'stat', truncate: 'other' };
    for (const [m, kind] of Object.entries(map)) {
      const orig = h[m];
      if (typeof orig !== 'function') continue;
      h[m] = function (...args) {
        probe.count(kind);
        probe.pendingAsync++;
        return orig.apply(h, args).then((r) => { probe.pendingAsync--; return r; }, (e) => { probe.pendingAsync--; throw e; });
      };
    }
  }
}

module.exports = { FsProbe, ORIG, KINDS, zero };
