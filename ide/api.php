<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ide/api.php — the file backend for the IDE app.
//
// A deliberately small, boring JSON endpoint. The IDE (ide/index.php) is just
// HTML/JS; every file operation it offers — browsing, reading, writing,
// renaming, deleting, searching — goes through this one script.
//
// SECURITY MODEL, copied from api/index.php on purpose:
//   * The same global token gate: X-Router-Token (or X-Sandbox-Token) checked
//     with hash_equals when sandbox.require_token is on; when the gate is OFF,
//     only same-machine requests are answered, exactly like the main API.
//   * Same path discipline as serve.php/.htaccess: every operation resolves to
//     a path inside the app root, and the folder names that hold secrets or
//     runtime data — storage/, logs/, tmp/, sessions/ — plus .git and any
//     dot-directory, are refused at every depth. storage/ holds the access
//     token and every API key; no IDE feature ever needs it.
//
// Endpoints (all JSON; GET for reads, POST for writes):
//   GET  ?action=info                 workspace name, root, limits
//   GET  ?action=list&path=           one directory: entries with type/size/mtime
//   GET  ?action=read&path=           file text (or a data URL preview for images)
//   GET  ?action=search&q=&path=&case=&regex=   grep across the project
//   GET  ?action=download&path=       raw bytes with a Content-Disposition
//   POST {action:"write",   path, content, encoding:"text"|"base64"}
//   POST {action:"create",  path, type:"file"|"dir"}
//   POST {action:"rename",  from, to}
//   POST {action:"delete",  path}     files unlinked; folders deleted recursively
//
// Agents use the same endpoints (that is the point of an agent-facing IDE),
// which is why every route takes a path and returns plain JSON.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/../autoload.php';

use Src\Config;
use Src\Sandbox;
use Src\Workspace;

const MAX_READ_BYTES  = 3145728;   // 3 MB of text is plenty for one editor tab
const MAX_WRITE_BYTES = 10485760;  // 10 MB written in one request
const MAX_SEARCH_FILE = 1048576;   // files above 1 MB are skipped when searching
const MAX_RESULTS     = 300;       // search result cap

/**
 * Folder names the IDE never touches, at any depth. The first four hold
 * secrets/runtime data (the same names .htaccess and serve.php refuse to
 * SERVE); the rest are dependency/build folders — thousands of files nobody
 * wants in an explorer or a project search.
 */
const DENIED_DIRS = ['storage', 'logs', 'tmp', 'sessions', '.git',
    'node_modules', '.venv', 'venv', '__pycache__'];

$ROOT = realpath(__DIR__ . '/..');
if ($ROOT === false) {
    fail(500, 'workspace root not found');
}

// ---------------------------------------------------------------- auth ----
// Mirrors the global gate in api/index.php, including its fail-closed
// behaviour: require_token with an EMPTY token is 503, not "everything open".
$sandboxCfg = Config::loadConfig()['sandbox'] ?? [];
$routerToken = trim((string)($sandboxCfg['token'] ?? ''));

if (!empty($sandboxCfg['require_token'])) {
    if ($routerToken === '') {
        fail(503, 'no token configured', 'This copy requires an access token but none is set. '
            . 'Run ./setup-token.sh to create one, or ./setup-token.sh --off to run without a token.');
    }
    $authed = false;
    foreach (['HTTP_X_ROUTER_TOKEN', 'HTTP_X_SANDBOX_TOKEN'] as $hdr) {
        $candidate = (string)($_SERVER[$hdr] ?? '');
        if ($candidate !== '' && hash_equals($routerToken, $candidate)) {
            $authed = true;
            break;
        }
    }
    if (!$authed) {
        fail(401, 'unauthorized');
    }
} elseif (!Sandbox::isLocalRequest($_SERVER)) {
    // Gate off: the main API then insists on local callers, and so does this.
    // Same reasoning — the IDE can rewrite the app's own source.
    fail(403, 'local requests only', 'No access token is set, so the IDE only answers requests '
        . 'from the machine it runs on. Set a token to use it from other devices.');
}

