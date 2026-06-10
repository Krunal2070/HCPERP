/* ═══════════════════════════════════════════════════════════════════
 * po_import.js — Bulk Purchase Order import from Excel
 *
 * Excel layout (one row per line item; group lines with same key into
 * a single PO; header fields are taken from the first row of each group):
 *
 *   PO Group | PO Date | Supplier Name | Status | Delivery Date |
 *   Remarks  | Voucher Type | Material | Packages | Qty per Pkg |
 *   UOM      | Rate    | HSN          | GST%
 *
 * PO numbers are auto-assigned server-side using the active voucher
 * numbering style — users don't pre-assign them.
 * ═══════════════════════════════════════════════════════════════════ */

var _poImportRows = [];   // [{poGroups: [...]}]
var _poImportGroups = []; // [{group_key, header:{...}, items:[...], _valid:bool, _issues:[...]}]
var _poImpVoucherTypes = null;  // cached list from /api/gop/voucher_types?parent_type=po
var _poImpNumPreviews = {};     // {voucher_type_name → {prefix, suffix, digits, next}}

/* Load (or return cached) voucher types for parent_type='po' */
async function _poImpLoadVoucherTypes() {
    if (_poImpVoucherTypes !== null) return _poImpVoucherTypes;
    try {
        var res  = await fetch('/api/gop/voucher_types?parent_type=po');
        var data = await res.json();
        _poImpVoucherTypes = (data.types || []).filter(function(t){ return t.is_active; });
    } catch(e) {
        _poImpVoucherTypes = [];
    }
    return _poImpVoucherTypes;
}

/* Fetch (or return cached) next-number preview for a given voucher type name */
async function _poImpFetchNumPreview(typeName) {
    var key = typeName || 'po';
    if (_poImpNumPreviews[key] !== undefined) return _poImpNumPreviews[key];
    try {
        var res = await fetch('/api/gop/voucher_numbering/next?voucher_type=' + encodeURIComponent(key));
        var d = await res.json();
        if (d && d.status === 'ok') {
            _poImpNumPreviews[key] = {
                prefix: d.prefix || '', suffix: d.suffix || '',
                digits: d.digits || 4,  next: d.next || 1
            };
        } else {
            _poImpNumPreviews[key] = null;
        }
    } catch(e) {
        _poImpNumPreviews[key] = null;
    }
    return _poImpNumPreviews[key];
}

/* Format a preview into a display string like "HCP/RM/PO/0001/25-26" */
function _poImpFmtPreview(p) {
    if (!p) return null;
    var num = String(p.next).padStart(p.digits || 4, '0');
    var parts = [];
    if (p.prefix) parts.push(p.prefix);
    parts.push(num);
    if (p.suffix) parts.push(p.suffix);
    return parts.join('/');
}

/* Resolve a typed voucher-type string against the active master list.
 * Returns {ok, resolved_name, reason} — resolved_name is the canonical
 * name from the master that should be sent in the payload.
 * Matches case-insensitively against name and abbreviation. */
function _poImpResolveVoucherType(typed) {
    var t = (typed || '').trim();
    if (!t) return { ok: true, resolved_name: '', reason: 'blank — server default' };
    var list = _poImpVoucherTypes || [];
    if (!list.length) {
        // No master configured — accept anything (server falls back to 'po' default style)
        return { ok: true, resolved_name: t, reason: 'no voucher type master configured' };
    }
    var tl = t.toLowerCase();
    for (var i = 0; i < list.length; i++) {
        var vt = list[i];
        if ((vt.name || '').toLowerCase().trim() === tl) {
            return { ok: true, resolved_name: vt.name, reason: 'matched name' };
        }
        if ((vt.abbreviation || '').toLowerCase().trim() === tl) {
            return { ok: true, resolved_name: vt.name, reason: 'matched abbreviation "' + vt.abbreviation + '"' };
        }
    }
    return { ok: false, resolved_name: t, reason: 'voucher type "' + t + '" not found in master' };
}

/* ── Column layout for template + parser ────────────────────────── */
var PO_IMPORT_COLS = [
    {key:'group_key',     label:'PO Group',         aliases:['po group','group','po','po key','po #']},
    {key:'po_date',       label:'PO Date',          aliases:['date','order date']},
    {key:'supplier_name', label:'Supplier Name',    aliases:['supplier','vendor','vendor name']},
    {key:'status',        label:'Status',           aliases:['po status']},
    {key:'delivery_date', label:'Delivery Date',    aliases:['expected date','expected by','delivery']},
    {key:'remarks',       label:'Remarks',          aliases:['notes','comment','comments']},
    {key:'voucher_type',  label:'Voucher Type',     aliases:['po type','type']},
    {key:'material',      label:'Material',         aliases:['material name','item','product']},
    {key:'packages',      label:'Packages',         aliases:['pkgs','pkg','no of packages','no. of packages']},
    {key:'qty_per_pkg',   label:'Qty per Pkg',      aliases:['qty/pkg','qty per package','quantity per package']},
    {key:'uom',           label:'UOM',              aliases:['unit','units']},
    {key:'rate',          label:'Rate',             aliases:['price','unit price','rate (₹)','rate (rs)','rate per kg']},
    {key:'hsn',           label:'HSN',              aliases:['hsn code']},
    {key:'gst',           label:'GST%',             aliases:['gst','gst %','gst rate','tax%']}
];

