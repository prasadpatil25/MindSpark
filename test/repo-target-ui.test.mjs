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
