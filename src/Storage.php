<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

namespace Src;

/**
 * Can this request write storage/?
 *
 * A copy whose storage/ is owned by root is not a slow install. It is a copy
 * where every save is dropped: a Config toggle snaps back, a session file is
 * never created, state sync answers a write that did not happen, and an agent's
 * turn can look exactly like a model thinking forever -- because nothing the
 * request produced could be recorded. The symptom is a hang; the cause is a
 * permission, and nothing in the app used to say so.
 *
 * So the check happens before the request does any work, and the refusal names
 * the one command that fixes it. That command has to be EXACT: the folder, the
 * user PHP is running as, and the same user as the group. A message that says
 * "check your permissions" leaves the operator guessing at all three.
 *
 * The probe is a real write, not is_writable(): a cloud-synced folder
 * (OneDrive, Dropbox) can carry a read-only reparse tag that makes
 * is_writable() false while real writes succeed, and the reverse mistake is
 * just as possible with ACLs. One stat is cheap; one wrong refusal on a healthy
 * install is not.
 *
 * CLI is never guarded. The suite, the tools and the installers run as the
 * owner of the tree; `php serve.php --check` already probes storage and prints
 * its own line, and an installer that refuses to run until permissions are
 * fixed cannot be the thing that fixes them.
 *
 * Windows has no chown, and inventing one would be worse than saying nothing.
 * There the refusal names the folder and the account instead, and `command()`
 * is empty so no caller can print a POSIX line on a host where it would fail.
 */
class Storage
{
    /** This app's storage/, forward-slashed, no trailing slash. */
    public static function path()
    {
        return rtrim(str_replace('\\', '/', dirname(__DIR__)), '/') . '/storage';
    }

    /**
     * The account PHP is running as, or '' when that cannot be established.
     *
     * posix_geteuid() is the truth when the extension is there: it reports the
     * process's own uid, which under Apache/FPM is the account that cannot write
     * the folder. The env fallbacks exist for hosts that build PHP without
     * posix; APACHE_RUN_USER is the account Apache drops to, and USER/LOGNAME are
     * set by most FPM pools. A value that is still a template (`${...}`) is not
     * an answer and is skipped.
     */
    public static function user()
    {
        if (function_exists('posix_geteuid') && function_exists('posix_getpwuid')) {
            $pw = @posix_getpwuid(posix_geteuid());
            if (is_array($pw) && !empty($pw['name'])) {
                return (string)$pw['name'];
            }
        }
        foreach (array('USER', 'LOGNAME', 'APACHE_RUN_USER', 'REDIRECT_APACHE_RUN_USER') as $key) {
            $value = isset($_SERVER[$key]) ? (string)$_SERVER[$key] : (string)getenv($key);
            $value = trim($value);
            if ($value !== '' && $value[0] !== '$' && $value[0] !== '{') {
                return $value;
            }
        }
        return '';
    }

    /**
     * Can this process really create a file in $dir?
     *
     * Writes a uniquely named file and removes it again. A failed unlink does
     * not turn a successful write into a failure -- the answer is about being
     * able to save, and that already worked.
     */
    public static function probe($dir)
    {
        $dir = rtrim(str_replace('\\', '/', (string)$dir), '/');
        if ($dir === '' || !is_dir($dir)) {
            return false;
        }
        $name = '.write-check-' . getmypid() . '-' . bin2hex(random_bytes(4));
        if (@file_put_contents($dir . '/' . $name, 'ok') === false) {
            return false;
        }
        @unlink($dir . '/' . $name);
        return true;
    }

    /**
     * The exact command that gives storage/ to the account PHP runs as.
     *
     * POSIX is a chown: the folder and the group, recursively. A path with a
     * space is quoted for the shell, because a command the operator has to
     * repair before pasting it is not an answer. Empty on Windows, where the
     * callers describe the fix instead of printing a command that cannot work.
     */
    public static function command($dir, $user = null)
    {
        return self::chownLine($dir, $user, DIRECTORY_SEPARATOR !== '\\');
    }

    /**
     * The chown line itself, for a named platform.
     *
     * The platform flag exists so the exact string can be asserted on a host
     * that is not the platform it is for: the operator's server is POSIX and
     * the checkout this is developed on is Windows, and a message nobody can
     * test is how the chown line drifts into "check your permissions".
     */
    public static function chownLine($dir, $user = null, $posix = null)
    {
        if ($posix === null) {
            $posix = DIRECTORY_SEPARATOR !== '\\';
        }
        if (!$posix) {
            return '';
        }
        $dir = rtrim(str_replace('\\', '/', (string)$dir), '/');
        $user = $user === null ? self::user() : (string)$user;
        if ($user === '') {
            $user = 'www-data';
        }
        return 'sudo chown -R ' . $user . ':' . $user . ' ' . self::shellArg($dir);
    }

    /** One shell word for a path, quoting only when it needs it. */
    private static function shellArg($path)
    {
        $path = (string)$path;
        if ($path === '') {
            return "''";
        }
        if (!preg_match('/[^A-Za-z0-9_\-.\/:@%+=,]/', $path)) {
            return $path;
        }
        return "'" . str_replace("'", "'\\''", $path) . "'";
    }

