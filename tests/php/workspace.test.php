<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace — the one write path the IDE and the agents share.
 *
 * Usage: php tests/php/workspace.test.php
 *
 * The bug this exists to prevent: two writers, no shared truth. The IDE saved
 * through `ide/api.php` and an agent wrote through `Sandbox::writeFile`, so an
 * agent edit landed on disk while the editor kept its old buffer, and a user
 * save could land on top of a file an agent had just rewritten — with nothing
 * anywhere saying either had happened.
 *
 * `Src\Workspace` is now the only writer, and every mutation appends a line to
 * `storage/ide/revs.jsonl` with a single tree-wide revision number. These
 * assertions pin the parts a client depends on:
 *
 *   * revisions only ever go up, one per mutation, and `changes($since)` returns
 *     exactly the ones after it (that is what the IDE polls);
 *   * a write keeps the previous text, addressed by its sha1, so an agent's edit
 *     can be undone or diffed (the chat offers exactly that);
 *   * the path rules did not loosen while moving: `storage/`, `logs/`, `tmp/`,
 *     `sessions/`, `.git` and dot-folders are still refused at any depth, `..`
 *     still cannot leave the root, and an absolute path is accepted only when it
 *     resolves inside the root (the chat hands over the path a tool reported);
 *   * an audit line is never allowed to fail the write it describes.
 *
 * It runs against a temporary tree through `Workspace::useRoot()`, so nothing in
 * the operator's checkout is touched.
 *
 * Exits 0 on success, 1 on any failure.
 */

require_once __DIR__ . '/../../autoload.php';

use Src\Workspace;

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

/** Run $fn and report the message it refused with, or null when it agreed. */
function refused(callable $fn)
{
    try {
        $fn();
    } catch (\RuntimeException $e) {
        return $e->getMessage();
    }
    return null;
}

function rm_tree(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) ?: array() as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $full = $dir . '/' . $name;
        if (is_dir($full) && !is_link($full)) {
            rm_tree($full);
        } else {
            @unlink($full);
        }
    }
    @rmdir($dir);
}

$tmp = sys_get_temp_dir() . '/ws-' . getmypid() . '-' . mt_rand(1000, 9999);
@mkdir($tmp, 0777, true);
@mkdir($tmp . '/ui/js', 0777, true);
@mkdir($tmp . '/storage', 0777, true);
@mkdir($tmp . '/.git', 0777, true);
file_put_contents($tmp . '/VERSION', "1\n");
Workspace::useRoot($tmp);

// ------------------------------------------------------------- the rev log

$first = Workspace::write('ui/js/a.js', "one\n", 'agent');
ok($first['path'] === 'ui/js/a.js', 'a write reports the workspace-relative path (' . $first['path'] . ')', $pass, $fail, $errors);
ok($first['rev'] === 1, 'the first write is revision 1 (' . $first['rev'] . ')', $pass, $fail, $errors);
ok($first['size'] === 4, 'the write reports its byte count (' . $first['size'] . ')', $pass, $fail, $errors);
ok(is_file($tmp . '/ui/js/a.js') && file_get_contents($tmp . '/ui/js/a.js') === "one\n",
    'the file on disk holds what was written', $pass, $fail, $errors);

$second = Workspace::write('ui/js/a.js', "one\ntwo\n", 'agent');
ok($second['rev'] === 2, 'a second write is revision 2 (' . $second['rev'] . ')', $pass, $fail, $errors);
ok($second['prev'] !== '' && Workspace::blob($second['prev']) === "one\n",
    'the previous text is kept, addressed by its sha1, so the edit can be undone',
    $pass, $fail, $errors);
ok(Workspace::blob($second['hash']) === "one\ntwo\n",
    'the new text is kept under its own hash too', $pass, $fail, $errors);

ok(Workspace::currentRev() === 2, 'currentRev is the newest revision (' . Workspace::currentRev() . ')',
    $pass, $fail, $errors);

$all = Workspace::changes(0);
ok(count($all) === 2, 'changes(0) returns both writes (' . count($all) . ')', $pass, $fail, $errors);
ok(isset($all[0]['rev'], $all[1]['rev']) && $all[0]['rev'] < $all[1]['rev'],
    'the log comes back oldest first', $pass, $fail, $errors);
ok($all[1]['actor'] === 'agent' && $all[1]['op'] === 'write',
    'a line names who wrote and what they did (' . $all[1]['actor'] . '/' . $all[1]['op'] . ')',
    $pass, $fail, $errors);

$since = Workspace::changes(1);
ok(count($since) === 1 && $since[0]['rev'] === 2,
    'changes(1) returns only what happened after revision 1', $pass, $fail, $errors);
ok(Workspace::changes(99) === array(), 'changes() past the newest revision is empty', $pass, $fail, $errors);

// A note that is not a full write still lands in the same log: the tree has to
// hear about creates, renames and deletes as well as saves.
Workspace::note($tmp . '/ui/js/a.js', 'rename', 'user', 8, array('from' => 'ui/js/old.js'));
$afterNote = Workspace::changes(2);
ok(count($afterNote) === 1 && $afterNote[0]['op'] === 'rename' && $afterNote[0]['actor'] === 'user',
    'a note records its own op and actor', $pass, $fail, $errors);
