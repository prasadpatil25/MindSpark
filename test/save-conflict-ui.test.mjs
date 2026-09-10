// scheduleSave() retries a failed cloud save once, on the assumption that the
// failure was the network. A CONFLICT - the map was changed elsewhere - is not
// that: retrying would overwrite the other person's work four seconds later.
// So a conflict must be told apart, reported in its own words, and not retried.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/load-app-fns.mjs';

function harness({ saveImpl }) {
  const el = { savePill: { classList: { add() {}, remove() {} } }, saveText: { textContent: '' } };
  const $ = sel => ({ '#savePill': el.savePill, '#saveText': el.saveText })[sel];
  const timers = [];
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const clearTimeout = () => {};
  const toasts = [];
  const saves = [];
  const Store = { save: async m => { saves.push(m); return saveImpl(m); } };
  const map = { id: 'm1' };
  const fn = new Function('$', 'setTimeout', 'clearTimeout', 'toast', 'Store', 'MODE', 'forgeName', 'READONLY',
    `let map = arguments[8]; let saveTimer = null; let _pendingSaveMap = null; let scheduleCloudSave = () => {};
     ${extractFunction('scheduleSave')}
     return scheduleSave;`)($, setTimeout, clearTimeout, m => toasts.push(m), Store, 'cloud', () => 'GitLab', false, map);
  return { run: fn, timers, toasts, saves, el };
}

// Drain the fake timers: run whatever is queued, including timers queued by timers.
async function flush(timers) {
  while (timers.length) { const t = timers.shift(); await t.fn(); }
}

describe('scheduleSave and conflicts', () => {
  test('a network failure is retried once and reported as a sync hiccup', async () => {
    let n = 0;
    const h = harness({ saveImpl: async () => { if (++n === 1) throw new Error('HTTP 502'); } });
    h.run(); await flush(h.timers);
    assert.equal(h.saves.length, 2, 'one retry');
    assert.match(h.toasts[0], /saved on this device and will retry/);
    assert.equal(h.el.saveText.textContent, 'Saved');
  });

  test('a conflict is reported in its own words and NOT retried', async () => {
    const h = harness({ saveImpl: async () => { const e = new Error('This map was changed elsewhere - reload it to see those changes, or keep editing and your next save will overwrite them.'); e.conflict = true; throw e; } });
    h.run(); await flush(h.timers);
    assert.equal(h.saves.length, 1, 'a retry would overwrite the other person\'s save');
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /changed elsewhere/);
    assert.equal(h.el.saveText.textContent, 'Conflict');
  });
});
