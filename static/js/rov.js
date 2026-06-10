/* rov.js — Rejection Out Voucher (Purchase Returns)
   TallyPrime flow: Supplier → Invoice/GRN (Tracking No.) → PO auto-linked
   Stock effect: DEDUCT quantities from stock on save.
   PO effect:    Rejected qty added back to PO (reopens closed PO).
   Depends on: utils.js, app.js, po.js (_poRows, _allRows, _supRows)
*/

var _rovRows     = [];
var _rovFiltered = [];
var _rovFilter   = 'all';
var _rovEditId   = null;
var _rovLines    = [];
var _rovGrns     = [];   // all GRNs (loaded once, filtered by supplier)
var _rovSelGrn   = null; // currently selected GRN object
window._rovLoaded = false;

/* Run DB migration silently on load */
(function(){ fetch('/api/procurement/rov/migrate',{method:'POST'}).catch(function(){}); })();

/* ══ LIST ══ */
function loadRovData() {
    var body = document.getElementById('rovListBody');
    if (body) body.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div>';
    fetch('/api/procurement/rov/list')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status !== 'ok') throw new Error(d.message);
            _rovRows = d.rovs || [];
            window._rovLoaded = true;
            var sb = document.getElementById('sbBadge-rov');
            if (sb) sb.textContent = _rovRows.length;
            rovApplyFilter();
        })
        .catch(function(e){
            if (body) body.innerHTML = '<div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>'+escHtml(e.message)+'</p></div>';
        });
}

function rovSetFilter(f) {
    _rovFilter = f;
    document.querySelectorAll('#rovFilterGroup .filter-pill').forEach(function(b){
        b.classList.toggle('active', b.id === 'rovF'+f.charAt(0).toUpperCase()+f.slice(1));
    });
    rovApplyFilter();
}

