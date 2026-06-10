/* ════════════════════════════════════════════════════════════════════
   PM TRS — FRONTEND
   ──────────────────────────────────────────────────────────────────
   Companion to the /api/pm_stock/trs/* endpoints. Three flows live
   here:

   1. GRN-line "Generate TRS" — kicked off from the edit-GRN modal
      footer button. Reads checked grn-item-row(s) → preflight →
      missing-data modal → generate. Mirrors the RM TRS pattern but
      with PM-specific data shape.

   2. GRN-line "TRS generated" badge decoration — loadTrsBadgesForGrn()
      is called from openEditGrn() after the modal opens. Adds a
      small pill next to each line that already has a TRS, with a
      click-through to view it.

   3. PM TRS grid (sidebar entry → tab-trs) — list, filters, search,
      double-click to detail/edit.

   Conventions reused from pm_stock_adjustments.js:
     * filter chips use the .trs-fbtn class; trsSetFilter() applies
       active-state styling without re-rendering everything.
     * Detail modal reuses the standard modal-overlay z-index 920 (above
       the GRN edit modal at z-index 900 so users can open from there).
     * showToast() is the shared global toast helper.
══════════════════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────────────────
// Current filter chip (matches server-side status enum exactly)
let _trsFilter   = 'All';
// Full list from the last fetch, used by the search input which
// filters client-side without re-fetching.
let _trsRows     = [];
// Whether the viewer is admin (used for edit/delete gating in the UI)
let _trsIsAdmin  = false;
let _trsMe       = '';
// The TRS detail-modal current row id (used to disambiguate after
// edits / deletes complete).
let _trsDetailId = null;
// State of the in-flight generate flow. Stashed so trsForceGenerate()
// and trsSubmitGenerate() have access to the original selection.
let _trsGenCtx   = null;

// ── HTML escape helper (shared with adjustments.js but keep a local
// copy so the file works standalone if order changes) ───────────────
function _trsEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── DD/MM/YYYY formatter ───────────────────────────────────────────
function _trsFmtDate(s){
  if(!s) return '—';
  const ten = String(s).slice(0,10);
  const p = ten.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ten;
}
function _trsFmtDateTime(s){
  if(!s) return '—';
  const dt = new Date(s);
  if(isNaN(dt.getTime())) return String(s);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
function _trsFmtN(n){
  const v = Number(n);
  if(!isFinite(v)) return '—';
  return v.toLocaleString('en-IN');
}

// ── Status pill (used in list and detail) ───────────────────────────
function _trsStatusPill(s){
  const map = {
    'Pending':      { bg:'rgba(245,158,11,.12)', fg:'#d97706', txt:'Pending' },
    'Approved':     { bg:'rgba(34,197,94,.12)',  fg:'#16a34a', txt:'Approved' },
    'Rejected':     { bg:'rgba(239,68,68,.12)',  fg:'#dc2626', txt:'Rejected' },
    'Under Review': { bg:'rgba(99,102,241,.12)', fg:'#6366f1', txt:'Under Review' },
  };
  const m = map[s] || { bg:'#eee', fg:'#666', txt: s || '—' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${m.bg};color:${m.fg};font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">${m.txt}</span>`;
}

// ════════════════════════════════════════════════════════════════════
// SECTION 1 — GRN edit-modal "Generate TRS" flow
// ════════════════════════════════════════════════════════════════════

/**
 * Entry point: the user clicked "Generate TRS" in the edit-GRN modal.
 * Collects checked rows, validates same-product, then preflights with
 * the server and shows the missing-data modal (or a duplicate-warning
 * modal if any of the lines already have a TRS).
 */
async function trsGenerateFromGrn(){
  const grnIdStr = document.getElementById('egrn-id')?.value;
  if(!grnIdStr){
    if(window.showToast) showToast('Save the GRN first before generating a TRS','error');
    return;
  }
  const grnId = parseInt(grnIdStr) || 0;
  if(!grnId){
    if(window.showToast) showToast('GRN id missing — save the GRN first','error');
    return;
  }

  // Collect checked rows. Each row keeps its grn_item_id in
  // div.dataset.grnItemId (set in egrnAddItem). Unsaved lines have no
  // dataset id — those can't be TRS'd until the GRN is saved.
  const rows = Array.from(document.querySelectorAll('.grn-item-row'));
  const selected = rows.filter(r => {
    const cb = r.querySelector('.grn-item-sel');
    return cb && cb.checked;
  });

  if(!selected.length){
    if(window.showToast) showToast('Tick at least one GRN line before generating TRS','error');
    return;
  }

  // Quick same-product validation client-side (server validates again,
  // but failing fast keeps the UX snappy).
  const pidSet = new Set();
  const lineIds = [];
  let unsavedFound = false;
  for(const r of selected){
    const pid = (r.querySelector('.gi-product')?.value || '').trim();
    if(pid) pidSet.add(pid);
    const lid = parseInt(r.dataset.grnItemId || 0);
    if(lid) lineIds.push(lid);
    else unsavedFound = true;
  }
  if(unsavedFound){
    if(window.showToast) showToast('One or more selected lines have unsaved edits — save the GRN first, then re-open and generate TRS','error', 5000);
    return;
  }
  if(pidSet.size > 1){
    if(window.showToast) showToast('Selected lines reference different products. TRS must cover ONE product at a time — uncheck the mismatched line(s).','error', 5500);
    return;
  }
  if(!lineIds.length){
    if(window.showToast) showToast('No valid line ids found in selection','error');
    return;
  }

  // Stash context so the modals can reach it
  _trsGenCtx = { grn_id: grnId, line_ids: lineIds };

  // Preflight
  try {
    const res = await fetch('/api/pm_stock/trs/preflight', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify({ grn_id: grnId, line_ids: lineIds }),
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Preflight failed','error');
      return;
    }
    if(!d.ok){
      if(d.mode === 'duplicate'){
        _trsShowDuplicate(d.existing || []);
        return;
      }
      // 'invalid' or anything else
      if(window.showToast) showToast(d.message || 'Cannot generate TRS','error', 5500);
      return;
    }
    // Ready — show the missing-data modal pre-populated
    _trsShowGenerateModal(d);
  } catch(e){
    if(window.showToast) showToast('Network error: ' + e.message, 'error');
  }
}
window.trsGenerateFromGrn = trsGenerateFromGrn;

