/* pm_stock_main.js — utilities, selection, Reports, toast, keydown handler */

// ── paginate (originally L1145..L1153) ─────────────────────────
function paginate(rows, grid) {
  const s = _pag[grid];
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / s.size));
  if(s.page > pages) s.page = pages;
  const start = (s.page-1)*s.size;
  return { slice: rows.slice(start, start+s.size), total, pages, page: s.page, start };
}


// ── renderPag (originally L1154..L1185) ─────────────────────────
function renderPag(containerId, grid, total, pages, page) {
  const el = document.getElementById(containerId);
  if(!el) return;
  const s = _pag[grid];
  const showing = Math.min(page*s.size, total);
  const from    = total ? (page-1)*s.size+1 : 0;

  // Page number buttons (max 5 shown)
  let pageBtns = '';
  let startP = Math.max(1, page-2), endP = Math.min(pages, page+2);
  if(endP-startP < 4){ startP = Math.max(1, endP-4); }
  for(let p=startP; p<=endP; p++){
    pageBtns += `<button class="pag-btn${p===page?' active':''}" onclick="_pag['${grid}'].page=${p};re${grid}()">${p}</button>`;
  }

  el.innerHTML = `
    <button class="pag-btn" onclick="_pag['${grid}'].page=1;re${grid}()" ${page<=1?'disabled':''}>«</button>
    <button class="pag-btn" onclick="_pag['${grid}'].page=${page-1};re${grid}()" ${page<=1?'disabled':''}>‹</button>
    ${pageBtns}
    <button class="pag-btn" onclick="_pag['${grid}'].page=${page+1};re${grid}()" ${page>=pages?'disabled':''}>›</button>
    <button class="pag-btn" onclick="_pag['${grid}'].page=${pages};re${grid}()" ${page>=pages?'disabled':''}>»</button>
    <span class="pag-spacer"></span>
    <span class="pag-info">${from}–${showing} of ${total}</span>
    <select class="pag-size" onchange="_pag['${grid}'].size=+this.value;_pag['${grid}'].page=1;localStorage.setItem('pm_pag_${grid}',this.value);re${grid}()">
      ${[10,25,50,100].map(n=>`<option value="${n}"${s.size===n?' selected':''}>${n}/page</option>`).join('')}
    </select>`;
}


/* ═══════════════════════════════════════════════════════════
   PRODUCTS
═══════════════════════════════════════════════════════════ */

// ── onRowCheck (originally L2593..L2598) ─────────────────────────
function onRowCheck(checkbox, id, type, rowData) {
  const key=id+'_'+type;
  if(checkbox.checked) _selectedRows[key]={...rowData,_type:type};
  else delete _selectedRows[key];
  updateWaBar();
}

// ── onLogCheck (originally L2599..L2603) ─────────────────────────
function onLogCheck(checkbox, id, source) {
  if(checkbox.checked) _selectedLog[id]={id,source};
  else delete _selectedLog[id];
  updateWaBar();
}

// ── onProdCheck (originally L2604..L2616) ─────────────────────────
function onProdCheck(checkbox, id) {
  if(checkbox.checked) {
    const rowData = _products.find(p => p.id === id);
    if(rowData) _selectedProd[id] = rowData;
  } else {
    delete _selectedProd[id];
  }
  _updateProdSelectionButtons();
  updateWaBar();
}

// Show/hide the Delete + Update-Code buttons based on selection count.
// Called from every place that mutates _selectedProd.

// ── _updateProdSelectionButtons (originally L2617..L2626) ─────────────────────────
function _updateProdSelectionButtons(){
  const n      = Object.keys(_selectedProd).length;
  const delBtn = document.getElementById('prodDeleteBtn');
  const delPermBtn = document.getElementById('prodDeletePermBtn');
  const codeBtn= document.getElementById('prodCodeRegenBtn');
  const codeCt = document.getElementById('prodCodeRegenCount');
  if(delBtn)  delBtn.style.display  = n ? '' : 'none';
  if(delPermBtn) delPermBtn.style.display = n ? '' : 'none';
  if(codeBtn) codeBtn.style.display = n ? '' : 'none';
  if(codeCt)  codeCt.textContent    = String(n);
}


