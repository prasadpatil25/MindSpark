// Named collaborators and link permissions need a VERIFIED identity from the
// collaboration backend. Until now that was GitHub-only twice over: the client
// asked for an identity with the bare token (so a backend could not know which
// forge to verify it against), and "Manage access" was shown when the forge
// was GitHub rather than when an identity had actually been minted. A
// companion backend (discussion #46, discovery merged as #50) can vouch for a
// GitLab or Gitea account too - once the client tells it which one.
//
// These tests pin (a) the identity request carrying {token, forge, instance}
// and the access-control UI keyed on the minted identity, and (b) "Add
// collaborator" resolving the typed login on the signed-in forge through the
// FORGES descriptor, never through api.github.com and never through a
// forge.id branch in the shared collaboration code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractConst, loadFns } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const FORGES = extractConst('FORGES');

// `const Session = {...};` closes over CloudStore, collabBase and fetch by
// name; hand it test doubles for the three.
function loadSession({ CloudStore, collabBase = () => 'https://maps.example.org', fetch }) {
  const start = APP.indexOf('const Session = {');
  const end = APP.indexOf('\n};', start) + 3;
  assert.ok(start !== -1 && end > start, 'Session object not found in app.js');
  return new Function('CloudStore', 'collabBase', 'fetch', `${APP.slice(start, end)}\nreturn Session;`)(CloudStore, collabBase, fetch);
}
function okSession(body = { token: 'JWT', exp: 4102444800, id: 'gitlab:git.example:7', login: 'timo' }) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

describe('(a) the identity request names the forge', () => {
  test('a self-hosted forge session posts {token, forge, instance}', async () => {
    const posted = [];
    const fetch = async (url, opt) => { posted.push({ url, body: JSON.parse(opt.body) }); return okSession()(); };
    const Session = loadSession({ CloudStore: { token: 'glpat-1', forge: FORGES.gitlab, instance: 'https://git.example' }, fetch });

    assert.equal(await Session.ensure(), 'JWT');
    assert.equal(posted[0].url, 'https://maps.example.org/api/session');
    assert.deepEqual(posted[0].body, { token: 'glpat-1', forge: 'gitlab', instance: 'https://git.example' });
    assert.equal(Session.id, 'gitlab:git.example:7', 'the minted subject is kept as the session id');
  });

  test('a GitHub session posts the forge and no instance', async () => {
    const posted = [];
    const fetch = async (url, opt) => { posted.push(JSON.parse(opt.body)); return okSession({ token: 'JWT', exp: 4102444800, id: '99', login: 'octo' })(); };
    const Session = loadSession({ CloudStore: { token: 'ghp_1', forge: FORGES.github, instance: null }, fetch });

    await Session.ensure();
    assert.deepEqual(posted[0], { token: 'ghp_1', forge: 'github' }, 'the worker reads only `token`; instance is absent, not null');
  });
});

describe('(a) access control is gated on a minted identity, not on the forge', () => {
  function gate({ id, forge = 'gitlab', collab = true }) {
    return loadFns(['accessControlAvailable'], {
      collabAvailable: () => collab,
      CloudStore: { forge: FORGES[forge] },
      Session: { id },
    }).accessControlAvailable();
  }
  test('a GitLab session with a minted identity gets "Manage access"', () => {
    assert.equal(gate({ id: 'gitlab:git.example:7', forge: 'gitlab' }), true);
  });
  test('a Gitea session with a minted identity gets "Manage access"', () => {
    assert.equal(gate({ id: 'gitea:codeberg.org:12', forge: 'gitea' }), true);
  });
  test('a GitHub session with no identity (backend answered 501 or never) does not', () => {
    assert.equal(gate({ id: null, forge: 'github' }), false);
  });
  test('no collaboration backend means no access control either', () => {
    assert.equal(gate({ id: '99', forge: 'github', collab: false }), false);
  });
  test('the identity is requested after every sign-in, before the app boots on it', () => {
    // Both paths that end with a signed-in cloud session ask the backend for an
    // identity right there, so the share menu never has to guess.
    const sites = APP.match(/showUserPill\(\);\s*await ensureCollabIdentity\(\);\s*await proceedBoot\(\);/g) || [];
    assert.equal(sites.length, 2, 'boot with a restored session, and completeCloudLogin');
  });
  test('asking for the identity never blocks the boot on a hung backend', async () => {
    let asked = 0;
    const { ensureCollabIdentity } = loadFns(['ensureCollabIdentity'], {
      collabAvailable: () => true,
      Session: { ensure: () => { asked++; return new Promise(() => {}); } },
    });
    const t0 = Date.now();
    await ensureCollabIdentity(20);
    assert.equal(asked, 1);
    assert.ok(Date.now() - t0 < 1000, 'resolved by the timeout, not by the backend');
  });
  test('and is not asked for at all when there is no backend', async () => {
    let asked = 0;
    const { ensureCollabIdentity } = loadFns(['ensureCollabIdentity'], {
      collabAvailable: () => false,
      Session: { ensure: () => { asked++; return null; } },
    });
    await ensureCollabIdentity();
    assert.equal(asked, 0);
  });
  test('the sharing copy names the signed-in forge, not GitHub', () => {
    const src = extractFunction('publishSharedMap');
    assert.doesNotMatch(src, /GitHub sign-in/, 'the publish confirmation must not promise a GitHub sign-in');
    assert.match(src, /forgeName\(\)/, 'it names whatever forge this session is on');
  });
});

