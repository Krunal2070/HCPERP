/* ════ PRODUCT SEARCH COMBOBOX ════
   Rewritten: event-delegation clicks, no global _pickProd,
   focus only shows/keeps dropdown without overwriting active query.
*/
function _initProdCombo(wrap, nextSelector, onSelect) {
  // Hidden input that holds the resolved product_id. Different forms
  // use different class names (legacy carry-over) — we accept any of:
  //   .mi-product       — MTV (Material Transfer)
  //   .gi-product       — godown/floor txn entry
  //   .grn-item-product — GRN
  //   .mri-product      — Material Request (added later)
  const hidden = wrap.querySelector('.mi-product,.gi-product,.grn-item-product,.mri-product');
  const input  = wrap.querySelector('.prod-combo-input');
  const dd     = wrap.querySelector('.prod-combo-dd');
  let _idx = -1;

  function _matches(q) {
    const lq = (q||'').toLowerCase().trim();
    return (_products||[]).filter(p => {
      if (!lq) return true;
      // Match against name, PM type, AND product code so users can type
      // any of those into the picker.
      const hay = `[${p.pm_type||''}] ${p.product_name||''} ${p.product_code||''}`.toLowerCase();
      return hay.includes(lq);
    });
  }

  function _pick(p) {
    const label = `[${p.pm_type}] ${p.product_name}`;
    if (hidden) hidden.value = p.id;
    input.value = label;
    input.style.borderColor = 'var(--teal,#0d9488)';
    dd.style.display = 'none';
    dd.innerHTML = '';
    _idx = -1;
    // Find the parent row to scope the "next" selector. Same family of
    // classes as the hidden input above. .mr-item-row is the MR form.
    const row = wrap.closest('.mtv-item-row,.grn-item-row,.mr-item-row');
    const sel = nextSelector || '.mi-qty,.gi-qty,.grn-item-qty,.mri-qty';
    const qtyEl = row?.querySelector(sel);
    if (qtyEl) setTimeout(() => qtyEl.focus(), 0);
    // Optional hook: let the caller react to the chosen product (e.g. the
    // Material Request form loads available in-stock versions for it).
    if (typeof onSelect === 'function') {
      try { onSelect(p, row); } catch(_) {}
    }
  }

  const _MAX_SHOW = 50;          // cap rendered rows — big lists lag the DOM
  let _ddList = [];              // products currently shown in the dropdown

  function _render(q) {
    _idx = -1;
    const all = _matches(q);
    const list = all.slice(0, _MAX_SHOW);
    if (!all.length) {
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--muted,#9ca3af);font-style:italic">${q ? 'No products match "'+q+'"' : 'Type to search…'}</div>`;
    } else {
      const lq = (q||'').toLowerCase().trim();
      // Build the highlight regex ONCE (not per-row) — per-row RegExp
      // construction across a long list was a big part of the lag.
      let re = null;
      if (lq) {
        try { re = new RegExp('(' + lq.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')','gi'); }
        catch(_) { re = null; }
      }
      let html = list.map((p, i) => {
        const raw  = `[${p.pm_type}] ${p.product_name}`;
        const safe = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const hl   = re ? safe.replace(re, '<strong style="color:var(--teal,#0d9488);font-weight:700">$1</strong>') : safe;
        return `<div class="pcd-item" data-idx="${i}"
          style="padding:7px 12px;font-size:12px;cursor:pointer;
          border-bottom:1px solid var(--border,rgba(0,0,0,.06));
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hl}</div>`;
      }).join('');
      if (all.length > _MAX_SHOW) {
        html += `<div style="padding:6px 12px;font-size:10.5px;color:var(--muted,#9ca3af);font-style:italic;text-align:center">+${all.length - _MAX_SHOW} more — keep typing to narrow</div>`;
      }
      dd.innerHTML = html;
      // One delegated click handler instead of two listeners per row.
      _ddList = list;
    }
    dd.style.display = 'block';
  }

  function _setActive(i) {
    const rows = dd.querySelectorAll('.pcd-item');
    rows.forEach(r => r.style.background = '');
    if (i >= 0 && i < rows.length) {
      rows[i].style.background = 'var(--teal-glow,rgba(13,148,136,.12))';
      rows[i].scrollIntoView({block:'nearest'});
    }
    _idx = i;
  }

  // Debounce filtering so fast typing doesn't re-render on every keystroke.
  let _debounce = null;
  input.addEventListener('input', () => {
    if (hidden) hidden.value = '';
    input.style.borderColor = '';
    const q = input.value.trim();
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => _render(q), 110);
  });

  input.addEventListener('focus', () => {
    // On focus with an empty box, show the hint rather than rendering the
    // entire product list (which is the main source of lag). Once the user
    // types, _render kicks in.
    const q = input.value.trim();
    if (!q) {
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--muted,#9ca3af);font-style:italic">Type to search…</div>`;
      dd.style.display = 'block';
    } else {
      _render(q);
    }
  });
  input.addEventListener('blur',  () => setTimeout(() => { dd.style.display='none'; }, 160));

  // Single delegated click handler (instead of two listeners per row).
  dd.addEventListener('mousedown', e => {
    const item = e.target.closest('.pcd-item');
    if (item) e.preventDefault();   // keep focus so blur doesn't close first
  });
  dd.addEventListener('click', e => {
    const item = e.target.closest('.pcd-item');
    if (!item) return;
    const i = parseInt(item.dataset.idx, 10);
    if (!isNaN(i) && _ddList[i]) _pick(_ddList[i]);
  });

  input.addEventListener('keydown', e => {
    const rows = dd.querySelectorAll('.pcd-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); _setActive(Math.min(_idx+1, rows.length-1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _setActive(Math.max(_idx-1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (_idx >= 0 && _ddList[_idx]) _pick(_ddList[_idx]); }
    else if (e.key === 'Escape') { dd.style.display='none'; }
  });
}

