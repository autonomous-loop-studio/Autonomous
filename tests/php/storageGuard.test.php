<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage guard: a storage/ the web user cannot write must refuse loudly.
 *
 * Usage: php tests/php/storageGuard.test.php
 *
 * The failure this is about looked like a hang, not like a permission: a copy
 * whose storage/ was owned by root dropped every save on the floor, so a Config
 * toggle snapped back, sessions were never written, and an agent's turn sat
 * there with nothing recorded. The guard's job is to make that impossible to
 * miss -- a 500 whose body carries the exact `sudo chown -R <user>:<user>
 * <path>/storage` line.
 *
 * What is pinned here:
 *
 *   * the probe is a real write (a fresh folder passes, a missing one does not)
 *     and it leaves nothing behind;
 *   * a writable storage is not reported as a problem, so a healthy install is
 *     never blocked by this;
 *   * a folder the process cannot write IS reported, with the folder, the user
 *     and the exact chown command -- not "check your permissions";
 *   * a config.json that cannot be written is reported too, because that is the
 *     same silent failure with a working folder around it;
 *   * the web refusal is JSON for the API and IDE (the client reads error +
 *     detail, so the chown line reaches the UI) and text everywhere else;
 *   * the boot hook is really wired: a clone whose storage/ is not usable
 *     refuses an ordinary request with 500, and the same clone answers 200 once
 *     storage/ exists -- a guard nobody calls is a comment;
 *   * the CLI SAPI is exempt, so the suite, the tools and `serve.php --check`
 *     keep their own reporting.
 *
 * Windows has no chown, so `command()` is empty there on purpose and the
 * checks assert the advice instead of pretending a POSIX line would work. The
 * unreadable cases chmod a throwaway folder; that cannot be simulated when the
 * test runs as root (root writes anyway), so they print SKIP there.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Storage;

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
    } else {
        $fail++;
        $errors[] = 'FAIL: ' . $name;
    }
}

function skip($why)
{
    echo "  SKIP: " . $why . "\n";
}

function same($got, $want, $name)
{
    ok($got === $want, $name . ' (got ' . var_export($got, true) . ', want ' . var_export($want, true) . ')');
}

