/* grn.js — Goods Receipt Note module
   Depends on: utils.js, app.js, po.js (for _poRows, _allRows, _supRows) */

var _grnRows     = [];   // all GRNs from server
var _grnFiltered = [];   // after filter
var _grnFilter   = 'all';
var _grnEditId   = null; // null = new GRN
var _grnLines    = [];   // [{material, po_qty, received_qty, rate, hsn_code, gst_rate}]
var _grnPoInvoices = []; // [{po_id, po_num, invoice_num, invoice_date}]
window._grnLoaded = false;

/* ═══════════════════════════════════════════════════════
   LIST — load & render
═══════════════════════════════════════════════════════ */
function loadGrnData() {
    var body = document.getElementById('grnListBody');
    if (body) body.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading GRNs…</h3></div>';
    fetch('/api/procurement/grn/list')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status !== 'ok') throw new Error(d.message);
            _grnRows = d.grns || [];
            window._grnLoaded = true;
            var sb = document.getElementById('sbBadge-grn');
            if (sb) sb.textContent = _grnRows.length;
            grnApplyFilter();
        })
        .catch(function(e){ if (body) body.innerHTML = '<div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>'+escHtml(e.message)+'</p></div>'; });
}

function grnSetFilter(f) {
    _grnFilter = f;
    document.querySelectorAll('#grnFilterGroup .filter-pill').forEach(function(b){
        b.classList.toggle('active', b.id === 'grnF' + f.charAt(0).toUpperCase() + f.slice(1));
    });
    grnApplyFilter();
}

function grnApplyFilter() {
    var q = (document.getElementById('grnSearchInput') ? document.getElementById('grnSearchInput').value : '').toLowerCase().trim();
    _grnFiltered = _grnRows.filter(function(r){
        // Status filter
        if (_grnFilter !== 'all' && r.status !== _grnFilter) return false;
        // Search: GRN num, supplier, PO num, invoice nums
        if (!q) return true;
        var haystack = [
            r.grn_num||'', r.supplier_name||'', r.po_num||'',
            r.invoice_num||'', r.grn_date||'', r.remarks||''
        ].join(' ').toLowerCase();
        // Also search inside po_invoices
        if (r.po_invoices && r.po_invoices.length) {
            r.po_invoices.forEach(function(inv){
                haystack += ' '+(inv.invoice_num||'')+' '+(inv.po_num||'');
            });
        }
        return haystack.indexOf(q) !== -1;
    });
    var badge = document.getElementById('grnRowBadge');
    if (badge) badge.textContent = _grnFiltered.length + ' GRN' + (_grnFiltered.length!==1?'s':'');
    grnRenderList();
}

