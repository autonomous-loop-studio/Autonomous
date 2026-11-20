/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Tool-dialect memory: strictly per-agent syntax, no cross-agent fallback.
//
// Usage: node tests/js/dialectMemo.test.mjs
//
// The exact answer is per agent, so a copied agent's different tool set cannot
// overwrite it and one agent's success never rewrites another's starting
// dialect. The provider+model slot survives only for lookups without an
// agent. These assertions pin that, plus the two operators over it: the Labs
// switch and an explicitly pinned dialect.
//
// Harness / Dialect: strict per-agent memo plus its seven tuning switches.
// The `?v=` is read from store.js rather than written here, so a cache-buster
// bump cannot split the test from the modules under test.

import { readFileSync } from 'node:fs';
const version = /APP_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(new URL('../../ui/js/store.js', import.meta.url), 'utf8'),
)?.[1];
if (!version) {
  console.error('dialectMemo tests\n' + '-'.repeat(60));
  console.error('Cannot read APP_VERSION from ui/js/store.js.');
  process.exit(1);
}
const { store } = await import(`../../ui/js/store.js?v=${version}`);
const { learnedDialect, rememberDialect, forgetDialect, toolProtocolFor, memoProvenance,
  dialectNegMemoEnabled, dialectColdHintEnabled, dialectDurableSettings,
  dialectDrillGateEnabled, dialectCloneInheritEnabled, copyDialectMemo,
  coldStartHintFor, recordDialectFail, dialectFailCount, dialectTelemetryEnabled } =
  await import(`../../ui/js/harness.js?v=${version}`);
const { realSuccessOnlyEnabled } =
  await import(`../../ui/js/training.js?v=${version}`);
