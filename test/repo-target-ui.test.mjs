// The login screen lets each pane name the repository maps are stored in, so
// a team can point everyone at one shared project. The value must reach
// CloudStore.login() by both sign-in paths (token and OAuth), which is why it
// is read from the pane by one helper rather than passed along by hand.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

describe('repository field on the login screen', () => {
  test('every forge pane has a repository input', () => {
    for (const id of ['ghRepo', 'giteaRepo', 'glRepo']) {
      assert.match(HTML, new RegExp(`<input[^>]*id="${id}"`), `index.html lacks #${id}`);
    }
  });

  test('repoTargetFor() reads the pane field and falls back to DEFAULT_REPO', () => {
    const fields = { '#ghRepo': '', '#glRepo': '  acme/maps ' };
    const $ = sel => (sel in fields ? { value: fields[sel] } : null);
    const fn = new Function('$', 'DEFAULT_REPO',
      `${extractFunction('repoTargetFor')}\n${extractFunction('repoFieldFor')}\nreturn repoTargetFor;`)($, 'mindspark-maps');
    assert.equal(fn('github'), 'mindspark-maps', 'empty field means the deployment default');
    assert.equal(fn('gitlab'), 'acme/maps', 'typed value wins, trimmed');
    assert.equal(fn('gitea'), 'mindspark-maps', 'a pane without the field still signs in');
  });

  test('completeCloudLogin hands the target to CloudStore.login', () => {
    const src = extractFunction('completeCloudLogin');
    assert.match(src, /CloudStore\.login\([^)]*repoTargetFor\(/);
  });
});

// The field is a setting, not the sign-in action, so it sits in a collapsed
// <details> and the card opens on the button. The two guards against a custom
// target being hidden by that: the summary always shows the current value,
// and the section opens itself when the value is not the default.
describe('repository field folds away by default', () => {
  test('each pane\'s input sits inside a <details class="login-repo"> that is closed in the markup', () => {
    for (const id of ['ghRepo', 'giteaRepo', 'glRepo']) {
      const at = HTML.indexOf(`id="${id}"`);
      const open = HTML.lastIndexOf('<details class="login-repo"', at);
      const close = HTML.indexOf('</details>', open);
      assert.ok(open !== -1 && close > at, `#${id} is not inside a login-repo details`);
      assert.doesNotMatch(HTML.slice(open, HTML.indexOf('>', open)), /\bopen\b/, `#${id}'s details must start collapsed`);
      assert.match(HTML.slice(open, at), /<summary>Configure repository <code class="repo-current">/, 'summary carries the current value');
    }
  });

  function harness(value) {
    const listeners = [];
    const cur = { textContent: '' };
    const det = { open: false, querySelector: sel => (sel === '.repo-current' ? cur : null) };
    const el = { value, closest: sel => (sel === 'details.login-repo' ? det : null), addEventListener: (t, fn) => listeners.push([t, fn]) };
    const sync = new Function('DEFAULT_REPO', `${extractFunction('syncRepoDetails')}\nreturn syncRepoDetails;`)('mindspark-maps');
    return { el, det, cur, listeners, sync };
  }

  test('the default target stays folded, with the value shown in the summary', () => {
    const h = harness('mindspark-maps');
    h.sync(h.el);
    assert.equal(h.det.open, false);
    assert.equal(h.cur.textContent, 'mindspark-maps');
  });

  test('an empty field reads as the default', () => {
    const h = harness('   ');
    h.sync(h.el);
    assert.equal(h.det.open, false);
    assert.equal(h.cur.textContent, 'mindspark-maps');
  });

  test('a custom target opens the section so it is never out of sight', () => {
    const h = harness('team/mindspark-maps');
    h.sync(h.el);
    assert.equal(h.det.open, true);
    assert.equal(h.cur.textContent, 'team/mindspark-maps');
  });

  test('typing updates the summary live, and the listener is attached once', () => {
    const h = harness('mindspark-maps');
    h.sync(h.el); h.sync(h.el);
    assert.equal(h.listeners.filter(([t]) => t === 'input').length, 1);
    h.el.value = 'acme/maps';
    h.listeners.find(([t]) => t === 'input')[1]();
    assert.equal(h.cur.textContent, 'acme/maps');
  });

  test('showLoginOverlay syncs every pane after prefilling', () => {
    const src = extractFunction('showLoginOverlay');
    assert.match(src, /syncRepoDetails\(el\)/);
  });
});