function grnRenderList() {
    var body = document.getElementById('grnListBody');
    if (!body) return;
    if (!_grnFiltered.length) {
        body.innerHTML = '<div class="state-box" style="padding:40px"><div class="state-icon">📋</div><h3>No GRNs found</h3><p>Click <strong>New GRN</strong> to create one.</p></div>';
        return;
    }
    var fi = function(n){ return n != null ? '₹ '+parseFloat(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'; };
    var statusColor = {open:'#0284c7',received:'var(--green-text)',partial:'var(--amber-text)',cancelled:'var(--muted)',draft:'var(--muted)'};
    var statusBg    = {open:'rgba(14,165,233,.12)',received:'var(--green-bg)',partial:'rgba(245,158,11,.12)',cancelled:'var(--text-08)',draft:'var(--text-08)'};

    body.innerHTML = '<div class="table-shell"><div class="table-scroll"><table>'
        + '<thead><tr>'
        + '<th style="white-space:nowrap">GRN No.</th>'
        + '<th>Supplier</th>'
        + '<th style="white-space:nowrap">GRN Date</th>'
        + '<th>Linked PO(s)</th>'
        + '<th>Invoice(s)</th>'
        + '<th style="text-align:right">Grand Total</th>'
        + '<th style="text-align:center">Items</th>'
        + '<th></th>'
        + '</tr></thead><tbody>'
        + _grnFiltered.map(function(r, idx){
            var sc = statusColor[r.status] || 'var(--muted)';
            var sb = statusBg[r.status]    || 'var(--text-08)';
            // Build invoice cell — compact
            var invs = r.po_invoices && r.po_invoices.length ? r.po_invoices
                : (r.invoice_num ? [{po_num:r.po_num||'',invoice_num:r.invoice_num,invoice_date:r.invoice_date}] : []);
            var invCell = invs.length
                ? invs.map(function(inv){
                    return escHtml(inv.invoice_num||'—')+(inv.invoice_date?'<span style="color:var(--muted);font-size:10px"> '+fmtDate(inv.invoice_date)+'</span>':'');
                  }).join('<br>')
                : '<span class="td-dim">—</span>';
            // PO nums
            var poNums = [];
            if (r.po_num) poNums.push(r.po_num);
            if (r.po_invoices && r.po_invoices.length) {
                r.po_invoices.forEach(function(inv){ if(inv.po_num && poNums.indexOf(inv.po_num)===-1) poNums.push(inv.po_num); });
            }
            var poCell = poNums.length
                ? poNums.map(function(p){ return '<span style="font-family:var(--font-mono);font-size:11px;color:var(--teal)">'+escHtml(p)+'</span>'; }).join('<br>')
                : '<span class="td-dim">—</span>';
            return '<tr style="cursor:pointer" ondblclick="openGrnFormByIdx('+idx+')">'
                + '<td style="font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:var(--teal);white-space:nowrap">'+escHtml(r.grn_num)+'</td>'
    
                + '<td style="font-weight:600;font-size:12px">'+escHtml(r.supplier_name||'—')+'</td>'
                + '<td class="td-mono" style="white-space:nowrap;color:var(--muted)">'+fmtDate(r.grn_date||'')+'</td>'
                + '<td style="font-size:11.5px">'+poCell+'</td>'
                + '<td style="font-size:11.5px">'+invCell+'</td>'
                + '<td class="td-mono" style="text-align:right;font-weight:700">'+fi(r.grand_total)+'</td>'
                + '<td style="text-align:center;font-size:11px;color:var(--muted)">'+(r.item_count||'—')+'</td>'
                + '<td style="white-space:nowrap">'
                +   '<button class="act-btn" style="padding:4px 10px;font-size:11px;margin-right:3px" onclick="event.stopPropagation();openGrnFormByIdx('+idx+')">✎ Edit</button>'
                +   '<button class="act-btn" style="padding:4px 8px;font-size:11px;background:rgba(244,63,94,.08);border-color:rgba(244,63,94,.3);color:var(--red-text)" onclick="event.stopPropagation();grnDelete('+idx+')">✕</button>'
                + '</td>'
                + '</tr>';
        }).join('')
        + '</tbody></table></div></div>';
}

function openGrnFormByIdx(idx) {
    openGrnForm(_grnFiltered[idx]);
}

async function grnDelete(idx) {
    var r = _grnFiltered[idx];
    if (!r || !r.id) return;
    if (!confirm('Delete GRN '+r.grn_num+'?\nThis cannot be undone.')) return;
    try {
        var res = await fetch('/api/procurement/grn/delete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id: r.id})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        toast('GRN '+r.grn_num+' deleted', 'success');
        loadGrnData();
    } catch(e) { toast('Delete failed: '+e.message, 'error'); }
}

/* ═══════════════════════════════════════════════════════
   FORM — open & render
═══════════════════════════════════════════════════════ */
async function openGrnForm(row) {
    _grnEditId = row ? row.id : null;
    _grnLines  = [];
    _grnPoInvoices = [];

    var list = document.getElementById('grn-list-pane');
    var pane = document.getElementById('grn-form-pane');
    var fbody = document.getElementById('grn-form-body');

    // Inject form HTML
    fbody.innerHTML = grnFormHTML();

    // Ensure _poRows and _allRows loaded
    if (!_poRows || !_poRows.length) {
        try { var pr = await fetch('/api/procurement/po/list'); var pd = await pr.json(); if(pd.status==='ok') { _poRows = pd.orders||[]; _poFiltered = _poRows.slice(); } } catch(e) {}
    }
    if (!_allRows || !_allRows.length) {
        try { var mr = await fetch('/api/procurement/stock_summary'); var md = await mr.json(); if(md.status==='ok') _allRows = md.rows||[]; } catch(e) {}
    }

    // Populate PO dropdown
    grnPopulatePOSelect(row ? row.po_id : null);

    var today = new Date().toISOString().slice(0,10);
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.value=v||''; };

    if (row && row.id) {
        // Edit existing — fetch full data
        sv('grnFormTitle', '');
        document.getElementById('grnFormEyebrow').textContent = 'EDIT GRN';
        document.getElementById('grnFormTitle').textContent = 'Edit Goods Receipt Note';
        try {
            var res = await fetch('/api/procurement/grn/get?id='+row.id);
            var d   = await res.json();
            if (d.status !== 'ok') throw new Error(d.message);
            var o = d.grn;
            document.getElementById('grnFormNum').textContent    = o.grn_num || '—';
            sv('grnDate',        o.grn_date     || today);
            sv('grnSupplier',    o.supplier_name|| '');
            sv('grnInvoiceNum',  o.invoice_num  || '');
            sv('grnInvoiceDate', o.invoice_date || '');
            // Load multi-PO invoices
            _grnPoInvoices = o.po_invoices && o.po_invoices.length ? o.po_invoices
                : [{po_id: o.po_id||null, po_num: o.po_num||'', invoice_num: o.invoice_num||'', invoice_date: o.invoice_date||''}];
            grnRenderPoInvoices();
            sv('grnStatus',      o.status       || 'draft');
            sv('grnRemarks',     o.remarks      || '');
            grnPopulatePOSelect(o.po_id);
            // Restore charges
            grnSetCharge('freight', o.freight_charge);
            grnSetCharge('packing', o.packing_charge);
            // Load items
            _grnLines = (o.items||[]).map(function(i){
                return {
                    material:     i.material||'',
                    po_qty:       i.po_qty       != null ? parseFloat(i.po_qty)       : '',
                    received_qty: i.received_qty != null ? parseFloat(i.received_qty) : '',
                    rate:         i.rate         != null ? parseFloat(i.rate)         : '',
                    hsn_code:     i.hsn_code     || '',
                    gst_rate:     i.gst_rate     != null ? parseFloat(i.gst_rate)     : 0,
                    location:     i.location     || '',
                    invoice_num:  i.invoice_num  || '',
                    invoice_date: i.invoice_date || '',
                    batch_num:    i.batch_num    || '',
                    mfg_date:     i.mfg_date     || '',
                    expiry_date:  i.expiry_date  || ''
                };
            });
        } catch(e) { toast('Could not load GRN: '+e.message, 'error'); }
    } else {
        // New GRN
        document.getElementById('grnFormEyebrow').textContent = 'NEW GRN';
        document.getElementById('grnFormTitle').textContent   = 'New Goods Receipt Note';
        document.getElementById('grnFormNum').textContent     = 'Auto-assigned on save';
        sv('grnDate',   today);
        sv('grnStatus', 'open');
        _grnLines = [];
        _grnPoInvoices = [{po_id:null, po_num:'', invoice_num:'', invoice_date:''}];
        grnRenderPoInvoices();
    }

    if (!_grnLines.length) _grnLines.push({material:'',po_qty:'',received_qty:'',rate:'',hsn_code:'',gst_rate:0,location:'',invoice_num:'',invoice_date:'',batch_num:'',mfg_date:'',expiry_date:''});
    grnRenderLines();

    list.style.display = 'none';
    pane.style.display = 'block';
    pane.scrollTo(0,0);
}

function grnSetCharge(type, val) {
    var key = type === 'freight' ? 'Freight' : 'Packing';
    var cb  = document.getElementById('grn'+key+'Enabled');
    var inp = document.getElementById('grn'+key+'Amt');
    if (!cb || !inp) return;
    var v = val ? parseFloat(val) : 0;
    if (v > 0) {
        cb.checked = true; inp.disabled = false; inp.style.opacity = '1';
        inp.value = v.toFixed(2);
    } else {
        cb.checked = false; inp.disabled = true; inp.style.opacity = '.4'; inp.value = '';
    }
}

function grnToggleCharge(type) {
    var key = type === 'freight' ? 'Freight' : 'Packing';
    var cb  = document.getElementById('grn'+key+'Enabled');
    var inp = document.getElementById('grn'+key+'Amt');
    if (!cb || !inp) return;
    inp.disabled    = !cb.checked;
    inp.style.opacity = cb.checked ? '1' : '.4';
    if (cb.checked) { inp.focus(); } else { inp.value = ''; }
    grnCalcTotal();
}

function grnCloseForm() {
    document.getElementById('grn-form-pane').style.display = 'none';
    document.getElementById('grn-list-pane').style.display = '';
    loadGrnData();
}

/* ═══════════════════════════════════════════════════════
   PO SELECT — populate & on-change
═══════════════════════════════════════════════════════ */
function grnPopulatePOSelect(selectedPoId) {
    var sel = document.getElementById('grnPoSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Manual (no linked PO) —</option>'
        + (_poRows||[]).filter(function(r){ return r.status !== 'cancelled'; })
            .map(function(r){
                return '<option value="'+r.id+'"'+(String(r.id)===String(selectedPoId)?' selected':'')+'>'
                    +escHtml(r.po_num)+' – '+escHtml(r.supplier_name||'')+'</option>';
            }).join('');
}

function grnPoChange() {
    var sel   = document.getElementById('grnPoSelect');
    var poId  = sel ? sel.value : '';
    if (!poId) return;
    var po = (_poRows||[]).find(function(r){ return String(r.id)===String(poId); });
    if (!po) return;
    // Fill supplier
    var supEl = document.getElementById('grnSupplier');
    if (supEl) supEl.value = po.supplier_name||'';
    // Add this PO to invoice list if not already there
    var exists = _grnPoInvoices.find(function(inv){ return String(inv.po_id)===String(poId); });
    if (!exists) {
        _grnPoInvoices.push({po_id: po.id, po_num: po.po_num||'', invoice_num: '', invoice_date: ''});
        grnRenderPoInvoices();
    }
    // Fetch full PO items
    fetch('/api/procurement/po/get?id='+poId)
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status !== 'ok') throw new Error(d.message);
            var o = d.order;
            _grnLines = (o.items||[]).map(function(i){
                var mr = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(i.material||'').toLowerCase(); });
                return {
                    material:     i.material||'',
                    po_qty:       i.qty       != null ? parseFloat(i.qty)      : '',
                    received_qty: i.qty       != null ? parseFloat(i.qty)      : '',
                    rate:         i.rate      != null ? parseFloat(i.rate)     : '',
                    hsn_code:     i.hsn_code  || (mr&&mr.hsn_code||''),
                    gst_rate:     i.gst_rate  != null ? parseFloat(i.gst_rate) : (mr&&mr.gst_rate!=null?parseFloat(mr.gst_rate):0),
                    location:'', invoice_num:'', invoice_date:'', batch_num:'', mfg_date:'', expiry_date:''
                };
            });
            if (!_grnLines.length) _grnLines.push({material:'',po_qty:'',received_qty:'',rate:'',hsn_code:'',gst_rate:0,location:'',invoice_num:'',invoice_date:'',batch_num:'',mfg_date:'',expiry_date:''});
            grnRenderLines();
            grnCalcStatus();
            toast('Items loaded from '+o.po_num, 'success', 2500);
        })
        .catch(function(e){ toast('Could not load PO: '+e.message, 'error'); });
}

/* ═══════════════════════════════════════════════════════
   PO TABLE — PO Number + PO Date only (no invoice fields)
═══════════════════════════════════════════════════════ */
function grnRenderPoInvoices() {
    var container = document.getElementById('grnPoInvoicesContainer');
    if (!container) return;
    if (!_grnPoInvoices.length) {
        container.innerHTML = '<div style="font-size:11.5px;color:var(--muted);padding:8px 12px">No PO linked — select a PO above or add manually.</div>';
        return;
    }
    var MONO = 'height:30px;padding:0 8px;border-radius:5px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);font-size:12px;outline:none;width:100%';
    var DATE = 'height:30px;padding:0 8px;border-radius:5px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-body);font-size:12px;outline:none;width:100%';

    container.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">'
        + '<thead><tr style="background:var(--surface2)">'
        + '<th style="padding:6px 10px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">PO Number</th>'
        + '<th style="padding:6px 10px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;width:180px">PO Date</th>'
        + '<th style="width:32px"></th>'
        + '</tr></thead><tbody>'
        + _grnPoInvoices.map(function(inv, i){
            // Look up PO date from _poRows cache
            var po = (_poRows||[]).find(function(r){ return String(r.id)===String(inv.po_id); });
            var poDate = po ? (po.po_date||'') : (inv.po_date||'');
            var isLinked = !!inv.po_id; // linked from PO selection — read-only

            var poNumCell = isLinked
                ? '<span style="font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:var(--teal)">'+escHtml(inv.po_num||'')+'</span>'
                : '<input type="text" class="grn-inv-inp" data-inv-idx="'+i+'" data-inv-field="po_num"'
                +   ' value="'+escHtml(inv.po_num||'')+'" placeholder="PO Number (manual)"'
                +   ' style="'+MONO+'" oninput="grnInvFieldChange('+i+',\'po_num\',this.value)">';

            var poDateCell = isLinked
                ? '<span style="font-size:12px;color:var(--muted)">'+fmtDate(poDate)+'</span>'
                : '<input type="date" class="grn-inv-inp" data-inv-idx="'+i+'" data-inv-field="po_date"'
                +   ' value="'+escHtml(poDate)+'"'
                +   ' style="'+DATE+'" onchange="grnInvFieldChange('+i+',\'po_date\',this.value)">';

            var canRemove = !isLinked || _grnPoInvoices.length > 1;
            return '<tr style="border-bottom:1px solid var(--border)">'
                + '<td style="padding:5px 8px">'+poNumCell+'</td>'
                + '<td style="padding:5px 8px">'+poDateCell+'</td>'
                + '<td style="padding:4px 6px;text-align:center">'
                +   (canRemove ? '<button onclick="grnRemoveInvoice('+i+')" style="width:22px;height:22px;border-radius:5px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);cursor:pointer;font-size:14px;line-height:1">×</button>' : '')
                + '</td>'
                + '</tr>';
        }).join('')
        + '</tbody></table>'
        + (!_grnPoInvoices.some(function(inv){ return !inv.po_id; })
            ? '' // hide "Add manual" if all rows are linked from PO
            : '<button onclick="grnAddManualInvoice()" style="margin-top:8px;height:26px;padding:0 12px;border-radius:6px;border:1px dashed var(--border2);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px">'
              + '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
              + ' Add another PO row</button>'
          );
}

