/* godowns_tc_decl.js — Supplier export, Godowns, Terms & Conditions, Declarations
   Depends on: utils.js */

/* ════════════════════════════════════════════════════════════════
   SUPPLIER EXCEL EXPORT
════════════════════════════════════════════════════════════════ */
var SUP_COLS = [
    {key:'supplier_code',   label:'Supplier Code'},
    {key:'supplier_name',   label:'Supplier Name *'},
    {key:'contact_person',  label:'Contact Person'},
    {key:'phone',           label:'Phone'},
    {key:'email',           label:'Email'},
    {key:'address',         label:'Address'},
    {key:'gst_number',      label:'GST Number'},
    {key:'pan_number',      label:'PAN Number'},
    {key:'payment_terms',   label:'Payment Terms'},
    {key:'currency',        label:'Currency'},
    {key:'lead_time_days',  label:'Lead Time (Days)'},
    {key:'moq',             label:'MOQ (kg)'},
    {key:'rating',          label:'Rating (1-5)'},
    {key:'status',          label:'Status'},
];

function exportSuppliersExcel() {
    var data = _supRows.length ? _supRows : [];
    if (!data.length) { toast('No supplier data to export', 'info'); return; }
    var header = SUP_COLS.map(function(c){ return c.label; });
    var rows = data.map(function(r) {
        return SUP_COLS.map(function(c){ return r[c.key] != null ? r[c.key] : ''; });
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet([header].concat(rows));
    // Column widths
    ws['!cols'] = SUP_COLS.map(function(c){
        return {wch: Math.max(c.label.length, 18)};
    });
    // Style header row (bold via cell metadata not supported in SheetJS free,
    // but we can set a wider width for name column)
    ws['!cols'][1] = {wch:36};
    ws['!cols'][5] = {wch:40};
    XLSX.utils.book_append_sheet(wb, ws, 'Suppliers');
    var date = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, 'HCP_Suppliers_' + date + '.xlsx');
    toast('Exported ' + data.length + ' suppliers', 'success');
}

function downloadSupplierTemplate() {
    var header = SUP_COLS.map(function(c){ return c.label; });
    var sample = [
        'SUP-0001','J B Fragrances And Flavours','Rajesh Shah','+91 98765 43210',
        'rajesh@jbff.com','Mumbai, Maharashtra','27AABCJ1234F1ZX','AABCJ1234F',
        '30 days credit','INR','7','25','4','active'
    ];
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet([header, sample]);
    ws['!cols'] = SUP_COLS.map(function(c){ return {wch: Math.max(c.label.length, 18)}; });
    ws['!cols'][1] = {wch:36};
    XLSX.utils.book_append_sheet(wb, ws, 'Suppliers');
    XLSX.writeFile(wb, 'HCP_Supplier_Import_Template.xlsx');
    toast('Template downloaded', 'success');
}

/* ════════════════════════════════════════════════════════════════
   SUPPLIER EXCEL IMPORT
════════════════════════════════════════════════════════════════ */
var _supImportRows = [];

function importSuppliersExcel(input) {
    var file = input.files[0];
    if (!file) return;
    input.value = ''; // reset so same file can be re-selected
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var wb = XLSX.read(e.target.result, {type:'array'});
            var ws = wb.Sheets[wb.SheetNames[0]];
            var raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
            if (!raw.length) { toast('File is empty', 'error'); return; }

            // Find header row — look for row containing 'Supplier Name'
            var headerIdx = 0;
            for (var i = 0; i < Math.min(raw.length, 5); i++) {
                var rowStr = raw[i].join(' ').toLowerCase();
                if (rowStr.includes('supplier name') || rowStr.includes('supplier_name')) {
                    headerIdx = i; break;
                }
            }
            var headers = raw[headerIdx].map(function(h){ return (h||'').toString().trim(); });
            var dataRows = raw.slice(headerIdx + 1).filter(function(r){
                return r.some(function(c){ return c !== ''; });
            });

            // Map columns to SUP_COLS keys
            var colMap = {};
            SUP_COLS.forEach(function(col) {
                var label = col.label.replace(' *','').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
                for (var j = 0; j < headers.length; j++) {
                    var h = headers[j].toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
                    if (h === label || h === col.key.toLowerCase().replace(/_/g,' ')) {
                        colMap[col.key] = j; break;
                    }
                }
            });

            // Parse rows
            _supImportRows = dataRows.map(function(row) {
                var obj = {};
                SUP_COLS.forEach(function(col) {
                    var idx = colMap[col.key];
                    obj[col.key] = idx !== undefined ? (row[idx] != null ? row[idx].toString().trim() : '') : '';
                });
                return obj;
            }).filter(function(r){ return r.supplier_name; }); // must have name

            if (!_supImportRows.length) { toast('No valid rows found — check column headers', 'error'); return; }

            // Show preview modal
            showSupImportPreview(file.name, _supImportRows);
        } catch(err) {
            toast('Failed to read file: ' + err.message, 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

function showSupImportPreview(filename, rows) {
    var previewCols = ['supplier_name','contact_person','phone','email','gst_number','payment_terms','status'];
    var colLabels = {'supplier_name':'Supplier Name','contact_person':'Contact','phone':'Phone',
                     'email':'Email','gst_number':'GST','payment_terms':'Payment Terms','status':'Status'};

    document.getElementById('supImportFileName').textContent = filename;
    document.getElementById('supImportRowCount').textContent = rows.length + ' rows found';
    document.getElementById('supImportFileStrip').style.display = 'flex';
    document.getElementById('supImportSub').textContent = 'Preview — ' + rows.length + ' suppliers to import';
    document.getElementById('supImportStats').textContent = rows.length + ' records ready';
    document.getElementById('supImportLog').style.display = 'none';
    var _uz = document.getElementById('supImportUploadZone'); if (_uz) _uz.style.display = 'none';

    // Header
    document.getElementById('supImportThead').innerHTML =
        '<tr style="border-bottom:2px solid var(--border2)">' +
        previewCols.map(function(k){
            return '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--muted);text-transform:uppercase;white-space:nowrap">' + (colLabels[k]||k) + '</th>';
        }).join('') + '</tr>';

    // Rows (show max 50 in preview)
    var preview = rows.slice(0, 50);
    document.getElementById('supImportTbody').innerHTML = preview.map(function(r, i) {
        return '<tr style="border-bottom:1px solid var(--border);' + (i%2===0?'background:var(--surface2)':'') + '">' +
            previewCols.map(function(k){
                var v = r[k] || '—';
                var style = 'padding:7px 12px;font-size:11.5px;color:var(--text);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis';
                if (k === 'supplier_name') style += ';font-weight:600';
                if (k === 'status') {
                    var pill = v === 'inactive'
                        ? '<span class="po-status draft">' + v.toUpperCase() + '</span>'
                        : '<span class="po-status received">ACTIVE</span>';
                    return '<td style="' + style + '">' + pill + '</td>';
                }
                return '<td style="' + style + '">' + escHtml(v) + '</td>';
            }).join('') + '</tr>';
    }).join('');

    if (rows.length > 50) {
        document.getElementById('supImportTbody').innerHTML +=
            '<tr><td colspan="' + previewCols.length + '" style="padding:10px 12px;text-align:center;font-size:11px;color:var(--muted)">' +
            '… and ' + (rows.length - 50) + ' more rows (all will be imported)</td></tr>';
    }

    // Enable confirm button
    var btn = document.getElementById('supImportConfirmBtn');
    btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer';

    document.getElementById('supImportModal').classList.add('open');
}

function closeSupImportModal() {
    document.getElementById('supImportModal').classList.remove('open');
    _supImportRows = [];
    // Reset modal back to its initial upload state
    var _uz = document.getElementById('supImportUploadZone'); if (_uz) _uz.style.display = 'flex';
    var _fs = document.getElementById('supImportFileStrip'); if (_fs) _fs.style.display = 'none';
    var _th = document.getElementById('supImportThead'); if (_th) _th.innerHTML = '';
    var _tb = document.getElementById('supImportTbody'); if (_tb) _tb.innerHTML = '';
    var _lg = document.getElementById('supImportLog'); if (_lg) { _lg.style.display = 'none'; _lg.innerHTML = ''; }
    var _st = document.getElementById('supImportStats'); if (_st) _st.textContent = '';
    var _sb = document.getElementById('supImportSub'); if (_sb) _sb.textContent = 'Select a file to begin';
    var _bt = document.getElementById('supImportConfirmBtn');
    if (_bt) { _bt.disabled = true; _bt.style.opacity = '.5'; _bt.style.cursor = 'not-allowed'; _bt.textContent = '\u2713 Import'; }
}

function confirmSupImport() {
    if (!_supImportRows.length) return;
    var btn = document.getElementById('supImportConfirmBtn');
    btn.disabled = true; btn.textContent = 'Importing…';

    var log = document.getElementById('supImportLog');
    log.style.display = 'block'; log.innerHTML = '';

    var saved = 0, failed = 0, total = _supImportRows.length;
    var logLines = [];

    // Send all rows via sequential saves
    function saveNext(idx) {
        if (idx >= _supImportRows.length) {
            // Done
            var summary = '✅ Import complete: ' + saved + ' saved, ' + failed + ' failed out of ' + total;
            logLines.push(summary);
            log.innerHTML = logLines.map(function(l){ return '<div>' + l + '</div>'; }).join('');
            log.scrollTop = log.scrollHeight;
            document.getElementById('supImportStats').textContent = saved + ' saved · ' + failed + ' failed';
            btn.textContent = '✓ Done';
            toast(saved + ' suppliers imported', saved > 0 ? 'success' : 'error');
            if (saved > 0) loadSupData();
            return;
        }
        var row = _supImportRows[idx];
        fetch('/api/procurement/suppliers/save', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                supplier_name:  row.supplier_name,
                supplier_code:  row.supplier_code || null,
                contact_person: row.contact_person || null,
                phone:          row.phone || null,
                email:          row.email || null,
                address:        row.address || null,
                gst_number:     row.gst_number || null,
                pan_number:     row.pan_number || null,
                payment_terms:  row.payment_terms || null,
                currency:       row.currency || 'INR',
                lead_time_days: row.lead_time_days || null,
                moq:            row.moq || null,
                rating:         row.rating || null,
                status:         row.status || 'active',
            })
        })
        .then(function(r){ return r.json(); })
        .then(function(d) {
            if (d.status === 'ok') {
                saved++;
                logLines.push('✓ [' + (idx+1) + '/' + total + '] ' + row.supplier_name + (d.action === 'created' ? ' — added (' + d.supplier_code + ')' : ' — updated'));
            } else {
                failed++;
                logLines.push('✗ [' + (idx+1) + '/' + total + '] ' + row.supplier_name + ' — ' + (d.message||'error'));
            }
            log.innerHTML = logLines.map(function(l){ return '<div>' + l + '</div>'; }).join('');
            log.scrollTop = log.scrollHeight;
            document.getElementById('supImportStats').textContent = (saved+failed) + ' / ' + total + ' processed';
            saveNext(idx + 1);
        })
        .catch(function(err) {
            failed++;
            logLines.push('✗ [' + (idx+1) + '/' + total + '] ' + row.supplier_name + ' — ' + err.message);
            log.innerHTML = logLines.map(function(l){ return '<div>' + l + '</div>'; }).join('');
            saveNext(idx + 1);
        });
    }
    saveNext(0);
}

