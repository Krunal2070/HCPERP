/* ═══════════════════════════════════════════════════════════════════════
   STOCK ADJUSTMENT — FRONTEND
   ─────────────────────────────────────────────────────────────────────
   Companion to the /api/pm_stock/adjustments/* endpoints in __init__.py.

   List flow:
     loadAdjList()         → fetch + render the list with status filter
     adjSetFilter(status)  → flip chip, reload

   Create / edit flow:
     openAdjModal([id])    → empty form OR populate from existing voucher
     adjAddItem([prefill]) → append a row to the items grid
     saveAdj()             → POST /save (idempotent — same call for create
                              and edit)

   Detail / admin actions:
     openAdjDetail(id)     → fetch + render the detail view + action buttons
     approveAdj(id)        → POST /approve (admin)
     rejectAdj(id)         → open reject-reason modal
     adjConfirmReject()    → POST /reject (admin)
     deleteAdj(id)         → POST /delete (own pending or admin)
     editAdjFromDetail(id) → close detail, reopen create/edit modal in
                              edit mode

   Data shared with the rest of the SPA:
     window._godowns / window._products — read-only access for the
     location dropdown and product typeahead. The list endpoint already
     returns server-computed totals so we don't re-derive them client-
     side beyond simple presentation.
═══════════════════════════════════════════════════════════════════════ */

// Current filter chip. Persists across loads within the session.
let _adjFilter = 'all';
// Currently-loaded list (last fetch). Used by detail/edit lookups to
// short-circuit when the row is already in hand.
let _adjList   = [];
// Caches what the server reported about the current viewer.
let _adjIsAdmin = false;
let _adjMe      = '';
// State for the create/edit modal. _adjEditId is null for create, an
// integer for edit-existing-voucher.
let _adjEditId  = null;
// Pending reject — stash the id while the reason modal is open.
let _adjRejectId = null;
// Auto-incrementing row id for items inside the modal. Pure UI key —
// not sent to the server.
let _adjRowSeq = 0;

// ── Filter chips ────────────────────────────────────────────────────
function adjSetFilter(status){
  _adjFilter = status;
  // Visual: highlight the active chip; reset others
  document.querySelectorAll('.adj-fbtn').forEach(b => {
    if(b.dataset.status === status){
      b.style.background    = '#f59e0b';
      b.style.color         = '#fff';
      b.style.borderColor   = '#f59e0b';
    } else {
      b.style.background    = 'var(--hsurf2,#f8fafc)';
      b.style.color         = 'var(--hmuted2,#6b7280)';
      b.style.borderColor   = 'var(--hbdr2,rgba(0,0,0,.13))';
      b.style.borderStyle   = 'solid';
      b.style.borderWidth   = '1.5px';
    }
  });
  loadAdjList();
}
window.adjSetFilter = adjSetFilter;

