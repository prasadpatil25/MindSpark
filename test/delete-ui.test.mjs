// Deleting a map is a write to the forge like any other, and can fail like any
// other (session expired, instance down). The store keeps the map listed until
// the forge has agreed; the menu that triggered it must not say "deleted" over
// a failure it never looked at.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/load-app-fns.mjs';

describe('the row menu delete', () => {
  test('a delete that fails is reported, not announced as done', () => {
    const src = extractFunction('openRowMenu');
    const del = src.slice(src.indexOf('[data-a="del"]'));
    assert.match(del, /try\s*\{[^}]*await Store\.remove\(m\.id\)/, 'the removal is guarded');
    assert.match(del, /catch\s*\(e\)\s*\{[^}]*toast\(/, 'and its failure is shown');
    const done = del.indexOf("toast('Map deleted')"), tried = del.indexOf('await Store.remove(m.id)');
    assert.ok(tried !== -1 && done > tried, '"Map deleted" only after the store agreed');
  });
});
