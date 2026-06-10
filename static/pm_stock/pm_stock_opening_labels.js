/* pm_stock_opening_labels.js — Opening Labels modal + import + repairs */

// ── openOpeningLabelsModal (originally L3222..L3265) ─────────────────────────
function openOpeningLabelsModal(){
  // Reset all fields
  const sv = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  sv('ol-product-search', '');
  sv('ol-product-id',     '');
  sv('ol-remarks',        '');
  sv('ol-date',           new Date().toISOString().slice(0,10));
  // Reset multi-group input — start with one empty row
  window._olGroups = [{no_of_box: '', per_box_qty: ''}];
  if(typeof olRenderGroups === 'function') olRenderGroups();
  const info = document.getElementById('ol-product-info');
  if(info){ info.style.display='none'; info.innerHTML=''; }
  const totalBar = document.getElementById('ol-total-bar');
  if(totalBar) totalBar.style.display = 'none';
  // Reset eligible-product cache + close any open dropdown
  window._olEligible    = [];
  window._olHighlighted = -1;
  olHideDropdown();

  // Disable product input until a location is picked
  const psearch = document.getElementById('ol-product-search');
  if(psearch){
    psearch.disabled = true;
    psearch.placeholder = 'Pick a location first…';
    psearch.style.opacity = '.55';
  }

  // Populate godown dropdown
  const godownEl = document.getElementById('ol-godown');
  if(godownEl){
    const opts = (_godowns||[]).map(g => {
      const isFloor = (g.godown_type === 'floor' || g.is_floor);
      const label   = isFloor ? `🏭 ${g.name} (Factory)` : `📦 ${g.name}`;
      return `<option value="${g.id}">${label}</option>`;
    }).join('');
    godownEl.innerHTML = '<option value="">— Select location —</option>' + opts;
    godownEl.onchange = olOnGodownChange;
  }

  document.getElementById('openingLabelsModal').classList.add('open');
  setTimeout(() => document.getElementById('ol-godown')?.focus(), 100);
}

// Fetch eligible products for the picked location, populate the cache

// ── olOnGodownChange (originally L3266..L3323) ─────────────────────────
async function olOnGodownChange(){
  const gid = parseInt(document.getElementById('ol-godown')?.value) || 0;
  const psearch = document.getElementById('ol-product-search');
  const info    = document.getElementById('ol-product-info');
  // Reset on every godown change
  if(psearch) psearch.value = '';
  document.getElementById('ol-product-id').value = '';
  if(info){ info.style.display='none'; info.innerHTML=''; }
  window._olEligible = [];
  window._olHighlighted = -1;
  olHideDropdown();

  if(!gid){
    if(psearch){
      psearch.disabled = true;
      psearch.placeholder = 'Pick a location first…';
      psearch.style.opacity = '.55';
    }
    return;
  }
  if(psearch){
    psearch.disabled = true;
    psearch.placeholder = 'Loading eligible products…';
    psearch.style.opacity = '.55';
  }
  try {
    const res = await fetch('/api/pm_stock/opening_stock/list?godown_id=' + gid);
    const d   = await res.json();
    if(d.status !== 'ok'){
      if(typeof showToast==='function') showToast(d.message || 'Failed to load opening products','error');
      if(psearch){ psearch.disabled = true; psearch.placeholder = 'Error loading products'; }
      return;
    }
    const list = (d.products || []).filter(p => (p.product_code||'').trim());
    window._olEligible = list;
    if(!list.length){
      if(psearch){
        psearch.disabled = true;
        psearch.placeholder = 'No products with opening stock at this location';
        psearch.style.opacity = '.55';
      }
      return;
    }
    if(psearch){
      psearch.disabled = false;
      psearch.placeholder = `Type to search · ${list.length} eligible product${list.length === 1 ? '' : 's'}`;
      psearch.style.opacity = '';
      setTimeout(() => psearch.focus(), 50);
    }
    olRenderDropdown('');
  } catch(e){
    if(typeof showToast==='function') showToast('Network error: ' + e.message, 'error');
    if(psearch){ psearch.disabled = true; psearch.placeholder = 'Error loading products'; }
  }
}

// Filter the eligible list by query, render rows in the custom dropdown.
// Each row shows code, name, and three qty values: opening / labelled / remaining.