// ── List load + render ─────────────────────────────────────────────
async function loadAdjList(){
  const wrap = document.getElementById('adj-list-wrap');
  if(!wrap) return;  // tab not in DOM (access denied?) — bail
  wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">Loading…</div>`;
  try {
    const url = `/api/pm_stock/adjustments/list?status=${encodeURIComponent(_adjFilter)}`;
    const res = await fetch(url);
    const d   = await res.json();
    if(d.status !== 'ok'){
      wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">${d.message || 'Failed to load'}</div>`;
      return;
    }
    _adjList    = d.vouchers || [];
    _adjIsAdmin = !!d.is_admin;
    _adjMe      = d.me || '';
    _renderAdjList(wrap, _adjList);
    // Pending badge in the sidebar (admins see all pending; non-admins
    // see their own pending). Only show when count > 0 to keep the
    // sidebar quiet.
    const pending = _adjList.filter(v => (v.status || '') === 'pending').length;
    const badge = document.getElementById('sb-adj-pending');
    if(badge){
      if(pending > 0){
        badge.textContent = String(pending);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    const info = document.getElementById('adj-count-info');
    if(info) info.textContent = `${_adjList.length} voucher${_adjList.length === 1 ? '' : 's'}`;
  } catch(e){
    wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">Error: ${e.message}</div>`;
  }
}
window.loadAdjList = loadAdjList;

function _renderAdjList(wrap, rows){
  if(!rows.length){
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <div style="font-size:24px;margin-bottom:8px">📭</div>
      No stock adjustments yet${_adjFilter !== 'all' ? ` with status "${_adjFilter}"` : ''}.
    </div>`;
    return;
  }
  const fmt = n => (Number(n) || 0).toLocaleString('en-IN');
  const fmtDate = s => {
    if(!s) return '—';
    const [y, m, d] = String(s).split('T')[0].split('-');
    return (d && m && y) ? `${d}/${m}/${y}` : String(s);
  };
  const statusPill = (s) => {
    const map = {
      pending:  { bg:'rgba(245,158,11,.12)',  fg:'#d97706', txt:'Pending' },
      approved: { bg:'rgba(34,197,94,.12)',   fg:'#16a34a', txt:'Approved' },
      rejected: { bg:'rgba(239,68,68,.12)',   fg:'#dc2626', txt:'Rejected' },
    };
    const m = map[s] || { bg:'#eee', fg:'#666', txt: s || '—' };
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${m.bg};color:${m.fg};font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px">${m.txt}</span>`;
  };
  const html = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.08))">
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Voucher</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Date</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Location</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Requested By</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Lines</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:#16a34a;text-transform:uppercase;letter-spacing:.4px">+ Inc</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.4px">− Dec</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Status</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const isMine = (r.requested_by === _adjMe);
          const canDelete = (r.status !== 'approved') && (_adjIsAdmin || isMine);
          const canEdit   = (r.status !== 'approved') && (_adjIsAdmin || isMine);
          const canActAdmin = _adjIsAdmin && r.status === 'pending';
          const locLabel = _escapeHtml(r.godown_name || '—') + (r.is_floor ? ' · Floor' : '');
          return `
            <tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">
              <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:#7c3aed;cursor:pointer;white-space:nowrap" onclick="openAdjDetail(${r.id})" title="View detail">${_escapeHtml(r.adj_no || '—')}</td>
              <td style="padding:9px 12px;color:var(--htxtb,#111);white-space:nowrap">${fmtDate(r.adj_date)}</td>
              <td style="padding:9px 12px;color:var(--htxtb,#111)">${locLabel}</td>
              <td style="padding:9px 12px;color:var(--hmuted2,#6b7280)">${_escapeHtml(r.requested_by || '—')}${isMine ? ' <span style="color:#7c3aed;font-weight:700">(you)</span>' : ''}</td>
              <td style="padding:9px 12px;text-align:right;color:var(--htxtb,#111)">${r.line_count || 0}</td>
              <td style="padding:9px 12px;text-align:right;color:#16a34a;font-weight:700">${Number(r.total_increase) > 0 ? '+' + fmt(r.total_increase) : '—'}</td>
              <td style="padding:9px 12px;text-align:right;color:#dc2626;font-weight:700">${Number(r.total_decrease) > 0 ? '−' + fmt(r.total_decrease) : '—'}</td>
              <td style="padding:9px 12px">${statusPill(r.status)}</td>
              <td style="padding:9px 12px;text-align:right;white-space:nowrap">
                <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10.5px" onclick="openAdjDetail(${r.id})" title="View"><i class="fas fa-eye"></i></button>
                ${canActAdmin ? `
                  <button class="btn btn-sm" style="padding:3px 8px;font-size:10.5px;background:#16a34a;color:#fff;border:none" onclick="approveAdj(${r.id})" title="Approve & post ledger"><i class="fas fa-check"></i></button>
                  <button class="btn btn-sm" style="padding:3px 8px;font-size:10.5px;background:#dc2626;color:#fff;border:none" onclick="rejectAdj(${r.id})" title="Reject with reason"><i class="fas fa-times"></i></button>
                ` : ''}
                ${canEdit ? `<button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10.5px" onclick="openAdjModal(${r.id})" title="Edit"><i class="fas fa-pen"></i></button>` : ''}
                ${canDelete ? `<button class="btn btn-sm" style="padding:3px 8px;font-size:10.5px;background:var(--hsurf2,#f8fafc);color:#dc2626;border:1px solid rgba(239,68,68,.3)" onclick="deleteAdj(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
              </td>
            </tr>
            ${r.status === 'rejected' && r.reject_reason ? `
              <tr style="background:rgba(239,68,68,.04)">
                <td colspan="9" style="padding:6px 12px;font-size:11px;color:#dc2626">
                  <i class="fas fa-comment-dots" style="margin-right:6px"></i><strong>Reject reason:</strong> ${_escapeHtml(r.reject_reason)}
                </td>
              </tr>` : ''}
          `;
        }).join('')}
      </tbody>
    </table>
  `;
  wrap.innerHTML = html;
}

function _escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Create / edit modal ────────────────────────────────────────────
async function openAdjModal(id){
  _adjEditId = id ? Number(id) : null;
  _adjRowSeq = 0;
  const modal = document.getElementById('adjFormModal');
  if(!modal){ if(window.showToast) showToast('Modal not loaded', 'error'); return; }

  // Reset to a clean form
  document.getElementById('adj-form-title').innerHTML = _adjEditId
    ? '✏️ Edit Stock Adjustment'
    : '⚖️ New Stock Adjustment';
  document.getElementById('adj-date').value     = new Date().toISOString().slice(0,10);
  document.getElementById('adj-remarks').value  = '';
  document.getElementById('adj-items').innerHTML = '';
  document.getElementById('adj-form-status').textContent = '';

  // Populate godown dropdown from window._godowns. If empty, try loading.
  await _adjEnsureGodowns();
  _adjFillGodownSelect();

  // Open BEFORE populating edit fields so any UI tweaks land on a visible modal
  modal.classList.add('open');

  if(_adjEditId){
    // Pull voucher detail and populate
    try {
      const res = await fetch(`/api/pm_stock/adjustments/${_adjEditId}`);
      const d   = await res.json();
      if(d.status !== 'ok'){
        if(window.showToast) showToast(d.message || 'Failed to load voucher', 'error');
        closeAdjModal();
        return;
      }
      const v = d.voucher || {};
      const its = d.items || [];
      document.getElementById('adj-date').value    = String(v.adj_date || '').slice(0,10);
      document.getElementById('adj-godown').value  = String(v.godown_id || '');
      document.getElementById('adj-remarks').value = v.voucher_remarks || '';
      if(its.length){
        its.forEach(it => adjAddItem({
          product_id:   it.product_id,
          product_name: it.product_name,
          product_code: it.product_code,
          direction:    it.direction,
          qty:          it.qty,
          reason:       it.reason,
        }));
      } else {
        adjAddItem();
      }
      // If the voucher is rejected, show its reason as a sticky banner in
      // the form status area to give the user context for the resubmit.
      if(v.status === 'rejected' && v.reject_reason){
        const s = document.getElementById('adj-form-status');
        if(s){
          s.innerHTML = `<span style="color:#dc2626"><i class="fas fa-comment-dots"></i> Previously rejected: ${_escapeHtml(v.reject_reason)}. Editing will resubmit as pending.</span>`;
        }
      }
    } catch(e){
      if(window.showToast) showToast('Error: ' + e.message, 'error');
      closeAdjModal();
      return;
    }
  } else {
    // Pre-default location: NEW BHAYLA GODOWN if available, else first
    const gs = (window._godowns || []);
    const def = gs.find(g => (g.name || '').toUpperCase().includes('BHAYLA')) || gs[0];
    if(def) document.getElementById('adj-godown').value = String(def.id);
    adjAddItem();
  }
}
window.openAdjModal = openAdjModal;

function closeAdjModal(){
  const m = document.getElementById('adjFormModal');
  if(m) m.classList.remove('open');
  _adjEditId = null;
}
window.closeAdjModal = closeAdjModal;

async function _adjEnsureGodowns(){
  if((window._godowns || []).length) return;
  if(typeof loadGodowns === 'function'){
    try { await loadGodowns(); } catch(_){}
  }
}

function _adjFillGodownSelect(){
  const sel = document.getElementById('adj-godown');
  if(!sel) return;
  const cur = sel.value;
  const gs = window._godowns || [];
  sel.innerHTML = '<option value="">— Select location —</option>' +
    gs.map(g => `<option value="${g.id}">${_escapeHtml(g.name)}${g.city ? ' · ' + _escapeHtml(g.city) : ''}</option>`).join('');
  if(cur) sel.value = cur;
}

// Append one item row to the items grid. `prefill` is optional and lets
// the edit-flow restore an existing line's values.
function adjAddItem(prefill){
  prefill = prefill || {};
  const wrap = document.getElementById('adj-items');
  if(!wrap) return;
  const rowId = ++_adjRowSeq;
  const row = document.createElement('div');
  row.className = 'adj-item-row';
  row.dataset.rowid = String(rowId);
  row.style.cssText = 'display:grid;grid-template-columns:4fr 130px 110px 3fr 28px;gap:6px;padding:6px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));align-items:start;position:relative';

  // Product picker — uses a native <input> + a dropdown rendered below.
  // We keep the data-list approach simple instead of reusing the MR
  // combo (which expects more state plumbing than this voucher needs).
  const pidVal  = prefill.product_id ? String(prefill.product_id) : '';
  const pTxt    = prefill.product_id
    ? `[${prefill.product_code || ''}] ${prefill.product_name || ''}`.trim()
    : '';
  const direction = (prefill.direction || 'decrease');
  const qty     = (prefill.qty != null) ? prefill.qty : '';
  const reason  = prefill.reason || '';

  row.innerHTML = `
    <div style="position:relative">
      <input type="text" class="adj-prod-search" placeholder="Search product…" autocomplete="off"
        value="${_escapeHtml(pTxt)}"
        oninput="_adjProdSearch(this, ${rowId})"
        onfocus="_adjProdSearch(this, ${rowId})"
        onblur="setTimeout(() => _adjProdHide(${rowId}), 160)"
        style="width:100%;padding:5px 9px;font-size:11.5px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">
      <input type="hidden" class="adj-prod-id" value="${pidVal}">
      <div class="adj-prod-dd" id="adj-prod-dd-${rowId}"
        style="display:none;position:absolute;z-index:50;left:0;right:0;top:calc(100% + 2px);background:var(--hsurf,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.18));border-radius:6px;max-height:240px;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.15)"></div>
    </div>
    <select class="adj-direction"
      style="width:100%;padding:5px 9px;font-size:11.5px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">
      <option value="increase" ${direction === 'increase' ? 'selected' : ''}>+ Increase</option>
      <option value="decrease" ${direction === 'decrease' ? 'selected' : ''}>− Decrease</option>
    </select>
    <input type="number" class="adj-qty" min="0" step="any" value="${qty}" placeholder="0"
      style="width:100%;padding:5px 9px;font-size:11.5px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit;text-align:right;font-weight:700">
    <input type="text" class="adj-reason" placeholder="Reason — e.g. damage, found, miscount…" value="${_escapeHtml(reason)}"
      style="width:100%;padding:5px 9px;font-size:11.5px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">
    <button onclick="this.closest('.adj-item-row').remove()" title="Remove this line"
      style="padding:0;width:26px;height:26px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:6px;background:var(--hsurf2,#f8fafc);color:#dc2626;cursor:pointer;font-size:11px">✕</button>
  `;
  wrap.appendChild(row);
}
window.adjAddItem = adjAddItem;

// Product search inside an item row. Filters window._products by the
// typed text and shows up to 100 matches in the dropdown.
function _adjProdSearch(inp, rowId){
  const q = (inp.value || '').toLowerCase().trim();
  const dd = document.getElementById('adj-prod-dd-' + rowId);
  if(!dd) return;
  const prods = (window._products || []);
  let list = prods;
  if(q){
    list = prods.filter(p =>
      ((p.product_name || '').toLowerCase().includes(q)) ||
      ((p.product_code || '').toLowerCase().includes(q)) ||
      ((p.pm_type      || '').toLowerCase().includes(q))
    );
  }
  if(!list.length){
    dd.innerHTML = `<div style="padding:10px 12px;text-align:center;font-size:11px;color:var(--hmuted,#9ca3af)">No matches</div>`;
    dd.style.display = 'block';
    return;
  }
  const shown = list.slice(0, 100);
  // Build rows with data-* attributes so we don't have to embed
  // user-controlled strings inside a literal JS argument list (which is
  // hard to escape safely once HTML decoding runs on attribute values).
  dd.innerHTML = shown.map(p => `
    <div data-pid="${p.id}" data-code="${_escapeHtml(p.product_code || '')}" data-name="${_escapeHtml(p.product_name || '')}"
      onclick="_adjProdPickFromEl(this, ${rowId})"
      style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));font-size:11px"
      onmouseenter="this.style.background='rgba(245,158,11,.10)'"
      onmouseleave="this.style.background='transparent'">
      <div><span style="font-family:monospace;font-weight:700;color:#7c3aed;font-size:10.5px">${_escapeHtml(p.product_code || '—')}</span>
        <span style="color:var(--htxtb,#111);font-weight:700;margin-left:6px">${_escapeHtml(p.product_name || '')}</span></div>
      <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-top:1px">[${_escapeHtml(p.pm_type || '-')}]</div>
    </div>
  `).join('') + (list.length > shown.length
      ? `<div style="padding:6px;text-align:center;font-size:10px;color:var(--hmuted,#9ca3af);background:var(--hsurf2,#f8fafc)">Showing first ${shown.length} of ${list.length}</div>`
      : '');
  dd.style.display = 'block';
}
window._adjProdSearch = _adjProdSearch;

function _adjProdPick(rowId, pid, code, name){
  const row = document.querySelector(`.adj-item-row[data-rowid="${rowId}"]`);
  if(!row) return;
  row.querySelector('.adj-prod-id').value     = pid;
  row.querySelector('.adj-prod-search').value = `[${code}] ${name}`;
  _adjProdHide(rowId);
  // Move focus into qty for fast entry
  const qty = row.querySelector('.adj-qty');
  if(qty) qty.focus();
}
window._adjProdPick = _adjProdPick;

// Variant: pull product info from the clicked element's data-* attrs.
// Safer than embedding strings in an inline onclick argument list,
// because HTML attribute decoding can re-introduce quote characters
// that would break the JS literal.
function _adjProdPickFromEl(el, rowId){
  const pid  = parseInt(el.getAttribute('data-pid') || 0);
  const code = el.getAttribute('data-code') || '';
  const name = el.getAttribute('data-name') || '';
  _adjProdPick(rowId, pid, code, name);
}
window._adjProdPickFromEl = _adjProdPickFromEl;

function _adjProdHide(rowId){
  const dd = document.getElementById('adj-prod-dd-' + rowId);
  if(dd) dd.style.display = 'none';
}
window._adjProdHide = _adjProdHide;

// ── Save (create or update) ────────────────────────────────────────
async function saveAdj(){
  const dateVal   = document.getElementById('adj-date').value;
  const gidVal    = document.getElementById('adj-godown').value;
  const remarks   = document.getElementById('adj-remarks').value;
  const rows      = document.querySelectorAll('.adj-item-row');

  if(!gidVal){
    if(window.showToast) showToast('Please pick a location', 'error');
    return;
  }
  if(!rows.length){
    if(window.showToast) showToast('Please add at least one line', 'error');
    return;
  }

  const items = [];
  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    const pid   = parseInt(r.querySelector('.adj-prod-id').value || 0);
    const dir   = r.querySelector('.adj-direction').value;
    const qty   = parseFloat(r.querySelector('.adj-qty').value || 0);
    const reason = (r.querySelector('.adj-reason').value || '').trim();
    if(!pid){
      if(window.showToast) showToast(`Row ${i+1}: pick a product`, 'error');
      return;
    }
    if(!(qty > 0)){
      if(window.showToast) showToast(`Row ${i+1}: qty must be greater than zero`, 'error');
      return;
    }
    if(!reason){
      if(window.showToast) showToast(`Row ${i+1}: reason is required`, 'error');
      return;
    }
    items.push({ product_id: pid, direction: dir, qty: qty, reason: reason });
  }

  const payload = {
    adj_date:        dateVal,
    godown_id:       parseInt(gidVal),
    voucher_remarks: remarks,
    items:           items,
  };
  if(_adjEditId) payload.id = _adjEditId;

  const btn = document.getElementById('adj-save-btn');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }
  try {
    const res = await fetch('/api/pm_stock/adjustments/save', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify(payload),
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Save failed', 'error');
      return;
    }
    if(window.showToast){
      const msg = d.mode === 'updated'
        ? `✓ ${d.adj_no || 'Adjustment'} updated · pending approval`
        : `✓ ${d.adj_no || 'Adjustment'} submitted for approval`;
      showToast(msg, 'success');
    }
    closeAdjModal();
    loadAdjList();
  } catch(e){
    if(window.showToast) showToast('Error: ' + e.message, 'error');
  } finally {
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit for Approval'; }
  }
}
window.saveAdj = saveAdj;

// ── Detail view ────────────────────────────────────────────────────
async function openAdjDetail(id){
  const m = document.getElementById('adjDetailModal');
  if(!m) return;
  document.getElementById('adj-detail-body').innerHTML =
    `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">Loading…</div>`;
  document.getElementById('adj-detail-actions').innerHTML = '';
  m.classList.add('open');
  try {
    const res = await fetch(`/api/pm_stock/adjustments/${id}`);
    const d   = await res.json();
    if(d.status !== 'ok'){
      document.getElementById('adj-detail-body').innerHTML =
        `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">${d.message || 'Failed to load'}</div>`;
      return;
    }
    _renderAdjDetail(d);
  } catch(e){
    document.getElementById('adj-detail-body').innerHTML =
      `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">Error: ${e.message}</div>`;
  }
}
window.openAdjDetail = openAdjDetail;

