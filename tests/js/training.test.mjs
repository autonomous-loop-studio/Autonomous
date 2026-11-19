/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Training-mode drill tests.
//
// Usage: node tests/js/training.test.mjs
//
// Covers the drill table and the armed/disarmed prompt block. The governor
// halving is exercised through limitsFor with a settings flip. No network.
// Exits 0 on success, 1 on failure.
//
// The `?v=` is read from store.js rather than written here, because the
// cache-buster moves on every UI release: a hardcoded copy silently splits
// this test from the modules under test the first time it moves (the armed
// assertions fail while nothing at all is wrong with the code). Same lesson
// commsLog.test.mjs learned first.
import { readFileSync } from 'node:fs';
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('Training mode tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}
const {
  TRAINING_THROTTLE, TRAINING_DIR, TRAINING_FILE, TRAINING_FILE_TOKEN, TRAINING_TASKS, TRAINING_TASKS_EASY,
  TRAINING_TASKS_ADVANCED, TRAINING_TASKS_FRONTIER, TRAINING_TASKS_BROWSER, DRILL_CHECKS_ADVANCED,
  DRILL_CHECKS_EASY, DRILL_CHECKS_FRONTIER, DRILL_CHECKS_BROWSER, TRAINING_BROWSER_TOKEN, TRAINING_PAGE_URL,
  TRAINING_TASKS_IDE, DRILL_CHECKS_IDE,
  trainingFileFor, trainingFileNow, trainingFileCheckFor, trainingPassOf, formatPassLine, isTrainingActive, trainingStepList, trainingBlockFor, trainingKickoffFor, trainingResumeFor,
  shouldResumeDrill, reachedCleanTarget, drillStripTitle, trainingDifficulty, trainingTasksFor, trainingChecksFor, showsEveryPass,
  trainingDifficultyLabel, trainingDifficultyHint, drillVerdict, drillVerdictText, normalizeCustomSteps, CUSTOM_STEP_MAX,
  drillPassFile, drillWriteRefusal, drillStepRefusal,
  trainingTaskExample, trainingToolScope, trainingNow, callSignature, drillRepeatNotice, drillFailureNotice,
  trainingAccuracy, todoPlanIsCurrent, DRILL_REPEAT_HINT, DRILL_REPEAT_LIMIT,
} = await import(`../../ui/js/training.js?v=${version}`);
const trainingModule = await import(`../../ui/js/training.js?v=${version}`);
const { store } = await import(`../../ui/js/store.js?v=${version}`);
const { limitsFor } = await import(`../../ui/js/rateGovernor.js?v=${version}`);
const { TOOL_REGISTRY } = await import(`../../ui/js/tools.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('Training mode tests');
console.log('-'.repeat(60));

// The throttle is the documented half rate.
eq(TRAINING_THROTTLE, 0.5, 'throttle is 50%');

// The drill lives in one sandbox folder and names it.
ok(TRAINING_TASKS.length >= 10, `drill has a full tool list (got ${TRAINING_TASKS.length})`);
ok(TRAINING_TASKS.every(t => t.tool && t.label), 'every step names a tool and a task');
eq(TRAINING_TASKS[0].tool, 'think', 'drill starts free (no approval gate)');
// The drill ends on a display tool ON PURPOSE: show_file paints the result into
// the transcript and ends the turn, so a show step anywhere earlier would strand
// every step after it. Completion is recorded in the step just before it.
eq(TRAINING_TASKS[TRAINING_TASKS.length - 1].tool, 'show_file',
  'drill ends by showing its result, not by describing it');
eq(TRAINING_TASKS[TRAINING_TASKS.length - 2].tool, 'todo_write',
  'completion is recorded immediately before the final show');
ok(TRAINING_TASKS.some(t => t.label.includes(TRAINING_FILE_TOKEN)), 'drill creates the agent\'s own training file');
ok(TRAINING_TASKS.filter(t => t.tool === 'edit_file').length >= 2,
  'drill edits twice with exact old_string/new_string replaces');
const appendStep = TRAINING_TASKS.find(t => t.tool === 'edit_file'
  && t.label.includes('drill 2 passed') && !t.label.includes('(exact match)'));
ok(!!appendStep && /old_string/.test(appendStep.label) && /new_string/.test(appendStep.label),
  'the add-a-line step teaches an anchored old_string/new_string replace, not a bare append');
ok(TRAINING_TASKS.some(t => t.tool === 'read_file' && /1-1/.test(t.label)),
  'drill teaches a ranged read so a big file is not pulled in whole');
ok(TRAINING_TASKS.filter(t => t.tool === 'read_file').every(t => /not show_file/.test(t.label)),
  'read steps say read_file, not show_file');
ok(TRAINING_TASKS.filter(t => t.tool === 'edit_file').every(t =>
  /not write_file/.test(t.label) && /str_replace_editor/.test(t.label)),
  'edit steps rule out write_file and str_replace_editor');
ok(/not read_file/.test(TRAINING_TASKS[TRAINING_TASKS.length - 1].label),
  'the final show_file step rules out read_file');
// A display step ends the turn, and training mode resumes the drill -- so the
// family can be practiced mid-drill, not only as the last step.
const showSteps = TRAINING_TASKS.filter(t => t.tool.startsWith('show_'));
ok(showSteps.length >= 3, `drill practices several display tools (got ${showSteps.length})`);
ok(showSteps.some(t => t.tool === 'show_file'), 'show_file is practiced');
ok(showSteps.some(t => t.tool === 'show_find'), 'show_find is practiced');
ok(showSteps.some(t => t.tool === 'show_command'), 'show_command is practiced');
ok(!('TRAINING_RESUME_LIMIT' in trainingModule),
  'no resume budget is exported: the loop is closed and unbounded');
ok(TRAINING_DIR === 'training' && TRAINING_FILE === 'training/training.txt', 'drill folder/default file constants');
eq(trainingFileFor({ id: 'agent_abc123' }), 'training/training-abc123-p1.txt', 'an agent gets a file named after its id');
eq(trainingFileFor({ id: 'agent_abc123' }, 'hard', 2), 'training/training-abc123-p2.txt',
  'a second pass writes a file with its own name');
ok(trainingFileFor({ id: 'agent_a' }, 'hard', 1) !== trainingFileFor({ id: 'agent_a' }, 'hard', 2),
  'two passes never share one drill file');
ok(trainingFileFor({ id: 'agent_a' }) !== trainingFileFor({ id: 'agent_b' }),
  'two agents never share one drill file');
eq(trainingStepList().length, TRAINING_TASKS.length, 'step list covers every task');
ok(trainingStepList()[0].startsWith('1. think'), 'step list is numbered from 1');

// Easy mode is the original 12-step sequence, kept beside the current drill.
eq(TRAINING_TASKS_EASY.length, 12, 'easy mode has the original 12 steps');
eq(TRAINING_TASKS_EASY[TRAINING_TASKS_EASY.length - 1].tool, 'todo_write',
  'easy mode ends on the original completion step');
ok(TRAINING_TASKS_EASY.some(t => t.tool === 'edit_file' && t.label.includes('Append a second line')),
  'easy mode keeps the old append wording that step 7 is meant to diagnose');
ok(!TRAINING_TASKS_EASY.some(t => t.tool.startsWith('show_')),
  'easy mode has no display-tool steps');
{
  const easyAgent = { id: 'agent_test' };
  const easyFile = trainingFileFor(easyAgent, 'easy');
  const easyCard = trainingTaskExample(TRAINING_TASKS_EASY[6], easyAgent, 'easy');
  ok(easyCard.includes('"old_string":"training"') && easyCard.includes('drill 2 passed'),
    'easy step 7 has a copyable anchored-edit card, not a bare append');
  ok(DRILL_CHECKS_EASY[6]({ tool: 'edit_file', arg: { path: easyFile, old_string: 'training', new_string: 'training\ndrill 2 passed' } }, easyFile),
    'easy step 7 passes the anchored edit that adds the second line');
  ok(DRILL_CHECKS_EASY[6]({ tool: 'edit_file', arg: { path: easyFile, old_string: 'training', new_string: 'training\\ndrill 2 passed' } }, easyFile),
    'easy step 7 accepts the literal escape the tool repairs for a drill file');
  ok(!DRILL_CHECKS_EASY[6]({ tool: 'edit_file', arg: { path: easyFile, old_string: '\n', new_string: 'training\ndrill 2 passed' } }, easyFile),
    'easy step 7 rejects the newline anchor that cannot match this file');
}
eq(trainingTasksFor('easy'), TRAINING_TASKS_EASY, 'easy selects the 12-step table');
eq(trainingTasksFor('hard'), TRAINING_TASKS, 'hard selects the current table');
eq(trainingDifficulty({}), 'hard', 'a missing difficulty defaults to hard');
eq(trainingDifficulty({ difficulty: 'easy' }), 'easy', 'easy reads back');
eq(trainingDifficulty({ difficulty: 'advanced' }), 'advanced', 'advanced reads back');
eq(trainingDifficulty({ difficulty: 'frontier' }), 'frontier', 'frontier reads back');
eq(trainingDifficulty({ difficulty: 'custom' }), 'custom', 'custom reads back');
eq(trainingDifficulty({ difficulty: 'nonsense' }), 'hard', 'an unknown difficulty falls back to hard');
eq(trainingChecksFor('easy').length, 12, 'easy checks align with its 12 steps');
eq(trainingChecksFor('hard').length, TRAINING_TASKS.length, 'hard checks align with its steps');
eq(trainingStepList(null, 'easy').length, 12, 'the dialog can list the easy steps');
eq(trainingStepList(null, 'hard').length, 17, 'the dialog can list the hard steps');

// Advanced is the fetch → save → show pipeline behind "show_url URL > log.txt".
eq(TRAINING_TASKS_ADVANCED.length, 8, 'advanced mode has 8 steps');
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'fetch_url' && t.label.includes('{page}')),
  'advanced fetches the drill page with fetch_url');
{
  // The page must be the app's own: a public site that rewords itself graded a
  // correct save as a failure (v465), and no follow-up release can prevent that.
  const filled = TRAINING_TASKS_ADVANCED[2].label.split('{page}').join(TRAINING_PAGE_URL);
  ok(filled.includes('http://drill.local/advanced.html') && !filled.includes('{page}'),
    'the advanced fetch step names the app-served drill page, not a public site');
}
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'write_file' && t.label.includes('{file}')),
  'advanced saves the fetched page to the agent log file');
ok(TRAINING_TASKS_ADVANCED.some(t => t.label.includes('cannot redirect')),
  'advanced explains that show_url cannot redirect into a file');
ok(TRAINING_TASKS_ADVANCED.some(t => t.tool === 'show_file'), 'advanced shows the saved copy');
eq(trainingTasksFor('advanced'), TRAINING_TASKS_ADVANCED, 'advanced selects its own table');
eq(trainingChecksFor('advanced'), DRILL_CHECKS_ADVANCED, 'advanced selects its own checks');
eq(trainingFileFor({ id: 'agent_adv' }, 'advanced'), 'training/advanced-nt-adv-p1.txt',
  'advanced gets its own per-agent log file');
eq(trainingFileFor({ id: 'agent_adv' }), 'training/training-nt-adv-p1.txt',
  'the default file stays the hard drill file');
eq(trainingStepList(null, 'advanced').length, 8, 'the dialog can list the advanced steps');

// Frontier is the real-desktop Notepad demo.
eq(TRAINING_TASKS_FRONTIER.length, 6, 'frontier mode has 6 steps');
for (const name of ['window_list', 'window_open', 'window_type']) {
  ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === name), `frontier uses ${name}`);
}
ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === 'window_open' && /notepad/i.test(t.label)),
  'frontier opens Notepad');
ok(TRAINING_TASKS_FRONTIER.some(t => t.tool === 'window_type' && /Hello!/.test(t.label)),
  'frontier types Hello!');
eq(trainingTasksFor('frontier'), TRAINING_TASKS_FRONTIER, 'frontier selects its own table');
eq(trainingChecksFor('frontier'), DRILL_CHECKS_FRONTIER, 'frontier selects its own checks');
eq(trainingStepList(null, 'frontier').length, 6, 'the dialog can list the frontier steps');
eq(trainingDifficultyLabel('custom'), 'Custom', 'custom has a display name');
ok(trainingDifficultyHint('custom').includes('saved'), 'custom hint points at the saved steps');
eq(trainingDifficultyLabel('advanced'), 'Advanced', 'advanced has a display name');
eq(trainingDifficultyLabel('frontier'), 'Frontier', 'frontier has a display name');
ok(trainingDifficultyHint('advanced').includes('fetch_url'), 'advanced hint names fetch_url');
ok(trainingDifficultyHint('frontier').includes('Notepad'), 'frontier hint names Notepad');

// Browser is a separate, local-page drill rather than a longer Frontier.
eq(TRAINING_TASKS_BROWSER.length, 9, 'browser mode has 9 steps');
for (const name of ['browser_open', 'browser_read', 'browser_type', 'browser_click', 'browser_wait']) {
  ok(TRAINING_TASKS_BROWSER.some(t => t.tool === name), `browser drill uses ${name}`);
}
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_open' && t.label.includes(TRAINING_BROWSER_TOKEN)),
  'browser drill opens the local page placeholder');
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_type' && /#drill-name/.test(t.label) && /training/.test(t.label)),
  'browser drill types into the documented field');
ok(TRAINING_TASKS_BROWSER.some(t => t.tool === 'browser_click' && /#drill-submit/.test(t.label)),
  'browser drill clicks the documented button');
eq(trainingTasksFor('browser'), TRAINING_TASKS_BROWSER, 'browser selects its own table');
eq(trainingChecksFor('browser'), DRILL_CHECKS_BROWSER, 'browser selects its own checks');
eq(trainingDifficulty({ difficulty: 'browser' }), 'browser', 'browser difficulty reads back');
eq(trainingDifficultyLabel('browser'), 'Browser', 'browser has a display name');
ok(trainingDifficultyHint('browser').includes('local-page'), 'browser hint names its local page');
ok(trainingDifficultyHint('browser').includes('visible window'), 'browser hint requires a visible window');
ok(trainingDifficultyHint('browser').includes('Labs → Browser'), 'browser hint states the Labs prerequisite');
eq(trainingStepList(null, 'browser').length, 9, 'the dialog can list the browser steps');
ok(trainingStepList(null, 'browser')[2].includes('browser.html'),
  'the browser step list resolves the local page URL');
ok(trainingStepList(null, 'browser')[2].includes('headless'),
  'the browser step list asks for a visible window');

// Disarmed by default: the prompt block injects nothing.
store.set('settings.trainingMode', { active: false, startedAt: 0 });
eq(isTrainingActive(), false, 'off by default');
eq(trainingBlockFor(), '', 'no prompt block while off');

// Armed: one retry-until-pass block heading the prompt.
store.set('settings.trainingMode', { active: true, startedAt: 1 });
eq(isTrainingActive(), true, 'armed flag reads back');
const drillFile = trainingFileFor({ id: 'agent_test' });
const block = trainingBlockFor({ id: 'agent_test' });
ok(block.includes('TRAINING MODE'), 'block names the mode');
ok(block.includes('TRY AGAIN'), 'block orders retries on failure');
ok(block.includes('never skip'), 'block forbids skipping failed steps');
ok(block.includes(drillFile), 'block names this agent\'s drill file');
ok(block.includes('OWN drill file'), 'block forbids touching another agent\'s file');
ok(trainingBlockFor({ id: 'agent_other' }).includes(trainingFileFor({ id: 'agent_other' })),
  'each agent\'s block names its own file');

// One file per PASS: the file an agent is handed changes when a pass ends, so
// no pass starts against the previous pass's finished bytes. The number lives
// in the store, so the block, the step labels and the verdict cannot disagree
// about which file this pass is using.
store.set('settings.trainingMode', { active: true, startedAt: 1 });
eq(trainingFileNow({ id: 'agent_test' }), 'training/training-t-test-p1.txt',
  'the live drill file is pass 1 before any pass completes');
store.set('settings.trainingMode', { active: true, startedAt: 1, pass: 2 });
eq(trainingFileNow({ id: 'agent_test' }), 'training/training-t-test-p2.txt',
  'the second pass writes a file nothing has used');
ok(trainingBlockFor({ id: 'agent_test' }).includes('training/training-t-test-p2.txt'),
  'the prompt block follows the stored pass');
ok(trainingStepList({ id: 'agent_test' }).some(s => s.includes('training/training-t-test-p2.txt')),
  'the step labels follow the stored pass');
eq(trainingPassOf({}), 1, 'a run with no stored pass is pass 1');
eq(trainingPassOf({ pass: 0 }), 1, 'pass 0 is not a pass');
eq(trainingPassOf({ pass: '3' }), 3, 'a stored pass reads back as a number');
// Grading follows the pass counter: each call must name the file of the pass it
// belongs to, not any generation of the name. The looser rule let a second pass
// rewrite the first pass's log and still read clean.
const drillFileOf = trainingFileCheckFor({ id: 'agent_test' });
eq(drillFileOf(1), 'training/training-t-test-p1.txt', 'pass 1 is graded against its own file');
eq(drillFileOf(2), 'training/training-t-test-p2.txt', 'pass 2 is graded against a different file');
ok(typeof drillFileOf === 'function', 'the pass is resolved while the history is walked, not up front');

// The run report lists each pass and the file it wrote, so a pass can be
// verified by opening that file instead of trusting the scoreboard.
eq(formatPassLine({ pass: 2, file: 'training/training-agent-test-p2.txt', clean: true, failures: 0 }),
  'pass 2 · training/training-agent-test-p2.txt · clean', 'a pass line names the pass, its file and its verdict');
ok(formatPassLine({ pass: 1, file: 'f.txt', clean: false, failures: 3 }).endsWith('3 failed attempts'),
  'a dirty pass says how many attempts failed');
ok(formatPassLine({ pass: 1, file: 'f.txt', clean: false, failures: 1 }).endsWith('1 failed attempt'),
  'one failure is singular');
// A failure line quotes the error the pass hit first, so the report answers
// "what went wrong" and not only "where".
ok(formatPassLine({
  pass: 2, file: 'f.txt', clean: false, failures: 2, step: 8,
  reason: 'str_replace: old string not found.',
}).endsWith('2 failed attempts · first at step 8: "str_replace: old string not found."'),
  'a failed pass quotes its first error and the step it happened on');
ok(formatPassLine({
  pass: 1, file: 'f.txt', clean: false, failures: 1, step: 5, reason: 'x'.repeat(300),
}).includes('…'), 'a long error is clipped rather than printed whole');
ok(!formatPassLine({ pass: 1, file: 'f.txt', clean: true, reason: 'ignored' }).includes('first at step'),
  'a clean pass never prints a failure reason');
eq(formatPassLine(null), '', 'no entry prints no line');
eq(formatPassLine({ pass: 0, file: 'f.txt', clean: true }), 'pass 1 · f.txt · clean',
  'an unusable pass number prints as pass 1');
// The self-test writes these two paths; they must be distinct and stable.
eq(trainingFileFor({ id: 'agent_drill_selftest' }, 'hard', 1),
  'training/training-lftest-p1.txt', 'the self-test writes its own pass-1 file');
eq(trainingFileFor({ id: 'agent_drill_selftest' }, 'hard', 2),
  'training/training-lftest-p2.txt', 'the self-test writes its own pass-2 file');
store.set('settings.trainingMode', { active: true, startedAt: 1 });
ok(trainingStepList().some(s => s.includes('training/training-<agent>-p1.txt')),
  'the operator-facing step list stays generic across agents');
for (const t of TRAINING_TASKS) ok(block.includes(t.tool), `block lists ${t.tool}`);
// The display family is taught by name even though only one is practiced, and
// the error-reading rule names the recoveries the sandbox returns.
for (const name of ['show_file', 'show_find', 'show_command', 'show_url']) {
  ok(block.includes(name), `block teaches ${name}`);
}
ok(block.includes('END the turn'), 'block says a display call ends the turn');
ok(block.includes('never lets the drill stop'), 'block says the loop never stops on its own');
ok(block.includes('start a fresh pass at step 1'), 'block says a completed drill starts another pass');
ok(block.includes('Continue'), 'block names the Continue message the app sends');
ok(block.includes('Did you mean'), 'block tells the agent to fix the argument an error names');
ok(block.includes('relative to the sandbox'), 'block states the path rule');

// Easy gets the old drill's rules: no anchored-edit contract, and step 7 is
// still the old append instruction. The harness rules (paths, Continue) stay.
store.set('settings.trainingMode', { active: true, startedAt: 2, difficulty: 'easy' });
store.set('trainingVerdicts', {});

// --- complete synthetic passes for the new tables ---------------------------
const advFile = trainingFileFor({ id: 'agent_test' }, 'advanced');
// The text ui/drill/advanced.html serves, marker and all.
const drillPageText = 'Drill page\n\nThis page is served by the app itself, from ui/drill/advanced.html. '
  + 'DRILL-PAGE-v1 \u2014 the redirect half of show_url URL > log.txt is a real file, and this sentence is what proves the file holds the page.';
const advancedCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'fetch_url', arg: { url: TRAINING_PAGE_URL }, status: 'ok', result: 'URL: http://drill.local/advanced.html (HTTP 200, Drill page)\n\n' + drillPageText },
  { tool: 'write_file', arg: { path: advFile, content: drillPageText }, status: 'ok' },
  { tool: 'read_file', arg: { path: advFile }, status: 'ok', result: drillPageText },
  { tool: 'show_url', arg: { url: TRAINING_PAGE_URL }, status: 'ok', result: drillPageText },
  { tool: 'show_file', arg: { path: advFile }, status: 'ok', result: drillPageText },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const advancedVerdict = drillVerdict(advancedCalls, advFile, 'advanced');
ok(advancedVerdict.complete && advancedVerdict.clean,
  'a complete advanced pass grades clean');
eq(advancedVerdict.totalSteps, 8, 'advanced verdict uses the 8-step table');

// The drill now grades a page the app serves itself, so the marker is ours and
// nothing outside this repo can invalidate a pass. A save of some OTHER page —
// correct behaviour for the wrong target — still fails, which is what keeps the
// step about the fetched page rather than about "a write happened".
const otherPageCalls = advancedCalls.map(c => (c.tool === 'write_file'
  ? { ...c, arg: { path: advFile, content: 'This domain is for use in documentation examples without needing permission. This is not a service.' } }
  : c));
ok(!drillVerdict(otherPageCalls, advFile, 'advanced').complete,
  'saving a different page than the drill page still fails the write step');

// A stub save is still refused: this checks the text, not merely "a write ran".
const stubWrite = advancedCalls.map(c => (c.tool === 'write_file'
  ? { ...c, arg: { path: advFile, content: 'saved' } } : c));
const stubVerdict = drillVerdict(stubWrite, advFile, 'advanced');
ok(!stubVerdict.complete && stubVerdict.failures >= 1,
  'a placeholder save still fails the write step');

// The report must name the file the pass wrote, not the file the counter has
// moved on to. In a live run pass 2 genuinely ran and rewrote `…-p1.txt` (it
// rebuilt its todo list from the first pass's, path and all), and the report
// filed it under `…-p2.txt` — the counter's next name — pointing the operator at
// a file no pass had written while the real one was overwritten.
{
  const file2 = advFile.replace(/-p1\.txt$/, '-p2.txt');
  eq(drillPassFile(advancedCalls), advFile, 'a pass that wrote p1 is filed under p1');
  eq(drillPassFile([...advancedCalls, ...advancedCalls]), advFile,
    'a second pass that rewrote p1 is filed under p1, not under the next pass number');
  const second = advancedCalls.map(c => (['write_file', 'read_file', 'show_file'].includes(c.tool)
    ? { ...c, arg: { ...c.arg, path: file2 } }
    : c));
  eq(drillPassFile([...advancedCalls, ...second]), file2, 'a pass that wrote p2 is filed under p2');
  eq(drillPassFile([]), '', 'a drill with no write step reports no file');
  eq(drillPassFile([{ tool: 'show_file', arg: { path: advFile } }]), '',
    'showing a file is not writing it, so it cannot name the pass file');
}

// Each pass must write ITS file. Pass 2 rebuilding its todo list from pass 1's —
// path and all — used to overwrite pass 1's evidence and still count as clean,
// because the write step accepted any pass's file.
{
  const checker = trainingFileCheckFor({ id: 'agent_test' }, 'advanced');
  eq(drillVerdict(advancedCalls, checker, 'advanced').passes, 1, 'one pass grades as one pass');
  const reused = drillVerdict([...advancedCalls, ...advancedCalls], checker, 'advanced');
  ok(!reused.complete && reused.failedAt === 4,
    'a pass that rewrote the previous pass\'s file fails its write step');
  const file2 = advFile.replace(/-p1\.txt$/, '-p2.txt');
  const own = advancedCalls.map(c => (['write_file', 'read_file', 'show_file'].includes(c.tool)
    ? { ...c, arg: { ...c.arg, path: file2 } }
    : c));
  const two = drillVerdict([...advancedCalls, ...own], checker, 'advanced');
  ok(two.complete && two.clean && two.passes === 2,
    'two passes that each wrote their own file still grade clean');
}

// The refusal has to fire BEFORE the write, or the pass it is protecting has
// already been overwritten. Only this run's own drill files are policed.
{
  const agent = { id: 'agent_test' };
  const p1 = trainingFileFor(agent, 'advanced', 1);
  const p2 = trainingFileFor(agent, 'advanced', 2);
  const msg = drillWriteRefusal('write_file', { path: p1 }, agent, 'advanced', 2);
  ok(msg.includes(p2) && msg.includes('another pass'), 'a write back to the previous pass\'s file is refused, and names the right one');
  eq(drillWriteRefusal('write_file', { path: p2 }, agent, 'advanced', 2), '', 'the pass\'s own file is not refused');
  eq(drillWriteRefusal('read_file', { path: p1 }, agent, 'advanced', 2), '',
    'reading an earlier pass\'s file stays allowed — refusing that would hide the evidence');
  eq(drillWriteRefusal('write_file', { path: trainingFileFor({ id: 'agent_other' }, 'advanced', 1) }, agent, 'advanced', 2), '',
    'another agent\'s drill file is not this guard\'s business');
  eq(drillWriteRefusal('write_file', { path: 'src/app.js' }, agent, 'advanced', 2), '',
    'ordinary project files are untouched');
  ok(drillWriteRefusal('edit_file', { path: p1 }, agent, 'advanced', 2),
    'edit_file is guarded too, not just write_file');
  ok(drillWriteRefusal('write_file', p1, agent, 'advanced', 2),
    'a bare path argument is guarded as well');
  ok(drillWriteRefusal('write_file', { path: `/${p1}` }, agent, 'advanced', 2).includes(p2),
    'a leading-slash spelling of the old pass file is guarded too');
  ok(drillWriteRefusal('write_file', { path: `C:/Users/someone/sandbox/${p1}` }, agent, 'advanced', 2).includes(p2),
    'an absolute sandbox path to the old pass file is guarded too');
  eq(drillWriteRefusal('write_file', { path: `/${p2}` }, agent, 'advanced', 2), '',
    'the leading-slash spelling of this pass\'s own file is allowed');
  const ideP1 = trainingFileFor(agent, 'ide', 1);
  const ideP2 = trainingFileFor(agent, 'ide', 2);
  ok(drillWriteRefusal('ide_write', { path: ideP1 }, agent, 'ide', 2).includes(ideP2),
    'an IDE write to the previous pass is refused, and names the right file');
  eq(drillWriteRefusal('ide_write', { path: ideP2 }, agent, 'ide', 2), '',
    'the IDE pass\'s own file is allowed');
  ok(drillWriteRefusal('ide_edit', { path: ideP1 }, agent, 'ide', 2),
    'an IDE edit to the previous pass is refused too');
}

// Grading is not enough: a model that re-runs earlier steps gets ok results and
// the strip stays on the same step forever. The gate refuses the call before it
// runs and names the step the app is actually waiting for.
{
  const prev = store.get('settings.trainingMode');
  store.set('settings.trainingMode', { active: true, startedAt: 7, difficulty: 'advanced' });
  const agent = { id: 'agent_gate' };
  const at6 = { step: 6, totalSteps: 8, complete: false, nextTool: 'show_file' };
  eq(drillStepRefusal('show_file', agent, at6), '', 'the expected step is allowed');
  const redo = drillStepRefusal('fetch_url', agent, at6);
  ok(redo.includes('step 7/8'), 'a redo is refused with the current position');
  ok(redo.includes('show_file'), 'and names the call the drill waits for');
  ok(redo.includes('Do not redo'), 'and says the drill runs in order');
  eq(drillStepRefusal('todo_write', agent, at6), '', 'a todo status update is allowed');
  eq(drillStepRefusal('read_file', agent, at6), '', 'read-only inspection is a scratchpad at any step');
  eq(drillStepRefusal('think', agent, at6), '',
    'a think scratchpad is allowed even when another step is awaited');
  const at0 = { step: 0, totalSteps: 8, complete: false, nextTool: 'think' };
  eq(drillStepRefusal('think', agent, at0), '', 'step 1 is the think call the drill waits for');
  const firstSkip = drillStepRefusal('todo_write', agent, at0);
  ok(firstSkip.includes('step 1/8') && firstSkip.includes('think'),
    'a todo update cannot skip step 1');
  ok(firstSkip.includes('only after a step has passed'),
    'and it says when a todo update is allowed');
  ok(drillStepRefusal('exec', agent, at6).includes('not part of this drill'),
    'a tool outside the drill is refused');
  const done = { step: 8, totalSteps: 8, complete: true, nextTool: '' };
  eq(drillStepRefusal('think', agent, done), '', 'the first step of the next pass is allowed');
  ok(drillStepRefusal('show_file', agent, done).includes('start the next one at step 1'),
    'a mid-drill call after completion is refused');
  ok(drillStepRefusal('todo_write', agent, done).includes('start the next one at step 1'),
    'after a pass, a todo update cannot replace step 1');
  store.set('settings.trainingMode', prev || { active: false, startedAt: 0 });
}

// The tool that caused the stall must not answer "cleared" to a usable list.
{
  const todo = TOOL_REGISTRY.todo_write;
  const ctx = { agentId: 'agent_todo_test' };
  const rendered = todo.run(['step one', 'step two'], '', ctx);
  ok(rendered.includes('step one') && rendered.includes('step two'),
    'todo_write accepts a plain array of strings');
  ok(todo.run({ todos: '[{"content":"encoded","status":"in_progress"}]' }, '', ctx).includes('encoded'),
    'todo_write accepts a JSON-encoded array, as small models send it');
  ok(todo.run('["step one","step two"]', '', ctx).includes('step one'),
    'todo_write accepts a bare JSON array string');
  ok(todo.run({ items: [{ content: 'a', status: 'in_progress' }] }, '', ctx).includes('a'),
    'todo_write accepts items[] as the list');
  const recovered = todo.run('{"todos":[{"content": "step ", "status": "completed"},content":step 2", "status": "_progress"}}', '', ctx);
  ok(recovered.includes('step 2') && recovered.includes('[~]'),
    'todo_write recovers a malformed JSON string instead of stalling step 2');
  const missingCommas = todo.run({
    todos: '["1. think", "2. todo_write", "3. echo", "4. now "5. write_file", "6. read_file", "7. edit_file", "8. list_dir "9. glob_files", "10. grep_code", "1. exec", "12. todo_write"]',
  }, '', ctx);
  ok(missingCommas.includes('1. think') && missingCommas.includes('12. todo_write')
    && missingCommas.split('\n').length === 12,
  'todo_write recovers a quoted todo list whose commas were lost');
  // An empty todo list must not satisfy the step: the old success answer
  // "todo list cleared" was the false positive that made the drill look passed.
  const easy = trainingChecksFor('easy');
  ok(!easy[1]({ tool: 'todo_write', arg: { todos: [] }, result: 'todo list cleared' }),
    'an empty todo does not pass easy step 2');
  ok(easy[1]({ tool: 'todo_write', arg: ['step 1'], result: '[ ] 1. step 1' }),
    'a real todo list passes easy step 2');
  ok(!easy[11]({ tool: 'todo_write', arg: { todos: [] }, result: 'todo list cleared' }),
    'an empty todo does not complete easy step 12');
  eq(todo.run({ todos: [] }, '', ctx), 'todo list cleared',
    'an explicit empty list still clears');
  let refused = false;
  try {
    todo.run({ steps: [{ step: 1, status: 'completed' }] }, '', ctx);
  } catch { refused = true; }
  ok(refused, 'a list with no usable content is refused, never reported as cleared');
}

const frontierCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'window_list', arg: {}, status: 'ok', result: 'Desktop programs: notepad - C:/Windows/System32/notepad.exe | running' },
  { tool: 'window_open', arg: { name: 'notepad' }, status: 'ok' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'ok', result: 'typed 6 character(s) into "notepad" (pid 9040) — Typed 6 character(s) into the newest window. Read back from the window: the typed text is there.' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const frontierVerdict = drillVerdict(frontierCalls, TRAINING_FILE, 'frontier');
ok(frontierVerdict.complete && frontierVerdict.clean,
  'a complete frontier pass grades clean');
eq(frontierVerdict.totalSteps, 6, 'frontier verdict uses the 6-step table');

// Arguments alone are not enough: the typing result must say the window was
// read back and contained the text.
const unverifiedFrontierCalls = frontierCalls.map(call => call.tool === 'window_type'
  ? { ...call, result: 'typed 6 character(s) into "notepad" — The window text could not be read back, so this typing is unverified.' }
  : call);
const unverifiedFrontierVerdict = drillVerdict(unverifiedFrontierCalls, TRAINING_FILE, 'frontier');
ok(!unverifiedFrontierVerdict.complete && !unverifiedFrontierVerdict.clean,
  'frontier rejects a typed call that was not verified on screen');
eq(unverifiedFrontierVerdict.failures, 1, 'the unverified typing counts as a failed step');
eq(unverifiedFrontierVerdict.step, 4, 'the unverified typing does not advance the drill');
ok(unverifiedFrontierVerdict.retryHint.includes('Retry window_type'),
  'an unverified frontier typing gets a retry hint');
ok(drillVerdictText(unverifiedFrontierVerdict).includes('Retry window_type'),
  'the retry hint is shown in the strip text');

const browserCalls = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'browser_open', arg: { url: 'http://127.0.0.1:8080/router/ui/drill/browser.html', headless: false }, status: 'ok', result: 'Opened http://127.0.0.1:8080/router/ui/drill/browser.html — Browser drill (visible window)' },
  { tool: 'browser_read', arg: {}, status: 'ok', result: 'Browser drill\nYour name\nSay hello\nWaiting for a name.' },
  { tool: 'browser_type', arg: { selector: '#drill-name', text: 'training' }, status: 'ok', result: 'Typed 8 character(s)' },
  { tool: 'browser_click', arg: { selector: '#drill-submit' }, status: 'ok', result: 'Clicked #drill-submit' },
  { tool: 'browser_wait', arg: { ms: 300 }, status: 'ok', result: 'Waited 300ms' },
  { tool: 'browser_read', arg: {}, status: 'ok', result: 'Browser drill\nYour name\ntraining\nSay hello\nHello, training.' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const browserVerdict = drillVerdict(browserCalls, TRAINING_FILE, 'browser');
ok(browserVerdict.complete && browserVerdict.clean,
  'a complete browser pass grades clean');
eq(browserVerdict.totalSteps, 9, 'browser verdict uses the 9-step table');

// The exact failure the operator hit with Nemo: every call returned ok, but
// the browser was headless, so nothing was ever visible. Step 3 must not
// advance, and the strip must tell the model how to retry.
const headlessBrowserCalls = browserCalls.map(call => call.tool === 'browser_open'
  ? { ...call, arg: { url: 'http://127.0.0.1:8080/router/ui/drill/browser.html', headless: true }, result: 'Opened http://127.0.0.1:8080/router/ui/drill/browser.html — Browser drill (headless — no window to watch)' }
  : call);
const headlessVerdict = drillVerdict(headlessBrowserCalls, TRAINING_FILE, 'browser');
ok(!headlessVerdict.complete && !headlessVerdict.clean,
  'browser rejects a headless drill even when every call returned ok');
eq(headlessVerdict.failures, 1, 'the headless open counts as a failed step');
eq(headlessVerdict.step, 2, 'the headless open does not advance the drill');
ok(headlessVerdict.retryHint.includes('Retry browser_open'),
  'a headless browser open gets a retry hint');

// The completion summary needs the whole run, not just the live pass: a
// corrected step 5 in pass one, then a clean pass two.
const failedFrontierPass = [
  { tool: 'think', arg: 'plan', status: 'ok' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
  { tool: 'window_list', arg: {}, status: 'ok', result: 'notepad | running' },
  { tool: 'window_open', arg: { name: 'notepad' }, status: 'ok' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'error', result: 'nothing to type into' },
  { tool: 'window_type', arg: { name: 'notepad', text: 'Hello!' }, status: 'ok', result: 'typed 6 character(s) into "notepad" (pid 9040) — Typed 6 character(s) into the newest window. Read back from the window: the typed text is there.' },
  { tool: 'todo_write', arg: { todos: [] }, status: 'ok' },
];
const runVerdict = drillVerdict(failedFrontierPass.concat(frontierCalls), TRAINING_FILE, 'frontier');
eq(runVerdict.passes, 2, 'the run counts both completed passes');
eq(runVerdict.cleanPasses, 1, 'the run counts its clean pass');
eq(runVerdict.failuresTotal, 1, 'the run counts failures across passes');
eq(runVerdict.failureCounts['5'], 1, 'the run remembers which step failed');
const easyBlock = trainingBlockFor({ id: 'agent_test' });
ok(easyBlock.includes('Append a second line'), 'easy block keeps the old append step');
ok(easyBlock.includes('12-step pass'), 'easy block names the 12-step pass');
ok(easyBlock.includes('Read-only inspection') && easyBlock.includes('Read the file first'),
  'easy block allows the read that finds the exact anchor before the append');
ok(easyBlock.includes('never an append'), 'easy block teaches the anchored edit');
ok(easyBlock.includes('"old_string":"training"'), 'easy block carries the anchored step-7 card in its step list');
ok(!easyBlock.includes('17. show_file:'), 'easy block never lists the 17-step ending');
ok(easyBlock.includes(drillFile), 'easy block still names this agent\'s own file');
ok(easyBlock.includes('never lets the drill stop'), 'easy block keeps the Continue loop');
const easyKickoff = trainingKickoffFor();
ok(easyKickoff.includes('12. todo_write:'), 'easy kickoff lists all 12 steps');
ok(!easyKickoff.includes('show_file'), 'easy kickoff does not name the hard ending');
ok(easyKickoff.includes('12-step pass'), 'easy kickoff names the pass length');

// Advanced gets the fetch/save/show lesson, including the redirect warning.
store.set('settings.trainingMode', { active: true, startedAt: 3, difficulty: 'advanced' });
store.set('trainingVerdicts', {});
const advancedBlock = trainingBlockFor({ id: 'agent_test' });
ok(advancedBlock.includes('fetch_url gets a page'), 'advanced block names fetch_url');
ok(advancedBlock.includes('show_url only DISPLAYS'), 'advanced block explains the display/tool split');
ok(advancedBlock.includes('holds the page text'),
  'the block asks for the saved page text, not a phrase the page may stop serving');
ok(advancedBlock.includes(trainingFileFor({ id: 'agent_test' }, 'advanced')),
  'advanced block names the agent log file');
ok(advancedBlock.includes('final todo_write'), 'advanced block names its completion step');
ok(advancedBlock.includes('EVERY step is a real tool call'),
  'advanced block says every step is a tool call, including think');
ok(advancedBlock.includes('{"tool":"think"'),
  'and shows the exact think call, not just the word');
// The pass file leads, and follows the pass counter. A model that rebuilt its
// todo list from the previous pass copied that pass's path with it and wrote
// the old file; the path used to sit in a rule midway down the block.
{
  const head = advancedBlock.split('\n').slice(0, 3).join('\n');
  ok(head.includes(`YOUR FILE FOR THIS PASS: ${trainingFileFor({ id: 'agent_test' }, 'advanced')}`),
    'the block leads with this pass\'s file, before the steps');
  store.set('settings.trainingMode', { active: true, startedAt: 3, difficulty: 'advanced', pass: 2 });
  const p2Block = trainingBlockFor({ id: 'agent_test' });
  ok(p2Block.split('\n').slice(0, 3).join('\n')
    .includes(`YOUR FILE FOR THIS PASS: ${trainingFileFor({ id: 'agent_test' }, 'advanced', 2)}`),
    'the leading file follows the pass counter for the second pass');
  ok(!p2Block.split('\n').slice(0, 3).join('\n').includes(trainingFileFor({ id: 'agent_test' }, 'advanced', 1)),
    'the previous pass\'s file is not offered up front');
  store.set('settings.trainingMode', { active: true, startedAt: 3, difficulty: 'frontier' });
  ok(!trainingBlockFor({ id: 'agent_test' }).includes('YOUR FILE FOR THIS PASS'),
    'a desktop drill is not handed a sandbox file');
  store.set('settings.trainingMode', { active: true, startedAt: 3, difficulty: 'advanced' });
}
const advancedKickoff = trainingKickoffFor();
ok(advancedKickoff.includes('8. todo_write:'), 'advanced kickoff lists all 8 steps');
ok(advancedKickoff.includes('Advanced pass'), 'advanced kickoff names the pass length');

// Frontier gets the real-desktop Notepad demo, not a file path.
store.set('settings.trainingMode', { active: true, startedAt: 4, difficulty: 'frontier' });
const frontierBlock = trainingBlockFor({ id: 'agent_test' });
ok(frontierBlock.includes('window_list first'), 'frontier block starts with window_list');
ok(frontierBlock.includes('window_open'), 'frontier block names window_open');
ok(frontierBlock.includes('window_type'), 'frontier block names window_type');
ok(frontierBlock.includes('Notepad'), 'frontier block names Notepad');
ok(frontierBlock.includes('Hello!'), 'frontier block carries the exact typed text');
ok(!frontierBlock.includes('relative to the sandbox'), 'frontier block stays off the sandbox path');
const frontierKickoff = trainingKickoffFor();
ok(frontierKickoff.includes('real desktop'), 'frontier kickoff names the real desktop');
ok(frontierKickoff.includes('6. todo_write:'), 'frontier kickoff lists all 6 steps');
ok(frontierKickoff.includes('Frontier pass'), 'frontier kickoff names the pass length');

// Browser gets the local page, its selectors and its visible finish line.
store.set('settings.trainingMode', { active: true, startedAt: 5, difficulty: 'browser' });
const browserBlock = trainingBlockFor({ id: 'agent_test' });
ok(browserBlock.includes('built-in browser'), 'browser block names the built-in browser');
ok(browserBlock.includes('browser.html'), 'browser block carries the local page URL');
ok(browserBlock.includes('#drill-name'), 'browser block names the input selector');
ok(browserBlock.includes('#drill-submit'), 'browser block names the button selector');
ok(browserBlock.includes('Hello, training'), 'browser block names the visible finish line');
ok(!browserBlock.includes('relative to the sandbox'), 'browser block stays off the sandbox path');
const browserKickoff = trainingKickoffFor();
ok(browserKickoff.includes('built-in browser'), 'browser kickoff names the built-in browser');
ok(browserKickoff.includes('browser.html'), 'browser kickoff carries the local page URL');
ok(browserKickoff.includes('9. todo_write:'), 'browser kickoff lists all 9 steps');
ok(browserKickoff.includes('Browser pass'), 'browser kickoff names the pass length');

// Custom drills: the operator's saved steps are the table, and the optional
// expected phrase is the only content check available to a free-form step.
const customSteps = normalizeCustomSteps([
  { tool: ' READ_FILE ', instruction: 'Read {file} and find hello', expect: ' HELLO ' },
  { tool: 'write_file', instruction: 'Save the result', expect: '' },
  { tool: '', instruction: 'not a step', expect: '' },
]);
eq(customSteps.length, 2, 'custom step normalisation drops incomplete rows');
eq(customSteps[0].tool, 'read_file', 'custom tool names are trimmed and lowercased');
eq(customSteps[0].expect, 'HELLO', 'expected phrases are trimmed but keep their case');
ok(CUSTOM_STEP_MAX >= 10, 'custom drills support a useful number of steps');
eq(normalizeCustomSteps(Array.from({ length: CUSTOM_STEP_MAX + 5 }, () => ({ tool: 'think', instruction: 'x' }))).length,
  CUSTOM_STEP_MAX, 'custom step normalisation enforces the cap');
eq(trainingTasksFor('custom', customSteps).length, 2, 'custom selects the saved table');
eq(trainingChecksFor('custom', customSteps).length, 2, 'custom checks align with its steps');
eq(trainingStepList(null, 'custom', customSteps)[0],
  '1. read_file — Read training/training-<agent>-p1.txt and find hello (must include “HELLO”)',
  'custom step list fills {file} and names the expected phrase');
const customFile = trainingFileFor({ id: 'agent_test' }, 'custom');
const customCalls = [
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'HELLO world' },
  { tool: 'write_file', arg: { path: customFile, content: 'HELLO' }, status: 'ok' },
];
const customVerdict = drillVerdict(customCalls, customFile, 'custom', customSteps);
ok(customVerdict.complete && customVerdict.clean, 'a complete custom pass with its expected phrase grades clean');
eq(customVerdict.totalSteps, 2, 'custom verdict uses the saved step count');
const customMiss = drillVerdict([
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'nothing useful' },
  { tool: 'read_file', arg: { path: customFile }, status: 'ok', result: 'HELLO world' },
  { tool: 'write_file', arg: { path: customFile, content: 'HELLO' }, status: 'ok' },
], customFile, 'custom', customSteps);
ok(customMiss.complete && !customMiss.clean, 'a missing expected phrase is a failed attempt even after a corrected retry');
eq(customMiss.failureCounts['1'], 1, 'the custom failure is attributed to its step');
eq(trainingTasksFor('custom', []).length, 0, 'an empty custom drill has no tasks');
const emptyCustom = drillVerdict([], customFile, 'custom', []);
eq(emptyCustom.totalSteps, 0, 'an empty custom drill has no pass to grade');
eq(emptyCustom.complete, false, 'an empty custom drill never completes');
store.set('settings.trainingMode', { active: true, startedAt: 5, difficulty: 'custom', customSteps });
const customBlock = trainingBlockFor({ id: 'agent_test' });
ok(customBlock.includes('read_file'), 'custom block lists the saved tool');
ok(customBlock.includes('Read training/training-t-test-p1.txt and find hello'),
  'custom block fills {file} in the saved instruction');
ok(customBlock.includes('must include “HELLO”'), 'custom block states the expected phrase');
ok(customBlock.includes('expected phrase'), 'custom block explains the optional content check');
const customKickoff = trainingKickoffFor();
ok(customKickoff.includes('2. write_file:'), 'custom kickoff lists the saved steps');
ok(customKickoff.includes('2-step Custom pass'), 'custom kickoff names the saved pass length');
ok(customKickoff.includes('Brain Lab'), 'custom kickoff allows custom tools');
store.set('settings.trainingMode', { active: true, startedAt: 1, difficulty: 'hard' });

// The recorded position is per agent, in that agent's own block. One shared
// "Continue" used to list every agent's position, and a live run had a second
// model read another agent's "pass complete" and start at step 17.
store.set('trainingVerdicts', {
  agent_test: { step: 15, totalSteps: 17, complete: false, name: 'Scout' },
  agent_other: { step: 3, totalSteps: 17, complete: false, name: 'Coder' },
});
const positioned = trainingBlockFor({ id: 'agent_test' });
ok(positioned.includes('15/17') && positioned.includes('step 16') && positioned.includes('todo_write'),
  'the block names this agent\'s recorded next step');
ok(positioned.includes('mid-pass think is a scratchpad'),
  'the block says a mid-pass think is a scratchpad, not a restart');
ok(!positioned.includes('starts a new attempt'),
  'the block no longer tells the model a think restarts the pass');
ok(!positioned.includes('3/17'), 'the block never carries another agent\'s position');
store.set('trainingVerdicts', { agent_test: { step: 17, totalSteps: 17, complete: true } });
ok(trainingBlockFor({ id: 'agent_test' }).includes('fresh pass'),
  'a completed pass resumes into a fresh one');
store.set('trainingVerdicts', {});

// The continued turn is generic: every agent reads its own position above.
eq(trainingResumeFor(),
  'Continue. Your TRAINING MODE block records your own position from the calls the app saw — resume there. A think call or a read-only inspection (read_file, list_dir, glob_files, grep_code, ide_read, browser_read, window_list) is a scratchpad: it does not restart the pass or reset its steps. Only a completed pass starts the next one.',
  'the shared Continue points at the per-agent block instead of listing positions');

// --- the clean-pass stopping rule -------------------------------------------
eq(reachedCleanTarget({ cleanPassTarget: 0 }, { a: { cleanPasses: 5 } }), null,
  '0 never stops on its own');
const targetHit = reachedCleanTarget({ cleanPassTarget: 2 },
  { a: { name: 'Scout', cleanPasses: 1 }, b: { name: 'Coder', cleanPasses: 2 } });
ok(!!targetHit && targetHit.name === 'Coder', 'the first agent at the target ends the run');
eq(reachedCleanTarget({ cleanPassTarget: 2 }, { a: { cleanPasses: 1 } }), null,
  'below the target keeps running');

// The strip says the rule only when there is one.
eq(drillStripTitle({}), 'drill', 'no target keeps the one-word header');
eq(drillStripTitle({ difficulty: 'easy' }), 'easy drill', 'easy mode is named in the strip');
eq(drillStripTitle({ difficulty: 'advanced' }), 'advanced drill', 'advanced mode is named in the strip');
eq(drillStripTitle({ difficulty: 'frontier' }), 'frontier drill', 'frontier mode is named in the strip');
eq(drillStripTitle({ cleanPassTarget: 0 }), 'drill', 'target 0 keeps the one-word header');
eq(drillStripTitle({ cleanPassTarget: 1 }), 'drill \u00b7 stop at 1 clean pass', 'one pass is singular');
eq(drillStripTitle({ cleanPassTarget: 3 }), 'drill \u00b7 stop at 3 clean passes', 'the header names the target');

// --- the resume decision (chat.js asks this after EVERY finished turn) -------
eq(shouldResumeDrill({ active: true }), true, 'an armed mode continues every turn');
eq(shouldResumeDrill({ active: false }), false, 'a disarmed mode never continues');
eq(shouldResumeDrill({}), false, 'no mode, no resume');
eq(shouldResumeDrill({ active: true, drillResumes: 999 }), true,
  'a resume count never ends the loop');
eq(shouldResumeDrill({ active: true, drillResumes: 9999, drillFails: 9 }), true,
  'failures never end the loop either - they only slow it down');
eq(showsEveryPass({ active: true }), false, 'pass reports are off by default');
eq(showsEveryPass({ active: true, showEveryPass: false }), false, 'the unchecked setting stays off');
eq(showsEveryPass({ active: true, showEveryPass: true }), true, 'Show every pass enables per-pass reports');
eq(showsEveryPass({ active: false, showEveryPass: true }), false, 'a stopped run never opens a pass report');

// The Start dispatch: self-contained, so a fresh turn AND a steered in-flight
// turn both get the drill even though only the fresh turn carries the block.
const kickoff = trainingKickoffFor();
ok(typeof kickoff === 'string' && kickoff.length > 200, 'kickoff is a full instruction');
ok(kickoff.includes('Training mode is ON'), 'kickoff announces the mode');
ok(kickoff.includes(TRAINING_DIR), 'kickoff names the drill folder');
ok(!kickoff.includes('<agent>'), 'kickoff never asks a model to resolve the agent placeholder');
ok(kickoff.includes('your drill file'), 'kickoff points at the agent\'s own file, named exactly in the prompt block');
ok(kickoff.includes('retried until it passes'), 'kickoff carries the retry rule');
ok(kickoff.includes('approval'), 'kickoff warns about approval pauses');
for (const t of TRAINING_TASKS) ok(kickoff.includes(t.tool), `kickoff lists ${t.tool}`);

// Armed: the governor halves the ceiling on the no-agent path.
const ENDPOINT = 'https://unknown.example/v1/chat/completions';
store.set('settings.trainingMode', { active: false, startedAt: 0 });
const plain = limitsFor(ENDPOINT, 'k-off');
const off = limitsFor(ENDPOINT, 'k-half-check');
store.set('settings.trainingMode', { active: true, startedAt: 1 });
const on = limitsFor(ENDPOINT, 'k-half-check');
eq(on.rpm, Math.max(1, Math.floor(off.rpm * TRAINING_THROTTLE)), 'armed ceiling is ~50% of disarmed');
ok(off.rpm > 0 && plain.rpm === off.rpm, 'disarmed ceiling is untouched');
store.set('settings.trainingMode', { active: false, startedAt: 0 });

// --- The IDE drill: the shared write path, exercised by the agent ----------
// The point of this mode is the DOOR, not the content. A model that answered it
// with write_file would put the same bytes on the same disk and sail past a
// content-only check while never touching the editor, so the table is pinned
// step by step and every check is asked directly.
const ideAgent = { id: 'agent_test' };
const ideFile = trainingFileFor(ideAgent, 'ide', 1);
const ideCall = (tool, arg, result) => ({ tool, arg, result });
eq(DRILL_CHECKS_IDE.length, TRAINING_TASKS_IDE.length, 'IDE tasks and checks stay index-aligned');
eq(trainingDifficulty({ difficulty: 'ide' }), 'ide', 'ide is a mode the settings can select');
eq(trainingDifficultyLabel('ide'), 'IDE', 'the IDE drill has its own label');
eq(trainingTasksFor('ide'), TRAINING_TASKS_IDE, 'tasksFor returns the IDE steps');
eq(trainingChecksFor('ide'), DRILL_CHECKS_IDE, 'checksFor returns the IDE checks');
ok(trainingTasksFor('ide').length === 8, 'the IDE drill is eight steps');
ok(ideFile.startsWith(`${TRAINING_DIR}/ide-`), 'the IDE drill keeps its own file family, so no drill grades another\'s file');
eq(drillPassFile([{ tool: 'ide_write', arg: { path: ideFile } }]), ideFile, 'an IDE pass is filed under the file ide_write actually wrote');
eq(drillPassFile([{ tool: 'write_file', arg: { path: ideFile } }]), ideFile, 'the sandbox write still counts as the pass file');
eq(drillPassFile([{ tool: 'ide_read', arg: { path: ideFile } }]), '', 'a read never claims to be the file a pass wrote');
ok(DRILL_CHECKS_IDE[2](ideCall('ide_write', { path: ideFile, content: 'ide drill' }, 'Wrote it'), ideFile), 'step 3 passes on the marker content');
ok(!DRILL_CHECKS_IDE[2](ideCall('ide_write', { path: ideFile, content: 'something else' }, 'Wrote it'), ideFile), 'step 3 fails on any other content');
ok(DRILL_CHECKS_IDE[3](ideCall('ide_open', { path: ideFile }, 'Opened it in the IDE'), ideFile), 'step 4 passes when ide_open names the file');
ok(DRILL_CHECKS_IDE[4](ideCall('ide_read', { path: ideFile }, '1| ide drill'), ideFile), 'step 5 passes on a read that shows the marker');
ok(DRILL_CHECKS_IDE[5](ideCall('ide_edit', { path: ideFile, old_string: 'ide drill', new_string: 'ide drill (edited)' }, 'Edited'), ideFile), 'step 6 passes on an anchored edit');
ok(!DRILL_CHECKS_IDE[5](ideCall('ide_edit', { path: ideFile, old_string: '', new_string: 'ide drill (edited)' }, 'error: ide_edit needs "old_string"'), ideFile), 'step 6 refuses an empty anchor, which is the append the drill exists to catch');
ok(DRILL_CHECKS_IDE[6](ideCall('ide_read', { path: ideFile }, '1| ide drill (edited)'), ideFile), 'step 7 passes when the read shows the edit');
ok(!DRILL_CHECKS_IDE[6](ideCall('ide_read', { path: ideFile }, '1| ide drill'), ideFile), 'step 7 fails when the read still shows the pre-edit text');
store.set('settings.trainingMode', { active: true, difficulty: 'ide', pass: 1 });
const ideBlock = trainingBlockFor(ideAgent);
ok(ideBlock.includes('ide_write') && ideBlock.includes('ide_edit'), 'the IDE block lists the IDE tools by name');
ok(ideBlock.includes(ideFile), 'the IDE block names this pass\'s file');
ok(/Do not substitute write_file/.test(ideBlock), 'the IDE block rules out the sandbox tools by name');
store.set('settings.trainingMode', { active: false, startedAt: 0 });

// --- accuracy: the exact next call, the drill tool scope, the loop breaker --
// The block used to name only `todo_write`, so a small model had to infer the
// call envelope and three agents lost valid todo lists inside a wrong wrapper.
// The example is rendered from the same task table the grader uses.
store.set('settings.trainingMode', { active: true, startedAt: 9, difficulty: 'hard' });
store.set('trainingVerdicts', { agent_test: { step: 1, totalSteps: 17, complete: false } });
const exactBlock = trainingBlockFor({ id: 'agent_test' });
ok(exactBlock.includes('Exact call: {'), 'the position line carries a copyable next call');
ok(exactBlock.includes('"tool":"todo_write"') && exactBlock.includes('"arg":["step 1","step 2"]'),
  'the example wraps a plain todo list in the tool envelope');
ok(!exactBlock.includes('{file}') && exactBlock.includes('training/training-t-test-p1.txt'),
  'the example resolves this agent\'s pass file, with no unfilled token');
store.set('trainingVerdicts', {});
store.set('settings.trainingMode', { active: true, startedAt: 9, difficulty: 'advanced' });
eq(drillStepRefusal('show_file', { id: 'agent_test' }, { step: 1 }).includes('Next call: {"tool":"todo_write"'), true,
  'an off-step refusal repeats the exact expected call');

// A stored plan from a previous pass must not be replayed as this pass's plan.
// It is all [x], so replaying it before step 2 tells the model the new pass is
// already done. Only step 2's todo_write makes a plan current.
ok(todoPlanIsCurrent('agent_test', { active: false }, {}), true,
  'outside a drill the stored plan is always shown');
ok(!todoPlanIsCurrent('agent_test', { active: true }, {}), false,
  'a drill with no recorded position hides the old plan');
ok(!todoPlanIsCurrent('agent_test', { active: true }, { agent_test: { step: 1 } }), false,
  'before step 2 the old plan is hidden');
ok(todoPlanIsCurrent('agent_test', { active: true }, { agent_test: { step: 2 } }), true,
  'after step 2 the plan written by this pass is shown');
ok(!todoPlanIsCurrent('agent_test', { active: true }, { agent_test: { step: 12, complete: true } }), false,
  'a completed pass hides its plan until the next pass writes a new one');

// The scope is the drill's own tools, nothing else.
const advScope = trainingToolScope('advanced');
ok(advScope.includes('fetch_url') && advScope.includes('show_file'), 'advanced scope carries the fetched-page tools');
ok(!advScope.includes('exec') && !advScope.includes('browser_open'), 'advanced scope leaves unrelated tools out');
const hardScope = trainingToolScope('hard');
ok(hardScope.includes('exec') && hardScope.includes('edit_file'), 'hard scope carries the shell and edit tools');
ok(!hardScope.includes('fetch_url'), 'hard scope does not advertise the advanced drill\'s tools');
ok(trainingToolScope('custom', [{ tool: 'read_file', instruction: 'x' }]).join(',') === 'read_file',
  'custom scope is exactly the saved custom tools');

// Examples are single-sourced from the task table and filled per agent.
const advTask = TRAINING_TASKS_ADVANCED[3];
const advExample = trainingTaskExample(advTask, { id: 'agent_task' }, 'advanced');
ok(advExample.includes('"tool":"write_file"') && advExample.includes(trainingFileFor({ id: 'agent_task' }, 'advanced')),
  'the advanced write example names the agent\'s own page file');
eq(trainingTaskExample(TRAINING_TASKS_ADVANCED[0], { id: 'agent_task' }, 'advanced').includes('think'), true,
  'the first advanced example is a think call');

// A repeated call is identified by tool + argument, independent of key order.
eq(callSignature('todo_write', { b: 2, a: [1, { d: 4, c: 3 }] }),
  callSignature('todo_write', { a: [1, { c: 3, d: 4 }], b: 2 }), 'argument key order does not split a repeat');
ok(callSignature('todo_write', { a: 1 }) !== callSignature('todo_write', { a: 2 }),
  'a different argument is a different attempt');

eq(drillRepeatNotice(DRILL_REPEAT_HINT - 1, TRAINING_TASKS[1], 2, 17, { id: 'a' }, 'hard'), '',
  'below the hint threshold the generic retry text stands');
const repeatHint = drillRepeatNotice(DRILL_REPEAT_HINT, TRAINING_TASKS[1], 2, 17, { id: 'a' }, 'hard');
ok(repeatHint.includes('Expected: {"tool":"todo_write"') && repeatHint.includes('change the argument'),
  'the hint names the exact call and says the argument must change');
const repeatStrong = drillRepeatNotice(DRILL_REPEAT_LIMIT, TRAINING_TASKS[1], 2, 17, { id: 'a' }, 'hard');
ok(repeatStrong.includes('does not skip a step') && !repeatStrong.includes('Paused after'),
  'the drill keeps retrying instead of pausing at the limit');
const failureNotice = drillFailureNotice(TRAINING_TASKS[1], 2, 17, { id: 'a' }, 'hard');
ok(failureNotice.includes('did not pass step 2/17') && failureNotice.includes('Next call must be exactly:'),
  'a failed drill check names the step and the exact call');

// First-try rate is per step, not per attempt: any failure on a step makes it
// not first-try, and the worst step is the one with the most failures.
const acc = trainingAccuracy([
  { totalSteps: 8, failureCounts: { 2: 2 } },
  { totalSteps: 8, failureCounts: {} },
]);
eq(acc.steps, 16, 'accuracy counts every step of every logged pass');
eq(acc.firstTry, 94, 'one failed step out of sixteen is 94% first try');
eq(acc.worstStep, 2, 'accuracy names the most-failed step');
eq(acc.worstCount, 2, 'accuracy reports how often that step failed');
eq(acc.passes, 2, 'accuracy counts the passes it read');
eq(trainingAccuracy([]).steps, 0, 'no completed pass has no accuracy yet');

// The judged pass carries its own failure tally for the pass log; the run-wide
// tally stays available for the summary.
const dirtyCalls = [
  advancedCalls[0],
  { tool: 'todo_write', arg: {}, status: 'error', result: 'error: todo_write needs todos' },
  ...advancedCalls.slice(1),
];
const dirtyVerdict = drillVerdict(dirtyCalls, advFile, 'advanced');
ok(dirtyVerdict.complete && !dirtyVerdict.clean, 'a pass that needed a retry still completes');
eq(dirtyVerdict.failureCounts['2'], 1, 'the run tally attributes the failure to step 2');
eq(dirtyVerdict.passFailureCounts['2'], 1, 'the judged pass carries its own step-2 failure');
eq(advancedVerdict.passFailureCounts && Object.keys(advancedVerdict.passFailureCounts).length, 0,
  'a clean pass has an empty per-pass tally');

// The live position is read from the verdict, so the forced native choice and
// the block agree on the step.
store.set('settings.trainingMode', { active: true, startedAt: 9, difficulty: 'advanced' });
store.set('trainingVerdicts', { agent_now: { step: 2, totalSteps: 8, complete: false } });
const now = trainingNow({ id: 'agent_now' });
eq(now.task.tool, 'fetch_url', 'the live position names the awaited tool');
eq(now.step, 2, 'the live position carries the zero-based step');
eq(now.total, 8, 'the live position carries the pass length');
ok(now.task.example.includes('fetch_url'), 'the live position carries the call example');
store.set('trainingVerdicts', {});
store.set('settings.trainingMode', { active: false, startedAt: 0 });

console.log('-'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
for (const e of errors) console.log('  ' + e);
process.exit(fail ? 1 : 0);
