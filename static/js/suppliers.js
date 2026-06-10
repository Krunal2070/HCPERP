/* suppliers.js — Suppliers tab: list, modal, save/delete, quick-new
   Depends on: utils.js */

/* ════════════════════════════════════════════════════════════════
   SUPPLIERS TAB
════════════════════════════════════════════════════════════════ */
var _supRows = [], _supFiltered = [];

/* ════════════════════════════════════════════════════════════════
   SUPPLIERS TAB  —  proper CRUD against procurement_suppliers DB
════════════════════════════════════════════════════════════════ */
var _supRows = [], _supFiltered = [], _supFilter = 'all';
var _supPage = 1, _supPageSize = 25, _supEditId = null;
var _supTypes = [];  // [{id, type_name}]

/* Load supplier types from server, populate all type dropdowns */
function loadSupTypes(cb) {
    fetch('/api/supplier_types')
        .then(function(r){ return r.json(); })
        .then(function(data) {
            _supTypes = data.types || [];
            _supPopulateTypeDropdowns();
            if (typeof cb === 'function') cb();
        })
        .catch(function(){});
}

function _supPopulateTypeDropdowns() {
    var opts = '<option value="">&#8212; Select Type &#8212;</option>' +
        _supTypes.map(function(t){
            return '<option value="' + t.id + '">' + escHtml(t.type_name) + '</option>';
        }).join('');
    var modalSel = document.getElementById('supModalType');
    if (modalSel) modalSel.innerHTML = opts;

    // Toolbar filter dropdown
    var filterSel = document.getElementById('supTypeFilter');
    if (filterSel) {
        filterSel.innerHTML = '<option value="">All Types</option>' +
            _supTypes.map(function(t){
                return '<option value="' + t.id + '">' + escHtml(t.type_name) + '</option>';
            }).join('');
    }
}

function loadSupData() {
    document.getElementById('supTbody').innerHTML =
        '<tr><td colspan="15"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    loadSupTypes(function() {
        fetch('/api/procurement/suppliers')
        .then(function(r){ return r.json(); })
        .then(function(data) {
            if (data.status !== 'ok') throw new Error(data.message || 'Load failed');
            _supRows = data.suppliers || [];
            var b = document.getElementById('supBadge');
            if (b) { b.textContent = _supRows.length; b.style.display = _supRows.length ? '' : 'none'; }
            document.getElementById('supRowBadge').textContent = _supRows.length + ' suppliers';
            supApplyFilters();
        })
        .catch(function(err) {
            document.getElementById('supTbody').innerHTML =
                '<tr><td colspan="15"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed</h3><p>' + escHtml(err.message) + '</p></div></td></tr>';
        });
    }); // end loadSupTypes
}

function supSetFilter(f) {
    _supFilter = f;
    document.getElementById('supFAll').classList.toggle('active', f === 'all');
    document.getElementById('supFActive').classList.toggle('active', f === 'active');
    document.getElementById('supFInactive').classList.toggle('active', f === 'inactive');
    _supPage = 1; supApplyFilters(); supUpdateFilterDot();
}

function supApplyFilters() {
    var q = (document.getElementById('supSearchInput').value || '').toLowerCase();
    var payFilter = (document.getElementById('supPayTypeFilter') ? document.getElementById('supPayTypeFilter').value : '').toLowerCase();
    var typeFilter = (document.getElementById('supTypeFilter') ? document.getElementById('supTypeFilter').value : '');
    _supFiltered = _supRows.filter(function(r) {
        if (_supFilter !== 'all' && r.status !== _supFilter) return false;
        if (payFilter && (r.payment_type||'').toLowerCase() !== payFilter) return false;
        if (typeFilter && String(r.supplier_type_id||'') !== typeFilter) return false;
        if (!q) return true;
        return (r.supplier_name + ' ' + (r.contact_person||'') + ' ' + (r.phone||'') + ' ' + (r.gst_number||'') + ' ' + (r.supplier_type_name||'')).toLowerCase().includes(q);
    });
    _supPage = 1; supRenderTable();
}

