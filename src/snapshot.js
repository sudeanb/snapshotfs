/* Snapshot engine — copy-on-write over the content-addressed store.
   A snapshot hashes every file's CONTENT (blobs) plus a directory TREE
   object; unchanged files hash identically, so consecutive snapshots
   share almost everything (dedup is the COW mechanism, not a copy step).
   Every mutation is journaled before it happens and the journal is
   cleared on success — an interrupted run leaves a detectable trail. */

import { join, relative, sep } from 'node:path';
import { sha256 } from './store.js';

const DEFAULT_IGNORES = ['.snapshotfs'];   // never snapshot the store itself

function walk(fs, dir, base, out = [], ignores = DEFAULT_IGNORES) {
  for (const name of fs.list(dir).sort()) {
    if (ignores.includes(name)) continue;
    const full = join(dir, name);
    const st = fs.stat(full);
    if (st.isDirectory) walk(fs, full, base, out, ignores);
    else out.push({ rel: relative(base, full).split(sep).join('/'), full });
  }
  return out;
}

export function snapshot(store, fs, dir, { label = '', time = null } = {}) {
  if (!store.initialized()) store.init();
  const files = walk(fs, dir, dir);
  const journalId = `snapshot:${time ?? 'auto'}:${label}`;

  store.journalAppend({ op: 'snapshot-begin', id: journalId, dir, files: files.length });
  try {
    // 1. blobs (content-addressed; identical content → identical id)
    const entries = files.map((f) => {
      const bytes = fs.read(f.full);
      const hash = store.putBlob(bytes);
      return { name: f.rel, hash, size: bytes.length };
    });

    // 2. trees, bottom-up: {files:[…], dirs:[…]} objects are blobs too
    const buildTree = (prefix) => {
      const node = { files: [], dirs: {} };
      for (const e of entries) {
        if (!e.name.startsWith(prefix)) continue;
        const rest = e.name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) node.files.push({ name: rest, hash: e.hash, size: e.size });
        else {
          const dirName = rest.slice(0, slash);
          if (!node.dirs[dirName]) node.dirs[dirName] = buildTree(prefix + dirName + '/');
        }
      }
      node.dirs = Object.fromEntries(Object.entries(node.dirs).sort(([a], [b]) => a < b ? -1 : 1));
      const canonical = JSON.stringify(node);
      return { node, hash: store.putBlob(Buffer.from(canonical)) };
    };
    const root = buildTree('');

    // 3. the snapshot record (chronological id: <unix-ms>-<roothash8>)
    const ms = time ?? Date.now();
    const id = `${String(ms).padStart(15, '0')}-${root.hash.slice(0, 8)}`;
    const reused = store.listSnapshots().some((sid) => store.getSnapshot(sid)?.root === root.hash);
    if (store.getSnapshot(id)) {
      store.journalClear();
      return { id, root: root.hash, files: entries.length, reused: true };
    }
    store.journalAppend({ op: 'snapshot-record', id });
    store.putSnapshot({ id, time: ms, label, root: root.hash, files: entries });
    store.journalClear();
    return { id, root: root.hash, files: entries.length, reused };
  } catch (err) {
    if (!err.injected) store.journalClear();
    throw err;
  }
}

/* Materialize a snapshot's tree under targetDir (created if needed).
   prune=true makes the target EXACTLY the snapshot (removes extras). */
export function checkout(store, fs, id, targetDir, { prune = false } = {}) {
  const snap = store.getSnapshot(id);
  if (!snap) throw new Error(`unknown snapshot: ${id}`);
  store.journalAppend({ op: 'checkout', id, target: targetDir });
  try {
    let restored = 0, removed = 0;
    const writeTree = (treeHash, prefix) => {
      const tree = JSON.parse(store.getBlob(treeHash).toString('utf8'));
      fs.mkdirp(prefix);
      for (const f of tree.files) {
        const p = fs.join(prefix, f.name);
        fs.writeAtomic(p, store.getBlob(f.hash));
        restored++;
      }
      for (const [name, sub] of Object.entries(tree.dirs)) {
        writeTree(sub.hash, fs.join(prefix, name));
      }
    };
    fs.mkdirp(targetDir);
    writeTree(snap.root, targetDir);
    if (prune) {
      const keep = new Set(collectPaths(store, snap.root, ''));
      for (const rel of walk(fs, targetDir, targetDir).map((f) => f.rel)) {
        if (!keep.has(rel)) { fs.remove(fs.join(targetDir, rel)); removed++; }
      }
    }
    store.journalClear();
    return { restored, removed };
  } catch (err) {
    if (!err.injected) store.journalClear();
    throw err;
  }
}

function collectPaths(store, treeHash, prefix, out = []) {
  const tree = JSON.parse(store.getBlob(treeHash).toString('utf8'));
  for (const f of tree.files) out.push(prefix + f.name);
  for (const [name, sub] of Object.entries(tree.dirs)) collectPaths(store, sub.hash, prefix + name + '/', out);
  return out;
}

/* Tree diff: added / removed / modified between two snapshot roots. */
export function diffTrees(store, rootA, rootB) {
  const flat = (hash, prefix = '', out = {}) => {
    const tree = JSON.parse(store.getBlob(hash).toString('utf8'));
    for (const f of tree.files) out[prefix + f.name] = f;
    for (const [name, sub] of Object.entries(tree.dirs)) flat(sub.hash, prefix + name + '/', out);
    return out;
  };
  const a = flat(rootA), b = flat(rootB);
  const added = [], removed = [], modified = [];
  for (const name of Object.keys(b)) {
    if (!(name in a)) added.push({ name, size: b[name].size });
    else if (a[name].hash !== b[name].hash) {
      modified.push({ name, oldSize: a[name].size, newSize: b[name].size, oldHash: a[name].hash, newHash: b[name].hash });
    }
  }
  for (const name of Object.keys(a)) {
    if (!(name in b)) removed.push({ name, size: a[name].size });
  }
  return {
    added: added.sort((x, y) => x.name < y.name ? -1 : 1),
    removed: removed.sort((x, y) => x.name < y.name ? -1 : 1),
    modified: modified.sort((x, y) => x.name < y.name ? -1 : 1),
  };
}

export function diff(store, idA, idB) {
  const a = store.getSnapshot(idA);
  const b = store.getSnapshot(idB);
  if (!a || !b) throw new Error('unknown snapshot id');
  return diffTrees(store, a.root, b.root);
}

/* Working-tree status vs a snapshot: same three buckets, computed from
   live file hashes (no snapshot taken). */
export function status(store, fs, id, dir) {
  const snap = store.getSnapshot(id);
  if (!snap) throw new Error(`unknown snapshot: ${id}`);
  const baseline = {};
  const flat = (hash, prefix = '') => {
    const tree = JSON.parse(store.getBlob(hash).toString('utf8'));
    for (const f of tree.files) baseline[prefix + f.name] = f.hash;
    for (const [name, sub] of Object.entries(tree.dirs)) flat(sub.hash, prefix + name + '/');
  };
  flat(snap.root);
  const now = {};
  for (const f of walk(fs, dir, dir)) {
    now[f.rel] = sha256(fs.read(f.full));
  }
  const modified = [], added = [], removed = [], unchanged = [];
  for (const [name, hash] of Object.entries(now)) {
    if (!(name in baseline)) added.push(name);
    else if (baseline[name] !== hash) modified.push(name);
    else unchanged.push(name);
  }
  for (const name of Object.keys(baseline)) if (!(name in now)) removed.push(name);
  return { modified: modified.sort(), added: added.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}
