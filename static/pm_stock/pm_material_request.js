/* pm_material_request.js — Material Request feature, client side.

   Lives in its own file because:
   - Self-contained (sidebar button, modal, list tab, fulfill bridge).
   - Domain-bounded so it can be removed/disabled cleanly later if the
     workflow changes substantially.

   Globals it relies on (defined elsewhere):
   - paginate(rows, gridName)               — pm_stock_main.js
   - renderPag(containerId, grid, t, p, pg) — pm_stock_main.js
   - _pag                                   — pm_stock_state.js
   - _godowns                               — pm_stock_state.js
   - _products / window._products           — pm_stock_state.js / products module
   - _initProdCombo(wrap, qtySel)           — pm_stock_combo.js (product picker)
   - showToast(msg, type, ms)               — pm_stock_main.js
   - fmtDate / fmtDateTime                  — pm_stock_main.js
   - mvOpenOutVoucher(tid)                  — pm_stock_movement.js (OUT modal)
   - api_transfer_start endpoint            — backend

   Globals it ADDS:
   - _pag.mreq                              — pagination slot
   - remreq()                               — page-button shim
   - openMrCreateModal()                    — sidebar button onclick
   - openMrFulfill(rid)                     — list "Fulfill" button onclick
   - openMrDetail(rid)                      — list "View" button onclick
   - cancelMrRequest(rid, no)               — list "Cancel" button onclick
   - mrLoadList()                           — load + render the 4th tab
   - renderMrList()                         — pagination shim target
   - refreshMrBadge()                       — sidebar+tab badge refresh

   Data flow
   ─────────
   create:    user fills modal → POST /api/pm_stock/material_request/save
              → mrLoadList() + refreshMrBadge()
   list:      mrLoadList() → GET /api/pm_stock/material_request/list
              → stash to window._mrListRows → renderMrList() with paginate.
   detail:    openMrDetail(rid) → GET /api/pm_stock/material_request/<id>
              → renders into mrDetailModal.
   fulfill:   openMrFulfill(rid) → GET /<id>/prefill_out → preloads
              window._mrPendingPrefill, opens the existing OUT modal
              via mvOpenOutCreate-equivalent. After OUT save, the backend
              save_out hook writes the link rows; we just need to refresh.
   cancel:    confirm → POST /api/pm_stock/material_request/cancel
              → mrLoadList() + refreshMrBadge()
*/

// ════════════════════════════════════════════════════════════════════
// Badge refresh — sidebar button + 4th-tab pill
// ════════════════════════════════════════════════════════════════════
async function refreshMrBadge(){
  try {
    const res = await fetch('/api/pm_stock/material_request/pending_count');
    const d = await res.json();
    if(d.status !== 'ok') return;
    const cnt = d.count || 0;
    // Sidebar button badge (added in pm_stock.html)
    const sb = document.getElementById('sb-mr-count');
    if(sb){ sb.textContent = String(cnt); sb.style.display = cnt ? '' : 'none'; }
    // 4th-tab pill (next to Material OUT/IN/History)
    const tab = document.getElementById('mm-tab-mr-count');
    if(tab){ tab.textContent = String(cnt); tab.style.display = cnt ? '' : 'none'; }
  } catch(_){}
}

// Periodic refresh — 60s while page is visible.
setTimeout(refreshMrBadge, 1200);
setInterval(() => {
  if(document.visibilityState === 'visible') refreshMrBadge();
}, 60000);


// ════════════════════════════════════════════════════════════════════
// Create-request modal
// ════════════════════════════════════════════════════════════════════
// Edit mode: when set to a request id, the create modal is in "edit" mode
// and saveMrRequest() PUTs to /update instead of /save. Reset by
// closeMrCreateModal(). Editing is only offered while status='pending'
// (no fulfilment started); the server enforces the same boundary.
let _mrEditId = null;

