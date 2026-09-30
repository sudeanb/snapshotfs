import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sha256 } from '../src/store.js';
import { NodeFS, MemoryFS } from '../src/fs.js';
import { snapshot, checkout, diff, diffTrees, status } from '../src/snapshot.js';
import { gc, fsck } from '../src/gc.js';

function tmpWorkdir() {
  return mkdtempSync(join(tmpdir(), 'snapfs-test-'));
}

function newStore(dir) {
  return new Store(new NodeFS(), join(dir, '.snapshotfs'));
}

test('store: blobs are content-addressed and deduplicated', () => {
  const root = tmpWorkdir();
  const store = newStore(root);
  store.init();
  const h1 = store.putBlob(Buffer.from('same content'));
  const h2 = store.putBlob(Buffer.from('same content'));
  const h3 = store.putBlob(Buffer.from('different'));
  assert.equal(h1, h2, 'same content → same blob');
  assert.notEqual(h1, h3);
  assert.equal(store.listBlobs().length, 2, 'only two physical objects');
  assert.deepEqual(store.getBlob(h1), Buffer.from('same content'));
  rmSync(root, { recursive: true, force: true });
});

test('store: getBlob rejects malformed ids', () => {
  const store = newStore(tmpWorkdir());
  store.init();
  assert.throws(() => store.getBlob('../etc/passwd'), /bad blob id/);
  assert.throws(() => store.getBlob('zz'), /bad blob id/);
});

test('snapshot: id is deterministic for identical content, records dedup', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'hello');
  const store = newStore(root);
  const s1 = snapshot(store, new NodeFS(), work, { label: 'one', time: 1700000000000 });
  const s2 = snapshot(store, new NodeFS(), work, { label: 'two', time: 1700000001000 });
  assert.equal(s1.root, s2.root, 'identical tree → same root hash');
  assert.equal(s1.reused, false);
  assert.equal(s2.reused, true, 'second snapshot shares the root — flagged reused');
  assert.equal(store.listSnapshots().length, 2);
  rmSync(root, { recursive: true, force: true });
});

test('snapshot: tree structure is preserved (nested dirs)', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(join(work, 'src', 'deep'), { recursive: true });
  writeFileSync(join(work, 'src', 'deep', 'x.js'), 'module.exports = 1;');
  writeFileSync(join(work, 'README.md'), 'readme');
  const store = newStore(root);
  const s = snapshot(store, new NodeFS(), work, { time: 1700000000000 });
  const out = join(root, 'out');
  checkout(store, new NodeFS(), s.id, out);
  assert.equal(readFileSync(join(out, 'src', 'deep', 'x.js'), 'utf8'), 'module.exports = 1;');
  assert.equal(readFileSync(join(out, 'README.md'), 'utf8'), 'readme');
  rmSync(root, { recursive: true, force: true });
});

test('COW: consecutive snapshots share unchanged blobs', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'big.txt'), 'x'.repeat(4096));
  writeFileSync(join(work, 'small.txt'), 'v1');
  const store = newStore(root);
  const fs = new NodeFS();
  const s1 = snapshot(store, fs, work, { time: 1 });
  const blobsAfter1 = store.listBlobs().length;
  writeFileSync(join(work, 'small.txt'), 'v2');       // touch ONE file
  const s2 = snapshot(store, fs, work, { time: 2 });
  const blobsAfter2 = store.listBlobs().length;
  assert.equal(blobsAfter2, blobsAfter1 + 2, 'one changed file costs a new blob + a new root tree');
  const d = diff(store, s1.id, s2.id);
  assert.deepEqual(d.modified.map((m) => m.name), ['small.txt']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  rmSync(root, { recursive: true, force: true });
});

test('diff: added, removed and modified are reported', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'keep.txt'), 'k');
  writeFileSync(join(work, 'gone.txt'), 'g');
  const store = newStore(root);
  const fs = new NodeFS();
  const s1 = snapshot(store, fs, work, { time: 1 });
  rmSync(join(work, 'gone.txt'));
  writeFileSync(join(work, 'new.txt'), 'n');
  writeFileSync(join(work, 'keep.txt'), 'k2');
  const s2 = snapshot(store, fs, work, { time: 2 });
  const d = diff(store, s1.id, s2.id);
  assert.deepEqual(d.added.map((x) => x.name), ['new.txt']);
  assert.deepEqual(d.removed.map((x) => x.name), ['gone.txt']);
  assert.deepEqual(d.modified.map((x) => x.name), ['keep.txt']);
  rmSync(root, { recursive: true, force: true });
});

