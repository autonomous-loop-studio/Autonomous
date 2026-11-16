#!/usr/bin/env node
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// DRILL-RUN.MJS — run a training drill against a real model, from a terminal
// ============================================
//
// The drill table, its checks and its grader live in ui/js/training.js. This
// runner uses that same code, so a pass graded here is graded by exactly what
// the Training screen uses — there is no second definition of "passed" to drift
// from the first.
//
// Per turn it:
//   1. arms the drill in the app's own store (settings.trainingMode),
//   2. builds the prompt block a live agent would receive (trainingBlockFor),
//   3. offers the drill's tools as native function schemas (ui/js/nativeTools.js),
//   4. executes every call through ide/api.php — the app's own write path, so
//      the revision log, the path jail and the actor labels all apply,
//   5. grades the history after each call and prints the verdict.
//
// Protocol: OpenAI-compatible chat completions only. Anthropic and Google use
// different request/response shapes; naming one of those says so instead of
// reporting the refusal as a model failure.
//
// Usage
//   node drill-run.mjs --dry-run
//       Print the system prompt, the tool schemas and the drill file. No network.
//   node drill-run.mjs --model openai/gpt-4o --key-env DRILL_API_KEY
//   node drill-run.mjs --target 3                 # chain passes, stop at 3 clean ones
//   node drill-run.mjs --mode advanced            # a different drill, same machinery
//
// --mode takes the Training dialog's own ids: easy, hard, advanced, frontier,
// browser, ide, custom. The task table, the checks, the pass-file naming and the
// tool list all come from ui/js/training.js for that mode, so this runner has no
// second definition of any drill. ide_* calls go through ide/api.php; every
// other mode's tools run through the app's own TOOL_REGISTRY, with the same
// scope the chat hands it.
//
// Frontier and Browser drive the real desktop and a real browser window, so a
// headless run of either really does launch Notepad / Chrome. That is the drill,
// not a side effect — --max-turns bounds how many times it can happen.
//   node drill-run.mjs --endpoint https://host/v1/chat/completions --model m \
//                      --key-file ./drill-key --base http://127.0.0.1:8080/router
//
// --base is optional. Without it the runner asks each of a short candidate list
// (Apache under /router on 8080, then php -S ports, then the roots) for the IDE
// API's info payload and uses the first that answers like this app.
//
// The key is read from --key-file, then --key-env, then storage/models.json, in
// that order, and is never printed — not in a log line, not in an error, not in
// --dry-run output.
//
// Exit codes: 0 a clean completed pass, 1 a pass that failed or did not finish,
// 2 a configuration problem (no key, no server, an unsupported provider).
//
// Every run writes a transcript to storage/drills/ (--out picks the path,
// --no-transcript skips it): the whole prompt, every call with its arguments,
// every result untruncated, and the verdict after each one — so a failed pass
// can be read later instead of only scrolled in the terminal.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// store.js and persistence.js expect a browser. A Map-backed shim keeps them
// quiet and lets training.js read settings through the accessor the app uses,
// so the armed drill here is the same object the app arms.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(String(k)) ? mem.get(String(k)) : null),
  setItem: (k, v) => mem.set(String(k), String(v)),
  removeItem: k => mem.delete(String(k)),
  clear: () => mem.clear(),
  key: i => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
// api.js reads window.location while its module initialises. Any quiet value
// will do: --base overwrites baseUrl below, before anything is sent.
globalThis.window = globalThis.window || { location: { pathname: '/ui/' } };
globalThis.document = globalThis.document || { getElementById: () => null };

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('./ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) die('cannot read APP_VERSION from ui/js/store.js');

const { store } = await import(`./ui/js/store.js?v=${version}`);
const {
  trainingBlockFor, drillVerdict, drillVerdictText, trainingFileFor, trainingFileCheckFor,
  trainingTasksFor,
} = await import(`./ui/js/training.js?v=${version}`);
const { TOOL_REGISTRY, toolInstructions, runTool, bindSandboxNow } = await import(`./ui/js/tools.js?v=${version}`);
const { nativeToolDefs } = await import(`./ui/js/nativeTools.js?v=${version}`);
const { sandboxRootFor } = await import(`./ui/js/agentConfig.js?v=${version}`);
const { api } = await import(`./ui/js/api.js?v=${version}`);

function die(msg) {
  console.error(`drill-run: ${msg}`);
  process.exit(2);
}

// An app module can throw from a timer — an approval dialog with no DOM, for
// instance. That used to kill Node mid-pass with a stack trace and no verdict;
// name it instead, so a run either ends with a scoreboard or says why not.
process.on('uncaughtException', e => die(`uncaught error in the app's own code: ${e && e.message}`));

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}
const has = name => argv.includes(`--${name}`);

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 45).join('\n'));
  process.exit(0);
}

