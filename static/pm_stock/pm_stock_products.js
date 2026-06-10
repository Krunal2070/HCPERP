/* pm_stock_products.js — Products tab + add/edit/typeahead */

/* ── Product-name hover → total stock tooltip ─────────────────────────
   Hovering a product name fetches its total live stock (Godown + Factory)
   from /product_stock/<id> and shows a small floating tooltip. Results are
   cached per product id for the session so repeat hovers are instant. */
var _prodStockCache = {};
var _prodStockTipEl = null;
var _prodStockTipTimer = null;

function _prodStockTip(){
  if(_prodStockTipEl) return _prodStockTipEl;
  var el = document.createElement('div');
  el.id = 'prodStockTip';
  el.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;display:none;'
    + 'background:#1f2430;color:#fff;font-size:11.5px;line-height:1.5;'
    + 'padding:8px 11px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);'
    + 'max-width:260px;font-family:inherit';
  document.body.appendChild(el);
  _prodStockTipEl = el;
  return el;
}
function _fmtQty(n){
  try { return Number(n).toLocaleString('en-IN'); } catch(e){ return String(n); }
}
function _prodStockTipShow(target, html){
  var el = _prodStockTip();
  el.innerHTML = html;
  el.style.display = 'block';
  var r = target.getBoundingClientRect();
  // position above the name; flip below if not enough room
  var top = r.top - el.offsetHeight - 8;
  if(top < 8) top = r.bottom + 8;
  var left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8));
  el.style.top = top + 'px';
  el.style.left = left + 'px';
}
function prodStockHover(target, pid){
  var loading = '<div style="font-weight:700;margin-bottom:2px">Total stock</div>'
    + '<div style="opacity:.8">Loading…</div>';
  if(_prodStockCache[pid]){
    _prodStockTipShow(target, _prodStockCache[pid]);
    return;
  }
  _prodStockTipShow(target, loading);
  clearTimeout(_prodStockTipTimer);
  _prodStockTipTimer = setTimeout(function(){
    fetch('/api/pm_stock/product_stock/' + pid)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.status !== 'ok'){ return; }
        var total = d.total_qty || 0;
        var tot = total > 0 ? '#34d399' : '#f87171';
        var html = '<div style="font-weight:800;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.15);padding-bottom:4px">'
          + 'Total stock: <span style="color:' + tot + '">' + _fmtQty(total) + '</span></div>'
          + '<div style="display:flex;gap:14px">'
          + '<span>🏬 Godown: <strong>' + _fmtQty(d.godown_qty||0) + '</strong></span>'
          + '<span>🏭 Factory: <strong>' + _fmtQty(d.factory_qty||0) + '</strong></span>'
          + '</div>';
        _prodStockCache[pid] = html;
        // only update if the tooltip is still showing (user still hovering)
        if(_prodStockTipEl && _prodStockTipEl.style.display === 'block'){
          _prodStockTipShow(target, html);
        }
      })
      .catch(function(){});
  }, 120);   // small debounce so quick mouse passes don't fire fetches
}
function prodStockHoverHide(){
  clearTimeout(_prodStockTipTimer);
  if(_prodStockTipEl) _prodStockTipEl.style.display = 'none';
}
// Invalidate the cache after stock-affecting actions (called from loadProducts).
function _prodStockCacheClear(){ _prodStockCache = {}; }

// ── loadProducts (originally L1186..L1192) ─────────────────────────
async function loadProducts() {
  _prodStockCacheClear();
  const res = await fetch('/api/pm_stock/products');
  _products = await res.json();
  window._products = _products;  // Expose for cross-module access (e.g. label printing)
  renderProductTable();
}


// ── renderProductTable (originally L1193..L1288) ─────────────────────────
function renderProductTable() {
  const search   = (document.getElementById('prod-search')?.value||'').toLowerCase();
  const pmType   = document.getElementById('prod-pm-type')?.value||'';
  const brandId  = parseInt(document.getElementById('prod-brand-filter')?.value)||0;
  let rows = _products;
  if(search)   rows = rows.filter(r =>
    (r.product_name || '').toLowerCase().includes(search) ||
    (r.pm_type      || '').toLowerCase().includes(search) ||
    (r.product_code || '').toLowerCase().includes(search)
  );
  if(pmType)   rows = rows.filter(r=>r.pm_type===pmType);
  if(brandId)  rows = rows.filter(r=>r.brand_id===brandId);
  // Unbranded filter (activated by "Assign Brands" button on the unbranded banner)
  if(window._prodUnbrandedFilter){
    rows = rows.filter(r => !parseInt(r.brand_id) || !(r.brand_name||'').trim());
  }
  _renderUnbrandedFilterChip();

  // ── Stale-selection guard ─────────────────────────────────────
  // If a search/filter is active, prune _selectedProd to only IDs that
  // are currently visible. This prevents the bug where a previous
  // "Select All" left thousands of IDs in the dictionary, causing a
  // later "Assign Brand" to mass-overwrite products the user can't see.
  // Selections persist normally when no filters are active.
  const hasFilter = !!(search || pmType || brandId || window._prodUnbrandedFilter);
  if(hasFilter && Object.keys(_selectedProd).length){
    const visibleIds = new Set(rows.map(r => r.id));
    let pruned = 0;
    for(const sid of Object.keys(_selectedProd)){
      if(!visibleIds.has(parseInt(sid))){
        delete _selectedProd[sid];
        pruned++;
      }
    }
    if(pruned > 0){
      console.log('[selection] pruned ' + pruned + ' selections that fell outside current filter');
      _updateProdSelectionButtons();
      updateSvBrandBar?.();
    }
  }
  // ──────────────────────────────────────────────────────────────

  const {slice, total, pages, page, start} = paginate(rows, 'prod');
  const tbody = document.getElementById('prodTbody');

  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="8" class="no-data"><i class="fas fa-box-open"></i> No products found</td></tr>`;
    document.getElementById('prodPag').innerHTML=''; return;
  }

  tbody.innerHTML = slice.map((r,i)=>{
    const sel = !!_selectedProd[r.id];
    const bBadge = r.brand_name ? `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${r.brand_color||'#5E35B1'}22;color:${r.brand_color||'#5E35B1'};border:1px solid ${r.brand_color||'#5E35B1'}44">${r.brand_name}</span>` : '—';
    const msVal = r.min_stock||0;
    const msColor = msVal>0 ? 'color:var(--floor-clr,#d97706);font-weight:700' : 'color:var(--hmuted,#9ca3af)';
    const code = (r.product_code||'').trim();
    const codeCell = code
      ? `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:800;letter-spacing:1px;font-family:'JetBrains Mono','Courier New',monospace;background:rgba(26,115,232,.10);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.25)">${code}</span>`
      : `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:9.5px;font-weight:700;background:rgba(220,38,38,.10);color:#dc2626;border:1px solid rgba(220,38,38,.25)" title="No product code — generate from banner">— missing —</span>`;
    return `<tr class="dbl-hint${sel?' selected-row':''}" ondblclick="openEditProduct(${r.id})">
      <td><input type="checkbox" class="row-select" data-id="${r.id}" data-grid="prod"
        onchange="onProdCheck(this,${r.id})"
        ${sel?'checked':''} style="accent-color:var(--brand)"></td>
      <td style="color:var(--hmuted,#9ca3af)">${start+i+1}</td>
      <td class="td-name"><span class="prod-name-hover" data-pid="${r.id}"
        onmouseenter="prodStockHover(this,${r.id})" onmouseleave="prodStockHoverHide()"
        style="cursor:help;border-bottom:1px dotted var(--hbdr2,rgba(0,0,0,.25))">${r.product_name}</span></td>
      <td>${codeCell}</td>
      <td><span class="pm-badge">${r.pm_type}</span></td>
      <td>${bBadge}</td>
      <td style="white-space:nowrap">${(function(){
        const pu = (r.primary_uom || 'Nos');
        const au = (r.alt_uom || '').trim();
        const ratio = r.alt_to_primary_ratio;
        const primaryBadge = `<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:800;background:rgba(13,148,136,.10);color:var(--teal,#0d9488);border:1px solid rgba(13,148,136,.25)">${pu}</span>`;
        if(!au) return primaryBadge;
        const tip = (ratio!=null && Number(ratio)>0) ? `1 ${pu} = ${Number(ratio).toLocaleString('en-IN')} ${au}` : `${au} (no ratio set)`;
        const altBadge = `<span title="${tip}" style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:rgba(124,58,237,.10);color:#7c3aed;border:1px solid rgba(124,58,237,.25);margin-left:4px">${au}</span>`;
        return primaryBadge + altBadge;
      })()}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap">
        <div style="display:flex;align-items:center;gap:4px">
          <input type="number" min="0" step="100" value="${msVal}" placeholder="0=off"
            data-pid="${r.id}"
            style="width:75px;background:var(--hinput,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.13));
              border-radius:5px;padding:3px 6px;font-size:11px;font-family:'Sora',sans-serif;
              ${msColor};outline:none"
            onkeydown="if(event.key==='Enter')saveInlineThreshold(this)"
            onfocus="this.style.borderColor='var(--floor-clr,#d97706)'"
            onblur="this.style.borderColor='var(--hbdr2,rgba(0,0,0,.13))'">
          <button onclick="saveInlineThreshold(this.previousElementSibling)"
            style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;cursor:pointer;
              background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);
              color:var(--floor-clr,#d97706);font-family:'Sora',sans-serif">Set</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  renderPag('prodPag','prod',total,pages,page);
  _updateProdSelectionButtons();
}

