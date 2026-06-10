/* ═══════════════════════════════════════════════════════════
   INVENTORY MODULE  (RM / PM / FG unified page)
   HCP Wellness · inventory_mgmt.js
═══════════════════════════════════════════════════════════ */

/* ═══ STATE ═══ */
let _dept         = 'RM';          // current department
let _panel        = 'items';       // items | brands | suppliers
let _items        = [];
let _brands       = [];         // dept-mapped brands (for Brands panel + filter)
let _allBrands    = [];         // ALL brands (for item-creation dropdown so unmapped brands still appear)
let _suppliers    = [];
let _lookups      = { pm_types:[], material_groups:[], material_types:[], uoms:[], gst_rates:[] };

let _selItems     = {};            // id → true
let _selBrands    = {};
let _selSups      = {};

let _editItemId   = null;
let _editBrandId  = null;
let _editSupId    = null;
let _editSupKey    = null;   // 'source:id' composite key when editing
let _editSupSource = null;   // 'procurement' | 'purchase'

const _pag = {
  items:     {page:1, size:parseInt(localStorage.getItem('inv_mgmt_pag_items'))    ||50},
  suppliers: {page:1, size:parseInt(localStorage.getItem('inv_mgmt_pag_suppliers'))||50},
  brands:    {page:1, size:parseInt(localStorage.getItem('inv_mgmt_pag_brands'))   ||50},
};

/* ═══ INIT ═══ */
document.addEventListener('DOMContentLoaded', async () => {
  _startClock();
  // Install global modal handlers (Escape closes; click-outside does NOT)
  _installModalHandlers();
  // First load: lookups, brands, suppliers, items
  await invLoadLookups();
  invSwitchDept('RM');  // triggers first load
});

/* ═══════════════════════════════════════════════════════════
   MODAL SYSTEM
   Requirement 5: Escape closes the modal.
   Requirement 6: Click outside the modal card does NOT close it.
═══════════════════════════════════════════════════════════ */
function invOpenModal(id){
  const m = document.getElementById(id);
  if(!m) return;
  m.classList.add('show');
  // focus first input
  setTimeout(()=>{ const i = m.querySelector('input,select,textarea'); if(i) i.focus(); }, 80);
}
function invCloseModal(id){
  const m = document.getElementById(id);
  if(!m) return;
  m.classList.remove('show');
}
function _installModalHandlers(){
  // Escape closes topmost open modal
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){
      const open = [...document.querySelectorAll('.modal-overlay.show')];
      if(open.length){
        e.preventDefault();
        invCloseModal(open[open.length - 1].id);
      }
    }
  });
  // Click-outside on overlay — INTENTIONALLY a no-op (requirement #6)
  // Only the explicit close (×) / Cancel / Escape dismisses.
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => {
      // do NOT close on click outside the card
      // (stop propagation so card internals behave normally)
      if(e.target === ov){ e.stopPropagation(); }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   DEPARTMENT SWITCH  (requirement #8)
═══════════════════════════════════════════════════════════ */
function invSwitchDept(dept){
  _dept = dept;
  // Button states
  document.querySelectorAll('.dept-btn').forEach(b => b.classList.toggle('active', b.dataset.dept === dept));
  // Update "New <DEPT> Item" button label
  if(typeof _invUpdateNewItemBtn === 'function') _invUpdateNewItemBtn();
  // Reload everything for this department
  _selItems = {}; _selBrands = {}; _selSups = {};
  _refreshBulkBars();
  invLoadBrands();      // for brand dropdown + brands panel
  invLoadSuppliers();   // for suppliers panel + supplier autocomplete
  invLoadItems();       // items table (department-filtered)
}

function invSwitchPanel(panel){
  _panel = panel;
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === panel));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-'+panel));
  if(panel === 'brands')    invRenderBrands();
  if(panel === 'suppliers') invRenderSuppliers();
  if(panel === 'items')     invRenderItems();
}

/* ═══════════════════════════════════════════════════════════
   LOOKUPS
═══════════════════════════════════════════════════════════ */
async function invLoadLookups(){
  try{
    const r = await fetch('/api/inventory_mgmt/lookups');
    const j = await r.json();
    if(j.status === 'ok'){
      _lookups = j;

      // Populate UOM select
      const uomSel = document.getElementById('im-uom');
      if(uomSel){
        uomSel.innerHTML = '<option value="">—</option>' +
          _lookups.uoms.map(u => `<option value="${u}">${u}</option>`).join('');
      }

      // Populate GST select
      const gstSel = document.getElementById('im-gst');
      if(gstSel){
        gstSel.innerHTML = '<option value="">—</option>' +
          _lookups.gst_rates.map(g => `<option value="${g}">${g}%</option>`).join('');
      }

      // Material types & groups (RM)
      const mtypeSel = document.getElementById('im-mtype');
      if(mtypeSel){
        mtypeSel.innerHTML = '<option value="">—</option>' +
          _lookups.material_types.map(t => `<option value="${t.id}">${t.type_name}</option>`).join('');
      }
      const grpSel = document.getElementById('im-group');
      if(grpSel){
        grpSel.innerHTML = '<option value="">—</option>' +
          _lookups.material_groups.map(g => `<option value="${g.id}">${g.group_name}</option>`).join('');
      }

      // PM types datalist
      const pmList = document.getElementById('im-pmtype-list');
      if(pmList){
        pmList.innerHTML = _lookups.pm_types.map(t => `<option value="${t}">`).join('');
      }
      // Group filter
      const grpFilter = document.getElementById('itemFilterGroup');
      if(grpFilter){
        grpFilter.innerHTML = '<option value="">All Groups</option>' +
          _lookups.material_groups.map(g => `<option value="${g.id}">${g.group_name}</option>`).join('');
      }
      // PM type filter
      const pmFilter = document.getElementById('itemFilterPmType');
      if(pmFilter){
        pmFilter.innerHTML = '<option value="">All PM Types</option>' +
          _lookups.pm_types.map(t => `<option value="${t}">${t}</option>`).join('');
      }
    }
  }catch(e){ console.error('loadLookups', e); }
}

/* ═══════════════════════════════════════════════════════════
   ITEMS — LOAD / RENDER
═══════════════════════════════════════════════════════════ */
async function invLoadItems(){
  const body = document.getElementById('itemsBody');
  body.innerHTML = `<tr><td colspan="15" class="no-data"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;

  try{
    const r = await fetch(`/api/inventory_mgmt/items?department=${encodeURIComponent(_dept)}`);
    const j = await r.json();
    if(j.status !== 'ok'){ throw new Error(j.message || 'Failed'); }
    _items = j.items || [];
  }catch(e){
    _items = [];
    body.innerHTML = `<tr><td colspan="15" class="no-data">⚠️ ${e.message}</td></tr>`;
    return;
  }

  // Update visible column set for dept
  _buildItemsHeader();
  invRenderItems();
  invRenderItemSummary();

  // ─── Hydrate PM stock from the canonical /api/pm_stock/summary endpoint ───
  // This guarantees our numbers match the PM Stock page exactly, because it
  // uses the exact same data source the PM Stock page uses.
  if(_dept === 'PM'){
    _invHydratePMStock();
  }
}

/**
 * Fetch the live PM stock summary (same data the PM Stock page shows) and
 * merge godown_stock + remaining (floor) into the items grid. This is the
 * cumulative / closing stock across all godowns + factory floor.
 *
 * Uses /api/pm_stock/summary/per_godown — the same endpoint that powers the
 * "Combined" tab on the PM Stock page. This is the canonical "total" source.
 * Each row returns:
 *   - total_godown_stock : sum of all godown stocks for that product
 *   - by_godown          : { godown_id: qty }
 * Floor stock comes from /api/pm_stock/summary's `remaining` field.
 */
async function _invHydratePMStock(){
  const today = new Date().toISOString().slice(0,10);
  try{
    // Fetch both endpoints in parallel (same as PM page does internally)
    const [perGodRes, summaryRes] = await Promise.all([
      fetch(`/api/pm_stock/summary/per_godown?to_date=${today}`),
      fetch(`/api/pm_stock/summary?godown_id=`),  // for floor (remaining)
    ]);

    const totals = {};  // product_id → total (godown + floor)

    // Godown totals from Combined endpoint
    if(perGodRes.ok){
      const data = await perGodRes.json();
      for(const r of (data.rows || [])){
        const id = parseInt(r.id);
        if(!id) continue;
        totals[id] = parseFloat(r.total_godown_stock || 0);
      }
    }

    // Floor stock from summary endpoint — add to each product's total
    if(summaryRes.ok){
      const summary = await summaryRes.json();
      if(Array.isArray(summary)){
        for(const s of summary){
          const id = parseInt(s.id);
          if(!id) continue;
          const floor = parseFloat(s.remaining || 0);
          totals[id] = (totals[id] || 0) + floor;
        }
      }
    }

    if(!Object.keys(totals).length) return;

    // Merge into _items
    let changed = 0;
    for(const it of _items){
      if(totals[it.id] != null){
        it.in_stock = totals[it.id];
        changed++;
      }
    }

    if(changed > 0){
      invRenderItems();
      invRenderItemSummary();
    }
  }catch(e){
    console.warn('PM stock hydration failed:', e);
  }
}

function _buildItemsHeader(){
  const head = document.getElementById('itemsHead');
  if(!head) return;
  const common = [
    `<th style="width:34px;padding-left:8px;padding-right:2px"><input type="checkbox" onchange="invToggleAllItems(this.checked)"></th>`,
    `<th style="width:56px;text-align:left;padding-left:2px;padding-right:8px" title="Click + to view godown-wise stock">#</th>`,
  ];
  let cols;
  if(_dept === 'RM'){
    // Inventory page intentionally omits HSN / GST% / Last Rate —
    // those belong on the procurement page, not the stock view.
    cols = ['Material Name','Group','Type','UOM','Last Supplier','MSL','In Stock','Updated'];
  } else if(_dept === 'PM'){
    cols = ['Product Name','PM Type','Brand','UOM','HSN','GST%','Last Supplier','Last Rate','Min Stock','In Stock'];
  } else {
    cols = ['FG Name','Code','SKU Size','Brand','UOM','HSN','GST%','Last Supplier','Last Rate','In Stock'];
  }
  head.innerHTML = common.join('') + cols.map(c => `<th>${c}</th>`).join('') + `<th style="width:90px" class="td-center">Actions</th>`;

  // Toggle RM/PM/FG-specific filter controls
  document.getElementById('itemFilterPmType').style.display = (_dept === 'PM') ? '' : 'none';
  document.getElementById('itemFilterGroup').style.display  = (_dept === 'RM') ? '' : 'none';
  document.getElementById('itemFilterBrand').style.display  = (_dept === 'RM') ? 'none' : '';
}