function supRenderTable() {
    var ps = _supPageSize === 0 ? _supFiltered.length : _supPageSize;
    var start = (_supPage - 1) * ps;
    var rows = ps ? _supFiltered.slice(start, start + ps) : _supFiltered;
    if (!rows.length) {
        document.getElementById('supTbody').innerHTML =
            '<tr><td colspan="15"><div class="state-box"><div class="state-icon">🏭</div><h3>No Suppliers Found</h3>' +
            '<p>Click "Add Supplier" or "Sync from Materials" to get started.</p></div></td></tr>';
    } else {
        var stars = ['','⭐','⭐⭐','⭐⭐⭐','⭐⭐⭐⭐','⭐⭐⭐⭐⭐'];
        document.getElementById('supTbody').innerHTML = rows.map(function(r, i) {
            var statusPill = r.status === 'active'
                ? '<span class="po-status received">ACTIVE</span>'
                : '<span class="po-status draft">INACTIVE</span>';
            var payLabel = r.payment_type
                ? escHtml(r.payment_type) + (r.credit_days ? ' · <strong>'+r.credit_days+'d</strong>' : '')
                : escHtml(r.payment_terms || '—');
            var typePill = r.supplier_type_name
                ? '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2);white-space:nowrap">' + escHtml(r.supplier_type_name) + '</span>'
                : '<span style="color:var(--muted);font-size:11px">—</span>';
            return '<tr ondblclick="openSupModal(' + (start+i) + ')" style="cursor:pointer">' +
                '<td class="td-sr">' + (start + i + 1) + '</td>' +
                '<td style="font-family:var(--font-mono);font-size:11px;color:var(--teal);font-weight:700;white-space:nowrap">' + escHtml(r.supplier_code || '—') + '</td>' +
                '<td style="font-weight:600;white-space:nowrap"><a onclick="event.stopPropagation();openSupLedger(' + (start+i) + ')" style="color:var(--teal);cursor:pointer;text-decoration:none" title="View Supplier Ledger">' + escHtml(r.supplier_name) + '</a></td>' +
                '<td>' + typePill + '</td>' +
                '<td style="font-size:12px">' + escHtml(r.contact_person || '—') + '</td>' +
                '<td style="display:none">' + escHtml(r.phone || '—') + '</td>' +
                '<td style="display:none">' + escHtml(r.email || '—') + '</td>' +
                '<td style="display:none">' + escHtml(r.gst_number || '—') + '</td>' +
                '<td style="font-size:11px">' + payLabel + '</td>' +
                '<td class="td-mono" style="text-align:center">' + (r.credit_days ? r.credit_days + ' d' : '—') + '</td>' +
                '<td class="td-mono" style="text-align:center">' + (r.lead_time_days ? r.lead_time_days + 'd' : '—') + '</td>' +
                '<td class="td-mono" style="text-align:center">' + (r.moq || '—') + '</td>' +
                '<td style="text-align:center;font-size:12px">' + (r.rating ? stars[r.rating] : '—') + '</td>' +
                '<td>' + statusPill + '</td>' +
                '<td style="text-align:center">' +
                (r.mat_count > 0
                    ? '<span onclick="event.stopPropagation();openSupMatModal(\''+escHtml(r.supplier_name).replace(/'/g,"\\'")+'\','+(start+i)+')" '
                      +'title="Click to view '+r.mat_count+' linked materials" '
                      +'style="font-family:var(--font-mono);font-size:11px;background:rgba(13,148,136,.15);color:var(--teal);padding:2px 10px;border-radius:20px;cursor:pointer;font-weight:700;border:1px solid rgba(13,148,136,.25)" '
                      +'onmouseover="this.style.background=\'rgba(13,148,136,.28)\'" '
                      +'onmouseout="this.style.background=\'rgba(13,148,136,.15)\'">'
                      +r.mat_count+'</span>'
                    : '<span style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">0</span>') +
                '</td>' +
                '<td><button class="act-btn" style="padding:4px 10px;font-size:11px" onclick="event.stopPropagation();openSupModal(' + (start+i) + ')">Edit</button></td>' +
                '</tr>';
        }).join('');
    }
    // Pagination
    var total = _supFiltered.length;
    var tp = _supPageSize === 0 ? 1 : Math.max(1, Math.ceil(total / _supPageSize));
    var s = _supPageSize === 0 ? 1 : (_supPage - 1) * _supPageSize + 1;
    var e = _supPageSize === 0 ? total : Math.min(_supPage * _supPageSize, total);
    document.getElementById('supPgInfo').textContent = total === 0 ? 'No suppliers' : s + '–' + e + ' of ' + total;
    var wrap = document.getElementById('supPgButtons');
    if (tp <= 1) { wrap.innerHTML = ''; return; }
    var h = '<button class="pg-btn" onclick="supGoPage(' + (_supPage-1) + ')" ' + (_supPage===1?'disabled':'') + '>‹</button>';
    for (var p=1;p<=Math.min(tp,7);p++) h += '<button class="pg-page-btn ' + (p===_supPage?'active':'') + '" onclick="supGoPage('+p+')">' + p + '</button>';
    h += '<button class="pg-btn" onclick="supGoPage(' + (_supPage+1) + ')" ' + (_supPage===tp?'disabled':'') + '>›</button>';
    wrap.innerHTML = h;
}
function supGoPage(p) { _supPage = Math.max(1, Math.min(p, Math.ceil(_supFiltered.length / (_supPageSize||1)))); supRenderTable(); }
function supOnPageSizeChange() { _supPageSize = parseInt(document.getElementById('supPgSizeSelect').value); _supPage = 1; supRenderTable(); }

function openSupModal(idxOrNull) {
    var r = (idxOrNull !== null && idxOrNull !== undefined) ? _supFiltered[parseInt(idxOrNull)] : null;
    _supEditId = r ? r.id : null;

    /* Helper: safe set value */
    var sv = function(id, val){ var e=document.getElementById(id); if(e) e.value = val||''; };

    sv('supModalName',        r ? r.supplier_name   : '');
    sv('supModalContact',     r ? r.contact_person  : '');
    sv('supModalPhone',       r ? r.phone           : '');
    sv('supModalEmail',       r ? r.email           : '');
    sv('supModalAddress',     r ? (r.address||'')   : '');
    sv('supModalGst',         r ? r.gst_number      : '');
    sv('supModalPan',         r ? r.pan_number      : '');
    sv('supModalPayTerms',    r ? r.payment_terms   : '');
    sv('supModalPayType',     r ? r.payment_type    : '');
    sv('supModalCreditDays',  r ? r.credit_days     : '');
    sv('supModalCurrency',    r ? (r.currency||'INR') : 'INR');
    sv('supModalLeadTime',    r ? r.lead_time_days  : '');
    sv('supModalMoq',         r ? r.moq             : '');
    sv('supModalRating',      r ? r.rating          : '');
    sv('supModalStatus',      r ? (r.status||'active') : 'active');
    sv('supModalType',        r ? (r.supplier_type_id||'') : '');

    /* Title + badge */
    var titleEl   = document.getElementById('supModalTitle');
    var eyeEl     = document.getElementById('supModalEyebrow');
    var codeEl    = document.getElementById('supModalCode');
    var delBtn    = document.getElementById('supModalDeleteBtn');
    if (titleEl) titleEl.textContent = r ? 'Edit Supplier' : 'Add Supplier';
    if (eyeEl)   eyeEl.textContent   = r ? 'EDIT SUPPLIER' : 'NEW SUPPLIER';
    if (codeEl)  codeEl.textContent  = r ? (r.supplier_code||'—') : 'Auto: HCPRMS-????';
    if (codeEl && !r) {
        // Fetch next preview code asynchronously for new supplier
        codeEl.style.color   = 'var(--muted)';
        codeEl.style.opacity = '.7';
        fetch('/api/procurement/suppliers/next_code')
            .then(function(res){ return res.json(); })
            .then(function(d){ if(d.status==='ok' && codeEl){ codeEl.textContent=d.next_code+' (preview)'; } })
            .catch(function(){});
    } else if(codeEl){
        codeEl.style.color   = 'var(--teal)';
        codeEl.style.opacity = '1';
    }
    if (delBtn)  delBtn.style.display = r ? '' : 'none';

    /* T&C, payment toggle */
    if (typeof tcPopulateSelect === 'function') tcPopulateSelect('supModalTCList', r ? (r.tc_list_id||null) : null);
    if (r && r.tc_list_id && typeof supPreviewTC === 'function') supPreviewTC(r.tc_list_id);
    if (typeof supToggleCredit === 'function') supToggleCredit();

    document.getElementById('supModal').classList.add('open');
    setTimeout(function(){ var e=document.getElementById('supModalName'); if(e) e.focus(); }, 80);
}
function closeSupModal() { document.getElementById('supModal').classList.remove('open'); }

function saveSupplier(addAnother) {
    var name = document.getElementById('supModalName').value.trim();
    if (!name) { toast('Supplier name is required', 'error'); return; }
    var payload = {
        id:             _supEditId,
        supplier_name:  name,
        contact_person: document.getElementById('supModalContact').value.trim(),
        phone:          document.getElementById('supModalPhone').value.trim(),
        email:          document.getElementById('supModalEmail').value.trim(),
        address:        (document.getElementById('supModalAddress')||{value:''}).value.trim(),
        gst_number:     document.getElementById('supModalGst').value.trim(),
        pan_number:     document.getElementById('supModalPan').value.trim(),
        payment_terms:  document.getElementById('supModalPayTerms').value.trim(),
        currency:       document.getElementById('supModalCurrency').value,
        payment_type:   (document.getElementById('supModalPayType')||{}).value || null,
        credit_days:    (document.getElementById('supModalCreditDays')||{}).value || null,
        tc_list_id:     document.getElementById('supModalTCList').value || null,
        lead_time_days: document.getElementById('supModalLeadTime').value || null,
        moq:            document.getElementById('supModalMoq').value || null,
        rating:         document.getElementById('supModalRating').value || null,
        status:         document.getElementById('supModalStatus').value,
        supplier_type_id: (document.getElementById('supModalType')||{}).value || null,
    };
    fetch('/api/procurement/suppliers/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') throw new Error(data.message);
        toast(_supEditId ? 'Supplier updated' : 'Supplier added — ' + (data.supplier_code || ''), 'success');
        closeSupModal();
        loadSupData();
        if (addAnother) setTimeout(function(){ openSupModal(null); }, 300);
    })
    .catch(function(err){ toast('Save failed: ' + err.message, 'error'); });
}

function deleteSupplier() {
    if (!_supEditId) return;
    var name = document.getElementById('supModalName').value.trim();
    if (!confirm('Delete supplier "' + name + '"?\n\nThis will not affect materials already linked to this supplier.')) return;
    fetch('/api/procurement/suppliers/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: _supEditId})
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Supplier deleted', 'success');
        closeSupModal();
        loadSupData();
    })
    .catch(function(err){ toast('Delete failed: ' + err.message, 'error'); });
}

function syncSuppliersFromMaterials() {
    if (!confirm('This will import all supplier names from Material Master into the Supplier database.\nExisting records will not be overwritten.\n\nContinue?')) return;
    fetch('/api/procurement/suppliers/sync_from_materials', {method:'POST'})
        .then(function(r){ return r.json(); })
        .then(function(data) {
            if (data.status !== 'ok') throw new Error(data.message);
            toast(data.inserted + ' new suppliers imported', 'success');
            loadSupData();
        })
        .catch(function(err){ toast('Sync failed: ' + err.message, 'error'); });
}



/* ════════════════════════════════════════════════════════════════
   SUPPLIER LEDGER — full tab with PO & GRN item details
════════════════════════════════════════════════════════════════ */
var _supLedgerIdx = null;

