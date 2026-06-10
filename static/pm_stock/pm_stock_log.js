/* pm_stock_log.js — Voucher Log, transaction list, edits */

let _vlogFilter = 'all'; // 'all' | 'grn' | 'mt' | 'dn' — moved from grn_mtv.js

// ── setVlogFilter (originally L558..L574) ─────────────────────────
function setVlogFilter(f){
  _vlogFilter = f;
  ['all','grn','mt','dn'].forEach(k=>{
    const btn = document.getElementById('vlog-filter-'+k);
    if(!btn) return;
    const colorFor = {grn:'var(--teal,#0d9488)', mt:'var(--floor-clr,#d97706)', dn:'#5E35B1', all:'var(--brand)'};
    if(k===f){
      btn.style.background = colorFor[k];
      btn.style.color='#fff';
    } else {
      btn.style.background='var(--hsurf2,#f8fafc)';
      btn.style.color = k==='all' ? 'var(--muted2,#6b7280)' : colorFor[k];
    }
  });
  renderVoucherLog();
}


// ── loadGrnList (originally L575..L576) ─────────────────────────
async function loadGrnList() { await loadVoucherLog(); }  // legacy alias


// ── loadVoucherLog (originally L577..L628) ─────────────────────────
async function loadVoucherLog() {
  const from   = document.getElementById('grn-from')?.value||'';
  const to     = document.getElementById('grn-to')?.value||'';
  const search = document.getElementById('grn-search')?.value||'';
  const tbody  = document.getElementById('grnListTbody');
  if(tbody) tbody.innerHTML=`<tr><td colspan="11" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;

  const gParams = new URLSearchParams({from_date:from, to_date:to, search});
  // Material Movement transfers replace the legacy MTV system
  const tParams = new URLSearchParams({from_date:from, to_date:to, search});
  // DN list uses different param names
  const dParams = new URLSearchParams();
  if(from) dParams.set('from', from);
  if(to)   dParams.set('to',   to);
  if(search) dParams.set('supplier', search);

  try {
    const [gRes, tRes, dRes] = await Promise.all([
      fetch('/api/pm_stock/grn/list?'+gParams),
      fetch('/api/pm_stock/transfers/list?'+tParams).catch(() => null),
      fetch('/api/pm_stock/dn/list?'+dParams).catch(() => null),
    ]);
    const grns = (await gRes.json()).map(r=>({...r, _type:'grn'}));
    let mts = [];
    if(tRes && tRes.ok) {
      try {
        const tj = await tRes.json();
        if(tj && tj.status === 'ok' && Array.isArray(tj.transfers)) {
          mts = tj.transfers.map(r=>({...r, _type:'mt'}));
        }
      } catch(e) { /* skip */ }
    }
    let dns = [];
    if(dRes && dRes.ok) {
      try {
        const dj = await dRes.json();
        if(dj && dj.status === 'ok' && Array.isArray(dj.dns)) {
          dns = dj.dns.map(r=>({...r, _type:'dn'}));
        }
      } catch(e) { /* server returned non-JSON — skip */ }
    }
    // Merge and sort by date desc
    _grnRows = [...grns, ...mts, ...dns].sort((a,b)=>{
      const da = a.grn_date || (a.out_at||'').slice(0,10) || a.dn_date || '';
      const db = b.grn_date || (b.out_at||'').slice(0,10) || b.dn_date || '';
      return db.localeCompare(da);
    });
  } catch(e) { _grnRows=[]; }
  _pag.grn.page=1;
  renderVoucherLog();
}


// ── renderVoucherLog (originally L629..L760) ─────────────────────────
function renderVoucherLog() {
  const rows = _vlogFilter==='all' ? _grnRows
             : _grnRows.filter(r=>r._type===_vlogFilter);
  const {slice,total,pages,page,start} = paginate(rows,'grn');
  const tbody = document.getElementById('grnListTbody');
  if(!tbody) return;
  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="12" class="no-data"><i class="fas fa-file-invoice"></i> No vouchers found.</td></tr>`;
    document.getElementById('grnPag').innerHTML=''; return;
  }
  tbody.innerHTML = slice.map((r,i)=>{
    const isGrn = r._type === 'grn';
    const isMt  = r._type === 'mt';
    const isDn  = r._type === 'dn';
    let typeBadge, voucherNo, voucherColor, voucherBg, voucherBorder, date, from, to, actions, editCall;
    if(isGrn) {
      // Distinguish pending-verification GRNs from posted ones. A pending GRN
      // has NOT yet contributed inward stock — show that prominently so users
      // don't assume stock has moved.
      const isPending = (r.verification_status === 'pending');
      if(isPending){
        typeBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;background:rgba(14,165,233,.12);color:#0ea5e9;border:1px solid rgba(14,165,233,.30);letter-spacing:.5px" title="Pending box-scan verification — no inward stock posted yet">GRN · PENDING</span>`;
      } else {
        typeBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;background:rgba(26,115,232,.12);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.25);letter-spacing:.5px">GRN</span>`;
      }
      voucherNo = r.grn_no;
      voucherColor = isPending ? '#0ea5e9' : 'var(--teal,#0d9488)';
      voucherBg    = isPending ? 'rgba(14,165,233,.08)' : 'rgba(26,115,232,.08)';
      voucherBorder= isPending ? 'rgba(14,165,233,.25)' : 'rgba(26,115,232,.2)';
      date = r.grn_date;
      from = r.supplier || '<span style="color:var(--muted,#9ca3af)">—</span>';
      to   = r.godown_name || '—';
      editCall = isPending ? `openGrnVerifyModal(${r.id})` : `openEditGrn(${r.id})`;
      const verifyBtn = isPending
        ? `<button class="action-btn" onclick="openGrnVerifyModal(${r.id})" title="Scan boxes to verify and post stock" style="background:rgba(14,165,233,.12);color:#0ea5e9;border:1px solid rgba(14,165,233,.30)"><i class="fas fa-qrcode"></i></button>`
        : '';
      actions = `${verifyBtn}<button class="action-btn" onclick="openEditGrn(${r.id})" title="Edit GRN" style="background:rgba(26,115,232,.1);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.25)"><i class="fas fa-edit"></i></button>
                 <button class="action-btn" onclick="pmGrnPrintById(${r.id})" title="Print GRN voucher" style="background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25)"><i class="fas fa-print"></i></button>
                 <button class="action-btn" onclick="requestGrnLabelReprint(${r.id},'${(r.grn_no||'').replace(/'/g,'')}')" title="Reprint box labels (admin approval required)" style="background:rgba(245,158,11,.1);color:#d97706;border:1px solid rgba(245,158,11,.25)"><i class="fas fa-tags"></i></button>
                 <button class="action-btn del" onclick="deleteGrn(${r.id},'${r.grn_no}')" title="Delete GRN"><i class="fas fa-trash"></i></button>`;
    } else if(isMt) {
      // Differentiate Material Transfer (MT) from Material Allotment (AL).
      // Allotment vouchers reuse the entire transfer pipeline but are flagged
      // with voucher_type='allotment' on the backend. The badge label changes
      // ("ALOT" instead of "XFER") so users can tell at a glance which type
      // they're looking at, but action buttons and click handlers are the
      // same for both since the underlying flow is identical.
      const isAllot = (r.voucher_type === 'allotment');
      const baseLbl = isAllot ? 'ALOT' : 'XFER';
      const st = r.status || '';
      let stColor = '#d97706', stBg = 'rgba(245,158,11,.12)', stBorder = 'rgba(245,158,11,.25)', stLabel = isAllot ? 'ALLOTMENT' : 'TRANSFER';
      if(r.has_discrepancy)         { stColor = '#dc2626'; stBg = 'rgba(220,38,38,.12)';  stBorder = 'rgba(220,38,38,.30)';  stLabel = '⚠ ' + baseLbl; }
      else if(st === 'out_started') { stColor = '#3b82f6'; stBg = 'rgba(59,130,246,.12)'; stBorder = 'rgba(59,130,246,.25)'; stLabel = baseLbl + ' · DRAFT'; }
      else if(st === 'in_pending')  { stColor = '#f59e0b'; stBg = 'rgba(245,158,11,.12)'; stBorder = 'rgba(245,158,11,.25)'; stLabel = baseLbl + ' · TRANSIT'; }
      else if(st === 'received')    { stColor = '#16a34a'; stBg = 'rgba(22,163,74,.12)';  stBorder = 'rgba(22,163,74,.25)';  stLabel = baseLbl + ' · DONE'; }
      else if(st === 'cancelled')   { stColor = '#6b7280'; stBg = 'rgba(107,114,128,.12)';stBorder = 'rgba(107,114,128,.25)';stLabel = baseLbl + ' · CANCEL'; }
      // Allotment-specific accent: tint the chip purple when not in an error/done/cancel state
      // so it visually stands apart from transfers.
      if(isAllot && !r.has_discrepancy && st !== 'received' && st !== 'cancelled'){
        stColor = '#7c3aed'; stBg = 'rgba(124,58,237,.10)'; stBorder = 'rgba(124,58,237,.28)';
      }
      typeBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;background:${stBg};color:${stColor};border:1px solid ${stBorder};letter-spacing:.5px" title="${isAllot ? 'Material Allotment voucher (FG packing)' : 'Material Transfer voucher'}">${stLabel}</span>`;
      voucherNo     = r.transfer_no;
      voucherColor  = stColor;
      voucherBg     = stBg;
      voucherBorder = stBorder;
      date = (r.out_at||'').slice(0,10);
      from = `<span style="font-size:11px;color:var(--muted2,#6b7280)">${r.from_name||'—'}</span>`;
      to   = `<span style="font-size:11px;color:var(--muted2,#6b7280)">${r.to_name||'—'}</span>`;
      const openCall = (st === 'out_started') ? `mvOpenOutVoucher(${r.transfer_id})`
                     : (st === 'in_pending')  ? `mvOpenInVoucher(${r.transfer_id})`
                     : `printTransferVoucher(${r.transfer_id},'out')`;
      editCall = openCall;
      const actBtnsArr = [];
      if(st === 'out_started') {
        actBtnsArr.push(`<button class="action-btn" onclick="mvOpenOutVoucher(${r.transfer_id})" title="Open OUT voucher" style="background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25)"><i class="fas fa-edit"></i></button>`);
      } else if(st === 'in_pending') {
        actBtnsArr.push(`<button class="action-btn" onclick="mvOpenInVoucher(${r.transfer_id})" title="Open IN voucher" style="background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.25)"><i class="fas fa-edit"></i></button>`);
      }
      actBtnsArr.push(`<button class="action-btn" onclick="printTransferVoucher(${r.transfer_id},'out')" title="Print OUT voucher" style="background:rgba(146,64,14,.1);color:#92400e;border:1px solid rgba(146,64,14,.25)"><i class="fas fa-print"></i></button>`);
      if(st === 'in_pending' || st === 'received') {
        actBtnsArr.push(`<button class="action-btn" onclick="printTransferInVoucher(${r.transfer_id})" title="Print IN voucher" style="background:rgba(30,64,175,.1);color:#1e40af;border:1px solid rgba(30,64,175,.25)"><i class="fas fa-print"></i></button>`);
      }
      if((typeof _isAdmin === 'function' ? _isAdmin() : false)) {
        const safeLabel = (r.transfer_no||'').replace(/'/g,'');
        // Admin Edit — full-power edit modal that cascades stock recompute.
        // Distinct red-pencil icon so it's not confused with the regular OPEN button.
        actBtnsArr.push(`<button class="action-btn" onclick="openTransferAdminEdit(${r.transfer_id})" title="Admin Edit: change voucher fields and re-post stock" style="background:rgba(220,38,38,.1);color:#dc2626;border:1px solid rgba(220,38,38,.3)"><i class="fas fa-user-edit"></i></button>`);
        actBtnsArr.push(`<button class="action-btn del" onclick="adminDeleteTransfer(${r.transfer_id},'${safeLabel}','${st}',${r.total_boxes||0},${r.total_qty||0})" title="Admin: delete voucher and revert stock"><i class="fas fa-trash"></i></button>`);
      }
      actions = actBtnsArr.join('');
    } else { // dn
      typeBadge = `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;background:rgba(99,102,241,.12);color:#5E35B1;border:1px solid rgba(99,102,241,.25);letter-spacing:.5px">DN</span>`;
      voucherNo = r.dn_no;
      voucherColor = '#5E35B1';
      voucherBg    = 'rgba(99,102,241,.08)';
      voucherBorder= 'rgba(99,102,241,.22)';
      date = r.dn_date;
      from = `<span style="font-size:11px;color:var(--muted2,#6b7280)">${r.godown_name||'—'}</span>`;
      to   = r.supplier || '<span style="color:var(--muted,#9ca3af)">—</span>';
      editCall = `openEditDn(${r.id})`;
      actions = `<button class="action-btn" onclick="openEditDn(${r.id})" title="Edit DN" style="background:rgba(99,102,241,.1);color:#5E35B1;border:1px solid rgba(99,102,241,.25)"><i class="fas fa-edit"></i></button>
                 <button class="action-btn" onclick="pmDnPrintById(${r.id})" title="Print DN" style="background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25)"><i class="fas fa-print"></i></button>
                 <button class="action-btn del" onclick="deleteDn(${r.id},'${r.dn_no}')" title="Delete DN"><i class="fas fa-trash"></i></button>`;
    }
    // Expand chevron — toggles inline detail row underneath
    const vtype = isGrn ? 'grn' : (isMt ? 'mt' : 'dn');
    const vid   = isGrn ? r.id  : (isMt ? r.transfer_id : r.id);
    const expandBtn = `<button onclick="event.stopPropagation();toggleVoucherDetails('${vtype}',${vid},this)"
        title="Show line item details"
        style="background:transparent;border:none;cursor:pointer;color:${voucherColor};
               padding:2px 4px;border-radius:3px;font-size:11px;line-height:1;
               transition:transform .15s ease;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px"
        data-expand-btn="${vtype}-${vid}">▶</button>`;
    return `<tr class="dbl-hint" style="cursor:pointer" ondblclick="${editCall}" title="Double-click to edit"
              data-voucher-row="${vtype}-${vid}">
      <td style="color:var(--muted,#9ca3af);font-size:11px">
        <span style="display:inline-flex;align-items:center;gap:5px">
          ${expandBtn}<span>${start+i+1}</span>
        </span>
      </td>
      <td>${typeBadge}</td>
      <td><span style="font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;
        color:${voucherColor};background:${voucherBg};
        padding:2px 9px;border-radius:4px;border:1px solid ${voucherBorder}">${voucherNo}</span>${
          // 📎 Invoice file count badge (GRN only)
          isGrn && (parseInt(r.invoice_file_count) || 0) > 0
            ? `<span title="${r.invoice_file_count} invoice file${r.invoice_file_count==1?'':'s'} attached"
                style="display:inline-flex;align-items:center;gap:2px;margin-left:6px;
                       padding:1px 6px;border-radius:9px;font-size:10px;font-weight:700;
                       font-family:var(--font-mono,monospace);line-height:1.4;
                       background:rgba(26,115,232,.12);color:var(--teal,#0d9488);
                       border:1px solid rgba(26,115,232,.30)"><i class="fas fa-paperclip" style="font-size:9px"></i> ${r.invoice_file_count}</span>`
            : ''
        }</td>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(date)}</td>
      <td class="td-name" style="max-width:160px">${from}</td>
      <td style="font-size:11px;color:var(--muted2,#6b7280)">${to}</td>
      <td class="num" style="color:var(--muted2,#6b7280)">${r.item_count||0}</td>
      <td class="num" style="font-weight:700;color:${voucherColor}">${fmt(r.total_qty||0)}</td>
      <td style="color:var(--muted,#9ca3af);font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.remarks||'—'}</td>
      <td style="color:var(--muted,#9ca3af);font-size:11px">${r.created_by||'—'}</td>
      <td style="text-align:center;white-space:nowrap">${actions}</td>
    </tr>`;
  }).join('');
  renderPag('grnPag','grn',total,pages,page);

  // If "Expand All" is currently active, immediately expand all freshly
  // rendered rows (e.g. after pagination / filter change).
  if(window._vlogExpandAll){
    setTimeout(() => {
      slice.forEach(r => {
        const vt  = r._type === 'grn' ? 'grn' : (r._type === 'mt' ? 'mt' : 'dn');
        const vid = r._type === 'grn' ? r.id  : (r._type === 'mt' ? r.transfer_id : r.id);
        const btn = document.querySelector(`[data-expand-btn="${vt}-${vid}"]`);
        if(btn && btn.dataset.expanded !== '1') toggleVoucherDetails(vt, vid, btn, true);
      });
    }, 50);
  }
}

/* ── Voucher detail expansion (Feature 1) ─────────────────────────
   Lazy-fetches line items the first time a row is expanded, caches
   them in window._voucherDetailCache, and toggles the detail row's
   visibility on subsequent clicks.
─────────────────────────────────────────────────────────────────── */
window._voucherDetailCache = window._voucherDetailCache || {};
window._vlogExpandAll      = false;


// ── toggleVoucherDetails (originally L761..L806) ─────────────────────────
async function toggleVoucherDetails(vtype, vid, btn, forceExpand){
  const key = `${vtype}-${vid}`;
  const row = document.querySelector(`[data-voucher-row="${key}"]`);
  if(!row) return;
  // Locate or create the detail sub-row (sibling immediately after the data row)
  let detailRow = row.nextElementSibling;
  if(!detailRow || detailRow.dataset.detailFor !== key){
    detailRow = document.createElement('tr');
    detailRow.dataset.detailFor = key;
    detailRow.style.display = 'none';
    detailRow.innerHTML = `<td colspan="11" style="padding:0;background:var(--hsurf2,#f8fafc);border-top:0">
      <div data-detail-body style="padding:14px 18px"></div>
    </td>`;
    row.parentNode.insertBefore(detailRow, row.nextSibling);
  }
  const isOpen = detailRow.style.display !== 'none';
  if(isOpen && !forceExpand){
    detailRow.style.display = 'none';
    if(btn){ btn.style.transform = ''; btn.dataset.expanded = '0'; }
    return;
  }
  // Open
  detailRow.style.display = '';
  if(btn){ btn.style.transform = 'rotate(90deg)'; btn.dataset.expanded = '1'; }

  const body = detailRow.querySelector('[data-detail-body]');
  // Use cache if present
  if(window._voucherDetailCache[key]){
    body.innerHTML = renderVoucherDetailHTML(window._voucherDetailCache[key]);
    return;
  }
  body.innerHTML = `<div style="font-size:11px;color:var(--muted2,#6b7280);padding:6px 0"><i class="fas fa-spinner fa-spin"></i> Loading items…</div>`;
  try {
    const res = await fetch(`/api/pm_stock/voucher/items?type=${vtype}&id=${vid}`);
    const d   = await res.json();
    if(d.status !== 'ok'){
      body.innerHTML = `<div style="color:#dc2626;font-size:11px;padding:6px 0">Error: ${d.message || 'Failed to load items'}</div>`;
      return;
    }
    window._voucherDetailCache[key] = d;
    body.innerHTML = renderVoucherDetailHTML(d);
  } catch(e){
    body.innerHTML = `<div style="color:#dc2626;font-size:11px;padding:6px 0">Network error: ${e.message}</div>`;
  }
}


// ── renderVoucherDetailHTML (originally L807..L860) ─────────────────────────
function renderVoucherDetailHTML(d){
  const items = d.items || [];
  if(!items.length){
    return `<div style="font-size:11px;color:var(--muted2,#6b7280);padding:8px 0;font-style:italic">No line items.</div>`;
  }
  const fmt2 = n => (Number(n)||0).toLocaleString('en-IN');
  const isMt = d.type === 'mt';
  // For transfers, group by side (out/in). For others, one flat block.
  const groups = isMt
    ? [
        { label: 'OUT (Source)',     items: items.filter(i => (i.side||'').toLowerCase() === 'out'), color: '#92400e' },
        { label: 'IN (Destination)', items: items.filter(i => (i.side||'').toLowerCase() === 'in'),  color: '#16a34a' }
      ].filter(g => g.items.length)
    : [{ label: '', items, color: 'var(--teal,#0d9488)' }];

  const headerInfo = `
    <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:11px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))">
      <div><span style="color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.5px;font-weight:700;font-size:9.5px">From: </span><strong style="color:var(--htxtb,#111)">${d.from || '—'}</strong></div>
      <div><span style="color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.5px;font-weight:700;font-size:9.5px">To: </span><strong style="color:var(--htxtb,#111)">${d.to || '—'}</strong></div>
      <div style="margin-left:auto;color:var(--hmuted,#9ca3af);font-size:10px"><strong>${items.length}</strong> line item${items.length===1?'':'s'}</div>
    </div>`;

  const tableHTML = groups.map(g => {
    const heading = g.label ? `<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${g.color};margin-bottom:6px">${g.label}</div>` : '';
    return heading + `
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-bottom:${groups.length>1?'12px':'0'}">
        <thead>
          <tr style="background:rgba(0,0,0,.03)">
            <th style="text-align:left;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);width:100px">Code</th>
            <th style="text-align:left;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280)">Product</th>
            <th style="text-align:left;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);width:80px">Type</th>
            <th style="text-align:right;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);width:70px">Boxes</th>
            <th style="text-align:right;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);width:90px">Qty/Box</th>
            <th style="text-align:right;padding:6px 10px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);width:100px">Total Qty</th>
          </tr>
        </thead>
        <tbody>
          ${g.items.map(i => `
            <tr style="border-top:1px solid var(--hbdr,rgba(0,0,0,.05))">
              <td style="padding:6px 10px;font-family:monospace;font-size:10.5px;font-weight:700;color:#7c3aed">${i.product_code || '—'}</td>
              <td style="padding:6px 10px;font-weight:700;color:var(--htxtb,#111)">${i.product_name || '—'}<div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:400;margin-top:1px">${i.brand_name || ''}</div></td>
              <td style="padding:6px 10px;font-size:10px;color:var(--hmuted2,#6b7280)">${i.pm_type || '—'}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:11px">${fmt2(i.no_of_box)}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:11px">${fmt2(i.per_box_qty)}</td>
              <td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:11.5px;font-weight:800;color:${g.color}">${fmt2(i.total_qty)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }).join('');

  return headerInfo + tableHTML;
}


