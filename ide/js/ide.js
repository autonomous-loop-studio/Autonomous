/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// IDE — application shell
// ============================================
//
// Owns the tabs (one doc object per open file), the editor instance, the
// theme switcher, the command palette and the mobile bottom bar. The doc
// model is deliberately plain — { path, name, lang, text, modified, ... } —
// so tabs are just an array of those with one attached to the Editor at a
// time. The Editor snapshots scroll/selection back into the doc on detach,
// so switching tabs is lossless.
//
// Boot order: apply saved look → editor → workspace info (which also proves
// the token) → explorer. A 401 raises the lock screen instead of a broken
// explorer, and the parent window can hand us the token any time via
// postMessage (see api.js).

import { ideApi, ApiError } from './api.js?v=500';
import { Editor } from './editor.js?v=500';
import { Tree } from './tree.js?v=500';
import { detectLang, langLabel } from './highlight.js?v=500';
import { planChanges, describeChange } from './changes.js?v=500';

const $ = (id) => document.getElementById(id);

// ---- persisted look --------------------------------------------------------
const THEME_KEY = 'ide.theme.v1';      // dark | matrix | cyberpunk
const GLASS_KEY = 'ide.glass.v1';      // '0' | '1'  (Desktop 2026 glass)
const WRAP_KEY = 'ide.wrap.v1';
const AUTOSAVE_KEY = 'ide.autosave.v1';

const ide = $('ide');
let theme = 'dark';
let glass = false;
let wrap = false;
let autoSave = false;
try {
  theme = localStorage.getItem(THEME_KEY) || 'dark';
  glass = localStorage.getItem(GLASS_KEY) === '1';
  wrap = localStorage.getItem(WRAP_KEY) === '1';
  autoSave = localStorage.getItem(AUTOSAVE_KEY) === '1';
} catch { /* private mode */ }

const THEMES = ['dark', 'matrix', 'cyberpunk'];
function applyTheme() {
  if (!THEMES.includes(theme)) theme = 'dark';
  ide.dataset.theme = theme;
  ide.dataset.glass = glass ? '1' : '0';
  ide.classList.toggle('wrap', wrap);
  $('stTheme').textContent = glass ? `${theme} · glass` : theme;
  $('btnGlass').classList.toggle('on', glass);
  try {
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(GLASS_KEY, glass ? '1' : '0');
    localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
  } catch { /* private mode */ }
  editor?.refresh();
}
function cycleTheme() {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme();
  toast(`theme: ${theme}`);
}
function toggleGlass() {
  glass = !glass;
  applyTheme();
  toast(`glass 2026: ${glass ? 'on' : 'off'}`);
}

// ------------------------------------------------------------ toasts ----
let toastTimer = 0;
function toast(msg, isErr = false) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ------------------------------------------------------- ask / confirm ----
let askResolve = null;
function ask(title, def = '') {
  $('askTitle').textContent = title;
  const input = $('askInput');
  input.value = def;
  $('askModal').hidden = false;
  input.focus();
  input.select();
  return new Promise((res) => { askResolve = res; });
}
$('askOk').addEventListener('click', () => { $('askModal').hidden = true; askResolve?.($('askInput').value.trim()); askResolve = null; });
$('askCancel').addEventListener('click', () => { $('askModal').hidden = true; askResolve?.(''); askResolve = null; });
$('askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('askOk').click(); }
  if (e.key === 'Escape') $('askCancel').click();
});

let confirmResolve = null;
function confirmBox(text) {
  $('confirmText').textContent = text;
  $('confirmModal').hidden = false;
  return new Promise((res) => { confirmResolve = res; });
}
$('confirmYes').addEventListener('click', () => { $('confirmModal').hidden = true; confirmResolve?.(true); confirmResolve = null; });
$('confirmNo').addEventListener('click', () => { $('confirmModal').hidden = true; confirmResolve?.(false); confirmResolve = null; });