/* ═══════════════════════════════════════════════════════════
   PRODUCT SEARCH DROPDOWN (custom styled)
═══════════════════════════════════════════════════════════ */
let _dropdownActive = {}; // {prefix: currentIndex}


// ── filterProductDropdown (originally L1289..L1320) ─────────────────────────
function filterProductDropdown(prefix) {
  const query   = (document.getElementById(prefix+'-product-search').value || '').toLowerCase();
  const list    = document.getElementById(prefix+'-product-list');
  const preview = document.getElementById(prefix+'-product-preview');

  if(query.length < 1){ list.classList.remove('open'); list.innerHTML=''; return; }

  const matches = _products.filter(p =>
    (p.product_name || '').toLowerCase().includes(query) ||
    (p.pm_type      || '').toLowerCase().includes(query) ||
    (p.product_code || '').toLowerCase().includes(query)
  ).slice(0, 40);

  if(!matches.length){
    list.innerHTML = `<div class="prod-dropdown-empty"><i class="fas fa-search"></i> No products found for "${query}"</div>`;
    list.classList.add('open');
    preview.style.display = 'none';
    return;
  }

  list.innerHTML = matches.map((p,i) => `
    <div class="prod-dropdown-item" data-id="${p.id}" data-idx="${i}"
      onmousedown="selectDropdownItem(event,'${prefix}',${p.id})"
      onmouseover="setDropdownActive('${prefix}',${i})">
      <span class="item-badge">${p.pm_type}</span>
      <span class="item-name">${highlightMatch(p.product_name, query)}</span>
    </div>`).join('');
  list.classList.add('open');
  _dropdownActive[prefix] = -1;
  preview.style.display = 'none';
}


