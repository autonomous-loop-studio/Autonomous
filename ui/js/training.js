/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// TRAINING.JS — Training mode: a paced tool drill
// ============================================
//
// While armed (Agents-tab header, dumbbell button), every active agent is:
//   * throttled to ~50% of its normal request rate (see rateGovernor.js) —
//     unless the dialog's pacing switch is off or the model runs locally, and
//   * locked by system prompt to one simple drill, worked in order, with a
//     retry-until-it-works rule so a miss becomes practice instead of a skip.
//
// Nothing here teaches weights — models do not keep those between calls. What
// "remember what worked" means is: the agent tracks each passed step with
// todo_write, and the drill that last worked stays in the run transcript and
// the todo list. The operator ends the drill with Stop on the same button; a
// 100% clean pass ends the run on its own (see trainingCleanTarget).

import { store } from './store.js?v=502';

/** Fraction of the normal request rate agents get while training. */
export const TRAINING_THROTTLE = 0.5;

/** Folder the whole drill lives in. The sandbox jail still applies: this is
 *  resolved under the agent's writable root, never outside it. */
export const TRAINING_DIR = 'training';
export const TRAINING_FILE = 'training/training.txt';
/**
 * Read-only calls that inspect the workspace. They are scratchpads, not steps:
 * a model may need the exact bytes before an anchored edit, and refusing the
 * read left Easy step 7 guessing `training\n` against a file containing
 * `training`. Allowing one can never skip a step because the verdict still
 * advances only when the call is the awaited step.
 */
export const DRILL_INSPECT_TOOLS = ['read_file', 'list_dir', 'glob_files', 'grep_code', 'ide_read', 'browser_read', 'window_list'];
const isInspect = (tool) => DRILL_INSPECT_TOOLS.includes(String(tool || '').toLowerCase());
/** Placeholder in the step labels, filled with the caller's own drill file. */
export const TRAINING_FILE_TOKEN = '{file}';
/** Local page the Browser drill drives; resolved against this module so it
 *  works at the root and under the Apache /router mount alike. */
export const TRAINING_BROWSER_PATH = 'ui/drill/browser.html';
export const TRAINING_BROWSER_TOKEN = '{browser}';
export const TRAINING_CAPTCHA_PATH = 'ui/drill/captcha.html';
export const TRAINING_CAPTCHA_TOKEN = '{captcha}';
export const TRAINING_CAPTCHA2_PATH = 'ui/drill/captcha2.html';
export const TRAINING_CAPTCHA2_TOKEN = '{captcha2}';
export const TRAINING_CAPTCHA3_PATH = 'ui/drill/captcha3.html';
export const TRAINING_CAPTCHA3_TOKEN = '{captcha3}';
/**
 * The Advanced drill's target: a page THIS APP serves, not a public site.
 *
 * It used to fetch https://example.com/, and example.com quietly changed its
 * wording (v465): a model that fetched the page and saved its text correctly
 * was graded `4 failed at step 4` and rewrote a good file until it gave up. A
 * drill must not depend on a page nobody here controls, so the page now lives
 * in ui/drill/ and is served from disk by Sandbox::drillFixture() — no host is
 * contacted, and the drill cannot drift again without someone editing this repo.
 */
export const TRAINING_PAGE_URL = 'http://drill.local/advanced.html';
export const TRAINING_PAGE_TOKEN = '{page}';
/** A saved custom drill is capped so a bad paste cannot make an endless pass. */
export const CUSTOM_STEP_MAX = 50;

/**
 * The saved custom steps, in the shape the drill uses.
 *
 * A custom step is a tool name plus the operator's instruction. `expect` is
 * optional: when it is set, a successful call also has to mention that text in
 * its arguments or result. Without it, the app can only know the tool returned
 * ok -- it cannot grade free-form prose.
 */
export function normalizeCustomSteps(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, CUSTOM_STEP_MAX).map((step) => {
    const tool = String(step && step.tool || '').trim().toLowerCase().slice(0, 80);
    const instruction = String(step && step.instruction || '').trim().slice(0, 1200);
    const expect = String(step && step.expect || '').trim().slice(0, 200);
    return { tool, instruction, ...(expect ? { expect } : {}) };
  }).filter(step => step.tool && step.instruction);
}

/** The leading folder of a drill file: the hard drill's, or Advanced's log. */
const drillStem = (difficulty) => (difficulty === 'advanced' ? 'advanced'
  : difficulty === 'ide' ? 'ide' : 'training');

/**
 * The agent part of a drill file name: short, filesystem-safe, stable.
 *
 * Six characters, not the whole agent id: a smaller model has to copy this
 * path out of its prompt, and a live run turned `agent-mwn6m27-ecyu71` into a
 * dozen near-miss filenames before it could read its own pass file. The id's
 * random tail is enough to keep sequential agents apart.
 */
const drillSlug = (agent) => {
  const raw = String((agent && (agent.id || agent.code || agent.name)) || 'agent');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(-6) || 'agent';
};

/**
 * The pass currently being drilled, 1-based.
 *
 * Stored as `settings.trainingMode.pass`: Start resets it to 1 and a completed
 * pass bumps it once, so every surface of one pass resolves the same number.
 * A missing or unusable value is pass 1, which is also what an install that
 * predates this setting reads.
 */
