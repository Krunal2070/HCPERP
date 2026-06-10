/* pm_stock_grn_mtv.js — GRN/MTV entry forms + voucher numbering */

// ── openGrnModal (originally L439..L463) ─────────────────────────
function openGrnModal() {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('grn-date').value = today;
  const pn = document.getElementById('grn-po-number'); if(pn) pn.value='';
  document.getElementById('grn-po-date').value = '';
  // Wipe any PO link from a previous session — every fresh GRN starts unlinked.
  const poIdEl = document.getElementById('grn-po-id'); if(poIdEl) poIdEl.value='';
  const poClr  = document.getElementById('grn-po-clear-btn'); if(poClr) poClr.style.display='none';
  document.getElementById('grn-supplier').value = '';
  const grnSupText = document.getElementById('grn-supplier-text'); if(grnSupText) grnSupText.value='';
  document.getElementById('grn-remarks').value = '';
  const pin = document.getElementById('grn-party-invoice-no'); if(pin) pin.value='';
  const pid2 = document.getElementById('grn-party-invoice-date'); if(pid2) pid2.value='';
  // Auto-fill supervisor with logged-in user name
  const supEl = document.getElementById('grn-supervisor');
  if(supEl) supEl.value = _loginUserName();
  document.getElementById('grn-items-container').innerHTML = '';
  const badge = document.getElementById('grn-vno-badge');
  if(badge) badge.style.display = 'none';
  populateGodownSelects();
  // Init supplier combo — ensure suppliers loaded
  if(!_supRows.length) loadSuppliers().then(()=>{ const w=document.getElementById('grn-sup-wrap'); if(w) _initSupplierCombo(w); });
  else { const w=document.getElementById('grn-sup-wrap'); if(w) _initSupplierCombo(w); }
  _grnItemCount = 0;
  addGrnItem();
  document.getElementById('grnModal').classList.add('open');
}


// ── openGrnForm (originally L464..L465) ─────────────────────────
function openGrnForm() { openGrnModal(); } // alias for any legacy calls


// ── closeGrnForm (originally L466..L467) ─────────────────────────
function closeGrnForm() { closeModal('grnModal'); }


// ── addGrnItem (originally L468..L502) ─────────────────────────
function addGrnItem() {
  _grnItemCount++;
  const wrap = document.getElementById('grn-items-container');
  if(!wrap) return;
  const row = document.createElement('div');
  row.className = 'grn-item-row';
  // Grid: select / product / boxes / per-box / total-qty / RATE / remarks / bag / delete
  // Rate (₹) is per-line and optional — used by ABC Analysis to compute
  // material value (Σ qty × rate). Legacy lines saved before this column
  // existed keep rate=0 and contribute 0 to value totals.
  row.style.cssText = 'display:grid;grid-template-columns:22px 1fr 72px 72px 90px 90px 100px 76px 28px;gap:5px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  row.innerHTML = `
    <input type="checkbox" class="grn-item-sel" style="width:14px;height:14px;cursor:pointer;accent-color:var(--teal,#0d9488)">
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="grn-item-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="grn-item-boxes" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="grn-item-boxcount" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="grn-item-qty" min="0.01" step="1" placeholder="0" readonly
      style="width:100%;background:rgba(13,148,136,.12);border:1.5px solid rgba(13,148,136,.35);border-radius:6px;padding:6px 4px;font-size:13px;font-weight:800;color:var(--teal,#0d9488);outline:none;text-align:right;cursor:not-allowed"
      title="Auto-calculated: No. of Box × Per Box Qty">
    <!-- Rate per unit (optional). Leave blank if unknown; report-side it just
         contributes 0 to value totals. No client validation beyond ≥ 0. -->
    <input type="number" class="grn-item-rate" min="0" step="0.0001" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 6px;font-size:12px;color:var(--text,#111);outline:none;text-align:right"
      title="Rate per unit (₹) — optional. Used by ABC Analysis report.">
    <input type="text" class="grn-item-remarks" placeholder="Optional…"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <!-- Bag toggle column. Checking it marks the line for group creation
         after GRN save: all the boxes in this line will be bundled into a
         single bag/lot with one group sticker. The label input only shows
         when the toggle is on (lazy via the click handler below). -->
    <div class="grn-bag-cell" style="display:flex;align-items:center;gap:4px;justify-content:center"
         title="Bundle all boxes in this line into one bag/lot">
      <input type="checkbox" class="grn-item-bag" style="width:14px;height:14px;cursor:pointer;accent-color:#7c3aed"
             onchange="grnToggleBagLabel(this)">
      <span class="grn-bag-emoji" style="font-size:14px;color:#7c3aed;cursor:pointer"
            onclick="this.previousElementSibling.click()">🛍️</span>
    </div>
    <button onclick="this.closest('.grn-item-row').remove()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>`;
  wrap.appendChild(row);
  _initProdCombo(row.querySelector('.prod-combo-wrap'), '.grn-item-qty');
  row.querySelector('.prod-combo-input').focus();
}

// Reveals/hides an inline bag-label input below the row when the bag
// toggle changes. Keeps the row layout compact when bag is off, but lets
// the operator name the bag (e.g. "Pallet 7") when relevant.
function grnToggleBagLabel(cb){
  const row = cb.closest('.grn-item-row');
  if(!row) return;
  let labelRow = row.nextElementSibling;
  if(cb.checked){
    if(!labelRow || !labelRow.classList.contains('grn-bag-label-row')){
      const lr = document.createElement('div');
      lr.className = 'grn-bag-label-row';
      lr.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 14px 8px 38px;background:rgba(124,58,237,.04);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))';
      lr.innerHTML = `
        <span style="font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.5px">🛍️ Bag label (optional)</span>
        <input type="text" class="grn-item-bag-label" maxlength="80" placeholder="e.g. Pallet 7, Shrink-wrap A…"
          style="flex:1;max-width:340px;font-size:11px;padding:5px 8px;
          border:1.5px solid rgba(124,58,237,.3);border-radius:5px;outline:none;
          background:#fff;color:var(--text,#0f172a)">
        <span style="font-size:10px;color:var(--text2,#475569)">All boxes in this line → one group sticker</span>`;
      row.parentNode.insertBefore(lr, row.nextSibling);
    }
  } else if(labelRow && labelRow.classList.contains('grn-bag-label-row')){
    labelRow.remove();
  }
}


// ── saveGrn (originally L503..L557) ─────────────────────────
async function saveGrn() {
  const grnDate  = document.getElementById('grn-date').value;
  const godownId = document.getElementById('grn-godown').value;
  const poNum    = document.getElementById('grn-po-number').value.trim();
  const poDate   = document.getElementById('grn-po-date').value || null;
  // If user picked a PO via the picker, this hidden field carries the FK.
  // Otherwise it's empty and the GRN is a free-standing direct receipt.
  const poIdRaw  = document.getElementById('grn-po-id')?.value || '';
  const poId     = poIdRaw ? parseInt(poIdRaw) || null : null;
  const supplier = (document.getElementById('grn-supplier-text')?.value
                 || document.getElementById('grn-supplier')?.value || '').trim();
  const remarks  = document.getElementById('grn-remarks').value.trim();
  const partyInvoiceNo   = document.getElementById('grn-party-invoice-no')?.value.trim() || null;
  const partyInvoiceDate = document.getElementById('grn-party-invoice-date')?.value || null;
  const supervisorName   = document.getElementById('grn-supervisor')?.value.trim() || null;

  if(!grnDate)  { showToast('Select GRN date','error'); return; }
  if(!godownId) { showToast('Select receiving location','error'); return; }

  const items = [];
  // Bag intentions are tracked alongside items but NOT sent to /grn/save
  // (the backend doesn't know about bags yet — Stage 2 adds groups in a
  // post-save pass via /api/pm_stock/groups/create_for_grn). Each entry
  // pairs a saved-item index with its bag flag + label so we can rebuild
  // the mapping after the GRN-save response gives us back the grn_id.
  const bagIntents = [];
  document.querySelectorAll('#grn-items-container .grn-item-row').forEach(row => {
    const pid      = parseInt(row.querySelector('.grn-item-product')?.value) || 0;
    const qty      = parseFloat(row.querySelector('.grn-item-qty')?.value)   || 0;
    const noOfBox  = parseInt(row.querySelector('.grn-item-boxes')?.value)   || 0;
    const boxCount = parseInt(row.querySelector('.grn-item-boxcount')?.value)|| 0;
    const rem      = row.querySelector('.grn-item-remarks')?.value?.trim()   || '';
    // Rate per unit (₹). Optional — backend stores 0 if blank/invalid.
    // Used by ABC Analysis report; no other code path consumes it yet.
    const rate     = parseFloat(row.querySelector('.grn-item-rate')?.value) || 0;
    const bagged   = !!row.querySelector('.grn-item-bag')?.checked;
    // The label row is a sibling that exists only when bag is checked.
    const labelRow = row.nextElementSibling;
    const bagLabel = (bagged && labelRow && labelRow.classList.contains('grn-bag-label-row'))
      ? (labelRow.querySelector('.grn-item-bag-label')?.value || '').trim()
      : '';
    if(pid && qty > 0) {
      items.push({product_id:pid, qty_received:qty, no_of_box:noOfBox, box_count:boxCount, remarks:rem, rate:rate});
      bagIntents.push({product_id:pid, bagged, bag_label: bagLabel || null, no_of_box: noOfBox});
    }
  });
  if(!items.length) { showToast('Add at least one item with quantity > 0','error'); return; }

  // Sanity check on bag intents: a bagged line must have ≥2 boxes (otherwise
  // there's nothing meaningful to group). We warn and proceed without
  // grouping that line rather than failing the save.
  const lonelyBagged = bagIntents.filter(b => b.bagged && (b.no_of_box || 0) < 2);
  if(lonelyBagged.length){
    showToast(`⚠ ${lonelyBagged.length} bagged line${lonelyBagged.length>1?'s':''} have <2 boxes — those will save as loose boxes`, 'info', 4500);
    lonelyBagged.forEach(b => { b.bagged = false; });
  }

  const saveBtn = document.getElementById('grn-save-btn');
  if(saveBtn) { const orig=saveBtn.innerHTML; saveBtn.innerHTML='<span class="spinner"></span> Saving…'; saveBtn.disabled=true;
    try {
      const res = await fetch('/api/pm_stock/grn/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({grn_date:grnDate, po_number:poNum||null, po_date:poDate, po_id:poId,
                              supplier, godown_id:parseInt(godownId), remarks,
                              party_invoice_no:partyInvoiceNo, party_invoice_date:partyInvoiceDate,
                              supervisor_name:supervisorName, items})
      });
      const data = await res.json();
      if(data.status==='ok') {
        const totalQty = items.reduce((s,i)=>s+i.qty_received,0);
        const isPending = (data.verification_status === 'pending') || !!data.verify_required;
        if(isPending){
          showToast(`📥 PM GRN saved as PENDING — ${data.grn_no}. Scan all boxes to verify and post stock.`, 'info', 6000);
        } else {
          showToast(`✓ PM GRN saved — ${data.grn_no}  (${items.length} item${items.length>1?'s':''}, ${fmt(totalQty)} units)`, 'success');
        }
        const badge = document.getElementById('grn-vno-badge');
        if(badge) { badge.textContent = data.grn_no; badge.style.display=''; }

        // ── Post-save bag/group creation ───────────────────────────────
        // For every line the operator marked "bag", call the group endpoint
        // to bundle that line's boxes into a group. Best-effort: failures
        // are toasted but don't roll back the GRN. The user can still
        // create groups manually later (Stage 3).
        const baggedLines = bagIntents.filter(b => b.bagged);
        if(baggedLines.length && data.id){
          try {
            const br = await fetch(`/api/pm_stock/grn/${data.id}/boxes_by_product`);
            const bd = await br.json();
            if(bd.status === 'ok'){
              const byPid = bd.by_product || {};
              const groupResults = [];
              for(const intent of baggedLines){
                const boxes = byPid[String(intent.product_id)] || byPid[intent.product_id] || [];
                if(boxes.length < 2){ continue; }
                try {
                  const gr = await fetch('/api/pm_stock/groups/create_for_grn', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({
                      grn_id:     data.id,
                      product_id: intent.product_id,
                      box_ids:    boxes.map(b => b.box_id),
                      label:      intent.bag_label,
                      remarks:    null,
                    })
                  });
                  const gd = await gr.json();
                  if(gd.status === 'ok'){
                    groupResults.push({ok:true, code:gd.group?.group_code, count:gd.group?.member_count});
                  } else {
                    groupResults.push({ok:false, msg:gd.message || 'Failed', pid:intent.product_id});
                  }
                } catch(e){
                  groupResults.push({ok:false, msg:e.message, pid:intent.product_id});
                }
              }
              const okCount = groupResults.filter(r => r.ok).length;
              const failCount = groupResults.filter(r => !r.ok).length;
              if(okCount){
                const codes = groupResults.filter(r=>r.ok).map(r=>r.code).join(', ');
                showToast(`🛍️ ${okCount} bag${okCount>1?'s':''} created: ${codes}`, 'success', 5000);
              }
              if(failCount){
                showToast(`⚠ ${failCount} bag(s) failed to create — see console`, 'error', 4500);
                console.warn('[grn-bag] failed group creates:', groupResults.filter(r=>!r.ok));
              }
            }
          } catch(e){
            showToast('GRN saved but bag creation failed: '+e.message, 'error', 4500);
            console.warn('[grn-bag] post-save error:', e);
          }
        }

        closeModal('grnModal');
        const _td = new Date().toISOString().slice(0,10);
        const _gf2 = document.getElementById('grn-from'); if(_gf2 && !_gf2.value) _gf2.value = _td;
        const _gt2 = document.getElementById('grn-to');   if(_gt2 && !_gt2.value) _gt2.value = _td;
        loadGrnList();
        await loadSummary();
        // If verification mode is on, jump straight into the Verify modal so
        // the operator can scan boxes immediately. Defer to next tick so the
        // GRN modal close animation doesn't fight the new modal opening.
        if(isPending && data.id && typeof openGrnVerifyModal === 'function'){
          setTimeout(() => { openGrnVerifyModal(data.id); }, 250);
        }
      } else { showToast(data.message||'Error saving GRN','error'); }
    } catch(e) { showToast('Error: '+e.message,'error'); }
    finally { saveBtn.innerHTML=orig; saveBtn.disabled=false; }
  }
}