// --- which server ----------------------------------------------------------

// The app answers at /router under Apache, at the root of a php -S, and on
// whichever port either was started on, so one hard-coded address that dies when
// it is wrong is a poor default. --base still wins outright; without it, each
// candidate is asked for the IDE API's info, which nothing else answers like it.
const CANDIDATES = [
  'http://127.0.0.1:8080/router',
  'http://127.0.0.1:8099',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8000/router',
  'http://127.0.0.1:8000',
  'http://localhost:8080/router',
];

/** Is this app answering at that address? Its info payload names the folder and
 * carries the read/write limits, which no other server on the port will match. */
async function isApp(url) {
  try {
    const res = await fetch(`${url}/ide/api.php?action=info`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok || !/json/i.test(String(res.headers.get('content-type') || ''))) return false;
    const body = await res.json().catch(() => null);
    return !!(body && typeof body.name === 'string' && body.limits);
  } catch {
    return false; // nothing listening, or not this app
  }
}

async function findApp() {
  const given = String(flag('base', '')).trim().replace(/\/+$/, '');
  if (given) {
    // An explicit address is not a guess, so it is checked rather than second-
    // guessed: a typo in the port or the /router prefix would otherwise surface
    // as a tool error in the middle of step 3 instead of a sentence up front.
    if (!(await isApp(given))) {
      die(`nothing at ${given}/ide/api.php?action=info — is the app running there, and is the
path prefix right (Apache mounts this folder at /router)? Drop --base to let the
runner look.`);
    }
    return { url: given, auto: false };
  }
  for (const url of CANDIDATES) {
    if (await isApp(url)) return { url, auto: true };
  }
  return { url: '', auto: false };
}

const found = await findApp();
if (!found.url) {
  die('cannot find the app — nothing answered /ide/api.php?action=info at any of:\n  '
    + CANDIDATES.join('\n  ')
    + '\nstart it (php -S, or Apache with this folder mounted), or pass --base <url>');
}
const base = found.url;
api.baseUrl = `${base}/api`;
const pass = Math.max(1, Math.floor(Number(flag('pass', '1')) || 1));
// How many CLEAN passes to stop at — the same setting the Training dialog
// writes (settings.trainingMode.cleanPassTarget). 0 keeps the app's meaning,
// "never stop on its own", which for a CLI is one pass.
const target = Math.max(0, Math.floor(Number(flag('target', '0')) || 0));
// A slow provider that stops answering used to stall a run forever: fetch has no
// timeout of its own. Each request now aborts and reports as a failed turn.
const requestTimeout = Math.max(5, Math.floor(Number(flag('timeout', '180')) || 180)) * 1000;
const maxTurns = Math.max(1, Math.floor(Number(flag('max-turns', '24')) || 24));
const keep = has('keep');
const dryRun = has('dry-run');
const agent = { id: String(flag('agent', 'drill_runner')), name: String(flag('agent', 'drill_runner')) };
// Which drill to arm. Checked against the app's own list first: training.js
// answers an unknown difficulty with the Hard table, so a typo would otherwise
// run a 17-step drill and report it as the one that was asked for.
const mode = String(flag('mode', 'ide')).trim().toLowerCase() || 'ide';
const MODES = ['easy', 'hard', 'advanced', 'frontier', 'browser', 'ide', 'custom'];
if (!MODES.includes(mode)) die(`--mode ${mode} is not a drill — one of ${MODES.join(', ')}`);

// --- the app's own config (no secret is ever printed) -----------------------