// Toggle sidebar submenu
function supToggleSidebarGroup() {
    var sub = document.getElementById('sbg-sup-sub');
    var grp = document.getElementById('sbg-sup');
    if (!sub) return;
    var open = sub.classList.contains('open');
    sub.classList.toggle('open', !open);
    grp.classList.toggle('open', !open);
}

// Open ledger tab from sidebar
function openSupLedgerTab() {
    switchTab('sup-ledger');
    setSidebarActive('sup-ledger');
    supLedgerPopulateSelect();
    // Expand submenu if not open
    var sub = document.getElementById('sbg-sup-sub');
    if (sub && !sub.classList.contains('open')) supToggleSidebarGroup();
}

// When clicking supplier name link from list → go to ledger tab with that supplier pre-selected
function openSupLedger(idx) {
    var sup = _supFiltered[idx];
    if (!sup) return;
    openSupLedgerTab();
    setTimeout(function(){
        var sel = document.getElementById('supLedgerSupplierSel');
        if (sel) { sel.value = sup.supplier_name; supLedgerFilter(); }
    }, 100);
}

function supLedgerPopulateSelect() {
    var sel = document.getElementById('supLedgerSupplierSel');
    if (!sel) return;
    var existing = sel.value;
    sel.innerHTML = '<option value="">— All Suppliers —</option>'
        + (_supRows||[]).map(function(r){
            return '<option value="'+escHtml(r.supplier_name)+'">'+escHtml(r.supplier_name)+'</option>';
          }).join('');
    if (existing) sel.value = existing;
}

function supLedgerFilter() {
    var q   = (document.getElementById('supLedgerSearch').value||'').toLowerCase().trim();
    var sel = (document.getElementById('supLedgerSupplierSel').value||'').trim();
    if (!sel && !q) {
        document.getElementById('supLedgerTabBody').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Select a supplier or search to view their ledger</div>';
        return;
    }
    var name = sel || q;
    document.getElementById('supLedgerTabBody').innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)"><div class="spinner"></div><br>Loading…</div>';
    _supLoadLedgerFull(name);
}

async function _supLoadLedgerFull(supplierName) {
    try {
        var [poRes, grnRes] = await Promise.all([
            fetch('/api/procurement/po/list').then(function(r){ return r.json(); }),
            fetch('/api/procurement/grn/list').then(function(r){ return r.json(); })
        ]);

        var allPOs  = (poRes.orders||[]).filter(function(p){
            return (p.supplier_name||p.supplier||'').toLowerCase().includes(supplierName.toLowerCase());
        });
        var allGRNs = (grnRes.grns||[]).filter(function(g){
            return (g.supplier_name||'').toLowerCase().includes(supplierName.toLowerCase());
        });

        // Fetch full detail (with line items) for each PO and GRN
        var poDetails  = await Promise.all(allPOs.map(function(p){
            return fetch('/api/procurement/po/get?id='+p.id).then(function(r){ return r.json(); })
                   .then(function(d){ return d.order || p; }).catch(function(){ return p; });
        }));
        var grnDetails = await Promise.all(allGRNs.map(function(g){
            return fetch('/api/procurement/grn/get?id='+g.id).then(function(r){ return r.json(); })
                   .then(function(d){ return d.grn || g; }).catch(function(){ return g; });
        }));

        _supRenderLedgerFull(supplierName, poDetails, grnDetails);
    } catch(e) {
        document.getElementById('supLedgerTabBody').innerHTML = '<div style="padding:20px;color:var(--red-text)">Error: '+escHtml(e.message)+'</div>';
    }
}

