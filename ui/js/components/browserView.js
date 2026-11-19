/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// BROWSERVIEW.JS — the built-in browser screen
// ============================================
//
// A full-window panel that shows whatever an installed Chrome/Edge is looking
// at, and lets the operator drive it too: address bar, Go, click on the page,
// type, read the text. Agents reach the SAME browser through the browser_*
// tools, so an agent can log in (with the operator watching) and then act.
//
// The server does the work (src/Browser.php over the DevTools Protocol); this
// only sends commands and paints the screenshots. It is off unless Config →
// Labs → Browser is on, which the server enforces with a 403.

import { store } from '../store.js?v=499';
import { api } from '../api.js?v=499';
import { esc } from '../utils.js?v=499';
import { k } from '../storage.js?v=499';

/** Live auto-refresh is a sticky preference, not a per-visit toggle. */
const LIVE_KEY = k('browserLive');

export class BrowserView {
  constructor() {
    this.el = null;
    this.img = null;
    this.open = false;
    this.status = { enabled: false, available: false, running: false };
    this._timer = null;
    this._live = this._loadLive();
    this._busy = false;
    // One request at a time per kind. Without these, pressing Go twice (or the
    // Live poll overlapping a slow screenshot) queued requests in the browser's
    // connection pool and the whole screen crawled for minutes.
    this._navBusy = false;
    this._shotBusy = false;
    this._actBusy = false;
    // null = fit-to-width; otherwise a 0.2…3 multiplier of the container width.
    this._zoom = null;
    // Last painted frame (data URL) so identical screenshots are not re-set —
    // re-assigning src to the same data URL forces a decode/repaint flicker.
    this._lastFrame = null;
    this._tabUrl = '';
    // Watchdog for the loading veil: it must never outlive the request.
    this._veilTimer = null;
  }