// ── vlogToggleExpandAll (originally L861..L894) ─────────────────────────
function vlogToggleExpandAll(){
  window._vlogExpandAll = !window._vlogExpandAll;
  const btn = document.getElementById('vlog-expand-all-btn');
  if(btn){
    if(window._vlogExpandAll){
      btn.innerHTML = '<i class="fas fa-compress-alt"></i> Collapse All';
      btn.style.background = 'rgba(124,58,237,.12)';
      btn.style.color = '#7c3aed';
      btn.style.borderColor = 'rgba(124,58,237,.3)';
    } else {
      btn.innerHTML = '<i class="fas fa-expand-alt"></i> Detailed';
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }
  }
  if(window._vlogExpandAll){
    // Expand every currently visible row
    document.querySelectorAll('[data-expand-btn]').forEach(b => {
      if(b.dataset.expanded !== '1'){
        const [vt, vidStr] = b.dataset.expandBtn.split('-');
        toggleVoucherDetails(vt, parseInt(vidStr, 10), b, true);
      }
    });
  } else {
    // Collapse all
    document.querySelectorAll('[data-detail-for]').forEach(r => { r.style.display = 'none'; });
    document.querySelectorAll('[data-expand-btn]').forEach(b => {
      b.style.transform = '';
      b.dataset.expanded = '0';
    });
  }
}