function _supRenderLedgerFull(supplierName, pos, grns) {
    var fi = function(n){ return n!=null ? '₹'+parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var fd = function(d){ if(!d)return'—'; var p=String(d).split('-'); if(p.length<3)return d; return p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]; };
    var statusPill = function(s){
        var map={open:'pending',partial:'partial',closed:'received',cancelled:'cancelled',approved:'approved'};
        return '<span class="po-status '+(map[s]||'draft')+'">'+s.toUpperCase()+'</span>';
    };

    // Store for whole-ledger share
    window._supLedgerData = { supplierName: supplierName, pos: pos, grns: grns };

    // Summary cards
    var openPOs   = pos.filter(function(p){ return p.status==='open'||p.status==='partial'||p.status==='approved'; });
    var closedPOs = pos.filter(function(p){ return p.status==='closed'; });
    var totalPOVal = pos.reduce(function(s,p){ return s+parseFloat(p.grand_total||0); }, 0);
    var totalGRNVal= grns.reduce(function(s,g){ return s+parseFloat(g.grand_total||0); }, 0);
    var pendingVal = openPOs.reduce(function(s,p){ return s+parseFloat(p.grand_total||0); }, 0);

    // Header with whole-ledger share buttons
    var sup = (_supRows||[]).find(function(s){ return s.supplier_name===supplierName; }) || {};
    var WA_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>';
    var EM_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';

    var html = '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px">'
             + '<div>'
             + '<div style="font-size:18px;font-weight:800;color:var(--text);margin-bottom:4px">'+escHtml(supplierName)+'</div>'
             + '<div style="font-size:11px;color:var(--muted)">Supplier PO &amp; GRN Ledger</div>'
             + '</div>'
             + '<div style="display:flex;gap:8px;align-items:center">'
             + '<button onclick="supLedgerWhatsAppAll()" style="display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:7px;border:1px solid #22c55e;background:#f0fdf4;color:#16a34a;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Send full ledger via WhatsApp">'+WA_SVG+' WhatsApp Ledger</button>'
             + '<button onclick="supLedgerEmailAll()" style="display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:7px;border:1px solid #3b82f6;background:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Email full ledger as PDF">'+EM_SVG+' Email Ledger PDF</button>'
             + '</div>'
             + '</div>';

    // Summary cards
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px">';
    [{label:'Total POs', val:pos.length, sub:fi(totalPOVal), c:'#1d4ed8'},
     {label:'Pending / Open', val:openPOs.length, sub:fi(pendingVal)+' pending', c:'#d97706'},
     {label:'Closed', val:closedPOs.length, sub:'fully received', c:'#16a34a'},
     {label:'GRNs Received', val:grns.length, sub:fi(totalGRNVal), c:'#0d9488'},
     {label:'Net Payable', val:fi(totalGRNVal), sub:'GRN value', c:'#7c3aed'},
    ].forEach(function(c){
        html += '<div style="padding:12px 14px;border:1px solid var(--border2);border-radius:9px;background:var(--surface)">'
             +  '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">'+c.label+'</div>'
             +  '<div style="font-size:18px;font-weight:900;color:'+c.c+'">'+c.val+'</div>'
             +  '<div style="font-size:10px;color:var(--muted);margin-top:2px">'+c.sub+'</div>'
             +  '</div>';
    });
    html += '</div>';

    // ── PURCHASE ORDERS ──
    html += '<div style="font-size:12px;font-weight:800;color:var(--text);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid var(--border2)">Purchase Orders</div>';

    if (!pos.length) {
        html += '<div style="padding:16px;text-align:center;color:var(--muted);border:1px solid var(--border2);border-radius:8px;margin-bottom:20px">No Purchase Orders for this supplier</div>';
    } else {
        pos.forEach(function(po){
            var items = po.items || [];
            var isBg = po.status==='closed'?'#f0fdf4': po.status==='cancelled'?'#fff1f2':'var(--surface)';
            html += '<div style="border:1px solid var(--border2);border-radius:10px;margin-bottom:12px;overflow:hidden">';
            // PO header row
            html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:'+isBg+';border-bottom:1px solid var(--border2);">'
                 +  '<div style="display:flex;align-items:center;gap:12px">'
                 +  '<span style="font-family:var(--font-mono);font-size:13px;font-weight:800;color:var(--teal)">'+escHtml(po.po_num||'—')+'</span>'
                 +  statusPill(po.status||'open')
                 +  '<span style="font-size:11px;color:var(--muted)">Date: '+fd(po.po_date)+'</span>'
                 +  (po.delivery_date?'<span style="font-size:11px;color:var(--muted)">Expected: '+fd(po.delivery_date)+'</span>':'')
                 +  '</div>'
                 +  '<div style="display:flex;align-items:center;gap:8px">'
                 +  '<span style="font-family:var(--font-mono);font-size:14px;font-weight:800;color:var(--text)">'+fi(po.grand_total)+'</span>'
                 +  (po.id ? '<button onclick="_supLedgerWhatsApp('+po.id+')" style="display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid #22c55e;background:#f0fdf4;color:#16a34a;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Send via WhatsApp"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg> WhatsApp</button>' : '')
                 +  (po.id ? '<button onclick="_supLedgerEmail('+po.id+',\''+escHtml(po.po_num||'')+'\',\''+escHtml(supplierName)+'\')" style="display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid #3b82f6;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Email PDF"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> Email PDF</button>' : '')
                 +  '</div>'
                 +  '</div>';
            // Items table
            if (items.length) {
                html += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
                     +  '<thead><tr style="background:var(--surface2)">'
                     +  '<th style="padding:6px 12px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">#</th>'
                     +  '<th style="padding:6px 12px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Material</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Qty (kg)</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Rate (₹)</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Amount (₹)</th>'
                     +  '<th style="padding:6px 12px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">GST %</th>'
                     +  '</tr></thead><tbody>';
                items.forEach(function(it, ii){
                    var qty  = parseFloat(it.qty||0);
                    var rate = parseFloat(it.rate||0);
                    var amt  = qty * rate;
                    html += '<tr style="border-bottom:1px solid var(--border);background:'+(ii%2?'var(--surface2)':'')+';">'
                         +  '<td style="padding:7px 12px;color:var(--muted);font-size:11px">'+(ii+1)+'</td>'
                         +  '<td style="padding:7px 12px;font-weight:600">'+escHtml(it.material||'—')
                         +  (it.hsn_code?'<br><span style="font-size:9px;color:var(--muted)">HSN: '+escHtml(it.hsn_code)+'</span>':'')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono)">'+(qty>0?qty.toLocaleString('en-IN',{minimumFractionDigits:3})+'  kg':'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono)">'+(rate>0?fi(rate):'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono);font-weight:600">'+(amt>0?fi(amt):'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:center;font-family:var(--font-mono)">'+(it.gst_rate?parseFloat(it.gst_rate)+'%':'—')+'</td>'
                         +  '</tr>';
                });
                html += '</tbody></table>';
            } else {
                html += '<div style="padding:10px 14px;font-size:11px;color:var(--muted)">No item details available</div>';
            }
            html += '</div>';
        });
    }

    // ── GRNs ──
    html += '<div style="font-size:12px;font-weight:800;color:var(--text);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid var(--border2);margin-top:8px">Goods Receipt Notes</div>';

    if (!grns.length) {
        html += '<div style="padding:16px;text-align:center;color:var(--muted);border:1px solid var(--border2);border-radius:8px">No GRNs yet for this supplier</div>';
    } else {
        grns.forEach(function(grn){
            var items = grn.items || [];
            var poNums = [];
            if (grn.po_num) poNums.push(grn.po_num);
            if (grn.po_invoices&&grn.po_invoices.length) grn.po_invoices.forEach(function(inv){ if(inv.po_num&&poNums.indexOf(inv.po_num)===-1) poNums.push(inv.po_num); });

            html += '<div style="border:1px solid var(--border2);border-left:3px solid #16a34a;border-radius:10px;margin-bottom:12px;overflow:hidden">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0fdf4;border-bottom:1px solid var(--border2);">'
                 +  '<div style="display:flex;align-items:center;gap:12px">'
                 +  '<span style="font-family:var(--font-mono);font-size:13px;font-weight:800;color:#16a34a">'+escHtml(grn.grn_num||'—')+'</span>'
                 +  '<span style="font-size:11px;color:var(--muted)">Date: '+fd(grn.grn_date)+'</span>'
                 +  (poNums.length?'<span style="font-size:11px;color:var(--teal)">POs: '+poNums.join(', ')+'</span>':'')
                 +  '</div>'
                 +  '<div style="display:flex;align-items:center;gap:8px">'
                 +  '<span style="font-family:var(--font-mono);font-size:14px;font-weight:800;color:var(--text)">'+fi(grn.grand_total)+'</span>'
                 +  (grn.id ? '<button onclick="_supLedgerGrnWhatsApp('+grn.id+')" style="display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid #22c55e;background:#f0fdf4;color:#16a34a;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Send via WhatsApp"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg> WhatsApp</button>' : '')
                 +  (grn.id ? '<button onclick="_supLedgerGrnEmail('+grn.id+',\''+escHtml(grn.grn_num||'')+'\',\''+escHtml(supplierName)+'\')" style="display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid #3b82f6;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body)" title="Email PDF"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> Email PDF</button>' : '')
                 +  '</div>'
                 +  '</div>';

            if (items.length) {
                html += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
                     +  '<thead><tr style="background:var(--surface2)">'
                     +  '<th style="padding:6px 12px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">#</th>'
                     +  '<th style="padding:6px 12px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Material</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">PO Qty</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Recd Qty</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Rate (₹)</th>'
                     +  '<th style="padding:6px 12px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Amount (₹)</th>'
                     +  '<th style="padding:6px 12px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Batch / Location</th>'
                     +  '</tr></thead><tbody>';
                items.forEach(function(it, ii){
                    var pqty = parseFloat(it.po_qty||0);
                    var rqty = parseFloat(it.received_qty||0);
                    var rate = parseFloat(it.rate||0);
                    var amt  = rqty * rate;
                    var batchLoc = [it.batch_num, it.location].filter(Boolean).join(' · ');
                    html += '<tr style="border-bottom:1px solid var(--border);background:'+(ii%2?'var(--surface2)':'')+';">'
                         +  '<td style="padding:7px 12px;color:var(--muted);font-size:11px">'+(ii+1)+'</td>'
                         +  '<td style="padding:7px 12px;font-weight:600">'+escHtml(it.material||'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono);color:var(--muted)">'+(pqty>0?pqty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg':'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono);font-weight:600;color:#16a34a">'+(rqty>0?rqty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg':'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono)">'+(rate>0?fi(rate):'—')+'</td>'
                         +  '<td style="padding:7px 12px;text-align:right;font-family:var(--font-mono);font-weight:600">'+(amt>0?fi(amt):'—')+'</td>'
                         +  '<td style="padding:7px 12px;font-size:11px;color:var(--muted)">'+escHtml(batchLoc||'—')+'</td>'
                         +  '</tr>';
                });
                html += '</tbody></table>';
            } else {
                html += '<div style="padding:10px 14px;font-size:11px;color:var(--muted)">No item details available</div>';
            }
            html += '</div>';
        });
    }

    document.getElementById('supLedgerTabBody').innerHTML = html;
}

/* ── Ledger WhatsApp / Email helpers ── */
async function _supLedgerWhatsApp(poId) {
    try {
        var res = await fetch('/api/procurement/po/get?id='+poId);
        var d   = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        var po   = d.order;
        var sup  = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase()===(po.supplier_name||'').toLowerCase(); }) || {};
        var phone= (sup.phone||'').replace(/[^0-9+]/g,'');
        var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var fd=function(d){if(!d)return'—';var p=String(d).split('-');return p.length===3?p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]:d;};
        var lines=['*Purchase Order — HCP Wellness Pvt Ltd*',''];
        lines.push('PO No: *'+(po.po_num||'—')+'*');
        lines.push('Date: '+fd(po.po_date));
        lines.push('Supplier: '+(po.supplier_name||'—'));
        lines.push('');
        if ((po.items||[]).length) {
            lines.push('*Line Items:*');
            po.items.forEach(function(it,i){
                var qty=parseFloat(it.qty||0), rate=parseFloat(it.rate||0), amt=qty*rate;
                lines.push((i+1)+'. '+it.material
                    +'  —  Qty: '+qty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg'
                    +'  |  Rate: ₹'+rate.toLocaleString('en-IN',{minimumFractionDigits:2})
                    +(amt>0?'  |  Amt: ₹'+amt.toLocaleString('en-IN',{minimumFractionDigits:2}):''));
            });
            lines.push('');
        }
        var gt = parseFloat(po.grand_total||0);
        if (gt>0) lines.push('*Grand Total: ₹'+gt.toLocaleString('en-IN',{minimumFractionDigits:2})+'*','');
        lines.push('_Please confirm receipt and expected delivery date._');
        var msg=encodeURIComponent(lines.join('\n'));
        window.open(phone?'https://wa.me/'+phone+'?text='+msg:'https://wa.me/?text='+msg,'_blank');
    } catch(e){ toast('WhatsApp error: '+e.message,'error'); }
}

