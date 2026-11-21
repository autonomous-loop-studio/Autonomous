/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// IDE screen — one of the studio's apps
// ============================================
//
// A thin host for the standalone IDE app (ide/index.php): a full-window
// dialog with an iframe, opened from the apps notch under the header like
// Brain Lab and the Routing Chart. The IDE is its own page with its own
// themes, so the iframe keeps the two apps' styles from ever touching.
//
// The one real job this class has is the token handshake: the IDE asks
// ("ide:hello") when it boots and the studio answers with the access token
// the user already configured ("ide:auth"), so the file API unlocks without
// the token being pasted a second time. The token never travels in a URL.

import { store } from './store.js?v=502';

export class IdeScreen {
  constructor() {
    this.el = null;
    this.open = false;
    this.frame = null;
  }

  init() {
    this._buildDom();
    document.body.appendChild(this.el);
  }

  _buildDom() {
    const el = document.createElement('div');
    el.className = 'ide-screen';
    el.id = 'ideScreen';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'IDE');
    // All interpolated values are literals or ids generated here — no user
    // text is ever in this template, so there is no injection surface.
    el.innerHTML = `
      <div class="ide-screen-head">
        <span class="ide-screen-dot"></span>
        <span class="ide-screen-title">IDE</span>
        <span class="ide-screen-hint">code · files · agents</span>
        <button class="ide-screen-btn" id="ideScreenPop" title="Open in a browser tab">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M12.5 9.5v3.2a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.7V4.8a1.3 1.3 0 0 1 1.3-1.3h3.2"/></svg>
        </button>
        <button class="ide-screen-btn" id="ideScreenClose" title="Close (Esc)">✕</button>
      </div>
      <iframe class="ide-screen-frame" id="ideScreenFrame" title="IDE"
        src="ide/index.php?v=502" allow="clipboard-write"></iframe>
    `;
    this.el = el;
    this.frame = el.querySelector('#ideScreenFrame');
    el.querySelector('#ideScreenClose').addEventListener('click', () => this.close());
    // Esc closes the screen from the studio side. Inside the iframe the IDE
    // handles its own Esc (its overlays first); a keydown in the parent
    // document means the user is asking for the screen itself to go away.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.close();
    });
    el.querySelector('#ideScreenPop').addEventListener('click', () => {
      window.open('ide/index.php?v=502', '_blank', 'noopener');
      this.close();
    });
    // Answer the handshake every time the frame (re)loads — the IDE re-asks
    // on boot, and if the user set the token only after opening this screen,
    // the reload the IDE's lock screen triggers still gets it.
    this.frame.addEventListener('load', () => { this._sendToken(); this._sendOpen(); });
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== this.frame?.contentWindow) return;
      if (e.data?.type === 'ide:hello') { this._sendToken(); this._sendOpen(); }
    });
  }

  /**
   * Open a file in the IDE from anywhere in the studio — the "Open in IDE" chip
   * under a file-writing tool call. Shows the screen and asks the iframe to open
   * the path; the request is held until the frame is listening, because a
   * message posted before the IDE's own script runs is simply lost.
   */
  openPath(path) {
    if (!path) return;
    this.pendingOpen = String(path);
    if (!this.open) this.show();
    else this._sendOpen();
  }

  _sendOpen() {
    if (!this.pendingOpen || !this.frame?.contentWindow) return;
    const path = this.pendingOpen;
    this.pendingOpen = '';
    try {
      this.frame.contentWindow.postMessage(
        { type: 'ide:open', path },
        window.location.origin,
      );
    } catch { /* frame not ready; the next load or hello retries */ }
  }

  _sendToken() {
    const token = store.get('settings.routerToken') || store.get('settings.sandboxToken');
    try {
      this.frame?.contentWindow?.postMessage(
        { type: 'ide:auth', token: token || '' },
        window.location.origin,
      );
    } catch { /* frame not ready yet; the next load event retries */ }
  }

  show() {
    if (!this.el) this.init();
    this.open = true;
    this.el.classList.add('open');
    document.body.style.overflow = 'hidden';   // the page behind must not scroll
    // A fresh token (typed into Config while this screen was closed) reaches
    // the IDE as soon as it opens.
    setTimeout(() => this._sendToken(), 50);
    setTimeout(() => this._sendOpen(), 400);
  }

  close() {
    this.open = false;
    this.el?.classList.remove('open');
    document.body.style.overflow = '';
  }

  toggle() {
    this.open ? this.close() : this.show();
  }
}

