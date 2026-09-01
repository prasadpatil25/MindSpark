/* ============================================================
   MindSpark - pluggable storage.
   - ServerStore: when running with `node server.js` locally (SQLite)
   - CloudStore : when deployed as static files (GitHub Pages, CF Pages,
                  Netlify, etc.). User logs in with a GitHub PAT and we
                  store each map as a JSON file inside their own private
                  `mindspark-maps` repo. No backend required.
   `initStore()` probes /healthz, then picks one.
   ============================================================ */

/* ------------------------------------------------------------
   On `catch(e){}` in this file.

   Empty catches here are deliberate, not oversights - but only for
   operations where failing is genuinely a non-event:

     - best-effort localStorage/sessionStorage writes (view state, UI
       scale, theme, backup caches). Storage can be full or blocked by
       privacy settings; every read path already copes with the value
       being absent, so there is nothing useful to say.
     - DOM teardown (`el.remove()`, closing popups) where the element
       may already be gone.
     - cosmetic niceties (caret placement, history.replaceState URL
       tidying) that no behaviour depends on.

   Anything that can lose the user's work, leave local and remote state
   disagreeing, or make a click the user just made do nothing MUST NOT
   be swallowed. Those log via console.warn, and additionally toast()
   when the user initiated the action and would otherwise see no
   response at all. A silent failure there is how a real bug once
   presented as "the sign-in popup just never appears".

   If you are adding a new catch, decide which of those two groups it
   is in. When in doubt, warn - noise in the console is cheaper than an
   invisible failure.
   ------------------------------------------------------------ */
const ServerStore = {
  async _j(url,opt){ const r=await fetch(url,opt); if(!r.ok) throw new Error(r.status); return r.status===204?null:r.json(); },
  async list(){ try{ return await this._j('/api/maps'); }catch(e){ return []; } },
  async get(id){ try{ return await this._j('/api/maps/'+id); }catch(e){ return null; } },
  async save(map){
    map.updated=Date.now();
    try{ await this._j('/api/maps/'+map.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(map)}); }
    catch(e){ await this._j('/api/maps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(map)}); }
  },
  async remove(id){ try{ await this._j('/api/maps/'+id,{method:'DELETE'}); }catch(e){ console.warn('map delete failed on the server; it is gone locally but may still exist remotely:', e.message); } },
  // Version history (SQLite-backed snapshots)
  async history(id){ try{ return await this._j('/api/maps/'+id+'/versions'); }catch(e){ return []; } },
  async version(id, ref){ try{ return await this._j('/api/maps/'+id+'/versions/'+ref); }catch(e){ return null; } }
};

const CloudStore = {
  token:null, user:null, repo:'mindspark-maps',
  shas:{}, indexSha:null, index:[],
  deleted:[], deletedSha:null,

  _headers(t=this.token){ return {Authorization:`token ${t}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}; },
  // Base64 helpers safe for UTF-8 (atob/btoa are Latin-1 only)
  _encode(s){ return btoa(unescape(encodeURIComponent(s))); },
  _decode(s){ return decodeURIComponent(escape(atob(s.replace(/\n/g,'')))); },

  // Writes that MUST succeed for core functionality (auth token, OAuth state
  // nonce) go through this instead of a raw localStorage.setItem. If storage
  // is full, the local map-backup cache (mindspark:backup:*) is the most
  // likely cause - it's written on every save/load with no cap or expiry, and
  // never cleared even for deleted maps. It's also just a recovery cache: the
  // authoritative copy of every map already lives on GitHub, so clearing it
  // to make room for something that actually blocks sign-in is always safe.
  // Returns true/false rather than throwing, so callers can show one clear,
  // actionable message instead of a raw QuotaExceededError.
  _setItemSafe(key, value){
    try{ localStorage.setItem(key, value); return true; }
    catch(e){
      if(!(e && (e.name==='QuotaExceededError' || e.code===22 || e.code===1014))) return false;
      try{
        const stale=[];
        for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && k.startsWith('mindspark:backup:')) stale.push(k); }
        stale.forEach(k=>{ try{ localStorage.removeItem(k); }catch(_){} });
      }catch(_){}
      try{ localStorage.setItem(key, value); return true; }
      catch(e2){ return false; }
    }
  },

  async _verify(t){
    const r=await fetch('https://api.github.com/user',{headers:this._headers(t)});
    if(!r.ok) throw new Error('Invalid GitHub token (HTTP '+r.status+')');
    return r.json();
  },
  async tryInit(){
    const t=localStorage.getItem('mindspark:gh:token');
    if(!t) return false;
    try{
      this.user=await this._verify(t);
      this.token=t;
      await this._ensureRepo();
      await this._loadIndex();
      await this._loadDeleted();
      return true;
    }catch(e){
      console.warn('Stored GitHub token rejected:', e.message);
      localStorage.removeItem('mindspark:gh:token');
      return false;
    }
  },
  async login(token){
    this.user=await this._verify(token);
    this.token=token;
    if(!this._setItemSafe('mindspark:gh:token', token)){
      throw new Error('Signed in, but could not save your session locally - your browser\'s storage is full. Try clearing site data for this page and signing in again.');
    }
    await this._ensureRepo();
    await this._loadIndex();
    await this._loadDeleted();
    return this.user;
  },
  logout(){
    this.token=null; this.user=null;
    this.shas={}; this.indexSha=null; this.index=[];
    this.deleted=[]; this.deletedSha=null;
    localStorage.removeItem('mindspark:gh:token');
  },
  // A fine-grained token scoped to `mindspark-maps` (the recommended login) can
  // read and write that one repo but CANNOT create it - repo creation needs
  // account-level Administration, which is exactly the breadth we're avoiding.
  // So a 404 here is only fatal for fine-grained tokens: we still try to create
  // (classic `repo` tokens succeed, and skipping step 1 is the whole reason that
  // fallback exists), and on failure say which of the two the user is holding
  // instead of blaming the scope generically.
  async _ensureRepo(){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}`,{headers:this._headers()});
    if(r.status===404){
      const cr=await fetch('https://api.github.com/user/repos',{
        method:'POST',
        headers:{...this._headers(),'Content-Type':'application/json'},
        body:JSON.stringify({name:this.repo,description:'My MindSpark mind maps',private:true,auto_init:true})
      });
      if(!cr.ok){
        const t=await cr.text();
        const fineGrained=/^github_pat_/.test(this.token||'');
        throw new Error(fineGrained
          ? 'Signed in, but there is no `'+this.repo+'` repository yet, and a fine-grained token can\'t create one. Create it on GitHub (private, with a README), then sign in again.'
          : 'Could not create '+this.repo+' (HTTP '+cr.status+'). A classic token needs the `repo` scope. '+t.slice(0,140));
      }
      await new Promise(res=>setTimeout(res,800));
    } else if(r.status===403){
      throw new Error('Token was accepted but can\'t reach `'+this.repo+'`. If it is fine-grained, check it lists that repository under Repository access and has Contents: Read and write.');
    } else if(!r.ok){
      throw new Error('Could not access repo (HTTP '+r.status+')');
    }
  },
  // Raw read of _index.json (updates indexSha). Returns [] on 404 or parse error.
  async _fetchIndexRaw(){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/_index.json`,{headers:this._headers()});
    if(r.status===404){ this.indexSha=null; return []; }
    if(!r.ok) throw new Error('Could not load index (HTTP '+r.status+')');
    const data=await r.json(); this.indexSha=data.sha;
    try{ const a=JSON.parse(this._decode(data.content)); return Array.isArray(a)?a:[]; }catch(e){ return []; }
  },
  async _loadIndex(){ this.index=await this._fetchIndexRaw(); },
  // Tombstones: ids of maps the user explicitly deleted. Persisted so a lingering
  // map file (e.g. a delete whose file-removal failed) is never resurrected.
  async _loadDeleted(){
    try{
      const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/_deleted.json`,{headers:this._headers()});
      if(!r.ok){ this.deleted=[]; this.deletedSha=null; return; }
      const data=await r.json(); this.deletedSha=data.sha;
      const a=JSON.parse(this._decode(data.content)); this.deleted=Array.isArray(a)?a:[];
    }catch(e){ this.deleted=[]; this.deletedSha=null; }
  },
  async _saveDeleted(){
    this.deletedSha=await this._writeFile('_deleted.json', JSON.stringify(this.deleted), this.deletedSha);
  },
  // List map ids present in the maps/ folder.
  async _listMapFiles(){
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/maps`,{headers:this._headers()});
    if(r.status===404) return [];
    if(!r.ok) throw new Error('Could not list maps (HTTP '+r.status+')');
    const arr=await r.json();
    return arr.filter(f=>f.type==='file'&&/\.json$/.test(f.name)).map(f=>f.name.replace(/\.json$/,''));
  },
  // Map files that exist but are absent from the index AND not tombstoned - i.e.
  // maps lost to a damaged/clobbered index. Returns ready-to-restore entries.
  async orphanMaps(){
    let fileIds; try{ fileIds=await this._listMapFiles(); }catch(e){ return []; }
    const inIndex=new Set(this.index.map(m=>m.id));
    const tomb=new Set(this.deleted);
    const ids=fileIds.filter(id=>!inIndex.has(id)&&!tomb.has(id));
    const out=[];
    for(const id of ids){
      try{
        const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/maps/${id}.json`,{headers:this._headers()});
        if(!r.ok) continue;
        const data=await r.json(); this.shas[id]=data.sha;
        const m=JSON.parse(this._decode(data.content));
        const e={id:m.id||id, title:m.title||'(untitled)', color:m.color, updated:m.updated||0}; if(m.pinned) e.pinned=true; out.push(e);
      }catch(e){}
    }
    return out;
  },
  // Add recovered orphan entries back into the index (never a tombstoned id).
  async restoreOrphans(entries){
    if(!entries||!entries.length) return 0;
    let n=0;
    for(const e of entries){
      if(this.deleted.includes(e.id)) continue;
      if(!this.index.some(m=>m.id===e.id)){ this.index.unshift(e); n++; }
    }
    this.index.sort((a,b)=>(b.updated||0)-(a.updated||0));
    if(n) await this._saveIndex();
    return n;
  },
  async _writeFile(path, content, sha){
    const body={message:`MindSpark: update ${path}`, content:this._encode(content)};
    if(sha) body.sha=sha;
    const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{
      method:'PUT', headers:{...this._headers(),'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    if(!r.ok){
      // If we got a 409 sha conflict, try once more after refreshing the sha
      if(r.status===409 || r.status===422){
        const gh=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{headers:this._headers()});
        if(gh.ok){
          const d=await gh.json();
          body.sha=d.sha;
          const retry=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`,{
            method:'PUT', headers:{...this._headers(),'Content-Type':'application/json'},
            body:JSON.stringify(body)
          });
          if(retry.ok){ const dat=await retry.json(); return dat.content.sha; }
        }
      }
      const t=await r.text();
      throw new Error('Write '+path+' failed (HTTP '+r.status+') '+t.slice(0,140));
    }
    const data=await r.json();
    return data.content.sha;
  },
  async _deleteFile(path, sha){
    const url=`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/${path}`;
    const del=(s)=>fetch(url,{method:'DELETE', headers:{...this._headers(),'Content-Type':'application/json'},
      body:JSON.stringify({message:`MindSpark: delete ${path}`, sha:s})});
    let r=await del(sha);
    if(r.ok || r.status===404) return;            // deleted, or already gone
    if(r.status===409 || r.status===422){          // missing/stale sha → refresh and retry
      const gh=await fetch(url,{headers:this._headers()});
      if(gh.status===404) return;
      if(gh.ok){ const d=await gh.json(); const r2=await del(d.sha); if(r2.ok||r2.status===404) return; r=r2; }
    }
    throw new Error('Delete '+path+' failed (HTTP '+r.status+')');
  },
  async _saveIndex(){
    // Merge-on-write: re-read the server index and overlay our in-memory entries,
    // then drop tombstoned ids. A save can therefore never clobber entries that
    // still exist on the server - only an explicit delete (via the tombstone
    // list) removes one. This neutralises the empty/failed-read clobber bug.
    let server=[];
    try{ server=await this._fetchIndexRaw(); }catch(e){ server=this.index.slice(); }
    const byId=new Map(server.map(m=>[m.id,m]));
    for(const m of this.index) byId.set(m.id,m);
    for(const id of this.deleted) byId.delete(id);
    this.index=[...byId.values()].sort((a,b)=>(b.updated||0)-(a.updated||0));
    this.indexSha=await this._writeFile('_index.json', JSON.stringify(this.index), this.indexSha);
  },
  // public API matching ServerStore
  async list(){ return this.index.slice(); },
  async get(id){
    try{
      const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/maps/${id}.json`,{headers:this._headers()});
      if(r.status===404){ const b=this._localBackup(id); if(b) return b; return null; }
      if(!r.ok) throw new Error('Could not load map (HTTP '+r.status+')');
      const data=await r.json();
      this.shas[id]=data.sha;
      let json;
      // The Contents API only inlines base64 content for files up to 1 MB. Larger
      // files come back with empty content (and encoding "none"), so we must read
      // them another way - via the Git Blobs API (handles up to 100 MB).
      const inlined = data.content && data.content.trim() && data.encoding!=='none';
      json = inlined ? this._decode(data.content) : await this._readLargeBlob(data);
      const parsed=JSON.parse(json);
      try{ localStorage.setItem('mindspark:backup:'+id, json); }catch(e){}   // refresh local copy
      return parsed;
    }catch(e){
      console.warn('CloudStore.get', e);
      const b=this._localBackup(id);
      if(b){ console.warn('CloudStore.get: served local backup for', id); return b; }
      return null;
    }
  },
  // Read a file too large for the Contents API to inline (>1 MB). Prefer the Git
  // Blobs API (returns base64, up to 100 MB); fall back to the raw download_url
  // (plain text, no decode) if the blob endpoint is unavailable.
  async _readLargeBlob(data){
    if(data.git_url){
      const br=await fetch(data.git_url,{headers:this._headers()});
      if(br.ok){
        const blob=await br.json();
        if(blob && blob.content) return this._decode(blob.content);
      }
    }
    if(data.download_url){
      const dr=await fetch(data.download_url,{headers:this._headers()});
      if(dr.ok) return await dr.text();   // raw JSON - already decoded
    }
    throw new Error('Could not read large map content (Blobs API + raw both failed)');
  },
  _localBackup(id){
    try{ const s=localStorage.getItem('mindspark:backup:'+id); return s?JSON.parse(s):null; }catch(e){ return null; }
  },
  async save(map){
    map.updated=Date.now();
    // Durability net: keep a local copy *before* the network write, so a failed
    // or interrupted GitHub save can never lose the user's edits.
    try{ localStorage.setItem('mindspark:backup:'+map.id, JSON.stringify(map)); }catch(e){}
    // Store compact (not pretty-printed): pretty-printing inflates large maps
    // past GitHub's 1 MB Contents-API limit, which then breaks reads.
    this.shas[map.id]=await this._writeFile(`maps/${map.id}.json`, JSON.stringify(map), this.shas[map.id]);
    const entry={id:map.id, title:map.title, color:map.color, updated:map.updated};
    if(map.pinned) entry.pinned=true;
    const i=this.index.findIndex(m=>m.id===map.id);
    if(i>=0) this.index[i]=entry; else this.index.unshift(entry);
    this.index.sort((a,b)=>b.updated-a.updated);
    await this._saveIndex();
  },
  async remove(id){
    // Delete the file (refreshing the sha if we don't have it cached - so deleting
    // a never-opened map still removes its file, not just the index entry).
    try{ await this._deleteFile(`maps/${id}.json`, this.shas[id]); }
    catch(e){ console.warn('map file delete:', e.message); }
    delete this.shas[id];
    this.index=this.index.filter(m=>m.id!==id);
    if(!this.deleted.includes(id)) this.deleted.push(id);   // tombstone: never resurrect
    try{ localStorage.removeItem('mindspark:backup:'+id); }catch(e){}
    try{ await this._saveDeleted(); }catch(e){ console.warn('tombstone save:', e.message); }
    await this._saveIndex();
  },
  // Version history = the GitHub commit history of the map's JSON file.
  async history(id){
    try{
      const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/commits?path=maps/${id}.json&per_page=50`,{headers:this._headers()});
      if(!r.ok) return [];
      const commits=await r.json();
      return commits.map(c=>({
        ref: c.sha,
        ts: Date.parse(c.commit?.author?.date || c.commit?.committer?.date || 0) || 0,
        message: c.commit?.message || ''
      }));
    }catch(e){ console.warn('history', e); return []; }
  },
  async version(id, ref){
    try{
      const r=await fetch(`https://api.github.com/repos/${this.user.login}/${this.repo}/contents/maps/${id}.json?ref=${encodeURIComponent(ref)}`,{headers:this._headers()});
      if(!r.ok) return null;
      const data=await r.json();
      const inlined = data.content && data.content.trim() && data.encoding!=='none';
      const json = inlined ? this._decode(data.content) : await this._readLargeBlob(data);
      return JSON.parse(json);
    }catch(e){ console.warn('version', e); return null; }
  }
};

let Store;
let MODE = 'unknown';
// Wrap document.execCommand so missing-method environments (older Safari without
// the legacy API, jsdom-based tests, etc.) silently no-op instead of throwing.
// All inline-formatting toolbar buttons funnel through here.
function execCmd(cmd, value){
  if(typeof document.execCommand !== 'function') return false;
  try { return document.execCommand(cmd, false, value); }
  catch(e){ console.warn('execCommand failed:', cmd, e); return false; }
}

async function initStore(){
  try{
    const r=await fetch('/healthz', {cache:'no-store'});
    if(r.ok){ Store=ServerStore; MODE='server'; return {mode:'server', loggedIn:true}; }
  }catch(e){}
  Store=CloudStore; MODE='cloud';
  const loggedIn=await CloudStore.tryInit();
  return {mode:'cloud', loggedIn};
}

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const uid=()=>Math.random().toString(36).slice(2,9);
// Per-node marker badges (issue #13). A deliberately small, curated set
// rather than a full emoji keyboard: these are meant to be scannable at a
// glance across a whole map, which stops working once there are hundreds of
// near-identical glyphs. Stored as the literal character in n.marker, so no
// mapping table has to stay in sync with saved maps.
// NOTE the \u{...} form for anything above U+FFFF: plain \uXXXX takes exactly
// four hex digits, so '\u1F6A9' silently parses as '\u1F6A' followed by a
// literal '9' and renders as garbage rather than a flag.
const MARKERS=[
  {c:'\u2B50',    label:'Star'},     {c:'\u2757',    label:'Important'},
  {c:'\u2753',    label:'Question'}, {c:'\u{1F6A9}', label:'Flag'},
  {c:'\u{1F525}', label:'Hot'},      {c:'\u{1F4A1}', label:'Idea'},
  {c:'\u{1F440}', label:'Review'},   {c:'\u{1F512}', label:'Blocked'},
  {c:'\u2705',    label:'Approved'}, {c:'\u26A0',    label:'Risk'},
  {c:'\u{1F3AF}', label:'Goal'},     {c:'\u{1F4CC}', label:'Pinned'},
];
const NODE_COLORS=['#ffffff','#ffe2d6','#ffedc2','#dcefce','#cfe9e6','#d8e0fb','#efd9f2','#e9e2d6'];
const PALETTE=['#e0613a','#2f6f6a','#c98a1a','#5a7d3a','#3a6ea5','#9b4f96','#8a8175'];

// Positions an already-appended `position:fixed` popup against an anchor element
// or rect, fully clamped to the CURRENT viewport on every side - recomputed fresh
// from live geometry each call, never a size/side baked in when the popup happened
// to first get built. Prefers opening below (or right-aligned, if `align:'right'`),
// but flips to whichever side actually has room, and caps its own max-height rather
// than running off a short window instead of just clamping X like most ad-hoc call
// sites used to. Same shape works for a toolbar dropdown, a nodebar picker, or a
// bottom-pinned bulk-bar picker (which naturally flips upward since there's more
// room above it than below).
function positionPopup(pop, anchor, opts){
  opts = opts || {};
  const margin = opts.margin!=null ? opts.margin : 8;
  const gap = opts.gap!=null ? opts.gap : 6;
  const align = opts.align || 'left';   // 'left': left edge under the anchor's left edge; 'right': right edge under the anchor's right edge
  pop.style.position='fixed';
  const prevVis=pop.style.visibility;
  // Disable any CSS max-height (e.g. export-pop's calc(100vh - 72px)) while
  // measuring the natural height - otherwise a tall menu would be capped and
  // we'd think it fits when it actually overflows.
  pop.style.visibility='hidden'; pop.style.maxHeight='none'; pop.style.overflowY='';
  // Measure with any entry animation suppressed. ui-rail plays `railPopIn` on
  // the export popup and the theme panel, and its first keyframe is
  // translateX(-6px) scale(.98). getBoundingClientRect() reports the
  // *transformed* box, so measuring while that runs understated the height by
  // 2 percent - enough that the share menu was clamped 10px short and its last
  // row fell off the bottom of a 1080p screen - and it also shifted the probe
  // below, whose whole premise is that a known style.left renders where it says.
  const prevAnim = pop.style.animation;
  pop.style.animation = 'none';
  // Self-calibrate the CSS-px <-> getBoundingClientRect-px factor using the popup
  // itself - set a KNOWN CSS left and measure where it actually renders - instead
  // of trusting a separate, always-off-screen probe element (_uiZ()) to behave
  // identically. getBoundingClientRect() can disagree with the CSS px that
  // style.left/top use (zoom, browser/version quirks, OS display scaling).
  const REF = 1000;
  pop.style.left = REF+'px'; pop.style.top = '0px';
  const probe = pop.getBoundingClientRect();
  const z = probe.left>1 ? probe.left/REF : 1;
  // From here on, EVERYTHING stays in raw getBoundingClientRect() space - the
  // anchor, the popup, and the viewport bounds are all measured via the exact
  // same API, so they're internally consistent with each other regardless of
  // what that space actually is relative to CSS px. Converting each measurement
  // to "logical" px individually (dividing every single one by z) risked mixing
  // a converted value with an unconverted one in the same comparison somewhere,
  // which is exactly as wrong as never converting, just by a different amount -
  // only visible once two values disagree enough to flip a clamp decision. The
  // one and only conversion happens at the very end, turning the final raw
  // left/top back into the CSS px that style.left/top actually expects.
  const rr = (anchor && anchor.nodeType===1) ? anchor.getBoundingClientRect() : anchor;
  const pw = probe.width, ph = probe.height;
  const vp = document.documentElement.getBoundingClientRect();
  const viewW = vp.width>1 ? vp.width : window.innerWidth*z;
  const viewH = vp.height>1 ? vp.height : window.innerHeight*z;
  pop.style.animation = prevAnim;   // measuring is done - let the entry animation play from here
  // ── Side placement (vertical toolbar flyout) ──────────────────────────────
  // Used by the side-toolbar layout (ui-rail) where the toolbar is a narrow
  // vertical rail: the popup should appear *beside* the rail, not below the
  // button. Mirrors VS Code / Figma / Slack: flyout 8px to the right of the
  // anchor, top-aligned with the anchor, flipping to the left or clamping if
  // there is no room. If opts.side is set, take this path instead of the
  // classic below/above dropdown path.
  if(opts.side==='right' || opts.side==='left'){
    const side = opts.side;
    const wantRight = side==='right';
    // Desired position beside the anchor
    let leftRight = rr.right + gap;
    let leftLeft  = rr.left - gap - pw;
    let left;
    if(wantRight){
      if(leftRight + pw <= viewW - margin) left = leftRight;
      else if(leftLeft >= margin) left = leftLeft;
      else {
        // Neither side fits cleanly - pick the side with more space and clamp
        const spaceRight = viewW - rr.right - gap - margin;
        const spaceLeft  = rr.left - gap - margin;
        if(spaceRight >= spaceLeft) left = Math.min(leftRight, viewW - pw - margin);
        else left = Math.max(margin, leftLeft);
      }
    } else {
      if(leftLeft >= margin) left = leftLeft;
      else if(leftRight + pw <= viewW - margin) left = leftRight;
      else {
        const spaceRight = viewW - rr.right - gap - margin;
        const spaceLeft  = rr.left - gap - margin;
        if(spaceLeft >= spaceRight) left = Math.max(margin, leftLeft);
        else left = Math.min(leftRight, viewW - pw - margin);
      }
    }
    if(left < margin) left = margin;
    if(left + pw > viewW - margin) left = Math.max(margin, viewW - pw - margin);
    // Vertical: align popup's top with anchor's top; nudge up if it would
    // overflow the viewport bottom, or clamp to top margin. Only constrain
    // height / enable scrolling when the content would actually overflow the
    // available space - otherwise leave it auto-sized with no scrollbar.
    let top = rr.top;
    let available;
    if(ph > viewH - 2*margin){
      top = margin;
      available = viewH - 2*margin;
    } else {
      if(top + ph > viewH - margin) top = viewH - ph - margin;
      if(top < margin) top = margin;
      available = viewH - top - margin;
    }
    if(ph > available){
      pop.style.maxHeight = Math.max(120, available/z) + 'px';
      pop.style.overflowY = 'auto';
    } else {
      // No overflow - let the content size naturally with no scroll container.
      // Use 'none' to override any CSS max-height (e.g. export-pop's
      // calc(100vh - 72px)) that would otherwise create an unnecessary
      // scrollbar when the content actually fits in the available space.
      pop.style.maxHeight = 'none';
      pop.style.overflowY = 'visible';
    }
    pop.style.left=(left/z)+'px'; pop.style.top=(top/z)+'px';
    pop.style.visibility=prevVis;
    return {left:left/z, top:top/z};
  }
  let left = align==='right' ? (rr.right-pw) : rr.left;
  if(left+pw > viewW-margin) left = viewW-pw-margin;
  if(left < margin) left = margin;
  const spaceBelow = viewH-(rr.bottom+gap)-margin;
  const spaceAbove = rr.top-gap-margin;
  let top;
  let availableDrop;
  if(ph<=spaceBelow || spaceBelow>=spaceAbove){
    top = rr.bottom+gap;
    availableDrop = viewH - top - margin;
  } else {
    availableDrop = spaceAbove;
    top = Math.max(margin, rr.top-gap-Math.min(ph,spaceAbove));
  }
  if(ph > availableDrop){
    pop.style.maxHeight = Math.max(120, availableDrop/z)+'px';
    pop.style.overflowY = 'auto';
  } else {
    pop.style.maxHeight = 'none';
    pop.style.overflowY = 'visible';
  }
  pop.style.left=(left/z)+'px'; pop.style.top=(top/z)+'px';
  pop.style.visibility=prevVis;
  return {left:left/z, top:top/z};
}

/* ---------- app state ---------- */
let map=null;                 // current map {id,title,color,rootId,nodes:{}}
let view={x:80,y:0,k:1};      // pan/zoom
let userZoom=null;            // user-chosen camera zoom, preserved across map switches
// The whole UI may be scaled by CSS `zoom` (display size). getBoundingClientRect
// then returns VISUAL px, but the #viewport transform works in LAYOUT px - so
// convert by dividing by the active UI zoom for any camera math.
// The whole UI may be scaled by CSS `zoom` (display size). How that interacts
// with getBoundingClientRect differs by browser/version (some return layout px,
// some zoom-scaled "visual" px). Rather than assume, MEASURE the factor with a
// 100px probe so camera math converts rect/pointer coords to the #viewport's
// layout space correctly on every browser. Cached; invalidated on scale change.
let _rzCache=null;
function _uiZ(){
  if(_rzCache!=null) return _rzCache;
  try{
    let p=document.getElementById('__zprobe');
    if(!p){
      p=document.createElement('div'); p.id='__zprobe'; p.setAttribute('aria-hidden','true');
      p.style.cssText='position:absolute;width:100px;height:1px;left:-99999px;top:0;pointer-events:none;visibility:hidden';
      (document.body||document.documentElement).appendChild(p);
    }
    const w=p.getBoundingClientRect().width;
    if(w>0){ _rzCache=w/100; return _rzCache; }   // cache only a real measurement
  }catch(e){}
  const z=parseFloat(document.documentElement.style.zoom);
  return (z && z>0) ? z : 1;                       // fallback before layout exists
}
function _stageSize(){ const r=stage.getBoundingClientRect(); const z=_uiZ(); return {w:r.width/z, h:r.height/z}; }
function _stagePoint(cx,cy){ const r=stage.getBoundingClientRect(); const z=_uiZ(); return {x:(cx-r.left)/z, y:(cy-r.top)/z}; }
// Per-map camera (zoom + pan), saved in localStorage so each map reopens exactly
// where the user left it. Kept out of the map object so it never bumps the map's
// "updated" time or reshuffles the sidebar.
let _svTimer=null;
function saveMapView(){ clearTimeout(_svTimer); _svTimer=setTimeout(_saveMapViewNow, 150); }
window.addEventListener('pagehide', ()=>{ clearTimeout(_svTimer); try{ _saveMapViewNow(); }catch(e){} });
function _saveMapViewNow(){
  if(!map || !map.id || READONLY) return;
  // Store the map-space point at the viewport CENTRE (plus zoom), not the raw pan
  // offset, so the same framing reproduces on any screen size - a map reopened on
  // a different browser/device/window lands consistently instead of shifted.
  const {w:SW,h:SH}=_stageSize();
  const cx=(SW/2 - view.x)/view.k, cy=(SH/2 - view.y)/view.k;
  if(!isFinite(cx)||!isFinite(cy)) return;
  try{ localStorage.setItem('mindspark:view:'+map.id, JSON.stringify({k:view.k, cx, cy})); }catch(e){}
}
function loadMapView(id){
  try{ const v=JSON.parse(localStorage.getItem('mindspark:view:'+id)||'null');
    if(v && isFinite(v.k) && ((isFinite(v.cx)&&isFinite(v.cy)) || (isFinite(v.x)&&isFinite(v.y)))) return v; }catch(e){}
  return null;
}
// Stage size when the camera was last framed - lets a live window resize keep the
// same map-point centred instead of letting the map drift sideways.
let _prevStage=null, _prevStageRect=null;
function _markStage(){
  const z=_stageSize(); if(z.w>1&&z.h>1) _prevStage=z;
  try{
    const r=stage.getBoundingClientRect();
    if(r.width>1 && r.height>1) _prevStageRect={left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
  }catch(e){}
  // The cache just changed - anything that read it earlier in this same gesture (e.g.
  // applyView()'s last frame, which runs BEFORE this) may have drawn against the old
  // value. Re-apply the two things that depend on it, once, now that it's fresh -
  // cheap since this only fires at gesture-settle, not per frame.
  if(typeof updateMinimapViewport==='function') updateMinimapViewport();
  if(typeof repositionNodeBar==='function' && typeof sel!=='undefined' && sel) repositionNodeBar();
}
// Keeps whatever map point is currently centred still centred after the stage's
// effective CSS-pixel size changes for any reason - a window resize, a UI-scale
// change, a sidebar toggle, ... Relies on _prevStage already holding the size from
// just before the change (kept fresh by _markStage(), called after every camera
// move) to know what point to preserve; updates it to the new size afterward so
// the next call has a correct baseline too.
function _recenterForStageChange(){
  if(!map) return;
  const {w:SW,h:SH}=_stageSize();
  if(!(SW>1&&SH>1)) return;
  if(_prevStage && _prevStage.w>1 && _prevStage.h>1){
    const cx=(_prevStage.w/2 - view.x)/view.k, cy=(_prevStage.h/2 - view.y)/view.k;
    view.x = SW/2 - cx*view.k;
    view.y = SH/2 - cy*view.k;
    applyView(); saveMapView();
  }
  _markStage();   // refreshes _prevStage AND _prevStageRect together - setting _prevStage alone here would leave _prevStageRect stale after every resize/UI-scale-change that goes through this path
}
// Apply a saved camera viewport-INDEPENDENTLY: recompute the pan from the CURRENT
// stage size so the stored centre point + zoom reproduce at any viewsize. Legacy
// {x,y} entries are honoured once, then migrated to {cx,cy} on the next save.
// While the stage width animates (sidebar collapse/expand), keep the given
// map-space point centred each frame so the map holds its position on screen.
// Smoothly keep the centred map-point in place while the sidebar animates, WITHOUT
// any per-frame JS or forced layout (which is what makes the old loop stutter on
// low-end / battery). We know the stage's final width, so we set the viewport's
// final transform and let the compositor animate it in lockstep with the sidebar
// (identical easing + duration). Because view.x is linear in stage width, the
// centred point stays put for the whole animation - GPU-only, no jank.
function _reframeSmooth(cx, cy, W1, H1){
  const tx = W1/2 - cx*view.k, ty = H1/2 - cy*view.k;
  view.x = tx; view.y = ty;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce){ applyView(); _markStage(); saveMapView(); updateMinimap(); return; }
  let done=false;
  const settle=()=>{ if(done) return; done=true; viewport.style.transition=''; _markStage(); saveMapView(); updateMinimap(); };
  viewport.style.transition = 'transform .22s cubic-bezier(.4,0,.2,1)';
  applyView();                                  // sets transform to target -> compositor animates it
  viewport.addEventListener('transitionend', function te(e){
    if(e.target===viewport && e.propertyName==='transform'){ viewport.removeEventListener('transitionend', te); settle(); }
  });
  setTimeout(settle, 280);                       // safety net if transitionend doesn't fire
}
function _reframeDuring(ms, cx, cy){
  const now=()=> (window.performance&&performance.now)?performance.now():Date.now();
  const t0=now();
  (function step(){
    const {w:SW,h:SH}=_stageSize();
    if(SW>1&&SH>1){ view.x=SW/2-cx*view.k; view.y=SH/2-cy*view.k; applyView(); }
    if(now()-t0<ms) requestAnimationFrame(step);
    else { _markStage(); saveMapView(); updateMinimap(); }
  })();
}
function applyMapView(saved){
  view.k = isFinite(saved.k) ? saved.k : 1;
  if(isFinite(saved.cx) && isFinite(saved.cy)){
    const {w:SW,h:SH}=_stageSize();
    view.x = SW/2 - saved.cx*view.k;
    view.y = SH/2 - saved.cy*view.k;
  } else {
    view.x = isFinite(saved.x) ? saved.x : 0;
    view.y = isFinite(saved.y) ? saved.y : 0;
  }
  applyView(); _markStage();
}
let sel=null;                 // selected node id
let history=[],hpos=-1;       // undo stack
let saveTimer=null, _pendingSaveMap=null;

const viewport=$('#viewport'), edges=$('#edges'), stage=$('#stage'), zoomVal=$('#zoomVal');
// Static chrome elements queried on hot paths (every render / every pan-zoom
// frame) - cache once at load instead of re-querying by id each time.
const _zoomSliderEl=$('#zoomSlider'), _mmEl=$('#minimap'), _breadcrumbEl=$('#breadcrumb');

/* ============================================================
   RENDER
   ============================================================ */
function applyView(){
  viewport.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.k})`;
  if(zoomVal) zoomVal.textContent=Math.round(view.k*100)+'%';
  if(_zoomSliderEl) _zoomSliderEl.value=Math.round(Math.min(300,Math.max(10,view.k*100)));
  // Keep the (in-viewport) node toolbar at a constant on-screen size AND a
  // constant ~12px gap below the node as zoom changes (so it never overlaps).
  const bar=$('#nodebar');
  if(bar){
    if(sel && map && map.nodes[sel]){
      positionAndClampNodeBar(bar, map.nodes[sel]);
    }else{
      bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
    }
  }
  updateMinimapViewport();
}
function clearNodes(){ document.querySelectorAll('.node').forEach(n=>n.remove()); }

function render(){
  clearNodes(); edges.innerHTML='';
  clearFormulaCache();
  if(!map){
    $('#empty').style.display='grid';
    $('#nodebar')?.remove();              // no node toolbar on a blank canvas
    if(activePicker){ activePicker.remove(); activePicker=null; }
    $('#mapTitle').value='';              // reset title field
    viewport.removeAttribute('data-style');
    viewport.removeAttribute('data-layout');   // reset style/background
    sel=null;
    updateBreadcrumb();                   // hides (no map)
    updateMinimap();                      // clears + hides the overview box
    renderOutline();                      // clears the outline dock
    return;
  }
  $('#empty').style.display='none';
  const mapStyle = map.style || 'modern';
  viewport.dataset.style = mapStyle;
  viewport.dataset.layout = map.layout || 'balanced';
  applyStyleConfigVars();
  applyLookConfigVars();
  applyThemeConfigVars();
  const _prevCI=_ci; _ci=buildChildIndex();   // O(1) childrenOf for this whole pass
  const zd=zebraDepth();                       // zebra tint levels (root = 0)
  try{
  const roll=computeRollups();                // O(n) descendant + task totals
  const hidden=hiddenSet();
  const toMeasure=[];
  // nodes
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    const hasKids=childrenOf(id).length>0;
    const el=document.createElement('div');
    el.className='node'+(id===map.rootId?' root':'')+(id===sel?' sel':'')+(hasKids&&n.collapsed?' collapsed':'')+(n.side==='left'?' left':'');
    el.dataset.id=id;
    if(zd[id]) el.setAttribute('data-depth', zd[id]);   // zebra parity for uncoloured nodes
    el.style.left=n.x+'px'; el.style.top=n.y+'px';
    if(id===map.rootId){
      const _isInk = (map.style||'modern')==='ink';
      const _base = map.color||'#e0613a';
      el.style.background = _isInk ? _base : colorFor(_base);
      el.style.color = pickContrast(_isInk ? _base : colorFor(_base));
    } else if(n.color && n.color!=='#fff' && n.color!=='#ffffff'){
      el.style.background = n.color;
      el.style.color = pickContrast(n.color);
    } else {
      // No explicit colour - let CSS theme variables handle it
      el.style.background = '';
      el.style.color = '';
    }
    // Manual width/height (when the user has resized the node). Height is a
    // floor (min-height), not a hard cap - .node has no overflow:hidden, so a
    // fixed height smaller than what the current font-size actually needs
    // (e.g. Back to School's 1.2em) would let text visually spill past the
    // card's own border rather than the box growing to fit it.
    if(n.width){ el.style.width=n.width+'px'; el.style.maxWidth='none'; }
    if(n.height){ el.style.minHeight=n.height+'px'; }
    // Reference/citation nodes get a distinct class
    if(n.ref) el.classList.add('ref-node');
    // Attached image renders as a thumbnail above the text (node goes column)
    if(n.image){
      el.classList.add('has-image');
      const img=document.createElement('img');
      img.className='node-image'; img.src=n.image; img.alt=n.imageAlt||'attachment';
      img.addEventListener('mousedown',ev=>ev.stopPropagation());
      img.addEventListener('dblclick',ev=>{ ev.stopPropagation(); window.open(n.image,'_blank'); });
      // If the image can't load, fall back to its alt text so the node isn't a broken icon
      img.addEventListener('error',()=>{
        img.remove(); el.classList.remove('has-image'); el.classList.add('img-missing');
        const cap=document.createElement('span'); cap.className='img-alt';
        cap.textContent = n.imageAlt || 'image not found';
        el.insertBefore(cap, el.firstChild);
      });
      el.appendChild(img);
    }
    // Marker badge - click to change, same interaction shape as the task
    // checkbox below it.
    if(n.marker){
      const mk=document.createElement('span');
      mk.className='node-marker';
      mk.textContent=n.marker;
      const mkLabel=(MARKERS.find(m=>m.c===n.marker)||{}).label;
      mk.title=(mkLabel?mkLabel+' - ':'')+'click to change';
      mk.addEventListener('mousedown',ev=>ev.stopPropagation());
      mk.addEventListener('click',ev=>{ ev.stopPropagation(); showMarkerPicker(mk, id); });
      el.appendChild(mk);
    }
    // Task checkbox - click to advance todo → doing → done
    if(n.task){
      el.classList.add('task-node','task-'+n.task);
      const cb=document.createElement('span');
      cb.className='task-check task-'+n.task;
      cb.title='Task: '+n.task+' (click to change)';
      cb.textContent = n.task==='done' ? '✓' : (n.task==='doing' ? '◐' : '');
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); cycleTask(id); });
      el.appendChild(cb);
    }
    // Text lives in its own span so contentEditable doesn't tangle with the handles
    const t=document.createElement('span'); t.className='node-text';
    if(n.hr){ el.classList.add('hr-node'); t.classList.add('node-hr'); t.textContent=''; }
    else if(n.html){ el.classList.add('block-node'); if(n.frontmatter) el.classList.add('frontmatter-node'); t.classList.add('node-block'); t.innerHTML = sanitizeNotes(n.html); }
    else {
      const plainCheck = nodeTextPlain(n.text||'').trim();
      if(plainCheck.startsWith('=')){
        // Formula node: show the computed result (Excel-style), not the literal "=...".
        // n.text itself is never touched here, so editing/markdown export still see the
        // raw formula.
        el.classList.add('formula-node');
        const val = computeNodeValue(id);
        if(val && typeof val==='object' && val.error){
          el.classList.add('formula-error');
          t.textContent = '#ERROR';
          t.title = plainCheck+' - '+val.error;
        } else {
          t.textContent = formatFormulaResult(val);
          t.title = plainCheck;
        }
      } else {
        renderNodeText(t, n.text||'', n.listType);
      }
    }
    // Per-node styling
    if(n.fontSize) t.style.fontSize=n.fontSize+'px';
    if(n.bold) t.style.fontWeight='700';
    if(n.italic) t.style.fontStyle='italic';
    const decos=[]; if(n.underline) decos.push('underline'); if(n.strike) decos.push('line-through');
    if(decos.length) t.style.textDecoration=decos.join(' ');
    if(n.textColor) t.style.color=n.textColor;
    if(n.highlight){ t.style.background=n.highlight; t.style.padding='0 4px'; t.style.borderRadius='3px'; t.style.boxDecorationBreak='clone'; t.style.webkitBoxDecorationBreak='clone'; }
    // Text alignment
    if(n.align && n.align!=='center'){
      t.style.textAlign=n.align;
      el.style.justifyContent = (n.align==='left') ? 'flex-start' : (n.align==='right') ? 'flex-end' : 'center';
    }
    if(n.listType) t.classList.add('node-text-list','list-'+n.listType);
    el.appendChild(t);
    // Hover-only watermark: when this node was created/last edited. Off by default so it
    // never clutters the map - only appears as a subtle background detail on hover.
    if(!n.hr && (n.created || n.updated)){
      const wm=document.createElement('span');
      wm.className='node-watermark'; wm.setAttribute('aria-hidden','true');
      wm.textContent=formatNodeTimestamp(n.updated||n.created);
      el.appendChild(wm);
    }

    // ---- Quick-action handles (appear on hover; collapse stays visible) ----
    const mkHandle=(cls,label,title,onClick)=>{
      const h=document.createElement('span');
      h.className='handle '+cls; h.textContent=label; h.title=title;
      h.addEventListener('mousedown',ev=>ev.stopPropagation());
      h.addEventListener('click',ev=>{ ev.stopPropagation(); onClick(); });
      return h;
    };

    // Collapse / expand toggle - only on nodes with children
    if(hasKids){
      el.appendChild(mkHandle(
        'h-collapse'+(n.collapsed?' collapsed':''),
        n.collapsed?'+':'−',
        n.collapsed?`Expand (${roll.desc[id]} hidden)`:'Collapse',
        ()=>{ n.collapsed=!n.collapsed; pushHistory(); autoLayout(); }
      ));
    }
    // Add child - every node
    el.appendChild(mkHandle('h-child','+','Add child topic',()=>addNode(id,false)));
    // Add sibling - every non-root node
    if(id!==map.rootId){
      el.appendChild(mkHandle('h-sibling','+','Add sibling topic',()=>addNode(id,true)));
    }
    // Resize grip - drag from the bottom-right corner to resize the node
    const grip=document.createElement('span');
    grip.className='resize-grip'; grip.title='Drag to resize';
    grip.addEventListener('mousedown',ev=>{ ev.stopPropagation(); ev.preventDefault(); startResize(id,ev); });
    el.appendChild(grip);
    // Notes indicator - visible only if a non-empty note exists
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const nm=document.createElement('span');
      nm.className='notes-mark';
      nm.textContent='📝';
      nm.title=noteText.length>120 ? noteText.slice(0,120)+'…' : noteText;
      nm.addEventListener('mousedown',ev=>ev.stopPropagation());
      nm.addEventListener('click',ev=>{ ev.stopPropagation(); showNotesEditor(id); });
      el.appendChild(nm);
    }
    // Citation/reference indicator
    if(n.ref){
      const cb=document.createElement('span');
      cb.className='ref-mark'; cb.textContent='📖';
      cb.title='Reference - click to edit citation';
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); showCitationForm(id); });
      el.appendChild(cb);
    }
    // Task progress roll-up - shown on nodes that have task-bearing descendants
    const prog = {done:roll.tdone[id], total:roll.ttot[id]};
    if(prog.total > 0 && !n.task){
      const pb=document.createElement('span');
      pb.className='task-progress'+(prog.done===prog.total?' complete':'');
      pb.textContent=`✓ ${prog.done}/${prog.total}`;
      pb.title=`${prog.done} of ${prog.total} tasks done in this branch`;
      pb.addEventListener('mousedown',ev=>ev.stopPropagation());
      pb.addEventListener('click',ev=>ev.stopPropagation());
      el.appendChild(pb);
    }
    // Token-count badge - shown for nodes whose text + notes are non-trivial.
    // Rough ~4 chars/token estimate (matches Anthropic & OpenAI tokenizer averages
    // for English; treat as ±20%). Helps when building prompts to keep an eye on
    // token budgets.
    const tokens = estimateTokens(n.text, n.notes);
    if(tokens >= 25){
      const tb = document.createElement('span');
      tb.className = 'token-badge';
      tb.textContent = '~'+tokens+'t';
      tb.title = `Approximately ${tokens} tokens (text${noteText?' + notes':''}). Rough estimate using ~4 chars/token.`;
      tb.addEventListener('mousedown',ev=>ev.stopPropagation());
      tb.addEventListener('click',ev=>ev.stopPropagation());
      el.appendChild(tb);
    }
    viewport.appendChild(el);
    toMeasure.push({el, n});
  }
  // Measure ALL nodes in one pass AFTER appending - reading getBoundingClientRect
  // interleaved with appends forces a layout reflow per node (O(n) thrash). One
  // batched read loop triggers a single reflow. getBoundingClientRect returns
  // VISUAL px, scaled by BOTH the canvas zoom (view.k) and the UI display zoom,
  // so divide by both to recover true layout dimensions.
  const sz=view.k*_uiZ();
  for(const {el, n} of toMeasure){
    const r=el.getBoundingClientRect();
    n.w=r.width/sz; n.h=r.height/sz;
  }
  drawEdges(hidden);
  positionNodeBar();
  scheduleTokenTotal();
  updateMinimap();
  updateBreadcrumb();
  renderOutline();                  // keep the outline dock in sync with the canvas
  // Re-apply multi-selection outlines (render rebuilds node elements)
  if(typeof multiSel !== 'undefined' && multiSel.size){
    multiSel.forEach(id=>document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel'));
  }
  } finally { _ci=_prevCI; }
}

// Sum estimated tokens across every node (text + notes) and show in the topbar.
let _tokTimer=null;
// The token total scans every node's text, which is wasteful to do synchronously
// inside render() (it dominated render time even when only a few nodes were
// visible). Schedule it off the hot path and coalesce bursts of renders into one
// recompute - the badge is a non-critical stat, so a ~300ms delay is invisible.
function scheduleTokenTotal(){
  if(_tokTimer) return;
  _tokTimer=setTimeout(()=>{ _tokTimer=null; try{ updateTokenTotal(); }catch(e){} }, 300);
}
function updateTokenTotal(){
  const el = $('#tokenTotal');
  if(!el || !map || !map.nodes){ if(el) el.textContent=''; return; }
  let total = 0;
  Object.values(map.nodes).forEach(n => { total += estimateTokens(n.text, n.notes); });
  el.textContent = total > 0 ? `~${total.toLocaleString()} tokens` : '';
  el.style.display = total > 0 ? '' : 'none';
}

// Render text inside a node, turning http(s)://… URLs into clickable links.
const URL_RE = /(https?:\/\/[^\s<>"'`)]+)/g;
// A short, readable label for a URL (host + trimmed path) used as the link text.
function prettyUrl(u){
  try{
    const x=new URL(u);
    let label=x.hostname.replace(/^www\./,'');
    let path=(x.pathname && x.pathname!=='/') ? x.pathname.replace(/\/$/,'') : '';
    label+=path;
    if(label.length>44) label=label.slice(0,42)+'\u2026';
    return label;
  }catch(_){ return u; }
}
function appendTextWithLinks(container, text){
  let last=0, m;
  URL_RE.lastIndex=0;
  while((m=URL_RE.exec(text))!==null){
    if(m.index>last) container.appendChild(document.createTextNode(text.slice(last,m.index)));
    const a=document.createElement('a');
    a.href=m[0]; a.target='_blank'; a.rel='noopener noreferrer';
    a.className='node-link';
    // Favicon (best-effort; removed if it fails to load - e.g. offline).
    let _host=''; try{ _host=new URL(m[0]).hostname.replace(/^www\./,''); }catch(_){}
    if(_host){
      const fav=document.createElement('img');
      fav.className='node-link-fav'; fav.alt=''; fav.loading='lazy'; fav.decoding='async';
      fav.src='https://icons.duckduckgo.com/ip3/'+_host+'.ico';
      fav.addEventListener('error',()=>{ try{ fav.remove(); }catch(_){} });
      a.appendChild(fav);
    }
    // Readable label instead of the raw (often long) URL. Display-only: editing
    // starts from the stored raw text, so this never changes what gets saved.
    const _lab=document.createElement('span'); _lab.className='node-link-label';
    _lab.textContent=prettyUrl(m[0]); a.appendChild(_lab);
    a.addEventListener('mousedown',e=>e.stopPropagation());
    a.addEventListener('click',e=>{
      e.stopPropagation();
      if(container.isContentEditable || container.closest('.node.editing')) e.preventDefault();
    });
    container.appendChild(a);
    last=m.index+m[0].length;
  }
  if(last<text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
// Wrap the current selection in a <ul>/<ol> where each <br>-separated line
// becomes its own <li>. Falls back to native execCommand when no selection.
function applyListToSelection(kind){
  const wsel = window.getSelection();
  if(!wsel || wsel.rangeCount === 0){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  const range = wsel.getRangeAt(0);
  if(range.collapsed){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  // Extract the selected contents into a fragment, then walk it to build lines.
  const frag = range.extractContents();
  const lines = fragmentToLines(frag);
  // Build a <ul>/<ol> with one <li> per line
  const listTag = (kind==='ul') ? 'ul' : 'ol';
  const listEl = document.createElement(listTag);
  lines.forEach(lineHTML => {
    const li = document.createElement('li');
    // Empty lines get a <br> so the <li> has visible height
    li.innerHTML = lineHTML.trim() || '<br>';
    listEl.appendChild(li);
  });
  // Insert the list back where the selection was
  range.insertNode(listEl);
  // Place the cursor at the end of the last list item
  const lastLi = listEl.lastElementChild;
  if(lastLi){
    const after = document.createRange();
    after.selectNodeContents(lastLi);
    after.collapse(false);
    wsel.removeAllRanges();
    wsel.addRange(after);
  }
  return true;
}
// Walk a DocumentFragment, splitting into lines on <br>/<div>/<p>/<li> boundaries,
// preserving any inline formatting (b/i/u/s/a/span) inside each line.
function fragmentToLines(frag){
  const lines = [];
  let current = '';
  const flush = () => { lines.push(current); current = ''; };
  const serialize = (el) => {
    const tmp = document.createElement('div');
    tmp.appendChild(el.cloneNode(true));
    return tmp.innerHTML;
  };
  const walk = (node) => {
    node.childNodes.forEach(child => {
      if(child.nodeType === 3){
        // Text node - split on any literal \n
        const parts = (child.nodeValue || '').split('\n');
        parts.forEach((part, i) => {
          if(i>0) flush();
          current += escapeHtml(part);
        });
      } else if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(tag === 'br'){ flush(); }
        else if(tag === 'div' || tag === 'p' || tag === 'li'){
          if(current) flush();
          walk(child);
          if(current) flush();
        } else {
          // Inline element - keep its formatting intact within the line
          current += serialize(child);
        }
      }
    });
  };
  walk(frag);
  if(current) flush();
  return lines.filter(l => l !== undefined);
}
const INLINE_HTML_RE = /<(b|i|u|s|strong|em|br|a|span|font|div|ul|ol|li|p|sub|sup|code|kbd|mark|ins|del|small|abbr)\b/i;
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;  // &rarr; &#8594; &amp; ...
// HTML entities (named like &nbsp;/&amp;, decimal &#160;, or hex &#xA0;). Text that
// contains these but no tags still needs to go through the HTML path so the entity
// is decoded for display instead of showing the literal "&nbsp;".
const ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/;
const hasInlineMarkup = t => INLINE_HTML_RE.test(t||'') || ENTITY_RE.test(t||'');
// Sanitize HTML: keep only a small inline-formatting whitelist; strip everything else
const SAFE_TAGS = new Set(['b','i','u','s','strong','em','br','a','span','font','div','ul','ol','li','p','sub','sup','code','kbd','mark','ins','del','small','abbr']);
// Memoized: render() re-sanitizes the same node HTML on every pass. Sanitizing
// is a pure function of (html, extraTags), so a bounded cache keyed on both is
// exact. Cleared wholesale at the cap - a miss just re-sanitizes.
const _sanCache=new Map();
function sanitizeInlineHTML(html, extraTags){
  // Parse INERTLY via <template>: its contents live in a document with no
  // browsing context, so smuggled resource-loaders like <img src=x onerror=…>
  // never fetch/fire during parsing. (A detached <div>.innerHTML still would.)
  const key = html + '\u0000' + (extraTags ? extraTags.join(',') : '');
  const hit = _sanCache.get(key);
  if(hit !== undefined) return hit;
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const allow = extraTags ? new Set([...SAFE_TAGS, ...extraTags]) : SAFE_TAGS;
  const walk = (node) => {
    [...node.childNodes].forEach(child => {
      if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(DROP_TAGS.has(tag)){ node.removeChild(child); return; }  // remove element AND its contents
        if(!allow.has(tag)){
          // Clean the subtree FIRST (so nothing dangerous survives), then unwrap -
          // keep only its (now-sanitized) text/inline children inline.
          walk(child);
          while(child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        [...child.attributes].forEach(attr => {
          const n = attr.name.toLowerCase();
          if(n.startsWith('on')) child.removeAttribute(attr.name);
          else if(tag==='a' && n==='href'){
            if(!/^https?:\/\//i.test(attr.value)) child.removeAttribute(attr.name);
          }
          else if(n==='style'){
            // Allow only color / background-color / font-weight / font-style / text-decoration / font-size / text-align
            const safe = attr.value
              .split(';').map(s=>s.trim()).filter(Boolean)
              .filter(s=>/^(color|background-color|font-weight|font-style|text-decoration|font-size|text-align)\s*:/i.test(s))
              .join('; ');
            if(safe) child.setAttribute('style', safe); else child.removeAttribute('style');
          }
          else if(!['href','target','rel','color','face','size'].includes(n)) child.removeAttribute(attr.name);   // note: class removed - pasted HTML must not claim app CSS classes
        });
        if(tag==='a'){ child.setAttribute('target','_blank'); child.setAttribute('rel','noopener noreferrer'); }
        walk(child);
      } else if(child.nodeType === 8){
        node.removeChild(child);  // comments
      }
    });
  };
  walk(tpl.content);
  // Serialize the now-sanitized fragment (no re-parse of untrusted input).
  const out = document.createElement('div');
  out.appendChild(tpl.content);
  const result = out.innerHTML;
  if(_sanCache.size>=500) _sanCache.clear();
  _sanCache.set(key, result);
  return result;
}
// Notes allow a few block tags on top of the inline set (headings, quotes).
const NOTES_TAGS = ['h1','h2','h3','blockquote','pre','code','table','thead','tbody','tr','th','td'];
// Elements removed WITH their contents (never unwrapped) - unwrapping these can
// promote a hidden <script> to the top level where a snapshotted loop misses it.
const DROP_TAGS = new Set(['script','style','iframe','object','embed','noscript','svg','math','template','link','meta','base','frame','frameset','title','xmp']);
function sanitizeNotes(html){ return sanitizeInlineHTML(html, NOTES_TAGS); }
// ---------------------------------------------------------------------------
// Minimal, dependency-free LaTeX -> MathML converter. Covers the common inline
// subset: sub/superscripts, Greek, operators/relations/arrows/sets, \frac,
// \sqrt (+ optional index), accents, math fonts, function names, spacing.
// NOT full LaTeX (no matrices / aligned environments / sized limits). Output is
// assembled only from a fixed MathML vocabulary with every literal escaped, so
// it never echoes user HTML and is safe to inject (bypassing the HTML sanitizer
// which intentionally drops user-supplied <math>/<svg>).
// ---------------------------------------------------------------------------
const MATH_GREEK = {
  alpha:'\u03b1',beta:'\u03b2',gamma:'\u03b3',delta:'\u03b4',epsilon:'\u03f5',varepsilon:'\u03b5',
  zeta:'\u03b6',eta:'\u03b7',theta:'\u03b8',vartheta:'\u03d1',iota:'\u03b9',kappa:'\u03ba',
  lambda:'\u03bb',mu:'\u03bc',nu:'\u03bd',xi:'\u03be',pi:'\u03c0',varpi:'\u03d6',rho:'\u03c1',
  varrho:'\u03f1',sigma:'\u03c3',varsigma:'\u03c2',tau:'\u03c4',upsilon:'\u03c5',phi:'\u03d5',
  varphi:'\u03c6',chi:'\u03c7',psi:'\u03c8',omega:'\u03c9',
  Gamma:'\u0393',Delta:'\u0394',Theta:'\u0398',Lambda:'\u039b',Xi:'\u039e',Pi:'\u03a0',
  Sigma:'\u03a3',Upsilon:'\u03a5',Phi:'\u03a6',Psi:'\u03a8',Omega:'\u03a9'
};
const MATH_OP = {
  dagger:'\u2020',ddagger:'\u2021',times:'\u00d7',div:'\u00f7',cdot:'\u22c5',ast:'\u2217',
  star:'\u22c6',circ:'\u2218',bullet:'\u2219',pm:'\u00b1',mp:'\u2213',oplus:'\u2295',
  ominus:'\u2296',otimes:'\u2297',oslash:'\u2298',odot:'\u2299',
  leq:'\u2264',le:'\u2264',geq:'\u2265',ge:'\u2265',neq:'\u2260',ne:'\u2260',approx:'\u2248',
  equiv:'\u2261',cong:'\u2245',sim:'\u223c',simeq:'\u2243',propto:'\u221d',ll:'\u226a',gg:'\u226b',
  leftarrow:'\u2190',rightarrow:'\u2192',to:'\u2192',gets:'\u2190',leftrightarrow:'\u2194',
  Leftarrow:'\u21d0',Rightarrow:'\u21d2',Leftrightarrow:'\u21d4',mapsto:'\u21a6',
  uparrow:'\u2191',downarrow:'\u2193',implies:'\u27f9',iff:'\u27fa',
  in:'\u2208',notin:'\u2209',ni:'\u220b',subset:'\u2282',subseteq:'\u2286',supset:'\u2283',
  supseteq:'\u2287',cup:'\u222a',cap:'\u2229',setminus:'\u2216',emptyset:'\u2205',varnothing:'\u2205',
  forall:'\u2200',exists:'\u2203',nexists:'\u2204',neg:'\u00ac',lnot:'\u00ac',land:'\u2227',
  wedge:'\u2227',lor:'\u2228',vee:'\u2228',
  langle:'\u27e8',rangle:'\u27e9',lfloor:'\u230a',rfloor:'\u230b',lceil:'\u2308',rceil:'\u2309',
  sum:'\u2211',prod:'\u220f',coprod:'\u2210',int:'\u222b',oint:'\u222e',iint:'\u222c',iiint:'\u222d',
  partial:'\u2202',nabla:'\u2207',angle:'\u2220',perp:'\u22a5',parallel:'\u2225',mid:'\u2223',
  cdots:'\u22ef',ldots:'\u2026',dots:'\u2026',vdots:'\u22ee',ddots:'\u22f1',prime:'\u2032'
};
const MATH_ID = { infty:'\u221e',hbar:'\u210f',ell:'\u2113',Re:'\u211c',Im:'\u2111',aleph:'\u2135',wp:'\u2118' };
const MATH_FUNCS = new Set(['sin','cos','tan','cot','sec','csc','sinh','cosh','tanh','log','ln','lg',
  'exp','lim','limsup','liminf','max','min','sup','inf','arg','det','dim','ker','deg','gcd','hom','Pr',
  'arcsin','arccos','arctan','mod']);
const MATH_ACCENT = { hat:'\u005e',widehat:'\u005e',tilde:'\u007e',widetilde:'\u007e',bar:'\u203e',
  overline:'\u203e',vec:'\u2192',dot:'\u02d9',ddot:'\u00a8',acute:'\u00b4',grave:'\u0060',check:'\u02c7',breve:'\u02d8' };
const MATH_FONT = { mathbb:'double-struck',mathcal:'script',mathfrak:'fraktur',mathbf:'bold',
  boldsymbol:'bold',mathrm:'normal',mathsf:'sans-serif',mathtt:'monospace',mathit:'italic' };
const MATH_SPACE = { ',':'0.17em',':':'0.22em',';':'0.28em','!':'-0.17em',quad:'1em',qquad:'2em' };

function _mathEsc(x){ return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function latexToMathML(src, display){
  let i=0; const s=src||'';
  const mrow = a => a.length===1 ? a[0] : '<mrow>'+a.join('')+'</mrow>';
  const EMPTY='<mrow></mrow>';
  function skipWs(){ while(i<s.length && /\s/.test(s[i])) i++; }
  function readGroup(){ skipWs(); if(s[i]==='{'){ i++; return mrow(parseList('}')); } return parseAtom()||EMPTY; }
  function readRaw(){ skipWs(); if(s[i]!=='{'){ const c=s[i++]; return c||''; } i++; let d=1,out='';
    while(i<s.length && d>0){ const c=s[i++]; if(c==='{')d++; else if(c==='}'){ d--; if(d===0)break; } out+=c; } return out; }
  function parseCommand(){
    i++; let name='';
    if(/[a-zA-Z]/.test(s[i])){ while(i<s.length && /[a-zA-Z]/.test(s[i])) name+=s[i++]; } else { name=s[i++]||''; }
    if(name==='frac'||name==='tfrac'||name==='dfrac'){ const a=readGroup(),b=readGroup(); return '<mfrac>'+a+b+'</mfrac>'; }
    if(name==='binom'){ const a=readGroup(),b=readGroup(); return '<mrow><mo>(</mo><mfrac linethickness="0">'+a+b+'</mfrac><mo>)</mo></mrow>'; }
    if(name==='sqrt'){ let idx=null; skipWs(); if(s[i]==='['){ i++; idx=mrow(parseList(']')); } const a=readGroup(); return idx? '<mroot>'+a+idx+'</mroot>' : '<msqrt>'+a+'</msqrt>'; }
    if(MATH_ACCENT[name]){ const a=readGroup(); return '<mover accent="true">'+a+'<mo>'+_mathEsc(MATH_ACCENT[name])+'</mo></mover>'; }
    if(MATH_FONT[name]){ const raw=readRaw(); return '<mi mathvariant="'+MATH_FONT[name]+'">'+_mathEsc(raw)+'</mi>'; }
    if(name==='text'||name==='textrm'||name==='textbf'||name==='mbox'){ const raw=readRaw(); return '<mtext>'+_mathEsc(raw)+'</mtext>'; }
    if(name==='operatorname'){ const raw=readRaw(); return '<mi mathvariant="normal">'+_mathEsc(raw)+'</mi>'; }
    if(name==='left'||name==='right'){ skipWs(); const d=s[i++]||''; if(d==='.') return ''; return '<mo stretchy="true">'+_mathEsc(d)+'</mo>'; }
    if(MATH_SPACE[name]!==undefined){ return '<mspace width="'+MATH_SPACE[name]+'"/>'; }
    if(MATH_OP[name]!==undefined){ return '<mo>'+_mathEsc(MATH_OP[name])+'</mo>'; }
    if(MATH_ID[name]!==undefined){ return '<mi>'+_mathEsc(MATH_ID[name])+'</mi>'; }
    if(MATH_GREEK[name]!==undefined){ return '<mi>'+_mathEsc(MATH_GREEK[name])+'</mi>'; }
    if(MATH_FUNCS.has(name)){ return '<mi>'+_mathEsc(name)+'</mi>'; }
    if(name==='\\'){ return '<mspace linebreak="newline"/>'; }
    return '<mtext>\\'+_mathEsc(name)+'</mtext>';
  }
  function parseAtom(){
    const ch=s[i]; if(ch===undefined) return '';
    if(ch==='{'){ i++; return mrow(parseList('}')); }
    if(ch==='\\') return parseCommand();
    i++;
    if(/\s/.test(ch)) return '';
    if(ch>='0'&&ch<='9'){ let num=ch; while(i<s.length && /[0-9.]/.test(s[i])) num+=s[i++]; return '<mn>'+num+'</mn>'; }
    if(/[a-zA-Z]/.test(ch)) return '<mi>'+ch+'</mi>';
    if(ch==='-') return '<mo>\u2212</mo>';
    if(ch==="'") return '<mo>\u2032</mo>';
    return '<mo>'+_mathEsc(ch)+'</mo>';
  }
  function parseList(stop){
    const out=[];
    while(i<s.length){
      const ch=s[i];
      if(stop && ch===stop){ i++; break; }
      if(!stop && ch==='}'){ break; }
      if(ch==='_'||ch==='^'){
        i++; skipWs();
        const base=out.length?out.pop():EMPTY; let sub=null,sup=null;
        if(ch==='_'){ sub=readGroup(); skipWs(); if(s[i]==='^'){ i++; skipWs(); sup=readGroup(); } }
        else { sup=readGroup(); skipWs(); if(s[i]==='_'){ i++; skipWs(); sub=readGroup(); } }
        if(sub!=null && sup!=null) out.push('<msubsup>'+base+sub+sup+'</msubsup>');
        else if(sub!=null) out.push('<msub>'+base+sub+'</msub>');
        else out.push('<msup>'+base+sup+'</msup>');
        continue;
      }
      const a=parseAtom(); if(a) out.push(a);
    }
    return out;
  }
  const body = mrow(parseList(null));
  return '<math xmlns="http://www.w3.org/1998/Math/MathML"'+(display?' display="block"':'')+'>'+body+'</math>';
}

// $$...$$ (display) or $...$ (inline, no leading/trailing space to avoid matching prose like "$5 ... $10")
const MATH_DELIM_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/;
function containsMath(text){
  if(!text || text.indexOf('$')<0) return false;
  return new RegExp(MATH_DELIM_RE.source).test(text);
}
// Render `text` into `container`, converting $...$ / $$...$$ to MathML while
// passing the surrounding text through the normal (sanitized) rendering path.
function appendMathAware(container, text){
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  let last=0, m;
  const plain=(str)=>{
    if(!str) return;
    if(hasInlineMarkup(str)){
      const span=document.createElement('span');
      span.innerHTML=sanitizeInlineHTML(str);
      autoLinkPlainTextNodes(span);
      while(span.firstChild) container.appendChild(span.firstChild);
    } else { appendTextWithLinks(container, str); }
  };
  while((m=re.exec(text))){
    plain(text.slice(last, m.index));
    const tex = m[1]!=null ? m[1] : m[2];
    const display = m[1]!=null;
    let mathml=null; try{ mathml=latexToMathML(tex, display); }catch(e){ mathml=null; }
    if(mathml){
      const tmp=document.createElement('span');
      tmp.innerHTML = mathml;                 // HTML5 parses <math> as MathML foreign content
      while(tmp.firstChild) container.appendChild(tmp.firstChild);
    } else { container.appendChild(document.createTextNode(m[0])); }
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
}

// Render text that may contain BOTH inline formatting/markup AND $...$ math.
// Math is extracted first into placeholder tokens (so its contents are never
// parsed as HTML), the remaining text is formatted/linked, then the rendered
// MathML is dropped back in. Lets math coexist with bold/italic/bullets/links -
// <b>$x^2$</b>, bulleted equations, etc.  (PUA placeholders survive HTML parsing.)
function renderFormattedWithMath(container, text){
  const slots=[];
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const masked=(text||'').replace(re,(full,dd,inl)=>{
    const tex = dd!=null ? dd : inl, display = dd!=null;
    let mathml=null; try{ mathml=latexToMathML(tex, display); }catch(e){ mathml=null; }
    slots.push({mathml, original: full});
    return '\uE000'+(slots.length-1)+'\uE001';
  });
  // Entities (&rarr; &#8594; ...) only decode via innerHTML, so route them through
  // the sanitizer too - createTextNode would show them literally.
  if(hasInlineMarkup(masked) || HTML_ENTITY_RE.test(masked)) container.innerHTML = sanitizeInlineHTML(masked);
  else container.appendChild(document.createTextNode(masked));
  autoLinkPlainTextNodes(container);
  if(!slots.length) return;
  const walker=document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const hits=[]; let tn;
  while((tn=walker.nextNode())){ if(tn.nodeValue && tn.nodeValue.indexOf('\uE000')>=0) hits.push(tn); }
  hits.forEach(node=>{
    const parts=node.nodeValue.split(/\uE000(\d+)\uE001/);   // [text, idx, text, idx, ...]
    const frag=document.createDocumentFragment();
    for(let i=0;i<parts.length;i++){
      if(i%2===0){ if(parts[i]) frag.appendChild(document.createTextNode(parts[i])); }
      else {
        const slot=slots[+parts[i]];
        if(slot && slot.mathml){ const tmp=document.createElement('span'); tmp.innerHTML=slot.mathml; while(tmp.firstChild) frag.appendChild(tmp.firstChild); }
        else frag.appendChild(document.createTextNode(slot ? slot.original : ''));
      }
    }
    node.parentNode.replaceChild(frag, node);
  });
}
// Formats a node's created/updated timestamp for the hover watermark - e.g. "Jul 15, 2026 · 3:42 PM".
// Uses the browser's own locale, same as everything else in the app that shows a date.
function formatNodeTimestamp(ts){
  if(!ts) return '';
  try{
    const d=new Date(ts);
    if(isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})+' \u00b7 '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }catch(e){ return ''; }
}
function renderNodeText(container, text, listType){
  container.textContent='';
  const isHTML = hasInlineMarkup(text);
  if(!listType){
    // Build formatting + math together so e.g. <b>$x^2$</b> renders both.
    renderFormattedWithMath(container, text);
    return;
  }
  // List mode: split on newlines (or <br> if HTML), one bullet per line
  let lines;
  if(isHTML){
    // Normalize <br> to \n for splitting; strip tags for prefixing purposes
    const tmp=document.createElement('div'); tmp.innerHTML=sanitizeInlineHTML(text);
    // Replace <br> with \n
    tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    lines = tmp.innerHTML.split(/\n+/);
  } else {
    lines = (text||'').split('\n');
  }
  lines.forEach((line, i)=>{
    if(i>0) container.appendChild(document.createElement('br'));
    const prefix = document.createElement('span');
    prefix.className='list-marker';
    prefix.textContent = listType==='ol' ? `${i+1}.\u00A0` : '•\u00A0';
    container.appendChild(prefix);
    const span=document.createElement('span');
    container.appendChild(span);
    // Bullet lines support the same formatting + math, so equations inside a
    // list render as math instead of raw $...$.
    renderFormattedWithMath(span, line);
  });
}
// Walk text nodes inside `root` and convert any bare URLs into <a> links.
// Skips text already inside an <a>, so we don't double-link.
function autoLinkPlainTextNodes(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toReplace=[];
  let node;
  while((node = walker.nextNode())){
    if(node.parentElement && node.parentElement.closest('a')) continue;
    if(URL_RE.test(node.nodeValue||'')) toReplace.push(node);
  }
  toReplace.forEach(t=>{
    const frag=document.createDocumentFragment();
    appendTextWithLinks(frag, t.nodeValue||'');
    t.parentNode.replaceChild(frag, t);
  });
}

function colorFor(hex){ // root gradient
  return `linear-gradient(135deg, ${hex}, ${shade(hex,-22)})`;
}
function shade(hex,amt){
  const n=parseInt(hex.slice(1),16);
  let r=(n>>16)+amt,g=((n>>8)&255)+amt,b=(n&255)+amt;
  r=Math.max(0,Math.min(255,r));g=Math.max(0,Math.min(255,g));b=Math.max(0,Math.min(255,b));
  return '#'+((r<<16)|(g<<8)|b).toString(16).padStart(6,'0');
}
// sRGB lerp between two #rrggbb hexes by t (0..1) - mirrors the zebra tint's
// color-mix(in srgb, ...) so the PNG export matches the on-screen striping.
function mixHex(a,b,t){
  const pa=parseInt(a.slice(1),16), pb=parseInt(b.slice(1),16);
  const r=Math.round(((pa>>16)&255)*(1-t)+((pb>>16)&255)*t);
  const g=Math.round(((pa>>8)&255)*(1-t)+((pb>>8)&255)*t);
  const bl=Math.round((pa&255)*(1-t)+(pb&255)*t);
  return '#'+((r<<16)|(g<<8)|bl).toString(16).padStart(6,'0');
}
// Shared: stair sub-branch path (drawEdges + exportPNG both need the exact
// same geometry - horizontal stem from parent's side to child's centre line,
// then a vertical attachment stub ending at the child's near edge).
function stairEdgePath(p, n){
  const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
  const ncx=n.x+(n.w||0)/2, ncy=n.y+(n.h||0)/2;
  const sx = ncx < pcx ? p.x : p.x+(p.w||0);
  const sy = pcy;
  const edgeY = ncy >= pcy ? n.y : n.y + (n.h||0);
  return `M${sx},${sy} L${ncx},${sy} L${ncx},${edgeY}`;
}
function drawEdges(hidden){
  const style=map.style||'modern';
  const layout=map.layout||'balanced';
  const segs=[];
  for(const id in map.nodes){
    const n=map.nodes[id]; if(!n.parent||hidden.has(id)||hidden.has(n.parent)) continue;
    const p=map.nodes[n.parent]; if(!p) continue;
    // Choose attach points based on layout orientation
    let x1,y1,x2,y2,horizontal=true,leftSide=(n.side==='left'),d;
    if(layout==='timeline' && n.parent!==map.rootId){
      // Sub-topic stem: straight up (or down) out of the main topic, then
      // across to the child. Direction is derived from the placed geometry
      // rather than a stored side, so it stays correct if a node is dragged.
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncy=n.y+(n.h||0)/2;
      const sx=pcx, sy = ncy<pcy ? p.y : p.y+(p.h||0);
      d = `M${sx},${sy} L${sx},${ncy} L${n.x},${ncy}`;
    } else if(layout==='stair' && n.parent!==map.rootId){
      // Stair sub-branch: horizontal stem from parent side to child's centre line,
      // then vertical with a short attachment stub to the child's edge. The 10px
      // vertical gap (indent 30 vs h/2 20) keeps the child's top off the main
      // horizontal branch so the attachment reads as a distinct step.
      d = stairEdgePath(p, n);
    } else if(layout==='radial'){
      // Spokes. The default bezier attaches to a card's left or right edge,
      // which on a radial map sends a connector for a node directly ABOVE the
      // centre looping out sideways and back - the single thing that stopped
      // it reading as radial. Centre-to-centre is the honest line here: the
      // edge SVG sits beneath the cards, so the overlap is hidden and what
      // remains is a clean spoke.
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncx=n.x+(n.w||0)/2, ncy=n.y+(n.h||0)/2;
      d = `M${pcx},${pcy} L${ncx},${ncy}`;
    } else if(layout==='grid'){
      if(n.parent===map.rootId){
        // Root to card: drop, across, drop. Long curves between grid cards
        // read as accidental rather than structural.
        const sx=p.x+(p.w||0)/2, sy=p.y+(p.h||0);
        const tx=n.x+(n.w||0)/2, ty=n.y;
        const mid=(sy+ty)/2;
        d = `M${sx},${sy} L${sx},${mid} L${tx},${mid} L${tx},${ty}`;
      } else {
        // Within a card's outline: the classic indented-list elbow - straight
        // down the parent's left edge, then across to the child. Indentation
        // already carries the hierarchy, so this only needs to confirm it.
        const sx=p.x+12, sy=p.y+(p.h||0);
        const ty=n.y+(n.h||0)/2;
        d = `M${sx},${sy} L${sx},${ty} L${n.x},${ty}`;
      }
    } else if(layout==='matrix'){
      // Straight centre-to-centre drop, like XMind's matrix/spreadsheet
      // structure: a parent sits directly above its cell stack, so a clean
      // vertical connector reads as a table hierarchy rather than a branch.
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0);
      const ncx=n.x+(n.w||0)/2, ncy=n.y;
      d = `M${pcx},${pcy} L${ncx},${ncy}`;
    } else {
      if(layout==='down'){
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
        x2=n.x+(n.w||0)/2; y2=n.y;
      } else if(layout==='up'){
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y;
        x2=n.x+(n.w||0)/2; y2=n.y+(n.h||0);
      } else if(layout==='stair'){
        // root → chain item: vertical spine like down
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
        x2=n.x+(n.w||0)/2; y2=n.y;
      } else {
        x1=leftSide ? p.x : p.x+(p.w||0);
        y1=p.y+(p.h||0)/2;
        x2=leftSide ? n.x+(n.w||0) : n.x;
        y2=n.y+(n.h||0)/2;
      }
      d = edgePath(x1,y1,x2,y2,leftSide,horizontal,style);
    }
    // Stroke settings per style: colour (null → CSS var), width (null → CSS
    // var), dash (null → solid). Dashed dashes, Minimal thins - the rest keep
    // the themed CSS defaults, so the merged single path below stays identical
    // to the old one-element output for those styles. The style config feeds
    // the dashes here; width and colour ride the --edge-width/--edge-color
    // CSS vars applyStyleConfigVars() sets on #viewport.
    let color=null, width=null, dash=null;
    const _sc = { ...STYLE_CONFIG_DEFAULTS[style], ...((map.styleConfig || {})[style] || {}) };
    if(style==='dashed') dash = _sc.dash > 0 ? `${_sc.dash} ${Math.max(2, Math.round(_sc.dash * 0.7))}` : null;
    segs.push({d, color, width, dash});
  }
  // Merge segments sharing stroke settings into one path element each, so a
  // plain map stays a single <path> and only styles that vary (dashed: dash
  // on, minimal: thin) multiply the element count.
  const merged=new Map();
  for(const s of segs){
    const key=s.color+'|'+s.width+'|'+(s.dash||'');
    merged.set(key, (merged.get(key)||'')+' '+s.d);
  }
  // Cross-links: non-tree edges (references / dependencies). Drawn as separate
  // dotted paths so they read differently from the structural tree edges.
  let linkPath='';
  const linkMarkers=[];
  (map.links||[]).forEach(lk=>{
    const a=map.nodes[lk.from], b=map.nodes[lk.to];
    if(!a||!b) return;
    if(hidden.has(lk.from)||hidden.has(lk.to)) return;
    const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
    const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
    // Gentle curve so overlapping links are distinguishable
    const mx=(ax+bx)/2, my=(ay+by)/2;
    const dx=bx-ax, dy=by-ay;
    const len=Math.hypot(dx,dy)||1;
    const off=Math.min(60, len*0.18);
    const cx=mx - (dy/len)*off, cy=my + (dx/len)*off;
    linkPath += `M${ax},${ay} Q${cx},${cy} ${bx},${by} `;
    linkMarkers.push({x:bx,y:by,cx,cy});
  });
  edges.innerHTML =
    edgePathsHTML(merged) +
    (linkPath ? `<path d="${linkPath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity="0.85"/>` : '');
}
// Build <path> elements from merged edge segments (Map key → path data).
// Pure so tests can pin the stroke/width/dash fallbacks - the 'null' string
// case is exactly the kind of thing that reads fine in code and then renders
// as invisible edges (SVG ignores stroke="null", defaulting to none).
function edgePathsHTML(merged){
  return [...merged].map(([key,d])=>{
    const [color,width,dash]=key.split('|');
    const stroke = (color && color!=='null') ? color : 'var(--edge-color, var(--line-2))';
    const sw     = (width && width!=='null') ? width : 'var(--edge-width, 2.2)';
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${dash&&dash!=='null'?` stroke-dasharray="${dash}"`:''}/>`;
  }).join('');
}
function edgePath(x1,y1,x2,y2,leftSide,horizontal,style){
  switch(style){
    case 'classic': {                                   // step / right-angle elbow
      if(horizontal){
        const mid=(x1+x2)/2;
        return `M${x1},${y1} L${mid},${y1} L${mid},${y2} L${x2},${y2}`;
      } else {
        const mid=(y1+y2)/2;
        return `M${x1},${y1} L${x1},${mid} L${x2},${mid} L${x2},${y2}`;
      }
    }
    case 'sketch': return `M${x1},${y1} L${x2},${y2}`;  // straight line
    case 'zigzag': {                                     // jagged polyline
      const amp=Math.min(12, Math.max(3, (horizontal?Math.abs(x2-x1):Math.abs(y2-y1))/8));
      let d=`M${x1},${y1}`;
      for(let i=1;i<=3;i++){
        const t=i/4;
        const bx=x1+(x2-x1)*t, by=y1+(y2-y1)*t;
        const off=(i%2 ? -amp : amp);
        d += horizontal ? ` L${bx},${by+off}` : ` L${bx+off},${by}`;
      }
      return d+` L${x2},${y2}`;
    }
    case 'bubble':                                       // same path as modern but CSS makes it thicker
    case 'modern':
    default: {                                           // smooth bezier
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        return `M${x1},${y1} C${x1+(leftSide?-dx:dx)},${y1} ${x2+(leftSide?dx:-dx)},${y2} ${x2},${y2}`;
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        const s = y2>y1 ? 1 : -1;
        return `M${x1},${y1} C${x1},${y1+s*dy} ${x2},${y2-s*dy} ${x2},${y2}`;
      }
    }
  }
}

/* ---------- tree helpers ---------- */
// ---- Children index (perf) -------------------------------------------------
// childrenOf is called all over layout/render. Scanning every node each time is
// O(n) per call → O(n²) renders/layouts on big maps. When a parent→children
// index is active (set up for the duration of a render/layout pass), childrenOf
// is O(1). buildChildIndex() builds it in one O(n) pass; withChildIndex(fn) makes
// it available for the duration of fn and restores any previous index after.
let _ci=null;
const EMPTY_KIDS=Object.freeze([]);
function buildChildIndex(){
  const idx=Object.create(null);
  for(const id in map.nodes){
    const p=map.nodes[id].parent;
    if(p==null) continue;
    (idx[p] || (idx[p]=[])).push(id);
  }
  return idx;
}
function withChildIndex(fn){
  const prev=_ci;
  _ci=buildChildIndex();
  try{ return fn(); } finally{ _ci=prev; }
}
const childrenOf=id => _ci
  ? (_ci[id] ? _ci[id].slice() : EMPTY_KIDS)
  : Object.values(map.nodes).filter(n=>n.parent===id).map(n=>n.id);
// Zebra depth map - BFS from the root so level parity is stable even though
// render() iterates map.nodes in arbitrary (insertion) order. Depth 0 = root;
// depths >= 1 feed the alternating tint in styles.css ([data-depth] rules).
function zebraDepth(){
  const d={}; if(!map) return d;
  const rid=map.rootId; if(!rid || !map.nodes[rid]) return d;
  d[rid]=0; const q=[rid]; let qi=0;
  while(qi<q.length){
    const id=q[qi++];
    for(const c of childrenOf(id)){
      if(d[c]!==undefined) continue;     // guard against cyclic parents
      d[c]=d[id]+1; q.push(c);
    }
  }
  return d;
}
function countDesc(id){let c=0;const walk=i=>childrenOf(i).forEach(k=>{c++;walk(k)});walk(id);return c;}
// One O(n) post-order pass computing, for every node: descendant count (desc),
// and task done/total among descendants (tdone/ttot). render() uses these instead
// of calling countDesc()/taskProgress() per node, which were each O(subtree) and
// made a full render O(n²) - the real cost when expanding a large map.
function computeRollups(){
  const desc=Object.create(null), tdone=Object.create(null), ttot=Object.create(null);
  const order=[]; const stack=[map.rootId];
  while(stack.length){ const id=stack.pop(); order.push(id); const ks=childrenOf(id); for(let j=0;j<ks.length;j++) stack.push(ks[j]); }
  for(let i=order.length-1;i>=0;i--){
    const id=order[i]; let d=0,td=0,tt=0;
    const ks=childrenOf(id);
    for(let j=0;j<ks.length;j++){
      const c=ks[j]; d+=desc[c]+1;
      const t=map.nodes[c].task;
      tt+=ttot[c]+(t?1:0); td+=tdone[c]+(t==='done'?1:0);
    }
    desc[id]=d; tdone[id]=td; ttot[id]=tt;
  }
  return {desc,tdone,ttot};
}
function hiddenSet(){
  const h=new Set();
  // Use the active index if we're inside a render/layout scope; otherwise build
  // one locally so this is always O(n), never O(n²) (it's also called by
  // fit/recenter/exportPNG/minimap, which run outside the render scope).
  const idx=_ci || buildChildIndex();
  const walk=(id, hide)=>{
    const newHide = hide || !!map.nodes[id]?.collapsed;
    const kids=idx[id]; if(!kids) return;
    for(const c of kids){ if(newHide) h.add(c); walk(c, newHide); }
  };
  walk(map.rootId,false);
  return h;
}

/* ============================================================
   LAYOUT - tidy tree, supports balanced / right / down
   ============================================================ */
const HGAP=70, VGAP=22, DOWN_HGAP=38, DOWN_VGAP=70;

// ===== Global overlap avoidance =====
// Nudge overlapping nodes apart with minimum displacement, moving whole
// subtrees so branch structure stays intact. The `anchorId` subtree is held
// fixed (the node just added / moved); everything overlapping it is pushed away.
// Preserves manual arrangement - only acts where boxes actually collide.
function _nbox(id){ const n=map.nodes[id]; return {x:n.x, y:n.y, w:n.w||120, h:n.h||40}; }
function _overlap(a,b,gap){
  return a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;
}
function _subtreeSet(id){ const s=new Set([id]); const w=i=>childrenOf(i).forEach(c=>{s.add(c);w(c);}); w(id); return s; }
function shiftSubtreeBy(id,dx,dy){ const n=map.nodes[id]; if(!n) return; n.x+=dx; n.y+=dy; childrenOf(id).forEach(c=>shiftSubtreeBy(c,dx,dy)); }
function resolveOverlaps(anchorId){
  if(!map) return;
  const GAP=16;
  const _lo = map.layout||'balanced';
  const vertical = _lo!=='down' && _lo!=='up';
  const hidden=hiddenSet();
  const ids=Object.keys(map.nodes).filter(id=>!hidden.has(id));
  if(ids.length < 2) return;
  const anchorSet = anchorId ? _subtreeSet(anchorId) : new Set();
  // Cache boxes per iteration to avoid recomputing _nbox for same id many times
  let iterations=0;
  while(iterations++ < 40){
    let movedAny=false;
    // Build cache for this iteration
    const boxCache = new Map();
    const getBox = id => {
      if(!boxCache.has(id)) boxCache.set(id, _nbox(id));
      return boxCache.get(id);
    };
    // Spatial hash: bucket by 200px cells to prune distant pairs
    const cellSize = 260;
    const buckets = new Map();
    for(const id of ids){
      const b=getBox(id);
      const cx=Math.floor((b.x+b.w/2)/cellSize), cy=Math.floor((b.y+b.h/2)/cellSize);
      const key=cx+','+cy;
      if(!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(id);
    }
    const checked = new Set();
    const checkPair = (A,B)=>{
      const key = A<B ? A+','+B : B+','+A;
      if(checked.has(key)) return;
      checked.add(key);
      if(map.nodes[A].parent===B || map.nodes[B].parent===A) return;
      const a=getBox(A), b=getBox(B);
      if(!_overlap(a,b,GAP)) return;
      let mover;
      if(anchorSet.has(A) && !anchorSet.has(B)) mover=B;
      else if(anchorSet.has(B) && !anchorSet.has(A)) mover=A;
      else mover = vertical ? (a.y<=b.y?B:A) : (a.x<=b.x?B:A);
      const other = (mover===A)?B:A;
      const mb=getBox(mover), ob=getBox(other);
      if(vertical){
        const dir = (mb.y >= ob.y) ? 1 : -1;
        const push = dir>0 ? (ob.y+ob.h+GAP - mb.y) : (mb.y+mb.h+GAP - ob.y);
        if(push>0){ shiftSubtreeBy(mover, 0, dir*push); movedAny=true; boxCache.delete(mover); }
      } else {
        const dir = (mb.x >= ob.x) ? 1 : -1;
        const push = dir>0 ? (ob.x+ob.w+GAP - mb.x) : (mb.x+mb.w+GAP - ob.x);
        if(push>0){ shiftSubtreeBy(mover, dir*push, 0); movedAny=true; boxCache.delete(mover); }
      }
    };
    for(const [key, cellIds] of buckets){
      // Check within cell and 8 neighbours
      const [cx,cy]=key.split(',').map(Number);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        const nkey=(cx+dx)+','+(cy+dy);
        const nCell=buckets.get(nkey);
        if(!nCell) continue;
        for(const A of cellIds) for(const B of nCell){
          if(A>=B) continue;
          checkPair(A,B);
          if(movedAny && checked.size>2000) break;
        }
      }
    }
    // Fallback: if no moves but buckets pruned too aggressively, do one full scan every 5 iters
    if(!movedAny && iterations%5===0){
      for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++){ checkPair(ids[i],ids[j]); if(movedAny) break; }
    }
    if(!movedAny) break;
  }
}

// After a node has been resized, push any siblings whose subtree-bounds now
// overlap the resized node (or each other) just enough to restore the default
// gap. We move whole subtrees (children follow), and only nudge - we don't do
// a full relayout, so the user's manual arrangement is preserved.
function resolveResizeCollisions(resizedId){
  if(!map || !map.nodes[resizedId]) return;
  const r = map.nodes[resizedId];
  if(!r.parent) return;                       // root: no siblings to nudge
  const layout = map.layout || 'balanced';
  const vertical = (layout === 'down' || layout === 'up');       // down/up stack horizontally
  const gap = vertical ? DOWN_HGAP : VGAP;

  // Helper: bounding box of a single node
  const box = id => {
    const n = map.nodes[id];
    return { x: n.x, y: n.y, w: n.w||120, h: n.h||40 };
  };
  // Helper: bounding box of a whole subtree (for cleaner collision avoidance -
  // a node + its descendants behave as one block).
  const subtreeBox = id => {
    const ids = [id]; const collect = i => { childrenOf(i).forEach(c => { ids.push(c); collect(c); }); };
    collect(id);
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    ids.forEach(i => {
      const b = box(i);
      if(b.x < minX) minX = b.x;
      if(b.y < minY) minY = b.y;
      if(b.x + b.w > maxX) maxX = b.x + b.w;
      if(b.y + b.h > maxY) maxY = b.y + b.h;
    });
    return { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
  };
  // Helper: shift a whole subtree
  const shift = (id, dx, dy) => {
    const n = map.nodes[id]; n.x += dx; n.y += dy;
    childrenOf(id).forEach(c => shift(c, dx, dy));
  };

  // Only consider siblings on the same side of the parent - those are the
  // ones that are stacked next to the resized node in the layout direction.
  const siblings = childrenOf(r.parent).filter(c => c !== resizedId && map.nodes[c].side === r.side);
  if(!siblings.length) return;

  // Resized-node centre on the stacking axis (y for horizontal layouts, x for down/up)
  const rb = box(resizedId);
  const rCentre = vertical ? rb.x + rb.w/2 : rb.y + rb.h/2;
  // Separate siblings into "before" (lower coord) and "after" (higher coord) on
  // the stacking axis. Sort each so we can cascade nudges.
  const before = [], after = [];
  siblings.forEach(s => {
    const sb = subtreeBox(s);
    const sc = vertical ? sb.x + sb.w/2 : sb.y + sb.h/2;
    (sc < rCentre ? before : after).push(s);
  });
  if(vertical){
    before.sort((a,b) => subtreeBox(b).x - subtreeBox(a).x);  // closest-to-resized first
    after.sort((a,b) => subtreeBox(a).x - subtreeBox(b).x);
  } else {
    before.sort((a,b) => subtreeBox(b).y - subtreeBox(a).y);
    after.sort((a,b) => subtreeBox(a).y - subtreeBox(b).y);
  }

  // "After" pass: ensure each successive sibling sits at least `gap` past the
  // previous block on the stacking axis. The first comparison uses the resized
  // node's actual box; subsequent ones use the previous subtree-bounds.
  let prevEnd = vertical ? (rb.x + rb.w) : (rb.y + rb.h);
  after.forEach(s => {
    const sb = subtreeBox(s);
    const start = vertical ? sb.x : sb.y;
    const need  = prevEnd + gap;
    if(start < need){
      const delta = need - start;
      if(vertical) shift(s, delta, 0);
      else         shift(s, 0, delta);
    }
    const newSB = subtreeBox(s);
    prevEnd = vertical ? (newSB.x + newSB.w) : (newSB.y + newSB.h);
  });
  // "Before" pass: mirror image - push earlier siblings backwards if they
  // would overlap with the resized node now (because it grew upward/leftward).
  let prevStart = vertical ? rb.x : rb.y;
  before.forEach(s => {
    const sb = subtreeBox(s);
    const end = vertical ? (sb.x + sb.w) : (sb.y + sb.h);
    const need = prevStart - gap;
    if(end > need){
      const delta = end - need;
      if(vertical) shift(s, -delta, 0);
      else         shift(s, 0, -delta);
    }
    const newSB = subtreeBox(s);
    prevStart = vertical ? newSB.x : newSB.y;
  });

  render();
}

// Assign root children to left/right by subtree weight for a balanced split.
// Used when first building a map (templates) or when explicitly re-balancing;
// stable autoLayout then preserves the assignment.
function balanceRootSides(){
  if(!map) return;
  // The "balanced" layout is the natural first-load arrangement: split the root
  // branches, in their existing top-to-bottom order, into two contiguous halves -
  // first half on the right, second half on the left. Matches how a fresh/imported
  // map is balanced and keeps branch order rather than reshuffling by weight.
  const kids=childrenOf(map.rootId);
  const half=Math.ceil(kids.length/2);
  kids.forEach((k,i)=>{ map.nodes[k].side = (i<half) ? 'right' : 'left'; });
}
// FLIP-animates nodes from their pre-layout positions (captured in `before`, {id:{x,y}})
// to wherever autoLayout() just placed them. Used after tidy layout / collapse-expand-all
// / any autoLayout() re-render, so the map eases into its new shape instead of jumping.
function flipAnimateNodes(before){
  if(!before || document.body.classList.contains('node-dragging')) return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const toAnimate=[];
  document.querySelectorAll('.node[data-id]').forEach(el=>{
    const id=el.dataset.id, b=before[id], n=map && map.nodes[id];
    if(!b || !n) return;                     // brand-new node, or map gone: nothing to FLIP from
    const dx=b.x-n.x, dy=b.y-n.y;
    if(Math.abs(dx)<0.5 && Math.abs(dy)<0.5) return;   // negligible/no movement
    el.style.transition='none';
    el.style.transform=`translate(${dx}px,${dy}px)`;
    toAnimate.push(el);
  });
  if(!toAnimate.length) return;
  void document.body.offsetHeight;   // force layout so the browser registers the starting transform before animating away from it
  requestAnimationFrame(()=>{
    toAnimate.forEach(el=>{ el.style.transition='transform .22s cubic-bezier(.4,0,.2,1)'; el.style.transform=''; });
    setTimeout(()=>{ toAnimate.forEach(el=>{ el.style.transition=''; }); }, 260);   // hand back to the normal CSS transition afterward
  });
}
/* ------------------------------------------------------------
   Layout configuration.

   The knobs a layout exposes, as plain validated JSON stored on the map
   (map.layoutConfig) so it travels with share links and exports.

   Deliberately DATA, never code. A layout config arrives on a stranger's
   machine whenever they open a #view= link, so anything executable here
   would be a code-execution channel into shared maps - the opposite of the
   care taken in sanitizeInlineHTML(). Numbers get clamped, unknown keys are
   dropped, and a malformed config falls back to defaults rather than
   throwing: a bad config should never make a map unopenable.
   ------------------------------------------------------------ */
const LAYOUT_CONFIG_DEFAULTS = {
  // The four tree layouts share a shape (gap between depth levels, gap between
  // siblings) but not values: 'down'/'up' stack generations vertically, so their
  // larger gap is the vertical one. 'up' is the exact vertical mirror of 'down'.
  balanced: { hGap:70, vGap:22 },
  right:    { hGap:70, vGap:22 },
  left:     { hGap:70, vGap:22 },
  down:     { hGap:38, vGap:70 },
  up:       { hGap:38, vGap:70 },
  radial: { ring:180, startAngle:-90, sweep:360 },
  grid:   { columns:3, gapX:60, gapY:60, rowGap:14, indent:24 },
  timeline: {
    gap: 70,            // horizontal gap between consecutive main topics
    stem: 30,           // clearance between the axis and a sub-topic block
    indent: 26,         // sub-topic inset from its main topic's left edge
    alternate: true,    // alternate sub-topics above/below, or keep one side
    start: 'above',     // which side the first main topic's sub-topics take
  },
  stair: {
    gap: 45,            // vertical gap between consecutive steps - slight decrease for tighter sibling spine (Supervised ↔ Unsupervised)
    stem: 24,           // clearance between the spine and a sub-topic block
    indent: 42,         // sub-topic inset from its step's top edge (h/2 + 22px gap between the horizontal branch and the child's top edge)
    alternate: true,    // alternate sub-topics left/right per step (like timeline)
    start: 'above',     // which side the first step's sub-topics take
  },
  matrix: { colGap:40, rowGap:24, cellGap:10, headGap:60 },
  fishbone: {
    gap: 70,            // gap between consecutive spine items
    stem: 30,           // clearance between the spine and a rib's sub-topic block
    indent: 26,         // sub-topic inset from its rib item's left edge
    alternate: true,    // alternate ribs above/below the spine, or keep one side
    start: 'above',     // which side the first rib takes
    angle: 35,          // rib angle off the spine (90 = perpendicular, like a timeline)
  },
};
// Bounds chosen so any accepted value still produces a readable map: a gap of
// 0 overlaps cards, and very large values scatter them past a usable canvas.
const LAYOUT_CONFIG_BOUNDS = {
  balanced: { hGap:[8,400], vGap:[4,300] },
  right:    { hGap:[8,400], vGap:[4,300] },
  left:     { hGap:[8,400], vGap:[4,300] },
  down:     { hGap:[8,400], vGap:[4,300] },
  up:       { hGap:[8,400], vGap:[4,300] },
  radial:   { ring:[60,600], startAngle:[-360,360], sweep:[30,360] },
  grid:     { columns:[1,8], gapX:[8,300], gapY:[8,300], rowGap:[0,120], indent:[0,120] },
  timeline: { gap:[8,400], stem:[0,300], indent:[0,300] },
  stair:    { gap:[8,400], stem:[0,300], indent:[0,300] },
  matrix:   { colGap:[8,300], rowGap:[8,300], cellGap:[0,120], headGap:[8,300] },
  fishbone: { gap:[8,400], stem:[0,300], indent:[0,300], angle:[10,170] },
};

function validateLayoutConfig(raw){
  const out = {};
  for(const engine of Object.keys(LAYOUT_CONFIG_DEFAULTS)){
    out[engine] = { ...LAYOUT_CONFIG_DEFAULTS[engine] };
  }
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for(const engine of Object.keys(out)){
    const sec = raw[engine];
    if(!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    const bounds = LAYOUT_CONFIG_BOUNDS[engine] || {};
    for(const key of Object.keys(bounds)){
      const v = sec[key];
      if(typeof v !== 'number' || !isFinite(v)) continue;  // strings/NaN ignored, not coerced
      const [lo,hi] = bounds[key];
      out[engine][key] = Math.min(hi, Math.max(lo, Math.round(v)));
    }
    if(engine === 'timeline' || engine === 'fishbone' || engine === 'stair'){
      if(typeof sec.alternate === 'boolean') out[engine].alternate = sec.alternate;
      if(sec.start === 'above' || sec.start === 'below') out[engine].start = sec.start;
    }
  }
  return out;
}
// The knobs that actually apply to one engine - what the settings dialog shows.
function layoutConfigFor(engine, raw){
  const all = validateLayoutConfig(raw);
  return all[engine] ? { [engine]: all[engine] } : {};
}

/* ------------------------------------------------------------
   Chain placement - root children strung along an axis, subtrees hanging off.

   The timeline is one instance of this: root at the left, main topics chained
   rightward on a centre line, sub-trees alternating above and below. The same
   procedure with a different axis gives a vertical timeline; with alternation
   off it gives a single-sided sequence.

   Like layoutTree, the two axes are transposes, so this works in "main" and
   "cross" terms:
     axis 'x'  main = x (the chain runs sideways), cross = y (branches hang up/down)
     axis 'y'  main = y (the chain runs downward),  cross = x (branches hang left/right)

   Mutates x/y/side on the given nodes.
   ------------------------------------------------------------ */
function layoutChain(nodes, rootId, kidsOf, opts){
  const horiz = opts.axis !== 'y';
  const dir = opts.dir < 0 ? -1 : 1;
  const { gap, stem, indent, gapMain, gapCross, alternate, start } = opts;
  // Fishbone is this engine with ribs leaving the spine at an angle instead of
  // square to it. 90 means perpendicular, which is the plain timeline, so the
  // default changes nothing for existing layouts.
  const angle = opts.angle != null ? opts.angle : 90;
  const slant = Math.abs(angle - 90) < 0.01 ? 0 : 1 / Math.tan(angle * Math.PI / 180);

  const mainSize  = n => horiz ? (n.w || 120) : (n.h || 40);
  const crossSize = n => horiz ? (n.h || 40)  : (n.w || 120);
  const setPos = (n, main, cross) => { if(horiz){ n.x = main; n.y = cross; } else { n.y = main; n.x = cross; } };
  const getMain  = n => horiz ? n.x : n.y;
  const getCross = n => horiz ? n.y : n.x;

  // Sub-tree extent along the cross axis (siblings stack there). Memoized per layout pass.
  const extentCache = new Map();
  const extent = id => {
    if(extentCache.has(id)) return extentCache.get(id);
    const n = nodes[id], cs = kidsOf(id);
    if(!cs.length || n.collapsed){ const v=crossSize(n); extentCache.set(id,v); return v; }
    let s = 0; cs.forEach((c,i)=>{ s += extent(c) + (i ? gapCross : 0); });
    const v = Math.max(crossSize(n), s);
    extentCache.set(id,v);
    return v;
  };
  // Ordinary tree placement, used for everything below a chain item.
  const place = (id, main, crossTop) => {
    const n = nodes[id];
    setPos(n, main, crossTop + (extent(id) - crossSize(n)) / 2);
    const cs = kidsOf(id);
    if(!cs.length || n.collapsed) return;
    // Center the children's block so that the visual centers align with the parent.
    // For varying child widths, left-aligned placement makes the average center off by (w2-w1)/4 etc.
    // Compute the total span of centers and shift to align average with parent center.
    const sum = cs.reduce((s,c,i)=>s+extent(c)+(i?gapCross:0),0);
    const offset = (extent(id) - sum)/2;
    let cross = crossTop + offset;
    const childCenters = [];
    const childIds = [];
    cs.forEach(c => {
      const cm = dir > 0 ? getMain(n) + mainSize(n) + gapMain
                         : getMain(n) - mainSize(nodes[c]) - gapMain;
      place(c, cm, cross);
      // Record visual center after placement (actual x+w/2 or y+h/2)
      const child = nodes[c];
      childCenters.push(horiz ? child.y + child.h/2 : child.x + child.w/2);
      childIds.push(c);
      cross += extent(c) + gapCross;
    });
    // For varying child widths, the average visual center is off from the block center.
    // Shift the whole block so that average aligns with parent center (crossTop + extent/2).
    if(cs.length>1){
      const avg = childCenters.reduce((a,b)=>a+b,0)/childCenters.length;
      const desired = crossTop + extent(id)/2;
      const shift = desired - avg;
      if(Math.abs(shift) > 0.5){
        const shiftSubtree = (cid, dx) => {
          const nn = nodes[cid];
          if(horiz) nn.y += dx; else nn.x += dx;
          kidsOf(cid).forEach(ch => shiftSubtree(ch, dx));
        };
        childIds.forEach(cid => shiftSubtree(cid, shift));
      }
    }
  };
  // Furthest point a placed sub-tree reaches along the chain direction, so the
  // next chain item can clear it.
  const reach = id => {
    const n = nodes[id];
    let r = dir > 0 ? getMain(n) + mainSize(n) : getMain(n);
    if(!n.collapsed) kidsOf(id).forEach(c => {
      const cr = reach(c);
      r = dir > 0 ? Math.max(r, cr) : Math.min(r, cr);
    });
    return r;
  };
  const assign = id => { nodes[id].side = opts.sideName || 'right'; kidsOf(id).forEach(assign); };

  const root = nodes[rootId];
  root.side = 'root';
  setPos(root, 0, -crossSize(root) / 2);          // the chain's centre line is cross = 0
  let cursor = dir > 0 ? mainSize(root) + gap : -gap;

  kidsOf(rootId).forEach((id, i) => {
    const item = nodes[id];
    assign(id);
    const itemMain = dir > 0 ? cursor : cursor - mainSize(item);
    setPos(item, itemMain, -crossSize(item) / 2);  // centred on the line
    let far = dir > 0 ? itemMain + mainSize(item) : itemMain;

    const kids = item.collapsed ? [] : kidsOf(id);
    if(kids.length){
      const first = (start === 'below') ? false : true;
      const up = alternate ? ((i % 2 === 0) === first) : first;
      let blockH = 0; kids.forEach((c,j)=>{ blockH += extent(c) + (j ? gapCross : 0); });
      let cross = up ? (getCross(item) - stem - blockH)
                     : (getCross(item) + crossSize(item) + stem);
      kids.forEach(c => {
        // How far this rib sits from the spine, and therefore how far it slides
        // back along it - which is what turns a square branch into a diagonal.
        const off = Math.abs(cross - getCross(item));
        const slide = slant ? off * slant * dir : 0;
        const base = dir > 0 ? getMain(item) + indent
                             : getMain(item) + mainSize(item) - indent - mainSize(nodes[c]);
        place(c, base + slide, cross);
        cross += extent(c) + gapCross;
      });
      kids.forEach(c => { const r = reach(c); far = dir > 0 ? Math.max(far, r) : Math.min(far, r); });
    }
    cursor = dir > 0 ? far + gap : far - gap;
  });
}

/* ------------------------------------------------------------
   Radial placement - root at the centre, descendants on rings.

   Each subtree owns an angular wedge sized by how many leaves it contains, so
   a bushy branch gets more of the circle than a sparse one and siblings never
   compete for the same arc. Depth becomes distance from the centre.

   Mutates x/y/side on the given nodes.
   ------------------------------------------------------------ */
function layoutRadial(nodes, rootId, kidsOf, opts){
  const ring   = opts.ring   != null ? opts.ring   : 180;   // base radius per level
  const start  = (opts.startAngle != null ? opts.startAngle : -90) * Math.PI / 180;
  const sweep  = (opts.sweep      != null ? opts.sweep      : 360) * Math.PI / 180;
  const pad    = opts.pad    != null ? opts.pad    : 14;   // angular gap between neighbouring cards on a ring
  const padV   = opts.padV   != null ? opts.padV   : 16;   // radial gap between a card and its parent

  // Leaf count drives the wedge share. Counting leaves rather than nodes keeps
  // a long thin branch from crowding out a wide shallow one.
  const leavesCache = new Map();
  const leaves = id => {
    if(leavesCache.has(id)) return leavesCache.get(id);
    const n = nodes[id];
    const cs = n.collapsed ? [] : kidsOf(id);
    if(!cs.length){ leavesCache.set(id,1); return 1; }
    let s = 0; cs.forEach(c => { s += leaves(c); });
    leavesCache.set(id,s);
    return s;
  };
  const rootLeaves = leaves(rootId);
  const csOf = id => nodes[id].collapsed ? [] : kidsOf(id);

  // Collect the visible nodes level by level so each ring can be sized to the
  // cards it actually holds.
  const levels = [];
  const parentOf = {};
  const walk = (id, depth) => {
    (levels[depth] = levels[depth] || []).push(id);
    csOf(id).forEach(c => { parentOf[c] = id; walk(c, depth + 1); });
  };
  walk(rootId, 0);

  // Ring radii and angular shares, settled by fixed point. Every card must fit
  // its share of the sweep, so a card wider than its leaf-earned share takes a
  // bigger wedge (taking it from nowhere in particular) and the ring grows
  // until the whole level fits the sweep. That keeps a single long label from
  // inflating every ring: the map only spreads as wide as its widest level.
  const share = {};
  const r = levels.map((_, d) => ring * d);
  for(let pass = 0; pass < 40; pass++){
    for(let depth = levels.length - 1; depth >= 1; depth--){
      levels[depth].forEach(id => {
        let s = sweep * leaves(id) / rootLeaves;
        const cardNeed = ((nodes[id].w || 120) + pad) / Math.max(r[depth], 1);
        if(cardNeed > s) s = cardNeed;
        const kids = csOf(id);
        let kidsSum = 0;
        kids.forEach(c => { kidsSum += share[c]; });
        if(kidsSum > s) s = kidsSum;
        share[id] = s;
      });
    }
    let changed = false;
    for(let depth = 1; depth < levels.length; depth++){
      let total = 0;
      levels[depth].forEach(id => { total += share[id]; });
      if(total > sweep && total > 0){
        const nr = r[depth] * total / sweep;
        if(nr > r[depth]){ r[depth] = nr; changed = true; }
      }
      // Radial clearance: a card may not sit so close to the centre that it
      // covers its parent - with the root as parent, that is the centre.
      let step = r[depth - 1];
      levels[depth].forEach(id => {
        const p = nodes[parentOf[id]];
        step = Math.max(step, r[depth - 1] + (nodes[id].w || 120) / 2 + (p ? (p.w || 120) : 0) / 2 + padV);
      });
      if(r[depth] < step){ r[depth] = step; changed = true; }
    }
    if(!changed) break;
  }

  const place = (id, a0, a1, depth) => {
    const n = nodes[id];
    const mid = (a0 + a1) / 2;
    // Position by centre, then convert to the top-left the renderer expects.
    n.x = Math.cos(mid) * r[depth] - (n.w || 120) / 2;
    n.y = Math.sin(mid) * r[depth] - (n.h || 40) / 2;
    // side drives which edge of the card connectors attach to.
    n.side = depth === 0 ? 'root' : (Math.cos(mid) < 0 ? 'left' : 'right');

    const cs = csOf(id);
    if(!cs.length) return;
    const kidsSum = cs.reduce((s, c) => s + share[c], 0) || 1;
    let a = a0;
    cs.forEach(c => {
      const w = (a1 - a0) * share[c] / kidsSum;
      place(c, a, a + w, depth + 1);
      a += w;
    });
  };

  place(rootId, start, start + sweep, 0);
  nodes[rootId].side = 'root';
}

/* ------------------------------------------------------------
   Matrix placement - root children as columns, their children as aligned rows.

   Looks like the grid at a glance, but the defining property is different:
   row N means the same thing in every column, so rows share a height and line
   up horizontally. That alignment is what makes a matrix readable as a table,
   and it is why this cannot be the grid with different numbers - the grid
   sizes each column independently.

   Anything below the second level is stacked inside its cell.
   ------------------------------------------------------------ */
function layoutMatrix(nodes, rootId, kidsOf, opts){
  const colGap = opts.colGap != null ? opts.colGap : 40;
  const rowGap = opts.rowGap != null ? opts.rowGap : 24;
  const cellGap = opts.cellGap != null ? opts.cellGap : 10;   // between stacked descendants
  const headGap = opts.headGap != null ? opts.headGap : 60;   // root to the header row

  const cols = kidsOf(rootId);
  // Everything under a cell, flattened - the matrix aligns rows, so a deep
  // branch stacks within its cell rather than spawning new columns.
  const stackOf = (id, out) => {
    out.push(id);
    if(!nodes[id].collapsed) kidsOf(id).forEach(c => stackOf(c, out));
    return out;
  };
  const cellsFor = colId => (nodes[colId].collapsed ? [] : kidsOf(colId))
    .map(rowId => stackOf(rowId, []));

  const grid = cols.map(cellsFor);
  const rowCount = grid.reduce((m, cells) => Math.max(m, cells.length), 0);

  // Uniform column widths and - the point of a matrix - uniform row heights.
  const colW = cols.map((colId, c) => {
    let w = nodes[colId].w || 120;
    grid[c].forEach(stack => stack.forEach(id => { w = Math.max(w, nodes[id].w || 120); }));
    return w;
  });
  const rowH = [];
  for(let r = 0; r < rowCount; r++){
    let h = 0;
    grid.forEach(cells => {
      const stack = cells[r];
      if(!stack) return;
      let sh = 0;
      stack.forEach((id, i) => { sh += (nodes[id].h || 40) + (i ? cellGap : 0); });
      h = Math.max(h, sh);
    });
    rowH[r] = h;
  }

  const colX = []; let x = 0;
  colW.forEach((w, i) => { colX[i] = x; x += w + colGap; });
  const totalW = x > 0 ? x - colGap : 0;

  const root = nodes[rootId];
  root.side = 'root';
  root.x = totalW / 2 - (root.w || 120) / 2;
  root.y = 0;

  const headY = (root.h || 40) + headGap;
  const rowY = []; let y = headY + (cols.length ? Math.max(...cols.map(id => nodes[id].h || 40)) + rowGap : 0);
  rowH.forEach((h, i) => { rowY[i] = y; y += h + rowGap; });

  cols.forEach((colId, c) => {
    const head = nodes[colId];
    head.side = 'down';
    head.x = colX[c]; head.y = headY;
    grid[c].forEach((stack, r) => {
      let cy = rowY[r];
      stack.forEach(id => {
        const n = nodes[id];
        n.side = 'down';
        n.x = colX[c]; n.y = cy;
        cy += (n.h || 40) + cellGap;
      });
    });
  });
}

/* ------------------------------------------------------------
   Grid placement - root children as cards in a grid, each with its
   sub-tree as an indented outline beneath it.

   Useful when the root's children are peers to be compared rather than a
   hierarchy to be traced: a board of topics rather than a branching map.
   ------------------------------------------------------------ */
function layoutGrid(nodes, rootId, kidsOf, opts){
  const cols   = Math.max(1, opts.columns != null ? opts.columns : 3);
  const gapX   = opts.gapX   != null ? opts.gapX   : 60;   // between columns
  const gapY   = opts.gapY   != null ? opts.gapY   : 60;   // between rows
  const rowGap = opts.rowGap != null ? opts.rowGap : 14;   // between outline rows
  const indent = opts.indent != null ? opts.indent : 24;   // per outline level

  // Flatten a sub-tree into indented rows, and measure the block it needs.
  const rowsOf = (id, depth, out) => {
    const n = nodes[id];
    out.push({ id, depth });
    if(n.collapsed) return out;
    kidsOf(id).forEach(c => rowsOf(c, depth + 1, out));
    return out;
  };
  const blockSize = rows => {
    let w = 0, h = 0;
    rows.forEach((r, i) => {
      const n = nodes[r.id];
      w = Math.max(w, r.depth * indent + (n.w || 120));
      h += (n.h || 40) + (i ? rowGap : 0);
    });
    return { w, h };
  };

  const kids = kidsOf(rootId);
  const cells = kids.map(id => {
    const rows = rowsOf(id, 0, []);
    return { id, rows, size: blockSize(rows) };
  });

  // Uniform column widths and per-row heights keep the grid readable.
  const colW = [];
  cells.forEach((c, i) => {
    const col = i % cols;
    colW[col] = Math.max(colW[col] || 0, c.size.w);
  });
  const rowH = [];
  cells.forEach((c, i) => {
    const row = Math.floor(i / cols);
    rowH[row] = Math.max(rowH[row] || 0, c.size.h);
  });
  const colX = [];
  let x = 0;
  for(let i = 0; i < colW.length; i++){ colX[i] = x; x += colW[i] + gapX; }
  const gridW = x > 0 ? x - gapX : 0;

  const root = nodes[rootId];
  root.side = 'root';
  root.x = gridW / 2 - (root.w || 120) / 2;      // centred above the grid
  root.y = 0;
  const top = (root.h || 40) + gapY;

  const rowY = [];
  let y = top;
  for(let i = 0; i < rowH.length; i++){ rowY[i] = y; y += rowH[i] + gapY; }

  cells.forEach((cell, i) => {
    const cx = colX[i % cols];
    let cy = rowY[Math.floor(i / cols)];
    cell.rows.forEach(r => {
      const n = nodes[r.id];
      n.x = cx + r.depth * indent;
      n.y = cy;
      n.side = 'down';
      cy += (n.h || 40) + rowGap;
    });
  });
}

// Named chain layouts, in the same spirit as TREE_LAYOUTS: the timeline is one
// set of parameters, not a special case. Verified against positions captured
// from the previous hand-written layoutTimeline - identical output for every
// shape and config in test/fixtures/chain-layout-golden.json.
const CHAIN_LAYOUTS = {
  timeline: { axis:'x', dir: 1 },
};
function chainLayoutOpts(name, cfg, hGap, vGap){
  const base = CHAIN_LAYOUTS[name];
  if(!base) return null;
  const t = validateLayoutConfig(cfg).timeline;
  return { ...base, gap:t.gap, stem:t.stem, indent:t.indent,
           alternate:t.alternate, start:t.start,
           gapMain:hGap, gapCross:vGap };
}

/* ------------------------------------------------------------
   Tree placement - one engine behind balanced / right / left / down.

   Those four are not four algorithms. They are the same recursive procedure
   with three parameters: which axis subtrees grow along, which direction, and
   whether the root splits its children between both directions. Writing them
   separately hid that, and meant a new variant (org-chart upward, logic chart
   with the root centred) needed new code rather than new numbers.

   The two axes are transposes of each other, so the code works in "main" and
   "cross" terms:
     axis 'x'  main = x (subtrees grow sideways), cross = y (siblings stack)
     axis 'y'  main = y (subtrees grow downward),  cross = x (siblings stack)

   Mutates x/y/side on the given nodes, like the other layout paths.
   ------------------------------------------------------------ */
function layoutTree(nodes, rootId, kidsOf, opts){
  const horiz = opts.axis !== 'y';
  const gapMain  = opts.gapMain,  gapCross = opts.gapCross;
  const mainSize  = n => horiz ? (n.w || 120) : (n.h || 40);
  const crossSize = n => horiz ? (n.h || 40)  : (n.w || 120);
  const setPos = (n, main, cross) => { if(horiz){ n.x = main; n.y = cross; } else { n.y = main; n.x = cross; } };
  const getMain = n => horiz ? n.x : n.y;

  // Cross-axis extent of a subtree: siblings stack along this axis, so it is
  // the sum of their extents, floored at the node's own size.
  const extent = id => {
    const n = nodes[id], cs = kidsOf(id);
    if(!cs.length || n.collapsed) return crossSize(n);
    let s = 0; cs.forEach((c,i)=>{ s += extent(c) + (i ? gapCross : 0); });
    return Math.max(crossSize(n), s);
  };
  // Place a node centred within its own subtree extent, then lay out children.
  const place = (id, main, crossTop, dir) => {
    const n = nodes[id];
    setPos(n, main, crossTop + (extent(id) - crossSize(n)) / 2);
    const cs = kidsOf(id);
    if(!cs.length || n.collapsed) return;
    let cross = crossTop;
    cs.forEach(c => {
      // Growing backwards positions by the CHILD's size, since coordinates are
      // top-left based; growing forwards positions past the parent's.
      const cm = dir > 0 ? getMain(n) + mainSize(n) + gapMain
                         : getMain(n) - mainSize(nodes[c]) - gapMain;
      place(c, cm, cross, dir);
      cross += extent(c) + gapCross;
    });
  };
  const assign = (id, side) => { nodes[id].side = side; kidsOf(id).forEach(c => assign(c, side)); };

  const root = nodes[rootId];
  root.side = 'root';
  const kids = kidsOf(rootId);

  // 'centered' runs the root through the placer, so it sits centred over its
  // children (org-chart). 'origin' pins it at 0,0 and balances each side's
  // block around its middle (mind-map).
  if(opts.rootAnchor === 'centered'){
    kids.forEach(k => assign(k, opts.sideName));
    place(rootId, 0, 0, opts.dir);
    return;
  }

  let backSet = [], fwdSet = [];
  if(opts.split === 'balanced'){
    // STABLE: keep whatever side each child already has so the map never
    // reshuffles on an unrelated edit; only new children (no side) are
    // assigned, to whichever side is lighter.
    kids.forEach(k => {
      const s = nodes[k].side;
      if(s === 'left') backSet.push(k); else if(s === 'right') fwdSet.push(k);
    });
    kids.forEach(k => {
      const s = nodes[k].side;
      if(s !== 'left' && s !== 'right'){
        if(fwdSet.length <= backSet.length){ fwdSet.push(k); nodes[k].side = 'right'; }
        else { backSet.push(k); nodes[k].side = 'left'; }
      }
    });
  } else if(opts.dir > 0){ fwdSet = kids.slice(); } else { backSet = kids.slice(); }

  fwdSet.forEach(k => assign(k, 'right'));
  backSet.forEach(k => assign(k, 'left'));

  root.x = 0; root.y = 0;
  const rootMid = (root.h || 50) / 2;   // 50, matching the original default here
  let fTop = -(fwdSet.reduce((s,k,i)=> s + extent(k) + (i ? gapCross : 0), 0)) / 2 + rootMid;
  fwdSet.forEach(k => { const e = extent(k); place(k, root.x + (root.w || 120) + gapMain, fTop, 1); fTop += e + gapCross; });
  let bTop = -(backSet.reduce((s,k,i)=> s + extent(k) + (i ? gapCross : 0), 0)) / 2 + rootMid;
  backSet.forEach(k => { const e = extent(k); place(k, root.x - (nodes[k].w || 120) - gapMain, bTop, -1); bTop += e + gapCross; });
}

// The parameters that reproduce each named layout. Verified against positions
// captured from the previous hand-written implementations: identical output for
// every shape/layout combination in test/fixtures/tree-layout-golden.json.
//
// Note the gap swap on the vertical axis: with subtrees growing downward, hGap
// separates SIBLINGS (cross axis) and vGap separates GENERATIONS (main axis) -
// the reverse of the horizontal layouts. Getting this backwards is the one
// mistake this table exists to prevent.
const TREE_LAYOUTS = {
  balanced: { axis:'x', dir: 1, split:'balanced', rootAnchor:'origin' },
  right:    { axis:'x', dir: 1, split:'one-side', rootAnchor:'origin' },
  left:     { axis:'x', dir:-1, split:'one-side', rootAnchor:'origin' },
  down:     { axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down' },
  up:       { axis:'y', dir:-1, split:'one-side', rootAnchor:'centered', sideName:'up' },
};
function treeLayoutOpts(name, hGap, vGap){
  const base = TREE_LAYOUTS[name];
  if(!base) return null;
  return base.axis === 'y'
    ? { ...base, gapMain: vGap, gapCross: hGap }
    : { ...base, gapMain: hGap, gapCross: vGap };
}

function autoLayout(noRender){
  if(!map) return;
  const _prevCI=_ci; _ci=buildChildIndex();   // O(1) childrenOf for the whole layout
  // Snapshot current positions before anything below moves them - used to FLIP-animate
  // into the new layout once it's rendered (see flipAnimateNodes), so "tidy layout" and
  // "collapse/expand all" ease into place instead of jumping. render() clears and rebuilds
  // node DOM elements from scratch, so a plain CSS left/top transition can't apply here -
  // this replays the movement manually via a transform on the fresh elements instead.
  const _beforePos={}; for(const id in map.nodes){ const n=map.nodes[id]; _beforePos[id]={x:n.x,y:n.y}; }
  try{
  // Render-to-measure only if some visible node has no measured size yet (e.g.
  // it was just revealed by expanding). This avoids a full extra render on every
  // collapse/expand - the single biggest cost when expanding a large branch.
  const _hid=hiddenSet(); let _needMeasure=false;
  for(const id in map.nodes){ if(!_hid.has(id) && !(map.nodes[id].w>0)){ _needMeasure=true; break; } }
  if(!noRender && _needMeasure) render();
  const root=map.nodes[map.rootId];
  root.side='root';
  const layout = map.layout || 'balanced';
  // Spacing comes from this map's config. Local names, so the module constants
  // stay the defaults and other callers (drag-insertion, FLIP) are unaffected.
  const _lc = validateLayoutConfig(map.layoutConfig)[layout] || LAYOUT_CONFIG_DEFAULTS.balanced;
  const LH = (_lc.hGap != null) ? _lc.hGap : HGAP;
  const LV = (_lc.vGap != null) ? _lc.vGap : VGAP;

  // ----- PLACEMENT -----
  // One dispatch for every layout: resolve to a strategy plus a complete
  // parameter set, then run it. Adding a layout is now a table entry rather
  // than another branch here.
  const _run = resolveLayout(layout, map.layoutParams);
  const _p = { ..._run.params };
  // The per-map spacing config still applies on top, so the settings dialog
  // keeps working for the built-ins.
  const _cfg = validateLayoutConfig(map.layoutConfig)[layout];
  if(_cfg){
    if(_cfg.hGap != null && _run.strategy === 'tree'){
      if(_p.axis === 'y'){ _p.gapCross = _cfg.hGap; _p.gapMain = _cfg.vGap; }
      else { _p.gapMain = _cfg.hGap; _p.gapCross = _cfg.vGap; }
    }
    for(const k of ['gap','stem','indent','alternate','start','ring','startAngle','sweep',
                    'columns','gapX','gapY','rowGap','angle','colGap','cellGap','headGap']){
      if(_cfg[k] !== undefined) _p[k] = _cfg[k];
    }
  }
  ({ tree: layoutTree, chain: layoutChain, radial: layoutRadial, grid: layoutGrid,
     matrix: layoutMatrix }[_run.strategy])
    (map.nodes, map.rootId, childrenOf, _p);
  if(!noRender){ render(); scheduleSave(); flipAnimateNodes(_beforePos); } return;
  if(!noRender){ render(); scheduleSave(); flipAnimateNodes(_beforePos); }
  } finally { _ci=_prevCI; }
}

// --- Live re-layout while editing -------------------------------------------
// Move EXISTING node elements to freshly-computed positions and redraw the
// connectors WITHOUT rebuilding the DOM, so the node being edited keeps its
// caret/selection intact.
function paintPositions(hidden){
  hidden = hidden || hiddenSet();
  document.querySelectorAll('.node').forEach(el=>{
    const n=map.nodes[el.dataset.id];
    if(n){ el.style.left=n.x+'px'; el.style.top=n.y+'px'; }
  });
  drawEdges(hidden);
  repositionNodeBar();
}
// Re-measure the node being edited, recompute the tidy layout, and paint it.
// Keeps the map neat as the node grows while typing (the way GitMind reflows).
function relayoutDuringEdit(id){
  if(!map) return;
  const el=document.querySelector(`.node[data-id="${id}"]`);
  if(!el) return;
  const n=map.nodes[id]; if(!n) return;
  const sz=view.k*_uiZ();
  const r=el.getBoundingClientRect();
  n.w=r.width/sz; n.h=r.height/sz;
  autoLayout(true);   // positions only - no DOM rebuild
  paintPositions();   // shift existing elements + redraw edges
}

/* ============================================================
   NODE OPERATIONS
   ============================================================ */
/* ---- Markdown mode: edit the map as text with a live two-way preview (v1) ---- */
let mdMode=false, _mdSyncing=false, _mdTimer=0, _mdLines=[], _mdSelSync=false, _mdActiveLine=0, mdPreview=false, mdWrap=false, _mdLH=20, _mdPT=12;
// ---- Fold-aware text model ----
// `_mdFullText` is the ALWAYS-COMPLETE markdown (source of truth for parsing back into
// the map). `ed.value` only ever holds the *visible* subset of its lines - whatever's
// left after removing any folded ranges - and `_mdView` is the mapping between the two.
// Folds are stored as a Set of _mdFullText line indices (the anchor/parent line of each
// folded range); indices are kept in sync across edits in mdCommitVisibleEdit().
let _mdFullText='', _mdFolds=new Set(), _mdView=null, _mdPrevVisible='';
function ensureMdPane(){
  const existing = document.getElementById('mdPane');
  if(existing){
    document.body.classList.add('md-ready');
    // Re-insert at correct grid position for current layout (modern vs classic/rail)
    const app=document.querySelector('.app'), stage=document.querySelector('.stage');
    if(app && stage && existing.parentElement===app && existing.nextElementSibling!==stage) app.insertBefore(existing, stage);
    return;
  }
  const app=document.querySelector('.app'), stage=document.querySelector('.stage'); if(!app||!stage) return;
  const pane=document.createElement('div'); pane.id='mdPane';
  pane.innerHTML='<div class="md-head"><span class="md-ttl">Markdown</span><span class="md-pos"></span><button class="md-pdf-btn" title="Download the rendered preview as a PDF">Download PDF</button><button class="md-wrap-btn" title="Toggle word wrap">Wrap</button><button class="md-prev-btn" title="Toggle rendered preview">Preview</button><button class="md-close" title="Exit Markdown mode (Esc)">\u2715</button></div>'
    +'<div class="md-toolbar"><button data-fmt="bold" title="Bold"><b>B</b></button><button data-fmt="italic" title="Italic"><i>I</i></button><button data-fmt="strike" title="Strikethrough"><s>S</s></button><button data-fmt="code" title="Inline code">&lt;/&gt;</button><span class="md-sep"></span><button data-fmt="h1" title="Heading 1">H1</button><button data-fmt="h2" title="Heading 2">H2</button><button data-fmt="h3" title="Heading 3">H3</button><span class="md-sep"></span><button data-fmt="quote" title="Blockquote">\u275D</button><button data-fmt="ul" title="Bullet list">\u2022</button><button data-fmt="ol" title="Numbered list">1.</button><button data-fmt="hr" title="Divider">-</button><span class="md-sep"></span><button data-fmt="link" title="Link">\uD83D\uDD17</button><button data-fmt="image" title="Image">\uD83D\uDDBC</button><button data-fmt="codeblock" title="Code block">\u2317</button><button data-fmt="table" title="Table">\u25A6</button></div><div class="md-body"><div class="md-gutter" aria-hidden="true"><div class="md-gutter-inner"></div></div><div class="md-code"><pre class="md-hl" aria-hidden="true"><div class="md-hl-inner"></div></pre>'
    +'<textarea id="mdEditor" spellcheck="false" wrap="off" placeholder="# Central idea&#10;- a branch&#10;  - a leaf"></textarea><div class="md-prev" aria-hidden="true"></div></div></div>'
    +'<div class="md-resize" title="Drag to resize"></div>';
  app.insertBefore(pane, stage);
  document.body.classList.add('md-ready');
  window.addEventListener('resize', ()=>{ if(mdMode){ mdCalibrate(); mdSyncGutterRowHeights(); } });
  pane.querySelector('.md-close').addEventListener('click',()=>toggleMdMode(false));
  pane.querySelector('.md-prev-btn').addEventListener('click', mdTogglePreview);
  pane.querySelector('.md-wrap-btn').addEventListener('click', mdToggleWrap);
  pane.querySelector('.md-pdf-btn').addEventListener('click', mdDownloadPdf);
  pane.querySelector('.md-toolbar').addEventListener('mousedown', e=>{ const b=e.target.closest('button[data-fmt]'); if(b){ e.preventDefault(); mdFormat(b.dataset.fmt); } });
  const ed=pane.querySelector('#mdEditor');
  ed.addEventListener('input', mdAfterEdit);
  ed.addEventListener('scroll', mdSyncScroll);
  ed.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ e.preventDefault(); toggleMdMode(false); return; }
    if((e.ctrlKey||e.metaKey) && !e.altKey){ const k=(e.key||'').toLowerCase();
      if(k==='z' && !e.shiftKey){ e.preventDefault(); undo(); return; }
      if(k==='y' || (k==='z' && e.shiftKey)){ e.preventDefault(); redo(); return; }
      if(k==='b'){ e.preventDefault(); mdFormat('bold'); return; }
      if(k==='i'){ e.preventDefault(); mdFormat('italic'); return; } }
    if(e.key==='Tab'){ e.preventDefault(); const a=ed.selectionStart,b=ed.selectionEnd; ed.value=ed.value.slice(0,a)+'  '+ed.value.slice(b); ed.selectionStart=ed.selectionEnd=a+2; mdAfterEdit(); }
    if(e.key==='Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey){
      if(mdHandleEnter(ed)){ e.preventDefault(); mdAfterEdit(); }
    }
  });
  const syncNodeFromCaret=()=>{ if(_mdSelSync) return; const vline=ed.value.slice(0,ed.selectionStart).split('\n').length-1; const line=_mdView?_mdView.visLineToFull[vline]:vline; let id=null; for(let l=line;l>=0;l--){ if(_mdLines[l]){ id=_mdLines[l]; break; } } if(id && map.nodes[id]){ _mdSelSync=true; select(id); _mdSelSync=false; } };
  // Full decoration refresh (not just mdUpdateActive) on click: guarantees the gutter and
  // overlay rows are freshly rebuilt from the textarea's *current* value before we mark the
  // active one, and re-syncs scroll - so a click can never land against a stale row or a
  // scroll position the browser has since adjusted (e.g. when the click also brings a
  // previously-partial row fully into view).
  ed.addEventListener('click', ()=>{ mdRefreshDecorations(); syncNodeFromCaret(); requestAnimationFrame(()=>mdRefreshDecorations()); });
  document.addEventListener('selectionchange', ()=>{ if(mdMode && document.activeElement===document.getElementById('mdEditor')) mdUpdateActive(); });
  ed.addEventListener('keyup', e=>{ mdUpdateActive(); if(e.key && e.key.indexOf('Arrow')===0) syncNodeFromCaret(); });
  // Fold toggles live in the gutter (one per foldable line) - the only place that can
  // receive clicks, since the overlay sits *underneath* the invisible-but-interactive
  // textarea and would never see a pointer event even with pointer-events:auto on a child.
  pane.querySelector('.md-gutter').addEventListener('mousedown', e=>{
    const b=e.target.closest('.gl-fold[data-full]'); if(!b) return;
    e.preventDefault(); mdToggleFold(+b.dataset.full);
  });
  const rz=pane.querySelector('.md-resize');
  rz.addEventListener('mousedown',e=>{ document.body.classList.add('md-resizing');
    e.preventDefault(); const x0=e.clientX, w0=pane.getBoundingClientRect().width, z=_uiZ();
    // w0 and (ev.clientX-x0) are both raw/visual px (getBoundingClientRect() and mouse
    // coordinates agree with each other, but scale with the UI-level display size) - the
    // CSS var they feed is read as logical px, so the whole sum needs the same /z
    // correction _stageSize()/_stagePoint() already apply, or the pane resizes at the
    // wrong rate relative to the mouse at any non-100% Display Size.
    // Dock and Minimal have the pane on the right side (stage left, pane right) with the
    // handle on the left edge, so dragging left should grow the pane - invert delta.
    // Generic check: if pane is to the right of stage, invert.
    const isRight = pane.getBoundingClientRect().left > (document.querySelector('.stage')?.getBoundingClientRect().left ?? 0);
    const mv=ev=>{ const delta = isRight ? (x0 - ev.clientX) : (ev.clientX - x0); const w=Math.max(240, Math.min(window.innerWidth*0.72, (w0+delta)/z)); app.style.setProperty('--md-w', w+'px'); };
    const up=()=>{ window.removeEventListener('mousemove',mv); window.removeEventListener('mouseup',up); document.body.classList.remove('md-resizing'); try{ animateViewTo(computeFitView(), 220); }catch(_){} mdSyncGutterRowHeights(); };
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up);
  });
}
function syncTextFromMap(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const oldLines=_mdLines, oldFolds=_mdFolds;   // remember before rebuilding, to carry fold state across the resync
  const newLines=[];
  _mdSyncing=true;
  try{ _mdFullText=buildMarkdown(undefined,{rich:true,meta:true,lineMap:newLines}); }catch(e){ _mdFullText=''; }
  _mdSyncing=false;
  _mdLines=newLines;
  // Carry folds over by node identity - a section folded before a canvas-side style
  // change (or any other resync) stays folded at that node's new line, instead of
  // silently popping back open on every edit.
  if(oldFolds.size){
    const nodeIdToNewLine=new Map();
    for(let i=0;i<newLines.length;i++){ if(newLines[i]!=null) nodeIdToNewLine.set(newLines[i], i); }
    const nextFolds=new Set();
    for(const oldLine of oldFolds){
      const id=oldLines[oldLine];
      if(id==null){
        // Not a node line - the mindspark meta comment (anchor line 0) is the one
        // expected case: it's always the very first line whenever present, so its own
        // fold carries straight across without a node-identity lookup.
        if(oldLine===0 && /^\uFEFF?\s*<!--\s*mindspark\b/i.test((_mdFullText.split('\n')[0])||'')) nextFolds.add(0);
        continue;
      }
      const newLine=nodeIdToNewLine.get(id);
      if(newLine!=null) nextFolds.add(newLine);
    }
    _mdFolds=nextFolds;
  } else {
    _mdFolds=new Set();
  }
  const view=mdBuildView(); _mdView=view;
  const vis=mdVisibleText(view);
  ed.value=vis; _mdPrevVisible=vis;
  mdRefreshDecorations();
  mdRenderPreviewIfActive();
}
function mdHighlightNode(id){   // node -> select + scroll its line in the editor
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  let line=-1; for(const k in _mdLines){ if(_mdLines[k]===id){ line=+k; break; } }
  if(line<0) return;
  if(mdUnfoldAncestorsOf(line)) mdRefreshDecorations();   // reveal the line if it was hidden in a fold
  const vline=(_mdView&&_mdView.fullToVis[line]!=null) ? _mdView.fullToVis[line] : line;
  const arr=ed.value.split('\n'); let start=0; for(let i=0;i<vline;i++) start+=(arr[i]||'').length+1;
  try{ ed.setSelectionRange(start, start); }catch(e){}   // caret at line start (no whole-line selection)
  ed.scrollLeft=0;                                       // don't jump horizontally on open
  ed.scrollTop=Math.max(0, vline*_mdLH - ed.clientHeight/2);
  mdUpdateActive(); mdSyncScroll();
  // A browser can apply its own "scroll the caret into view" adjustment asynchronously -
  // a tick after the selection change above - which would silently reintroduce horizontal
  // scroll. Re-assert once more on the next frame to catch that.
  requestAnimationFrame(()=>{ ed.scrollLeft=0; mdSyncScroll(); });
}
// ---- VS Code-style decorations: syntax highlight + line numbers + active line ----
function _hlLine(raw){
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let s=esc(raw);
  if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return '<span class="hl-hr">'+s+'</span>';                      // horizontal rule
  if(/^#{1,6}(\s|$)/.test(raw)) return s.replace(/^(#{1,6})([\s\S]*)$/, '<span class="hl-hmark">$1</span><span class="hl-head">$2</span>');
  if(/^\s*&gt;/.test(s)) return '<span class="hl-quote">'+s+'</span>';
  if(/^\s*\|.*\|/.test(s)) s=s.replace(/\|/g,'<span class="hl-punc">|</span>');
  s=s.replace(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s)?/, (m,a,b,c,t)=> a+'<span class="hl-bullet">'+b+'</span>'+c+(t?'<span class="hl-task">'+t.trim()+'</span> ':''));
  s=s.replace(/!\[[^\]]*\]\([^)]+\)/g, m=>'<span class="hl-img">'+m+'</span>');
  s=s.replace(/(^|[^!])(\[[^\]]+\]\([^)]+\))/g, (m,p,l)=>p+'<span class="hl-link">'+l+'</span>');
  s=s.replace(/`[^`]+`/g, m=>'<span class="hl-code-inline">'+m+'</span>');
  s=s.replace(/\*\*[^*]+\*\*/g, m=>'<span class="hl-strong">'+m+'</span>');
  s=s.replace(/~~[^~]+~~/g, m=>'<span class="hl-strike">'+m+'</span>');
  s=s.replace(/(^|[^*<])(\*[^*<]+\*)/g, (m,p,e)=>p+'<span class="hl-em">'+e+'</span>');
  s=s.replace(/(^|[\s(>])(__[^_]+__)(?=[\s).,;:!?<]|$)/g, (m,p,e)=>p+'<span class="hl-strong">'+e+'</span>');   // __bold__
  s=s.replace(/(^|[\s(>])(_[^_]+_)(?=[\s).,;:!?<]|$)/g, (m,p,e)=>p+'<span class="hl-em">'+e+'</span>');            // _italic_ (not snake_case)
  s=s.replace(/&lt;\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^&]*?)?\/?&gt;/g, m=>'<span class="hl-tag">'+m+'</span>');    // raw HTML tags
  s=s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m,p,u)=>p+'<span class="hl-url">'+u+'</span>');              // bare URLs
  return s;
}
function renderMdList(items, itemFn){
  const root={children:[],depth:-1}; const stack=[root];
  items.forEach(raw=>{ const ind=(raw.match(/^\s*/)||[''])[0].replace(/\t/g,'  ').length; const depth=Math.floor(ind/2); const ordered=/^\s*\d+\./.test(raw);
    const node={text:itemFn(raw),children:[],depth,ordered};
    while(stack.length>1 && stack[stack.length-1].depth>=depth) stack.pop();
    stack[stack.length-1].children.push(node); stack.push(node); });
  const emit=n=>{ if(!n.children.length) return ''; const tag=n.children[0].ordered?'ol':'ul';
    return '<'+tag+'>'+n.children.map(c=>'<li>'+c.text+emit(c)+'</li>').join('')+'</'+tag+'>'; };
  return emit(root);
}
// Display-only variant of mdInlineToHtml that also renders $...$ / $$...$$ LaTeX to MathML
// (via the existing dependency-free latexToMathML(), same one the canvas nodes use). Used by
// mdToHtml() for the Markdown preview and PDF export - NOT by the parser: node text must keep
// math as literal $...$ source (see htmlToInlineMd's comment) so it stays editable/round-trips.
function mdInlineToHtmlWithMath(txt){
  if(!txt || txt.indexOf('$')<0) return mdInlineToHtml(txt);
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const slots=[];
  const masked = txt.replace(re, (full,dd,inl)=>{
    const tex = dd!=null ? dd : inl, display = dd!=null;
    let mathml=null; try{ mathml=latexToMathML(tex, display); }catch(e){ mathml=null; }
    slots.push(mathml!=null ? mathml : escapeHtml(full));   // fall back to the raw text if it doesn't parse as LaTeX
    return '\uE000'+(slots.length-1)+'\uE001';               // PUA placeholder survives markdown/HTML processing untouched
  });
  return mdInlineToHtml(masked).replace(/\uE000(\d+)\uE001/g, (m,idx)=> slots[+idx]!=null ? slots[+idx] : '');
}
function mdToHtml(md){
  let frontHtml='';
  // Strip a leading mindspark comment and/or YAML frontmatter block, in whichever order
  // they appear (loop, not two independent one-shot checks - same reasoning as
  // parseMarkdownOutline: an anchored check silently stops matching if the other block
  // ends up first, leaking raw "<!-- mindspark" / "---" text into the rendered preview).
  for(let guard=0; guard<4; guard++){
    const mm = md.match(/^\uFEFF?\s*<!--\s*mindspark[\s\S]*?-->\s*\n?/i);
    if(mm){ md=md.slice(mm[0].length); continue; }
    const fm = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if(fm){ frontHtml = frontmatterFieldsToHtml(parseFrontmatterFields(fm[0])); md=md.slice(fm[0].length); continue; }
    break;
  }
  const L=md.split('\n'); const out=frontHtml?[frontHtml]:[]; let i=0;
  const esc=x=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const item=x=>mdInlineToHtmlWithMath(x.replace(/^\s*([-*+]|\d+\.)\s+/,'').replace(/^\[[ ]\]\s/,'\u2610 ').replace(/^\[[xX]\]\s/,'\u2611 '));
  const cells=r=>r.replace(/^\s*\|?/,'').replace(/\|?\s*$/,'').split('|').map(c=>c.trim());
  const tbl=rows=>'<table><thead><tr>'+cells(rows[0]).map(h=>'<th>'+mdInlineToHtmlWithMath(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(2).map(r=>'<tr>'+cells(r).map(c=>'<td>'+mdInlineToHtmlWithMath(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  while(i<L.length){
    let line=L[i];
    if(!line.trim()){ i++; continue; }
    let fm=line.match(/^\s*(```+|~~~+)(.*)$/);
    if(fm){ const buf=[]; let j=i+1; while(j<L.length && !/^\s*(```+|~~~+)\s*$/.test(L[j])){ buf.push(L[j]); j++; } out.push('<pre class="mp-code"><code>'+esc(buf.join('\n'))+'</code></pre>'); i=j+1; continue; }
    let h=line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ out.push('<h'+h[1].length+'>'+mdInlineToHtmlWithMath(h[2])+'</h'+h[1].length+'>'); i++; continue; }
    if(/^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)){ out.push('<hr>'); i++; continue; }
    if(/^\s*>/.test(line)){ const buf=[]; while(i<L.length && /^\s*>/.test(L[i])){ buf.push(L[i].replace(/^\s*>\s?/,'')); i++; } out.push('<blockquote>'+mdInlineToHtmlWithMath(buf.join('<br>'))+'</blockquote>'); continue; }
    if(line.includes('|') && i+1<L.length && /-/.test(L[i+1]) && /^[\s|:\-]+$/.test(L[i+1])){ const rows=[]; while(i<L.length && L[i].includes('|') && L[i].trim()){ rows.push(L[i]); i++; } out.push(tbl(rows)); continue; }
    if(/^\s*<(table|div|details|figure|section|img|hr|blockquote|p|h[1-6]|ul|ol)\b/i.test(line)){ const tm=line.match(/^\s*<([a-z0-9]+)/i), tag=tm?tm[1].toLowerCase():''; const buf=[line];
      const VOID=/^(img|hr|br|input|source|col|area|embed|track|wbr|link|meta)$/;
      if(tag && !VOID.test(tag) && !new RegExp('</'+tag+'>','i').test(line) && !/\/>\s*$/.test(line)){ let j=i+1, found=false; while(j<L.length){ buf.push(L[j]); if(new RegExp('</'+tag+'>','i').test(L[j])){ found=true; j++; break; } j++; } if(found){ i=j; } else { buf.length=1; i++; } } else i++;
      out.push(buf.join('\n').replace(/<\/?(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi,'').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'').replace(/\b(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,'$1="#"')); continue; }
    let im=line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if(im){ out.push('<img alt="'+esc(im[1])+'" src="'+esc(im[2])+'">'); i++; continue; }
    if(/^\s*([-*+]|\d+\.)\s+/.test(line)){ const items=[]; while(i<L.length && (/^\s*([-*+]|\d+\.)\s+/.test(L[i]) || (L[i].trim() && /^\s{2,}\S/.test(L[i])))){ items.push(L[i]); i++; } out.push(renderMdList(items,item)); continue; }
    const buf=[line]; i++; while(i<L.length && L[i].trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\||<)/.test(L[i])){ buf.push(L[i]); i++; }
    out.push('<p>'+mdInlineToHtmlWithMath(buf.join(' '))+'</p>');
  }
  // final safety: strip event handlers / javascript: URLs
  return out.join('\n').replace(/\son\w+="[^"]*"/gi,'').replace(/javascript:/gi,'');
}
function mdWrapSel(before, after){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart,e=ed.selectionEnd,sel=ed.value.slice(s,e);
  ed.value=ed.value.slice(0,s)+before+sel+after+ed.value.slice(e);
  if(s===e){ ed.selectionStart=ed.selectionEnd=s+before.length; } else { ed.selectionStart=s+before.length; ed.selectionEnd=e+before.length; }
  ed.focus(); mdAfterEdit(); }
function mdLinePrefix(pfx){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart,e=ed.selectionEnd; const ls=ed.value.lastIndexOf('\n',s-1)+1;
  const block=ed.value.slice(ls,Math.max(e,ls)); const out=block.split('\n').map(l=>pfx+l).join('\n');
  ed.value=ed.value.slice(0,ls)+out+ed.value.slice(Math.max(e,ls)); ed.selectionStart=ls; ed.selectionEnd=ls+out.length; ed.focus(); mdAfterEdit(); }
function mdLineToggle(pfx){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart; const ls=ed.value.lastIndexOf('\n',s-1)+1; let le=ed.value.indexOf('\n',ls); if(le<0) le=ed.value.length;
  let line=ed.value.slice(ls,le).replace(/^#{1,6}\s+/,''); const nl=pfx+line; ed.value=ed.value.slice(0,ls)+nl+ed.value.slice(le); ed.selectionStart=ed.selectionEnd=ls+nl.length; ed.focus(); mdAfterEdit(); }
function mdInsertText(text, caret){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart; ed.value=ed.value.slice(0,s)+text+ed.value.slice(ed.selectionEnd); const pos=s+(caret!=null?caret:text.length); ed.selectionStart=ed.selectionEnd=pos; ed.focus(); mdAfterEdit(); }
function mdFormat(a){ const ed=document.getElementById('mdEditor'); if(!ed||ed.readOnly) return;
  switch(a){
    case 'bold': mdWrapSel('**','**'); break;
    case 'italic': mdWrapSel('*','*'); break;
    case 'strike': mdWrapSel('~~','~~'); break;
    case 'code': mdWrapSel('`','`'); break;
    case 'h1': mdLineToggle('# '); break;
    case 'h2': mdLineToggle('## '); break;
    case 'h3': mdLineToggle('### '); break;
    case 'quote': mdLinePrefix('> '); break;
    case 'ul': mdLinePrefix('- '); break;
    case 'ol': mdLinePrefix('1. '); break;
    case 'hr': mdInsertText('\n\n---\n\n'); break;
    case 'link': mdWrapSel('[','](url)'); break;
    case 'image': mdInsertText('![alt](url)', 2); break;
    case 'codeblock': mdInsertText('\n```\n\n```\n', 5); break;
    case 'table': mdInsertText('\n| Column A | Column B |\n| --- | --- |\n| Cell 1 | Cell 2 |\n'); break;
  }
}
// Smart Enter: continue lists/quotes onto the next line the way markmap-repl's CodeMirror
// editor does, and auto-close a fenced code block right after its opening fence. Returns
// true if it handled the keypress (caller must preventDefault + commit); false lets the
// browser's default Enter behaviour run (plain paragraph text, or a selection replace).
function mdHandleEnter(ed){
  if(ed.readOnly) return false;
  if(ed.selectionStart!==ed.selectionEnd) return false;   // let default Enter replace a real selection
  const val=ed.value, pos=ed.selectionStart;
  const lineStart=val.lastIndexOf('\n', pos-1)+1;
  let lineEnd=val.indexOf('\n', pos); if(lineEnd<0) lineEnd=val.length;
  const line=val.slice(lineStart, pos);           // current line's text up to the caret
  const fullLine=val.slice(lineStart, lineEnd);    // whole current line (fence detection needs the full line)
  const atLineEnd=pos>=lineEnd;
  const insertAt=(text,caretOffset)=>{ ed.value=val.slice(0,pos)+text+val.slice(pos); ed.selectionStart=ed.selectionEnd=pos+(caretOffset!=null?caretOffset:text.length); };
  const replaceLine=(text,caretOffset)=>{ ed.value=val.slice(0,lineStart)+text+val.slice(lineEnd); ed.selectionStart=ed.selectionEnd=lineStart+(caretOffset!=null?caretOffset:text.length); };

  // Are we currently inside a fenced code block? Count fence lines strictly above this one.
  const before=val.slice(0, lineStart);
  const fenceCount=(before.match(/^[ \t]*(`{3,}|~{3,})/gm)||[]).length;
  const inFence=fenceCount%2===1;

  if(!inFence){
    const fenceOpen=fullLine.match(/^(\s*)(`{3,}|~{3,})(\S*)\s*$/);
    if(fenceOpen && atLineEnd){
      const indent=fenceOpen[1], marker=fenceOpen[2];
      insertAt('\n'+indent+'\n'+indent+marker, 1+indent.length);
      return true;
    }
  }
  if(inFence){
    const indent=(fullLine.match(/^\s*/)||[''])[0];   // just keep code indentation, no list logic inside a fence
    insertAt('\n'+indent);
    return true;
  }

  const task=line.match(/^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)(.*)$/);
  if(task){
    const [, indent, bullet, gap, , body]=task;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }   // empty item -> exit the list
    insertAt('\n'+indent+bullet+gap+'[ ] ');
    return true;
  }
  const ul=line.match(/^(\s*)([-*+])(\s+)(.*)$/);
  if(ul){
    const [, indent, bullet, gap, body]=ul;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+indent+bullet+gap);
    return true;
  }
  const ol=line.match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
  if(ol){
    const [, indent, num, sep, gap, body]=ol;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+indent+(parseInt(num,10)+1)+sep+gap);
    return true;
  }
  const bq=line.match(/^(\s*(?:>\s?)+)(.*)$/);
  if(bq && bq[1].trim()){
    const [, prefix, body]=bq;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+prefix);
    return true;
  }
  return false;
}
function mdRenderPreviewIfActive(){
  if(!mdPreview) return;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  const prev=pane.querySelector('.md-prev'); if(prev) prev.innerHTML=mdToHtml(_mdFullText);   // full text: preview isn't affected by folds
}
function mdTogglePreview(){
  mdPreview=!mdPreview;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  pane.classList.toggle('md-preview', mdPreview);
  const btn=pane.querySelector('.md-prev-btn'); if(btn){ btn.classList.toggle('on', mdPreview); btn.textContent=mdPreview?'Edit':'Preview'; }
  if(mdPreview) mdRenderPreviewIfActive();
  else mdRefreshDecorations();   // gutter/highlight were display:none while previewing - re-sync now that they're visible again, rather than trusting whatever was last written while hidden
}
// Word wrap: the textarea and the (invisible-text-bearing) highlight overlay share one
// CSS rule for white-space (see styles.css), so switching both to pre-wrap at once keeps
// them pixel-aligned - same font/width/padding, same text, so the browser wraps both
// identically. The fold-toggle gutter stays visible too - mdRefreshDecorations() (called
// below) re-syncs each of its row heights to match the now-possibly-wrapped line it labels.
function mdToggleWrap(){
  mdWrap=!mdWrap;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  pane.classList.toggle('md-wrap', mdWrap);
  const btn=pane.querySelector('.md-wrap-btn'); if(btn) btn.classList.toggle('on', mdWrap);
  mdRefreshDecorations();
}
// "Download PDF": renders the full markdown into a dedicated print-only container and
// hands off to the browser's native print dialog (Save as PDF works everywhere without
// pulling in a PDF-generation library, keeping this a zero-dependency app). Print-specific
// CSS (see styles.css) hides the rest of the app and forces light, ink-friendly colors
// regardless of the active theme.
function mdDownloadPdf(){
  if(!map) return;
  let root=document.getElementById('mdPrintRoot');
  if(!root){ root=document.createElement('div'); root.id='mdPrintRoot'; document.body.appendChild(root); }
  // No separate title heading here - the root/center node's own text is already the
  // document's first H1 (via buildMarkdown -> mdToHtml), so adding map.title on top of
  // that would just duplicate or mismatch it. The center node itself is never touched.
  root.innerHTML=mdToHtml(_mdFullText);   // full text: PDF export isn't affected by folds
  const oldTitle=document.title;
  const suggestedName=(map.title||'mindmap').replace(/[\\/:*?"<>|]/g,'').trim()||'mindmap';
  document.title=suggestedName;   // browsers use this as the suggested "Save as PDF" filename
  document.body.classList.add('md-printing');
  let cleaned=false;
  const cleanup=()=>{
    if(cleaned) return; cleaned=true;
    document.body.classList.remove('md-printing');
    document.title=oldTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(()=>{ window.print(); setTimeout(cleanup, 1000); }, 30);   // tiny delay lets the print layout settle first
}
// ---- Folding: outline depth per line, independent of the full parser ----
// Mirrors parseMarkdownOutline()'s nesting rules (heading level; bullet indent relative
// to the nearest heading/lead-in paragraph; fenced code + GFM tables as one atomic unit)
// closely enough that a fold's boundary always matches a node's subtree, without needing
// a full parse on every keystroke. Lines that aren't a heading/bullet/block-owner (blank
// lines, blockquote/notes lines, plain paragraph continuations) get `null`: they're not
// fold anchors themselves, they just fold away together with whatever anchor precedes them.
function mdLineDepths(text){
  const L=text.split('\n');
  const depth=new Array(L.length).fill(null);
  let lastHeadingDepth=0, subDepth=null;
  const base=()=>(subDepth!=null?subDepth:lastHeadingDepth);
  const nextIsBullet=from=>{ for(let k=from+1;k<L.length;k++){ if(!L[k].trim()) continue; return /^\s*(?:[-*+]|\d+\.)\s+/.test(L[k]); } return false; };
  for(let i=0;i<L.length;i++){
    const line=L[i];
    const fence=line.match(/^(\s*)(`{3,}|~{3,})/);
    if(fence){
      const ind=fence[1], fch=fence[2][0], flen=fence[2].length;
      depth[i]=base()+1+Math.floor(ind.length/2);
      let j=i+1; while(j<L.length){ const cl=L[j].match(/^\s*(`{3,}|~{3,})\s*$/); if(cl && cl[1][0]===fch && cl[1].length>=flen) break; j++; }
      i=j; continue;
    }
    if(line.includes('|') && line.trim() && i+1<L.length && L[i+1].includes('|') && /-/.test(L[i+1]) && /^[\s|:-]+$/.test(L[i+1])){
      const ind=(line.match(/^\s*/)||[''])[0].length;
      depth[i]=base()+1+Math.floor(ind/2);
      let j=i+2; while(j<L.length && L[j].includes('|') && L[j].trim()) j++;
      i=j-1; continue;
    }
    if(!line.trim()) continue;
    const h=line.match(/^(#{1,6})\s+/);
    if(h){ lastHeadingDepth=h[1].length; subDepth=null; depth[i]=lastHeadingDepth; continue; }
    if(/^\s*>/.test(line)) continue;   // blockquote/notes line: attaches to its owner
    if(/^\s*<img\b/i.test(line)) continue;   // embedded-image line: attaches to its owner, same as a blockquote - never its own fold level (see mdFoldRange)
    const bullet=line.match(/^(\s*)(?:[-*+]|\d+\.)\s+/);
    if(bullet){ const indent=bullet[1].replace(/\t/g,'  ').length; depth[i]=base()+1+Math.floor(indent/2); continue; }
    if(nextIsBullet(i)){ depth[i]=lastHeadingDepth+1; subDepth=lastHeadingDepth+1; continue; }   // lead-in paragraph above a list
  }
  return depth;
}
function mdFoldRange(depths, anchor){   // [start,end) of lines nested under `anchor`, or null if nothing to fold
  const d=depths[anchor]; if(d==null) return null;
  for(let j=anchor+1;j<depths.length;j++){ if(depths[j]!=null && depths[j]<=d) return j>anchor+1 ? [anchor+1,j] : null; }
  return depths.length>anchor+1 ? [anchor+1, depths.length] : null;
}
// Builds the mapping between the full (authoritative) text and the visible (folded) text
// that actually lives in the textarea. Cached on _mdView after every render.
function mdBuildView(){
  const fullLines=_mdFullText.split('\n');
  const depths=mdLineDepths(_mdFullText);
  const allRanges=new Map();
  for(let i=0;i<depths.length;i++){ if(depths[i]!=null){ const r=mdFoldRange(depths,i); if(r) allRanges.set(i,r); } }
  // The mindspark meta comment, when present, is always the very first line(s) - it sits
  // outside the document's outline entirely, so its body (the JSON line + closing "-->")
  // can't be found via the depth-based sibling/ancestor search above. Detect its span
  // directly instead, so its opening line gets a fold toggle like any other line would.
  if(/^\uFEFF?\s*<!--\s*mindspark\b/i.test(fullLines[0]||'')){
    for(let j=1;j<fullLines.length;j++){
      if(/-->/.test(fullLines[j])){
        let end=j+1;
        if(fullLines[end]!=null && fullLines[end].trim()==='') end++;   // fold the blank spacer line after --> too, if present
        if(end>1) allRanges.set(0, [1, end]);
        break;
      }
    }
  }
  const hidden=new Set(), foldInfo=new Map();
  for(const a of _mdFolds){
    const r=allRanges.get(a); if(!r) continue;
    for(let k=r[0];k<r[1];k++) hidden.add(k);
    foldInfo.set(a, {start:r[0], end:r[1], count:r[1]-r[0]});
  }
  const visLineToFull=[], fullToVis=new Array(fullLines.length).fill(-1);
  for(let i=0;i<fullLines.length;i++){ if(hidden.has(i)) continue; fullToVis[i]=visLineToFull.length; visLineToFull.push(i); }
  return { fullLines, depths, allRanges, hidden, foldInfo, visLineToFull, fullToVis };
}
function mdVisibleText(view){ return view.visLineToFull.map(i=>view.fullLines[i]).join('\n'); }
function mdRenderGutter(view){
  let g='';
  for(let vi=0; vi<view.visLineToFull.length; vi++){
    const fi=view.visLineToFull[vi];
    const foldable=view.allRanges.has(fi);
    const folded=foldable && _mdFolds.has(fi);
    const btn=foldable
      ? '<span class="gl-fold" data-full="'+fi+'" title="'+(folded?'Unfold':'Fold')+'">'+(folded?'\u25B8':'\u25BE')+'</span>'
      : '<span class="gl-fold"></span>';
    g+='<div class="gl" data-l="'+vi+'">'+btn+'<span class="gl-num">'+(fi+1)+'</span></div>';
  }
  return g;
}
// Reveals every fold that hides `fullLineIdx`. Returns true if anything changed.
function mdUnfoldAncestorsOf(fullLineIdx){
  const view=_mdView||mdBuildView(); let changed=false;
  for(const [a,info] of view.foldInfo){ if(fullLineIdx>=info.start && fullLineIdx<info.end){ _mdFolds.delete(a); changed=true; } }
  return changed;
}
function mdToggleFold(fullLineIdx){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  if(_mdFolds.has(fullLineIdx)) _mdFolds.delete(fullLineIdx); else _mdFolds.add(fullLineIdx);
  const view=mdBuildView(); _mdView=view;
  const vis=mdVisibleText(view);
  ed.value=vis; _mdPrevVisible=vis;
  const vline=view.fullToVis[fullLineIdx];
  if(vline!=null && vline>=0){
    const arr=vis.split('\n'); let start=0; for(let i=0;i<vline;i++) start+=(arr[i]||'').length+1;
    try{ ed.setSelectionRange(start,start); }catch(e){}
  }
  mdRefreshDecorations();
  ed.focus();
}
function mdHighlight(text, view){
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines=text.split('\n'); let inFence=false, inComment=false; const parts=[];
  for(let i=0;i<lines.length;i++){
    const raw=lines[i]; let html;
    if(inComment){ html='<span class="hl-comment">'+esc(raw)+'</span>'; if(/--&gt;|-->/.test(raw)) inComment=false; }
    else if(/^\s*<!--/.test(raw)){ inComment=!/-->/.test(raw); html='<span class="hl-comment">'+esc(raw)+'</span>'; }
    else if(inFence){ html='<span class="hl-code">'+esc(raw)+'</span>'; if(/^\s*(```+|~~~+)\s*$/.test(raw)) inFence=false; }
    else if(/^\s*(```+|~~~+)/.test(raw)){ inFence=true; html='<span class="hl-fence">'+esc(raw)+'</span>'; }
    else html=_hlLine(raw);
    let chip='';
    if(view){
      const fi=view.visLineToFull[i];
      const info=fi!=null ? view.foldInfo.get(fi) : null;
      if(info){
        chip=' <span class="md-fold-chip">\u22EF '+info.count+' line'+(info.count===1?'':'s')+' folded</span>';
        // The lines this fold hides might contain whatever would have closed an
        // in-progress comment/fence (opened on this line, or already open before it) -
        // scan them via the full text (without rendering them) so that state resolves
        // correctly instead of leaking into the still-visible lines after the fold.
        if(inComment || inFence){
          for(let k=info.start; k<info.end && (inComment||inFence); k++){
            const hraw=view.fullLines[k];
            if(inComment){ if(/-->/.test(hraw)) inComment=false; }
            else if(/^\s*(```+|~~~+)\s*$/.test(hraw)) inFence=false;
          }
        }
      }
    }
    // Real block-level rows (not just newline-joined spans) so the active-line highlight
    // is a plain CSS class on the actual row - always pixel-perfect, in or out of view,
    // with no separate position math to keep in sync while clicking/scrolling.
    parts.push('<div class="hl-line" data-l="'+i+'">'+(html||'')+chip+'</div>');
  }
  return parts.join('');
}
function mdSyncScroll(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const hl=document.querySelector('#mdPane .md-hl-inner'), gut=document.querySelector('#mdPane .md-gutter-inner');
  // A transform on the INNER wrapper, not `scrollTop` on the outer (clipping) element itself.
  // Setting `scrollTop` gets silently clamped to that element's OWN scrollHeight - and the
  // overlay's <div>-per-line rows can end up a pixel or two taller/shorter in total than the
  // textarea's native line rendering (different rendering paths for a <textarea> vs plain
  // block content), so the clamp would kick in once scrolled far enough, making the
  // highlighted row drift from the real caret row - exactly the "only happens once there's a
  // scrollbar" symptom. A transform has no such ceiling: it always shifts by exactly what the
  // textarea reports, full stop. (Transforming .md-hl/.md-gutter directly would be wrong too -
  // that would drag their own overflow:hidden clipping box along with it; the transform has to
  // land on a plain, non-clipping inner element instead.)
  const dx=-ed.scrollLeft, dy=-ed.scrollTop;
  if(hl) hl.style.transform='translate('+dx+'px,'+dy+'px)';
  if(gut) gut.style.transform='translateY('+dy+'px)';
}
function mdUpdateActive(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const before=ed.value.slice(0, ed.selectionStart);
  const line=before.split('\n').length-1, col=before.length-(before.lastIndexOf('\n')+1);
  _mdActiveLine=line;
  document.querySelectorAll('#mdPane .md-gutter .gl.active').forEach(e=>e.classList.remove('active'));
  const g=document.querySelector('#mdPane .md-gutter .gl[data-l="'+line+'"]'); if(g) g.classList.add('active');
  document.querySelectorAll('#mdPane .md-hl .hl-line.active').forEach(e=>e.classList.remove('active'));
  const hlRow=document.querySelector('#mdPane .md-hl .hl-line[data-l="'+line+'"]'); if(hlRow) hlRow.classList.add('active');
  const pos=document.querySelector('#mdPane .md-pos'); if(pos) pos.textContent='Ln '+(line+1)+', Col '+(col+1);
  mdSyncScroll();   // re-pin the overlay/gutter's own scroll offset to the textarea's, in case
                    // whatever triggered this call (click, arrow-key nav) also scrolled it
}
function mdRefreshDecorations(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const hl=document.querySelector('#mdPane .md-hl-inner'), gut=document.querySelector('#mdPane .md-gutter-inner'); if(!hl||!gut) return;
  const view=mdBuildView(); _mdView=view;
  // ed.value is expected to already match this view - mdCommitVisibleEdit's job on every
  // edit - but mdHighlight(ed.value, view) below counts rows from ed.value.split('\n')
  // while mdRenderGutter(view) counts rows from view.visLineToFull; if the two ever drift
  // apart (an edge case in the fold-index-shift math elsewhere), the highlight pane and
  // gutter silently render a different number of rows, with no visible error beyond the
  // misalignment itself. Detect and correct that here rather than trusting the invariant
  // blindly - only touches ed.value (and the cursor) on the rare mismatch, not on every
  // refresh, so normal typing is unaffected.
  const expectedVis = mdVisibleText(view);
  if(ed.value !== expectedVis){ ed.value = expectedVis; _mdPrevVisible = expectedVis; }
  hl.innerHTML=mdHighlight(ed.value, view);
  gut.innerHTML=mdRenderGutter(view);
  mdSyncGutterRowHeights(hl, gut);
  mdCalibrate();
  mdUpdateActive(); mdSyncScroll();
  // A layout shift that settles just after this synchronous pass (a scrollbar
  // appearing now that the content is taller, the pane's own width still
  // transitioning, ...) would leave the row heights just measured baked in as
  // stale - nothing else would re-check them until an unrelated click happened to
  // trigger another full refresh. Re-measure once more next frame to catch that.
  requestAnimationFrame(()=>{ if(document.getElementById('mdEditor')) mdSyncGutterRowHeights(hl, gut); });
}
// Each .gl gutter row is normally a fixed 20px (one Markdown line = one visual row). Once
// word wrap is on, a line can span several visual rows, so its .gl row needs to grow to
// match - otherwise every row below it drifts further out of alignment with the text it
// labels. Reads every .hl-line's rendered height first and only then writes the matching
// .gl heights (rather than interleaving read/write per row), so this doesn't force a
// separate synchronous layout reflow for every single line.
function mdSyncGutterRowHeights(hl, gut){
  if(!mdWrap) return;
  hl = hl || document.querySelector('#mdPane .md-hl-inner');
  gut = gut || document.querySelector('#mdPane .md-gutter-inner');
  if(!hl || !gut) return;
  // Both are display:none while in Preview mode (and offsetParent is null for any hidden
  // element), so getBoundingClientRect() would measure everything as 0 here - writing that
  // 0px straight into each row's inline height. Nothing re-measures on the way back to edit
  // mode, so those 0px rows would stay collapsed on top of each other indefinitely. A window
  // resize firing while Preview is open (the pane's own resize listener doesn't check which
  // sub-mode is active) is exactly the kind of thing that triggers this call at the wrong time.
  if(hl.offsetParent===null || gut.offsetParent===null) return;
  const hlRows=hl.querySelectorAll('.hl-line'), glRows=gut.querySelectorAll('.gl');
  // getBoundingClientRect() returns visual pixels - already scaled by the current
  // Display Size zoom. Assigning that raw value into style.height would scale it a
  // SECOND time when the browser renders it (the .gl row lives inside the same
  // zoomed pane), silently shrinking every row height at any zoom below 100% and
  // making the gutter drift further from the text with every subsequent row.
  const z=_uiZ();
  const heights=[]; for(let i=0;i<hlRows.length;i++) heights.push(hlRows[i].getBoundingClientRect().height/z);
  for(let i=0;i<glRows.length && i<heights.length;i++) glRows[i].style.height=heights[i]+'px';
}
function mdCalibrate(){   // derive the textarea's real line-height + padding (used to centre a target line when jumping to it)
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const cs=getComputedStyle(ed);
  _mdPT=parseFloat(cs.paddingTop)||12;
  const pb=parseFloat(cs.paddingBottom)||12, n=(ed.value.match(/\n/g)||[]).length+1;
  let lh=parseFloat(cs.lineHeight);
  if(ed.scrollHeight > ed.clientHeight + 4 && n>2){ lh=(ed.scrollHeight-_mdPT-pb)/n; }   // trust the measurement only when content overflows
  if(!(lh>6 && lh<80)) lh=20;
  _mdLH=lh;
  // NOTE: deliberately NOT writing this back as hl.style.lineHeight / gut.style.lineHeight.
  // The overlay, gutter, and textarea all share one CSS-declared line-height (20px) already,
  // which keeps every row in the three layers pixel-identical by construction. Overriding it
  // here with a heuristic measurement (only once content overflows - i.e. exactly when the
  // editor is scrolled) is what caused the active-line highlight to drift below the real
  // caret row on scrolled text. _mdLH/_mdPT are still used for the scroll-into-view centring
  // math in mdHighlightNode(), which only needs an approximate value.
}
// ---- Merging a textarea edit (typing, paste, toolbar action, …) back into _mdFullText ----
function mdLineDiff(oldLines,newLines){
  let p=0; const maxP=Math.min(oldLines.length,newLines.length);
  while(p<maxP && oldLines[p]===newLines[p]) p++;
  let s=0; while(s<maxP-p && oldLines[oldLines.length-1-s]===newLines[newLines.length-1-s]) s++;
  return { p, oldEnd:oldLines.length-s, newEnd:newLines.length-s };
}
function mdCommitVisibleEdit(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const newVis=ed.value;
  if(newVis===_mdPrevVisible) return;
  const view=_mdView||mdBuildView();
  const oldLines=_mdPrevVisible.split('\n'), newLines=newVis.split('\n');
  const {p, oldEnd, newEnd}=mdLineDiff(oldLines, newLines);
  const fullOldStart = p<view.visLineToFull.length ? view.visLineToFull[p] : view.fullLines.length;
  const fullOldEnd = oldEnd>p ? view.visLineToFull[oldEnd-1]+1 : fullOldStart;
  // Safety check: does the replaced span skip over any folded (hidden) full-text lines?
  // A textarea can only ever show/edit visible lines, so if the visible-to-full mapping
  // isn't consecutive across the replaced range, some hidden content sits inside it.
  let gapCrossed=false;
  if(oldEnd>p){ const span=view.visLineToFull[oldEnd-1]-view.visLineToFull[p]; if(span!==(oldEnd-1-p)) gapCrossed=true; }
  if(gapCrossed){
    // Never silently drop hidden content: reveal it and let the user redo the edit
    // against the now fully-visible text, instead of deleting what they couldn't see.
    let changed=false;
    for(const [a,info] of view.foldInfo){ if(info.end>fullOldStart && info.start<fullOldEnd){ _mdFolds.delete(a); changed=true; } }
    const freshView=mdBuildView(); _mdView=freshView;
    const freshVis=mdVisibleText(freshView);
    ed.value=freshVis; _mdPrevVisible=freshVis;
    if(changed) toast('Expanded a folded section - try that edit again');
    return;
  }
  const newFullLines=newLines.slice(p,newEnd);
  const fullLines=view.fullLines.slice();
  fullLines.splice(fullOldStart, fullOldEnd-fullOldStart, ...newFullLines);
  _mdFullText=fullLines.join('\n');
  const delta=newFullLines.length-(fullOldEnd-fullOldStart);
  const nextFolds=new Set();
  for(const a of _mdFolds){
    if(a>=fullOldStart && a<fullOldEnd){
      // The anchor's own line was inside the replaced span. If it was a plain in-place
      // edit (that one line swapped for exactly one new line - by far the common case,
      // e.g. fixing a typo in a folded heading), keep the fold anchored there. Otherwise
      // the line's identity is gone, so the fold is dropped - which just means its
      // content becomes visible again, never that it's lost.
      if(a===fullOldStart && newFullLines.length>0) nextFolds.add(fullOldStart);
      continue;
    }
    nextFolds.add(a>=fullOldEnd ? a+delta : a);
  }
  _mdFolds=nextFolds;
  _mdPrevVisible=newVis;   // ed.value itself is left exactly as the browser already has it
}
function mdAfterEdit(){
  mdCommitVisibleEdit();
  mdRefreshDecorations();
  clearTimeout(_mdTimer);
  _mdTimer=setTimeout(applyMdToMap, 300);
}
function applyMdToMap(){
  const ed=document.getElementById('mdEditor'); if(!ed||!mdMode) return;
  if(typeof READONLY!=='undefined' && READONLY) return;
  let parsed; try{ parsed=parseMarkdownOutline(_mdFullText, map.title||'Map'); }catch(e){ return; }   // full text: folds must never delete nodes
  if(!parsed||!parsed.rootId||!parsed.nodes||!parsed.nodes[parsed.rootId]) return;   // ignore un-parseable/empty text
  _mdSyncing=true;
  sel=null; document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel')); document.getElementById('nodebar')?.remove();
  map.nodes=parsed.nodes; map.rootId=parsed.rootId;
  if(typeof balanceRootSides==='function') balanceRootSides();
  autoLayout(); pushHistory();   // undoable + persists (guarded so it won't clobber the editor)
  _mdSyncing=false;
}
function toggleMdMode(on){
  const want=(on===undefined)?!mdMode:!!on; if(want===mdMode) return;
  ensureMdPane();
  const _pane=document.getElementById('mdPane'); if(_pane) void _pane.offsetWidth;   // reflow so the first open animates from width 0
  mdMode=want; document.body.classList.toggle('md-mode', mdMode);
  const btn=document.getElementById('mdToggle'); if(btn) btn.classList.toggle('on', mdMode);
  if(mdMode){
    syncTextFromMap();
    const ed=document.getElementById('mdEditor');
    if(ed){
      ed.readOnly=!!(typeof READONLY!=='undefined' && READONLY);
      ed.focus();
      if(sel) mdHighlightNode(sel);
      else{ try{ ed.setSelectionRange(0,0); }catch(e){} ed.scrollTop=0; ed.scrollLeft=0; mdUpdateActive(); mdSyncScroll(); }
      // Belt-and-suspenders: a browser can apply its own "scroll the caret into view"
      // adjustment asynchronously (a tick after focus/selection change), which would
      // silently reintroduce horizontal scroll after the synchronous reset above. Re-assert
      // once more on the next frame to catch that - same defensive pattern as the earlier
      // click-auto-scroll fix for the active-line highlight.
      requestAnimationFrame(()=>{ ed.scrollLeft=0; mdSyncScroll(); });
    }
  }
  else if(!(typeof READONLY!=='undefined' && READONLY)) pushHistory();   // one undo entry for the md session
  setTimeout(()=>{
    try{ animateViewTo(computeFitView(), 260); }catch(e){}
    try{ if(mdMode) mdCalibrate(); }catch(e){}
    // The pane's own width transition (220ms, pure CSS) is still running when
    // syncTextFromMap() -> mdRefreshDecorations() measured gutter row heights just
    // above - at/near width:0, word-wrap makes every line "wrap" into many tiny
    // rows, baking wildly wrong heights in as permanent inline styles. Nothing else
    // re-measures once the transition actually finishes, so re-sync once more now
    // that the pane has reached its real width.
    try{ if(mdMode) mdSyncGutterRowHeights(); }catch(e){}
  }, 260);   // smoothly re-fit once the pane finished sliding, instead of snapping
}
function pushHistory(){
  const snapshot = JSON.stringify({nodes:map.nodes,rootId:map.rootId,title:map.title,color:map.color,links:map.links||[],layout:map.layout,vars:map.vars||{}});
  if(history.length && hpos>=0 && history[hpos]===snapshot) return;   // nothing actually changed - don't save/flash "Saving…" for no reason
  history=history.slice(0,hpos+1);
  history.push(snapshot);
  if(history.length>50) history.shift();
  hpos=history.length-1;
  updateUndo();
  scheduleSave();                              // any change to history persists
  if(typeof Collab!=='undefined') Collab.onLocalChange();   // broadcast edits to live collaborators
  if(mdMode && !_mdSyncing) syncTextFromMap();                // keep the Markdown editor in sync with canvas edits
}
function updateUndo(){ $('#undo').disabled=hpos<=0; $('#redo').disabled=hpos>=history.length-1; }
function restore(s){ const o=JSON.parse(s); map.nodes=o.nodes; map.rootId=o.rootId; map.title=o.title; map.color=o.color; if(o.links) map.links=o.links; if(o.layout) map.layout=o.layout; if(o.vars) map.vars=o.vars; $('#mapTitle').value=map.title; autoLayout(); if(mdMode && !_mdSyncing) syncTextFromMap(); }
function undo(){ if(hpos>0){hpos--;restore(history[hpos]);updateUndo();} }
function redo(){ if(hpos<history.length-1){hpos++;restore(history[hpos]);updateUndo();} }

function addNode(parentId,asSibling){
  if(READONLY) return;
  let parent=parentId;
  if(asSibling){ const p=map.nodes[parentId]; parent=p.parent||map.rootId; if(parentId===map.rootId) parent=map.rootId; }
  const pn=map.nodes[parent]||map.nodes[map.rootId];
  const side = parent===map.rootId ? (childrenOf(map.rootId).length%2? 'left':'right') : (pn.side||'right');
  const id=uid();
  // Pick a random soft color from the palette (skip plain white at index 0)
  const palette=NODE_COLORS.slice(1);
  const color=palette[Math.floor(Math.random()*palette.length)];
  map.nodes[id]={id,text:'New topic',parent,
    x:pn.x+(side==='left'?-180:180),y:pn.y+40,side, color, created:Date.now()};
  if(pn.collapsed) pn.collapsed=false;
  pushHistory();
  // Stable auto-layout tidies the tree (the new node is inserted in order and
  // everything stays non-overlapping). Because layout is stable, existing
  // branches keep their side/order - it tidies, it doesn't reshuffle.
  autoLayout();
  select(id,true);
}
// Position a freshly-added node relative to its existing siblings without
// moving any other node. Keeps insertion order (new node goes last) and
// preserves the user's manual arrangement of the rest of the map.
function placeNewNodeNear(id){
  const n=map.nodes[id]; if(!n) return;
  const parent=map.nodes[n.parent]; if(!parent) return;
  const layout=map.layout||'balanced';
  // Only stack against siblings on the SAME side. Root children can be split
  // left/right, and a left-side node must be placed on the left (so its edge
  // leaves the root's left edge) rather than next to a right-side sibling -
  // otherwise the connector stretches all the way across the canvas.
  const sibs=childrenOf(n.parent).filter(c=>c!==id && map.nodes[c].side===n.side);
  const nw=n.w||120, nh=n.h||40;
  if(layout==='down'){
    // Horizontal stacking: new node goes to the right of the rightmost sibling
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight, sn.x+(sn.w||120)); y=sn.y; });
      n.x=maxRight+DOWN_HGAP; n.y=y;
    } else {
      n.x=parent.x+((parent.w||120)-nw)/2; n.y=childY;
    }
  } else if(layout==='up'){
    // Mirror of down: children grow upward, siblings stack horizontally
    const childY=parent.y-nh-DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight, sn.x+(sn.w||120)); y=sn.y; });
      n.x=maxRight+DOWN_HGAP; n.y=y;
    } else {
      n.x=parent.x+((parent.w||120)-nw)/2; n.y=childY;
    }
  } else {
    // Vertical stacking: new node goes below the lowest SAME-SIDE sibling
    const dir=n.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom){maxBottom=b;} colX=sn.x; });
      n.y=maxBottom+VGAP;
      n.x=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP);
    } else {
      // First node on this side - sit it beside the parent on the matching side
      n.x=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP;
      n.y=parent.y+((parent.h||40)-nh)/2;
    }
  }
}
function deleteNode(id){
  if(id===map.rootId) return;
  const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
  const parent=map.nodes[id].parent;
  rm.forEach(r=>delete map.nodes[r]);
  pruneLinks(rm);
  sel=parent;
  autoLayout();      // re-tidy first…
  pushHistory();     // …then snapshot the clean, balanced state
}
function select(id,edit){
  // Toggle .sel class on existing elements rather than re-rendering - so the
  // DOM element identity is preserved across clicks (required for dblclick).
  document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
  sel=id;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el) el.classList.add('sel');
  }
  positionNodeBar();
  updateBreadcrumb();
  if(mdMode && !_mdSelSync && id) mdHighlightNode(id);   // node click -> highlight its Markdown line
  if(edit) setTimeout(()=>startEdit(id),0);
}

/* ============================================================
   MULTI-SELECT - shift-click to build a selection set, then
   bulk delete / recolor / re-parent.
   ============================================================ */
let multiSel = new Set();
let reparentMode = false;

function toggleMultiSelect(id){
  // First shift-click seeds the set with the current primary selection so the
  // node you already had selected is included.
  if(multiSel.size === 0 && sel && sel !== id) multiSel.add(sel);
  if(multiSel.has(id)) multiSel.delete(id);
  else multiSel.add(id);
  updateMultiSelUI();
}
function clearMultiSelect(){
  multiSel.clear();
  reparentMode = false;
  updateMultiSelUI();
}
function updateMultiSelUI(){
  document.querySelectorAll('.node.multi-sel').forEach(n=>n.classList.remove('multi-sel'));
  multiSel.forEach(id=>{
    document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel');
  });
  if(multiSel.size >= 2){
    $('#nodebar')?.remove();   // hide the single-node format toolbar
    showBulkBar();
  } else {
    hideBulkBar();
  }
}
function hideBulkBar(){ $('#bulkBar')?.remove(); }
function showBulkBar(prompt){
  hideBulkBar();
  const bar = document.createElement('div');
  bar.id = 'bulkBar'; bar.className = 'bulk-bar';
  if(prompt){
    bar.innerHTML = `<span class="bulk-count">${prompt}</span>
      <button class="bulk-cancel" data-a="cancel">Cancel</button>`;
  } else {
    bar.innerHTML = `
      <span class="bulk-count">${multiSel.size} selected</span>
      <div class="bulk-sep"></div>
      <button data-a="bold" title="Bold all"><b>B</b></button>
      <button data-a="italic" title="Italic all"><i>I</i></button>
      <button data-a="underline" title="Underline all"><u>U</u></button>
      <button data-a="strike" title="Strikethrough all"><s>S</s></button>
      <div class="bulk-sep"></div>
      <button data-a="size" title="Font size">A<span style="font-size:9px">▾</span></button>
      <button data-a="align" title="Text alignment">⇆</button>
      <button data-a="textcolor" title="Text color"><span style="border-bottom:2px solid var(--accent)">A</span></button>
      <button data-a="highlight" title="Highlight">▦</button>
      <button data-a="color" title="Node background">🎨</button>
      <div class="bulk-sep"></div>
      <button data-a="reparent" title="Move all under a new parent">⤷</button>
      <button data-a="delete" class="bulk-danger" title="Delete all">🗑</button>
      <button class="bulk-cancel" data-a="cancel" title="Clear selection">✕</button>`;
  }
  document.body.appendChild(bar);
  bar.addEventListener('mousedown', e=>e.stopPropagation());
  bar.querySelectorAll('button').forEach(b=> b.onclick = (ev)=>{
    ev.stopPropagation();
    const a = b.dataset.a;
    if(a==='delete') bulkDelete();
    else if(a==='color') showBulkColorPicker(b, 'bg');
    else if(a==='reparent') startBulkReparent();
    else if(a==='cancel') clearMultiSelect();
    else if(a==='bold') bulkFormat('bold');
    else if(a==='italic') bulkFormat('italic');
    else if(a==='underline') bulkFormat('underline');
    else if(a==='strike') bulkFormat('strike');
    else if(a==='size') showBulkSizePicker(b);
    else if(a==='align') bulkCycleAlign();
    else if(a==='textcolor') showBulkColorPicker(b, 'text');
    else if(a==='highlight') showBulkColorPicker(b, 'highlight');
  });
}
// Toggle a boolean style across all selected nodes (on if any are off).
function bulkFormat(prop){
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  const anyOff = ids.some(id => !map.nodes[id][prop]);
  ids.forEach(id => { map.nodes[id][prop] = anyOff; });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkSetProp(prop, value){
  [...multiSel].forEach(id=>{ if(map.nodes[id]) map.nodes[id][prop] = value; });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkCycleAlign(){
  const order = ['left','center','right'];
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  // Use the first node's current alignment to decide the next in the cycle
  const cur = map.nodes[ids[0]]?.align || 'left';
  const next = order[(order.indexOf(cur)+1) % order.length];
  ids.forEach(id => { map.nodes[id].align = next; });
  pushHistory(); render(); updateMultiSelUI();
  toast('Aligned '+next);
}
function showBulkSizePicker(anchorBtn){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  const pk = document.createElement('div');
  pk.className = 'picker size';
  pk.innerHTML = FONT_SIZES.map(s=>`<button data-s="${s}">${s}px</button>`).join('');
  document.body.appendChild(pk);
  positionPopup(pk, anchorBtn);
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{ bulkSetProp('fontSize', +b.dataset.s); pk.remove(); });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function showBulkColorPicker(anchorBtn, kind){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  let colors, prop, allowNone=false;
  if(kind==='text'){ colors = TEXT_COLORS; prop='textColor'; }
  else if(kind==='highlight'){ colors = HILITES; prop='highlight'; allowNone=true; }
  else { colors = ['#fff','#ffd9c2','#ffe9a8','#d6f0c8','#c5e8e4','#cfe0f5','#e6d4f2','#f5d0dd','#e0e0e0']; prop='color'; }
  const pk = document.createElement('div');
  pk.className = 'picker';
  pk.innerHTML =
    (allowNone ? `<button class="p-sw" style="background:transparent;position:relative" data-c="" title="None">∅</button>` : '') +
    colors.map(c=>`<button class="p-sw" style="background:${c}" data-c="${c}"></button>`).join('');
  document.body.appendChild(pk);
  positionPopup(pk, anchorBtn);
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{
    const v = b.dataset.c;
    bulkSetProp(prop, v || null);
    pk.remove();
  });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function bulkColor(color){
  multiSel.forEach(id=>{ if(map.nodes[id] && id!==map.rootId) map.nodes[id].color = color; });
  pushHistory(); render(); updateMultiSelUI();
  toast(`Recolored ${multiSel.size} nodes`);
}
function bulkDelete(){
  const targets = [...multiSel].filter(id => id !== map.rootId);
  if(!targets.length){ toast('Can’t delete the root'); return; }
  const removed = new Set();
  targets.forEach(id=>{
    if(!map.nodes[id]) return;
    const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
    rm.forEach(r=>{ delete map.nodes[r]; removed.add(r); });
  });
  if(sel && removed.has(sel)) sel = map.rootId;
  pruneLinks(removed);
  clearMultiSelect();
  pushHistory(); autoLayout();
  toast(`Deleted ${removed.size} node${removed.size===1?'':'s'}`);
}
function startBulkReparent(){
  reparentMode = true;
  showBulkBar('Click a target node to move ' + multiSel.size + ' nodes under it…');
}
function bulkReparent(targetId){
  let count = 0;
  multiSel.forEach(id=>{
    if(id===map.rootId) return;                 // can't reparent root
    if(id===targetId) return;                    // skip self
    if(isDescendant(targetId, id)) return;       // would create a cycle
    const child = map.nodes[id]; if(!child) return;
    child.parent = targetId;
    // Inherit side from the new parent
    let side;
    if(targetId===map.rootId){ side = (count%2) ? 'left' : 'right'; }
    else side = map.nodes[targetId].side || 'right';
    const propagate=(nid,s)=>{ map.nodes[nid].side=s; childrenOf(nid).forEach(c=>propagate(c,s)); };
    propagate(id, side);
    count++;
  });
  reparentMode = false;
  clearMultiSelect();
  pushHistory(); autoLayout();
  toast(count ? `Moved ${count} node${count===1?'':'s'}` : 'Nothing moved');
}

/* ============================================================
   CROSS-LINKS - non-tree edges between any two nodes.
   Press L on a selected node, then click another to link them.
   ============================================================ */
let linkMode = false, linkSource = null;
function startLinkMode(sourceId){
  if(!sourceId){ return; }
  linkMode = true; linkSource = sourceId;
  document.querySelector(`.node[data-id="${sourceId}"]`)?.classList.add('link-source');
  toast('Link mode - click another node (Esc to cancel)');
}
function cancelLinkMode(){
  linkMode = false; linkSource = null;
  document.querySelectorAll('.node.link-source').forEach(n=>n.classList.remove('link-source'));
}
function completeLink(targetId){
  const from = linkSource;
  cancelLinkMode();
  if(!from || !targetId || from===targetId) return;
  if(!map.links) map.links = [];
  // Toggle: if this exact link already exists (either direction), remove it
  const existsIdx = map.links.findIndex(l =>
    (l.from===from && l.to===targetId) || (l.from===targetId && l.to===from));
  if(existsIdx >= 0){
    map.links.splice(existsIdx, 1);
    toast('Cross-link removed');
  } else {
    map.links.push({ from, to: targetId });
    toast('Cross-link added');
  }
  pushHistory(); render(); scheduleSave();
}
// Remove any cross-links that reference a node (called when a node is deleted)
function pruneLinks(removedIds){
  if(!map.links || !map.links.length) return;
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds);
  map.links = map.links.filter(l => !gone.has(l.from) && !gone.has(l.to));
}

/* ============================================================
   TASK STATE - todo → doing → done, with parent roll-up
   ============================================================ */
// Marker palette popup. Anchored to whatever was clicked (nodebar button or
// the badge itself) so it appears next to the thing the user acted on.
function showMarkerPicker(anchor, id){
  const n=map.nodes[id]; if(!n) return;
  if(READONLY) return;
  const cur=n.marker||'';
  const p=document.createElement('div');
  p.className='picker marker-picker'; p._anchor=anchor;
  p.innerHTML = MARKERS.map(m=>
      `<button data-v="${m.c}" title="${escapeHtml(m.label)}" class="${m.c===cur?'on':''}">${m.c}</button>`
    ).join('') +
    `<button data-v="" title="Remove marker" class="mk-none">\u2716</button>` +
    `<button type="button" class="mk-custom" title="Paste any emoji - copy it from Emojipedia or anywhere else">\uFF0B Custom emoji</button>`;
  document.body.appendChild(p);
  positionPopup(p, anchor, {align:'left'});
  p.addEventListener('mousedown',ev=>ev.stopPropagation());
  p.querySelectorAll('button[data-v]').forEach(b=> b.onclick=ev=>{
    ev.stopPropagation();
    setMarker(id, b.dataset.v);
    p.remove();
  });
  // Custom emoji: swap the grid for a paste row. Any single emoji grapheme is
  // accepted (ZWJ families, flags, skin tones - the Segmenter counts them as
  // one), so users can copy anything from Emojipedia without us curating it.
  p.querySelector('.mk-custom').onclick=ev=>{
    ev.stopPropagation();
    p.innerHTML = `<div class="mk-custom-row">
        <input type="text" maxlength="16" placeholder="Paste an emoji\u2026" spellcheck="false">
        <button type="button" class="mk-apply" disabled>Apply</button>
      </div>`;
    const input=p.querySelector('input'), apply=p.querySelector('.mk-apply');
    const valid=()=>{
      const v=input.value.trim();
      if(!v) return false;
      let parts;
      try{ parts=[...new Intl.Segmenter().segment(v)]; }catch(e){ parts=null; }
      if(!parts || parts.length!==1) return false;
      return /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{FE0F}]/u.test(v);
    };
    const refresh=()=>{ apply.disabled=!valid(); };
    input.addEventListener('input',refresh);
    input.addEventListener('keydown',ev=>{
      ev.stopPropagation();
      if(ev.key==='Enter' && valid()){ setMarker(id, input.value.trim()); p.remove(); }
    });
    apply.onclick=ev=>{
      ev.stopPropagation();
      if(valid()){ setMarker(id, input.value.trim()); p.remove(); }
    };
    input.focus();
  };
  // Close on the next outside click, matching how the other popups behave.
  setTimeout(()=>{
    const off=ev=>{ if(!p.contains(ev.target)){ p.remove(); document.removeEventListener('mousedown',off); } };
    document.addEventListener('mousedown',off);
  },0);
}
function setMarker(id, ch){
  const n=map.nodes[id]; if(!n) return;
  if(ch) n.marker=ch; else delete n.marker;
  // autoLayout, not just render: the badge changes the node's width, and
  // neighbours were positioned for the old size.
  pushHistory(); render(); autoLayout();
}
function cycleTask(id){
  const n=map.nodes[id]; if(!n) return;
  const order=[null,'todo','doing','done'];
  const cur=order.indexOf(n.task||null);
  const next=order[(cur+1)%order.length];
  if(next) n.task=next; else delete n.task;
  pushHistory(); render();
}
// Count done / total task-bearing nodes within a subtree (excluding the node itself)
function taskProgress(id){
  let done=0,total=0;
  const walk=i=>childrenOf(i).forEach(c=>{
    const t=map.nodes[c].task;
    if(t){ total++; if(t==='done') done++; }
    walk(c);
  });
  walk(id);
  return {done,total};
}

/* ============================================================
   CITATION / REFERENCE NODES
   ============================================================ */
function formatCitation(c){
  if(!c) return '';
  if(typeof c==='string') return c;
  const parts=[];
  if(c.authors) parts.push(c.authors);
  if(c.year) parts.push('('+c.year+')');
  let s=parts.join(' ');
  // Appends a segment with the right separator - avoids a double period when the
  // preceding segment already ends in sentence punctuation (very common for
  // authors with abbreviated initials, e.g. "Smith, J.").
  const append = seg => { if(!s){ s=seg; return; } s += (/[.!?]$/.test(s) ? ' ' : '. ') + seg; };
  if(c.title) append(c.title);
  if(c.source) append(c.source);
  if(c.doi) append(/^https?:/.test(c.doi)?c.doi:'doi:'+c.doi);
  return s.trim();
}
// Layout config editor. A raw JSON textarea rather than a row of sliders: the
// point of externalising these constants was that a config can be written,
// saved and shared as text. Whatever is typed goes through
// validateLayoutConfig(), so an out-of-range or misspelled value is corrected
// rather than accepted - and the corrected result is what gets saved, which is
// the only way to discover the bounds without separate documentation.
// Import / manage layout presets. Shows the current map's layout as JSON so a
// user can copy it, tweak it, and paste it back as a new preset - which is the
// realistic way anyone produces one of these.
function showLayoutImportForm(){
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const cur = map ? (findLayout(map.layoutPreset || map.layout) || BUILTIN_LAYOUTS[0]) : BUILTIN_LAYOUTS[0];
  const sample = JSON.stringify({
    v:1, id:'my-timeline', name:'My timeline', desc:'Wider spacing',
    engine: cur.engine,
    options: validateLayoutConfig(map && map.layoutConfig),
  }, null, 2);
  const customs = loadCustomLayouts();
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Import a layout</h2>
      <div class="vf-hint">A layout picks one of the built-in engines
        (${LAYOUT_ENGINES.join(', ')}) and tunes it - it cannot define a new
        algorithm. Imported layouts are saved on this device; the maps you apply
        them to stay readable for everyone.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(sample)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      ${customs.length ? `<div class="vf-hint" style="margin-top:10px">Saved layouts</div>
        <div class="li-list">${customs.map(c=>
          `<span class="li-chip">${escapeHtml(c.name)}<button data-del="${escapeHtml(c.id)}" title="Remove">\u00d7</button></span>`
        ).join('')}</div>` : ''}
      <div class="vf-actions">
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Import</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const fail=msg=>{ err.hidden=false; err.textContent=msg; };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ return fail('Not valid JSON: '+e.message); }
    const preset = validateLayoutPreset(parsed);
    if(!preset){
      return fail('Not a usable layout. It needs an "id" (letters, digits and dashes), '
        + 'a "name", and an "engine" that is one of: ' + LAYOUT_ENGINES.join(', ') + '.');
    }
    if(BUILTIN_LAYOUTS.some(b=>b.id===preset.id)){
      return fail(`"${preset.id}" is a built-in layout name - please choose another id.`);
    }
    const list = loadCustomLayouts().filter(c=>c.id!==preset.id);   // re-importing replaces
    list.push(preset);
    if(!saveCustomLayouts(list)) return fail('Could not save - this browser\u2019s storage may be full.');
    close(); toast(`Layout \u201c${preset.name}\u201d imported`);
    try{ $('#themeBtn').click(); }catch(_){}   // reopen so the new entry is visible
  };
  m.querySelectorAll('[data-del]').forEach(b=> b.onclick=()=>{
    const id=b.dataset.del;
    saveCustomLayouts(loadCustomLayouts().filter(c=>c.id!==id));
    // A map already using it keeps working: engine and options live on the map.
    close(); toast('Layout removed');
    try{ $('#themeBtn').click(); }catch(_){}
  });
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showLayoutConfigForm(){
  if(!map || READONLY) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  // Only the active engine's knobs - showing timeline's settings while
  // 'balanced' is selected was both confusing and inapplicable.
  const engine = map.layout || 'balanced';
  const current = JSON.stringify(layoutConfigFor(engine, map.layoutConfig), null, 2);
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Layout settings - ${escapeHtml((findLayout(map.layoutPreset||engine)||{name:engine}).name)}</h2>
      <div class="vf-hint">Saved with this map and included in share links. Out-of-range
        values are clamped and unknown keys ignored, so what you get back may differ
        from what you type.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(current)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-actions">
        <button class="vf-unref">Reset to defaults</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const apply=section=>{
    // Merge, do not replace: the dialog only ever shows the ACTIVE engine's
    // section, so writing a whole fresh object would silently reset the
    // settings of every other layout the user had tuned.
    map.layoutConfig = { ...(map.layoutConfig || {}), ...section };
    // autoLayout re-places and schedules a save; scheduleSave() is called
    // directly too so the settings persist even if a future change makes that
    // path conditional.
    pushHistory(); render(); autoLayout();
    try{ scheduleSave(); }catch(e){ console.warn('saving layout settings failed:', e.message); }
    close(); toast('Layout settings saved');
  };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ err.hidden=false; err.textContent='Not valid JSON: '+e.message; return; }
    // Keep only the section for the engine being edited.
    apply(layoutConfigFor(engine, parsed));
  };
  m.querySelector('.vf-unref').onclick=()=>apply(layoutConfigFor(engine, null));
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showStyleConfigForm(){
  if(!map || READONLY) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  // Only the active style's knobs - same rule as the layout dialog.
  const style = map.style || 'modern';
  const current = JSON.stringify(styleConfigFor(style, map.styleConfig), null, 2);
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Map style settings - ${escapeHtml((MAP_STYLES.find(s=>s.id===style)||{name:style}).name)}</h2>
      <div class="vf-hint">Saved with this map and included in share links.
        edgeColor is any CSS color ("" = the theme default); cardPad is a
        uniform card padding (0 = the style's own padding); glow only affects
        Neon and dash only affects Dashed. Out-of-range values are clamped and
        unknown keys ignored, so what you get back may differ from what you
        type.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(current)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-actions">
        <button class="vf-unref">Reset to defaults</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const apply=section=>{
    // Merge, do not replace: only the ACTIVE style's section is shown, so a
    // whole fresh object would silently reset every other style the user had
    // tuned - exactly the trap the layout dialog guards against.
    map.styleConfig = { ...(map.styleConfig || {}), ...section };
    // render() re-applies the CSS vars; autoLayout() re-tidies because a
    // cardPad/radius change can resize cards and shift neighbours.
    pushHistory(); render(); autoLayout();
    try{ scheduleSave(); }catch(e){ console.warn('saving style settings failed:', e.message); }
    close(); toast('Map style settings saved');
  };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ err.hidden=false; err.textContent='Not valid JSON: '+e.message; return; }
    apply(styleConfigFor(style, parsed));
  };
  m.querySelector('.vf-unref').onclick=()=>apply(styleConfigFor(style, null));
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showLookConfigForm(){
  if(!map || READONLY) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  // Only the active look's knobs - same rule as the style and layout dialogs.
  const look = document.documentElement.getAttribute('data-look') || 'office';
  const current = JSON.stringify(lookConfigFor(look, map.lookConfig), null, 2);
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Look settings - ${escapeHtml(((LOOKS.find(l=>l.id===look)||{name:look}).name).replace(/<br\s*\/?>/gi, ' '))}</h2>
      <div class="vf-hint">Saved with this map and included in share links. font is
        any CSS font family ("" keeps the look's own default font); nodeSize
        scales the node text (1 = the look's own size); radius rounds the
        chrome - popups, pickers, minimap, modals (equal to the look's default
        keeps the look's own asymmetric corners). Out-of-range values are
        clamped and unknown keys ignored, so what you get back may differ from
        what you type.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(current)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-actions">
        <button class="vf-unref">Reset to defaults</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const apply=section=>{
    // Merge, do not replace: only the ACTIVE look's section is shown, so a
    // whole fresh object would silently reset every other look the user had
    // tuned - exactly the trap the style dialog guards against.
    map.lookConfig = { ...(map.lookConfig || {}), ...section };
    pushHistory(); render(); autoLayout();
    try{ scheduleSave(); }catch(e){ console.warn('saving look settings failed:', e.message); }
    close(); toast('Look settings saved');
  };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ err.hidden=false; err.textContent='Not valid JSON: '+e.message; return; }
    apply(lookConfigFor(look, parsed));
  };
  m.querySelector('.vf-unref').onclick=()=>apply(lookConfigFor(look, null));
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showThemeConfigForm(){
  if(!map || READONLY) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  // Only the active theme's knobs - same rule as the other dialogs.
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const current = spaceForSwatches(JSON.stringify(themeConfigFor(theme, map.themeConfig), null, 2));
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Colour theme settings - ${escapeHtml(((THEMES.find(t=>t.id===theme)||{name:theme}).name).replace(/<br\s*\/?>/gi, ' '))}</h2>
      <div class="vf-hint">Saved with this map and included in share links. Each
        key is any CSS colour: paper (canvas background), ink (text), accent
        (highlights), nodeBg (cards), line (borders), glow (the stage wash).
        Typing "" keeps the theme's own colour; everything else in the theme's
        palette is untouched. Values are capped at 40 characters and unknown
        keys ignored, so what you get back may differ from what you type.
        Click the square beside a colour to pick one; the map behind this card
        follows the drag, and nothing is kept until you hit Apply.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(current)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-actions">
        <button class="vf-unref">Reset to defaults</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  let previewed = false;
  attachColorSwatches(ta, text=>{ previewed = true; previewThemeConfig(theme, text); });
  ta.focus();
  // applyThemeConfigVars() undoes whatever the picker previewed onto :root. It
  // reads map.themeConfig, so it is right on both paths: cancel restores the
  // saved colours, apply has already written the new ones. The render is for the
  // node colours that are computed in JS rather than read from a variable.
  const close=()=>{
    closeColorPicker(); m.remove(); applyThemeConfigVars();
    if(previewed && map) render();
  };
  const apply=section=>{
    // Merge, do not replace: only the ACTIVE theme's section is shown, so a
    // whole fresh object would silently reset every other theme the user had
    // tuned - exactly the trap the style dialog guards against.
    map.themeConfig = { ...(map.themeConfig || {}), ...section };
    pushHistory(); render(); autoLayout();
    try{ scheduleSave(); }catch(e){ console.warn('saving theme settings failed:', e.message); }
    previewed = false;   // the render above already settled it, close() need not repeat it
    close(); toast('Colour theme settings saved');
  };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ err.hidden=false; err.textContent='Not valid JSON: '+e.message; return; }
    apply(themeConfigFor(theme, parsed));
  };
  m.querySelector('.vf-unref').onclick=()=>apply(themeConfigFor(theme, null));
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showCitationForm(id){
  const n=map.nodes[id]; if(!n) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const c = (n.citation && typeof n.citation==='object') ? n.citation : {};
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Reference / citation</h2>
      <p class="vf-sub">Fill the fields, or paste a full citation into "Authors". The node will show the formatted reference and be included in <b>Export → References</b>.</p>
      <div class="vf-doi-lookup">
        <input class="vf-doi-in" placeholder="Paste a DOI to autofill (e.g. 10.1109/TIM.2026.3659640)">
        <button class="vf-doi-go">Fetch</button>
      </div>
      <div class="vf-fields">
        <label class="vf-row"><span class="vf-name">Authors</span><textarea class="vf-input" data-f="authors" rows="1" placeholder="Smith, J. & Doe, A.">${escapeHtml(c.authors||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Title</span><textarea class="vf-input" data-f="title" rows="1" placeholder="A study of …">${escapeHtml(c.title||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Year</span><textarea class="vf-input" data-f="year" rows="1" placeholder="2026">${escapeHtml(c.year||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">Source / venue</span><textarea class="vf-input" data-f="source" rows="1" placeholder="Journal / Conference">${escapeHtml(c.source||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">DOI / URL</span><textarea class="vf-input" data-f="doi" rows="1" placeholder="10.1109/… or https://…">${escapeHtml(c.doi||'')}</textarea></label>
      </div>
      <div class="vf-actions">
        ${n.ref?'<button class="vf-unref">Remove reference</button>':''}
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Save reference</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta=>{ const g=()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,120)+'px';}; ta.addEventListener('input',g); g(); });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  // DOI → Crossref autofill
  const doiGo=m.querySelector('.vf-doi-go'), doiIn=m.querySelector('.vf-doi-in');
  const setField=(f,val)=>{ const ta=m.querySelector(`.vf-input[data-f="${f}"]`); if(ta && val){ ta.value=val; ta.dispatchEvent(new Event('input')); } };
  const fetchDoi=async()=>{
    let doi=(doiIn.value||'').trim();
    if(!doi){ toast('Paste a DOI first'); return; }
    doi=doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').replace(/^doi:/i,'').trim();
    doiGo.disabled=true; const old=doiGo.textContent; doiGo.textContent='…';
    try{
      const r=await fetch('https://api.crossref.org/works/'+encodeURIComponent(doi),{headers:{'Accept':'application/json'}});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const msg=(await r.json()).message||{};
      const authors=(msg.author||[]).map(a=>[a.family,a.given].filter(Boolean).join(', ')).join('; ');
      const title=Array.isArray(msg.title)?msg.title[0]:msg.title;
      const yr=(msg.issued&&msg.issued['date-parts']&&msg.issued['date-parts'][0]&&msg.issued['date-parts'][0][0]);
      const source=Array.isArray(msg['container-title'])?msg['container-title'][0]:(msg['container-title']||msg.publisher);
      if(authors) setField('authors',authors);
      if(title) setField('title',title);
      if(yr) setField('year',String(yr));
      if(source) setField('source',source);
      setField('doi', msg.DOI ? 'https://doi.org/'+msg.DOI : doi);
      toast('Citation autofilled');
    }catch(e){ toast('DOI lookup failed - check the DOI or fill manually'); }
    finally{ doiGo.disabled=false; doiGo.textContent=old; }
  };
  doiGo.onclick=fetchDoi;
  doiIn.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); fetchDoi(); } });
  m.querySelector('.vf-go').onclick=()=>{
    const cit={}; m.querySelectorAll('.vf-input').forEach(ta=>{ if(ta.value.trim()) cit[ta.dataset.f]=ta.value.trim(); });
    n.citation=cit; n.ref=true;
    const formatted=formatCitation(cit);
    if(formatted) n.text=formatted;
    pushHistory(); render(); close(); toast('Reference saved');
  };
  m.querySelector('.vf-unref')?.addEventListener('click',()=>{ delete n.ref; delete n.citation; pushHistory(); render(); close(); toast('Reference removed'); });
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){e.preventDefault();close();} });
}
// Collect every reference node and copy a formatted list to the clipboard.
function exportReferences(){
  if(!map) return;
  const refs=Object.values(map.nodes).filter(n=>n.ref).map(n=>formatCitation(n.citation)||nodeTextPlain(n.text));
  if(!refs.length){ toast('No reference nodes yet - mark a node with 📖'); return; }
  refs.sort((a,b)=>a.localeCompare(b));
  const text='References\n\n'+refs.map((r,i)=>`[${i+1}] ${r}`).join('\n')+'\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=>toast(`${refs.length} references copied`),
      ()=>{ download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast('Downloaded references'); });
  } else { download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast('Downloaded references'); }
}

/* ============================================================
   IMAGE ATTACHMENTS - stored as down-scaled data-URLs on the node
   ============================================================ */
function attachImageToNode(id){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=()=>{ const f=inp.files[0]; if(f) readImageFile(f,id); };
  inp.click();
}
function readImageFile(file,id){
  if(!file.type.startsWith('image/')){ toast('Not an image file'); return; }
  const reader=new FileReader();
  reader.onload=()=>{
    const img=new Image();
    img.onload=()=>{
      // Down-scale to a sane max so the data-URL stays small (esp. for cloud/GitHub storage)
      const MAX=360;
      let w=img.width,h=img.height;
      if(w>MAX){ h=Math.round(h*MAX/w); w=MAX; }
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      let data;
      try{ data=cv.toDataURL('image/jpeg',0.82); }catch(e){ data=reader.result; }
      map.nodes[id].image=data;
      // autoLayout(), not just render(): the node grows to fit the image, and
      // its neighbours' positions were computed for the old, smaller size -
      // without a re-tidy the enlarged node overlaps them.
      pushHistory(); render(); autoLayout();
      const kb=Math.round(data.length/1024);
      toast(`Image attached (~${kb} KB)`+(kb>500 && MODE==='cloud'?' - large images slow cloud sync':''));
    };
    img.onerror=()=>toast('Could not read image');
    img.src=reader.result;
  };
  reader.readAsDataURL(file);
}

/* ------------------------------------------------------------
   Drag-and-drop / paste an image straight onto a node.

   Both paths funnel into readImageFile() above, so the down-scale,
   size warning and cloud-sync caveat are shared rather than
   reimplemented.

   Note these use the HTML5 drag events (dragover/drop), which are a
   completely separate channel from the mousedown/mousemove dragging
   used to reparent nodes - so file drops and node dragging cannot
   interfere with each other.
   ------------------------------------------------------------ */

// Which node, if any, is under these viewport coordinates?
function nodeIdAtPoint(clientX, clientY){
  const el = document.elementFromPoint(clientX, clientY);
  const nodeEl = el && el.closest ? el.closest('.node') : null;
  const id = nodeEl && nodeEl.dataset.id;
  return (id && map && map.nodes && map.nodes[id]) ? id : null;   // must be a live node
}

// Pull the first image out of a DataTransfer, whether it arrived as a
// dropped file or as a pasted clipboard item.
function firstImageFile(dt){
  if(!dt) return null;
  const files = dt.files && dt.files.length ? [...dt.files] : [];
  if(files.length) return files.find(f => f.type.startsWith('image/')) || null;
  // Clipboard images arrive as items with no entry in .files
  if(dt.items){
    for(const it of dt.items){
      if(it.kind === 'file'){
        const f = it.getAsFile();
        if(f && f.type.startsWith('image/')) return f;
      }
    }
  }
  return null;
}

let _fileDropEl = null;
function setFileDropTarget(el){
  if(_fileDropEl === el) return;
  if(_fileDropEl) _fileDropEl.classList.remove('file-drop');
  _fileDropEl = el;
  if(_fileDropEl) _fileDropEl.classList.add('file-drop');
}

if(stage){
  stage.addEventListener('dragover', e => {
    // Only claim the event for actual file drags - otherwise a text
    // selection drag would be hijacked too.
    if(READONLY || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const id = nodeIdAtPoint(e.clientX, e.clientY);
    // A separate class from .drop-target on purpose: that one means
    // "nest as child" during node dragging, and reusing it here would
    // promise something this drop does not do.
    setFileDropTarget(id ? viewport.querySelector(`.node[data-id="${id}"]`) : null);
  });

  stage.addEventListener('dragleave', e => {
    if(e.target === stage || !stage.contains(e.relatedTarget)) setFileDropTarget(null);
  });

  stage.addEventListener('drop', e => {
    if(READONLY || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setFileDropTarget(null);
    const id = nodeIdAtPoint(e.clientX, e.clientY);
    if(!id){ toast('Drop an image onto a topic card to attach it'); return; }
    const file = firstImageFile(e.dataTransfer);
    if(!file){ toast('Only image files can be attached'); return; }
    if(e.dataTransfer.files && e.dataTransfer.files.length > 1) toast('Attaching the first image only');
    // Same commit-first reasoning as the paste handler below.
    const editingEl = document.querySelector('.node.editing');
    if(editingEl){
      const te = editingEl.querySelector('.node-text') || editingEl;
      te.blur();
    }
    readImageFile(file, id);
  });
}

window.addEventListener('paste', e => {
  if(READONLY) return;
  const file = firstImageFile(e.clipboardData);
  if(!file) return;                       // ordinary text paste - leave it alone

  // If a node is mid-edit, commit that edit BEFORE attaching the image.
  // startEdit() represents an existing image as ![alt](src) markdown inside
  // the editable text, and finish() parses it back out on commit - including
  // a branch that DELETES n.image when the text contains no such markdown.
  // Setting n.image directly during an edit produces exactly that state, so
  // the image was being wiped the moment focus left the node. Committing
  // first means the attach lands on a settled node instead.
  const editingEl = document.querySelector('.node.editing');
  const targetId = (editingEl && editingEl.dataset.id) || sel;
  if(!targetId || !map || !map.nodes[targetId]){ toast('Select a topic first, then paste the image'); return; }
  e.preventDefault();                      // only now, once we know we are handling it
  if(editingEl){
    const te = editingEl.querySelector('.node-text') || editingEl;
    te.blur();                             // synchronous: onBlur -> finish(true)
  }
  readImageFile(file, targetId);
});

/* ============================================================
   SEARCH ACROSS ALL MAPS
   ============================================================ */
async function searchAllMaps(query){
  const q=(query||'').trim().toLowerCase();
  if(!q) return [];
  let idx=[]; try{ idx=await Store.list(); }catch(e){ idx=[]; }
  if(!idx.length) return [];
  const results=[];
  const CONCURRENCY = 6;
  // Process in batches to avoid firing 50+ parallel GitHub requests (rate limit)
  for(let i=0;i<idx.length && results.length<200;i+=CONCURRENCY){
    const batch = idx.slice(i, i+CONCURRENCY);
    const maps = await Promise.all(batch.map(async meta=>{
      try{
        const m = (meta.id===(map&&map.id)) ? map : await Store.get(meta.id);
        return m && m.nodes ? m : null;
      }catch(e){ return null; }
    }));
    for(const m of maps){
      if(!m) continue;
      for(const n of Object.values(m.nodes)){
        const plain=nodeTextPlain(n.text||'').toLowerCase();
        const notes=(n.notes||'').replace(/<[^>]*>/g,' ').toLowerCase();
        if(plain.includes(q) || notes.includes(q)){
          const src=plain.includes(q)?nodeTextPlain(n.text||''):(n.notes||'').replace(/<[^>]*>/g,' ');
          const at=src.toLowerCase().indexOf(q);
          const snippet=(at>30?'…':'')+src.slice(Math.max(0,at-30), at+q.length+40).trim()+'…';
          results.push({ mapId:m.id, mapTitle:m.title||'Untitled', nodeId:n.id, snippet });
          if(results.length>=200) return results;
        }
      }
    }
  }
  return results;
}

// Debounced global search → render results panel
let _globalSearchT=null, _globalSearchSeq=0;
function runGlobalSearch(query){
  clearTimeout(_globalSearchT);
  const q=(query||'').trim();
  if(q.length<2){ hideGlobalResults(); return; }
  const seq=++_globalSearchSeq;
  _globalSearchT=setTimeout(async ()=>{
    const panel=ensureGlobalResults();
    panel.innerHTML='<div class="gs-status">Searching all maps…</div>';
    const results=await searchAllMaps(q);
    if(seq!==_globalSearchSeq) return;   // a newer search superseded this one
    renderGlobalResults(results, q);
  }, 220);
}
function ensureGlobalResults(){
  let panel=$('#globalResults');
  if(!panel){
    panel=document.createElement('div');
    panel.id='globalResults'; panel.className='global-results';
    panel.addEventListener('mousedown',e=>e.stopPropagation());
    document.body.appendChild(panel);
  }
  // Anchor under the search strip
  panel.style.display='block';
  positionPopup(panel, $('#searchWrap'), {align:'right'});
  return panel;
}
function hideGlobalResults(){ const p=$('#globalResults'); if(p) p.style.display='none'; }
function renderGlobalResults(results, q){
  const panel=ensureGlobalResults();
  if(!results.length){ panel.innerHTML=`<div class="gs-status">No matches for “${escapeHtml(q)}”.</div>`; return; }
  // Group by map
  const byMap={};
  results.forEach(r=>{ (byMap[r.mapId]=byMap[r.mapId]||{title:r.mapTitle, items:[]}).items.push(r); });
  const re=new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','ig');
  panel.innerHTML=`<div class="gs-head">${results.length} match${results.length===1?'':'es'} across ${Object.keys(byMap).length} map${Object.keys(byMap).length===1?'':'s'}</div>`+
    Object.entries(byMap).map(([mid,g])=>`
      <div class="gs-group">
        <div class="gs-map">${escapeHtml(g.title)}${mid===(map&&map.id)?' <span class="gs-cur">(current)</span>':''}</div>
        ${g.items.slice(0,8).map(it=>`
          <button class="gs-item" data-map="${mid}" data-node="${it.nodeId}">
            ${escapeHtml(it.snippet).replace(re,'<mark>$1</mark>')}
          </button>`).join('')}
        ${g.items.length>8?`<div class="gs-more">+${g.items.length-8} more…</div>`:''}
      </div>`).join('');
  panel.querySelectorAll('.gs-item').forEach(b=> b.onclick=async ()=>{
    const mid=b.dataset.map, nid=b.dataset.node;
    if(!map || map.id!==mid){ await loadMap(mid); }
    select(nid,false);
    centreOn(nid);
    hideGlobalResults();
  });
}

/* ---------- inline editing ---------- */
// Live markdown shortcuts while editing: typing the closing delimiter of
// **bold**, *italic*, or ~~strike~~ converts the span in place (Notion/Linear
// style). Runs on each input event; processes one completed pattern at a time.
function tryMarkdownShortcut(){
  const wsel = window.getSelection();
  if(!wsel || !wsel.rangeCount) return false;
  const range = wsel.getRangeAt(0);
  const node = range.startContainer;
  if(node.nodeType !== 3) return false;            // text nodes only
  const offset = range.startOffset;
  const upto = node.nodeValue.slice(0, offset);
  // Order matters: bold (**) must be tested before italic (*).
  const patterns = [
    [/\*\*([^*]+?)\*\*$/, 'b'],
    [/\*([^*]+?)\*$/,     'i'],
    [/~~([^~]+?)~~$/,     's'],
    [/`([^`]+?)`$/,       'code'],
  ];
  for(const [re, tag] of patterns){
    const m = upto.match(re);
    if(!m || !m[1].trim()) continue;
    const inner = m[1];
    const matchStart = offset - m[0].length;
    const before = node.nodeValue.slice(0, matchStart);
    const after  = node.nodeValue.slice(offset);
    const parent = node.parentNode;
    const frag = document.createDocumentFragment();
    if(before) frag.appendChild(document.createTextNode(before));
    const fmt = document.createElement(tag);
    fmt.textContent = inner;
    frag.appendChild(fmt);
    const afterNode = document.createTextNode(after.length ? after : '\u00A0');
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    // Put the cursor right after the formatted span so further typing is normal
    const nr = document.createRange();
    if(after.length){ nr.setStart(afterNode, 0); }
    else { nr.setStart(afterNode, 1); }   // past the nbsp placeholder
    nr.collapse(true);
    wsel.removeAllRanges(); wsel.addRange(nr);
    return true;
  }
  return false;
}

// Edit an imported block node (code block or table) in place: its rendered HTML is
// made contentEditable and, on commit, read back into n.html (code -> re-escaped
// <pre><code>; table -> sanitized <table>) so n.text is never corrupted. Blur / Esc /
// Ctrl+Enter finish; inside a code block Enter just adds a newline.
function startBlockEdit(id, el){
  const node=map.nodes[id]; const box=el.querySelector('.node-block'); if(!node||!box) return;
  const isCode=/<pre[\s>]/i.test(node.html||''); const original=node.html;
  el.classList.add('editing','editing-block');
  box.setAttribute('contenteditable','true'); box.focus();
  const finish=(commit)=>{
    box.removeAttribute('contenteditable'); el.classList.remove('editing','editing-block');
    box.removeEventListener('blur',onBlur); box.removeEventListener('keydown',onKey);
    if(commit){
      let html;
      if(isCode){
        const pre=box.querySelector('pre'); let code;
        if(pre){ const tmp=pre.cloneNode(true); tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n'))); code=(tmp.textContent||'').replace(/\n$/,''); }
        else code=(box.textContent||'');
        html='<pre><code>'+code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</code></pre>';
      } else {
        const tbl=box.querySelector('table');
        html=sanitizeNotes(tbl?tbl.outerHTML:box.innerHTML);
      }
      if(!html || !html.replace(/<[^>]+>/g,'').trim()) html=original;   // never allow it to be emptied
      map.nodes[id].html=html; pushHistory();
    }
    autoLayout();   // re-renders the node fresh from n.html (drops contentEditable cruft)
  };
  const onBlur=()=>finish(true);
  const onKey=e=>{
    e.stopPropagation();
    if(e.key==='Escape'){ e.preventDefault(); finish(false); box.blur(); }
    else if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); finish(true); box.blur(); }
  };
  box.addEventListener('blur',onBlur); box.addEventListener('keydown',onKey);
}
// ---- Formula function autocomplete: Excel-style "=SU" suggests SUM(...) while typing ----
let _formulaAC = null;   // { el, matches, replaceStart, replaceEnd, activeIndex, textEl, nodeId }
function _caretTextOffset(el){
  const sel=window.getSelection();
  if(!sel.rangeCount) return (el.textContent||'').length;
  const range=sel.getRangeAt(0);
  const pre=range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}
function _setCaretTextOffset(el, offset){
  const sel=window.getSelection();
  const range=document.createRange();
  let remaining=offset, node=null, foundOffset=0;
  const walker=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  while(walker.nextNode()){
    const tn=walker.currentNode;
    if(remaining<=tn.textContent.length){ node=tn; foundOffset=remaining; break; }
    remaining-=tn.textContent.length;
  }
  if(node) range.setStart(node, foundOffset);
  else { range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); return; }
  range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
}
// Pure trigger-detection: are we, right now, in a position where a function name could
// start (right after "=", an operator, "(", "," or whitespace, inside a formula)? Returns
// the partial name typed so far and where to splice in the chosen suggestion.
function detectFormulaAutocompleteTrigger(text, caretOffset){
  if(!text.trimStart().startsWith('=')) return null;
  const before=text.slice(0, caretOffset);
  const m=before.match(/(?:^|[=+\-*/%^(,\s])([A-Za-z]{0,20})$/);
  if(!m) return null;
  const partial=m[1];
  return { partial, replaceStart:caretOffset-partial.length, replaceEnd:caretOffset };
}
function closeFormulaAutocomplete(){
  if(_formulaAC){ _formulaAC.el.remove(); _formulaAC=null; }
}
function _renderFormulaAcActive(){
  if(!_formulaAC) return;
  [..._formulaAC.el.children].forEach((row,i)=>row.classList.toggle('active', i===_formulaAC.activeIndex));
  const activeRow=_formulaAC.el.children[_formulaAC.activeIndex];
  if(activeRow) activeRow.scrollIntoView({block:'nearest'});
}
function _insertFormulaSuggestion(){
  if(!_formulaAC) return;
  const f=_formulaAC.matches[_formulaAC.activeIndex]; if(!f) return;
  const {textEl, replaceStart, replaceEnd, nodeId}=_formulaAC;
  const text=textEl.textContent||'';
  const insertion = f.name==='PI' ? f.name : f.name+'(';   // PI is a bare constant, no parens
  const newText = text.slice(0,replaceStart)+insertion+text.slice(replaceEnd);
  textEl.textContent=newText;
  _setCaretTextOffset(textEl, replaceStart+insertion.length);
  closeFormulaAutocomplete();
  textEl.focus();
  relayoutDuringEdit(nodeId);
}
function updateFormulaAutocomplete(textEl, nodeId){
  const text=textEl.textContent||'';
  const caret=_caretTextOffset(textEl);
  const trig=detectFormulaAutocompleteTrigger(text, caret);
  if(!trig){ closeFormulaAutocomplete(); return; }
  const partial=trig.partial.toUpperCase();
  const matches=FORMULA_FUNC_INFO.filter(f=>f.name.startsWith(partial)).slice(0,8);
  if(!matches.length){ closeFormulaAutocomplete(); return; }
  if(!_formulaAC){
    const pop=document.createElement('div'); pop.className='formula-ac';
    document.body.appendChild(pop);
    _formulaAC = { el:pop, matches:[], replaceStart:0, replaceEnd:0, activeIndex:0, textEl, nodeId };
  }
  _formulaAC.matches=matches; _formulaAC.replaceStart=trig.replaceStart; _formulaAC.replaceEnd=trig.replaceEnd; _formulaAC.activeIndex=0;
  _formulaAC.textEl=textEl; _formulaAC.nodeId=nodeId;
  _formulaAC.el.innerHTML='';
  matches.forEach(f=>{
    const row=document.createElement('div'); row.className='formula-ac-row';
    row.innerHTML='<span class="formula-ac-sig">'+f.sig+'</span><span class="formula-ac-desc">'+f.desc+'</span>';
    row.addEventListener('mousedown', e=>{ e.preventDefault(); _insertFormulaSuggestion(); });
    _formulaAC.el.appendChild(row);
  });
  _renderFormulaAcActive();
  positionPopup(_formulaAC.el, textEl);
}
// Called first from the editing keydown handler; returns true if it handled the key
// (so the caller should stop - e.g. Enter selects a suggestion instead of finishing the edit).
function formulaAutocompleteKeydown(e){
  if(!_formulaAC) return false;
  if(e.key==='ArrowDown'){ e.preventDefault(); _formulaAC.activeIndex=Math.min(_formulaAC.matches.length-1, _formulaAC.activeIndex+1); _renderFormulaAcActive(); return true; }
  if(e.key==='ArrowUp'){ e.preventDefault(); _formulaAC.activeIndex=Math.max(0, _formulaAC.activeIndex-1); _renderFormulaAcActive(); return true; }
  if(e.key==='Tab' || e.key==='Enter'){ e.preventDefault(); _insertFormulaSuggestion(); return true; }
  if(e.key==='Escape'){ closeFormulaAutocomplete(); return true; }
  return false;
}
function startEdit(id){
  if(READONLY) return;
  if(map.nodes[id] && map.nodes[id].hr) return;   // dividers aren't editable
  const el=document.querySelector(`.node[data-id="${id}"]`); if(!el) return;
  if(map.nodes[id] && map.nodes[id].html){ startBlockEdit(id, el); return; }   // edit code/table in place
  const textEl=el.querySelector('.node-text')||el;
  const raw = map.nodes[id]?.text || '';
  // Preserve any inline formatting (bold/italic/etc.) for the user to edit
  if(INLINE_HTML_RE.test(raw)) textEl.innerHTML = sanitizeInlineHTML(raw);
  else textEl.textContent = raw;
  // If the node carries an image, reveal its source while editing so the user sees/edits
  // everything (caption + image); it's parsed back out on commit.
  if(map.nodes[id] && map.nodes[id].image){
    const cap = textEl.textContent.trim();
    textEl.textContent = (cap ? cap + '  ' : '') + '![' + (map.nodes[id].imageAlt||'') + '](' + map.nodes[id].image + ')';
  }
  el.classList.add('editing');
  textEl.contentEditable='true';
  // Keep the format toolbar visible - it's what makes inline B/I/U work
  textEl.focus();
  // select all text so typing replaces it
  const range=document.createRange(); range.selectNodeContents(textEl);
  const s=getSelection(); s.removeAllRanges(); s.addRange(range);
  let _editRAF=0;
  const finish=(commit)=>{
    closeFormulaAutocomplete();
    textEl.contentEditable='false'; el.classList.remove('editing');
    textEl.removeEventListener('blur',onBlur); textEl.removeEventListener('keydown',onKey);
    textEl.removeEventListener('input',onInput);
    if(commit){
      // Capture as HTML so the user's inline B/I/U is preserved.
      const html = textEl.innerHTML.trim();
      let plain = textEl.textContent.trim();
      // Pull an image reference (![alt](src)) back out into n.image / n.imageAlt so editing
      // an image node updates the picture rather than storing the markdown as text.
      const imgM = plain.match(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/);
      if(imgM){ map.nodes[id].image = imgM[2]; map.nodes[id].imageAlt = imgM[1]||''; plain = plain.replace(imgM[0],'').replace(/\s{2,}/g,' ').trim(); }
      else if(map.nodes[id].image!==undefined){ delete map.nodes[id].image; delete map.nodes[id].imageAlt; }
      const isImg = map.nodes[id].image!==undefined;
      // If the user only typed plain text, store plain; otherwise store sanitized HTML.
      const hasFormatting = INLINE_HTML_RE.test(html) && !imgM;
      let newText = plain ? (hasFormatting ? sanitizeInlineHTML(html) : plain) : (isImg ? '' : 'Untitled');
      // A user-typed entity code (&rarr;) gets double-escaped to &amp;rarr; through the
      // contentEditable round-trip; restore it so it still renders as a symbol even when
      // the selection is wrapped in inline formatting (matches plain-text behaviour).
      if(newText && newText !== 'Untitled') newText = newText.replace(/&amp;(#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&$1');
      map.nodes[id].text = newText;
      map.nodes[id].updated = Date.now();
      // Title sync - for the root and only when user hasn't renamed the map manually
      if(id===map.rootId && map.titleAuto===true){
        // Strip tags for the title
        const titleText = newText.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim() || 'Untitled';
        map.title = titleText;
        $('#mapTitle').value = titleText;
        refreshList();
        // keep the tab label live too (mirrors the #mapTitle input handler)
        if(_tabActive>=0 && _tabs[_tabActive]) _tabs[_tabActive].title=titleText;
        const _tabLbl=document.querySelector('#tabRow .tab.active .tab-title'); if(_tabLbl) _tabLbl.textContent=titleText||'Untitled';
      }
      pushHistory();
    }
    // Tidy the branch so the (grown/shrunk) node and its siblings stay neatly
    // laid out after editing - mirrors GitMind, which keeps the map tidy both
    // during and after typing. autoLayout() re-renders internally.
    if(_editRAF){ cancelAnimationFrame(_editRAF); _editRAF=0; }
    autoLayout();
  };
  const onBlur=()=>finish(true);
  const onInput=()=>{
    tryMarkdownShortcut();
    updateFormulaAutocomplete(textEl, id);
    // Keep the map tidy as the node grows (GitMind-style live reflow), throttled
    // to one re-layout per animation frame so typing stays smooth.
    if(_editRAF) cancelAnimationFrame(_editRAF);
    _editRAF=requestAnimationFrame(()=>{ _editRAF=0; relayoutDuringEdit(id); });
  };
  const onKey=e=>{
    e.stopPropagation();
    if(formulaAutocompleteKeydown(e)) return;   // popup open: let it handle nav/select/dismiss first
    // Standard contentEditable shortcuts: Ctrl/Cmd+B / I / U toggle inline
    if((e.ctrlKey||e.metaKey) && !e.shiftKey){
      const k=e.key.toLowerCase();
      if(k==='b'||k==='i'||k==='u'){ e.preventDefault(); execCmd(k==='b'?'bold':k==='i'?'italic':'underline'); return; }
    }
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(true);textEl.blur();}
    if(e.key==='Escape'){e.preventDefault();textEl.textContent=map.nodes[id].text;finish(false);textEl.blur();}
  };
  textEl.addEventListener('blur',onBlur); textEl.addEventListener('keydown',onKey);
  textEl.addEventListener('input',onInput);
}

/* ---------- node context toolbar ---------- */
const FONT_SIZES = [12,14,15,16,18,20,24,28,32];
const TEXT_COLORS = ['#23201b','#5b5447','#b8451f','#c98a1a','#5a7d3a','#2f6f6a','#3a6ea5','#9b4f96'];
const HILITES = ['#fff59d','#ffcdd2','#c8e6c9','#b3e5fc','#e1bee7','#ffe0b2'];
let activePicker = null;

function showPicker(anchor, kind, current, onPick){
  // Toggle off if the same anchor's picker is already open
  if(activePicker && activePicker._anchor===anchor){
    activePicker.remove(); activePicker=null; return;
  }
  if(activePicker){ activePicker.remove(); activePicker=null; }
  document.querySelectorAll('.export-pop').forEach(p=>{ try{p.remove();}catch(_){} });
  try{ if(typeof closeThemePanel==='function') closeThemePanel(); }catch(_){}
  const p=document.createElement('div');
  p.className='picker '+kind; p._anchor=anchor;
  if(kind==='size'){
    p.innerHTML=FONT_SIZES.map(s=>
      `<button data-v="${s}" class="${s==current?'on':''}">${s}</button>`).join('');
  }else if(kind==='align'){
    const opts=[
      {v:'left',  ic:'⫷', t:'Align left'},
      {v:'center',ic:'≡', t:'Align centre'},
      {v:'right', ic:'⫸', t:'Align right'}
    ];
    p.innerHTML=opts.map(o=>
      `<button data-v="${o.v}" class="${o.v===current?'on':''}" title="${o.t}"><span class="align-icon align-${o.v}">${o.ic}</span></button>`).join('');
  }else{
    const list = kind==='text' ? TEXT_COLORS : HILITES;
    const label = kind==='text' ? 'Default' : 'None';
    p.innerHTML =
      `<button class="p-default" data-v="">${label}</button>`+
      list.map(c=>`<button class="p-sw ${c==current?'on':''}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('');
  }
  document.body.appendChild(p);
  positionPopup(p, anchor);
  activePicker=p;
  p.addEventListener('mousedown',e=>e.stopPropagation());
  p.querySelectorAll('button').forEach(b=>{
    // Keep contentEditable selection alive while picking
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const v=b.dataset.v;
      onPick(kind==='size' ? parseInt(v) : (v||null));
      p.remove(); if(activePicker===p) activePicker=null;
    });
  });
}
// global click closes any open picker
document.addEventListener('click',e=>{
  if(activePicker && !activePicker.contains(e.target) && !e.target.closest('.fmt-btn')){
    activePicker.remove(); activePicker=null;
  }
});

// Where the node bar *would* sit if there were no viewport edges to worry
// about: horizontally centred under the node, with a constant ~12px
// on-screen gap below it regardless of zoom (a world-space gap would shrink
// when zoomed out).
function nodeBarBasePosition(n){
  return {
    left: n.x+(n.w||0)/2,
    top:  n.y+(n.h||40)+12/view.k
  };
}

// Keeps the (already-appended) node bar fully inside the visible canvas
// area, nudging it back on-screen if the node it belongs to sits near an
// edge. Always recomputes from the canonical base position first, so
// corrections never accumulate/drift across repeated calls (e.g. while
// panning or zooming with a node selected).
function positionAndClampNodeBar(bar, n){
  const pos=nodeBarBasePosition(n);
  bar.style.left=pos.left+'px';
  bar.style.top=pos.top+'px';
  bar.style.transformOrigin='top center';
  // The bar lives inside the zoomable viewport, so counter-scale it by 1/zoom
  // to keep it a constant on-screen size no matter how far the map is zoomed.
  bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
  if(!stage) return;
  const z=_uiZ();   // getBoundingClientRect() below scales with the UI-level display size too, not just canvas zoom - same correction _stageSize()/_stagePoint() already apply
  // _prevStageRect is kept fresh by _markStage() at gesture-settle points, not every
  // frame - the stage's own bounds can't change mid-gesture, so reusing it here saves
  // one of the two forced-reflow getBoundingClientRect() calls this function used to
  // make on every single pan/zoom/drag frame.
  const bounds=(_prevStageRect && _prevStageRect.width>1) ? _prevStageRect : stage.getBoundingClientRect();
  const margin=8*z;   // keep the comparison in the same raw space as bounds/rect rather than mixing a CSS-px margin into it
  const rect=bar.getBoundingClientRect();
  const k=view.k||1;
  let dx=0, dy=0;
  const maxLeft=bounds.right-margin, minLeft=bounds.left+margin;
  if(rect.right>maxLeft) dx=maxLeft-rect.right;
  if(rect.left+dx<minLeft) dx=minLeft-rect.left;   // bar wider than the stage: pin to the left edge rather than overflow both sides
  const maxTop=bounds.bottom-margin, minTop=bounds.top+margin;
  if(rect.bottom>maxTop) dy=maxTop-rect.bottom;
  if(rect.top+dy<minTop) dy=minTop-rect.top;
  if(dx||dy){
    bar.style.left=(pos.left+dx/(k*z))+'px';
    bar.style.top=(pos.top+dy/(k*z))+'px';
  }
}

// Cheap alternative to positionNodeBar() for continuous gestures (dragging a node,
// relayout-while-typing) where the toolbar's CONTENT never changes mid-gesture -
// only the node's position does. positionNodeBar() tears the bar down and rebuilds
// ~20 buttons' worth of innerHTML plus re-attaches a listener on every one of them;
// doing that on every drag-move frame was the single biggest cost in the whole
// pan/zoom/drag path. This just repositions the bar that's already there.
function repositionNodeBar(){
  const bar=document.getElementById('nodebar');
  if(bar){ if(sel && map && map.nodes[sel]) positionAndClampNodeBar(bar, map.nodes[sel]); }
  else positionNodeBar();   // no bar yet (shouldn't normally happen mid-gesture) - build it properly
}

function positionNodeBar(){
  $('#nodebar')?.remove();
  if(READONLY) return;            // read-only shared view shows no editing toolbar
  if(activePicker){ activePicker.remove(); activePicker=null; }
  // When 2+ nodes are multi-selected, the bottom bulk bar takes over - don't
  // also show the single-node toolbar.
  if(typeof multiSel !== 'undefined' && multiSel.size >= 2) return;
  if(!sel||!map.nodes[sel]) return;
  const el=document.querySelector(`.node[data-id="${sel}"]`); if(!el) return;
  const n=map.nodes[sel];
  const isRoot=sel===map.rootId;
  const hasKids=childrenOf(sel).length>0;
  const fs = n.fontSize || (isRoot?19:15);
  const tc = n.textColor || (isRoot?'#ffffff':'#23201b');
  const hl = n.highlight || 'transparent';

  const bar=document.createElement('div'); bar.className='nodebar'; bar.id='nodebar';
  bar.innerHTML=`
    <div class="nb-group">
      <button data-a="child" title="Add child (Tab)">＋</button>
      ${!isRoot?'<button data-a="sibling" title="Add sibling (Enter)">⤵</button>':''}
      ${hasKids?`<button data-a="collapse" title="Collapse/expand (Space)">${map.nodes[sel].collapsed?'⊕':'⊖'}</button>`:''}
      <button data-a="edit" title="Edit (F2)">✎</button>
      <button data-a="notes" class="${(n.notes||'').trim()?'on':''}" title="${(n.notes||'').trim()?'Edit notes':'Add notes'}">📝</button>
      <button data-a="task" class="${n.task?'on':''}" title="Task state (todo / doing / done)">☑</button>
      <button data-a="marker" class="${n.marker?'on':''}" title="${n.marker?'Change marker':'Add a marker'}">${n.marker||'\u2B50'}</button>
      <button data-a="cite" class="${n.ref?'on':''}" title="Reference / citation">📖</button>
      <button data-a="image" class="${n.image?'on':''}" title="Attach image">🖼</button>
      ${!isRoot?'<button data-a="del" title="Delete (Del)">🗑</button>':''}
    </div>
    <div class="nb-div"></div>
    <div class="nb-group">
      <button data-a="size" class="fmt-btn size-btn" title="Font size"><span>${fs}</span><span class="caret">▾</span></button>
      <button data-a="bold" class="${n.bold?'on':''}" title="Bold"><b>B</b></button>
      <button data-a="italic" class="${n.italic?'on':''}" title="Italic"><i>I</i></button>
      <button data-a="strike" class="${n.strike?'on':''}" title="Strikethrough"><s>S</s></button>
      <button data-a="underline" class="${n.underline?'on':''}" title="Underline"><u>U</u></button>
      <button data-a="ul" class="${n.listType==='ul'?'on':''}" title="Bullet list (use Shift+Enter for new items)">•≡</button>
      <button data-a="ol" class="${n.listType==='ol'?'on':''}" title="Numbered list (use Shift+Enter for new items)">1≡</button>
      <button data-a="align" class="fmt-btn align-btn" title="Text alignment"><span class="align-icon align-${n.align||'center'}">≡</span><span class="caret">▾</span></button>
      <button data-a="textColor" class="fmt-btn color-btn" title="Text color"><span class="A-mark" style="border-bottom:3px solid ${tc}">A</span><span class="caret">▾</span></button>
      <button data-a="highlight" class="fmt-btn color-btn" title="Highlight"><span class="A-mark" style="background:${hl};padding:0 2px;border-radius:2px">A</span><span class="caret">▾</span></button>
    </div>
    <div class="nb-div"></div>
    <span class="swatches" title="Card color">${(isRoot?PALETTE:NODE_COLORS).map(c=>`<span class="sw" data-c="${c}" style="background:${c};${c==='#ffffff'?'border-color:var(--line)':''}"></span>`).join('')}</span>`;
  viewport.appendChild(bar);
  // Position after appending so we can measure the bar's real on-screen size
  // and clamp it to stay fully inside the visible canvas, however close to
  // an edge the node is.
  positionAndClampNodeBar(bar, n);
  bar.addEventListener('mousedown',e=>e.stopPropagation());
  // Prevent toolbar clicks from stealing focus from a node being edited,
  // so the contentEditable text-selection survives execCommand calls.
  bar.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));

  // Inline formatting when a node is in edit mode → applies to the current
  // text selection via execCommand. Outside edit mode → falls back to the
  // node-wide toggle (existing behaviour, kept for back-compat).
  const editingNode = () => {
    const ed = document.querySelector('.node.editing');
    return (ed && ed.dataset.id === sel) ? ed : null;
  };
  const inlineOrToggle = (prop, cmd) => {
    const ed = editingNode();
    if(ed){
      execCmd(cmd);
      ed.querySelector('.node-text')?.focus();
    } else {
      map.nodes[sel][prop] = !map.nodes[sel][prop];
      map.nodes[sel].updated = Date.now();
      pushHistory(); render();
    }
  };
  const toggleList = (kind) => {
    const ed = editingNode();
    if(ed){
      // Selection-aware list: split the selection on <br>/newlines and turn
      // each line into its own <li>. We can't use the browser's built-in
      // execCommand here - Chrome/WebKit collapse multi-line selections into
      // a single <li>, which isn't what the user wants.
      applyListToSelection(kind);
      if(map.nodes[sel].listType) map.nodes[sel].listType = null;
      ed.querySelector('.node-text')?.focus();
    } else {
      // Whole-node toggle (legacy behaviour, kept for users who haven't entered edit mode)
      const cur = map.nodes[sel].listType;
      map.nodes[sel].listType = (cur===kind ? null : kind);
      map.nodes[sel].updated = Date.now();
      pushHistory(); render();
    }
  };
  bar.querySelectorAll('button').forEach(b=>{
    b.onclick=(ev)=>{
      ev.stopPropagation();
      const a=b.dataset.a;
      if(a==='child') addNode(sel,false);
      else if(a==='sibling') addNode(sel,true);
      else if(a==='edit') startEdit(sel);
      else if(a==='del') deleteNode(sel);
      else if(a==='collapse'){ map.nodes[sel].collapsed=!map.nodes[sel].collapsed; pushHistory(); autoLayout(); }
      else if(a==='bold')      inlineOrToggle('bold',      'bold');
      else if(a==='italic')    inlineOrToggle('italic',    'italic');
      else if(a==='strike')    inlineOrToggle('strike',    'strikeThrough');
      else if(a==='underline') inlineOrToggle('underline', 'underline');
      else if(a==='ul') toggleList('ul');
      else if(a==='ol') toggleList('ol');
      else if(a==='notes') showNotesEditor(sel);
      else if(a==='task') cycleTask(sel);
      else if(a==='marker'){ showMarkerPicker(b, sel); return; }   // return: keep the bar open behind the picker
      else if(a==='cite') showCitationForm(sel);
      else if(a==='image'){
        if(map.nodes[sel].image){
          if(confirm('Remove the attached image? (OK removes · Cancel lets you pick a new one)')){ delete map.nodes[sel].image; pushHistory(); render(); }
          else attachImageToNode(sel);
        } else attachImageToNode(sel);
      }
      else if(a==='size') showPicker(b,'size',fs,v=>{ map.nodes[sel].fontSize=v; pushHistory(); render(); });
      else if(a==='align') showPicker(b,'align',n.align||'center',v=>{ map.nodes[sel].align=v; pushHistory(); render(); });
      else if(a==='textColor') showPicker(b,'text',n.textColor,v=>{ map.nodes[sel].textColor=v; pushHistory(); render(); });
      else if(a==='highlight') showPicker(b,'hilite',n.highlight,v=>{ map.nodes[sel].highlight=v; pushHistory(); render(); });
    };
  });
  bar.querySelectorAll('.sw').forEach(s=>s.onclick=(ev)=>{
    ev.stopPropagation();
    if(isRoot) map.color=s.dataset.c; else map.nodes[sel].color=s.dataset.c;
    pushHistory(); render();
  });
}

/* ============================================================
   INTERACTION - pan / zoom / drag
   ============================================================ */
let dragNode=null,dragStart=null,panning=false,panStart=null,moved=false;
let resizing=null;     // {id, sx, sy, sw, sh}
let dropTarget=null;   // id of node currently hovered as a reparent target

// Snapshot positions of `id` and all its descendants so the whole subtree
// can move together during a drag, then reset cleanly on cancel.
function beginSubtreeDrag(id, mx, my){
  document.body.classList.add('node-dragging');   // suspend the position transition below while actively dragging (must track the pointer 1:1, not ease into place)
  const subtree={};
  withChildIndex(()=>{
    const collect = i => {
      subtree[i] = { x: map.nodes[i].x, y: map.nodes[i].y };
      childrenOf(i).forEach(collect);
    };
    collect(id);
  });
  return { mx, my, root:id, subtree };
}
// Apply (dx,dy) delta to the whole subtree captured in start.subtree.
function applySubtreeDelta(start, dx, dy){
  for(const id in start.subtree){
    const base = start.subtree[id];
    const n = map.nodes[id]; if(!n) continue;
    n.x = base.x + dx; n.y = base.y + dy;
    const el = document.querySelector(`.node[data-id="${id}"]`);
    if(el){ el.style.left = n.x+'px'; el.style.top = n.y+'px'; }
  }
}

// Used by render() to attach mousedown to the resize grip
function startResize(id, ev){
  const n=map.nodes[id];
  _rzCache=null;   // re-measure fresh - a stale factor here would throw off every dx/dy for the whole gesture
  resizing={id, sx:ev.clientX, sy:ev.clientY, sw:n.width||n.w||120, sh:n.height||n.h||40};
}
// Walks up parents; true if `id` is a descendant of `ancestorId` (or equal)
function isDescendant(id, ancestorId){
  let cur=id;
  while(cur){ if(cur===ancestorId) return true; cur=map.nodes[cur]?.parent; }
  return false;
}
// Find the node under (x,y) that's a valid drop target for the currently-dragged node.
function findDropTarget(x,y){
  if(!dragNode) return null;
  // The dragged node has pointer-events disabled during drag, so it won't be returned here.
  const els=document.elementsFromPoint(x,y);
  for(const el of els){
    const node=el.closest && el.closest('.node');
    if(node && node.dataset && node.dataset.id){
      const tid=node.dataset.id;
      if(tid===dragNode) continue;
      // Don't allow dropping a node onto its own subtree (would create a cycle)
      if(isDescendant(tid, dragNode)) continue;
      // Hovering the centre of a node nests as a child; hovering its top/bottom
      // edge inserts as a sibling before/after it (reorder). Root only accepts
      // nesting (it has no siblings).
      let mode='on';
      if(tid!==map.rootId){
        const r=node.getBoundingClientRect();
        const rel=(y-r.top)/(r.height||1);
        if(rel<0.30) mode='before';
        else if(rel>0.70) mode='after';
      }
      return {id:tid, mode};
    }
  }
  return null;
}
function setDropTarget(dt){
  const id=dt&&dt.id, mode=(dt&&dt.mode)||'on';
  if(dropTarget && dt && dropTarget.id===id && dropTarget.mode===mode) return;
  document.querySelectorAll('.node.drop-target,.node.drop-before,.node.drop-after')
    .forEach(n=>n.classList.remove('drop-target','drop-before','drop-after'));
  dropTarget=dt||null;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el) el.classList.add(mode==='on'?'drop-target':(mode==='before'?'drop-before':'drop-after'));
  }
}
// Insert `dragId` as a sibling of `refId`, immediately before or after it,
// reparenting if needed. This both reorders siblings and inserts between them.
function insertSibling(dragId, refId, mode){
  if(dragId===map.rootId || refId===map.rootId || dragId===refId) return false;
  if(isDescendant(refId, dragId)) return false;        // can't drop into own subtree
  const drag=map.nodes[dragId], ref=map.nodes[refId];
  if(!drag || !ref) return false;
  const newParent=ref.parent; if(newParent==null) return false;
  drag.parent=newParent;
  const side = (newParent===map.rootId) ? (ref.side||'right') : (map.nodes[newParent].side||'right');
  const propagate=(id,sd)=>{ map.nodes[id].side=sd; childrenOf(id).forEach(c=>propagate(c,sd)); };
  withChildIndex(()=>propagate(dragId, side));
  // Rebuild map.nodes with dragId re-positioned right before/after refId. Sibling
  // order is map.nodes key order, so this is how ordering is expressed.
  const reordered={};
  for(const k in map.nodes){
    if(k===dragId) continue;                     // pulled out; re-inserted at target
    if(k===refId && mode==='before') reordered[dragId]=drag;
    reordered[k]=map.nodes[k];
    if(k===refId && mode==='after') reordered[dragId]=drag;
  }
  if(!reordered[dragId]) reordered[dragId]=drag;
  map.nodes=reordered;
  pushHistory(); autoLayout();
  return true;
}
// Re-parent a node and propagate the new side down its subtree
function reparent(childId, newParentId){
  if(childId===map.rootId) return false;       // can't re-parent the root
  if(childId===newParentId) return false;
  if(isDescendant(newParentId, childId)) return false;
  const child=map.nodes[childId];
  if(!child || child.parent===newParentId) return false;  // dropped on its current parent - nothing to do
  child.parent=newParentId;
  // Recompute side: root alternates left/right, otherwise inherit parent's side
  let newSide;
  if(newParentId===map.rootId){
    const others=childrenOf(map.rootId).filter(c=>c!==childId).length;
    newSide = others%2 ? 'left' : 'right';
  } else {
    newSide = map.nodes[newParentId].side || 'right';
  }
  const propagate=(id,side)=>{
    map.nodes[id].side=side;
    childrenOf(id).forEach(c=>propagate(c,side));
  };
  propagate(childId, newSide);
  // The tree changed shape - re-tidy. Stable layout keeps every other branch
  // exactly where it was and just slots the moved subtree cleanly into its new
  // parent, guaranteeing nothing overlaps.
  pushHistory(); autoLayout();
  toast('Re-parented to "'+(map.nodes[newParentId].text||'…')+'"');
  return true;
}
// Reposition an existing subtree to sit cleanly as a child of `parentId`,
// shifting the whole subtree rigidly (preserves its internal arrangement).
function placeReparentedSubtree(childId, parentId){
  const child=map.nodes[childId], parent=map.nodes[parentId];
  if(!child||!parent) return;
  const layout=map.layout||'balanced';
  const sibs=childrenOf(parentId).filter(c=>c!==childId && map.nodes[c].side===child.side);
  const cw=child.w||120, ch=child.h||40;
  let tx, ty;
  if(layout==='down'){
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight,sn.x+(sn.w||120)); y=sn.y; });
      tx=maxRight+DOWN_HGAP; ty=y;
    } else { tx=parent.x+((parent.w||120)-cw)/2; ty=childY; }
  } else if(layout==='up'){
    const childY=parent.y-ch-DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight,sn.x+(sn.w||120)); y=sn.y; });
      tx=maxRight+DOWN_HGAP; ty=y;
    } else { tx=parent.x+((parent.w||120)-cw)/2; ty=childY; }
  } else {
    const dir=child.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom)maxBottom=b; colX=sn.x; });
      ty=maxBottom+VGAP;
      tx=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP);
    } else {
      tx=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP;
      ty=parent.y+((parent.h||40)-ch)/2;
    }
  }
  shiftSubtreeBy(childId, tx-child.x, ty-child.y);
}

stage.addEventListener('mousedown',e=>{
  // Don't intercept clicks on the chrome / overlay UI.
  if(e.target.closest('.topbar, .overview, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .minimap, .breadcrumb')) return;
  const nodeEl=e.target.closest('.node');
  // If the click lands inside a node that's currently being edited, let
  // contentEditable handle it natively (text selection, cursor placement).
  // Stage MUST NOT start panning here - that would clear the selection and
  // tear down the format toolbar.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  if(nodeEl){
    const id=nodeEl.dataset.id;
    // Link mode: the next node click completes (or toggles) a cross-link
    if(linkMode && !e.shiftKey){
      completeLink(id);
      return;
    }
    // Re-parent mode: the next plain node click chooses the new parent
    if(reparentMode && !e.shiftKey){
      bulkReparent(id);
      return;
    }
    // Shift-click toggles multi-selection (no drag, keep primary sel intact)
    if(e.shiftKey){
      toggleMultiSelect(id);
      return;
    }
    // Normal click clears any multi-selection
    if(multiSel.size) clearMultiSelect();
    select(id,false);
    if(READONLY) return;          // view-only: allow selection, no dragging/editing
    dragNode=id; moved=false;
    // Defer staging the subtree-drag until the pointer actually moves. Staging it
    // here walks the node's whole subtree, which makes selecting a large branch
    // (e.g. the root of a big map) slow - a plain click should be instant.
    dragStart={ mx:e.clientX, my:e.clientY, root:id, subtree:null };
  } else {
    if(reparentMode){ reparentMode=false; hideBulkBar(); updateMultiSelUI(); }
    if(linkMode) cancelLinkMode();
    panning=true; panStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};
    if(sel){
      sel=null;
      document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
      $('#nodebar')?.remove();
    }
    if(multiSel.size) clearMultiSelect();
  }
});
// Drag/resize do O(n) work (rebuild all edges, find a drop target) per move.
// Mouse moves can fire faster than the screen refreshes, so we coalesce the heavy
// work to one update per animation frame and reuse the hidden-set for the whole
// gesture (it can't change mid-drag). Keeps drag smooth on big maps / low-end.
let _moveRAF=0, _movePt=null, _dragHidden=null;
function _applyMove(){
  _moveRAF=0;
  const e=_movePt; if(!e) return;
  const hidden = _dragHidden || (_dragHidden = hiddenSet());
  if(resizing){
    const sc=view.k*_uiZ();
    const dx=(e.clientX-resizing.sx)/sc, dy=(e.clientY-resizing.sy)/sc;
    const n=map.nodes[resizing.id];
    n.width=Math.max(60, Math.round(resizing.sw+dx));
    n.height=Math.max(30, Math.round(resizing.sh+dy));
    const el=document.querySelector(`.node[data-id="${resizing.id}"]`);
    if(el){ el.style.width=n.width+'px'; el.style.maxWidth='none'; el.style.height=n.height+'px'; n.w=n.width; n.h=n.height; }
    drawEdges(hidden);
    repositionNodeBar();
  } else if(dragNode && moved){
    const sc=view.k*_uiZ();
    const dx=(e.clientX-dragStart.mx)/sc, dy=(e.clientY-dragStart.my)/sc;
    // Stage the subtree the first time a real drag begins (not on click).
    if(!dragStart.subtree) dragStart=beginSubtreeDrag(dragNode, dragStart.mx, dragStart.my);
    applySubtreeDelta(dragStart, dx, dy);
    drawEdges(hidden);
    repositionNodeBar();
    // Detect a drop target under the cursor (only after a real drag has started)
    if(dragNode!==map.rootId) setDropTarget(findDropTarget(e.clientX, e.clientY));
  }
}
window.addEventListener('mousemove',e=>{
  if(panning){                       // pan is GPU-only + cheap: keep it immediate
    const z=_uiZ();
    view.x=panStart.vx+(e.clientX-panStart.x)/z; view.y=panStart.vy+(e.clientY-panStart.y)/z;
    applyView();
    return;
  }
  if(!resizing && !dragNode) return;
  // Move-threshold check stays on the raw event so a tiny nudge still registers.
  if(dragNode && !moved){
    const sc=view.k*_uiZ();
    const dx=(e.clientX-dragStart.mx)/sc, dy=(e.clientY-dragStart.my)/sc;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
  }
  _movePt={clientX:e.clientX, clientY:e.clientY};
  if(!_moveRAF) _moveRAF=requestAnimationFrame(_applyMove);   // coalesce to one update / frame
});
window.addEventListener('mouseup',()=>{
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; _applyMove(); }
  _movePt=null; _dragHidden=null;
  if(resizing){
    resizing = null;
    // Re-tidy so the resized node's new footprint doesn't overlap its
    // neighbours. Needs an explicit render() first, not just autoLayout()
    // alone: during the drag, n.w/n.h were set directly to match the
    // dragged width/height (not measured from the DOM), and the node's
    // height was held to that exact value while actively dragging. But
    // min-height (not a hard cap - see the node rendering code) means the
    // element can actually render TALLER than that dragged value once a
    // normal render() runs, if the content needs more room than what was
    // dragged to. autoLayout() only force-remeasures nodes with NO
    // measurement at all, not ones with a stale one from the drag itself -
    // so without this render() first, it would compute positions (and
    // reserve neighbour spacing) from the stale, too-small dragged size,
    // and the node could then visually overlap a neighbour once it renders
    // at its true, larger size.
    render();
    autoLayout();
    pushHistory();
  }
  if(dragNode){
    if(dropTarget && dragNode!==map.rootId){
      const did = (dropTarget.mode==='on') ? reparent(dragNode, dropTarget.id)        // nest as child
                                           : insertSibling(dragNode, dropTarget.id, dropTarget.mode); // reorder / insert between
      // No-op drop (e.g. dropped back onto its current parent): the drag left the
      // node at the drop position, so tidy it back into place instead of overlapping.
      if(!did && moved){ autoLayout(); }
    } else if(moved){
      // Dropped in empty space (no new parent). Standard mind-map behaviour:
      // snap the tree back into its clean, non-overlapping arrangement.
      autoLayout();
      pushHistory();
    }
    setDropTarget(null);
    dragNode=null;
  }
  if(panning){ panning=false; saveMapView(); }
});

/* ============================================================
   TOUCH SUPPORT - mirrors the mouse handlers, plus pinch-zoom.
   Single finger: pan the canvas, or drag a node, or tap to select.
   Two fingers: pinch to zoom.
   ============================================================ */
let pinch=null;  // {d0, k0, cx, cy} while pinch-zooming
function tPt(t){ return {clientX:t.clientX, clientY:t.clientY}; }

stage.addEventListener('touchstart', e=>{
  if(!e.touches) return;
  // Pinch starts: two fingers down anywhere on the stage
  if(e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const dx=b.clientX-a.clientX, dy=b.clientY-a.clientY;
    pinch={ d0:Math.hypot(dx,dy), k0:view.k, cx:(a.clientX+b.clientX)/2, cy:(a.clientY+b.clientY)/2 };
    dragNode=null; panning=false; resizing=null;
    e.preventDefault();
    return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  // Don't intercept taps on the chrome / overlay UI
  if(t.target && t.target.closest && t.target.closest('.topbar, .overview, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .notes-popup, .donate-modal, .theme-panel, .login-overlay, .user-pill, .minimap, .breadcrumb')) return;
  const nodeEl=t.target.closest?.('.node');
  // Don't pan / drag when tapping inside a node that's being edited -
  // contentEditable needs to handle the touch for caret placement and selection.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  if(nodeEl){
    const id=nodeEl.dataset.id;
    select(id,false);
    panning=false;                       // drop any stale pan state from an interrupted gesture
    dragNode=id; moved=false;
    // Defer the subtree walk until the finger actually moves, so a plain tap stays
    // instant even on a large map. (The mouse path does the same; walking eagerly on
    // every touch froze selection on big maps / low-end Android.)
    dragStart={ mx:t.clientX, my:t.clientY, root:id, subtree:null };
  } else {
    dragNode=null;                       // drop any stale drag state from an interrupted gesture
    panning=true; panStart={x:t.clientX,y:t.clientY,vx:view.x,vy:view.y};
    if(sel){ sel=null; document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel')); $('#nodebar')?.remove(); }
  }
}, {passive:false});

window.addEventListener('touchmove', e=>{
  if(!e.touches) return;
  if(pinch && e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const d=Math.hypot(b.clientX-a.clientX, b.clientY-a.clientY);
    const k=Math.min(3, Math.max(0.1, pinch.k0 * (d/pinch.d0)));
    const p=_stagePoint(pinch.cx, pinch.cy);
    const px=p.x, py=p.y;
    const old=view.k;
    view.x = px-(px-view.x)*(k/old); view.y = py-(py-view.y)*(k/old); view.k = k; userZoom=k;
    applyView(); saveMapView();
    e.preventDefault(); return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  if(dragNode){
    const sc=view.k*_uiZ();
    const dx=(t.clientX-dragStart.mx)/sc, dy=(t.clientY-dragStart.my)/sc;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
    _movePt={clientX:t.clientX, clientY:t.clientY};
    if(!_moveRAF) _moveRAF=requestAnimationFrame(_applyMove);   // coalesce to one update/frame + reuse the cached hidden-set, same as the mouse path - touch can sample well above 60Hz
    e.preventDefault();
  } else if(panning){
    const z=_uiZ();
    view.x=panStart.vx+(t.clientX-panStart.x)/z; view.y=panStart.vy+(t.clientY-panStart.y)/z;
    applyView();
    e.preventDefault();
  }
}, {passive:false});

window.addEventListener('touchend', e=>{
  const remaining = e.touches ? e.touches.length : 0;
  if(pinch && remaining<2){ pinch=null; }
  if(remaining>0) return;              // still touching
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; _applyMove(); }
  _movePt=null; _dragHidden=null;
  if(dragNode){
    if(dropTarget && dragNode!==map.rootId){
      const did = (dropTarget.mode==='on') ? reparent(dragNode, dropTarget.id)
                                           : insertSibling(dragNode, dropTarget.id, dropTarget.mode);
      if(!did && moved){ autoLayout(); }   // snap back on a no-op drop
    }
    else if(moved){ autoLayout(); pushHistory(); }
    setDropTarget(null);
    dragNode=null;
  }
  if(panning){ panning=false; saveMapView(); }
});

// Android (esp. 16) fires touchcancel whenever the system/browser reclaims a gesture
// (scroll takeover, navigation, app switch, etc.). Without this, touchend never runs,
// so dragNode/panning/pinch stay set and every later touch is mis-read as a continuing
// drag - the canvas looks frozen. Reset all gesture state defensively.
window.addEventListener('touchcancel', ()=>{
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; }
  _movePt=null; _dragHidden=null;
  if(dragNode){ setDropTarget(null); dragNode=null; }
  if(panning){ panning=false; saveMapView(); }
  pinch=null; resizing=null; moved=false;
});

// Double-tap to edit (since dblclick doesn't fire reliably on touch)
let lastTap=0, lastTapId=null;
stage.addEventListener('touchend', e=>{
  const t=e.changedTouches?.[0]; if(!t) return;
  const nodeEl=t.target.closest?.('.node');
  if(!nodeEl) { lastTap=0; return; }
  const id=nodeEl.dataset.id, now=Date.now();
  if(id===lastTapId && now-lastTap<350){ startEdit(id); lastTap=0; }
  else { lastTap=now; lastTapId=id; }
});

stage.addEventListener('wheel',e=>{
  e.preventDefault();
  const p=_stagePoint(e.clientX, e.clientY);
  const px=p.x, py=p.y;
  const old=view.k;
  const k=Math.min(3,Math.max(.1, view.k*(e.deltaY<0?1.12:.89)));
  view.x=px-(px-view.x)*(k/old); view.y=py-(py-view.y)*(k/old); view.k=k; userZoom=k;
  applyView(); saveMapView();
},{passive:false});

function zoom(f){ const {w,h}=_stageSize();const px=w/2,py=h/2;const old=view.k;
  const k=Math.min(3,Math.max(.1,view.k*f));
  const tx=px-(px-view.x)*(k/old), ty=py-(py-view.y)*(k/old);
  userZoom=k;
  animateViewTo({x:tx,y:ty,k}, 160, saveMapView);
}
function setZoom(percent){
  const {w,h}=_stageSize();const px=w/2,py=h/2;const old=view.k;
  const k=Math.min(3,Math.max(.1, percent/100));
  const tx=px-(px-view.x)*(k/old), ty=py-(py-view.y)*(k/old);
  userZoom=k;
  animateViewTo({x:tx,y:ty,k}, 160, saveMapView);
}
function computeFitView(){   // pure calculation - does not touch `view` or the DOM
  if(!map) return null;
  const xs=[],ys=[],xe=[],ye=[];
  const hidden=hiddenSet();
  for(const id in map.nodes){ if(hidden.has(id))continue; const n=map.nodes[id];xs.push(n.x);ys.push(n.y);xe.push(n.x+(n.w||120));ye.push(n.y+(n.h||40)); }
  if(!xs.length) return null;
  const minx=Math.min(...xs),miny=Math.min(...ys),maxx=Math.max(...xe),maxy=Math.max(...ye);
  const {w:SW,h:SH}=_stageSize();
  // If the stage hasn't been laid out yet (e.g. fit() called during initial boot
  // before first paint), bail rather than computing a view that throws the map
  // off-screen - the caller should re-fit once layout settles.
  if(!(SW>1) || !(SH>1)) return null;
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  // Scale the map's bounding box to fit the viewport with a margin. Cap at 100%
  // so a tiny map isn't magnified; this is what makes a big map auto-shrink to
  // fit a smaller screen instead of overflowing at full size.
  const margin=64;
  const availW=Math.max(120, SW - margin*2);
  const availH=Math.max(120, SH - margin*2);
  const k=Math.max(0.1, Math.min(availW/cw, availH/ch, 1));
  return { x: SW/2 - (minx+cw/2)*k, y: SH/2 - (miny+ch/2)*k, k };
}
function fit(){
  const t=computeFitView(); if(!t) return;
  view.x=t.x; view.y=t.y; view.k=t.k;
  applyView(); _markStage();
}
// Smoothly tweens the canvas pan/zoom to a target view over `duration` ms - used where an
// instant fit()/recenter() snap would read as a jarring jump right after something else (like
// the Markdown pane's own CSS width transition) already animated smoothly. Same easing curve
// family as the pane's `cubic-bezier(.4,0,.2,1)` transition, so the two motions read as one
// continuous, cohesive movement rather than "slide, then snap".
let _viewAnimRAF=0;
function animateViewTo(target, duration, onDone){
  if(!target) return;
  cancelAnimationFrame(_viewAnimRAF);
  if(typeof window!=='undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    view.x=target.x; view.y=target.y; view.k=target.k; applyView(); _markStage(); if(onDone) onDone(); return;
  }
  const start={x:view.x, y:view.y, k:view.k};
  const t0=(typeof performance!=='undefined' ? performance.now() : Date.now());
  const ease=p=>1-Math.pow(1-p,3);   // ease-out cubic
  const step=(now)=>{
    const p=Math.min(1, (now-t0)/duration);
    const e=ease(p);
    view.x=start.x+(target.x-start.x)*e;
    view.y=start.y+(target.y-start.y)*e;
    view.k=start.k+(target.k-start.k)*e;
    applyView();
    if(p<1) _viewAnimRAF=requestAnimationFrame(step);
    else { _markStage(); if(onDone) onDone(); }
  };
  _viewAnimRAF=requestAnimationFrame(step);
}
// Centre the map's bounding box in the current stage viewport WITHOUT changing
// zoom - used when the viewport size changes (e.g. entering/leaving focus mode)
// so the map doesn't appear to jump sideways.
function computeRecenterView(){   // pure calculation - does not touch `view` or the DOM
  if(!map) return null;
  const hidden=hiddenSet();
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  }
  if(!isFinite(minx)) return null;
  const {w:SW,h:SH}=_stageSize();
  const cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  return { x: SW/2 - cx*view.k, y: SH/2 - cy*view.k, k: view.k };
}
function recenter(){
  const t=computeRecenterView(); if(!t) return;
  view.x=t.x; view.y=t.y;
  applyView(); _markStage();
}

/* ============================================================
   KEYBOARD
   ============================================================ */
// Navigate from `id` in the direction of an arrow key, respecting current layout.
function navTarget(id, key){
  if(!map||!map.nodes[id]) return null;
  const n=map.nodes[id];
  const layout=map.layout||'balanced';
  const kids=childrenOf(id);
  const parent=n.parent;
  const siblings=parent ? childrenOf(parent) : [];
  const idxInSiblings=siblings.indexOf(id);
  const firstVisible=cs=>(cs.length && !n.collapsed) ? cs[0] : null;
  const sibAt=delta=>{
    const i=idxInSiblings+delta;
    return (i>=0 && i<siblings.length) ? siblings[i] : null;
  };
  if(layout==='down'){
    if(key==='ArrowDown')  return firstVisible(kids) || sibAt(1);
    if(key==='ArrowUp')    return parent || sibAt(-1);
    if(key==='ArrowLeft')  return sibAt(-1);
    if(key==='ArrowRight') return sibAt(1);
  } else if(layout==='up'){
    if(key==='ArrowUp')    return firstVisible(kids) || sibAt(1);
    if(key==='ArrowDown')  return parent || sibAt(-1);
    if(key==='ArrowLeft')  return sibAt(-1);
    if(key==='ArrowRight') return sibAt(1);
  } else {
    const side=n.side; // 'root', 'left', 'right'
    if(key==='ArrowLeft'){
      if(id===map.rootId){
        const lk=kids.filter(k=>map.nodes[k].side==='left');
        if(lk.length && !n.collapsed) return lk[0];
      }
      if(side==='right'||side==='root') return parent;
      if(side==='left') return firstVisible(kids);
    }
    if(key==='ArrowRight'){
      if(id===map.rootId){
        const rk=kids.filter(k=>map.nodes[k].side!=='left');
        if(rk.length && !n.collapsed) return rk[0];
      }
      if(side==='left'||side==='root') return parent;
      if(side==='right') return firstVisible(kids);
    }
    if(key==='ArrowUp')   return sibAt(-1);
    if(key==='ArrowDown') return sibAt(1);
  }
  return null;
}

window.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA'].includes(e.target.tagName)||e.target.isContentEditable||document.querySelector('.node.editing')) return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
  if(!sel||!map) return;
  if(e.key==='Tab'){e.preventDefault();addNode(sel,false);}
  else if(e.key==='Enter'){e.preventDefault();addNode(sel,true);}
  else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteNode(sel);}
  else if(e.key==='F2'){e.preventDefault();startEdit(sel);}
  else if(e.key===' '){e.preventDefault();const n=map.nodes[sel];if(childrenOf(sel).length){n.collapsed=!n.collapsed;pushHistory();autoLayout();}}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();
    const next=navTarget(sel, e.key);
    if(next) select(next, false);
  }
  else if(e.key==='l'||e.key==='L'){
    // Cross-link mode: remember the source, next node click links to it
    e.preventDefault();
    startLinkMode(sel);
  }
  else if(e.key==='Escape' && linkMode){
    e.preventDefault();
    cancelLinkMode();
  }
  else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){
    // Replace mode: set the text to the typed key and enter edit with cursor at end.
    e.preventDefault();
    map.nodes[sel].text=e.key;
    const tEl=document.querySelector(`.node[data-id="${sel}"] .node-text`);
    if(tEl) tEl.textContent=e.key;
    startEdit(sel);
    requestAnimationFrame(()=>{
      const t2=document.querySelector(`.node[data-id="${sel}"] .node-text`);
      if(!t2) return;
      const r=document.createRange(); r.selectNodeContents(t2); r.collapse(false);
      const s=getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  }
});
stage.addEventListener('dblclick',e=>{const n=e.target.closest('.node');if(n)startEdit(n.dataset.id);});
// The stage clips overflow, but the browser can still programmatically scroll it
// to bring a focused/oversized node's caret into view (e.g. after pasting a large
// block while editing). Panning is done entirely via the #viewport transform, so
// the stage must never scroll - any scroll would drag the absolutely-positioned
// topbar and hint out of place (the fixed zoombar is unaffected). Lock it.
stage.addEventListener('scroll',()=>{ if(stage.scrollLeft||stage.scrollTop){ stage.scrollLeft=0; stage.scrollTop=0; } },{passive:true});

/* ============================================================
   SEARCH
   ============================================================ */
function openSearch(withReplace){
  const w=$('#searchWrap');
  w.classList.add('open');
  if(withReplace) w.classList.add('replace-mode');
  if(document.body.classList.contains('ui-rail')){
    const btn=$('#searchBtn');
    if(btn){
      // Position directly to the right of the ⌕ button, vertically centered.
      // Use offsetLeft/Top (relative to the rail's padding box) so padding/border
      // and --ui-zoom are handled correctly; getBoundingClientRect would need
      // manual padding correction and is zoom-sensitive.
      const left = btn.offsetLeft + btn.offsetWidth + 6;
      const top = btn.offsetTop + (btn.offsetHeight - w.offsetHeight) / 2;
      w.style.left = left + 'px';
      w.style.top = Math.max(4, Math.min(top, window.innerHeight - 60)) + 'px';
      w.style.right='auto';
    }
  } else { w.style.top=''; w.style.left=''; w.style.right=''; }
  $('#search').focus(); $('#search').select();
}
function closeSearch(){
  const w=$('#searchWrap');
  w.classList.remove('open','replace-mode','all-mode');
  w.style.top=''; w.style.left=''; w.style.right='';
  $('#search').value=''; $('#replace').value='';
  $('#searchCount').textContent='';
  $('#allMapsToggle')?.classList.remove('on');
  globalSearchMode=false;
  hideGlobalResults();
  doSearch('');
}
let globalSearchMode=false;
$('#allMapsToggle')?.addEventListener('click', ()=>{
  globalSearchMode = !globalSearchMode;
  const w=$('#searchWrap');
  w.classList.toggle('all-mode', globalSearchMode);
  $('#allMapsToggle').classList.toggle('on', globalSearchMode);
  $('#search').placeholder = globalSearchMode ? 'Search ALL maps…' : 'Find in nodes…';
  $('#search').focus();
  if(globalSearchMode){ runGlobalSearch($('#search').value); }
  else { hideGlobalResults(); doSearch($('#search').value); }
});
$('#searchBtn').onclick=()=>{
  const w=$('#searchWrap');
  if(w.classList.contains('open')) closeSearch(); else openSearch(false);
};
$('#replaceToggle').onclick=()=>{ $('#searchWrap').classList.toggle('replace-mode'); $('#replace').focus(); };
$('#search').addEventListener('input',e=>{ if(globalSearchMode) runGlobalSearch(e.target.value); else doSearch(e.target.value); });
$('#search').addEventListener('keydown',e=>{
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); focusNextMatch(); }
});
$('#replace').addEventListener('keydown',e=>{
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); e.shiftKey ? replaceAll() : replaceNext(); }
});
$('#replaceOne').onclick=replaceNext;
$('#replaceAll').onclick=replaceAll;

// Global shortcuts: Ctrl/⌘+F opens find, Ctrl/⌘+H opens find+replace.
// Registered separately so they fire even when a node is being edited.
window.addEventListener('keydown', e=>{
  if(!(e.ctrlKey||e.metaKey)) return;
  const k = e.key.toLowerCase();
  if(k === 'f'){
    e.preventDefault();
    // If we're editing a node, commit it first so search can highlight cleanly
    document.querySelector('.node.editing .node-text')?.blur();
    openSearch(false);
  } else if(k === 'h'){
    e.preventDefault();
    document.querySelector('.node.editing .node-text')?.blur();
    openSearch(true);
  }
}, true);  // capture phase - beat the browser's native find on Ctrl/⌘+F

let searchMatches=[], searchPos=-1;
function doSearch(q){
  q=q.trim().toLowerCase();
  searchMatches=[]; searchPos=-1;
  document.querySelectorAll('.node').forEach(el=>{
    el.classList.remove('dim','match','match-current');
    if(!q)return;
    const raw = map.nodes[el.dataset.id].text || '';
    const plain = INLINE_HTML_RE.test(raw) ? nodeTextPlain(raw) : raw;
    if(plain.toLowerCase().includes(q)){ el.classList.add('match'); searchMatches.push(el.dataset.id); }
    else el.classList.add('dim');
  });
  const cnt=$('#searchCount');
  if(cnt) cnt.textContent = q ? (searchMatches.length ? `${searchMatches.length} found` : 'none') : '';
}
function focusNextMatch(){
  if(!searchMatches.length) return;
  searchPos = (searchPos+1) % searchMatches.length;
  const id = searchMatches[searchPos];
  document.querySelectorAll('.node.match-current').forEach(n=>n.classList.remove('match-current'));
  const el=document.querySelector(`.node[data-id="${id}"]`);
  el?.classList.add('match-current');
  select(id,false);
  centreOn(id);
  $('#searchCount').textContent = `${searchPos+1} / ${searchMatches.length}`;
}
// Replace in a single node's text, HTML-aware (operates on the plain text, then
// re-stores; if the node had inline HTML we replace within text nodes only).
function replaceInNode(id, find, repl){
  const n=map.nodes[id]; if(!n) return 0;
  const flags='gi';
  const re=new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), flags);
  let count=0;
  if(INLINE_HTML_RE.test(n.text||'')){
    // Walk text nodes only, preserving tags - parse inertly via <template>.
    const tpl=document.createElement('template'); tpl.innerHTML=n.text||'';
    const walker=document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const texts=[]; let t; while((t=walker.nextNode())) texts.push(t);
    texts.forEach(tn=>{
      if(re.test(tn.nodeValue||'')){ re.lastIndex=0; tn.nodeValue=tn.nodeValue.replace(re, ()=>{count++;return repl;}); }
    });
    if(count){ const d=document.createElement('div'); d.appendChild(tpl.content); n.text=d.innerHTML; }
  } else {
    const out=(n.text||'').replace(re, ()=>{count++; return repl;});
    if(count) n.text=out;
  }
  return count;
}
function replaceNext(){
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find || !searchMatches.length) return;
  if(searchPos<0) searchPos=0;
  const id=searchMatches[searchPos] || searchMatches[0];
  const c=replaceInNode(id, find, repl);
  if(c){ pushHistory(); render(); toast(`Replaced ${c} in 1 node`); }
  doSearch(find);            // refresh matches (node may no longer match)
}
function replaceAll(){
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find) return;
  let total=0, nodes=0;
  Object.keys(map.nodes).forEach(id=>{ const c=replaceInNode(id, find, repl); if(c){ total+=c; nodes++; } });
  if(total){ pushHistory(); render(); toast(`Replaced ${total} occurrence${total>1?'s':''} in ${nodes} node${nodes>1?'s':''}`); }
  else toast('No matches to replace');
  doSearch(find);
}
// Centre the viewport on a node (used by find-next)
function centreOn(id){
  const n=map.nodes[id]; if(!n) return;
  const {w:SW,h:SH}=_stageSize();
  view.x = SW/2 - (n.x + (n.w||120)/2)*view.k;
  view.y = SH/2 - (n.y + (n.h||40)/2)*view.k;
  applyView();
}

/* ============================================================
   MINIMAP - scaled overview, click to jump
   ============================================================ */
const MM_W=168, MM_H=120;
function updateMinimap(){
  const mm=_mmEl; if(!mm) return;
  if(!map){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; mm._prevRects=''; return; }
  const hidden=hiddenSet();
  const ids=Object.keys(map.nodes).filter(id=>!hidden.has(id));
  if(!ids.length){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; mm._prevRects=''; return; }
  mm.style.display='';
  const zd=withChildIndex(zebraDepth);   // zebra tint levels, mirrors the on-canvas striping
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  ids.forEach(id=>{ const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  });
  const pad=24; minx-=pad; miny-=pad; maxx+=pad; maxy+=pad;
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  const scale=Math.min(MM_W/cw, MM_H/ch);
  const ox=(MM_W-cw*scale)/2, oy=(MM_H-ch*scale)/2;
  mm._t={minx,miny,scale,ox,oy};
  const rects=ids.map(id=>{
    const n=map.nodes[id];
    const x=ox+(n.x-minx)*scale, y=oy+(n.y-miny)*scale;
    const w=Math.max(2,(n.w||120)*scale), h=Math.max(2,(n.h||40)*scale);
    const col = id===map.rootId ? (map.color||'#e0613a')
      : (n.color && n.color!=='#fff' && n.color!=='#ffffff') ? n.color
      : (zd[id] && zd[id]%2===1) ? 'var(--zebra-1)' : (zd[id] ? 'var(--zebra-2)' : 'var(--line-2)');
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${col}" ${id===sel?'class="mm-sel"':''}/>`;
  }).join('');
  // The rects string encodes EVERYTHING the minimap shows (positions, sizes,
  // colours, root/selection, visible set - even node insertion order), so an
  // exact string match means the overview is already up to date. Skipping the
  // innerHTML write avoids re-parsing and re-rendering the whole SVG on renders
  // that didn't move nodes (selection changes, style tweaks, …).
  if(rects === mm._prevRects){ updateMinimapViewport(); return; }
  mm._prevRects=rects;
  mm.innerHTML=`<svg viewBox="0 0 ${MM_W} ${MM_H}" width="${MM_W}" height="${MM_H}">${rects}<rect id="mmView" fill="none"/></svg>`;
  updateMinimapViewport();
}
function updateMinimapViewport(){
  const mm=_mmEl; if(!mm||!mm._t) return;
  const v=mm.querySelector('#mmView'); if(!v) return;
  const {minx,miny,scale,ox,oy}=mm._t;
  // _prevStage is kept fresh by _markStage() at gesture-settle points (resize, sidebar
  // toggle, animation end, ...) rather than every frame - reusing it here avoids forcing
  // a synchronous layout reflow (stage.getBoundingClientRect()) on every single pan/zoom/
  // drag frame, since the stage's own size can't actually change mid-gesture.
  const {w:SW,h:SH} = (_prevStage && _prevStage.w>1 && _prevStage.h>1) ? _prevStage : _stageSize();
  const wx=-view.x/view.k, wy=-view.y/view.k, ww=SW/view.k, wh=SH/view.k;
  v.setAttribute('x',(ox+(wx-minx)*scale).toFixed(1));
  v.setAttribute('y',(oy+(wy-miny)*scale).toFixed(1));
  v.setAttribute('width', Math.max(4,ww*scale).toFixed(1));
  v.setAttribute('height',Math.max(4,wh*scale).toFixed(1));
}
function minimapJump(clientX, clientY){
  const mm=_mmEl; if(!mm||!mm._t) return;
  const rect=mm.getBoundingClientRect();
  const z=_uiZ();
  const {minx,miny,scale,ox,oy}=mm._t;
  const wx=minx+(((clientX-rect.left)/z)-ox)/scale;
  const wy=miny+(((clientY-rect.top)/z)-oy)/scale;
  const {w:SW,h:SH}=_stageSize();
  view.x=SW/2 - wx*view.k;
  view.y=SH/2 - wy*view.k;
  applyView();
}

/* ============================================================
   BREADCRUMB - clickable path from root to the selected node.
   Hidden by default; expands while hovering the overview chip
   in the status bar (visibility handled by syncBreadcrumb).
   ============================================================ */
function updateBreadcrumb(){
  const bc=_breadcrumbEl; if(!bc) return;
  if(!map || !sel || !map.nodes[sel]){ if(bc._prevHtml){ bc.innerHTML=''; bc._prevHtml=''; } bc._has=false; syncBreadcrumb(); return; }
  const path=[]; let cur=sel, guard=0;
  while(cur && guard++<200){ path.unshift(cur); cur=map.nodes[cur]?.parent; }
  if(path.length<=1){ if(bc._prevHtml){ bc.innerHTML=''; bc._prevHtml=''; } bc._has=false; syncBreadcrumb(); return; }   // nothing to show at the root
  bc._has=true;
  const html=path.map((id,i)=>{
    const label=nodeTextPlain(map.nodes[id].text||'')||'(untitled)';
    const short=label.length>22 ? label.slice(0,22)+'…' : label;
    const crumb=`<button class="bc-crumb${id===sel?' current':''}" data-id="${id}" title="${escapeHtml(label)}">${escapeHtml(short)}</button>`;
    return crumb + (i<path.length-1 ? '<span class="bc-sep">›</span>' : '');
  }).join('');
  // render() runs on every interaction; skip the innerHTML write (and the
  // per-crumb listener re-attach) when the path hasn't changed.
  if(html!==bc._prevHtml){
    bc._prevHtml=html;
    bc.innerHTML=html;
    bc.querySelectorAll('.bc-crumb').forEach(b=>b.onclick=()=>{ select(b.dataset.id,false); centreOn(b.dataset.id); });
  }
  syncBreadcrumb();
}
function syncBreadcrumb(){
  const bc=_breadcrumbEl; if(!bc) return;
  // Classic shell (as upstream): the breadcrumb is always visible once the
  // selection has a path; the modern shell expands it only while hovering
  // the overview chip in the status bar, and focus mode hides the overview
  // so it stays tucked away there too.
  const classic = document.body.classList.contains('ui-classic') || document.body.classList.contains('ui-rail') || document.body.classList.contains('ui-zen');
  const show = !!bc._has && (classic ? !document.body.classList.contains('focus-mode') : !!bc._ov);
  bc.classList.toggle('shown', show);
}
// Overview chip: hovering it (or tabbing into its controls) expands the breadcrumb.
(function(){
  const ov=$('#overview'); if(!ov) return;
  const set=v=>{ const bc=_breadcrumbEl; if(bc) bc._ov=v; syncBreadcrumb(); };
  ov.addEventListener('mouseenter',()=>set(true));
  ov.addEventListener('mouseleave',()=>set(false));
  ov.addEventListener('focusin',()=>set(true));
  ov.addEventListener('focusout',()=>set(false));
})();

/* ============================================================
   MAPS - list / create / load / delete
   ============================================================ */
// Per-map "⋮" menu (Duplicate / Delete) for the sidebar - one open at a time,
// closes on outside click / scroll / blur. Frees row width for the map title.
let _rowPop=null, _rowPopOut=null;
function closeRowMenu(){
  if(_rowPop){ try{ _rowPop.remove(); }catch(_){} _rowPop=null; }
  if(_rowPopOut){
    document.removeEventListener('mousedown', _rowPopOut, true);
    window.removeEventListener('scroll', closeRowMenu, true);
    window.removeEventListener('blur', closeRowMenu);
    _rowPopOut=null;
  }
}
// Shared: position a fixed .row-pop portal below its trigger button,
// right-aligned to the owning row, flipped above when out of room, clamped
// to the viewport with an 8px margin (all divided by UI zoom). Used by
// openRowMenu / openSharedRowMenu / openSharedByMeRowMenu.
function positionRowPop(pop, btn){
  const rb = btn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const _z=_uiZ();
  const row = btn.closest('.map-item') || btn.parentElement;
  const rowRect = row.getBoundingClientRect();
  let left = rowRect.right - pr.width - 4;
  let top = rb.bottom + 2;
  if((rb.bottom + pr.height)/_z + 10 > window.innerHeight){ top = rb.top - pr.height - 2; pop.classList.add('flip-up'); }
  const margin=8;
  if(left < margin) left = margin;
  if(left + pr.width > window.innerWidth - margin) left = window.innerWidth - pr.width - margin;
  if(top < margin) top = margin;
  if(top + pr.height > window.innerHeight - margin) top = window.innerHeight - pr.height - margin;
  pop.style.left = (left/_z)+'px';
  pop.style.top = (top/_z)+'px';
  pop.style.visibility='';
}

function openRowMenu(btn, m){
  if(_rowPop && _rowPop._for===m.id){ closeRowMenu(); return; }   // toggle off
  if(typeof closeAllMenus==='function') closeAllMenus();
  closeRowMenu();
  const pop=document.createElement('div'); pop.className='row-pop'; pop._for=m.id;
  pop.innerHTML='<button data-a="pin"><span class="rp-ic">\uD83D\uDCCC</span>'+(m.pinned?'Unpin':'Pin')+'</button>'+
                '<button data-a="dup"><span class="rp-ic">\u2398</span>Duplicate</button>'+
                '<button data-a="del" class="danger"><span class="rp-ic">\uD83D\uDDD1</span>Delete</button>';
  // Portal to body with fixed positioning - escapes overflow clipping of .side-scroll
  // (like Notion/VS Code context menus) and stays above .side-foot.
  pop.style.visibility='hidden'; pop.style.left='-9999px'; pop.style.top='-9999px';
  document.body.appendChild(pop);
  positionRowPop(pop, btn);
  pop.querySelector('[data-a="pin"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); togglePin(m.id); };
  pop.querySelector('[data-a="dup"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); duplicateMap(m.id); };
  pop.querySelector('[data-a="del"]').onclick=async ev=>{ ev.stopPropagation(); closeRowMenu();
    if(!confirm('Delete "'+(m.title||'Untitled')+'"?')) return;
    await Store.remove(m.id);
    if(map && map.id===m.id){ map=null; render(); }
    refreshList(); toast('Map deleted');
  };
  _rowPop=pop;
  _rowPopOut=(e)=>{ if(_rowPop && (!e || e.type!=='mousedown' || !_rowPop.contains(e.target))) closeRowMenu(); };
  setTimeout(()=>{
    document.addEventListener('mousedown', _rowPopOut, true);
    window.addEventListener('scroll', closeRowMenu, true);
    window.addEventListener('blur', closeRowMenu);
  },0);
}
async function refreshList(){
  let idx=[];
  try{ idx=await Store.list(); }catch(e){ idx=[]; }
  // Merge the current in-memory map so title edits / new maps appear immediately
  // (don't wait for the debounced save to hit the database). Shared maps (_cloudView)
  // are NOT owned - they belong in "Shared with me", never in "Your maps".
  if(map && !map._cloudView){
    const local={id:map.id, title:map.title, color:map.color, updated:map.updated||Date.now(), pinned:map.pinned||undefined};
    const at=idx.findIndex(m=>m.id===map.id);
    if(at>=0) idx[at]={...idx[at], ...local};
    else idx.unshift(local);
  }
  // Pinned maps first, then most-recently-updated.
  idx.sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || (b.updated||0)-(a.updated||0));
  const list=$('#mapList'); list.innerHTML='';
  (idx||[]).forEach(m=>{
    const el=document.createElement('div');
    el.className='map-item'+(map&&m.id===map.id?' active':'')+(m.pinned?' pinned':'');
    el.innerHTML=`<span class="dot" style="background:${m.color||'#e0613a'}"></span><span class="nm">${escapeHtml(m.title||'Untitled')}</span><button class="row-menu" title="More" aria-haspopup="true" aria-label="More actions">\u22ee</button>`;
    el.style.cursor='pointer';
    el.onclick=()=>{ if(!map || map.id!==m.id) loadMap(m.id); };
    el.querySelector('.row-menu').onclick=ev=>{ ev.stopPropagation(); openRowMenu(ev.currentTarget, m); };
    list.appendChild(el);
  });
  // Shared maps: one list combining maps you've shared OUT (you're the owner) and maps
  // shared WITH you (you're a guest), deduped by room. Opening connects to the LIVE copy.
  const _byMe=_sharedByMeStore(), _withMe=_sharedStore();
  const _seen=new Set(); const _unified=[];
  _byMe.forEach(x=>{ const room=x.room||x.id; if(!room||_seen.has(room)) return; _seen.add(room);
    _unified.push({ room, token:x.token, title:x.title, color:x.color, addedAt:x.addedAt, mine:true }); });
  _withMe.forEach(x=>{ const room=x.id; if(!room) return;
    if(_seen.has(room)){ try{ _saveSharedStore(_sharedStore().filter(e=>e.id!==room)); }catch(e){} return; }  // self-heal an old double-filing
    _seen.add(room);
    _unified.push({ room, token:x.token, title:x.title, color:x.color, addedAt:x.addedAt, mine:false }); });
  if(_unified.length){
    const hdr=document.createElement('div'); hdr.className='map-group-label'; hdr.textContent='Shared maps';
    list.appendChild(hdr);
    _unified.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).forEach(sm=>{
      const activeShared=(map && map._cloudView===sm.room) || (map && map.id==='shared-'+sm.room);
      const el=document.createElement('div');
      el.className='map-item shared-row'+(activeShared?' active':'');
      const badge = sm.mine
        ? '<span class="shared-badge" title="Shared by you">\uD83D\uDD17</span>'
        : '<span class="shared-badge" title="'+(sm.token?'Shared with you \u00b7 editable':'Shared with you \u00b7 view only')+'">'+(sm.token?'\u270F\uFE0F':'\uD83D\uDC41')+'</span>';
      el.innerHTML='<span class="dot" style="background:'+(sm.color||'#e0613a')+'"></span>'+
        '<span class="nm">'+escapeHtml(sm.title||'Shared map')+'</span>'+badge+
        '<button class="row-menu" title="More" aria-haspopup="true" aria-label="More actions">\u22ee</button>';
      el.style.cursor='pointer';
      el.onclick=()=>{ if(!(map && map._cloudView===sm.room)) openSharedInPlace(sm.room, sm.token); };
      el.querySelector('.row-menu').onclick=ev=>{ ev.stopPropagation(); openSharedRowMenu(ev.currentTarget, sm); };
      list.appendChild(el);
    });
  }
}
function escapeHtml(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

// Pin/unpin a map so it stays at the top of the sidebar (works on any map, not
// only the open one). Pin state lives on the map and is mirrored into the index.
async function togglePin(id){
  const target = (map && map.id===id) ? map : await Store.get(id);
  if(!target){ toast('Could not open map'); return; }
  const now = !target.pinned;
  if(now) target.pinned = true; else delete target.pinned;
  try{ await Store.save(target); }
  catch(e){ toast('Could not update pin'); return; }
  if(map && map.id===id){ if(now) map.pinned=true; else delete map.pinned; }
  refreshList();
  toast(now ? 'Pinned to top' : 'Unpinned');
}

/* ---------- Rich-text Notes editor popup ---------- */
function showNotesEditor(nodeId){
  document.querySelectorAll('.notes-popup').forEach(p=>p.remove());
  if(!map||!map.nodes[nodeId]) return;
  const n=map.nodes[nodeId];
  const popup=document.createElement('div');
  popup.className='notes-popup';
  const has=(n.notes||'').replace(/<[^>]*>/g,'').trim().length>0;
  popup.innerHTML=`
    <div class="np-toolbar">
      <button data-c="bold"          title="Bold"><b>B</b></button>
      <button data-c="italic"        title="Italic"><i>i</i></button>
      <button data-c="strikeThrough" title="Strikethrough"><s>S</s></button>
      <div class="np-div"></div>
      <button data-c="h1"            title="Heading 1">H1</button>
      <button data-c="h2"            title="Heading 2">H2</button>
      <div class="np-div"></div>
      <button data-c="insertUnorderedList" title="Bullet list">•≡</button>
      <button data-c="insertOrderedList"   title="Numbered list">1≡</button>
      <div class="np-div"></div>
      <button data-c="createLink"  title="Insert link">🔗</button>
      <button data-c="unlink"      title="Remove link">⊘🔗</button>
      <button data-c="removeFormat" title="Clear formatting">⨯</button>
    </div>
    <div class="np-editor" contenteditable="true" data-placeholder="Type your notes - Markdown-style formatting available via the toolbar."></div>
    <div class="np-actions">
      ${has?'<button class="np-clear">Remove</button>':''}
      <button class="np-cancel">Cancel</button>
      <button class="np-save primary">Save</button>
    </div>`;
  const r=stage.getBoundingClientRect(), z=_uiZ();
  // r.left/width/top are raw px (scale with UI-level display size); style.left/top are
  // read as logical px, so divide through by the same factor _stageSize()/_stagePoint()
  // already use before mixing them with the (logical) -240/70 constants below.
  popup.style.left = (r.left/z + r.width/z/2 - 240) + 'px';
  popup.style.top  = (r.top/z  + 70) + 'px';
  document.body.appendChild(popup);
  popup.addEventListener('mousedown',e=>e.stopPropagation());
  const editor=popup.querySelector('.np-editor');
  editor.innerHTML = sanitizeNotes(n.notes||'');   // safe: inert-parsed, whitelisted
  editor.focus();
  // Place cursor at end
  const range=document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const s=getSelection(); s.removeAllRanges(); s.addRange(range);

  popup.querySelectorAll('.np-toolbar button').forEach(btn=>{
    btn.addEventListener('mousedown',e=>e.preventDefault());  // keep selection
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const c=btn.dataset.c;
      if(c==='h1'||c==='h2'){ execCmd('formatBlock', '<'+c+'>'); }
      else if(c==='createLink'){
        const url=prompt('Enter URL (https://…):'); if(url) execCmd('createLink',url);
      }
      else { execCmd(c); }
      editor.focus();
    });
  });

  const close=()=>popup.remove();
  const save=()=>{
    // Robust sanitize (inert parse + tag/attr whitelist) before storing.
    const html=sanitizeNotes(editor.innerHTML);
    const plain=html.replace(/<[^>]*>/g,'').trim();
    if(plain) map.nodes[nodeId].notes=html; else delete map.nodes[nodeId].notes;
    pushHistory(); render(); close();
  };
  popup.querySelector('.np-save').onclick=save;
  popup.querySelector('.np-cancel').onclick=close;
  popup.querySelector('.np-clear')?.addEventListener('click',()=>{
    delete map.nodes[nodeId].notes; pushHistory(); render(); close();
  });
  editor.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); save(); }
  });
}

/* ============================================================
   PROMPT TEMPLATES - see templates.js, loaded before this file.
   TEMPLATES and TEMPLATE_CATEGORIES are defined there; the
   functions that use them stay here.
   ============================================================ */
async function createMapFromTemplate(templateId){
  if(!leaveLiveForSwitch()) return;
  const tpl = TEMPLATES[templateId];
  if(!tpl){ createMap(); return; }
  const id = uid();
  const keyToId = {};      // template key -> real uid
  const nodes = {};
  let rootId = null;
  tpl.nodes.forEach(n => {
    const nid = uid();
    keyToId[n.k] = nid;
    if(!n.parent) rootId = nid;
  });
  // Optional per-node fields a template may set to showcase features.
  const OPT = ['notes','image','ref','citation','fontSize','bold','italic',
    'underline','strike','textColor','highlight','align','listType','collapsed','width','height',
    'html','frontmatter','raw','lang','marker'];
  tpl.nodes.forEach(n => {
    const nid = keyToId[n.k];
    const node = {
      id: nid,
      text: n.text,
      parent: n.parent ? keyToId[n.parent] : null,
      x: 0, y: 0,
      side: n.parent ? null : 'root',   // unsided → balanced by weight below
      color: n.color || '#fff'
    };
    if(n.task) node.task = n.task;       // carry task state
    OPT.forEach(f => { if(n[f] !== undefined) node[f] = n[f]; });
    nodes[nid] = node;
  });
  // Cross-links (template keys → real ids), skipping any that don't resolve.
  const links = Array.isArray(tpl.links)
    ? tpl.links.filter(l => keyToId[l.from] && keyToId[l.to])
               .map(l => ({ from: keyToId[l.from], to: keyToId[l.to] }))
    : [];
  const _tplLayout = (typeof tpl.layout === 'string' && tpl.layout) ? tpl.layout : 'balanced';
  const _engineOk = typeof LAYOUT_ENGINES !== 'undefined' ? LAYOUT_ENGINES.includes(_tplLayout) : true;
  const _layout = _engineOk ? _tplLayout : 'balanced';
  map = { id, title: tpl.name, titleAuto: false, color: tpl.color, layout: _layout, rootId, nodes, links };
  sel = rootId; history = []; hpos = -1;
  if(_layout === 'balanced') balanceRootSides();        // split top-level branches evenly left/right (only for balanced)
  pushHistory();
  $('#mapTitle').value = map.title;
  autoLayout(); fit();
  if(tabsEnabled){ openMapInTab(map); scheduleSave(); return; }   // new map opens as a tab
  scheduleSave(); refreshList();
}

// ===== Map duplication =====
async function duplicateMap(id){
  let src = (map && map.id===id) ? map : null;
  if(!src){ try{ src = await Store.get(id); }catch(e){} }
  if(!src){ toast('Could not duplicate'); return; }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.title = (src.title||'Untitled') + ' (copy)';
  copy.titleAuto = false;
  copy.updated = Date.now();
  await Store.save(copy);
  await loadMap(copy.id);
  refreshList();
  toast('Map duplicated');
}

// ===== Save current map as a reusable template =====
function saveAsTemplate(){
  if(!map){ return; }
  const name = (prompt('Name this template:', map.title||'My template')||'').trim();
  if(!name) return;
  const idToK = {}; let i=0;
  Object.keys(map.nodes).forEach(nid=>{ idToK[nid] = (nid===map.rootId) ? 'root' : ('n'+(i++)); });
  const nodes = Object.values(map.nodes).map(n=>{
    const o = { k: idToK[n.id], text: nodeTextPlain(n.text)||'' };
    if(n.parent) o.parent = idToK[n.parent];
    if(n.task) o.task = n.task;
    return o;
  });
  const tpl = { id:'user_'+uid(), name, desc:'Your saved template', color: map.color||'#e0613a', group:'mine', icon:'⭐', nodes, _user:true };
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store.push(tpl);
  try{ localStorage.setItem('mindspark:userTemplates', JSON.stringify(store)); }catch(e){ toast('Could not save (storage full?)'); return; }
  loadUserTemplates();
  toast('Saved to "My templates"');
}
function deleteUserTemplate(tid){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store = store.filter(t=>t.id!==tid);
  localStorage.setItem('mindspark:userTemplates', JSON.stringify(store));
  delete TEMPLATES[tid];
  if(!store.length){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
// Merge user templates from localStorage into the in-memory catalog.
function loadUserTemplates(){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){ store=[]; }
  // Drop any previously-merged user templates so we don't duplicate on re-call
  Object.keys(TEMPLATES).forEach(k=>{ if(TEMPLATES[k]&&TEMPLATES[k]._user) delete TEMPLATES[k]; });
  store.forEach(t=>{ TEMPLATES[t.id]=t; });
  const hasCat = TEMPLATE_CATEGORIES.some(c=>c.id==='mine');
  if(store.length && !hasCat){
    TEMPLATE_CATEGORIES.push({ id:'mine', label:'My templates', icon:'⭐', color:'#c98a1a' });
  } else if(!store.length && hasCat){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
// Close every top-level menu/popover so only one is ever open at once.
function closeAllMenus(){
  document.querySelectorAll('.tpl-pop, .export-pop').forEach(p=>{ try{p.remove();}catch(_){} });
  if(typeof closeRowMenu==='function') closeRowMenu();
  try{ if(typeof closeThemePanel==='function') closeThemePanel(); }catch(_){}
  if(typeof activePicker!=='undefined' && activePicker){ try{activePicker.remove();}catch(_){} activePicker=null; }
}
function showTemplatesMenu(){
  if(document.querySelector('.tpl-pop')){ closeAllMenus(); return; }      // click again closes it
  closeAllMenus();
  const pop = document.createElement('div');
  pop.className = 'tpl-pop';
  document.body.appendChild(pop);
  pop.addEventListener('mousedown', e => e.stopPropagation());
  // Stop clicks inside the popover from reaching the document-level
  // outside-click handler - otherwise drilling into a category (which
  // rebuilds innerHTML and detaches the clicked button) would be seen as
  // an "outside" click and close the menu.
  pop.addEventListener('click', e => e.stopPropagation());

  const place = () => {
    // Anchor under the "New mind map" row, constrained to the viewport.
    const row = document.querySelector('.new-map-row') || $('#newMapMenu');
    positionPopup(pop, row);
  };
  const close = () => pop.remove();

  // ----- root view: blank + category list -----
  const renderRoot = () => {
    pop.innerHTML = `
      <div class="tpl-head">Start from a template</div>
      <button class="tpl-item" data-act="blank">
        <span class="tpl-ic" style="background:#e0613a">✕</span>
        <span><b>Blank map</b><i>Just a root node</i></span>
      </button>
      <div class="tpl-divider"></div>
      ${TEMPLATE_CATEGORIES.map(c=>{
        const count = Object.values(TEMPLATES).filter(t=>(t.group||'prompt')===c.id).length;
        return `<button class="tpl-item tpl-cat" data-cat="${c.id}">
            <span class="tpl-ic" style="background:${c.color}">${c.icon}</span>
            <span><b>${escapeHtml(c.label)}</b><i>${count} template${count===1?'':'s'}</i></span>
            <span class="tpl-chev">›</span>
          </button>`;
      }).join('')}`;
    pop.querySelector('[data-act="blank"]').onclick = () => { close(); createMap(); };
    pop.querySelectorAll('.tpl-cat').forEach(b => b.onclick = () => renderCategory(b.dataset.cat));
    place();
  };

  // ----- category view: back + that category's templates -----
  const renderCategory = (catId) => {
    const cat = TEMPLATE_CATEGORIES.find(c=>c.id===catId);
    const entries = Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===catId);
    pop.innerHTML = `
      <button class="tpl-back" data-act="back">‹ All categories</button>
      <div class="tpl-head" style="padding-top:2px">${escapeHtml(cat.label)}</div>
      ${entries.map(([id,t])=>`
        <button class="tpl-item" data-id="${id}">
          <span class="tpl-ic" style="background:${t.color}">${t.icon || '?'}</span>
          <span><b>${escapeHtml(t.name)}</b><i>${escapeHtml(t.desc)}</i></span>
          ${t._user?`<span class="tpl-del" data-del="${id}" title="Delete template">×</span>`:''}
        </button>`).join('')}`;
    pop.querySelector('[data-act="back"]').onclick = renderRoot;
    pop.querySelectorAll('.tpl-item[data-id]').forEach(b => b.onclick = (e) => {
      if(e.target.classList.contains('tpl-del')){
        e.stopPropagation();
        deleteUserTemplate(e.target.dataset.del);
        renderCategory(catId);   // refresh; back to root if category now empty
        if(!TEMPLATE_CATEGORIES.some(c=>c.id===catId)) renderRoot();
        return;
      }
      close(); createMapFromTemplate(b.dataset.id);
    });
    place();
  };

  renderRoot();
  setTimeout(() => document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)){ close(); document.removeEventListener('click', cl); }
  }), 0);
}
function createMap(){
  if(!leaveLiveForSwitch()) return;
  exitSharedMode();
  const id=uid(); const rid=uid();
  const rootText='Central Idea';
  const m={id,title:rootText,titleAuto:true,color:PALETTE[Math.floor(Math.random()*PALETTE.length)],rootId:rid,
    nodes:{[rid]:{id:rid,text:rootText,parent:null,x:0,y:0,side:'root',color:'#fff'}}};
  // Show it immediately - never wait on the network to render the UI.
  flushPendingSave();
  map=m; sel=rid; history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value=map.title;
  autoLayout();
  if(tabsEnabled){ openMapInTab(map); scheduleSave(); return; }   // tabbed workspace: new map opens as its own tab
  // Default new maps to 100% zoom, centred on the root
  view.k=1;
  const {w:sw,h:sh}=_stageSize();
  const rn=map.nodes[rid];
  view.x = sw/2 - (rn.x + (rn.w||120)/2);
  view.y = sh/2 - (rn.y + (rn.h||50)/2);
  applyView(); _markStage();
  scheduleSave();          // persist to the database in the background
  refreshList();
  setTimeout(()=>startEdit(rid),120);
}
async function loadMap(id){
  if(!leaveLiveForSwitch()) return;
  exitSharedMode();            // if we were viewing a shared map, leave it cleanly
  let m=null;
  try{ m=await Store.get(id); }catch(e){ toast('Could not load map'); return false; }
  if(!m){ toast('Map not found'); return false; }
  // Legacy migration: old maps may still store `comment` - promote it to `notes`
  for(const n of Object.values(m.nodes||{})){
    if(n.comment && !n.notes){
      n.notes = '<p>'+escapeHtml(n.comment).replace(/\n/g,'<br>')+'</p>';
      delete n.comment;
    }
  }
  flushPendingSave();          // persist the outgoing map's pending edit to itself
  if(tabsEnabled){ openMapInTab(m); return true; }   // tabbed workspace: open (or switch to) a tab
  map=m; sel=map.rootId;
  const _imported = !!map._import; if(_imported) delete map._import;
  // Initialise history WITHOUT triggering a save - loading is not a change,
  // so the sidebar order (sorted by `updated`) must not be reshuffled.
  history=[JSON.stringify({nodes:map.nodes,rootId:map.rootId,title:map.title,color:map.color})];
  hpos=0; updateUndo();
  $('#mapTitle').value=map.title;
  if(_imported){ balanceRootSides(); autoLayout(); }
  render();
  // Restore this map's saved camera if it has one; otherwise preserve the
  // session zoom across switches; otherwise auto-fit a fresh map.
  const saved=loadMapView(map.id);
  if(saved && !_imported){ applyMapView(saved); }
  else if(userZoom!=null && !_imported){ view.k=userZoom; recenter(); }
  else fit();
  refreshList();
  if(mdMode) syncTextFromMap();   // keep the Markdown editor in sync when switching maps
  return true;
}

/* ---------- title ---------- */
$('#mapTitle').addEventListener('input',e=>{
  if(!map) return;
  map.title=e.target.value;
  map.titleAuto=false;          // user took control - stop mirroring the root text
  if(_tabActive>=0 && _tabs[_tabActive]) _tabs[_tabActive].title=e.target.value;   // keep the tab label live
  const tt=document.querySelector('#tabRow .tab.active .tab-title'); if(tt) tt.textContent=e.target.value||'Untitled';
  scheduleSave(); refreshList();
});

/* ---------- autosave ---------- */
function scheduleSave(){
  if(!map || READONLY || map._ephemeral) return;   // live-session guest map is not persisted to a repo
  if(map._cloudEdit){ scheduleCloudSave(); return; }   // shared cloud map saves back to the Durable Object
  const target = map;          // bind THIS map: switching maps before the timer
  _pendingSaveMap = target;    // fires must NOT redirect the write onto another map
  $('#savePill').classList.add('saving'); $('#saveText').textContent='Saving…';
  clearTimeout(saveTimer);
  // Cloud mode talks to GitHub - debounce longer to stay well under 5000 req/h
  const delay = (MODE==='cloud') ? 1500 : 600;
  saveTimer=setTimeout(async()=>{
    saveTimer=null;
    try{
      await Store.save(target);
      if(_pendingSaveMap===target) _pendingSaveMap=null;
      $('#savePill').classList.remove('saving'); $('#saveText').textContent='Saved';
    }catch(e){
      $('#savePill').classList.remove('saving'); $('#saveText').textContent='Retrying…';
      // The map was copied to local storage before the network write, so the
      // edit isn't lost. Tell the user plainly and retry once after a short wait.
      toast((MODE==='cloud')
        ? 'Couldn’t sync to GitHub just now - your changes are saved on this device and will retry.'
        : 'Couldn’t reach the server - your changes are saved on this device and will retry.');
      setTimeout(async()=>{
        try{ await Store.save(target); if(_pendingSaveMap===target) _pendingSaveMap=null; $('#savePill').classList.remove('saving'); $('#saveText').textContent='Saved'; }
        catch(e2){ $('#saveText').textContent='Save failed'; }
      }, 4000);
    }
  },delay);
}
// Commit any pending debounced edit to ITS OWN map right now - call before
// switching maps so the write lands on the map that was edited, never on the
// one just opened (which would reorder/overwrite it).
function flushPendingSave(){
  if(!saveTimer) return;
  clearTimeout(saveTimer); saveTimer=null;
  const target=_pendingSaveMap; _pendingSaveMap=null;
  if(target && !READONLY){ Promise.resolve().then(()=>Store.save(target)).catch(()=>{}); }
}

/* ============================================================
   EXPORT  (JSON + PNG via manual canvas render)
   ============================================================ */
function exportMenu(){
  if(document.querySelector('.export-pop')){ closeAllMenus(); return; }   // click again closes it
  closeAllMenus();
  const pop=document.createElement('div');
  pop.className='export-pop';
  const _collabItems = collabAvailable() ? `
    <button data-a="collab"><span class="ex-ic">👥</span><span><b>Collaborate live</b><i>Real-time editing - share an invite link</i></span></button>
    <button data-a="cloudshare"><span class="ex-ic">☁</span><span><b>Cloud share (editable)</b><i>Publish + copy an edit link collaborators can save to</i></span></button>
    <button data-a="manageaccess"><span class="ex-ic">🔐</span><span><b>Manage access</b><i>Named collaborators &amp; link permissions</i></span></button>` : '';
  pop.innerHTML=`
    <div class="ex-grp">Share &amp; collaborate</div>
    <button data-a="share"><span class="ex-ic">🔗</span><span><b>Copy share link</b><i>Read-only view, no account needed</i></span></button>${_collabItems}
    <div class="ex-grp">Tools</div>
    <button data-a="history"><span class="ex-ic">🕘</span><span><b>Version history</b><i>Browse & restore past versions</i></span></button>
    <button data-a="present"><span class="ex-ic">▶</span><span><b>Presentation mode</b><i>Step through the map one topic at a time</i></span></button>
    <button data-a="buildprompt"><span class="ex-ic">✨</span><span><b>Compile subtree → prompt</b><i>Assemble the selected branch into a prompt</i></span></button>
    <div class="ex-grp">Export</div>
    <button data-a="png"   ><span class="ex-ic">🖼</span><span><b>PNG image</b><i>Themed export, honors map style</i></span></button>
    <button data-a="prompt"><span class="ex-ic">⚡</span><span><b>Export as prompt</b><i>Fill variables, then copy clean text</i></span></button>
    <button data-a="mdrich"><span class="ex-ic">📝</span><span><b>Markdown</b><i>Formatting, tasks, tables, code</i></span></button>
    <button data-a="copy"  ><span class="ex-ic">⎘</span><span><b>Copy as text (clipboard)</b><i>Plain outline, no download</i></span></button>
    <button data-a="word"  ><span class="ex-ic">📄</span><span><b>Word document (.doc)</b><i>Opens in Word, Google Docs, LibreOffice</i></span></button>
    <button data-a="mermaid"><span class="ex-ic">🧜</span><span><b>Mermaid diagram</b><i>Renders in GitHub, Notion, Obsidian</i></span></button>
    <button data-a="refs"><span class="ex-ic">📖</span><span><b>References list</b><i>All citation nodes, formatted</i></span></button>
    <div class="ex-grp">Manage</div>
    <button data-a="duplicate"><span class="ex-ic">⎘</span><span><b>Duplicate this map</b><i>Make an editable copy</i></span></button>
    <button data-a="astemplate"><span class="ex-ic">⭐</span><span><b>Save as template</b><i>Reuse this structure for new maps</i></span></button>
    <button data-a="json"  ><span class="ex-ic">{}</span><span><b>JSON file</b><i>Full backup, re-importable</i></span></button>
    <div class="ex-grp">Import</div>
    <button data-a="import"><span class="ex-ic">↑</span><span><b>Import file</b><i>JSON, OPML, or Markdown outline</i></span></button>`;
  document.body.appendChild(pop);
  // Side-toolbar layout: fly out to the right of the vertical rail (VS Code / Figma
  // pattern) rather than dropping below the narrow 46px bar, which would be
  // clamped to the viewport edge and appear detached.
  const _isRail = document.body.classList.contains('ui-rail') && !window.matchMedia('(max-width: 720px)').matches;
  positionPopup(pop, $('#menuExport'), _isRail ? {side:'right'} : {align:'right'});
  pop.addEventListener('mousedown',e=>e.stopPropagation());
  const close=()=>pop.remove();
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)) { close(); document.removeEventListener('click', cl); }
  }), 0);
  pop.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    const a=b.dataset.a; close();
    if(a==='share') copyShareLink();
    if(a==='collab'){ if(collabAvailable()) Collab.startHost(); else toast('Live collaboration needs the hosted app'); }
    if(a==='cloudshare'){ if(collabAvailable()) publishSharedMap(); else toast('Cloud share needs the hosted app'); }
    if(a==='manageaccess'){ if(collabAvailable()) openAccessPanel(); else toast('Managing access needs the hosted app'); }
    else if(a==='history') showVersionHistory();
    else if(a==='present') startPresentation();
    else if(a==='buildprompt') showBuildPrompt(sel || (map&&map.rootId));
    else if(a==='png') exportPNG();
    else if(a==='prompt') exportAsPrompt();
    else if(a==='mdrich') exportMarkdown(false, true);
    else if(a==='copy') exportMarkdown(true);
    else if(a==='word') exportDoc();
    else if(a==='mermaid') exportMermaid();
    else if(a==='refs') exportReferences();
    else if(a==='duplicate') duplicateMap(map.id);
    else if(a==='astemplate') saveAsTemplate();
    else if(a==='json') exportJSON();
    else if(a==='import') importJSON();
  });
}

/* ============================================================
   Version history - browse and restore past saves of the current map.
   Cloud mode: real GitHub commit history of the map's file.
   Server mode: SQLite snapshots taken on each content change.
   ============================================================ */
let _historyPreview = null;   // {original} while previewing a past version
function relTime(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+' min ago';
  if(s<86400) return Math.floor(s/3600)+' h ago';
  const d=Math.floor(s/86400);
  if(d<30) return d+' day'+(d===1?'':'s')+' ago';
  return new Date(ts).toLocaleDateString();
}
async function showVersionHistory(){
  if(!map){ toast('Open a map first'); return; }
  if(typeof Store.history !== 'function'){ toast('History not available'); return; }
  document.querySelectorAll('.hist-panel,.export-pop').forEach(p=>p.remove());
  const panel=document.createElement('div');
  panel.className='hist-panel';
  panel.innerHTML=`<div class="hist-head"><b>Version history</b><button class="hist-x" title="Close">×</button></div>
    <div class="hist-list"><div class="hist-status">Loading…</div></div>`;
  document.body.appendChild(panel);
  panel.addEventListener('mousedown',e=>e.stopPropagation());
  panel.querySelector('.hist-x').onclick=()=>{ cancelHistoryPreview(); panel.remove(); };
  const list=panel.querySelector('.hist-list');
  const mapId=map.id;
  let versions=[];
  try{ versions=await Store.history(mapId); }catch(e){ versions=[]; }
  if(!versions || !versions.length){
    list.innerHTML=`<div class="hist-status">No earlier versions yet.<br><span class="hist-sub">Versions are recorded each time the map changes${MODE==='cloud'?' (your GitHub commit history)':''}. Make an edit, then check back.</span></div>`;
    return;
  }
  list.innerHTML = versions.map((v,i)=>`
    <div class="hist-row" data-ref="${escapeHtml(String(v.ref!=null?v.ref:v.ts))}">
      <div class="hist-when"><b>${i===0?'Latest':relTime(v.ts)}</b><i>${new Date(v.ts).toLocaleString()}</i></div>
      <div class="hist-actions">
        <button class="hist-prev">Preview</button>
        <button class="hist-diff">Diff</button>
        <button class="hist-restore${i===0?' disabled':''}"${i===0?' disabled':''}>Restore</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.hist-row').forEach(row=>{
    const ref=row.dataset.ref;
    row.querySelector('.hist-prev').onclick=()=>previewVersion(mapId, ref, row);
    row.querySelector('.hist-diff').onclick=()=>diffVersion(mapId, ref);
    const rb=row.querySelector('.hist-restore');
    if(rb && !rb.disabled) rb.onclick=()=>restoreVersion(mapId, ref);
  });
}
// Compute node-level changes between an older map snapshot and a newer one.
function diffMaps(oldMap, newMap){
  const O=(oldMap&&oldMap.nodes)||{}, N=(newMap&&newMap.nodes)||{};
  const plain=t=>nodeTextPlain(t||'').replace(/\s+/g,' ').trim();
  const added=[], removed=[], changed=[];
  for(const id in N){ if(!(id in O)) added.push(plain(N[id].text)); }
  for(const id in O){ if(!(id in N)) removed.push(plain(O[id].text)); }
  for(const id in N){ if(id in O){ const a=plain(O[id].text), b=plain(N[id].text); if(a!==b) changed.push({from:a,to:b}); } }
  return {added, removed, changed};
}
async function diffVersion(mapId, ref){
  const data=await Store.version(mapId, ref);
  if(!data){ toast('Could not load that version'); return; }
  const past=normalizeLoadedMap(data);
  const current=_historyPreview ? _historyPreview.original : map;   // real current map
  showDiffPanel(diffMaps(past, current));
}
function showDiffPanel(d){
  document.querySelectorAll('.diff-panel').forEach(p=>p.remove());
  const e=escapeHtml;
  const sec=(title,items,cls)=> !items.length ? '' :
    `<div class="diff-sec"><div class="diff-h ${cls}">${title} (${items.length})</div>`+
    items.map(it=> typeof it==='string'
      ? `<div class="diff-row ${cls}">${e(it||'(empty)')}</div>`
      : `<div class="diff-row chg"><span class="d-from">${e(it.from||'(empty)')}</span><span class="d-arrow">\u2192</span><span class="d-to">${e(it.to||'(empty)')}</span></div>`
    ).join('')+`</div>`;
  const total=d.added.length+d.removed.length+d.changed.length;
  const panel=document.createElement('div'); panel.className='diff-panel';
  panel.innerHTML=`<div class="diff-head"><b>Changes since this version</b><button class="diff-x" title="Close">\u00d7</button></div>`+
    (total ? sec('Added',d.added,'add')+sec('Removed',d.removed,'del')+sec('Edited',d.changed,'chg')
           : `<div class="diff-empty">No differences - identical to the current map.</div>`);
  document.body.appendChild(panel);
  panel.querySelector('.diff-x').onclick=()=>panel.remove();
}
async function previewVersion(mapId, ref, row){
  const data=await Store.version(mapId, ref);
  if(!data){ toast('Could not load that version'); return; }
  if(!_historyPreview) _historyPreview={ original: JSON.parse(JSON.stringify(map)) };
  map = normalizeLoadedMap(data);
  render(); fit();
  document.querySelectorAll('.hist-row').forEach(r=>r.classList.remove('active'));
  row?.classList.add('active');
  showPreviewBanner(mapId, ref);
}
function showPreviewBanner(mapId, ref){
  document.querySelectorAll('.hist-banner').forEach(b=>b.remove());
  const b=document.createElement('div');
  b.className='hist-banner';
  b.innerHTML=`<span>👁 Previewing an earlier version (read-only)</span>
    <button class="hb-restore">Restore this version</button>
    <button class="hb-cancel">Back to current</button>`;
  document.body.appendChild(b);
  b.querySelector('.hb-restore').onclick=()=>restoreVersion(mapId, ref);
  b.querySelector('.hb-cancel').onclick=()=>{ cancelHistoryPreview(); };
}
function cancelHistoryPreview(){
  document.querySelectorAll('.hist-banner').forEach(b=>b.remove());
  if(_historyPreview){ map=_historyPreview.original; _historyPreview=null; render(); fit(); }
}
async function restoreVersion(mapId, ref){
  const data=await Store.version(mapId, ref);
  if(!data){ toast('Could not load that version'); return; }
  const restored=normalizeLoadedMap(data);
  restored.id=mapId;                 // keep identity
  restored.updated=Date.now();
  _historyPreview=null;
  map=restored;
  history=[]; hpos=-1; pushHistory();   // restored state becomes a fresh undo baseline
  render(); fit();
  try{ await Store.save(map); }catch(e){ console.warn('save after history restore failed:', e.message); toast('Restored, but saving failed - changes are local only'); }
  document.querySelectorAll('.hist-banner,.hist-panel').forEach(p=>p.remove());
  refreshList();
  toast('Version restored');
}
// Normalize a loaded/decoded map object to the current shape (defensive defaults).
function normalizeLoadedMap(m){
  return { id:m.id, title:m.title||'Untitled map', titleAuto:!!m.titleAuto, color:m.color||'#e0613a',
           rootId:m.rootId, style:m.style, layout:m.layout||'balanced',
           nodes:m.nodes||{}, links:m.links||[], vars:m.vars||{} };
}

/* ============================================================
   Build prompt from branch - assemble the selected subtree into a clean,
   structured prompt; copy it, or (optional, bring-your-own-key) run it
   against an LLM API and drop the answer back as child nodes.
   ============================================================ */
function assemblePrompt(rootId){
  if(!map || !map.nodes[rootId]) return '';
  const lines=[];
  const walk=(id, depth)=>{
    const n=map.nodes[id]; if(!n) return;
    const txt=nodeTextPlain(n.text||'').replace(/\n/g,' ').trim();
    const indent='  '.repeat(depth);
    if(depth===0){ lines.push(txt); }
    else { lines.push(`${indent}- ${txt}`); }
    const note=(n.notes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    if(note) lines.push(`${indent}  (${note})`);
    childrenOf(id).forEach(c=>walk(c, depth+1));
  };
  walk(rootId, 0);
  // Substitute any {{variables}} the map already has values for.
  let out=lines.join('\n');
  const vars=map.vars||{};
  out=out.replace(/\{\{(\w+)\}\}/g,(m,k)=> (vars[k]!=null && String(vars[k]).trim()!=='') ? vars[k] : m);
  return out;
}
const LLM_PROVIDERS = {
  anthropic: {
    label:'Anthropic (Claude)', url:'https://api.anthropic.com/v1/messages',
    defaultModel:'claude-3-5-sonnet-latest',
    headers:(key)=>({'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}),
    body:(model,prompt)=>JSON.stringify({model, max_tokens:1024, messages:[{role:'user',content:prompt}]}),
    extract:(d)=> (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()
  },
  openai: {
    label:'OpenAI', url:'https://api.openai.com/v1/chat/completions',
    defaultModel:'gpt-4o-mini',
    headers:(key)=>({'content-type':'application/json','Authorization':'Bearer '+key}),
    body:(model,prompt)=>JSON.stringify({model, messages:[{role:'user',content:prompt}]}),
    extract:(d)=> (d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content||'').trim()
  }
};
function showBuildPrompt(nodeId){
  if(!map){ toast('Open a map first'); return; }
  nodeId = nodeId && map.nodes[nodeId] ? nodeId : map.rootId;
  document.querySelectorAll('.bp-panel,.export-pop').forEach(p=>p.remove());
  const prompt=assemblePrompt(nodeId);
  const provider=localStorage.getItem('mindspark:llm:provider')||'anthropic';
  const model=localStorage.getItem('mindspark:llm:model:'+provider) || LLM_PROVIDERS[provider].defaultModel;
  const tok=estimateTokens(prompt,'');
  const panel=document.createElement('div');
  panel.className='bp-panel';
  panel.innerHTML=`
    <div class="bp-head"><b>Build prompt from “${escapeHtml(nodeTextPlain(map.nodes[nodeId].text||'').slice(0,40)||'branch')}”</b><button class="bp-x" title="Close">×</button></div>
    <textarea class="bp-text" spellcheck="false">${escapeHtml(prompt)}</textarea>
    <div class="bp-meta"><span class="bp-tok">~${tok} tokens</span></div>
    <div class="bp-row">
      <button class="bp-copy primary">Copy prompt</button>
      <button class="bp-toggle">Run with API ▾</button>
    </div>
    <div class="bp-run" style="display:none">
      <div class="bp-run-row">
        <select class="bp-provider">
          ${Object.entries(LLM_PROVIDERS).map(([k,v])=>`<option value="${k}"${k===provider?' selected':''}>${v.label}</option>`).join('')}
        </select>
        <input class="bp-model" placeholder="model" value="${escapeHtml(model)}">
      </div>
      <input class="bp-key" type="password" placeholder="API key (stored only in this browser)" value="${escapeHtml(localStorage.getItem('mindspark:llm:key:'+provider)||'')}">
      <div class="bp-warn">⚠ Your key is stored in this browser's localStorage and sent directly to the provider. Use a scoped key; don't use this on a shared machine.</div>
      <button class="bp-send primary">Send →</button>
      <div class="bp-result" style="display:none"></div>
    </div>`;
  document.body.appendChild(panel);
  panel.addEventListener('mousedown',e=>e.stopPropagation());
  const $$=s=>panel.querySelector(s);
  $$('.bp-x').onclick=()=>panel.remove();
  $$('.bp-copy').onclick=()=>{ navigator.clipboard?.writeText($$('.bp-text').value).then(()=>toast('Prompt copied'),()=>toast('Copy failed')); };
  $$('.bp-toggle').onclick=()=>{ const r=$$('.bp-run'); r.style.display = r.style.display==='none'?'block':'none'; };
  const provSel=$$('.bp-provider'), modelIn=$$('.bp-model'), keyIn=$$('.bp-key');
  provSel.onchange=()=>{ const pv=provSel.value;
    modelIn.value=localStorage.getItem('mindspark:llm:model:'+pv)||LLM_PROVIDERS[pv].defaultModel;
    keyIn.value=localStorage.getItem('mindspark:llm:key:'+pv)||''; };
  $$('.bp-send').onclick=async()=>{
    const pv=provSel.value, key=keyIn.value.trim(), mdl=modelIn.value.trim()||LLM_PROVIDERS[pv].defaultModel;
    if(!key){ toast('Enter an API key'); return; }
    localStorage.setItem('mindspark:llm:provider',pv);
    localStorage.setItem('mindspark:llm:model:'+pv,mdl);
    localStorage.setItem('mindspark:llm:key:'+pv,key);
    const res=$$('.bp-result'); res.style.display='block'; res.textContent='Running…';
    const send=$$('.bp-send'); send.disabled=true;
    try{
      const cfg=LLM_PROVIDERS[pv];
      const r=await fetch(cfg.url,{method:'POST',headers:cfg.headers(key),body:cfg.body(mdl,$$('.bp-text').value)});
      if(!r.ok){ const t=await r.text(); throw new Error('HTTP '+r.status+' - '+t.slice(0,200)); }
      const data=await r.json();
      const answer=cfg.extract(data)||'(empty response)';
      res.innerHTML='';
      const pre=document.createElement('div'); pre.className='bp-answer'; pre.textContent=answer;
      const acts=document.createElement('div'); acts.className='bp-answer-acts';
      const cp=document.createElement('button'); cp.textContent='Copy answer';
      cp.onclick=()=>navigator.clipboard?.writeText(answer).then(()=>toast('Answer copied'));
      const add=document.createElement('button'); add.className='primary'; add.textContent='Add as child nodes';
      add.onclick=()=>{ addResponseAsNodes(nodeId, answer); panel.remove(); toast('Added to map'); };
      acts.appendChild(cp); acts.appendChild(add);
      res.appendChild(pre); res.appendChild(acts);
    }catch(e){
      res.textContent='Error: '+e.message;
    } finally { send.disabled=false; }
  };
}
// Turn an LLM answer into child nodes under `parentId`. Top-level bullet/numbered
// lines become separate children; otherwise the whole answer becomes one node.
function addResponseAsNodes(parentId, answer){
  if(!map || !map.nodes[parentId]) return;
  const lines=answer.split('\n').map(l=>l.trim()).filter(Boolean);
  const bullets=lines.filter(l=>/^([-*•]|\d+[.)])\s+/.test(l));
  const mk=(text, notes)=>{
    const id=uid();
    map.nodes[id]={ id, text:text.slice(0,200), parent:parentId, x:0, y:0, side:null, color:'#fff', created:Date.now() };
    if(notes) map.nodes[id].notes='<p>'+escapeHtml(notes).replace(/\n/g,'<br>')+'</p>';
  };
  if(bullets.length>=2 && bullets.length>=lines.length*0.5){
    bullets.forEach(b=>mk(b.replace(/^([-*•]|\d+[.)])\s+/,'')));
  } else {
    const title=lines[0]||'AI response';
    mk(title.length>60?title.slice(0,60)+'…':title, answer);
  }
  autoLayout(); pushHistory(); scheduleSave();
}

/* ============================================================
   Presentation mode - step through the map one node at a time.
   ============================================================ */
let _pres = null;   // {order, idx, collapsed} while presenting
function startPresentation(){
  if(!map || !map.nodes[map.rootId]){ toast('Open a map first'); return; }
  document.querySelectorAll('.export-pop').forEach(p=>p.remove());
  // Expand everything so the whole map is walkable; remember what to restore.
  const wasCollapsed = Object.keys(map.nodes).filter(id=>map.nodes[id].collapsed);
  wasCollapsed.forEach(id=>map.nodes[id].collapsed=false);
  // Depth-first order from the root → walks branch by branch.
  const order=[];
  const walk=id=>{ order.push(id); childrenOf(id).forEach(walk); };
  walk(map.rootId);
  _pres={ order, idx:0, collapsed:wasCollapsed };
  document.body.classList.add('presenting');
  autoLayout();
  const bar=document.createElement('div');
  bar.className='pres-bar';
  bar.innerHTML=`<button class="pres-prev" title="Previous (←)">◀</button>
    <span class="pres-count"></span>
    <span class="pres-title"></span>
    <button class="pres-next" title="Next (→ / Space)">▶</button>
    <button class="pres-exit" title="Exit (Esc)">✕</button>`;
  document.body.appendChild(bar);
  bar.addEventListener('mousedown',e=>e.stopPropagation());
  bar.querySelector('.pres-prev').onclick=()=>presStep(-1);
  bar.querySelector('.pres-next').onclick=()=>presStep(1);
  bar.querySelector('.pres-exit').onclick=()=>endPresentation();
  document.addEventListener('keydown', presKey, true);
  presGo(0);
}
function presKey(e){
  if(!_pres) return;
  if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){ e.preventDefault(); e.stopPropagation(); presStep(1); }
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){ e.preventDefault(); e.stopPropagation(); presStep(-1); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); endPresentation(); }
}
function presStep(d){ if(!_pres) return; presGo(Math.max(0, Math.min(_pres.order.length-1, _pres.idx+d))); }
function presGo(i){
  if(!_pres) return;
  _pres.idx=i;
  const id=_pres.order[i];
  document.querySelectorAll('.node.pres-current').forEach(el=>el.classList.remove('pres-current'));
  const el=document.querySelector(`.node[data-id="${id}"]`);
  if(el) el.classList.add('pres-current');
  // Comfortable fixed zoom, centred on the current node.
  view.k=Math.min(1.1, Math.max(view.k, 0.9));
  centreOn(id);
  const bar=document.querySelector('.pres-bar');
  if(bar){
    bar.querySelector('.pres-count').textContent=`${i+1} / ${_pres.order.length}`;
    bar.querySelector('.pres-title').textContent=nodeTextPlain(map.nodes[id]?.text||'')||'(untitled)';
    bar.querySelector('.pres-prev').disabled = i===0;
    bar.querySelector('.pres-next').disabled = i===_pres.order.length-1;
  }
}
function endPresentation(){
  if(!_pres) return;
  document.removeEventListener('keydown', presKey, true);
  document.querySelectorAll('.pres-bar').forEach(b=>b.remove());
  document.querySelectorAll('.node.pres-current').forEach(el=>el.classList.remove('pres-current'));
  document.body.classList.remove('presenting');
  // Restore collapse state (presentation never persists changes).
  (_pres.collapsed||[]).forEach(id=>{ if(map.nodes[id]) map.nodes[id].collapsed=true; });
  _pres=null;
  autoLayout(); fit();
}

function exportJSON(){
  const blob=new Blob([JSON.stringify(map,null,2)],{type:'application/json'});
  download(blob,(map.title||'mindmap')+'.json'); toast('JSON exported');
}
function importJSON(){ importFile(); }   // back-compat alias
// ---- GitMind (.gmind) import ----------------------------------------------
// A .gmind file is a ZIP archive containing content.json (GitMind's nested tree).
// Read the ZIP via its central directory; inflate DEFLATE entries with the native
// DecompressionStream. No external dependency.
async function _gmindUnzip(buf, prefer){
  const dv=new DataView(buf), bytes=new Uint8Array(buf);
  let eocd=-1;
  for(let i=bytes.length-22; i>=0; i--){ if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('Not a valid .gmind file (no ZIP directory)');
  const cdCount=dv.getUint16(eocd+10,true), cdOffset=dv.getUint32(eocd+16,true);
  const files={}; let p=cdOffset;
  for(let n=0;n<cdCount;n++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true);
    const compSize=dv.getUint32(p+20,true);
    const nameLen=dv.getUint16(p+28,true), extraLen=dv.getUint16(p+30,true), commentLen=dv.getUint16(p+32,true);
    const localOff=dv.getUint32(p+42,true);
    const name=new TextDecoder().decode(bytes.subarray(p+46, p+46+nameLen));
    const lhNameLen=dv.getUint16(localOff+26,true), lhExtraLen=dv.getUint16(localOff+28,true);
    const dataStart=localOff+30+lhNameLen+lhExtraLen;
    files[name]={method, comp:bytes.subarray(dataStart, dataStart+compSize)};
    p += 46+nameLen+extraLen+commentLen;
  }
  const key=(prefer && Object.keys(files).find(k=>k.toLowerCase().endsWith(prefer)))
    || Object.keys(files).find(k=>/(^|\/)content\.json$/i.test(k))
    || Object.keys(files).find(k=>/\.json$/i.test(k));
  if(!key) throw new Error('No content.json found inside the .gmind file');
  const f=files[key]; let out;
  if(f.method===0){ out=f.comp; }
  else if(f.method===8){
    const stream=new Response(f.comp).body.pipeThrough(new DecompressionStream('deflate-raw'));
    out=new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error('Unsupported compression in .gmind (method '+f.method+')');
  return new TextDecoder('utf-8').decode(out);
}
// GitMind stores rich text as HTML. Fold block elements to line breaks and run it
// through our inline sanitizer so formatting survives but nothing dangerous does.
function gmindHtmlToInline(html, plain){
  if(!html) return plain!=null ? String(plain) : '';
  let s=String(html).replace(/<\/(p|div)>/gi,'<br>').replace(/<(p|div)[^>]*>/gi,'');
  s=s.replace(/(\s*<br\s*\/?>\s*)+$/i,'');   // trim trailing breaks
  return sanitizeInlineHTML(s);
}
function convertGmindToMap(d, filename){
  const rootNode = d.root || (d.data || d.children ? d : (d.body && (d.body.root||d.body)) || d);
  if(!rootNode) throw new Error('Unrecognized .gmind structure');
  const nodes={}; const links=[]; let counter=0; const newId=()=>'g'+(counter++);
  let rootId=null;
  const applyStyle=(n, style)=>{
    if(!style) return;
    const fs=parseInt(style.fontSize,10); if(fs) n.fontSize=fs;
    if(style.fontWeight==='bold' || +style.fontWeight>=600) n.bold=true;
    if(/italic/i.test(style.fontStyle||'')) n.italic=true;
    const td=style.textDecoration||style.textDecorationLine||'';
    if(/underline/i.test(td)) n.underline=true;
    if(/line-through/i.test(td)) n.strike=true;
    if(style.color) n.textColor=style.color;
  };
  const walk=(g, parentId, isRoot)=>{
    const data=g.data||{};
    const id=newId();
    const plain = data.text!=null ? String(data.text) : '';
    const n={ id, parent:parentId, x:0, y:0,
      text: data.html ? gmindHtmlToInline(data.html, plain) : plain };
    const kids = Array.isArray(g.children) ? g.children : [];
    if(kids.length && !isRoot) n.collapsed = (data.expanded===false);
    if(data.image){ const im=data.image; const url = typeof im==='string'?im:(im.url||im.src||''); if(url) n.image=url; }
    applyStyle(n, g.style);
    nodes[id]=n;
    if(isRoot){
      rootId=id; n.side='root';
      const split = (data.mindLayoutSplitIndex!=null) ? data.mindLayoutSplitIndex : Math.ceil(kids.length/2);
      kids.forEach((c,i)=>{ const cid=walk(c, id, false); nodes[cid].side = i<split ? 'right' : 'left'; });
    } else {
      kids.forEach(c=> walk(c, id, false));
    }
    return id;
  };
  walk(rootNode, null, true);
  const title = (rootId && nodes[rootId]) ? nodeTextPlain(nodes[rootId].text) : '';
  return { id:uid(), title: title || (filename||'Imported').replace(/\.gmind$/i,''),
           titleAuto:false, color:'#e0613a', rootId, nodes, links, vars:{} };
}
async function parseGmind(buf, filename){
  const jsonText = await _gmindUnzip(buf);
  let d; try{ d=JSON.parse(jsonText); }catch(e){ throw new Error('.gmind content.json is not valid JSON'); }
  return convertGmindToMap(d, filename);
}

// ---- MindMeister (.mind) import -------------------------------------------
// A .mind file is a ZIP wrapping map.json: a nested tree whose node text lives in
// `title`, with `note` / `link` / `image` fields and a flat `connections` list.
function mindTitleToText(title){
  if(title==null) return '';
  const t=String(title).replace(/\r\n?/g,'\n');
  // Preserve intra-title line breaks as <br> (titles can contain hard wraps).
  return t.indexOf('\n')>=0 ? t.split('\n').map(escapeHtml).join('<br>') : t;
}
function convertMindToMap(d, filename){
  const root = d.root || d;
  if(!root || !root.children && root.title==null) throw new Error('Unrecognized .mind structure');
  const nodes={}; const links=[]; let counter=0; const newId=()=>'m'+(counter++);
  const idMap={}; let rootId=null;
  const th=d.theme||{};
  const bg=(th.root_style&&th.root_style.backgroundColor)||(th.background&&th.background.color)||'';
  const themeColor = /^#?[0-9a-f]{6}$/i.test(bg) ? ('#'+bg.replace(/^#/,'')) : '#5b8db2';
  const applyStyle=(n, style)=>{
    if(!style) return;
    if(style.bold) n.bold=true;
    if(style.italic) n.italic=true;
    const fs=parseInt(style.fontSize,10); if(fs) n.fontSize=fs;
    if(style.color && /^#?[0-9a-f]{6}$/i.test(style.color)) n.textColor='#'+String(style.color).replace(/^#/,'');
  };
  const walk=(g, parentId, isRoot)=>{
    const id=newId();
    if(g.id!=null) idMap[g.id]=id;
    const kids = Array.isArray(g.children) ? g.children : [];
    const n={ id, parent:parentId, x:0, y:0, text: mindTitleToText(g.title) };
    const note=g.note!=null ? String(g.note).trim() : '';
    if(note && note!=='-') n.notes = sanitizeNotes(note.replace(/\r\n?/g,'\n').replace(/\n/g,'<br>'));
    if(g.link){ const url=String(g.link); n.notes=(n.notes||'')+`<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`; }
    if(g.image){ const im=g.image; const url=typeof im==='string'?im:(im.url||im.src||''); if(url) n.image=url; }
    applyStyle(n, g.style);
    nodes[id]=n;
    if(isRoot){
      rootId=id; n.side='root';
      const half=Math.ceil(kids.length/2);
      kids.forEach((c,i)=>{ const cid=walk(c,id,false); nodes[cid].side = i<half?'right':'left'; });
    } else {
      kids.forEach(c=>walk(c,id,false));
    }
    return id;
  };
  walk(root, null, true);
  (Array.isArray(d.connections)?d.connections:[]).forEach(c=>{
    const a=idMap[c.from!=null?c.from:c.source_id], b=idMap[c.to!=null?c.to:c.target_id];
    if(a && b && a!==b) links.push({from:a, to:b});
  });
  const title = (rootId && nodes[rootId]) ? nodeTextPlain(nodes[rootId].text) : '';
  return { id:uid(), title: title || (filename||'Imported').replace(/\.mind$/i,''),
           titleAuto:false, color:themeColor, rootId, nodes, links, vars:{} };
}
async function parseMind(buf, filename){
  const jsonText = await _gmindUnzip(buf, 'map.json');
  let d; try{ d=JSON.parse(jsonText); }catch(e){ throw new Error('.mind map.json is not valid JSON'); }
  return convertMindToMap(d, filename);
}
function fmAttr(el, name){
  // FreeMind attributes are all-caps in the wild (TEXT, FOLDED, COLOR,
  // POSITION, LINK...) but a few exporters write them lowercase; match either.
  const v=el.getAttribute(name)
    ?? el.getAttribute(name.toUpperCase())
    ?? el.getAttribute(name.toLowerCase());
  return v==null ? '' : v;
}
function fmHtmlToInline(html){
  // FreeMind richcontent wraps its HTML in <html><body>; strip those, then
  // reuse the GitMind conversion (block folding + inline sanitizer).
  return gmindHtmlToInline(String(html).replace(/^[\s\S]*?<body[^>]*>/i,'').replace(/<\/body>[\s\S]*$/i,''), '');
}
function convertFreemindToMap(doc, filename){
  const mapEl=doc.documentElement;
  if(!mapEl || String(mapEl.tagName).toLowerCase()!=='map'){
    throw new Error('Unrecognized .mm structure (expected <map> with <node> children)');
  }
  const topLevel=[...mapEl.children].filter(el=>String(el.tagName).toLowerCase()==='node');
  if(!topLevel.length) throw new Error('Unrecognized .mm structure (no <node> found)');
  const nodes={}; const links=[]; let counter=0; const newId=()=>'f'+(counter++);
  let rootId=null;
  const nodeText=(el)=>{
    const rc=[...el.children].find(c=>String(c.tagName).toLowerCase()==='richcontent'
      && fmAttr(c,'type').toUpperCase()==='NODE');
    if(rc) return fmHtmlToInline(rc.innerHTML);
    const plain=fmAttr(el,'text');
    return plain.indexOf('\n')>=0 ? plain.split('\n').map(escapeHtml).join('<br>') : plain;
  };
  const applyStyle=(n, el)=>{
    const textColor=fmAttr(el,'color');
    if(/^#?[0-9a-f]{6}$/i.test(textColor)) n.textColor='#'+textColor.replace(/^#/,'');
    const bg=fmAttr(el,'background_color');
    if(/^#?[0-9a-f]{6}$/i.test(bg)) n.color='#'+bg.replace(/^#/,'');
    if(String(fmAttr(el,'folded')).toLowerCase()==='true') n.collapsed=true;
    const font=[...el.children].find(c=>String(c.tagName).toLowerCase()==='font');
    if(font){
      const fs=parseInt(fmAttr(font,'size'),10); if(fs) n.fontSize=fs;
      if(String(fmAttr(font,'bold')).toLowerCase()==='true') n.bold=true;
      if(String(fmAttr(font,'italic')).toLowerCase()==='true') n.italic=true;
    }
    const link=fmAttr(el,'link');
    if(/^(https?|ftp|mailto):/i.test(link)){
      n.notes=(n.notes||'')+`<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;
    }
    const note=[...el.children].find(c=>String(c.tagName).toLowerCase()==='richcontent'
      && fmAttr(c,'type').toUpperCase()==='NOTE');
    if(note){
      const noteText = note.querySelector('html') ? fmHtmlToInline(note.innerHTML) : note.textContent;
      if(noteText && noteText.trim()) n.notes=(n.notes||'')+sanitizeNotes(noteText.replace(/\n/g,'<br>'));
    }
  };
  const walk=(el, parentId, isRoot)=>{
    const id=newId();
    const n={ id, parent:parentId, x:0, y:0, text:nodeText(el) };
    applyStyle(n, el);
    nodes[id]=n;
    const kids=[...el.children].filter(c=>String(c.tagName).toLowerCase()==='node');
    if(isRoot){
      rootId=id; n.side='root';
      const split=Math.ceil(kids.length/2);
      kids.forEach((c,i)=>{
        const cid=walk(c,id,false);
        const p=String(fmAttr(c,'position')).toLowerCase();
        nodes[cid].side = p==='left'||p==='right' ? p : (i<split?'right':'left');
      });
    } else {
      kids.forEach(c=> walk(c,id,false));
    }
    return id;
  };
  let title;
  if(topLevel.length===1){
    walk(topLevel[0], null, true);
    title = nodeTextPlain(nodes[rootId].text);
  } else {
    // Multiple top-level nodes (allowed by FreeMind): wrap them under a
    // synthetic root so the map still has exactly one.
    rootId=newId();
    nodes[rootId]={ id:rootId, parent:null, x:0, y:0, text:escapeHtml((filename||'Imported').replace(/\.mm$/i,'')), side:'root' };
    const half=Math.ceil(topLevel.length/2);
    topLevel.forEach((el,i)=>{ const cid=walk(el,rootId,false); nodes[cid].side = i<half?'right':'left'; });
    title='';
  }
  return { id:uid(), title: title || (filename||'Imported').replace(/\.mm$/i,''),
           titleAuto:false, color:'#e0613a', rootId, nodes, links, vars:{} };
}
function parseFreemind(text, filename){
  let doc;
  try{ doc=new DOMParser().parseFromString(text, 'application/xml'); }
  catch(e){ throw new Error('Not a valid .mm (FreeMind XML) file'); }
  if(doc.querySelector('parsererror')) throw new Error('Not a valid .mm (FreeMind XML) file');
  return convertFreemindToMap(doc, filename);
}

function importFile(){
  const inp=document.createElement('input');
  inp.type='file';
  inp.accept='.json,.opml,.xml,.md,.markdown,.txt,.gmind,.mind,.mm';
  inp.onchange=async()=>{
    const f=inp.files[0]; if(!f) return;
    const name=(f.name||'').toLowerCase();
    try{
      let m, preserveState=false;
      if(name.endsWith('.gmind')){
        // Binary ZIP - read as bytes, not text. GitMind carries its own
        // expanded/collapsed state, so don't force-collapse afterwards.
        m=await parseGmind(await f.arrayBuffer(), f.name);
        preserveState=true;
      } else if(name.endsWith('.mind')){
        // MindMeister ZIP (map.json). No reliable collapse state in the export,
        // so fall through to the default collapse-to-overview below.
        m=await parseMind(await f.arrayBuffer(), f.name);
      } else if(name.endsWith('.mm')){
        // FreeMind XML carries its own folded state.
        m=parseFreemind(await f.text(), f.name);
        preserveState=true;
      } else {
        const t=await f.text();
        if(name.endsWith('.json')) { m=JSON.parse(t); }
        else if(name.endsWith('.opml')||name.endsWith('.xml')) { m=parseOPML(t, f.name); }
        else { m=parseMarkdownOutline(t, f.name); }   // .md, .markdown, .txt
      }
      if(!m || !m.nodes || !m.rootId) throw new Error('No recognizable outline');
      // Start collapsed so the user sees a clean top-level overview (unless the
      // format already carries its own expand state, e.g. .gmind).
      if(!preserveState){
        Object.keys(m.nodes).forEach(id=>{
          if(id !== m.rootId) m.nodes[id].collapsed = true;
        });
      }
      m.id=uid();
      await Store.save(m);
      await loadMap(m.id);
      // Imported nodes have no positions (all at 0,0) - lay them out into a
      // proper tree, then frame the result.
      autoLayout(); fit();
      refreshList();
      toast('Imported '+f.name + (preserveState?'':' (collapsed - click ＋ to expand)'));
    }catch(e){ console.error(e); alert('Could not import this file:\n'+e.message); }
  };
  inp.click();
}
// Convert basic inline markdown (**bold**, *italic*, ~~strike~~) to our HTML.
function mdInlineToHtml(t){
  const hasHtml = INLINE_HTML_RE.test(t);    // raw inline HTML (<b>, <sub>, <a>, ...) present?
  const hasMd = /!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|(?:^|[^*])\*[^*]+\*|~~[^~]+~~|`[^`]+`|(?:^|[^!])\[[^\]]+\]\([^)]+\)/.test(t);
  if(!hasHtml && !hasMd) return t;            // plain text stays plain
  // keep any raw formatting HTML (sanitized) rather than escaping it to literal text
  let s = hasHtml ? sanitizeInlineHTML(t) : escapeHtml(t);
  // Code spans are masked out before the other inline rules run, and restored verbatim
  // afterward, so their content is never itself reinterpreted as further formatting -
  // matches standard Markdown precedence (`**not bold**` stays literal text inside a code
  // span, not a bold run). A later regex pass over the same string can't tell "this asterisk
  // is inside a <code> tag" apart from any other, so wrapping alone isn't enough - the
  // content has to be out of the string entirely while those passes run.
  const codeSlots=[];
  s = s.replace(/`([^`]+)`/g, (m, code) => { codeSlots.push(code); return '\uE010'+(codeSlots.length-1)+'\uE011'; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m,alt,src)=>'<img alt="'+alt.replace(/"/g,'&quot;')+'" src="'+src.replace(/"/g,'&quot;')+'" loading="lazy">');   // inline image
  s = s.replace(/(^|[^!])\[([^\]]+)\]\(([^)]+)\)/g, '$1<a href="$3" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\uE010(\d+)\uE011/g, (m,idx)=>'<code>'+codeSlots[+idx]+'</code>');
  return s;
}
// Inverse of mdInlineToHtml: node HTML -> inline Markdown. Leaves $...$ math source
// verbatim (math is stored as text, not rendered into n.text), so equations round-trip.
function htmlToInlineMd(html){
  if(html==null) return '';
  if(!hasInlineMarkup(html)) return String(html);          // plain text (may hold $...$) - as-is
  const tpl=document.createElement('template'); tpl.innerHTML=html;   // inert parse
  const emit = node => {
    let out='';
    node.childNodes.forEach(ch=>{
      if(ch.nodeType===3){ out += ch.nodeValue; return; }  // text node (keeps $...$, entities decoded)
      if(ch.nodeType!==1) return;
      const tag=ch.tagName.toLowerCase(), inner=emit(ch);
      if(tag==='b'||tag==='strong')                      out+='**'+inner+'**';
      else if(tag==='i'||tag==='em')                     out+='*'+inner+'*';
      else if(tag==='s'||tag==='strike'||tag==='del')    out+='~~'+inner+'~~';
      else if(tag==='code')                              out+='`'+inner+'`';
      else if(tag==='br')                                out+='\n';
      else if(tag==='a'){ const h=ch.getAttribute('href')||''; out += h ? '['+(inner||h)+']('+h+')' : inner; }
      else if(/^(sub|sup|kbd|mark|ins|u|abbr|small)$/.test(tag)){ const at=ch.getAttribute('title'); out += '<'+tag+(at?' title="'+at.replace(/"/g,'&quot;')+'"':'')+'>'+inner+'</'+tag+'>'; }  // no md equivalent -> keep as HTML
      else if(tag==='ul'||tag==='ol'||tag==='li'){ out += '<'+tag+'>'+inner.replace(/\n/g,'<br>')+'</'+tag+'>'; }  // no md list syntax fits inside a single node's text -> keep as HTML (see applyListToSelection); guard against a bare newline (e.g. from an empty <li><br></li>) breaking the single-line Markdown round-trip
      else                                               out+=inner;   // span, div, … -> text only
    });
    return out;
  };
  return emit(tpl.content).replace(/\u00A0/g,' ');
}
// Parse an OPML document into a map.
function parseOPML(text, filename){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Invalid OPML / XML');
  const body = doc.querySelector('body');
  if(!body) throw new Error('OPML has no <body>');
  const title = (doc.querySelector('head > title')?.textContent
               || (filename||'').replace(/\.[^.]+$/, '') || 'Imported').trim();
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  const walk = (outline, parentId, side) => {
    const id = uid();
    const txt = outline.getAttribute('text') || outline.getAttribute('title') || '';
    nodes[id] = { id, text:mdInlineToHtml(txt.trim()), parent:parentId, side, x:0, y:0 };
    const note = outline.getAttribute('_note') || outline.getAttribute('note');
    if(note) nodes[id].notes = escapeHtml(note);
    [...outline.children]
      .filter(c => c.tagName && c.tagName.toLowerCase()==='outline')
      .forEach(child => walk(child, id, side));
  };
  const tops = [...body.children].filter(c => c.tagName && c.tagName.toLowerCase()==='outline');
  tops.forEach((o, i) => walk(o, rootId, i%2 ? 'left' : 'right'));
  return { id:uid(), title, titleAuto:false, color:'#e0613a', rootId, nodes };
}
// Parse a Markdown / plain-text outline (headings and/or nested bullets) into a map.
// Parses simple "key: value" YAML frontmatter lines into an ordered list of {key,value}
// pairs. Not a general YAML parser - frontmatter for things like a Claude Skill (or most
// static-site front matter) is flat key: value pairs, optionally quoted; a continuation
// line (no "key:" prefix, e.g. a wrapped block-scalar description) is appended to the
// previous field's value rather than attempting a full YAML block-scalar parse.
function parseFrontmatterFields(raw){
  const inner = raw.replace(/^---\r?\n/, '').replace(/\r?\n---\s*$/, '');
  const lines = inner.split(/\r?\n/);
  const fields = [];
  for(const line of lines){
    if(!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if(!m){ if(fields.length) fields[fields.length-1].value += ' '+line.trim(); continue; }
    let [, key, value] = m;
    value = value.trim();
    if(value.length>1 && ((value[0]==="'" && value[value.length-1]==="'") || (value[0]==='"' && value[value.length-1]==='"'))){
      value = value.slice(1,-1);
    }
    fields.push({ key, value });
  }
  return fields;
}
function frontmatterFieldsToHtml(fields){
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let h = '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>';
  fields.forEach(f=>{ h += '<tr><td>'+esc(f.key)+'</td><td>'+esc(f.value)+'</td></tr>'; });
  h += '</tbody></table>';
  return h;
}
// Inverse of frontmatterFieldsToHtml: reads a frontmatter table node's rows back into a
// "---\nkey: value\n---" YAML block for export.
function frontmatterNodeToYaml(n){
  const tpl=document.createElement('template'); tpl.innerHTML=n.html||'';
  const rows=[...tpl.content.querySelectorAll('tbody tr')];
  const lines=['---'];
  rows.forEach(tr=>{
    const cells=tr.querySelectorAll('td'); if(cells.length<2) return;
    const key=(cells[0].textContent||'').trim(); if(!key) return;
    let value=(cells[1].textContent||'').trim();
    // Re-quote if the value has characters YAML would otherwise treat specially (colon,
    // leading/trailing whitespace, empty, or a leading character with special YAML meaning).
    if(value==='' || /^\s|\s$/.test(value) || /[:#{}\[\],&*!|>'"%@`]/.test(value)){
      value = "'"+value.replace(/'/g, "''")+"'";
    }
    lines.push(key+': '+value);
  });
  lines.push('---');
  return lines.join('\n');
}
function parseMarkdownOutline(text, filename){
  let _meta=null, _frontmatter=null;
  // Strip a leading <!-- mindspark ... --> comment and a leading YAML --- ... --- block,
  // in whichever order they appear. Looping instead of checking each once matters: if
  // buildMarkdown ever emits them in a different order than expected, a single anchored
  // check would silently stop matching the second block, leaving it to leak into the
  // outline as literal text/nodes instead of being recognized as metadata.
  for(let guard=0; guard<4; guard++){
    const mm = text.match(/^\uFEFF?\s*<!--\s*mindspark\s*\r?\n([\s\S]*?)\r?\n\s*-->\s*\r?\n?/i);
    if(mm){ try{ _meta=JSON.parse(mm[1].trim()); }catch(e){ _meta=null; } text=text.slice(mm[0].length); continue; }
    const fm = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if(fm){ _frontmatter=('---\n'+fm[1].replace(/\s+$/,'')+'\n---'); text=text.slice(fm[0].length); continue; }
    break;
  }
  const title = (filename||'').replace(/\.[^.]+$/, '') || 'Imported';
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  // Frontmatter (a leading YAML block - e.g. a Claude Skill's `name`/`description`, or a
  // static-site page's front matter) becomes a real, visible, editable child node instead of
  // being silently dropped: rendered as a small "Field | Value" table so it's readable at a
  // glance and directly editable, and re-emitted as proper --- YAML --- at the very top of the
  // file when the map is exported back to Markdown (see buildMarkdown / frontmatterNodeToYaml).
  // Inserted into `nodes` before the main parse loop runs so it naturally lands as the first
  // child once the sole-top-level-heading gets promoted to root, below.
  let frontmatterId = null;
  if(_frontmatter){
    frontmatterId = uid();
    const fields = parseFrontmatterFields(_frontmatter);
    nodes[frontmatterId] = { id:frontmatterId, parent:rootId, x:0, y:0, frontmatter:true, html: frontmatterFieldsToHtml(fields) };
  }
  const stack = [{ id:rootId, depth:0 }];
  let sideCounter = 0, lastHeadingDepth = 0, subDepth = null;
  const LIST_WRAP_RE = /^<(ul|ol)>([\s\S]*)<\/\1>$/i;
  const add = (txt, depth, task, extra) => {
    while(stack.length>1 && stack[stack.length-1].depth >= depth) stack.pop();
    const parentId = stack[stack.length-1].id;
    const id = uid();
    let side = 'right';
    if(parentId===rootId) side = (sideCounter++ % 2) ? 'left' : 'right';
    else side = nodes[parentId].side || 'right';
    // A formula ("=SUM(children)", "=2*3*4", ...) is verbatim, code-like content - never run
    // it through inline-markdown scanning, which would happily mangle e.g. the asterisks in
    // "=2*3*4" into a spurious *italic* span.
    const isFormula = txt.trim().startsWith('=');
    let text = isFormula ? txt.trim() : mdInlineToHtml(txt), listType = null;
    const styleProps = {};
    // Peel whole-node style wrapper tags (from buildMarkdown's wrapStyle - <div style=
    // text-align>, <span style=font-size>, <span style=color>, <mark style=background-
    // color>, <u>) from the outside in, extracting each into a discrete node property.
    // Unlike bold/italic/strike (which are fine left as plain embedded <b>/<i>/<s> - purely
    // a rendering concern), fontSize/textColor/highlight/align also feed layout and PDF/
    // canvas export elsewhere, so they need to land back on the node object itself.
    const peelStyle = s => {
      let m, changed = true;
      while(changed){
        changed = false;
        if((m = s.match(/^<div style="text-align:(left|right)">([\s\S]*)<\/div>$/i))){ styleProps.align = m[1].toLowerCase(); s = m[2]; changed = true; }
        else if((m = s.match(/^<span style="font-size:(\d+)px">([\s\S]*)<\/span>$/i))){ styleProps.fontSize = +m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<span style="color:(#[0-9a-fA-F]{3,8})">([\s\S]*)<\/span>$/i))){ styleProps.textColor = m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<mark style="background-color:(#[0-9a-fA-F]{3,8})">([\s\S]*)<\/mark>$/i))){ styleProps.highlight = m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<u>([\s\S]*)<\/u>$/i))){ styleProps.underline = true; s = m[1]; changed = true; }
      }
      return s;
    };
    // A whole-node bulleted/numbered list (multiple lines inside ONE node) has no plain-
    // Markdown equivalent, so buildMarkdown emits it as literal <ul>/<ol><li> HTML instead
    // (already part of the sanitizer's inline-HTML whitelist). Recognize that shape here and
    // unwrap it back into the canvas-native form: listType + <br>-joined line text - a single
    // node/line either way, no separate bookkeeping required.
    if(!isFormula){
      const lm = text.match(LIST_WRAP_RE);
      if(lm){
        const tpl = document.createElement('template'); tpl.innerHTML = lm[2];
        const kids = [...tpl.content.childNodes].filter(c => c.nodeType===1 || (c.nodeType===3 && c.nodeValue.trim()));
        if(kids.length && kids.every(c => c.nodeType===1 && c.tagName.toLowerCase()==='li')){
          text = kids.map(li=>{
            const inner = li.innerHTML;
            // A lone <br> is applyListToSelection's placeholder for an otherwise-empty
            // line (kept so the <li> still has visible height) - treat it as empty here,
            // not as literal content, or joining with <br> below would double it up.
            return /^\s*<br\s*\/?>\s*$/i.test(inner) ? '' : peelStyle(inner);
          }).join('<br>');
          listType = lm[1].toLowerCase()==='ol' ? 'ol' : 'ul';
        }
      } else {
        text = peelStyle(text);
      }
    }
    nodes[id] = { id, text, parent:parentId, side, x:0, y:0 };
    if(listType) nodes[id].listType = listType;
    Object.assign(nodes[id], styleProps);
    if(task) nodes[id].task = task;
    if(extra) Object.assign(nodes[id], extra);
    stack.push({ id, depth });
  };
  const IMG_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;   // [1]=alt [2]=src
  const attachCur = fn => { const c=stack[stack.length-1]; if(c && nodes[c.id]) fn(nodes[c.id]); };
  const attachNotes = html => attachCur(n=>{ n.notes = (n.notes ? n.notes + '\n' : '') + html; });
  const escHtml = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const splitRow = r => { let x=r.trim(); if(x[0]==='|') x=x.slice(1); if(x[x.length-1]==='|') x=x.slice(0,-1); return x.split('|').map(c=>c.trim()); };
  const isTableSep = x => /-/.test(x) && /^[\s|:-]+$/.test(x) && x.includes('|');
  const tableToHtml = rows => {
    const head = splitRow(rows[0]);
    const cell = (c,tag) => '<'+tag+'>'+mdInlineToHtml(c)+'</'+tag+'>';
    let h='<table><thead><tr>'+head.map(c=>cell(c,'th')).join('')+'</tr></thead>';
    const body=rows.slice(2).filter(r=>r.trim());
    if(body.length) h+='<tbody>'+body.map(r=>{ const cs=splitRow(r); return '<tr>'+head.map((_,i)=>cell(cs[i]!=null?cs[i]:'','td')).join('')+'</tr>'; }).join('')+'</tbody>';
    return h+'</table>';
  };
  const L = text.split('\n');
  const base = () => (subDepth!=null ? subDepth : lastHeadingDepth);   // current section container
  const stripWrap = x => x.replace(/^<(?:p|div|center|figure|picture|span|section|article)\b[^>]*>/i,'').replace(/<\/(?:p|div|center|figure|picture|span|section|article)>$/i,'').trim();
  const nextIsBullet = from => { for(let k=from+1;k<L.length;k++){ if(!L[k].trim()) continue; return /^\s*(?:[-*+]|\d+\.)\s+/.test(L[k]); } return false; };
  for(let i=0; i<L.length; i++){
    const line = L[i];
    // Fenced code block -> its own block child node of the nearest heading (renders the code)
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if(fence){
      const ind=fence[1], fch=fence[2][0], flen=fence[2].length, buf=[]; let j=i+1;
      while(j<L.length){ const cl=L[j].match(/^\s*(`{3,}|~{3,})\s*$/); if(cl && cl[1][0]===fch && cl[1].length>=flen) break; buf.push(L[j].startsWith(ind)?L[j].slice(ind.length):L[j]); j++; }
      const lang=fence[3].trim();
      add(lang||'code', base() + 1 + Math.floor(ind.length/2), null, { html:'<pre><code>'+escHtml(buf.join('\n'))+'</code></pre>', lang:lang||'' });
      i=j; continue;   // skip past the closing fence
    }
    // GFM table (header row + separator line) -> its own block child node of the nearest heading
    if(line.includes('|') && line.trim() && i+1<L.length && isTableSep(L[i+1])){
      const ind=(line.match(/^\s*/)||[''])[0].length;
      const rows=[line, L[i+1]]; let j=i+2;
      while(j<L.length && L[j].includes('|') && L[j].trim()){ rows.push(L[j]); j++; }
      add('table', base() + 1 + Math.floor(ind/2), null, { html:tableToHtml(rows) }); i=j-1; continue;
    }
    if(!line.trim()) continue;
    // Multi-line raw HTML block (<table>, <div style=...>, <details>, ...) -> one raw block node
    const htmlOpen = line.match(/^\s*<(table|div|details|figure|blockquote|dl|section)\b/i);
    if(htmlOpen && !new RegExp('</'+htmlOpen[1]+'\\s*>','i').test(line)){
      const tag=htmlOpen[1].toLowerCase(), buf=[line]; let depth=1, j=i+1;
      const openRe=new RegExp('<'+tag+'\\b','gi'), closeRe=new RegExp('</'+tag+'\\s*>','gi');
      while(j<L.length && depth>0){ const ln=L[j]; buf.push(ln); depth += (ln.match(openRe)||[]).length - (ln.match(closeRe)||[]).length; j++; }
      add(tag+' block', base() + 1, null, { html: buf.join('\n'), raw:true });
      i=j-1; continue;
    }
    // Raw HTML <img> (bare, or wrapped in <p>/<a>/<figure>) -> image on the current node
    const rawImg = line.match(/<img\b[^>]*>/i);
    if(rawImg){
      const src=(rawImg[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)||[])[1];
      const alt=(rawImg[0].match(/\balt\s*=\s*["']([^"']*)["']/i)||[])[1];
      if(src) attachCur(n=>{ n.image=src; if(alt) n.imageAlt=alt; });
      continue;
    }
    // Horizontal rule (---, ***, ___) -> separator, not a node
    if(/^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)){ add('', base()+1, null, {hr:true}); continue; }   // horizontal rule -> divider node
    // A bare block wrapper on its own line (<p ...>, </p>, <div>, <center>, <figure>...) -> unwrap (no node)
    if(/^<\/?(?:p|div|center|figure|picture|section|article)\b[^>]*>$/i.test(line.trim())) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ lastHeadingDepth = h[1].length; subDepth = null; add(h[2].trim(), lastHeadingDepth, null, { hlevel:h[1].length }); continue; }
    // Blockquote -> the current node's notes
    const quote = line.match(/^\s*>\s?(.*)$/);
    if(quote){ attachCur(n=>{ n.notes = (n.notes ? n.notes + '\n' : '') + quote[1]; }); continue; }
    // A standalone image line -> attach to the current node (don't make a child)
    const imgLine = line.trim().match(IMG_LINE);
    if(imgLine){ attachCur(n=>{ n.image = imgLine[2]; if(imgLine[1]) n.imageAlt = imgLine[1]; }); continue; }
    const bullet = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if(bullet){
      const indent = bullet[1].replace(/\t/g, '  ').length;
      let body = bullet[2].trim(), task = null;
      const cb = body.match(/^\[([ xX])\]\s+(.*)$/);        // GitHub-style task checkbox
      if(cb){ task = cb[1].toLowerCase()==='x' ? 'done' : 'todo'; body = cb[2].trim(); }
      const bi = body.match(IMG_LINE);                        // a bullet that is only an image
      if(bi){ attachCur(n=>{ n.image = bi[2]; if(bi[1]) n.imageAlt = bi[1]; }); continue; }
      add(body, base() + 1 + Math.floor(indent/2), task);
      continue;
    }
    // A bold-led paragraph immediately followed by a list acts as a sub-heading:
    // it becomes the parent of that list (e.g. "**Editing & canvas**" over its bullets).
    if(nextIsBullet(i)){   // a lead-in line directly above a list -> parent of that list
      add(line.trim(), lastHeadingDepth + 1, null, {para:true});
      subDepth = lastHeadingDepth + 1;
      continue;
    }
    // Plain paragraph: hang under the current section (unwrap a surrounding block tag)
    const para = stripWrap(line.trim());
    if(para) add(para, base() + 1, null, {para:true});   // plain line -> paragraph child (no bullet marker)
  }
  // The filename is the map TITLE, not a node. When the whole document hangs off a
  // single top-level node (the common case: one `# Heading`), promote it to the root
  // and drop the filename wrapper - matching how markmap renders a Markdown file.
  // (The frontmatter node, if any, doesn't count as "real" content for this check - a
  // skill.md with one heading plus its frontmatter should still promote the heading.)
  let finalRoot = rootId;
  const tops = Object.values(nodes).filter(n => n.parent === rootId && n.id !== frontmatterId);
  if(tops.length === 1){
    const promoted = tops[0];
    promoted.parent = null; promoted.side = 'root';
    delete nodes[rootId];
    finalRoot = promoted.id;
    if(frontmatterId) nodes[frontmatterId].parent = finalRoot;
  }
  // Balanced left/right split (each branch kept consistent) so the imported map isn't
  // lopsided - the parser can't call the DOM-bound balanceRootSides().
  const kids = Object.values(nodes).filter(n => n.parent === finalRoot);
  const half = Math.ceil(kids.length / 2);
  const setBranch = (id, side) => { nodes[id].side = side; Object.values(nodes).filter(c => c.parent === id).forEach(c => setBranch(c.id, side)); };
  kids.forEach((k, i) => setBranch(k.id, i < half ? 'right' : 'left'));
  nodes[finalRoot].side = 'root';
  if(_meta && _meta.nodes){
    const kidsOrd = pid => Object.values(nodes).filter(n=>n.parent===pid);   // document order (matches export)
    const applyMeta=(id,path)=>{ const mm=_meta.nodes[path], n=nodes[id];
      if(mm && n){
        if(mm.color) n.color=mm.color; if(mm.textColor) n.textColor=mm.textColor;
        if(mm.w){ n.width=mm.w; n.w=mm.w; } if(mm.h){ n.height=mm.h; n.h=mm.h; }
        if(mm.collapsed) n.collapsed=true;
        if(mm.underline) n.underline=true;   // bold/italic/strike round-trip via visible **/*/~~ syntax instead (see buildMarkdown)
        if(mm.fontSize) n.fontSize=mm.fontSize; if(mm.listType) n.listType=mm.listType;
        if(mm.highlight) n.highlight=mm.highlight; if(mm.align) n.align=mm.align;
        if(mm.image) n.image=mm.image; if(mm.ref) n.ref=true; if(mm.citation) n.citation=mm.citation;
        if(mm.created) n.created=mm.created; if(mm.updated) n.updated=mm.updated;
      }
      kidsOrd(id).forEach((c,i)=>applyMeta(c.id, path+'.'+i));
    };
    applyMeta(finalRoot, '0');
  }
  const out = { id:uid(), title, titleAuto:false, color:(_meta&&_meta.color)||'#e0613a', rootId:finalRoot, nodes };
  if(_frontmatter) out.frontmatter=_frontmatter;
  if(_meta&&_meta.layout) out.layout=_meta.layout;
  if(_meta&&_meta.vars) out.vars=_meta.vars;
  return out;
}

// ============================================================================
// Formula engine: Excel-like calculations for nodes.
//
// A node becomes a "formula" when its (plain) text starts with '='. Supports:
//  - arithmetic: + - * / % ^ (right-assoc), parens, unary +/-
//  - comparisons: < > <= >= == !=  (produce 1/0, usable in IF)
//  - functions: SUM AVERAGE/AVG MIN MAX COUNT ROUND ABS SQRT POW MOD FLOOR
//               CEIL/CEILING TRUNC IF LOG LOG10 EXP PI E
//  - SUM(children) etc: aggregate over the current node's direct children
//  - {Label}: reference another node by label - matches either a bare-number
//    node's full text, or (for the natural "Rent: 1200" mind-map pattern) the
//    part before the colon, so a descriptively-labeled node is both readable
//    AND referenceable from a sibling formula.
//
// Plain (non-formula) node text is still usable as a *value* if it parses as
// a number (optionally with $ / % / thousands separators, or a "Label: n"
// prefix) - so a parent can SUM(children) over a mix of plain numbers and
// sub-formulas, same as Excel treats a bare "42" cell as a number.
// ============================================================================
class FormulaError extends Error {}
const FORMULA_FUNCS = {
  SUM:     args => args.reduce((a,b)=>a+b, 0),
  AVERAGE: args => args.length ? args.reduce((a,b)=>a+b,0)/args.length : 0,
  AVG:     args => FORMULA_FUNCS.AVERAGE(args),
  MIN:     args => { if(!args.length) throw new FormulaError('MIN needs at least one value'); return Math.min(...args); },
  MAX:     args => { if(!args.length) throw new FormulaError('MAX needs at least one value'); return Math.max(...args); },
  COUNT:   args => args.length,
  ROUND:   args => { const x=args[0], n=args.length>1?args[1]:0; const f=Math.pow(10,n); return Math.round(x*f)/f; },
  ABS:     args => Math.abs(args[0]),
  SQRT:    args => { if(args[0]<0) throw new FormulaError('SQRT of a negative number'); return Math.sqrt(args[0]); },
  POW:     args => Math.pow(args[0], args[1]),
  MOD:     args => { if(args[1]===0) throw new FormulaError('Division by zero'); return args[0] % args[1]; },
  FLOOR:   args => Math.floor(args[0]),
  CEIL:    args => Math.ceil(args[0]),
  CEILING: args => Math.ceil(args[0]),
  TRUNC:   args => Math.trunc(args[0]),
  LOG:     args => Math.log(args[0]),
  LOG10:   args => Math.log10(args[0]),
  EXP:     args => Math.exp(args[0]),
};
// Function signatures shown in the formula autocomplete popup.
const FORMULA_FUNC_INFO = [
  {name:'SUM',     sig:'SUM(a, b, ...)',      desc:'Adds up values - try SUM(children)'},
  {name:'AVERAGE', sig:'AVERAGE(a, b, ...)',  desc:'Mean of values - try AVERAGE(children)'},
  {name:'AVG',     sig:'AVG(a, b, ...)',      desc:'Alias for AVERAGE'},
  {name:'MIN',     sig:'MIN(a, b, ...)',      desc:'Smallest value'},
  {name:'MAX',     sig:'MAX(a, b, ...)',      desc:'Largest value'},
  {name:'COUNT',   sig:'COUNT(a, b, ...)',    desc:'How many values'},
  {name:'ROUND',   sig:'ROUND(x, digits)',    desc:'Rounds x to given decimals'},
  {name:'ABS',     sig:'ABS(x)',              desc:'Absolute value'},
  {name:'SQRT',    sig:'SQRT(x)',             desc:'Square root'},
  {name:'POW',     sig:'POW(x, y)',           desc:'x to the power of y'},
  {name:'MOD',     sig:'MOD(x, y)',           desc:'Remainder of x / y'},
  {name:'FLOOR',   sig:'FLOOR(x)',            desc:'Round down'},
  {name:'CEIL',    sig:'CEIL(x)',             desc:'Round up'},
  {name:'TRUNC',   sig:'TRUNC(x)',            desc:'Drop the decimal part'},
  {name:'IF',      sig:'IF(cond, then, else)',desc:'Branches on a condition'},
  {name:'LOG',     sig:'LOG(x)',              desc:'Natural log'},
  {name:'LOG10',   sig:'LOG10(x)',            desc:'Base-10 log'},
  {name:'EXP',     sig:'EXP(x)',              desc:'e to the power of x'},
  {name:'PI',      sig:'PI',                  desc:'3.14159...'},
];
function _formulaTokenize(src){
  const toks=[]; let i=0; const n=src.length;
  while(i<n){
    const c=src[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c==='{'){
      const j=src.indexOf('}', i+1);
      if(j<0) throw new FormulaError('Unclosed { reference');
      toks.push({t:'ref', v:src.slice(i+1,j).trim()}); i=j+1; continue;
    }
    if(/[0-9]/.test(c) || (c==='.' && /[0-9]/.test(src[i+1]||''))){
      let j=i, dot=false;
      while(j<n && (/[0-9]/.test(src[j]) || (src[j]==='.' && !dot))){ if(src[j]==='.') dot=true; j++; }
      toks.push({t:'num', v:parseFloat(src.slice(i,j))}); i=j; continue;
    }
    if(/[A-Za-z_]/.test(c)){
      let j=i; while(j<n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({t:'ident', v:src.slice(i,j)}); i=j; continue;
    }
    if(c==='<' || c==='>' || c==='!'){
      if(src[i+1]==='='){ toks.push({t:'op', v:c+'='}); i+=2; continue; }
      toks.push({t:'op', v:c}); i++; continue;
    }
    if(c==='='){
      if(src[i+1]==='='){ toks.push({t:'op', v:'=='}); i+=2; continue; }
      toks.push({t:'op', v:'=='}); i++; continue;   // lone "=" also means equality inside an expression
    }
    if('+-*/%^'.includes(c)){ toks.push({t:'op', v:c}); i++; continue; }
    if(c==='('){ toks.push({t:'('}); i++; continue; }
    if(c===')'){ toks.push({t:')'}); i++; continue; }
    if(c===','){ toks.push({t:','}); i++; continue; }
    throw new FormulaError('Unexpected character: "'+c+'"');
  }
  toks.push({t:'eof'});
  return toks;
}
function _formulaParse(toks){
  let p=0;
  const peek=()=>toks[p];
  const next=()=>toks[p++];
  function expect(t){ const tok=next(); if(tok.t!==t) throw new FormulaError('Expected "'+t+'"'); return tok; }
  function parseExpression(){ return parseComparison(); }
  function parseComparison(){
    let left=parseAdd();
    const t=peek();
    if(t.t==='op' && ['<','>','<=','>=','==','!='].includes(t.v)){
      next(); const right=parseAdd();
      return {type:'cmp', op:t.v, left, right};
    }
    return left;
  }
  function parseAdd(){
    let node=parseTerm();
    while(peek().t==='op' && (peek().v==='+'||peek().v==='-')){
      const op=next().v; node={type:'bin', op, left:node, right:parseTerm()};
    }
    return node;
  }
  function parseTerm(){
    let node=parseUnary();
    while(peek().t==='op' && (peek().v==='*'||peek().v==='/'||peek().v==='%')){
      const op=next().v; node={type:'bin', op, left:node, right:parseUnary()};
    }
    return node;
  }
  // Unary binds looser than ^ on the left (-2^2 is -(2^2) = -4, the standard math/Python
  // convention - not (-2)^2 = 4), but parsePower's own right-hand (exponent) side still
  // goes through parseUnary so 2^-2 = 0.25 works without needing parens around the -2.
  function parsePower(){
    const base=parsePrimary();
    if(peek().t==='op' && peek().v==='^'){ next(); return {type:'bin', op:'^', left:base, right:parseUnary()}; }
    return base;
  }
  function parseUnary(){
    if(peek().t==='op' && (peek().v==='-'||peek().v==='+')){
      const op=next().v; return {type:'unary', op, arg:parseUnary()};
    }
    return parsePower();
  }
  function parseArg(){
    if(peek().t==='ident' && peek().v.toLowerCase()==='children' && toks[p+1] && toks[p+1].t!=='('){
      next(); return {type:'children'};
    }
    return parseExpression();
  }
  function parsePrimary(){
    const t=peek();
    if(t.t==='num'){ next(); return {type:'num', value:t.v}; }
    if(t.t==='ref'){ next(); return {type:'ref', label:t.v}; }
    if(t.t==='('){ next(); const e=parseExpression(); expect(')'); return e; }
    if(t.t==='ident'){
      next();
      const name=t.v.toUpperCase();
      if(peek().t==='('){
        next();
        const args=[];
        if(peek().t!==')'){
          args.push(parseArg());
          while(peek().t===','){ next(); args.push(parseArg()); }
        }
        expect(')');
        return {type:'call', name, args};
      }
      if(name==='CHILDREN') return {type:'children'};
      return {type:'const', name};
    }
    throw new FormulaError('Unexpected token in formula');
  }
  const ast=parseExpression();
  if(peek().t!=='eof') throw new FormulaError('Unexpected trailing input');
  return ast;
}
function _assertNum(v, where){
  if(v && typeof v==='object' && '__children' in v) throw new FormulaError('children can only be used as a whole function argument, e.g. SUM(children)');
  if(typeof v!=='number' || !isFinite(v)) throw new FormulaError('Expected a number'+(where?(' ('+where+')'):''));
}
function _formulaEval(node, ctx){
  switch(node.type){
    case 'num': return node.value;
    case 'const':
      if(node.name==='PI') return Math.PI;
      if(node.name==='E') return Math.E;
      throw new FormulaError('Unknown name: '+node.name);
    case 'children': return { __children: ctx.children() };
    case 'ref': {
      const v = ctx.resolveRef(node.label);
      if(v==null) throw new FormulaError('Cannot resolve {'+node.label+'}');
      _assertNum(v, '{'+node.label+'}');
      return v;
    }
    case 'unary': {
      const v=_formulaEval(node.arg, ctx); _assertNum(v);
      return node.op==='-' ? -v : v;
    }
    case 'bin': {
      const l=_formulaEval(node.left, ctx), r=_formulaEval(node.right, ctx);
      _assertNum(l); _assertNum(r);
      switch(node.op){
        case '+': return l+r;
        case '-': return l-r;
        case '*': return l*r;
        case '/': if(r===0) throw new FormulaError('Division by zero'); return l/r;
        case '%': if(r===0) throw new FormulaError('Division by zero'); return l%r;
        case '^': return Math.pow(l,r);
      }
      break;
    }
    case 'cmp': {
      const l=_formulaEval(node.left, ctx), r=_formulaEval(node.right, ctx);
      _assertNum(l); _assertNum(r);
      switch(node.op){
        case '<': return l<r?1:0;   case '>': return l>r?1:0;
        case '<=': return l<=r?1:0; case '>=': return l>=r?1:0;
        case '==': return l===r?1:0; case '!=': return l!==r?1:0;
      }
      break;
    }
    case 'call': {
      if(node.name==='IF'){
        if(node.args.length!==3) throw new FormulaError('IF needs 3 arguments: IF(cond, then, else)');
        const cond=_formulaEval(node.args[0], ctx); _assertNum(cond, 'IF condition');
        return cond ? _formulaEval(node.args[1], ctx) : _formulaEval(node.args[2], ctx);
      }
      if(node.name==='PI' && node.args.length===0) return Math.PI;
      const fn=FORMULA_FUNCS[node.name];
      if(!fn) throw new FormulaError('Unknown function: '+node.name+'()');
      const flat=[];
      for(const a of node.args){
        const v=_formulaEval(a, ctx);
        if(v && typeof v==='object' && '__children' in v) flat.push(...v.__children);
        else { _assertNum(v, 'argument to '+node.name); flat.push(v); }
      }
      return fn(flat);
    }
  }
  throw new FormulaError('Malformed formula');
}
function evalFormula(src, ctx){
  const toks=_formulaTokenize(src);
  const ast=_formulaParse(toks);
  const v=_formulaEval(ast, ctx);
  _assertNum(v, 'result');
  return v;
}
function parseNumericLiteral(text){
  if(text==null) return null;
  let s=String(text).trim();
  if(!s) return null;
  let percent=false;
  if(/%$/.test(s)){ percent=true; s=s.slice(0,-1).trim(); }
  s=s.replace(/^[$\u20ac\u00a3\u00a5]\s*/,'').replace(/,/g,'');
  if(!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v=parseFloat(s);
  return percent ? v/100 : v;
}
function parseLabeledValue(text){
  const s=String(text||'').trim();
  const m=s.match(/^(.+?):\s*(.+)$/);
  if(m){
    const val=parseNumericLiteral(m[2]);
    if(val!=null) return { label:m[1].trim(), value:val };
  }
  return { label:s, value:parseNumericLiteral(s) };
}
// Cleared at the start of every render() so formulas always reflect the current map;
// memoized within a single pass so a value referenced by several formulas is only computed once.
let _formulaCache=new Map();
function clearFormulaCache(){ _formulaCache=new Map(); }
function computeNodeValue(nodeId, visiting){
  if(_formulaCache.has(nodeId)) return _formulaCache.get(nodeId);
  if(!visiting) visiting=new Set();
  if(visiting.has(nodeId)) return {error:'Circular reference'};
  const n = map && map.nodes[nodeId];
  if(!n) return null;
  const plain = nodeTextPlain(n.text||'').trim();
  if(!plain.startsWith('=')){
    const num = parseLabeledValue(plain).value;
    _formulaCache.set(nodeId, num);
    return num;
  }
  const nextVisiting = new Set(visiting); nextVisiting.add(nodeId);
  const ctx = {
    children: () => childrenOf(nodeId).map(cid=>computeNodeValue(cid, nextVisiting)).filter(v=> typeof v==='number' && isFinite(v)),
    resolveRef: (label) => {
      const norm = s => (s||'').trim().toLowerCase();
      const target = norm(label);
      const tried=new Set();
      const tryList = (ids)=>{
        for(const cid of ids){
          if(tried.has(cid) || cid===nodeId) continue; tried.add(cid);
          const cn=map.nodes[cid]; if(!cn) continue;
          const cnPlain = nodeTextPlain(cn.text||'');
          if(norm(parseLabeledValue(cnPlain).label)===target){
            const v=computeNodeValue(cid, nextVisiting);
            return (v && typeof v==='object' && v.error) ? undefined : v;
          }
        }
        return undefined;
      };
      let v;
      if(n.parent!=null){ v=tryList(childrenOf(n.parent)); if(v!==undefined) return v; }
      v=tryList(childrenOf(nodeId)); if(v!==undefined) return v;
      v=tryList(Object.keys(map.nodes)); if(v!==undefined) return v;
      return null;
    }
  };
  let result;
  try{ result = evalFormula(plain.slice(1), ctx); }
  catch(e){ result = { error: (e && e.message) || 'Formula error' }; }
  _formulaCache.set(nodeId, result);
  return result;
}
// Formats a computed formula value for display in the node (e.g. trims float noise).
function formatFormulaResult(v){
  if(v==null) return '-';
  if(typeof v==='object' && v.error) return '#ERROR';
  if(typeof v==='number'){
    if(!isFinite(v)) return '#ERROR';
    const rounded = Math.round(v*1e6)/1e6;
    return String(rounded);
  }
  return '-';
}

// Strip HTML to plain text but keep newlines from <br> and block elements
// Memoized: render()/updateTokenTotal() call this for every node on every pass,
// and parsing a <template> per call dominates those passes on maps with many
// formatted nodes. The result is a pure function of `text`, so a bounded cache
// keyed on the string is exact. Cleared wholesale at the cap - correctness
// never depends on the cache (a miss just re-parses).
let _ntpCache=new Map();
function nodeTextPlain(text){
  if(!text) return '';
  if(!hasInlineMarkup(text)) return text;
  const hit=_ntpCache.get(text);
  if(hit!==undefined) return hit;
  const tpl=document.createElement('template'); tpl.innerHTML=text;   // inert parse
  tpl.content.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
  const out=(tpl.content.textContent||'').replace(/\u00A0/g,' ').trim();
  if(_ntpCache.size>=2000) _ntpCache.clear();
  _ntpCache.set(text, out);
  return out;
}
// Rough token count: ~4 chars per token (English avg for GPT/Claude tokenizers).
// Adds notes content to the total so the badge reflects what would actually be
// included if the user exports this node to a prompt.
function estimateTokens(text, notes){
  const tParts = nodeTextPlain(text||'');
  const nParts = notes ? (notes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim() : '';
  const chars = tParts.length + nParts.length;
  if(chars === 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}
// ===== Mermaid flowchart export =====
// Walk the tree and emit `parent --> child` edges plus node definitions.
// Renders natively in GitHub, GitLab, Notion, Obsidian, etc.
function buildMermaid(startId){
  const root = startId || map.rootId;
  const lines = ['flowchart TD'];
  // Stable short ids: n0, n1, … mapped from node ids
  const idMap = {}; let counter = 0;
  const mid = id => (idMap[id] || (idMap[id] = 'n' + (counter++)));
  // Escape text for a Mermaid node label inside ["..."]
  const label = id => {
    let t = nodeTextPlain(map.nodes[id].text) || ' ';
    t = t.replace(/\n+/g, ' ').replace(/"/g, '#quot;').trim();
    if(t.length > 80) t = t.slice(0, 77) + '…';
    return t;
  };
  const defined = new Set();
  const define = id => {
    if(defined.has(id)) return;
    defined.add(id);
    lines.push(`    ${mid(id)}["${label(id)}"]`);
  };
  const walk = id => {
    define(id);
    childrenOf(id).forEach(c => {
      define(c);
      lines.push(`    ${mid(id)} --> ${mid(c)}`);
      walk(c);
    });
  };
  walk(root);
  // Colour the root node to match the map accent
  const accent = (map.color || '#e0613a');
  lines.push(`    style ${mid(root)} fill:${accent},color:#fff,stroke:${accent}`);
  return lines.join('\n');
}
function exportMermaid(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const code = buildMermaid(startId);
  // Wrap in a fenced ```mermaid block so it pastes straight into Markdown
  const fenced = '```mermaid\n' + code + '\n```\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(fenced).then(
      () => toast('Mermaid diagram copied'),
      () => { download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md'); toast('Clipboard blocked - downloaded instead'); }
    );
  } else {
    download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md');
    toast('Mermaid diagram downloaded');
  }
}

// Build hierarchical Markdown bullets from the map. If `startId` is given,
// only that node's subtree is included - useful for "copy this branch as a prompt".
// Serialize a node's notes HTML back to Markdown blocks so code fences and tables
// round-trip: <pre> -> fenced code, <table> -> pipe table, else -> blockquote lines.
function _htmlTableToMdRows(tableEl){
  const rows=[...tableEl.querySelectorAll('tr')].map(tr=>[...tr.children].map(c=>htmlToInlineMd(c.innerHTML).replace(/\s*\n\s*/g,' ').trim()));
  if(!rows.length) return [];
  const ncol=Math.max(...rows.map(r=>r.length));
  const fill=r=>{ const c=r.slice(); while(c.length<ncol) c.push(''); return c; };
  const out=['| '+fill(rows[0]).join(' | ')+' |', '| '+Array(ncol).fill('---').join(' | ')+' |'];
  rows.slice(1).forEach(r=>out.push('| '+fill(r).join(' | ')+' |'));
  return out;
}
function notesToMdBlocks(notesHtml){
  const tpl=document.createElement('template'); tpl.innerHTML=notesHtml||'';
  const blocks=[];
  tpl.content.childNodes.forEach(ch=>{
    if(ch.nodeType===3){ ch.nodeValue.split('\n').forEach(l=>{ if(l.trim()) blocks.push({q:l.trim()}); }); return; }
    if(ch.nodeType!==1) return;
    const tag=ch.tagName.toLowerCase();
    if(tag==='pre') blocks.push({ code: ch.textContent.replace(/\n+$/,'') });
    else if(tag==='table') blocks.push({ table:_htmlTableToMdRows(ch) });
    else { htmlToInlineMd(ch.innerHTML).split('\n').forEach(l=>{ if(l.trim()) blocks.push({q:l.trim()}); }); }
  });
  return blocks;
}
function _nodeMeta(n){   // per-node info that JSON has but Markdown can't express
  const m={};
  // n.color is the node's BOX background (a shape property, not text styling) - no clean
  // inline-HTML equivalent, and reusing background-color here would collide with n.highlight
  // (a genuine text highlight) on reimport. Kept in meta.
  if(n.color) m.color=n.color;
  if(n.width) m.w=n.width;
  if(n.height) m.h=n.height;
  if(n.collapsed) m.collapsed=1;
  // textColor / underline / fontSize / highlight / align / image are intentionally NOT
  // stored here - they round-trip via visible HTML (<span style>, <u>, <mark>, <div
  // style>, <img>) in the text itself instead (see buildMarkdown / parseMarkdownOutline's
  // `add`), the same way bold/italic/strike already use visible **/*/~~ syntax.
  // (applyMeta below still reads these legacy meta fields for files exported before this.)
  if(n.ref) m.ref=1;
  if(n.citation) m.citation=n.citation;
  if(n.created) m.created=n.created;
  if(n.updated) m.updated=n.updated;
  return Object.keys(m).length? m : null;
}
function buildMarkdown(startId, opts){
  const rich = !!(opts && opts.rich);            // rich: keep formatting, tasks, links, images
  const withMeta = !!(opts && opts.meta);        // prepend a <!-- mindspark ... --> metadata comment
  const lineMap = (opts && opts.lineMap) || null;// filled: lineMap[lineIndex] = nodeId (node<->text sync)
  const root = startId || map.rootId;
  const lines=[];
  const nmeta={}, lm={};
  const baseDepth = 0;
  const notesText = n => (n.notes||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim();
  const emitNotes = (n, pad) => {   // rich: code fences / tables round-trip; other notes -> blockquotes
    if(!(n.notes||'').trim()) return;
    notesToMdBlocks(n.notes).forEach(b=>{
      if(b.code!=null){ lines.push('```'); b.code.split('\n').forEach(l=>lines.push(l)); lines.push('```'); }
      else if(b.table){ b.table.forEach(l=>lines.push(l)); }
      else lines.push(pad+'> '+b.q);
    });
  };
  const walk=(id, bd, path)=>{
    const n=map.nodes[id];
    if(!n) return;
    if(n.frontmatter) return;   // emitted separately as YAML frontmatter at the very top instead - never inline
    if(withMeta){ const mm=_nodeMeta(n); if(mm) nmeta[path]=mm; }
    const pad='  '.repeat(bd);
    if(n.hr){ if(lineMap) lm[lines.length]=id; lines.push(pad+'---'); return; }   // divider round-trips as ---
    if(n.html){   // block node (table / code / raw HTML) at the current bullet indent
      if(lineMap) lm[lines.length]=id;
      if(n.raw){ n.html.split('\n').forEach(l=>lines.push(l.trim()?pad+l:l)); return; }
      const lang=(rich && n.lang) ? n.lang : '';
      notesToMdBlocks(n.html).forEach(b=>{
        if(b.code!=null){ lines.push(pad+'```'+lang); b.code.split('\n').forEach(l=>lines.push(pad+l)); lines.push(pad+'```'); }
        else if(b.table){ b.table.forEach(l=>lines.push(pad+l)); }
        else lines.push(pad+'> '+b.q);
      });
      return;
    }
    let body = (rich ? htmlToInlineMd(n.text) : nodeTextPlain(n.text)) || 'Untitled';
    const wrapStyle = s => {   // whole-node style toggles (nodebar buttons) get real Markdown/HTML syntax, not just metadata
      if(!rich) return s;
      if(n.strike) s='~~'+s+'~~';
      if(n.italic) s='*'+s+'*';
      if(n.bold) s='**'+s+'**';
      if(n.underline) s='<u>'+s+'</u>';
      if(n.highlight) s=`<mark style="background-color:${n.highlight}">${s}</mark>`;
      if(n.textColor) s=`<span style="color:${n.textColor}">${s}</span>`;
      if(n.fontSize) s=`<span style="font-size:${n.fontSize}px">${s}</span>`;
      if(n.align && n.align!=='center') s=`<div style="text-align:${n.align}">${s}</div>`;   // 'center' is the render-time default (see renderNodeText) - skip for brevity
      return s;
    };
    // A non-http(s) image (pasted/uploaded - stored as a data: URI) has no Markdown image
    // syntax that can hold it, so it round-trips as a literal <img> tag instead of silently
    // living only in the meta comment; a plain http(s) image keeps using ![image](url).
    const imageLine = () => {
      if(!(rich && n.image)) return null;
      if(/^https?:\/\//i.test(n.image)) return `![${n.imageAlt||'image'}](${n.image})`;
      return `<img src="${n.image}"${n.imageAlt ? ' alt="'+escapeHtml(n.imageAlt)+'"' : ''}>`;
    };
    let first;
    if(rich && n.listType){
      // A bulleted/numbered node (multiple lines living inside ONE node) has no plain-
      // Markdown equivalent - a bare "- line" is indistinguishable from a new sibling
      // node. <ul>/<ol>/<li> are already in the sanitizer's inline-HTML whitelist (see
      // SAFE_TAGS/INLINE_HTML_RE), so use them directly: visible/readable as real HTML in
      // the Markdown text, and it round-trips as a single line/node - parseMarkdownOutline
      // unwraps this same shape straight back into listType + <br>-joined text. Whole-node
      // style toggles are applied per <li> (not around the whole wrapper) so the outer tag
      // always literally starts with <ul>/<ol> for the importer to recognize.
      const tag = n.listType==='ol' ? 'ol' : 'ul';
      first = `<${tag}>` + body.split('\n').map(l=>`<li>${wrapStyle(l||'<br>')}</li>`).join('') + `</${tag}>`;
    } else {
      first = wrapStyle(body.replace(/\n+/g, rich ? '<br>' : ' '));   // keep multi-line text in ONE node
    }
    const hlevel = (id===root) ? 1 : ((rich && n.hlevel) ? n.hlevel : 0);   // imported headings re-emit as #/##/###
    if(hlevel){
      if(lines.length && lines[lines.length-1]!=='') lines.push('');
      if(lineMap) lm[lines.length]=id;   // record AFTER the spacer line, so it points at the heading text itself
      lines.push('#'.repeat(hlevel)+' '+first);
      if(rich){ emitNotes(n, ''); } else { const nt=notesText(n); if(nt) lines.push('', nt); }
      const il = imageLine(); if(il) lines.push(il);
      lines.push('');
      childrenOf(id).forEach((c,i)=>walk(c, 0, path+'.'+i));       // heading's children start a fresh bullet indent
    } else {
      if(lineMap) lm[lines.length]=id;
      const box = (rich && n.task) ? (n.task==='done' ? '[x] ' : '[ ] ') : '';
      const isPara = rich && n.para && !n.task;                 // keep plain paragraphs plain (no bullet)
      lines.push(isPara ? `${pad}${first}` : `${pad}- ${box}${first}`);
      const notePad = isPara ? pad : `${pad}  `;
      if(rich){ emitNotes(n, notePad); } else { const nt=notesText(n); if(nt) nt.split('\n').forEach(l=>lines.push(`${notePad}> ${l}`)); }
      const il = imageLine(); if(il) lines.push(`${notePad}${il}`);
      childrenOf(id).forEach((c,i)=>walk(c, bd+1, path+'.'+i));
    }
  };
  // A frontmatter child of root (Claude Skill name/description, etc.) is emitted as real
  // YAML --- frontmatter --- at the very top of the file, not as inline content.
  let frontmatterYaml = null;
  { const fmChild = childrenOf(root).find(cid => map.nodes[cid] && map.nodes[cid].frontmatter);
    if(fmChild) frontmatterYaml = frontmatterNodeToYaml(map.nodes[fmChild]);
  }
  walk(root, 0, '0');
  let out=lines, shift=0; const prefix=[];
  if(withMeta){
    const meta={ v:1 };
    if(map.layout) meta.layout=map.layout;
    if(map.color) meta.color=map.color;
    if(map.vars && Object.keys(map.vars).length) meta.vars=map.vars;
    if(Object.keys(nmeta).length) meta.nodes=nmeta;
    if(Object.keys(meta).length>1){ prefix.push('<!-- mindspark', JSON.stringify(meta), '-->', ''); }
  }
  if(frontmatterYaml){ frontmatterYaml.split('\n').forEach(l=>prefix.push(l)); prefix.push(''); }
  else if(rich && map.frontmatter){ map.frontmatter.split('\n').forEach(l=>prefix.push(l)); prefix.push(''); }   // legacy fallback
  if(prefix.length){ out=prefix.concat(lines); shift=prefix.length; }
  if(lineMap){ lineMap.length=0; for(const k in lm) lineMap[+k+shift]=lm[k]; }
  return out.join('\n');
}

// === Variable / placeholder detection ============================================
// Recognise {{name}} and ${name} in node text + notes. Names can include letters,
// numbers, underscores, hyphens, dots, and spaces.
const VAR_RE = /\{\{\s*([\w.\- ]+?)\s*\}\}|\$\{\s*([\w.\- ]+?)\s*\}/g;
function findVariables(startId){
  const root = startId || map.rootId;
  const seen = new Set();
  const order = [];
  const visit = text => {
    if(!text) return;
    const plain = nodeTextPlain(text);
    VAR_RE.lastIndex = 0;
    let m; while((m = VAR_RE.exec(plain)) !== null){
      const name = (m[1] || m[2] || '').trim();
      if(name && !seen.has(name)){ seen.add(name); order.push(name); }
    }
  };
  const walk = id => {
    const n = map.nodes[id]; if(!n) return;
    visit(n.text);
    if(n.notes) visit((n.notes||'').replace(/<[^>]+>/g,' '));
    childrenOf(id).forEach(walk);
  };
  walk(root);
  return order;
}
// Replace {{var}} and ${var} occurrences inside `text` using the values map.
function substituteVariables(text, values){
  if(!text) return text;
  return text.replace(VAR_RE, (m, a, b) => {
    const name = (a || b || '').trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m;
  });
}

// Build a clean prompt text - hierarchical headings, no markdown syntax noise,
// notes inlined. Optionally substitutes filled variable values.
function buildPrompt(startId, values){
  const root = startId || map.rootId;
  const out = [];
  const sub = t => values ? substituteVariables(t, values) : t;
  const walk = (id, depth) => {
    const n = map.nodes[id]; if(!n) return;
    const text = sub(nodeTextPlain(n.text) || 'Untitled');
    const notes = sub(((n.notes||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()));
    if(depth === 0){
      out.push(text);
      if(notes) out.push('', notes);
      out.push('');
    } else if(depth === 1){
      // Top-level branches become section headers
      out.push('');
      out.push(text);
      out.push('-'.repeat(Math.min(text.length, 40)));
      if(notes) out.push(notes);
    } else {
      const indent = '  '.repeat(depth - 1);
      out.push(`${indent}${text}`);
      if(notes) out.push(`${indent}  (${notes})`);
    }
    childrenOf(id).forEach(c => walk(c, depth + 1));
  };
  walk(root, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Show a small modal listing each detected variable with an input field.
// On submit, calls `done(values)` with the user-entered substitutions.
function showVariableForm(varNames, defaults, mapId, done){
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const m = document.createElement('div');
  m.className = 'var-form';
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Fill variables</h2>
      <p class="vf-sub">Found ${varNames.length} placeholder${varNames.length===1?'':'s'} - fill them before exporting the prompt.</p>
      <div class="vf-fields">
        ${varNames.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="value for ${escapeHtml(name)}">${escapeHtml(defaults[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-skip">Skip / use raw</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Export</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  // Auto-grow textareas as the user types
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight, 140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close = () => m.remove();
  const collect = () => {
    const out = {};
    m.querySelectorAll('.vf-input').forEach(ta => { out[ta.dataset.name] = ta.value; });
    // Remember per-map for next time
    try { localStorage.setItem('mindspark:vars:'+mapId, JSON.stringify(out)); } catch(e){}
    return out;
  };
  m.querySelector('.vf-go').onclick     = () => { const v = collect(); close(); done(v); };
  m.querySelector('.vf-skip').onclick   = () => { close(); done(null); };  // null = no substitution
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick  = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}

// Top-level "Export as prompt" - detects variables, shows the form when any are
// present, then builds the prompt text and copies it to the clipboard.
function exportAsPrompt(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const vars = findVariables(startId);
  const finish = (values) => {
    const text = buildPrompt(startId, values);
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(text).then(
        () => toast(`Prompt copied (${text.length} chars)`),
        () => { download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt'); toast('Clipboard blocked - downloaded instead'); }
      );
    } else {
      download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt');
      toast('Prompt downloaded');
    }
  };
  if(vars.length === 0){
    finish(null);
    return;
  }
  // Build defaults: map-level variables first (the "official" defaults defined
  // once via the Variables panel), then any per-session localStorage values on top.
  const defaults = { ...(map.vars || {}) };
  try {
    const saved = JSON.parse(localStorage.getItem('mindspark:vars:'+map.id) || '{}');
    Object.assign(defaults, saved);
  } catch(e){}
  // If every detected variable already has a non-empty map-level default, skip the
  // form entirely and export straight away - that's the whole point of map vars.
  const allCovered = vars.every(v => (map.vars||{})[v] != null && String((map.vars||{})[v]).trim() !== '');
  if(allCovered){
    finish(defaults);
    toast('Used saved map variables');
    return;
  }
  showVariableForm(vars, defaults, map.id, (values) => {
    finish(values);
  });
}

// ===== Map-level variables panel =====
// Lets the user set default values for every {{placeholder}} / ${placeholder}
// in the map, stored on map.vars so future prompt exports reuse them.
function showMapVariables(){
  if(!map) return;
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const vars = findVariables(map.rootId);
  const cur = map.vars || {};
  const m = document.createElement('div');
  m.className = 'var-form';
  if(vars.length === 0){
    m.innerHTML = `
      <div class="vf-backdrop"></div>
      <div class="vf-card">
        <button class="vf-close" aria-label="Close">×</button>
        <h2>Map variables</h2>
        <p class="vf-sub">No placeholders found yet. Use <code>{{name}}</code> or <code>$\{name}</code> anywhere in your node text, then set their default values here so every prompt export fills them automatically.</p>
        <div class="vf-actions"><button class="vf-cancel">Close</button></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', e => e.stopPropagation());
    const close=()=>m.remove();
    m.querySelector('.vf-close').onclick=close;
    m.querySelector('.vf-cancel').onclick=close;
    m.querySelector('.vf-backdrop').onclick=close;
    return;
  }
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">×</button>
      <h2>Map variables</h2>
      <p class="vf-sub">Set default values for the ${vars.length} placeholder${vars.length===1?'':'s'} in this map. Prompt exports will reuse these without asking - leave one blank to be prompted at export time.</p>
      <div class="vf-fields">
        ${vars.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="default for ${escapeHtml(name)}">${escapeHtml(cur[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-clear">Clear all</button>
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Save defaults</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick = () => {
    const out = {};
    m.querySelectorAll('.vf-input').forEach(ta => { if(ta.value.trim()!=='') out[ta.dataset.name]=ta.value; });
    map.vars = out;
    pushHistory(); scheduleSave();
    close();
    toast('Map variables saved');
  };
  m.querySelector('.vf-clear').onclick = () => { m.querySelectorAll('.vf-input').forEach(ta=>{ta.value='';ta.dispatchEvent(new Event('input'));}); };
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}
function exportMarkdown(toClipboard, rich){
  if(!map) return;
  // If a non-root node is selected, export *that branch* - perfect for
  // pulling out a single prompt or section from a larger map.
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const md = buildMarkdown(startId, {rich:!!rich, meta:!!rich});
  const scope = startId === map.rootId ? '' : ' (selected branch)';
  if(toClipboard){
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(md).then(
        ()=>toast('Copied to clipboard'+scope),
        ()=>{ download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md'); toast('Clipboard blocked - downloaded instead'); }
      );
    } else {
      download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md');
      toast('Clipboard unavailable - downloaded');
    }
  } else {
    const name = startId === map.rootId ? map.title : nodeTextPlain(map.nodes[startId]?.text);
    download(new Blob([md],{type:'text/markdown'}), (name||'mindmap')+'.md');
    toast('Markdown exported'+scope);
  }
}
// Build a Word-compatible HTML document (saved with .doc extension -
// Word, Google Docs, and LibreOffice all open this as a Word document).
// Renders one LaTeX expression to a small PNG data-URL <img> tag, for exports that
// can't render MathML/OMML natively (the HTML-based .doc export opens in Word,
// Google Docs, and LibreOffice, none of which reliably render raw MathML pasted in
// via a file - but all three display an embedded image just fine). Reuses the same
// canvas math-layout engine (_layoutMath) the PNG exporter already relies on,
// scoped to a single expression instead of a full node.
function mathToImgTag(tex, fontPx, color){
  fontPx = fontPx || 16; color = color || '#23201b';
  try{
    const t=document.createElement('span'); t.innerHTML=latexToMathML(tex,false);
    const mathEl=t.querySelector('math'); if(!mathEl) return null;
    const measureCv=document.createElement('canvas'); const mctx=measureCv.getContext('2d');
    const lay=_layoutMath(mctx, mathEl, fontPx, 'serif', color);
    const scale=3, pad=2;   // render at higher pixel density so it stays crisp at normal document zoom
    const w=Math.max(1,Math.ceil(lay.w+pad*2)), h=Math.max(1,Math.ceil(lay.asc+lay.desc+pad*2));
    const cv=document.createElement('canvas'); cv.width=w*scale; cv.height=h*scale;
    const ctx=cv.getContext('2d'); ctx.scale(scale,scale);
    lay.draw(pad, pad+lay.asc);
    // CSS height stays at the UNSCALED size - scale only adds pixel density, not display size.
    return `<img src="${cv.toDataURL('image/png')}" style="vertical-align:middle;height:${h}px" alt="${escapeHtml(tex)}">`;
  }catch(e){ return null; }
}
// Splits `text` around $...$/$$...$$ math segments, running each surrounding plain-
// text chunk through the normal escapeHtml/sanitizeInlineHTML path and replacing
// each math segment with its rendered image - rather than running the whole string
// through the escaper first, which would mangle the <img> markup this injects.
// Returns null (falls back to the caller's normal path) if there's no math at all,
// so the common case is untouched.
function renderMathForExport(text, fontPx, color){
  text = text || '';
  if(!containsMath(text)) return null;
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const plain = s => INLINE_HTML_RE.test(s) ? sanitizeInlineHTML(s) : escapeHtml(s).replace(/\n/g,'<br>');
  let out='', last=0, m;
  while((m=re.exec(text))){
    out += plain(text.slice(last,m.index));
    const tex=m[1]!=null?m[1]:m[2];
    out += mathToImgTag(tex, fontPx, color) || escapeHtml(m[0]);   // literal text if rendering ever fails
    last=m.index+m[0].length;
  }
  out += plain(text.slice(last));
  return out;
}
function buildDoc(){
  const title = (map.title || 'Mind Map').replace(/[<>]/g,'');
  let body = `<h1>${escapeHtml(title)}</h1>`;
  // Root's image, if any
  const rootN = map.nodes[map.rootId];
  if(rootN && rootN.image){ body += `<img src="${rootN.image}" alt="${escapeHtml(rootN.imageAlt||'attachment')}" style="max-width:320px;max-height:220px;display:block;margin-bottom:10px;border-radius:8px">`; }
  // Add root's notes under the title
  const rn = rootN?.notes;
  if(rn){ body += `<p><em>${renderMathForExport(rn, 13, '#6a6258') ?? sanitizeInlineHTML(rn)}</em></p>`; }
  // Render children as nested <ul>
  const renderChildren = (parentId, depth)=>{
    const cs = childrenOf(parentId);
    if(!cs.length) return '';
    let out = `<ul>`;
    cs.forEach(cid=>{
      const n = map.nodes[cid];
      const txt = renderMathForExport(n.text||'', 15, '#23201b')
        ?? (INLINE_HTML_RE.test(n.text||'') ? sanitizeInlineHTML(n.text) : escapeHtml(n.text||'').replace(/\n/g,'<br>'));
      const taskMark = n.task ? (n.task==='done' ? '\u2611\uFE0F ' : n.task==='doing' ? '\u25D0 ' : '\u2610 ') : '';
      out += `<li>`;
      if(n.image) out += `<img src="${n.image}" alt="${escapeHtml(n.imageAlt||'attachment')}" style="max-width:280px;max-height:200px;display:block;margin-bottom:4px;border-radius:6px"><br>`;
      out += `${taskMark}${n.task==='done'?`<span style="text-decoration:line-through;opacity:.65">${txt}</span>`:txt}`;
      if(n.notes){ out += `<br><em style="color:#666">${renderMathForExport(n.notes, 13, '#6a6258') ?? sanitizeInlineHTML(n.notes)}</em>`; }
      out += renderChildren(cid, depth+1);
      out += `</li>`;
    });
    out += `</ul>`;
    return out;
  };
  body += renderChildren(map.rootId, 1);

  // Word-friendly HTML document with proper MIME hints
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:#23201b;line-height:1.55;max-width:780px;margin:24px auto;padding:0 24px}
  h1{font-family:Cambria,Georgia,serif;color:#e0613a;margin:0 0 18px;font-size:26pt}
  ul{margin:6px 0 6px 24px;padding-left:18px}
  li{margin:4px 0}
  em{font-style:italic;color:#6a6258}
  a{color:#3a6ea5}
</style>
</head>
<body>${body}</body>
</html>`;
}
function exportDoc(){
  if(!map) return;
  const html = buildDoc();
  // .doc extension + msword MIME → Word, Google Docs, LibreOffice all open it
  const filename = (map.title||'mindmap')+'.doc';
  const blob = new Blob(['\ufeff', html], {type:'application/msword'});
  download(blob, filename);
  toast('Word document exported');
}
// --- Canvas math rendering (for PNG export) --------------------------------
// A small layout engine that draws the MathML subset produced by latexToMathML
// onto a 2D canvas (sub/superscripts, fractions, roots, accents). Used by the
// PNG exporter so equations render properly instead of showing raw LaTeX source.
function _layoutMath(ctx, el, fontPx, family, color){
  const ASC=fontPx*0.72, DESC=fontPx*0.24;
  const textBox=(str, italic)=>{
    let f=(italic?'italic ':'')+fontPx+'px '+family;
    ctx.font=f; const w=ctx.measureText(str).width;
    return { w, asc:ASC, desc:DESC, draw:(x,base)=>{ ctx.save(); ctx.font=f; ctx.fillStyle=color; ctx.textBaseline='alphabetic'; ctx.textAlign='left'; ctx.fillText(str,x,base); ctx.restore(); } };
  };
  if(el.nodeType===3) return textBox(el.nodeValue||'', false);
  const tag=(el.tagName||'').toLowerCase();
  const kids=Array.from(el.childNodes);
  const seq=()=>{
    const parts=kids.map(k=>_layoutMath(ctx,k,fontPx,family,color));
    const w=parts.reduce((s,p)=>s+p.w,0);
    const asc=Math.max(ASC,...parts.map(p=>p.asc),0);
    const desc=Math.max(DESC,...parts.map(p=>p.desc),0);
    return { w, asc, desc, draw:(x,base)=>{ let cx=x; parts.forEach(p=>{ p.draw(cx,base); cx+=p.w; }); } };
  };
  if(tag==='math'||tag==='mrow'||tag==='mstyle'||tag==='') return seq();
  if(tag==='mi'){ const t=el.textContent||''; return textBox(t, t.length===1 && /[a-zA-Z]/.test(t)); }
  if(tag==='mn'||tag==='mo'||tag==='mtext') return textBox(el.textContent||'', false);
  if(tag==='mspace'){ const em=parseFloat(el.getAttribute('width')||'0')||0; return { w:em*fontPx, asc:0, desc:0, draw:()=>{} }; }
  if(tag==='msup'||tag==='msub'||tag==='msubsup'){
    const base=_layoutMath(ctx,kids[0],fontPx,family,color);
    const sf=fontPx*0.72;
    let sup=null, sub=null;
    if(tag==='msup') sup=_layoutMath(ctx,kids[1],sf,family,color);
    else if(tag==='msub') sub=_layoutMath(ctx,kids[1],sf,family,color);
    else { sub=_layoutMath(ctx,kids[1],sf,family,color); sup=_layoutMath(ctx,kids[2],sf,family,color); }
    const supRise=fontPx*0.40, subDrop=fontPx*0.20;
    const sw=Math.max(sup?sup.w:0, sub?sub.w:0);
    return { w:base.w+sw+fontPx*0.04,
      asc:Math.max(base.asc, supRise+(sup?sup.asc:0)),
      desc:Math.max(base.desc, subDrop+(sub?sub.desc:0)),
      draw:(x,b)=>{ base.draw(x,b); const sx=x+base.w; if(sup) sup.draw(sx,b-supRise); if(sub) sub.draw(sx,b+subDrop+sf*0.5); } };
  }
  if(tag==='mfrac'){
    const num=_layoutMath(ctx,kids[0],fontPx*0.92,family,color);
    const den=_layoutMath(ctx,kids[1],fontPx*0.92,family,color);
    const pad=fontPx*0.18, gap=fontPx*0.18;
    const w=Math.max(num.w,den.w)+pad*2;
    const line=el.getAttribute('linethickness');
    return { w, asc:num.asc+num.desc+gap+fontPx*0.28, desc:den.asc+den.desc+gap-fontPx*0.28,
      draw:(x,b)=>{ const midY=b-fontPx*0.28;
        num.draw(x+(w-num.w)/2, midY-gap-num.desc);
        den.draw(x+(w-den.w)/2, midY+gap+den.asc);
        if(line!=='0'){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=Math.max(1,fontPx*0.05); ctx.beginPath(); ctx.moveTo(x+pad*0.5,midY); ctx.lineTo(x+w-pad*0.5,midY); ctx.stroke(); ctx.restore(); } } };
  }
  if(tag==='msqrt'||tag==='mroot'){
    const content=_layoutMath(ctx,kids[0],fontPx,family,color);
    const lead=fontPx*0.62;
    return { w:content.w+lead+fontPx*0.2, asc:content.asc+fontPx*0.12, desc:content.desc,
      draw:(x,b)=>{ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=Math.max(1,fontPx*0.06); ctx.beginPath();
        const top=b-(content.asc+fontPx*0.12), bot=b+content.desc*0.4;
        ctx.moveTo(x,b); ctx.lineTo(x+lead*0.4,bot); ctx.lineTo(x+lead*0.7,top); ctx.lineTo(x+content.w+lead+fontPx*0.2,top); ctx.stroke(); ctx.restore();
        content.draw(x+lead,b); } };
  }
  if(tag==='mover'){
    const base=_layoutMath(ctx,kids[0],fontPx,family,color);
    const acc=_layoutMath(ctx,kids[1],fontPx*0.8,family,color);
    return { w:Math.max(base.w,acc.w), asc:base.asc+fontPx*0.28, desc:base.desc,
      draw:(x,b)=>{ base.draw(x,b); acc.draw(x+(base.w-acc.w)/2, b-base.asc-fontPx*0.05); } };
  }
  if(kids.length) return seq();
  return textBox(el.textContent||'', false);
}
// Draw a node's text that contains $...$ math. Lines split on \n; each line is a
// row of plain-text and math segments laid out horizontally, block centered on cy.
function drawNodeMath(ctx, text, o){
  const family=o.family, fontPx=o.fontPx, color=o.color;
  ctx.save();
  ctx.fillStyle=color;
  // listType (whole-node bullets): prefix each line the same way drawFormattedText
  // does for its own plain-text listType case, then fall through to the normal
  // per-line math-segment parsing below - this is already line-oriented, so a
  // bullet prefix on each line is all that's needed to support it here too.
  const rawLines=(text||'').split('\n');
  const lines = o.listType
    ? rawLines.map((line,i)=> (o.listType==='ol' ? `${i+1}. ` : '\u2022 ')+line)
    : rawLines;
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const built=lines.map(line=>{
    const segs=[]; let last=0,m; re.lastIndex=0;
    const pushText=(s)=>{ if(!s) return; ctx.font=(o.bold?'bold ':'500 ')+fontPx+'px '+family; segs.push({type:'t',str:s,w:ctx.measureText(s).width,asc:fontPx*0.72,desc:fontPx*0.24}); };
    while((m=re.exec(line))){
      pushText(line.slice(last,m.index));
      const tex=m[1]!=null?m[1]:m[2];
      let mathEl=null; try{ const t=document.createElement('span'); t.innerHTML=latexToMathML(tex,false); mathEl=t.querySelector('math'); }catch(e){}
      if(mathEl){ const lay=_layoutMath(ctx,mathEl,fontPx,family,color); segs.push({type:'m',lay,w:lay.w,asc:lay.asc,desc:lay.desc}); }
      else pushText(m[0]);
      last=m.index+m[0].length;
    }
    pushText(line.slice(last));
    const w=segs.reduce((s,p)=>s+p.w,0);
    const asc=Math.max(fontPx*0.72,...segs.map(s=>s.asc),0);
    const desc=Math.max(fontPx*0.24,...segs.map(s=>s.desc),0);
    return {segs,w,asc,desc};
  });
  const lineH=Math.max(...built.map(b=>b.asc+b.desc), fontPx*1.2)*1.1;
  const totalH=lineH*built.length;
  let cy=o.y - totalH/2;
  built.forEach(b=>{
    const baseline=cy+b.asc;
    let x = o.align==='left' ? o.x : o.align==='right' ? (o.x+o.maxWidth-b.w) : (o.x+(o.maxWidth-b.w)/2);
    b.segs.forEach(s=>{
      if(s.type==='t'){ ctx.save(); ctx.font=(o.bold?'bold ':'500 ')+fontPx+'px '+family; ctx.fillStyle=color; ctx.textBaseline='alphabetic'; ctx.textAlign='left'; ctx.fillText(s.str,x,baseline); ctx.restore(); }
      else s.lay.draw(x, baseline);
      x+=s.w;
    });
    cy+=lineH;
  });
  ctx.restore();
}

async function exportPNG(){
  render();
  // Read live theme colors from CSS custom properties so the export matches
  // whatever theme/map style the user has selected.
  const cs = getComputedStyle(document.documentElement);
  const css = name => cs.getPropertyValue(name).trim();
  const themeBg     = css('--paper')     || '#f4efe6';
  const themeEdge   = css('--line-2')    || '#c8bda8';
  const themeInk    = css('--ink')       || '#23201b';
  const themeNodeBg = css('--node-bg')   || '#ffffff';
  const themeLine   = css('--line')      || '#d8cfbf';
  const accent      = css('--accent')    || '#e0613a';
  const toolbarBg   = css('--toolbar-bg') || '#fbf8f2';
  const toolbarText = css('--toolbar-text') || '#23201b';
  const line2       = css('--line-2') || themeEdge;
  const stickyBg    = css('--sticky') || '#fff7b0';
  const stickyEdge  = css('--sticky-edge') || '#f2e27a';
  const stickyInk   = css('--sticky-ink') || '#4a431f';
  // Zebra tints for uncoloured nodes - same 93/7 split as the CSS striping.
  const zebraA = mixHex(themeNodeBg, accent, 0.07);
  const zebraB = mixHex(themeNodeBg, css('--teal') || '#2f6f6a', 0.07);
  const zd = withChildIndex(zebraDepth);   // depth parity for the tint choice
  const mapStyle  = map.style  || 'modern';
  const mapLayout = map.layout || 'balanced';

  const hidden=hiddenSet(); const ids=Object.keys(map.nodes).filter(i=>!hidden.has(i));
  // Pre-load every node's image - ctx.drawImage() needs an actual loaded Image
  // object, not the data-URL string, so this has to finish before the drawing
  // pass below runs. A per-image timeout means one slow/corrupt image can't hang
  // the whole export; that node just falls back to no image, like before.
  const loadImg = src => new Promise(resolve=>{
    const img=new Image();
    let done=false; const finish=v=>{ if(!done){ done=true; resolve(v); } };
    img.onload=()=>finish(img);
    img.onerror=()=>finish(null);
    setTimeout(()=>finish(null), 4000);
    img.src=src;
  });
  const imgMap={};
  await Promise.all(ids.filter(i=>map.nodes[i].image).map(async i=>{ imgMap[i]=await loadImg(map.nodes[i].image); }));

  // Favicons for link nodes, so the export matches what the live canvas shows.
  // crossOrigin='anonymous' is the whole safety story here: favicons come from
  // a third-party host, and drawing a cross-origin image WITHOUT it taints the
  // canvas, which makes the final toBlob() throw and kills the entire export.
  // With it, the browser either gets CORS headers and the icon is safe to
  // draw, or the load fails outright and we simply skip that icon. A missing
  // favicon is a cosmetic loss; a tainted canvas is a broken feature.
  const loadFavicon = src => new Promise(resolve=>{
    const img=new Image();
    let done=false; const finish=v=>{ if(!done){ done=true; resolve(v); } };
    img.crossOrigin='anonymous';
    img.onload=()=>finish(img);
    img.onerror=()=>finish(null);
    setTimeout(()=>finish(null), 3000);   // never let a slow icon host stall the export
    img.src=src;
  });
  const favicons={};
  {
    const hosts=new Set();
    ids.forEach(i=>{
      const t=map.nodes[i].text||'';
      URL_RE.lastIndex=0; let m;
      while((m=URL_RE.exec(t))!==null){
        try{ hosts.add(new URL(m[0]).hostname.replace(/^www\./,'')); }catch(_){}
      }
    });
    await Promise.all([...hosts].map(async h=>{
      favicons[h]=await loadFavicon('https://icons.duckduckgo.com/ip3/'+h+'.ico');
    }));
  }
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  ids.forEach(i=>{const n=map.nodes[i];minx=Math.min(minx,n.x);miny=Math.min(miny,n.y);maxx=Math.max(maxx,n.x+(n.w||120));maxy=Math.max(maxy,n.y+(n.h||40));});
  const pad=50,scale=2;
  const W=(maxx-minx+pad*2),H=(maxy-miny+pad*2);
  const cv=document.createElement('canvas');cv.width=W*scale;cv.height=H*scale;
  const ctx=cv.getContext('2d');ctx.scale(scale,scale);
  // Exact background - matches .stage for any Colour Theme + I am look.
  // Uses live CSS vars so theme/look changes are reflected without hardcoding.
  const look = document.documentElement.getAttribute('data-look') || 'office';
  const stageBg = css('--paper') || themeBg;
  ctx.fillStyle=stageBg; ctx.fillRect(0,0,W,H);
  // stage background-image per look - replicate CSS gradients/patterns
  const lineColor = css('--line') || themeLine;
  const paperColor = stageBg;
  const canvasDot = css('--canvas-dot');
  const tealColor = css('--teal') || '#2f6f6a';
  const accentColor = accent;
  const drawLookBg = ()=>{
    if(look==='handwritten'){
      // repeating-linear-gradient(var(--paper) 0, var(--paper) 27px, var(--line) 28px) 100% 28px
      ctx.strokeStyle=lineColor; ctx.lineWidth=1;
      for(let y=28; y<H; y+=28){ ctx.beginPath(); ctx.moveTo(0,y+0.5); ctx.lineTo(W,y+0.5); ctx.stroke(); }
    } else if(look==='coffee-shop'){
      // 135deg diagonal hatch 22px paper + 1px line, 32px tile
      ctx.strokeStyle=lineColor; ctx.lineWidth=1;
      for(let d=-H; d<W+H; d+=32){
        ctx.beginPath(); ctx.moveTo(d,0); ctx.lineTo(d+H, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(d+22,0); ctx.lineTo(d+22+H, H); ctx.stroke();
      }
    } else if(look==='lab'){
      // blueprint grid 26px both axes, 55% line
      ctx.strokeStyle=lineColor; ctx.globalAlpha=0.55; ctx.lineWidth=1;
      for(let x=0;x<=W;x+=26){ ctx.beginPath(); ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,H); ctx.stroke(); }
      for(let y=0;y<=H;y+=26){ ctx.beginPath(); ctx.moveTo(0,y+0.5); ctx.lineTo(W,y+0.5); ctx.stroke(); }
      ctx.globalAlpha=1;
    } else if(look==='forest'){
      // 7 radial ellipses - approximate with filled ellipses at low alpha
      const col=tealColor;
      ctx.fillStyle=col; ctx.globalAlpha=0.08;
      const spots=[[0.18,0.22,7,10],[0.68,0.18,5,7],[0.42,0.38,9,6],[0.82,0.52,6,8],[0.12,0.68,8,5],[0.55,0.78,5,9],[0.30,0.88,6,6]];
      spots.forEach(([rx,ry,rw,rh])=>{ ctx.beginPath(); ctx.ellipse(W*rx,H*ry,rw,rh,0,0,Math.PI*2); ctx.fill(); });
      ctx.globalAlpha=1;
    } else if(look==='beach'){
      ctx.strokeStyle=tealColor; ctx.globalAlpha=0.07; ctx.lineWidth=1;
      for(let d=-H; d<W+H; d+=60){
        ctx.beginPath(); ctx.moveTo(d,0); ctx.lineTo(d+H, H); ctx.stroke();
      }
      ctx.globalAlpha=1;
    } else if(look==='studio'){
      ctx.strokeStyle=css('--ink')||themeInk; ctx.globalAlpha=0.12; ctx.lineWidth=1;
      for(let d=-H; d<W+H; d+=31){
        ctx.beginPath(); ctx.moveTo(d,0); ctx.lineTo(d+H, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(d+H,0); ctx.lineTo(d, H); ctx.stroke();
      }
      ctx.globalAlpha=1;
    } else if(look==='mountain'){
      ctx.strokeStyle=lineColor; ctx.globalAlpha=0.12; ctx.lineWidth=1;
      for(let y=60; y<H; y+=120){ ctx.beginPath(); ctx.moveTo(0,y+0.5); ctx.lineTo(W,y+0.5); ctx.stroke(); }
      for(let x=80; x<W; x+=80){ ctx.beginPath(); ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,H); ctx.stroke(); }
      ctx.globalAlpha=1;    } else if(look==='desert'){
      // dunes - three large ellipses + coconut palms on curve + sand speck
      ctx.fillStyle=lineColor; ctx.globalAlpha=0.12;
      ctx.beginPath(); ctx.ellipse(W*0.22,H*1.08,W*0.42,H*0.18,0,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=0.10; ctx.beginPath(); ctx.ellipse(W*0.78,H*1.15,W*0.38,H*0.15,0,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=0.08; ctx.beginPath(); ctx.ellipse(W*0.50,H*1.02,W*0.52,H*0.12,0,0,Math.PI*2); ctx.fill();
      // coconut palms on dune curve - four palms at 12/35/62/85%
      ctx.strokeStyle=lineColor; ctx.globalAlpha=0.16; ctx.lineWidth=2.2; ctx.lineCap='round'; ctx.lineJoin='round';
      const palms=[{x:W*0.12,y:H-18},{x:W*0.35,y:H-22},{x:W*0.62,y:H-16},{x:W*0.85,y:H-18}];
      palms.forEach(p=>{
        const topY=p.y-72;
        ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.quadraticCurveTo(p.x-1,p.y-35,p.x+2,topY); ctx.stroke();
        const fronds=[[-32,-10,-46,-26],[-22,-22,-36,-42],[0,-28,-4,-46],[22,-22,38,-34],[32,-10,48,-18]];
        fronds.forEach(([dx1,dy1,dx2,dy2])=>{ ctx.beginPath(); ctx.moveTo(p.x+2,topY); ctx.quadraticCurveTo(p.x+dx1*0.6,topY+dy1*0.6,p.x+dx2,topY+dy2); ctx.stroke(); });
        ctx.fillStyle=lineColor; ctx.globalAlpha=0.16;
        ctx.beginPath(); ctx.arc(p.x-2,topY+4,2.2,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(p.x+5,topY+6,1.9,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle=lineColor; ctx.globalAlpha=0.16; ctx.fillStyle=lineColor;
      });
      // speck
      ctx.fillStyle=css('--ink')||themeInk; ctx.globalAlpha=0.09;
      for(let dx=12; dx<W; dx+=46){ for(let dy=12; dy<H; dy+=46){ ctx.beginPath(); ctx.arc(dx,dy,1,0,Math.PI*2); ctx.fill(); }}
      for(let dx=34; dx<W; dx+=52){ for(let dy=28; dy<H; dy+=52){ ctx.beginPath(); ctx.arc(dx,dy,0.9,0,Math.PI*2); ctx.fill(); }}
      ctx.globalAlpha=1; ctx.lineCap='round'; ctx.lineJoin='round';
    } else {
      // office / default, sketchpad, etc. - dot grid
      if(canvasDot){
        ctx.fillStyle = canvasDot;
        ctx.beginPath();
        for(let dx=0; dx<=W; dx+=26){
          for(let dy=0; dy<=H; dy+=26){
            ctx.moveTo(dx+1, dy);
            ctx.arc(dx, dy, 1, 0, Math.PI*2);
          }
        }
        ctx.fill();
      }
    }
    // stage glow wash - ellipse at 50% 0% (top centre) - matches .stage:before
    const glow = css('--stage-glow');
    if(glow && glow!=='transparent' && glow!=='none' && glow.includes('rgba')){
      const m=glow.match(/rgba?\([^)]+\)/);
      if(m){
        // Use elliptical gradient via scaled circle to match CSS ellipse
        ctx.save();
        // CSS ellipse at top: scale Y to 0.6 to get wide ellipse
        ctx.scale(1, 0.6);
        const r = Math.max(W, H/0.6) * 0.85;
        const g = ctx.createRadialGradient(W/2, 0, 0, W/2, 0, r);
        g.addColorStop(0, m[0]);
        g.addColorStop(0.6, 'transparent');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle=g;
        ctx.fillRect(0, 0, W, H/0.6);
        ctx.restore();
      }
    }
  };
  drawLookBg();
  ctx.translate(-minx+pad,-miny+pad);

  // Edges - mirror drawEdges() exactly so every layout + style matches live
  ctx.lineCap='round'; ctx.lineJoin='round';
  const _sc = (typeof STYLE_CONFIG_DEFAULTS!=='undefined' && STYLE_CONFIG_DEFAULTS[mapStyle])
    ? { ...STYLE_CONFIG_DEFAULTS[mapStyle], ...((map.styleConfig||{})[mapStyle]||{}) }
    : null;
  ids.forEach(i=>{
    const n=map.nodes[i]; if(!n.parent||hidden.has(n.parent)) return;
    const p=map.nodes[n.parent]; if(!p) return;
    // Reproduce drawEdges() branching: timeline/radial/grid/matrix/down vs generic
    let d=null, x1,y1,x2,y2,leftSide=(n.side==='left'),horizontal=true;
    if(mapLayout==='timeline' && n.parent!==map.rootId){
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncy=n.y+(n.h||0)/2;
      const sx=pcx, sy = ncy<pcy ? p.y : p.y+(p.h||0);
      d = `M${sx},${sy} L${sx},${ncy} L${n.x},${ncy}`;
    } else if(mapLayout==='stair' && n.parent!==map.rootId){
      d = stairEdgePath(p, n);
    } else if(mapLayout==='radial'){
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncx=n.x+(n.w||0)/2, ncy=n.y+(n.h||0)/2;
      d = `M${pcx},${pcy} L${ncx},${ncy}`;
    } else if(mapLayout==='grid'){
      if(n.parent===map.rootId){
        const sx=p.x+(p.w||0)/2, sy=p.y+(p.h||0);
        const tx=n.x+(n.w||0)/2, ty=n.y;
        const mid=(sy+ty)/2;
        d = `M${sx},${sy} L${sx},${mid} L${tx},${mid} L${tx},${ty}`;
      } else {
        const sx=p.x+12, sy=p.y+(p.h||0);
        const ty=n.y+(n.h||0)/2;
        d = `M${sx},${sy} L${sx},${ty} L${n.x},${ty}`;
      }
    } else if(mapLayout==='matrix'){
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0);
      const ncx=n.x+(n.w||0)/2, ncy=n.y;
      d = `M${pcx},${pcy} L${ncx},${ncy}`;
    } else {
      if(mapLayout==='down'){
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
        x2=n.x+(n.w||0)/2; y2=n.y;
      } else if(mapLayout==='up'){
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y;
        x2=n.x+(n.w||0)/2; y2=n.y+(n.h||0);
      } else if(mapLayout==='stair'){
        horizontal=false;
        x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
        x2=n.x+(n.w||0)/2; y2=n.y;
      } else {
        x1=leftSide ? p.x : p.x+(p.w||0); y1=p.y+(p.h||0)/2;
        x2=leftSide ? n.x+(n.w||0) : n.x;  y2=n.y+(n.h||0)/2;
      }
    }
    // Style: respect styleConfig, fallback to theme defaults like CSS does
    let col = (_sc && _sc.edgeColor) ? _sc.edgeColor : null;
    let wid = _sc ? _sc.edgeWidth : null;
    if(col==null){
      if(mapStyle==='bubble' || mapStyle==='neon' || mapStyle==='circuit') col=accent;
      else if(mapStyle==='sketch' || mapStyle==='ink') col=themeInk;
      else col=themeEdge;
    }
    if(wid==null){
      if(mapStyle==='bubble') wid=3;
      else if(mapStyle==='sketch') wid=1.6;
      else if(mapStyle==='classic') wid=1.6;
      else if(mapStyle==='minimal') wid=1.1;
      else if(mapStyle==='neon') wid=2.4;
      else if(mapStyle==='ink') wid=2.6;
      else if(mapStyle==='clay') wid=1.6;
      else wid=2.2;
    }
    let dash = null;
    if(_sc && _sc.dash) dash = _sc.dash>0 ? [ _sc.dash, Math.max(2, Math.round(_sc.dash*0.7)) ] : [];
    else if(mapStyle==='dashed') dash=[7,5];
    else dash=[];
    ctx.strokeStyle=col; ctx.lineWidth=wid;
    ctx.setLineDash(dash||[]);
    if(mapStyle==='neon'){ ctx.shadowColor=col; ctx.shadowBlur=8; }
    ctx.beginPath();
    if(d!==null){
      // Reconstruct SVG path commands on canvas
      const parts=d.split(/(?=[MLC])/); // split before each command
      let first=true;
      for(const seg of parts){
        const c=seg[0]; const nums=seg.slice(1).trim().split(/[\s,]+/).map(Number);
        if(c==='M'){ ctx.moveTo(nums[0],nums[1]); }
        else if(c==='L'){ ctx.lineTo(nums[0],nums[1]); }
        else if(c==='C'){ ctx.bezierCurveTo(nums[0],nums[1],nums[2],nums[3],nums[4],nums[5]); }
      }
    } else if(mapStyle==='classic'){
      if(horizontal){ const mid=(x1+x2)/2; ctx.moveTo(x1,y1); ctx.lineTo(mid,y1); ctx.lineTo(mid,y2); ctx.lineTo(x2,y2); }
      else { const mid=(y1+y2)/2; ctx.moveTo(x1,y1); ctx.lineTo(x1,mid); ctx.lineTo(x2,mid); ctx.lineTo(x2,y2); }
    } else if(mapStyle==='sketch'){
      ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    } else if(mapStyle==='zigzag'){
      const amp=Math.min(12, Math.max(3, (horizontal?Math.abs(x2-x1):Math.abs(y2-y1))/8));
      ctx.moveTo(x1,y1);
      for(let zi=1;zi<=3;zi++){
        const t=zi/4, bx=x1+(x2-x1)*t, by=y1+(y2-y1)*t, off=(zi%2 ? -amp : amp);
        horizontal ? ctx.lineTo(bx, by+off) : ctx.lineTo(bx+off, by);
      }
      ctx.lineTo(x2,y2);
    } else {
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1+(leftSide?-dx:dx),y1, x2+(leftSide?dx:-dx),y2, x2,y2);
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1,y1+dy, x2,y2-dy, x2,y2);
      }
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  // Cross-links - dotted accent curves (match the on-screen rendering)
  if(map.links && map.links.length){
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 6]);
    ctx.globalAlpha = 0.85;
    map.links.forEach(lk=>{
      const a=map.nodes[lk.from], b=map.nodes[lk.to];
      if(!a||!b||hidden.has(lk.from)||hidden.has(lk.to)) return;   // a folded-away endpoint still has coordinates but isn't in the exported bounds - drawing to it sends the curve off-canvas
      const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
      const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
      const mx=(ax+bx)/2, my=(ay+by)/2;
      const dx=bx-ax, dy=by-ay; const len=Math.hypot(dx,dy)||1;
      const off=Math.min(60, len*0.18);
      const cx=mx-(dy/len)*off, cy=my+(dx/len)*off;
      ctx.beginPath(); ctx.moveTo(ax,ay); ctx.quadraticCurveTo(cx,cy,bx,by); ctx.stroke();
    });
    ctx.restore();
  }

  // Nodes - radius per style, respecting styleConfig like live CSS (modern 12, classic 4/6 root, bubble 999, sketch 3, dashed 14, minimal 6/8 root, zigzag 2, neon 10)
  const _styleCfg = (typeof STYLE_CONFIG_DEFAULTS!=='undefined' && STYLE_CONFIG_DEFAULTS[mapStyle])
    ? { ...STYLE_CONFIG_DEFAULTS[mapStyle], ...((map.styleConfig||{})[mapStyle]||{}) } : null;
  const _baseRadius = _styleCfg ? _styleCfg.radius : (mapStyle==='bubble'?999: mapStyle==='classic'?4: mapStyle==='sketch'?3: mapStyle==='dashed'?14: mapStyle==='minimal'?6: mapStyle==='zigzag'?2: mapStyle==='neon'?10:12);
  const roll = computeRollups();
  // Small pill badge (task-progress / token-count), matching the on-screen corner style.
  const drawPillBadge = (text, x, yTop, bg, fg) => {
    ctx.font = 'bold 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    const tw = ctx.measureText(text).width;
    const padX=7, ph=15, pw=tw+padX*2;
    roundRect(ctx, x, yTop, pw, ph, ph/2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth=1.5; ctx.strokeStyle=themeNodeBg; ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, x+pw/2, yTop+ph/2+0.5);
    ctx.textAlign='start';
  };
  ids.forEach(i=>{
    const n=map.nodes[i]; const isRoot=(i===map.rootId);
    const w=n.w||120, h=n.h||40;
    const baseR = _baseRadius;
    const radius = isRoot ? (mapStyle==='classic' ? 6 : mapStyle==='minimal' ? 8 : baseR) : baseR;
    const r = Math.min(radius, h/2);
    // Detect formula early for border/badges/text
    let _isFormula=false, _formulaVal=null;
    try{
      const _plainEarly = (typeof nodeTextPlain==='function' ? nodeTextPlain(n.text||'') : String(n.text||'')).trim();
      if(_plainEarly.startsWith('=')){
        _isFormula=true;
        _formulaVal = (typeof computeNodeValue==='function' ? computeNodeValue(i) : null);
      }
    }catch(e){}
    roundRect(ctx, n.x, n.y, w, h, r);
    if(isRoot){
      const _hex = map.color || accent;
      if(mapStyle==='ink'){
        ctx.fillStyle = _hex;
      } else {
        try{
          const _dark = (typeof shade==='function' ? shade(_hex, -22) : _hex);
          const _grad = ctx.createLinearGradient(n.x, n.y, n.x+w, n.y+h);
          _grad.addColorStop(0, _hex);
          _grad.addColorStop(1, _dark);
          ctx.fillStyle = _grad;
        } catch(e){ ctx.fillStyle = _hex; }
      }
    } else {
      const _hasColor = n.color && n.color!=='#fff' && n.color!=='#ffffff';
      ctx.fillStyle = _hasColor ? n.color
        : (zd[i] && zd[i]%2===1 ? zebraA : (zd[i] ? zebraB : themeNodeBg));
    }
    ctx.fill();
    const shouldStroke = (() => {
      if(mapStyle==='bubble') return false;
      if(mapStyle==='sketch' && isRoot) return false;
      if((mapStyle==='modern' || mapStyle==='dashed') && isRoot) return false;
      return true;
    })();
    if(shouldStroke){
      if(mapStyle==='minimal'){ ctx.strokeStyle=themeLine; ctx.lineWidth=1; }
      else if(mapStyle==='neon'){ ctx.strokeStyle=accent; ctx.lineWidth=1.2; ctx.shadowColor=accent; ctx.shadowBlur=10; }
      else if(mapStyle==='zigzag'){ ctx.strokeStyle=themeLine; ctx.lineWidth=2; }
      else if(mapStyle==='sketch'){ ctx.strokeStyle=themeInk; ctx.lineWidth=2; }
      else if(mapStyle==='classic'){ ctx.strokeStyle=themeLine; ctx.lineWidth=1.5; }
      else if(mapStyle==='dashed'){ ctx.strokeStyle=themeLine; ctx.lineWidth=1.5; }
      else if(mapStyle==='circuit'){ ctx.strokeStyle=accent; ctx.lineWidth=1.5; ctx.shadowColor=accent; ctx.shadowBlur=6; }
      else if(mapStyle==='blueprint'){ ctx.strokeStyle=themeInk; ctx.lineWidth=1.5; ctx.setLineDash([6,4]); }
      else if(mapStyle==='clay'){ ctx.strokeStyle=themeLine; ctx.lineWidth=1; ctx.shadowColor=themeInk; ctx.shadowBlur=8; }
      else if(mapStyle==='ink'){ ctx.strokeStyle=themeInk; ctx.lineWidth=3; }
      else if(mapStyle==='paper'){ ctx.strokeStyle=themeLine; ctx.lineWidth=1; }
      else { ctx.strokeStyle=themeLine; ctx.lineWidth=1.5; }
      ctx.stroke();
      if(mapStyle==='blueprint') ctx.setLineDash([]);
      if(mapStyle==='ink'){ ctx.save(); ctx.shadowColor=themeInk; ctx.shadowBlur=0; ctx.strokeStyle=themeInk; ctx.lineWidth=1; ctx.globalAlpha=0.18; ctx.strokeRect(n.x+2, n.y+2, w, h); ctx.restore(); }
      ctx.shadowBlur = 0;
    }
    if(_isFormula && _formulaVal && _formulaVal.error){
      ctx.strokeStyle='#e5484d'; ctx.lineWidth=1.5; ctx.stroke();
    }
    // Reference node - distinct left border + italic, like live .node.ref-node
    if(n.ref){
      ctx.save();
      // clip to node shape then draw 4px left border in accent
      roundRect(ctx, n.x, n.y, w, h, r);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.fillRect(n.x, n.y, 4, h);
      ctx.restore();
    }
    // Text - pick a color that contrasts with the node background, and exact font
    // matching the live look - --sans/--serif + handwritten/sketchpad scale + lookConfig nodeSize
    const _hasColor2 = n.color && n.color!=='#fff' && n.color!=='#ffffff';
    const _zebraBg = zd[i] && zd[i]%2===1 ? zebraA : (zd[i] ? zebraB : themeNodeBg);
    const bg = isRoot ? (map.color || accent) : (_hasColor2 ? n.color : _zebraBg);
    const textFill = n.textColor || (isRoot ? pickContrast(bg) : (_hasColor2 ? pickContrast(n.color) : themeInk));
    const sans = css('--sans') || '"Bricolage Grotesque",system-ui,sans-serif';
    const serif = css('--serif') || sans;
    let fontPx = n.fontSize || (isRoot ? 19 : 15);
    // look font-size scaling (handwritten 1.2em) + lookConfig nodeSize
    const lookScale = (look==='handwritten' ? 1.2 : look==='sketchpad' ? 1.15 : 1) * (parseFloat(css('--look-node-size')) || 1);
    if(!n.fontSize) fontPx = Math.round(fontPx * lookScale);
    const fontFamily = isRoot ? serif : sans;
    ctx.textBaseline='middle';
    // Padding per style: bubble has wider pads (11/22 vs 9/15), others use default
    const insetX = (() => {
      if(mapStyle==='bubble') return isRoot ? 26 : 22;
      return isRoot ? 22 : 15;
    })();
    // Node image - drawn first, at the top, so text/checkbox center in the space below it
    let imgDrawH = 0;
    const img = imgMap[i];
    if(img){
      const contentW = w - insetX*2;
      imgDrawH = Math.min(280, contentW * (img.naturalHeight/img.naturalWidth || 1));
      const imgY = n.y + (isRoot?14:10);
      ctx.save();
      roundRect(ctx, n.x+insetX, imgY, contentW, imgDrawH, 8);
      ctx.clip();
      ctx.drawImage(img, n.x+insetX, imgY, contentW, imgDrawH);
      ctx.restore();
      imgDrawH += (isRoot?14:10)+6;   // top offset + the CSS's 6px margin-bottom, so text centers below it correctly
    }
    // Formula / frontmatter badges - match live ::before pseudo-elements
    if(_isFormula){
      ctx.save();
      ctx.fillStyle = (_formulaVal && _formulaVal.error) ? '#e5484d' : accent;
      ctx.beginPath(); ctx.arc(n.x-7+8, n.y-7+8, 8, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 7px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('fx', n.x-7+8, n.y-7+8+0.5);
      ctx.restore();
    } else if(n.frontmatter){
      const _fw = ctx.measureText('YAML').width + 10;
      ctx.save();
      ctx.fillStyle = css('--teal') || '#2f6f6a';
      roundRect(ctx, n.x+8, n.y-9, _fw, 12, 4);
      ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 7px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('YAML', n.x+8+_fw/2, n.y-9+6);
      ctx.restore();
    }
    const textCenterY = n.y + imgDrawH + (h-imgDrawH)/2;
    // Highlight (background per text) - node-wide for the canvas export
    if(n.highlight){
      ctx.fillStyle = n.highlight;
      ctx.fillRect(n.x+insetX-2, n.y+imgDrawH+4, w-insetX*2+4, h-imgDrawH-8);
    }
    const baseX = n.x+insetX;
    let textX = baseX, textMaxWidth = w-insetX*2;
    // Marker badge - drawn before the task box so export order matches the DOM.
    if(n.marker){
      ctx.font='15px sans-serif'; ctx.textAlign='start'; ctx.textBaseline='middle';
      ctx.fillStyle=textFill;
      ctx.fillText(n.marker, textX, textCenterY);
      const mw=ctx.measureText(n.marker).width+6;
      textX += mw; textMaxWidth -= mw;
    }
    // Task checkbox - 18px box + 7px gap, matching .task-check's live CSS exactly
    if(n.task){
      const boxSize=18, boxY=textCenterY-boxSize/2, boxX=textX;
      roundRect(ctx, boxX, boxY, boxSize, boxSize, 5);
      ctx.fillStyle = n.task==='done' ? '#4a9d5b' : themeNodeBg;
      ctx.fill();
      ctx.strokeStyle = n.task==='doing' ? '#c98a1a' : (n.task==='done' ? '#4a9d5b' : line2);
      ctx.lineWidth=2; ctx.stroke();
      if(n.task==='done'||n.task==='doing'){
        ctx.font='bold 12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle = n.task==='done' ? '#fff' : '#c98a1a';
        ctx.fillText(n.task==='done'?'\u2713':'\u25D0', boxX+boxSize/2, boxY+boxSize/2+1);
        ctx.textAlign='start';
      }
      textX = boxX+boxSize+7; textMaxWidth -= boxSize+7;
    }
    // Clip text to node bounds so it never leaks outside rounded rect (like live CSS overflow)
    ctx.save();
    roundRect(ctx, n.x, n.y, w, h, r);
    ctx.clip();
    // Special node types: hr, block html, formula (=SUM...), or rich text
    let htmlForExport = n.text||'';
    if(n.hr){
      // hr-node: 54px line centered, like live .node.hr-node .node-hr (uses --ink-soft)
      const _hrCol = css('--ink-soft') || textFill;
      ctx.strokeStyle = _hrCol; ctx.globalAlpha=0.6; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(n.x + w/2 - 27, textCenterY); ctx.lineTo(n.x + w/2 + 27, textCenterY); ctx.stroke();
      ctx.globalAlpha=1;
      ctx.restore();
    } else if(_isFormula){
      // Formula node: show computed result (or #ERROR), like live .formula-node
      const _isTaskDone = n.task==='done';
      const _prevAlpha = ctx.globalAlpha;
      if(_isTaskDone) ctx.globalAlpha = 0.62;
      let _txt='', _col=textFill;
      if(_formulaVal && typeof _formulaVal==='object' && _formulaVal.error){
        _txt='#ERROR'; _col='#e5484d';
        // live also tints border red; reflect by stroking already-clipped border would be outside clip, so skip
      } else {
        try{ _txt = (typeof formatFormulaResult==='function' ? formatFormulaResult(_formulaVal) : String(_formulaVal)); } catch(e){ _txt=String(_formulaVal); }
      }
      ctx.fillStyle=_col;
      // Use same font handling as live formula (tabular nums, but canvas can't easily set that)
      const _f = (_isTaskDone||!!n.strike ? 'line-through ' : '') + (n.underline?'underline ':'') + ((!!n.bold||isRoot)?'bold ':'500 ') + (n.italic||!!n.ref?'italic ':'') + fontPx+'px '+fontFamily;
      // Simple center/align draw for formula result (single line)
      ctx.font=((!!n.bold||isRoot)?'bold ':'500 ') + (n.italic||!!n.ref?'italic ':'') + fontPx+'px '+fontFamily;
      ctx.textAlign = n.align==='left' ? 'left' : n.align==='right' ? 'right' : 'center';
      const _fx = n.align==='left' ? textX : n.align==='right' ? textX+textMaxWidth : textX+textMaxWidth/2;
      // Draw with strike-through if needed
      ctx.fillText(_txt, _fx, textCenterY);
      if(n.underline || _isTaskDone || n.strike){
        const _w = ctx.measureText(_txt).width;
        const _x0 = n.align==='left' ? _fx : n.align==='right' ? _fx-_w : _fx-_w/2;
        ctx.strokeStyle=_col; ctx.lineWidth=Math.max(1,fontPx/15); ctx.beginPath();
        const _ly = _isTaskDone||n.strike ? (textCenterY - fontPx*0.18) : (textCenterY + fontPx*0.38);
        ctx.moveTo(_x0, _ly); ctx.lineTo(_x0+_w, _ly); ctx.stroke();
      }
      if(_isTaskDone) ctx.globalAlpha=_prevAlpha;
      ctx.textAlign='start';
      ctx.restore();
    } else {
      if(n.html){
        htmlForExport = n.html;
      }
      const _isTaskDone = n.task==='done';
      const _prevAlpha = ctx.globalAlpha;
      if(_isTaskDone) ctx.globalAlpha = 0.62;
      if(containsMath(htmlForExport)){
        drawNodeMath(ctx, htmlForExport, {
          x: textX, y: textCenterY, maxWidth: textMaxWidth,
          fontPx, color: textFill, family: fontFamily,
          bold: !!n.bold || isRoot, align: n.align || 'center', listType: n.listType || null
        });
      } else {
        drawFormattedText(ctx, htmlForExport, {
      favicons,
      x: textX,
      y: textCenterY,
      maxWidth: textMaxWidth,
      fontPx,
      color: textFill,
      family: fontFamily,
      baseBold: !!n.bold || isRoot,
      baseItalic: !!n.italic || !!n.ref,
      baseUnderline: !!n.underline,
      baseStrike: !!n.strike || _isTaskDone,
      align: n.align || 'center',
      listType: n.listType || null
    });
      }
      if(_isTaskDone) ctx.globalAlpha = _prevAlpha;
      ctx.restore();
    }
    // Notes indicator - sticky note, like live .notes-mark
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const cx = (n.side==='left') ? n.x + 4 : n.x + w - 4;
      const cy = n.y + 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI*2);
      ctx.fillStyle = stickyBg;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = stickyEdge;
      ctx.stroke();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = stickyInk;
      ctx.fillText('📝', cx, cy);
      ctx.textAlign = 'start';   // restore
      ctx.textBaseline = 'middle';
    }
    // Task-progress roll-up badge - top-left pill, like live .task-progress
    const prog = {done:roll.tdone[i], total:roll.ttot[i]};
    if(prog.total>0 && !n.task){
      const complete = prog.done===prog.total;
      drawPillBadge(`\u2713 ${prog.done}/${prog.total}`, n.x-6, n.y-9, complete?'#4a9d5b':toolbarBg, complete?'#fff':toolbarText);
    }
    // Token-count badge - bottom-left pill, same threshold as the on-screen version
    const tokens = estimateTokens(n.text, n.notes);
    if(tokens>=25){
      drawPillBadge(`~${tokens}t`, n.x-6, n.y+h-6, toolbarBg, toolbarText);
    }
    // Reference/citation mark - top-left circle with a 📖 glyph
    if(n.ref){
      const cx=n.x-9+11, cy=n.y-9+11;
      ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI*2);
      ctx.fillStyle=themeNodeBg; ctx.fill();
      ctx.lineWidth=1.5; ctx.strokeStyle=accent; ctx.stroke();
      ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=themeInk; ctx.fillText('📖', cx, cy);
      ctx.textAlign='start';
    }
  });

  try{
    cv.toBlob(b=>{download(b,(map.title||'mindmap')+'.png');toast('PNG exported');});
  }catch(e){
    // Only reachable if the canvas got tainted despite the CORS guard above.
    console.warn('PNG export failed:', e.message);
    toast('Could not export the PNG');
  }
}

// Render text (possibly containing inline <b>/<i>/<u>/<s>/<a>/<br>/<ul>/<ol>/<li>)
// onto a canvas context at the given centre point, with word-wrap and per-line
// alignment. This is what makes the PNG export look like the browser render.
function drawFormattedText(ctx, html, opts){
  const { x, y, maxWidth, fontPx, color, family, baseBold, baseItalic, baseUnderline, baseStrike, align, listType } = opts;
  // Step 1: walk the HTML, collecting "runs" each with a formatting state.
  // \n separators come from <br>, end-of-li, and end-of-p/div blocks.
  const tmp = document.createElement('div');
  tmp.innerHTML = (html || '').toString();
  const runs = [];
  // legacy listType (whole-node bullets) - render as if each line of plain text
  // were wrapped in a <li>. Prefix marker is unformatted (like live .list-marker opacity .7) - not bold/italic.
  if(listType && !INLINE_HTML_RE.test(html||'')){
    const lines = (html||'').split('\n');
    lines.forEach((line, i)=>{
      const prefix = listType==='ol' ? `${i+1}. ` : '• ';
      runs.push({ text:prefix, bold:false, italic:false, underline:false, strike:false, link:false });
      if(line) runs.push({ text:line, bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike, link:false });
      if(i < lines.length-1) runs.push({ text:'\n', bold:false,italic:false,underline:false,strike:false, link:false });
    });
  } else {
    const walk = (node, st) => {
      node.childNodes.forEach(child => {
        if(child.nodeType === 3){
          // Split on \n so embedded newlines (Shift+Enter while editing) become
          // real line breaks in the export, not whitespace.
          const v = (child.nodeValue || '').replace(/\u00A0/g,' ');
          if(!v) return;
          const parts = v.split('\n');
          parts.forEach((p, i) => {
            if(i > 0) runs.push({ text:'\n', ...st });
            if(!p) return;
            // Auto-detect raw URLs the same way the live DOM does
            // (appendTextWithLinks) - the stored node content never contains
            // an <a> tag for these (that wrapping is display-only, applied
            // fresh on every live render, never saved) so without this the
            // export has no way to know a plain-text segment is a link at
            // all, and just draws the raw URL as ordinary text.
            URL_RE.lastIndex = 0;
            let last = 0, m;
            let matched = false;
            while((m = URL_RE.exec(p)) !== null){
              matched = true;
              if(m.index > last) runs.push({ text:p.slice(last, m.index), ...st });
              let _fh=''; try{ _fh=new URL(m[0]).hostname.replace(/^www\./,''); }catch(_){}
              runs.push({ text:prettyUrl(m[0]), ...st, link:true, underline:true, favHost:_fh });
              last = m.index + m[0].length;
            }
            if(matched){ if(last < p.length) runs.push({ text:p.slice(last), ...st }); }
            else runs.push({ text:p, ...st });
          });
        } else if(child.nodeType === 1){
          const tag = child.tagName.toLowerCase();
          const next = { ...st };
          if(tag==='b'||tag==='strong') next.bold = true;
          if(tag==='i'||tag==='em')     next.italic = true;
          if(tag==='u')                 next.underline = true;
          if(tag==='s'||tag==='strike') next.strike = true;
          if(tag==='a'){ next.link = true; next.underline = true; }
          if(tag==='br'){ runs.push({ text:'\n', ...st }); return; }
          if(tag==='li'){
            // Push bullet/number prefix - unformatted like live native bullets (not bold/italic)
            const isOL = child.parentElement && child.parentElement.tagName==='OL';
            const idx = child.parentElement ? Array.from(child.parentElement.children).indexOf(child)+1 : 1;
            runs.push({ text:(isOL ? `${idx}. ` : '• '), bold:false, italic:false, underline:false, strike:false, link:false });
          }
          walk(child, next);
          if(['li','p','div','h1','h2','h3','blockquote','pre','ul','ol','table','tr'].includes(tag)) runs.push({ text:'\n', ...st });
        }
      });
    };
    walk(tmp, { bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike, link:false });
  }

  if(runs.length===0) return;

  // Step 2: word-wrap into lines. Each line = array of {text, w, bold, italic, underline, strike}
  const setFont = (run) => {
    let f='';
    if(run.italic) f += 'italic ';
    f += (run.bold ? 'bold ' : '500 ') + fontPx + 'px ' + family;
    ctx.font = f;
  };
  const lines = [[]];
  let curW = 0;
  // Favicons are preloaded by the caller (exportPNG) before we get here, so a
  // missing or failed one is already known at measure time - that matters,
  // because the icon's width has to be reserved during wrapping, not at draw
  // time. `favicons` is keyed by hostname; a null value means "did not load",
  // in which case nothing is reserved and nothing is drawn.
  const favicons = opts.favicons || {};
  const iconW = Math.round(fontPx * 1.15);   // icon box + trailing gap
  runs.forEach(run => {
    if(run.text === '\n'){ lines.push([]); curW = 0; return; }
    // Keep whitespace as separate chunks so wrapping breaks on it
    const parts = run.text.split(/(\s+)/);
    let firstChunk = true;
    parts.forEach(part => {
      if(!part) return;
      setFont(run);
      // Only the first visible chunk of a link run carries the icon - a
      // wrapped URL must not repeat it on every line.
      let fav = (firstChunk && run.favHost && favicons[run.favHost]) ? favicons[run.favHost] : null;
      let w = ctx.measureText(part).width + (fav ? iconW : 0);
      // Handle long words without spaces that exceed maxWidth - break anywhere
      // like CSS `overflow-wrap:anywhere` (live DOM does). Split into fitting chunks.
      if(part.trim() && w > maxWidth){
        let remaining = part;
        let isFirstSub = true;
        while(remaining){
          // binary search longest prefix that fits
          let low=1, high=remaining.length, best=1;
          while(low<=high){
            const mid=Math.floor((low+high)/2);
            const prefix=remaining.slice(0,mid);
            setFont(run);
            const pw=ctx.measureText(prefix).width + (isFirstSub && fav ? iconW : 0);
            if(pw <= maxWidth){ best=mid; low=mid+1; } else high=mid-1;
          }
          const chunk=remaining.slice(0,best);
          setFont(run);
          const cw=ctx.measureText(chunk).width + (isFirstSub && fav ? iconW : 0);
          if(curW + cw > maxWidth && lines[lines.length-1].length>0){
            lines.push([]); curW=0;
          }
          const chunkFav = isFirstSub ? fav : null;
          lines[lines.length-1].push({ text:chunk, w:cw, bold:run.bold, italic:run.italic, underline:run.underline, strike:run.strike, link:run.link, fav:chunkFav });
          curW += cw;
          if(cw >= maxWidth - 1){ lines.push([]); curW=0; }
          remaining=remaining.slice(best);
          isFirstSub=false; fav=null;
          firstChunk=false;
        }
        return;
      }
      if(curW + w > maxWidth && lines[lines.length-1].length > 0 && part.trim()){
        lines.push([]); curW = 0;
      }
      lines[lines.length-1].push({ text:part, w, bold:run.bold, italic:run.italic, underline:run.underline, strike:run.strike, link:run.link, fav });
      curW += w;
      if(part.trim()) firstChunk = false;
    });
  });
  while(lines.length > 1 && lines[lines.length-1].length === 0) lines.pop();

  // Step 3: draw. Vertically centre block around y.
  const lineH = Math.round(fontPx * 1.35);
  const totalH = lines.length * lineH;
  let yy = y - totalH/2 + lineH/2;
  // Hyperlink colour (resolved from CSS var so it matches the live theme)
  const linkColor = (typeof getComputedStyle === 'function')
    ? (getComputedStyle(document.documentElement).getPropertyValue('--link').trim() || '#3a6ea5')
    : '#3a6ea5';
  ctx.fillStyle = color;
  lines.forEach(line => {
    const lineW = line.reduce((s, r) => s + r.w, 0);
    let xx = x;
    if(align === 'center') xx = x + (maxWidth - lineW)/2;
    else if(align === 'right') xx = x + (maxWidth - lineW);
    line.forEach(run => {
      setFont(run);
      const runColor = run.link ? linkColor : color;
      ctx.fillStyle = runColor;
      let tx = xx;
      if(run.fav){
        const box = Math.round(fontPx * 0.9);
        try{ ctx.drawImage(run.fav, xx, yy - box*0.78, box, box); }
        catch(e){ /* never let a bad icon abort the whole export */ }
        tx += iconW;
      }
      ctx.fillText(run.text, tx, yy);
      if(run.underline || run.strike){
        ctx.strokeStyle = runColor;
        ctx.lineWidth = Math.max(1, fontPx/15);
        ctx.beginPath();
        const ly = run.underline ? (yy + fontPx*0.38) : (yy - fontPx*0.18);
        // Underline only the text, not the icon.
        ctx.moveTo(tx, ly); ctx.lineTo(xx + run.w, ly);
        ctx.stroke();
      }
      xx += run.w;
    });
    yy += lineH;
  });
}
// Pick black-or-white for best contrast against a hex background
function pickContrast(hex){
  const h = (hex||'').replace('#','');
  if(h.length < 6) return '#23201b';
  const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  // luminance roughly per WCAG
  const L = (0.299*r + 0.587*g + 0.114*b) / 255;
  return L > 0.6 ? '#23201b' : '#ffffff';
}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function wrapText(ctx,text,x,y,maxW,lh){const words=text.split(/\s+/);let line='',lines=[];words.forEach(w=>{const t=line?line+' '+w:w;if(ctx.measureText(t).width>maxW&&line){lines.push(line);line=w;}else line=t;});if(line)lines.push(line);const startY=y-(lines.length-1)*lh/2;lines.forEach((l,i)=>ctx.fillText(l,x,startY+i*lh));}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

/* ---------- toast ---------- */
let toastT;function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2000);}

/* ============================================================
   WIRE UP
   ============================================================ */
$('#newMap').onclick=createMap;
$('#emptyNew').onclick=createMap;
$('#addChild').onclick=()=>{ if(!map)return; addNode(sel||map.rootId,false); };
// Before printing, fit the whole map into view so nothing is clipped on paper.
let _rzReframeT=null;
window.addEventListener('resize', ()=>{
  _rzCache=null;   // browser zoom / OS display scaling may have changed - re-measure on next _uiZ() call
  clearTimeout(_rzReframeT);
  _rzReframeT=setTimeout(()=>{
    if(!map){ _markStage(); return; }
    _recenterForStageChange();
    updateMinimap();
  }, 160);
});
window.addEventListener('beforeprint', ()=>{ try{ fit(); }catch(e){} });

$('#layout').onclick=autoLayout;            // re-tidies node positions (does NOT move the camera)
// Collapse-all / expand-all toggle. If any collapsible node is currently
// expanded, the first click collapses everything; otherwise it expands all.
// Animates as an incremental cascade rather than jumping straight to the final state:
// collapsing proceeds deepest-branch-first (so a parent doesn't visually swallow a
// still-open child), expanding proceeds shallowest-first (children reveal only after
// their own parent has opened) - the same ordering tree UIs like VS Code's file
// explorer or Notion's outline use for a "collapse/expand all".
// "Collapse/expand all branches" steps the WHOLE map one depth level per click instead
// of jumping straight to fully expanded or fully collapsed. Collapsing closes the
// deepest still-open branch level first (so a shallow branch never visually swallows a
// still-open child); expanding opens the shallowest still-closed branch level first
// (children only reveal once their own parent has opened). Repeated clicks cycle:
// expand, expand, ... fully open -> collapse, collapse, ... fully closed -> expand
// again. The map's actual root is never itself a candidate to collapse - that would
// hide the whole map - only its descendants are.
let _collapseAllDir=null;
function stepCollapseAll(){
  if(!map) return null;
  // Unconditional walk: how many depth levels the WHOLE tree has, regardless of the
  // current fold state - this is only for reporting progress ("expanded 2/4"), not for
  // deciding what to fold/unfold below (that still only ever looks at what's currently
  // reachable, via the visibility-respecting walk further down).
  let totalDepth=-1;
  const walkAll=(id, depth)=>{
    childrenOf(id).forEach(c=>{
      if(childrenOf(c).length){ if(depth>totalDepth) totalDepth=depth; walkAll(c, depth+1); }
    });
  };
  walkAll(map.rootId, 0);
  const totalLevels=totalDepth+1;
  if(totalLevels<=0) return null;

  const branches=[];
  const walk=(id, depth)=>{
    childrenOf(id).forEach(c=>{
      if(childrenOf(c).length){
        branches.push({id:c, depth});
        if(!map.nodes[c].collapsed) walk(c, depth+1);
      }
    });
  };
  walk(map.rootId, 0);
  const hidden=branches.filter(b=>map.nodes[b.id].collapsed);
  const fullyExpanded=hidden.length===0;
  const openBranches=branches.filter(b=>!map.nodes[b.id].collapsed);
  const fullyCollapsed=openBranches.length===0;

  let dir=_collapseAllDir;
  if(!dir) dir = fullyExpanded ? 'collapse' : 'expand';   // no memory yet -> infer from current state
  if(dir==='collapse' && fullyCollapsed) dir='expand';     // exhausted (fully closed) -> flip
  if(dir==='expand' && fullyExpanded) dir='collapse';      // exhausted (fully open) -> flip
  _collapseAllDir=dir;

  if(dir==='expand'){
    const minDepth=Math.min(...hidden.map(b=>b.depth));
    hidden.filter(b=>b.depth===minDepth).forEach(b=>{ map.nodes[b.id].collapsed=false; });
    return {dir, step:minDepth+1, total:totalLevels};        // levels 0..minDepth are now open
  } else {
    const maxDepth=Math.max(...openBranches.map(b=>b.depth));
    openBranches.filter(b=>b.depth===maxDepth).forEach(b=>{ map.nodes[b.id].collapsed=true; });
    return {dir, step:totalLevels-maxDepth, total:totalLevels};   // levels maxDepth..totalLevels-1 are now closed
  }
}
$('#collapseAll')?.addEventListener('click', ()=>{
  if(!map) return;
  const st=stepCollapseAll();
  if(!st) return;
  pushHistory();
  autoLayout();
  const verb=st.dir==='collapse' ? 'Collapsed' : 'Expanded';
  toast(st.step>=st.total ? `${verb} all` : `${verb} ${st.step}/${st.total}`);
});
$('#undo').onclick=undo; $('#redo').onclick=redo;
document.getElementById('mdToggle')?.addEventListener('click',()=>toggleMdMode());
$('#zoomIn').onclick=()=>zoom(1.15); $('#zoomOut').onclick=()=>zoom(.87);
$('#zoomFit').onclick=()=>{ const t=computeFitView(); if(t){ animateViewTo(t,220); userZoom=t.k; } saveMapView(); };
$('#minimap')?.addEventListener('mousedown', e=>{ e.stopPropagation(); minimapJump(e.clientX, e.clientY); });
$('#minimap')?.addEventListener('click', e=>e.stopPropagation());
// Click the zoom % to enter a custom value
(function(){
  const zv=$('#zoomVal');
  zv.addEventListener('click',()=>{
    zv.contentEditable='true';
    zv.textContent=Math.round(view.k*100);   // strip the % for easier editing
    zv.focus();
    const r=document.createRange(); r.selectNodeContents(zv);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const apply=()=>{
    zv.contentEditable='false';
    const v=parseFloat(String(zv.textContent).replace(/[^\d.]/g,''));
    if(Number.isFinite(v) && v>=10 && v<=300) setZoom(v); else applyView();
  };
  zv.addEventListener('blur',apply);
  zv.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); zv.blur(); }
    if(e.key==='Escape'){ e.preventDefault(); applyView(); zv.blur(); }
  });
})();
// Zoom slider - drag maps straight to setZoom() (no animation so the slider
// stays glued to the finger), same 10–300% bounds as the % readout.
$('#zoomSlider')?.addEventListener('input', e=>{ setZoom(parseInt(e.target.value,10)); });
// Overview card (minimap + zoom) collapse toggle, persisted per browser.
const ovToggle=$('#overviewToggle');
ovToggle?.addEventListener('click',()=>{
  const ov=$('#overview');
  const collapsed=ov.classList.toggle('collapsed');
  ovToggle.title=collapsed?'Expand overview':'Collapse overview';
  try{ localStorage.setItem('mindspark:overviewCollapsed', collapsed?'1':'0'); }catch(e){}
});
try{
  const ov=$('#overview'), ovt=$('#overviewToggle');
  if(ov && ovt && localStorage.getItem('mindspark:overviewCollapsed')==='1'){
    ov.classList.add('collapsed'); ovt.title='Expand overview';
  }
}catch(e){}
$('#menuExport').onclick=(e)=>{ e.stopPropagation(); exportMenu(); };
let _sideExpandedW = 268;   // cached logical width of the expanded sidebar
// Collapsed desktop sidebar keeps a slim icon rail instead of vanishing, so
// the reframe delta is (expanded width - rail width), not the whole width.
const SIDE_RAIL_W = 36;
function toggleSidePanel(){
  // Zen write has no grid sidebar - it is a slide-over overlay toggled via side-open
  if(document.body.classList.contains('ui-zen')){
    document.body.classList.toggle('side-open');
    return;
  }
  const side=$('#side');
  // On phones the sidebar is a transform overlay (stage keeps full width), so no
  // reframe is needed there - let CSS slide it.
  const overlay = window.matchMedia('(max-width: 720px)').matches;
  const z=(typeof _uiZ==='function'?(_uiZ()||1):1);
  const wasCollapsed = side.classList.contains('collapsed');
  if(!wasCollapsed){
    const sbNow = side.getBoundingClientRect().width / z;
    if(sbNow > 1) _sideExpandedW = sbNow;          // remember the expanded width
  }
  // Capture the map-point at the viewport centre BEFORE the width changes.
  let cx,cy,has=false;
  if(map && !overlay){ const {w:SW,h:SH}=_stageSize(); cx=(SW/2-view.x)/view.k; cy=(SH/2-view.y)/view.k; has=isFinite(cx)&&isFinite(cy); }
  side.classList.toggle('collapsed');
  // The drag handle writes an inline width, which beats the .side.collapsed
  // CSS rule - clear it while collapsed (or in the mobile overlay) and
  // restore the remembered width when expanding, so the toggle always works
  // even right after a drag-resize.
  if(overlay || side.classList.contains('collapsed')){
    side.style.width='';
  }else{
    side.style.width=Math.max(_sideExpandedW, SIDE_RAIL_W+1)+'px';   // never restore a rail-sized width
  }
  if(has){
    const collapsing = side.classList.contains('collapsed');
    const {w:W0, h:H0} = _stageSize();           // still the pre-animation size this frame
    const delta = Math.max(0, _sideExpandedW - SIDE_RAIL_W);
    const W1 = collapsing ? (W0 + delta) : (W0 - delta);
    _reframeSmooth(cx, cy, W1, H0);
  }
}
$('#toggleSide').onclick=toggleSidePanel;
$('#railToggle')?.addEventListener('click',()=>{
  const side=$('#side');
  if(side.classList.contains('collapsed')) toggleSidePanel();   // reopen from the icon rail
});
// Sidebar tabs: Maps (default) and Templates. Templates renders the same
// catalog as the caret popover, but inline - click an entry to build a map.
function setSideTab(tab){
  const maps=tab==='maps';
  $('#sidePaneMaps').classList.toggle('active',maps);
  $('#sidePaneTpls').classList.toggle('active',!maps);
  $('#sideTabMaps').classList.toggle('active',maps);
  $('#sideTabTpls').classList.toggle('active',!maps);
  if(!maps) renderTplList();
}
function renderTplList(){
  const el=$('#tplList'); if(!el) return;
  el.innerHTML='';
  TEMPLATE_CATEGORIES.forEach(c=>{
    const entries=Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===c.id);
    if(!entries.length) return;
    const hdr=document.createElement('div'); hdr.className='tpl-side-hdr'; hdr.textContent=c.label;
    el.appendChild(hdr);
    entries.forEach(([id,t])=>{
      const item=document.createElement('button'); item.type='button'; item.className='tpl-side-item';
      item.title=t.desc||t.name;
      item.innerHTML='<span class="tpl-side-ic" style="background:'+(t.color||c.color)+'">'+(t.icon||'\u2726')+'</span>'+
        '<span class="tpl-side-meta"><b>'+escapeHtml(t.name)+'</b><i>'+escapeHtml(t.desc||'')+'</i></span>';
      item.addEventListener('click',()=>{ if(typeof createMapFromTemplate==='function') createMapFromTemplate(id); });
      el.appendChild(item);
    });
  });
}
$('#sideTabMaps').onclick=()=>setSideTab('maps');
$('#sideTabTpls').onclick=()=>setSideTab('tpls');
// Draggable sidebar width (desktop). Clamped 180–420px, persisted, and the
// zoom-proof measurement in toggleSidePanel picks up the new width naturally.
(function(){
  const side=$('#side'), h=$('#sideResize'); if(!h) return;
  let dragging=false, startX=0, startW=0;
  h.addEventListener('mousedown',e=>{
    e.preventDefault();
    dragging=true; startX=e.clientX; startW=side.getBoundingClientRect().width;
    side.classList.add('resizing');
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const z=(typeof _uiZ==='function'?(_uiZ()||1):1);
    const w=Math.round(Math.min(420,Math.max(180,(startW+(e.clientX-startX))/z)));
    side.style.width=w+'px';
  });
  const done=()=>{
    if(!dragging) return;
    dragging=false; side.classList.remove('resizing');
    try{ localStorage.setItem('mindspark:sideW', side.style.width); }catch(e){}
  };
  document.addEventListener('mouseup',done);
  window.addEventListener('blur',done);
  try{
    if(!window.matchMedia('(max-width: 720px)').matches){
      const w=localStorage.getItem('mindspark:sideW');
      if(w) side.style.width=w;
    }
  }catch(e){}
})();
// On phones, default the sidebar to collapsed (slid off-screen overlay).
// And tapping the dimmed canvas while it's open should close it.
if(window.matchMedia('(max-width: 720px)').matches){
  $('#side').classList.add('collapsed');
  $('#stage').addEventListener('click', e=>{
    const side=$('#side');
    if(side.classList.contains('collapsed')) return;
    // Only close if the user tapped the dimming overlay (the ::after pseudo) -
    // which sits on top of all the topbar/zoombar at z-index 150. Easiest
    // proxy: tap landed on #stage or #viewport (not on a node or chrome).
    if(e.target.id==='stage' || e.target.id==='viewport'){
      side.classList.add('collapsed');
    }
  });
}
$('#hintClose').onclick=()=>$('#hint').style.display='none';

/* ---------- UI scale (whole-interface zoom, persisted) ---------- */
// Auto scale by viewport size, continuous rather than stepped: interpolates
// linearly between MIN_S at a small/cramped viewport and MAX_S at a spacious one,
// using whichever of width/height is more constrained (so a wide-but-short window
// and a narrow-but-tall window both scale down correctly, not just one axis).
// This is the DEFAULT and stays live - see maybeReapplyAutoScale() below - unless
// the person picks a fixed percentage from the theme panel, which pins it.
const UI_SCALE_RANGE = { minW:1265, maxW:2545, minH:570, maxH:1305, minS:0.8, maxS:1.0 };
function autoScaleForViewport(w,h){
  const {minW,maxW,minH,maxH,minS,maxS}=UI_SCALE_RANGE;
  const clamp01=x=>Math.max(0,Math.min(1,x));
  const tw=clamp01((w-minW)/(maxW-minW)), th=clamp01((h-minH)/(maxH-minH));
  const t=Math.min(tw,th);   // the more cramped dimension decides
  return minS + t*(maxS-minS);
}
function isUiScaleAuto(){
  const v=parseFloat(localStorage.getItem('mindspark:uiScale'));
  return !(v && v>=0.5 && v<=2);
}
function getUiScale(){
  const v=parseFloat(localStorage.getItem('mindspark:uiScale'));
  if(v && v>=0.5 && v<=2) return v;                                   // explicit choice, pinned
  return autoScaleForViewport(window.innerWidth, window.innerHeight);  // auto: tracks the current viewport
}
function applyUiScale(v){
  // CSS `zoom` on the root scales the entire UI uniformly - chrome and canvas -
  // like browser zoom, while keeping pointer/geometry math self-consistent.
  // We also expose the factor as --ui-zoom so full-viewport containers can size
  // themselves to calc(100vh / zoom) - otherwise a 100vh box would render at
  // only `zoom`× the screen height and leave a gap at the bottom.
  const z = (v && v>=0.5 && v<=2) ? v : 1;
  document.documentElement.style.zoom = z!==1 ? String(z) : '';
  document.documentElement.style.setProperty('--ui-zoom', String(z));
  _rzCache=null;   // the browser-zoom probe measurement is now stale - a changed scale invalidates it, same as a window resize would
  // The stage's effective CSS-pixel size just changed with the zoom (more/fewer
  // layout pixels now fit in the same physical viewport) - keep whatever map
  // point was centred still centred, exactly like a window resize does.
  if(typeof stage!=='undefined' && stage) _recenterForStageChange();
  if(typeof updateMinimap==='function' && map) updateMinimap();
}
function setUiScale(v){
  v = Math.min(2, Math.max(0.5, v||1));
  try{ localStorage.setItem('mindspark:uiScale', String(v)); }catch(e){}
  applyUiScale(v);
  toast('Interface scale: '+Math.round(v*100)+'%');
}
function setUiScaleAuto(){
  try{ localStorage.removeItem('mindspark:uiScale'); }catch(e){}
  applyUiScale(getUiScale());
  toast('Interface scale: Auto ('+Math.round(getUiScale()*100)+'%)');
}
// Keeps auto-scale genuinely responsive to the browser window instead of a
// snapshot frozen at whichever size the page happened to load at. Only acts
// while no explicit percentage is pinned, and only re-applies when the computed
// value actually moved (so it doesn't fight a mid-drag node resize/pan with
// zoom recalculation on every pixel of a window drag).
let _uiScaleResizeT=0;
window.addEventListener('resize', ()=>{
  clearTimeout(_uiScaleResizeT);
  _uiScaleResizeT=setTimeout(()=>{
    if(!isUiScaleAuto()) return;
    applyUiScale(getUiScale());
  }, 150);
});

/* ============================================================
   INLINE COLOUR SWATCHES - the VS Code style colour decorator, for
   the JSON textareas in the two theme dialogs.

   VS Code draws a small square in front of every colour literal in a
   CSS file and opens a picker when you click it. A <textarea> cannot
   hold inline widgets, so the square is an absolutely positioned
   button in a layer on top of the text, and a hidden mirror div holds
   the same text with a <span> around each colour literal. Reading
   those spans gives the exact pixel box of every token in one layout
   pass, instead of guessing at character widths (which would drift on
   any look that changes the font). The mirror is styled from the
   textarea's own computed style for the same reason.
   ============================================================ */

// Hex (3/4/6/8 digits) and the functional rgb()/rgba() forms. Deliberately not
// hsl() and not the named colours: themes/*.json and the theme config only ever
// use these two, and a swatch that cannot write the value back in the notation
// the user typed is worse than no swatch at all.
const CSS_COLOR_RE = /#[0-9a-fA-F]{3,8}|rgba?\([^()]*\)/g;

// A CSS colour literal to {r,g,b,a}, or null when it is not one this picker can
// round-trip. Lengths 5 and 7 fall through the hex branch on purpose: they are
// not colours, and the regex above has to be permissive to find the 8 digit form.
function parseCssColor(str){
  if(typeof str !== 'string') return null;
  const clamp=(n,lo,hi)=> n<lo ? lo : (n>hi ? hi : n);
  const s = str.trim();
  if(s[0] === '#'){
    const h = s.slice(1);
    if(!/^[0-9a-fA-F]+$/.test(h)) return null;
    const x = c => parseInt(c.length===1 ? c+c : c, 16);
    if(h.length===3 || h.length===4)
      return { r:x(h[0]), g:x(h[1]), b:x(h[2]), a: h.length===4 ? x(h[3])/255 : 1 };
    if(h.length===6 || h.length===8)
      return { r:x(h.slice(0,2)), g:x(h.slice(2,4)), b:x(h.slice(4,6)),
               a: h.length===8 ? x(h.slice(6,8))/255 : 1 };
    return null;
  }
  const m = /^rgba?\(([^()]*)\)$/i.exec(s);
  if(!m) return null;
  // Splits both the legacy "r, g, b, a" and the modern "r g b / a" syntax.
  const parts = m[1].split(/[,\/\s]+/).map(p=>p.trim()).filter(Boolean);
  if(parts.length < 3 || parts.length > 4) return null;
  const chan = p => {
    const n = parseFloat(p);
    return isFinite(n) ? clamp(Math.round(p.endsWith('%') ? n*2.55 : n), 0, 255) : null;
  };
  const r=chan(parts[0]), g=chan(parts[1]), b=chan(parts[2]);
  if(r===null || g===null || b===null) return null;
  let a = 1;
  if(parts.length===4){
    const n = parseFloat(parts[3]);
    if(!isFinite(n)) return null;
    a = clamp(parts[3].endsWith('%') ? n/100 : n, 0, 1);
  }
  return { r, g, b, a };
}

// Writes a colour back in the notation it was found in, so picking a colour in
// a themes/*.json paste changes the value and nothing else: hex stays hex,
// rgb()/rgba() stays functional and keeps its spacing habit and its short ".07"
// style alpha. An alpha below 1 promotes hex to its 8 digit form.
function formatCssColor(c, like){
  const clamp=(n,lo,hi)=> n<lo ? lo : (n>hi ? hi : n);
  const a = c.a==null ? 1 : clamp(c.a, 0, 1);
  const r=clamp(Math.round(c.r),0,255), g=clamp(Math.round(c.g),0,255), b=clamp(Math.round(c.b),0,255);
  const sample = typeof like==='string' ? like.trim() : '';
  if(sample && sample[0] !== '#'){
    const sep = /,\s/.test(sample) ? ', ' : ',';
    if(a >= 1 && /^rgb\(/i.test(sample)) return `rgb(${[r,g,b].join(sep)})`;
    const av = String(Math.round(a*1000)/1000).replace(/^0\./, '.');
    return `rgba(${[r,g,b,av].join(sep)})`;
  }
  const hex2 = n => n.toString(16).padStart(2,'0');
  const out = '#' + hex2(r) + hex2(g) + hex2(b) + (a >= 1 ? '' : hex2(Math.round(a*255)));
  // Follow the case of the literal being replaced rather than imposing one.
  return /[A-F]/.test(sample) && !/[a-f]/.test(sample) ? out.toUpperCase() : out;
}

// Every colour literal in a block of text, with its offsets. Anything the regex
// catches but parseCssColor rejects is dropped, so a stray "#12345" gets no
// swatch rather than a broken one.
function findColorTokens(text){
  const out = [];
  CSS_COLOR_RE.lastIndex = 0;
  let m;
  while((m = CSS_COLOR_RE.exec(text))){
    const rgba = parseCssColor(m[0]);
    if(rgba) out.push({ start:m.index, end:m.index+m[0].length, text:m[0], rgba });
  }
  return out;
}

function rgbToHsv(c){
  const r=c.r/255, g=c.g/255, b=c.b/255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let h=0;
  if(d){
    if(mx===r) h=((g-b)/d+6)%6;
    else if(mx===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;
  }
  return { h, s: mx ? d/mx : 0, v: mx };
}
function hsvToRgb(h,s,v){
  const f=n=>{ const k=(n+h/60)%6; return Math.round(255*(v - v*s*Math.max(0, Math.min(k, 4-k, 1)))); };
  return { r:f(5), g:f(3), b:f(1) };
}

// Widen the gap between a JSON key and its value so the swatch has blank
// columns to sit in without covering a character. Whitespace between tokens is
// free in JSON, so the text stays exactly as parseable as JSON.stringify left it.
function spaceForSwatches(json){
  return json.replace(/":\s*"/g, '":   "');
}

/* ---------- the picker popup ---------- */

let _csPop = null;
function closeColorPicker(){
  if(!_csPop) return;
  const p = _csPop; _csPop = null;
  document.removeEventListener('mousedown', p._out, true);
  document.removeEventListener('keydown', p._key, true);
  p.remove();
  if(p._form) p._form.classList.remove('cs-peek', 'cs-peek-drag');
  if(p._done) p._done();
}
// Saturation/value square, hue bar, alpha bar and the literal as text: the same
// four controls VS Code shows. opts.onInput fires on every move with the new
// literal, so the textarea (and the canvas behind the dialog) follows the drag.
// opts.owner marks which textarea the anchor button belongs to, so that layer
// can leave itself alone while the picker is anchored to one of its buttons.
function openColorPicker(anchor, initial, opts){
  opts = opts || {};
  closeColorPicker();
  const start = parseCssColor(initial) || { r:255, g:255, b:255, a:1 };
  let hsv = rgbToHsv(start), alpha = start.a;
  const pop = document.createElement('div');
  pop.className = 'cs-pop';
  pop.innerHTML = `
    <div class="cs-sv"><span class="cs-sv-sat"></span><span class="cs-sv-val"></span><i class="cs-dot"></i></div>
    <div class="cs-bar cs-hue"><i class="cs-dot"></i></div>
    <div class="cs-bar cs-alpha"><span class="cs-agrad"></span><i class="cs-dot"></i></div>
    <input class="cs-text" spellcheck="false" aria-label="Colour value">`;
  document.body.appendChild(pop);
  // A modal that hides the map is the wrong shape for choosing a colour FOR the
  // map, so the dialog stops covering it while the picker is open: the backdrop
  // goes clear, and the card itself steps out of the way for the length of a
  // drag. Both are class flips on the dialog, undone in closeColorPicker().
  const form = anchor.closest ? anchor.closest('.var-form') : null;
  if(form) form.classList.add('cs-peek');
  pop._form = form;
  const sv=pop.querySelector('.cs-sv'), hue=pop.querySelector('.cs-hue'),
        al=pop.querySelector('.cs-alpha'), txt=pop.querySelector('.cs-text');
  const svDot=sv.querySelector('.cs-dot'), hueDot=hue.querySelector('.cs-dot'),
        alDot=al.querySelector('.cs-dot'), alGrad=al.querySelector('.cs-agrad');
  const paint=(emit)=>{
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const literal = formatCssColor({ ...rgb, a:alpha }, initial);
    const solid = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
    sv.style.background = `hsl(${hsv.h},100%,50%)`;
    svDot.style.left = (hsv.s*100)+'%';
    svDot.style.top = ((1-hsv.v)*100)+'%';
    svDot.style.background = solid;
    hueDot.style.left = (hsv.h/360*100)+'%';
    hueDot.style.background = `hsl(${hsv.h},100%,50%)`;
    alGrad.style.background = `linear-gradient(to right, rgba(${rgb.r},${rgb.g},${rgb.b},0), ${solid})`;
    alDot.style.left = (alpha*100)+'%';
    alDot.style.background = literal;
    if(document.activeElement !== txt) txt.value = literal;
    if(emit && opts.onInput) opts.onInput(literal);
  };
  // One drag handler for all three surfaces: pointer capture means a drag that
  // leaves the square still tracks, which is what makes the square usable.
  // A single click on a bar is a pointerdown and a pointerup a few ms apart.
  // Fading the card for that would just be a flicker, so the fade waits to see
  // whether the pointer is actually being dragged.
  let peekT = 0;
  const peek=(on)=>{
    clearTimeout(peekT);
    if(!form) return;
    if(on) peekT = setTimeout(()=>form.classList.add('cs-peek-drag'), 180);
    else form.classList.remove('cs-peek-drag');
  };
  const track=(el, fn)=>{
    let on=false;
    const at=e=>{
      const r=el.getBoundingClientRect();
      const cl=(n,lo,hi)=> n<lo ? lo : (n>hi ? hi : n);
      fn(cl((e.clientX-r.left)/(r.width||1), 0, 1), cl((e.clientY-r.top)/(r.height||1), 0, 1));
      paint(true);
    };
    el.addEventListener('pointerdown', e=>{
      e.preventDefault(); on=true; peek(true);
      try{ el.setPointerCapture(e.pointerId); }catch(_){}
      at(e);
    });
    el.addEventListener('pointermove', e=>{ if(on) at(e); });
    const up=e=>{ on=false; peek(false); try{ el.releasePointerCapture(e.pointerId); }catch(_){} };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  track(sv, (x,y)=>{ hsv.s=x; hsv.v=1-y; });
  track(hue, x=>{ hsv.h=x*360; });
  track(al, x=>{ alpha=Math.round(x*100)/100; });
  txt.addEventListener('input', ()=>{
    const c = parseCssColor(txt.value);
    if(!c) return;
    hsv = rgbToHsv(c); alpha = c.a;
    paint(true);
  });
  txt.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); closeColorPicker(); } });
  pop._done = opts.onClose;
  pop._owner = opts.owner;
  pop._out = e=>{ if(!pop.contains(e.target) && !anchor.contains(e.target)) closeColorPicker(); };
  // Capture phase: the dialogs stop mousedown from bubbling out of the card, so
  // a bubble phase listener here would never see a click inside one.
  pop._key = e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeColorPicker(); } };
  document.addEventListener('mousedown', pop._out, true);
  document.addEventListener('keydown', pop._key, true);
  _csPop = pop;
  paint(false);
  positionPopup(pop, anchor, { align:'left' });
  return pop;
}

/* ---------- the swatch layer ---------- */

// Copied onto the mirror so its text lands on the same pixels as the
// textarea's. Everything that moves a glyph is here; colour and background
// are not, because the mirror is invisible.
const CS_MIRROR_PROPS = ['fontFamily','fontSize','fontWeight','fontStyle','fontVariant',
  'letterSpacing','wordSpacing','lineHeight','textIndent','textTransform','tabSize','whiteSpace',
  'paddingTop','paddingRight','paddingBottom','paddingLeft',
  'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'];
const CS_SIZE = 11;   // px, the square's side
const CS_GAP  = 4;    // px between the square and the colour it belongs to

// Decorate one textarea with a clickable swatch in front of every colour
// literal. onLive, when given, is called with the whole text after every picker
// move, for callers that want to preview the change somewhere else.
function attachColorSwatches(ta, onLive){
  const wrap = document.createElement('div'); wrap.className = 'cs-wrap';
  ta.parentNode.insertBefore(wrap, ta); wrap.appendChild(ta);
  const mirror = document.createElement('div'); mirror.className = 'cs-mirror';
  const layer = document.createElement('div'); layer.className = 'cs-layer';
  wrap.appendChild(mirror); wrap.appendChild(layer);

  // idx is the token's position in the scan, not its offsets: replacing one
  // colour literal with another never changes how many there are or their
  // order, but it does move every offset after it, and a cached offset would
  // then edit the wrong span of text.
  const edit=(btn, idx)=>{
    const tok = findColorTokens(ta.value)[idx];
    if(!tok) return;
    const fill = btn.querySelector('.cs-fill');
    openColorPicker(btn, tok.text, {
      owner: ta,
      onInput: next=>{
        const v = ta.value, selA = ta.selectionStart, selB = ta.selectionEnd;
        ta.value = v.slice(0, tok.start) + next + v.slice(tok.end);
        // Setting .value collapses the caret to the end, which would silently
        // move the user's cursor across the document mid-drag.
        const d = next.length - (tok.end - tok.start);
        const fix = p => p >= tok.end ? p + d : p;
        try{ ta.setSelectionRange(fix(selA), fix(selB)); }catch(_){}
        tok.end = tok.start + next.length; tok.text = next;
        // Repaint in place: a full place() would destroy the very button the
        // open picker is anchored to. The layer is rebuilt when it closes.
        fill.style.background = next;
        if(onLive) onLive(ta.value);
      },
      onClose: ()=>{
        // Rebuild on the next frame, not now: this runs from the mousedown that
        // dismissed the picker, and tearing the buttons down before that click
        // lands would swallow a click aimed at another swatch.
        requestAnimationFrame(place);
        // Hand the focus back to the textarea, at the scroll position the user
        // was reading at, whenever it would otherwise be left on nothing or on
        // a button the rebuild above is about to remove. Without this the next
        // Escape reaches no one and the dialog appears to ignore it.
        const ae = document.activeElement;
        if(!ae || ae === document.body || wrap.contains(ae)){
          const st = ta.scrollTop, sl = ta.scrollLeft;
          ta.focus(); ta.scrollTop = st; ta.scrollLeft = sl;
        }
      },
    });
  };

  const place=()=>{
    // The open picker is anchored to a button in this layer, so leave it alone.
    if(_csPop && _csPop._owner === ta) return;
    layer.textContent = ''; mirror.textContent = '';
    const tokens = findColorTokens(ta.value);
    if(!tokens.length) return;
    const cs = getComputedStyle(ta);
    for(const p of CS_MIRROR_PROPS) mirror.style[p] = cs[p];
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = ta.offsetWidth+'px';
    mirror.style.height = ta.offsetHeight+'px';
    // Build the whole mirror first, then read every box: one layout pass rather
    // than one per token.
    const frag = document.createDocumentFragment();
    const marks = [];
    let at = 0;
    for(const t of tokens){
      // Anchor to the opening quote when there is one. In a JSON file that is
      // where the value visually starts, and it is where VS Code puts the square.
      const q = (ta.value[t.start-1]==='"' || ta.value[t.start-1]==="'") ? t.start-1 : t.start;
      frag.appendChild(document.createTextNode(ta.value.slice(at, q)));
      const span = document.createElement('span');
      span.textContent = ta.value.slice(q, t.end);
      frag.appendChild(span);
      marks.push({ t, span, q });
      at = t.end;
    }
    frag.appendChild(document.createTextNode(ta.value.slice(at)));
    mirror.appendChild(frag);
    const lh = parseFloat(getComputedStyle(mirror).lineHeight) || 16;
    for(const { t, span, q } of marks){
      // A colour buried inside a longer value (the rgba() inside a --shadow,
      // say) has no blank columns in front of it, and a square there would sit
      // on top of the text. Skip it rather than draw it wrong.
      const pre = ta.value.slice(0, q);
      if(pre.length - pre.replace(/[ \t]+$/, '').length < 2) continue;
      const x = span.offsetLeft - CS_SIZE - CS_GAP - ta.scrollLeft;
      const y = span.offsetTop + (lh - CS_SIZE)/2 - ta.scrollTop;
      if(x < 0) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cs-swatch'; b.title = 'Pick a colour';
      b.style.left = x+'px'; b.style.top = y+'px';
      const fill = document.createElement('span');
      fill.className = 'cs-fill';
      fill.style.background = formatCssColor(t.rgba, t.text);
      b.appendChild(fill);
      const idx = tokens.indexOf(t);
      // Do not let the square take the focus off the text the user is editing.
      b.onmousedown = e=>e.preventDefault();
      b.onclick = e=>{ e.preventDefault(); e.stopPropagation(); edit(b, idx); };
      layer.appendChild(b);
    }
  };

  // A themes/*.json file, and anything else JSON.stringify wrote, puts a single
  // space after the colon, which is not enough room for a square. Re-space on
  // paste and on blur: both are moments where the text is settling rather than
  // being typed into, and only whitespace between tokens ever changes, so the
  // JSON the user pasted still parses to exactly the same object.
  const respace=()=>{
    const next = spaceForSwatches(ta.value);
    if(next === ta.value) return;
    // Move the caret by the same transform applied to the text in front of it.
    // A match straddling the caret can land it a character or two off, which is
    // why this runs only when the user is not mid-word.
    const head = spaceForSwatches(ta.value.slice(0, ta.selectionStart)).length;
    ta.value = next;
    try{ ta.setSelectionRange(head, head); }catch(_){}
  };
  // Programmatic writes do not fire input, so this only ever runs for the user's
  // own typing, where closing the picker first is the honest thing to do.
  ta.addEventListener('input', ()=>{ closeColorPicker(); place(); });
  // Paste fires before the text lands, hence the timeout.
  ta.addEventListener('paste', ()=>setTimeout(()=>{ respace(); place(); }, 0));
  ta.addEventListener('change', ()=>{ respace(); place(); });
  ta.addEventListener('scroll', place);
  if(window.ResizeObserver) new ResizeObserver(place).observe(ta);
  place();
  return place;
}

/* ---------- Themes ---------- */
const THEMES = [
  {id:'light',           name:'Light',           swatch:['#f4efe6','#ffffff','#e0613a']},
  {id:'dark',            name:'Dark',            swatch:['#1e1e1e','#2d2d2d','#3794ff']},
  {id:'light-owl',       name:'Light Owl',       swatch:['#fbfbfb','#ffffff','#2aa298']},
  {id:'night-owl',       name:'Night Owl',       swatch:['#011627','#0b2942','#7e57c2']},
  {id:'catppuccin-light', name:'Catppuccin<br>Light', swatch:['#eff1f5','#e6e9ef','#8839ef']},
  {id:'catppuccin-dark',  name:'Catppuccin<br>Dark',  swatch:['#1e1e2e','#181825','#cba6f7']},
  {id:'rose-pine-dawn',  name:'Rosé Pine<br>Dawn',  swatch:['#faf4ed','#fffaf3','#907aa9']},
  {id:'rose-pine-moon',  name:'Rosé Pine<br>Moon',  swatch:['#232136','#393552','#c4a7e7']},
  {id:'github-light',    name:'GitHub Light',    swatch:['#ffffff','#f6f8fa','#0969da']},
{id:'github-dark',    name:'GitHub Dark',   swatch:['#0d1117','#161b22','#58a6ff']},
  {id:'solarized',       name:'Solarized',       swatch:['#fdf6e3','#eee8d5','#268bd2']},
  {id:'scholar-parchment', name:'Scholar',       swatch:['#faf8f3','#f1ece1','#0a4d3c']},
  {id:'paper-ink',       name:'Paper &<br>Ink',  swatch:['#fcfbf7','#f1efe9','#27364b']},
  {id:'mint-graphite',   name:'Mint<br>Graphite', swatch:['#f7fbf9','#e6f3ee','#0f9f75']},
  {id:'carbon-amber',     name:'Carbon &<br>Amber', swatch:['#121212','#1a1400','#ffb000']},
  {id:'cyber-quantum',    name:'Cyber<br>Quantum', swatch:['#0a101d','#10192c','#00f0ff']},
  {id:'blueprint',        name:'Blueprint',        swatch:['#005596','#004478','#ffffff']},
  {id:'obsidian',         name:'Obsidian',         swatch:['#000000','#18181b','#ffffff']},
  {id:'swiss-crimson',    name:'Swiss<br>Crimson', swatch:['#f4f4f4','#e6e6e6','#d90429']},
  {id:'nordic-sage',      name:'Nordic<br>Sage',   swatch:['#f3f5f3','#e4eae6','#3b604d']},
  {id:'deep-ocean',       name:'Deep<br>Ocean',    swatch:['#06181d','#0d282e','#10b981']},
  {id:'google-material',  name:'Material<br>You',  swatch:['#1f1f1f','#2d2d2d','#a8c7fa']},
  {id:'github-modern',    name:'GitHub<br>Modern', swatch:['#22272e','#2d333b','#539bf5']},
  {id:'sakura-drift',     name:'Sakura<br>Drift',  swatch:['#fff9fa','#ffebf0','#ff758f']},
  {id:'aurora-frost',     name:'Aurora<br>Frost',  swatch:['#0b132b','#1c2541','#70e000']},
  {id:'espresso',         name:'Espresso',         swatch:['#1a1412','#281e19','#d4a373']},
  {id:'arctic-glass',     name:'Arctic<br>Glass',  swatch:['#f4faff','#e9f5fb','#149bd7']},
  {id:'copper-lab',       name:'Copper<br>Lab',    swatch:['#1b1715','#29201c','#d97745']},
  {id:'forest-night',     name:'Forest<br>Night',  swatch:['#101b17','#172720','#63c174']},
  {id:'cobalt',           name:'Cobalt',           swatch:['#0b1530','#121f42','#4f8cff']},
  {id:'lavender-mist',    name:'Lavender',         swatch:['#faf8ff','#f0ebfa','#7956c8']},
  {id:'ruby-night',       name:'Ruby<br>Night',    swatch:['#151314','#24191c','#f43f5e']},
  {id:'sandstone',        name:'Sandstone',        swatch:['#fbf6ee','#f3e7d4','#b45309']},
  {id:'electric-indigo',  name:'Electric<br>Indigo', swatch:['#0e0a22','#191238','#8b5cf6']},
  {id:'teal-paper',       name:'Teal<br>Paper',    swatch:['#f7fcfb','#e6f2f0','#0f766e']},
  {id:'steel-orange',     name:'Steel &<br>Orange', swatch:['#171a1d','#23282d','#f97316']},
  {id:'cosmic-rose',      name:'Cosmic<br>Rose',   swatch:['#100c1b','#20142a','#f472b6']},
  {id:'plasma-crimson',   name:'Plasma<br>Crimson', swatch:['#12080c','#1f0e14','#ff2d55']},
  {id:'neon-noir',        name:'Neon<br>Noir',     swatch:['#0a0a0f','#12121c','#00ff9f']},
  {id:'desert-oasis',     name:'Desert<br>Oasis',  swatch:['#fdf6e9','#f5e8d0','#d97706']},
  {id:'ice-crystal',      name:'Ice<br>Crystal',   swatch:['#f0f9ff','#e0f2fe','#0ea5e9']},
  {id:'ember-forge',      name:'Ember<br>Forge',   swatch:['#140e0a','#221610','#ef4444']},
  {id:'violet-circuit',   name:'Violet<br>Circuit', swatch:['#0f0a1a','#1a1230','#a855f7']},
  {id:'moss-stone',       name:'Moss &<br>Stone',  swatch:['#f4f6f0','#e8eedc','#4d7c0f']},
  {id:'twilight-amber',   name:'Twilight<br>Amber', swatch:['#16120c','#241e14','#fbbf24']},
  {id:'ocean-depth',      name:'Ocean<br>Depth',   swatch:['#06141c','#0c1e28','#22d3ee']},
  {id:'charcoal-gold',    name:'Charcoal<br>Gold', swatch:['#121212','#1c1c18','#eab308']},
  {id:'soft-clay',        name:'Soft<br>Clay',     swatch:['#fbf6f2','#f5e8e0','#c2410c']},
  {id:'azure-horizon',    name:'Azure<br>Horizon', swatch:['#0a1420','#121e30','#3b82f6']},
  {id:'jade-temple',      name:'Jade<br>Temple',   swatch:['#0a1612','#12241c','#10b981']},
  {id:'magenta-pulse',    name:'Magenta<br>Pulse', swatch:['#140a16','#221022','#ec4899']},
  {id:'graphite-terminal', name:'Graphite<br>Terminal', swatch:['#1a1a1a','#242424','#60a5fa']},
  {id:'honeycomb',        name:'Honeycomb',        swatch:['#fffbeb','#fef3c7','#f59e0b']},
  {id:'frosted-pine',     name:'Frosted<br>Pine',  swatch:['#0c1610','#122018','#34d399']},
  {id:'quantum-violet',   name:'Quantum<br>Violet', swatch:['#0e0a18','#18122a','#8b5cf6']},
  {id:'copper-rust',      name:'Copper<br>Rust',   swatch:['#16120e','#241a12','#ea580c']},
  {id:'lunar-silver',     name:'Lunar<br>Silver',  swatch:['#0e1014','#181c22','#94a3b8']}
];
// Shown in their own dedicated panel section, not mixed into the regular
// colour-theme grid above. Deliberately a different kind of thing from
// THEMES/MAP_STYLES - font + non-node chrome texture only, independent of
// both color (still controlled by whichever Colour Theme is active) and
// card/branch shape (still controlled by whichever Map Style is active).
// 'office' is the implicit default, same pattern as 'light' for themes -
// achieved by absence of the data-look attribute, not its own CSS block.
// Names are written to complete "I am ___" (the section's own label) -
// "I am in the Office" / "I am at Coffee Shop" / "I am back to School".
const LOOKS = [
  {id:'office',      name:'in the<br>Office',  font:'inherit'},
  {id:'coffee-shop', name:'at Coffee<br>Shop', font:'"Nunito",sans-serif'},
  {id:'handwritten', name:'back to<br>School', font:'"Caveat",cursive'},
  {id:'lab',         name:'in the<br>Lab',     font:'"JetBrains Mono",monospace'},
  {id:'scientist',   name:'the<br>Scientist',  font:'"Space Mono",monospace'},
  {id:'architect',   name:'the<br>Architect',  font:'"Space Grotesk",sans-serif'},
  {id:'alien',       name:'an<br>Alien',       font:'"Space Mono",monospace'},
  {id:'psycho',      name:'a<br>Psycho',       font:'"Oswald",system-ui,sans-serif'},
  {id:'forest',      name:'in the<br>Forest',   font:'"Fredoka",system-ui,sans-serif'},
  {id:'beach',       name:'at the<br>Beach',    font:'"Oswald",system-ui,sans-serif'},
  {id:'studio',      name:'in the<br>Studio',   font:'"Fraunces",serif'},
  {id:'mountain',    name:'on the<br>Mountain',font:'"Roboto Condensed",system-ui,sans-serif'},
  {id:'desert',      name:'in the<br>Desert',     font:'"Nunito",system-ui,sans-serif'}
];
const MAP_STYLES = [
  {id:'modern',  name:'Modern',  desc:'Soft cards, curved branches'},
  {id:'classic', name:'Classic', desc:'Rectangles, right-angle branches'},
  {id:'bubble',  name:'Bubble',  desc:'Pill cards, thick curves'},
  {id:'sketch',  name:'Sketch',  desc:'Outlined cards, straight lines'},
  {id:'dashed',  name:'Dashed',  desc:'Curved branches drawn as dashes'},
  {id:'minimal', name:'Minimal', desc:'Flat hairline cards, slim branches'},
  {id:'zigzag',  name:'Zigzag',  desc:'Squared cards, jagged branch lines'},
  {id:'neon',    name:'Neon',    desc:'Glowing cards, luminous branches'},
  {id:'circuit', name:'Circuit', desc:'Squared boards, dotted circuits with joint dots'},
  {id:'blueprint', name:'Blueprint', desc:'Transparent wireframes, double-line drafts'},
  {id:'clay', name:'Clay', desc:'Inflated clay, soft inset shadows'},
  {id:'ink', name:'Ink', desc:'Bold comic, heavy ink borders, hard shadow'},
  {id:'paper', name:'Paper', desc:'Ruled paper with soft stack shadow'}
];
// Per-style tunables, keyed by style id on the map as map.styleConfig - the
// same pattern as layoutConfig. Defaults mirror what the CSS and the export
// painter hardcode today, so an unconfigured map renders exactly as before.
const STYLE_CONFIG_DEFAULTS = {
  modern:  { edgeWidth:2.2, edgeColor:'', radius:12,  cardPad:0,  glow:0,  dash:0 },
  classic: { edgeWidth:1.6, edgeColor:'', radius:4,   cardPad:0,  glow:0,  dash:0 },
  bubble:  { edgeWidth:3,   edgeColor:'', radius:999, cardPad:22, glow:0,  dash:0 },
  sketch:  { edgeWidth:1.6, edgeColor:'', radius:3,   cardPad:0,  glow:0,  dash:0 },
  dashed:  { edgeWidth:2.2, edgeColor:'', radius:14,  cardPad:0,  glow:0,  dash:7 },
  minimal: { edgeWidth:1.1, edgeColor:'', radius:6,   cardPad:0,  glow:0,  dash:0 },
  zigzag:  { edgeWidth:2,   edgeColor:'', radius:2,   cardPad:0,  glow:0,  dash:0 },
  neon:    { edgeWidth:2.4, edgeColor:'', radius:10,  cardPad:0,  glow:16, dash:0 },
  circuit: { edgeWidth:1.4, edgeColor:'', radius:4,   cardPad:2,  glow:8,  dash:3 },
  blueprint:{ edgeWidth:1.2, edgeColor:'', radius:11,  cardPad:0,  glow:0,  dash:6 },
  clay:    { edgeWidth:1.6, edgeColor:'', radius:16,  cardPad:6,  glow:12, dash:0 },
  ink:     { edgeWidth:2.6, edgeColor:'', radius:8,   cardPad:0,  glow:0,  dash:0 },
  paper:   { edgeWidth:1.5, edgeColor:'', radius:6,   cardPad:4,  glow:0,  dash:0 },
};
const STYLE_CONFIG_BOUNDS = {
  edgeWidth:[1,8], edgeColor:[0,40], radius:[0,999], cardPad:[0,80], glow:[0,80], dash:[0,60],
};
// Repairs rather than rejects, like validateLayoutConfig: numbers are clamped
// to their bounds, edgeColor is kept as a short string ('' = theme default),
// unknown keys and unknown styles are dropped, and every style gets its
// defaults merged in so a section never comes back half-formed.
function validateStyleConfig(raw){
  const out = {};
  for(const style of Object.keys(STYLE_CONFIG_DEFAULTS)){
    out[style] = { ...STYLE_CONFIG_DEFAULTS[style] };
  }
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for(const style of Object.keys(out)){
    const sec = raw[style];
    if(!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    if(typeof sec.edgeColor === 'string' && sec.edgeColor.trim()){
      out[style].edgeColor = sec.edgeColor.trim().slice(0, STYLE_CONFIG_BOUNDS.edgeColor[1]);
    }
    for(const key of ['edgeWidth','radius','cardPad','glow','dash']){
      const v = sec[key];
      if(typeof v !== 'number' || !isFinite(v)) continue;
      const [lo,hi] = STYLE_CONFIG_BOUNDS[key];
      out[style][key] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}
// The knobs that apply to one style - what the settings dialog shows.
function styleConfigFor(style, raw){
  const all = validateStyleConfig(raw);
  return all[style] ? { [style]: all[style] } : {};
}
// Push the active style's config onto #viewport as inline custom properties,
// which override the per-style CSS rules (inline beats attribute selectors).
// Called on every render so load, style switches and theme changes all agree.
function applyStyleConfigVars(){
  const vp = viewport;
  if(!vp || !map) return;
  const style = map.style || 'modern';
  const cfg = { ...STYLE_CONFIG_DEFAULTS[style], ...((map.styleConfig || {})[style] || {}) };
  vp.style.setProperty('--edge-width', cfg.edgeWidth);
  vp.style.setProperty('--edge-color', cfg.edgeColor || null);
  // Length vars need explicit units: a bare number is invalid for
  // border-radius/padding, and an invalid var() makes the property fall back
  // to its initial value (radius 0, padding 0) instead of the style's default.
  vp.style.setProperty('--node-radius', cfg.radius + 'px');
  vp.style.setProperty('--node-pad-x', cfg.cardPad ? cfg.cardPad + 'px' : null);
  vp.style.setProperty('--node-pad-y', cfg.cardPad ? cfg.cardPad + 'px' : null);
  vp.style.setProperty('--node-glow', cfg.glow + 'px');
  vp.style.setProperty('--edge-glow', Math.max(2, Math.round(cfg.glow / 5)));
}
// Per-look tunables, keyed by look id on the map as map.lookConfig - the
// same pattern as styleConfig/layoutConfig. font is the look's own font
// family by default (mirroring the --sans/--serif each look's CSS declares,
// so an unconfigured map renders exactly as before); nodeSize scales node
// text (1 = the look's own size); radius rounds the chrome (popups, pickers,
// minimap, modals - equal to the look's default keeps its own asymmetric
// corners).
const LOOK_CONFIG_DEFAULTS = {
  office:       { font:'"Bricolage Grotesque",system-ui,sans-serif', nodeSize:1, radius:14 },
  'coffee-shop':{ font:'"Nunito",sans-serif',                        nodeSize:1, radius:18 },
  handwritten:  { font:'"Caveat",cursive',                           nodeSize:1, radius:20 },
  lab:          { font:'"JetBrains Mono",monospace',                 nodeSize:1, radius:4  },
  scientist:    { font:'"Space Mono",monospace',                     nodeSize:1, radius:4  },
  architect:    { font:'"Space Grotesk",sans-serif',                 nodeSize:1, radius:6  },
  alien:        { font:'"Space Mono",monospace',                     nodeSize:1, radius:12 },
  psycho:       { font:'"Oswald",system-ui,sans-serif',              nodeSize:1, radius:4  },
  forest:       { font:'"Fredoka",system-ui,sans-serif',             nodeSize:1, radius:16 },
  beach:        { font:'"Oswald",system-ui,sans-serif',              nodeSize:1, radius:24 },
  studio:       { font:'"Fraunces",serif',                           nodeSize:1, radius:8  },
  mountain:     { font:'"Roboto Condensed",system-ui,sans-serif',    nodeSize:1, radius:10 },
  desert:       { font:'"Nunito",system-ui,sans-serif',               nodeSize:1, radius:12 },
  sketchpad:    { font:'system-ui,sans-serif',                        nodeSize:1, radius:14 },
};
const LOOK_CONFIG_BOUNDS = { nodeSize:[0.8,1.6], radius:[0,60] };
// Repairs rather than rejects, like validateStyleConfig: numbers are clamped
// to their bounds, font is kept as a short string (typing "" keeps the
// look's own default font), unknown keys and unknown looks are dropped, and
// every look gets its defaults merged in so a section never comes back
// half-formed.
function validateLookConfig(raw){
  const out = {};
  for(const look of Object.keys(LOOK_CONFIG_DEFAULTS)){
    out[look] = { ...LOOK_CONFIG_DEFAULTS[look] };
  }
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for(const look of Object.keys(out)){
    const sec = raw[look];
    if(!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    if(typeof sec.font === 'string' && sec.font.trim()){
      out[look].font = sec.font.trim().slice(0, 60);
    }
    for(const key of ['nodeSize','radius']){
      const v = sec[key];
      if(typeof v !== 'number' || !isFinite(v)) continue;
      const [lo,hi] = LOOK_CONFIG_BOUNDS[key];
      out[look][key] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}
// The knobs that apply to one look - what the settings dialog shows.
function lookConfigFor(look, raw){
  const all = validateLookConfig(raw);
  return all[look] ? { [look]: all[look] } : {};
}
// Push the active look's config onto :root as inline custom properties -
// inline styles beat the :root[data-look=...] attribute rules, so configured
// values win over the look's own CSS without touching it (and --look-radius/
// --look-node-size are consumed by the base chrome/node rules, which fall
// back to the look's own values when unset). Called on every render so load,
// look switches and map loads all agree.
function applyLookConfigVars(){
  const root = document.documentElement;
  if(!root || !map) return;
  const look = root.getAttribute('data-look') || 'office';
  const defaults = LOOK_CONFIG_DEFAULTS[look] || LOOK_CONFIG_DEFAULTS.office;
  const cfg = { ...defaults, ...((map.lookConfig || {})[look] || {}) };
  if(cfg.font){ root.style.setProperty('--sans', cfg.font); root.style.setProperty('--serif', cfg.font); }
  else { root.style.removeProperty('--sans'); root.style.removeProperty('--serif'); }
  if(cfg.nodeSize !== 1) root.style.setProperty('--look-node-size', cfg.nodeSize);
  else root.style.removeProperty('--look-node-size');
  if(cfg.radius !== defaults.radius) root.style.setProperty('--look-radius', cfg.radius + 'px');
  else root.style.removeProperty('--look-radius');
}
const THEME_CONFIG_DEFAULTS = {
  'light':            { paper:'#f4efe6',  ink:'#23201b', accent:'#e0613a', nodeBg:'#ffffff', line:'#d8cfbf', glow:'rgba(255,255,255,.5)' },
  'dark':             { paper:'#1e1e1e',  ink:'#d4d4d4', accent:'#3794ff', nodeBg:'#2d2d2d', line:'#3c3c3c', glow:'rgba(255,255,255,.04)' },
  'light-owl':        { paper:'#fbfbfb',  ink:'#403f53', accent:'#2aa298', nodeBg:'#ffffff', line:'#ececec', glow:'rgba(255,255,255,.6)' },
  'night-owl':        { paper:'#011627',  ink:'#d6deeb', accent:'#7e57c2', nodeBg:'#0b2942', line:'#1d3b53', glow:'rgba(126,87,194,.06)' },
  'catppuccin-light': { paper:'#eff1f5',  ink:'#4c4f69', accent:'#8839ef', nodeBg:'#ffffff', line:'#ccd0da', glow:'rgba(136,57,239,.04)' },
  'catppuccin-dark':  { paper:'#1e1e2e',  ink:'#cdd6f4', accent:'#cba6f7', nodeBg:'#313244', line:'#313244', glow:'rgba(203,166,247,.05)' },
  'rose-pine-dawn':   { paper:'#faf4ed',  ink:'#575279', accent:'#907aa9', nodeBg:'#fffaf3', line:'#f2e9e1', glow:'rgba(144,122,169,.04)' },
  'rose-pine-moon':   { paper:'#232136',  ink:'#e0def4', accent:'#c4a7e7', nodeBg:'#393552', line:'#393552', glow:'rgba(196,167,231,.05)' },
  'github-light':     { paper:'#ffffff',  ink:'#1f2328', accent:'#0969da', nodeBg:'#ffffff', line:'#d0d7de', glow:'rgba(9,105,218,.04)' },
  'github-dark':      { paper:'#0d1117',  ink:'#e6edf3', accent:'#58a6ff', nodeBg:'#161b22', line:'#30363d', glow:'rgba(88,166,255,.05)' },
  'dracula':          { paper:'#282a36',  ink:'#f8f8f2', accent:'#ff79c6', nodeBg:'#44475a', line:'#44475a', glow:'rgba(189,147,249,.06)' },
  'nord':             { paper:'#2e3440',  ink:'#eceff4', accent:'#88c0d0', nodeBg:'#434c5e', line:'#434c5e', glow:'rgba(143,188,187,.05)' },
  'slate-steel':      { paper:'#0f172a',  ink:'#cbd5e1', accent:'#38bdf8', nodeBg:'#1e293b', line:'#334155', glow:'rgba(56,189,248,.05)' },
  'vscode-onedark':   { paper:'#282c34',  ink:'#abb2bf', accent:'#98c379', nodeBg:'#2c323d', line:'#3e4451', glow:'rgba(152,195,121,.05)' },
  'monokai-pro':      { paper:'#2d2a2e',  ink:'#fcfcfa', accent:'#a9dc76', nodeBg:'#363337', line:'#403e41', glow:'rgba(169,220,118,.05)' },
  'amazon-aws':       { paper:'#161e2e',  ink:'#d1d5db', accent:'#ff9900', nodeBg:'#232f3e', line:'#374151', glow:'rgba(255,153,0,.05)' },
  'synthwave':        { paper:'#1a102f',  ink:'#e2d9f3', accent:'#00f5d4', nodeBg:'#281b45', line:'#483267', glow:'rgba(255,113,206,.06)' },
  'matrix-green':     { paper:'#030705',  ink:'#9ef7b2', accent:'#39ff88', nodeBg:'#0b2414', line:'#123a1f', glow:'rgba(57,255,136,.06)' },
  'solarized':        { paper:'#fdf6e3',  ink:'#657b83', accent:'#268bd2', nodeBg:'#ffffff', line:'#eee8d5', glow:'rgba(38,139,210,.05)' },
  'scholar-parchment':{ paper:'#faf8f3',  ink:'#2c2c2a', accent:'#0a4d3c', nodeBg:'#ffffff', line:'#e2ddd3', glow:'rgba(197,160,89,.06)' },
  
  'paper-ink':        { paper:'#fcfbf7',  ink:'#343434', accent:'#27364b', nodeBg:'#ffffff', line:'#ddd9d0', glow:'rgba(39,54,75,.05)' },
  'mint-graphite':    { paper:'#f7fbf9',  ink:'#34423c', accent:'#0f9f75', nodeBg:'#ffffff', line:'#d8e8e1', glow:'rgba(15,159,117,.05)' },
  'carbon-amber':     { paper:'#121212',  ink:'#d4af37', accent:'#ffb000', nodeBg:'#1f1800', line:'#332600', glow:'rgba(255,176,0,.06)' },
  'cyber-quantum':    { paper:'#0a101d',  ink:'#e2f8ff', accent:'#00f0ff', nodeBg:'#10192c', line:'#1b3b4d', glow:'rgba(0,240,255,.07)' },
  'blueprint':        { paper:'#005596',  ink:'#e0f2fe', accent:'#ffffff', nodeBg:'#004478', line:'#4080b0', glow:'rgba(255,255,255,.08)' },
  'obsidian':         { paper:'#000000',  ink:'#a1a1aa', accent:'#ffffff', nodeBg:'#18181b', line:'#27272a', glow:'rgba(255,255,255,.05)' },
  'swiss-crimson':    { paper:'#f4f4f4',  ink:'#111111', accent:'#d90429', nodeBg:'#ffffff', line:'#d1d1d1', glow:'rgba(217,4,41,.05)' },
  'nordic-sage':      { paper:'#f3f5f3',  ink:'#2d3a34', accent:'#3b604d', nodeBg:'#ffffff', line:'#d5ddd8', glow:'rgba(59,96,77,.05)' },
  'deep-ocean':       { paper:'#06181d',  ink:'#a3e5d9', accent:'#10b981', nodeBg:'#0d282e', line:'#113836', glow:'rgba(16,185,129,.06)' },
  'google-material':  { paper:'#1f1f1f',  ink:'#e3e2e6', accent:'#a8c7fa', nodeBg:'#2d2d2d', line:'#444746', glow:'rgba(168,199,250,.05)' },
  'github-modern':    { paper:'#22272e',  ink:'#adbac7', accent:'#539bf5', nodeBg:'#2d333b', line:'#444c56', glow:'rgba(83,155,245,.05)' },
  'sakura-drift':     { paper:'#fff9fa',  ink:'#4a3e43', accent:'#ff758f', nodeBg:'#ffffff', line:'#f7d6df', glow:'rgba(255,117,143,.05)' },
  'aurora-frost':     { paper:'#0b132b',  ink:'#c0d6df', accent:'#70e000', nodeBg:'#1c2541', line:'#1c2541', glow:'rgba(112,224,0,.06)' },
  'espresso':         { paper:'#1a1412',  ink:'#e3d5ca', accent:'#d4a373', nodeBg:'#281e19', line:'#382b24', glow:'rgba(212,163,115,.06)' },
  'arctic-glass':     { paper:'#f4faff',  ink:'#274154', accent:'#149bd7', nodeBg:'#ffffff', line:'#d6eaf4', glow:'rgba(20,155,215,.05)' },
  'copper-lab':       { paper:'#1b1715',  ink:'#e4d7ce', accent:'#d97745', nodeBg:'#29201c', line:'#463128', glow:'rgba(217,119,69,.06)' },
  'forest-night':     { paper:'#101b17',  ink:'#d5e5dc', accent:'#63c174', nodeBg:'#172720', line:'#294138', glow:'rgba(99,193,116,.06)' },
  'cobalt':           { paper:'#0b1530',  ink:'#d7e3ff', accent:'#4f8cff', nodeBg:'#121f42', line:'#263b6b', glow:'rgba(79,140,255,.06)' },
  'lavender-mist':    { paper:'#faf8ff',  ink:'#403a52', accent:'#7956c8', nodeBg:'#ffffff', line:'#e4ddf2', glow:'rgba(121,86,200,.05)' },
  'ruby-night':       { paper:'#151314',  ink:'#e8dddf', accent:'#f43f5e', nodeBg:'#24191c', line:'#43242b', glow:'rgba(244,63,94,.07)' },
  'sandstone':        { paper:'#fbf6ee',  ink:'#51463a', accent:'#b45309', nodeBg:'#ffffff', line:'#e8d8c2', glow:'rgba(180,83,9,.06)' },
  'electric-indigo':  { paper:'#0e0a22',  ink:'#dcd7ff', accent:'#8b5cf6', nodeBg:'#191238', line:'#33255b', glow:'rgba(139,92,246,.07)' },
  'teal-paper':       { paper:'#f7fcfb',  ink:'#304744', accent:'#0f766e', nodeBg:'#ffffff', line:'#d4e7e3', glow:'rgba(15,118,110,.05)' },
  'steel-orange':     { paper:'#171a1d',  ink:'#d9dee3', accent:'#f97316', nodeBg:'#23282d', line:'#353b40', glow:'rgba(249,115,22,.06)' },
  'cosmic-rose':      { paper:'#100c1b',  ink:'#e4d9ea', accent:'#f472b6', nodeBg:'#20142a', line:'#38223f', glow:'rgba(244,114,182,.07)' },
  'plasma-crimson':   { paper:'#12080c',  ink:'#f5d0d8', accent:'#ff2d55', nodeBg:'#1f0e14', line:'#4a1a28', glow:'rgba(255,45,85,.08)' },
  'neon-noir':        { paper:'#0a0a0f',  ink:'#c8c8d4', accent:'#00ff9f', nodeBg:'#12121c', line:'#1f1f2e', glow:'rgba(0,255,159,.07)' },
  'desert-oasis':     { paper:'#fdf6e9',  ink:'#4a3c2a', accent:'#d97706', nodeBg:'#ffffff', line:'#e8d5b5', glow:'rgba(217,119,6,.06)' },
  'ice-crystal':      { paper:'#f0f9ff',  ink:'#1e3a5f', accent:'#0ea5e9', nodeBg:'#ffffff', line:'#bae6fd', glow:'rgba(14,165,233,.05)' },
  'ember-forge':      { paper:'#140e0a',  ink:'#e8d5c4', accent:'#ef4444', nodeBg:'#221610', line:'#3d2418', glow:'rgba(239,68,68,.08)' },
  'violet-circuit':   { paper:'#0f0a1a',  ink:'#d4c8f0', accent:'#a855f7', nodeBg:'#1a1230', line:'#2e1f4a', glow:'rgba(168,85,247,.08)' },
  'moss-stone':       { paper:'#f4f6f0',  ink:'#2e3a2a', accent:'#4d7c0f', nodeBg:'#ffffff', line:'#d4dcc8', glow:'rgba(77,124,15,.06)' },
  'twilight-amber':   { paper:'#16120c',  ink:'#e8dcc8', accent:'#fbbf24', nodeBg:'#241e14', line:'#3a3020', glow:'rgba(251,191,36,.07)' },
  'ocean-depth':      { paper:'#06141c',  ink:'#b8d8e8', accent:'#22d3ee', nodeBg:'#0c1e28', line:'#0e2a38', glow:'rgba(34,211,238,.07)' },
  'charcoal-gold':    { paper:'#121212',  ink:'#d4d0c8', accent:'#eab308', nodeBg:'#1c1c18', line:'#2e2e28', glow:'rgba(234,179,8,.07)' },
  'soft-clay':        { paper:'#fbf6f2',  ink:'#4a3a32', accent:'#c2410c', nodeBg:'#ffffff', line:'#e8d8cc', glow:'rgba(194,65,12,.06)' },
  'azure-horizon':    { paper:'#0a1420',  ink:'#c0d8f0', accent:'#3b82f6', nodeBg:'#121e30', line:'#1a2e48', glow:'rgba(59,130,246,.07)' },
  'jade-temple':      { paper:'#0a1612',  ink:'#c0e0d4', accent:'#10b981', nodeBg:'#12241c', line:'#1a3a2e', glow:'rgba(16,185,129,.07)' },
  'magenta-pulse':    { paper:'#140a16',  ink:'#e8d0e8', accent:'#ec4899', nodeBg:'#221022', line:'#3a1a3a', glow:'rgba(236,72,153,.08)' },
  'graphite-terminal':{ paper:'#1a1a1a',  ink:'#b8b8b8', accent:'#60a5fa', nodeBg:'#242424', line:'#333333', glow:'rgba(96,165,250,.06)' },
  'honeycomb':        { paper:'#fffbeb',  ink:'#4a3a1a', accent:'#f59e0b', nodeBg:'#ffffff', line:'#f5e6b0', glow:'rgba(245,158,11,.07)' },
  'frosted-pine':     { paper:'#0c1610',  ink:'#c0d8c8', accent:'#34d399', nodeBg:'#122018', line:'#1a3a28', glow:'rgba(52,211,153,.07)' },
  'quantum-violet':   { paper:'#0e0a18',  ink:'#d0c8e8', accent:'#8b5cf6', nodeBg:'#18122a', line:'#2a1e48', glow:'rgba(139,92,246,.08)' },
  'copper-rust':      { paper:'#16120e',  ink:'#e0d0c0', accent:'#ea580c', nodeBg:'#241a12', line:'#3a2a1e', glow:'rgba(234,88,12,.08)' },
  'lunar-silver':     { paper:'#0e1014',  ink:'#c8d0d8', accent:'#94a3b8', nodeBg:'#181c22', line:'#2a3038', glow:'rgba(148,163,184,.06)' },
};
const THEME_CONFIG_BOUNDS = { color:[0,40] };
// The six knobs and the CSS variable each one drives. One table: applying,
// previewing from the colour picker and reading a custom theme's palette all
// need the same mapping.
const THEME_CONFIG_VARS = { paper:'--paper', ink:'--ink', accent:'--accent', nodeBg:'--node-bg', line:'--line', glow:'--stage-glow' };
// Repairs rather than rejects, like validateLookConfig: every colour is kept
// as a short CSS colour string (typing "" keeps the theme's own colour),
// unknown keys and unknown themes are dropped, and every theme gets its
// defaults merged in so a section never comes back half-formed.
function validateThemeConfig(raw){
  const out = {};
  for(const theme of Object.keys(THEME_CONFIG_DEFAULTS)){
    out[theme] = { ...THEME_CONFIG_DEFAULTS[theme] };
  }
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for(const theme of Object.keys(out)){
    const sec = raw[theme];
    if(!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    for(const key of ['paper','ink','accent','nodeBg','line','glow']){
      if(typeof sec[key] === 'string' && sec[key].trim()){
        out[theme][key] = sec[key].trim().slice(0, THEME_CONFIG_BOUNDS.color[1]);
      }
    }
  }
  return out;
}
// The knobs that apply to one theme - what the settings dialog shows.
function themeConfigFor(theme, raw){
  const all = validateThemeConfig(raw);
  return all[theme] ? { [theme]: all[theme] } : {};
}
// Push the active theme's config onto :root as inline custom properties -
// inline styles beat the :root[data-theme=...] rules, so configured colours
// win over the theme's own palette without touching it. Called on every
// render so load, theme switches and map loads all agree.
function applyThemeConfigVars(){
  const root = document.documentElement;
  if(!root || !map) return;
  const theme = root.getAttribute('data-theme') || 'light';
  // A custom theme has no THEME_CONFIG_DEFAULTS entry - its own palette takes
  // that role, so the six config knobs still start from (and can tune) it.
  let defaults = THEME_CONFIG_DEFAULTS[theme];
  if(theme==='custom'){
    const custom = loadCustomTheme();
    if(custom){
      defaults = Object.fromEntries(Object.entries(THEME_CONFIG_VARS).map(([k,v])=>[k, custom.vars[v]]));
    } else defaults = THEME_CONFIG_DEFAULTS.light;
  }
  const cfg = { ...defaults, ...((map.themeConfig || {})[theme] || {}) };
  for(const key of Object.keys(THEME_CONFIG_VARS)){
    const v = cfg[key];
    if(v && typeof v === 'string') root.style.setProperty(THEME_CONFIG_VARS[key], v);
    else root.style.removeProperty(THEME_CONFIG_VARS[key]);
  }
}
// Push a themeConfig JSON string onto :root without saving anything. Used by
// the colour picker in the settings dialog so a drag shows on the canvas behind
// the card; applyThemeConfigVars() puts the saved values back when it closes,
// which is what makes cancelling leave nothing behind.
function previewThemeConfig(theme, text){
  let parsed;
  try{ parsed = JSON.parse(text); }catch(e){ return; }
  const sec = (themeConfigFor(theme, parsed) || {})[theme];
  if(!sec) return;
  for(const key of Object.keys(THEME_CONFIG_VARS)){
    if(sec[key]) document.documentElement.style.setProperty(THEME_CONFIG_VARS[key], sec[key]);
  }
}

/* ------------------------------------------------------------
   Layout presets.

   A preset SELECTS AND PARAMETERISES one of the placement engines this app
   implements - it does not define a new algorithm. That distinction is the
   whole design: 'balanced' keeps each child on whichever side it already had,
   'down' does org-chart width packing, 'timeline' chains an axis. Those are
   recursive procedures, not numbers, and the only way JSON could express them
   is by shipping executable code - which would arrive on a stranger's machine
   through every #view= link. So an imported layout picks an engine and tunes
   it, and every built-in below is written in exactly the schema an import must
   use, so there is no privileged path.

   Applying a preset writes map.layout (the engine) and map.layoutConfig (its
   options). Both travel with the map, so a shared map renders correctly for
   someone who has never seen the preset - only the picker entry is local.
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   Layout strategies and their parameters.

   Steps 1-3 established that every layout this app draws is one of four
   placement STRATEGIES with different numbers. This exposes those numbers, so
   a layout can be written as JSON rather than code - which is what makes a
   shared library of layouts possible without shipping executable plugins.

   Each strategy declares its parameters: enums list their allowed values,
   pairs are numeric [min,max]. Anything not listed here cannot be set, so a
   preset can only ever reach knobs the engines actually read.
   ------------------------------------------------------------ */
const LAYOUT_PARAMS = {
  tree: {
    axis:['x','y'], dir:[-1,1], split:['balanced','one-side'],
    rootAnchor:['origin','centered'],
    gapMain:[8,400], gapCross:[4,300],
  },
  chain: {
    axis:['x','y'], dir:[-1,1], start:['above','below'], alternate:'boolean',
    gap:[8,400], stem:[0,300], indent:[0,300], gapMain:[8,400], gapCross:[4,300],
    angle:[10,170],
  },
  radial: { ring:[60,600], startAngle:[-360,360], sweep:[30,360], pad:[0,30], padV:[0,40] },
  matrix: { colGap:[8,300], rowGap:[8,300], cellGap:[0,120], headGap:[8,300] },
  grid:   { columns:[1,8], gapX:[8,300], gapY:[8,300], rowGap:[0,120], indent:[0,120] },
};
// The built-in layouts, now expressed as strategy + parameters. These are the
// same values steps 1-3 verified against captured output, so naming a built-in
// engine and spelling out its parameters are two ways of saying one thing.
const ENGINE_PARAMS = {
  balanced:{ strategy:'tree',  params:{ axis:'x', dir: 1, split:'balanced', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  right:   { strategy:'tree',  params:{ axis:'x', dir: 1, split:'one-side', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  left:    { strategy:'tree',  params:{ axis:'x', dir:-1, split:'one-side', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  down:    { strategy:'tree',  params:{ axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down', gapMain:16, gapCross:40 } },
  timeline:{ strategy:'chain', params:{ axis:'x', dir: 1, gap:70, stem:30, indent:26, alternate:true, start:'above', gapMain:70, gapCross:22 } },
  radial:  { strategy:'radial',params:{ ring:180, startAngle:-90, sweep:360, pad:14, padV:16 } },
  up:      { strategy:'tree',  params:{ axis:'y', dir:-1, split:'one-side', rootAnchor:'centered', sideName:'up',   gapMain:16, gapCross:40 } },
  stair:   { strategy:'chain', params:{ axis:'y', dir:1, gap:45, stem:24, indent:42, alternate:true,  start:'above', sideName:'down', gapMain:70, gapCross:40 } },
  grid:    { strategy:'grid',  params:{ columns:3, gapX:60, gapY:60, rowGap:14, indent:24 } },
  matrix:  { strategy:'matrix',params:{ colGap:40, rowGap:24, cellGap:10, headGap:60 } },
  fishbone:{ strategy:'chain', params:{ axis:'x', dir:1, gap:70, stem:30, indent:26,
                                        alternate:true, start:'above', angle:35,
                                        gapMain:70, gapCross:22 } },
};

// Keeps only parameters the strategy declares, each within its allowed values.
// Unlike validateLayoutPreset() this REPAIRS rather than rejects: params arrive
// alongside a preset that is otherwise valid, so a single bad number should not
// discard the whole layout.
function validateLayoutParams(strategy, raw){
  const schema = LAYOUT_PARAMS[strategy];
  if(!schema) return {};
  const out = {};
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for(const [key, rule] of Object.entries(schema)){
    const v = raw[key];
    if(v === undefined) continue;
    if(rule === 'boolean'){ if(typeof v === 'boolean') out[key] = v; continue; }
    if(Array.isArray(rule) && typeof rule[0] === 'string'){ if(rule.includes(v)) out[key] = v; continue; }
    if(Array.isArray(rule)){
      if(typeof v !== 'number' || !isFinite(v)) continue;   // never coerce
      out[key] = Math.min(rule[1], Math.max(rule[0], Math.round(v)));
    }
  }
  return out;
}

// What autoLayout actually runs: a strategy plus a complete parameter set.
// Accepts a built-in engine name, a strategy name, or neither, and always
// returns something runnable - an unopenable map is never the right answer to
// a bad layout name.
function resolveLayout(name, params){
  const byEngine = ENGINE_PARAMS[name];
  const strategy = byEngine ? byEngine.strategy : (LAYOUT_PARAMS[name] ? name : 'tree');
  const base = byEngine ? byEngine.params : ENGINE_PARAMS.balanced.params;
  return { strategy, params: { ...base, ...validateLayoutParams(strategy, params) } };
}

const LAYOUT_ENGINES = ['balanced','right','left','down','up','timeline','stair','radial','grid','matrix','fishbone'];
const BUILTIN_LAYOUTS = [
  {v:1, id:'balanced', name:'Balanced', desc:'Branches split left & right', engine:'balanced'},
  {v:1, id:'right',    name:'Right',    desc:'All branches grow right',     engine:'right'},
  {v:1, id:'left',     name:'Left',     desc:'All branches grow left',      engine:'left'},
  {v:1, id:'down',     name:'Down',     desc:'Org-chart, top to bottom',    engine:'down'},
  {v:1, id:'timeline', name:'Timeline', desc:'Sequence along an axis, sub-topics alternating',
        engine:'timeline'},
  {v:1, id:'up',       name:'Up',       desc:'Inverted org, bottom to top', engine:'up'},
  {v:1, id:'stair',    name:'Stairs',   desc:'Vertical steps descending', engine:'stair'},
  {v:1, id:'radial',   name:'Radial',   desc:'Root at the centre, branches on rings', engine:'radial'},
  {v:1, id:'grid',     name:'Grid',     desc:'Top-level topics as cards, sub-topics as outlines',
        engine:'grid'},
  {v:1, id:'matrix',   name:'Matrix',   desc:'Columns and aligned rows, read like a table', engine:'matrix'},
  {v:1, id:'fishbone', name:'Fishbone', desc:'Spine with angled ribs, for cause-and-effect', engine:'fishbone'},
];
const CUSTOM_LAYOUTS_KEY = 'mindspark:layouts';

// A preset is per-device (localStorage), not per-map: it is a picker entry.
function loadCustomLayouts(){
  try{
    const raw = JSON.parse(localStorage.getItem(CUSTOM_LAYOUTS_KEY) || '[]');
    if(!Array.isArray(raw)) return [];
    return raw.map(validateLayoutPreset).filter(Boolean);
  }catch(e){ console.warn('could not read saved layouts:', e.message); return []; }
}
function saveCustomLayouts(list){
  try{ localStorage.setItem(CUSTOM_LAYOUTS_KEY, JSON.stringify(list)); return true; }
  catch(e){ console.warn('could not save layouts:', e.message); return false; }
}
function allLayouts(){ return BUILTIN_LAYOUTS.concat(loadCustomLayouts()); }
function findLayout(id){ return allLayouts().find(l=>l.id===id) || null; }

// Returns a clean preset, or null if it cannot be one. Null rather than
// defaults on purpose: a preset the user is importing should be REJECTED with
// a reason, not silently turned into something they did not ask for.
function validateLayoutPreset(raw){
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Either form is accepted: an engine name (shorthand for a built-in's
  // parameters) or a strategy with explicit params. A preset must name one.
  const hasEngine = LAYOUT_ENGINES.includes(raw.engine);
  const hasStrategy = typeof raw.strategy === 'string' && !!LAYOUT_PARAMS[raw.strategy];
  if(!hasEngine && !hasStrategy) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0,40) : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0,24) : '';
  if(!/^[a-z0-9][a-z0-9-]*$/i.test(id) || !name) return null;
  const out = { v:1, id, name };
  if(hasEngine) out.engine = raw.engine;
  if(hasStrategy){
    out.strategy = raw.strategy;
    out.params = validateLayoutParams(raw.strategy, raw.params);
  } else if(raw.params){
    // Params given against an engine name: validate under that engine's strategy.
    out.params = validateLayoutParams(ENGINE_PARAMS[raw.engine].strategy, raw.params);
  }
  if(typeof raw.desc === 'string' && raw.desc.trim()) out.desc = raw.desc.trim().slice(0,80);
  // Options reuse the layout-config validator, so bounds live in one place.
  if(raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)){
    out.options = validateLayoutConfig(raw.options);
  }
  return out;
}

function applyTheme(id){
  if(id==='custom'){ applyCustomTheme(); return; }
  clearCustomThemeVars();
  if(id && id!=='light') document.documentElement.setAttribute('data-theme', id);
  else document.documentElement.removeAttribute('data-theme');
  try{ localStorage.setItem('mindspark:theme', id||'light'); }catch(e){}
  // Colour theme doesn't change node size today, but re-render anyway rather
  // than assume that stays true forever - cheap, and matches applyLook below.
  if(map) render();
}
// Custom themes: the "Add theme" tile in the colour-theme panel. Unlike the
// built-ins a custom theme has no CSS block of its own - it carries the same
// 20 variables as themes/*.json and they are applied inline on :root. There is
// exactly one slot: importing again replaces the previous theme.
const CUSTOM_THEME_VARS = ['--toolbar-bg','--toolbar-text','--paper','--paper-2','--ink','--ink-soft','--line','--line-2','--accent','--accent-deep','--teal','--chrome','--chrome-edge','--node-bg','--node-ink','--canvas-dot','--stage-glow','--link','--shadow','--shadow-lg'];
// Repairs rather than rejects: out-of-range or non-colour values are dropped
// and the rest rebuilt, so a slightly-off paste still imports cleanly.
function validateCustomTheme(raw){
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if(typeof raw.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(raw.id)) return null;
  if(typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length>40) return null;
  if(!raw.vars || typeof raw.vars !== 'object' || Array.isArray(raw.vars)) return null;
  const vars = {};
  for(const key of CUSTOM_THEME_VARS){
    const v = raw.vars[key];
    if(typeof v !== 'string' || !v.trim() || v.trim().length>80) return null;
    vars[key] = v.trim();
  }
  return { v:1, id: raw.id, name: raw.name.trim(), vars };
}
function loadCustomTheme(){
  try{ return validateCustomTheme(JSON.parse(localStorage.getItem('mindspark:custom-theme')||'null')); }
  catch(e){ return null; }
}
function saveCustomTheme(theme){
  try{
    if(theme) localStorage.setItem('mindspark:custom-theme', JSON.stringify(theme));
    else localStorage.removeItem('mindspark:custom-theme');
    return true;
  }catch(e){ return false; }
}
function clearCustomThemeVars(){
  const root = document.documentElement;
  for(const key of CUSTOM_THEME_VARS) root.style.removeProperty(key);
}
function applyCustomTheme(){
  const theme = loadCustomTheme();
  if(!theme){
    // A stored 'custom' with no theme behind it is a stale save - fall back
    // and repair the storage rather than leaving the app on a half-theme.
    clearCustomThemeVars();
    document.documentElement.removeAttribute('data-theme');
    try{ localStorage.setItem('mindspark:theme', 'light'); }catch(e){}
    if(map) render();
    return;
  }
  clearCustomThemeVars();
  const root = document.documentElement;
  for(const [key, val] of Object.entries(theme.vars)) root.style.setProperty(key, val);
  root.setAttribute('data-theme', 'custom');
  try{ localStorage.setItem('mindspark:theme', 'custom'); }catch(e){}
  if(map) render();
}
// Push a pasted palette onto :root without importing it, so the map behind the
// Add-a-theme card shows the colours while a swatch is being dragged. Nothing is
// validated beyond the length cap that applyCustomTheme would apply anyway: this
// writes no storage and the dialog's close() restores what was inline before.
function previewCustomThemeVars(text){
  let parsed;
  try{ parsed = JSON.parse(text); }catch(e){ return; }
  const vars = parsed && parsed.vars;
  if(!vars || typeof vars !== 'object' || Array.isArray(vars)) return;
  const root = document.documentElement;
  for(const key of CUSTOM_THEME_VARS){
    const v = vars[key];
    if(typeof v === 'string' && v.trim() && v.trim().length <= 80) root.style.setProperty(key, v.trim());
  }
}
// Import / manage the single custom theme. Mirrors the layout import form: the
// theme is pasted as JSON, exactly as it appears in the themes/ folder. Only
// one imported theme can exist - pasting another replaces it.
function showThemeImportForm(){
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const cur = loadCustomTheme();
  const live = getComputedStyle(document.documentElement);
  const sample = spaceForSwatches(JSON.stringify({
    v:1, id:'my-theme', name:'My theme',
    vars: Object.fromEntries(CUSTOM_THEME_VARS.map(k=>[k, live.getPropertyValue(k).trim()])),
  }, null, 2));
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="Close">\u00d7</button>
      <h2>Add a theme</h2>
      <div class="vf-hint">A theme is a palette of ${CUSTOM_THEME_VARS.length} colour
        variables, exactly the format of the files in the themes/ folder. Paste
        one in to try it, or click the square beside any colour to pick a new
        one. Only one imported theme is kept at a time - importing again
        replaces it.</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(sample)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-hint" style="margin-top:12px">…or pick one of the ${THEMES.length-20} library themes - one click, no JSON</div>
      <div class="lib-grid">
        ${THEMES.slice(20).map(t=>`
          <button class="lib-card" data-lib="${t.id}" title="Import \u201c${escapeHtml(t.name.replace(/<br\s*\/?>/gi,' '))}\u201d">
            ${buildSwatchHTML(t)}<span class="lib-name">${t.name}</span>
          </button>`).join('')}
      </div>
      ${cur ? `<div class="vf-hint" style="margin-top:10px">Imported theme</div>
        <div class="li-list"><span class="li-chip">${escapeHtml(cur.name)}<button data-del="1" title="Remove">\u00d7</button></span></div>` : ''}
      <div class="vf-actions">
        <button class="vf-cancel">Cancel</button>
        <button class="vf-go primary">Import</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  // Also stop clicks bubbling: the Import button reopens the theme panel, and
  // without this the same click's bubble phase would hit the document-level
  // outside-click handler and close it again a frame later.
  m.addEventListener('click',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  // Snapshot what is inline on :root before previewing anything, and put
  // exactly that back on close. Byte for byte beats reasoning about which path
  // set it: a custom theme's 20 variables and the six theme-config knobs both
  // live here, and only one of them is ours to undo.
  const rootInline = {};
  for(const key of CUSTOM_THEME_VARS) rootInline[key] = document.documentElement.style.getPropertyValue(key);
  let previewed = false;
  attachColorSwatches(ta, text=>{ previewed = true; previewCustomThemeVars(text); });
  ta.focus();
  const close=()=>{
    closeColorPicker(); m.remove();
    if(!previewed) return;
    const root = document.documentElement;
    for(const key of CUSTOM_THEME_VARS){
      if(rootInline[key]) root.style.setProperty(key, rootInline[key]);
      else root.style.removeProperty(key);
    }
    // Node colours that are computed in JS rather than read from a variable
    // (pickContrast and friends) only catch up on a render.
    if(map) render();
  };
  const fail=msg=>{ err.hidden=false; err.textContent=msg; };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ return fail('Not valid JSON: '+e.message); }
    const theme = validateCustomTheme(parsed);
    if(!theme){
      return fail('Not a usable theme. It needs an "id" (lowercase letters, digits and dashes), '
        + 'a "name", and a "vars" object covering all '+CUSTOM_THEME_VARS.length+' colour variables.');
    }
    if(!saveCustomTheme(theme)) return fail('Could not save - this browser\u2019s storage may be full.');
    previewed = false;   // applyCustomTheme() below sets the final palette and renders
    close(); toast(`Theme \u201c${theme.name}\u201d imported`);
    applyCustomTheme();
    try{ $('#themeBtn').click(); }catch(_){}   // reopen so the new theme shows as active
  };
  const delBtn=m.querySelector('[data-del]');
  if(delBtn) delBtn.onclick=()=>{
    saveCustomTheme(null);
    // applyTheme() clears the 20 inline variables itself, so there is nothing
    // for close() to restore here: doing it anyway would paint the theme that
    // was just removed back onto :root.
    previewed = false;
    if(document.documentElement.getAttribute('data-theme')==='custom') applyTheme('light');
    close(); toast('Theme removed');
    try{ $('#themeBtn').click(); }catch(_){}
  };
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelectorAll('.lib-card').forEach(b=> b.onclick=()=>{
    importLibraryTheme(b.dataset.lib);
  });
}
// Import one of the shipped library themes (the ones beyond the panel's
// visible 20) straight from the Add-a-theme dialog. The theme's palette is
// read from its own live CSS block, so the imported result is exactly what
// the user sees - no server round-trip, no embedded copy of the JSON.
function importLibraryTheme(id){
  closeColorPicker();
  const t=THEMES.find(x=>x.id===id);
  if(!t) return;
  const root=document.documentElement;
  // The palette must be read from the theme's own CSS block, but two things
  // sit on :root as INLINE styles and would win over the attribute selector:
  // the six config knobs applyThemeConfigVars() writes, and (when a custom
  // theme is active) the previous custom theme's 20 inline variables. Clear
  // them for the read, then restore exactly what was there before.
  const saved={};
  for(const key of CUSTOM_THEME_VARS) saved[key]=root.style.getPropertyValue(key);
  const prev=root.getAttribute('data-theme');
  root.setAttribute('data-theme', id);
  const cs=getComputedStyle(root);
  const vars={};
  for(const key of CUSTOM_THEME_VARS){
    root.style.removeProperty(key);
    vars[key]=cs.getPropertyValue(key).trim();
  }
  for(const key of CUSTOM_THEME_VARS){
    if(saved[key]) root.style.setProperty(key, saved[key]);
    else root.style.removeProperty(key);
  }
  if(prev && prev!=='light') root.setAttribute('data-theme', prev);
  else root.removeAttribute('data-theme');
  const theme=validateCustomTheme({ v:1, id, name:t.name.replace(/<br\s*\/?>/gi,' ').trim(), vars });
  if(!theme){ toast('Could not import that theme'); return; }
  if(!saveCustomTheme(theme)){ toast('Could not save - this browser\u2019s storage may be full.'); return; }
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  toast(`Theme \u201c${theme.name}\u201d imported`);
  applyCustomTheme();
  try{ $('#themeBtn').click(); }catch(_){}   // reopen so the new theme shows as active
}
// "Look and feel" (Back to School, etc.) is font + chrome texture only -
// entirely CSS-driven (see :root[data-look=...] rules), so unlike the old
// isHandwrittenTheme() this needs no JS-side helper at all. Independent of
// applyTheme() (colors) and applyMapStyle() (card/branch shape) - all three
// are separate attributes that never override each other.
function applyLook(id){
  if(id && id!=='office') document.documentElement.setAttribute('data-look', id);
  else document.documentElement.removeAttribute('data-look');
  try{ localStorage.setItem('mindspark:look', id||'office'); }catch(e){}
  // Two things need to happen here, not just a re-render:
  // 1) Web fonts load asynchronously - the very first time Caveat/Patrick
  //    Hand gets used in a session, the font file may still be downloading
  //    at the exact moment this render() runs synchronously below. The
  //    browser then measures nodes against a FALLBACK font's metrics, and
  //    once the real font actually finishes loading, silently swaps it in
  //    and resizes the node text - with nothing re-measuring on its own,
  //    since it's a browser-internal event this code otherwise never reacts
  //    to. Explicitly wait for the specific font this look uses, then
  //    re-render once it's genuinely ready, to catch whatever the first
  //    render() got wrong.
  // 2) A look's larger font-size can make a node grow taller than it was
  //    (nodes are width:max-content, and min-height is now a floor, not a
  //    cap - see the node rendering code). Sibling positions were computed
  //    for the OLD, smaller sizes, and nothing moves them just because a
  //    node above/beside them grew in place - so a taller node can start
  //    overlapping its neighbour. autoLayout() re-tidies based on current
  //    sizes, the same way it already runs after a manual resize-drag. It
  //    needs the explicit render() right before it, not just to run alone:
  //    autoLayout() only force-remeasures nodes with NO measurement yet,
  //    not ones with a stale measurement from before the font changed, so
  //    without this render() first it would compute positions from
  //    outdated sizes.
  if(map){ render(); autoLayout(); }
  const look=LOOKS.find(l=>l.id===id);
  if(look && look.font && look.font!=='inherit' && document.fonts && document.fonts.load){
    const fontName = look.font.split(',')[0];   // '"Caveat"' from '"Caveat",cursive' - the
                                                  // actual web font; the rest is just a
                                                  // fallback keyword that needs no loading
    document.fonts.load('1em '+fontName).then(()=>{ if(map){ render(); autoLayout(); } }).catch(()=>{});
  }
}
// Interface layout: how the chrome itself is arranged. 'modern' is the local
// shell (full-width top bar + status bar with hint/overview); 'classic' is
// the upstream repo's floating shell (toolbar floats over the canvas, zoom +
// minimap float bottom-right, hint floats bottom-left, no status bar). The
// switch is class + reparenting: the same DOM nodes are moved between their
// modern and classic containers, so every listener stays wired.
const UI_LAYOUTS = [
  {id:'classic', name:'Classic<br>floating'},
  {id:'modern',  name:'Modern<br>bars'},
  {id:'rail',    name:'Side<br>toolbar'},
  {id:'zen',     name:'Zen<br>write'},
  {id:'dock',    name:'Bottom<br>dock'},
  {id:'split',   name:'Split<br>editor'},
  {id:'minimal', name:'Minimal<br>clean'},
  {id:'mirror',  name:'Mirror<br>floating'},
  {id:'outline', name:'Outline<br>dock'}
];
// ===== Outline dock - a live tree panel mirroring the map hierarchy =====
// Only exists in the ui-outline layout; the ▤ button toggles it (body class
// outline-open). Rows select + centre the node; the twist folds a branch in
// the outline only - the map itself is never touched. Rebuilt by render()
// alongside the breadcrumb, with a html-compare so steady state costs nothing.
const _olCollapsed=new Set();
let _olPrev='';
function ensureOutlinePane(){
  let pane=document.getElementById('outlinePane');
  if(pane) return pane;
  pane=document.createElement('div');
  pane.id='outlinePane';
  pane.innerHTML=`<div class="ol-head"><span>Outline</span>
      <button type="button" class="ol-close" title="Hide outline">✕</button></div>
    <div class="ol-body"></div>`;
  pane.querySelector('.ol-close').onclick=()=>document.body.classList.remove('outline-open');
  pane.addEventListener('click',e=>{
    const tw=e.target.closest('.ol-twist');
    if(tw){
      const li=tw.closest('.ol-node');
      const id=li.dataset.id;
      if(_olCollapsed.has(id)) _olCollapsed.delete(id); else _olCollapsed.add(id);
      li.classList.toggle('collapsed', _olCollapsed.has(id));
      return;
    }
    const row=e.target.closest('.ol-row');
    if(row){
      const id=row.closest('.ol-node').dataset.id;
      select(id,false); centreOn(id);
    }
  });
  const app=document.querySelector('.app');
  app.insertBefore(pane, app.querySelector('.stage'));
  return pane;
}
function renderOutline(){
  const pane=document.getElementById('outlinePane');
  if(!pane || !document.body.classList.contains('ui-outline')) return;
  const bodyEl=pane.querySelector('.ol-body'); if(!bodyEl) return;
  let html='';
  if(map){
    const hidden=hiddenSet();
    const buf=[];
    const walk=(ids, sub)=>{
      buf.push(sub?'<ul class="ol-sub">':'<ul class="ol-tree">');
      for(const id of ids){
        if(hidden.has(id)) continue;
        const n=map.nodes[id];
        const kids=childrenOf(id).filter(k=>!hidden.has(k));
        buf.push(`<li class="ol-node${id===sel?' sel':''}${_olCollapsed.has(id)?' collapsed':''}" data-id="${id}">`);
        buf.push(`<div class="ol-row"><span class="ol-twist${kids.length?'':' ol-leaf'}">▾</span>`);
        buf.push(`<span class="ol-label">${escapeHtml(nodeTextPlain(n.text||'')||'(untitled)')}</span></div>`);
        if(kids.length) walk(kids, true);
        buf.push('</li>');
      }
      buf.push('</ul>');
    };
    walk([map.rootId], false);
    html=buf.join('');
  }
  if(html!==_olPrev){
    _olPrev=html;
    const st=bodyEl.scrollTop;
    bodyEl.innerHTML=html;
    bodyEl.scrollTop=st;
  }
}
$('#outlineBtn')?.addEventListener('click',()=>{
  if(!document.body.classList.contains('ui-outline')) return;
  document.body.classList.toggle('outline-open');
  refitStageAfterChrome();   // the dock takes 280px off the canvas - re-fit once it has slid
});

// ===== Tabs - browser-style strip for open maps =====
// Opt-in via the ▭ toolbar button (persisted). Each open map lives in its own
// tab as a deep clone; the active tab's map IS the global `map`. Switching tabs
// flushes the outgoing map's pending save (bound to its own object), swaps the
// global, rebuilds undo history and restores that map's saved camera.
let tabsEnabled=false; try{ tabsEnabled=localStorage.getItem('mindspark:tabs')==='1'; }catch(e){}
let _tabs=[];          // [{key, title, map}]
let _tabActive=-1;
function setTabsEnabled(on){
  tabsEnabled=!!on;
  try{ localStorage.setItem('mindspark:tabs', tabsEnabled?'1':'0'); }catch(e){}
  document.body.classList.toggle('tabs-on', tabsEnabled);
  const btn=document.getElementById('tabsBtn'); if(btn) btn.classList.toggle('on', tabsEnabled);
  if(tabsEnabled){
    if(_tabs.length===0 && map){ _tabs=[{key:map.id, title:map.title||'Untitled', map}]; _tabActive=0; }
    renderTabs();
  } else {
    _tabs=[]; _tabActive=-1;
    document.getElementById('tabStrip')?.classList.add('hidden');
  }
}
function renderTabs(){
  const strip=document.getElementById('tabStrip'); if(!strip) return;
  strip.classList.toggle('hidden', !tabsEnabled);
  const row=document.getElementById('tabRow'); if(!row) return;
  row.innerHTML='';
  _tabs.forEach((t,i)=>{
    const b=document.createElement('button');
    b.className='tab'+(i===_tabActive?' active':'');
    b.title=t.title||'Untitled';
    b.innerHTML=`<span class="tab-title"></span>${_tabs.length>1?`<span class="tab-close" title="Close">✕</span>`:''}`;
    b.querySelector('.tab-title').textContent=t.title||'Untitled';
    b.addEventListener('click',()=>_activateTab(i));
    const cx=b.querySelector('.tab-close');
    if(cx) cx.addEventListener('click',e=>{ e.stopPropagation(); closeTab(i); });
    row.appendChild(b);
  });
}
function openMapInTab(m){
  const key=m.id;
  const ex=_tabs.findIndex(t=>t.key===key);
  if(ex>=0){ _activateTab(ex); return; }
  _tabs.push({key, title:m.title||'Untitled', map: JSON.parse(JSON.stringify(m))});
  _activateTab(_tabs.length-1);
}
function _activateTab(i){
  const t=_tabs[i]; if(!t) return;
  if(i===_tabActive){ renderTabs(); return; }
  flushPendingSave();
  map=t.map; sel=map.rootId;
  const _imported=!!map._import; if(_imported) delete map._import;
  history=[JSON.stringify({nodes:map.nodes,rootId:map.rootId,title:map.title,color:map.color})];
  hpos=0; updateUndo();
  $('#mapTitle').value=map.title;
  _tabActive=i;
  render();
  if(_imported){ balanceRootSides(); autoLayout(); }
  const saved=loadMapView(map.id);
  if(saved) applyMapView(saved);
  else if(userZoom!=null){ view.k=userZoom; recenter(); }
  else fit();
  if(mdMode) syncTextFromMap();
  renderTabs(); refreshList();
}
function closeTab(i){
  if(_tabs.length<=1) return;   // the last tab stays put
  flushPendingSave();
  const wasActive=(i===_tabActive);
  _tabs.splice(i,1);
  if(wasActive){
    _tabActive=-1;              // force _activateTab to run (its guard skips same-index calls)
    _activateTab(Math.max(0, i-1));
  } else if(i<_tabActive) _tabActive--;
  renderTabs();
}
$('#tabsBtn')?.addEventListener('click',()=>setTabsEnabled(!tabsEnabled));
document.getElementById('tabNew')?.addEventListener('click',()=>{ if(!tabsEnabled) setTabsEnabled(true); createMap(); });

// Stage size the current layout switch left behind. A switch that leaves the
// stage the same size keeps the user's pan/zoom untouched; one that grows or
// shrinks it re-fits the map to the new canvas (see the tail of applyUiLayout).
let _prevLayoutStageKey='';
let _layoutFitTimer=0;
// Re-fits the map whenever chrome changed the stage's edges. It runs twice on
// purpose: once now, which is the whole story for a layout that resizes the
// stage outright, and once more after the panes that slide have settled.
// #mdPane, #outlinePane and .side all animate their width over 220ms, so a
// single synchronous measurement reads the stage the map is about to LEAVE:
// entering the outline dock fitted to a canvas 253px wider than the one that
// arrived and clipped the map's right edge, and leaving the split editor
// fitted to the narrow half and parked the map in the left third. The second
// pass is a no-op when nothing slid, since the stage key is then unchanged.
function refitStageAfterChrome(){
  if(!map) return;
  const pass=()=>{
    const sz=_stageSize(), key=sz.w+'x'+sz.h;
    if(key===_prevLayoutStageKey) return;      // stage stood still - keep the user's pan/zoom
    _prevLayoutStageKey=key;
    animateViewTo(computeFitView(), 260);
  };
  pass();
  clearTimeout(_layoutFitTimer);
  _layoutFitTimer=setTimeout(pass, 280);       // 220ms width transition plus a frame of slack
}
function applyUiLayout(id){
  const classic=(id==='classic'||id==='mirror'), rail=(id==='rail'), zen=(id==='zen'),
        dock=(id==='dock'), split=(id==='split'), minimal=(id==='minimal'), mirror=(id==='mirror'),
        outline=(id==='outline');
  document.body.classList.toggle('ui-classic', classic);   // mirror reuses every classic rule
  document.body.classList.toggle('ui-rail', rail);
  document.body.classList.toggle('ui-zen', zen);
  document.body.classList.toggle('ui-dock', dock);
  document.body.classList.toggle('ui-split', split);
  document.body.classList.toggle('ui-minimal', minimal);
  document.body.classList.toggle('ui-mirror', mirror);
  document.body.classList.toggle('ui-outline', outline);
  document.body.classList.remove('outline-open');   // the outline dock starts folded
  if(!outline){ document.getElementById('outlinePane')?.remove(); _olPrev=''; }   // a fresh pane must render, never hit the html-compare cache
  document.body.classList.remove('zen-chrome');   // zen chrome is revealed on hover, never persisted
  // Pin toolbar button is zen-only: remove it immediately when leaving zen
  // (classic/rail branches bypass restoreShell, so they would otherwise leak
  // the button when switching away from zen).
  if (!zen) document.getElementById('zenPin')?.remove();
  document.body.classList.remove('side-open');    // the dock slide-over is always closed on a switch
  const _minMenu=document.getElementById('minimalMenu'); if(_minMenu) _minMenu.hidden=true;   // ditto the launcher menu
  if(document.body.classList.contains('ui-deck')) exitDeck();   // presentation is transient
  // Only the split editor keeps the markdown pane on; every other layout
  // starts with it closed and the toggle reset.
  document.body.classList.remove('md-mode','md-ready');
  const mdt=document.getElementById('mdToggle'); if(mdt) mdt.classList.remove('on');
  try{ localStorage.setItem('mindspark:uiLayout', id||'modern'); }catch(e){}
  const app=document.querySelector('.app'), stage=$('#stage'),
        topbar=document.querySelector('.topbar'), side=$('#side'),
        brand=document.querySelector('.brand'), statusBar=$('#statusBar'),
        hint=$('#hint'), sbRight=document.querySelector('.sb-right'),
        overview=$('#overview'), toggleSide=$('#toggleSide'),
        newMap=$('#newMap'), titleEdit=document.querySelector('.title-edit'),
        zoomRow=document.querySelector('.zoom-row'), overviewToggle=$('#overviewToggle'),
        sideTabs=document.querySelector('.side-tabs');
  const rewireSide=()=>{               // non-dock layouts: tabs switch panes in place
    // The dock lends .side-tabs to the status bar, and it must come home before
    // any branch runs: classic/rail/zen skip restoreShell, so leaving the tabs
    // in the dock stranded them there, and classic's `side.insertBefore(nmRow,
    // .side-tabs)` then threw NotFoundError and aborted the whole switch.
    // rewireSide runs for every layout ahead of the branches, so it re-homes.
    if(sideTabs && sideTabs.parentNode!==side) side.insertBefore(sideTabs, side.querySelector('.side-pane'));
    toggleSide.onclick=toggleSidePanel;
    const tm=document.getElementById('sideTabMaps'), tt=document.getElementById('sideTabTpls');
    if(tm) tm.onclick=()=>setSideTab('maps');
    if(tt) tt.onclick=()=>setSideTab('tpls');
  };
  const restoreShell=()=>{             // put every reparented piece back into the modern shell
    app.insertBefore(topbar, side);              // restore grid order: topbar first
    statusBar.insertBefore(hint, statusBar.firstChild);
    statusBar.appendChild(overview);
    overview.insertBefore(zoomRow, overviewToggle);   // back inside the chip, before the chevron
    brand.appendChild(toggleSide);
    brand.insertBefore(newMap, toggleSide);      // back into the brand row
    newMap.textContent='＋';
    topbar.insertBefore(titleEdit, topbar.firstChild);
    $('#addChild').textContent='＋ Topic';
    document.querySelector('.new-map-row')?.remove();
    topbar.querySelectorAll('.tb-orphan').forEach(g=>g.remove());
    document.getElementById('zenPin')?.remove();   // pin toggle is zen-only
    [$('#savePill'),$('#tokenTotal'),$('#userPill')].forEach(p=>{ if(p) sbRight.appendChild(p); });
    side.classList.remove('collapsed','side-open'); side.style.width='';
  };
  rewireSide();   // every layout starts with the plain tab/toggle wiring; dock overrides below
  if(classic){
    // Toolbar floats inside the canvas (as upstream); pills already live in
    // .topbar in classic order (user-pill, token-total, save-pill).
    stage.appendChild(topbar);
    stage.appendChild(overview);
    // The zoom controls become the standalone vertical zoombar (as upstream),
    // floating beside the minimap card instead of inside it.
    stage.appendChild(zoomRow);
    stage.appendChild(hint);
    let grp=topbar.querySelector('.tb-orphan');
    if(!grp){ grp=document.createElement('div'); grp.className='tb-group tb-orphan';
      grp.appendChild(toggleSide); topbar.insertBefore(grp, topbar.firstChild); }
    grp.after(titleEdit);                            // title sits beside the ☰ group, as upstream
    [$('#userPill'),$('#tokenTotal'),$('#savePill')].forEach(p=>{ if(p) topbar.appendChild(p); });
    $('#addChild').textContent='＋ Topic';
    // The collapse chevron is hidden in classic, so never start collapsed there.
    overview.classList.remove('collapsed');
    // Sidebar shell (as upstream): brand keeps only the mark + title; the
    // new-map row sits beneath with a wide "＋ New mind map" and a ▾ caret
    // that opens the template dropdown (as in original MindSpark classic floating).
    let nmRow=document.querySelector('.new-map-row');
    if(!nmRow){
      nmRow=document.createElement('div'); nmRow.className='new-map-row';
      side.insertBefore(nmRow, document.querySelector('.side-tabs'));
      nmRow.appendChild(newMap);
      newMap.textContent='＋ New mind map';   // wide label, as upstream
      const caret=document.createElement('button'); caret.type='button';
      caret.className='new-map-caret'; caret.id='newMapMenu';
      caret.title='Start from a template'; caret.textContent='\u25be';
      caret.addEventListener('click',(e)=>{
        e.stopPropagation();
        showTemplatesMenu();
      });
      nmRow.appendChild(caret);
    }
  }else if(rail){
    // Side-toolbar layout: the toolbar becomes a vertical icon rail docked
    // left of the canvas (side | rail | stage). Title, save feedback, minimap
    // card, zoombar and hint float over the canvas, exactly like classic.
    app.insertBefore(topbar, stage);             // grid order: side, rail, stage
    let grp=topbar.querySelector('.tb-orphan');
    if(!grp){ grp=document.createElement('div'); grp.className='tb-group tb-orphan';
      grp.appendChild(toggleSide); topbar.insertBefore(grp, topbar.firstChild); }
    $('#addChild').textContent='＋';            // icon-only in the narrow rail
    stage.appendChild(titleEdit);                // floating title, top-left
    stage.appendChild(overview);
    stage.appendChild(zoomRow);
    stage.appendChild(hint);
    stage.appendChild($('#savePill'));           // floating save feedback, top-right
    overview.classList.remove('collapsed');
    // If coming from classic, the wide new-map row must go back to a compact
    // brand button (toggleSide stays on the rail here, so no insertBefore).
    const nmRow=document.querySelector('.new-map-row');
    if(nmRow){ nmRow.remove(); brand.appendChild(newMap); newMap.textContent='＋'; }
  }else if(zen){
    // Zen / write layout: the whole shell disappears and the canvas takes
    // everything. A slim floating toolbar (the same .topbar) slides in near
    // the top edge on hover (wireZen) and holds the title, search, actions
    // and save pill; minimap card, zoombar and hint stay floating as classic.
    stage.appendChild(topbar);
    stage.appendChild(overview);
    stage.appendChild(zoomRow);
    stage.appendChild(hint);
    stage.appendChild($('#savePill'));
    $('#addChild').textContent='＋ Topic';       // horizontal strip keeps the label
    let grp=topbar.querySelector('.tb-orphan');
    if(!grp){ grp=document.createElement('div'); grp.className='tb-group tb-orphan';
      grp.appendChild(toggleSide); topbar.insertBefore(grp, topbar.firstChild); }
    grp.after(titleEdit);                        // title beside the ☰ group, as classic
    [$('#userPill'),$('#tokenTotal')].forEach(p=>{ if(p) topbar.appendChild(p); });
    // Pin toggle: keeps the centered bar always visible (no top-edge hover needed).
    // State persists in localStorage; restored at boot below.
    let pin=document.getElementById('zenPin');
    if(!pin){
      pin=document.createElement('button'); pin.type='button'; pin.id='zenPin';
      pin.className='tb'; pin.title='Pin toolbar (always visible)';
      pin.textContent='\uD83D\uDCCC';   // 📌 round pushpin
      pin.addEventListener('click',()=>{
        const on=!document.body.classList.contains('zen-pinned');
        document.body.classList.toggle('zen-pinned',on);
        try{ localStorage.setItem('mindspark:zenPinned',on?'1':'0'); }catch(e){}
        pin.classList.toggle('on',on);
        pin.textContent='\uD83D\uDCCC';   // 📌 pin for both states - .on background shows pinned
        pin.title=on?'Unpin toolbar':'Pin toolbar (always visible)';
      });
    }
    topbar.appendChild(pin);
    const _pinned=document.body.classList.contains('zen-pinned');
    pin.classList.toggle('on',_pinned);
    pin.textContent='\uD83D\uDCCC';   // 📌 pinned and unpinned - .on distinguishes
    pin.title=_pinned?'Unpin toolbar':'Pin toolbar (always visible)';
    overview.classList.remove('collapsed');
    const nmRow=document.querySelector('.new-map-row');
    if(nmRow){ nmRow.remove(); brand.appendChild(newMap); newMap.textContent='＋'; }
  }else if(outline){
    // Outline dock: the modern shell plus a live tree panel between the
    // sidebar and the canvas (side | outline | canvas). The ▤ button in the
    // toolbar folds it in and out; rows select + centre the node.
    restoreShell();
    rewireSide();
    ensureOutlinePane();
    renderOutline();
    document.body.classList.add('outline-open');
  }else if(minimal){
    // Minimal: the plain modern shell with the sidebar removed entirely - no
    // column, no slide-over. The compact ＋ stays in the brand row; the
    // sidebar toggle is hidden since there is nothing to toggle. Instead the
    // MindSpark logo at the top-left opens the launcher menu, whose Maps and
    // Templates entries slide the sidebar in as an overlay so those panels
    // stay reachable.
    restoreShell();
    rewireSide();
    ensureMinimalMenu();
  }else if(dock){
    // Bottom-dock layout: the status bar becomes a full-width dock that owns
    // the sidebar toggle, the Maps/Templates tabs, the hint and the overview
    // chip; the sidebar turns into a slide-over panel opened from the dock.
    restoreShell();
    app.insertBefore(stage, statusBar);          // grid order: topbar, stage, dock, side
    statusBar.insertBefore(toggleSide, statusBar.firstChild);
    statusBar.insertBefore(sideTabs, toggleSide.nextSibling);
    toggleSide.onclick=toggleDockSide;
    const tm=document.getElementById('sideTabMaps'), tt=document.getElementById('sideTabTpls');
    if(tm) tm.onclick=()=>{ setSideTab('maps'); document.body.classList.add('side-open'); };
    if(tt) tt.onclick=()=>{ setSideTab('tpls'); document.body.classList.add('side-open'); };
   }else if(split){
    // Split editor: the modern shell plus the markdown pane pinned open as a
    // permanent third column (side | editor | canvas). The pane stays resizable.
    restoreShell();
    rewireSide();
    document.body.classList.add('md-ready');
    mdMode=false; toggleMdMode(true);            // force the pane on; width comes from --md-w
  }else{
    restoreShell();
    rewireSide();
  }
  // The stage just changed size, so re-measure and re-render the canvas.
  renderTabs();   // tab strip visibility depends on the layout (hidden in floating shells)
  if(map){
    render();
    // The switch moved the stage's edges - re-fit the map to the new canvas
    // so it expands (or contracts) to use the space the switch freed up,
    // computed from the map's current content. Layouts that leave the stage
    // the same size keep the current pan/zoom untouched.
    refitStageAfterChrome();
  }
}
// Minimal layout: a Raspberry-Pi-OS-style launcher. The MindSpark logo sits
// beside the map title at the top-left; clicking it opens a menu whose items
// cascade like a classic start menu: Maps lists every saved map (click to
// load), Templates drills down through categories to individual templates
// (click to create), and Open source links out to GitHub and the MindSpark GPT.
let _minimalMenuWired=false;
function ensureMinimalMenu(){
  const topbar=document.querySelector('.topbar');
  let btn=document.getElementById('minimalMenuBtn');
  if(!btn){
    btn=document.createElement('button');
    btn.type='button'; btn.id='minimalMenuBtn'; btn.className='minimal-menu-btn';
    btn.title='Menu';
    btn.innerHTML='<svg viewBox="0 0 64 64"><defs><radialGradient id="minMenuGrad" cx="30%" cy="25%"><stop offset="0%" stop-color="#ff8a5b"/><stop offset="100%" stop-color="#e0613a"/></radialGradient></defs><rect x="4" y="4" width="56" height="56" rx="14" fill="url(#minMenuGrad)"/><path d="M32 14 L36.5 27.5 L50 32 L36.5 36.5 L32 50 L27.5 36.5 L14 32 L27.5 27.5 Z" fill="#fff" opacity=".95"/></svg>';
  }
  topbar.insertBefore(btn, topbar.firstChild);   // logo stays beside the map title (restoreShell re-inserts the title first)
  if(_minimalMenuWired) return; _minimalMenuWired=true;
  const menu=document.createElement('div');
  menu.id='minimalMenu'; menu.className='minimal-menu'; menu.hidden=true;
  const GH_SVG='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.57 9.57 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85V21c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z"/></svg>';
  const BRAIN_SVG='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 2a8 8 0 1 1-8 8 8 8 0 0 1 8-8zm-3.5 9.5l3-3 3 3-1.5 1.5-1.5-1.5-1.5 1.5z"/></svg>';
  const BUG_SVG='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 2a8 8 0 1 1-8 8 8 8 0 0 1 8-8zm-1 4h2v6h-2zm0 8h2v2h-2z"/></svg>';
  menu.innerHTML=
    '<button type="button" class="mm-item mm-has-sub" data-sub="minimalMapsSub"><span class="mm-ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3L3 5.5V21l6-2.5 6 2.5 6-2.5V3l-6 2.5L9 3zm0 2.2l6 2.4v11.2l-6-2.4V5.2z"/></svg></span><span class="mm-lbl">Maps</span><span class="mm-caret">▸</span></button>'+
    '<button type="button" class="mm-item mm-has-sub" data-sub="minimalTplSub"><span class="mm-ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/></svg></span><span class="mm-lbl">Templates</span><span class="mm-caret">▸</span></button>'+
    '<button type="button" class="mm-item mm-has-sub" data-sub="minimalGhSub"><span class="mm-ic">'+GH_SVG+'</span><span class="mm-lbl">Open source</span><span class="mm-caret">▸</span></button>';
  document.body.appendChild(menu);
  // Cascade panels live on <body> - NOT inside the animated menu - so their
  // fixed positioning stays relative to the viewport (a transformed ancestor
  // would otherwise become their containing block and misplace them).
  const subs=new Set();
  // Hide panels below a given cascade depth, keeping one panel (the one about
  // to open) visible. Depth 1 = top-level cascades (Maps/Templates/Open source),
  // depth 2 = category drills - opening a deeper panel must NOT hide the
  // category list it hangs off, or its items lose their rects and the panel
  // would be placed at the menu's spot.
  const hideSubs=(keep, depth)=>subs.forEach(s=>{ if(s!==keep && (depth===undefined || +s.dataset.depth >= depth)) s.hidden=true; });
  const makeSub=(id, innerHTML)=>{
    let s=document.getElementById(id);
    if(s) return s;
    s=document.createElement('div');
    s.id=id; s.className='minimal-sub'; s.hidden=true; s.dataset.depth='1';
    if(innerHTML) s.innerHTML=innerHTML;
    document.body.appendChild(s); subs.add(s);
    return s;
  };
  // Pure placement decision for a cascade panel: given the anchor item rect, the
// panel's size and the viewport/menu bounds, decide where the panel should sit.
// Returns {top, left} in viewport coordinates. The main menu sits at the
// top-left, so a panel must never cover it: it opens to the right of the item
// (at least 4px past the menu's right edge) when that fits, otherwise flips to
// the left only if it clears the menu, and otherwise drops below the item
// (below the menu) so every level stays reachable.
function minimalSubPlacement(rect, subW, subH, vw, vh, menuLeft, menuRight){
  let top=rect.top, left=Math.max(rect.right+4, menuRight+4);   // clear the menu box
  if(left+subW>vw-8){                       // too wide for the right
    const flipLeft=rect.left-subW-4;
    if(flipLeft>=menuRight){                // clears the menu on the left
      left=flipLeft;
    } else {                                // would cover the menu: cascade downward
      top=rect.bottom+4; left=rect.left;
    }
  }
  if(top+subH>vh-8) top=Math.max(8, vh-subH-8);
  return { top, left };
}
// Position a cascade next to its anchor rect (captured before any panel is
// hidden, so the anchor's coordinates are still valid) - see minimalSubPlacement.
  const placeSub=(sub, r, anchor)=>{
    const menuRect=menu.getBoundingClientRect();
    const z = (typeof _uiZ==='function' ? _uiZ() : 1) || 1;
    // r and menuRect are in visual pixels (zoom-scaled), while offsetWidth/
    // window.innerWidth are in CSS pixels. Convert to a common space (CSS)
    // so the 1080p (zoom 0.9) vs 2K (zoom 1.0) gap is consistent and submenus
    // never overlap the main menu.
    const rCss = {left:r.left/z, right:r.right/z, top:r.top/z, bottom:r.bottom/z};
    const menuCss = {left:menuRect.left/z, right:menuRect.right/z};
    // Measure natural size without the CSS max-height cap (min(70vh,420px))
    // otherwise a tall Templates list would be capped at 420 and we'd think it
    // fits when it actually needs viewport-aware scrolling.
    const prevMaxH = sub.style.maxHeight;
    const prevOver = sub.style.overflowY;
    sub.style.maxHeight='none'; sub.style.overflowY='';
    sub.style.visibility='hidden'; sub.hidden=false;
    const w=sub.offsetWidth, h=sub.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let p=minimalSubPlacement(rCss, w, h, vw, vh, menuCss.left, menuCss.right);
    // Depth 2+ : anchor lives inside a minimal-sub. Ensure we also clear that
    // parent panel, not just the main menu, otherwise the child slightly
    // overlaps its parent (parent right 400, child left 398 = 2px overlap).
    if(anchor){
      const parentSub = anchor.closest('.minimal-sub');
      if(parentSub){
        const pr = parentSub.getBoundingClientRect();
        const prCss = {left:pr.left/z, right:pr.right/z};
        const need = prCss.right + 8; // 8px gap from parent edge
        if(p.left < need) p.left = need;
        // If that pushes it off-screen, let minimalSubPlacement's flip logic
        // handle it, but re-check after.
        if(p.left + w > vw - 8){
          const flipLeft = rCss.left - w - 8;
          if(flipLeft >= menuCss.right && flipLeft >= prCss.right) p.left = flipLeft;
          else { p.top = rCss.bottom + 4; p.left = rCss.left; }
          if(p.top + h > vh - 8) p.top = Math.max(8, vh - h - 8);
        }
      }
    }
    sub.style.top=p.top+'px'; sub.style.left=p.left+'px';
    // Only constrain height / show scrollbar when content would overflow viewport
    const available = vh - p.top - 8;
    if(h > available){
      sub.style.maxHeight = Math.max(120, available) + 'px';
      sub.style.overflowY = 'auto';
    } else {
      sub.style.maxHeight = 'none';
      sub.style.overflowY = '';
    }
    sub.style.visibility='';
    // Restore if we are not constraining? Already set to none/''.
  };
  const showSub=(sub, anchor, depth)=>{
    const r=anchor.getBoundingClientRect();   // capture BEFORE hideSubs hides the anchor's own panel
    hideSubs(sub, depth);
    if(!sub) return;
    placeSub(sub, r, anchor);
    if(sub.id==='minimalMapsSub') renderMaps(sub);
    else if(sub.id==='minimalTplSub') renderTpl(sub);
    else if(sub.dataset.cat) renderTplCat(sub);
    sub.hidden=false;
  };
  const closeLauncher=()=>{ menu.hidden=true; hideSubs(); };
  // Maps cascade - every saved map (dot + title, active map highlighted,
  // pinned ones flagged) plus shared maps; clicking loads the map.
  const renderMaps=async panel=>{
    panel.innerHTML='';
    let idx=[];
    try{ idx=await Store.list(); }catch(e){ idx=[]; }
    if(map && !map._cloudView){
      const local={id:map.id,title:map.title,color:map.color,updated:map.updated||Date.now(),pinned:map.pinned||undefined};
      const at=idx.findIndex(m=>m.id===map.id);
      if(at>=0) idx[at]={...idx[at],...local}; else idx.unshift(local);
    }
    idx.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0)||(b.updated||0)-(a.updated||0));
    const add=item=>{
      const el=document.createElement('button');
      el.type='button'; el.className='mm-item'+(item.active?' active':'');
      if(item.id!==undefined) el.dataset.mapId=item.id;
      else{ el.dataset.room=item.room||''; el.dataset.token=item.token||''; }
      el.innerHTML='<span class="mm-ic"><span class="dot" style="background:'+(item.color||'#e0613a')+'"></span></span><span class="mm-lbl">'+escapeHtml(item.title||'Untitled')+'</span>'+(item.pinned?'<span class="mm-pin">📌</span>':'');
      panel.appendChild(el);
    };
    if(!idx.length) panel.innerHTML='<div class="mm-empty">No maps yet</div>';
    else idx.forEach(m=>add({...m, active: map && m.id===map.id}));
    const _byMe=_sharedByMeStore(), _withMe=_sharedStore();
    const _seen=new Set(); const _unified=[];
    _byMe.forEach(x=>{ const room=x.room||x.id; if(!room||_seen.has(room)) return; _seen.add(room); _unified.push({room,token:x.token,title:x.title,color:x.color}); });
    _withMe.forEach(x=>{ const room=x.id; if(!room||_seen.has(room)) return; _seen.add(room); _unified.push({room,token:x.token,title:x.title,color:x.color}); });
    if(_unified.length){
      const hdr=document.createElement('div'); hdr.className='map-group-label'; hdr.textContent='Shared maps';
      panel.appendChild(hdr);
      _unified.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).forEach(sm=>add({...sm, room:sm.room, token:sm.token, title:sm.title||'Shared map'}));
    }
  };
  // Templates cascade - category list first; each category drills into its own
  // sub-panel of templates.
  const renderTpl=panel=>{
    panel.innerHTML='';
    let any=false;
    for(const c of TEMPLATE_CATEGORIES){
      const entries=Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===c.id);
      if(!entries.length) continue;
      any=true;
      const el=document.createElement('button');
      el.type='button'; el.className='mm-item mm-has-sub'; el.dataset.cat=c.id;
      el.innerHTML='<span class="mm-ic" style="color:'+c.color+'">'+escapeHtml(c.icon||'✦')+'</span><span class="mm-lbl">'+escapeHtml(c.label)+'</span><span class="mm-caret">▸</span>';
      panel.appendChild(el);
    }
    if(!any) panel.innerHTML='<div class="mm-empty">No templates</div>';
  };
  const renderTplCat=panel=>{
    const c=TEMPLATE_CATEGORIES.find(c=>c.id===panel.dataset.cat)||{label:'Templates',color:'#8c5da7'};
    panel.innerHTML='';
    const hdr=document.createElement('div'); hdr.className='map-group-label'; hdr.textContent=c.label; panel.appendChild(hdr);
    const entries=Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===c.id);
    if(!entries.length){ panel.innerHTML='<div class="mm-empty">No templates</div>'; return; }
    entries.forEach(([id,t])=>{
      const el=document.createElement('button');
      el.type='button'; el.className='mm-item'; el.dataset.tpl=id;
      el.innerHTML='<span class="mm-ic" style="color:'+(t.color||c.color)+'">'+escapeHtml(t.icon||'✦')+'</span><span class="mm-lbl">'+escapeHtml(t.name)+'</span>';
      panel.appendChild(el);
    });
  };
  // Open-source cascade.
  const ghSub=makeSub('minimalGhSub',
    '<a class="mm-item" data-ref="ghRepoLink"><span class="mm-ic">'+GH_SVG+'</span><span class="mm-lbl">GitHub</span></a>'+
    '<a class="mm-item" data-ref="gptLink"><span class="mm-ic">'+BRAIN_SVG+'</span><span class="mm-lbl">MindSpark GPT</span></a>'+
    '<a class="mm-item" data-ref="ghIssueLink"><span class="mm-ic">'+BUG_SVG+'</span><span class="mm-lbl">Report bug</span></a>');
  ghSub.addEventListener('click',e=>{
    const it=e.target.closest('.mm-item'); if(!it) return;
    const l=document.getElementById(it.dataset.ref);
    if(l && l.href && l.href!=='#'){ closeLauncher(); window.open(l.href,'_blank','noopener'); }
  });
  // Maps cascade actions.
  const mapsSub=makeSub('minimalMapsSub');
  mapsSub.addEventListener('click',e=>{
    const it=e.target.closest('.mm-item'); if(!it) return;
    closeLauncher();
    const id=it.dataset.mapId, room=it.dataset.room;
    if(id){ if(!map || map.id!==id) loadMap(id); }
    else if(room) openSharedInPlace(room, it.dataset.token);
  });
  // Templates cascade actions: category items drill in, template items create.
  const tplSub=makeSub('minimalTplSub');
  tplSub.addEventListener('click',e=>{
    const it=e.target.closest('.mm-item'); if(!it) return;
    if(it.dataset.cat){
      const s=makeSub('minimalTplCat_'+it.dataset.cat); s.dataset.cat=it.dataset.cat; s.dataset.depth='2';
      if(!s.hidden){ s.hidden=true; return; }
      showSub(s, it, 2);
      return;
    }
  });
  // Hover opens the cascade; a short grace period lets the pointer travel into
  // the sub-panel before it closes again. Re-entering the main menu always
  // collapses every cascade so the top-level items are reachable again.
  menu.addEventListener('mouseenter',()=>hideSubs());
  menu.querySelectorAll('.mm-has-sub').forEach(item=>{
    item.addEventListener('mouseenter',()=>showSub(document.getElementById(item.dataset.sub), item, 1));
  });
  tplSub.addEventListener('mouseover',e=>{
    const it=e.target.closest('.mm-item[data-cat]');
    if(it){ const s=makeSub('minimalTplCat_'+it.dataset.cat); s.dataset.cat=it.dataset.cat; s.dataset.depth='2'; showSub(s, it, 2); }
  });
  // Any template item click creates the map from that template.
  document.addEventListener('click',e=>{
    const it=e.target.closest('.minimal-sub .mm-item[data-tpl]');
    if(it){
      const id=it.dataset.tpl;
      closeLauncher();
      if(typeof createMapFromTemplate==='function') createMapFromTemplate(id);
    }
  });
  // Close the cascade when the pointer leaves the menu and all open sub-panels.
  let _mmLeaveTimer=null;
  const scheduleHide=()=>{ clearTimeout(_mmLeaveTimer); _mmLeaveTimer=setTimeout(()=>{ if(!menu.matches(':hover') && ![...subs].some(s=>s.matches(':hover'))) hideSubs(); },120); };
  menu.addEventListener('mouseleave',scheduleHide);
  subs.forEach(s=>{ s.addEventListener('mouseenter',()=>clearTimeout(_mmLeaveTimer)); s.addEventListener('mouseleave',scheduleHide); });
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    if(menu.hidden){ closeAllMenus(); hideSubs(); const r=btn.getBoundingClientRect(); const z=(typeof _uiZ==='function'?_uiZ():1)||1; menu.style.top=(r.bottom/z+6)+'px'; menu.style.left=(r.left/z)+'px'; menu.hidden=false; }
    else closeLauncher();
  });
  menu.addEventListener('click',e=>{
    const it=e.target.closest('.mm-item'); if(!it) return;
    const sub=it.dataset.sub;
    if(sub){   // toggle the cascade (touch users have no hover)
      const s=document.getElementById(sub);
      if(s && !s.hidden){ s.hidden=true; return; }
      showSub(s, it);
    }
  });
  document.addEventListener('click',e=>{ if(!e.target.closest('#minimalMenuBtn, #minimalMenu, .minimal-sub')) closeLauncher(); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeLauncher(); });
}
// Zen chrome reveal: sliding the mouse near the top edge of the canvas shows
// the floating toolbar (and hides it again once the pointer moves back into
// the map). Wired once; a no-op in every other layout.
let _zenWired=false;
function wireZen(){
  if(_zenWired) return; _zenWired=true;
  const st=$('#stage'); if(!st) return;
  st.addEventListener('mousemove',e=>{
    if(!document.body.classList.contains('ui-zen')) return;
    const r=st.getBoundingClientRect();
    document.body.classList.toggle('zen-chrome', (e.clientY - r.top) < 90);
  });
}
wireZen();
function toggleDockSide(){ document.body.classList.toggle('side-open'); }
// Dock/Minimal/Zen layouts: clicking anywhere outside the slide-over (or its
// tabs/toggle) closes it again. Guarded so no other layout is affected.
document.addEventListener('click',e=>{
  if(document.body.classList.contains('side-open')
     && (document.body.classList.contains('ui-dock') || document.body.classList.contains('ui-minimal') || document.body.classList.contains('ui-zen'))
     && !e.target.closest('.side, #toggleSide, .side-tabs')) document.body.classList.remove('side-open');
});
function buildUiLayoutThumb(id){
  if(id==='classic') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="8"  width="11" height="26" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="4"  width="50" height="9"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="22" y="26" width="11" height="6"  rx="1" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="42" y="26" width="11" height="6"  rx="1" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='rail') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="11" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="16" y="2"  width="6"  height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="25" y="2"  width="40" height="30" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="28" y="24" width="8"  height="4"  rx="1" fill="var(--chrome,#eee)"/>
    <rect x="40" y="24" width="8"  height="4"  rx="1" fill="var(--chrome,#eee)"/>
  </svg></span>`;
  if(id==='zen') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="66" height="36" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="14" y="2"  width="42" height="8"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="52" y="26" width="10" height="7"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="8"  y="26" width="10" height="7"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='outline') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="11" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="2"  width="19" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="40" y="2"  width="28" height="36" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="21" y="7"  width="11" height="2" rx="1" fill="var(--accent,#888)"/>
    <rect x="21" y="12" width="8"  height="2" rx="1" fill="var(--ink-soft,#bbb)"/>
    <rect x="25" y="17" width="8"  height="2" rx="1" fill="var(--ink-soft,#bbb)"/>
    <rect x="25" y="22" width="8"  height="2" rx="1" fill="var(--ink-soft,#bbb)"/>
  </svg></span>`;
  if(id==='minimal') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="66" height="8"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="2"  y="13" width="66" height="21" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="2"  y="36" width="66" height="2"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='mirror') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="11" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="4"  width="50" height="9"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="58" y="6"  width="6"  height="5"  rx="1" fill="var(--accent,#888)"/>
    <rect x="22" y="26" width="11" height="6"  rx="1" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="57" y="26" width="11" height="6"  rx="1" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='dock') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="66" height="8"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="2"  y="13" width="66" height="20" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="8"  y="18" width="10" height="10" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="2"  y="36" width="66" height="2"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="6"  y="36.5" width="8"  height="1" rx="0.5" fill="var(--accent,#888)"/>
    <rect x="17" y="36.5" width="16" height="1" rx="0.5" fill="var(--accent,#888)"/>
  </svg></span>`;
  if(id==='split') return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="11" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="2"  width="50" height="6"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="11" width="24" height="27" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="45" y="11" width="22" height="27" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="19" y="15" width="10" height="2"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
  </svg></span>`;
  return `<span class="style-thumb"><svg viewBox="0 0 70 40" width="70" height="40">
    <rect x="2"  y="2"  width="11" height="36" rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="2"  width="51" height="8"  rx="2" fill="var(--chrome,#eee)" stroke="var(--line)"/>
    <rect x="17" y="13" width="51" height="21" rx="2" fill="var(--paper-2,#ddd)" stroke="var(--line)"/>
    <rect x="17" y="36" width="51" height="2"  rx="1" fill="var(--chrome,#eee)" stroke="var(--line)"/>
  </svg></span>`;
}
function applyMapStyle(id){
  if(!map) return;
  map.style = id;
  pushHistory(); render();
}
function applyMapLayout(id){
  if(!map) return;
  // A preset id resolves to an engine plus options; both are written onto the
  // map so it stays portable for anyone who does not have this preset.
  const preset = findLayout(id);
  if(preset){
    map.layout = preset.engine;
    // Only a preset that actually carries options may replace the map's
    // settings. This used to `delete map.layoutConfig` otherwise, so simply
    // clicking the current layout again threw away everything the user had
    // set in the gear dialog.
    if(preset.options) map.layoutConfig = preset.options;
    // Structural params travel with the map, so a preset the recipient does
    // not have still renders the way its author intended.
    if(preset.params && Object.keys(preset.params).length) map.layoutParams = preset.params;
    else delete map.layoutParams;
    if(preset.strategy && !preset.engine) map.layout = preset.strategy;
    if(preset.id !== preset.engine) map.layoutPreset = preset.id; else delete map.layoutPreset;
  } else {
    map.layout = id;
    delete map.layoutPreset;
  }
  // Explicitly choosing a layout must re-assign the root children's sides so the
  // change actually takes effect (autoLayout's stable balanced mode otherwise
  // preserves a prior 'right' layout's sides and the map stays right-aligned).
  withChildIndex(()=>{
    if(id==='balanced') balanceRootSides();
    else if(id==='right') childrenOf(map.rootId).forEach(k=>{ map.nodes[k].side='right'; });
    else if(id==='left') childrenOf(map.rootId).forEach(k=>{ map.nodes[k].side='left'; });
  });
  pushHistory(); autoLayout(); fit();
}

let themePanel=null;
function closeThemePanel(){ if(themePanel){ themePanel.remove(); themePanel=null; } }
function buildSwatchHTML(t){
  return `<span class="theme-thumb" style="background:${t.swatch[0]}">
            <span class="t1" style="background:${t.swatch[1]}"></span>
            <span class="t2" style="background:${t.swatch[2]}"></span>
          </span>`;
}
function buildLookThumb(l){
  return `<span class="theme-thumb look-thumb" style="font-family:${l.font}">Aa</span>`;
}
function buildStyleThumb(id){
  // Small SVG preview showing two nodes + the branch style. Card sizes mirror
  // the 'balanced' layout thumbnail (root 14x12, children 14x10) so the two
  // panel rows read as the same kind of card.
  const ROOT={x:12,y:22,w:14,h:12}, CH1={x:56,y:6,w:14,h:10}, CH2={x:56,y:42,w:14,h:10};
  const rects=(rx)=>`<rect x="${ROOT.x}" y="${ROOT.y}" width="${ROOT.w}" height="${ROOT.h}" rx="${rx}" fill="var(--accent)"/>
      <rect x="${CH1.x}" y="${CH1.y}" width="${CH1.w}" height="${CH1.h}" rx="${rx}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
      <rect x="${CH2.x}" y="${CH2.y}" width="${CH2.w}" height="${CH2.h}" rx="${rx}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>`;
  if(id==='neon') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(6)}
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
  </span>`;
  if(id==='dashed') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(6)}
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--ink-soft)" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 3"/>
    </svg>
  </span>`;
  if(id==='minimal') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(3)}
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--ink-soft)" stroke-width="1.1" stroke-linecap="round"/>
    </svg>
  </span>`;
  if(id==='zigzag') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(1)}
      <path d="M26,28 L36,22 L44,34 L56,11 M26,28 L36,34 L44,22 L56,47" fill="none" stroke="var(--ink-soft)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>`;
  if(id==='circuit') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(2)}
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="3 3"/>
      <circle cx="26" cy="28" r="1.8" fill="var(--accent)"/><circle cx="47" cy="11" r="1.2" fill="var(--accent)"/><circle cx="47" cy="47" r="1.2" fill="var(--accent)"/>
    </svg>
  </span>`;
  if(id==='blueprint') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <rect x="${ROOT.x}" y="${ROOT.y}" width="${ROOT.w}" height="${ROOT.h}" rx="3" fill="var(--accent)"/>
      <rect x="${CH1.x}" y="${CH1.y}" width="${CH1.w}" height="${CH1.h}" rx="3" fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-dasharray="6 4"/>
      <rect x="${CH2.x}" y="${CH2.y}" width="${CH2.w}" height="${CH2.h}" rx="3" fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-dasharray="6 4"/>
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--ink-soft)" stroke-width="1.2" stroke-linecap="round" stroke-dasharray="6 4"/>
    </svg>
  </span>`;
  if(id==='clay') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <defs><filter id="clayF"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="var(--ink)" flood-opacity="0.14"/><feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="var(--ink)" flood-opacity="0.1"/></filter></defs>
      ${rects(6)}
      <rect x="${CH1.x}" y="${CH1.y}" width="${CH1.w}" height="${CH1.h}" rx="6" fill="var(--node-bg,#fff)" stroke="color-mix(in srgb, var(--line) 40%, transparent)" stroke-width="1" filter="url(#clayF)"/>
      <rect x="${CH2.x}" y="${CH2.y}" width="${CH2.w}" height="${CH2.h}" rx="6" fill="var(--node-bg,#fff)" stroke="color-mix(in srgb, var(--line) 40%, transparent)" stroke-width="1" filter="url(#clayF)"/>
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--line)" stroke-width="1.6" stroke-linecap="round"/>
    </svg>
  </span>`;
  if(id==='ink') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <rect x="${ROOT.x}" y="${ROOT.y}" width="${ROOT.w}" height="${ROOT.h}" rx="4" fill="var(--accent)"/>
      <rect x="${CH1.x}" y="${CH1.y}" width="${CH1.w}" height="${CH1.h}" rx="4" fill="var(--node-bg,#fff)" stroke="var(--ink)" stroke-width="2.2"/>
      <rect x="${CH2.x}" y="${CH2.y}" width="${CH2.w}" height="${CH2.h}" rx="4" fill="var(--node-bg,#fff)" stroke="var(--ink)" stroke-width="2.2"/>
      <rect x="${CH1.x+1}" y="${CH1.y+1}" width="${CH1.w}" height="${CH1.h}" rx="4" fill="none" stroke="var(--ink)" stroke-width="0.7" opacity="0.18"/>
      <rect x="${CH2.x+1}" y="${CH2.y+1}" width="${CH2.w}" height="${CH2.h}" rx="4" fill="none" stroke="var(--ink)" stroke-width="0.7" opacity="0.18"/>
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="square"/>
    </svg>
  </span>`;
  if(id==='paper') return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <rect x="${ROOT.x}" y="${ROOT.y}" width="${ROOT.w}" height="${ROOT.h}" rx="3" fill="var(--accent)"/>
      <rect x="${CH1.x}" y="${CH1.y}" width="${CH1.w}" height="${CH1.h}" rx="3" fill="var(--node-bg,#fff)" stroke="var(--line)" stroke-width="1"/>
      <line x1="${CH1.x+2}" y1="${CH1.y+4}" x2="${CH1.x+12}" y2="${CH1.y+4}" stroke="var(--line)" stroke-width="0.7" opacity="0.5"/>
      <line x1="${CH1.x+2}" y1="${CH1.y+7}" x2="${CH1.x+12}" y2="${CH1.y+7}" stroke="var(--line)" stroke-width="0.7" opacity="0.5"/>
      <rect x="${CH2.x}" y="${CH2.y}" width="${CH2.w}" height="${CH2.h}" rx="3" fill="var(--node-bg,#fff)" stroke="var(--line)" stroke-width="1"/>
      <line x1="${CH2.x+2}" y1="${CH2.y+4}" x2="${CH2.x+12}" y2="${CH2.y+4}" stroke="var(--line)" stroke-width="0.7" opacity="0.5"/>
      <line x1="${CH2.x+2}" y1="${CH2.y+7}" x2="${CH2.x+12}" y2="${CH2.y+7}" stroke="var(--line)" stroke-width="0.7" opacity="0.5"/>
      <path d="M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M${CH1.x+CH1.w-3},${CH1.y} L${CH1.x+CH1.w},${CH1.y} L${CH1.x+CH1.w},${CH1.y+3} Z" fill="var(--line)" opacity="0.35"/>
      <path d="M${CH2.x+CH2.w-3},${CH2.y} L${CH2.x+CH2.w},${CH2.y} L${CH2.x+CH2.w},${CH2.y+3} Z" fill="var(--line)" opacity="0.35"/>
    </svg>
  </span>`;
  let path;
  if(id==='classic') path='M26,28 L40,28 L40,11 L56,11 M26,28 L40,28 L40,47 L56,47';
  else if(id==='sketch') path='M26,28 L56,11 M26,28 L56,47';
  else path='M26,28 C38,28 47,11 56,11 M26,28 C38,28 47,47 56,47';
  const radius = id==='bubble'? 6 : id==='classic'? 2 : id==='sketch'? 2 : 3;
  const stroke = id==='bubble'? 2.2 : 1.4;
  return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      ${rects(radius)}
      <path d="${path}" fill="none" stroke="var(--ink-soft)" stroke-width="${stroke}"/>
    </svg>
  </span>`;
}
function buildLayoutThumb(id){
  // Card sizes follow one standard so every thumbnail row (map style, layout,
  // I am) reads the same kind of card: root 14x12, children 14x10 - matching
  // the 'balanced' layout and the map style thumbs. Compositions differ, not
  // the cards themselves.
  let svg;
  if(id==='radial') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <path d="M35,30 L35,12 M35,30 L52,40 M35,30 L18,40" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <circle cx="35" cy="30" r="7" fill="var(--accent)"/>
    <circle cx="35" cy="10" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <circle cx="54" cy="42" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <circle cx="16" cy="42" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='grid') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="4"  width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="6"  y="20" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="20" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="40" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="40" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='timeline') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <path d="M11,30 L62,30" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <path d="M26,30 L26,16 L34,16 M46,30 L46,44 L54,44" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <rect x="4"  y="24" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="20" y="25" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="40" y="25" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="34" y="11" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="54" y="39" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='down') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="6"  width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="8"  y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="28" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M35,18 L35,26 L15,26 L15,36 M35,26 L35,36 M35,26 L55,26 L55,36" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='up') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="42" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="8"  y="14" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="28" y="14" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="14" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M35,42 L35,34 L15,34 L15,24 M35,34 L35,24 M35,34 L55,34 L55,24" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='stair') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="4"  width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="38" y="20" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="32" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="44" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M35,16 L35,50" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <path d="M35,22 L38,22 M35,34 L38,34 M35,46 L38,46" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='left') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="50" y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="6"  y="6"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="22" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M50,28 C38,28 30,11 20,11 M50,28 L20,27 M50,28 C38,28 30,43 20,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='right') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="6"  y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="48" y="6"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="22" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M20,28 C32,28 40,11 48,11 M20,28 L48,27 M20,28 C32,28 40,43 48,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="2"  y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="2"  y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M28,28 C22,28 22,13 16,13 M28,28 C22,28 22,43 16,43 M42,28 C48,28 48,13 52,13 M42,28 C48,28 48,43 52,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  return `<span class="style-thumb">${svg}</span>`;
}

$('#varsBtn')?.addEventListener('click', showMapVariables);
$('#themeBtn').onclick=(e)=>{
  e.stopPropagation();
  if(themePanel){ closeThemePanel(); return; }
  closeAllMenus();
  const curTheme  = document.documentElement.getAttribute('data-theme') || 'light';
  const customTheme = loadCustomTheme();
  // Colour-theme tiles: 2-row horizontally scrollable grid, like Layout/Map
  // style. 20 curated built-ins are shown (no slicing beyond 20), plus the
  // Add theme tile always in the final slot - column-major fill so the
  // visible rows read left-to-right in theme order. The imported theme (if
  // any) sits before Add; an empty spacer holds that slot when there is none.
  // Rest of the 65 themes are reachable via Add theme → library grid.
  const VISIBLE_THEMES = 20;
  const ROWS=2, COLS=4;
  const themeTiles = [
    ...THEMES.slice(0, VISIBLE_THEMES).map(theme=>({theme})),
    ...(customTheme ? [{custom:true}] : [{spacer:true}]),
    {add:true},
  ];
  const themeTilesOrdered = [];
  for(let c=0; c*ROWS < themeTiles.length; c++){
    for(let r=0; r<ROWS; r++){
      // Columns past the first COLS hold any overflow beyond the visible
      // 8 slots, continuing the same row-major sequence instead of
      // wrapping to a 3rd row.
      const o = c < COLS ? r*COLS + c : ROWS*COLS + (c-COLS)*ROWS + r;
      if(o < themeTiles.length) themeTilesOrdered.push(themeTiles[o]);
    }
  }
  const curLook   = document.documentElement.getAttribute('data-look')  || 'office';
  const curStyle  = (map && map.style)  || 'modern';
  const curLayout = (map && (map.layoutPreset || map.layout)) || 'balanced';
  const curUi     = document.body.classList.contains('ui-zen') ? 'zen'
                  : (document.body.classList.contains('ui-dock') ? 'dock'
                  : (document.body.classList.contains('ui-split') ? 'split'
                  : (document.body.classList.contains('ui-rail') ? 'rail'
                  : (document.body.classList.contains('ui-mirror') ? 'mirror'
                  : (document.body.classList.contains('ui-classic') ? 'classic'
                  : (document.body.classList.contains('ui-outline') ? 'outline'
                  : (document.body.classList.contains('ui-minimal') ? 'minimal' : 'modern')))))));
  // The colour-theme picker shows 20 curated built-ins in a 2-row
  // horizontally scrollable grid (like Layout), with the Add theme tile
  // at the end; remaining 45 themes via Add theme → library grid.
  themePanel=document.createElement('div');
  themePanel.className='theme-panel theme-panel-large';
  themePanel.innerHTML = `
    <div class="tp-section">
      <div class="tp-label">Colour theme
        <button class="tp-cog" data-cog="theme" title="Colour theme settings (JSON)">\u2699</button>
      </div>
      <div class="tp-grid tp-scroll-row tp-scroll-2rows">
        ${themeTilesOrdered.map(tile=>
          tile.custom ? `
          <button class="theme-opt custom-theme-opt${curTheme==='custom'?' active':''}" data-cat="theme" data-id="custom" title="${escapeHtml(customTheme.name)}">
            ${buildSwatchHTML({id:'custom', name:customTheme.name, swatch:[customTheme.vars['--paper'], customTheme.vars['--chrome'], customTheme.vars['--accent']]})}<span class="theme-name">${escapeHtml(customTheme.name)}</span>
          </button>`
          : tile.add ? `
          <button class="theme-opt add-theme-opt" data-cat="addtheme"
            title="Add a theme from the themes/ folder">
            <span class="add-theme-icon">+</span><span class="theme-name">Add theme</span>
          </button>`
          : tile.spacer ? `<span aria-hidden="true"></span>`
          : `
          <button class="theme-opt${tile.theme.id===curTheme?' active':''}" data-cat="theme" data-id="${tile.theme.id}">
            ${buildSwatchHTML(tile.theme)}<span class="theme-name">${tile.theme.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section tp-section-special">
      <div class="tp-label">I am
        <button class="tp-cog" data-cog="look" title="Look settings (JSON)">\u2699</button>
      </div>
      <div class="tp-grid tp-scroll-row">
        ${LOOKS.map(l=>`
          <button class="theme-opt${l.id===curLook?' active':''}" data-cat="look" data-id="${l.id}">
            ${buildLookThumb(l)}<span class="theme-name">${l.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Map style
        <button class="tp-cog" data-cog="style" title="Map style settings (JSON)">\u2699</button>
      </div>
      <div class="tp-grid tp-scroll-row">
        ${MAP_STYLES.map(s=>`
          <button class="theme-opt${s.id===curStyle?' active':''}" data-cat="style" data-id="${s.id}" title="${s.desc}">
            ${buildStyleThumb(s.id)}<span class="theme-name">${s.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Map layout
        <button class="tp-cog" data-cog="layout" title="Map layout settings (JSON)">\u2699</button>
      </div>
      <div class="tp-grid tp-scroll-row">
        ${allLayouts().map(l=>`
          <button class="theme-opt${l.id===curLayout?' active':''}" data-cat="layout" data-id="${l.id}" title="${l.desc}">
            ${buildLayoutThumb(l.id)}<span class="theme-name">${l.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">App layout <span class="tp-hint">shell of bars, sidebar & status bar</span></div>
      <div class="tp-grid tp-scroll-row">
        ${UI_LAYOUTS.map(l=>`
          <button class="theme-opt${l.id===curUi?' active':''}" data-cat="ui" data-id="${l.id}">
            ${buildUiLayoutThumb(l.id)}<span class="theme-name">${l.name}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Display size <span class="tp-hint">scales the whole interface</span></div>
      <div class="tp-scale">
        <button class="scale-opt${isUiScaleAuto()?' active':''}" data-scale="auto">Auto</button>
        ${[80,90,100,110,125].map(p=>`
          <button class="scale-opt${(!isUiScaleAuto() && p===Math.round(getUiScale()*100))?' active':''}" data-scale="${p}">${p}%</button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(themePanel);
  // Side-toolbar layout: same flyout treatment as the export menu - keep the
  // large theme panel clear of the rail and aligned to the triggering icon.
  const _isRailTheme = document.body.classList.contains('ui-rail') && !window.matchMedia('(max-width: 720px)').matches;
  positionPopup(themePanel, $('#themeBtn'), _isRailTheme ? {side:'right'} : {align:'right'});
  themePanel.addEventListener('mousedown',ev=>ev.stopPropagation());

  // A horizontally scrolling row keeps the panel from growing a whole extra
  // line for one more layout, but scrolling sideways is easy to miss: most
  // mice have no horizontal wheel, so without help an option parked off-screen
  // is effectively invisible. Three affordances make it discoverable:
  //   - edge fades, shown only on the side that actually has more to reveal
  //   - a normal (vertical) wheel scrolls the row while the pointer is over it
  //   - the active option is scrolled into view when the panel opens
  // The cog is not a .theme-opt, so it is wired separately rather than going
  // through the category dispatch below.
  const cogs = themePanel.querySelectorAll('.tp-cog');
  if(cogs.length) cogs.forEach(cog=> cog.onclick = ev => {
    ev.stopPropagation(); closeThemePanel();
    if(cog.dataset.cog === 'style') showStyleConfigForm();
    else if(cog.dataset.cog === 'layout') showLayoutConfigForm();
    else if(cog.dataset.cog === 'look') showLookConfigForm();
    else showThemeConfigForm();
  });

  themePanel.querySelectorAll('.tp-scroll-row').forEach(row=>{
    const sync=()=>{
      const max = row.scrollWidth - row.clientWidth;
      row.classList.toggle('has-more-right', max > 1 && row.scrollLeft < max - 1);
      row.classList.toggle('has-more-left',  max > 1 && row.scrollLeft > 1);
    };
    row.addEventListener('scroll', sync, {passive:true});
    row.addEventListener('wheel', ev=>{
      // Only hijack a purely vertical wheel; a trackpad's horizontal gesture
      // already works and must not be doubled.
      if(Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
      const max = row.scrollWidth - row.clientWidth;
      if(max <= 1) return;
      // Hand the wheel back to the panel once this row can go no further,
      // otherwise the pointer resting here would trap vertical scrolling.
      if((ev.deltaY < 0 && row.scrollLeft <= 0) || (ev.deltaY > 0 && row.scrollLeft >= max - 1)) return;
      ev.preventDefault();
      const card=row.querySelector('.theme-opt');
      const step=((card?card.offsetWidth:160)+4)*4;
      row.scrollBy({left: Math.sign(ev.deltaY)*step, behavior:'smooth'});
    }, {passive:false});
    // Reveal the current selection rather than always starting at the left.
    const act = row.querySelector('.theme-opt.active');
    if(act) act.scrollIntoView({block:'nearest', inline:'nearest'});
    requestAnimationFrame(sync);
  });
  themePanel.querySelectorAll('.theme-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      const cat=opt.dataset.cat, id=opt.dataset.id;
      if(cat==='theme') applyTheme(id);
      else if(cat==='addtheme'){ closeThemePanel(); showThemeImportForm(); }
      else if(cat==='look') applyLook(id);
      else if(cat==='style') applyMapStyle(id);
      else if(cat==='layout') applyMapLayout(id);
      else if(cat==='ui'){
        applyUiLayout(id);
        const repositionUi=()=>{
          if(!themePanel || !document.body.contains(themePanel)) return;
          _rzCache=null;
          const _isRailNow = document.body.classList.contains('ui-rail') && !window.matchMedia('(max-width: 720px)').matches;
          positionPopup(themePanel, $('#themeBtn'), _isRailNow ? {side:'right'} : {align:'right'});
        };
        repositionUi();
        requestAnimationFrame(()=>requestAnimationFrame(repositionUi));
      }
      // Clear active state across every section sharing this category, not
      // just the clicked button's own section (opt.closest('.tp-section')).
      // Each category lives in exactly one section again now that 'look' is
      // its own category rather than sharing 'theme' - but scoping by
      // data-cat across the whole panel is the more general, robust
      // approach regardless of how many sections a category happens to span.
      themePanel.querySelectorAll(`.theme-opt[data-cat="${cat}"]`).forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
    };
  });
  themePanel.querySelectorAll('.scale-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      if(opt.dataset.scale==='auto') setUiScaleAuto();
      else setUiScale(parseInt(opt.dataset.scale,10)/100);
      themePanel.querySelectorAll('.scale-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
      // The zoom just changed, so the panel's already-computed fixed position (from
      // before the change) no longer lines up with the theme button - reposition
      // against its current (post-zoom) geometry rather than leaving it stranded.
      // Also re-run it a couple of frames later, invalidating the zoom-probe cache
      // again first: a getBoundingClientRect() read right after the style change is
      // *supposed* to force a synchronous, up-to-date reflow, but some zoom values
      // have shown a stale first read in practice, so this is a deliberate belt-and-
      // suspenders re-measurement rather than trusting that alone.
      const reposition=()=>{
        if(!document.body.contains(themePanel)) return;
        _rzCache=null;
        positionPopup(themePanel, $('#themeBtn'), {align:'right'});
      };
      reposition();
      requestAnimationFrame(()=>requestAnimationFrame(reposition));
    };
  });
};
document.addEventListener('click',e=>{
  if(themePanel && !themePanel.contains(e.target) && e.target.id!=='themeBtn') closeThemePanel();
});
// Apply saved theme at boot. For first-time visitors, follow the OS preference
// (prefers-color-scheme) so dark-mode users get dark by default.
try{
  let saved = localStorage.getItem('mindspark:theme');
  const RETIRED_THEMES = {'solarized-dark':'github-dark', 'solarized-light':'github-light', 'monokai':'catppuccin-dark', 'catppuccin':'catppuccin-dark'};   // replaced themes
  if(saved==='handwritten'){
    // Pre-refactor save: 'handwritten' used to be a data-theme value. Migrate
    // intent rather than silently dropping it - falls back to a real color
    // theme, and separately turns on the new Back to School look. Only sets
    // the localStorage key here, doesn't call applyLook() directly - that
    // happens once, below, as the single source of truth for applying the
    // look at boot (calling it here too would double-apply it: two renders,
    // two duplicate font-load requests, since applyLook() sets this same
    // key as a side effect and the line below reads it right back).
    saved=null;
    try{ localStorage.setItem('mindspark:look', 'handwritten'); }catch(e){}
  }
  if(saved && RETIRED_THEMES[saved]){ saved=RETIRED_THEMES[saved]; try{ localStorage.setItem('mindspark:theme', saved); }catch(e){} }
  if(saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}catch(e){}
try{ applyLook(localStorage.getItem('mindspark:look') || 'office'); }catch(e){}
try{ if(localStorage.getItem('mindspark:zenPinned')==='1') document.body.classList.add('zen-pinned'); }catch(e){}
try{ applyUiLayout(localStorage.getItem('mindspark:uiLayout') || 'modern'); }catch(e){}   // app shell layout (Modern bars / Classic floating)

applyView();

/* ============================================================
   DONATE - quick-amount picker. Edit DONATE_CONFIG below to
   point at your own payment links. Set any line to null/'' to
   hide that provider in the modal.
   ============================================================ */
const DONATE_CONFIG = {
  // Buy Me a Coffee - works globally. Replace USERNAME with yours.
  bmac:    'https://www.buymeacoffee.com/YOUR_USERNAME',
  // Ko-fi - works globally.
  kofi:    'https://ko-fi.com/YOUR_USERNAME',
  // PayPal.me - supports embedding the amount in the URL: paypal.me/YOU/5
  paypal:  'https://www.paypal.com/paypalme/YOUR_USERNAME',
  // UPI (India) - direct deep-link. Replace with your VPA.
  // Example: 'upi://pay?pa=yourname@okicici&pn=MindSpark&cu=INR'
  upi:     'upi://pay?pa=prasadpatil252@okaxis&pn=MindSpark&cu=INR',
  // UPI QR code - works on any device. Put the image as a data URL
  //   (paste a `data:image/png;base64,...` here)
  // or as an external URL (e.g., '/upi-qr.png' if you place the file in /public).
  upiQr:   '/upi-qr.png',
  upiNote: 'prasadpatil252@okaxis',  // optional caption shown below the QR, e.g. "yourname@okicici"
  // GitHub Sponsors
  github:  null
};
const DONATE_AMOUNTS = [3, 5, 10, 25];

function showDonateModal(){
  document.querySelectorAll('.donate-modal').forEach(m=>m.remove());
  const m=document.createElement('div');
  m.className='donate-modal';
  const has = k => DONATE_CONFIG[k] && !String(DONATE_CONFIG[k]).includes('YOUR_USERNAME');
  const providers = [
    has('bmac')   && {k:'bmac',   label:'Buy Me a Coffee', icon:'☕', url:DONATE_CONFIG.bmac,   color:'#ffdd00', supportsAmount:false},
    has('kofi')   && {k:'kofi',   label:'Ko-fi',           icon:'♥', url:DONATE_CONFIG.kofi,   color:'#ff5e5b', supportsAmount:false},
    has('paypal') && {k:'paypal', label:'PayPal',          icon:'P', url:DONATE_CONFIG.paypal, color:'#0070ba', supportsAmount:true},
    has('upi')    && {k:'upi',    label:'UPI app (India)', icon:'₹', url:DONATE_CONFIG.upi,    color:'#5f259f', supportsAmount:true},
    has('upiQr')  && {k:'upiQr',  label:'Scan UPI QR',     icon:'⚌', url:null,                  color:'#5f259f', supportsAmount:false},
    has('github') && {k:'github', label:'GitHub Sponsors', icon:'♥', url:DONATE_CONFIG.github, color:'#bf3989', supportsAmount:false}
  ].filter(Boolean);
  const configured = providers.length>0;
  m.innerHTML = `
    <div class="donate-backdrop"></div>
    <div class="donate-card">
      <button class="donate-close" aria-label="Close">×</button>
      <div class="donate-head">
        <div class="donate-icon">♥</div>
        <h2>Support MindSpark</h2>
        <p>MindSpark is free and open source. If it's useful to you, a small contribution helps keep it that way.</p>
      </div>
      ${configured ? `
        <div class="donate-amounts">
          <div class="donate-label">Pick an amount</div>
          <div class="donate-amount-row">
            ${DONATE_AMOUNTS.map(a=>`<button class="donate-amt" data-amt="${a}">$${a}</button>`).join('')}
            <div class="donate-custom">
              <span>$</span><input type="number" id="donateCustomAmt" min="1" placeholder="other" />
            </div>
          </div>
        </div>
        <div class="donate-providers">
          <div class="donate-label">Donate via</div>
          ${providers.map(p=>`
            <button class="donate-provider" data-k="${p.k}" style="--p-color:${p.color}">
              <span class="dp-icon">${p.icon}</span>
              <span class="dp-label">${p.label}</span>
              <span class="dp-arrow">→</span>
            </button>`).join('')}
        </div>
      ` : `
        <div class="donate-empty">
          <p><b>Donations aren't configured yet.</b></p>
          <p class="small">If you're the host of this MindSpark instance, open <code>public/app.js</code>, scroll to <code>DONATE_CONFIG</code>, and add your Buy Me a Coffee / Ko-fi / PayPal / UPI links. The button will go live the next time you redeploy.</p>
        </div>
      `}
      <div class="donate-foot">
        <a href="#" id="shareLink">↗ Share MindSpark</a>
      </div>
    </div>`;
  document.body.appendChild(m);

  let chosenAmount = null;
  const amtBtns = m.querySelectorAll('.donate-amt');
  const customInput = m.querySelector('#donateCustomAmt');
  amtBtns.forEach(b=>b.addEventListener('click',()=>{
    chosenAmount = +b.dataset.amt;
    amtBtns.forEach(x=>x.classList.toggle('on', x===b));
    if(customInput) customInput.value='';
  }));
  if(customInput) customInput.addEventListener('input',()=>{
    const v=parseFloat(customInput.value);
    if(v>0){ chosenAmount=v; amtBtns.forEach(b=>b.classList.remove('on')); }
  });
  m.querySelectorAll('.donate-provider').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const p = providers.find(x=>x.k===btn.dataset.k);
      if(p.k === 'upiQr'){ showUpiQrView(m); return; }
      let url = p.url;
      if(p.supportsAmount && chosenAmount){
        if(p.k==='paypal') url = url.replace(/\/?$/, '/'+chosenAmount);
        else if(p.k==='upi') url = url + (url.includes('?')?'&':'?') + 'am='+chosenAmount;
      }
      window.open(url, '_blank', 'noopener');
    });
  });
  const close = () => m.remove();
  m.querySelector('.donate-close').onclick = close;
  m.querySelector('.donate-backdrop').onclick = close;
  m.querySelector('#shareLink')?.addEventListener('click',e=>{
    e.preventDefault();
    const url = location.origin + location.pathname;
    if(navigator.share) navigator.share({title:'MindSpark', text:'A free, open mind-mapping app', url}).catch(()=>{});
    else { navigator.clipboard?.writeText(url); toast('Link copied'); }
  });
  document.addEventListener('keydown', function esc(e){
    if(e.key==='Escape'){ close(); document.removeEventListener('keydown', esc); }
  });
}
$('#donateBtn')?.addEventListener('click', showDonateModal);

// ===== Focus mode - hide all chrome, show only the canvas =====
function toggleFocusMode(){
  const on = !document.body.classList.contains('focus-mode');
  document.body.classList.toggle('focus-mode', on);
  let exit = $('#focusExit');
  if(on){
    if(!exit){
      exit = document.createElement('button');
      exit.id = 'focusExit'; exit.className = 'focus-exit';
      exit.innerHTML = '⛶ Exit focus';
      exit.title = 'Exit focus mode (Esc)';
      exit.onclick = toggleFocusMode;
      document.body.appendChild(exit);
    }
    toast('Focus mode - Esc to exit');
  } else {
    exit?.remove();
  }
  // The viewport size changes when chrome is shown/hidden - wait for the layout
  // to settle, then smoothly animate the map back to centred (keeping zoom) so it
  // doesn't just jump sideways.
  requestAnimationFrame(()=>requestAnimationFrame(()=>animateViewTo(computeRecenterView(), 220)));
}
$('#focusBtn')?.addEventListener('click', toggleFocusMode);

// ===== Presentation - canvas-only walkthrough of the map =====
// Walks the map breadth-first (root, its children, then each level below) and
// steps the viewport from node to node. Chrome is hidden by body.ui-deck; the
// current node gets an accent ring, the rest of the map dims. ←/→ move, Esc
// leaves; clicking the canvas also advances. Works from every app layout.
let _deck=null;   // { list:[nodeIds], idx }
function deckBuildList(){
  const list=[], hidden=hiddenSet();
  const walk=(ids)=>{
    const next=[];
    for(const id of ids){
      if(hidden.has(id)) continue;
      list.push(id);
      next.push(...childrenOf(id));
    }
    if(next.length) walk(next);
  };
  if(map) walk([map.rootId]);
  return list;
}
function enterDeck(){
  if(!map || _deck) return;
  const list=deckBuildList();
  if(!list.length) return;
  _deck={list, idx:0};
  document.body.classList.add('ui-deck');
  const bar=document.createElement('div');
  bar.id='deckBar';
  bar.innerHTML=`<span class="deck-title"></span>
    <span class="deck-pos"></span>
    <span class="deck-nav">
      <button type="button" id="deckPrev" title="Previous (←)">◀</button>
      <button type="button" id="deckNext" title="Next (→)">▶</button>
      <button type="button" id="deckExit" title="Exit (Esc)">✕</button>
    </span>`;
  bar.querySelector('#deckPrev').onclick=()=>deckStep(-1);
  bar.querySelector('#deckNext').onclick=()=>deckStep(1);
  bar.querySelector('#deckExit').onclick=exitDeck;
  document.body.appendChild(bar);
  deckGo(0);
  toast('Presentation - ← → to move, Esc to exit');
}
function exitDeck(){
  if(!_deck) return;
  _deck=null;
  // Capture the map point sitting under the stage centre BEFORE the chrome
  // comes back. body.ui-deck hides the bars with display:none, so leaving the
  // deck hands back a stage that is narrower by the sidebar and shorter by the
  // top and status bars; with no compensation the node being presented jumped
  // out of the centre by exactly half of that (121px at 1080p in the modern
  // shell). The bars have no width transition, so the new size is readable at
  // once - same reframe the sidebar toggle uses.
  const {w:SW,h:SH}=_stageSize();
  const cx=(SW/2-view.x)/view.k, cy=(SH/2-view.y)/view.k;
  document.body.classList.remove('ui-deck');
  document.getElementById('deckBar')?.remove();
  document.querySelectorAll('.node.deck-current').forEach(n=>n.classList.remove('deck-current'));
  if(map && isFinite(cx) && isFinite(cy)){
    const {w:W1,h:H1}=_stageSize();
    if(W1>1 && H1>1) _reframeSmooth(cx, cy, W1, H1);
  }
}
function deckStep(d){ if(_deck) deckGo(_deck.idx + d); }
function deckGo(i){
  if(!_deck) return;
  const n=_deck.list.length;
  i=((i%n)+n)%n;
  _deck.idx=i;
  const id=_deck.list[i], node=map.nodes[id];
  if(!node) return;
  document.querySelectorAll('.node.deck-current').forEach(x=>x.classList.remove('deck-current'));
  document.querySelector(`.node[data-id="${id}"]`)?.classList.add('deck-current');
  const {w:SW,h:SH}=_stageSize();
  animateViewTo({x: SW/2-(node.x+(node.w||120)/2)*view.k,
                 y: SH/2-(node.y+(node.h||40)/2)*view.k,
                 k: view.k}, 260);
  const bar=document.getElementById('deckBar');
  if(bar){
    bar.querySelector('.deck-title').textContent=nodeTextPlain(node.text||'')||'(untitled)';
    bar.querySelector('.deck-pos').textContent=(i+1)+' / '+n;
  }
}
$('#presentBtn')?.addEventListener('click', enterDeck);
// Deck keys are captured (phase 1) so the map's own arrow/Esc handlers don't
// also fire while presenting.
document.addEventListener('keydown',e=>{
  if(!document.body.classList.contains('ui-deck')) return;
  if(e.key==='ArrowRight'){ e.preventDefault(); e.stopPropagation(); deckStep(1); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); e.stopPropagation(); deckStep(-1); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); exitDeck(); }
}, true);
// Clicking anywhere on the canvas advances to the next node.
$('#stage')?.addEventListener('click',e=>{
  if(!document.body.classList.contains('ui-deck')) return;
  if(e.target.closest('#deckBar')) return;
  deckStep(1);
});

// ===== Keyboard shortcuts help - press '?' to open =====
function showKeyboardHelp(){
  document.querySelectorAll('.kb-help').forEach(m=>m.remove());
  const m = document.createElement('div');
  m.className = 'kb-help';
  const shortcuts = [
    ['Building the map',[
      ['Tab',            'Add a child node'],
      ['Enter',          'Add a sibling node'],
      ['F2 / double-click', 'Edit the selected node'],
      ['Delete',         'Remove the selected node'],
      ['Space',          'Collapse / expand'],
      ['L',              'Cross-link to another node'],
      ['drag',           'Move node (subtree follows)'],
      ['drag onto node', 'Re-parent under that node'],
    ]],
    ['Navigation',[
      ['↑ ↓ ← →',        'Move selection between nodes'],
      ['scroll',         'Zoom canvas (mouse) / two-finger pinch (touch)'],
      ['drag canvas',    'Pan the map'],
    ]],
    ['Editing text',[
      ['Ctrl/⌘ + B / I / U', 'Bold / italic / underline the selection'],
      ['select + UL/OL btn', 'Make each selected line a bullet'],
      ['Shift + Enter',  'Newline within the node text'],
      ['Esc',            'Cancel an edit / close a popup'],
    ]],
    ['History',[
      ['Ctrl/⌘ + Z',     'Undo'],
      ['Ctrl/⌘ + Shift + Z',  'Redo'],
    ]]
  ];
  const renderTable = group => `
    <h3>${group[0]}</h3>
    <table>${group[1].map(r=>`<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</table>`;
  m.innerHTML = `
    <div class="kb-backdrop"></div>
    <div class="kb-card">
      <button class="kb-close" aria-label="Close">×</button>
      <h2>Keyboard shortcuts</h2>
      <div class="kb-grid">${shortcuts.map(renderTable).join('')}</div>
      <p class="kb-foot">Press <kbd>?</kbd> any time to open this list.</p>
    </div>`;
  document.body.appendChild(m);
  const close=()=>m.remove();
  m.querySelector('.kb-close').onclick = close;
  m.querySelector('.kb-backdrop').onclick = close;
  m.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
window.addEventListener('keydown', e=>{
  if(e.key !== '?') return;
  // Don't intercept when typing inside a text field / contentEditable
  if(e.target.isContentEditable) return;
  const tag = (e.target.tagName||'').toUpperCase();
  if(tag === 'INPUT' || tag === 'TEXTAREA') return;
  if(document.querySelector('.node.editing')) return;
  e.preventDefault();
  showKeyboardHelp();
});
// Esc exits focus mode (only when nothing else is open/focused)
window.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  if(!document.body.classList.contains('focus-mode')) return;
  // Don't fight with editing/notes/login overlay - they handle Esc themselves
  if(document.querySelector('.node.editing')) return;
  if(document.querySelector('.notes-popup')) return;
  if(document.querySelector('.donate-modal')) return;
  if($('#loginOverlay') && $('#loginOverlay').style.display==='flex') return;
  e.preventDefault();
  toggleFocusMode();
}, true);

// ===== GitHub source/issue link =====
// Set this to your repo and the sidebar footer links will go live.
const GITHUB_URL = 'https://github.com/prasadpatil25/mindspark';
(function wireGitHub(){
  const ghOk = GITHUB_URL && !GITHUB_URL.includes('YOUR_USERNAME');
  const repo = $('#ghRepoLink'), issue = $('#ghIssueLink');
  if(ghOk){
    if(repo) repo.href = GITHUB_URL;
    if(issue) issue.href = GITHUB_URL.replace(/\/$/, '') + '/issues/new?labels=bug';
  } else {
    // Until configured, point at the canonical readme so the buttons aren't dead.
    // Replace these in app.js (search for GITHUB_URL) to publish your own repo.
    [repo,issue].forEach(a=>{ if(a){ a.href='#'; a.addEventListener('click',e=>{
      e.preventDefault();
      toast('Set GITHUB_URL in app.js to your repo URL');
    }); }});
  }
})();

// GitHub stars badge - sidebar footer (cached, 6h TTL, offline-first)
(function loadGhStars(){
  const el=$('#ghStars'); if(!el) return;
  const repoPath=(GITHUB_URL||'').replace(/^https:\/\/github\.com\//,'').replace(/\/$/,'');
  if(!repoPath || repoPath.includes('YOUR_USERNAME')) return;
  const cacheKey='mindspark:gh-stars:'+repoPath;
  const fmt=n=> n>=1000 ? (n>=1000000 ? (n/1000000).toFixed(1).replace(/\.0$/,'')+'M' : (n/1000).toFixed(1).replace(/\.0$/,'')+'k') : String(n);
  const render=n=>{
    if(!isFinite(n)) return;
    el.textContent='★ '+fmt(n);
    el.hidden=false;
    el.title=n.toLocaleString()+' stars on GitHub';
  };
  try{
    const cached=JSON.parse(localStorage.getItem(cacheKey)||'null');
    if(cached && isFinite(cached.count) && Date.now()-cached.ts < 6*3600*1000){
      render(cached.count);
    }
  }catch(e){}
  fetch('https://api.github.com/repos/'+repoPath, {cache:'no-store'})
    .then(r=> r.ok ? r.json() : Promise.reject())
    .then(j=>{
      if(!j || !isFinite(j.stargazers_count)) return;
      render(j.stargazers_count);
      try{ localStorage.setItem(cacheKey, JSON.stringify({count:j.stargazers_count, ts:Date.now()})); }catch(e){}
    })
    .catch(()=>{});
})();

// Swap the donate modal's card into a "scan UPI QR" view.
function showUpiQrView(modal){
  const card = modal.querySelector('.donate-card');
  // Save the original innerHTML so we can restore it via the back button
  if(!card.dataset.originalHTML) card.dataset.originalHTML = card.innerHTML;
  card.innerHTML = `
    <button class="donate-close" aria-label="Close">×</button>
    <button class="donate-back" aria-label="Back">← Back</button>
    <div class="qr-view">
      <h2>Scan to pay via UPI</h2>
      <p class="qr-sub">Open any UPI app (Google Pay, PhonePe, Paytm, BHIM) and scan the code below.</p>
      <div class="qr-frame">
        <img class="qr-image" src="${DONATE_CONFIG.upiQr}" alt="UPI QR code"/>
      </div>
      ${DONATE_CONFIG.upiNote ? `<div class="qr-note">${escapeHtml(DONATE_CONFIG.upiNote)}</div>` : ''}
      ${DONATE_CONFIG.upi ? `<a class="qr-deeplink" href="${DONATE_CONFIG.upi}">Or tap to open in your UPI app →</a>` : ''}
      <p class="qr-foot">Thank you for supporting MindSpark 💛</p>
    </div>`;
  card.querySelector('.donate-close').onclick = () => modal.remove();
  card.querySelector('.donate-back').onclick  = () => {
    card.innerHTML = card.dataset.originalHTML;
    showDonateModal();  // re-wire - easier than rebuilding events
    modal.remove();
  };
}
// First-run sample: seed the bundled "ML - Overview (Demo)" map as the user's own
// editable copy, so a brand-new sidebar isn't empty. Fetched (not embedded) to
// keep app.js lean; on failure (offline/missing) the caller falls back to a blank map.
async function seedDemoMap(){
  let demo;
  try{
    const r = await fetch('demo-map.json', { cache:'no-store' });
    if(!r.ok) return false;
    demo = await r.json();
  }catch(e){ return false; }
  if(!demo || !demo.rootId || !demo.nodes) return false;
  demo.id = uid();                 // a fresh id → the user's own copy
  demo.updated = Date.now();
  map = demo; sel = null;
  history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value = map.title || 'ML - Overview (Demo)';
  autoLayout();
  const savedV=loadMapView(map.id);
  if(savedV) applyMapView(savedV); else fit();
  refreshList();
  try{ await Store.save(map); }catch(e){ console.warn('save after map load failed:', e.message); }
  return true;
}
async function proceedBoot(){
  await _proceedBoot();
  // Seed the tab strip with the boot map when tabbed workspace is on.
  if(tabsEnabled && map && _tabs.length===0){ _tabs=[{key:map.id, title:map.title||'Untitled', map}]; _tabActive=0; renderTabs(); }
}
async function _proceedBoot(){
  loadUserTemplates();   // merge any saved "My templates" into the catalog
  // A shared map queued for copying takes priority over loading the last map.
  if(await consumePendingImport()) return;
  try{ const _mid=new URLSearchParams(location.search).get('map'); if(_mid && await loadMap(_mid)) return; }catch(e){}
  let idx=[];
  try{ idx=await Store.list(); }catch(e){ console.warn('could not list maps; starting with an empty list:', e.message); }
  if(idx && idx.length){
    const ok=await loadMap(idx[0].id);
    if(!ok) createMap();
  } else {
    // Empty list. Before seeding a blank map, check for orphan map files that
    // exist in the repo but aren't in the index and weren't deleted - the
    // signature of a damaged/clobbered index. Restore those instead of losing them.
    let orphans=[];
    if(typeof Store.orphanMaps==='function'){ try{ orphans=await Store.orphanMaps(); }catch(e){} }
    if(orphans && orphans.length){
      try{
        const n=await Store.restoreOrphans(orphans);
        if(n) toast(n+' recovered map'+(n>1?'s':'')+' restored to your list');
      }catch(e){}
      let idx2=[]; try{ idx2=await Store.list(); }catch(e){ console.warn('could not re-list maps after orphan recovery:', e.message); }
      if(idx2.length && await loadMap(idx2[0].id)) return;
    }
    // Truly empty store: on first run, seed the demo sample instead of a blank map.
    if(!localStorage.getItem('mindspark:demoSeeded')){
      const seeded = await seedDemoMap();
      try{ localStorage.setItem('mindspark:demoSeeded','1'); }catch(e){}
      if(seeded) return;
    }
    createMap();
  }
}

function showSharedPill(editable){
  const pill=$('#userPill'); if(!pill) return;
  pill.style.display='flex';
  pill.classList.add('shared-pill');
  const nm=$('#userName'); if(nm) nm.textContent = editable ? 'Shared map' : 'Shared \u00b7 read-only';
  pill.title = editable
    ? 'Editing a shared map - changes are visible to everyone with access'
    : 'Viewing a shared map - read-only';
}
function showUserPill(){
  const pill=$('#userPill'); if(!pill) return;
  pill.classList.remove('shared-pill'); pill.title='';
  pill.style.display='flex';
  $('#userAvatar').src = CloudStore.user.avatar_url;
  $('#userName').textContent = CloudStore.user.login;
  $('#userSignOut').onclick = ()=>{
    if(confirm('Sign out of MindSpark? Your maps stay safely in your GitHub repo.')){
      CloudStore.logout();
      location.reload();
    }
  };
}

// ============================================================
// OPTIONAL GitHub OAuth ("Sign in with GitHub") - second cloud login option.
// Leave these blank to keep the app fully static/no-backend: only the personal
// access token (PAT) flow shows. Set both to enable the OAuth button as well:
//   clientId  : your GitHub OAuth App client_id (public)
//   workerUrl : the deployed Cloudflare Worker base URL (holds the client_secret
//               and does the code->token exchange). See /worker.
// ============================================================
const GH_OAUTH = { clientId: 'Ov23liCukvrI3Zs9p3Px', workerUrl: 'https://mindspark-oauth.githubpage.workers.dev/' };
function oauthConfigured(){
  if(/(^|\.)github\.io$/.test(location.hostname)) return false;
  return !!(GH_OAUTH.clientId && GH_OAUTH.workerUrl);
}
// Live collaboration & cloud share rely on the Cloudflare worker, whose CORS/origin
// is bound to the deployed app - they can't work from local (server-mode) hosting
// or from static GitHub Pages (PAT-only).
function collabAvailable(){ return MODE==='cloud' && oauthConfigured(); }

// Shared success path for BOTH login methods (PAT and OAuth).
// A cloud-backed #shared= link opened while signed out is parked here, then opened
// in-place once sign-in completes (Overleaf-style: shared links require an account).
let _pendingSharedLink = null;
async function completeCloudLogin(token){
  await CloudStore.login(token);
  const ov=$('#loginOverlay'); if(ov) ov.style.display='none';
  showUserPill();
  await proceedBoot();
  if(_pendingSharedLink){
    const s=_pendingSharedLink; _pendingSharedLink=null;
    try{ await openSharedInPlace(s.id, s.token); }catch(e){ console.warn('open shared after login failed:', e); }
  }
}

// Open GitHub's authorize page in a popup. The Worker callback posts the token
// back to this window (see the message listener below).
function startGithubLogin(){
  if(!oauthConfigured()) return;
  const rnd = (window.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('')
    : (Date.now().toString(36)+Math.random().toString(36).slice(2));
  const err=$('#ghError');
  if(!CloudStore._setItemSafe('mindspark:oauth:state', rnd)){
    if(err) err.textContent = 'Could not start sign-in - your browser\'s local storage is full. Try clearing site data for this page and trying again.';
    return;
  }
  const redirect = GH_OAUTH.workerUrl.replace(/\/+$/,'') + '/callback';
  const url = 'https://github.com/login/oauth/authorize'
    + '?client_id='   + encodeURIComponent(GH_OAUTH.clientId)
    + '&redirect_uri=' + encodeURIComponent(redirect)
    + '&scope=repo'
    + '&state='        + encodeURIComponent(rnd);
  const w=620,h=720, left=Math.max(0,(screen.width-w)/2), top=Math.max(0,(screen.height-h)/2);
  const pop = window.open(url, 'mindspark_github_oauth', `width=${w},height=${h},left=${left},top=${top}`);
  if(!pop && err) err.textContent = 'Popup blocked - allow popups for this site, or use a token below.';
}

// Receive the token from the Worker popup. Validated by (a) message origin ===
// the configured Worker origin and (b) a matching one-time state nonce.
window.addEventListener('message', async (ev)=>{
  if(!oauthConfigured()) return;
  let workerOrigin; try{ workerOrigin = new URL(GH_OAUTH.workerUrl).origin; }catch(e){ return; }
  if(ev.origin !== workerOrigin) return;
  const d = ev.data;
  if(!d || d.type !== 'mindspark-oauth') return;
  const expected = localStorage.getItem('mindspark:oauth:state');
  localStorage.removeItem('mindspark:oauth:state');
  const err=$('#ghError');
  if(d.error || !d.token){ if(err) err.textContent='GitHub sign-in failed'+(d.error?(': '+d.error):'')+'.'; return; }
  if(!expected || d.state !== expected){ if(err) err.textContent='Sign-in could not be verified - please try again.'; return; }
  try{ await completeCloudLogin(d.token); }
  catch(e){ if(err) err.textContent = e.message || String(e); }
});

function showLoginOverlay(opts){
  const ov=$('#loginOverlay'); if(!ov) return;
  ov.style.display='flex';
  const note=$('#loginShareNote');
  if(note){
    if(opts && opts.shared){ note.textContent='This map was shared with you. Sign in with GitHub to open it.'; note.style.display='block'; }
    else { note.style.display='none'; }
  }
  const sign=$('#ghSignIn'), pat=$('#ghPat'), err=$('#ghError');
  // OAuth button: only shown when an OAuth App + Worker are configured.
  const oauthBox=$('#loginOauth'), oauthBtn=$('#ghOauthBtn');
  if(oauthBox){
    if(oauthConfigured()){ oauthBox.style.display='block'; if(oauthBtn) oauthBtn.onclick=startGithubLogin; }
    else { oauthBox.style.display='none'; }
  }
  const doLogin=async()=>{
    const tok=(pat.value||'').trim();
    if(!tok){ err.textContent='Paste your token first.'; return; }
    err.textContent=''; sign.disabled=true; sign.textContent='Signing in…';
    try{
      await completeCloudLogin(tok);
    }catch(e){
      err.textContent = e.message || String(e);
      sign.disabled=false; sign.textContent='Sign in';
    }
  };
  sign.onclick = doLogin;
  pat.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  pat.focus();
}

/* ============================================================
   ASYNC SHARING - read-only share links (no backend needed)

   The whole map is serialized, gzip-compressed (when the browser supports
   CompressionStream), and packed into the URL fragment. Opening the link
   decodes it and shows a read-only view. Nothing is sent to any server - the
   data lives entirely in the link, so recipients need no account.
   ============================================================ */
let READONLY = false;   // true while viewing a shared (read-only) map

function _b64urlFromBytes(bytes){
  let bin=''; const CH=0x8000;
  for(let i=0;i<bytes.length;i+=CH) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+CH));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function _bytesFromB64url(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='=';
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function _gzip(str){
  if(typeof CompressionStream==='undefined') return null;
  const cs=new CompressionStream('gzip');
  const w=cs.writable.getWriter(); w.write(new TextEncoder().encode(str)); w.close();
  const buf=await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}
async function _gunzip(bytes){
  const ds=new DecompressionStream('gzip');
  const w=ds.writable.getWriter(); w.write(bytes); w.close();
  const buf=await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
function _shareePayload(m){
  const p = { v:1, title:m.title, color:m.color, style:m.style, layout:m.layout,
              rootId:m.rootId, nodes:m.nodes, links:m.links||[], vars:m.vars||{} };
  if(m.layoutConfig) p.layoutConfig = m.layoutConfig;   // omitted entirely when unset
  if(m.styleConfig) p.styleConfig = m.styleConfig;
  if(m.lookConfig) p.lookConfig = m.lookConfig;
  return p;
}
async function buildShareLink(){
  const json=JSON.stringify(_shareePayload(map));
  const gz=await _gzip(json);
  const token = gz ? ('g'+_b64urlFromBytes(gz)) : ('r'+_b64urlFromBytes(new TextEncoder().encode(json)));
  return location.origin + location.pathname + '#view=' + token;
}
async function decodeShareToken(token){
  const scheme=token[0], body=token.slice(1);
  const bytes=_bytesFromB64url(body);
  const json = scheme==='g' ? await _gunzip(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}
async function copyShareLink(){
  if(!map) return;
  try{
    const url=await buildShareLink();
    const kb=Math.round(url.length/1024*10)/10;
    const finish=()=> toast(url.length>12000
      ? `Link copied (~${kb} KB) - very long links may not open everywhere; consider removing large images`
      : 'Read-only share link copied');
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(url).then(finish, ()=>showShareFallback(url));
    } else showShareFallback(url);
  }catch(e){ toast('Could not build share link'); }
}
function showShareFallback(url){
  document.querySelectorAll('.share-fallback').forEach(p=>p.remove());
  const m=document.createElement('div'); m.className='var-form share-fallback';
  m.innerHTML=`<div class="vf-backdrop"></div><div class="vf-card">
    <button class="vf-close">×</button><h2>Read-only share link</h2>
    <p class="vf-sub">Copy this link and send it to anyone - they can view (not edit) this map, no account needed.</p>
    <textarea class="vf-input" rows="4" readonly style="width:100%">${escapeHtml(url)}</textarea>
    <div class="vf-actions"><button class="vf-go primary">Copy</button></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('textarea'); ta.focus(); ta.select();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick=()=>{ ta.select(); try{document.execCommand('copy'); toast('Copied');}catch(e){} close(); };
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
}
async function tryEnterSharedView(){
  const h=location.hash||'';
  const mt=h.match(/^#view=(.+)$/);
  if(!mt) return false;
  let payload;
  try{ payload=await decodeShareToken(mt[1]); }
  catch(e){ console.error('bad share link',e); return false; }
  READONLY=true;
  document.body.classList.add('shared-view');
  map={ id:'shared', title:payload.title||'Shared map', color:payload.color||'#e0613a',
        style:payload.style, layout:payload.layout, rootId:payload.rootId,
        nodes:payload.nodes||{}, links:payload.links||[], vars:payload.vars||{},
        layoutConfig:payload.layoutConfig, styleConfig:payload.styleConfig, lookConfig:payload.lookConfig };
  sel=null;
  $('#mapTitle').value=map.title; $('#mapTitle').readOnly=true;
  // Grow the title <input> to fit the whole title (it clips to its width) so a
  // shared map shows its full name rather than a truncation.
  $('#mapTitle').size = Math.max(8, (map.title||'').length + 1);
  render();
  showSharedBanner();
  // Lay out + fit once the page has actually been laid out. At initial boot the
  // stage (and nodes) can still measure 0, which makes fit() center on a wrong
  // box and the map disappears. Re-running autoLayout re-measures every node and
  // recomputes clean positions, then fit() frames it. Retry across frames until
  // the stage has a real size; also do it on window 'load' as a backstop.
  let tries=0;
  const settle=()=>{
    if(stage.getBoundingClientRect().width>1){ autoLayout(); fit(); }
    else if(tries++<60){ requestAnimationFrame(settle); }
  };
  requestAnimationFrame(settle);
  window.addEventListener('load', ()=>{ autoLayout(); fit(); }, { once:true });
  return true;
}
function showSharedBanner(){
  if($('#sharedBanner')) return;
  const b=document.createElement('div'); b.id='sharedBanner'; b.className='shared-banner';
  b.innerHTML=`<span class="sb-eye">👁</span>
    <span class="sb-text">You're viewing a shared map - <b>read-only</b></span>
    <button class="sb-copy" id="sbCopy">Make an editable copy</button>
    <a class="sb-brand" href="${location.origin+location.pathname}" title="Open MindSpark">MindSpark</a>`;
  document.body.appendChild(b);
  _setBannerHeightVar(b);
  b.addEventListener('mousedown',e=>e.stopPropagation());
  $('#sbCopy').onclick=()=>{
    try{ sessionStorage.setItem('mindspark:pendingImport', JSON.stringify(_shareePayload(map))); }catch(e){}
    location.href = location.origin + location.pathname;
  };
}
async function consumePendingImport(){
  let raw; try{ raw=sessionStorage.getItem('mindspark:pendingImport'); }catch(e){ return false; }
  if(!raw) return false;
  try{ sessionStorage.removeItem('mindspark:pendingImport'); }catch(e){}
  let p; try{ p=JSON.parse(raw); }catch(e){ return false; }
  const id=uid();
  map={ id, title:(p.title||'Shared map')+' (copy)', titleAuto:false, color:p.color||'#e0613a',
        style:p.style, layout:p.layout, rootId:p.rootId, nodes:p.nodes||{},
        links:p.links||[], vars:p.vars||{}, updated:Date.now() };
  sel=map.rootId; history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value=map.title;
  render(); fit();
  if(typeof Store!=='undefined' && Store){ try{ await Store.save(map); }catch(e){ console.warn('saving the editable copy failed:', e.message); toast('Copy created, but saving failed - it is local only'); } }
  refreshList();
  toast('Editable copy created');
  return true;
}

/* ============================================================================
   Live collaboration - dependency-free op-broadcast (per-node last-write-wins).
   Emits per-node ops on every local edit (via pushHistory) and applies remote
   ops + presence cursors from the room's Durable Object. No Yjs, no deps.
   ============================================================================ */
const Collab = (function(){
  let ws=null, me=null, room=null, active=false, applying=false, joiner=false, firstSnap=true;
  let shadow=null, snapTimer=0, curThrottle=0, pingTimer=0, reapTimer=0;
  const peers=new Map();                    // id -> {color,name,x,y,el}
  let layer=null, pill=null;

  const clone = o => JSON.parse(JSON.stringify(o));
  const snap  = () => ({ nodes:clone(map.nodes), rootId:map.rootId, title:map.title, color:map.color,
                         links:clone(map.links||[]), layout:map.layout, vars:clone(map.vars||{}), style:map.style });
  function wsUrl(r){ try{ const u=new URL(GH_OAUTH.workerUrl);
    return (u.protocol==='https:'?'wss:':'ws:')+'//'+u.host+'/api/collab/'+encodeURIComponent(r); }catch(e){ return null; } }

  function ensureUI(){
    if(!layer){ layer=document.createElement('div'); layer.id='collabCursors'; document.body.appendChild(layer); }
    if(!pill){ pill=document.createElement('div'); pill.id='collabPill'; pill.style.display='none';
      pill.innerHTML='<span class="cp-dots"></span><span class="cp-txt"></span>'
        +'<button class="cp-save" title="Save your own editable copy to your maps">Save a copy</button>'
        +'<button class="cp-link" title="Copy invite link">🔗</button>'
        +'<button class="cp-stop" title="Leave live session">✕</button>';
      document.body.appendChild(pill);
      pill.querySelector('.cp-stop').onclick=()=>stop(true);
      pill.querySelector('.cp-link').onclick=()=>{ copyLink(); toast('Invite link copied'); };
      pill.querySelector('.cp-save').onclick=()=>saveCopy();
    }
  }
  function updatePill(){
    ensureUI();
    if(!active){ pill.style.display='none'; return; }
    pill.style.display='flex';
    const dots=pill.querySelector('.cp-dots'); dots.innerHTML='';
    const add=(c,t)=>{ const d=document.createElement('i'); d.className='cp-dot'; d.style.background=c; d.title=t; dots.appendChild(d); };
    add(me?me.color:'#999','You');
    peers.forEach(p=>add(p.color, p.name||'Guest'));
    const n=peers.size+1;
    pill.querySelector('.cp-txt').textContent='Live · '+n+(n===1?' person':' people');
    const sv=pill.querySelector('.cp-save'); if(sv) sv.style.display=(map&&map._ephemeral)?'':'none';   // only guests fork a copy
  }

  function startHost(){
    if(!map||!map.id){ toast('Open a map first'); return; }
    if(active){ copyLink(); toast('Invite link copied'); return; }
    joiner=false; firstSnap=false; connect(map.id, true);
  }
  function join(roomId){ joiner=true; firstSnap=true; connect(roomId, false); }

  function connect(roomId, asHost){
    const url=wsUrl(roomId); if(!url){ toast('Live editing isn\u2019t configured'); return; }
    room=roomId;
    try{ ws=new WebSocket(url); }catch(e){ toast('Could not start live session'); return; }
    ws.onopen=()=>{ active=true; shadow=snap();
      if(asHost){ send({t:'snapshot', map:snap()}); copyLink(); toast('Live session started - link copied'); }
      bindCursor(); updatePill(); loop();
      pingTimer=setInterval(()=>send({t:'ping'}), 6000);   // heartbeat so peers know we\u2019re alive
      reapTimer=setInterval(reapStale, 5000);              // drop cursors of peers gone silent (network drop)
    };
    ws.onmessage=ev=>onMessage(ev.data);
    ws.onclose=()=>{ active=false; clearCursors(); updatePill(); };
    ws.onerror=()=>{ toast('Live connection error'); };
  }
  function stop(notify){ clearInterval(pingTimer); clearInterval(reapTimer); if(ws){ try{ ws.close(); }catch(e){} } ws=null; active=false; room=null; peers.clear(); clearCursors(); updatePill(); if(notify) toast('Left live session'); }
  function send(o){ if(ws&&ws.readyState===1){ try{ ws.send(JSON.stringify(o)); }catch(e){ console.warn('live-session send failed; this edit was not broadcast:', e.message); } } }
  function link(){ return location.origin+location.pathname+'#live='+room; }
  function copyLink(){ try{ navigator.clipboard.writeText(link()); }catch(e){ console.warn('clipboard write failed:', e.message); toast('Could not copy - copy the link from the address bar'); } }

  function onMessage(data){
    let m; try{ m=JSON.parse(data); }catch(e){ return; }
    if(m.from){ const pr=peers.get(m.from); if(pr) pr.lastSeen=Date.now(); }   // liveness
    switch(m.t){
      case 'welcome':
        me={id:m.id, color:m.color};
        peers.clear(); (m.peers||[]).forEach(p=>peers.set(p.id,{color:p.color,name:p.name||'',lastSeen:Date.now()}));
        if(joiner && m.snapshot) applySnapshot(m.snapshot);
        updatePill(); break;
      case 'ping': break;   // heartbeat only (lastSeen already refreshed above)
      case 'join':  peers.set(m.id,{color:m.color,name:'',lastSeen:Date.now()}); updatePill(); break;
      case 'leave': removeCursor(m.id); peers.delete(m.id); updatePill(); break;
      case 'name':  { const p=peers.get(m.id); if(p){ p.name=m.name; updatePill(); } break; }
      case 'cur':   moveCursor(m.from, m.x, m.y); break;
      case 'op':    applyOps(m.ops); break;
      case 'snapshot': if(joiner && firstSnap) applySnapshot(m.map); break;
    }
  }

  function applySnapshot(s){
    applying=true;
    try{
      map.nodes=clone(s.nodes||{}); if(s.rootId) map.rootId=s.rootId;
      if(s.title!=null){ map.title=s.title; const t=$('#mapTitle'); if(t) t.value=s.title; }
      if(s.color) map.color=s.color;
      if(s.links) map.links=clone(s.links);
      if(s.layout) map.layout=s.layout;
      if(s.vars)  map.vars=clone(s.vars);
      if('style' in s) map.style=s.style;
      shadow=snap();
      if(typeof autoLayout==='function') autoLayout();
      render();
      if(firstSnap && typeof fit==='function'){ fit(); firstSnap=false; }
      pushHistory();                 // baseline snapshot so a guest can undo their first edit
    } finally { applying=false; }    // always release the lock, even if malformed snapshot data throws partway through - otherwise every local edit silently stops syncing for the rest of the session
  }
  function applyOps(ops){
    applying=true;
    try{
      for(const op of ops){
        if(op.t==='node') map.nodes[op.id]=op.n;
        else if(op.t==='del'){ delete map.nodes[op.id]; if(sel===op.id) sel=null; }
        else if(op.t==='meta'){ if(op.k==='title'){ map.title=op.v; const t=$('#mapTitle'); if(t) t.value=op.v; } else map[op.k]=op.v; }
      }
      shadow=snap(); render();
    } finally { applying=false; }    // same guarantee - a malformed op or a render() edge case must not permanently wedge sync
    if(map && !map._ephemeral && !READONLY) scheduleSave();   // host persists collaborators' edits
  }

  // Called from pushHistory() AND after autoLayout(). Coalesced on a short timer
  // so a pushHistory()+autoLayout() burst is diffed ONCE - capturing the final,
  // aligned node positions rather than the pre-layout ones.
  let opTimer=0;
  function onLocalChange(){
    if(!active||applying||!shadow||!map) return;
    clearTimeout(opTimer); opTimer=setTimeout(flushOps, 60);
  }
  function flushOps(){
    if(!active||!shadow||!map) return;
    const cur=snap(), ops=diff(shadow, cur);
    if(ops.length){
      send({t:'op', ops}); shadow=cur;
      clearTimeout(snapTimer); snapTimer=setTimeout(()=>{ if(active) send({t:'snapshot', map:snap()}); }, 1500);
    }
  }
  function diff(prev, cur){
    const ops=[];
    for(const id in cur.nodes){ const a=prev.nodes[id], b=cur.nodes[id];
      if(!a || JSON.stringify(a)!==JSON.stringify(b)) ops.push({t:'node', id, n:b}); }
    for(const id in prev.nodes){ if(!cur.nodes[id]) ops.push({t:'del', id}); }
    if(prev.title!==cur.title)  ops.push({t:'meta', k:'title',  v:cur.title});
    if(prev.color!==cur.color)  ops.push({t:'meta', k:'color',  v:cur.color});
    if(prev.rootId!==cur.rootId)ops.push({t:'meta', k:'rootId', v:cur.rootId});
    if(JSON.stringify(prev.links||[])!==JSON.stringify(cur.links||[])) ops.push({t:'meta', k:'links', v:cur.links});
    if(prev.layout!==cur.layout) ops.push({t:'meta', k:'layout', v:cur.layout});
    if(JSON.stringify(prev.vars||{})!==JSON.stringify(cur.vars||{})) ops.push({t:'meta', k:'vars', v:cur.vars});
    if(JSON.stringify(prev.style)!==JSON.stringify(cur.style)) ops.push({t:'meta', k:'style', v:cur.style});
    return ops;
  }

  // ---- presence cursors ----
  function bindCursor(){
    const surf = (typeof stage!=='undefined' && stage) ? stage : document.body;
    if(surf._collabBound) return; surf._collabBound=true;
    surf.addEventListener('pointermove', e=>{
      if(!active) return; const now=Date.now(); if(now-curThrottle<55) return; curThrottle=now;
      // e.clientX/Y are raw viewport-relative coordinates - need the same stage-offset +
      // UI-zoom correction _stagePoint() already applies elsewhere before they're
      // comparable to view.x/y at all, then undo the canvas pan/zoom to get map-space.
      const p=_stagePoint(e.clientX, e.clientY);
      send({t:'cur', x:(p.x-view.x)/view.k, y:(p.y-view.y)/view.k });
    });
  }
  function moveCursor(id, wx, wy){
    const p=peers.get(id); if(!p) return; p.x=wx; p.y=wy; ensureUI();
    if(!p.el){ p.el=document.createElement('div'); p.el.className='collab-cursor';
      p.el.innerHTML='<svg viewBox="0 0 16 16" width="18" height="18"><path d="M1 1 L1 13 L4.6 9.6 L7 14.5 L9.2 13.4 L6.8 8.6 L11.5 8.6 Z"/></svg><b></b>';
      layer.appendChild(p.el); }
    p.el.querySelector('path').setAttribute('fill', p.color);
    const b=p.el.querySelector('b'); b.textContent=p.name||'Guest'; b.style.background=p.color;
    place(p);
  }
  function place(p){ if(!p.el||p.x==null) return; p.el.style.transform='translate('+(p.x*view.k+view.x)+'px,'+(p.y*view.k+view.y)+'px)'; }
  function reposition(){ peers.forEach(place); }
  function loop(){ if(!active) return; reposition(); requestAnimationFrame(loop); }
  function removeCursor(id){ const p=peers.get(id); if(p&&p.el){ p.el.remove(); p.el=null; } }
  function clearCursors(){ peers.forEach(p=>{ if(p.el){ p.el.remove(); p.el=null; } }); if(layer) layer.innerHTML=''; }
  function reapStale(){ const now=Date.now(); let changed=false;
    peers.forEach((pr,id)=>{ if(now-(pr.lastSeen||now) > 18000){ removeCursor(id); peers.delete(id); changed=true; } });
    if(changed) updatePill(); }

  // Guest forks the live map into their OWN repo. Reuses the shared-view import:
  // stash the current map, leave the room, reload - consumePendingImport() (which
  // runs after sign-in) creates and saves the editable copy.
  function saveCopy(){
    if(!map){ return; }
    try{ sessionStorage.setItem('mindspark:pendingImport', JSON.stringify(_shareePayload(map))); }catch(e){}
    stop(false);
    toast('Opening your copy\u2026');
    location.href = location.origin + location.pathname;
  }

  // A closing/backgrounded tab closes the socket promptly so peers drop our cursor.
  window.addEventListener('pagehide', ()=>{ try{ if(ws && ws.readyState===1) ws.close(); }catch(e){} });

  return { startHost, join, stop, onLocalChange, reposition, isActive:()=>active };
})();

// autoLayout() repositions nodes without going through pushHistory(), so wrap it
// to also notify the live session - coalesced, so it only sends real changes.
if(typeof autoLayout==='function'){
  const _autoLayout_orig = autoLayout;
  autoLayout = function(){ const r=_autoLayout_orig.apply(this, arguments);
    try{ if(typeof Collab!=='undefined') Collab.onLocalChange(); }catch(e){} return r; };
}

function leaveLiveForSwitch(){
  // Returns true if the caller may switch maps, false to abort.
  if(typeof Collab==='undefined' || !Collab.isActive()) return true;
  if(map && map._ephemeral){
    // Guest leaving the live view: re-boot the app (login overlay, or their own maps).
    Collab.stop(false);
    location.href = location.origin + location.pathname;   // drops #live
    return false;
  }
  // Host: confirm before disconnecting collaborators.
  if(!confirm('Leave the live session? Your collaborators will be disconnected from this map.')) return false;
  Collab.stop(false); toast('Left the live session');
  return true;
}

// ---- Cloud-hosted shared map (async, persists in the Durable Object) ----
function sharedApiUrl(id){
  try{ const u=new URL(GH_OAUTH.workerUrl); return u.origin+'/api/collab/'+encodeURIComponent(id); }
  catch(e){ return null; }
}
// ---- Session identity: a short-lived signed JWT proving the GitHub identity, sent
// as a Bearer to the collab worker so it can enforce per-map ACLs. If the worker has
// no AUTH_SECRET configured it returns 501 and we fall back to legacy capability links.
const Session = {
  jwt:null, exp:0, id:null, login:null, _pending:null, _off:false,
  async ensure(){
    if(this._off) return null;
    if(this.jwt && (Date.now()/1000) < this.exp-60) return this.jwt;
    if(this._pending) return this._pending;
    this._pending=(async()=>{
      try{
        if(typeof CloudStore==='undefined' || !CloudStore.token) return null;
        const base=(GH_OAUTH.workerUrl||'').replace(/\/+$/,''); if(!base) return null;
        const r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:CloudStore.token})});
        if(r.status===501){ this._off=true; return null; }
        if(!r.ok) return null;
        const d=await r.json(); this.jwt=d.token; this.exp=d.exp||0; this.id=d.id||null; this.login=d.login||null;
        return this.jwt;
      }catch(e){ return null; }
    })();
    const v=await this._pending; this._pending=null; return v;
  },
  clear(){ this.jwt=null; this.exp=0; this.id=null; this.login=null; this._off=false; }
};
// All collab Durable-Object calls go through here so they carry the Bearer identity.
async function _collabFetch(url, opts={}){
  const headers={ ...(opts.headers||{}) };
  const jwt=await Session.ensure(); if(jwt) headers['Authorization']='Bearer '+jwt;
  return fetch(url, { ...opts, headers });
}
// ---- "Shared with me" library: links you've opened, kept per-browser ----
function _sharedStore(){ try{ return JSON.parse(localStorage.getItem('mindspark:sharedMaps')||'[]'); }catch(e){ return []; } }
function _saveSharedStore(a){ try{ localStorage.setItem('mindspark:sharedMaps', JSON.stringify(a)); }catch(e){} }
function rememberSharedMap(entry){
  if(!entry || !entry.id) return;
  const a=_sharedStore(); const at=a.findIndex(x=>x.id===entry.id);
  const rec={ id:entry.id, token: entry.token || (at>=0?a[at].token:null),
              title: entry.title || (at>=0?a[at].title:'Shared map'),
              color: entry.color || (at>=0?a[at].color:'#e0613a'), addedAt: Date.now() };
  if(at>=0) a[at]=rec; else a.unshift(rec);
  _saveSharedStore(a);
}
function forgetSharedMap(id){ _saveSharedStore(_sharedStore().filter(x=>x.id!==id)); refreshList(); toast('Removed from list'); }
function openSharedFromLibrary(sm){ openSharedInPlace(sm.id, sm.token); }
// ---- "Shared by me" library: maps you've published; opening one connects to the LIVE
// shared copy (polling + merge) so you actually see collaborators' edits. ----
function _sharedByMeStore(){ try{ return JSON.parse(localStorage.getItem('mindspark:sharedByMe')||'[]'); }catch(e){ return []; } }
function _saveSharedByMeStore(a){ try{ localStorage.setItem('mindspark:sharedByMe', JSON.stringify(a)); }catch(e){} }
function rememberSharedByMe(entry){
  if(!entry || !entry.room) return;
  const a=_sharedByMeStore(); const at=a.findIndex(x=>x.room===entry.room || x.id===entry.id);
  const rec={ id:entry.id, room:entry.room, token: entry.token || (at>=0?a[at].token:null),
              title: entry.title || (at>=0?a[at].title:'Shared map'), color: entry.color || (at>=0?a[at].color:'#e0613a'), addedAt: Date.now() };
  if(at>=0) a[at]=rec; else a.unshift(rec);
  _saveSharedByMeStore(a);
  if(typeof refreshList==='function') refreshList();
}
function forgetSharedByMe(room){ _saveSharedByMeStore(_sharedByMeStore().filter(x=>x.room!==room)); refreshList(); toast('Removed from Shared by me'); }
function openSharedByMeRowMenu(btn, sm){
  if(_rowPop && _rowPop._for==='sbm:'+sm.room){ closeRowMenu(); return; }
  if(typeof closeAllMenus==='function') closeAllMenus();
  closeRowMenu();
  const pop=document.createElement('div'); pop.className='row-pop'; pop._for='sbm:'+sm.room;
  pop.innerHTML='<button data-a="open"><span class="rp-ic">\u2197</span>Open live copy</button>'+
    '<button data-a="copyedit"><span class="rp-ic">\u270F\uFE0F</span>Copy edit link</button>'+
    '<button data-a="access"><span class="rp-ic">\uD83D\uDD10</span>Manage access</button>'+
    '<button data-a="forget" class="danger"><span class="rp-ic">\u2715</span>Remove from list</button>';
  pop.style.visibility='hidden'; pop.style.left='-9999px'; pop.style.top='-9999px';
  document.body.appendChild(pop);
  positionRowPop(pop, btn);
  const editLink=location.origin+location.pathname+'#shared='+sm.room+':'+sm.token;
  pop.querySelector('[data-a="open"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); openSharedInPlace(sm.room, sm.token); };
  pop.querySelector('[data-a="copyedit"]').onclick=async ev=>{ ev.stopPropagation(); closeRowMenu(); try{ await navigator.clipboard.writeText(editLink); toast('Edit link copied'); }catch(e){} };
  pop.querySelector('[data-a="access"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); openAccessPanel(sm.room); };
  pop.querySelector('[data-a="forget"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); forgetSharedByMe(sm.room); };
  _rowPop=pop;
  _rowPopOut=(e)=>{ if(_rowPop && (!e || e.type!=='mousedown' || !_rowPop.contains(e.target))) closeRowMenu(); };
  setTimeout(()=>{ document.addEventListener('mousedown', _rowPopOut, true); window.addEventListener('scroll', closeRowMenu, true); window.addEventListener('blur', closeRowMenu); },0);
}
function openSharedRowMenu(btn, sm){
  const key='sh:'+(sm.room||sm.id);
  if(_rowPop && _rowPop._for===key){ closeRowMenu(); return; }
  if(typeof closeAllMenus==='function') closeAllMenus();
  closeRowMenu();
  const room=sm.room||sm.id;
  const pop=document.createElement('div'); pop.className='row-pop'; pop._for=key;
  pop.innerHTML='<button data-a="open"><span class="rp-ic">\u2197</span>Open</button>'+
    (sm.token?'<button data-a="copyedit"><span class="rp-ic">\u270F\uFE0F</span>Copy edit link</button>':'')+
    '<button data-a="copyview"><span class="rp-ic">\uD83D\uDD17</span>Copy view link</button>'+
    (sm.mine?'<button data-a="access"><span class="rp-ic">\uD83D\uDD10</span>Manage access</button>':'')+
    '<button data-a="forget" class="danger"><span class="rp-ic">\u2715</span>Remove from list</button>';
  pop.style.visibility='hidden'; pop.style.left='-9999px'; pop.style.top='-9999px';
  document.body.appendChild(pop);
  positionRowPop(pop, btn);
  const base=location.origin+location.pathname+'#shared='+room;
  pop.querySelector('[data-a="open"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); openSharedInPlace(room, sm.token); };
  const ce=pop.querySelector('[data-a="copyedit"]'); if(ce) ce.onclick=async ev=>{ ev.stopPropagation(); closeRowMenu(); try{ await navigator.clipboard.writeText(base+':'+sm.token); toast('Edit link copied'); }catch(e){} };
  pop.querySelector('[data-a="copyview"]').onclick=async ev=>{ ev.stopPropagation(); closeRowMenu(); try{ await navigator.clipboard.writeText(base); toast('View link copied'); }catch(e){} };
  const ac=pop.querySelector('[data-a="access"]'); if(ac) ac.onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); openAccessPanel(room); };
  pop.querySelector('[data-a="forget"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); if(sm.mine) forgetSharedByMe(room); else forgetSharedMap(room); };
  _rowPop=pop;
  _rowPopOut=(e)=>{ if(_rowPop && (!e || e.type!=='mousedown' || !_rowPop.contains(e.target))) closeRowMenu(); };
  setTimeout(()=>{ document.addEventListener('mousedown', _rowPopOut, true); window.addEventListener('scroll', closeRowMenu, true); window.addEventListener('blur', closeRowMenu); },0);
}
// Publish the current map to the cloud store; returns a short #shared=<id> link.
async function publishSharedMap(){
  if(!map || !map.id){ toast('Open a map first'); return; }
  if(!sharedApiUrl(map.id)){ toast('Cloud sharing isn\u2019t configured'); return; }
  if(!map._editToken) map._editToken = 'e'+Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,6);
  let room = map._shareRoom || map.id;
  const body = JSON.stringify(_shareePayload(map));
  try{
    let r=await _collabFetch(sharedApiUrl(room), { method:'PUT', headers:{'Content-Type':'application/json','X-Edit-Token':map._editToken}, body });
    if(r.status===403){
      // Base room was claimed under a different (older) token and is locked. Move to a
      // fresh room id so the owner always gets a working edit link.
      room = map.id+'~'+Math.random().toString(36).slice(2,7); map._shareRoom = room;
      r=await _collabFetch(sharedApiUrl(room), { method:'PUT', headers:{'Content-Type':'application/json','X-Edit-Token':map._editToken}, body });
    }
    if(!r.ok) throw new Error('HTTP '+r.status);
    const editLink=location.origin+location.pathname+'#shared='+room+':'+map._editToken;
    try{ await navigator.clipboard.writeText(editLink); }catch(e){ console.warn('clipboard write failed:', e.message); toast('Could not copy the edit link'); }
    map._shareRoom = room;
    // New editable shares require collaborators to sign in (legacy links stay anonymous until re-shared).
    try{ await accessApi(room, 'link', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ access:'edit-auth' }) }); }catch(e){}
    rememberSharedByMe({ id: map.id, room, token: map._editToken, title: map.title, color: map.color });
    if(typeof scheduleSave==='function' && !map._cloudEdit) scheduleSave();   // persist the token in the owner repo so re-publishing reuses it
    toast('Edit link copied - collaborators sign in with GitHub to open it.');
  }catch(e){ toast('Could not publish: '+(e.message||e)); }
}

// ---- Identity-based access control: owner manages named collaborators + link access ----
async function accessApi(roomId, sub, opts){
  const base=sharedApiUrl(roomId); if(!base) return { status:0, ok:false, d:{} };
  try{ const r=await _collabFetch(base+(sub?('/'+sub):''), opts||{}); let d={}; try{ d=await r.json(); }catch(e){} return { status:r.status, ok:r.ok, d }; }
  catch(e){ return { status:0, ok:false, d:{} }; }
}
async function _resolveGitHubUser(login){
  login=String(login||'').trim().replace(/^@/,''); if(!login) return null;
  try{
    const h=(typeof CloudStore!=='undefined'&&CloudStore.token)?{Authorization:'token '+CloudStore.token,Accept:'application/vnd.github+json'}:{Accept:'application/vnd.github+json'};
    const r=await fetch('https://api.github.com/users/'+encodeURIComponent(login),{headers:h});
    if(!r.ok) return null; const u=await r.json(); return (u&&u.id!=null)?{ id:String(u.id), login:u.login }:null;
  }catch(e){ return null; }
}
function _accessRoomId(){ return (map && (map._cloudView || map._shareRoom || map.id)) || null; }
async function openAccessPanel(roomId){
  roomId = roomId || _accessRoomId();
  if(!roomId){ toast('Publish or open a shared map first'); return; }
  if(!sharedApiUrl(roomId)){ toast('Cloud sharing isn\u2019t configured'); return; }
  const acl=await accessApi(roomId,'acl',{method:'GET'});
  if(acl.status===401){ toast('Sign in to manage access'); return; }
  if(acl.status===403){ toast('Only the map owner can manage access'); return; }
  if(!acl.ok){ toast('Couldn\u2019t load access settings - publish the map first'); return; }
  _renderAccessPanel(roomId, acl.d);
}
function _timeAgo(ts){
  const sec=Math.max(0,Math.floor((Date.now()-(ts||0))/1000));
  if(sec<60) return 'just now';
  const m=Math.floor(sec/60); if(m<60) return m+'m ago';
  const h=Math.floor(m/60); if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function _renderAccessPanel(roomId, data){
  const ex=document.querySelector('.access-modal'); if(ex) ex.remove();
  const ov=document.createElement('div'); ov.className='access-modal';
  const members=data.members||{}; const link=data.linkAccess||'none';
  // Decompose linkAccess into a level (none/view/edit) + whether sign-in is required.
  const level = link==='none' ? 'none' : (link.indexOf('view')===0 ? 'view' : 'edit');
  const requireAuth = /-auth$/.test(link);
  const rows=Object.keys(members).map(id=>{
    const mem=members[id]||{};
    return '<div class="am-row"><span class="am-who">@'+escapeHtml(mem.login||id)+'</span>'+
      '<span class="am-role">'+(mem.role==='viewer'?'Viewer':'Editor')+'</span>'+
      '<button class="am-rm" data-id="'+escapeHtml(id)+'">Remove</button></div>';
  }).join('') || '<div class="am-empty">No named collaborators yet.</div>';
  const vis=data.visitors||{};
  const vkeys=Object.keys(vis).sort((a,b)=>(vis[b].lastSeen||0)-(vis[a].lastSeen||0));
  const visitorsHtml = vkeys.length ? (
    '<div class="am-sec"><div class="am-lbl">Recently opened by</div><div class="am-vis">'+
    vkeys.map(id=>'<div class="am-visrow"><span class="am-who">@'+escapeHtml(vis[id].login||id)+'</span>'+
      '<span class="am-vtime">'+_timeAgo(vis[id].lastSeen)+'</span></div>').join('')+
    '</div></div>') : '';
  ov.innerHTML='<div class="am-card"><div class="am-head"><b>Manage access</b><button class="am-x" aria-label="Close">\u00d7</button></div>'+
    '<div class="am-sec"><div class="am-lbl">Anyone with the link</div><div class="am-link">'+
      '<label><input type="radio" name="amlink" value="none" '+(level==='none'?'checked':'')+'> No access</label>'+
      '<label><input type="radio" name="amlink" value="view" '+(level==='view'?'checked':'')+'> Can view</label>'+
      '<label><input type="radio" name="amlink" value="edit" '+(level==='edit'?'checked':'')+'> Can edit</label>'+
    '</div>'+
    '<label class="am-auth"><input type="checkbox" class="am-reqauth" '+(requireAuth?'checked':'')+' '+(level==='none'?'disabled':'')+'> Require GitHub sign-in to open</label>'+
    '</div>'+
    '<div class="am-sec"><div class="am-lbl">Collaborators</div><div class="am-list">'+rows+'</div>'+
      '<div class="am-add"><input class="am-user" type="text" placeholder="GitHub username" autocomplete="off">'+
      '<select class="am-newrole"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>'+
      '<button class="am-addbtn">Add</button></div></div>'+
    visitorsHtml+
    '<div class="am-foot">Owner: @'+escapeHtml(data.ownerLogin||data.ownerId||'')+'</div></div>';
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.addEventListener('mousedown',e=>{ if(e.target===ov) close(); });
  ov.querySelector('.am-x').onclick=close;
  const combined=()=>{
    const lvl=ov.querySelector('input[name="amlink"]:checked').value;
    if(lvl==='none') return 'none';
    return ov.querySelector('.am-reqauth').checked ? (lvl+'-auth') : lvl;
  };
  const applyLink=async()=>{
    const access=combined();
    const res=await accessApi(roomId,'link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access})});
    toast((res&&res.ok)?'Link access updated':'Couldn\u2019t update link access');
  };
  ov.querySelectorAll('input[name="amlink"]').forEach(r=>r.onchange=()=>{
    ov.querySelector('.am-reqauth').disabled = (r.value==='none');
    applyLink();
  });
  ov.querySelector('.am-reqauth').onchange=applyLink;
  ov.querySelectorAll('.am-rm').forEach(b=>b.onclick=async()=>{
    const res=await accessApi(roomId,'acl/'+encodeURIComponent(b.dataset.id),{method:'DELETE'});
    if(res&&res.ok) openAccessPanel(roomId); else toast('Couldn\u2019t remove collaborator');
  });
  ov.querySelector('.am-addbtn').onclick=async()=>{
    const login=ov.querySelector('.am-user').value; const role=ov.querySelector('.am-newrole').value;
    if(!login.trim()) return;
    const u=await _resolveGitHubUser(login);
    if(!u){ toast('No such GitHub user'); return; }
    const res=await accessApi(roomId,'acl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:u.id, login:u.login, role})});
    if(res&&res.ok){ toast('Added @'+u.login); openAccessPanel(roomId); }
    else toast(res&&res.status===400?'That user is already the owner':'Couldn\u2019t add collaborator');
  };
}
function _cloneObj(o){ return JSON.parse(JSON.stringify(o)); }
// Diff the loaded base against the current map -> per-node ops the server merges.
function cloudDiff(base, cur){
  const ops=[]; const bn=(base&&base.nodes)||{}, cn=(cur&&cur.nodes)||{};
  for(const id in cn){ if(JSON.stringify(bn[id])!==JSON.stringify(cn[id])) ops.push({t:'node', id, n:cn[id]}); }
  for(const id in bn){ if(!cn[id]) ops.push({t:'del', id}); }
  ['title','color','rootId','layout','style'].forEach(k=>{ if((base||{})[k]!==(cur||{})[k]) ops.push({t:'meta',k,v:cur[k]}); });
  if(JSON.stringify((base&&base.links)||[])!==JSON.stringify((cur&&cur.links)||[])) ops.push({t:'meta',k:'links',v:cur.links});
  if(JSON.stringify((base&&base.vars)||{})!==JSON.stringify((cur&&cur.vars)||{})) ops.push({t:'meta',k:'vars',v:cur.vars});
  return ops;
}
// Adopt the server's merged map (your edits + others') so editors converge.
function adoptCloudMerged(merged){
  if(!merged || typeof merged!=='object') return;
  const selId = sel && sel.id;
  map.nodes = merged.nodes||{};
  map.links = merged.links||[];
  if(merged.title!=null) map.title=merged.title;
  if(merged.color) map.color=merged.color;
  if(merged.rootId) map.rootId=merged.rootId;
  if(merged.layout) map.layout=merged.layout;
  if('style' in merged) map.style=merged.style;
  if(merged.vars) map.vars=merged.vars;
  sel = (selId && map.nodes[selId]) ? map.nodes[selId] : null;
  if($('#mapTitle')) $('#mapTitle').value=map.title;
  render();
}
let _cloudSaveTimer=0, _cloudPollTimer=0, _cloudPollSig='';
// Perform the cloud save (diff -> PATCH -> adopt merged). Separated so a map switch
// can flush a pending save immediately.
// If the owner is locked out of their own shared map (the Durable Object room was
// claimed under a token from an earlier build/session, so this link's token no
// longer matches - a 403), re-publish the CURRENT content to a fresh room id and
// rebind the live session. The old link is already dead, so a new one is the only fix.
async function _recoverCloudSave(ce){
  if(map._healing) return false; map._healing=true;
  try{
    const baseId=String(ce.id||'').split('~')[0];
    let owned=null; try{ owned=await Store.get(baseId); }catch(e){}
    if(!owned) return false;                     // not the owner -> can't reset someone else's room
    const room=baseId+'~'+Math.random().toString(36).slice(2,7);
    const token=owned._editToken || ce.token || ('e'+Math.random().toString(36).slice(2,10));
    const url=sharedApiUrl(room); if(!url) return false;
    const r=await _collabFetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Token':token},body:JSON.stringify(_shareePayload(map))});
    if(!r.ok) return false;
    map._cloudEdit={id:room,token}; map._cloudView=room;
    map._cloudBase=_cloneObj(_shareePayload(map));
    rememberSharedMap({id:room,token,title:map.title,color:map.color});
    try{ _saveSharedStore(_sharedStore().filter(x=>x.id!==baseId)); }catch(e){}   // drop the dead base-room entry
    const link=location.origin+location.pathname+'#shared='+room+':'+token;
    try{ window.history.replaceState(null,'',link); }catch(e){}
    try{ await navigator.clipboard.writeText(link); }catch(e){ console.warn('clipboard write failed:', e.message); toast('Could not copy the link'); }
    _cloudPollSig=JSON.stringify(_shareePayload(map)); stopCloudPoll(); startCloudPoll(room);
    toast('Old share link was out of sync - created a fresh editable link (copied). Re-share it with collaborators.');
    return true;
  } finally { map._healing=false; }
}
async function _doCloudSave(ce, retried){
  const url=sharedApiUrl(ce.id);
  if(!url){ $('#saveText').textContent='Save failed'; return; }
  const cur=_shareePayload(map);
  const ops=cloudDiff(map._cloudBase||cur, cur);
  if(!ops.length){ $('#savePill').classList.remove('saving'); $('#saveText').textContent='Saved'; return; }
  try{
    const r=await _collabFetch(url, { method:'PATCH', headers:{'Content-Type':'application/json','X-Edit-Token':ce.token}, body:JSON.stringify({ops}) });
    if(!r.ok) throw new Error('HTTP '+r.status);
    const res=await r.json().catch(()=>null);
    if(res && res.map) adoptCloudMerged(res.map);
    map._cloudBase=_cloneObj(_shareePayload(map));   // base = what's now on the server
    _cloudPollSig = JSON.stringify(res && res.map ? res.map : _shareePayload(map));
    $('#savePill').classList.remove('saving'); $('#saveText').textContent='Saved';
  }catch(e){
    if(!retried && /\b403\b/.test(String(e.message))){
      if(await _recoverCloudSave(ce)) return _doCloudSave(map._cloudEdit, true);
      $('#savePill').classList.remove('saving'); $('#saveText').textContent='Save failed';
      toast('This shared link is out of sync. Ask the map owner for a fresh edit link.');
      return;
    }
    $('#savePill').classList.remove('saving'); $('#saveText').textContent='Save failed';
    toast('Couldn\u2019t save shared map: '+(e.message||e));
  }
}
function scheduleCloudSave(){
  const ce=map._cloudEdit; if(!ce) return;
  if(map._opening) return;                    // just opened this shared map - not a user edit
  const cur=_shareePayload(map);
  if(!cloudDiff(map._cloudBase||cur, cur).length) return;   // nothing actually changed - don't flash "Saving…"
  $('#savePill').classList.add('saving'); $('#saveText').textContent='Saving…';
  clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer=setTimeout(()=>{ _cloudSaveTimer=0; _doCloudSave(ce); }, 1200);
}
// Fire any pending cloud edit immediately (used when leaving a shared map): send the
// diff without adopting back, since we're switching away from this map.
function flushCloudSave(){
  if(!_cloudSaveTimer) return;
  clearTimeout(_cloudSaveTimer); _cloudSaveTimer=0;
  const ce=map && map._cloudEdit; if(!ce) return;
  const url=sharedApiUrl(ce.id); if(!url) return;
  const ops=cloudDiff(map._cloudBase||_shareePayload(map), _shareePayload(map));
  if(!ops.length) return;
  try{ _collabFetch(url, { method:'PATCH', headers:{'Content-Type':'application/json','X-Edit-Token':ce.token}, body:JSON.stringify({ops}) }).catch(()=>{}); }catch(e){}
}
// Lightweight polling so shared maps reflect others' edits without a live session.
function startCloudPoll(id){ stopCloudPoll(); _cloudPollTimer=setInterval(()=>cloudPollOnce(id), 5000); }
function stopCloudPoll(){ if(_cloudPollTimer){ clearInterval(_cloudPollTimer); _cloudPollTimer=0; } }
async function cloudPollOnce(id){
  if(!map || document.hidden) return;
  if(map._cloudView!==id){ stopCloudPoll(); return; }   // switched away -> stop; never adopt onto another map
  const url=sharedApiUrl(id); if(!url) return;
  let data; try{ const r=await _collabFetch(url); if(!r.ok) return; data=await r.json(); }catch(e){ return; }
  const sig=JSON.stringify(data);
  if(sig===_cloudPollSig) return;                        // nothing new since last poll
  if(map._cloudEdit){
    const pending = cloudDiff(map._cloudBase||_shareePayload(map), _shareePayload(map)).length>0;
    if(pending) return;                                  // don't stomp unsaved local edits; next save merges
    adoptCloudMerged(data); map._cloudBase=_cloneObj(_shareePayload(map));
  } else {
    adoptCloudMerged(data);                              // read-only viewer reflects latest
  }
  _cloudPollSig=sig;
}
window.addEventListener('pagehide', stopCloudPoll);
// Measure the shared banner's real height into a CSS var so the app/canvas offset
// adapts when the text wraps (e.g. narrow screens) instead of guessing a fixed px.
function _setBannerHeightVar(b){
  requestAnimationFrame(()=>{ try{ const h=Math.ceil(b.getBoundingClientRect().height/_uiZ());
    if(h>0) document.documentElement.style.setProperty('--shared-banner-h', h+'px'); }catch(e){} });
}
window.addEventListener('resize', ()=>{ const b=document.getElementById('cloudEditBanner')||document.getElementById('sharedBanner'); if(b) _setBannerHeightVar(b); });
function showCloudEditBanner(){
  if($('#cloudEditBanner')) return;
  const b=document.createElement('div'); b.id='cloudEditBanner'; b.className='shared-banner';
  b.innerHTML='<span class="sb-eye">\u270F\uFE0F</span>'
    +'<span class="sb-text">You\u2019re editing a <b>shared</b> map - changes save for everyone with the link</span>';
  document.body.appendChild(b);
  _setBannerHeightVar(b);
}
// ---- Shared-map core (used by direct-link boot AND in-place open from the sidebar) ----
async function _fetchSharedMap(id){
  const url=sharedApiUrl(id); if(!url) return null;
  try{ const r=await _collabFetch(url); if(!r.ok) return null; return await r.json(); }
  catch(e){ console.error('shared map load failed', e); return null; }
}
// Apply a fetched shared snapshot into the live editor (banner, poll, read-only state).
function _applySharedMap(id, token, data){
  const editable=!!token;
  READONLY=!editable;
  document.body.classList.remove('cloud-edit','shared-view');
  document.body.classList.add(editable?'cloud-edit':'shared-view');
  document.body.classList.add('no-banner');   // compact themed pill instead of a full-width banner
  map={ id:'shared-'+id, title:data.title||'Shared map', color:data.color||'#e0613a',
        style:data.style, layout:data.layout||'balanced', rootId:data.rootId,
        nodes:data.nodes||{}, links:data.links||[], vars:data.vars||{} };
  map._cloudView=id;
  map._opening=true;                 // opening a shared map isn't an edit - suppress the save pill until it settles
  if(editable){ map._cloudEdit={ id, token }; }
  sel=null; history=[]; hpos=-1;
  $('#mapTitle').value=map.title; $('#mapTitle').readOnly=!editable;
  $('#mapTitle').size = Math.max(8, (map.title||'').length + 1);
  render();
  if(editable) map._cloudBase=_cloneObj(_shareePayload(map));   // base AFTER render (coords baked in)
  if(editable) pushHistory();
  showSharedPill(editable);
  // A map you published lives under "Shared by me"; don't also file it as a guest
  // entry (that produced a duplicate sidebar row).
  if(!(typeof _sharedByMeStore==='function' && _sharedByMeStore().some(x=>(x.room||x.id)===id)))
    rememberSharedMap({ id, token, title: map.title, color: map.color });
  _cloudPollSig = JSON.stringify(data);
  startCloudPoll(id);
  let tries=0;
  const rebase=()=>{ if(editable) map._cloudBase=_cloneObj(_shareePayload(map)); };
  const settle=()=>{ if(stage.getBoundingClientRect().width>1){ autoLayout(); fit(); rebase(); map._opening=false; } else if(tries++<60){ requestAnimationFrame(settle); } else { map._opening=false; } };
  requestAnimationFrame(settle);
}

// Leave shared mode WITHOUT a reload: flush a pending save, stop polling, drop the
// banner/read-only state, and clear #shared= from the URL so you can switch straight
// back to "Your maps" in the same session (no browser back button needed).
function exitSharedMode(){
  flushCloudSave();
  stopCloudPoll();
  const ce=document.getElementById('cloudEditBanner'); if(ce) ce.remove();
  const sb=document.getElementById('sharedBanner'); if(sb) sb.remove();
  document.body.classList.remove('cloud-edit','shared-view','no-banner');
  READONLY=false;
  if(typeof CloudStore!=='undefined' && CloudStore.user) showUserPill();   // restore your account pill
  const t=$('#mapTitle'); if(t) t.readOnly=false;
  _cloudPollSig='';
  if((location.hash||'').indexOf('#shared=')===0){
    try{ window.history.replaceState(null,'', location.origin+location.pathname+location.search); }catch(e){}
  }
}
// Open a shared map IN-PLACE from the sidebar - keeps "Your maps" + "Shared with me"
// visible and switchable, the way Overleaf keeps owned and shared projects in one list.
async function openSharedInPlace(id, token){
  if(typeof leaveLiveForSwitch==='function' && !leaveLiveForSwitch()) return false;
  flushPendingSave();          // persist the outgoing map
  exitSharedMode();            // clear any previous shared banner/poll
  showSharedPill(!!token);     // set the shared pill NOW so the username doesn't flash during the fetch
  const data=await _fetchSharedMap(id);
  if(!data){ toast('Couldn\u2019t open the shared map'); if(typeof CloudStore!=='undefined' && CloudStore.user) showUserPill(); return false; }
  _applySharedMap(id, token, data);
  refreshList();               // keep the sidebar populated + highlight the shared row
  try{ window.history.replaceState(null,'', location.origin+location.pathname+'#shared='+id+(token?(':'+token):'')); }catch(e){}
  return true;
}
// On boot: a direct #shared=<id> link opened by someone NOT signed in (external
// recipient) - standalone read-only / edit view, no account needed.
async function tryEnterSharedMap(){
  const mt=(location.hash||'').match(/^#shared=([^:]+)(?::(.+))?$/);
  if(!mt) return false;
  const id=decodeURIComponent(mt[1]);
  const token=mt[2]?decodeURIComponent(mt[2]):null;
  const data=await _fetchSharedMap(id);
  if(!data) return false;
  _applySharedMap(id, token, data);
  window.addEventListener('load', ()=>{ autoLayout(); fit(); if(token) map._cloudBase=_cloneObj(_shareePayload(map)); }, { once:true });
  return true;
}

async function tryEnterLiveSession(){
  const m=(location.hash||'').match(/^#live=(.+)$/);
  if(!m) return false;
  const room=decodeURIComponent(m[1]);
  map={ id:'live-'+room, title:'Live map', color:'#e0613a', rootId:null, nodes:{}, links:[], vars:{}, _ephemeral:true };
  sel=null; history=[]; hpos=-1;
  const t=$('#mapTitle'); if(t) t.value=map.title;
  render();
  Collab.join(room);
  return true;
}

/* ============================================================
   Quote of the day - sidebar footer (cascade: Quotable → ZenQuotes → FavQs → DummyJSON → local)
   ============================================================ */
let _qotdQuotes=null;
function _qotdDayOfYear(d=new Date()){
  const start=new Date(d.getFullYear(),0,0);
  const diff=d - start + ((start.getTimezoneOffset()-d.getTimezoneOffset())*60*1000);
  return Math.floor(diff/86400000);
}
function _qotdRender(q){
  const wrap=$('#qotd'), txt=wrap?.querySelector('.qotd-text'), auth=wrap?.querySelector('.qotd-author');
  if(!wrap||!txt||!auth||!q) return;
  txt.textContent=q.text||''; auth.textContent=q.author||'Unknown';
  wrap.hidden=false;
}
async function _qotdFetch(url, parser){
  try{
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), 4000);
    const r=await fetch(url, {signal:ctrl.signal, cache:'no-store'});
    clearTimeout(t);
    if(!r.ok) throw new Error('http '+r.status);
    const j=await r.json();
    const q=parser(j);
    if(q && q.text && q.text.trim()) return {text:q.text.trim(), author:(q.author||'Unknown').trim()};
  }catch(e){}
  return null;
}
const _qotdParsers = {
  quotable: j=>({text:j.content, author:j.author}),
  zenquotes: j=>Array.isArray(j)&&j[0]?{text:j[0].q, author:j[0].a}:null,
  favqs: j=>j.quote?{text:j.quote.body, author:j.quote.author}:null,
  dummyjson: j=>({text:j.quote, author:j.author}),
  quoteslate: j=>({text:j.quote, author:j.author}),
  stoic: j=>j.data?{text:j.data.quote, author:j.data.author}:null,
  typefit: j=>{
    if(!Array.isArray(j)||!j.length) return null;
    const r=j[Math.floor(Math.random()*j.length)];
    return r?{text:r.text, author:r.author}:null;
  },
  freeapi: j=>j.data?{text:j.data.content, author:j.data.author}:null
};
let _qotdProvidersCache = null;
async function _qotdLoadProviders(){
  if(_qotdProvidersCache) return _qotdProvidersCache;
  // Try external JSON first - lets users add providers without code change (see public/quote-providers.json)
  try{
    const res = await fetch('./quote-providers.json', {cache:'no-store'});
    if(res.ok){
      const raw = await res.json();
      if(Array.isArray(raw) && raw.length){
        const mapped = raw.map(e=>{
          const p = _qotdParsers[e.parser];
          if(!e.url || !p) return null;
          const obj = { url:e.url, parser:p };
          if(e.fallback && e.fallback.url && _qotdParsers[e.fallback.parser]){
            obj.fallback = { url:e.fallback.url, parser:_qotdParsers[e.fallback.parser] };
          }
          return obj;
        }).filter(Boolean);
        if(mapped.length){ _qotdProvidersCache = mapped; return mapped; }
      }
    }
  }catch(e){}
  // Hardcoded fallback - mirrors quote-providers.json so offline / 404 still works
  const fallback = [
    { url:'https://api.quotable.io/random', parser:_qotdParsers.quotable },
    { url:'https://zenquotes.io/api/today', parser:_qotdParsers.zenquotes,
      fallback:{ url:'https://zenquotes.io/api/random', parser:_qotdParsers.zenquotes } },
    { url:'https://favqs.com/api/qotd', parser:_qotdParsers.favqs },
    { url:'https://dummyjson.com/quotes/random', parser:_qotdParsers.dummyjson },
    { url:'https://quoteslate.vercel.app/api/quotes/random', parser:_qotdParsers.quoteslate },
    { url:'https://stoic.tekloon.net/stoic-quote', parser:_qotdParsers.stoic },
    { url:'https://type.fit/api/quotes', parser:_qotdParsers.typefit },
    { url:'https://api.freeapi.app/api/v1/public/quotes/quote/random', parser:_qotdParsers.freeapi }
  ];
  _qotdProvidersCache = fallback;
  return fallback;
}
async function _qotdTryCascade(){
  // Shuffled cascade - providers come from quote-providers.json (or hardcoded fallback),
  // random order per call for diversity; still sequential failover, local quotes.json remains final fallback in loadQotd.
  const providers = await _qotdLoadProviders();
  // Fisher-Yates on a copy - original order untouched, each load/refresh gets different order
  const order = providers.slice();
  for(let i=order.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [order[i],order[j]]=[order[j],order[i]]; }
  for(const p of order){
    let q=await _qotdFetch(p.url, p.parser);
    if(q) return q;
    if(p.fallback){
      q=await _qotdFetch(p.fallback.url, p.fallback.parser);
      if(q) return q;
    }
  }
  return null;
}
async function loadQotd(){
  const wrap=$('#qotd'); if(!wrap) return;
  try{
    // try live cascade first
    const live=await _qotdTryCascade();
    if(live){ _qotdRender(live); }
    else {
      // local fallback - deterministic daily rotation
      if(!_qotdQuotes){
        const res=await fetch('./quotes.json', {cache:'no-store'});
        if(!res.ok) throw new Error('no quotes');
        _qotdQuotes=await res.json();
      }
      if(!Array.isArray(_qotdQuotes)||!_qotdQuotes.length) throw new Error('empty');
      const idx=_qotdDayOfYear()%_qotdQuotes.length;
      _qotdRender(_qotdQuotes[idx]);
    }
    // refresh → try live again, else random local
    $('#qotdRefresh')?.addEventListener('click', async ()=>{
      const r=await _qotdTryCascade();
      if(r) _qotdRender(r);
      else if(_qotdQuotes){
        const rnd=_qotdQuotes[Math.floor(Math.random()*_qotdQuotes.length)];
        _qotdRender(rnd);
      }
    }, {once:false});
  }catch(e){
    wrap.hidden=true;
  }
}
// init after DOM ready (side-foot exists at parse time, but fetch after load)
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', loadQotd);
else loadQotd();

(async()=>{
  // The inline <head> script guesses the auto scale before any page content exists,
  // Re-apply auto-scale now that the DOM is fully laid out. Skip if the pre-paint
  // scale (index.html) already matches what this file's calculation produces -
  // both use the same continuous formula, so they agree unless the viewport
  // changed between the inline script and this point.
  try{
    if(isUiScaleAuto()){
      const _now=getUiScale();
      if(Math.abs((window.__prePaintScale||0)-_now)>0.001) applyUiScale(_now);
    }
  }catch(e){}
  requestAnimationFrame(()=>{ try{ if(isUiScaleAuto()) applyUiScale(getUiScale()); }catch(e){} });
  // Read-only shared link? Decode and render a view-only map - no store, no
  // login, no account needed by the recipient.
  if(await tryEnterLiveSession()) return;
  if(await tryEnterSharedView()) return;
  // A #shared= link: if you're signed in, boot your app first (so "Your maps" + the
  // "Shared with me" library are loaded) and open the shared map IN-PLACE. If you're
  // an external recipient (not signed in), fall back to the standalone shared view.
  const _sh=(location.hash||'').match(/^#shared=([^:]+)(?::(.+))?$/);
  const _openSharedAfterBoot=async()=>{ if(_sh) await openSharedInPlace(decodeURIComponent(_sh[1]), _sh[2]?decodeURIComponent(_sh[2]):null); };
  const {mode, loggedIn} = await initStore();
  if(mode==='cloud'){
    if(loggedIn){ showUserPill(); await proceedBoot(); await _openSharedAfterBoot(); }
    else if(_sh){ _pendingSharedLink={ id:decodeURIComponent(_sh[1]), token:_sh[2]?decodeURIComponent(_sh[2]):null }; showLoginOverlay({ shared:true }); }   // shared link -> require sign-in first
    else { showLoginOverlay(); }
  } else {
    await proceedBoot(); await _openSharedAfterBoot();   // server / local mode
  }
})().catch(e=>{ console.error(e); if(!map) createMap(); });
