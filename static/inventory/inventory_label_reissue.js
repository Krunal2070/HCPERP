/* ═══════════════════════════════════════════════════════════════════════
   inventory_label_reissue.js — Label Reissue Approvals  (Inventory Phase 7)
   HCP Wellness · adapted from pm_stock_label_reissue.js
   ───────────────────────────────────────────────────────────────────────
   REISSUE = the box's QR/label is damaged → assign a brand-new code + print.
   Flow: user requests (reason) → admin approves (new code stamped) → print.

   Surfaces:
     • "🏷️ Label Reissue" sidebar item (Admin section) — opens approvals for
       approvers, or "My Reissue Requests" for everyone else.
     • A small "request reissue" prompt (by box code) available in the modal.

   Backend: inventory_label_reissue.py → /api/inventory_mgmt/label_reissue/*
   =================================================================== */

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const fdt = (s) => { if(!s) return ''; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/); return m?`${m[3]}/${m[2]}/${m[1]}${m[4]?(' '+m[4]+':'+m[5]):''}`:String(s); };
  const API = '/api/inventory_mgmt/label_reissue';

  const R = { requests:[], canApprove:false, canRequest:false, filter:'pending' };

  function pill(st){
    const map = {
      pending:  ['#92400e','rgba(245,158,11,.12)','PENDING'],
      approved: ['#0f766e','rgba(13,148,136,.12)','APPROVED · ready to print'],
      printed:  ['#475569','rgba(100,116,139,.14)','PRINTED'],
      rejected: ['#991b1b','rgba(220,38,38,.10)','REJECTED'],
    };
    const [fg,bg,txt] = map[st] || ['#374151','rgba(0,0,0,.06)',String(st||'').toUpperCase()];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:9.5px;font-weight:800;letter-spacing:.3px;color:${fg};background:${bg}">${txt}</span>`;
  }

  function _ensure(){
    if($('invReissueModal')) return;
    const html = `
<div class="modal-overlay" id="invReissueModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>🏷️</span> Label Reissue</div>
      <button class="modal-close" onclick="invReissueClose()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:14px">
      <div id="reissue-request-form" style="display:flex;gap:10px;align-items:flex-end;margin-bottom:12px;flex-wrap:wrap;padding:10px 12px;border:1px dashed var(--border,#d1d5db);border-radius:9px">
        <div style="flex:1;min-width:180px">
          <label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">Request a reissue (damaged label)</label>
          <input type="text" id="reissue-code" placeholder="Scan / type the box code" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)">
        </div>
        <button class="btn btn-primary" onclick="invReissueRaise()"><i class="fas fa-tag"></i> Request</button>
      </div>
      <div id="reissue-filters" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"></div>
      <div id="reissue-list"></div>
    </div>
    <div class="modal-foot"><div style="flex:1"></div><button class="btn" onclick="invReissueClose()">Close</button></div>
  </div>
</div>`;
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    document.body.appendChild(tmp.firstElementChild);
  }

  async function open(){ _ensure(); $('invReissueModal').classList.add('show'); await load(); }
  function close(){ $('invReissueModal')?.classList.remove('show'); }

  async function load(){
    const qs = R.filter ? ('?status=' + encodeURIComponent(R.filter)) : '';
    $('reissue-list').innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">Loading…</div>`;
    try {
      const r = await fetch(API + '/requests' + qs);
      const d = await r.json();
      if(d.status !== 'ok'){ toast(d.message || 'Failed','error',4000); return; }
      R.requests = d.requests || []; R.canApprove = !!d.can_approve; R.canRequest = !!d.can_request;
      // Approvers (admins) see approval list only; requesters see the request form.
      const rf = $('reissue-request-form');
      if(rf) rf.style.display = (R.canApprove || !R.canRequest) ? 'none' : '';
      render();
    } catch(e){ toast('Network error','error',4000); }
  }

  function render(){
    const filters = ['pending','approved','printed','rejected',''];
    const flabel = { pending:'Pending', approved:'Approved', printed:'Printed', rejected:'Rejected', '':'All' };
    $('reissue-filters').innerHTML = filters.map(f =>
      `<button class="btn ${R.filter===f?'btn-primary':''}" style="padding:5px 12px;font-size:12px" onclick="invReissueFilter('${f}')">${flabel[f]}</button>`).join('');

    const host = $('reissue-list');
    if(!R.requests.length){
      host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">No ${R.filter||''} reissue requests.</div>`;
      return;
    }
    host.innerHTML = R.requests.map(o => {
      const canDecide = R.canApprove && o.status === 'pending';
      const canPrint  = (o.status === 'approved');
      const codeLine = o.new_box_code
        ? `Old <strong style="font-family:monospace">${esc(o.old_box_code||'')}</strong> → New <strong style="font-family:monospace;color:#0f766e">${esc(o.new_box_code)}</strong>`
        : `Box <strong style="font-family:monospace">${esc(o.old_box_code||('#'+o.box_id))}</strong>`;
      return `
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
            <div style="font-weight:700;font-size:13px">${esc(o.material_name||('Material #'+o.material_id))}</div>
            ${pill(o.status)}
          </div>
          <div style="font-size:11.5px;color:var(--text,#374151);margin-top:5px">${codeLine}</div>
          <div style="font-size:11px;color:var(--muted,#6b7280);margin-top:3px">📍 ${esc(o.godown_name||'')}${o.grn_no?(' · GRN '+esc(o.grn_no)):''}</div>
          <div style="font-size:12.5px;margin-top:6px"><b>Reason:</b> ${esc(o.reason||'')}</div>
          <div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:4px">
            By ${esc(o.requested_by)} · ${fdt(o.requested_at)}
            ${o.decided_by ? ` · ${o.status} by ${esc(o.decided_by)} ${fdt(o.decided_at)}` : ''}
            ${o.decided_note ? ` · note: ${esc(o.decided_note)}` : ''}
            ${o.printed_at ? ` · printed ${fdt(o.printed_at)}` : ''}
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            ${canDecide ? `<button class="btn btn-primary" style="padding:5px 14px" onclick="invReissueDecide(${o.req_id},'approve')"><i class="fas fa-check"></i> Approve</button>
              <button class="btn" style="padding:5px 14px;color:#dc2626" onclick="invReissueDecide(${o.req_id},'reject')"><i class="fas fa-times"></i> Reject</button>` : ''}
            ${canPrint ? `<button class="btn" style="padding:5px 14px;color:#0f766e" onclick="invReissuePrint(${o.req_id})"><i class="fas fa-print"></i> Print replacement</button>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function setFilter(f){ R.filter = f; load(); }

  async function raise(){
    const code = ($('reissue-code')?.value || '').trim();
    if(!code){ toast('Enter a box code','warn',3000); return; }
    const reason = prompt('Reason for reissue (e.g. label torn / QR won\'t scan):');
    if(reason === null) return;
    if(!reason.trim()){ toast('A reason is required','warn',3000); return; }
    try {
      const r = await fetch(API + '/request', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_code: code, reason: reason.trim() })
      });
      const d = await r.json();
      if(d.status === 'ok'){ toast(d.duplicate ? 'A request already exists for that box.' : '✓ Reissue request submitted','success',2800); if($('reissue-code')) $('reissue-code').value=''; load(); }
      else toast(d.message || 'Failed','error',4500);
    } catch(e){ toast('Network error','error',4000); }
  }

  async function decide(rid, action){
    let note = '';
    if(action === 'reject'){ note = prompt('Reason for rejecting (optional):') || ''; }
    try {
      const r = await fetch(`${API}/${rid}/${action}`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ note })
      });
      const d = await r.json();
      if(d.status === 'ok'){
        toast(action === 'approve' ? `✓ Approved — new code ${d.new_box_code}` : '✓ Rejected', 'success', 3000);
        load(); refreshBadge();
      } else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }

  async function doPrint(rid){
    try {
      const r = await fetch(`${API}/${rid}/print`, { method:'POST' });
      const d = await r.json();
      if(d.status === 'ok'){
        toast(`Replacement label for ${d.new_box_code} marked printed`,'success',3000);
        // Best-effort: trigger the existing label print if a handler exists.
        if(typeof window.invGrnPrintBoxLabel === 'function'){ try { window.invGrnPrintBoxLabel(d.new_box_code); } catch(e){} }
        load();
      } else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }

  /* ── nav + badge ──────────────────────────────────────────────────── */
  function _injectNav(){
    if($('reissue-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    const acc = (window._invAccess && window._invAccess.access) || {};
    const isAdmin = !!(window._invAccess && window._invAccess.is_admin);
    const ready = !!(window._invAccess && window._invAccess.ready);
    if(ready && !isAdmin && !acc.label_reissue) return;  // no access → no menu
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Vouchers');
    if(!section){
      section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
        .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Admin');
    }
    if(!section){
      section = document.createElement('div'); section.className = 'inv-nav-section';
      section.innerHTML = `<div class="inv-nav-section-label">Vouchers</div>`;
      navBody.appendChild(section);
    }
    const item = document.createElement('div');
    item.className = 'inv-nav-item'; item.id = 'reissue-nav-item';
    item.setAttribute('data-cap','label_reissue');
    item.onclick = () => open();
    item.innerHTML = `<span class="ico">🏷️</span><span>Label Reissue</span>
      <span id="reissue-nav-badge" style="display:none;margin-left:auto;background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:9px;padding:1px 7px"></span>`;
    section.appendChild(item);
  }
  async function refreshBadge(){
    const isAdmin = !!(window._invAccess && window._invAccess.is_admin);
    const b = $('reissue-nav-badge');
    if(!isAdmin){ if(b) b.style.display='none'; return; }
    try {
      const r = await fetch(API + '/pending_count');
      const d = await r.json();
      if(b && d.status === 'ok'){
        if(d.count > 0){ b.textContent = d.count; b.style.display = ''; }
        else b.style.display = 'none';
      }
    } catch(e){}
  }

  function _boot(){ _injectNav(); refreshBadge(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();
  document.addEventListener('inv-access-ready', function(){ _injectNav(); refreshBadge(); });

  window.invReissueOpen   = open;
  window.invReissueClose  = close;
  window.invReissueFilter = setFilter;
  window.invReissueRaise  = raise;
  window.invReissueDecide = decide;
  window.invReissuePrint  = doPrint;

  console.log('✅ inventory_label_reissue.js loaded (Phase 7)');
})();
