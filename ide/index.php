<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ide/index.php — the IDE app: a mobile-friendly code editor for this project.
//
// Standalone page AND one of the main app's screens: the studio opens it in a
// same-origin iframe under the apps notch. Apache's root .htaccess stamps
// X-Frame-Options: DENY on every response, so this entry point relaxes that to
// same-origin-only framing — a stranger's site still cannot embed it, the
// studio can.
//
// Every file operation goes to ide/api.php, which carries the same token gate
// as the main API. The page itself holds no data; the token arrives either
// from the parent window (postMessage handshake) or is pasted into the lock
// screen on first use.

header_remove('X-Frame-Options');
header("Content-Security-Policy: frame-ancestors 'self'");
?>
<!DOCTYPE html>
<!--
  Copyright 2026 M. Bryce Hudson
  SPDX-License-Identifier: Apache-2.0
-->
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="color-scheme" content="dark">
  <title>IDE // Autonomous Loop Studio</title>
  <link rel="stylesheet" href="css/ide.css?v=482">
</head>
<body>
  <!-- Token lock: shown when the API answers 401 and no token is known -->
  <div class="ide-lock" id="ideLock" hidden>
    <div class="ide-lock-card">
      <div class="ide-lock-title">IDE LOCKED</div>
      <p>This workspace requires an access token. Paste the one from
         Config &rarr; Access token in the main app.</p>
      <input id="lockToken" class="ide-lock-input" type="password"
             placeholder="access token" autocomplete="off" spellcheck="false">
      <button id="lockGo" class="ide-lock-btn" type="button">Unlock</button>
    </div>
  </div>

  <div class="ide" id="ide">
    <!-- ============ top bar ============ -->
    <header class="ide-top">
      <button class="ide-btn ide-nav" id="btnTree" title="Files" aria-label="Toggle file tree">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 3.5L2 8l3.5 4.5"/><path d="M8 3l4 10" opacity=".0"/><path d="M10.5 3.5L14 8l-3.5 4.5"/></svg>
        <span class="ide-nav-label">Files</span>
      </button>
      <div class="ide-brand">
        <span class="ide-dot"></span>
        <span class="ide-name">IDE</span>
        <span class="ide-ws" id="wsName">workspace</span>
      </div>
      <div class="ide-top-actions">
        <button class="ide-btn" id="btnNewFile" title="New file (Ctrl+Alt+N)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 1.8H4.2A1.2 1.2 0 0 0 3 3v10a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 13V5.8z"/><path d="M9 1.8V5.8H13"/><path d="M8 7.6v3.4M6.3 9.3h3.4"/></svg>
        </button>
        <button class="ide-btn" id="btnSearch" title="Find in project (Ctrl+Shift+F)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/></svg>
        </button>
        <button class="ide-btn" id="btnPalette" title="Command palette (Ctrl+K)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.8" y="4.5" width="12.4" height="7" rx="1.4"/><path d="M4.5 8h.01M7 8h.01M9.5 8h.01M12 8h.01" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="ide-btn" id="btnTheme" title="Theme">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4z" fill="currentColor" stroke="none" opacity=".55"/></svg>
        </button>
        <button class="ide-btn" id="btnGlass" title="Glass 2026 (Desktop 2026 look)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="8.5" height="8.5" rx="2"/><path d="M5.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7" opacity=".55"/></svg>
        </button>
        <button class="ide-btn ide-only-frame" id="btnPop" title="Open in browser tab">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M12.5 9.5v3.2a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.7V4.8a1.3 1.3 0 0 1 1.3-1.3h3.2"/></svg>
        </button>
      </div>
    </header>

    <!-- One strip for "this changed on disk while you have unsaved edits" -->
    <div class="ide-conflict" id="conflictBar" hidden>
      <span class="ide-conflict-text" id="conflictText"></span>
      <button class="ide-conflict-btn" id="conflictLoad" type="button">Load theirs</button>
      <button class="ide-conflict-btn" id="conflictKeep" type="button">Keep mine</button>
      <button class="ide-conflict-btn" id="conflictHide" type="button" title="Dismiss">✕</button>
    </div>

    <!-- ============ body: tree | editor ============ -->
    <div class="ide-body">
      <aside class="ide-side" id="ideSide">
        <div class="ide-side-head">
          <span class="ide-side-title">EXPLORER</span>
          <button class="ide-mini" id="btnRefresh" title="Refresh tree"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13.4 2.6v2.6h-2.6" /></svg></button>
          <button class="ide-mini" id="btnNewFolder" title="New folder"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 12.6V4a1.2 1.2 0 0 1 1.2-1.2h3l1.5 1.8h5.5A1.2 1.2 0 0 1 14.2 6v6.6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M8 7.2v3.2M6.4 8.8h3.2"/></svg></button>
          <button class="ide-mini" id="btnUpload" title="Upload file"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 10.5V2.6M4.8 5.4L8 2.2l3.2 3.2"/><path d="M2.5 10.5v2.7a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2v-2.7"/></svg></button>
        </div>
        <nav class="ide-tree" id="tree" aria-label="Project files"></nav>
        <input type="file" id="fileInput" multiple hidden>
      </aside>
      <div class="ide-gutter" id="gutter" aria-hidden="true"></div>

      <main class="ide-main">
        <div class="ide-tabs" id="tabs" role="tablist"></div>

        <div class="ide-editor-area" id="editorArea">
          <div class="ide-welcome" id="welcome">
            <div class="ide-welcome-logo">&lt;/&gt;</div>
            <div class="ide-welcome-title">AUTONOMOUS IDE</div>
            <div class="ide-welcome-sub">Open a file from the explorer, or press <kbd>Ctrl</kbd>+<kbd>K</kbd> for commands.</div>
            <div class="ide-welcome-tips">
              <span><kbd>Ctrl</kbd>+<kbd>S</kbd> save</span>
              <span><kbd>Ctrl</kbd>+<kbd>F</kbd> find</span>
              <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> project search</span>
            </div>
          </div>

          <div class="ide-editor" id="editor" hidden>
            <div class="ed-wrap" id="edWrap">
              <pre class="ed-hl" id="edHl" aria-hidden="true"><code id="edCode"></code></pre>
              <textarea class="ed-input" id="edInput" spellcheck="false" autocomplete="off"
                        autocapitalize="off" autocorrect="off" wrap="off"></textarea>
            </div>
          </div>

          <div class="ide-preview" id="preview" hidden>
            <img id="previewImg" alt="">
          </div>

          <!-- find / replace bar -->
          <div class="ed-find" id="edFind" hidden>
            <div class="ed-find-row">
              <input class="ed-find-input" id="findInput" placeholder="find" spellcheck="false">
              <span class="ed-find-count" id="findCount"></span>
              <button class="ide-mini" id="findPrev" title="Previous (Shift+Enter)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9.5L8 5.5l4 4"/></svg></button>
              <button class="ide-mini" id="findNext" title="Next (Enter)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6.5l4 4 4-4"/></svg></button>
              <button class="ide-mini" id="findToggleRep" title="Toggle replace"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6.5l4 4 4-4"/></svg></button>
              <button class="ide-mini" id="findClose" title="Close (Esc)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
            </div>
            <div class="ed-find-row" id="replaceRow" hidden>
              <input class="ed-find-input" id="replaceInput" placeholder="replace" spellcheck="false">
              <button class="ide-mini ed-rep-one" id="replaceOne" title="Replace">1</button>
              <button class="ide-mini" id="replaceAll" title="Replace all">all</button>
            </div>
          </div>

          <!-- project-wide search panel -->
          <div class="ide-search" id="searchPanel" hidden>
            <div class="ide-search-row">
              <input class="ide-search-input" id="searchInput" placeholder="search the whole project" spellcheck="false">
              <label class="ide-check"><input type="checkbox" id="searchCase"> Aa</label>
              <label class="ide-check"><input type="checkbox" id="searchRegex"> .*</label>
              <button class="ide-mini" id="searchClose" title="Close"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
            </div>
            <div class="ide-search-results" id="searchResults"></div>
          </div>
        </div>

        <!-- status bar -->
        <footer class="ide-status">
          <span class="ide-status-item ide-status-path" id="stPath"></span>
          <span class="ide-status-item" id="stLang"></span>
          <span class="ide-status-item" id="stPos">Ln 1, Col 1</span>
          <span class="ide-status-item" id="stInfo"></span>
          <span class="ide-status-item ide-status-dirty" id="stDirty"></span>
          <span class="ide-status-item ide-spacer"></span>
          <button class="ide-status-btn" id="stWrap" title="Toggle word wrap">wrap</button>
          <span class="ide-status-item" id="stTheme">default</span>
        </footer>
      </main>
    </div>

    <!-- ============ mobile bottom toolbar ============ -->
    <nav class="ide-mobilebar" id="mobileBar">
      <button class="mb-btn" id="mbFiles"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.8 3h10.4M2.8 6h10.4M2.8 9h6.4M2.8 12h4.4"/></svg><span>Files</span></button>
      <button class="mb-btn" id="mbFind"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/></svg><span>Find</span></button>
      <button class="mb-btn" id="mbSave"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.8 13.2H3.2A1.2 1.2 0 0 1 2 12V4a1.2 1.2 0 0 1 1.2-1.2h7.4L13.8 6v6a1.2 1.2 0 0 1-1.2 1.2z"/><path d="M5 2.8v3.4h5.2V2.8M5 13.2v-4h6v4"/></svg><span>Save</span></button>
      <button class="mb-btn" id="mbTheme"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4z" fill="currentColor" stroke="none" opacity=".55"/></svg><span>Theme</span></button>
      <button class="mb-btn" id="mbMore"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.8" y="4.5" width="12.4" height="7" rx="1.4"/><path d="M4.5 8h.01M7 8h.01M9.5 8h.01M12 8h.01" stroke-width="2" stroke-linecap="round"/></svg><span>Menu</span></button>
    </nav>
  </div>

  <!-- command palette -->
  <div class="ide-palette" id="palette" hidden>
    <div class="ide-palette-card" role="dialog" aria-label="Command palette">
      <input class="ide-palette-input" id="paletteInput" placeholder="type a command…" spellcheck="false" autocomplete="off">
      <div class="ide-palette-list" id="paletteList"></div>
    </div>
  </div>

  <!-- inline ask dialog (replaces window.prompt: it is unusable on phones) -->
  <div class="ide-modal" id="askModal" hidden>
    <div class="ide-modal-card" role="dialog" aria-label="Input">
      <div class="ide-modal-title" id="askTitle"></div>
      <input class="ide-modal-input" id="askInput" spellcheck="false" autocomplete="off">
      <div class="ide-modal-row">
        <button class="ide-lock-btn ide-modal-cancel" id="askCancel" type="button">Cancel</button>
        <button class="ide-lock-btn ide-modal-ok" id="askOk" type="button">OK</button>
      </div>
    </div>
  </div>

  <!-- confirm dialog -->
  <div class="ide-modal" id="confirmModal" hidden>
    <div class="ide-modal-card" role="dialog" aria-label="Confirm">
      <div class="ide-modal-title" id="confirmText"></div>
      <div class="ide-modal-row">
        <button class="ide-lock-btn ide-modal-cancel" id="confirmNo" type="button">Cancel</button>
        <button class="ide-lock-btn ide-modal-ok" id="confirmYes" type="button">OK</button>
      </div>
    </div>
  </div>

  <div class="ide-toasts" id="toasts"></div>

  <script type="module" src="js/ide.js?v=482"></script>
</body>
</html>
