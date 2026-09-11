// An OAuth access token from a PKCE sign-in expires (GitLab: two hours) while
// the refresh token it came with does not. The store refreshes on a 401 (see
// cloudstore-requests.test.mjs); this covers the app around it - the refresh
// token has to reach the store at sign-in, and a session that cannot be
// refreshed has to end at the sign-in screen with the reason, not as "Map
// not found" on a map that is right there.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

describe('refresh token at sign-in', () => {
  test('the PKCE exchange hands the refresh token and client id to the login', async () => {
    const FORGES = extractConst('FORGES');
    globalThis.FORGES = FORGES;   // descriptor methods reach for the registry by its global name
    const state = { forgeId: 'gitlab', state: 'S1', verifier: 'V1', instance: 'https://git.example', clientId: 'cid-9' };
    const store = new Map([['mindspark:forge:oauthstate', JSON.stringify(state)]]);
    const localStorage = { getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k), setItem: (k, v) => store.set(k, v) };
    const posted = [];
    const fetch = async (url, opt) => {
      posted.push({ url, body: Object.fromEntries(new URLSearchParams(opt.body)) });
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 7200 }) };
    };
    const logins = [];
    const said = [];
    const { finishForgeLogin } = new Function('FORGES', 'FORGE_OAUTH_STATE', 'localStorage', 'fetch', 'forgeSay', 'oauthRedirectUri', 'completeCloudLogin',
      `${extractFunction('finishForgeLogin')}\nreturn { finishForgeLogin };`)(
      FORGES, 'mindspark:forge:oauthstate', localStorage, fetch, (id, m) => said.push(m), () => 'https://app.example/oauth-callback.html',
      async (...a) => { logins.push(a); });

    await finishForgeLogin('CODE', 'S1');

    assert.deepEqual(said.filter(Boolean), [], 'no error surfaced');
    assert.equal(posted[0].url, 'https://git.example/oauth/token');
    assert.equal(posted[0].body.grant_type, 'authorization_code');
    assert.deepEqual(logins, [['AT', 'gitlab', 'https://git.example', { token: 'RT', clientId: 'cid-9' }]],
      'access token, forge, instance, and the refresh pair the store will need two hours from now');
  });

  test('completeCloudLogin forwards the refresh pair to CloudStore.login', () => {
    const src = extractFunction('completeCloudLogin');
    assert.match(src, /CloudStore\.login\([^)]*repoTargetFor\([^)]*\),\s*refresh\)/, 'refresh must be the argument after the repository target');
  });
});

describe('an expired session', () => {
  test('the sign-in screen can say the session expired', () => {
    const src = extractFunction('showLoginOverlay');
    assert.match(src, /opts\s*&&\s*opts\.expired/, 'showLoginOverlay must accept {expired:true}');
    assert.match(src, /session (has )?expired/i, 'and tell the user in those words');
  });

  test('the store tells the app, and the app goes to sign-in with that reason', () => {
    // Mid-session: a save or open hits a 401 the refresh cannot repair.
    assert.match(APP, /CloudStore\.onSessionExpired\s*=/, 'the hook must be wired');
    const hook = APP.slice(APP.search(/CloudStore\.onSessionExpired\s*=/));
    assert.match(hook.slice(0, 600), /showLoginOverlay\(\{\s*expired:\s*true/, 'the hook opens the sign-in screen with the reason');
    // At boot: tryInit() failed because the stored session could not be refreshed.
    const boot = APP.slice(APP.indexOf('const {mode, loggedIn} = await initStore();'));
    assert.match(boot.slice(0, 700), /showLoginOverlay\(\s*CloudStore\.sessionExpired\s*\?/, 'boot passes the reason on instead of a plain sign-in');
  });
});