// (moved) let _vlogFilter — declared in pm_stock_log.js

// ── deleteGrn (originally L897..L913) ─────────────────────────
async function deleteGrn(id, grnNo) {
  if(!confirm(`Delete PM GRN ${grnNo}?\n\nThis will also remove the auto-created godown inward entries. This cannot be undone.`)) return;
  const res  = await fetch('/api/pm_stock/grn/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  const data = await res.json();
  if(data.status==='ok') {
    showToast(`✓ PM GRN ${grnNo} deleted`,'success');
    _grnRows = _grnRows.filter(r=>r.id!==id);
    renderGrnList(_grnRows);
    await loadSummary();
  } else { showToast(data.message||'Error','error'); }
}

/* ═══════════════════════════════════════════════════════════
   MATERIAL TRANSFER VOUCHER (MTV)
═══════════════════════════════════════════════════════════ */
let _mtvItemCount = 0;


// ── openMtvModal (originally L914..L926) ─────────────────────────
function openMtvModal() {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('mtv-date').value = today;
  document.getElementById('mtv-remarks').value = '';
  document.getElementById('mtv-items-container').innerHTML = '';
  const badge = document.getElementById('mtv-vno-badge');
  if(badge) badge.style.display = 'none';
  populateGodownSelects();
  _mtvItemCount = 0;
  addMtvItem();
  document.getElementById('mtvModal').classList.add('open');
}


// ── openMtvForm (originally L927..L928) ─────────────────────────
function openMtvForm() { openMtvModal(); } // alias


// ── closeMtvForm (originally L929..L930) ─────────────────────────
function closeMtvForm() { closeModal('mtvModal'); }


// ── addMtvItem (originally L931..L963) ─────────────────────────
function addMtvItem() {
  _mtvItemCount++;
  const wrap = document.getElementById('mtv-items-container');
  if(!wrap) return;
  const prodOpts = _products.map(p =>
    `<option value="${p.id}">[${p.pm_type}] ${p.product_name}</option>`
  ).join('');
  const row = document.createElement('div');
  row.className = 'mtv-item-row';
  row.style.cssText = 'display:grid;grid-template-columns:2fr 120px 1fr auto;gap:8px;align-items:end;margin-bottom:8px;padding:10px 12px;background:var(--surface2,#f8fafc);border:1px solid var(--border,rgba(0,0,0,.09));border-radius:8px';
  row.innerHTML = `
    <div class="form-group" style="margin:0">
      <label style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:4px">Product *</label>
      <select class="mtv-item-product"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:7px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none">
        <option value="">— Select Product —</option>${prodOpts}
      </select>
    </div>
    <div class="form-group" style="margin:0">
      <label style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:4px">Qty *</label>
      <input type="number" class="mtv-item-qty" min="0.01" step="1" placeholder="0"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text,#111);outline:none">
    </div>
    <div class="form-group" style="margin:0">
      <label style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:4px">Remarks</label>
      <input type="text" class="mtv-item-remarks" placeholder="Optional…"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text,#111);outline:none">
    </div>
    <button onclick="this.closest('.mtv-item-row').remove()"
      style="width:30px;height:30px;border-radius:6px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center">✕</button>`;
  wrap.appendChild(row);
}


// ── saveMtv (originally L964..L1010) ─────────────────────────
async function saveMtv() {
  const mtvDate  = document.getElementById('mtv-date').value;
  const fromGd   = document.getElementById('mtv-from').value;
  const toGd     = document.getElementById('mtv-to').value;
  const fromType = document.getElementById('mtv-from-type').value;
  const toType   = document.getElementById('mtv-to-type').value;
  const remarks  = document.getElementById('mtv-remarks').value.trim();

  if(!mtvDate) { showToast('Select transfer date','error'); return; }
  if(!fromGd)  { showToast('Select FROM location','error'); return; }
  if(!toGd)    { showToast('Select TO location','error'); return; }
  if(fromGd===toGd && fromType===toType) { showToast('Source and destination are the same location + type','error'); return; }

  const items = [];
  document.querySelectorAll('.mtv-item-row').forEach(row => {
    const pid = parseInt(row.querySelector('.mi-product')?.value) || 0;
    const qty = parseFloat(row.querySelector('.mi-qty')?.value)   || 0;
    const rem = row.querySelector('.mi-remarks')?.value?.trim()   || '';
    if(pid && qty > 0) items.push({product_id:pid, qty, remarks:rem});
  });
  if(!items.length) { showToast('Add at least one item with quantity > 0','error'); return; }

  const saveBtn = document.getElementById('mtv-save-btn');
  if(saveBtn) {
    const orig=saveBtn.innerHTML; saveBtn.innerHTML='<span class="spinner"></span> Saving…'; saveBtn.disabled=true;
    try {
      const res = await fetch('/api/pm_stock/mtv/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({mtv_date:mtvDate, from_godown:parseInt(fromGd), to_godown:parseInt(toGd),
                              from_type:fromType, to_type:toType, remarks, items})
      });
      const data = await res.json();
      if(data.status==='ok') {
        const fromG = _godowns.find(g=>String(g.id)===fromGd);
        const toG   = _godowns.find(g=>String(g.id)===toGd);
        showToast(`✓ Transfer saved — ${data.mtv_no}  ${fromG?.name||''} → ${toG?.name||''}  (${items.length} item${items.length>1?'s':''})`, 'success');
        const badge = document.getElementById('mtv-vno-badge');
        if(badge) { badge.textContent = data.mtv_no; badge.style.display=''; }
        closeModal('mtvModal');
        loadMtvList();
        await loadSummary();
      } else { showToast(data.message||'Error saving transfer','error'); }
    } catch(e) { showToast('Error: '+e.message,'error'); }
    finally { saveBtn.innerHTML=orig; saveBtn.disabled=false; }
  }
}


// ── loadMtvList (originally L1011..L1012) ─────────────────────────
async function loadMtvList() { await loadVoucherLog(); }  // now refreshes combined log