// ── olRenderDropdown (originally L3324..L3377) ─────────────────────────
function olRenderDropdown(query){
  const drop = document.getElementById('ol-product-dropdown');
  if(!drop) return;
  const list = window._olEligible || [];
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? list.filter(p =>
        (p.product_name || '').toLowerCase().includes(q) ||
        (p.product_code || '').toLowerCase().includes(q) ||
        (p.brand_name   || '').toLowerCase().includes(q))
    : list;
  if(!filtered.length){
    drop.innerHTML = `<div style="padding:14px 16px;text-align:center;font-size:11.5px;color:var(--hmuted,#9ca3af)">No matches</div>`;
    drop.style.display = 'block';
    window._olHighlighted = -1;
    window._olFiltered    = [];
    return;
  }
  // Cap to 200 visible at a time so the DOM stays light
  const cap = 200;
  const shown = filtered.slice(0, cap);
  window._olFiltered = shown;
  if(window._olHighlighted >= shown.length) window._olHighlighted = -1;
  const fmt = n => (Number(n)||0).toLocaleString('en-IN');
  drop.innerHTML = shown.map((p, i) => {
    const op_qty  = p.opening_qty   || 0;
    const lab_qty = p.labelled_qty  || 0;
    const rem_qty = p.remaining_qty || 0;
    const isHi = (i === window._olHighlighted);
    const fullyLabelled = (rem_qty <= 0 && op_qty > 0);
    return `
      <div data-idx="${i}" onclick="olPickIndex(${i})" onmouseenter="olHighlight(${i})"
        style="display:flex;align-items:center;gap:12px;padding:9px 14px;cursor:pointer;
          border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));
          background:${isHi ? 'rgba(124,58,237,.10)' : 'transparent'};
          ${fullyLabelled ? 'opacity:.6;' : ''}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:nowrap">
            <span style="font-family:monospace;font-size:10.5px;font-weight:700;color:#7c3aed;flex-shrink:0;padding-top:1px">${p.product_code}</span>
            <span style="font-size:12px;font-weight:700;color:var(--htxtb,#111);line-height:1.35;word-break:break-word">${p.product_name}</span>
          </div>
          <div style="margin-top:3px;font-size:10px;color:var(--hmuted2,#6b7280)">[${p.pm_type || '-'}] ${p.brand_name || ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;flex-shrink:0;font-family:'Sora',sans-serif;min-width:140px">
          <span style="font-size:12px;font-weight:800;color:#16a34a">${fmt(rem_qty)}</span>
          <span style="font-size:9.5px;color:var(--hmuted,#9ca3af);white-space:nowrap">${fmt(op_qty)} opening${lab_qty > 0 ? ` · ${fmt(lab_qty)} labelled` : ''}</span>
        </div>
      </div>`;
  }).join('') + (filtered.length > cap
      ? `<div style="padding:8px 12px;text-align:center;font-size:10.5px;color:var(--hmuted,#9ca3af);background:var(--hsurf2,#f8fafc)">Showing first ${cap} of ${filtered.length} — refine search to narrow</div>`
      : '');
  drop.style.display = 'block';
}


// ── olShowDropdown (originally L3378..L3380) ─────────────────────────
function olShowDropdown(){
  if((window._olEligible || []).length) olRenderDropdown(document.getElementById('ol-product-search')?.value || '');
}

// ── olHideDropdown (originally L3381..L3385) ─────────────────────────
function olHideDropdown(){
  const drop = document.getElementById('ol-product-dropdown');
  if(drop){ drop.style.display='none'; drop.innerHTML=''; }
  window._olHighlighted = -1;
}

// ── olHighlight (originally L3386..L3387) ─────────────────────────
function olHighlight(idx){ window._olHighlighted = idx; }