// ── renderGrnList (originally L895..L896) ─────────────────────────
function renderGrnList(rows){ renderVoucherLog(); } // legacy alias


// ── loadLog (originally L1651..L1668) ─────────────────────────
async function loadLog() {
  const params=new URLSearchParams({
    from_date:  document.getElementById('log-from').value||'',
    to_date:    document.getElementById('log-to').value||'',
    search:     document.getElementById('log-search').value||'',
    pm_type:    document.getElementById('log-pm-type').value||'',
    source:     document.getElementById('log-source').value||'all',
    godown_id:  document.getElementById('gl-location')?.value||'',
  });
  document.getElementById('logTbody').innerHTML=`<tr class="loading-row"><td colspan="11"><span class="spinner"></span> Loading…</td></tr>`;
  try {
    const res=await fetch('/api/pm_stock/transactions?'+params);
    _logRows=await res.json();
  } catch(e) { _logRows=[]; }
  _pag.log.page=1;
  renderLog(_logRows);
}


// ── renderLog (originally L1669..L1770) ─────────────────────────
function renderLog(rows) {
  const {slice,total,pages,page,start}=paginate(rows,'log');
  const tbody=document.getElementById('logTbody');
  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="11" class="no-data"><i class="fas fa-filter"></i> No vouchers found</td></tr>`;
    document.getElementById('logPag').innerHTML=''; return;
  }
  tbody.innerHTML=slice.map((r,i)=>{
    const isGrn    = r.source==='grn';
    const isMtv    = r.source==='mtv';
    const isGodown = r.source==='godown';
    const isFloor  = r.source==='floor';

    // ── Voucher badge colour ──
    const vnoColor  = isGrn ? 'var(--teal,#0d9488)'
                    : isMtv ? 'var(--amber-text,#92400e)'
                    : isGodown ? 'var(--godown-clr,#0ea5e9)'
                    : '#8b5cf6'; // floor = purple
    const vnoBg     = isGrn ? 'rgba(26,115,232,.08)'
                    : isMtv ? 'rgba(245,158,11,.1)'
                    : isGodown ? 'rgba(14,165,233,.08)'
                    : 'rgba(139,92,246,.08)';
    const vnoBorder = isGrn ? 'rgba(26,115,232,.2)'
                    : isMtv ? 'rgba(245,158,11,.3)'
                    : isGodown ? 'rgba(14,165,233,.2)'
                    : 'rgba(139,92,246,.2)';
    const vnoCell=`<span style="font-family:var(--font-mono,monospace);font-size:10px;font-weight:700;
      color:${vnoColor};background:${vnoBg};padding:1px 7px;border-radius:4px;
      border:1px solid ${vnoBorder}">${r.voucher_no||'—'}</span>`;

    // ── Type badge ──
    const typeLabel  = isGrn    ? 'GRN'
                     : isMtv    ? 'MTV'
                     : isGodown ? (r.txn_type==='opening' ? 'OPENING'
                                 : r.txn_type==='inward'  ? 'INWARD'
                                 : 'OUTWARD')
                     : isFloor  ? (r.txn_type==='floor_opening' ? 'FLR-OP'
                                 : r.txn_type==='dispatch'      ? 'DISPATCH'
                                 : r.txn_type==='rejection'     ? 'REJECT'
                                 : r.txn_type==='pm_return'     ? 'RETURN'
                                 : r.txn_type||'FLOOR')
                     : r.txn_type||'—';
    const typeBg     = isGrn    ? 'rgba(34,197,94,.12)'
                     : isMtv    ? 'rgba(245,158,11,.12)'
                     : isGodown ? 'rgba(14,165,233,.1)'
                     : 'rgba(245,158,11,.1)';
    const typeColor  = isGrn    ? '#16a34a'
                     : isMtv    ? '#92400e'
                     : isGodown ? '#0369a1'
                     : '#92400e';
    const typeBorder = isGrn    ? 'rgba(34,197,94,.25)'
                     : isMtv    ? 'rgba(245,158,11,.3)'
                     : isGodown ? 'rgba(14,165,233,.25)'
                     : 'rgba(245,158,11,.3)';
    const typeCell=`<span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;
      background:${typeBg};color:${typeColor};border:1px solid ${typeBorder};white-space:nowrap">${typeLabel}</span>`;

    // ── FROM column ──
    // GRN: supplier name  |  MTV: from location  |  Godown/Floor: godown name
    const fromText = isGrn    ? (r.supplier || r.from_location || '—')
                   : isMtv    ? (r.from_location || '—')
                   : isGodown ? (r.godown_name || '—')
                   : isFloor  ? (r.godown_name || '—')
                   : '—';
    const fromCell = `<span style="font-size:11px;color:var(--muted2,#6b7280);
      ${isGrn?'font-style:italic':''}">${fromText}</span>`;

    // ── TO column ──
    // GRN: receiving location  |  MTV: to location  |  Godown/Floor: txn type label
    const toText = isGrn    ? (r.godown_name || r.to_location || '—')
                 : isMtv    ? (r.to_location || '—')
                 : '—';
    const toCell = isGrn || isMtv
      ? `<span style="font-size:11px;color:var(--teal,#0d9488);font-weight:600">${toText}</span>`
      : `<span style="font-size:11px;color:var(--muted,#9ca3af)">—</span>`;

    // ── Remarks ──
    const rem = isGrn ? (r.remarks || '—') : (r.remarks || '—');

    // ── Double-click target ──
    const dblFn = isGrn ? `openEditGrn(${r.voucher_id})`
                : isMtv ? `openEditMtv(${r.voucher_id})`
                : '';
    const dblAttr = dblFn ? `ondblclick="${dblFn}" title="Double-click to edit"` : '';

    return `<tr style="cursor:${dblFn?'pointer':'default'}" ${dblAttr}>
      <td style="color:var(--hmuted,#9ca3af)">${start+i+1}</td>
      <td style="white-space:nowrap">${fmtDate(r.txn_date)}</td>
      <td style="white-space:nowrap">${vnoCell}</td>
      <td>${typeCell}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fromCell}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${toCell}</td>
      <td class="td-name" style="max-width:200px">${r.product_name}${dblFn?'<span style="font-size:9px;color:var(--muted,#9ca3af);opacity:0" class="dbl-edit-hint"> ✏ edit</span>':''}</td>
      <td><span class="pm-badge">${r.pm_type}</span></td>
      <td class="num" style="font-size:13px;font-weight:700">${fmt(r.qty)}</td>
      <td style="max-width:160px;color:var(--hmuted,#9ca3af);font-size:11px">${rem}</td>
      <td style="color:var(--hmuted,#9ca3af);font-size:11px">${r.created_by||'—'}</td>
    </tr>`;
  }).join('');
  renderPag('logPag','log',total,pages,page);
}