// ── highlightMatch (originally L1321..L1329) ─────────────────────────
function highlightMatch(text, query) {
  if(!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if(idx === -1) return text;
  return text.slice(0,idx) +
    `<strong style="color:var(--brand)">${text.slice(idx, idx+query.length)}</strong>` +
    text.slice(idx+query.length);
}


// ── setDropdownActive (originally L1330..L1335) ─────────────────────────
function setDropdownActive(prefix, idx) {
  _dropdownActive[prefix] = idx;
  document.querySelectorAll(`#${prefix}-product-list .prod-dropdown-item`)
    .forEach((el,i) => el.classList.toggle('active', i===idx));
}


// ── selectDropdownItem (originally L1336..L1362) ─────────────────────────
function selectDropdownItem(event, prefix, productId) {
  event.preventDefault();
  const prod = _products.find(p => p.id === productId);
  if(!prod) return;
  document.getElementById(prefix+'-product-id').value    = prod.id;
  document.getElementById(prefix+'-product-search').value = `[${prod.pm_type}] ${prod.product_name}`;
  const preview = document.getElementById(prefix+'-product-preview');
  preview.textContent  = `✓ ${prod.product_name}`;
  preview.style.display = 'block';
  const list = document.getElementById(prefix+'-product-list');
  list.classList.remove('open');
  list.innerHTML = '';
  // Show current stock context
  const summary = _summary.find(s => s.id === productId);
  const ctx = document.getElementById(prefix+'-stock-context');
  if(ctx && summary){
    const gEl = document.getElementById(prefix+'-stock-godown');
    const fEl = document.getElementById(prefix+'-stock-floor');
    if(gEl) gEl.textContent = fmt(summary.godown_stock);
    if(fEl) fEl.textContent = fmt(summary.remaining);
    // Colour godown stock red if negative or zero
    if(gEl) gEl.style.color = summary.godown_stock <= 0 ? 'var(--red,#ef4444)' : 'var(--godown-clr)';
    if(fEl) fEl.style.color = summary.remaining   <= 0 ? 'var(--red,#ef4444)' : 'var(--floor-clr)';
    ctx.style.display = 'block';
  }
}


// ── navDropdown (originally L1363..L1406) ─────────────────────────
function navDropdown(event, prefix) {
  const list  = document.getElementById(prefix+'-product-list');
  const items = list.querySelectorAll('.prod-dropdown-item');
  if(!list.classList.contains('open') || !items.length) return;

  let idx = _dropdownActive[prefix] ?? -1;

  if(event.key === 'ArrowDown'){
    event.preventDefault();
    idx = Math.min(idx+1, items.length-1);
    setDropdownActive(prefix, idx);
    items[idx]?.scrollIntoView({block:'nearest'});
  } else if(event.key === 'ArrowUp'){
    event.preventDefault();
    idx = Math.max(idx-1, 0);
    setDropdownActive(prefix, idx);
    items[idx]?.scrollIntoView({block:'nearest'});
  } else if(event.key === 'Enter'){
    event.preventDefault();
    if(idx >= 0 && items[idx]){
      const id = parseInt(items[idx].dataset.id);
      selectDropdownItem(event, prefix, id);
    }
  } else if(event.key === 'Escape'){
    list.classList.remove('open');
    list.innerHTML = '';
  }
}

// Close dropdown when clicking outside
document.addEventListener('mousedown', e => {
  ['ge','fe'].forEach(prefix => {
    const list   = document.getElementById(prefix+'-product-list');
    const input  = document.getElementById(prefix+'-product-search');
    if(list && input && !list.contains(e.target) && e.target !== input){
      list.classList.remove('open');
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   SUMMARY (Stock View) — LIVE UPDATE
═══════════════════════════════════════════════════════════ */


// ── openEditProduct (originally L2519..L2558) ─────────────────────────
function openEditProduct(id) {
  const prod = _products.find(p=>p.id===id); if(!prod) return;
  document.getElementById('ep-id').value   = id;
  document.getElementById('ep-name').value = prod.product_name;
  document.getElementById('ep-pm').value   = prod.pm_type;
  // Code field (read-only)
  const codeFld = document.getElementById('ep-code');
  if(codeFld){
    codeFld.value = (prod.product_code || '');
    codeFld.placeholder = (prod.product_code ? '' : '(none — pick brand + PM type)');
    codeFld.dataset.origCode  = prod.product_code || '';
    codeFld.dataset.origPm    = prod.pm_type || '';
    codeFld.dataset.origBrand = String(prod.brand_id || '');
  }
  // Populate brand select — brand is REQUIRED for products with codes
  const epBrand = document.getElementById('ep-brand');
  if(epBrand){
    epBrand.innerHTML = '<option value="">— Select Brand —</option>' +
      _brands.map(b=>`<option value="${b.id}"${prod.brand_id==b.id?' selected':''}>${b.name}</option>`).join('');
  }
  // ── Lock Brand + PM Type for non-admins when product already has a code.
  // Changing either would force the code to regenerate, which is admin-only.
  const isAdmin    = (typeof isAdminUser === 'function') ? !!isAdminUser()
                   : (typeof window.__pmIsAdmin === 'function' ? !!window.__pmIsAdmin() : false);
  const hasCode    = !!(prod.product_code || '').trim();
  const lockFields = hasCode && !isAdmin;
  const epPmField  = document.getElementById('ep-pm');
  if(epBrand) {
    epBrand.disabled = lockFields;
    epBrand.title    = lockFields ? 'Locked — admin only (changing would regenerate the product code)' : '';
    epBrand.style.opacity = lockFields ? '.6' : '';
  }
  if(epPmField) {
    epPmField.readOnly = lockFields;
    epPmField.title    = lockFields ? 'Locked — admin only (changing would regenerate the product code)' : '';
    epPmField.style.opacity = lockFields ? '.6' : '';
  }
  // UOM prefill (Phase 1) — populate selects, then derive the two conversion
  // qty inputs from the stored alt-per-primary ratio so the UI reads as
  // "1 [primary] = [ratio] [alt]".
  const epPU = document.getElementById('ep-primary-uom');
  const epAU = document.getElementById('ep-alt-uom');
  const ePq  = document.getElementById('ep-conv-primary-qty');
  const eAq  = document.getElementById('ep-conv-alt-qty');
  const storedPrimary = (prod.primary_uom || 'Nos');
  const storedAlt     = (prod.alt_uom || '');
  const storedRatio   = (prod.alt_to_primary_ratio != null ? Number(prod.alt_to_primary_ratio) : null);
  _fillUomSelect(epPU, storedPrimary, false);
  _fillUomSelect(epAU, storedAlt,    true);
  if(ePq) ePq.value = 1;
  if(eAq) eAq.value = (storedAlt && storedRatio != null && storedRatio > 0) ? storedRatio : '';
  epOnUomChange();
  document.getElementById('editProductModal').classList.add('open');
}

// Common UOM list shared by Add + Edit Product modals.
const _UOM_LIST = [
  'Nos','Box','Case','Dozen','Pkt','Bag','Bottle','Pcs','Pair','Set','Roll','Unit',
  'Kg','Gm','Mg','Lb',
  'Ltr','Ml',
  'Mtr','Cm','Mm','Ft','Inch'
];

// Populate a UOM <select> with our list. `includeNone` adds a "— None —" entry
// at the top (used for the alternate-UOM picker).
function _fillUomSelect(sel, current, includeNone){
  if(!sel) return;
  const cur = (current || '').trim();
  let html = includeNone ? '<option value="">— None —</option>' : '';
  // If current value is not in the canonical list (e.g. legacy 'PCS' from
  // Phase 1 default), keep it as a selectable option so it round-trips
  // without forcing a silent change.
  const list = _UOM_LIST.slice();
  if(cur && !list.some(u => u.toLowerCase() === cur.toLowerCase())) list.unshift(cur);
  for(const u of list){
    const sel2 = (cur && u.toLowerCase() === cur.toLowerCase()) ? ' selected' : '';
    html += `<option value="${u}"${sel2}>${u}</option>`;
  }
  sel.innerHTML = html;
}

// Live update of the Tally-style conversion line. Shows/hides the conversion
// row based on whether an alt UOM is chosen, and mirrors the UOM names beside
// the qty inputs so it reads naturally as "1 Kg = 15,000 Nos".
function _uomOnChange(prefix){
  const pSel = document.getElementById(prefix + '-primary-uom');
  const aSel = document.getElementById(prefix + '-alt-uom');
  const p = (pSel?.value || '').trim() || 'Nos';
  const a = (aSel?.value || '').trim();
  const row = document.getElementById(prefix + '-conv-row');
  const pLbl = document.getElementById(prefix + '-conv-primary-uom');
  const aLbl = document.getElementById(prefix + '-conv-alt-uom');
  if(pLbl) pLbl.textContent = p;
  if(aLbl) aLbl.textContent = a || '—';
  if(row)  row.style.display = a ? '' : 'none';
  // Guard against picking the same UOM on both sides.
  if(a && a.toLowerCase() === p.toLowerCase()){
    if(aSel){ aSel.value = ''; aSel.focus(); }
    if(typeof showToast === 'function') showToast('Alternate UOM must differ from primary','error');
    if(row) row.style.display = 'none';
  }
}
function apOnUomChange(){ _uomOnChange('ap'); }
function epOnUomChange(){ _uomOnChange('ep'); }
window.apOnUomChange = apOnUomChange;
window.epOnUomChange = epOnUomChange;

// ═════════════════════════════════════════════════════════════
// Bulk UOM assign (Phase 2) — Products page selection toolbar.
// Mirrors assignBrandToSelectedProds: same selection model, same
// confirm-with-sample dialog, same fields, but for UOM + ratio.
// ═════════════════════════════════════════════════════════════

// Live update of the in-bar conversion line: show/hide based on alt UOM,
// mirror UOM names beside the qty inputs ("1 Kg = 15,000 Nos" style).
function updateProdUomBar(){
  const p = (document.getElementById('prod-assign-primary-uom')?.value||'').trim() || 'Nos';
  const a = (document.getElementById('prod-assign-alt-uom')?.value||'').trim();
  const conv = document.getElementById('prod-uom-conv');
  const pLbl = document.getElementById('prod-uom-conv-p-lbl');
  const aLbl = document.getElementById('prod-uom-conv-a-lbl');
  if(pLbl) pLbl.textContent = p;
  if(aLbl) aLbl.textContent = a || '—';
  if(conv) conv.style.display = a ? 'flex' : 'none';
  if(a && a.toLowerCase() === p.toLowerCase()){
    const altSel = document.getElementById('prod-assign-alt-uom');
    if(altSel) altSel.value = '';
    if(conv) conv.style.display = 'none';
    if(typeof showToast === 'function') showToast('Alternate UOM must differ from primary','error');
  }
}
window.updateProdUomBar = updateProdUomBar;

async function assignUomToSelectedProds(clearAlt=false){
  const ids = Object.keys(_selectedProd).map(Number);
  if(!ids.length){ showToast('Select products first','error'); return; }

  const primaryUom = (document.getElementById('prod-assign-primary-uom')?.value||'').trim() || 'Nos';
  const altUom     = clearAlt ? '' : (document.getElementById('prod-assign-alt-uom')?.value||'').trim();
  let altRatio = null;
  if(!clearAlt && altUom){
    if(altUom.toLowerCase() === primaryUom.toLowerCase()){
      showToast('Alternate UOM must differ from primary','error'); return;
    }
    const convP = parseFloat(document.getElementById('prod-uom-conv-p')?.value);
    const convA = parseFloat(document.getElementById('prod-uom-conv-a')?.value);
    if(!(convP > 0) || !(convA > 0)){
      showToast(`Enter the conversion: how many ${altUom} make up 1 ${primaryUom}?`,'error');
      document.getElementById('prod-uom-conv-a')?.focus(); return;
    }
    altRatio = convA / convP;
  }

  // Confirmation with sample names so a stray "Select All" can't mass-overwrite silently.
  const sampleNames = ids.slice(0, 5).map(i => {
    const p = _products.find(x => x.id === i);
    return p ? '• ' + p.product_name : '• (id ' + i + ')';
  }).join('\n');
  const more = ids.length > 5 ? `\n…and ${ids.length - 5} more` : '';
  let action;
  if(clearAlt){
    action = `Clear the Alternate UOM (and ratio) on ${ids.length} product(s)?\n(Primary UOM is left unchanged.)`;
  } else if(altUom){
    action = `Set Primary UOM to "${primaryUom}" and Alternate UOM to "${altUom}" (1 ${primaryUom} = ${altRatio} ${altUom}) on ${ids.length} product(s)?`;
  } else {
    action = `Set Primary UOM to "${primaryUom}" on ${ids.length} product(s)?\n(No alternate UOM — any existing alternate stays as-is unless you click "Clear Alt".)`;
  }
  const confirmMsg = `${action}\n\n${sampleNames}${more}\n\n` +
    (ids.length > 50
      ? `⚠ This is a LARGE batch (${ids.length} products). Double-check the list above.\n\n`
      : '') + `Click OK to proceed.`;
  if(!confirm(confirmMsg)) return;

  try{
    const res = await fetch('/api/pm_stock/products/assign_uom',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        ids,
        primary_uom: primaryUom,
        alt_uom: clearAlt ? null : (altUom || null),
        alt_to_primary_ratio: clearAlt ? null : altRatio,
        clear_alt: !!clearAlt,
        confirm_large_batch: ids.length > 500
      })
    });
    const data = await res.json();
    if(data.status === 'ok'){
      showToast(`✓ UOM updated on ${data.updated_count || ids.length} product(s)`,'success');
      _selectedProd = {};
      const uomBar = document.getElementById('prod-uom-bar'); if(uomBar) uomBar.style.display = 'none';
      const brandBar = document.getElementById('prod-brand-bar'); if(brandBar) brandBar.style.display = 'none';
      document.getElementById('prodDeleteBtn')?.style.setProperty('display','none');
      document.querySelectorAll('.row-select[data-grid="prod"]').forEach(cb => cb.checked = false);
      const allCb = document.getElementById('chkAllProd'); if(allCb) allCb.checked = false;
      await loadProducts();
    } else {
      showToast(data.message || 'Error', 'error');
    }
  }catch(e){ showToast('Error: '+e.message, 'error'); }
}
window.assignUomToSelectedProds = assignUomToSelectedProds;


// ── saveProductEdit (originally L2559..L2592) ─────────────────────────
async function saveProductEdit() {
  const id      = parseInt(document.getElementById('ep-id').value);
  const name    = document.getElementById('ep-name').value.trim();
  const pm      = document.getElementById('ep-pm').value.trim();
  const brandId = parseInt(document.getElementById('ep-brand')?.value)||null;
  // UOM (Phase 1) — Tally-style: ratio = alt_qty / primary_qty (alt-per-primary).
  const primaryUom = (document.getElementById('ep-primary-uom')?.value||'').trim() || 'Nos';
  const altUom     = (document.getElementById('ep-alt-uom')?.value||'').trim() || '';
  const convP      = parseFloat(document.getElementById('ep-conv-primary-qty')?.value);
  const convA      = parseFloat(document.getElementById('ep-conv-alt-qty')?.value);
  let altRatio = null;
  if(altUom){
    if(altUom.toLowerCase() === primaryUom.toLowerCase()){
      showToast('Alternate UOM must differ from primary UOM','error');
      document.getElementById('ep-alt-uom')?.focus(); return;
    }
    if(!(convP > 0) || !(convA > 0)){
      showToast(`Enter the conversion: how many ${altUom} make up 1 ${primaryUom}?`,'error');
      document.getElementById('ep-conv-alt-qty')?.focus(); return;
    }
    altRatio = convA / convP;
  }
  if(!name||!pm){showToast('Fill name and PM type','error');return;}
  if(!brandId){
    showToast('Brand is required (used to generate product code)','error');
    document.getElementById('ep-brand')?.focus();
    return;
  }
  const res=await fetch('/api/pm_stock/update_product',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id, product_name:name, pm_type:pm, brand_id:brandId,
                         primary_uom:primaryUom, alt_uom:(altUom||null),
                         alt_to_primary_ratio:altRatio})});
  const data=await res.json();
  if(data.status==='ok'){
    const newCode = data.product_code || '';
    showToast(newCode ? `✓ Product updated (Code: ${newCode})` : '✓ Product updated','success');
    closeModal('editProductModal');
    const prod=_products.find(p=>p.id===id);
    if(prod){
      prod.product_name=name; prod.pm_type=pm; prod.brand_id=brandId;
      if(newCode) prod.product_code = newCode;
      prod.primary_uom = primaryUom; prod.alt_uom = altUom||''; prod.alt_to_primary_ratio = altRatio;
      const b=_brands.find(x=>x.id===brandId);
      prod.brand_name=b?b.name:''; prod.brand_color=b?b.color:'';
    }
    renderProductTable();
    loadPmTypes();
    await loadSummary();
  } else { showToast(data.message||'Error','error'); }
}

