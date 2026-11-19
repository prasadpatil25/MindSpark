// A node can be narrower than its hover date (a short "Hi" topic, or a card the user
// resized smaller). The watermark used to be pinned to the node's width with
// overflow:hidden, so the date was trimmed to an ellipsis. It must size to its own text
// and stay centered over the node instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('the node date watermark sizes to its text instead of being clipped', () => {
  const match = CSS.match(/\.node \.node-watermark\{([^}]*)\}/);
  assert.ok(match, '.node .node-watermark rule not found');
  const rule = match[1];
  assert.match(rule, /left:50%/);
  assert.match(rule, /right:auto/);
  assert.match(rule, /width:max-content/);
  assert.match(rule, /transform:translateX\(-50%\)/);
  assert.doesNotMatch(rule, /overflow:hidden/);
  assert.doesNotMatch(rule, /text-overflow:ellipsis/);
});