/* ════ Extend switchTab for new tabs ════ */
(function() {
    var _base = window.switchTab;
    window.switchTab = function(id) {
        _base(id);
        if (id === 'po')  {
            if (!window._poSkipAutoLoad) loadPoData();
            // Ensure material master (_allRows) is loaded so PO rate lookup works
            if (!_allRows || !_allRows.length) loadData();
        }
        if (id === 'sup' && !_supRows.length) loadSupData();
        if (id === 'grn' && typeof loadGrnData === 'function') loadGrnData();
    };
})();

/* ════ Alt+3 / Alt+4 shortcuts ════ */
document.addEventListener('keydown', function(e) {
    if (e.altKey) {
        if (e.key === '3') { e.preventDefault(); switchTab('po');  }
        if (e.key === '4') { e.preventDefault(); switchTab('sup'); }
    }
});


/* ════════════════════════════════════════════════════════════════
   SIDEBAR — auto-hide + active state
════════════════════════════════════════════════════════════════ */
var _sidebarTimer = null;
var _sidebarOpen  = true;

function toggleSidebar() {
    _sidebarOpen = !_sidebarOpen;
    _applySidebar();
    clearTimeout(_sidebarTimer);
}

function _applySidebar() {
    var sb = document.getElementById('appSidebar');
    if (!sb) return;
    if (_sidebarOpen) {
        sb.classList.remove('collapsed');
    } else {
        sb.classList.add('collapsed');
    }
}