function readJson(rel, fallback = null) {
  const p = new URL(rel, import.meta.url);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

const sandboxCfg = readJson('./storage/config.json', {})?.sandbox || {};
const ideToken = String(sandboxCfg.token || '').trim();

const catalogue = Array.isArray(readJson('./storage/models.json', [])) ? readJson('./storage/models.json', []) : [];
const wanted = String(flag('model', '')).trim();
const row = wanted
  ? catalogue.find(r => String(r && (r.model || r.id) || '') === wanted || String(r && r.id) === wanted)
  : catalogue.find(r => String(r && r.apiKey || '').trim());

const endpoint = String(flag('endpoint', row?.endpoint || '')).trim();
const model = String(flag('model', row?.model || row?.id || '')).trim();
const provider = String(flag('provider', row?.provider || '')).trim().toLowerCase();

function resolveKey() {
  const file = String(flag('key-file', '')).trim();
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) die(`--key-file ${file} is empty`);
    return value;
  }
  const envName = String(flag('key-env', 'DRILL_API_KEY')).trim();
  if (envName && process.env[envName]) return String(process.env[envName]).trim();
  const fromCatalogue = String(row?.apiKey || '').trim();
  if (fromCatalogue) return fromCatalogue;
  return '';
}

// --- the drill -------------------------------------------------------------

// Arming it in the app's store is what makes trainingBlockFor produce anything:
// the block is the same function the chat uses, not a copy of its text.
const tasks = trainingTasksFor(mode);
if (!tasks.length) {
  die(mode === 'custom'
    ? '--mode custom runs the operator\u2019s saved steps, and a headless run has none — build them in the app\u2019s custom drill builder and use easy/hard/advanced/frontier/browser/ide here'
    : `--mode ${mode} has no steps — one of ${MODES.join(', ')}`);
}
// The drill's own tools, in the order its steps name them: an IDE pass offers
// ide_*, an Advanced pass offers fetch_url/write_file/show_url/show_file. Nothing
// is hard-coded, so the tools offered can never disagree with the steps.
const toolNames = [...new Set(tasks.map(t => String(t.tool)))];
const IDE_TOOL_NAMES = ['ide_open', 'ide_read', 'ide_write', 'ide_edit'];
// Frontier, Browser and Custom steps name no drill file at all, so their prompt
// block carries no file line and there is nothing to look for in it.
const usesFile = tasks.some(t => /\{file\}|write_file|read_file|edit_file|ide_write|ide_edit|ide_read|ide_open|str_replace/.test(`${t.tool} ${t.label}`));

// Grading follows the pass counter rather than one fixed file name: a history
// of two passes judged against p2 reads pass 1's p1 calls as failures, and
// reports a clean two-pass run as "1 failed". The app passes this same
// matcher to drillVerdict, so a rate means the same thing in both places.
const matcher = trainingFileCheckFor(agent, mode);

let file = '';
let systemPrompt = '';

/**
 * Arm one pass and build the block that names its own file.
 *
 * The counter is the app's (settings.trainingMode.pass) and so is the file
 * naming, so this runner and the Training screen describe the same run. A
 * fresh conversation per pass is deliberate: a model handed the last pass's
 * transcript rebuilds its todo list from it and copies that path with it — the
 * failure the pass counter exists to prevent.
 */
function beginPass(n) {
  store.set('settings.trainingMode', { active: true, difficulty: mode, pass: n, cleanPassTarget: target });
  file = trainingFileFor(agent, mode, n);
  systemPrompt = [
    trainingBlockFor(agent),
    toolInstructions(toolNames, ROOT, 'native-api'),
  ].filter(Boolean).join('\n\n');
  if (usesFile && !systemPrompt.includes(file)) {
    die(`the prompt block does not name ${file} — is the drill armed in ui/js/training.js?`);
  }
}

beginPass(pass);
// Headless has no operator to click Allow, and every non-IDE step that asks
// (write_file, window_open, browser_type) would otherwise hang on a dialog that
// cannot be drawn. This is the app's OWN auto-approve setting, the same one an
// operator can turn on in Config, so a drill run here behaves like theirs.
store.set('settings.autoApprove', true);
// Tools other than the IDE's bind their runners here, once, to the client the
// runner already points at --base; they are the app's own implementations.
if (toolNames.some(n => !IDE_TOOL_NAMES.includes(n))) bindSandboxNow(api);