const { mergeLearnedSettings } = await import(`../../ui/js/utils.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('dialectMemo tests (strictly per agent)');
console.log('-'.repeat(60));

store.set('settings.toolDialectMap', {});
store.set('settings.toolDialectMemo', true);

const a = { id: 'agent-a', provider: 'openai', model: 'model-x' };
const b = { id: 'agent-b', provider: 'openai', model: 'model-x' };

// --- one success teaches one agent ------------------------------------------
eq(learnedDialect(a.provider, a.model, a.id), '', 'nothing learned for A yet');
rememberDialect(a.provider, a.model, 'plain', a.id);
eq(learnedDialect(a.provider, a.model, a.id), 'plain', 'A remembers the dialect its calls executed with');
eq(store.get('settings').toolDialectMap['agent-a::openai::model-x'], 'plain',
  'the memo is filed under the agent, provider and model');
ok(!('openai::model-x' in (store.get('settings').toolDialectMap || {})),
  'an agent write never creates the shared slot');
eq(learnedDialect(b.provider, b.model, b.id), '', 'B starts clean — no hand-me-down from A');
eq(toolProtocolFor(a), 'plain', 'A starts from its own memo');
eq(toolProtocolFor({ ...b }), 'json', 'B starts from the heuristic, not A');
rememberDialect(b.provider, b.model, 'native', b.id);
eq(toolProtocolFor(a), 'plain', 'A keeps its own dialect after B learns another');
eq(toolProtocolFor({ ...b }), 'native', 'B now starts from what B proved');
eq(learnedDialect('openai', 'model-x'), '', 'a lookup without an agent sees nothing yet');
rememberDialect('openai', 'model-x', 'plain');
eq(learnedDialect('openai', 'model-x'), 'plain', 'a write without an agent updates that slot');
eq(learnedDialect(a.provider, a.model, a.id), 'plain', 'the shared write leaves A alone');

// --- the model is part of the key, so a switch invalidates -------------------
const aOnY = { id: 'agent-a', provider: 'openai', model: 'model-y' };
eq(learnedDialect(aOnY.provider, aOnY.model, aOnY.id), '', 'a different model has no memo');
eq(toolProtocolFor(aOnY), 'json', 'the new model starts from the heuristic');
eq(toolProtocolFor(a), 'plain', 'switching back reuses what that model learned');

// --- operators still win -----------------------------------------------------
eq(toolProtocolFor({ ...a, toolProtocol: 'json' }), 'json',
  'a pinned dialect beats the memo');
rememberDialect(a.provider, a.model, 'made-up', a.id);
eq(learnedDialect(a.provider, a.model, a.id), 'plain', 'a dialect that does not exist is never stored');
store.set('settings.toolDialectMemo', false);
eq(learnedDialect(a.provider, a.model, a.id), '', 'switch off: the memo is not consulted');
rememberDialect(a.provider, a.model, 'json', a.id);
eq(learnedDialect(a.provider, a.model, a.id), '', 'switch off: nothing is written either');
store.set('settings.toolDialectMemo', true);
eq(learnedDialect(a.provider, a.model, a.id), 'plain', 'switch on again: the memo was kept intact');

// --- forget is per agent, and a sync cannot erase it -------------------------
rememberDialect('groq', 'model-z', 'plain', 'agent-c');
forgetDialect(a.provider, a.model, a.id);
eq(learnedDialect(a.provider, a.model, a.id), '', 'forget drops this agent\'s memo');
eq(learnedDialect(b.provider, b.model, b.id), 'native', 'forget leaves the other agent alone');
// Forgetting is not gated by the Labs switch: an operator who turned the memo
// off must still be able to clear what an earlier session learned.
store.set('settings.toolDialectMap', {
  ...(store.get('settings').toolDialectMap || {}),
  'agent-e::openai::model-x': 'native',
});
store.set('settings.toolDialectMemo', false);
eq(forgetDialect('openai', 'model-x', 'agent-e'), 'native',
  'forget returns the dialect it dropped');
ok(!('agent-e::openai::model-x' in (store.get('settings').toolDialectMap || {})),
  'and works while the memo is switched off');
eq(forgetDialect('openai', 'model-x', 'agent-e'), '',
  'forgetting a missing memo returns nothing');
store.set('settings.toolDialectMemo', true);
const merged = mergeLearnedSettings(store.get('settings'),
  { toolDialectMap: { 'agent-d::other::m': 'json' } });
eq(merged.toolDialectMap['agent-b::openai::model-x'], 'native',
  'a sync from an older device keeps what this one learned');
eq(merged.toolDialectMap['agent-c::groq::model-z'], 'plain', 'and keeps an agent outside the model pair');
eq(merged.toolDialectMap['agent-d::other::m'], 'json', 'while adopting what the other device learned');

// The Forget button's whole promise: the memo drives the next turn, and after
// forgetting the agent starts from the provider heuristic again.
{
  const c = { id: 'agent-f', provider: 'openai', model: 'model-x' };
  rememberDialect(c.provider, c.model, 'native', c.id);
  eq(toolProtocolFor(c), 'native', 'the memo is what the next turn starts from');
  eq(forgetDialect(c.provider, c.model, c.id), 'native', 'forget removes that memo');
  eq(toolProtocolFor(c), 'json', 'and the next turn falls back to the provider heuristic');
}

// Real-success only: off by default, so nothing gets stricter unasked.
eq(realSuccessOnlyEnabled({}), false, 'real-success only defaults to off');
eq(realSuccessOnlyEnabled({ realSuccessOnly: true }), true, 'the Training popup can switch it on');
eq(realSuccessOnlyEnabled({ realSuccessOnly: false }), false, 'and back off again');
eq(memoProvenance(a.provider, a.model, a.id), '', 'A has no memo here (it was forgotten above)');

// Harness / Dialect section defaults: safe helpers ON, strict gates OFF.
eq(dialectNegMemoEnabled(), true, 'negative memo defaults on');
eq(dialectColdHintEnabled(), true, 'cold-start hint defaults on');
eq(dialectDurableSettings().on, false, 'durable lock defaults off');
eq(dialectDrillGateEnabled(), false, 'drill-verdict gate defaults off');
eq(dialectCloneInheritEnabled(), false, 'clone inherit defaults off');
eq(dialectTelemetryEnabled(), true, 'telemetry defaults on');
store.set('settings.trainingRealSuccessOnly', true);
eq(realSuccessOnlyEnabled(), true, 'the Harness switch turns real-success only on');
store.set('settings.trainingRealSuccessOnly', false);
store.set('settings.trainingMode', { ...(store.get('settings.trainingMode') || {}), realSuccessOnly: true });
eq(realSuccessOnlyEnabled(), false, 'the Harness switch wins over the legacy Training key');
eq(realSuccessOnlyEnabled({ realSuccessOnly: true }), true, 'the legacy key still answers when passed directly');
store.set('settings.trainingMode', { ...(store.get('settings.trainingMode') || {}), realSuccessOnly: false });

// Negative memo: failures count, never teach, and can be switched off.
store.set('settings.dialectNegMemo', true);
store.set('settings.toolDialectNegMap', {});
store.set('settings.dialectMemoFails', {});
eq(dialectFailCount('openai', 'model-x', 'native', 'agent-neg'), 0, 'no failures counted yet');
recordDialectFail('openai', 'model-x', 'native', 'agent-neg');
eq(dialectFailCount('openai', 'model-x', 'native', 'agent-neg'), 1, 'one parse failure is counted');
eq(learnedDialect('openai', 'model-x', 'agent-neg'), '', 'a failure never writes a memo');
store.set('settings.dialectNegMemo', false);
recordDialectFail('openai', 'model-x', 'native', 'agent-neg');
eq(dialectFailCount('openai', 'model-x', 'native', 'agent-neg'), 0, 'switch off: the count reads as unused');
eq((store.get('settings').toolDialectNegMap || {})['agent-neg::openai::model-x::native'], 1, 'and the stored count is left untouched');
store.set('settings.dialectNegMemo', true);

// Cold-start hint: suggest, never apply (fresh model pair, so no agent has a memo yet).
store.set('settings.dialectColdHint', true);
rememberDialect('openai', 'model-cold', 'native', 'agent-cold-a');
eq(coldStartHintFor('openai', 'model-cold', 'agent-cold-b'), 'native', 'B is told what A proved');
eq(learnedDialect('openai', 'model-cold', 'agent-cold-b'), '', 'but B still starts with no memo of its own');
eq(toolProtocolFor({ id: 'agent-cold-b', provider: 'openai', model: 'model-cold' }), 'json', 'and the hint never changes the heuristic');
store.set('settings.dialectColdHint', false);
eq(coldStartHintFor('openai', 'model-cold', 'agent-cold-b'), '', 'switch off: no hint is offered');
store.set('settings.dialectColdHint', true);
forgetDialect('openai', 'model-cold', 'agent-cold-a');

// Durable lock: OFF means one ok still locks (today's behaviour).
store.set('settings.dialectDurable', { on: false, need: 2, evict: 3 });
store.set('settings.dialectMemoStreaks', {});
rememberDialect('openai', 'model-x', 'plain', 'agent-dur');
eq(learnedDialect('openai', 'model-x', 'agent-dur'), 'plain', 'durable off: a single ok locks');
forgetDialect('openai', 'model-x', 'agent-dur');
// Durable ON: the same dialect must repeat before it sticks.
store.set('settings.dialectDurable', { on: true, need: 2, evict: 3 });
rememberDialect('openai', 'model-x', 'plain', 'agent-dur');
eq(learnedDialect('openai', 'model-x', 'agent-dur'), '', 'durable on: the first ok only streaks');
rememberDialect('openai', 'model-x', 'plain', 'agent-dur');
eq(learnedDialect('openai', 'model-x', 'agent-dur'), 'plain', 'the repeat locks it');
forgetDialect('openai', 'model-x', 'agent-dur');
store.set('settings.dialectDurable', { on: false, need: 2, evict: 3 });
store.set('settings.dialectMemoStreaks', {});

// Clone inherit: OFF means a copy starts clean (today's behaviour).
store.set('settings.dialectCloneInherit', false);
rememberDialect('openai', 'model-x', 'native', 'agent-src');
eq(copyDialectMemo('agent-src', 'agent-dst'), 0, 'clone off: nothing is copied');
eq(learnedDialect('openai', 'model-x', 'agent-dst'), '', 'the copy starts clean');
store.set('settings.dialectCloneInherit', true);
// Clean the destination first so the copy has somewhere to land.
forgetDialect('openai', 'model-x', 'agent-dst');
ok(copyDialectMemo('agent-src', 'agent-dst') >= 1, 'clone on: the memo is copied');
eq(learnedDialect('openai', 'model-x', 'agent-dst'), 'native', 'and the copy starts from it');
store.set('settings.dialectCloneInherit', false);
forgetDialect('openai', 'model-x', 'agent-src');
forgetDialect('openai', 'model-x', 'agent-dst');

for (const line of errors) console.log(line);
console.log(`dialectMemo: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
