/* ═══════════════════════════════════════════════════════════════════════
   DELIVERY NOTE (DN) — HCP Wellness → Supplier, reduces godown stock
═══════════════════════════════════════════════════════════════════════ */

let _dnList = [];
window._pag = window._pag || {};
_pag.dn = { page: 1, pp: 15 };

/* ── Open new DN modal ── */
async function openDnModal() {
  const sv = (id,v) => { const e=document.getElementById(id); if(e) e.value=v; };
  const today = new Date().toISOString().slice(0,10);
  sv('dn-date', today);
  sv('dn-supplier',''); sv('dn-supplier-text','');
  sv('dn-reference-no',''); sv('dn-reference-date','');
  sv('dn-reason',''); sv('dn-remarks','');
  sv('dn-supervisor', _loginUserName ? _loginUserName() : '');
  const c = document.getElementById('dn-items-container'); if(c) c.innerHTML = '';
  const badge = document.getElementById('pmv-dn-badge'); if(badge) badge.style.display='none';
  const vnoBar = document.getElementById('dn-vno-bar'); if(vnoBar) vnoBar.style.display='none';

  if(!_godowns || !_godowns.length) await loadGodowns();
  // Populate godown select — exclude floor locations (DN is from godowns only)
  const sel = document.getElementById('dn-godown');
  if(sel) {
    sel.innerHTML = '<option value="">— Select godown —</option>' +
      (_godowns||[]).filter(g => !g.is_floor).map(g => `<option value="${g.id}">${godownLabel ? godownLabel(g) : g.name}</option>`).join('');
  }

  // Init supplier combo
  const w = document.getElementById('dn-sup-wrap');
  if(w) {
    if(!_supRows || !_supRows.length) {
      loadSuppliers().then(() => _initSupplierCombo(w));
    } else {
      _initSupplierCombo(w);
    }
  }

  document.getElementById('pmDnModal').classList.add('open');
  if(typeof applyHomeGodownLock === 'function') applyHomeGodownLock();
  requestAnimationFrame(() => {
    const row = dnAddItem();
    if(row) row.querySelector('.prod-combo-input')?.focus();
  });
  previewDnVoucherNo();
}

async function previewDnVoucherNo() {
  // Voucher preview is non-critical — the DN number is set on save.
  // Left as a no-op stub for future enhancement.
}

function dnClearForm() {
  const sv = (id,v) => { const e=document.getElementById(id); if(e) e.value=v; };
  sv('dn-date', new Date().toISOString().slice(0,10));
  sv('dn-supplier',''); sv('dn-supplier-text','');
  sv('dn-reference-no',''); sv('dn-reference-date','');
  sv('dn-reason',''); sv('dn-remarks','');
  const c = document.getElementById('dn-items-container'); if(c) c.innerHTML = '';
  const panel = document.getElementById('dn-sup-details'); if(panel) { panel.style.display='none'; panel.innerHTML=''; }
  dnAddItem();
}

/* ── Build one item row — shared builder for both modals ── */
function _dnItemRowHtml() {
  return `
    <input type="checkbox" class="grn-item-sel" style="width:14px;height:14px;cursor:pointer;accent-color:#6366f1">
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="gi-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="gi-boxes" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-boxcount" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-qty" min="1" step="1" placeholder="0" readonly
      style="width:100%;background:rgba(99,102,241,.12);border:1.5px solid rgba(99,102,241,.35);border-radius:6px;padding:6px 4px;font-size:13px;font-weight:800;color:#4f46e5;outline:none;text-align:right;cursor:not-allowed"
      title="Auto-calculated: No. of Box × Per Box Qty">
    <input type="text" class="gi-remarks" placeholder="Optional…"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <button class="dn-row-del"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center">✕</button>`;
}

function dnAddItem(item) {
  return _dnBuildRow('dn', document.getElementById('dn-items-container'), item);
}

function ednAddItem(item) {
  return _dnBuildRow('edn', document.getElementById('edn-items-container'), item);
}

