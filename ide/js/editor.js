/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// editor — the code surface
// ============================================
//
// One textarea, one painted highlight layer behind it, one line-number
// column. The textarea's own text is fully transparent (only the caret and
// selection paint), so the regex highlighter in highlight.js provides the
// colours. Both layers live inside one scroll container, which means there is
// no scroll-sync problem: they scroll together, and the line column follows
// on a scroll event.
//
// Native undo/redo survives everything a user types. Programmatic edits
// (find/replace, auto-indent) go through execCommand('insertText') where the
// browser supports it, which keeps history intact; only large structural
// changes fall back to a plain value swap.

import { escHtml, highlight } from './highlight.js?v=481';

export class Editor {
  constructor({ onChange, onCursor }) {
    this.onChange = onChange || (() => {});
    this.onCursor = onCursor || (() => {});
    this.doc = null;
    this.matches = [];
    this.matchIdx = -1;

    this.wrap = document.getElementById('edWrap');
    this.hl = document.getElementById('edHl');
    this.code = document.getElementById('edCode');
    this.input = document.getElementById('edInput');

    // Build the structure the CSS expects: a line-number column beside a
    // scroll container that holds BOTH layers, so they scroll as one.
    this.lines = document.createElement('div');
    this.lines.className = 'ed-lines';
    this.linesInner = document.createElement('div');
    this.lines.appendChild(this.linesInner);
    this.scroll = document.createElement('div');
    this.scroll.className = 'ed-scroll';
    this.wrap.insertBefore(this.lines, this.hl);
    this.wrap.insertBefore(this.scroll, this.hl);
    this.scroll.appendChild(this.hl);
    this.scroll.appendChild(this.input);

    this._raf = 0;
    this._pending = false;

    this.input.addEventListener('input', () => this._onInput());
    this.input.addEventListener('scroll', () => this._syncLines()); // safety net
    this.scroll.addEventListener('scroll', () => this._syncLines());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === this.input) this._onCursor();
    });
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    // Rotation, sidebar resize, mobile keyboard: content-driven sizes must
    // be re-measured or the layers desync from the scroll container.
    window.addEventListener('resize', () => { if (this.doc) this._sizeInput(); });
  }

  // ------------------------------------------------------------ attach ----
  /** Mount a doc { path, name, lang, text, modified, scrollTop, selStart }. */
  attach(doc) {
    this.doc = doc;
    this.input.value = doc.text;
    this.matches = [];
    this.matchIdx = -1;
    this._render();
    this.input.scrollTop = 0; // container does the scrolling; keep both at 0
    if (doc.scrollTop) {
      this.scroll.scrollTop = doc.scrollTop;
    }
    const sel = Math.min(doc.selStart ?? doc.text.length, doc.text.length);
    this.input.setSelectionRange(sel, sel);
    this._syncLines();
    this._onCursor();
  }

  /** Snapshot back into the doc: text, modified, scroll, selection. */
  detach() {
    const doc = this.doc;
    if (doc) {
      doc.text = this.input.value;
      doc.scrollTop = this.scroll.scrollTop;
      doc.selStart = this.input.selectionStart;
    }
    this.doc = null;
    return doc;
  }

  get value() {
    return this.doc ? this.input.value : '';
  }

  /** Re-paint without touching history (theme or wrap change). */
  refresh() {
    this._render(true);
  }

  focus() {
    this.input.focus();
  }

  // ------------------------------------------------------------ render ----
  _render(keepScroll = false) {
    const doc = this.doc;
    if (!doc) return;
    const top = keepScroll ? this.scroll.scrollTop : 0;
    this.code.innerHTML = highlight(doc.text, doc.lang);
    if (this.matches.length) {
      this._renderWithMatches();
    }
    this._syncLines();
    this._sizeInput();
    if (keepScroll) this.scroll.scrollTop = top;
  }

  _renderWithMatches() {
    const doc = this.doc;
    if (!doc || !this.matches.length) return;
    const text = this.input.value;
    let out = '';
    let last = 0;
    for (let i = 0; i < this.matches.length; i++) {
      const [s, e] = this.matches[i];
      if (s < last) continue; // overlapping (shouldn't happen with literal find)
      out += escHtml(text.slice(last, s));
      const cls = i === this.matchIdx ? 'tk-match cur' : 'tk-match';
      out += `<span class="${cls}">${escHtml(text.slice(s, e))}</span>`;
      last = e;
    }
    out += escHtml(text.slice(last));
    this.code.innerHTML = out;
  }

  _syncLines() {
    const doc = this.doc;
    if (!doc) return;
    const count = this.input.value.split('\n').length;
    const cur = this.input.value.slice(0, this.input.selectionStart).split('\n').length;
    if (this.linesInner._count !== count) {
      let html = '';
      for (let i = 1; i <= count; i++) html += `<div>${i}</div>`;
      this.linesInner.innerHTML = html;
      this.linesInner._count = count;
      this._sizeInput();
    }
    // mark the current line number
    const nodes = this.linesInner.children;
    if (this._curLine !== cur && nodes[cur - 1]) {
      if (nodes[this._curLine - 1]) nodes[this._curLine - 1].classList.remove('cur');
      nodes[cur - 1].classList.add('cur');
      this._curLine = cur;
    }
    this.lines.scrollTop = this.scroll.scrollTop;
  }

  /** Both layers must be exactly as big as the content so the single scroll
      container scrolls them together. In wrap mode the width is fixed and the
      height follows the painted layer. */
  _sizeInput() {
    const isWrap = document.getElementById('ide').classList.contains('wrap');
    if (isWrap) {
      this.hl.style.width = '100%';
      this.input.style.width = '100%';
      this.input.style.height = `${Math.max(this.hl.offsetHeight, this.scroll.clientHeight)}px`;
    } else {
      const w = Math.max(this.hl.scrollWidth, this.scroll.clientWidth);
      this.hl.style.width = '';
      this.input.style.width = `${w}px`;
      this.input.style.height = `${Math.max(this.hl.offsetHeight, this.scroll.clientHeight)}px`;
    }
  }

  _onInput() {
    const doc = this.doc;
    if (!doc) return;
    doc.text = this.input.value;
    doc.modified = true;
    this.matches = [];
    this.matchIdx = -1;
    if (this._raf) cancelAnimationFrame(this._raf);
    // Coalesce fast typing into one paint per frame; large files stay smooth.
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
      this._sizeInput();
      this._syncLines();
    });
    this.onChange(doc);
    this._onCursor();
  }

  _onCursor() {
    const doc = this.doc;
    if (!doc) return;
    const pos = this.input.selectionStart;
    const before = this.input.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - (before.lastIndexOf('\n') + 1) + 1;
    this.onCursor({ line, col });
    this._syncLines();
  }

  _onKey(e) {
    const doc = this.doc;
    if (!doc) return;
    const mod = e.ctrlKey || e.metaKey;

    // Tab / Shift+Tab: indent the selection instead of losing focus.
    if (e.key === 'Tab') {
      e.preventDefault();
      this._indent(e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !mod) {
      e.preventDefault();
      this._enter();
      return;
    }
    // Bracket/quote auto-close: only when nothing is selected, so a selection
    // can be wrapped the normal browser way.
    const closers = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    if (closers[e.key] && this.input.selectionStart === this.input.selectionEnd) {
      const after = this.input.value[this.input.selectionStart] || '';
      const isQuote = e.key === closers[e.key];
      // Typing a closing char when the next char IS that char just steps over.
      if (isQuote && after === e.key) {
        e.preventDefault();
        this.input.setSelectionRange(this.input.selectionStart + 1, this.input.selectionStart + 1);
        this._onCursor();
        return;
      }
      // Quotes only auto-close when the caret is at a word boundary.
      if (isQuote && /[\w"'`]/.test(after)) return;
      e.preventDefault();
      this._insert(e.key + closers[e.key]);
      this.input.setSelectionRange(this.input.selectionStart - 1, this.input.selectionStart - 1);
      return;
    }
    if ((e.key === ']' || e.key === ')' || e.key === '}') &&
        this.input.selectionStart === this.input.selectionEnd &&
        this.input.value[this.input.selectionStart] === e.key) {
      e.preventDefault();
      this.input.setSelectionRange(this.input.selectionStart + 1, this.input.selectionStart + 1);
      this._onCursor();
    }
  }

  /** Programmatic insert that preserves native undo where possible. */
  _insert(text) {
    const ok = document.execCommand && (() => {
      try { return document.execCommand('insertText', false, text); } catch { return false; }
    })();
    if (!ok) {
      const s = this.input.selectionStart;
      const v = this.input.value;
      this.input.value = v.slice(0, s) + text + v.slice(this.input.selectionEnd);
      this.input.setSelectionRange(s + text.length, s + text.length);
      this._onInput();
    }
  }

  _indent(outdent) {
    const input = this.input;
    const v = input.value;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const multi = e > s && v.slice(s, e + 1).includes('\n');
    if (!multi && !outdent) {
      this._insert('    ');
      return;
    }
    const end = v.indexOf('\n', e) === -1 ? v.length : v.indexOf('\n', e);
    const block = v.slice(lineStart, end);
    const lines = block.split('\n');
    const changed = lines.map((ln) => {
      if (outdent) {
        const m = ln.match(/^ {1,4}|^\t/);
        return m ? ln.slice(m[0].length) : ln;
      }
      return ln === '' ? ln : '    ' + ln;
    });
    const next = changed.join('\n');
    if (next === block) return;
    input.setSelectionRange(lineStart, end);
    this._insert(next);
    input.setSelectionRange(lineStart, lineStart + next.length);
  }

  _enter() {
    const input = this.input;
    const v = input.value;
    const pos = input.selectionStart;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(lineStart, pos);
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const prevCh = line.trimEnd().slice(-1);
    // A block opener adds a level; `case`/labels get one too (best effort).
    const extra = /[{(:[]$/.test(prevCh) ? '    ' : '';
    let insert = '\n' + indent + extra;
    // Enter between braces: push the closer onto its own line.
    const nextCh = v[pos] || '';
    if (prevCh === '{' && nextCh === '}') {
      insert = '\n' + indent + extra + '\n' + indent;
    }
    this._insert(insert);
    const caret = input.selectionStart - (prevCh === '{' && nextCh === '}' ? indent.length : 0);
    input.setSelectionRange(caret, caret);
    this._onCursor();
  }

  // ------------------------------------------------------------- find ----
  setFindState(st) {
    this.findState = st; // { q, caseSensitive }
  }

  /** Recompute matches for the current query; returns the count. */
  computeMatches(q, caseSensitive) {
    this.matches = [];
    this.matchIdx = -1;
    const text = this.input.value;
    if (q) {
      const hay = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? q : q.toLowerCase();
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1 && this.matches.length < 5000) {
        this.matches.push([i, i + q.length]);
        i += q.length;
      }
    }
    this._renderWithMatches();
    return this.matches.length;
  }

  gotoMatch(idx) {
    if (!this.matches.length) return;
    this.matchIdx = ((idx % this.matches.length) + this.matches.length) % this.matches.length;
    this._renderWithMatches();
    const [s] = this.matches[this.matchIdx];
    const row = this.input.value.slice(0, s).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(this.code).lineHeight) || 20;
    const view = this.scroll.clientHeight;
    const y = row * lh;
    if (y < this.scroll.scrollTop || y > this.scroll.scrollTop + view - lh * 2) {
      this.scroll.scrollTop = Math.max(0, y - view / 2);
    }
    this.lines.scrollTop = this.scroll.scrollTop;
  }

  nextMatch() { this.gotoMatch(this.matchIdx + 1); }
  prevMatch() { this.gotoMatch(this.matchIdx - 1); }

  /** Replace the current match (or the selection, if it matches). */
  replaceCurrent(replacement) {
    if (this.matchIdx < 0 || !this.matches[this.matchIdx]) return false;
    const [s, e] = this.matches[this.matchIdx];
    this.input.setSelectionRange(s, e);
    this._insert(replacement);
    this.computeMatches(this.findState?.q || '', this.findState?.caseSensitive || false);
    if (this.matches.length) this.gotoMatch(Math.min(this.matchIdx, this.matches.length - 1));
    return true;
  }

  replaceAll(replacement) {
    if (!this.matches.length) return 0;
    const q = this.findState?.q || '';
    if (!q) return 0;
    const text = this.input.value;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const next = text.replace(re, replacement);
    const n = this.matches.length;
    this.input.value = next;
    if (this.doc) {
      this.doc.text = next;
      this.doc.modified = true;
    }
    this._onInput();
    return n;
  }
}
