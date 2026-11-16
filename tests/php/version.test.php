<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bump stays together: one cache-buster, in every place a browser reads it.
 *
 * Usage: php tests/php/version.test.php
 *
 * A release moves `APP_VERSION` in `ui/js/store.js` and then has to move it in
 * four more places or browsers mix a new module with an old one — which is
 * exactly how "api.sandbox is not a function" happened. Two of those places are
 * easy to miss because they are not `?v=` on an import line:
 *
 *   * `<span id="appVersion">` in both `index.html` and `ui/index.html`, which
 *     is the badge the operator reads; it said v470 while the modules were at
 *     v471, so the header disagreed with the code it was describing.
 *   * `<html data-build="…">` in the same two files, which `langs.js` appends to
 *     the Prism vendor scripts it injects at runtime. Nothing documented it and
 *     no bump ever touched it: it still said 143 through four releases, so every
 *     Prism file the app fetched was asked for as `?v=143` and any update to one
 *     would have come from cache.
 *
 * So this file reads the numbers the way the update check does (`Update::
 * versionPairIn`, not a second hand-rolled regex) and fails when any of them
 * disagree, when a `?v=` in `ui/**` or either `index.html` names anything but
 * the current cache-buster, or when `VERSION` falls behind it.
 *
 * Exits 0 on success, 1 on any failure.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Update;

$root = dirname(__DIR__, 2);

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

/** Every `?v=<digits>` in a file, skipping those that compute the number. */
function cache_busters($text)
{
    preg_match_all('/\?v=(\d+)/', (string) $text, $m);
    return $m[1];
}

/** The values that do not match the cache-buster, in file order. */
function stale_busters($text, $app)
{
    $stale = array();
    foreach (cache_busters($text) as $value) {
        if ($value !== $app) {
            $stale[] = $value;
        }
    }
    return $stale;
}

/** The `data-build` attribute of the <html> tag, or null when there is none. */
function data_build($html)
{
    if (preg_match('/<html[^>]*\bdata-build\s*=\s*["\']([^"\']*)["\']/i', (string) $html, $m)) {
        return trim($m[1]);
    }
    return null;
}

/** The text of the `<span id="appVersion">` badge, or null when there is none. */
function version_badge($html)
{
    if (preg_match('/id\s*=\s*["\']appVersion["\'][^>]*>\s*([^<]*?)\s*</i', (string) $html, $m)) {
        return trim($m[1]);
    }
    return null;
}

// ------------------------------------------------------------- the two numbers
// Read through the app's own reader: a test that parses `store.js` with its own
// regex can agree with itself while disagreeing with every running copy.
$pair = Update::versionPairIn($root);
$release = $pair['release'] ? $pair['release']['label'] : null;
$app = $pair['app'] ? $pair['app']['label'] : null;

ok($release !== null && preg_match('/^\d+$/', (string) $release) === 1,
    'VERSION is a plain integer (' . var_export($release, true) . ')',
    $pass, $fail, $errors);

ok($app !== null && preg_match('/^\d+$/', (string) $app) === 1,
    'APP_VERSION reads out of ui/js/store.js (' . var_export($app, true) . ')',
    $pass, $fail, $errors);

if ($release === null || $app === null) {
    // Nothing below can be judged without both numbers, and a sweep that
    // silently compares against null would pass every file.
    echo str_repeat('-', 60) . "\n";
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . "\n";
    exit(1);
}

ok((int) $release >= (int) $app,
    'VERSION is never behind APP_VERSION (' . $release . ' vs ' . $app . '), or the update check cannot see a release',
    $pass, $fail, $errors);

