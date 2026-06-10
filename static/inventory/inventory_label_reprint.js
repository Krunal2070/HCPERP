/* ═══════════════════════════════════════════════════════════════════════
   inventory_label_reprint.js — Label Reprint Approvals  (Inventory Phase 7)
   HCP Wellness · adapted from pm_stock reprint flow
   ───────────────────────────────────────────────────────────────────────
   REPRINT = print the SAME label again (code unchanged). Approval required.
   Scope: a set of box codes, OR a whole GRN's in-stock boxes.

   Flow: user requests (scope + reason) → approver approves → per-box print
   tracking → print each / all.

   "🖨️ Label Reprint" sidebar item (Admin section) with pending badge.

   Backend: inventory_label_reprint.py → /api/inventory_mgmt/label_reprint/*
   =================================================================== */

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const fdt = (s) => { if(!s) return ''; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/); return m?`${m[3]}/${m[2]}/${m[1]}${m[4]?(' '+m[4]+':'+m[5]):''}`:String(s); };
  const API = '/api/inventory_mgmt/label_reprint';

  const P = { requests:[], canApprove:false, canRequest:false, filter:'pending', scope:'boxes', expanded:{}, detailOpen:{} };

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
    if($('invReprintModal')) return;
    const html = `
<div class="modal-overlay" id="invReprintModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>🖨️</span> Label Reprint</div>
      <button class="modal-close" onclick="invReprintClose()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:14px">
      <div id="reprint-form" style="padding:12px 14px;border:1px dashed var(--border,#d1d5db);border-radius:9px;margin-bottom:14px"></div>
      <div id="reprint-filters" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"></div>
      <div id="reprint-list"></div>
    </div>
    <div class="modal-foot"><div style="flex:1"></div><button class="btn" onclick="invReprintClose()">Close</button></div>
  </div>
</div>`;
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    document.body.appendChild(tmp.firstElementChild);
  }

  async function open(){ _ensure(); $('invReprintModal').classList.add('show'); renderForm(); await load(); }
  function close(){ $('invReprintModal')?.classList.remove('show'); }

  /* Open the modal pre-filled to request a reprint for a specific GRN.
     Called from the Voucher Log / GRN list "reprint labels" action. */
  function openForGrn(grnId, grnNo){
    _ensure();
    $('invReprintModal').classList.add('show');
    P.scope = 'grn';
    P.filter = 'pending';
    renderForm();
    // prefill the GRN field + a sensible reason
    setTimeout(function(){
      var g = $('reprint-grn'); if(g) g.value = grnId || '';
      var rsn = $('reprint-reason'); if(rsn && grnNo) rsn.placeholder = 'Reprint labels for GRN ' + grnNo;
    }, 30);
    load();
  }

  function renderForm(){
    const host = $('reprint-form');
    if(!host) return;
    // Per the request/approval split: approvers (admins) only see the approval
    // list — no request form. Requesters (non-admin store users with access)
    // see the form. If we don't yet know (before first load), show nothing.
    if(P.canApprove || !P.canRequest){
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    host.style.display = '';
    const seg = (k,label) => `<button type="button" class="btn ${P.scope===k?'btn-primary':''}" style="padding:6px 14px;font-size:12px" onclick="invReprintScope('${k}')">${label}</button>`;
    const scopeField = P.scope === 'grn'
      ? `<div style="flex:1;min-width:200px"><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">GRN number / ID</label>
           <input type="text" id="reprint-grn" placeholder="GRN id" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)">
           <div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:3px">Reprints every in-stock box of this GRN.</div></div>`
      : `<div style="flex:1;min-width:200px"><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">Box codes</label>
           <textarea id="reprint-codes" rows="2" placeholder="Scan / paste box codes (comma or newline separated)" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)"></textarea></div>`;
    host.innerHTML = `
      <div style="font-size:12px;font-weight:800;margin-bottom:8px">Request a reprint <span style="font-weight:400;color:var(--muted,#9ca3af)">— same label, code unchanged · needs approval</span></div>
      <div style="display:flex;gap:8px;margin-bottom:10px">${seg('boxes','By box codes')}${seg('grn','Whole GRN')}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">
        ${scopeField}
        <div style="flex:1;min-width:180px"><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">Reason</label>
          <input type="text" id="reprint-reason" placeholder="e.g. labels torn during transit" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)"></div>
      </div>
      <div style="margin-top:10px"><button class="btn btn-primary" onclick="invReprintRaise()"><i class="fas fa-paper-plane"></i> Submit request</button></div>`;
  }

  async function load(){
    const qs = P.filter ? ('?status=' + encodeURIComponent(P.filter)) : '';
    $('reprint-list').innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">Loading…</div>`;
    try {
      const r = await fetch(API + '/requests' + qs);
      const d = await r.json();
      if(d.status !== 'ok'){ toast(d.message || 'Failed','error',4000); return; }
      P.requests = d.requests || []; P.canApprove = !!d.can_approve; P.canRequest = !!d.can_request;
      renderForm();
      render();
    } catch(e){ toast('Network error','error',4000); }
  }

  function render(){
    const filters = ['pending','approved','printed','rejected',''];
    const flabel = { pending:'Pending', approved:'Approved', printed:'Printed', rejected:'Rejected', '':'All' };
    $('reprint-filters').innerHTML =
      filters.map(f => `<button class="btn ${P.filter===f?'btn-primary':''}" style="padding:5px 12px;font-size:12px" onclick="invReprintFilter('${f}')">${flabel[f]}</button>`).join('')
      + (P.canApprove && P.filter==='pending' && P.requests.length ? `<button class="btn" style="padding:5px 12px;font-size:12px;margin-left:auto;color:#0f766e" onclick="invReprintApproveAll()"><i class="fas fa-check-double"></i> Approve all</button>` : '');

    const host = $('reprint-list');
    if(!P.requests.length){
      host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">No ${P.filter||''} reprint requests.</div>`;
      return;
    }
    host.innerHTML = P.requests.map(o => {
      const canDecide = P.canApprove && o.status === 'pending';
      const isApproved = (o.status === 'approved' || o.status === 'printed');
      const scopeTxt = o.scope_type === 'grn' ? `Whole GRN <strong>${esc(o.grn_no||('#'+o.grn_id))}</strong>` : `${o.box_count} box(es)`;
      const prog = (o.total_count != null) ? ` · printed ${o.printed_count||0}/${o.total_count}` : '';
      const boxesPanel = (isApproved && P.expanded[o.req_id]) ? `<div id="reprint-boxes-${o.req_id}" style="margin-top:8px"></div>` : '';

      // Material summary chips (what's being reprinted).
      const matChips = (o.materials||[]).length
        ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">`
          + (o.materials||[]).map(m => `<span style="font-size:11px;background:var(--surface,#eef2f7);border:1px solid var(--border,#e5e7eb);border-radius:7px;padding:2px 8px"><b>${esc(m.name)}</b> · ${m.count}</span>`).join('')
          + `</div>`
        : '';

      // Collapsible detail of every box/label in the request.
      const det = o.box_detail || [];
      const detailRows = det.length
        ? det.map(b => `<tr>
            <td style="padding:4px 8px;font-family:monospace;font-size:11px">${esc(b.box_code)}</td>
            <td style="padding:4px 8px;font-size:11.5px">${esc(b.material_name||'—')}</td>
            <td style="padding:4px 8px;font-size:11.5px">${esc(b.batch_num||'—')}</td>
            <td style="padding:4px 8px;font-size:11.5px">${b.expiry_date?fdt(b.expiry_date):'—'}</td>
            <td style="padding:4px 8px;font-size:11.5px">${esc(b.grn_no||'—')}</td>
          </tr>`).join('')
        : `<tr><td colspan="5" style="padding:8px;text-align:center;color:var(--muted,#9ca3af);font-size:11.5px">No box details available.</td></tr>`;
      const moreNote = (o.box_codes && o.box_codes.length > det.length)
        ? `<div style="font-size:10.5px;color:var(--muted,#9ca3af);padding:4px 8px">…and ${o.box_codes.length - det.length} more box(es) not shown.</div>` : '';
      const detailOpen = !!P.detailOpen[o.req_id];
      const detailPanel = `
        <div style="margin-top:8px">
          <button class="btn" style="padding:4px 11px;font-size:11.5px" onclick="invReprintToggleDetail(${o.req_id})">
            <i class="fas fa-${detailOpen?'chevron-up':'list-ul'}"></i> ${detailOpen?'Hide':'View'} label details (${det.length}${(o.box_codes&&o.box_codes.length>det.length)?'+':''})
          </button>
          ${detailOpen ? `<div style="margin-top:8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;overflow:auto;max-height:260px">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="background:var(--surface,#f3f4f6);position:sticky;top:0">
                <th style="text-align:left;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted,#6b7280)">Box Code</th>
                <th style="text-align:left;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted,#6b7280)">Material</th>
                <th style="text-align:left;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted,#6b7280)">Batch</th>
                <th style="text-align:left;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted,#6b7280)">Expiry</th>
                <th style="text-align:left;padding:5px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted,#6b7280)">GRN</th>
              </tr></thead>
              <tbody>${detailRows}</tbody>
            </table>
            ${moreNote}
          </div>` : ''}
        </div>`;

      return `
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
            <div style="font-weight:700;font-size:13px">Reprint #${o.req_id} · ${scopeTxt}</div>
            ${pill(o.status)}
          </div>
          <div style="font-size:12.5px;margin-top:6px"><b>Reason:</b> ${esc(o.reason||'')}</div>
          ${matChips}
          <div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:4px">
            By ${esc(o.requested_by)} · ${fdt(o.requested_at)}
            ${o.decided_by ? ` · ${o.status} by ${esc(o.decided_by)} ${fdt(o.decided_at)}` : ''}${prog}
          </div>
          ${detailPanel}
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            ${canDecide ? `<button class="btn btn-primary" style="padding:5px 14px" onclick="invReprintDecide(${o.req_id},'approve')"><i class="fas fa-check"></i> Approve</button>
              <button class="btn" style="padding:5px 14px;color:#dc2626" onclick="invReprintDecide(${o.req_id},'reject')"><i class="fas fa-times"></i> Reject</button>` : ''}
            ${isApproved ? `<button class="btn" style="padding:5px 14px" onclick="invReprintToggleBoxes(${o.req_id})"><i class="fas fa-list"></i> ${P.expanded[o.req_id]?'Hide':'Show'} boxes</button>
              <button class="btn" style="padding:5px 14px;color:#0f766e" onclick="invReprintPrintAll(${o.req_id})"><i class="fas fa-print"></i> Print all</button>` : ''}
          </div>
          ${boxesPanel}
        </div>`;
    }).join('');
    // hydrate any expanded box panels
    P.requests.forEach(o => { if((o.status==='approved'||o.status==='printed') && P.expanded[o.req_id]) loadBoxes(o.req_id); });
  }

  function setScope(s){ P.scope = s; renderForm(); }
  function setFilter(f){ P.filter = f; load(); }

  async function raise(){
    const reason = ($('reprint-reason')?.value || '').trim();
    if(!reason){ toast('Enter a reason','warn',3000); return; }
    const body = { scope_type: P.scope, reason };
    if(P.scope === 'grn'){
      const g = ($('reprint-grn')?.value || '').trim();
      if(!g){ toast('Enter the GRN id','warn',3000); return; }
      body.grn_id = Number(g);
    } else {
      const codes = ($('reprint-codes')?.value || '').trim();
      if(!codes){ toast('Add box codes','warn',3000); return; }
      body.box_codes = codes;
    }
    try {
      const r = await fetch(API + '/request', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const d = await r.json();
      if(d.status === 'ok'){
        toast(d.duplicate ? 'A request already exists for that scope.' : `✓ Reprint request submitted (${d.box_count||0} box)`, 'success', 2800);
        if($('reprint-reason')) $('reprint-reason').value='';
        if($('reprint-codes')) $('reprint-codes').value='';
        if($('reprint-grn')) $('reprint-grn').value='';
        load();
      } else toast(d.message || 'Failed','error',4500);
    } catch(e){ toast('Network error','error',4000); }
  }

  async function decide(rid, action){
    let note = '';
    if(action === 'reject'){ note = prompt('Reason for rejecting (optional):') || ''; }
    try {
      const r = await fetch(`${API}/${rid}/${action}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ note }) });
      const d = await r.json();
      if(d.status === 'ok'){ toast(action==='approve'?'✓ Approved':'✓ Rejected','success',2200); load(); refreshBadge(); }
      else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }

  async function approveAll(){
    const ids = P.requests.filter(o => o.status==='pending').map(o => o.req_id);
    if(!ids.length) return;
    if(!confirm(`Approve all ${ids.length} pending reprint request(s)?`)) return;
    try {
      const r = await fetch(`${API}/approve_bulk`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ req_ids: ids }) });
      const d = await r.json();
      if(d.status === 'ok'){ toast(`✓ Approved ${d.approved} request(s)`,'success',2500); load(); refreshBadge(); }
      else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }

  function toggleBoxes(rid){ P.expanded[rid] = !P.expanded[rid]; render(); }
  function toggleDetail(rid){ P.detailOpen[rid] = !P.detailOpen[rid]; render(); }
  async function loadBoxes(rid){
    const host = $('reprint-boxes-'+rid);
    if(!host) return;
    host.innerHTML = `<div style="font-size:11.5px;color:var(--muted,#9ca3af)">Loading boxes…</div>`;
    try {
      const r = await fetch(`${API}/${rid}/boxes`);
      const d = await r.json();
      if(d.status !== 'ok'){ host.innerHTML = ''; return; }
      host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px">` + (d.boxes||[]).map(b =>
        `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:8px;font-size:11px;background:${b.printed?'rgba(13,148,136,.1)':'var(--surface,#eef2f7)'}">
          <span style="font-family:monospace;font-weight:700">${esc(b.box_code)}</span>
          ${b.printed ? '<span style="color:#0f766e">✓</span>' : `<button class="btn" style="padding:1px 8px;font-size:10px" onclick="invReprintPrintBox(${rid},'${esc(b.box_code)}')">print</button>`}
        </span>`).join('') + `</div>`;
    } catch(e){ host.innerHTML = ''; }
  }
  async function printBox(rid, code){
    // OPEN THE PRINT WINDOW FIRST. Only mark the box as printed on the
    // backend after the print job has been launched, so a failed print
    // (pop-up blocked, missing label data, etc.) doesn't leave a box
    // marked-but-not-actually-printed.
    if(typeof window.invGrnPrintBoxLabel !== 'function'){
      toast('Label printer unavailable — refresh the page','error',4500); return;
    }
    try {
      await window.invGrnPrintBoxLabel(code);
    } catch(e){
      toast('Print failed: ' + (e && e.message || e),'error',5000); return;
    }
    try {
      const r = await fetch(`${API}/${rid}/print`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ box_code: code }) });
      const d = await r.json();
      if(d.status === 'ok'){ load(); }
      else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }
  async function printAll(rid){
    // 1) Fetch the actual box codes for this request — the existing
    //    /<rid>/boxes endpoint returns every box (printed and unprinted)
    //    for an approved reprint request.
    // 2) Open ONE print window containing all those labels.
    // 3) THEN mark them printed on the backend (only after print fires).
    if(typeof window.invGrnPrintBoxLabel !== 'function'){
      toast('Label printer unavailable — refresh the page','error',4500); return;
    }
    let codes = [];
    try {
      const r = await fetch(`${API}/${rid}/boxes`);
      const d = await r.json();
      if(d.status !== 'ok'){ toast(d.message || 'Could not load boxes','error',4000); return; }
      codes = (d.boxes || []).map(b => b.box_code).filter(Boolean);
    } catch(e){ toast('Network error loading boxes','error',4000); return; }
    if(!codes.length){ toast('No boxes to print','warn',3000); return; }

    try {
      await window.invGrnPrintBoxLabel(codes);
    } catch(e){
      toast('Print failed: ' + (e && e.message || e),'error',5000); return;
    }
    try {
      const r = await fetch(`${API}/${rid}/print`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
      const d = await r.json();
      if(d.status === 'ok'){ toast('✓ Marked all printed','success',2200); load(); }
      else toast(d.message || 'Failed','error',4000);
    } catch(e){ toast('Network error','error',4000); }
  }

  /* ── nav + badge ──────────────────────────────────────────────────── */
  function _injectNav(){
    if($('reprint-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    // Only show the menu to users who can use this feature: admins (approve)
    // or non-admin users granted the label_reprint access toggle (request).
    const acc = (window._invAccess && window._invAccess.access) || {};
    const isAdmin = !!(window._invAccess && window._invAccess.is_admin);
    const ready = !!(window._invAccess && window._invAccess.ready);
    if(ready && !isAdmin && !acc.label_reprint) return;  // no access → no menu
    // Prefer the "Vouchers" section so store users can find it; fall back to Admin.
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
    item.className = 'inv-nav-item'; item.id = 'reprint-nav-item';
    item.setAttribute('data-cap','label_reprint');
    item.onclick = () => open();
    item.innerHTML = `<span class="ico">🖨️</span><span>Label Reprint</span>
      <span id="reprint-nav-badge" style="display:none;margin-left:auto;background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:9px;padding:1px 7px"></span>`;
    section.appendChild(item);
  }
  async function refreshBadge(){
    // The pending-count badge is only meaningful to approvers (admins).
    const isAdmin = !!(window._invAccess && window._invAccess.is_admin);
    const b = $('reprint-nav-badge');
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

  window.invReprintOpen   = open;
  window.invReprintForGrn = openForGrn;
  window.invReprintClose  = close;
  window.invReprintScope  = setScope;
  window.invReprintFilter = setFilter;
  window.invReprintRaise  = raise;
  window.invReprintDecide = decide;
  window.invReprintApproveAll = approveAll;
  window.invReprintToggleBoxes = toggleBoxes;
  window.invReprintToggleDetail = toggleDetail;
  window.invReprintPrintBox = printBox;
  window.invReprintPrintAll = printAll;

  console.log('✅ inventory_label_reprint.js loaded (Phase 7)');
})();
