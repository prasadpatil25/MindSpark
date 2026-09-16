// The live-session WebSocket was anonymous: a room with an access list gated
// its HTTP API (read to open, write to save, admin to manage) while anyone
// holding the room id could join the socket, read every op and push their own.
// The identity that /api/session mints now rides on the upgrade URL as
// ?token=<jwt> - a browser WebSocket cannot set headers - and the Durable
// Object answers it with the same authorizeRequest() decision the HTTP API
// uses: `read` to join, `write` to store a snapshot or relay an op. Cursors,
// names and pings are not writes. A room without an access list (a live
// session of an unpublished map) stays open, as before.
//
// These tests pin (a) the worker side - the identity read off the URL, the
// join and write decisions, the wiring in the Durable Object - and (b) the
// client side - the token on the URL, the identity requested before the
// socket opens, and a #live= guest restoring a saved forge session first.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signJWT } from '../worker/auth-core.js';
import { socketIdentity, socketAllowed } from '../worker/collab-http.js';
import { loadFns } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const DO = readFileSync(join(ROOT, 'worker', 'collab-do.js'), 'utf8');

const SECRET = 'test-secret';
const env = { AUTH_SECRET: SECRET };
const upgrade = (room, token) => new Request('https://maps.example.org/api/collab/' + room + (token ? '?token=' + encodeURIComponent(token) : ''), { headers: { Upgrade: 'websocket' } });
const storageWith = (entries = {}) => ({ get: async k => entries[k] });
const acl = (over = {}) => ({ ownerId: 'owner', ownerLogin: 'ada', members: {}, linkAccess: 'none', ...over });

describe('(a) socketIdentity() reads the identity off the upgrade URL', () => {
  test('a valid ?token= yields {sub, login}', async () => {
    const jwt = await signJWT({ sub: 'gitlab:git.example:7', login: 'timo' }, SECRET, 600);
    assert.deepEqual(await socketIdentity(env, upgrade('r', jwt)), { sub: 'gitlab:git.example:7', login: 'timo' });
  });
  test('no token, a forged token and an expired token are all anonymous', async () => {
    assert.equal(await socketIdentity(env, upgrade('r')), null);
    assert.equal(await socketIdentity(env, upgrade('r', 'not-a-jwt')), null);
    const forged = await signJWT({ sub: 'owner', login: 'ada' }, 'other-secret', 600);
    assert.equal(await socketIdentity(env, upgrade('r', forged)), null);
    const expired = await signJWT({ sub: 'owner', login: 'ada' }, SECRET, -10);
    assert.equal(await socketIdentity(env, upgrade('r', expired)), null);
  });
  test('a worker without AUTH_SECRET never mints, so it never trusts a token either', async () => {
    const jwt = await signJWT({ sub: 'owner', login: 'ada' }, SECRET, 600);
    assert.equal(await socketIdentity({}, upgrade('r', jwt)), null);
  });
});

describe('(a) socketAllowed() decides join and write like the HTTP API', () => {
  test('a room without an access list is open to anonymous sockets, reads and writes', async () => {
    assert.equal(await socketAllowed(storageWith(), null, 'read'), true);
    assert.equal(await socketAllowed(storageWith(), null, 'write'), true);
  });
  test('an unpublished room with only a legacy edit token stays open on the socket', async () => {
    assert.equal(await socketAllowed(storageWith({ editToken: 'e123' }), null, 'read'), true);
    assert.equal(await socketAllowed(storageWith({ editToken: 'e123' }), null, 'write'), true);
  });
  test('linkAccess none: anonymous is refused, the owner and members join', async () => {
    const s = storageWith({ acl: acl({ members: { bob: { role: 'viewer' } } }) });
    assert.equal(await socketAllowed(s, null, 'read'), false);
    assert.equal(await socketAllowed(s, { sub: 'stranger', login: '' }, 'read'), false);
    assert.equal(await socketAllowed(s, { sub: 'owner', login: 'ada' }, 'read'), true);
    assert.equal(await socketAllowed(s, { sub: 'bob', login: 'bob' }, 'read'), true);
  });
  test('a viewer may join but not write; an editor and the owner may write', async () => {
    const s = storageWith({ acl: acl({ members: { bob: { role: 'viewer' }, eve: { role: 'editor' } } }) });
    assert.equal(await socketAllowed(s, { sub: 'bob', login: 'bob' }, 'write'), false);
    assert.equal(await socketAllowed(s, { sub: 'eve', login: 'eve' }, 'write'), true);
    assert.equal(await socketAllowed(s, { sub: 'owner', login: 'ada' }, 'write'), true);
  });
  test('link permissions apply to the socket: view lets anonymous join but not write, edit lets them write, the -auth variants need an identity', async () => {
    const view = storageWith({ acl: acl({ linkAccess: 'view' }) });
    assert.equal(await socketAllowed(view, null, 'read'), true);
    assert.equal(await socketAllowed(view, null, 'write'), false);
    const edit = storageWith({ acl: acl({ linkAccess: 'edit' }) });
    assert.equal(await socketAllowed(edit, null, 'write'), true);
    const editAuth = storageWith({ acl: acl({ linkAccess: 'edit-auth' }) });
    assert.equal(await socketAllowed(editAuth, null, 'read'), false);
    assert.equal(await socketAllowed(editAuth, { sub: 'stranger', login: '' }, 'write'), true);
  });
  test('a socket never claims ownership: an identified stranger on an unclaimed room is a plain writer, and the ACL stays untouched', async () => {
    let written = false;
    const s = { get: async () => undefined, put: async () => { written = true; } };
    assert.equal(await socketAllowed(s, { sub: 'first', login: '' }, 'write'), true);
    assert.equal(written, false, 'authorizeRequest may answer claim:true; the socket must not act on it');
  });
});