/**
 * Renders the missing-data modal body with the aggregated preview at
 * top + editable fields below.
 */
function _trsShowGenerateModal(pre){
  const body = document.getElementById('trs-gen-body');
  if(!body) return;
  const agg = pre.aggregate || {};
  const grn = pre.grn || {};
  const missing = pre.missing_fields || [];

  // Pre-fill defaults that the operator can override
  const defaults = pre.defaults || {};
  const verifiedBy = defaults.verified_by || '';

  // Render the preview block — values come from the server-aggregated
  // GRN line totals. Show how many lines are aggregated for clarity.
  const lineCount = (agg.lines || []).length;
  body.innerHTML = `
    <!-- Aggregated preview (read-only) -->
    <div style="background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:10px;padding:12px 14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap">
        <div style="flex:1 1 280px;min-width:0">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Item</div>
          <div style="font-size:13px;font-weight:800;color:var(--htxtb,#111);margin-top:2px;line-height:1.3">
            ${agg.product_code ? `<span style="font-family:monospace;color:#7c3aed;font-size:11px;margin-right:6px">${_trsEsc(agg.product_code)}</span>` : ''}
            ${_trsEsc(agg.product_name || '—')}
          </div>
          ${agg.pm_type ? `<div style="font-size:10px;color:var(--hmuted,#9ca3af);margin-top:2px">[${_trsEsc(agg.pm_type)}]</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">GRN</div>
          <div style="font-family:monospace;font-weight:800;color:#0d9488;font-size:11.5px;margin-top:2px">${_trsEsc(grn.grn_no || '')}</div>
          <div style="font-size:10px;color:var(--hmuted,#9ca3af);margin-top:2px">${_trsFmtDate(grn.grn_date)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding-top:10px;border-top:1px dashed var(--hbdr,rgba(0,0,0,.1));font-size:11px">
        <div>
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">No. of Box</div>
          <div style="font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-size:14px">${_trsFmtN(agg.no_of_box)}</div>
        </div>
        <div>
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Per Box Qty</div>
          <div style="font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-size:14px">${_trsFmtN(agg.qty_per_pkg)}</div>
        </div>
        <div>
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Total Qty</div>
          <div style="font-weight:800;color:var(--teal,#0d9488);margin-top:2px;font-size:14px">${_trsFmtN(agg.total_qty)} <span style="color:var(--hmuted,#9ca3af);font-size:10px;font-weight:400">${_trsEsc(agg.primary_uom || '')}</span></div>
        </div>
      </div>
      ${lineCount > 1 ? `<div style="margin-top:8px;font-size:10.5px;color:#0ea5e9;font-weight:700"><i class="fas fa-layer-group"></i> Aggregated from ${lineCount} GRN line(s) of the same product</div>` : ''}
    </div>

    <!-- Supplier + previous supplier (server-derived; admin can edit later in detail modal) -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div>
        <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Current Supplier</div>
        <div style="padding:7px 10px;background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:var(--htxtb,#111)">${_trsEsc(grn.supplier || '—')}</div>
      </div>
      <div>
        <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">
          Previous Supplier
          <span style="margin-left:6px;padding:1px 6px;border-radius:999px;background:${pre.new_or_old === 'NEW' ? 'rgba(220,38,38,.15)' : 'rgba(34,197,94,.15)'};color:${pre.new_or_old === 'NEW' ? '#dc2626' : '#16a34a'};font-size:9px;font-weight:800;letter-spacing:.3px">${pre.new_or_old}</span>
        </div>
        <div style="padding:7px 10px;background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:${pre.previous_supplier ? 'var(--htxtb,#111)' : 'var(--hmuted,#9ca3af)'}">${pre.previous_supplier ? _trsEsc(pre.previous_supplier) : '— (first time)'}</div>
      </div>
    </div>

    <!-- User-fillable fields (the "missing data") -->
    <div style="border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:10px;padding:12px 14px;background:rgba(14,165,233,.04)">
      <div style="font-size:11px;font-weight:800;color:#0284c7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px"><i class="fas fa-edit"></i> Verification details (please fill)</div>
      <div id="trs-gen-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
    </div>
  `;

  // Render dynamic fields. We always include verified_by since it lets
  // the operator stamp a name different from their login (common when
  // an unauthorized stand-in is doing the work).
  const wrap = document.getElementById('trs-gen-fields');
  const fields = [
    ...missing,
    { key:'verified_by', label:'Verified By', type:'text', default: verifiedBy },
  ];
  for(const f of fields){
    const id = 'trs-gen-' + f.key;
    let inputHtml = '';
    if(f.type === 'select'){
      inputHtml = `<select id="${id}" style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">`
        + (f.options || []).map(o => `<option value="${_trsEsc(o)}" ${o === f.default ? 'selected':''}>${_trsEsc(o)}</option>`).join('')
        + `</select>`;
    } else if(f.type === 'number'){
      const step = f.step || 'any';
      const mn = (f.min != null) ? `min="${f.min}"` : '';
      inputHtml = `<input type="number" id="${id}" ${mn} step="${step}" value="${f.default != null ? _trsEsc(String(f.default)) : ''}"
        style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit;text-align:right">`;
    } else {
      inputHtml = `<input type="text" id="${id}" value="${f.default != null ? _trsEsc(String(f.default)) : ''}"
        style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">`;
    }
    wrap.insertAdjacentHTML('beforeend', `
      <div>
        <label for="${id}" style="display:block;font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">${_trsEsc(f.label)}</label>
        ${inputHtml}
      </div>
    `);
  }

  // Open modal. We may already be on top of the editGrnModal (z-index
  // 900); the trsGenerateModal is at 920 in HTML.
  document.getElementById('trsGenerateModal').classList.add('open');
}

/**
 * Read field values from the open modal and POST to /generate. On
 * success, refresh the GRN-line badges and close the modal.
 */