const toolDefs = nativeToolDefs(
  toolNames.map(name => ({ name, description: TOOL_REGISTRY[name]?.describe || name })),
  'openai',
);

if (dryRun) {
  console.log('=== drill ===');
  console.log(`mode: ${mode} · ${tasks.length} steps · file: ${file || '(none — this drill names no file)'}`);
  console.log(`target: ${target ? `${target} clean pass${target === 1 ? '' : 'es'}` : 'one pass'} (--target)`);
  console.log(`server: ${base}${found.auto ? ' (found)' : ' (--base)'} (${ideToken ? 'token from storage/config.json' : 'no token configured'})`);
  console.log('\n=== tools offered as function schemas ===');
  for (const d of toolDefs) console.log(`  ${d.function.name}(${Object.keys(d.function.parameters?.properties || {}).join(', ')})`);
  console.log('\n=== system prompt (first 30 lines) ===');
  for (const line of systemPrompt.split('\n').slice(0, 30)) console.log('  ' + line);
  console.log(`\n  ... ${systemPrompt.split('\n').length} lines, ${systemPrompt.length} characters`);
  console.log('\nDry run: nothing was sent to a model and nothing was written.');
  process.exit(0);
}

if (!endpoint) die('no endpoint: pass --endpoint, or put a provider row with an endpoint in storage/models.json');
if (provider === 'anthropic' || provider === 'google') {
  die(`${provider} uses a different request shape; this runner speaks OpenAI-compatible chat completions only`);
}
const key = resolveKey();
if (!key) {
  die('no API key. Use --key-file <path>, --key-env <NAME>, or a provider row in storage/models.json '
    + '(Config → Providers in the app). The key is never printed.');
}
if (!/chat\/completions|localhost|127\.0\.0\.1/i.test(endpoint) && !/^https:/i.test(endpoint)) {
  die('the endpoint must be https (or a loopback address for a local model)');
}

// --- the transcript --------------------------------------------------------
//
// A failed pass is only useful if its evidence survives the scrollback. The
// terminal keeps the one-line form; the file keeps the whole thing — the prompt
// the model actually read, every call with its arguments, every result
// untruncated, and the verdict after each call. It is written from an exit hook
// so a run that dies halfway still leaves what it did, and it lives under
// storage/, which every serving mode refuses to serve.

const transcriptPath = String(flag('out', '')).trim()
  || `storage/drills/${new Date().toISOString().replace(/[:.]/g, '-')}-${agent.id}.log`;
const transcriptOff = has('no-transcript');
let transcript = '';
// The transcript is not allowed to become the reason a run dies: a loop that
// goes wrong writes megabytes, and an unbounded string throws instead of
// reporting. It stops at 4 MB and says so.
const MAX_TRANSCRIPT = 4_000_000;
let transcriptTrimmed = false;
const appendToTranscript = (chunk) => {
  if (transcript.length >= MAX_TRANSCRIPT) {
    if (!transcriptTrimmed) {
      transcriptTrimmed = true;
      transcript += '\n[transcript truncated at 4 MB]\n';
    }
    return;
  }
  transcript += chunk;
};
const note = (line = '') => appendToTranscript(line + '\n');
const say = (...parts) => {
  const line = parts.map(String).join(' ');
  appendToTranscript(line + '\n');
  console.log(line);
};
process.on('exit', () => {
  if (transcriptOff) return;
  try {
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, transcript);
  } catch { /* a lost transcript must never fail the run */ }
});

note('drill-run transcript');
note(`started:  ${new Date().toISOString()}`);
note(`agent:    ${agent.id} \u00b7 pass ${pass}`);
note(`file:     ${file}`);
note(`model:    ${model || '(unset)'}`);
note(`endpoint: ${endpoint}`);
note(`base:     ${base}`);
note('');
note('=== system prompt ===');
note(systemPrompt);
note('');
note('=== tools ===');
note(toolDefs.map(d => d.function.name).join(', '));