/* ═══════════════════════════════════════════════════════════
   SELECTION — STOCK / COMBINED
═══════════════════════════════════════════════════════════ */

// ── openAddProductModal (originally L2867..L2897) ─────────────────────────
function openAddProductModal(){
  document.getElementById('ap-name').value='';
  document.getElementById('ap-pm').value='';
  document.getElementById('ap-op-date').value=new Date().toISOString().slice(0,10);
  // Reset code field
  const codeFld = document.getElementById('ap-code');
  if(codeFld){ codeFld.value = ''; codeFld.placeholder = 'Pick Brand + PM Type to generate'; }
  const regen = document.getElementById('ap-code-regen');
  if(regen){ regen.disabled = true; regen.style.opacity = '.5'; }
  // Populate brand dropdown — brand is now REQUIRED
  const apBrand = document.getElementById('ap-brand');
  if(apBrand){
    apBrand.innerHTML = '<option value="">— Select Brand —</option>' +
      _brands.map(b=>`<option value="${b.id}">${b.name}</option>`).join('');
  }
  // Clear and seed godown rows container with one row per godown
  const container = document.getElementById('ap-godown-rows');
  if(container) {
    container.innerHTML = '';
    // Add one row per known storage godown by default (excludes FACTORY/floor locations)
    const storage = _apStorageGodowns();
    if(storage.length) {
      storage.forEach(g => apAddGodownRow(g.id));
    } else {
      apAddGodownRow(); // at least one blank row
    }
  }
  // UOM (Phase 1) — populate selects, default primary = 'Nos', no alternate.
  const apPU = document.getElementById('ap-primary-uom');
  const apAU = document.getElementById('ap-alt-uom');
  const apPq = document.getElementById('ap-conv-primary-qty');
  const apAq = document.getElementById('ap-conv-alt-qty');
  _fillUomSelect(apPU, 'Nos', false);
  _fillUomSelect(apAU, '',    true);
  if(apPq) apPq.value = 1;
  if(apAq) apAq.value = '';
  if(typeof apOnUomChange === 'function') apOnUomChange();
  document.getElementById('addProductModal').classList.add('open');
  setTimeout(()=>document.getElementById('ap-name').focus(), 100);
}


