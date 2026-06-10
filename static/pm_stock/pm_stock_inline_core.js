/* ════════════════════════════════════════════════════════════════════════
   pm_stock_inline_core.js
   Extracted from pm_stock.html inline <script> blocks for maintainability.
   Each section below was previously a standalone inline block; concatenated
   here in original order so initialization sequencing is preserved.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Was inline block 2: Theme system, ledger modal, common utilities ── */
/* ═══════════════════════════════════════════════════════════
   THEME SYSTEM (matches procurement)
═══════════════════════════════════════════════════════════ */
const THEMES = ['light'];
function cycleTheme(){
  // PM Stock is locked to light theme — theme switching disabled on this page
  document.documentElement.setAttribute('data-theme','light');
}
// Ctrl+D disabled on this page
document.addEventListener('keydown', e => {
  if((e.ctrlKey||e.metaKey) && e.key==='d'){ e.preventDefault(); }
});

// ── Alt-key shortcuts for the GRN tab action buttons ─────────────
// Alt+B → New GRN, Alt+E → New Delivery Note, Alt+T → Voucher #,
// Alt+P → Voucher Permissions, Alt+Z → Recycle Bin, Alt+O → Reprint Approvals.
// These run alongside the master Alt-handler in pm_stock_main.js (those
// keys aren't claimed there, so there's no conflict). Each shortcut clicks
// the corresponding button if it exists & is visible — that way the same
// role gating that hides the button (PM-role / non-admin) automatically
// gates the shortcut too without us re-checking permissions here.
document.addEventListener('keydown', e => {
  if(!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Don't fire when typing in inputs
  const tag = document.activeElement?.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const k = (e.key || '').toLowerCase();
  let handler = null;
  switch(k){
    case 'b': handler = () => document.getElementById('btn-new-grn')?.click(); break;
    case 'e': handler = () => document.getElementById('btn-new-dn')?.click();  break;
    case 'j': handler = () => (typeof openAllotmentPicker === 'function') && openAllotmentPicker(); break;
    case 'u': handler = () => { window.location.href = '/pm_stock/audit'; }; break;
    case 't': handler = () => (typeof pmvOpenVoucherSettings === 'function') && pmvOpenVoucherSettings(); break;
    case 'p': handler = () => (typeof openVoucherPermsModal    === 'function') && openVoucherPermsModal();    break;
    case 'z': handler = () => (typeof openRecycleBinModal      === 'function') && openRecycleBinModal();      break;
    case 'o': handler = () => (typeof openReprintApprovalsModal=== 'function') && openReprintApprovalsModal();break;
  }
  if(!handler) return;
  e.preventDefault();
  // For T/P/Z/O — only fire if the corresponding button is currently visible
  // (i.e. role gates pass). For B/E we already click the button so an
  // explicit display:'none' on it just makes the click a no-op.
  const visGate = {
    t: () => document.querySelector('button[onclick="pmvOpenVoucherSettings()"]'),
    p: () => document.querySelector('button[onclick="openVoucherPermsModal()"]'),
    z: () => document.querySelector('button[onclick="openRecycleBinModal()"]'),
    o: () => document.getElementById('reprint-approvals-btn'),
  };
  if(visGate[k]){
    const btn = visGate[k]();
    if(!btn || btn.offsetParent === null) return;  // hidden / not in DOM
  }
  handler();
});

/* ═══════════════════════════════════════════════════════════
   ROLE + VOUCHER PERMISSIONS
   - window.__pmRole is the authoritative role string ('admin','PM','user',…)
   - window.__pmIsAdmin() returns true ONLY when role is admin
   - window.__pmVoucherPerms is the live map { grn, mtv, dn, opening }
   - applyVoucherPerms() shows/hides forms+banners based on the map
═══════════════════════════════════════════════════════════ */
// Default-permissive until fetch returns
window.__pmVoucherPerms = { grn:true, mtv:true, dn:true, opening:true };

async function loadVoucherPerms(){
  try {
    const res = await fetch('/api/pm_stock/voucher_permissions');
    const d   = await res.json();
    if(d && d.status === 'ok' && d.permissions){
      window.__pmVoucherPerms = Object.assign(
        { grn:true, mtv:true, dn:true, opening:true },
        d.permissions
      );
    }
  } catch(_){ /* fall through with defaults */ }
  applyVoucherPerms();
}

function applyVoucherPerms(){
  const isAdm = window.__pmIsAdmin();
  const p     = window.__pmVoucherPerms || {};
  const setPair = (formId, bannerId, allowed) => {
    const form   = document.getElementById(formId);
    const banner = document.getElementById(bannerId);
    if(form)   form.style.display   = allowed ? '' : 'none';
    if(banner) banner.style.display = allowed ? 'none' : '';
  };
  // MTV — Material OUT form on the Movement tab
  setPair('mout-form-card', 'mout-disabled-banner', isAdm || p.mtv !== false);
  // GRN — New GRN button row (gate the button itself, banner sits above the table)
  const grnBtn = document.getElementById('btn-new-grn');
  if(grnBtn) grnBtn.style.display = (isAdm || p.grn !== false) ? '' : 'none';
  const grnBanner = document.getElementById('grn-disabled-banner');
  if(grnBanner) grnBanner.style.display = (isAdm || p.grn !== false) ? 'none' : '';
  // DN — New DN button
  const dnBtn = document.getElementById('btn-new-dn');
  if(dnBtn) dnBtn.style.display = (isAdm || p.dn !== false) ? '' : 'none';
  const dnBanner = document.getElementById('dn-disabled-banner');
  if(dnBanner) dnBanner.style.display = (isAdm || p.dn !== false) ? 'none' : '';
  // Opening Stock — Add Product / Import buttons on Products tab
  const addBtn  = document.getElementById('btn-add-product');
  const impBtn  = document.getElementById('btn-import-product');
  const opAllow = isAdm || p.opening !== false;
  if(addBtn) addBtn.style.display = opAllow ? '' : 'none';
  if(impBtn) impBtn.style.display = opAllow ? '' : 'none';
  const opBanner = document.getElementById('opening-disabled-banner');
  if(opBanner) opBanner.style.display = opAllow ? 'none' : '';
}

// Wrappers that check perms before opening creation modals. We hook these AFTER
// pm_stock_main.js loads (it defines openAddProductModal). The wrappers read
// the live perms map; admins always pass through.
document.addEventListener('DOMContentLoaded', () => { loadVoucherPerms(); });

/* ═══════════════════════════════════════════════════════════
   VOUCHER PERMISSIONS ADMIN MODAL
═══════════════════════════════════════════════════════════ */
async function openVoucherPermsModal(){
  if(!window.__pmIsAdmin()){ if(typeof showToast==='function') showToast('Admin only','error'); return; }
  const m = document.getElementById('voucherPermsModal');
  if(!m) return;
  m.classList.add('open');
  await loadVoucherPerms();
  await loadPmSettings();
  renderVoucherPermsRows();
  renderPmSettingsRows();
}
function renderVoucherPermsRows(){
  const wrap = document.getElementById('vperms-rows');
  if(!wrap) return;
  const p = window.__pmVoucherPerms || {};
  const rows = [
    { key:'grn',     label:'GRN (Goods Receipt Note)',         icon:'📥', tint:'#0d9488' },
    { key:'mtv',     label:'MTV (Material Transfer / OUT)',    icon:'📦', tint:'#f59e0b' },
    { key:'dn',      label:'DN (Delivery Note)',               icon:'🚚', tint:'#6366f1' },
    { key:'opening', label:'Opening Stock (Add Product)',      icon:'🆕', tint:'#7c3aed' }
  ];
  wrap.innerHTML = rows.map(r => {
    const enabled = (p[r.key] !== false);
    return `
      <div style="display:flex;align-items:center;gap:14px;padding:12px 14px;border:1.5px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;background:var(--hsurf,#fff)">
        <div style="font-size:20px">${r.icon}</div>
        <div style="flex:1">
          <div style="font-size:12.5px;font-weight:800;color:var(--htxtb,#111)">${r.label}</div>
          <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px">
            ${enabled ? 'Non-admin users CAN create new vouchers of this type.' : 'Non-admin users are BLOCKED from creating new vouchers of this type.'}
          </div>
        </div>
        <label style="position:relative;display:inline-block;width:46px;height:24px;cursor:pointer">
          <input type="checkbox" ${enabled?'checked':''} onchange="toggleVoucherPerm('${r.key}', this.checked, this)"
            style="opacity:0;width:0;height:0">
          <span style="position:absolute;inset:0;background:${enabled?'#16a34a':'#cbd5e1'};border-radius:20px;transition:.2s;
            box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.05)"></span>
          <span style="position:absolute;top:3px;left:${enabled?'25px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;
            box-shadow:0 1px 3px rgba(0,0,0,.25);transition:.2s"></span>
        </label>
      </div>
    `;
  }).join('');
}
async function toggleVoucherPerm(key, enabled, el){
  if(!window.__pmIsAdmin()) return;
  // Optimistic UI
  const prev = (window.__pmVoucherPerms || {})[key];
  window.__pmVoucherPerms[key] = !!enabled;
  renderVoucherPermsRows();
  try {
    const res = await fetch('/api/pm_stock/voucher_permissions', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ voucher_type:key, enabled: !!enabled })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      window.__pmVoucherPerms[key] = (prev !== false);
      renderVoucherPermsRows();
      if(typeof showToast==='function') showToast(d.message || 'Update failed','error');
      return;
    }
    if(typeof showToast==='function') showToast(`✓ ${key.toUpperCase()} ${enabled?'enabled':'disabled'} for non-admins`,'success');
    applyVoucherPerms();
  } catch(e){
    window.__pmVoucherPerms[key] = (prev !== false);
    renderVoucherPermsRows();
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

/* ─── Behavior settings (key/value) ────────────────────────────
   Currently exposes: grn_verify_required.
   The map is exposed as window.__pmSettings so other modules
   (saveGrn, voucher log render) can branch on it without an
   extra fetch. Defaults are permissive (false) until first load. */
window.__pmSettings = { grn_verify_required: false };

async function loadPmSettings(){
  try {
    const res = await fetch('/api/pm_stock/settings');
    const d   = await res.json();
    if(d && d.status === 'ok' && d.settings){
      window.__pmSettings = Object.assign({ grn_verify_required:false }, d.settings);
    }
  } catch(_){ /* fall through with defaults */ }
}

function renderPmSettingsRows(){
  const wrap = document.getElementById('vsettings-rows');
  if(!wrap) return;
  const s = window.__pmSettings || {};
  const rows = [
    {
      key: 'grn_verify_required',
      label: 'GRN box-scan verification',
      icon: '🔍',
      tint: '#0ea5e9',
      onText:  'GRN saves WITHOUT posting stock. Operator must scan every box and confirm totals to post inward stock.',
      offText: 'GRN saves and posts inward stock immediately on save (legacy behavior).',
    }
  ];
  wrap.innerHTML = rows.map(r => {
    const enabled = !!s[r.key];
    return `
      <div style="display:flex;align-items:center;gap:14px;padding:12px 14px;border:1.5px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;background:var(--hsurf,#fff)">
        <div style="font-size:20px">${r.icon}</div>
        <div style="flex:1">
          <div style="font-size:12.5px;font-weight:800;color:var(--htxtb,#111)">${r.label}</div>
          <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px;line-height:1.5">
            ${enabled ? r.onText : r.offText}
          </div>
        </div>
        <label style="position:relative;display:inline-block;width:46px;height:24px;cursor:pointer">
          <input type="checkbox" ${enabled?'checked':''} onchange="togglePmSetting('${r.key}', this.checked)"
            style="opacity:0;width:0;height:0">
          <span style="position:absolute;inset:0;background:${enabled?'#0ea5e9':'#cbd5e1'};border-radius:20px;transition:.2s;
            box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.05)"></span>
          <span style="position:absolute;top:3px;left:${enabled?'25px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;
            box-shadow:0 1px 3px rgba(0,0,0,.25);transition:.2s"></span>
        </label>
      </div>
    `;
  }).join('');
}

async function togglePmSetting(key, enabled){
  if(!window.__pmIsAdmin()) return;
  const prev = !!(window.__pmSettings || {})[key];
  window.__pmSettings[key] = !!enabled;
  renderPmSettingsRows();
  try {
    const res = await fetch('/api/pm_stock/settings', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key, value: !!enabled })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      window.__pmSettings[key] = prev;
      renderPmSettingsRows();
      if(typeof showToast==='function') showToast(d.message || 'Update failed','error');
      return;
    }
    if(typeof showToast==='function'){
      const niceLabel = (key === 'grn_verify_required') ? 'GRN verification' : key;
      showToast(`✓ ${niceLabel} ${enabled?'enabled':'disabled'}`,'success');
    }
  } catch(e){
    window.__pmSettings[key] = prev;
    renderPmSettingsRows();
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

// Load settings once at page boot so non-admin saveGrn can read the toggle
// state without extra round-trips. Failure here just leaves defaults in place.
document.addEventListener('DOMContentLoaded', () => { loadPmSettings(); });

/* ═══════════════════════════════════════════════════════════
   RECYCLE BIN (Phase 1)
   - Admin-only soft-delete browser
   - Filter by entity type, status, deleter, date range
   - View payload, restore, hard-purge actions
═══════════════════════════════════════════════════════════ */
function openRecycleBinModal(){
  if(!window.__pmIsAdmin()){ if(typeof showToast==='function') showToast('Admin only','error'); return; }
  const m = document.getElementById('recycleBinModal');
  if(!m) return;
  m.classList.add('open');
  loadRecycleBin();
}
function rbinClearFilters(){
  ['rbin-entity-type','rbin-status','rbin-deleted-by','rbin-from','rbin-to'].forEach(id => {
    const el = document.getElementById(id); if(!el) return;
    if(el.tagName === 'SELECT'){ el.value = (id==='rbin-status' ? 'active' : ''); }
    else el.value = '';
  });
  loadRecycleBin();
}

async function loadRecycleBin(){
  const tbody = document.getElementById('rbin-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const et = (document.getElementById('rbin-entity-type')?.value || '').trim();
  const st = (document.getElementById('rbin-status')?.value || 'active').trim();
  const db = (document.getElementById('rbin-deleted-by')?.value || '').trim();
  const fr = (document.getElementById('rbin-from')?.value || '').trim();
  const to = (document.getElementById('rbin-to')?.value || '').trim();
  if(et) params.append('entity_type', et);
  if(st) params.append('status', st);
  if(db) params.append('deleted_by', db);
  if(fr) params.append('from_date', fr);
  if(to) params.append('to_date', to);
  try {
    const res = await fetch('/api/pm_stock/recycle_bin?' + params.toString());
    const d   = await res.json();
    const cnt = document.getElementById('rbin-count');
    if(d.status !== 'ok'){
      tbody.innerHTML = `<tr><td colspan="7" class="no-data" style="color:#dc2626">${d.message || 'load failed'}</td></tr>`;
      if(cnt) cnt.textContent = '';
      return;
    }
    if(cnt) cnt.textContent = `${d.count || 0} entr${d.count === 1 ? 'y' : 'ies'}`;
    window._binEntries = d.entries || [];
    if(_pag && _pag.bin) _pag.bin.page = 1;
    renderBinList();
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="7" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Paginated renderer — slices window._binEntries by _pag.bin.
function renderBinList(){
  const tbody = document.getElementById('rbin-tbody');
  if(!tbody) return;
  const entries = window._binEntries || [];
  if(!entries.length){
    tbody.innerHTML = `<tr><td colspan="7" class="no-data">No entries.</td></tr>`;
    const pag = document.getElementById('binPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const typeMap = {
    grn:      { label: 'GRN',         color: '#0d9488' },
    dn:       { label: 'DN',          color: '#6366f1' },
    mtv:      { label: 'Legacy MTV',  color: '#f59e0b' },
    transfer: { label: 'Transfer',    color: '#7c3aed' }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const p = paginate(entries, 'bin');
  tbody.innerHTML = p.slice.map(e => {
      const t = typeMap[e.entity_type] || { label: e.entity_type || '?', color: '#6b7280' };
      const statusBadge = e.restored_at
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:#16a34a1a;color:#16a34a;border:1px solid #16a34a44">Restored</span>`
        : `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:#f59e0b1a;color:#92400e;border:1px solid #f59e0b44">Active</span>`;
      const restoreBtn = e.restored_at
        ? `<button disabled style="background:#e5e7eb;border:1px solid #d1d5db;color:#9ca3af;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:not-allowed;font-family:inherit">↶ Restored</button>`
        : `<button onclick="restoreFromBin(${e.bin_id})" style="background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.3);color:#16a34a;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">↶ Restore</button>`;
      return `
        <tr>
          <td style="font-family:monospace;font-weight:700">#${e.bin_id}</td>
          <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${t.color}1a;color:${t.color};border:1px solid ${t.color}44">${t.label}</span></td>
          <td>
            <div style="font-weight:700;font-size:12px;color:var(--htxtb,#111)">${esc(e.entity_label || '—')}</div>
            <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px">${esc(e.payload_summary || '')}</div>
            ${e.reason ? `<div style="font-size:10px;color:#7c3aed;margin-top:2px"><i>Reason: ${esc(e.reason)}</i></div>` : ''}
          </td>
          <td style="font-size:11px">${esc(e.deleted_by || '—')}</td>
          <td style="font-size:10.5px;color:var(--hmuted,#9ca3af)">${fmtDateTime(e.deleted_at)}</td>
          <td>${statusBadge}${e.restored_at ? `<div style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-top:3px">by ${esc(e.restored_by||'')}</div>` : ''}</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="viewBinPayload(${e.bin_id})" title="View raw payload" style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.3);color:#6366f1;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">👁 View</button>
            ${restoreBtn}
            <button onclick="purgeFromBin(${e.bin_id})" title="Permanently delete (irreversible)" style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">🗑 Purge</button>
          </td>
        </tr>
      `;
    }).join('');
  renderPag('binPag', 'bin', p.total, p.pages, p.page);
}

async function viewBinPayload(binId){
  const meta = document.getElementById('rbin-detail-meta');
  const pre  = document.getElementById('rbin-detail-payload');
  if(meta) meta.textContent = `Bin entry #${binId} — loading…`;
  if(pre)  pre.textContent  = 'Loading…';
  document.getElementById('rbinDetailModal')?.classList.add('open');
  try {
    const res = await fetch(`/api/pm_stock/recycle_bin/${binId}`);
    const d   = await res.json();
    if(d.status !== 'ok'){
      if(pre) pre.textContent = `Error: ${d.message || 'failed'}`;
      return;
    }
    const e = d.entry || {};
    if(meta){
      meta.innerHTML = `<strong>${e.entity_type || '?'}</strong> · ${e.entity_label || '—'} · deleted by ${e.deleted_by || '—'} on ${fmtDateTime(e.deleted_at)}${e.restored_at ? ` · <span style="color:#16a34a">restored</span> on ${e.fmtDateTime(restored_at)}` : ''}`;
    }
    if(pre){
      try {
        pre.textContent = JSON.stringify(e.payload_parsed, null, 2);
      } catch(_) {
        pre.textContent = e.payload || '(empty)';
      }
    }
  } catch(err){
    if(pre) pre.textContent = `Error: ${err.message}`;
  }
}

async function restoreFromBin(binId){
  if(!confirm(`Restore bin entry #${binId}?\n\nThis re-creates the original rows. If the row IDs are still in use elsewhere, the restore will fail.`)) return;
  try {
    const res = await fetch('/api/pm_stock/recycle_bin/restore', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ bin_id: binId })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(typeof showToast==='function') showToast(d.message || 'Restore failed','error', 6000);
      else alert('Restore failed: ' + (d.message || ''));
      return;
    }
    if(typeof showToast==='function') showToast(`✓ Restored ${d.entity_type} #${d.entity_id || ''}`, 'success', 4000);
    loadRecycleBin();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

async function purgeFromBin(binId){
  if(!confirm(`PERMANENTLY DELETE bin entry #${binId}?\n\nThis is irreversible — the data will be gone forever and cannot be restored.\n\nProceed only if you are certain.`)) return;
  if(!confirm('Final confirmation: this CANNOT be undone. Click OK to permanently delete, Cancel to abort.')) return;
  try {
    const res = await fetch('/api/pm_stock/recycle_bin/purge', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ bin_id: binId })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(typeof showToast==='function') showToast(d.message || 'Purge failed','error');
      return;
    }
    if(typeof showToast==='function') showToast(`Purged bin entry #${binId}`, 'success');
    loadRecycleBin();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

/* ═══════════════════════════════════════════════════════════
   LABEL REPRINT APPROVAL (Phase 1)
   - Non-admins request reprint → admin approves → user prints
   - Admin sees pending count badge that polls every 30s
   - Non-admins see their own pending+approved count badge
═══════════════════════════════════════════════════════════ */
window._reqrepCtx = null;  // pending request payload while user fills reason

function isAdminUser(){ return (window.__pmRole === 'admin'); }

// Open request reprint modal — called by GRN/Opening label flows for non-admins
function openRequestReprintModal(ctx){
  // ctx = {
  //   scope_type, voucher_kind, voucher_id, voucher_label,
  //   allow_edits (bool),
  //   product_id, godown_id (required when allow_edits=true),
  //   current_no_of_box, current_per_box_qty (for "current values" display)
  // }
  window._reqrepCtx = ctx;
  const summary = document.getElementById('reqrep-summary');
  if(summary){
    summary.innerHTML = `
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#92400e;margin-bottom:4px">Reprint scope</div>
      <div style="font-weight:700">${ctx.voucher_label || '—'}</div>
      <div style="font-size:10.5px;color:var(--hmuted2,#6b7280);margin-top:3px">${ctx.scope_type === 'voucher_grn' ? 'GRN labels' : ctx.scope_type === 'voucher_op' ? 'Opening Stock labels' : 'Specific boxes'}</div>`;
  }
  const reason = document.getElementById('reqrep-reason');
  if(reason) reason.value = '';

  // Edit section
  const editSection = document.getElementById('reqrep-edit-section');
  const editEnable  = document.getElementById('reqrep-enable-edit');
  const editFields  = document.getElementById('reqrep-edit-fields');
  const newNobInp   = document.getElementById('reqrep-new-nob');
  const newPbqInp   = document.getElementById('reqrep-new-pbq');
  const curVals     = document.getElementById('reqrep-current-vals');
  const newTotalEl  = document.getElementById('reqrep-new-total');

  if(newNobInp) newNobInp.value = '';
  if(newPbqInp) newPbqInp.value = '';
  if(editEnable) editEnable.checked = false;
  if(editFields) editFields.style.display = 'none';
  if(newTotalEl) newTotalEl.textContent = 'New total: —';

  if(ctx.allow_edits && editSection){
    editSection.style.display = '';
    if(curVals){
      const cnob = ctx.current_no_of_box;
      const cpbq = ctx.current_per_box_qty;
      const ctot = (Number(cnob)||0) * (Number(cpbq)||0);
      curVals.innerHTML = (cnob != null && cpbq != null)
        ? `Current: <strong>${cnob}</strong> box × <strong>${(Number(cpbq)||0).toLocaleString('en-IN')}</strong> = <strong>${ctot.toLocaleString('en-IN')}</strong> total qty`
        : 'Current values not available';
    }
  } else if(editSection){
    editSection.style.display = 'none';
  }

  document.getElementById('requestReprintModal')?.classList.add('open');
  setTimeout(() => reason?.focus(), 100);
}

function reqrepToggleEdit(){
  const en = document.getElementById('reqrep-enable-edit')?.checked;
  const editFields = document.getElementById('reqrep-edit-fields');
  if(editFields) editFields.style.display = en ? '' : 'none';
  if(en){
    // Pre-fill with current values so user can tweak instead of typing from scratch
    const ctx = window._reqrepCtx || {};
    const nobInp = document.getElementById('reqrep-new-nob');
    const pbqInp = document.getElementById('reqrep-new-pbq');
    if(nobInp && !nobInp.value && ctx.current_no_of_box != null) nobInp.value = ctx.current_no_of_box;
    if(pbqInp && !pbqInp.value && ctx.current_per_box_qty != null) pbqInp.value = ctx.current_per_box_qty;
    reqrepRecomputeTotal();
  }
}

function reqrepRecomputeTotal(){
  const nob = parseFloat(document.getElementById('reqrep-new-nob')?.value || 0);
  const pbq = parseFloat(document.getElementById('reqrep-new-pbq')?.value || 0);
  const el  = document.getElementById('reqrep-new-total');
  if(!el) return;
  if(nob > 0 && pbq > 0){
    el.innerHTML = `New total: <strong style="color:#7c3aed">${(nob*pbq).toLocaleString('en-IN')}</strong>`;
  } else {
    el.textContent = 'New total: —';
  }
}

async function submitReprintRequest(){
  const ctx = window._reqrepCtx;
  if(!ctx) return;
  const reason = (document.getElementById('reqrep-reason')?.value || '').trim();
  if(!reason){
    if(typeof showToast==='function') showToast('A reason is required','error');
    return;
  }
  // Optional edit fields
  let editPayload = {};
  const editEnabled = !!document.getElementById('reqrep-enable-edit')?.checked;
  if(editEnabled && ctx.allow_edits){
    const nob = parseInt(document.getElementById('reqrep-new-nob')?.value || 0, 10);
    const pbq = parseFloat(document.getElementById('reqrep-new-pbq')?.value || 0);
    if(!(nob > 0) || !(pbq > 0)){
      if(typeof showToast==='function') showToast('Enter valid new no. of box and per-box qty (both > 0), or uncheck the edit option','error', 5000);
      return;
    }
    editPayload = {
      product_id:      ctx.product_id,
      godown_id:       ctx.godown_id,
      new_no_of_box:   nob,
      new_per_box_qty: pbq
    };
  }
  const btn = document.getElementById('reqrep-submit-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    const body = Object.assign({}, {
      scope_type:    ctx.scope_type,
      voucher_kind:  ctx.voucher_kind,
      voucher_id:    ctx.voucher_id,
      voucher_label: ctx.voucher_label,
      box_codes:     ctx.box_codes || [],
      reason:        reason
    }, editPayload);
    const res = await fetch('/api/pm_stock/reprint/request', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(typeof showToast==='function') showToast(d.message || 'Failed','error', 5000);
      return;
    }
    if(typeof showToast==='function') showToast(`✓ Request #${d.req_id} submitted. An admin will review it shortly.`, 'success', 5500);
    closeModal('requestReprintModal');
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = 'Submit Request'; }
  }
}

// Wrapper: non-admins requesting a reprint of GRN labels for a saved GRN
function requestGrnLabelReprint(grnId, grnNo){
  if(isAdminUser()){
    // Admin path: open the Edit GRN modal so they can hit "Print Labels" inside it
    if(typeof openEditGrn === 'function'){
      openEditGrn(grnId);
      if(typeof showToast==='function') showToast('Open the labels view from the Edit GRN modal to reprint.', 'info', 4500);
    } else if(typeof showToast==='function') showToast('Edit modal unavailable','error');
    return;
  }
  openRequestReprintModal({
    scope_type:    'voucher_grn',
    voucher_kind:  'grn',
    voucher_id:    grnId,
    voucher_label: 'GRN ' + (grnNo || '#'+grnId)
  });
}

// Wrapper: non-admins requesting reprint of an Opening Stock label batch
function requestOpeningLabelReprint(opLabel, opSeq, productName){
  if(isAdminUser()){
    if(typeof showToast==='function') showToast('Admins can print directly. (Opening label re-rendering not yet exposed in this view.)','info');
    return;
  }
  openRequestReprintModal({
    scope_type:    'voucher_op',
    voucher_kind:  'op',
    voucher_id:    opSeq,
    voucher_label: opLabel + (productName ? ' · ' + productName : '')
  });
}

// ── Admin: Reprint Approvals modal ───────────────────────────────────
async function openReprintApprovalsModal(){
  if(!isAdminUser()) return;
  document.getElementById('reprintApprovalsModal')?.classList.add('open');
  loadReprintApprovals();
}

async function loadReprintApprovals(){
  const tbody = document.getElementById('rapr-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const st  = document.getElementById('rapr-status')?.value || '';
  const usr = (document.getElementById('rapr-user')?.value || '').trim();
  if(st)  params.append('status', st);
  if(usr) params.append('requested_by', usr);
  try {
    const res = await fetch('/api/pm_stock/reprint/requests?' + params.toString());
    const d   = await res.json();
    const cnt = document.getElementById('rapr-count');
    if(d.status !== 'ok'){
      tbody.innerHTML = `<tr><td colspan="9" class="no-data" style="color:#dc2626">${d.message || 'load failed'}</td></tr>`;
      if(cnt) cnt.textContent = '';
      return;
    }
    if(cnt) cnt.textContent = `${d.count || 0} request${d.count === 1 ? '' : 's'}`;
    window._raprList = d.requests || [];
    if(_pag && _pag.pendreq) _pag.pendreq.page = 1;
    renderPendingReprintReqs();
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="9" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Paginated renderer — slices window._raprList by _pag.pendreq.
function renderPendingReprintReqs(){
  const tbody = document.getElementById('rapr-tbody');
  if(!tbody) return;
  const list = window._raprList || [];
  if(!list.length){
    tbody.innerHTML = `<tr><td colspan="9" class="no-data">No requests match the filters.</td></tr>`;
    const pag = document.getElementById('pendreqPag'); if(pag) pag.innerHTML = '';
    if(typeof _updateRaprBulkBar === 'function') _updateRaprBulkBar();
    return;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const typeBadge = (r) => {
    const t = r.scope_type === 'voucher_grn' ? { label: 'GRN', color: '#0d9488' }
            : r.scope_type === 'voucher_op'  ? { label: 'Opening', color: '#7c3aed' }
            : { label: 'Boxes', color: '#6b7280' };
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${t.color}1a;color:${t.color};border:1px solid ${t.color}44">${t.label}</span>`;
  };
  const statusBadge = (s) => {
    const m = { pending: ['#f59e0b','Pending'], approved: ['#16a34a','Approved'], printed: ['#3b82f6','Printed'], rejected: ['#dc2626','Rejected'] };
    const [c, lbl] = m[s] || ['#6b7280', s || '—'];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${c}1a;color:${c};border:1px solid ${c}44">${lbl}</span>`;
  };
  const p = paginate(list, 'pendreq');
  tbody.innerHTML = p.slice.map(r => {
      const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
      const isEdit = (r.new_no_of_box != null && r.new_per_box_qty != null);
      const editBlock = isEdit
        ? `<div style="margin-top:5px;padding:4px 8px;background:rgba(124,58,237,.08);border-left:3px solid #7c3aed;border-radius:4px;font-size:10px;color:var(--htxtb,#111)">
             <strong style="color:#7c3aed">⚠ EDIT REPRINT</strong> · new dimensions:
             <strong>${fmtN(r.new_no_of_box)}</strong> box × <strong>${fmtN(r.new_per_box_qty)}</strong>
             = <strong>${fmtN((Number(r.new_no_of_box)||0) * (Number(r.new_per_box_qty)||0))}</strong> total qty
             <div style="font-size:9.5px;color:#92400e;margin-top:2px">Approving will allow the requester to recreate boxes &amp; update ledger.</div>
           </div>`
        : '';
      const isPending = r.status === 'pending';
      return `
      <tr>
        <td style="text-align:center;width:34px">${
          isPending
            ? `<input type="checkbox" class="rapr-pick" data-rid="${r.req_id}" onchange="_updateRaprBulkBar()" style="cursor:pointer;width:16px;height:16px">`
            : ''
        }</td>
        <td style="font-family:monospace;font-weight:700">#${r.req_id}</td>
        <td>${typeBadge(r)}</td>
        <td><div style="font-weight:700;font-size:12px">${esc(r.voucher_label || '—')}</div>${editBlock}</td>
        <td style="font-size:11px;color:var(--htxtb,#111);max-width:240px"><i>${esc(r.reason || '')}</i></td>
        <td style="font-size:11px">${esc(r.requested_by || '—')}</td>
        <td style="font-size:10.5px;color:var(--hmuted,#9ca3af)">${fmtDateTime(r.requested_at)}</td>
        <td>${statusBadge(r.status)}${r.approved_by ? `<div style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-top:3px">by ${esc(r.approved_by)}</div>` : ''}</td>
        <td style="text-align:center;white-space:nowrap">
          ${isPending
            ? `<button onclick="approveReprintRequest(${r.req_id})" style="background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.3);color:#16a34a;border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:4px">✓ Approve</button>
               <button onclick="rejectReprintRequest(${r.req_id})" style="background:rgba(220,38,38,.1);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">✕ Reject</button>`
            : (r.decided_note ? `<div style="font-size:10px;color:var(--hmuted2,#6b7280);font-style:italic">${esc(r.decided_note)}</div>` : '<span style="color:var(--hmuted,#9ca3af);font-size:10px">—</span>')}
        </td>
      </tr>`;
    }).join('');
  renderPag('pendreqPag', 'pendreq', p.total, p.pages, p.page);
  if(typeof _updateRaprBulkBar === 'function') _updateRaprBulkBar();
}

/* ── Bulk-approve helpers ──────────────────────────────────────────
   _updateRaprBulkBar runs whenever a checkbox changes. It updates the
   selected count badge and enables/disables the "Approve N selected"
   button.

   _raprToggleAll wires the header checkbox to flip every visible row's
   checkbox at once, so admin can select all then unselect a few rather
   than ticking 20 by hand.

   approveSelectedReprintRequests sends the chosen ids in a single
   request to /reprint/approve_bulk and refreshes the modal on success. */
function _updateRaprBulkBar(){
  const picks = Array.from(document.querySelectorAll('.rapr-pick:checked'));
  const btn   = document.getElementById('rapr-bulk-approve-btn');
  const cnt   = document.getElementById('rapr-bulk-count');
  const n     = picks.length;
  if(btn){
    btn.disabled = (n === 0);
    btn.style.opacity = n === 0 ? .55 : 1;
    btn.textContent = n === 0 ? '✓ Approve Selected' : `✓ Approve Selected (${n})`;
  }
  if(cnt) cnt.textContent = n === 0 ? '' : `${n} selected`;
  // Reflect header checkbox state
  const totalPickable = document.querySelectorAll('.rapr-pick').length;
  const head = document.getElementById('rapr-pick-all');
  if(head){
    head.checked = (totalPickable > 0 && n === totalPickable);
    head.indeterminate = (n > 0 && n < totalPickable);
  }
}

function _raprToggleAll(checked){
  document.querySelectorAll('.rapr-pick').forEach(cb => { cb.checked = !!checked; });
  _updateRaprBulkBar();
}

async function approveSelectedReprintRequests(){
  const ids = Array.from(document.querySelectorAll('.rapr-pick:checked'))
    .map(cb => parseInt(cb.dataset.rid, 10))
    .filter(Number.isFinite);
  if(!ids.length) return;
  const note = prompt(
    `Optional note for the requester(s) — applies to all ${ids.length} approval(s) (leave blank to skip):`, ''
  );
  if(note === null) return;
  const btn = document.getElementById('rapr-bulk-approve-btn');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Approving…'; }
  try {
    const res = await fetch('/api/pm_stock/reprint/approve_bulk', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ req_ids: ids, note: note || '' })
    });
    const d = await res.json();
    if(d.status !== 'ok'){
      if(typeof showToast==='function') showToast(d.message || 'Bulk approve failed','error');
      return;
    }
    if(typeof showToast==='function'){
      const msg = d.skipped
        ? `✓ ${d.approved} approved · ${d.skipped} skipped`
        : `✓ ${d.approved} request${d.approved===1?'':'s'} approved`;
      showToast(msg, 'success', 3500);
    }
    loadReprintApprovals();
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  } finally {
    if(btn){ btn.disabled = false; }
  }
}

async function approveReprintRequest(reqId){
  const note = prompt('Optional note for the requester (leave blank to skip):', '');
  if(note === null) return; // cancelled
  try {
    const res = await fetch(`/api/pm_stock/reprint/${reqId}/approve`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ note: note || '' })
    });
    const d = await res.json();
    if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Failed','error'); return; }
    if(typeof showToast==='function') showToast(`✓ Approved request #${reqId}`,'success');
    loadReprintApprovals();
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

async function rejectReprintRequest(reqId){
  const note = prompt('Reason for rejection (will be visible to the requester):', '');
  if(note === null) return;
  try {
    const res = await fetch(`/api/pm_stock/reprint/${reqId}/reject`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ note: note || '' })
    });
    const d = await res.json();
    if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Failed','error'); return; }
    if(typeof showToast==='function') showToast(`Rejected request #${reqId}`,'success');
    loadReprintApprovals();
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

// ── Non-admin: My Reprint Requests modal ─────────────────────────────
async function openMyReprintRequestsModal(){
  document.getElementById('myReprintRequestsModal')?.classList.add('open');
  loadMyReprintRequests();
}

/* Render the actions cell for one row in the user's My-Reprint modal.
   Three cases:

   1) status='approved' WITH per-box tracking (box_status non-empty) →
      Render each unprinted box as its own "Print" button. Already-printed
      boxes show as greyed-out "✓ Printed at HH:MM" lines. When all boxes
      are done, the parent row flips to 'printed' on the next refresh and
      this case stops applying.

   2) status='approved' WITHOUT per-box tracking (legacy approvals from
      before this code shipped) → single "Print Now" button that uses
      the bulk redeem path (whole voucher in one shot, as before).

   3) Any other status (pending / rejected / printed) → dash. */
function _renderMyReprintActions(r, esc){
  if(r.status !== 'approved' || !r.print_token){
    return '<span style="color:var(--hmuted,#9ca3af);font-size:10px">—</span>';
  }
  const boxStatus = Array.isArray(r.box_status) ? r.box_status : [];
  if(boxStatus.length === 0){
    // Legacy bulk-print path
    return `<button onclick="redeemAndPrint(${r.req_id},'${esc(r.print_token)}','${esc(r.scope_type)}','${esc(r.voucher_kind || '')}',${r.voucher_id || 'null'})"
              style="background:#16a34a;color:#fff;border:none;border-radius:5px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">
              <i class="fas fa-print"></i> Print Now
            </button>`;
  }
  // Per-box rendering — one row per box, with its own print button
  const unprintedCount = boxStatus.filter(b => !b.printed).length;
  const totalCount     = boxStatus.length;
  const headerLine = `<div style="font-size:10px;font-weight:700;color:#5b21b6;margin-bottom:5px">
    📦 ${totalCount - unprintedCount} of ${totalCount} printed${unprintedCount === 0 ? ' ✓' : ''}
  </div>`;
  const rows = boxStatus.map(b => {
    if(b.printed){
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:10.5px;color:var(--hmuted,#9ca3af)">
        <span style="font-family:monospace;text-decoration:line-through;flex:1">${esc(b.box_code)}</span>
        <span style="color:#16a34a;font-weight:700;white-space:nowrap">✓ Printed</span>
      </div>`;
    }
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:10.5px">
      <span style="font-family:monospace;font-weight:700;flex:1">${esc(b.box_code)}</span>
      <button onclick="redeemAndPrintOneBox(${r.req_id},'${esc(r.print_token)}','${esc(b.box_code)}','${esc(r.scope_type)}','${esc(r.voucher_kind || '')}',${r.voucher_id || 'null'})"
              style="background:#16a34a;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
        <i class="fas fa-print"></i> Print
      </button>
    </div>`;
  }).join('');
  return headerLine + rows;
}

async function loadMyReprintRequests(){
  const tbody = document.getElementById('myrep-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="no-data">Loading…</td></tr>`;
  try {
    const res = await fetch('/api/pm_stock/reprint/requests');
    const d   = await res.json();
    if(d.status !== 'ok'){
      tbody.innerHTML = `<tr><td colspan="6" class="no-data" style="color:#dc2626">${d.message || 'load failed'}</td></tr>`;
      return;
    }
    window._myrepList = d.requests || [];
    if(_pag && _pag.myreq) _pag.myreq.page = 1;
    renderMyReprintReqs();
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="6" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Paginated renderer — slices window._myrepList by _pag.myreq.
function renderMyReprintReqs(){
  const tbody = document.getElementById('myrep-tbody');
  if(!tbody) return;
  const list = window._myrepList || [];
  if(!list.length){
    tbody.innerHTML = `<tr><td colspan="6" class="no-data">No reprint requests yet.</td></tr>`;
    const pag = document.getElementById('myreqPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const typeBadge = (r) => {
    const t = r.scope_type === 'voucher_grn' ? { label: 'GRN', color: '#0d9488' }
            : r.scope_type === 'voucher_op'  ? { label: 'Opening', color: '#7c3aed' }
            : { label: 'Boxes', color: '#6b7280' };
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${t.color}1a;color:${t.color};border:1px solid ${t.color}44">${t.label}</span>`;
  };
  const statusBadge = (s) => {
    const m = { pending: ['#f59e0b','Pending'], approved: ['#16a34a','Approved · Ready'], printed: ['#3b82f6','Printed'], rejected: ['#dc2626','Rejected'] };
    const [c, lbl] = m[s] || ['#6b7280', s || '—'];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${c}1a;color:${c};border:1px solid ${c}44">${lbl}</span>`;
  };
  window._myrepHelpers = { esc };
  const p = paginate(list, 'myreq');
  tbody.innerHTML = p.slice.map(r => {
      const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
      const isEdit = (r.new_no_of_box != null && r.new_per_box_qty != null);
      const editLine = isEdit
        ? `<div style="font-size:10px;color:#7c3aed;margin-top:3px"><strong>⚠ Edit:</strong> ${fmtN(r.new_no_of_box)} × ${fmtN(r.new_per_box_qty)} = ${fmtN((Number(r.new_no_of_box)||0)*(Number(r.new_per_box_qty)||0))} total</div>`
        : '';
      return `
      <tr>
        <td style="font-family:monospace;font-weight:700">#${r.req_id}</td>
        <td>${typeBadge(r)}</td>
        <td><div style="font-weight:700;font-size:12px">${esc(r.voucher_label || '—')}</div>
            <div style="font-size:10px;color:var(--hmuted,#9ca3af);margin-top:2px"><i>${esc(r.reason || '')}</i></div>
            ${editLine}
            ${r.decided_note ? `<div style="font-size:10px;color:#7c3aed;margin-top:3px">Note: ${esc(r.decided_note)}</div>` : ''}</td>
        <td style="font-size:10.5px;color:var(--hmuted,#9ca3af)">${fmtDateTime(r.requested_at)}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="text-align:left;white-space:normal;min-width:280px">
          ${_renderMyReprintActions(r, esc)}
        </td>
      </tr>`;
    }).join('');
  renderPag('myreqPag', 'myreq', p.total, p.pages, p.page);
}

/* Per-box redeem & print.

   Consumes ONE box within an approved request. The parent request stays
   'approved' until every box has been printed (then it flips to 'printed'
   automatically).

   Print mechanics:
   - For OP scope: reconstructs the printOpeningLabels payload via the
     existing /op_batches/payload endpoint, then slices box_codes down to
     just the box being reprinted. Single label rendered.
   - For GRN scope: opens the legacy GRN edit modal. The user clicks
     "Print Labels" inside to fire the print. The per-box DB consumption
     has already happened, so the next time the user opens My-Reprint the
     printed box shows as ✓ Printed.
   (GRN single-label print is a follow-up — needs a GRN-side payload
   endpoint that takes a box_code filter.) */
async function redeemAndPrintOneBox(reqId, token, boxCode, scopeType, voucherKind, voucherId){
  if(!confirm(`Print label for box ${boxCode}? Once printed, this box can't be re-printed without a new approval (other boxes in this request remain available).`)) return;
  try {
    // Step 1: redeem just this one box on the server
    const rres = await fetch(`/api/pm_stock/reprint/${reqId}/redeem`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token, box_code: boxCode })
    });
    const rd = await rres.json();
    if(rd.status !== 'ok'){
      if(typeof showToast==='function') showToast(rd.message || 'Per-box redeem failed','error', 5000);
      return;
    }
    if(typeof showToast==='function') showToast(`✓ Approved box ${boxCode}. Printing…`, 'success', 3000);

    if(scopeType === 'voucher_op' && voucherId){
      // Reconstruct OP payload and print just this one box
      try {
        const hint = (window._opbatRedeemHint || {})[voucherId] || {};
        const params = new URLSearchParams({ op_seq: voucherId });
        if(hint.product_id) params.set('product_id', hint.product_id);
        if(hint.godown_id)  params.set('godown_id',  hint.godown_id);
        const pres = await fetch('/api/pm_stock/op_batches/payload?' + params.toString());
        const pdata = await pres.json();
        if(pdata.status !== 'ok' || !pdata.box_codes?.length){
          if(typeof showToast==='function') showToast('Redeem ok, but batch payload missing: ' + (pdata.message || 'no boxes'), 'error', 6000);
          return;
        }
        // Slice payload to just this one box. Most label render functions
        // honour the box_codes array length, so a single-entry array
        // produces a single label.
        const sliced = Object.assign({}, pdata, {
          box_codes: [boxCode],
          no_of_box: 1,
          per_box_qtys: Array.isArray(pdata.per_box_qtys) ? [pdata.per_box_qtys[0]] : null,
        });
        if(typeof printOpeningLabels === 'function'){
          printOpeningLabels(sliced);
        } else if(typeof showToast==='function'){
          showToast('Redeem ok, but print function unavailable — refresh page.', 'error');
        }
      } catch(e){
        if(typeof showToast==='function') showToast('Redeem ok but print failed: ' + e.message, 'error');
      }
    } else if(scopeType === 'voucher_grn' && voucherId){
      // For GRN, fall back to opening the edit modal. The box is already
      // marked printed in the DB, so the user sees correct status next
      // time they open My-Reprint. They click "Print Labels" inside the
      // GRN modal to fire the actual print (which prints all labels —
      // limitation of the current GRN render path, follow-up needed).
      if(typeof openEditGrn === 'function'){
        if(typeof showToast==='function') showToast('Per-box approval redeemed. Opening GRN — click "Print Labels" inside.', 'success', 6000);
        openEditGrn(voucherId);
      } else if(typeof showToast==='function'){
        showToast('Redeemed, but edit modal unavailable.', 'error');
      }
    } else {
      if(typeof showToast==='function') showToast('Approved, but no print handler for this scope.', 'success');
    }

    // Refresh the my-reprint table so the box now shows as ✓ Printed and
    // disappears from the unprinted list. Don't close the modal — the
    // user may want to print the next box in the same request.
    loadMyReprintRequests();
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error: ' + e.message, 'error');
  }
}

async function redeemAndPrint(reqId, token, scopeType, voucherKind, voucherId){
  if(!confirm('Print these labels now? Approval is single-use — once you redeem it, you cannot re-print without a new approval.')) return;
  try {
    // First load the request details so we know whether it has edit fields
    const lres = await fetch('/api/pm_stock/reprint/requests');
    const ld   = await lres.json();
    let reqDetail = null;
    if(ld && ld.status === 'ok' && Array.isArray(ld.requests)){
      reqDetail = ld.requests.find(r => r.req_id === reqId) || null;
    }
    const isEdit = reqDetail
      && reqDetail.new_no_of_box != null
      && reqDetail.new_per_box_qty != null
      && reqDetail.product_id != null;

    // ── Selective request: skip the legacy /redeem call and instead
    //    POST directly to the selective endpoint, supplying the saved
    //    selections + the request_token. The endpoint atomically
    //    applies the rebuild AND marks the request as printed.
    const isSelective = !!(reqDetail
      && reqDetail.selections
      && Array.isArray(reqDetail.selections.selections)
      && reqDetail.selections.selections.length);
    if(isSelective){
      const sel     = reqDetail.selections.selections;
      const removed = Array.isArray(reqDetail.selections.removed_box_ids)
        ? reqDetail.selections.removed_box_ids : [];
      let url, body;
      if(scopeType === 'voucher_grn'){
        url  = `/api/pm_stock/grn/${voucherId}/reprint_labels_selective`;
        body = {
          request_token:    token,
          request_req_id:   reqId,
          product_id:       reqDetail.product_id,
          selections:       sel,
          removed_box_ids:  removed,
          reason:           'Approved selective request #' + reqId,
        };
      } else if(scopeType === 'voucher_op'){
        url  = `/api/pm_stock/op_batches/${voucherId}/reprint_selective`;
        body = {
          request_token:    token,
          request_req_id:   reqId,
          product_id:       reqDetail.product_id,
          godown_id:        reqDetail.godown_id,
          selections:       sel,
          removed_box_ids:  removed,
          reason:           'Approved selective request #' + reqId,
        };
      } else {
        if(typeof showToast==='function') showToast('Selective requests must target a voucher','error');
        return;
      }
      const res = await fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const txt = await res.text();
      let d = null;
      try { d = txt ? JSON.parse(txt) : null; } catch(_){ d = null; }
      if(!d){
        const hint = (res.status === 404)
          ? 'Endpoint not found — has the server been restarted?'
          : (res.status === 401 || res.status === 403) ? 'Not authorised — token may be invalid or already used.'
          : (res.status >= 500) ? 'Server error — see Flask log.'
          : `HTTP ${res.status}`;
        if(typeof showToast==='function') showToast(hint, 'error', 6000); return;
      }
      if(!res.ok || d.status !== 'ok'){
        if(typeof showToast==='function') showToast(d.message || 'Selective reprint failed','error', 6000);
        return;
      }
      if(typeof showToast==='function') showToast('✓ Approved selective reprint applied. Printing…','success', 3500);
      // Build a ctx so _sbrFirePrint can render labels with the right metadata.
      const ctx = (scopeType === 'voucher_grn')
        ? {
            kind: 'grn',
            grn_id: voucherId,
            grn_no: d.grn_no || reqDetail.voucher_label || '',
            grn_date: d.grn_date || '',
            product_id: d.product_id, product_code: d.product_code,
            product_name: d.product_name, pm_type: d.pm_type, brand_name: d.brand_name,
            supplier_text: '—', invoice_no: '—', invoice_date: '',
            supervisor: (window._currentUser || ''),
          }
        : {
            kind: 'op',
            op_seq: voucherId,
            op_label: d.op_label || reqDetail.voucher_label || ('PM-OP/' + String(voucherId).padStart(4,'0')),
            op_date: '',
            godown_id: d.godown_id,
            product_id: d.product_id, product_code: d.product_code,
            product_name: d.product_name, pm_type: d.pm_type, brand_name: d.brand_name,
          };
      if(typeof window._sbrFirePrint === 'function'){
        window._sbrFirePrint(ctx, d);
      } else if(typeof _sbrFirePrint === 'function'){
        _sbrFirePrint(ctx, d);
      } else {
        if(typeof showToast==='function') showToast('Reprint applied but the print previewer is missing — refresh the page.','error');
      }
      closeModal('myReprintRequestsModal');
      refreshReprintBadge();
      return;
    }

    if(isEdit && scopeType === 'voucher_op'){
      // Edit reprint for OP — POST to op_batches/<seq>/reprint_with_edits.
      // The endpoint internally validates the token and marks request as printed.
      const res = await fetch(`/api/pm_stock/op_batches/${voucherId}/reprint_with_edits`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          req_id: reqId, token: token,
          product_id: reqDetail.product_id,
          godown_id:  reqDetail.godown_id,
          new_no_of_box:   reqDetail.new_no_of_box,
          new_per_box_qty: reqDetail.new_per_box_qty
        })
      });
      const d = await res.json();
      if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Edit reprint failed','error', 6000); return; }
      if(typeof showToast==='function') showToast(`✓ Approved & edited · ${d.no_of_box}×${d.per_box_qty}. Printing…`,'success', 4000);
      if(typeof printOpeningLabels === 'function'){
        printOpeningLabels(d);
      }
      closeModal('myReprintRequestsModal');
      refreshReprintBadge();
      return;
    }
    if(isEdit && scopeType === 'voucher_grn'){
      // Edit reprint for GRN
      const res = await fetch(`/api/pm_stock/grn/${voucherId}/reprint_labels_with_edits`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          req_id: reqId, token: token,
          product_id: reqDetail.product_id,
          new_no_of_box:   reqDetail.new_no_of_box,
          new_per_box_qty: reqDetail.new_per_box_qty
        })
      });
      const d = await res.json();
      if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Edit reprint failed','error', 6000); return; }
      if(typeof showToast==='function') showToast(`✓ Approved & edited · ${d.no_of_box}×${d.per_box_qty}. Open GRN to print labels.`,'success', 6500);
      if(typeof openEditGrn === 'function'){
        openEditGrn(voucherId);
      }
      closeModal('myReprintRequestsModal');
      refreshReprintBadge();
      return;
    }

    // Pure reprint path (no edits) — original flow
    const res = await fetch(`/api/pm_stock/reprint/${reqId}/redeem`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token })
    });
    const d = await res.json();
    if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Redeem failed','error', 5000); return; }
    if(scopeType === 'voucher_grn' && voucherKind === 'grn' && voucherId){
      if(typeof openEditGrn === 'function'){
        if(typeof showToast==='function') showToast('Approval redeemed. Opening GRN — click "Print Labels" inside to fire the print.','success', 6000);
        openEditGrn(voucherId);
      } else {
        if(typeof showToast==='function') showToast('Approved, but edit modal unavailable. Refresh and try again.','error');
      }
    } else if(scopeType === 'voucher_op' && voucherId){
      try {
        const hint = (window._opbatRedeemHint || {})[voucherId] || {};
        const params = new URLSearchParams({ op_seq: voucherId });
        if(hint.product_id) params.set('product_id', hint.product_id);
        if(hint.godown_id)  params.set('godown_id',  hint.godown_id);
        const pres = await fetch('/api/pm_stock/op_batches/payload?' + params.toString());
        const pdata = await pres.json();
        if(pdata.status !== 'ok' || !pdata.box_codes?.length){
          if(typeof showToast==='function') showToast('Approval redeemed but could not load batch boxes: ' + (pdata.message || 'no boxes'), 'error', 6000);
        } else if(typeof printOpeningLabels === 'function'){
          if(typeof showToast==='function') showToast('Approval redeemed. Printing labels…','success', 3000);
          printOpeningLabels(pdata);
        } else {
          if(typeof showToast==='function') showToast('Approved, but print function unavailable. Refresh and try again.','error');
        }
      } catch(e){
        if(typeof showToast==='function') showToast('Approval redeemed but print failed: ' + e.message, 'error');
      }
    } else {
      if(typeof showToast==='function') showToast('Approval redeemed.','success');
    }
    closeModal('myReprintRequestsModal');
    refreshReprintBadge();
  } catch(e){
    if(typeof showToast==='function') showToast('Network error','error');
  }
}

// ── Notification badge polling ────────────────────────────────────────
async function refreshReprintBadge(){
  try {
    const res = await fetch('/api/pm_stock/reprint/pending_count');
    const d   = await res.json();
    if(d.status !== 'ok') return;
    const c = d.count || 0;
    const adminBadge = document.getElementById('reprint-approvals-badge');
    const userBadge  = document.getElementById('my-reprint-badge');
    if(adminBadge){
      adminBadge.style.display = c > 0 ? 'inline-block' : 'none';
      adminBadge.textContent   = c > 9 ? '9+' : String(c);
    }
    if(userBadge){
      userBadge.style.display = c > 0 ? 'inline-block' : 'none';
      userBadge.textContent   = c > 9 ? '9+' : String(c);
    }
  } catch(_){}
}
// Poll every 30s, plus once on load
setTimeout(refreshReprintBadge, 1500);
setInterval(() => { if(document.visibilityState === 'visible') refreshReprintBadge(); }, 30000);

/* ═══════════════════════════════════════════════════════════
   OP LABEL HISTORY — past batches + reprint
═══════════════════════════════════════════════════════════ */
window._opbatRedeemHint = window._opbatRedeemHint || {};

function openOpBatchesModal(){
  document.getElementById('opBatchesModal')?.classList.add('open');
  loadOpBatches();
}

function opbatClearFilters(){
  ['opbat-search','opbat-from','opbat-to'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  loadOpBatches();
}

async function loadOpBatches(){
  const tbody = document.getElementById('opbat-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const s  = (document.getElementById('opbat-search')?.value || '').trim();
  const fr = (document.getElementById('opbat-from')?.value   || '').trim();
  const to = (document.getElementById('opbat-to')?.value     || '').trim();
  if(s)  params.append('search', s);
  if(fr) params.append('from_date', fr);
  if(to) params.append('to_date', to);
  try {
    const res = await fetch('/api/pm_stock/op_batches/list?' + params.toString());
    const d   = await res.json();
    const cnt = document.getElementById('opbat-count');
    if(d.status !== 'ok'){
      tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${d.message || 'load failed'}</td></tr>`;
      if(cnt) cnt.textContent = '';
      return;
    }
    const list = d.batches || [];
    if(cnt) cnt.textContent = `${list.length} batch${list.length === 1 ? '' : 'es'}`;
    window._opbatList = list;
    if(_pag && _pag.opening) _pag.opening.page = 1;
    renderOpeningList();
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Paginated renderer — slices window._opbatList by _pag.opening.
function renderOpeningList(){
  const tbody = document.getElementById('opbat-tbody');
  if(!tbody) return;
  const list = window._opbatList || [];
  if(!list.length){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">No Opening Stock label batches yet.</td></tr>`;
    const pag = document.getElementById('openingPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const fmt2 = n => (Number(n)||0).toLocaleString('en-IN');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const p = paginate(list, 'opening');
  tbody.innerHTML = p.slice.map(b => {
      const isAdmin = isAdminUser();
      const safeLabel = (b.op_label || '').replace(/'/g,'');
      const safeProd  = (b.product_name || '').replace(/'/g,'');
      const action = isAdmin
        ? `<div style="display:inline-flex;gap:4px;align-items:center">
             <button onclick="opbatPrintNow(${b.op_seq},${b.product_id},${b.godown_id},${b.no_of_box},${b.per_box_qty})" title="Reprint all box labels" style="background:#16a34a;color:#fff;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit"><i class="fas fa-print"></i> Reprint</button>
             <button onclick="openSelectiveReprintForOp(${b.op_seq},${b.product_id},${b.godown_id})" title="Selective reprint — pick specific boxes, edit qty, add new" style="background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);color:#7c3aed;border-radius:5px;padding:5px 8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">🏷</button>
           </div>`
        : `<div style="display:inline-flex;gap:4px;align-items:center">
             <button onclick="openSelectiveReprintForOp(${b.op_seq},${b.product_id},${b.godown_id})" title="Selective reprint — pick boxes &amp; qty, then submit for admin approval" style="background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);color:#7c3aed;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit"><i class="fas fa-tags"></i> Selective Request</button>
             <button onclick="requestOpLabelReprintFromBatch(${b.op_seq},${b.product_id},${b.godown_id},'${safeLabel}','${safeProd}',${b.no_of_box},${b.per_box_qty})" title="Generic reprint request (no per-box selection)" style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:#d97706;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit"><i class="fas fa-clipboard-list"></i> Request</button>
           </div>`;
      return `
        <tr>
          <td><span style="font-family:monospace;font-size:11px;font-weight:700;color:#7c3aed;background:rgba(124,58,237,.08);padding:2px 8px;border-radius:4px;border:1px solid rgba(124,58,237,.2)">${esc(b.op_label)}</span></td>
          <td>
            <div style="font-weight:700;font-size:12px">${esc(b.product_name)}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:2px;font-size:10px;color:var(--hmuted,#9ca3af)">
              <span style="font-family:monospace;font-weight:700;color:#7c3aed">${esc(b.product_code)}</span>
              <span>·</span>
              <span>[${esc(b.pm_type || '-')}]</span>
              <span>${esc(b.brand_name || '')}</span>
            </div>
          </td>
          <td style="font-size:11px;color:var(--htxtb,#111)">${esc(b.godown_name || '—')}</td>
          <td class="num" style="font-family:monospace">${fmt2(b.no_of_box)}</td>
          <td class="num" style="font-family:monospace">${fmt2(b.per_box_qty)}</td>
          <td class="num" style="font-family:monospace;font-weight:800;color:#16a34a">${fmt2(b.total_qty)}</td>
          <td style="font-size:10.5px;color:var(--hmuted,#9ca3af)">${fmtDateTime(b.created_at)}<div style="font-size:9.5px">by ${esc(b.created_by || '—')}</div></td>
          <td style="text-align:center">${action}</td>
        </tr>`;
    }).join('');
  renderPag('openingPag', 'opening', p.total, p.pages, p.page);
}

// Non-admin: request reprint of a specific OP batch. Stores the
// (product_id, godown_id) hint so the redeem step can target the right batch.
function requestOpLabelReprintFromBatch(opSeq, productId, godownId, opLabel, productName, currentNob, currentPbq){
  // Cache the (product_id, godown_id) hint so redeem can retrieve them later
  window._opbatRedeemHint = window._opbatRedeemHint || {};
  window._opbatRedeemHint[opSeq] = { product_id: productId, godown_id: godownId };
  // Persist hint across reload via sessionStorage
  try {
    sessionStorage.setItem('opbatRedeemHint', JSON.stringify(window._opbatRedeemHint));
  } catch(_){}
  openRequestReprintModal({
    scope_type:          'voucher_op',
    voucher_kind:        'op',
    voucher_id:          opSeq,
    voucher_label:       opLabel + (productName ? ' · ' + productName : ''),
    allow_edits:         true,
    product_id:          productId,
    godown_id:           godownId,
    current_no_of_box:   currentNob,
    current_per_box_qty: currentPbq
  });
}

// Admin direct-reprint path (no approval needed). Optionally prompts for
// new dimensions; if user supplies them, calls the edit-reprint endpoint
// which recreates boxes and updates the ledger.
async function opbatPrintNow(opSeq, productId, godownId, currentNob, currentPbq){
  const baseMsg = `Reprint all labels for OP batch #${opSeq}?\n\n` +
    `Current: ${currentNob||'—'} box × ${currentPbq||'—'} = ${((currentNob||0)*(currentPbq||0)).toLocaleString('en-IN')} total\n\n` +
    `Click OK to reprint as-is.\n` +
    `Click Cancel to edit dimensions instead.`;
  const justReprint = confirm(baseMsg);
  if(justReprint){
    // Pure reprint — no data change
    try {
      const params = new URLSearchParams({
        op_seq: opSeq, product_id: productId, godown_id: godownId
      });
      const res = await fetch('/api/pm_stock/op_batches/payload?' + params.toString());
      const d   = await res.json();
      if(d.status !== 'ok' || !d.box_codes?.length){
        if(typeof showToast==='function') showToast(d.message || 'Could not load batch','error', 5000);
        return;
      }
      if(typeof printOpeningLabels === 'function'){
        if(typeof showToast==='function') showToast(`Loading ${d.no_of_box} labels…`,'info', 2000);
        printOpeningLabels(d);
      } else {
        if(typeof showToast==='function') showToast('Print function unavailable','error');
      }
    } catch(e){
      if(typeof showToast==='function') showToast('Error: ' + e.message, 'error');
    }
    return;
  }
  // Edit path — prompt for new dimensions
  const newNobStr = prompt(`New no. of box (current: ${currentNob}):`, String(currentNob || ''));
  if(newNobStr === null) return;
  const newPbqStr = prompt(`New per-box qty (current: ${currentPbq}):`, String(currentPbq || ''));
  if(newPbqStr === null) return;
  const newNob = parseInt(newNobStr, 10);
  const newPbq = parseFloat(newPbqStr);
  if(!(newNob > 0) || !(newPbq > 0)){
    if(typeof showToast==='function') showToast('Both values must be positive numbers','error');
    return;
  }
  const newTotal = newNob * newPbq;
  const oldTotal = (currentNob||0) * (currentPbq||0);
  if(!confirm(
    `Confirm edit reprint for OP batch #${opSeq}:\n\n` +
    `   Old: ${currentNob} box × ${currentPbq} = ${oldTotal.toLocaleString('en-IN')}\n` +
    `   New: ${newNob} box × ${newPbq} = ${newTotal.toLocaleString('en-IN')}\n\n` +
    `This will DELETE the existing box records and CREATE new ones with new codes, AND update the ledger opening qty to ${newTotal.toLocaleString('en-IN')}.\n\n` +
    `Old box records will go to the Recycle Bin (admin can restore).\n\n` +
    `Proceed?`
  )) return;
  try {
    const res = await fetch(`/api/pm_stock/op_batches/${opSeq}/reprint_with_edits`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        product_id: productId, godown_id: godownId,
        new_no_of_box: newNob, new_per_box_qty: newPbq
      })
    });
    const d = await res.json();
    if(d.status !== 'ok'){ if(typeof showToast==='function') showToast(d.message || 'Edit reprint failed','error', 6000); return; }
    if(typeof showToast==='function') showToast(`✓ OP batch updated · ${newNob}×${newPbq}. Loading print…`,'success', 3500);
    if(typeof printOpeningLabels === 'function'){
      printOpeningLabels(d);
    }
    // Refresh the batches list so the user sees the new dimensions
    if(document.getElementById('opBatchesModal')?.classList.contains('open')){
      setTimeout(loadOpBatches, 500);
    }
  } catch(e){
    if(typeof showToast==='function') showToast('Error: ' + e.message, 'error');
  }
}

// Restore opbat redeem hint cache on page load (so refresh-then-redeem still works)
try {
  const cached = sessionStorage.getItem('opbatRedeemHint');
  if(cached) window._opbatRedeemHint = Object.assign({}, JSON.parse(cached) || {});
} catch(_){}

/* ── Was inline block 3: Escape key handler for txnLedgerModal ── */
// Close on Escape
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    const m = document.getElementById('txnLedgerModal');
    if(m && m.classList.contains('open')) closeModal('txnLedgerModal');
  }
});

/* ── Was inline block 4: _postJson helper with proper error parsing ── */
(function(){
  'use strict';

  // Safely POST JSON and parse the response. Returns the parsed JSON
  // body on success; on failure throws an Error with a useful message.
  // We deliberately read .text() first because Flask's debug error pages
  // are HTML — calling .json() on them produces "Unexpected token '<'"
  // which is a useless message for the operator. With this wrapper the
  // toast says "Server returned HTML — endpoint missing or Flask not
  // restarted?" which is actionable.
  async function _allotPostJson(url, body){
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
    } catch(netErr){
      throw new Error('Network error: ' + (netErr.message || netErr));
    }
    const text = await res.text();
    const trimmed = (text || '').trimStart();
    // Flask error pages start with "<!DOCTYPE" or "<html" — treat that as
    // a routing/server problem, not a JSON parse error.
    if(trimmed.startsWith('<')){
      const hint = res.status === 404
        ? 'endpoint not found — Flask may need a restart to pick up new routes'
        : `server returned an HTML error page (HTTP ${res.status})`;
      throw new Error(hint);
    }
    try {
      return JSON.parse(text);
    } catch(_){
      throw new Error(`Bad JSON from server (HTTP ${res.status})`);
    }
  }

  // Build option list of godowns (mirrors _populateGodownSelects in
  // pm_stock_movement.js — keep in sync if that filtering changes).
  function _allotGodownOptions(){
    const list = (window._godowns || []);
    return list.map(g => {
      const isFloor = (g.godown_type === 'floor' || g.is_floor);
      const label   = isFloor ? `🏭 ${g.name}` : `📦 ${g.name}`;
      return `<option value="${g.id}">${_esc(label)}</option>`;
    }).join('');
  }

  function _esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
    );
  }

  function _enforceHomeLock(){
    // Same source-side lock that regular MTV uses: non-admin home users
    // can only allot FROM their home godown. Admins are unrestricted.
    const h = window._pmUserHome;
    const fromSel = document.getElementById('allot-from');
    if(!fromSel) return;
    if(!h || h.is_admin || !h.home_godown_id){
      fromSel.disabled = false;
      return;
    }
    fromSel.value = String(h.home_godown_id);
    fromSel.disabled = true;
    fromSel.title = 'Locked to your home godown';
  }

  window.openAllotmentPicker = function(){
    const modal = document.getElementById('allotmentPickerModal');
    if(!modal) return;
    // Populate selects each open (godown list may have changed)
    const opts = _allotGodownOptions();
    const fromSel = document.getElementById('allot-from');
    const toSel   = document.getElementById('allot-to');
    if(fromSel) fromSel.innerHTML = '<option value="">— Select source —</option>' + opts;
    if(toSel)   toSel.innerHTML   = '<option value="">— Select destination —</option>' + opts;
    // Clear remarks and scan input
    const rem = document.getElementById('allot-remarks');
    if(rem) rem.value = '';
    const scan = document.getElementById('allot-scan-input');
    if(scan) scan.value = '';
    // Apply home-godown lock for non-admin users
    _enforceHomeLock();
    // Reset banner & button state
    allotValidateForm();
    modal.classList.add('open');
    // Focus the scan input — that's the primary path
    setTimeout(() => {
      const s = document.getElementById('allot-scan-input');
      if(s) s.focus();
    }, 80);
  };

  // Scan handler: on Enter, calls /create_allotment_with_box. The
  // backend looks up the box, creates the allotment voucher (using the
  // box's current godown as From, and either the user-selected To or
  // From-as-To by default), records the OUT-side scan, and returns the
  // new transfer_id. We then pivot to the OUT voucher modal so the
  // operator can keep scanning more boxes via its existing scan input.
  window.allotHandleScanInput = async function(ev){
    if(!ev || ev.key !== 'Enter') return;
    ev.preventDefault();
    const input = document.getElementById('allot-scan-input');
    const code  = (input?.value || '').trim().toUpperCase();
    if(!code) return;
    // Optional cross-godown override: if user picked a To value before
    // scanning, send it. Otherwise leave to_godown_id off and let the
    // backend default to the box's current godown.
    const toSelVal = parseInt(document.getElementById('allot-to')?.value) || 0;
    const remarks  = (document.getElementById('allot-remarks')?.value || '').trim();
    const payload  = { box_code: code, remarks };
    if(toSelVal) payload.to_godown_id = toSelVal;

    // Disable input while in-flight to prevent double-submit
    if(input){ input.disabled = true; input.style.opacity = '.6'; }
    try {
      const d = await _allotPostJson('/api/pm_stock/transfers/voucher/create_allotment_with_box', payload);
      if(d.status !== 'ok'){
        if(typeof showToast === 'function') showToast(d.message || 'Scan failed', 'error', 4000);
        if(input){ input.value = ''; input.focus(); }
        return;
      }
      closeModal('allotmentPickerModal');
      if(typeof showToast === 'function'){
        const note = d.same_godown ? ' · same-godown' : '';
        showToast(`✓ ${d.transfer_no} created${note} · scanned ${d.scanned_box?.box_code || code}`, 'success', 3500);
      }
      if(typeof mvOpenOutVoucher === 'function'){
        await mvOpenOutVoucher(d.transfer_id);
      }
    } catch(e){
      if(typeof showToast === 'function') showToast('Error: ' + (e.message || e), 'error');
    } finally {
      if(input){
        input.disabled = false;
        input.style.opacity = '';
        input.value = '';
      }
    }
  };

  // Live-validates the picker. Enables/disables the Create button and
  // shows a subtle banner indicating whether this is a same-godown
  // allotment (consumption only — no IN stock posted) or cross-godown
  // (full out+in posting like a regular transfer).
  window.allotValidateForm = function(){
    const f = parseInt(document.getElementById('allot-from')?.value) || 0;
    const t = parseInt(document.getElementById('allot-to')?.value)   || 0;
    const btn = document.getElementById('allot-create-btn');
    const banner = document.getElementById('allot-mode-banner');
    const valid = !!(f && t);
    if(btn){
      btn.disabled = !valid;
      btn.style.opacity = valid ? '1' : '.5';
      btn.style.cursor  = valid ? 'pointer' : 'not-allowed';
    }
    if(banner){
      if(!valid){
        banner.style.display = 'none';
      } else if(f === t){
        banner.style.display = '';
        banner.style.background = 'rgba(245,158,11,.10)';
        banner.style.border     = '1px solid rgba(245,158,11,.30)';
        banner.style.color      = '#92400e';
        banner.innerHTML = '⚙️ <strong>Same-godown allotment</strong> — stock will be deducted from source on save (utilised in FG packing). No IN-side increment will be posted.';
      } else {
        banner.style.display = '';
        banner.style.background = 'rgba(13,148,136,.08)';
        banner.style.border     = '1px solid rgba(13,148,136,.25)';
        banner.style.color      = '#0d9488';
        banner.innerHTML = '↪️ <strong>Cross-godown allotment</strong> — behaves like a transfer (OUT decrements source, IN increments destination on save).';
      }
    }
  };

  window.allotCreateVoucher = async function(){
    const f = parseInt(document.getElementById('allot-from')?.value) || 0;
    const t = parseInt(document.getElementById('allot-to')?.value)   || 0;
    const remarks = (document.getElementById('allot-remarks')?.value || '').trim();
    if(!f || !t){
      if(typeof showToast === 'function') showToast('Pick both source and destination', 'error');
      return;
    }
    const btn = document.getElementById('allot-create-btn');
    const orig = btn ? btn.innerHTML : '';
    if(btn){
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
      btn.disabled = true;
    }
    try {
      const d = await _allotPostJson('/api/pm_stock/transfers/voucher/create_allotment', {
        from_godown_id: f, to_godown_id: t, remarks
      });
      if(d.status !== 'ok'){
        if(typeof showToast === 'function') showToast(d.message || 'Failed to create allotment', 'error');
        return;
      }
      // Success — close picker, open the OUT voucher modal for scanning
      closeModal('allotmentPickerModal');
      if(typeof showToast === 'function'){
        const note = d.same_godown ? ' (same-godown — OUT only)' : '';
        showToast(`✓ ${d.transfer_no} created${note}`, 'success', 3500);
      }
      if(typeof mvOpenOutVoucher === 'function'){
        await mvOpenOutVoucher(d.transfer_id);
      }
    } catch(e){
      if(typeof showToast === 'function') showToast('Error: ' + (e.message || e), 'error');
    } finally {
      if(btn){ btn.innerHTML = orig; btn.disabled = false; }
    }
  };

  // Enter inside the remarks field submits if the form is valid
  document.addEventListener('DOMContentLoaded', () => {
    const rem = document.getElementById('allot-remarks');
    if(rem){
      rem.addEventListener('keydown', e => {
        if(e.key === 'Enter'){
          e.preventDefault();
          const btn = document.getElementById('allot-create-btn');
          if(btn && !btn.disabled) allotCreateVoucher();
        }
      });
    }
    // Esc closes the picker (in addition to the global Esc handler)
    document.addEventListener('keydown', e => {
      if(e.key === 'Escape'){
        const m = document.getElementById('allotmentPickerModal');
        if(m && m.classList.contains('open')) closeModal('allotmentPickerModal');
      }
    });
  });
})();

/* ── Was inline block 5: _inboxPostJson + common In-Transit scan handler ── */
(function(){
  'use strict';

  async function _inboxPostJson(url, body){
    let res;
    try {
      res = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
    } catch(netErr){
      throw new Error('Network error: ' + (netErr.message || netErr));
    }
    const text = await res.text();
    const trimmed = (text || '').trimStart();
    if(trimmed.startsWith('<')){
      const hint = res.status === 404
        ? 'endpoint not found — Flask may need a restart to pick up new routes'
        : `server returned an HTML error page (HTTP ${res.status})`;
      throw new Error(hint);
    }
    try {
      return JSON.parse(text);
    } catch(_){
      throw new Error(`Bad JSON from server (HTTP ${res.status})`);
    }
  }

  function _esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
    );
  }

  function _setResult(html, tone){
    const el = document.getElementById('inbox-scan-result');
    if(!el) return;
    const colors = {
      info: 'var(--hmuted,#9ca3af)',
      ok:   '#0d9488',
      warn: '#d97706',
      err:  '#dc2626',
    };
    el.style.color = colors[tone] || colors.info;
    el.innerHTML = html;
  }

  // Briefly highlight the row in the in-transit list that matches the
  // routed voucher so the operator sees which one was hit.
  function _flashVoucherRow(transferNo){
    const list = document.getElementById('min-pending-list');
    if(!list) return;
    const rows = list.querySelectorAll('div[onclick^="mvOpenInVoucher"]');
    for(const r of rows){
      if(r.textContent.includes(transferNo)){
        const prev = r.style.boxShadow;
        r.style.transition = 'box-shadow .25s';
        r.style.boxShadow = '0 0 0 4px rgba(13,148,136,.35)';
        setTimeout(() => { r.style.boxShadow = prev || ''; }, 1200);
        r.scrollIntoView({behavior:'smooth', block:'center'});
        break;
      }
    }
  }

  window.inboxHandleScanInput = async function(ev){
    if(!ev || ev.key !== 'Enter') return;
    ev.preventDefault();
    const input = document.getElementById('inbox-scan-input');
    const code = (input?.value || '').trim().toUpperCase();
    if(!code) return;

    if(input){ input.disabled = true; input.style.opacity = '.6'; }
    _setResult(`🔍 Looking up <code style="font-family:monospace;font-weight:700">${_esc(code)}</code>…`, 'info');

    try {
      const d = await _inboxPostJson('/api/pm_stock/transfers/inbox/scan_box', { box_code: code });
      if(d.status !== 'ok'){
        if(typeof _voiceNotScanned === 'function') _voiceNotScanned();
        _setResult(`✗ ${_esc(d.message || 'scan failed')}`, 'err');
        if(typeof showToast === 'function') showToast(d.message || 'Scan failed', 'error', 4500);
        if(input){ input.value = ''; input.focus(); }
        return;
      }
      if(typeof _voiceScanned === 'function') _voiceScanned();
      const extraNote = d.was_extra ? ' <span style="color:#d97706;font-weight:700">(EXTRA — not in OUT batch)</span>' : '';
      const dupNote   = d.multiple_candidates ? ' <span style="color:#d97706;font-weight:700">· multiple candidates, picked oldest</span>' : '';
      _setResult(
        `✓ Routed <code style="font-family:monospace;font-weight:700">${_esc(d.box.box_code)}</code> · ${_esc(d.box.product_name || '')} → <strong>${_esc(d.transfer_no)}</strong>${extraNote}${dupNote}`,
        'ok'
      );
      if(typeof showToast === 'function'){
        showToast(`✓ ${d.box.box_code} → ${d.transfer_no}`, 'success', 2500);
      }
      if(typeof mvLoadInTransit === 'function'){
        await mvLoadInTransit();
        _flashVoucherRow(d.transfer_no);
      }
      if(typeof mvOpenInVoucher === 'function'){
        await mvOpenInVoucher(d.transfer_id);
      }
    } catch(e){
      if(typeof _voiceNotScanned === 'function') _voiceNotScanned();
      _setResult(`✗ ${_esc(e.message || e)}`, 'err');
      if(typeof showToast === 'function') showToast('Error: ' + (e.message || e), 'error', 4500);
    } finally {
      if(input){
        input.disabled = false;
        input.style.opacity = '';
        input.value = '';
        setTimeout(() => { try { input.focus(); } catch(_){} }, 200);
      }
    }
  };

  // Auto-focus the scan input when the IN sub-tab becomes visible.
  // mm-sub-in's display is toggled by mmSetSubTab — observe the style
  // attribute and refocus on show. Also focus once on initial load.
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('mm-sub-in');
    if(!panel) return;
    const focusInput = () => {
      const inp = document.getElementById('inbox-scan-input');
      if(inp && panel.style.display !== 'none') inp.focus();
    };
    setTimeout(focusInput, 250);
    const obs = new MutationObserver(muts => {
      for(const m of muts){
        if(m.attributeName === 'style'){
          setTimeout(focusInput, 80);
        }
      }
    });
    obs.observe(panel, { attributes: true, attributeFilter: ['style'] });
  });
})();