// ── toggleAllCheckboxes (originally L2627..L2738) ─────────────────────────
function toggleAllCheckboxes(type, checked) {
  if(type==='godown'||type==='floor'){
    const search=(document.getElementById('sv-search')?.value||'').toLowerCase();
    const pmType=document.getElementById('sv-pm-type')?.value||'';
    const brandId=parseInt(document.getElementById('sv-brand')?.value)||0;
    const stockFilter=document.getElementById('sv-stock-filter')?.value||'';
    let allRows=_summary;
    if(search)  allRows=allRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(search) ||
      (r.pm_type      || '').toLowerCase().includes(search) ||
      (r.product_code || '').toLowerCase().includes(search)
    );
    if(pmType)  allRows=allRows.filter(r=>r.pm_type===pmType);
    if(brandId) allRows=allRows.filter(r=>_brands.find(b=>b.id===brandId&&b.name===r.brand_name));
    if(type==='godown'){
      if(stockFilter==='nonzero') allRows=allRows.filter(r=>r.godown_stock>0);
      if(stockFilter==='zero')    allRows=allRows.filter(r=>r.godown_stock<=0);
    } else {
      if(stockFilter==='nonzero') allRows=allRows.filter(r=>r.remaining>0);
      if(stockFilter==='zero')    allRows=allRows.filter(r=>r.remaining<=0);
    }

    allRows.forEach(r=>{
      const key=r.id+'_'+type;
      if(checked) _selectedRows[key]={...r,_type:type};
      else        delete _selectedRows[key];
    });
    document.querySelectorAll(`.row-select[data-type="${type}"]`).forEach(cb=>{
      cb.checked=checked;
    });

  } else if(type==='combined'){
    const search=(document.getElementById('ct-search')?.value||'').toLowerCase();
    const pmType=document.getElementById('ct-pm-type')?.value||'';
    const brandId=parseInt(document.getElementById('ct-brand')?.value)||0;
    const stockFilter=document.getElementById('ct-stock-filter')?.value||'';
    let allRows=_summary;
    if(search)  allRows=allRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(search) ||
      (r.pm_type      || '').toLowerCase().includes(search) ||
      (r.product_code || '').toLowerCase().includes(search)
    );
    if(pmType)  allRows=allRows.filter(r=>r.pm_type===pmType);
    if(brandId) allRows=allRows.filter(r=>_brands.find(b=>b.id===brandId&&b.name===r.brand_name));
    if(stockFilter==='nonzero') allRows=allRows.filter(r=>(r.godown_stock+r.remaining)>0);
    if(stockFilter==='zero')    allRows=allRows.filter(r=>(r.godown_stock+r.remaining)<=0);

    allRows.forEach(r=>{
      const key=r.id+'_combined';
      if(checked) _selectedRows[key]={...r,_type:'combined'};
      else        delete _selectedRows[key];
    });
    document.querySelectorAll('.row-select[data-type="combined"]').forEach(cb=>{
      cb.checked=checked;
    });

  } else if(type==='log'){
    // All log rows across all pages
    const search=(document.getElementById('log-search')?.value||'').toLowerCase();
    const pmType=(document.getElementById('log-pm-type')?.value||'');
    const source=(document.getElementById('log-source')?.value||'all');
    let allRows=_logRows;
    if(search)  allRows=allRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(search) ||
      (r.pm_type      || '').toLowerCase().includes(search) ||
      (r.product_code || '').toLowerCase().includes(search)
    );
    if(pmType)  allRows=allRows.filter(r=>r.pm_type===pmType);
    if(source!=='all') allRows=allRows.filter(r=>r.source===source);

    allRows.forEach(r=>{
      if(checked) _selectedLog[r.id]={id:r.id,source:r.source};
      else        delete _selectedLog[r.id];
    });
    document.querySelectorAll('.row-select[data-grid="log"]').forEach(cb=>{ cb.checked=checked; });

  } else if(type==='prod'){
    // All filtered products across all pages
    const search=(document.getElementById('prod-search')?.value||'').toLowerCase();
    const pmType=(document.getElementById('prod-pm-type')?.value||'');
    const brandFilterId=parseInt(document.getElementById('prod-brand-filter')?.value)||0;
    let allRows=_products;
    if(search)        allRows=allRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(search) ||
      (r.pm_type      || '').toLowerCase().includes(search) ||
      (r.product_code || '').toLowerCase().includes(search)
    );
    if(pmType)        allRows=allRows.filter(r=>r.pm_type===pmType);
    if(brandFilterId) allRows=allRows.filter(r=>parseInt(r.brand_id||0)===brandFilterId);

    if(checked){
      allRows.forEach(r=>{ _selectedProd[r.id]=r; });
    } else {
      allRows.forEach(r=>{ delete _selectedProd[r.id]; });
    }

    // Update visible DOM checkboxes on current page
    document.querySelectorAll('.row-select[data-grid="prod"]').forEach(cb=>{
      const id=parseInt(cb.dataset.id);
      // Only check/uncheck if this row is in the filtered set
      const inFilter=allRows.some(r=>r.id===id);
      if(inFilter) cb.checked=checked;
    });

    _updateProdSelectionButtons();
    // Force brand bar update immediately
    updateSvBrandBar();
  }

  updateWaBar();
}


// ── clearSelection (originally L2739..L2748) ─────────────────────────
function clearSelection(){
  _selectedRows={}; _selectedLog={}; _selectedProd={};
  document.querySelectorAll('.row-select').forEach(cb=>cb.checked=false);
  ['chkAllGodown','chkAllFloor','chkAllCombined','chkAllLog','chkAllProd'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.checked=false;
  });
  _updateProdSelectionButtons();
  updateWaBar();
}


// ── updateWaBar (originally L2749..L2762) ─────────────────────────
function updateWaBar(){
  const count=Object.keys(_selectedRows).length+Object.keys(_selectedLog).length+Object.keys(_selectedProd).length;
  document.getElementById('waCount').textContent=count;
  document.getElementById('waBar').classList.toggle('visible',count>0);
  // Only show Delete when log txns or products are selected (not stock/combined rows)
  const canDelete = Object.keys(_selectedLog).length>0 || Object.keys(_selectedProd).length>0;
  const delBtn = document.getElementById('waDeleteBtn');
  if(delBtn) delBtn.style.display = canDelete ? '' : 'none';
  updateSvBrandBar();
}

/* ═══════════════════════════════════════════════════════════
   BULK DELETE
═══════════════════════════════════════════════════════════ */

// ── bulkDeleteSelected (originally L2763..L2798) ─────────────────────────
async function bulkDeleteSelected(){
  const stockKeys=Object.keys(_selectedRows);
  const logKeys  =Object.keys(_selectedLog);
  const prodKeys =Object.keys(_selectedProd);

  // Stock view / combined rows are NOT deletable — only log transactions and products
  if(stockKeys.length && !logKeys.length && !prodKeys.length){
    showToast('Select items from Transaction Log or Products tab to delete','error');
    return;
  }

  const total = logKeys.length + prodKeys.length;
  if(!total){showToast('Nothing selected to delete','error');return;}
  if(!confirm(`Delete ${total} selected item(s)? This cannot be undone.`)) return;

  // Delete log transactions (with mirror cascade via bulk_delete_txn)
  if(logKeys.length){
    const items=Object.values(_selectedLog).map(r=>({id:r.id,source:r.source}));
    await fetch('/api/pm_stock/bulk_delete_txn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
    _logRows=_logRows.filter(r=>!_selectedLog[r.id]);
  }
  // Delete products
  if(prodKeys.length){
    await fetch('/api/pm_stock/delete_product',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:prodKeys.map(Number)})});
    _products=_products.filter(p=>!_selectedProd[p.id]);
    window._products = _products;
  }

  showToast(`✓ ${total} item(s) deleted`,'success');
  clearSelection();
  renderLog(_logRows);
  renderProductTable();
  await loadSummary();
  loadPmTypes();
}


