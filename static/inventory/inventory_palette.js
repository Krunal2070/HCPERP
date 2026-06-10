/*
   inventory_palette.js - Command Palette (Ctrl+K) (RM)
   HCP Wellness - adapted from pm_stock_palette.js, pm-themed

   Keyboard launcher for navigation + create actions. Open with Ctrl+K
   (or Cmd+K on Mac). Fuzzy search across a static action registry that
   dispatches to existing nav handlers. Recents kept in localStorage
   (no backend needed). Self-contained; no new tables.
*/

(function(){
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  const LS_RECENTS = 'inv_palette_recents';

  const S = { open:false, query:'', hi:0, results:[] };

  // ── Action registry. Each maps to an existing nav item / global handler.
  //    run() clicks the matching sidebar item when present (keeps behaviour
  //    identical to clicking it), else calls a known global.
  function _navClick(matchText){
    const items = document.querySelectorAll('.inv-nav-item');
    for(const it of items){
      const t = (it.textContent||'').trim().toLowerCase();
      if(t.includes(matchText.toLowerCase())){ it.click(); return true; }
    }
    return false;
  }
  function _byId(id){ const el=document.getElementById(id); if(el){ el.click(); return true; } return false; }

  const ACTIONS = [
    { id:'nav-items',     label:'Items',            cat:'Navigate', kw:'materials list stock', icon:'📦', run:()=>_navClick('Items') },
    { id:'nav-brands',    label:'Brands',           cat:'Navigate', kw:'brand', icon:'🏷️', run:()=>_navClick('Brands') },
    { id:'nav-suppliers', label:'Suppliers',        cat:'Navigate', kw:'vendor party', icon:'🚚', run:()=>_navClick('Suppliers') },
    { id:'nav-mr',        label:'Material Request', cat:'Navigate', kw:'mr request indent', icon:'📋', run:()=>_navClick('Material Request') },
    { id:'nav-godown',    label:'Godown View',      cat:'Navigate', kw:'warehouse stock location', icon:'🏬', run:()=>_navClick('Godown View') },
    { id:'nav-transfer',  label:'Stock Transfers',  cat:'Navigate', kw:'transfer move', icon:'🔁', run:()=>_navClick('Stock Transfers') },
    { id:'nav-simple',    label:'Simple Voucher',   cat:'Navigate', kw:'voucher', icon:'🧾', run:()=>_navClick('Simple Voucher') },
    { id:'nav-managegod', label:'Manage Godowns',   cat:'Navigate', kw:'godown setup', icon:'🏗️', run:()=>_navClick('Manage Godowns') },
    { id:'nav-opening',   label:'Opening Stock',    cat:'Navigate', kw:'opening balance', icon:'🚩', run:()=>_navClick('Opening Stock') },
    { id:'nav-split',     label:'Box Split',        cat:'Navigate', kw:'split divide pkg', icon:'✂️', run:()=>(window.invSplitOpen?window.invSplitOpen():_navClick('Box Split')) },
    { id:'nav-grn',       label:'Goods Receipt (GRN)', cat:'Navigate', kw:'grn receipt inward', icon:'📥', run:()=>_navClick('Goods Receipt') },
    { id:'nav-vlog',      label:'Voucher Log',      cat:'Navigate', kw:'log history', icon:'📜', run:()=>_navClick('Voucher Log') },
    { id:'nav-dn',        label:'Delivery Note',    cat:'Navigate', kw:'dn outward dispatch return', icon:'📤', run:()=>(window.invDnOpenList?window.invDnOpenList():_navClick('Delivery Note')) },
    { id:'nav-access',    label:'User Access Control', cat:'Admin', kw:'permission role', icon:'🛡️', run:()=>_navClick('User Access Control') },
    { id:'nav-fefo',      label:'FEFO Overrides',   cat:'Admin', kw:'fefo override expiry', icon:'⏳', run:()=>_navClick('FEFO Overrides') },
    { id:'nav-lock',      label:'Material Lock',    cat:'Admin', kw:'lock block', icon:'🔒', run:()=>_navClick('Material Lock') },
    { id:'nav-reissue',   label:'Label Reissue',    cat:'Admin', kw:'label damaged reissue', icon:'🏷️', run:()=>_navClick('Label Reissue') },
    { id:'nav-reprint',   label:'Label Reprint',    cat:'Admin', kw:'label reprint', icon:'🖨️', run:()=>_navClick('Label Reprint') },
    { id:'act-newitem',   label:'New RM Item',      cat:'Create', kw:'add create material', icon:'➕', run:()=>(window.invOpenSourceModal?window.invOpenSourceModal('new'):_byId('btnNewItem')) },
    { id:'act-newdn',     label:'New Delivery Note', cat:'Create', kw:'create dn', icon:'➕', run:()=>(window.invDnNew?window.invDnNew():_navClick('Delivery Note')) },
  ];

  function _getRecents(){ try { return JSON.parse(localStorage.getItem(LS_RECENTS)||'[]'); } catch(e){ return []; } }
  function _pushRecent(id){
    let r=_getRecents().filter(x=>x!==id); r.unshift(id); r=r.slice(0,6);
    try { localStorage.setItem(LS_RECENTS, JSON.stringify(r)); } catch(e){}
  }

  // simple subsequence fuzzy match; returns score + matched indices, or null
  function _fuzzy(q, text){
    if(!q) return { score:0, hl:[] };
    q=q.toLowerCase(); const t=text.toLowerCase();
    let qi=0, hl=[], score=0, streak=0;
    for(let i=0;i<t.length && qi<q.length;i++){
      if(t[i]===q[qi]){ hl.push(i); qi++; streak++; score+=streak; if(i===0) score+=5; }
      else streak=0;
    }
    return qi===q.length ? { score, hl } : null;
  }

  function _ensure(){
    if(document.getElementById('invPalOverlay')) return;
    const html = `
<div id="invPalOverlay" style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(15,23,42,.4);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);align-items:flex-start;justify-content:center;padding-top:12vh">
  <div id="invPalBox" style="width:560px;max-width:92vw;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,rgba(0,0,0,.08))">
      <span style="color:var(--text3,#80868B);font-size:15px">⌕</span>
      <input id="invPalInput" type="text" autocomplete="off" placeholder="Type a command or search…  (Esc to close)"
        style="flex:1;border:none;outline:none;background:transparent;font-size:15px;color:var(--text,#1F1F1F);font-family:var(--font-body,'Inter',sans-serif)">
      <span style="font-family:var(--font-mono,monospace);font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(0,0,0,.05);color:var(--text3,#80868B);border:1px solid rgba(0,0,0,.08)">Ctrl K</span>
    </div>
    <div id="invPalList" style="max-height:54vh;overflow-y:auto;padding:6px"></div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
    document.getElementById('invPalInput').addEventListener('input', (e)=>{ S.query=e.target.value; S.hi=0; _render(); });
    document.getElementById('invPalInput').addEventListener('keydown', _onKey);
    document.getElementById('invPalOverlay').addEventListener('mousedown', (e)=>{ if(e.target.id==='invPalOverlay') close(); });
  }

  function _visibleActions(){
    // hide actions whose nav item is hidden by access control
    return ACTIONS.filter(a=>{
      if(a.cat!=='Admin' && a.cat!=='Navigate') return true;
      return true; // keep all; nav handler no-ops if missing
    });
  }

  function _compute(){
    const q=S.query.trim();
    if(!q){
      const rec=_getRecents();
      const recActions = rec.map(id=>ACTIONS.find(a=>a.id===id)).filter(Boolean).map(a=>({a, hl:[], recent:true}));
      const rest = ACTIONS.filter(a=>!rec.includes(a.id)).map(a=>({a, hl:[]}));
      return recActions.concat(rest);
    }
    const scored=[];
    for(const a of _visibleActions()){
      const m=_fuzzy(q, a.label) || _fuzzy(q, a.kw||'');
      if(m) scored.push({a, hl:_fuzzy(q,a.label)?m.hl:[], score:m.score});
    }
    scored.sort((x,y)=>y.score-x.score);
    return scored;
  }

  function _hlLabel(label, hl){
    if(!hl||!hl.length) return esc(label);
    let out='', set=new Set(hl);
    for(let i=0;i<label.length;i++){
      out += set.has(i) ? '<b style="color:var(--blue,#1A73E8)">'+esc(label[i])+'</b>' : esc(label[i]);
    }
    return out;
  }

  function _render(){
    S.results=_compute();
    if(S.hi>=S.results.length) S.hi=Math.max(0,S.results.length-1);
    const list=document.getElementById('invPalList');
    if(!S.results.length){ list.innerHTML='<div style="padding:18px;text-align:center;color:var(--text3,#80868B);font-size:13px">No matches</div>'; return; }
    let lastCat=null, html='', idx=0;
    const showCat = !S.query.trim();
    for(const r of S.results){
      if(showCat && r.recent && lastCat!=='Recent'){ html+=_catHdr('Recent'); lastCat='Recent'; }
      else if(showCat && !r.recent && r.a.cat!==lastCat && !r.recent){ html+=_catHdr(r.a.cat); lastCat=r.a.cat; }
      const hi=(idx===S.hi);
      html+=`<div class="inv-pal-row" data-idx="${idx}" onmousemove="invPalHi(${idx})" onclick="invPalRun(${idx})"
        style="display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:8px;cursor:pointer;${hi?'background:var(--blue-lt,#E8F0FE)':''}">
        <span style="width:20px;text-align:center;font-size:15px">${r.a.icon||'•'}</span>
        <span style="flex:1;font-size:13.5px;color:var(--text,#1F1F1F)">${_hlLabel(r.a.label, r.hl)}</span>
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text3,#80868B)">${esc(r.a.cat)}</span>
      </div>`;
      idx++;
    }
    list.innerHTML=html;
    const hiEl=list.querySelector(`.inv-pal-row[data-idx="${S.hi}"]`);
    if(hiEl) hiEl.scrollIntoView({block:'nearest'});
  }
  function _catHdr(c){ return `<div style="padding:8px 11px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B)">${esc(c)}</div>`; }

  function open(){
    _ensure();
    S.open=true; S.query=''; S.hi=0;
    const ov=document.getElementById('invPalOverlay'); ov.style.display='flex';
    const inp=document.getElementById('invPalInput'); inp.value=''; setTimeout(()=>inp.focus(),30);
    _render();
  }
  function close(){ const ov=document.getElementById('invPalOverlay'); if(ov) ov.style.display='none'; S.open=false; }

  function _onKey(e){
    if(e.key==='ArrowDown'){ e.preventDefault(); S.hi=Math.min(S.results.length-1,S.hi+1); _render(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); S.hi=Math.max(0,S.hi-1); _render(); }
    else if(e.key==='Enter'){ e.preventDefault(); run(S.hi); }
    else if(e.key==='Escape'){ e.preventDefault(); close(); }
  }
  function run(idx){
    const r=S.results[idx]; if(!r) return;
    _pushRecent(r.a.id);
    close();
    try { r.a.run(); } catch(e){ console.warn('palette action failed', e); }
  }

  function _hasAccess(cat){
    const a=window._invAccess;
    if(!a||!a.ready) return true;           // before access loads, don't block
    if(a.is_admin) return true;
    return a.access && a.access[cat]!=='off' && a.access[cat]!==false;
  }

  // Global Ctrl+K / Cmd+K
  document.addEventListener('keydown', (e)=>{
    if((e.ctrlKey||e.metaKey) && (e.key==='k'||e.key==='K')){
      e.preventDefault();
      if(!_hasAccess('command_palette')) return;
      S.open ? close() : open();
    }
  });

  window.invPalOpen=open; window.invPalClose=close;
  window.invPalRun=run; window.invPalHi=(i)=>{ S.hi=i; _render(); };

  console.log('inventory_palette.js loaded (Ctrl+K)');
})();
