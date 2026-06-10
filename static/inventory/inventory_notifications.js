/* ════════════════════════════════════════════════════════════════════════
   inventory_notifications.js — Notification bell + persistent log (RM)
   HCP Wellness
   ────────────────────────────────────────────────────────────────────────
   A topbar bell that surfaces the dashboard's tasks & alerts as a rolling,
   database-backed notification log:

     • Bell button (with an unread count badge) lives in the topbar.
     • Clicking it opens a dropdown of current notifications; each row links
       to the page/report that resolves it (reusing the dashboard's openers).
     • "See all" opens a full history modal (active + resolved), also linked.
     • Read-state is per-user; counts refresh without duplicating rows.

   Backend (in inventory_reports.py):
     POST /api/inventory_mgmt/notifications/sync        — recompute + upsert
     GET  /api/inventory_mgmt/notifications/list?scope= — active | all
     POST /api/inventory_mgmt/notifications/read        — {id} | {all:true}

   Self-contained: injects its own bell, dropdown, styles, and history modal.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : null);

  const API = '/api/inventory_mgmt/notifications';
  const POLL_MS = 90000;            // background re-sync cadence

  let _items   = [];                 // active notifications (for the dropdown)
  let _unread  = 0;
  let _open    = false;
  let _pollTimer = null;
  let _syncing = false;

  /* ── link_key → opener (mirrors the dashboard's deep-link map) ─────────── */
  function _openLink(linkKey){
    // Approvals / module tabs open their own panels; stock alerts open a report.
    const viaFn = {
      material_requests:    'invMRActivate',
      transfers_in_transit: 'invStmActivate',
      simple_in_transit:    'invStmActivate',
      fefo_overrides:       'invFefoOpen',
      label_reprints:       'invReprintOpen',
      label_reissues:       'invReissueOpen',
    };
    const viaReport = {
      below_msl:      'reorder',
      zero_stock:     'negzero',
      negative_stock: 'negzero',
      expiring_30:    'expiry',
      expired:        'expiry',
      expiry:         'expiry',   // agent's 60-day expiry warning
    };
    // Direct openers (no report): audit hub for the "audit overdue" notice.
    const viaDirect = {
      audit: 'invAuditOpenHub',
    };
    if(viaDirect[linkKey]){
      const fn = window[viaDirect[linkKey]];
      if(typeof fn === 'function'){ try{ fn(); }catch(e){ toast('Could not open that item','error'); } }
      else { toast('That feature is not available','info'); }
      return;
    }
    if(viaFn[linkKey]){
      const fn = window[viaFn[linkKey]];
      if(typeof fn === 'function'){ try{ fn(); }catch(e){ toast('Could not open that item','error'); } }
      else { toast('That feature is not available','info'); }
      return;
    }
    if(viaReport[linkKey]){
      if(typeof window.invReportsOpen === 'function'){
        window.invReportsOpen();
        setTimeout(()=>{ if(typeof window.invReportsPick==='function') window.invReportsPick(viaReport[linkKey]); }, 120);
      } else { toast('Reports module not available','error'); }
      return;
    }
    // Unknown / no link — fall back to the Home dashboard if present.
    if(typeof window.invDashboardOpen === 'function') window.invDashboardOpen();
  }

  const SEV = {
    info:  { color:'#1A73E8', bg:'#E8F0FE', icon:'fa-circle-info' },
    warn:  { color:'#B06000', bg:'#FEF7E0', icon:'fa-triangle-exclamation' },
    error: { color:'#C5221F', bg:'#FCE8E6', icon:'fa-circle-exclamation' },
  };

  /* ── Styles (scoped, theme-token aware) ───────────────────────────────── */
  function _injectStyles(){
    if($('inv-notif-styles')) return;
    const st = document.createElement('style');
    st.id = 'inv-notif-styles';
    st.textContent = `
      .inv-notif-wrap{ position:relative; display:inline-flex; }
      .inv-notif-bell{ position:relative; }
      .inv-notif-badge{ position:absolute; top:-3px; right:-3px; min-width:17px; height:17px;
        padding:0 4px; border-radius:9px; background:#C5221F; color:#fff; font-size:10px;
        font-weight:800; line-height:17px; text-align:center; box-shadow:0 0 0 2px var(--card,#fff); }
      .inv-notif-pop{ position:absolute; top:calc(100% + 8px); right:0; width:360px; max-width:92vw;
        background:var(--card,#fff); border:1px solid var(--border,rgba(0,0,0,.12)); border-radius:14px;
        box-shadow:0 16px 44px rgba(0,0,0,.18); z-index:1600; overflow:hidden; display:none; }
      .inv-notif-pop.show{ display:block; }
      .inv-notif-head{ display:flex; align-items:center; gap:8px; padding:12px 14px;
        border-bottom:1px solid var(--border2,rgba(0,0,0,.07)); }
      .inv-notif-head .ttl{ font-size:13px; font-weight:800; color:var(--text,#1F1F1F); }
      .inv-notif-head .sp{ flex:1; }
      .inv-notif-head .lnk{ font-size:11.5px; font-weight:700; color:var(--brand,#1A73E8);
        cursor:pointer; background:none; border:none; padding:3px 4px; }
      .inv-notif-head .lnk:hover{ text-decoration:underline; }
      .inv-notif-list{ max-height:62vh; overflow-y:auto; }
      .inv-notif-row{ display:flex; gap:10px; padding:11px 14px; cursor:pointer;
        border-bottom:1px solid var(--border2,rgba(0,0,0,.05)); transition:background .12s; }
      .inv-notif-row:hover{ background:var(--surface2,#FAF9F5); }
      .inv-notif-row.unread{ background:rgba(26,115,232,.06); }
      .inv-notif-row.unread:hover{ background:rgba(26,115,232,.10); }
      .inv-notif-ic{ width:30px; height:30px; border-radius:8px; flex:0 0 auto;
        display:flex; align-items:center; justify-content:center; font-size:13px; }
      .inv-notif-bd{ min-width:0; flex:1; }
      .inv-notif-bd .t{ font-size:12.5px; font-weight:700; color:var(--text,#1F1F1F);
        display:flex; align-items:center; gap:6px; }
      .inv-notif-bd .cnt{ font-size:10.5px; font-weight:800; color:#fff; background:#C5221F;
        border-radius:9px; padding:0 6px; line-height:15px; }
      .inv-notif-bd .s{ font-size:11px; color:var(--text3,#80868B); margin-top:1px; }
      .inv-notif-bd .when{ font-size:10px; color:var(--text3,#80868B); margin-top:2px; }
      .inv-notif-dot{ width:8px; height:8px; border-radius:50%; background:var(--brand,#1A73E8);
        flex:0 0 auto; align-self:center; }
      .inv-notif-empty{ padding:26px 14px; text-align:center; color:var(--text3,#80868B); font-size:12.5px; }
      .inv-notif-foot{ padding:9px 14px; text-align:center; border-top:1px solid var(--border2,rgba(0,0,0,.07)); }
      .inv-notif-foot button{ font-size:12px; font-weight:700; color:var(--brand,#1A73E8);
        background:none; border:none; cursor:pointer; }
      .inv-notif-foot button:hover{ text-decoration:underline; }
      .inv-notif-resolved{ opacity:.55; }
      .inv-notif-badge2{ font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.04em;
        padding:1px 6px; border-radius:7px; }
    `;
    document.head.appendChild(st);
  }

  /* ── Bell mount (topbar, before the user pill) ────────────────────────── */
  function _mountBell(){
    if($('invNotifWrap')) return;
    const right = document.querySelector('.topbar .topbar-right');
    if(!right) return;
    const wrap = document.createElement('div');
    wrap.className = 'inv-notif-wrap';
    wrap.id = 'invNotifWrap';
    wrap.innerHTML = `
      <button class="icon-btn inv-notif-bell" id="invNotifBell" title="Notifications" aria-label="Notifications">
        <i class="fas fa-bell"></i>
        <span class="inv-notif-badge" id="invNotifBadge" style="display:none">0</span>
      </button>
      <div class="inv-notif-pop" id="invNotifPop" role="menu" aria-label="Notifications"></div>`;
    // Place the bell just before the user pill (or first child as fallback).
    const pill = right.querySelector('.user-pill');
    if(pill) right.insertBefore(wrap, pill); else right.insertBefore(wrap, right.firstChild);

    $('invNotifBell').addEventListener('click', (e)=>{ e.stopPropagation(); _toggle(); });
    document.addEventListener('click', (e)=>{
      if(_open && !wrap.contains(e.target)) _close();
    });
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && _open) _close(); });
  }

  function _toggle(){ _open ? _close() : _openPop(); }
  function _openPop(){
    const pop = $('invNotifPop'); if(!pop) return;
    _open = true; pop.classList.add('show');
    _renderPop();
    // Re-sync on open so the badge & list are fresh.
    _sync();
  }
  function _close(){ _open=false; const pop=$('invNotifPop'); if(pop) pop.classList.remove('show'); }

  function _fmtWhen(s){
    if(!s) return '';
    // s like 'YYYY-MM-DD HH:MM:SS' → DD/MM/YYYY HH:MM
    const m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s));
    if(!m) return esc(s);
    return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  }

  function _rowHtml(n, opts){
    opts = opts || {};
    const sev = SEV[n.severity] || SEV.info;
    const unread = (n.status==='active' && !n.is_read);
    const resolved = (n.status==='resolved');
    const cnt = n.count>1 ? `<span class="cnt">${n.count}</span>` : '';
    return `<div class="inv-notif-row ${unread?'unread':''} ${resolved?'inv-notif-resolved':''}"
                 data-id="${n.id}" data-link="${esc(n.link_key)}">
      <div class="inv-notif-ic" style="background:${sev.bg};color:${sev.color}"><i class="fas ${sev.icon}"></i></div>
      <div class="inv-notif-bd">
        <div class="t">${esc(n.title)} ${cnt}
          ${resolved?'<span class="inv-notif-badge2" style="background:var(--green-lt,#E6F4EA);color:var(--green,#137333)">resolved</span>':''}
        </div>
        ${n.body?`<div class="s">${esc(n.body)}</div>`:''}
        <div class="when">${_fmtWhen(n.seen_at || n.created_at)}</div>
      </div>
      ${unread?'<span class="inv-notif-dot"></span>':''}
    </div>`;
  }

  function _renderPop(){
    const pop = $('invNotifPop'); if(!pop) return;
    const rows = _items.length
      ? _items.map(n=>_rowHtml(n)).join('')
      : `<div class="inv-notif-empty"><i class="fas fa-circle-check" style="color:var(--green,#137333)"></i>
           &nbsp;You're all caught up — no active notifications.</div>`;
    pop.innerHTML = `
      <div class="inv-notif-head">
        <span class="ttl">Notifications</span>
        <span class="sp"></span>
        <button class="lnk" id="invNotifMarkAll">Mark all read</button>
      </div>
      <div class="inv-notif-list">${rows}</div>
      <div class="inv-notif-foot"><button id="invNotifSeeAll">See all notifications</button></div>`;
    // Wire rows
    pop.querySelectorAll('.inv-notif-row').forEach(el=>{
      el.addEventListener('click', ()=>{
        const id = parseInt(el.getAttribute('data-id'),10);
        const link = el.getAttribute('data-link');
        _markRead(id);
        _close();
        _openLink(link);
      });
    });
    const ma = $('invNotifMarkAll'); if(ma) ma.addEventListener('click', (e)=>{ e.stopPropagation(); _markAll(); });
    const sa = $('invNotifSeeAll'); if(sa) sa.addEventListener('click', (e)=>{ e.stopPropagation(); _close(); _openHistory(); });
  }

  function _updateBadge(){
    const b = $('invNotifBadge'); if(!b) return;
    if(_unread > 0){ b.textContent = _unread>99?'99+':String(_unread); b.style.display=''; }
    else { b.style.display='none'; }
  }

  /* ── Data ─────────────────────────────────────────────────────────────── */
  async function _sync(){
    if(_syncing) return;
    _syncing = true;
    try{
      // Fire the agent check first (it logs its pending items into the same
      // store under the 'agent:' namespace). Best-effort and in parallel — we
      // don't block the dashboard sync on it.
      const agentPing = fetch('/api/inventory_mgmt/agent/pending', {credentials:'same-origin'})
        .catch(()=>{});
      // Dashboard sync recomputes task:/alert: rows AND returns the merged list.
      const r = await fetch(API+'/sync', {method:'POST', credentials:'same-origin'});
      const j = await r.json();
      if(j.status==='ok'){ _items=j.items||[]; _unread=j.unread||0; _updateBadge(); if(_open) _renderPop(); }
      // If the agent logged anything new after our list call, pull a fresh list.
      await agentPing;
      try{
        const r2 = await fetch(API+'/list?scope=active', {credentials:'same-origin'});
        const j2 = await r2.json();
        if(j2.status==='ok'){ _items=j2.items||[]; _unread=j2.unread||0; _updateBadge(); if(_open) _renderPop(); }
      }catch(e){}
    }catch(e){ /* silent — bell just won't update this cycle */ }
    finally{ _syncing = false; }
  }

  async function _markRead(id){
    if(!id) return;
    // optimistic
    const n=_items.find(x=>x.id===id); if(n && !n.is_read){ n.is_read=true; _unread=Math.max(0,_unread-1); _updateBadge(); if(_open) _renderPop(); }
    try{ await fetch(API+'/read', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({id})}); }catch(e){}
  }
  async function _markAll(){
    _items.forEach(n=>{ n.is_read=true; }); _unread=0; _updateBadge(); if(_open) _renderPop();
    try{ await fetch(API+'/read', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({all:true})}); }catch(e){}
  }

  /* ── History modal (all notifications, active + resolved) ─────────────── */
  function _ensureHistory(){
    if($('invNotifHistModal')) return;
    const html = `
<div class="modal-overlay" id="invNotifHistModal">
  <div class="modal-card" style="max-width:92vw;width:680px">
    <div class="modal-head">
      <div class="modal-title"><span>🔔</span> <span>Notification history</span></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="invNotifHistRefresh" title="Refresh"><i class="fas fa-rotate"></i></button>
        <button class="modal-close" id="invNotifHistClose">&times;</button>
      </div>
    </div>
    <div class="modal-body" id="invNotifHistBody" style="padding:0">
      <div style="padding:30px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
    const ov=$('invNotifHistModal');
    ov.addEventListener('click',(e)=>{ if(e.target===ov) _closeHistory(); });
    $('invNotifHistClose').addEventListener('click', _closeHistory);
    $('invNotifHistRefresh').addEventListener('click', _loadHistory);
  }
  function _openHistory(){ _ensureHistory(); $('invNotifHistModal').classList.add('show'); _loadHistory(); }
  function _closeHistory(){ const ov=$('invNotifHistModal'); if(ov) ov.classList.remove('show'); }

  async function _loadHistory(){
    const body=$('invNotifHistBody'); if(body) body.innerHTML='<div style="padding:30px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>';
    try{
      const r=await fetch(API+'/list?scope=all', {credentials:'same-origin'});
      const j=await r.json();
      if(j.status!=='ok'){ if(body) body.innerHTML='<div style="padding:24px;color:#C5221F">'+esc(j.message||'Failed to load')+'</div>'; return; }
      const list=j.items||[];
      if(!list.length){ if(body) body.innerHTML='<div class="inv-notif-empty">No notifications recorded yet.</div>'; return; }
      const rows=list.map(n=>_rowHtml(n)).join('');
      if(body){
        body.innerHTML=`<div class="inv-notif-list" style="max-height:70vh">${rows}</div>`;
        body.querySelectorAll('.inv-notif-row').forEach(el=>{
          el.addEventListener('click', ()=>{
            const id=parseInt(el.getAttribute('data-id'),10);
            const link=el.getAttribute('data-link');
            _markRead(id);
            _closeHistory();
            _openLink(link);
          });
        });
      }
      // Opening history is a good moment to refresh the bell too.
      _sync();
    }catch(e){ if(body) body.innerHTML='<div style="padding:24px;color:#C5221F">'+esc(e.message)+'</div>'; }
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  function _boot(){
    _injectStyles();
    _mountBell();
    _sync();
    if(_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(_sync, POLL_MS);
  }

  // Expose for other modules / manual refresh.
  window.invNotifSync   = _sync;
  window.invNotifOpen   = _openPop;
  window.invNotifHistory= _openHistory;

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();
  console.log('inventory_notifications.js loaded');
})();
