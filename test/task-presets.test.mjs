// Task presets are the instruction chips in Build Prompt. The built-in five
// are code; the user's own are stored as {label, task} so the chip shows a
// name rather than the first 24 characters of the instruction, and so the
// preferences export reads as a list of named presets. Earlier builds stored
// bare strings; those still load with the derived label they always had.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

function harness(stored) {
  const store = { ...stored };
  const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
  return { store, ...loadFns(['bpNormalizePrompts', 'bpPresetLabel', 'bpLoadPrompts', 'bpSavePrompts'], {
    BP_PROMPTS_KEY: 'mindspark:llm:prompts', BP_PRESET_LIMIT: extractConst('BP_PRESET_LIMIT'), localStorage, console,
  }) };
}
const LONG = 'Translate the following branch into Hindi, keeping the structure:';

describe('bpNormalizePrompts', () => {
  test('legacy strings become named presets with the label the chip always showed', () => {
    const { bpNormalizePrompts, bpPresetLabel } = harness({});
    assert.deepEqual(bpNormalizePrompts([LONG, 'Short one']), [{ label: bpPresetLabel(LONG), task: LONG }, { label: 'Short one', task: 'Short one' }]);
    assert.equal(bpPresetLabel(LONG), LONG.slice(0, 24) + '…');
  });

  test('objects keep their label; a missing label is derived; junk is dropped; texts are capped', () => {
    const { bpNormalizePrompts } = harness({});
    const got = bpNormalizePrompts([
      { label: '  Translate ', task: ' ' + LONG + ' ' },
      { task: 'No label here' },
      { label: 'Empty task', task: '   ' },
      { label: 'x'.repeat(80), task: 'y'.repeat(500) },
      null, 42, 'a', ['nope'], { label: 'only label' },
    ]);
    assert.deepEqual(got.map(p => [p.label, p.task.length]), [['Translate', LONG.length], ['No label here', 13], ['x'.repeat(40), 400], ['a', 1]]);
  });

  test('duplicates (by instruction) collapse and the list is capped at the limit', () => {
    const { bpNormalizePrompts } = harness({});
    assert.equal(bpNormalizePrompts(['same', { label: 'Same again', task: 'same' }]).length, 1);
    assert.equal(bpNormalizePrompts(Array.from({ length: 30 }, (_, i) => 'task ' + i)).length, extractConst('BP_PRESET_LIMIT'));
    assert.deepEqual(bpNormalizePrompts('nope'), []);
    assert.deepEqual(bpNormalizePrompts({ task: 'x' }), []);
  });
});

describe('load / save', () => {
  test('save normalises; load survives junk in storage; a legacy store reads as named presets', () => {
    const h = harness({ 'mindspark:llm:prompts': JSON.stringify(['Legacy instruction text']) });
    assert.deepEqual(h.bpLoadPrompts(), [{ label: 'Legacy instruction text', task: 'Legacy instruction text' }]);
    assert.equal(h.bpSavePrompts([{ label: 'A', task: 'do a' }, 'do b']), true);
    assert.deepEqual(JSON.parse(h.store['mindspark:llm:prompts']), [{ label: 'A', task: 'do a' }, { label: 'do b', task: 'do b' }]);
    h.store['mindspark:llm:prompts'] = '{broken';
    assert.deepEqual(h.bpLoadPrompts(), []);
  });
});
