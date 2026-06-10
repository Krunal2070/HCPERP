/*
   inventory_dock.js - Floating Dock / movable navbar (RM)
   HCP Wellness - adapted from pm_stock_dock.js (simplified per spec)

   A floating bar the user can DRAG anywhere and PIN in place. Width fits its
   contents (quick-action chips + a search button that opens the Command
   Palette). Position + pin state persist in localStorage (no backend).

   Reuses the Command Palette's action set (inventory_palette.js) so there's
   one source of truth for what the chips do.
*/

(function(){
  'use strict';

  const LS_POS = 'inv_dock_pos';     // {x,y,pinned}
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });

  // Quick chips shown on the dock (id must exist as a sidebar nav match / global)
  const CHIPS = [
    { label:'Items',    icon:'📦', run:()=>_navClick('Items') },
    { label:'GRN',      icon:'📥', run:()=>_navClick('Goods Receipt') },
    { label:'Transfers',icon:'🔁', run:()=>_navClick('Stock Transfers') },
    { label:'Box Split',icon:'✂️', run:()=>(window.invSplitOpen?window.invSplitOpen():_navClick('Box Split')) },
    { label:'Delivery', icon:'📤', run:()=>(window.invDnOpenList?window.invDnOpenList():_navClick('Delivery Note')) },
  ];

  function _navClick(matchText){
    const items=document.querySelectorAll('.inv-nav-item');
    for(const it of items){ if((it.textContent||'').trim().toLowerCase().includes(matchText.toLowerCase())){ it.click(); return; } }
  }

  function _loadPos(){ try { return JSON.parse(localStorage.getItem(LS_POS)||'null'); } catch(e){ return null; } }
  function _savePos(p){ try { localStorage.setItem(LS_POS, JSON.stringify(p)); } catch(e){} }

  function _mount(){
    if(document.getElementById('invDock')) return;
    const dock=document.createElement('div');
    dock.id='invDock';
    dock.style.cssText=[
      'position:fixed','z-index:7000','top:74px','left:50%','transform:translateX(-50%)',
      'display:inline-flex','align-items:center','gap:6px','width:max-content','max-width:94vw',
      'padding:6px 8px','background:linear-gradient(180deg,#ffffff,#f6f7fb)',
      'border:1px solid var(--nb-border-strong,rgba(70,72,212,.16))','border-radius:14px',
      'box-shadow:0 10px 30px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.08),inset 0 1px 0 rgba(255,255,255,.9)',
      'font-family:var(--font-body,Inter,sans-serif)','user-select:none','cursor:default'
    ].join(';');

    // drag handle
    let chips = CHIPS.map((c,i)=>
      `<button class="inv-dock-chip" data-i="${i}" title="${esc(c.label)}"
        style="display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:9px;border:1px solid rgba(70,72,212,.14);
               background:linear-gradient(180deg,#fff,#f4f5f9);color:var(--nb-text-muted,#444746);font-size:12px;font-weight:600;cursor:pointer;
               box-shadow:0 1px 2px rgba(15,23,42,.06),inset 0 1px 0 rgba(255,255,255,.9);transition:transform .14s,box-shadow .18s,color .14s,border-color .14s">
        <span style="font-size:13px">${c.icon}</span><span class="inv-dock-lbl">${esc(c.label)}</span></button>`
    ).join('');

    dock.innerHTML =
      `<span id="invDockGrip" title="Drag to move" style="cursor:grab;color:var(--text3,#80868B);font-size:14px;padding:0 4px;letter-spacing:-2px">⋮⋮</span>
       <div id="invDockSearchWrap" style="position:relative">
         <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text3,#80868B);font-size:12px;pointer-events:none">⌕</span>
         <input id="invDockSearch" type="text" autocomplete="off" spellcheck="false" placeholder="Search…  (/)"
           style="width:170px;padding:7px 10px 7px 26px;border-radius:9px;border:1px solid rgba(70,72,212,.14);background:var(--white,#fff);color:var(--text,#1F1F1F);font-size:12px;outline:none;box-shadow:inset 0 1px 2px rgba(15,23,42,.05)">
         <div id="invDockResults" style="display:none;position:absolute;top:calc(100% + 5px);left:0;width:260px;max-height:280px;overflow-y:auto;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.16);z-index:10"></div>
       </div>
       <span style="width:1px;height:20px;background:rgba(0,0,0,.1);margin:0 2px"></span>
       ${chips}
       <span style="width:1px;height:20px;background:rgba(0,0,0,.1);margin:0 2px"></span>
       <button id="invDockPin" title="Pin in place" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid rgba(70,72,212,.14);background:linear-gradient(180deg,#fff,#f4f5f9);cursor:pointer;font-size:14px;box-shadow:0 1px 2px rgba(15,23,42,.06)">📍</button>`;

    document.body.appendChild(dock);

    // wire chips
    dock.querySelectorAll('.inv-dock-chip').forEach(btn=>{
      btn.addEventListener('click',()=>{ const i=+btn.dataset.i; try{ CHIPS[i].run(); }catch(e){} });
      btn.addEventListener('mouseenter',()=>{ btn.style.transform='translateY(-2px)'; btn.style.borderColor='var(--nb-primary,#4648D4)'; btn.style.color='var(--nb-primary,#4648D4)'; });
      btn.addEventListener('mouseleave',()=>{ btn.style.transform=''; btn.style.borderColor='rgba(70,72,212,.14)'; btn.style.color='var(--nb-text-muted,#444746)'; });
    });
    document.getElementById('invDockPin').addEventListener('click', _togglePin);
    _wireSearch();

    _restorePos();
    _enableDrag(dock);
  }

  // ── Global search: queries the backend across materials + vouchers
  //    (GRN / DN / Transfer / MR) AND matches screens locally. Like pm.
  function _searchScreens(q){
    const out=[];
    document.querySelectorAll('.inv-nav-item').forEach(it=>{
      const label=(it.textContent||'').trim();
      if(label){ const s=_fuzzy(q,label); if(s>=0) out.push({kind:'screen', label, el:it, _s:s}); }
    });
    out.sort((a,b)=>b._s-a._s);
    return out.slice(0,4);
  }
  function _fuzzy(q,text){
    q=q.toLowerCase(); const t=String(text||'').toLowerCase();
    let qi=0,score=0,streak=0;
    for(let i=0;i<t.length&&qi<q.length;i++){
      if(t[i]===q[qi]){ qi++; streak++; score+=streak; if(i===0) score+=5; } else streak=0;
    }
    return qi===q.length?score:-1;
  }

  const VKIND = {
    grn:      {icon:'📥', label:'GRN'},
    dn:       {icon:'📤', label:'Delivery Note'},
    transfer: {icon:'🔁', label:'Transfer'},
    mr:       {icon:'📋', label:'Material Request'},
  };

  let _dockHi=0, _dockRes=[], _searchTimer=null, _searchSeq=0;
  function _wireSearch(){
    const inp=document.getElementById('invDockSearch');
    const dd=document.getElementById('invDockResults');
    if(!inp) return;
    inp.addEventListener('input',()=>{ _dockHi=0; _onSearchInput(); });
    inp.addEventListener('focus',()=>{ if(inp.value.trim()) _onSearchInput(); });
    inp.addEventListener('blur',()=> setTimeout(()=>{ dd.style.display='none'; },150));
    inp.addEventListener('keydown',(e)=>{
      if(e.key==='ArrowDown'){ e.preventDefault(); _dockHi=Math.min(_dockRes.length-1,_dockHi+1); _paint(); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); _dockHi=Math.max(0,_dockHi-1); _paint(); }
      else if(e.key==='Enter'){ e.preventDefault(); _runResult(_dockHi); }
      else if(e.key==='Escape'){ inp.value=''; dd.style.display='none'; inp.blur(); }
    });
  }
  function _onSearchInput(){
    const inp=document.getElementById('invDockSearch');
    const dd=document.getElementById('invDockResults');
    const q=(inp.value||'').trim();
    if(!q){ dd.style.display='none'; _dockRes=[]; return; }
    // show screen matches immediately; fetch data (debounced)
    _dockRes = _searchScreens(q);
    _paint(q.length<2 ? 'Type 2+ chars to search data…' : 'Searching…');
    if(q.length<2) return;
    clearTimeout(_searchTimer);
    const seq=++_searchSeq;
    _searchTimer=setTimeout(async ()=>{
      try {
        const r=await fetch('/api/inventory_mgmt/global_search?q='+encodeURIComponent(q));
        if(seq!==_searchSeq) return; // a newer keystroke superseded this one
        if(!r.ok){
          // 404 = endpoint missing (Flask not restarted); show screens only.
          _dockRes=_searchScreens(q);
          _paint(r.status===404 ? 'Data search unavailable (restart server)' : 'Search error '+r.status);
          return;
        }
        let j;
        try { j=await r.json(); } catch(parseErr){ _dockRes=_searchScreens(q); _paint('Bad search response'); return; }
        if(seq!==_searchSeq) return;
        const mats=(j.materials||[]).map(m=>({kind:'material', label:m.name, id:m.id, uom:m.uom}));
        const vouchers=(j.vouchers||[]).map(v=>({kind:'voucher', vkind:v.kind, label:v.voucher_no, id:v.id, detail1:v.detail1, detail2:v.detail2}));
        _dockRes=_searchScreens(q).concat(mats).concat(vouchers);
        _paint();
      } catch(e){ if(seq===_searchSeq){ _dockRes=_searchScreens(q); _paint('Search failed: '+e.message); } }
    }, 180);
  }
  function _paint(placeholderMsg){
    const dd=document.getElementById('invDockResults');
    if(!dd) return;
    if(!_dockRes.length){
      dd.innerHTML='<div style="padding:10px 12px;color:var(--text3,#80868B);font-size:12px">'+esc(placeholderMsg||'No matches')+'</div>';
      dd.style.display='block'; return;
    }
    if(_dockHi>=_dockRes.length) _dockHi=_dockRes.length-1;
    dd.innerHTML=_dockRes.map((r,i)=>{
      const hi=(i===_dockHi); const bg=hi?'background:var(--blue-lt,#E8F0FE);':'';
      if(r.kind==='screen'){
        return `<div data-i="${i}" style="padding:8px 12px;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:8px;${bg}">
          <span style="font-size:11px">↪</span><span style="flex:1">${esc(r.label)}</span>
          <span style="font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B)">Screen</span></div>`;
      }
      if(r.kind==='material'){
        return `<div data-i="${i}" style="padding:8px 12px;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:8px;${bg}">
          <span style="font-size:11px">📦</span><span style="flex:1">${esc(r.label)}</span>
          <span style="font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B)">Item</span></div>`;
      }
      // voucher
      const meta=VKIND[r.vkind]||{icon:'•',label:r.vkind};
      const sub=[r.detail1, r.detail2].filter(Boolean).join(' · ');
      return `<div data-i="${i}" style="padding:8px 12px;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:8px;${bg}">
        <span style="font-size:11px">${meta.icon}</span>
        <span style="flex:1"><div style="font-family:var(--font-mono,monospace);font-weight:600">${esc(r.label)}</div>${sub?`<div style="font-size:10px;color:var(--text2,#5F6368)">${esc(sub)}</div>`:''}</span>
        <span style="font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B)">${esc(meta.label)}</span></div>`;
    }).join('');
    dd.querySelectorAll('div[data-i]').forEach(el=>{
      el.addEventListener('mousedown',(ev)=>{ ev.preventDefault(); _runResult(+el.dataset.i); });
      el.addEventListener('mousemove',()=>{ _dockHi=+el.dataset.i; });
    });
    dd.style.display='block';
  }
  function _runResult(i){
    const r=_dockRes[i]; if(!r) return;
    const inp=document.getElementById('invDockSearch');
    const dd=document.getElementById('invDockResults');
    if(r.kind==='screen'){
      try { r.el.click(); } catch(e){}
    } else if(r.kind==='material'){
      // Open the item's own page (edit/detail), not just type into search.
      try {
        const itemsNav=Array.from(document.querySelectorAll('.inv-nav-item'))
          .find(n=>(n.textContent||'').trim().toLowerCase().includes('items'));
        if(itemsNav) itemsNav.click();
        // give the Items panel a moment to mount, then open the item page.
        setTimeout(()=>{
          if(typeof window.invOpenSourceModal==='function'){
            try { window.invOpenSourceModal('edit', r.id); return; } catch(e){}
          }
          // fallback: at least filter the list to it
          const box=document.getElementById('itemSearch') || document.querySelector('input[placeholder*="Search items" i]');
          if(box){ box.value=r.label; box.dispatchEvent(new Event('input',{bubbles:true})); box.focus(); }
        },220);
      } catch(e){}
    } else if(r.kind==='voucher'){
      _openVoucher(r);
    }
    inp.value=''; dd.style.display='none'; inp.blur();
  }
  function _openVoucher(r){
    // Route to the right screen/handler by voucher kind, opening the
    // specific voucher where a handler exists.
    try {
      if(r.vkind==='dn'){
        if(window.invDnOpenDetail) return window.invDnOpenDetail(r.id);
        if(window.invDnOpenList) return window.invDnOpenList();
      }
      if(r.vkind==='grn'){
        _navClick('Goods Receipt');
        // give the GRN screen a moment to mount, then open the exact GRN
        setTimeout(function(){ if(window.invGrnOpenById) window.invGrnOpenById(r.id); }, 250);
        return;
      }
      if(r.vkind==='transfer'){
        _navClick('Stock Transfers');
        // open the exact transfer once the screen is up
        setTimeout(function(){ if(window.invTrOpenExisting) window.invTrOpenExisting(r.id); }, 250);
        return;
      }
      if(r.vkind==='mr'){
        _navClick('Material Request');
        // open the exact request once the screen is up
        setTimeout(function(){ if(window.invMROpenDetail) window.invMROpenDetail(r.id); }, 250);
        return;
      }
    } catch(e){}
  }

  let _pinned=false;
  function _restorePos(){
    const p=_loadPos(); const dock=document.getElementById('invDock');
    if(p && typeof p.x==='number'){
      dock.style.left=p.x+'px'; dock.style.top=p.y+'px'; dock.style.transform='none';
    }
    _pinned=!!(p&&p.pinned); _reflectPin();
  }
  function _reflectPin(){
    const b=document.getElementById('invDockPin'); const grip=document.getElementById('invDockGrip');
    if(!b) return;
    b.textContent=_pinned?'📌':'📍';
    b.title=_pinned?'Pinned — click to unpin':'Pin in place';
    b.style.background=_pinned?'linear-gradient(180deg,#e8f0fe,#d7e6fd)':'linear-gradient(180deg,#fff,#f4f5f9)';
    b.style.borderColor=_pinned?'rgba(26,115,232,.4)':'rgba(70,72,212,.14)';
    if(grip){ grip.style.cursor=_pinned?'not-allowed':'grab'; grip.style.opacity=_pinned?'.4':'1'; }
  }
  function _togglePin(){
    _pinned=!_pinned; _reflectPin();
    const dock=document.getElementById('invDock');
    const r=dock.getBoundingClientRect();
    _savePos({x:r.left, y:r.top, pinned:_pinned});
  }

  function _enableDrag(dock){
    const grip=document.getElementById('invDockGrip');
    let sx,sy,ox,oy,dragging=false;
    function down(e){
      if(_pinned) return;
      dragging=true; grip.style.cursor='grabbing';
      const r=dock.getBoundingClientRect();
      dock.style.transform='none'; dock.style.left=r.left+'px'; dock.style.top=r.top+'px';
      const pt=e.touches?e.touches[0]:e;
      sx=pt.clientX; sy=pt.clientY; ox=r.left; oy=r.top;
      e.preventDefault();
      document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
      document.addEventListener('touchmove',move,{passive:false}); document.addEventListener('touchend',up);
    }
    function move(e){
      if(!dragging) return;
      const pt=e.touches?e.touches[0]:e;
      let nx=ox+(pt.clientX-sx), ny=oy+(pt.clientY-sy);
      const w=dock.offsetWidth, h=dock.offsetHeight;
      nx=Math.max(4, Math.min(window.innerWidth-w-4, nx));
      ny=Math.max(4, Math.min(window.innerHeight-h-4, ny));
      dock.style.left=nx+'px'; dock.style.top=ny+'px';
      e.preventDefault();
    }
    function up(){
      if(!dragging) return; dragging=false; grip.style.cursor='grab';
      const r=dock.getBoundingClientRect();
      _savePos({x:r.left, y:r.top, pinned:_pinned});
      document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up);
      document.removeEventListener('touchmove',move); document.removeEventListener('touchend',up);
    }
    grip.addEventListener('mousedown',down);
    grip.addEventListener('touchstart',down,{passive:false});
  }

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;            // before access loads, allow
    if(a.is_admin) return true;
    return a.access && a.access.floating_dock!=='off' && a.access.floating_dock!==false;
  }
  function _applyAccess(){
    const d=document.getElementById('invDock');
    if(_hasAccess()){ if(!d) _mount(); }
    else if(d){ d.remove(); }
  }
  document.addEventListener('inv-access-ready', _applyAccess);

  function _boot(){ if(_hasAccess()) _mount(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invDockReset=function(){ try{localStorage.removeItem(LS_POS);}catch(e){} const d=document.getElementById('invDock'); if(d) d.remove(); _mount(); };
  console.log('inventory_dock.js loaded');
})();