/* ── Excel dropdown toggle ──────────────────────────────────────── */
function poToggleExcelDrop(e) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('poExcelDrop');
    if (!dd) return;
    dd.style.display = (dd.style.display === 'none' || !dd.style.display) ? 'block' : 'none';
}
document.addEventListener('click', function(e) {
    var dd = document.getElementById('poExcelDrop');
    var btn = document.getElementById('poExcelBtn');
    if (!dd || dd.style.display === 'none') return;
    if (btn && (btn === e.target || btn.contains(e.target))) return;
    if (dd.contains(e.target)) return;
    dd.style.display = 'none';
});

/* ── Date helpers (DD/MMM/YYYY everywhere per project rule) ─────── */
var _PO_IMP_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* Format an ISO yyyy-mm-dd or any Date-parseable string to DD/MMM/YYYY */
function _poImpFmtDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
        return String(v.getDate()).padStart(2,'0') + '/' + _PO_IMP_MONTHS[v.getMonth()] + '/' + v.getFullYear();
    }
    var s = String(v).trim();
    // Already DD/MMM/YYYY?
    var m = s.match(/^(\d{1,2})[\/\-\s]+([A-Za-z]{3,})[\/\-\s]+(\d{4})$/);
    if (m) {
        var mi = _PO_IMP_MONTHS.findIndex(function(mn){ return mn.toLowerCase() === m[2].toLowerCase().slice(0,3); });
        if (mi >= 0) return String(parseInt(m[1],10)).padStart(2,'0') + '/' + _PO_IMP_MONTHS[mi] + '/' + m[3];
    }
    // ISO yyyy-mm-dd
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
        var mi2 = parseInt(m[2],10) - 1;
        if (mi2 >= 0 && mi2 < 12) return String(parseInt(m[3],10)).padStart(2,'0') + '/' + _PO_IMP_MONTHS[mi2] + '/' + m[1];
    }
    // DD/MM/YYYY or DD-MM-YYYY
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        var mi3 = parseInt(m[2],10) - 1;
        if (mi3 >= 0 && mi3 < 12) return String(parseInt(m[1],10)).padStart(2,'0') + '/' + _PO_IMP_MONTHS[mi3] + '/' + m[3];
    }
    return s; // fallback — pass through, parser will flag
}

/* Convert any user-facing date to ISO yyyy-mm-dd for backend payload */
function _poImpDateToIso(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
        return v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0') + '-' + String(v.getDate()).padStart(2,'0');
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{1,2})[\/\-\s]+([A-Za-z]{3,})[\/\-\s]+(\d{4})$/);
    if (m) {
        var mi = _PO_IMP_MONTHS.findIndex(function(mn){ return mn.toLowerCase() === m[2].toLowerCase().slice(0,3); });
        if (mi >= 0) return m[3] + '-' + String(mi+1).padStart(2,'0') + '-' + String(parseInt(m[1],10)).padStart(2,'0');
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + String(parseInt(m[2],10)).padStart(2,'0') + '-' + String(parseInt(m[3],10)).padStart(2,'0');
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return m[3] + '-' + String(parseInt(m[2],10)).padStart(2,'0') + '-' + String(parseInt(m[1],10)).padStart(2,'0');
    return null;
}