// Open the create modal pre-filled to EDIT an existing pending request.
// Reuses the same modal/markup as create; only the title, Save button
// label, and submit target differ.
async function openMrEdit(rid){
  try {
    const res = await fetch(`/api/pm_stock/material_request/${rid}`);
    const d = await res.json();
    if(d.status !== 'ok'){ showToast(d.message || 'Could not load request', 'error', 4000); return; }
    if((d.request.status || '') !== 'pending'){
      showToast('This request can no longer be edited — fulfilment has started.', 'error', 4500);
      if(typeof mrLoadList === 'function') mrLoadList();
      return;
    }
    // Open the (empty) create modal first — this populates godown dropdowns
    // and ensures products are loaded — then overwrite with the request's
    // values and rebuild the item rows.
    await openMrCreateModal();
    _mrEditId = rid;

    // Switch the modal chrome into edit mode.
    const titleEl = document.getElementById('mr-create-title');
    if(titleEl) titleEl.textContent = `✎ Edit Material Request · ${d.request.request_no || ''}`;
    const saveBtn = document.getElementById('mr-save-btn');
    if(saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Update Request';

    // Prefill header.
    const dateEl = document.getElementById('mr-create-date');
    if(dateEl && d.request.request_date) dateEl.value = String(d.request.request_date).slice(0,10);
    const dstSel = document.getElementById('mr-create-godown');
    if(dstSel && d.request.dest_godown_id) dstSel.value = String(d.request.dest_godown_id);
    const srcSel = document.getElementById('mr-create-source-godown');
    if(srcSel) srcSel.value = d.request.source_godown_id ? String(d.request.source_godown_id) : '';
    const remEl = document.getElementById('mr-create-remarks');
    if(remEl) remEl.value = d.request.remarks || '';

    // Rebuild item rows from the request's items.
    const c = document.getElementById('mr-create-items');
    if(c){
      c.innerHTML = '';
      (d.items || []).forEach(it => {
        mrCreateAddItem();
        const row = c.lastElementChild;
        if(!row) return;
        const hid = row.querySelector('.mri-product');
        const hidV = row.querySelector('.mri-version');
        const inp = row.querySelector('.mrpv-input');
        const qty = row.querySelector('.mri-qty');
        const rem = row.querySelector('.mri-remarks');
        const ver = (it.product_version || '').trim();
        if(hid)  hid.value  = it.product_id;
        if(hidV) hidV.value = ver;
        if(inp){
          const base = `[${it.pm_type || ''}] ${it.product_name || ('#' + it.product_id)}`;
          inp.value = ver ? `${base} · ${ver}` : base;
          inp.style.borderColor = 'var(--teal,#0d9488)';
        }
        if(qty){
          // UOM (Phase 3) — if the saved request used an alternate UOM,
          // show the user the alt value they originally typed (not the
          // converted primary). The row's dataset carries the UOM metadata
          // so save/convert math still works on re-save.
          row.dataset.primaryUom = (it.primary_uom || 'Nos');
          row.dataset.altUom     = (it.alt_uom || '');
          row.dataset.altRatio   = (it.alt_to_primary_ratio != null) ? String(it.alt_to_primary_ratio) : '';
          const _euom = (it.entered_uom || '').trim();
          const _eqty = (it.entered_qty != null) ? Number(it.entered_qty) : null;
          if(_euom && _eqty != null && _eqty > 0){
            qty.value = _eqty;
          } else {
            qty.value = it.qty_requested;
          }
          if(typeof mrUpdateRowUomUi === 'function') mrUpdateRowUomUi(row);
        }
        if(rem) rem.value = it.remarks || '';
      });
      if(!c.children.length) mrCreateAddItem();
    }
  } catch(e){
    showToast('Error: ' + e.message, 'error', 4000);
  }
}

async function openMrCreateModal(){
  document.getElementById('mrCreateModal')?.classList.add('open');
  // Default date = today
  const today = new Date().toISOString().slice(0,10);
  const dateEl = document.getElementById('mr-create-date');
  if(dateEl && !dateEl.value) dateEl.value = today;
  // Ensure products & godowns are loaded — the modal can be opened
  // from a sidebar button before the user ever visits the Products /
  // Stock tabs, in which case window._products / window._godowns are
  // still empty and the in-row product picker shows zero matches.
  // Load on demand (idempotent — no-ops if already loaded by another tab).
  try {
    if(!(window._products || []).length && typeof loadProducts === 'function'){
      await loadProducts();
    }
  } catch(_){}
  try {
    if(!(window._godowns || []).length && typeof loadGodowns === 'function'){
      await loadGodowns();
    }
  } catch(_){}

  // Populate Source + Destination godown dropdowns. Defaults:
  //   - Source      = NEW BHAYLA GODOWN  (the warehouse)
  //   - Destination = FACTORY            (the production floor)
  // Matched by name substring so renaming a godown to "New Bhayla
  // Godown - Ahmedabad" still picks up the match. If nothing matches,
  // the default option ("— Any source —" / "— Select destination —")
  // stays selected and the user picks manually.
  const godowns = (window._godowns || []);
  const findGodownId = (needles) => {
    for(const n of needles){
      const hit = godowns.find(g => (g.name || '').toUpperCase().includes(n));
      if(hit) return hit.id;
    }
    return '';
  };
  const fmtOpt = g => `<option value="${g.id}">${g.name}${g.city ? ' · '+g.city : ''}</option>`;

  const srcSel = document.getElementById('mr-create-source-godown');
  if(srcSel){
    // Populate options if not already done (idempotent across opens).
    if(!srcSel.options || srcSel.options.length <= 1){
      srcSel.innerHTML = '<option value="">— Any source —</option>' + godowns.map(fmtOpt).join('');
    }
    // ALWAYS re-apply the default on each open, since closeMrCreateModal
    // resets the value to '' between sessions. Without this, a second
    // open shows "— Any source —" even though the options are populated.
    const defaultSrc = findGodownId(['NEW BHAYLA', 'BHAYLA']);
    if(defaultSrc) srcSel.value = String(defaultSrc);
    // Setting .value programmatically does NOT fire onchange, so the cached
    // product/version options (which carry per-source stock) would otherwise
    // keep stale all-location numbers. Drop the cache so the next product
    // search re-fetches stock scoped to this source godown.
    if(typeof _mrInvalidatePVOptions === 'function') _mrInvalidatePVOptions();
  }

  const dstSel = document.getElementById('mr-create-godown');
  if(dstSel){
    if(!dstSel.options || dstSel.options.length <= 1){
      dstSel.innerHTML = '<option value="">— Select destination —</option>' + godowns.map(fmtOpt).join('');
    }
    const defaultDst = findGodownId(['FACTORY']);
    if(defaultDst) dstSel.value = String(defaultDst);
  }

  // Reset / ensure exactly one items row
  const c = document.getElementById('mr-create-items');
  if(c && !c.children.length) mrCreateAddItem();

  // Auto-focus the first product search input. Deferred to next tick so
  // the row has been mounted by mrCreateAddItem above (its own focus call
  // runs inside that function but is preempted by the modal animation;
  // this defers past both).
  setTimeout(() => {
    const inp = document.querySelector('#mr-create-items .prod-combo-input');
    if(inp) inp.focus();
  }, 100);

  // Safety fallback: if godowns hadn't loaded by the time the dropdowns
  // were populated (rare — e.g. first ever modal open on a slow connection
  // racing with the loadGodowns fetch), the dropdowns will show only the
  // placeholder option. Schedule a 500ms retry that re-runs the populate
  // + default-apply step. This is idempotent — if defaults were already
  // applied successfully on the first pass, the retry is a no-op.
  setTimeout(() => {
    const gs = (window._godowns || []);
    if(!gs.length) return;   // nothing we can do; godowns still empty
    const _findId = (needles) => {
      for(const n of needles){
        const hit = gs.find(g => (g.name || '').toUpperCase().includes(n));
        if(hit) return hit.id;
      }
      return '';
    };
    const _fmt = g => `<option value="${g.id}">${g.name}${g.city ? ' · '+g.city : ''}</option>`;
    const _src = document.getElementById('mr-create-source-godown');
    if(_src && (!_src.options || _src.options.length <= 1)){
      _src.innerHTML = '<option value="">— Any source —</option>' + gs.map(_fmt).join('');
    }
    if(_src && !_src.value && !_mrEditId){
      const ds = _findId(['NEW BHAYLA', 'BHAYLA']);
      if(ds) _src.value = String(ds);
    }
    const _dst = document.getElementById('mr-create-godown');
    if(_dst && (!_dst.options || _dst.options.length <= 1)){
      _dst.innerHTML = '<option value="">— Select destination —</option>' + gs.map(_fmt).join('');
    }
    if(_dst && !_dst.value && !_mrEditId){
      const dd = _findId(['FACTORY']);
      if(dd) _dst.value = String(dd);
    }
    // Stock-at-source might also have missed the first refresh because
    // source was empty. Fire one more if we just set it.
    if(typeof _mrRefreshStockAtSource === 'function') _mrRefreshStockAtSource();
  }, 500);

  // Load stock-at-source counts so the picker can show "(qty)" next to
  // each product. If the Source field changes later, re-fetch.
  _mrRefreshStockAtSource();
  const srcSel2 = document.getElementById('mr-create-source-godown');
  if(srcSel2 && !srcSel2._mrChangeBound){
    srcSel2.addEventListener('change', _mrRefreshStockAtSource);
    srcSel2._mrChangeBound = true;
  }
  // Install the dropdown decorator (idempotent — does nothing if already
  // installed). Watches the items container for new prod-combo-dd
  // children and appends "(qty)" badges to each row.
  _mrInstallStockDecorator();
}

// ── Stock-at-source plumbing ─────────────────────────────────────────
//
// When the requester picks a Source godown, we want to show each
// product's available qty at that godown right after its name in the
// search dropdown. This avoids the typical back-and-forth of "request
// 500 → fulfiller says only 320 available → requester re-files".
//
// _mrStockAtSource is keyed by product_id, value = qty at the currently
// selected source. Empty when no source is selected (we show no qty
// badge in that case rather than misleading totals).
window._mrStockAtSource = {};

async function _mrRefreshStockAtSource(){
  const srcSel = document.getElementById('mr-create-source-godown');
  const srcId  = srcSel?.value ? parseInt(srcSel.value) : 0;
  window._mrStockAtSource = {};
  if(!srcId){
    // No source picked → clear any existing badges
    _mrApplyStockBadges();
    return;
  }
  try {
    const res = await fetch('/api/pm_stock/summary/per_godown');
    const d   = await res.json();
    const rows = (d && (d.rows || d.products)) || [];
    const map = {};
    for(const r of rows){
      const pid = r.product_id || r.id;
      const by  = r.by_godown || {};
      // by_godown keys are stringified godown IDs in the response
      const q   = by[String(srcId)];
      if(q != null) map[pid] = Number(q) || 0;
    }
    window._mrStockAtSource = map;
  } catch(_){
    window._mrStockAtSource = {};
  }
  _mrApplyStockBadges();
}

// Walk every visible dropdown row and append/refresh the qty badge.
// Called after a stock refresh AND every time the combo's dropdown
// mutates (via the MutationObserver in _mrInstallStockDecorator).
//
// Also honors the "Non-zero stock only" checkbox: when checked, any
// row whose product has qty <= 0 at the current source is hidden
// (display:none) instead of decorated. When unchecked, all rows show.
// The hide is reversible — toggling the checkbox or changing source
// runs this function again and any previously-hidden rows reappear.
function _mrApplyStockBadges(){
  const nonZeroOnly = !!document.getElementById('mr-nonzero-only')?.checked;
  const dds = document.querySelectorAll('#mrCreateModal .prod-combo-dd');
  dds.forEach(dd => {
    dd.querySelectorAll('.pcd-item').forEach((row) => {
      // Always reset visibility — toggling off the filter should
      // restore previously-hidden rows.
      row.style.display = '';
      // Strip any prior badge so refreshes don't double-stamp.
      row.querySelector('.pcd-stockbadge')?.remove();
      // Resolve product_id from the row's index in the latest matches.
      // We don't have direct access to the products list here, but we
      // can match by visible text. _initProdCombo renders rows in the
      // order [pm_type] product_name — use that to look up product_id
      // from window._products.
      const txt = row.textContent || '';
      const m = txt.match(/^\s*\[([^\]]+)\]\s*(.+?)\s*$/);
      if(!m) return;
      const pmType = m[1].trim();
      const pname  = m[2].trim();
      const prod = (window._products || []).find(p =>
        (p.pm_type || '') === pmType && (p.product_name || '') === pname
      );
      if(!prod) return;
      const stockMap = window._mrStockAtSource || {};
      const sourceSet = Object.keys(stockMap).length > 0;
      const qty = stockMap[prod.id] || 0;
      // Apply the non-zero filter when (a) it's checked AND (b) we
      // actually have stock data (a source is selected). Without a
      // source, the filter does nothing — otherwise every product
      // would vanish, which would be confusing.
      if(nonZeroOnly && sourceSet && qty <= 0){
        row.style.display = 'none';
        return;
      }
      // If the source is unset, _mrStockAtSource is empty and we skip
      // the badge entirely (no misleading zero badges).
      if(!sourceSet) return;
      const fmt = (Number(qty) || 0).toLocaleString('en-IN');
      const color = qty > 0 ? 'var(--teal,#0d9488)' : '#9ca3af';
      const bg    = qty > 0 ? 'rgba(26,115,232,.10)' : 'rgba(148,163,184,.10)';
      const badge = document.createElement('span');
      badge.className = 'pcd-stockbadge';
      badge.style.cssText = `margin-left:8px;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;color:${color};background:${bg};font-variant-numeric:tabular-nums;letter-spacing:.2px`;
      badge.textContent = `(${fmt})`;
      row.appendChild(badge);
    });
  });
}

// Watch the items container for new prod-combo-dd elements being mounted
// (each newly-added item row creates its own dropdown) and for content
// changes inside existing dropdowns (each keystroke re-renders the dd's
// innerHTML). Whenever either happens, re-apply badges.
//
// Installed once per page load — idempotent guard via window flag.
function _mrInstallStockDecorator(){
  if(window._mrStockDecoratorInstalled) return;
  const items = document.getElementById('mr-create-items');
  if(!items) return;
  const observer = new MutationObserver((muts) => {
    let touched = false;
    for(const m of muts){
      if(m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)){
        touched = true; break;
      }
      if(m.type === 'characterData'){
        touched = true; break;
      }
    }
    if(touched){
      // Defer to next frame so the combo finishes its DOM updates
      // before we add badges (otherwise our badges get stripped by
      // the combo's innerHTML reassignment).
      requestAnimationFrame(_mrApplyStockBadges);
    }
  });
  observer.observe(items, { childList: true, subtree: true, characterData: true });
  window._mrStockDecoratorInstalled = true;
}