function grnInvFieldChange(idx, field, val) {
    if (_grnPoInvoices[idx]) _grnPoInvoices[idx][field] = val;
}

function grnRemoveInvoice(idx) {
    _grnPoInvoices.splice(idx, 1);
    grnRenderPoInvoices();
}

function grnAddManualInvoice() {
    _grnPoInvoices.push({po_id: null, po_num: '', po_date: '', invoice_num: '', invoice_date: ''});
    grnRenderPoInvoices();
    setTimeout(function(){
        var inputs = document.querySelectorAll('.grn-inv-inp[data-inv-field="po_num"]');
        if (inputs.length) inputs[inputs.length-1].focus();
    }, 40);
}


function grnRenderLines() {
    var tb = document.getElementById('grnLinesTbody');
    if (!tb) return;
    var IS  = 'width:100%;height:30px;padding:0 6px;border-radius:5px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-body);outline:none;font-size:11px';
    var MS  = IS+';font-family:var(--font-mono);text-align:right';
    var RO  = IS+';background:var(--surface3,var(--surface2));color:var(--muted2);opacity:.7';
    // locOpts built per-line to handle selected state
    if (!_grnLines.length) {
        tb.innerHTML = '<tr><td colspan="13" style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No items — select a PO above or click "+ Add Item"</td></tr>';
        grnCalcTotal(); return;
    }
    tb.innerHTML = _grnLines.map(function(line, i){
        var amt = (parseFloat(line.received_qty)||0)*(parseFloat(line.rate)||0);
        var amtStr = amt>0?'₹ '+amt.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
        var gstPct = line.gst_rate!=null?parseFloat(line.gst_rate):0;
        if (!gstPct&&line.material&&_allRows&&_allRows.length){var mr=_allRows.find(function(r){return(r.material_name||'').toLowerCase()===line.material.toLowerCase();});if(mr&&mr.gst_rate!=null)gstPct=parseFloat(mr.gst_rate);}
        var isPO=line.po_qty!=='';
        var _defGodown = (_gdGodowns||[]).find(function(g){ return g.is_default; }) || (_gdGodowns||[])[0] || null;
        var _defGodownName = (_defGodown && _defGodown.name) ? _defGodown.name : '';
        var locSel='<option value="">— Location —</option>'+(_gdGodowns||[]).map(function(g){
            var isSel = (line.location && line.location===g.name) || (!line.location && g.name===_defGodownName);
            return '<option value="'+escHtml(g.name)+'"'+(isSel?' selected':'')+'>'+escHtml(g.name)+'</option>';
        }).join('');
        var bg=i%2?'var(--surface2)':'var(--surface)';
        return '<tr data-gi="'+i+'" style="border-bottom:1px solid var(--border);background:'+bg+';">'
            +'<td style="padding:5px 4px;color:var(--muted);font-size:10px;width:20px;text-align:center;vertical-align:top;padding-top:8px">'+(i+1)+'</td>'
            +'<td style="padding:3px 4px;min-width:160px;vertical-align:top"><input class="grn-li-inp grn-mat-inp" data-gi="'+i+'" value="'+escHtml(line.material||'')+'" placeholder="Material…" '+(isPO?'readonly ':'')+'style="'+(isPO?RO:IS)+'"></td>'
            +'<td style="padding:3px 4px;width:75px;vertical-align:top"><input type="number" class="grn-li-inp grn-poqty-inp" data-gi="'+i+'" value="'+(line.po_qty||'')+'" readonly style="'+MS+';opacity:.5" tabindex="-1"></td>'
            +'<td style="padding:3px 4px;width:85px;vertical-align:top"><input type="number" class="grn-li-inp grn-rqty-inp grn-calc" data-gi="'+i+'" value="'+(line.received_qty||'')+'" placeholder="0.000" min="0" step="0.001" style="'+MS+'"></td>'
            +'<td style="padding:3px 4px;width:90px;vertical-align:top"><input type="number" class="grn-li-inp grn-rate-inp" data-gi="'+i+'" value="'+(line.rate||'')+'" readonly tabindex="-1" style="'+MS+';opacity:.65" title="Set in PO"></td>'
            +'<td style="padding:5px 5px;text-align:center;width:45px;font-family:var(--font-mono);font-size:10.5px;color:'+(gstPct>0?'var(--text)':'var(--muted)')+';vertical-align:top;padding-top:8px">'+(gstPct>0?gstPct+'%':'—')+'</td>'
            +'<td class="grn-amt-cell" style="padding:5px 6px;text-align:right;font-family:var(--font-mono);font-size:11.5px;font-weight:700;color:'+(amt>0?'var(--text)':'var(--muted)')+';white-space:nowrap;vertical-align:top;padding-top:8px">'+amtStr+'</td>'
            +'<td style="padding:3px 4px;width:130px;vertical-align:top"><select class="grn-li-inp grn-loc-inp" data-gi="'+i+'" style="'+IS+'">'+locSel+'</select></td>'
            +'<td style="padding:3px 4px;width:100px;vertical-align:top"><input type="text" class="grn-li-inp grn-invnum-inp" data-gi="'+i+'" value="'+escHtml(line.invoice_num||'')+'" placeholder="INV#" style="'+IS+';font-family:var(--font-mono)"></td>'
            +'<td style="padding:3px 4px;width:112px;vertical-align:top"><input type="date" class="grn-li-inp grn-invdate-inp" data-gi="'+i+'" value="'+escHtml(line.invoice_date||'')+'" style="'+IS+'"></td>'
            +'<td style="padding:3px 4px;width:90px;vertical-align:top"><input type="text" class="grn-li-inp grn-batch-inp" data-gi="'+i+'" value="'+escHtml(line.batch_num||'')+'" placeholder="Batch#" style="'+IS+';font-family:var(--font-mono)"></td>'
            +'<td style="padding:3px 4px;width:112px;vertical-align:top"><input type="date" class="grn-li-inp grn-mfg-inp" data-gi="'+i+'" value="'+escHtml(line.mfg_date||'')+'" style="'+IS+'"></td>'
            +'<td style="padding:3px 4px;width:112px;vertical-align:top"><input type="date" class="grn-li-inp grn-exp-inp" data-gi="'+i+'" value="'+escHtml(line.expiry_date||'')+'" style="'+IS+'"></td>'
            +'<td style="padding:3px 4px;text-align:center;width:24px;vertical-align:top;padding-top:6px"><button class="grn-li-del" data-gi="'+i+'" style="width:20px;height:20px;border-radius:4px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);cursor:pointer;font-size:13px;line-height:1">×</button></td>'
            +'</tr>';
    }).join('');
    grnCalcTotal();
    grnUpdateCount();
}


function grnCalcTotal() {
    var taxable = 0, cgstTotal = 0, sgstTotal = 0;
    _grnLines.forEach(function(l){
        var amt = (parseFloat(l.received_qty)||0)*(parseFloat(l.rate)||0);
        taxable += amt;
        if (amt > 0) {
            var mr     = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(l.material||'').toLowerCase(); });
            var gstPct = l.gst_rate != null && parseFloat(l.gst_rate) > 0 ? parseFloat(l.gst_rate)
                       : (mr && mr.gst_rate != null ? parseFloat(mr.gst_rate) : 0);
            if (gstPct > 0) { var cgst = Math.round(amt*(gstPct/2)/100*100)/100; cgstTotal += cgst; sgstTotal += cgst; }
        }
    });
    var fe = document.getElementById('grnFreightAmt');
    var pe = document.getElementById('grnPackingAmt');
    var freight = (fe && !fe.disabled) ? (parseFloat(fe.value)||0) : 0;
    var packing = (pe && !pe.disabled) ? (parseFloat(pe.value)||0) : 0;
    taxable += freight + packing;
    var grand = taxable + cgstTotal + sgstTotal;
    var fi = function(n){ return '₹ '+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.textContent=v; };
    var sd = function(id,show){ var e=document.getElementById(id); if(e) e.style.display=show?'':'none'; };
    sv('grnFootTaxable',  taxable>0    ? fi(taxable)    : '—');
    sv('grnFootCGST',     cgstTotal>0  ? fi(cgstTotal)  : '—');
    sv('grnFootSGST',     sgstTotal>0  ? fi(sgstTotal)  : '—');
    sv('grnGrandTotal',   grand>0      ? fi(grand)       : '—');
    sd('grnFootRowCGST',  cgstTotal>0);
    sd('grnFootRowSGST',  sgstTotal>0);
    grnCalcStatus();
}

