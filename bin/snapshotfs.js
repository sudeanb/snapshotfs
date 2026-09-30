#!/usr/bin/env node
/* snapshotfs CLI — copy-on-write snapshots of a real directory.
   The store lives in <dir>/.snapshotfs by default. */

import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { NodeFS } from '../src/fs.js';
import { snapshot, checkout, diff, status } from '../src/snapshot.js';
import { gc, fsck } from '../src/gc.js';

const args = process.argv.slice(2);
const cmd = args[0];
const has = (f) => args.includes(f);
const get = (f) => (has(f) ? args[args.indexOf(f) + 1] : null);
const asJson = has('--json');
const fs = new NodeFS();

function usage() {
  console.error(`usage: snapshotfs <command> …

  snapshot <dir> [--label L]   take a copy-on-write snapshot of a directory
  log [<dir>]                  list snapshots (newest last)
  diff <idA> <idB>             tree diff between two snapshots
  status <id> <dir>            working tree vs a snapshot
  checkout <id> <dir> [--prune] restore a snapshot (prune = make it exact)
  gc [--dry-run]               sweep blobs no snapshot references
  fsck                         verify + repair after a crash
  init <dir>                   create an empty store`);
  process.exit(2);
}

const dirOf = (d) => resolve(d);
const storeFor = (d) => new Store(fs, fs.join(dirOf(d), '.snapshotfs'));
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

switch (cmd) {
  case 'init': {
    const dir = dirOf(args[1] ?? '.');
    const store = storeFor(args[1] ?? '.');
    store.init();
    console.log(`initialized ${store.root}`);
    break;
  }
  case 'snapshot': {
    const dir = dirOf(args[1] ?? usage());
    const store = storeFor(args[1]);
    const r = snapshot(store, fs, dir, { label: get('--label') ?? '' });
    console.log(asJson ? JSON.stringify(r) : `◉ ${r.id}  root ${r.root.slice(0, 12)} · ${r.files} file(s)${r.reused ? ' · unchanged (reused)' : ''}`);
    break;
  }
  case 'log': {
    const store = storeFor(args[1] ?? '.');
    const snaps = store.listSnapshots().map((id) => store.getSnapshot(id));
    if (asJson) { console.log(JSON.stringify(snaps)); break; }
    for (const s of snaps) {
      console.log(`${s.id}  ${new Date(s.time).toISOString()}  ${(s.label ?? '').padEnd(16)} ${s.files.length} files · root ${s.root.slice(0, 12)}`);
    }
    break;
  }
  case 'diff': {
    const store = storeFor(args[3] ?? '.');
    const d = diff(store, args[1], args[2]);
    if (asJson) { console.log(JSON.stringify(d)); break; }
    for (const a of d.added) console.log(`  + ${a.name} (${fmtBytes(a.size)})`);
    for (const r of d.removed) console.log(`  - ${r.name} (${fmtBytes(r.size)})`);
    for (const m of d.modified) console.log(`  ~ ${m.name}  ${fmtBytes(m.oldSize)} → ${fmtBytes(m.newSize)}`);
    console.log(`\n  ${d.added.length} added · ${d.removed.length} removed · ${d.modified.length} modified`);
    break;
  }
  case 'status': {
    const store = storeFor(args[2] ?? '.');
    const st = status(store, fs, args[1], dirOf(args[2]));
    if (asJson) { console.log(JSON.stringify(st)); break; }
    for (const m of st.modified) console.log(`  ~ ${m}`);
    for (const a of st.added) console.log(`  + ${a}`);
    for (const r of st.removed) console.log(`  - ${r}`);
    console.log(`\n  ${st.modified.length} modified · ${st.added.length} added · ${st.removed.length} removed · ${st.unchanged.length} unchanged`);
    break;
  }
  case 'checkout': {
    const target = dirOf(get('--into') ?? args[2] ?? '.');
    const store = storeFor(target);
    const r = checkout(store, fs, args[1], target, { prune: has('--prune') });
    console.log(asJson ? JSON.stringify(r) : `⏪ ${args[1]} → ${target}  (${r.restored} restored, ${r.removed} pruned)`);
    break;
  }
  case 'gc': {
    const store = storeFor(get('--dir') ?? args[1] ?? '.');
    const r = gc(store, { dryRun: has('--dry-run') });
    console.log(asJson ? JSON.stringify(r, (_, v) => v instanceof Buffer ? v.toString() : v) :
      `${has('--dry-run') ? '[dry-run] ' : ''}${r.removed} blob(s) + ${r.removedSnapshots} snapshot(s) swept · ${fmtBytes(r.freedBytes)} freed · ${r.kept} kept`);
    break;
  }
  case 'fsck': {
    const store = storeFor(args[1] ?? '.');
    const r = fsck(store);
    if (asJson) { console.log(JSON.stringify(r)); break; }
    if (r.clean) console.log('✓ clean — journal empty, no temp files, no garbage');
    else {
      for (const rep of r.repairs) console.log(`  repaired ${rep.what}: ${rep.detail}`);
      console.log(`✓ ${r.repairs.length} repair(s) applied`);
    }
    break;
  }
  default:
    usage();
}