function closeMrCreateModal(){
  document.getElementById('mrCreateModal')?.classList.remove('open');
  // Reset edit mode + restore create-mode chrome.
  _mrEditId = null;
  const titleEl = document.getElementById('mr-create-title');
  if(titleEl) titleEl.textContent = '📝 New Material Request';
  const saveBtn = document.getElementById('mr-save-btn');
  if(saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Request';
  // Reset form
  ['mr-create-date','mr-create-godown','mr-create-source-godown','mr-create-remarks'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  const c = document.getElementById('mr-create-items'); if(c) c.innerHTML = '';
}

// ── Material Request product+version picker ───────────────────────────
// The requester picks a product *and* version in one go — each in-stock
// version is its own pickable line (e.g. "[Box] Beardo Oil · OLD DESIGN").
// Options are loaded once (cached) from product_version_options. A plain
// "(any version)" line exists for every product so unversioned/any picks
// and out-of-stock products are still requestable.
let _mrPVOptions = null;       // cached flat list
let _mrPVLoading = null;       // in-flight promise

async function _mrEnsurePVOptions(){
  if(_mrPVOptions) return _mrPVOptions;
  if(_mrPVLoading) return _mrPVLoading;
  const src = (document.getElementById('mr-create-source-godown')?.value || '').trim();
  let url = '/api/pm_stock/material_request/product_version_options';
  if(src) url += `?source_godown_id=${encodeURIComponent(src)}`;
  _mrPVLoading = fetch(url).then(r => r.json()).then(d => {
    _mrPVOptions = (d && d.status === 'ok') ? (d.options || []) : [];
    _mrPVLoading = null;
    return _mrPVOptions;
  }).catch(() => { _mrPVLoading = null; _mrPVOptions = []; return _mrPVOptions; });
  return _mrPVLoading;
}
// Source location changed → versions differ, so drop the cache.
function _mrInvalidatePVOptions(){ _mrPVOptions = null; }

function mrCreateAddItem(){
  const c = document.getElementById('mr-create-items');
  if(!c) return;
  const div = document.createElement('div');
  div.className = 'mr-item-row';
  div.style.cssText = 'display:grid;grid-template-columns:5fr 130px 0.5fr 28px;gap:6px;padding:6px 8px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));align-items:center';
  div.innerHTML = `
    <div class="mrpv-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="mri-product" value="">
      <input type="hidden" class="mri-version" value="">
      <input type="text" class="mrpv-input" placeholder="Type to search product / version…" autocomplete="off"
        style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text,#111);outline:none">
      <div class="mrpv-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <div class="mri-qty-wrap" style="display:flex;flex-direction:column;gap:2px;min-width:0">
      <div style="display:flex;gap:4px;align-items:stretch;min-width:0">
        <input type="number" class="mri-qty" min="0" step="any" placeholder="Qty *"
          oninput="if(typeof mrUpdateRowConvHint==='function')mrUpdateRowConvHint(this.closest('.mr-item-row'))"
          style="flex:1;min-width:0;background:rgba(26,115,232,.10);border:1.5px solid rgba(26,115,232,.30);border-radius:6px;padding:6px 8px;font-size:13px;font-weight:700;color:var(--teal,#0d9488);outline:none;text-align:right">
        <span class="mri-qty-uom" style="display:flex;align-items:center;padding:0 6px;font-size:10.5px;font-weight:800;color:var(--hmuted2,#6b7280);background:var(--hsurf2,#f8fafc);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;min-width:32px;justify-content:center">—</span>
      </div>
      <div class="mri-qty-hint" style="font-size:9.5px;color:var(--hmuted,#9ca3af);text-align:right;min-height:11px"></div>
    </div>
    <input type="text" class="mri-remarks" placeholder="Optional remarks"
      style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:6px 8px;font-size:12px;color:var(--text,#111);outline:none">
    <button onclick="this.closest('.mr-item-row').remove()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center">✕</button>`;
  c.appendChild(div);
  _initMrPVCombo(div.querySelector('.mrpv-wrap'));
  div.querySelector('.mrpv-input')?.focus();
}

// UOM (Phase 3) — update the qty UOM label + clear conversion hint when the
// row's product changes. Called from the picker's pick() after stashing UOM
// data on the row's dataset.
function mrUpdateRowUomUi(row){
  if(!row) return;
  const pu = (row.dataset.primaryUom || '').trim() || 'Nos';
  const au = (row.dataset.altUom || '').trim();
  const r  = parseFloat(row.dataset.altRatio);
  const hasAlt = !!(au && r > 0);
  const uomLbl = row.querySelector('.mri-qty-uom');
  // When alt is configured, the requester types in alt; otherwise in primary.
  if(uomLbl) uomLbl.textContent = hasAlt ? au : pu;
  const hint = row.querySelector('.mri-qty-hint');
  if(hint) hint.textContent = '';
  // Re-render the hint in case there's already a qty typed.
  mrUpdateRowConvHint(row);
}
window.mrUpdateRowUomUi = mrUpdateRowUomUi;

// Live conversion hint — shown only when the product has alt UOM + ratio.
// When the requester types "45000" with alt=Nos and 1 Kg = 15000 Nos, this
// shows "= 3 Kg" so they can sanity-check the conversion before saving.
function mrUpdateRowConvHint(row){
  if(!row) return;
  const hint = row.querySelector('.mri-qty-hint'); if(!hint) return;
  const pu = (row.dataset.primaryUom || '').trim() || 'Nos';
  const au = (row.dataset.altUom || '').trim();
  const r  = parseFloat(row.dataset.altRatio);
  const qtyStr = row.querySelector('.mri-qty')?.value;
  const qty = parseFloat(qtyStr);
  if(!au || !(r > 0)){ hint.textContent = ''; return; }
  if(!(qty > 0)){ hint.textContent = ''; return; }
  const primaryQty = qty / r;       // alt → primary (Tally: 1 pu = r au)
  // Limit decimals sensibly: integer if it lands on one, otherwise up to 4.
  const fmt = Math.abs(primaryQty - Math.round(primaryQty)) < 0.0005
            ? Math.round(primaryQty).toLocaleString('en-IN')
            : Number(primaryQty.toFixed(4)).toLocaleString('en-IN');
  hint.textContent = `= ${fmt} ${pu}`;
}
window.mrUpdateRowConvHint = mrUpdateRowConvHint;

// Build the product+version typeahead for one MR row.
function _initMrPVCombo(wrap){
  const hidProd = wrap.querySelector('.mri-product');
  const hidVer  = wrap.querySelector('.mri-version');
  const input   = wrap.querySelector('.mrpv-input');
  const dd      = wrap.querySelector('.mrpv-dd');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MAX = 60;
  let idx = -1, shown = [], debounce = null;

  const label = (o) => {
    const base = `[${o.pm_type||''}] ${o.product_name||''}`;
    if(o.version) return `${base} · ${o.version}`;
    return base;
  };

  function render(q){
    idx = -1;
    const opts = _mrPVOptions || [];
    const lq = (q||'').toLowerCase().trim();
    const all = !lq ? opts : opts.filter(o => label(o).toLowerCase().includes(lq) || (o.product_code||'').toLowerCase().includes(lq));
    shown = all.slice(0, MAX);
    if(!opts.length){
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">Loading products…</div>`;
    } else if(!all.length){
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">${q ? 'No match for "'+esc(q)+'"' : 'Type to search…'}</div>`;
    } else {
      // Name of the source location these stock numbers are scoped to, so the
      // "@ Location" suffix makes clear it's source-godown stock (not all-loc).
      const _srcSel = document.getElementById('mr-create-source-godown');
      const _srcName = (_srcSel && _srcSel.value && _srcSel.options[_srcSel.selectedIndex])
        ? _srcSel.options[_srcSel.selectedIndex].text.split(' · ')[0].trim() : '';
      const _atSrc = _srcName ? ` <span style="color:var(--hmuted,#9ca3af);font-size:9.5px">@ ${esc(_srcName)}</span>` : '';
      let html = shown.map((o,i) => {
        // UOM (Phase 3) — if the product has an alternate UOM with a positive
        // ratio, show stock in the alternate unit (the unit the requester
        // thinks in), with the primary shown smaller alongside for clarity.
        // Otherwise show stock in primary as before.
        const _pu = (o.primary_uom || 'Nos');
        const _au = (o.alt_uom || '').trim();
        const _r  = (o.alt_to_primary_ratio != null ? Number(o.alt_to_primary_ratio) : 0);
        const _hasAlt = !!(_au && _r > 0);
        let qtyTxt = '';
        if(o.stock_qty != null && o.stock_qty > 0){
          const primaryNum = Number(o.stock_qty);
          if(_hasAlt){
            const altNum = primaryNum * _r;     // primary × (alt-per-primary)
            qtyTxt = `<span style="color:var(--teal,#0d9488);font-size:10px;font-weight:700"> · ${altNum.toLocaleString('en-IN')} ${esc(_au)} in stock</span>`
                   + `<span style="color:var(--hmuted2,#6b7280);font-size:9.5px;margin-left:4px">(${primaryNum.toLocaleString('en-IN')} ${esc(_pu)})</span>${_atSrc}`;
          } else {
            qtyTxt = `<span style="color:var(--teal,#0d9488);font-size:10px;font-weight:700"> · ${primaryNum.toLocaleString('en-IN')} ${esc(_pu)} in stock</span>${_atSrc}`;
          }
        } else if(o.stock_qty === 0){
          qtyTxt = `<span style="color:#dc2626;font-size:10px"> · out of stock${_srcName?' @ '+esc(_srcName):''}</span>`;
        }
        const verBadge = o.version
          ? `<span style="color:#6d28d9;font-weight:700"> · 🏷️ ${esc(o.version)}</span>`
            + (o.box_count!=null ? `<span style="color:var(--hmuted,#9ca3af);font-size:10px"> (${o.box_count} box${o.box_count===1?'':'es'})</span>` : '')
          : `<span style="color:var(--hmuted,#9ca3af);font-size:10px;font-style:italic"> · any version</span>`;
        return `<div class="mrpv-item" data-idx="${i}"
          style="padding:7px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--border,rgba(0,0,0,.06));white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          [${esc(o.pm_type||'')}] ${esc(o.product_name||'')}${verBadge}${qtyTxt}</div>`;
      }).join('');
      if(all.length > MAX) html += `<div style="padding:6px 12px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-style:italic;text-align:center">+${all.length-MAX} more — keep typing</div>`;
      dd.innerHTML = html;
    }
    dd.style.display = 'block';
  }

  function pick(o){
    hidProd.value = o.product_id;
    hidVer.value  = o.version || '';
    input.value   = label(o);
    input.style.borderColor = 'var(--teal,#0d9488)';
    dd.style.display = 'none'; dd.innerHTML = '';
    idx = -1;
    // UOM (Phase 3) — stash UOM metadata on the row so saveMrRequest can
    // convert from alt→primary, and so the qty UOM label can render.
    const row = wrap.closest('.mr-item-row');
    if(row){
      row.dataset.primaryUom = (o.primary_uom || 'Nos');
      row.dataset.altUom     = (o.alt_uom || '');
      row.dataset.altRatio   = (o.alt_to_primary_ratio != null) ? String(o.alt_to_primary_ratio) : '';
    }
    if(typeof mrUpdateRowUomUi === 'function') mrUpdateRowUomUi(row);
    const qtyEl = row?.querySelector('.mri-qty');
    if(qtyEl) setTimeout(() => qtyEl.focus(), 0);
  }

  function setActive(i){
    const rows = dd.querySelectorAll('.mrpv-item');
    rows.forEach(r => r.style.background = '');
    if(i >= 0 && i < rows.length){ rows[i].style.background = 'var(--teal-glow,rgba(13,148,136,.12))'; rows[i].scrollIntoView({block:'nearest'}); }
    idx = i;
  }

  input.addEventListener('input', () => {
    hidProd.value = ''; hidVer.value = '';   // typing again clears the pick
    input.style.borderColor = '';
    const q = input.value.trim();
    if(debounce) clearTimeout(debounce);
    debounce = setTimeout(() => render(q), 90);
  });
  input.addEventListener('focus', async () => {
    await _mrEnsurePVOptions();
    render(input.value.trim());
  });
  input.addEventListener('blur', () => setTimeout(() => { dd.style.display='none'; }, 160));
  dd.addEventListener('mousedown', e => { if(e.target.closest('.mrpv-item')) e.preventDefault(); });
  dd.addEventListener('click', e => {
    const item = e.target.closest('.mrpv-item');
    if(!item) return;
    const i = parseInt(item.dataset.idx, 10);
    if(!isNaN(i) && shown[i]) pick(shown[i]);
  });
  input.addEventListener('keydown', e => {
    const rows = dd.querySelectorAll('.mrpv-item');
    if(e.key === 'ArrowDown'){ e.preventDefault(); setActive(Math.min(idx+1, rows.length-1)); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); setActive(Math.max(idx-1, 0)); }
    else if(e.key === 'Enter'){ e.preventDefault(); if(idx >= 0 && shown[idx]) pick(shown[idx]); }
    else if(e.key === 'Escape'){ dd.style.display='none'; }
  });
}

async function saveMrRequest(){
  const date = document.getElementById('mr-create-date')?.value || '';
  const godownId = document.getElementById('mr-create-godown')?.value || '';
  const sourceGodownId = document.getElementById('mr-create-source-godown')?.value || '';
  const remarks = (document.getElementById('mr-create-remarks')?.value || '').trim();
  if(!date)     { showToast('Select date', 'error'); return; }
  if(!godownId) { showToast('Select destination location', 'error'); return; }

  const items = [];
  document.querySelectorAll('#mr-create-items .mr-item-row').forEach(row => {
    const pid = parseInt(row.querySelector('.mri-product')?.value) || 0;
    const typedQty = parseFloat(row.querySelector('.mri-qty')?.value) || 0;
    const rem = (row.querySelector('.mri-remarks')?.value || '').trim();
    const ver = (row.querySelector('.mri-version')?.value || '').trim();
    // UOM (Phase 3) — if the product has an alternate UOM with a positive
    // ratio, the requester typed in the alternate unit. Convert to primary
    // (which is what stock math + fulfillment use) before sending. The
    // backend also stores entered_uom + entered_qty so the printed voucher
    // can show the conversion matrix.
    const pu = (row.dataset.primaryUom || '').trim() || 'Nos';
    const au = (row.dataset.altUom || '').trim();
    const r  = parseFloat(row.dataset.altRatio);
    const hasAlt = !!(au && r > 0);
    let qtyPrimary = typedQty;
    let entered_uom = null, entered_qty = null;
    if(hasAlt && typedQty > 0){
      qtyPrimary  = typedQty / r;     // alt → primary
      entered_uom = au;
      entered_qty = typedQty;
    }
    if(pid && qtyPrimary > 0) items.push({
      product_id: pid,
      qty_requested: qtyPrimary,
      remarks: rem,
      product_version: ver,
      entered_uom, entered_qty,
    });
  });
  if(!items.length){
    showToast('Add at least one item with qty > 0', 'error');
    return;
  }

  const btn = document.getElementById('mr-save-btn');
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.innerHTML = '<span class="spinner"></span> Saving…'; btn.disabled = true; }
  try {
    // source_godown_id is optional — sent only when user selected one
    // (the default value matches an actual godown, but if they reset
    // the field to "— Any source —" we send null and the backend
    // treats it as "fulfiller picks at OUT-creation time").
    const payload = {
      request_date: date,
      dest_godown_id: parseInt(godownId),
      remarks, items,
    };
    if(sourceGodownId) payload.source_godown_id = parseInt(sourceGodownId);

    // Edit mode → PUT to /update with the request id; else create via /save.
    const editing = !!_mrEditId;
    if(editing) payload.id = _mrEditId;
    const url = editing ? '/api/pm_stock/material_request/update'
                        : '/api/pm_stock/material_request/save';
    const res = await fetch(url, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(editing ? '✓ Request updated' : `✓ Request ${d.request_no} created`, 'success', 4000);
      closeMrCreateModal();
      // Refresh list + badge
      if(typeof mrLoadList === 'function') mrLoadList();
      refreshMrBadge();
    } else {
      showToast(d.message || (editing ? 'Update failed' : 'Save failed'), 'error', 5000);
    }
  } catch(e){
    showToast('Error: '+e.message, 'error');
  } finally {
    if(btn){ btn.innerHTML = orig; btn.disabled = false; }
  }
}