// ── clearLogFilters (originally L1771..L1782) ─────────────────────────
function clearLogFilters(){
  const today=new Date().toISOString().slice(0,10);
  document.getElementById('log-from').value=today;
  document.getElementById('log-to').value=today;
  document.getElementById('log-search').value='';
  document.getElementById('log-pm-type').value='';
  document.getElementById('log-source').value='all';
  _logRows=[];
  document.getElementById('logTbody').innerHTML=`<tr><td colspan="13" class="no-data"><i class="fas fa-filter"></i> Apply filters and click Fetch</td></tr>`;
  document.getElementById('logPag').innerHTML='';
}


// ── reverseTxn (originally L1830..L1874) ─────────────────────────
async function reverseTxn(id, source, qty, txnType, txnDate, productName){
  // Map original txn_type to its opposite
  const reverseMap = {
    'opening':       'outward',
    'inward':        'outward',
    'outward':       'inward',
    'floor_opening': 'dispatch',
    'issue':         'dispatch',
    'dispatch':      'issue',
    'rejection':     'inward',   // floor rejection reversal goes back as inward
    'pm_return':     'issue',
  };
  const revType = reverseMap[txnType];
  if(!revType){
    showToast('Cannot reverse this transaction type','error');
    return;
  }
  const typeLbl  = txnLabel(txnType);
  const revLbl   = txnLabel(revType);
  const today    = new Date().toISOString().slice(0,10);
  if(!confirm(`Reverse transaction?\n\nProduct: ${productName}\nOriginal: ${typeLbl} × ${fmt(qty)} on ${fmtDate(txnDate)}\nWill create: ${revLbl} × ${fmt(qty)} today\n\nThis keeps the audit trail intact.`)) return;

  const endpoint = source==='godown' ? '/api/pm_stock/godown/save' : '/api/pm_stock/floor/save';
  // Get product id from log rows
  const row = _logRows.find(r=>r.id===id);
  if(!row){ showToast('Row not found','error'); return; }

  const res  = await fetch(endpoint,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      product_id: row.product_id,
      txn_type:   revType,
      qty:        qty,
      txn_date:   today,
      remarks:    `[Reversal of ${typeLbl} on ${fmtDate(txnDate)}]`
    })
  });
  const data = await res.json();
  if(data.status==='ok'){
    showToast(`✓ Reversal entry created — ${revLbl} × ${fmt(qty)}`,'success');
    await loadSummary();
    loadLog();
  } else { showToast(data.message||'Error','error'); }
}