function _paginate(rows, key){
  const p = _pag[key] || {page:1,size:50};
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / p.size));
  p.page = Math.min(p.page, pages);
  const start = (p.page - 1) * p.size;
  const slice = rows.slice(start, start + p.size);
  return {slice,total,pages,page:p.page,start};
}

function invRenderItems(){
  const search    = (document.getElementById('itemSearch')?.value || '').toLowerCase().trim();
  const brandSel  = document.getElementById('itemFilterBrand')?.value || '';
  const brandId   = parseInt(brandSel) || 0;
  const brandNone = (brandSel === 'none');   // filter to items with NO brand
  const pmType    = document.getElementById('itemFilterPmType')?.value || '';
  const groupId   = parseInt(document.getElementById('itemFilterGroup')?.value) || 0;
  const stockFlt  = document.getElementById('itemFilterStock')?.value || '';

  let rows = _items.slice();
  if(search){
    rows = rows.filter(r => {
      const bag = [r.name, r.last_supplier, r.hsn_code, r.pm_type, r.fg_code, r.sku_size, r.brand_name, r.group_name, r.material_type].filter(Boolean).join(' ').toLowerCase();
      return bag.includes(search);
    });
  }
  if(brandNone && _dept !== 'RM') rows = rows.filter(r => !r.brand_id);
  else if(brandId && _dept !== 'RM') rows = rows.filter(r => r.brand_id === brandId);
  if(pmType  && _dept === 'PM') rows = rows.filter(r => r.pm_type === pmType);
  if(groupId && _dept === 'RM') rows = rows.filter(r => r.group_id === groupId);

  // Stock-level filter (applies to IN STOCK = in_stock field)
  if(stockFlt){
    rows = rows.filter(r => {
      const qty = parseFloat(r.in_stock || 0);
      const msl = parseFloat(r.msl || 0);
      switch(stockFlt){
        case 'nonzero':   return qty > 0;
        case 'zero':      return qty === 0 || qty === null || isNaN(qty);
        case 'negative':  return qty < 0;
        case 'below_msl': return msl > 0 && qty < msl;
        default: return true;
      }
    });
  }

  const {slice,total,pages,page,start} = _paginate(rows, 'items');
  const body = document.getElementById('itemsBody');

  if(!rows.length){
    body.innerHTML = `<tr><td colspan="15" class="no-data"><i class="fas fa-box-open"></i> No items found</td></tr>`;
    document.getElementById('itemsPag').innerHTML = '';
    return;
  }

  body.innerHTML = slice.map((r,i) => _renderItemRow(r, start+i+1)).join('');
  _renderPagination('itemsPag', page, pages, total, 'items');
  _refreshBulkBars();
}