// ------------------------------------------------------------- editor ----
const editor = new Editor({
  onChange: (doc) => {
    renderTabs();
    tree?.markDirty(doc.path, doc.modified);
    renderStatus();
    if (autoSave && !doc.binary) saveDoc(doc, true);
  },
  onCursor: ({ line, col }) => {
    $('stPos').textContent = `Ln ${line}, Col ${col}`;
  },
});

// --------------------------------------------------------------- tabs ----
let tabs = [];       // doc objects
let activeIdx = -1;
let tree = null;

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  tabs.forEach((doc, i) => {
    const tab = document.createElement('button');
    tab.className = 'ide-tab' + (i === activeIdx ? ' active' : '') + (doc.modified ? ' dirty' : '');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.innerHTML = `<span class="tab-name">${doc.name}</span><span class="tab-close">×</span>`;
    tab.title = doc.path;
    tab.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
    tab.addEventListener('click', () => activateTab(i));
    bar.appendChild(tab);
  });
  const showEditor = activeIdx >= 0;
  $('editor').hidden = !showEditor;
  $('welcome').style.display = showEditor ? 'none' : '';
  const doc = tabs[activeIdx];
  $('preview').hidden = !showEditor || !doc?.binary;
}

function activateTab(i) {
  if (i === activeIdx) return;
  editor.detach();
  activeIdx = i;
  const doc = tabs[i];
  // Unhide the editor pane FIRST: the Editor measures the painted layer when
  // it attaches, and a hidden element measures zero.
  renderTabs();
  if (doc.binary) {
    $('previewImg').src = doc.dataUrl;
  } else {
    editor.attach(doc);
  }
  $('stPath').textContent = doc.path;
  $('stLang').textContent = doc.binary ? doc.mime : langLabel(doc.lang);
  tree?.setActive(doc.path);
  renderStatus();
}

async function openFile(path, { line = 0 } = {}) {
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx >= 0) {
    activateTab(idx);
    if (line) scrollDocToLine(tabs[idx], line);
    return;
  }
  let data;
  try {
    data = await ideApi.read(path);
  } catch (err) {
    toast(err.detail || err.message, true);
    return;
  }
  const name = path.split('/').pop();
  const doc = {
    path,
    name,
    lang: detectLang(name),
    text: data.content || '',
    modified: false,
    binary: !!data.binary,
    mime: data.mime || '',
    dataUrl: data.dataUrl || '',
    scrollTop: 0,
    selStart: 0,
  };
  tabs.push(doc);
  activateTab(tabs.length - 1);
  if (line) scrollDocToLine(doc, line);
}

function scrollDocToLine(doc, line) {
  if (doc.binary) return;
  editor.attach(doc);
  const lh = parseFloat(getComputedStyle(editor.code).lineHeight) || 20;
  editor.scroll.scrollTop = Math.max(0, (line - 3) * lh);
  editor.lines.scrollTop = editor.scroll.scrollTop;
}

function closeTab(i) {
  const doc = tabs[i];
  const doClose = () => {
    if (i === activeIdx) editor.detach();
    tabs.splice(i, 1);
    activeIdx = tabs.length ? Math.min(i, tabs.length - 1) : -1;
    if (activeIdx >= 0) {
      const d = tabs[activeIdx];
      renderTabs(); // unhide before the Editor measures (see activateTab)
      if (d.binary) { $('previewImg').src = d.dataUrl; }
      else { editor.attach(d); }
      $('stPath').textContent = d.path;
      $('stLang').textContent = d.binary ? d.mime : langLabel(d.lang);
      tree?.setActive(d.path);
    } else {
      renderTabs();
      $('stPath').textContent = '';
      $('stLang').textContent = '';
      tree?.setActive(null);
    }
    renderStatus();
  };
  if (doc.modified) {
    confirmBox(`"${doc.name}" has unsaved changes. Close anyway?`).then((ok) => ok && doClose());
  } else {
    doClose();
  }
}

