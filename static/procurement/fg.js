/* fg.js — Finished Goods Registry
   Depends on: utils.js, app.js
   Loaded by procurement.html */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
let _fgAll       = [];   // all FG rows from server
let _fgFiltered  = [];   // after search/filter
let _fgBrands    = [];   // procurement_brands
let _fgFormuls   = [];   // formulation batches {batch_name, product_code}
let _fgPmProds   = [];   // pm_products {id, product_name, pm_type}
let _fgSelected  = new Set();  // selected fg ids (multiselect)
let _fgEditId    = null;       // id being edited, null = create
let _fgPmChips   = [];         // pm_product ids in current form
let _fgFormulAcIdx = -1;
let _fgPmAcIdx     = -1;

/* ══════════════════════════════════════════════════════
   LOAD DATA
══════════════════════════════════════════════════════ */
async function loadFgData() {
    try {
        const [fgRes, brandRes, formulRes, pmRes] = await Promise.all([
            fetch('/api/fg/list'),
            fetch('/api/fg/brands'),
            fetch('/api/fg/formulations'),
            fetch('/api/fg/pm_products'),
        ]);
        const [fgData, brandData, formulData, pmData] = await Promise.all([
            fgRes.json(), brandRes.json(), formulRes.json(), pmRes.json()
        ]);

        _fgAll     = fgData.status === 'ok'     ? fgData.items    : [];
        _fgBrands  = brandData.status === 'ok'  ? brandData.brands  : [];
        _fgFormuls = formulData.status === 'ok' ? formulData.batches : [];
        _fgPmProds = pmData.status === 'ok'     ? pmData.products    : [];

        // Update badge
        const badge = document.getElementById('fgBadge');
        const sbBadge = document.getElementById('sbBadge-fg');
        if (badge)   badge.textContent   = _fgAll.length;
        if (sbBadge) sbBadge.textContent = _fgAll.length;

        // Populate brand filter dropdown
        _fgPopulateBrandFilter();

        fgApplyFilters();
    } catch (e) {
        document.getElementById('fgTbody').innerHTML =
            `<tr><td colspan="8"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>${escHtml(e.message)}</p></div></td></tr>`;
    }
}