function _renderAdjDetail(d){
  const v   = d.voucher || {};
  const its = d.items || [];
  const isAdmin = !!d.is_admin;
  const canEdit = !!d.can_edit;
  const fmt = n => (Number(n) || 0).toLocaleString('en-IN');
  const fmtDate = s => {
    if(!s) return '—';
    const [y, m, day] = String(s).split('T')[0].split('-');
    return (day && m && y) ? `${day}/${m}/${y}` : String(s);
  };
  const fmtDt = s => {
    if(!s) return '—';
    const dt = new Date(s);
    if(isNaN(dt.getTime())) return String(s);
    const pad = n => String(n).padStart(2,'0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  };
  const statusPill = (s) => {
    const map = {
      pending:  { bg:'rgba(245,158,11,.12)',  fg:'#d97706', txt:'Pending' },
      approved: { bg:'rgba(34,197,94,.12)',   fg:'#16a34a', txt:'Approved' },
      rejected: { bg:'rgba(239,68,68,.12)',   fg:'#dc2626', txt:'Rejected' },
    };
    const m = map[s] || { bg:'#eee', fg:'#666', txt: s || '—' };
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${m.bg};color:${m.fg};font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px">${m.txt}</span>`;
  };

  const dirPill = (dir) => dir === 'increase'
    ? `<span style="color:#16a34a;font-weight:800">+ Increase</span>`
    : `<span style="color:#dc2626;font-weight:800">− Decrease</span>`;

  const totalInc = its.filter(i => i.direction === 'increase').reduce((a, b) => a + Number(b.qty || 0), 0);
  const totalDec = its.filter(i => i.direction === 'decrease').reduce((a, b) => a + Number(b.qty || 0), 0);

  document.getElementById('adj-detail-body').innerHTML = `
    <div style="padding:16px 22px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));background:linear-gradient(135deg,rgba(245,158,11,.06),rgba(245,158,11,.01));position:relative">
      <button class="modal-close" onclick="closeModal('adjDetailModal')" style="position:absolute;top:14px;right:18px">✕</button>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="font-size:14px;font-weight:800;color:var(--htxtb,#111)">⚖️ Adjustment ${_escapeHtml(v.adj_no || '')}</div>
        ${statusPill(v.status)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px;font-size:11px">
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Date</div><div style="color:var(--htxtb,#111);font-weight:700">${fmtDate(v.adj_date)}</div></div>
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Location</div><div style="color:var(--htxtb,#111);font-weight:700">${_escapeHtml(v.godown_name || '—')}${v.is_floor ? ' · Floor' : ''}</div></div>
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Requested By</div><div style="color:var(--htxtb,#111);font-weight:700">${_escapeHtml(v.requested_by || '—')}</div></div>
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Requested At</div><div style="color:var(--htxtb,#111);font-weight:700">${fmtDt(v.requested_at)}</div></div>
        ${v.approved_at ? `<div><div style="color:#16a34a;font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Approved By</div><div style="color:var(--htxtb,#111);font-weight:700">${_escapeHtml(v.approved_by || '—')} · ${fmtDt(v.approved_at)}</div></div>` : ''}
        ${v.rejected_at ? `<div><div style="color:#dc2626;font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Rejected By</div><div style="color:var(--htxtb,#111);font-weight:700">${_escapeHtml(v.rejected_by || '—')} · ${fmtDt(v.rejected_at)}</div></div>` : ''}
      </div>
      ${v.voucher_remarks ? `<div style="margin-top:10px;font-size:11px;color:var(--htxtb,#111)"><strong style="color:var(--hmuted2,#6b7280)">Remarks:</strong> ${_escapeHtml(v.voucher_remarks)}</div>` : ''}
      ${v.reject_reason ? `
        <div style="margin-top:10px;padding:10px 14px;background:rgba(239,68,68,.07);border-left:3px solid #dc2626;border-radius:0 6px 6px 0">
          <div style="font-size:9.5px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Reject Reason</div>
          <div style="font-size:12px;color:var(--htxtb,#111)">${_escapeHtml(v.reject_reason)}</div>
        </div>` : ''}
    </div>
    <div style="padding:14px 22px">
      <div style="font-size:11px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Lines (${its.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;overflow:hidden;table-layout:auto">
        <thead>
          <tr style="background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.08))">
            <th style="text-align:left;padding:7px 10px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;width:auto">Product</th>
            <th style="text-align:left;padding:7px 10px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;width:110px;white-space:nowrap">Direction</th>
            <th style="text-align:right;padding:7px 10px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;width:110px;white-space:nowrap">Qty</th>
            <th style="text-align:left;padding:7px 10px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;width:220px">Reason</th>
          </tr>
        </thead>
        <tbody>
          ${its.map(it => `
            <tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">
              <td style="padding:7px 10px;color:var(--htxtb,#111);white-space:nowrap">
                <span style="font-family:monospace;font-weight:700;color:#7c3aed;font-size:10.5px">${_escapeHtml(it.product_code || '—')}</span>
                <span style="margin-left:6px">${_escapeHtml(it.product_name || '')}</span>
                <span style="color:var(--hmuted,#9ca3af);font-size:10px;margin-left:6px">[${_escapeHtml(it.pm_type || '-')}]</span>
              </td>
              <td style="padding:7px 10px;white-space:nowrap">${dirPill(it.direction)}</td>
              <td style="padding:7px 10px;text-align:right;color:var(--htxtb,#111);font-weight:700;white-space:nowrap">${fmt(it.qty)} <span style="color:var(--hmuted,#9ca3af);font-size:10px;font-weight:400">${_escapeHtml(it.primary_uom || '')}</span></td>
              <td style="padding:7px 10px;color:var(--hmuted2,#6b7280);font-size:11px;word-break:break-word">${_escapeHtml(it.reason || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr style="background:var(--hsurf2,#f8fafc);border-top:1px solid var(--hbdr,rgba(0,0,0,.08))">
            <td colspan="2" style="padding:7px 10px;font-size:11px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Totals</td>
            <td style="padding:7px 10px;text-align:right;font-size:11.5px;font-weight:800">
              <span style="color:#16a34a">+${fmt(totalInc)}</span> &nbsp;
              <span style="color:#dc2626">−${fmt(totalDec)}</span>
            </td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  // Footer actions — vary by role and status
  const actions = document.getElementById('adj-detail-actions');
  const adjId = Number(v.id);
  const buttons = [];
  if(isAdmin && v.status === 'pending'){
    buttons.push(`<button class="btn btn-sm" style="background:#16a34a;color:#fff;border:none" onclick="closeModal('adjDetailModal');approveAdj(${adjId})"><i class="fas fa-check"></i> Approve</button>`);
    buttons.push(`<button class="btn btn-sm" style="background:#dc2626;color:#fff;border:none" onclick="closeModal('adjDetailModal');rejectAdj(${adjId})"><i class="fas fa-times"></i> Reject</button>`);
  }
  if(canEdit){
    buttons.push(`<button class="btn btn-outline btn-sm" onclick="editAdjFromDetail(${adjId})"><i class="fas fa-pen"></i> Edit</button>`);
  }
  if(v.status !== 'approved' && (isAdmin || v.requested_by === d.me)){
    buttons.push(`<button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:rgba(239,68,68,.4)" onclick="deleteAdj(${adjId})"><i class="fas fa-trash"></i> Delete</button>`);
  }
  buttons.push(`<button class="btn btn-outline btn-sm" onclick="closeModal('adjDetailModal')">Close</button>`);
  actions.innerHTML = buttons.join('');
}

function editAdjFromDetail(id){
  closeModal('adjDetailModal');
  openAdjModal(id);
}
window.editAdjFromDetail = editAdjFromDetail;

// ── Approve / Reject / Delete ──────────────────────────────────────
async function approveAdj(id){
  if(!confirm('Approve this adjustment? Ledger entries will be posted immediately.')) return;
  try {
    const res = await fetch(`/api/pm_stock/adjustments/${id}/approve`, { method:'POST' });
    const d   = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Approve failed', 'error');
      return;
    }
    if(window.showToast) showToast(`✓ Approved · ${(d.posted || []).length} ledger row(s) posted`, 'success');
    loadAdjList();
  } catch(e){
    if(window.showToast) showToast('Error: ' + e.message, 'error');
  }
}
window.approveAdj = approveAdj;

function rejectAdj(id){
  _adjRejectId = id;
  const ta = document.getElementById('adj-reject-reason');
  if(ta) ta.value = '';
  const m = document.getElementById('adjRejectModal');
  if(m) m.classList.add('open');
  setTimeout(() => { if(ta) ta.focus(); }, 50);
}
window.rejectAdj = rejectAdj;

async function adjConfirmReject(){
  const ta = document.getElementById('adj-reject-reason');
  const reason = (ta && ta.value || '').trim();
  if(!reason){
    if(window.showToast) showToast('Reason is required', 'error');
    return;
  }
  const id = _adjRejectId;
  if(!id){ closeModal('adjRejectModal'); return; }
  try {
    const res = await fetch(`/api/pm_stock/adjustments/${id}/reject`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ reject_reason: reason }),
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Reject failed', 'error');
      return;
    }
    if(window.showToast) showToast('✓ Adjustment rejected', 'success');
    closeModal('adjRejectModal');
    _adjRejectId = null;
    loadAdjList();
  } catch(e){
    if(window.showToast) showToast('Error: ' + e.message, 'error');
  }
}
window.adjConfirmReject = adjConfirmReject;

async function deleteAdj(id){
  if(!confirm('Delete this adjustment voucher? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/pm_stock/adjustments/${id}/delete`, { method:'POST' });
    const d   = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Delete failed', 'error');
      return;
    }
    if(window.showToast) showToast('✓ Deleted', 'success');
    // Close detail modal if it's currently showing the deleted voucher
    closeModal('adjDetailModal');
    loadAdjList();
  } catch(e){
    if(window.showToast) showToast('Error: ' + e.message, 'error');
  }
}
window.deleteAdj = deleteAdj;

// ── Initial filter chip styling on first load ──────────────────────
// Without this, the chips look like unstyled outline buttons until the
// user clicks one. Fires once the DOM is ready and the tab exists.
function _adjInitChips(){
  if(document.getElementById('adj-f-all')){
    adjSetFilter('all');
  }
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', _adjInitChips);
} else {
  _adjInitChips();
}