/* ════════════════════════════════════════════════════════════════════
   Per-row scanned-box tracking
   ─────────────────────────────────────────────────────────────────────
   Each row carries:
     row._dnBoxes      – Array<{box_id, box_code, short_code, per_box_qty,
                                product_id, product_name}>
     row._dnBoxesStrip – sibling <div> rendering the chips with × buttons

   When _dnBoxes changes, _dnRenderChips() rebuilds the strip AND
   recomputes the row's no_of_box / qty_delivered from the box list
   (so the math always agrees with reality). Manual editing of the
   numeric inputs is locked off whenever the row has any scanned boxes.
════════════════════════════════════════════════════════════════════ */
function _dnBuildRow(prefix, container, item) {
  if(!container) return null;
  const div = document.createElement('div');
  div.className = 'grn-item-row';
  div.style.cssText = 'display:grid;grid-template-columns:22px 1fr 72px 72px 90px 120px 28px;gap:5px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML = _dnItemRowHtml();
  container.appendChild(div);

  // Chip strip — sibling div, spans full row width, hidden by default
  const strip = document.createElement('div');
  strip.className = 'dn-boxes-strip';
  strip.style.cssText = 'display:none;padding:6px 8px 10px 36px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));background:rgba(99,102,241,.025)';
  container.appendChild(strip);

  div._dnBoxes      = [];
  div._dnBoxesStrip = strip;
  strip._dnRow      = div;  // back-pointer for the × handler

  // Wire up the row's × delete button to also remove its chip strip and
  // restore any pending box scans into the source pool.
  const delBtn = div.querySelector('.dn-row-del');
  if(delBtn) delBtn.onclick = () => {
    // Just remove DOM — boxes attached to this row never made it to the
    // server (unsaved DN) or will be diffed-restored on save (existing DN).
    strip.remove();
    div.remove();
  };

  if(typeof _initProdCombo === 'function') _initProdCombo(div.querySelector('.prod-combo-wrap'), '.gi-qty');
  if(!item && prefix === 'dn') div.querySelector('.prod-combo-input').focus();

  if(item) {
    const pid = String(item.product_id||'');
    const prod = (_products||[]).find(p => String(p.id) === pid);
    if(prod){
      div.querySelector('.gi-product').value = pid;
      div.querySelector('.prod-combo-input').value = `[${prod.pm_type}] ${prod.product_name}`;
      div.querySelector('.prod-combo-input').style.borderColor = '#4f46e5';
    }
    div.querySelector('.gi-boxes').value    = item.no_of_box||'';
    div.querySelector('.gi-boxcount').value = item.box_count||'';
    div.querySelector('.gi-qty').value      = item.qty_delivered||'';
    div.querySelector('.gi-remarks').value  = item.remarks||'';
    if((item.no_of_box||0) > 0 && (item.box_count||0) > 0) {
      grnCalcQty(div.querySelector('.gi-boxes'));
    }
    // Existing DN: preload box scans on the row
    if(Array.isArray(item.boxes) && item.boxes.length){
      div._dnBoxes = item.boxes.map(b => ({
        box_id:        b.box_id,
        box_code:      b.box_code,
        short_code:    b.short_code || '',
        per_box_qty:   Number(b.per_box_qty || 0),
        product_id:    b.product_id,
        product_name:  (prod && prod.product_name) || '',
        _persisted:    true,  // came from server, not a new scan
      }));
      _dnRenderChips(div);
    }
  }
  return div;
}

/* Render box chips into the row's strip and recompute the row's totals
   based on the attached boxes. */
function _dnRenderChips(row) {
  const strip = row._dnBoxesStrip;
  const boxes = row._dnBoxes || [];
  if(!strip) return;
  if(!boxes.length){
    strip.style.display = 'none';
    strip.innerHTML = '';
    // Re-enable manual entry once no boxes are attached
    const b  = row.querySelector('.gi-boxes');     if(b)  b.readOnly = false;
    const bc = row.querySelector('.gi-boxcount');  if(bc) bc.readOnly = false;
    return;
  }
  strip.style.display = 'block';
  const totalQty = boxes.reduce((s,b) => s + Number(b.per_box_qty || 0), 0);
  const summary = `<span style="font-size:10px;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:.4px;margin-right:8px">${boxes.length} box(es) scanned · ${totalQty.toLocaleString('en-IN')} pcs</span>`;
  const chips = boxes.map((b, idx) => {
    const label = (b.short_code || b.box_code || '?');
    const qty   = Number(b.per_box_qty||0).toLocaleString('en-IN');
    return `<span class="dn-box-chip" style="display:inline-flex;align-items:center;gap:6px;
              padding:3px 8px 3px 9px;margin:2px 3px;border-radius:11px;
              background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);
              font-size:10.5px;font-family:monospace;font-weight:700;color:#4338ca">
              ${_escAttr(label)} · <span style="color:#6b7280;font-weight:600">${qty}</span>
              <button class="dn-chip-x" data-idx="${idx}" title="Remove this box from the DN"
                style="background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.35);
                       color:#dc2626;width:16px;height:16px;border-radius:50%;cursor:pointer;
                       font-size:10px;line-height:1;padding:0;display:inline-flex;
                       align-items:center;justify-content:center">×</button>
            </span>`;
  }).join('');
  strip.innerHTML = summary + chips;

  // Wire up × handlers
  strip.querySelectorAll('.dn-chip-x').forEach(btn => {
    btn.onclick = () => {
      const i = parseInt(btn.getAttribute('data-idx'));
      if(isNaN(i) || i < 0 || i >= row._dnBoxes.length) return;
      const removed = row._dnBoxes.splice(i, 1)[0];
      _dnRecalcFromBoxes(row);
      _dnRenderChips(row);
      if(typeof showToast === 'function')
        showToast(`Removed ${removed.short_code || removed.box_code}`, 'info', 1600);
    };
  });

  // Lock the numeric inputs whenever boxes are attached — the boxes
  // are the source of truth for no_of_box / box_count / qty_delivered.
  const b  = row.querySelector('.gi-boxes');     if(b)  b.readOnly = true;
  const bc = row.querySelector('.gi-boxcount');  if(bc) bc.readOnly = true;

  _dnRecalcFromBoxes(row);
}

