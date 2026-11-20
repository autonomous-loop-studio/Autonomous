/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// tree — the explorer sidebar
// ============================================
//
// Directories load lazily: one /list call per folder the user expands, so a
// big workspace costs nothing until it is opened. Each folder keeps its <ul>,
// which is how refresh-after-write finds the right branch to reload.
//
// Row actions live in a context menu raised by right-click AND by a long
// press (500 ms), because phones have no right-click.

import { ideApi } from './api.js?v=501';

const FOLDER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 12.6V4a1.2 1.2 0 0 1 1.2-1.2h3l1.5 1.8h5.5A1.2 1.2 0 0 1 14.2 6v6.6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 1.8H4.2A1.2 1.2 0 0 0 3 3v10a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 13V5.8z"/><path d="M9 1.8V5.8H13"/></svg>';
const CARET = '<svg class="tree-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 3.5L10.5 8l-5 4.5"/></svg>';

function iconFor(name, isDir) {
  if (isDir) return `<span class="tree-ico dir">${FOLDER_ICON}</span>`;
  const ext = String(name).split('.').pop().toLowerCase();
  const cls = { php: 'php', js: 'js', mjs: 'js', cjs: 'js', ts: 'js', css: 'css', scss: 'css',
    html: 'html', htm: 'html', json: 'json', md: 'md', svg: 'img', png: 'img', jpg: 'img',
    jpeg: 'img', gif: 'img', webp: 'img' }[ext] || '';
  return `<span class="tree-ico file ${cls}">${FILE_ICON}</span>`;
}

