# MindSpark Themes

`themes/*.json` are **reference palettes** for the Colour Theme picker (`public/app.js:8787` `THEMES`, `public/styles.css:21` `:root[data-theme="..."]`). They are not fetched at boot - the picker is hardcoded for instant offline switching. Use these JSON files to **import** a theme via **Add theme** or to propose a new built-in.

## File count
81 JSON files, each one complete palette. Example `light.json` / `dark.json`.

Light palettes are the largest group. Some are drawn from interfaces people
already know - `google-light`, `youtube-light`, `notion-light`, `figma-light`,
`slack-light`, `apple-light`, `stripe-light`, `vercel-light`, `linear-light`,
`fluent-light`, `github-light` - and the rest stand on their own:
`porcelain`, `alabaster`, `salt-flat`, `pearl-mist`, `chalk-studio`,
`rice-paper`, `paper-ink`, `scholar-parchment`, `sandstone`, `light`.

## JSON structure

```json
{
  "v": 1,
  "id": "my-theme",
  "name": "My Theme",
  "vars": {
    "--toolbar-bg": "#23201b",
    "--toolbar-text": "#ffffff",
    "--paper": "#f4efe6",
    "--paper-2": "#efe8db",
    "--ink": "#23201b",
    "--ink-soft": "#6b6357",
    "--line": "#d8cfbf",
    "--line-2": "#c8bda8",
    "--accent": "#e0613a",
    "--accent-deep": "#b8451f",
    "--teal": "#2f6f6a",
    "--chrome": "#fbf8f2",
    "--chrome-edge": "#e7ddcc",
    "--node-bg": "#ffffff",
    "--node-ink": "#23201b",
    "--canvas-dot": "#d8cfbf",
    "--stage-glow": "rgba(255,255,255,.5)",
    "--link": "#b8451f",
    "--shadow": "0 2px 4px rgba(40,30,15,.06),0 8px 24px rgba(40,30,15,.10)",
    "--shadow-lg": "0 10px 40px rgba(40,30,15,.18)"
  }
}
```

### Fields

| Field | Type | Constraints | Purpose |
|-------|------|-------------|---------|
| `v` | number | `1` | schema version |
| `id` | string | `^[a-z0-9-]{1,40}$` lowercase, digits, dash | `data-theme` value, used in `localStorage:mindspark:theme` |
| `name` | string | `1-40` chars, trimmed | Display name in picker (`buildSwatchHTML` `public/app.js:10599`) |
| `vars` | object | 20 keys, each `1-80` chars trimmed | CSS custom properties (see below) |

All 20 vars are **required** - `public/app.js:9468` `validateCustomTheme()` rejects if any missing/empty.

### Vars table (20)

| Var | Used for |
|-----|----------|
| `--toolbar-bg` / `--toolbar-text` | Top bar (`public/styles.css:1080` `.topbar`) |
| `--paper` / `--paper-2` | Canvas background (`styles.css:1071` `.stage`) + alternate |
| `--ink` / `--ink-soft` | Primary/secondary text (`styles.css:1003` `.side`, `styles.css:1067` `.side-foot`) |
| `--line` / `--line-2` | Borders, dividers |
| `--accent` / `--accent-deep` | Primary accent (buttons, selection, `qotd` `styles.css:1069`) |
| `--teal` | Secondary accent (links, alternative) |
| `--chrome` / `--chrome-edge` | Sidebar, panels, chrome surfaces |
| `--node-bg` / `--node-ink` | Mind-map nodes (`styles.css:1076` `#viewport`) |
| `--canvas-dot` | Dot grid (`styles.css:1072`) |
| `--stage-glow` | Radial glow (`styles.css:1074` `.stage:before`) |
| `--link` | Links |
| `--shadow` / `--shadow-lg` | Shadows (`--shadow` nodes, `--shadow-lg` modals) |

Values are any CSS color/length - hex `#rrggbb`, `rgb()`, `rgba()`, `hsla()` for colors; shadows as `box-shadow` strings. Keep `stage-glow` translucent (`rgba(..., .04-.5)`) for subtlety.

## How to use

### 1. Import via Add theme (no code change)
1. Copy any `themes/*.json` (e.g. `themes/dark.json`)
2. Open MindSpark → **Theme** (🎨) → **Colour theme** → **Add theme** (bottom-right, `public/app.js:10599` `tp-scroll-2rows`)
3. Paste JSON into textarea, **Import**. Only one custom slot - importing again replaces it (`localStorage:mindspark:custom-theme` `app.js:9481`).

The picker also shows `lib-grid` (`styles.css:1886`) - one-click import of any built-in beyond the visible 2×4 grid.

### 2. Propose a new built-in
1. Create `themes/<id>.json` with 20 vars.
2. Add entry to `THEMES` (`public/app.js:8787` `{id,name,swatch:[paper,chrome,accent]}`) and CSS block `:root[data-theme="<id>"]{...}` (`public/styles.css:21`).
3. Run `npm test` (`435` tests include theme panel) and `node --check public/app.js`.

## Validation
`validateCustomTheme()` (`public/app.js:9468`) checks:
- `id` regex, `name` length, `vars` 20 keys, each trimmed `1-80` chars.
- Unknown keys ignored, empty strings rejected.

## Tips
- Start from `light.json` (warm) or `dark.json` (dark) and tweak `accent` + `paper` first.
- Test both light and dark `stage-glow` opacity - too strong washes canvas.
- Use `color-mix(in srgb, var(--accent) 7%, transparent)` for subtle surfaces like `qotd` (`styles.css:1069`).

## License
MIT - same as MindSpark root.