/* ── Was inline block 6: Godown cache + transfer helpers ── */
(function(){
  // Cached godown lookup (best-effort; fallback handles missing cache)
  function _gName(id){
    const list = (window._godowns || []);
    const g = list.find(x => Number(x.id) === Number(id));
    if(!g) return '—';
    const isFloor = (g.godown_type === 'floor' || g.is_floor || (g.type||'').toLowerCase()==='floor');
    const baseName = g.name || '—';
    return isFloor ? (baseName + ' (Factory)') : baseName;
  }
  function _fmtN(n){
    const v = Number(n) || 0;
    return v.toLocaleString('en-IN', {maximumFractionDigits: 3});
  }
  function _fmtDate(s){
    if(!s) return '—';
    const dt = String(s).slice(0,10).split('-');
    if(dt.length !== 3) return s;
    return `${dt[2]}/${dt[1]}/${dt[0]}`;
  }
  function _todayLocal(){
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tz).toISOString().slice(0,10);
  }

  // Public: open the modal and build for today's date
  window.openWaReportModal = function(){
    const modal = document.getElementById('waReportModal');
    if(!modal) return;
    const dateInp = document.getElementById('wa-report-date');
    if(dateInp && !dateInp.value) dateInp.value = _todayLocal();
    const phInp   = document.getElementById('wa-report-phone');
    if(phInp){
      // Restore last-used number for convenience
      try {
        const last = localStorage.getItem('pm_wa_last_phone');
        if(last && !phInp.value) phInp.value = last;
      } catch(e){}
    }
    modal.classList.add('open');
    waReportRebuild();
  };

  // Re-fetch and rebuild the report text for the chosen date
  window.waReportRebuild = async function(){
    const dateInp = document.getElementById('wa-report-date');
    const dateStr = (dateInp && dateInp.value) || _todayLocal();
    const includeItems = !!document.getElementById('wa-include-items')?.checked;

    const subtitle = document.getElementById('wa-report-subtitle');
    if(subtitle) subtitle.textContent = `Activity for ${_fmtDate(dateStr)}`;

    const loading = document.getElementById('wa-report-loading');
    const summary = document.getElementById('wa-report-summary');
    const txt     = document.getElementById('wa-report-text');
    if(loading) loading.style.display = '';
    if(summary) summary.innerHTML = '';
    if(txt) txt.value = '';

    try {
      // Fetch GRNs, Transfers, and label-print summary for the day in parallel
      const [grnRes, xferRes, labelRes] = await Promise.all([
        fetch(`/api/pm_stock/grn/list?from_date=${dateStr}&to_date=${dateStr}`).catch(()=>null),
        fetch(`/api/pm_stock/transfers/list?from_date=${dateStr}&to_date=${dateStr}`).catch(()=>null),
        fetch(`/api/pm_stock/labels/summary?from_date=${dateStr}&to_date=${dateStr}`).catch(()=>null),
      ]);

      let grns = [];
      if(grnRes && grnRes.ok){
        try { const j = await grnRes.json(); if(Array.isArray(j)) grns = j; } catch(e){}
      }
      let xfers = [];
      if(xferRes && xferRes.ok){
        try {
          const j = await xferRes.json();
          if(j && j.status==='ok' && Array.isArray(j.transfers)) xfers = j.transfers;
        } catch(e){}
      }
      // Labels: optional / may be unavailable on older deploys
      let labels = null;
      if(labelRes && labelRes.ok){
        try {
          const j = await labelRes.json();
          if(j && j.status === 'ok') labels = j;
        } catch(e){}
      }

      // Optionally fetch line items for each voucher when checkbox is on
      let grnDetails = {}, xferDetails = {};
      if(includeItems){
        // Cap parallel fetches to avoid storm; vouchers per day are usually low.
        const grnDetailPromises = grns.slice(0, 50).map(g =>
          fetch(`/api/pm_stock/grn/${g.id}`).then(r=>r.ok?r.json():null).catch(()=>null)
            .then(d => { if(d && !d.status) grnDetails[g.id] = d; else if(d && d.status==='ok') grnDetails[g.id] = d; })
        );
        const xferDetailPromises = xfers.slice(0, 50).map(t => {
          const tid = t.transfer_id || t.id;
          return fetch(`/api/pm_stock/transfers/${tid}/voucher_data?type=out`)
            .then(r=>r.ok?r.json():null).catch(()=>null)
            .then(d => { if(d && d.status==='ok') xferDetails[tid] = d; });
        });
        await Promise.all([...grnDetailPromises, ...xferDetailPromises]);
      }

      // Build summary chips
      const grnQty    = grns.reduce((s,r)=>s+(Number(r.total_qty)||0), 0);
      const grnBoxes  = grns.reduce((s,r)=>s+(Number(r.total_boxes)||0), 0);
      const xferQty   = xfers.reduce((s,r)=>s+(Number(r.total_qty)||0), 0);

      // Label-print totals (may be 0 if endpoint unavailable on this deploy)
      const lblTotal     = labels?.total_labels || 0;
      const lblEvents    = labels?.total_events || 0;
      const lblByKind    = labels?.by_kind || {};
      const lblGrnFresh  = (lblByKind.grn_fresh    || 0);
      const lblGrnReprt  = (lblByKind.grn_reprint  || 0) + (lblByKind.grn_selective || 0);
      const lblOpFresh   = (lblByKind.op_fresh     || 0);
      const lblOpReprt   = (lblByKind.op_reprint   || 0) + (lblByKind.op_selective  || 0);
      const lblDnFresh   = (lblByKind.dn_fresh     || 0);
      const lblManual    = (lblByKind.manual       || 0);

      // Break transfers down by status so the user can see, at a glance,
      // how many are still Draft (OUT only), In Transit, Received, Cancelled.
      // These four buckets mirror the stMap defined a few lines below — keep
      // the keys in sync if you ever add a new transfer status.
      const xferByStatus = { out_started:0, in_pending:0, received:0, cancelled:0, other:0 };
      const xferQtyByStatus = { out_started:0, in_pending:0, received:0, cancelled:0, other:0 };
      xfers.forEach(t => {
        const k = (t.status in xferByStatus) ? t.status : 'other';
        xferByStatus[k] += 1;
        xferQtyByStatus[k] += Number(t.total_qty || 0);
      });
      const fmtStat = (label, n, qty, color) =>
        n > 0
          ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:${color};font-weight:700"><span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block"></span>${label} ${n}${qty?` <span style="color:var(--hmuted,#9ca3af);font-weight:500">(${_fmtN(qty)})</span>`:''}</span>`
          : '';

      if(summary){
        const grandQty = grnQty + xferQty;
        summary.innerHTML = `
          <div style="flex:1 0 100%;padding:12px 16px;background:linear-gradient(135deg,rgba(37,211,102,.08),rgba(13,148,136,.05));border:1.5px solid rgba(13,148,136,.25);border-radius:10px">
            <div style="font-size:9.5px;color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Day Summary · ${_fmtDate(dateStr)}</div>
            <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline">
              <div><span style="font-size:22px;font-weight:800;color:var(--teal,#0d9488);font-family:monospace">${grns.length + xfers.length}</span> <span style="font-size:11px;color:var(--hmuted2,#6b7280);font-weight:700">total vouchers</span></div>
              <div><span style="font-size:16px;font-weight:800;color:var(--htxtb,#111);font-family:monospace">${_fmtN(grandQty)}</span> <span style="font-size:11px;color:var(--hmuted2,#6b7280);font-weight:700">total qty moved</span></div>
            </div>
          </div>
          <div style="flex:1;min-width:140px;padding:10px 14px;background:rgba(13,148,136,.06);border:1.5px solid rgba(13,148,136,.20);border-radius:8px">
            <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;letter-spacing:.4px">GRNs</div>
            <div style="font-size:18px;font-weight:800;color:var(--teal,#0d9488)">${grns.length}</div>
            <div style="font-size:10.5px;color:var(--hmuted2,#6b7280)">${_fmtN(grnQty)} pcs received${grnBoxes ? ` · <strong style="color:var(--htxtb,#111)">${_fmtN(grnBoxes)} boxes</strong>` : ''}</div>
          </div>
          <div style="flex:2;min-width:240px;padding:10px 14px;background:rgba(245,158,11,.06);border:1.5px solid rgba(245,158,11,.20);border-radius:8px">
            <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;letter-spacing:.4px">Material Transfers (Out / In)</div>
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
              <div style="font-size:18px;font-weight:800;color:#d97706">${xfers.length}</div>
              <div style="font-size:10.5px;color:var(--hmuted2,#6b7280)">${_fmtN(xferQty)} pcs moved</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;padding-top:5px;border-top:1px dashed rgba(245,158,11,.3)">
              ${fmtStat('Draft', xferByStatus.out_started, xferQtyByStatus.out_started, '#9ca3af')}
              ${fmtStat('In Transit', xferByStatus.in_pending, xferQtyByStatus.in_pending, '#d97706')}
              ${fmtStat('Received', xferByStatus.received, xferQtyByStatus.received, '#0d9488')}
              ${fmtStat('Cancelled', xferByStatus.cancelled, xferQtyByStatus.cancelled, '#dc2626')}
              ${xferByStatus.other ? fmtStat('Other', xferByStatus.other, xferQtyByStatus.other, '#6b7280') : ''}
              ${xfers.length === 0 ? '<span style="font-size:10.5px;color:var(--hmuted,#9ca3af);font-style:italic">no transfer activity</span>' : ''}
            </div>
          </div>
          <div style="flex:1;min-width:170px;padding:10px 14px;background:rgba(99,102,241,.06);border:1.5px solid rgba(99,102,241,.22);border-radius:8px">
            <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:800;text-transform:uppercase;letter-spacing:.4px">🖨️ Labels Printed</div>
            <div style="font-size:18px;font-weight:800;color:#4f46e5">${_fmtN(lblTotal)}</div>
            <div style="font-size:10.5px;color:var(--hmuted2,#6b7280)">${lblEvents ? `${_fmtN(lblEvents)} print events` : (labels ? 'no print activity' : 'data unavailable')}</div>
            ${lblTotal > 0 ? `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:5px;padding-top:5px;border-top:1px dashed rgba(99,102,241,.3)">
              ${(lblGrnFresh + lblGrnReprt) ? `<span style="font-size:10.5px;color:#4f46e5;font-weight:700">GRN ${_fmtN(lblGrnFresh + lblGrnReprt)}${lblGrnReprt ? ` <span style="color:var(--hmuted,#9ca3af);font-weight:500">(${_fmtN(lblGrnReprt)} reprint)</span>` : ''}</span>` : ''}
              ${(lblOpFresh + lblOpReprt) ? `<span style="font-size:10.5px;color:#4f46e5;font-weight:700">OP ${_fmtN(lblOpFresh + lblOpReprt)}${lblOpReprt ? ` <span style="color:var(--hmuted,#9ca3af);font-weight:500">(${_fmtN(lblOpReprt)} reprint)</span>` : ''}</span>` : ''}
              ${lblDnFresh ? `<span style="font-size:10.5px;color:#4f46e5;font-weight:700">DN ${_fmtN(lblDnFresh)}</span>` : ''}
              ${lblManual  ? `<span style="font-size:10.5px;color:#4f46e5;font-weight:700">Manual ${_fmtN(lblManual)}</span>`  : ''}
            </div>` : ''}
          </div>`;
      }

      // Build the WhatsApp message text
      const lines = [];
      lines.push(`📋 *PM Stock — Daily Report*`);
      lines.push(`📅 Date: ${_fmtDate(dateStr)}`);
      lines.push(`🏭 HCP Wellness Pvt. Ltd.`);
      lines.push('');

      // ── Top summary block ──────────────────────────────────────
      // Gives the reader a one-glance picture before they scroll into
      // per-voucher detail. Always present, regardless of brief/detailed.
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`📊 *Day Summary*`);
      lines.push(`Total Vouchers: *${grns.length + xfers.length}*  •  Total Qty: *${_fmtN(grnQty + xferQty)}*`);
      lines.push(`• 📦 GRN: *${grns.length}*  · qty *${_fmtN(grnQty)}*${grnBoxes ? `  · boxes *${_fmtN(grnBoxes)}*` : ''}`);
      lines.push(`• 🔄 Material Transfers: *${xfers.length}*  · qty *${_fmtN(xferQty)}*`);
      if(xfers.length){
        const statusBits = [];
        if(xferByStatus.out_started) statusBits.push(`Draft *${xferByStatus.out_started}*`);
        if(xferByStatus.in_pending)  statusBits.push(`In-Transit *${xferByStatus.in_pending}*`);
        if(xferByStatus.received)    statusBits.push(`Received *${xferByStatus.received}*`);
        if(xferByStatus.cancelled)   statusBits.push(`Cancelled *${xferByStatus.cancelled}*`);
        if(xferByStatus.other)       statusBits.push(`Other *${xferByStatus.other}*`);
        if(statusBits.length) lines.push(`     └─ ${statusBits.join('  ·  ')}`);
      }
      // Labels printed line (only when we have data — silently skip on
      // older deploys where /labels/summary doesn't exist).
      if(labels){
        if(lblTotal > 0){
          lines.push(`• 🖨️ Labels Printed: *${_fmtN(lblTotal)}*  · ${_fmtN(lblEvents)} print event${lblEvents===1?'':'s'}`);
          const lbits = [];
          const grnAll = lblGrnFresh + lblGrnReprt;
          const opAll  = lblOpFresh  + lblOpReprt;
          if(grnAll)      lbits.push(`GRN *${_fmtN(grnAll)}*${lblGrnReprt ? ` _(reprint ${_fmtN(lblGrnReprt)})_` : ''}`);
          if(opAll)       lbits.push(`OP *${_fmtN(opAll)}*${lblOpReprt ? ` _(reprint ${_fmtN(lblOpReprt)})_` : ''}`);
          if(lblDnFresh)  lbits.push(`DN *${_fmtN(lblDnFresh)}*`);
          if(lblManual)   lbits.push(`Manual *${_fmtN(lblManual)}*`);
          if(lbits.length) lines.push(`     └─ ${lbits.join('  ·  ')}`);
        } else {
          lines.push(`• 🖨️ Labels Printed: *0*`);
        }
      }
      lines.push('');

      // GRN section
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`📦 *GRN Details*`);
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      if(!grns.length){
        lines.push(`_No GRN entries today._`);
      } else {
        grns.forEach((g, idx) => {
          lines.push('');
          lines.push(`*${idx+1}.* GRN \`${g.grn_no || '—'}\``);
          if(g.supplier)         lines.push(`   👤 Supplier: ${g.supplier}`);
          if(g.godown_name)      lines.push(`   🏬 Location: ${g.godown_name}`);
          if(g.party_invoice_no) lines.push(`   🧾 Inv No: ${g.party_invoice_no}${g.party_invoice_date ? ' • ' + _fmtDate(g.party_invoice_date) : ''}`);
          lines.push(`   📊 Items: *${g.item_count||0}*  •  Qty: *${_fmtN(g.total_qty)}*${(Number(g.total_boxes) > 0) ? `  •  Boxes: *${_fmtN(g.total_boxes)}*` : ''}`);
          if(includeItems){
            const detail = grnDetails[g.id];
            const items  = detail && Array.isArray(detail.items) ? detail.items : [];
            if(items.length){
              items.forEach(it => {
                const nm = it.product_name || '—';
                const pm = it.pm_type ? `[${it.pm_type}] ` : '';
                // GRN item field is 'qty_received' (per route schema)
                const qty = Number(it.qty_received != null ? it.qty_received : it.qty) || 0;
                const nob = Number(it.no_of_box || 0);
                const pbq = Number(it.box_count || it.per_box_qty || 0);
                let qtyStr = `${_fmtN(qty)}`;
                if(nob > 0 && pbq > 0) qtyStr = `${nob}×${_fmtN(pbq)} = ${_fmtN(qty)}`;
                lines.push(`     • ${pm}${nm} — ${qtyStr}`);
              });
            }
          }
          if(g.created_by) lines.push(`   _by ${g.created_by}_`);
        });
      }

      lines.push('');
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`🔄 *Material Transfer Details*`);
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      if(!xfers.length){
        lines.push(`_No transfer activity today._`);
      } else {
        xfers.forEach((t, idx) => {
          lines.push('');
          const stMap = {
            'out_started': 'Draft (OUT only)',
            'in_pending':  'In Transit',
            'received':    'Received ✓',
            'cancelled':   'Cancelled ✗',
          };
          const stLbl = stMap[t.status] || (t.status || '—');
          lines.push(`*${idx+1}.* Transfer \`${t.transfer_no || '—'}\``);
          lines.push(`   ➡️ ${t.from_name || '—'} → ${t.to_name || '—'}`);
          lines.push(`   🔖 Status: ${stLbl}${t.has_discrepancy ? '  ⚠️ Discrepancy' : ''}`);
          lines.push(`   📊 Items: *${t.item_count||0}*  •  Qty: *${_fmtN(t.total_qty)}*`);
          if(includeItems){
            const tid = t.transfer_id || t.id;
            const detail = xferDetails[tid];
            const items  = detail && Array.isArray(detail.items) ? detail.items : [];
            if(items.length){
              items.forEach(it => {
                const nm = it.product_name || '—';
                const pm = it.pm_type ? `[${it.pm_type}] ` : '';
                const qty = Number(it.total_qty || it.qty || 0);
                const nob = Number(it.no_of_box || 0);
                const pbq = Number(it.per_box_qty || 0);
                let qtyStr = `${_fmtN(qty)}`;
                if(nob > 0 && pbq > 0) qtyStr = `${nob}×${_fmtN(pbq)} = ${_fmtN(qty)}`;
                lines.push(`     • ${pm}${nm} — ${qtyStr}`);
              });
            }
          }
          if(t.out_by) lines.push(`   _by ${t.out_by}_`);
        });
      }

      lines.push('');
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`Generated at ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`);

      if(txt) txt.value = lines.join('\n');
    } catch(e){
      if(txt) txt.value = `Error building report: ${e.message || e}`;
    } finally {
      if(loading) loading.style.display = 'none';
    }
  };

  // Copy current text to clipboard
  window.waReportCopy = async function(){
    const txt = document.getElementById('wa-report-text');
    if(!txt || !txt.value){ if(typeof showToast==='function') showToast('Nothing to copy','error'); return; }
    try {
      await navigator.clipboard.writeText(txt.value);
      if(typeof showToast==='function') showToast('✓ Copied to clipboard','success');
    } catch(e){
      // Fallback
      txt.select(); document.execCommand('copy');
      if(typeof showToast==='function') showToast('✓ Copied','success');
    }
  };

  // Send: opens https://web.whatsapp.com/send?phone=<num>&text=<body> in a new tab
  window.waReportSend = function(){
    const txt = document.getElementById('wa-report-text');
    const phone = (document.getElementById('wa-report-phone')?.value || '').replace(/[\s+\-()]/g,'');
    const body = (txt && txt.value) || '';
    if(!body.trim()){ if(typeof showToast==='function') showToast('Report is empty','error'); return; }

    if(phone){
      try { localStorage.setItem('pm_wa_last_phone', phone); } catch(e){}
    }

    // wa.me redirects to whichever WhatsApp is preferred; web.whatsapp.com forces web.
    // Spec: phone must be country-code + number, no + or spaces.
    let url;
    if(phone) {
      url = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(body)}`;
    } else {
      // No phone → open WhatsApp Web home with text in clipboard hint
      url = `https://web.whatsapp.com/send?text=${encodeURIComponent(body)}`;
    }
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if(!win){
      if(typeof showToast==='function') showToast('Pop-up blocked — allow pop-ups for this site and click again','error',5000);
      return;
    }
    if(typeof showToast==='function') showToast('Opened WhatsApp Web — click Send inside the new tab','success',4500);
  };
})();