function _renderItemRow(r, n){
  const sel = !!_selItems[r.id];
  const last_rate = r.last_rate == null ? '—' : ('₹ ' + Number(r.last_rate).toFixed(2));
  const gst = r.gst_rate == null ? '—' : (r.gst_rate + '%');
  const stock = _formatStock(r.in_stock, r.msl);
  const last_sup = r.last_supplier ? `<span title="${_esc(r.last_supplier)}">${_esc(r.last_supplier.slice(0,28))}${r.last_supplier.length>28?'…':''}</span>` : '<span class="muted-cell">—</span>';
  const brand = r.brand_name ? `<span class="chip chip-brand" style="background:${r.brand_color}22;color:${r.brand_color};border-color:${r.brand_color}44">${_esc(r.brand_name)}</span>` : '<span class="muted-cell">—</span>';

  let mid = '';
  if(_dept === 'RM'){
    const group = r.group_name ? `<span class="chip chip-group">${_esc(r.group_name)}</span>` : '<span class="muted-cell">—</span>';
    const mtype = r.material_type ? `<span class="chip chip-type">${_esc(r.material_type)}</span>` : '<span class="muted-cell">—</span>';
    // Inventory page — omits HSN / GST% / Last Rate (those live on
    // procurement). MSL and In Stock are kept since they're stock-relevant.
    mid = `
      <td class="td-name">${_esc(r.name)}</td>
      <td>${group}</td>
      <td>${mtype}</td>
      <td>${_esc(r.uom || 'KG')}</td>
      <td>${last_sup}</td>
      <td class="td-num">${r.msl != null ? Number(r.msl).toFixed(3) : '—'}</td>
      <td class="td-num">${stock}</td>
      <td class="muted-cell" style="font-size:11px">${_esc(r.updated_at || '')}</td>
    `;
  } else if(_dept === 'PM'){
    const pmt = r.pm_type ? `<span class="chip chip-type">${_esc(r.pm_type)}</span>` : '<span class="muted-cell">—</span>';
    mid = `
      <td class="td-name">${_esc(r.name)}</td>
      <td>${pmt}</td>
      <td>${brand}</td>
      <td>${_esc(r.uom || 'NOS')}</td>
      <td>${_esc(r.hsn_code || '—')}</td>
      <td class="td-num">${gst}</td>
      <td>${last_sup}</td>
      <td class="td-num">${last_rate}</td>
      <td class="td-num">${r.msl != null ? Number(r.msl).toFixed(0) : '—'}</td>
      <td class="td-num">${stock}</td>
    `;
  } else { // FG
    mid = `
      <td class="td-name">${_esc(r.name)}</td>
      <td>${_esc(r.fg_code || '—')}</td>
      <td>${_esc(r.sku_size || '—')}</td>
      <td>${brand}</td>
      <td>${_esc(r.uom || 'NOS')}</td>
      <td>${_esc(r.hsn_code || '—')}</td>
      <td class="td-num">${gst}</td>
      <td>${last_sup}</td>
      <td class="td-num">${last_rate}</td>
      <td class="td-num">${stock}</td>
    `;
  }

  return `<tr class="${sel?'selected-row':''}" data-item-id="${r.id}" ondblclick="invToggleStockExpand(${r.id})" title="Click + or double-click for godown-wise stock breakdown">
    <td style="padding-left:8px;padding-right:2px"><input type="checkbox" class="row-select" ${sel?'checked':''} onchange="invToggleItem(${r.id}, this.checked)"></td>
    <td style="padding-left:2px;padding-right:8px;white-space:nowrap">
      <button class="inv-expand-btn" id="invExpBtn-${r.id}" onclick="event.stopPropagation();invToggleStockExpand(${r.id})" title="Show godown-wise stock" aria-expanded="false">+</button>
      <span class="muted-cell" style="font-family:var(--font-mono,monospace);font-size:11px;margin-left:4px">${n}</span>
    </td>
    ${mid}
    <td class="td-center">
      <div class="row-actions">
        <button class="icon-btn-sm hist" onclick="invToggleStockExpand(${r.id})" title="Stock breakdown"><i class="fas fa-layer-group"></i></button>
        ${window.INV_CTX && (window.INV_CTX.canEditItems || window.INV_CTX.canEdit)
          ? `<button class="icon-btn-sm edit" onclick="invOpenSourceModal('edit', ${r.id})" title="Edit"><i class="fas fa-pen"></i></button>
             <button class="icon-btn-sm del" onclick="invDeleteOne(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>`
          : ''}
      </div>
    </td>
  </tr>`;
}

function _formatStock(qty, msl){
  const q = Number(qty || 0);
  if(q === 0) return '<span class="stock-zero">0</span>';
  const dec = _dept === 'RM' ? 3 : 0;
  const low = msl != null && q < Number(msl);
  const cls = low ? 'stock-low' : 'stock-ok';
  return `<span class="${cls}">${q.toLocaleString('en-IN', {maximumFractionDigits: dec})}</span>`;
}

function invRenderItemSummary(){
  const wrap = document.getElementById('itemSummary');
  if(!wrap) return;
  const total = _items.length;
  const withStock = _items.filter(i => Number(i.in_stock) > 0).length;
  const zeroStock = _items.filter(i => {
    const q = Number(i.in_stock || 0);
    return q === 0 || isNaN(q);
  }).length;
  const lowStock  = _items.filter(i => i.msl != null && Number(i.in_stock) < Number(i.msl)).length;
  const totalStockValue = _items.reduce((s,i) => {
    const rate = Number(i.last_rate || 0);
    const qty  = Number(i.in_stock || 0);
    return s + rate * qty;
  }, 0);

  const cards = [
    {label:'Total Items',       value:total,              sub:_dept + ' department',   filter:'',           cls:'inv-stat-card-total', icon:'fa-database'},
    {label:'With Stock',        value:withStock,          sub:'items > 0',              filter:'nonzero',    cls:'inv-stat-card-with',  icon:'fa-check-circle'},
    {label:'Zero Stock',        value:zeroStock,          sub:'items = 0',              filter:'zero',       cls:'inv-stat-card-zero',  icon:'fa-circle'},
    {label:'Below MSL',         value:lowStock,           sub:'low-stock alerts',       filter:'below_msl',  cls:'inv-stat-card-low',   icon:'fa-triangle-exclamation'},
    {label:'Est. Stock Value',  value:'<span class="inv-stat-cur">₹</span>' + totalStockValue.toLocaleString('en-IN',{maximumFractionDigits:0}), sub:'at last rate',  filter:'', cls:'inv-stat-card-value', icon:'fa-coins'},
  ];
  // Read the current filter so the matching card lights up "active"
  const _activeFilter = (document.getElementById('itemFilterStock')?.value || '');
  wrap.innerHTML = cards.map(c => {
    const clickable = c.filter !== undefined;
    const isActive  = clickable && (c.filter === _activeFilter) && c.filter !== '';
    const onClick = clickable
      ? `onclick="invApplyStockFilter('${c.filter}')" style="cursor:pointer" title="Click to filter"`
      : '';
    const cls = ['inv-stat-card', c.cls, isActive ? 'active' : '',
      (c.cls === 'inv-stat-card-low' && Number(c.value) > 0) ? 'has-alerts' : ''
    ].filter(Boolean).join(' ');
    return `<div class="${cls}" ${onClick}>
      <div class="inv-stat-card-label"><i class="fas ${c.icon}"></i> ${c.label}</div>
      <div class="inv-stat-card-value">${c.value}</div>
      <div class="inv-stat-card-sub">${c.sub}</div>
    </div>`;
  }).join('');
}

/** Click handler for summary cards — applies stock-level filter and re-renders. */
function invApplyStockFilter(val){
  const sel = document.getElementById('itemFilterStock');
  if(sel){
    sel.value = val || '';
    invRenderItems();
    // Scroll table into view
    const t = document.getElementById('itemsTable');
    if(t) t.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function _renderPagination(elId, page, pages, total, key){
  const el = document.getElementById(elId);
  if(!el) return;
  if(pages <= 1){
    el.innerHTML = `<span>${total} items</span>`;
    return;
  }
  let html = `<span>${total} items · Page ${page} of ${pages}</span>`;
  html += `<button onclick="invGoPage('${key}',1)" ${page<=1?'disabled':''}>«</button>`;
  html += `<button onclick="invGoPage('${key}',${page-1})" ${page<=1?'disabled':''}>‹</button>`;
  // numbered buttons (window around current)
  const start = Math.max(1, page-2), end = Math.min(pages, start+4);
  for(let p=start;p<=end;p++){
    html += `<button class="${p===page?'active':''}" onclick="invGoPage('${key}',${p})">${p}</button>`;
  }
  html += `<button onclick="invGoPage('${key}',${page+1})" ${page>=pages?'disabled':''}>›</button>`;
  html += `<button onclick="invGoPage('${key}',${pages})" ${page>=pages?'disabled':''}>»</button>`;
  el.innerHTML = html;
}
function invGoPage(key, p){
  _pag[key].page = p;
  if(key==='items')     invRenderItems();
  if(key==='suppliers') invRenderSuppliers();
  if(key==='brands')    invRenderBrands();
}
function invChangePageSize(key, size){
  _pag[key].size = parseInt(size) || 50;
  _pag[key].page = 1;
  localStorage.setItem('inv_mgmt_pag_'+key, _pag[key].size);
  if(key==='items')     invRenderItems();
  if(key==='suppliers') invRenderSuppliers();
  if(key==='brands')    invRenderBrands();
}

/* ═══════════════════════════════════════════════════════════
   MULTI-SELECT (Requirement #7)
═══════════════════════════════════════════════════════════ */
function invToggleItem(id, checked){
  if(checked) _selItems[id] = true; else delete _selItems[id];
  _refreshBulkBars();
  invRenderItems(); // to reflect 'selected-row' class
}
function invToggleAllItems(checked){
  if(checked){
    _items.forEach(r => { _selItems[r.id] = true; });
  } else {
    _selItems = {};
  }
  _refreshBulkBars();
  invRenderItems();
}
function invClearSelection(){ _selItems = {}; _refreshBulkBars(); invRenderItems(); }

function _refreshBulkBars(){
  const nItems  = Object.keys(_selItems).length;
  const nBrands = Object.keys(_selBrands).length;
  const nSups   = Object.keys(_selSups).length;

  const ib = document.getElementById('itemsBulkBar');
  const bb = document.getElementById('brandsBulkBar');
  const sb = document.getElementById('supBulkBar');
  if(ib){ ib.classList.toggle('show', nItems>0); document.getElementById('itemsBulkCount').textContent = nItems; }
  if(bb){ bb.classList.toggle('show', nBrands>0); document.getElementById('brandsBulkCount').textContent = nBrands; }
  if(sb){ sb.classList.toggle('show', nSups>0); document.getElementById('supBulkCount').textContent = nSups; }
}

/* ═══════════════════════════════════════════════════════════
   ITEM CREATE / EDIT / DELETE (Requirement #1, #4)
═══════════════════════════════════════════════════════════ */
function invOpenItemModal(itemId){
  _editItemId = itemId || null;
  document.getElementById('itemModalTitle').innerHTML = itemId
    ? `<i class="fas fa-pen"></i> Edit Item`
    : `<i class="fas fa-plus"></i> New Item`;

  // Fill suppliers datalist (current department only — requirement #9)
  const supList = document.getElementById('im-sup-list');
  if(supList){
    supList.innerHTML = _suppliers.map(s => `<option value="${_esc(s.supplier_name)}">`).join('');
  }

  // Brand dropdown (dept-filtered)
  const bs = document.getElementById('im-brand');
  if(bs){
    bs.innerHTML = '<option value="">— No Brand —</option>' +
      _brands.map(b => `<option value="${b.id}">${_esc(b.name)}</option>`).join('');
  }

  // Default department to current tab
  const deptSel = document.getElementById('im-dept');
  deptSel.value = _dept;
  _onItemDeptChange();

  deptSel.onchange = _onItemDeptChange;

  if(itemId){
    const it = _items.find(x => x.id === itemId);
    if(!it){ alert('Item not found'); return; }
    _fillItemForm(it);
  } else {
    _clearItemForm();
  }

  invOpenModal('itemModal');
}

function _onItemDeptChange(){
  const d = document.getElementById('im-dept').value;
  document.querySelectorAll('.rm-only').forEach(el => el.style.display = (d === 'RM') ? '' : 'none');
  document.querySelectorAll('.pm-only').forEach(el => el.style.display = (d === 'PM') ? '' : 'none');
  document.querySelectorAll('.fg-only').forEach(el => el.style.display = (d === 'FG') ? '' : 'none');
  // Brand visible for PM and FG
  document.querySelectorAll('.brand-only').forEach(el => el.style.display = (d === 'PM' || d === 'FG') ? '' : 'none');
  // UOM default
  const uom = document.getElementById('im-uom');
  if(uom && !uom.value){ uom.value = d === 'RM' ? 'KG' : 'NOS'; }
}

function _clearItemForm(){
  ['im-name','im-hsn','im-msl','im-lastsup','im-lastrate',
   'im-packsize','im-lead','im-fgcode','im-sku','im-fbatch','im-remarks','im-pmtype']
   .forEach(id => { const e = document.getElementById(id); if(e) e.value = ''; });
  document.getElementById('im-gst').value = '';
  document.getElementById('im-uom').value = _dept === 'RM' ? 'KG' : 'NOS';
  document.getElementById('im-brand').value = '';
  document.getElementById('im-mtype').value = '';
  document.getElementById('im-group').value = '';
}

function _fillItemForm(it){
  document.getElementById('im-dept').value = it.department;
  _onItemDeptChange();
  document.getElementById('im-name').value     = it.name || '';
  document.getElementById('im-hsn').value      = it.hsn_code || '';
  document.getElementById('im-gst').value      = it.gst_rate != null ? it.gst_rate : '';
  document.getElementById('im-uom').value      = it.uom || '';
  document.getElementById('im-msl').value      = it.msl != null ? it.msl : '';
  document.getElementById('im-lastsup').value  = it.last_supplier || '';
  document.getElementById('im-lastrate').value = it.last_rate != null ? it.last_rate : '';

  if(it.department === 'RM'){
    document.getElementById('im-mtype').value    = it.material_type_id || '';
    document.getElementById('im-group').value    = it.group_id || '';
    document.getElementById('im-packsize').value = it.std_pack_size || '';
    document.getElementById('im-lead').value     = it.lead_time_days || '';
  } else if(it.department === 'PM'){
    document.getElementById('im-pmtype').value = it.pm_type || '';
    document.getElementById('im-brand').value  = it.brand_id || '';
  } else {
    document.getElementById('im-fgcode').value  = it.fg_code || '';
    document.getElementById('im-sku').value     = it.sku_size || '';
    document.getElementById('im-fbatch').value  = it.formulation_batch || '';
    document.getElementById('im-remarks').value = it.remarks || '';
    document.getElementById('im-brand').value   = it.brand_id || '';
  }
}

async function invSaveItem(){
  const payload = {
    id:              _editItemId || null,
    department:      document.getElementById('im-dept').value,
    name:            document.getElementById('im-name').value.trim(),
    hsn_code:        document.getElementById('im-hsn').value.trim(),
    gst_rate:        document.getElementById('im-gst').value || null,
    uom:             document.getElementById('im-uom').value,
    msl:             document.getElementById('im-msl').value || null,
    last_supplier:   document.getElementById('im-lastsup').value.trim(),
    last_rate:       document.getElementById('im-lastrate').value || null,
    // RM extras
    material_type_id: document.getElementById('im-mtype').value || null,
    group_id:         document.getElementById('im-group').value || null,
    std_pack_size:    document.getElementById('im-packsize').value.trim(),
    lead_time_days:   document.getElementById('im-lead').value || null,
    // PM extras
    pm_type:          document.getElementById('im-pmtype').value.trim(),
    brand_id:         document.getElementById('im-brand').value || null,
    // FG extras
    fg_code:          document.getElementById('im-fgcode').value.trim(),
    sku_size:         document.getElementById('im-sku').value.trim(),
    formulation_batch: document.getElementById('im-fbatch').value.trim(),
    remarks:          document.getElementById('im-remarks').value.trim(),
  };
  if(!payload.name){ alert('Item name required'); return; }

  try{
    const r = await fetch('/api/inventory_mgmt/items/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Save failed');
    invCloseModal('itemModal');
    // If saved in a different dept than currently viewed, switch to that dept
    if(payload.department !== _dept){ invSwitchDept(payload.department); }
    else                              { invLoadItems(); }
  }catch(e){ alert('Error: ' + e.message); }
}

async function invDeleteOne(id){
  if(!confirm('Delete this item? This cannot be undone.')) return;
  await _deleteItems([id]);
}
async function invDeleteSelected(){
  const ids = Object.keys(_selItems).map(Number);
  if(!ids.length) return;
  if(!confirm(`Delete ${ids.length} selected item(s)?`)) return;
  await _deleteItems(ids);
}
async function _deleteItems(ids){
  try{
    const r = await fetch('/api/inventory_mgmt/items/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({department:_dept, ids})
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Delete failed');
    _selItems = {};
    invLoadItems();
  }catch(e){ alert('Error: ' + e.message); }
}

async function invRefreshLastPurchase(){
  try{
    const r = await fetch('/api/inventory_mgmt/last_purchase/refresh', {method:'POST'});
    const j = await r.json();
    alert(j.message || (j.status === 'ok' ? 'Refreshed' : 'Failed'));
    invLoadItems();
  }catch(e){ alert('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════
   INLINE STOCK BREAKDOWN (click + on row → expand sub-row)
═══════════════════════════════════════════════════════════ */

// Cache for fetched breakdowns so re-expanding the same row is instant.
// Keyed by `${_dept}:${itemId}` so switching depts gets fresh data.
const _invStockExpandCache = {};

/**
 * Toggle godown-wise stock breakdown as an inline sub-row directly
 * beneath the item row. Click again to collapse.
 *
 * Re-uses the same data sources as the existing modal:
 *   - PM  → /api/pm_stock/summary/per_godown + /api/pm_stock/summary
 *   - RM/FG → /api/inventory_mgmt/stock_breakdown
 */
async function invToggleStockExpand(itemId){
  const row = document.querySelector(`tr[data-item-id="${itemId}"]`);
  if(!row) return;
  const btn = document.getElementById(`invExpBtn-${itemId}`);

  // Already expanded? Collapse it.
  const existing = document.querySelector(`tr.inv-stock-subrow[data-parent="${itemId}"]`);
  if(existing){
    existing.remove();
    if(btn){
      btn.textContent = '+';
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'Show godown-wise stock';
    }
    return;
  }

  // Collapse all other open sub-rows first — keeps the table tidy.
  document.querySelectorAll('tr.inv-stock-subrow').forEach(tr => tr.remove());
  document.querySelectorAll('.inv-expand-btn.open').forEach(b => {
    b.textContent = '+';
    b.classList.remove('open');
    b.setAttribute('aria-expanded', 'false');
    b.title = 'Show godown-wise stock';
  });

  // Build & insert a sub-row with loading state.
  const colCount = row.children.length;
  const sub = document.createElement('tr');
  sub.className = 'inv-stock-subrow';
  sub.dataset.parent = String(itemId);
  sub.innerHTML = `
    <td colspan="${colCount}" class="inv-stock-subrow-cell">
      <div class="inv-stock-subrow-inner">
        <div class="inv-stock-subrow-loading">
          <i class="fas fa-spinner fa-spin"></i> Loading godown-wise stock…
        </div>
      </div>
    </td>`;
  row.insertAdjacentElement('afterend', sub);
  if(btn){
    btn.textContent = '−';
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    btn.title = 'Hide godown-wise stock';
  }

  // Fetch (or use cached) breakdown.
  const cacheKey = `${_dept}:${itemId}`;
  let payload = _invStockExpandCache[cacheKey];
  if(!payload){
    try{
      payload = await _invFetchStockBreakdown(itemId);
      _invStockExpandCache[cacheKey] = payload;
    }catch(e){
      sub.querySelector('.inv-stock-subrow-inner').innerHTML =
        `<div class="inv-stock-subrow-error">⚠️ ${_esc(e.message || 'Failed to load')}</div>`;
      return;
    }
  }

  // Render the breakdown.
  const innerEl = sub.querySelector('.inv-stock-subrow-inner');
  if(innerEl) innerEl.innerHTML = _renderInlineBreakdown(payload);
}

/** Fetch godown-wise stock for one item (department-aware). */
async function _invFetchStockBreakdown(itemId){
  const it = _items.find(x => x.id === itemId);
  if(!it) throw new Error('Item not found');
  let rows = [];
  let total = 0;
  let uom = it.uom || (_dept === 'RM' ? 'KG' : 'NOS');

  if(_dept === 'PM'){
    const toDate = new Date().toISOString().slice(0,10);
    const [perGodRes, summaryRes] = await Promise.all([
      fetch(`/api/pm_stock/summary/per_godown?to_date=${toDate}`),
      fetch(`/api/pm_stock/summary?godown_id=`),
    ]);
    const perGod = perGodRes.ok ? await perGodRes.json() : {godowns:[], rows:[]};
    const summary = summaryRes.ok ? await summaryRes.json() : [];
    const godowns = perGod.godowns || [];
    const prodRow = (perGod.rows || []).find(x => parseInt(x.id) === itemId);
    const summaryRow = Array.isArray(summary) ? summary.find(x => parseInt(x.id) === itemId) : null;
    if(prodRow){
      const byGd = prodRow.by_godown || {};
      for(const g of godowns){
        const q = parseFloat(byGd[String(g.id)] || byGd[g.id] || 0);
        if(q !== 0){
          rows.push({
            godown_name: g.name || '(unnamed)',
            godown_type: g.type || 'godown',
            city: g.city || '', state: g.state || '',
            qty: q,
          });
        }
      }
    }
    const floorQty = summaryRow ? parseFloat(summaryRow.remaining || 0) : 0;
    if(floorQty !== 0){
      rows.push({
        godown_name: 'Factory Floor', godown_type: 'floor',
        city:'', state:'', qty: floorQty,
      });
    }
    total = rows.reduce((s,r) => s + r.qty, 0);
  } else {
    // RM / FG
    const r = await fetch(`/api/inventory_mgmt/stock_breakdown?department=${encodeURIComponent(_dept)}&item_id=${itemId}`);
    const j = await r.json();
    if(j.status !== 'ok'){ throw new Error(j.message || 'Failed'); }
    rows  = j.rows || [];
    total = j.total || 0;
    uom   = j.uom || uom;
  }
  return { rows, total, uom, itemName: it.name };
}

/** Render the inline breakdown as a compact godown grid. */
function _renderInlineBreakdown({rows, total, uom, itemName}){
  const dec = _dept === 'RM' ? 3 : 0;
  const fmt = n => Number(n || 0).toLocaleString('en-IN', {maximumFractionDigits: dec});

  if(!rows || !rows.length){
    return `
      <div class="inv-stock-empty">
        <i class="fas fa-warehouse"></i>
        No stock in any godown
        <span class="inv-stock-empty-sub">This item shows 0 in all locations</span>
      </div>`;
  }

  // Sort: floor last, then by qty descending
  const sorted = rows.slice().sort((a, b) => {
    if(a.godown_type === 'floor' && b.godown_type !== 'floor') return 1;
    if(b.godown_type === 'floor' && a.godown_type !== 'floor') return -1;
    return Math.abs(b.qty) - Math.abs(a.qty);
  });

  const typeColor = {
    factory:  ['#dc262611', 'var(--nb-danger)'],
    godown:   ['#0ea5e911', 'var(--nb-cyan)'],
    transit:  ['#f59e0b11', 'var(--nb-amber)'],
    rejected: ['#6b728011', 'var(--nb-text-muted)'],
    floor:    ['#10b98111', 'var(--nb-success)'],
  };

  const cards = sorted.map(r => {
    const [bg, fg] = typeColor[r.godown_type] || typeColor.godown;
    const loc = [r.city, r.state].filter(Boolean).join(', ');
    return `
      <div class="inv-stock-card" style="border-color:${fg}44;background:${bg}">
        <div class="inv-stock-card-head">
          <span class="inv-stock-card-name">${_esc(r.godown_name)}</span>
          <span class="inv-stock-card-type" style="color:${fg}">${_esc(r.godown_type || 'godown')}</span>
        </div>
        ${loc ? `<div class="inv-stock-card-loc">${_esc(loc)}</div>` : ''}
        <div class="inv-stock-card-qty">${fmt(r.qty)} <span class="inv-stock-card-uom">${_esc(uom)}</span></div>
      </div>`;
  }).join('');

  return `
    <div class="inv-stock-grid">${cards}</div>
    <div class="inv-stock-total">
      <span class="inv-stock-total-lbl">TOTAL ACROSS ALL LOCATIONS</span>
      <span class="inv-stock-total-val">${fmt(total)} <span class="inv-stock-total-uom">${_esc(uom)}</span></span>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════
   STOCK BREAKDOWN MODAL (double-click → godown-wise qty)
