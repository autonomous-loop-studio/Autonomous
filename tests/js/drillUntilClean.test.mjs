/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// The drill repeats until one pass is 100% clean.
//
// Usage: node tests/js/drillUntilClean.test.mjs
//
// Three promises are pinned here:
//
//   1. A step only passes when the exact call for it succeeds. A wrong tool is
//      off-step, a right tool with wrong arguments is a failed attempt, and a
//      skipped call proves nothing -- so a step cannot be skipped into the
//      score. The step has to be repeated correctly.
//   2. A pass is 100% clean only when every step passed with no failed attempt
//      and no retry. A corrected step is still not clean.
//   3. The run's stopping rule defaults to ONE clean pass, so whole passes
//      repeat until the agent reaches 100% and then the run stops. 0 remains
//      the explicit "never stop".
//
// The clean history below is a real Hard pass (17 steps), built with the same
// arguments and result text the live tools return.

import { readFileSync } from 'node:fs';
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('drillUntilClean tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}
const { trainingFileFor, trainingCleanTarget, drillVerdict, drillVerdictText, reachedCleanTarget } =
  await import(`../../ui/js/training.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('drillUntilClean tests');
console.log('-'.repeat(60));

const file = trainingFileFor({ id: 'agent-clean' }, 'hard', 1);

/** A complete, clean Hard pass: every step correct, no failed attempt. */
function cleanPass() {
  return [
    { tool: 'think', arg: { thought: 'run the drill' }, status: 'ok', result: 'ok' },
    { tool: 'todo_write', arg: { items: [] }, status: 'ok', result: 'ok' },
    { tool: 'echo', arg: 'training', status: 'ok', result: 'training' },
    { tool: 'now', arg: {}, status: 'ok', result: '2026-11-19 10:00' },
    { tool: 'write_file', arg: { path: file, content: 'training' }, status: 'ok', result: 'wrote 8 bytes' },
    { tool: 'read_file', arg: { path: file }, status: 'ok', result: 'training' },
    { tool: 'read_file', arg: { path: file, range: '1-1' }, status: 'ok', result: 'training' },
    { tool: 'edit_file', arg: { path: file, old_string: 'training', new_string: 'training\ndrill 2 passed' }, status: 'ok', result: 'ok' },
    { tool: 'edit_file', arg: { path: file, old_string: 'drill 2 passed', new_string: 'drill 2 passed (exact match)' }, status: 'ok', result: 'ok' },
    { tool: 'list_dir', arg: { path: 'training' }, status: 'ok', result: 'training/' + file.split('/').pop() },
    { tool: 'glob_files', arg: { pattern: 'training/*' }, status: 'ok', result: file },
    { tool: 'grep_code', arg: { pattern: 'training' }, status: 'ok', result: file },
    { tool: 'show_find', arg: { pattern: 'training' }, status: 'ok', result: 'training: 1 match' },
    { tool: 'exec', arg: { argv: ['echo', 'training'] }, status: 'ok', result: 'training' },
    { tool: 'show_command', arg: { argv: ['echo', 'training'] }, status: 'ok', result: 'training' },
    { tool: 'todo_write', arg: { items: [] }, status: 'ok', result: 'ok' },
    { tool: 'show_file', arg: { path: file }, status: 'ok', result: 'training\ndrill 2 passed (exact match)' },
  ];
}

/** A complete Advanced pass (8 steps): fetch, save, read, show, show_file. */
function advancedPass(file) {
  return [
    { tool: 'think', arg: {}, status: 'ok', result: 'ok' },
    { tool: 'todo_write', arg: { items: [] }, status: 'ok', result: 'ok' },
    { tool: 'fetch_url', arg: { url: 'http://drill.local/advanced.html' }, status: 'ok', result: 'HTTP 200 \u2014 drill-page-v1' },
    { tool: 'write_file', arg: { path: file, content: 'drill-page-v1 ' + 'x'.repeat(60) }, status: 'ok', result: 'wrote 73 bytes' },
    { tool: 'read_file', arg: { path: file }, status: 'ok', result: 'drill-page-v1' },
    { tool: 'show_url', arg: { url: 'http://drill.local/advanced.html' }, status: 'ok', result: 'drill-page-v1' },
    { tool: 'show_file', arg: { path: file }, status: 'ok', result: 'drill-page-v1' },
    { tool: 'todo_write', arg: { items: [] }, status: 'ok', result: 'ok' },
  ];
}

const calls = cleanPass();
eq(calls.length, 17, 'the Hard drill has 17 steps');

// --- 1. a full pass with no failed attempt is 100%, with 0 retries ----------
const clean = drillVerdict(calls, file, 'hard');
eq(clean.step, clean.totalSteps, 'the clean pass completed all 17 steps');
eq(clean.complete, true, 'the pass is complete');
eq(clean.clean, true, 'with no failed attempt it is clean');
eq(clean.failures, 0, 'zero failed attempts');
eq(clean.retries, 0, 'zero retries');
eq(clean.cleanPasses, 1, 'the run counts one clean pass');

// --- 2. no skipping: a wrong call cannot advance the step -------------------
const wrongWrite = [{
  tool: 'write_file',
  arg: { path: file, content: 'not the drill' },
  status: 'ok',
  result: 'wrote 12 bytes',
}];
// Use a non-inspection later call here: read_file is deliberately a neutral
// scratchpad, so it cannot be the test's example of an off-step call.
const skipped = [...calls.slice(0, 4), ...wrongWrite, calls[7]];
const s = drillVerdict(skipped, file, 'hard');
eq(s.step, 4, 'a wrong step-5 write does not advance the drill');
eq(s.failures, 1, 'it is a failed attempt at step 5');
eq(s.failedAt, 5, 'the failure is pinned to step 5');
eq(s.nextTool, 'write_file', 'the drill still waits for step 5');
eq(s.offTool, 'edit_file', 'a call for a later step is off-step, not a pass');
const afterFix = drillVerdict([...skipped, calls[4]], file, 'hard');
eq(afterFix.step, 5, 'the corrected step 5 advances, so the next step was never skipped');

// --- 3. the step repeats until it is done correctly -------------------------
const wrongEcho = [calls[0], calls[1], { ...calls[2], result: 'something else' }];
const e = drillVerdict(wrongEcho, file, 'hard');
eq(e.step, 2, 'an echo that does not say "training" does not pass step 3');
eq(e.failures, 1, 'it is a failed attempt');
eq(e.failureStep, 3, 'the report quotes step 3');
const fixedEcho = drillVerdict([...wrongEcho, calls[2]], file, 'hard');
eq(fixedEcho.step, 3, 'repeating the step correctly passes it');

// --- 4. a corrected pass is not 100%; the next clean one is -----------------
const dirty = [
  ...calls.slice(0, 4),
  { ...calls[4], status: 'error', result: 'Error: approval denied' },
  ...calls.slice(4),
];
const d = drillVerdict(dirty, file, 'hard');
eq(d.complete, true, 'the pass finishes after the retry');
eq(d.clean, false, 'a corrected step means the pass is not 100%');
eq(d.cleanPasses, 0, 'no clean pass is counted');
eq(reachedCleanTarget({ cleanPassTarget: 1 }, { agent: d }), null,
  'a dirty pass does not end the run');

const twoPasses = drillVerdict(dirty.concat(cleanPass()), file, 'hard');
eq(twoPasses.passes, 2, 'the run completed two passes');
eq(twoPasses.cleanPasses, 1, 'the second pass is the clean one');
const hit = reachedCleanTarget({ cleanPassTarget: 1 }, { agent: twoPasses });
ok(!!hit && hit.cleanPasses === 1, 'the run stops at the first 100% clean pass');
eq(reachedCleanTarget({ cleanPassTarget: 0 }, { agent: twoPasses }), null,
  'target 0 still means never stop');

// --- 5. a mid-pass think is a scratchpad, never a restart --------------------
const advFile = trainingFileFor({ id: 'agent-adv' }, 'advanced', 1);
const adv = advancedPass(advFile);
const stuck = adv.slice(0, 6).concat(Array.from({ length: 12 }, () => ({
  tool: 'show_file', arg: { path: 'training/wrong.txt' }, status: 'error', result: 'not a file',
})));
const before = drillVerdict(stuck, advFile, 'advanced');
eq(before.step, 6, 'the stuck attempt sits at step 6');
ok(drillVerdictText(before).includes('12 failed'), 'the strip shows the failed attempts');
const think = { tool: 'think', arg: {}, status: 'ok', result: 'ok' };
const withThink = drillVerdict(stuck.concat([think]), advFile, 'advanced');
eq(withThink.step, 6, 'a mid-pass think does not reset the step');
eq(withThink.failures, 12, 'nor the live failure count');
eq(withThink.restarts, 0, 'and is not a restart');
eq(withThink.offStep, before.offStep, 'and is not counted as off-step');
eq(withThink.failuresTotal, 12, 'the failures stay in the run tally');
ok(drillVerdictText(withThink).includes('12 failed'), 'the strip still carries them');
const finished = drillVerdict(stuck.concat([think, adv[6], adv[7]]), advFile, 'advanced');
eq(finished.complete, true, 'the same pass can finish after the scratchpad call');
eq(finished.clean, false, 'but it is not clean while it carries 12 failures');
eq(finished.cleanPasses, 0, 'so it does not count toward the clean-pass target');
eq(finished.failuresTotal, 12, 'and the run still reports them');
const cleanWithThink = drillVerdict([...adv.slice(0, 6), think, ...adv.slice(6)], advFile, 'advanced');
eq(cleanWithThink.clean, true, 'a scratchpad think does not stop a clean pass');
eq(cleanWithThink.cleanPasses, 1, 'and the pass still counts toward the target');
const fresh = drillVerdict(adv, advFile, 'advanced');
eq(fresh.cleanPasses, 1, 'a fresh pass with no failed attempt is still clean');

// --- 6. the stopping rule defaults to one clean pass ------------------------
eq(trainingCleanTarget({}), 1, 'an unset target means stop at the first clean pass');
eq(trainingCleanTarget({ cleanPassTarget: undefined }), 1, 'undefined is unset');
eq(trainingCleanTarget({ cleanPassTarget: 0 }), 1, 'a saved 0 is the old default and is read as 1');
eq(trainingCleanTarget({ cleanPassTarget: 2 }), 2, 'a saved number is honoured');
eq(trainingCleanTarget({ cleanPassTarget: '3' }), 3, 'a numeric string is accepted');
eq(trainingCleanTarget({ cleanPassTarget: -3 }), 1, 'a negative target is floored at one clean pass');
eq(trainingCleanTarget({ cleanPassTarget: 999 }), 99, 'the ceiling is clamped');

for (const line of errors) console.log(line);
console.log(`drillUntilClean: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