// ── olPickIndex (originally L3388..L3417) ─────────────────────────
function olPickIndex(idx){
  const list = window._olFiltered || [];
  const p = list[idx];
  if(!p) return;
  const psearch = document.getElementById('ol-product-search');
  const idFld   = document.getElementById('ol-product-id');
  const info    = document.getElementById('ol-product-info');
  if(psearch) psearch.value = `[${p.product_code}] ${p.product_name}`;
  if(idFld)   idFld.value   = p.id;
  if(info){
    const op_qty  = (p.opening_qty   || 0).toLocaleString('en-IN');
    const lab_qty = (p.labelled_qty  || 0).toLocaleString('en-IN');
    const rem_qty = (p.remaining_qty || 0).toLocaleString('en-IN');
    info.style.display = 'block';
    info.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
        <span style="font-family:monospace;font-weight:800;color:#7c3aed;font-size:11px">${p.product_code}</span>
        <span style="font-size:11px;font-weight:700;color:var(--htxtb,#111)">${p.product_name}</span>
        <span style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-left:auto">[${p.pm_type}] ${p.brand_name||''}</span>
      </div>
      <div style="display:flex;gap:14px;font-size:10.5px;color:var(--htxtb,#111)">
        <span>Opening: <strong>${op_qty}</strong></span>
        <span>Already labelled: <strong style="color:${(p.labelled_qty||0)>0?'#92400e':'inherit'}">${lab_qty}</strong></span>
        <span>Remaining: <strong style="color:#16a34a">${rem_qty}</strong></span>
      </div>`;
  }
  olHideDropdown();
}

// Live search & keyboard navigation

// ── olOnProductInput (originally L3418..L3426) ─────────────────────────
function olOnProductInput(){
  const inp = document.getElementById('ol-product-search');
  // Clear previously-resolved id whenever the user types again
  document.getElementById('ol-product-id').value = '';
  document.getElementById('ol-product-info').style.display = 'none';
  if(!inp) return;
  olRenderDropdown(inp.value);
}


// ── olOnProductKeydown (originally L3427..L3471) ─────────────────────────
function olOnProductKeydown(ev){
  const drop = document.getElementById('ol-product-dropdown');
  if(!drop || drop.style.display === 'none') return;
  const list = window._olFiltered || [];
  if(!list.length) return;
  if(ev.key === 'ArrowDown'){
    ev.preventDefault();
    window._olHighlighted = Math.min(list.length - 1, (window._olHighlighted ?? -1) + 1);
    olRenderDropdown(document.getElementById('ol-product-search')?.value || '');
    // Scroll the highlighted row into view
    const row = drop.querySelector(`[data-idx="${window._olHighlighted}"]`);
    if(row) row.scrollIntoView({ block: 'nearest' });
  } else if(ev.key === 'ArrowUp'){
    ev.preventDefault();
    window._olHighlighted = Math.max(0, (window._olHighlighted ?? 0) - 1);
    olRenderDropdown(document.getElementById('ol-product-search')?.value || '');
    const row = drop.querySelector(`[data-idx="${window._olHighlighted}"]`);
    if(row) row.scrollIntoView({ block: 'nearest' });
  } else if(ev.key === 'Enter'){
    if(window._olHighlighted >= 0){
      ev.preventDefault();
      olPickIndex(window._olHighlighted);
    }
  } else if(ev.key === 'Escape'){
    olHideDropdown();
  }
}

// Hide the dropdown when clicking outside the picker (but not on the row,
// which has its own onclick → olPickIndex)
document.addEventListener('click', function(e){
  const search = document.getElementById('ol-product-search');
  const drop   = document.getElementById('ol-product-dropdown');
  if(!search || !drop) return;
  if(drop.style.display === 'none') return;
  if(e.target === search) return;
  if(drop.contains(e.target)) return;
  olHideDropdown();
});

// ── Opening label "groups" — one OP label, multiple per-box-qty rows.
// Each group: { no_of_box, per_box_qty }. Render dynamic <div>s under
// #ol-groups; recompute the total bar whenever rows change.
window._olGroups = [];   // mutable list of {no_of_box, per_box_qty}


// ── olRenderGroups (originally L3472..L3511) ─────────────────────────
function olRenderGroups(){
  const wrap = document.getElementById('ol-groups');
  if(!wrap) return;
  wrap.innerHTML = '';
  if(!window._olGroups.length){
    window._olGroups.push({no_of_box: '', per_box_qty: ''});
  }
  window._olGroups.forEach((g, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 110px 30px;gap:8px;align-items:center;background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr2,rgba(0,0,0,.10));border-radius:8px;padding:8px 10px';
    const subTotal = (Number(g.no_of_box)||0) * (Number(g.per_box_qty)||0);
    row.innerHTML = `
      <div>
        <label style="font-size:9.5px;font-weight:700;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px">No. of Box</label>
        <input type="number" min="1" step="1" placeholder="5" value="${g.no_of_box || ''}"
          oninput="olOnGroupInput(${idx}, 'no_of_box', this.value)"
          style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.15));border-radius:6px;padding:7px 10px;font-size:13px;font-family:inherit;color:var(--htxtb,#111);outline:none">
      </div>
      <div>
        <label style="font-size:9.5px;font-weight:700;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px">Per Box Qty</label>
        <input type="number" min="1" step="any" placeholder="1000" value="${g.per_box_qty || ''}"
          oninput="olOnGroupInput(${idx}, 'per_box_qty', this.value)"
          style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.15));border-radius:6px;padding:7px 10px;font-size:13px;font-family:inherit;color:var(--htxtb,#111);outline:none">
      </div>
      <div style="text-align:right">
        <label style="font-size:9.5px;font-weight:700;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px">Subtotal</label>
        <div style="font-size:13px;font-weight:800;color:${subTotal>0?'#7c3aed':'var(--hmuted,#9ca3af)'};font-family:'Sora',sans-serif;padding:7px 0">${subTotal>0 ? subTotal.toLocaleString('en-IN') : '—'}</div>
      </div>
      <div style="text-align:center">
        <button type="button" onclick="olRemoveGroup(${idx})"
          ${window._olGroups.length === 1 ? 'disabled' : ''}
          title="${window._olGroups.length === 1 ? 'At least one group is required' : 'Remove this group'}"
          style="background:${window._olGroups.length === 1 ? 'rgba(0,0,0,.04)' : 'rgba(220,38,38,.08)'};border:1px solid ${window._olGroups.length === 1 ? 'rgba(0,0,0,.08)' : 'rgba(220,38,38,.30)'};color:${window._olGroups.length === 1 ? 'var(--hmuted,#cbd5e1)' : '#dc2626'};border-radius:6px;width:28px;height:28px;font-size:13px;${window._olGroups.length === 1 ? '' : 'cursor:pointer'};display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1">×</button>
      </div>
    `;
    wrap.appendChild(row);
  });
  olUpdateTotal();
}


// ── olOnGroupInput (originally L3512..L3530) ─────────────────────────
function olOnGroupInput(idx, field, value){
  if(!window._olGroups[idx]) return;
  window._olGroups[idx][field] = value;
  // Update only the subtotal cell to avoid losing input focus
  const wrap = document.getElementById('ol-groups');
  if(wrap){
    const row = wrap.children[idx];
    if(row){
      const subTotal = (Number(window._olGroups[idx].no_of_box)||0) * (Number(window._olGroups[idx].per_box_qty)||0);
      const sub = row.querySelector('div[style*="text-align:right"] > div');
      if(sub){
        sub.textContent = subTotal > 0 ? subTotal.toLocaleString('en-IN') : '—';
        sub.style.color = subTotal > 0 ? '#7c3aed' : 'var(--hmuted,#9ca3af)';
      }
    }
  }
  olUpdateTotal();
}


// ── olAddGroup (originally L3531..L3535) ─────────────────────────
function olAddGroup(){
  window._olGroups.push({no_of_box: '', per_box_qty: ''});
  olRenderGroups();
}


// ── olRemoveGroup (originally L3536..L3541) ─────────────────────────
function olRemoveGroup(idx){
  if(window._olGroups.length <= 1) return;
  window._olGroups.splice(idx, 1);
  olRenderGroups();
}


// ── olUpdateTotal (originally L3542..L3560) ─────────────────────────
function olUpdateTotal(){
  const groups = (window._olGroups || []);
  let totalBoxes = 0, totalQty = 0;
  for(const g of groups){
    const n = Number(g.no_of_box)||0;
    const p = Number(g.per_box_qty)||0;
    if(n > 0 && p > 0){ totalBoxes += n; totalQty += n * p; }
  }
  const bar = document.getElementById('ol-total-bar');
  const txt = document.getElementById('ol-total-text');
  if(!bar || !txt) return;
  if(totalBoxes > 0 && totalQty > 0){
    txt.innerHTML = `<strong>${totalBoxes}</strong> labels &nbsp;·&nbsp; total qty <strong style="color:#7c3aed">${totalQty.toLocaleString('en-IN')}</strong>`;
    bar.style.display = 'block';
  } else {
    bar.style.display = 'none';
  }
}


// ── generateOpeningLabels (originally L3561..L3613) ─────────────────────────
async function generateOpeningLabels(){
  const pid = parseInt(document.getElementById('ol-product-id')?.value)||0;
  const gid = parseInt(document.getElementById('ol-godown')?.value)||0;
  const date= document.getElementById('ol-date')?.value || '';
  const rem = document.getElementById('ol-remarks')?.value.trim() || '';

  if(!pid){ showToast('Pick a product from the list','error'); document.getElementById('ol-product-search')?.focus(); return; }
  if(!gid){ showToast('Pick a location','error'); document.getElementById('ol-godown')?.focus(); return; }

  // Validate groups
  const groups = (window._olGroups || [])
    .map(g => ({ no_of_box: parseInt(g.no_of_box)||0, per_box_qty: parseFloat(g.per_box_qty)||0 }))
    .filter(g => g.no_of_box > 0 && g.per_box_qty > 0);
  if(!groups.length){
    showToast('Enter at least one valid group (no. of box and per-box qty both > 0)','error');
    return;
  }

  const btn = document.getElementById('ol-save-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/pm_stock/opening_boxes/create',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        product_id:  pid,
        godown_id:   gid,
        groups:      groups,           // multi-group payload
        op_date:     date,
        remarks:     rem
      })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      showToast(d.message || 'Failed to generate','error', 6000);
      return;
    }
    showToast(`✓ Generated ${d.no_of_box} labels (${d.op_label}) · qty ${(d.total_qty||0).toLocaleString('en-IN')} · stock unchanged`,'success', 5000);
    closeModal('openingLabelsModal');
    // Print the labels — printOpeningLabels reads per_box_qtys for the
    // mixed-qty case and falls back to per_box_qty for the single-qty case.
    if(typeof printOpeningLabels === 'function') printOpeningLabels(d);
    else showToast('Generated, but print function not loaded','info');
  } catch(e){
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}


// ── openImportModal (originally L3614..L3643) ─────────────────────────
function openImportModal(){
  console.log('[Import] openImportModal called');
  try {
    const modal = document.getElementById('importModal');
    if(!modal) {
      alert('Import modal element #importModal not found on this page.');
      return;
    }
    const xlsInput = document.getElementById('import-xlsx');
    if(xlsInput) {
      xlsInput.value = '';
      if(!xlsInput.__prevWired) {
        xlsInput.addEventListener('change', () => {
          try { previewXlsx(); } catch(e){ console.error('[Import] preview err:', e); }
        });
        xlsInput.__prevWired = true;
      }
    }
    const preview = document.getElementById('imp-xls-preview');
    if(preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    const dateEl = document.getElementById('imp-op-date');
    if(dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
    modal.classList.add('open');
    console.log('[Import] modal opened');
  } catch(e) {
    console.error('[Import] openImportModal threw:', e);
    alert('Import modal error: ' + e.message);
  }
}


// ── downloadTemplate (originally L3644..L3701) ─────────────────────────
function downloadTemplate(){
  if(typeof XLSX==='undefined'){showToast('SheetJS not loaded','error');return;}
  // Dynamically build template: fixed cols (Sr No, Product, PM Type) + 1 col per storage location
  const locations = _apStorageGodowns(); // includes godowns + factory
  if(!locations.length){ showToast('No godowns configured — add a godown first','error'); return; }

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: PM Import Template ──
  const header = ['Sr No.', 'Name of Product', 'PM Type',
    ...locations.map(g => g.name + (g.godown_type==='floor'||g.is_floor ? ' [Factory]' : ''))];

  const sampleRows = [
    [1, 'CM-Beardo 200ml Body Wash Bottle', 'Bottle', ...locations.map((_,i)=>i===0?500:0)],
    [2, 'CM-Beardo 200ml Body Wash Cap',    'Cap',    ...locations.map((_,i)=>i===0?500:0)],
    [3, 'CM-Beardo Charcoal Body Wash 200ml Front Label', 'Front Label', ...locations.map((_,i)=>i===0?1000:0)],
    [4, '', '', ...locations.map(()=>'')],
    [5, '', '', ...locations.map(()=>'')],
  ];
  const data = [header, ...sampleRows];
  const ws = XLSX.utils.aoa_to_sheet(data);
  // Column widths
  ws['!cols'] = [{wch:8},{wch:52},{wch:18}, ...locations.map(()=>({wch:22}))];
  ws['!rows'] = Array(data.length).fill({hpt:20});
  XLSX.utils.book_append_sheet(wb, ws, 'PM Import');

  // ── Sheet 2: Instructions ──
  const instructions = [
    ['HCP Wellness — PM Stock Import Template (Multi-Godown)'], [''],
    ['COLUMN', 'DESCRIPTION', 'REQUIRED', 'EXAMPLE'],
    ['Sr No.',          'Serial number (can leave blank)',                    'No',  '1'],
    ['Name of Product', 'Full product name',                                  'YES', 'CM-Beardo 200ml Body Wash Bottle'],
    ['PM Type',         'Packaging material type',                            'YES', 'Bottle, Cap, Label, Box, Tube…'],
    ...locations.map(g => {
      const isFactory = g.godown_type==='floor' || g.is_floor;
      return [
        g.name + (isFactory?' [Factory]':''),
        `Opening balance at ${g.name} (${isFactory?'factory floor':'godown'}) — 0 if none`,
        'No',
        '500'
      ];
    }),
    [''],
    ['NOTES:'],
    ['• Existing products are skipped (matched by Product Name + PM Type)'],
    ["• Opening entries created only once per location — re-importing won't overwrite existing entries"],
    ['• Leave a location cell blank or 0 to skip opening stock for that location'],
    ['• Opening date is selected in the import modal on the portal'],
    ['• Column headers must exactly match the godown names shown above'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(instructions);
  ws2['!cols'] = [{wch:28},{wch:58},{wch:12},{wch:42}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

  XLSX.writeFile(wb, 'PM_Stock_Import_Template.xlsx');
  showToast(`✓ Template downloaded — ${locations.length} location column(s)`,'success');
}


// ── previewXlsx (originally L3702..L3751) ─────────────────────────
async function previewXlsx(){
  const file = document.getElementById('import-xlsx').files[0];
  if(!file) return;
  const preview = document.getElementById('imp-xls-preview');
  if(typeof XLSX==='undefined'){
    preview.textContent = `📄 ${file.name} ready`;
    preview.style.display = 'block';
    return;
  }
  try{
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, {type:'array'});
    const sheetName = wb.SheetNames.includes('PM Import') ? 'PM Import'
                    : wb.SheetNames.includes('MAIN SHEET') ? 'MAIN SHEET'
                    : wb.SheetNames[0];
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:0});
    if(!rows.length){ preview.textContent='⚠️ Empty sheet'; preview.style.display='block'; return; }

    // Match header columns to known godowns
    const header = rows[0].map(c => String(c||'').trim());
    const locations = _apStorageGodowns();
    const matchedCols = [];
    header.forEach((h,ci) => {
      // Strip "[Factory]" suffix for matching
      const cleanH = h.replace(/\s*\[Factory\]\s*$/i,'').trim().toLowerCase();
      const match  = locations.find(g => g.name.toLowerCase() === cleanH);
      if(match) matchedCols.push({col: ci, godown: match});
    });

    // Count valid product rows
    let valid = 0, productsWithAnyOp = 0;
    for(let i=1; i<rows.length; i++){
      const name = String(rows[i][1]||rows[i][0]||'').trim();
      if(!name || name.length < 2) continue;
      valid++;
      const hasOp = matchedCols.some(mc => (parseFloat(rows[i][mc.col])||0) > 0);
      if(hasOp) productsWithAnyOp++;
    }

    preview.innerHTML = `✅ <strong>${file.name}</strong><br>` +
      `&nbsp;&nbsp;• <strong>${valid}</strong> product rows · <strong>${productsWithAnyOp}</strong> with opening stock<br>` +
      `&nbsp;&nbsp;• <strong>${matchedCols.length}</strong> location column(s) matched: ${matchedCols.map(mc=>mc.godown.name).join(', ')||'<em style="color:#ef4444">none</em>'}`;
    preview.style.display = 'block';
  } catch(e) {
    preview.textContent = `📄 ${file.name} — click Import`;
    preview.style.display = 'block';
  }
}


// ── doImport (originally L3752..L3883) ─────────────────────────
async function doImport(){
  const file = document.getElementById('import-xlsx').files[0];
  if(!file){ showToast('Please choose an Excel file first','error'); return; }

  const opDate = document.getElementById('imp-op-date').value || new Date().toISOString().slice(0,10);

  const btn = document.getElementById('imp-submit-btn');
  const origHTML = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Reading file…';
  btn.disabled  = true;

  try {
    if(typeof XLSX === 'undefined'){ showToast('SheetJS not loaded — refresh and retry','error'); return; }

    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, {type:'array'});
    const locations = _apStorageGodowns();
    const items = [];

    // ══ PATH A — New multi-godown template (sheet "PM Import") ══
    if(wb.SheetNames.includes('PM Import')){
      const ws   = wb.Sheets['PM Import'];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:0, raw:true});
      if(!rows.length){ showToast('Empty sheet','error'); return; }

      // Build column map by header matching
      const header = rows[0].map(c => String(c??'').trim());
      let nameCol = -1, pmCol = -1;
      const locCols = []; // [{col, godown_id, is_floor}]
      header.forEach((h, ci) => {
        const lo = h.toLowerCase();
        if(nameCol<0 && (lo==='name of product' || lo==='product name' || lo==='product')) nameCol = ci;
        if(pmCol<0   && (lo==='pm type' || lo==='pm')) pmCol = ci;
        // Match godown column (strip "[Factory]" suffix)
        const cleanH = h.replace(/\s*\[Factory\]\s*$/i,'').trim().toLowerCase();
        const loc    = locations.find(g => g.name.toLowerCase() === cleanH);
        if(loc) locCols.push({col: ci, godown_id: loc.id, is_floor: loc.godown_type==='floor' || loc.is_floor});
      });

      // Fallback if columns not found
      if(nameCol<0) nameCol = 1;
      if(pmCol<0)   pmCol   = 2;

      for(let ri=1; ri<rows.length; ri++){
        const row  = rows[ri];
        const name = String(row[nameCol]??'').trim();
        const pm   = String(row[pmCol]??'').trim();
        if(!name || !pm || name.length < 2) continue;

        // Collect opening entries per matched location column
        const openings = locCols.map(lc => ({
          godown_id: lc.godown_id,
          is_floor:  lc.is_floor,
          qty:       Number(row[lc.col]) || 0
        })).filter(o => o.qty > 0);

        items.push({ product_name: name, pm_type: pm, op_date: opDate, openings });
      }

    // ══ PATH B — Legacy Beardo format (MAIN SHEET + FLOOR) ══
    } else {
      // Find a default godown + factory for legacy mapping
      const defaultGodown = locations.find(g => !(g.godown_type==='floor'||g.is_floor));
      const defaultFloor  = locations.find(g => g.godown_type==='floor' || g.is_floor);
      if(!defaultGodown){ showToast('No default godown found — cannot import legacy format','error'); return; }

      const mainName = wb.SheetNames.includes('MAIN SHEET') ? 'MAIN SHEET' : wb.SheetNames[0];
      const mainRows = XLSX.utils.sheet_to_json(wb.Sheets[mainName], {header:1, defval:0});
      let nameCol=1, pmCol=2, opCol=3;
      for(let ri=0; ri<Math.min(5,mainRows.length); ri++){
        mainRows[ri].forEach((cell,ci)=>{
          const s = String(cell).toLowerCase();
          if(s.includes('name of product')||s==='product name') nameCol = ci;
          if(s==='pm'||s==='pm type') pmCol = ci;
          if(s==='op'||s==='opening'||s==='opening balance'||s==='godown op') opCol = ci;
        });
      }
      const floorOpMap = {};
      if(wb.SheetNames.includes('FLOOR')){
        const floorRows = XLSX.utils.sheet_to_json(wb.Sheets['FLOOR'], {header:1, defval:0});
        let fNameCol=1, fOpCol=3;
        for(let ri=0; ri<Math.min(5,floorRows.length); ri++){
          floorRows[ri].forEach((cell,ci)=>{
            const s = String(cell).toLowerCase();
            if(s.includes('name of product')) fNameCol = ci;
            if(s==='op'||s==='opening'||s==='floor op') fOpCol = ci;
          });
        }
        for(let ri=1; ri<floorRows.length; ri++){
          const raw = floorRows[ri][fNameCol];
          if(typeof raw==='string' && raw.startsWith('=')) continue;
          const name = String(raw||'').trim();
          const op   = parseFloat(floorRows[ri][fOpCol]??0)||0;
          if(name && name.length > 2) floorOpMap[name] = op;
        }
      }
      for(let ri=1; ri<mainRows.length; ri++){
        const name = String(mainRows[ri][nameCol]||'').trim();
        const pm   = String(mainRows[ri][pmCol]  ||'').trim();
        const gOp  = parseFloat(mainRows[ri][opCol]??0)||0;
        if(!name || !pm || name.length < 2) continue;
        const fOp = floorOpMap[name] || 0;

        const openings = [];
        if(gOp > 0)                openings.push({godown_id: defaultGodown.id, is_floor: false, qty: gOp});
        if(fOp > 0 && defaultFloor) openings.push({godown_id: defaultFloor.id,  is_floor: true,  qty: fOp});

        items.push({ product_name: name, pm_type: pm, op_date: opDate, openings });
      }
    }

    if(!items.length){ showToast('No valid product rows found','error'); return; }

    const totalOp = items.reduce((s,r)=>s + r.openings.length, 0);
    showToast(`⏳ ${items.length} products · ${totalOp} opening entries — uploading…`,'info');
    btn.innerHTML = '<span class="spinner"></span> Saving…';

    const res  = await fetch('/api/pm_stock/import_products', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(items)
    });
    const data = await res.json();
    if(data.status==='ok'){
      showToast(`✓ ${data.added} new products · ${data.skipped} existed · ${data.op_added} opening entries created`,'success');
      closeModal('importModal');
      await loadProducts(); await loadPmTypes(); await loadSummary();
    } else { showToast(data.message||'Import failed','error'); }
  } catch(e){ showToast('Error: '+e.message,'error'); }
  finally{ btn.innerHTML=origHTML; btn.disabled=false; }
}



// ── openBackfillModal (originally L3900..L3913) ─────────────────────────
function openBackfillModal(){
  const el = document.getElementById('backfill-godown');
  if(el){
    const opts = (_godowns||[]).map(g=>`<option value="${g.id}">${godownLabel(g)}</option>`).join('');
    el.innerHTML = '<option value="">— Select Godown —</option>' + opts;
    // Pre-select default godown if available
    const def = (_godowns||[]).find(g=>g.is_default);
    if(def) el.value = String(def.id);
  }
  const res = document.getElementById('backfill-result');
  if(res){ res.style.display='none'; res.textContent=''; }
  document.getElementById('backfillModal').classList.add('open');
}


// ── openDataRepairsModal (originally L3914..L3918) ─────────────────────────
function openDataRepairsModal(){
  const m = document.getElementById('dataRepairsModal');
  if(m) m.classList.add('open');
}


// ── doMtvRepair (originally L3919..L3935) ─────────────────────────
async function doMtvRepair(){
  try{
    showToast('⏳ Scanning MTV transactions…','info');
    const res = await fetch('/api/pm_stock/mtv/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data = await res.json();
    if(data.status==='ok'){
      if(data.fixed_mtvs > 0){
        const detail = (data.detail||[]).map(d=>`${d.mtv_no}: +${d.inserted} inserted, -${d.deleted} deleted`).join(' | ');
        showToast(`✅ Fixed ${data.fixed_mtvs} MTVs — ${data.rows_inserted} floor entries inserted, ${data.rows_deleted} wrong entries deleted${detail?' · '+detail:''}`, 'success');
      } else {
        showToast(`✅ Nothing to fix — all MTV floor entries are correct. ${data.message||''}`.trim(), 'success');
      }
      await loadSummary();
    } else { showToast('❌ '+(data.message||'Repair failed'),'error'); }
  }catch(e){ showToast('Error: '+e.message,'error'); }
}


// ── doFloorInRepair (originally L3936..L3972) ─────────────────────────
async function doFloorInRepair(){
  if(!confirm('Repair Material IN vouchers where factory/floor stock didn\'t update?\n\n• Scans all "received" transfer vouchers whose destination is a floor location\n• Inserts missing inflow rows so factory stock totals are correct\n• Removes stale rows posted with the wrong txn_type by older code\n• Deletes duplicate inflow rows (caused by multiple repair runs)\n\nIdempotent — safe to run more than once.')) return;
  try{
    showToast('⏳ Scanning floor IN vouchers…','info');
    const res = await fetch('/api/pm_stock/transfers/repair_floor_in',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const data = await res.json();
    if(data.status==='ok'){
      const inserted   = data.rows_inserted      || 0;
      const cleaned    = data.rows_deleted_bogus || 0;
      const duplicates = data.duplicates_deleted || 0;
      const totalChanges = inserted + cleaned + duplicates;

      // Diagnostic line — shows what each phase actually saw and did
      const diag = `Scanned: A=${data.phase_a_rows_seen??'?'} A2=${data.phase_a2_rows_seen??'?'} A3=${data.phase_a3_rows_seen??'?'} · Deleted: A2=${data.phase_a2_deleted??'?'} A3=${data.phase_a3_deleted??'?'}`;
      console.log('[Repair] ' + diag, data);

      if(totalChanges > 0){
        const detail = (data.detail||[]).slice(0,6).map(d => {
          const bits = [];
          if(d.inserted)      bits.push(`+${d.inserted}`);
          if(d.deleted_bogus) bits.push(`-${d.deleted_bogus} stale`);
          if(d.duplicates)    bits.push(`-${d.duplicates} dup`);
          return `${d.transfer_no} (${bits.join(', ')})`;
        }).join(' | ');
        const summary = [];
        if(inserted)   summary.push(`${inserted} inserted`);
        if(cleaned)    summary.push(`${cleaned} stale removed`);
        if(duplicates) summary.push(`${duplicates} duplicates removed`);
        showToast(`✅ Repair complete — ${summary.join(', ')}${detail?' · '+detail:''}`,'success', 8000);
      } else {
        showToast(`✅ Nothing to fix — all ${data.transfers_scanned} transfers OK · ${diag}`,'success', 9000);
      }
      await loadSummary();
    } else { showToast('❌ '+(data.message||'Repair failed'),'error'); }
  }catch(e){ showToast('Error: '+e.message,'error'); }
}


// ── doBackfill (originally L3973..L3998) ─────────────────────────
async function doBackfill(){
  const godownId = parseInt(document.getElementById('backfill-godown')?.value)||null;
  if(!godownId){ showToast('Please select a godown','error'); return; }
  const btn = document.getElementById('backfill-submit-btn');
  const origHTML = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Updating…'; btn.disabled = true;
  try{
    const res = await fetch('/api/pm_stock/backfill_opening_godown',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({godown_id: godownId})
    });
    const data = await res.json();
    const resultEl = document.getElementById('backfill-result');
    if(data.status==='ok'){
      const total = data.godown_updated + data.floor_updated;
      resultEl.style.cssText = 'display:block;background:rgba(26,115,232,0.08);border:1px solid rgba(26,115,232,0.3);color:var(--brand);border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:12px';
      resultEl.innerHTML = `✅ Done! Updated <strong>${data.godown_updated}</strong> godown opening rows + <strong>${data.floor_updated}</strong> factory opening rows (${total} total).`;
      await loadSummary();
    } else {
      resultEl.style.cssText = 'display:block;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:12px';
      resultEl.textContent = '❌ ' + (data.message||'Update failed');
    }
  }catch(e){ showToast('Error: '+e.message,'error'); }
  finally{ btn.innerHTML=origHTML; btn.disabled=false; }
}