test('status: working tree vs snapshot', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'same.txt'), 's');
  writeFileSync(join(work, 'edit.txt'), 'v1');
  const store = newStore(root);
  const fs = new NodeFS();
  const s = snapshot(store, fs, work, { time: 1 });
  writeFileSync(join(work, 'edit.txt'), 'v2');
  writeFileSync(join(work, 'extra.txt'), 'e');
  rmSync(join(work, 'same.txt'));
  const st = status(store, fs, s.id, work);
  assert.deepEqual(st.modified, ['edit.txt']);
  assert.deepEqual(st.added, ['extra.txt']);
  assert.deepEqual(st.removed, ['same.txt']);
  assert.deepEqual(st.unchanged, []);
  rmSync(root, { recursive: true, force: true });
});

test('checkout with prune: target becomes exactly the snapshot', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'a');
  const store = newStore(root);
  const fs = new NodeFS();
  const s = snapshot(store, fs, work, { time: 1 });
  writeFileSync(join(work, 'b.txt'), 'b');            // now only in the work tree
  const out = join(root, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'stale.txt'), 'old');
  checkout(store, fs, s.id, out, { prune: true });
  assert.ok(existsSync(join(out, 'a.txt')));
  assert.ok(!existsSync(join(out, 'stale.txt')), 'prune removes files not in the snapshot');
  assert.ok(!existsSync(join(out, 'b.txt')), 'work-tree-only files are not copied');
  rmSync(root, { recursive: true, force: true });
});

test('time travel: restore an old snapshot over an evolved tree', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  const store = newStore(root);
  const fs = new NodeFS();
  writeFileSync(join(work, 'doc.txt'), 'version 1');
  const s1 = snapshot(store, fs, work, { time: 1, label: 'v1' });
  writeFileSync(join(work, 'doc.txt'), 'version 2');
  const s2 = snapshot(store, fs, work, { time: 2, label: 'v2' });
  checkout(store, fs, s1.id, work, { prune: true });
  assert.equal(readFileSync(join(work, 'doc.txt'), 'utf8'), 'version 1', 'back to the past');
  checkout(store, fs, s2.id, work, { prune: true });
  assert.equal(readFileSync(join(work, 'doc.txt'), 'utf8'), 'version 2', 'and forward again');
  rmSync(root, { recursive: true, force: true });
});

test('gc: unreferenced blobs are swept, referenced ones stay', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  const store = newStore(root);
  const fs = new NodeFS();
  writeFileSync(join(work, 'f.txt'), 'one');
  const s1 = snapshot(store, fs, work, { time: 1 });
  writeFileSync(join(work, 'f.txt'), 'two');
  const s2 = snapshot(store, fs, work, { time: 2 });
  // while BOTH snapshots exist, the old blob is still history → not garbage
  assert.equal(gc(store).removed, 0, 'history keeps old blobs alive');
  store.deleteSnapshot(s1.id);                        // drop the old history…
  const report = gc(store);                           // …now s1's tree + blob are garbage
  assert.equal(report.removed, 2, 'old tree + old file blob die together');
  assert.ok(!store.hasBlob(report.garbage[0]));
  checkout(store, fs, s2.id, join(root, 'out'));
  assert.equal(readFileSync(join(root, 'out', 'f.txt'), 'utf8'), 'two');
  rmSync(root, { recursive: true, force: true });
});

test('gc dry-run removes nothing', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  const store = newStore(root);
  const fs = new NodeFS();
  writeFileSync(join(work, 'f.txt'), 'one');
  const s1 = snapshot(store, fs, work, { time: 1 });
  writeFileSync(join(work, 'f.txt'), 'two');
  snapshot(store, fs, work, { time: 2 });
  store.deleteSnapshot(s1.id);
  const before = store.listBlobs().length;
  const report = gc(store, { dryRun: true });
  assert.equal(report.removed, 2);
  assert.equal(store.listBlobs().length, before, 'dry run touches nothing');
  rmSync(root, { recursive: true, force: true });
});