// ════════════════════════════════════════════════════════════════════
// List tab (the 4th tab next to Material OUT/IN/History)
// ════════════════════════════════════════════════════════════════════
async function mrLoadList(){
  const tbody = document.getElementById('mr-list-tbody');
  if(!tbody) return;
  // First load only: admins default to seeing ALL requests (they rarely
  // raise their own), while regular users keep the "My requests" default.
  if(!window._mrScopeInit){
    window._mrScopeInit = true;
    const _isAdmin = (typeof isAdminUser === 'function') ? !!isAdminUser() : false;
    const scopeSel = document.getElementById('mr-list-scope');
    if(scopeSel && _isAdmin) scopeSel.value = 'all';
  }
  tbody.innerHTML = `<tr><td colspan="8" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const st = (document.getElementById('mr-list-status')?.value || '').trim();
  const f  = (document.getElementById('mr-list-from')?.value   || '').trim();
  const t  = (document.getElementById('mr-list-to')?.value     || '').trim();
  const s  = (document.getElementById('mr-list-search')?.value || '').trim();
  const scope = (document.getElementById('mr-list-scope')?.value || 'mine').trim();
  if(st) params.append('status', st);
  if(f)  params.append('from_date', f);
  if(t)  params.append('to_date', t);
  if(s)  params.append('search', s);
  if(scope === 'mine') params.append('mine', '1');
  try {
    const res = await fetch('/api/pm_stock/material_request/list?' + params.toString());
    const d = await res.json();
    if(d.status !== 'ok'){
      tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${d.message||'Load failed'}</td></tr>`;
      return;
    }
    window._mrListRows = d.requests || [];
    if(_pag && _pag.mreq) _pag.mreq.page = 1;
    renderMrList();
    renderMrMyOpenBanner(d.requests || []);
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Banner for the requester: when they open the grid, summarise THEIR own
// open (pending + in_progress) requests and remind them they can pre-close
// any in_progress ones that won't continue. Hidden for users with none.
function renderMrMyOpenBanner(rows){
  const box = document.getElementById('mr-my-open-banner');
  if(!box) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const _curUser = (typeof currentUser === 'string' && currentUser) ? currentUser
                 : (window._currentUser || '');
  const _norm = s => String(s||'').trim().toLowerCase();
  if(!_curUser){ box.style.display='none'; box.innerHTML=''; return; }

  const mine = (rows||[]).filter(r =>
    _norm(r.requested_by) === _norm(_curUser) &&
    (r.status === 'pending' || r.status === 'in_progress'));
  if(!mine.length){ box.style.display='none'; box.innerHTML=''; return; }

  const pending = mine.filter(r => r.status === 'pending');
  const inprog  = mine.filter(r => r.status === 'in_progress');

  const chip = (r) => {
    const c = r.status === 'in_progress' ? '#3b82f6' : '#f59e0b';
    return `<button onclick="openMrDetail(${r.id})" title="Open ${esc(r.request_no)}"
      style="display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid ${c}55;
      color:${c};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;
      font-family:inherit;margin:2px 3px 2px 0">
      <span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block"></span>
      ${esc(r.request_no)}</button>`;
  };

  const parts = [];
  if(inprog.length) parts.push(`<strong>${inprog.length}</strong> in progress`);
  if(pending.length) parts.push(`<strong>${pending.length}</strong> pending`);

  box.style.display = 'block';
  box.innerHTML = `
    <div style="margin:0 0 12px;padding:12px 14px;border-radius:10px;
      background:linear-gradient(135deg,rgba(70,72,212,.06),rgba(129,39,207,.04));
      border:1px solid rgba(70,72,212,.18)">
      <div style="font-size:12.5px;font-weight:800;color:#3730a3;display:flex;align-items:center;gap:7px">
        <span>📋</span><span>You have ${parts.join(' and ')} request${mine.length>1?'s':''}.</span>
      </div>
      <div style="margin-top:7px">
        ${inprog.map(chip).join('')}${pending.map(chip).join('')}
      </div>
      ${inprog.length ? `<div style="margin-top:9px;font-size:11px;color:#6d28d9;
        background:rgba(109,40,217,.08);border-left:3px solid #7c3aed;border-radius:5px;padding:7px 10px">
        ⏹ <strong>Tip:</strong> If an in-progress request isn't going to continue anymore,
        you can <strong>pre-close</strong> it — open the request and use the Pre-close button.
        Whatever was already fulfilled stays; the rest is marked no longer needed.
      </div>` : ''}
    </div>`;
}

