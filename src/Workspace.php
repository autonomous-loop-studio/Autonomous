<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

namespace Src;

/**
 * Workspace — one write path for the IDE and the agents.
 *
 * Before this class there were two writers and no shared truth: the IDE saved
 * through `ide/api.php`, and an agent wrote through `Sandbox::writeFile`. So an
 * agent edit landed on disk while the editor kept showing its old buffer, and a
 * user save could land on top of a file an agent had just rewritten — with no
 * record anywhere that either had happened.
 *
 * Every mutation now goes through here, and every mutation leaves a line in
 * `storage/ide/revs.jsonl`:
 *
 *   {rev, path, op, actor, at, bytes, hash, prev}
 *
 * `rev` is a single counter for the whole tree, so a client that remembers the
 * last rev it saw can ask "what happened since?" and get exactly the answer —
 * which is what the IDE polls and what the chat reads to say "edited X".
 *
 * Why a polling log and not a socket: this app's supported serving modes include
 * `php -S`, which is single-threaded — one held-open stream would block every
 * other request, including the one the agent is waiting on. A 1.5s poll of a
 * small document behaves the same on `php -S`, Apache and nginx.
 *
 * The log lives under `storage/`, which every serving mode already refuses to
 * serve and which `resolve()` refuses to reach, so it is readable only through
 * `ide/api.php?action=revs`, never as a file.
 *
 * Old content is kept content-addressed in `storage/ide/blobs/<sha1>` so an
 * agent's edit can be undone and a diff can be shown without a second history
 * store.
 */
class Workspace
{
    /** Folder names never reachable through the file API, at any depth. */
    public const DENIED_DIRS = ['storage', 'logs', 'tmp', 'sessions', '.git',
        'node_modules', '.venv', 'venv', '__pycache__'];

    /** How many change lines `changes()` will ever return in one answer. */
    public const MAX_CHANGES = 400;

    /** A test-only root override; null means "this app". */
    private static ?string $root = null;

    /** Point the class at another tree (tests). Call with no argument to reset. */
    public static function useRoot(?string $dir = null): void
    {
        if ($dir === null) {
            self::$root = null;
            return;
        }
        $real = realpath($dir);
        self::$root = rtrim(str_replace('\\', '/', $real === false ? $dir : $real), '/');
    }

    public static function root(): string
    {
        if (self::$root !== null) {
            return self::$root;
        }
        $real = realpath(dirname(__DIR__));
        return str_replace('\\', '/', $real === false ? dirname(__DIR__) : $real);
    }

    // ------------------------------------------------------------- paths ----

    /**
     * Resolve a workspace-relative (or absolute-but-inside) path.
     *
     * Rules, the same ones `ide/api.php` has always enforced:
     *   * `..` is honoured but may never leave the root;
     *   * the runtime/secret folders are refused at ANY depth, and so are
     *     dot-directories other than ordinary project dotfiles;
     *   * the resolved path must stay inside the root. For a file that does not
     *     exist yet, the nearest existing ancestor is what gets contained.
     *
     * Absolute paths are accepted when they resolve inside the root — the chat
     * hands over the absolute path a tool reported, and refusing it there would
     * mean guessing the workspace prefix in the browser.
     *
     * @throws \RuntimeException  message starts with 'not found' (404),
     *                            'folder not accessible' (403) or another
     *                            refusal (400); `ide/api.php` maps them.
     */
    public static function resolve(string $rel, bool $mustExist = true): string
    {
        $root = self::root();
        $input = str_replace('\\', '/', trim($rel));
        if ($input === '') {
            $input = '.';
        }

        $absolute = (bool) preg_match('#^(?:[A-Za-z]:/|//|/)#', $input);
        if ($absolute) {
            $abs = rtrim($input, '/');
            if ($abs === '') {
                $abs = '/';
            }
            $real = realpath($abs);
            if ($real !== false) {
                $real = str_replace('\\', '/', $real);
                if (!self::inside($real)) {
                    throw new \RuntimeException('path escapes the workspace');
                }
                self::denySegments(self::relativeTo($real));
                return $real;
            }
            if ($mustExist) {
                throw new \RuntimeException('not found');
            }
            $parent = $abs;
            while (($real = @realpath($parent)) === false) {
                $up = dirname($parent);
                if ($up === $parent) {
                    throw new \RuntimeException('path escapes the workspace');
                }
                $parent = $up;
            }
            $real = str_replace('\\', '/', $real);
            if (!self::inside($real)) {
                throw new \RuntimeException('path escapes the workspace');
            }
            self::denySegments(self::relativeTo($abs));
            return $abs;
        }

        $parts = [];
        foreach (explode('/', $input) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                if (!$parts) {
                    throw new \RuntimeException('path escapes the workspace');
                }
                array_pop($parts);
                continue;
            }
            $parts[] = $seg;
        }
        self::denySegments(implode('/', $parts));
        if (!$parts) {
            $parts = ['.'];
        }

