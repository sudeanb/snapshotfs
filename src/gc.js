/* Mark-and-sweep GC over the content-addressed store.
   Mark: every blob reachable from every snapshot record's root tree
   (trees reference subtrees + file blobs). Sweep: object files whose
   hash was never marked, plus orphan snapshot records (JSON without a
   parseable root, or snapshots from a crashed run). */

export function gc(store, { dryRun = false } = {}) {
  const marked = new Set();

  const markTree = (hash) => {
    if (marked.has(hash)) return;
    marked.add(hash);
    let tree;
    try { tree = JSON.parse(store.getBlob(hash).toString('utf8')); }
    catch { return; }                    // not a tree (a plain file blob) — already marked
    for (const f of tree.files ?? []) marked.add(f.hash);
    for (const sub of Object.values(tree.dirs ?? {})) markTree(sub.hash);
  };

  const orphans = [];
  for (const id of store.listSnapshots()) {
    let rec;
    try { rec = store.getSnapshot(id); } catch { orphans.push({ kind: 'snapshot', id }); continue; }
    if (!rec || !/^[0-9a-f]{64}$/.test(rec.root ?? '')) { orphans.push({ kind: 'snapshot', id }); continue; }
    if (!store.hasBlob(rec.root)) { orphans.push({ kind: 'snapshot', id }); continue; }
    markTree(rec.root);
  }

  const garbage = store.listBlobs().filter((h) => !marked.has(h));
  let freedBytes = 0;
  if (!dryRun) {
    for (const h of garbage) {
      freedBytes += store.getBlob(h).length;
      store.fs.remove(store.blobPath(h));
    }
    for (const o of orphans) store.deleteSnapshot(o.id);
  } else {
    for (const h of garbage) freedBytes += store.getBlob(h).length;
  }

  return {
    scanned: store.listBlobs().length + garbage.length,
    kept: marked.size,
    removed: dryRun ? garbage.length : garbage.length,
    removedSnapshots: orphans.length,
    freedBytes,
    dryRun,
    garbage,
    orphans,
  };
}

/* fsck: detect + repair the aftermath of a crash.
   A crashed mutation leaves (a) a non-empty journal and (b) possibly temp
   files. Both are safe to clear: blobs are content-addressed (a half
   write can't exist under a final name — writeAtomic renames), snapshot
   records are written atomically, so the worst case is "the operation
   simply didn't happen", which the journal confirms. */
export function fsck(store) {
  const journal = store.journalRead();
  const tempFiles = store.fs.list(store.fs.join(store.root))
    .filter((f) => f.startsWith('objects') === false)
    .filter((f) => f.includes('.tmp-'));

  const repairs = [];
  if (journal.length > 0) {
    repairs.push({ what: 'journal', detail: `${journal.length} dangling intent(s) cleared`, entries: journal.map((j) => j.op) });
    store.journalClear();
  }
  for (const t of tempFiles) {
    store.fs.remove(store.fs.join(store.root, t));
    repairs.push({ what: 'temp-file', detail: t });
  }
  const g = gc(store, { dryRun: true });
  if (g.garbage.length || g.orphans.length) {
    gc(store);
    repairs.push({ what: 'gc', detail: `${g.garbage.length} blob(s), ${g.orphans.length} snapshot(s)` });
  }
  return { clean: repairs.length === 0, repairs, journalEntries: journal.length };
}