function renderStatus() {
  const doc = tabs[activeIdx];
  if (!doc) {
    $('stInfo').textContent = '';
    $('stDirty').textContent = '';
    return;
  }
  const bytes = new TextEncoder().encode(doc.text).length;
  $('stInfo').textContent = doc.binary ? `${doc.mime}` : `${doc.text.split('\n').length} lines · ${fmtSize(bytes)}`;
  $('stDirty').textContent = doc.modified ? '● unsaved' : '';
}

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// --------------------------------------------------------------- save ----
async function saveDoc(doc, quiet = false) {
  if (!doc || doc.binary) return;
  doc.text = editor.value || doc.text;
  try {
    const res = await ideApi.write(doc.path, doc.text);
    // Our own save is recorded in the same rev log the poller reads, so note it
    // here or it comes straight back as "changed on disk" a second later.
    recentSaves.set(doc.path, Date.now());
    sinceRev = Math.max(sinceRev, Number(res.rev) || 0);
    doc.modified = false;
    tree?.markDirty(doc.path, false);
    renderStatus();
    if (!quiet) toast(`saved ${doc.path} (${fmtSize(res.size)})`);
  } catch (err) {
    toast(err.detail || err.message, true);
  }
}
async function saveActive() {
  const doc = tabs[activeIdx];
  if (!doc) { toast('no open file'); return; }
  await saveDoc(doc);
}
async function saveAll() {
  const dirty = tabs.filter((t) => t.modified && !t.binary);
  for (const doc of dirty) {
    // eslint-disable-next-line no-await-in-loop
    await saveDoc(doc, true);
  }
  toast(dirty.length ? `saved ${dirty.length} file(s)` : 'nothing to save');
}

// ------------------------------------------------------------- find ----
function openFind() {
  const doc = tabs[activeIdx];
  if (!doc || doc.binary) { toast('open a text file first'); return; }
  $('edFind').hidden = false;
  $('replaceRow').hidden = true;
  const input = $('findInput');
  input.focus();
  input.select();
  runFind();
}
function runFind() {
  const q = $('findInput').value;
  editor.setFindState({ q, caseSensitive: false });
  const n = editor.computeMatches(q, false);
  $('findCount').textContent = n ? `${n} match${n === 1 ? '' : 'es'}` : (q ? 'no match' : '');
  if (n) { editor.nextMatch(); }
}
$('findInput').addEventListener('input', runFind);
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) editor.prevMatch(); else editor.nextMatch();
  }
  if (e.key === 'Escape') closeFind();
});
$('findNext').addEventListener('click', () => editor.nextMatch());
$('findPrev').addEventListener('click', () => editor.prevMatch());
$('findClose').addEventListener('click', closeFind);
$('findToggleRep').addEventListener('click', () => {
  $('replaceRow').hidden = !$('replaceRow').hidden;
  if (!$('replaceRow').hidden) $('replaceInput').focus();
});
$('replaceOne').addEventListener('click', () => {
  editor.replaceCurrent($('replaceInput').value);
  renderStatus();
});
$('replaceAll').addEventListener('click', () => {
  const n = editor.replaceAll($('replaceInput').value);
  toast(`replaced ${n}`);
  runFind();
  renderStatus();
});
function closeFind() {
  $('edFind').hidden = true;
  editor.matches = [];
  editor.matchIdx = -1;
  editor._render(true);
  editor.focus();
}