function rovApplyFilter() {
    var q = (document.getElementById('rovSearchInput')||{value:''}).value.toLowerCase().trim();
    _rovFiltered = _rovRows.filter(function(r){
        if (_rovFilter !== 'all' && r.status !== _rovFilter) return false;
        if (!q) return true;
        return [r.grn_num||'',r.supplier_name||'',r.po_num||'',r.rejection_reason||'',r.grn_date||'']
            .join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var badge = document.getElementById('rovRowBadge');
    if (badge) badge.textContent = _rovFiltered.length+' voucher'+(_rovFiltered.length!==1?'s':'');
    rovRenderList();
}

function rovRenderList() {
    var body = document.getElementById('rovListBody');
    if (!body) return;
    if (!_rovFiltered.length) {
        body.innerHTML = '<div class="state-box" style="padding:40px"><div class="state-icon">↩</div><h3>No Rejection Out Vouchers</h3><p>Click <strong>+ New Rejection Out</strong> to record a return to supplier.</p></div>';
        return;
    }
    var fi = function(n){ return n!=null?'₹ '+parseFloat(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—'; };
    body.innerHTML = '<div class="table-shell"><div class="table-scroll"><table>'
        +'<thead><tr>'
        +'<th style="white-space:nowrap">Voucher No.</th>'
        +'<th>Party (Supplier)</th>'
        +'<th style="white-space:nowrap">Date</th>'
        +'<th>Invoice / GRN</th>'
        +'<th>PO Ref</th>'
        +'<th>Narration</th>'
        +'<th style="text-align:right">Total Value</th>'
        +'<th style="text-align:center">Items</th>'
        +'<th></th>'
        +'</tr></thead><tbody>'
        +_rovFiltered.map(function(r,idx){
            return '<tr style="cursor:pointer" ondblclick="rovOpenByIdx('+idx+')">'
                +'<td style="font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:#dc2626;white-space:nowrap">'+escHtml(r.grn_num)+'</td>'
                +'<td style="font-weight:600;font-size:12px">'+escHtml(r.supplier_name||'—')+'</td>'
                +'<td class="td-mono" style="white-space:nowrap;color:var(--muted)">'+fmtDate(r.grn_date||'')+'</td>'
                +'<td style="font-family:var(--font-mono);font-size:11px;color:var(--muted2)">'+escHtml(r.tracking_grn_num||r.invoice_ref||'—')+'</td>'
                +'<td style="font-family:var(--font-mono);font-size:11px;color:var(--teal)">'+escHtml(r.po_num||'—')+'</td>'
                +'<td style="font-size:11.5px;color:var(--muted2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml(r.rejection_reason||'—')+'</td>'
                +'<td class="td-mono" style="text-align:right;font-weight:700;color:#dc2626">'+fi(r.grand_total)+'</td>'
                +'<td style="text-align:center;font-size:11px;color:var(--muted)">'+(r.item_count||'—')+'</td>'
                +'<td style="white-space:nowrap">'
                +'<button class="act-btn" style="padding:4px 10px;font-size:11px;margin-right:3px" onclick="event.stopPropagation();rovOpenByIdx('+idx+')">✎ Edit</button>'
                +'<button class="act-btn" style="padding:4px 8px;font-size:11px;background:rgba(244,63,94,.08);border-color:rgba(244,63,94,.3);color:var(--red-text)" onclick="event.stopPropagation();rovDelete('+idx+')">✕</button>'
                +'</td>'
                +'</tr>';
        }).join('')
        +'</tbody></table></div></div>';
}

function rovOpenByIdx(idx) { openRovForm(_rovFiltered[idx]); }

async function rovDelete(idx) {
    var r = _rovFiltered[idx];
    if (!r||!r.id) return;
    if (!confirm('Delete Rejection Out Voucher '+r.grn_num+'?\nThis will restore rejected quantities to stock.')) return;
    try {
        var res = await fetch('/api/procurement/rov/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:r.id})});
        var d = await res.json();
        if (d.status!=='ok') throw new Error(d.message);
        toast('↩ '+r.grn_num+' deleted · Stock restored','success');
        loadRovData();
    } catch(e){ toast('Delete failed: '+e.message,'error'); }
}

/* ══ FORM ══ */
function rovBlankLine() {
    return {material:'',po_qty:'',received_qty:'',rate:'',unit:'KG',rejection_reason:'',batch_num:'',invoice_num:'',location:'',po_num:'',po_id:null};
}

async function openRovForm(row) {
    _rovEditId  = row ? row.id : null;
    _rovLines   = [];
    _rovSelGrn  = null;
    var list  = document.getElementById('rov-list-pane');
    var pane  = document.getElementById('rov-form-pane');
    var fbody = document.getElementById('rov-form-body');

    // Pre-load suppliers if not already loaded
    if (!window._supRows || !window._supRows.length) {
        try {
            var sr = await fetch('/api/procurement/suppliers');
            var sd = await sr.json();
            if (sd.status==='ok') window._supRows = sd.suppliers || [];
        } catch(e){}
    }

    // GRNs are loaded per-supplier on demand (not preloaded)

    // Now build form (suppliers are available for datalist)
    fbody.innerHTML = rovFormHTML();

    rovPopulateGodowns();

    var today = new Date().toISOString().slice(0,10);
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.value=v||''; };

    if (row && row.id) {
        document.getElementById('rovFormEyebrow').textContent = 'EDIT VOUCHER';
        document.getElementById('rovFormTitle').textContent   = 'Edit Rejection Out Voucher';
        try {
            var res = await fetch('/api/procurement/rov/get?id='+row.id);
            var d2 = await res.json();
            if (d2.status!=='ok') throw new Error(d2.message);
            var o = d2.rov;
            document.getElementById('rovFormNum').textContent = o.grn_num||'—';
            sv('rovDate',            o.grn_date||today);
            sv('rovSupplier',        o.supplier_name||'');
            sv('rovRejectionReason', o.rejection_reason||'');
            sv('rovRemarks',         o.remarks||'');
            sv('rovGodown',          o.godown||'');
            // Show supplier details
            _rovShowSupplierDetails(o.supplier_name||'');
            // Load GRNs for this supplier, then select the tracking GRN
            if (o.supplier_name) {
                try {
                    var gr = await fetch('/api/procurement/rov/grns_for_supplier?supplier='+encodeURIComponent(o.supplier_name));
                    var gd = await gr.json();
                    if (gd.status==='ok') _rovGrns = gd.grns || [];
                } catch(e){}
            }
            rovPopulateInvoiceSelect(o.tracking_grn_id || null);
            _rovLines = (o.items||[]).map(function(i){
                return {material:i.material||'',po_qty:i.po_qty!=null?parseFloat(i.po_qty):'',
                        received_qty:i.received_qty!=null?parseFloat(i.received_qty):'',
                        rate:i.rate!=null?parseFloat(i.rate):'',
                        unit:i.unit||'KG',rejection_reason:i.rejection_reason||'',
                        batch_num:i.batch_num||'',invoice_num:i.invoice_num||'',
                        location:i.location||'',
                        po_num:i.item_po_num||i.po_num||'',po_id:i.po_id||null};
            });
        } catch(e){ toast('Could not load voucher: '+e.message,'error'); }
    } else {
        document.getElementById('rovFormEyebrow').textContent = 'NEW VOUCHER';
        document.getElementById('rovFormTitle').textContent   = 'New Rejection Out Voucher';
        document.getElementById('rovFormNum').textContent     = 'Auto-assigned on save';
        sv('rovDate', today);
        _rovPreviewNextNum();
    }
    if (!_rovLines.length) _rovLines.push(rovBlankLine());
    rovRenderLines();
    list.style.display = 'none';
    pane.style.display = 'block';
    pane.scrollTo(0,0);
}

function _rovPreviewNextNum() {
    fetch('/api/procurement/voucher_numbering/next?voucher_type=rov')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status==='ok' && (d.prefix||d.suffix)) {
                var num = String(d.next).padStart(d.digits||4,'0');
                var parts = [];
                if (d.prefix) parts.push(d.prefix);
                parts.push(num);
                if (d.suffix) parts.push(d.suffix);
                var el = document.getElementById('rovFormNum');
                if (el && el.textContent.indexOf('Auto')!==-1) el.textContent = 'Next: '+parts.join('/');
            }
        }).catch(function(){});
}

/* ── SUPPLIER CHANGE → fetch invoices + show party details ── */
function rovSupplierChange() {
    var supplier = (document.getElementById('rovSupplier').value||'').trim();
    var poInfo = document.getElementById('rovPoInfo');
    if (poInfo) poInfo.innerHTML = '';
    _rovGrns = [];

    // Show supplier details
    _rovShowSupplierDetails(supplier);

    if (!supplier) {
        var sel = document.getElementById('rovInvoiceSelect');
        if (sel) sel.innerHTML = '<option value="">— Select supplier first —</option>';
        return;
    }
    // Fetch GRNs/invoices for this supplier
    var sel = document.getElementById('rovInvoiceSelect');
    if (sel) sel.innerHTML = '<option value="">Loading invoices…</option>';
    fetch('/api/procurement/rov/grns_for_supplier?supplier='+encodeURIComponent(supplier))
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status==='ok') {
                _rovGrns = d.grns || [];
                rovPopulateInvoiceSelect(null);
                if (!_rovGrns.length) {
                    toast('No invoices found for '+supplier,'info',3000);
                }
            } else {
                toast('Error loading invoices: '+(d.message||'Unknown'),'error');
                if (sel) sel.innerHTML = '<option value="">— Error: '+(d.message||'failed')+' —</option>';
            }
        })
        .catch(function(e){
            toast('Failed to load invoices: '+e.message,'error');
            if (sel) sel.innerHTML = '<option value="">— Network error —</option>';
        });
}

