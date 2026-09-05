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
    assert.deepEqual(Object.keys(FORGES).sort(), ['gitea', 'github', 'gitlab']);
    for (const [key, f] of Object.entries(FORGES)) {
      assert.equal(f.id, key, `${key}.id must match its registry key`);
      assert.equal(typeof f.label, 'string');
      assert.equal(typeof f.selfHosted, 'boolean');
      for (const fn of ['apiBase', 'webBase', 'headers', 'canCreateRepo', 'newRepoUrl', 'newTokenUrl']) {
        assert.equal(typeof f[fn], 'function', `${key}.${fn} must be a function`);
      }
      // Every URL and every response shape CloudStore needs now comes from
      // here. A forge missing one of these fails at load rather than at the
      // first save on someone else's account.
      for (const fn of ['repoUrl', 'createRepoBody', 'contentsUrl', 'writeUrl', 'treeUrl', 'treeFiles',
                        'commitsUrl', 'parseCommits', 'normalizeUser', 'defaultBranch', 'writeBody',
                        'deleteBody', 'readVersion', 'writeVersion', 'isInlined', 'blobSources']) {
        assert.equal(typeof f[fn], 'function', `${key}.${fn} must be a function`);
      }
      assert.equal(typeof f.createScopeHint, 'string');
      assert.equal(typeof f.repoAccessHint, 'string');
      assert.equal(typeof f.createRepoPath, 'string');
      assert.ok(['PUT','POST'].includes(f.createFileMethod), `${key}.createFileMethod`);
      // Sending GitHub's `per_page` to Gitea (or vice versa) is ignored rather
      // than rejected - you just silently get the default page size.
      assert.ok(['per_page', 'limit'].includes(f.commitsLimitParam), `${key}.commitsLimitParam`);
      // The scheme is per-forge and getting it wrong is a flat 401: Gitea's API
      // does not accept Bearer for a PAT, and GitLab does not accept `token`
      // at all. So this asserts a valid scheme, and each forge's own test pins
      // which one it is.
      assert.match(f.headers('T').Authorization, /^(token|Bearer) T$/, `${key} auth header`);
      // A branch is either named on every call or on none; a forge that returns
      // one only sometimes would build a URL with `undefined` in it.
      const branch = f.defaultBranch({ default_branch: 'trunk' });
      assert.ok(branch === null || typeof branch === 'string', `${key}.defaultBranch`);
      assert.equal(f.defaultBranch(null), branch === null ? null : f.defaultBranch(null),
        `${key}.defaultBranch must still answer when the repo response is unreadable`);
      if (branch !== null) assert.ok(f.defaultBranch(null), `${key} must fall back to a real branch name`);
    }
  });

  test('every forge normalises identity to the same {id, login} shape', () => {
    // CloudStore._ref() builds repo URLs from user.login and the account pill
    // renders login + avatar_url, so a forge that answers a different field
    // name has to translate HERE - not leave `undefined` in a URL path.
    for (const [key, f] of Object.entries(FORGES)) {
      const me = f.normalizeUser(f.id === 'gitlab'
        ? { id: 7, username: 'ada', avatar_url: 'https://x/a.png' }
        : { id: 7, login: 'ada', avatar_url: 'https://x/a.png' });
      assert.deepEqual(me, { id: 7, login: 'ada', avatar_url: 'https://x/a.png' }, `${key}.normalizeUser`);
      // "Authenticated, but nobody we can name" must be null, not a partial
      // object - _verify turns exactly that into a readable error.
      assert.equal(f.normalizeUser({ id: 7 }), null, `${key}.normalizeUser without a name`);
      assert.equal(f.normalizeUser(null), null, `${key}.normalizeUser(null)`);
    }
  });

  test('a create never carries a version token', () => {
    // _writeFile decides create-vs-update by whether it holds a version token
    // and passes it straight to writeBody. Forgejo's CreateFileOptions has no
    // sha property and 422s if one appears, so no create body may grow one.
    //
    // What an UPDATE does with that token is deliberately NOT asserted here:
    // GitHub and Gitea send it back as an optimistic-concurrency check, and a
    // forge that identifies the target by method and path alone is entitled to
    // drop it. That belongs in each forge's own test, not in a shared loop.
    const r = { api: 'https://api.example', owner: 'ada', repo: 'mindspark-maps', branch: 'main' };
    for (const [key, f] of Object.entries(FORGES)) {
      const create = f.writeBody(r, 'maps/a.json', 'BASE64', undefined);
      assert.equal('sha' in create, false, `${key}.writeBody must omit sha when creating`);
      assert.equal(create.content, 'BASE64', `${key}.writeBody content`);
    }
  });

  test('GitHub behaviour is unchanged by the multi-forge split', () => {
    const gh = FORGES.github;
    assert.equal(gh.selfHosted, false);
    assert.equal(gh.apiBase(), 'https://api.github.com');
    assert.equal(gh.apiBase('https://ignored.example'), 'https://api.github.com',
      'GitHub must ignore an instance URL - there is only one github.com');
    assert.equal(gh.commitsLimitParam, 'per_page');
    assert.match(gh.headers('T').Authorization, /^token T$/);
    assert.equal(gh.headers('T')['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(gh.headers('T').Accept, 'application/vnd.github+json');
    // Fine-grained tokens cannot create a repo; classic ones can. This drives
    // which error _ensureRepo() shows, so it must not silently invert.
    assert.equal(gh.canCreateRepo('github_pat_11ABC'), false);
    assert.equal(gh.canCreateRepo('ghp_classic'), true);
    // GitHub's PUT both creates and updates - sha optional.
    assert.equal(gh.createFileMethod, 'PUT');
    // The URLs CloudStore used to build inline, pinned where they now live.
    const r = { api: 'https://api.github.com', owner: 'ada', repo: 'mindspark-maps', branch: null };
    assert.equal(gh.repoUrl(r), 'https://api.github.com/repos/ada/mindspark-maps');
    assert.equal(gh.contentsUrl(r, '_index.json'),
      'https://api.github.com/repos/ada/mindspark-maps/contents/_index.json');
    assert.equal(gh.contentsUrl(r, 'maps/x.json', 'abc123'),
      'https://api.github.com/repos/ada/mindspark-maps/contents/maps/x.json?ref=abc123');
    assert.equal(gh.commitsUrl(r, 'maps/x.json', 50),
      'https://api.github.com/repos/ada/mindspark-maps/commits?path=maps/x.json&per_page=50');
    assert.equal(gh.readVersion({ sha: 'S' }), 'S');
    assert.equal(gh.writeVersion({ content: { sha: 'S' } }), 'S');
    // GitHub round-trips the version token as an optimistic-concurrency check.
    assert.equal(gh.writeBody(r, 'maps/x.json', 'B', 'V1').sha, 'V1');
    // >1 MB comes back with empty content and encoding "none" - reading that as
    // if it were inlined yields an empty map, which is how it once presented.
    assert.equal(gh.isInlined({ content: '', encoding: 'none' }), false);
    assert.equal(gh.isInlined({ content: 'eyJ9', encoding: 'base64' }), true);
    assert.deepEqual(gh.treeFiles([{ type: 'file', name: 'a.json' }, { type: 'dir', name: 'sub' }]), ['a.json']);
    assert.deepEqual(
      gh.parseCommits([{ sha: 'C1', commit: { author: { date: '2024-01-01T00:00:00Z' }, message: 'm' } }]),
      [{ ref: 'C1', ts: Date.parse('2024-01-01T00:00:00Z'), message: 'm' }]);
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
    const r = { api: 'https://codeberg.org/api/v1', owner: 'ada', repo: 'mindspark-maps', branch: null };
    assert.equal(g.contentsUrl(r, 'maps/x.json'),
      'https://codeberg.org/api/v1/repos/ada/mindspark-maps/contents/maps/x.json');
    assert.equal(g.commitsUrl(r, 'maps/x.json', 50),
      'https://codeberg.org/api/v1/repos/ada/mindspark-maps/commits?path=maps/x.json&limit=50');
    // PUT is repoUpdateFile and REQUIRES the sha - dropping it is a 422.
    assert.equal(g.writeBody(r, 'maps/x.json', 'B', 'V1').sha, 'V1');
    assert.match(g.headers('T').Authorization, /^token T$/,
      'Gitea rejects Bearer for a personal access token');
  });

  test('GitLab addresses projects and files nothing like the other two', () => {
    const gl = FORGES.gitlab;
    assert.equal(gl.selfHosted, true);
    assert.equal(gl.apiBase('https://gitlab.com/'), 'https://gitlab.com/api/v4');
    // Bearer is the only scheme that covers a PAT and an OAuth token alike.
    assert.match(gl.headers('T').Authorization, /^Bearer T$/);
    assert.equal(gl.headers('T')['X-GitHub-Api-Version'], undefined);

    const r = { api: 'https://gitlab.com/api/v4', owner: 'ada', repo: 'mindspark-maps', branch: 'main' };
    // The project is ONE URL-encoded path segment, not owner/repo segments.
    assert.equal(gl.repoUrl(r), 'https://gitlab.com/api/v4/projects/ada%2Fmindspark-maps');
    // The file path is a path parameter, so its own slash is encoded too, and
    // ref is mandatory - a bare files URL is an error, not the default branch.
    assert.equal(gl.contentsUrl(r, 'maps/x.json'),
      'https://gitlab.com/api/v4/projects/ada%2Fmindspark-maps/repository/files/maps%2Fx.json?ref=main');
    assert.equal(gl.contentsUrl(r, 'maps/x.json', 'abc123'),
      'https://gitlab.com/api/v4/projects/ada%2Fmindspark-maps/repository/files/maps%2Fx.json?ref=abc123');
    // Writes name the branch in the body, so the write URL carries no ref.
    assert.equal(gl.writeUrl(r, 'maps/x.json'),
      'https://gitlab.com/api/v4/projects/ada%2Fmindspark-maps/repository/files/maps%2Fx.json');
    // Listing is a different endpoint entirely - not the file endpoint.
    assert.ok(gl.treeUrl(r, 'maps').includes('/repository/tree?path=maps&ref=main'));
    assert.ok(gl.commitsUrl(r, 'maps/x.json', 50).includes('per_page=50'));
    assert.ok(gl.commitsUrl(r, 'maps/x.json', 50).includes('ref_name=main'));

    // `blob`, not `file`; a `tree` is a subdirectory.
    assert.deepEqual(gl.treeFiles([{ type: 'blob', name: 'a.json' }, { type: 'tree', name: 'sub' }]), ['a.json']);
    assert.deepEqual(gl.parseCommits([{ id: 'C1', created_at: '2024-01-01T00:00:00Z', title: 't', message: 'm' }]),
      [{ ref: 'C1', ts: Date.parse('2024-01-01T00:00:00Z'), message: 'm' }]);
    // `username`, not `login` - and never `name`, which is not unique and would
    // land in the project path.
    assert.deepEqual(gl.normalizeUser({ id: 3, username: 'ada', name: 'Ada L', avatar_url: 'a' }),
      { id: 3, login: 'ada', avatar_url: 'a' });

    // Writes must declare base64 - the default is text, which mangles any
    // non-ASCII map - and must carry the branch, which is not optional.
    const w = gl.writeBody(r, 'maps/x.json', 'B64', 'V1');
    assert.equal(w.encoding, 'base64');
    assert.equal(w.branch, 'main');
    assert.equal(w.content, 'B64');
    assert.equal(w.commit_message, 'MindSpark: update maps/x.json');
    assert.equal(gl.deleteBody(r, 'maps/x.json', 'V1').branch, 'main');

    // A successful write answers only {file_path, branch} - there is no sha to
    // thread onward - so writeVersion returns a marker. It MUST be truthy, or
    // _writeFile would treat the next save as a create and POST at a path that
    // already exists.
    assert.ok(gl.writeVersion({ file_path: 'maps/x.json', branch: 'main' }),
      'a write must leave a truthy version token or every second save is a doomed create');
    assert.equal(gl.readVersion({ blob_id: 'B', last_commit_id: 'C' }), 'B');
    assert.equal(gl.readVersion({}), null, 'no id means "we do not know it exists"');
    // Content is inlined at any size here, so there is no >1 MB second path.
    assert.equal(gl.isInlined({ content: 'eyJ9' }), true);
    assert.equal(gl.defaultBranch({ default_branch: 'master' }), 'master',
      'an older project on master must not be read as main');
    assert.equal(gl.defaultBranch(null), 'main');
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
    // Commit pagination differs per forge (per_page vs limit) and is now built
    // inside the descriptor, so CloudStore must delegate the whole URL.
    assert.ok(/this\.forge\.commitsUrl\(/.test(src),
      'history() must build its URL through the forge descriptor');
    assert.ok(!/per_page=50/.test(src), 'per_page is GitHub-only and must not be hardcoded');
    for (const [key, f] of Object.entries(FORGES)) {
      const url = f.commitsUrl({ api: 'https://api.example', owner: 'ada', repo: 'm', branch: 'main' }, 'maps/x.json', 50);
      assert.ok(url.includes(`${f.commitsLimitParam}=50`),
        `${key}.commitsUrl must use its own pagination param`);
    }
    // CloudStore must not reconstruct a repo path either - that is the shape
    // GitLab does not share, and the one an inline template literal re-hardcodes.
    assert.ok(!/\/repos\//.test(src),
      'CloudStore must build repo URLs through forge.repoUrl()/contentsUrl(), not inline');
    assert.ok(!/\/contents\//.test(src),
      'CloudStore must not hardcode the contents API path');
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
    // actually work out of the box. Every self-hosted pane offers a datalist;
    // all of them are checked, so a new forge cannot ship a suggestion the CSP
    // silently blocks.
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    const lists = [...html.matchAll(/<datalist id="(\w+Suggest)">([\s\S]*?)<\/datalist>/g)];
    assert.ok(lists.length >= 2, 'the per-forge instance suggestions are gone from index.html');
    for (const [, id, body] of lists) {
      for (const m of body.matchAll(/value="(https:\/\/[^"]+)"/g)) {
        assert.ok(connect.includes(new URL(m[1]).origin),
          `${m[1]} is offered in ${id} as a ready-to-use instance but is not in connect-src`);
      }
    }
  });

  test('every self-hosted forge has a pane, and every pane a forge', () => {
    // The wiring loop skips a pane whose markup is missing, which is the right
    // behaviour at runtime and a silent "sign-in tab does nothing" in a build.
    // So the table, the markup and the registry are checked against each other.
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    const table = APP.slice(APP.indexOf('const SELF_HOSTED_PANES = ['));
    const rows = [...table.slice(0, table.indexOf('];')).matchAll(/forgeId:'(\w+)'/g)].map(m => m[1]);

    for (const [key, f] of Object.entries(FORGES)) {
      if (!f.selfHosted) continue;
      assert.ok(rows.includes(key), `${key} is self-hosted but has no SELF_HOSTED_PANES row`);
      assert.ok(html.includes(`data-forge-pane="${key}"`), `${key} has no pane in index.html`);
      assert.ok(html.includes(`data-forge="${key}"`), `${key} has no tab in index.html`);
    }
    for (const id of rows) {
      assert.ok(FORGES[id], `SELF_HOSTED_PANES names "${id}", which is not in FORGES`);
    }
    // Every element id the table points at must exist, or that control is
    // simply inert - no error, no console warning, nothing to notice.
    const paneRows = table.slice(0, table.indexOf('];'));
    for (const m of paneRows.matchAll(/'#([A-Za-z0-9_]+)'/g)) {
      assert.ok(html.includes(`id="${m[1]}"`), `SELF_HOSTED_PANES points at #${m[1]}, which is not in index.html`);
    }
  });

  test('a PKCE forge carries everything the shared exchange needs', () => {
    // finishForgeLogin() reads these off whichever descriptor the popup
    // belonged to. A missing bodyFormat would silently send Gitea's JSON to a
    // host that wants form encoding, which is an opaque 400.
    for (const [key, f] of Object.entries(FORGES)) {
      if (!f.oauth) continue;
      for (const fn of ['authorizeUrl', 'tokenUrl', 'newAppUrl']) {
        assert.equal(typeof f.oauth[fn], 'function', `${key}.oauth.${fn}`);
      }
      assert.ok(['json', 'form'].includes(f.oauth.bodyFormat), `${key}.oauth.bodyFormat`);
      assert.equal(typeof f.oauth.scope, 'string');
      assert.ok(f.oauth.corsHint, `${key}.oauth.corsHint - a failed exchange must name its likely cause`);
    }
  });
});