async function _supLedgerEmail(poId, poNum, supplierName) {
    try {
        toast('Generating PDF…','info',2000);
        var res  = await fetch('/api/procurement/po/pdf?id='+poId);
        if (!res.ok) throw new Error('PDF generation failed');
        var blob = await res.blob();
        var safe = (poNum||'PO').replace(/\//g,'_');
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href=url; a.download='PO_'+safe+'.pdf'; a.click();
        setTimeout(function(){URL.revokeObjectURL(url);},10000);
        var sup  = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase()===supplierName.toLowerCase(); }) || {};
        var email= sup.email||'';
        var subj = encodeURIComponent('Purchase Order '+poNum+' — HCP Wellness Pvt Ltd');
        var body = encodeURIComponent('Dear '+(sup.contact_person||supplierName)+',\n\nPlease find attached the Purchase Order '+poNum+'.\n\nKindly confirm receipt and expected delivery date.\n\nRegards,\nHCP Wellness Pvt Ltd');
        window.location.href='mailto:'+encodeURIComponent(email)+'?subject='+subj+'&body='+body;
        toast('PDF downloaded — attach PO_'+safe+'.pdf to the email that just opened','success',8000);
    } catch(e){ toast('Email error: '+e.message,'error'); }
}

async function _supLedgerGrnWhatsApp(grnId) {
    try {
        var res = await fetch('/api/procurement/grn/get?id='+grnId);
        var d   = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        var grn  = d.grn;
        var sup  = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase()===(grn.supplier_name||'').toLowerCase(); }) || {};
        var phone= (sup.phone||'').replace(/[^0-9+]/g,'');
        var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var fd=function(d){if(!d)return'—';var p=String(d).split('-');return p.length===3?p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]:d;};
        var lines=['*Goods Receipt Note — HCP Wellness Pvt Ltd*',''];
        lines.push('GRN No: *'+(grn.grn_num||'—')+'*');
        lines.push('Date: '+fd(grn.grn_date));
        lines.push('Supplier: '+(grn.supplier_name||'—'));
        lines.push('');
        if ((grn.items||[]).length) {
            lines.push('*Items Received:*');
            grn.items.forEach(function(it,i){
                var rqty=parseFloat(it.received_qty||0), rate=parseFloat(it.rate||0), amt=rqty*rate;
                lines.push((i+1)+'. '+it.material
                    +'  —  Recd: '+rqty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg'
                    +'  |  Rate: ₹'+rate.toLocaleString('en-IN',{minimumFractionDigits:2})
                    +(amt>0?'  |  Amt: ₹'+amt.toLocaleString('en-IN',{minimumFractionDigits:2}):''));
            });
            lines.push('');
        }
        var gt=parseFloat(grn.grand_total||0);
        if (gt>0) lines.push('*Grand Total: ₹'+gt.toLocaleString('en-IN',{minimumFractionDigits:2})+'*','');
        lines.push('_Goods Receipt Note from HCP Wellness Pvt Ltd._');
        var msg=encodeURIComponent(lines.join('\n'));
        window.open(phone?'https://wa.me/'+phone+'?text='+msg:'https://wa.me/?text='+msg,'_blank');
    } catch(e){ toast('WhatsApp error: '+e.message,'error'); }
}

async function _supLedgerGrnEmail(grnId, grnNum, supplierName) {
    try {
        toast('Generating GRN PDF…','info',2000);
        var res  = await fetch('/api/procurement/grn/pdf?id='+grnId);
        if (!res.ok) throw new Error('PDF generation failed');
        var blob = await res.blob();
        var safe = (grnNum||'GRN').replace(/\//g,'_');
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a'); a.href=url; a.download='GRN_'+safe+'.pdf'; a.click();
        setTimeout(function(){URL.revokeObjectURL(url);},10000);
        var sup  = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase()===supplierName.toLowerCase(); }) || {};
        var email= sup.email||'';
        var subj = encodeURIComponent('Goods Receipt Note '+grnNum+' — HCP Wellness Pvt Ltd');
        var body = encodeURIComponent('Dear '+(sup.contact_person||supplierName)+',\n\nPlease find attached the Goods Receipt Note '+grnNum+'.\n\nRegards,\nHCP Wellness Pvt Ltd');
        window.location.href='mailto:'+encodeURIComponent(email)+'?subject='+subj+'&body='+body;
        toast('PDF downloaded — attach GRN_'+safe+'.pdf to the email that just opened','success',8000);
    } catch(e){ toast('Email error: '+e.message,'error'); }
}

/* ════════════════════════════════════════════════════════════════
   WHOLE-LEDGER SHARE — WhatsApp & Email PDF
════════════════════════════════════════════════════════════════ */
function supLedgerWhatsAppAll() {
    var d = window._supLedgerData;
    if (!d) { toast('No ledger loaded','warning'); return; }
    var supplierName = d.supplierName;
    var pos  = d.pos  || [];
    var grns = d.grns || [];
    var sup  = (_supRows||[]).find(function(s){ return s.supplier_name===supplierName; }) || {};
    var phone = (sup.phone||'').replace(/[^0-9+]/g,'');
    var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var fd=function(d){if(!d)return'—';var p=String(d).split('-');return p.length===3?p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]:d;};
    var fi=function(n){return '₹'+parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});};

    var lines=['*Supplier PO & GRN Ledger — HCP Wellness Pvt Ltd*',''];
    lines.push('Supplier: *'+supplierName+'*');
    lines.push('Generated: '+fd(new Date().toISOString().slice(0,10)));
    lines.push('');

    // Summary
    var totalPOVal  = pos.reduce(function(s,p){return s+parseFloat(p.grand_total||0);},0);
    var openPOs     = pos.filter(function(p){return p.status==='open'||p.status==='partial'||p.status==='approved';});
    var closedPOs   = pos.filter(function(p){return p.status==='closed';});
    var totalGRNVal = grns.reduce(function(s,g){return s+parseFloat(g.grand_total||0);},0);
    var pendingVal  = openPOs.reduce(function(s,p){return s+parseFloat(p.grand_total||0);},0);

    lines.push('📊 *Summary*');
    lines.push('Total POs: '+pos.length+' | Total Value: '+fi(totalPOVal));
    lines.push('Open/Partial: '+openPOs.length+' ('+fi(pendingVal)+' pending)');
    lines.push('Closed: '+closedPOs.length+' | GRNs: '+grns.length);
    lines.push('Net Payable (GRN value): *'+fi(totalGRNVal)+'*');
    lines.push('');

    // POs
    if (pos.length) {
        lines.push('📄 *Purchase Orders*');
        pos.forEach(function(po,i){
            var items = po.items||[];
            lines.push((i+1)+'. *'+po.po_num+'* — '+po.status.toUpperCase()+' — '+fd(po.po_date)+' — *'+fi(po.grand_total)+'*');
            items.forEach(function(it){
                var qty=parseFloat(it.qty||0), rate=parseFloat(it.rate||0);
                lines.push('   • '+it.material+': '+qty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg @ ₹'+rate.toLocaleString('en-IN',{minimumFractionDigits:2}));
            });
        });
        lines.push('');
    }

    // GRNs
    if (grns.length) {
        lines.push('📦 *Goods Receipt Notes*');
        grns.forEach(function(grn,i){
            var items = grn.items||[];
            lines.push((i+1)+'. *'+grn.grn_num+'* — '+fd(grn.grn_date)+' — *'+fi(grn.grand_total)+'*');
            items.forEach(function(it){
                var rqty=parseFloat(it.received_qty||0), rate=parseFloat(it.rate||0);
                lines.push('   • '+it.material+': '+rqty.toLocaleString('en-IN',{minimumFractionDigits:3})+' kg @ ₹'+rate.toLocaleString('en-IN',{minimumFractionDigits:2}));
            });
        });
        lines.push('');
    }

    lines.push('_— HCP Wellness Pvt Ltd_');
    var msg=encodeURIComponent(lines.join('\n'));
    window.open(phone?'https://wa.me/'+phone+'?text='+msg:'https://wa.me/?text='+msg,'_blank');
}