// ----------------------------------------------------- project search ----
async function openSearch() {
  $('searchPanel').hidden = false;
  $('searchInput').focus();
  $('searchInput').select();
}
async function runProjectSearch() {
  const q = $('searchInput').value.trim();
  const box = $('searchResults');
  if (!q) { box.innerHTML = '<div class="sr-none">type something to search for</div>'; return; }
  box.innerHTML = '<div class="sr-none">searching…</div>';
  try {
    const { results, truncated } = await ideApi.search(q, {
      caseSensitive: $('searchCase').checked,
      regex: $('searchRegex').checked,
    });
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = `<div class="sr-none">no results for "${q.replace(/</g, '&lt;')}"</div>`;
      return;
    }
    let lastFile = '';
    results.forEach((r) => {
      if (r.path !== lastFile) {
        lastFile = r.path;
        const f = document.createElement('div');
        f.className = 'sr-file';
        f.textContent = r.path;
        f.addEventListener('click', () => openFile(r.path, { line: r.line }));
        box.appendChild(f);
      }
      const hit = document.createElement('div');
      hit.className = 'sr-hit';
      const ln = document.createElement('span');
      ln.className = 'sr-ln';
      ln.textContent = r.line || '';
      const txt = document.createElement('span');
      txt.className = 'sr-txt';
      txt.innerHTML = markHit(r.text, q, $('searchCase').checked, $('searchRegex').checked);
      hit.appendChild(ln);
      hit.appendChild(txt);
      hit.addEventListener('click', () => openFile(r.path, { line: r.line }));
      box.appendChild(hit);
    });
    if (truncated) {
      const more = document.createElement('div');
      more.className = 'sr-none';
      more.textContent = '(results truncated — narrow the query)';
      box.appendChild(more);
    }
  } catch (err) {
    box.innerHTML = `<div class="sr-none">${(err.detail || err.message).replace(/</g, '&lt;')}</div>`;
  }
}
function markHit(text, q, caseSensitive, regex) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let re;
  try {
    re = regex ? new RegExp(q, caseSensitive ? '' : 'i') : null;
  } catch { re = null; }
  if (!re) {
    const i = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? q : q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  const m = re.exec(text);
  if (!m) return esc(text);
  return esc(text.slice(0, m.index)) + '<mark>' + esc(m[0]) + '</mark>' + esc(text.slice(m.index + m[0].length));
}
$('searchInput').addEventListener('input', runProjectSearch);
$('searchCase').addEventListener('change', runProjectSearch);
$('searchRegex').addEventListener('change', runProjectSearch);
$('searchClose').addEventListener('click', () => { $('searchPanel').hidden = true; });

// ----------------------------------------------------------- explorer ----
function initTree() {
  tree = new Tree($('tree'), {
    onOpenFile: (p) => openFile(p),
    renamed: (from, to) => {
      // keep open tabs pointing at the same file after a rename
      const doc = tabs.find((t) => t.path === from);
      if (doc) {
        editor.detach();
        doc.path = to;
        doc.name = to.split('/').pop();
        activateTab(tabs.indexOf(doc));
      }
    },
    deleted: (path) => {
      const idx = tabs.findIndex((t) => t.path === path);
      if (idx >= 0) {
        if (idx === activeIdx) editor.detach();
        tabs.splice(idx, 1);
        activeIdx = -1;
        if (tabs.length) activateTab(0);
        else { renderTabs(); renderStatus(); }
      }
    },
    ask,
    confirm: confirmBox,
    toast,
  });
}

// -------------------------------------------------------------- upload ----
$('btnUpload').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async () => {
  const files = [...($('fileInput').files || [])];
  $('fileInput').value = '';
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isText = [...bytes.slice(0, 4096)].includes(0) === false;
    const body = isText
      ? { content: new TextDecoder().decode(bytes) }
      : { content: btoa(String.fromCharCode(...bytes)), encoding: 'base64' };
    try {
      // eslint-disable-next-line no-await-in-loop
      await ideApi.write(f.name, body.content, body.encoding || 'text');
      toast(`uploaded ${f.name}`);
    } catch (err) {
      toast(`${f.name}: ${err.detail || err.message}`, true);
    }
  }
  tree?.refreshAll();
});