function _rovShowSupplierDetails(supplierName) {
    var box = document.getElementById('rovSupplierDetails');
    if (!box) return;
    if (!supplierName) { box.innerHTML = ''; box.style.display = 'none'; return; }
    var sup = (window._supRows||[]).find(function(s){
        return s.supplier_name && s.supplier_name.toLowerCase() === supplierName.toLowerCase();
    });
    if (!sup) { box.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0">Supplier not found in master</div>'; box.style.display = 'block'; return; }
    var lines = [];
    lines.push('<strong style="font-size:12px;color:var(--text)">'+escHtml(sup.supplier_name)+'</strong>');
    if (sup.address) lines.push('<span>'+escHtml(sup.address)+'</span>');
    var meta = [];
    if (sup.contact_person) meta.push('👤 '+escHtml(sup.contact_person));
    if (sup.phone) meta.push('📞 '+escHtml(sup.phone));
    if (sup.email) meta.push('✉ '+escHtml(sup.email));
    if (meta.length) lines.push('<span>'+meta.join(' &nbsp;·&nbsp; ')+'</span>');
    var biz = [];
    if (sup.gst_number) biz.push('GST: <strong style="font-family:var(--font-mono);letter-spacing:.5px">'+escHtml(sup.gst_number)+'</strong>');
    if (sup.pan_number) biz.push('PAN: <strong style="font-family:var(--font-mono);letter-spacing:.5px">'+escHtml(sup.pan_number)+'</strong>');
    if (sup.payment_terms) biz.push('Payment: '+escHtml(sup.payment_terms));
    if (sup.credit_days) biz.push('Credit: '+sup.credit_days+' days');
    if (biz.length) lines.push('<span>'+biz.join(' &nbsp;·&nbsp; ')+'</span>');
    box.innerHTML = lines.join('<br>');
    box.style.display = 'block';
}

function rovPopulateInvoiceSelect(selectedGrnId) {
    var sel = document.getElementById('rovInvoiceSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select Party Invoice —</option>'
        + (!_rovGrns.length ? '<option value="" disabled>No invoices found for this supplier</option>' : '')
        + _rovGrns.map(function(g){
            var label = g.grn_num + ' dtd ' + fmtDate(g.grn_date);
            if (g.invoice_num) label += ' · Inv: ' + g.invoice_num;
            if (g.item_count) label += ' (' + g.item_count + ' items)';
            if (g.grand_total) label += ' — ₹' + parseFloat(g.grand_total).toLocaleString('en-IN');
            return '<option value="'+g.id+'"'+(String(g.id)===String(selectedGrnId)?' selected':'')+'>'+escHtml(label)+'</option>';
        }).join('');
}

/* ── INVOICE/GRN CHANGE → load items + resolve PO per item ── */
async function rovInvoiceChange() {
    var sel = document.getElementById('rovInvoiceSelect');
    var grnId = sel ? sel.value : '';
    if (!grnId) {
        _rovSelGrn = null;
        var poInfo = document.getElementById('rovPoInfo');
        if (poInfo) poInfo.innerHTML = '';
        return;
    }
    try {
        var res = await fetch('/api/procurement/grn/get?id='+grnId);
        var d = await res.json();
        if (d.status!=='ok') throw new Error(d.message);
        _rovSelGrn = d.grn;
        var supEl = document.getElementById('rovSupplier');
        if (supEl && !supEl.value && d.grn.supplier_name) supEl.value = d.grn.supplier_name;

        // Build piList for po_invoices map
        var piList = d.grn.po_invoices || [];
        if (typeof piList === 'string') { try { piList = JSON.parse(piList); } catch(e){ piList=[]; } }


        // Build PO→invoice map from po_invoices JSON
        // piList entries: [{po_id, po_num, invoice_num, invoice_date}]
        var poInvMap = {};  // po_num → invoice_num
        (piList||[]).forEach(function(pi){
            if (pi.po_num && pi.invoice_num) poInvMap[pi.po_num] = pi.invoice_num;
        });

        // Single-PO GRN: header invoice_num is the invoice
        // Multi-PO GRN: invoice_num is '' on header, lives in poInvMap per po_num
        // Fallback: the consolidated invoice_num already assembled by grns_for_supplier API
        var grnEntry = _rovGrns.find(function(g){ return String(g.id) === String(grnId); });
        // Invoice: prefer grns_for_supplier entry (has all sources merged), then GRN header,
        // then first entry of po_invoices JSON (where single-PO GRN invoice lives)
        var piInv0 = (piList && piList.length) ? (piList[0].invoice_num || '') : '';
        var consolidatedInv = (grnEntry && grnEntry.invoice_num)
                           || (d.grn.invoice_num || '').trim()
                           || piInv0;

        // Location: GRN header unload_location, else default godown name
        var defGodownName = '';
        if (window._gdGodowns && window._gdGodowns.length) {
            var defGd = window._gdGodowns.find(function(g){ return g.is_default; }) || window._gdGodowns[0];
            if (defGd) defGodownName = defGd.name || '';
        }
        var grnGodown = (d.grn.unload_location || '').trim() || defGodownName;

        // Show invoice info strip
        var poInfo = document.getElementById('rovPoInfo');
        if (poInfo) {
            poInfo.innerHTML = consolidatedInv
                ? '<span style="font-size:11px">📄 Party Invoice: <strong>'+escHtml(consolidatedInv)+'</strong></span>'
                : '';
        }

        // Fill line items
        // NOTE: api_grn_get already resolves po_num and po_id per item via mat_po_map
        // so we use i.po_num / i.po_id directly — no need to re-fetch PO data
        _rovLines = (d.grn.items||[]).map(function(i){
            var mat    = (i.material||'').trim();
            var itemPo = i.po_num || '';                           // already resolved by backend
            var itemPoId = i.po_id || null;

            // Invoice resolution order:
            // 1. Per-item invoice_num stored on the GRN item row
            // 2. po_invoices map keyed by this item's po_num (multi-PO GRNs)
            // 3. GRN header invoice_num (single-PO GRN)
            // 4. First po_invoices entry invoice (where most GRNs store it)
            // 5. Consolidated invoice from grns_for_supplier (all sources merged)
            var itemInv = (i.invoice_num || '').trim()
                       || poInvMap[itemPo]
                       || (d.grn.invoice_num || '').trim()
                       || piInv0
                       || consolidatedInv;

            // Location resolution order:
            // 1. Per-item location stored on the GRN item row
            // 2. GRN header unload_location
            // 3. Default godown from _gdGodowns
            var itemLoc = (i.location || '').trim()
                       || (d.grn.unload_location || '').trim()
                       || grnGodown;

            return {
                material:         mat,
                po_qty:           i.received_qty != null ? parseFloat(i.received_qty) : '',
                received_qty:     '',
                rate:             i.rate != null ? parseFloat(i.rate) : '',
                unit:             i.unit || 'KG',
                rejection_reason: '',
                batch_num:        i.batch_num || '',
                invoice_num:      itemInv,
                location:         itemLoc,
                po_num:           itemPo,
                po_id:            itemPoId
            };
        });
        if (!_rovLines.length) _rovLines.push(rovBlankLine());
        rovRenderLines();
        toast('Items loaded — enter rejected quantities','success',3000);
    } catch(e){ toast('Could not load GRN: '+e.message,'error'); }
}

function rovPopulateGodowns() {
    var sel = document.getElementById('rovGodown');
    if (!sel) return;
    if (window._gdGodowns && window._gdGodowns.length) {
        sel.innerHTML = '<option value="">— Select Godown —</option>'
            +window._gdGodowns.map(function(g){
                return '<option value="'+escHtml(g.name)+'"'+(g.is_default?' selected':'')+'>'+escHtml(g.name)+'</option>';
            }).join('');
    } else {
        fetch('/api/procurement/godowns').then(function(r){ return r.json(); }).then(function(d){
            if (d.status==='ok') {
                sel.innerHTML = '<option value="">— Select Godown —</option>'
                    +(d.godowns||[]).map(function(g){
                        return '<option value="'+escHtml(g.name)+'"'+(g.is_default?' selected':'')+'>'+escHtml(g.name)+'</option>';
                    }).join('');
            }
        }).catch(function(){});
    }
}

function rovCloseForm() {
    document.getElementById('rov-form-pane').style.display = 'none';
    document.getElementById('rov-list-pane').style.display = '';
    _rovSelGrn = null;
    loadRovData();
}

function rovRenderLines() {
    var tb = document.getElementById('rovLinesTbody');
    if (!tb) return;
    var IS = 'width:100%;height:30px;padding:0 6px;border-radius:5px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-body);outline:none;font-size:11px';
    var MS = IS+';font-family:var(--font-mono);text-align:right';
    var RO = IS+';opacity:.6';
    var UNITS = ['KG','G','L','ML','NOS','PKT','BOX'];
    if (!_rovLines.length) {
        tb.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No items — select an Invoice/GRN above or click &ldquo;+ Add Item&rdquo;</td></tr>';
        rovCalcTotal(); return;
    }
    var isFromGrn = !!_rovSelGrn;
    tb.innerHTML = _rovLines.map(function(line,i){
        var amt = (parseFloat(line.received_qty)||0)*(parseFloat(line.rate)||0);
        var amtStr = amt>0?'₹ '+amt.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
        var hasRef = line.po_qty!=='';
        var bg = i%2?'var(--surface2)':'var(--surface)';
        var unitOpts = UNITS.map(function(u){ return '<option value="'+u+'"'+(line.unit===u?' selected':'')+'>'+u+'</option>'; }).join('');
        return '<tr data-ri="'+i+'" style="border-bottom:1px solid var(--border);background:'+bg+';">'
            +'<td style="padding:5px 4px;color:var(--muted);font-size:10px;width:20px;text-align:center;vertical-align:top;padding-top:8px">'+(i+1)+'</td>'
            +'<td style="padding:3px 4px;min-width:130px;vertical-align:top"><input class="rov-li-inp rov-mat-inp" data-ri="'+i+'" value="'+escHtml(line.material||'')+'" placeholder="Stock item…" '+(hasRef?'readonly ':'')+'style="'+(hasRef?RO:IS)+'" list="rovMatList"></td>'
            +'<td style="padding:5px 4px;width:110px;vertical-align:top;font-family:var(--font-mono);font-size:9.5px;color:var(--teal);font-weight:600;padding-top:8px;white-space:nowrap">'+(line.po_num?escHtml(line.po_num):'<span style="color:var(--muted);font-weight:400">—</span>')+'</td>'
            +'<td style="padding:5px 4px;width:70px;vertical-align:top;font-size:10px;color:var(--muted2);padding-top:8px;white-space:nowrap">'+(line.invoice_num?escHtml(line.invoice_num):'—')+'</td>'
            +'<td style="padding:5px 4px;width:80px;vertical-align:top;font-size:10px;padding-top:8px">'+(line.location?escHtml(line.location):'—')+'</td>'
            +'<td style="padding:3px 4px;width:70px;vertical-align:top"><input type="number" class="rov-li-inp" data-ri="'+i+'" value="'+(line.po_qty||'')+'" readonly style="'+MS+';opacity:.5" tabindex="-1" title="Received qty from GRN"></td>'
            +'<td style="padding:3px 4px;width:85px;vertical-align:top"><input type="number" class="rov-li-inp rov-rqty-inp rov-calc" data-ri="'+i+'" value="'+(line.received_qty||'')+'" placeholder="0.000" min="0" step="0.001" style="'+MS+';border-color:rgba(220,38,38,.4)"></td>'
            +'<td style="padding:3px 4px;width:50px;vertical-align:top"><select class="rov-li-inp rov-unit-inp" data-ri="'+i+'" style="'+IS+';width:50px;font-size:10px;padding:0 2px">'+unitOpts+'</select></td>'
            +'<td style="padding:3px 4px;width:80px;vertical-align:top"><input type="number" class="rov-li-inp rov-rate-inp rov-calc" data-ri="'+i+'" value="'+(line.rate||'')+'" '+(hasRef?'readonly tabindex="-1"':'')+' placeholder="Rate" style="'+(hasRef?MS+';opacity:.6':MS)+'"></td>'
            +'<td class="rov-amt-cell" style="padding:5px 4px;text-align:right;font-family:var(--font-mono);font-size:11px;font-weight:700;color:'+(amt>0?'#dc2626':'var(--muted)')+';white-space:nowrap;vertical-align:top;padding-top:8px">'+amtStr+'</td>'
            +'<td style="padding:3px 4px;min-width:100px;vertical-align:top"><input class="rov-li-inp rov-rej-inp" data-ri="'+i+'" value="'+escHtml(line.rejection_reason||'')+'" placeholder="Reason…" style="'+IS+'"></td>'
            +'<td style="padding:3px 4px;text-align:center;width:24px;vertical-align:top;padding-top:6px"><button class="rov-li-del" data-ri="'+i+'" style="width:20px;height:20px;border-radius:4px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);cursor:pointer;font-size:13px;line-height:1">×</button></td>'
            +'</tr>';
    }).join('');
    rovCalcTotal();
    var cnt = document.getElementById('rovLineCount');
    if (cnt) cnt.textContent = _rovLines.length+' item'+(_rovLines.length!==1?'s':'');
}

function rovCalcTotal() {
    var total = 0;
    _rovLines.forEach(function(l){ total += (parseFloat(l.received_qty)||0)*(parseFloat(l.rate)||0); });
    var el = document.getElementById('rovGrandTotal');
    var fi = function(n){ return '₹ '+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    if (el) el.textContent = total>0 ? fi(total) : '—';
}

function rovAddLine() {
    _rovLines.push(rovBlankLine());
    rovRenderLines();
    setTimeout(function(){
        var inp = document.querySelector('#rovLinesTbody tr[data-ri="'+(_rovLines.length-1)+'"] .rov-mat-inp');
        if (inp) inp.focus();
    }, 40);
}

document.addEventListener('input', function(e){
    var inp = e.target;
    if (!inp.classList.contains('rov-li-inp')) return;
    var idx = parseInt(inp.dataset.ri); if (isNaN(idx)) return;
    if (inp.classList.contains('rov-mat-inp'))   _rovLines[idx].material         = inp.value;
    if (inp.classList.contains('rov-rqty-inp'))  _rovLines[idx].received_qty     = inp.value;
    if (inp.classList.contains('rov-rate-inp'))  _rovLines[idx].rate             = inp.value;
    if (inp.classList.contains('rov-rej-inp'))   _rovLines[idx].rejection_reason = inp.value;
    if (inp.classList.contains('rov-batch-inp')) _rovLines[idx].batch_num        = inp.value;
    if (inp.classList.contains('rov-calc')) {
        var amt = (parseFloat(_rovLines[idx].received_qty)||0)*(parseFloat(_rovLines[idx].rate)||0);
        var aCell = document.querySelector('#rovLinesTbody tr[data-ri="'+idx+'"] .rov-amt-cell');
        if (aCell) {
            aCell.textContent = amt>0?'₹ '+amt.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
            aCell.style.color = amt>0?'#dc2626':'var(--muted)';
        }
        rovCalcTotal();
    }
});
document.addEventListener('change', function(e){
    var inp = e.target;
    if (!inp.classList.contains('rov-li-inp')) return;
    var idx = parseInt(inp.dataset.ri); if (isNaN(idx)) return;
    if (inp.classList.contains('rov-unit-inp')) _rovLines[idx].unit = inp.value;
});
document.addEventListener('click', function(e){
    var btn = e.target.closest('.rov-li-del');
    if (!btn) return;
    var idx = parseInt(btn.dataset.ri); if (isNaN(idx)) return;
    _rovLines.splice(idx,1);
    if (!_rovLines.length) _rovLines.push(rovBlankLine());
    rovRenderLines();
});

/* ══ SAVE ══ */
async function saveRov() {
    var supplier = (document.getElementById('rovSupplier').value||'').trim();
    if (!supplier) { toast('Party (Supplier) name is required','error'); return; }
    var validLines = _rovLines.filter(function(l){ return l.material&&l.material.trim(); });
    if (!validLines.length) { toast('Add at least one stock item','error'); return; }

    // Get PO info from the selected GRN
    var poId = null, poNum = '';
    var trackingGrnId = null, trackingGrnNum = '';
    var invSel = document.getElementById('rovInvoiceSelect');
    if (invSel && invSel.value) {
        trackingGrnId = parseInt(invSel.value);
        var matchedGrn = _rovGrns.find(function(g){ return g.id === trackingGrnId; });
        if (matchedGrn) {
            trackingGrnNum = matchedGrn.grn_num || '';
            poId  = matchedGrn.po_id || null;
            poNum = matchedGrn.po_num || '';
        }
    }

    var payload = {
        id: _rovEditId||null, supplier_name:supplier,
        rov_date: document.getElementById('rovDate').value||'',
        po_id: poId, po_num: poNum,
        tracking_grn_id: trackingGrnId,
        tracking_grn_num: trackingGrnNum,
        godown: (document.getElementById('rovGodown')||{}).value||'',
        rejection_reason:(document.getElementById('rovRejectionReason').value||'').trim(),
        remarks:(document.getElementById('rovRemarks').value||'').trim(),
        items: validLines.map(function(l){
            return {material:l.material.trim(), po_qty:parseFloat(l.po_qty)||0,
                    received_qty:parseFloat(l.received_qty)||0, rate:parseFloat(l.rate)||0,
                    unit:l.unit||'KG', rejection_reason:l.rejection_reason||'',
                    batch_num:l.batch_num||'',
                    invoice_num:l.invoice_num||'',
                    location:l.location||'',
                    po_num:l.po_num||'', po_id:l.po_id||null};
        })
    };
    var btn = document.getElementById('rovSaveBtn');
    if (btn){ btn.disabled=true; btn.textContent='Saving…'; }
    try {
        var res = await fetch('/api/procurement/rov/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        var d = await res.json();
        if (d.status!=='ok') throw new Error(d.message||'Save failed');

        // Eye-catching success banner
        var bannerMsg = '<strong>↩ Rejection Out Voucher Saved</strong><br>'
            + '<span style="font-family:var(--font-mono);font-size:14px">'+escHtml(d.rov_num)+'</span>';
        if (d.po_reopen && d.po_reopen.all_reopened && d.po_reopen.all_reopened.length) {
            d.po_reopen.all_reopened.forEach(function(p){
                bannerMsg += '<br><span style="margin-top:4px;display:inline-block;padding:2px 10px;border-radius:12px;background:rgba(255,255,255,.2);font-size:11px">'
                    + '🔄 PO '+escHtml(p.po_num)+' reopened → OPEN</span>';
            });
        } else if (d.po_reopen && d.po_reopen.po_num) {
            bannerMsg += '<br><span style="margin-top:4px;display:inline-block;padding:2px 10px;border-radius:12px;background:rgba(255,255,255,.2);font-size:11px">'
                + '🔄 PO '+escHtml(d.po_reopen.po_num)+' reopened → OPEN</span>';
        }
        _rovShowBanner(bannerMsg, 'success');
        rovCloseForm();
    } catch(e){
        _rovShowBanner('<strong>Save Failed</strong><br>'+escHtml(e.message), 'error');
        if (btn){ btn.disabled=false; btn.textContent='Save Voucher'; }
    }
}

/* Eye-catching full-width banner notification */
function _rovShowBanner(htmlMsg, type) {
    var existing = document.getElementById('rovBannerNotif');
    if (existing) existing.remove();
    var colors = {
        success: { bg:'linear-gradient(135deg,#065f46,#10b981)', border:'#34d399' },
        error:   { bg:'linear-gradient(135deg,#991b1b,#ef4444)', border:'#f87171' },
        info:    { bg:'linear-gradient(135deg,#1e40af,#3b82f6)', border:'#60a5fa' }
    };
    var c = colors[type] || colors.info;
    var banner = document.createElement('div');
    banner.id = 'rovBannerNotif';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:16px 24px;'
        + 'background:'+c.bg+';color:#fff;font-size:13px;text-align:center;line-height:1.6;'
        + 'border-bottom:2px solid '+c.border+';box-shadow:0 4px 20px rgba(0,0,0,.3);'
        + 'animation:rovBannerSlide .3s ease-out';
    banner.innerHTML = '<div style="max-width:600px;margin:0 auto">'+htmlMsg+'</div>'
        + '<button onclick="this.parentElement.remove()" style="position:absolute;top:8px;right:16px;background:none;border:none;color:rgba(255,255,255,.7);font-size:18px;cursor:pointer;line-height:1">✕</button>';
    document.body.appendChild(banner);
    // Add animation keyframe if not already present
    if (!document.getElementById('rovBannerStyle')) {
        var style = document.createElement('style');
        style.id = 'rovBannerStyle';
        style.textContent = '@keyframes rovBannerSlide{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}';
        document.head.appendChild(style);
    }
    // Auto-dismiss after 6 seconds
    setTimeout(function(){ var b=document.getElementById('rovBannerNotif'); if(b) b.style.transition='opacity .4s'; if(b) b.style.opacity='0'; setTimeout(function(){ if(b&&b.parentNode) b.remove(); },400); }, 6000);
}

async function rovDeleteCurrent() {
    if (!_rovEditId) return;
    var rov = _rovRows.find(function(r){ return r.id===_rovEditId; });
    if (!confirm('Delete Rejection Out Voucher '+(rov?rov.grn_num:'')+'?\nStock will be restored.')) return;
    try {
        var res = await fetch('/api/procurement/rov/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:_rovEditId})});
        var d = await res.json();
        if (d.status!=='ok') throw new Error(d.message);
        _rovShowBanner('<strong>↩ Voucher Deleted</strong><br>Stock quantities restored', 'info');
        rovCloseForm();
    } catch(e){ toast('Delete failed: '+e.message,'error'); }
}

/* ══ PRINT ══ */
async function rovPrint() {
    // Ensure billing & godown data is loaded
    if (!window._gdBilling || !window._gdGodowns) {
        try { await gdLoad(); } catch(e){}
    }
    var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var fd=function(d){ if(!d)return'—'; var p=String(d).split('-'); if(p.length<3)return d; return p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]; };
    var gv=function(id){ var e=document.getElementById(id); return e?e.value||'':''; };
    var gvt=function(id){ var e=document.getElementById(id); return e?e.textContent||'':''; };
    var rov_num=gvt('rovFormNum').trim()||'—';
    var supplier=gv('rovSupplier').trim()||'—';

    // Get full supplier details from master
    var sup = (window._supRows||[]).find(function(s){ return s.supplier_name && s.supplier_name.toLowerCase()===supplier.toLowerCase(); }) || {};
    var supLines = [];
    supLines.push('<strong>'+escHtml(supplier)+'</strong>');
    if (sup.address) supLines.push(escHtml(sup.address));
    if (sup.gst_number) supLines.push('GSTIN/UIN: <strong>'+escHtml(sup.gst_number)+'</strong>');
    if (sup.pan_number) supLines.push('PAN: '+escHtml(sup.pan_number));
    if (sup.contact_person) supLines.push(escHtml(sup.contact_person)+(sup.phone?' · '+escHtml(sup.phone):''));
    if (sup.email) supLines.push('E-Mail: '+escHtml(sup.email));

    // Company billing address
    var bill = window._gdBilling || {};
    var billLines = [];
    if (bill.name)  billLines.push('<strong>'+escHtml(bill.name)+'</strong>');
    if (bill.addr1) billLines.push(escHtml(bill.addr1));
    if (bill.addr2) billLines.push(escHtml(bill.addr2));
    if (bill.gst)   billLines.push('GSTIN/UIN: <strong>'+escHtml(bill.gst)+'</strong>');
    if (bill.phone) billLines.push('Ph: '+escHtml(bill.phone));
    if (bill.email) billLines.push('E-Mail: '+escHtml(bill.email));
    if (!billLines.length) billLines.push('<strong>HCP WELLNESS PVT LTD</strong>');

    // Default shipping godown
    var defGodown = (window._gdGodowns||[]).find(function(g){ return g.is_default; }) || (window._gdGodowns||[])[0] || {};
    var shipLines = [];
    if (bill.name) shipLines.push('<strong>'+escHtml(bill.name)+' — Ship From</strong>');
    if (defGodown.name) shipLines.push(escHtml(defGodown.name));
    var gdFullAddr = [defGodown.address, defGodown.city, defGodown.state, defGodown.pin].filter(Boolean).join(', ');
    if (gdFullAddr) shipLines.push(escHtml(gdFullAddr));
    if (defGodown.contact) shipLines.push(escHtml(defGodown.contact)+(defGodown.phone?' · '+escHtml(defGodown.phone):''));
    if (!shipLines.length) shipLines.push('<strong>HCP WELLNESS PVT LTD</strong>');

    // Get invoice numbers from items (not from GRN header)
    var invSel = document.getElementById('rovInvoiceSelect');
    var invDateLabel = '—';
    var printInvNums = [];
    _rovLines.forEach(function(l){ if(l.invoice_num && printInvNums.indexOf(l.invoice_num)===-1) printInvNums.push(l.invoice_num); });
    var trackingLabel = printInvNums.length ? printInvNums.join(', ') : '—';
    if (invSel && invSel.value) {
        var g = _rovGrns.find(function(x){ return String(x.id)===invSel.value; });
        if (g) {
            invDateLabel = fd(g.invoice_date || g.grn_date);
            if (!printInvNums.length) trackingLabel = g.invoice_num || '—';
        }
    }
    var validLines=_rovLines.filter(function(l){ return l.material&&l.material.trim(); });
    if (!validLines.length){ toast('No items to print','error'); return; }
    var total=0;
    var rows=validLines.map(function(r,i){
        var rqty=parseFloat(r.received_qty)||0; var rate=parseFloat(r.rate)||0; var amt=rqty*rate; total+=amt;
        var fi=function(n){ return '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
        return '<tr><td style="text-align:center;color:#888">'+(i+1)+'</td>'
            +'<td><strong>'+escHtml(r.material)+'</strong>'+(r.batch_num?'<br><span style="font-size:8px;color:#888">Batch: '+escHtml(r.batch_num)+'</span>':'')+'</td>'
            +'<td style="font-family:monospace;font-size:9px;color:#1d4ed8">'+(r.po_num?escHtml(r.po_num):'—')+'</td>'
            +'<td style="font-size:9px;color:#666">'+(r.invoice_num?escHtml(r.invoice_num):'—')+'</td>'
            +'<td style="font-size:9px;color:#666">'+(r.location?escHtml(r.location):'—')+'</td>'
            +'<td style="text-align:right;font-family:monospace">'+(parseFloat(r.po_qty)||0).toFixed(3)+' '+escHtml(r.unit||'KG')+'</td>'
            +'<td style="text-align:right;font-family:monospace;color:#b91c1c;font-weight:700">'+rqty.toFixed(3)+' '+escHtml(r.unit||'KG')+'</td>'
            +'<td style="text-align:right;font-family:monospace">'+(rate>0?fi(rate):'—')+'</td>'
            +'<td style="text-align:right;font-family:monospace;color:#b91c1c;font-weight:700">'+(amt>0?fi(amt):'—')+'</td>'
            +'<td style="color:#666;font-size:9px">'+escHtml(r.rejection_reason||'—')+'</td></tr>';
    }).join('');
    var fi=function(n){ return '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+escHtml(rov_num)+'</title>'
        +'<style>*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact}'
        +'body{font-family:Arial,sans-serif;font-size:11px;padding:20px 28px}'
        +'.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:8px}'
        +'.co{font-size:16px;font-weight:900;letter-spacing:-.5px}'
        +'.vtype{font-size:22px;font-weight:900;color:#b91c1c;text-transform:uppercase;letter-spacing:-.5px;margin-top:2px}'
        +'.bar{display:grid;border:1px solid #999}'
        +'.bar3{grid-template-columns:1fr 1fr 1fr}'
        +'.bar2{grid-template-columns:1fr 1fr}'
        +'.bc{padding:5px 9px;border-right:1px solid #999}.bc:last-child{border-right:none}'
        +'.bl{font-size:7px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.6px;margin-bottom:1px}'
        +'.bv{font-size:10.5px;font-weight:600}'
        +'table{width:100%;border-collapse:collapse;margin-top:8px}'
        +'thead tr{background:#b91c1c}th{color:#fff;padding:6px 8px;font-size:8px;font-weight:700;text-transform:uppercase;border-right:1px solid rgba(255,255,255,.2)}'
        +'tbody tr{border-bottom:1px solid #ddd}tbody tr:nth-child(odd){background:#fff8f8}'
        +'td{padding:6px 8px;vertical-align:top;border-right:1px solid #eee}'
        +'.narr{margin-top:12px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:10px}'
        +'.narr-label{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;margin-bottom:2px}'
        +'.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:50px}'
        +'.sig-box{border-top:1px solid #999;padding-top:6px;text-align:center;font-size:9px;color:#888}'
        +'.party-grid{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #999;border-top:none}'
        +'.party-box{padding:8px 10px;border-right:1px solid #999;font-size:10px;line-height:1.65}'
        +'.party-box:last-child{border-right:none}'
        +'.party-label{font-size:7px;font-weight:800;color:#666;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}'
        +'@media print{body{padding:8px 14px}}</style></head><body>'
        +'<div class="hdr"><div><div class="vtype">Rejection Out Voucher</div>'
        +'<div class="co">HCP WELLNESS PVT LTD</div></div>'
        +'<div style="text-align:right"><div style="font-size:8px;font-weight:800;color:#888;text-transform:uppercase">Voucher No.</div>'
        +'<div style="font-size:16px;font-weight:900;font-family:monospace;color:#b91c1c">'+escHtml(rov_num)+'</div></div></div>'
        // Bar: Voucher + Date only (invoice/location shown per item)
        +'<div class="bar" style="grid-template-columns:1fr 1fr">'
        +'<div class="bc"><div class="bl">Voucher No.</div><div class="bv">'+escHtml(rov_num)+'</div></div>'
        +'<div class="bc"><div class="bl">Date</div><div class="bv">'+fd(gv('rovDate'))+'</div></div>'
        +'</div>'
        // 3-column address grid
        +'<div class="party-grid">'
        +'<div class="party-box"><div class="party-label">Our Company (Billing)</div>'+billLines.join('<br>')+'</div>'
        +'<div class="party-box"><div class="party-label">Dispatched From</div>'+shipLines.join('<br>')+'</div>'
        +'<div class="party-box"><div class="party-label">Return To (Supplier)</div>'+supLines.join('<br>')+'</div>'
        +'</div>'
        // Items table with PO Ref, Invoice, Location per item
        +'<table><thead><tr><th style="width:22px;text-align:center">Sl</th><th style="text-align:left">Name of Item</th>'
        +'<th style="text-align:left">PO Ref</th><th style="text-align:left">Invoice</th><th style="text-align:left">Location</th>'
        +'<th>Received Qty</th><th style="color:#fca5a5">Rejected Qty</th>'
        +'<th>Rate (₹)</th><th style="color:#fca5a5">Amount (₹)</th><th style="text-align:left">Reason</th></tr></thead>'
        +'<tbody>'+rows+'</tbody>'
        +'<tfoot><tr><td colspan="8" style="text-align:right;font-weight:700;padding:8px;color:#b91c1c">Total Rejection Value</td>'
        +'<td style="text-align:right;font-weight:800;font-size:13px;font-family:monospace;color:#b91c1c">'+fi(total)+'</td><td></td></tr></tfoot></table>';
    var narr = gv('rovRejectionReason').trim() || gv('rovRemarks').trim();
    if (narr) html += '<div class="narr"><div class="narr-label">Narration</div>'+escHtml(narr)+'</div>';
    html += '<div class="sig-grid"><div class="sig-box">Authorised Signatory</div><div class="sig-box">Received By (Supplier)</div></div>';
    html += '</body></html>';
    var win=window.open('','_blank','width=900,height=700');
    if (!win){ toast('Pop-up blocked','error'); return; }
    win.document.open(); win.document.write(html); win.document.close();
    win.onload=function(){ win.focus(); win.print(); };
}

/* ══ FORM HTML ══ */
function rovFormHTML() {
    var supOpts = (window._supRows||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
    var matOpts = (window._allRows||[]).map(function(m){ return '<option value="'+escHtml(m.material_name)+'">'; }).join('');
    return '<div style="background:var(--surface);min-height:100%">'
        // Sticky header bar
        +'<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:var(--surface2);border-bottom:1px solid var(--border2);position:sticky;top:0;z-index:50">'
        +'<div style="display:flex;align-items:center;gap:14px">'
        +'<button onclick="rovCloseForm()" style="height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>Back to List</button>'
        +'<div><div id="rovFormEyebrow" style="font-size:9px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.8px">NEW VOUCHER</div>'
        +'<div id="rovFormTitle" style="font-size:17px;font-weight:800;color:var(--text)">New Rejection Out Voucher</div></div></div>'
        +'<div style="display:flex;gap:8px;align-items:center">'
        +'<button id="rovDeleteBtn" onclick="rovDeleteCurrent()" style="display:'+(_rovEditId?'inline-flex':'none')+';height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);align-items:center;gap:6px">Delete Voucher</button>'
        +'<button onclick="rovPrint()" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Preview &amp; Print</button>'
        +'</div></div>'
        // Alert
        +'<div style="margin:10px 16px 0;padding:10px 14px;background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);border-radius:8px;font-size:12px;color:#b91c1c">⚠ <strong>Stock Deduction:</strong> Saving will <strong>deduct</strong> rejected quantities from stock and update the PO status.</div>'
        // Header card
        +'<div class="form-card" style="margin:10px 16px 0;border-radius:10px">'
        +'<div class="form-card-head" style="background:linear-gradient(135deg,#991b1b,#dc2626)">'
        +'<div class="form-card-head-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg> REJECTION OUT VOUCHER</div>'
        +'<span class="form-card-badge" style="background:rgba(255,255,255,.2);color:#fff">Voucher No: <span id="rovFormNum" style="font-family:var(--font-mono)">Auto-assigned</span></span>'
        +'</div>'
        +'<div class="form-card-body" style="padding:12px 14px">'
        // Row 1: Date, Supplier, GRN Reference (to load items)
        +'<div style="display:grid;grid-template-columns:130px 1fr 1fr;gap:12px;margin-bottom:10px">'
        +'<div class="form-group"><label class="form-label">Date</label><input class="form-input-styled" type="date" id="rovDate"></div>'
        +'<div class="form-group"><label class="form-label">Party (Supplier) <span class="req">*</span></label><select class="form-input-styled" id="rovSupplier" onchange="rovSupplierChange()"><option value="">— Select Supplier —</option>'+((window._supRows||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'+escHtml(s.supplier_name)+'</option>'; }).join(''))+'</select></div>'
        +'<div class="form-group"><label class="form-label">GRN Reference <span style="font-weight:400;font-size:9px;color:var(--muted)">select to auto-fill items</span></label><select class="form-input-styled" id="rovInvoiceSelect" onchange="rovInvoiceChange()"><option value="">— Select supplier first —</option></select></div>'
        +'</div>'
        // Hidden godown (keep element for backward compat but not visible)
        +'<select id="rovGodown" style="display:none"><option value="">—</option></select>'
        // Supplier details strip (auto-filled on selection)
        +'<div id="rovSupplierDetails" style="display:none;margin-bottom:8px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;font-size:11px;color:var(--muted);line-height:1.7"></div>'
        // PO info strip
        +'<div id="rovPoInfo" style="margin-bottom:8px;min-height:18px"></div>'
        // Row 2: Narration, Remarks
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
        +'<div class="form-group"><label class="form-label">Narration / Rejection Reason</label><input class="form-input-styled" type="text" id="rovRejectionReason" placeholder="e.g. Quality not meeting specs, Damaged goods…"></div>'
        +'<div class="form-group"><label class="form-label">Remarks</label><input class="form-input-styled" type="text" id="rovRemarks" placeholder="Any notes…"></div>'
        +'</div></div></div>'
        // Line items card
        +'<div class="form-card" style="margin:10px 16px 0;border-radius:10px">'
        +'<div class="form-card-head" style="background:linear-gradient(135deg,#991b1b,#dc2626)">'
        +'<div class="form-card-head-title">STOCK ITEMS (Rejected &amp; Returned)</div>'
        +'<div style="display:flex;align-items:center;gap:8px"><span id="rovLineCount" style="font-size:10px;color:rgba(255,255,255,.7)">0 items</span>'
        +'<button onclick="rovAddLine()" style="height:26px;padding:0 12px;border-radius:6px;border:none;background:#fff;color:#b91c1c;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body)">+ Add Item</button></div></div>'
        +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">'
        +'<thead><tr style="background:var(--surface2);border-bottom:1px solid var(--border2)">'
        +'<th style="padding:7px 4px;text-align:center;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:20px">#</th>'
        +'<th style="padding:7px 6px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase">Name of Item *</th>'
        +'<th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--teal);text-transform:uppercase;width:110px">PO Ref</th>'
        +'<th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:70px">Invoice</th>'
        +'<th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:80px">Location</th>'
        +'<th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:70px">Received</th>'
        +'<th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:#dc2626;text-transform:uppercase;width:85px">Rejected *</th>'
        +'<th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:50px">Unit</th>'
        +'<th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;width:80px">Rate (₹)</th>'
        +'<th style="padding:7px 4px;text-align:right;font-size:9px;font-weight:700;color:#dc2626;text-transform:uppercase;width:100px">Amount (₹)</th>'
        +'<th style="padding:7px 4px;text-align:left;font-size:9px;font-weight:700;color:#dc2626;text-transform:uppercase;min-width:100px">Reason</th>'
        +'<th style="padding:7px 4px;width:24px"></th>'
        +'</tr></thead>'
        +'<tbody id="rovLinesTbody"></tbody>'
        +'<tfoot><tr style="border-top:2px solid var(--border2);background:var(--surface2)">'
        +'<td colspan="8" style="padding:12px 14px;font-size:11px;font-weight:800;color:#b91c1c;text-align:right;text-transform:uppercase;letter-spacing:.5px">Total Rejection Value</td>'
        +'<td id="rovGrandTotal" style="padding:12px 14px;text-align:right;font-weight:800;font-size:16px;color:#dc2626;font-family:var(--font-mono)">—</td>'
        +'<td colspan="3"></td></tr></tfoot></table></div>'
        +'<datalist id="rovMatList">'+matOpts+'</datalist></div>'
        // Save bar
        +'<div style="position:sticky;bottom:0;background:var(--surface2);border-top:1px solid var(--border2);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:50;margin-top:10px">'
        +'<div style="display:flex;gap:10px;align-items:center">'
        +'<button onclick="rovCloseForm()" style="height:36px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Cancel</button>'
        +'<button onclick="rovPrint()" style="height:36px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Print Voucher</button>'
        +'<button id="rovSaveBtn" onclick="saveRov()" style="height:36px;padding:0 24px;border-radius:7px;border:none;background:#b91c1c;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font-body)">Save Voucher</button>'
        +'</div>'
        +'<div style="font-size:10.5px;color:var(--muted)">⚠ Saving will <strong>deduct</strong> quantities from stock &amp; update PO</div>'
        +'</div></div>';
}

window.openRovFormByIdx = rovOpenByIdx;
