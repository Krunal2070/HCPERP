/* pm_stock_stockview.js — Stock View, godown sub-tabs, ledger, alerts */

// ── loadSummary (originally L409..L438) ─────────────────────────
async function loadSummary() {
  const godownId = document.getElementById('gl-location')?.value || '';
  const params = new URLSearchParams({
    search:    document.getElementById('sv-search')?.value||'',
    pm_type:   document.getElementById('sv-pm-type')?.value||'',
    from_date: document.getElementById('sv-from-date')?.value||'',
    to_date:   document.getElementById('sv-to-date')?.value||'',
    brand_id:  document.getElementById('sv-brand')?.value||'',
    godown_id: godownId,
  });
  const gt = document.getElementById('godownTbody');
  const ft = document.getElementById('floorTbody');
  if(gt) gt.innerHTML=`<tr class="loading-row"><td colspan="8"><span class="spinner"></span> Loading…</td></tr>`;
  if(ft) ft.innerHTML=`<tr class="loading-row"><td colspan="9"><span class="spinner"></span> Loading…</td></tr>`;
  const res = await fetch('/api/pm_stock/summary?'+params);
  _summary  = await res.json();
  // Reset to page 1 on every fresh load
  _pag.godown.page = 1;
  _pag.floor.page  = 1;
  renderSummary();
  updateStats();
  if(document.getElementById('tab-combined')?.classList.contains('active')) renderCombined();
  checkLowStockAlerts();
}

/* ═══════════════════════════════════════════════════════════
   PM GRN — Goods Receipt Note
═══════════════════════════════════════════════════════════ */
let _grnItemCount = 0;


// ── renderSummary (originally L1407..L1528) ─────────────────────────
function renderSummary() {
  const stockFilter = document.getElementById('sv-stock-filter')?.value || '';

  // ── Godown ── apply stock filter before pagination
  let gRows = (_summary||[]).slice();
  if(stockFilter === 'negative')    gRows = gRows.filter(r => r.godown_stock < 0);
  if(stockFilter === 'nonzero')     gRows = gRows.filter(r => r.godown_stock > 0);
  if(stockFilter === 'zero')        gRows = gRows.filter(r => r.godown_stock <= 0);
  if(stockFilter === 'has_inward')  gRows = gRows.filter(r => r.inward > 0);
  if(stockFilter === 'has_outward') gRows = gRows.filter(r => r.outward > 0);
  if(stockFilter === 'has_movement')gRows = gRows.filter(r => r.inward > 0 || r.outward > 0);

  const {slice:gSlice, total:gTotal, pages:gPages, page:gPage, start:gStart} = paginate(gRows,'godown');
  const gTbody = document.getElementById('godownTbody');
  if(!gRows.length){
    const totalItems = (_summary||[]).length;
    let reason = '<i class="fas fa-box"></i> No data';
    if(totalItems > 0 && stockFilter) {
      const filterLabels = {
        negative:     'Negative Stock (godown_stock < 0)',
        nonzero:      'Stock > 0 (godown_stock > 0)',
        zero:         'Stock = 0 (godown_stock ≤ 0)',
        has_inward:   'Has Inward',
        has_outward:  'Has Outward',
        has_movement: 'Any Movement'
      };
      const lbl = filterLabels[stockFilter] || stockFilter;
      reason = `<i class="fas fa-filter" style="color:var(--floor-clr,#d97706)"></i>
        <strong>Stock filter "${lbl}" returned 0 rows</strong><br>
        <span style="font-size:11px;color:var(--muted,#9ca3af)">
          ${totalItems} product(s) loaded but none matched this filter.<br>
          <a href="#" onclick="const sf=document.getElementById('sv-stock-filter');if(sf){sf.value='';renderSummary();}return false;"
             style="color:var(--teal,#0d9488);text-decoration:underline;font-weight:700">Clear Stock filter →</a>
        </span>`;
    }
    gTbody.innerHTML=`<tr><td colspan="10" class="no-data">${reason}</td></tr>`;
    document.getElementById('godownPag').innerHTML='';
  } else {
    gTbody.innerHTML = gSlice.map(r=>{
      const chip=stockChip(r.godown_stock);
      const sel=!!_selectedRows[r.id+'_godown'];
      const brandBadge = r.brand_name ? `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${r.brand_color||'#5E35B1'}22;color:${r.brand_color||'#5E35B1'};border:1px solid ${r.brand_color||'#5E35B1'}44">${r.brand_name}</span>` : '<span style="color:var(--hmuted,#9ca3af);font-size:10px">—</span>';
      return `<tr class="dbl-hint${sel?' selected-row':''}" ondblclick="openTxnLedger(${r.id})" title="Double-click to view transaction ledger">
        <td><input type="checkbox" class="row-select" data-id="${r.id}" data-type="godown"
          onchange="onRowCheck(this,${r.id},'godown',${JSON.stringify(r).replace(/"/g,'&quot;')})"
          ${sel?'checked':''} style="accent-color:var(--brand)"></td>
        <td>${brandBadge}</td>
        <td class="td-name">${r.product_name}</td>
        <td><span class="pm-badge">${r.pm_type}</span></td>
        <td class="num">${fmt(r.op)}</td>
        <td class="num pos">${fmt(r.inward)}</td>
        <td class="num neu">${fmt(r.outward)}</td>
        <td class="num">${chip}</td>
        <td class="num" style="font-size:11px;color:${r.min_stock>0?'var(--floor-clr,#d97706)':'var(--muted,#9ca3af)'}">${r.min_stock>0?fmt(r.min_stock):'—'}</td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af);white-space:nowrap">${fmtDate(r.godown_last_txn)||'—'}</td>
      </tr>`;
    }).join('');
    renderPag('godownPag','godown',gTotal,gPages,gPage);
  }

  // ── Floor ── apply stock filter before pagination
  let fRows = (_summary||[]).slice();
  if(stockFilter === 'negative')    fRows = fRows.filter(r => r.remaining < 0);
  if(stockFilter === 'nonzero')     fRows = fRows.filter(r => r.remaining > 0);
  if(stockFilter === 'zero')        fRows = fRows.filter(r => r.remaining <= 0);
  if(stockFilter === 'has_inward')  fRows = fRows.filter(r => r.issue > 0);
  if(stockFilter === 'has_outward') fRows = fRows.filter(r => r.dispatch > 0);
  if(stockFilter === 'has_movement')fRows = fRows.filter(r => r.issue > 0 || r.dispatch > 0);

  const {slice:fSlice, total:fTotal, pages:fPages, page:fPage} = paginate(fRows,'floor');
  const fTbody = document.getElementById('floorTbody');
  if(!fRows.length){
    // Show informative empty-state message explaining WHY no rows match
    const totalFloorItems = (_summary||[]).length;
    let reason = '<i class="fas fa-box"></i> No data';
    if(totalFloorItems > 0 && stockFilter) {
      const filterLabels = {
        negative:     'Negative Stock (remaining < 0)',
        nonzero:      'Stock > 0 (remaining > 0)',
        zero:         'Stock = 0 (remaining ≤ 0)',
        has_inward:   'Has Inward',
        has_outward:  'Has Outward',
        has_movement: 'Any Movement'
      };
      const lbl = filterLabels[stockFilter] || stockFilter;
      reason = `<i class="fas fa-filter" style="color:var(--floor-clr,#d97706)"></i>
        <strong>Stock filter "${lbl}" returned 0 rows</strong><br>
        <span style="font-size:11px;color:var(--muted,#9ca3af)">
          ${totalFloorItems} product(s) loaded but none matched this filter.<br>
          <a href="#" onclick="const sf=document.getElementById('sv-stock-filter');if(sf){sf.value='';renderSummary();}return false;"
             style="color:var(--teal,#0d9488);text-decoration:underline;font-weight:700">Clear Stock filter →</a>
        </span>`;
    } else if(totalFloorItems === 0) {
      reason = `<i class="fas fa-box"></i> No products loaded. Check date filters or refresh.`;
    }
    fTbody.innerHTML=`<tr><td colspan="11" class="no-data">${reason}</td></tr>`;
    document.getElementById('floorPag').innerHTML='';
  } else {
    fTbody.innerHTML = fSlice.map(r=>{
      const chip=stockChip(r.remaining,'floor');
      const sel=!!_selectedRows[r.id+'_floor'];
      const fBrandBadge = r.brand_name ? `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${r.brand_color||'#5E35B1'}22;color:${r.brand_color||'#5E35B1'};border:1px solid ${r.brand_color||'#5E35B1'}44">${r.brand_name}</span>` : '<span style="color:var(--hmuted,#9ca3af);font-size:10px">—</span>';
      return `<tr class="dbl-hint${sel?' selected-row':''}" ondblclick="openTxnLedger(${r.id})" title="Double-click to view transaction ledger">
        <td><input type="checkbox" class="row-select" data-id="${r.id}" data-type="floor"
          onchange="onRowCheck(this,${r.id},'floor',${JSON.stringify(r).replace(/"/g,'&quot;')})"
          ${sel?'checked':''} style="accent-color:var(--brand)"></td>
        <td>${fBrandBadge}</td>
        <td class="td-name">${r.product_name}</td>
        <td><span class="pm-badge">${r.pm_type}</span></td>
        <td class="num">${fmt(r.floor_op)}</td>
        <td class="num pos">${fmt(r.issue)}</td>
        <td class="num pos">${fmt(r.dispatch)}</td>
        <td class="num neg">${fmt(r.rejection)}</td>
        <td class="num">${fmt(r.pm_return)}</td>
        <td class="num">${chip}</td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af);white-space:nowrap">${fmtDate(r.floor_last_txn)||'—'}</td>
      </tr>`;
    }).join('');
    renderPag('floorPag','floor',fTotal,fPages,fPage);
  }
}