// ------------------------------------------------------------- helpers ----

function fail(int $code, string $error, string $detail = ''): void {
    http_response_code($code);
    echo json_encode($detail === '' ? ['error' => $error] : ['error' => $error, 'detail' => $detail]);
    exit(0);
}

function out(array $payload): void {
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit(0);
}

/**
 * Resolve a workspace-relative path safely. Returns an absolute filesystem
 * path, or dies with 400/403. Rules:
 *   * absolute paths, drive letters and UNC names are refused;
 *   * ".." is honoured but never allowed to leave the app root;
 *   * the runtime/secret folders (storage, logs, tmp, sessions), .git and any
 *     dot-directory are refused at ANY depth — the same names serve.php and
 *     the root .htaccess refuse to serve, for the same reason;
 *   * the resolved path must stay inside the app root (realpath containment,
 *     checking the deepest existing ancestor for not-yet-created files).
 */
function resolve_path(string $rel, bool $mustExist = true): string {
    try {
        return Workspace::resolve($rel, $mustExist);
    } catch (RuntimeException $e) {
        $msg = $e->getMessage();
        if (strpos($msg, 'not found') === 0) {
            fail(404, 'not found');
        }
        if (strpos($msg, 'not accessible') !== false) {
            fail(403, $msg);
        }
        fail(400, $msg);
    }
}

function is_binary_bytes(string $bytes): bool {
    $probe = substr($bytes, 0, 8192);
    return $probe !== '' && strpos($probe, "\0") !== false;
}

const TEXT_EXT = ['php','js','mjs','cjs','css','html','htm','json','md','txt','svg','xml',
    'yml','yaml','ini','env','sql','sh','bash','bat','cmd','ps1','py','rb','go','rs',
    'java','c','h','cpp','hpp','cs','ts','tsx','jsx','vue','scss','less','toml','conf'];

function is_text_name(string $name): bool {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return $ext === '' || in_array($ext, TEXT_EXT, true);
}

// ------------------------------------------------------------- actions ----

$action = (string)($_GET['action'] ?? '');
$input = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw = file_get_contents('php://input');
    $input = json_decode($raw ?: '', true);
    if (!is_array($input)) {
        fail(400, 'bad JSON body');
    }
    if ($action === '') {
        $action = (string)($input['action'] ?? '');
    }
}

