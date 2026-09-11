// The forge descriptors are unit-tested next door; this drives the real
// CloudStore against a stubbed network and asserts the requests it actually
// emits - method, URL and body - for a full sign-in, save, read, history and
// delete.
//
// Why this exists: the descriptor split means a URL can be perfectly correct in
// isolation and still be sent with the wrong method, or with a body the forge
// rejects, or against the wrong branch. That failure mode is invisible to a
// per-method test and expensive in practice: a write that silently 400s is a
// map the user believes was saved.
//
// GitHub is asserted alongside GitLab deliberately. GitHub's traffic is the
// baseline the refactor must not have disturbed, and having both here makes a
// change that "fixes" one by breaking the other impossible to miss.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

// CloudStore can't be lifted with extractConst: its initialiser reads FORGES,
// so the registry has to be in scope. Take the whole slice from the registry to
// the end of the store and evaluate it with the browser globals it touches.
function loadStore(fetchImpl, store = new Map()) {
  const start = APP.indexOf('const FORGES = {');
  const end = APP.indexOf('\nlet Store;', start);
  assert.ok(start !== -1 && end > start, 'FORGES..CloudStore block not found in app.js');

  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  // No <meta> CSP in the stub, which is the "can't tell - let it try" branch of
  // cspAllowsInstance(); the CSP itself is covered by test/csp.test.mjs.
  const document = { querySelector: () => null };
  const location = { href: 'https://app.example/', origin: 'https://app.example', hostname: 'app.example' };

  const factory = new Function('fetch', 'localStorage', 'document', 'location',
    `${APP.slice(start, end)}\nreturn { FORGES, CloudStore };`);
  return factory(fetchImpl, localStorage, document, location);
}

/** Minimal Response: CloudStore uses ok/status/json/text, and clone() for the branch read. */
function res(status, body) {
  const r = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
  };
  r.clone = () => res(status, body);
  return r;
}