// ── sendWhatsappSelected (originally L2819..L2834) ─────────────────────────
function sendWhatsappSelected(){
  const rows=Object.values(_selectedRows);
  if(!rows.length){showToast('Select at least one stock item','error');return;}
  const today=fmtDate(new Date());
  let msg=`📦 *PM Stock Report*\n🗓 ${today}\n━━━━━━━━━━━━━━━━━━━━\n`;
  const godown=rows.filter(r=>r._type==='godown');
  const floor =rows.filter(r=>r._type==='floor');
  if(godown.length){msg+=`\n🏭 *GODOWN STOCK*\n`;godown.forEach(r=>{msg+=`• ${r.product_name}\n  PM: ${r.pm_type} | Stock: *${fmt(r.godown_stock)}*\n  (OP:${fmt(r.op)} IN:${fmt(r.inward)} OUT:${fmt(r.outward)})\n`;});}
  if(floor.length ){msg+=`\n🏗️ *FLOOR STOCK*\n`; floor.forEach(r=>{msg+=`• ${r.product_name}\n  PM: ${r.pm_type} | Remaining: *${fmt(r.remaining)}*\n  (Issued:${fmt(r.issue)} Disp:${fmt(r.dispatch)} Rej:${fmt(r.rejection)} Ret:${fmt(r.pm_return)})\n`;});}
  msg+=`\n_HCP Wellness Pvt Ltd_`;
  window.open('https://web.whatsapp.com/send?text='+encodeURIComponent(msg),'_blank');
}

/* ═══════════════════════════════════════════════════════════
   EXCEL EXPORT
═══════════════════════════════════════════════════════════ */

// ── exportExcel (originally L2835..L2866) ─────────────────────────
async function exportExcel(scope,selectionMode){
  let ids=[];
  if(selectionMode==='selected'){
    ids=Object.values(_selectedRows).map(r=>r.id);
    if(!ids.length){showToast('Select at least one item first','error');return;}
  }
  const toDate=document.getElementById('sv-to-date')?.value||new Date().toISOString().slice(0,10);
  // Pass active filters so export matches what's on screen
  const isCombined = scope==='combined' || document.getElementById('tab-combined')?.classList.contains('active');
  const payload = {
    scope, ids, to_date: toDate,
    search:       isCombined ? (document.getElementById('ct-search')?.value||'') : (document.getElementById('sv-search')?.value||''),
    pm_type:      isCombined ? (document.getElementById('ct-pm-type')?.value||'') : (document.getElementById('sv-pm-type')?.value||''),
    brand_id:     isCombined ? (document.getElementById('ct-brand')?.value||'') : (document.getElementById('sv-brand')?.value||''),
    stock_filter: isCombined ? (document.getElementById('ct-stock-filter')?.value||'') : (document.getElementById('sv-stock-filter')?.value||''),
  };
  showToast('⏳ Generating Excel…','info');
  try{
    const res=await fetch('/api/pm_stock/export_excel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!res.ok){const err=await res.json().catch(()=>({}));showToast(err.message||'Export failed','error');return;}
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`PM_Stock_${toDate}.xlsx`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
    showToast('✓ Excel downloaded','success');
  }catch(e){showToast('Export error: '+e.message,'error');}
}

/* ═══════════════════════════════════════════════════════════
   PRODUCT MANAGEMENT MODALS
═══════════════════════════════════════════════════════════ */

// ── closeModal (originally L3884..L3899) ─────────────────────────
function closeModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.remove('open');
  // Clear any inline force-display styles added by openImportModal etc.
  el.style.display = '';
  el.style.position = '';
  el.style.inset = '';
  el.style.zIndex = '';
  el.style.alignItems = '';
  el.style.justifyContent = '';
  el.style.background = '';
  el.style.backdropFilter = '';
  el.style.padding = '';
}