export function trainingPassOf(mode) {
  const n = Math.floor(Number(mode && mode.pass));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** The stored pass, for callers that only have an agent and a difficulty. */
export function trainingPassNow() {
  try { return trainingPassOf(store.get('settings.trainingMode')); } catch { return 1; }
}

/**
 * Whether the todo plan on disk belongs to the pass in progress.
 *
 * todo_write is replayed into every system prompt so the plan survives context
 * compaction. That is right during a task, but at the start of a drill pass the
 * stored list is the PREVIOUS pass's, every item [x]. Replaying it told a fresh
 * pass the work was already done before step 1, and the model then skipped the
 * plan it was supposed to write at step 2. The plan becomes current only after
 * step 2's todo_write has passed; a completed pass hides it again until the
 * next pass writes its own.
 */
export function todoPlanIsCurrent(agentId, mode = undefined, verdicts = undefined) {
  const m = mode === undefined ? store.get('settings.trainingMode') : mode;
  if (!m || !m.active) return true;
  const all = verdicts === undefined ? store.get('trainingVerdicts') : verdicts;
  const v = agentId ? ((all || {})[agentId] || null) : null;
  if (!v) return false;
  const step = Math.max(0, Math.floor(Number(v.step) || 0));
  return !v.complete && step >= 2;
}

/**
 * Rewrite this run's drill-file family to the pass in progress.
 *
 * A todo list rebuilt from the previous pass copies that pass's file path
 * with it (live: p3 on pass 4). Replayed verbatim it contradicts YOUR FILE
 * FOR THIS PASS, so the model copies the old pN.txt into the write step.
 * Shared by desktop and mobile so both clients behave the same; mirrors the
 * history scrub in chat.js `_historyFor`.
 */
export function scrubDrillFile(text, agent, difficulty = 'hard') {
  const src = String(text ?? '');
  if (!src || !agent) return src;
  try {
    const current = trainingFileNow(agent, difficulty);
    const family = String(current).replace(/-p\d+\.txt$/i, '');
    if (!family || family === current) return src;
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return src.replace(new RegExp(`${escaped}-p\\d+\\.txt`, 'gi'), current);
  } catch { return src; }
}

/**
 * The drill file for one agent and one pass.
 *
 * Two collisions shaped this name. Every active agent trains in the SAME
 * sandbox, so one shared training.txt let two agents collide (v457): agent B's
 * completed output was what agent A's step 7 read, and A's step 9 then matched
 * two lines. Then consecutive PASSES collided even in a per-agent file: pass 2
 * started against pass 1's finished bytes, so the agent either refused to
 * create a file that already existed or could no longer match the text its
 * edits expect, and the drill's retry-until-it-passes rule turned that into a
 * loop. A pass number in the name gives every pass a file nothing has written.
 *
 * The suffix stays three characters on purpose: models have to copy the path
 * out of their prompt, and the long per-agent name was already enough to stall
 * a run (v458). The pass is filled in by the app, so no extra call is asked of
 * the agent — Easy mode is not made harder by any of this.
 */
export function trainingFileFor(agent, difficulty = 'hard', pass = 1) {
  return `${TRAINING_DIR}/${drillStem(difficulty)}-${drillSlug(agent)}-p${trainingPassOf({ pass })}.txt`;
}

/** The drill file for the pass in progress (the store's pass). */
export function trainingFileNow(agent, difficulty = 'hard') {
  return trainingFileFor(agent, difficulty, trainingPassNow());
}

/**
 * The agent's drill file for ANY pass, as a matcher.
 *
 * The verdict walks a history that can hold several passes, and those calls
 * name the file their own pass was given. Grading that history against one
 * path would re-judge pass 1 against pass 2's name and report failures that
 * never happened — so the verdict takes this matcher instead, and each call is
 * judged against the generation of the file it actually named. The unnumbered
 * spelling is accepted too: a transcript from before this change still names
 * it, and a resumed context may quote one.
 */
export function trainingFileCheckFor(agent, difficulty = 'hard') {
  return (pass) => trainingFileFor(agent, difficulty, pass);
}

/**
 * One line of the run report's per-pass list: which pass, which file it wrote,
 * and whether the app judged it clean.
 *
 * Pure, so the report and its test cannot drift apart. The whole point of
 * printing the path is that the operator can open that file and see the bytes
 * the pass really produced, instead of trusting the scoreboard.
 */
export function formatPassLine(entry) {
  if (!entry) return '';
  const pass = Math.max(1, Math.floor(Number(entry.pass)) || 1);
  const failures = Math.max(0, Math.floor(Number(entry.failures)) || 0);
  const verdict = entry.clean ? 'clean' : `${failures} failed attempt${failures === 1 ? '' : 's'}`;
  // A failed pass is only useful if it says WHAT failed: the error a model kept
  // hitting is the difference between "this model is bad at edits" and "this
  // step's wording is wrong". Whitespace is flattened and the text is clipped,
  // because a tool refusal can be a whole paragraph.
  const reason = String(entry.reason || '').replace(/\s+/g, ' ').trim();
  const step = Math.max(0, Math.floor(Number(entry.step)) || 0);
  const why = (!entry.clean && reason)
    ? ` · first at step ${step || '?'}: "${reason.length > 120 ? reason.slice(0, 120) + '…' : reason}"`
    : '';
  return `pass ${pass} · ${String(entry.file || '')} · ${verdict}${why}`;
}

/** Generic wording for surfaces that describe the drill to the operator. */
const fileForSteps = (agent, difficulty = 'hard') => agent
  ? trainingFileNow(agent, difficulty)
  : `${TRAINING_DIR}/${drillStem(difficulty)}-<agent>-p${trainingPassNow()}.txt`;
const fillFile = (text, agent, difficulty = 'hard') =>
  String(text).split(TRAINING_FILE_TOKEN).join(fileForSteps(agent, difficulty));
const browserDrillUrl = () => new URL('../drill/browser.html', import.meta.url).href;
const fillBrowser = (text) => String(text).split(TRAINING_BROWSER_TOKEN).join(browserDrillUrl());
const captchaDrillUrl = () => new URL('../drill/captcha.html', import.meta.url).href;
const fillCaptcha = (text) => String(text).split(TRAINING_CAPTCHA_TOKEN).join(captchaDrillUrl());
const captcha2DrillUrl = () => new URL('../drill/captcha2.html', import.meta.url).href;
const fillCaptcha2 = (text) => String(text).split(TRAINING_CAPTCHA2_TOKEN).join(captcha2DrillUrl());
const captcha3DrillUrl = () => new URL('../drill/captcha3.html', import.meta.url).href;
const fillCaptcha3 = (text) => String(text).split(TRAINING_CAPTCHA3_TOKEN).join(captcha3DrillUrl());
const fillPage = (text) => String(text).split(TRAINING_PAGE_TOKEN).join(TRAINING_PAGE_URL);

/**
 * Training mode is a closed loop: while it is armed, EVERY finished turn is
 * followed by "Continue", with no budget and no exception for the last step.
 *
 * The old six-resume budget existed to stop a model looping on one display
 * step, but it made the mode useless for unattended practice: a model that
 * stopped after two free steps stalled the drill and the operator had to cycle
 * Start (or leave Always-On running to fake the loop). A finished drill now
 * simply starts another pass.
 *
 * Every exit is a human action, on purpose: switch training off, press STOP
 * (that turn only), type a draft into the composer, or deactivate every agent.
 */

/**
 * The drill, simplest-first. One tool per step so a failure names exactly
 * what to retry. Approval-gated tools (write/exec/…) come after the free
 * ones, because each of those pauses on the operator's Approve button — that
 * pause is part of the lesson, not something to route around.
 */
/** The exact anchored edit card for the two append steps. JSON.stringify
 * produces one backslash before n, the JSON newline escape. A hand-written
 * two-backslash sequence made a model send the literal characters instead. */
const anchoredAppendCard = () => JSON.stringify({
  tool: 'edit_file',
  arg: { path: '{file}', old_string: 'training', new_string: 'training\ndrill 2 passed' },
});

export const TRAINING_TASKS = [
  { tool: 'think', label: 'Call the think tool with one sentence about the drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will work the drill in order.\"}"},
  { tool: 'todo_write', label: 'Write the drill steps below as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}"},
  { tool: 'echo', label: 'Echo "training" back — echo takes a bare string: {"tool":"echo","arg":"training"}, not {"arg":{"text":"training"}}.' ,
    example: "{\"tool\":\"echo\",\"arg\":\"training\"}"},
  { tool: 'now', label: 'Report the current date and time.' ,
    example: "{\"tool\":\"now\"}"},
  { tool: 'write_file', label: 'Create {file} containing exactly "training". (approval needed — wait, do not skip.)' ,
    example: "{\"tool\":\"write_file\",\"arg\":{\"path\":\"{file}\",\"content\":\"training\"}}"},
  { tool: 'read_file', label: 'Read {file} back with read_file — not show_file — confirm "training".' ,
    example: "{\"tool\":\"read_file\",\"arg\":\"{file}\"}"},
  { tool: 'read_file', label: 'Read only line 1 of {file}: read_file with path plus trailing " 1-1" — not show_file.' ,
    example: "{\"tool\":\"read_file\",\"arg\":\"{file} 1-1\"}"},
  { tool: 'edit_file', label: 'In {file}, use edit_file — not write_file, not str_replace_editor — to replace "training" with two lines: "training", then "drill 2 passed". old_string matches; new_string is the two-line text with a real newline. Use exactly this call: ' + anchoredAppendCard() + '. Send the arguments flat — {"path":...,"old_string":...,"new_string":...} — not nested under a second "arg". edit_file replaces, never appends. (approval needed — wait.)',
    example: anchoredAppendCard() },
  { tool: 'edit_file', label: 'Use edit_file again — not write_file and not str_replace_editor — to replace the exact line "drill 2 passed" with "drill 2 passed (exact match)". (approval needed — edits touch only named text.)' ,
    example: "{\"tool\":\"edit_file\",\"arg\":{\"path\":\"{file}\",\"old_string\":\"drill 2 passed\",\"new_string\":\"drill 2 passed (exact match)\"}}"},
  { tool: 'list_dir', label: 'List the training folder.' ,
    example: "{\"tool\":\"list_dir\",\"arg\":\"training\"}"},
  { tool: 'glob_files', label: 'Find files matching "training/*".' ,
    example: "{\"tool\":\"glob_files\",\"arg\":\"training/*\"}"},
  { tool: 'grep_code', label: 'Search the training folder for the word "training".' ,
    example: "{\"tool\":\"grep_code\",\"arg\":\"training\"}"},
  // The display family: each show_* call paints its output into the transcript
  // and ENDS the turn. Training mode resumes the drill after it, which is what
  // lets these sit mid-drill instead of only at the end.
  { tool: 'show_find', label: 'Show the search: use show_find for "training" — matches on screen are your reply. Ends the turn; drill resumes after.' ,
    example: "{\"tool\":\"show_find\",\"arg\":\"training\"}"},
  { tool: 'exec', label: 'Run ["echo","training"] and confirm the output. (approval needed — wait.)' ,
    example: "{\"tool\":\"exec\",\"arg\":[\"echo\",\"training\"]}"},
  { tool: 'show_command', label: 'Show a command: use show_command for ["echo","training"]; its output is your reply. (approval needed — display twin of exec; ends the turn, drill resumes.)' ,
    example: "{\"tool\":\"show_command\",\"arg\":[\"echo\",\"training\"]}"},
  { tool: 'todo_write', label: 'Mark every drill step completed, and put your two-line summary (which tools passed, retries) in the last item.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
  { tool: 'show_file', label: 'Show {file} with show_file — not read_file — the file on screen IS the drill report. Ends the turn; mode sends Continue for a fresh pass, so do not reprint the contents.' ,
    example: "{\"tool\":\"show_file\",\"arg\":\"{file}\"}"},
];

/**
 * Easy mode: the original 12-step sequence, kept for comparison.
 *
 * The wording is taken from commit 53b05a9, with two deliberate changes:
 *   * the hard-coded training/training.txt path became {file}, so two agents
 *     still drill in their own files instead of colliding in one;
 *   * the final "and stop: the drill is done" became "this completes the
 *     12-step pass", because the current harness sends Continue and owns the
 *     ending.
 *
 * Everything else is the old wording — including "Append a second line" on
 * step 7. The wording stays because it is the historical shape of the drill;
 * its card is now the anchored edit that step always meant. A live run with
 * this step's old no-example card sent edit_file with old_string "\n" against
 * a file containing "training", failed, and then could not recover. Hard mode
 * still teaches the same anchored shape in its own words.
 */
export const TRAINING_TASKS_EASY = [
  { tool: 'think', label: 'Call the think tool with one sentence about the drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will work the drill in order.\"}"},
  { tool: 'todo_write', label: 'Write the drill steps below as your todo list, first one in_progress. Send a plain array of step strings — no nested JSON string.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":[\"step 1\",\"step 2\"]}"},
  { tool: 'echo', label: 'Echo the word "training" back.\n{"tool":"echo","arg":"training"}' ,
    example: "{\"tool\":\"echo\",\"arg\":\"training\"}"},
  { tool: 'now', label: 'Report the current date and time.' ,
    example: "{\"tool\":\"now\"}"},
  { tool: 'write_file', label: 'Create {file} containing exactly "training". (approval needed — wait, do not skip.)' ,
    example: "{\"tool\":\"write_file\",\"arg\":{\"path\":\"{file}\",\"content\":\"training\"}}"},
  { tool: 'read_file', label: 'Read {file} back and confirm it says "training".' ,
    example: "{\"tool\":\"read_file\",\"arg\":\"{file}\"}"},
  { tool: 'edit_file', label: 'Append a second line "drill 2 passed" to {file}. Read the file first with read_file and copy its existing text exactly (line may lack trailing newline). Use exactly this call: ' + anchoredAppendCard() + '. (approval needed — wait.)',
    example: anchoredAppendCard() },
  { tool: 'list_dir', label: 'List the training folder.' ,
    example: "{\"tool\":\"list_dir\",\"arg\":\"training\"}"},
  { tool: 'glob_files', label: 'Find files matching "training/*".' ,
    example: "{\"tool\":\"glob_files\",\"arg\":\"training/*\"}"},
  { tool: 'grep_code', label: 'Search the training folder for the word "training".' ,
    example: "{\"tool\":\"grep_code\",\"arg\":\"training\"}"},
  { tool: 'exec', label: 'Run ["echo","training"] and confirm the output. (approval needed — wait.)' ,
    example: "{\"tool\":\"exec\",\"arg\":[\"echo\",\"training\"]}"},
  { tool: 'todo_write', label: 'Mark every drill step completed — this completes the 12-step pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
];

/**
 * Advanced mode: the read → save → show pipeline behind
 * “show_url URL > log.txt”. `show_url` is a display tool: it paints a page and
 * ends the turn, so it cannot redirect into a file. The drill teaches the two
 * real halves instead — fetch_url to read the bytes, write_file to keep them —
 * then proves both the live page and the saved copy on screen.
 */
export const TRAINING_TASKS_ADVANCED = [
  { tool: 'think', label: 'Call the think tool with one sentence about the fetch → save → show pipeline before touching anything — a real tool call, not a sentence in your reply.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will fetch the page, save it, then show both.\"}"},
  { tool: 'todo_write', label: 'Write the Advanced steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}"},
  { tool: 'fetch_url', label: 'Fetch {page} with fetch_url and read the page text. Read half of “show_url URL > log.txt”: show_url only displays and cannot redirect into a file. {page} is served by this app, so it always answers.' ,
    example: "{\"tool\":\"fetch_url\",\"arg\":\"{page}\"}"},
  { tool: 'write_file', label: 'Save that fetched page text to {file} with write_file — the redirect half, done as a real file. (approval needed — wait.)' ,
    example: "{\"tool\":\"write_file\",\"arg\":{\"path\":\"{file}\",\"content\":\"<the fetched page text>\"}}"},
  { tool: 'read_file', label: 'Read {file} back with read_file and confirm it holds the page text you just fetched.' ,
    example: "{\"tool\":\"read_file\",\"arg\":\"{file}\"}"},
  { tool: 'show_url', label: 'Show the live page with show_url at {page} — page text on screen is your reply. Ends the turn; drill resumes after.' ,
    example: "{\"tool\":\"show_url\",\"arg\":\"{page}\"}"},
  { tool: 'show_file', label: 'Show the saved copy with show_file at {file} — file on screen proves the redirect, not just the fetch. Ends the turn; drill resumes after.' ,
    example: "{\"tool\":\"show_file\",\"arg\":\"{file}\"}"},
  { tool: 'todo_write', label: 'Mark every step completed and put your one-line summary (what was fetched, where it was saved) in the last item — this completes the 8-step Advanced pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
];

/**
 * Frontier mode: the real desktop.
 *
 * This is deliberately the small Notepad demo, not a file drill. The operator
 * configures programs in Config → Shell access; agents only name one, and both
 * window_open and window_type still pause for approval. The typed text is the
 * result, so the final step records it and leaves the window open.
 */
export const TRAINING_TASKS_FRONTIER = [
  { tool: 'think', label: 'Call the think tool with one sentence about the desktop demo before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will find Notepad, open it, and type Autonomous Loop Studio - By MBHudson.\"}"},
  { tool: 'todo_write', label: 'Write the Frontier steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}"},
  { tool: 'window_list', label: 'Call window_list and find the configured program named “notepad”. Do not open anything yet.' ,
    example: "{\"tool\":\"window_list\"}"},
  { tool: 'window_open', label: 'Open Notepad on the real desktop with window_open: {"name":"notepad"}. (approval needed — leave the window open.)' ,
    example: "{\"tool\":\"window_open\",\"arg\":{\"name\":\"notepad\"}}"},
  { tool: 'window_type', label: 'Type exactly “Autonomous Loop Studio - By MBHudson” into Notepad with window_type: {"name":"notepad","text":"Autonomous Loop Studio - By MBHudson"}. (approval needed — result must say read back; retry if unverified.)' ,
    example: "{\"tool\":\"window_type\",\"arg\":{\"name\":\"notepad\",\"text\":\"Autonomous Loop Studio - By MBHudson\"}}"},
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: Notepad is open and “Autonomous Loop Studio - By MBHudson” was typed on screen. This completes the 6-step Frontier pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
];

/**
 * Browser mode: the built-in browser driving a deterministic local page.
 *
 * This is deliberately separate from Frontier. Browser Labs is an opt-in
 * server setting and Chrome/Edge may not be installed; folding these steps
 * into the Notepad drill would make a browser failure block the desktop demo
 * too. The local page has one field and one button, so the pass can be
 * recorded or repeated without a public site changing under it.
 */
export const TRAINING_TASKS_BROWSER = [
  { tool: 'think', label: 'Call the think tool with one sentence about the browser drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will open the local page, type, click, and read it back.\"}"},
  { tool: 'todo_write', label: 'Write the Browser steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}"},
  { tool: 'browser_open', label: 'Open the local Browser drill page in a visible window with browser_open: {"url":"{browser}","headless":false}. Wait for it to load.' ,
    example: "{\"tool\":\"browser_open\",\"arg\":{\"url\":\"{browser}\",\"headless\":false}}"},
  { tool: 'browser_read', label: 'Read the page with browser_read and confirm it says “Browser drill”.' ,
    example: "{\"tool\":\"browser_read\"}"},
  { tool: 'browser_type', label: 'Type exactly “training” into the name field with browser_type: {"selector":"#drill-name","text":"training"}. (approval needed — wait.)' ,
    example: "{\"tool\":\"browser_type\",\"arg\":{\"selector\":\"#drill-name\",\"text\":\"training\"}}"},
  { tool: 'browser_click', label: 'Click the “Say hello” button with browser_click: {"selector":"#drill-submit"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#drill-submit\"}}"},
  { tool: 'browser_wait', label: 'Wait for the page to settle with browser_wait: {"ms":300}.' ,
    example: "{\"tool\":\"browser_wait\",\"arg\":{\"ms\":300}}"},
  { tool: 'browser_read', label: 'Read the page again with browser_read and confirm it says “Hello, training”.' ,
    example: "{\"tool\":\"browser_read\"}"},
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the browser opened the local drill page, “training” was typed, and “Hello, training” was read back. This completes the 9-step Browser pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
];

/**
 * Captcha mode: a local page with a fixed code the agent must read and type.
 *
 * Mirrors the Browser drill, but the page carries a captcha code instead of a
 * name field: the agent opens it, reads the code, types it into the answer
 * field, clicks Verify, waits, and reads "Captcha solved" back. The code is
 * fixed so the pass is deterministic and repeatable.
 */
export const TRAINING_TASKS_CAPTCHA = [
  { tool: 'think', label: 'Call the think tool with one sentence about the captcha drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will open the captcha page, read the code, type it, and verify.\"}" },
  { tool: 'todo_write', label: 'Write the Captcha steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}" },
  { tool: 'browser_open', label: 'Open the local Captcha drill page in a visible window with browser_open: {"url":"{captcha}","headless":false}. Wait for it to load.' ,
    example: "{\"tool\":\"browser_open\",\"arg\":{\"url\":\"{captcha}\",\"headless\":false}}" },
  { tool: 'browser_read', label: 'Read the page with browser_read and confirm it says "Captcha drill".' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'browser_type', label: 'Type exactly "X7K9Q" into the answer field with browser_type: {"selector":"#captcha-answer","text":"X7K9Q"}. (Asks approval — wait for it.)' ,
    example: "{\"tool\":\"browser_type\",\"arg\":{\"selector\":\"#captcha-answer\",\"text\":\"X7K9Q\"}}" },
  { tool: 'browser_click', label: 'Click the "Verify" button with browser_click: {"selector":"#captcha-submit"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#captcha-submit\"}}" },
  { tool: 'browser_wait', label: 'Wait for the page to settle with browser_wait: {"ms":300}.' ,
    example: "{\"tool\":\"browser_wait\",\"arg\":{\"ms\":300}}" },
  { tool: 'browser_read', label: 'Read the page again with browser_read and confirm it says "Captcha solved".' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the captcha page opened, "X7K9Q" was typed, and "Captcha solved" was read back. This completes the 9-step Captcha pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}" },
];

/**
 * Captcha Lev.2: a 3x3 grid; select all squares with a bus.
 */
export const TRAINING_TASKS_CAPTCHA2 = [
  { tool: 'think', label: 'Call the think tool with one sentence about the captcha drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will open the grid captcha page, read the prompt, click every bus tile, and verify.\"}" },
  { tool: 'todo_write', label: 'Write the Captcha steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}" },
  { tool: 'browser_open', label: 'Open the local Captcha Lev.2 drill page in a visible window with browser_open: {"url":"{captcha2}","headless":false}. Wait for it to load.' ,
    example: "{\"tool\":\"browser_open\",\"arg\":{\"url\":\"{captcha2}\",\"headless\":false}}" },
  { tool: 'browser_read', label: 'Read the page with browser_read and confirm it says “Captcha drill”.' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'browser_click', label: 'Click the first bus tile with browser_click: {"selector":"#tile-0"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-0\"}}" },
  { tool: 'browser_click', label: 'Click the second bus tile with browser_click: {"selector":"#tile-3"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-3\"}}" },
  { tool: 'browser_click', label: 'Click the third bus tile with browser_click: {"selector":"#tile-5"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-5\"}}" },
  { tool: 'browser_click', label: 'Click the “Verify” button with browser_click: {"selector":"#captcha-submit"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#captcha-submit\"}}" },
  { tool: 'browser_wait', label: 'Wait for the page to settle with browser_wait: {"ms":300}.' ,
    example: "{\"tool\":\"browser_wait\",\"arg\":{\"ms\":300}}" },
  { tool: 'browser_read', label: 'Read the page again with browser_read and confirm it says “Captcha solved”.' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the grid captcha page opened, all bus tiles were clicked, and “Captcha solved” was read back. This completes the 11-step Captcha Lev.2 pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}" },
];

/**
 * Captcha Lev.3: a 3x3 grid; select all squares with a stop sign.
 */
export const TRAINING_TASKS_CAPTCHA3 = [
  { tool: 'think', label: 'Call the think tool with one sentence about the captcha drill before touching anything — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will open the grid captcha page, read the prompt, click every stop-sign tile, and verify.\"}" },
  { tool: 'todo_write', label: 'Write the Captcha steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}" },
  { tool: 'browser_open', label: 'Open the local Captcha Lev.3 drill page in a visible window with browser_open: {"url":"{captcha3}","headless":false}. Wait for it to load.' ,
    example: "{\"tool\":\"browser_open\",\"arg\":{\"url\":\"{captcha3}\",\"headless\":false}}" },
  { tool: 'browser_read', label: 'Read the page with browser_read and confirm it says “Captcha drill”.' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'browser_click', label: 'Click the first stop-sign tile with browser_click: {"selector":"#tile-0"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-0\"}}" },
  { tool: 'browser_click', label: 'Click the second stop-sign tile with browser_click: {"selector":"#tile-2"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-2\"}}" },
  { tool: 'browser_click', label: 'Click the third stop-sign tile with browser_click: {"selector":"#tile-4"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-4\"}}" },
  { tool: 'browser_click', label: 'Click the fourth stop-sign tile with browser_click: {"selector":"#tile-6"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-6\"}}" },
  { tool: 'browser_click', label: 'Click the fifth stop-sign tile with browser_click: {"selector":"#tile-8"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#tile-8\"}}" },
  { tool: 'browser_click', label: 'Click the “Verify” button with browser_click: {"selector":"#captcha-submit"}.' ,
    example: "{\"tool\":\"browser_click\",\"arg\":{\"selector\":\"#captcha-submit\"}}" },
  { tool: 'browser_wait', label: 'Wait for the page to settle with browser_wait: {"ms":300}.' ,
    example: "{\"tool\":\"browser_wait\",\"arg\":{\"ms\":300}}" },
  { tool: 'browser_read', label: 'Read the page again with browser_read and confirm it says “Captcha solved”.' ,
    example: "{\"tool\":\"browser_read\"}" },
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the grid captcha page opened, all stop-sign tiles were clicked, and “Captcha solved” was read back. This completes the 13-step Captcha Lev.3 pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}" },
];

/**
 * The IDE drill: the shared write path, exercised by the agent itself.
 *
 * Every earlier file drill proves a model can write to the sandbox. This one
 * proves a model can write through the SAME door an operator's editor uses, so
 * the two never diverge: `ide_write` creates the file, `ide_open` puts it in
 * front of the operator, `ide_read` reads it back through the IDE's own API,
 * and `ide_edit` changes it by exact replacement. Nothing here touches the
 * sandbox tools on purpose — substituting `write_file` for `ide_write` is the
 * failure this mode exists to catch, and its checks would pass on content that
 * never reached the editor.
 */
export const TRAINING_TASKS_IDE = [
  { tool: 'think', label: 'Call the think tool with one sentence about the IDE drill: every file step goes through the operator\u2019s editor, not the sandbox tools — a real tool call, not prose.' ,
    example: "{\"tool\":\"think\",\"arg\":\"I will use the IDE tools for every file step.\"}"},
  { tool: 'todo_write', label: 'Write the IDE steps as your todo list, first one in_progress.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"step 1\",\"status\":\"completed\"},{\"content\":\"step 2\",\"status\":\"in_progress\"}]}}"},
  { tool: 'ide_write', label: 'Create the file with ide_write: {"path":"{file}","content":"ide drill"}. Send the arguments flat — {"path":...,"content":"..."} — not nested under a second "arg". That is the only content the later steps edit.' ,
    example: "{\"tool\":\"ide_write\",\"arg\":{\"path\":\"{file}\",\"content\":\"ide drill\"}}"},
  { tool: 'ide_open', label: 'Open the same file in the operator\u2019s IDE with ide_open: {"path":"{file}"} — it appears in their editor.' ,
    example: "{\"tool\":\"ide_open\",\"arg\":{\"path\":\"{file}\"}}"},
  { tool: 'ide_read', label: 'Read it back with ide_read: {"path":"{file}"} and confirm it says “ide drill”.' ,
    example: "{\"tool\":\"ide_read\",\"arg\":{\"path\":\"{file}\"}}"},
  { tool: 'ide_edit', label: 'Change it through the IDE with ide_edit: old_string “ide drill”, new_string “ide drill (edited)”. Exact replacement, never an append.' ,
    example: "{\"tool\":\"ide_edit\",\"arg\":{\"path\":\"{file}\",\"old_string\":\"ide drill\",\"new_string\":\"ide drill (edited)\"}}"},
  { tool: 'ide_read', label: 'Read it again with ide_read: {"path":"{file}"} and confirm it now says “ide drill (edited)”.' ,
    example: "{\"tool\":\"ide_read\",\"arg\":{\"path\":\"{file}\"}}"},
  { tool: 'todo_write', label: 'Mark every step completed and put one line in the last item: the file was created, opened, read, edited and read back through the IDE. This completes the 8-step IDE pass.' ,
    example: "{\"tool\":\"todo_write\",\"arg\":{\"todos\":[{\"content\":\"all steps done\",\"status\":\"completed\"}]}}"},
];

/** Terms used by the checks below, tolerant of how a model spells an argument. */
const argText = (call) => {
  try { return JSON.stringify((call && call.arg) ?? '').toLowerCase(); }
  catch { return String((call && call.arg) || '').toLowerCase(); }
};
const resultText = (call) => String((call && call.result) || '').toLowerCase();
/** Does this call name the drill file? `file` is a path or a matcher. */
const namesTrainingFile = (call, file) => {
  const text = argText(call);
  if (file instanceof RegExp) return file.test(text);
  return text.includes(String(file || TRAINING_FILE).toLowerCase());
};
/** The edit_file arguments as sent, before the case-folding argText() applies. */
const editArg = (call) => (call && call.arg && typeof call.arg === 'object' && !Array.isArray(call.arg)) ? call.arg : {};
const showsTraining = (call) => /training/.test(resultText(call));
/** Does this list_dir call name the training folder the step asked to list? */
const listDirNamesTraining = (call) => /training/i.test(argText(call));
/**
 * A pathless list_dir is the orientation call the tool docs teach ("call
 * list_dir with no path to see the directory you are rooted at"), not a
 * listing of the training folder. Graded as a failed attempt it cost every
 * pass one failure: the model oriented first, then listed training correctly.
 */
const isOrientationListDir = (call) => {
  const a = call && call.arg;
  if (a == null) return true;
  if (typeof a === 'string') return a.trim() === '';
  if (typeof a === 'object' && !Array.isArray(a)) {
    return Object.values(a).every((v) => v == null || (typeof v === 'string' && v.trim() === ''));
  }
  return false;
};
/**
 * The marker on the drill's own page (ui/drill/advanced.html).
 *
 * Both sides of the grade depend on THIS string: the page carries it, and the
 * checks look for it in the saved content and in the read-back. It is ours, so
 * it cannot go stale the way example.com's wording did — and tests/php/
 * drillPage.test.php fails if the page and this module ever disagree.
 */
const DRILL_PAGE_MARKER = /drill-page-v1/i;
const showsDrillPage = (call) => DRILL_PAGE_MARKER.test(resultText(call));

/**
 * What each step can be CHECKED on, beyond "the call returned ok".
 *
 * Index-aligned with TRAINING_TASKS. `null` means the step has no checkable
 * artefact (think, todo_write, now): a successful call is all the evidence
 * there can be. Every other entry looks at the arguments and/or the result, so
 * a model cannot "pass" the ranged read with a full read, or the write with an
 * empty file, and still be called clean.
 */
export const DRILL_CHECKS = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => showsTraining(c),                                                  // 3 echo
  null,                                                                     // 4 now
  (c, file) => namesTrainingFile(c, file) && /"content"\s*:\s*"training/.test(argText(c)), // 5 write_file
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 6 read back
  (c, file) => namesTrainingFile(c, file) && /1-1|"range"/.test(argText(c)),  // 7 ranged read
  (c, file) => namesTrainingFile(c, file)
    && String(editArg(c).old_string ?? '') === 'training'
    && /training\r?\ndrill 2 passed/.test(String(editArg(c).new_string ?? '').replace(/\\n/g, '\n')), // 8 anchored append
  (c, file) => namesTrainingFile(c, file)
    && String(editArg(c).old_string ?? '') === 'drill 2 passed'
    && /drill 2 passed \(exact match\)/.test(String(editArg(c).new_string ?? '')), // 9 exact replace
  (c) => listDirNamesTraining(c),                                           // 10 list_dir
  (c) => showsTraining(c),                                                  // 11 glob_files
  (c) => showsTraining(c),                                                  // 12 grep_code
  (c) => showsTraining(c),                                                  // 13 show_find
  (c) => showsTraining(c),                                                  // 14 exec
  (c) => showsTraining(c),                                                  // 15 show_command
  null,                                                                     // 16 todo_write
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 17 show_file
];

/**
 * Easy-mode checks, aligned with TRAINING_TASKS_EASY.
 *
 * Step 7 is deliberately lenient: the old label says "append", a capability
 * edit_file does not have. A model that anchors the edit correctly passes; a
 * model that sends an empty old_string fails at step 7, which is the failure
 * this mode exists to expose. The check does not require the hard mode's
 * exact old_string/new_string pair, because the old wording never taught it.
 */
export const DRILL_CHECKS_EASY = [
  null,                                                                     // 1 think
  (c) => !/todo list cleared/i.test(resultText(c)),                         // 2 todo_write
  (c) => showsTraining(c),                                                  // 3 echo
  null,                                                                     // 4 now
  (c, file) => namesTrainingFile(c, file) && /"content"\s*:\s*"training/.test(argText(c)), // 5 write_file
  (c, file) => namesTrainingFile(c, file) && showsTraining(c),                // 6 read back
  (c, file) => namesTrainingFile(c, file)
    && String(editArg(c).old_string ?? '') === 'training'
    && /training\r?\ndrill 2 passed/.test(String(editArg(c).new_string ?? '').replace(/\\n/g, '\n')), // 7 anchored append
  (c) => listDirNamesTraining(c),                                           // 8 list_dir
  (c) => showsTraining(c),                                                  // 9 glob_files
  (c) => showsTraining(c),                                                  // 10 grep_code
  (c) => showsTraining(c),                                                  // 11 exec
  (c) => !/todo list cleared/i.test(resultText(c)),                         // 12 todo_write
];

/** Advanced checks, aligned with TRAINING_TASKS_ADVANCED. */
export const DRILL_CHECKS_ADVANCED = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\.local/i.test(argText(c)) && /HTTP 200/i.test(resultText(c)), // 3 fetch_url
  // The saved CONTENT is what this step is about, so it must be real page text
  // and not a summary or a placeholder: length plus the page's own marker.
  (c, file) => {
    const a = (c && c.arg && typeof c.arg === 'object' && !Array.isArray(c.arg)) ? c.arg : {};
    const content = typeof a.content === 'string' ? a.content : '';
    return namesTrainingFile(c, file) && content.length >= 40 && DRILL_PAGE_MARKER.test(content);
  },                                                                        // 4 write_file
  (c, file) => namesTrainingFile(c, file) && showsDrillPage(c),              // 5 read_file
  (c) => /drill\.local/i.test(argText(c)) && showsDrillPage(c),              // 6 show_url
  (c, file) => namesTrainingFile(c, file) && showsDrillPage(c),              // 7 show_file
  null,                                                                     // 8 todo_write
];

/** Frontier checks, aligned with TRAINING_TASKS_FRONTIER. */
export const DRILL_CHECKS_FRONTIER = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /notepad/i.test(resultText(c)),                                    // 3 window_list
  (c) => /notepad/i.test(argText(c)),                                       // 4 window_open
  (c) => /notepad/i.test(argText(c))
    && /"text"\s*:\s*"autonomous loop studio - by mbhudson"/.test(argText(c)), // 5 window_type
  null,                                                                     // 6 todo_write
];

/** Browser checks, aligned with TRAINING_TASKS_BROWSER. */
export const DRILL_CHECKS_BROWSER = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\/browser\.html/i.test(argText(c))
    && /visible window/i.test(resultText(c)),                              // 3 browser_open (visible)
  (c) => /browser drill/i.test(resultText(c)),                              // 4 browser_read heading
  (c) => /#drill-name/i.test(argText(c)) && /"text"\s*:\s*"training"/.test(argText(c)), // 5 browser_type
  (c) => /#drill-submit/i.test(argText(c)),                                 // 6 browser_click
  (c) => /"ms"\s*:\s*\d+/.test(argText(c)) || /waited \d+ms/i.test(resultText(c)), // 7 browser_wait
  (c) => /hello,\s*training/i.test(resultText(c)),                          // 8 browser_read result
  null,                                                                     // 9 todo_write
];

/** Captcha checks, aligned with TRAINING_TASKS_CAPTCHA. */
export const DRILL_CHECKS_CAPTCHA = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\/captcha\.html/i.test(argText(c))
    && /visible window/i.test(resultText(c)),                              // 3 browser_open (visible)
  (c) => /captcha drill/i.test(resultText(c)),                              // 4 browser_read heading
  (c) => /#captcha-answer/i.test(argText(c)) && /"text"\s*:\s*"x7k9q"/.test(argText(c)), // 5 browser_type
  (c) => /#captcha-submit/i.test(argText(c)),                               // 6 browser_click
  (c) => /"ms"\s*:\s*\d+/.test(argText(c)) || /waited \d+ms/i.test(resultText(c)), // 7 browser_wait
  (c) => /captcha solved/i.test(resultText(c)),                             // 8 browser_read result
  null,                                                                     // 9 todo_write
];

/** Grid captcha (Lev.2) checks: open, read, click three bus tiles, submit, wait, read “Captcha solved”. */
export const DRILL_CHECKS_CAPTCHA2 = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\/captcha2\.html/i.test(argText(c))
    && /visible window/i.test(resultText(c)),                              // 3 browser_open (visible)
  (c) => /captcha/i.test(resultText(c)),                                    // 4 browser_read heading
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 5 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 6 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 7 browser_click tile
  (c) => /#captcha-submit/i.test(argText(c)),                               // 8 browser_click submit
  (c) => /"ms"\s*:\s*\d+/.test(argText(c)) || /waited \d+ms/i.test(resultText(c)), // 9 browser_wait
  (c) => /captcha solved/i.test(resultText(c)),                             // 10 browser_read result
  null,                                                                     // 11 todo_write
];

/** Grid captcha (Lev.3) checks: open, read, click five stop-sign tiles, submit, wait, read “Captcha solved”. */
export const DRILL_CHECKS_CAPTCHA3 = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c) => /drill\/captcha3\.html/i.test(argText(c))
    && /visible window/i.test(resultText(c)),                              // 3 browser_open (visible)
  (c) => /captcha/i.test(resultText(c)),                                    // 4 browser_read heading
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 5 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 6 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 7 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 8 browser_click tile
  (c) => /#tile-\d+/i.test(argText(c)),                                     // 9 browser_click tile
  (c) => /#captcha-submit/i.test(argText(c)),                               // 10 browser_click submit
  (c) => /"ms"\s*:\s*\d+/.test(argText(c)) || /waited \d+ms/i.test(resultText(c)), // 11 browser_wait
  (c) => /captcha solved/i.test(resultText(c)),                             // 12 browser_read result
  null,                                                                     // 13 todo_write
];

/**
 * IDE checks, aligned with TRAINING_TASKS_IDE.
 *
 * The tool name for each step is enforced by the harness (a call to the wrong
 * tool is off-step), so these grade only what the call and its result say: the
 * path is this pass's file, the created content is the marker, the edit is
 * anchored on that marker, and the second read really shows the edit.
 */
export const DRILL_CHECKS_IDE = [
  null,                                                                     // 1 think
  null,                                                                     // 2 todo_write
  (c, file) => namesTrainingFile(c, file) && /"content"\s*:\s*"ide drill/.test(argText(c)), // 3 ide_write
  (c, file) => namesTrainingFile(c, file),                                  // 4 ide_open
  (c, file) => namesTrainingFile(c, file) && /ide drill/.test(resultText(c)), // 5 ide_read back
  (c, file) => namesTrainingFile(c, file)
    && /"old_string"\s*:\s*"[^"]*ide drill/.test(argText(c))
    && /"new_string"\s*:\s*"[^"]*edited/.test(argText(c)),                // 6 ide_edit
  (c, file) => namesTrainingFile(c, file) && /edited/.test(resultText(c)),   // 7 ide_read again
  null,                                                                     // 8 todo_write
];

/** The saved custom table, or the current one when no explicit list is given. */
function customStepsFrom(steps) {
  return normalizeCustomSteps(steps === undefined ? store.get('settings.trainingMode.customSteps') : steps);
}

/** Turn saved custom steps into the same task shape the built-in drills use. */
function customTasksFrom(steps) {
  return customStepsFrom(steps).map(step => ({ tool: step.tool, label: step.instruction, expect: step.expect || '' }));
}

/** Optional literal check for a custom step; no `expect` means success is enough. */
function customChecksFrom(steps) {
  return customStepsFrom(steps).map(step => {
    if (!step.expect) return null;
    const needle = step.expect.toLowerCase();
    return (call) => `${argText(call)}\n${resultText(call)}`.includes(needle);
  });
}

/** Which drill a mode setting selects. Unknown/legacy settings are Hard. */
export function trainingDifficulty(mode) {
  const d = String((mode && mode.difficulty) || '').toLowerCase();
  const normalized = d === 'captcha' ? 'captcha1' : d;
  return ['easy', 'hard', 'advanced', 'frontier', 'browser', 'captcha1', 'captcha2', 'captcha3', 'ide', 'custom'].includes(normalized) ? normalized : 'hard';
}

/** The ordered task table for a difficulty. */
export function trainingTasksFor(difficulty, customSteps = undefined) {
  if (difficulty === 'easy') return TRAINING_TASKS_EASY;
  if (difficulty === 'advanced') return TRAINING_TASKS_ADVANCED;
  if (difficulty === 'frontier') return TRAINING_TASKS_FRONTIER;
  if (difficulty === 'browser') return TRAINING_TASKS_BROWSER;
  if (difficulty === 'captcha' || difficulty === 'captcha1') return TRAINING_TASKS_CAPTCHA;
  if (difficulty === 'captcha2') return TRAINING_TASKS_CAPTCHA2;
  if (difficulty === 'captcha3') return TRAINING_TASKS_CAPTCHA3;
  if (difficulty === 'ide') return TRAINING_TASKS_IDE;
  if (difficulty === 'custom') return customTasksFrom(customSteps);
  return TRAINING_TASKS;
}

/** The index-aligned checks for a difficulty. */
export function trainingChecksFor(difficulty, customSteps = undefined) {
  if (difficulty === 'easy') return DRILL_CHECKS_EASY;
  if (difficulty === 'advanced') return DRILL_CHECKS_ADVANCED;
  if (difficulty === 'frontier') return DRILL_CHECKS_FRONTIER;
  if (difficulty === 'browser') return DRILL_CHECKS_BROWSER;
  if (difficulty === 'captcha' || difficulty === 'captcha1') return DRILL_CHECKS_CAPTCHA;
  if (difficulty === 'captcha2') return DRILL_CHECKS_CAPTCHA2;
  if (difficulty === 'captcha3') return DRILL_CHECKS_CAPTCHA3;
  if (difficulty === 'ide') return DRILL_CHECKS_IDE;
  if (difficulty === 'custom') return customChecksFrom(customSteps);
  return DRILL_CHECKS;
}

/**
 * The exact call for one drill step, with this agent's file/page filled in.
 *
 * The step tables carry an `example` beside the wording, so the block the
 * model reads and the gate that refuses it can quote the same shape. A small
 * model that can copy a JSON object does not have to infer the envelope from
 * prose; a custom step has no example because the operator writes the tool and
 * the instruction, not a schema.
 */
export function trainingTaskExample(task, agent = null, difficulty = 'hard') {
  // A weak model copies this card literally, and the nested todo object was
  // the one card it kept losing quotes and braces from. The tool accepts a
  // plain array of step strings, so show that shape instead.
  if (String((task && task.tool) || '').toLowerCase() === 'todo_write') {
    return '{"tool":"todo_write","arg":["step 1","step 2"]}';
  }
  const raw = String((task && task.example) || '');
  if (!raw) return '';
  return fillCaptcha3(fillCaptcha2(fillCaptcha(fillBrowser(fillPage(fillFile(raw, agent, difficulty))))));
}

/**
 * The tools the active drill can name, and nothing else.
 *
 * A drill has a fixed task table; advertising all 50-odd agent tools alongside
 * it is both a prompt cost and a choice cost. The training turn narrows the
 * advertised set to this list (the drill's own tools still win over the agent's
 * panel, exactly as the IDE/browser drills already append theirs), so the model
 * is choosing among seven tools instead of fifty.
 */
export function trainingToolScope(difficulty = undefined, customSteps = undefined) {
  const mode = store.get('settings.trainingMode') || {};
  const diff = difficulty || trainingDifficulty(mode);
  const tasks = trainingTasksFor(diff, customSteps === undefined ? mode.customSteps : customSteps);
  return Array.from(new Set(tasks.map(t => String(t.tool || '').trim()).filter(Boolean)));
}

/**
 * The step the app is waiting for, for the callers that need a tool name rather
 * than prose (forced native choice, repeat guard). A completed pass points at
 * step 1 again because the drill immediately starts the next pass.
 */
export function trainingNow(agent = null) {
  const mode = store.get('settings.trainingMode') || {};
  const difficulty = trainingDifficulty(mode);
  const tasks = trainingTasksFor(difficulty, mode.customSteps);
  const verdict = agent ? ((store.get('trainingVerdicts') || {})[agent.id] || null) : null;
  const total = tasks.length;
  const complete = !!(verdict && verdict.complete);
  const raw = complete ? 0 : (verdict && Number.isFinite(Number(verdict.step)) ? Number(verdict.step) : 0);
  const step = total ? Math.max(0, Math.min(raw, total - 1)) : 0;
  return { difficulty, tasks, total, step, task: tasks[step] || null, complete };
}

/** Stable JSON for a repeat signature: key order must not defeat the guard. */
const stableArg = (value) => {
  if (Array.isArray(value)) return value.map(stableArg);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableArg(value[key]);
    return out;
  }
  return value;
};
export function callSignature(tool, arg) {
  let body;
  try { body = JSON.stringify(stableArg(arg)); } catch { body = String(arg); }
  return `${String(tool || '')}|${body}`;
}

/** The first identical failure that earns an explicit correction. */
export const DRILL_REPEAT_HINT = 3;
/** The louder hint threshold. The drill never pauses or skips a step: the
 *  operator's rule is to repeat the same step until it succeeds. */
export const DRILL_REPEAT_LIMIT = 8;

/**
 * What the model is told after the same call fails repeatedly, or '' before
 * the hint threshold. The exact expected call is quoted when the task has one:
 * "change the argument" without saying which shape is right is what let a live
 * model send a valid `todo_write` 74 times.
 */
export function drillRepeatNotice(count, task, step, total, agent = null, difficulty = 'hard') {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < DRILL_REPEAT_HINT) return '';
  const example = trainingTaskExample(task, agent, difficulty);
  const where = step && total ? ` at step ${step}/${total}` : '';
  const strong = n >= DRILL_REPEAT_LIMIT;
  return `[Drill guard] This exact call has failed ${n} times${where}. Sending it again cannot pass.`
    + (example ? ` Expected: ${example}.` : '')
    + (strong
      ? ' The drill does not skip a step — change the argument and try again.'
      : ' Read the error above and change the argument it names.');
}

/** How many times the SAME error text at one step earns the shape hint. */
export const SAME_ERROR_HINT = 2;

/** Whether the same-error shape hint is on. Default on; the dialog can switch it off. */
export function sameErrorHintEnabled(mode = undefined) {
  const m = mode === undefined ? (store.get('settings.trainingMode') || {}) : (mode || {});
  return m.sameErrorHint !== false;
}

/** Whether training mode halves the request rate. Default on; the Training dialog can switch it off. Local runners are never throttled either way — they have no quota to respect (see rateGovernor.js). */
export function trainingThrottleEnabled(mode = undefined) {
  const m = mode === undefined ? (store.get('settings.trainingMode') || {}) : (mode || {});
  return m.throttle !== false;
}

/** Whether hyper brute force is armed. Default off; the Training dialog can switch it on. A failing drill step is swept through every shape in turn instead of retried in one. */
export function hyperBruteEnabled(mode = undefined) {
  const m = mode === undefined ? (store.get('settings.trainingMode') || {}) : (mode || {});
  return !!(m && m.hyperBrute);
}

/** The four prompt shapes a brute sweep tries, simplest first — the same order the parse-failure escalation already uses, so a same-turn reteach and the next turn agree on what comes next. */
export const BRUTE_SHAPES = ['plain', 'json', 'native', 'anthropic'];
/** Consecutive clean runs in the winning shape that prove it (the hit counts as the first). */
export const BRUTE_CONFIRM = 3;
/** Operator words for the four shapes, for sweep notices. */
export const BRUTE_LABEL = { plain: 'plain JSON', json: 'JSON object', native: 'native tags', anthropic: 'Claude XML' };

/** First of BRUTE_SHAPES not in `tried` (an array or Set), or null when all four failed. Pure so the sweep order is testable without a chat instance. */
export function bruteNextShape(tried) {
  const set = new Set(Array.isArray(tried) ? tried : [...(tried || [])]);
  for (const s of BRUTE_SHAPES) {
    if (!set.has(s)) return s;
  }
  return null;
}

/** Fresh per-agent brute state for one run. `tried`/`winners` are keyed by drill step index; `dead` steps exhausted all four shapes and fall back to the normal retry. */
export function bruteNew() {
  return { tried: {}, winners: {}, proven: {}, wins: 0, lastWinner: null, sweep: null, retry: null, retryOnce: {}, dead: {} };
}

/**
 * Which shape the next attempt on this step must use, or null for the normal path.
 *
 * A sweep in progress pins its next untried shape; a step with a winner pins
 * the winner; otherwise the most recent winner stays pinned while it confirms.
 * Pure: the chat instance owns the state object, this only reads it.
 */
export function brutePinFor(st, step) {
  const s = st || bruteNew();
  if (s.sweep != null && s.sweep !== step) s.sweep = null;
  if (s.retry && s.retry.step !== step) s.retry = null;
  if ((s.dead || {})[step]) return null;
  if (s.retry && s.retry.step === step) return s.retry.shape;
  if (s.sweep === step) return bruteNextShape(s.tried[step] || []);
  if (s.winners && s.winners[step]) return s.winners[step];
  return s.lastWinner || null;
}

/**
 * Record a failed attempt on a drill step. Pure: mutates and returns the decision.
 *
 * A first execution failure is usually a typo, not the shape, so the step gets
 * one free retry in the same shape; parse failures and repeats start the sweep
 * at once. The sweep pins each untried shape in turn; when all four failed the
 * step is marked dead and the normal retry takes over. A failing winner is
 * dethroned so evidence, not history, picks the shape.
 *
 * @param {object} st brute state (see bruteNew)
 * @param {number} step 0-based drill step that failed
 * @param {string} shape the shape that was taught for the failed attempt
 * @param {'parse'|'exec'} kind parse failures are shape evidence; exec failures may be typos
 */
export function bruteFail(st, step, shape, kind) {
  const s = st || bruteNew();
  const tried = s.tried[step] || (s.tried[step] = []);
  if (kind === 'exec' && !tried.includes(shape) && !(s.retryOnce && s.retryOnce[step])) {
    (s.retryOnce || (s.retryOnce = {}))[step] = true;
    s.retry = { step, shape };
    return { pin: shape, note: '', swept: false, exhausted: false, retry: true };
  }
  if (s.retry && s.retry.step === step) s.retry = null;
  if (s.retryOnce) delete s.retryOnce[step];
  if (!tried.includes(shape)) tried.push(shape);
  s.wins = 0;
  if (s.winners && s.winners[step] === shape) delete s.winners[step];
  const next = bruteNextShape(tried);
  if (!next) {
    if (s.sweep === step) s.sweep = null;
    (s.dead || (s.dead = {}))[step] = true;
    return { pin: null, note: '', swept: true, exhausted: true };
  }
  s.sweep = step;
  return {
    pin: next, swept: true, exhausted: false, retry: false,
    note: `Hyper brute (${tried.length}/4): the "${BRUTE_LABEL[shape] || shape}" shape did not run step ${step + 1}. Same step again, now ONLY in the "${BRUTE_LABEL[next]}" shape — one attempt, in the exact format your system prompt teaches.`,
  };
}

/**
 * Record a clean run on a drill step. The hit counts as the first of
 * BRUTE_CONFIRM consecutive runs; when the count is reached the shape is
 * proven and the caller saves it. A shape change restarts the count.
 */
export function bruteWin(st, step, shape) {
  const s = st || bruteNew();
  if (s.sweep === step) s.sweep = null;
  if (s.retryOnce) delete s.retryOnce[step];
  if (s.retry && s.retry.step === step) s.retry = null;
  if (shape !== s.lastWinner) { s.lastWinner = shape; s.wins = 0; }
  (s.winners || (s.winners = {}))[step] = shape;
  s.wins += 1;
  if (s.wins >= BRUTE_CONFIRM && !(s.proven || {})[shape]) {
    (s.proven || (s.proven = {}))[shape] = true;
    return { proven: shape };
  }
  return { proven: null };
}

/** Whether dialect memory requires a real tool success. Default off; Config → Harness / Dialect can switch it on. Reads the new top-level key first, then the legacy Training popup key. */
export function realSuccessOnlyEnabled(mode = undefined) {
  if (mode !== undefined) {
    const m = mode || {};
    if (typeof m.trainingRealSuccessOnly === 'boolean') return m.trainingRealSuccessOnly;
    return !!(m && m.realSuccessOnly);
  }
  const s = store.get('settings') || {};
  if (typeof s.trainingRealSuccessOnly === 'boolean') return s.trainingRealSuccessOnly;
  const m = s.trainingMode || {};
  return !!(m && m.realSuccessOnly);
}

/** Normalise an error for same-error counting: volatile spacing collapsed, capped. */
export function normaliseErrorText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * What the model is told when the SAME error answers the same step repeatedly.
 *
 * `drillRepeatNotice` counts identical CALLS; this counts identical ERRORS,
 * which is the signal when the call keeps changing but the refusal does not —
 * usually a shape problem (a nested envelope, a wrong key) rather than wrong
 * content. It names the flat shape and quotes the step's exact call when the
 * task has one.
 */
export function drillSameErrorNotice(errCount, task, step, total, agent = null, difficulty = 'hard') {
  const n = Math.max(0, Math.floor(Number(errCount) || 0));
  if (n < SAME_ERROR_HINT) return '';
  const example = trainingTaskExample(task, agent, difficulty);
  const where = step && total ? ` at step ${step}/${total}` : '';
  return `[Drill guard] The same error has answered ${n} times${where}. The call shape is probably wrong, not the content: send the arguments flat ({"path":...,"old_string":...,"new_string":...}), not nested under a second "arg".`
    + (example ? ` Expected: ${example}.` : '');
}

/**
 * The correction handed back when the RIGHT tool ran but its arguments did not
 * pass the drill check. A successful `ide_open` of the wrong pass file used to
 * read as "Opened ..." and the model was never told the drill rejected it, so
 * it kept guessing. This names the step and the exact call immediately.
 */
export function drillFailureNotice(task, step, total, agent = null, difficulty = 'hard') {
  if (!task) return '';
  const example = trainingTaskExample(task, agent, difficulty);
  return `[Drill] That call did not pass step ${step}/${total}.`
    + (example ? ` Next call must be exactly: ${example}.` : '')
    + ' The step is still waiting; retry it before moving on.';
}

/**
 * First-try accuracy and the worst step across the completed passes in a run.
 *
 * A step counts as first-try when the pass recorded no failed attempt at it.
 * `failureCounts` is per step and already includes retries, so the percentage
 * is steps, not attempts: a pass that failed step 2 five times is still one
 * non-first-try step out of the pass's total, which is the number that says
 * whether the prompt or the model improved.
 */
export function trainingAccuracy(passLog) {
  const passes = Array.isArray(passLog) ? passLog : [];
  const counts = {};
  let steps = 0, firstTry = 0, observed = 0;
  for (const p of passes) {
    const total = Math.max(0, Math.floor(Number(p && p.totalSteps) || 0));
    if (!total) continue;
    const fc = (p.failureCounts && typeof p.failureCounts === 'object') ? p.failureCounts : {};
    const failedSteps = Object.keys(fc).filter(k => Number(fc[k]) > 0).length;
    steps += total;
    firstTry += Math.max(0, total - failedSteps);
    observed++;
    for (const [step, n] of Object.entries(fc)) {
      const k = Number(step);
      const c = Number(n) || 0;
      if (k > 0 && c > 0) counts[k] = (counts[k] || 0) + c;
    }
  }
  if (!steps) return { steps: 0, firstTry: null, worstStep: 0, worstCount: 0, passes: 0 };
  const worst = Object.entries(counts)
    .map(([step, n]) => [Number(step), n])
    .filter(([step, n]) => step > 0 && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return {
    steps,
    firstTry: Math.round((firstTry / steps) * 100),
    worstStep: worst ? worst[0] : 0,
    worstCount: worst ? worst[1] : 0,
    passes: observed,
  };
}

const DIFFICULTY_INFO = {
  easy: {
    label: 'Easy',
    hint: 'Easy runs the original 12-step sequence, including its old append step. Per-agent files and the Continue loop still apply.',
  },
  hard: {
    label: 'Hard',
    hint: 'Hard runs the current 17-step drill with the ranged read, anchored edits and display tools.',
  },
  advanced: {
    label: 'Advanced',
    hint: 'Advanced runs an 8-step fetch → save → show pipeline: fetch_url reads the app\u2019s own drill page, write_file keeps it as the log, then show_url and show_file prove the live page and the saved copy.',
  },
  frontier: {
    label: 'Frontier',
    hint: 'Frontier runs a 6-step real-desktop demo: window_list finds Notepad, window_open opens it, and window_type types “Autonomous Loop Studio - By MBHudson” and reads the window back to prove it landed. Leave the window open to watch it.',
  },
  browser: {
    label: 'Browser',
    hint: 'Browser runs a 9-step local-page demo in a visible window: open the page, read it, type “training”, click “Say hello”, wait, then read “Hello, training” back. Needs Config → Labs → Browser and Chrome or Edge.',
  },
  captcha1: {
    label: 'Captcha Lev.1',
    hint: 'Captcha runs a 9-step local-page demo in a visible window: open the page, read the code “X7K9Q”, type it into the answer field, click Verify, wait, then read “Captcha solved” back. Needs Config → Labs → Browser and Chrome or Edge.',
  },
  captcha2: {
    label: 'Captcha Lev.2',
    hint: 'Captcha Lev.2 runs an 11-step grid demo in a visible window: open the page, read the prompt, click every bus tile, click Verify, wait, then read “Captcha solved” back. Needs Config → Labs → Browser and Chrome or Edge.',
  },
  captcha3: {
    label: 'Captcha Lev.3',
    hint: 'Captcha Lev.3 runs a 13-step grid demo in a visible window: open the page, read the prompt, click every stop-sign tile, click Verify, wait, then read “Captcha solved” back. Needs Config → Labs → Browser and Chrome or Edge.',
  },
  ide: {
    label: 'IDE',
    hint: 'IDE runs an 8-step shared-editor demo: ide_write creates your drill file, ide_open puts it in the operator\u2019s editor, ide_read proves it, ide_edit changes it by exact replacement, and a second ide_read proves the change. One write path, so the open editor updates live.',
  },
  custom: {
    label: 'Custom',
    hint: 'Custom runs the steps you saved in the drill builder. Each step names the tool the agent must call and the instruction it must follow; an optional expected phrase adds a content check.',
  },
};

/** Human name for a difficulty, used by the dialog and the Start toast. */
export function trainingDifficultyLabel(difficulty) {
  return DIFFICULTY_INFO[trainingDifficulty({ difficulty })]?.label || 'Hard';
}

/** One-line explanation of what a difficulty practices. */
export function trainingDifficultyHint(difficulty) {
  return DIFFICULTY_INFO[trainingDifficulty({ difficulty })]?.hint || DIFFICULTY_INFO.hard.hint;
}

/** What the final step is and what happens after it, per drill. */
function trainingEnding(difficulty, total = 0) {
  if (difficulty === 'easy') {
    return 'After each passed step, update your todo list; the final todo_write completes the 12-step pass — the mode then sends Continue again, so begin a fresh pass instead of waiting.';
  }
  if (difficulty === 'advanced') {
    return 'After each passed step, update your todo list; the final todo_write completes the 8-step Advanced pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. show_url and show_file end their turns, and the drill resumes after each one.';
  }
  if (difficulty === 'frontier') {
    return 'After each passed step, update your todo list; the final todo_write completes the 6-step Frontier pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The Notepad window stays open after the typing step; do not close it.';
  }
  if (difficulty === 'browser') {
    return 'After each passed step, update your todo list; the final todo_write completes the 9-step Browser pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The local drill page stays open; do not navigate to other sites.';
  }
  if (difficulty === 'captcha' || difficulty === 'captcha1') {
    return 'After each passed step, update your todo list; the final todo_write completes the 9-step Captcha pass � the mode then sends Continue again, so begin a fresh pass instead of waiting. The local captcha page stays open; do not close it.';
  }
  if (difficulty === 'captcha2') {
    return 'After each passed step, update your todo list; the final todo_write completes the 11-step Captcha Lev.2 pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The local captcha page stays open; do not close it.';
  }
  if (difficulty === 'captcha3') {
    return 'After each passed step, update your todo list; the final todo_write completes the 13-step Captcha Lev.3 pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The local captcha page stays open; do not close it.';
  }
  if (difficulty === 'ide') {
    return 'After each passed step, update your todo list; the final todo_write completes the 8-step IDE pass — the mode then sends Continue again, so begin a fresh pass instead of waiting. The file stays open in the operator\u2019s editor; leave it open.';
  }
  if (difficulty === 'custom') {
    return `After each passed step, update your todo list; the final step completes the ${total}-step Custom pass — the mode then sends Continue again, so begin a fresh pass instead of waiting.`;
  }
  return 'After each passed step, update your todo list; the summary goes in the last todo item; the final show_file ends the PASS — the mode then sends Continue again, so begin a fresh pass instead of waiting.';
}

/**
 * Why a tool call must wait, or '' when it may run.
 *
 * Grading alone cannot keep a drill in order: a model that re-runs steps 3-6
 * keeps getting ok results, the verdict stays at step 6, and the operator
 * watches "6/8 · waiting for show_file" while the transcript fills with work
 * that cannot count. This gate refuses the call BEFORE it runs and names the
 * step the app is actually waiting for.
 *
 * `think` is the model's scratchpad and is allowed at any point. At step 1 it
 * IS the awaited step and advances the drill; mid-pass it advances nothing and
 * resets nothing (the verdict ignores it).
 *
 * `todo_write` is the status update the drill asks for after every passed
 * step, so it is allowed once the pass has actually progressed. It is NOT
 * allowed while the drill still waits for step 1: a live run answered
 * "Step 1 (think): ..." with prose, then sent todo_write again and again, each
 * call answered "todo list cleared", and the drill sat at 1/8 for the rest of
 * the run. A todo update is housekeeping only after the first step has passed.
 *
 * The expected step itself is always allowed even with wrong arguments: the
 * tool's own error is more useful than a gate message, and the verdict counts
 * the failed attempt.
 */
export function drillStepRefusal(tool, agent, verdict, difficulty = undefined) {
  const mode = store.get('settings.trainingMode') || {};
  const diff = difficulty || trainingDifficulty(mode);
  const tasks = trainingTasksFor(diff, mode.customSteps);
  if (!tasks.length) return '';
  const name = String(tool || '').trim().toLowerCase();
  // A scratchpad call is always allowed. At step 1 it is the step itself, so
  // the verdict advances there; later it is neutral (see drillVerdict).
  if (name === 'think') return '';
  // Inspecting the file is not skipping the drill. This is what lets a model
  // read its own pass file before an anchored edit instead of guessing a
  // trailing newline it cannot see.
  if (isInspect(name)) return '';
  const complete = !!(verdict && verdict.complete);
  const step = complete ? 0
    : Math.max(0, Math.min(Number(verdict && verdict.step) || 0, tasks.length));
  const next = complete ? tasks[0] : (tasks[step] || tasks[0]);
  if (name === String(next.tool || '').trim().toLowerCase()) return '';
  // Housekeeping, not a step: a todo update may ride along once the pass has
  // actually progressed. Before step 1 has passed it is an attempt to skip the
  // drill's first step -- and "todo list cleared" used to reward exactly that.
  if (name === 'todo_write' && !complete && step > 0) return '';
  const where = complete
    ? `The pass is complete — start the next one at step 1 (${tasks[0].tool})`
    : `You are at step ${step + 1}/${tasks.length}, and your next reply must be the ${next.tool} call and nothing else`;
  const expected = trainingTaskExample(next, agent, diff);
  const exact = expected ? ` Next call: ${expected}.` : '';
  const inDrill = tasks.some(t => String(t.tool || '').trim().toLowerCase() === name);
  const housekeeping = name === 'todo_write'
    ? ' A todo update is allowed only after a step has passed; step 1 comes first.'
    : '';
  return (inDrill
    ? `${where}.${exact} Do not redo an earlier step or jump ahead; the drill runs in order.`
    : `${where}.${exact} ${tool} is not part of this drill — work only the listed steps.`) + housekeeping;
}

/**
 * Why a write must not run, or '' when it may.
 *
 * Grading a wrong-pass write as a failure (v468) catches it, but by then the
 * write has already happened: a pass that rebuilt its todo list from the
 * previous pass's overwrote that pass's evidence before the step was refused.
 * The evidence is the point of writing one file per pass, so the refusal has to
 * come before the tool runs. The model gets an ordinary tool error naming the
 * file it should have used, which is the same correction the drill's reminder
 * gives it, only sooner and without the damage.
 *
 * Only this run's own drill files are checked: anything outside
 * `training/<stem>-<agent>-pN.txt` is somebody else's business, and the pass's
 * own file (or a non-file tool) is never refused.
 */
export function drillWriteRefusal(tool, arg, agent, difficulty = undefined, pass = undefined) {
  // IDE writes are the same evidence as sandbox writes. Missing them here let
  // an IDE pass write the PREVIOUS pass's file successfully, after which the
  // drill failed the step but the model had already seen "Wrote ...".
  if (!['write_file', 'edit_file', 'append_file', 'ide_write', 'ide_edit'].includes(tool)) return '';
  const diff = difficulty || trainingDifficulty(store.get('settings.trainingMode') || {});
  const n = pass === undefined ? trainingPassNow() : pass;
  const raw = typeof arg === 'string' ? arg : (arg && (arg.path || arg.file)) || '';
  const path = String(raw).trim().replace(/\\/g, '/');
  if (!path) return '';
  const mine = trainingFileFor(agent, diff, n);
  const family = `${TRAINING_DIR}/${drillStem(diff)}-${drillSlug(agent)}`;
  // The file server accepts a leading slash as another spelling of a
  // sandbox-relative path, and an absolute path can carry the same family at
  // its tail. Normalize both before the family test: without this, a write to
  // /training/… (or C:/…/sandbox/training/…) bypassed the guard, landed on the
  // old pass's file, and was only caught after the damage was done.
  const relative = (() => {
    const p = path.replace(/^\/+/, '');
    const marker = p.lastIndexOf('/training/');
    return marker >= 0 ? p.slice(marker + 1) : p;
  })();
  if (!relative.startsWith(family)) return '';
  if (relative === mine) return '';
  return `drill pass ${n} writes ${mine}, not ${relative} — ${relative} belongs to another pass of this run, and each pass keeps its own file. Write ${mine}.`;
}

/**
 * The file a pass actually wrote, read from the tool records rather than from
 * the pass counter.
 *
 * These are not the same thing, and assuming they were is what made a live run's
 * report lie: pass 1 wrote `…-p1.txt`, pass 2 ran and wrote `…-p1.txt` AGAIN (it
 * rebuilt its todo list from the first pass's and copied that path), and the
 * report then filed pass 2 under `…-p2.txt` — the name the counter had already
 * moved to — so the summary pointed at a file no pass had written while the real
 * one had been overwritten. The last write_file in the history is the pass that
 * just finished, which is the file an operator should open.
 *
 * Empty when the pass wrote nothing (Frontier, Browser and Custom drills have no
 * file step); callers fall back to the expected path.
 */
export function drillPassFile(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const call = list[i];
    // Every tool that CREATES the pass file counts, not just the sandbox one:
    // the IDE drill writes with ide_write, and reading only write_file left
    // that drill's report falling back to the counter's file — the NEXT pass's
    // name — so the report pointed at a file the pass never wrote.
    const arg = call && call.arg && typeof call.arg === 'object'
      && (call.tool === 'write_file' || call.tool === 'ide_write') ? call.arg : null;
    const path = arg && typeof arg.path === 'string' ? arg.path.trim() : '';
    if (path) return path;
  }
  return '';
}

/**
 * Grade a drill pass from the tool records alone.
 *
 * The point is not to ask the model whether it succeeded -- its todo list is a
 * claim, not evidence. The app saw every call it made: which tool, with what
 * arguments, and whether the result was ok, an error, skipped or waiting on an
 * approval. This walks those records against TRAINING_TASKS in order and
 * answers two questions:
 *
 *   complete -- did a full pass of every step run?
 *   clean    -- did it do so with no failed attempt at any step?
 *
 * Retries are counted the way the transcript header counts them (the same
 * tool + the same arguments sent again after an error), but `failures` also
 * counts a CORRECTED attempt, which is why `clean` is failures === 0 rather
 * than retries === 0: a step fixed with different arguments is not a clean
 * step, even though it is not a literal repeat.
 *
 * A pass boundary is a `think` after the pass has every step. Records that are
 * still running, skipped because a display tool ended the turn, or waiting on
 * an approval never prove a step passed -- and a skipped call is not a
 * failure either.
 *
 * `file` is a drill path, a RegExp, or a function from trainingFileCheckFor
 * that maps a pass number to that pass's file. The function is what the app
 * uses: grading every call against whatever generation of the name it happens
 * to mention let a second pass rewrite the FIRST pass's log and still count as
 * clean, because the file it wrote was not the file the app had just told it to
 * write. Walked per pass, a wrong-pass write fails its step and the drill tells
 * the agent which file is its own.
 */
export function drillVerdict(calls, file = TRAINING_FILE, difficulty = 'hard', customSteps = undefined) {
  const tasks = trainingTasksFor(difficulty, customSteps);
  const checks = trainingChecksFor(difficulty, customSteps);
  const total = tasks.length;
  const list = Array.isArray(calls) ? calls.filter(c => c && c.tool) : [];
  // A custom drill with no saved steps has no pass to grade. Return the empty
  // shape rather than dividing by / indexing into a zero-length table.
  if (!total) {
    return {
      totalSteps: 0, step: 0, complete: false, clean: false, passes: 0, cleanPasses: 0,
      failures: 0, failuresTotal: 0, failureCounts: {}, passFailureCounts: {}, retries: 0, pending: false,
      failedAt: null, offStep: 0, offTool: '', nextTool: '', retryHint: '', restarts: 0, empty: true,
    };
  }
  const blank = () => ({
    step: 0, failures: 0, failureCounts: {}, retries: 0, pending: false,
    failedAt: null, offStep: 0, offTool: '', lastFailure: null, firstFailure: null,
  });
  let cur = blank();
  let passes = 0;
  let cleanPasses = 0;
  // Kept in the returned shape for existing callers. A mid-pass think is a
  // scratchpad now, so a live drill never restarts itself.
  const restarts = 0;
  let last = null;
  let lastKey = '';
  let lastStatus = '';
  // Failures belong to the step they happened on, not just the pass. The live
  // strip still reads `failures` for the current pass; the completion summary
  // reads this run-wide tally ("2x step 5, 1x step 7").
  const completedFailureCounts = {};
  let completedFailures = 0;
  const mergePass = (pass) => {
    for (const [step, n] of Object.entries(pass.failureCounts || {})) {
      completedFailureCounts[step] = (completedFailureCounts[step] || 0) + n;
    }
    completedFailures += pass.failures;
  };
  const countFailure = (failedResult = '') => {
    const stepNo = cur.step + 1;
    cur.failures++;
    cur.failureCounts[stepNo] = (cur.failureCounts[stepNo] || 0) + 1;
    if (cur.failedAt === null) cur.failedAt = stepNo;
    // The FIRST failure is what the report quotes: later ones are usually the
    // model repeating it, and quoting the last would name a symptom of the
    // symptom instead of the thing that went wrong.
    if (cur.firstFailure === null) cur.firstFailure = { step: stepNo, result: String(failedResult || '') };
    cur.lastFailure = { step: stepNo, result: String(failedResult || '') };
  };

  for (const call of list) {
    const tool = String(call.tool);
    const status = String(call.status || '');

    // A finished pass starts a new attempt: the next call must be step 1's
    // tool. A `think` DURING a pass is different -- it is the scratchpad the
    // tool instructions promise, so it advances nothing, resets nothing, and
    // is ignored below. Only a completed pass can begin the next one.
    if (cur.step >= total) {
      if (tool !== tasks[0].tool) continue;
      mergePass(cur);
      passes++;
      if (cur.failures === 0 && !cur.pending) cleanPasses++;
      last = cur;
      cur = blank();
    }

    const want = tasks[cur.step];
    const check = checks[cur.step];
    // The file of the pass this call belongs to, resolved as the walk goes: a
    // history can hold several passes, and each one has its own file.
    const fileNow = typeof file === 'function' ? file(passes + 1) : file;
    const key = `${tool}|${argText(call)}`;
    const retry = lastKey === key && lastStatus === 'error';
    lastKey = key;
    lastStatus = status;

    // A check only judges a call that SUCCEEDED: a pending approval, an error
    // and a still-running call have produced no artefact to inspect.
    const checkOk = !check || status !== 'ok' || check(call, fileNow);

    // Another tool never advances the drill, and it is not an attempt at this
    // step either. It is still recorded: a run of calls for other steps is what
    // a model that lost its place looks like, and the strip used to sit on the
    // same number with no explanation while one restarted the drill.
    if (tool !== want.tool) {
      // The scratchpad is allowed at any point and is not a lost place: it
      // neither advances the step nor counts as off-step.
      if (tool === 'think' || isInspect(tool)) continue;
      if (status !== 'skipped' && status !== 'running') {
        if (status === 'error') {
          // An error on a tool that is not the next step is still a failed
          // attempt. The old rule called it only "off-step", so the red
          // write_file errors in a live run never appeared in the strip.
          countFailure(resultText(call));
        } else {
          cur.offStep++;
          cur.offTool = tool;
        }
      }
      continue;
    }

    // The right tool with arguments this step cannot accept IS an attempt at
    // it -- a full read is not the ranged read. This used to be ignored, so a
    // model could repeat a wrong call and still be graded clean.
    if (!checkOk) {
      // Orientation is taught by the tool docs, so a pathless list_dir while
      // the drill waits for list_dir is a scratchpad read, not a failed
      // attempt. A list_dir that names any other path still fails the step.
      if (want.tool === 'list_dir' && isOrientationListDir(call)) continue;
      countFailure(resultText(call));
      if (status === 'error' && retry) cur.retries++;
      cur.offStep = 0;
      cur.offTool = '';
      continue;
    }

    // A real attempt at the step clears the "lost" signal.
    cur.offStep = 0;
    cur.offTool = '';

    if (status === 'pending') { cur.pending = true; continue; }
    if (status === 'error') {
      countFailure(resultText(call));
      if (retry) cur.retries++;
      continue;
    }
    // running / skipped / unknown: the step may yet happen, but it has not.
    if (status !== 'ok') continue;
    cur.step++;
  }

  const complete = cur.step >= total;
  if (complete) {
    mergePass(cur);
    passes++;
    if (cur.failures === 0 && !cur.pending) cleanPasses++;
    last = cur;
  }
  const failureCounts = { ...completedFailureCounts };
  if (!complete) {
    for (const [step, n] of Object.entries(cur.failureCounts)) {
      failureCounts[step] = (failureCounts[step] || 0) + n;
    }
  }
  // While a new pass is in progress the judgement is still the finished one.
  const judged = complete ? cur : last;
  // Which pass the failure text describes: the finished one when another has
  // already started, otherwise the pass being watched. A pass that never
  // completed has no `last` at all, and its first error is exactly what the
  // operator needs to see — so it is not left blank.
  const reported = complete ? cur : (last || cur);
  // The Frontier typing step is the one place where a successful-looking call
  // can still be a failure: the app now reads the window back, and if that
  // read-back says unverified, the operator needs the next action in the strip,
  // not just a red "1 failed at step 5".
  const nextTask = complete ? null : tasks[cur.step];
  const retryHint = (!complete && difficulty === 'frontier'
    && nextTask && nextTask.tool === 'window_type'
    && cur.lastFailure && cur.lastFailure.step === cur.step + 1
    && /unverified|could not be read back/i.test(cur.lastFailure.result))
    ? 'Retry window_type: the window text was not read back, so the typed text is unconfirmed.'
    : (!complete && difficulty === 'browser'
      && nextTask && nextTask.tool === 'browser_open'
      && cur.lastFailure && cur.lastFailure.step === cur.step + 1
      && /headless/.test(cur.lastFailure.result))
      ? 'Retry browser_open with "headless":false: this drill needs a visible window.'
      : '';
  return {
    totalSteps: total,
    step: Math.min(cur.step, total),
    complete,
    // "Clean" is a claim about a FINISHED pass only. A pass in progress, or a
    // log with no calls, is never clean however few failures it has so far.
    clean: !!judged && judged.failures === 0 && !judged.pending,
    passes,
    // Clean passes in this run: the number the "stop after N clean passes"
    // option counts, and the same judgement `clean` makes — a finished pass
    // with zero failed attempts.
    cleanPasses,
    // Always 0: a mid-pass think is a scratchpad, not a restart. Kept in the
    // returned shape so older callers keep working.
    restarts,
    // Failure counts describe the pass being watched: while another pass runs,
    // that is the one whose failures the operator needs to see live.
    failures: cur.failures,
    // The whole run, for the completion summary: every finished pass plus the
    // one in progress, with a per-step breakdown.
    failuresTotal: completedFailures + (complete ? 0 : cur.failures),
    failureCounts,
    // The judged pass's own per-step tally, for the pass log's accuracy line.
    // `failureCounts` above is run-wide; the log needs one pass at a time.
    passFailureCounts: judged ? { ...(judged.failureCounts || {}) } : {},
    retries: cur.retries,
    pending: cur.pending,
    failedAt: cur.failedAt,
    // Calls since the last step progress that were for another tool. Not a
    // failure (the step was never attempted), but the visible sign of a model
    // that lost its place.
    offStep: cur.offStep,
    offTool: cur.offTool,
    nextTool: complete ? '' : (tasks[cur.step]?.tool || ''),
    // The error the judged pass hit first, so the report can quote it instead
    // of only counting it. Empty when the pass had no failed attempt.
    failureReason: reported && reported.firstFailure ? reported.firstFailure.result : '',
    failureStep: reported && reported.firstFailure ? reported.firstFailure.step : null,
    retryHint,
  };
}

/**
 * The verdict that reached this run's clean-pass target, or null.
 *
 * The mode never stores 0 (trainingCleanTarget clamps to 1..99), but a 0 is
 * still treated as "no target" here so an older caller can never stop a run
 * by accident. With several agents, the FIRST to reach the target ends the run
 * for all of them: waiting for every agent would let one bad model keep a
 * fleet billing forever, which is the opposite of what a stopping rule is for.
 */
export function reachedCleanTarget(mode, verdicts) {
  const target = Math.max(0, Math.floor(Number(mode && mode.cleanPassTarget) || 0));
  if (!target) return null;
  for (const v of Object.values(verdicts || {})) {
    if (v && Number(v.cleanPasses || 0) >= target) return v;
  }
  return null;
}

/**
 * The stopping rule for this run, in clean passes.
 *
 * The drill exists to reach a 100% pass: every step correct, no failed attempt,
 * no retry. So the floor is 1 and an unset value means 1 -- whole passes repeat
 * until that clean pass, then the run stops. A saved 0 (the old "never stop"
 * default) is read as 1 too: leaving it at 0 would silently opt an existing
 * install out of the rule. 99 is the ceiling so a bad paste cannot pin a fleet
 * forever; Stop is the way out of a long unattended run. Clamped here rather
 * than in each caller, so the dialog, Start and the stop listener can never
 * disagree about the rule.
 */
export function trainingCleanTarget(mode) {
  const raw = mode ? mode.cleanPassTarget : undefined;
  if (raw === undefined || raw === null || raw === '') return 1;
  return Math.max(1, Math.min(99, Math.floor(Number(raw) || 1)));
}

/**
 * The strip's leading label. States the stopping rule only when one is set, so
 * the normal header stays one word and a run that will end itself says so.
 */
export function drillStripTitle(mode) {
  const n = Math.max(0, Math.floor(Number(mode && mode.cleanPassTarget) || 0));
  const difficulty = trainingDifficulty(mode);
  const base = difficulty === 'easy' ? 'easy drill'
    : difficulty === 'advanced' ? 'advanced drill'
      : difficulty === 'frontier' ? 'frontier drill'
        : difficulty === 'ide' ? 'ide drill'
          : difficulty === 'custom' ? 'custom drill' : 'drill';
  if (!n) return base;
  return `${base} \u00b7 stop at ${n} clean pass${n === 1 ? '' : 'es'}`;
}

/**
 * One line for a verdict, shared by the live strip and the Training dialog so
 * the two can never describe the same run differently.
 *
 * Complete passes are described by their outcome; an unfinished one shows how
 * far it got and what is blocking it. "clean" only ever appears on a finished
 * pass (see drillVerdict).
 */
export function drillVerdictText(verdict) {
  if (!verdict) return '';
  const bits = [`${verdict.step}/${verdict.totalSteps}`];
  if (verdict.complete) {
    bits.push(verdict.clean ? 'clean' : `${verdict.failures} failed`);
  } else if (verdict.failures) {
    bits.push(`${verdict.failures} failed${verdict.failedAt ? ` at step ${verdict.failedAt}` : ''}`);
  } else if (verdict.offStep) {
    bits.push(`waiting for ${verdict.nextTool || 'the next step'} (last call: ${verdict.offTool})`);
  }
  if (verdict.pending) bits.push('approval');
  if (verdict.stuck) {
    const st = typeof verdict.stuck === 'object' ? verdict.stuck : {};
    bits.push(`stuck${st.step ? ` at step ${st.step}` : ''}${st.count ? ` after ${st.count} tries` : ''}`);
  }
  if (verdict.retryHint) bits.push(verdict.retryHint);
  if (verdict.passes) bits.push(`${verdict.passes} pass${verdict.passes === 1 ? '' : 'es'}${verdict.complete ? '' : ' done'}`);
  return bits.join(' \u00b7 ');
}

/** True while the operator has training mode armed. */
export function isTrainingActive() {
  try {
    return !!(store.get('settings.trainingMode') || {}).active;
  } catch {
    return false;
  }
}

/** Whether a completed pass should get its own report while the run goes on. */
export function showsEveryPass(mode) {
  return !!(mode && mode.active && mode.showEveryPass);
}

/** Short numbered recap for the popup dialog. */
export function trainingStepList(agent = null, difficulty = 'hard', customSteps = undefined) {
  return trainingTasksFor(difficulty, customSteps)
         .map((t, i) => `${i + 1}. ${t.tool} — ${fillCaptcha3(fillCaptcha2(fillCaptcha(fillCaptcha(fillBrowser(fillPage(fillFile(t.label, agent, difficulty)))))))}${t.expect ? ` (must include “${t.expect}”)` : ''}`);
}

/**
 * The chat turn Start dispatches, so arming the mode IS starting the drill.
 * Self-contained on purpose: a fresh turn also carries the drill in its
 * system prompt, but a turn already in flight when Start is pressed was built
 * before arming — this text reaches those agents through the steer queue at
 * their next tool-loop boundary. Either way the drill runs through the normal
 * turn path, so messages, topology, metrics and trace all behave as usual.
 */
export function trainingKickoffFor(difficulty = null) {
  // This one text reaches every agent, so it must never contain the literal
  // `<agent>` placeholder: a live run had the model stop to work out what its
  // "agent id" was instead of reading the exact path its own prompt block
  // already carried. The block is authoritative; this message stays generic.
  const mode = store.get('settings.trainingMode') || {};
  const diff = difficulty || trainingDifficulty(mode);
  const tasks = trainingTasksFor(diff, mode.customSteps);
  const stepLabel = (label) => fillCaptcha3(fillCaptcha2(fillCaptcha(fillBrowser(fillPage(String(label).split(TRAINING_FILE_TOKEN)
    .join(diff === 'advanced' ? 'your log file' : 'your drill file'))))));
  const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${stepLabel(t.label)}${t.expect ? ` (must include “${t.expect}”)` : ''}`).join('\n');
  const ending = trainingEnding(diff, tasks.length);
  const custom = diff === 'custom';
  const scope = diff === 'frontier'
    ? 'on the real desktop'
    : diff === 'browser'
      ? 'in the built-in browser, on the local drill page'
      : custom
        ? 'wherever each step directs (the training folder, a URL, or the real desktop)'
        : 'inside the "training" sandbox folder';
  const fileRule = diff === 'frontier'
    ? 'window_list first, and use only the program names it shows; window_open the program before window_type; leave Notepad open after typing; never touch another window'
    : diff === 'browser'
      ? 'open only the local browser drill page named above in a visible window (headless:false); use #drill-name for the field and #drill-submit for the button; do not navigate to any other site'
      : custom
        ? 'use the exact tool each step names, including any custom tool saved in Brain Lab, and follow the instruction as written'
        : 'every agent has its OWN file in the training folder — use the exact path in your TRAINING MODE block, which the app also repeats when this kickoff reaches a turn already in flight — never another agent\'s file, and never the project folder above the sandbox';
  const approvalRule = diff === 'frontier'
    ? 'window_open and window_type ask for my approval — waiting for it is part of the drill'
    : diff === 'browser'
      ? 'browser_type asks for my approval — waiting for it is part of the drill'
      : custom
        ? 'any step whose tool asks for my approval — waiting for it is part of the drill'
        : 'write_file, edit_file and exec ask for my approval — waiting for it is part of the drill';
  return `Training mode is ON — work this drill now, step by step, ${scope}. Nothing else while it is on.\n`
    + `Steps:\n${steps}\n`
    + `Rules: one step at a time; a failed step is retried until it passes, never skipped — but READ the error and change the argument, because "Did you mean ..." or "not a file" means the path is wrong, not that the call should be sent again unchanged; ${fileRule}; ${approvalRule}.${hyperBruteEnabled(mode) ? ' Hyper brute force is ON: when a step fails you will redo it in each untried shape in turn — plain JSON, JSON object, native tags, Claude XML — until one runs, then repeat the winning shape until it has run cleanly 3 times in a row.' : ''} ${ending}`;
}

/**
 * Whether a finished training turn should be continued.
 *
 * "Every turn" is the point: a display step, a plain text reply, a budget
 * exhaustion and a completed drill all get the same treatment. The drill block
 * in the system prompt says what to do with the Continue that follows.
 *
 * Pure (no store access) so the decision is testable without a chat instance.
 */
export function shouldResumeDrill(mode) {
  return !!(mode && mode.active);
}

/**
 * The text a continued drill turn is dispatched with.
 *
 * Plain "Continue" when there is nothing recorded yet. Once calls exist, the
 * message carries the position the APP saw for each agent. A resumed turn was
 * rebuilt from a short message window and its own todo list, and a model that
 * lost track restarted the whole pass: the calls for steps 1-15 then arrived
 * while the verdict waited at 16, which read as a silent stall. Naming the
 * next step costs one line and makes the restart impossible to do innocently.
 *
 * Still sent silently and rendered nowhere, so the operator sees only the
 * drill -- the model sees the position its own past calls produced.
 */
export function trainingResumeFor() {
  // One message reaches EVERY active agent, so it must not list their
  // positions: a live run had the second model read the first model's
  // "pass complete (17/17)" and start at step 17. Each agent's own position
  // is in its own TRAINING MODE block, where the app wrote it; this stays
  // generic and points there.
  return 'Continue. Your TRAINING MODE block records your own position from the calls the app saw — resume there. A think call or a read-only inspection (read_file, list_dir, glob_files, grep_code, ide_read, browser_read, window_list) is a scratchpad: it does not restart the pass or reset its steps. Only a completed pass starts the next one.';
}

/**
 * The system-prompt block injected in front of every agent's own prompt while
 * training is armed. Three jobs: INSTRUCT (the drill), PROBE (stay on it),
 * and REMEMBER (record each pass so the next turn reuses what worked).
 */
export function trainingBlockFor(agent = null) {
  if (!isTrainingActive()) return '';
  const mode = store.get('settings.trainingMode') || {};
  const difficulty = trainingDifficulty(mode);
  const tasks = trainingTasksFor(difficulty, mode.customSteps);
  const frontier = difficulty === 'frontier';
  const browser = difficulty === 'browser';
  const ide = difficulty === 'ide';
  const custom = difficulty === 'custom';
  const file = fileForSteps(agent, difficulty);
     const steps = tasks.map((t, i) => `${i + 1}. ${t.tool}: ${fillCaptcha3(fillCaptcha2(fillCaptcha(fillCaptcha(fillBrowser(fillPage(fillFile(t.label, agent, difficulty)))))))}${t.expect ? ` (must include “${t.expect}”)` : ''}`).join('\n');
  const mine = agent ? (store.get('trainingVerdicts') || {})[agent.id] : null;
  const total = tasks.length;
  const recorded = mine && Number.isFinite(Number(mine.step)) ? Math.max(0, Number(mine.step)) : null;
  const step = recorded === null ? null : Math.min(recorded, total);
  const complete = !!(mine && (mine.complete || step >= total));
  const next = step !== null && step < total ? tasks[step] : null;
  const nextExample = next ? trainingTaskExample(next, agent, difficulty) : '';
  const firstExample = tasks[0] ? trainingTaskExample(tasks[0], agent, difficulty) : '';
  const positionRule = step === null ? ''
    : complete
      ? `- YOUR recorded position: pass complete (${total}/${total}) — start a fresh pass at step 1${firstExample ? `. Exact call: ${firstExample}` : ''}.\n`
      : `- YOUR recorded position: ${step}/${total} — next is step ${step + 1}${next ? ` (${next.tool})` : ''}${nextExample ? `. Exact call: ${nextExample}` : ''}. Resume there. A mid-pass think is a scratchpad: it neither advances nor resets the drill, and only a completed pass starts the next one.\n`;
  // The pass file, up front. A model that rebuilt its todo list from the last
  // pass copied that pass's path with it and wrote the old file; the path was
  // buried in a rule halfway down this block, after the steps. Said first, and
  // named as the only file for THIS pass, it is much harder to miss.
  const fileLine = (frontier || browser || custom)
    ? ''
    : `YOUR FILE FOR THIS PASS: ${file} — every file step reads and writes exactly that path. A path from an earlier pass, or one copied out of your own todo list, is the WRONG file.\n`;
  const pacing = trainingThrottleEnabled(mode);
  const opening = `[TRAINING MODE — ${pacing ? 'paced drill, ~50% request rate' : 'drill at full request rate'}. Nothing else matters until training mode is switched off.]\n`
    + fileLine
    + (frontier
      ? `Work ONLY these steps, in order, on the real desktop. Do not answer other questions, do not open unrelated programs, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
      : ide
        ? `Work ONLY these steps, in order, through the built-in IDE. Do not answer other questions, do not touch other files, do not start other work \u2014 if asked anything else, finish the current drill step first and say the drill comes first.\n`
        : browser
          ? `Work ONLY these steps, in order, in the built-in browser. Do not answer other questions, do not open unrelated pages, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
        : custom
          ? `Work ONLY these steps, in order, wherever each one directs. Do not answer other questions, do not start unrelated work — if asked anything else, finish the current drill step first and say the drill comes first.\n`
          : `Work ONLY these steps, in order, inside the "training" sandbox folder. Do not answer other questions, do not touch other files, do not start other work — if asked anything else, finish the current drill step first and say the drill comes first.\n`)
    + `Steps:\n${steps}\n`
    + `Rules:\n`;

  // Easy keeps the old drill's rules (there is no edit_file contract and no
  // display-tool lesson) so step 7 stays the diagnostic it was. The path,
  // old-transcript and position rules are harness safety, not difficulty.
  if (difficulty === 'easy') {
    return opening
      + `- One step at a time. Call the step's tool, read its result, then move on.\n`
      + `- EVERY step is a real tool call, including step 1 (think). Writing "Step 1 (think): ..." as prose runs nothing; send {"tool":"think","arg":"..."} and read its result.\n`
      + `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`
      + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN drill file — do not read or edit another agent's.\n`
      + `- THIS RUN uses the file above. Any earlier training transcript that mentions training/training.txt is an OLD run: ignore its paths and copy nothing from it.\n`
      + positionRule
      + `- Read-only inspection (read_file, list_dir, glob_files, grep_code) is a scratchpad: it is allowed at any step, never advances the drill, and never counts as a failure. Use read_file when you need the exact text before edit_file.\n`
      + `- edit_file is exact search-and-replace, never an append: old_string is the text you match, new_string replaces it. For step 7, use the exact call in the step: it replaces "training" with the two-line text "training" then "drill 2 passed". Do not send the two characters backslash and n instead of a newline.` + String.fromCharCode(10)
      + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
      + `- The Continue message names the step the app recorded for you. Resume there. A mid-pass think is a scratchpad: it neither advances nor resets the drill; only a completed pass starts a new one.\n`
      + `- This mode never lets the drill stop. When a turn ends — a short reply or a completed pass — you are sent "Continue" automatically. Treat Continue as the next instruction: pick up the first step your todo list does not show completed, and when every step is complete, start a fresh pass at step 1. Never say the drill is finished, never ask whether to continue, never wait for the operator.\n`
      + `- After each passed step, update your todo_write list so what worked is written down.`;
  }

  const oneStep = `- One step at a time. Call the step's tool, read its result, then move on.\n`
    + `- EVERY step is a real tool call, including step 1 (think). Writing "Step 1 (think): ..." as prose runs nothing; send {"tool":"think","arg":"..."} and read its result.\n`;
  const retry = `- If a tool call errors, is denied, or returns the wrong thing, read the error message and TRY AGAIN with fixed arguments. Keep retrying the SAME step — never skip a failed step, never move on until it returns ok.\n`;
  const inspectRule = `- Read-only inspection (read_file, list_dir, glob_files, grep_code, ide_read, browser_read, window_list) is a scratchpad: allowed at any point, it never advances or resets the drill and is not a failure. Use it when you need the exact text before an edit.\n`;
  const continueRule = `- The Continue message names the step the app recorded for you. Resume at that step. A mid-pass think is a scratchpad: it neither advances nor resets the drill; only a completed pass starts a new one.\n` + inspectRule;
  const stopRule = `- This mode never lets the drill stop. When a turn ends — a display step, a short reply, even the final step — you are sent "Continue" automatically. Treat Continue as the next instruction: pick up the first step your todo list does not show completed, and when every step is complete, start a fresh pass at step 1. Never say the drill is finished, never ask whether to continue, never wait for the operator.\n`;

  if (custom) {
    return opening
      + oneStep
      + retry
      + `- These are the operator's saved custom steps. Call the exact tool named by each step and carry out its instruction; never substitute an easier tool.\n`
      + `- A step may use a built-in tool or one saved in Brain Lab. If a step includes {file}, it resolves to your drill file, ${file}; otherwise follow the instruction exactly.\n`
      + `- Some custom steps carry an expected phrase. The app checks the call's arguments and result for it, so make sure the phrase appears before moving on.\n`
      + positionRule
      + `- Any step whose tool asks for approval may pause. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down.`;
  }

  if (difficulty === 'frontier') {
    return opening
      + oneStep
      + retry
      + `- This is the REAL desktop, not the sandbox: window_list first, and use only the program names it shows. Never invent a path, executable or window name.\n`
      + `- window_open starts one configured program by name; the window outlives your reply. Call window_list again if you are unsure whether it is already running.\n`
      + `- window_type types into the newest window of that program, live on screen, then reads the window back. Type exactly "Autonomous Loop Studio - By MBHudson" into Notepad, keep the burst short, and leave the window open afterwards — the result must say the typed text is there; if it says unverified, retry the step.\n`
      + positionRule
      + `- window_open and window_type ask the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary; the Notepad window stays open.`;
  }

  if (difficulty === 'browser') {
    return opening
      + oneStep
      + retry
      + `- This drill runs in the built-in browser, not the sandbox or the desktop. Open only the local page named above; do not navigate to other sites.\n`
      + `- browser_type needs the #drill-name selector and the exact text "training". browser_click uses #drill-submit. browser_read after each action tells you what actually changed.\n`
      + `- browser_wait is a real pause for the page to settle; keep it short (300 ms). The final browser_read must show “Hello, training”.\n`
      + positionRule
      + `- browser_type asks the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary; the local drill page stays open.`;
  }

  if (difficulty === 'ide') {
    return opening
      + oneStep
      + retry
      + `- Every file step goes through the IDE's own API: ide_write, ide_open, ide_read, ide_edit. Do not substitute write_file, read_file or edit_file \u2014 they are a different door to the same disk, and this drill exists to prove the IDE door works.\n`
      + `- ide_write takes the WHOLE file as "content"; ide_edit is exact search-and-replace, so old_string is the text you match and new_string replaces it. An empty or ambiguous old_string is refused, so a bare append can never pass.\n`
      + `- The file is ${file}, in the app's own tree rather than the sandbox: pass exactly that path, relative, with forward slashes.\n`
      + `- ide_open only shows the file in the operator's editor and changes nothing on disk. The operator may be watching it, so open the real file before you edit it.\n`
      + positionRule
      + `- ide_edit asks the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary; the file stays open in the IDE.`;
  }

  if (difficulty === 'advanced') {
    return opening
      + oneStep
      + retry
      + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
      + `- fetch_url gets a page's text into your context. show_url only DISPLAYS a page and ENDS the turn; it cannot redirect into a file. The redirect in "show_url URL > log.txt" is two calls here: fetch_url to read the bytes, then write_file to keep them.\n`
      + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN log file — do not read or edit another agent's.\n`
      + `- THIS RUN uses the file above. Any earlier training transcript that mentions another path is an OLD run: ignore its paths and copy nothing from it.\n`
      + positionRule
      + `- write_file asks the operator for approval. That pause is normal: wait for it, do not work around it, and do not narrate the call as text.\n`
      + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_url (the live page) and show_file (the saved copy). Never re-describe what one showed. Use fetch_url when you need the page text back to save it; use show_url only when the page itself is the answer.\n`
      + continueRule
      + stopRule
      + `- After each passed step, update your todo_write list so what worked is written down. The final todo_write is the summary — it completes the pass, and the mode then sends Continue for a fresh one.`;
  }

  return opening
    + oneStep
    + retry
    + `- An error that says "Did you mean ..." or "not a file" is telling you the ARGUMENT is wrong: change it. Sending the identical call again fails identically.\n`
    + `- edit_file is exact search-and-replace, never an append: old_string is the text you match, new_string replaces it. To add a line, anchor on the neighbouring text and make new_string the two-line text (the exact call for this step shows the shape). Do not send the two characters backslash and n instead of a newline. An empty or ambiguous old_string is refused, so a bare append can never pass.` + String.fromCharCode(10)
    + `- Paths are relative to the sandbox: ${file}. Never the project folder above it, and never an absolute C:\\... path. Every agent has its OWN drill file — do not read or edit another agent's.\n`
    + `- THIS RUN uses the file above. Any earlier training transcript that mentions training/training.txt is an OLD run: ignore its paths and copy nothing from it.\n`
    + positionRule
    + `- Some steps ask the operator for approval (write_file, edit_file, exec). That pause is normal: wait for it, do not work around it, do not narrate the call as text.\n`
    + `- Display tools paint their output straight into the transcript as your reply and END the turn: show_file (a file), show_find (search results), show_command (a command's output), show_url (a page). Never re-describe what one showed, and never use one when you need the output back to decide the next step — that is read_file, grep_code, exec. The read steps are read_file, never show_file; the edit steps are edit_file, never write_file or str_replace_editor.\n`
    + continueRule
    + stopRule.replace('even the final step', 'even the final show_file')
    + `- After each passed step, update your todo_write list so what worked is written down. Put the two-line summary (which tools passed, how many retries each took) in the final todo item: the last step shows the file and ends the turn.`;
}