// ── _apStorageGodowns (originally L2898..L2906) ─────────────────────────
function _apStorageGodowns() {
  // Include ALL storage locations — godowns AND factory/floor.
  // Exclude only billing and shipping address types.
  return (_godowns||[]).filter(g =>
    g.godown_type !== 'billing' &&
    g.godown_type !== 'shipping'
  );
}


// ── _apUsedGodownIds (originally L2907..L2912) ─────────────────────────
function _apUsedGodownIds() {
  // Get already-selected godown IDs from existing rows
  return [...document.querySelectorAll('#ap-godown-rows .ap-gd-sel')]
    .map(sel => sel.value).filter(v => v);
}


// ── apAddGodownRow (originally L2913..L2956) ─────────────────────────
function apAddGodownRow(preselectedGodownId) {
  const container = document.getElementById('ap-godown-rows');
  if(!container) return;
  const storage = _apStorageGodowns();
  const used    = _apUsedGodownIds();

  // Check if there's any godown still available (excluding the one we're pre-selecting)
  const available = storage.filter(g =>
    !used.includes(String(g.id)) || String(g.id) === String(preselectedGodownId)
  );
  if(!available.length) {
    showToast('All godowns already added','info');
    apUpdateAddBtn();
    return;
  }

  const opts = '<option value="">— Select Godown —</option>' +
    storage.map(g => {
      const isUsed       = used.includes(String(g.id));
      const isPreselected = String(g.id) === String(preselectedGodownId);
      const disabled = (isUsed && !isPreselected) ? 'disabled style="color:#bbb"' : '';
      return `<option value="${g.id}" ${isPreselected?'selected':''} ${disabled}>${godownLabel(g)}${isUsed&&!isPreselected?' (already added)':''}</option>`;
    }).join('');

  const row = document.createElement('div');
  row.className = 'ap-gdrow';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 100px 28px;gap:6px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  row.innerHTML = `
    <select class="ap-gd-sel" onchange="apOnGodownChange(this)"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid rgba(14,165,233,.3);
      border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--font-body);color:var(--htxtb,#111);outline:none">
      ${opts}
    </select>
    <input type="number" class="ap-gd-qty" min="0" step="1" placeholder="0"
      style="width:100%;background:rgba(14,165,233,.05);border:1.5px solid rgba(14,165,233,.3);
        border-radius:6px;padding:6px 8px;font-size:12px;font-weight:700;color:var(--godown-clr);outline:none;text-align:right">
    <button type="button" onclick="this.closest('.ap-gdrow').remove();apRefreshRows()" title="Remove"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);
        color:#ef4444;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>`;
  container.appendChild(row);
  apUpdateAddBtn();
}

/* Called when a godown dropdown changes — refresh all row dropdowns to disable used godowns */

// ── apOnGodownChange (originally L2957..L2972) ─────────────────────────
function apOnGodownChange(selectEl) {
  // Detect a duplicate selection: if this value is already selected in ANOTHER row, reject
  const myValue = selectEl.value;
  if(myValue) {
    const otherSelects = [...document.querySelectorAll('#ap-godown-rows .ap-gd-sel')].filter(s => s !== selectEl);
    const duplicate = otherSelects.find(s => s.value === myValue);
    if(duplicate) {
      showToast('This godown is already added','error');
      selectEl.value = '';
      return;
    }
  }
  apRefreshRows();
}

/* Refresh all row dropdowns — mark used godowns as disabled in each */