describe('(b) every forge can look a user up by login', () => {
  const r = { api: 'https://git.example/api/v4', owner: 'o', repo: 'r', branch: 'main' };
  test('the descriptor pair exists on every forge', () => {
    for (const [key, f] of Object.entries(FORGES)) {
      assert.equal(typeof f.userUrl, 'function', `${key}.userUrl(r, login)`);
      assert.equal(typeof f.readUser, 'function', `${key}.readUser(json)`);
    }
  });
  test('GitHub: /users/<login> answers the user object', () => {
    const gh = FORGES.github;
    assert.equal(gh.userUrl({ ...r, api: 'https://api.github.com' }, 'octo cat'), 'https://api.github.com/users/octo%20cat');
    assert.deepEqual(gh.readUser({ id: 583231, login: 'octocat', avatar_url: 'a' }), { id: '583231', login: 'octocat' });
    assert.equal(gh.readUser({ message: 'Not Found' }), null);
  });
  test('Gitea: /users/<login> on the instance API', () => {
    const g = FORGES.gitea;
    assert.equal(g.userUrl({ ...r, api: 'https://codeberg.org/api/v1' }, 'octo'), 'https://codeberg.org/api/v1/users/octo');
    assert.deepEqual(g.readUser({ id: 12, login: 'octo' }), { id: '12', login: 'octo' });
  });
  test('GitLab: has no /users/<login>; it searches by username and answers a list', () => {
    const gl = FORGES.gitlab;
    assert.equal(gl.userUrl(r, 'octo'), 'https://git.example/api/v4/users?username=octo');
    assert.deepEqual(gl.readUser([{ id: 7, username: 'octo', name: 'Octo' }]), { id: '7', login: 'octo' });
    assert.equal(gl.readUser([]), null, 'an unknown username is an empty list, not a 404');
    assert.equal(gl.readUser(null), null);
  });
});

describe('(b) "Add collaborator" resolves the login on the signed-in forge', () => {
  function resolver({ forge, instance, sessionId, answer, status = 200 }) {
    const fetched = [];
    const CloudStore = {
      token: 'T', forge: FORGES[forge], instance,
      _ref() { return { api: this.forge.apiBase(this.instance), owner: 'o', repo: 'r', branch: 'main' }; },
    };
    const fetch = async (url, opt) => { fetched.push({ url, headers: opt.headers }); return { ok: status < 400, status, json: async () => answer }; };
    const { _resolveCollaborator } = loadFns(['_resolveCollaborator'], { CloudStore, Session: { id: sessionId }, fetch });
    return { _resolveCollaborator, fetched };
  }

  test('a GitLab session looks the login up on its own instance, with its own auth scheme', async () => {
    const { _resolveCollaborator, fetched } = resolver({
      forge: 'gitlab', instance: 'https://git.example', sessionId: 'gitlab:git.example:7',
      answer: [{ id: 12, username: 'anna' }],
    });
    const u = await _resolveCollaborator(' @anna ');
    assert.equal(fetched[0].url, 'https://git.example/api/v4/users?username=anna');
    assert.equal(fetched[0].headers.Authorization, 'Bearer T');
    assert.deepEqual(u, { id: 'gitlab:git.example:12', login: 'anna' },
      'the posted id carries the same namespace the backend put on the caller\'s own identity');
  });

  test('a GitHub session against the worker keeps plain ids', async () => {
    const { _resolveCollaborator, fetched } = resolver({
      forge: 'github', instance: null, sessionId: '99', answer: { id: 583231, login: 'octocat' },
    });
    const u = await _resolveCollaborator('octocat');
    assert.equal(fetched[0].url, 'https://api.github.com/users/octocat');
    assert.equal(fetched[0].headers.Authorization, 'token T');
    assert.deepEqual(u, { id: '583231', login: 'octocat' }, 'the worker\'s subjects are bare GitHub ids');
  });

  test('an unknown login is null, whether the forge says 404 or []', async () => {
    const a = resolver({ forge: 'github', instance: null, sessionId: '99', answer: { message: 'Not Found' }, status: 404 });
    assert.equal(await a._resolveCollaborator('nobody'), null);
    const b = resolver({ forge: 'gitlab', instance: 'https://git.example', sessionId: 'gitlab:git.example:7', answer: [] });
    assert.equal(await b._resolveCollaborator('nobody'), null);
  });

  test('an empty login is not looked up', async () => {
    const { _resolveCollaborator, fetched } = resolver({ forge: 'github', instance: null, sessionId: '99', answer: {} });
    assert.equal(await _resolveCollaborator('  @ '), null);
    assert.equal(fetched.length, 0);
  });

  test('the access panel uses it and no longer knows about GitHub', () => {
    const panel = extractFunction('_renderAccessPanel');
    assert.match(panel, /_resolveCollaborator\(/);
    assert.doesNotMatch(panel, /GitHub/, 'the "no such user" toast names the forge via forgeName()');
    assert.match(panel, /forgeName\(\)/);
    assert.equal(APP.includes('_resolveGitHubUser'), false, 'the GitHub-only resolver is gone');
    assert.equal(APP.includes("'https://api.github.com/users/"), false, 'no hard-wired api.github.com lookup remains');
  });
});

describe('no forge-specific branching in the collaboration code', () => {
  // The per-forge differences (endpoint, auth scheme, response shape) live on
  // FORGES; the collaboration code - identity, sharing, access control, live
  // sessions - must read them from the descriptor. Same rule as the storage
  // paths (forge-adapters.test.mjs), for the same reason: an untested
  // `if(forge.id===...)` is how one forge silently gets a worse feature.
  test('from collabBase() to the end of app.js', () => {
    const start = APP.indexOf('function collabBase(');
    assert.notEqual(start, -1);
    const collab = APP.slice(start);
    assert.doesNotMatch(collab, /forge\.id\s*===/, 'put the difference on the FORGES descriptor');
    assert.doesNotMatch(collab, /forge\.id\s*!==/, 'put the difference on the FORGES descriptor');
  });
});