// --- the app's IDE API -----------------------------------------------------

async function ide(query, body) {
  const headers = {};
  if (ideToken) headers['X-Router-Token'] = ideToken;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${base}/ide/api.php${query}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach ${base} — start the app first (php serve.php): ${e.message}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* the status is the story */ }
  const text = (data && (data.detail || data.error)) || `HTTP ${res.status}`;
  return { ok: res.ok, status: res.status, data: data || {}, text };
}

const numbered = (text) => String(text).split(/\r\n|\r|\n/)
  .map((line, i) => `${i + 1}| ${line}`).join('\n');

/**
 * Every non-IDE drill's tools, run through the app's own registry.
 *
 * Only the IDE drill has a runner of its own (ide/api.php, the shared write
 * path). Everything else — fetch_url, write_file, read_file, show_url,
 * show_file, the window and browser tools — is TOOL_REGISTRY's own run() with
 * the same scope the chat hands it, so this runner cannot drift from what a live
 * agent executes. A tool reports a refusal as text, and that text is exactly
 * what the model would see, so `error:`/`denied:` is what makes a call a failure
 * here too.
 */
/**
 * A native call's arguments are an object, but most of the registry's tools take
 * ONE positional argument (`arg: 'url'`, `arg: 'path'`) and read it as a string:
 * fetch_url does String(arg), so an object handed straight in arrives as
 * "[object Object]" and the server reports `cannot resolve host object Object`.
 * The chat flattens a native call the same way, by the same declaration.
 */
function declaredKey(name) {
  const decl = TOOL_REGISTRY[name]?.arg;
  if (typeof decl !== 'string') return '';
  if (/^[a-z_][a-z0-9_]*$/i.test(decl)) return decl;
  // A display tool describes its shape as a one-key JSON template
  // (`show_url` is `{"url":"https://example.com/docs"}`) because it mirrors
  // another tool. Two or more keys (write_file) must stay an object.
  const one = /^\s*\{\s*"([a-z_][a-z0-9_]*)"\s*:[^,{}]*\}\s*$/.exec(decl);
  return one ? one[1] : '';
}

function toolArg(name, arg) {
  const decl = declaredKey(name);
  if (!decl) return arg;
  if (arg == null) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && !Array.isArray(arg)) {
    const first = arg[decl];
    if (typeof first === 'string' || typeof first === 'number') return String(first);
    // One wrapper deep: a model that sent {"url":{"url":"..."}} and meant it.
    if (first && typeof first === 'object' && typeof first[decl] === 'string') return first[decl];
  }
  return arg;
}

async function runSandboxTool(name, arg) {
  try {
    const out = await runTool(name, toolArg(name, arg), String((arg && (arg.note || arg.thought)) || ''), {
      agentId: agent.id,
      sessionId: 'drill_runner',
      sandboxRoot: sandboxRootFor(agent),
      toolScope: toolNames,
    });
    const text = String(out ?? '');
    return { status: /^(error|denied)\s*:/i.test(text.trim()) ? 'error' : 'ok', result: text || 'ok' };
  } catch (e) {
    return { status: 'error', result: `error: ${e.message}` };
  }
}