function _fgPopulateBrandFilter() {
    const sel = document.getElementById('fgBrandFilter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Brands</option>'
        + _fgBrands.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    sel.value = cur;
    comboboxRefresh(sel);
}

/* ══════════════════════════════════════════════════════
   FILTER + RENDER TABLE
══════════════════════════════════════════════════════ */
function fgApplyFilters() {
    const q       = (document.getElementById('fgSearchInput')?.value || '').trim().toLowerCase();
    const brandId = document.getElementById('fgBrandFilter')?.value || '';
    const status  = document.getElementById('fgStatusFilter')?.value;

    _fgFiltered = _fgAll.filter(r => {
        if (q) {
            const hay = (r.fg_name + ' ' + r.sku_size + ' ' + r.brand_name + ' ' + r.formulation_batch).toLowerCase();
            if (!hay.includes(q)) return false;
        }
        if (brandId && String(r.brand_id) !== brandId) return false;
        if (status !== '' && status !== undefined && String(r.is_active) !== status) return false;
        return true;
    });

    fgRenderTable();
}

function fgRenderTable() {
    const tbody = document.getElementById('fgTbody');
    if (!tbody) return;

    // Update count
    const cnt = document.getElementById('fgRowCount');
    if (cnt) cnt.textContent = `${_fgFiltered.length} / ${_fgAll.length}`;

    if (!_fgFiltered.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="state-box"><div class="state-icon">📦</div><h3>No finished goods found</h3><p>Click "Create FG" to add your first one.</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = _fgFiltered.map(r => {
        const brandPill = r.brand_id
            ? `<span style="font-size:10px;font-weight:700;padding:1px 8px;border-radius:20px;
               background:${r.brand_color};color:${r.brand_text_color};
               border:1px solid ${r.brand_color}55">${escHtml(r.brand_name)}</span>`
            : '<span class="td-dim">—</span>';

        const statusBadge = r.is_active
            ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;
               background:rgba(16,185,129,.12);color:var(--green-text);border:1px solid rgba(16,185,129,.25)">Active</span>`
            : `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;
               background:rgba(239,68,68,.1);color:var(--red-text);border:1px solid rgba(239,68,68,.25)">Inactive</span>`;

        const formulLink = r.formulation_batch
            ? `<span style="font-size:10.5px;color:var(--teal);font-family:var(--font-mono)">${escHtml(r.formulation_batch)}</span>`
            : '<span class="td-dim">—</span>';

        const pmCount = r.pm_links?.length || 0;
        const pmCell = pmCount > 0
            ? `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;
               background:var(--text-08);color:var(--muted2)">${pmCount} PM linked</span>`
            : '<span class="td-dim">—</span>';

        const isChecked = _fgSelected.has(r.id);

        return `<tr class="fvq-row" style="cursor:pointer;border-left:3px solid ${r.is_active ? 'transparent' : 'rgba(239,68,68,.4)'}"
                    ondblclick="openFgForm(${r.id})">
            <td style="padding:8px 6px;text-align:center;border-right:1px solid var(--border)">
                <input type="checkbox" class="fg-row-cb" data-id="${r.id}"
                    onclick="event.stopPropagation();fgRowClick(this)"
                    ${isChecked ? 'checked' : ''}
                    style="cursor:pointer;width:14px;height:14px;accent-color:var(--teal)">
            </td>
            <td style="padding:9px 12px;font-weight:600;color:var(--text)">${escHtml(r.fg_name)}</td>
            <td style="padding:9px 12px;font-size:11px;color:var(--muted2);font-family:var(--font-mono)">${r.sku_size ? escHtml(r.sku_size) : '<span class="td-dim">—</span>'}</td>
            <td style="padding:9px 12px">${brandPill}</td>
            <td style="padding:9px 12px">${formulLink}</td>
            <td style="padding:9px 12px">${pmCell}</td>
            <td style="padding:9px 12px;text-align:center">${statusBadge}</td>
            <td style="padding:9px 8px;text-align:center;white-space:nowrap">
                <button onclick="event.stopPropagation();openFgForm(${r.id})"
                    class="btn-ghost" style="height:26px;padding:0 10px;font-size:11px">Edit</button>
                <button onclick="event.stopPropagation();fgDeleteRow(${r.id},'${escHtml(r.fg_name).replace(/'/g,"\\'")}')
                    " class="btn-ghost" style="height:26px;padding:0 8px;font-size:11px;color:var(--red-text);border-color:rgba(244,63,94,.35)">✕</button>
            </td>
        </tr>`;
    }).join('');

    // Sync header checkbox
    const sa = document.getElementById('fgSelectAll');
    const allCbs = [...document.querySelectorAll('.fg-row-cb')];
    if (sa) sa.checked = allCbs.length > 0 && allCbs.every(c => c.checked);
}

/* ══════════════════════════════════════════════════════
   SELECTION
══════════════════════════════════════════════════════ */
function fgRowClick(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _fgSelected.add(id); else _fgSelected.delete(id);
    _fgSyncBulkBar();
    const sa = document.getElementById('fgSelectAll');
    const all = [...document.querySelectorAll('.fg-row-cb')];
    if (sa) sa.checked = all.length > 0 && all.every(c => c.checked);
}

function fgToggleSelectAll(cb) {
    if (cb.checked) {
        _fgFiltered.forEach(r => _fgSelected.add(r.id));
    } else {
        _fgSelected.clear();
    }
    document.querySelectorAll('.fg-row-cb').forEach(c => {
        c.checked = cb.checked;
        if (cb.checked) _fgSelected.add(parseInt(c.dataset.id));
    });
    _fgSyncBulkBar();
}

function fgClearSelection() {
    _fgSelected.clear();
    document.querySelectorAll('.fg-row-cb').forEach(c => c.checked = false);
    const sa = document.getElementById('fgSelectAll'); if (sa) sa.checked = false;
    _fgSyncBulkBar();
}

function _fgSyncBulkBar() {
    const any = _fgSelected.size > 0;
    const bar = document.getElementById('fgBulkBar');
    if (bar) bar.style.display = any ? 'inline-flex' : 'none';
    const cnt = document.getElementById('fgBulkCount');
    if (cnt) cnt.textContent = `${_fgSelected.size} selected:`;
    // Populate brand select
    if (any) {
        const bsel = document.getElementById('fgBulkBrandSel');
        if (bsel) {
            bsel.innerHTML = '<option value="">— No Brand —</option>'
                + _fgBrands.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
        }
    }
}

async function fgBulkAssignBrand() {
    const ids = [..._fgSelected];
    if (!ids.length) { toast('Select at least one FG', 'warning'); return; }
    const brand_id = document.getElementById('fgBulkBrandSel')?.value || null;
    try {
        const res = await fetch('/api/fg/bulk_brand', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, brand_id: brand_id ? parseInt(brand_id) : null })
        });
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        const bname = _fgBrands.find(b => b.id === parseInt(brand_id))?.name || '(none)';
        toast(`Brand "${bname}" applied to ${ids.length} FG`, 'success');
        fgClearSelection();
        await loadFgData();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function fgBulkToggleStatus(status) {
    const ids = [..._fgSelected];
    if (!ids.length) { toast('Select at least one FG', 'warning'); return; }
    try {
        const res = await fetch('/api/fg/bulk_status', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, is_active: status })
        });
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast(`${ids.length} FG ${status ? 'activated' : 'deactivated'}`, 'success');
        fgClearSelection();
        await loadFgData();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════
   FORM OPEN / CLOSE