/* Auto-calculate status from received vs PO quantities:
   - cancelled : linked PO is cancelled
   - open      : no received_qty > 0 for any item
   - received  : every item with po_qty has received_qty >= po_qty
   - partial   : some received but not all full
*/
function grnCalcStatus() {
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    var status = 'open';

    // Check if linked PO is cancelled
    var sel = document.getElementById('grnPoSelect');
    if (sel && sel.value) {
        var po = (_poRows||[]).find(function(r){ return String(r.id)===String(sel.value); });
        if (po && po.status === 'cancelled') { status = 'cancelled'; }
    }

    if (status !== 'cancelled' && validLines.length) {
        var anyReceived = validLines.some(function(l){ return parseFloat(l.received_qty||0) > 0; });
        if (!anyReceived) {
            status = 'open';
        } else {
            // Check if all items fully received
            var allFull = validLines.every(function(l){
                var rqty = parseFloat(l.received_qty||0);
                var pqty = parseFloat(l.po_qty||0);
                // If no po_qty reference (manual GRN), treat as full if received > 0
                if (!pqty) return rqty > 0;
                return rqty >= pqty - 0.001; // small tolerance for float
            });
            status = allFull ? 'received' : 'partial';
        }
    }

    // Update both status badges
    var colors = {
        open:      {bg:'rgba(14,165,233,.12)',  color:'#0284c7'},
        received:  {bg:'var(--green-bg)',        color:'var(--green-text)'},
        partial:   {bg:'rgba(245,158,11,.12)',   color:'var(--amber-text)'},
        cancelled: {bg:'var(--text-08)',         color:'var(--muted)'}
    };
    var c = colors[status] || colors.open;
    ['grnStatusBadge','grnStatusBadgeBottom'].forEach(function(id){
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = status.toUpperCase();
        el.style.background = c.bg;
        el.style.color = c.color;
    });
    window._grnAutoStatus = status;
}

function grnUpdateCount() {
    var el = document.getElementById('grnLineCount');
    if (el) el.textContent = _grnLines.length + ' item' + (_grnLines.length!==1?'s':'');
}

function grnAddLine() {
    _grnLines.push({material:'',po_qty:'',received_qty:'',rate:'',hsn_code:'',gst_rate:0,
                    location:'',invoice_num:'',invoice_date:'',batch_num:'',mfg_date:'',expiry_date:''});
    grnRenderLines();
    var idx = _grnLines.length - 1;
    setTimeout(function(){
        var inp = document.querySelector('#grnLinesTbody tr[data-gi="'+idx+'"] .grn-mat-inp');
        if (inp) inp.focus();
    }, 40);
}

// Input delegation for line items
document.addEventListener('input', function(e){
    var inp = e.target;
    if (!inp.classList.contains('grn-li-inp')) return;
    var idx = parseInt(inp.dataset.gi);
    if (isNaN(idx)) return;
    if (inp.classList.contains('grn-mat-inp'))     _grnLines[idx].material     = inp.value;
    if (inp.classList.contains('grn-rqty-inp'))    _grnLines[idx].received_qty = inp.value;
    if (inp.classList.contains('grn-invnum-inp'))  _grnLines[idx].invoice_num  = inp.value;
    if (inp.classList.contains('grn-batch-inp'))   _grnLines[idx].batch_num    = inp.value;
    if (inp.classList.contains('grn-calc')) {
        var qty = parseFloat(_grnLines[idx].received_qty)||0;
        var rt  = parseFloat(_grnLines[idx].rate)||0;
        var amt = qty * rt;
        var aCell = document.querySelector('#grnLinesTbody tr[data-gi="'+idx+'"] .grn-amt-cell');
        if (aCell) {
            aCell.textContent = amt > 0 ? '₹ '+amt.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
            aCell.style.color = amt > 0 ? 'var(--text)' : 'var(--muted)';
        }
        grnCalcTotal();
    }
});
document.addEventListener('change', function(e){
    var inp = e.target;
    if (!inp.classList.contains('grn-li-inp')) return;
    var idx = parseInt(inp.dataset.gi);
    if (isNaN(idx)) return;
    if (inp.classList.contains('grn-loc-inp'))     _grnLines[idx].location     = inp.value;
    if (inp.classList.contains('grn-invdate-inp')) _grnLines[idx].invoice_date = inp.value;
    if (inp.classList.contains('grn-mfg-inp'))     _grnLines[idx].mfg_date     = inp.value;
    if (inp.classList.contains('grn-exp-inp'))     _grnLines[idx].expiry_date  = inp.value;
});

// Delete line button delegation
document.addEventListener('click', function(e){
    var btn = e.target.closest('.grn-li-del');
    if (!btn) return;
    var idx = parseInt(btn.dataset.gi);
    if (isNaN(idx)) return;
    _grnLines.splice(idx, 1);
    if (!_grnLines.length) _grnLines.push({material:'',po_qty:'',received_qty:'',rate:'',hsn_code:'',gst_rate:0,location:'',invoice_num:'',invoice_date:'',batch_num:'',mfg_date:'',expiry_date:''});
    grnRenderLines();
});

