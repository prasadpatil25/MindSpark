// "Run with API" talks to the providers directly from the browser with the
// user's own key. Three things went wrong quietly: the Anthropic default named
// a model that no longer exists at the API (and a remembered one kept being
// sent), max_tokens:1024 cut "Expand"/"Outline" answers mid-sentence with no
// sign the second half was missing, and nothing read the provider's own
// stop / finish reason. Pinned here against the real table and helper.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const LLM_MAX_TOKENS = extractConst('LLM_MAX_TOKENS');
globalThis.LLM_MAX_TOKENS = LLM_MAX_TOKENS;   // the body() closures read it at call time
const LLM_PROVIDERS = extractConst('LLM_PROVIDERS');

describe('LLM provider table', () => {
  test('the Anthropic default is a current model id, without a date suffix', () => {
    assert.equal(LLM_PROVIDERS.anthropic.defaultModel, 'claude-opus-5');
  });

  test('every request leaves room for a real answer', () => {
    assert.ok(LLM_MAX_TOKENS >= 4096, `${LLM_MAX_TOKENS} is too small for Expand/Outline on a normal branch`);
    const body = JSON.parse(LLM_PROVIDERS.anthropic.body('m', 'hi'));
    assert.equal(body.max_tokens, LLM_MAX_TOKENS);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  test('every provider can report a cut-off answer', () => {
    for (const [id, cfg] of Object.entries(LLM_PROVIDERS)) {
      assert.equal(typeof cfg.truncated, 'function', id + ' has no truncated()');
      assert.equal(cfg.truncated({}), false, id + ': empty response is not truncated');
    }
    assert.equal(LLM_PROVIDERS.anthropic.truncated({ stop_reason: 'max_tokens' }), true);
    assert.equal(LLM_PROVIDERS.anthropic.truncated({ stop_reason: 'end_turn' }), false);
    for (const id of ['openai', 'openrouter', 'groq']) {
      assert.equal(LLM_PROVIDERS[id].truncated({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }), true, id);
      assert.equal(LLM_PROVIDERS[id].truncated({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }), false, id);
    }
  });

  test('extract() still returns the text', () => {
    assert.equal(LLM_PROVIDERS.anthropic.extract({ content: [{ type: 'text', text: ' a ' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }), 'a \nb');
    assert.equal(LLM_PROVIDERS.openai.extract({ choices: [{ message: { content: ' c ' } }] }), 'c');
  });
});

describe('llmModelFor - remembered model with retirement', () => {
  const load = store => loadFns(['llmModelFor'], {
    LLM_PROVIDERS,
    localStorage: { getItem: k => { if (store === 'throw') throw new Error('blocked'); return store[k] ?? null; } },
  }).llmModelFor;

  test('a remembered current model is used as-is', () => {
    assert.equal(load({ 'mindspark:llm:model:anthropic': 'claude-sonnet-5' })('anthropic'), 'claude-sonnet-5');
    assert.equal(load({ 'mindspark:llm:model:openai': 'gpt-4.1' })('openai'), 'gpt-4.1');
  });

  test('a remembered retired Anthropic model falls back to the default instead of being sent', () => {
    for (const old of ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-20250219', 'claude-3-haiku-20240307', 'claude-2.1', 'claude-instant-1.2']) {
      assert.equal(load({ 'mindspark:llm:model:anthropic': old })('anthropic'), 'claude-opus-5', old);
    }
  });

  test('nothing remembered, or storage blocked, gives the default', () => {
    assert.equal(load({})('anthropic'), 'claude-opus-5');
    assert.equal(load('throw')('groq'), LLM_PROVIDERS.groq.defaultModel);
    assert.equal(load({})('nope'), '');
  });
});