  init() {
    const el = document.createElement('div');
    el.className = 'browser-screen';
    el.id = 'browserScreen';
    el.hidden = true;
    el.innerHTML = `
      <div class="bs-chrome">
        <div class="bs-tabstrip">
          <span class="bs-title">Browser</span>
          <span class="bs-tab-host" id="bsTabHost"></span>
        </div>
        <div class="bs-head">
          <button class="bs-ico" id="bsReload" title="Reload the page" aria-label="Reload">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
          <div class="bs-urlpill">
            <span class="bs-lock" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
            </span>
            <input class="bs-url" id="bsUrl" placeholder="https://…" spellcheck="false" autocomplete="off">
            <button class="bs-go" id="bsGo" title="Go" aria-label="Go">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>
            </button>
          </div>
          <div class="bs-right">
            <button class="bs-ico" id="bsLive" title="Refresh the view automatically" aria-label="Live">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </button>
            <label class="bs-check" title="Headless has no window; untick to watch a real window">
              <input type="checkbox" id="bsHeadless"><span>headless</span>
            </label>
            <button class="bs-btn" id="bsStartStop">Launch</button>
            <span class="bs-status" id="bsStatus"></span>
            <button class="bs-ico bs-panel-btn" id="bsPanel" title="Drive &amp; safety" aria-label="Drive and safety panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/></svg>
            </button>
            <button class="bs-ico" id="bsFull" title="Full screen" aria-label="Full screen" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>
            </button>
            <button class="bs-x" id="bsClose" title="Close" aria-label="Close">&#10005;</button>
          </div>
        </div>
        <div class="bs-body">
          <div class="bs-stage">
            <div class="bs-frame">
              <div class="bs-frame-bar">
                <span class="bs-frame-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="bs-frame-url" id="bsFrameUrl"></span>
              </div>
              <div class="bs-view"><img id="bsImg" alt="browser view"></div>
              <div class="bs-empty" id="bsEmpty" hidden>
                <b>Browser not running</b>
                <span>Press <b>Launch</b> above — or let an agent start it<br>with the browser_* tools.</span>
              </div>
              <div class="bs-load" id="bsLoad" aria-hidden="true"><i></i><span>Loading</span></div>
              <div class="bs-zoom" role="group" aria-label="Zoom">
                <button id="bsZoomOut" title="Zoom out" aria-label="Zoom out">−</button>
                <button id="bsZoomPct" class="bs-zoom-pct fit" title="Click to reset to fit">fit</button>
                <button id="bsZoomIn" title="Zoom in" aria-label="Zoom in">+</button>
              </div>
            </div>
          </div>
          <aside class="bs-side" id="bsSide">
            <div class="bs-side-h">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Drive it
            </div>
            <textarea class="bs-type" id="bsType" rows="3" placeholder="Type into the focused field…  (Ctrl/⌘+Enter sends)"></textarea>
            <div class="bs-side-row">
              <button class="bs-btn" id="bsTypeSend">Send text</button>
              <button class="bs-btn" id="bsEnter">Enter</button>
            </div>
            <button class="bs-btn" id="bsRead">Read page text</button>
            <pre class="bs-text" id="bsText"></pre>
            <div class="bs-side-h">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Block list
            </div>
            <textarea class="bs-blocklist" id="bsBlocklist" rows="5" spellcheck="false"
              placeholder="*.gov&#10;this.site.com/folder1/folder2/&#10;*website*&#10;10.0.0.1"></textarea>
            <div class="bs-side-row"><button class="bs-btn" id="bsBlockSave">Save block list</button></div>
            <div class="bs-hint">One pattern per line. <b>*</b> is a wildcard: <code>*.gov</code> blocks any .gov site, <code>*word*</code> blocks anything containing it, and a bare host or IP (<code>10.0.0.1</code>) blocks exactly that host. Enforced on every navigation — yours and the agents'.</div>
            <div class="bs-hint">Agents use the browser_* tools on this same page. Log in once here and the session sticks.</div>
          </aside>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.img = el.querySelector('#bsImg');
    this.img.decoding = 'async';

    el.querySelector('#bsClose').addEventListener('click', () => this.hide());
    el.querySelector('#bsGo').addEventListener('click', () => this.go());
    el.querySelector('#bsUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.go(); }
    });
    el.querySelector('#bsReload').addEventListener('click', () => this.shot({ veil: true }));
    el.querySelector('#bsLive').addEventListener('click', () => this._toggleLive());
    el.querySelector('#bsFull').addEventListener('click', () => this._toggleFull());
    // The browser can be taken out of fullscreen by its own chord (F11, Esc);
    // the button has to follow that rather than its last click.
    document.addEventListener('fullscreenchange', () => this._paintFull());
    el.querySelector('#bsStartStop').addEventListener('click', () => this._startStop());
    el.querySelector('#bsTypeSend').addEventListener('click', () => this.sendText());
    el.querySelector('#bsEnter').addEventListener('click', () => this.press('Enter'));
    el.querySelector('#bsRead').addEventListener('click', () => this.readText());
    el.querySelector('#bsBlockSave').addEventListener('click', () => this.saveBlocklist());
    el.querySelector('#bsPanel').addEventListener('click', () => {
      el.querySelector('.bs-side').classList.toggle('open');
    });
    el.querySelector('#bsZoomIn').addEventListener('click', () => this._zoomStep(0.1));
    el.querySelector('#bsZoomOut').addEventListener('click', () => this._zoomStep(-0.1));
    el.querySelector('#bsZoomPct').addEventListener('click', () => {
      this._zoom = null;
      this._applyZoom();
    });
    el.querySelector('#bsType').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.sendText(); }
    });
    this.img.addEventListener('click', (e) => this._click(e));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.open) return;
      // Never close the screen while the operator is typing in it.
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      // One layer at a time: the full-screen view first, then the pane.
      // Real fullscreen never reaches here -- the browser owns Escape and exits,
      // which is the same outcome.
      if (this.el.classList.contains('bs-immersive')) { this._toggleImmersive(); return; }
      this.hide();
    });
    // Live keeps running while the app tab is visible, even when this screen
    // is not — so returning to it (or an agent acting) shows the current page.
    document.addEventListener('visibilitychange', () => this._syncLive());
    store.subscribe('settings.browserLiveBackground', () => this._syncLive());
    this._syncLive();
    this.refreshStatus();
  }

  async refreshStatus() {
    try {
      this.status = { ...this.status, ...(await api.browserStatus()) };
    } catch { /* leave the last known */ }
    this._paintStatus();
    this._syncLive();
  }

  _paintStatus() {
    const s = this.status;
    const st = this.el.querySelector('#bsStatus');
    const startStop = this.el.querySelector('#bsStartStop');
    const disabled = !s.enabled || !s.available;
    // Decided BEFORE the early returns below: the empty-state panel is an
    // overlay on the stage, so "off" and "unavailable" have to leave it hidden
    // too. A running browser hides it unconditionally -- its label talks about
    // launching, and over a live page it read as a translucent veil that never
    // went away.
    const empty = this.el.querySelector('#bsEmpty');
    if (empty) empty.hidden = !(s.enabled && s.available && !s.running);
    ['bsGo', 'bsReload', 'bsLive', 'bsStartStop', 'bsTypeSend', 'bsEnter', 'bsRead'].forEach((id) => {
      const b = this.el.querySelector('#' + id);
      if (b) b.disabled = disabled;
    });
    if (!s.enabled) { st.textContent = 'Off — turn on in Config → Labs → Browser.'; return; }
    if (!s.available) { st.textContent = 'No Chrome or Edge found on this machine.'; return; }
    st.textContent = s.running ? `running on :${s.port}` : 'not running';
    // The checkbox follows the browser that is actually running, so a
    // headless instance opened by an agent is not silently restarted visible
    // on the next Launch, and a visible one stays visible.
    const headlessBox = this.el.querySelector('#bsHeadless');
    if (headlessBox && s.running) headlessBox.checked = !!s.headless;
    startStop.textContent = s.running ? 'Stop' : 'Launch';
    startStop.classList.toggle('running', !!s.running);
    startStop.disabled = false;
    if (!s.running) this._veilOff();
  }

  show() {
    this.open = true;
    this.el.hidden = false;
    // The app's fixed scanline veil is switched off in CSS while this is set.
    document.body.classList.add('browser-open');
    this._paintTab(this.el.querySelector('#bsUrl').value);
    this._syncLive();
    this._loadBlocklist();
    this.refreshStatus().then(() => { if (this.status.running) this.shot(); });
  }
  hide() {
    this.open = false;
    this.el.hidden = true;
    document.body.classList.remove('browser-open');
    // Closing the screen must never leave the veil up, or the app in fullscreen
    // (the toolbar button would be off-screen and only a browser chord could
    // get out).
    this._veilOff();
    if (document.fullscreenElement === this.el) {
      try { document.exitFullscreen(); } catch { /* already out */ }
    }
    this.el.classList.remove('bs-immersive');
    this._paintFull();
    // Live is NOT switched off here: it stays on (and keeps polling while the
    // app tab is visible) so coming back — or an agent acting — is never stale.
    this._syncLive();
  }
  toggle() { this.open ? this.hide() : this.show(); }

  _loadLive() {
    try { const v = localStorage.getItem(LIVE_KEY); return v === null ? true : v === '1'; }
    catch { return true; }
  }
  _saveLive() {
    try { localStorage.setItem(LIVE_KEY, this._live ? '1' : '0'); } catch { /* private mode */ }
  }

  _toast(message, type = 'info') {
    try { store.emit('toast', { message, type }); } catch { /* no store */ }
  }

  async _startStop() {
    if (this._busy) return;
    this._busy = true;
    try {
      if (this.status.running) {
        await api.browserStop();
        this._toast('Browser stopped');
      } else {
        const headless = this.el.querySelector('#bsHeadless').checked;
        this._toast(headless ? 'Starting headless browser…' : 'Starting the browser window…');
        await api.browserLaunch(headless);
        this._toast('Browser ready');
      }
    } catch (e) {
      this._toast(`Browser: ${e.message}`, 'error');
    } finally {
      this._busy = false;
      await this.refreshStatus();
      if (this.status.running) this.shot({ veil: true });
    }
  }

  async go() {
    if (this._navBusy) return;
    const url = this.el.querySelector('#bsUrl').value.trim();
    if (!url) return;
    this._navBusy = true;
    const st = this.el.querySelector('#bsStatus');
    if (st) st.textContent = 'loading…';
    try {
      const info = await api.browserNavigate(url);
      if (info && info.url) {
        this.el.querySelector('#bsUrl').value = info.url;
        this._paintTab(info.url);
      }
      await this.shot({ veil: true });
    } catch (e) {
      this._toast(`Navigate: ${e.message}`, 'error');
    } finally {
      this._navBusy = false;
      this._paintStatus();
    }
  }

  /**
   * Pull one frame. `opts.veil` shows the loading veil — used for deliberate
   * actions (Go, Reload, first frame). The Live poll passes nothing: a veil
   * pulsing every two seconds would read as the page endlessly reloading.
   */
  async shot(opts = {}) {
    if (!this.status.running || this._shotBusy) return;
    this._shotBusy = true;
    if (!!opts.veil || !this._lastFrame) this._veilOn();
    try {
      const res = await api.browserScreenshot();
      // Newer servers answer with a JPEG (`img` + `mime`); older ones with PNG.
      const b64 = (res && (res.img || res.png)) || '';
      if (b64) {
        const mime = res.img ? (res.mime || 'image/jpeg') : 'image/png';
        const frame = `data:${mime};base64,${b64}`;
        if (frame !== this._lastFrame) {
          this._lastFrame = frame;
          this.img.src = frame;
        }
        if (res.url) this._paintTab(res.url);
      }
    } catch { /* keep the last frame */ }
    finally {
      this._shotBusy = false;
      this._veilOff();
    }
  }

  /** Show the current page in the faux tab and the frame's address line. */
  _paintTab(url) {
    if (!url) return;
    this._tabUrl = url;
    let host = url;
    try { host = new URL(url).host || url; } catch { /* opaque URL: show raw */ }
    const hostEl = this.el.querySelector('#bsTabHost');
    const frameEl = this.el.querySelector('#bsFrameUrl');
    if (hostEl) hostEl.textContent = host;
    if (frameEl) frameEl.textContent = url;
  }

  /** Zoom is a multiplier of the frame width; `null` means fit. */
  _zoomStep(delta) {
    this._zoom = Math.min(3, Math.max(0.2, (this._zoom || 1) + delta));
    this._applyZoom();
  }
  _applyZoom() {
    const pct = this.el.querySelector('#bsZoomPct');
    if (this._zoom == null) {
      this.img.style.width = '';
      this.img.style.maxWidth = '100%';
      if (pct) { pct.textContent = 'fit'; pct.classList.add('fit'); }
    } else {
      this.img.style.maxWidth = 'none';
      this.img.style.width = Math.round(this._zoom * 100) + '%';
      if (pct) {
        pct.textContent = Math.round(this._zoom * 100) + '%';
        pct.classList.remove('fit');
      }
    }
  }

  _toggleLive() {
    this._live = !this._live;
    this._saveLive();
    this._syncLive();
    if (this._live && this.status.running) this.shot();
  }

  /**
   * Full screen for the page we are watching. Real fullscreen where the API
   * exists; the CSS screen (chrome stripped) where it does not, so a phone gets
   * the same view instead of a dead button.
   */
  _toggleFull() {
    const el = this.el;
    if (!el) return;
    // Already filling the display one way or the other: one press leaves.
    if (document.fullscreenElement === el || el.classList.contains('bs-immersive')) {
      if (document.fullscreenElement === el) {
        try { document.exitFullscreen(); } catch { /* already out */ }
      }
      el.classList.remove('bs-immersive');
      this._paintFull();
      return;
    }
    const ask = el.requestFullscreen && el.requestFullscreen.bind(el);
    if (!ask) { this._toggleImmersive(); return; }
    // A request can fail (an iframe, a kiosk policy, no user gesture) and some
    // environments never settle it at all. Either way the operator asked for a
    // full screen, so one that cannot arrive is replaced by the CSS one after a
    // moment rather than leaving a button that looks dead.
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._toggleImmersive();
    };
    const timer = setTimeout(fallback, 600);
    ask().then(() => {
      settled = true;
      clearTimeout(timer);
      this._paintFull();
    }, fallback);
  }

  _toggleImmersive() {
    this.el?.classList.toggle('bs-immersive');
    this._paintFull();
  }

  _paintFull() {
    const btn = this.el?.querySelector('#bsFull');
    if (!btn) return;
    const on = document.fullscreenElement === this.el
      || this.el.classList.contains('bs-immersive');
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Leave full screen' : 'Full screen';
    btn.setAttribute('aria-label', btn.title);
  }

  /**
   * The loading veil is a promise the screen has to keep: it comes off whatever
   * happens to the request behind it. A screenshot that never settles (a wedged
   * CDP connection, a page that is still painting) used to leave it up for good
   * -- a translucent overlay over a page that had already rendered.
   */
  _veilOn() {
    const veil = this.el?.querySelector('#bsLoad');
    if (!veil) return;
    clearTimeout(this._veilTimer);
    veil.classList.add('on');
    this._veilTimer = setTimeout(() => this._veilOff(), 7000);
  }

  _veilOff() {
    clearTimeout(this._veilTimer);
    this._veilTimer = null;
    this.el?.querySelector('#bsLoad')?.classList.remove('on');
  }

  /**
   * Start/stop the Live poll to match the sticky preference, the browser's
   * running state, and tab visibility. The poll keeps going while the app tab
   * is visible even if this screen is hidden, so it "stays live".
   */
  /** Config → Labs → "Keep Live running when hidden". */
  _bgLive() { return (store.get('settings') || {}).browserLiveBackground !== false; }

  _syncLive() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.el?.querySelector('#bsLive')?.classList.toggle('active', this._live);
    const want = this._live && this.status.running && !document.hidden
      && (this.open || this._bgLive());
    if (!want) return;
    this._timer = setInterval(() => {
      if (!this._live || !this.status.running || document.hidden) return;
      if (!this.open && !this._bgLive()) return;
      if (!this._shotBusy) this.shot();
    }, 2000);
  }

  async _click(e) {
    if (!this.status.running || this._actBusy) return;
    this._actBusy = true;
    try {
      const rect = this.img.getBoundingClientRect();
      const nx = this.img.naturalWidth || rect.width;
      const ny = this.img.naturalHeight || rect.height;
      const x = (e.clientX - rect.left) * (nx / rect.width);
      const y = (e.clientY - rect.top) * (ny / rect.height);
      await api.browserClick(Math.round(x), Math.round(y));
      await this.shot();
    } catch (err) { this._toast(`Click: ${err.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async sendText() {
    if (this._actBusy) return;
    const box = this.el.querySelector('#bsType');
    const text = box.value;
    if (!text) return;
    this._actBusy = true;
    try { await api.browserType(text); box.value = ''; await this.shot(); }
    catch (e) { this._toast(`Type: ${e.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async press(key) {
    if (this._actBusy) return;
    this._actBusy = true;
    try { await api.browserKey(key); await this.shot(); }
    catch (e) { this._toast(`Key: ${e.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async readText() {
    try {
      const res = await api.browserRead();
      this.el.querySelector('#bsText').textContent = String(res.text || '').slice(0, 20000);
    } catch (e) { this._toast(`Read: ${e.message}`, 'error'); }
  }

  /** Fill the block-list box from the server config (never clobber typing). */
  async _loadBlocklist() {
    try {
      const cfg = await api.getConfig();
      const list = (cfg && cfg.browser && Array.isArray(cfg.browser.blocklist)) ? cfg.browser.blocklist : [];
      const ta = this.el.querySelector('#bsBlocklist');
      if (ta && document.activeElement !== ta) ta.value = list.join('\n');
    } catch { /* leave whatever is shown */ }
  }

  async saveBlocklist() {
    const ta = this.el.querySelector('#bsBlocklist');
    const lines = String(ta.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    try {
      const cfg = await api.getConfig();
      cfg.browser = { ...(cfg.browser || {}), blocklist: lines };
      await api.saveConfig(cfg);
      ta.value = lines.join('\n');
      this._toast(`Block list saved (${lines.length} rule${lines.length === 1 ? '' : 's'})`);
    } catch (e) { this._toast(`Block list not saved: ${e.message}`, 'error'); }
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._veilOff();
    this.el?.remove();
  }
}

export default BrowserView;
