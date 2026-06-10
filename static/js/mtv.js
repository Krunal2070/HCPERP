/* mtv.js — Material Transfer Voucher
   Depends on: utils.js, app.js, voucher_numbering.js
   Features: flat item-level list · bulk select · WhatsApp · email · print/PDF
             double-click to edit · GRN-matched form styling               */

/* ── Register MTV with unified voucher numbering ── */
if (typeof _vnRegisterType === 'function') _vnRegisterType('mtv');

/* ══════════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════════ */
var WA_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>';

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
var _mtvList      = [];        // flat: one row per item per voucher
var _mtvVouchers  = [];        // raw voucher+items from server
var _mtvFilter    = 'all';
var _mtvSearch    = '';
var _mtvSelected  = new Set(); // selected voucher IDs
var _mtvEditId    = null;
var _mtvItems     = [];
var _mtvAllMats   = [];
var _mtvAllGodowns = [];   // cached godowns for From/To autocomplete
var _mtvLocked    = false;

/* ══════════════════════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════════════════════ */
async function loadMtvList() {
    var body = document.getElementById('mtvListBody');
    if (!body) return;
    body.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading MTVs\u2026</h3></div>';
    try {
        var res  = await fetch('/api/procurement/mtv/list');
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        _mtvVouchers = data.rows || [];
        _mtvSelected.clear();
        _mtvBuildFlatList();
        await _mtvRenderList();
    } catch (e) {
        body.innerHTML = '<div class="state-box"><h3>Error loading MTVs</h3><p>' + escHtml(e.message || String(e)) + '</p></div>';
        console.error('[MTV] loadMtvList error:', e);
    }
}

/* Build flat list: one row per material per voucher (like a ledger) */
function _mtvBuildFlatList() {
    /* We need items too — but /mtv/list only returns headers.
       Build a "virtual" flat view from header data only (items loaded lazily for share).
       For the flat list we show each voucher as expandable group rows.
       Each voucher that has item_count > 0 will get item_count rows once items are fetched.
       For now render header-level rows; items expand on click.                              */
    _mtvList = _mtvVouchers.slice();
}

/* ══════════════════════════════════════════════════════════════════
   FILTER / SEARCH
══════════════════════════════════════════════════════════════════ */
function mtvApplyFilter() {
    _mtvSearch = (document.getElementById('mtvSearchInput') ? document.getElementById('mtvSearchInput').value : '').toLowerCase().trim();
    _mtvRenderList();
}

function mtvSetFilter(f) {
    _mtvFilter = f;
    document.querySelectorAll('#mtvFilterGroup .filter-pill').forEach(function(b) {
        b.classList.toggle('active', b.dataset.f === f);
    });
    _mtvRenderList();
}

/* ══════════════════════════════════════════════════════════════════
   RENDER LIST — flat rows with Sr, Date, Voucher No, Item, Qty, From, To
══════════════════════════════════════════════════════════════════ */
async function _mtvRenderList() {
    var body = document.getElementById('mtvListBody');
    if (!body) return;
    try {
    var rows = _mtvVouchers.slice();
    if (_mtvFilter !== 'all') rows = rows.filter(function(r){ return r.status === _mtvFilter; });
    if (_mtvSearch) {
        rows = rows.filter(function(r){
            return (r.mtv_num  || '').toLowerCase().includes(_mtvSearch) ||
                   (r.from_loc || '').toLowerCase().includes(_mtvSearch) ||
                   (r.to_loc   || '').toLowerCase().includes(_mtvSearch) ||
                   (r.remarks  || '').toLowerCase().includes(_mtvSearch);
        });
    }

    var badge    = document.getElementById('mtvBadge');
    var sbBadge  = document.getElementById('sbBadge-mtv');
    var rowBadge = document.getElementById('mtvRowBadge');
    if (badge)    badge.textContent    = _mtvVouchers.length;
    if (sbBadge)  sbBadge.textContent  = _mtvVouchers.length;
    if (rowBadge) rowBadge.textContent = rows.length + ' Vouchers';

    _mtvUpdateBulkBar();

    if (!rows.length) {
        body.innerHTML = '<div class="state-box"><h3>No MTVs found</h3><p>Adjust filters or create a new MTV.</p></div>';
        return;
    }

    // Fetch items for all visible vouchers in one batch
    var itemMap = {};
    try {
        var ids = rows.map(function(r){ return r.id; }).join(',');
        var ir = await fetch('/api/procurement/mtv/items_batch?ids=' + ids);
        var id2 = await ir.json();
        if (id2.status === 'ok') itemMap = id2.items_by_voucher || {};
    } catch(e) { /* items will be empty, still render headers */ }

    var statusStyle = {
        open:      'background:rgba(37,99,235,.1);color:#2563eb',
        completed: 'background:rgba(22,163,74,.1);color:#16a34a',
        cancelled: 'background:rgba(220,38,38,.08);color:#dc2626'
    };
    var statusLabel = { open:'Open', completed:'Completed', cancelled:'Cancelled' };

    var html = '<table style="width:100%;border-collapse:collapse;font-size:12px">'
        + '<thead><tr style="background:var(--surface2);border-bottom:2px solid var(--border2);position:sticky;top:0;z-index:10">'
        + '<th style="padding:8px 10px;width:36px">'
        +   '<input type="checkbox" id="mtvSelAll" onchange="_mtvToggleAll(this.checked)" title="Select all">'
        + '</th>'
        + '<th style="padding:8px 6px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:40px">Sr</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:110px">Date</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:140px">Voucher No.</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Item Name</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:120px">From Godown</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:120px">To Godown</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:90px">Status</th>'
        + '<th style="padding:8px 6px;width:120px"></th>'
        + '</tr></thead><tbody>';

    var srNo = 0;
    rows.forEach(function(r) {
        var items = itemMap[String(r.id)] || [];
        // Attach all items to row so _mtvListRow can build inline summary + tooltip
        r._items = items;
        var ss  = statusStyle[r.status] || '';
        var sl  = statusLabel[r.status] || r.status || '—';
        var sel = _mtvSelected.has(r.id);
        var rowSelStyle = sel ? 'background:rgba(37,99,235,.06)' : '';

        // Always one row per voucher — item summary shown inline in Item Name cell
        srNo++;
        var firstItem = items.length > 0 ? items[0] : null;
        html += _mtvListRow(r, firstItem, srNo, ss, sl, sel, rowSelStyle, true);
    });

    html += '</tbody></table>';
    body.innerHTML = html;
    } catch(e) {
        body.innerHTML = '<div class="state-box"><h3>Error rendering MTVs</h3><p>' + (e && e.message ? escHtml(e.message) : String(e)) + '</p></div>';
        console.error('[MTV] _mtvRenderList error:', e);
    }
}