/* ── Template download ──────────────────────────────────────────── */
async function poDownloadImportTemplate() {
    if (typeof XLSX === 'undefined') {
        toast('XLSX library not loaded', 'error');
        return;
    }
    var headers = PO_IMPORT_COLS.map(function(c){ return c.label; });

    // Today + 15 days for sample dates
    var today = new Date();
    var fmtIso = function(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
    var soon = new Date(today.getTime() + 15*24*60*60*1000);
    var todayStr = _poImpFmtDate(fmtIso(today));
    var soonStr  = _poImpFmtDate(fmtIso(soon));

    var sample = [
        // PO-1: 2 line items, only first row has header fields
        ['PO-1', todayStr, 'AHMEDABAD AGENCY', 'open',  soonStr, 'sample bulk order', 'General Purchase Order (General PO)', 'Galaxy 226',    5, 50,  'KG', 135, '',     18],
        ['PO-1', '',        '',                  '',      '',       '',                  '',                                  'Glycerin',      2, 100, 'KG', 90,  '',     18],
        // PO-2: 1 line item
        ['PO-2', todayStr, 'KOTHARI FRAGRANCES', 'open', soonStr, '',                  '',                                  'Sandalwood Oil', 1, 25,  'KG', 4500, '',    18]
    ];

    var aoa = [headers].concat(sample);
    var ws = XLSX.utils.aoa_to_sheet(aoa);

    // Set column widths for readability
    ws['!cols'] = [
        {wch:10},{wch:14},{wch:28},{wch:10},{wch:14},{wch:24},{wch:30},
        {wch:24},{wch:9},{wch:11},{wch:6},{wch:9},{wch:8},{wch:7}
    ];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Orders');

    // Instructions sheet
    var notes = [
        ['Purchase Order Bulk Import Template'],
        [''],
        ['HOW TO USE:'],
        ['  1. One row per line-item.  Group multiple lines into one PO by giving them the same "PO Group" value.'],
        ['  2. PO header fields (PO Date, Supplier, Status, Delivery Date, Remarks, Voucher Type) only need to be filled on the FIRST row of each group.  Subsequent rows in the same group can leave them blank.'],
        ['  3. PO numbers are assigned automatically by the server using the active voucher numbering style.  Do NOT pre-assign PO numbers.'],
        ['  4. Dates must be DD/MMM/YYYY (e.g. 01/Jun/2026).  DD-MM-YYYY and YYYY-MM-DD are also accepted.'],
        ['  5. Supplier Name must match an existing supplier exactly (case-insensitive, trimmed).  Materials must match the Material Master.'],
        ['  6. Status defaults to "open" if blank.  Voucher Type defaults to the first available type.'],
        ['  7. Total Qty for each line = Packages × Qty per Pkg.  If only total qty is known, use Packages=1 and Qty per Pkg=<total>.'],
        [''],
        ['COLUMN REFERENCE:'],
        ['  PO Group       Any label that groups rows of the same PO (e.g. PO-1, batch-A)'],
        ['  PO Date        First row of each group only.  Defaults to today if blank.'],
        ['  Supplier Name  First row of each group only.  Must match Supplier Master.'],
        ['  Status         open / approved / not_approved / closed / cancelled.  Default: open'],
        ['  Delivery Date  First row of each group only.  Optional.'],
        ['  Remarks        First row of each group only.  Optional.'],
        ['  Voucher Type   First row of each group only.  Optional — defaults to the first configured voucher type.'],
        ['  Material       Required.  Must match Material Master.'],
        ['  Packages       Whole number.  Default 1 if blank but Qty/Pkg given.'],
        ['  Qty per Pkg    Decimal.  Default to total qty / packages.'],
        ['  UOM            Defaults to material master UOM, then KG.'],
        ['  Rate           Decimal (₹).  Defaults to last purchase rate.'],
        ['  HSN            Optional override of material master HSN.'],
        ['  GST%           Enter as a PERCENTAGE — e.g. 18 (not 0.18).  Optional override of material master GST rate.']
    ];
    var nws = XLSX.utils.aoa_to_sheet(notes);
    nws['!cols'] = [{wch:130}];
    XLSX.utils.book_append_sheet(wb, nws, 'Instructions');

    // ── Voucher Types reference sheet ──────────────────────────────
    // Lists valid voucher type names (paste these into the "Voucher Type" column).
    // Also shows what numbering style each will produce — purely informational.
    var vtTypes = [];
    try { vtTypes = await _poImpLoadVoucherTypes(); } catch(_) { vtTypes = []; }
    var vtAoa = [['Voucher Type Name', 'Abbreviation', 'Next PO Number Preview']];
    if (!vtTypes.length) {
        vtAoa.push(['(no voucher types configured — leave the column blank to use default numbering)','','']);
    } else {
        // Fetch number previews for each in parallel, then render
        try {
            await Promise.all(vtTypes.map(function(t){ return _poImpFetchNumPreview(t.name); }));
        } catch(_) {}
        vtTypes.forEach(function(t){
            var preview = _poImpFmtPreview(_poImpNumPreviews[t.name]);
            vtAoa.push([
                t.name || '',
                t.abbreviation || '',
                preview || '(no numbering style configured)'
            ]);
        });
        vtAoa.push(['', '', '']);
        vtAoa.push(['Paste a value from "Voucher Type Name" or "Abbreviation" column into the Voucher Type field of the import sheet.','','']);
        vtAoa.push(['Leave blank to use the default voucher type / numbering style.','','']);
    }
    var vws = XLSX.utils.aoa_to_sheet(vtAoa);
    vws['!cols'] = [{wch:50}, {wch:20}, {wch:34}];
    XLSX.utils.book_append_sheet(wb, vws, 'Voucher Types');

    var stamp = _poImpFmtDate(fmtIso(today)).replace(/\//g,'-');
    XLSX.writeFile(wb, 'PO_Import_Template_' + stamp + '.xlsx');
    toast('Template downloaded', 'success');
}

/* ── File parser ────────────────────────────────────────────────── */
function poImportExcel(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    input.value = ''; // reset so same file can be re-selected
    if (typeof XLSX === 'undefined') { toast('XLSX library not loaded', 'error'); return; }

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
            // Prefer a sheet called "Purchase Orders" if present, else first sheet
            var sheetName = wb.SheetNames.find(function(n){ return /purchase orders?/i.test(n); }) || wb.SheetNames[0];
            var ws = wb.Sheets[sheetName];
            var raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, dateNF:'yyyy-mm-dd'});
            if (!raw.length) { toast('File is empty', 'error'); return; }

            // Locate header row — search first 5 rows for one containing "Material" + "Supplier"
            var headerIdx = 0;
            for (var i = 0; i < Math.min(raw.length, 5); i++) {
                var rowStr = (raw[i]||[]).join(' ').toLowerCase();
                if (rowStr.indexOf('material') >= 0 && (rowStr.indexOf('supplier') >= 0 || rowStr.indexOf('po group') >= 0)) {
                    headerIdx = i; break;
                }
            }
            var headers = (raw[headerIdx] || []).map(function(h){ return (h == null ? '' : String(h)).trim(); });

            // Build column map (header label → key)
            var colMap = {};
            PO_IMPORT_COLS.forEach(function(col) {
                var labelN = col.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                var aliasN = (col.aliases || []).map(function(a){ return a.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); });
                for (var j = 0; j < headers.length; j++) {
                    var h = headers[j].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    if (!h) continue;
                    if (h === labelN || aliasN.indexOf(h) >= 0) {
                        if (colMap[col.key] === undefined) colMap[col.key] = j;
                    }
                }
            });

            if (colMap.material === undefined) {
                toast('Could not find "Material" column — check the headers in your file', 'error');
                return;
            }

            // Parse data rows
            var dataRows = raw.slice(headerIdx + 1).filter(function(r){
                return r.some(function(c){ return c !== '' && c != null; });
            });
            if (!dataRows.length) { toast('No data rows found', 'error'); return; }

            var parsed = dataRows.map(function(row, rIdx) {
                var rec = { _row: headerIdx + 2 + rIdx }; // 1-based Excel row number for error reporting
                PO_IMPORT_COLS.forEach(function(col) {
                    var idx = colMap[col.key];
                    var v = (idx !== undefined) ? row[idx] : '';
                    rec[col.key] = (v == null) ? '' : (v instanceof Date ? v : String(v).trim());
                });
                return rec;
            });

            // Group rows by PO Group, carrying forward header fields where blank
            _poImportGroups = _poImpBuildGroups(parsed);
            if (!_poImportGroups.length) { toast('No valid POs found in the file', 'error'); return; }

            // Load voucher type master + per-type number previews BEFORE validating
            // (so we can both validate the typed voucher type and show what number
            // each PO will get).
            _poImpLoadVoucherTypes().then(function(){
                // Validate each group against supplier + material masters + voucher types
                _poImpValidateGroups(_poImportGroups);

                // Fetch numbering previews for each unique voucher type used.
                // Server returns next-available number per type; we only display it
                // (server still assigns atomically at import time, so the actual
                // assigned number may differ if other POs land in between).
                var uniqueTypes = {};
                _poImportGroups.forEach(function(g){
                    if (g._valid) uniqueTypes[g.header.voucher_type || ''] = true;
                });
                var typeNames = Object.keys(uniqueTypes);
                Promise.all(typeNames.map(function(tn){ return _poImpFetchNumPreview(tn); }))
                    .then(function(){
                        poShowImportPreview(file.name, _poImportGroups);
                    });
            });
        } catch (err) {
            toast('Failed to read file: ' + err.message, 'error');
            try { console.error(err); } catch(_) {}
        }
    };
    reader.readAsArrayBuffer(file);
}