async function trsSubmitGenerate(){
  if(!_trsGenCtx){
    if(window.showToast) showToast('Generate context lost — close and retry','error');
    return;
  }
  const payload = {
    grn_id:         _trsGenCtx.grn_id,
    line_ids:       _trsGenCtx.line_ids,
    physical_state: (document.getElementById('trs-gen-physical_state')?.value || 'OK').trim(),
    sample_qty:     parseFloat(document.getElementById('trs-gen-sample_qty')?.value || '1') || 1,
    client_name:    (document.getElementById('trs-gen-client_name')?.value || '').trim(),
    verified_by:    (document.getElementById('trs-gen-verified_by')?.value || '').trim(),
    force_duplicate: !!_trsGenCtx.force,
  };
  const btn = document.getElementById('trs-gen-submit');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…'; }
  try {
    const res = await fetch('/api/pm_stock/trs/generate', {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify(payload),
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(d.code === 'duplicate' && d.existing){
        // User raced — show duplicate dialog
        _trsShowDuplicate(d.existing);
        return;
      }
      if(window.showToast) showToast(d.message || 'Generate failed','error', 5000);
      return;
    }
    if(window.showToast) showToast(`✓ TRS ${d.trs_num} generated`, 'success', 3500);
    closeModal('trsGenerateModal');
    // Re-decorate GRN lines with the new TRS badge
    if(_trsGenCtx && _trsGenCtx.grn_id) loadTrsBadgesForGrn(_trsGenCtx.grn_id);
    _trsGenCtx = null;
    // If the user is currently viewing the TRS list, refresh it too
    if(document.getElementById('tab-trs')?.style.display !== 'none'){
      loadTrsList();
    }
  } catch(e){
    if(window.showToast) showToast('Network error: ' + e.message,'error');
  } finally {
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Generate TRS'; }
  }
}
window.trsSubmitGenerate = trsSubmitGenerate;

/**
 * Render the duplicate-warning modal. existing is a list of
 * {id, trs_num, status, matched_lines:[ids]} entries from /preflight.
 */
function _trsShowDuplicate(existing){
  const body = document.getElementById('trs-dup-body');
  const forceBtn = document.getElementById('trs-dup-force');
  if(!body) return;
  body.innerHTML = `
    <div style="font-size:12px;color:var(--htxtb,#111);margin-bottom:12px;line-height:1.5">
      A Testing Requisition Slip already exists for one or more of the selected GRN lines:
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${existing.map(e => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:8px;background:var(--hsurf2,#f8fafc)">
          <div>
            <div style="font-family:monospace;font-weight:800;color:#0ea5e9;font-size:12px">${_trsEsc(e.trs_num)}</div>
            <div style="font-size:10px;color:var(--hmuted,#9ca3af);margin-top:2px">covers line${(e.matched_lines||[]).length===1?'':'s'} #${(e.matched_lines||[]).join(', #')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${_trsStatusPill(e.status)}
            <button class="btn btn-outline btn-sm" onclick="closeModal('trsDuplicateModal');closeModal('trsGenerateModal');openTrsDetail(${e.id})"
              style="padding:3px 10px;font-size:11px">
              <i class="fas fa-eye"></i> Open
            </button>
          </div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:14px;padding:10px 12px;background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;border-radius:4px;font-size:11px;color:#92400e">
      💡 If the existing TRS is for the same lines and still pending, edit it instead of creating a duplicate.
      Only force a new one if the original was rejected and you intend to keep both for the audit trail.
    </div>
  `;
  if(forceBtn) forceBtn.style.display = '';
  document.getElementById('trsDuplicateModal').classList.add('open');
}

/**
 * "Force create another anyway" — close the duplicate modal and
 * re-run preflight with skip_duplicate_check=true so we get the
 * aggregate and missing-fields, then open the generate modal as
 * normal. _trsGenCtx.force is set so the eventual /generate call
 * also passes force_duplicate=true.
 */
async function trsForceGenerate(){
  if(!_trsGenCtx){ closeModal('trsDuplicateModal'); return; }
  _trsGenCtx.force = true;
  closeModal('trsDuplicateModal');
  try {
    const res = await fetch('/api/pm_stock/trs/preflight', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify({
        grn_id: _trsGenCtx.grn_id,
        line_ids: _trsGenCtx.line_ids,
        skip_duplicate_check: true,
      }),
    });
    const d = await res.json();
    if(d.status !== 'ok' || !d.ok){
      if(window.showToast) showToast(d.message || 'Preflight failed','error');
      return;
    }
    _trsShowGenerateModal(d);
  } catch(e){
    if(window.showToast) showToast('Network error: ' + e.message,'error');
  }
}
window.trsForceGenerate = trsForceGenerate;

// ════════════════════════════════════════════════════════════════════
// SECTION 2 — GRN-line badge decoration
// ════════════════════════════════════════════════════════════════════

/**
 * For an open edit-GRN modal, query /grn_status and decorate each
 * .grn-item-row whose dataset.grnItemId is covered by a TRS with a
 * "TRS generated" pill. Idempotent — drops any existing pills before
 * re-rendering.
 */
async function loadTrsBadgesForGrn(grnId){
  if(!grnId) return;
  try {
    const res = await fetch(`/api/pm_stock/trs/grn_status?grn_id=${encodeURIComponent(grnId)}`);
    const d = await res.json();
    if(d.status !== 'ok') return;
    const byLine = d.by_line || {};
    const rows = Array.from(document.querySelectorAll('#egrn-items-container .grn-item-row'));
    for(const r of rows){
      // Remove existing badge first
      const old = r.querySelector('.trs-line-badge');
      if(old) old.remove();
      const lid = r.dataset.grnItemId;
      if(!lid) continue;
      const trs = byLine[String(lid)];
      if(!trs) continue;
      const status = trs.status || 'Pending';
      const colorMap = {
        'Pending':      { bg:'rgba(245,158,11,.12)', fg:'#d97706', icon:'⏳' },
        'Approved':     { bg:'rgba(34,197,94,.12)',  fg:'#16a34a', icon:'✅' },
        'Rejected':     { bg:'rgba(239,68,68,.12)',  fg:'#dc2626', icon:'❌' },
        'Under Review': { bg:'rgba(99,102,241,.12)', fg:'#6366f1', icon:'🔍' },
      };
      const m = colorMap[status] || colorMap['Pending'];
      // Insert pill into the product cell (2nd column has the combo
      // wrap). We add an absolute-positioned span on the right of the
      // combo wrap so it overlays nicely without breaking layout.
      const combo = r.querySelector('.prod-combo-wrap');
      if(!combo) continue;
      const pill = document.createElement('span');
      pill.className = 'trs-line-badge';
      pill.title = `TRS ${trs.trs_num} · ${status}${trs.is_locked ? ' (locked)' : ''} — click to view`;
      pill.style.cssText = `position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:2px 7px;border-radius:999px;background:${m.bg};color:${m.fg};font-size:9.5px;font-weight:800;letter-spacing:.3px;cursor:pointer;text-transform:uppercase;z-index:10;border:1px solid ${m.fg}33;line-height:1.2`;
      pill.innerHTML = `${m.icon} TRS`;
      pill.onclick = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openTrsDetail(trs.trs_id);
      };
      combo.appendChild(pill);
    }
  } catch(_e){
    // Silent — badges are nice-to-have, not critical
  }
}
window.loadTrsBadgesForGrn = loadTrsBadgesForGrn;