test('crash safety: injected failure mid-snapshot leaves no record, fsck repairs', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'aaa');
  writeFileSync(join(work, 'b.txt'), 'bbb');
  const store = newStore(root);
  const fs = new NodeFS();

  const good = snapshot(store, fs, work, { time: 1, label: 'good' });

  // crash: allow only N atomic writes, then EIO
  const crashing = new MemoryFS();                     // separate crash sandbox
  const crashStore = new Store(crashing, '.snapshotfs');
  const good2 = snapshot(crashStore, crashing, work, { time: 1 });  // seed copy of the state
  crashing.failAfter = 2;                              // the FS turns EIO after 2 more writes
  assert.throws(() => snapshot(crashStore, crashing, work, { time: 2, label: 'doomed' }),
    /injected failure/);
  assert.equal(crashStore.journalRead().length > 0, true, 'journal shows the interrupted intent');

  const repaired = fsck(crashStore);
  assert.equal(repaired.clean, false);
  assert.ok(repaired.repairs.some((r) => r.what === 'journal'));
  assert.equal(crashStore.journalRead().length, 0, 'journal cleared after repair');
  assert.ok(crashStore.getSnapshot(good2.id), 'the earlier snapshot survives');

  // and the engine still works after the crash + repair
  crashing.failAfter = null;                           // "reboot": the fault is gone
  const after = snapshot(crashStore, crashing, work, { time: 3, label: 'post-crash' });
  assert.ok(after.id);
  rmSync(root, { recursive: true, force: true });
});

test('crash safety: atomic writes never expose partial blobs', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'x.txt'), 'data');
  const store = newStore(root);
  snapshot(store, new NodeFS(), work, { time: 1 });
  // every object in the store parses as a well-formed blob (no tmp leftovers under final names)
  for (const h of store.listBlobs()) {
    assert.equal(h, sha256(store.getBlob(h)), `object ${h} matches its own content hash`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('fsck on a healthy store is a no-op', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'a');
  const store = newStore(root);
  snapshot(store, new NodeFS(), work, { time: 1 });
  const report = fsck(store);
  assert.equal(report.clean, true);
  rmSync(root, { recursive: true, force: true });
});

test('MemoryFS adapter runs the same engine (browser parity)', () => {
  const mfs = new MemoryFS();
  mfs.writeAtomic('/proj/index.html', Buffer.from('<h1>hi</h1>'));
  mfs.writeAtomic('/proj/app.js', Buffer.from('console.log(1)'));
  const store = new Store(mfs, '/proj/.snapshotfs');
  const s1 = snapshot(store, mfs, '/proj', { time: 1 });
  mfs.writeAtomic('/proj/app.js', Buffer.from('console.log(2)'));
  const s2 = snapshot(store, mfs, '/proj', { time: 2 });
  const d = diff(store, s1.id, s2.id);
  assert.deepEqual(d.modified.map((m) => m.name), ['app.js']);
  checkout(store, mfs, s1.id, '/proj', { prune: true });
  assert.equal(mfs.read('/proj/app.js').toString(), 'console.log(1)');
});

test('large-ish tree: 200 files across nested dirs round-trip', () => {
  const root = tmpWorkdir();
  const work = join(root, 'work');
  for (let d = 0; d < 10; d++) {
    mkdirSync(join(work, `dir${d}`), { recursive: true });
    for (let f = 0; f < 20; f++) writeFileSync(join(work, `dir${d}`, `f${f}.txt`), `content ${d}/${f}`);
  }
  const store = newStore(root);
  const s = snapshot(store, new NodeFS(), work, { time: 1 });
  assert.equal(s.files, 200);
  const out = join(root, 'out');
  checkout(store, new NodeFS(), s.id, out);
  assert.equal(readFileSync(join(out, 'dir7', 'f13.txt'), 'utf8'), 'content 7/13');
  rmSync(root, { recursive: true, force: true });
});