/* Group rows into POs and carry forward header fields */
function _poImpBuildGroups(rows) {
    var groups = [];
    var byKey = {};
    var lastKey = null;
    var anonCounter = 0;

    rows.forEach(function(r) {
        // Skip lines with no material (probably a separator row)
        var mat = (r.material || '').toString().trim();
        if (!mat) return;

        // Determine grouping key — explicit "PO Group" wins; else carry the last; else anonymous
        var gk = (r.group_key || '').toString().trim();
        if (!gk) {
            // No group key — if header fields present, start a new anonymous group
            var hasHeaderFields = (r.supplier_name || '').toString().trim() || (r.po_date || '').toString().trim();
            if (hasHeaderFields || lastKey == null) {
                anonCounter++;
                gk = '__anon_' + anonCounter;
            } else {
                gk = lastKey; // continue previous group
            }
        }
        lastKey = gk;

        if (!byKey[gk]) {
            byKey[gk] = {
                group_key: gk,
                header: {
                    po_date:        (r.po_date       || '').toString().trim(),
                    supplier_name:  (r.supplier_name || '').toString().trim(),
                    status:         (r.status        || '').toString().trim() || 'open',
                    delivery_date:  (r.delivery_date || '').toString().trim(),
                    remarks:        (r.remarks       || '').toString().trim(),
                    voucher_type:   (r.voucher_type  || '').toString().trim()
                },
                items: [],
                _issues: [],
                _valid: true
            };
            groups.push(byKey[gk]);
        } else {
            // Carry forward header fields from THIS row only if not already set on the group
            var g = byKey[gk];
            ['po_date','supplier_name','status','delivery_date','remarks','voucher_type'].forEach(function(k){
                if (!g.header[k] && (r[k] || '').toString().trim()) {
                    g.header[k] = (r[k] || '').toString().trim();
                }
            });
        }

        byKey[gk].items.push({
            _row:        r._row,
            material:    mat,
            packages:    (r.packages    || '').toString().trim(),
            qty_per_pkg: (r.qty_per_pkg || '').toString().trim(),
            uom:         (r.uom         || '').toString().trim(),
            rate:        (r.rate        || '').toString().trim(),
            hsn:         (r.hsn         || '').toString().trim(),
            gst:         (r.gst         || '').toString().trim()
        });
    });

    return groups;
}