// ── getProductIdByName (originally L1875..L1879) ─────────────────────────
async function getProductIdByName(name, pmType){
  const p = _products.find(x=>x.product_name===name && x.pm_type===pmType);
  return p ? p.id : null;
}


// ── deleteTxn (originally L1880..L1894) ─────────────────────────
async function deleteTxn(id,source){
  if(!confirm('Delete this transaction? This cannot be undone.')) return;
  const res=await fetch('/api/pm_stock/delete_txn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,source})});
  const data=await res.json();
  if(data.status==='ok'){
    showToast('Transaction deleted','success');
    _logRows=_logRows.filter(r=>!(r.id===id&&r.source===source));
    renderLog(_logRows);
    await loadSummary();
  } else { showToast(data.message||'Error','error'); }
}

/* ═══════════════════════════════════════════════════════════
   COMBINED TOTAL TAB
═══════════════════════════════════════════════════════════ */

// ── openEditTxn (originally L2335..L2347) ─────────────────────────
function openEditTxn(id, source, qty, txnDate, remarks) {
  document.getElementById('et-id').value      = id;
  document.getElementById('et-source').value  = source;
  document.getElementById('et-qty').value     = qty;
  document.getElementById('et-date').value    = txnDate;
  document.getElementById('et-remarks').value = remarks;
  document.getElementById('editTxnModal').classList.add('open');
}

// Called from summary row dblclick — opens log tab prefilled for that product
/* ═══════════════════════════════════════════════════════════
   QUICK ENTRY from Stock View (feature 1+2)
═══════════════════════════════════════════════════════════ */

// ── openQuickEntry (originally L2348..L2384) ─────────────────────────
function openQuickEntry(productId, source) {
  const r = _summary.find(s => s.id === productId);
  if(!r) return;

  // Switch to Entry tab and pre-fill the correct form
  switchTab('grn');
  const prefix = source === 'godown' ? 'ge' : 'fe';

  // Pre-fill product search field
  document.getElementById(prefix+'-product-search').value =
    `[${r.pm_type}] ${r.product_name}`;
  document.getElementById(prefix+'-product-id').value = productId;

  // Show preview
  const preview = document.getElementById(prefix+'-product-preview');
  if(preview){
    preview.textContent = `✓ ${r.product_name} — ${r.pm_type}`;
    preview.style.display = 'block';
  }
  // Close dropdown list
  const list = document.getElementById(prefix+'-product-list');
  if(list){ list.classList.remove('open'); list.innerHTML=''; }

  // Feature 2: if godown, default txn type to 'outward' (Issue to Factory)
  // and show current godown stock as context
  if(source === 'godown'){
    document.getElementById('ge-txn-type').value = 'outward';
    document.getElementById('ge-qty').focus();
    showToast(`📦 ${r.product_name} — Godown: ${fmt(r.godown_stock)} — enter qty to issue`,'info');
  } else {
    document.getElementById('fe-txn-type').value = 'dispatch';
    document.getElementById('fe-qty').focus();
    showToast(`🏗️ ${r.product_name} — Floor: ${fmt(r.remaining)} — enter qty`,'info');
  }
}
let _detailProductId = null;


// ── openItemDetail (originally L2385..L2417) ─────────────────────────
function openItemDetail(productId) {
  const r = _summary.find(s => s.id === productId);
  if(!r) return;
  _detailProductId = productId;

  // Populate header
  document.getElementById('idm-name').textContent    = r.product_name;
  document.getElementById('idm-pm').textContent      = r.pm_type;

  // Populate threshold field
  const minStockField = document.getElementById('idm-min-stock');
  if(minStockField) minStockField.value = r.min_stock || 0;
  document.getElementById('itemDetailModal').dataset.productId = productId;

  // Stock chips
  document.getElementById('idm-op').textContent        = fmt(r.op);
  document.getElementById('idm-inward').textContent    = fmt(r.inward);
  document.getElementById('idm-outward').textContent   = fmt(r.outward);
  document.getElementById('idm-godown').textContent    = fmt(r.godown_stock);
  document.getElementById('idm-floor-op').textContent  = fmt(r.floor_op);
  document.getElementById('idm-rejection').textContent = fmt(r.rejection);
  document.getElementById('idm-dispatch').textContent  = fmt(r.dispatch);
  document.getElementById('idm-remaining').textContent = fmt(r.remaining);
  document.getElementById('idm-combined').textContent  = fmt(r.godown_stock + r.remaining);

  // Clear month picker — default to ALL transactions
  document.getElementById('idm-month-picker').value = '';
  document.getElementById('idm-month').textContent  = 'All Transactions';

  document.getElementById('itemDetailModal').classList.add('open');
  loadItemMonthTxns();
}


// ── loadItemMonthTxns (originally L2418..L2482) ─────────────────────────
async function loadItemMonthTxns() {
  if(!_detailProductId) return;
  const ym = document.getElementById('idm-month-picker').value;

  let fromDate = '', toDate = '';
  if(ym) {
    const [yr, mo] = ym.split('-');
    fromDate = `${yr}-${mo}-01`;
    const lastDay = new Date(parseInt(yr), parseInt(mo), 0).getDate();
    toDate = `${yr}-${mo}-${String(lastDay).padStart(2,'0')}`;
    const d = new Date(parseInt(yr), parseInt(mo)-1, 1);
    document.getElementById('idm-month').textContent =
      d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  } else {
    document.getElementById('idm-month').textContent = 'All Transactions';
  }

  const tbody = document.getElementById('idm-txn-tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;

  try {
    const params = new URLSearchParams({
      from_date: fromDate, to_date: toDate,
      search: '', pm_type: '', source: 'all',
      product_id:   String(_detailProductId),  // fetch only this product's transactions
      include_auto: '1'   // include auto-mirror entries so orphans can be deleted
    });
    const res  = await fetch('/api/pm_stock/transactions?' + params);
    const rows = await res.json();

    // Stash for pagination shim — reidmTxn() re-renders on page change.
    window._idmTxnRows = rows || [];
    if(_pag && _pag.idmTxn) _pag.idmTxn.page = 1;
    renderIdmTxnList();
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" class="no-data">Error loading: ${e.message}</td></tr>`;
  }
}

// Paginated renderer — slices window._idmTxnRows by _pag.idmTxn.
function renderIdmTxnList(){
  const tbody = document.getElementById('idm-txn-tbody');
  if(!tbody) return;
  const filtered = window._idmTxnRows || [];
  if(!filtered.length){
    tbody.innerHTML = `<tr><td colspan="6" class="no-data" style="padding:24px">
      <i class="fas fa-inbox" style="font-size:24px;opacity:0.3;display:block;margin-bottom:8px"></i>
      No transactions this month</td></tr>`;
    const pag = document.getElementById('idmTxnPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const p = paginate(filtered, 'idmTxn');
  tbody.innerHTML = p.slice.map((r, i) => {
      const isAuto = (r.remarks||'').startsWith('[Auto:');
      // i is 0-based index within the page; alternate-row stripe uses
      // (p.start + i) so the stripe pattern stays consistent across pages.
      const bg = (p.start + i)%2===0 ? '' : `background:var(--heven,#fafafa)`;
      // Source label + chip class. The data layer exposes several source
      // types: 'godown' / 'floor' (direct ledger rows) and
      // 'grn' / 'mtv' / 'dn' (rolled-up references to vouchers that
      // ultimately wrote into a godown or floor). For chip styling we
      // collapse the latter into 'godown' since they all represent a
      // godown-side transaction in the merged ledger. Without this
      // mapping, 'grn'-sourced rows had `class="src-grn"` with no CSS
      // rule → plain text, while 'godown' rows next to them had a
      // styled blue chip → visual inconsistency.
      const srcLabel = r.source === 'floor' ? 'Factory' : 'Godown';
      const srcClass = r.source === 'floor' ? 'src-floor' : 'src-godown';
      const vnoHtml = r.voucher_no
        ? `<span style="font-family:var(--font-mono,monospace);font-size:9.5px;font-weight:700;color:var(--teal,#0d9488);
            background:var(--teal-glow,rgba(13,148,136,.07));padding:1px 5px;border-radius:3px;
            border:1px solid var(--teal-glow2,rgba(13,148,136,.15));margin-right:5px;white-space:nowrap">${r.voucher_no}</span>`
        : '';
      const remarksText = r.remarks || '';
      const cell = 'padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))';
      return `<tr style="${bg}${isAuto?';opacity:0.75;font-style:italic':''}">
        <td style="${cell};color:var(--htxtb,#111);white-space:nowrap;font-size:11.5px">${fmtDate(r.txn_date)}</td>
        <td style="${cell}"><span class="${srcClass}">${srcLabel}</span></td>
        <td style="${cell}"><span class="txn-type-pill txn-${r.txn_type}">${txnLabel(r.txn_type)}</span></td>
        <td style="${cell};text-align:right;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;color:var(--htxtb,#111)">${fmt(r.qty)}</td>
        <td style="${cell};color:var(--hmuted2,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px" title="${(vnoHtml+' '+(remarksText||'')).trim()}">${vnoHtml}${remarksText||'—'}</td>
        <td style="${cell};color:var(--muted,#9ca3af);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.created_by||'—'}</td>
      </tr>`;
    }).join('');
  renderPag('idmTxnPag', 'idmTxn', p.total, p.pages, p.page);
}


// ── deleteIdmTxn (originally L2483..L2494) ─────────────────────────
async function deleteIdmTxn(id, source){
  const isAuto = _detailProductId && true; // always confirm
  if(!confirm(`Delete this ${source} transaction?\n${source==='floor'&&id?'Note: if this is an auto-mirror entry, deleting it is safe.':''}\n\nThis cannot be undone.`)) return;
  const res  = await fetch('/api/pm_stock/delete_txn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,source})});
  const data = await res.json();
  if(data.status==='ok'){
    showToast('Transaction deleted','success');
    await loadSummary();
    loadItemMonthTxns(); // refresh the modal table
  } else { showToast(data.message||'Error','error'); }
}


// ── saveTxnEdit (originally L2495..L2518) ─────────────────────────
async function saveTxnEdit() {
  const id      = document.getElementById('et-id').value;
  const source  = document.getElementById('et-source').value;
  const qty     = parseFloat(document.getElementById('et-qty').value);
  const txnDate = document.getElementById('et-date').value;
  const remarks = document.getElementById('et-remarks').value.trim();
  if(!qty||qty<=0){showToast('Enter a valid quantity','error');return;}
  const res=await fetch('/api/pm_stock/update_txn',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id,source,qty,txn_date:txnDate,remarks})});
  const data=await res.json();
  if(data.status==='ok'){
    showToast('✓ Transaction updated','success');
    closeModal('editTxnModal');
    // Update local log rows live
    const row=_logRows.find(r=>r.id==id);
    if(row){row.qty=qty;row.txn_date=txnDate;row.remarks=remarks;}
    renderLog(_logRows);
    await loadSummary();
  } else { showToast(data.message||'Error','error'); }
}

/* ═══════════════════════════════════════════════════════════
   DOUBLE-CLICK EDIT — PRODUCTS
═══════════════════════════════════════════════════════════ */