/* ═══════════════════════════════════════════════════════
   SAVE
═══════════════════════════════════════════════════════ */
async function saveGrn() {
    var supplier = (document.getElementById('grnSupplier').value||'').trim();
    if (!supplier) { toast('Supplier name is required', 'error'); return; }
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    if (!validLines.length) { toast('Add at least one line item', 'error'); return; }

    var fe = document.getElementById('grnFreightAmt');
    var pe = document.getElementById('grnPackingAmt');
    var sel = document.getElementById('grnPoSelect');

    var payload = {
        id:             _grnEditId || null,
        supplier_name:  supplier,
        grn_date:       document.getElementById('grnDate').value        || '',
        invoice_num:    (_grnPoInvoices.length===1 ? (_grnPoInvoices[0].invoice_num||'') : ''),
        invoice_date:   (_grnPoInvoices.length===1 ? (_grnPoInvoices[0].invoice_date||'') : ''),
        po_invoices:    _grnPoInvoices.filter(function(inv){ return inv.po_id || inv.invoice_num || inv.po_num; }),
        po_id:          sel && sel.value ? parseInt(sel.value) : (_grnPoInvoices.length===1&&_grnPoInvoices[0].po_id?_grnPoInvoices[0].po_id:null),
        po_num:         (function(){ if(sel&&sel.value){ var po=(_poRows||[]).find(function(r){ return String(r.id)===String(sel.value); }); return po?po.po_num:''; } return _grnPoInvoices.length===1?(_grnPoInvoices[0].po_num||''):''; })(),
        status:         window._grnAutoStatus || 'open',
        remarks:        document.getElementById('grnRemarks').value     || '',
        unload_location: (function(){
            var defGd = (_gdGodowns||[]).find(function(g){ return g.is_default; }) || (_gdGodowns||[])[0];
            return defGd ? defGd.name : '';
        })(),
        freight_charge: (fe && !fe.disabled && fe.value) ? parseFloat(fe.value)||null : null,
        packing_charge: (pe && !pe.disabled && pe.value) ? parseFloat(pe.value)||null : null,
        items: validLines.map(function(l){
            var defGd2 = (_gdGodowns||[]).find(function(g){ return g.is_default; }) || (_gdGodowns||[])[0];
            var defLoc = defGd2 ? defGd2.name : '';
            return {
                material:     l.material.trim(),
                po_qty:       parseFloat(l.po_qty)||0,
                received_qty: parseFloat(l.received_qty)||0,
                rate:         parseFloat(l.rate)||0,
                hsn_code:     l.hsn_code||'',
                gst_rate:     l.gst_rate||0,
                location:     l.location || defLoc,
                invoice_num:  l.invoice_num||'',
                invoice_date: l.invoice_date||'',
                batch_num:    l.batch_num||'',
                mfg_date:     l.mfg_date||'',
                expiry_date:  l.expiry_date||''
            };
        })
    };

    var btn = document.getElementById('grnSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        var res = await fetch('/api/procurement/grn/save', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message||'Save failed');
        // Patch PO cache with updated statuses so list reflects immediately
        if (d.po_statuses && _poRows && _poRows.length) {
            Object.keys(d.po_statuses).forEach(function(pid){
                var po = _poRows.find(function(r){ return String(r.id)===String(pid); });
                if (po) po.status = d.po_statuses[pid];
            });
            // Re-render PO list if it's visible
            if (typeof poApplyFilters === 'function') poApplyFilters();
        }
        if (!_grnEditId) {
            toast('✅ GRN Saved — '+d.grn_num, 'success', 5000);
        } else {
            toast('GRN updated', 'success');
        }
        grnCloseForm();
    } catch(e) {
        toast('Save failed: '+e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Save GRN'; }
    }
}

/* ═══════════════════════════════════════════════════════
   FORM HTML (injected)
═══════════════════════════════════════════════════════ */
function grnFormHTML() {
    return `
    <div style="background:var(--surface);min-height:100%">
        <!-- Form header bar — Back + title + Delete only (no Save here) -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:var(--surface2);border-bottom:1px solid var(--border2);position:sticky;top:0;z-index:50">
            <div style="display:flex;align-items:center;gap:14px">
                <button onclick="grnCloseForm()" style="height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                    Back to GRN List
                </button>
                <div>
                    <div id="grnFormEyebrow" style="font-size:9px;font-weight:800;color:var(--teal);text-transform:uppercase;letter-spacing:.8px">NEW GRN</div>
                    <div id="grnFormTitle" style="font-size:17px;font-weight:800;color:var(--text)">New Goods Receipt Note</div>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <button id="grnDeleteBtn" onclick="grnDeleteCurrent()" style="display:${_grnEditId?'inline-flex':'none'};height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);align-items:center;gap:6px">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Delete GRN
                </button>
                <button onclick="grnPrint()" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    Preview &amp; Print
                </button>
                <button onclick="grnPrintWithPOs()" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px" title="Print GRN + linked POs together">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    GRN + PO(s)
                </button>
            </div>
        </div>

        <!-- GRN Header Card -->
        <div class="form-card" style="margin:14px 16px 0;border-radius:10px">
            <div class="form-card-head">
                <div class="form-card-head-title">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
                    GRN DETAILS
                </div>
                <span class="form-card-badge">GRN No: <span id="grnFormNum" style="font-family:var(--font-mono);letter-spacing:.5px">Auto-assigned on save</span></span>
            </div>
            <div class="form-card-body" style="padding:12px 14px">
                <div style="display:grid;grid-template-columns:160px 1fr;gap:12px;margin-bottom:10px">
                    <div class="form-group">
                        <label class="form-label">GRN Date</label>
                        <input class="form-input-styled" type="date" id="grnDate">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Supplier Name <span class="req">*</span> <span style="font-weight:400;font-size:9px;color:var(--muted)">(auto-filled from PO)</span></label>
                        <input class="form-input-styled" type="text" id="grnSupplier" placeholder="Supplier name…" list="grnSupplierList">
                        <datalist id="grnSupplierList">${(_supRows||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('')}</datalist>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:200px 1fr;gap:12px;margin-bottom:10px">
                    <div class="form-group">
                        <label class="form-label">Link to PO</label>
                        <select class="form-input-styled" id="grnPoSelect" onchange="grnPoChange()">
                            <option value="">— Manual —</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Remarks</label>
                        <input class="form-input-styled" type="text" id="grnRemarks" placeholder="Any notes…">
                    </div>
                </div>
                <!-- Per-PO Table -->
                <div class="form-sec-label" style="margin-bottom:6px">Linked PO Details
                    <span style="font-weight:400;font-size:9px;color:var(--muted);text-transform:none;letter-spacing:0;margin-left:6px">— auto-filled from PO selection · add manually if needed</span>
                </div>
                <div id="grnPoInvoicesContainer" style="border:1px solid var(--border2);border-radius:8px;overflow:hidden;margin-bottom:4px">
                    <div style="padding:10px;color:var(--muted);font-size:12px">Loading…</div>
                </div>
                <button onclick="grnAddManualInvoice()" id="grnAddPORowBtn" style="margin-top:4px;height:26px;padding:0 12px;border-radius:6px;border:1px dashed var(--border2);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    + Add another PO row
                </button>
            </div>
        </div>

        <!-- Line Items Card -->
        <div class="form-card" style="margin:10px 16px 0;border-radius:10px">
            <div class="form-card-head">
                <div class="form-card-head-title">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                    LINE ITEMS
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                    <span id="grnLineCount" style="font-size:10px;color:rgba(255,255,255,.7)">0 items</span>
                    <button onclick="grnAddLine()" style="height:26px;padding:0 12px;border-radius:6px;border:none;background:#fff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        + Add Item
                    </button>
                </div>
            </div>
            <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12.5px">
                    <thead>
                        <tr style="background:var(--surface2);border-bottom:1px solid var(--border2)">
                            <th style="padding:7px 4px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:20px">#</th>
                            <th style="padding:7px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Material *</th>
                            <th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:75px">PO Qty</th>
                            <th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:85px">Recd Qty</th>
                            <th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:90px">Rate (₹)</th>
                            <th style="padding:7px 4px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:45px">GST</th>
                            <th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:110px">Amount</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:130px">Location</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:100px">Invoice No.</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:112px">Inv. Date</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:90px">Batch No.</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:112px">Mfg Date</th>
                            <th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:112px">Expiry</th>
                            <th style="padding:7px 4px;width:24px"></th>
                        </tr>
                    </thead>
                    <tbody id="grnLinesTbody">
                        <tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No items — select a PO above or click "+ Add Item"</td></tr>
                    </tbody>
                    <tfoot>
                        <tr style="border-top:1px solid var(--border)">
                            <td colspan="14" style="padding:5px 10px">
                                <button onclick="grnAddLine()" style="height:26px;padding:0 12px;border-radius:6px;border:1px dashed var(--border2);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px"
                                    onmouseover="this.style.borderColor='#2563eb';this.style.color='#2563eb'"
                                    onmouseout="this.style.borderColor='';this.style.color=''">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    Add another item
                                </button>
                            </td>
                        </tr>
                        <!-- Freight -->
                        <tr style="border-top:1px solid var(--border);background:var(--surface)">
                            <td colspan="5" style="padding:5px 14px;text-align:right;font-size:10.5px;color:var(--muted)">
                                <label style="display:flex;align-items:center;gap:6px;justify-content:flex-end;cursor:pointer">
                                    <input type="checkbox" id="grnFreightEnabled" onchange="grnToggleCharge('freight')" style="cursor:pointer">
                                    <span style="font-weight:600">Freight Charges (₹)</span>
                                </label>
                            </td>
                            <td style="padding:4px 8px;text-align:center;color:var(--muted)">—</td>
                            <td style="padding:4px 8px">
                                <input type="number" id="grnFreightAmt" min="0" step="0.01" placeholder="0.00" disabled
                                    onchange="grnCalcTotal()" oninput="grnCalcTotal()"
                                    style="width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);text-align:right;font-size:12.5px;opacity:.4">
                            </td>
                            <td></td>
                        </tr>
                        <!-- Packing -->
                        <tr style="background:var(--surface)">
                            <td colspan="5" style="padding:5px 14px;text-align:right;font-size:10.5px;color:var(--muted)">
                                <label style="display:flex;align-items:center;gap:6px;justify-content:flex-end;cursor:pointer">
                                    <input type="checkbox" id="grnPackingEnabled" onchange="grnToggleCharge('packing')" style="cursor:pointer">
                                    <span style="font-weight:600">Packing Charges (₹)</span>
                                </label>
                            </td>
                            <td style="padding:4px 8px;text-align:center;color:var(--muted)">—</td>
                            <td style="padding:4px 8px">
                                <input type="number" id="grnPackingAmt" min="0" step="0.01" placeholder="0.00" disabled
                                    onchange="grnCalcTotal()" oninput="grnCalcTotal()"
                                    style="width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);text-align:right;font-size:12.5px;opacity:.4">
                            </td>
                            <td></td>
                        </tr>
                        <!-- Taxable -->
                        <tr style="border-top:1px solid var(--border);background:var(--surface2)">
                            <td colspan="12" style="padding:7px 14px;font-size:10.5px;font-weight:600;color:var(--muted);text-align:right">Taxable Amount</td>
                            <td id="grnFootTaxable" style="padding:7px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">—</td>
                            <td></td>
                        </tr>
                        <tr id="grnFootRowCGST" style="display:none;background:var(--surface2)">
                            <td colspan="12" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">CGST</td>
                            <td id="grnFootCGST" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">—</td>
                            <td></td>
                        </tr>
                        <tr id="grnFootRowSGST" style="display:none;background:var(--surface2)">
                            <td colspan="12" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">SGST</td>
                            <td id="grnFootSGST" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">—</td>
                            <td></td>
                        </tr>
                        <tr style="border-top:2px solid var(--border2);background:var(--surface2)">
                            <td colspan="12" style="padding:12px 14px;font-size:11px;font-weight:800;color:var(--text);text-align:right;text-transform:uppercase;letter-spacing:.5px">Grand Total</td>
                            <td id="grnGrandTotal" style="padding:12px 14px;text-align:right;font-weight:800;font-size:16px;color:var(--text);font-family:var(--font-mono)">—</td>
                            <td></td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>

        <!-- Save bar — always visible at bottom -->
        <div style="position:sticky;bottom:0;background:var(--surface2);border-top:1px solid var(--border2);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:50;margin-top:10px">
            <div style="display:flex;gap:10px;align-items:center">
                <button onclick="grnCloseForm()" style="height:36px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">
                    Cancel
                </button>
                <button onclick="grnPrint()" style="height:36px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    Print GRN
                </button>
                <button onclick="grnPrintWithPOs()" style="height:36px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px" title="Print GRN + all linked Purchase Orders">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    GRN + PO(s)
                </button>
                <button id="grnSaveBtn" onclick="saveGrn()" style="height:36px;padding:0 24px;border-radius:7px;border:none;background:#1d4ed8;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:8px">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                    Save GRN
                </button>
            </div>
        </div>
    </div>`;
}

async function grnDeleteCurrent() {
    if (!_grnEditId) return;
    var grn = _grnRows.find(function(r){ return r.id === _grnEditId; });
    if (!confirm('Delete GRN '+(grn?grn.grn_num:'this GRN')+'?\nThis cannot be undone.')) return;
    try {
        var res = await fetch('/api/procurement/grn/delete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id: _grnEditId})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        toast('GRN deleted', 'success');
        grnCloseForm();
    } catch(e) { toast('Delete failed: '+e.message, 'error'); }
}

/* Also expose openGrnFormByIdx for dblclick on list rows */
window.openGrnFormByIdx = openGrnFormByIdx;

/* ═══════════════════════════════════════════════════════
   Open GRN form pre-filled from PO selection
═══════════════════════════════════════════════════════ */
async function openGrnFormWithData(data) {
    _grnEditId = null;
    _grnLines  = data.items || [];
    // Build invoice rows — one per selected PO
    var selPoIds = data._selectedPoIds || (data.po_id ? [data.po_id] : []);
    _grnPoInvoices = selPoIds.map(function(pid){
        var po = (_poRows||[]).find(function(r){ return String(r.id)===String(pid); });
        return {po_id: pid, po_num: po?po.po_num:'', invoice_num: '', invoice_date: ''};
    });
    if (!_grnPoInvoices.length) _grnPoInvoices = [{po_id:null, po_num:'', invoice_num:'', invoice_date:''}];

    var list  = document.getElementById('grn-list-pane');
    var pane  = document.getElementById('grn-form-pane');
    var fbody = document.getElementById('grn-form-body');

    fbody.innerHTML = grnFormHTML();

    // Ensure lists loaded
    if (!_allRows || !_allRows.length) {
        try { var mr = await fetch('/api/procurement/stock_summary'); var md = await mr.json(); if(md.status==='ok') _allRows = md.rows||[]; } catch(e) {}
    }
    if (!_poRows || !_poRows.length) {
        try { var pr = await fetch('/api/procurement/po/list'); var pd = await pr.json(); if(pd.status==='ok') { _poRows=pd.orders||[]; } } catch(e) {}
    }

    grnPopulatePOSelect(data.po_id || null);

    var today = new Date().toISOString().slice(0,10);
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.value=v||''; };

    document.getElementById('grnFormEyebrow').textContent = 'NEW GRN';
    document.getElementById('grnFormTitle').textContent   = 'New Goods Receipt Note';
    document.getElementById('grnFormNum').textContent     = 'Auto-assigned on save';
    sv('grnDate',     today);
    sv('grnSupplier', data.supplier_name || '');
    sv('grnStatus',   'draft');

    // Show info note if multiple POs merged
    if (data._selectedPoIds && data._selectedPoIds.length > 1) {
        var noteEl = document.createElement('div');
        noteEl.style.cssText = 'margin:10px 16px 0;padding:10px 14px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);border-radius:8px;font-size:12px;color:#059669;font-weight:600';
        noteEl.innerHTML = '✅ Items merged from <strong>'+data._selectedPoIds.length+' POs</strong>. Received qty defaults to PO qty — adjust as needed.';
        var formBody = document.getElementById('grn-form-body');
        if (formBody) formBody.insertAdjacentElement('afterbegin', noteEl);
    }

    if (!_grnLines.length) _grnLines.push({material:'',po_qty:'',received_qty:'',rate:'',hsn_code:'',gst_rate:0,location:'',invoice_num:'',invoice_date:'',batch_num:'',mfg_date:'',expiry_date:''});
    grnRenderPoInvoices();
    grnRenderLines();

    list.style.display = 'none';
    pane.style.display = 'block';
    pane.scrollTo(0,0);
}

/* ═══════════════════════════════════════════════════════
   GRN PRINT
═══════════════════════════════════════════════════════ */
function grnPrint() {
    var html = _grnBuildPrintHTML();
    if (!html) return;
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.onload = function(){ win.focus(); win.print(); };
}

function _grnBuildPrintHTML() {
    var gv  = function(id){ var e=document.getElementById(id); return e?e.value||'':''; };
    var gvt = function(id){ var e=document.getElementById(id); return e?e.textContent||'':''; };

    // DD/MMM/YYYY formatter
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var fd = function(d){ if(!d)return '—'; var p=String(d).split('-'); if(p.length<3)return d; return p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]; };

    var grn_num  = gvt('grnFormNum').trim() || '—';
    var grn_date = gv('grnDate');
    var supplier = gv('grnSupplier').trim() || '—';
    var remarks  = gv('grnRemarks').trim();

    var fe = document.getElementById('grnFreightAmt');
    var pe = document.getElementById('grnPackingAmt');
    var freightVal = (fe && !fe.disabled && fe.value) ? parseFloat(fe.value)||0 : 0;
    var packingVal = (pe && !pe.disabled && pe.value) ? parseFloat(pe.value)||0 : 0;

    // PO-level invoices (header invoices table)
    var poInvoices = (_grnPoInvoices||[]).filter(function(inv){ return inv.invoice_num||inv.po_num; });

    // Supplier details
    var sup = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase()===supplier.toLowerCase(); }) || {};

    // Line items
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    if (!validLines.length) { toast('No items to print','error'); return null; }

    var total = 0, cgstTotal = 0, sgstTotal = 0;
    var lineData = validLines.map(function(l){
        var rqty = parseFloat(l.received_qty)||0;
        var pqty = parseFloat(l.po_qty)||0;
        var rate = parseFloat(l.rate)||0;
        var amt  = rqty * rate;
        total += amt;
        var mr     = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(l.material||'').toLowerCase(); });
        var gstPct = l.gst_rate!=null&&parseFloat(l.gst_rate)>0 ? parseFloat(l.gst_rate) : (mr&&mr.gst_rate!=null?parseFloat(mr.gst_rate):0);
        var cgst   = (gstPct>0&&amt>0) ? Math.round(amt*(gstPct/2)/100*100)/100 : 0;
        return {
            material:     l.material,
            rqty: rqty, pqty: pqty, rate: rate, amt: amt,
            gstPct: gstPct, cgst: cgst, sgst: cgst,
            hsnCode:     l.hsn_code || (mr&&mr.hsn_code||''),
            location:     l.location||'',
            invoice_num:  l.invoice_num||'',
            invoice_date: l.invoice_date||'',
            batch_num:    l.batch_num||'',
            mfg_date:     l.mfg_date||'',
            expiry_date:  l.expiry_date||''
        };
    });
    cgstTotal = lineData.reduce(function(s,r){return s+r.cgst;},0);
    sgstTotal = cgstTotal;
    var taxable    = total + freightVal + packingVal;
    var grandTotal = taxable + cgstTotal + sgstTotal;

    var fi = function(n){ return '\u20b9'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var esc = escHtml;

    // Amount in words
    function numToWords(n){
        if(!n||n===0)return'Zero';
        var ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
        var tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
        function h(n){if(n<20)return ones[n];if(n<100)return tens[Math.floor(n/10)]+(ones[n%10]?' '+ones[n%10]:'');return ones[Math.floor(n/100)]+' Hundred'+(n%100?' '+h(n%100):'');}
        n=Math.round(n);
        if(n>=10000000)return h(Math.floor(n/10000000))+' Crore'+(n%10000000?' '+numToWords(n%10000000):'');
        if(n>=100000) return h(Math.floor(n/100000))+' Lakh'+(n%100000?' '+numToWords(n%100000):'');
        if(n>=1000)   return h(Math.floor(n/1000))+' Thousand'+(n%1000?' '+numToWords(n%1000):'');
        return h(n);
    }
    var grandWords = 'INR '+numToWords(Math.floor(grandTotal))+' Only';

    // Item rows — with per-item invoice, batch, location
    var itemRows = lineData.map(function(r, i){
        var fRqty = r.rqty>0?r.rqty.toLocaleString('en-IN',{minimumFractionDigits:3,maximumFractionDigits:3})+' Kgs':'—';
        var fPqty = r.pqty>0?r.pqty.toLocaleString('en-IN',{minimumFractionDigits:3,maximumFractionDigits:3})+' Kgs':'—';
        // Sub-info line under material name
        var sub = [];
        if (r.hsnCode)     sub.push('HSN: '+esc(r.hsnCode));
        if (r.invoice_num) sub.push('Inv: <strong>'+esc(r.invoice_num)+'</strong>'+(r.invoice_date?' ('+fd(r.invoice_date)+')':''));
        if (r.batch_num)   sub.push('Batch: <strong>'+esc(r.batch_num)+'</strong>');
        if (r.mfg_date)    sub.push('Mfg: '+fd(r.mfg_date));
        if (r.expiry_date) sub.push('Exp: '+fd(r.expiry_date));
        if (r.location)    sub.push('📍 '+esc(r.location));
        var subLine = sub.length ? '<br><span style="font-size:8.5px;color:#555">'+sub.join(' &nbsp;|&nbsp; ')+'</span>' : '';
        return '<tr class="item-row">'
            +'<td class="ctr">'+(i+1)+'</td>'
            +'<td class="tl"><strong>'+esc(r.material)+'</strong>'+subLine+'</td>'
            +'<td class="rr">'+fPqty+'</td>'
            +'<td class="rr">'+fRqty+'</td>'
            +'<td class="rr">'+(r.rate>0?fi(r.rate):'—')+'</td>'
            +'<td class="rr">'+(r.amt>0?fi(r.amt):'—')+'</td>'
            +'</tr>';
    }).join('');

    if (freightVal>0) itemRows+='<tr class="item-row" style="background:#f8fafc"><td class="ctr">—</td><td class="tl" style="font-style:italic;color:#475569">Freight Charges</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">'+fi(freightVal)+'</td></tr>';
    if (packingVal>0) itemRows+='<tr class="item-row" style="background:#f8fafc"><td class="ctr">—</td><td class="tl" style="font-style:italic;color:#475569">Packing Charges</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">'+fi(packingVal)+'</td></tr>';

    // Linked PO table — show PO Number + PO Date only
    var invoiceRowsHTML = poInvoices.map(function(inv){
        var po = (_poRows||[]).find(function(r){ return String(r.id)===String(inv.po_id); });
        var poDate = po ? (po.po_date||'') : '';
        return '<tr>'
            +'<td style="padding:5px 8px;font-size:10.5px;font-weight:700;color:#1e3a8a;font-family:monospace">'+esc(inv.po_num||'—')+'</td>'
            +'<td style="padding:5px 8px;font-size:10.5px;color:#444">'+fd(poDate)+'</td>'
            +'</tr>';
    }).join('');

    // Supplier lines
    var supLines = ['<strong>'+esc(supplier)+'</strong>'];
    if (sup.address)        supLines.push(esc(sup.address));
    if (sup.gst_number)     supLines.push('GSTIN: <strong>'+esc(sup.gst_number)+'</strong>');
    if (sup.contact_person) supLines.push('Contact: '+esc(sup.contact_person)+(sup.phone?' | '+esc(sup.phone):''));
    if (sup.email)          supLines.push('E-Mail: '+esc(sup.email));

    var CSS = '*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
        +'body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;padding:20px 28px}'
        +'.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #166534;padding-bottom:8px;margin-bottom:0}'
        +'.co{font-size:19px;font-weight:900;color:#166534}'
        +'.cosub{font-size:8.5px;color:#666;text-transform:uppercase;letter-spacing:.5px}'
        +'.pnum{font-size:13px;font-weight:800;font-family:monospace;text-align:right;color:#166534}'
        +'.bar{display:grid;border:1px solid #ccc;border-top:none}'
        +'.bar3{grid-template-columns:1fr 1fr 1fr}'
        +'.bc{padding:5px 9px;border-right:1px solid #ccc}.bc:last-child{border-right:none}'
        +'.bl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:1px}'
        +'.bv{font-size:10.5px;font-weight:600}'
        +'.adg{display:grid;grid-template-columns:1fr 1fr;border:1px solid #ccc;border-top:none}'
        +'.ab{padding:8px 10px;border-right:1px solid #ccc;font-size:10px;line-height:1.65}'
        +'.ab:last-child{border-right:none}'
        +'.al{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px;padding-bottom:3px;border-bottom:1px solid #eee}'
        +'table{width:100%;border-collapse:collapse}'
        +'thead tr{background:#166534}'
        +'th{color:#fff;padding:6px 8px;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-right:1px solid rgba(255,255,255,.2);text-align:right}'
        +'th:first-child{text-align:center}th:nth-child(2){text-align:left}th:last-child{border-right:none}'
        +'tbody tr.item-row{border-bottom:1px solid #ddd}'
        +'tbody tr.item-row:nth-child(odd){background:#f9fafb}'
        +'td{padding:6px 8px;font-size:10.5px;vertical-align:top;border-right:1px solid #eee}'
        +'td:last-child{border-right:none}'
        +'.ctr{text-align:center;color:#888;width:22px}'
        +'.tl{text-align:left}'
        +'.rr{text-align:right;font-family:monospace}'
        +'.ftrow td{padding:4px 8px;border-right:1px solid #eee;font-size:10px}'
        +'.ftrow td:last-child{border-right:none}'
        +'.ftrow-total td{font-weight:800;font-size:12px;background:#f0fdf4;border-top:2px solid #166534}'
        +'.amt-words{border:1px solid #ccc;border-top:none;padding:6px 10px;font-size:10px}'
        +'.sig{display:grid;grid-template-columns:1fr 1fr;border:1px solid #ccc;border-top:none}'
        +'.sb{padding:9px 10px;border-right:1px solid #ccc;min-height:48px}.sb:last-child{border-right:none;text-align:right}'
        +'.sl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}'
        +'.footer{text-align:center;font-size:8.5px;color:#94a3b8;margin-top:6px;border-top:1px solid #eee;padding-top:5px}'
        +'@media print{body{padding:8px 14px}button{display:none!important}}';

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+esc(grn_num)+'</title>'
        +'<style>'+CSS+'</style></head><body>'
        +'<div class="hdr">'
        +'<div><div class="co">HCP WELLNESS PVT LTD</div><div class="cosub">Goods Receipt Note</div></div>'
        +'<div><div class="pnum">'+esc(grn_num)+'</div></div>'
        +'</div>'
        +'<div class="bar bar3">'
        +'<div class="bc"><div class="bl">GRN Number</div><div class="bv">'+esc(grn_num)+'</div></div>'
        +'<div class="bc"><div class="bl">GRN Date</div><div class="bv">'+fd(grn_date)+'</div></div>'
        +'<div class="bc"><div class="bl">Supplier</div><div class="bv">'+esc(supplier)+'</div></div>'
        +'</div>'
        +'<div class="adg">'
        +'<div class="ab"><div class="al">Supplier Details</div>'+supLines.join('<br>')+'</div>'
        +'<div class="ab"><div class="al">Linked PO Details</div>'
        +(invoiceRowsHTML
            ? '<table style="width:100%;border-collapse:collapse;margin-top:2px">'
              +'<thead><tr style="background:#f1f5f9"><th style="padding:4px 8px;text-align:left;font-size:8px;color:#666;font-weight:700">PO NUMBER</th><th style="padding:4px 8px;text-align:left;font-size:8px;color:#666;font-weight:700">PO DATE</th></tr></thead>'
              +'<tbody>'+invoiceRowsHTML+'</tbody></table>'
            : '<span style="color:#999;font-size:10px">—</span>')
        +'</div>'
        +'</div>'
        +'<table><thead><tr>'
        +'<th style="width:22px;text-align:center">Sl</th>'
        +'<th style="text-align:left">Material Description &amp; Details</th>'
        +'<th style="width:90px">PO Qty</th>'
        +'<th style="width:90px">Recd Qty</th>'
        +'<th style="width:85px">Rate (\u20b9/kg)</th>'
        +'<th style="width:105px">Amount (\u20b9)</th>'
        +'</tr></thead>'
        +'<tbody>'+itemRows+'</tbody>'
        +'<tfoot>'
        +'<tr class="ftrow"><td colspan="5" style="text-align:right;color:#555">Taxable Amount</td><td class="rr">'+fi(taxable)+'</td></tr>'
        +(cgstTotal>0?'<tr class="ftrow"><td colspan="5" style="text-align:right;color:#555">CGST</td><td class="rr">'+fi(cgstTotal)+'</td></tr>':'')
        +(sgstTotal>0?'<tr class="ftrow"><td colspan="5" style="text-align:right;color:#555">SGST</td><td class="rr">'+fi(sgstTotal)+'</td></tr>':'')
        +'<tr class="ftrow-total"><td colspan="5" style="text-align:right;text-transform:uppercase;letter-spacing:.5px">Grand Total</td><td class="rr" style="font-size:13px">'+fi(grandTotal)+'</td></tr>'
        +'</tfoot></table>'
        +'<div class="amt-words"><strong>Amount in Words:</strong>&nbsp; '+esc(grandWords)+'</div>'
        +(remarks?'<div style="border:1px solid #ccc;border-top:none;padding:5px 9px;font-size:10px;color:#555"><strong>Remarks:</strong> '+esc(remarks)+'</div>':'')
        +'<div class="sig">'
        +'<div class="sb"><div class="sl">Received By (Store)</div><div style="margin-top:28px;font-size:9px;color:#888">Name &amp; Signature</div></div>'
        +'<div class="sb"><div class="sl">Authorised By</div><div style="margin-top:28px;font-size:9px;color:#888">for HCP Wellness Pvt Ltd</div></div>'
        +'</div>'
        +'<div class="footer">SUBJECT TO AHMEDABAD JURISDICTION &nbsp;|&nbsp; This is a Computer Generated Document</div>'
        +'</body></html>';
}



