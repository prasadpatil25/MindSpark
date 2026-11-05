# Layout presets

Each file here is a complete MindSpark layout, expressed as JSON. To use one:
open the theme panel (🎨), find **Layout**, scroll to the **Import** tile, and
paste the file's contents.

Imported layouts are saved on your device. The maps you apply them to are not
affected - a map records the resolved strategy and parameters, so a map using
a layout you imported still renders correctly for someone who has never seen
it.

## Why these are data, not code

A layout picks one of the placement **strategies** MindSpark implements
and tunes it. It cannot define a new algorithm, and that is deliberate: a
layout travels inside every `#view=` share link, so anything executable here
would run on the machine of whoever opened a shared map.

| Strategy | Shape | Key parameters |
|---|---|---|
| `tree`   | Branches growing from a root | `axis`, `dir`, `split`, `rootAnchor` |
| `chain`  | A sequence along an axis with sub-trees hanging off | `axis`, `dir`, `alternate`, `start`, `stem` |
| `radial` | Root at the centre, depth as distance | `ring`, `startAngle`, `sweep` |
| `grid`   | Top-level topics as cards, sub-trees as outlines | `columns`, `indent` |
| `matrix` | Columns with rows aligned across them, like a table | `colGap`, `rowGap`, `cellGap` |
| `treetable` | Depth as columns, each block spanning its subtree | `colGap`, `rowGap`, `rootSide` |

`chain` also takes an `angle`: 90 is square to the spine (a timeline), and
anything less slants the ribs (a fishbone). Existing timelines are unaffected,
since 90 is the default.

`treetable` also takes a `rootSide`: `left` (the default), `right`, `top` or
`bottom`. The gap between depth levels is always `colGap` and the gap between
sibling blocks is always `rowGap`, whichever edge the root sits on.

Values outside the allowed range are clamped and unrecognised keys are ignored,
so a layout written against a newer version still loads - it just ignores what
it does not understand.

## Writing your own

The quickest route is to copy an existing map's layout: open the cog beside
**Layout** to see the current settings as JSON, adjust, then paste into the
Import dialog with an `id` and `name` added.

`id` must be letters, digits and dashes only; `name` is what appears in the
picker and is truncated past 24 characters.