// ----------------------------------------------------------- palette ----
const COMMANDS = [
  { name: 'New file', key: 'Ctrl+Alt+N', run: () => tree?._newFile('.') },
  { name: 'New folder', run: () => tree?._newFolder('.') },
  { name: 'Save', key: 'Ctrl+S', run: saveActive },
  { name: 'Save all', run: saveAll },
  { name: 'Toggle auto-save', hint: () => (autoSave ? 'currently ON' : 'currently OFF'), run: () => { autoSave = !autoSave; try { localStorage.setItem(AUTOSAVE_KEY, autoSave ? '1' : '0'); } catch {} toast(`auto-save ${autoSave ? 'on' : 'off'}`); } },
  { name: 'Find in file', key: 'Ctrl+F', run: openFind },
  { name: 'Find in project', key: 'Ctrl+Shift+F', run: openSearch },
  { name: 'Refresh explorer', run: () => tree?.refreshAll() },
  { name: 'Close tab', run: () => activeIdx >= 0 && closeTab(activeIdx) },
  { name: 'Close all tabs', run: async () => { if (await confirmBox('Close all tabs (unsaved changes are discarded)?')) { editor.detach(); tabs = []; activeIdx = -1; renderTabs(); renderStatus(); } } },
  { name: 'Toggle word wrap', hint: () => (wrap ? 'currently ON' : 'currently OFF'), run: () => { wrap = !wrap; applyTheme(); toast(`wrap ${wrap ? 'on' : 'off'}`); } },
  { name: 'Theme: default', run: () => { theme = 'dark'; applyTheme(); toast('theme: default'); } },
  { name: 'Theme: matrix', run: () => { theme = 'matrix'; applyTheme(); toast('theme: matrix'); } },
  { name: 'Theme: cyberpunk', run: () => { theme = 'cyberpunk'; applyTheme(); toast('theme: cyberpunk'); } },
  { name: 'Glass 2026 on/off', hint: () => (glass ? 'currently ON' : 'currently OFF'), run: toggleGlass },
  { name: 'Open path…', run: async () => { const p = await ask('Open file path', 'index.html'); if (p) openFile(p); } },
];

let paletteSel = 0;
function openPalette() {
  $('palette').hidden = false;
  const input = $('paletteInput');
  input.value = '';
  renderPalette('');
  input.focus();
}
function closePalette() {
  $('palette').hidden = true;
  editor.focus();
}
function renderPalette(filter) {
  const list = $('paletteList');
  const f = filter.toLowerCase();
  const items = COMMANDS.filter((c) => c.name.toLowerCase().includes(f));
  paletteSel = Math.min(paletteSel, Math.max(0, items.length - 1));
  list.innerHTML = '';
  items.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'pl-item' + (i === paletteSel ? ' sel' : '');
    b.type = 'button';
    b.innerHTML = `<span>${c.name}</span><span class="pl-hint">${c.key || (c.hint ? c.hint() : '')}</span>`;
    b.addEventListener('click', () => { closePalette(); c.run(); });
    list.appendChild(b);
  });
  return items;
}
$('paletteInput').addEventListener('input', (e) => { paletteSel = 0; renderPalette(e.target.value); });
$('paletteInput').addEventListener('keydown', (e) => {
  const f = COMMANDS.filter((c) => c.name.toLowerCase().includes($('paletteInput').value.toLowerCase()));
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, f.length - 1); renderPalette($('paletteInput').value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette($('paletteInput').value); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = f[paletteSel]; if (c) { closePalette(); c.run(); } }
  else if (e.key === 'Escape') closePalette();
});
$('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });

// ------------------------------------------------------------ top bar ----
$('btnTree').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 860px)').matches) {
    $('ideSide').classList.toggle('open');
  } else {
    document.body.classList.toggle('tree-hidden');
    $('btnTree').classList.toggle('on');
    editor._sizeInput();
  }
});
$('btnNewFile').addEventListener('click', () => tree?._newFile('.'));
$('btnNewFolder').addEventListener('click', () => tree?._newFolder('.'));
$('btnRefresh').addEventListener('click', () => tree?.refreshAll());
$('btnSearch').addEventListener('click', openSearch);
$('btnPalette').addEventListener('click', openPalette);
$('btnTheme').addEventListener('click', cycleTheme);
$('btnGlass').addEventListener('click', toggleGlass);
$('stWrap').addEventListener('click', () => { wrap = !wrap; applyTheme(); });
$('stWrap').classList.toggle('on', wrap);
$('stTheme').addEventListener('click', cycleTheme);
$('btnPop').addEventListener('click', () => window.open('index.php', '_blank', 'noopener'));