function _mtvListRow(r, item, srNo, ss, sl, sel, rowSelStyle, showActions) {
    // Build inline item summary: "Glycerine – 250 Kg, Sorbitol – 100 Kg, …"
    var allItems = (r._items || []);
    var parts = allItems.filter(function(it){ return it.material_name; }).map(function(it) {
        var q = it.qty ? parseFloat(it.qty).toLocaleString('en-IN', {maximumFractionDigits:3}) + ' ' + (it.uom||'') : '';
        return escHtml(it.material_name) + (q ? ' <span style="color:var(--muted);font-size:10px">– ' + q + '</span>' : '');
    });

    var itemName;
    if (parts.length === 0) {
        itemName = '<span style="color:var(--muted);font-style:italic">No items</span>';
    } else {
        // Show all items, each on its own line separated by a light divider
        var rows = parts.map(function(p, i) {
            return '<div style="' + (i > 0 ? 'margin-top:2px;padding-top:2px;border-top:1px solid var(--border);' : '') + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px">' + p + '</div>';
        });
        itemName = '<div style="display:flex;flex-direction:column;gap:0">' + rows.join('') + '</div>';
    }
    var qtyStr   = '';
    if (item && item.qty) {
        try {
            qtyStr = parseFloat(item.qty).toLocaleString('en-IN', {maximumFractionDigits:3}) + ' ' + (item.uom || '');
            if (item.packages) qtyStr += ' <span style="font-size:9.5px;color:var(--muted);margin-left:3px">(' + item.packages + ' pkgs)</span>';
        }
        catch(e) { qtyStr = String(item.qty); }
    }

    // Action buttons (only rendered on first item row to avoid repetition)
    var actionCell = '';
    if (showActions) {
        actionCell = '<div style="display:flex;gap:4px;align-items:center">'
            // Edit
            + '<button onclick="event.stopPropagation();openMtvForm(' + r.id + ')" title="Edit MTV" '
            + 'style="height:26px;padding:0 8px;border-radius:5px;border:1px solid var(--border2);'
            + 'background:var(--surface);color:var(--text);font-size:10px;font-weight:600;cursor:pointer;font-family:var(--font-body)">'
            + 'Edit</button>'
            // Print
            + '<button onclick="event.stopPropagation();mtvPrintPreview(' + r.id + ')" title="Print" '
            + 'style="height:26px;padding:0 7px;border-radius:5px;border:1px solid var(--border2);'
            + 'background:var(--surface);color:var(--text);cursor:pointer;display:flex;align-items:center">'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'
            + '</button>'
            // WhatsApp
            + '<button onclick="event.stopPropagation();mtvShareWhatsApp(' + r.id + ')" title="Share via WhatsApp" '
            + 'style="height:26px;padding:0 7px;border-radius:5px;border:1px solid #22c55e;'
            + 'background:#f0fdf4;color:#16a34a;cursor:pointer;display:flex;align-items:center">'
            + WA_SVG + '</button>'
            // Email
            + '<button onclick="event.stopPropagation();mtvShareEmail(' + r.id + ')" title="Share via Email" '
            + 'style="height:26px;padding:0 7px;border-radius:5px;border:1px solid var(--border2);'
            + 'background:var(--surface);color:var(--muted);cursor:pointer;display:flex;align-items:center">'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>'
            + '</button>'
            // Delete
            + '<button onclick="event.stopPropagation();mtvDeleteOne(' + r.id + ')" title="Delete MTV" '
            + 'style="height:26px;padding:0 7px;border-radius:5px;border:1px solid rgba(244,63,94,.3);'
            + 'background:rgba(244,63,94,.06);color:var(--red-text);cursor:pointer;display:flex;align-items:center">'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
            + '</button>'
            + '</div>';
    }

    return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;' + rowSelStyle + '" '
        + 'ondblclick="openMtvForm(' + r.id + ')" '
        + 'onmouseover="if(!this.dataset.sel)this.style.background=\'var(--surface2)\'" '
        + 'onmouseout="if(!this.dataset.sel)this.style.background=\'' + (sel ? 'rgba(37,99,235,.06)' : '') + '\'" '
        + 'data-sel="' + (sel ? '1' : '') + '">'
        // Checkbox
        + '<td style="padding:6px 10px" onclick="event.stopPropagation()">'
        +   (showActions ? '<input type="checkbox" data-vid="' + r.id + '" ' + (sel?'checked':'') + ' onchange="_mtvToggleOne(' + r.id + ',this.checked)">' : '')
        + '</td>'
        // Sr No
        + '<td style="padding:6px 6px;text-align:center;color:var(--muted);font-size:11px">' + srNo + '</td>'
        // Date
        + '<td style="padding:6px 6px;white-space:nowrap;font-size:12px">' + (showActions ? fmtDate(r.mtv_date) : '') + '</td>'
        // Voucher No
        + '<td style="padding:6px 6px">'
        +   (showActions ? '<span style="font-family:var(--font-mono);font-size:11.5px;font-weight:700;color:var(--teal)">' + escHtml(r.mtv_num||'—') + '</span>' : '')
        + '</td>'
        // Item name
        + '<td style="padding:6px 6px">' + itemName + '</td>'
        // From
        + '<td style="padding:6px 6px;font-size:11.5px">' + (showActions ? escHtml(r.from_loc||'—') : '') + '</td>'
        // To
        + '<td style="padding:6px 6px;font-size:11.5px">' + (showActions ? escHtml(r.to_loc||'—') : '') + '</td>'
        // Status
        + '<td style="padding:6px 6px">'
        +   (showActions ? '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;' + ss + '">' + sl + '</span>' : '')
        + '</td>'
        // Actions
        + '<td style="padding:4px 6px">' + actionCell + '</td>'
        + '</tr>';
}

/* ══════════════════════════════════════════════════════════════════
   SELECTION
══════════════════════════════════════════════════════════════════ */
function _mtvToggleOne(id, checked) {
    if (checked) _mtvSelected.add(id);
    else         _mtvSelected.delete(id);
    _mtvUpdateBulkBar();
    // update "select all" state
    var allCb = document.getElementById('mtvSelAll');
    if (allCb) {
        var total   = document.querySelectorAll('[data-vid]').length;
        allCb.indeterminate = _mtvSelected.size > 0 && _mtvSelected.size < total;
        allCb.checked = _mtvSelected.size > 0 && _mtvSelected.size === total;
    }
}

function _mtvToggleAll(checked) {
    document.querySelectorAll('[data-vid]').forEach(function(cb) {
        var id = parseInt(cb.dataset.vid);
        if (checked) _mtvSelected.add(id);
        else         _mtvSelected.delete(id);
        cb.checked = checked;
    });
    _mtvUpdateBulkBar();
}

function _mtvUpdateBulkBar() {
    var bar = document.getElementById('mtvBulkBar');
    if (!bar) return;
    var n = _mtvSelected.size;
    if (n === 0) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';
    var lbl = document.getElementById('mtvBulkLabel');
    if (lbl) lbl.textContent = n + ' voucher' + (n===1?'':'s') + ' selected';
}

/* ══════════════════════════════════════════════════════════════════
   BULK ACTIONS
══════════════════════════════════════════════════════════════════ */
async function mtvBulkWhatsApp() {
    if (!_mtvSelected.size) { toast('Select at least one MTV', 'warning'); return; }
    var ids = Array.from(_mtvSelected);
    // Fetch all selected vouchers
    var lines = ['*Material Transfer Vouchers \u2014 HCP Wellness Pvt Ltd*', ''];
    for (var i = 0; i < ids.length; i++) {
        try {
            var res  = await fetch('/api/procurement/mtv/get?id=' + ids[i]);
            var data = await res.json();
            if (data.status !== 'ok') continue;
            var v = data.mtv;
            lines.push('*' + (v.mtv_num||'—') + '* | ' + fmtDate(v.mtv_date));
            lines.push('From: ' + (v.from_loc||'—') + '  \u2192  To: ' + (v.to_loc||'—'));
            (data.items||[]).forEach(function(it, j) {
                try { var q = parseFloat(it.qty||0).toLocaleString('en-IN',{maximumFractionDigits:3}) + ' ' + (it.uom||''); }
                catch(e) { var q = String(it.qty||''); }
                lines.push('  ' + (j+1) + '. ' + (it.material_name||'—') + '  \u2014  ' + q + (it.packages ? ' | ' + it.packages + ' pkgs' : ''));
            });
            lines.push('Status: ' + (v.status||'—').toUpperCase());
            lines.push('');
        } catch(e) {}
    }
    if (lines.length <= 2) { toast('No data to share', 'warning'); return; }
    window.open('https://web.whatsapp.com/send?text=' + encodeURIComponent(lines.join('\n')), '_blank');
}

async function mtvBulkEmail() {
    if (!_mtvSelected.size) { toast('Select at least one MTV', 'warning'); return; }
    var ids = Array.from(_mtvSelected);
    if (ids.length === 1) { mtvShareEmail(ids[0]); return; }
    // Download PDF for each — open mailto
    toast('Downloading PDFs for ' + ids.length + ' MTVs\u2026', 'info', 3000);
    for (var i = 0; i < ids.length; i++) {
        var r = _mtvVouchers.find(function(v){ return v.id === ids[i]; });
        if (!r) continue;
        var safe = (r.mtv_num||'MTV').replace(/\//g,'_');
        var a = document.createElement('a');
        a.href = '/api/procurement/mtv/pdf?id=' + ids[i];
        a.download = 'MTV_' + safe + '.pdf';
        a.click();
        await new Promise(function(res){ setTimeout(res, 500); });
    }
    var subj = encodeURIComponent('Material Transfer Vouchers \u2014 HCP Wellness Pvt Ltd');
    var body = encodeURIComponent('Please find the attached Material Transfer Vouchers.\n\nRegards,\nHCP Wellness Pvt Ltd');
    window.location.href = 'mailto:?subject=' + subj + '&body=' + body;
}

async function mtvBulkDelete() {
    if (!_mtvSelected.size) { toast('Select at least one MTV', 'warning'); return; }
    var n = _mtvSelected.size;
    if (!confirm('Delete ' + n + ' selected MTV(s)? This cannot be undone.')) return;
    var ids = Array.from(_mtvSelected);
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var res  = await fetch('/api/procurement/mtv/delete', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ id: ids[i] })
            });
            var data = await res.json();
            if (data.status !== 'ok') failed++;
        } catch(e) { failed++; }
    }
    toast(failed ? (n - failed) + ' deleted, ' + failed + ' failed' : n + ' MTVs deleted', failed?'error':'success');
    loadMtvList();
}

async function mtvBulkPrint() {
    if (!_mtvSelected.size) { toast('Select at least one MTV', 'warning'); return; }
    var ids = Array.from(_mtvSelected);
    for (var i = 0; i < ids.length; i++) {
        window.open('/api/procurement/mtv/print?id=' + ids[i], '_blank');
        await new Promise(function(res){ setTimeout(res, 400); });
    }
}

