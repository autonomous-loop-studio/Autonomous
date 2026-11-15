<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * drill-selftest.php — the two-pass training-drill check, from a terminal.
 *
 *   php tools/drill-selftest.php                 use the configured sandbox
 *   php tools/drill-selftest.php --root <dir>    narrow to one allowed folder
 *   php tools/drill-selftest.php --agent <id>    name the probe agent
 *   php tools/drill-selftest.php --quiet         print only the RESULT line
 *
 * It writes training/training-<agent>-p1.txt, runs the drill's two anchored
 * edits on it, then does the same for -p2.txt, and reads both back. A second
 * pass has to end at the same two lines WITHOUT the first pass being rewritten:
 * the bug that made agents retry a write they could never complete was pass 2
 * opening the file pass 1 had already finished.
 *
 * This uses the same Sandbox primitives the tools use (write / str_replace /
 * read_text), so it needs no server, no model and no approval. It deletes
 * nothing — both files stay where they are, as the proof. The UI's
 * "RUN TWO-PASS SELF-TEST" button does the same thing through the tool
 * registry; this is the version that works on a machine with no browser.
 *
 * The slug rule below must stay in step with drillSlug() in ui/js/training.js,
 * and the two anchored edits with the drill's steps 8 and 9. If either drifts,
 * this check would pass while a real pass fails — which is the one thing it
 * exists to prevent.
 *
 * Exit 0 = both passes passed; 1 = a pass failed or the sandbox refused;
 * 2 = bad usage.
 */

require_once __DIR__ . '/../autoload.php';

use Src\Sandbox;

function drill_selftest_usage()
{
    echo "Two-pass training-drill self-test\n\n";
    echo "  php tools/drill-selftest.php [--root <dir>] [--agent <id>] [--quiet]\n\n";
    echo "  --root <dir>    narrow the writes to one folder inside the sandbox roots\n";
    echo "  --agent <id>    probe name (default agent_drill_selftest)\n";
    echo "  --quiet, -q     print only the RESULT line\n";
    echo "  --help, -h      this text\n\n";
    echo "Writes training/training-<agent>-p1.txt and -p2.txt and verifies both.\n";
    echo "Nothing is deleted; the files are the evidence.\n";
}

$opt = array('root' => '', 'agent' => 'agent_drill_selftest', 'quiet' => false);
$argc = count($argv);
for ($i = 1; $i < $argc; $i++) {
    $a = (string)$argv[$i];
    if ($a === '--quiet' || $a === '-q') { $opt['quiet'] = true; continue; }
    if ($a === '--help' || $a === '-h') { drill_selftest_usage(); exit(0); }
    if (preg_match('/^--(root|agent)=(.*)$/s', $a, $m)) { $opt[$m[1]] = $m[2]; continue; }
    if ($a === '--root' || $a === '--agent') {
        if ($i + 1 >= $argc) {
            fwrite(STDERR, "drill-selftest: $a needs a value (try --help)\n");
            exit(2);
        }
        $opt[substr($a, 2)] = (string)$argv[++$i];
        continue;
    }
    fwrite(STDERR, "drill-selftest: unknown argument \"$a\" (try --help)\n");
    exit(2);
}

/** Same rule as training.js: lowercase, non-alphanumerics to '-', last 48. */
function drill_selftest_slug($raw)
{
    $s = strtolower((string)$raw);
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    $s = trim((string)$s, '-');
    if (strlen($s) > 48) { $s = substr($s, -48); }
    return $s !== '' ? $s : 'agent';
}

$scope = $opt['root'] !== '' ? $opt['root'] : null;
$slug = drill_selftest_slug($opt['agent']);
$want = "training\ndrill 2 passed (exact match)";
$fileFor = function ($pass) use ($slug) {
    return 'training/training-' . $slug . '-p' . (int)$pass . '.txt';
};

$quiet = (bool)$opt['quiet'];
if (!$quiet) {
    echo "Two-pass training-drill self-test\n";
    echo str_repeat('-', 60) . "\n";
    try {
        $st = Sandbox::status();
        echo 'Writing inside: ' . (implode(', ', (array)$st['write_roots']) ?: '(none configured)') . "\n";
        if ($scope !== null) { echo "Narrowed to:    $scope\n"; }
    } catch (\Throwable $e) {
        echo 'Sandbox status unavailable: ' . $e->getMessage() . "\n";
    }
    echo "\n";
}

$passes = array();
$firstSig = '';
$firstPath = '';
$failure = '';

try {
    foreach (array(1, 2) as $pass) {
        $rel = $fileFor($pass);
        $written = Sandbox::writeFile($rel, 'training', 'write', $scope);
        Sandbox::strReplace($rel, 'training', "training\ndrill 2 passed", false, $scope);
        Sandbox::strReplace($rel, 'drill 2 passed', 'drill 2 passed (exact match)', false, $scope);
        $read = Sandbox::readText($rel, $scope);
        $body = rtrim(str_replace(array("\r\n", "\r"), "\n", (string)$read['content']));
        if ($body !== $want) {
            $failure = "pass $pass did not end where the drill expects\n"
                . '  file:   ' . $read['path'] . "\n"
                . '  wanted: ' . json_encode($want) . "\n"
                . '  read:   ' . json_encode(substr($body, 0, 200));
            break;
        }
        if ($pass === 1) {
            $firstPath = $read['path'];
            clearstatcache(true, $firstPath);
            $firstSig = @filesize($firstPath) . ':' . @filemtime($firstPath);
        }
        $passes[] = 'pass ' . $pass . ' · ' . $rel . ' · ' . (int)$read['bytes'] . ' bytes · ends at the two drill lines';
        if (!$quiet) { echo end($passes) . " ✓\n"; }
    }

    if ($failure === '') {
        $secondPath = Sandbox::readText($fileFor(2), $scope)['path'];
        if (realpath($firstPath) === realpath($secondPath)) {
            $failure = 'both passes resolved to the same file: ' . $firstPath;
        } else {
            clearstatcache(true, $firstPath);
            $nowSig = @filesize($firstPath) . ':' . @filemtime($firstPath);
            if ($firstSig !== '' && $nowSig !== $firstSig) {
                $failure = 'pass 1 was rewritten while pass 2 ran: ' . $firstPath;
            }
        }
    }
} catch (\Throwable $e) {
    $failure = 'sandbox refused the run: ' . $e->getMessage();
}

if ($failure !== '') {
    if (!$quiet) { echo "\n"; }
    echo "RESULT: FAIL — $failure\n";
    exit(1);
}

if (!$quiet) {
    echo 'pass 1 was not rewritten by pass 2 ✓' . "\n";
    echo "\n";
}
echo 'RESULT: PASS — two passes, two files, both ending at the drill\'s two lines' . "\n";
exit(0);