// ── apRefreshRows (originally L2973..L2995) ─────────────────────────
function apRefreshRows() {
  const storage = _apStorageGodowns();
  const rows    = [...document.querySelectorAll('#ap-godown-rows .ap-gdrow')];
  rows.forEach(row => {
    const sel = row.querySelector('.ap-gd-sel');
    if(!sel) return;
    const currentVal = sel.value;
    // Collect values selected in OTHER rows
    const otherVals = rows.filter(r => r !== row)
      .map(r => r.querySelector('.ap-gd-sel')?.value)
      .filter(v => v);
    sel.innerHTML = '<option value="">— Select Godown —</option>' +
      storage.map(g => {
        const isUsed = otherVals.includes(String(g.id));
        const isMine = String(g.id) === String(currentVal);
        const dis = (isUsed && !isMine) ? 'disabled style="color:#bbb"' : '';
        return `<option value="${g.id}" ${isMine?'selected':''} ${dis}>${godownLabel(g)}${isUsed&&!isMine?' (already added)':''}</option>`;
      }).join('');
  });
  apUpdateAddBtn();
}

/* Enable/disable the + Add Godown button based on whether any godowns remain */

// ── apUpdateAddBtn (originally L2996..L3007) ─────────────────────────
function apUpdateAddBtn() {
  const btn = document.getElementById('ap-add-gd-btn');
  if(!btn) return;
  const storage = _apStorageGodowns();
  const used    = _apUsedGodownIds();
  const allUsed = storage.length > 0 && used.length >= storage.length;
  btn.disabled = allUsed;
  btn.style.opacity = allUsed ? '0.4' : '1';
  btn.style.cursor  = allUsed ? 'not-allowed' : 'pointer';
  btn.title         = allUsed ? 'All godowns already added' : '';
}


// ── saveNewProduct (originally L3008..L3072) ─────────────────────────
async function saveNewProduct(){
  const name    = document.getElementById('ap-name').value.trim();
  const pm      = document.getElementById('ap-pm').value.trim();
  const brandId = parseInt(document.getElementById('ap-brand')?.value)||null;
  const opDate  = document.getElementById('ap-op-date').value||new Date().toISOString().slice(0,10);
  // UOM (Phase 1) — primary defaults to Nos; alt optional. Conversion is
  // entered Tally-style as "[primary_qty] [primary] = [alt_qty] [alt]";
  // the stored ratio is alt-per-primary = alt_qty / primary_qty.
  const primaryUom = (document.getElementById('ap-primary-uom')?.value||'').trim() || 'Nos';
  const altUom     = (document.getElementById('ap-alt-uom')?.value||'').trim() || '';
  const convP      = parseFloat(document.getElementById('ap-conv-primary-qty')?.value);
  const convA      = parseFloat(document.getElementById('ap-conv-alt-qty')?.value);
  let altRatio = null;
  if(altUom){
    if(altUom.toLowerCase() === primaryUom.toLowerCase()){
      showToast('Alternate UOM must differ from primary UOM','error');
      document.getElementById('ap-alt-uom')?.focus(); return;
    }
    if(!(convP > 0) || !(convA > 0)){
      showToast(`Enter the conversion: how many ${altUom} make up 1 ${primaryUom}?`,'error');
      document.getElementById('ap-conv-alt-qty')?.focus(); return;
    }
    altRatio = convA / convP;       // alt per 1 primary
  }

  // Collect per-godown rows
  const gdRows = [];
  document.querySelectorAll('#ap-godown-rows .ap-gdrow').forEach(row => {
    const gid = parseInt(row.querySelector('.ap-gd-sel')?.value)||0;
    const qty = parseFloat(row.querySelector('.ap-gd-qty')?.value)||0;
    if(gid && qty > 0) gdRows.push({godown_id: gid, qty});
  });

  if(!name||!pm){showToast('Fill product name and PM type','error');return;}
  if(!brandId){
    showToast('Brand is required (used to generate a unique product code)','error');
    document.getElementById('ap-brand')?.focus();
    return;
  }

  const btn = document.getElementById('ap-save-btn');
  const origHTML = btn.innerHTML; btn.innerHTML='<span class="spinner"></span> Saving…'; btn.disabled=true;
  try{
    // 1. Create product
    const res = await fetch('/api/pm_stock/add_product',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({product_name:name, pm_type:pm, brand_id:brandId,
                           primary_uom:primaryUom, alt_uom:(altUom||null),
                           alt_to_primary_ratio:altRatio})});
    const data = await res.json();
    if(data.status==='duplicate'){
      showToast(data.message || 'A product with this name already exists.', 'warning', 6000);
      return;
    }
    if(data.status!=='ok'){showToast(data.message||'Error','error');return;}
    const productId = data.id;
    const newCode   = data.product_code || '';

    // 2. Save opening stock per location (godown or factory)
    for(const gd of gdRows){
      const loc = (_godowns||[]).find(g => g.id === gd.godown_id);
      const isFactory = loc && (loc.godown_type === 'floor' || loc.is_floor);
      if(isFactory) {
        // Factory opening
        await fetch('/api/pm_stock/floor/save',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({product_id:productId,txn_type:'floor_opening',qty:gd.qty,txn_date:opDate,
                               remarks:'Factory Opening Balance',godown_id:gd.godown_id})});
      } else {
        // Godown opening
        await fetch('/api/pm_stock/godown/save',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({product_id:productId,txn_type:'opening',qty:gd.qty,txn_date:opDate,
                               remarks:'Opening Balance',godown_id:gd.godown_id})});
      }
    }

    const totalGdnOp = gdRows.reduce((s,r)=>s+r.qty,0);
    const codeMsg = newCode ? ` (Code: ${newCode})` : '';
    showToast(totalGdnOp>0
      ? `✓ Product added${codeMsg} — Godown OP: ${fmt(totalGdnOp)}`
      : `✓ Product added${codeMsg}`, 'success');
    closeModal('addProductModal');
    await loadProducts(); await loadPmTypes(); await loadSummary();
  }catch(e){showToast('Error: '+e.message,'error');}
  finally{btn.innerHTML=origHTML;btn.disabled=false;}
}

/* ═══════════════════════════════════════════════════════════
   PRODUCT CODE GENERATION (preview + banner + backfill)
═══════════════════════════════════════════════════════════ */

// Strip to alphanumeric uppercase, take up to maxLen chars

// ── _cleanForCode (originally L3073..L3077) ─────────────────────────
function _cleanForCode(text, maxLen){
  return String(text||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0, maxLen);
}

// Build a 10-char preview code using current brand + PM type and random digits

// ── _buildPreviewCode (originally L3078..L3089) ─────────────────────────
function _buildPreviewCode(brandName, pmType){
  const b = _cleanForCode(brandName, 4);
  const p = _cleanForCode(pmType,    4);
  if(!b || !p) return '';
  const fixed = b + p;             // 2..8 chars
  const rand  = 10 - fixed.length; // 2..8 digits
  let suffix = '';
  for(let i=0; i<rand; i++) suffix += Math.floor(Math.random()*10);
  return (fixed + suffix).slice(0, 10);
}