function setSidebarActive(tabId) {
    document.querySelectorAll('.sidebar-item[id^="sb-"]').forEach(function(el) {
        el.classList.remove('active');
    });
    var el = document.getElementById('sb-' + tabId);
    if (el) el.classList.add('active');
    // Auto-hide after 5s
    clearTimeout(_sidebarTimer);
    _sidebarTimer = setTimeout(function() {
        if (_sidebarOpen) {
            _sidebarOpen = false;
            _applySidebar();
        }
    }, 5000);
}

function _sidebarResetTimer() {
    clearTimeout(_sidebarTimer);
    _sidebarTimer = setTimeout(function() {
        if (_sidebarOpen) {
            _sidebarOpen = false;
            _applySidebar();
        }
    }, 5000);
}

// Update sidebar badges from existing badge data
function updateSidebarBadges() {
    var tabBadge = document.getElementById('tabBadge');
    var fvqBadge = document.getElementById('fvqBadge');
    var poBadge  = document.getElementById('poBadge');
    var supBadge = document.getElementById('supBadge');
    if (tabBadge && document.getElementById('sbBadge-mqsd'))
        document.getElementById('sbBadge-mqsd').textContent = tabBadge.textContent || '–';
    if (fvqBadge && document.getElementById('sbBadge-fvq'))
        document.getElementById('sbBadge-fvq').textContent = fvqBadge.textContent || '–';
    if (poBadge && document.getElementById('sbBadge-po'))
        document.getElementById('sbBadge-po').textContent = poBadge.textContent || '–';
    if (supBadge && document.getElementById('sbBadge-sup'))
        document.getElementById('sbBadge-sup').textContent = supBadge.textContent || '–';
}

