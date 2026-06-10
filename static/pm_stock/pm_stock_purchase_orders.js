/* ═══════════════════════════════════════════════════════════
   PM Purchase Orders — Phase A (read-only list)

   Owns the Purchase Orders tab: fetching, filtering, and
   rendering the list. New/Edit/Approve/Receive flows arrive
   in later phases — those buttons are placeholders today.

   Reads `/api/pm_stock/purchase_orders/list` which returns
   one row per PO with aggregated item counts and a derived
   `received_qty_total` (sum across all linked GRNs).
═══════════════════════════════════════════════════════════ */

// Last successful list payload — used by future row-click handlers so we
// don't refetch on every interaction.
window._poList = [];

async function loadPoList(){
  const tbody = document.getElementById('po-list-tbody');
  const sumEl = document.getElementById('po-list-summary');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;
  if(sumEl) sumEl.textContent = '—';

  const params = new URLSearchParams();
  const from = document.getElementById('po-from')?.value;
  const to   = document.getElementById('po-to')?.value;
  const stat = document.getElementById('po-status')?.value;
  const appr = document.getElementById('po-approval')?.value;
  const srch = document.getElementById('po-search')?.value?.trim();
  if(from) params.set('from_date', from);
  if(to)   params.set('to_date',   to);
  if(stat) params.set('status', stat);
  if(appr) params.set('approval_status', appr);
  if(srch) params.set('search', srch);

  try {
    const r = await fetch('/api/pm_stock/purchase_orders/list?' + params.toString());
    if(!r.ok){
      // Try to parse the server's JSON error for a meaningful message
      let serverMsg = '';
      try {
        const errJson = await r.json();
        serverMsg = errJson?.message || '';
      } catch(_){}
      if(r.status === 503 && serverMsg){
        // Schema not migrated — show actionable hint + offer the version check
        tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center;font-size:12px">
          <div style="color:#dc2626;font-weight:700;margin-bottom:6px">⚠ Database not ready</div>
          <div style="color:var(--htxtb,#111);font-size:11.5px;margin-bottom:8px">${_escPo(serverMsg)}</div>
          <a href="/api/pm_stock/_version" target="_blank" style="font-size:11px;color:#0d9488;text-decoration:underline">Open /api/pm_stock/_version in a new tab</a>
          <span style="color:var(--hmuted,#9ca3af);font-size:10.5px"> to see which migrations are missing.</span>
        </td></tr>`;
        return;
      }
      tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center;color:#dc2626;font-size:12px">Failed to load (HTTP ${r.status}).${serverMsg ? ' ' + _escPo(serverMsg) : ''} Has the database migration run? Try restarting Flask.</td></tr>`;
      return;
    }
    const data = await r.json();
    window._poList = Array.isArray(data) ? data : [];
    _renderPoList(window._poList);
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center;color:#dc2626;font-size:12px">Network error: ${e.message}</td></tr>`;
  }
}

function _renderPoList(rows){
  const tbody = document.getElementById('po-list-tbody');
  const sumEl = document.getElementById('po-list-summary');
  if(!tbody) return;
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="10" style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <div style="font-size:13px;color:var(--htxtb,#111);margin-bottom:4px">No purchase orders yet</div>
      <div style="font-size:10.5px">POs are created in Phase B — once available, they'll appear here.</div>
    </td></tr>`;
    if(sumEl) sumEl.textContent = '0 POs';
    return;
  }
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const fmtD = s => s ? String(s).split('T')[0].split(' ')[0] : '—';

  // Status pill colors are derived from the two-axis model. The user reads
  // both pills together: "open + approved" = ready to receive.
  const statusPill = (s) => {
    const colors = {
      draft:     { bg:'#f1f5f9', fg:'#475569', label:'draft' },
      open:      { bg:'#dbeafe', fg:'#1d4ed8', label:'open' },
      partial:   { bg:'#fed7aa', fg:'#9a3412', label:'partial' },
      closed:    { bg:'#bbf7d0', fg:'#15803d', label:'closed' },
      cancelled: { bg:'#fecaca', fg:'#991b1b', label:'cancelled' },
    };
    const c = colors[s] || { bg:'#f1f5f9', fg:'#64748b', label: s || '—' };
    return `<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${c.bg};color:${c.fg};font-size:10px;font-weight:800;letter-spacing:.3px;text-transform:uppercase">${c.label}</span>`;
  };
  const apprPill = (s) => {
    const colors = {
      pending:  { bg:'#fef3c7', fg:'#92400e', label:'⏳ pending' },
      approved: { bg:'#bbf7d0', fg:'#15803d', label:'✓ approved' },
      rejected: { bg:'#fecaca', fg:'#991b1b', label:'✗ rejected' },
    };
    const c = colors[s] || { bg:'#f1f5f9', fg:'#64748b', label: s || '—' };
    return `<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${c.bg};color:${c.fg};font-size:10px;font-weight:800;letter-spacing:.3px">${c.label}</span>`;
  };

  tbody.innerHTML = rows.map((r, i) => {
    const totalQty = Number(r.total_qty_primary)||0;
    const rcvd     = Number(r.received_qty_total)||0;
    const pct      = totalQty > 0 ? Math.min(100, (rcvd/totalQty)*100) : 0;
    const pctTxt   = totalQty > 0 ? ` <span style="font-size:9px;color:var(--hmuted,#9ca3af)">(${pct.toFixed(0)}% received)</span>` : '';
    return `
    <tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));font-size:12px">
      <td style="padding:8px 10px;color:var(--hmuted,#9ca3af);font-size:11px">${i+1}</td>
      <td style="padding:8px 10px;font-family:var(--font-mono,monospace);font-weight:700;color:#0d9488">${_escPo(r.po_num)}</td>
      <td style="padding:8px 10px;white-space:nowrap">${fmtD(r.po_date)}</td>
      <td style="padding:8px 10px">${_escPo(r.supplier_name || '—')}</td>
      <td style="padding:8px 10px;text-align:center">${r.item_count || 0}</td>
      <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtN(totalQty)}${pctTxt}</td>
      <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${r.grand_total ? '₹ '+fmtN(Number(r.grand_total).toFixed(2)) : '—'}</td>
      <td style="padding:8px 10px;text-align:center">${statusPill(r.status)}</td>
      <td style="padding:8px 10px;text-align:center">${apprPill(r.approval_status)}</td>
      <td style="padding:6px 10px;text-align:center;white-space:nowrap">
        ${_poRowActions(r)}
      </td>
    </tr>`;
  }).join('');

  if(sumEl){
    const counts = { draft:0, open:0, partial:0, closed:0, cancelled:0 };
    rows.forEach(r => { if(counts.hasOwnProperty(r.status)) counts[r.status]++; });
    const parts = [];
    if(counts.draft)     parts.push(`${counts.draft} draft`);
    if(counts.open)      parts.push(`${counts.open} open`);
    if(counts.partial)   parts.push(`${counts.partial} partial`);
    if(counts.closed)    parts.push(`${counts.closed} closed`);
    if(counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
    sumEl.textContent = `${rows.length} PO${rows.length===1?'':'s'} · ` + (parts.join(' · ') || '—');
  }
}

// Decide which action buttons are sensible for a PO row given its lifecycle.
// • Draft / pending     → View, Edit, Approve, Reject, Cancel
// • Open / pending      → View, Edit, Approve, Reject, Cancel
// • Open / approved     → View, (Edit allowed — header & non-line tweaks)
// • Partial / approved  → View only (line edits locked by backend anyway)
// • Closed / Cancelled / Rejected → View only
function _poRowActions(r){
  const isCancelled = r.status === 'cancelled';
  const isClosed    = r.status === 'closed';
  const isRejected  = r.approval_status === 'rejected';
  const isApproved  = r.approval_status === 'approved';
  const hasReceipts = (Number(r.received_qty_total) || 0) > 0;
  // 'View' is always shown (read-only summary modal — reuses the form modal in disabled mode).
  const btn = (icon, label, fn, color, title) =>
    `<button class="btn btn-sm" onclick="${fn}" title="${title}" style="padding:3px 8px;font-size:11px;background:${color};color:#fff;border:none;border-radius:5px;margin:0 1px"><i class="fas fa-${icon}"></i> ${label}</button>`;
  const out = [];
  out.push(btn('eye',   '',        `viewPo(${r.id})`,      '#64748b', 'View'));
  if(!isClosed && !isCancelled && !isRejected){
    out.push(btn('edit', '',       `editPo(${r.id})`,      '#0d9488', 'Edit'));
  }
  if(!isApproved && !isRejected && !isCancelled){
    out.push(btn('check','',       `approvePo(${r.id})`,   '#16a34a', 'Approve'));
    out.push(btn('times','',       `openRejectPo(${r.id},'${_escPo(r.po_num)}')`, '#dc2626', 'Reject'));
  }
  if(!isApproved && !isCancelled && !isClosed && !hasReceipts){
    out.push(btn('ban', '',        `cancelPo(${r.id},'${_escPo(r.po_num)}')`,    '#92400e', 'Cancel'));
  }
  return out.join('');
}

function _escPo(s){
  if(s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Expose globals so the sidebar onclick + switchTab handler find them.
window.loadPoList = loadPoList;

/* ═══════════════════════════════════════════════════════════════════
   Phase B — PO Form (create + edit), Approve / Reject / Cancel,
   and the PO Picker used by the GRN modal.

   State conventions:
     • _poForm.mode   = 'create' | 'edit' — set by openPoForm() / editPo().
     • _poForm.lockedLines = product IDs whose qty cannot drop below received
       qty (only relevant in edit mode of an already-approved PO).
   All fetch errors are toasted via showToast() (defined globally). We don't
   own that helper; we just call it. If it's missing we fall back to alert().
   ═══════════════════════════════════════════════════════════════════ */

const _poForm = { mode:'create', editingId:null, lockedLines:{} };
let _poFormRowCounter = 0;

function _poToast(msg, type, ms){
  if(typeof showToast === 'function') showToast(msg, type||'info', ms||3000);
  else { try { alert(msg); } catch(_){} }
}

// ── Open PO Form for CREATE ───────────────────────────────────────────
async function openPoForm(){
  _poForm.mode = 'create';
  _poForm.editingId = null;
  _poForm.lockedLines = {};
  _resetPoForm();
  // Today as default
  const t = new Date(); const iso = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  document.getElementById('po-form-date').value = iso;
  document.getElementById('po-form-title').textContent = '📋 New Purchase Order';
  document.getElementById('po-form-vno').style.display = 'none';
  await _poPopulateGodowns();
  // Ensure suppliers are loaded — the user may not have visited the Suppliers tab yet
  if(!(window._supRows || []).length && typeof loadSuppliers === 'function'){
    try { await loadSuppliers(); } catch(_){}
  }
  if(!(window._products || []).length && typeof loadProducts === 'function'){
    try { await loadProducts(); } catch(_){}
  }
  // Start with one empty line so the form isn't blank
  addPoFormRow();
  if(typeof openModal === 'function') openModal('poFormModal');
  else document.getElementById('poFormModal').classList.add('open');
}

// ── Open PO Form for EDIT ─────────────────────────────────────────────
async function editPo(poId){
  _poForm.mode = 'edit';
  _poForm.editingId = poId;
  _poForm.lockedLines = {};
  _resetPoForm();
  document.getElementById('po-form-title').textContent = '✏️ Edit Purchase Order';
  await _poPopulateGodowns();
  if(!(window._supRows || []).length && typeof loadSuppliers === 'function'){
    try { await loadSuppliers(); } catch(_){}
  }
  if(!(window._products || []).length && typeof loadProducts === 'function'){
    try { await loadProducts(); } catch(_){}
  }
  // Fetch the PO + its lines
  let d;
  try {
    const r = await fetch(`/api/pm_stock/purchase_orders/${poId}`);
    d = await r.json();
  } catch(e){ _poToast('Network error: '+e.message,'error'); return; }
  if(d.status !== 'ok'){ _poToast(d.message || 'Failed to load PO','error'); return; }
  const h = d.header || {};
  // Header
  document.getElementById('po-form-id').value      = h.id || '';
  document.getElementById('po-form-date').value    = (h.po_date || '').slice(0,10);
  document.getElementById('po-form-supplier-id').value = h.supplier_id || '';
  document.getElementById('po-form-supplier').value    = h.supplier_name || '';
  document.getElementById('po-form-godown').value      = h.godown_id || '';
  document.getElementById('po-form-delivery-date').value = (h.delivery_date || '').slice(0,10);
  document.getElementById('po-form-delivery-days').value = h.delivery_days || '';
  document.getElementById('po-form-status').value  = (h.status === 'partial' || h.status === 'closed') ? 'open' : (h.status || 'draft');
  document.getElementById('po-form-freight').value = h.freight_charge || 0;
  document.getElementById('po-form-packing').value = h.packing_charge || 0;
  document.getElementById('po-form-remarks').value = h.remarks || '';
  const vno = document.getElementById('po-form-vno');
  if(vno){ vno.textContent = h.po_num || ''; vno.style.display = h.po_num ? '' : 'none'; }
  // Lines — and stash received qty per product so the row can enforce a floor
  (d.items || []).forEach(it => {
    const rcvd = Number(it.received_qty)||0;
    if(rcvd > 0) _poForm.lockedLines[it.product_id] = (_poForm.lockedLines[it.product_id] || 0) + rcvd;
    addPoFormRow(it);
  });
  if(!(d.items || []).length) addPoFormRow();
  poFormRecalc();
  if(typeof openModal === 'function') openModal('poFormModal');
  else document.getElementById('poFormModal').classList.add('open');
}

// View-only mode is just edit() rendered with the save button hidden,
// but we keep it dumb for now — same modal, user can close without changes.
function viewPo(poId){ editPo(poId); }

function _resetPoForm(){
  document.getElementById('po-form-id').value = '';
  document.getElementById('po-form-supplier-id').value = '';
  document.getElementById('po-form-supplier').value = '';
  document.getElementById('po-form-delivery-date').value = '';
  document.getElementById('po-form-delivery-days').value = '';
  document.getElementById('po-form-freight').value = 0;
  document.getElementById('po-form-packing').value = 0;
  document.getElementById('po-form-remarks').value = '';
  document.getElementById('po-form-items-container').innerHTML = '';
  document.getElementById('po-form-line-total').textContent = '₹ 0.00';
  document.getElementById('po-form-fp-total').textContent   = '₹ 0.00';
  document.getElementById('po-form-grand-total').textContent= '₹ 0.00';
  _poFormRowCounter = 0;
}

async function _poPopulateGodowns(){
  const sel = document.getElementById('po-form-godown');
  if(!sel) return;
  if(!(window._godowns || []).length && typeof loadGodowns === 'function'){
    try { await loadGodowns(); } catch(_){}
  }
  const gs = window._godowns || [];
  sel.innerHTML = `<option value="">— Any / not specified —</option>` +
    gs.map(g => `<option value="${g.id}">${_escPo(g.name)}</option>`).join('');
}

// ── Supplier typeahead (uses window._supRows populated by loadSuppliers) ──
function poFormSupplierFilter(q){
  const dd = document.getElementById('po-form-supplier-dd');
  if(!dd) return;
  const all = window._supRows || [];
  const term = (q||'').trim().toLowerCase();
  const matches = term
    ? all.filter(s => (s.supplier_name||'').toLowerCase().includes(term)).slice(0, 30)
    : all.slice(0, 30);
  if(!matches.length){
    dd.innerHTML = `<div style="padding:8px 12px;color:var(--hmuted,#9ca3af);font-size:11px">No suppliers match. ${all.length?'':'Visit Suppliers tab to load.'}</div>`;
    dd.style.display = 'block';
    return;
  }
  dd.innerHTML = matches.map(s => `
    <div style="padding:7px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))"
         onmousedown="event.preventDefault()"
         onclick="poFormPickSupplier(${s.id}, '${_escPo(s.supplier_name).replace(/'/g, '&#39;')}')">
      <b>${_escPo(s.supplier_name)}</b>
      ${s.city ? `<span style="color:var(--hmuted,#9ca3af);font-size:10px"> · ${_escPo(s.city)}</span>` : ''}
    </div>`).join('');
  dd.style.display = 'block';
}

function poFormPickSupplier(id, name){
  document.getElementById('po-form-supplier-id').value = id;
  document.getElementById('po-form-supplier').value = name;
  document.getElementById('po-form-supplier-dd').style.display = 'none';
}

// Hide dropdown when user clicks outside the supplier field
document.addEventListener('click', (e) => {
  const dd = document.getElementById('po-form-supplier-dd');
  const inp = document.getElementById('po-form-supplier');
  if(!dd || !inp) return;
  if(e.target !== inp && !dd.contains(e.target)) dd.style.display = 'none';
});

// ── Line item row ─────────────────────────────────────────────────────
// `pre` (optional) is an existing item record from the API to pre-fill.
function addPoFormRow(pre){
  const wrap = document.getElementById('po-form-items-container');
  if(!wrap) return;
  _poFormRowCounter++;
  const rid = _poFormRowCounter;
  const row = document.createElement('div');
  row.className = 'po-form-row';
  row.dataset.rowId = rid;
  row.style.cssText = 'display:grid;grid-template-columns:1fr 90px 90px 110px 110px 80px 130px 80px 28px;gap:6px;padding:6px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));align-items:center';
  row.innerHTML = `
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="po-row-product" value="${pre?pre.product_id:''}">
      <input type="hidden" class="po-row-uom-primary" value="${pre?(pre.primary_uom||'Nos'):'Nos'}">
      <input type="text" class="prod-combo-input po-row-product-name" placeholder="Type to search product…" autocomplete="off"
        value="${pre?_escPo(pre.product_name||''):''}"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:1100;background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="po-row-qty" min="0" step="0.001" value="${pre?(pre.qty||0):''}"
      oninput="poFormLineRecalc(this)"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:right">
    <input type="text" class="po-row-uom" placeholder="${pre?(pre.primary_uom||'Nos'):'Nos'}" value="${pre?(pre.entered_uom||pre.primary_uom||'Nos'):''}"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;color:var(--text,#111);outline:none;text-align:center">
    <input type="number" class="po-row-rate" min="0" step="0.0001" value="${pre?(pre.rate||0):''}" placeholder="0"
      oninput="poFormLineRecalc(this)"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 6px;font-size:12px;color:var(--text,#111);outline:none;text-align:right">
    <input type="number" class="po-row-amount" min="0" step="0.01" value="${pre?(pre.amount||0):''}" placeholder="0" readonly
      style="width:100%;background:rgba(13,148,136,.08);border:1.5px solid rgba(13,148,136,.25);border-radius:6px;padding:6px 6px;font-size:12px;font-weight:700;color:var(--teal,#0d9488);outline:none;text-align:right;cursor:not-allowed"
      title="Auto-calculated: Qty × Rate">
    <input type="number" class="po-row-gst" min="0" max="100" step="0.01" value="${pre?(pre.gst_rate||0):''}" placeholder="0"
      oninput="poFormLineRecalc(this)"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;color:var(--text,#111);outline:none;text-align:right">
    <input type="text" class="po-row-remarks" value="${pre?_escPo(pre.remarks||''):''}" placeholder="Optional…"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <span class="po-row-line-total" style="text-align:right;font-size:12px;font-weight:800;color:var(--htxtb,#111);font-variant-numeric:tabular-nums">₹ 0</span>
    <button onclick="this.closest('.po-form-row').remove();poFormRecalc()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center">✕</button>`;
  wrap.appendChild(row);
  // Wire up the product picker. We piggy-back on the existing _initProdCombo
  // helper used by the GRN modal — it expects `.prod-combo-wrap`, hidden
  // `.po-row-product`, and the input to be inside. Our row matches that.
  if(typeof _initProdCombo === 'function'){
    _initProdCombo(row.querySelector('.prod-combo-wrap'), '.po-row-qty', (p) => {
      // Fired when a product is selected — set the hidden product_id, capture
      // the canonical UOM, and focus the qty field. The combo's built-in
      // "focus next" lookup uses .closest('.mtv-item-row,.grn-item-row,...')
      // which doesn't know about .po-form-row, so we do it ourselves.
      if(p && p.id){
        row.querySelector('.po-row-product').value = p.id;
        row.querySelector('.po-row-uom-primary').value = p.primary_uom || 'Nos';
        const uomI = row.querySelector('.po-row-uom');
        if(!uomI.value) uomI.placeholder = p.primary_uom || 'Nos';
        setTimeout(() => row.querySelector('.po-row-qty')?.focus(), 0);
      }
    });
  }
  // If pre-filling, compute the row total
  if(pre) poFormLineRecalc(row.querySelector('.po-row-qty'));
}

// Per-row math: amount = qty * rate; line_total = amount + gst.
// We update the row inline + recalc the footer totals.
function poFormLineRecalc(srcEl){
  const row = srcEl.closest('.po-form-row');
  if(!row) return;
  const qty  = parseFloat(row.querySelector('.po-row-qty')?.value) || 0;
  const rate = parseFloat(row.querySelector('.po-row-rate')?.value) || 0;
  const gst  = parseFloat(row.querySelector('.po-row-gst')?.value) || 0;
  const amount = +(qty * rate).toFixed(4);
  const gstAmt = +(amount * gst / 100).toFixed(4);
  const lineTotal = +(amount + gstAmt).toFixed(2);
  row.querySelector('.po-row-amount').value = amount.toFixed(2);
  row.querySelector('.po-row-line-total').textContent = '₹ ' + lineTotal.toLocaleString('en-IN');
  poFormRecalc();
}

// Footer math: sum all rows, add freight + packing.
function poFormRecalc(){
  const rows = document.querySelectorAll('#po-form-items-container .po-form-row');
  let lineSum = 0;
  rows.forEach(row => {
    const qty  = parseFloat(row.querySelector('.po-row-qty')?.value) || 0;
    const rate = parseFloat(row.querySelector('.po-row-rate')?.value) || 0;
    const gst  = parseFloat(row.querySelector('.po-row-gst')?.value) || 0;
    const amount = qty * rate;
    lineSum += amount + (amount * gst / 100);
  });
  const fr = parseFloat(document.getElementById('po-form-freight')?.value) || 0;
  const pk = parseFloat(document.getElementById('po-form-packing')?.value) || 0;
  const grand = lineSum + fr + pk;
  const fmt = n => '₹ ' + Number(n).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  document.getElementById('po-form-line-total').textContent = fmt(lineSum);
  document.getElementById('po-form-fp-total').textContent   = fmt(fr + pk);
  document.getElementById('po-form-grand-total').textContent= fmt(grand);
}

// ── Save (create or update) ───────────────────────────────────────────
async function savePoForm(){
  const id        = document.getElementById('po-form-id').value || null;
  const po_date   = document.getElementById('po-form-date').value;
  const supplier_id   = parseInt(document.getElementById('po-form-supplier-id').value) || null;
  const supplier_name = document.getElementById('po-form-supplier').value.trim();
  const godown_id = parseInt(document.getElementById('po-form-godown').value) || null;
  const delivery_date = document.getElementById('po-form-delivery-date').value || null;
  const delivery_days = parseInt(document.getElementById('po-form-delivery-days').value) || null;
  const status    = document.getElementById('po-form-status').value || 'draft';
  const remarks   = document.getElementById('po-form-remarks').value.trim();
  const freight_charge = parseFloat(document.getElementById('po-form-freight').value) || 0;
  const packing_charge = parseFloat(document.getElementById('po-form-packing').value) || 0;

  if(!po_date)       { _poToast('PO date is required','error'); return; }
  if(!supplier_name) { _poToast('Supplier is required','error'); return; }

  const items = [];
  document.querySelectorAll('#po-form-items-container .po-form-row').forEach(row => {
    const pid = parseInt(row.querySelector('.po-row-product')?.value) || 0;
    const qty = parseFloat(row.querySelector('.po-row-qty')?.value) || 0;
    if(!pid || qty <= 0) return;
    const rate = parseFloat(row.querySelector('.po-row-rate')?.value) || 0;
    const gst  = parseFloat(row.querySelector('.po-row-gst')?.value) || 0;
    const amount = +(qty * rate).toFixed(4);
    const uom = (row.querySelector('.po-row-uom')?.value || '').trim() ||
                (row.querySelector('.po-row-uom-primary')?.value || 'Nos');
    items.push({
      product_id: pid,
      qty,
      entered_uom: uom,
      entered_qty: qty,
      qty_primary: qty,  // assume entered uom = primary uom for now
      rate,
      amount,
      gst_rate: gst,
      cgst_amount: +(amount * gst / 200).toFixed(4),
      sgst_amount: +(amount * gst / 200).toFixed(4),
      remarks: (row.querySelector('.po-row-remarks')?.value || '').trim()
    });
  });
  if(!items.length){ _poToast('Add at least one line with qty > 0','error'); return; }

  // Client-side guard on locked lines (server enforces too).
  if(_poForm.mode === 'edit'){
    const newSums = {};
    items.forEach(it => { newSums[it.product_id] = (newSums[it.product_id]||0) + it.qty_primary; });
    for(const [pid, rcv] of Object.entries(_poForm.lockedLines)){
      if((newSums[pid]||0) < Number(rcv)){
        _poToast(`Cannot reduce qty for a product below already-received ${rcv}`, 'error', 5000);
        return;
      }
    }
  }

  const body = { id: id || undefined, po_date, supplier_id, supplier_name, godown_id,
                 delivery_date, delivery_days, status, remarks,
                 freight_charge, packing_charge, items };
  const btn = document.getElementById('po-form-save-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…'; }
  try {
    const r = await fetch('/api/pm_stock/purchase_orders/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if(d.status === 'ok'){
      _poToast(d.mode === 'create' ? `✓ PO ${d.po_num} created` : '✓ PO updated', 'success');
      if(typeof closeModal === 'function') closeModal('poFormModal');
      else document.getElementById('poFormModal').classList.remove('open');
      if(typeof loadPoList === 'function') loadPoList();
    } else {
      _poToast(d.message || 'Save failed', 'error', 5000);
    }
  } catch(e){ _poToast('Network error: '+e.message,'error'); }
  finally { if(btn){ btn.disabled=false; btn.innerHTML=origHTML; } }
}

// ── Approve / Reject / Cancel ─────────────────────────────────────────
async function approvePo(poId){
  if(!confirm('Approve this PO? Once approved, line quantities cannot be reduced below already-received quantities.')) return;
  try {
    const r = await fetch(`/api/pm_stock/purchase_orders/${poId}/approve`, { method:'POST' });
    const d = await r.json();
    if(d.status === 'ok'){
      _poToast('✓ PO approved', 'success');
      loadPoList();
    } else {
      _poToast(d.message || 'Approve failed','error');
    }
  } catch(e){ _poToast('Network error: '+e.message,'error'); }
}

function openRejectPo(poId, poNum){
  document.getElementById('po-reject-id').value = poId;
  document.getElementById('po-reject-num').textContent = poNum || '';
  document.getElementById('po-reject-reason').value = '';
  if(typeof openModal === 'function') openModal('poRejectModal');
  else document.getElementById('poRejectModal').classList.add('open');
  setTimeout(()=>document.getElementById('po-reject-reason')?.focus(), 80);
}

async function submitPoReject(){
  const poId   = parseInt(document.getElementById('po-reject-id').value) || 0;
  const reason = document.getElementById('po-reject-reason').value.trim();
  if(!poId) return;
  if(!reason){ _poToast('Reason is required','error'); return; }
  try {
    const r = await fetch(`/api/pm_stock/purchase_orders/${poId}/reject`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ reason })
    });
    const d = await r.json();
    if(d.status === 'ok'){
      _poToast('✓ PO rejected','success');
      if(typeof closeModal === 'function') closeModal('poRejectModal');
      else document.getElementById('poRejectModal').classList.remove('open');
      loadPoList();
    } else {
      _poToast(d.message || 'Reject failed','error', 5000);
    }
  } catch(e){ _poToast('Network error: '+e.message,'error'); }
}