// Add Product modal — refresh code preview when brand or PM type changes

// ── apMaybeGenerateCode (originally L3090..L3104) ─────────────────────────
function apMaybeGenerateCode(){
  const brandId = parseInt(document.getElementById('ap-brand')?.value)||0;
  const pm      = (document.getElementById('ap-pm')?.value || '').trim();
  const brand   = (_brands||[]).find(b => b.id === brandId);
  const codeFld = document.getElementById('ap-code');
  const regen   = document.getElementById('ap-code-regen');
  if(!codeFld) return;
  const preview = (brand && pm) ? _buildPreviewCode(brand.name, pm) : '';
  codeFld.value = preview;
  if(regen){
    regen.disabled = !preview;
    regen.style.opacity = preview ? '1' : '.5';
  }
}


// ── apRegenerateCode (originally L3105..L3107) ─────────────────────────
function apRegenerateCode(){ apMaybeGenerateCode(); }

// Edit Product modal — re-preview code when brand or PM type changes

// ── epMaybeRegenerateCode (originally L3108..L3137) ─────────────────────────
function epMaybeRegenerateCode(){
  const codeFld = document.getElementById('ep-code');
  if(!codeFld) return;
  const brandId   = parseInt(document.getElementById('ep-brand')?.value)||0;
  const pm        = (document.getElementById('ep-pm')?.value || '').trim();
  const brand     = (_brands||[]).find(b => b.id === brandId);
  const origCode  = codeFld.dataset.origCode  || '';
  const origPm    = codeFld.dataset.origPm    || '';
  const origBrand = codeFld.dataset.origBrand || '';
  const changed   = String(brandId) !== origBrand || pm !== origPm || !origCode;

  const hint = document.getElementById('ep-code-hint');
  if(!brand || !pm){
    codeFld.value = origCode;
    if(hint){
      hint.textContent = origCode
        ? 'Code regenerates automatically when Brand or PM Type changes.'
        : 'Pick Brand + PM Type — a code will be generated on save.';
    }
    return;
  }
  if(changed){
    codeFld.value = _buildPreviewCode(brand.name, pm);
    if(hint) hint.innerHTML = '<span style="color:var(--floor-clr,#d97706);font-weight:700">⚠ Brand/PM Type changed — a new code will be generated on save.</span>';
  } else {
    codeFld.value = origCode;
    if(hint) hint.textContent = 'Code regenerates automatically when Brand or PM Type changes.';
  }
}


// ── epRegenerateCode (originally L3138..L3156) ─────────────────────────
function epRegenerateCode(){
  const codeFld = document.getElementById('ep-code');
  if(!codeFld) return;
  const brandId = parseInt(document.getElementById('ep-brand')?.value)||0;
  const pm      = (document.getElementById('ep-pm')?.value || '').trim();
  const brand   = (_brands||[]).find(b => b.id === brandId);
  if(!brand || !pm){
    showToast('Pick Brand and PM Type first','error'); return;
  }
  codeFld.value = _buildPreviewCode(brand.name, pm);
  // Force "changed" state so save will persist new code
  codeFld.dataset.origCode = '';
  const hint = document.getElementById('ep-code-hint');
  if(hint) hint.innerHTML = '<span style="color:var(--floor-clr,#d97706);font-weight:700">⚠ A new code will be assigned on save.</span>';
}

// ADMIN-ONLY: Regenerate product codes for the currently selected products.
// Called from the "Update Code" button in the Products tab toolbar.
// Touches only product_code on the server — never brand_id or anything else.

// ── regenerateSelectedProductCodes (originally L3157..L3221) ─────────────────────────
async function regenerateSelectedProductCodes(){
  const ids = Object.keys(_selectedProd).map(x => parseInt(x)).filter(n => n > 0);
  if(!ids.length){ showToast('Select one or more products first','info'); return; }

  // Surface what will and won't get a code, so admin sees consequences before confirming.
  const eligible = ids.filter(id => {
    const p = _products.find(x => x.id === id);
    return p && p.brand_id && (p.brand_name || '').trim() && (p.pm_type || '').trim();
  });
  const noBrand = ids.length - eligible.length;

  let warning = '';
  const haveCodes = ids.filter(id => {
    const p = _products.find(x => x.id === id);
    return p && (p.product_code || '').trim();
  });
  if(haveCodes.length){
    warning = `\n\n⚠ ${haveCodes.length} of these already have a code — those codes will be REPLACED.`;
  }

  if(!confirm(
      `Generate / regenerate product codes for ${ids.length} selected product(s)?\n\n` +
      `• ${eligible.length} will be processed\n` +
      `• ${noBrand} will be skipped (no brand assigned)` +
      warning +
      `\n\nThis only changes the product code. Brand and other fields are not touched.`
  )) return;

  const btn = document.getElementById('prodCodeRegenBtn');
  const orig = btn ? btn.innerHTML : '';
  if(btn){
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating…';
    btn.disabled  = true;
  }
  try {
    const res = await fetch('/api/pm_stock/products/regenerate_codes', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({product_ids: ids})
    });
    const d = await res.json();
    if(d.status === 'ok'){
      let msg = `✓ Updated ${d.generated} product code${d.generated===1?'':'s'}`;
      if(d.skipped_no_brand) msg += ` · ${d.skipped_no_brand} skipped (no brand)`;
      if(d.failed)           msg += ` · ${d.failed} failed`;
      showToast(msg, (d.failed || d.skipped_no_brand) ? 'info' : 'success', 5000);
      // Print error detail to console so admin can investigate failures
      if(d.errors && d.errors.length){
        console.warn('[product-code regenerate] issues:', d.errors);
      }
      await loadProducts();
    } else {
      showToast(d.message || 'Failed to update codes','error');
    }
  } catch(e){
    showToast('Error: ' + e.message, 'error');
  } finally {
    if(btn){ btn.innerHTML = orig; btn.disabled = false; }
  }
}

/* ═══════════════════════════════════════════════════════════
   OPENING STOCK LABELS  (admin only)
═══════════════════════════════════════════════════════════ */


// ── openEditOpening — single location + single qty ───────────────────
function openEditOpening(productId) {
  const r = _summary.find(s => s.id === productId);
  if(!r) return;

  document.getElementById('eop-product-id').value    = productId;
  document.getElementById('eop-product-name').textContent = `${r.product_name}  ·  ${r.pm_type}${r.brand_name?' · '+r.brand_name:''}`;
  document.getElementById('eop-date').value          = new Date().toISOString().slice(0,10);
  // Stash the per-location current values so the qty box can reflect the
  // chosen location's existing opening (godown vs factory).
  window._eopRow = r;

  // Pre-select the active location (from the stock-view filter) if any.
  const godownSel = document.getElementById('eop-godown');
  const activeGodown = document.getElementById('gl-location')?.value || '';
  if(godownSel){
    if(activeGodown) godownSel.value = activeGodown;
    else godownSel.value = '';
  }
  _eopOnLocationChange();   // fill qty + label for the selected location
  document.getElementById('editOpeningModal').classList.add('open');
  setTimeout(() => document.getElementById('eop-qty')?.focus(), 60);
}