/* Validate groups against in-memory supplier + material masters */
function _poImpValidateGroups(groups) {
    var supLookup = {};
    (typeof _supRows !== 'undefined' && _supRows ? _supRows : []).forEach(function(s) {
        if (s && s.supplier_name) supLookup[s.supplier_name.toLowerCase().trim()] = s;
    });

    var matLookup = {};
    (typeof _allRows !== 'undefined' && _allRows ? _allRows : []).forEach(function(m) {
        if (m && m.material_name) matLookup[m.material_name.toLowerCase().trim()] = m;
    });

    groups.forEach(function(g) {
        g._issues = [];
        g._valid = true;

        // Supplier
        if (!g.header.supplier_name) {
            g._issues.push('Supplier missing');
            g._valid = false;
        } else if (!supLookup[g.header.supplier_name.toLowerCase()]) {
            g._issues.push('Supplier "' + g.header.supplier_name + '" not in master');
            g._valid = false;
        }

        // Items
        if (!g.items.length) {
            g._issues.push('No line items');
            g._valid = false;
        }
        g.items.forEach(function(it) {
            it._issues = [];
            var mr = matLookup[it.material.toLowerCase()];
            if (!mr) {
                it._issues.push('Material not in master');
                g._valid = false;
            } else {
                // Back-fill UOM from master if blank
                if (!it.uom) it.uom = (mr.uom || 'KG');
                // Back-fill rate if blank
                if (!it.rate && mr.last_purchase_rate != null && parseFloat(mr.last_purchase_rate) > 0) {
                    it.rate = String(mr.last_purchase_rate);
                }
                // Back-fill HSN / GST if blank
                if (!it.hsn && mr.hsn_code) it.hsn = mr.hsn_code;
                if (!it.gst && mr.gst_rate != null) it.gst = String(mr.gst_rate);
            }
            // Normalize GST: if user typed a fraction like 0.18 thinking GST
            // is a multiplier, convert it to percentage form (18).  Real GST
            // rates are 0/5/12/18/28 — any non-zero value below 1 is almost
            // certainly a typing mistake.
            var _gstVal = parseFloat(it.gst);
            if (isFinite(_gstVal) && _gstVal > 0 && _gstVal < 1) {
                var _gstWas = it.gst;
                it.gst = String(Math.round(_gstVal * 100 * 100) / 100);
                it._gst_note = 'normalized ' + _gstWas + ' → ' + it.gst + '%';
            }
            // Numeric checks
            var pkgs = parseFloat(it.packages);
            var qpp  = parseFloat(it.qty_per_pkg);
            if ((!isFinite(pkgs) || pkgs <= 0) && (!isFinite(qpp) || qpp <= 0)) {
                it._issues.push('Both Packages and Qty/Pkg are empty');
                g._valid = false;
            } else if (!isFinite(pkgs) || pkgs <= 0) {
                it.packages = '1'; // default 1
            } else if (!isFinite(qpp) || qpp <= 0) {
                it._issues.push('Qty per Pkg is empty');
                g._valid = false;
            }
            if (it.rate === '' || !isFinite(parseFloat(it.rate))) {
                it._issues.push('Rate missing');
                g._valid = false;
            }
        });

        // Date format
        if (g.header.po_date && !_poImpDateToIso(g.header.po_date)) {
            g._issues.push('PO Date unrecognised: ' + g.header.po_date);
            g._valid = false;
        }
        if (g.header.delivery_date && !_poImpDateToIso(g.header.delivery_date)) {
            g._issues.push('Delivery Date unrecognised: ' + g.header.delivery_date);
            g._valid = false;
        }

        // Voucher type — resolve against master and canonicalize
        var vtRes = _poImpResolveVoucherType(g.header.voucher_type);
        if (!vtRes.ok) {
            g._issues.push(vtRes.reason);
            g._valid = false;
        }
        // Replace the typed string with the canonical name from the master
        // (so abbreviation typed by the user → full name sent to server).
        g.header.voucher_type = vtRes.resolved_name;
        g._vtype_note = vtRes.reason;
    });
}

