/* FS adapters — the store and engine speak this tiny interface:
   join, exists, read, writeAtomic, append, list, remove, mkdirp, stat.
   NodeFS is the real one; MemoryFS powers the browser playground and
   the crash-injection tests. */

import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, mkdirSync, statSync, renameSync, unlinkSync, openSync, closeSync, utimesSync } from 'node:fs';

export class NodeFS {
  join(...parts) { return join(...parts); }
  exists(p) { return existsSync(p); }
  read(p) { return readFileSync(p); }
  list(p) { return readdirSync(p).sort(); }
  remove(p) { rmSync(p, { recursive: true, force: true }); }
  mkdirp(p) { mkdirSync(p, { recursive: true }); }
  append(p, bytes) { appendFileSync(p, bytes); }
  stat(p) {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
  }

  /* atomic write: temp file in the same directory + rename */
  writeAtomic(p, bytes) {
    mkdirp(dirname(p));
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const fd = openSync(tmp, 'w');
    writeFileSync(fd, bytes);
    closeSync(fd);
    try {
      renameSync(tmp, p);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  }
}

const mkdirp = (p) => mkdirSync(p, { recursive: true });

/* In-memory FS — also a fault-injection point for crash-safety tests. */
export class MemoryFS {
  constructor() {
    this.files = new Map();       // path → Buffer
  }

  join(...parts) { return join(...parts); }
  exists(p) { return this.files.has(p); }
  read(p) {
    if (!this.files.has(p)) throw new Error(`ENOENT: ${p}`);
    return Buffer.from(this.files.get(p));
  }
  list(p) {
    const prefix = p.endsWith('/') ? p : p + '/';
    return [...this.files.keys()]
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .map((f) => f.slice(prefix.length))
      .sort();
  }
  remove(p) {
    for (const f of [...this.files.keys()]) {
      if (f === p || f.startsWith(p.endsWith('/') ? p : p + '/')) this.files.delete(f);
    }
  }
  mkdirp() { /* directories are implicit */ }
  append(p, bytes) {
    this.files.set(p, this.files.has(p) ? Buffer.concat([this.files.get(p), bytes]) : Buffer.from(bytes));
  }
  stat(p) {
    const b = this.read(p);
    return { size: b.length, mtimeMs: 0, isDirectory: false };
  }
  writeAtomic(p, bytes) {
    this._writes = (this._writes ?? 0) + 1;
    if (this.failAfter !== null && this._writes > this.failAfter) {
      const err = new Error(`EIO: injected failure after ${this.failAfter} writes`);
      err.injected = true;
      throw err;
    }
    this.files.set(p, Buffer.from(bytes));
  }
}
