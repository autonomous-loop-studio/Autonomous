# IDE — Autonomous Loop Studio

A mobile-friendly code editor for this project, in plain PHP/JS/HTML/CSS with
**zero dependencies** (no Monaco, no CodeMirror, no build step). It works
standalone in a browser tab AND as one of the main app's screens via the apps
notch under the header.

## Opening it

- **From the app:** tap the notch under the header → **IDE**. The studio opens
  the IDE in a same-origin iframe and hands over your access token
  automatically (a `postMessage` handshake) — no pasting.
- **Standalone:** visit `/ide/index.php` (e.g. `http://127.0.0.1:8080/ide/index.php`
  with `php -S 127.0.0.1:8080 serve.php`). If the workspace requires a token,
  the lock screen asks for the one from **Config → Access token**.

## Themes

The IDE mirrors the main app's two look systems:

- **Colour themes** — `default`, `matrix`, `cyberpunk` (same palettes as
  `ui/css/base.css`). Cycle with the palette button in the top bar.
- **Glass 2026** — the Desktop 2026 glass shell look (same glass gradient,
  edge, blur and radius as `ui/css/desktop2026.css`), toggled with the
  layers button. It stacks with any colour theme.

Choices persist in `localStorage` (`ide.theme.v1`, `ide.glass.v1`).

## Features

- File explorer with lazy folder loading, long-press/right-click menu
  (new file, new folder, rename, delete, download, copy path)
- Multi-tab editing with dirty markers and unsaved-changes guard
- Syntax highlighting for PHP, JS/TS, HTML/XML, CSS/SCSS, JSON, Markdown,
  Python, shell (hand-written tokenizer — `ide/js/highlight.js`)
- Line numbers, auto-indent, tab-indent, bracket/quote auto-close
- Find & replace in file (`Ctrl+F` / `Ctrl+H`-style replace row)
- Project-wide search with results panel (`Ctrl+Shift+F`)
- Command palette (`Ctrl+K`), word wrap, auto-save, image preview,
  file upload, drag-free gutter resize, mobile bottom toolbar

## Agent access (HTTP API)

Everything the UI can do, an agent can do — `ide/api.php` is a plain JSON
endpoint guarded exactly like the main API (same `X-Router-Token` gate, same
"local requests only" fallback). **`storage/`, `logs/`, `tmp/`, `sessions/`
and `.git` are refused at every depth** — they hold keys and runtime data.

| Method | Path / body | Purpose |
|---|---|---|
| GET | `?action=info` | workspace name + limits |
| GET | `?action=list&path=ui/js` | directory listing |
| GET | `?action=read&path=index.html` | file text (images → data URL) |
| GET | `?action=search&q=agent&case=0&regex=0` | project grep (denied folders pruned) |
| GET | `?action=download&path=` | raw bytes as attachment |
| POST | `{action:"write", path, content, encoding:"text"\|"base64"}` | create/overwrite a file |
| POST | `{action:"create", path, type:"file"\|"dir"}` | new file or folder |
| POST | `{action:"rename", from, to}` | rename / move |
| POST | `{action:"delete", path}` | delete (folders recursively) |

## Files

```
ide/
  index.php        entry page (also relaxes X-Frame-Options to same-origin)
  api.php          the file backend (token gate + path safety)
  .htaccess        Apache: SAMEORIGIN framing + no-cache for this folder
  css/ide.css      all styles + both theme systems
  js/api.js        fetch client, token handshake
  js/highlight.js  dependency-free tokenizer
  js/editor.js     the editing surface
  js/tree.js       explorer + context menu
  js/ide.js        app shell: tabs, palette, search, mobile bar, boot
```

## Server notes

- **Apache/XAMPP:** works out of the box (real `.php` files execute; `ide/.htaccess`
  overrides the app-wide `X-Frame-Options: DENY` for this folder only).
- **`php -S … serve.php`:** `serve.php` routes `/ide/index.php` and
  `/ide/api.php` to PHP — the same allowlist idea it already applies to
  `/api/index.php`.