// ── updateStats (originally L1529..L1542) ─────────────────────────
function updateStats() {
  const totalGodown=_summary.reduce((s,r)=>s+r.godown_stock,0);
  const totalInward=_summary.reduce((s,r)=>s+r.inward,0);
  const totalFloor =_summary.reduce((s,r)=>s+r.remaining,0);
  const totalDisp  =_summary.reduce((s,r)=>s+r.dispatch,0);
  const totalRej   =_summary.reduce((s,r)=>s+r.rejection,0);
  document.getElementById('statGodownItems').textContent =_summary.length;
  document.getElementById('statInward').textContent      =fmtBig(totalInward);
  document.getElementById('statFloorItems').textContent  =_summary.filter(r=>r.remaining>0).length;
  document.getElementById('statDispatched').textContent  =fmtBig(totalDisp);
  document.getElementById('statTotalStock').textContent  =fmtBig(totalGodown+totalFloor);
  document.getElementById('statRejections').textContent  =fmtBig(totalRej);
}


// ── stockChip (originally L1543..L1547) ─────────────────────────
function stockChip(val){
  const cls = val < 0 ? 'negative' : val > 100 ? 'ok' : val > 0 ? 'warn' : 'danger';
  const label = val < 0 ? `⚠ ${fmt(val)}` : fmt(val);
  return `<span class="stock-chip ${cls}" ${val<0?'title="Negative stock — check transactions"':''}>${label}</span>`;
}

// ── clearStockFilters (originally L1548..L1560) ─────────────────────────
function clearStockFilters(){
  document.getElementById('sv-search').value='';
  document.getElementById('sv-pm-type').value='';
  const fd=document.getElementById('sv-from-date'); if(fd) fd.value='';
  document.getElementById('sv-to-date').value=new Date().toISOString().slice(0,10);
  const sb=document.getElementById('sv-brand'); if(sb) sb.value='';
  const sf=document.getElementById('sv-stock-filter'); if(sf) sf.value='';
  loadSummary();
}

/* ═══════════════════════════════════════════════════════════
   GODOWN ENTRY SAVE — LIVE UPDATE
═══════════════════════════════════════════════════════════ */