async function cancelPo(poId, poNum){
  if(!confirm(`Cancel PO ${poNum||''}? This is reversible only by creating a new PO.`)) return;
  try {
    const r = await fetch(`/api/pm_stock/purchase_orders/${poId}/cancel`, { method:'POST' });
    const d = await r.json();
    if(d.status === 'ok'){
      _poToast('✓ PO cancelled','success');
      loadPoList();
    } else {
      _poToast(d.message || 'Cancel failed','error');
    }
  } catch(e){ _poToast('Network error: '+e.message,'error'); }
}

// ── PO Picker (called from GRN modal) ─────────────────────────────────
function openPoPickerForGrn(){
  if(typeof openModal === 'function') openModal('poPickerModal');
  else document.getElementById('poPickerModal').classList.add('open');
  document.getElementById('po-picker-search').value = '';
  loadPoPickerList();
  setTimeout(()=>document.getElementById('po-picker-search')?.focus(), 80);
}

async function loadPoPickerList(){
  const tbody = document.getElementById('po-picker-tbody');
  if(!tbody) return;
  const q = document.getElementById('po-picker-search')?.value?.trim() || '';
  const params = new URLSearchParams();
  // Only POs that are approved AND not in a terminal state make sense to receive against.
  params.set('approval_status', 'approved');
  params.set('status', 'open,partial');
  if(q) params.set('search', q);
  tbody.innerHTML = `<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;
  try {
    const r = await fetch('/api/pm_stock/purchase_orders/list?' + params.toString());
    if(!r.ok){
      tbody.innerHTML = `<tr><td colspan="8" style="padding:20px;text-align:center;color:#dc2626;font-size:12px">Failed (HTTP ${r.status})</td></tr>`;
      return;
    }
    const data = await r.json();
    const rows = Array.isArray(data) ? data : [];
    if(!rows.length){
      tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">No approved open/partial POs found.</td></tr>`;
      return;
    }
    const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
    const fmtD = s => s ? String(s).slice(0,10).split('-').reverse().join('/') : '—';
    tbody.innerHTML = rows.map(r => {
      const pending = Math.max(0, (Number(r.total_qty_primary)||0) - (Number(r.received_qty_total)||0));
      return `<tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));font-size:12px">
        <td style="padding:7px 10px;font-family:monospace;font-weight:700;color:#0d9488">${_escPo(r.po_num)}</td>
        <td style="padding:7px 10px">${fmtD(r.po_date)}</td>
        <td style="padding:7px 10px">${_escPo(r.supplier_name||'—')}</td>
        <td style="padding:7px 10px;text-align:center">${r.item_count||0}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtN(r.total_qty_primary)}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtN(r.received_qty_total)}<span style="color:var(--hmuted,#9ca3af);font-size:10px"> (${fmtN(pending)} pend.)</span></td>
        <td style="padding:7px 10px;text-align:center;font-size:10px;text-transform:uppercase;font-weight:800;color:#1d4ed8">${_escPo(r.status)}</td>
        <td style="padding:7px 10px;text-align:center">
          <button class="btn btn-sm" onclick="pickPoForGrn(${r.id})" style="padding:3px 10px;font-size:11px;background:#0d9488;color:#fff;border:none;border-radius:5px">
            <i class="fas fa-arrow-right"></i> Use
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="8" style="padding:20px;text-align:center;color:#dc2626;font-size:12px">Error: ${_escPo(e.message)}</td></tr>`;
  }
}