        $path = $root . '/' . implode('/', $parts);
        $real = realpath($path);
        if ($real !== false) {
            $real = str_replace('\\', '/', $real);
            if (!self::inside($real)) {
                throw new \RuntimeException('path escapes the workspace');
            }
            return $real;
        }
        if ($mustExist) {
            throw new \RuntimeException('not found');
        }
        $parent = $path;
        while (($real = @realpath($parent)) === false) {
            $up = dirname($parent);
            if ($up === $parent) {
                throw new \RuntimeException('path escapes the workspace');
            }
            $parent = $up;
        }
        $real = str_replace('\\', '/', $real);
        if (!self::inside($real)) {
            throw new \RuntimeException('path escapes the workspace');
        }
        return $path;
    }

    /** Workspace-relative path for anything inside the root. */
    public static function relative(string $abs): string
    {
        $abs = str_replace('\\', '/', $abs);
        if (!self::inside($abs)) {
            throw new \RuntimeException('path escapes the workspace');
        }
        return self::relativeTo($abs);
    }

    private static function relativeTo(string $abs): string
    {
        $root = self::root();
        $rel = substr(str_replace('\\', '/', $abs), strlen($root));
        return ltrim($rel, '/');
    }

    private static function inside(string $abs): bool
    {
        $root = self::root();
        if (strcasecmp(substr($abs, 0, strlen($root)), $root) !== 0) {
            return false;
        }
        $rest = substr($abs, strlen($root));
        return $rest === '' || $rest[0] === '/';
    }

    /** @throws \RuntimeException when a segment names a folder we never touch. */
    private static function denySegments(string $rel): void
    {
        foreach (explode('/', $rel) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            $low = strtolower($seg);
            if (in_array($low, self::DENIED_DIRS, true)) {
                throw new \RuntimeException("folder not accessible: {$seg}");
            }
            if ($low[0] === '.' && !preg_match('/^[.][A-Za-z0-9_.-]+$/', $low)) {
                throw new \RuntimeException("folder not accessible: {$seg}");
            }
        }
    }

    // ------------------------------------------------------- the rev log ----

    private static function dir(): string
    {
        return self::root() . '/storage/ide';
    }

    private static function logPath(): string
    {
        return self::dir() . '/revs.jsonl';
    }

    private static function counterPath(): string
    {
        return self::dir() . '/rev';
    }

    private static function ensureDir(): bool
    {
        $dir = self::dir();
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return false;
        }
        $blobs = $dir . '/blobs';
        if (!is_dir($blobs) && !@mkdir($blobs, 0775, true) && !is_dir($blobs)) {
            return false;
        }
        return true;
    }

    /** The newest revision recorded, or 0 when nothing has been written yet. */
    public static function currentRev(): int
    {
        $raw = @file_get_contents(self::counterPath());
        return $raw === false ? 0 : max(0, (int) trim($raw));
    }

    /**
     * Changes newer than `$since`, oldest first.
     *
     * @return array<int,array{rev:int,path:string,op:string,actor:string,at:int,bytes:int,hash:string,prev:string}>
     */
    public static function changes(int $since = 0, int $limit = self::MAX_CHANGES): array
    {
        $path = self::logPath();
        if (!is_file($path)) {
            return [];
        }
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            return [];
        }
        @flock($handle, LOCK_SH);
        $out = [];
        while (($line = fgets($handle)) !== false) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $row = json_decode($line, true);
            if (!is_array($row) || !isset($row['rev'])) {
                continue;
            }
            if ((int) $row['rev'] <= $since) {
                continue;
            }
            $out[] = $row;
            if (count($out) > $limit) {
                array_shift($out);   // keep the newest window, not the oldest
            }
        }
        @flock($handle, LOCK_UN);
        fclose($handle);
        return $out;
    }

    /**
     * Record one change and return its revision.
     *
     * Never throws for a path outside the workspace — a write that succeeded
     * must not fail because the audit could not name it. Callers that need to
     * know should use `write()` instead, which resolves first.
     */
    public static function note(string $pathOrAbs, string $op = 'write', string $actor = 'user',
                                int $bytes = 0, array $extra = []): int
    {
        try {
            $rel = self::relative(self::resolve($pathOrAbs, false));
        } catch (\RuntimeException $e) {
            return 0;
        }
        return self::append($rel, $op, $actor, $bytes, $extra);
    }

    /** `note()` for callers whose work must not fail on an audit problem. */
    public static function noteSafe(string $pathOrAbs, string $op = 'write', string $actor = 'user',
                                    int $bytes = 0, array $extra = []): void
    {
        try {
            self::note($pathOrAbs, $op, $actor, $bytes, $extra);
        } catch (\Throwable $e) {
            // A failed audit line must never fail the write it describes.
        }
    }

    private static function append(string $rel, string $op, string $actor, int $bytes, array $extra = []): int
    {
        if (!self::ensureDir()) {
            return 0;
        }
        $lock = @fopen(self::dir() . '/rev.lock', 'c+');
        if ($lock === false) {
            return 0;
        }
        @flock($lock, LOCK_EX);
        try {
            $rev = self::currentRev() + 1;
            @file_put_contents(self::counterPath(), (string) $rev, LOCK_EX);
            $row = array_merge([
                'rev' => $rev,
                'path' => $rel,
                'op' => $op,
                'actor' => $actor,
                'at' => time(),
                'bytes' => $bytes,
                'hash' => '',
                'prev' => '',
            ], $extra);
            $row['rev'] = $rev;
            @file_put_contents(self::logPath(), json_encode($row, JSON_UNESCAPED_SLASHES) . "\n",
                FILE_APPEND | LOCK_EX);
            return $rev;
        } finally {
            @flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    // ---------------------------------------------------------- snapshots ----

    private static function blobPath(string $hash): string
    {
        return self::dir() . '/blobs/' . preg_replace('/[^a-f0-9]/i', '', $hash);
    }

    /** Keep a copy of a version so it can be restored or diffed later. */
    public static function remember(string $text): string
    {
        $hash = sha1($text);
        if (!self::ensureDir()) {
            return $hash;
        }
        $file = self::blobPath($hash);
        if (!is_file($file)) {
            @file_put_contents($file, $text, LOCK_EX);
        }
        return $hash;
    }

    /** The text kept under a hash, or null when it is gone. */
    public static function blob(string $hash): ?string
    {
        $file = self::blobPath($hash);
        if ($hash === '' || !is_file($file)) {
            return null;
        }
        $text = @file_get_contents($file);
        return $text === false ? null : $text;
    }

    // -------------------------------------------------------------- writes ----

    /**
     * Write a file through the shared path: snapshot the old text, write the
     * new text, record the revision. This is the only writer the IDE uses.
     *
     * @return array{path:string,rev:int,hash:string,prev:string,size:int}
     */
    public static function write(string $rel, string $content, string $actor = 'user'): array
    {
        $abs = self::resolve($rel, false);
        if (is_dir($abs)) {
            throw new \RuntimeException('is a folder');
        }
        $parent = dirname($abs);
        if (!is_dir($parent) && !@mkdir($parent, 0777, true) && !is_dir($parent)) {
            throw new \RuntimeException('cannot create folder');
        }
        $content = (string) $content;
        $previous = is_file($abs) ? @file_get_contents($abs) : false;
        $prevHash = $previous === false ? '' : self::remember($previous);
        $bytes = @file_put_contents($abs, $content, LOCK_EX);
        if ($bytes === false) {
            throw new \RuntimeException('cannot write file');
        }
        // Keep this version too, so a `hash` in the log always resolves: the
        // newest version is what a diff, or "undo this edit", asks for first.
        $hash = self::remember($content);
        $rel = self::relative($abs);
        $rev = self::append($rel, 'write', $actor, strlen($content), [
            'hash' => $hash,
            'prev' => $prevHash,
        ]);
        return ['path' => $rel, 'rev' => $rev, 'hash' => $hash, 'prev' => $prevHash, 'size' => strlen($content)];
    }

    /** Remove a file (or folder) and record it. Used by the IDE's delete. */
    public static function remove(string $rel, string $actor = 'user'): void
    {
        $abs = self::resolve($rel, true);
        $relPath = self::relative($abs);
        $rev = self::append($relPath, 'delete', $actor, 0, []);
        if (is_dir($abs)) {
            self::removeTree($abs);
        } else {
            @unlink($abs);
        }
        if ($rev === 0) {
            return;   // nothing to say; the deletion stands either way
        }
    }

    private static function removeTree(string $dir): void
    {
        $names = @scandir($dir);
        if ($names === false) {
            return;
        }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $full = $dir . '/' . $name;
            if (is_dir($full) && !is_link($full)) {
                self::removeTree($full);
            } else {
                @unlink($full);
            }
        }
        @rmdir($dir);
    }
}