// ── saveGodownEntry (originally L1561..L1590) ─────────────────────────
async function saveGodownEntry() {
  const productId=parseInt(document.getElementById('ge-product-id').value);
  const txnType  =document.getElementById('ge-txn-type').value;
  const qty      =parseFloat(document.getElementById('ge-qty').value);
  const date     =document.getElementById('ge-date').value;
  const remarks  =document.getElementById('ge-remarks').value.trim();
  if(!productId){showToast('Please select a product','error');return;}
  if(!qty||qty<=0){showToast('Enter a valid quantity','error');return;}
  // Stock validation warning
  if(txnType==='outward'){
    const sr=_summary.find(s=>s.id===productId);
    if(sr && qty > sr.godown_stock){
      const over = fmt(qty - sr.godown_stock);
      const avail = fmt(sr.godown_stock);
      if(!confirm(`⚠️ Stock warning\n\nIssuing ${fmt(qty)} but only ${avail} available in godown.\nThis will result in ${over} over-issue.\n\nContinue anyway?`)) return;
    }
  }
  const res=await fetch('/api/pm_stock/godown/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({product_id:productId,txn_type:txnType,qty,txn_date:date,remarks,godown_id:_getEntryGodownId('ge')})});
  const data=await res.json();
  if(data.status==='ok'){
    const qtyFmt = fmt(qty);
    const vno = data.voucher_no ? ` [${data.voucher_no}]` : '';
    showToast(txnType==='outward'?`✓ Godown: Issued ${qtyFmt} to Factory — both sides updated${vno}`:`✓ Godown entry saved${vno}`,'success');
    clearGodownForm();
    await loadSummary(); // live update
    if(document.getElementById('tab-log').classList.contains('active')) loadLog();
  } else { showToast(data.message||'Error','error'); }
}


// ── clearGodownForm (originally L1591..L1605) ─────────────────────────
function clearGodownForm(){
  ['ge-product-search','ge-qty','ge-remarks'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('ge-product-id').value='';
  document.getElementById('ge-product-preview').style.display='none';
  const list=document.getElementById('ge-product-list');
  if(list){list.classList.remove('open');list.innerHTML='';}
  document.getElementById('ge-txn-type').value='opening';
  document.getElementById('ge-date').value=new Date().toISOString().slice(0,10);
  const gCtx=document.getElementById('ge-stock-context'); if(gCtx) gCtx.style.display='none';
  const geGdn=document.getElementById('ge-godown'); if(geGdn) geGdn.value='';
}

/* ═══════════════════════════════════════════════════════════
   FLOOR ENTRY SAVE — LIVE UPDATE
═══════════════════════════════════════════════════════════ */

// ── saveFloorEntry (originally L1606..L1635) ─────────────────────────
async function saveFloorEntry() {
  const productId=parseInt(document.getElementById('fe-product-id').value);
  const txnType  =document.getElementById('fe-txn-type').value;
  const qty      =parseFloat(document.getElementById('fe-qty').value);
  const date     =document.getElementById('fe-date').value;
  const remarks  =document.getElementById('fe-remarks').value.trim();
  if(!productId){showToast('Please select a product','error');return;}
  if(!qty||qty<=0){showToast('Enter a valid quantity','error');return;}
  // Stock validation warning for dispatch and pm_return
  if(txnType==='dispatch'||txnType==='rejection'){
    const sr=_summary.find(s=>s.id===productId);
    if(sr && qty > sr.remaining){
      const over = fmt(qty - sr.remaining);
      const avail = fmt(sr.remaining);
      if(!confirm(`⚠️ Stock warning\n\n${txnType==='dispatch'?'Dispatching':'Rejecting'} ${fmt(qty)} but only ${avail} remaining in factory.\nThis will result in ${over} over-${txnType==='dispatch'?'dispatch':'rejection'}.\n\nContinue anyway?`)) return;
    }
  }
  const res=await fetch('/api/pm_stock/floor/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({product_id:productId,txn_type:txnType,qty,txn_date:date,remarks,godown_id:_getEntryGodownId('fe')})});
  const data=await res.json();
  if(data.status==='ok'){
    const qtyFmtF = fmt(qty);
    const vno = data.voucher_no ? ` [${data.voucher_no}]` : '';
    showToast(txnType==='pm_return'?`✓ Factory: Returned ${qtyFmtF} to Godown — both sides updated${vno}`:`✓ Factory entry saved${vno}`,'success');
    clearFloorForm();
    await loadSummary(); // live update
    if(document.getElementById('tab-log').classList.contains('active')) loadLog();
  } else { showToast(data.message||'Error','error'); }
}


// ── clearFloorForm (originally L1636..L1650) ─────────────────────────
function clearFloorForm(){
  ['fe-product-search','fe-qty','fe-remarks'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('fe-product-id').value='';
  document.getElementById('fe-product-preview').style.display='none';
  const list=document.getElementById('fe-product-list');
  if(list){list.classList.remove('open');list.innerHTML='';}
  document.getElementById('fe-txn-type').value='floor_opening';
  document.getElementById('fe-date').value=new Date().toISOString().slice(0,10);
  const fCtx=document.getElementById('fe-stock-context'); if(fCtx) fCtx.style.display='none';
  const feGdn=document.getElementById('fe-godown'); if(feGdn) feGdn.value='';
}

/* ═══════════════════════════════════════════════════════════
   TRANSACTION LOG
═══════════════════════════════════════════════════════════ */

// ── buildGodownTabs (originally L1914..L1962) ─────────────────────────
function buildGodownTabs() {
  const container = document.getElementById('sv-godown-tabs');
  if(!container) return;
  // Exclude floor locations (Factory), billing, shipping
  // FACTORY has godown_type='godown' in DB but is_floor flag OR name contains FACTORY
  // We also explicitly hide any storage row literally named "FACTORY" — the real
  // factory inventory lives in the "🏭 Factory Stock" tab (floor view), so a
  // storage tab with the same name is redundant and confusing.
  let storage = (_godowns||[]).filter(g => {
    if(g.godown_type === 'floor' || g.godown_type === 'billing' || g.godown_type === 'shipping') return false;
    if(g.is_floor) return false;
    if((g.name||'').trim().toUpperCase() === 'FACTORY') return false;
    return true;
  });
  // Sort: "NEW BHAYLA GODOWN" first (the active warehouse), then everything else alphabetically.
  storage.sort((a, b) => {
    const an = (a.name||'').toUpperCase();
    const bn = (b.name||'').toUpperCase();
    const aIsNew = an.includes('NEW BHAYLA');
    const bIsNew = bn.includes('NEW BHAYLA');
    if(aIsNew && !bIsNew) return -1;
    if(bIsNew && !aIsNew) return  1;
    return an.localeCompare(bn);
  });
  // Rebuild all buttons: one per storage godown + Factory floor tab
  container.innerHTML = '';
  storage.forEach((g, idx) => {
    const btn = document.createElement('button');
    btn.id = `sv-tab-gd-${g.id}`;
    btn.dataset.godownId = g.id;
    btn.style.cssText = `padding:6px 18px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none;
      background:${idx===0?'var(--godown-clr)':'transparent'};color:${idx===0?'#fff':'var(--hmuted2,#6b7280)'};
      font-family:var(--font-body);transition:0.15s`;
    btn.textContent = `🏢 ${g.name}${g.city?', '+g.city:''}`;
    btn.onclick = () => switchStockTabGodown(g.id);
    container.appendChild(btn);
  });
  // Factory tab — always one, always last
  const fBtn = document.createElement('button');
  fBtn.id = 'sv-tab-floor';
  fBtn.dataset.godownId = '';
  fBtn.style.cssText = 'padding:6px 18px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none;background:transparent;color:var(--hmuted2,#6b7280);font-family:var(--font-body);transition:0.15s';
  fBtn.textContent = '🏭 Factory Stock';
  fBtn.onclick = () => switchStockTab('floor');
  container.appendChild(fBtn);
  // Activate first godown tab by default
  if(storage.length) switchStockTabGodown(storage[0].id);
}


let _stockTab = 'godown';   // moved here from pm_stock_main.js

// ── switchStockTabGodown (originally L1963..L1989) ─────────────────────────
function switchStockTabGodown(godownId) {
  // Highlight the clicked tab button
  const container = document.getElementById('sv-godown-tabs');
  if(container) {
    container.querySelectorAll('button').forEach(b => {
      const isThis = String(b.dataset.godownId) === String(godownId);
      b.style.background = isThis ? 'var(--godown-clr)' : 'transparent';
      b.style.color      = isThis ? '#fff' : 'var(--hmuted2,#6b7280)';
    });
  }
  // Show godown panel, hide floor
  const gp = document.getElementById('sv-panel-godown');
  const fp = document.getElementById('sv-panel-floor');
  if(gp) gp.style.display = '';
  if(fp) fp.style.display = 'none';
  // *** Update the GLOBAL location filter — this is what loadSummary reads ***
  const glLoc = document.getElementById('gl-location');
  if(glLoc) glLoc.value = String(godownId);
  window._activeStockGodownId = godownId;
  loadSummary();
}

/* ═══════════════════════════════════════════════════════════
   COMBINED TAB — per-godown breakdown
═══════════════════════════════════════════════════════════ */
let _perGodownData = null; // cached response from /api/pm_stock/summary/per_godown


// ── switchStockTab (originally L4355..L4405) ─────────────────────────
function switchStockTab(tab) {
  _stockTab = tab;
  const isGodown = tab === 'godown';

  const gPanel = document.getElementById('sv-panel-godown');
  const fPanel = document.getElementById('sv-panel-floor');
  if(gPanel) gPanel.style.display = isGodown ? '' : 'none';
  if(fPanel) fPanel.style.display = isGodown ? 'none' : '';

  // After buildGodownTabs() runs, sv-tab-godown / sv-tab-floor may be
  // replaced by dynamic buttons — null-guard both.
  const gBtn = document.getElementById('sv-tab-godown');
  const fBtn = document.getElementById('sv-tab-floor');
  if(gBtn) { gBtn.style.background = isGodown ? 'var(--godown-clr)' : 'transparent';
             gBtn.style.color      = isGodown ? '#fff' : 'var(--hmuted2,#6b7280)'; }
  if(fBtn) { fBtn.style.background = isGodown ? 'transparent' : 'var(--floor-clr)';
             fBtn.style.color      = isGodown ? 'var(--hmuted2,#6b7280)' : '#0f172a'; }

  // If switching to floor via dynamic tabs, deactivate all godown tab buttons
  const container = document.getElementById('sv-godown-tabs');
  if(container && !isGodown) {
    container.querySelectorAll('button[data-godown-id]:not([data-godown-id=""])').forEach(b => {
      b.style.background = 'transparent';
      b.style.color      = 'var(--hmuted2,#6b7280)';
    });
    // Highlight floor button
    if(fBtn) { fBtn.style.background='var(--floor-clr)'; fBtn.style.color='#0f172a'; }
  }

  // Sync location filter for godown tab
  const glLoc = document.getElementById('gl-location');
  if(glLoc && isGodown) {
    if(!glLoc.value) {
      const def = (_godowns||[]).find(g => g.is_default && g.godown_type !== 'floor' && !g.is_floor);
      if(def) { glLoc.value = String(def.id); onLocationChange(); }
    }
  }

  // Update Report button
  const rptBtn = document.getElementById('sv-report-btn');
  if(rptBtn){
    rptBtn.onclick = ()=>openReportModal(tab);
    rptBtn.style.background = isGodown ? 'rgba(14,165,233,0.12)' : 'rgba(245,158,11,0.12)';
    rptBtn.style.color      = isGodown ? 'var(--godown-clr)' : 'var(--floor-clr)';
    rptBtn.style.borderColor= isGodown ? 'rgba(14,165,233,0.3)' : 'rgba(245,158,11,0.3)';
  }
}

/* ═══════════════════════════════════════════════════════════
   BRAND MANAGEMENT
═══════════════════════════════════════════════════════════ */

// ── assignBrandToSelected (originally L4406..L4408) ─────────────────────────
async function assignBrandToSelected(clear=false){
  // legacy stub — brand assign now only from Products tab
}

// ── assignBrandToSelectedProds (originally L4409..L4456) ─────────────────────────
async function assignBrandToSelectedProds(clear=false){
  const ids = Object.keys(_selectedProd).map(Number);
  if(!ids.length){ showToast('Select products first','error'); return; }
  const brandId = clear ? null : parseInt(document.getElementById('prod-assign-brand').value)||null;
  if(!clear && !brandId){ showToast('Select a brand to assign','error'); return; }

  // ── Safety confirmation: show the exact count and a sample of names so
  //    accidental mass-overwrite (e.g. from a stale "Select All") is caught.
  const sampleNames = ids.slice(0, 5).map(i => {
    const p = _selectedProd[i] || _products.find(x => x.id === i);
    return p ? '• ' + p.product_name : '• (id ' + i + ')';
  }).join('\n');
  const more = ids.length > 5 ? `\n…and ${ids.length - 5} more` : '';
  const brandName = clear
    ? '(none — clearing brand)'
    : (_brands.find(b => b.id === brandId)?.name || '(unknown)');
  const confirmMsg =
    `${clear ? 'Clear brand from' : 'Assign brand "' + brandName + '" to'} ${ids.length} product(s)?\n\n` +
    `${sampleNames}${more}\n\n` +
    (ids.length > 50
      ? `⚠ This is a LARGE batch (${ids.length} products). Double-check the list above is what you intended.\n\n`
      : '') +
    `Click OK to proceed.`;
  if(!confirm(confirmMsg)) return;

  const res  = await fetch('/api/pm_stock/assign_brand',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      ids,
      brand_id: brandId,
      confirm_large_batch: ids.length > 500   // user already saw the count and approved
    })
  });
  const data = await res.json();
  if(data.status==='ok'){
    showToast(clear?`✓ Brand cleared from ${ids.length} product(s)`:`✓ Brand assigned to ${ids.length} product(s)`,'success');
    _selectedProd={};
    document.getElementById('prod-brand-bar').style.display='none';
    document.getElementById('prodDeleteBtn').style.display='none';
    var _pdp=document.getElementById('prodDeletePermBtn'); if(_pdp) _pdp.style.display='none';
    document.querySelectorAll('.row-select[data-grid="prod"]').forEach(cb=>cb.checked=false);
    document.getElementById('chkAllProd').checked=false;
    await loadProducts();
    await loadSummary();
  } else { showToast(data.message||'Error','error'); }
}

// Show/hide brand assign bar based on selection

// ── updateSvBrandBar (originally L4457..L4471) ─────────────────────────
function updateSvBrandBar(){
  // Products tab brand bar — shows when products are selected
  const prodCount = Object.keys(_selectedProd).length;
  const prodBar   = document.getElementById('prod-brand-bar');
  if(prodBar){
    prodBar.style.display = prodCount>0 ? 'flex' : 'none';
    const cnt = document.getElementById('prod-sel-count');
    if(cnt) cnt.textContent = prodCount;
  }
  // UOM assign bar (Phase 2) — same selection model.
  const uomBar = document.getElementById('prod-uom-bar');
  if(uomBar){
    uomBar.style.display = prodCount>0 ? 'flex' : 'none';
    const uomCnt = document.getElementById('prod-uom-sel-count');
    if(uomCnt) uomCnt.textContent = prodCount;
    // First time the bar appears, populate its UOM selects.
    if(prodCount>0 && !uomBar.dataset.populated){
      if(typeof _fillUomSelect === 'function'){
        _fillUomSelect(document.getElementById('prod-assign-primary-uom'), 'Nos', false);
        _fillUomSelect(document.getElementById('prod-assign-alt-uom'),     '',    true);
      }
      uomBar.dataset.populated = '1';
      if(typeof updateProdUomBar === 'function') updateProdUomBar();
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   PER-PRODUCT MIN STOCK THRESHOLD + DAILY ALERT
═══════════════════════════════════════════════════════════ */
// Called from inline input in Godown grid or Products grid

// ── saveInlineThreshold (originally L4472..L4494) ─────────────────────────
async function saveInlineThreshold(input){
  const productId = parseInt(input.dataset.pid);
  const minStock  = parseInt(input.value) || 0;
  if(!productId) return;

  const res  = await fetch('/api/pm_stock/set_min_stock',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({product_id: productId, min_stock: minStock})
  });
  const data = await res.json();
  if(data.status==='ok'){
    // Update local state
    const prod = _products.find(p=>p.id===productId);
    if(prod) prod.min_stock = minStock;
    const sr = _summary.find(s=>s.id===productId);
    if(sr) sr.min_stock = minStock;
    // Style input to reflect set state
    input.style.color = minStock>0 ? 'var(--floor-clr,#d97706)' : 'var(--hmuted,#9ca3af)';
    input.style.fontWeight = minStock>0 ? '700' : '400';
    showToast(minStock>0 ? `✓ Alert: notify when stock < ${fmt(minStock)}` : '✓ Alert cleared','success');
    checkLowStockAlerts(true);
  } else { showToast(data.message||'Error','error'); }
}

// ── saveProductThreshold (originally L4495..L4523) ─────────────────────────
async function saveProductThreshold(){
  const modal = document.getElementById('itemDetailModal');
  const productId = parseInt(modal?.dataset.productId);
  const minStock  = parseInt(document.getElementById('idm-min-stock').value) || 0;
  if(!productId){ showToast('No product selected','error'); return; }

  const res  = await fetch('/api/pm_stock/set_min_stock',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({product_id: productId, min_stock: minStock})
  });
  const data = await res.json();
  if(data.status==='ok'){
    // Update local _products and _summary
    const prod = _products.find(p=>p.id===productId);
    if(prod) prod.min_stock = minStock;
    const sr = _summary.find(s=>s.id===productId);
    if(sr) sr.min_stock = minStock;
    showToast(minStock>0 ? `✓ Alert set: notify when stock < ${fmt(minStock)}` : '✓ Alert cleared','success');
    // Re-run alert check immediately
    checkLowStockAlerts(true);
  } else { showToast(data.message||'Error','error'); }
}

/* Daily low-stock alert system
   - Checks once per day (stored date in localStorage)
   - Shows a dismissible panel listing all below-threshold items
   - Per-product dismissal stored: pm_dismissed_YYYYMMDD_productId
   - Auto-clears dismissal when stock goes above threshold
*/

// ── viewNegativeStock (originally L4524..L4540) ─────────────────────────
function viewNegativeStock(){
  // Switch to stock tab, set filter to zero/negative, reset pagination
  switchTab('stock');
  setSidebarActive('stock');
  const sf = document.getElementById('sv-stock-filter');
  if(sf){ sf.value = 'negative'; }
  switchStockTab('godown');
  _pag.godown.page = 1;
  _pag.floor.page  = 1;
  renderSummary();
}

/* ═══════════════════════════════════════════════════════════
   TXN LEDGER MODAL — opened by double-click on stock row
═══════════════════════════════════════════════════════════ */
let _tlmProductId = null;


// ── openTxnLedger (originally L4541..L4565) ─────────────────────────
function openTxnLedger(productId) {
  const r = _summary.find(s => s.id === productId);
  if(!r) return;
  _tlmProductId = productId;

  document.getElementById('tlm-name').textContent = r.product_name;
  document.getElementById('tlm-pm').textContent   = `${r.pm_type}${r.brand_name ? ' · ' + r.brand_name : ''}`;

  // Populate godown selector — pre-select currently active location filter
  const sel = document.getElementById('tlm-godown');
  const opts = (_godowns||[]).map(g =>
    `<option value="${g.id}">${godownLabel(g)}</option>`
  ).join('');
  sel.innerHTML = '<option value="">All Locations</option>' + opts;
  // Pre-select the global location filter if one is active
  const activeGodown = document.getElementById('gl-location')?.value || '';
  if(activeGodown) sel.value = activeGodown;

  // Clear month filter — load all
  document.getElementById('tlm-month').value = '';

  document.getElementById('txnLedgerModal').classList.add('open');
  loadTxnLedger();
}


/* ═══════════════════════════════════════════════════════════════════
   PM-GTXN / PM-FTXN VOUCHER DETAIL (admin only)
   ─────────────────────────────────────────────────────────────────
   Clicking a PG/... voucher badge in the per-product ledger opens
   this modal. Fetches the single godown_txn row + linked product /
   godown context, renders read-only fields with an Edit toggle that
   reveals qty / date / remarks inputs and a Save button. A Delete
   button (admin-confirm) removes the row entirely.

   Note on PF/... (floor_txn): we ALSO route PF clicks here for now —
   the backend endpoint only covers godown_txn, but PF rows will show
   a clear "no detail available" message rather than break. Future
   work can add a parallel /api/pm_stock/floor_txn/<id> endpoint.
   ─────────────────────────────────────────────────────────────── */
let _gvdState = { id: null, source: null, voucher: null };

async function openGodownTxnDetail(txnId, source) {
  _gvdState = { id: txnId, source: source || 'godown', voucher: null };
  const modal = document.getElementById('gvDetailModal');
  if(!modal) { showToast('Voucher detail modal not loaded', 'error'); return; }
  modal.classList.add('open');
  // Reset header + body to a fresh loading state
  document.getElementById('gvd-title').textContent = 'Loading…';
  document.getElementById('gvd-body').innerHTML =
    `<div style="text-align:center;color:var(--hmuted,#9ca3af);padding:30px 0">
       <span class="spinner"></span> Loading voucher…
     </div>`;
  document.getElementById('gvd-footer').innerHTML =
    `<button class="btn btn-outline btn-sm" onclick="closeModal('gvDetailModal')">Close</button>`;

  // PF rows have no detail endpoint yet — show a friendly message.
  if(source === 'floor') {
    document.getElementById('gvd-title').textContent = 'Floor Voucher';
    document.getElementById('gvd-body').innerHTML =
      `<div style="padding:18px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px;color:#92400e;line-height:1.5">
         <div style="font-weight:700;margin-bottom:6px">⚠️ No direct edit available</div>
         <div style="font-size:12px">PF (floor transaction) vouchers are created as side effects of GRN / DN / Allotment vouchers. Edit those source vouchers instead — this floor row will update automatically.</div>
       </div>`;
    return;
  }

  try {
    const res = await fetch(`/api/pm_stock/godown_txn/${txnId}`);
    const j   = await res.json();
    if(j.status !== 'ok') {
      document.getElementById('gvd-body').innerHTML =
        `<div style="color:#dc2626;padding:14px;background:rgba(239,68,68,.06);border-radius:8px;
                     border:1px solid rgba(239,68,68,.2)">${j.message || 'Failed to load voucher'}</div>`;
      return;
    }
    _gvdState.voucher = j.voucher;
    _gvdRender(j.voucher);
  } catch(e) {
    document.getElementById('gvd-body').innerHTML =
      `<div style="color:#dc2626">Network error: ${e.message}</div>`;
  }
}

function _gvdRender(v) {
  document.getElementById('gvd-title').textContent = v.voucher_no || `Voucher #${v.id}`;

  const typeLabel = ({
    'opening':   'Opening Balance',
    'inward':    'Inward (godown receipt)',
    'outward':   'Outward (godown issue)',
  })[v.txn_type] || v.txn_type;

  const typeColor = ({
    'opening':   '#0d9488',
    'inward':    '#16a34a',
    'outward':   '#dc2626',
  })[v.txn_type] || '#6b7280';

  // Format qty with sign indicator
  const qtyNum = parseFloat(v.qty) || 0;
  const qtyStr = qtyNum.toLocaleString('en-IN', {maximumFractionDigits: 3});
  const qtyPrefix = v.txn_type === 'outward' ? '−' : '+';

  // Field row helper — label + value, fixed width
  const R = (label, value, extra = '') =>
    `<div style="display:grid;grid-template-columns:130px 1fr;gap:10px;padding:8px 0;
                  border-bottom:1px solid rgba(0,0,0,.05);align-items:start">
       <div style="font-size:10.5px;font-weight:700;color:var(--hmuted2,#6b7280);
                   text-transform:uppercase;letter-spacing:.5px;padding-top:2px">${label}</div>
       <div style="font-size:12.5px;color:#0f172a;${extra}">${value}</div>
     </div>`;

  document.getElementById('gvd-body').innerHTML = `
    <div style="margin-bottom:14px">
      <div style="display:inline-block;padding:3px 10px;border-radius:6px;
                  font-size:10.5px;font-weight:800;letter-spacing:.4px;
                  color:${typeColor};background:${typeColor}15;border:1px solid ${typeColor}33">
        ${typeLabel.toUpperCase()}
      </div>
    </div>
    <div id="gvd-readonly">
      ${R('Voucher #', `<code style="font-size:12px">${v.voucher_no || '—'}</code>`)}
      ${R('Product',   v.product_name + (v.product_code ? ` <span style="color:#9ca3af">· ${v.product_code}</span>` : ''))}
      ${R('Godown',    v.godown_name || '<i style="color:#9ca3af">—</i>')}
      ${R('Date',      v.txn_date)}
      ${R('Quantity',  `<span style="font-weight:800;color:${typeColor};font-size:14px">${qtyPrefix}${qtyStr}</span>`)}
      ${R('Remarks',   v.remarks ? _escHtmlSafe(v.remarks) : '<i style="color:#9ca3af">—</i>')}
      ${R('Created by',v.created_by || '<i style="color:#9ca3af">—</i>')}
    </div>
    <div id="gvd-editform" style="display:none">
      <div style="margin-bottom:10px;font-size:11px;color:#92400e;padding:8px 12px;
                   background:rgba(245,158,11,.08);border-radius:6px;border:1px solid rgba(245,158,11,.2)">
        Edit qty / date / remarks. Other fields are immutable.
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:10.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Quantity</label>
        <input type="number" step="0.001" id="gvd-edit-qty" value="${qtyNum}"
               style="width:100%;padding:8px 10px;border:1.5px solid rgba(0,0,0,.15);border-radius:7px;font-size:13px;font-family:var(--font-mono,monospace)">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:10.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Date</label>
        <input type="date" id="gvd-edit-date" value="${v.txn_date}"
               style="width:100%;padding:8px 10px;border:1.5px solid rgba(0,0,0,.15);border-radius:7px;font-size:13px">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:10.5px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Remarks</label>
        <textarea id="gvd-edit-remarks" rows="2"
                  style="width:100%;padding:8px 10px;border:1.5px solid rgba(0,0,0,.15);border-radius:7px;font-size:12.5px;font-family:inherit;resize:vertical">${_escHtmlSafe(v.remarks || '')}</textarea>
      </div>
    </div>
  `;

  // Footer: Edit / Delete / Save+Cancel buttons
  document.getElementById('gvd-footer').innerHTML = `
    <button id="gvd-btn-delete" class="btn btn-sm" onclick="_gvdDelete()"
            style="background:rgba(239,68,68,.1);color:#dc2626;border:1.5px solid rgba(239,68,68,.3)">
      🗑️ Delete
    </button>
    <div style="flex:1"></div>
    <button id="gvd-btn-edit" class="btn btn-sm" onclick="_gvdToggleEdit(true)"
            style="background:rgba(13,148,136,.1);color:#0d9488;border:1.5px solid rgba(13,148,136,.3)">
      ✏️ Edit
    </button>
    <button id="gvd-btn-save" class="btn btn-sm" onclick="_gvdSave()" style="display:none;
            background:#0d9488;color:#fff;border:1.5px solid #0d9488">
      💾 Save
    </button>
    <button id="gvd-btn-cancel" class="btn btn-outline btn-sm" onclick="_gvdToggleEdit(false)" style="display:none">
      Cancel
    </button>
    <button class="btn btn-outline btn-sm" onclick="closeModal('gvDetailModal')">Close</button>
  `;
}

function _gvdToggleEdit(editing) {
  document.getElementById('gvd-readonly').style.display = editing ? 'none' : '';
  document.getElementById('gvd-editform').style.display = editing ? '' : 'none';
  document.getElementById('gvd-btn-edit').style.display   = editing ? 'none' : '';
  document.getElementById('gvd-btn-delete').style.display = editing ? 'none' : '';
  document.getElementById('gvd-btn-save').style.display   = editing ? '' : 'none';
  document.getElementById('gvd-btn-cancel').style.display = editing ? '' : 'none';
}

async function _gvdSave() {
  if(!_gvdState.id) return;
  const qty     = parseFloat(document.getElementById('gvd-edit-qty').value);
  const date    = document.getElementById('gvd-edit-date').value;
  const remarks = document.getElementById('gvd-edit-remarks').value.trim();
  if(!qty || isNaN(qty)) { showToast('Enter a valid qty (cannot be zero)', 'error'); return; }
  if(!date)              { showToast('Date is required', 'error'); return; }
  try {
    const res = await fetch(`/api/pm_stock/godown_txn/${_gvdState.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ qty, txn_date: date, remarks }),
    });
    const j = await res.json();
    if(j.status !== 'ok') { showToast(j.message || 'Save failed', 'error'); return; }
    showToast('✓ Voucher updated', 'success');
    closeModal('gvDetailModal');
    // Reload the ledger so the change is visible
    if(typeof loadTxnLedger === 'function') loadTxnLedger();
    if(typeof loadSummary    === 'function') loadSummary();
  } catch(e) {
    showToast('Network error: ' + e.message, 'error');
  }
}

async function _gvdDelete() {
  if(!_gvdState.id) return;
  const v = _gvdState.voucher;
  const vno = v?.voucher_no || `#${_gvdState.id}`;
  if(!confirm(`Delete voucher ${vno}?\n\n` +
              `This permanently removes the row from pm_godown_txn. Stock balances will recalculate on the next page load.\n\n` +
              `Type-confirm not required, but this CANNOT be undone.`)) return;
  try {
    const res = await fetch(`/api/pm_stock/godown_txn/${_gvdState.id}`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ confirm: 'DELETE' }),
    });
    const j = await res.json();
    if(j.status !== 'ok') { showToast(j.message || 'Delete failed', 'error'); return; }
    showToast(`✓ Voucher ${vno} deleted`, 'success');
    closeModal('gvDetailModal');
    if(typeof loadTxnLedger === 'function') loadTxnLedger();
    if(typeof loadSummary    === 'function') loadSummary();
  } catch(e) {
    showToast('Network error: ' + e.message, 'error');
  }
}

function _escHtmlSafe(s) {
  return String(s||'').replace(/[<>&"']/g, c =>
    ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

// Expose for the inline onclick on voucher badges
window.openGodownTxnDetail = openGodownTxnDetail;
window._gvdToggleEdit = _gvdToggleEdit;
window._gvdSave       = _gvdSave;
window._gvdDelete     = _gvdDelete;


// ── loadTxnLedger (originally L4566..L4765) ─────────────────────────
async function loadTxnLedger() {
  if(!_tlmProductId) return;
  const ym = document.getElementById('tlm-month').value;
  let fromDate = '', toDate = '';
  if(ym) {
    const [yr, mo] = ym.split('-');
    fromDate = `${yr}-${mo}-01`;
    const lastDay = new Date(parseInt(yr), parseInt(mo), 0).getDate();
    toDate = `${yr}-${mo}-${String(lastDay).padStart(2,'0')}`;
  }

  const tbody = document.getElementById('tlm-tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;

  try {
    const params = new URLSearchParams({
      from_date: fromDate, to_date: toDate,
      source: 'all', search: '', pm_type: '',
      product_id: String(_tlmProductId),
      godown_id: document.getElementById('tlm-godown')?.value || '',
    });
    const res  = await fetch('/api/pm_stock/transactions?' + params);
    let rows = await res.json();

    // Sort oldest first for running balance
    rows.sort((a, b) => {
      const d = (a.txn_date||'').localeCompare(b.txn_date||'');
      return d !== 0 ? d : (a.id||0) - (b.id||0);
    });

    // ── Collapse self-transfer pairs ─────────────────────────────────────
    // When a transfer voucher's source == destination (a self-transfer at
    // the same godown), both legs land in pm_floor_txn / pm_godown_txn at
    // the SAME godown_id, producing one IN row and one OUT row tagged with
    // identical [PM-MT:VNO] remarks. That's a no-op stock-wise but it
    // doubles the Inward / Outward totals and clutters the ledger.
    //
    // Strategy: detect such pairs by voucher_no + same godown + opposite
    // signs, and merge them into a single annotated row with qty=0.
    const _PMMT_RE = /\[PM-MT:([^\]]+)\]\s*(IN|OUT)/i;
    const _byVoucher = new Map(); // vno → { godown_id → [rows] }
    rows.forEach(r => {
      const m = (r.remarks||'').match(_PMMT_RE);
      if(!m) return;
      const vno = m[1];
      const gid = String(r.godown_id||'');
      if(!_byVoucher.has(vno)) _byVoucher.set(vno, new Map());
      const g = _byVoucher.get(vno);
      if(!g.has(gid)) g.set(gid, []);
      g.get(gid).push(r);
    });
    const _selfXferIds = new Set();
    _byVoucher.forEach((gMap) => {
      gMap.forEach(arr => {
        if(arr.length < 2) return;
        const ins  = arr.filter(r => /\sIN\b/i.test(r.remarks||''));
        const outs = arr.filter(r => /\sOUT\b/i.test(r.remarks||''));
        // Pair them up: each (IN, OUT) with matching qty becomes one collapsed row
        ins.forEach(inRow => {
          if(_selfXferIds.has(inRow.id)) return;
          const inQty = parseFloat(inRow.qty)||0;
          const match = outs.find(o =>
            !_selfXferIds.has(o.id) &&
            Math.abs((parseFloat(o.qty)||0) - inQty) < 0.001
          );
          if(match) {
            // Drop the OUT row, mark the IN row as a self-transfer (qty=0)
            _selfXferIds.add(match.id);
            inRow._selfTransfer = true;
            inRow._origQty = inQty;
            inRow.qty = 0;
            inRow.txn_type = 'self_transfer';
          }
        });
      });
    });
    if(_selfXferIds.size) {
      rows = rows.filter(r => !_selfXferIds.has(r.id));
    }
    // ─────────────────────────────────────────────────────────────────────

    if(!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="no-data" style="padding:28px">
        <i class="fas fa-inbox" style="font-size:28px;opacity:.25;display:block;margin-bottom:8px"></i>
        No transactions found</td></tr>`;
      // Zero chips
      ['op','in','out','cl'].forEach(k => document.getElementById('tlm-chip-'+k).textContent = '0');
      return;
    }

    // Compute running balance
    // Opening = godown_stock at start (from _summary, adjusted for period)
    // For simplicity: start balance = first row's running balance before it
    // We treat opening/floor_opening as inward for balance, outward/dispatch as outward
    const INWARD_TYPES  = new Set(['opening','floor_opening','inward','issue','pm_return','transfer_in']);
    const OUTWARD_TYPES = new Set(['outward','dispatch','rejection','transfer_out','transfer']);

    // Determine starting balance: sum all txns before our window
    // If no date filter, start from 0 and opening entries add to balance
    let balance = 0;
    if(fromDate) {
      // Get summary balance up to day before fromDate
      const sumRow = _summary.find(s => s.id === _tlmProductId);
      if(sumRow) {
        // Use current godown_stock from summary and back-calculate
        // Simpler: just accumulate from first row
        balance = 0;
      }
    }

    let totalIn = 0, totalOut = 0;
    const firstBalance = balance;

    const C = 'padding:9px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))';

    tbody.innerHTML = rows.map((r, i) => {
      const isSelf = r.txn_type === 'self_transfer';
      const isIn   = !isSelf && INWARD_TYPES.has(r.txn_type);
      const isOut  = !isSelf && OUTWARD_TYPES.has(r.txn_type);
      const qty    = parseFloat(r.qty) || 0;

      const openBal = balance;
      let inQty = 0, outQty = 0;
      if(isSelf)     { /* no stock effect — both legs cancel out */ }
      else if(isIn)  { inQty = qty;  balance += qty; totalIn  += qty; }
      else if(isOut) { outQty = qty; balance -= qty; totalOut += qty; }
      else           { inQty = qty;  balance += qty; totalIn  += qty; } // unknown = treat as inward

      const closeBal = balance;
      const isNeg    = closeBal < 0;
      const closeCl  = isNeg ? '#dc2626' : 'var(--teal,#0d9488)';

      // Voucher badge — clickable for godown_txn (PG/...) and floor_txn (PF/...)
      // rows when the current user is an admin. Other source types currently
      // have no detail modal so they stay as static badges.
      const _isAdmin = (typeof window._isAdmin === 'boolean') ? window._isAdmin
                     : (String(window.__pmRole||'').toLowerCase() === 'admin');
      const _vClickable = _isAdmin && r.voucher_no &&
                         (r.source === 'godown' || r.source === 'floor');
      const _vHandler = _vClickable
        ? `onclick="openGodownTxnDetail(${r.id}, '${r.source}')"`
        : '';
      const _vCursor = _vClickable ? 'cursor:pointer;' : '';
      const _vTitle  = _vClickable ? 'title="Click to view / edit this voucher"' : '';
      const vno = r.voucher_no
        ? `<span ${_vHandler} ${_vTitle} style="font-family:var(--font-mono,monospace);font-size:10px;font-weight:700;
            color:var(--teal,#0d9488);background:rgba(26,115,232,.07);
            padding:1px 6px;border-radius:3px;border:1px solid rgba(26,115,232,.18);
            white-space:nowrap;${_vCursor}">${r.voucher_no}</span>`
        : `<span style="color:var(--muted,#9ca3af);font-size:10px">—</span>`;

      const rowBg = isSelf
        ? 'background:rgba(245,158,11,.08)'
        : (i%2===0 ? '' : 'background:var(--heven,rgba(0,0,0,.018))');

      // Remarks: show from_location → to_location for MTV, else remarks text
      let remarks = r.remarks || '';
      if(r.source === 'mtv') {
        remarks = `${r.from_location||'—'} → ${r.to_location||'—'}`;
      } else if(r.source === 'grn') {
        remarks = r.remarks || '';
      }
      if(isSelf) {
        const cleaned = remarks.replace(/\s+(IN|OUT)\s*$/i,'');
        remarks = `⚠ Self-transfer (no stock change) · ${cleaned}`;
      }

      // Determine click handler based on source
      const canOpen = r.source === 'grn' || r.source === 'mtv';
      const vid = parseInt(r.voucher_id) || 0;
      const onDbl = r.source === 'grn' && vid ? `tlmOpenVoucher('grn',${vid})`
                  : r.source === 'mtv' && vid ? `tlmOpenVoucher('mtv',${vid})`
                  : '';

      // Self-transfer rows render with strikethrough qty for clarity
      const _selfQty = parseFloat(r._origQty)||0;
      const inHTML = isSelf
        ? `<span style="text-decoration:line-through;color:var(--muted,#9ca3af);font-weight:600">${fmt(_selfQty)}</span>`
        : (inQty>0?'+'+fmt(inQty):'—');
      const inColor = isSelf ? 'var(--muted,#9ca3af)' : (inQty>0?'#15803d':'var(--muted,#9ca3af)');
      const outHTML = isSelf
        ? `<span style="text-decoration:line-through;color:var(--muted,#9ca3af);font-weight:600">${fmt(_selfQty)}</span>`
        : (outQty>0?'−'+fmt(outQty):'—');
      const outColor = isSelf ? 'var(--muted,#9ca3af)' : (outQty>0?'#dc2626':'var(--muted,#9ca3af)');

      return `<tr style="${rowBg}${canOpen?';cursor:pointer':''}"
        ${onDbl ? `ondblclick="${onDbl}" title="Double-click to open voucher"` : ''}>
        <td style="${C};white-space:nowrap;font-size:11.5px;color:var(--htxtb,#111)">${fmtDate(r.txn_date)}</td>
        <td style="${C}">${vno}</td>
        <td style="${C};text-align:right;font-variant-numeric:tabular-nums;color:var(--hmuted2,#6b7280)">${fmt(openBal)}</td>
        <td style="${C};text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:${inColor}">${inHTML}</td>
        <td style="${C};text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:${outColor}">${outHTML}</td>
        <td style="${C};text-align:right;font-weight:800;font-variant-numeric:tabular-nums;color:${closeCl}${isNeg?';animation:pulse-negative 1.5s infinite':''}">${fmt(closeBal)}</td>
        <td style="${C};color:var(--hmuted2,#6b7280);font-size:11px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(remarks)}">${escHtml(remarks)||'—'}</td>
      </tr>`;
    }).join('');

    // Update summary chips
    document.getElementById('tlm-chip-op').textContent  = fmt(firstBalance);
    document.getElementById('tlm-chip-in').textContent  = fmt(totalIn);
    document.getElementById('tlm-chip-out').textContent = fmt(totalOut);
    const finalClose = firstBalance + totalIn - totalOut;
    const clEl = document.getElementById('tlm-chip-cl');
    clEl.textContent = fmt(finalClose);
    clEl.style.color = finalClose < 0 ? '#dc2626' : 'var(--teal,#0d9488)';

  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" class="no-data">Error: ${e.message}</td></tr>`;
  }
}


// ── tlmOpenVoucher (originally L4766..L4772) ─────────────────────────
function tlmOpenVoucher(type, id) {
  // editGrnModal / editMtvModal have z-index:900, above ledger (800)
  // so they appear on top without needing to close the ledger
  if(type === 'mtv') openEditMtv(id);
  else               openEditGrn(id);
}


// ── checkLowStockAlerts (originally L4773..L4806) ─────────────────────────
function checkLowStockAlerts(force=false){
  if(!_summary.length) return;

  // ── Negative stock banner — always updated, never dismissible until fixed ──
  const negItems = _summary.filter(r => r.godown_stock < 0);
  _renderNegativeBanner(negItems);

  // ── Unbranded products banner — persistent, never dismissible until fixed ──
  // A product is "unbranded" if brand_id is 0/null/missing OR brand_name is empty
  const unbrandedItems = _summary.filter(r => {
    const bid = parseInt(r.brand_id) || 0;
    const bn  = (r.brand_name || '').trim();
    return bid === 0 || !bn;
  });
  _renderUnbrandedBanner(unbrandedItems);

  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const lastCheck = localStorage.getItem('pm_alert_last_check');
  if(!force && lastCheck === today) return;
  localStorage.setItem('pm_alert_last_check', today);

  // ── Low stock panel (min_stock threshold) ──
  const alerts = _summary.filter(r => {
    const threshold = r.min_stock || 0;
    if(threshold <= 0) return false;
    const stock = r.godown_stock;
    const dimKey = `pm_dismissed_${today}_${r.id}`;
    if(stock >= threshold){ localStorage.removeItem(dimKey); return false; }
    if(localStorage.getItem(dimKey)) return false;
    return true;
  });
  if(alerts.length) showLowStockPanel(alerts, today);
}


// ── _renderUnbrandedBanner (originally L4807..L4882) ─────────────────────────
function _renderUnbrandedBanner(unbItems){
  const existing = document.getElementById('unbr-banner');
  if(!unbItems.length){
    if(existing) existing.remove();
    _adjustBannerPadding();
    return;
  }

  const banner = existing || document.createElement('div');
  banner.id = 'unbr-banner';
  banner.style.cssText = `
    position:fixed;left:0;right:0;z-index:9998;
    background:linear-gradient(135deg,#92400e 0%,#d97706 50%,#92400e 100%);
    background-size:200% 100%;
    animation:unbr-banner-pulse 2.5s ease-in-out infinite;
    color:#fff;font-family:'Sora',sans-serif;
    box-shadow:0 3px 14px rgba(146,64,14,0.4);
    border-bottom:2px solid #fbbf24;
  `;

  // Inject animation keyframes once
  if(!document.getElementById('unbr-banner-style')){
    const s = document.createElement('style');
    s.id = 'unbr-banner-style';
    s.textContent = `
      @keyframes unbr-banner-pulse {
        0%,100%{background-position:0% 50%}
        50%{background-position:100% 50%}
      }
      @keyframes unbr-count-blink {
        0%,100%{opacity:1} 50%{opacity:0.55}
      }
      #unbr-banner .unbr-count {
        animation: unbr-count-blink 1.2s ease-in-out infinite;
        display:inline-block;
      }
    `;
    document.head.appendChild(s);
  }

  const names = unbItems.slice(0,3).map(r =>
    `<span style="font-weight:800">${r.product_name.split(' ').slice(0,3).join(' ')}</span>`
  ).join(', ');
  const more  = unbItems.length > 3 ? ` <span style="opacity:.8">+${unbItems.length-3} more</span>` : '';

  const n = unbItems.length;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:7px 20px;max-width:100%;flex-wrap:wrap">
      <span style="font-size:18px;flex-shrink:0">🏷️</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:800;letter-spacing:.3px;line-height:1.3">
          BRAND MISSING — <span class="unbr-count">${n} product${n>1?'s':''}</span> without brand:
          <span style="font-weight:400;opacity:.9">${names}${more}</span>
        </div>
        <div style="font-size:10.5px;font-weight:500;opacity:.92;line-height:1.3;margin-top:1px;font-family:'Noto Sans Devanagari','Sora',sans-serif">
          ब्रांड नहीं जोड़ा गया — <strong>${n} उत्पाद</strong> में ब्रांड अलॉट नहीं है, कृपया असाइन करें।
        </div>
      </div>
      <button onclick="viewUnbranded()"
        style="flex-shrink:0;background:rgba(255,255,255,0.22);border:1.5px solid rgba(255,255,255,0.5);
          color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:6px;cursor:pointer;
          font-family:'Sora',sans-serif;white-space:nowrap;transition:background .15s"
        onmouseover="this.style.background='rgba(255,255,255,0.35)'"
        onmouseout="this.style.background='rgba(255,255,255,0.22)'">
        Assign Brands →
      </button>
    </div>
  `;

  if(!existing){
    document.body.appendChild(banner);
  }
  // Reposition — sits below negative banner if present
  _adjustBannerPadding();
}


// ── _adjustBannerPadding (originally L4883..L4914) ─────────────────────────
function _adjustBannerPadding(){
  // Now delegates to the unified _refreshBannerOffset() which measures
  // every banner present (negative, unbranded, discrepancy) and stacks
  // them via a single --banner-offset CSS variable. The topbar and
  // sidebar read that variable from CSS — no per-module top mutations.
  if(typeof _refreshBannerOffset === 'function') _refreshBannerOffset();
  // Run again after layout settles, in case offsetHeight wasn't stable
  // when this was called (banners with wrapping text).
  setTimeout(() => {
    if(typeof _refreshBannerOffset === 'function') _refreshBannerOffset();
  }, 120);
}

/* Switch to the Products tab and filter to show only unbranded products */

// ── viewUnbranded (originally L4915..L4926) ─────────────────────────
function viewUnbranded(){
  switchTab('products');
  setSidebarActive('products');
  // Clear product search, set PM Type filter to empty, add a brand-less filter
  const search = document.getElementById('prod-search');
  if(search) search.value = '';
  window._prodUnbrandedFilter = true;
  _pag.prod.page = 1;
  renderProductTable();
}

/* Show a removable chip above the product table when unbranded filter is active */

// ── _renderUnbrandedFilterChip (originally L4927..L4949) ─────────────────────────
function _renderUnbrandedFilterChip(){
  const tbody = document.getElementById('prodTbody');
  const existing = document.getElementById('unbr-filter-chip');
  if(!window._prodUnbrandedFilter){
    if(existing) existing.remove();
    return;
  }
  if(existing || !tbody) return;
  const table = tbody.closest('table');
  if(!table || !table.parentElement) return;
  const chip = document.createElement('div');
  chip.id = 'unbr-filter-chip';
  chip.style.cssText = `margin:0 0 8px;display:inline-flex;align-items:center;gap:8px;
    padding:5px 12px;background:rgba(217,119,6,0.1);border:1.5px solid rgba(217,119,6,0.4);
    color:#92400e;border-radius:20px;font-size:11px;font-weight:700;font-family:'Sora',sans-serif`;
  chip.innerHTML = `
    🏷️ Showing only <strong>products without brand</strong>
    <button onclick="clearUnbrandedFilter()"
      style="background:rgba(217,119,6,0.2);border:none;color:#92400e;font-weight:800;
        cursor:pointer;width:18px;height:18px;border-radius:50%;font-size:12px;padding:0">✕</button>`;
  table.parentElement.insertBefore(chip, table);
}


// ── clearUnbrandedFilter (originally L4950..L4955) ─────────────────────────
function clearUnbrandedFilter(){
  window._prodUnbrandedFilter = false;
  _pag.prod.page = 1;
  renderProductTable();
}


// ── _renderNegativeBanner (originally L4956..L5025) ─────────────────────────
function _renderNegativeBanner(negItems){
  const existing = document.getElementById('neg-stock-banner');
  if(!negItems.length){
    if(existing) existing.remove();
    _adjustBannerPadding();
    return;
  }

  const banner = existing || document.createElement('div');
  banner.id = 'neg-stock-banner';
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9999;
    background:linear-gradient(135deg,#7f0000 0%,#b91c1c 50%,#7f0000 100%);
    background-size:200% 100%;
    animation:neg-banner-pulse 2s ease-in-out infinite;
    color:#fff;font-family:'Sora',sans-serif;
    box-shadow:0 4px 20px rgba(127,0,0,0.5);
    border-bottom:3px solid #fca5a5;
  `;

  // Add animation keyframes once
  if(!document.getElementById('neg-banner-style')){
    const s = document.createElement('style');
    s.id = 'neg-banner-style';
    s.textContent = `
      @keyframes neg-banner-pulse {
        0%,100%{background-position:0% 50%;box-shadow:0 4px 20px rgba(127,0,0,0.5)}
        50%{background-position:100% 50%;box-shadow:0 4px 28px rgba(185,28,28,0.8)}
      }
      @keyframes neg-count-blink {
        0%,100%{opacity:1} 50%{opacity:0.4}
      }
      #neg-stock-banner .neg-count {
        animation: neg-count-blink 1s ease-in-out infinite;
        display:inline-block;
      }
    `;
    document.head.appendChild(s);
  }

  const names = negItems.slice(0,3).map(r=>`<span style="font-weight:800">${r.product_name.split(' ').slice(0,3).join(' ')}</span> (${fmt(r.godown_stock)})`).join(', ');
  const more  = negItems.length > 3 ? ` <span style="opacity:.8">+${negItems.length-3} more</span>` : '';

  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 20px;max-width:100%;flex-wrap:wrap">
      <span style="font-size:20px;flex-shrink:0">🚨</span>
      <div style="flex:1;min-width:0">
        <span style="font-size:12px;font-weight:800;letter-spacing:.3px">
          NEGATIVE STOCK — <span class="neg-count">${negItems.length} product${negItems.length>1?'s':''}</span> below zero:
        </span>
        <span style="font-size:11px;margin-left:6px;opacity:.9">${names}${more}</span>
      </div>
      <button onclick="viewNegativeStock()"
        style="flex-shrink:0;background:rgba(255,255,255,0.2);border:1.5px solid rgba(255,255,255,0.5);
          color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:6px;cursor:pointer;
          font-family:'Sora',sans-serif;white-space:nowrap;transition:background .15s"
        onmouseover="this.style.background='rgba(255,255,255,0.35)'"
        onmouseout="this.style.background='rgba(255,255,255,0.2)'">
        View All →
      </button>
    </div>
  `;

  if(!existing){
    document.body.prepend(banner);
  }
  // Shared padding adjustment handles stacking for negative + unbranded banners
  _adjustBannerPadding();
}


// ── showLowStockPanel (originally L5026..L5079) ─────────────────────────
function showLowStockPanel(alerts, today){
  // Remove existing panel
  const existing = document.getElementById('low-stock-panel');
  if(existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'low-stock-panel';
  panel.style.cssText = `position:fixed;bottom:80px;left:24px;z-index:600;
    width:340px;max-height:360px;background:var(--hcard,#fff);
    border:2px solid rgba(245,158,11,0.4);border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,0.2);font-family:'Sora',sans-serif;
    display:flex;flex-direction:column;overflow:hidden`;

  panel.innerHTML = `
    <div style="padding:10px 14px;background:rgba(245,158,11,0.12);border-bottom:1px solid rgba(245,158,11,0.3);
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <span style="font-size:12px;font-weight:800;color:var(--floor-clr,#d97706)">
        ⚠️ Low Stock Alert — ${alerts.length} item${alerts.length>1?'s':''}
      </span>
      <button onclick="document.getElementById('low-stock-panel').remove()"
        style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--hmuted2,#6b7280);line-height:1">✕</button>
    </div>
    <div style="overflow-y:auto;flex:1;padding:6px 0">
      ${alerts.map(r=>`
        <div style="display:flex;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))">
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:700;color:var(--htxtb,#111);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${r.product_name}">${r.product_name}</div>
            <div style="font-size:10px;color:var(--hmuted2,#6b7280)">
              Stock: <strong style="color:var(--red,#ef4444)">${fmt(r.godown_stock)}</strong>
              &nbsp;/&nbsp; Min: <strong style="color:var(--floor-clr,#d97706)">${fmt(r.min_stock)}</strong>
            </div>
          </div>
          <button onclick="dismissLowStockAlert(${r.id},'${today}')"
            style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;cursor:pointer;
              background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr2,rgba(0,0,0,.13));
              color:var(--hmuted2,#6b7280);white-space:nowrap;font-family:'Sora',sans-serif">
            Dismiss today
          </button>
        </div>`).join('')}
    </div>
    <div style="padding:8px 14px;background:var(--hsurf2,#f8fafc);border-top:1px solid var(--hbdr,rgba(0,0,0,.09));
      display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
      <button onclick="dismissAllLowStock(${JSON.stringify(alerts.map(r=>r.id))},'${today}')"
        style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:6px;cursor:pointer;
          background:var(--hsurf2,#f8fafc);border:1.5px solid var(--hbdr2,rgba(0,0,0,.13));
          color:var(--hmuted2,#6b7280);font-family:'Sora',sans-serif">
        Dismiss All
      </button>
    </div>`;

  document.body.appendChild(panel);
}


// ── dismissLowStockAlert (originally L5080..L5095) ─────────────────────────
function dismissLowStockAlert(productId, today){
  localStorage.setItem(`pm_dismissed_${today}_${productId}`, '1');
  // Remove just this item from panel
  const panel = document.getElementById('low-stock-panel');
  if(!panel) return;
  const remaining = _summary.filter(r=>{
    const threshold = r.min_stock||0;
    if(threshold<=0) return false;
    if(r.godown_stock>=threshold) return false;
    if(localStorage.getItem(`pm_dismissed_${today}_${r.id}`)) return false;
    return true;
  });
  if(!remaining.length){ panel.remove(); return; }
  showLowStockPanel(remaining, today);
}


// ── dismissAllLowStock (originally L5096..L5102) ─────────────────────────
function dismissAllLowStock(ids, today){
  ids.forEach(id=>localStorage.setItem(`pm_dismissed_${today}_${id}`,'1'));
  const panel = document.getElementById('low-stock-panel');
  if(panel) panel.remove();
}

let _toastTimer=null;