// True if a location id is a factory/floor location (client-side detect,
// mirrors the server's _is_floor_godown name/type heuristic).
function _eopIsFloor(godownId){
  const g = (_godowns||[]).find(x => String(x.id) === String(godownId));
  if(!g) return false;
  if(g.is_floor || g.godown_type === 'floor') return true;
  const n = String(g.name||'').toLowerCase();
  return n.includes('factory') || n.includes('floor');
}

// When the location changes, show that location's CURRENT opening in the
// single qty box, and colour the label godown-blue or factory-amber.
function _eopOnLocationChange(){
  const r = window._eopRow || {};
  const gid = document.getElementById('eop-godown')?.value || '';
  const isFloor = _eopIsFloor(gid);
  const label = document.getElementById('eop-qty-label');
  const qty   = document.getElementById('eop-qty');
  const hint  = document.getElementById('eop-hint');
  if(label){
    label.textContent = isFloor ? '🏗️ Factory Opening Qty' : '🏭 Godown Opening Qty';
    label.style.color = isFloor ? 'var(--floor-clr,#d97706)' : 'var(--godown-clr,#0ea5e9)';
  }
  // Reflect the existing opening for the chosen scope. The summary row gives
  // overall op / floor_op; per-godown precision comes from the server on save.
  if(qty){
    if(!gid){ qty.value = ''; }
    else if(isFloor){ qty.value = (r.floor_op != null ? r.floor_op : 0); }
    else { qty.value = (r.op != null ? r.op : 0); }
  }
  if(hint){
    hint.textContent = gid
      ? (isFloor
          ? 'Entering FACTORY (floor) opening for this location.'
          : 'Entering GODOWN opening for this location.')
      : 'Pick a location first, then enter its opening quantity.';
  }
}

// ── saveOpeningStock — one location, one qty ─────────────────────────
async function saveOpeningStock() {
  // Defensive lookups: if the page is mid-deploy (old HTML + new JS), the
  // single-entry fields may be absent. Fall back to the legacy dual fields
  // rather than crashing on null.value.
  const _val = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
  const productId  = parseInt(_val('eop-product-id'))||0;
  const godownId   = parseInt(_val('eop-godown'))||null;
  const txnDate    = _val('eop-date');

  // Preferred (v2) single qty field; fall back to legacy godown/floor inputs.
  let qtyVal = _val('eop-qty');
  if(qtyVal === null){
    // Old HTML still loaded — read whichever legacy field is present.
    const lg = _val('eop-godown-qty'); const lf = _val('eop-floor-qty');
    qtyVal = (lg && parseFloat(lg)) ? lg : (lf || 0);
    if(document.getElementById('eop-qty') === null){
      showToast('Page is out of date — please hard-refresh (Ctrl+Shift+R)','error',4000);
    }
  }
  qtyVal = parseFloat(qtyVal)||0;

  if(!productId){ showToast('Product not set','error'); return; }
  if(!godownId) { showToast('Select a location','error'); return; }
  if(!txnDate)  { showToast('Select opening date','error'); return; }

  // Route the single qty to godown or floor based on the chosen location.
  const isFloor   = _eopIsFloor(godownId);
  const godownQty = isFloor ? 0 : qtyVal;
  const floorQty  = isFloor ? qtyVal : 0;

  const btn = document.getElementById('eop-save-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if(btn){ btn.innerHTML = '<span class="spinner"></span> Saving…'; btn.disabled = true; }

  try{
    const res = await fetch('/api/pm_stock/opening/save',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({product_id:productId, godown_qty:godownQty, floor_qty:floorQty,
                            txn_date:txnDate, godown_id:godownId})
    });
    const data = await res.json();
    if(data.status==='ok'){
      showToast('✅ Opening stock updated','success');
      closeModal('editOpeningModal');
      await loadSummary();
    } else { showToast(data.message||'Error saving','error'); }
  }catch(e){ showToast('Error: '+e.message,'error'); }
  finally{ if(btn){ btn.innerHTML=origHTML; btn.disabled=false; } }
}

// ── deleteSelectedProducts (soft delete — deactivates, keeps history) ────────
async function deleteSelectedProducts(){
  const ids=Object.keys(_selectedProd).map(Number);
  if(!ids.length){showToast('Nothing selected','error');return;}
  if(!confirm(`Deactivate ${ids.length} product(s)?\n\nThis hides them and clears their stock transactions, but the product record is kept (can be restored). To remove permanently, use "Delete permanently".`)) return;
  const res=await fetch('/api/pm_stock/delete_product',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  const data=await res.json();
  if(data.status==='ok'){
    showToast(`✓ ${ids.length} product(s) deactivated`,'success');
    _products=_products.filter(p=>!_selectedProd[p.id]);
    window._products = _products;
    _selectedProd={};
    renderProductTable();
    await loadSummary();
    loadPmTypes();
  } else { showToast(data.message||'Error','error'); }
}

// ── deleteSelectedProductsPermanent (HARD delete — only if unused) ───────────
async function deleteSelectedProductsPermanent(){
  const ids=Object.keys(_selectedProd).map(Number);
  if(!ids.length){showToast('Nothing selected','error');return;}
  if(!confirm(`PERMANENTLY delete ${ids.length} product(s) from the database?\n\nThis cannot be undone. Products that have any history (boxes, transactions, or material requests) will be skipped and reported — only unused products are removed.`)) return;
  const res=await fetch('/api/pm_stock/delete_product_permanent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,confirm:true})});
  const data=await res.json();
  if(data.status!=='ok'){ showToast(data.message||'Error','error',5000); return; }

  const nDel = (data.deleted||[]).length;
  const blocked = data.blocked||[];
  if(nDel){
    showToast(`✓ ${nDel} product(s) permanently deleted`,'success');
    const delIds = {}; (data.deleted||[]).forEach(x=>delIds[x.id]=true);
    _products=_products.filter(p=>!delIds[p.id]);
    window._products = _products;
  }
  if(blocked.length){
    // Tell the user exactly why each blocked product couldn't be removed.
    const lines = blocked.map(b=>`• ${b.product_name}: has ${b.reasons.join(', ')}`).join('\n');
    showToast(`${blocked.length} product(s) kept — they have history. Use Deactivate instead.`,'warning',6000);
    alert(`These products were NOT permanently deleted because they have history:\n\n${lines}\n\nUse "Deactivate" (soft delete) for these instead.`);
  }
  _selectedProd={};
  renderProductTable();
  await loadSummary();
  loadPmTypes();
}

/* ═══════════════════════════════════════════════════════════
   WHATSAPP
═══════════════════════════════════════════════════════════ */