═══════════════════════════════════════════════════════════ */
async function invOpenStockBreakdown(itemId){
  const it = _items.find(x => x.id === itemId);
  if(!it){ alert('Item not found'); return; }

  // Open modal first with loading state
  const modal = document.getElementById('stockBreakdownModal');
  document.getElementById('sbm-item-name').textContent = it.name;
  document.getElementById('sbm-dept-badge').innerHTML =
    `<span class="chip chip-dept-${_dept.toLowerCase()}">${_dept}</span>`;
  document.getElementById('sbm-body').innerHTML =
    `<div class="no-data"><i class="fas fa-spinner fa-spin"></i> Loading breakdown…</div>`;
  invOpenModal('stockBreakdownModal');

  try{
    let rows = [];
    let total = 0;
    let uom = it.uom || (_dept === 'RM' ? 'KG' : 'NOS');

    if(_dept === 'PM'){
      // Use the canonical per-godown endpoint + summary endpoint — same data the PM Stock page uses
      const toDate = new Date().toISOString().slice(0,10);
      const [perGodRes, summaryRes] = await Promise.all([
        fetch(`/api/pm_stock/summary/per_godown?to_date=${toDate}`),
        fetch(`/api/pm_stock/summary?godown_id=`),
      ]);
      const perGod = perGodRes.ok ? await perGodRes.json() : {godowns:[], rows:[]};
      const summary = summaryRes.ok ? await summaryRes.json() : [];

      const godowns = perGod.godowns || [];
      const prodRow = (perGod.rows || []).find(x => parseInt(x.id) === itemId);
      const summaryRow = Array.isArray(summary) ? summary.find(x => parseInt(x.id) === itemId) : null;

      if(prodRow){
        const byGd = prodRow.by_godown || {};
        for(const g of godowns){
          const q = parseFloat(byGd[String(g.id)] || byGd[g.id] || 0);
          if(q !== 0){
            rows.push({
              godown_name: g.name || '(unnamed)',
              godown_type: g.type || 'godown',
              city:        g.city || '',
              state:       g.state || '',
              qty:         q,
            });
          }
        }
      }
      // Floor / factory stock from summary endpoint's "remaining"
      const floorQty = summaryRow ? parseFloat(summaryRow.remaining || 0) : 0;
      if(floorQty !== 0){
        rows.push({
          godown_name: 'Factory Floor',
          godown_type: 'floor',
          city: '', state: '',
          qty:  floorQty,
        });
      }
      total = rows.reduce((s,r) => s + r.qty, 0);

    } else {
      // RM and FG use the Python backend breakdown endpoint
      const r = await fetch(`/api/inventory_mgmt/stock_breakdown?department=${encodeURIComponent(_dept)}&item_id=${itemId}`);
      const j = await r.json();
      if(j.status !== 'ok'){ throw new Error(j.message || 'Failed'); }
      rows  = j.rows || [];
      total = j.total || 0;
      uom   = j.uom || uom;
    }

    const dec = _dept === 'RM' ? 3 : 0;
    const fmt = n => Number(n || 0).toLocaleString('en-IN', {maximumFractionDigits: dec});

    if(!rows.length){
      document.getElementById('sbm-body').innerHTML = `
        <div class="no-data">
          <i class="fas fa-warehouse"></i>
          No stock in any godown
          <div style="font-size:12px;margin-top:4px;color:var(--nb-text-muted)">
            This item shows 0 in all locations
          </div>
        </div>`;
      return;
    }

    const typeBadge = t => {
      if(!t) return '';
      const cls = {
        godown:  'background:#0ea5e922;color:var(--nb-cyan);border-color:#0ea5e944',
        floor:   'background:#f59e0b22;color:var(--nb-amber);border-color:#f59e0b44',
        billing: 'background:#6b728022;color:var(--nb-text-muted);border-color:#6b728044',
        shipping:'background:#8b5cf622;color:var(--nb-purple);border-color:#8b5cf644',
        system:  'background:#16a34a22;color:var(--nb-success);border-color:#16a34a44',
      }[t] || 'background:#6b728022;color:var(--nb-text-muted);border-color:#6b728044';
      return `<span class="chip" style="${cls}">${t}</span>`;
    };

    const rowsHtml = rows.map((r,i) => `
      <tr>
        <td class="muted-cell">${i+1}</td>
        <td class="td-name">${_esc(r.godown_name)}</td>
        <td>${typeBadge(r.godown_type)}</td>
        <td>${_esc(r.city || '')}${r.city && r.state ? ', ' : ''}${_esc(r.state || '')}</td>
        <td class="td-num"${r.qty < 0 ? ' style="color:var(--nb-danger)"' : ''}>
          <strong>${fmt(r.qty)}</strong> <span class="muted-cell" style="font-size:11px">${uom}</span>
        </td>
      </tr>`).join('');

    document.getElementById('sbm-body').innerHTML = `
      <table class="inv-table" style="margin:0">
        <thead><tr>
          <th style="width:40px">#</th>
          <th>Godown / Location</th>
          <th style="width:120px">Type</th>
          <th>City / State</th>
          <th class="td-num" style="width:160px">Qty</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr style="background:var(--nb-surface);font-weight:700">
            <td colspan="4" style="text-align:right;padding:12px">Total in stock</td>
            <td class="td-num" style="padding:12px">
              <strong style="font-size:16px;color:var(--nb-primary)">${fmt(total)}</strong>
              <span class="muted-cell" style="font-size:11px">${uom}</span>
            </td>
          </tr>
        </tfoot>
      </table>`;
  }catch(e){
    document.getElementById('sbm-body').innerHTML =
      `<div class="no-data">⚠️ ${_esc(e.message)}</div>`;
  }
}