function mrClearListFilters(){
  ['mr-list-scope','mr-list-status','mr-list-from','mr-list-to','mr-list-search'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    // Scope defaults to "mine", status to "open"; date/search blank.
    if(id === 'mr-list-scope') el.value = 'mine';
    else if(id === 'mr-list-status') el.value = 'open';
    else el.value = '';
  });
  mrLoadList();
}

// Paginated renderer for the 4th tab. Reads window._mrListRows.
function renderMrList(){
  const tbody = document.getElementById('mr-list-tbody');
  if(!tbody) return;
  const rows = window._mrListRows || [];
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">No material requests yet.</td></tr>`;
    const pag = document.getElementById('mreqPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statusBadge = (s) => {
    const m = {
      pending:     ['#f59e0b','Pending'],
      in_progress: ['#3b82f6','In Progress'],
      fulfilled:   ['#16a34a','Fulfilled'],
      cancelled:   ['#6b7280','Cancelled'],
      closed:      ['#7c3aed','Closed'],
    };
    const [c, lbl] = m[s] || ['#6b7280', s || '—'];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${c}1a;color:${c};border:1px solid ${c}44">${lbl}</span>`;
  };
  const p = paginate(rows, 'mreq');
  tbody.innerHTML = p.slice.map(r => {
    const req = Number(r.total_requested) || 0;
    const ful = Number(r.total_fulfilled) || 0;
    const rawPct = req > 0 ? Math.round((ful/req)*100) : 0;
    const isFulfilled = (r.status === 'fulfilled');
    // The aggregate can read 100% while an individual item is still short
    // (over-delivery on one line, shortfall on another), which would wrongly
    // show a full green bar next to an "In Progress" status. So the bar only
    // goes full-green when the request is ACTUALLY fulfilled; otherwise it's
    // capped just under full and kept blue/amber to match the real status.
    const pct = isFulfilled ? 100 : Math.min(98, Math.max(0, rawPct));
    const barColor = isFulfilled ? '#16a34a' : (ful > 0 ? '#3b82f6' : '#f59e0b');
    const overNote = (!isFulfilled && rawPct >= 100)
      ? ' <span title="Totals match but an item is still short — see detail" style="color:#d97706;font-weight:700">⚠</span>'
      : '';
    const progress = `
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;min-width:60px;height:6px;background:rgba(0,0,0,.07);border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${barColor}"></div>
        </div>
        <div style="font-size:10px;color:var(--hmuted2,#6b7280);white-space:nowrap;font-variant-numeric:tabular-nums">${fmtN(ful)} / ${fmtN(req)}${overNote}</div>
      </div>`;
    const isOpen   = (r.status === 'pending' || r.status === 'in_progress');
    const isPendingZeroFul = (r.status === 'pending' && ful <= 0);
    // Cancel visibility rules:
    //   - status='pending' AND nothing fulfilled → anyone (the request owner OR an admin)
    //   - status='in_progress' → admin ONLY
    //   - status='fulfilled' / 'cancelled' → no one
    // Frontend hides the button entirely when the user isn't allowed
    // to cancel; the backend has the same matrix as a defensive check.
    const _isAdmin = (typeof isAdminUser === 'function') ? !!isAdminUser() : false;
    // Who is viewing — requester identity (used to hide Fulfill from the
    // person who raised the request; they don't fulfil their own request).
    const _curUser = (typeof currentUser === 'string' && currentUser) ? currentUser
                   : (window._currentUser || '');
    const _norm = s => String(s||'').trim().toLowerCase();
    const isRequester = _curUser && (_norm(r.requested_by) === _norm(_curUser));

    const canCancel = isPendingZeroFul
                   || (_isAdmin && r.status === 'in_progress')
                   || (_isAdmin && r.status === 'pending');
    // Fulfil is for the store/warehouse side, not the requester. Hide it from
    // the requester (unless they're also an admin, who can do anything).
    const canFulfill = isOpen && (_isAdmin || !isRequester);
    const fulfillBtn = canFulfill
      ? `<button onclick="event.stopPropagation();openMrFulfill(${r.id})" title="Open Material OUT pre-filled from this request" style="background:rgba(26,115,232,.10);border:1px solid rgba(26,115,232,.3);color:var(--teal,#0d9488);border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">📦 Fulfill</button>`
      : '';
    const cancelBtn = canCancel
      ? `<button onclick="event.stopPropagation();cancelMrRequest(${r.id},'${esc(r.request_no).replace(/'/g,'')}')" title="Cancel request${r.status==='in_progress' ? ' (admin override — fulfilment already started)' : ''}" style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">✕ Cancel${r.status==='in_progress' ? ' (admin)' : ''}</button>`
      : '';
    // Edit: only while pending (no fulfilment started) and only the
    // requester or an admin. Server enforces the same rule.
    const canEdit = (r.status === 'pending') && (_isAdmin || isRequester);
    const editBtn = canEdit
      ? `<button onclick="event.stopPropagation();openMrEdit(${r.id})" title="Edit items / details (allowed until fulfilment starts)" style="background:rgba(13,148,136,.10);border:1px solid rgba(13,148,136,.3);color:var(--teal,#0d9488);border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">✎ Edit</button>`
      : '';
    // Pre-close: end an OPEN request (pending OR in_progress) early with a
    // reason — "I don't need the rest." Requester or admin. Server enforces.
    const canClose = isOpen && (_isAdmin || isRequester);
    const closeBtn = canClose
      ? `<button onclick="event.stopPropagation();preCloseMrRequest(${r.id},'${esc(r.request_no).replace(/'/g,'')}')" title="Pre-close this request early (keeps what's already fulfilled; needs a reason)" style="background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.3);color:#7c3aed;border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">⏹ Pre-close</button>`
      : '';
    return `
    <tr>
      <td><a href="javascript:openMrDetail(${r.id})" style="font-family:monospace;font-weight:700;color:var(--teal,#0d9488);text-decoration:none">${esc(r.request_no)}</a></td>
      <td style="white-space:nowrap;font-size:11px">${esc((typeof fmtDate === 'function') ? fmtDate(r.request_date) : (r.request_date || ''))}</td>
      <td><strong>${esc(r.dest_godown_name || '—')}</strong></td>
      <td style="font-size:11px">${esc(r.requested_by || '—')}</td>
      <td style="text-align:center">${r.item_count || 0}</td>
      <td style="min-width:140px">${progress}</td>
      <td>${statusBadge(r.status)}</td>
      <td style="text-align:center;white-space:nowrap">
        <button onclick="event.stopPropagation();openMrDetail(${r.id})" title="View details" style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.3);color:#5E35B1;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">👁 View</button>
        ${editBtn}${fulfillBtn}${closeBtn}${cancelBtn}
      </td>
    </tr>`;
  }).join('');
  renderPag('mreqPag', 'mreq', p.total, p.pages, p.page);
}

// renderPag composes 're' + 'mreq' + '()' → remreq()
function remreq(){ renderMrList(); }


// ════════════════════════════════════════════════════════════════════
// Detail modal
// ════════════════════════════════════════════════════════════════════
async function openMrDetail(rid){
  document.getElementById('mrDetailModal')?.classList.add('open');
  document.getElementById('mr-detail-body').innerHTML =
    `<div style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af)">
      <span class="spinner"></span> Loading…
    </div>`;
  try {
    const res = await fetch(`/api/pm_stock/material_request/${rid}`);
    const d = await res.json();
    if(d.status !== 'ok'){
      document.getElementById('mr-detail-body').innerHTML =
        `<div style="padding:24px;color:#dc2626">Error: ${d.message||'load failed'}</div>`;
      return;
    }
    document.getElementById('mr-detail-body').innerHTML = _renderMrDetailHTML(d);
    window._mrDetailData = d;   // stash for printMrRequest()
  } catch(e){
    document.getElementById('mr-detail-body').innerHTML =
      `<div style="padding:24px;color:#dc2626">Error: ${e.message}</div>`;
  }
}

function closeMrDetailModal(){
  document.getElementById('mrDetailModal')?.classList.remove('open');
}