async function supLedgerEmailAll() {
    var d = window._supLedgerData;
    if (!d) { toast('No ledger loaded','warning'); return; }
    var supplierName = d.supplierName;
    var pos  = d.pos  || [];
    var grns = d.grns || [];
    var sup  = (_supRows||[]).find(function(s){ return s.supplier_name===supplierName; }) || {};
    var email = sup.email||'';

    toast('Generating Ledger PDF…','info',2000);
    try {
        // Build list of PO and GRN ids
        var poIds  = pos.map(function(p){return p.id;}).filter(Boolean);
        var grnIds = grns.map(function(g){return g.id;}).filter(Boolean);

        var res = await fetch('/api/procurement/suppliers/ledger_pdf', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({supplier_name: supplierName, po_ids: poIds, grn_ids: grnIds})
        });
        if (!res.ok) throw new Error('PDF generation failed: '+res.statusText);
        var blob = await res.blob();
        var safe = supplierName.replace(/[^a-zA-Z0-9]/g,'_');
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a'); a.href=url; a.download='Ledger_'+safe+'.pdf'; a.click();
        setTimeout(function(){URL.revokeObjectURL(url);},10000);

        var subj = encodeURIComponent('Supplier Ledger — '+supplierName+' — HCP Wellness Pvt Ltd');
        var body = encodeURIComponent('Dear '+(sup.contact_person||supplierName)+',\n\nPlease find attached the complete PO & GRN Ledger for your account with HCP Wellness Pvt Ltd.\n\nRegards,\nHCP Wellness Pvt Ltd');
        window.location.href='mailto:'+encodeURIComponent(email)+'?subject='+subj+'&body='+body;
        toast('Ledger PDF downloaded — attach Ledger_'+safe+'.pdf to the email','success',8000);
    } catch(e) { toast('Error: '+e.message,'error'); }
}


/* ════════════════════════════════════════════════════════════════
   WHOLE SUPPLIER LIST SHARE  —  Admin only
   WhatsApp: formatted text to web.whatsapp.com
   Email: opens mailto with list in body + instructions to attach Excel
════════════════════════════════════════════════════════════════ */
async function shareAllSuppliersWhatsApp() {
    try {
        toast('Building supplier list…','info',1500);
        var res  = await fetch('/api/procurement/suppliers/list_for_share');
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        var sups = data.suppliers || [];
        var lines = ['*Supplier Directory — HCP Wellness Pvt Ltd*',''];
        lines.push('Total: *'+sups.length+' Suppliers*');
        lines.push('Generated: '+new Date().toLocaleDateString('en-IN'));
        lines.push('────────────────────────');
        sups.forEach(function(s,i){
            lines.push((i+1)+'. *'+s.supplier_name+'*  ['+s.supplier_code+']');
            if (s.contact_person) lines.push('   👤 '+s.contact_person);
            if (s.phone)          lines.push('   📞 '+s.phone);
            if (s.email)          lines.push('   ✉  '+s.email);
            if (s.gst_number)     lines.push('   GST: '+s.gst_number);
            var pay = s.payment_type ? s.payment_type+(s.credit_days?' ('+s.credit_days+'d)':'') : (s.payment_terms||'');
            if (pay)              lines.push('   💳 '+pay);
            if (s.mat_count)      lines.push('   📦 Materials: '+s.mat_count);
            lines.push('');
        });
        lines.push('_— HCP Wellness Pvt Ltd Procurement_');
        var msg = encodeURIComponent(lines.join('\n'));
        window.open('https://web.whatsapp.com/send?text='+msg,'_blank');
    } catch(e){ toast('Error: '+e.message,'error'); }
}

async function shareAllSuppliersEmail() {
    try {
        toast('Building supplier list…','info',1500);
        var res  = await fetch('/api/procurement/suppliers/list_for_share');
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        var sups = data.suppliers || [];
        // Export Excel for manual attachment
        exportSuppliersExcel();
        var bodyLines = [];
        bodyLines.push('Please find the complete Supplier Directory of HCP Wellness Pvt Ltd.');
        bodyLines.push('An Excel file has been downloaded — please attach it to this email.');
        bodyLines.push('');
        bodyLines.push('SUMMARY: '+sups.length+' suppliers as on '+new Date().toLocaleDateString('en-IN'));
        bodyLines.push('');
        sups.forEach(function(s,i){
            bodyLines.push((i+1)+'. '+s.supplier_name+' ['+s.supplier_code+']'
                +(s.phone?' | '+s.phone:'')
                +(s.email?' | '+s.email:''));
        });
        bodyLines.push('');
        bodyLines.push('Regards,');
        bodyLines.push('HCP Wellness Pvt Ltd');
        var subj = 'Supplier Directory — HCP Wellness Pvt Ltd';
        var body = bodyLines.join('\n');
        // Open Gmail compose (works in browser, no OS mail client needed)
        var gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1'
            + '&su=' + encodeURIComponent(subj)
            + '&body=' + encodeURIComponent(body);
        window.open(gmailUrl, '_blank');
        toast('Excel downloaded — attach it to the Gmail compose window','success',7000);
    } catch(e){ toast('Error: '+e.message,'error'); }
}

async function migrateSupplierCodesToHCPRMS() {
    if (!confirm('This will renumber ALL supplier codes to HCPRMS-0001, HCPRMS-0002… format.\n\nOld codes (e.g. SUP-0001) will be replaced.\nThis cannot be undone.\n\nContinue?')) return;
    try {
        var res  = await fetch('/api/procurement/suppliers/migrate_codes',{method:'POST'});
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Migrated '+data.updated+' of '+data.total+' suppliers to HCPRMS format','success',5000);
        loadSupData();
    } catch(e){ toast('Migration failed: '+e.message,'error'); }
}


/* ════════════════════════════════════════════════════════════════
   SUPPLIER MATERIALS MODAL
════════════════════════════════════════════════════════════════ */
var _supMatData     = [];
var _supMatSupInfo  = {};
var _supMatSupName  = '';

