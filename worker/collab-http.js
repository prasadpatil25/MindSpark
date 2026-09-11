// MindSpark - collab map HTTP API + ACL routing (no Cloudflare imports, testable).
// The Durable Object delegates here, passing a storage adapter ({get,put} async) and
// env. Returns { status, body }; the DO wraps it with CORS into a Response.
import { verifyJWT, authorizeRequest } from './auth-core.js';

async function identityOf(env, request){
  const secret = env && env.AUTH_SECRET; if(!secret) return null;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i); if(!m) return null;
  const p = await verifyJWT(m[1], secret); if(!p || p.sub == null) return null;
  return { sub: String(p.sub), login: p.login || '' };
}
async function authz(storage, env, request, need, allowClaim){
  const acl = await storage.get('acl');
  const editToken = await storage.get('editToken');
  const ident = await identityOf(env, request);
  const d = authorizeRequest({ acl, editToken, identity: ident, tokenHeader: request.headers.get('X-Edit-Token') || '', need, allowClaim });
  return { d, ident, acl, editToken };
}
// Establish ownership / claim a legacy token per the decision flags. Returns the live ACL.
async function applyClaims(storage, d, ident, acl, editToken, request){
  if(d.claim && ident && !acl){
    const provided = request.headers.get('X-Edit-Token') || '';
    const tok = editToken || provided || '';
    if(tok && !editToken) await storage.put('editToken', tok);
    const newAcl = { ownerId: ident.sub, ownerLogin: ident.login, members: {}, linkAccess: tok ? 'edit-auth' : 'none' };
    await storage.put('acl', newAcl);
    return newAcl;
  }
  if(d.claimToken){
    const provided = request.headers.get('X-Edit-Token') || '';
    if(provided) await storage.put('editToken', provided);
  }
  return acl;
}
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(k){ return typeof k === 'string' && !UNSAFE_KEYS.has(k); }
function applyOps(snap, ops){
  snap.nodes = snap.nodes || {};
  for(const op of (ops || [])){
    if(op && op.t === 'node' && op.id && isSafeKey(op.id)) snap.nodes[op.id] = op.n;
    else if(op && op.t === 'del' && op.id && isSafeKey(op.id)) delete snap.nodes[op.id];
    else if(op && op.t === 'meta' && op.k && isSafeKey(op.k)) snap[op.k] = op.v;
  }
  return snap;
}

// Record a signed-in NON-owner who accessed the map, so the owner can see who has
// opened the shared link. Throttled to at most one storage write per visitor per minute.
async function recordVisitor(storage, ident, acl){
  if(!ident || !acl || String(acl.ownerId) === ident.sub) return;
  const v = await storage.get('visitors') || {};
  const prev = v[ident.sub]; const now = Date.now();
  if(prev && (now - (prev.lastSeen || 0)) < 60000) return;   // throttle
  const role = (acl.members && acl.members[ident.sub]) ? acl.members[ident.sub].role : 'link';
  v[ident.sub] = { login: ident.login || '', lastSeen: now, role };
  const keys = Object.keys(v);
  if(keys.length > 50){ keys.sort((a,b)=>(v[a].lastSeen||0)-(v[b].lastSeen||0)); for(let i=0;i<keys.length-50;i++) delete v[keys[i]]; }
  await storage.put('visitors', v);
}