// Print the currently-open Material Request as a clean document. Available to
// both the fulfiller and the requester (anyone who can open the detail).
function printMrRequest(){
  const d = window._mrDetailData;
  if(!d || !d.request){ showToast('Open a request first', 'error'); return; }
  const r = d.request;
  const items = d.items || [];
  const esc2 = s => String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const dateStr = (() => {
    const s = String(r.request_date||'').slice(0,10).split('-');
    return s.length===3 ? `${s[2]}/${s[1]}/${s[0]}` : (r.request_date||'');
  })();
  const statusLabel = ({pending:'Pending',in_progress:'In Progress',fulfilled:'Fulfilled',cancelled:'Cancelled',closed:'Closed'})[r.status] || r.status || '';

  const rows = items.map((it,i) => {
    const req = Number(it.qty_requested)||0, ful = Number(it.qty_fulfilled)||0;
    // UOM (Phase 3) — show the conversion matrix when the line was entered
    // in an alternate UOM. The "requested" column shows what the user typed
    // (e.g. "45,000 Nos") with the primary-UOM equivalent below in muted
    // text (e.g. "= 3 Kg"). Lines without entered_uom render as before.
    const _euom = (it.entered_uom || '').trim();
    const _eqty = (it.entered_qty != null) ? Number(it.entered_qty) : null;
    const _pu   = (it.primary_uom || 'Nos');
    const reqCell = (_euom && _eqty != null && _eqty > 0)
      ? `<div style="font-weight:700">${fmtN(_eqty)} ${esc2(_euom)}</div>`
        + `<div style="font-size:9.5px;color:#888">= ${fmtN(req)} ${esc2(_pu)}</div>`
      : `${fmtN(req)} <span style="color:#888;font-size:10px">${esc2(_pu)}</span>`;
    const fulCell = (_euom && _eqty != null && _eqty > 0 && (it.alt_to_primary_ratio||0) > 0)
      ? `<div style="font-weight:700">${fmtN(ful * Number(it.alt_to_primary_ratio))} ${esc2(_euom)}</div>`
        + `<div style="font-size:9.5px;color:#888">= ${fmtN(ful)} ${esc2(_pu)}</div>`
      : `${fmtN(ful)} <span style="color:#888;font-size:10px">${esc2(_pu)}</span>`;
    return `<tr>
      <td style="text-align:center">${i+1}</td>
      <td>${esc2(it.product_name || ('#'+it.product_id))}${it.pm_type?` <span style="color:#666;font-size:10px">[${esc2(it.pm_type)}]</span>`:''}${it.product_version?`<br><span style="color:#6d28d9;font-size:10px;font-weight:700">🏷️ ${esc2(it.product_version)}</span>`:''}</td>
      <td style="text-align:right">${reqCell}</td>
      <td style="text-align:right">${fulCell}</td>
      <td>${esc2(it.remarks||'')}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Material Request ${esc2(r.request_no)}</title>
    <style>
      *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}
      h1{font-size:18px;margin:0 0 2px} .sub{color:#555;font-size:11px;margin-bottom:14px}
      .meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 16px;padding:10px 0;border-top:1px solid #ccc;border-bottom:1px solid #ccc}
      .meta div{font-size:11px} .meta b{display:block;color:#666;font-size:9px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
      table{width:100%;border-collapse:collapse;margin-top:6px}
      th,td{border:1px solid #bbb;padding:6px 8px;font-size:11px;vertical-align:top}
      th{background:#f0f0f0;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
      .foot{margin-top:28px;display:flex;justify-content:space-between;font-size:10px;color:#666}
      .sign{margin-top:42px;display:flex;justify-content:space-between}
      .sign div{border-top:1px solid #888;padding-top:4px;width:30%;text-align:center;font-size:10px;color:#444}
      @media print{body{margin:12mm}}
    </style></head><body>
    <h1>Material Request — ${esc2(r.request_no)}</h1>
    <div class="sub">HCP Wellness Pvt Ltd · PM Stock</div>
    <div class="meta">
      <div><b>Date</b>${esc2(dateStr)}</div>
      <div><b>Destination</b>${esc2(r.dest_godown_name||'')}</div>
      <div><b>Requested by</b>${esc2(r.requested_by||'')}</div>
      <div><b>Status</b>${esc2(statusLabel)}</div>
      <div><b>Items</b>${items.length}</div>
    </div>
    ${r.remarks?`<div style="margin-bottom:10px;font-size:11px"><b style="color:#666">Remarks:</b> ${esc2(r.remarks)}</div>`:''}
    <table>
      <thead><tr><th style="width:34px;text-align:center">#</th><th>Product</th><th style="text-align:right;width:90px">Requested</th><th style="text-align:right;width:90px">Fulfilled</th><th style="width:30%">Remarks</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#999">No items</td></tr>'}</tbody>
    </table>
    <div class="sign">
      <div>Requested By</div><div>Issued / Fulfilled By</div><div>Received By</div>
    </div>
    <div class="foot"><span>Printed: ${new Date().toLocaleString('en-IN')}</span><span>${esc2(r.request_no)}</span></div>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`;

  const w = window.open('', '_blank', 'width=900,height=700');
  if(!w){ showToast('Allow pop-ups to print', 'error', 4000); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

function _renderMrDetailHTML(d){
  const r = d.request || {};
  const items = d.items || [];
  const story = d.story || [];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const statusMap = {
    pending:     ['#f59e0b','Pending'],
    in_progress: ['#3b82f6','In Progress'],
    fulfilled:   ['#16a34a','Fulfilled'],
    cancelled:   ['#6b7280','Cancelled'],
    closed:      ['#7c3aed','Closed'],
  };
  const [sc, sl] = statusMap[r.status] || ['#6b7280', r.status || '—'];

  // Per-item removal: a requester (or admin) may remove an item whose
  // fulfilment hasn't started (qty_fulfilled === 0), even while the request
  // is in_progress because OTHER items were started. Only when the request
  // itself is still open (pending/in_progress) and more than one item exists.
  const _isAdmin = (typeof isAdminUser === 'function') ? !!isAdminUser() : false;
  const _curUser = (typeof currentUser === 'string' && currentUser) ? currentUser
                 : (window._currentUser || '');
  const _normU = s => String(s||'').trim().toLowerCase();
  const _isRequester = _curUser && (_normU(r.requested_by) === _normU(_curUser));
  const _reqOpen = (r.status === 'pending' || r.status === 'in_progress');
  const _canRemoveItems = _reqOpen && (_isAdmin || _isRequester) && items.length > 1;

  // Header
  // Layout: PM-REQ/0003/26-27  |  18/05/2026  on the left; status pill on the right.
  // The right-side "Request Date" field is gone — date now sits beside the
  // request number for tighter scanning. Format DD/MM/YYYY via fmtDate so
  // dates are uniform across all pages.
  const dateFmt = (typeof fmtDate === 'function') ? fmtDate(r.request_date) : (r.request_date || '—');
  const header = `
    <div style="padding:16px 20px;padding-right:52px;background:linear-gradient(135deg,rgba(70,72,212,.06),rgba(129,39,207,.02));border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09))">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-size:11px;color:var(--hmuted,#9ca3af);font-weight:700;letter-spacing:.5px;text-transform:uppercase">Material Request</div>
          <div style="font-size:18px;font-weight:800;font-family:monospace;color:var(--nb-primary,#4648D4);margin-top:2px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
            <span>${esc(r.request_no || '')}</span>
            <span style="color:var(--hmuted,#9ca3af);font-weight:600">|</span>
            <span style="font-size:14px;color:var(--htxtb,#111);font-weight:700">${esc(dateFmt)}</span>
          </div>
        </div>
        <div style="text-align:right;flex:0 0 auto">
          <span style="display:inline-block;padding:3px 12px;border-radius:4px;font-size:11px;font-weight:800;background:${sc}1a;color:${sc};border:1px solid ${sc}44;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap">${sl}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:12px;font-size:12px">
        <div><div style="font-size:9.5px;color:var(--hmuted2,#6b7280);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Requested by</div><div style="font-weight:600">${esc(r.requested_by || '—')}</div></div>
        <div><div style="font-size:9.5px;color:var(--hmuted2,#6b7280);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Destination</div><div style="font-weight:600">${esc(r.dest_godown_name || '—')}</div></div>
      </div>
      ${r.remarks ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(0,0,0,.03);border-radius:6px;font-size:12px;font-style:italic;color:var(--hmuted2,#6b7280)">Remarks: ${esc(r.remarks)}</div>` : ''}
      ${r.status === 'cancelled' && r.cancelled_by ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(107,114,128,.08);border-left:3px solid #6b7280;border-radius:5px;font-size:11px;color:#374151">
        Cancelled by <strong>${esc(r.cancelled_by)}</strong> on ${esc((typeof fmtDateTime === 'function') ? fmtDateTime(r.cancelled_at) : (r.cancelled_at || '—'))}${r.cancel_reason ? '. Reason: '+esc(r.cancel_reason) : '.'}
      </div>` : ''}
      ${r.status === 'closed' && r.cancelled_by ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(124,58,237,.08);border-left:3px solid #7c3aed;border-radius:5px;font-size:11px;color:#374151">
        ⏹ Pre-closed by <strong>${esc(r.cancelled_by)}</strong> on ${esc((typeof fmtDateTime === 'function') ? fmtDateTime(r.cancelled_at) : (r.cancelled_at || '—'))}${r.cancel_reason ? '. Reason: '+esc(r.cancel_reason) : '.'}
      </div>` : ''}
    </div>`;

  // Items table
  const itemsRows = items.map((it, i) => {
    const req = Number(it.qty_requested) || 0;
    const ful = Number(it.qty_fulfilled) || 0;
    const pct = req > 0 ? Math.min(100, Math.round((ful/req)*100)) : 0;
    // Remove allowed only if THIS item hasn't started (ful === 0).
    const canRemoveThis = _canRemoveItems && ful === 0;
    const actionCell = _canRemoveItems ? `
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));text-align:center;width:44px">
        ${canRemoveThis
          ? `<button title="Remove this item (not yet fulfilled)" onclick="removeMrItem(${r.id},${it.id},'${esc(String(it.product_name||'')).replace(/'/g,'')}')" style="background:rgba(220,38,38,.10);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:6px;width:26px;height:26px;cursor:pointer;font-weight:800;line-height:1;font-size:12px">✕</button>`
          : `<span title="Fulfilment started — can't remove" style="color:var(--hmuted,#cbd5e1);font-size:12px">🔒</span>`}
      </td>` : '';
    // UOM (Phase 3) — show requested in entered_uom (alt) when set, with
    // primary equivalent shown smaller. Fulfilled cell follows the same
    // shape so fulfillment progress reads in the same units.
    const _euom = (it.entered_uom || '').trim();
    const _eqty = (it.entered_qty != null) ? Number(it.entered_qty) : null;
    const _pu   = (it.primary_uom || 'Nos');
    const _r    = (it.alt_to_primary_ratio != null) ? Number(it.alt_to_primary_ratio) : 0;
    const _hasAlt = !!(_euom && _eqty != null && _eqty > 0 && _r > 0);
    const reqHtml = _hasAlt
      ? `<div>${fmtN(_eqty)} <span style="font-size:10px;color:var(--hmuted2,#6b7280)">${esc(_euom)}</span></div>
         <div style="font-size:10px;color:var(--hmuted,#9ca3af);font-weight:500">= ${fmtN(req)} ${esc(_pu)}</div>`
      : `${fmtN(req)} <span style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:500">${esc(_pu)}</span>`;
    const fulInAlt = _hasAlt ? (ful * _r) : 0;
    const fulHtml = _hasAlt
      ? `<div>${fmtN(fulInAlt)} <span style="font-size:10px;font-weight:500">${esc(_euom)}</span></div>
         <div style="font-size:10px;font-weight:500;opacity:.7">= ${fmtN(ful)} ${esc(_pu)}</div>`
      : `${fmtN(ful)} <span style="font-size:10px;font-weight:500">${esc(_pu)}</span>`;
    return `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));color:var(--hmuted,#9ca3af)">${i+1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))">
        <div style="font-weight:700;font-size:12px">${esc(it.product_name || ('#'+it.product_id))}</div>
        ${it.pm_type ? `<div style="font-size:10px;color:var(--hmuted,#9ca3af);margin-top:2px">[${esc(it.pm_type)}]</div>` : ''}
        ${it.product_version ? `<div style="display:inline-block;font-size:10px;font-weight:700;color:#6d28d9;background:rgba(109,40,217,.1);padding:1px 7px;border-radius:9px;margin-top:3px">🏷️ Version: ${esc(it.product_version)}</div>` : ''}
        ${it.remarks ? `<div style="font-size:10px;color:var(--hmuted2,#6b7280);margin-top:2px;font-style:italic">${esc(it.remarks)}</div>` : ''}
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));text-align:right;font-weight:700">${reqHtml}</td>
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));text-align:right;font-weight:700;color:${pct>=100?'#16a34a':(pct>0?'#3b82f6':'#9ca3af')}">${fulHtml}</td>
      <td style="padding:8px 10px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));min-width:120px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;min-width:50px;height:6px;background:rgba(0,0,0,.07);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${pct>=100?'#16a34a':(pct>0?'#3b82f6':'#f59e0b')}"></div>
          </div>
          <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-variant-numeric:tabular-nums">${pct}%</div>
        </div>
      </td>
      ${actionCell}
    </tr>`;
  }).join('');
  const itemsTable = `
    <div style="padding:14px 20px">
      <div style="font-size:11px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Items</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid var(--hbdr,rgba(0,0,0,.09));border-radius:6px;overflow:hidden">
        <thead>
          <tr style="background:linear-gradient(to bottom,var(--nb-surface,#f8f9fa) 0%,var(--nb-surface-2,#f1f3f4) 100%);border-bottom:1px solid var(--nb-border-strong,rgba(70,72,212,.14))">
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em;width:30px">#</th>
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em">Product</th>
            <th style="padding:11px 14px;text-align:right;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em">Requested</th>
            <th style="padding:11px 14px;text-align:right;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em">Fulfilled</th>
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em">Progress</th>
            ${_canRemoveItems ? '<th style="padding:11px 14px;text-align:center;font-size:10px;font-weight:700;color:var(--nb-text-muted,#444746);text-transform:uppercase;letter-spacing:.12em;width:44px"></th>' : ''}
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>
    </div>`;

  // Fulfillment story
  // Per-line layout:
  //   [primary]  <fulfiller> delivered <qty> of <product> via <transfer_no>
  //   [meta]     Received by <receiver> (or "Pending IN" if not yet received)
  //   [right]    <fulfilled_at DD/MM/YYYY HH:MM>  (and IN time if received)
  const storyHtml = story.length
    ? `<div style="padding:0 20px 16px">
        <div style="font-size:11px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Fulfillment History</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${story.map(s => {
            const fulAt = (typeof fmtDateTime === 'function') ? fmtDateTime(s.fulfilled_at) : (s.fulfilled_at || '');
            const rcvAt = (typeof fmtDateTime === 'function') ? fmtDateTime(s.received_at)  : (s.received_at  || '');
            const hasReceiver = !!(s.received_by && String(s.received_by).trim());
            const receiverLine = hasReceiver
              ? `Received by <strong>${esc(s.received_by)}</strong>${rcvAt ? ` on <span style="color:var(--hmuted,#9ca3af)">${esc(rcvAt)}</span>` : ''}`
              : `<span style="color:#f59e0b;font-weight:700">⏱ Awaiting IN scan</span>`;
            return `
            <div style="padding:9px 12px;background:rgba(26,115,232,.04);border-left:3px solid var(--teal,#0d9488);border-radius:5px;display:flex;gap:12px;align-items:flex-start;font-size:12px">
              <div style="flex:1;min-width:0">
                <div>
                  <strong>${esc(s.fulfilled_by || '—')}</strong> delivered
                  <strong style="color:var(--teal,#0d9488)">${fmtN(s.qty_fulfilled)}</strong>
                  of <em>${esc(s.product_name || '#'+s.product_id)}</em>
                  via <a href="javascript:_mrViewTransfer(${s.transfer_id})" style="font-family:monospace;color:var(--teal,#0d9488);text-decoration:none;font-weight:700">${esc(s.transfer_no || ('#'+s.transfer_id))}</a>
                </div>
                <div style="margin-top:3px;font-size:11px;color:var(--hmuted2,#6b7280)">${receiverLine}</div>
              </div>
              <div style="font-size:10px;color:var(--hmuted,#9ca3af);white-space:nowrap;text-align:right">${esc(fulAt)}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`
    : `<div style="padding:0 20px 16px"><div style="padding:14px;background:rgba(245,158,11,.05);border:1px dashed rgba(245,158,11,.3);border-radius:6px;font-size:11.5px;color:#92400e;text-align:center">No fulfillment activity yet. Click <strong>Fulfill</strong> on the list to send out the requested material.</div></div>`;

  return header + itemsTable + storyHtml;
}

// Forwarder — opens the transfer voucher view from the fulfillment story
function _mrViewTransfer(tid){
  if(typeof mvViewAnyVoucher === 'function'){
    // We don't know the transfer's current status without a fetch, but
    // mvViewAnyVoucher handles all states sensibly — pass 'received' as
    // a hint since fulfillment story only shows COMMITTED OUT vouchers.
    mvViewAnyVoucher(tid, 'received');
  }
}


// ════════════════════════════════════════════════════════════════════
// Fulfill flow
// ════════════════════════════════════════════════════════════════════
async function openMrFulfill(rid){
  try {
    const res = await fetch(`/api/pm_stock/material_request/${rid}/prefill_out`);
    const d = await res.json();
    if(d.status !== 'ok'){
      showToast(d.message || 'Cannot prefill OUT', 'error', 5000);
      return;
    }
    if(!(d.items || []).length){
      showToast('Nothing left to fulfill on this request', 'info');
      return;
    }
    // Stash the prefill so moutCreateVoucher() picks it up when the user
    // clicks "Create Voucher". The hidden field is just the request_id;
    // the visible side is the dest-locked dropdown + the banner.
    window._mrPendingPrefill = {
      request_id:       d.request_id,
      request_no:       d.request_no,
      dest_godown_id:   d.dest_godown_id,
      dest_godown_name: d.dest_godown_name,
      remarks:          d.remarks || '',
      items:            d.items,
    };
    // Switch to Material Movement → OUT subtab. The OUT form is a
    // permanent inline form (not a modal), so once we switch the user
    // sees the source/destination dropdowns.
    if(typeof switchTab === 'function'){ switchTab('mm'); }
    if(typeof setSidebarActive === 'function'){ try { setSidebarActive('mm'); } catch(_){} }
    if(typeof mmSwitchSubTab === 'function'){
      mmSwitchSubTab('out');
    }
    // Wait a tick so the OUT form's dropdowns are populated, then
    // pre-set the destination + a placeholder banner above the form.
    setTimeout(() => {
      const toSel = document.getElementById('mout-to');
      if(toSel){
        toSel.value = String(d.dest_godown_id);
        if(typeof moutValidateForm === 'function') moutValidateForm();
      }
      const rem = document.getElementById('mout-remarks');
      if(rem && !rem.value) rem.value = `Fulfilling Request ${d.request_no}`;
      _mrShowPrefillBannerOnOutForm(window._mrPendingPrefill);
      // Scroll the OUT form into view
      document.getElementById('mout-form-card')?.scrollIntoView({behavior:'smooth', block:'start'});
      showToast(`Pick a SOURCE location, then click "Create Voucher". Items to send: ${d.items.length}.`, 'info', 6000);
    }, 150);
  } catch(e){
    showToast('Error: '+e.message, 'error');
  }
}

// Banner shown above the OUT form (NOT inside the modal), so the user
// is aware which request they're fulfilling while they're still in the
// pre-create state. Replaced once the actual modal opens (which has
// its own _mvOutShowMrBanner).
function _mrShowPrefillBannerOnOutForm(prefill){
  if(!prefill) return;
  const host = document.getElementById('mout-form-card');
  if(!host) return;
  let banner = document.getElementById('mr-prefill-banner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'mr-prefill-banner';
    banner.style.cssText = 'margin-bottom:14px;padding:10px 14px;background:linear-gradient(135deg,rgba(26,115,232,.10),rgba(26,115,232,.02));border:1.5px solid rgba(26,115,232,.35);border-radius:8px;font-size:11.5px;color:var(--htxtb,#111)';
    host.insertBefore(banner, host.firstChild);
  }
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const itemsList = (prefill.items || []).map(it => {
    // UOM (Phase 3) — fulfiller works in primary, but if this line was
    // entered by the requester in alt UOM, show the conversion matrix:
    // "remaining qty 3 Kg (= 45,000 Nos as requested)" so the fulfiller
    // knows both the unit they handle AND the requester's intent.
    const pu  = (it.primary_uom || 'Nos');
    const au  = (it.alt_uom || '');
    const r   = (it.alt_to_primary_ratio != null) ? Number(it.alt_to_primary_ratio) : 0;
    const eu  = (it.entered_uom || '').trim();
    const hasAltLink = !!(eu && r > 0);
    const remaining = Number(it.qty)||0;
    let qtyHtml = `<strong style="color:var(--teal,#0d9488)">${fmtN(remaining)} ${pu}</strong>`;
    if(hasAltLink){
      const inAlt = remaining * r;
      const inAltFmt = Math.abs(inAlt - Math.round(inAlt)) < 0.0005
                     ? Math.round(inAlt).toLocaleString('en-IN')
                     : Number(inAlt.toFixed(4)).toLocaleString('en-IN');
      qtyHtml += ` <span style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:600">(= ${inAltFmt} ${eu} as requested)</span>`;
    }
    return `<li><strong>${it.product_name || '#'+it.product_id}</strong> — remaining qty ${qtyHtml}</li>`;
  }).join('');
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <span style="font-size:18px">📝</span>
      <div style="flex:1">
        <div style="font-size:10px;color:var(--hmuted,#9ca3af);font-weight:700;letter-spacing:.5px;text-transform:uppercase">Fulfilling Material Request</div>
        <div style="font-size:13px;font-weight:800;font-family:monospace;color:var(--teal,#0d9488)">${prefill.request_no}</div>
      </div>
      <button onclick="_mrClearPrefill()" title="Cancel fulfillment context — request_id won't be attached to the next OUT voucher" style="background:transparent;border:1px solid var(--hbdr2,rgba(0,0,0,.15));color:var(--hmuted2,#6b7280);border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">✕ Clear</button>
    </div>
    <div style="font-size:11px;color:var(--hmuted2,#6b7280);margin-bottom:4px">Destination is locked to <strong>${prefill.dest_godown_name}</strong>. Pick any source godown, create the voucher, then scan the boxes for:</div>
    <ul style="margin:4px 0 0 18px;font-size:11px;color:var(--htxtb,#111);line-height:1.6">${itemsList}</ul>`;
}

// Clears the pending prefill, removes the banner, and lets the user
// create an unlinked OUT voucher. Called by the ✕ Clear button.
function _mrClearPrefill(){
  window._mrPendingPrefill = null;
  document.getElementById('mr-prefill-banner')?.remove();
  showToast('Fulfillment context cleared. Next OUT voucher will not be linked to a request.', 'info', 4000);
}


// ════════════════════════════════════════════════════════════════════
// Cancel
// ════════════════════════════════════════════════════════════════════
async function cancelMrRequest(rid, no){
  if(!confirm(`Cancel Material Request ${no}?\nOnly allowed while status is "Pending" with nothing fulfilled.`)) return;
  const reason = prompt('Reason for cancelling (optional):', '') || '';
  try {
    const res = await fetch('/api/pm_stock/material_request/cancel', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: rid, reason })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`✓ Request ${no} cancelled`, 'success');
      mrLoadList();
      refreshMrBadge();
    } else {
      showToast(d.message || 'Cancel failed', 'error', 5000);
    }
  } catch(e){
    showToast('Error: '+e.message, 'error');
  }
}

// Pre-close a request early. Unlike cancel, this works even when partially
// fulfilled — it keeps what's been sent and marks the request 'closed'. A
// reason is REQUIRED (the backend rejects an empty reason).
// Remove a single unfulfilled item from a request (per-item, works while the
// request is in_progress as long as THIS item hasn't started).
async function removeMrItem(rid, itemId, name){
  if(!confirm(`Remove "${name || 'this item'}" from the request?\n\nOnly allowed because this item hasn't been fulfilled yet. This cannot be undone.`)) return;
  try {
    const res = await fetch('/api/pm_stock/material_request/remove_item', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ request_id: rid, item_id: itemId })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast('✓ Item removed', 'success');
      // Refresh the open detail modal + the list behind it.
      if(typeof openMrDetail === 'function') openMrDetail(rid);
      if(typeof mrLoadList === 'function') mrLoadList();
      refreshMrBadge();
    } else {
      showToast(d.message || 'Could not remove item', 'error', 5000);
    }
  } catch(e){
    showToast('Error: '+e.message, 'error');
  }
}

