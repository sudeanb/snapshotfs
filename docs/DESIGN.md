# SnapshotFS design

## Data model

Three object kinds, all content-addressed (sha256) in one store:

```
.snapshotfs/
  objects/<sha256>      blobs: file contents AND tree objects (JSON)
  snapshots/<id>.json   records: {id, time, label, root, files}
  journal               write-ahead intents (cleared on success)
```

A **tree object** is `{"files":[{"name","hash","size"}…],"dirs":{name:tree}}` —
serialized canonically (sorted keys) so identical directory states hash
identically. A snapshot's `root` is the hash of the top tree.

## Copy-on-write flow

`snapshot(dir)`:

1. journal `snapshot-begin`
2. hash every file → `putBlob` (unchanged files hit existing objects —
   this IS the copy-on-write: nothing is copied, identical content
   dedups to the same blob)
3. build trees bottom-up; tree objects are blobs too, so an unchanged
   subtree reuses the same tree blob across snapshots
4. write the record atomically, journal `snapshot-record`, clear journal

Cost of touching one file in a 10k-file tree: one file blob + the chain
of tree nodes from its directory to the root. Nothing else.

## Diff / status

`diff(idA, idB)` flattens both trees into `name → {hash,size}` maps and
buckets names into added / removed / modified (hash inequality).
`status(id, dir)` does the same against live files by hashing the work
tree — no snapshot taken.

## GC — mark and sweep

- **mark**: from every snapshot record's root tree, walk trees and mark
  every referenced hash (trees + file blobs)
- **sweep**: object files never marked; snapshot records whose JSON is
  corrupt or whose root blob is missing (crashed writes)
- `--dry-run` computes both sets without deleting

Deleting an old snapshot is what releases its exclusive blobs — history
is the retention policy. That is why "gc removes nothing while both
snapshots exist" is a TESTED behavior, not an accident.

## Crash safety

Every mutation follows write-ahead journaling:

```
journal(snapshot-begin) → mutate → journal(snapshot-record) → journal clear
```

Blob and record writes are **atomic** (temp file + rename in NodeFS), so
a crash can never leave a half-written object under its final name; the
worst case is "the operation did not happen". `fsck` proves that: it
finds a non-empty journal + temp leftovers, clears them, and runs a GC
pass for blobs the aborted snapshot had already written. The crash test
injects EIO mid-snapshot through a fault-injecting FS adapter and asserts
exactly this.

## The FUSE layer (documented interface)

The engine is intentionally OS-independent; the mount layer is the thin
OS-specific part. On Linux, a fuse3 binding would expose:

```
/mountpoint/          current working tree
/mountpoint/.snapshots/<id>/…   read-only views of any snapshot
```

Backed by `checkout` into an overlay dir + `status` for the live view.
It is deliberately not part of this repo's tested surface: shipping an
untested kernel-adjacent layer would break the "no fake code" rule —
the engine + CLI above are complete, tested, and portable (NodeFS on
Linux/macOS, MemoryFS in the browser playground).

## Known limits

- whole-file blobs (no chunking — dedup is per-file, like git without packs)
- no encryption at rest; the store is plain files
- GC is not concurrent-safe against a snapshot running at the same time