function _initSupplierCombo(wrap) {
  // Supplier searchable combobox — same pattern as product combo
  // wrap: the .sup-combo-wrap element
  // hidden input gets the supplier NAME (not id), text input is the search field
  const hidden = wrap.querySelector('input[type="hidden"]');
  const input  = wrap.querySelector('.sup-combo-input');
  const dd     = wrap.querySelector('.sup-combo-dd');
  let _idx = -1;

  function _matches(q) {
    const lq = (q||'').toLowerCase().trim();
    return (_supRows||[]).filter(s =>
      !lq || (s.supplier_name||'').toLowerCase().includes(lq)
    ).slice(0, 50); // cap at 50
  }

  function _updateDetailsPanel(supplierName) {
    // Render supplier details panel, scoped to the sibling #{prefix}-sup-details div
    const prefix = wrap.id.replace('-sup-wrap','');
    const panel  = document.getElementById(prefix + '-sup-details');
    if(!panel) return;
    const nm = (supplierName || '').trim();
    if(!nm) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
    const s = (_supRows && _supRows.length ? _supRows : (window._supRows || [])).find(x =>
      (x.supplier_name || '').trim().toLowerCase() === nm.toLowerCase()
    );
    if(!s) {
      // Typed name doesn't match any cached supplier — show a hint card with a
      // "Refresh list" button so a newly-added supplier can be pulled in without
      // leaving the form. Most common cause is stale cache after adding via the + button.
      panel.style.display = '';
      panel.innerHTML = `
        <div style="padding:8px 12px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);
          border-radius:7px;font-size:11px;color:var(--floor-clr,#d97706);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:14px">ℹ️</span>
          <span style="flex:1;min-width:0"><strong>${escHtml(nm)}</strong> is not in the supplier directory.</span>
          <button type="button" onclick="_refreshSupRowsAndRender('${wrap.id}')"
            style="background:rgba(245,158,11,.15);color:var(--floor-clr,#d97706);border:1px solid rgba(245,158,11,.4);
              padding:3px 10px;border-radius:5px;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit">
            🔄 Refresh list
          </button>
          <button type="button" onclick="_dnOrGrnAddSupplier(this)" data-name="${escHtml(nm)}"
            style="background:rgba(26,115,232,.12);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.4);
              padding:3px 10px;border-radius:5px;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit">
            ➕ Add new
          </button>
        </div>`;
      return;
    }
    // Render full details card — all fields shown even when empty (with "—")
    const dash = v => (v && String(v).trim()) ? escHtml(String(v).trim()) : '<span style="color:var(--muted,#9ca3af)">—</span>';
    panel.style.display = '';
    panel.innerHTML = `
      <div style="background:linear-gradient(135deg,rgba(26,115,232,.06),rgba(26,115,232,.02));
        border:1px solid rgba(26,115,232,.25);border-radius:8px;padding:10px 12px">
        <div style="font-size:9.5px;font-weight:800;color:var(--teal,#0d9488);
          text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:6px">
          🏢 Supplier Details
          ${s.supplier_code ? `<span style="background:rgba(26,115,232,.15);color:var(--teal,#0d9488);padding:1px 7px;border-radius:10px;font-size:9px;letter-spacing:.3px">${escHtml(s.supplier_code)}</span>` : ''}
          ${s.status ? `<span style="background:${s.status==='active'?'rgba(34,197,94,.15)':'rgba(148,163,184,.2)'};color:${s.status==='active'?'#16a34a':'#64748b'};padding:1px 7px;border-radius:10px;font-size:9px;letter-spacing:.3px;text-transform:uppercase">${escHtml(s.status)}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px 14px;font-size:11px">
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Contact Person</span>${dash(s.contact_person)}</div>
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Phone</span><span style="font-family:var(--font-mono,monospace)">${dash(s.phone)}</span></div>
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Email</span>${dash(s.email)}</div>
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">GST Number</span><span style="font-family:var(--font-mono,monospace)">${dash(s.gst_number)}</span></div>
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">PAN</span><span style="font-family:var(--font-mono,monospace)">${dash(s.pan_number)}</span></div>
          <div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Payment Terms</span>${dash(s.payment_terms)}</div>
          <div style="grid-column:1/-1"><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Address</span>${dash(s.address)}</div>
          ${s.supplier_type_name ? `<div><span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;display:block">Type</span>${escHtml(s.supplier_type_name)}</div>` : ''}
        </div>
      </div>`;
  }

  function _pick(s) {
    if(hidden) hidden.value = s.supplier_name;
    input.value = s.supplier_name;
    input.style.borderColor = 'var(--teal,#0d9488)';
    dd.style.display = 'none';
    dd.innerHTML = '';
    _idx = -1;
    _updateDetailsPanel(s.supplier_name);
  }

  function _render(q) {
    _idx = -1;
    const list = _matches(q);
    if(!list.length) {
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--muted,#9ca3af);font-style:italic">${q?'No suppliers match "'+q+'"':'Type to search or use + to add…'}</div>`;
    } else {
      const lq = (q||'').toLowerCase().trim();
      dd.innerHTML = list.map((s,i) => {
        const name = escHtml(s.supplier_name||'');
        const hl = lq ? name.replace(
          new RegExp('('+lq.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),
          '<strong style="color:var(--teal,#0d9488);font-weight:700">$1</strong>'
        ) : name;
        return `<div class="pcd-item" data-idx="${i}"
          style="padding:7px 12px;font-size:12px;cursor:pointer;
          border-bottom:1px solid var(--border,rgba(0,0,0,.06));
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hl}</div>`;
      }).join('');
      dd.querySelectorAll('.pcd-item').forEach((el,i) => {
        el.addEventListener('mousedown', e => e.preventDefault());
        el.addEventListener('click', () => _pick(list[i]));
      });
    }
    dd.style.display = 'block';
  }

  function _setActive(i) {
    const rows = dd.querySelectorAll('.pcd-item');
    rows.forEach(r => r.style.background='');
    if(i>=0 && i<rows.length){
      rows[i].style.background='var(--teal-glow,rgba(13,148,136,.12))';
      rows[i].scrollIntoView({block:'nearest'});
    }
    _idx = i;
  }

  input.addEventListener('input', () => {
    // Keep hidden field in sync with the visible text.
    // If the typed text exactly matches a supplier, use the canonical name;
    // otherwise fall back to raw text so save/print never see an empty supplier.
    const currentText = (input.value || '').trim();
    const matchedSupplier = (_supRows || []).find(s =>
      (s.supplier_name || '').toLowerCase() === currentText.toLowerCase()
    );
    if(hidden) {
      hidden.value = matchedSupplier ? matchedSupplier.supplier_name : currentText;
    }
    input.style.borderColor = '';
    _render(currentText);
    _updateDetailsPanel(currentText);
  });
  input.addEventListener('focus', () => { _render(input.value.trim()); });
  input.addEventListener('blur',  () => setTimeout(() => { dd.style.display='none'; }, 160));
  input.addEventListener('keydown', e => {
    const rows = dd.querySelectorAll('.pcd-item');
    if(e.key==='ArrowDown'){ e.preventDefault(); _setActive(Math.min(_idx+1,rows.length-1)); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); _setActive(Math.max(_idx-1,0)); }
    else if(e.key==='Enter'){ e.preventDefault(); if(_idx>=0&&rows[_idx]) rows[_idx].click(); }
    else if(e.key==='Escape'){ dd.style.display='none'; }
  });

  // Populate details immediately if input already has a value
  // (happens when openEditGrn sets the text before the combo is initialised)
  if(input.value && input.value.trim()) _updateDetailsPanel(input.value.trim());
}