/* ═══════════════════════════════════════════════════════════
   BRANDS (Requirement #3)
═══════════════════════════════════════════════════════════ */
async function invLoadBrands(){
  try{
    const r = await fetch(`/api/inventory_mgmt/brands?department=${encodeURIComponent(_dept)}`);
    const j = await r.json();
    _brands = (j.status === 'ok') ? (j.brands || []) : [];
  }catch(e){ _brands = []; }

  // Populate brand filter (items panel) with dept-filtered brands
  const filt = document.getElementById('itemFilterBrand');
  if(filt){
    const cur = filt.value;
    // "All Brands" (no filter) → every item; "No Brand" → items with no brand
    // assigned (brand_id null/empty); then each actual brand.
    filt.innerHTML = '<option value="">All Brands</option>' +
      '<option value="none">— No Brand —</option>' +
      _brands.map(b => `<option value="${b.id}">${_esc(b.name)}</option>`).join('');
    filt.value = cur;
  }
  invRenderBrands();
}

function invRenderBrands(){
  const body = document.getElementById('brandsBody');
  if(!body) return;
  const search = (document.getElementById('brandSearch')?.value || '').toLowerCase().trim();
  let rows = _brands.slice();
  if(search) rows = rows.filter(b => (b.name||'').toLowerCase().includes(search));

  if(!rows.length){
    body.innerHTML = `<tr><td colspan="6" class="no-data"><i class="fas fa-tags"></i> No brands${search?' match':''}</td></tr>`;
    const pagEl = document.getElementById('brandsPag');
    if(pagEl) pagEl.innerHTML = '';
    return;
  }

  const {slice,total,pages,page,start} = _paginate(rows, 'brands');

  body.innerHTML = slice.map((b,i) => {
    const sel = !!_selBrands[b.id];
    // All brands now apply to all departments — show a unified badge
    const deptSet = new Set(b.departments || []);
    const allDepts = deptSet.has('RM') && deptSet.has('PM') && deptSet.has('FG');
    const deptDisplay = allDepts
      ? '<span class="chip" style="background:#6366f122;color:var(--nb-indigo);border-color:#6366f144">All Depts (RM · PM · FG)</span>'
      : ((b.departments || []).map(d => `<span class="chip chip-dept-${d.toLowerCase()}">${d}</span>`).join(' ')
          || '<span class="muted-cell">—</span>');
    return `<tr class="${sel?'selected-row':''}" ondblclick="invOpenBrandModal(${b.id})">
      <td><input type="checkbox" ${sel?'checked':''} onchange="invToggleBrand(${b.id}, this.checked)"></td>
      <td class="muted-cell">${start+i+1}</td>
      <td><span class="chip" style="background:${b.color}22;color:${b.color};border-color:${b.color}44">${_esc(b.name)}</span></td>
      <td>${deptDisplay}</td>
      <td><div style="display:inline-block;width:22px;height:22px;border-radius:4px;background:${b.color};border:1px solid #0002"></div></td>
      <td class="td-center">
        ${window.INV_CTX.canEdit
          ? `<button class="icon-btn-sm edit" onclick="invOpenBrandModal(${b.id})" title="Edit"><i class="fas fa-pen"></i></button>
             <button class="icon-btn-sm del" onclick="invDeleteBrand(${b.id})" title="Delete"><i class="fas fa-trash"></i></button>`
          : '—'}
      </td>
    </tr>`;
  }).join('');

  _renderPagination('brandsPag', page, pages, total, 'brands');
  _refreshBulkBars();
}