/* ═══════════════════════════════════════════════════════
   GRN + linked PO(s) combined print — full fidelity
═══════════════════════════════════════════════════════ */
async function grnPrintWithPOs() {
    var grnHTML = _grnBuildPrintHTML();
    if (!grnHTML) return;

    // Collect linked PO IDs
    var poIds = [];
    (_grnPoInvoices||[]).forEach(function(inv){
        if (inv.po_id && poIds.indexOf(parseInt(inv.po_id)) === -1)
            poIds.push(parseInt(inv.po_id));
    });
    var sel = document.getElementById('grnPoSelect');
    if (sel && sel.value) {
        var pid = parseInt(sel.value);
        if (!isNaN(pid) && poIds.indexOf(pid) === -1) poIds.push(pid);
    }

    if (!poIds.length) { grnPrint(); return; }

    toast('Loading linked PO(s)…', 'info', 2000);

    // For each PO: load full data, populate PO form silently, capture print HTML
    var poHTMLParts = [];
    for (var i = 0; i < poIds.length; i++) {
        try {
            var html = await _fetchPOPrintHTML(poIds[i]);
            if (html) poHTMLParts.push(html);
        } catch(e) { console.error('PO print error for id '+poIds[i], e); }
    }

    if (!poHTMLParts.length) { grnPrint(); return; }

    // Strip closing tags from GRN, append each PO with page-break, then close
    var combined = grnHTML.replace('</body></html>', '');
    poHTMLParts.forEach(function(poHtml){
        // poHtml is a full <!DOCTYPE...> document — extract just <body> content
        var bodyMatch = poHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        var styleMatch = poHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
        var bodyContent = bodyMatch ? bodyMatch[1] : poHtml;
        var styleContent = styleMatch ? '<style>'+styleMatch[1]+'</style>' : '';
        combined += '<div style="page-break-before:always"></div>'
                 + styleContent
                 + '<div style="padding:20px 28px">' + bodyContent + '</div>';
    });
    combined += '</body></html>';

    var win = window.open('', '_blank', 'width=960,height=750');
    if (!win) { toast('Pop-up blocked — allow pop-ups', 'error'); return; }
    win.document.open(); win.document.write(combined); win.document.close();
    win.onload = function(){ win.focus(); win.print(); };
}