export class Tree {
  /**
   * @param {HTMLElement} root      container for the tree
   * @param {object} hooks { onOpenFile(path), onFsChanged(), ask(title, def),
   *                         confirm(text), toast(msg, err), renamed(from,to) }
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.dirs = new Map();   // path → { li, loaded, open }
    this.activePath = null;
    this.menu = null;
    this._pressTimer = 0;
    this.loadRoot();
  }

  loadRoot() {
    this.root.innerHTML = '';
    const li = this._mkDirLi('.', 'workspace');
    this.root.appendChild(li);
    this._loadDir('.', li);
  }

  _mkDirLi(path, name) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    li.dataset.path = path;
    const row = document.createElement('button');
    row.className = 'tree-row';
    row.type = 'button';
    row.innerHTML = `${CARET}<span class="tree-ico dir">${FOLDER_ICON}</span><span class="tree-name">${name === '.' ? 'workspace' : name}</span>`;
    li.appendChild(row);
    const kids = document.createElement('ul');
    kids.className = 'tree-children';
    li.appendChild(kids);
    const rec = { li, kids, row, loaded: false, open: false };
    this.dirs.set(path, rec);
    row.addEventListener('click', () => this.toggleDir(path));
    this._wireRow(row, path, true);
    return li;
  }

  async toggleDir(path) {
    const rec = this.dirs.get(path);
    if (!rec) return;
    if (!rec.open) {
      rec.open = true;
      rec.li.classList.add('open');
      if (!rec.loaded) await this._loadDir(path, rec.li);
      return;
    }
    rec.open = false;
    rec.li.classList.remove('open');
  }

  async refreshDir(path) {
    const rec = this.dirs.get(path);
    if (!rec) return;
    if (!rec.open && path !== '.') return;
    rec.kids.innerHTML = '';
    // children that were expanded keep their entries in dirs; drop them so a
    // refresh never resurrects folders that no longer exist
    for (const [p, r] of [...this.dirs]) {
      if (p !== '.' && (p === path || p.startsWith(path + '/'))) this.dirs.delete(p);
    }
    rec.loaded = false;
    await this._loadDir(path, rec.li);
  }

  refreshAll() {
    this.dirs.clear();
    this.loadRoot();
  }

  async _loadDir(path, li) {
    const rec = this.dirs.get(path);
    if (!rec) return;
    let entries;
    try {
      entries = (await ideApi.list(path)).entries;
    } catch (err) {
      this.hooks.toast(`tree: ${err.message || 'cannot list folder'}`, true);
      return;
    }
    const kids = rec.kids;
    kids.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '(empty)';
      kids.appendChild(empty);
    }
    for (const e of entries) {
      const childPath = path === '.' ? e.name : `${path}/${e.name}`;
      if (e.dir) {
        kids.appendChild(this._mkDirLi(childPath, e.name));
      } else {
        const liFile = document.createElement('li');
        liFile.className = 'tree-node';
        const row = document.createElement('button');
        row.className = 'tree-row';
        row.type = 'button';
        row.dataset.path = childPath;
        row.innerHTML = `${CARET.replace('tree-caret', 'tree-caret leaf')}<span class="tree-ico file">${iconFor(e.name, false)}</span><span class="tree-name">${e.name}</span>`;
        row.addEventListener('click', () => {
          this.setActive(childPath);
          this.hooks.onOpenFile(childPath);
        });
        this._wireRow(row, childPath, false, e.name);
        liFile.appendChild(row);
        kids.appendChild(liFile);
      }
    }
    rec.loaded = true;
    this._syncActive();
  }

  setActive(path) {
    this.activePath = path;
    this._syncActive();
  }

  _syncActive() {
    this.root.querySelectorAll('.tree-row.active').forEach((el) => el.classList.remove('active'));
    if (!this.activePath) return;
    const row = this.root.querySelector(`.tree-row[data-path="${CSS.escape(this.activePath)}"]`);
    if (row) row.classList.add('active');
  }

  markDirty(path, dirty) {
    const row = this.root.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.toggle('dirty', !!dirty);
  }

  // ------------------------------------------------------- context menu ----
  _wireRow(row, path, isDir, name = path.split('/').pop()) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showMenu(e.clientX, e.clientY, path, isDir, name);
    });
    // long press for touch: 500ms hold raises the same menu
    row.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      this._pressTimer = setTimeout(() => {
        this._showMenu(t.clientX, t.clientY, path, isDir, name);
      }, 500);
    }, { passive: true });
    const cancel = () => clearTimeout(this._pressTimer);
    row.addEventListener('touchend', cancel);
    row.addEventListener('touchmove', cancel);
    row.addEventListener('touchcancel', cancel);
  }

  _closeMenu() {
    if (this.menu) {
      this.menu.remove();
      this.menu = null;
    }
  }

  _showMenu(x, y, path, isDir, name) {
    this._closeMenu();
    const items = [
      ...(isDir ? [['New file', () => this._newFile(path)], ['New folder', () => this._newFolder(path)]] : []),
      ...(!isDir ? [['Open', () => this.hooks.onOpenFile(path)]] : []),
      [isDir ? 'Refresh' : 'Download', () => (isDir ? this.refreshDir(path) : this._download(path))],
      ['Rename', () => this._rename(path, isDir)],
      ['Delete', () => this._delete(path, isDir)],
      ['Copy path', () => this._copyPath(path)],
    ];
    const menu = document.createElement('div');
    menu.className = 'tree-menu';
    items.forEach(([label, fn]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this._closeMenu();
        fn();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    this.menu = menu;
    // keep it on screen
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    setTimeout(() => {
      document.addEventListener('pointerdown', (e2) => {
        if (!menu.contains(e2.target)) this._closeMenu();
      }, { once: true });
      document.addEventListener('keydown', (e2) => {
        if (e2.key === 'Escape') this._closeMenu();
      }, { once: true });
    });
  }

  async _newFile(dirPath) {
    const name = await this.hooks.ask('New file name', 'new-file.php');
    if (!name) return;
    const full = dirPath === '.' ? name : `${dirPath}/${name}`;
    try {
      await ideApi.create(full, 'file');
      await this.refreshDir(dirPath);
      this.hooks.onOpenFile(full);
    } catch (err) {
      this.hooks.toast(err.detail || err.message, true);
    }
  }

  async _newFolder(dirPath) {
    const name = await this.hooks.ask('New folder name', 'folder');
    if (!name) return;
    const full = dirPath === '.' ? name : `${dirPath}/${name}`;
    try {
      await ideApi.create(full, 'dir');
      await this.refreshDir(dirPath);
    } catch (err) {
      this.hooks.toast(err.detail || err.message, true);
    }
  }

  async _rename(path, isDir) {
    const oldName = path.split('/').pop();
    const parent = path.split('/').slice(0, -1).join('/');
    const name = await this.hooks.ask('Rename to', oldName);
    if (!name || name === oldName) return;
    const to = parent ? `${parent}/${name}` : name;
    try {
      await ideApi.rename(path, to);
      await this.refreshDir(parent || '.');
      this.hooks.renamed(path, to);
    } catch (err) {
      this.hooks.toast(err.detail || err.message, true);
    }
  }

  async _delete(path, isDir) {
    const ok = await this.hooks.confirm(`Delete ${isDir ? 'folder' : 'file'} "${path}"${isDir ? ' and everything in it' : ''}?`);
    if (!ok) return;
    try {
      await ideApi.del(path);
      const parent = path.split('/').slice(0, -1).join('/');
      await this.refreshDir(parent || '.');
      this.hooks.deleted(path);
    } catch (err) {
      this.hooks.toast(err.detail || err.message, true);
    }
  }

  _download(path) {
    // Relative (not /-rooted) so it resolves inside ide/ at any mount point;
    // the token must travel for the download too, so a fetch → object URL
    // does it without leaking the token into the URL.
    const url = `api.php?action=download&path=${encodeURIComponent(path)}`;
    const a = document.createElement('a');
    a.href = url;
    // The token must travel for the download too; a fetch → object URL does it
    // without leaking the token into the URL.
    fetch(url, { headers: { 'X-Router-Token': ideApi.getToken() || '', 'X-Sandbox-Token': ideApi.getToken() || '' } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        const a2 = document.createElement('a');
        a2.href = u;
        a2.download = path.split('/').pop();
        a2.click();
        setTimeout(() => URL.revokeObjectURL(u), 4000);
      })
      .catch((err) => this.hooks.toast(`download: ${err.message}`, true));
  }

  _copyPath(path) {
    navigator.clipboard?.writeText(path).then(
      () => this.hooks.toast('path copied'),
      () => this.hooks.toast('copy failed', true),
    );
  }
}