/* When a row has scanned boxes, the box list determines no_of_box,
   box_count, and qty_delivered. We segregate by per_box_qty bucket and
   pick the dominant bucket for display (most rows will have a single
   bucket — full boxes only, or a known full/half split). If multiple
   buckets exist, no_of_box reads as the total count but box_count
   shows the most-common per-box value with a hint. */
function _dnRecalcFromBoxes(row){
  const boxes = row._dnBoxes || [];
  const bEl   = row.querySelector('.gi-boxes');
  const bcEl  = row.querySelector('.gi-boxcount');
  const qEl   = row.querySelector('.gi-qty');
  if(!boxes.length){
    if(bEl)  bEl.value  = '';
    if(qEl)  qEl.value  = '';
    return;
  }
  // Count by per_box_qty bucket
  const buckets = new Map();
  let total = 0;
  for(const b of boxes){
    const q = Number(b.per_box_qty || 0);
    total += q;
    buckets.set(q, (buckets.get(q) || 0) + 1);
  }
  // Pick the bucket with the most boxes as the "representative" box_count
  let repQty = 0, repCount = -1;
  buckets.forEach((cnt, q) => { if(cnt > repCount){ repCount = cnt; repQty = q; } });
  if(bEl)  bEl.value  = boxes.length;
  if(bcEl) bcEl.value = repQty;
  if(qEl)  qEl.value  = total;
  // Visual hint when multiple bucket sizes present — box_count alone
  // can't tell the whole story
  if(bcEl){
    if(buckets.size > 1){
      bcEl.style.background  = 'rgba(245,158,11,.12)';
      bcEl.title = `Mixed box sizes: ${[...buckets.entries()]
        .map(([q,c]) => `${c}×${q}`).join(' + ')} = ${total}`;
    } else {
      bcEl.style.background  = '';
      bcEl.title = '';
    }
  }
}

/* Minimal HTML-attr escaper — only enough to keep box codes safe inside
   button data-attrs and chip labels. */