ok(Workspace::currentRev() === 3, 'a note moves the revision (' . Workspace::currentRev() . ')',
    $pass, $fail, $errors);

// --------------------------------------------------------------- deletions

Workspace::remove('ui/js/a.js', 'user');
ok(!file_exists($tmp . '/ui/js/a.js'), 'remove deletes the file', $pass, $fail, $errors);
$afterDelete = Workspace::changes(3);
ok(count($afterDelete) === 1 && $afterDelete[0]['op'] === 'delete',
    'a delete is recorded like any other change', $pass, $fail, $errors);

// ------------------------------------------------------------ path rules

$msg = refused(function () { return Workspace::resolve('storage/config.json', false); });
ok($msg !== null && strpos($msg, 'not accessible') !== false,
    'storage/ is still refused (' . var_export($msg, true) . ')', $pass, $fail, $errors);

$msg = refused(function () { return Workspace::resolve('logs/x.txt', false); });
ok($msg !== null && strpos($msg, 'not accessible') !== false, 'logs/ is still refused', $pass, $fail, $errors);

$msg = refused(function () { return Workspace::resolve('.git/config', false); });
ok($msg !== null && strpos($msg, 'not accessible') !== false, '.git is still refused', $pass, $fail, $errors);

$msg = refused(function () { return Workspace::resolve('../outside.txt', false); });
ok($msg !== null && strpos($msg, 'escapes') !== false,
    '.. cannot leave the workspace (' . var_export($msg, true) . ')', $pass, $fail, $errors);

$msg = refused(function () use ($tmp) { return Workspace::resolve(sys_get_temp_dir() . '/elsewhere.txt', false); });
ok($msg !== null && strpos($msg, 'escapes') !== false,
    'an absolute path outside the root is refused (' . var_export($msg, true) . ')', $pass, $fail, $errors);

$inside = Workspace::resolve($tmp . '/ui/js/new.js', false);
ok(str_replace('\\', '/', $inside) === str_replace('\\', '/', $tmp . '/ui/js/new.js'),
    'an absolute path inside the root is accepted — the chat hands one over', $pass, $fail, $errors);

$msg = refused(function () { return Workspace::resolve('ui/js/missing.js', true); });
ok($msg !== null && strpos($msg, 'not found') === 0, 'a missing file that must exist is 404-shaped', $pass, $fail, $errors);

// An audit that cannot be written must never fail the write it describes.
Workspace::noteSafe($tmp . '/storage/config.json', 'write', 'agent');
ok(true, 'noteSafe swallows a refusal instead of raising it', $pass, $fail, $errors);

// A write through an absolute in-root path is still a normal write.
$abs = Workspace::write($tmp . '/ui/js/b.js', "b\n", 'user');
ok($abs['path'] === 'ui/js/b.js' && $abs['rev'] > 0,
    'writing by absolute in-root path is recorded relatively (' . $abs['path'] . ')', $pass, $fail, $errors);

// ------------------------------------------------- drill folder archive ----

// The IDE drill writes into the APP tree, which the sandbox jail cannot reach,
// so a stopped run's pass files stayed where they were and the next run's pass 1
// landed on top of them. The archive moves the folder once and deletes nothing.
@mkdir($tmp . '/training', 0777, true);
file_put_contents($tmp . '/training/ide-agent-x-p1.txt', "ide drill\n");
$archived = Workspace::archiveTrainingFolder('20261114-231845');
ok($archived === 'training-runs/20261114-231845/training',
    'the drill folder is moved to a dated training-runs/ folder (' . $archived . ')',
    $pass, $fail, $errors);
ok(!is_dir($tmp . '/training'), 'and training/ is gone from the project root', $pass, $fail, $errors);
ok(file_get_contents($tmp . '/training-runs/20261114-231845/training/ide-agent-x-p1.txt') === "ide drill\n",
    'the pass file survived the move, byte for byte', $pass, $fail, $errors);
ok(Workspace::archiveTrainingFolder('20261114-231846') === '',
    'a call with nothing to move answers quietly', $pass, $fail, $errors);

@mkdir($tmp . '/training', 0777, true);
file_put_contents($tmp . '/training/ide-agent-y-p1.txt', "again\n");
$msg = refused(function () { return Workspace::archiveTrainingFolder('20261114-231845'); });
ok($msg !== null && strpos($msg, 'already exists') !== false,
    'an occupied destination is refused instead of merging two runs together (' . var_export($msg, true) . ')',
    $pass, $fail, $errors);
ok(is_file($tmp . '/training/ide-agent-y-p1.txt'),
    'and a refused archive leaves the files where they were', $pass, $fail, $errors);
@mkdir($tmp . '/training-runs/20261114-231847', 0777, true);
ok(Workspace::archiveTrainingFolder('20261114-231847') === 'training-runs/20261114-231847/training',
    'the next run is moved aside under its own stamp', $pass, $fail, $errors);

// ------------------------------------------------------------------- tidy
Workspace::useRoot(null);
rm_tree($tmp);

echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . "\n";
    exit(1);
}
echo $pass . ' passed' . "\n";
