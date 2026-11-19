<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * tools/drill-selftest.php, run the way an operator runs it.
 *
 * Usage: php tests/php/drillSelftest.test.php
 *
 * The command-line drill check is a thin wrapper over Sandbox, and the thing
 * that can actually break is the wrapper: argument parsing, the temp config it
 * is pointed at, the slug it derives, and whether a refused root fails instead
 * of writing anyway. So this spawns the real script in a real PHP process and
 * reads what it wrote.
 *
 * Exits 0 on success, 1 on any failure.
 */

require_once __DIR__ . '/../../autoload.php';

$pass = 0;
$fail = 0;
$errors = [];

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) { $pass++; }
    else { $fail++; $errors[] = "FAIL: $name"; }
}

function rm_tree($path)
{
    if (is_file($path) || is_link($path)) { @unlink($path); return; }
    if (!is_dir($path)) { return; }
    foreach ((array)@scandir($path) as $entry) {
        if ($entry !== '.' && $entry !== '..') { rm_tree($path . '/' . $entry); }
    }
    @rmdir($path);
}

/** Run the tool with args, pointed at one config, and collect exit/stdout/stderr. */
function run_tool($tool, array $args, $configPath)
{
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($tool);
    foreach ($args as $a) { $cmd .= ' ' . escapeshellarg((string)$a); }
    $env = getenv();
    if (!is_array($env)) { $env = []; }
    $env['ROUTER_CONFIG'] = $configPath;
    $desc = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = @proc_open($cmd, $desc, $pipes, null, $env);
    if (!is_resource($proc)) {
        return ['exit' => -1, 'out' => '', 'err' => 'could not start PHP'];
    }
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    return ['exit' => $exit, 'out' => (string)$out, 'err' => (string)$err];
}

$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-drill-selftest-' . getmypid();
rm_tree($tmp);
@mkdir($tmp, 0777, true);

$configPath = $tmp . '/config.json';
file_put_contents($configPath, json_encode([
    'sandbox' => [
        'read_roots' => [$tmp],
        'write_roots' => [$tmp],
        'require_token' => false,
        'token' => '',
    ],
], JSON_PRETTY_PRINT));

$tool = realpath(__DIR__ . '/../../tools/drill-selftest.php');
$want = "training\ndrill 2 passed (exact match)";
$read = function ($path) use ($want) {
    if (!is_file($path)) { return null; }
    return rtrim(str_replace(["\r\n", "\r"], "\n", (string)file_get_contents($path)));
};

echo "CLI drill self-test\n";
echo str_repeat('-', 60) . "\n";

if ($tool === false) {
    echo "  FAIL: tools/drill-selftest.php not found\n";
    echo "0 passed, 1 failed\n";
    exit(1);
}

// 1. The check itself, quiet: exit code and the two files.
$first = run_tool($tool, ['--quiet'], $configPath);
$firstOut = $first['out'] . $first['err'];
ok($first['exit'] === 0, "the self-test exits 0 (got {$first['exit']}: " . trim($firstOut) . ')');
ok(strpos($first['out'], 'RESULT: PASS') !== false, 'it prints RESULT: PASS');
$p1 = $tmp . '/training/training-lftest-p1.txt';
$p2 = $tmp . '/training/training-lftest-p2.txt';
ok($read($p1) === $want, 'pass 1 left its file at the drill\'s two lines');
ok($read($p2) === $want, 'pass 2 left its own file at the drill\'s two lines');

// 2. A second run is the same two passes over again: the names are fixed, so
//    this also proves a rerun does not fail on files that already exist.
$second = run_tool($tool, ['--quiet'], $configPath);
ok($second['exit'] === 0, 'a second run still passes');
ok($read($p1) === $want && $read($p2) === $want, 'and both files still hold the drill bytes');

// 3. Not quiet: it says which files it wrote and that pass 1 was not rewritten.
$loud = run_tool($tool, [], $configPath);
ok($loud['exit'] === 0, 'the verbose run passes too');
ok(strpos($loud['out'], 'training-lftest-p1.txt') !== false,
    'the report names the pass-1 file it wrote');
ok(stripos($loud['out'], 'not rewritten') !== false,
    'it states that pass 2 did not rewrite pass 1');

// 4. --agent renames the probe, --root narrows where it writes.
$inner = $tmp . '/narrow';
@mkdir($inner, 0777, true);
$narrow = run_tool($tool, ['--root', $inner, '--agent', 'agent_narrow', '--quiet'], $configPath);
ok($narrow['exit'] === 0, '--root with --agent passes');
ok($read($inner . '/training/training-narrow-p1.txt') === $want,
    'the narrowed run wrote inside --root, named after --agent');
ok(!is_file($tmp . '/training/training-narrow-p1.txt'),
    'and not in the wider root');

// 5. A folder outside the sandbox roots is refused rather than written.
$outside = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-drill-outside-' . getmypid();
rm_tree($outside);
@mkdir($outside, 0777, true);
$denied = run_tool($tool, ['--root', $outside, '--quiet'], $configPath);
ok($denied['exit'] === 1, 'a root outside the allowlist fails instead of writing');
ok(stripos($denied['out'] . $denied['err'], 'outside the allowed roots') !== false,
    'and the refusal names the reason');
ok(!is_dir($outside . '/training'), 'nothing was written outside the roots');

// 6. Usage errors are told apart from a failed check.
$bad = run_tool($tool, ['--not-a-flag'], $configPath);
ok($bad['exit'] === 2, 'an unknown flag is a usage error (exit 2)');
$noValue = run_tool($tool, ['--root'], $configPath);
ok($noValue['exit'] === 2, 'a flag with no value is a usage error (exit 2)');
$help = run_tool($tool, ['--help'], $configPath);
ok($help['exit'] === 0 && strpos($help['out'], '--root') !== false, '--help explains the flags and exits 0');

rm_tree($tmp);
rm_tree($outside);

echo str_repeat('-', 60) . "\n";
echo "$pass passed, $fail failed\n";
foreach ($errors as $e) { echo "  $e\n"; }
exit($fail === 0 ? 0 : 1);