async function openSupMatModal(supplierName, filteredIdx) {
    _supMatSupName = supplierName;
    _supMatData    = [];
    _supMatSupInfo = {};
    if (filteredIdx !== undefined && _supFiltered[filteredIdx]) {
        var s = _supFiltered[filteredIdx];
        _supMatSupInfo = { supplier_name:s.supplier_name, phone:s.phone||'', email:s.email||'', contact_person:s.contact_person||'' };
    }
    document.getElementById('supMatModalTitle').textContent = supplierName;
    document.getElementById('supMatModalSub').textContent   = 'Loading materials…';
    document.getElementById('supMatTbody').innerHTML =
        '<tr><td colspan="6"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    document.getElementById('supMatCount').textContent = '–';
    document.getElementById('supMatSearch').value = '';
    _supMatUpdateContactBar();
    document.getElementById('supMatWaBtn').style.display    = 'inline-flex';
    document.getElementById('supMatEmailBtn').style.display = _supMatSupInfo.email ? 'inline-flex' : 'none';
    document.getElementById('supMatModal').classList.add('open');
    try {
        var res  = await fetch('/api/procurement/suppliers/materials?name='+encodeURIComponent(supplierName));
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        _supMatData    = data.materials || [];
        _supMatSupInfo = data.supplier  || _supMatSupInfo;
        document.getElementById('supMatModalSub').textContent =
            supplierName+' · '+_supMatData.length+' material'+ (_supMatData.length!==1?'s':'')+' linked';
        _supMatUpdateContactBar();
        document.getElementById('supMatEmailBtn').style.display = _supMatSupInfo.email ? 'inline-flex' : 'none';
        supMatRender();
    } catch(e) {
        document.getElementById('supMatTbody').innerHTML =
            '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--red-text)">'+escHtml(e.message)+'</td></tr>';
        toast('Failed to load materials: '+e.message,'error');
    }
}
function closeSupMatModal(){ document.getElementById('supMatModal').classList.remove('open'); }
function _supMatUpdateContactBar(){
    var bar = document.getElementById('supMatContactBar');
    var s   = _supMatSupInfo;
    var hasInfo = s.phone||s.email||s.contact_person;
    bar.style.display = hasInfo ? 'flex' : 'none';
    document.getElementById('supMatContactName').textContent  = s.contact_person ? '👤 '+s.contact_person : '';
    document.getElementById('supMatContactPhone').textContent = s.phone          ? '📞 '+s.phone          : '';
    document.getElementById('supMatContactEmail').textContent = s.email          ? '✉ ' +s.email          : '';
}
function supMatRender(){
    var q    = (document.getElementById('supMatSearch').value||'').trim().toLowerCase();
    var rows = q ? _supMatData.filter(function(r){ return (r.material_name||'').toLowerCase().includes(q); }) : _supMatData;
    document.getElementById('supMatCount').textContent = rows.length+' material'+(rows.length!==1?'s':'')+(q?' (filtered)':'');
    if (!rows.length){
        document.getElementById('supMatTbody').innerHTML =
            '<tr><td colspan="6"><div class="state-box"><div class="state-icon">📦</div>'+
            '<h3>'+(q?'No matches':'No materials linked')+'</h3>'+
            '<p>'+(q?'Try a different search term.':'No materials are linked to this supplier yet.')+'</p>'+
            '</div></td></tr>';
        return;
    }
    document.getElementById('supMatTbody').innerHTML = rows.map(function(r,i){
        var rate = r.last_purchase_rate!=null ? '₹ '+fmtNum(r.last_purchase_rate,4) : '<span class="td-dim">—</span>';
        var msl  = r.msl!=null ? fmtNum(r.msl,3) : '<span class="td-dim">—</span>';
        return '<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background=\'var(--text-05)\'" onmouseout="this.style.background=\'\'">'
            +'<td style="padding:8px 12px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">'+(i+1)+'</td>'
            +'<td style="padding:8px 12px;font-weight:600;border-right:1px solid var(--border)">'+escHtml(r.material_name)
            +(r.description?'<br><span style="font-size:10px;font-style:italic;color:var(--muted);font-weight:400">'+escHtml(r.description)+'</span>':'')+'</td>'
            +'<td style="padding:8px 12px;font-family:var(--font-mono);font-weight:700;color:var(--green-text);text-align:right;border-right:1px solid var(--border)">'+rate+'</td>'
            +'<td style="padding:8px 12px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border)">'+msl+'</td>'
            +'<td style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;text-align:center;border-right:1px solid var(--border)">'+escHtml(r.hsn_code||'—')+'</td>'
            +'<td style="padding:8px 12px;text-align:center;font-size:11px">'+(r.gst_rate!=null?r.gst_rate+'%':'<span class="td-dim">—</span>')+'</td>'
            +'</tr>';
    }).join('');
}
function _supMatBuildMessage(){
    var q    = (document.getElementById('supMatSearch').value||'').trim().toLowerCase();
    var rows = q ? _supMatData.filter(function(r){ return (r.material_name||'').toLowerCase().includes(q); }) : _supMatData;
    var lines=['*Material List — HCP Wellness Pvt Ltd*',''];
    lines.push('Supplier: *'+_supMatSupName+'*');
    lines.push('Total: '+rows.length+' material'+(rows.length!==1?'s':''));
    lines.push('Date: '+new Date().toLocaleDateString('en-IN'));
    lines.push('────────────────────────');
    rows.forEach(function(r,i){
        var rate = r.last_purchase_rate!=null ? '₹'+parseFloat(r.last_purchase_rate).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:4})+'/kg' : 'Rate N/A';
        lines.push((i+1)+'. *'+r.material_name+'*');
        lines.push('   '+rate+(r.msl?'  |  MSL: '+parseFloat(r.msl).toLocaleString('en-IN',{maximumFractionDigits:3})+' kg':''));
    });
    lines.push('────────────────────────');
    lines.push('_Procurement · HCP Wellness Pvt Ltd_');
    return lines.join('\n');
}
function supMatSendWhatsApp(){
    var phone = (_supMatSupInfo.phone||'').replace(/[^0-9+]/g,'');
    if (phone && phone.length===10 && !phone.startsWith('+')) phone='91'+phone;
    var msg = encodeURIComponent(_supMatBuildMessage());
    window.open(phone?'https://web.whatsapp.com/send?phone='+phone+'&text='+msg:'https://web.whatsapp.com/send?text='+msg,'_blank');
}
function supMatSendEmail(){
    var s     = _supMatSupInfo;
    var q     = (document.getElementById('supMatSearch').value||'').trim().toLowerCase();
    var rows  = q ? _supMatData.filter(function(r){ return (r.material_name||'').toLowerCase().includes(q); }) : _supMatData;
    var bodyLines=['Dear '+(s.contact_person||_supMatSupName)+',','','Please find below the list of '+rows.length+' material(s) we procure from you:',''];
    rows.forEach(function(r,i){
        var rate = r.last_purchase_rate!=null ? ' — ₹'+parseFloat(r.last_purchase_rate).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:4})+'/kg':'';
        bodyLines.push((i+1)+'. '+r.material_name+rate);
    });
    bodyLines.push('','Regards,','HCP Wellness Pvt Ltd');
    var subj = encodeURIComponent('Material List — '+_supMatSupName+' — HCP Wellness Pvt Ltd');
    window.location.href='mailto:'+encodeURIComponent(s.email||'')+'?subject='+subj+'&body='+encodeURIComponent(bodyLines.join('\n'));
}

/* ════════════════════════════════════════════════════════════════
   SUPPLIER TYPE MANAGER
════════════════════════════════════════════════════════════════ */
var _supTypeEditId = null;

function openSupTypeManager() {
    _supTypeEditId = null;
    document.getElementById('supTypeManagerModal').classList.add('open');
    setTimeout(function(){ var e=document.getElementById('supTypeNewName'); if(e){e.value='';e.focus();} }, 80);
    // Always fetch fresh — may be called from sidebar before Suppliers tab was loaded
    fetch('/api/supplier_types')
        .then(function(r){ return r.json(); })
        .then(function(data) {
            _supTypes = data.types || [];
            _supPopulateTypeDropdowns();
            renderSupTypeList();
        })
        .catch(function(err){ toast('Failed to load types: ' + err.message, 'error'); });
}

function closeSupTypeManager() {
    document.getElementById('supTypeManagerModal').classList.remove('open');
    // Refresh type dropdowns in case types changed
    loadSupTypes();
}