// Auto-hide sidebar after 5s on page load
setTimeout(function() {
    _sidebarOpen = false;
    _applySidebar();
}, 5000);

// Keyboard shortcuts — Alt+M, Alt+A, Alt+S (PO modal context-aware)
document.addEventListener('keydown', function(e) {
    if (!e.altKey) return;
    var poOpen = !!(document.getElementById('poModal') && document.getElementById('poModal').classList.contains('open'));
    var k = e.key.toUpperCase();
    if (k === 'M') {
        e.preventDefault();
        if (poOpen) poQuickNewMaterial(); else toggleSidebar();
    } else if (k === 'A' && poOpen) {
        e.preventDefault();
        poAddLine();
        setTimeout(function(){
            var inputs = document.querySelectorAll('#poLinesTbody .po-li-inp[data-field="material"]');
            if (inputs.length) inputs[inputs.length-1].focus();
        }, 80);
    } else if (k === 'S' && poOpen && !document.querySelector('.modal-overlay.open:not(#poModal)')) {
        e.preventDefault();
        poQuickNewSupplier();
    }
}, true);

// Keep badges in sync after data loads
var _origLoadData = typeof loadData !== 'undefined' ? loadData : null;
if (_origLoadData) {
    var _patchedLoadData = _origLoadData;
}
setInterval(updateSidebarBadges, 3000);


