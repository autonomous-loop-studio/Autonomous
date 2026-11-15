<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// The Advanced drill's own page.
//
// Advanced used to fetch https://example.com/, and that check went stale when
// example.com reworded its page: a model that fetched the page and saved its
// text correctly was graded `4 failed at step 4` and rewrote a good file until
// it gave up (v465). The drill now grades ui/drill/advanced.html, served from
// disk by Sandbox::drillFixture() for the fake host drill.local.
//
// This test exists because the fixture and the grader are two files that must
// agree: the page carries the marker, and DRILL_CHECKS_ADVANCED looks for it.
// If someone edits the page's wording, this fails here instead of failing every
// later drill pass with no explanation.
//
// Usage: php tests/php/drillPage.test.php — exit 0 pass, 1 fail.

declare(strict_types=1);

require_once __DIR__ . '/../../autoload.php';

use Src\Sandbox;

$root = dirname(__DIR__, 2);

$fail = 0;
$checks = 0;
function check($cond, $label) {
    global $fail, $checks;
    $checks++;
    if ($cond) { echo "  ok  $label\n"; return; }
    $fail++;
    echo "  FAIL $label\n";
}

echo "Drill page tests\n" . str_repeat('-', 60) . "\n";

$page = $root . '/ui/drill/advanced.html';
$training = (string)@file_get_contents($root . '/ui/js/training.js');

check(is_file($page), 'ui/drill/advanced.html exists');
$html = is_file($page) ? (string)file_get_contents($page) : '';
check(stripos($html, 'DRILL-PAGE-v1') !== false, 'the page carries the DRILL-PAGE-v1 marker');

// The grader must look for the same marker the page carries.
check(preg_match('/DRILL_PAGE_MARKER\s*=\s*\/drill-page-v1\/i/', $training) === 1,
    'training.js grades the DRILL-PAGE-v1 marker');
check(strpos($training, "'http://drill.local/advanced.html'") !== false,
    'training.js points the drill at drill.local/advanced.html');
check(!preg_match('/label:.*example\.com/i', $training),
    'no Advanced drill step still points at a public page');

$res = Sandbox::fetchUrl('http://drill.local/advanced.html');
check(($res['status'] ?? 0) === 200, 'fetchUrl serves the drill page with HTTP 200');
check(($res['type'] ?? '') === 'html', 'the drill page is read as html');
check(stripos((string)($res['text'] ?? ''), 'DRILL-PAGE-v1') !== false,
    'the fetched text carries the marker the write step checks');
check(strlen((string)($res['text'] ?? '')) >= 40, 'the fetched text is long enough to grade');
check(($res['truncated'] ?? true) === false, 'the drill page fits in one fetch');

// Without a scheme, fetchUrl assumes https — the drill host must still resolve.
$bare = Sandbox::fetchUrl('drill.local/advanced.html');
check(($bare['status'] ?? 0) === 200, 'drill.local works without a scheme too');

// The fixture path is flat: nothing may climb out of ui/drill/.
foreach ([
    'http://drill.local/../storage/config.json' => 'a path outside ui/drill/',
    'http://drill.local/advanced.txt'           => 'a file that is not .html',
    'http://drill.local/'                        => 'no page name at all',
] as $url => $what) {
    $refused = false;
    try { Sandbox::fetchUrl($url); } catch (\RuntimeException $e) { $refused = true; }
    check($refused, "fetchUrl refuses $what");
}
$missing = false;
try { Sandbox::fetchUrl('http://drill.local/no-such-page.html'); } catch (\RuntimeException $e) { $missing = true; }
check($missing, 'fetchUrl refuses an unknown drill page instead of returning nothing');

// The loopback rule is untouched: drill.local is a name this method answers
// itself, not an exemption that lets a real local address through.
foreach (['http://127.0.0.1:8080/advanced.html', 'http://localhost/advanced.html'] as $url) {
    $refused = false;
    try { Sandbox::fetchUrl($url); } catch (\RuntimeException $e) { $refused = true; }
    check($refused, "the public-URL rule still refuses $url");
}

echo str_repeat('-', 60) . "\n";
echo $fail === 0 ? "$checks passed\n" : "$checks checks, $fail failed\n";
exit($fail === 0 ? 0 : 1);
