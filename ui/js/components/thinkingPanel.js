/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// THINKINGPANEL.JS — Thinking overlay panel
// ============================================

import { store } from '../store.js?v=502';
import { esc, scrollFollowWanted } from '../utils.js?v=502';

export class ThinkingPanel {
  constructor() {
    this.panel = null;
    this.content = null;
    this.log = [];
  }

  init() {
    this.panel = document.getElementById('thinkingPanel');
    this.content = document.getElementById('thinkingContent');

    document.getElementById('thinkingClose')?.addEventListener('click', () => this.hide());

    // Listen for thinking events
    store.on('thinking:add', (entry) => this.addEntry(entry));
  }

  toggle() { this.panel.classList.toggle('hidden'); }
  show() { this.panel.classList.remove('hidden'); }
  hide() { this.panel.classList.add('hidden'); }

  addEntry(entry) {
    this.log.unshift(entry);
    if (this.log.length > 50) this.log.pop();
    this._render();
  }

  _render() {
    if (!this.content) return;
    // Auto Scroll is the same Config → Interface switch the transcript uses.
    // The log is newest-first, so following it means staying at the top; an
    // operator who scrolled down to read older entries is put back where they
    // were when the switch is off.
    const auto = scrollFollowWanted(store.get('settings.autoScroll'), null);
    const prior = this.panel ? this.panel.scrollTop : 0;
    this.content.innerHTML = this.log.map(e => `
      <div class="thinking-entry">
        <div class="thinking-agent" style="color:${e.color}">${esc(e.agentName)} <span class="thinking-time">${e.time}</span></div>
        <div>${esc(e.text)}</div>
      </div>
    `).join('');
    if (this.panel) this.panel.scrollTop = auto ? 0 : prior;
  }
}

export default ThinkingPanel;
