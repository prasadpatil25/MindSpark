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
function loadStore(fetchImpl) {
  const start = APP.indexOf('const FORGES = {');
  const end = APP.indexOf('\nlet Store;', start);
  assert.ok(start !== -1 && end > start, 'FORGES..CloudStore block not found in app.js');

  const store = new Map();
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

  function gitlabNet(existing = {}) {
    return net([
      [(m, u) => u === 'https://gitlab.com/api/v4/user',
        () => res(200, { id: 3, username: 'ada', name: 'Ada L', avatar_url: 'https://x/a.png' })],
      [(m, u) => u === PROJECT,
        () => res(200, { id: 42, default_branch: 'trunk' })],
      [(m, u) => m === 'GET' && u.startsWith(FILES),
        (m, u) => {
          const path = decodeURIComponent(u.slice(FILES.length + 1).split('?')[0]);
          if (!(path in existing)) return res(404, {});
          return res(200, { file_path: path, content: b64(existing[path]), blob_id: 'B-' + path, ref: 'trunk' });
        }],
      [(m, u) => (m === 'POST' || m === 'PUT') && u.startsWith(FILES),
        (m, u, body) => {
          const path = decodeURIComponent(u.slice(FILES.length + 1));
          existing[path] = Buffer.from(body.content, 'base64').toString('utf8');
          return res(201, { file_path: path, branch: body.branch });
        }],
      [(m, u) => m === 'DELETE' && u.startsWith(FILES),
        (m, u) => { delete existing[decodeURIComponent(u.slice(FILES.length + 1))]; return res(204, ''); }],
      [(m, u) => u.startsWith(PROJECT + '/repository/commits'),
        () => res(200, [{ id: 'C1', created_at: '2024-05-01T10:00:00Z', title: 't', message: 'MindSpark: update' }])],
      [(m, u) => u.startsWith(PROJECT + '/repository/tree'),
        () => res(200, Object.keys(existing).filter(p => p.startsWith('maps/'))
          .map(p => ({ type: 'blob', name: p.slice(5) })))],
    ]);
  }

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

  test('a first save creates with POST, and the next one updates with PUT', async () => {
    const { log, fetchImpl } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    log.length = 0;

    await CloudStore.save({ id: 'm1', title: 'Café ☕' });
    const first = only(log, c => c.url.startsWith(FILES + '/maps%2Fm1.json'));
    assert.equal(first.length, 1, 'a create must not need a recovery round-trip');
    assert.equal(first[0].method, 'POST');
    // Writes carry the branch in the BODY, and must not carry the read query.
    assert.equal(first[0].url, FILES + '/maps%2Fm1.json', 'a write URL must have no ?ref');
    assert.equal(first[0].body.branch, 'trunk');
    assert.equal(first[0].body.encoding, 'base64', 'without this the default is text, which mangles non-ASCII');
    assert.equal(Buffer.from(first[0].body.content, 'base64').toString('utf8').includes('Café ☕'), true);
    assert.equal('sha' in first[0].body, false);

    log.length = 0;
    await CloudStore.save({ id: 'm1', title: 'Café ☕ 2' });
    const second = only(log, c => c.url.startsWith(FILES + '/maps%2Fm1.json'));
    assert.equal(second.length, 1,
      'the second save must go straight to PUT - a write leaves no sha, so this is what the marker is for');
    assert.equal(second[0].method, 'PUT');
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

  test('delete removes the file and tombstones the id', async () => {
    const { log, fetchImpl } = gitlabNet();
    const { CloudStore } = loadStore(fetchImpl);
    await CloudStore.login('glpat-secret', 'gitlab', 'https://gitlab.com');
    await CloudStore.save({ id: 'm1', title: 'One' });
    log.length = 0;

    await CloudStore.remove('m1');
    const del = only(log, c => c.method === 'DELETE');
    assert.equal(del.length, 1);
    assert.equal(del[0].url, FILES + '/maps%2Fm1.json');
    assert.equal(del[0].body.branch, 'trunk', 'a delete without a branch is rejected');
    assert.equal(del[0].body.commit_message, 'MindSpark: delete maps/m1.json');
    assert.deepEqual(await CloudStore.list(), []);
    assert.ok(CloudStore.deleted.includes('m1'), 'the id must be tombstoned so it is never resurrected');
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
