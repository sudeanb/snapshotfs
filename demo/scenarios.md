# Step-by-step scenarios (copy-paste ready)

## 1 — version a project, travel back in time

```bash
mkdir -p work/src && cd work
echo "v1" > doc.txt && echo "console.log(1)" > src/app.js

snapshotfs snapshot . --label v1
echo "v2" > doc.txt
snapshotfs snapshot . --label v2
snapshotfs log .
```

```console
0017907…-c6dd1db9  2026-09-30T08:09:54.676Z  v1   2 files · root c6dd1db9206e
0017907…-8d685643  2026-09-30T08:09:54.707Z  v2   2 files · root 8d6856439903
```

## 2 — what changed between v1 and v2?

```bash
snapshotfs diff <v1-id> <v2-id> .
```

```console
  ~ doc.txt  3 B → 3 B
  0 added · 0 removed · 1 modified
```

## 3 — time travel (and back)

```bash
snapshotfs checkout <v1-id> . --prune
cat doc.txt          # → v1
snapshotfs checkout <v2-id> . --prune
cat doc.txt          # → v2
```

`--prune` makes the directory EXACTLY that snapshot (files created after
it disappear; taking a new snapshot brings them back).

## 4 — storage: dedup means versioning is (almost) free

```bash
dd if=/dev/urandom of=big.bin bs=1m count=8    # 8 MiB
snapshotfs snapshot . --label before
snapshotfs status <before-id> .                # 0 modified
snapshotfs gc .                                # nothing to sweep — all blobs referenced
snapshotfs log . --json | jq 'length'          # every snapshot, one shared 8 MiB blob
```

## 5 — crash simulation

```bash
kill -9 %1                    # mid-snapshot, worst timing
snapshotfs fsck .             # → journal cleared, temp files removed, gc applied
snapshotfs snapshot . --label after   # engine fine
```

(Unit tests do this deterministically with a fault-injecting FS —
see `test/snapshotfs.test.js`, "injected failure mid-snapshot".)