function _escAttr(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ════════════════════════════════════════════════════════════════════
   Strict items collector.
   ─────────────────────────────────────────────────────────────────────
   Reads every row in the container and returns:
     { items: [...], error: null }  on success
     { items: null,  error: 'msg' } on validation failure

   Critically, this function NEVER silently drops a row. If a row has
   ANY user-visible data (qty > 0, no_of_box > 0, scanned boxes, OR
   text typed into the product input) but no product was actually
   selected from the dropdown — the function returns an error and
   highlights the offending row red. This catches the silent-line-
   dropping bug where the user typed a product name without clicking
   an item in the picker, leaving the hidden .gi-product empty.

   Pure rows (everything blank, including no product text typed) are
   considered "empty" and ignored — that's normal for the trailing
   row left by + Add Item.
════════════════════════════════════════════════════════════════════ */
function _dnCollectItems(containerSel){
  const items = [];
  const rows  = document.querySelectorAll(`${containerSel} .grn-item-row`);
  let badRow  = null;
  let badIdx  = 0;
  let badMsg  = '';

  // Clear any previous red highlights
  rows.forEach(r => {
    r.style.outline = '';
    r.style.outlineOffset = '';
  });

  rows.forEach((row, i) => {
    if(badRow) return;  // stop at first bad row
    const prodInputVal = (row.querySelector('.prod-combo-input')?.value || '').trim();
    const pid   = parseInt(row.querySelector('.gi-product')?.value) || 0;
    const qty   = parseFloat(row.querySelector('.gi-qty')?.value) || 0;
    const nob   = parseInt(row.querySelector('.gi-boxes')?.value) || 0;
    const bc    = parseInt(row.querySelector('.gi-boxcount')?.value) || 0;
    const rem   = row.querySelector('.gi-remarks')?.value?.trim() || '';
    const boxes = (row._dnBoxes || []).map(b => b.box_code).filter(Boolean);

    const hasAnyData = (qty > 0) || (nob > 0) || (bc > 0)
                    || (boxes.length > 0) || (rem.length > 0)
                    || (prodInputVal.length > 0);

    // Pure-empty row → silently skipped (this is the placeholder row
    // left by + Add Item that the user never filled in).
    if(!hasAnyData) return;

    // Row has data → product MUST be selected.
    if(!pid){
      badRow = row;
      badIdx = i + 1;
      badMsg = prodInputVal
        ? `Row ${badIdx}: you typed "${prodInputVal}" but didn't pick a product from the dropdown. Click a suggestion to select it.`
        : `Row ${badIdx}: data filled in but no product selected.`;
      return;
    }
    // Product is OK; but the line must have qty > 0 to be meaningful.
    if(qty <= 0){
      badRow = row;
      badIdx = i + 1;
      badMsg = `Row ${badIdx}: total quantity is 0. Enter a quantity or remove the row.`;
      return;
    }

    items.push({
      product_id:   pid,
      qty_delivered: qty,
      no_of_box:    nob,
      box_count:    bc,
      remarks:      rem,
      boxes,
    });
  });

  if(badRow){
    // Visual: red outline + scroll into view
    badRow.style.outline = '2px solid #dc2626';
    badRow.style.outlineOffset = '2px';
    badRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { items: null, error: badMsg };
  }
  if(!items.length){
    return { items: null, error: 'Add at least one item with qty > 0.' };
  }
  return { items, error: null };
}

/* ── Save new DN ── */
async function saveDn() {
  const dnDate   = document.getElementById('dn-date').value;
  const godownId = document.getElementById('dn-godown').value;
  const supplier = (document.getElementById('dn-supplier-text')?.value
                 || document.getElementById('dn-supplier')?.value || '').trim();
  const reason   = document.getElementById('dn-reason').value;
  const remarks  = document.getElementById('dn-remarks').value.trim();
  const supervisorName = document.getElementById('dn-supervisor')?.value?.trim() || null;
  const refNo   = document.getElementById('dn-reference-no')?.value?.trim() || null;
  const refDate = document.getElementById('dn-reference-date')?.value || null;

  if(!dnDate)   { showToast('Select DN date','error'); return; }
  if(!godownId) { showToast('Select From godown','error'); return; }
  if(!supplier) { showToast('Select Supplier','error'); return; }

  const collected = _dnCollectItems('#dn-items-container');
  if(collected.error){ showToast(collected.error, 'error', 6000); return; }
  const items = collected.items;

  const btn = document.getElementById('dn-save-btn');
  const orig = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> Saving…'; btn.disabled = true;
  try {
    const res = await fetch('/api/pm_stock/dn/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        dn_date: dnDate, supplier, from_godown: parseInt(godownId),
        reason, remarks, supervisor_name: supervisorName,
        reference_no: refNo, reference_date: refDate, items
      })
    });
    const data = await res.json();
    if(data.status === 'ok') {
      showToast(`✓ PM DN ${data.dn_no} saved — ${items.length} item(s)`, 'success', 5000);
      const badge = document.getElementById('pmv-dn-badge');
      if(badge) { badge.textContent = data.dn_no; badge.style.display=''; }
      const vbar = document.getElementById('dn-vno-bar');
      const vdsp = document.getElementById('dn-vno-display');
      if(vbar && vdsp) { vdsp.textContent = data.dn_no; vbar.style.display='flex'; }
      if(confirm(`PM DN ${data.dn_no} saved.\n\nPrint now?`))
        pmDnPrint({dn_no:data.dn_no, supervisor_name:supervisorName, reason, reference_no:refNo, reference_date:refDate},
                  items, dnDate, supplier, godownId, remarks);
      closeModal('pmDnModal');
      if(typeof loadVoucherLog === 'function') loadVoucherLog();
      if(typeof loadSummary === 'function') await loadSummary();
    } else {
      showToast(data.message || 'Save failed', 'error');
    }
  } catch(e) { showToast('Error: '+e.message, 'error'); }
  finally { btn.innerHTML = orig; btn.disabled = false; }
}

/* ── Edit / update / delete ── */
async function openEditDn(id) {
  try {
    showToast('Loading DN…','info',1500);
    const res = await fetch(`/api/pm_stock/dn/${id}`);
    const data = await res.json();
    if(data.status === 'error') { showToast(data.message || 'Not found', 'error'); return; }

    document.getElementById('edn-id').value = id;
    document.getElementById('edn-vno').textContent = data.dn_no;
    document.getElementById('edn-date').value      = data.dn_date || '';
    document.getElementById('edn-supplier').value  = data.supplier || '';
    const sup = document.getElementById('edn-supplier-text');
    if(sup) sup.value = data.supplier || '';
    document.getElementById('edn-reason').value   = data.reason || '';
    document.getElementById('edn-remarks').value  = data.remarks || '';
    document.getElementById('edn-supervisor').value = data.supervisor_name || '';
    document.getElementById('edn-reference-no').value = data.reference_no || '';
    document.getElementById('edn-reference-date').value = data.reference_date || '';

    if(!_godowns || !_godowns.length) await loadGodowns();
    const sel = document.getElementById('edn-godown');
    sel.innerHTML = '<option value="">— Select —</option>' +
      (_godowns||[]).filter(g => !g.is_floor).map(g => `<option value="${g.id}">${godownLabel ? godownLabel(g) : g.name}</option>`).join('');
    if(data.from_godown) sel.value = String(data.from_godown);

    // Init supplier combo
    if(!_supRows || !_supRows.length) loadSuppliers().then(() => { const w=document.getElementById('edn-sup-wrap'); if(w) _initSupplierCombo(w); });
    else { const w=document.getElementById('edn-sup-wrap'); if(w) _initSupplierCombo(w); }

    // Items
    const c = document.getElementById('edn-items-container');
    c.innerHTML = '';
    (data.items || []).forEach(it => ednAddItem(it));
    if(!data.items || !data.items.length) ednAddItem();

    document.getElementById('editDnModal').classList.add('open');
    if(typeof applyHomeGodownLock === 'function') applyHomeGodownLock();
  } catch(e) { showToast('Error loading DN: '+e.message, 'error'); }
}