══════════════════════════════════════════════════════ */
function openFgForm(id) {
    _fgEditId  = id;
    _fgPmChips = [];

    // Populate brand select
    const bsel = document.getElementById('fgFormBrand');
    if (bsel) {
        bsel.innerHTML = '<option value="">— No Brand —</option>'
            + _fgBrands.map(b => `<option value="${b.id}">${escHtml(b.name)}</option>`).join('');
    }

    const title = document.getElementById('fgFormTitle');
    const statusWrap = document.getElementById('fgFormStatusWrap');

    if (id) {
        // Edit mode
        const r = _fgAll.find(x => x.id === id);
        if (!r) { toast('FG not found', 'error'); return; }
        if (title) title.textContent = '✏️ Edit FG';
        document.getElementById('fgFormName').value  = r.fg_name || '';
        document.getElementById('fgFormSku').value   = r.sku_size || '';
        if (bsel) bsel.value = r.brand_id || '';
        // Formulation
        document.getElementById('fgFormulInput').value  = r.formulation_batch || '';
        document.getElementById('fgFormFormul').value   = r.formulation_batch || '';
        // PM chips
        _fgPmChips = [...(r.pm_links || [])];
        _fgRenderPmChips();
        // Status
        if (statusWrap) statusWrap.style.display = '';
        document.getElementById('fgFormStatus').value = r.is_active;
    } else {
        // Create mode
        if (title) title.textContent = '📦 Create FG';
        document.getElementById('fgFormName').value  = '';
        document.getElementById('fgFormSku').value   = '';
        if (bsel) bsel.value = '';
        document.getElementById('fgFormulInput').value = '';
        document.getElementById('fgFormFormul').value  = '';
        _fgPmChips = [];
        _fgRenderPmChips();
        if (statusWrap) statusWrap.style.display = 'none';
    }

    document.getElementById('fgFormHint').textContent = '';
    document.getElementById('fgFormModal').classList.add('open');
    setTimeout(() => document.getElementById('fgFormName')?.focus(), 80);
}

function closeFgForm() {
    document.getElementById('fgFormModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
    const m = document.getElementById('fgFormModal');
    if (m) m.addEventListener('click', e => { if (e.target === m) closeFgForm(); });
});

