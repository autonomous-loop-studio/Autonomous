/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// stale jail tests -- clearing a per-agent file jail the server will refuse.
//
// Usage: node tests/js/staleJail.test.mjs
//
// A jail outlives the folder it names. This copy moved out of OneDrive, and
// every agent that remembered the old path then failed EVERY file tool with
// "sandbox directory does not exist" -- one stale setting, every call, which is
// exactly what a training drill is (a file call on every step). These assertions
// pin the repair: a jail outside the allowlist is cleared so the agent follows
// the global directory, a jail inside it is left alone, the global directory is
// moved to a root that exists, and an answer with no roots repairs nothing at
// all rather than blanking every path.
//
// The `?v=` is read from store.js rather than written here, because agentConfig
// imports a VERSIONED store.js and ESM would hand this file a second copy of the
// store -- the assertions would then edit one store and check another. Same
// lesson contextWindow.test.mjs and training.test.mjs already carry.
import { readFileSync } from 'node:fs';

const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('Stale jail tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}

const { store } = await import(`../../ui/js/store.js?v=${version}`);
const { repairStaleJails, sandboxRootFor } = await import(`../../ui/js/agentConfig.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };

console.log('stale jail tests');
console.log('-'.repeat(60));

const root = 'C:/Users/anonb/Desktop/Autonomous-Project/Autonomous-master/sandbox';
const moved = 'C:/Users/anonb/OneDrive/Desktop/Re-Release/Autonomous-Project/Autonomous-master/sandbox';
const status = { enabled: true, read_roots: [root], write_roots: [root] };

// --- a jail from before the move is cleared --------------------------------
store.set('agents', [
  { id: 'a1', name: 'no jail of its own' },
  { id: 'a2', name: 'inside the root', sandboxRoot: root + '/sub' },
  { id: 'a3', name: 'from the old folder', sandboxRoot: moved },
]);
store.set('settings.projectDir', moved);

ok(repairStaleJails(status) === true, 'a stale jail is reported as repaired');
const agents = store.get('agents');
ok(agents[0].sandboxRoot === undefined, 'an agent with no jail is untouched');
ok(agents[1].sandboxRoot === root + '/sub', 'a jail inside an allowed root is kept');
ok(agents[2].sandboxRoot === undefined,
  'a jail naming a folder that is not allowed any more is cleared');
ok(sandboxRootFor(agents[2]) === root,
  'so that agent now follows the global directory, which the server does allow');
ok(store.get('settings.projectDir') === root,
  'the global working directory is moved to a root that exists');

// --- it is idempotent: nothing left to change ------------------------------
ok(repairStaleJails(status) === false, 'a second run changes nothing');

// --- a Windows-style jail is understood too --------------------------------
store.set('agents', [{ id: 'b', sandboxRoot: moved.replace(/\//g, '\\') }]);
ok(repairStaleJails(status) === true, 'backslashes are normalised before comparing');
ok(store.get('agents')[0].sandboxRoot === undefined, 'and a stale backslash path is cleared');

// --- no usable answer is not a licence to rewrite settings -----------------
store.set('agents', [{ id: 'z', sandboxRoot: 'C:/elsewhere' }]);
store.set('settings.projectDir', 'C:/elsewhere');
ok(repairStaleJails(null) === false, 'an unreachable status repairs nothing');
ok(repairStaleJails({ enabled: false, read_roots: [], write_roots: [] }) === false,
  'a status with no allowed roots repairs nothing');
ok(store.get('agents')[0].sandboxRoot === 'C:/elsewhere',
  'and the value is left exactly where it was');
ok(store.get('settings.projectDir') === 'C:/elsewhere',
  'the global directory is left alone too');

// --- a write-only root counts, and a sibling path is not "inside" ----------
store.set('agents', [
  { id: 'w', sandboxRoot: 'C:/data/out' },
  { id: 'x', sandboxRoot: 'C:/data/output-not-inside' },
]);
store.set('settings.projectDir', 'C:/data/out/deeper');
ok(repairStaleJails({ read_roots: [], write_roots: ['C:/data/out'] }) === true,
  'a write-only root is enough to repair against');
const after = store.get('agents');
ok(after[0].sandboxRoot === 'C:/data/out', 'the root itself is kept');
ok(after[1].sandboxRoot === undefined,
  'a path that merely starts with the same letters is not inside the root');
ok(store.get('settings.projectDir') === 'C:/data/out/deeper',
  'a directory under the root is kept');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(errors.join('\n')); process.exit(1); }
