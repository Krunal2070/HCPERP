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
        _mtvRenderList();
    } catch (e) {
        body.innerHTML = '<div class="state-box"><h3>Error loading MTVs</h3><p>' + escHtml(e.message) + '</p></div>';
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
        + '<th style="padding:8px 6px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:90px">Qty</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:120px">From Godown</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:120px">To Godown</th>'
        + '<th style="padding:8px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:90px">Status</th>'
        + '<th style="padding:8px 6px;width:120px"></th>'
        + '</tr></thead><tbody>';

    var srNo = 0;
    rows.forEach(function(r) {
        var items = itemMap[String(r.id)] || [];
        var ss  = statusStyle[r.status] || '';
        var sl  = statusLabel[r.status] || r.status || '—';
        var sel = _mtvSelected.has(r.id);
        var rowSelStyle = sel ? 'background:rgba(37,99,235,.06)' : '';

        if (items.length === 0) {
            // No items — show a single placeholder row
            srNo++;
            html += _mtvListRow(r, null, srNo, ss, sl, sel, rowSelStyle, true);
        } else {
            items.forEach(function(it, ii) {
                srNo++;
                html += _mtvListRow(r, it, srNo, ss, sl, sel, rowSelStyle, ii === 0);
            });
        }
    });

    html += '</tbody></table>';
    body.innerHTML = html;
}

function _mtvListRow(r, item, srNo, ss, sl, sel, rowSelStyle, showActions) {
    var itemName = item ? escHtml(item.material_name || '—') : '<span style="color:var(--muted);font-style:italic">No items</span>';
    var qtyStr   = '';
    if (item && item.qty) {
        try { qtyStr = parseFloat(item.qty).toLocaleString('en-IN', {maximumFractionDigits:3}) + ' ' + (item.uom || ''); }
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
        // Qty
        + '<td style="padding:6px 6px;text-align:right;font-weight:600;font-family:var(--font-mono);font-size:12px">' + qtyStr + '</td>'
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
                lines.push('  ' + (j+1) + '. ' + (it.material_name||'—') + '  \u2014  ' + q);
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
                lines.push((i+1) + '. ' + (it.material_name||'—') + '  \u2014  ' + q);
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
async function openMtvForm(id) {
    _mtvEditId = id || null;
    _mtvItems  = [];

    if (!_mtvAllMats.length)    await _mtvLoadMats();
    if (!_mtvAllGodowns.length) await _mtvLoadGodowns();

    document.getElementById('mtv-list-pane').style.display = 'none';
    document.getElementById('mtv-form-pane').style.display = 'block';
    document.getElementById('mtv-form-body').innerHTML =
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
        return { material_id: it.material_id||null, material_name: it.material_name||'',
                 qty: it.qty||'', uom: it.uom||'kg', remarks: it.remarks||'' };
    });
    if (!_mtvItems.length) _mtvItems.push(_mtvBlankItem());

    document.getElementById('mtv-form-body').innerHTML = _mtvBuildFormHTML(rec, nextNum);
    _mtvRenderItemRows();
}