/** Records every request, and answers from the first matching route. */
function net(routes) {
  const log = [];
  const fetchImpl = async (url, opt = {}) => {
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : null;
    log.push({ method, url, body, headers: opt.headers || {} });
    for (const [match, reply] of routes) {
      if (match(method, url)) return reply(method, url, body);
    }
    return res(404, {});
  };
  return { log, fetchImpl };
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const only = (log, pred) => log.filter(pred);

describe('CloudStore over GitLab', () => {
  // One project, on a NON-default-looking branch, to prove the branch is read
  // from the project rather than assumed to be main.
  const PROJECT = 'https://gitlab.com/api/v4/projects/ada%2Fmindspark-maps';
  const FILES = PROJECT + '/repository/files';
  const COMMITS = PROJECT + '/repository/commits';

  // A stub GitLab: files plus the last commit that touched each of them, and a
  // commits endpoint that applies actions atomically and answers a new id.
  // `failNext` makes the next commit answer 400 the way GitLab does when a
  // last_commit_id is stale, so the recovery path can be driven.
  function gitlabNet(existing = {}, opts = {}) {
    const last = {}; for (const p of Object.keys(existing)) last[p] = 'C0';
    let n = 0;
    const state = { existing, last, interpose: null };
    const nn = net([
      [(m, u) => u === 'https://gitlab.com/api/v4/user',
        () => res(200, { id: 3, username: 'ada', name: 'Ada L', avatar_url: 'https://x/a.png' })],
      [(m, u) => u === PROJECT,
        () => res(200, { id: 42, default_branch: 'trunk' })],
      [(m, u) => m === 'GET' && u.startsWith(FILES),
        (m, u) => {
          const path = decodeURIComponent(u.slice(FILES.length + 1).split('?')[0]);
          if (!(path in existing)) return res(404, {});
          return res(200, { file_path: path, content: b64(existing[path]), blob_id: 'B-' + path, last_commit_id: last[path], ref: 'trunk' });
        }],
      [(m, u) => m === 'POST' && u === COMMITS,
        (m, u, body) => {
          // Someone else's push landing just before ours: mutate the server
          // state and refuse this commit, as GitLab does for a stale lock.
          if (state.interpose) { const f = state.interpose; state.interpose = null; f(); return res(400, { message: 'A file has changed since you started editing it' }); }
          for (const a of body.actions) {
            if (a.action === 'delete') { if (!(a.file_path in existing)) return res(400, { message: "A file with this name doesn't exist" }); delete existing[a.file_path]; delete last[a.file_path]; continue; }
            if (a.action === 'create' && a.file_path in existing) return res(400, { message: 'A file with this name already exists' });
            if (a.action === 'update' && !(a.file_path in existing)) return res(400, { message: "A file with this name doesn't exist" });
            if (a.last_commit_id && a.last_commit_id !== last[a.file_path]) return res(400, { message: 'A file has changed since you started editing it' });
            existing[a.file_path] = Buffer.from(a.content, 'base64').toString('utf8');
          }
          const id = 'CM' + (++n);
          for (const a of body.actions) if (a.action !== 'delete') last[a.file_path] = id;
          return res(201, { id, short_id: id, committed_date: '2024-05-01T10:00:00Z' });
        }],
      [(m, u) => u.startsWith(COMMITS + '?'),
        () => res(200, [{ id: 'C1', created_at: '2024-05-01T10:00:00Z', title: 't', message: 'MindSpark: update' }])],
      [(m, u) => u.startsWith(PROJECT + '/repository/tree'),
        () => res(200, Object.keys(existing).filter(p => p.startsWith('maps/'))
          .map(p => ({ type: 'blob', name: p.slice(5) })))],
    ]);
    return { ...nn, state };
  }
  const commits = log => only(log, c => c.method === 'POST' && c.url === COMMITS);
  const fileWrites = log => only(log, c => c.method !== 'GET' && c.url.startsWith(FILES));

  test('signs in as `username` and reads the branch off the project', async () => {
    const { log, fetchImpl } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    const me = await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com/');

    assert.equal(me.login, 'ada', 'GitLab answers `username`; CloudStore builds project paths from `login`');
    assert.equal(CloudStore.branch, 'trunk', 'the branch must come from the project, not a guess');
    // Bearer, and nothing GitHub-shaped.
    assert.equal(log[0].headers.Authorization, 'Bearer glpat-secret');
    assert.equal(log[0].headers['X-GitHub-Api-Version'], undefined);
    // The trailing slash on the instance must not survive into the URL.
    assert.equal(log[0].url, 'https://gitlab.com/api/v4/user');
    // Every read names the branch: without ref this endpoint errors.
    for (const c of only(log, c => c.url.startsWith(FILES))) {
      assert.match(c.url, /\?ref=trunk$/, `${c.url} must name the branch`);
    }
  });

  test('a save is ONE commit carrying the map and the index, locked on last_commit_id', async () => {
    const { log, fetchImpl } = gitlabNet({ '_index.json': '[]' });
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    log.length = 0;

    await CloudStore.save({ id: 'm1', title: 'Café ☕' });
    assert.equal(fileWrites(log).length, 0, 'the files API must not be written to any more');
    const c = commits(log);
    assert.equal(c.length, 1, 'map + index land in one atomic commit');
    assert.equal(c[0].body.branch, 'trunk');
    assert.equal(c[0].body.commit_message, 'MindSpark: update maps/m1.json', 'history keeps reading as before');
    const [mapA, idxA] = c[0].body.actions;
    assert.equal(mapA.action, 'create'); assert.equal(mapA.file_path, 'maps/m1.json');
    assert.equal(mapA.encoding, 'base64', 'without this the default is text, which mangles non-ASCII');
    assert.ok(Buffer.from(mapA.content, 'base64').toString('utf8').includes('Café ☕'));
    assert.equal('last_commit_id' in mapA, false, 'a create has nothing to lock on');
    assert.equal(idxA.action, 'update'); assert.equal(idxA.file_path, '_index.json');
    assert.equal(idxA.last_commit_id, 'C0', 'the index is locked on the commit it was read at');
  });

  test('the next save is locked on the commit id the previous one returned', async () => {
    const { log, fetchImpl } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'One' });
    log.length = 0;

    await CloudStore.save({ id: 'm1', title: 'Two' });
    const c = commits(log);
    assert.equal(c.length, 1);
    const [mapA, idxA] = c[0].body.actions;
    assert.equal(mapA.action, 'update');
    assert.equal(mapA.last_commit_id, 'CM1', 'the write response IS the next lock token - no extra read');
    assert.equal(idxA.last_commit_id, 'CM1');
    assert.equal((await CloudStore.get('m1')).title, 'Two');
  });

  test('reads decode base64 and history maps GitLab commit fields', async () => {
    const { fetchImpl } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'Café ☕' });

    const back = await CloudStore.get('m1');
    assert.equal(back.title, 'Café ☕');
    assert.deepEqual(await CloudStore.list(), [{ id: 'm1', title: 'Café ☕', color: undefined, updated: back.updated }]);

    const h = await CloudStore.history('m1');
    assert.deepEqual(h, [{ ref: 'C1', ts: Date.parse('2024-05-01T10:00:00Z'), message: 'MindSpark: update' }]);
  });

  test('delete is ONE commit: remove the file, tombstone the id, update the index', async () => {
    const { log, fetchImpl, state } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'One' });
    log.length = 0;

    await CloudStore.remove('m1');
    const c = commits(log);
    assert.equal(c.length, 1);
    assert.equal(c[0].body.commit_message, 'MindSpark: delete maps/m1.json');
    const byPath = Object.fromEntries(c[0].body.actions.map(a => [a.file_path, a]));
    assert.equal(byPath['maps/m1.json'].action, 'delete');
    assert.equal(byPath['maps/m1.json'].last_commit_id, 'CM1', 'a delete is locked too');
    assert.equal(byPath['_deleted.json'].action, 'create');
    assert.equal(byPath['_index.json'].action, 'update');
    assert.equal('maps/m1.json' in state.existing, false);
    assert.deepEqual(await CloudStore.list(), []);
    assert.ok(CloudStore.deleted.includes('m1'), 'the id must be tombstoned so it is never resurrected');
  });

  test('a delete whose commit fails leaves the index and the tombstones untouched', async () => {
    const store = new Map();
    const { fetchImpl, state } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl, store);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'One' });
    // Same session, but GitLab now falls over on the commit (a 500 is not a
    // stale-lock 400, so there is no merge-and-retry either).
    const brokenFetch = async (url, opt) => (opt && opt.method === 'POST' && url === COMMITS) ? res(500, { message: 'boom' }) : fetchImpl(url, opt);
    const { CloudStore: broken } = loadStore(brokenFetch, store);
    assert.equal(await broken.tryInit(), true);
    assert.deepEqual((await broken.list()).map(m => m.id), ['m1']);

    await assert.rejects(broken.remove('m1'), /500/);

    assert.deepEqual((await broken.list()).map(m => m.id), ['m1'], 'the map is still listed - it still exists');
    assert.equal(broken.deleted.includes('m1'), false, 'no tombstone for a map that was not deleted');
    assert.equal('maps/m1.json' in state.existing, true);
  });

  test('a stale index (another device saved) is re-read, merged and committed again - once', async () => {
    const { log, fetchImpl, state } = gitlabNet({ '_index.json': '[]' });
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    // A second device's save lands AFTER we re-read the index and BEFORE our
    // commit - the only window the merge-on-write read cannot cover.
    state.interpose = () => {
      state.existing['_index.json'] = JSON.stringify([{ id: 'other', title: 'Theirs', updated: 5 }]);
      state.last['_index.json'] = 'C7';
      state.existing['maps/other.json'] = '{"id":"other"}'; state.last['maps/other.json'] = 'C7';
    };
    log.length = 0;

    await CloudStore.save({ id: 'm1', title: 'Mine' });
    const c = commits(log);
    assert.equal(c.length, 2, 'first commit is refused (stale index), second carries the merge');
    const idx = c[1].body.actions.find(a => a.file_path === '_index.json');
    assert.equal(idx.last_commit_id, 'C7', 'retried on the commit the index was re-read at');
    const merged = JSON.parse(Buffer.from(idx.content, 'base64').toString('utf8')).map(m => m.id).sort();
    assert.deepEqual(merged, ['m1', 'other'], 'the other device\'s map must survive our save');
  });

  test('a map changed elsewhere is reported as a conflict, never silently overwritten', async () => {
    const { log, fetchImpl, state } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'Mine v1' });
    // Elsewhere: someone else saved this very map.
    state.existing['maps/m1.json'] = '{"id":"m1","title":"Theirs"}'; state.last['maps/m1.json'] = 'CX';
    log.length = 0;

    let err = null;
    try { await CloudStore.save({ id: 'm1', title: 'Mine v2' }); } catch (e) { err = e; }
    assert.ok(err && err.conflict === true, 'the caller must be able to tell a conflict from a network failure');
    assert.equal(commits(log).length, 1, 'no blind retry');
    assert.equal(JSON.parse(state.existing['maps/m1.json']).title, 'Theirs', 'their version stays on the server');
    assert.equal(CloudStore.shas.m1, 'CX', 'the server\'s version is adopted so the user\'s NEXT save can overwrite deliberately');
    await CloudStore.save({ id: 'm1', title: 'Mine v3' });
    assert.equal(JSON.parse(state.existing['maps/m1.json']).title, 'Mine v3');
  });

  test('orphan recovery reads the tree endpoint, not the file endpoint', async () => {
    // A map file present but missing from the index - the damaged-index case.
    const { fetchImpl } = gitlabNet({ 'maps/lost.json': JSON.stringify({ id: 'lost', title: 'Lost' }) });
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');

    const orphans = await CloudStore.orphanMaps();
    assert.deepEqual(orphans.map(o => o.id), ['lost']);
    assert.equal(await CloudStore.restoreOrphans(orphans), 1);
  });
});