export async function handleCollabHttp(storage, env, request){
  const url = new URL(request.url);
  const after = (url.pathname.split('/api/collab/')[1] || '');
  const sub = after.split('/').slice(1).join('/');     // '', 'acl', 'acl/<id>', 'link'
  const method = request.method;

  // -------- ACL management (owner only) --------
  if(sub === 'acl' || sub.startsWith('acl/') || sub === 'link'){
    const { d, ident, acl, editToken } = await authz(storage, env, request, 'admin', true);
    if(!d.ok) return { status: d.status, body: { error: d.status === 401 ? 'sign in required' : 'owner only' } };
    let cur = await applyClaims(storage, d, ident, acl, editToken, request);
    cur = cur || await storage.get('acl');

    if(sub === 'acl' && method === 'GET'){
      const visitors = await storage.get('visitors') || {};
      return { status: 200, body: { ownerId: cur.ownerId, ownerLogin: cur.ownerLogin, members: cur.members || {}, linkAccess: cur.linkAccess || 'none', visitors } };
    }
    if(sub === 'acl' && method === 'POST'){
      let b; try{ b = await request.json(); }catch(e){ return { status: 400, body: { error: 'bad json' } }; }
      const uid = String((b && b.userId) || '').trim();
      const role = (b && b.role === 'viewer') ? 'viewer' : 'editor';
      if(!uid) return { status: 400, body: { error: 'userId required' } };
      if(!isSafeKey(uid)) return { status: 400, body: { error: 'invalid userId' } };
      if(uid === String(cur.ownerId)) return { status: 400, body: { error: 'already the owner' } };
      cur.members = cur.members || {};
      cur.members[uid] = { role, login: String((b && b.login) || '') };
      await storage.put('acl', cur);
      return { status: 200, body: { ok: true, members: cur.members } };
    }
    if(sub.startsWith('acl/') && method === 'DELETE'){
      const uid = decodeURIComponent(sub.slice('acl/'.length));
      if(cur.members && cur.members[uid]){ delete cur.members[uid]; await storage.put('acl', cur); }
      return { status: 200, body: { ok: true, members: cur.members || {} } };
    }
    if(sub === 'link' && method === 'POST'){
      let b; try{ b = await request.json(); }catch(e){ return { status: 400, body: { error: 'bad json' } }; }
      const access = ['none','view','edit','view-auth','edit-auth'].includes(b && b.access) ? b.access : 'none';
      cur.linkAccess = access;
      await storage.put('acl', cur);
      return { status: 200, body: { ok: true, linkAccess: access } };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }

  // -------- Map snapshot API --------
  if(method === 'GET'){
    const { d, ident, acl } = await authz(storage, env, request, 'read', false);
    if(!d.ok) return { status: d.status, body: { error: d.status === 401 ? 'sign in required' : 'no access' } };
    await recordVisitor(storage, ident, acl);
    const snap = await storage.get('snapshot');
    return snap ? { status: 200, body: snap } : { status: 404, body: { error: 'not found' } };
  }
  if(method === 'PUT'){
    let m; try{ m = await request.json(); }catch(e){ return { status: 400, body: { error: 'bad json' } }; }
    if(!m || typeof m !== 'object') return { status: 400, body: { error: 'map object required' } };
    const { d, ident, acl, editToken } = await authz(storage, env, request, 'write', true);   // PUT may claim ownership
    if(!d.ok) return { status: d.status, body: { error: d.status === 401 ? 'sign in required' : 'no edit access' } };
    const aclAfter = await applyClaims(storage, d, ident, acl, editToken, request);
    await recordVisitor(storage, ident, aclAfter || acl);
    await storage.put('snapshot', m);
    return { status: 200, body: { ok: true } };
  }
  if(method === 'PATCH'){
    const { d, ident, acl, editToken } = await authz(storage, env, request, 'write', false);  // PATCH never claims
    if(!d.ok) return { status: d.status, body: { error: d.status === 401 ? 'sign in required' : 'no edit access' } };
    await applyClaims(storage, d, ident, acl, editToken, request);
    await recordVisitor(storage, ident, acl);
    let body; try{ body = await request.json(); }catch(e){ return { status: 400, body: { error: 'bad json' } }; }
    const ops = Array.isArray(body && body.ops) ? body.ops : [];
    let snap = await storage.get('snapshot') || { nodes: {} };
    snap = applyOps(snap, ops);
    await storage.put('snapshot', snap);
    return { status: 200, body: { ok: true, map: snap } };
  }
  return { status: 405, body: { error: 'method not allowed' } };
}
