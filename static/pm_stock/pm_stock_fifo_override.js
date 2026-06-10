/* ════════════════════════════════════════════════════════════════════════
   FIFO OVERRIDE APPROVALS  —  admin review + requester tracking
   ────────────────────────────────────────────────────────────────────────
   Companion to the FIFO override request flow in pm_stock_movement.js.

   Non-admins raise override requests for FIFO-violating boxes (each with a
   reason); they can queue several boxes and submit them at once. Admins
   review them here and approve/reject — individually or in bulk. An
   approved request grants the requester a single-use pass to re-scan that
   exact box.

   Surfaces:
     • Admin  : "FIFO Override Approvals" modal  (openFifoOverrideApprovalsModal)
     • User   : "My FIFO Overrides" modal        (openMyFifoOverridesModal)
     • Badge  : refreshFifoOverrideBadge()  — polls pending_count

   Endpoints (see __init__.py):
     GET  /api/pm_stock/fifo_override/requests        ?status=
     GET  /api/pm_stock/fifo_override/pending_count
     POST /api/pm_stock/fifo_override/<id>/approve    {note}
     POST /api/pm_stock/fifo_override/<id>/reject     {note}
     POST /api/pm_stock/fifo_override/approve_bulk    {req_ids, note}
     POST /api/pm_stock/fifo_override/reject_bulk     {req_ids, note}
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // ── small shared utils ───────────────────────────────────────────────
  function _toast(msg, kind, ms){
    if(typeof showToast === 'function') showToast(msg, kind || 'info', ms || 3000);
  }
  function _esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function _fmtDateTime(s){
    if(!s) return '';
    // Server sends 'YYYY-MM-DD HH:MM:SS' — render DD/MM/YYYY HH:MM
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if(m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
    return String(s);
  }
  function _isAdminUser(){
    return (typeof _isAdmin === 'function') ? _isAdmin() : false;
  }

  // Status pill styling
  const STATUS_STYLE = {
    pending:  {bg:'rgba(245,158,11,.12)', fg:'#92400e', label:'PENDING'},
    approved: {bg:'rgba(13,148,136,.12)', fg:'#0f766e', label:'APPROVED'},
    used:     {bg:'rgba(100,116,139,.14)',fg:'#475569', label:'USED'},
    rejected: {bg:'rgba(220,38,38,.10)',  fg:'#991b1b', label:'REJECTED'},
    expired:  {bg:'rgba(100,116,139,.14)',fg:'#475569', label:'EXPIRED'},
  };
  function _statusPill(status){
    const s = STATUS_STYLE[status] || {bg:'rgba(0,0,0,.06)', fg:'#374151', label:String(status||'').toUpperCase()};
    return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:9.5px;
      font-weight:800;letter-spacing:.4px;background:${s.bg};color:${s.fg}">${s.label}</span>`;
  }

  // ── modal scaffolding (created lazily, like the FIFO violation modal) ──
  function _ensureModal(id, titleHtml, subtitleHtml){
    let modal = document.getElementById(id);
    if(modal) return modal;
    modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal-overlay';
    modal.style.cssText = 'z-index:1000';
    modal.innerHTML = `
      <div class="modal" style="width:760px;max-width:96vw;max-height:90vh;display:flex;
        flex-direction:column;background:var(--surface,#fff);border-radius:12px;overflow:hidden;
        box-shadow:0 24px 64px rgba(0,0,0,.3)">
        <div style="padding:16px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));
          display:flex;align-items:flex-start;gap:12px;flex-shrink:0">
          <div style="flex:1">
            <div style="font-size:15px;font-weight:800;color:var(--htxtb,#111);display:flex;align-items:center;gap:8px">${titleHtml}</div>
            <div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:2px">${subtitleHtml}</div>
          </div>
          <button onclick="document.getElementById('${id}').classList.remove('open')"
            class="modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;
              color:var(--hmuted,#9ca3af);line-height:1">✕</button>
        </div>
        <div id="${id}-toolbar" style="flex-shrink:0"></div>
        <div id="${id}-body" style="overflow-y:auto;padding:14px 18px;flex:1"></div>
        <div id="${id}-footer" style="padding:12px 18px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));
          background:var(--hsurf2,#f9fafb);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0"></div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  // ════════════════════════════════════════════════════════════════════
  // ADMIN: FIFO Override Approvals
  // ════════════════════════════════════════════════════════════════════
  let _adminSelected = new Set();
  let _adminRows = [];

  window.openFifoOverrideApprovalsModal = async function(){
    if(!(window.__pmHasAccess && window.__pmHasAccess('fifo_override')) && !_isAdminUser()){ _toast('You do not have access to FIFO Override approvals','error'); return; }
    const modal = _ensureModal(
      'fifoOverrideApprovalsModal',
      '🔓 FIFO Override Approvals',
      'Approve or reject FIFO override requests. Approved requests let the requester re-scan that exact box (single use).'
    );
    _adminSelected = new Set();
    modal.classList.add('open');
    await _adminLoad('pending');
  };

  async function _adminLoad(statusFilter){
    const body = document.getElementById('fifoOverrideApprovalsModal-body');
    const toolbar = document.getElementById('fifoOverrideApprovalsModal-toolbar');
    if(body) body.innerHTML = `<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>`;
    // Filter tabs
    if(toolbar){
      const tabs = [['pending','Pending'],['approved','Approved'],['used','Used'],['rejected','Rejected'],['','All']];
      toolbar.innerHTML = `
        <div style="display:flex;gap:6px;padding:10px 18px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));
          background:var(--hsurf2,#fafbfc);flex-wrap:wrap">
          ${tabs.map(([v,l]) => `
            <button onclick="_fifoAdminFilter('${v}')" data-filter="${v}"
              class="fvo-tab" style="padding:5px 12px;border-radius:7px;border:1px solid var(--hbdr,rgba(0,0,0,.12));
                background:${v===statusFilter?'#0d9488':'#fff'};color:${v===statusFilter?'#fff':'var(--htxt,#374151)'};
                font-size:11.5px;font-weight:700;cursor:pointer">${l}</button>`).join('')}
        </div>`;
    }
    try {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const res = await fetch('/api/pm_stock/fifo_override/requests' + qs);
      const d = await res.json();
      if(d.status !== 'ok'){ if(body) body.innerHTML = `<div style="padding:20px;color:#b91c1c">${_esc(d.message||'Load failed')}</div>`; return; }
      _adminRows = d.requests || [];
      _adminCurrentFilter = statusFilter;
      _adminRender();
    } catch(e){
      if(body) body.innerHTML = `<div style="padding:20px;color:#b91c1c">Network error: ${_esc(e.message)}</div>`;
    }
  }
  let _adminCurrentFilter = 'pending';
  window._fifoAdminFilter = function(v){ _adminSelected = new Set(); _adminLoad(v); };

  function _adminRender(){
    const body = document.getElementById('fifoOverrideApprovalsModal-body');
    const footer = document.getElementById('fifoOverrideApprovalsModal-footer');
    if(!body) return;
    const rows = _adminRows;
    if(!rows.length){
      body.innerHTML = `<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">No requests in this view.</div>`;
      if(footer) footer.innerHTML = `<button onclick="document.getElementById('fifoOverrideApprovalsModal').classList.remove('open')" class="btn btn-outline" style="padding:8px 18px">Close</button>`;
      return;
    }
    const anyPending = rows.some(r => r.status === 'pending');
    body.innerHTML = rows.map(r => _adminRowHtml(r)).join('');
    // Footer with bulk actions (only meaningful when pending rows exist)
    if(footer){
      footer.innerHTML = `
        ${anyPending ? `
          <label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--htxt,#374151);margin-right:auto;cursor:pointer">
            <input type="checkbox" id="fvo-selectall" onchange="_fifoAdminSelectAll(this.checked)"> Select all pending
          </label>
          <button onclick="_fifoAdminBulk('reject')" class="btn btn-outline"
            style="border-color:rgba(220,38,38,.4);color:#dc2626;padding:8px 14px;font-weight:700">✗ Reject selected</button>
          <button onclick="_fifoAdminBulk('approve')" class="btn btn-primary"
            style="background:#0d9488;border-color:#0d9488;padding:8px 16px;font-weight:700">✓ Approve selected</button>
        ` : `
          <button onclick="document.getElementById('fifoOverrideApprovalsModal').classList.remove('open')" class="btn btn-outline" style="padding:8px 18px">Close</button>
        `}`;
    }
    _adminSyncSelectAll();
  }

  function _adminRowHtml(r){
    const isPending = r.status === 'pending';
    const checkbox = isPending
      ? `<input type="checkbox" class="fvo-row-chk" data-id="${r.req_id}" ${_adminSelected.has(r.req_id)?'checked':''}
           onchange="_fifoAdminToggle(${r.req_id}, this.checked)" style="margin-top:3px">`
      : `<span style="width:14px;display:inline-block"></span>`;
    const sf = _esc(r.scanned_fifo_code || '—');
    const of = _esc(r.oldest_fifo_code || '—');
    const ctx = [];
    if(r.oldest_voucher) ctx.push(`older lot from <strong>${_esc(r.oldest_voucher)}</strong>`);
    if(r.oldest_box_count) ctx.push(`${r.oldest_box_count} box(es) pending`);
    const decided = r.decided_by
      ? `<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:4px">
           ${r.status==='rejected'?'Rejected':'Approved'} by <strong>${_esc(r.decided_by)}</strong> · ${_fmtDateTime(r.decided_at)}
           ${r.decided_note?` · "${_esc(r.decided_note)}"`:''}</div>`
      : '';
    const used = r.used_at
      ? `<div style="font-size:10.5px;color:#475569;margin-top:2px">Consumed ${_fmtDateTime(r.used_at)}</div>` : '';
    return `
      <div style="display:flex;gap:10px;padding:12px;border:1px solid var(--hbdr,rgba(0,0,0,.09));
        border-radius:9px;margin-bottom:9px;background:#fff">
        ${checkbox}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-family:monospace;font-weight:800;font-size:13px;color:var(--text,#0f172a)">${_esc(r.box_code)}</span>
            ${_statusPill(r.status)}
            <span style="font-size:10.5px;color:var(--hmuted,#9ca3af)">#${r.req_id}</span>
          </div>
          <div style="font-size:11.5px;color:var(--htxt,#374151);margin-top:4px">
            ${_esc(r.product_name || '')}
            ${r.transfer_no?` · <span style="font-family:monospace;color:#0d9488">${_esc(r.transfer_no)}</span>`:''}
          </div>
          <div style="font-size:11px;color:var(--hmuted,#6b7280);margin-top:4px">
            Scanned lot <strong style="color:#dc2626;font-family:monospace">${sf}</strong>,
            should send <strong style="color:#0d9488;font-family:monospace">${of}</strong> first
            ${ctx.length?` · ${ctx.join(' · ')}`:''}
          </div>
          <div style="font-size:11.5px;color:var(--text,#0f172a);margin-top:6px;padding:7px 10px;
            background:var(--hsurf2,#f9fafb);border-radius:6px;border-left:3px solid #f59e0b">
            <span style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#92400e">Reason</span><br>
            ${_esc(r.reason || '(none given)')}
          </div>
          <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">
            Requested by <strong>${_esc(r.requested_by)}</strong> · ${_fmtDateTime(r.requested_at)}
          </div>
          ${decided}${used}
          ${isPending ? `
            <div style="display:flex;gap:8px;margin-top:9px">
              <button onclick="_fifoAdminDecideOne(${r.req_id}, 'approve')" class="btn btn-sm btn-primary"
                style="background:#0d9488;border-color:#0d9488;padding:5px 14px;font-weight:700;font-size:11.5px">✓ Approve</button>
              <button onclick="_fifoAdminDecideOne(${r.req_id}, 'reject')" class="btn btn-sm btn-outline"
                style="border-color:rgba(220,38,38,.4);color:#dc2626;padding:5px 14px;font-weight:700;font-size:11.5px">✗ Reject</button>
            </div>` : ''}
        </div>
      </div>`;
  }

  window._fifoAdminToggle = function(id, on){
    if(on) _adminSelected.add(id); else _adminSelected.delete(id);
    _adminSyncSelectAll();
  };
  window._fifoAdminSelectAll = function(on){
    _adminSelected = new Set();
    if(on){
      _adminRows.filter(r => r.status === 'pending').forEach(r => _adminSelected.add(r.req_id));
    }
    document.querySelectorAll('#fifoOverrideApprovalsModal-body .fvo-row-chk').forEach(chk => {
      chk.checked = on;
    });
  };
  function _adminSyncSelectAll(){
    const sa = document.getElementById('fvo-selectall');
    if(!sa) return;
    const pendingCount = _adminRows.filter(r => r.status === 'pending').length;
    sa.checked = pendingCount > 0 && _adminSelected.size === pendingCount;
  }

  window._fifoAdminDecideOne = async function(reqId, action){
    let note = null;
    if(action === 'reject'){
      note = prompt('Reason for rejecting this override request (optional):') || null;
    }
    await _adminPost(`/api/pm_stock/fifo_override/${reqId}/${action}`, {note});
  };

  window._fifoAdminBulk = async function(action){
    const ids = Array.from(_adminSelected);
    if(!ids.length){ _toast('Select at least one pending request','error', 3000); return; }
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    let note = prompt(`${verb} ${ids.length} request(s). Optional shared note:`, '');
    if(note === null && action === 'approve'){ /* allow empty note on approve, but cancel cancels */ }
    if(note === null) return; // cancelled
    note = (note || '').trim() || null;
    const url = `/api/pm_stock/fifo_override/${action}_bulk`;
    await _adminPost(url, {req_ids: ids, note}, true);
  };

  async function _adminPost(url, payload, isBulk){
    try {
      const res = await fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload || {})
      });
      const d = await res.json();
      if(d.status === 'ok'){
        if(isBulk){
          const n = d.approved != null ? d.approved : d.rejected;
          let msg = `${n} request(s) ${d.approved != null ? 'approved' : 'rejected'}`;
          if(d.skipped) msg += ` · ${d.skipped} skipped`;
          _toast('✓ ' + msg, 'success', 4000);
        } else {
          _toast('✓ Done', 'success', 2500);
        }
        _adminSelected = new Set();
        await _adminLoad(_adminCurrentFilter);
        if(typeof refreshFifoOverrideBadge === 'function') refreshFifoOverrideBadge();
      } else {
        _toast(d.message || 'Action failed', 'error', 4500);
      }
    } catch(e){
      _toast('Network error: ' + (e.message||e), 'error', 4500);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // USER: My FIFO Overrides
  // ════════════════════════════════════════════════════════════════════
  window.openMyFifoOverridesModal = async function(){
    const modal = _ensureModal(
      'myFifoOverridesModal',
      '🔓 My FIFO Overrides',
      'Track your FIFO override requests. Once an admin approves one, re-scan that exact box during Material OUT to push it through (single use).'
    );
    const tb = document.getElementById('myFifoOverridesModal-toolbar');
    if(tb) tb.innerHTML = '';
    modal.classList.add('open');
    const body = document.getElementById('myFifoOverridesModal-body');
    const footer = document.getElementById('myFifoOverridesModal-footer');
    if(footer) footer.innerHTML = `<button onclick="document.getElementById('myFifoOverridesModal').classList.remove('open')" class="btn btn-outline" style="padding:8px 18px">Close</button>`;
    if(body) body.innerHTML = `<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>`;
    try {
      const res = await fetch('/api/pm_stock/fifo_override/requests');
      const d = await res.json();
      if(d.status !== 'ok'){ if(body) body.innerHTML = `<div style="padding:20px;color:#b91c1c">${_esc(d.message||'Load failed')}</div>`; return; }
      const rows = d.requests || [];
      if(!rows.length){
        if(body) body.innerHTML = `<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">
          You haven't requested any FIFO overrides yet.</div>`;
        return;
      }
      if(body) body.innerHTML = rows.map(r => _myRowHtml(r)).join('');
    } catch(e){
      if(body) body.innerHTML = `<div style="padding:20px;color:#b91c1c">Network error: ${_esc(e.message)}</div>`;
    }
  };

  function _myRowHtml(r){
    const sf = _esc(r.scanned_fifo_code || '—');
    const of = _esc(r.oldest_fifo_code || '—');
    let hint = '';
    if(r.status === 'approved'){
      hint = `<div style="margin-top:8px;padding:8px 11px;background:rgba(13,148,136,.08);
        border:1px solid rgba(13,148,136,.3);border-radius:7px;font-size:11.5px;color:#0f766e">
        ✓ Approved — re-scan box <strong style="font-family:monospace">${_esc(r.box_code)}</strong> during Material OUT to send it. Single use.</div>`;
    } else if(r.status === 'pending'){
      hint = `<div style="margin-top:8px;font-size:11px;color:#92400e">⏳ Waiting for an admin to decide.</div>`;
    } else if(r.status === 'used'){
      hint = `<div style="margin-top:8px;font-size:11px;color:#475569">This override was used on ${_fmtDateTime(r.used_at)}.</div>`;
    } else if(r.status === 'rejected'){
      hint = `<div style="margin-top:8px;padding:8px 11px;background:rgba(220,38,38,.06);
        border:1px solid rgba(220,38,38,.25);border-radius:7px;font-size:11.5px;color:#991b1b">
        ✗ Rejected${r.decided_note?` — "${_esc(r.decided_note)}"`:''}. You can submit a new request with more detail.</div>`;
    }
    return `
      <div style="padding:12px;border:1px solid var(--hbdr,rgba(0,0,0,.09));border-radius:9px;margin-bottom:9px;background:#fff">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-family:monospace;font-weight:800;font-size:13px;color:var(--text,#0f172a)">${_esc(r.box_code)}</span>
          ${_statusPill(r.status)}
          <span style="font-size:10.5px;color:var(--hmuted,#9ca3af)">#${r.req_id}</span>
        </div>
        <div style="font-size:11.5px;color:var(--htxt,#374151);margin-top:4px">
          ${_esc(r.product_name || '')}${r.transfer_no?` · <span style="font-family:monospace;color:#0d9488">${_esc(r.transfer_no)}</span>`:''}
        </div>
        <div style="font-size:11px;color:var(--hmuted,#6b7280);margin-top:4px">
          Scanned <strong style="color:#dc2626;font-family:monospace">${sf}</strong>,
          older lot <strong style="color:#0d9488;font-family:monospace">${of}</strong> pending
        </div>
        <div style="font-size:11.5px;color:var(--text,#0f172a);margin-top:6px;padding:7px 10px;
          background:var(--hsurf2,#f9fafb);border-radius:6px;border-left:3px solid #f59e0b">
          <span style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#92400e">Reason</span><br>
          ${_esc(r.reason || '(none given)')}
        </div>
        <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">Requested ${_fmtDateTime(r.requested_at)}</div>
        ${hint}
      </div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // BADGE POLLING
  // ════════════════════════════════════════════════════════════════════
  window.refreshFifoOverrideBadge = async function(){
    try {
      const res = await fetch('/api/pm_stock/fifo_override/pending_count');
      const d = await res.json();
      if(d.status !== 'ok') return;
      const c = d.count || 0;
      ['fifo-override-approvals-badge','my-fifo-override-badge'].forEach(id => {
        const el = document.getElementById(id);
        if(el){
          el.style.display = c > 0 ? 'inline-block' : 'none';
          el.textContent = c > 9 ? '9+' : String(c);
        }
      });
    } catch(_){}
  };
  setTimeout(window.refreshFifoOverrideBadge, 1800);
  setInterval(() => {
    if(document.visibilityState === 'visible') window.refreshFifoOverrideBadge();
  }, 30000);

})();
