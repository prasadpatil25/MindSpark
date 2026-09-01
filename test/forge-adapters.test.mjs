// CloudStore stores maps as files in a git repo over the forge's REST API.
// Gitea mirrors GitHub's contents API and Forgejo is a Gitea fork, so one
// descriptor serves both - which is exactly why this needs guarding: the
// adapters look interchangeable, so a GitHub-shaped assumption can leak back
// into shared code and still appear to work until a Gitea user hits it.
//
// Two invariants matter here:
//   1. The FORGES descriptors keep the contract CloudStore relies on.
//   2. CloudStore itself contains NO hardcoded forge URL - the moment one
//      reappears, every non-GitHub user silently talks to api.github.com.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const FORGES = extractConst('FORGES');

/** The slice of app.js between `const CloudStore = {` and `let Store;`. */
function cloudStoreSource() {
  const start = APP.indexOf('const CloudStore = {');
  const end = APP.indexOf('\nlet Store;', start);
  assert.ok(start !== -1 && end > start, 'CloudStore block not found in app.js');
  return APP.slice(start, end);
}

describe('forge adapters', () => {
  test('every forge satisfies the contract CloudStore calls', () => {
    assert.deepEqual(Object.keys(FORGES).sort(), ['gitea', 'github']);
    for (const [key, f] of Object.entries(FORGES)) {
      assert.equal(f.id, key, `${key}.id must match its registry key`);
      assert.equal(typeof f.label, 'string');
      assert.equal(typeof f.selfHosted, 'boolean');
      for (const fn of ['apiBase', 'webBase', 'headers', 'canCreateRepo', 'newRepoUrl', 'newTokenUrl']) {
        assert.equal(typeof f[fn], 'function', `${key}.${fn} must be a function`);
      }
      assert.equal(typeof f.createRepoPath, 'string');
      assert.ok(['PUT','POST'].includes(f.createFileMethod), `${key}.createFileMethod`);
      // Sending GitHub's `per_page` to Gitea (or vice versa) is ignored rather
      // than rejected - you just silently get the default page size.
      assert.ok(['per_page', 'limit'].includes(f.commitsLimitParam), `${key}.commitsLimitParam`);
      // The token must arrive as `token <t>` for both; Bearer is not accepted
      // by Gitea's API for personal access tokens.
      assert.match(f.headers('T').Authorization, /^token T$/, `${key} auth header`);
    }
  });

  test('GitHub behaviour is unchanged by the multi-forge split', () => {
    const gh = FORGES.github;
    assert.equal(gh.selfHosted, false);
    assert.equal(gh.apiBase(), 'https://api.github.com');
    assert.equal(gh.apiBase('https://ignored.example'), 'https://api.github.com',
      'GitHub must ignore an instance URL - there is only one github.com');
    assert.equal(gh.commitsLimitParam, 'per_page');
    assert.equal(gh.headers('T')['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(gh.headers('T').Accept, 'application/vnd.github+json');
    // Fine-grained tokens cannot create a repo; classic ones can. This drives
    // which error _ensureRepo() shows, so it must not silently invert.
    assert.equal(gh.canCreateRepo('github_pat_11ABC'), false);
    assert.equal(gh.canCreateRepo('ghp_classic'), true);
    // GitHub's PUT both creates and updates - sha optional.
    assert.equal(gh.createFileMethod, 'PUT');
  });

  test('Gitea/Forgejo builds v1 API URLs from a user-supplied instance', () => {
    const g = FORGES.gitea;
    assert.equal(g.selfHosted, true);
    assert.equal(g.apiBase('https://codeberg.org'), 'https://codeberg.org/api/v1');
    // A pasted URL with a trailing slash is the common case and must not
    // produce a double slash, which some reverse proxies 404.
    assert.equal(g.apiBase('https://codeberg.org/'), 'https://codeberg.org/api/v1');
    assert.equal(g.apiBase('https://git.example.com///'), 'https://git.example.com/api/v1');
    assert.equal(g.commitsLimitParam, 'limit');
    assert.equal(g.newTokenUrl('https://codeberg.org/'), 'https://codeberg.org/user/settings/applications');
    assert.equal(g.newRepoUrl('https://codeberg.org'), 'https://codeberg.org/repo/create');
    // Gitea tokens carry write:repository, which does allow repo creation -
    // so Gitea users get the one-step flow GitHub can't offer.
    assert.equal(g.canCreateRepo('anything'), true);
    assert.equal(g.headers('T')['X-GitHub-Api-Version'], undefined,
      'GitHub-only headers must not be sent to a third-party instance');
    // Forgejo's swagger: POST = repoCreateFile (required: [content]),
    // PUT = repoUpdateFile (required: [sha, content]). A sha-less PUT is a 422,
    // so reusing GitHub's single-method write breaks EVERY first save - the new
    // map, and the very first _index.json. This shipped once; hence the test.
    assert.equal(g.createFileMethod, 'POST');
  });

  test('CloudStore hardcodes no forge URL', () => {
    const src = cloudStoreSource();
    assert.ok(!/api\.github\.com/.test(src),
      'CloudStore must reach the API through this._apiBase(), not a literal GitHub URL');
    // Narrowed to request targets on purpose: an example URL inside a
    // user-facing error message ("e.g. https://codeberg.org") is fine, a forge
    // origin inside a fetch() is the bug this guards.
    assert.ok(!/fetch\([^)]*https:\/\/(github|codeberg|gitea)\.(com|org)/.test(src),
      'CloudStore must not fetch a hardcoded forge origin');
    // The paginated commits call is the one query param that differs.
    assert.ok(/\$\{this\.forge\.commitsLimitParam\}=50/.test(src),
      'history() must use the per-forge commit pagination param');
    assert.ok(!/per_page=50/.test(src), 'per_page is GitHub-only and must not be hardcoded');
  });

  test('writes pick the create method from the forge, and never send a sha with it', () => {
    const src = cloudStoreSource();
    const write = src.slice(src.indexOf('async _writeFile'), src.indexOf('async _deleteFile'));
    assert.match(write, /this\.forge\.createFileMethod/,
      '_writeFile must take the create method from the forge descriptor');
    // The create branch must be reached only when we have no sha, and must not
    // carry one: CreateFileOptions has no such property and Forgejo 422s.
    assert.match(write, /sha\s*\?\s*await send\('PUT',\s*\{sha\}\)\s*:\s*await send\(this\.forge\.createFileMethod,\s*\{\}\)/,
      'create must be the sha-less branch and update the sha-carrying one');
    // Both directions of a stale belief have to recover: a 404 means our
    // "update" is really a create, a 409/422 means our "create" is really an update.
    assert.match(write, /r\.status===409 \|\| r\.status===422 \|\| r\.status===404/,
      '_writeFile must recover from both a missing file and a conflicting one');
  });

  test('no forge-specific branching leaked into the shared storage paths', () => {
    // Auth and repo-creation legitimately differ per forge. Everything below
    // them - index reconciliation, tombstones, orphan recovery - is the code
    // that loses maps if it grows an untested per-forge branch.
    const src = cloudStoreSource();
    const shared = src.slice(src.indexOf('async _fetchIndexRaw'));
    assert.ok(!/forge\.id\s*===/.test(shared),
      'the shared storage paths must stay provider-agnostic; put the difference in FORGES');
  });

  test('every fixed-origin forge is reachable under the CSP', () => {
    const meta = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
      .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(meta, 'index.html has no CSP meta tag');
    const connect = meta[1].match(/connect-src ([^;]+)/)[1].trim().split(/\s+/);

    for (const f of Object.values(FORGES)) {
      if (f.selfHosted) continue;
      const origin = new URL(f.apiBase()).origin;
      assert.ok(connect.includes(origin), `${f.id} calls ${origin} but it is not in connect-src`);
    }
    // The instances the login screen tells people work out of the box must
    // actually work out of the box.
    const suggested = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
      .match(/<datalist id="giteaSuggest">([\s\S]*?)<\/datalist>/);
    assert.ok(suggested, 'the Gitea instance suggestions are gone from index.html');
    for (const m of suggested[1].matchAll(/value="(https:\/\/[^"]+)"/g)) {
      assert.ok(connect.includes(new URL(m[1]).origin),
        `${m[1]} is offered as a ready-to-use instance but is not in connect-src`);
    }
  });
});