// ------------------------------------------------- the pages, badge and build
foreach (array('index.html', 'ui/index.html') as $page) {
    $html = @file_get_contents($root . '/' . $page);
    if (!ok($html !== false, $page . ' is readable', $pass, $fail, $errors)) {
        continue;
    }

    $build = data_build($html);
    ok($build === $app,
        $page . ' data-build agrees with APP_VERSION (' . var_export($build, true) . ' vs ' . var_export($app, true) . ')'
        . ' — langs.js appends it to the Prism vendor scripts',
        $pass, $fail, $errors);

    $badge = version_badge($html);
    ok($badge === 'v' . $app,
        $page . ' appVersion badge agrees with APP_VERSION (' . var_export($badge, true) . ' vs ' . var_export('v' . $app, true) . ')',
        $pass, $fail, $errors);
}

// Every other page under ui/ that carries a build number has to carry this one.
$pages = glob($root . '/ui/*.html');
sort($pages);
$otherPages = 0;
foreach ($pages as $path) {
    $html = @file_get_contents($path);
    $build = $html === false ? null : data_build($html);
    if ($build === null) {
        continue;
    }
    $otherPages++;
    ok($build === $app,
        'ui/' . basename($path) . ' data-build agrees with APP_VERSION (' . var_export($build, true) . ' vs ' . var_export($app, true) . ')',
        $pass, $fail, $errors);
}
ok($otherPages >= 1,
    'the data-build sweep found the ui/ page that carries one (' . $otherPages . ')',
    $pass, $fail, $errors);

// --------------------------------------------------------- every ?v= an asset
// What a browser is handed: both entry pages plus everything under ui/. A
// `?v=` that is computed (`?v=' + APP_VERSION`, `` ?v=${...} ``) is skipped on
// purpose -- there is no number in the file to disagree.
// `ide/` is its own page with its own cache-buster, and it was the place this
// test could not see: the studio opened `ide/index.php?v=475` while the IDE's
// own CSS and modules still said 474, so a browser kept yesterday's editor.
$assets = array($root . '/index.html');
foreach (array('ui', 'ide') as $tree) {
    $dir = $root . '/' . $tree;
    if (!is_dir($dir)) {
        continue;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        $name = strtolower($file->getFilename());
        if (!preg_match('/\.(js|css|html|php)$/', $name)) {
            continue;
        }
        if (strpos(str_replace('\\', '/', (string) $file), '/ui/vendor/') !== false) {
            continue;   // third-party, no cache-buster of ours in it
        }
        $assets[] = (string) $file;
    }
}
sort($assets);

$seen = 0;
$stale = array();
foreach ($assets as $path) {
    $text = @file_get_contents($path);
    if ($text === false) {
        continue;
    }
    $rel = str_replace('\\', '/', str_replace($root . '/', '', $path));
    $values = cache_busters($text);
    if (!$values) {
        continue;
    }
    $seen += count($values);
    $bad = stale_busters($text, $app);
    if ($bad) {
        $stale[] = $rel . ' (' . count($bad) . ' x ?v=' . $bad[0] . ')';
    }
}

ok($seen > 100,
    'the cache-buster sweep read the assets a browser gets (' . $seen . ' ?v= values in ' . count($assets) . ' files)',
    $pass, $fail, $errors);

ok(empty($stale),
    'every ?v= in ui/** and index.html names APP_VERSION ' . $app . ': ' . implode('; ', $stale),
    $pass, $fail, $errors);

// ------------------------------------------------------------------ the control
// A sweep that cannot fail is not a sweep. These prove the comparison bites.
ok(stale_busters("import x from './y.js?v=143';", $app) === array('143'),
    'the sweep flags an import left at an older number',
    $pass, $fail, $errors);
ok(stale_busters("import x from './y.js?v=" . $app . "';", $app) === array(),
    'and accepts the same import at the current number',
    $pass, $fail, $errors);
ok(stale_busters("const bust = `?v=" . '${APP_VERSION}' . "`;", $app) === array(),
    'and leaves a computed cache-buster alone',
    $pass, $fail, $errors);

// ------------------------------------------------------------------- report
echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . "\n";
    exit(1);
}
echo $pass . ' passed' . "\n";