function invToggleBrand(id, ok){ if(ok) _selBrands[id]=true; else delete _selBrands[id]; _refreshBulkBars(); invRenderBrands(); }
function invToggleAllBrands(ok){
  if(ok){ _brands.forEach(b => _selBrands[b.id]=true); } else { _selBrands = {}; }
  _refreshBulkBars(); invRenderBrands();
}
function invClearBrandSelection(){ _selBrands = {}; _refreshBulkBars(); invRenderBrands(); }

function invOpenBrandModal(id){
  _editBrandId = id || null;
  document.getElementById('brandModalTitle').textContent = id ? 'Edit Brand' : 'New Brand';
  document.getElementById('bm-name').value = '';
  document.getElementById('bm-color').value = 'var(--nb-indigo)';
  document.getElementById('bm-textcolor').value = '#ffffff';
  if(id){
    const b = _brands.find(x => x.id === id);
    if(b){
      document.getElementById('bm-name').value = b.name;
      document.getElementById('bm-color').value = b.color;
      document.getElementById('bm-textcolor').value = b.text_color;
    }
  }
  invOpenModal('brandModal');
}

async function invSaveBrand(){
  // Brands apply to all departments by default (per user spec).
  const payload = {
    id: _editBrandId,
    name: document.getElementById('bm-name').value.trim(),
    color: document.getElementById('bm-color').value,
    text_color: document.getElementById('bm-textcolor').value,
    departments: ['RM', 'PM', 'FG']
  };
  if(!payload.name){ alert('Brand name required'); return; }
  try{
    const r = await fetch('/api/inventory_mgmt/brands/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Save failed');
    invCloseModal('brandModal');
    invLoadBrands();
  }catch(e){ alert('Error: '+e.message); }
}