// ── escHtml (originally L4047..L4047) ─────────────────────────
function escHtml(s){ if(!s&&s!==0)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── fmt (originally L4048..L4048) ─────────────────────────
function fmt(val){const n=parseFloat(val)||0;return n%1===0?n.toLocaleString('en-IN'):n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}

// ── fmtDate (originally L4049..L4062) ─────────────────────────
function fmtDate(d){
  // Display any YYYY-MM-DD or YYYY-MM-DDTHH:MM[...] as DD/MM/YYYY.
  // Accepts plain date strings, ISO datetime strings, and Date objects.
  if(!d || d==='—') return '—';
  if(d instanceof Date && !isNaN(d)){
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}


// ── fmtDateTime (originally L4063..L4072) ─────────────────────────
function fmtDateTime(d){
  // Display ISO datetime as DD/MM/YYYY HH:MM. Accepts strings or Date objects.
  // Falls back to '—' for empty input or fmtDate(d) if no time component is found.
  if(!d || d==='—') return '—';
  const s = String(d).replace('T',' ').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if(!m) return s;
  const date = `${m[3]}/${m[2]}/${m[1]}`;
  return m[4] ? `${date} ${m[4]}:${m[5]}` : date;
}

// ── fmtBig (originally L4073..L4073) ─────────────────────────
function fmtBig(val){const n=parseFloat(val)||0;if(n>=100000)return(n/100000).toFixed(1)+'L';if(n>=1000)return(n/1000).toFixed(1)+'K';return n.toLocaleString('en-IN');}

// ── txnLabel (originally L4074..L4101) ─────────────────────────
function txnLabel(type){const map={opening:'Opening',inward:'Inward',outward:'Issue→Factory',floor_opening:'Factory OP',issue:'Issued',dispatch:'Dispatch',rejection:'Rejection',pm_return:'PM Return↑',transfer:'MTV Transfer'};return map[type]||type;}

/* ═══════════════════════════════════════════════════════════
   STOCK REPORT MODAL
═══════════════════════════════════════════════════════════ */
let _rptSource  = 'godown';  // 'godown' | 'floor'
let _rptRows    = [];        // all fetched rows
let _rptSelected= new Set(); // selected row ids

const RPT_TXN_TYPES = {
  godown: [
    {v:'all',      l:'All Types'},
    {v:'opening',  l:'Opening Balance'},
    {v:'inward',   l:'Inward (GRN Received)'},
    {v:'outward',  l:'Issue to Factory'},
    {v:'transfer', l:'MTV Transfer'},
  ],
  floor: [
    {v:'all',          l:'All Types'},
    {v:'floor_opening',l:'Factory Opening'},
    {v:'issue',        l:'Issued from Godown'},
    {v:'dispatch',     l:'Dispatch (Packed)'},
    {v:'rejection',    l:'Rejection'},
    {v:'pm_return',    l:'PM Return to Godown'},
    {v:'transfer',     l:'MTV Transfer'},
  ]
};


// ── initReportsTab (originally L2143..L2156) ─────────────────────────
function initReportsTab() {
  // Set default dates if empty
  const today = new Date().toISOString().slice(0,10);
  const fromEl = document.getElementById('rpt-from');
  const toEl   = document.getElementById('rpt-to');
  if(fromEl && !fromEl.value) {
    // Default: first of current month
    const d = new Date(); d.setDate(1);
    fromEl.value = d.toISOString().slice(0,10);
  }
  if(toEl && !toEl.value) toEl.value = today;
  setReportType(_reportType);
}


// ── setReportType (originally L2157..L2183) ─────────────────────────
function setReportType(type) {
  _reportType = type;
  const cfg = {
    dispatch:  { label:'Dispatched',  color:'var(--blue,#3b82f6)',   bg:'rgba(59,130,246,.12)',  border:'rgba(59,130,246,.3)'  },
    rejection: { label:'Rejection',   color:'var(--red,#ef4444)',    bg:'rgba(239,68,68,.12)',   border:'rgba(239,68,68,.3)'   },
    pm_return: { label:'PM Return',   color:'var(--purple,#8b5cf6)', bg:'rgba(139,92,246,.12)', border:'rgba(139,92,246,.3)'  },
  };
  // Style buttons
  ['dispatch','rejection','pm_return'].forEach(t => {
    const btn = document.getElementById('rpt-btn-'+t);
    if(!btn) return;
    if(t === type) {
      btn.style.background = cfg[t].bg;
      btn.style.color      = cfg[t].color;
      btn.style.border     = `1.5px solid ${cfg[t].border}`;
    } else {
      btn.style.background = 'var(--hsurf2,#f8fafc)';
      btn.style.color      = 'var(--muted2,#6b7280)';
      btn.style.border     = '1.5px solid var(--hbdr2,rgba(0,0,0,.13))';
    }
  });
  // Update qty header
  const qh = document.getElementById('rpt-qty-header');
  if(qh) qh.textContent = `Total ${cfg[type]?.label||type}`;
  loadReport();
}


// ── loadReport (originally L2184..L2205) ─────────────────────────
async function loadReport() {
  const from   = document.getElementById('rpt-from')?.value || '';
  const to     = document.getElementById('rpt-to')?.value   || new Date().toISOString().slice(0,10);
  const pmType = document.getElementById('rpt-pm-type')?.value||'';
  const search = document.getElementById('rpt-search')?.value||'';

  const stbody = document.getElementById('rptSummaryTbody');
  const dtbody = document.getElementById('rptDetailTbody');
  if(stbody) stbody.innerHTML = `<tr><td colspan="6" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;
  if(dtbody) dtbody.innerHTML = `<tr><td colspan="10" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;

  try {
    const params = new URLSearchParams({type:_reportType,from_date:from,to_date:to,pm_type:pmType,search});
    const res  = await fetch('/api/pm_stock/factory_report?'+params);
    const data = await res.json();
    _reportRows = data.rows || [];
    // Stash the full response so rerpt() (the renderPag page-button shim)
    // can re-render on page changes without re-fetching.
    window._reportData = data;
    renderReport(data);
  } catch(e) {
    showToast('Error loading report: '+e.message,'error');
  }
}


// ── renderReport (originally L2206..L2279) ─────────────────────────
function renderReport(data) {
  // Pagination shim path: rerpt() calls renderReport() with no arg to
  // re-paint after _pag.rpt.page changes. Fall back to the stashed
  // response from the last loadReport() call.
  if(!data) data = window._reportData || {};
  const rows     = data.rows || [];
  const summary  = data.prod_totals || [];
  const grand    = data.grand_total || 0;
  const typeCfg  = {
    dispatch:  {color:'var(--blue,#3b82f6)',   icon:'🚀'},
    rejection: {color:'var(--red,#ef4444)',    icon:'❌'},
    pm_return: {color:'var(--purple,#8b5cf6)', icon:'↩️'},
  };
  const cfg = typeCfg[_reportType] || {};

  // Stats band
  const statsEl = document.getElementById('rpt-stats');
  if(statsEl) statsEl.innerHTML = `
    <div class="stat-card" style="padding:12px;border-top:3px solid ${cfg.color||'var(--brand)'}">
      <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">
        ${cfg.icon||''} Total Qty
      </div>
      <div style="font-size:22px;font-weight:800;color:${cfg.color||'var(--brand)'}">${fmt(grand)}</div>
    </div>
    <div class="stat-card" style="padding:12px;border-top:3px solid var(--purple)">
      <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Transactions</div>
      <div style="font-size:22px;font-weight:800;color:var(--purple)">${rows.length}</div>
    </div>
    <div class="stat-card" style="padding:12px;border-top:3px solid var(--godown-clr)">
      <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Products</div>
      <div style="font-size:22px;font-weight:800;color:var(--godown-clr)">${summary.length}</div>
    </div>`;

  // Summary table
  const stbody = document.getElementById('rptSummaryTbody');
  if(stbody) {
    if(!summary.length) {
      stbody.innerHTML = `<tr><td colspan="6" class="no-data">No data for selected filters</td></tr>`;
    } else {
      stbody.innerHTML = summary
        .sort((a,b)=>b.total_qty-a.total_qty)
        .map((r,i)=>`
        <tr>
          <td style="color:var(--hmuted,#9ca3af)">${i+1}</td>
          <td class="td-name">${r.product_name}</td>
          <td><span class="pm-badge">${r.pm_type}</span></td>
          <td style="font-size:11px;color:var(--muted,#9ca3af)">${r.brand_name||'—'}</td>
          <td class="num" style="font-weight:800;color:${cfg.color||'var(--brand)'};font-size:13px">${fmt(r.total_qty)}</td>
          <td class="num" style="color:var(--muted,#9ca3af)">${r.count}</td>
        </tr>`).join('');
    }
  }

  // Detail table
  const dtbody = document.getElementById('rptDetailTbody');
  if(dtbody) {
    if(!rows.length) {
      dtbody.innerHTML = `<tr><td colspan="10" class="no-data">No transactions found</td></tr>`;
    } else {
      const {slice,total,pages,page,start} = paginate(rows,'rpt');
      dtbody.innerHTML = slice.map((r,i)=>`
        <tr>
          <td style="color:var(--hmuted,#9ca3af)">${start+i+1}</td>
          <td style="white-space:nowrap">${fmtDate(r.txn_date)}</td>
          <td><span style="font-family:var(--font-mono,monospace);font-size:10px;color:var(--muted,#9ca3af)">${r.voucher_no||'—'}</span></td>
          <td class="td-name">${r.product_name}</td>
          <td><span class="pm-badge">${r.pm_type}</span></td>
          <td style="font-size:11px;color:var(--muted,#9ca3af)">${r.brand_name||'—'}</td>
          <td class="num" style="font-weight:700;color:${cfg.color||'var(--brand)'}">${fmt(r.qty)}</td>
          <td style="font-size:11px;color:var(--muted,#9ca3af)">${r.location||'—'}</td>
          <td style="font-size:11px;color:var(--muted,#9ca3af);max-width:150px">${r.remarks||'—'}</td>
          <td style="font-size:11px;color:var(--muted,#9ca3af)">${r.created_by||'—'}</td>
        </tr>`).join('');
      renderPag('rptPag','rpt',total,pages,page);
    }
  }
}


// ── clearReportFilters (originally L2280..L2289) ─────────────────────────
function clearReportFilters() {
  const today = new Date().toISOString().slice(0,10);
  const d = new Date(); d.setDate(1);
  const el = document.getElementById('rpt-from'); if(el) el.value = d.toISOString().slice(0,10);
  const el2 = document.getElementById('rpt-to'); if(el2) el2.value = today;
  const el3 = document.getElementById('rpt-pm-type'); if(el3) el3.value = '';
  const el4 = document.getElementById('rpt-search'); if(el4) el4.value = '';
  loadReport();
}


// ── exportReportXls (originally L2290..L2305) ─────────────────────────
function exportReportXls() {
  if(!_reportRows.length){showToast('No data to export','error');return;}
  if(typeof XLSX==='undefined'){showToast('XLSX library not loaded','error');return;}
  const wb = XLSX.utils.book_new();
  const hdr = ['#','Date','Voucher','Product','PM Type','Brand','Qty','Location','Remarks','By'];
  const data = [hdr, ..._reportRows.map((r,i)=>[
    i+1, r.txn_date, r.voucher_no||'', r.product_name, r.pm_type,
    r.brand_name||'', r.qty, r.location||'', r.remarks||'', r.created_by||''
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{wch:4},{wch:12},{wch:18},{wch:50},{wch:14},{wch:16},{wch:10},{wch:24},{wch:24},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws, _reportType);
  XLSX.writeFile(wb, `PM_${_reportType}_report.xlsx`);
}



// ── openReportModal (originally L4102..L4141) ─────────────────────────
function openReportModal(source) {
  _rptSource   = source;
  _rptRows     = [];
  _rptSelected = new Set();

  // Title + color
  const isGodown = source === 'godown';
  document.getElementById('rpt-title').innerHTML =
    isGodown ? '📊 <span style="color:var(--godown-clr)">Godown Stock</span> Report'
             : '📊 <span style="color:var(--floor-clr)">Floor Stock</span> Report';

  // Populate txn type dropdown
  const sel = document.getElementById('rpt2-txn-type');
  sel.innerHTML = RPT_TXN_TYPES[source].map(t=>`<option value="${t.v}">${t.l}</option>`).join('');

  // Populate PM type dropdown
  const pm = document.getElementById('rpt2-pm-type');
  pm.innerHTML = '<option value="">All PM Types</option>' +
    _pmTypes.map(t=>`<option value="${t}">${t}</option>`).join('');

  // Default dates: current month
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = String(now.getMonth()+1).padStart(2,'0');
  const lastD = new Date(y, now.getMonth()+1, 0).getDate();
  document.getElementById('rpt2-from').value = `${y}-${m}-01`;
  document.getElementById('rpt2-to').value   = `${y}-${m}-${String(lastD).padStart(2,'0')}`;

  // Reset table
  document.getElementById('rpt-tbody').innerHTML =
    `<tr><td colspan="9" class="no-data"><i class="fas fa-chart-bar"></i> Set filters and click Run</td></tr>`;
  document.getElementById('rpt-summary-band').style.display = 'none';
  document.getElementById('rpt-wa-btn').style.opacity = '0.5';
  document.getElementById('rpt-wa-btn').style.pointerEvents = 'none';
  document.getElementById('rpt-chk-all').checked = false;

  document.getElementById('reportModal').classList.add('open');
  runReport();  // auto-run with default current-month filter
}


// ── resetReport (originally L4142..L4159) ─────────────────────────
function resetReport() {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = String(now.getMonth()+1).padStart(2,'0');
  const last = new Date(y, now.getMonth()+1, 0).getDate();
  document.getElementById('rpt2-from').value     = `${y}-${m}-01`;
  document.getElementById('rpt2-to').value       = `${y}-${m}-${String(last).padStart(2,'0')}`;
  document.getElementById('rpt2-txn-type').value = 'all';
  document.getElementById('rpt2-pm-type').value  = '';
  _rptRows=[]; _rptSelected=new Set();
  document.getElementById('rpt-tbody').innerHTML =
    `<tr><td colspan="9" class="no-data"><i class="fas fa-chart-bar"></i> Set filters and click Run</td></tr>`;
  document.getElementById('rpt-summary-band').style.display='none';
  document.getElementById('rpt-wa-btn').style.opacity='0.5';
  document.getElementById('rpt-wa-btn').style.pointerEvents='none';
  document.getElementById('rpt-chk-all').checked=false;
}


// ── runReport (originally L4160..L4270) ─────────────────────────
async function runReport() {
  const from    = document.getElementById('rpt2-from').value;
  const to      = document.getElementById('rpt2-to').value;
  const txnType = document.getElementById('rpt2-txn-type').value;
  const pmType  = document.getElementById('rpt2-pm-type').value;
  console.log('[Report] runReport — from:', from, 'to:', to, 'txnType:', txnType, 'pmType:', pmType, 'source:', _rptSource);

  if(!from || !to){ showToast('Select a date range','error'); return; }

  const tbody = document.getElementById('rpt-tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;

  const params = new URLSearchParams({
    from_date: from, to_date: to,
    search: '', pm_type: pmType,
    source: 'all'   // always fetch all sources; txn_type filter applied client-side
  });

  console.log('[Report] Fetching:', '/api/pm_stock/transactions?' + params);
  const res   = await fetch('/api/pm_stock/transactions?' + params);
  let rows    = await res.json();
  console.log('[Report] Server returned', rows.length, 'rows');
  if(rows.length > 0) {
    const dates = [...new Set(rows.map(r => r.txn_date))].sort();
    console.log('[Report] Distinct dates in response:', dates);
  }

  // Filter by txn type if not 'all'
  if(txnType !== 'all') rows = rows.filter(r => r.txn_type === txnType);
  // Filter by pm type
  if(pmType) rows = rows.filter(r => r.pm_type === pmType);

  _rptRows     = rows;
  _rptSelected = new Set();

  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="9" class="no-data"><i class="fas fa-inbox"></i> No transactions found for this filter</td></tr>`;
    document.getElementById('rpt-summary-band').style.display = 'none';
    return;
  }

  // Render rows
  const totalQty = rows.reduce((s,r)=>s+r.qty,0);
  tbody.innerHTML = rows.map((r,i)=>{
    const isAuto=(r.remarks||'').startsWith('[Auto:');
    const bg = i%2===0?'':'background:var(--heven,#fafafa)';

    // ── Smart voucher / remarks rendering ──────────────────────────────
    // Extract embedded voucher refs like [MTV: PM-MTV/0002/26-27] or [GRN: PM-GRN/0001]
    const remarksRaw = r.remarks || '';
    const mtvMatch   = remarksRaw.match(/\[MTV:\s*([^\]]+)\]/);
    const grnMatch   = remarksRaw.match(/\[GRN:\s*([^\]]+)\]/);
    const autoMatch  = remarksRaw.match(/\[Auto:[^\]]*\]/);
    // Plain remarks = strip any embedded bracket tags
    const plainRem   = remarksRaw.replace(/\[[^\]]+\]/g,'').trim();

    let voucherHtml = '';
    if (mtvMatch) {
      // MTV-linked row: show MTV# as primary badge, own txn# as secondary
      voucherHtml = `<span style="font-size:9.5px;font-weight:700;font-family:var(--font-mono);
        background:rgba(99,102,241,0.12);color:#6366f1;
        padding:1px 6px;border-radius:3px;margin-right:4px;white-space:nowrap">${mtvMatch[1]}</span>`;
      if (r.voucher_no) voucherHtml += `<span style="font-size:9px;color:var(--hmuted,#9ca3af);font-family:var(--font-mono)">${r.voucher_no}</span>`;
    } else if (grnMatch) {
      voucherHtml = `<span style="font-size:9.5px;font-weight:700;font-family:var(--font-mono);
        background:rgba(13,148,136,0.12);color:var(--brand,#0d9488);
        padding:1px 6px;border-radius:3px;margin-right:4px;white-space:nowrap">${grnMatch[1]}</span>`;
    } else if (r.source === 'grn' && r.voucher_no) {
      // Direct GRN row
      voucherHtml = `<span style="font-size:9.5px;font-weight:700;font-family:var(--font-mono);
        background:rgba(13,148,136,0.12);color:var(--brand,#0d9488);
        padding:1px 6px;border-radius:3px;margin-right:4px;white-space:nowrap">${r.voucher_no}</span>`;
    } else if (r.voucher_no) {
      // Regular godown/floor direct txn
      voucherHtml = `<span style="font-size:9.5px;font-weight:700;font-family:var(--font-mono);
        background:var(--brand-dim,rgba(13,148,136,0.1));color:var(--brand,#0d9488);
        padding:1px 6px;border-radius:3px;margin-right:4px;white-space:nowrap">${r.voucher_no}</span>`;
    }
    const remDisplay = autoMatch
      ? `<span style="font-size:10px;color:var(--hmuted,#9ca3af);font-style:italic">auto</span>`
      : (plainRem ? `<span style="font-size:11px">${plainRem}</span>` : '');
    // ───────────────────────────────────────────────────────────────────

    return `<tr style="${bg}${isAuto?';opacity:.7;font-style:italic':''}">
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))">
        <input type="checkbox" class="rpt-row-chk row-select" data-id="${r.id}"
          onchange="rptOnCheck(this,${r.id})" style="accent-color:var(--brand)">
      </td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));color:var(--hmuted,#9ca3af)">${i+1}</td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));color:var(--htxtb,#111);white-space:nowrap">${fmtDate(r.txn_date)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));color:var(--htxt,#374151);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.product_name}">${r.product_name}</td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))"><span class="pm-badge">${r.pm_type}</span></td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))"><span class="txn-type-pill txn-${r.txn_type}">${txnLabel(r.txn_type)}</span></td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:var(--htxtb,#111)">${fmt(r.qty)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${voucherHtml}${remDisplay}
      </td>
      <td style="padding:7px 12px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));color:var(--hmuted,#9ca3af)">${r.created_by||'—'}</td>
    </tr>`;
  }).join('');

  // Show summary
  const band = document.getElementById('rpt-summary-band');
  band.style.display = 'block';
  document.getElementById('rpt-total-rows').textContent  = `${rows.length} transactions`;
  document.getElementById('rpt-total-qty').textContent   = `Total Qty: ${fmt(totalQty)}`;
  document.getElementById('rpt-selected-count').textContent = '0 selected';
  document.getElementById('rpt-chk-all').checked = false;
  rptUpdateWaBtn();
}


// ── rptOnCheck (originally L4271..L4278) ─────────────────────────
function rptOnCheck(cb, id) {
  if(cb.checked) _rptSelected.add(id);
  else           _rptSelected.delete(id);
  document.getElementById('rpt-selected-count').textContent =
    _rptSelected.size ? `${_rptSelected.size} selected` : '0 selected';
  rptUpdateWaBtn();
}


// ── rptToggleAll (originally L4279..L4289) ─────────────────────────
function rptToggleAll(checked) {
  _rptSelected = new Set();
  document.querySelectorAll('.rpt-row-chk').forEach(cb => {
    cb.checked = checked;
    if(checked) _rptSelected.add(parseInt(cb.dataset.id));
  });
  document.getElementById('rpt-selected-count').textContent =
    _rptSelected.size ? `${_rptSelected.size} selected` : '0 selected';
  rptUpdateWaBtn();
}


// ── rptSelectAll (originally L4290..L4293) ─────────────────────────
function rptSelectAll() {
  document.getElementById('rpt-chk-all').checked = true;
  rptToggleAll(true);
}

// ── rptClearSelection (originally L4294..L4298) ─────────────────────────
function rptClearSelection() {
  document.getElementById('rpt-chk-all').checked = false;
  rptToggleAll(false);
}


// ── rptUpdateWaBtn (originally L4299..L4305) ─────────────────────────
function rptUpdateWaBtn() {
  const btn = document.getElementById('rpt-wa-btn');
  const hasSelection = _rptSelected.size > 0;
  btn.style.opacity       = hasSelection ? '1' : '0.5';
  btn.style.pointerEvents = hasSelection ? 'auto' : 'none';
}


// ── sendReportWhatsapp (originally L4306..L4354) ─────────────────────────
function sendReportWhatsapp() {
  if(!_rptSelected.size){ showToast('Select at least one row','error'); return; }

  const rows    = _rptRows.filter(r => _rptSelected.has(r.id));
  const from    = document.getElementById('rpt2-from').value;
  const to      = document.getElementById('rpt2-to').value;
  const txnType = document.getElementById('rpt2-txn-type').value;
  const source  = _rptSource === 'godown' ? '🏭 Godown' : '🏗️ Floor';
  const today   = fmtDate(new Date());
  const totalQty= rows.reduce((s,r)=>s+r.qty, 0);

  let msg = `📦 *PM Stock Report — ${source}*\n`;
  msg += `🗓 Period: ${from} to ${to}\n`;
  if(txnType !== 'all') msg += `🔖 Type: ${txnLabel(txnType)}\n`;
  msg += `📅 Generated: ${today}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Group by product for cleaner message
  const grouped = {};
  rows.forEach(r => {
    const key = r.product_name;
    if(!grouped[key]) grouped[key] = {pm_type: r.pm_type, txns: []};
    grouped[key].txns.push(r);
  });

  Object.entries(grouped).forEach(([name, data]) => {
    const total = data.txns.reduce((s,t)=>s+t.qty, 0);
    msg += `• *${name}* [${data.pm_type}]\n`;
    data.txns.forEach(t => {
      msg += `  ${fmtDate(t.txn_date)} | ${txnLabel(t.txn_type)} | Qty: *${fmt(t.qty)}*`;
      if(t.remarks && !t.remarks.startsWith('[Auto:')) msg += ` | ${t.remarks}`;
      msg += '\n';
    });
    if(data.txns.length > 1) msg += `  ↳ Total: *${fmt(total)}*\n`;
    msg += '\n';
  });

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `✅ *Total Qty: ${fmt(totalQty)}*  |  ${rows.length} transactions\n`;
  msg += `_HCP Wellness Pvt Ltd_`;

  window.open('https://web.whatsapp.com/send?text=' + encodeURIComponent(msg), '_blank');
}

/* ═══════════════════════════════════════════════════════════
   GODOWN / FLOOR SUB-TABS
═══════════════════════════════════════════════════════════ */
// (moved) let _stockTab — declared in pm_stock_stockview.js


// ── showToast (defensively rewritten to honor custom timeout + guarantee fade-out) ──
//
// Three-argument signature: (msg, type, ms)
//   msg  — string, can contain HTML
//   type — 'success' | 'error' | 'info' (default 'success')
//   ms   — auto-hide delay in milliseconds (default 3500)
//
// The earlier implementation hardcoded 3500ms and silently dropped a 3rd
// argument that several callers were passing. That alone didn't cause
// permanently-stuck toasts (others fade fine) but it meant some toasts
// stuck longer than expected. The defensive bits below protect against
// any future re-entry / out-of-order timer issues:
//
// 1. Each call gets a sequence number (`_toastSeq`). The auto-hide
//    callback only acts if the current sequence still matches — so a
//    stale timer can never clobber a fresh toast OR vice versa.
// 2. After the transition's intended duration we *force-remove* `.show`
//    by setting class + clearing inline styles. If something external
//    has stamped `style="opacity:1"` (Chrome devtools sometimes do this),
//    `removeAttribute('style')` wipes it cleanly.
// 3. A belt-and-braces safety net at 2× the requested ms forcibly
//    re-removes `.show` in case the first removal didn't visually
//    update due to a stalled CSS transition.
let _toastSeq = 0;
// NOTE: _toastTimer is declared once in pm_stock_stockview.js at global
// scope. Do NOT redeclare it here with `let` — two top-level `let` of the
// same name across scripts throws "already declared" and kills this file.
function showToast(msg, type='success', ms){
  // Centered, auto-dismissing message (replaces the old corner toast that
  // could get stuck). Shows in the middle of the screen, then fades out
  // after `ms` (default 3000ms) and removes itself. Self-contained — builds
  // its own element + styles, so every existing showToast(...) call works.
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  const colors = {
    success:'#16a34a', error:'#dc2626', info:'#4648D4', warning:'#d97706'
  };
  const dur = Math.max(800, Math.min(20000, Number(ms) || 3000));

  // One-time styles + keyframes.
  if(!document.getElementById('centerMsgStyle')){
    const st = document.createElement('style');
    st.id = 'centerMsgStyle';
    st.textContent =
      '#centerMsgWrap{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;pointer-events:none}'
      + '.center-msg{pointer-events:none;max-width:80vw;display:flex;align-items:center;gap:10px;'
      + 'padding:14px 22px;border-radius:14px;font-size:14px;font-weight:700;line-height:1.4;'
      + 'color:#fff;background:rgba(25,28,33,.94);box-shadow:0 18px 50px rgba(0,0,0,.32);'
      + '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);'
      + 'border-left:5px solid var(--cm-accent,#16a34a);'
      + 'opacity:0;transform:translateY(8px) scale(.97);'
      + 'transition:opacity .22s ease,transform .22s ease}'
      + '.center-msg.show{opacity:1;transform:translateY(0) scale(1)}'
      + '.center-msg-ic{font-size:18px;flex:0 0 auto}';
    document.head.appendChild(st);
  }

  // Single container, reused.
  let wrap = document.getElementById('centerMsgWrap');
  if(!wrap){
    wrap = document.createElement('div');
    wrap.id = 'centerMsgWrap';
    document.body.appendChild(wrap);
  }

  // A fresh message replaces any currently-showing one.
  const mySeq = ++_toastSeq;
  if(_toastTimer){ clearTimeout(_toastTimer); _toastTimer = null; }
  wrap.innerHTML = '';

  const box = document.createElement('div');
  box.className = 'center-msg';
  box.style.setProperty('--cm-accent', colors[type] || colors.success);
  box.innerHTML = '<span class="center-msg-ic">' + (icons[type]||'') + '</span><span>' + msg + '</span>';
  wrap.appendChild(box);

  // Animate in.
  void box.offsetWidth;
  box.classList.add('show');

  // Auto-dismiss after `dur`, then fade + remove.
  _toastTimer = setTimeout(() => {
    if(mySeq !== _toastSeq) return;
    box.classList.remove('show');
    setTimeout(() => {
      if(mySeq !== _toastSeq) return;
      if(wrap) wrap.innerHTML = '';
    }, 260);
    _toastTimer = null;
  }, dur);
}


// ── lines 5118..5240 (originally L5118..L5240) ─────────────────────────
document.addEventListener('keydown',e=>{
  // Escape — close any open modal, or clear active entry form
  if(e.key==='Escape'){
    const open = document.querySelector('.modal-overlay.open');
    if(open && open.id){ closeModal(open.id); return; }
    // If on entry tab, clear whichever form has focus
    const active = document.querySelector('.tab-panel.active');
    if(active && active.id==='tab-entry'){
      if(document.activeElement && document.activeElement.id && document.activeElement.id.startsWith('ge-')) clearGodownForm();
      else clearFloorForm();
    }
    return;
  }

  // Don't fire shortcuts when typing in inputs/textareas (except Alt combos)
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if(e.altKey && !e.ctrlKey && !e.metaKey){
    e.preventDefault();
    switch(e.key){
      // ── Tab switching ──────────────────────────────
      case '1': switchTab('stock');    setSidebarActive('stock');    break;
      case '2': switchTab('combined'); setSidebarActive('combined'); break;
      case '3': switchTab('grn');      setSidebarActive('grn');      break;
      case '4': switchTab('log');      setSidebarActive('log');      break;
      case '5': switchTab('products'); setSidebarActive('products'); break;
      case '6': switchTab('mm');       setSidebarActive('mm');       break;  // Alt+6 → Material Movement
      case '7':                                                              // Alt+7 → Voucher Numbering
        if(typeof openVoucherNumSettings === 'function') openVoucherNumSettings();
        break;
      case '8':                                                              // Alt+8 → User → Location (admin)
        if(typeof openUserLocationModal === 'function') openUserLocationModal();
        break;
      case '9': switchTab('suppliers');  setSidebarActive('suppliers');  break;  // Alt+9 → Supplier Directory
      case '0': switchTab('sup-ledger'); setSidebarActive('sup-ledger'); break;  // Alt+0 → Supplier PM Ledger
      case 'y': case 'Y':                                                    // Alt+Y → Factory Reports
        switchTab('reports'); setSidebarActive('reports'); break;
      case 'k': case 'K': window.location.href = '/task_scheduler'; break;   // Alt+K → Task Scheduler
      case 'h': case 'H': window.location.href = '/'; break;                  // Alt+H → Back to Portal

      // ── Entry saves ───────────────────────────────
      case 'm': case 'M': toggleSidebar(); break;    // Alt+M → Toggle sidebar (no-op now, kept for back-compat)
      case 's': case 'S': saveGodownEntry(); break;  // Alt+S → Save Godown
      case 'd': case 'D': saveFloorEntry();  break;  // Alt+D → Save Floor

      // ── Focus first product search on entry tab ───
      case 'g': case 'G': switchStockTab('godown'); break;  // Alt+G → Godown sub-tab
      case 'l': case 'L': switchStockTab('floor');  break;  // Alt+L → Floor sub-tab
      case 'f': case 'F': {                                  // Alt+F → Focus search
        const active = document.querySelector('.tab-panel.active');
        if(active?.id === 'tab-entry'){
          document.getElementById('ge-product-search')?.focus();
        } else if(active?.id === 'tab-stock'){
          document.getElementById('sv-search')?.focus();
        } else if(active?.id === 'tab-log'){
          document.getElementById('log-search')?.focus();
        } else if(active?.id === 'tab-products'){
          document.getElementById('prod-search')?.focus();
        }
        break;
      }

      // ── Log fetch ─────────────────────────────────
      case 'Enter': loadLog(); break;              // Alt+Enter → Fetch log
      case 'v': case 'V': {                            // Alt+V → View item detail for first selected
        const selId = parseInt(Object.keys(_selectedRows)[0]);
        if(selId) openItemDetail(selId);
        break;
      }

      // ── Products ──────────────────────────────────
      case 'a': case 'A': openAddProductModal();  break;  // Alt+A → Add Product
      case 'i': case 'I': openImportModal();      break;  // Alt+I → Import Excel

      // ── Export / share ────────────────────────────
      case 'x': case 'X': exportExcel('combined'); break; // Alt+X → Export all XLS
      case 'w': case 'W': {                               // Alt+W → WhatsApp
        const active2 = document.querySelector('.tab-panel.active');
        if(active2?.id==='tab-combined') sendWhatsappCombined();
        else sendWhatsappSelected();
        break;
      }

      // ── Refresh stock ─────────────────────────────
      case 'r': case 'R': {                               // Alt+R → Refresh / Reset filters
        const active3 = document.querySelector('.tab-panel.active');
        if(active3?.id==='tab-stock')    { clearStockFilters(); }
        else if(active3?.id==='tab-log') { clearLogFilters(); }
        else loadSummary();
        break;
      }

      // ── Sticky note ───────────────────────────────
      case 'n': case 'N': toggleStickyNote(); break;  // Alt+N → Note

      // ── Select all on current tab ─────────────────
      case 'q': case 'Q': {                           // Alt+Q → Select all visible
        const active4 = document.querySelector('.tab-panel.active');
        if(active4?.id==='tab-stock'){
          document.getElementById('chkAllGodown')?.click();
          document.getElementById('chkAllFloor')?.click();
        } else if(active4?.id==='tab-log'){
          document.getElementById('chkAllLog')?.click();
        } else if(active4?.id==='tab-products'){
          document.getElementById('chkAllProd')?.click();
        }
        break;
      }

      // ── Clear selection ───────────────────────────
      case 'Escape': clearSelection(); break;

      // ── Delete key ────────────────────────────────
      case 'Delete': {
        const active5 = document.querySelector('.tab-panel.active');
        if(active5?.id==='tab-products') deleteSelectedProducts();
        else bulkDeleteSelected();
        break;
      }
    }
  }
});