/* ══════════════════════════════════════════════════════════════════
   SINGLE-ROW ACTIONS
══════════════════════════════════════════════════════════════════ */
async function mtvShareWhatsApp(id) {
    try {
        var res  = await fetch('/api/procurement/mtv/get?id=' + id);
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        var v     = data.mtv;
        var items = data.items || [];
        var lines = ['*Material Transfer Voucher \u2014 HCP Wellness Pvt Ltd*', ''];
        lines.push('MTV No: *' + (v.mtv_num||'—') + '*');
        lines.push('Date: ' + fmtDate(v.mtv_date));
        lines.push('From: *' + (v.from_loc||'—') + '*  \u2192  To: *' + (v.to_loc||'—') + '*');
        if (v.remarks) lines.push('Remarks: ' + v.remarks);
        lines.push('');
        if (items.length) {
            lines.push('*Materials Transferred:*');
            items.forEach(function(it, i) {
                try { var q = parseFloat(it.qty||0).toLocaleString('en-IN',{maximumFractionDigits:3}) + ' ' + (it.uom||''); }
                catch(e) { var q = String(it.qty||''); }
                lines.push((i+1) + '. ' + (it.material_name||'—') + '  \u2014  ' + q + (it.packages ? ' | ' + it.packages + ' pkgs' : ''));
            });
            lines.push('');
        }
        lines.push('Status: *' + (v.status||'open').toUpperCase() + '*');
        lines.push('_HCP Wellness Pvt Ltd \u2014 Internal Transfer Document_');
        window.open('https://web.whatsapp.com/send?text=' + encodeURIComponent(lines.join('\n')), '_blank');
    } catch(e) { toast('WhatsApp error: ' + e.message, 'error'); }
}