async function invDeleteBrand(id){
  if(!confirm('Delete this brand?')) return;
  await _deleteBrands([id]);
}
async function invDeleteSelectedBrands(){
  const ids = Object.keys(_selBrands).map(Number);
  if(!ids.length) return;
  if(!confirm(`Delete ${ids.length} brand(s)?`)) return;
  await _deleteBrands(ids);
}
async function _deleteBrands(ids){
  try{
    const r = await fetch('/api/inventory_mgmt/brands/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ids})
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Delete failed');
    _selBrands = {};
    invLoadBrands();
  }catch(e){ alert('Error: '+e.message); }
}

/* ═══════════════════════════════════════════════════════════
   SUPPLIERS (Requirement #9)
═══════════════════════════════════════════════════════════ */
async function invLoadSuppliers(){
  try{
    // If the toolbar toggle "Show all" is checked, ask the API for all
    // suppliers regardless of department mapping. Otherwise strict
    // department filtering applies (suppliers must have a row in
    // inventory_supplier_dept for the current department).
    const showAll = !!document.getElementById('supShowAll')?.checked;
    const url = `/api/inventory_mgmt/suppliers?department=${encodeURIComponent(_dept)}`
              + (showAll ? '&show_all=1' : '');
    const r = await fetch(url);
    const j = await r.json();
    _suppliers = (j.status === 'ok') ? (j.suppliers || []) : [];
  }catch(e){ _suppliers = []; }
  invRenderSuppliers();
}

function invRenderSuppliers(){
  const body = document.getElementById('supBody');
  if(!body) return;
  const search = (document.getElementById('supSearch')?.value || '').toLowerCase().trim();
  const stFilter = document.getElementById('supFilterStatus')?.value || '';
  let rows = _suppliers.slice();
  if(search){
    rows = rows.filter(s => {
      const bag = [s.supplier_name, s.supplier_code, s.contact_person, s.phone, s.email, s.gst_number].filter(Boolean).join(' ').toLowerCase();
      return bag.includes(search);
    });
  }
  if(stFilter) rows = rows.filter(s => s.status === stFilter);

  if(!rows.length){
    body.innerHTML = `<tr><td colspan="10" class="no-data"><i class="fas fa-truck"></i> No suppliers${search?' match':''}</td></tr>`;
    const pagEl = document.getElementById('supPag');
    if(pagEl) pagEl.innerHTML = '';
    return;
  }

  const {slice,total,pages,page,start} = _paginate(rows, 'suppliers');

  body.innerHTML = slice.map((s,i) => {
    const selKey = s.source + ':' + s.id;
    const sel = !!_selSups[selKey];
    const depts = (s.departments || []).map(d => `<span class="chip chip-dept-${d.toLowerCase()}">${d}</span>`).join(' ');
    const stat = s.status === 'active'
      ? '<span class="chip" style="background:#16a34a22;color:var(--nb-success);border-color:#16a34a44">active</span>'
      : '<span class="chip" style="background:#ef444422;color:var(--nb-danger);border-color:#ef444444">inactive</span>';
    const srcBadge = s.source === 'purchase'
      ? '<span class="chip" style="background:#7c3aed22;color:var(--nb-purple);border-color:#7c3aed44" title="From purchase_suppliers (PM)">PM</span>'
      : '<span class="chip" style="background:#2563eb22;color:var(--nb-primary);border-color:#2563eb44" title="From procurement_suppliers (RM/FG)">RM/FG</span>';

    // Supplier-type chip — colour-coded for quick scanning
    let typeChip = '<span class="muted-cell">—</span>';
    const tn = (s.type_name || '').toUpperCase();
    if(tn.includes('RM'))         typeChip = '<span class="chip" style="background:#16a34a22;color:var(--nb-success);border-color:#16a34a44">RM</span>';
    else if(tn.includes('PM'))    typeChip = '<span class="chip" style="background:#7c3aed22;color:var(--nb-purple);border-color:#7c3aed44">PM</span>';
    else if(tn.includes('OTHER')) typeChip = '<span class="chip" style="background:#9ca3af22;color:var(--nb-text-muted);border-color:#9ca3af44">OTHER</span>';
    else if(s.type_name)          typeChip = `<span class="chip" style="background:#6b728022;color:var(--nb-text-muted);border-color:#6b728044">${_esc(s.type_name)}</span>`;

    return `<tr class="${sel?'selected-row':''}" ondblclick="invOpenSupplierModal('${selKey}')">
      <td><input type="checkbox" ${sel?'checked':''} onchange="invToggleSup('${selKey}', this.checked)"></td>
      <td class="muted-cell">${start+i+1}</td>
      <td class="td-name">${_esc(s.supplier_name)} ${srcBadge}</td>
      <td>${typeChip}</td>
      <td>${_esc(s.supplier_code || '—')}</td>
      <td>${_esc(s.phone || '—')}</td>
      <td>${_esc(s.email || '—')}</td>
      <td>${_esc(s.gst_number || '—')}</td>
      <td>${stat}</td>
      <td class="td-center">
        ${window.INV_CTX.canEdit
          ? `<button class="icon-btn-sm edit" onclick="invOpenSupplierModal('${selKey}')" title="Edit"><i class="fas fa-pen"></i></button>
             <button class="icon-btn-sm del" onclick="invDeleteSupplier('${selKey}')" title="Delete"><i class="fas fa-trash"></i></button>`
          : '—'}
      </td>
    </tr>`;
  }).join('');

  _renderPagination('supPag', page, pages, total, 'suppliers');
  _refreshBulkBars();
}

function invToggleSup(key, ok){ if(ok) _selSups[key]=true; else delete _selSups[key]; _refreshBulkBars(); invRenderSuppliers(); }
function invToggleAllSuppliers(ok){
  if(ok){ _suppliers.forEach(s => _selSups[s.source+':'+s.id]=true); } else { _selSups = {}; }
  _refreshBulkBars(); invRenderSuppliers();
}
function invClearSupSelection(){ _selSups = {}; _refreshBulkBars(); invRenderSuppliers(); }

/* Note: the earlier "Tag all as RM" bulk-tagging helpers were removed —
   the suppliers panel now filters by supplier_type_id (joined on the
   server side), so no client-side or manual tagging is needed.
   The supplier_type for each record is set on the supplier_type column
   of procurement_suppliers (FK to supplier_type table). */

function _supKey(s){ return s.source + ':' + s.id; }
function _parseSupKey(key){
  const [source, id] = String(key).split(':');
  return { source, id: parseInt(id) };
}
function _findSupByKey(key){
  const p = _parseSupKey(key);
  return _suppliers.find(s => s.source === p.source && s.id === p.id);
}

function invOpenSupplierModal(key){
  // key can be null/undefined (new supplier) or 'source:id' (edit)
  _editSupKey = key || null;
  _editSupSource = null;
  _editSupId = null;

  const s = key ? _findSupByKey(key) : null;
  document.getElementById('supModalTitle').textContent = s ? 'Edit Supplier' : 'New Supplier';

  ['sm-name','sm-code','sm-contact','sm-phone','sm-email','sm-gst','sm-pan','sm-lead',
   'sm-address','sm-paytype','sm-credit','sm-rating'].forEach(id => {
    const e = document.getElementById(id); if(e) e.value = '';
  });
  document.getElementById('sm-status').value = 'active';
  document.querySelectorAll('.sm-dept').forEach(c => c.checked = false);

  if(s){
    _editSupSource = s.source;
    _editSupId     = s.id;
    document.getElementById('sm-name').value    = s.supplier_name || '';
    document.getElementById('sm-code').value    = s.supplier_code || '';
    document.getElementById('sm-contact').value = s.contact_person || '';
    document.getElementById('sm-phone').value   = s.phone || '';
    document.getElementById('sm-email').value   = s.email || '';
    document.getElementById('sm-gst').value     = s.gst_number || '';
    document.getElementById('sm-pan').value     = s.pan_number || '';
    document.getElementById('sm-lead').value    = s.lead_time_days != null ? s.lead_time_days : '';
    document.getElementById('sm-address').value = s.address || '';
    document.getElementById('sm-paytype').value = s.payment_type || '';
    document.getElementById('sm-credit').value  = s.credit_days != null ? s.credit_days : '';
    document.getElementById('sm-rating').value  = s.rating != null ? s.rating : '';
    document.getElementById('sm-status').value  = s.status || 'active';
    document.querySelectorAll('.sm-dept').forEach(c => {
      c.checked = (s.departments || []).includes(c.value);
    });
  } else {
    const cur = document.querySelector('.sm-dept[value="'+_dept+'"]');
    if(cur) cur.checked = true;
  }

  _syncSupplierFormMode();
  // Wire department-checkbox listeners so the form adjusts on change
  document.querySelectorAll('.sm-dept').forEach(c => {
    c.onchange = _syncSupplierFormMode;
  });

  invOpenModal('supModal');
}

/**
 * When PM is the only/any department chosen, we must use purchase_suppliers,
 * which doesn't support supplier_code / PAN / payment_type / credit_days / lead_time_days.
 * Hide those fields and show a source banner.
 */
function _syncSupplierFormMode(){
  const chosen = [...document.querySelectorAll('.sm-dept:checked')].map(c => c.value);
  const hasPM  = chosen.includes('PM');
  const hasRMorFG = chosen.includes('RM') || chosen.includes('FG');

  const banner = document.getElementById('sm-source-banner');
  let mode = 'procurement'; // default
  let conflict = false;

  if(hasPM && hasRMorFG){
    conflict = true;
  } else if(hasPM){
    mode = 'purchase';
  } else {
    mode = 'procurement';
  }

  // Toggle fields only available in procurement_suppliers
  const procOnlyIds = ['sm-code','sm-pan','sm-lead','sm-paytype','sm-credit'];
  procOnlyIds.forEach(id => {
    const row = document.getElementById(id)?.closest('.field');
    if(row) row.style.display = (mode === 'procurement' && !conflict) ? '' : 'none';
  });

  if(banner){
    if(conflict){
      banner.innerHTML = `⚠️ <strong>Cannot mix PM with RM/FG on one supplier</strong>
        <div style="margin-top:3px;font-size:11px">PM suppliers live in <code>purchase_suppliers</code>;
        RM/FG suppliers live in <code>procurement_suppliers</code>. Create two separate records.</div>`;
      banner.style.background = 'var(--nb-danger-light)';
      banner.style.color = 'var(--nb-danger)';
      banner.style.display = '';
    } else if(mode === 'purchase'){
      banner.innerHTML = `ℹ️ Saving to <code>purchase_suppliers</code> (PM) — limited fields only.`;
      banner.style.background = 'var(--nb-purple-light)';
      banner.style.color = 'var(--nb-purple)';
      banner.style.display = '';
    } else {
      banner.innerHTML = `ℹ️ Saving to <code>procurement_suppliers</code> (RM / FG) — full fields available.`;
      banner.style.background = 'var(--nb-primary-light)';
      banner.style.color = 'var(--nb-primary)';
      banner.style.display = '';
    }
  }
  // Disable save button on conflict
  const saveBtn = document.getElementById('sm-save-btn');
  if(saveBtn) saveBtn.disabled = conflict;
}

async function invSaveSupplier(){
  const depts = [...document.querySelectorAll('.sm-dept:checked')].map(c => c.value);
  if(!depts.length){ alert('Select at least one department'); return; }

  const hasPM = depts.includes('PM');
  const hasRMorFG = depts.includes('RM') || depts.includes('FG');
  if(hasPM && hasRMorFG){
    alert('Cannot mix PM with RM/FG on one supplier record. PM uses purchase_suppliers; RM/FG uses procurement_suppliers. Please create two separate records.');
    return;
  }
  const source = hasPM ? 'purchase' : 'procurement';

  const payload = {
    id:             _editSupId,
    source:         source,
    supplier_name:  document.getElementById('sm-name').value.trim(),
    supplier_code:  document.getElementById('sm-code').value.trim(),
    contact_person: document.getElementById('sm-contact').value.trim(),
    phone:          document.getElementById('sm-phone').value.trim(),
    email:          document.getElementById('sm-email').value.trim(),
    gst_number:     document.getElementById('sm-gst').value.trim(),
    pan_number:     document.getElementById('sm-pan').value.trim(),
    lead_time_days: document.getElementById('sm-lead').value || null,
    address:        document.getElementById('sm-address').value.trim(),
    payment_type:   document.getElementById('sm-paytype').value.trim(),
    credit_days:    document.getElementById('sm-credit').value || null,
    rating:         document.getElementById('sm-rating').value || null,
    status:         document.getElementById('sm-status').value,
    departments:    depts,
  };
  if(!payload.supplier_name){ alert('Supplier name required'); return; }

  // If editing, send the original source so the server updates the right table
  if(_editSupSource) payload.source = _editSupSource;

  try{
    const r = await fetch('/api/inventory_mgmt/suppliers/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Save failed');
    invCloseModal('supModal');
    invLoadSuppliers();
  }catch(e){ alert('Error: '+e.message); }
}

async function invDeleteSupplier(key){
  if(!confirm('Delete this supplier?')) return;
  await _deleteSuppliers([key]);
}
async function invDeleteSelectedSuppliers(){
  const keys = Object.keys(_selSups);
  if(!keys.length) return;
  if(!confirm(`Delete ${keys.length} supplier(s)?`)) return;
  await _deleteSuppliers(keys);
}
async function _deleteSuppliers(keys){
  const items = keys.map(k => {
    const p = _parseSupKey(k);
    return { id: p.id, source: p.source };
  });
  try{
    const r = await fetch('/api/inventory_mgmt/suppliers/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({items})
    });
    const j = await r.json();
    if(j.status !== 'ok') throw new Error(j.message || 'Delete failed');
    _selSups = {};
    invLoadSuppliers();
  }catch(e){ alert('Error: '+e.message); }
}