/* ════ SUPPLIERS ════ */
let _supRows = [], _supTypes = [], _supEditId = null;
let _supLedgerGrns = [], _supLedgerName = '';
window._supRows = _supRows;  // Expose for cross-module access; updated in loadSuppliers

/* Load supplier types into modal dropdown */
async function _loadSupTypes() {
  if(_supTypes.length) return;
  try {
    const r = await fetch('/api/pm_stock/supplier_type_assoc');
    const d = await r.json();
    _supTypes = d.types || [];
  } catch(e){ _supTypes = []; }
  // Auto-find the PM SUPPLIER type and set the hidden input
  const pmType = _supTypes.find(t => t.type_name.toUpperCase().includes('PM'));
  const hiddenInput = document.getElementById('sup-modal-type');
  if(pmType && hiddenInput) hiddenInput.value = pmType.id;
}

async function loadSuppliers() {
  // IMPORTANT: always fetch the full supplier list for the internal cache.
  // If a search term is in the Supplier Directory field, apply it client-side
  // during render — do NOT use it as a server-side filter, otherwise the cache
  // gets filtered and the GRN/Edit-GRN combos can't find suppliers that don't
  // match the stale search term.
  const tbody  = document.getElementById('supTbody');
  if(tbody) tbody.innerHTML = `<tr><td colspan="9" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;
  try {
    const url = `/api/pm_stock/suppliers`;
    console.log('[Suppliers] Fetching full cache:', url);
    const res = await fetch(url);
    console.log('[Suppliers] HTTP status:', res.status, res.statusText);
    if(!res.ok) {
      const text = await res.text();
      console.error('[Suppliers] HTTP error body:', text);
      showToast(`HTTP ${res.status}: suppliers endpoint failed. Check console.`, 'error', 8000);
      _supRows = [];
      window._supRows = _supRows;
      if(tbody) tbody.innerHTML = `<tr><td colspan="9" class="no-data" style="color:#ef4444">
        <i class="fas fa-exclamation-triangle"></i> HTTP ${res.status} — ${res.statusText}<br>
        <span style="font-size:10px">Check browser console for details. Flask may need restart after updating pm_stock_routes.py</span>
      </td></tr>`;
      return;
    }
    const d = await res.json();
    console.log('[Suppliers] Response:', d);
    _supRows = d.suppliers || [];
    window._supRows = _supRows;  // Expose for cross-module access (e.g. _updateDetailsPanel, pmGrnPrint)
    console.log('[Suppliers] Loaded', _supRows.length, 'suppliers');
    if(d.diagnostic) {
      const dx = d.diagnostic;
      console.log('[Suppliers] Diagnostic:', dx);
      if(dx.needs_config) {
        showToast(
          `⚠️ Showing all suppliers — no PM supplier types configured. Click "Associate Types" to configure.`,
          'info', 6000
        );
      } else if(_supRows.length === 0 && dx.total_suppliers > 0) {
        showToast(
          `⚠️ No suppliers returned. DB has ${dx.total_suppliers} suppliers total but the filter "${dx.filter_used}" matched zero. Check Associate Types.`,
          'error', 8000
        );
      } else if(_supRows.length === 0 && dx.total_suppliers === 0) {
        showToast(`ℹ️ No suppliers in the DB at all. Click "+ Add Supplier" to create one.`, 'info', 5000);
      }
    } else {
      console.warn('[Suppliers] No diagnostic field in response — OLD server code is running. Restart Flask after updating pm_stock_routes.py');
      showToast('⚠️ Flask not restarted — run `pkill -HUP gunicorn` or restart the app', 'info', 8000);
    }
  } catch(e){
    _supRows = [];
    window._supRows = _supRows;
    console.error('[Suppliers] Fetch threw:', e);
    showToast('Network error loading suppliers: '+e.message, 'error', 6000);
    if(tbody) tbody.innerHTML = `<tr><td colspan="9" class="no-data" style="color:#ef4444">
      <i class="fas fa-exclamation-triangle"></i> ${e.message}</td></tr>`;
  }
  _pag.suppliers = _pag.suppliers || {page:1, size:25};
  _pag.suppliers.page = 1;
  renderSuppliers();
  // Populate ledger dropdown
  const sel = document.getElementById('sup-ledger-sel');
  if(sel){
    sel.innerHTML = '<option value="">— Select Supplier —</option>' +
      _supRows.map(s=>`<option value="${escHtml(s.supplier_name)}">${escHtml(s.supplier_name)}</option>`).join('');
  }
}

function renderSuppliers() {
  const tbody  = document.getElementById('supTbody');
  if(!tbody) return;
  const status = document.getElementById('sup-status-filter')?.value || '';
  const search = (document.getElementById('sup-search')?.value || '').trim().toLowerCase();
  let rows = _supRows.slice();
  if(status) rows = rows.filter(r => r.status === status);
  if(search) {
    rows = rows.filter(r => {
      const hay = [
        r.supplier_name, r.contact_person, r.supplier_type_name,
        r.gst_number, r.pan_number, r.phone, r.email
      ].map(v => String(v || '').toLowerCase()).join(' ');
      return hay.includes(search);
    });
  }
  _pag.suppliers = _pag.suppliers || {page:1, size:25};
  const size  = _pag.suppliers.size || 25;
  const page  = _pag.suppliers.page || 1;
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total/size));
  const start = (page-1)*size;
  const slice = rows.slice(start, start+size);
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="9" class="no-data"><i class="fas fa-users"></i> No suppliers found</td></tr>`;
    document.getElementById('supPag').innerHTML = ''; return;
  }
  const ratingStars = n => n ? '⭐'.repeat(n) : '—';
  tbody.innerHTML = slice.map((r,i) => {
    const typePill = r.supplier_type_name
      ? `<span style="font-size:10px;font-weight:600;padding:1px 7px;border-radius:20px;background:rgba(99,102,241,.1);color:#5E35B1;border:1px solid rgba(99,102,241,.2)">${escHtml(r.supplier_type_name)}</span>`
      : '<span style="color:var(--muted,#9ca3af);font-size:10px">—</span>';
    const statusBadge = r.status === 'active'
      ? `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(34,197,94,.1);color:#16a34a;border:1px solid rgba(34,197,94,.25)">Active</span>`
      : `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(239,68,68,.08);color:#ef4444;border:1px solid rgba(239,68,68,.2)">Inactive</span>`;
    return `<tr style="cursor:pointer" ondblclick="openSupplierModal(${r.id})" title="Double-click to edit">
      <td style="color:var(--muted,#9ca3af)">${start+i+1}</td>
      <td class="td-name" style="font-weight:600">
        <a onclick="openSupLedgerForSupplier('${escHtml(r.supplier_name).replace(/'/g,"\\'")}');return false"
           style="color:var(--teal,#0d9488);cursor:pointer;text-decoration:none"
           title="View PM Ledger">${escHtml(r.supplier_name)}</a>
      </td>
      <td>${typePill}</td>
      <td style="font-size:11px;color:var(--muted2,#6b7280)">${escHtml(r.contact_person||'—')}</td>
      <td style="font-size:11px;font-family:var(--font-mono,monospace)">${escHtml(r.phone||'—')}</td>
      <td style="font-size:11px;font-family:var(--font-mono,monospace);color:var(--muted2,#6b7280)">${escHtml(r.gst_number||'—')}</td>
      <td style="font-size:11px;color:var(--muted2,#6b7280)">${escHtml(r.payment_type||r.payment_terms||'—')}</td>
      <td>${statusBadge}</td>
      <td style="white-space:nowrap">
        <button class="action-btn" onclick="openSupplierModal(${r.id})" title="Edit"
          style="background:rgba(26,115,232,.1);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.25)"><i class="fas fa-edit"></i></button>
        <button class="action-btn del" onclick="deleteSupplierPm(${r.id},'${escHtml(r.supplier_name).replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
  renderPag('supPag','suppliers',total,pages,page);
}

async function openSupplierModal(id) {
  await _loadSupTypes();
  _supEditId = id || null;
  const sv = (eid,v) => { const e=document.getElementById(eid); if(e) e.value=v||''; };
  document.getElementById('sup-modal-title').textContent = id ? '✏️ Edit Supplier' : '➕ Add Supplier';
  document.getElementById('sup-modal-code').textContent  = '';
  sv('sup-modal-id',''); sv('sup-modal-name','');
  // Don't clear sup-modal-type — _loadSupTypes sets it to PM SUPPLIER id
  sv('sup-modal-contact',''); sv('sup-modal-phone',''); sv('sup-modal-email','');
  sv('sup-modal-address',''); sv('sup-modal-gst',''); sv('sup-modal-pan','');
  sv('sup-modal-paytype',''); sv('sup-modal-payterms',''); sv('sup-modal-credit','');
  sv('sup-modal-lead',''); sv('sup-modal-currency','INR'); sv('sup-modal-rating','');
  sv('sup-modal-status','active');
  if(id){
    const r = _supRows.find(s=>s.id===id) || {};
    sv('sup-modal-id', r.id||'');
    sv('sup-modal-name', r.supplier_name||'');
    // Don't override type on edit — always stays PM SUPPLIER for this page
    sv('sup-modal-contact', r.contact_person||'');
    sv('sup-modal-phone', r.phone||'');
    sv('sup-modal-email', r.email||'');
    sv('sup-modal-address', r.address||'');
    sv('sup-modal-gst', r.gst_number||'');
    sv('sup-modal-pan', r.pan_number||'');
    sv('sup-modal-paytype', r.payment_type||'');
    sv('sup-modal-payterms', r.payment_terms||'');
    sv('sup-modal-credit', r.credit_days||'');
    sv('sup-modal-lead', r.lead_time_days||'');
    sv('sup-modal-currency', r.currency||'INR');
    sv('sup-modal-rating', r.rating||'');
    sv('sup-modal-status', r.status||'active');
    document.getElementById('sup-modal-code').textContent = r.supplier_code ? `Code: ${r.supplier_code}` : '';
  }
  document.getElementById('supplierModal').classList.add('open');
}

async function saveSupplierPm() {
  const gv = id => document.getElementById(id)?.value||'';
  const name = gv('sup-modal-name').trim();
  if(!name){ showToast('Supplier name required','error'); return; }
  const payload = {
    id:               gv('sup-modal-id')||null,
    supplier_name:    name,
    supplier_type_id: gv('sup-modal-type')||null,
    contact_person:   gv('sup-modal-contact'),
    phone:            gv('sup-modal-phone'),
    email:            gv('sup-modal-email'),
    address:          gv('sup-modal-address'),
    gst_number:       gv('sup-modal-gst'),
    pan_number:       gv('sup-modal-pan'),
    payment_type:     gv('sup-modal-paytype'),
    payment_terms:    gv('sup-modal-payterms'),
    credit_days:      gv('sup-modal-credit')||null,
    lead_time_days:   gv('sup-modal-lead')||null,
    currency:         gv('sup-modal-currency')||'INR',
    rating:           gv('sup-modal-rating')||null,
    status:           gv('sup-modal-status')||'active',
  };
  try {
    const res = await fetch('/api/pm_stock/suppliers/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d = await res.json();
    if(d.status==='ok'){
      showToast(`✓ Supplier ${payload.id?'updated':'added'}`,'success');
      closeModal('supplierModal');
      // Refresh cache so any open GRN/Edit modal's combo picks up the new supplier
      await loadSuppliers();
      // If a GRN modal is open with this name typed, refresh its details panel
      ['grn-sup-wrap','egrn-sup-wrap'].forEach(wrapId => {
        const wrap = document.getElementById(wrapId);
        if(!wrap) return;
        const inp = wrap.querySelector('.sup-combo-input');
        if(!inp) return;
        const current = (inp.value || '').trim();
        if(!current) return;
        // If this wrap was waiting for our newly added name, pre-fill it
        if(current.toLowerCase() === name.toLowerCase()) {
          inp.value = name; // canonical casing
          const hid = wrap.querySelector('input[type="hidden"]');
          if(hid) hid.value = name;
        }
        _refreshSupRowsAndRender(wrapId);
      });
    } else showToast(d.message||'Error','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

/* Global helper — reload suppliers from server and re-render the details panel
   for a specific combo wrap. Useful when user just added a supplier via the +
   button on a GRN form and wants the cache refreshed without leaving the form. */
async function _refreshSupRowsAndRender(wrapId) {
  const wrap = document.getElementById(wrapId);
  if(!wrap) return;
  const inp = wrap.querySelector('.sup-combo-input');
  const panel = document.getElementById(wrapId.replace('-sup-wrap','') + '-sup-details');
  if(panel) panel.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--muted,#9ca3af);text-align:center">🔄 Refreshing suppliers…</div>`;
  try {
    await loadSuppliers();
    showToast(`✓ Loaded ${(_supRows||[]).length} suppliers`, 'success', 1500);
  } catch(e){ showToast('Failed to refresh: '+e.message, 'error'); return; }
  // Re-trigger the panel renderer — look for the internal function via a synthetic input event
  if(inp) {
    // Dispatch an input event so the combo's own _updateDetailsPanel runs
    inp.dispatchEvent(new Event('input', {bubbles: true}));
  }
}

async function deleteSupplierPm(id, name) {
  if(!confirm(`Delete supplier "${name}"?\nThis does not remove linked GRNs.`)) return;
  try {
    const res = await fetch('/api/pm_stock/suppliers/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const d = await res.json();
    if(d.status==='ok'){ showToast(`✓ Supplier deleted`,'success'); loadSuppliers(); }
    else showToast(d.message||'Error','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ── Supplier Type Association (admin) ── */
async function openSupTypeAssoc() {
  document.getElementById('sup-type-assoc-list').innerHTML = '<div style="color:var(--muted,#9ca3af);font-size:12px">Loading…</div>';
  document.getElementById('supTypeAssocModal').classList.add('open');
  try {
    const res = await fetch('/api/pm_stock/supplier_type_assoc');
    const d   = await res.json();
    const types = d.types || [];
    if(!types.length){
      document.getElementById('sup-type-assoc-list').innerHTML = '<div style="color:var(--muted,#9ca3af);font-size:12px">No supplier types found. Add types in the Procurement page first.</div>';
      return;
    }
    document.getElementById('sup-type-assoc-list').innerHTML = types.map(t=>`
      <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border,rgba(0,0,0,.09));border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--surface,#fff)">
        <input type="checkbox" value="${t.id}" ${t.associated?'checked':''} style="width:15px;height:15px;accent-color:var(--teal,#0d9488)">
        <span style="font-size:12px;font-weight:600;color:var(--text,#111)">${escHtml(t.type_name)}</span>
        ${t.associated?'<span style="margin-left:auto;font-size:10px;color:var(--teal,#0d9488);font-weight:700">✓ Active</span>':''}
      </label>`).join('');
  } catch(e){
    document.getElementById('sup-type-assoc-list').innerHTML = `<div style="color:#ef4444">Error: ${e.message}</div>`;
  }
}

async function saveSupTypeAssoc() {
  const checked = [...document.querySelectorAll('#sup-type-assoc-list input[type=checkbox]:checked')].map(cb=>parseInt(cb.value));
  try {
    const res = await fetch('/api/pm_stock/supplier_type_assoc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type_ids:checked})});
    const d = await res.json();
    if(d.status==='ok'){
      showToast(`✓ Association saved — ${d.saved} type(s) linked`,'success');
      closeModal('supTypeAssocModal');
      _supTypes = []; // force reload
      loadSuppliers();
    } else showToast(d.message||'Error','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ── Supplier PM Ledger ── */
async function loadSupLedgerDropdown() {
  if(!_supRows.length) await loadSuppliers();
  // dropdown already populated by loadSuppliers
}

function openSupLedgerForSupplier(name) {
  switchTab('sup-ledger');
  setSidebarActive('sup-ledger');
  const sel = document.getElementById('sup-ledger-sel');
  if(sel){ sel.value = name; loadSupLedger(); }
}

async function loadSupLedger() {
  const name = document.getElementById('sup-ledger-sel')?.value || '';
  const body = document.getElementById('supLedgerBody');
  if(!name){
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted,#9ca3af)">Select a supplier to view their PM GRN ledger</div>';
    return;
  }
  body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted,#9ca3af)"><span class="spinner"></span> Loading…</div>`;
  try {
    const res = await fetch(`/api/pm_stock/suppliers/pm_grn_ledger?supplier=${encodeURIComponent(name)}`);
    const d   = await res.json();
    _supLedgerGrns = d.grns || [];
    _supLedgerName = name;
    renderSupLedger();
  } catch(e){ body.innerHTML = `<div style="padding:20px;color:#ef4444">Error: ${e.message}</div>`; }
}

function filterSupLedger() {
  renderSupLedger();
}

function renderSupLedger() {
  const body   = document.getElementById('supLedgerBody');
  const search = (document.getElementById('sup-ledger-search')?.value||'').toLowerCase();
  let rows     = _supLedgerGrns.slice();
  if(search) rows = rows.filter(r =>
    (r.grn_no||'').toLowerCase().includes(search) ||
    (r.location||'').toLowerCase().includes(search) ||
    (r.po_number||'').toLowerCase().includes(search)
  );

  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fd = d => { if(!d)return'—'; const p=String(d).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; };

  const totalQty  = _supLedgerGrns.reduce((s,r)=>s+parseFloat(r.total_qty||0),0);
  const totalGRNs = _supLedgerGrns.length;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div>
        <div style="font-size:18px;font-weight:800;color:var(--text,#111)">${escHtml(_supLedgerName)}</div>
        <div style="font-size:11px;color:var(--muted,#9ca3af)">PM Stock GRN Ledger</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
      <div style="padding:12px 14px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:9px;background:var(--surface,#fff)">
        <div style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Total GRNs</div>
        <div style="font-size:22px;font-weight:900;color:var(--teal,#0d9488)">${totalGRNs}</div>
      </div>
      <div style="padding:12px 14px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:9px;background:var(--surface,#fff)">
        <div style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Total Qty Received</div>
        <div style="font-size:22px;font-weight:900;color:var(--teal,#0d9488)">${fmt(totalQty)}</div>
      </div>
      <div style="padding:12px 14px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:9px;background:var(--surface,#fff)">
        <div style="font-size:9px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Showing</div>
        <div style="font-size:22px;font-weight:900;color:var(--blue,#3b82f6)">${rows.length}</div>
      </div>
    </div>`;

  if(!rows.length){
    html += `<div style="padding:40px;text-align:center;color:var(--muted,#9ca3af)"><i class="fas fa-file-invoice"></i><br>No PM GRNs found for this supplier</div>`;
  } else {
    html += `<div class="tbl-wrap"><table>
      <thead><tr>
        <th>#</th><th>GRN No.</th><th>Date</th><th>PO Ref</th>
        <th>Location</th><th class="num">Items</th><th class="num">Total Qty</th>
        <th>Remarks</th><th>By</th><th>Actions</th>
      </tr></thead>
      <tbody>` +
      rows.map((r,i) => `<tr>
        <td style="color:var(--muted,#9ca3af)">${i+1}</td>
        <td><span style="font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;color:var(--teal,#0d9488);background:rgba(26,115,232,.08);padding:1px 7px;border-radius:4px;border:1px solid rgba(26,115,232,.2)">${escHtml(r.grn_no)}</span></td>
        <td style="white-space:nowrap;font-size:12px">${fd(r.grn_date)}</td>
        <td style="font-size:11px;color:var(--muted2,#6b7280)">${r.po_number?`<span style="font-family:var(--font-mono,monospace)">${escHtml(r.po_number)}</span>`:'—'}</td>
        <td style="font-size:11px">${escHtml(r.location||'—')}</td>
        <td class="num" style="color:var(--muted2,#6b7280)">${r.item_count}</td>
        <td class="num" style="font-weight:700;color:var(--teal,#0d9488)">${fmt(r.total_qty)}</td>
        <td style="font-size:11px;color:var(--muted,#9ca3af)">${escHtml(r.remarks||'—')}</td>
        <td style="font-size:11px;color:var(--muted,#9ca3af)">${escHtml(r.created_by||'—')}</td>
        <td>
          <button class="action-btn" onclick="pmGrnPrintById(${r.id})" title="Print GRN"
            style="background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25)"><i class="fas fa-print"></i></button>
          <button class="action-btn" onclick="openEditGrn(${r.id})" title="Edit GRN"
            style="background:rgba(26,115,232,.1);color:var(--teal,#0d9488);border:1px solid rgba(26,115,232,.25)"><i class="fas fa-edit"></i></button>
        </td>
      </tr>`).join('') +
      `</tbody></table></div>`;
  }
  body.innerHTML = html;
}

/* ════ SIDEBAR ════ */
//  New design: sidebar markup uses .nav-a and lives inside <nav class="sidebar">.
//  On desktop the sidebar is permanent (CSS forces body:not(.sb-open) to act
//  like sb-open is on). On mobile (≤768px) it's a drawer that toggles via
//  body.sb-open. toggleSidebar() flips that class so the hamburger works on
//  mobile while being effectively a no-op on desktop.
var _sidebarOpen = true;
function toggleSidebar(){
  // Flip the sb-open class. Desktop and mobile share the same auto-hide
  // behavior — sidebar slides in/out via CSS, JS just toggles the class.
  document.body.classList.toggle('sb-open');
  _sidebarOpen = document.body.classList.contains('sb-open');
  // Re-start the auto-hide countdown if we just opened the sidebar.
  // If we just closed it (user hit hamburger to dismiss), kill the timer.
  if(_sidebarOpen){
    if(typeof _scheduleSidebarAutoHide === 'function') _scheduleSidebarAutoHide();
  } else {
    if(typeof _clearSidebarAutoHide === 'function') _clearSidebarAutoHide();
  }
}
function _applySidebar(){
  // Sidebar starts open on page load. The auto-hide timer below will
  // close it after 5 seconds of no interaction. Users open it again
  // by clicking the hamburger.
  document.body.classList.add('sb-open');
  _scheduleSidebarAutoHide();
}

/* ── Sidebar auto-hide timer ─────────────────────────────────────
   Closes the sidebar 5 seconds after the user stops interacting with
   it. Interactions that reset the timer:
     • Mouse enters the sidebar
     • A click anywhere inside the sidebar
     • The hamburger button is clicked (re-opens + restarts timer)
   The timer is cancelled (sidebar stays open) while the cursor is
   actually OVER the sidebar, so users reading the menu don't get
   it pulled out from under them.
*/
const _SIDEBAR_AUTOHIDE_MS = 5000;
let _sidebarHideTimer = null;
let _sidebarHovered   = false;

function _clearSidebarAutoHide(){
  if(_sidebarHideTimer){
    clearTimeout(_sidebarHideTimer);
    _sidebarHideTimer = null;
  }
}
function _scheduleSidebarAutoHide(){
  _clearSidebarAutoHide();
  // Don't schedule if the cursor is parked on the sidebar — the
  // mouseleave handler will start the timer when they leave.
  if(_sidebarHovered) return;
  _sidebarHideTimer = setTimeout(() => {
    if(_sidebarHovered) return;   // double-check at fire time
    document.body.classList.remove('sb-open');
    _sidebarOpen = false;
  }, _SIDEBAR_AUTOHIDE_MS);
}

// Hover-sensitivity: cancel auto-hide while the cursor is on the sidebar,
// resume it (with a fresh 5s window) when they leave.
document.addEventListener('DOMContentLoaded', () => {
  const sb = document.getElementById('appSidebar');
  if(!sb) return;
  sb.addEventListener('mouseenter', () => {
    _sidebarHovered = true;
    _clearSidebarAutoHide();
  });
  sb.addEventListener('mouseleave', () => {
    _sidebarHovered = false;
    if(document.body.classList.contains('sb-open')){
      _scheduleSidebarAutoHide();
    }
  });
  // A click inside the sidebar (e.g. picking a tab) also restarts the
  // timer — gives the user time to read the page before it auto-hides.
  sb.addEventListener('click', () => {
    if(document.body.classList.contains('sb-open')){
      _scheduleSidebarAutoHide();
    }
  });
});
function setSidebarActive(tabId){
  // Active state lives on .nav-a in the new design (.sidebar-item is the
  // legacy class name, still queried as a fallback for any cached pages).
  document.querySelectorAll('.nav-a[id^="sb-"], .sidebar-item[id^="sb-"]').forEach(function(el){
    el.classList.remove('active');
  });
  var el = document.getElementById('sb-'+tabId);
  if(el) el.classList.add('active');
  // No auto-hide timer — sidebar stays open permanently on desktop.
}
// Sidebar starts open and stays open on desktop. On mobile users tap the
// hamburger to toggle the drawer, which flips body.sb-open via toggleSidebar().
_applySidebar();

/* ── Helper for supplier-not-found "Add new" button ──
   Called from the hint card with data-name attribute so we avoid nested quote
   escaping inside template-literal HTML. */
window._dnOrGrnAddSupplier = function(btn) {
  const name = btn.getAttribute('data-name') || '';
  if(typeof openSupplierModal === 'function') openSupplierModal();
  const nameInput = document.getElementById('sup-modal-name');
  if(nameInput) nameInput.value = name;
};


/* ═══════════════════════════════════════════════════════════════════════════
   _refreshBannerOffset — UNIFIED stack-aware banner-offset calculator
   ─────────────────────────────────────────────────────────────────────────
   The page can have up to three sticky banners at the top, in this order:
     1. #neg-stock-banner       (negative-stock alert)
     2. #unbr-banner            (brand-missing alert)
     3. #discrepancyBanner      (transfer discrepancy alert)
   They are independently created by different modules. Each was setting its
   own top/padding values, which collided when multiple banners were visible
   simultaneously — most recently the topbar got hidden behind a stacked
   pair (e.g. unbranded above + topbar relying on --banner-offset that only
   tracked discrepancy).

   This function is the single source of truth: it measures every banner
   present, stacks them top-down, and exposes the SUM as --banner-offset.
   The topbar and sidebar (in pm_stock.html) read that variable via CSS
   `top: var(--banner-offset, 0px)` — no per-module top mutations needed.

   Each banner-creating module calls this function after creating, resizing
   or removing its banner. Idempotent and cheap.
═══════════════════════════════════════════════════════════════════════════ */
function _refreshBannerOffset(){
  // Measure each banner if present. Order matters — they stack visually
  // top-down in this same order.
  const ids = ['neg-stock-banner', 'unbr-banner', 'discrepancyBanner'];
  let cumTop = 0;
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    // Stack each banner below the previous one's bottom edge.
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.right = '0';
    el.style.top  = cumTop + 'px';
    el.style.zIndex = '9999';
    cumTop += el.offsetHeight || 0;
  });
  // Expose the total to CSS so topbar/sidebar can shift below the stack.
  if(cumTop > 0){
    document.documentElement.style.setProperty('--banner-offset', cumTop + 'px');
  } else {
    document.documentElement.style.removeProperty('--banner-offset');
  }
}
window._refreshBannerOffset = _refreshBannerOffset;

// Recompute on viewport resize — banners can wrap on narrow viewports and
// change height. ResizeObserver would be even better but isn't needed for
// such an infrequent event.
window.addEventListener('resize', () => {
  if(typeof _refreshBannerOffset === 'function') _refreshBannerOffset();
});