// ── renderMtvList (originally L1013..L1048) ─────────────────────────
function renderMtvList(rows) {
  const {slice,total,pages,page,start} = paginate(rows,'mtv');
  const tbody = document.getElementById('mtvListTbody');
  if(!tbody) return;
  if(!rows.length) {
    tbody.innerHTML=`<tr><td colspan="9" class="no-data"><i class="fas fa-exchange-alt"></i> No transfer vouchers found. Click "New Transfer" to create one.</td></tr>`;
    document.getElementById('mtvPag').innerHTML=''; return;
  }
  tbody.innerHTML = slice.map((r,i) => {
    return `<tr class="dbl-hint" ondblclick="openEditMtv(${r.id})" title="Double-click to edit" style="cursor:pointer">
      <td style="color:var(--muted,#9ca3af);font-size:11px">${start+i+1}</td>
      <td><span style="font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;
        color:var(--amber-text,#92400e);background:rgba(245,158,11,.08);
        padding:2px 9px;border-radius:4px;border:1px solid rgba(245,158,11,.25)">${r.mtv_no}</span></td>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(r.mtv_date)}</td>
      <td style="font-size:11px">${r.from_name||'—'}</td>
      <td style="font-size:11px">${r.to_name||'—'}</td>
      <td class="num" style="color:var(--muted2,#6b7280)">${r.item_count}</td>
      <td class="num" style="font-weight:700;color:var(--amber-text,#92400e)">${fmt(r.total_qty)}</td>
      <td style="color:var(--muted,#9ca3af);font-size:11px">${r.created_by||'—'}</td>
      <td style="color:var(--muted,#9ca3af);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.remarks||'—'}</td>
      <td style="text-align:center;white-space:nowrap">
        <button class="action-btn" onclick="openEditMtv(${r.id})" title="Edit MTV" style="background:rgba(245,158,11,.1);color:var(--amber-text,#92400e);border:1px solid rgba(245,158,11,.3)"><i class="fas fa-edit"></i></button>
        <button class="action-btn" onclick="pmMtvPrintById(${r.id})" title="Print MTV" style="background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25)"><i class="fas fa-print"></i></button>
        <button class="action-btn del" onclick="deleteMtv(${r.id},'${r.mtv_no}')" title="Delete MTV"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
  renderPag('mtvPag','mtv',total,pages,page);
}

/* ═══════════════════════════════════════════════════════════
   VOUCHER NUMBERING SETTINGS
═══════════════════════════════════════════════════════════ */
let _voucherSeqs = [];


// ── openVoucherNumSettings (originally L1049..L1053) ─────────────────────────
async function openVoucherNumSettings() {
  document.getElementById('voucherSettingsModalReal').classList.add('open');
  await loadVoucherSeqs();
}


// ── loadVoucherSeqs (originally L1054..L1061) ─────────────────────────
async function loadVoucherSeqs() {
  const tbody = document.getElementById('voucherSeqTbody');
  if(tbody) tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted,#9ca3af)"><span class="spinner"></span> Loading…</td></tr>`;
  try { const res=await fetch('/api/pm_stock/voucher_sequences'); _voucherSeqs=await res.json(); }
  catch(e) { _voucherSeqs=[]; }
  renderVoucherSeqs();
}


// ── renderVoucherSeqs (originally L1062..L1102) ─────────────────────────
function renderVoucherSeqs() {
  const tbody = document.getElementById('voucherSeqTbody');
  if(!tbody) return;
  const typeLabels = {
    'PM-GRN':  '📥 PM GRN (Goods Receipt)',
    'PM-MTV':  '🔄 Material Transfer Voucher',
    'PM-GTXN': '🏢 Godown Transaction',
    'PM-FTXN': '🏭 Factory (Floor) Transaction',
  };
  tbody.innerHTML = _voucherSeqs.map((s,i) => `
    <tr style="border-bottom:1px solid var(--border,rgba(0,0,0,.08))">
      <td style="padding:10px 14px;font-weight:600;color:var(--text,#111);font-size:12px">${typeLabels[s.voucher_type]||s.voucher_type}</td>
      <td style="padding:10px 14px">
        <input type="text" data-i="${i}" data-f="prefix" value="${s.prefix||''}"
          placeholder="e.g. PMG"
          style="width:80px;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:5px 8px;font-size:12px;font-family:var(--font-mono,monospace);color:var(--text,#111);outline:none"
          oninput="updateVoucherSeq(this)">
      </td>
      <td style="padding:10px 14px">
        <input type="number" data-i="${i}" data-f="last_num" value="${s.last_num||0}" min="0"
          style="width:80px;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text,#111);outline:none"
          oninput="updateVoucherSeq(this)">
      </td>
      <td style="padding:10px 14px">
        <input type="number" data-i="${i}" data-f="pad_digits" value="${s.pad_digits||4}" min="2" max="8"
          style="width:60px;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text,#111);outline:none"
          oninput="updateVoucherSeq(this)">
      </td>
      <td style="padding:10px 14px">
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" data-i="${i}" data-f="reset_yearly" ${s.reset_yearly?'checked':''}
            onchange="updateVoucherSeq(this)" style="accent-color:var(--teal,#0d9488);width:14px;height:14px">
          Reset yearly
        </label>
      </td>
      <td style="padding:10px 14px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--teal,#0d9488);font-weight:700" id="vseq-preview-${i}">
        ${_previewVoucher(s)}
      </td>
    </tr>`).join('');
}


// ── _previewVoucher (originally L1103..L1110) ─────────────────────────
function _previewVoucher(s) {
  const now = new Date();
  const fy = now.getMonth()>=3 ? now.getFullYear() : now.getFullYear()-1;
  const fyLabel = `${String(fy).slice(2)}-${String(fy+1).slice(2)}`;
  const num = String((parseInt(s.last_num)||0)+1).padStart(parseInt(s.pad_digits)||4,'0');
  return s.reset_yearly ? `${s.prefix||'X'}/${fyLabel}/${num}` : `${s.prefix||'X'}/${num}`;
}


// ── updateVoucherSeq (originally L1111..L1119) ─────────────────────────
function updateVoucherSeq(input) {
  const i = parseInt(input.dataset.i);
  const f = input.dataset.f;
  if(f==='reset_yearly') _voucherSeqs[i][f] = input.checked ? 1 : 0;
  else _voucherSeqs[i][f] = (f==='last_num'||f==='pad_digits') ? (parseInt(input.value)||0) : input.value;
  const prev = document.getElementById(`vseq-preview-${i}`);
  if(prev) prev.textContent = _previewVoucher(_voucherSeqs[i]);
}


// ── saveVoucherSeqs (originally L1120..L1138) ─────────────────────────
async function saveVoucherSeqs() {
  const btn = document.getElementById('vseq-save-btn');
  const orig = btn.innerHTML; btn.innerHTML='<span class="spinner"></span> Saving…'; btn.disabled=true;
  try {
    const res = await fetch('/api/pm_stock/voucher_sequences/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(_voucherSeqs)
    });
    const data = await res.json();
    if(data.status==='ok') { showToast('✓ Voucher numbering settings saved','success'); closeModal('voucherSettingsModalReal'); }
    else showToast(data.message||'Error','error');
  } catch(e) { showToast('Error: '+e.message,'error'); }
  finally { btn.innerHTML=orig; btn.disabled=false; }
}

/* ═══════════════════════════════════════════════════════════
   LOCATION-AWARE GODOWN/FLOOR ENTRY
   (patch existing functions to include godown_id)
═══════════════════════════════════════════════════════════ */

// ── saveVoucherSettings (originally L1828..L1829) ─────────────────────────
function saveVoucherSettings() { saveVoucherSeqs(); }


// ── clearGrnForm (originally L1783..L1794) ─────────────────────────
function clearGrnForm() {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('grn-date').value = today;
  const pn = document.getElementById('grn-po-number'); if(pn) pn.value='';
  document.getElementById('grn-po-date').value='';
  document.getElementById('grn-supplier').value=''; const _gst=document.getElementById('grn-supplier-text'); if(_gst)_gst.value='';
  document.getElementById('grn-remarks').value='';
  document.getElementById('grn-items-container').innerHTML='';
  _grnItemCount=0;
  addGrnItem();
}


// ── clearGrnFilters (originally L1795..L1805) ─────────────────────────
function clearGrnFilters() {
  const today = new Date().toISOString().slice(0,10);
  const gf = document.getElementById('grn-from'); if(gf) gf.value='';
  const gt = document.getElementById('grn-to');   if(gt) gt.value='';
  const gs = document.getElementById('grn-search'); if(gs) gs.value='';
  _grnRows=[];
  const tb = document.getElementById('grnListTbody');
  if(tb) tb.innerHTML=`<tr><td colspan="11" class="no-data"><i class="fas fa-file-invoice"></i> Set date range and click Fetch</td></tr>`;
  document.getElementById('grnPag').innerHTML='';
}


// ── clearMtvForm (originally L1806..L1816) ─────────────────────────
function clearMtvForm() {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('mtv-date').value = today;
  document.getElementById('mtv-remarks').value='';
  const mf = document.getElementById('mtv-from'); if(mf) mf.value='';
  const mt = document.getElementById('mtv-to');   if(mt) mt.value='';
  document.getElementById('mtv-items-container').innerHTML='';
  _mtvItemCount=0;
  addMtvItem();
}


// ── clearMtvFilters (originally L1817..L1827) ─────────────────────────
function clearMtvFilters() {
  const mfd = document.getElementById('mtv-from-date'); if(mfd) mfd.value='';
  const mtd = document.getElementById('mtv-to-date');   if(mtd) mtd.value='';
  const ms  = document.getElementById('mtv-search');    if(ms)  ms.value='';
  _mtvRows=[];
  const tb = document.getElementById('mtvListTbody');
  if(tb) tb.innerHTML=`<tr><td colspan="10" class="no-data"><i class="fas fa-exchange-alt"></i> Set date range and click Fetch</td></tr>`;
  const mp = document.getElementById('mtvPag'); if(mp) mp.innerHTML='';
}

// Alias for backward compat with topbar button


/* ════════════════════════════════════════════════════════════════
   GRN VERIFY (box-scan) MODAL
   Used when admin has turned on `grn_verify_required`. After save,
   the GRN sits in 'pending' state with no inward stock posted.
   This modal lets the operator:
     • see the expected box list and required totals,
     • scan each box (camera scanner OR keystroke / paste),
     • watch progress (X / N boxes scanned),
     • commit when everything matches — server posts inward stock
       and flips the GRN to 'verified'.
   The flow injects the modal HTML lazily on first open so we don't
   bloat the base page for installs that never use this feature.
════════════════════════════════════════════════════════════════ */

let _grnVerify = {
  grnId:        null,
  grnNo:        '',
  expected:     [],     // array of { box_code, product_id, product_name, per_box_qty, box_seq, total_boxes }
  expectedSet:  null,   // Set of upper-cased box_code strings
  scannedSet:   null,   // Set of upper-cased box_code strings (deduped)
  scannedOrder: [],     // chronological scan list (preserves "last scanned" feedback)
  itemTotal:    0,
  boxTotal:     0,
  status:       'pending',
  // Latest discrepancy report (set after a failed verify). Used by the
  // share-action buttons (download PDF, email, WhatsApp).
  lastReport:   null,   // { report_id, report_no, mismatch_kind, pdf_available, summary, kind_label }
};

function _gvEnsureModal(){
  if(document.getElementById('grnVerifyModal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="modal-overlay" id="grnVerifyModal" style="z-index:910">
    <div class="modal" style="max-width:min(98vw,1100px);padding:0;overflow:hidden;border-radius:14px;display:flex;flex-direction:column;max-height:92vh">
      <div style="padding:14px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#0ea5e9 0%,#0d9488 100%);color:#fff">
        <div>
          <div style="font-size:14px;font-weight:800;letter-spacing:.3px">🔍 Verify GRN — Box Scan</div>
          <div id="gv-subtitle" style="font-size:11px;opacity:.92;margin-top:2px">Scan every box on this GRN to post inward stock.</div>
        </div>
        <button class="modal-close" style="color:#fff" onclick="closeGrnVerifyModal()">✕</button>
      </div>

      <div style="padding:14px 20px;display:flex;gap:14px;flex-wrap:wrap;background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07))">
        <div style="flex:1;min-width:140px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">GRN No.</div>
          <div id="gv-grnno" style="font-family:var(--font-mono,monospace);font-size:14px;font-weight:800;color:#0d9488;margin-top:2px">—</div>
        </div>
        <div style="flex:1;min-width:140px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Boxes Scanned</div>
          <div id="gv-progress" style="font-size:14px;font-weight:800;color:var(--htxtb,#111);margin-top:2px">0 / 0</div>
        </div>
        <div style="flex:1;min-width:140px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Required Qty</div>
          <div id="gv-itemqty" style="font-size:14px;font-weight:800;color:var(--htxtb,#111);margin-top:2px">0.00</div>
        </div>
        <div style="flex:1;min-width:140px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Boxes Total Qty</div>
          <div id="gv-boxqty" style="font-size:14px;font-weight:800;color:var(--htxtb,#111);margin-top:2px">0.00</div>
        </div>
      </div>

      <div style="padding:14px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07))">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="gv-scan-input" type="text" placeholder="Scan or type box code, then press Enter…"
            style="flex:1;min-width:200px;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;
                   padding:10px 12px;font-family:var(--font-mono,monospace);font-size:13px;color:var(--text,#111);outline:none"
            onkeydown="gvHandleScanKey(event)" autocomplete="off">
          <button class="btn btn-outline btn-sm" onclick="gvAddTyped()" title="Add the typed code">Add</button>
          <button class="btn btn-outline btn-sm" onclick="gvResetScans()" title="Clear all scanned codes">Reset</button>
          <button class="btn btn-sm" onclick="gvOpenAutoVerify()" title="Admin: bulk-verify by uploading an Excel of box codes (column A)"
                  style="background:#7c3aed;color:#fff;font-weight:700">🔐 Auto-Verify</button>
        </div>
        <div id="gv-scan-msg" style="margin-top:8px;font-size:11px;color:var(--hmuted,#9ca3af);min-height:14px"></div>
      </div>

      <div style="flex:1;overflow:auto;padding:8px 20px 14px 20px">
        <!-- Side-by-side compare: left = expected (labels), right = verified scans.
             At narrow widths (<840px modal) the grid stacks vertically — the
             right column moves below the left so neither table gets crushed. -->
        <style>
          @media (max-width: 840px){
            #grnVerifyModal .gv-compare-grid{ grid-template-columns: 1fr !important; }
            #grnVerifyModal .gv-compare-grid > div:first-child{ border-right:none !important; border-bottom:1.5px solid var(--hbdr,rgba(0,0,0,.1)); }
          }
        </style>
        <div class="gv-compare-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:0;align-items:start;
                    border:1.5px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;overflow:hidden;background:var(--hsurf2,#f8fafc)">
          <!-- LEFT: Expected boxes -->
          <div style="border-right:1.5px solid var(--hbdr,rgba(0,0,0,.1));background:#fff">
            <div style="padding:9px 12px;background:linear-gradient(180deg,#f1f5f9,#e2e8f0);font-size:11px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.6px;display:flex;align-items:center;justify-content:space-between">
              <span>📋 Expected (label)</span>
              <span id="gv-exp-count" style="font-size:10px;color:#64748b">—</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
              <thead>
                <tr style="background:#f8fafc">
                  <th style="text-align:left;padding:6px 8px;width:26px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">#</th>
                  <th style="text-align:left;padding:6px 8px;width:90px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Box Code</th>
                  <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Product</th>
                  <th style="text-align:right;padding:6px 8px;width:64px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Qty</th>
                </tr>
              </thead>
              <tbody id="gv-exp-tbody">
                <tr><td colspan="4" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">Loading…</td></tr>
              </tbody>
            </table>
          </div>

          <!-- RIGHT: Verified / scanned boxes -->
          <div style="background:#fff">
            <div style="padding:9px 12px;background:linear-gradient(180deg,rgba(13,148,136,.08),rgba(13,148,136,.16));font-size:11px;font-weight:800;color:#0d9488;text-transform:uppercase;letter-spacing:.6px;display:flex;align-items:center;justify-content:space-between">
              <span>🔍 Verified (scan)</span>
              <span id="gv-ver-count" style="font-size:10px;color:#0d9488">—</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
              <thead>
                <tr style="background:#f8fafc">
                  <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Scanned Box</th>
                  <th style="text-align:right;padding:6px 8px;width:64px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Qty</th>
                  <th style="text-align:center;padding:6px 8px;width:84px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:9.5px;color:#64748b;font-weight:800">Status</th>
                </tr>
              </thead>
              <tbody id="gv-ver-tbody">
                <tr><td colspan="3" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">No scans yet</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Summary band — totals + discrepancy hint -->
        <div id="gv-summary-band" style="margin-top:10px;padding:9px 14px;border-radius:8px;background:#f1f5f9;border:1px solid var(--hbdr,rgba(0,0,0,.08));display:flex;gap:18px;flex-wrap:wrap;font-size:11.5px;align-items:center">
          <span><strong id="gv-sum-matched" style="color:#16a34a">0</strong> <span style="color:#16a34a">matched</span></span>
          <span><strong id="gv-sum-missing" style="color:#dc2626">0</strong> <span style="color:#dc2626">missing</span></span>
          <span><strong id="gv-sum-extra"   style="color:#d97706">0</strong> <span style="color:#d97706">extra</span></span>
          <span style="flex:1"></span>
          <span id="gv-sum-hint" style="color:var(--hmuted2,#6b7280);font-size:10.5px">Scan boxes to verify against the expected list →</span>
        </div>

        <!-- ── Discrepancy panel (only visible after a failed verify) ── -->
        <div id="gv-disc-panel" style="display:none;margin-top:14px;padding:14px;border:1.5px solid #fca5a5;background:#fef2f2;border-radius:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="font-size:14px;font-weight:800;color:#dc2626;letter-spacing:.3px">⚠ Discrepancy Detected — Stock Not Posted</div>
            <span id="gv-disc-reportno" style="font-family:var(--font-mono,monospace);font-size:10.5px;font-weight:700;color:#7f1d1d;background:#fee2e2;border:1px solid #fca5a5;padding:2px 7px;border-radius:4px"></span>
          </div>
          <div id="gv-disc-summary" style="font-size:11.5px;color:#7f1d1d;line-height:1.6;margin-bottom:10px"></div>

          <!-- Recipient row: phone + email + supervisor name (saved per-browser) -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
            <div>
              <label style="font-size:9.5px;font-weight:800;color:#7f1d1d;letter-spacing:.4px;text-transform:uppercase;display:block;margin-bottom:3px">Supervisor name</label>
              <input id="gv-rcpt-name" type="text" placeholder="e.g. Rakesh K"
                style="width:100%;padding:7px 9px;font-size:12px;border:1.5px solid #fca5a5;border-radius:6px;background:#fff;outline:none">
            </div>
            <div>
              <label style="font-size:9.5px;font-weight:800;color:#7f1d1d;letter-spacing:.4px;text-transform:uppercase;display:block;margin-bottom:3px">Email (Gmail)</label>
              <input id="gv-rcpt-email" type="email" placeholder="supervisor@hcp.com"
                style="width:100%;padding:7px 9px;font-size:12px;border:1.5px solid #fca5a5;border-radius:6px;background:#fff;outline:none">
            </div>
            <div>
              <label style="font-size:9.5px;font-weight:800;color:#7f1d1d;letter-spacing:.4px;text-transform:uppercase;display:block;margin-bottom:3px">WhatsApp phone (with country code)</label>
              <input id="gv-rcpt-phone" type="tel" placeholder="+919876543210"
                style="width:100%;padding:7px 9px;font-size:12px;border:1.5px solid #fca5a5;border-radius:6px;background:#fff;outline:none">
            </div>
          </div>

          <!-- Action buttons -->
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm" onclick="gvDownloadReport()"
              style="background:#dc2626;color:#fff;border:1px solid #dc2626">
              <i class="fas fa-file-pdf"></i> Download PDF
            </button>
            <button class="btn btn-sm" onclick="gvPrintReport()"
              style="background:#fff;color:#dc2626;border:1.5px solid #dc2626"
              title="Open the discrepancy PDF in a new tab and trigger print">
              <i class="fas fa-print"></i> Print
            </button>
            <button class="btn btn-sm" onclick="gvSendViaGmail()"
              style="background:#fff;color:#dc2626;border:1.5px solid #dc2626">
              <i class="fas fa-envelope"></i> Email via Gmail
            </button>
            <button class="btn btn-sm" onclick="gvSendViaWhatsappPdf()"
              style="background:#16a34a;color:#fff;border:1px solid #16a34a">
              <i class="fab fa-whatsapp"></i> WhatsApp · Send PDF
            </button>
            <button class="btn btn-sm" onclick="gvSendViaWhatsappText()"
              style="background:#fff;color:#16a34a;border:1.5px solid #16a34a">
              <i class="fab fa-whatsapp"></i> WhatsApp · Text Only
            </button>
          </div>
          <div style="margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.28);border-radius:6px;font-size:10.5px;color:#92400e;line-height:1.55">
            <strong>Browser limitation:</strong> Gmail and WhatsApp Web don't accept attachments via URL. Click <em>Download PDF</em> first, then <em>Email via Gmail</em> or <em>WhatsApp · Send PDF</em> — both will open the compose window with prefilled subject/body. Drag the just-downloaded PDF into the message to attach it.
          </div>
        </div>

        <!-- ── Operator note (shown only when there's a discrepancy candidate) ── -->
        <div id="gv-note-wrap" style="margin-top:12px">
          <label style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);letter-spacing:.5px;text-transform:uppercase;display:block;margin-bottom:4px">Operator note <span style="text-transform:none;font-weight:500;opacity:.7">(optional — added to discrepancy report if verification fails)</span></label>
          <textarea id="gv-op-note" rows="2" placeholder="e.g. driver said two boxes were left at supplier dock, awaiting redelivery"
            style="width:100%;padding:8px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;resize:vertical;font-family:var(--font-body)"></textarea>
        </div>
      </div>

      <div style="padding:12px 20px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));display:flex;justify-content:space-between;align-items:center;background:var(--hsurf2,#f8fafc);gap:8px">
        <div id="gv-statusline" style="font-size:11px;color:var(--hmuted,#9ca3af)"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="closeGrnVerifyModal()">Close</button>
          <button class="btn btn-primary btn-sm" id="gv-confirm-btn" onclick="confirmGrnVerify()" disabled
            style="background:#0d9488;border-color:#0d9488">
            <i class="fas fa-check-circle"></i> Confirm &amp; Post Stock
          </button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap.firstElementChild);
}

function closeGrnVerifyModal(){
  const m = document.getElementById('grnVerifyModal');
  if(m) m.classList.remove('open');
}

async function openGrnVerifyModal(grnId){
  if(!grnId){ if(typeof showToast==='function') showToast('No GRN id','error'); return; }
  _gvEnsureModal();
  // Reset state
  _grnVerify = {
    grnId, grnNo:'', expected:[], expectedSet:new Set(),
    scannedSet:new Set(), scannedOrder:[],
    itemTotal:0, boxTotal:0, status:'pending', lastReport:null
  };
  document.getElementById('gv-exp-tbody').innerHTML =
    `<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af)"><span class="spinner"></span> Loading expected boxes…</td></tr>`;
  document.getElementById('gv-ver-tbody').innerHTML =
    `<tr><td colspan="3" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">No scans yet</td></tr>`;
  document.getElementById('gv-grnno').textContent   = '—';
  document.getElementById('gv-progress').textContent = '0 / 0';
  document.getElementById('gv-itemqty').textContent  = '0.00';
  document.getElementById('gv-boxqty').textContent   = '0.00';
  document.getElementById('gv-scan-input').value     = '';
  document.getElementById('gv-scan-msg').textContent = '';
  document.getElementById('gv-statusline').textContent = '';
  const _opNote = document.getElementById('gv-op-note');
  if(_opNote) _opNote.value = '';
  // Reset the discrepancy panel — hidden until a verify attempt fails.
  const _disc = document.getElementById('gv-disc-panel');
  if(_disc) _disc.style.display = 'none';
  // Restore the supervisor recipients from prior session (browser-local).
  // Stored under a single key so any GRN's verify modal sees the same default
  // — supervisors are the same people across vouchers.
  try {
    const saved = JSON.parse(localStorage.getItem('pm_disc_recipients') || '{}');
    const setIf = (id, v) => { const el = document.getElementById(id); if(el) el.value = v || ''; };
    setIf('gv-rcpt-name',  saved.name);
    setIf('gv-rcpt-email', saved.email);
    setIf('gv-rcpt-phone', saved.phone);
  } catch(_){ /* ignore parse errors */ }
  const btn = document.getElementById('gv-confirm-btn');
  if(btn){ btn.disabled = true; }
  document.getElementById('grnVerifyModal').classList.add('open');

  try {
    const res = await fetch(`/api/pm_stock/grn/${grnId}/verify_status`);
    const d   = await res.json();
    if(d.status !== 'ok'){
      document.getElementById('gv-exp-tbody').innerHTML =
        `<tr><td colspan="4" style="padding:24px;text-align:center;color:#dc2626">${d.message || 'Failed to load GRN'}</td></tr>`;
      return;
    }
    const g = d.grn || {};
    _grnVerify.grnNo       = g.grn_no || '';
    _grnVerify.expected    = g.boxes || [];
    _grnVerify.expectedSet = new Set(_grnVerify.expected.map(b => String(b.box_code || '').toUpperCase().trim()));
    // Also build a short_code → box_code map. Newer labels encode the
    // compact short_code in their QR (e.g. A0004187). Operators may
    // scan either format depending on label generation, so we resolve
    // any short-code hit back to its corresponding long box_code before
    // checking the expected set.
    _grnVerify.shortToLong = new Map();
    for(const b of _grnVerify.expected){
      const sc = String(b.short_code || '').toUpperCase().trim();
      const lc = String(b.box_code   || '').toUpperCase().trim();
      if(sc && lc) _grnVerify.shortToLong.set(sc, lc);
    }
    _grnVerify.itemTotal   = Number(g.item_total_qty || 0);
    _grnVerify.boxTotal    = Number(g.total_qty || 0);
    _grnVerify.status      = g.verification_status || 'pending';

    document.getElementById('gv-grnno').textContent  = _grnVerify.grnNo;
    document.getElementById('gv-itemqty').textContent = _grnVerify.itemTotal.toFixed(2);
    document.getElementById('gv-boxqty').textContent  = _grnVerify.boxTotal.toFixed(2);
    document.getElementById('gv-subtitle').textContent =
      _grnVerify.status === 'verified'
        ? `Already verified — stock has been posted. Read-only view.`
        : `Scan every box on this GRN to post inward stock.`;

    if(_grnVerify.status === 'verified'){
      // Show all rows as already-verified for read-only context.
      _grnVerify.scannedSet = new Set(_grnVerify.expectedSet);
      _grnVerify.scannedOrder = Array.from(_grnVerify.expectedSet);
      const inp = document.getElementById('gv-scan-input');
      if(inp){ inp.disabled = true; inp.placeholder = 'GRN already verified.'; }
    } else {
      const inp = document.getElementById('gv-scan-input');
      if(inp){ inp.disabled = false; inp.placeholder = 'Scan or type box code, then press Enter…'; setTimeout(()=>inp.focus(), 150); }
    }
    gvRender();
  } catch(e){
    document.getElementById('gv-exp-tbody').innerHTML =
      `<tr><td colspan="4" style="padding:24px;text-align:center;color:#dc2626">Network error: ${e.message}</td></tr>`;
  }
}

function gvRender(){
  const expBody = document.getElementById('gv-exp-tbody');
  const verBody = document.getElementById('gv-ver-tbody');
  if(!expBody || !verBody) return;

  const exp = _grnVerify.expected || [];
  if(!exp.length){
    expBody.innerHTML = `<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">No boxes expected on this GRN — verification not applicable.</td></tr>`;
    verBody.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">—</td></tr>`;
    document.getElementById('gv-progress').textContent = '0 / 0';
    return;
  }

  const scanned     = _grnVerify.scannedSet || new Set();
  const scannedList = _grnVerify.scannedOrder || [];
  // Quick lookup: box_code → expected row for the right-side rendering.
  const expByCode = new Map();
  exp.forEach(b => {
    const code = String(b.box_code || '').toUpperCase();
    if(code) expByCode.set(code, b);
  });

  // ── LEFT (Expected): one row per expected box, highlight matched ones ──
  expBody.innerHTML = exp.map((b, i) => {
    const code        = String(b.box_code  || '').toUpperCase();
    const shortCode   = String(b.short_code || '').toUpperCase();
    const displayCode = shortCode || code;
    const isOk = scanned.has(code);
    const bg   = isOk ? 'rgba(22,163,74,.06)' : 'transparent';
    const stripe = isOk ? 'border-left:3px solid #16a34a' : 'border-left:3px solid transparent';
    const qty  = Number(b.per_box_qty || 0).toFixed(2);
    const pname = b.product_name || `(product #${b.product_id})`;
    return `
      <tr style="background:${bg};${stripe}">
        <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));color:var(--hmuted,#9ca3af);font-size:11px">${i+1}</td>
        <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;color:#0d9488;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${code}">${displayCode}</td>
        <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${pname}">${pname}</td>
        <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));text-align:right;font-variant-numeric:tabular-nums;font-size:11px">${qty}</td>
      </tr>`;
  }).join('');

  // ── RIGHT (Verified): one row per scanned code, in scan order ──
  // Includes both matches AND extras. Extras (codes not in the expected
  // set) are flagged in red so the operator sees them as discrepancies
  // before even confirming.
  if(!scannedList.length){
    verBody.innerHTML = `<tr><td colspan="3" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">No scans yet — start scanning to verify ↓</td></tr>`;
  } else {
    verBody.innerHTML = scannedList.map(code => {
      const upper = String(code || '').toUpperCase();
      const isMatch = _grnVerify.expectedSet.has(upper);
      const expBox  = expByCode.get(upper);
      const shortCode = String(expBox?.short_code || '').toUpperCase();
      const displayCode = shortCode || upper;
      const qty = expBox ? Number(expBox.per_box_qty || 0).toFixed(2) : '—';
      const bg  = isMatch ? 'rgba(22,163,74,.06)' : 'rgba(220,38,38,.06)';
      const tint = isMatch ? '#16a34a' : '#dc2626';
      const label = isMatch ? '✓ matched' : '⚠ extra';
      const stripe = `border-left:3px solid ${tint}`;
      return `
        <tr style="background:${bg};${stripe}">
          <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;color:${tint};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${upper}">${displayCode}</td>
          <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));text-align:right;font-variant-numeric:tabular-nums;font-size:11px">${qty}</td>
          <td style="padding:7px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));text-align:center;font-size:10px;font-weight:800;color:${tint};letter-spacing:.3px">${label}</td>
        </tr>`;
    }).join('');
  }

  // ── Counts ──
  const total = _grnVerify.expectedSet.size;
  const done  = Array.from(scanned).filter(c => _grnVerify.expectedSet.has(c)).length;
  const extra = Array.from(scanned).filter(c => !_grnVerify.expectedSet.has(c)).length;
  const missing = total - done;
  document.getElementById('gv-progress').textContent = `${done} / ${total}`;
  const _expCount = document.getElementById('gv-exp-count'); if(_expCount) _expCount.textContent = `${total} box(es)`;
  const _verCount = document.getElementById('gv-ver-count'); if(_verCount) _verCount.textContent = `${scannedList.length} scan(s)`;

  // Summary band
  const _m = document.getElementById('gv-sum-matched'); if(_m) _m.textContent = done;
  const _mi = document.getElementById('gv-sum-missing'); if(_mi) _mi.textContent = missing;
  const _ex = document.getElementById('gv-sum-extra'); if(_ex) _ex.textContent = extra;
  const _hint = document.getElementById('gv-sum-hint');
  if(_hint){
    if(missing === 0 && extra === 0 && done > 0){
      _hint.innerHTML = '<span style="color:#16a34a;font-weight:700">✓ All boxes matched — ready to confirm</span>';
    } else if(extra > 0){
      _hint.innerHTML = `<span style="color:#dc2626">${extra} extra scan(s) — these will be flagged as discrepancy</span>`;
    } else if(missing > 0){
      _hint.innerHTML = `<span style="color:#d97706">${missing} box(es) still missing — keep scanning →</span>`;
    } else {
      _hint.textContent = 'Scan boxes to verify against the expected list →';
    }
  }

  // Enable confirm button only when:
  //   1. status is still 'pending' (not already verified)
  //   2. every expected code has been scanned exactly once
  //   3. no foreign codes have been scanned (we never let them in, but defensive)
  const allScanned = (done === total && total > 0);
  const noForeign  = Array.from(scanned).every(c => _grnVerify.expectedSet.has(c));
  const ready      = (_grnVerify.status === 'pending' && allScanned && noForeign);
  const btn = document.getElementById('gv-confirm-btn');
  if(btn){ btn.disabled = !ready; }
  const sl = document.getElementById('gv-statusline');
  if(sl){
    if(_grnVerify.status === 'verified'){
      sl.textContent = '✓ Already verified.';
      sl.style.color = '#16a34a';
    } else if(ready){
      sl.textContent = `✓ All ${total} boxes scanned. Ready to post stock.`;
      sl.style.color = '#16a34a';
    } else {
      sl.textContent = `${total - done} box${(total-done)===1?'':'es'} remaining…`;
      sl.style.color = 'var(--hmuted,#9ca3af)';
    }
  }
}

function gvHandleScanKey(ev){
  if(ev.key === 'Enter'){
    ev.preventDefault();
    gvAddTyped();
  }
}
function gvAddTyped(){
  const inp = document.getElementById('gv-scan-input');
  if(!inp) return;
  const raw = (inp.value || '').trim();
  if(!raw) return;
  inp.value = '';
  gvIngestCode(raw);
  setTimeout(()=>inp.focus(), 0);
}
function gvIngestCode(raw){
  if(_grnVerify.status !== 'pending'){
    _gvFlash('GRN already verified — scans ignored.', 'warn');
    return;
  }
  // QR labels may encode either a bare code (one line) or a structured
  // payload like "BEARTUBE34-G0161-B001\n{json...}". Extract the first
  // non-empty line and try it. Also try parsing the JSON payload as a
  // fallback for QRs that put the canonical code only inside the JSON.
  let firstLine = String(raw || '').split('\n')[0].trim();
  let code = firstLine.toUpperCase();
  if(!code) return;

  // Step 1: short_code → long box_code resolution.
  // Newer labels encode the compact short_code in their QR (A0004187 etc.).
  // Older labels encode the long box_code. We accept both formats here.
  if(_grnVerify.shortToLong && _grnVerify.shortToLong.has(code)){
    code = _grnVerify.shortToLong.get(code);
  }

  // Step 2: if the scan looked like JSON or contained one, try to pull
  // a box_code field out of it. This handles the structured-QR case
  // where the long code lives in the JSON blob.
  if(!_grnVerify.expectedSet.has(code) && raw.indexOf('{') >= 0){
    try {
      const jstart = raw.indexOf('{');
      const json = JSON.parse(raw.substring(jstart));
      if(json && typeof json.box_code === 'string'){
        const altLong = json.box_code.toUpperCase().trim();
        if(altLong && _grnVerify.expectedSet.has(altLong)){
          code = altLong;
        }
      }
      if(json && typeof json.short_code === 'string'){
        const altShort = json.short_code.toUpperCase().trim();
        if(_grnVerify.shortToLong && _grnVerify.shortToLong.has(altShort)){
          code = _grnVerify.shortToLong.get(altShort);
        }
      }
    } catch(_){ /* not JSON, ignore */ }
  }

  if(!_grnVerify.expectedSet.has(code)){
    _gvFlash(`✗ ${code} — not part of this GRN`, 'error');
    return;
  }
  if(_grnVerify.scannedSet.has(code)){
    _gvFlash(`⚠ ${code} — already scanned`, 'warn');
    return;
  }
  _grnVerify.scannedSet.add(code);
  _grnVerify.scannedOrder.push(code);
  // The operator is making progress — hide any prior discrepancy panel so
  // they're not staring at stale errors. The lastReport object is kept
  // (so they can still re-download the PDF later from the voucher log if
  // needed); only the in-modal panel is dismissed.
  const _disc = document.getElementById('gv-disc-panel');
  if(_disc && _disc.style.display !== 'none') _disc.style.display = 'none';
  _gvFlash(`✓ ${code} — scanned (${_grnVerify.scannedSet.size}/${_grnVerify.expectedSet.size})`, 'ok');
  gvRender();
}
function _gvFlash(msg, kind){
  const el = document.getElementById('gv-scan-msg');
  if(!el) return;
  const colorMap = { ok:'#16a34a', warn:'#d97706', error:'#dc2626' };
  el.textContent = msg;
  el.style.color = colorMap[kind] || 'var(--hmuted,#9ca3af)';
  el.style.fontWeight = '700';
}
function gvResetScans(){
  if(_grnVerify.status !== 'pending') return;
  if(!_grnVerify.scannedSet.size){ return; }
  if(!confirm('Clear all scanned box codes for this GRN?')) return;
  _grnVerify.scannedSet = new Set();
  _grnVerify.scannedOrder = [];
  _gvFlash('Scans cleared.', 'warn');
  gvRender();
}

async function confirmGrnVerify(){
  if(_grnVerify.status !== 'pending') return;
  const total = _grnVerify.expectedSet.size;
  const done  = _grnVerify.scannedSet.size;
  if(done < total){
    if(typeof showToast==='function') showToast(`${total-done} box${(total-done)===1?'':'es'} not yet scanned.`, 'error');
    return;
  }
  const note = (document.getElementById('gv-op-note')?.value || '').trim();
  const btn = document.getElementById('gv-confirm-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Verifying…';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/pm_stock/grn/${_grnVerify.grnId}/verify`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ box_codes: Array.from(_grnVerify.scannedSet), note })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      // ── Discrepancy path ────────────────────────────────────────────
      // Surface the mismatch as an inline panel with PDF/email/WhatsApp
      // share options. GRN stays pending; user must fix scans + retry
      // (or contact supervisor with the discrepancy report attached).
      if(d.code === 'verification_mismatch' || d.code === 'qty_mismatch'){
        _grnVerify.lastReport = d.report || null;
        _gvShowDiscrepancyPanel(d);
        if(typeof showToast==='function'){
          const labelMap = {verification_mismatch:'Box-set mismatch', qty_mismatch:'Quantity mismatch'};
          showToast(`⚠ ${labelMap[d.code] || 'Mismatch'} — discrepancy report ready to share`, 'error', 5500);
        }
        console.warn('[grn-verify]', d);
      } else {
        if(typeof showToast==='function') showToast(d.message || 'Verification failed', 'error', 5000);
      }
      btn.innerHTML = orig;
      btn.disabled = false;
      return;
    }
    if(typeof showToast==='function') showToast(d.message || `✓ GRN ${_grnVerify.grnNo} verified — stock posted.`, 'success', 5000);
    _grnVerify.status = 'verified';
    closeGrnVerifyModal();
    if(typeof loadGrnList === 'function')  loadGrnList();
    if(typeof loadSummary === 'function')  loadSummary();
  } catch(e){
    btn.innerHTML = orig;
    btn.disabled = false;
    if(typeof showToast==='function') showToast('Network error: ' + e.message, 'error');
  }
}

/* ── Discrepancy panel rendering & share actions ──────────────── */

function _gvShowDiscrepancyPanel(d){
  // Build the human-readable summary from the structured response
  const panel = document.getElementById('gv-disc-panel');
  if(!panel) return;
  const rno   = document.getElementById('gv-disc-reportno');
  const sum   = document.getElementById('gv-disc-summary');
  const r     = d.report || {};
  if(rno){
    if(r.report_no){ rno.textContent = r.report_no; rno.style.display = ''; }
    else           { rno.textContent = ''; rno.style.display = 'none'; }
  }
  // The summary mirrors what's in the PDF, but tighter — three short lines.
  const lines = [];
  if(d.code === 'qty_mismatch'){
    const it = Number(d.item_total || 0).toFixed(2);
    const bx = Number(d.box_total  || 0).toFixed(2);
    const dv = (Number(d.box_total||0) - Number(d.item_total||0)).toFixed(2);
    lines.push(`<strong>Quantity mismatch:</strong> declared ${it} vs box-sum ${bx} (variance ${dv > 0 ? '+'+dv : dv}).`);
  } else {
    const m = (d.missing||[]).length;
    const u = (d.unknown||[]).length;
    const dup = (d.duplicates||[]).length;
    const bits = [];
    if(m)   bits.push(`<strong>${m}</strong> missing`);
    if(u)   bits.push(`<strong>${u}</strong> unknown`);
    if(dup) bits.push(`<strong>${dup}</strong> duplicate`);
    lines.push(`<strong>Box-set mismatch:</strong> ${bits.join(' · ') || '—'}.`);
    lines.push(`Scanned ${d.scanned_count || 0} of ${d.expected_count || 0} expected.`);
  }
  if(sum) sum.innerHTML = lines.join('<br>');
  panel.style.display = '';
  // Scroll the panel into view so the user notices it
  setTimeout(() => { panel.scrollIntoView({behavior:'smooth', block:'nearest'}); }, 50);
}

function _gvSaveRecipients(){
  // Persist supervisor name/email/phone for next time.
  try {
    const data = {
      name:  (document.getElementById('gv-rcpt-name')?.value  || '').trim(),
      email: (document.getElementById('gv-rcpt-email')?.value || '').trim(),
      phone: (document.getElementById('gv-rcpt-phone')?.value || '').trim(),
    };
    localStorage.setItem('pm_disc_recipients', JSON.stringify(data));
    return data;
  } catch(_){ return {name:'', email:'', phone:''}; }
}

function _gvBuildShareText(){
  // Plain-text summary used for email body / WhatsApp text. Kept short
  // enough to fit comfortably in WhatsApp's URL-encoded message field
  // (~2000 char practical limit).
  const r = _grnVerify.lastReport || {};
  const grnNo = _grnVerify.grnNo || '—';
  const lines = [];
  lines.push(`*GRN Discrepancy Report*`);
  lines.push(`GRN: ${grnNo}`);
  if(r.report_no) lines.push(`Report: ${r.report_no}`);
  lines.push('');
  // Pull the human-readable summary out of the panel — it's already formatted.
  const sumEl = document.getElementById('gv-disc-summary');
  if(sumEl){
    const txt = sumEl.innerText || sumEl.textContent || '';
    if(txt.trim()) lines.push(txt.trim());
  }
  const note = (document.getElementById('gv-op-note')?.value || '').trim();
  if(note){ lines.push(''); lines.push(`Operator note: ${note}`); }
  lines.push('');
  lines.push(`Stock has NOT been posted — GRN remains pending until verification succeeds.`);
  return lines.join('\n');
}

function _gvReportPdfUrl(){
  const r = _grnVerify.lastReport || {};
  if(!r.report_id) return null;
  return `/api/pm_stock/grn/discrepancy_report/${r.report_id}/pdf`;
}

function gvDownloadReport(){
  const url = _gvReportPdfUrl();
  if(!url){
    if(typeof showToast==='function') showToast('No report available — run verify first.', 'error');
    return;
  }
  _gvSaveRecipients();
  // Trigger download via a transient anchor — same-origin, browser handles it.
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(_grnVerify.lastReport.report_no || 'discrepancy').replace(/\//g,'_')}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>a.remove(), 200);
  if(typeof showToast==='function') showToast('📄 PDF downloading…', 'info', 2500);
}

// Print the discrepancy report — opens the same server-generated PDF in a
// new tab and asks the browser to open its print dialog. We can't render
// the report contents inline because the PDF is built server-side; this
// uses the same artifact as Download/Email so paper, email, and chat
// recipients all see the exact same report.
function gvPrintReport(){
  const url = _gvReportPdfUrl();
  if(!url){
    if(typeof showToast==='function') showToast('No report available — run verify first.', 'error');
    return;
  }
  _gvSaveRecipients();
  // Open in a new tab so the operator can still see the verify modal
  // afterwards. window.open returns null if blocked by popup blocker; we
  // fall back to a direct navigation that the user can manually print.
  const w = window.open(url, '_blank');
  if(!w){
    if(typeof showToast==='function') showToast('Popup blocked — opening report in this tab. Use Ctrl+P to print.', 'info', 4000);
    window.location.href = url;
    return;
  }
  // Try to trigger the print dialog automatically once the PDF has loaded.
  // Cross-document print may fail on Chrome's built-in PDF viewer due to
  // sandboxing — in that case the operator presses Ctrl+P themselves.
  // The toast below tells them what to do if auto-print doesn't fire.
  try {
    w.addEventListener('load', () => {
      try { w.focus(); w.print(); } catch(_){}
    });
  } catch(_){}
  if(typeof showToast==='function') showToast('🖨️ Opening report — press Ctrl+P if the print dialog doesn\'t appear.', 'info', 3500);
}

function gvSendViaGmail(){
  const r = _grnVerify.lastReport || {};
  const rcpt = _gvSaveRecipients();
  if(!rcpt.email){
    if(typeof showToast==='function') showToast('Enter the supervisor\'s email first.', 'error');
    document.getElementById('gv-rcpt-email')?.focus();
    return;
  }
  // Auto-download the PDF first so it's already in the user's Downloads
  // folder ready to drag into the Gmail compose window. (Browsers do not
  // permit programmatic attachment to webmail composers.)
  if(_gvReportPdfUrl()){
    gvDownloadReport();
  }
  const subject = `GRN Discrepancy — ${_grnVerify.grnNo}${r.report_no ? ' · ' + r.report_no : ''}`;
  // Gmail compose URL drops the leading * markdown, but plain text is fine.
  const bodyTxt = _gvBuildShareText().replace(/\*/g,'') +
    '\n\n— Attached: discrepancy report PDF (drag from Downloads to attach).';
  const u = new URL('https://mail.google.com/mail/');
  u.searchParams.set('view', 'cm');
  u.searchParams.set('fs',   '1');
  u.searchParams.set('to',   rcpt.email);
  u.searchParams.set('su',   subject);
  u.searchParams.set('body', bodyTxt);
  window.open(u.toString(), '_blank', 'noopener');
  if(typeof showToast==='function') showToast('📧 Gmail opened. Drag the downloaded PDF into the message to attach.', 'info', 6000);
}

function _gvNormalisePhone(p){
  // WhatsApp wants digits only with country code (e.g. 919876543210, no '+').
  return String(p || '').replace(/[^0-9]/g, '');
}

function gvSendViaWhatsappPdf(){
  const rcpt = _gvSaveRecipients();
  const phone = _gvNormalisePhone(rcpt.phone);
  if(!phone){
    if(typeof showToast==='function') showToast('Enter the WhatsApp phone number with country code.', 'error');
    document.getElementById('gv-rcpt-phone')?.focus();
    return;
  }
  // Same flow as Gmail: download the PDF first, then open WhatsApp Web with
  // a prefilled message saying "see attached". User attaches manually.
  if(_gvReportPdfUrl()){
    gvDownloadReport();
  }
  const text = _gvBuildShareText() +
    '\n\nAttached: discrepancy report PDF (drag from Downloads to attach).';
  const u = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`;
  window.open(u, '_blank', 'noopener');
  if(typeof showToast==='function') showToast('💬 WhatsApp Web opened. Drag the downloaded PDF into the chat to attach.', 'info', 6000);
}

function gvSendViaWhatsappText(){
  const rcpt = _gvSaveRecipients();
  const phone = _gvNormalisePhone(rcpt.phone);
  if(!phone){
    if(typeof showToast==='function') showToast('Enter the WhatsApp phone number with country code.', 'error');
    document.getElementById('gv-rcpt-phone')?.focus();
    return;
  }
  // Text-only flow: no PDF download. The full discrepancy summary is sent
  // as a plain message — useful when the supervisor only needs the gist.
  const text = _gvBuildShareText();
  const u = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`;
  window.open(u, '_blank', 'noopener');
  if(typeof showToast==='function') showToast('💬 WhatsApp Web opened with the discrepancy text.', 'info', 4000);
}


/* ════════════════════════════════════════════════════════════════════════
   PM GRN INVOICE FILE ATTACHMENTS — disk-stored, multiple per GRN
   ════════════════════════════════════════════════════════════════════════
   Files: <flask-root>/uploads/pm_stock/grn/<grn_id>/invoice/<uuid>__<name>
   Endpoints (all under /api/pm_stock/grn/file/...):
     POST   /upload                — multipart {grn_id, file}
     GET    /list?grn_id=...       — { status, files: [...] }
     GET    /<file_id>             — streams the file (inline view)
     DELETE /<file_id>             — removes DB row + disk file
   The UI lives inside the Edit GRN modal (egrn-*). For a new GRN, you must
   save first, then re-open via "Edit" to attach invoices (since uploads
   need a GRN ID to anchor to).
*/

// In-memory list for the currently-open GRN.
var _pmGrnInvoiceFiles = [];

var _PMGRN_FILE_ACCEPT     = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';
var _PMGRN_FILE_MAX_BYTES  = 10 * 1024 * 1024;

// Trim "very_long_invoice_name_2026_05_13.pdf" to a chip-friendly form.
function _pmGrnTrimName(name, maxLen){
  name = String(name || '');
  if (name.length <= maxLen) return name;
  var dot = name.lastIndexOf('.');
  var ext = dot > 0 ? name.slice(dot) : '';
  var stem = dot > 0 ? name.slice(0, dot) : name;
  if (ext.length >= maxLen - 2) return name.slice(0, maxLen - 1) + '…';
  var keep = Math.max(3, maxLen - ext.length - 1);
  return stem.slice(0, keep) + '…' + ext;
}

// Lightweight HTML escape — pm_stock has a global `esc` elsewhere but we
// don't want to hard-depend on it.
function _pmGrnEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Load the invoice files for an existing GRN into the modal.
async function loadPmGrnFiles(grnId){
  _pmGrnInvoiceFiles = [];
  pmGrnRenderInvoiceFiles();
  if(!grnId) return;
  try {
    const res = await fetch('/api/pm_stock/grn/file/list?grn_id=' + encodeURIComponent(grnId));
    const data = await res.json();
    if(data.status === 'ok'){
      _pmGrnInvoiceFiles = data.files || [];
      pmGrnRenderInvoiceFiles();
    }
  } catch(e){
    if(typeof showToast === 'function') showToast('Could not load invoice files: '+e.message, 'error');
  }
}

// Render the chips list inside the Edit GRN modal.
function pmGrnRenderInvoiceFiles(){
  var listEl = document.getElementById('egrn-invoices-list');
  if(!listEl) return;
  if(!_pmGrnInvoiceFiles.length){
    listEl.innerHTML = '<span style="color:var(--muted,#9ca3af);font-size:11px;font-style:italic">No invoice files attached yet.</span>';
    return;
  }
  listEl.innerHTML = _pmGrnInvoiceFiles.map(function(f){
    var sizeKb = Math.round((f.size_bytes || 0) / 1024);
    var iconClass = (f.mime_type || '').indexOf('pdf') !== -1 ? 'fa-file-pdf' : 'fa-file-image';
    return '<a class="pm-grn-invoice-chip" target="_blank" '
         + 'href="/api/pm_stock/grn/file/' + f.id + '" '
         + 'title="' + _pmGrnEsc(f.original_name) + ' (' + sizeKb + ' KB)" '
         + 'style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;'
         + 'border:1px solid rgba(13,148,136,.35);border-radius:14px;'
         + 'background:rgba(13,148,136,.08);color:var(--teal,#0d9488);'
         + 'font-size:11.5px;font-weight:600;text-decoration:none;'
         + 'transition:background .12s">'
         + '<i class="fas ' + iconClass + '"></i> '
         + _pmGrnEsc(_pmGrnTrimName(f.original_name, 28))
         + ' <span style="font-family:var(--font-mono,monospace);font-size:10px;'
         + 'font-weight:600;color:var(--muted,#6b7280);margin-left:2px">' + sizeKb + ' KB</span>'
         + '<button onclick="event.preventDefault();event.stopPropagation();pmGrnDeleteInvoiceFile(' + f.id + ');return false;" '
         + 'title="Remove" '
         + 'style="width:16px;height:16px;display:inline-flex;align-items:center;'
         + 'justify-content:center;margin-left:4px;padding:0;border:none;border-radius:50%;'
         + 'background:rgba(220,38,38,.12);color:#dc2626;font-size:11px;font-weight:700;'
         + 'cursor:pointer;line-height:1">×</button>'
         + '</a>';
  }).join('');
}

// Open a file picker and upload the chosen files to the current GRN.
function pmGrnPickInvoiceFile(){
  var grnIdInput = document.getElementById('egrn-id');
  var grnId = grnIdInput ? grnIdInput.value : '';
  if(!grnId){
    if(typeof showToast === 'function') showToast('No GRN open — save the GRN first', 'error');
    return;
  }
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = _PMGRN_FILE_ACCEPT;
  input.multiple = true;
  input.style.display = 'none';
  input.onchange = function(){
    var files = Array.prototype.slice.call(input.files || []);
    if(!files.length){ document.body.removeChild(input); return; }
    // Validate first, then upload in sequence.
    var validFiles = [];
    files.forEach(function(f){
      var mime = (f.type || '').toLowerCase();
      var okMime = ['application/pdf','image/jpeg','image/jpg','image/png'].indexOf(mime) !== -1;
      if(!okMime){
        if(typeof showToast === 'function') showToast('Skipped "' + f.name + '" — unsupported type', 'error');
        return;
      }
      if(f.size > _PMGRN_FILE_MAX_BYTES){
        if(typeof showToast === 'function') showToast('Skipped "' + f.name + '" — too large (max 10 MB)', 'error');
        return;
      }
      validFiles.push(f);
    });
    if(!validFiles.length){ document.body.removeChild(input); return; }
    var pending = validFiles.length;
    var success = 0;
    validFiles.forEach(function(f){
      var fd = new FormData();
      fd.append('file', f);
      fd.append('grn_id', grnId);
      fetch('/api/pm_stock/grn/file/upload', { method:'POST', body: fd })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(d.status === 'ok'){
            _pmGrnInvoiceFiles.push(d.file);
            success++;
          } else {
            if(typeof showToast === 'function') showToast('Upload failed for "' + f.name + '": ' + (d.message || 'error'), 'error');
          }
        })
        .catch(function(e){
          if(typeof showToast === 'function') showToast('Upload error: ' + e.message, 'error');
        })
        .finally(function(){
          pending--;
          if(pending === 0){
            pmGrnRenderInvoiceFiles();
            if(success > 0 && typeof showToast === 'function'){
              showToast('✓ ' + success + ' invoice file' + (success>1?'s':'') + ' attached', 'success');
            }
          }
        });
    });
    document.body.removeChild(input);
  };
  document.body.appendChild(input);
  input.click();
}

// Delete one file (DB row + disk file).
function pmGrnDeleteInvoiceFile(fileId){
  if(!confirm('Remove this invoice file?')) return;
  fetch('/api/pm_stock/grn/file/' + fileId, { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.status === 'ok'){
        _pmGrnInvoiceFiles = _pmGrnInvoiceFiles.filter(function(f){ return f.id !== fileId; });
        pmGrnRenderInvoiceFiles();
        if(typeof showToast === 'function') showToast('Invoice file removed', 'success');
      } else {
        if(typeof showToast === 'function') showToast('Delete failed: ' + (d.message || 'error'), 'error');
      }
    })
    .catch(function(e){
      if(typeof showToast === 'function') showToast('Delete error: ' + e.message, 'error');
    });
}


// ═══ Invoice files — new-GRN staging path ═══════════════════════════════
// The edit-GRN modal uploads files immediately because the GRN row already
// exists. The NEW-GRN modal has no grn_id yet, so we stage files in memory
// and upload them AFTER /api/pm_stock/grn/save returns with the freshly
// minted grn_id. Same MIME / size validation as the live-upload path.
//
// Public surface used elsewhere:
//   - pmGrnStageInvoiceFile()       — file picker → push valid files to staging
//   - pmGrnUnstageFile(idx)         — × chip click → remove staged file
//   - pmGrnResetStagedFiles()       — called by pmvOpen on modal open
//   - pmGrnUploadStagedFilesFor(id) — called by saveGrn after success

// Module-level array — files held in memory between pick and save. Lives
// on window so saveGrn (different file) can see / consume it.
window._pmGrnStagedInvoiceFiles = window._pmGrnStagedInvoiceFiles || [];

function pmGrnStageInvoiceFile(){
  // Mirror the edit-modal validator so users see identical errors regardless
  // of which entry point they used. Files don't leave the browser at this
  // step — they're held in window._pmGrnStagedInvoiceFiles until save.
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = _PMGRN_FILE_ACCEPT;
  input.multiple = true;
  input.style.display = 'none';
  input.onchange = function(){
    var files = Array.prototype.slice.call(input.files || []);
    if(!files.length){ document.body.removeChild(input); return; }
    var added = 0;
    files.forEach(function(f){
      var mime = (f.type || '').toLowerCase();
      var okMime = ['application/pdf','image/jpeg','image/jpg','image/png'].indexOf(mime) !== -1;
      if(!okMime){
        if(typeof showToast === 'function') showToast('Skipped "' + f.name + '" — unsupported type', 'error');
        return;
      }
      if(f.size > _PMGRN_FILE_MAX_BYTES){
        if(typeof showToast === 'function') showToast('Skipped "' + f.name + '" — too large (max 10 MB)', 'error');
        return;
      }
      window._pmGrnStagedInvoiceFiles.push(f);
      added++;
    });
    document.body.removeChild(input);
    pmGrnRenderStagedFiles();
    if(added > 0 && typeof showToast === 'function'){
      showToast('✓ ' + added + ' file' + (added>1?'s':'') + ' staged. Will upload after Save.', 'success');
    }
  };
  document.body.appendChild(input);
  input.click();
}

function pmGrnRenderStagedFiles(){
  var listEl = document.getElementById('grn-invoices-staged-list');
  if(!listEl) return;
  var files = window._pmGrnStagedInvoiceFiles || [];
  if(!files.length){
    listEl.innerHTML = '<span style="color:var(--muted,#9ca3af);font-size:11px;font-style:italic">No invoice files added yet.</span>';
    return;
  }
  // Chips with × per file. Index-based remove because File objects have no stable id.
  listEl.innerHTML = files.map(function(f, i){
    var sizeKb = (f.size / 1024).toFixed(0) + ' KB';
    var icon   = (f.type || '').indexOf('pdf') !== -1 ? 'fa-file-pdf' : 'fa-file-image';
    var safeName = String(f.name || 'file').replace(/[<>&"']/g, function(c){
      return ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c];
    });
    return ''
      + '<div style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;'
      + 'background:var(--hinput,#fff);border:1px solid var(--hbdr,rgba(0,0,0,.12));'
      + 'border-radius:14px;font-size:11px">'
      +   '<i class="fas ' + icon + '" style="color:var(--teal,#0d9488)"></i>'
      +   '<span style="font-weight:600">' + safeName + '</span>'
      +   '<span style="color:var(--muted,#9ca3af);font-size:9.5px">' + sizeKb + '</span>'
      +   '<span onclick="pmGrnUnstageFile(' + i + ')" '
      +         'style="cursor:pointer;color:#ef4444;font-weight:800;padding:0 4px" '
      +         'title="Remove">×</span>'
      + '</div>';
  }).join('');
}

function pmGrnUnstageFile(idx){
  var arr = window._pmGrnStagedInvoiceFiles || [];
  if(idx < 0 || idx >= arr.length) return;
  arr.splice(idx, 1);
  pmGrnRenderStagedFiles();
}

function pmGrnResetStagedFiles(){
  window._pmGrnStagedInvoiceFiles = [];
  pmGrnRenderStagedFiles();
}

// Upload all staged files for a freshly-created GRN. Sequential, not
// parallel — keeps toast feedback intelligible and avoids stampeding the
// disk for large image batches. Best-effort: failures toast but don't
// block — the GRN is saved either way; user can re-upload from the edit
// modal if anything failed.
async function pmGrnUploadStagedFilesFor(grnId){
  var files = (window._pmGrnStagedInvoiceFiles || []).slice();
  if(!files.length || !grnId) return { uploaded: 0, failed: 0 };
  var uploaded = 0, failed = 0;
  for(var i = 0; i < files.length; i++){
    var f = files[i];
    try {
      var fd = new FormData();
      fd.append('file', f);
      fd.append('grn_id', grnId);
      var r = await fetch('/api/pm_stock/grn/file/upload', { method:'POST', body: fd });
      var d = await r.json();
      if(d && d.status === 'ok') uploaded++;
      else {
        failed++;
        if(typeof showToast === 'function') showToast('Upload failed for "' + f.name + '": ' + ((d && d.message) || 'error'), 'error', 5000);
      }
    } catch(e){
      failed++;
      if(typeof showToast === 'function') showToast('Upload error for "' + f.name + '": ' + e.message, 'error', 5000);
    }
  }
  // Clear staged list on a clean run; on partial failure we still clear
  // so the user doesn't get a duplicate-upload prompt — they can re-add
  // failed files from the edit modal.
  pmGrnResetStagedFiles();
  return { uploaded: uploaded, failed: failed };
}

/* ═══════════════════════════════════════════════════════════════════════
   AUTO-VERIFY (admin-gated Excel upload shortcut)
   ─────────────────────────────────────────────────────────────────────
   Visible to every user on the Verify GRN modal as the "🔐 Auto-Verify"
   button. Clicking it asks for an admin password. On success, opens a
   file picker that accepts .xlsx / .xls / .csv. Reads column A as box
   codes (long box_code OR short_code — both resolved against the modal's
   expected set the same way scanner input is). Shows a preview of
   matched / unmatched / missing, then the admin confirms.

   On confirm: populates _grnVerify.scannedSet exactly as if the operator
   had scanned every code listed in the file. The operator (or admin)
   then clicks the existing "Confirm & Post Stock" — which runs the
   server's normal verify endpoint with its full safety checks
   (set-match + qty-match). No backend safety is bypassed; this purely
   automates keystrokes.
   ─────────────────────────────────────────────────────────────────── */

// Open the admin password dialog. After successful password, advances to
// the file-picker stage. Pure UI orchestration — no data mutation here.
function gvOpenAutoVerify(){
  // Guard: the verify modal must be open and loaded. _grnVerify is a
  // module-scope `let` in this file, so reference it directly rather than
  // via window (which is undefined for `let` declarations).
  if(!_grnVerify || !_grnVerify.expectedSet || !_grnVerify.expectedSet.size){
    if(typeof showToast === 'function') showToast('Verify modal not loaded yet','error');
    return;
  }
  if(_grnVerify.status === 'verified'){
    if(typeof showToast === 'function') showToast('GRN already verified','info');
    return;
  }
  // Build the dialog once, reuse across opens.
  let modal = document.getElementById('gvAutoVerifyModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'gvAutoVerifyModal';
    modal.className = 'modal-overlay';
    // z-index higher than the verify modal (910) so it sits on top.
    modal.style.zIndex = '950';
    modal.innerHTML = `
      <div class="modal" style="max-width:560px;width:92%">
        <div class="modal-header" style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff">
          <div>
            <div style="font-size:15px;font-weight:800">🔐 Admin Auto-Verify</div>
            <div style="font-size:11px;opacity:.9;margin-top:2px" id="gvav-subtitle">
              Enter admin password to unlock bulk verification by Excel upload.
            </div>
          </div>
          <button class="modal-close" onclick="gvCloseAutoVerify()" style="color:#fff">×</button>
        </div>
        <div class="modal-body" id="gvav-body" style="padding:18px 20px">
          <!-- Stage 1: password -->
          <div id="gvav-stage-pwd">
            <label style="font-size:11px;font-weight:700;color:var(--hmuted,#9ca3af);letter-spacing:.3px;text-transform:uppercase">
              Admin password
            </label>
            <input id="gvav-pwd-input" type="password" autocomplete="off"
                   placeholder="Type the admin password and press Enter"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();gvAutoVerifySubmitPwd();}"
                   style="margin-top:6px;width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text,#111);outline:none">
            <div id="gvav-pwd-msg" style="margin-top:8px;font-size:11px;color:#dc2626;min-height:14px"></div>
            <div style="margin-top:14px;font-size:11px;color:var(--hmuted,#9ca3af);line-height:1.5">
              The password is checked against the User_Tbl. Anyone (operator or admin) can use this button —
              an admin must be physically present to type their password. The password is sent over the same
              session and is never stored in the browser.
            </div>
          </div>
          <!-- Stage 2: file picker (hidden until password OK) -->
          <div id="gvav-stage-file" style="display:none">
            <div style="font-size:12px;color:var(--htxtb,#111);margin-bottom:10px">
              <span style="color:#16a34a;font-weight:700">✓ Admin verified</span> ·
              upload an Excel / CSV file with box codes in <b>column A</b>.
            </div>
            <input id="gvav-file-input" type="file" accept=".xlsx,.xls,.csv"
                   onchange="gvAutoVerifyReadFile(event)"
                   style="width:100%;font-size:12px;padding:8px;border:1.5px dashed var(--border2,rgba(0,0,0,.18));border-radius:8px;background:var(--hinput,#fff);color:var(--text,#111)">
            <div style="margin-top:10px;font-size:11px;color:var(--hmuted,#9ca3af);line-height:1.5">
              Each row in column A should be one box code — long format
              (BEARTUBE08-G0332-B001) or short format (A0038938). Header row is
              auto-skipped. Blank rows are ignored.
            </div>
            <div id="gvav-file-msg" style="margin-top:8px;font-size:11px;color:#dc2626;min-height:14px"></div>
          </div>
          <!-- Stage 3: preview (hidden until file parsed) -->
          <div id="gvav-stage-preview" style="display:none">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
              <div style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:8px;padding:10px;text-align:center">
                <div style="font-size:10px;color:#16a34a;font-weight:700;letter-spacing:.3px;text-transform:uppercase">Matched</div>
                <div id="gvav-prev-matched" style="font-size:22px;font-weight:800;color:#16a34a;margin-top:2px">0</div>
              </div>
              <div style="background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.25);border-radius:8px;padding:10px;text-align:center">
                <div style="font-size:10px;color:#d97706;font-weight:700;letter-spacing:.3px;text-transform:uppercase">Missing</div>
                <div id="gvav-prev-missing" style="font-size:22px;font-weight:800;color:#d97706;margin-top:2px">0</div>
              </div>
              <div style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);border-radius:8px;padding:10px;text-align:center">
                <div style="font-size:10px;color:#dc2626;font-weight:700;letter-spacing:.3px;text-transform:uppercase">Extra</div>
                <div id="gvav-prev-extra" style="font-size:22px;font-weight:800;color:#dc2626;margin-top:2px">0</div>
              </div>
            </div>
            <div id="gvav-prev-hint" style="font-size:12px;color:var(--htxtb,#111);background:var(--hinput,#f9fafb);border-radius:8px;padding:10px 12px;margin-bottom:12px">
              Review the counts above. If everything looks right, click Apply to load these codes as scanned.
              You'll then click <b>Confirm &amp; Post Stock</b> in the Verify modal as normal.
            </div>
            <div id="gvav-prev-issues" style="font-size:11px;color:var(--hmuted,#9ca3af);max-height:140px;overflow:auto"></div>
          </div>
        </div>
        <div class="modal-footer" style="padding:12px 20px;border-top:1px solid var(--hbdr,rgba(0,0,0,.07));display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-outline btn-sm" onclick="gvCloseAutoVerify()">Cancel</button>
          <button id="gvav-action-btn" class="btn btn-sm" onclick="gvAutoVerifySubmitPwd()"
                  style="background:#7c3aed;color:#fff;font-weight:700">Unlock</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  // Reset to stage 1 on every open
  document.getElementById('gvav-stage-pwd').style.display = '';
  document.getElementById('gvav-stage-file').style.display = 'none';
  document.getElementById('gvav-stage-preview').style.display = 'none';
  document.getElementById('gvav-pwd-input').value = '';
  document.getElementById('gvav-pwd-msg').textContent = '';
  document.getElementById('gvav-file-msg').textContent = '';
  const actBtn = document.getElementById('gvav-action-btn');
  actBtn.textContent = 'Unlock';
  actBtn.onclick = gvAutoVerifySubmitPwd;
  modal.classList.add('open');
  setTimeout(() => document.getElementById('gvav-pwd-input')?.focus(), 100);
}

function gvCloseAutoVerify(){
  const m = document.getElementById('gvAutoVerifyModal');
  if(m) m.classList.remove('open');
  // Clear sensitive bits on close.
  const p = document.getElementById('gvav-pwd-input'); if(p) p.value = '';
  window._gvavParsedCodes = null;
}

// Stage 1 → 2: submit the password to /admin_passcheck.
async function gvAutoVerifySubmitPwd(){
  const pwd = (document.getElementById('gvav-pwd-input')?.value || '').trim();
  const msg = document.getElementById('gvav-pwd-msg');
  msg.textContent = '';
  if(!pwd){
    msg.textContent = 'Password required.';
    return;
  }
  const btn = document.getElementById('gvav-action-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Checking…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/pm_stock/admin_passcheck', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json().catch(() => ({status:'error',message:'Network error'}));
    if(res.status === 401 && data.message && /not logged in/i.test(data.message)){
      msg.textContent = 'Your session has expired. Reload the page and log in again.';
      return;
    }
    if(!res.ok || data.status !== 'ok'){
      msg.textContent = data.message || `Failed (HTTP ${res.status}).`;
      return;
    }
    // Success → clear password from input, advance to file stage.
    document.getElementById('gvav-pwd-input').value = '';
    document.getElementById('gvav-stage-pwd').style.display = 'none';
    document.getElementById('gvav-stage-file').style.display = '';
    document.getElementById('gvav-subtitle').textContent =
      `Unlocked by ${data.admin_username || 'admin'} · upload the Excel file.`;
    btn.style.display = 'none';   // file-stage uses the onchange of the input
  } catch(e){
    msg.textContent = 'Network error: ' + (e?.message || e);
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

// Stage 2 → 3: read column A from the uploaded file.
async function gvAutoVerifyReadFile(event){
  const file = event.target.files && event.target.files[0];
  if(!file) return;
  const msg = document.getElementById('gvav-file-msg');
  msg.textContent = '';
  try {
    const name = (file.name || '').toLowerCase();
    let codes = [];
    if(name.endsWith('.csv')){
      const text = await file.text();
      codes = text.split(/\r?\n/).map(line => {
        // Take everything before the first comma as column A. Handle a
        // simple double-quoted value if present.
        let cell = line.split(',')[0] || '';
        cell = cell.trim();
        if(cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1);
        return cell;
      }).filter(c => c.length);
    } else {
      // .xlsx / .xls via SheetJS (already loaded globally by the app).
      if(typeof XLSX === 'undefined'){
        msg.textContent = 'XLSX library not loaded — try refreshing the page.';
        return;
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type:'array' });
      const sheetName = wb.SheetNames[0];
      if(!sheetName){ msg.textContent = 'Empty workbook.'; return; }
      const ws = wb.Sheets[sheetName];
      // Read as array-of-arrays so we always get raw column-A regardless of
      // header names. defval:'' keeps blank cells from collapsing rows.
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
      codes = rows.map(r => String((r && r[0]) || '').trim()).filter(c => c.length);
    }
    // Drop a header row if column A's first non-empty cell isn't code-shaped.
    // Box codes either start with A0 (short_code) or contain '-G' (long box_code).
    // If the first cell doesn't look code-shaped AND there are >1 rows, drop it.
    if(codes.length > 1){
      const first = codes[0].toUpperCase();
      const looksLikeCode = /^[A-Z]\d{5,}$/.test(first) || /-G\d{4}-/.test(first) || first.startsWith('BAG-');
      if(!looksLikeCode) codes = codes.slice(1);
    }
    // Normalise: uppercase, trim, dedupe in input-order.
    const seen = new Set();
    const cleaned = [];
    for(const c of codes){
      const u = c.toUpperCase().trim();
      if(!u) continue;
      if(seen.has(u)) continue;
      seen.add(u);
      cleaned.push(u);
    }
    if(!cleaned.length){
      msg.textContent = 'No box codes found in column A.';
      return;
    }
    // Resolve short codes to long codes against the expected set (mirrors
    // the scanner-input logic in gvAddCode).
    const expectedSet = _grnVerify.expectedSet || new Set();
    const shortToLong = _grnVerify.shortToLong || new Map();
    const resolved = cleaned.map(u => shortToLong.get(u) || u);
    const matched = resolved.filter(u => expectedSet.has(u));
    const extra   = resolved.filter(u => !expectedSet.has(u));
    const matchedSet = new Set(matched);
    const missing = Array.from(expectedSet).filter(u => !matchedSet.has(u));

    // Stash for the Apply step
    window._gvavParsedCodes = { matched, extra, missing, allResolved: resolved };

    // Show preview stage
    document.getElementById('gvav-stage-file').style.display = 'none';
    document.getElementById('gvav-stage-preview').style.display = '';
    document.getElementById('gvav-prev-matched').textContent = matched.length;
    document.getElementById('gvav-prev-missing').textContent = missing.length;
    document.getElementById('gvav-prev-extra').textContent   = extra.length;

    const issues = document.getElementById('gvav-prev-issues');
    let issuesHtml = '';
    if(extra.length){
      issuesHtml += `<div style="margin-top:4px"><b style="color:#dc2626">⚠ Extra (not in expected list):</b><br>`
                  + extra.slice(0, 30).map(c => `<code style="display:inline-block;padding:1px 5px;margin:2px;background:rgba(220,38,38,.08);border-radius:3px;font-size:10px">${c}</code>`).join('')
                  + (extra.length > 30 ? `<br><span style="color:#9ca3af">…and ${extra.length-30} more</span>` : '')
                  + `</div>`;
    }
    if(missing.length){
      issuesHtml += `<div style="margin-top:8px"><b style="color:#d97706">○ Missing (in GRN but not in file):</b><br>`
                  + missing.slice(0, 30).map(c => `<code style="display:inline-block;padding:1px 5px;margin:2px;background:rgba(217,119,6,.08);border-radius:3px;font-size:10px">${c}</code>`).join('')
                  + (missing.length > 30 ? `<br><span style="color:#9ca3af">…and ${missing.length-30} more</span>` : '')
                  + `</div>`;
    }
    issues.innerHTML = issuesHtml;

    const hint = document.getElementById('gvav-prev-hint');
    if(matched.length === expectedSet.size && !extra.length && !missing.length){
      hint.style.background = 'rgba(22,163,74,.08)';
      hint.innerHTML = `<span style="color:#16a34a;font-weight:700">✓ Perfect match — ${matched.length} of ${expectedSet.size} boxes.</span> Click Apply to load and then Confirm in the Verify modal.`;
    } else if(extra.length || missing.length){
      hint.style.background = 'rgba(217,119,6,.08)';
      hint.innerHTML = `<b style="color:#d97706">⚠ The file does not match perfectly.</b> Applying will still proceed but the server will reject with a discrepancy report. Fix the file first if possible.`;
    }

    // Show Apply button
    const btn = document.getElementById('gvav-action-btn');
    btn.style.display = '';
    btn.textContent = `Apply (${matched.length} matched)`;
    btn.onclick = gvAutoVerifyApply;
  } catch(e){
    msg.textContent = 'Failed to read file: ' + (e?.message || e);
  }
}

// Stage 3 → load: populate _grnVerify.scannedSet from the parsed codes.
function gvAutoVerifyApply(){
  const parsed = window._gvavParsedCodes;
  if(!parsed){ return; }
  // Reset any prior manual scans on this open, then load the file's codes.
  // We load EVERY resolved code (matched + extra). The server endpoint will
  // run its own set-match check and produce a discrepancy report if the
  // file had unexpected codes — exactly the same as manual scans would.
  _grnVerify.scannedSet = new Set(parsed.allResolved);
  _grnVerify.scannedOrder = parsed.allResolved.slice();
  if(typeof gvRender === 'function') gvRender();
  gvCloseAutoVerify();
  if(typeof showToast === 'function'){
    showToast(`Auto-Verify loaded ${parsed.allResolved.length} code(s). Review and click Confirm.`, 'success', 4500);
  }
}

// Expose for inline onclick handlers
window.gvOpenAutoVerify       = gvOpenAutoVerify;
window.gvCloseAutoVerify      = gvCloseAutoVerify;
window.gvAutoVerifySubmitPwd  = gvAutoVerifySubmitPwd;
window.gvAutoVerifyReadFile   = gvAutoVerifyReadFile;
window.gvAutoVerifyApply      = gvAutoVerifyApply;
