/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// LINENUMBERS.JS — The gutter for code in the chat
// ============================================
//
// One source line, one number. Two shapes, because the two boxes scroll
// differently:
//
//   * `gutterFor(text)` — a <pre> of numbers, for a block that does NOT wrap
//     (`.code-block-pre code` is `white-space: pre`). It sits beside the code
//     as its own column and sticks to the left edge while the code scrolls
//     sideways, so the numbers never scroll out of view. Because the columns
//     share a font size and line-height, number N sits on line N.
//   * `numberedRows(text)` — one row per line, for a box that DOES wrap
//     (`.tool-call-value` is `pre-wrap`). A separate column would drift out of
//     step the moment a long line wrapped, so the number rides on the line
//     itself and hangs in the margin, the way an editor numbers a wrapped line.
//
// Both are decoration: the numbers are `aria-hidden` and `user-select: none`, so
// a screen reader and a copy both get the code and nothing else.

/** How many lines the text renders as (a trailing newline is not a line). */
export function countLines(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (src === '') return 0;
  return src.split('\n').length;
}

/**
 * The label column for a non-wrapping block, or null when there is nothing to
 * count (empty or a single line — one line needs no number to find it).
 */
export function gutterFor(text) {
  const count = countLines(text);
  if (count < 2) return null;
  const gutter = document.createElement('pre');
  gutter.className = 'cb-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  const out = [];
  for (let i = 1; i <= count; i++) out.push(String(i));
  gutter.textContent = out.join('\n');
  return gutter;
}

/**
 * One `<div class="ln-row">` per line for a wrapping box, or null when the text
 * is empty or a single line (the plain text is nicer there).
 */
export function numberedRows(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (src === '') return null;
  const lines = src.split('\n');
  if (lines.length < 2) return null;
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'ln-row';
    const num = document.createElement('span');
    num.className = 'ln-n';
    num.textContent = String(i + 1);
    num.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.className = 'ln-t';
    body.textContent = line;
    row.appendChild(num);
    row.appendChild(body);
    frag.appendChild(row);
  });
  return frag;
}

export default { countLines, gutterFor, numberedRows };
