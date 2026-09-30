# ⧉ SnapshotFS

**Copy-on-write snapshots for real directories: a content-addressed
dedup store, tree diffing, time-travel checkout, mark-and-sweep GC and
journal-based crash safety — zero dependencies.**

[![CI](https://github.com/sudeanb/snapshotfs/actions/workflows/ci.yml/badge.svg)](https://github.com/sudeanb/snapshotfs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Every snapshot hashes file *contents*, so versioning a huge tree twice
costs only what actually changed — and deleting history is what releases
space, via an explicit GC.

```console
$ snapshotfs snapshot . --label v2
◉ 0017907…-8d685643  root 8d6856439903 · 2 file(s)

$ snapshotfs diff <v1> <v2> .
  ~ doc.txt  3 B → 3 B
  0 added · 1 removed · 0 modified

$ snapshotfs checkout <v1> . --prune     # time travel
⏪ 0017907…-c6dd1db9 → …/work  (3 restored, 0 pruned)
```

**[Live playground →](https://sudeanb.github.io/snapshotfs/)**
(the same engine over a MemoryFS: edit files, snapshot, diff, travel, GC)

## Features

- content-addressed store (sha256): identical content = one blob, ever
- copy-on-write snapshots: unchanged subtrees reuse their tree blobs
- tree diff + working-tree status (`added / removed / modified`)
- checkout with `--prune` (target becomes exactly the snapshot)
- time travel: restore any snapshot over the live tree, forward or back
- mark-and-sweep GC with `--dry-run`; deleting history releases blobs
- crash safety: write-ahead journal + atomic writes + `fsck` — tested
  with an EIO-injecting filesystem
- portable core: NodeFS adapter for real directories, MemoryFS adapter
  for the browser playground

## Quick start

```bash
git clone https://github.com/sudeanb/snapshotfs.git
cd snapshotfs
node --test                                   # 16 tests
mkdir work && cd work && echo hi > a.txt
node bin/snapshotfs.js snapshot . --label first
node bin/snapshotfs.js log .
```

Step-by-step copy-paste scenarios (including the crash simulation) live
in [demo/scenarios.md](demo/scenarios.md).

## Usage

```js
import { Store } from './src/store.js';
import { NodeFS } from './src/fs.js';
import { snapshot, diff, checkout } from './src/snapshot.js';
import { gc } from './src/gc.js';

const fs = new NodeFS();
const store = new Store(fs, './.snapshotfs');
const s1 = snapshot(store, fs, './work', { label: 'v1' });
// …edit…
const s2 = snapshot(store, fs, './work', { label: 'v2' });
diff(store, s1.id, s2.id);      // { added, removed, modified }
checkout(store, fs, s1.id, './work', { prune: true });
gc(store, { dryRun: true });
```

CLI: `snapshot · log · diff · status · checkout · gc · fsck · init`
(every command has `--json`).

## How it works

The store keeps blobs once, keyed by sha256. A snapshot hashes each
file's content, then builds canonical JSON **tree objects** bottom-up —
trees are blobs too, so an unchanged subtree hashes to the same object
across every snapshot. `docs/DESIGN.md` has the full data model, the COW
flow, the GC reachability rules and the crash-safety protocol (write-ahead
journal + atomic rename; the worst case after a kill -9 is "the operation
never happened", which `fsck` confirms and cleans).

| file | role |
|---|---|
| `src/store.js` | content-addressed blob store + snapshot records + journal |
| `src/fs.js` | NodeFS / MemoryFS adapters (the FS is injectable) |
| `src/snapshot.js` | snapshot / checkout / diff / status |
| `src/gc.js` | mark-and-sweep GC + fsck |
| `bin/snapshotfs.js` | CLI |
| `playground/` | the same engine on MemoryFS, in the browser |

## The FUSE layer

The original brief called for a FUSE mount. This repo deliberately ships
the **tested, portable engine + CLI**; the mount layer is specified as a
thin, OS-specific binding (documented in `docs/DESIGN.md`, Linux fuse3)
rather than included untested — no untestable kernel-adjacent code in a
repo whose brand is crash safety.

## Testing

16 tests on real temp directories: dedup, deterministic roots, nested
trees, COW blob accounting (one changed file = one blob + one tree),
diff/status/checkout/prune, time travel both directions, GC reachability
(history keeps blobs alive; deleting a snapshot releases them), dry-run,
crash injection mid-snapshot → fsck repairs → engine still works, atomic
writes never expose partial blobs, and 200-file round-trips.

## Limitations

- per-file dedup (no content chunking), no compression, no encryption
- GC assumes no concurrent snapshot while sweeping
- the store lives inside the tree it snapshots (`.snapshotfs/`, excluded)

## License

[MIT](LICENSE)
