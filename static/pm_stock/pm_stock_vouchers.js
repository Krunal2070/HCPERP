/* ── Theme ─────────────────────────────────────────────────────────────── */
function hcpApplyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('hcp_theme', t);
  // Update :root.light class for CSS compat
  if(t==='light'||t==='rose') document.documentElement.classList.add('light');
  else document.documentElement.classList.remove('light');
  // Update swatch active dots
  document.querySelectorAll('.hcp-swatch').forEach(s => {
    const dot = s.querySelector('.hcp-active-dot');
    const active = s.dataset.t === t;
    s.style.borderColor = active ? '#0d9488' : 'transparent';
    s.style.boxShadow   = active ? '0 0 0 3px rgba(13,148,136,.2)' : '';
    if(dot) dot.style.display = active ? 'block' : 'none';
  });
  const msg = document.getElementById('hcp-applied-msg');
  if(msg){ msg.style.display='block'; clearTimeout(window._hcpMsgTimer); window._hcpMsgTimer=setTimeout(()=>msg.style.display='none',2000); }
}
window.hcpApplyTheme = function(t){
  // PM Stock page is locked to light theme — ignore any other theme request
  document.documentElement.setAttribute('data-theme','light');
  document.documentElement.classList.add('light');
};

window.hcpOpenSettings = function(){
  // Theme settings hidden on PM Stock page
};
window.hcpCloseSettings = function(){
  const ol = document.getElementById('hcp-settings-overlay');
  if(ol) ol.style.display='none';
};
document.addEventListener('keydown', e => {
  if(e.key==='Escape'){ hcpCloseSettings(); }
});
// Always light on this page
document.documentElement.setAttribute('data-theme','light');
document.documentElement.classList.add('light');

/* ── Sticky Note ──────────────────────────────────────────────────────── */
function toggleStickyNote(){
  const el = document.getElementById('stickyNote');
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
  document.getElementById('stickyToggleBtn').style.background =
    isHidden ? 'rgba(253,224,71,0.2)' : '';
}
function saveStickyNote(){
  localStorage.setItem('pm_sticky_note', document.getElementById('stickyText').value);
}
// Load saved note
document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('pm_sticky_note');
  if(saved) document.getElementById('stickyText').value = saved;
});

// Make sticky note draggable
(function(){
  let el, handle, ox, oy, sx, sy, dragging=false;
  document.addEventListener('DOMContentLoaded', ()=>{
    el     = document.getElementById('stickyNote');
    handle = document.getElementById('stickyDragHandle');
    if(!handle) return;
    handle.addEventListener('mousedown', e=>{
      dragging=true; ox=e.clientX; oy=e.clientY;
      const r=el.getBoundingClientRect();
      sx=r.left; sy=r.top;
      el.style.right='auto'; el.style.bottom='auto';
      el.style.left=sx+'px'; el.style.top=sy+'px';
    });
    document.addEventListener('mousemove', e=>{
      if(!dragging) return;
      el.style.left=(sx+e.clientX-ox)+'px';
      el.style.top =(sy+e.clientY-oy)+'px';
    });
    document.addEventListener('mouseup', ()=>{ dragging=false; });
  });
})();

/* ── Reset DB (admin) — granular category-based clearing ──────────────── */
let _resetCats = [];   // categories returned from server
let _resetSel  = new Set();   // currently-selected category keys

async function openResetModal(){
  document.getElementById('resetConfirmText').value = '';
  _refreshResetButton();
  document.getElementById('resetModal').classList.add('open');
  await _loadResetCategories();
}

async function _loadResetCategories(){
  const list = document.getElementById('reset-cat-list');
  if(!list) return;
  list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px"><span class="spinner"></span> Loading…</div>`;
  try {
    const res = await fetch('/api/pm_stock/reset/categories');
    const d = await res.json();
    if(d.status !== 'ok'){
      list.innerHTML = `<div style="padding:18px;color:var(--red)">${d.message||'Failed to load'}</div>`;
      return;
    }
    _resetCats = d.categories || [];
    _renderResetCatList();
  } catch(e){
    list.innerHTML = `<div style="padding:18px;color:var(--red)">Error: ${e.message}</div>`;
  }
}