/* ════════════════════════════════════════════════════════════════
   PO NUMBER SETTINGS — stored in localStorage
════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════
   PO NUMBERING STYLES — multi-style with date ranges
   Each style: {id, prefix, suffix, from, to, digits, next, label}
/* ════════════════════════════════════════════════════════════════
   VOUCHER NUMBERING — unified multi-type system
   Supports: po, grn  (extensible to any future voucher type)
   Storage key: hcp_voucher_num_styles  (object keyed by type)
════════════════════════════════════════════════════════════════ */

var VOUCHER_TYPES = [
    { key: 'po',  label: 'Purchase Order', icon: '📄', defaultPrefix: 'HCP/RM/PO', defaultSuffix: '' },
    { key: 'grn', label: 'Goods Receipt Note', icon: '📦', defaultPrefix: 'GRN', defaultSuffix: '' }
];

// Master store: { po: [...styles], grn: [...styles] }
var _voucherNumStyles = (function(){
    try {
        var s = localStorage.getItem('hcp_voucher_num_styles');
        if (s) return JSON.parse(s);
    } catch(e){}
    // Migrate from old hcp_po_num_styles
    var yr = new Date().getFullYear();
    var defaultStyle = { id: 1, prefix:'HCP/RM/PO', suffix:'', digits:4, next:1,
                         from: yr+'-04-01', to: (yr+1)+'-03-31' };
    var migrated = {};
    try {
        var old = localStorage.getItem('hcp_po_num_styles');
        if (old) migrated.po = JSON.parse(old);
    } catch(e){}
    if (!migrated.po) migrated.po = [defaultStyle];
    if (!migrated.grn) migrated.grn = [{ id: 2, prefix:'GRN', suffix:'', digits:4, next:1,
                                          from: yr+'-04-01', to: (yr+1)+'-03-31' }];
    return migrated;
})();

var _vNumEditType = 'po';   // currently editing voucher type
var _vNumEditIdx  = -1;     // -1 = new, >=0 = editing index

function _vNumSave() {
    try { localStorage.setItem('hcp_voucher_num_styles', JSON.stringify(_voucherNumStyles)); } catch(e){}
}

function _vNumGetStyles(type) {
    if (!_voucherNumStyles[type]) _voucherNumStyles[type] = [];
    return _voucherNumStyles[type];
}

function _vNumGetActive(type) {
    var styles = _vNumGetStyles(type);
    var today  = new Date().toISOString().slice(0,10);
    return styles.find(function(s){
        return (!s.from || s.from <= today) && (!s.to || s.to >= today);
    }) || styles[styles.length-1] || { prefix: type.toUpperCase(), suffix:'', digits:4, next:1 };
}

function generateVoucherNumber(type) {
    var cfg  = _vNumGetActive(type);
    var num  = String(cfg.next).padStart(parseInt(cfg.digits)||4,'0');
    var parts = [];
    if (cfg.prefix) parts.push(cfg.prefix);
    parts.push(num);
    if (cfg.suffix) parts.push(cfg.suffix);
    return parts.join('/');
}

// Legacy alias — keeps generatePONumber() working in po_form.js / po.js
function generatePONumber() { return generateVoucherNumber('po'); }

/* ── Modal open/close ── */
function openVoucherNumSettings() {
    _vNumEditType = 'po';
    _vNumEditIdx  = -1;
    vNumRenderTabs();
    vNumRenderList();
    document.getElementById('voucherNumEditForm').style.display = 'none';
    document.getElementById('voucherNumSettingsModal').classList.add('open');
}
function closeVoucherNumSettings() {
    document.getElementById('voucherNumSettingsModal').classList.remove('open');
}
// Legacy alias for any remaining openPONumSettings() calls
function openPONumSettings() { openVoucherNumSettings(); }
function closePONumSettings() { closeVoucherNumSettings(); }

/* ── Tab render ── */
function vNumRenderTabs() {
    var tabBar = document.getElementById('vNumTabBar');
    if (!tabBar) return;
    tabBar.innerHTML = VOUCHER_TYPES.map(function(vt){
        var active = vt.key === _vNumEditType;
        return '<button onclick="vNumSwitchType(\''+vt.key+'\')" style="height:32px;padding:0 14px;border-radius:7px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-body);transition:all .15s;'
            + (active ? 'background:#1d4ed8;color:#fff;' : 'background:var(--surface2);color:var(--muted2);')
            + '">' + vt.icon + ' ' + vt.label + '</button>';
    }).join('');
}