/* ── Preview rendering ──────────────────────────────────────────── */
function poShowImportPreview(filename, groups) {
    var modal = document.getElementById('poImportModal');
    if (!modal) return;

    var totalLines = groups.reduce(function(s,g){ return s + g.items.length; }, 0);
    var validCount   = groups.filter(function(g){ return g._valid; }).length;
    var invalidCount = groups.length - validCount;

    var fn = document.getElementById('poImportFileName'); if (fn) fn.textContent = filename;
    var pc = document.getElementById('poImportPoCount'); if (pc) pc.textContent = groups.length + ' POs · ' + totalLines + ' line items';
    var fs = document.getElementById('poImportFileStrip'); if (fs) fs.style.display = 'flex';
    var sb = document.getElementById('poImportSub');  if (sb) sb.textContent = 'Preview — ' + groups.length + ' POs to import';
    var uz = document.getElementById('poImportUploadZone'); if (uz) uz.style.display = 'none';
    var lg = document.getElementById('poImportLog'); if (lg) { lg.style.display = 'none'; lg.innerHTML = ''; }

    // Validation summary
    var val = document.getElementById('poImportValidation');
    if (val) {
        val.style.display = 'block';
        var html = '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">';
        html += '<span style="font-weight:700;color:var(--text)">Validation:</span>';
        html += '<span style="color:#059669;font-weight:600">&#x2713; ' + validCount + ' valid</span>';
        if (invalidCount) html += '<span style="color:var(--red-text);font-weight:600">&#x2717; ' + invalidCount + ' have issues</span>';
        html += '<span style="color:var(--muted)">' + groups.length + ' POs · ' + totalLines + ' line items</span>';
        html += '</div>';
        if (invalidCount) html += '<div style="margin-top:6px;font-size:11px;color:var(--muted)">Only valid POs will be imported. Fix the issues in your Excel and re-upload to import everything.</div>';
        val.innerHTML = html;
    }

    // Group cards
    var list = document.getElementById('poImportPreviewList');
    if (!list) return;
    list.innerHTML = groups.map(function(g, gi) {
        var totalQty = g.items.reduce(function(s,it){
            var pk = parseFloat(it.packages)||0, qp = parseFloat(it.qty_per_pkg)||0;
            return s + (pk*qp);
        }, 0);
        var totalAmt = g.items.reduce(function(s,it){
            var pk = parseFloat(it.packages)||0, qp = parseFloat(it.qty_per_pkg)||0, rt = parseFloat(it.rate)||0;
            return s + (pk*qp*rt);
        }, 0);

        var pillClass = g._valid ? 'received' : 'draft';
        var pillTxt   = g._valid ? 'VALID' : 'ISSUES';
        var pillColor = g._valid ? '#059669' : 'var(--red-text)';
        var pillBg    = g._valid ? 'rgba(16,185,129,.12)' : 'rgba(244,63,94,.10)';

        // Group header (collapsible)
        var displayKey = g.group_key.replace(/^__anon_/, 'PO ');
        var hdr = '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px 8px 0 0;cursor:pointer" onclick="(function(el){var b=el.parentNode.querySelector(\'.po-imp-body\');b.style.display=(b.style.display===\'none\'?\'\':\'none\');})(this)">';
        hdr += '<span style="font-weight:800;font-size:13px;color:var(--text)">' + escHtml(displayKey) + '</span>';
        hdr += '<span style="font-size:10px;color:var(--muted);font-style:italic">(label only — PO number auto-assigned on import)</span>';
        hdr += '<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:' + pillBg + ';color:' + pillColor + ';font-size:10px;font-weight:700;letter-spacing:.5px">' + pillTxt + '</span>';
        hdr += '<span style="font-size:11.5px;color:var(--muted);font-weight:600">' + escHtml(g.header.supplier_name || '— no supplier —') + '</span>';
        hdr += '<span style="margin-left:auto;font-size:11px;color:var(--muted)">';
        hdr +=     g.items.length + ' line' + (g.items.length===1?'':'s') + ' · ';
        hdr +=     '\u20b9 ' + totalAmt.toLocaleString('en-IN',{maximumFractionDigits:2});
        hdr += '</span>';
        hdr += '</div>';

        // Header meta row
        // Build numbering preview text for this group
        var vtKey = g.header.voucher_type || '';
        var prevObj = _poImpNumPreviews[vtKey] !== undefined ? _poImpNumPreviews[vtKey] : null;
        var prevStr = _poImpFmtPreview(prevObj);
        var vtDisplay = g.header.voucher_type || 'default';
        var voucherCell = '<b>' + escHtml(vtDisplay) + '</b>';
        if (prevStr) {
            voucherCell += ' <span style="color:var(--muted);font-size:10.5px">&rarr; next #</span> <code style="font-size:11px;color:var(--teal);font-weight:700">' + escHtml(prevStr) + '</code>';
        } else if (g._valid) {
            voucherCell += ' <span style="color:var(--amber-text,#b45309);font-size:10.5px;font-style:italic">(no numbering style configured — will use default)</span>';
        }

        var meta = '<div class="po-imp-body" style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;background:var(--surface)">';
        meta += '<div style="display:grid;grid-template-columns:repeat(3,1fr) 2fr;gap:8px;padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border)">';
        meta += '<div><span style="color:var(--muted)">Date:</span> <b>' + escHtml(_poImpFmtDate(g.header.po_date) || 'today') + '</b></div>';
        meta += '<div><span style="color:var(--muted)">Delivery:</span> <b>' + escHtml(_poImpFmtDate(g.header.delivery_date) || '—') + '</b></div>';
        meta += '<div><span style="color:var(--muted)">Status:</span> <b>' + escHtml((g.header.status||'open').toUpperCase()) + '</b></div>';
        meta += '<div><span style="color:var(--muted)">Voucher:</span> ' + voucherCell + '</div>';
        if (g.header.remarks) meta += '<div style="grid-column:1/-1"><span style="color:var(--muted)">Remarks:</span> ' + escHtml(g.header.remarks) + '</div>';
        meta += '</div>';

        // Issues block
        if (g._issues.length) {
            meta += '<div style="padding:6px 12px;background:rgba(244,63,94,.06);border-bottom:1px solid var(--border);font-size:11px;color:var(--red-text)">';
            meta += '<b>Group issues:</b> ' + g._issues.map(escHtml).join(' · ');
            meta += '</div>';
        }

        // Line items table
        meta += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">';
        meta += '<thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border)">';
        ['#','Material','Pkgs','Qty/Pkg','UOM','Total','Rate','Amount','Status'].forEach(function(h,i){
            var ta = (i===0||i===2||i===3||i===4||i===5||i===6||i===7) ? 'right' : 'left';
            if (i===0||i===4||i===8) ta = 'center';
            meta += '<th style="padding:6px 8px;text-align:'+ta+';font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">'+h+'</th>';
        });
        meta += '</tr></thead><tbody>';
        g.items.forEach(function(it, i) {
            var pk = parseFloat(it.packages)||0, qp = parseFloat(it.qty_per_pkg)||0, rt = parseFloat(it.rate)||0;
            var tq = pk*qp, amt = tq*rt;
            var rowBg = (i%2 ? 'var(--surface2)' : 'var(--surface)');
            var ok = !it._issues || !it._issues.length;
            meta += '<tr style="border-bottom:1px solid var(--border);background:' + rowBg + '">';
            meta += '<td style="padding:6px 8px;text-align:center;color:var(--muted)">' + (i+1) + '</td>';
            meta += '<td style="padding:6px 8px;font-weight:600">' + escHtml(it.material) + '</td>';
            meta += '<td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">' + (pk||'—') + '</td>';
            meta += '<td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">' + (qp||'—') + '</td>';
            meta += '<td style="padding:6px 8px;text-align:center">' + escHtml(it.uom||'') + '</td>';
            meta += '<td style="padding:6px 8px;text-align:right;font-family:var(--font-mono);font-weight:600">' + (tq>0 ? tq.toLocaleString('en-IN',{maximumFractionDigits:3}) : '—') + '</td>';
            meta += '<td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">' + (rt>0 ? rt.toLocaleString('en-IN',{maximumFractionDigits:2}) : '—') + '</td>';
            meta += '<td style="padding:6px 8px;text-align:right;font-family:var(--font-mono);font-weight:700">' + (amt>0 ? '\u20b9 '+amt.toLocaleString('en-IN',{maximumFractionDigits:2}) : '—') + '</td>';
            if (ok) {
                if (it._gst_note) {
                    meta += '<td style="padding:6px 8px;text-align:center;color:#b45309;font-weight:600;font-size:10px" title="' + escHtml(it._gst_note) + '">&#x26A0; GST fixed</td>';
                } else {
                    meta += '<td style="padding:6px 8px;text-align:center;color:#059669;font-weight:700">&#x2713;</td>';
                }
            } else {
                meta += '<td style="padding:6px 8px;text-align:center;color:var(--red-text);font-weight:600;font-size:10.5px" title="' + escHtml(it._issues.join('; ')) + '">' + escHtml(it._issues.join(', ')) + '</td>';
            }
            meta += '</tr>';
        });
        meta += '</tbody></table></div>';

        return '<div style="margin-bottom:14px">' + hdr + meta + '</div>';
    }).join('');

    // Stats + confirm button
    var stats = document.getElementById('poImportStats');
    if (stats) stats.textContent = validCount + ' of ' + groups.length + ' POs ready to import';
    var btn = document.getElementById('poImportConfirmBtn');
    if (btn) {
        var enabled = validCount > 0;
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '1' : '.5';
        btn.style.cursor  = enabled ? 'pointer' : 'not-allowed';
        btn.textContent   = '\u2713 Import ' + validCount + ' PO' + (validCount===1?'':'s');
    }

    modal.classList.add('open');
}