/* ══════════════════════════════════════════════════════
   SAVE FORM
══════════════════════════════════════════════════════ */
async function saveFgForm() {
    const fg_name = (document.getElementById('fgFormName')?.value || '').trim();
    if (!fg_name) {
        toast('FG name is required', 'warning');
        document.getElementById('fgFormName')?.focus();
        return;
    }

    const payload = {
        fg_name,
        sku_size:           (document.getElementById('fgFormSku')?.value || '').trim() || null,
        brand_id:           document.getElementById('fgFormBrand')?.value
                            ? parseInt(document.getElementById('fgFormBrand').value) : null,
        formulation_batch:  (document.getElementById('fgFormFormul')?.value || '').trim() || null,
        pm_links:           _fgPmChips,
    };

    if (_fgEditId) {
        payload.is_active = parseInt(document.getElementById('fgFormStatus')?.value ?? 1);
    }

    const btn = document.getElementById('fgFormSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
        const url    = _fgEditId ? `/api/fg/update/${_fgEditId}` : '/api/fg/create';
        const method = _fgEditId ? 'PUT' : 'POST';
        const res    = await fetch(url, {
            method, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast(_fgEditId ? 'FG updated' : `"${fg_name}" created`, 'success');
        closeFgForm();
        await loadFgData();
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}

/* ══════════════════════════════════════════════════════
   DELETE
══════════════════════════════════════════════════════ */
async function fgDeleteRow(id, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
        const res  = await fetch(`/api/fg/delete/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast(`"${name}" deleted`, 'success');
        _fgSelected.delete(id);
        await loadFgData();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════
   FORMULATION AUTOCOMPLETE (in form)
══════════════════════════════════════════════════════ */
function fgFormulAcFilter(q) {
    const list = document.getElementById('fgFormulAcList');
    const hid  = document.getElementById('fgFormFormul');
    if (!list) return;
    const ql     = q.trim().toLowerCase();
    const matches = ql
        ? _fgFormuls.filter(b => b.batch_name.toLowerCase().includes(ql) || (b.product_code || '').toLowerCase().includes(ql))
        : _fgFormuls;
    if (!matches.length) { list.style.display = 'none'; return; }
    _fgFormulAcIdx = -1;
    list.innerHTML = matches.map((b, i) => {
        const hi = ql
            ? escHtml(b.batch_name).replace(new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                m => `<mark style="background:rgba(20,184,166,.25);color:var(--teal);border-radius:2px">${m}</mark>`)
            : escHtml(b.batch_name);
        const code = b.product_code ? `<span style="font-size:10px;color:var(--muted);font-family:var(--font-mono);margin-left:6px">${escHtml(b.product_code)}</span>` : '';
        return `<div class="fg-ac-formul" data-val="${escHtml(b.batch_name)}" data-idx="${i}"
                     onclick="fgFormulAcSelect(this.dataset.val)"
                     onmouseenter="this.style.background='var(--teal-glow,rgba(20,184,166,.1))'"
                     onmouseleave="this.style.background=''"
                     style="padding:7px 12px;font-size:12px;cursor:pointer;color:var(--text);border-bottom:1px solid var(--border)">${hi}${code}</div>`;
    }).join('');
    list.style.display = 'block';
    if (hid) hid.value = '';
    setTimeout(() => document.addEventListener('click', function _c(e) {
        const wrap = document.getElementById('fgFormulAcWrap');
        if (wrap && !wrap.contains(e.target)) { list.style.display = 'none'; document.removeEventListener('click', _c); }
    }), 10);
}

function fgFormulAcSelect(val) {
    document.getElementById('fgFormulInput').value = val;
    document.getElementById('fgFormFormul').value  = val;
    document.getElementById('fgFormulAcList').style.display = 'none';
}

function fgFormulAcKey(e) {
    const list  = document.getElementById('fgFormulAcList');
    const items = [...document.querySelectorAll('.fg-ac-formul')];
    if (!items.length || list.style.display === 'none') return;
    if (e.key === 'ArrowDown')       { e.preventDefault(); _fgFormulAcIdx = Math.min(_fgFormulAcIdx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); _fgFormulAcIdx = Math.max(_fgFormulAcIdx - 1, 0); }
    else if (e.key === 'Enter')      { e.preventDefault(); if (_fgFormulAcIdx >= 0) fgFormulAcSelect(items[_fgFormulAcIdx].dataset.val); return; }
    else if (e.key === 'Escape')     { list.style.display = 'none'; return; }
    else return;
    items.forEach((it, i) => {
        it.style.background = i === _fgFormulAcIdx ? 'var(--teal-glow,rgba(20,184,166,.1))' : '';
        if (i === _fgFormulAcIdx) it.scrollIntoView({ block: 'nearest' });
    });
}

/* ══════════════════════════════════════════════════════
   PM AUTOCOMPLETE + CHIPS (in form)
══════════════════════════════════════════════════════ */
function fgPmAcFilter(q) {
    const list = document.getElementById('fgPmAcList');
    if (!list) return;
    const ql = q.trim().toLowerCase();
    const matches = ql
        ? _fgPmProds.filter(p =>
            p.product_name.toLowerCase().includes(ql) || (p.pm_type || '').toLowerCase().includes(ql))
        : _fgPmProds;
    const available = matches.filter(p => !_fgPmChips.includes(p.id));
    if (!available.length) { list.style.display = 'none'; return; }
    _fgPmAcIdx = -1;
    list.innerHTML = available.map((p, i) => {
        const hi = ql
            ? escHtml(p.product_name).replace(new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                m => `<mark style="background:rgba(20,184,166,.25);color:var(--teal);border-radius:2px">${m}</mark>`)
            : escHtml(p.product_name);
        return `<div class="fg-ac-pm" data-id="${p.id}" data-name="${escHtml(p.product_name)}" data-idx="${i}"
                     onclick="fgPmAcSelect(parseInt(this.dataset.id), this.dataset.name)"
                     onmouseenter="this.style.background='var(--teal-glow,rgba(20,184,166,.1))'"
                     onmouseleave="this.style.background=''"
                     style="padding:7px 12px;font-size:12px;cursor:pointer;color:var(--text);border-bottom:1px solid var(--border)">
                <span style="font-size:9px;background:var(--text-08);padding:1px 6px;border-radius:10px;color:var(--muted2);margin-right:6px">${escHtml(p.pm_type)}</span>${hi}
            </div>`;
    }).join('');
    list.style.display = 'block';
    setTimeout(() => document.addEventListener('click', function _c(e) {
        const wrap = document.getElementById('fgPmAcWrap');
        if (wrap && !wrap.contains(e.target)) { list.style.display = 'none'; document.removeEventListener('click', _c); }
    }), 10);
}

function fgPmAcSelect(id, name) {
    if (!_fgPmChips.includes(id)) {
        _fgPmChips.push(id);
        _fgRenderPmChips();
    }
    document.getElementById('fgPmInput').value = '';
    document.getElementById('fgPmAcList').style.display = 'none';
}

function fgPmAcKey(e) {
    const list  = document.getElementById('fgPmAcList');
    const items = [...document.querySelectorAll('.fg-ac-pm')];
    if (!items.length || list.style.display === 'none') return;
    if (e.key === 'ArrowDown')    { e.preventDefault(); _fgPmAcIdx = Math.min(_fgPmAcIdx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _fgPmAcIdx = Math.max(_fgPmAcIdx - 1, 0); }
    else if (e.key === 'Enter')   { e.preventDefault(); if (_fgPmAcIdx >= 0) { const it = items[_fgPmAcIdx]; fgPmAcSelect(parseInt(it.dataset.id), it.dataset.name); } return; }
    else if (e.key === 'Escape')  { list.style.display = 'none'; return; }
    else return;
    items.forEach((it, i) => {
        it.style.background = i === _fgPmAcIdx ? 'var(--teal-glow,rgba(20,184,166,.1))' : '';
        if (i === _fgPmAcIdx) it.scrollIntoView({ block: 'nearest' });
    });
}

function _fgRenderPmChips() {
    const wrap = document.getElementById('fgPmChips');
    if (!wrap) return;
    if (!_fgPmChips.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = _fgPmChips.map(id => {
        const p = _fgPmProds.find(x => x.id === id);
        const label = p ? `[${escHtml(p.pm_type)}] ${escHtml(p.product_name)}` : `PM #${id}`;
        return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;
                    background:var(--teal-glow,rgba(20,184,166,.1));border:1px solid var(--teal-dim);
                    border-radius:20px;font-size:11px;color:var(--teal)">
                ${label}
                <button onclick="fgPmChipRemove(${id})" style="border:none;background:transparent;color:var(--teal);cursor:pointer;font-size:13px;line-height:1;padding:0">×</button>
            </span>`;
    }).join('');
}

function fgPmChipRemove(id) {
    _fgPmChips = _fgPmChips.filter(x => x !== id);
    _fgRenderPmChips();
}

/* ══════════════════════════════════════════════════════
   AUTO-LOAD when FG tab is first activated
══════════════════════════════════════════════════════ */
(function _fgAutoLoad() {
    // Intercept switchTab to lazy-load on first visit
    const _origSwitch = window.switchTab;
    if (typeof _origSwitch === 'function') {
        window.switchTab = function (id) {
            _origSwitch(id);
            if (id === 'fg' && !_fgAll.length) loadFgData();
        };
    } else {
        // fallback: load on DOMContentLoaded
        document.addEventListener('DOMContentLoaded', () => {
            const sb = document.getElementById('sb-fg');
            if (sb) sb.addEventListener('click', () => { if (!_fgAll.length) loadFgData(); });
        });
    }
})();
