/* ═══════════════════════════════════════════════════════════════════════
   inventory_fefo.js — FEFO Override Approvals  (Inventory Phase 3)
   HCP Wellness · adapted from pm_stock_fifo_override.js
   ───────────────────────────────────────────────────────────────────────
   Admin reviews FEFO-violation override requests (approve/reject). Any user
   can view their own requests. Gated behind the 'fefo_override' access
   category; admins always have access.

   A self-injecting "⏳ FEFO Overrides" sidebar item opens the modal. A badge
   shows the pending count for approvers.

   Backend: inventory_fefo.py → /api/inventory_mgmt/fefo/override/*
   =================================================================== */

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const API = '/api/inventory_mgmt/fefo/override';

  const F = { requests:[], canApprove:false, filter:'pending' };

  function pill(st){
    const map = {
      pending:  ['#92400e','rgba(217,119,6,.14)','Pending'],
      approved: ['#0f766e','rgba(13,148,136,.14)','Approved'],
      used:     ['#475569','rgba(100,116,139,.16)','Used'],
      rejected: ['#991b1b','rgba(220,38,38,.12)','Rejected'],
    };
    const [fg,bg,txt] = map[st] || ['#374151','#eee',st];
    return `<span style="padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;color:${fg};background:${bg}">${txt}</span>`;
  }
  const fdt = (s) => { if(!s) return ''; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]?(' '+m[4]+':'+m[5]):''}` : String(s); };

  function _ensureModal(){
    if($('invFefoModal')) return;
    const html = `
<div class="modal-overlay" id="invFefoModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>⏳</span> FEFO Override Approvals</div>
      <button class="modal-close" onclick="invFefoClose()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:14px">
      <div id="fefo-filters" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"></div>
      <div id="fefo-list"></div>
    </div>
    <div class="modal-foot">
      <div style="flex:1"></div>
      <button class="btn" onclick="invFefoClose()">Close</button>
    </div>
  </div>
</div>`;
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    document.body.appendChild(tmp.firstElementChild);
  }

  async function open(){
    _ensureModal();
    $('invFefoModal').classList.add('show');
    await load();
  }
  function close(){ $('invFefoModal')?.classList.remove('show'); }

  async function load(){
    const qs = F.filter ? ('?status=' + encodeURIComponent(F.filter)) : '';
    $('fefo-list').innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">Loading…</div>`;
    try {
      const r = await fetch(API + '/requests' + qs);
      const d = await r.json();
      if(d.status !== 'ok'){ toast(d.message || 'Failed','error',4000); return; }
      F.requests = d.requests || [];
      F.canApprove = !!d.can_approve;
      render();
    } catch(e){ toast('Network error','error',4000); }
  }

  function render(){
    // filter chips
    const filters = ['pending','approved','rejected','used',''];
    const flabel = { pending:'Pending', approved:'Approved', rejected:'Rejected', used:'Used', '':'All' };
    $('fefo-filters').innerHTML = filters.map(f =>
      `<button class="btn ${F.filter===f?'btn-primary':''}" style="padding:5px 12px;font-size:12px" onclick="invFefoFilter('${f}')">${flabel[f]}</button>`).join('');

    const host = $('fefo-list');
    if(!F.requests.length){
      host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">No ${F.filter||''} override requests.</div>`;
      return;
    }
    host.innerHTML = F.requests.map(o => {
      const canDecide = F.canApprove && o.status === 'pending';
      return `
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
            <div style="font-weight:700;font-size:13px">${esc(o.box_code || ('Box #'+o.box_id))} · ${esc(o.material_name||'')}</div>
            ${pill(o.status)}
          </div>
          <div style="font-size:11.5px;color:var(--muted,#6b7280);margin-top:5px">
            Godown: ${esc(o.godown_name||'')} · This box expires <b>${esc(o.box_expiry||'(none)')}</b>,
            earlier stock expires <b>${esc(o.earliest_expiry||'—')}</b>
          </div>
          <div style="font-size:12.5px;margin-top:6px"><b>Reason:</b> ${esc(o.reason||'')}</div>
          <div style="font-size:11px;color:var(--muted,#9ca3af);margin-top:5px">
            By ${esc(o.requested_by)} · ${fdt(o.requested_at)}
            ${o.decided_by ? ` · ${o.status} by ${esc(o.decided_by)} ${fdt(o.decided_at)}` : ''}
            ${o.decide_note ? ` · note: ${esc(o.decide_note)}` : ''}
          </div>
          ${canDecide ? `
            <div style="margin-top:10px;display:flex;gap:8px">
              <button class="btn btn-primary" style="padding:5px 14px" onclick="invFefoDecide(${o.id},'approve')"><i class="fas fa-check"></i> Approve</button>
              <button class="btn" style="padding:5px 14px;color:#dc2626" onclick="invFefoDecide(${o.id},'reject')"><i class="fas fa-times"></i> Reject</button>
            </div>` : ''}
        </div>`;
    }).join('');
  }

  function setFilter(f){ F.filter = f; load(); }

  async function decide(oid, action){
    let note = '';
    if(action === 'reject'){
      note = prompt('Reason for rejecting (optional):') || '';
    }
    try {
      const r = await fetch(`${API}/${oid}/${action}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ note })
      });
      const d = await r.json();
      if(d.status === 'ok'){ toast(`✓ ${action === 'approve' ? 'Approved' : 'Rejected'}`,'success',2200); load(); refreshBadge(); }
      else { toast(d.message || 'Failed','error',4000); }
    } catch(e){ toast('Network error','error',4000); }
  }

  /* ── nav + badge ──────────────────────────────────────────────────── */
  function _injectNav(){
    if($('fefo-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Admin');
    if(!section){
      section = document.createElement('div');
      section.className = 'inv-nav-section'; section.id = 'fefo-nav-section';
      section.innerHTML = `<div class="inv-nav-section-label">Admin</div>`;
      navBody.appendChild(section);
    }
    const item = document.createElement('div');
    item.className = 'inv-nav-item'; item.id = 'fefo-nav-item';
    item.onclick = () => open();
    item.innerHTML = `<span class="ico">⏳</span><span>FEFO Overrides</span>
      <span id="fefo-nav-badge" style="display:none;margin-left:auto;background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:9px;padding:1px 7px"></span>`;
    section.appendChild(item);
  }
  async function refreshBadge(){
    try {
      const r = await fetch(API + '/pending_count');
      const d = await r.json();
      const b = $('fefo-nav-badge');
      if(b && d.status === 'ok'){
        if(d.count > 0){ b.textContent = d.count; b.style.display = ''; }
        else b.style.display = 'none';
      }
    } catch(e){}
  }
  // Show the nav item only to approvers (fefo_override access or admin).
  function _applyAccess(){
    const item = $('fefo-nav-item');
    if(!item) return;
    const a = window._invAccess;
    const allowed = !a || !a.ready || a.is_admin ||
      (a.access && a.access.fefo_override !== 'off' && a.access.fefo_override !== false);
    item.style.display = allowed ? '' : 'none';
  }
  document.addEventListener('inv-access-ready', () => { _applyAccess(); refreshBadge(); });

  function _boot(){ _injectNav(); _applyAccess(); refreshBadge(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();

  window.invFefoOpen   = open;
  window.invFefoClose  = close;
  window.invFefoFilter = setFilter;
  window.invFefoDecide = decide;

  console.log('✅ inventory_fefo.js loaded (Phase 3)');
})();