switch ($action) {

    // ---- workspace metadata -------------------------------------------
    case 'info': {
        out([
            'root' => '.',
            'name' => basename($ROOT),
            'php'  => PHP_VERSION,
            'limits' => [
                'read' => MAX_READ_BYTES,
                'write' => MAX_WRITE_BYTES,
                'results' => MAX_RESULTS,
            ],
            'tokenRequired' => !empty($sandboxCfg['require_token']),
        ]);
    }

    // ---- what happened since a revision --------------------------------
    // The IDE polls this while it is visible; the chat reads the same lines to
    // say who edited a file. One counter for the whole tree, so "since" is
    // exact rather than a timestamp guess.
    case 'revs': {
        $since = max(0, (int)($_GET['since'] ?? 0));
        out([
            'rev' => Workspace::currentRev(),
            'changes' => Workspace::changes($since),
        ]);
    }

    // ---- one directory listing ----------------------------------------
    case 'list': {
        $dir = resolve_path((string)($_GET['path'] ?? '.'));
        if (!is_dir($dir)) {
            fail(400, 'not a folder');
        }
        $entries = [];
        $names = @scandir($dir);
        if ($names === false) {
            fail(403, 'cannot read folder');
        }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $low = strtolower($name);
            // The same names the web layers refuse to serve are hidden here
            // too: they are runtime data or VCS internals, not project code.
            if (in_array($low, DENIED_DIRS, true)) {
                continue;
            }
            if ($low[0] === '.' && !preg_match('/^[.][A-Za-z0-9_.-]+$/', $low)) {
                continue;
            }
            $full = $dir . '/' . $name;
            $isDir = is_dir($full);
            $entries[] = [
                'name' => $name,
                'dir'  => $isDir,
                'size' => $isDir ? 0 : (int)@filesize($full),
                'mtime' => (int)@filemtime($full),
            ];
        }
        usort($entries, function ($a, $b) {
            if ($a['dir'] !== $b['dir']) {
                return $a['dir'] ? -1 : 1;
            }
            return strcasecmp($a['name'], $b['name']);
        });
        out(['path' => (string)($_GET['path'] ?? '.'), 'entries' => $entries]);
    }

    // ---- read one file --------------------------------------------------
    case 'read': {
        $path = resolve_path((string)($_GET['path'] ?? ''));
        if (!is_file($path)) {
            fail(404, 'not found');
        }
        $size = (int)@filesize($path);
        $name = basename($path);
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));

        // Images get a data-URL preview; the editor pane renders them <img>.
        if (in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'], true)) {
            if ($size > 2097152) {
                fail(413, 'image too large to preview');
            }
            $bytes = @file_get_contents($path);
            if ($bytes === false) {
                fail(403, 'cannot read file');
            }
            out(['path' => (string)$_GET['path'], 'binary' => true,
                 'mime' => $ext === 'jpg' ? 'image/jpeg' : 'image/' . $ext,
                 'dataUrl' => 'data:image/' . ($ext === 'jpg' ? 'jpeg' : $ext) . ';base64,'
                     . base64_encode($bytes), 'size' => $size]);
        }

        if ($size > MAX_READ_BYTES) {
            fail(413, 'file too large', 'This file is bigger than the ' . round(MAX_READ_BYTES / 1048576)
                . ' MB the editor will open. Download it instead.');
        }
        $bytes = @file_get_contents($path);
        if ($bytes === false) {
            fail(403, 'cannot read file');
        }
        if (is_binary_bytes($bytes) || !is_text_name($name)) {
            fail(415, 'binary file', 'The editor only opens text files. This looks binary.');
        }
        out(['path' => (string)$_GET['path'], 'content' => $bytes, 'binary' => false, 'size' => $size]);
    }

    // ---- project-wide search -------------------------------------------
    case 'search': {
        $q = (string)($_GET['q'] ?? '');
        if ($q === '') {
            out(['q' => $q, 'results' => []]);
        }
        $foldCase = ($_GET['case'] ?? '0') !== '1';
        $useRegex = ($_GET['regex'] ?? '0') === '1';
        $from = resolve_path((string)($_GET['path'] ?? '.'));

        $needles = [];
        if ($useRegex) {
            $needles['re'] = $q;
        } elseif ($foldCase) {
            $needles['ci'] = strtolower($q);
        } else {
            $needles['cs'] = $q;
        }

        $results = [];
        // Prune denied folders DURING the walk: a plain LEAVES_ONLY iterator
        // would still descend into storage/ and yield its files as leaves.
        // The callback returns false for a denied directory, which stops the
        // iterator from ever entering it.
        $filter = new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($from, FilesystemIterator::SKIP_DOTS),
            function ($cur) {
                if (!$cur->isDir()) {
                    return true;
                }
                $low = strtolower($cur->getFilename());
                if (in_array($low, DENIED_DIRS, true)) {
                    return false;
                }
                return !($low[0] === '.' && !preg_match('/^[.][A-Za-z0-9_.-]+$/', $low));
            }
        );
        $it = new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($it as $file) {
            if (count($results) >= MAX_RESULTS) {
                break;
            }
            if ($file->isDir()) {
                continue;
            }
            $path = $file->getPathname();
            $name = $file->getFilename();
            $low = strtolower($name);
            if ((int)$file->getSize() > MAX_SEARCH_FILE || !is_text_name($name)) {
                continue;
            }
            $bytes = @file_get_contents($path);
            if ($bytes === false || is_binary_bytes($bytes)) {
                continue;
            }
            $rel = str_replace('\\', '/', substr($path, strlen($ROOT) + 1));
            $lines = preg_split('/\r\n|\r|\n/', $bytes);
            $count = 0;
            foreach ($lines as $i => $line) {
                $hit = false;
                if (isset($needles['re'])) {
                    $hit = @preg_match('~' . str_replace('~', '\~', $q) . '~' . ($foldCase ? 'i' : '') , $line) === 1;
                } elseif (isset($needles['ci'])) {
                    $hit = strpos(strtolower($line), $needles['ci']) !== false;
                } else {
                    $hit = strpos($line, $needles['cs']) !== false;
                }
                if ($hit) {
                    $count++;
                    if (count($results) < MAX_RESULTS) {
                        $results[] = ['path' => $rel, 'line' => $i + 1, 'text' => mb_substr($line, 0, 400)];
                    }
                }
            }
            // More than a handful of hits in one file still counts once:
            if ($count > 0 && count($results) >= MAX_RESULTS) {
                $results[] = ['path' => $rel, 'line' => 0, 'text' => '(more matches not shown)'];
                break;
            }
        }
        out(['q' => $q, 'results' => $results, 'truncated' => count($results) >= MAX_RESULTS]);
    }

    // ---- raw download ----------------------------------------------------
    case 'download': {
        $path = resolve_path((string)($_GET['path'] ?? ''));
        if (!is_file($path)) {
            fail(404, 'not found');
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . (string)filesize($path));
        header('Content-Disposition: attachment; filename="' . addslashes(basename($path)) . '"');
        header('X-Content-Type-Options: nosniff');
        @readfile($path);
        exit(0);
    }

    // ---- save (create or overwrite) --------------------------------------
    case 'write': {
        $path = resolve_path((string)($input['path'] ?? ''), false);
        $content = (string)($input['content'] ?? '');
        if (($input['encoding'] ?? 'text') === 'base64') {
            $content = base64_decode($content, true);
            if ($content === false) {
                fail(400, 'bad base64');
            }
        }
        if (strlen($content) > MAX_WRITE_BYTES) {
            fail(413, 'too large to save');
        }
        $existing = @realpath($path);
        if ($existing !== false) {
            if (is_dir($existing)) {
                fail(400, 'is a folder');
            }
            if (!is_binary_bytes((string)@file_get_contents($existing, false, null, 0, 8192))
                && !is_text_name(basename($existing))) {
                fail(415, 'binary file', 'Refusing to overwrite what looks like a binary file with text.');
            }
            $path = $existing;
        }
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
            fail(403, 'cannot create folder');
        }
        try {
            // Who wrote it. The IDE's own saves are the user; a tool call made on
            // the agent's behalf says so, so the log can tell "I did that" from
            // "an agent did that" — which is the whole reason the actor is
            // recorded. It is a label, not an authorization: the token gate and
            // the path jail have already decided whether this request may write
            // at all, and the only value that changes anything is the badge the
            // IDE draws next to the change.
            $actor = (($input['actor'] ?? '') === 'agent') ? 'agent' : 'user';
            $saved = Workspace::write($path, $content, $actor);
        } catch (RuntimeException $e) {
            fail(403, $e->getMessage());
        }
        // The revision is the IDE's own "did anything change" signal: a save
        // here and an agent's write_file look identical to both readers.
        out(['ok' => true, 'path' => $saved['path'], 'size' => $saved['size'], 'rev' => $saved['rev']]);
    }

    // ---- new file / new folder -------------------------------------------
    case 'create': {
        $type = ($input['type'] ?? 'file') === 'dir' ? 'dir' : 'file';
        $path = resolve_path((string)($input['path'] ?? ''), false);
        if (@file_exists($path) || @realpath($path) !== false) {
            fail(409, 'already exists');
        }
        if ($type === 'dir') {
            if (!@mkdir($path, 0777, true)) {
                fail(403, 'cannot create folder');
            }
        } else {
            $dir = dirname($path);
            if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
                fail(403, 'cannot create folder');
            }
            if (@file_put_contents($path, (string)($input['content'] ?? ''), LOCK_EX) === false) {
                fail(403, 'cannot create file');
            }
        }
        Workspace::noteSafe($path, $type === 'dir' ? 'mkdir' : 'create', 'user',
            $type === 'dir' ? 0 : strlen((string)($input['content'] ?? '')));
        out(['ok' => true]);
    }

    // ---- rename / move -----------------------------------------------------
    case 'rename': {
        $from = resolve_path((string)($input['from'] ?? ''));
        $to = resolve_path((string)($input['to'] ?? ''), false);
        if (!file_exists($from)) {
            fail(404, 'not found');
        }
        if (@file_exists($to)) {
            fail(409, 'target already exists');
        }
        if (!@rename($from, $to)) {
            // Cross-device or stubborn OneDrive locks: fall back to copy+unlink.
            if (is_dir($from)) {
                fail(403, 'cannot rename folder');
            }
            $bytes = @file_get_contents($from);
            if ($bytes === false || @file_put_contents($to, $bytes, LOCK_EX) === false) {
                fail(403, 'cannot rename file');
            }
            @unlink($from);
        }
        Workspace::noteSafe($to, 'rename', 'user', is_file($to) ? (int)@filesize($to) : 0, [
            'from' => (string)($input['from'] ?? ''),
        ]);
        out(['ok' => true]);
    }

    // ---- delete --------------------------------------------------------------
    // ---- exact replacement, on the same write path as a save -----------
    // The agent-facing twin of Sandbox::strReplace, but through the IDE's door,
    // so the operator's open editor sees the change at its next poll instead of
    // quietly drifting from what the agent believes is on disk. Ambiguity is
    // refused rather than guessed: an old_string that appears more than once is
    // almost always the wrong anchor.
    case 'edit': {
        $path = resolve_path((string)($input['path'] ?? ''));
        $old = (string)($input['old_string'] ?? '');
        $new = (string)($input['new_string'] ?? '');
        if (!is_file($path)) {
            fail(404, 'not a file');
        }
        if ($old === '') {
            fail(400, 'old_string is empty');
        }
        $raw = (string)@file_get_contents($path);
        $count = substr_count($raw, $old);
        if ($count === 0) {
            fail(409, 'old_string not found', 'Nothing in ' . basename($path) . ' matches that text.');
        }
        $all = !empty($input['replace_all']);
        if ($count > 1 && !$all) {
            fail(409, 'old_string is not unique', 'It appears ' . $count . ' times; add more context or pass replace_all.');
        }
        $updated = $all ? str_replace($old, $new, $raw)
            : substr_replace($raw, $new, (int)strpos($raw, $old), strlen($old));
        if (strlen($updated) > MAX_WRITE_BYTES) {
            fail(413, 'too large to save');
        }
        try {
            $saved = Workspace::write($path, $updated, 'agent');
        } catch (\RuntimeException $e) {
            fail(403, $e->getMessage());
        }
        out([
            'ok' => true,
            'path' => $saved['path'],
            'replaced' => $all ? $count : 1,
            'rev' => $saved['rev'],
        ]);
    }
    case 'delete': {
        $path = resolve_path((string)($input['path'] ?? ''));
        if (!file_exists($path)) {
            fail(404, 'not found');
        }
        Workspace::noteSafe($path, 'delete', 'user');
        if (is_dir($path)) {
            if (!rrmdir($path)) {
                fail(403, 'cannot delete folder (is something holding it open?)');
            }
        } elseif (!@unlink($path)) {
            fail(403, 'cannot delete file');
        }
        out(['ok' => true]);
    }

    default:
        fail(400, 'unknown action');
}

/**
 * Recursive folder delete. Every entry walks resolve_path's rules by
 * construction (it lives under an already-validated parent), so this can only
 * ever remove things the caller was allowed to name.
 */
function rrmdir(string $dir): bool {
    $names = @scandir($dir);
    if ($names === false) {
        return false;
    }
    foreach ($names as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $full = $dir . '/' . $name;
        if (is_dir($full) && !is_link($full)) {
            if (!rrmdir($full)) {
                return false;
            }
        } elseif (!@unlink($full)) {
            return false;
        }
    }
    return @rmdir($dir);
}
