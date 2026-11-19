// The standalone export is one file a person can open years later with no
// server: the real stylesheet, a snapshot of the rendered stage, and a small
// view-only layer for pan/zoom. These tests pin the parts that are cheap to get
// wrong and expensive to notice - the CSP, escaping of the title/root style,
// and that no editor or network surface sneaks back in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const CSP = extractConst('STANDALONE_CSP');
const fns = loadFns(['buildStandaloneDocument', 'standaloneRootAttrs', 'escapeHtml'], { STANDALONE_CSP: CSP });
const { buildStandaloneDocument, standaloneRootAttrs } = fns;

const base = {
  title: 'A <map> & "friends"',
  root: { lang: 'en', theme: 'dark', look: 'studio', style: '--paper:#111;--ink:#eee' },
  stageHtml: '<div class="stage"><div id="viewport"><svg id="edges"></svg><div class="node root">Root</div></div></div>',
  styles: 'body{background:var(--paper)}',
  fontLinks: '<link href="https://fonts.googleapis.com/css2?family=Nunito" rel="stylesheet">',
  viewerCss: '.sv-bar{color:red}',
  viewerJs: '(function(){var stage=document.querySelector(".stage");})();',
};

describe('standalone document', () => {
  test('is a complete HTML document with inline style and script', () => {
    const doc = buildStandaloneDocument(base);
    assert.match(doc, /^<!doctype html>/i);
    assert.match(doc, /<html lang="en" data-theme="dark" data-look="studio"/);
    assert.match(doc, /<meta charset="utf-8">/);
    assert.match(doc, /<title>A &lt;map&gt; &amp; &quot;friends&quot;<\/title>/);
    assert.match(doc, /body\{background:var\(--paper\)\}/);
    assert.match(doc, /\.sv-bar\{color:red\}/);
    assert.match(doc, /<div class="stage">/);
    assert.match(doc, /fonts\.googleapis\.com/);
    assert.match(doc, /standalone-viewer/);
    assert.match(doc, /id="svFit"/);
    assert.doesNotMatch(doc, /<script[^>]+src=/i, 'the viewer must not load a script');
    assert.doesNotMatch(doc, /\bapp\.js\b/);
  });

  test('the title is escaped everywhere it appears', () => {
    const doc = buildStandaloneDocument({ ...base, title: '<img src=x onerror=alert(1)>' });
    assert.equal((doc.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length, 2,
      'both the <title> and the visible title pill must be escaped');
    assert.doesNotMatch(doc, /<img src=x/);
  });

  test('root palette variables survive, quoted values included', () => {
    const doc = buildStandaloneDocument({
      ...base,
      root: { lang: 'en', style: '--sans:"Caveat",cursive;--paper:#fff' },
    });
    assert.match(doc, /style="--sans:&quot;Caveat&quot;,cursive;--paper:#fff"/);
  });

  test('the CSP permits the export and nothing to talk to', () => {
    assert.match(CSP, /default-src 'none'/);
    assert.match(CSP, /script-src 'unsafe-inline'/);
    assert.match(CSP, /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    assert.match(CSP, /img-src data: blob: http: https:/);
    assert.match(CSP, /base-uri 'none'/);
    assert.match(CSP, /form-action 'none'/);
    assert.doesNotMatch(CSP, /connect-src/, 'the viewer must not be able to fetch');
    assert.doesNotMatch(CSP, /'self'/);
    const doc = buildStandaloneDocument(base);
    assert.ok(doc.includes('content="' + CSP + '"'));
  });

  test('a closing style or script tag inside the payload cannot break out', () => {
    const doc = buildStandaloneDocument({
      ...base,
      styles: 'a{content:"</style>"}',
      viewerCss: 'b{content:"</style>"}',
      viewerJs: 'var x="</script>";',
    });
    // The only real closing tags are the wrappers themselves; the payload's
    // copies carry a backslash and cannot terminate the block.
    assert.equal((doc.match(/<style>/g) || []).length, 2);
    assert.equal((doc.match(/<\/style>/g) || []).length, 2);
    assert.equal((doc.match(/<script>/g) || []).length, 1);
    assert.equal((doc.match(/<\/script>/g) || []).length, 1);
    assert.ok(doc.includes('<\\/style>'));
    assert.ok(doc.includes('<\\/script>'));
  });
});

describe('standalone root attributes', () => {
  test('keeps theme variables but drops the app UI scale', () => {
    const values = {
      '--paper': '#222',
      '--ui-zoom': '0.8',
      'zoom': '0.8',
      '--shared-banner-h': '42px',
      '--look-node-size': '1.1',
    };
    const keys = Object.keys(values);
    const style = { length: keys.length, getPropertyValue: p => values[p] };
    keys.forEach((k, i) => { style[i] = k; });
    const root = {
      getAttribute: name => ({ lang: 'en', dir: 'rtl', 'data-theme': 'dark', 'data-look': 'studio' })[name] || null,
      style,
    };
    const attrs = standaloneRootAttrs(root);
    assert.equal(attrs.lang, 'en');
    assert.equal(attrs.dir, 'rtl');
    assert.equal(attrs.theme, 'dark');
    assert.equal(attrs.look, 'studio');
    assert.match(attrs.style, /--paper:#222/);
    assert.match(attrs.style, /--look-node-size:1\.1/);
    assert.doesNotMatch(attrs.style, /ui-zoom|shared-banner|(^|;)zoom:/);
  });

  test('no inline variables means no empty style attribute', () => {
    const root = { getAttribute: () => null, style: { length: 0, getPropertyValue: () => '' } };
    assert.deepEqual(standaloneRootAttrs(root), {});
  });
});
