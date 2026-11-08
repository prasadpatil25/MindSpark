# Contributing to MindSpark

Thanks for taking the time. This file covers what you need to get set up and
what CI will check, so nothing about your PR is a surprise.

## Getting it running

You need **Node 22 or newer** - nothing else. MindSpark has no runtime
dependencies; it uses Node's built-in HTTP server and its built-in SQLite.

```bash
git clone https://github.com/prasadpatil25/MindSpark.git
cd MindSpark
npm start          # http://localhost:3000
```

`npm run dev` does the same with `--watch`, restarting on file changes.

There is no build step and no bundler. `public/app.js` is loaded directly by
the browser as a plain script, so what you edit is what runs - just reload.

### Where things live

| Path | What it is |
|---|---|
| `public/app.js` | The client. Plain script, no modules or build step. |
| `public/templates.js` | Prompt template data, split out of `app.js` for size. Loaded **before** it - see the note in that file. |
| `public/sw.js` | Service worker (offline shell caching). |
| `public/styles.css` | All styling, including themes and looks. |
| `server.js` | Local dev server + SQLite persistence. |
| `worker/` | Cloudflare Worker: sharing, collab, import endpoint. |
| `test/` | Test suite (`node:test`, no framework). |

## Running the tests

```bash
npm test
```

All tests are plain `node:test` - no framework, no dependencies to install.

`public/app.js` has no module exports, so it can't be imported. Tests for it
use `test/helpers/load-app-fns.mjs`, which reads the **real source files** and
lifts out individual function declarations. It searches every client script,
so it keeps working if a function moves between them. That means tests exercise the
shipped code rather than a copy that could quietly drift - but it also means
**renaming or deleting one of those functions will fail the tests**. If that
happens, update the name in the relevant test; don't work around the harness.

### Adding tests

Worth doing for anything in `worker/` (it's importable, so testing is easy) and
for pure functions in `app.js`. Anything requiring a real browser - layout,
rendering, drag behaviour - isn't currently covered; say so in the PR rather
than trying to fake it.

## What CI checks

Every push and pull request runs:

1. `npm test`
2. `node --check` on every tracked `.js` / `.mjs` file
3. YAML validation of everything under `.github/`
4. A smoke test that boots the server and asserts `/`, `/app.js`,
   `/styles.css` and `/api/maps` all return 200

CI must pass before a PR can merge into `main`. You can run all of it locally
before pushing - the commands above are the same ones CI runs.

## Pull requests

**Keep one PR to one change.** This is the single most useful thing you can do
for review. A PR that says "add feature X" and also quietly reformats a file,
bumps a dependency, or removes something unrelated is much harder to review
than two separate PRs, and it's easy to do by accident when working from an
older fork.

If your fork has drifted, rebase or merge `main` into it first so the diff
shows only your changes:

```bash
git remote add upstream https://github.com/prasadpatil25/MindSpark.git
git fetch upstream
git rebase upstream/main
```

**Explain the why, not just the what.** The diff already shows what changed.
What helps is the reasoning - especially for anything touching auth, sharing,
or storage.

**Flag anything you couldn't test.** That's genuinely useful information, not
an admission of sloppiness.

## Code conventions

There's no linter or formatter - please match the surrounding style rather than
reformatting.

- **Zero runtime dependencies.** This is deliberate: MindSpark self-hosts from
  a single file with no install step. A PR adding a runtime dependency needs a
  strong argument. Dev-only dependencies are a different matter.
- **No build step.** Anything requiring compilation or bundling to run in the
  browser changes the project's basic shape - please open an issue first.
- **Empty `catch(e){}` needs a reason.** See the comment block at the top of
  `public/app.js`. Silent catches are fine for best-effort storage writes, DOM
  teardown, and cosmetic operations. They are not fine for anything that can
  lose the user's work, leave local and remote state disagreeing, or make a
  click do nothing. Those should `console.warn`, and `toast()` too if the user
  initiated the action.

## Optional authenticated hosts

A host may define `window.MINDSPARK_HOST` before loading `app.js`:

```js
window.MINDSPARK_HOST = {
  store,                  // list/get/save/remove/history/version, like ServerStore
  async ready() {},        // validate the session/storage before boot
  onError(error) {},       // display a persistent boot error, without losing edits
  shareBase: 'https://your-host.example/' // optional snapshot-link entry point
};
```

The host is responsible for authentication, ownership checks, browser-storage
isolation, error reporting on storage operations, and the safety of `shareBase`.
The store should reject failed operations rather than return an empty library.
The editor keeps server-mode editing and autosave behavior, but hosted boot/load
errors propagate to `onError` and do not create a fallback map or switch to a
forge. Hosts skip the offline service worker so cached pages do not bypass their
session lifecycle. Without this object, standalone behavior is unchanged.

This is not a built-in account system or a browser security sandbox. Keep host
code separate from the editor and test both standalone and hosted behavior.
`test/hosted-store.test.mjs` covers the opt-in contract.

## Reporting bugs

Please include which storage mode you were in - local (`node server.js`) or
cloud (signed in with GitHub) - since a lot of behaviour differs between them.
A screenshot helps enormously for anything visual, and the browser console
often contains the actual error.
