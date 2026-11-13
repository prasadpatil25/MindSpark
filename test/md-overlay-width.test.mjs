// The highlight overlay is a div with no scrollbar, while the textarea grows one as
// soon as its content overflows. A classic scrollbar narrows the textarea's content
// box but not the overlay's, so with word wrap on every line breaks later in the
// overlay than in the textarea. The drift accumulates down the document, putting the
// caret several rows away from the active-line highlight, and the row background
// paints across the scrollbar. mdSyncOverlayWidth() sizes the overlay to the
// textarea's client width, which already excludes the scrollbar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

function harness(clientWidth = 693, offsetWidth = 709) {
  const style = { width: '', right: '' };
  const ed = { clientWidth, offsetWidth };
  const hl = { style };
  const document = {
    getElementById: id => (id === 'mdEditor' ? ed : null),
    querySelector: sel => (sel === '#mdPane .md-hl' ? hl : null),
  };
  return { document, style, ed };
}

test('the overlay takes the textarea client width, not its scrollbar-inclusive offset width', () => {
  const h = harness();
  const { mdSyncOverlayWidth } = loadFns(['mdSyncOverlayWidth'], { document: h.document });
  mdSyncOverlayWidth();
  assert.equal(h.style.width, '693px');
  assert.equal(h.style.right, 'auto');
});

test('a hidden pane does not overwrite the last usable width', () => {
  const h = harness(0);
  h.style.width = '640px';
  const { mdSyncOverlayWidth } = loadFns(['mdSyncOverlayWidth'], { document: h.document });
  mdSyncOverlayWidth();
  assert.equal(h.style.width, '640px');
});

test('a changed client width is applied on the next sync', () => {
  const h = harness(693);
  const { mdSyncOverlayWidth } = loadFns(['mdSyncOverlayWidth'], { document: h.document });
  mdSyncOverlayWidth();
  h.ed.clientWidth = 710;
  mdSyncOverlayWidth();
  assert.equal(h.style.width, '710px');
});

test('resize sync applies the width even while word wrap is off', () => {
  // Window resize and the pane divider both call mdSyncGutterRowHeights; the
  // overlay still needs narrowing when wrap is off, so the active row stops at
  // the scrollbar instead of painting under it.
  const h = harness(710, 710);
  const { mdSyncGutterRowHeights } = loadFns(['mdSyncOverlayWidth', 'mdSyncGutterRowHeights'], {
    document: h.document,
    mdWrap: false,
  });
  mdSyncGutterRowHeights();
  assert.equal(h.style.width, '710px');
});