// ════════════════════════════════════════════════════════════════════
// SECTION 3 — PM TRS list grid (tab-trs)
// ════════════════════════════════════════════════════════════════════

function trsSetFilter(status){
  _trsFilter = status;
  // Update chip styling
  document.querySelectorAll('.trs-fbtn').forEach(b => {
    const active = (b.dataset.status === status);
    b.style.background  = active ? '#0ea5e9' : 'var(--hsurf2,#f8fafc)';
    b.style.color       = active ? '#fff' : 'var(--hmuted2,#6b7280)';
    b.style.borderColor = active ? '#0ea5e9' : 'var(--hbdr2,rgba(0,0,0,.13))';
    b.style.borderStyle = 'solid';
    b.style.borderWidth = '1.5px';
  });
  loadTrsList();
}
window.trsSetFilter = trsSetFilter;

async function loadTrsList(){
  const wrap = document.getElementById('trs-list-wrap');
  if(!wrap) return;
  // Reset to page 1 — fresh fetch is implicitly "start at the top"
  if(typeof _trsPage === 'number') _trsPage = 1;
  wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">Loading…</div>`;
  try {
    const url = `/api/pm_stock/trs/list?status=${encodeURIComponent(_trsFilter)}`;
    const res = await fetch(url);
    const d   = await res.json();
    if(d.status !== 'ok'){
      wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">${_trsEsc(d.message || 'Failed to load')}</div>`;
      return;
    }
    _trsRows    = d.trs || [];
    _trsIsAdmin = !!d.is_admin;
    _trsMe      = d.me || '';
    renderTrsList();
    // Sidebar pending badge
    const pending = _trsRows.filter(r => r.approval_status === 'Pending').length;
    const sb = document.getElementById('sb-trs-pending');
    if(sb){
      if(pending > 0){
        sb.textContent = String(pending);
        sb.style.display = '';
      } else {
        sb.style.display = 'none';
      }
    }
  } catch(e){
    wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">Error: ${_trsEsc(e.message)}</div>`;
  }
}
window.loadTrsList = loadTrsList;

function renderTrsList(){
  const wrap = document.getElementById('trs-list-wrap');
  if(!wrap) return;
  // Client-side text search
  const q = (document.getElementById('trs-search')?.value || '').toLowerCase().trim();
  let rows = _trsRows;
  if(q){
    rows = rows.filter(r =>
      (r.trs_num || '').toLowerCase().includes(q) ||
      (r.grn_num || '').toLowerCase().includes(q) ||
      (r.material || '').toLowerCase().includes(q) ||
      (r.product_code || '').toLowerCase().includes(q) ||
      (r.supplier_name || '').toLowerCase().includes(q) ||
      (r.previous_supplier || '').toLowerCase().includes(q)
    );
  }

  const info = document.getElementById('trs-count-info');
  if(info) info.textContent = `${rows.length} TRS${rows.length === 1 ? '' : 's'}`;

  if(!rows.length){
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <div style="font-size:24px;margin-bottom:8px">🧪</div>
      No PM TRS rows ${q ? `matching "${_trsEsc(q)}"` : (_trsFilter !== 'All' ? `with status "${_trsFilter}"` : 'yet')}.
    </div>`;
    return;
  }

  // ── Pagination state ──────────────────────────────────────────────
  // Per-search reset: if the filtered count is smaller than the current
  // page would need, snap back to page 1 so the user never lands on a
  // ghost page that vanished when they typed in the search box.
  if(typeof _trsPageSize !== 'number') _trsPageSize = 50;
  if(typeof _trsPage     !== 'number') _trsPage     = 1;
  const pageSize  = _trsPageSize === 0 ? rows.length : _trsPageSize;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  if(_trsPage > totalPages) _trsPage = totalPages;
  if(_trsPage < 1)          _trsPage = 1;
  const startIdx = (_trsPage - 1) * pageSize;
  const pageRows = rows.slice(startIdx, startIdx + pageSize);

  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:auto">
      <thead>
        <tr style="background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.08))">
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">TRS No</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">TRS Date</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Item</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">GRN</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Boxes</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Total Qty</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Supplier</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">Status</th>
          <th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">Approved By / At</th>
          <th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${pageRows.map(r => {
          const canEdit = !r.is_locked && (r.approval_status === 'Pending' || _trsIsAdmin);
          const canDelete = (r.approval_status === 'Pending') || _trsIsAdmin;
          const newOldChip = r.new_or_old === 'NEW'
            ? `<span style="margin-left:4px;padding:1px 5px;background:rgba(220,38,38,.12);color:#dc2626;font-size:8.5px;font-weight:800;border-radius:3px;vertical-align:middle">NEW</span>`
            : '';
          return `
            <tr ondblclick="openTrsDetail(${r.id})" style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));cursor:pointer"
                onmouseenter="this.style.background='rgba(14,165,233,.04)'"
                onmouseleave="this.style.background='transparent'">
              <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:#0ea5e9;white-space:nowrap">${_trsEsc(r.trs_num)}</td>
              <td style="padding:9px 12px;color:var(--htxtb,#111);white-space:nowrap">${_trsFmtDate(r.generated_at)}</td>
              <td style="padding:9px 12px;color:var(--htxtb,#111);min-width:200px">
                ${r.product_code ? `<span style="font-family:monospace;color:#7c3aed;font-size:10.5px;margin-right:4px">${_trsEsc(r.product_code)}</span>` : ''}
                ${_trsEsc(r.material || '')}
              </td>
              <td style="padding:9px 12px;color:var(--hmuted2,#6b7280);font-family:monospace;font-size:11px;white-space:nowrap">${_trsEsc(r.grn_num || '')}</td>
              <td style="padding:9px 12px;text-align:right;color:var(--htxtb,#111);white-space:nowrap">${_trsFmtN(r.no_of_box)}</td>
              <td style="padding:9px 12px;text-align:right;color:var(--htxtb,#111);font-weight:700;white-space:nowrap">${_trsFmtN(r.total_qty)} <span style="color:var(--hmuted,#9ca3af);font-size:10px;font-weight:400">${_trsEsc(r.uom || '')}</span></td>
              <td style="padding:9px 12px;color:var(--htxtb,#111);font-size:11px">${_trsEsc(r.supplier_name || '—')}${newOldChip}</td>
              <td style="padding:9px 12px;white-space:nowrap">${_trsStatusPill(r.approval_status)}${(r.is_locked && r.approval_status !== 'Under Review') ? '<span title="Locked: >24h since QC decision" style="margin-left:4px;color:#dc2626;font-size:10px"><i class="fas fa-lock"></i></span>' : ''}</td>
              <td style="padding:9px 12px;color:var(--hmuted2,#6b7280);font-size:10.5px;white-space:nowrap">
                ${r.approved_by ? `<div>${_trsEsc(r.approved_by)}</div><div style="color:var(--hmuted,#9ca3af);font-size:10px">${_trsFmtDateTime(r.approval_dt)}</div>` : '—'}
              </td>
              <td style="padding:9px 12px;text-align:right;white-space:nowrap" onclick="event.stopPropagation()">
                <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10.5px" onclick="openTrsDetail(${r.id})" title="View detail"><i class="fas fa-eye"></i></button>
                ${canDelete ? `<button class="btn btn-sm" style="padding:3px 8px;font-size:10.5px;background:var(--hsurf2,#f8fafc);color:#dc2626;border:1px solid rgba(239,68,68,.3)" onclick="deleteTrs(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${_trsRenderPagerBar(rows.length, _trsPage, pageSize, totalPages, startIdx)}
  `;
}
window.renderTrsList = renderTrsList;

