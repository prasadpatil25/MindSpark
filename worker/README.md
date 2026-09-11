# MindSpark - GitHub OAuth Worker (optional)

MindSpark works fully static with the **personal access token (PAT)** login and
no backend. This optional Cloudflare Worker adds a friendlier **"Sign in with
GitHub"** button by performing the OAuth `code → token` exchange (which needs the
OAuth App *client secret*, so it can't run in the browser).

If you don't deploy this and leave `GH_OAUTH` blank in `public/app.js`, only the
PAT login shows - nothing else changes.

## Deploy

1. **Create a GitHub OAuth App** → https://github.com/settings/developers → *New OAuth App*
   - **Homepage URL:** your MindSpark URL
   - **Authorization callback URL:** `https://<your-worker>.workers.dev/callback`
   - Copy the **Client ID**; click **Generate a new client secret** and copy it.

2. **Set the secrets** (from this `worker/` folder):
   ```sh
   npm i -g wrangler        # or use: npx wrangler ...
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   ```

3. **Restrict token delivery (strongly recommended)** - in `wrangler.toml` add:
   ```toml
   [vars]
   ALLOWED_ORIGIN = "https://your-mindspark-app.example.com"
   ```
   With this set, the Worker will hand the token only to your app's origin.
   Without it, the token is posted with `'*'`, which a malicious page that
   opens the OAuth flow itself could intercept.

4. **Deploy:**
   ```sh
   wrangler deploy
   ```

5. **Point the app at it** - in `public/app.js`:
   ```js
   const GH_OAUTH = {
     clientId:  '<your client id>',
     workerUrl: 'https://<your-worker>.workers.dev',
     appOrigin: 'https://your-mindspark-app.example.com'   // = ALLOWED_ORIGIN above
   };
   ```
   `appOrigin` must be the exact origin the app is served from. The button is
   shown only on that origin, so a copy of `public/` running anywhere else
   (another domain, localhost) falls back to the token login instead of sending
   its users through your OAuth App and worker. If the two values disagree, the
   popup closes without delivering a token and the overlay says so.

That's it. The login overlay now shows **Sign in with GitHub** above the existing
token option. Both produce a GitHub token that the app uses identically.

## How it works / security

- The popup hits GitHub's authorize page, then GitHub redirects to the Worker's
  `/callback` with a one-time `code` and your `state` nonce.
- The Worker exchanges the `code` for a token using the **client secret** (never
  exposed to the browser) and `postMessage`s the token back to the app window.
- The app accepts it only if the message **origin == your Worker origin** and the
  **`state` matches** the nonce it generated - guarding against CSRF / spoofing.
- The OAuth App `repo` scope lets MindSpark create and read/write its private
  `mindspark-maps` repository. For tighter, per-repo access, use a GitHub *App*
  instead of an OAuth App (more setup; not required).

## GPT map import (`POST /api/import`) - share-link, no PAT

The worker turns a generated map spec into the same gzip+base64url **`#view=`
share link** the app's "Copy share link" feature produces. It writes nothing to
GitHub and needs **no personal access token** - so it works for every user.

Flow: GPT calls `/api/import` -> worker returns `https://<app>/#view=<token>` ->
the user opens it (read-only, no login needed) -> clicks **"Make an editable
copy"** -> the map is saved into *their own* repo with *their own* token.

Setup:
1. `wrangler secret put IMPORT_TOKEN` (a random secret; also goes in the GPT Action auth).
2. Ensure `ALLOWED_ORIGIN` = your app URL (e.g. https://mindspark.githubpage.workers.dev) -
   it's used to build the link and is likely already set for OAuth.
3. Deploy: `npx wrangler deploy --config worker/wrangler.toml`.

In the Custom GPT Action: `servers.url` = this worker's URL; Auth = API Key ->
Bearer -> your `IMPORT_TOKEN`. The endpoint returns `{ id, url }` where `url`
is the share link.

Note: the whole map travels inside the URL, so very large maps make very long
links. Typical generated maps are well under 2 KB; multi-hundred-node maps could
approach browser URL limits.
