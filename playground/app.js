import { MemoryFS } from '../src/fs.js';
import { Store } from '../src/store.js';
import { snapshot, checkout, diff, status } from '../src/snapshot.js';
import { gc } from '../src/gc.js';

const DIR = '/project';
const mfs = new MemoryFS();
const store = new Store(mfs, DIR + '/.snapshotfs');

/* seed a tiny project */
mfs.writeAtomic(DIR + '/index.html', Buffer.from('<h1>snapshotfs</h1>\n'));
mfs.writeAtomic(DIR + '/src/app.js', Buffer.from('console.log("v1")\n'));
mfs.writeAtomic(DIR + '/src/util.js', Buffer.from('export const answer = 42;\n'));

const $ = (id) => document.getElementById(id);
let files = [];
let selected = null;
let selA = null, selB = null;

function refresh() {
  const walk = (dir, prefix = '') => {
    const out = [];
    for (const name of mfs.list(dir)) {
      if (name === '.snapshotfs') continue;
      const p = dir + '/' + name;
      out.push({ path: p, rel: prefix + name });
    }
    return out;
  };
  files = walk(DIR);
  const st = selA ? status(store, mfs, selA, DIR) : null;
  $('fileList').innerHTML = files.map((f) => {
    const changed = st && (st.modified.includes(f.rel) || st.added.includes(f.rel));
    const gone = st && st.removed.includes(f.rel);
    return `<div class="file ${selected === f.path ? 'sel' : ''}" data-p="${f.path}">
      <span class="${changed ? 'changed' : ''}">${changed ? '~ ' : gone ? '· ' : ''}${f.rel}</span></div>`;
  }).join('');
  document.querySelectorAll('.file').forEach((el) => el.onclick = () => selectFile(el.dataset.p));
  const blobs = store.initialized() ? store.listBlobs().length : 0;
  const snaps = store.listSnapshots().length;
  $('storeStats').textContent = `${blobs} blobs · ${snaps} snapshots (deduped by sha256)`;
  renderSnaps();
  renderDiff();
}

function selectFile(path) {
  selected = path;
  $('editingName').textContent = path.replace(DIR + '/', '');
  $('editor').value = mfs.read(path).toString('utf8');
  $('editor').disabled = false;
  $('save').disabled = false;
  $('del').disabled = false;
  refresh();
}

$('save').onclick = () => {
  if (selected) mfs.writeAtomic(selected, Buffer.from($('editor').value));
  refresh();
};
$('newFile').onclick = () => {
  const name = prompt('file name (e.g. docs/notes.md)');
  if (!name) return;
  mfs.writeAtomic(DIR + '/' + name, Buffer.from(''));
  selectFile(DIR + '/' + name);
};
$('del').onclick = () => {
  if (selected) { mfs.remove(selected); selected = null; $('editor').value = ''; $('editor').disabled = true; $('save').disabled = true; $('del').disabled = true; }
  refresh();
};

function renderSnaps() {
  const snaps = store.listSnapshots().map((id) => store.getSnapshot(id));
  $('snapList').innerHTML = snaps.map((s) => {
    const cls = ['snap', s.id === selA ? 'sel selA' : '', s.id === selB ? 'selB' : ''].join(' ');
    return `<div class="${cls}" data-id="${s.id}">
      <span class="id">${s.id.slice(-16)}</span>
      ${s.label ? '· ' + s.label : ''} · ${s.files.length} files
      ${s.reused ? '<span class="reused">· unchanged</span>' : ''}
      <span class="reused">· ${new Date(s.time).toLocaleTimeString()}</span></div>`;
  }).join('') || '<p class="legend">no snapshots yet — press ◉ snapshot</p>';
  document.querySelectorAll('.snap').forEach((el) => el.onclick = () => {
    const id = el.dataset.id;
    if (!selA || (selA && selB)) { selA = id; selB = null; }
    else selB = id;
    refresh();
  });
}

function renderDiff() {
  const out = $('diffOut');
  if (!(selA && selB)) {
    if (selA) {
      const st = status(store, mfs, selA, DIR);
      out.innerHTML = `<span class="mod">${st.modified.length} modified</span> ·
        <span class="add">${st.added.length} added</span> ·
        <span class="del">${st.removed.length} removed</span> vs working tree (select a 2nd snapshot to diff history)`;
    }
    return;
  }
  const d = diff(store, selA, selB);
  out.innerHTML =
    d.added.map((a) => `<div class="add">+ ${a.name} (${a.size} B)</div>`).join('') +
    d.removed.map((r) => `<div class="del">− ${r.name} (${r.size} B)</div>`).join('') +
    d.modified.map((m) => `<div class="mod">~ ${m.name} (${m.oldSize} → ${m.newSize} B)</div>`).join('') +
    `<p class="legend">${d.added.length} added · ${d.removed.length} removed · ${d.modified.length} modified — blue = older, green = newer</p>`;
}

$('snap').onclick = () => {
  const r = snapshot(store, mfs, DIR, { label: $('label').value });
  if (!selA) selA = r.id;
  $('label').value = '';
  refresh();
};
$('checkoutBtn').onclick = () => {
  if (!selA) return;
  checkout(store, mfs, selA, DIR, { prune: true });
  selected = null;
  refresh();
};
$('diffBtn').onclick = () => { if (selA && selB) renderDiff(); };
$('gcBtn').onclick = () => {
  const r = gc(store);
  $('gcOut').textContent = r.dryRun ? '' :
    `swept ${r.removed} blob(s), freed ${r.freedBytes} B · kept ${r.kept}`;
  refresh();
};

refresh();