function rm_tree($dir)
{
    if (!is_dir($dir)) {
        return;
    }
    foreach ((array)@scandir($dir) as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $path = $dir . '/' . $entry;
        if (is_dir($path) && !is_link($path)) {
            rm_tree($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

$posix = DIRECTORY_SEPARATOR !== '\\';
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-storage-guard-' . getmypid();
rm_tree($tmp);
@mkdir($tmp . '/good', 0777, true);
@mkdir($tmp . '/locked', 0777, true);

echo "Storage guard\n";
echo str_repeat('-', 60) . "\n";

// --- 1. the probe ----------------------------------------------------------
ok(Storage::probe($tmp . '/good'), 'a fresh writable folder passes the write probe');
$left = array_values(array_diff((array)@scandir($tmp . '/good'), array('.', '..')));
same($left, array(), 'the probe leaves no file behind');
ok(!Storage::probe($tmp . '/does-not-exist'), 'a missing folder cannot be written');

// --- 2. a healthy storage is not a problem ---------------------------------
ok(Storage::problem($tmp . '/good') === null, 'a writable folder with no config.json is healthy');
ok(Storage::problem() === null, 'this checkout\'s own storage/ is writable');
same(substr(Storage::path(), -8), '/storage', 'the default path is this app\'s storage/');

// --- 3. the command is exact ----------------------------------------------
// chownLine() is asserted for POSIX on every host: the server this guard was
// written for is POSIX, and a string only tested on the platform it targets is
// a string nobody on the development machine ever read.
same(
    Storage::chownLine('/var/www/app/storage', 'www-data', true),
    'sudo chown -R www-data:www-data /var/www/app/storage',
    'the fix is the exact chown line'
);
same(
    Storage::chownLine('/var/www/app/storage/', 'www-data', true),
    'sudo chown -R www-data:www-data /var/www/app/storage',
    'a trailing slash does not reach the command'
);
same(
    Storage::chownLine('/var/www/my site/storage', 'www-data', true),
    "sudo chown -R www-data:www-data '/var/www/my site/storage'",
    'a path with a space is quoted once, correctly'
);
same(Storage::chownLine('C:/app/storage', 'www-data', false), '', 'a non-POSIX host gets no chown');
same(
    Storage::command('/var/www/app/storage', 'www-data'),
    $posix ? 'sudo chown -R www-data:www-data /var/www/app/storage' : '',
    'command() follows this host'
);

// --- 4. a missing storage is named as missing ------------------------------
$missing = Storage::problem($tmp . '/not-here');
ok($missing !== null, 'a missing storage is a problem');
same($missing['kind'] ?? null, 'missing', 'and it is reported as missing');
if ($posix) {
    ok(strpos((string)$missing['run'], 'sudo mkdir -p') === 0, 'the missing folder gets a mkdir first');
    ok(strpos((string)$missing['run'], 'chown -R') !== false, 'and the chown line is still there');
} else {
    same((string)$missing['run'], '', 'Windows has no line to run for a missing folder');
    ok(strpos((string)$missing['advice'], 'Modify rights') !== false, 'but the advice names the fix');
    ok(strpos((string)$missing['advice'], $tmp . '/not-here') !== false, 'and the folder');
}

// --- 5. an unwritable folder is reported, with the fix ---------------------
if (!$posix) {
    skip('directory modes do not apply on Windows');
} else {
    @chmod($tmp . '/locked', 0555);
    if (Storage::probe($tmp . '/locked')) {
        skip('running as root: a 0555 folder is still writable');
    } else {
        $locked = Storage::problem($tmp . '/locked');
        ok($locked !== null, 'an unwritable storage is a problem');
        same($locked['kind'] ?? null, 'dir', 'and it is reported as the folder');
        same($locked['path'] ?? null, $tmp . '/locked', 'the problem names the folder');
        same(
            $locked['command'] ?? null,
            'sudo chown -R ' . Storage::user() . ':' . Storage::user() . ' ' . $tmp . '/locked',
            'the problem carries the exact chown command for this user'
        );
        same($locked['run'] ?? null, $locked['command'] ?? null, 'and it is the line to run');
        ok(strpos((string)($locked['error'] ?? ''), 'not writable') !== false, 'the error says not writable');
        ok(strpos((string)($locked['detail'] ?? ''), 'thinking forever') !== false,
            'and the detail says what it looks like from the outside');
    }
    @chmod($tmp . '/locked', 0777);
}

// --- 6. a working folder with an unwritable config.json --------------------
if (!$posix) {
    skip('file modes do not apply on Windows');
} else {
    $cfgDir = $tmp . '/cfg';
    @mkdir($cfgDir, 0777, true);
    file_put_contents($cfgDir . '/config.json', '{}');
    @chmod($cfgDir . '/config.json', 0444);
    if (is_writable($cfgDir . '/config.json')) {
        skip('running as root: a 0444 file is still writable');
    } else {
        $cfgProblem = Storage::problem($cfgDir);
        ok($cfgProblem !== null, 'an unwritable config.json is a problem');
        same($cfgProblem['kind'] ?? null, 'config', 'and it is reported as the config file');
        same($cfgProblem['path'] ?? null, $cfgDir . '/config.json', 'the problem names the file');
        ok(strpos((string)($cfgProblem['command'] ?? ''), 'chown -R') !== false,
            'its fix is the same chown on the folder');
    }
    @chmod($cfgDir . '/config.json', 0644);
}

// --- 7. the refusal itself ------------------------------------------------
// guard() must be a no-op under CLI, or the suite dies the moment a checkout
// has a read-only storage/ (which is exactly the machine that needs the line).
Storage::guard();
ok(true, 'guard() is a no-op under the CLI SAPI');

/** Run one refusal in a child process: CLI, so only fail() is exercised. */
function refuse($scriptName, array $problem, $dir)
{
    $file = $dir . '/refuse-' . md5($scriptName) . '.php';
    $code = "<?php\nrequire " . var_export(dirname(__DIR__, 2) . '/autoload.php', true) . ";\n"
        . '$_SERVER[\'SCRIPT_NAME\'] = ' . var_export($scriptName, true) . ";\n"
        . '$_SERVER[\'REQUEST_URI\'] = ' . var_export($scriptName, true) . ";\n"
        . '\\Src\\Storage::fail(' . var_export($problem, true) . ");\n";
    file_put_contents($file, $code);
    if (!function_exists('proc_open')) {
        @unlink($file);
        return null;
    }
    $spec = array(1 => array('pipe', 'w'), 2 => array('pipe', 'w'));
    $proc = @proc_open(array(PHP_BINARY, $file), $spec, $pipes, $dir);
    if (!is_resource($proc)) {
        @unlink($file);
        return null;
    }
    $out = (string)stream_get_contents($pipes[1]);
    $errOut = (string)stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $codeOut = proc_close($proc);
    @unlink($file);
    return array('out' => $out, 'err' => $errOut, 'exit' => $codeOut);
}

$problem = array(
    'kind'    => 'dir',
    'path'    => '/var/www/app/storage',
    'user'    => 'www-data',
    'error'   => 'storage/ is not writable by www-data',
    'detail'  => '/var/www/app/storage cannot be written by the user running PHP.',
    'command' => $posix ? 'sudo chown -R www-data:www-data /var/www/app/storage' : '',
    'run'     => $posix ? 'sudo chown -R www-data:www-data /var/www/app/storage' : '',
    'advice'  => $posix
        ? "Fix it with:\n  sudo chown -R www-data:www-data /var/www/app/storage"
        : 'Give the account PHP runs as (www-data) Modify rights on /var/www/app/storage, then reload this page.',
);
$expectedDetail = $problem['run'] !== '' ? $problem['run'] : $problem['advice'];

$api = refuse('/api/index.php', $problem, $tmp);
if ($api === null) {
    skip('proc_open is disabled, cannot run a refusal in a child process');
} else {
    $json = json_decode($api['out'], true);
    ok(is_array($json), 'an API refusal answers JSON');
    same($json['error'] ?? null, $problem['error'], 'the JSON carries the error');
    same($json['detail'] ?? null, $expectedDetail, 'the client-facing detail is the fix');
    same($json['fix'] ?? null, $problem['run'], 'and a fix field carries the line to run');
    same($json['kind'] ?? null, 'dir', 'the JSON names what is wrong');
}

$page = refuse('/index.html', $problem, $tmp);
if ($page === null) {
    skip('proc_open is disabled, cannot run a refusal in a child process');
} else {
    ok(strpos($page['out'], 'Fix it with:') !== false || strpos($page['out'], 'Modify rights') !== false,
        'a non-API refusal is plain text with the fix');
    if ($posix) {
        ok(strpos($page['out'], $problem['command']) !== false, 'and prints the same command');
    }
    same(trim($page['err']), '', 'with nothing on stderr');
}

// --- 8. the boot hook, over real HTTP --------------------------------------
// Sections above prove the strings. This proves the wiring: a clone whose
// storage/ is not a directory must refuse an ordinary request, and a clone with
// a healthy storage/ must answer normally -- no false refusal on a good install.
function http_get($url, &$status)
{
    $status = 0;
    $ctx = stream_context_create(array('http' => array(
        'method' => 'GET',
        'ignore_errors' => true,
        'timeout' => 5,
    )));
    $body = @file_get_contents($url, false, $ctx);
    if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
        $status = (int)$m[1];
    }
    return $body === false ? '' : $body;
}

$appRoot = dirname(__DIR__, 2);
$port = 0;
if (!function_exists('proc_open')) {
    skip('proc_open is disabled, cannot boot a guard server');
} else {
    require_once __DIR__ . '/free-port.php';
    $port = function_exists('free_port') ? free_port() : 0;
    if ($port === 0) {
        skip('no free loopback port to boot a guard server');
    }
}

if ($port > 0) {
    $clone = $tmp . '/boot';
    @mkdir($clone . '/src', 0777, true);
    copy($appRoot . '/autoload.php', $clone . '/autoload.php');
    copy($appRoot . '/src/Storage.php', $clone . '/src/Storage.php');
    file_put_contents($clone . '/storage', 'not a directory');
    file_put_contents($clone . '/router.php', '<?php require __DIR__ . \'/autoload.php\'; echo "OK";');

    $log = $clone . '/server.log';
    $spec = array(1 => array('file', $log, 'a'), 2 => array('file', $log, 'a'));
    $proc = @proc_open(
        array(PHP_BINARY, '-S', '127.0.0.1:' . $port, 'router.php'),
        $spec,
        $pipes,
        $clone
    );
    if (!is_resource($proc)) {
        skip('could not boot a guard server');
    } else {
        $base = 'http://127.0.0.1:' . $port;
        // Wait for the server to answer: an open port is not readiness.
        $status = 0;
        $body = '';
        for ($i = 0; $i < 50; $i++) {
            $body = http_get($base . '/api/status', $status);
            if ($status !== 0) {
                break;
            }
            usleep(100000);
        }

        same($status, 500, 'a broken storage refuses an API request with 500');
        $json = json_decode($body, true);
        ok(is_array($json), 'and the refusal is JSON the client can read');
        same($json['kind'] ?? null, 'missing', 'it names the state');
        ok(strpos((string)($json['error'] ?? ''), 'storage') !== false, 'and the folder');
        if ($posix) {
            ok(strpos((string)($json['detail'] ?? ''), 'mkdir -p') !== false,
                'the API detail carries the line to run');
            ok(strpos((string)($json['detail'] ?? ''), 'chown -R') !== false,
                'which includes the chown');
        } else {
            ok(strpos((string)($json['detail'] ?? ''), 'Modify rights') !== false,
                'the API detail carries the platform fix');
        }

        $pageStatus = 0;
        $pageBody = http_get($base . '/', $pageStatus);
        same($pageStatus, 500, 'a page request is refused too');
        ok(strpos($pageBody, 'storage/') !== false, 'and the page body names storage/');

        @proc_terminate($proc);
        @proc_close($proc);

        // The healthy control is a SECOND clone, booted with storage/ already a
        // folder. Swapping a path from file to directory under a running
        // `php -S` on Windows leaves its stat cache saying "file", which is a
        // property of the test setup, not of the guard.
        $good = $tmp . '/boot-good';
        @mkdir($good . '/src', 0777, true);
        @mkdir($good . '/storage', 0777, true);
        copy($appRoot . '/autoload.php', $good . '/autoload.php');
        copy($appRoot . '/src/Storage.php', $good . '/src/Storage.php');
        file_put_contents($good . '/router.php', '<?php require __DIR__ . \'/autoload.php\'; echo "OK";');
        $okPort = free_port();
        if ($okPort === 0) {
            skip('no second free port for the healthy control');
        } else {
            $okProc = @proc_open(
                array(PHP_BINARY, '-S', '127.0.0.1:' . $okPort, 'router.php'),
                array(1 => array('file', $good . '/server.log', 'a'), 2 => array('file', $good . '/server.log', 'a')),
                $okPipes,
                $good
            );
            if (!is_resource($okProc)) {
                skip('could not boot the healthy control');
            } else {
                $okStatus = 0;
                $okBody = '';
                for ($i = 0; $i < 50; $i++) {
                    $okBody = http_get('http://127.0.0.1:' . $okPort . '/api/status', $okStatus);
                    if ($okStatus !== 0) {
                        break;
                    }
                    usleep(100000);
                }
                same($okStatus, 200, 'a healthy storage is not blocked');
                same(trim($okBody), 'OK', 'and the request runs');
                @proc_terminate($okProc);
                @proc_close($okProc);
            }
        }
    }
}

// --- cleanup ---------------------------------------------------------------
rm_tree($tmp);

foreach ($errors as $line) {
    echo $line . "\n";
}
echo "storageGuard: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