// ── Pagination state + bar helpers ───────────────────────────────────
// Module-scope so search/filter changes don't lose the page-size choice.
let _trsPage     = 1;
let _trsPageSize = 50;       // 50 / page by default; 0 = "All"

function _trsRenderPagerBar(total, page, size, totalPages, startIdx){
  // Build a compact pager: page-size selector on the left, page number
  // counter in the middle, ‹ Prev / Next › buttons on the right. The
  // bar disappears entirely when there's only one page AND user is
  // showing all rows on it — no point showing dead controls.
  const showingFrom = total === 0 ? 0 : (startIdx + 1);
  const showingTo   = Math.min(total, startIdx + size);
  // Number-strip: up to 7 buttons, with ellipses if there are gaps.
  const win = 1;  // pages either side of current
  const pages = [];
  for(let p = 1; p <= totalPages; p++){
    if(p === 1 || p === totalPages || (p >= page - win && p <= page + win)){
      pages.push(p);
    } else if(pages[pages.length - 1] !== '…'){
      pages.push('…');
    }
  }
  const btn = (label, disabled, onclick, isActive) => `
    <button onclick="${disabled || isActive ? '' : onclick}"
            ${disabled || isActive ? 'disabled' : ''}
            style="padding:4px 10px;min-width:32px;font-size:11.5px;border-radius:6px;
                   border:1px solid var(--hbdr2,rgba(0,0,0,.13));
                   background:${isActive ? '#0ea5e9' : 'var(--hsurf,#fff)'};
                   color:${isActive ? '#fff' : (disabled ? 'var(--hmuted,#9ca3af)' : 'var(--htxtb,#111)')};
                   cursor:${disabled || isActive ? 'default' : 'pointer'};
                   font-weight:${isActive ? 700 : 500};
                   font-family:inherit">${label}</button>`;
  const numStrip = pages.map(p =>
    p === '…'
      ? `<span style="padding:4px 4px;color:var(--hmuted,#9ca3af);font-size:11.5px">…</span>`
      : btn(String(p), false, `_trsGoToPage(${p})`, p === page)
  ).join('');
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
                padding:10px 14px;border-top:1px solid var(--hbdr,rgba(0,0,0,.06));
                background:var(--hsurf2,#fafbfc);flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--hmuted2,#6b7280)">
        <span>Showing <b style="color:var(--htxtb,#111)">${showingFrom}-${showingTo}</b> of <b style="color:var(--htxtb,#111)">${total}</b></span>
        <span style="color:var(--hbdr2,rgba(0,0,0,.13))">·</span>
        <label style="display:flex;align-items:center;gap:6px">
          <span>Page size</span>
          <select onchange="_trsSetPageSize(parseInt(this.value,10))"
                  style="padding:3px 6px;font-size:11.5px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:5px;background:var(--hinput,#fff);color:var(--htxtb,#111);font-family:inherit">
            <option value="25"  ${_trsPageSize===25?'selected':''}>25</option>
            <option value="50"  ${_trsPageSize===50?'selected':''}>50</option>
            <option value="100" ${_trsPageSize===100?'selected':''}>100</option>
            <option value="0"   ${_trsPageSize===0 ?'selected':''}>All</option>
          </select>
        </label>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        ${btn('« First', page <= 1, `_trsGoToPage(1)`)}
        ${btn('‹ Prev',  page <= 1, `_trsGoToPage(${page - 1})`)}
        ${numStrip}
        ${btn('Next ›',  page >= totalPages, `_trsGoToPage(${page + 1})`)}
        ${btn('Last »',  page >= totalPages, `_trsGoToPage(${totalPages})`)}
      </div>
    </div>
  `;
}

function _trsGoToPage(p){
  _trsPage = p;
  renderTrsList();
  // Scroll the list into view so the user sees the new page top.
  const wrap = document.getElementById('trs-list-wrap');
  if(wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window._trsGoToPage = _trsGoToPage;

function _trsSetPageSize(n){
  _trsPageSize = (typeof n === 'number' && n >= 0) ? n : 50;
  _trsPage = 1;   // resetting to first page on size change is least surprising
  renderTrsList();
}
window._trsSetPageSize = _trsSetPageSize;

// Reset to page 1 whenever the search box content changes, so the user
// doesn't end up on a page that doesn't exist after typing.
document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('trs-search');
  if(search){
    search.addEventListener('input', () => { _trsPage = 1; });
  }
});

// ════════════════════════════════════════════════════════════════════
// SECTION 4 — Detail / edit modal
// ════════════════════════════════════════════════════════════════════

async function openTrsDetail(trsId){
  _trsDetailId = trsId;
  const body = document.getElementById('trs-detail-body');
  const actions = document.getElementById('trs-detail-actions');
  if(!body || !actions) return;
  body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">Loading…</div>`;
  actions.innerHTML = '';
  document.getElementById('trsDetailModal').classList.add('open');
  try {
    const res = await fetch(`/api/pm_stock/trs/${trsId}`);
    const d = await res.json();
    if(d.status !== 'ok'){
      body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">${_trsEsc(d.message || 'Failed to load')}</div>`;
      return;
    }
    _renderTrsDetail(d);
  } catch(e){
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red,#ef4444);font-size:12px">Error: ${_trsEsc(e.message)}</div>`;
  }
}
window.openTrsDetail = openTrsDetail;

function _renderTrsDetail(d){
  const r        = d.trs || {};
  const isAdmin  = !!d.is_admin;
  // Editable when:
  //   * status is Pending and not locked  → anyone with pm_trs access
  //   * status is anything past Pending  → only admin (locked or not)
  //   * locked AND not admin              → never
  const isPending = r.approval_status === 'Pending';
  const canEdit  = (!r.is_locked && isPending) || isAdmin;
  const newOldChip = r.new_or_old === 'NEW'
    ? `<span style="padding:2px 7px;background:rgba(220,38,38,.15);color:#dc2626;font-size:9.5px;font-weight:800;border-radius:3px;letter-spacing:.3px;margin-left:6px">NEW SUPPLIER</span>`
    : `<span style="padding:2px 7px;background:rgba(34,197,94,.15);color:#16a34a;font-size:9.5px;font-weight:800;border-radius:3px;letter-spacing:.3px;margin-left:6px">RETURNING</span>`;

  const body = document.getElementById('trs-detail-body');
  body.innerHTML = `
    <div style="padding:16px 22px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));background:linear-gradient(135deg,rgba(14,165,233,.06),rgba(14,165,233,.01));position:relative">
      <button class="modal-close" onclick="closeModal('trsDetailModal')" style="position:absolute;top:14px;right:18px">✕</button>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="font-size:14px;font-weight:800;color:var(--htxtb,#111)">🧪 TRS ${_trsEsc(r.trs_num)}</div>
        ${_trsStatusPill(r.approval_status)}
        ${(r.is_locked && r.approval_status !== 'Under Review') ? '<span title="Locked: >24h since QC decision" style="color:#dc2626;font-weight:700;font-size:11px"><i class="fas fa-lock"></i> Locked</span>' : ''}
        ${(r.approval_status !== 'Pending' && r.approval_status !== 'Under Review' && r.hours_remaining != null && !r.is_locked) ? `<span style="color:#0ea5e9;font-size:11px"><i class="fas fa-hourglass-half"></i> ${r.hours_remaining.toFixed(1)}h until lock</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:14px;font-size:11px">
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Generated</div><div style="color:var(--htxtb,#111);font-weight:700">${_trsFmtDateTime(r.generated_at)}</div></div>
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Generated By</div><div style="color:var(--htxtb,#111);font-weight:700">${_trsEsc(r.generated_by || '—')}</div></div>
        <div><div style="color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">GRN</div><div style="color:#0d9488;font-family:monospace;font-weight:800">${_trsEsc(r.grn_num || '—')} <span style="color:var(--hmuted,#9ca3af);font-weight:400;font-size:10px;font-family:inherit">${_trsFmtDate(r.grn_date)}</span></div></div>
        ${r.approved_by ? `<div><div style="color:#16a34a;font-weight:800;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px">Approved By</div><div style="color:var(--htxtb,#111);font-weight:700">${_trsEsc(r.approved_by)}</div><div style="color:var(--hmuted2,#6b7280);font-size:10px">${_trsFmtDateTime(r.approval_dt)}</div></div>` : ''}
      </div>
    </div>

    <div style="padding:16px 22px">
      <!-- Item + qty (read-only — derived from GRN, cannot be edited per spec) -->
      <div style="background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Item</div>
        <div style="font-size:13px;font-weight:800;color:var(--htxtb,#111);line-height:1.3">
          ${r.product_code ? `<span style="font-family:monospace;color:#7c3aed;font-size:11px;margin-right:6px">${_trsEsc(r.product_code)}</span>` : ''}
          ${_trsEsc(r.material || '—')}
          ${r.pm_type ? `<span style="font-size:10px;color:var(--hmuted,#9ca3af);font-weight:400;margin-left:6px">[${_trsEsc(r.pm_type)}]</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--hbdr,rgba(0,0,0,.1))">
          <div>
            <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">No. of Box</div>
            <div style="font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-size:14px">${_trsFmtN(r.no_of_box)}</div>
          </div>
          <div>
            <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Per Box Qty</div>
            <div style="font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-size:14px">${_trsFmtN(r.qty_per_pkg)}</div>
          </div>
          <div>
            <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">Total Qty</div>
            <div style="font-weight:800;color:var(--teal,#0d9488);margin-top:2px;font-size:14px">${_trsFmtN(r.total_qty)} <span style="color:var(--hmuted,#9ca3af);font-size:10px;font-weight:400">${_trsEsc(r.uom || '')}</span></div>
          </div>
        </div>
      </div>

      <!-- Supplier info -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div>
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Current Supplier${newOldChip}</div>
          <div style="padding:7px 10px;background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:var(--htxtb,#111)">${_trsEsc(r.supplier_name || '—')}</div>
        </div>
        <div>
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Previous Supplier</div>
          <div style="padding:7px 10px;background:var(--hsurf2,#f8fafc);border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:${r.previous_supplier ? 'var(--htxtb,#111)' : 'var(--hmuted,#9ca3af)'}">${r.previous_supplier ? _trsEsc(r.previous_supplier) : '— (first time)'}</div>
        </div>
      </div>

      <!-- Editable fields (or read-only summary) -->
      <div style="border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:8px;padding:12px 14px;background:${canEdit ? 'rgba(14,165,233,.04)' : 'var(--hsurf2,#f8fafc)'}">
        <div style="font-size:11px;font-weight:800;color:${canEdit ? '#0284c7' : 'var(--hmuted2,#6b7280)'};text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">
          ${canEdit ? '<i class="fas fa-edit"></i> Verification (editable)' : '<i class="fas fa-lock"></i> Verification (read-only)'}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
          <div>
            <label style="display:block;font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Physical State</label>
            ${canEdit
              ? `<select id="trs-detail-physical_state" style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">
                  ${['OK','Damaged','Wet','Contaminated','Other'].map(o => `<option value="${o}" ${o === r.physical_state ? 'selected':''}>${o}</option>`).join('')}
                </select>`
              : `<div style="padding:7px 10px;background:#fff;border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:var(--htxtb,#111)">${_trsEsc(r.physical_state || 'OK')}</div>`
            }
          </div>
          <div>
            <label style="display:block;font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Sample Qty</label>
            ${canEdit
              ? `<input type="number" id="trs-detail-sample_qty" min="0" step="any" value="${_trsEsc(String(r.sample_qty != null ? r.sample_qty : 1))}"
                  style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit;text-align:right">`
              : `<div style="padding:7px 10px;background:#fff;border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:var(--htxtb,#111);text-align:right">${_trsFmtN(r.sample_qty)}</div>`
            }
          </div>
          <div>
            <label style="display:block;font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Verified By</label>
            ${canEdit
              ? `<input type="text" id="trs-detail-verified_by" value="${_trsEsc(r.verified_by || '')}"
                  style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">`
              : `<div style="padding:7px 10px;background:#fff;border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:var(--htxtb,#111)">${_trsEsc(r.verified_by || '—')}</div>`
            }
          </div>
          <div>
            <label style="display:block;font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Client Name (optional)</label>
            ${canEdit
              ? `<input type="text" id="trs-detail-client_name" value="${_trsEsc(r.client_name || '')}"
                  style="width:100%;padding:6px 10px;font-size:12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;background:var(--hinput,#fff);color:var(--text,#111);outline:none;font-family:inherit">`
              : `<div style="padding:7px 10px;background:#fff;border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:6px;font-size:12px;color:${r.client_name ? 'var(--htxtb,#111)' : 'var(--hmuted,#9ca3af)'}">${r.client_name ? _trsEsc(r.client_name) : '—'}</div>`
            }
          </div>
        </div>
      </div>

      ${r.rejection_reason ? `
        <div style="margin-top:14px;padding:10px 14px;background:rgba(239,68,68,.07);border-left:3px solid #dc2626;border-radius:0 6px 6px 0">
          <div style="font-size:9.5px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Rejection Reason</div>
          <div style="font-size:12px;color:var(--htxtb,#111);line-height:1.5">${_trsEsc(r.rejection_reason)}</div>
        </div>` : ''}
      ${r.approval_remarks ? `
        <div style="margin-top:10px;padding:10px 14px;background:rgba(99,102,241,.07);border-left:3px solid #6366f1;border-radius:0 6px 6px 0">
          <div style="font-size:9.5px;font-weight:800;color:#6366f1;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">QC Remarks</div>
          <div style="font-size:12px;color:var(--htxtb,#111);line-height:1.5">${_trsEsc(r.approval_remarks)}</div>
        </div>` : ''}
    </div>
  `;

  // Footer actions — split into left group (share / print) and right
  // group (edit / decision / close).
  const actions = document.getElementById('trs-detail-actions');
  const leftBtns  = [];
  const rightBtns = [];
  // Print TRS — always available for any TRS that exists, regardless
  // of status. Opens a new tab streaming the PDF.
  leftBtns.push(`<button class="btn btn-outline btn-sm" onclick="printTrs(${r.id})" title="Open the TRS PDF in a new tab (print or download from there)">
    <i class="fas fa-print"></i> Print TRS
  </button>`);
  // WhatsApp — opens web.whatsapp.com with a pre-filled summary message.
  // User picks the contact in the WhatsApp UI itself, so no number
  // prompt is needed here.
  leftBtns.push(`<button class="btn btn-sm" onclick="shareTrsWhatsApp(${r.id})" title="Share TRS summary via WhatsApp Web"
    style="background:#25D366;color:#fff;border:none">
    <i class="fab fa-whatsapp"></i> WhatsApp
  </button>`);
  if(canEdit){
    rightBtns.push(`<button class="btn btn-sm" style="background:#0ea5e9;color:#fff;border:none" onclick="saveTrsDetail(${r.id})"><i class="fas fa-save"></i> Save Changes</button>`);
  }
  const canDelete = (r.approval_status === 'Pending') || isAdmin;
  if(canDelete){
    rightBtns.push(`<button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:rgba(239,68,68,.4)" onclick="deleteTrs(${r.id})"><i class="fas fa-trash"></i> Delete</button>`);
  }
  rightBtns.push(`<button class="btn btn-outline btn-sm" onclick="closeModal('trsDetailModal')">Close</button>`);
  actions.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap">${leftBtns.join('')}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto">${rightBtns.join('')}</div>
  `;
}

async function saveTrsDetail(trsId){
  const payload = {};
  const ps = document.getElementById('trs-detail-physical_state');
  if(ps) payload.physical_state = ps.value;
  const sq = document.getElementById('trs-detail-sample_qty');
  if(sq && sq.value !== '') payload.sample_qty = parseFloat(sq.value) || 0;
  const vb = document.getElementById('trs-detail-verified_by');
  if(vb) payload.verified_by = vb.value;
  const cn = document.getElementById('trs-detail-client_name');
  if(cn) payload.client_name = cn.value;
  try {
    const res = await fetch(`/api/pm_stock/trs/${trsId}/update`, {
      method:  'POST',
      headers: { 'Content-Type':'application/json' },
      body:    JSON.stringify(payload),
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Update failed','error', 4500);
      return;
    }
    if(window.showToast) showToast('✓ TRS updated','success');
    closeModal('trsDetailModal');
    loadTrsList();
  } catch(e){
    if(window.showToast) showToast('Network error: ' + e.message,'error');
  }
}
window.saveTrsDetail = saveTrsDetail;

async function deleteTrs(trsId){
  if(!confirm('Delete this TRS? Associated observation report (if any) will also be deleted. This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/pm_stock/trs/${trsId}/delete`, { method: 'POST' });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Delete failed','error', 4500);
      return;
    }
    if(window.showToast) showToast('✓ TRS deleted','success');
    closeModal('trsDetailModal');
    loadTrsList();
    // Refresh GRN badges if an edit-GRN modal is currently open
    const egrn = document.getElementById('egrn-id');
    if(egrn && egrn.value){
      loadTrsBadgesForGrn(parseInt(egrn.value) || 0);
    }
  } catch(e){
    if(window.showToast) showToast('Network error: ' + e.message,'error');
  }
}
window.deleteTrs = deleteTrs;

