// "Run with API" talks to the providers directly from the browser with the
// user's own key. A provider is data - label, URL, wire shape - built-ins in
// LLM_BUILTIN and the user's own in localStorage, so anyone can point the panel
// at Ollama, LM Studio, vLLM, Mistral, a gateway... from Preferences and carry
// the list in the preferences export. Keys stay per provider id and are never
// exported. Earlier bugs pinned here too: a retired default model kept being
// sent, max_tokens:1024 cut answers with no sign, and nothing read the
// provider's stop / finish reason.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const LLM_MAX_TOKENS = extractConst('LLM_MAX_TOKENS');
globalThis.LLM_MAX_TOKENS = LLM_MAX_TOKENS;   // the shape body() closures read it at call time
globalThis.location = { origin: 'https://app.example' };   // OpenRouter's extra headers read it at call time
const LLM_SHAPES = extractConst('LLM_SHAPES');
const LLM_BUILTIN = extractConst('LLM_BUILTIN');

function harness(stored = {}, csp = null) {
  const store = { ...stored };
  const localStorage = { getItem: k => (store === 'throw' ? (() => { throw new Error('blocked'); })() : (store[k] ?? null)), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
  const fns = loadFns(['llmProviders', 'loadLlmProviders', 'saveLlmProviders', 'validateLlmProviders', 'llmUrlOk', 'llmModelFor'], {
    LLM_SHAPES, LLM_BUILTIN, LLM_MAX_TOKENS,
    LLM_PROVIDERS_KEY: 'mindspark:llm:providers', LLM_ID_RE: extractConst('LLM_ID_RE'),
    localStorage, location: { origin: 'https://app.example' }, console,
  });
  return { ...fns, store };
}

describe('wire shapes', () => {
  test('openai: bearer auth only when there is a key; no output cap in the body; length = cut off', () => {
    const s = LLM_SHAPES.openai;
    assert.equal(s.headers('k').Authorization, 'Bearer k');
    assert.ok(!('Authorization' in s.headers('')), 'a keyless local server gets no auth header');
    const body = JSON.parse(s.body('m', 'hi'));
    assert.deepEqual(body, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(s.extract({ choices: [{ message: { content: ' c ' } }] }), 'c');
    assert.equal(s.truncated({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }), true);
    assert.equal(s.truncated({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }), false);
    assert.equal(s.truncated({}), false);
  });

  test('anthropic: x-api-key only when there is a key, max_tokens leaves room, stop_reason read', () => {
    const s = LLM_SHAPES.anthropic;
    assert.equal(s.headers('k')['x-api-key'], 'k');
    assert.ok(!('x-api-key' in s.headers('')));
    assert.equal(s.headers('k')['anthropic-version'], '2023-06-01');
    assert.ok(LLM_MAX_TOKENS >= 4096);
    assert.equal(JSON.parse(s.body('m', 'hi')).max_tokens, LLM_MAX_TOKENS);
    assert.equal(s.extract({ content: [{ type: 'text', text: ' a ' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }), 'a \nb');
    assert.equal(s.truncated({ stop_reason: 'max_tokens' }), true);
    assert.equal(s.truncated({ stop_reason: 'end_turn' }), false);
  });
});

describe('built-in providers', () => {
  test('the Anthropic default is a current model id, without a date suffix', () => {
    assert.equal(LLM_BUILTIN.find(p => p.id === 'anthropic').defaultModel, 'claude-opus-5');
  });

  test('every built-in names a known shape and an https URL', () => {
    for (const p of LLM_BUILTIN) {
      assert.ok(LLM_SHAPES[p.shape], p.id + ' shape');
      assert.match(p.url, /^https:\/\//, p.id + ' url');
    }
  });

  test('resolved providers carry the shape functions and any extra headers', () => {
    const { llmProviders } = harness();
    const P = llmProviders();
    assert.deepEqual(Object.keys(P), ['anthropic', 'openai', 'openrouter', 'groq']);
    assert.equal(P.openrouter.headers('k')['HTTP-Referer'], 'https://app.example');
    assert.equal(P.openrouter.headers('k').Authorization, 'Bearer k');
    for (const p of Object.values(P)) {
      assert.equal(p.custom, false);
      assert.equal(p.needsKey, true);
      for (const fn of ['headers', 'body', 'extract', 'truncated']) assert.equal(typeof p[fn], 'function', p.id + '.' + fn);
    }
  });
});

describe('custom providers', () => {
  test('a valid entry is kept, normalised, and resolved with its shape', () => {
    const h = harness({ 'mindspark:llm:providers': JSON.stringify([
      { id: 'Ollama', label: ' Ollama (laptop) ', url: 'http://localhost:11434/v1/chat/completions', shape: 'openai', defaultModel: 'llama3.1', needsKey: false },
    ]) });
    const P = h.llmProviders();
    assert.ok(P.ollama, 'id is lower-cased');
    assert.equal(P.ollama.label, 'Ollama (laptop)');
    assert.equal(P.ollama.custom, true);
    assert.equal(P.ollama.needsKey, false);
    assert.ok(!('Authorization' in P.ollama.headers('')));
    assert.equal(h.llmModelFor('ollama'), 'llama3.1');
  });

  test('a built-in id cannot be taken over by a file', () => {
    const h = harness({ 'mindspark:llm:providers': JSON.stringify([{ id: 'anthropic', url: 'https://evil.example/v1', shape: 'anthropic' }]) });
    assert.equal(h.llmProviders().anthropic.url, 'https://api.anthropic.com/v1/messages');
    assert.deepEqual(h.loadLlmProviders(), []);
  });

  test('bad ids, bad URLs, unknown shapes and junk are repaired or dropped', () => {
    const { validateLlmProviders } = harness();
    const got = validateLlmProviders([
      { id: 'ok', url: 'https://x.example/v1', shape: 'weird' },      // shape falls back to openai
      { id: 'bad id!', url: 'https://x.example/v1' },
      { id: 'nourl' },
      { id: 'ftp', url: 'ftp://x.example' },
      { id: 'dup', url: 'https://a.example' }, { id: 'dup', url: 'https://b.example' },
      'string', null, 42,
    ]);
    assert.deepEqual(got.map(p => [p.id, p.shape, p.url]), [['ok', 'openai', 'https://x.example/v1'], ['dup', 'openai', 'https://a.example']]);
    assert.deepEqual(validateLlmProviders('nope'), []);
    assert.deepEqual(validateLlmProviders({ id: 'x' }), []);
    assert.equal(validateLlmProviders(Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, url: 'https://x.example' }))).length, 20, 'capped');
  });

  test('http is allowed only for this machine and private networks', () => {
    const { llmUrlOk } = harness();
    for (const ok of ['https://api.mistral.ai/v1/chat/completions', 'http://localhost:11434/v1/chat/completions', 'http://127.0.0.1:1234/v1', 'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.16.0.2/v1', 'http://box.local:11434/v1']) {
      assert.equal(llmUrlOk(ok), true, ok);
    }
    for (const no of ['http://api.mistral.ai/v1', 'http://172.32.0.1/v1', 'ftp://x', 'not a url', 'javascript:alert(1)', '']) {
      assert.equal(llmUrlOk(no), false, no);
    }
  });

  test('save round-trips through the validator; load survives junk in storage', () => {
    const h = harness();
    assert.equal(h.saveLlmProviders([{ id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', shape: 'openai', defaultModel: 'mistral-large-latest' }, { id: 'nope' }]), true);
    assert.deepEqual(JSON.parse(h.store['mindspark:llm:providers']), [{ id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', shape: 'openai', defaultModel: 'mistral-large-latest', needsKey: true }]);
    h.store['mindspark:llm:providers'] = '{broken';
    assert.deepEqual(h.loadLlmProviders(), []);
    assert.deepEqual(Object.keys(h.llmProviders()), ['anthropic', 'openai', 'openrouter', 'groq'], 'built-ins are unaffected by junk');
  });
});

describe('llmModelFor - remembered model with retirement', () => {
  test('a remembered current model is used as-is', () => {
    assert.equal(harness({ 'mindspark:llm:model:anthropic': 'claude-sonnet-5' }).llmModelFor('anthropic'), 'claude-sonnet-5');
    assert.equal(harness({ 'mindspark:llm:model:openai': 'gpt-4.1' }).llmModelFor('openai'), 'gpt-4.1');
  });

  test('a remembered retired Anthropic model falls back to the default instead of being sent', () => {
    for (const old of ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-20250219', 'claude-3-haiku-20240307', 'claude-2.1', 'claude-instant-1.2']) {
      assert.equal(harness({ 'mindspark:llm:model:anthropic': old }).llmModelFor('anthropic'), 'claude-opus-5', old);
    }
  });

  test('nothing remembered, or an unknown provider, gives the default or nothing', () => {
    assert.equal(harness({}).llmModelFor('anthropic'), 'claude-opus-5');
    assert.equal(harness({}).llmModelFor('groq'), LLM_BUILTIN.find(p => p.id === 'groq').defaultModel);
    assert.equal(harness({}).llmModelFor('nope'), '');
  });
});