function vNumSwitchType(type) {
    _vNumEditType = type;
    _vNumEditIdx  = -1;
    vNumRenderTabs();
    vNumRenderList();
    document.getElementById('voucherNumEditForm').style.display = 'none';
}

/* ── Style list render ── */
function vNumRenderList() {
    var container = document.getElementById('vNumStylesList');
    if (!container) return;
    var styles = _vNumGetStyles(_vNumEditType);
    var today  = new Date().toISOString().slice(0,10);
    if (!styles.length) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">No styles yet — click &ldquo;Add Style&rdquo;</div>';
        return;
    }
    container.innerHTML = styles.map(function(s, i){
        var isActive  = (!s.from || s.from <= today) && (!s.to || s.to >= today);
        var isFuture  = s.from && s.from > today;
        var sColor    = isActive ? '#166534' : isFuture ? '#1d4ed8' : '#64748b';
        var sBg       = isActive ? '#dcfce7'  : isFuture ? '#dbeafe'  : '#f1f5f9';
        var sLabel    = isActive ? 'ACTIVE'   : isFuture ? 'UPCOMING' : 'EXPIRED';
        var num       = String(s.next).padStart(parseInt(s.digits)||4,'0');
        var preview   = [s.prefix, num, s.suffix].filter(Boolean).join('/');
        var MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var fd = function(d){ if(!d)return'—'; var p=d.split('-'); return p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]; };
        return '<div style="border:1px solid var(--border2);border-radius:9px;padding:12px 14px;background:var(--surface);border-left:3px solid '+(isActive?'#16a34a':'var(--border2)')+';">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
            +   '<div style="display:flex;align-items:center;gap:8px">'
            +   '<span style="font-family:var(--font-mono);font-size:13px;font-weight:800;color:var(--text)">'+preview+'</span>'
            +   '<span style="font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;background:'+sBg+';color:'+sColor+'">'+sLabel+'</span>'
            +   '</div>'
            +   '<div style="display:flex;gap:6px">'
            +   '<button onclick="vNumEditStyle('+i+')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--muted2);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body)">✎ Edit</button>'
            +   '<button onclick="vNumDeleteStyle('+i+')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body)">✕</button>'
            +   '</div></div>'
            + '<div style="display:grid;grid-template-columns:repeat(4,auto);gap:16px">'
            + '<div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Prefix</div><div style="font-size:12px;color:var(--text);font-family:var(--font-mono)">'+(s.prefix||'—')+'</div></div>'
            + '<div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Suffix</div><div style="font-size:12px;color:var(--text);font-family:var(--font-mono)">'+(s.suffix||'—')+'</div></div>'
            + '<div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Valid From</div><div style="font-size:12px;color:var(--text)">'+fd(s.from)+'</div></div>'
            + '<div><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Valid To</div><div style="font-size:12px;color:var(--text)">'+fd(s.to)+'</div></div>'
            + '</div>'
            + '<div style="margin-top:8px;font-size:10px;color:var(--muted)">Digits: <strong>'+s.digits+'</strong> &nbsp;|&nbsp; Next counter: <strong>#'+s.next+'</strong></div>'
            + '</div>';
    }).join('');
}

/* ── Edit form ── */
function vNumAddNew() {
    _vNumEditIdx = -1;
    var vt  = VOUCHER_TYPES.find(function(v){ return v.key===_vNumEditType; }) || {};
    document.getElementById('vNumFormTitle').textContent = 'New Style — ' + (vt.label||_vNumEditType);
    document.getElementById('vNumPrefix').value  = vt.defaultPrefix || _vNumEditType.toUpperCase();
    document.getElementById('vNumSuffix').value  = vt.defaultSuffix || '';
    document.getElementById('vNumDigits').value  = '4';
    document.getElementById('vNumStart').value   = '1';
    var d = new Date();
    document.getElementById('vNumFrom').value    = d.toISOString().slice(0,10);
    d.setFullYear(d.getFullYear()+1); d.setDate(d.getDate()-1);
    document.getElementById('vNumTo').value      = d.toISOString().slice(0,10);
    updateVNumPreview();
    document.getElementById('voucherNumEditForm').style.display = 'block';
    document.getElementById('vNumPrefix').focus();
}

