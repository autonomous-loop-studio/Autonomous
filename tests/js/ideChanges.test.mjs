/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ideChanges tests -- what the IDE does with a change it did not make.
//
// Usage: node tests/js/ideChanges.test.mjs
//
// This is the part of "agents and the user share one editor" that can lose
// someone's work, so it is a pure function and it is tested here rather than
// behind a browser. The rule the whole feature rests on: a clean buffer reloads,
// a dirty buffer never does — the human's unsaved text wins until they say
// otherwise.

import { planChanges, describeChange } from '../../ide/js/changes.js';

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('ide changes tests');
console.log('-'.repeat(60));

const clean = { path: 'ui/js/tools.js', modified: false, binary: false };
const dirty = { path: 'ui/js/chat.js', modified: true, binary: false };
const image = { path: 'ui/img/logo.png', modified: false, binary: true };
const tabs = [clean, dirty, image];

// --- a clean buffer reloads -------------------------------------------------
eq(planChanges(tabs, [{ path: 'ui/js/tools.js', rev: 7, actor: 'agent' }]).reload,
  ['ui/js/tools.js'], 'a clean buffer is reloaded');

// --- a dirty buffer is a conflict, never a reload ---------------------------
const dirtyPlan = planChanges(tabs, [{ path: 'ui/js/chat.js', rev: 8, actor: 'agent', op: 'write' }]);
eq(dirtyPlan.reload, [], 'a dirty buffer is not reloaded');
eq(dirtyPlan.conflict.length, 1, 'a dirty buffer raises one conflict');
eq(dirtyPlan.conflict[0].actor, 'agent', 'the conflict says who changed it');
eq(dirtyPlan.conflict[0].rev, 8, 'the conflict carries the revision it saw');

// --- files that are not open are not the editor's business ------------------
eq(planChanges(tabs, [{ path: 'src/Workspace.php', rev: 9 }]).ignore, ['src/Workspace.php'],
  'a file that is not open is ignored');

// --- a binary tab is ignored even when clean --------------------------------
eq(planChanges(tabs, [{ path: 'ui/img/logo.png', rev: 10 }]).ignore, ['ui/img/logo.png'],
  'a binary tab is ignored');

// --- our own save is not "changed on disk" ---------------------------------
eq(planChanges(tabs, [{ path: 'ui/js/tools.js', rev: 11 }], ['ui/js/tools.js']).reload, [],
  'the IDE\'s own save is skipped');
eq(planChanges(tabs, [{ path: 'ui/js/tools.js', rev: 11 }], new Set(['ui/js/tools.js'])).reload, [],
  'and a Set works the same as an array');

// --- several changes, mixed -------------------------------------------------
const mixed = planChanges(tabs, [
  { path: 'ui/js/tools.js', rev: 12 },
  { path: 'ui/js/chat.js', rev: 13, actor: 'agent' },
  { path: 'ui/js/chat.js', rev: 13, actor: 'agent' },
  { path: 'src/Workspace.php', rev: 14 },
]);
eq(mixed.reload, ['ui/js/tools.js'], 'one clean reload in a mixed batch');
eq(mixed.conflict.length, 1, 'the same path twice is one conflict, not two');
eq(mixed.ignore, ['src/Workspace.php'], 'the unopened path stays in ignore');

// --- path spelling: backslashes and a leading ./ are the same file ---------
eq(planChanges(tabs, [{ path: '.\\ui\\js\\tools.js', rev: 15 }]).reload, ['ui/js/tools.js'],
  'a Windows-style path matches the tab it names');

// --- nothing to do ----------------------------------------------------------
eq(planChanges(tabs, []), { reload: [], conflict: [], ignore: [] }, 'an empty batch is a no-op');
eq(planChanges([], [{ path: 'ui/js/tools.js', rev: 16 }]).ignore, ['ui/js/tools.js'],
  'with no tabs open everything is ignored');

// --- the words the operator reads ------------------------------------------
ok(describeChange({ path: 'ui/js/tools.js', actor: 'agent', op: 'write' })
  === 'ui/js/tools.js was changed by an agent', 'an agent write reads as an agent');
ok(describeChange({ path: 'x.js', actor: 'agent:qwen', op: 'write' }).includes('an agent'),
  'an actor named agent:<model> still reads as an agent');
ok(describeChange({ path: 'x.js', actor: 'user', op: 'write' }).includes('another editor'),
  'anything else reads as another editor');
ok(describeChange({ path: 'x.js', actor: 'agent', op: 'delete' }) === 'x.js was deleted by an agent',
  'a delete is described as a delete');

console.log('-'.repeat(60));
if (fail) {
  console.log(errors.join('\n'));
  console.log(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`${pass} passed`);
