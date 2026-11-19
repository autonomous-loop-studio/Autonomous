/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Tool-dialect memory: the agent's own syntax, with a provider+model fallback.
//
// Usage: node tests/js/dialectMemo.test.mjs
//
// The exact answer is per agent, so a copied agent's different tool set cannot
// overwrite it. But a per-agent key alone made a new agent on a model that had
// already executed a syntax start from the heuristic and repeat the same failed
// envelope. The provider+model slot is the harness-wide memory; the agent slot
// wins when it exists. These assertions pin that, plus the two operators over
// it: the Labs switch and an explicitly pinned dialect.
//
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
const { learnedDialect, rememberDialect, forgetDialect, toolProtocolFor } =
  await import(`../../ui/js/harness.js?v=${version}`);
const { mergeLearnedSettings } = await import(`../../ui/js/utils.js?v=${version}`);

let pass = 0, fail = 0;
const errors = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; errors.push('FAIL: ' + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('dialectMemo tests (agent + provider fallback)');
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
eq(store.get('settings').toolDialectMap['openai::model-x'], 'plain',
  'and the provider+model slot carries the harness-wide memory');
eq(learnedDialect(b.provider, b.model, b.id), 'plain', 'B inherits a working syntax from the provider slot');
eq(toolProtocolFor(a), 'plain', 'A starts from its own memo');
eq(toolProtocolFor({ ...b }), 'plain', 'B starts from the provider fallback, not the heuristic');
rememberDialect(b.provider, b.model, 'native', b.id);
eq(toolProtocolFor(a), 'plain', 'A keeps its own dialect after B learns another');
eq(toolProtocolFor({ ...b }), 'native', 'B now starts from what B proved');

// A lookup without an agent uses the harness-wide provider slot.
eq(learnedDialect('openai', 'model-x'), 'native', 'a lookup without an agent sees the provider memo');
rememberDialect('openai', 'model-x', 'plain');
eq(learnedDialect('openai', 'model-x'), 'plain', 'a write without an agent updates that slot');

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

for (const line of errors) console.log(line);
console.log(`dialectMemo: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