async function _fetchPOPrintHTML(poId) {
    // Ensure PO form is injected (needed for _poBuildPrintHTML DOM reads)
    if (typeof _poInjectForm === 'function') _poInjectForm();
    if (typeof gdLoad === 'function') gdLoad();

    // Ensure TC and declaration lists are loaded
    if ((!_tcLists||!_tcLists.length) && typeof _tcLoadFromDB==='function') {
        try { await _tcLoadFromDB(); } catch(e){}
    }
    if ((!_declLists||!_declLists.length) && typeof _declLoadFromDB==='function') {
        try { await _declLoadFromDB(); } catch(e){}
    }

    // Fetch full PO data
    var res = await fetch('/api/procurement/po/get?id=' + poId);
    var d   = await res.json();
    if (d.status !== 'ok') throw new Error(d.message);
    var o = d.order;

    // Save current PO form state
    var savedLines  = _poLines ? _poLines.slice() : [];
    var savedStatus = window._poCurrentStatus;
    var savedEditId = _poEditId;

    // Helper to set a DOM input value
    var sv = function(id, v){ var e=document.getElementById(id); if(e) e.value=(v||''); };

    // Populate PO form DOM with fetched data
    sv('poModalNum',         o.po_num||'');
    sv('poModalDate',        o.po_date||'');
    sv('poModalSupplier',    o.supplier_name||'');
    sv('poModalExpected',    o.delivery_date||'');
    sv('poModalRemarks',     o.remarks||'');
    sv('poModalDeliveryDays',o.delivery_days||'');

    // T&C and declaration
    if (typeof tcPopulateSelect==='function')   tcPopulateSelect('poModalTCList', o.tc_list_id||null);
    if (typeof declPopulateSelect==='function') declPopulateSelect('poModalDeclaration', o.declaration_id||null);
    sv('poModalTCList',      o.tc_list_id    ? String(o.tc_list_id)    : '');
    sv('poModalDeclaration', o.declaration_id? String(o.declaration_id): '');

    // Freight / packing
    var freightEl = document.getElementById('poFreightAmt');
    var packingEl = document.getElementById('poPackingAmt');
    var freightCb = document.getElementById('poFreightEnabled');
    var packingCb = document.getElementById('poPackingEnabled');
    if (freightEl && freightCb) {
        if (o.freight_charge && parseFloat(o.freight_charge) > 0) {
            freightCb.checked = true; freightEl.disabled = false;
            freightEl.value   = parseFloat(o.freight_charge).toFixed(2);
        } else {
            freightCb.checked = false; freightEl.disabled = true; freightEl.value = '';
        }
    }
    if (packingEl && packingCb) {
        if (o.packing_charge && parseFloat(o.packing_charge) > 0) {
            packingCb.checked = true; packingEl.disabled = false;
            packingEl.value   = parseFloat(o.packing_charge).toFixed(2);
        } else {
            packingCb.checked = false; packingEl.disabled = true; packingEl.value = '';
        }
    }

    // Supplier detail fields (auto-fill from supplier master)
    var sup = (_supRows||[]).find(function(s){ return s.supplier_name === (o.supplier_name||''); }) || {};
    sv('poSupAddress',    sup.address||'');
    sv('poSupGST',        sup.gst_number||'');
    sv('poSupPAN',        sup.pan_number||'');
    sv('poSupContact',    sup.contact_person||'');
    sv('poSupPhone',      sup.phone||'');
    sv('poSupEmail',      sup.email||'');
    sv('poSupPayTerms',   sup.payment_terms||sup.payment_type||'');
    sv('poSupCreditDays', sup.credit_days ? String(sup.credit_days) : '');

    // Shipping address — try to set first godown as default for the print
    var shipSel = document.getElementById('poShippingAddr');
    if (shipSel && o.shipping_godown_id) {
        shipSel.value = o.shipping_godown_id;
    } else if (shipSel && _gdGodowns && _gdGodowns.length) {
        shipSel.value = '0';  // first godown
    }
    var billSel = document.getElementById('poBillingAddr');
    if (billSel) billSel.value = 'company';

    // Set _poLines from fetched items
    _poLines = (o.items||[]).map(function(i){
        return {
            material:    i.material||'',
            qty:         i.qty||'',
            rate:        i.rate||'',
            hsn_code:    i.hsn_code||'',
            gst_rate:    i.gst_rate != null ? parseFloat(i.gst_rate) : 0,
            cgst_amount: i.cgst_amount != null ? parseFloat(i.cgst_amount) : 0,
            sgst_amount: i.sgst_amount != null ? parseFloat(i.sgst_amount) : 0
        };
    });

    // Set status
    if (typeof _poSetStatus === 'function') _poSetStatus(o.status || 'open');
    window._poCurrentStatus = o.status || 'open';
    _poEditId = o.id;

    // Call existing full-fidelity print builder — without T&C page 2
    window._poPrintNoTC = true;
    var html = typeof _poBuildPrintHTML === 'function' ? _poBuildPrintHTML() : null;
    window._poPrintNoTC = false;

    // Restore previous PO form state
    _poLines  = savedLines;
    window._poCurrentStatus = savedStatus;
    _poEditId = savedEditId;

    return html;
}