function _renderResetCatList(){
  const list = document.getElementById('reset-cat-list');
  if(!list) return;
  if(!_resetCats.length){
    list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">No categories</div>`;
    return;
  }
  list.innerHTML = _resetCats.map(c => {
    const checked = _resetSel.has(c.key);
    const danger  = (c.key === 'products' || c.key === 'boxes');
    const tableLine = c.tables.map(t => `${t.table} (${t.rows.toLocaleString('en-IN')})`).join(' · ');
    return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
      background:${checked ? (danger?'rgba(239,68,68,.06)':'rgba(13,148,136,.06)') : 'transparent'};
      border:1.5px solid ${checked ? (danger?'rgba(239,68,68,.35)':'rgba(13,148,136,.3)') : 'transparent'};
      border-radius:7px;cursor:pointer;margin-bottom:4px;transition:.12s">
      <input type="checkbox" ${checked?'checked':''} onchange="resetToggleCat('${c.key}',this.checked)"
        style="accent-color:${danger?'var(--red)':'var(--brand)'};width:15px;height:15px;margin-top:2px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <strong style="font-size:12.5px;color:${danger?'var(--red)':'var(--htxtb,#111)'}">${c.label}</strong>
          <span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;
            background:${c.total_rows>0?'rgba(245,158,11,.12)':'rgba(0,0,0,.06)'};
            color:${c.total_rows>0?'var(--floor-clr,#d97706)':'var(--hmuted,#9ca3af)'}">${c.total_rows.toLocaleString('en-IN')} row${c.total_rows===1?'':'s'}</span>
        </div>
        <div style="font-size:10.5px;color:var(--hmuted2,#6b7280);margin-top:2px;line-height:1.35">${c.desc}</div>
        <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-top:3px;font-family:var(--font-mono,monospace)">${tableLine}</div>
      </div>
    </label>`;
  }).join('');
}

function resetToggleCat(key, checked){
  if(checked) _resetSel.add(key);
  else        _resetSel.delete(key);
  _renderResetCatList();
  _refreshResetButton();
}

function resetPickPreset(name){
  _resetSel.clear();
  if(name === 'transactions'){
    _resetSel.add('transactions');
  } else if(name === 'vouchers'){
    ['transactions','transfers','grns','dns','boxes','audit'].forEach(k => _resetSel.add(k));
  } else if(name === 'full'){
    _resetCats.forEach(c => _resetSel.add(c.key));
  } else if(name === 'clear'){
    /* nothing — already cleared */
  }
  _renderResetCatList();
  _refreshResetButton();
}

function _refreshResetButton(){
  const inp = document.getElementById('resetConfirmText');
  const btn = document.getElementById('resetConfirmBtn');
  const lbl = document.getElementById('resetConfirmBtnLabel');
  if(!btn || !lbl) return;
  const typedOk = inp && inp.value.trim() === 'RESET';
  const hasSel  = _resetSel.size > 0;
  const ok      = typedOk && hasSel;
  btn.style.opacity      = ok ? '1' : '0.4';
  btn.style.pointerEvents = ok ? 'auto' : 'none';
  lbl.textContent = `Clear Selected (${_resetSel.size})`;
}

document.addEventListener('DOMContentLoaded', ()=>{
  const inp = document.getElementById('resetConfirmText');
  if(inp) inp.addEventListener('input', _refreshResetButton);
});

async function doResetSelected(){
  const cats = Array.from(_resetSel);
  if(!cats.length){ showToast('Pick at least one category','error'); return; }
  if(!confirm(`Permanently clear ${cats.length} categor${cats.length===1?'y':'ies'}?\n\n${cats.join(', ')}\n\nThis cannot be undone.`)) return;
  const btn = document.getElementById('resetConfirmBtn');
  const lbl = document.getElementById('resetConfirmBtnLabel');
  const orig = lbl.textContent;
  lbl.innerHTML = '<span class="spinner"></span> Clearing…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/pm_stock/reset/categories', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({categories: cats})
    });
    const data = await res.json();
    if(data.status === 'ok'){
      showToast(`✓ ${data.message}`,'success', 5000);
      if(data.errors && data.errors.length){
        // Show table-level errors so admin can see what didn't clear
        console.warn('Reset errors:', data.errors);
        showToast(`⚠ ${data.errors.length} table(s) had errors — see console`,'error', 6000);
      }
      closeModal('resetModal');
      _resetSel.clear();
      _summary = []; _logRows = [];
      if(cats.includes('products')) _products = [];
      if(typeof loadSummary === 'function') await loadSummary();
      if(cats.includes('products') && typeof loadProducts === 'function') {
        await loadProducts();
        if(typeof loadPmTypes === 'function') await loadPmTypes();
      }
    } else {
      showToast(data.message || 'Reset failed', 'error');
    }
  } catch(e){
    showToast('Error: '+e.message, 'error');
  } finally {
    lbl.textContent = orig;
    btn.disabled = false;
    _refreshResetButton();
  }
}

// Backward-compat — anything still calling doResetAll just opens the new modal
function doResetAll(){ return doResetSelected(); }
/* _gdName: show actual DB name */
function _gdName(name) { return name || '—'; }

/* ═══ MODAL UTILITIES ═══ */
function closeModal(id) { const e=document.getElementById(id); if(e) e.classList.remove('open'); }
function openModal(id)  { const e=document.getElementById(id); if(e) e.classList.add('open'); if(typeof applyHomeGodownLock === 'function') applyHomeGodownLock(); }
// Backdrop-click-to-close was previously enabled here. Disabled by user
// request — accidental clicks outside a modal would lose form state. Modals
// can still be closed via the X button, the Cancel button, or Escape key.
document.addEventListener('keydown', function(e) {
  if(e.key !== 'Escape') return;
  const openModals = Array.from(document.querySelectorAll('.modal-overlay.open'));
  if(openModals.length > 0) { openModals[openModals.length-1].classList.remove('open'); e.preventDefault(); }
});

/* ═══ UNIFIED VOUCHER MODAL ═══ */
let _pmvTab = 'grn';

async function pmvOpen(tab) {
  _pmvTab = tab || 'grn';
  const today = new Date().toISOString().slice(0,10);
  const sv = (id,v) => { const e=document.getElementById(id); if(e) e.value=v; };
  sv('grn-date',today); sv('grn-po-number',''); sv('grn-po-date','');
  sv('grn-supplier',''); sv('grn-supplier-text',''); sv('grn-remarks','');
  const gic=document.getElementById('grn-items-container'); if(gic) gic.innerHTML='';
  const gb=document.getElementById('pmv-grn-badge'); if(gb) gb.style.display='none';
  const gvb=document.getElementById('grn-vno-bar'); if(gvb) gvb.style.display='none';
  // Clear the saved-grn-id stash from any previous session. This dataset
  // attribute is set by saveGrn() so subsequent label prints inside the
  // same new-GRN modal session can look up real short_codes; we must
  // reset it on each modal open so a fresh GRN doesn't reuse stale state.
  const _pmModalRst = document.getElementById('pmVoucherModal');
  if(_pmModalRst && _pmModalRst.dataset) delete _pmModalRst.dataset.savedGrnId;
  // Reset staged-invoice-files list — fresh modal = fresh attachments.
  if(typeof pmGrnResetStagedFiles === 'function') pmGrnResetStagedFiles();
  sv('mtv-date',today);
  const mtvRem=document.getElementById('mtv-remarks'); if(mtvRem) mtvRem.value='';
  const mf=document.getElementById('mtv-from'); if(mf) mf.value='';
  const mt=document.getElementById('mtv-to'); if(mt) mt.value='';
  const mic=document.getElementById('mtv-items-container'); if(mic) mic.innerHTML='';
  const mb=document.getElementById('pmv-mtv-badge'); if(mb) mb.style.display='none';
  const mvb=document.getElementById('mtv-vno-bar'); if(mvb) mvb.style.display='none';
  if(!_godowns || _godowns.length===0) await loadGodowns();
  populateGodownSelects();
  pmvSwitchTab(_pmvTab);
  document.getElementById('pmVoucherModal').classList.add('open');
  if(_pmvTab==='grn') previewGrnVoucherNo(); else previewMtvVoucherNo();

  // ── Initialise supplier combo for the GRN pane ──
  // Load suppliers on first open; thereafter reuse the cached _supRows
  if(_pmvTab === 'grn') {
    const w = document.getElementById('grn-sup-wrap');
    if(w) {
      if(!_supRows || !_supRows.length) {
        loadSuppliers().then(() => _initSupplierCombo(w));
      } else {
        _initSupplierCombo(w);
      }
    }
  }

  requestAnimationFrame(() => {
    let row;
    if (_pmvTab==='grn') row = grnAddItem();
    else { const c=document.getElementById('mtv-items-container'); if(c) c.innerHTML=''; row = mtvAddItem(); }
    if (row) row.querySelector('.prod-combo-input')?.focus();
  });
}
function openGrnModal() { pmvOpen('grn'); }
function openMtvModal() { pmvMtvDeprecated(); }
function openGrnForm()  { pmvOpen('grn'); }
function openMtvForm()  { pmvMtvDeprecated(); }
function closeGrnForm() { closeModal('pmVoucherModal'); }
function closeMtvForm() { closeModal('pmVoucherModal'); }

// Called when anything tries to open MTV creation. Closes the unified
// voucher modal (if open), switches the page to Material Movement, and
// shows a brief explainer.
function pmvMtvDeprecated() {
  // Close unified voucher modal if it's currently shown
  closeModal('pmVoucherModal');
  if(typeof switchTab === 'function')      switchTab('mm');
  if(typeof setSidebarActive === 'function') setSidebarActive('mm');
  if(typeof showToast === 'function'){
    showToast('MTV is replaced by Material Movement — pick OUT or IN','info', 4500);
  }
}

function pmvSwitchTab(tab) {
  _pmvTab = tab;
  const isGrn = tab==='grn';
  const pg=document.getElementById('pmv-pane-grn');
  const pm=document.getElementById('pmv-pane-mtv');
  const fg=document.getElementById('pmv-footer-grn');
  const fm=document.getElementById('pmv-footer-mtv');
  const bg=document.getElementById('pmv-tab-btn-grn');
  const bm=document.getElementById('pmv-tab-btn-mtv');
  if(pg) pg.style.display=isGrn?'':'none';
  if(pm) pm.style.display=isGrn?'none':'';
  if(fg) fg.style.display=isGrn?'flex':'none';
  if(fm) fm.style.display=isGrn?'none':'flex';
  if(bg){bg.style.background=isGrn?'var(--teal,#0d9488)':'var(--surface2,#f8fafc)';bg.style.color=isGrn?'#fff':'var(--muted2,#6b7280)';}
  if(bm){bm.style.background=!isGrn?'rgba(245,158,11,.15)':'var(--surface2,#f8fafc)';bm.style.color=!isGrn?'var(--amber-text,#92400e)':'var(--muted2,#6b7280)';}
  if(isGrn) previewGrnVoucherNo(); else previewMtvVoucherNo();
}

function grnAddItem() {
  const c=document.getElementById('grn-items-container'); if(!c) return;
  const div=document.createElement('div');
  div.className='grn-item-row';
  // 9-col grid (added a 60px UOM slot between Total Qty and Remarks).
  div.style.cssText='display:grid;grid-template-columns:22px 1fr 100px 72px 72px 90px 60px 120px 28px;gap:5px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML=`
    <input type="checkbox" class="grn-item-sel" style="width:14px;height:14px;cursor:pointer;accent-color:var(--teal,#0d9488)">
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="gi-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="text" class="gi-version" maxlength="60" placeholder="version (optional)"
      title="Free-text version marker for this line — e.g. 'Old design', 'v2', 'New cap'. Shows as [VERSION] next to the product name on labels and printed vouchers."
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:11.5px;color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
    <input type="number" class="gi-boxes" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-boxcount" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-qty" min="0" step="1" placeholder="0"
      style="width:100%;background:rgba(13,148,136,.12);border:1.5px solid rgba(13,148,136,.35);border-radius:6px;padding:6px 4px;font-size:13px;font-weight:800;color:var(--teal,#0d9488);outline:none;text-align:right"
      title="Auto-calculated from No. of Box × Per Box Qty, or enter total directly">
    <select class="gi-uom" disabled title="Pick a product first"
      style="width:100%;background:var(--hsurf2,#f8fafc);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:11px;font-weight:700;color:var(--text,#111);outline:none;text-align:center">
      <option value="">—</option>
    </select>
    <input type="text" class="gi-remarks" placeholder="Optional…"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <button onclick="this.closest('.grn-item-row').remove()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center">✕</button>`;
  c.appendChild(div);
  // Wire the product picker — when a product is chosen, populate this row's
  // UOM dropdown with the product's Primary + (optional) Alternate, defaulting
  // to Primary. UOM is a pure label this phase (no conversion).
  _initProdCombo(div.querySelector('.prod-combo-wrap'), '.gi-qty', function(p){
    grnPopulateLineUom(div, p);
  });
  div.scrollIntoView({block:'nearest', behavior:'smooth'});
  return div;
}

// Populate a GRN line's UOM dropdown from the chosen product. Selected value
// defaults to the product's primary UOM. If the product has no alternate, the
// dropdown still works (just one option) — it's locked in primary either way.
// Defensive: if the passed `prod` is missing UOM fields (stale cache or partial
// payload from old code), fall back to looking up the current _products list
// by product_id so a fresh page load always shows the right UOMs.
function grnPopulateLineUom(rowEl, prod, preselectUom){
  const sel = rowEl?.querySelector?.('.gi-uom'); if(!sel) return;
  if(!prod || !prod.id){
    sel.innerHTML = '<option value="">—</option>'; sel.disabled = true;
    sel.style.background = 'var(--hsurf2,#f8fafc)';
    return;
  }
  // Resolve a "fresh" product record so we have the latest UOM fields even
  // if the caller passed an older snapshot.
  let p = prod;
  if((!p.primary_uom || !p.primary_uom.trim()) && Array.isArray(window._products)){
    const found = window._products.find(x => String(x.id) === String(p.id));
    if(found) p = Object.assign({}, p, found);
  }
  const primary = (p.primary_uom || 'Nos').toString().trim() || 'Nos';
  const alt     = (p.alt_uom     || '').toString().trim();
  let html = `<option value="${primary}">${primary}</option>`;
  if(alt && alt.toLowerCase() !== primary.toLowerCase()){
    html += `<option value="${alt}">${alt}</option>`;
  }
  sel.innerHTML = html;
  sel.disabled = false;
  sel.style.background = 'var(--hinput,#fff)';
  // Preselect a stored UOM if reloading (Edit modal); otherwise primary.
  const want = (preselectUom || '').toString().trim();
  sel.value = (want && [primary, alt].some(u => u && u.toLowerCase() === want.toLowerCase()))
            ? want : primary;
}
window.grnPopulateLineUom = grnPopulateLineUom;
function grnClearForm() {
  const today=new Date().toISOString().slice(0,10);
  ['grn-po-number','grn-supplier','grn-remarks'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('grn-date').value=today;
  document.getElementById('grn-po-date').value='';
  // Auto-fill supervisor with logged-in user
  const supEl=document.getElementById('grn-supervisor'); if(supEl) supEl.value=_loginUserName();
  document.getElementById('grn-items-container').innerHTML='';
  grnAddItem();
}

/* ── Get logged-in user's display name from the topbar DOM ──
   Falls back to 'Unknown' if DOM element not found.
   This is always correct because Flask rendered {{ user_name }}
   into .user-name when the page loaded.
─────────────────────────────────────────────────────────── */
function _loginUserName() {
  return (document.querySelector('.user-name')?.textContent || '').trim() || 'Unknown';
}
function clearGrnForm() { grnClearForm(); }
function clearGrnFilters() {
  ['grn-from','grn-to','grn-search'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  _grnRows=[];
  const tb=document.getElementById('grnListTbody');
  if(tb) tb.innerHTML=`<tr><td colspan="12" class="no-data">Set date range and click Fetch</td></tr>`;
  const pg=document.getElementById('grnPag'); if(pg) pg.innerHTML='';
}

async function saveGrn() {
  const grnDate=document.getElementById('grn-date').value;
  const godownId=document.getElementById('grn-godown').value;
  // Supplier: visible text is source of truth, hidden is fallback
  const supplier=(document.getElementById('grn-supplier-text')?.value
               || document.getElementById('grn-supplier')?.value || '').trim();
  const poNum=document.getElementById('grn-po-number')?.value?.trim()||null;
  const poDate=document.getElementById('grn-po-date')?.value||null;
  const remarks=document.getElementById('grn-remarks').value.trim();
  const supervisorName=document.getElementById('grn-supervisor')?.value?.trim()||null;
  const partyInvoiceNo=document.getElementById('grn-party-invoice-no')?.value?.trim()||null;
  const partyInvoiceDate=document.getElementById('grn-party-invoice-date')?.value||null;
  if(!grnDate){showToast('Select GRN date','error');return;}
  if(!godownId){showToast('Select receiving location','error');return;}
  const items=[];
  document.querySelectorAll('#grn-items-container .grn-item-row').forEach(row=>{
    const pid=parseInt(row.querySelector('.gi-product')?.value)||0;
    const qty=parseFloat(row.querySelector('.gi-qty')?.value)||0;
    let noOfBox=parseInt(row.querySelector('.gi-boxes')?.value)||0;
    let boxCount=parseInt(row.querySelector('.gi-boxcount')?.value)||0;
    const rem=row.querySelector('.gi-remarks')?.value?.trim()||'';
    const pver=row.querySelector('.gi-version')?.value?.trim()||'';
    // UOM label (Phase 2) — pure metadata; not used for any conversion.
    const euom=(row.querySelector('.gi-uom')?.value||'').trim()||null;
    // If user entered only total qty, default to 1 box of that qty
    if(qty > 0 && noOfBox === 0 && boxCount === 0) {
      noOfBox = 1;
      boxCount = qty;
    }
    if(pid&&qty>0) items.push({
      product_id:pid, qty_received:qty,
      no_of_box:noOfBox, box_count:boxCount,
      remarks:rem, product_version:pver,
      entered_uom: euom,
    });
  });
  if(!items.length){showToast('Add at least one item with qty > 0','error');return;}
  const btn=document.getElementById('grn-save-btn');
  const orig=btn.innerHTML; btn.innerHTML='<span class="spinner"></span> Saving…'; btn.disabled=true;
  try{
    const res=await fetch('/api/pm_stock/grn/save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({grn_date:grnDate,godown_id:parseInt(godownId),supplier,po_number:poNum,po_date:poDate,remarks,
                           supervisor_name:supervisorName,party_invoice_no:partyInvoiceNo,
                           party_invoice_date:partyInvoiceDate,items})});
    const data=await res.json();
    if(data.status==='ok'){
      showToast(`✓ PM GRN ${data.grn_no} saved — ${items.length} item(s)`,'success',5000);
      const badge=document.getElementById('pmv-grn-badge');
      if(badge){badge.textContent=data.grn_no;badge.style.display='';}
      const vnoBar=document.getElementById('grn-vno-bar');
      const vnoDisp=document.getElementById('grn-vno-display');
      if(vnoBar&&vnoDisp){vnoDisp.textContent=data.grn_no;vnoBar.style.display='flex';}
      // Stash the freshly-minted GRN id on the modal element so grnOpenLabels
      // can find it for the short_code fetch + FIFO lookup. The save endpoint
      // returns the new row's id as `id` (not grn_id).
      const _pmModal = document.getElementById('pmVoucherModal');
      const newGrnId = data.id || data.grn_id;
      if(_pmModal && newGrnId) _pmModal.dataset.savedGrnId = String(newGrnId);

      // Stamp each item row with its newly-created grn_item_id so the
      // label printer can look up short codes by item id rather than by
      // (product_id, sequence) — the latter produces duplicate QR codes
      // when the same product appears on multiple lines of the GRN.
      // data.item_ids is parallel to the items[] payload we sent above:
      // one entry per row, with `null` for rows that got skipped server-
      // side (no product / zero qty).
      if(Array.isArray(data.item_ids)){
        const rows = document.querySelectorAll('#grn-items-container .grn-item-row');
        // The items[] array we sent was built by skipping rows with no
        // pid or zero qty, so a direct row→id mapping by index would be
        // off. Re-walk in the same skip pattern to align them.
        let ix = 0;
        rows.forEach(row => {
          const pid = parseInt(row.querySelector('.gi-product')?.value)||0;
          const qty = parseFloat(row.querySelector('.gi-qty')?.value)||0;
          if(pid && qty > 0){
            const id = data.item_ids[ix];
            if(id) row.dataset.grnItemId = String(id);
            ix++;
          }
        });
      }

      // Upload any staged invoice files to the freshly-created GRN.
      // The new-GRN modal stages files in memory (no grn_id yet); after
      // save succeeds we walk that array and POST each one to the
      // existing /api/pm_stock/grn/file/upload endpoint shared with the
      // edit modal. Failures toast per-file but don't block the rest of
      // the save flow.
      if(typeof pmGrnUploadStagedFilesFor === 'function'
         && (window._pmGrnStagedInvoiceFiles || []).length
         && newGrnId){
        try {
          const upRes = await pmGrnUploadStagedFilesFor(newGrnId);
          if(upRes && upRes.uploaded > 0){
            showToast(`📎 ${upRes.uploaded} invoice file${upRes.uploaded>1?'s':''} attached`, 'success', 4000);
          }
        } catch(_) { /* uploader toasts per-file errors */ }
      }

      if(confirm(`PM GRN ${data.grn_no} saved.\n\nPrint now?`))
        pmGrnPrint({grn_no:data.grn_no, supervisor_name:supervisorName, created_by:_loginUserName(),
                    party_invoice_no:partyInvoiceNo, party_invoice_date:partyInvoiceDate},items,grnDate,supplier,godownId,poNum,poDate,remarks);
      closeModal('pmVoucherModal');
      // Set list filter to today so the new voucher is visible
      const _today = new Date().toISOString().slice(0,10);
      const _gf = document.getElementById('grn-from'); if(_gf && !_gf.value) _gf.value = _today;
      const _gt = document.getElementById('grn-to');   if(_gt && !_gt.value) _gt.value = _today;
      loadGrnList();
      await loadSummary();
    }else showToast(data.message||'Error saving GRN','error');
  }catch(e){showToast('Error: '+e.message,'error');}
  finally{btn.innerHTML=orig;btn.disabled=false;}
}

/* ─── MTV (legacy Material Transfer Voucher) ─────────────────────────────
   Coexists with the newer scan-based Material Transfer system (pm_transfers).
   Both create/edit/save/print flows are fully functional.
   ─────────────────────────────────────────────────────────────────────────  */
function mtvAddItem() {
  const c=document.getElementById('mtv-items-container'); if(!c) return;
  const div=document.createElement('div');
  div.className='mtv-item-row';
  div.style.cssText='display:grid;grid-template-columns:1fr 120px 28px;gap:6px;padding:6px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML=`
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="mi-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="mi-qty" min="1" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:right;margin-top:1px">
    <button onclick="this.closest('.mtv-item-row').remove()"
      style="width:24px;height:24px;border-radius:5px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22);color:#ef4444;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:3px">✕</button>`;
  c.appendChild(div);
  _initProdCombo(div.querySelector('.prod-combo-wrap'), '.mi-qty');
  div.scrollIntoView({block:'nearest', behavior:'smooth'});
  return div;
}
function mtvClearForm() {
  const today=new Date().toISOString().slice(0,10);
  document.getElementById('mtv-date').value=today;
  const r=document.getElementById('mtv-remarks'); if(r) r.value='';
  const mf=document.getElementById('mtv-from'); if(mf) mf.value='';
  const mt=document.getElementById('mtv-to'); if(mt) mt.value='';
  const mic=document.getElementById('mtv-items-container'); if(mic) mic.innerHTML='';
  mtvAddItem();
}
function clearMtvForm() { mtvClearForm(); }
function clearMtvFilters() { /* no-op */ }
function _mtvLocType(godownId) {
  // Returns 'floor' if location is factory/floor, else 'godown'
  // Uses is_floor flag set by the backend based on actual transaction data
  const g = (_godowns||[]).find(x => String(x.id) === String(godownId));
  return (g && (g.godown_type === 'floor' || g.is_floor)) ? 'floor' : 'godown';
}
function mtvCheckSameLoc() {
  const fromGd=document.getElementById('mtv-from')?.value;
  const toGd=document.getElementById('mtv-to')?.value;
  const same=fromGd&&toGd&&fromGd===toGd;
  const wF=document.getElementById('mtv-same-loc-warn');
  const wT=document.getElementById('mtv-same-loc-warn-to');
  if(wF) wF.style.display=same?'':'none';
  if(wT) wT.style.display=same?'':'none';
  const mf=document.getElementById('mtv-from');
  const mt=document.getElementById('mtv-to');
  if(mf) mf.style.borderColor=same?'#ef4444':'rgba(245,158,11,.3)';
  if(mt) mt.style.borderColor=same?'#ef4444':'rgba(13,148,136,.3)';
  // Auto-detect and set from_type / to_type from the selected location's godown_type
  const ftEl=document.getElementById('mtv-from-type');
  const ttEl=document.getElementById('mtv-to-type');
  if(ftEl) ftEl.value = fromGd ? _mtvLocType(fromGd) : 'godown';
  if(ttEl) ttEl.value = toGd   ? _mtvLocType(toGd)   : 'godown';
}
async function saveMtv() {
  const mtvDate=document.getElementById('mtv-date').value;
  const fromGd=document.getElementById('mtv-from').value;
  const toGd=document.getElementById('mtv-to').value;
  const fromType=_mtvLocType(fromGd);
  const toType=_mtvLocType(toGd);
  const r=document.getElementById('mtv-remarks');
  const remarks=r?r.value.trim():'';
  if(!mtvDate){showToast('Select transfer date','error');return;}
  if(!fromGd){showToast('Select source location','error');return;}
  if(!toGd){showToast('Select destination location','error');return;}
  if(String(fromGd)===String(toGd)){showToast('Source and destination cannot be the same','error');return;}
  const items=[];
  document.querySelectorAll('#mtv-items-container .mtv-item-row').forEach(row=>{
    const pid=parseInt(row.querySelector('.mi-product')?.value)||0;
    const qty=parseFloat(row.querySelector('.mi-qty')?.value)||0;
    if(pid&&qty>0) items.push({product_id:pid,qty,remarks:''});
  });
  if(!items.length){showToast('Add at least one item with qty > 0','error');return;}
  const btn=document.getElementById('mtv-save-btn');
  const orig=btn.innerHTML; btn.innerHTML='<span class="spinner"></span> Saving…'; btn.disabled=true;
  try{
    const res=await fetch('/api/pm_stock/mtv/save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mtv_date:mtvDate,from_godown:parseInt(fromGd),to_godown:parseInt(toGd),
        from_type:fromType,to_type:toType,remarks,items})});
    const data=await res.json();
    if(data.status==='ok'){
      showToast(`✓ Transfer Voucher ${data.mtv_no} saved — ${items.length} item(s)`,'success',5000);
      const badge=document.getElementById('pmv-mtv-badge');
      if(badge){badge.textContent=data.mtv_no;badge.style.display='';}
      const vnoBar=document.getElementById('mtv-vno-bar');
      const vnoDisp=document.getElementById('mtv-vno-display');
      if(vnoBar&&vnoDisp){vnoDisp.textContent=data.mtv_no;vnoBar.style.display='flex';}
      if(confirm(`MTV ${data.mtv_no} saved.\n\nPrint now?`))
        pmMtvPrint(data.mtv_no,mtvDate,parseInt(toGd),toType,[{from_godown:parseInt(fromGd),from_type:fromType,items}],remarks);
      closeModal('pmVoucherModal');
      // Set list filter to today so the new voucher is visible
      const _today2 = new Date().toISOString().slice(0,10);
      const _mf = document.getElementById('mtv-from-date'); if(_mf && !_mf.value) _mf.value = _today2;
      const _mt = document.getElementById('mtv-to-date');   if(_mt && !_mt.value) _mt.value = _today2;
      loadMtvList();
      await loadSummary();
    }else showToast(data.message||'Error saving transfer','error');
  }catch(e){showToast('Error: '+e.message,'error');}
  finally{btn.innerHTML=orig;btn.disabled=false;}
}


/* ═══ VOUCHER NUMBER PREVIEW ═══ */
async function fetchNextVoucherNo(type) {
  try{
    const res=await fetch(`/api/pm_stock/voucher_numbering/next_preview?type=${type}`);
    if(!res.ok) return null;
    const d=await res.json();
    return d.preview||null;
  }catch(e){return null;}
}
async function previewGrnVoucherNo() {
  const bar=document.getElementById('grn-vno-bar');
  const disp=document.getElementById('grn-vno-display');
  if(!bar||!disp) return;
  disp.textContent='…'; bar.style.display='flex';
  const vno=await fetchNextVoucherNo('pm_grn');
  if(vno){disp.textContent=vno;bar.style.display='flex';}
  else bar.style.display='none';
}
async function previewMtvVoucherNo() {
  const bar=document.getElementById('mtv-vno-bar');
  const disp=document.getElementById('mtv-vno-display');
  if(!bar||!disp) return;
  disp.textContent='…'; bar.style.display='flex';
  const vno=await fetchNextVoucherNo('pm_mtv');
  if(vno){disp.textContent=vno;bar.style.display='flex';}
  else bar.style.display='none';
}

/* ═══ PM VOUCHER NUMBERING ═══
   Tabs in this map drive the modal at pmVnModal. Order = order shown.
   Backend allows pm_grn, pm_dn, pm_mt, pm_mtv, pm_al, pm_aud, pm_op.
   Internal-only ledger types (pm_gtxn, pm_ftxn) are excluded — those are
   system-created movements, not user-facing vouchers.
   If no style is configured for a type, _next_voucher_no falls back to
   pm_voucher_sequences (built-in defaults) so creating that voucher type
   continues to work without admin intervention. */
const _PMVN_TYPES={
  'pm_grn': 'PM GRN',
  'pm_dn':  'Delivery Note',
  'pm_mt':  'Material Transfer',
  'pm_mtv': 'Transfer (MTV legacy)',
  'pm_al':  'Allotment',
  'pm_aud': 'Audit Session',
  'pm_op':  'Opening Stock',
  'pm_mr':  'Material Request',
};
let _pmvnType='pm_grn', _pmvnEditId=null, _pmvnData=[];
function pmvOpenVoucherSettings(){pmvnLoad();}
function openVoucherNumSettings(){pmvnLoad();}
function saveVoucherSettings(){}
async function pmvnLoad(){
  try{const r=await fetch('/api/pm_stock/voucher_numbering/list');const d=await r.json();_pmvnData=d.styles||[];}catch(e){_pmvnData=[];}
  _pmvnType='pm_grn';_pmvnEditId=null;
  pmvnRenderTabs();pmvnRenderList();pmvnHideForm();
  document.getElementById('pmVnModal').classList.add('open');
}
function pmvnRenderTabs(){
  const bar=document.getElementById('pmvn-tabs');if(!bar)return;
  bar.innerHTML=Object.entries(_PMVN_TYPES).map(([t,l])=>{
    const a=t===_pmvnType;
    return`<button onclick="pmvnSwitchType('${t}')" style="height:28px;padding:0 13px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid ${a?'var(--teal,#0d9488)':'var(--border2,rgba(0,0,0,.13))'};background:${a?'rgba(13,148,136,.1)':'transparent'};color:${a?'var(--teal,#0d9488)':'var(--muted,#9ca3af)'}">${l}</button>`;
  }).join('');
}
function pmvnSwitchType(t){_pmvnType=t;_pmvnEditId=null;pmvnRenderTabs();pmvnRenderList();pmvnHideForm();}
function pmvnRenderList(){
  const list=document.getElementById('pmvn-list');if(!list)return;
  const today=new Date().toISOString().slice(0,10);
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fd=d=>{if(!d)return'—';const p=String(d).split('-');return p[2]+'/'+p[1]+'/'+p[0];};
  const rows=_pmvnData.filter(s=>s.voucher_type===_pmvnType);
  if(!rows.length){list.innerHTML=`<div style="padding:14px;text-align:center;color:var(--muted,#9ca3af);font-size:12px">No styles for <strong>${_PMVN_TYPES[_pmvnType]}</strong>. Click "Add Numbering Style" below.</div>`;return;}
  list.innerHTML=rows.map(s=>{
    const preview=[s.prefix,String(s.start_num||1).padStart(s.digits||4,'0'),s.suffix].filter(Boolean).join('/');
    const active=s.valid_from<=today&&s.valid_to>=today;
    return`<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid ${active?'rgba(13,148,136,.35)':'var(--border2,rgba(0,0,0,.13))'};border-radius:8px;background:${active?'rgba(13,148,136,.04)':'transparent'};margin-bottom:6px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <span style="font-family:var(--font-mono,monospace);font-size:13px;font-weight:700;color:${active?'var(--teal,#0d9488)':'var(--text,#111)'}">${preview}</span>
          ${active?'<span style="font-size:9px;font-weight:800;padding:1px 7px;border-radius:10px;background:var(--teal,#0d9488);color:#fff">Active</span>':''}
        </div>
        <div style="font-size:10px;color:var(--muted,#9ca3af)">Prefix: <strong>${s.prefix||'—'}</strong> · Suffix: <strong>${s.suffix||'—'}</strong> · ${s.digits||4} digits · ${fd(s.valid_from)} → ${fd(s.valid_to)}</div>
      </div>
      <button onclick="pmvnStartEdit(${s.id})" style="width:26px;height:26px;border-radius:5px;border:1px solid var(--border2,rgba(0,0,0,.13));background:transparent;cursor:pointer;font-size:13px">✏️</button>
      <button onclick="pmvnDelete(${s.id})" style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25);cursor:pointer;font-size:13px;color:#ef4444">🗑</button>
    </div>`;
  }).join('');
}
function pmvnStartAdd(){
  _pmvnEditId=null;
  document.getElementById('pmvn-form-title').textContent=`New Style — ${_PMVN_TYPES[_pmvnType]}`;
  ['pmvn-prefix','pmvn-suffix','pmvn-from','pmvn-to'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('pmvn-digits').value='4';
  document.getElementById('pmvn-start').value='1';
  pmvnUpdatePreview();
  document.getElementById('pmvn-form').style.display='';
  document.getElementById('pmvn-prefix').focus();
}
function pmvnStartEdit(id){
  const s=_pmvnData.find(x=>x.id===id);if(!s)return;
  _pmvnEditId=id;
  document.getElementById('pmvn-form-title').textContent=`Edit Style #${id}`;
  document.getElementById('pmvn-prefix').value=s.prefix||'';
  document.getElementById('pmvn-suffix').value=s.suffix||'';
  document.getElementById('pmvn-digits').value=s.digits||4;
  document.getElementById('pmvn-start').value=s.start_num||1;
  document.getElementById('pmvn-from').value=s.valid_from||'';
  document.getElementById('pmvn-to').value=s.valid_to||'';
  pmvnUpdatePreview();
  document.getElementById('pmvn-form').style.display='';
}
function pmvnHideForm(){_pmvnEditId=null;const f=document.getElementById('pmvn-form');if(f)f.style.display='none';}
function pmvnCancelEdit(){pmvnHideForm();}
function pmvnUpdatePreview(){
  const prefix=(document.getElementById('pmvn-prefix')?.value||'').trim().toUpperCase();
  const suffix=(document.getElementById('pmvn-suffix')?.value||'').trim().toUpperCase();
  const digits=parseInt(document.getElementById('pmvn-digits')?.value)||4;
  const start=parseInt(document.getElementById('pmvn-start')?.value)||1;
  const el=document.getElementById('pmvn-preview');
  if(el)el.textContent=[prefix,String(start).padStart(digits,'0'),suffix].filter(Boolean).join('/');
}
async function pmvnSaveStyle(){
  const prefix=(document.getElementById('pmvn-prefix').value||'').trim().toUpperCase();
  const suffix=(document.getElementById('pmvn-suffix').value||'').trim().toUpperCase();
  const digits=parseInt(document.getElementById('pmvn-digits').value)||4;
  const start=parseInt(document.getElementById('pmvn-start').value)||1;
  const from=document.getElementById('pmvn-from').value;
  const to=document.getElementById('pmvn-to').value;
  if(!from||!to){showToast('Valid From and Valid To required','error');return;}
  if(from>to){showToast('Valid From must be before Valid To','error');return;}
  const payload={voucher_type:_pmvnType,prefix,suffix,digits,start_num:start,valid_from:from,valid_to:to};
  if(_pmvnEditId)payload.id=_pmvnEditId;
  try{
    const res=await fetch('/api/pm_stock/voucher_numbering/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await res.json();
    if(d.status==='ok'){
      showToast('✓ Voucher numbering style saved','success');
      try{const r2=await fetch('/api/pm_stock/voucher_numbering/list');const d2=await r2.json();_pmvnData=d2.styles||[];}catch(_){}
      pmvnRenderList();pmvnHideForm();
    }else showToast(d.message||'Error','error');
  }catch(e){showToast('Error: '+e.message,'error');}
}
async function pmvnDelete(id){
  if(!confirm('Delete this numbering style?'))return;
  try{
    const res=await fetch('/api/pm_stock/voucher_numbering/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const d=await res.json();
    if(d.status==='ok'){showToast('Style deleted','success');_pmvnData=_pmvnData.filter(s=>s.id!==id);pmvnRenderList();}
    else showToast(d.message||'Error','error');
  }catch(e){showToast('Error: '+e.message,'error');}
}

/* ═══ PRINT FUNCTIONS ═══ */
function pmGrnPrint(data,items,grnDate,supplier,godownId,poNum,poDate,remarks){
  // Invoice fields ride along on `data` (party_invoice_no / party_invoice_date)
  // so existing call sites that don't pass them still work.
  const partyInvoiceNo   = data.party_invoice_no   || '';
  const partyInvoiceDate = data.party_invoice_date || '';
  const godown=(_godowns||[]).find(g=>String(g.id)===String(godownId));
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fd=d=>{if(!d)return'—';const p=String(d).split('-');return p[2]+'/'+p[1]+'/'+p[0];};
  const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dash=v=>(v&&String(v).trim())?esc(String(v).trim()):'<span style="color:#bbb">—</span>';
  const grnNo=data.grn_no;
  const total=items.reduce((s,i)=>s+(i.qty_received||0),0);

  // ── Look up full supplier details from cached _supRows (loaded on page init) ──
  const sup = (window._supRows||[]).find(s =>
    (s.supplier_name||'').trim().toLowerCase() === (supplier||'').trim().toLowerCase()
  );

  // Build the HCP "Receiver" address line (godown address + city + state + pincode)
  const rcvrAddressLine = [godown?.address, godown?.city, godown?.state, godown?.pincode]
    .filter(p => p && String(p).trim()).join(', ');

  const supBlock = `
    <div class="party-row">
      <!-- Shipper / Supplier block -->
      <div class="pbox pbox-from">
        <div class="pbox-hdr">
          <span class="pbox-role">From (Shipper)</span>
          <span class="pbox-title">Supplier Details</span>
          ${sup?.supplier_code ? `<span class="pbox-code">${esc(sup.supplier_code)}</span>` : ''}
        </div>
        <div class="pbox-grid">
          <div class="sbc"><div class="sbl">Supplier Name</div><div class="sbv bold">${dash(supplier)}</div></div>
          <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(sup?.contact_person)}</div></div>
          <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(sup?.phone)}</div></div>
          <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(sup?.email)}</div></div>
          <div class="sbc"><div class="sbl">GST Number</div><div class="sbv mono">${dash(sup?.gst_number)}</div></div>
          <div class="sbc"><div class="sbl">PAN</div><div class="sbv mono">${dash(sup?.pan_number)}</div></div>
          <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(sup?.address)}</div></div>
          <div class="sbc wide"><div class="sbl">Payment Terms</div><div class="sbv">${dash(sup?.payment_terms)}</div></div>
        </div>
      </div>

      <!-- Receiver / HCP godown block -->
      <div class="pbox pbox-to">
        <div class="pbox-hdr">
          <span class="pbox-role">To (Receiver)</span>
          <span class="pbox-title">HCP Wellness Pvt Ltd</span>
        </div>
        <div class="pbox-grid">
          <div class="sbc"><div class="sbl">Receiving Location</div><div class="sbv bold">${dash(godown?.name)}</div></div>
          <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(godown?.contact)}</div></div>
          <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(godown?.phone)}</div></div>
          <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(godown?.email)}</div></div>
          <div class="sbc wide"><div class="sbl">Supervisor (Unloading)</div><div class="sbv">${dash(data.supervisor_name)}</div></div>
          <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(rcvrAddressLine)}</div></div>
        </div>
      </div>
    </div>`;

  const itemRows=items.map((it,i)=>{
    // Prefer the product_name the API returned directly — it's authoritative
    // and always present. Fall back to the global _products list only if the
    // server didn't include the name (older code paths) AND _products is
    // already loaded. Earlier bug: this was the ONLY source, so if _products
    // hadn't been loaded yet (user opened print before visiting Products tab)
    // or if id types disagreed (string vs int), the name printed as "—".
    const prod=(_products||[]).find(p=>p.id==it.product_id);   // == on purpose: tolerate string/int mismatch
    const pName = it.product_name || prod?.product_name || '—';
    const pType = it.pm_type      || prod?.pm_type      || '';
    const nb = parseInt(it.no_of_box)||0;
    const bc = parseInt(it.box_count)||0;
    const nbStr = nb>0 ? nb.toLocaleString('en-IN') : '<span style="color:#bbb">—</span>';
    const bcStr = bc>0 ? bc.toLocaleString('en-IN') : '<span style="color:#bbb">—</span>';
    // Append [VERSION] when the per-line product_version is set —
    // mirrors what shows on the box labels so the printed GRN stays
    // consistent with the physical labels.
    const _ver = (it.product_version || '').trim();
    const _nameHtml = `<strong>${esc(pName)}</strong>`
                    + (_ver ? ` <span style="font-weight:800;color:#5b21b6">[${esc(_ver.toUpperCase())}]</span>` : '');
    // UOM (Phase 3) — show what the user picked on the GRN line. If empty
    // (legacy GRN created before UOM existed), fall back to the product's
    // current primary UOM so the column never prints blank. Pure label;
    // no conversion applied to the qty.
    const _uomTxt = ((it.entered_uom || '').trim()) || (it.primary_uom) || ((prod && prod.primary_uom) || 'Nos');
    return`<tr><td class="c">${i+1}</td><td>${_nameHtml}<br><span style="font-size:8.5px;color:#555">${esc(pType)}</span></td><td class="r">${nbStr}</td><td class="r">${bcStr}</td><td class="r">${(it.qty_received||0).toLocaleString('en-IN')}</td><td style="text-align:center;font-weight:700;color:#000">${esc(_uomTxt)}</td><td>${esc(it.remarks||'—')}</td></tr>`;
  }).join('');

  const CSS=`*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:Arial,sans-serif;font-size:11px;color:#000;padding:18px 24px;background:#fff}
  .hd{display:flex;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:8px}
  .co{font-size:18px;font-weight:900;color:#000}
  .vno{font-size:13px;font-weight:800;font-family:monospace;color:#000}
  .bar{display:grid;border:1px solid #000;border-top:none}
  .b4{grid-template-columns:repeat(4,1fr)}
  .b3{grid-template-columns:repeat(3,1fr)}
  .b2{grid-template-columns:repeat(2,1fr)}
  .bc{padding:5px 9px;border-right:1px solid #000}
  .bc:last-child{border-right:none}
  .bl{font-size:7px;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:.6px}
  .bv{font-size:11px;font-weight:600;color:#000}

  /* Party details: supplier + receiver side by side */
  .party-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
  .pbox{border-radius:0;overflow:hidden;background:#fff;border:1px solid #000}
  .pbox-from{border-color:#000;background:#fff}
  .pbox-to{border-color:#000;background:#fff}
  .pbox-hdr{padding:4px 10px;font-size:9px;font-weight:800;color:#fff;background:#000;
    text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pbox-role{background:rgba(255,255,255,.22);padding:1px 8px;border-radius:0;font-size:7.5px;letter-spacing:.3px;border:1px solid rgba(255,255,255,.4)}
  .pbox-title{flex:1;font-size:10px}
  .pbox-code{background:rgba(255,255,255,.22);padding:1px 8px;border-radius:0;font-size:8.5px;letter-spacing:.3px;border:1px solid rgba(255,255,255,.4)}
  .pbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .pbox-from .sbc, .pbox-to .sbc{border-right:1px solid #000;border-bottom:1px solid #000}
  .sbc{padding:5px 10px}
  .pbox-grid .sbc:nth-child(2n){border-right:none}
  .sbc.wide{grid-column:1/-1;border-right:none}
  .sbl{font-size:6.5px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:1px}
  .sbv{font-size:9.5px;font-weight:600;color:#000;word-break:break-word}
  .sbv.bold{font-size:10.5px;font-weight:800;color:#000}
  .sbv.mono{font-family:'Courier New',monospace;font-size:9px}

  table{width:100%;border-collapse:collapse;margin-top:8px;border:1px solid #000}
  thead tr{background:#000 !important}
  th{color:#fff;padding:6px 8px;font-size:8px;font-weight:700;text-transform:uppercase;background:#000}
  tr{border-bottom:1px solid #000}
  tbody tr:nth-child(odd){background:#f2f2f2}
  td{padding:6px 8px;font-size:10.5px;vertical-align:top;color:#000}
  .c{text-align:center;color:#666;width:24px}
  .r{text-align:right;font-family:monospace}
  .sig{display:grid;grid-template-columns:1fr 1fr;border:1px solid #000;border-top:none}
  .sb{padding:10px;border-right:1px solid #000;min-height:50px}
  .sb:last-child{border-right:none}
  .sl{font-size:7px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
  .ft{text-align:center;font-size:8.5px;color:#666;margin-top:8px;border-top:1px solid #000;padding-top:5px}
  @media print{body{padding:8px 14px}button{display:none!important}}`;

  const win=window.open('','_blank','width=850,height=650');
  if(!win){showToast('Pop-up blocked','error');return;}

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${esc(grnNo)}</title><style>${CSS}</style></head><body>

  <div class="hd">
    <div>
      <div class="co">PM Goods Receipt Note</div>
      <div style="font-size:8px;color:#666;text-transform:uppercase">HCP Wellness Pvt Ltd</div>
    </div>
    <div class="vno">${esc(grnNo)} | ${fd(grnDate)}</div>
  </div>

  ${(poNum || partyInvoiceNo || remarks) ? `<div class="bar b3" style="grid-template-columns:repeat(${(poNum?2:0)+(partyInvoiceNo?2:0)+1},1fr)">
    ${poNum ? `<div class="bc"><div class="bl">PO Ref</div><div class="bv">${esc(poNum)}</div></div>
    <div class="bc"><div class="bl">PO Date</div><div class="bv">${fd(poDate)}</div></div>` : ''}
    ${partyInvoiceNo ? `<div class="bc"><div class="bl">Invoice No</div><div class="bv">${esc(partyInvoiceNo)}</div></div>
    <div class="bc"><div class="bl">Invoice Date</div><div class="bv">${fd(partyInvoiceDate)}</div></div>` : ''}
    <div class="bc"><div class="bl">Remarks</div><div class="bv">${esc(remarks||'—')}</div></div>
  </div>` : ''}

  ${supBlock}

  <table>
    <thead><tr>
      <th class="c">#</th>
      <th style="text-align:left">Product</th>
      <th class="r" style="width:70px">No. of Box</th>
      <th class="r" style="width:80px">Per Box Qty</th>
      <th class="r" style="width:90px">Total Qty</th>
      <th style="width:60px;text-align:center">UOM</th>
      <th style="text-align:left">Remarks</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
    <tfoot><tr style="background:#e8e8e8;font-weight:800;border-top:2px solid #000">
      <td colspan="4" style="padding:6px 8px;font-size:10px">Total — ${items.length} item(s)</td>
      <td class="r" style="padding:6px 8px">${total.toLocaleString('en-IN')}</td>
      <td></td>
      <td></td>
    </tr></tfoot>
  </table>

  <div class="sig">
    <div class="sb"><div class="sl">Prepared By</div></div>
    <div class="sb"><div class="sl">Received By</div></div>
  </div>

  <div class="ft">PM GRN ${esc(grnNo)} · HCP Wellness Pvt Ltd · ${new Date().toLocaleString('en-IN')}</div>

  <br>
  <button onclick="window.print()" style="padding:6px 14px;background:#000;color:#fff;border:none;border-radius:0;cursor:pointer">🖨 Print</button>
  </body></html>`);

  win.document.close();
  win.onload=()=>{win.focus();win.print();};
}
async function pmGrnPrintById(id){
  try{
    showToast('Loading GRN…','info',1500);
    // Ensure suppliers are loaded so pmGrnPrint can pull full details into the supplier box
    if(typeof loadSuppliers === 'function' && (!window._supRows || !window._supRows.length)) {
      await loadSuppliers();
    }
    const res=await fetch(`/api/pm_stock/grn/${id}`);
    const data=await res.json();
    if(data.status==='error'){showToast(data.message||'Not found','error');return;}
    const items=(data.items||[]).map(i=>({
      product_id:i.product_id, qty_received:i.qty_received,
      no_of_box:i.no_of_box, box_count:i.box_count, remarks:i.remarks||'',
      // Carry the canonical name + type the API returned. Earlier these were
      // dropped and the print template relied on a client-side lookup against
      // _products, which silently fell back to "—" when _products wasn't loaded
      // yet (e.g. printing before visiting the Products tab) or when id types
      // didn't match. Source-of-truth is the server response.
      product_name: i.product_name || '',
      pm_type:      i.pm_type      || '',
      product_version:i.product_version || '',
      entered_uom:i.entered_uom || '',
      primary_uom:i.primary_uom || '',
      alt_uom:i.alt_uom || ''
    }));
    pmGrnPrint({grn_no:data.grn_no, supervisor_name:data.supervisor_name, created_by:data.created_by,
                party_invoice_no:data.party_invoice_no, party_invoice_date:data.party_invoice_date},
               items,data.grn_date,data.supplier,data.godown_id,data.po_number,data.po_date,data.remarks);
  }catch(e){showToast('Error: '+e.message,'error');}
}
/* MTV print — DEPRECATED, stubbed */
async function pmMtvPrintById(id){
  try{
    showToast('Loading MTV…','info',1500);
    const res=await fetch(`/api/pm_stock/mtv/${id}`);
    const data=await res.json();
    if(data.status==='error'){showToast(data.message||'Not found','error');return;}
    const items=(data.items||[]).map(i=>({product_id:i.product_id,qty:i.qty,remarks:i.remarks||''}));
    pmMtvPrint(data.mtv_no,data.mtv_date,data.to_godown,data.to_type,
      [{from_godown:data.from_godown,from_type:data.from_type,items}],data.remarks);
  }catch(e){showToast('Error: '+e.message,'error');}
}
function pmMtvPrint(mtvNo,mtvDate,toGdId,toType,sources,remarks){
  const toG=(_godowns||[]).find(g=>String(g.id)===String(toGdId));
  const fromG=(_godowns||[]).find(g=>String(g.id)===String((sources||[])[0]?.from_godown));
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fd=d=>{if(!d)return'—';const p=String(d).split('-');return p[2]+'/'+p[1]+'/'+p[0];};
  const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dash=v=>(v&&String(v).trim())?esc(String(v).trim()):'<span style="color:#bbb">—</span>';
  const addrLine=g=>[g?.address,g?.city,g?.state,g?.pincode].filter(p=>p&&String(p).trim()).join(', ');
  let srcRows='';
  (sources||[]).forEach((src,si)=>{
    const sG=(_godowns||[]).find(g=>String(g.id)===String(src.from_godown));
    if((sources||[]).length>1)
      srcRows+=`<tr style="background:#fef3c7"><td colspan="3" style="padding:5px 8px;font-size:10px;font-weight:800;color:#92400e">Source ${si+1}: ${esc(sG?.name||'—')}</td></tr>`;
    (src.items||[]).forEach((it,ii)=>{
      const prod=(_products||[]).find(p=>p.id===it.product_id);
      srcRows+=`<tr><td class="c">${ii+1}</td><td><strong>${esc(prod?.product_name||'—')}</strong><br><span style="font-size:8.5px;color:#666">${esc(prod?.pm_type||'')}</span></td><td class="r">${it.qty.toLocaleString('en-IN')}</td></tr>`;
    });
  });
  const totalQty=(sources||[]).reduce((s,src)=>s+(src.items||[]).reduce((ss,i)=>ss+i.qty,0),0);
  const CSS=`*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:18px 24px}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #92400e;padding-bottom:10px;margin-bottom:0}
.co{font-size:20px;font-weight:900;color:#92400e;letter-spacing:-.3px}
.co-sub{font-size:8px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-top:2px}
.vno{font-size:14px;font-weight:800;font-family:monospace;color:#92400e;text-align:right}
.bar{display:grid;grid-template-columns:1.2fr 1fr 1.3fr 1.3fr 1.3fr;border:1px solid #ccc;border-top:none;margin-bottom:8px}
.bc{padding:6px 10px;border-right:1px solid #ccc}
.bc:last-child{border-right:none}
.bl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}
.bv{font-size:12px;font-weight:700;color:#111}

/* Party boxes: from + to side-by-side */
.party-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.pbox{border-radius:4px;overflow:hidden;background:#f9fafb;border:1px solid #d1d5db}
.pbox-from{border-color:#92400e;background:#fef3c7}
.pbox-to{border-color:#6366f1;background:#eef2ff}
.pbox-hdr{padding:4px 10px;font-size:9px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pbox-from .pbox-hdr{background:#92400e}
.pbox-to   .pbox-hdr{background:#4f46e5}
.pbox-role{background:rgba(255,255,255,.22);padding:1px 8px;border-radius:10px;font-size:7.5px;letter-spacing:.3px}
.pbox-title{flex:1;font-size:10px}
.pbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
.pbox-from .sbc{border-right:1px solid #e9d7a8;border-bottom:1px solid #e9d7a8}
.pbox-to   .sbc{border-right:1px solid #cfd4f1;border-bottom:1px solid #cfd4f1}
.sbc{padding:5px 10px}
.pbox-grid .sbc:nth-child(2n){border-right:none}
.sbc.wide{grid-column:1/-1;border-right:none}
.sbl{font-size:6.5px;font-weight:800;color:#8a6b3e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:1px}
.pbox-to .sbl{color:#5c6095}
.sbv{font-size:9.5px;font-weight:600;color:#111;word-break:break-word}
.sbv.bold{font-size:10.5px;font-weight:800}
.pbox-from .sbv.bold{color:#92400e}
.pbox-to   .sbv.bold{color:#4f46e5}
.sbv.mono{font-family:'Courier New',monospace;font-size:9px}

table{width:100%;border-collapse:collapse;margin-bottom:0}
thead tr{background:#92400e !important}
th{color:#fff;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#92400e}
tr{border-bottom:1px solid #e5e7eb}
tbody tr:nth-child(even){background:#fafaf8}
td{padding:6px 8px;font-size:10.5px;vertical-align:middle}
.c{text-align:center;color:#9ca3af;width:28px;font-size:10px}
.r{text-align:right;font-family:monospace;font-weight:700}
tfoot tr{background:#fef3c7!important;border-top:2px solid #92400e}
tfoot td{font-weight:800;font-size:11px}
.sig{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #ccc;border-top:none;margin-top:20px}
.sb{padding:12px 10px;border-right:1px solid #ccc;min-height:52px}
.sb:last-child{border-right:none}
.sl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.ft{text-align:center;font-size:8.5px;color:#9ca3af;margin-top:10px;border-top:1px solid #eee;padding-top:6px}
@media print{body{padding:8px 14px}button{display:none!important}}`;

  const win=window.open('','_blank','width=860,height=700');
  if(!win){showToast('Pop-up blocked — please allow popups','error');return;}
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>MTV ${esc(mtvNo)}</title><style>${CSS}</style></head><body>
<div class="hd">
  <div>
    <div class="co">HCP WELLNESS PVT LTD</div>
    <div class="co-sub">PM Material Transfer Voucher</div>
  </div>
  <div class="vno">${esc(mtvNo)}</div>
</div>
<div class="bar">
  <div class="bc"><div class="bl">MTV No.</div><div class="bv">${esc(mtvNo)}</div></div>
  <div class="bc"><div class="bl">Date</div><div class="bv">${fd(mtvDate)}</div></div>
  <div class="bc"><div class="bl">Source (From)</div><div class="bv">${esc(fromG?.name||'—')}</div></div>
  <div class="bc"><div class="bl">Destination (To)</div><div class="bv">${esc(toG?.name||'—')}</div></div>
  <div class="bc"><div class="bl">Remarks</div><div class="bv">${esc(remarks||'—')}</div></div>
</div>

<!-- From / To full detail boxes -->
<div class="party-row">
  <div class="pbox pbox-from">
    <div class="pbox-hdr">
      <span class="pbox-role">From (Issuer)</span>
      <span class="pbox-title">Source Location</span>
    </div>
    <div class="pbox-grid">
      <div class="sbc"><div class="sbl">Location Name</div><div class="sbv bold">${dash(fromG?.name)}</div></div>
      <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(fromG?.contact)}</div></div>
      <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(fromG?.phone)}</div></div>
      <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(fromG?.email)}</div></div>
      <div class="sbc"><div class="sbl">GST Number</div><div class="sbv mono">${dash(fromG?.gst_number)}</div></div>
      <div class="sbc"><div class="sbl">Type</div><div class="sbv">${dash(fromG?.is_floor ? 'Factory Floor' : 'Godown')}</div></div>
      <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(addrLine(fromG))}</div></div>
    </div>
  </div>

  <div class="pbox pbox-to">
    <div class="pbox-hdr">
      <span class="pbox-role">To (Receiver)</span>
      <span class="pbox-title">Destination Location</span>
    </div>
    <div class="pbox-grid">
      <div class="sbc"><div class="sbl">Location Name</div><div class="sbv bold">${dash(toG?.name)}</div></div>
      <div class="sbc"><div class="sbl">Contact Person</div><div class="sbv">${dash(toG?.contact)}</div></div>
      <div class="sbc"><div class="sbl">Phone</div><div class="sbv mono">${dash(toG?.phone)}</div></div>
      <div class="sbc"><div class="sbl">Email</div><div class="sbv">${dash(toG?.email)}</div></div>
      <div class="sbc"><div class="sbl">GST Number</div><div class="sbv mono">${dash(toG?.gst_number)}</div></div>
      <div class="sbc"><div class="sbl">Type</div><div class="sbv">${dash(toType==='floor' || toG?.is_floor ? 'Factory Floor' : 'Godown')}</div></div>
      <div class="sbc wide"><div class="sbl">Address</div><div class="sbv">${dash(addrLine(toG))}</div></div>
    </div>
  </div>
</div>

<table>
  <thead><tr>
    <th class="c">#</th>
    <th style="text-align:left">Product</th>
    <th class="r" style="width:100px">Qty</th>
  </tr></thead>
  <tbody>${srcRows}</tbody>
  <tfoot><tr>
    <td colspan="2" style="padding:7px 8px">Total — ${(sources||[]).reduce((s,src)=>s+(src.items||[]).length,0)} item(s)</td>
    <td class="r" style="padding:7px 8px">${totalQty.toLocaleString('en-IN')}</td>
  </tr></tfoot>
</table>
<div class="sig">
  <div class="sb"><div class="sl">Issued By</div></div>
  <div class="sb"><div class="sl">Received By</div></div>
  <div class="sb"><div class="sl">Authorised By</div></div>
</div>
<div class="ft">MTV ${esc(mtvNo)} · HCP Wellness Pvt Ltd · ${new Date().toLocaleString('en-IN')}</div>
<br><button onclick="window.print()" style="padding:6px 14px;background:#92400e;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700">🖨 Print</button>
</body></html>`);
  win.document.close();
  win.onload=()=>{win.focus();win.print();};
}

/* ═══ GRN EDIT / DELETE ═══ */
async function openEditGrn(id) {
  try {
    showToast('Loading GRN…','info',1500);
    const res  = await fetch(`/api/pm_stock/grn/${id}`);
    const data = await res.json();
    if(data.status==='error'){ showToast(data.message||'Not found','error'); return; }

    document.getElementById('egrn-id').value       = id;
    document.getElementById('egrn-vno').textContent = data.grn_no;
    // "Fix Box Qty" repair button — now visible to all users. The endpoint
    // is dry-run by default and writes are fully audited, so it's safe to
    // open up. (Used to be admin-only.)
    const _fixBtn = document.getElementById('egrn-fixqty-btn');
    if(_fixBtn) _fixBtn.style.display = '';
    // Stash created_by on the modal so printEditGrn() can read it back
    // (the form has no field for it — it's stored server-side at save time).
    const _egrnModal = document.getElementById('editGrnModal');
    if(_egrnModal) _egrnModal.dataset.createdBy = data.created_by || '';
    document.getElementById('egrn-date').value      = data.grn_date||'';
    document.getElementById('egrn-supplier').value  = data.supplier||'';
    const egrnSupText = document.getElementById('egrn-supplier-text');
    if(egrnSupText) egrnSupText.value = data.supplier||'';
    // Init combo
    if(!_supRows.length) loadSuppliers().then(()=>{ const w=document.getElementById('egrn-sup-wrap'); if(w) _initSupplierCombo(w); });
    else { const w=document.getElementById('egrn-sup-wrap'); if(w) _initSupplierCombo(w); }
    document.getElementById('egrn-po-number').value = data.po_number||'';
    document.getElementById('egrn-po-date').value   = data.po_date||'';
    document.getElementById('egrn-remarks').value   = data.remarks||'';
    const epinEl = document.getElementById('egrn-party-invoice-no');
    if(epinEl) epinEl.value = data.party_invoice_no||'';
    const epidEl = document.getElementById('egrn-party-invoice-date');
    if(epidEl) epidEl.value = data.party_invoice_date||'';
    const esupEl = document.getElementById('egrn-supervisor');
    // If record has no supervisor saved yet, default to current login user
    if(esupEl) esupEl.value = data.supervisor_name || _loginUserName();

    // Populate godown select
    const opts = '<option value="">— Select Location —</option>' +
      (_godowns||[]).map(g=>`<option value="${g.id}">${godownLabel(g)}</option>`).join('');
    const sel = document.getElementById('egrn-godown');
    sel.innerHTML = opts;
    if(data.godown_id) sel.value = String(data.godown_id);

    // Populate items
    const c = document.getElementById('egrn-items-container');
    c.innerHTML = '';
    (data.items||[]).forEach(item => egrnAddItem(item));
    if(!data.items||!data.items.length) egrnAddItem();

    document.getElementById('editGrnModal').classList.add('open');
    if(typeof applyHomeGodownLock === 'function') applyHomeGodownLock();

    // Load any attached invoice files into the new "Invoice Files" panel.
    // This is non-blocking and harmless if the endpoint isn't there (older builds).
    if(typeof loadPmGrnFiles === 'function') {
      loadPmGrnFiles(id);
    }
    // Decorate each line row with a "TRS generated" badge if a TRS
    // already covers that line. Non-blocking; safe to no-op if the
    // pm_stock_trs.js bundle isn't loaded (e.g. user without pm_trs
    // access — Jinja drops the script tag).
    if(typeof loadTrsBadgesForGrn === 'function') {
      loadTrsBadgesForGrn(id);
    }
  } catch(e) { showToast('Error loading GRN: '+e.message,'error'); }
}

function egrnAddItem(item) {
  const c = document.getElementById('egrn-items-container'); if(!c) return;
  const div  = document.createElement('div');
  div.className = 'grn-item-row';
  // 9-col grid (added a 60px UOM slot between Total Qty and Remarks).
  div.style.cssText = 'display:grid;grid-template-columns:22px 1fr 100px 72px 72px 90px 60px 120px 28px;gap:5px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML = `
    <input type="checkbox" class="grn-item-sel" style="width:14px;height:14px;cursor:pointer;accent-color:var(--teal,#0d9488)">
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="gi-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="text" class="gi-version" maxlength="60" placeholder="version (optional)"
      title="Free-text version marker for this line — e.g. 'Old design', 'v2', 'New cap'. Shows as [VERSION] next to the product name on labels and printed vouchers."
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:11.5px;color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
    <input type="number" class="gi-boxes" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-boxcount" min="0" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:center"
      oninput="grnCalcQty(this)">
    <input type="number" class="gi-qty" min="0" step="1" placeholder="0"
      style="width:100%;background:rgba(13,148,136,.12);border:1.5px solid rgba(13,148,136,.35);border-radius:6px;padding:6px 4px;font-size:13px;font-weight:800;color:var(--teal,#0d9488);outline:none;text-align:right"
      title="Auto-calculated from No. of Box × Per Box Qty, or enter total directly">
    <select class="gi-uom" disabled title="Pick a product first"
      style="width:100%;background:var(--hsurf2,#f8fafc);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 4px;font-size:11px;font-weight:700;color:var(--text,#111);outline:none;text-align:center">
      <option value="">—</option>
    </select>
    <input type="text" class="gi-remarks" placeholder="Optional…"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <button onclick="this.closest('.grn-item-row').remove()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center">✕</button>`;
  c.appendChild(div);
  // Wire product picker — populate UOM dropdown when a product is chosen.
  _initProdCombo(div.querySelector('.prod-combo-wrap'), '.gi-qty', function(p){
    grnPopulateLineUom(div, p);
  });
  div.querySelector('.prod-combo-input').focus();
  div.scrollIntoView({block:'nearest', behavior:'smooth'});
  if(item) {
    const pid = String(item.product_id||'');
    const prod = (_products||[]).find(p=>String(p.id)===pid);
    const productInput = div.querySelector('.prod-combo-input');
    const productHidden = div.querySelector('.gi-product');
    if(prod){
      // Active product — found in the loaded list. Normal path.
      productHidden.value = pid;
      productInput.value = `[${prod.pm_type}] ${prod.product_name}`;
      productInput.style.borderColor = 'var(--teal,#0d9488)';
    } else if(pid && (item.product_name || item.pm_type)){
      // Product exists in pm_products but isn't in _products — most often
      // because it's been deactivated (is_active=0) by the products-tab
      // delete action. The GRN GET endpoint joins pm_products without
      // filtering on is_active, so it returns the name/pm_type for us.
      // Without this fallback, the row would render with a blank product
      // field and editing would silently lose the link to the original
      // product on save (gi-product hidden value would be empty).
      productHidden.value = pid;
      const pmTxt = item.pm_type ? `[${item.pm_type}] ` : '';
      productInput.value = `${pmTxt}${item.product_name || ''}`;
      // Amber highlight + tooltip to make it visible the product is no
      // longer in the active list. The hidden id is still set, so saving
      // the GRN keeps the link intact unless the user picks a different
      // product from the dropdown.
      productInput.style.borderColor = '#d97706';
      productInput.style.background  = 'rgba(245,158,11,.08)';
      productInput.title = 'This product is deactivated. Reactivate it in Products tab to see it in the dropdown, or pick a replacement here.';
    } else if(pid){
      // Last-resort: id present but no product_name field returned.
      // Don't lose the id; show a placeholder text.
      productHidden.value = pid;
      productInput.value = `(deactivated product · id ${pid})`;
      productInput.style.borderColor = '#dc2626';
      productInput.style.background  = 'rgba(220,38,38,.08)';
      productInput.title = 'Product no longer exists in master data. Pick a replacement.';
    }
    div.querySelector('.gi-boxes').value    = item.no_of_box||'';
    div.querySelector('.gi-boxcount').value = item.box_count||'';
    // Set qty from saved value — if boxes + boxcount are present they'll drive grnCalcQty
    div.querySelector('.gi-qty').value      = item.qty_received||'';
    div.querySelector('.gi-remarks').value  = item.remarks||'';
    // Product version (free-text per-line marker, e.g. "Old design").
    // Stored on pm_grn_items.product_version; appears as [VERSION] next
    // to the product name on labels and the printed voucher.
    const versionInput = div.querySelector('.gi-version');
    if(versionInput) versionInput.value = item.product_version || '';
    // UOM (Phase 2) — prefill the line's UOM dropdown from the saved value.
    // The GRN GET endpoint returns entered_uom + primary_uom + alt_uom per
    // line. We synthesize a minimal product object so grnPopulateLineUom
    // can build the dropdown the same way as for a freshly-picked product.
    const _puom = (item.primary_uom || (prod && prod.primary_uom) || 'Nos');
    const _auom = (item.alt_uom     || (prod && prod.alt_uom)     || '');
    grnPopulateLineUom(div, {id: item.product_id, primary_uom: _puom, alt_uom: _auom},
                       item.entered_uom || '');
    // Stash the FIFO code so grnOpenLabels can stamp it on box labels without
    // having to round-trip through /api/pm_stock/fifo/lookup. The GET endpoint
    // /api/pm_stock/grn/<id> already joins pm_fifo_lots and returns fifo_code
    // per item — we just have to keep it on the row.
    if(item.fifo_code) {
      div.dataset.fifoCode = item.fifo_code;
    }
    // Stash the GRN item id too — label printing needs it to look up
    // per-line short codes (otherwise two lines of the same product
    // both get the same short_code on the first box). The id comes
    // from /api/pm_stock/grn/<id>'s items[].id field.
    if(item.id){
      div.dataset.grnItemId = String(item.id);
    }
    // If both box fields populated, recompute qty to keep it consistent
    if((item.no_of_box||0) > 0 && (item.box_count||0) > 0) {
      grnCalcQty(div.querySelector('.gi-boxes'));
    }
    // ── Selective Reprint button — only on saved items ──
    // Only saved line items have an ID + product_id we can reference.
    // The button opens the selective-reprint modal that lets the user
    // pick specific box numbers, edit per-box qty, and add new boxes.
    // For admins it applies the change immediately; for non-admins it
    // submits a request that the admin must approve before printing.
    const grnId = parseInt(document.getElementById('egrn-id')?.value)||0;
    if(grnId && pid && typeof window.openSelectiveReprintForGrn === 'function'){
      // Stick the button in front of the trash button so it stays inside
      // the row's grid (last column = trash). We replace the trash btn
      // with a small flex container holding both.
      const trashBtn = div.querySelector('button');
      if(trashBtn){
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;align-items:stretch';
        const selBtn = document.createElement('button');
        selBtn.type = 'button';
        selBtn.title = 'Selective reprint (pick specific box numbers, edit qty, add new boxes)';
        selBtn.innerHTML = '🏷';
        selBtn.style.cssText = 'width:26px;height:18px;border-radius:4px;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);color:#7c3aed;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1';
        selBtn.onclick = () => window.openSelectiveReprintForGrn(grnId, parseInt(pid));
        // Shrink the trash button to share the column
        trashBtn.style.height = '18px';
        trashBtn.style.fontSize = '9px';
        trashBtn.parentNode.insertBefore(wrap, trashBtn);
        wrap.appendChild(selBtn);
        wrap.appendChild(trashBtn);
      }
    }
  }
}

// Admin: re-sync each box's per-box qty to its GRN line. Fixes the
// "120-box scans as 170" bug for GRNs with two lines of the same product.
// Always DRY-RUNS first, shows the diff, then asks before writing.
async function grnFixBoxQty(){
  const id = parseInt(document.getElementById('egrn-id')?.value) || 0;
  if(!id){ showToast('Open a GRN first','error'); return; }
  try{
    // 1) Dry run — see what would change.
    const dr = await fetch(`/api/pm_stock/grn/${id}/resync_box_qty`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({apply:false})
    });
    const d = await dr.json();
    if(d.status!=='ok'){ showToast(d.message||'Diagnose failed','error',4000); return; }

    const fixes = d.would_fix || d.fixed || [];
    if(!fixes.length && !(d.skipped||[]).length){
      alert(`✓ ${d.grn_no}: all ${d.boxes_checked} box(es) already have the correct per-box qty. Nothing to fix.`);
      return;
    }
    let msg = `${d.grn_no}\n\nChecked ${d.boxes_checked} box(es). Correct already: ${d.already_correct}.\n`;
    if(fixes.length){
      const lines = fixes.slice(0,12).map(f => `• ${f.short_code||f.box_code}: ${f.from} → ${f.to}`);
      msg += `\nWILL FIX ${fixes.length} box(es):\n${lines.join('\n')}`;
      if(fixes.length>12) msg += `\n…and ${fixes.length-12} more`;
    }
    if((d.skipped||[]).length){
      msg += `\n\n⚠️ ${d.skipped.length} box(es) SKIPPED (link unclear — not changed):\n` +
             d.skipped.slice(0,6).map(s=>`• ${s.short_code||s.box_code}: ${s.reason}`).join('\n');
    }
    if(!fixes.length){ alert(msg + '\n\nNothing safe to auto-fix.'); return; }
    msg += `\n\nApply these ${fixes.length} correction(s) now?`;
    if(!confirm(msg)) return;

    // 2) Apply.
    const ap = await fetch(`/api/pm_stock/grn/${id}/resync_box_qty`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({apply:true})
    });
    const a = await ap.json();
    if(a.status!=='ok'){ showToast(a.message||'Apply failed','error',4000); return; }
    showToast(`Fixed ${a.applied_count} box(es) — per-box qty re-synced`,'success',4000);
  }catch(e){ showToast('Error: '+e.message,'error'); }
}

async function saveEditGrn() {
  const id       = document.getElementById('egrn-id').value;
  const grnDate  = document.getElementById('egrn-date').value;
  const godownId = document.getElementById('egrn-godown').value;
  const supplier = (document.getElementById('egrn-supplier-text')?.value
                 || document.getElementById('egrn-supplier')?.value || '').trim();
  const poNum    = document.getElementById('egrn-po-number').value.trim()||null;
  const poDate   = document.getElementById('egrn-po-date').value||null;
  const remarks  = document.getElementById('egrn-remarks').value.trim();
  const partyInvoiceNo   = document.getElementById('egrn-party-invoice-no')?.value.trim()||null;
  const partyInvoiceDate = document.getElementById('egrn-party-invoice-date')?.value||null;
  const supervisorName   = document.getElementById('egrn-supervisor')?.value.trim()||null;
  if(!grnDate)  { showToast('Select GRN date','error'); return; }
  if(!godownId) { showToast('Select location','error'); return; }
  const items = [];
  document.querySelectorAll('#egrn-items-container .grn-item-row').forEach(row=>{
    const pid      = parseInt(row.querySelector('.gi-product')?.value)||0;
    const qty      = parseFloat(row.querySelector('.gi-qty')?.value)||0;
    let noOfBox  = parseInt(row.querySelector('.gi-boxes')?.value)||0;
    let boxCount = parseInt(row.querySelector('.gi-boxcount')?.value)||0;
    const rem      = row.querySelector('.gi-remarks')?.value?.trim()||'';
    const pver     = row.querySelector('.gi-version')?.value?.trim()||'';
    // UOM label (Phase 2) — pure metadata; no conversion.
    const euom     = (row.querySelector('.gi-uom')?.value||'').trim()||null;
    // If user entered only total qty, default to 1 box of that qty
    if(qty > 0 && noOfBox === 0 && boxCount === 0) {
      noOfBox = 1;
      boxCount = qty;
    }
    if(pid&&qty>0) items.push({
      product_id:pid, qty_received:qty,
      no_of_box:noOfBox, box_count:boxCount,
      remarks:rem, product_version:pver,
      entered_uom: euom,
    });
  });
  if(!items.length){ showToast('Add at least one item','error'); return; }
  try {
    const res  = await fetch('/api/pm_stock/grn/update',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id,grn_date:grnDate,godown_id:parseInt(godownId),supplier,po_number:poNum,po_date:poDate,remarks,
                           party_invoice_no:partyInvoiceNo,party_invoice_date:partyInvoiceDate,
                           supervisor_name:supervisorName,items})});
    const data = await res.json();
    if(data.status==='ok'){
      // If the GRN is still pending verification (i.e. it was pending before
      // the edit), the operator now has a fresh box set to scan. Skip the
      // print prompt and jump straight to the verify modal.
      if(data.verification_status === 'pending'){
        showToast(`📥 GRN ${data.grn_no} updated — still pending. Scan boxes to verify.`, 'info', 5000);
        closeModal('editGrnModal');
        loadGrnList(); await loadSummary();
        if(typeof openGrnVerifyModal === 'function'){
          setTimeout(() => { openGrnVerifyModal(parseInt(id)); }, 250);
        }
        return;
      }
      showToast(`✓ GRN ${data.grn_no} updated`,'success');
      closeModal('editGrnModal');
      loadGrnList(); await loadSummary();
      if(confirm(`GRN ${data.grn_no} updated.\n\nPrint now?`))
        pmGrnPrint({grn_no:data.grn_no, supervisor_name:supervisorName,
                    created_by:(document.getElementById('editGrnModal')?.dataset?.createdBy || _loginUserName()),
                    party_invoice_no:partyInvoiceNo, party_invoice_date:partyInvoiceDate},
                   items,grnDate,supplier,godownId,poNum,poDate,remarks);
    } else showToast(data.message||'Error','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ═══ MTV EDIT / DELETE — DEPRECATED ═══ */
async function openEditMtv(id) {
  try {
    showToast('Loading MTV…','info',1500);
    const res  = await fetch(`/api/pm_stock/mtv/${id}`);
    const data = await res.json();
    if(data.status==='error'){ showToast(data.message||'Not found','error'); return; }

    document.getElementById('emtv-id').value       = id;
    document.getElementById('emtv-vno').textContent = data.mtv_no;
    document.getElementById('emtv-date').value      = data.mtv_date||'';
    const rem = document.getElementById('emtv-remarks'); if(rem) rem.value = data.remarks||'';

    const opts = '<option value="">— Select —</option>' +
      (_godowns||[]).map(g=>`<option value="${g.id}">${godownLabel(g)}</option>`).join('');
    const sf = document.getElementById('emtv-from');
    const st = document.getElementById('emtv-to');
    sf.innerHTML = opts; st.innerHTML = opts;
    if(data.from_godown) sf.value = String(data.from_godown);
    if(data.to_godown)   st.value = String(data.to_godown);

    // Items
    const c = document.getElementById('emtv-items-container');
    c.innerHTML = '';
    (data.items||[]).forEach(item => emtvAddItem(item));
    if(!data.items||!data.items.length) emtvAddItem();

    document.getElementById('editMtvModal').classList.add('open');
  } catch(e){ showToast('Error loading MTV: '+e.message,'error'); }
}
function emtvAddItem(item) {
  const c = document.getElementById('emtv-items-container'); if(!c) return;
  const div  = document.createElement('div');
  div.className = 'mtv-item-row';
  div.style.cssText = 'display:grid;grid-template-columns:1fr 120px 28px;gap:6px;padding:6px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML = `
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="mi-product" value="">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--text,#111);outline:none;text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="mi-qty" min="1" step="1" placeholder="0"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;font-weight:700;color:var(--text,#111);outline:none;text-align:right">
    <button onclick="this.closest('.mtv-item-row').remove()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22);color:#ef4444;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>`;
  c.appendChild(div);
  _initProdCombo(div.querySelector('.prod-combo-wrap'), '.mi-qty');
  if(item){
    const pid = String(item.product_id||'');
    const prod = (_products||[]).find(p=>String(p.id)===pid);
    if(prod){
      div.querySelector('.mi-product').value = pid;
      div.querySelector('.prod-combo-input').value = `[${prod.pm_type}] ${prod.product_name}`;
    }
    div.querySelector('.mi-qty').value = item.qty||'';
  }
}
async function saveEditMtv() {
  const id      = document.getElementById('emtv-id').value;
  const mtvDate = document.getElementById('emtv-date').value;
  const fromGd  = document.getElementById('emtv-from').value;
  const toGd    = document.getElementById('emtv-to').value;
  const fromType = _mtvLocType(fromGd);
  const toType   = _mtvLocType(toGd);
  const remEl   = document.getElementById('emtv-remarks');
  const remarks = remEl?remEl.value.trim():'';
  if(!mtvDate){showToast('Select date','error');return;}
  if(!fromGd) {showToast('Select source','error');return;}
  if(!toGd)   {showToast('Select destination','error');return;}
  if(fromGd===toGd){showToast('Source and destination cannot be the same','error');return;}
  const items=[];
  document.querySelectorAll('#emtv-items-container .mtv-item-row').forEach(row=>{
    const pid=parseInt(row.querySelector('.mi-product')?.value)||0;
    const qty=parseFloat(row.querySelector('.mi-qty')?.value)||0;
    if(pid&&qty>0) items.push({product_id:pid,qty});
  });
  if(!items.length){showToast('Add at least one item','error');return;}
  try{
    const res=await fetch('/api/pm_stock/mtv/update',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id,mtv_date:mtvDate,from_godown:parseInt(fromGd),to_godown:parseInt(toGd),from_type:fromType,to_type:toType,remarks,items})});
    const data=await res.json();
    if(data.status==='ok'){
      showToast(`✓ MTV ${data.mtv_no} updated`,'success');
      closeModal('editMtvModal');
      loadMtvList(); await loadSummary();
      if(confirm(`MTV ${data.mtv_no} updated.\n\nPrint now?`))
        pmMtvPrint(data.mtv_no,mtvDate,parseInt(toGd),toType,[{from_godown:parseInt(fromGd),from_type:fromType,items}],remarks);
    } else showToast(data.message||'Error','error');
  }catch(e){showToast('Error: '+e.message,'error');}
}


function printEditGrn(){
  const grnNo   = document.getElementById('egrn-vno')?.textContent||'';
  const grnDate = document.getElementById('egrn-date')?.value||'';
  const godownId= document.getElementById('egrn-godown')?.value||'';
  const supplier= (document.getElementById('egrn-supplier-text')?.value
                || document.getElementById('egrn-supplier')?.value || '').trim();
  const poNum   = document.getElementById('egrn-po-number')?.value||null;
  const poDate  = document.getElementById('egrn-po-date')?.value||null;
  const remarks = document.getElementById('egrn-remarks')?.value||'';
  // Pull supervisor (form field) + created_by (cached from openEditGrn or
  // current login user as fallback). Without these, the receiver block on
  // the printed voucher shows em-dashes.
  const supervisorName = document.getElementById('egrn-supervisor')?.value?.trim()||'';
  const createdBy      = (document.getElementById('editGrnModal')?.dataset?.createdBy || '').trim()
                       || _loginUserName();
  const items=[];
  document.querySelectorAll('#egrn-items-container .grn-item-row').forEach(row=>{
    const pid=parseInt(row.querySelector('.gi-product')?.value)||0;
    const qty=parseFloat(row.querySelector('.gi-qty')?.value)||0;
    const nb=parseInt(row.querySelector('.gi-boxes')?.value)||0;
    const bc=parseInt(row.querySelector('.gi-boxcount')?.value)||0;
    const rem=row.querySelector('.gi-remarks')?.value?.trim()||'';
    const pver=row.querySelector('.gi-version')?.value?.trim()||'';
    const euom=(row.querySelector('.gi-uom')?.value||'').trim()||'';
    if(pid&&qty>0) items.push({product_id:pid,qty_received:qty,no_of_box:nb,box_count:bc,remarks:rem,product_version:pver,entered_uom:euom});
  });
  if(!items.length){showToast('No items to print','error');return;}
  const _piNo   = document.getElementById('egrn-party-invoice-no')?.value?.trim()||'';
  const _piDate = document.getElementById('egrn-party-invoice-date')?.value||'';
  pmGrnPrint({grn_no:grnNo, supervisor_name:supervisorName, created_by:createdBy,
              party_invoice_no:_piNo, party_invoice_date:_piDate},items,grnDate,supplier,godownId,poNum,poDate,remarks);
}

/* ══════════════════════════════════════════════════════
   GRN BOX CALC — auto qty = no_of_box × box_count
══════════════════════════════════════════════════════ */
function grnCalcQty(inputEl) {
  const row = inputEl.closest('.grn-item-row');
  if(!row) return;
  const boxesEl    = row.querySelector('.grn-item-boxes,.gi-boxes');
  const boxcountEl = row.querySelector('.grn-item-boxcount,.gi-boxcount');
  const qtyEl      = row.querySelector('.grn-item-qty,.gi-qty');
  if(!boxesEl || !boxcountEl || !qtyEl) return;
  const b  = parseInt(boxesEl.value)    || 0;
  const bc = parseInt(boxcountEl.value) || 0;
  // Always recompute — including clearing to 0 when either input is empty.
  // qty field is readonly in UI so user cannot type; it must always reflect b × bc.
  qtyEl.value = (b > 0 && bc > 0) ? (b * bc) : 0;
  qtyEl.style.background = (b > 0 && bc > 0) ? 'rgba(13,148,136,.12)' : 'rgba(239,68,68,.06)';
}

/* ══════════════════════════════════════════════════════
   SELECT ALL toggle for GRN item checkboxes
══════════════════════════════════════════════════════ */
function grnToggleAll(masterCb, containerId) {
  const container = document.getElementById(containerId);
  if(!container) return;
  container.querySelectorAll('.grn-item-sel').forEach(cb => { cb.checked = masterCb.checked; });
}

/* ══════════════════════════════════════════════════════
   OPEN LABEL MODAL — collect all checked rows from given container

   Save-first policy for the NEW-GRN modal
   ───────────────────────────────────────
   QR codes encode real DB short_codes that only exist once the boxes
   have been inserted at save time. Printing labels for an unsaved GRN
   would produce throwaway codes that don't match what scanners will
   look up later. So if this is called from the new-GRN modal (container
   id "grn-items-container") and the GRN hasn't been saved yet, we
   refuse to print and tell the user to save first.

   "Saved" means either:
     - egrn-id field has a value (edit-modal path), OR
     - pmVoucherModal.dataset.savedGrnId is set (saveGrn stashed it
       after a successful save in this same new-modal session, so the
       user can print labels right after saving without reopening)
══════════════════════════════════════════════════════ */
async function grnOpenLabels(containerId) {
  const container = document.getElementById(containerId);
  if(!container) return;

  const checkedRows = [...container.querySelectorAll('.grn-item-row')]
    .filter(row => row.querySelector('.grn-item-sel')?.checked);

  if(!checkedRows.length) {
    showToast('Select at least one item to print labels','error');
    return;
  }

  // ── Save-first guard for the new-GRN modal ──
  // QR codes encode real DB short_codes that only exist after the boxes
  // are inserted at save time. Printing before save would either emit
  // placeholder codes that don't match what scanners will look up, or
  // (worse) emit codes that get reused on a different GRN later. So we
  // refuse to print until the GRN is actually saved.
  //
  // Detection: this is the new-GRN modal when container id is
  // "grn-items-container". "Already saved" means either:
  //   - egrn-id is populated (edit modal path), OR
  //   - pmVoucherModal.dataset.savedGrnId is set (set by saveGrn() after
  //     a successful save in the same new-GRN modal session)
  const isNewGrnModal = (containerId === 'grn-items-container');
  if(isNewGrnModal){
    const pmModal = document.getElementById('pmVoucherModal');
    const stashedId = pmModal && pmModal.dataset && pmModal.dataset.savedGrnId;
    const editId   = document.getElementById('egrn-id')?.value;
    const alreadySaved = !!(stashedId || editId);
    if(!alreadySaved){
      showToast(
        'Save the GRN first. Labels can only be printed after the GRN is saved, '
        + 'so each box gets its real QR code from the database.',
        'error',
        6000
      );
      return;
    }
  }

  // GRN header data — support both modals
  const grnNo = (document.getElementById('egrn-vno')?.textContent
              || document.getElementById('grn-vno-display')?.textContent || '').trim() || '—';
  const grnDate = document.getElementById('egrn-date')?.value
               || document.getElementById('grn-date')?.value || '';
  const godownId = document.getElementById('egrn-godown')?.value
                || document.getElementById('grn-godown')?.value || '';
  const supervisor = (document.getElementById('egrn-supervisor')?.value
                   || document.getElementById('grn-supervisor')?.value || '').trim() || '—';

  // Supplier + invoice fields
  const supplierText = (document.getElementById('egrn-supplier-text')?.value
                     || document.getElementById('grn-supplier-text')?.value || '').trim() || '—';
  const invoiceNo   = (document.getElementById('egrn-party-invoice-no')?.value
                    || document.getElementById('grn-party-invoice-no')?.value || '').trim() || '—';
  const invoiceDate = document.getElementById('egrn-party-invoice-date')?.value
                   || document.getElementById('grn-party-invoice-date')?.value || '';
  const invoiceDateFmt = invoiceDate
    ? fmtDate(invoiceDate)
    : '—';

  const godown = (_godowns||[]).find(g=>String(g.id)===String(godownId));
  const location = godown ? (godown.name + (godown.city ? ', '+godown.city : '')) : '—';

  const now = new Date();
  const istStr = now.toLocaleString('en-GB',{
    timeZone:'Asia/Kolkata',
    day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true
  });
  const grnDateFmt = grnDate
    ? fmtDate(grnDate)
    : '—';

  // Build item data array — separate pmType and brand from productName
  const items = checkedRows.map(row => {
    const raw = (row.querySelector('.prod-combo-input')?.value||'').trim();
    const pid = parseInt(row.querySelector('.gi-product,.grn-item-product-id')?.value) || 0;
    let pmType = '', productName = raw || '—', brandName = '', productCode = '';
    // Preferred: look up via product id. Check both window._products (cross-module)
    // and _products (local if this module has its own copy)
    const prodList = (window._products && window._products.length)
                     ? window._products
                     : (typeof _products !== 'undefined' ? _products : []);
    const prod = prodList.find(p => p.id === pid);
    if(prod) {
      pmType      = prod.pm_type || '';
      productName = prod.product_name || raw;
      brandName   = prod.brand_name || '';
      productCode = (prod.product_code || '').trim();
      console.log(`[Label] Product ${pid}: name=${productName.slice(0,30)}, brand="${brandName}", pm=${pmType}, code=${productCode}`);
    } else {
      console.warn(`[Label] Product id ${pid} NOT FOUND in products cache (cache has ${prodList.length} items). Using raw text: ${raw.slice(0,30)}`);
      // Fallback: parse "[PM Type] Name" pattern if lookup fails
      const m = raw.match(/^\[([^\]]+)\]\s*(.*)$/);
      if(m) { pmType = m[1].trim(); productName = m[2].trim() || raw; }
    }
    const noOfBox  = parseInt(row.querySelector('.grn-item-boxes,.gi-boxes')?.value)    || 0;
    const boxCount = parseInt(row.querySelector('.grn-item-boxcount,.gi-boxcount')?.value)|| 0;
    const qty      = parseFloat(row.querySelector('.grn-item-qty,.gi-qty')?.value)       || 0;
    // FIFO code — set by egrnAddItem from the GRN GET endpoint. May be empty
    // for fresh / unsaved rows; in that case the lookup below fills it in.
    const fifoCode = (row.dataset?.fifoCode || '').trim();
    // GRN item id — set by saveGrn (new-GRN flow) or egrnAddItem (edit flow).
    // Used by makeLabelPage to look up the correct short_code per LINE
    // rather than per (product, position) — fixes duplicate-QR bug when
    // a product appears on multiple GRN lines.
    const grnItemId = parseInt(row.dataset?.grnItemId || 0) || 0;
    // Per-line free-text version (e.g. "Old design") — appended in [] next
    // to the product name on the label.
    const productVersion = (row.querySelector('.gi-version')?.value || '').trim();
    return { productId: pid, productCode, productName, pmType, brandName, noOfBox, boxCount, qty, fifoCode, grnItemId, productVersion };
  });

  // Store on modal for printing
  const modal = document.getElementById('grnLabelModal');
  // grnId discovery order:
  //   1. edit-GRN modal's hidden field (egrn-id) — set by openEditGrn
  //   2. new-GRN modal's dataset.savedGrnId — stashed by saveGrn() after
  //      a successful save (covers both manual save + the auto-save path
  //      above that fires when label-print is clicked on an unsaved GRN)
  // Either way, having a real id is what unlocks the short_code fetch
  // and FIFO lookup paths below.
  let grnId = parseInt(document.getElementById('egrn-id')?.value) || null;
  if(!grnId){
    const _pmModal = document.getElementById('pmVoucherModal');
    const stashed = _pmModal && _pmModal.dataset && _pmModal.dataset.savedGrnId;
    if(stashed){
      const n = parseInt(stashed);
      if(n && !isNaN(n)) grnId = n;
    }
  }
  modal._labelData = {
    grnNo, grnDate, grnDateFmt, supervisor, location, istStr, items,
    supplierText, invoiceNo, invoiceDateFmt, grnId
  };

  // ── FIFO codes ──────────────────────────────────────────────────
  // Two paths get the FIFO code onto each label:
  //   1. From the row's data-fifo-code attribute (already set by egrnAddItem
  //      from /api/pm_stock/grn/<id>'s fifo_code field). This is the fast path
  //      and works for any saved GRN opened via the edit modal.
  //   2. Lookup via /api/pm_stock/fifo/lookup using the GRN id. Used as a
  //      fallback for edge cases where the row attribute is missing.
  // Reuse the same grnId resolved above so auto-saved new-GRN prints get
  // FIFO codes from the get-go.
  const grnIdForFifo = grnId || 0;
  const itemsMissingFifo = items.filter(it => it.productId && !it.fifoCode);
  if(grnIdForFifo && itemsMissingFifo.length){
    const lots = itemsMissingFifo.map(it => ({
      kind: 'grn', ref: grnIdForFifo, product_id: it.productId
    }));
    if(lots.length){
      // Mark the labelData as awaiting FIFO so the print button can wait.
      modal._labelData._fifoPending = true;
      fetch('/api/pm_stock/fifo/lookup', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ lots })
      }).then(r => r.json()).then(d => {
        if(d && d.status === 'ok' && Array.isArray(d.results)){
          const map = {};
          d.results.forEach(r => { if(r.product_id) map[r.product_id] = r.fifo_code || ''; });
          (modal._labelData.items || []).forEach(it => {
            if(!it.fifoCode) it.fifoCode = map[it.productId] || '';
          });
        }
        modal._labelData._fifoPending = false;
      }).catch(_ => { modal._labelData._fifoPending = false; });
    }
  }

  // ── Short-code map fetch ───────────────────────────────────────
  // Each box gets an 8-char sequential short_code at GRN-save time.
  // Pull the {product_id: {box_seq: code}} map once per modal open so
  // the renderer (which builds labels lazily, one at a time) can look
  // up the QR payload by (productId, boxNum) without hitting the
  // server per-label. Print button waits via _scPending if the fetch
  // is still in flight when print is clicked.
  if(grnId){
    modal._labelData._scPending = true;
    fetch(`/api/pm_stock/grn/${grnId}/box_short_codes`)
      .then(r => r.json())
      .then(j => {
        if(j && j.status === 'ok'){
          if(j.codes)   modal._labelData._shortCodeMap   = j.codes;    // legacy: { product_id: { box_seq: short_code } }
          if(j.by_item) modal._labelData._shortCodeByItem = j.by_item; // preferred: { grn_item_id: [short_code, ...] }
        }
        modal._labelData._scPending = false;
      })
      .catch(_ => { modal._labelData._scPending = false; });
  }

  // Render preview list
  const list = document.getElementById('lbl-items-list');
  list.innerHTML = items.map((it, i) => {
    const codeBadge = it.productCode
      ? `<span style="display:inline-block;font-family:monospace;font-size:9.5px;font-weight:800;letter-spacing:.5px;padding:1px 6px;border-radius:3px;background:rgba(13,148,136,.10);color:var(--teal,#0d9488);border:1px solid rgba(13,148,136,.3);margin-left:6px">${it.productCode}</span>`
      : `<span style="display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;background:rgba(220,38,38,.10);color:#dc2626;border:1px solid rgba(220,38,38,.3);margin-left:6px" title="No product code — scanner won't be able to identify this item">⚠ no code</span>`;
    return `
    <div style="background:var(--surface,#fff);border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">
      <div style="width:22px;height:22px;border-radius:50%;background:rgba(13,148,136,.1);border:1.5px solid rgba(13,148,136,.3);
        color:var(--teal,#0d9488);font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:700;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.productName}${it.productVersion ? ' <span style="color:#7c3aed">['+it.productVersion.toUpperCase()+']</span>' : ''}${codeBadge}</div>
        <div style="font-size:10px;color:var(--muted,#9ca3af);margin-top:1px">
          ${it.noOfBox} boxes × ${it.boxCount} pcs = <strong style="color:var(--teal,#0d9488)">${it.qty.toLocaleString('en-IN')} pcs</strong>
        </div>
      </div>
      <div style="font-size:9px;color:var(--muted,#9ca3af);text-align:right;flex-shrink:0">
        <div>GRN: <strong style="font-family:monospace;color:var(--teal,#0d9488)">${grnNo}</strong></div>
        <div>${grnDateFmt}</div>
      </div>
    </div>`;
  }).join('');

  // Show supplier info below item list
  document.getElementById('lbl-supplier-preview').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px;padding:8px 10px;background:rgba(13,148,136,.05);border:1px solid rgba(13,148,136,.2);border-radius:7px;font-size:10px">
      <div><span style="color:var(--muted,#9ca3af);font-size:9px;text-transform:uppercase;letter-spacing:.5px">Supplier</span><br><strong>${supplierText}</strong></div>
      <div><span style="color:var(--muted,#9ca3af);font-size:9px;text-transform:uppercase;letter-spacing:.5px">Invoice No</span><br><strong style="font-family:monospace">${invoiceNo}</strong></div>
      <div><span style="color:var(--muted,#9ca3af);font-size:9px;text-transform:uppercase;letter-spacing:.5px">Invoice Date</span><br><strong>${invoiceDateFmt}</strong></div>
    </div>`;

  const totalLabels = items.reduce((sum, it) => sum + Math.max(it.noOfBox || 1, 1), 0);
  document.getElementById('lbl-count-hint').textContent =
    `${items.length} item${items.length>1?'s':''} → ${totalLabels} label${totalLabels>1?'s':''} total (one per box, numbered "X of N")`;

  modal.classList.add('open');
}

/* ══════════════════════════════════════════════════════
   PRINT — generates one 100×75mm page per item
══════════════════════════════════════════════════════ */
async function grnLabelDoPrint() {
  const modal = document.getElementById('grnLabelModal');
  const d = modal?._labelData;
  if(!d || !d.items?.length){ showToast('No label data','error'); return; }

  // If a FIFO lookup is in flight (kicked off when the modal opened),
  // wait briefly for it so labels stamp the right FIFO code. We poll
  // since the fetch was fired without a stored promise reference.
  if(d._fifoPending){
    const startedAt = Date.now();
    while(d._fifoPending && (Date.now() - startedAt) < 4000){
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // Same wait for the short_code fetch. Bounded so a slow/down fetch
  // can't block printing forever — labels will fall back to encoding
  // the long box_code into their QR, which still scans.
  if(d._scPending){
    const startedAt = Date.now();
    while(d._scPending && (Date.now() - startedAt) < 4000){
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // Block printing if any item is missing a product code — a label without a
  // code can't be scanned back into a voucher and would just have to be reprinted.
  const missing = d.items.filter(it => !((it.productCode || '').trim()));
  if(missing.length){
    const names = missing.slice(0, 3).map(it => '• ' + it.productName).join('\n');
    const more  = missing.length > 3 ? `\n…and ${missing.length - 3} more` : '';
    showToast(`Cannot print — ${missing.length} item${missing.length>1?'s':''} missing product code. Generate codes from the Products tab first.`, 'error', 6000);
    alert(
      `Cannot print labels.\n\n` +
      `${missing.length} item${missing.length>1?'s':''} on this voucher ` +
      `${missing.length>1?'do':'does'} not have a Product Code:\n\n${names}${more}\n\n` +
      `Go to the Products tab and click "Generate Codes" on the banner ` +
      `(make sure each item has a Brand assigned first).`
    );
    return;
  }

  /* ── Group/bag sticker page ───────────────────────────────────────────
     A single 100×75mm sticker that goes on the outside of a shrink-wrapped
     bag of boxes. Visually distinct (purple banner) so warehouse staff
     don't confuse it with a regular box label. Lists the member box codes
     in small text underneath, so even if the QR scanner is unavailable the
     bag's contents are human-readable.

     The QR payload is the bag code (BAG-PRODUCT-G####-L###). When scanned
     into an MTV, the system fans out scans to all member boxes.

     `g` is the group object from /api/pm_stock/grn/<id>/groups.
     `d` is the labelData with header info (grnNo, dates, supervisor, etc.).
  */
  function makeGroupStickerPage(g, d){
    const productName = (g.product_name || '').toString();
    const sizeCls = productName.length <= 14 ? 'xl'
                   : productName.length <= 24 ? 'lg'
                   : productName.length <= 40 ? 'md'
                   : productName.length <= 64 ? 'sm'
                   : productName.length <= 100 ? 'xs' : 'xxs';
    const groupCode  = (g.group_code || '').toUpperCase();
    const memberList = Array.isArray(g.members) ? g.members : [];
    const memberCodes = memberList.map(m => m.box_code).join('   ·   ');
    const totalQty = Number(g.total_qty || 0);

    return `<div class="label-wrap">
<div class="label" style="background:#fff">

  <!-- Purple BAG/LOT banner across the top -->
  <div style="background:linear-gradient(90deg,#7c3aed,#5b21b6);color:#fff;
    padding:6px 12px;display:flex;align-items:center;justify-content:space-between;
    font-weight:800;font-size:11pt;letter-spacing:.5pt">
    <span>🛍️ BAG / LOT</span>
    <span style="font-family:'Courier New',monospace;font-size:9pt;font-weight:700">
      ${memberList.length} BOX${memberList.length===1?'':'ES'}
    </span>
  </div>

  <!-- Product name + group code -->
  <div class="product-box" style="border-color:#7c3aed">
    <div class="product-name ${sizeCls}">${productName || '—'}</div>
    <div class="product-code" style="color:#5b21b6;font-weight:800">(${groupCode})</div>
  </div>

  <!-- Brand + Type -->
  <div class="bt-row">
    <div class="bt-cell">
      <span class="bt-label">BRAND :</span>
      <span class="bt-value lg">${(g.brand_name || '—').toUpperCase()}</span>
    </div>
    <div class="bt-cell">
      <span class="bt-label">TYPE :</span>
      <span class="bt-value lg">${g.pm_type || '—'}</span>
    </div>
  </div>

  <!-- Supplier -->
  <div class="supplier-row">
    <div class="supplier-label">SUPPLIER</div>
    <div class="supplier-name ${(d.supplierText||'').length<=20?'lg':(d.supplierText||'').length<=32?'md':'sm'}">${(d.supplierText||'—').toUpperCase()}</div>
  </div>

  <!-- Mid: GRN/INV info on the left, big QR on the right -->
  <div class="mid-grid">
    <div class="mid-info">
      <div class="info-pair">
        <div class="info-label">GRN. DATE</div>
        <div class="info-value lg">${d.grnDateFmt || '—'}</div>
      </div>
      <div class="info-pair info-pair-right">
        <div class="info-label">INV. DATE</div>
        <div class="info-value lg">${d.invoiceDateFmt || '—'}</div>
      </div>
      <div class="info-pair">
        <div class="info-label">GRN. NO</div>
        <div class="info-value lg">${d.grnNo || '—'}</div>
      </div>
      <div class="info-pair info-pair-right">
        <div class="info-label">TOTAL QTY</div>
        <div class="info-value lg" style="color:#5b21b6">${totalQty.toLocaleString('en-IN')}</div>
      </div>
    </div>
    <div class="mid-qr">
      <div class="qr-zone">
        <canvas class="qrcanvas" data-payload="${groupCode}"></canvas>
      </div>
    </div>
  </div>

  <!-- Bottom: list member box codes in small text -->
  <div style="margin:6px 8px 4px;padding:5px 8px;background:rgba(124,58,237,.06);
    border-radius:4px;border:1px dashed rgba(124,58,237,.3);
    font-family:'Courier New',monospace;font-size:6.5pt;line-height:1.5;
    color:#5b21b6;max-height:42px;overflow:hidden">
    <strong style="font-size:7pt;letter-spacing:.4pt">CONTAINS:</strong> ${memberCodes || '—'}
  </div>

  <!-- Bottom strip: supervisor + branding -->
  <div class="footer-strip" style="background:#5b21b6;color:#fff">
    <span><strong>SUPERVISOR</strong> ${(d.supervisor||'—').toUpperCase()}</span>
    <span><strong>HCP WELLNESS PVT. LTD</strong></span>
  </div>

</div>
</div>`;
  }

  /* ── Build one physical label page ─────────────────────────
     boxNum  = current box number (1-based)
     totalBoxes = total boxes for this item (noOfBox)
     Each item with noOfBox=N produces N pages, numbered "1 of N", "2 of N" …
  ─────────────────────────────────────────────────────────── */
  function makeLabelPage(it, d, boxNum, totalBoxes, isLastPage, localItemPos) {

    // ── QR payload: just the box code (e.g. "BEARTUBE12-G0234-B003").
    //   Plain text — no JSON, no preamble. The scanner looks up everything
    //   else (product, per-box qty, current location) by this code.
    let perBoxForQr = parseFloat(it.boxCount) || 0;
    const totalQtyForQr = parseFloat(it.qty) || 0;
    if(!perBoxForQr && totalBoxes > 0 && totalQtyForQr > 0) {
      perBoxForQr = totalQtyForQr / totalBoxes;
      if(Math.abs(perBoxForQr - Math.round(perBoxForQr)) < 0.001) perBoxForQr = Math.round(perBoxForQr);
    }
    // Box code: prefer per-item override (set by the split-box flow,
    // where each child has a server-generated code that doesn't match
    // the GRN-derived pattern), then pre-computed list (opening labels),
    // else build it from grnNo + product code + box seq (regular GRN flow).
    let boxCode;
    if(it.boxCode) {
      // Split-box children pass their server-generated box_code directly
      // on each item. The label renderer must use this verbatim — the
      // children's codes use the next free B-seq for the GRN, not the
      // box_seq the page-cursor would compute.
      boxCode = it.boxCode;
    }
    if(!boxCode && Array.isArray(d.boxCodes) && d.boxCodes.length) {
      // For opening labels, server returns one code per page in the same order
      // we expand items below. Use the cursor stored on `d`.
      d._codeCursor = (d._codeCursor || 0);
      boxCode = d.boxCodes[d._codeCursor] || '';
      d._codeCursor++;
    }
    if(!boxCode) {
      const grnNoStr  = String(d.grnNo || '');
      const grnDigits = (grnNoStr.match(/\/(\d{1,5})\//) || grnNoStr.match(/(\d+)/) || ['',''])[1] || '0';
      const grnPart   = 'G' + String(grnDigits).padStart(4, '0');
      const boxPart   = 'B' + String(boxNum).padStart(3, '0');
      const productPart = (it.productCode || 'XXXXXXXXXX').toUpperCase();
      boxCode = `${productPart}-${grnPart}-${boxPart}`;
    }
    // ── QR payload selection ────────────────────────────────────────
    // The QR encodes a SHORT code (8 chars, e.g. "A0000001") when one
    // is available; the long box_code stays as the visible text below
    // the product name. Four sources in priority order:
    //   1. it._shortCode  — set by callers that already know it (reprint
    //                       endpoints pass parallel arrays).
    //   2. d.shortCodes[cursor-1] — opening-label cursor path, parallel
    //                       array to d.boxCodes consumed above.
    //   3. d._shortCodeByItem[grnItemId][localItemPos-1] — preferred for
    //                       first-print GRN labels. Keyed by GRN item id
    //                       so two lines of the same product get DIFFERENT
    //                       short codes per box, even when the print loop
    //                       processes them in either order.
    //   4. d._shortCodeMap[productId][boxNum] — LEGACY fallback. Works
    //                       fine when a product appears on only one GRN
    //                       line; produces duplicate QRs across lines of
    //                       the same product, which is exactly the bug
    //                       source (3) above fixes. Kept for old payloads.
    // Final fallback: long box_code. Both forms are accepted by scan endpoints
    // (OR-clause on short_code OR box_code) so old-style QRs keep working.
    let qrPayload = '';
    if(it._shortCode){
      qrPayload = it._shortCode;
    } else if(Array.isArray(d.shortCodes) && d._codeCursor > 0){
      qrPayload = d.shortCodes[d._codeCursor - 1] || '';
    } else if(d._shortCodeByItem && it.grnItemId && localItemPos){
      // Preferred path — keyed by GRN line id, indexed by per-line position.
      const arr = d._shortCodeByItem[it.grnItemId] || d._shortCodeByItem[String(it.grnItemId)];
      if(Array.isArray(arr)){
        qrPayload = arr[localItemPos - 1] || '';
      }
    }
    if(!qrPayload && d._shortCodeMap && it.productId){
      // Legacy fallback for label payloads that don't carry a grnItemId.
      const perProd = d._shortCodeMap[it.productId] || d._shortCodeMap[String(it.productId)];
      if(perProd){
        qrPayload = perProd[boxNum] || perProd[String(boxNum)] || '';
      }
    }
    if(!qrPayload) qrPayload = boxCode;
    // Keep the api.qrserver.com URL ready as a defensive fallback in case
    // the local QR library fails to load (offline / CDN blocked). The
    // primary path generates QRs in-page from qrcode-generator (see the
    // window.onload script later in this file).
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=2&data=${encodeURIComponent(qrPayload)}&ecc=M`;

    // ── Adaptive product font size — shrink as name gets longer ──
    // The product box grows to fill slack vertical space (flex: 1 0 auto),
    // so we pick tier based on how many lines the text needs at each font size
    //
    // The "display name" appends the per-line product_version in [] when set
    // (e.g. "CM-Perfora ... 125GRM Tube [OLD DESIGN]"). Done once here so
    // both the size-class calculation and the rendered HTML see the same
    // string length.
    const _verRaw = (it.productVersion || '').trim();
    const displayName = _verRaw
      ? `${it.productName} [${_verRaw.toUpperCase()}]`
      : (it.productName || '');
    const nameLen = displayName.length;
    let sizeCls;
    if      (nameLen <= 18) sizeCls = 'xl';    // very short → 14pt, 1 line
    else if (nameLen <= 32) sizeCls = 'lg';    // short → 12pt, 2 lines
    else if (nameLen <= 52) sizeCls = 'md';    // medium → 10pt, 2-3 lines
    else if (nameLen <= 80) sizeCls = 'sm';    // long → 8.5pt, 3 lines
    else                    sizeCls = 'xs';    // very long → 7pt, 4 lines

    return `<div class="label-wrap">
<div class="label">

  <!-- ① Product name box (rounded border) — adaptive for full visibility -->
  <div class="product-box">
    <div class="product-name ${nameLen<=14?'xl':nameLen<=24?'lg':nameLen<=40?'md':nameLen<=64?'sm':nameLen<=100?'xs':'xxs'}">${displayName}</div>
    <!-- Prominent short_code — this is what the QR encodes and what
         operators read out loud / type manually if the QR is damaged.
         Falls back to the long box_code on legacy boxes that don't yet
         have a short_code (run the Backfill Short Codes admin tool to
         clear those up). The long box_code is intentionally NOT shown
         here anymore — it was confusing for warehouse staff. -->
    <div class="short-code">${qrPayload}</div>
  </div>

  <!-- ② Brand + Type row (two rounded pills) — values adaptive -->
  <div class="bt-row">
    <div class="bt-cell">
      <span class="bt-label">BRAND :</span>
      <span class="bt-value ${(it.brandName||'').length<=8?'lg':(it.brandName||'').length<=14?'md':(it.brandName||'').length<=20?'sm':'xs'}">${(it.brandName||'—').toUpperCase()}</span>
    </div>
    <div class="bt-cell">
      <span class="bt-label">TYPE :</span>
      <span class="bt-value ${(it.pmType||'').length<=8?'lg':(it.pmType||'').length<=14?'md':(it.pmType||'').length<=20?'sm':'xs'}">${it.pmType||'—'}</span>
    </div>
  </div>

  <!-- ③ Supplier (or location for opening stock) — adaptive -->
  ${d.isOpening ? `
    <div class="supplier-row">
      <div class="supplier-label">LOCATION</div>
      <div class="supplier-name ${(d.locationName||'').length<=20?'lg':(d.locationName||'').length<=32?'md':(d.locationName||'').length<=48?'sm':'xs'}">${(d.locationName||'—').toUpperCase()}</div>
    </div>
  ` : `
    <div class="supplier-row">
      <div class="supplier-label">SUPPLIER</div>
      <div class="supplier-name ${(d.supplierText||'').length<=20?'lg':(d.supplierText||'').length<=32?'md':(d.supplierText||'').length<=48?'sm':'xs'}">${(d.supplierText||'—').toUpperCase()}</div>
    </div>
  `}

  <!-- ④ Middle: 2-col date/no info LEFT (with dotted divider) + QR RIGHT -->
  <div class="mid-grid">

    <div class="mid-info">
      ${d.isOpening ? `
        <div class="info-pair">
          <div class="info-label">OP. DATE</div>
          <div class="info-value ${String(d.opDateFmt||'').length<=12?'lg':String(d.opDateFmt||'').length<=18?'md':'sm'}">${d.opDateFmt||'—'}</div>
        </div>
        <div class="info-pair info-pair-right">
          <div class="info-label">REF</div>
          <div class="info-value ${String(d.opLabel||'').length<=12?'lg':String(d.opLabel||'').length<=18?'md':'sm'}">${d.opLabel||'—'}</div>
        </div>
        <div class="info-pair">
          <div class="info-label">REMARKS</div>
          <div class="info-value ${String(d.remarks||'').length<=12?'lg':String(d.remarks||'').length<=24?'md':String(d.remarks||'').length<=40?'sm':'xs'}">${d.remarks||'—'}</div>
        </div>
        <div class="info-pair info-pair-right"></div>
      ` : `
        <div class="info-pair">
          <div class="info-label">GRN. DATE</div>
          <div class="info-value ${String(d.grnDateFmt||'').length<=12?'lg':String(d.grnDateFmt||'').length<=18?'md':'sm'}">${d.grnDateFmt}</div>
        </div>
        <div class="info-pair info-pair-right">
          <div class="info-label">INV. DATE</div>
          <div class="info-value ${String(d.invoiceDateFmt||'').length<=12?'lg':String(d.invoiceDateFmt||'').length<=18?'md':'sm'}">${d.invoiceDateFmt}</div>
        </div>
        <div class="info-pair">
          <div class="info-label">GRN. NO</div>
          <div class="info-value ${String(d.grnNo||'').length<=14?'lg':String(d.grnNo||'').length<=22?'md':String(d.grnNo||'').length<=30?'sm':'xs'}">${d.grnNo}</div>
        </div>
        <div class="info-pair info-pair-right">
          <div class="info-label">INV. NO</div>
          <div class="info-value ${String(d.invoiceNo||'').length<=14?'lg':String(d.invoiceNo||'').length<=22?'md':String(d.invoiceNo||'').length<=30?'sm':'xs'}">${d.invoiceNo}</div>
        </div>
      `}
    </div>

    <div class="mid-qr">
      <div class="qr-img-wrap">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
             alt="QR" class="qrimg"
             data-qr-payload="${qrPayload}"
             data-qr-fallback-url="${qrUrl}"
             crossorigin="anonymous">
      </div>
      <div class="fifo-sep"></div>
      <div class="fifo-block">
        <div class="fifo-label">FIFO</div>
        ${(() => {
          const fc = String(it.fifoCode || d.fifoCode || '').trim();
          const display = fc || '—';
          const len = display.length;
          const cls = len <= 2 ? 'lg' : len <= 3 ? 'md' : len <= 4 ? 'sm' : 'xs';
          return `<div class="fifo-no ${cls}">${display}</div>`;
        })()}
      </div>
    </div>

  </div>

  <!-- ⑤ Quantity formula — adaptive numbers (some totals can be 6+ digits) -->
  ${(() => {
    let perBox = parseFloat(it.boxCount) || 0;
    const totalQty = parseFloat(it.qty) || 0;
    if(!perBox && totalBoxes > 0 && totalQty > 0) {
      perBox = totalQty / totalBoxes;
      if(Math.abs(perBox - Math.round(perBox)) < 0.001) perBox = Math.round(perBox);
    }
    const perBoxDisp = perBox ? perBox.toLocaleString('en-IN') : '—';
    const totalDisp  = totalQty.toLocaleString('en-IN');
    const boxDisp    = `${boxNum}/${totalBoxes}`;
    const qSize = (s) => s.length<=4?'lg':s.length<=6?'md':s.length<=8?'sm':'xs';
    return `<div class="qty-box">
      <div class="qty-cell">
        <div class="qty-label">NO. OF BOX</div>
        <div class="qty-value ${qSize(boxDisp)}">${boxDisp}</div>
      </div>
      <div class="qty-op">x</div>
      <div class="qty-cell">
        <div class="qty-label">PER BOX QTY.</div>
        <div class="qty-value ${qSize(perBoxDisp)}">${perBoxDisp}</div>
      </div>
      <div class="qty-op">=</div>
      <div class="qty-cell">
        <div class="qty-label">TOTAL QTY.</div>
        <div class="qty-value ${qSize(totalDisp)}">${totalDisp}</div>
      </div>
    </div>`;
  })()}

  <!-- ⑥ Bottom strip — Supervisor LEFT, Company RIGHT -->
  <div class="footer-row">
    <div class="footer-cell">
      <span class="footer-label">SUPERVISOR</span>
      <span class="footer-value ${(d.supervisor||'').length<=10?'lg':(d.supervisor||'').length<=18?'md':'sm'}">${(d.supervisor||'—').toUpperCase()}</span>
    </div>
    <div class="footer-cell footer-cell-right">
      <span class="footer-company">HCP WELLNESS PVT. LTD</span>
    </div>
  </div>

</div>
</div>`;
  }

  /* ── Expand items: N boxes → N pages each ──
     Items normally produce N pages (one per box) numbered "1 of N", "2 of N"…
     Selective reprint passes a flat list of synthetic single-box items,
     each pre-stamped with `_boxNum` (this label's position) and
     `_totalBoxes` (the total selection size). When those overrides
     are present we use them instead of the loop counters so the
     reprinted labels show e.g. "3/5" instead of "1/1".

     Multi-item same product
     -----------------------
     Operators legitimately split a single product across two GRN rows when
     they have N full boxes plus 1 partial box (different per_box_qty). The
     backend's box_code is keyed on (product, grn, seq), so each row CANNOT
     restart at B001 — that would collide on the UNIQUE box_code index, with
     Item 2's partial box silently lost. To match the backend's continuous
     box_seq numbering, this expander now tracks a running seq per product
     across all items of the GRN, and stamps the final cross-item total as
     the denominator on every label for that product. */
  const allPages = [];

  // First pass: total boxes per product across all items (final denominator).
  // Keyed by productId when available, else by productCode, else by
  // productName so we still group correctly when codes are missing.
  const _prodKey = (it) => {
    if(it.productId)   return 'pid:' + it.productId;
    if(it.productCode) return 'code:' + String(it.productCode).toUpperCase();
    return 'name:' + String(it.productName || '');
  };
  const totalByProduct = {};
  d.items.forEach(it => {
    if(typeof it._boxNum === 'number' && typeof it._totalBoxes === 'number') return; // overridden
    const n = Math.max(parseInt(it.noOfBox) || 1, 1);
    const k = _prodKey(it);
    totalByProduct[k] = (totalByProduct[k] || 0) + n;
  });

  // Second pass: emit pages with running per-product seq.
  //   - boxNum / totalBoxes  → shown on the label as "X / Y" (per-product
  //                            count, so a 37-line + 1-line same-product
  //                            GRN reads as 1/38..38/38). This is what
  //                            the operator reads on paper.
  //   - localItemPos         → 1..n WITHIN the current GRN line. Used
  //                            ONLY for short-code lookup against
  //                            by_item[grnItemId][localItemPos-1], so each
  //                            line's boxes get THEIR own short codes
  //                            instead of overlapping at box_seq=1.
  const seqByProduct = {};
  d.items.forEach(it => {
    const hasOverride = (typeof it._boxNum === 'number' && typeof it._totalBoxes === 'number');
    if(hasOverride){
      // Single physical page for this synthetic item; its box-of-N comes
      // straight from the override values. Reprint flows already provide
      // _shortCode directly per page (see _shortCode branch in
      // makeLabelPage), so localItemPos isn't needed here.
      allPages.push({ it, boxNum: it._boxNum, totalBoxes: it._totalBoxes, localItemPos: it._boxNum });
    } else {
      const n = Math.max(parseInt(it.noOfBox) || 1, 1);
      const k = _prodKey(it);
      const productTotal = totalByProduct[k] || n;
      for(let b = 1; b <= n; b++) {
        seqByProduct[k] = (seqByProduct[k] || 0) + 1;
        allPages.push({
          it,
          boxNum:       seqByProduct[k],
          totalBoxes:   productTotal,
          localItemPos: b,               // 1..n within THIS line only
        });
      }
    }
  });

  let pagesHtml = allPages.map((p, idx) =>
    makeLabelPage(p.it, d, p.boxNum, p.totalBoxes, idx === allPages.length - 1, p.localItemPos)
  ).join('\n');

  // ── Group sticker pages ───────────────────────────────────────────────
  // If this GRN has any bagged lines (box-groups), append one group sticker
  // per group AFTER the regular box labels. Stickers reuse the same 100×75mm
  // CSS but add a purple "BAG / LOT" badge and a member-codes list. Operator
  // sticks the bag sticker on the outside of the shrink-wrapped pallet, the
  // individual box labels go on each box inside.
  if(d.grnId){
    try {
      const gr = await fetch(`/api/pm_stock/grn/${d.grnId}/groups`);
      const gd = await gr.json();
      if(gd.status === 'ok' && Array.isArray(gd.groups) && gd.groups.length){
        const stickerHtml = gd.groups.map(g => makeGroupStickerPage(g, d)).join('\n');
        pagesHtml += '\n' + stickerHtml;
      }
    } catch(e){
      console.warn('[group-sticker] fetch failed:', e);
      // Non-fatal — print the regular labels even if groups can't be fetched.
    }
  }

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>GRN Labels — ${d.grnNo}</title>
<style>
  @page { size: 100mm 75mm; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body { font-family: Arial, Helvetica, sans-serif; background: #e8edf2; color: #000; }

  /* Toolbar (screen only) */
  #toolbar {
    background: #000; color: #fff; padding: 8px 16px;
    display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 700;
    position: sticky; top: 0; z-index: 10;
  }
  #toolbar button {
    background: #fff; color: #000; border: none; border-radius: 4px;
    padding: 6px 18px; font-size: 13px; font-weight: 800; cursor: pointer;
  }
  #toolbar .hint { font-size: 11px; font-weight: 400; opacity: .85; }

  .label-wrap { display: flex; justify-content: center; padding: 14px 0; }

  /* THE LABEL — 100mm × 75mm */
  .label {
    width: 100mm; height: 75mm;
    background: #fff;
    color: #000;
    box-shadow: 0 3px 16px rgba(0,0,0,.18);
    display: flex; flex-direction: column;
    padding: 1.4mm 1.8mm 1.2mm 1.8mm;
    overflow: hidden;
    page-break-inside: avoid;
    break-inside: avoid;
    gap: 0.7mm;
    /* Anchor for absolutely-positioned children. Currently used to float
       .mid-qr up so the QR sits closer to the product-box rather than
       being trapped inside the mid-grid below the supplier row. */
    position: relative;
  }

  /* ① PRODUCT BOX — rounded outer border, name HUGE adaptive */
  .product-box {
    border: 0.45mm solid #000;
    border-radius: 1.6mm;
    padding: 0.6mm 1.5mm 0.5mm 1.5mm;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center;
    flex: 0 0 auto;
    min-height: 11mm;
    max-height: 17mm;
    gap: 0.2mm;
    overflow: hidden;
  }
  .product-name {
    font-weight: 900;
    color: #000;
    text-transform: uppercase;
    line-height: 1.05;
    letter-spacing: 0.05mm;
    word-break: break-word;
    overflow-wrap: anywhere;
    width: 100%;
  }
  .product-name.xl   { font-size: 17pt; }
  .product-name.lg   { font-size: 14pt; }
  .product-name.md   { font-size: 11.5pt; }
  .product-name.sm   { font-size: 9.5pt; }
  .product-name.xs   { font-size: 8pt; line-height: 1.08; }
  .product-name.xxs  { font-size: 6.8pt; line-height: 1.1; letter-spacing: 0; }
  /* ── Short code (NEW prominent box identifier) ──────────────────
     Sits between the product name and the long box_code subtitle.
     This is what the QR encodes and what operators read aloud. Set
     prominent enough to be visible from arm's length when handheld
     scanners are used. Monospace so digits/letters stay legible. */
  .short-code {
    font-size: 11pt;
    color: #000;
    font-weight: 800;
    font-family: 'Courier New', Consolas, monospace;
    letter-spacing: 0.3mm;
    margin-top: 0.6mm;
    line-height: 1.05;
    text-align: center;
  }
  .product-code {
    font-size: 6pt;
    color: #555;
    font-weight: 500;
    letter-spacing: 0.08mm;
    margin-top: 0.2mm;
    word-break: break-all;
    line-height: 1.0;
    text-align: center;
  }

  /* ② BRAND + TYPE row */
  .bt-row {
    display: grid;
    grid-template-columns: 1.3fr 1fr;
    gap: 1.4mm;
    flex: 0 0 auto;
    /* No right gutter needed — QR is now positioned BELOW this row, not
       beside it, so brand/type can use the full label width. */
  }
  .bt-cell {
    border: 0.4mm solid #000;
    border-radius: 1.6mm;
    padding: 0.7mm 1.6mm;
    display: flex;
    align-items: center;
    gap: 1.3mm;
    min-height: 6mm;
    overflow: hidden;
  }
  .bt-label {
    font-size: 7.5pt;
    font-weight: 800;
    color: #000;
    letter-spacing: 0.15mm;
    flex: 0 0 auto;
    line-height: 1.1;
  }
  .bt-value {
    font-weight: 900;
    color: #000;
    flex: 1 1 auto;
    line-height: 1.05;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .bt-value.lg { font-size: 11.5pt; }
  .bt-value.md { font-size: 9.5pt; }
  .bt-value.sm { font-size: 8pt; }
  .bt-value.xs { font-size: 6.8pt; line-height: 1.1; }

  /* ③ SUPPLIER */
  .supplier-row {
    flex: 0 0 auto;
    margin-top: 0.2mm;
    padding-left: 0.4mm;
    /* Right gutter reserved for the floating QR — see .bt-row note. */
    padding-right: 22mm;
    overflow: hidden;
  }
  .supplier-label {
    font-size: 6.5pt;
    font-weight: 700;
    color: #000;
    letter-spacing: 0.18mm;
    margin-bottom: 0.2mm;
    line-height: 1.1;
  }
  .supplier-name {
    font-weight: 900;
    color: #000;
    line-height: 1.05;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .supplier-name.lg { font-size: 11.5pt; }
  .supplier-name.md { font-size: 9.5pt; }
  .supplier-name.sm { font-size: 7.8pt; line-height: 1.08; }
  .supplier-name.xs { font-size: 6.5pt; line-height: 1.1; letter-spacing: 0; }

  /* ④ MIDDLE GRID
     Now a single column. The QR/FIFO cell that used to occupy the right
     side moved to absolute positioning at top-right of the label, so the
     left "info pairs" can use full width. */
  .mid-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.4mm;
    flex: 1 1 auto;
    align-items: stretch;
    min-height: 0;
    overflow: hidden;
  }
  .mid-info {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 0.4mm 0.8mm;
    align-items: center;
    position: relative;
    padding: 0.2mm 0;
    min-width: 0;
    min-height: 0;
  }
  .mid-info::before {
    content: '';
    position: absolute;
    top: 8%;
    bottom: 8%;
    left: 50%;
    width: 0;
    border-left: 0.35mm dashed #000;
  }
  .info-pair {
    padding: 0 0.8mm 0 0.4mm;
    overflow: hidden;
    min-width: 0;
  }
  .info-pair-right {
    padding-left: 1.6mm;
  }
  .info-label {
    font-size: 6.2pt;
    font-weight: 700;
    color: #000;
    letter-spacing: 0.12mm;
    margin-bottom: 0.1mm;
    line-height: 1.1;
  }
  .info-value {
    font-weight: 900;
    color: #000;
    line-height: 1.05;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .info-value.lg { font-size: 9.5pt; }
  .info-value.md { font-size: 8pt; }
  .info-value.sm { font-size: 6.8pt; }
  .info-value.xs { font-size: 5.8pt; line-height: 1.1; letter-spacing: 0; }

  /* QR + FIFO stack
     Floats to the top-right of the label (absolutely positioned on .label)
     so the QR sits just below the product-box rather than being trapped
     in the mid-grid below the supplier row. The bt-row and supplier-row
     have a 22mm right-padding to keep their text out of the QR's column.
     Width remains 21mm to preserve the FIFO numerals' readable size at
     7-foot scan distance. */
  .mid-qr {
    position: absolute;
    /* Vertical position chosen to balance the gap ABOVE the QR (between
       the bottom of the brand/type row and the QR's top edge) against
       the gap BELOW the FIFO numeral (between FIFO and the qty-box top).
       Earlier 'top: 21.5mm' left the upper gap visibly smaller than the
       lower one — bumping to 24.5mm centers the whole QR+FIFO stack
       between brand/type row and qty-box. */
    top: 24.5mm;
    right: 1.8mm;          /* match .label right-padding */
    width: 21mm;
    display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    flex-shrink: 0;
    min-height: 0;
    gap: 0.6mm;
  }
  .qr-img-wrap {
    /* Bumped from 14.5mm → 18mm — bigger scan target, easier 7-ft reads. */
    width: 18mm; height: 18mm;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .qrimg {
    width: 100%; height: 100%;
    object-fit: contain;
  }
  .fifo-sep {
    width: 100%;
    height: 0;
    border-top: 0.4mm solid #000;
    margin: 0.2mm 0 0.4mm 0;
  }
  .fifo-block {
    width: 100%;
    text-align: center;
    line-height: 1;
    color: #000;
    flex: 1 1 auto;
    min-height: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .fifo-label {
    font-size: 5.4pt;
    font-weight: 800;
    letter-spacing: 0.18mm;
    color: #000;
    margin-bottom: 0.3mm;
  }
  /* FIFO number — adaptive size by length so a 1-char ("A1") code
     is HUGE for 7-ft readability while a longer ("AA42") code still
     fits without spilling out of the 21mm-wide cell. */
  .fifo-no {
    font-weight: 900;
    color: #000;
    line-height: 0.95;
    letter-spacing: 0;
  }
  .fifo-no.lg { font-size: 28pt; }   /* "A1" — 2 chars  → ~9.9mm tall */
  .fifo-no.md { font-size: 22pt; }   /* "A12" — 3 chars → ~7.8mm tall */
  .fifo-no.sm { font-size: 18pt; }   /* "AA12" — 4 chars */
  .fifo-no.xs { font-size: 14pt; }   /* longer */

  /* ⑤ QUANTITY BOX — adaptive numbers */
  .qty-box {
    border: 0.45mm solid #000;
    border-radius: 1.6mm;
    padding: 0.6mm 1.6mm;
    display: grid;
    grid-template-columns: 1fr 3.5mm 1fr 3.5mm 1fr;
    align-items: center;
    gap: 0;
    flex: 0 0 auto;
    min-height: 10.5mm;
    overflow: hidden;
  }
  .qty-cell {
    text-align: center;
    overflow: hidden;
    min-width: 0;
  }
  .qty-label {
    font-size: 6.2pt;
    font-weight: 700;
    color: #000;
    letter-spacing: 0.15mm;
    margin-bottom: 0.15mm;
    line-height: 1.1;
  }
  .qty-value {
    font-weight: 900;
    color: #000;
    line-height: 1;
    letter-spacing: -0.05mm;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .qty-value.lg { font-size: 14pt; }
  .qty-value.md { font-size: 11.5pt; }
  .qty-value.sm { font-size: 9.5pt; }
  .qty-value.xs { font-size: 8pt; }
  .qty-op {
    font-size: 11pt;
    font-weight: 700;
    color: #000;
    text-align: center;
    line-height: 1;
  }

  /* ⑥ FOOTER */
  .footer-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0.4mm;
    flex: 0 0 auto;
    gap: 1.6mm;
    overflow: hidden;
  }
  .footer-cell {
    display: flex;
    align-items: baseline;
    gap: 1.3mm;
    overflow: hidden;
    min-width: 0;
  }
  .footer-cell-right {
    margin-left: auto;
    flex: 0 0 auto;
  }
  .footer-label {
    font-size: 6.2pt;
    font-weight: 700;
    color: #000;
    letter-spacing: 0.18mm;
    flex: 0 0 auto;
    line-height: 1.1;
  }
  .footer-value {
    font-weight: 900;
    color: #000;
    line-height: 1.05;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .footer-value.lg { font-size: 9pt; }
  .footer-value.md { font-size: 7.5pt; }
  .footer-value.sm { font-size: 6.5pt; line-height: 1.1; }
  .footer-company {
    font-size: 8.5pt;
    font-weight: 900;
    color: #000;
    letter-spacing: 0.12mm;
    line-height: 1.1;
    flex: 0 0 auto;
  }

  /* PRINT */
  @media print {
    body { background: #fff; }
    #toolbar { display: none; }
    .label-wrap { padding: 0; }
    .label { border: none; box-shadow: none; page-break-after: always; }
    .label:last-child { page-break-after: avoid; }
  }
</style>
</head>
<body>
<div id="toolbar">
  <button onclick="window.print()">🖨️ Print Labels</button>
  <span class="hint">${allPages.length} label${allPages.length>1?'s':''} · 100×75mm · Margins: None · Scale: 100%</span>
</div>
${pagesHtml}
<!-- ──────────────────────────────────────────────────────────────
  QR LIBRARY (cdnjs) — generates QR codes locally in <50ms each so we
  don't hammer api.qrserver.com and trip its rate limit (which was
  causing the blank-QR pages B003+ when printing 18+ labels).
  If this script fails to load (offline / CDN blocked / very old
  browser), the boot script below falls back to the api.qrserver.com
  URL stored on each img's data-qr-fallback-url attribute.
─────────────────────────────────────────────────────────────── -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/2.0.4/qrcode.min.js"></script>
<script>
  // ── Local QR rendering ─────────────────────────────────────────
  // Uses qrcode-generator's typeNumber=0 (auto) with ECC level 'H'
  // (30% damage tolerance) to match the previous api.qrserver.com
  // ecc=H output. Output is rendered to a same-origin data URL so
  // the print engine doesn't need any network.
  function makeQrDataUrl(payload){
    if(typeof qrcode === 'undefined') return null;
    try {
      // ECC level 'M' (15% redundancy) instead of 'H' (30%). On a small
      // 100×75mm thermal label, 'H' packs so many modules that each cell
      // prints sub-pixel and scanners can't resolve them. 'M' roughly
      // halves the module count for the same payload, giving larger, far
      // more scannable cells while still tolerating normal print wear.
      var qr = qrcode(0, 'M');
      qr.addData(String(payload || ''));
      qr.make();
      // Larger cellSize → bigger source bitmap → crisper when the print CSS
      // scales it into the QR cell. margin=2 keeps the mandatory quiet zone.
      return qr.createDataURL(10, 2);
    } catch(e){
      return null;
    }
  }

  // ── Defensive fallback: batched + retry api.qrserver.com loader ──
  // Only used when the local library failed. Loads at most 4 images
  // concurrently; on error retries once after a 600ms delay before
  // giving up. Stops the cascading rate-limit failure pattern that
  // was producing the original blank-QR pages.
  function loadImageWithRetry(img, url, attempt){
    return new Promise(function(resolve){
      function fire(){
        img.onload  = function(){ resolve(true); };
        img.onerror = function(){
          if(attempt < 1){
            setTimeout(function(){ loadImageWithRetry(img, url, attempt+1).then(resolve); }, 600);
          } else {
            resolve(false);
          }
        };
        img.src = url;
      }
      fire();
    });
  }

  function loadInBatches(imgs, batchSize){
    var i = 0;
    function next(){
      if(i >= imgs.length) return Promise.resolve();
      var slice = imgs.slice(i, i + batchSize);
      i += batchSize;
      return Promise.all(slice.map(function(img){
        var url = img.getAttribute('data-qr-fallback-url') || '';
        return loadImageWithRetry(img, url, 0);
      })).then(next);
    }
    return next();
  }

  // Wait for an <img> element src to be fully decoded and paintable.
  // We prefer img.decode() (returns a promise that resolves when decode is
  // done), but fall back to a one-shot onload listener for older browsers.
  // Either way the promise resolves to true on success, false on failure —
  // never rejects, so a single broken QR can't kill the whole print.
  function waitForImageReady(img){
    return new Promise(function(resolve){
      if(img.complete && img.naturalWidth > 0){
        // Already decoded (e.g. cached). decode() is still the safer call —
        // forces the browser to finish ANY pending decode work before resolving.
        if(typeof img.decode === 'function'){
          img.decode().then(function(){ resolve(true); }, function(){ resolve(false); });
        } else {
          resolve(true);
        }
        return;
      }
      // Image is still being parsed (data URL is large or 18+ assigned at once).
      var done = false;
      img.addEventListener('load',  function(){ if(!done){ done=true; resolve(true);  } });
      img.addEventListener('error', function(){ if(!done){ done=true; resolve(false); } });
      // Safety net — never block printing forever if a single img wedges.
      setTimeout(function(){ if(!done){ done=true; resolve(false); } }, 5000);
    });
  }

  window.addEventListener('load', function() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('.qrimg'));
    if (!imgs.length) { window.print(); return; }

    // ── Primary path: local generation ──
    // Walk every QR slot and try to fill it from the library. Track
    // both filled images (so we can await their decode before printing)
    // AND any that failed so we can fall through to the network fallback
    // for just those (instead of all-or-nothing).
    var filled = [];     // images we assigned a data URL to — must wait for decode
    var unfilled = [];   // library failed — fall back to network
    imgs.forEach(function(img){
      var payload = img.getAttribute('data-qr-payload') || '';
      var data    = makeQrDataUrl(payload);
      if(data){
        img.src = data;
        filled.push(img);
      } else {
        unfilled.push(img);
      }
    });

    // ── Crucial: wait for every locally-filled QR's data URL to decode ──
    // Without this, on large sheets (300+ labels = 300+ data URLs assigned
    // in a tight loop) Chrome fires window.print() before its image-decode
    // pipeline catches up, and the printed page captures the original 1×1
    // transparent GIF placeholders → blank QR slots. img.decode() resolves
    // only once each image is paintable, fixing the race.
    var decodeWait = Promise.all(filled.map(waitForImageReady));

    var fallbackWait;
    if(unfilled.length === 0){
      fallbackWait = Promise.resolve();
    } else {
      console.warn('[label-print] Local QR generation failed for ' +
                   unfilled.length + '/' + imgs.length +
                   ' labels — falling back to api.qrserver.com');
      fallbackWait = loadInBatches(unfilled, 4);
    }

    Promise.all([decodeWait, fallbackWait]).then(function(){
      // Small extra delay lets the browser commit the final layout/paint
      // after the last QR settles. 150ms was insufficient on large sheets;
      // 400ms is generous without being noticeable to the user.
      setTimeout(function(){ window.print(); }, 400);
    });
  });
<\/script>
</body>
</html>`;

  /* ── Always open in a new window so Chrome applies @page size correctly ── */
  const win = window.open('', '_blank', 'width=500,height=600');
  if(!win) {
    showToast('Pop-up blocked — please allow pop-ups for this site and try again', 'error', 5000);
    return;
  }
  win.document.write(fullHtml);
  win.document.close();
  closeModal('grnLabelModal');
}

/* ════════════════════════════════════════════════════════════
   PRINT OPENING-STOCK LABELS
   Reuses the GRN label print pipeline by setting `_labelData`
   on the (hidden) grnLabelModal element with isOpening=true so
   the middle section shows Opening info instead of GRN/Supplier.
   The server-supplied box codes (PRODUCTCODE-OPNNNN-BNNN) ride
   on `boxCodes`, used in order as each page is built.
═══════════════════════════════════════════════════════════════ */
function printOpeningLabels(payload) {
  // payload shape (from server):
  //   { op_label, product_id, product_code, product_name, no_of_box,
  //     per_box_qty, per_box_qtys?, total_qty, godown_id, box_codes,
  //     op_date, remarks, groups? }
  // If `per_box_qtys` is present (one entry per box) we treat the print
  // as a multi-group case — different boxes carry different qty values.
  // Otherwise we fall back to the legacy single-pbq path.
  if(!payload || !payload.box_codes || !payload.box_codes.length) {
    showToast('No box codes returned from server', 'error');
    return;
  }
  // Locate product details from cache for richer display (pm_type, brand)
  const prodList = (window._products || []);
  const prod = prodList.find(p => p.id === payload.product_id) || {};

  // Locate location name from godown cache
  const gd = (window._godowns || []).find(g => g.id === payload.godown_id) || {};
  const isFloor   = (gd.godown_type === 'floor' || gd.is_floor);
  const locName   = isFloor ? (gd.name + ' (Factory)') : (gd.name || '—');

  // Format opening date
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fdt = (s) => {
    if(!s) return '—';
    const dt = String(s).slice(0,10).split('-');
    if(dt.length !== 3) return s;
    return `${dt[2]}/${dt[1]}/${dt[0]}`;
  };

  // Detect multi-pbq mode: per_box_qtys array with varying values
  const pbqs = Array.isArray(payload.per_box_qtys) ? payload.per_box_qtys : null;
  const totalBoxes = Number(payload.no_of_box) || (payload.box_codes || []).length;
  const isMixed = pbqs && pbqs.length === payload.box_codes.length
                       && pbqs.some(q => Number(q) !== Number(pbqs[0]));

  let items;
  if(isMixed){
    // One synthetic single-page item per box, each with its own per-box qty.
    // makeLabelPage's caller honours `_boxNum` / `_totalBoxes` overrides
    // and `boxCount` per item — same mechanism as selective reprint.
    items = payload.box_codes.map((code, i) => ({
      productId:    payload.product_id,
      productCode:  payload.product_code,
      productName:  payload.product_name || prod.product_name || '—',
      pmType:       payload.pm_type   || prod.pm_type    || '',
      brandName:    payload.brand_name || prod.brand_name || '',
      noOfBox:      1,
      boxCount:     Number(pbqs[i]) || 0,
      qty:          Number(pbqs[i]) || 0,
      _boxCode:     code,
      // 8-char short_code for the QR payload. Empty = legacy box; the
      // renderer falls back to encoding the long box_code in those.
      _shortCode:   (Array.isArray(payload.short_codes) ? (payload.short_codes[i] || '') : ''),
      _boxNum:      i + 1,
      _totalBoxes:  totalBoxes,
    }));
  } else {
    // Legacy single-pbq path — one item, expanded N times by the loop.
    items = [{
      productId:    payload.product_id,
      productCode:  payload.product_code,
      productName:  payload.product_name || prod.product_name || '—',
      pmType:       payload.pm_type   || prod.pm_type    || '',
      brandName:    payload.brand_name || prod.brand_name || '',
      noOfBox:      payload.no_of_box,
      boxCount:     payload.per_box_qty,  // grnLabel calls this "boxCount" = per-box
      qty:          payload.total_qty
    }];
  }

  // Construct the data shape expected by grnLabelDoPrint
  const labelData = {
    isOpening:       true,
    opLabel:         payload.op_label,
    opDateFmt:       fdt(payload.op_date),
    locationName:    locName,
    remarks:         payload.remarks || '—',
    grnNo:           payload.op_label,    // shows on the bottom of QR badge as fallback
    grnDateFmt:      fdt(payload.op_date),
    supplierText:    'Opening Stock',
    invoiceNo:       '—',
    invoiceDateFmt:  '—',
    location:        locName,
    supervisor:      (window._currentUser || ''),
    istStr:          new Date().toLocaleString('en-IN'),
    boxCodes:        payload.box_codes,   // pre-computed OP codes from server
    // Parallel array — NULL/empty entries fall back to long box_code in QR.
    shortCodes:      payload.short_codes || [],
    _codeCursor:     0,
    // OP batches are single-product so one FIFO code applies to all labels
    // in this batch — stamp at label-data level so makeLabelPage picks it up
    // via d.fifoCode.
    fifoCode:        payload.fifo_code || '',
    items:           items
  };

  // Stash on the (potentially absent) grnLabelModal element so grnLabelDoPrint
  // picks it up. If the element doesn't exist, create a tiny placeholder.
  let modal = document.getElementById('grnLabelModal');
  if(!modal) {
    modal = document.createElement('div');
    modal.id = 'grnLabelModal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  modal._labelData = labelData;
  grnLabelDoPrint();
}

/* ════════════════════════════════════════════════════════════════════════
   REISSUE REPLACEMENT LABEL  —  request → admin approve → print
   ────────────────────────────────────────────────────────────────────────
   A user whose printed QR is damaged/unscannable REQUESTS a replacement
   label (with a reason). An admin approves; on approval the server stamps a
   brand-new short code on the box. The requester then prints the new label
   from "My Reissue Requests" via printReissuedLabel(reqId).

   reissueBoxLabel(codeOrBox) submits the REQUEST (prompts for a reason).
═══════════════════════════════════════════════════════════════════════════ */
async function reissueBoxLabel(codeOrBox, opts){
  opts = opts || {};
  let code = '', boxId = null;
  if(codeOrBox && typeof codeOrBox === 'object'){
    code  = (codeOrBox.short_code || codeOrBox.box_code || '').toString().trim();
    boxId = codeOrBox.box_id || null;
  } else {
    code = (codeOrBox || '').toString().trim();
  }
  if(!code && !boxId){ showToast('No box to reissue','error'); return; }

  const ref = code || ('box #' + boxId);
  const reason = (opts.reason != null) ? opts.reason
    : prompt(`Request a REPLACEMENT label for ${ref}?\n\nThe old QR will stop working once an admin approves and you reprint.\n\nEnter a reason (required):`, '');
  if(reason == null) return;                 // cancelled
  const r = (reason || '').trim();
  if(!r){ showToast('A reason is required','error', 3500); return; }

  try {
    const res = await fetch('/api/pm_stock/label_reissue/request', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(boxId ? { box_id: boxId, reason: r } : { code, reason: r })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`📨 Reissue request #${d.req_id} sent to admin`, 'success', 4000);
      if(typeof refreshLabelReissueBadge === 'function') refreshLabelReissueBadge();
    } else {
      showToast(d.message || 'Request failed','error', 4500);
    }
  } catch(e){
    showToast('Network error: ' + (e.message||e), 'error', 4500);
  }
}
window.reissueBoxLabel = reissueBoxLabel;

/* Print an APPROVED reissue request's replacement label. Fetches the
   assembled label payload (encoding the new short code) and renders one
   label through the GRN/OP print pipeline. */
async function printReissuedLabel(reqId){
  let resp;
  try {
    const res = await fetch(`/api/pm_stock/label_reissue/${reqId}/print`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    });
    resp = await res.json();
  } catch(e){
    showToast('Network error: ' + (e.message||e), 'error', 4500); return;
  }
  if(!resp || resp.status !== 'ok'){
    showToast((resp && resp.message) || 'Print failed', 'error', 4500); return;
  }
  const L = resp.label || {};
  const item = {
    productId:    L.product_id,
    productCode:  L.product_code || '',
    productName:  L.product_name || '—',
    productVersion: L.product_version || '',
    pmType:       L.pm_type || '',
    brandName:    L.brand_name || '',
    noOfBox:      1,
    boxCount:     Number(L.per_box_qty) || 0,
    qty:          Number(L.per_box_qty) || 0,
    fifoCode:     L.fifo_code || '',
    boxCode:      L.box_code,
    _shortCode:   resp.new_code || L.new_short_code,   // NEW code → QR payload
    _boxNum:      Number(L.box_seq) || 1,
    _totalBoxes:  Number(L.total_boxes) || 1,
  };
  const labelData = {
    isOpening:      !!L.isOpening,
    grnNo:          L.grn_no || L.op_label || '',
    grnDateFmt:     L.grn_date_fmt || L.op_date_fmt || '',
    supervisor:     L.supervisor || (window._currentUser || ''),
    istStr:         new Date().toLocaleString('en-IN'),
    supplierText:   L.supplier_text || '',
    invoiceNo:      L.invoice_no || '—',
    invoiceDateFmt: L.invoice_date_fmt || '—',
    fifoCode:       L.fifo_code || '',
    // Box's current location — print it on every label, GRN or opening.
    locationName:   L.location_name || '',
    location:       L.location_name || '',
    items:          [item],
  };
  if(L.isOpening){
    labelData.opLabel      = L.op_label || L.grn_no || '';
    labelData.opDateFmt    = L.op_date_fmt || '';
    labelData.remarks      = '—';
  }
  let modal = document.getElementById('grnLabelModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'grnLabelModal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  modal._labelData = labelData;
  showToast(`🏷️ Printing replacement label (${resp.new_code || ''})`, 'success', 3500);
  grnLabelDoPrint();
  if(typeof refreshLabelReissueBadge === 'function') setTimeout(refreshLabelReissueBadge, 800);
}
window.printReissuedLabel = printReissuedLabel;

/* MTV edit / print / delete */
function printEditMtv(){
  const mtvNo  = document.getElementById('emtv-vno')?.textContent||'';
  const mtvDate= document.getElementById('emtv-date')?.value||'';
  const fromGd = document.getElementById('emtv-from')?.value||'';
  const toGd   = document.getElementById('emtv-to')?.value||'';
  const remarks= document.getElementById('emtv-remarks')?.value||'';
  const items=[];
  document.querySelectorAll('#emtv-items-container .mtv-item-row').forEach(row=>{
    const pid=parseInt(row.querySelector('.mi-product')?.value)||0;
    const qty=parseFloat(row.querySelector('.mi-qty')?.value)||0;
    if(pid&&qty>0) items.push({product_id:pid,qty});
  });
  if(!items.length){showToast('No items to print','error');return;}
  pmMtvPrint(mtvNo,mtvDate,parseInt(toGd),'godown',[{from_godown:parseInt(fromGd),from_type:'godown',items}],remarks);
}
async function deleteMtv(id, mtvNo) {
  if(!confirm(`Delete Transfer Voucher ${mtvNo}?\n\nThis will reverse the stock movements. Cannot be undone.`)) return;
  try{
    const res=await fetch('/api/pm_stock/mtv/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const data=await res.json();
    if(data.status==='ok'){
      showToast(`✓ MTV ${mtvNo} deleted`,'success');
      _mtvRows=_mtvRows.filter(r=>r.id!==id);
      renderMtvList(_mtvRows);
      await loadSummary();
    } else showToast(data.message||'Error','error');
  }catch(e){showToast('Error: '+e.message,'error');}
}