    /**
     * What is wrong with this storage folder, or null when nothing is.
     *
     * Three states, because they need different words:
     *   * the folder is missing          -- chown cannot help; it has to exist;
     *   * a write into it fails          -- the whole tree must be handed over;
     *   * config.json cannot be written  -- the folder works, but every settings
     *                                       save is still dropped on the floor.
     *
     * `command` is always the plain chown (empty on Windows). `run` is the one
     * line that fixes this exact state -- it adds the mkdir when the folder is
     * absent -- and `advice` is what a text response prints under "Fix it with:".
     */
    public static function problem($dir = null)
    {
        $dir = $dir === null ? self::path() : rtrim(str_replace('\\', '/', (string)$dir), '/');
        $user = self::user();
        $who = $user !== '' ? $user : 'the user running PHP';
        $command = self::command($dir, $user);
        $missing = !is_dir($dir);

        $run = '';
        if ($command !== '') {
            $run = ($missing ? 'sudo mkdir -p ' . self::shellArg($dir) . ' && ' : '') . $command;
        }

        $advice = $run !== ''
            ? "Fix it with:\n  " . $run
            : 'Give the account PHP runs as' . ($user !== '' ? ' (' . $user . ')' : '')
                . ' Modify rights on ' . $dir . ', then reload this page.';

        if ($missing) {
            return array(
                'kind'    => 'missing',
                'path'    => $dir,
                'user'    => $user,
                'error'   => 'storage/ is missing, so nothing can be saved',
                'detail'  => $dir . ' does not exist. It has to exist, and it has to belong to ' . $who . '.',
                'command' => $command,
                'run'     => $run,
                'advice'  => $advice,
            );
        }

        if (!self::probe($dir)) {
            return array(
                'kind'    => 'dir',
                'path'    => $dir,
                'user'    => $user,
                'error'   => 'storage/ is not writable by ' . $who,
                'detail'  => $dir . ' cannot be written by the user running PHP. Every save '
                    . 'would fail silently: settings snap back, sessions and state are lost, and '
                    . "an agent's turn can look like it is thinking forever.",
                'command' => $command,
                'run'     => $run,
                'advice'  => $advice,
            );
        }

        $config = $dir . '/config.json';
        if (is_file($config) && !is_writable($config)) {
            return array(
                'kind'    => 'config',
                'path'    => $config,
                'user'    => $user,
                'error'   => 'storage/config.json is not writable by ' . $who,
                'detail'  => $config . ' exists but cannot be written by the user running PHP, '
                    . 'so every settings save fails silently and the toggle snaps back.',
                'command' => $command,
                'run'     => $run,
                'advice'  => $advice,
            );
        }

        return null;
    }

    /**
     * Refuse the request with the problem and the command that fixes it.
     *
     * JSON for the API and IDE -- the client reads `error` and appends `detail`,
     * so the chown line reaches the operator in the UI instead of sitting in a
     * network tab. Text for anything else, which is what a browser and curl
     * show. 500, never 200: a save that cannot work is a server fault, and the
     * client already treats 5xx as broken rather than success.
     */
    public static function fail(array $problem)
    {
        if (!headers_sent()) {
            http_response_code(500);
            header('Cache-Control: no-store');
        }
        $fix = (string)($problem['run'] ?? '');
        $advice = (string)($problem['advice'] ?? '');
        if (self::wantsJson()) {
            if (!headers_sent()) {
                header('Content-Type: application/json; charset=utf-8');
            }
            echo json_encode(array(
                'error'   => (string)($problem['error'] ?? 'storage/ is not writable'),
                'detail'  => $fix !== '' ? $fix : $advice,
                'fix'     => $fix,
                'storage' => (string)($problem['path'] ?? ''),
                'user'    => (string)($problem['user'] ?? ''),
                'kind'    => (string)($problem['kind'] ?? ''),
            ), JSON_UNESCAPED_SLASHES);
        } else {
            if (!headers_sent()) {
                header('Content-Type: text/plain; charset=utf-8');
            }
            echo (string)($problem['error'] ?? 'storage/ is not writable') . "\n\n"
                . (string)($problem['detail'] ?? '') . "\n\n"
                . $advice . "\n";
        }
        exit;
    }

    /** Does this request belong to an endpoint that answers JSON? */
    private static function wantsJson()
    {
        $hints = array(
            isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '',
            isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '',
            isset($_SERVER['PHP_SELF']) ? $_SERVER['PHP_SELF'] : '',
        );
        foreach ($hints as $hint) {
            if (preg_match('#/api($|[/?.])#i', str_replace('\\', '/', (string)$hint))) {
                return true;
            }
        }
        return false;
    }

    /**
     * The boot check: run before the request does any work.
     *
     * Skipped under the CLI SAPI (the suite, the tools, serve.php's own --check)
     * and for the installer, which is the one request that might be running
     * before ownership is right and whose whole job is to repair a copy.
     */
    public static function guard()
    {
        if (PHP_SAPI === 'cli') {
            return;
        }
        $script = isset($_SERVER['SCRIPT_NAME']) ? str_replace('\\', '/', (string)$_SERVER['SCRIPT_NAME']) : '';
        if (strpos($script, 'install-update.php') !== false) {
            return;
        }
        $problem = self::problem();
        if ($problem !== null) {
            self::fail($problem);
        }
    }
}
