// Gitea/Forgejo sign-in uses OAuth2 authorization-code + PKCE with a PUBLIC
// client: there is no client secret, so the ONLY thing standing between an
// intercepted authorization code and someone else's account is that the code
// can be redeemed just once, by the browser that can produce the verifier whose
// SHA-256 it committed to up front.
//
// That makes the challenge derivation security-critical and completely silent
// when wrong: a `plain`-style or mis-encoded challenge still completes the flow
// on a permissive server. So it is checked against the RFC 7636 Appendix B
// vector rather than against itself.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const APP_URL = 'https://maps.example.org/MindSpark/index.html';
const { pkceVerifier, b64urlFromBytes, pkceChallenge, oauthRedirectUri } =
  loadFns(['pkceVerifier', 'b64urlFromBytes', 'pkceChallenge', 'oauthRedirectUri'],
          { location: { href: APP_URL, origin: 'https://maps.example.org' } });

describe('PKCE', () => {
  test('challenge matches the RFC 7636 Appendix B vector', async () => {
    // If this fails, every instance that actually enforces PKCE will reject the
    // exchange - and any instance that does not will accept a forged one.
    assert.equal(
      await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('base64url output carries no standard-base64 characters', () => {
    // +, / and = are all legal in a query string only when escaped; getting this
    // wrong produces a challenge that mismatches on some servers and not others.
    const out = b64urlFromBytes(new Uint8Array([251, 255, 190, 0, 16, 65]));
    assert.match(out, /^[A-Za-z0-9_-]+$/);
    assert.ok(!/[+/=]/.test(out));
  });

  test('verifiers meet the RFC length and alphabet rules, and never repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const v = pkceVerifier();
      assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length}`);
      assert.match(v, /^[A-Za-z0-9\-._~]+$/, 'verifier alphabet');
      assert.ok(!seen.has(v), 'verifier repeated - not drawn from a CSPRNG?');
      seen.add(v);
    }
  });

  test('the redirect URI resolves next to the app, not to the site root', () => {
    // Gitea requires the redirect_uri to be byte-identical across the authorize
    // request, the token request and the registered app. A project-page deploy
    // (/MindSpark/) is the case a root-relative path would silently break.
    assert.equal(oauthRedirectUri(), 'https://maps.example.org/MindSpark/oauth-callback.html');
  });
});

describe('OAuth callback page', () => {
  const page = read('public', 'oauth-callback.html');

  test('posts the code only to its own origin', () => {
    assert.match(page, /postMessage\([^)]*,\s*location\.origin\s*\)/,
      'the callback must pin the target origin, never postMessage(..., "*")');
    assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(page),
      'a wildcard target origin would hand the authorization code to any listener');
  });

  test('never holds the access token itself', () => {
    // Only the opener has the code_verifier, so the exchange belongs there. If
    // this page ever grew a token request it would also need the verifier, i.e.
    // the secret would start travelling between windows.
    assert.ok(!/access_token/.test(page), 'the callback page must not exchange or handle tokens');
    assert.ok(!/localStorage/.test(page), 'the callback page must not touch app storage');
  });

  test('ships its own strict policy', () => {
    // It is a separate document, so the app's <meta> policy does not cover it,
    // and GitHub Pages sends no headers.
    const m = page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(m, 'oauth-callback.html has no CSP');
    assert.match(m[1], /default-src 'none'/);
    assert.ok(!/https?:\/\//.test(m[1]), 'the callback page needs no external origin');
  });
});

describe('sign-in card', () => {
  const html = read('public', 'index.html');
  const css = read('public', 'styles.css');

  test('cannot grow past the viewport', () => {
    // Two hosts x two methods made this card tall enough that the Sign in button
    // fell below the fold on a short window, with no way to scroll to it.
    const card = css.match(/\.login-card\{([\s\S]*?)\}/);
    assert.ok(card, '.login-card rule not found');
    assert.match(card[1], /max-height:\s*100%/, 'the card must be capped to its overlay');
    assert.match(card[1], /overflow-y:\s*auto/, 'the capped card must scroll internally');
    // Deliberately NOT vh: the app scales its whole UI at small viewports, so at
    // 0.8x a 600px window is 750 CSS px of usable space and a vh cap clips the
    // card hundreds of pixels short of the room it has.
    assert.ok(!/max-height:\s*calc\(100vh/.test(card[1]),
      'vh under-measures the scaled UI - size the card against the overlay instead');
    const overlay = css.match(/\.login-overlay\{([\s\S]*?)\}/);
    assert.match(overlay[1], /padding:/, 'the overlay must supply the gutter the card sizes against');
    assert.match(overlay[1], /box-sizing:\s*border-box/, 'without border-box the padding would overflow');
  });

  test('every host offers both sign-in methods', () => {
    for (const id of ['ghOauthBtn', 'ghTokenDetails', 'giteaOauthBtn', 'giteaTokenDetails']) {
      assert.ok(html.includes(`id="${id}"`), `${id} is missing from the login card`);
    }
    // The token flow is the fallback that always works, so it must be a
    // <details> that script can open - not permanently collapsed markup.
    assert.match(html, /<details class="login-token" id="ghTokenDetails">/);
    assert.match(html, /<details class="login-token" id="giteaTokenDetails">/);
  });

  test('the PKCE client id is never treated as a secret', () => {
    const app = read('public', 'app.js');
    // Matches it being SENT (an object key or assignment), not merely named -
    // the GitHub worker comment legitimately mentions holding one server-side.
    assert.ok(!/client_secret['"`]?\s*[:=]/.test(app),
      'a public client must never send a client secret from the browser');
    assert.match(app, /code_challenge_method=S256/, 'PKCE must use S256, not plain');
  });
});
