// The colour squares beside a textarea's colour literals are an overlay laid
// over the textarea. A square for a line scrolled out of view showed just
// below the box: the wrapper was a few px taller than the textarea (inline
// baseline gap), and nothing skipped squares outside the visible text area.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

describe('colour swatches stay inside the textarea', () => {
  test('only squares wholly inside the visible text area are drawn', () => {
    const src = extractFunction('attachColorSwatches');
    assert.match(src, /if\(x < 0 \|\| y < 0 \|\| y \+ CS_SIZE > ta\.clientHeight \|\| x \+ CS_SIZE > ta\.clientWidth\) continue;/);
  });

  test('the wrapped textarea is a block, so the overlay is exactly the textarea\'s box', () => {
    assert.match(CSS, /\.cs-wrap > textarea\{display:block\}/);
    assert.match(CSS, /\.cs-layer\{position:absolute; inset:0; overflow:hidden/);
  });
});