function renderSupTypeList() {
    var el = document.getElementById('supTypeList');
    if (!el) return;
    if (!_supTypes.length) {
        el.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12px;padding:20px 0">No types added yet.</div>';
        return;
    }
    el.innerHTML = _supTypes.map(function(t) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface2);border:1px solid var(--border2);border-radius:7px">' +
            '<span style="flex:1;font-size:13px;font-weight:600">' + escHtml(t.type_name) + '</span>' +
            '<button class="act-btn" style="padding:3px 10px;font-size:11px" onclick="editSupType(' + t.id + ',\'' + escHtml(t.type_name).replace(/'/g,"\\'") + '\')" title="Rename">✎ Edit</button>' +
            '<button class="act-btn" style="padding:3px 10px;font-size:11px;color:var(--red-text);border-color:rgba(244,63,94,.3)" onclick="deleteSupType(' + t.id + ',\'' + escHtml(t.type_name).replace(/'/g,"\\'") + '\')" title="Delete">✕</button>' +
            '</div>';
    }).join('');
}

function editSupType(id, name) {
    _supTypeEditId = id;
    var inp = document.getElementById('supTypeNewName');
    if (inp) { inp.value = name; inp.focus(); }
}

function saveSupType() {
    var inp = document.getElementById('supTypeNewName');
    var name = (inp ? inp.value : '').trim();
    if (!name) { toast('Type name cannot be empty', 'error'); return; }
    var payload = { type_name: name };
    if (_supTypeEditId) payload.id = _supTypeEditId;
    fetch('/api/supplier_types/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') throw new Error(data.message);
        toast(_supTypeEditId ? 'Type updated' : 'Type added', 'success');
        _supTypeEditId = null;
        if (inp) inp.value = '';
        // Refresh types list
        fetch('/api/supplier_types')
            .then(function(r){ return r.json(); })
            .then(function(d) {
                _supTypes = d.types || [];
                _supPopulateTypeDropdowns();
                renderSupTypeList();
            });
    })
    .catch(function(err){ toast('Save failed: ' + err.message, 'error'); });
}

function deleteSupType(id, name) {
    if (!confirm('Delete type "' + name + '"?\n\nSuppliers assigned this type will have their type cleared.')) return;
    fetch('/api/supplier_types/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: id})
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Type deleted', 'success');
        _supTypes = _supTypes.filter(function(t){ return t.id !== id; });
        _supPopulateTypeDropdowns();
        renderSupTypeList();
    })
    .catch(function(err){ toast('Delete failed: ' + err.message, 'error'); });
}

/* ════════════════════════════════════════════════════════════════
   TOOLBAR DROPDOWN HELPERS
════════════════════════════════════════════════════════════════ */
var _supDdOpen = null;

function supToggleDd(name) {
    var panels = { filter:'supFilterPanel', excel:'supExcelPanel', share:'supSharePanel', assign:'supAssignPanel' };
    var target = panels[name];
    var isOpen = document.getElementById(target) && document.getElementById(target).classList.contains('open');
    // Close all first
    Object.values(panels).forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.classList.remove('open');
    });
    // Toggle the clicked one
    if (!isOpen) {
        var el = document.getElementById(target);
        if (el) el.classList.add('open');
        _supDdOpen = name;
    } else {
        _supDdOpen = null;
    }
}
// Single persistent global click handler — closes all sup dropdowns when clicking outside
document.addEventListener('click', function(e) {
    if (!_supDdOpen) return;
    var wraps = document.querySelectorAll('.sup-dd-wrap');
    var inside = false;
    wraps.forEach(function(w){ if (w.contains(e.target)) inside = true; });
    if (!inside) {
        supCloseDds();
        _supDdOpen = null;
    }
});
function supCloseDds() {
    ['supFilterPanel','supExcelPanel','supSharePanel','supAssignPanel'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.classList.remove('open');
    });
    _supDdOpen = null;
}
function supUpdateFilterDot() {
    var active =
        (document.getElementById('supFAll') && !document.getElementById('supFAll').classList.contains('active')) ||
        (document.getElementById('supTypeFilter') && document.getElementById('supTypeFilter').value !== '') ||
        (document.getElementById('supPayTypeFilter') && document.getElementById('supPayTypeFilter').value !== '');
    var dot = document.getElementById('supFilterDot');
    if (dot) dot.style.display = active ? 'block' : 'none';
}
function supClearFilters() {
    supSetFilter('all');
    var t = document.getElementById('supTypeFilter');    if(t) t.value = '';
    var p = document.getElementById('supPayTypeFilter'); if(p) p.value = '';
    supApplyFilters();
    supUpdateFilterDot();
}

/* ════════════════════════════════════════════════════════════════
   BULK ASSIGN SUPPLIER TYPE
════════════════════════════════════════════════════════════════ */
var _bulkTypeChecked = {};   // { supplier_id: true/false }

function openBulkAssignType() {
    _bulkTypeChecked = {};
    // Populate type dropdown
    var sel = document.getElementById('bulkTypeSelect');
    if (sel) {
        sel.innerHTML = '<option value="">&#8212; Select Type &#8212;</option>' +
            _supTypes.map(function(t){
                return '<option value="' + t.id + '">' + escHtml(t.type_name) + '</option>';
            }).join('');
    }
    // Build checklist from current filtered rows (or all rows)
    var list = document.getElementById('bulkTypeList');
    var rows = _supFiltered.length ? _supFiltered : _supRows;
    if (list) {
        list.innerHTML = rows.map(function(r) {
            return '<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px" ' +
                'onmouseover="this.style.background=\'var(--surface3)\'" onmouseout="this.style.background=\'\'">' +
                '<input type="checkbox" data-sid="' + r.id + '" onchange="bulkTypeCheck(this)" ' +
                'style="width:14px;height:14px;accent-color:var(--teal);cursor:pointer"> ' +
                '<span style="font-family:var(--font-mono);font-size:10px;color:var(--teal);min-width:90px">' + escHtml(r.supplier_code||'—') + '</span>' +
                '<span style="font-weight:600;flex:1">' + escHtml(r.supplier_name) + '</span>' +
                '<span style="font-size:10px;color:var(--muted);min-width:80px;text-align:right">' +
                    (r.supplier_type_name ? escHtml(r.supplier_type_name) : '<em>No type</em>') +
                '</span>' +
                '</label>';
        }).join('');
    }
    bulkTypeUpdateCount();
    document.getElementById('supBulkTypeModal').classList.add('open');
}

function closeBulkAssignType() {
    document.getElementById('supBulkTypeModal').classList.remove('open');
}

function bulkTypeCheck(cb) {
    var sid = cb.dataset.sid;
    _bulkTypeChecked[sid] = cb.checked;
    bulkTypeUpdateCount();
}

function bulkTypeUpdateCount() {
    var n = Object.values(_bulkTypeChecked).filter(Boolean).length;
    var el = document.getElementById('bulkTypeSelCount');
    if (el) el.textContent = n ? '(' + n + ' selected)' : '';
}

function bulkTypeSelectAll() {
    document.querySelectorAll('#bulkTypeList input[type=checkbox]').forEach(function(cb){
        cb.checked = true;
        _bulkTypeChecked[cb.dataset.sid] = true;
    });
    bulkTypeUpdateCount();
}

function bulkTypeDeselectAll() {
    document.querySelectorAll('#bulkTypeList input[type=checkbox]').forEach(function(cb){
        cb.checked = false;
        _bulkTypeChecked[cb.dataset.sid] = false;
    });
    bulkTypeUpdateCount();
}

function saveBulkAssignType() {
    var typeId = document.getElementById('bulkTypeSelect').value;
    if (!typeId) { toast('Please select a supplier type first', 'error'); return; }
    var ids = Object.keys(_bulkTypeChecked).filter(function(k){ return _bulkTypeChecked[k]; });
    if (!ids.length) { toast('Please select at least one supplier', 'error'); return; }
    fetch('/api/procurement/suppliers/bulk_assign_type', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ supplier_ids: ids, supplier_type_id: typeId })
    })
    .then(function(r){ return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') throw new Error(data.message);
        var typeName = (document.getElementById('bulkTypeSelect').selectedOptions[0]||{}).text || '';
        toast(data.updated + ' supplier(s) assigned to "' + typeName + '"', 'success');
        closeBulkAssignType();
        loadSupData();
    })
    .catch(function(err){ toast('Failed: ' + err.message, 'error'); });
}