async function mtvShareEmail(id) {
    try {
        toast('Generating PDF\u2026', 'info', 2000);
        var r = _mtvVouchers.find(function(v){ return v.id === id; }) || {};
        var safe = (r.mtv_num||'MTV').replace(/\//g,'_');
        var a = document.createElement('a');
        a.href = '/api/procurement/mtv/pdf?id=' + id;
        a.download = 'MTV_' + safe + '.pdf';
        a.click();
        setTimeout(function() {
            var subj = encodeURIComponent('Material Transfer ' + (r.mtv_num||'') + ' \u2014 HCP Wellness Pvt Ltd');
            var body = encodeURIComponent(
                'Please find attached the Material Transfer Voucher ' + (r.mtv_num||'') + '.\n\n'
                + 'From: ' + (r.from_loc||'') + '\nTo: ' + (r.to_loc||'') + '\n\n'
                + 'Regards,\nHCP Wellness Pvt Ltd'
            );
            window.location.href = 'mailto:?subject=' + subj + '&body=' + body;
            toast('PDF downloaded \u2014 attach MTV_' + safe + '.pdf to the email', 'success', 7000);
        }, 800);
    } catch(e) { toast('Email error: ' + e.message, 'error'); }
}

async function mtvDeleteOne(id) {
    var r = _mtvVouchers.find(function(v){ return v.id === id; }) || {};
    if (!confirm('Delete ' + (r.mtv_num||'this MTV') + '? This cannot be undone.')) return;
    try {
        var res  = await fetch('/api/procurement/mtv/delete', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('MTV deleted', 'info');
        loadMtvList();
    } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
}

function mtvPrintPreview(id) {
    window.open('/api/procurement/mtv/print?id=' + id, '_blank');
}

/* ══════════════════════════════════════════════════════════════════
   FORM — OPEN / CLOSE
══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   MTV VOUCHER TYPE — loads from GOP
══════════════════════════════════════════════ */
async function mtvLoadVoucherTypes(currentTypeName) {
    var sel = document.getElementById('mtvVoucherTypeSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select Type —</option>';
    try {
        var res  = await fetch('/api/gop/voucher_types?parent_type=mtv');
        var data = await res.json();
        if (data.status !== 'ok') return;
        _mtvTypeList = data.types || []; // cache for group mapping
        _mtvTypeList.filter(function(t){ return t.is_active; }).forEach(function(t) {
            var opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.name + (t.abbreviation ? ' (' + t.abbreviation + ')' : '');
            if (t.name === currentTypeName) opt.selected = true;
            sel.appendChild(opt);
        });
        if (!currentTypeName && sel.options.length === 2) sel.selectedIndex = 1;
        // Trigger type change to load numbering + set material filter
        mtvOnTypeChange();
    } catch(e) { /* silently ignore */ }
}

/* Cache of loaded types for abbreviation lookups */
var _mtvTypeList = [];

/* ══════════════════════════════════════════════
   FEATURE 1: Update MTV number when type changes
   FEATURE 2: Filter material autocomplete by group
══════════════════════════════════════════════ */
var _mtvPrevVoucherType = '';

async function mtvOnTypeChange() {
    var sel  = document.getElementById('mtvVoucherTypeSelect');
    var typeName = sel ? sel.value : '';
    if (!typeName) return;

    // ── Confirm reset if items already entered ──
    var hasData = _mtvItems.some(function(it){ return (it.material_name||'').trim(); });
    if (_mtvPrevVoucherType && typeName !== _mtvPrevVoucherType && hasData) {
        if (!confirm('Changing the transfer type will clear all current materials. Continue?')) {
            sel.value = _mtvPrevVoucherType;
            return;
        }
        _mtvItems = [_mtvBlankItem()];
        _mtvRenderItemRows();
    }
    _mtvPrevVoucherType = typeName;

    // ── Feature 1: Fetch active numbering style for this type ──
    var numInput  = document.getElementById('mtvNumInput');
    var numBadge  = document.getElementById('mtvFormNum');
    var isNew     = !_mtvEditId;

    if (isNew && numInput) {
        numInput.value = 'Fetching…';
        try {
            var res  = await fetch('/api/gop/voucher_numbering/next?voucher_type=' + encodeURIComponent(typeName));
            var data = await res.json();
            if (data.status === 'ok') {
                var p   = data.prefix ? data.prefix + '/' : '';
                var s   = data.suffix ? '/' + data.suffix : '';
                var num = p + String(data.next).padStart(data.digits || 4, '0') + s;
                numInput.value = num;
                if (numBadge) numBadge.textContent = num;
            } else {
                numInput.value = 'MTV/0001';
            }
        } catch(e) {
            numInput.value = 'MTV/0001';
        }
    }

    // ── Feature 2: Set material filter from material_type_id association ──
    var typeInfo = _mtvTypeList.find(function(t){ return t.name === typeName; });
    // mat_type_abbr = linked procurement_material_types.abbreviation (RM/PM/FG/OT)
    var matAbbr = typeInfo ? ((typeInfo.mat_type_abbr || '')).toUpperCase() : '';
    // Fallback: guess from voucher abbreviation prefix if no explicit association set
    if (!matAbbr && typeInfo && typeInfo.abbreviation) {
        var va = typeInfo.abbreviation.toUpperCase();
        if (va.startsWith('RM'))      matAbbr = 'RM';
        else if (va.startsWith('PM')) matAbbr = 'PM';
        else if (va.startsWith('FG')) matAbbr = 'FG';
    }
    if      (matAbbr === 'RM') _mtvMatGroupFilter = 'rm';
    else if (matAbbr === 'PM') _mtvMatGroupFilter = 'pm';
    else if (matAbbr === 'FG') _mtvMatGroupFilter = 'fg';
    else                       _mtvMatGroupFilter = null;
}

/* Active material group filter — applied in _mtvLocSuggest and item autocomplete */
var _mtvMatGroupFilter = null;

/* Returns true if a material (from _mtvAllMats) matches the current group filter */
function _mtvMatMatchesGroup(mat) {
    if (!_mtvMatGroupFilter) return true;
    var abbr = (mat.mat_type_abbr || mat.group_name || '').toUpperCase();
    // Primary: explicit material type abbreviation
    if (mat.mat_type_abbr) {
        if (_mtvMatGroupFilter === 'rm') return abbr === 'RM';
        if (_mtvMatGroupFilter === 'pm') return abbr === 'PM';
        if (_mtvMatGroupFilter === 'fg') return abbr === 'FG';
        return true;
    }
    // Fallback: guess from group_name
    var grp = (mat.group_name || '').toLowerCase();
    if (_mtvMatGroupFilter === 'rm') return grp.includes('raw');
    if (_mtvMatGroupFilter === 'pm') return grp.includes('pack');
    if (_mtvMatGroupFilter === 'fg') return grp.includes('finish') || grp.includes('fg');
    return true;
}

async function openMtvForm(id) {
    _mtvEditId = id || null;
    _mtvItems  = [];

    if (!_mtvAllMats.length)    await _mtvLoadMats();
    if (!_mtvAllGodowns.length) await _mtvLoadGodowns();

    var _mtvListEl = document.getElementById('mtv-list-pane');
    var _mtvFormEl = document.getElementById('mtv-form-pane');
    var _mtvBodyEl = document.getElementById('mtv-form-body');
    if (_mtvListEl) _mtvListEl.style.display = 'none';
    if (_mtvFormEl) { _mtvFormEl.style.display = 'block'; _mtvFormEl.style.width = '100%'; }
    if (_mtvBodyEl) _mtvBodyEl.innerHTML =
        '<div class="state-box"><div class="spinner"></div><h3>Loading\u2026</h3></div>';

    var rec = null, items = [];
    if (id) {
        try {
            var res = await fetch('/api/procurement/mtv/get?id=' + id);
            var d   = await res.json();
            if (d.status !== 'ok') throw new Error(d.message);
            rec = d.mtv; items = d.items || [];
        } catch(e) { toast('Failed to load MTV: ' + e.message, 'error'); _mtvCloseForm(); return; }
    }

    // Next voucher number via unified numbering
    var nextNum = 'MTV/0001';
    if (!id) {
        try {
            var cfg = (typeof _vNumGetActive === 'function') ? _vNumGetActive('mtv') : {};
            var url = '/api/procurement/voucher_numbering/next?voucher_type=mtv';
            if (cfg.prefix) url += '&prefix=' + encodeURIComponent(cfg.prefix);
            if (cfg.suffix) url += '&suffix=' + encodeURIComponent(cfg.suffix);
            if (cfg.digits) url += '&digits=' + cfg.digits;
            var nr = await fetch(url);
            var nd = await nr.json();
            if (nd.status === 'ok') {
                var p  = nd.prefix ? nd.prefix + '/' : 'MTV/';
                var s  = nd.suffix ? '/' + nd.suffix  : '';
                nextNum = p + String(nd.next).padStart(nd.digits || 4, '0') + s;
            }
        } catch(e) { /* use fallback */ }
    }

    _mtvLocked = !!(rec && (rec.status === 'completed' || rec.status === 'cancelled'));
    _mtvItems  = items.map(function(it) {
        var pkgs   = parseFloat(it.packages) || 0;
        var storedQty = parseFloat(it.qty) || 0;
        // qty_per_pkg: use stored value if available, else derive from total/pkgs
        var qpp = parseFloat(it.qty_per_pkg) || (pkgs > 0 ? storedQty / pkgs : storedQty);
        var total = pkgs > 0 ? pkgs * qpp : storedQty;
        return { material_id: it.material_id||null, material_name: it.material_name||'',
                 qty: String(total), qty_per_pkg: String(qpp||''), packages: it.packages||'',
                 total_qty: total, uom: it.uom||'kg', remarks: it.remarks||'' };
    });
    if (!_mtvItems.length) _mtvItems.push(_mtvBlankItem());

    document.getElementById('mtv-form-body').innerHTML = _mtvBuildFormHTML(rec, nextNum);
    await mtvLoadVoucherTypes(rec ? (rec.voucher_type_name || '') : '');
    _mtvRenderItemRows();
}

function _mtvCloseForm() {
    // Support both procurement (mtv-list-pane) and General OP (gopMtvListPane) contexts
    var listEl = document.getElementById('gopMtvListPane') || document.getElementById('mtv-list-pane');
    var formEl = document.getElementById('mtv-form-pane');
    if (listEl) listEl.style.display = '';
    if (formEl) formEl.style.display = 'none';
    loadMtvList();
}

/* ══════════════════════════════════════════════════════════════════
   FORM HTML — GRN-matched
══════════════════════════════════════════════════════════════════ */
function _mtvBuildFormHTML(rec, nextNum) {
    var v       = rec || {};
    var mtvNum  = v.mtv_num  || nextNum;
    var mtvDate = (v.mtv_date ? String(v.mtv_date).substring(0,10) : new Date().toISOString().substring(0,10));
    var fromLoc = v.from_loc || '';
    var toLoc   = v.to_loc   || '';
    var remarks = v.remarks  || '';
    var status  = v.status   || 'open';
    var isNew   = !rec;
    var eyebrow = isNew ? 'NEW MTV' : ('MTV \u00b7 ' + status.toUpperCase());
    var title   = isNew ? 'New Material Transfer Voucher' : ('Material Transfer \u2014 ' + escHtml(mtvNum));
    var dis     = _mtvLocked ? 'disabled' : '';

    var pillCss = {
        open:      'background:rgba(37,99,235,.12);color:#2563eb;border:1px solid rgba(37,99,235,.3)',
        completed: 'background:rgba(22,163,74,.12);color:#16a34a;border:1px solid rgba(22,163,74,.3)',
        cancelled: 'background:rgba(220,38,38,.12);color:#dc2626;border:1px solid rgba(220,38,38,.3)'
    };

    var out = '<div style="background:var(--surface);min-height:100%">';

    // ── Sticky toolbar ──
    out += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;'
         + 'background:var(--surface2);border-bottom:1px solid var(--border2);position:sticky;top:0;z-index:50">';
    out += '<div style="display:flex;align-items:center;gap:14px">';
    out += '<button onclick="_mtvCloseForm()" style="height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--border2);'
         + 'background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;'
         + 'font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
         + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>'
         + 'Back to List</button>';
    out += '<div>'
         + '<div style="font-size:9px;font-weight:800;color:var(--teal);text-transform:uppercase;letter-spacing:.8px">' + eyebrow + '</div>'
         + '<div style="font-size:17px;font-weight:800;color:var(--text)">' + title + '</div>'
         + '</div>';
    if (rec) out += '<span style="font-size:11px;font-weight:700;padding:3px 12px;border-radius:20px;' + (pillCss[status]||'') + '">' + status.charAt(0).toUpperCase() + status.slice(1) + '</span>';
    out += '</div>';

    out += '<div style="display:flex;gap:8px;align-items:center">';
    if (rec && !_mtvLocked) {
        out += '<button onclick="mtvDeleteCurrent()" style="height:32px;padding:0 14px;border-radius:7px;'
             + 'border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);'
             + 'font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
             + 'Delete</button>';
    }
    if (rec) {
        out += '<button onclick="mtvShareWhatsApp(' + rec.id + ')" style="height:32px;padding:0 12px;border-radius:7px;'
             + 'border:1px solid #22c55e;background:#f0fdf4;color:#16a34a;font-size:12px;font-weight:600;'
             + 'cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + WA_SVG + ' WhatsApp</button>';
        out += '<button onclick="mtvShareEmail(' + rec.id + ')" style="height:32px;padding:0 12px;border-radius:7px;'
             + 'border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;'
             + 'cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>'
             + ' Email</button>';
        out += '<button onclick="mtvPrintPreview(' + rec.id + ')" style="height:32px;padding:0 12px;border-radius:7px;'
             + 'border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;'
             + 'cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'
             + ' Print</button>';
    }
    if (!_mtvLocked) {
        out += '<button onclick="saveMtv(\'open\')" style="height:32px;padding:0 16px;border-radius:7px;'
             + 'border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;'
             + 'cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/><polyline points="7 3 7 8 15 8"/></svg>'
             + ' Save Draft</button>';
        out += '<button id="mtvCompletBtn" onclick="saveMtv(\'completed\')" style="height:32px;padding:0 16px;border-radius:7px;'
             + 'border:none;background:#16a34a;color:#fff;font-size:12px;font-weight:700;'
             + 'cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">'
             + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
             + ' Complete Transfer</button>';
    }
    out += '</div></div>'; // end toolbar

    // ── Header card ──
    out += '<div class="form-card" style="margin:14px 16px 0;border-radius:10px">';
    out += '<div class="form-card-head">'
         + '<div class="form-card-head-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg> MTV DETAILS</div>'
         + '<span class="form-card-badge">MTV No: <span id="mtvFormNum" style="font-family:var(--font-mono);letter-spacing:.5px">' + escHtml(mtvNum) + '</span></span>'
         + '</div>';
    out += '<div class="form-card-body" style="padding:14px 16px">';
    out += '<div style="display:grid;grid-template-columns:200px 170px 150px 1fr 1fr;gap:12px;margin-bottom:12px">';
    out += '<div class="form-group"><label class="form-label">Transfer Type <span class="req">*</span></label>'
         + '<select class="form-input-styled" id="mtvVoucherTypeSelect" ' + dis + ' onchange="mtvOnTypeChange()">'
         + '<option value="">Loading…</option>'
         + '</select></div>';
    out += '<div class="form-group"><label class="form-label">MTV Number</label>'
         + '<input class="form-input-styled" type="text" id="mtvNumInput" value="' + escHtml(mtvNum) + '" ' + dis
         + ' autocomplete="off" style="font-family:var(--font-mono);font-weight:600"></div>';
    out += '<div class="form-group"><label class="form-label">Date</label>'
         + '<input class="form-input-styled" type="date" id="mtvDateInput" value="' + mtvDate + '" ' + dis + '></div>';
    out += '<div class="form-group"><label class="form-label">From Location <span class="req">*</span></label>'
         + '<div style="position:relative">'
         + '<input class="form-input-styled" type="text" id="mtvFromInput" value="' + escHtml(fromLoc) + '" ' + dis
         + ' placeholder="Store / Godown / Lab\u2026" autocomplete="off"'
         + (!_mtvLocked ? ' oninput="_mtvLocInput(\'from\')" onkeydown="_mtvLocKey(event,\'from\')" onblur="_mtvLocBlur(\'from\')" onfocus="_mtvLocInput(\'from\')"' : '')
         + '>'
         + (!_mtvLocked ? '<div id="mtvFromDd" style="display:none;position:absolute;top:100%;left:0;right:0;'
         + 'background:#fff;border:1px solid #e2e8f0;border-radius:7px;'
         + 'box-shadow:0 8px 28px rgba(0,0,0,.22);z-index:9999;max-height:240px;overflow-y:auto"></div>' : '')
         + '</div></div>';
    out += '<div class="form-group"><label class="form-label">To Location <span class="req">*</span></label>'
         + '<div style="position:relative">'
         + '<input class="form-input-styled" type="text" id="mtvToInput" value="' + escHtml(toLoc) + '" ' + dis
         + ' placeholder="Production / QC / Dispatch\u2026" autocomplete="off"'
         + (!_mtvLocked ? ' oninput="_mtvLocInput(\'to\')" onkeydown="_mtvLocKey(event,\'to\')" onblur="_mtvLocBlur(\'to\')" onfocus="_mtvLocInput(\'to\')"' : '')
         + '>'
         + (!_mtvLocked ? '<div id="mtvToDd" style="display:none;position:absolute;top:100%;left:0;right:0;'
         + 'background:#fff;border:1px solid #e2e8f0;border-radius:7px;'
         + 'box-shadow:0 8px 28px rgba(0,0,0,.22);z-index:9999;max-height:240px;overflow-y:auto"></div>' : '')
         + '</div></div>';
    out += '</div>';
    out += '<div style="display:grid;grid-template-columns:1fr 160px;gap:12px">';
    out += '<div class="form-group"><label class="form-label">Remarks</label>'
         + '<input class="form-input-styled" type="text" id="mtvRemarksInput" value="' + escHtml(remarks) + '" ' + dis
         + ' placeholder="Optional notes\u2026" autocomplete="off"></div>';
    if (!_mtvLocked) {
        out += '<div class="form-group"><label class="form-label">Status</label>'
             + '<select class="form-input-styled" id="mtvStatusSel">'
             + '<option value="open"' + (status==='open'?' selected':'') + '>Open</option>'
             + '<option value="completed"' + (status==='completed'?' selected':'') + '>Completed</option>'
             + '<option value="cancelled"' + (status==='cancelled'?' selected':'') + '>Cancelled</option>'
             + '</select></div>';
    } else { out += '<div></div>'; }
    out += '</div></div></div>';

    // ── Items card ──
    out += '<div class="form-card" style="margin:10px 16px 18px;border-radius:10px;overflow:visible">';
    out += '<div class="form-card-head">'
         + '<div class="form-card-head-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> MATERIALS TO TRANSFER</div>'
         + '<div style="display:flex;align-items:center;gap:8px">'
         + '<span id="mtvLineCount" style="font-size:10px;color:rgba(255,255,255,.7)">0 items</span>'
         + (_mtvMatGroupFilter ? '<span style="font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:10px;'
           + 'background:rgba(255,255,255,.2);color:#fff;margin-left:4px">'
           + '🔵 ' + ({rm:'RM',pm:'PM',fg:'FG'}[_mtvMatGroupFilter]||_mtvMatGroupFilter.toUpperCase()) + ' only</span>' : '');
    if (!_mtvLocked) {
        out += '<button onclick="_mtvAddRow()" style="height:26px;padding:0 12px;border-radius:6px;border:none;'
             + 'background:#fff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;'
             + 'font-family:var(--font-body);display:flex;align-items:center;gap:4px">'
             + '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
             + '+ Add Row</button>';
    }
    out += '</div></div>';
    out += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">';
    out += '<thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border2)">'
         + '<th style="padding:7px 8px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:32px">#</th>'
         + '<th style="padding:7px 8px;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Material <span style="color:var(--red-text)">*</span></th>'
         + '<th style="padding:7px 8px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:75px">Pkgs</th>'
         + '<th style="padding:7px 8px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:12px;color:#6b7280">&times;</th>'
         + '<th style="padding:7px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:100px">Qty/Pkg</th>'
         + '<th style="padding:7px 8px;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:80px">UOM</th>'
         + '<th style="padding:7px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--teal);text-transform:uppercase;width:100px">=Total Qty</th>'
         + '<th style="padding:7px 8px;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Remarks</th>'
         + (!_mtvLocked ? '<th style="padding:7px 8px;width:28px"></th>' : '')
         + '</tr></thead><tbody id="mtvItemTbody"></tbody>';
    if (!_mtvLocked) {
        out += '<tfoot><tr style="border-top:1px solid var(--border)"><td colspan="9" style="padding:6px 10px">'
             + '<button onclick="_mtvAddRow()" style="height:26px;padding:0 12px;border-radius:6px;border:1px dashed var(--border2);'
             + 'background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body);'
             + 'display:flex;align-items:center;gap:4px" '
             + 'onmouseover="this.style.borderColor=\'#2563eb\';this.style.color=\'#2563eb\'" '
             + 'onmouseout="this.style.borderColor=\'\';this.style.color=\'\'">'
             + '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
             + 'Add another row</button></td></tr></tfoot>';
    }
    out += '</table></div></div></div>';
    return out;
}

/* ══════════════════════════════════════════════════════════════════
   ITEM ROWS
══════════════════════════════════════════════════════════════════ */
function _mtvBlankItem() { return { material_id:null, material_name:'', qty_per_pkg:'', packages:'', total_qty:0, uom:'kg', remarks:'' }; }

function _mtvRenderItemRows() {
    var tbody = document.getElementById('mtvItemTbody');
    if (!tbody) return;
    var filled = _mtvItems.filter(function(it){ return it.material_name && (parseFloat(it.total_qty||it.qty))>0; }).length;
    var lc = document.getElementById('mtvLineCount');
    if (lc) lc.textContent = filled + (filled===1?' item':' items');
    var uoms = ['kg','g','mg','L','mL','pcs','bags','drums','bottles'];
    var html = '';
    _mtvItems.forEach(function(it, i) {
        var bg = i%2===0 ? '' : 'background:var(--surface)';
        if (_mtvLocked) {
            var pkgsDisp  = it.packages  ? String(it.packages)  : '\u2014';
            var qppDisp   = it.qty_per_pkg ? parseFloat(it.qty_per_pkg).toLocaleString('en-IN',{maximumFractionDigits:3}) : '\u2014';
            var totalDisp = it.total_qty > 0 ? parseFloat(it.total_qty).toLocaleString('en-IN',{maximumFractionDigits:3}) : (it.qty ? parseFloat(it.qty).toLocaleString('en-IN',{maximumFractionDigits:3}) : '\u2014');
            html += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
                + '<td style="padding:8px;text-align:center;color:var(--muted);font-size:11px">' + (i+1) + '</td>'
                + '<td style="padding:8px;font-weight:600">' + escHtml(it.material_name||'\u2014') + '</td>'
                + '<td style="padding:8px;text-align:center;font-weight:800;color:var(--text);font-family:var(--font-mono)">' + pkgsDisp + '</td>'
                + '<td style="padding:8px;text-align:center;color:var(--muted);font-size:13px;font-weight:300">&times;</td>'
                + '<td style="padding:8px;text-align:right;font-family:var(--font-mono);font-weight:600">' + qppDisp + '</td>'
                + '<td style="padding:8px;text-align:center;color:var(--muted);font-size:11.5px;font-weight:600">' + escHtml(it.uom||'') + '</td>'
                + '<td style="padding:8px;text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--teal);font-size:13px">' + totalDisp + '</td>'
                + '<td style="padding:8px;color:var(--muted);font-size:11.5px">' + escHtml(it.remarks||'') + '</td>'
                + '</tr>';
        } else {
            html += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
                + '<td style="padding:5px 8px;text-align:center;color:var(--muted);font-size:11px">' + (i+1) + '</td>'
                + '<td style="padding:4px 6px;overflow:visible"><div style="position:relative">'
                +   '<input class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;width:100%" '
                +     'id="mtvMat-' + i + '" value="' + escHtml(it.material_name) + '" '
                +     'placeholder="Type to search\u2026" oninput="_mtvMatInput(' + i + ')" onkeydown="_mtvMatKey(event,' + i + ')" onblur="_mtvMatBlur(' + i + ')" autocomplete="off">'
                +   '<div id="mtvMatDd-' + i + '" onmousedown="event.preventDefault()" style="display:none;position:fixed;z-index:9999;min-width:320px;'
                +     'background:#fff;border:1px solid #e2e8f0;border-radius:7px;'
                +     'box-shadow:0 8px 28px rgba(0,0,0,.22);max-height:240px;overflow-y:auto"></div>'
                + '</div></td>'
                + '<td style="padding:4px 6px;width:75px"><input type="number" class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;text-align:center;width:100%;font-weight:700" '
                +   'id="mtvPkgs-' + i + '" value="' + (it.packages||'') + '" min="0" step="1" placeholder="—" '
                +   'oninput="_mtvCalcTotal(' + i + ')" title="No. of Packages"></td>'
                + '<td style="padding:4px 6px;text-align:center;width:20px;color:var(--muted);font-size:13px;font-weight:300">&times;</td>'
                + '<td style="padding:4px 6px;width:100px"><input class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;text-align:right;width:100%" '
                +   'type="number" step="any" min="0" id="mtvQty-' + i + '" value="' + escHtml(String(it.qty_per_pkg||'')) + '" '
                +   'placeholder="0" oninput="_mtvCalcTotal(' + i + ')" title="Qty per Package"></td>'
                + '<td style="padding:4px 6px;min-width:70px;text-align:center">'
                +   '<span id="mtvUom-' + i + '" style="font-size:12px;font-weight:600;color:var(--text);'
                +     'display:inline-block;padding:5px 8px;background:var(--surface2);border-radius:6px;'
                +     'border:1px solid var(--border);min-width:44px;text-align:center">' + escHtml(it.uom||'KG') + '</span>'
                + '</td>'
                + '<td style="padding:4px 6px;width:100px;text-align:right">'
                +   '<span id="mtvTotal-' + i + '" style="font-size:12.5px;font-weight:800;color:var(--teal);font-family:var(--font-mono);padding:4px 6px;display:inline-block">'
                +   (it.total_qty > 0 ? it.total_qty.toLocaleString('en-IN',{maximumFractionDigits:3}) : '\u2014') + '</span>'
                + '</td>'
                + '<td style="padding:4px 6px"><input class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;width:100%" '
                +   'id="mtvRowRmk-' + i + '" value="' + escHtml(it.remarks||'') + '" '
                +   'placeholder="Notes\u2026" oninput="_mtvRowRmkChange(' + i + ')"></td>'
                + '<td style="padding:4px 6px;text-align:center">'
                +   '<button onclick="_mtvRemoveRow(' + i + ')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:4px;border-radius:4px;display:flex;align-items:center" '
                +     'onmouseover="this.style.color=\'var(--red-text)\'" onmouseout="this.style.color=\'var(--muted)\'">'
                +   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
                + '</td></tr>';
        }
    });
    tbody.innerHTML = html;
}

function _mtvAddRow()        { _mtvItems.push(_mtvBlankItem()); _mtvRenderItemRows(); }
function _mtvRemoveRow(i)    { _mtvItems.splice(i,1); if(!_mtvItems.length)_mtvItems.push(_mtvBlankItem()); _mtvRenderItemRows(); }
function _mtvCalcTotal(i) {
    var pkgsEl    = document.getElementById('mtvPkgs-' + i);
    var qtyEl     = document.getElementById('mtvQty-'  + i);
    var totalEl   = document.getElementById('mtvTotal-' + i);
    var warnEl    = document.getElementById('mtvQtyWarn-' + i);
    if (warnEl) warnEl.remove();
    if (!pkgsEl || !qtyEl) return;

    var pkgs    = parseFloat(pkgsEl.value) || 0;
    var qtyPkg  = parseFloat(qtyEl.value)  || 0;
    var total   = pkgs * qtyPkg;

    _mtvItems[i].packages   = pkgsEl.value;
    _mtvItems[i].qty_per_pkg = qtyEl.value;
    _mtvItems[i].total_qty  = total;
    _mtvItems[i].qty        = total;  // keep qty = total for save compatibility

    if (totalEl) {
        totalEl.textContent = total > 0
            ? total.toLocaleString('en-IN', {maximumFractionDigits:3})
            : '\u2014';
        totalEl.style.color = total > 0 ? 'var(--teal)' : 'var(--muted)';
    }
    _mtvUpdateCount();

    // Live stock warning on total
    if (total > 0) {
        var matName = _mtvItems[i].material_name || '';
        var mat     = matName ? (_mtvAllMats||[]).find(function(r){
            return (r.name||'').toLowerCase() === matName.toLowerCase();
        }) : null;
        var available = mat ? (parseFloat(mat.in_stock_qty) || 0) : null;
        if (available !== null && total > available) {
            var warn = document.createElement('div');
            warn.id = 'mtvQtyWarn-' + i;
            warn.style.cssText = 'font-size:9.5px;color:#b45309;font-weight:600;margin-top:2px;padding:2px 4px;background:rgba(251,191,36,.15);border-radius:3px;white-space:nowrap';
            warn.textContent = '\u26a0 Only ' + available + ' ' + (_mtvItems[i].uom||'KG') + ' available';
            qtyEl.parentNode.appendChild(warn);
        }
    }
}

function _mtvRowRmkChange(i) { var el=document.getElementById('mtvRowRmk-'+i); if(el)_mtvItems[i].remarks=el.value; }
function _mtvPkgsChange(i)    { var el=document.getElementById('mtvPkgs-'+i); if(el)_mtvItems[i].packages=el.value; }
function _mtvUpdateCount() {
    var f=_mtvItems.filter(function(it){ return it.material_name&&(parseFloat(it.total_qty||it.qty))>0; }).length;
    var lc=document.getElementById('mtvLineCount');
    if(lc)lc.textContent=f+(f===1?' item':' items');
}

async function _mtvLoadMats() {
    try {
        // Try stock_summary first (works from both procurement and general_op contexts)
        var res = await fetch('/api/procurement/stock_summary');
        var d   = await res.json();
        if (d.status === 'ok') {
            _mtvAllMats = (d.rows || []).map(function(m){
                return {
                    id:            m.id || null,
                    name:          m.material_name || '',
                    group_name:    m.group_name    || '',
                    mat_type_abbr: m.mat_type_abbr || '',
                    mat_type_color:m.mat_type_color|| '',
                    uom:           m.uom           || 'KG',
                    in_stock_qty:  parseFloat(m.in_stock_qty) || 0
                };
            });
            return;
        }
    } catch(e) {}
    try {
        // Fallback to materials list
        var res2 = await fetch('/api/procurement/materials');
        var d2   = await res2.json();
        _mtvAllMats = (d2.materials||[]).map(function(m){
            return {
                id:            m.id || null,
                name:          m.material_name || '',
                group_name:    m.group_name    || '',
                mat_type_abbr: m.mat_type_abbr || '',
                mat_type_color:m.mat_type_color|| '',
                uom:           m.uom           || 'KG'
            };
        });
    } catch(e){ _mtvAllMats=[]; }
}

async function _mtvLoadGodowns() {
    try {
        // Try GOP endpoint first (works from general_op), fall back to procurement
        var url = '/api/gop/godowns';
        var res = await fetch(url);
        var d   = await res.json();
        if (d.status !== 'ok') throw new Error('not ok');
        _mtvAllGodowns = (d.godowns || [])
            .filter(function(g){ return (g.type||'godown') !== 'billing'; })
            .map(function(g){
                var label = g.name || '';
                var sub   = [g.city, g.state].filter(Boolean).join(', ');
                return { id: g.id, name: label, sub: sub, is_default: g.is_default };
            });
    } catch(e){ _mtvAllGodowns = []; }
}

function _mtvLocInput(which) {
    var inpId = which === 'from' ? 'mtvFromInput' : 'mtvToInput';
    var ddId  = which === 'from' ? 'mtvFromDd'   : 'mtvToDd';
    var inp   = document.getElementById(inpId);
    var dd    = document.getElementById(ddId);
    if (!inp || !dd) return;

    var q = inp.value.toLowerCase().trim();
    // Show all godowns on focus (empty query), filter when typing
    var hits = q
        ? _mtvAllGodowns.filter(function(g){ return g.name.toLowerCase().includes(q); })
        : _mtvAllGodowns.slice();

    if (!hits.length) { dd.style.display = 'none'; return; }

    dd.innerHTML = hits.map(function(g) {
        var safeName = g.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return '<div data-selectable="1" style="padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border);'
            + 'display:flex;align-items:center;gap:10px;transition:background .1s;background:#fff" '
            + 'onmouseover="this.style.background=\'#f1f5f9\'" '
            + 'onmouseout="this.style.background=\'#fff\'" '
            + 'onmousedown="event.preventDefault();_mtvLocSelect(\'' + which + '\',\'' + safeName + '\')">'
            + '<div style="flex:1;min-width:0">'
            +   '<div style="font-size:12px;font-weight:600;color:var(--text)">'
            +     (g.is_default ? '<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:10px;'
            +       'background:#2563eb;color:#fff;margin-right:6px;vertical-align:middle">DEFAULT</span>' : '')
            +     escHtml(g.name)
            +   '</div>'
            +   (g.sub ? '<div style="font-size:10.5px;color:var(--muted);margin-top:1px">' + escHtml(g.sub) + '</div>' : '')
            + '</div>'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>'
            + '</div>';
    }).join('');
    dd.style.display = 'block';
    _mtvLocFocusIdx[which] = -1;
}

function _mtvLocSelect(which, name) {
    var inpId = which === 'from' ? 'mtvFromInput' : 'mtvToInput';
    var ddId  = which === 'from' ? 'mtvFromDd'   : 'mtvToDd';
    var inp   = document.getElementById(inpId);
    var dd    = document.getElementById(ddId);
    if (inp) inp.value = name;
    if (dd)  dd.style.display = 'none';
}

function _mtvLocBlur(which) {
    setTimeout(function() {
        var ddId = which === 'from' ? 'mtvFromDd' : 'mtvToDd';
        var dd   = document.getElementById(ddId);
        if (dd) dd.style.display = 'none';
        _mtvLocFocusIdx[which] = -1;
    }, 300);
}

/* Keyboard navigation for godown dropdowns */
var _mtvLocFocusIdx = { from: -1, to: -1 };

function _mtvLocKey(e, which) {
    var ddId = which === 'from' ? 'mtvFromDd' : 'mtvToDd';
    var dd   = document.getElementById(ddId);

    if (!dd || dd.style.display === 'none') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _mtvLocInput(which); }
        return;
    }

    var items = dd.querySelectorAll('[data-selectable]');
    if (!items.length) return;

    var cur = _mtvLocFocusIdx[which] !== undefined ? _mtvLocFocusIdx[which] : -1;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        cur = Math.min(cur + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cur = Math.max(cur - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (cur >= 0 && items[cur]) {
            // Read name from onmousedown attr
            var attr = items[cur].getAttribute('onmousedown') || '';
            var match = attr.match(/_mtvLocSelect\('([^']+)','([^']+)'\)/);
            if (match) {
                _mtvLocSelect(match[1], match[2]);
                _mtvLocFocusIdx[which] = -1;
                // Move focus to next field
                var nextId = which === 'from' ? 'mtvToInput' : null;
                if (nextId) { var next = document.getElementById(nextId); if (next) next.focus(); }
            }
        }
        return;
    } else if (e.key === 'Escape') {
        e.preventDefault();
        dd.style.display = 'none';
        _mtvLocFocusIdx[which] = -1;
        return;
    } else {
        return;
    }

    _mtvLocFocusIdx[which] = cur;
    items.forEach(function(el, idx) {
        el.style.background = idx === cur ? '#e0e7ff' : '#fff';
        el.style.fontWeight = idx === cur ? '700' : '';
    });
    if (items[cur]) items[cur].scrollIntoView({ block: 'nearest' });
}

function _mtvMatInput(i) {
    var inp = document.getElementById('mtvMat-' + i);
    var dd  = document.getElementById('mtvMatDd-' + i);
    var q   = inp ? inp.value.toLowerCase().trim() : '';
    _mtvItems[i].material_name = inp ? inp.value : '';
    _mtvItems[i].material_id   = null;
    if (!q || !dd) { if (dd) dd.style.display = 'none'; return; }

    var nameHits = _mtvAllMats.filter(function(m) {
        return m.name.toLowerCase().includes(q);
    });
    var filtered = _mtvMatGroupFilter
        ? nameHits.filter(function(m){ return _mtvMatMatchesGroup(m); })
        : nameHits;
    var showWarning = false;
    if (_mtvMatGroupFilter && filtered.length === 0 && nameHits.length > 0) {
        filtered = nameHits;
        showWarning = true;
    }
    if (!filtered.length) { dd.style.display = 'none'; return; }

    // Position fixed dropdown under input
    var rect = inp.getBoundingClientRect();
    dd.style.top   = (rect.bottom + 2) + 'px';
    dd.style.left  = rect.left + 'px';
    dd.style.width = Math.max(rect.width, 320) + 'px';

    var filterLabel = { rm: 'Raw Material', pm: 'Packing Material', fg: 'Finished Goods' };
    var header = '';
    if (_mtvMatGroupFilter && !showWarning) {
        header = '<div style="padding:5px 12px;font-size:9.5px;font-weight:700;color:#2563eb;'
            + 'background:rgba(37,99,235,.07);border-bottom:1px solid #e2e8f0;letter-spacing:.04em">'
            + '\u{1F535} Filtered: ' + (filterLabel[_mtvMatGroupFilter] || _mtvMatGroupFilter.toUpperCase()) + ' only</div>';
    } else if (showWarning) {
        header = '<div style="padding:5px 12px;font-size:9.5px;font-weight:600;color:#b45309;'
            + 'background:rgba(251,191,36,.1);border-bottom:1px solid #e2e8f0">'
            + '\u26a0 No material types assigned yet \u2014 showing all.</div>';
    }

    dd.innerHTML = header + filtered.slice(0, 15).map(function(m, idx) {
        var sn     = m.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        var uomStr = (m.uom || 'KG').replace(/'/g, "\\'");
        var typeBadge = m.mat_type_abbr
            ? '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:5px;color:#fff;background:'
              + (m.mat_type_color || '#6b7280') + ';margin-left:6px;flex-shrink:0">' + escHtml(m.mat_type_abbr) + '</span>'
            : (m.group_name
                ? '<span style="font-size:9.5px;color:#64748b;margin-left:6px;flex-shrink:0">' + escHtml(m.group_name) + '</span>'
                : '');
        var uomBadge = m.uom
            ? '<span style="font-size:9.5px;color:#0d9488;margin-left:auto;padding-left:8px;flex-shrink:0">' + escHtml(m.uom) + '</span>'
            : '';
        return '<div class="mtv-mat-item" data-selectable="1" style="padding:7px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #e2e8f0;'
            + 'display:flex;align-items:center;transition:background .1s;background:#fff" '
            + 'onmouseover="this.style.background=\'#f1f5f9\'" onmouseout="this.style.background=\'#fff\'" '
            + 'onmousedown="event.preventDefault();_mtvSelectMat(' + i + ',' + (m.id || 'null') + ',\'' + sn + '\',\'' + uomStr + '\')">'
            + '<span>' + escHtml(m.name) + '</span>' + typeBadge + uomBadge
            + '</div>';
    }).join('');
    dd.style.display = 'block';
    _mtvMatFocusIdx[i] = -1;
}


function _mtvSelectMat(i, id, name, uom) {
    _mtvItems[i].material_id   = id;
    _mtvItems[i].material_name = name;
    _mtvItems[i].uom           = uom || 'KG';
    var inp    = document.getElementById('mtvMat-' + i);
    var dd     = document.getElementById('mtvMatDd-' + i);
    var uomEl = document.getElementById('mtvUom-' + i);
    if (inp)   inp.value = name;
    if (dd)    dd.style.display = 'none';
    // Auto-fill UOM from the selected material
    if (uomEl && uom) {
        var u = uom.toUpperCase();
        uomEl.textContent = u;
        _mtvItems[i].uom = u;
    }
    _mtvUpdateCount();
}
function _mtvMatBlur(i){
    setTimeout(function(){
        var dd=document.getElementById('mtvMatDd-'+i);
        var inp=document.getElementById('mtvMat-'+i);
        if(dd)dd.style.display='none';
        if(inp){_mtvItems[i].material_name=inp.value.trim();_mtvUpdateCount();}
    },300);
}

/* Keyboard navigation: ArrowDown/Up moves highlight, Enter selects, Escape closes */
var _mtvMatFocusIdx = {};

function _mtvMatKey(e, i) {
    var dd = document.getElementById('mtvMatDd-' + i);
    if (!dd || dd.style.display === 'none') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _mtvMatInput(i); }
        return;
    }
    var items = dd.querySelectorAll('[data-selectable]');
    if (!items.length) return;

    var cur = (_mtvMatFocusIdx[i] !== undefined) ? _mtvMatFocusIdx[i] : -1;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        cur = Math.min(cur + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cur = Math.max(cur - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (cur >= 0 && items[cur]) {
            // Read data directly from onmousedown attr and call _mtvSelectMat
            var attr = items[cur].getAttribute('onmousedown') || '';
            var match = attr.match(/_mtvSelectMat\((\d+),(null|\d+),'((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)'\)/);
            if (match) {
                var rowIdx = parseInt(match[1]);
                var matId  = match[2] === 'null' ? null : parseInt(match[2]);
                var name   = match[3].replace(/\'/g, "'");
                var uom    = match[4].replace(/\'/g, "'");
                _mtvSelectMat(rowIdx, matId, name, uom);
            }
        }
        return;
    } else if (e.key === 'Escape') {
        e.preventDefault();
        dd.style.display = 'none';
        _mtvMatFocusIdx[i] = -1;
        return;
    } else {
        return;
    }

    _mtvMatFocusIdx[i] = cur;
    items.forEach(function(el, idx) {
        el.style.background = idx === cur ? '#e0e7ff' : '#fff';
        el.style.fontWeight = idx === cur ? '700' : '';
    });
    if (items[cur]) items[cur].scrollIntoView({ block: 'nearest' });
}

/* ══════════════════════════════════════════════════════════════════
   SAVE
══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   STOCK ERROR MODAL — shown when qty > available
══════════════════════════════════════════════ */
function _mtvShowStockError(errors) {
    var existing = document.getElementById('mtvStockErrorModal');
    if (existing) existing.remove();

    var rows = errors.map(function(e) {
        var pct = e.available > 0 ? Math.round((e.available / e.requested) * 100) : 0;
        var barColor = pct < 30 ? '#ef4444' : pct < 70 ? '#f59e0b' : '#22c55e';
        return '<tr style="border-bottom:1px solid #e2e8f0">'
            + '<td style="padding:8px 10px;font-size:12px;font-weight:600;color:#1e293b">' + escHtml(e.name) + '</td>'
            + '<td style="padding:8px 10px;text-align:right;font-family:monospace;font-size:12px;color:#ef4444;font-weight:700">'
            +   e.requested + ' <span style="font-size:10px;color:#64748b">' + escHtml(e.uom) + '</span></td>'
            + '<td style="padding:8px 10px;text-align:right;font-family:monospace;font-size:12px;color:#16a34a;font-weight:700">'
            +   e.available + ' <span style="font-size:10px;color:#64748b">' + escHtml(e.uom) + '</span></td>'
            + '<td style="padding:8px 10px;min-width:90px">'
            +   '<div style="background:#f1f5f9;border-radius:4px;height:8px;overflow:hidden">'
            +     '<div style="width:' + Math.min(pct,100) + '%;height:100%;background:' + barColor + ';border-radius:4px"></div>'
            +   '</div>'
            +   '<div style="font-size:9px;color:#64748b;text-align:right;margin-top:2px">' + pct + '% available</div>'
            + '</td>'
            + '</tr>';
    }).join('');

    var modal = document.createElement('div');
    modal.id = 'mtvStockErrorModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';

    var inner = document.createElement('div');
    inner.style.cssText = 'background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:560px;width:90%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column';

    var head = document.createElement('div');
    head.style.cssText = 'padding:16px 20px;background:#fef2f2;border-bottom:1px solid #fecaca;display:flex;align-items:center;justify-content:space-between';
    head.innerHTML = '<div>'
        + '<div style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Transfer Blocked</div>'
        + '<div style="font-size:16px;font-weight:800;color:#991b1b">Insufficient Stock</div>'
        + '</div>';
    var xBtn = document.createElement('button');
    xBtn.textContent = '\u2715';
    xBtn.style.cssText = 'width:28px;height:28px;border-radius:6px;border:1px solid #fecaca;background:transparent;color:#ef4444;cursor:pointer;font-size:16px;line-height:1';
    xBtn.onclick = function(){ modal.remove(); };
    head.appendChild(xBtn);

    var body = document.createElement('div');
    body.style.cssText = 'padding:14px 20px;overflow-y:auto';
    body.innerHTML = '<p style="font-size:12px;color:#64748b;margin:0 0 12px">The following materials do not have enough stock at the source location. Reduce the transfer quantity or replenish stock first.</p>'
        + '<table style="width:100%;border-collapse:collapse;font-size:12px">'
        + '<thead><tr style="background:#f8fafc">'
        + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase">Material</th>'
        + '<th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase">Requested</th>'
        + '<th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase">Available</th>'
        + '<th style="padding:7px 10px;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase">Stock Level</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';

    var foot = document.createElement('div');
    foot.style.cssText = 'padding:12px 20px;border-top:1px solid #e2e8f0;text-align:right';
    var okBtn = document.createElement('button');
    okBtn.textContent = "OK, I'll fix it";
    okBtn.style.cssText = 'height:34px;padding:0 20px;border-radius:7px;border:none;background:#2563eb;color:#fff;font-size:13px;font-weight:700;cursor:pointer';
    okBtn.onclick = function(){ modal.remove(); };
    foot.appendChild(okBtn);

    inner.appendChild(head);
    inner.appendChild(body);
    inner.appendChild(foot);
    modal.appendChild(inner);
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
}


async function saveMtv(forcedStatus) {
    var get=function(id){ var el=document.getElementById(id); return el?el.value.trim():''; };
    var mtvNum  = get('mtvNumInput');
    var mtvDate = get('mtvDateInput');
    var fromLoc = get('mtvFromInput');
    var toLoc   = get('mtvToInput');
    var remarks = get('mtvRemarksInput');
    var status  = forcedStatus || get('mtvStatusSel') || 'open';

    if(!mtvNum)  { toast('MTV number is required','error'); return; }
    if(!mtvDate) { toast('Date is required','error'); return; }
    if(!fromLoc) { toast('From Location is required','error'); return; }
    if(!toLoc)   { toast('To Location is required','error'); return; }

    _mtvItems.forEach(function(it,i){
        var q=document.getElementById('mtvQty-'+i);
        var m=document.getElementById('mtvMat-'+i);
        var p=document.getElementById('mtvPkgs-'+i);
        if(q){ it.qty_per_pkg=q.value; it.qty=String((parseFloat(p?p.value:'0')||0)*(parseFloat(q.value)||0)); }
        if(m)it.material_name=m.value.trim();
        if(p)it.packages=p.value;
    });
    var items=_mtvItems.filter(function(it){ return it.material_name&&(parseFloat(it.total_qty||it.qty))>0; });
    if(!items.length){ toast('Add at least one material with Qty > 0','error'); return; }

    // ── Stock availability check (for all saves, hard block on complete) ──
    var stockErrors = [];
    if (_mtvAllMats && _mtvAllMats.length) {
        items.forEach(function(it) {
            var mat = (_mtvAllMats||[]).find(function(r){
                return (r.name||'').toLowerCase() === (it.material_name||'').toLowerCase();
            });
            var available = mat ? (parseFloat(mat.in_stock_qty) || 0) : null;
            var requested = parseFloat(it.qty) || 0;
            if (available !== null && requested > available) {
                stockErrors.push({
                    name:      it.material_name,
                    requested: requested,
                    available: available,
                    uom:       it.uom || 'KG'
                });
            }
        });
    }

    if (stockErrors.length > 0) {
        var errLines = stockErrors.map(function(e){
            return '• ' + e.name + ': requested ' + e.requested + ' ' + e.uom
                 + ', available ' + e.available + ' ' + e.uom;
        });
        var msg = 'Insufficient stock for ' + stockErrors.length + ' item'
                + (stockErrors.length > 1 ? 's' : '') + ':\n\n'
                + errLines.join('\n')
                + '\n\nPlease reduce the quantity or check the stock levels.';
        toast('Insufficient stock — transfer blocked', 'error', 5000);
        // Show detailed modal
        _mtvShowStockError(stockErrors);
        return;
    }

    if(status==='completed'){
        if(!confirm('Complete this transfer?\n\nStock will be adjusted for '+items.length+' material(s). This cannot be undone.')) return;
    }
    var btn=document.getElementById('mtvCompletBtn');
    if(btn){btn.disabled=true;btn.textContent='Saving\u2026';}

    try {
        var res=await fetch('/api/procurement/mtv/save',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:_mtvEditId,mtv_num:mtvNum,mtv_date:mtvDate,
                from_loc:fromLoc,to_loc:toLoc,remarks:remarks,status:status,
                voucher_type_name:(document.getElementById('mtvVoucherTypeSelect')?document.getElementById('mtvVoucherTypeSelect').value:'')||null,
                items:items})
        });
        var data=await res.json();
        if(data.status!=='ok') {
            if(data.stock_errors && data.stock_errors.length) {
                var errs = data.stock_errors.map(function(e){
                    return { name: e.material, requested: e.requested, available: e.available, uom: 'KG' };
                });
                _mtvShowStockError(errs);
                return;
            }
            throw new Error(data.message);
        }
        toast(status==='completed'?'\u2705 Transfer completed \u2014 '+data.mtv_num:'MTV saved \u2014 '+data.mtv_num,'success',4500);
        _mtvEditId=data.id;
        openMtvForm(data.id);
    } catch(e){
        toast('Save failed: '+e.message,'error');
        if(btn){btn.disabled=false;btn.textContent='Complete Transfer';}
    }
}

/* ══════════════════════════════════════════════════════════════════
   DELETE (from form)
══════════════════════════════════════════════════════════════════ */
async function mtvDeleteCurrent() {
    if(!_mtvEditId) return;
    if(!confirm('Delete this MTV permanently?')) return;
    try {
        var res=await fetch('/api/procurement/mtv/delete',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:_mtvEditId})
        });
        var data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast('MTV deleted','info');
        _mtvCloseForm();
    } catch(e){ toast('Delete failed: '+e.message,'error'); }
}

/* ══════════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════════ */
(function(){
    var _mtvInited=false;
    var tc=document.getElementById('tc-mtv');
    if(!tc) return;
    var obs=new MutationObserver(function(){
        if(tc.classList.contains('active')&&!_mtvInited){
            _mtvInited=true; obs.disconnect(); loadMtvList();
        }
    });
    obs.observe(tc,{attributes:true,attributeFilter:['class']});
})();