// User picked a PO from the picker — fetch it and populate the GRN modal.
async function pickPoForGrn(poId){
  try {
    const r = await fetch(`/api/pm_stock/purchase_orders/${poId}`);
    const d = await r.json();
    if(d.status !== 'ok'){ _poToast(d.message||'Failed to load PO','error'); return; }
    const h = d.header || {};
    // Fill GRN header
    document.getElementById('grn-po-id').value      = h.id;
    document.getElementById('grn-po-number').value  = h.po_num || '';
    document.getElementById('grn-po-date').value    = (h.po_date||'').slice(0,10);
    const supTxt = document.getElementById('grn-supplier-text') || document.getElementById('grn-supplier');
    if(supTxt) supTxt.value = h.supplier_name || '';
    if(h.godown_id){
      const gSel = document.getElementById('grn-godown');
      if(gSel) gSel.value = h.godown_id;
    }
    // Reveal the "clear" button so user can detach the link if they change their mind
    const cb = document.getElementById('grn-po-clear-btn');
    if(cb) cb.style.display = '';
    // Wipe existing GRN line rows and rebuild from PO items minus any already received
    const itemsWrap = document.getElementById('grn-items-container');
    if(itemsWrap){
      itemsWrap.innerHTML = '';
      (d.items || []).forEach(it => {
        const pending = Math.max(0, (Number(it.qty_primary)||0) - (Number(it.received_qty)||0));
        if(pending <= 0) return;  // line fully received — skip
        if(typeof addGrnItem !== 'function') return;
        addGrnItem();
        const row = itemsWrap.lastElementChild;
        if(!row) return;
        // Find the prod-combo and set the product + name. Fall back if helpers absent.
        const hidPid = row.querySelector('.grn-item-product');
        const visIn  = row.querySelector('.prod-combo-input');
        if(hidPid) hidPid.value = it.product_id;
        if(visIn)  visIn.value  = it.product_name || '';
        // Set qty (read-only since GRN derives from boxes × per-box) — but if
        // there are no boxes, we leave No. of Box / Per-box empty for operator
        // to enter; the qty field is computed. We can at least seed the qty
        // intent by writing it into the readonly field directly.
        const qF = row.querySelector('.grn-item-qty');
        if(qF) qF.value = pending;
        // Pre-fill rate from the PO line so ABC Analysis picks up rates
        // automatically for receipts that flow through a PO. Operator can
        // still edit before save if the actual invoice rate differs.
        const rF = row.querySelector('.grn-item-rate');
        if(rF && Number(it.rate)) rF.value = it.rate;
      });
      // If nothing got added (all lines fully received), add one empty row so
      // the operator can still post a manual adjustment if needed.
      if(!itemsWrap.children.length && typeof addGrnItem === 'function') addGrnItem();
    }
    if(typeof closeModal === 'function') closeModal('poPickerModal');
    else document.getElementById('poPickerModal').classList.remove('open');
    _poToast(`✓ PO ${h.po_num} loaded — ${(d.items||[]).length} line${(d.items||[]).length>1?'s':''}`, 'success', 3500);
  } catch(e){ _poToast('Network error: '+e.message,'error'); }
}

function clearGrnPoLink(){
  document.getElementById('grn-po-id').value = '';
  document.getElementById('grn-po-number').value = '';
  document.getElementById('grn-po-date').value = '';
  const cb = document.getElementById('grn-po-clear-btn');
  if(cb) cb.style.display = 'none';
  _poToast('PO link cleared','info', 2000);
}

// Expose globals so HTML inline onclick handlers find them.
window.openPoForm          = openPoForm;
window.editPo              = editPo;
window.viewPo              = viewPo;
window.addPoFormRow        = addPoFormRow;
window.savePoForm          = savePoForm;
window.poFormRecalc        = poFormRecalc;
window.poFormLineRecalc    = poFormLineRecalc;
window.poFormSupplierFilter= poFormSupplierFilter;
window.poFormPickSupplier  = poFormPickSupplier;
window.approvePo           = approvePo;
window.openRejectPo        = openRejectPo;
window.submitPoReject      = submitPoReject;
window.cancelPo            = cancelPo;
window.openPoPickerForGrn  = openPoPickerForGrn;
window.loadPoPickerList    = loadPoPickerList;
window.pickPoForGrn        = pickPoForGrn;
window.clearGrnPoLink      = clearGrnPoLink;