describe('CloudStore over GitHub is unchanged by the refactor', () => {
  const REPO = 'https://api.github.com/repos/ada/mindspark-maps';

  function githubNet(existing = {}) {
    return net([
      [(m, u) => u === 'https://api.github.com/user',
        () => res(200, { id: 1, login: 'ada', avatar_url: 'https://x/a.png' })],
      [(m, u) => u === REPO, () => res(200, { name: 'mindspark-maps', default_branch: 'main' })],
      [(m, u) => m === 'GET' && u.startsWith(REPO + '/contents/'),
        (m, u) => {
          const path = u.slice((REPO + '/contents/').length).split('?')[0];
          if (!(path in existing)) return res(404, {});
          return res(200, { content: b64(existing[path]), sha: 'S-' + path, encoding: 'base64' });
        }],
      [(m, u) => (m === 'PUT' || m === 'POST') && u.startsWith(REPO + '/contents/'),
        (m, u, body) => {
          const path = u.slice((REPO + '/contents/').length);
          existing[path] = Buffer.from(body.content, 'base64').toString('utf8');
          return res(200, { content: { sha: 'S2-' + path } });
        }],
    ]);
  }

  test('signs in, creates with a sha-less PUT, then updates carrying the sha', async () => {
    const { log, fetchImpl } = githubNet();
    const { CloudStore } = loadStore(fetchImpl);
    const me = await CloudStore.login('ghp_classic', 'github', null);

    assert.equal(me.login, 'ada');
    assert.equal(CloudStore.branch, null, 'GitHub resolves the branch server-side and must name none');
    assert.equal(log[0].headers.Authorization, 'token ghp_classic');
    log.length = 0;

    await CloudStore.save({ id: 'm1', title: 'One' });
    const first = only(log, c => c.url === REPO + '/contents/maps/m1.json');
    assert.equal(first.length, 1);
    assert.equal(first[0].method, 'PUT', "GitHub's PUT both creates and updates");
    assert.equal('sha' in first[0].body, false, 'a create must carry no sha');
    assert.equal(first[0].body.message, 'MindSpark: update maps/m1.json');

    log.length = 0;
    await CloudStore.save({ id: 'm1', title: 'Two' });
    const second = only(log, c => c.url === REPO + '/contents/maps/m1.json');
    assert.equal(second[0].method, 'PUT');
    assert.equal(second[0].body.sha, 'S2-maps/m1.json', 'the sha from the write must be sent back on the next one');
    assert.equal((await CloudStore.get('m1')).title, 'Two');
  });

  test('a >1 MB file falls back to the Blobs API rather than reading empty content', async () => {
    const big = JSON.stringify({ id: 'big', title: 'Big' });
    const { fetchImpl } = net([
      [(m, u) => u === 'https://api.github.com/user', () => res(200, { id: 1, login: 'ada' })],
      [(m, u) => u === REPO, () => res(200, {})],
      [(m, u) => u === REPO + '/contents/maps/big.json',
        () => res(200, { content: '', encoding: 'none', sha: 'S', git_url: REPO + '/git/blobs/S' })],
      [(m, u) => u === REPO + '/git/blobs/S', () => res(200, { content: b64(big) })],
      [() => true, () => res(404, {})],
    ]);
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('ghp_classic', 'github', null);
    assert.equal((await CloudStore.get('big')).title, 'Big');
  });
});