/* ── Confirm + send to backend ──────────────────────────────────── */
async function confirmPoImport() {
    var valid = _poImportGroups.filter(function(g){ return g._valid; });
    if (!valid.length) { toast('No valid POs to import', 'error'); return; }

    // Build server payload — array of PO objects matching /api/procurement/po/save shape
    var payload = { pos: valid.map(function(g) {
        // Build items list
        var items = g.items.map(function(it) {
            var pk = parseFloat(it.packages)||0, qp = parseFloat(it.qty_per_pkg)||0, rt = parseFloat(it.rate)||0;
            return {
                material:    it.material,
                qty:         pk * qp,
                qty_per_pkg: qp,
                packages:    pk > 0 ? Math.round(pk) : null,
                rate:        rt,
                uom:         it.uom || 'KG',
                hsn_code:    it.hsn || '',
                gst_rate:    parseFloat(it.gst) || 0
            };
        });
        return {
            _group_key:        g.group_key,
            po_date:           _poImpDateToIso(g.header.po_date) || null,
            supplier_name:     g.header.supplier_name,
            status:            (g.header.status || 'open').toLowerCase(),
            delivery_date:     _poImpDateToIso(g.header.delivery_date) || null,
            remarks:           g.header.remarks || null,
            voucher_type_name: g.header.voucher_type || null,
            items: items
        };
    })};

    // Lock the UI
    var btn = document.getElementById('poImportConfirmBtn');
    if (btn) { btn.disabled = true; btn.style.opacity = '.5'; btn.textContent = 'Importing…'; }

    var log = document.getElementById('poImportLog');
    if (log) { log.style.display = 'block'; log.innerHTML = 'Uploading ' + valid.length + ' POs…\n'; }

    try {
        var res = await fetch('/api/procurement/po/bulk_import', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message || 'Import failed');

        // Render log
        var lines = [];
        lines.push('Done — ' + (d.created||0) + ' created, ' + (d.failed||0) + ' failed.\n');
        (d.results || []).forEach(function(r, i) {
            var grp = r.group_key ? (r.group_key.replace(/^__anon_/,'PO ') + '  →  ') : '';
            if (r.ok) {
                lines.push('[' + (i+1) + '] \u2713 ' + grp + (r.po_num || '(no number)') + '  —  ' + (r.supplier_name||'') + '  (' + (r.line_count||0) + ' lines)');
            } else {
                lines.push('[' + (i+1) + '] \u2717 ' + grp + (r.supplier_name||'(no supplier)') + '  —  ' + (r.error||'unknown error'));
            }
        });
        if (log) { log.innerHTML = lines.map(escHtml).join('\n'); }

        if (d.created > 0) {
            toast(d.created + ' POs imported successfully', 'success');
            // Refresh PO list
            if (typeof loadPoData === 'function') loadPoData();
        }
        if (d.failed > 0) {
            toast(d.failed + ' POs failed — see import log', 'error', 6000);
        }

        // Re-purpose the confirm button as "Close"
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.textContent = 'Close';
            btn.onclick = function(){ closePoImportModal(); btn.onclick = null; };
        }
    } catch (err) {
        toast('Import failed: ' + err.message, 'error');
        if (log) { log.innerHTML = '\u2717 ' + escHtml(err.message); }
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.textContent = 'Retry';
        }
    }
}

/* ── Close + reset ──────────────────────────────────────────────── */
function closePoImportModal() {
    var modal = document.getElementById('poImportModal');
    if (modal) modal.classList.remove('open');
    _poImportRows = [];
    _poImportGroups = [];

    var uz = document.getElementById('poImportUploadZone'); if (uz) uz.style.display = 'flex';
    var fs = document.getElementById('poImportFileStrip'); if (fs) fs.style.display = 'none';
    var pl = document.getElementById('poImportPreviewList'); if (pl) pl.innerHTML = '';
    var val = document.getElementById('poImportValidation'); if (val) { val.style.display = 'none'; val.innerHTML = ''; }
    var lg = document.getElementById('poImportLog'); if (lg) { lg.style.display = 'none'; lg.innerHTML = ''; }
    var st = document.getElementById('poImportStats'); if (st) st.textContent = '';
    var sb = document.getElementById('poImportSub'); if (sb) sb.textContent = 'Select a file to begin';

    var btn = document.getElementById('poImportConfirmBtn');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '.5';
        btn.style.cursor = 'not-allowed';
        btn.textContent = '\u2713 Import POs';
        btn.onclick = function(){ confirmPoImport(); };
    }
}