async function execute(name, arg) {
  if (name === 'think' || name === 'todo_write') return { status: 'ok', result: 'ok' };
  if (!IDE_TOOL_NAMES.includes(name)) return runSandboxTool(name, arg);
  const path = String((arg && arg.path) || '').trim();
  if (!path) return { status: 'error', result: `error: ${name} needs a "path"` };

  if (name === 'ide_open') {
    // There is no window on a terminal. The step grades the call, and the answer
    // must not claim something appeared that could not have.
    return { status: 'ok', result: `Opened ${path} in the IDE (headless run: no window to show it in)` };
  }

  if (name === 'ide_read') {
    const r = await ide(`?action=read&path=${encodeURIComponent(path)}`);
    if (!r.ok) return { status: 'error', result: r.text };
    const content = String(r.data.content ?? '');
    return { status: 'ok', result: content ? numbered(content) : `(${r.data.path || path} is empty)` };
  }

  if (name === 'ide_write') {
    if (typeof arg.content !== 'string') return { status: 'error', result: 'error: ide_write needs "content"' };
    const r = await ide('', { action: 'write', path, content: arg.content, actor: 'agent' });
    if (!r.ok) return { status: 'error', result: r.text };
    return { status: 'ok', result: `Wrote ${r.data.path} (${r.data.size} bytes, revision ${r.data.rev})` };
  }

  if (name === 'ide_edit') {
    const oldString = typeof arg.old_string === 'string' ? arg.old_string : '';
    if (!oldString) {
      return { status: 'error', result: 'error: ide_edit needs "old_string" \u2014 it is an exact match, never an append' };
    }
    const r = await ide('', {
      action: 'edit', path, old_string: oldString,
      new_string: typeof arg.new_string === 'string' ? arg.new_string : '',
      replace_all: arg.replace_all === true,
    });
    if (!r.ok) return { status: 'error', result: r.text };
    return { status: 'ok', result: `Edited ${r.data.path}: ${r.data.replaced} replacement(s), revision ${r.data.rev}` };
  }

  return { status: 'error', result: `error: unknown tool ${name}` };
}

// --- the loop --------------------------------------------------------------

const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: 'Begin the drill.' },
];
const calls = [];
const written = usesFile && file ? [file] : [];
// One row per COMPLETED pass, in the app's report terms: pass number, the file
// it actually wrote, clean or not, and the first thing it hit. A pass that never
// finished has no row, exactly like the Training summary — a scoreboard of
// zeroes for a run that stopped early would say less than nothing.
const passResults = [];
let verdict = drillVerdict(calls, matcher, mode);
let stopReason = '';
// How many passes THIS run has armed. `verdict.complete` describes the last
// completed pass, so once the counter moves it stays true until the model's
// first `think` opens the new one — a loop that read it alone re-entered here
// forever and grew the transcript until Node ran out of string.
let startedPasses = 1;

say(`drill: ${mode} \u00b7 ${tasks.length} steps \u00b7 agent ${agent.id} \u00b7 pass ${pass}`);
say(`target: ${target ? `${target} clean pass${target === 1 ? '' : 'es'}` : 'one pass'}`);
say(`file:  ${usesFile && file ? file : '(none)'}`);
say(`app:   ${base}${found.auto ? ' (found)' : ''}`);
say(`model: ${model || '(unset)'} via ${endpoint}`);
say('');