function _mtvCloseForm() {
    document.getElementById('mtv-list-pane').style.display = '';
    document.getElementById('mtv-form-pane').style.display = 'none';
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
    out += '<div style="display:grid;grid-template-columns:170px 150px 1fr 1fr;gap:12px;margin-bottom:12px">';
    out += '<div class="form-group"><label class="form-label">MTV Number</label>'
         + '<input class="form-input-styled" type="text" id="mtvNumInput" value="' + escHtml(mtvNum) + '" ' + dis
         + ' autocomplete="off" style="font-family:var(--font-mono);font-weight:600"></div>';
    out += '<div class="form-group"><label class="form-label">Date</label>'
         + '<input class="form-input-styled" type="date" id="mtvDateInput" value="' + mtvDate + '" ' + dis + '></div>';
    out += '<div class="form-group"><label class="form-label">From Location <span class="req">*</span></label>'
         + '<div style="position:relative">'
         + '<input class="form-input-styled" type="text" id="mtvFromInput" value="' + escHtml(fromLoc) + '" ' + dis
         + ' placeholder="Store / Godown / Lab\u2026" autocomplete="off"'
         + (!_mtvLocked ? ' oninput="_mtvLocInput(\'from\')" onblur="_mtvLocBlur(\'from\')" onfocus="_mtvLocInput(\'from\')"' : '')
         + '>'
         + (!_mtvLocked ? '<div id="mtvFromDd" style="display:none;position:absolute;top:100%;left:0;right:0;'
         + 'background:var(--card);border:1px solid var(--border2);border-radius:7px;'
         + 'box-shadow:0 6px 24px rgba(0,0,0,.18);z-index:400;max-height:220px;overflow-y:auto"></div>' : '')
         + '</div></div>';
    out += '<div class="form-group"><label class="form-label">To Location <span class="req">*</span></label>'
         + '<div style="position:relative">'
         + '<input class="form-input-styled" type="text" id="mtvToInput" value="' + escHtml(toLoc) + '" ' + dis
         + ' placeholder="Production / QC / Dispatch\u2026" autocomplete="off"'
         + (!_mtvLocked ? ' oninput="_mtvLocInput(\'to\')" onblur="_mtvLocBlur(\'to\')" onfocus="_mtvLocInput(\'to\')"' : '')
         + '>'
         + (!_mtvLocked ? '<div id="mtvToDd" style="display:none;position:absolute;top:100%;left:0;right:0;'
         + 'background:var(--card);border:1px solid var(--border2);border-radius:7px;'
         + 'box-shadow:0 6px 24px rgba(0,0,0,.18);z-index:400;max-height:220px;overflow-y:auto"></div>' : '')
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
    out += '<div class="form-card" style="margin:10px 16px 18px;border-radius:10px">';
    out += '<div class="form-card-head">'
         + '<div class="form-card-head-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> MATERIALS TO TRANSFER</div>'
         + '<div style="display:flex;align-items:center;gap:8px">'
         + '<span id="mtvLineCount" style="font-size:10px;color:rgba(255,255,255,.7)">0 items</span>';
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
         + '<th style="padding:7px 8px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:110px">Qty</th>'
         + '<th style="padding:7px 8px;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:95px">UOM</th>'
         + '<th style="padding:7px 8px;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Remarks</th>'
         + (!_mtvLocked ? '<th style="padding:7px 8px;width:28px"></th>' : '')
         + '</tr></thead><tbody id="mtvItemTbody"></tbody>';
    if (!_mtvLocked) {
        out += '<tfoot><tr style="border-top:1px solid var(--border)"><td colspan="6" style="padding:6px 10px">'
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
function _mtvBlankItem() { return { material_id:null, material_name:'', qty:'', uom:'kg', remarks:'' }; }

function _mtvRenderItemRows() {
    var tbody = document.getElementById('mtvItemTbody');
    if (!tbody) return;
    var filled = _mtvItems.filter(function(it){ return it.material_name && parseFloat(it.qty)>0; }).length;
    var lc = document.getElementById('mtvLineCount');
    if (lc) lc.textContent = filled + (filled===1?' item':' items');
    var uoms = ['kg','g','mg','L','mL','pcs','bags','drums','bottles'];
    var html = '';
    _mtvItems.forEach(function(it, i) {
        var bg = i%2===0 ? '' : 'background:var(--surface)';
        if (_mtvLocked) {
            html += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
                + '<td style="padding:8px;text-align:center;color:var(--muted);font-size:11px">' + (i+1) + '</td>'
                + '<td style="padding:8px;font-weight:500">' + escHtml(it.material_name||'\u2014') + '</td>'
                + '<td style="padding:8px;text-align:right;font-weight:600">' + escHtml(String(it.qty||'')) + '</td>'
                + '<td style="padding:8px;color:var(--muted)">' + escHtml(it.uom||'') + '</td>'
                + '<td style="padding:8px;color:var(--muted);font-size:11.5px">' + escHtml(it.remarks||'') + '</td>'
                + '</tr>';
        } else {
            html += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
                + '<td style="padding:5px 8px;text-align:center;color:var(--muted);font-size:11px">' + (i+1) + '</td>'
                + '<td style="padding:4px 6px"><div style="position:relative">'
                +   '<input class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;width:100%" '
                +     'id="mtvMat-' + i + '" value="' + escHtml(it.material_name) + '" '
                +     'placeholder="Type to search\u2026" oninput="_mtvMatInput(' + i + ')" onblur="_mtvMatBlur(' + i + ')" autocomplete="off">'
                +   '<div id="mtvMatDd-' + i + '" style="display:none;position:absolute;top:100%;left:0;right:0;'
                +     'background:var(--card);border:1px solid var(--border2);border-radius:7px;'
                +     'box-shadow:0 6px 24px rgba(0,0,0,.18);z-index:300;max-height:220px;overflow-y:auto"></div>'
                + '</div></td>'
                + '<td style="padding:4px 6px"><input class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;text-align:right;width:100%" '
                +   'type="number" step="any" min="0" id="mtvQty-' + i + '" value="' + escHtml(String(it.qty||'')) + '" '
                +   'placeholder="0" oninput="_mtvQtyChange(' + i + ')"></td>'
                + '<td style="padding:4px 6px"><select class="form-input-styled" style="font-size:12px;padding:5px 8px;margin:0;width:100%" '
                +   'id="mtvUom-' + i + '" onchange="_mtvUomChange(' + i + ')">'
                +   uoms.map(function(u){ return '<option value="' + u + '"' + (it.uom===u?' selected':'') + '>' + u + '</option>'; }).join('')
                + '</select></td>'
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
function _mtvQtyChange(i)    { var el=document.getElementById('mtvQty-'+i); if(el)_mtvItems[i].qty=el.value; _mtvUpdateCount(); }
function _mtvUomChange(i)    { var el=document.getElementById('mtvUom-'+i); if(el)_mtvItems[i].uom=el.value; }
function _mtvRowRmkChange(i) { var el=document.getElementById('mtvRowRmk-'+i); if(el)_mtvItems[i].remarks=el.value; }
function _mtvUpdateCount() {
    var f=_mtvItems.filter(function(it){ return it.material_name&&parseFloat(it.qty)>0; }).length;
    var lc=document.getElementById('mtvLineCount');
    if(lc)lc.textContent=f+(f===1?' item':' items');
}

async function _mtvLoadMats() {
    try {
        var res=await fetch('/api/procurement/materials');
        var d=await res.json();
        _mtvAllMats=(d.materials||[]).map(function(m){ return {id:m.id,name:m.material_name||''}; });
    } catch(e){ _mtvAllMats=[]; }
}

async function _mtvLoadGodowns() {
    try {
        var res = await fetch('/api/procurement/godowns');
        var d   = await res.json();
        _mtvAllGodowns = (d.godowns || [])
            .filter(function(g){ return g.type !== 'billing'; })
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
        return '<div style="padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border);'
            + 'display:flex;align-items:center;gap:10px;transition:background .1s" '
            + 'onmouseover="this.style.background=\'var(--surface2)\'" '
            + 'onmouseout="this.style.background=\'\'" '
            + 'onmousedown="_mtvLocSelect(\'' + which + '\',\'' + safeName + '\')">'
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
    }, 160);
}

function _mtvMatInput(i) {
    var inp=document.getElementById('mtvMat-'+i);
    var dd=document.getElementById('mtvMatDd-'+i);
    var q=inp?inp.value.toLowerCase().trim():'';
    _mtvItems[i].material_name=inp?inp.value:'';
    _mtvItems[i].material_id=null;
    if(!q||!dd){if(dd)dd.style.display='none';return;}
    var hits=_mtvAllMats.filter(function(m){ return m.name.toLowerCase().includes(q); }).slice(0,12);
    if(!hits.length){dd.style.display='none';return;}
    dd.innerHTML=hits.map(function(m){
        var sn=m.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return '<div style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border);transition:background .1s" '
            +'onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'" '
            +'onmousedown="_mtvSelectMat('+i+','+m.id+',\''+sn+'\')">'+escHtml(m.name)+'</div>';
    }).join('');
    dd.style.display='block';
}
function _mtvSelectMat(i,id,name){
    _mtvItems[i].material_id=id;_mtvItems[i].material_name=name;
    var inp=document.getElementById('mtvMat-'+i);
    var dd=document.getElementById('mtvMatDd-'+i);
    if(inp)inp.value=name;if(dd)dd.style.display='none';_mtvUpdateCount();
}
function _mtvMatBlur(i){
    setTimeout(function(){
        var dd=document.getElementById('mtvMatDd-'+i);
        var inp=document.getElementById('mtvMat-'+i);
        if(dd)dd.style.display='none';
        if(inp){_mtvItems[i].material_name=inp.value.trim();_mtvUpdateCount();}
    },160);
}

/* ══════════════════════════════════════════════════════════════════
   SAVE
══════════════════════════════════════════════════════════════════ */
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
        if(q)it.qty=q.value; if(m)it.material_name=m.value.trim();
    });
    var items=_mtvItems.filter(function(it){ return it.material_name&&parseFloat(it.qty)>0; });
    if(!items.length){ toast('Add at least one material with Qty > 0','error'); return; }

    if(status==='completed'){
        if(!confirm('Complete this transfer?\n\nStock will be adjusted for '+items.length+' material(s). This cannot be undone.')) return;
    }
    var btn=document.getElementById('mtvCompletBtn');
    if(btn){btn.disabled=true;btn.textContent='Saving\u2026';}

    try {
        var res=await fetch('/api/procurement/mtv/save',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:_mtvEditId,mtv_num:mtvNum,mtv_date:mtvDate,
                from_loc:fromLoc,to_loc:toLoc,remarks:remarks,status:status,items:items})
        });
        var data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
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