async function saveEditDn() {
  const id = document.getElementById('edn-id').value;
  const dnDate = document.getElementById('edn-date').value;
  const godownId = document.getElementById('edn-godown').value;
  const supplier = (document.getElementById('edn-supplier-text')?.value
                 || document.getElementById('edn-supplier')?.value || '').trim();
  const reason = document.getElementById('edn-reason').value;
  const remarks = document.getElementById('edn-remarks').value.trim();
  const supervisorName = document.getElementById('edn-supervisor')?.value?.trim() || null;
  const refNo = document.getElementById('edn-reference-no')?.value?.trim() || null;
  const refDate = document.getElementById('edn-reference-date')?.value || null;

  const collected = _dnCollectItems('#edn-items-container');
  if(collected.error){ showToast(collected.error, 'error', 6000); return; }
  const items = collected.items;

  try {
    const res = await fetch('/api/pm_stock/dn/update', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        id, dn_date: dnDate, supplier, from_godown: parseInt(godownId),
        reason, remarks, supervisor_name: supervisorName,
        reference_no: refNo, reference_date: refDate, items
      })
    });
    const data = await res.json();
    if(data.status === 'ok') {
      showToast(`✓ DN ${data.dn_no} updated`, 'success');
      closeModal('editDnModal');
      if(typeof loadVoucherLog === 'function') loadVoucherLog();
      if(typeof loadSummary === 'function') await loadSummary();
      if(confirm(`DN ${data.dn_no} updated.\n\nPrint now?`))
        pmDnPrint({dn_no:data.dn_no, supervisor_name:supervisorName, reason, reference_no:refNo, reference_date:refDate},
                  items, dnDate, supplier, godownId, remarks);
    } else showToast(data.message || 'Error', 'error');
  } catch(e) { showToast('Error: '+e.message, 'error'); }
}

function printEditDn() {
  const id = document.getElementById('edn-id').value;
  const dnNo = document.getElementById('edn-vno').textContent;
  const dnDate = document.getElementById('edn-date').value;
  const godownId = document.getElementById('edn-godown').value;
  const supplier = (document.getElementById('edn-supplier-text')?.value
                 || document.getElementById('edn-supplier')?.value || '').trim();
  const remarks = document.getElementById('edn-remarks')?.value || '';
  const supervisorName = document.getElementById('edn-supervisor')?.value?.trim() || null;
  const refNo = document.getElementById('edn-reference-no')?.value?.trim() || null;
  const refDate = document.getElementById('edn-reference-date')?.value || null;
  const reason = document.getElementById('edn-reason')?.value || '';

  const collected = _dnCollectItems('#edn-items-container');
  if(collected.error){
    showToast('Cannot print: ' + collected.error, 'error', 6000);
    return;
  }
  pmDnPrint({dn_no:dnNo, supervisor_name:supervisorName, reason, reference_no:refNo, reference_date:refDate},
            collected.items, dnDate, supplier, godownId, remarks);
}

async function deleteDn(id, dnNo) {
  if(!confirm(`Delete DN ${dnNo}?\nThis will also reverse the outward stock transactions.`)) return;
  try {
    const res = await fetch('/api/pm_stock/dn/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({id})
    });
    const d = await res.json();
    if(d.status === 'ok') {
      showToast(`✓ DN ${dnNo} deleted`, 'success');
      if(typeof loadVoucherLog === 'function') loadVoucherLog();
      if(typeof loadSummary === 'function') await loadSummary();
    } else showToast(d.message || 'Error', 'error');
  } catch(e) { showToast('Error: '+e.message, 'error'); }
}

/* ── DN Print — HCP (from) + Supplier (to) side by side ── */
async function pmDnPrintById(id) {
  try {
    showToast('Loading DN…','info',1500);
    if(typeof loadSuppliers === 'function' && (!window._supRows || !window._supRows.length)) {
      await loadSuppliers();
    }
    const res = await fetch(`/api/pm_stock/dn/${id}`);
    const data = await res.json();
    if(data.status === 'error') { showToast(data.message || 'Not found', 'error'); return; }
    const items = (data.items||[]).map(i => ({
      product_id: i.product_id, qty_delivered: i.qty_delivered,
      no_of_box: i.no_of_box, box_count: i.box_count, remarks: i.remarks || ''
    }));
    pmDnPrint(data, items, data.dn_date, data.supplier, data.from_godown, data.remarks);
  } catch(e) { showToast('Error: '+e.message, 'error'); }
}