/* ═══════════════════════════════════════════════════════════
   WHATSAPP / EMAIL SHARING (Requirement #7)
═══════════════════════════════════════════════════════════ */
async function invShareSelected(channel){
  const ids = Object.keys(_selItems).map(Number);
  if(!ids.length){ alert('Select items first'); return; }

  const sel = _items.filter(i => _selItems[i.id]);
  // Group by supplier (so we can send one message per supplier)
  const bySupplier = {};
  sel.forEach(i => {
    const s = i.last_supplier || '(Unassigned)';
    (bySupplier[s] = bySupplier[s] || []).push(i);
  });

  const supplierNames = Object.keys(bySupplier).filter(n => n !== '(Unassigned)');

  let contactMap = {};
  if(supplierNames.length){
    try{
      const r = await fetch('/api/inventory_mgmt/share/contacts?suppliers=' +
        encodeURIComponent(supplierNames.join('|')));
      const j = await r.json();
      if(j.status === 'ok'){
        j.contacts.forEach(c => { contactMap[c.supplier_name] = c; });
      }
    }catch(e){ /* non-fatal */ }
  }

  // Build message
  for(const [supplier, items] of Object.entries(bySupplier)){
    const lines = items.map(i => {
      const stock = Number(i.in_stock || 0);
      const msl   = i.msl != null ? Number(i.msl) : null;
      const stockStr = stock.toLocaleString('en-IN', {maximumFractionDigits: _dept === 'RM' ? 3 : 0});
      const flag = (msl != null && stock < msl) ? ' ⚠️ BELOW MSL' : '';
      return `• ${i.name}${i.sku_size ? ' ('+i.sku_size+')' : ''} — In Stock: ${stockStr} ${i.uom || ''}${flag}`;
    }).join('\n');

    const header = `*HCP ${_dept} Inventory — ${supplier}*\n${new Date().toLocaleString('en-IN')}\n\n`;
    const body   = header + lines + '\n\n— Sent from HCP Portal';

    const contact = contactMap[supplier];
    if(channel === 'whatsapp'){
      const phone = (contact?.phone || '').replace(/[^\d]/g,'');
      const url = phone
        ? `https://wa.me/${phone}?text=${encodeURIComponent(body)}`
        : `https://wa.me/?text=${encodeURIComponent(body)}`;
      window.open(url, '_blank');
    } else if(channel === 'email'){
      const to = contact?.email || '';
      const subj = `HCP ${_dept} Inventory — ${supplier}`;
      const mail = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
      window.location.href = mail;
      // small delay so each mailto is distinct
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

async function invShareSelectedSuppliers(channel){
  const ids = Object.keys(_selSups).map(Number);
  if(!ids.length){ alert('Select suppliers first'); return; }
  const sel = _suppliers.filter(s => _selSups[s.id]);

  for(const s of sel){
    const body = `Hi ${s.contact_person || s.supplier_name},\n\nRegards,\nHCP Wellness`;
    if(channel === 'whatsapp'){
      const phone = (s.phone || '').replace(/[^\d]/g,'');
      const url = phone
        ? `https://wa.me/${phone}?text=${encodeURIComponent(body)}`
        : `https://wa.me/?text=${encodeURIComponent(body)}`;
      window.open(url, '_blank');
    } else if(channel === 'email'){
      const mail = `mailto:${encodeURIComponent(s.email || '')}?subject=${encodeURIComponent('HCP Wellness')}&body=${encodeURIComponent(body)}`;
      window.location.href = mail;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   EXPORT
═══════════════════════════════════════════════════════════ */
function invExportItems(){
  if(!_items.length){ alert('Nothing to export'); return; }
  const rows = _items.map(i => {
    const base = {
      'Department':      i.department,
      'Name':            i.name,
      'UOM':             i.uom || '',
      'HSN Code':        i.hsn_code || '',
      'GST %':           i.gst_rate != null ? i.gst_rate : '',
      'Last Supplier':   i.last_supplier || '',
      'Last Rate':       i.last_rate != null ? i.last_rate : '',
      'Last Date':       i.last_date || '',
      'In Stock':        i.in_stock || 0,
      'MSL / Min':       i.msl != null ? i.msl : '',
    };
    if(i.department === 'RM'){
      base['Group']      = i.group_name || '';
      base['Type']       = i.material_type || '';
      base['Std Pack']   = i.std_pack_size || '';
      base['Lead Days']  = i.lead_time_days != null ? i.lead_time_days : '';
    }
    if(i.department === 'PM'){
      base['PM Type']    = i.pm_type || '';
      base['Brand']      = i.brand_name || '';
    }
    if(i.department === 'FG'){
      base['FG Code']    = i.fg_code || '';
      base['SKU Size']   = i.sku_size || '';
      base['Brand']      = i.brand_name || '';
      base['Formulation']= i.formulation_batch || '';
    }
    return base;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, _dept + ' Inventory');
  const fn = `Inventory_${_dept}_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fn);
}

/* ═══════════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════════ */
function _esc(s){
  if(s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function _startClock(){
  const el = document.getElementById('clockDisplay');
  if(!el) return;
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  };
  tick(); setInterval(tick, 1000);
}

function invCycleTheme(){
  const themes = ['light','dark'];
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = themes[(themes.indexOf(cur) + 1) % themes.length];
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('hcp_inventory_mgmt_theme', next);
  localStorage.setItem('hcp_theme', next);
}

/* ═══════════════════════════════════════════════════════════
   SOURCE-PAGE IFRAME MODAL (Option A — embed real modals)

   Opens the department's real page (/procurement, /pm_stock, /fg)
   inside an iframe with ?auto=new-item | ?auto=edit&id=... ; the
   target page auto-opens its real modal and postMessage()s back on
   save. Inventory list then refreshes itself.
═══════════════════════════════════════════════════════════ */
const _INV_SOURCE_ROUTES = {
  RM: { url: '/procurement', label: 'Raw Material',    icon: 'fa-flask',    color: 'var(--nb-primary)' },
  PM: { url: '/pm_stock',    label: 'Packing Material', icon: 'fa-box',     color: 'var(--nb-purple)' },
  FG: { url: '/fg',          label: 'Finished Goods',   icon: 'fa-boxes-stacked', color: 'var(--nb-success)' },
};

function _invSourceUrl(dept, mode, id){
  const route = _INV_SOURCE_ROUTES[dept];
  if(!route) return null;
  const q = new URLSearchParams();
  q.set('auto',  mode === 'edit' ? 'edit' : 'new-item');
  q.set('embed', '1');
  if(mode === 'edit' && id) q.set('id', String(id));
  return route.url + '?' + q.toString();
}

/**
 * Open the iframe modal pointing at the given department's real page.
 * mode: 'new' | 'edit'
 * id:   required when mode === 'edit'
 * dept: optional — defaults to current _dept
 */
function invOpenSourceModal(mode, id, dept){
  dept = dept || _dept;
  const route = _INV_SOURCE_ROUTES[dept];
  if(!route){ alert('Unknown department: ' + dept); return; }

  const url = _invSourceUrl(dept, mode, id);
  const frame = document.getElementById('sim-frame');
  if(!frame) return;

  // Update chrome
  document.getElementById('sim-icon').className = 'fas ' + route.icon;
  document.getElementById('sim-title').textContent =
    (mode === 'edit' ? 'Edit ' : 'New ') + route.label + (id ? ' — #' + id : '');
  document.getElementById('sim-dept-badge').innerHTML =
    `<span class="chip chip-dept-${dept.toLowerCase()}">${dept}</span>`;
  const openFull = document.getElementById('sim-open-full');
  if(openFull) openFull.href = url.replace(/&?embed=1/, '') ;

  // Point the iframe at the URL
  frame.src = url;

  invOpenModal('sourceIframeModal');
}

function invCloseSourceModal(){
  invCloseModal('sourceIframeModal');
  // Clear src to stop any running scripts
  const frame = document.getElementById('sim-frame');
  if(frame) frame.src = 'about:blank';
}

/**
 * postMessage listener — the embedded source page hooks its own fetch
 * and sends {source:'inventory-iframe', type:'saved', payload:{...}} on
 * successful save. We listen here, close the iframe, and reload items.
 */
window.addEventListener('message', function(ev){
  const m = ev.data;
  if(!m || m.source !== 'inventory-iframe') return;
  if(m.type === 'saved'){
    // Close after a short delay so the user sees their success toast inside the iframe
    setTimeout(() => {
      invCloseSourceModal();
      // Refresh items + brands (brands may have been added during creation)
      invLoadBrands();
      invLoadItems();
    }, 800);
  } else if(m.type === 'close' || m.type === 'escape'){
    invCloseSourceModal();
  }
});

/**
 * Update the "New Item" button label to reflect current department.
 * Called from invSwitchDept().
 */
function _invUpdateNewItemBtn(){
  const lbl = document.getElementById('newItemBtnLabel');
  if(lbl){
    lbl.textContent = 'New ' + ({RM:'RM',PM:'PM',FG:'FG'}[_dept] || '') + ' Item';
  }
}