// --------------------------------------------------------- mobile bar ----
$('mbFiles').addEventListener('click', () => {
  const side = $('ideSide');
  side.classList.toggle('open');
  $('mbFiles').classList.toggle('on', side.classList.contains('open'));
});
$('mbFind').addEventListener('click', () => {
  if ($('edFind').hidden) openFind(); else closeFind();
});
$('mbSave').addEventListener('click', saveActive);
$('mbTheme').addEventListener('click', cycleTheme);
$('mbMore').addEventListener('click', openPalette);

// -------------------------------------------------------- shortcuts ----
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    if (e.key === 'Escape') {
      if (!$('palette').hidden) closePalette();
      else if (!$('askModal').hidden) $('askCancel').click();
      else if (!$('confirmModal').hidden) $('confirmNo').click();
      else if (!$('searchPanel').hidden) $('searchPanel').hidden = true;
      else if (!$('edFind').hidden) closeFind();
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 's' && !e.shiftKey) { e.preventDefault(); saveActive(); }
  else if (k === 's' && e.shiftKey) { e.preventDefault(); saveAll(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); openSearch(); }
  else if (k === 'f' && !e.shiftKey) { e.preventDefault(); openFind(); }
  else if (k === 'k') { e.preventDefault(); openPalette(); }
  else if (k === 'p' && e.shiftKey) { e.preventDefault(); openPalette(); }
  else if (k === 'n' && e.altKey) { e.preventDefault(); tree?._newFile('.'); }
});

window.addEventListener('beforeunload', (e) => {
  if (tabs.some((t) => t.modified)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------- watching the disk ----
// The IDE and the agents share one write path (src/Workspace.php): every save,
// write, patch, rename and delete appends a revision. This poll is what turns
// that into "the agent's edit appeared in my editor".
//
// Polling and not a socket, on purpose: this app runs under `php -S` too, which
// is single-threaded — one held-open stream would block the very request the
// agent is waiting on. 1.5s of a small JSON document costs nothing and behaves
// the same on php -S, Apache and nginx.
const WATCH_MS = 1500;
let sinceRev = 0;
let watchTimer = 0;
let watching = false;
let primed = false;                 // first answer only sets the baseline
const recentSaves = new Map();      // path -> when we saved it ourselves
let conflictPath = '';

function startWatching() {
  if (watching) return;
  watching = true;
  pollChanges();
}

async function pollChanges() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(pollChanges, WATCH_MS);
  if (document.hidden) return;          // a hidden editor asks for nothing
  if (!$('ideLock').hidden) return;    // locked: the token is the problem, not the files
  try {
    const res = await ideApi.revs(sinceRev);
    const next = Number(res.rev) || 0;
    const changes = (res.changes || []).filter((c) => {
      const at = recentSaves.get(c.path);
      return !(at && Date.now() - at < 4000);   // our own save echoing back
    });
    if (!primed) {
      // Everything already in the log belongs to before this editor was open.
      primed = true;
      sinceRev = Math.max(sinceRev, next);
      return;
    }
    sinceRev = Math.max(sinceRev, next);
    if (changes.length) await applyDiskChanges(changes);
  } catch {
    // A poll that fails is not worth a toast every 1.5 seconds — and a 401 has
    // already raised the lock screen through the API client.
  }
}

async function applyDiskChanges(changes) {
  const plan = planChanges(tabs, changes, new Set());
  let touched = false;
  for (const path of plan.reload) {
    // eslint-disable-next-line no-await-in-loop
    const done = await reloadDoc(path);
    if (done) { flashTab(path, 'changed on disk'); touched = true; }
  }
  if (plan.conflict.length) {
    showConflict(plan.conflict[plan.conflict.length - 1]);
    touched = true;
  }
  if (touched || plan.ignore.length) tree?.refreshAll();
}

/** Re-read a clean buffer from disk, keeping the caret where the user left it. */
async function reloadDoc(path) {
  const doc = tabs.find((t) => t.path === path);
  if (!doc || doc.modified) return false;
  let data;
  try {
    data = await ideApi.read(path);
  } catch {
    return false;    // deleted under us: leave the buffer, the tree will drop it
  }
  const active = tabs[activeIdx] === doc;
  const keepTop = active ? editor.scroll.scrollTop : doc.scrollTop;
  const keepSel = active ? editor.input.selectionStart : doc.selStart;
  if (active) editor.detach();
  doc.text = data.content || '';
  doc.modified = false;
  doc.scrollTop = keepTop;
  doc.selStart = Math.min(keepSel || 0, doc.text.length);
  if (active) editor.attach(doc);
  tree?.markDirty(path, false);
  renderStatus();
  return true;
}

/** Mark a tab as changed for a moment and say so once. */
function flashTab(path, why) {
  const i = tabs.findIndex((t) => t.path === path);
  const el = i >= 0 ? $('tabs').children[i] : null;
  if (el) {
    el.classList.add('changed');
    setTimeout(() => el.classList.remove('changed'), 2200);
  }
  toast(`${path} — ${why}`);
}

function showConflict(change) {
  conflictPath = change.path;
  $('conflictText').textContent = `${describeChange(change)} — you have unsaved edits`;
  $('conflictBar').hidden = false;
}

function hideConflict() {
  conflictPath = '';
  $('conflictBar').hidden = true;
}

$('conflictLoad').addEventListener('click', async () => {
  const path = conflictPath;
  hideConflict();
  if (!path) return;
  const doc = tabs.find((t) => t.path === path);
  if (!doc) return;
  // Theirs wins only because the human just said so: drop the dirty flag first
  // or reloadDoc() (correctly) refuses to touch it.
  doc.modified = false;
  if (await reloadDoc(path)) toast('loaded the version on disk');
});
$('conflictKeep').addEventListener('click', () => {
  hideConflict();
  toast('kept your version — saving will overwrite theirs');
});
$('conflictHide').addEventListener('click', hideConflict);

// ------------------------------------------------------------- boot ----
let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  applyTheme();
  $('wsName').textContent = '…';
  try {
    const info = await ideApi.info();
    $('wsName').textContent = info.name || 'workspace';
    initTree();
    $('ideLock').hidden = true;
    startWatching();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      showLock(err);
    } else {
      $('wsName').textContent = 'offline';
      toast(err.detail || err.message, true);
    }
    booted = false;
  }
}

