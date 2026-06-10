/* ════════════════════════════════════════════════════════════════════════
   pm_stock_inline_sbr.js
   Extracted from pm_stock.html inline <script> blocks for maintainability.
   Each section below was previously a standalone inline block; concatenated
   here in original order so initialization sequencing is preserved.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Was inline block 8: Scan-box-receipt flow for GRN/OP ── */
(function(){
  // State for the active session
  // _sbrCtx = {
  //   kind: 'grn'|'op',
  //   // GRN:
  //   grn_id, grn_no, godown_id, supplier_text, invoice_no, invoice_date,
  //   grn_date, supervisor,
  //   // OP:
  //   op_seq, op_label, op_date,
  //   // Common:
  //   product_id, product_code, product_name, pm_type, brand_name,
  //   orig_total, orig_no_of_box, orig_per_box_qty,
  //   max_box_seq, max_total_boxes,
  //   rows: [{ key, box_id, box_seq, box_code, per_box_qty, status,
  //            checked, is_new, is_kept_original }]
  // };
  window._sbrCtx = null;

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function _fmt(n){ return (Number(n)||0).toLocaleString('en-IN', {maximumFractionDigits:3}); }

  // Entry point: open for a saved GRN line item.
  // Admins go straight to apply-on-save. Non-admins use the same UI
  // but the save button submits a request that needs admin approval
  // before the print can fire.
  window.openSelectiveReprintForGrn = async function(grnId, productId){
    const isAdmin = (typeof isAdminUser === 'function') ? isAdminUser() : false;
    const modal = document.getElementById('selBoxReprintModal');
    if(!modal) return;
    modal.classList.add('open');
    const tbody = document.getElementById('sbr-tbody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="6" class="no-data"><i class="fas fa-spinner fa-spin"></i> Loading boxes…</td></tr>`;

    try {
      // Fetch boxes for this GRN+product. Use a generous limit so all boxes come back.
      const url = `/api/pm_stock/boxes/list?grn_id=${encodeURIComponent(grnId)}&product_id=${encodeURIComponent(productId)}&limit=1000`;
      const res = await fetch(url);
      // Robust parse — see sbrCommitAndPrint for the rationale.
      const txt = await res.text();
      let d = null;
      try { d = txt ? JSON.parse(txt) : null; } catch(_){ d = null; }
      if(!d){
        const hint = (res.status === 404)
          ? 'Endpoint not found — has the server been restarted?'
          : (res.status === 401 || res.status === 403)
            ? 'Not authorised.'
            : (res.status >= 500) ? 'Server error.' : `HTTP ${res.status}`;
        if(typeof showToast==='function') showToast(hint, 'error', 6000);
        modal.classList.remove('open'); return;
      }
      if(d.status !== 'ok' || !Array.isArray(d.boxes)){
        if(typeof showToast==='function') showToast(d.message || 'Failed to load boxes','error');
        modal.classList.remove('open'); return;
      }
      if(!d.boxes.length){
        if(typeof showToast==='function') showToast('This GRN line has no boxes — generate labels first','error');
        modal.classList.remove('open'); return;
      }

      // Pull header info from the Edit GRN modal (open) for label rendering
      const ctx = {
        kind:           'grn',
        mode:           isAdmin ? 'apply' : 'request',  // request = needs admin approval
        grn_id:         Number(grnId),
        product_id:     Number(productId),
        grn_no:         d.boxes[0].grn_no || '—',
        godown_id:      d.boxes[0].current_godown_id || 0,
        product_code:   d.boxes[0].product_code || '',
        product_name:   d.boxes[0].product_name || '',
        pm_type:        d.boxes[0].pm_type || '',
        // Brand: not in box list, look up from product cache
        brand_name:     '',
        // Supplier/invoice: read from open Edit GRN modal if present
        supplier_text:  (document.getElementById('egrn-supplier-text')?.value || '').trim() || '—',
        invoice_no:     (document.getElementById('egrn-party-invoice-no')?.value || '').trim() || '—',
        invoice_date:   document.getElementById('egrn-party-invoice-date')?.value || '',
        grn_date:       document.getElementById('egrn-date')?.value || '',
        supervisor:     (document.getElementById('egrn-supervisor')?.value || '').trim() || '—',
      };
      // Brand from product cache
      const prodList = (window._products || []);
      const prod     = prodList.find(p => Number(p.id) === Number(productId));
      if(prod) ctx.brand_name = prod.brand_name || '';

      _sbrInitFromBoxes(ctx, d.boxes);
    } catch(e){
      if(typeof showToast==='function') showToast('Network error: ' + (e.message||e),'error');
      modal.classList.remove('open');
    }
  };

  // Entry point: open for an OP-batch row.
  // Admins go straight to apply-on-save. Non-admins use the same UI
  // but the save button submits a request that needs admin approval
  // before the print can fire.
  window.openSelectiveReprintForOp = async function(opSeq, productId, godownId){
    const isAdmin = (typeof isAdminUser === 'function') ? isAdminUser() : false;
    const modal = document.getElementById('selBoxReprintModal');
    if(!modal) return;
    modal.classList.add('open');
    const tbody = document.getElementById('sbr-tbody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="6" class="no-data"><i class="fas fa-spinner fa-spin"></i> Loading boxes…</td></tr>`;

    try {
      const opLabel = `PM-OP/${String(opSeq).padStart(4,'0')}`;
      const url = `/api/pm_stock/boxes/list?grn_no=${encodeURIComponent(opLabel)}&product_id=${encodeURIComponent(productId)}&godown_id=${encodeURIComponent(godownId)}&limit=1000`;
      const res = await fetch(url);
      // Robust parse — see sbrCommitAndPrint for the rationale.
      const txt = await res.text();
      let d = null;
      try { d = txt ? JSON.parse(txt) : null; } catch(_){ d = null; }
      if(!d){
        const hint = (res.status === 404)
          ? 'Endpoint not found — has the server been restarted?'
          : (res.status === 401 || res.status === 403)
            ? 'Not authorised.'
            : (res.status >= 500) ? 'Server error.' : `HTTP ${res.status}`;
        if(typeof showToast==='function') showToast(hint, 'error', 6000);
        modal.classList.remove('open'); return;
      }
      if(d.status !== 'ok' || !Array.isArray(d.boxes) || !d.boxes.length){
        if(typeof showToast==='function') showToast(d.message || 'No boxes found for this OP batch','error');
        modal.classList.remove('open'); return;
      }
      const ctx = {
        kind:         'op',
        mode:         isAdmin ? 'apply' : 'request',
        op_seq:       Number(opSeq),
        op_label:     opLabel,
        product_id:   Number(productId),
        godown_id:    Number(godownId),
        product_code: d.boxes[0].product_code || '',
        product_name: d.boxes[0].product_name || '',
        pm_type:      d.boxes[0].pm_type || '',
        brand_name:   '',
        op_date:      (d.boxes[0].created_at || '').slice(0,10),
      };
      const prodList = (window._products || []);
      const prod     = prodList.find(p => Number(p.id) === Number(productId));
      if(prod) ctx.brand_name = prod.brand_name || '';
      _sbrInitFromBoxes(ctx, d.boxes);
    } catch(e){
      if(typeof showToast==='function') showToast('Network error: ' + (e.message||e),'error');
      modal.classList.remove('open');
    }
  };

  function _sbrInitFromBoxes(ctx, boxes){
    // Compute originals
    const origTotal = boxes.reduce((s,b)=>s+(Number(b.per_box_qty)||0), 0);
    const maxSeq    = boxes.reduce((m,b)=>Math.max(m, Number(b.box_seq)||0), 0);
    const maxTotal  = boxes.reduce((m,b)=>Math.max(m, Number(b.total_boxes)||0), 0);

    ctx.orig_total       = origTotal;
    ctx.orig_no_of_box   = boxes.length;
    ctx.orig_per_box_qty = boxes.length ? (origTotal / boxes.length) : 0;
    ctx.max_box_seq      = maxSeq;
    ctx.max_total_boxes  = Math.max(maxTotal, boxes.length);

    // Build editable rows from the existing boxes
    ctx.rows = boxes.map(b => ({
      key:        'k_' + (b.box_id || b.box_seq || Math.random()),
      box_id:     b.box_id,
      box_seq:    b.box_seq,
      box_code:   b.box_code,
      per_box_qty: Number(b.per_box_qty) || 0,
      status:     b.current_status || 'in_stock',
      checked:    true,                 // by default, select all existing boxes
      is_new:     false,
      is_kept_original: true,           // means "this box exists today"
    }));

    window._sbrCtx = ctx;
    _sbrRenderHeader();
    _sbrRenderRows();
    _sbrRecompute();
  }

  function _sbrRenderHeader(){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    const subtitle = document.getElementById('sbr-subtitle');
    const ctxBox   = document.getElementById('sbr-context');
    const isGrn    = ctx.kind === 'grn';
    const isReq    = (ctx.mode === 'request');
    // Toggle the Reason row (only visible in request mode)
    const reasonRow = document.getElementById('sbr-reason-row');
    if(reasonRow) reasonRow.style.display = isReq ? '' : 'none';
    // Re-label the action button so users know exactly what happens
    const printBtn = document.getElementById('sbr-print-btn');
    if(printBtn){
      printBtn.innerHTML = isReq
        ? '<i class="fas fa-paper-plane"></i> Submit Selective Request'
        : '<i class="fas fa-print"></i> Save &amp; Print Selected';
    }
    if(subtitle){
      const baseTxt = isGrn
        ? `Adjusting box labels for one GRN line item. Total qty must match the original.`
        : `Adjusting box labels for an Opening Stock batch. Total qty must match the original.`;
      subtitle.textContent = isReq
        ? baseTxt + ' Submitting for admin approval — print will be available after approval.'
        : baseTxt;
    }
    if(ctxBox){
      const refLabel = isGrn ? `GRN ${_esc(ctx.grn_no)}` : `OP ${_esc(ctx.op_label)}`;
      ctxBox.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center">
          <div>
            <span style="color:var(--hmuted2,#6b7280);font-size:10px;text-transform:uppercase;letter-spacing:.4px">Voucher</span><br>
            <strong style="font-family:var(--font-mono,monospace);color:var(--teal,#0d9488)">${refLabel}</strong>
          </div>
          <div>
            <span style="color:var(--hmuted2,#6b7280);font-size:10px;text-transform:uppercase;letter-spacing:.4px">Product</span><br>
            <strong>${ctx.pm_type ? `[${_esc(ctx.pm_type)}] ` : ''}${_esc(ctx.product_name||'—')}</strong>
            ${ctx.product_code ? `<span style="font-family:monospace;font-size:10px;background:rgba(13,148,136,.1);color:var(--teal,#0d9488);padding:1px 6px;border-radius:3px;margin-left:6px">${_esc(ctx.product_code)}</span>` : ''}
          </div>
          <div>
            <span style="color:var(--hmuted2,#6b7280);font-size:10px;text-transform:uppercase;letter-spacing:.4px">Original</span><br>
            <strong>${ctx.orig_no_of_box} box × ${_fmt(ctx.orig_per_box_qty)} = ${_fmt(ctx.orig_total)}</strong>
          </div>
        </div>`;
    }
  }

  function _sbrRenderRows(){
    const ctx = window._sbrCtx;
    const tbody = document.getElementById('sbr-tbody');
    if(!ctx || !tbody) return;
    if(!ctx.rows.length){
      tbody.innerHTML = `<tr><td colspan="6" class="no-data">No boxes — click "Add New Box" to create.</td></tr>`;
      return;
    }
    // Sort by box_seq for stable display
    const sorted = [...ctx.rows].sort((a,b)=>(Number(a.box_seq)||0)-(Number(b.box_seq)||0));
    tbody.innerHTML = sorted.map(r => {
      const stColor = r.status === 'out' ? '#dc2626' : (r.status === 'in_stock' ? '#16a34a' : '#6b7280');
      const stLbl   = r.status === 'out' ? 'OUT' : (r.status === 'in_stock' ? 'In Stock' : (r.status || '—'));
      const newBadge = r.is_new
        ? `<span style="margin-left:6px;font-size:9px;font-weight:800;padding:1px 6px;border-radius:3px;background:rgba(13,148,136,.12);color:var(--teal,#0d9488);border:1px solid rgba(13,148,136,.25);letter-spacing:.4px">NEW</span>`
        : '';
      const codeStr = r.box_code || `(auto-generate)`;
      const dis     = (r.status === 'out' && !r.is_new) ? 'disabled title="This box is OUT — cannot reprint"' : '';
      return `<tr data-row-key="${r.key}" style="${r.checked?'':'opacity:.55'}">
        <td><input type="checkbox" class="sbr-cb" data-key="${r.key}" ${r.checked?'checked':''} ${dis}
            onchange="sbrToggleRow('${r.key}', this.checked)" style="width:14px;height:14px;cursor:pointer;accent-color:#7c3aed"></td>
        <td style="font-family:monospace;color:var(--htxtb,#111);font-weight:700">${r.box_seq}</td>
        <td style="font-family:monospace;font-size:11px">${_esc(codeStr)}${newBadge}</td>
        <td class="num">
          <input type="number" min="0.001" step="0.001" value="${r.per_box_qty || ''}"
            data-key="${r.key}" onchange="sbrEditQty('${r.key}', this.value)"
            style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:5px;padding:5px 8px;font-size:12px;font-family:monospace;color:var(--htxtb,#111);outline:none;text-align:right">
        </td>
        <td><span style="display:inline-block;padding:1px 7px;border-radius:3px;font-size:9.5px;font-weight:700;background:${stColor}1a;color:${stColor};border:1px solid ${stColor}44">${stLbl}</span></td>
        <td style="text-align:center">
          ${r.is_new
            ? `<button onclick="sbrRemoveRow('${r.key}')" title="Remove this new row" style="background:transparent;border:none;cursor:pointer;color:#dc2626;font-size:14px"><i class="fas fa-times-circle"></i></button>`
            : `<span style="color:var(--hmuted,#9ca3af);font-size:10px" title="Existing box — uncheck to skip">—</span>`}
        </td>
      </tr>`;
    }).join('');
  }

  // Compute totals & toggle the print button + match badge
  function _sbrRecompute(){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    const sel = ctx.rows.filter(r => r.checked);
    const newTotal = sel.reduce((s,r)=>s + (Number(r.per_box_qty)||0), 0);
    const orig = Number(ctx.orig_total)||0;
    document.getElementById('sbr-orig-total').textContent = _fmt(orig);
    document.getElementById('sbr-sel-count').textContent  = sel.length;
    document.getElementById('sbr-new-total').textContent  = _fmt(newTotal);

    // Allow tiny float tolerance for floating point sums
    const matches = Math.abs(newTotal - orig) < 0.001;
    const noneSelected = sel.length === 0;
    const badge = document.getElementById('sbr-match-badge');
    const btn   = document.getElementById('sbr-print-btn');
    if(badge){
      if(noneSelected){
        badge.textContent = 'Select at least one box';
        badge.style.background = 'rgba(107,114,128,.12)';
        badge.style.color      = '#6b7280';
        badge.style.border     = '1.5px solid rgba(107,114,128,.3)';
      } else if(matches){
        badge.textContent = '✓ Total matches';
        badge.style.background = 'rgba(22,163,74,.12)';
        badge.style.color      = '#16a34a';
        badge.style.border     = '1.5px solid rgba(22,163,74,.3)';
      } else {
        const diff = newTotal - orig;
        badge.textContent = `${diff>0?'+':''}${_fmt(diff)} vs original`;
        badge.style.background = 'rgba(220,38,38,.10)';
        badge.style.color      = '#dc2626';
        badge.style.border     = '1.5px solid rgba(220,38,38,.3)';
      }
    }
    if(btn) btn.disabled = !(matches && !noneSelected);
  }

  // Bulk select / clear
  window.sbrSelectAll = function(checked){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    ctx.rows.forEach(r => {
      // Don't auto-check OUT boxes
      if(checked && r.status === 'out' && !r.is_new) return;
      r.checked = !!checked;
    });
    _sbrRenderRows();
    _sbrRecompute();
  };
  window.sbrToggleAll = function(masterCb){
    sbrSelectAll(!!masterCb.checked);
  };
  window.sbrToggleRow = function(key, checked){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    const r = ctx.rows.find(x => x.key === key);
    if(!r) return;
    r.checked = !!checked;
    // Re-render only the row's opacity hint (cheap to re-render all)
    _sbrRenderRows();
    _sbrRecompute();
  };
  window.sbrEditQty = function(key, val){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    const r = ctx.rows.find(x => x.key === key);
    if(!r) return;
    r.per_box_qty = Math.max(0, parseFloat(val) || 0);
    _sbrRecompute();
  };
  window.sbrAddNewBox = function(){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    // Auto-number: continue from max(box_seq)+1, then bump as we add more
    ctx.max_box_seq = (Number(ctx.max_box_seq)||0) + 1;
    const seq = ctx.max_box_seq;
    const defaultPbq = ctx.orig_per_box_qty || 0;
    ctx.rows.push({
      key:        'new_' + Date.now() + '_' + seq,
      box_id:     null,
      box_seq:    seq,
      box_code:   null,                 // server will assign on save
      per_box_qty: defaultPbq,
      status:     'in_stock',
      checked:    true,
      is_new:     true,
      is_kept_original: false,
    });
    _sbrRenderRows();
    _sbrRecompute();
  };
  window.sbrRemoveRow = function(key){
    const ctx = window._sbrCtx;
    if(!ctx) return;
    const idx = ctx.rows.findIndex(x => x.key === key);
    if(idx < 0) return;
    const r = ctx.rows[idx];
    if(!r.is_new) return; // safety: existing rows are removed by unchecking
    ctx.rows.splice(idx, 1);
    _sbrRenderRows();
    _sbrRecompute();
  };

  // Submit to backend, then fire the existing label print pipeline
  window.sbrCommitAndPrint = async function(){
    const ctx = window._sbrCtx;
    if(!ctx){ if(typeof showToast==='function') showToast('No context','error'); return; }
    const sel = ctx.rows.filter(r => r.checked);
    if(!sel.length){ if(typeof showToast==='function') showToast('Select at least one box','error'); return; }
    const newTotal = sel.reduce((s,r)=>s+(Number(r.per_box_qty)||0), 0);
    const orig = Number(ctx.orig_total)||0;
    if(Math.abs(newTotal - orig) >= 0.001){
      if(typeof showToast==='function') showToast(`Total ${_fmt(newTotal)} ≠ original ${_fmt(orig)} — adjust qty so the totals match`,'error', 5500);
      return;
    }
    // Validate every selected row has a positive qty
    const invalid = sel.find(r => !(Number(r.per_box_qty) > 0));
    if(invalid){
      if(typeof showToast==='function') showToast(`Box seq ${invalid.box_seq} has invalid qty — must be > 0`,'error');
      return;
    }

    const btn = document.getElementById('sbr-print-btn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + (ctx.mode==='request' ? 'Submitting…' : 'Saving…'); }

    // Build payload — server consumes "selections" + "removed_box_ids".
    // selections = the rows that will appear in the new label set, with
    //   {box_id|null, box_seq, per_box_qty, is_new}.
    // removed_box_ids = IDs of existing boxes that the user unchecked
    //   (those will be deleted server-side, on apply).
    const selections = sel.map(r => ({
      box_id:      r.box_id,
      box_seq:     r.box_seq,
      per_box_qty: Number(r.per_box_qty),
      is_new:      !!r.is_new,
    }));
    const removed = ctx.rows
      .filter(r => !r.checked && !r.is_new && r.box_id)
      .map(r => r.box_id);

    try {
      // ── Non-admin: SUBMIT a reprint request (admin must approve) ──
      if(ctx.mode === 'request'){
        const reasonEl  = document.getElementById('sbr-reason');
        const userReason = (reasonEl && reasonEl.value || '').trim();
        if(!userReason){
          if(typeof showToast==='function') showToast('Please provide a reason for the reprint request','error', 4500);
          if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Selective Request'; }
          // Highlight the reason field
          if(reasonEl){ reasonEl.focus(); reasonEl.style.borderColor = 'var(--red, #dc2626)'; setTimeout(()=>{ reasonEl.style.borderColor = ''; }, 2000); }
          return;
        }
        const reqPayload = {
          scope_type:    (ctx.kind === 'grn') ? 'voucher_grn' : 'voucher_op',
          voucher_kind:  ctx.kind,
          voucher_id:    (ctx.kind === 'grn') ? ctx.grn_id : ctx.op_seq,
          voucher_label: (ctx.kind === 'grn') ? ctx.grn_no : ctx.op_label,
          product_id:    ctx.product_id,
          selections:    selections,
          removed_box_ids: removed,
          reason:        userReason,
        };
        if(ctx.kind === 'op') reqPayload.godown_id = ctx.godown_id;

        const res = await fetch('/api/pm_stock/reprint/request', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(reqPayload),
        });
        const txt = await res.text();
        let d = null;
        try { d = txt ? JSON.parse(txt) : null; } catch(_){ d = null; }
        if(!d){
          const hint = (res.status === 404)
            ? 'Endpoint not found — has the server been restarted to pick up the new routes?'
            : (res.status === 401 || res.status === 403) ? 'Not authorised — please log in.'
            : (res.status >= 500) ? 'Server error — see Flask log for details.'
            : `HTTP ${res.status}`;
          if(typeof showToast==='function') showToast(hint, 'error', 6000);
          if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Selective Request'; }
          return;
        }
        if(!res.ok || d.status !== 'ok'){
          if(typeof showToast==='function') showToast(d.message || `HTTP ${res.status}`, 'error', 6000);
          if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Selective Request'; }
          return;
        }
        if(typeof showToast==='function')
          showToast(`✓ Request #${d.req_id} submitted — admin will review. Check "My Reprint Requests" for status.`,'success', 5500);
        closeModal('selBoxReprintModal');
        // Refresh the My Requests panel if it's currently visible
        if(typeof loadMyReprintRequests === 'function'){ try{ loadMyReprintRequests(); }catch(e){} }
        return;
      }

      // ── Admin: APPLY the selective reprint immediately ──
      const payload = {
        product_id:      ctx.product_id,
        selections,
        removed_box_ids: removed,
        reason:          'Selective reprint with edits',
      };
      let url;
      if(ctx.kind === 'grn'){
        url = `/api/pm_stock/grn/${ctx.grn_id}/reprint_labels_selective`;
      } else {
        // OP
        payload.godown_id = ctx.godown_id;
        url = `/api/pm_stock/op_batches/${ctx.op_seq}/reprint_selective`;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      // Robust response parse: server may have returned HTML if the
      // route doesn't exist (Flask not restarted after a routes update),
      // an auth redirect, or an unhandled exception. Try JSON first;
      // fall back to a clean HTTP-status message instead of the cryptic
      // "Unexpected token '<'" the raw JSON.parse failure produces.
      const txt = await res.text();
      let d = null;
      try { d = txt ? JSON.parse(txt) : null; } catch(_){ d = null; }
      if(!d){
        const hint = (res.status === 404)
          ? 'Endpoint not found — has the server been restarted to pick up the new routes?'
          : (res.status === 401 || res.status === 403)
            ? 'Not authorised — log in as admin or ensure your home location matches.'
            : (res.status >= 500)
              ? 'Server error — see Flask log for details.'
              : `HTTP ${res.status}`;
        if(typeof showToast==='function') showToast(hint, 'error', 6000);
        if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-print"></i> Save &amp; Print Selected'; }
        return;
      }
      if(!res.ok || d.status !== 'ok'){
        if(typeof showToast==='function') showToast(d.message || `HTTP ${res.status}`, 'error', 5500);
        if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-print"></i> Save &amp; Print Selected'; }
        return;
      }
      if(typeof showToast==='function') showToast('✓ Saved — opening print preview…','success', 3000);
      closeModal('selBoxReprintModal');

      // Fire the existing print pipeline with the selected subset
      _sbrFirePrint(ctx, d);

      // Refresh GRN list / OP batches list if open
      if(ctx.kind === 'grn' && typeof loadVoucherLog === 'function') loadVoucherLog();
      if(ctx.kind === 'op' && typeof loadOpBatches === 'function') {
        try { loadOpBatches(); } catch(e){}
      }
      if(typeof loadSummary === 'function') loadSummary();
    } catch(e){
      if(typeof showToast==='function') showToast('Network error: ' + (e.message||e),'error');
      if(btn){ btn.disabled = false; btn.innerHTML = (ctx.mode==='request')
        ? '<i class="fas fa-paper-plane"></i> Submit Selective Request'
        : '<i class="fas fa-print"></i> Save &amp; Print Selected'; }
    }
  };

  // Hand the server response to the existing print code.
  // Server returns: { status, box_codes:[...], per_box_qtys:[...], no_of_box, ... }
  // We reuse grnLabelDoPrint by constructing the modal._labelData expected shape.
  // Exposed as window._sbrFirePrint so redeemAndPrint (lives in a different
  // top-level scope) can also call it after applying an approved selective
  // request.
  window._sbrFirePrint = function(ctx, resp){ return _sbrFirePrint(ctx, resp); };
  function _sbrFirePrint(ctx, resp){
    const codes = Array.isArray(resp.box_codes) ? resp.box_codes : [];
    const pbqs  = Array.isArray(resp.per_box_qtys) ? resp.per_box_qtys : [];
    // Parallel array of 8-char sequential short_codes from the server.
    // Empty/missing entries mean a legacy box; the renderer falls back
    // to encoding the long box_code in the QR for those.
    const shortCodes = Array.isArray(resp.short_codes) ? resp.short_codes : [];
    if(!codes.length){
      if(typeof showToast==='function') showToast('No box codes returned — refresh and try again','error');
      return;
    }
    // For multi-pbq prints, expand items list so each label gets its own per-box-qty.
    // The existing grnLabelDoPrint expects items[] with noOfBox + boxCount;
    // we fake that by creating one synthetic item per box code, each with noOfBox=1.
    // It then iterates allPages = N (one per item).
    //
    // Box-of-N label numbering: the server tells us the actual box_seq for
    // each printed box and the total batch size. If those fields aren't
    // present (older server), we parse the trailing `B<nnn>` from the
    // box code as a fallback. Either way, the printed label correctly
    // shows e.g. "3/5" — the box's real position in the original batch
    // — instead of "1/1".
    const seqsFromServer = Array.isArray(resp.box_seqs) ? resp.box_seqs : null;
    const totalBoxesFinal = Number(resp.total_boxes || resp.no_of_box || codes.length);
    function _seqFromCode(code){
      const m = String(code||'').match(/-B(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : null;
    }
    const items = codes.map((code, i) => {
      const seq = (seqsFromServer && seqsFromServer[i] != null)
        ? Number(seqsFromServer[i])
        : (_seqFromCode(code) || (i + 1));
      return {
        productId:    ctx.product_id,
        productCode:  ctx.product_code || '',
        productName:  ctx.product_name || '—',
        pmType:       ctx.pm_type || '',
        brandName:    ctx.brand_name || '',
        noOfBox:      1,                       // each synthetic item = one box → one page
        boxCount:     pbqs[i] || 0,            // per-box qty for this specific label
        qty:          pbqs[i] || 0,            // per-label total = qty per box
        _boxCode:     code,
        _shortCode:   shortCodes[i] || '',     // 8-char QR payload (empty = use boxCode)
        _boxNum:      seq,                     // this box's actual seq in the batch
        _totalBoxes:  totalBoxesFinal,         // total boxes in the rebuilt batch
      };
    });
    const boxCodes = codes.slice();

    const modalEl = document.getElementById('grnLabelModal') || (() => {
      const ph = document.createElement('div');
      ph.id = 'grnLabelModal'; ph.style.display = 'none';
      document.body.appendChild(ph); return ph;
    })();

    const fmtDateLocal = (s) => {
      if(!s) return '—';
      const dt = String(s).slice(0,10).split('-');
      if(dt.length !== 3) return s;
      return `${dt[2]}/${dt[1]}/${dt[0]}`;
    };

    if(ctx.kind === 'grn'){
      modalEl._labelData = {
        isOpening:       false,
        grnNo:           ctx.grn_no,
        grnDate:         ctx.grn_date,
        grnDateFmt:      fmtDateLocal(ctx.grn_date),
        supervisor:      ctx.supervisor || '—',
        location:        '',
        istStr:          new Date().toLocaleString('en-IN'),
        items,
        supplierText:    ctx.supplier_text || '—',
        invoiceNo:       ctx.invoice_no || '—',
        invoiceDateFmt:  fmtDateLocal(ctx.invoice_date),
        boxCodes,
        shortCodes,        // parallel array; per-item _shortCode also set above
        _codeCursor:     0,
        // Selective reprint is single-product so one FIFO code applies to
        // all printed labels in this run — stamp at label-data level.
        fifoCode:        resp.fifo_code || '',
      };
    } else {
      modalEl._labelData = {
        isOpening:       true,
        opLabel:         ctx.op_label,
        opDateFmt:       fmtDateLocal(ctx.op_date),
        locationName:    (function(){
          const list = (window._godowns || []);
          const g = list.find(x => Number(x.id) === Number(ctx.godown_id));
          if(!g) return '—';
          const isFloor = (g.godown_type === 'floor' || g.is_floor || (g.type||'').toLowerCase()==='floor');
          return isFloor ? (g.name + ' (Factory)') : (g.name || '—');
        })(),
        remarks:         'Selective reprint',
        grnNo:           ctx.op_label,
        grnDateFmt:      fmtDateLocal(ctx.op_date),
        supplierText:    'Opening Stock',
        invoiceNo:       '—',
        invoiceDateFmt:  '—',
        location:        '',
        supervisor:      (window._currentUser || ''),
        istStr:          new Date().toLocaleString('en-IN'),
        items,
        boxCodes,
        shortCodes,
        _codeCursor:     0,
        fifoCode:        resp.fifo_code || '',
      };
    }
    if(typeof grnLabelDoPrint === 'function'){
      grnLabelDoPrint();
    } else {
      if(typeof showToast==='function') showToast('Print function not available — page reload needed','error');
    }
  }
})();