// A model that answers in prose twice in a row is not going to start calling
// tools on the twenty-fourth turn. Two chances, then stop — a terminal that
// prints "done" twenty-one times hides the one line that matters.
let textOnly = 0;
let turns = 0;
for (;;) {
  // A completed pass either ends the run (its clean-pass target is met, or no
  // target was asked for) or opens the next one on a fresh counter and file.
  if (verdict.complete && verdict.passes >= startedPasses) {
    passResults.push({
      pass: pass + startedPasses - 1,
      file,
      clean: !!verdict.clean,
      failures: Number(verdict.failures) || 0,
      step: verdict.failedAt || null,
      reason: String(verdict.failureReason || ''),
    });
    if (!target || verdict.cleanPasses >= target) {
      stopReason = target ? `clean-pass target ${target} reached` : 'one pass requested';
      break;
    }
    say('');
    say(`pass ${verdict.passes} complete — starting pass ${verdict.passes + 1}`);
    note('');
    note(`pass ${verdict.passes} complete; starting pass ${verdict.passes + 1}`);
    startedPasses++;
    beginPass(pass + startedPasses - 1);
    written.push(file);
    // The next pass reads a DIFFERENT block (its own file), and a transcript
    // that kept only the first one would describe a drill the model never saw.
    note(`=== pass ${startedPasses} · ${file} ===`);
    note(systemPrompt);
    messages.length = 0;
    messages.push({ role: 'system', content: systemPrompt }, { role: 'user', content: 'Begin the drill.' });
    turns = 0;
    textOnly = 0;
    continue;
  }
  if (turns >= maxTurns) {
    stopReason = `turn budget (${maxTurns} per pass)`;
    break;
  }
  turns++;
  const turn = turns;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, messages, tools: toolDefs, tool_choice: 'auto', temperature: 0, stream: false,
      }),
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (e) {
    die(e && e.name === 'TimeoutError'
      ? `the endpoint did not answer within ${requestTimeout / 1000}s (--timeout)`
      : `request failed: ${e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // A provider's error text can quote the key back, so only the status and
    // the error type are repeated here.
    die(`the endpoint answered HTTP ${res.status}${body?.error?.type ? ` (${body.error.type})` : ''}`);
  }

  const msg = body?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (!toolCalls.length) {
    say(`[turn ${turn}] text instead of a call:`);
    say('  ' + String(msg.content || '').trim().slice(0, 400).split('\n').join('\n  '));
    note('');
    note(`--- turn ${turn} ---`);
    note(`assistant (no tool call): ${String(msg.content || '').trim()}`);
    messages.push({ role: 'assistant', content: String(msg.content || '') });
    messages.push({ role: 'user', content: `Continue the drill at step ${verdict.step + 1}.` });
    if (++textOnly >= 2) {
      say('stopping: two turns without a tool call');
      stopReason = 'two turns without a tool call';
      break;
    }
    continue;
  }
  textOnly = 0;
  messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
  note('');
  note(`--- turn ${turn} ---`);
  note(`assistant: ${String(msg.content || '').trim() || '(no text)'}`);

  for (const tc of toolCalls) {
    const name = String(tc.function?.name || '');
    let arg = {};
    try { arg = JSON.parse(tc.function?.arguments || '{}'); } catch { arg = {}; }
    const { status, result } = await execute(name, arg);
    calls.push({ tool: name, arg, result, status });
    messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 4000) });
    verdict = drillVerdict(calls, matcher, mode);
    const mark = status === 'ok' ? 'ok  ' : 'FAIL';
    say(`  ${String(verdict.step)}/${tasks.length}  ${mark} ${name.padEnd(11)} ${String(result).split('\n')[0].slice(0, 90)}`);
    note(`call: ${name} ${JSON.stringify(arg)}`);
    note(`result [${status}]: ${result}`);
    note(`verdict: ${drillVerdictText(verdict)}`);
    if (verdict.complete) break;
  }
}

// The pass files are this run's artefact, not the operator's: remove them
// unless asked to keep them, through the app, so the revision log stays true.
if (keep) {
  note(`pass files kept: ${written.join(', ')}`);
} else {
  for (const p of written) {
    // Only the IDE has a delete on its own API. The sandbox drills' files are
    // left where the app leaves its own, and the transcript says which.
    const del = mode === 'ide' ? await ide('', { action: 'delete', path: p }).catch(() => null) : null;
    note(del && del.ok ? `pass file removed: ${p}` : `pass file left in place: ${p}`);
  }
}

say('');
say('-'.repeat(60));
say('verdict: ' + drillVerdictText(verdict));
say(`passes: ${verdict.passes} \u00b7 clean passes: ${verdict.cleanPasses}${target ? ` \u00b7 target: ${target}` : ''}`);
if (passResults.length > 1) {
  say('per pass:');
  for (const p of passResults) {
    const outcome = p.clean
      ? 'clean'
      : `${p.failures} failed${p.step ? ` at step ${p.step}` : ''}`
        + (p.reason ? ` \u2014 ${String(p.reason).split('\n')[0].slice(0, 80)}` : '');
    say(`  pass ${p.pass}  ${p.file}  ${outcome}`);
  }
}
if (verdict.failures && verdict.firstFailure) {
  say(`first failure (step ${verdict.firstFailure.step}): ${String(verdict.firstFailure.result).split('\n')[0]}`);
}
if (verdict.offStep) say(`off-step calls: ${verdict.offStep} (last: ${verdict.offTool})`);
if (stopReason) say(`stopped: ${stopReason}`);
if (!verdict.complete) say(`unfinished at step ${verdict.step + 1}`);
say(`calls recorded: ${calls.length} \u00b7 files ${keep || mode !== 'ide' ? 'kept' : 'removed'}`);
if (!transcriptOff) say(`transcript: ${transcriptPath}`);
const reached = target ? verdict.cleanPasses >= target : (verdict.complete && verdict.clean);
process.exit(reached ? 0 : 1);

