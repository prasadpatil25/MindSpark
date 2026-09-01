/**
 * MindSpark - open-source mind mapping server.
 *
 * ZERO dependencies. Uses Node's built-in HTTP server and built-in SQLite.
 * No `npm install` required. Just:
 *
 *   node server.js
 *
 * Requires Node.js >= 22 (for the built-in node:sqlite module).
 *
 * Environment variables (all optional):
 *   PORT     – HTTP port            (default 3000)
 *   DB_PATH  – SQLite database file (default ./data/mindspark.db)
 *   PUBLIC   – static files dir     (default ./public)
 */

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mindspark.db');
// PUBLIC collides with a standard Windows env var of the same name
// (C:\Users\Public) that every Windows machine inherits - reading it blindly
// would send static requests to the wrong folder. MS_PUBLIC is the
// unambiguous override; the legacy PUBLIC name is still honoured when it is
// not just the OS default. (The pkg launcher sets PUBLIC to the snapshot
// path, which never matches the Windows default, so that flow is unaffected.)
const PUBLIC =
  process.env.MS_PUBLIC ||
  (process.env.PUBLIC && !(process.platform === 'win32' && /^[a-zA-Z]:[\\/]Users[\\/]Public$/i.test(process.env.PUBLIC)) ? process.env.PUBLIC : null) ||
  path.join(__dirname, 'public');