function vNumEditStyle(idx) {
    _vNumEditIdx = idx;
    var s   = _vNumGetStyles(_vNumEditType)[idx];
    var vt  = VOUCHER_TYPES.find(function(v){ return v.key===_vNumEditType; }) || {};
    document.getElementById('vNumFormTitle').textContent = 'Edit Style — ' + (vt.label||_vNumEditType);
    document.getElementById('vNumPrefix').value  = s.prefix||'';
    document.getElementById('vNumSuffix').value  = s.suffix||'';
    document.getElementById('vNumDigits').value  = s.digits||4;
    document.getElementById('vNumStart').value   = s.next||1;
    document.getElementById('vNumFrom').value    = s.from||'';
    document.getElementById('vNumTo').value      = s.to||'';
    updateVNumPreview();
    document.getElementById('voucherNumEditForm').style.display = 'block';
    document.getElementById('voucherNumEditForm').scrollIntoView({behavior:'smooth',block:'nearest'});
}

function vNumCancelEdit() {
    document.getElementById('voucherNumEditForm').style.display = 'none';
    _vNumEditIdx = -1;
}

function updateVNumPreview() {
    var prefix  = (document.getElementById('vNumPrefix').value||'').trim();
    var suffix  = (document.getElementById('vNumSuffix').value||'').trim();
    var digits  = parseInt(document.getElementById('vNumDigits').value)||4;
    var next    = parseInt(document.getElementById('vNumStart').value)||1;
    var preview = [prefix, String(next).padStart(digits,'0'), suffix].filter(Boolean).join('/');
    var el = document.getElementById('vNumPreview');
    if (el) el.textContent = preview;
}

function vNumSaveStyle() {
    var prefix = (document.getElementById('vNumPrefix').value||'').trim();
    var suffix = (document.getElementById('vNumSuffix').value||'').trim();
    var digits = parseInt(document.getElementById('vNumDigits').value)||4;
    var next   = parseInt(document.getElementById('vNumStart').value)||1;
    var from   = document.getElementById('vNumFrom').value.trim();
    var to     = document.getElementById('vNumTo').value.trim();

    if (!from || !to) { toast('Valid From and Valid To dates are required','error'); return; }
    if (from > to)    { toast('Valid From must be before Valid To','error'); return; }

    var styles = _vNumGetStyles(_vNumEditType);
    var style  = { id: Date.now(), prefix:prefix, suffix:suffix, digits:digits, next:next, from:from, to:to };

    if (_vNumEditIdx >= 0) {
        style.id = styles[_vNumEditIdx].id;
        styles[_vNumEditIdx] = style;
        toast('Style updated','success');
    } else {
        styles.push(style);
        toast('Style added','success');
    }
    styles.sort(function(a,b){ return (a.from||'').localeCompare(b.from||''); });
    _voucherNumStyles[_vNumEditType] = styles;
    _vNumSave();
    vNumRenderList();
    document.getElementById('voucherNumEditForm').style.display = 'none';
    _vNumEditIdx = -1;
}

function vNumDeleteStyle(idx) {
    if (!confirm('Delete this numbering style?')) return;
    var styles = _vNumGetStyles(_vNumEditType);
    styles.splice(idx, 1);
    _voucherNumStyles[_vNumEditType] = styles;
    _vNumSave();
    vNumRenderList();
}

// Legacy shims so old poNum* function calls still work
function poNumRenderList()   { vNumRenderList(); }
function poNumAddNew()       { vNumAddNew(); }
function poNumEditStyle(i)   { vNumEditStyle(i); }
function poNumCancelEdit()   { vNumCancelEdit(); }
function poNumSaveStyle()    { vNumSaveStyle(); }
function poNumDeleteStyle(i) { vNumDeleteStyle(i); }
function updatePONumPreview(){ updateVNumPreview(); }

