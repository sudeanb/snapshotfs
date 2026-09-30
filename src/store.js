/* Content-addressed blob store — the deduplication layer.
   Blobs are write-once, keyed by sha256, written atomically
   (tmp file + rename) so a crash never leaves a half-written object
   under its final name. The FS layer is an adapter: NodeFS in production,
   MemoryFS in the browser playground — same store code everywhere. */

import { createHash } from 'node:crypto';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* A tiny FS interface the store needs: join, exists, read, writeAtomic,
   list, remove, mkdirp. NodeFS implements it over node:fs; MemoryFS over
   a Map (playground). */
export class Store {
  constructor(fs, rootDir = '.snapshotfs') {
    this.fs = fs;
    this.root = rootDir;
    this.objectsDir = fs.join(rootDir, 'objects');
    this.snapsDir = fs.join(rootDir, 'snapshots');
  }

  init() {
    this.fs.mkdirp(this.objectsDir);
    this.fs.mkdirp(this.snapsDir);
  }

  initialized() {
    return this.fs.exists(this.objectsDir);
  }

  /* Write-once: if the blob exists, the write is skipped (dedup by construction). */
  putBlob(bytes) {
    const hash = sha256(bytes);
    const path = this.fs.join(this.objectsDir, hash);
    if (!this.fs.exists(path)) this.fs.writeAtomic(path, bytes);
    return hash;
  }

  hasBlob(hash) {
    return this.fs.exists(this.fs.join(this.objectsDir, hash));
  }

  getBlob(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad blob id: ${hash}`);
    return this.fs.read(this.fs.join(this.objectsDir, hash));
  }

  /* Garbage: every object file not reachable from a snapshot root. */
  listBlobs() {
    return this.fs.list(this.objectsDir).filter((f) => /^[0-9a-f]{64}$/.test(f));
  }

  blobPath(hash) {
    return this.fs.join(this.objectsDir, hash);
  }

  /* Snapshot records are JSON, also atomic. */
  putSnapshot(record) {
    const path = this.fs.join(this.snapsDir, `${record.id}.json`);
    this.fs.writeAtomic(path, Buffer.from(JSON.stringify(record, null, 1)));
    return record.id;
  }

  getSnapshot(id) {
    const path = this.fs.join(this.snapsDir, `${id}.json`);
    if (!this.fs.exists(path)) return null;
    return JSON.parse(this.fs.read(path).toString('utf8'));
  }

  listSnapshots() {
    if (!this.fs.exists(this.snapsDir)) return [];
    return this.fs.list(this.snapsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();                                  // ids are timestamp-prefixed → chronological
  }

  deleteSnapshot(id) {
    this.fs.remove(this.fs.join(this.snapsDir, `${id}.json`));
  }

  /* ---- journal (write-ahead intent, for crash safety) ---- */

  journalPath() {
    return this.fs.join(this.root, 'journal');
  }

  journalAppend(entry) {
    this.fs.append(this.journalPath(), Buffer.from(JSON.stringify(entry) + '\n'));
  }

  journalRead() {
    if (!this.fs.exists(this.journalPath())) return [];
    return this.fs.read(this.journalPath()).toString('utf8')
      .split('\n').filter((l) => l.trim() !== '')
      .map((l) => {
        try { return JSON.parse(l); } catch { return { op: 'corrupt', raw: l }; }
      });
  }

  journalClear() {
    if (this.fs.exists(this.journalPath())) this.fs.remove(this.journalPath());
  }
}