describe('(a) the Durable Object gates the socket with those two', () => {
  test('the upgrade asks socketIdentity() and socketAllowed(read) before accepting, and answers 401/403 otherwise', () => {
    const fetchStart = DO.indexOf('async fetch(request)');
    const accept = DO.indexOf('acceptWebSocket(', fetchStart);
    const ident = DO.indexOf('socketIdentity(', fetchStart);
    const allowed = DO.indexOf("socketAllowed(", fetchStart);
    assert.ok(ident !== -1 && ident < accept, 'read the identity before accepting the socket');
    assert.ok(allowed !== -1 && allowed < accept, 'decide `read` before accepting the socket');
    assert.match(DO.slice(fetchStart, accept), /status:\s*identity\s*\?\s*403\s*:\s*401/, 'a stranger is 403, anonymous is 401 - the HTTP API answers the same');
  });
  test('the identity is kept on the socket attachment and asked again for every snapshot and op', () => {
    assert.match(DO, /serializeAttachment\(\{[^}]*identity/, 'the attachment carries the identity');
    const msg = DO.indexOf('async webSocketMessage(');
    const body = DO.slice(msg, DO.indexOf('async webSocketClose(', msg));
    assert.match(body, /socketAllowed\([^)]*'write'\)/, 'writes are decided per message, against the ACL as it is now');
    const snapshot = body.indexOf("m.t === 'snapshot'"), op = body.indexOf("m.t === 'op'");
    assert.ok(snapshot !== -1 && op !== -1, 'both the snapshot store and the op relay are gated');
    assert.ok(body.indexOf("m.t === 'name'") !== -1 && body.indexOf("m.t === 'name'") < op, 'a name is not a write and is handled before the op gate');
  });
});

describe('(b) the client carries the identity on the socket', () => {
  // wsUrl() is a closure inside the Collab module; lift its text and hand it
  // the two names it reads: collabBase and Session.
  function loadWsUrl({ collabBase, Session }) {
    const start = APP.indexOf('function wsUrl(r)');
    assert.notEqual(start, -1, 'wsUrl() not found in the Collab module');
    const m = /\r?\n\r?\n/.exec(APP.slice(start));   // first blank line after the function: LF or CRLF checkout
    const end = m ? start + m.index : -1;
    return new Function('collabBase', 'Session', `${APP.slice(start, end)}\nreturn wsUrl;`)(collabBase, Session);
  }
  test('wsUrl() appends ?token=<jwt> when an identity was minted', () => {
    const wsUrl = loadWsUrl({ collabBase: () => 'https://maps.example.org', Session: { jwt: 'a.b/c' } });
    assert.equal(wsUrl('room 1'), 'wss://maps.example.org/api/collab/room%201?token=a.b%2Fc');
  });
  test('wsUrl() is unchanged without an identity, and still null without a backend', () => {
    assert.equal(loadWsUrl({ collabBase: () => 'http://localhost:8787', Session: { jwt: null } })('r'), 'ws://localhost:8787/api/collab/r');
    assert.equal(loadWsUrl({ collabBase: () => 'http://localhost:8787', Session: undefined })('r'), 'ws://localhost:8787/api/collab/r');
    assert.equal(loadWsUrl({ collabBase: () => null, Session: { jwt: 'x' } })('r'), null);
  });
  test('connect() asks for the identity before building the socket URL', () => {
    const start = APP.indexOf('async function connect(roomId, asHost)');
    assert.notEqual(start, -1, 'connect() must be async to await the identity');
    const body = APP.slice(start, APP.indexOf('function stop(', start));
    const ensure = body.indexOf('await ensureCollabIdentity()'), url = body.indexOf('wsUrl(roomId)');
    assert.ok(ensure !== -1 && url !== -1 && ensure < url);
  });
});

describe('(b) a #live= guest restores a saved forge session before joining', () => {
  function enter({ hash, collabUrl, tryInit = async () => {}, ensure = async () => {} }) {
    const calls = [];
    const CloudStore = { tryInit: async () => { calls.push('tryInit'); await tryInit(); } };
    const Collab = { join: room => calls.push('join:' + room) };
    const fns = loadFns(['tryEnterLiveSession'], {
      location: { hash }, COLLAB: { url: collabUrl }, CloudStore, Collab,
      ensureCollabIdentity: async () => { calls.push('ensure'); await ensure(); },
      $: () => null, render: () => calls.push('render'),
      map: null, sel: null, history: [], hpos: -1, Store: null, MODE: 'local',
    });
    return { run: () => fns.tryEnterLiveSession(), calls };
  }
  test('with a backend: session restored, identity requested, then the room is joined', async () => {
    const { run, calls } = enter({ hash: '#live=abc%20d', collabUrl: 'https://maps.example.org' });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['render', 'tryInit', 'ensure', 'join:abc d']);
  });
  test('a failing session restore still joins - as an anonymous guest, as before', async () => {
    const { run, calls } = enter({ hash: '#live=abc', collabUrl: 'https://maps.example.org', tryInit: async () => { throw new Error('no saved session'); } });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['render', 'tryInit', 'ensure', 'join:abc']);
  });
  test('without a backend nothing is restored and the join is unchanged', async () => {
    const { run, calls } = enter({ hash: '#live=abc', collabUrl: '' });
    assert.equal(await run(), true);
    assert.deepEqual(calls, ['render', 'join:abc']);
  });
  test('no #live= hash: false, nothing touched', async () => {
    const { run, calls } = enter({ hash: '#view=xyz', collabUrl: 'https://maps.example.org' });
    assert.equal(await run(), false);
    assert.deepEqual(calls, []);
  });
});