function showLock(err) {
  const lock = $('ideLock');
  const msg = lock.querySelector('p');
  if (err && err.detail) msg.textContent = err.detail;
  else msg.textContent = 'This workspace requires an access token. Paste the one from Config → Access token in the main app.';
  lock.hidden = false;
  // If we live in the studio's iframe, ask for the token once more: the
  // parent may simply not have answered the very first handshake yet.
  ideApi.handshake();
}
$('lockGo').addEventListener('click', async () => {
  const t = $('lockToken').value.trim();
  if (!t) return;
  ideApi.setToken(t);
  $('ideLock').hidden = true;
  booted = false;
  await boot();
});
$('lockToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockGo').click(); });

// If the parent answers the auth handshake late, adopt the token and restart.
window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return;
  const msg = e.data;
  // The studio asks us to open a file — a chat tool-call's "Open in IDE".
  if (msg && msg.type === 'ide:open' && msg.path) {
    openFile(String(msg.path), { line: Number(msg.line) || 0 });
    return;
  }
  if (msg && msg.type === 'ide:auth' && msg.token) {
    ideApi.setToken(msg.token);
    if (!$('ideLock').hidden || !booted) {
      $('ideLock').hidden = true;
      booted = false;
      boot();
    }
  }
});

// Standalone (not framed): the pop-out button has nothing to pop out of.
if (window.self === window.top) {
  $('btnPop').style.display = 'none';
}

// Handshake first (cheap), then immediately try the API; if a token already
// exists in storage the handshake is simply ignored by the parent.
ideApi.handshake();
boot();