function pmDnPrint(data, items, dnDate, supplier, godownId, remarks) {
  const godown = (_godowns||[]).find(g => String(g.id) === String(godownId));
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fd = d => { if(!d) return '—'; const p = String(d).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; };
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dash = v => (v && String(v).trim()) ? esc(String(v).trim()) : '<span style="color:#bbb">—</span>';
  const addrLine = g => [g?.address, g?.city, g?.state, g?.pincode].filter(p => p && String(p).trim()).join(', ');

  const dnNo = data.dn_no;
  const total = items.reduce((s,i) => s + (parseFloat(i.qty_delivered)||0), 0);

  const sup = (window._supRows||[]).find(s =>
    (s.supplier_name||'').trim().toLowerCase() === (supplier||'').trim().toLowerCase()
  );

  const itemRows = items.map((it,i) => {
    const prod = (_products||[]).find(p => p.id === it.product_id);
    const pm   = prod?.pm_type || '';
    const brand= prod?.brand_name || '';
    return `<tr>
      <td class="c">${i+1}</td>
      <td><strong>${esc(prod?.product_name||'—')}</strong>
        ${pm ? `<br><span style="font-size:8.5px;color:#555">${esc(pm)}${brand ? ' · '+esc(brand) : ''}</span>` : ''}</td>
      <td class="r">${it.no_of_box||0}</td>
      <td class="r">${it.box_count||0}</td>
      <td class="r"><strong>${(parseFloat(it.qty_delivered)||0).toLocaleString('en-IN')}</strong></td>
      <td>${esc(it.remarks||'—')}</td>
    </tr>`;
  }).join('');

  const CSS = `*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:18px 24px}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #4f46e5;padding-bottom:10px;margin-bottom:0}
.co{font-size:20px;font-weight:900;color:#4f46e5;letter-spacing:-.3px}
.co-sub{font-size:8px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-top:2px}
.vno{font-size:14px;font-weight:800;font-family:monospace;color:#4f46e5;text-align:right}
.bar{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #ccc;border-top:none;margin-bottom:8px}
.bc{padding:6px 10px;border-right:1px solid #ccc}
.bc:last-child{border-right:none}
.bl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}
.bv{font-size:12px;font-weight:700;color:#111}

/* Party boxes */
.party-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.pbox{border-radius:4px;overflow:hidden;border:1px solid #d1d5db}
.pbox-from{border-color:#0d9488;background:#f0fdfa}
.pbox-to{border-color:#4f46e5;background:#eef2ff}
.pbox-hdr{padding:4px 10px;font-size:9px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pbox-from .pbox-hdr{background:#0d9488}
.pbox-to   .pbox-hdr{background:#4f46e5}
.pbox-role{background:rgba(255,255,255,.22);padding:1px 8px;border-radius:10px;font-size:7.5px}
.pbox-title{flex:1;font-size:10px}
.pbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
.pbox-from .sbc{border-right:1px solid #cde5e2;border-bottom:1px solid #cde5e2}
.pbox-to   .sbc{border-right:1px solid #cfd4f1;border-bottom:1px solid #cfd4f1}
.sbc{padding:5px 10px}
.pbox-grid .sbc:nth-child(2n){border-right:none}
.sbc.wide{grid-column:1/-1;border-right:none}
.sbl{font-size:6.5px;font-weight:800;color:#647d7a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:1px}
.pbox-to .sbl{color:#5c6095}
.sbv{font-size:9.5px;font-weight:600;color:#111;word-break:break-word}
.sbv.bold{font-size:10.5px;font-weight:800}
.pbox-from .sbv.bold{color:#0d9488}
.pbox-to   .sbv.bold{color:#4f46e5}
.sbv.mono{font-family:'Courier New',monospace;font-size:9px}

table{width:100%;border-collapse:collapse;margin-top:8px}
thead tr{background:#4f46e5 !important}
th{color:#fff;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;background:#4f46e5}
tr{border-bottom:1px solid #e5e7eb}
tbody tr:nth-child(even){background:#fafaf8}
td{padding:6px 8px;font-size:10.5px;vertical-align:top}
.c{text-align:center;color:#9ca3af;width:28px}
.r{text-align:right;font-family:monospace}
tfoot tr{background:#eef2ff!important;font-weight:800;border-top:2px solid #4f46e5}
tfoot td{font-weight:800}
.sig{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #ccc;border-top:none;margin-top:20px}
.sb{padding:12px 10px;border-right:1px solid #ccc;min-height:52px}
.sb:last-child{border-right:none}
.sl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.ft{text-align:center;font-size:8.5px;color:#9ca3af;margin-top:10px;border-top:1px solid #eee;padding-top:6px}
@media print{body{padding:8px 14px}button{display:none!important}}`;

  const win = window.open('', '_blank', 'width=860,height=700');
  if(!win) { showToast('Pop-up blocked','error'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>DN ${esc(dnNo)}</title><style>${CSS}</style></head><body>

  <div class="hd">
    <div>
      <div class="co">PM Delivery Note</div>
      <div class="co-sub">HCP Wellness Pvt Ltd · Outbound to Supplier</div>
    </div>
    <div class="vno">${esc(dnNo)}</div>
  </div>

  <div class="bar">
    <div class="bc"><div class="bl">DN No.</div><div class="bv">${esc(dnNo)}</div></div>
    <div class="bc"><div class="bl">DN Date</div><div class="bv">${fd(dnDate)}</div></div>
    <div class="bc"><div class="bl">Reason</div><div class="bv">${esc(data?.reason||'—')}</div></div>
    <div class="bc"><div class="bl">Reference</div><div class="bv">${esc(data?.reference_no||'—')}${data?.reference_date?` / ${fd(data.reference_date)}`:''}</div></div>
  </div>

  <!-- From HCP godown + To Supplier boxes -->
  <div class="party-row">
    <div class="pbox pbox-from">
      <div class="pbox-hdr">
        <span class="pbox-role">From (Issuer)</span>
        <span class="pbox-title">HCP Wellness Pvt Ltd</span>
      </div>
      <div class="pbox-grid">
        <div class="sbc"><div class="sbl">Issuing Location</div><div class="sbv bold">${dash(godown?.name)}</div></div>
        <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(godown?.contact)}</div></div>
        <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(godown?.phone)}</div></div>
        <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(godown?.email)}</div></div>
        <div class="sbc"><div class="sbl">GST Number</div><div class="sbv mono">${dash(godown?.gst_number)}</div></div>
        <div class="sbc"><div class="sbl">Supervisor</div><div class="sbv">${dash(data?.supervisor_name)}</div></div>
        <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(addrLine(godown))}</div></div>
      </div>
    </div>

    <div class="pbox pbox-to">
      <div class="pbox-hdr">
        <span class="pbox-role">To (Receiver)</span>
        <span class="pbox-title">Supplier Details</span>
        ${sup?.supplier_code ? `<span class="pbox-role">${esc(sup.supplier_code)}</span>` : ''}
      </div>
      <div class="pbox-grid">
        <div class="sbc"><div class="sbl">Supplier Name</div><div class="sbv bold">${dash(supplier)}</div></div>
        <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(sup?.contact_person)}</div></div>
        <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(sup?.phone)}</div></div>
        <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(sup?.email)}</div></div>
        <div class="sbc"><div class="sbl">GST Number</div><div class="sbv mono">${dash(sup?.gst_number)}</div></div>
        <div class="sbc"><div class="sbl">PAN</div><div class="sbv mono">${dash(sup?.pan_number)}</div></div>
        <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(sup?.address)}</div></div>
      </div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th class="c">#</th>
      <th style="text-align:left">Product</th>
      <th class="r" style="width:70px">Boxes</th>
      <th class="r" style="width:80px">Per Box</th>
      <th class="r" style="width:90px">Qty</th>
      <th style="text-align:left">Remarks</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
    <tfoot><tr>
      <td colspan="4" style="padding:7px 8px">Total — ${items.length} item(s)</td>
      <td class="r" style="padding:7px 8px">${total.toLocaleString('en-IN')}</td>
      <td></td>
    </tr></tfoot>
  </table>

  ${remarks ? `<div style="margin-top:10px;padding:6px 10px;background:#f8fafc;border-left:3px solid #4f46e5;font-size:10px"><strong>Remarks:</strong> ${esc(remarks)}</div>` : ''}

  <div class="sig">
    <div class="sb"><div class="sl">Issued By (HCP)</div></div>
    <div class="sb"><div class="sl">Received By (Supplier)</div></div>
    <div class="sb"><div class="sl">Authorised By</div></div>
  </div>

  <div class="ft">PM DN ${esc(dnNo)} · HCP Wellness Pvt Ltd · ${new Date().toLocaleString('en-IN')}</div>

  <br>
  <button onclick="window.print()" style="padding:6px 14px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700">🖨 Print</button>

  </body></html>`);
  win.document.close();
  win.onload = () => { win.focus(); win.print(); };
}

/* ════════════════════════════════════════════════════════════════
   SCAN-TO-ADD for Delivery Notes
   ────────────────────────────────────────────────────────────────
   1. Server pre-validates the box (lives at our source godown, in_stock,
      not already on another DN) via /api/pm_stock/dn/box/check.
   2. Refuses duplicates if the SAME box is already on any row of this
      DN (the server would reject this on save anyway; we surface it
      earlier so the user gets immediate feedback).
   3. Finds an existing row whose product_id AND per_box_qty match the
      scanned box. If found, attaches; else creates a new row.
   4. Pushes the box into row._dnBoxes and re-renders the chip strip.
      The row's no_of_box / box_count / qty_delivered are recomputed
      from the box list, so the math is always self-consistent.

   Works for both the new-DN ('dn') and edit-DN ('edn') modals.
════════════════════════════════════════════════════════════════ */
async function dnHandleScanInput(ev, prefix){
  if(ev && ev.type === 'keydown' && ev.key !== 'Enter') return;
  prefix = (prefix === 'edn') ? 'edn' : 'dn';
  const inp = document.getElementById(`${prefix}-scan-input`);
  if(!inp) return;
  const code = (inp.value || '').trim().toUpperCase();
  if(!code) return;
  inp.value = '';

  // From-godown is required to validate the scan. For edit mode the godown
  // can be changed — if so, the user has to pick a new source before
  // scanning is meaningful.
  const godownEl = document.getElementById(`${prefix}-godown`);
  const fromGodown = parseInt(godownEl?.value || 0) || 0;
  if(!fromGodown){
    showToast('Pick the source godown first, then scan.', 'warn', 3500);
    setTimeout(() => inp.focus(), 50);
    return;
  }
  // For edit mode, send the DN id so re-scanning a box already on this
  // DN doesn't fail the "must be in_stock" check.
  const dnId = (prefix === 'edn')
    ? (parseInt(document.getElementById('edn-id')?.value) || null)
    : null;

  // Pre-validation against the server: confirms box exists, is at our
  // source godown, and isn't already 'consumed' (i.e. on another DN).
  try {
    const res = await fetch('/api/pm_stock/dn/box/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, from_godown_id: fromGodown, dn_id: dnId
      })
    });
    const d = await res.json();
    if(d.status !== 'ok' || !d.box){
      showToast(d.message || `Box ${code} cannot be scanned here`, 'error', 4500);
      setTimeout(() => inp.focus(), 50);
      return;
    }
    const box = d.box;
    const productId = String(box.product_id);
    const perBoxQty = parseFloat(box.per_box_qty || 0);
    const boxId     = parseInt(box.box_id);

    // Duplicate-on-this-DN check (any row)
    const containerSel = `#${prefix}-items-container .grn-item-row`;
    const allRows = document.querySelectorAll(containerSel);
    for(const r of allRows){
      const present = (r._dnBoxes || []).some(b => parseInt(b.box_id) === boxId);
      if(present){
        showToast(`${box.box_code} is already on this DN`, 'warn', 3000);
        setTimeout(() => inp.focus(), 50);
        return;
      }
    }

    // Find an existing row whose product_id AND per-box-qty match the
    // scanned box. Half boxes (post-split) MUST land on their own row
    // separate from full boxes — otherwise the math is wrong.
    const EPS = 0.001;
    let foundRow = null;
    allRows.forEach(r => {
      const pid = (r.querySelector('.gi-product')||{}).value;
      if(!pid || String(pid) !== productId) return;
      // For rows that already have scanned boxes, compare against their
      // recomputed box_count (which reflects the dominant per-box-qty
      // bucket). For empty rows, fall back to the inline input.
      const bc = parseFloat((r.querySelector('.gi-boxcount')||{}).value || 0);
      if(Math.abs(bc - perBoxQty) < EPS) foundRow = r;
    });

    if(!foundRow){
      // New row — create with the box's per_box_qty as the seed
      const addFn = (prefix === 'edn') ? ednAddItem : dnAddItem;
      foundRow = addFn({
        product_id:   productId,
        no_of_box:    0,         // _dnRecalcFromBoxes will set this
        box_count:    perBoxQty,
        qty_delivered: 0,
        remarks:      ''
      });
      if(!foundRow){
        showToast('Internal: could not build a row','error');
        return;
      }
    }

    // Defensive: ensure the row's hidden product field and visible label
    // are populated from the scanned box. The combo's `input` handler
    // wipes hidden.value on every keystroke, so a row that started life
    // via picker → then got typed in → could end up with an empty
    // hidden.value and silently disappear on save. Scanning into a row
    // is unambiguous about which product it is, so we set both fields.
    const pidEl  = foundRow.querySelector('.gi-product');
    const lblEl  = foundRow.querySelector('.prod-combo-input');
    if(pidEl && !pidEl.value) pidEl.value = String(productId);
    if(lblEl && box.product_name){
      const ptype = (box.pm_type || '');
      lblEl.value = ptype ? `[${ptype}] ${box.product_name}` : box.product_name;
      lblEl.style.borderColor = 'var(--teal,#0d9488)';
    }
    // Clear any leftover red error outline
    foundRow.style.outline = '';
    foundRow.style.outlineOffset = '';

    // Attach the box to the row's state and re-render
    foundRow._dnBoxes = foundRow._dnBoxes || [];
    foundRow._dnBoxes.push({
      box_id:       boxId,
      box_code:     box.box_code,
      short_code:   box.short_code || '',
      per_box_qty:  perBoxQty,
      product_id:   parseInt(productId),
      product_name: box.product_name || '',
    });
    _dnRenderChips(foundRow);

    const count = foundRow._dnBoxes.length;
    showToast(`✓ ${box.product_name} +1 box of ${perBoxQty} (${count} on this line)`,
              'success', 1800);
  } catch(e){
    showToast('Error: ' + e.message, 'error');
  }
  setTimeout(() => inp.focus(), 50);
}