async function preCloseMrRequest(rid, no){
  if(!confirm(`Pre-close Material Request ${no}?\n\nThis ends the request early — whatever has already been fulfilled stays, and the remaining quantity is marked as no longer needed. This cannot be undone.`)) return;
  let reason = prompt('Reason for pre-closing this request (required):', '');
  if(reason === null) return;                 // user hit Cancel on the prompt
  reason = reason.trim();
  if(!reason){ showToast('A reason is required to pre-close.', 'error', 4000); return; }
  try {
    const res = await fetch('/api/pm_stock/material_request/close', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: rid, reason })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`✓ Request ${no} pre-closed`, 'success');
      mrLoadList();
      refreshMrBadge();
    } else {
      showToast(d.message || 'Pre-close failed', 'error', 5000);
    }
  } catch(e){
    showToast('Error: '+e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════════
// Keyboard shortcut: 'A' adds a new item row while the create modal is open
// ════════════════════════════════════════════════════════════════════
// Listens at the document level but only acts when:
//   1. The create modal is actually open (.classList contains 'open')
//   2. Focus is NOT on a text input / textarea — otherwise typing
//      letter 'a' inside the product search would fire this and add
//      a stray row instead of letting the letter through.
//   3. No modifier keys (ctrl / alt / meta) — those are reserved for
//      browser/system shortcuts.
// Press 'A' (uppercase or lowercase) to add a row, exactly like clicking
// the "+ Add Item" button.
document.addEventListener('keydown', (ev) => {
  if(ev.key !== 'a' && ev.key !== 'A') return;
  if(ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const modal = document.getElementById('mrCreateModal');
  if(!modal || !modal.classList.contains('open')) return;
  // Don't steal letter 'a' from text inputs the user is typing into.
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  ev.preventDefault();
  if(typeof mrCreateAddItem === 'function') mrCreateAddItem();
});

// ════════════════════════════════════════════════════════════════════
// gotoMrTab — sidebar navigation handler
// ════════════════════════════════════════════════════════════════════
// The sidebar "Material Request" button is the user's primary entry
// point into the feature. It used to open the create-new-request modal
// directly, but most of the time users want to SEE existing requests
// (to check status, fulfil one, or pick up where they left off) rather
// than immediately create another. This helper navigates to the MR
// sub-tab inside Material Movement, where:
//   - Pending requests are visible at the top
//   - "+ New Request" button is still one click away
//   - In-progress / fulfilled history is right below
//
// Steps:
//   1. switchTab('mm')          — open the Material Movement tab
//   2. mmSwitchSubTab('mr')     — activate the MR sub-tab inside it
//   3. setSidebarActive('mr')   — highlight the sidebar item
//
// Each function is guarded with typeof checks so a missing module
// doesn't throw — at worst the user lands on the MM tab and sees the
// default sub-tab. mrLoadList() fires inside mmSwitchSubTab so no need
// to call it here.
function gotoMrTab(){
  try {
    if(typeof switchTab === 'function')        switchTab('mm');
    if(typeof mmSwitchSubTab === 'function')   mmSwitchSubTab('mr');
    if(typeof setSidebarActive === 'function') setSidebarActive('mr');
  } catch(e){
    // Fall back to opening the create modal so the user still has a
    // way to interact with the feature even if the tab plumbing has
    // changed underneath us.
    if(typeof openMrCreateModal === 'function') openMrCreateModal();
  }
}