// ---- database ------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS maps (
    id      TEXT PRIMARY KEY,
    title   TEXT NOT NULL DEFAULT 'Untitled map',
    color   TEXT,
    data    TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_versions (
    id    TEXT NOT NULL,
    ts    INTEGER NOT NULL,
    data  TEXT NOT NULL,
    PRIMARY KEY (id, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_versions_id ON map_versions (id, ts DESC);
`);
const Q = {
  list:   db.prepare('SELECT id, title, color, updated FROM maps ORDER BY updated DESC'),
  get:    db.prepare('SELECT data FROM maps WHERE id = ?'),
  insert: db.prepare('INSERT INTO maps (id,title,color,data,updated) VALUES (?,?,?,?,?)'),
  update: db.prepare('UPDATE maps SET title=?, color=?, data=?, updated=? WHERE id=?'),
  del:    db.prepare('DELETE FROM maps WHERE id = ?'),
  // version history
  vLatest: db.prepare('SELECT data FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 1'),
  vInsert: db.prepare('INSERT OR REPLACE INTO map_versions (id,ts,data) VALUES (?,?,?)'),
  vList:   db.prepare('SELECT ts FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 100'),
  vGet:    db.prepare('SELECT data FROM map_versions WHERE id = ? AND ts = ?'),
  vDelOld: db.prepare('DELETE FROM map_versions WHERE id = ? AND ts NOT IN (SELECT ts FROM map_versions WHERE id = ? ORDER BY ts DESC LIMIT 50)'),
  vDelAll: db.prepare('DELETE FROM map_versions WHERE id = ?')
};
const upsert = (m) => {
  const data = JSON.stringify(m);
  const updated = m.updated || Date.now();
  const r = Q.update.run(m.title || 'Untitled map', m.color || null, data, updated, m.id);
  if (r.changes === 0) Q.insert.run(m.id, m.title || 'Untitled map', m.color || null, data, updated);
  // Snapshot a version only when the content actually changed (skips no-op autosaves),
  // then prune to the most recent 50 per map.
  const last = Q.vLatest.get(m.id);
  if (!last || last.data !== data) {
    Q.vInsert.run(m.id, updated, data);
    Q.vDelOld.run(m.id, m.id);
  }
};

// ---- map import (GPT integration) ---------------------------------------
const uid = () => Math.random().toString(36).slice(2, 9);

function buildMapFromSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('body must be a JSON object');
  const title = (typeof spec.title === 'string' && spec.title.trim()) ? spec.title.trim() : 'Imported map';
  const inNodes = Array.isArray(spec.nodes) ? spec.nodes : null;
  if (!inNodes || !inNodes.length) throw new Error('nodes[] is required and must be non-empty');
  const byId = new Map();
  for (const n of inNodes) {
    if (!n || typeof n.id !== 'string' || !n.id) throw new Error('every node needs a non-empty string id');
    if (byId.has(n.id)) throw new Error('duplicate node id: ' + n.id);
    if (typeof n.text !== 'string') throw new Error('node ' + n.id + ' is missing text');
    byId.set(n.id, n);
  }
  let rootId = (typeof spec.rootId === 'string' && spec.rootId) ? spec.rootId : null;
  if (rootId && !byId.has(rootId)) throw new Error('rootId does not match any node');
  if (!rootId) {
    const roots = inNodes.filter(n => n.parent == null);
    if (roots.length !== 1) throw new Error('exactly one root node (parent=null) required, found ' + roots.length);
    rootId = roots[0].id;
  }
  for (const n of inNodes) {
    if (n.id === rootId) continue;
    if (n.parent == null) throw new Error('node ' + n.id + ' has no parent (only the root may be parent-less)');
    if (!byId.has(n.parent)) throw new Error('node ' + n.id + ' references missing parent ' + n.parent);
    if (n.parent === n.id) throw new Error('node ' + n.id + ' is its own parent');
  }
  const N = byId.size;
  for (const n of inNodes) { let cur = n, hops = 0; while (cur && cur.id !== rootId) { cur = byId.get(cur.parent); if (++hops > N) throw new Error('cycle detected near node ' + n.id); } }
  const nodes = {};
  for (const n of inNodes) {
    const node = { id: n.id, text: String(n.text), parent: n.id === rootId ? null : n.parent,
      x: 0, y: 0, side: n.id === rootId ? 'root' : null, color: (typeof n.color === 'string' && n.color) ? n.color : '#fff' };
    if (typeof n.notes === 'string' && n.notes.trim()) node.notes = n.notes;
    if (n.collapsed === true) node.collapsed = true;
    if (n.tag != null && n.tag !== '') node.tag = String(n.tag);
    if (n.citation && typeof n.citation === 'object') {
      const c = n.citation, cit = {};
      if (Array.isArray(c.authors) && c.authors.length) cit.authors = c.authors.join(', ');
      else if (typeof c.authors === 'string' && c.authors.trim()) cit.authors = c.authors.trim();
      if (c.year != null) cit.year = c.year;
      if (typeof c.title === 'string' && c.title.trim()) cit.title = c.title.trim();
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }
  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  return { id: uid(), title, titleAuto: false, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
           layout: 'balanced', rootId, nodes, links, _import: true, updated: Date.now() };
}

// ---- tiny helpers --------------------------------------------------------
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json' };
// Response types worth gzipping - every text-ish MIME above, and nothing that
// is already compressed (png/ico). This Set is the decision: it used to sit here
// as a list of file EXTENSIONS that nothing read, beside a hand-rolled MIME
// substring match that made the real call, so editing it did nothing.
const COMPRESSIBLE = new Set([
  'text/html', 'text/javascript', 'text/css',
  'application/json', 'image/svg+xml', 'application/manifest+json',
]);
const GZIP_MIN = 1024;   // below this, the gzip header costs more than it saves
// `entry` is an optional file-cache row; when present its gzip is computed once
// and reused, instead of re-running gzipSync on every request for bytes that
// have not changed. API responses pass nothing and still compress per response,
// which is correct - they are generated fresh each time.
const send = (res, code, body, type='application/json', req, entry) => {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const accept = req && req.headers && req.headers['accept-encoding'] || '';
  if(buf.length>GZIP_MIN && accept.includes('gzip') && COMPRESSIBLE.has(type)){
    try{
      const gz = entry
        ? (entry.gz !== undefined ? entry.gz : (entry.gz = zlib.gzipSync(buf)))
        : zlib.gzipSync(buf);
      if(gz.length < buf.length){
        res.writeHead(code, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': gz.length });
        return res.end(gz);
      }
    }catch(e){}
  }
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 8e6) { req.destroy(); reject(new Error('payload too large')); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// ---- static file cache ----------------------------------------------------
// app.js is ~670 KB and every page load re-reads it from disk. Keep file bytes
// in memory, invalidated by mtime so live edits during `node --watch` dev are
// still picked up. Client-facing Cache-Control headers are untouched, so the
// freshness semantics the service worker depends on don't change.
//
// The row also carries the gzipped bytes, filled in by send() the first time a
// client asks for them. Compressing on every request cost ~16 ms of blocking CPU
// per cold page load (app.js 11.9, styles.css 3.2, templates.js 0.6, index 0.2)
// - and gzipSync is synchronous, so on one thread that stalls every other
// request in flight. An mtime change replaces the row, so `gz` can never go
// stale against `data`.
const fileCache = new Map();
function fileEntry(full, stat) {
  const hit = fileCache.get(full);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  if (fileCache.size >= 256) fileCache.clear();
  const row = { mtimeMs: stat.mtimeMs, data: fs.readFileSync(full), gz: undefined };
  fileCache.set(full, row);
  return row;
}

// ---- server --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Defense-in-depth CSP. Permits everything the app actually uses (self,
  // inline styles/script for the bootstrap, Google Fonts, data:/blob: images,
  // and the GitHub API for cloud mode) while blocking external script/exfil
  // origins, framing, and plugins. Relax if you self-host extra integrations.
  //
  // This header only covers server mode. The static deployments can't send
  // headers, so the same policy is duplicated in public/index.html (<meta>) and
  // public/_headers - and test/csp.test.mjs fails if the three drift apart.
  // The only sanctioned difference: the static copies also allow the OAuth /
  // collab Worker origin, which server mode never contacts.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com https://icons.duckduckgo.com",
    "connect-src 'self' https://api.github.com https://codeberg.org https://gitea.com https://api.crossref.org https://api.anthropic.com https://api.openai.com https://api.quotable.io https://zenquotes.io https://favqs.com https://dummyjson.com https://quoteslate.vercel.app https://stoic.tekloon.net https://type.fit https://api.freeapi.app",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));

  try {
    // ----- API -----
    if (p === '/api/maps' && req.method === 'GET') return send(res, 200, Q.list.all());

    if (p === '/api/maps' && req.method === 'POST') {
      const m = await readBody(req);
      if (!m || !m.id) return send(res, 400, { error: 'missing map id' });
      upsert(m); return send(res, 201, { ok: true, id: m.id });
    }

    if (p === '/api/import' && req.method === 'POST') {
      if (process.env.IMPORT_TOKEN && req.headers.authorization !== 'Bearer ' + process.env.IMPORT_TOKEN)
        return send(res, 401, { error: 'unauthorized' });
      const spec = await readBody(req);
      let m;
      try { m = buildMapFromSpec(spec); }
      catch (e) { return send(res, 400, { error: String(e && e.message || e) }); }
      upsert(m);
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
      return send(res, 201, { id: m.id, url: `${proto}://${host}/?map=${m.id}` });
    }

    const idMatch = p.match(/^\/api\/maps\/([\w-]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (req.method === 'GET') {
        const row = Q.get.get(id);
        return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const m = await readBody(req); m.id = id; upsert(m);
        return send(res, 200, { ok: true, id });
      }
      if (req.method === 'DELETE') { Q.del.run(id); Q.vDelAll.run(id); res.writeHead(204); return res.end(); }
    }

    // ----- version history -----
    const vListMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions$/);
    if (vListMatch && req.method === 'GET') {
      return send(res, 200, Q.vList.all(vListMatch[1]).map(r => ({ ts: r.ts })));
    }
    const vGetMatch = p.match(/^\/api\/maps\/([\w-]+)\/versions\/(\d+)$/);
    if (vGetMatch && req.method === 'GET') {
      const row = Q.vGet.get(vGetMatch[1], Number(vGetMatch[2]));
      return row ? send(res, 200, row.data, 'application/json') : send(res, 404, { error: 'not found' });
    }

    if (p === '/healthz') return send(res, 200, { ok: true });

    // ----- static files -----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    // Prefix check with a trailing separator so a sibling directory like
    // "<PUBLIC>-evil" can never satisfy the check (defense in depth).
    if (full === PUBLIC || full.startsWith(PUBLIC + path.sep)) {
      let st = null;
      try { st = fs.statSync(full); } catch (e) { /* falls through to 404 */ }
      if (st && st.isFile()) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        const entry = fileEntry(full, st);
        return send(res, 200, entry.data, MIME[path.extname(full)] || 'application/octet-stream', req, entry);
      }
    }

    // If the frontend itself is missing, explain it instead of a cryptic 404.
    if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
      return send(res, 500, `<!doctype html><meta charset=utf-8>
        <style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 24px;line-height:1.6;color:#23201b}
        code{background:#f0ece3;padding:2px 6px;border-radius:5px}h1{color:#b8451f}</style>
        <h1>Frontend files not found</h1>
        <p>The server is running, but it can't find the <code>public/</code> folder with the app's files.</p>
        <p>It looked here:<br><code>${PUBLIC}</code></p>
        <p><b>Fix:</b> make sure a <code>public</code> folder (containing <code>index.html</code>,
        <code>app.js</code>, <code>styles.css</code>) sits right next to <code>server.js</code>,
        then run <code>node server.js</code> again from that folder. Re-extracting the zip usually resolves it.</p>`,
        'text/html');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  MindSpark running → http://localhost:${PORT}`);
  console.log(`  Database          → ${DB_PATH}`);
  const ok = fs.existsSync(path.join(PUBLIC, 'index.html'));
  console.log(`  Frontend          → ${PUBLIC}  ${ok ? '✓ found' : '✗ NOT FOUND'}`);
  if (!ok) {
    console.log(`\n  ⚠  public/index.html was not found at the path above.`);
    console.log(`     Make sure the "public" folder is next to server.js, then restart.`);
  }
  console.log(`  (zero dependencies - Node built-in HTTP + SQLite)\n`);
});