// The target repository used to be fixed to `<login>/mindspark-maps`. A team
// needs one shared project instead, so login() takes a target: a bare name
// stays under the signed-in account, `group/sub/name` is used verbatim.
describe('CloudStore repository target', () => {
  const GL = 'https://gitlab.com/api/v4';
  function glNet(projects) {
    return net([
      [(m, u) => u === GL + '/user', () => res(200, { id: 3, username: 'ada' })],
      [(m, u) => m === 'GET' && projects.includes(u.slice((GL + '/projects/').length)) && u.startsWith(GL + '/projects/') && !u.includes('/repository/'),
        () => res(200, { id: 42, default_branch: 'main' })],
      [(m, u) => m === 'POST' && u === GL + '/projects',
        (m, u, body) => res(201, { id: 43, default_branch: 'main', path_with_namespace: 'ada/' + body.path })],
      [(m, u) => m === 'POST' && u.endsWith('/repository/commits'),
        () => res(201, { id: 'CM1' })],
    ]);
  }

  test('a bare name stays under the signed-in account', async () => {
    const { log, fetchImpl } = glNet(['ada%2Fmindspark-maps']);
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com', 'mindspark-maps');
    assert.ok(log.some(c => c.url === GL + '/projects/ada%2Fmindspark-maps'));
  });

  test('a group path is used verbatim, and saves go to that project', async () => {
    const { log, fetchImpl } = glNet(['team%2Ftools%2Fmindspark-maps']);
    const { CloudStore } = loadStore(fetchImpl);
    const me = await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com', 'team/tools/mindspark-maps');
    assert.equal(me.login, 'ada', 'the identity is still the signed-in user, not the group');
    log.length = 0;
    await CloudStore.save({ id: 'm1', title: 'One' });
    const w = only(log, c => c.method === 'POST' && c.url.endsWith('/repository/commits'));
    assert.equal(w[0].url, GL + '/projects/team%2Ftools%2Fmindspark-maps/repository/commits');
    assert.equal(w[0].body.actions[0].file_path, 'maps/m1.json');
  });

  test('a missing group project is reported, never created', async () => {
    const { log, fetchImpl } = glNet([]);
    const { CloudStore } = loadStore(fetchImpl);
    await assert.rejects(
      () => CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com', 'team/mindspark-maps'),
      /team\/mindspark-maps/);
    assert.equal(only(log, c => c.method === 'POST' && c.url === GL + '/projects').length, 0,
      'a project someone else owns must not be auto-created under the user');
  });

  test('a missing personal project is still created, as before', async () => {
    const { log, fetchImpl } = glNet([]);
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    const create = only(log, c => c.method === 'POST' && c.url === GL + '/projects');
    assert.equal(create.length, 1);
    assert.equal(create[0].body.path, 'mindspark-maps');
  });

  test('the target survives a reload through tryInit', async () => {
    const shared = new Map();
    const a = loadStore(glNet(['team%2Fmindspark-maps']).fetchImpl, shared);
    await a.CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com', 'team/mindspark-maps');

    const { log, fetchImpl } = glNet(['team%2Fmindspark-maps']);
    const b = loadStore(fetchImpl, shared);
    assert.equal(await b.CloudStore.tryInit(), true);
    assert.ok(log.some(c => c.url === GL + '/projects/team%2Fmindspark-maps'), 'must reopen the team project, not the personal default');
    b.CloudStore.logout();
    assert.equal(shared.has('mindspark:forge:repo'), false, 'logout forgets the target with the session');
  });

  test('whitespace and slashes around the target are ignored', async () => {
    const { log, fetchImpl } = glNet(['team%2Fmindspark-maps']);
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com', '  /team/mindspark-maps/ ');
    assert.ok(log.some(c => c.url === GL + '/projects/team%2Fmindspark-maps'));
  });

  test('GitHub: an org target addresses /repos/<org>/<repo>', async () => {
    const { log, fetchImpl } = net([
      [(m, u) => u === 'https://api.github.com/user', () => res(200, { id: 1, login: 'ada' })],
      [(m, u) => u === 'https://api.github.com/repos/acme/mindspark-maps', () => res(200, { default_branch: 'main' })],
      [(m, u) => m === 'PUT' && u.includes('/contents/'), () => res(200, { content: { sha: 'S' } })],
    ]);
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('ghp_classic', 'github', null, 'acme/mindspark-maps');
    log.length = 0;
    await CloudStore.save({ id: 'm1', title: 'One' });
    assert.ok(log.some(c => c.url === 'https://api.github.com/repos/acme/mindspark-maps/contents/maps/m1.json'));
  });
});