// ════════════════════════════════════════════════════════════════════
// SECTION 4.5 — Print + WhatsApp share
// ════════════════════════════════════════════════════════════════════

/**
 * Open the TRS PDF in a new tab. The server renders the PDF with
 * Content-Disposition: inline, so most browsers open it in a tab
 * where the user can print or download from the built-in viewer.
 */
function printTrs(trsId){
  if(!trsId) return;
  const url = `/api/pm_stock/trs/${trsId}/pdf`;
  // We use noopener+noreferrer so the new tab can't reach back into
  // this page's window object. Some browsers block window.open in a
  // promise chain — we're synchronous here so it's fine.
  window.open(url, '_blank', 'noopener,noreferrer');
}
window.printTrs = printTrs;

/**
 * Share TRS summary via WhatsApp Web. Builds a multi-line text
 * summary + a deep-link back to this TRS's detail page, then opens
 * web.whatsapp.com/send?text=... so the user can pick a contact.
 * (No PDF attachment — wa.me doesn't support file attachments via
 * URL anyway, only text. PDF is available as a separate Print button.)
 */
async function shareTrsWhatsApp(trsId){
  // Fetch the latest snapshot so the message reflects current state
  // (avoids stale data if the modal was opened a while ago).
  try {
    const res = await fetch(`/api/pm_stock/trs/${trsId}`);
    const d = await res.json();
    if(d.status !== 'ok'){
      if(window.showToast) showToast(d.message || 'Failed to load TRS','error');
      return;
    }
    const r = d.trs || {};
    const dmy = s => {
      if(!s) return '—';
      const ten = String(s).slice(0,10).split('-');
      return ten.length === 3 ? `${ten[2]}/${ten[1]}/${ten[0]}` : String(s);
    };
    const fmtNum = n => {
      const v = Number(n);
      return isFinite(v) ? v.toLocaleString('en-IN') : '—';
    };
    // Build the message. Keep it readable in WhatsApp (uses *bold*
    // markdown which WhatsApp supports natively).
    const lines = [];
    lines.push(`*🧪 TRS ${r.trs_num || ''}*`);
    lines.push(`Status: *${r.approval_status || 'Pending'}*`);
    lines.push('');
    lines.push(`*Item:* ${r.material || '—'}`);
    if(r.product_code) lines.push(`Code: \`${r.product_code}\``);
    lines.push(`*GRN:* ${r.grn_num || '—'} (${dmy(r.grn_date)})`);
    lines.push('');
    lines.push(`📦 Boxes: *${fmtNum(r.no_of_box)}*  ·  Per box: *${fmtNum(r.qty_per_pkg)}*`);
    lines.push(`📊 Total Qty: *${fmtNum(r.total_qty)} ${r.uom || ''}*`);
    lines.push(`🏭 Supplier: ${r.supplier_name || '—'}${r.new_or_old === 'NEW' ? ' _(NEW)_' : ''}`);
    if(r.previous_supplier){
      lines.push(`   Previously: ${r.previous_supplier}`);
    }
    lines.push('');
    lines.push(`Physical State: ${r.physical_state || 'OK'}  ·  Sample Qty: ${fmtNum(r.sample_qty)}`);
    if(r.client_name) lines.push(`Client: ${r.client_name}`);
    lines.push(`Verified By: ${r.verified_by || r.generated_by || '—'}`);
    if(r.approval_status === 'Approved' && r.approved_by){
      lines.push('');
      lines.push(`✅ Approved by *${r.approved_by}*`);
      if(r.approval_dt) lines.push(`   At: ${r.approval_dt}`);
    } else if(r.approval_status === 'Rejected'){
      lines.push('');
      lines.push(`❌ Rejected${r.approved_by ? ' by ' + r.approved_by : ''}`);
      if(r.rejection_reason) lines.push(`   Reason: ${r.rejection_reason}`);
    }
    // Link back to the TRS. The browser-side route is the same SPA
    // page; we just add a hash so loadTrsList can deep-link on load.
    const url = `${window.location.origin}/pm_stock#trs/${trsId}`;
    lines.push('');
    lines.push(`🔗 ${url}`);

    const text = lines.join('\n');
    const waUrl = `https://web.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  } catch(e){
    if(window.showToast) showToast('Failed to build WhatsApp message: ' + e.message,'error');
  }
}
window.shareTrsWhatsApp = shareTrsWhatsApp;

// ════════════════════════════════════════════════════════════════════
// SECTION 5 — Initial chip styling
// ════════════════════════════════════════════════════════════════════
function _trsInitChips(){
  if(document.getElementById('trs-f-all')){
    trsSetFilter('All');
  }
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', _trsInitChips);
} else {
  _trsInitChips();
}
