/* po.js — Possible batch calc, PO list, line items, save/delete, print, form pane
   Depends on: utils.js, suppliers.js, godowns_tc_decl.js */

/* ═══════════════════════════════════════════════════════
   POSSIBLE BATCH CALCULATOR
   Computes max batch size limited by available stock.
   For each material: max_kg = in_stock / (required / batch_size)
   The minimum across all materials = the limiting batch size.
═══════════════════════════════════════════════════════ */
function openPossibleBatch(){
    if(!_rmData || !_rmData.materials.length){ toast('Generate RM report first','warning'); return; }

    // Use TOTAL of all cart batch sizes as reference
    // because _rmData.materials[].total_qty is summed across all cart batches
    var refSize = 0;
    (_rmCart||[]).forEach(function(c){ refSize += (c.batch_size||0); });
    if(!refSize){ toast('No batch size reference found','warning'); return; }
    var cartSummary = (_rmCart||[]).map(function(c){ return c.batch_name+' ('+fmtNum(c.batch_size,3)+' KG)'; }).join(', ');

    // Build per-material calculation
    // required_per_kg = total_qty / refSize  (how much per 1 KG of batch)
    var rows = [];
    var minPossible = Infinity;
    var limitingMat = '';

    _rmData.materials.forEach(function(m){
        if(m.current_stock === null || m.current_stock === undefined) return; // skip unknown stock
        var perKg = m.total_qty / refSize;   // kg of this material needed per 1 kg of batch
        if(perKg <= 0) return;
        var maxBatch = m.current_stock / perKg;
        rows.push({
            name:       m.name,
            stock:      m.current_stock,
            perKg:      perKg,
            maxBatch:   maxBatch,
            isLimiting: false,
        });
        if(maxBatch < minPossible){
            minPossible = maxBatch;
            limitingMat = m.name;
        }
    });

    // Mark limiting material(s) — within 1% of minimum
    rows.forEach(function(r){ r.isLimiting = (r.maxBatch <= minPossible * 1.01); });
    // Sort: limiting first, then by maxBatch ascending
    rows.sort(function(a,b){ return a.maxBatch - b.maxBatch; });

    var possible = isFinite(minPossible) ? Math.floor(minPossible * 1000) / 1000 : 0;
    document.getElementById('pbMaxSize').textContent = fmtNum(possible, 3);
    document.getElementById('pbLimitedBy').textContent = limitingMat ? 'Limited by: ' + limitingMat : '';
    document.getElementById('pbSub').textContent = 'Total batch: ' + fmtNum(refSize,3) + ' KG  \u00b7  ' + _rmData.materials.length + ' materials  \u00b7  ' + (_rmCart||[]).length + ' batch' + ((_rmCart||[]).length!==1?'es':'');

    // Render breakdown table
    var tbody = document.getElementById('pbTbody');
    if(!rows.length){
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted);font-size:12px">No stock data available for any material</td></tr>';
    } else {
        var h = '';
        rows.forEach(function(r, i){
            var isLim = r.isLimiting;
            var bg  = isLim ? 'background:rgba(251,191,36,.06);' : (i%2===0?'':'background:var(--surface2);');
            var lBdr= isLim ? 'border-left:3px solid rgba(251,191,36,.7);' : 'border-left:3px solid transparent;';
            var status = isLim
                ? '<span style="color:#fbbf24;font-weight:700;font-size:11px">\u26a0 Limiting</span>'
                : '<span style="color:#4ade80;font-size:11px">\u2705 OK</span>';
            h += '<tr style="border-bottom:1px solid var(--border);'+bg+lBdr+'">'
               + '<td style="padding:8px 10px;font-weight:600;color:var(--text)">'+escHtml(r.name)+'</td>'
               + '<td style="padding:8px 10px;text-align:right;color:#38bdf8;font-family:var(--font-mono)">'+fmtNum(r.stock,4)+' kg</td>'
               + '<td style="padding:8px 10px;text-align:right;color:var(--muted2);font-family:var(--font-mono)">'+fmtNum(r.perKg,6)+' kg</td>'
               + '<td style="padding:8px 10px;text-align:right;font-weight:700;font-family:var(--font-mono);color:'+(isLim?'#fbbf24':'#4ade80')+'">'+fmtNum(r.maxBatch,3)+' kg</td>'
               + '<td style="padding:8px 10px;text-align:center">'+status+'</td>'
               + '</tr>';
        });
        tbody.innerHTML = h;
    }

    document.getElementById('possibleBatchModal').classList.add('open');
}

function closePossibleBatch(){
    document.getElementById('possibleBatchModal').classList.remove('open');
}
document.getElementById('possibleBatchModal').addEventListener('click', function(e){
    if(e.target===document.getElementById('possibleBatchModal')) closePossibleBatch();
});



/* Manufacturing process functions are defined in fvq_viewer.js */


/* ── RM Cart Draft (localStorage) ── */
var _RM_DRAFT_KEY = 'hcp_rm_cart_draft';

function rmSaveDraft(){
    try{
        localStorage.setItem(_RM_DRAFT_KEY, JSON.stringify(_rmCart));
    }catch(e){}
}

function rmLoadDraft(){
    try{
        var raw = localStorage.getItem(_RM_DRAFT_KEY);
        if(!raw) return false;
        var saved = JSON.parse(raw);
        if(!Array.isArray(saved) || !saved.length) return false;
        // Validate each entry against current _fvqBatches
        var valid = saved.filter(function(c){
            return c.batch_name && (_fvqBatches||[]).some(function(b){ return b.batch_name===c.batch_name; });
        });
        if(!valid.length) return false;
        _rmCart = valid;
        return true;
    }catch(e){ return false; }
}

function rmClearDraft(){
    try{ localStorage.removeItem(_RM_DRAFT_KEY); }catch(e){}
}


/* ════════════════════════════════════════════════════════════════
   PURCHASE ORDERS TAB
════════════════════════════════════════════════════════════════ */
var _poRows = [], _poFiltered = [], _poPage = 1, _poPageSize = 25, _poFilter = 'all';

/* ── Approval system tracking ──
 * _poCurrentApprovalStatus / _poCurrentApprovedBy / _poCurrentApprovedAt mirror
 * the loaded PO's approval fields so the form-button UI stays consistent.
 * _poCanApprove + _poIsAdmin are loaded once via /api/procurement/po/can_approve. */
var _poCurrentApprovalStatus = 'pending';
var _poCurrentApprovedBy     = '';
var _poCurrentApprovedAt     = '';
var _poCanApprove = false;
var _poIsAdmin    = false;
var _poCurrentUsername = '';

/* Load approval permission once on init (used to show/hide Approve button) */
function poLoadApprovalPerms() {
    return fetch('/api/procurement/po/can_approve').then(function(r){return r.json();}).then(function(d){
        if (d && d.status === 'ok') {
            _poCanApprove      = !!d.can_approve;
            _poIsAdmin         = !!d.is_admin;
            _poCurrentUsername = d.username || '';
        }
    }).catch(function(){});
}

/* Approve the currently-open PO. Approval button only visible when can_approve is true
 * and PO is pending. */
function poApprove() {
    if (!_poEditId) { toast('Save the PO first before approving','warning'); return; }
    if (!confirm('Approve this Purchase Order?\n\nOnce approved you can print, email, and share it. Editing the PO afterwards will revert it to pending.')) return;
    fetch('/api/procurement/po/approve', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id: _poEditId})
    }).then(function(r){return r.json();}).then(function(d){
        if (d.status !== 'ok') throw new Error(d.message||'Approval failed');
        toast('Purchase Order approved by ' + d.approved_by, 'success');
        _poCurrentApprovalStatus = 'approved';
        _poCurrentApprovedBy     = d.approved_by;
        _poCurrentApprovedAt     = new Date().toISOString();
        poUpdateApprovalUI();
        if (typeof loadPoData === 'function') loadPoData();  // refresh PO list
    }).catch(function(e){ toast('Approval failed: '+e.message,'error'); });
}

/* Revoke an approval, sending the PO back to pending. */
function poRevokeApproval() {
    if (!_poEditId) return;
    if (!confirm('Revoke approval and send this PO back to pending?\n\nThe PO will need to be re-approved before it can be printed or emailed.')) return;
    fetch('/api/procurement/po/revoke_approval', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id: _poEditId})
    }).then(function(r){return r.json();}).then(function(d){
        if (d.status !== 'ok') throw new Error(d.message||'Revoke failed');
        toast('Approval revoked — PO is back to pending','warning');
        _poCurrentApprovalStatus = 'pending';
        _poCurrentApprovedBy     = '';
        _poCurrentApprovedAt     = '';
        poUpdateApprovalUI();
        if (typeof loadPoData === 'function') loadPoData();
    }).catch(function(e){ toast('Failed: '+e.message,'error'); });
}

/* Update the form-bar UI to reflect current approval status:
 *  - Badge (Pending / Approved by X)
 *  - Approve button visibility (approvers only, pending POs only)
 *  - Revoke button visibility (approvers only, approved POs only)
 *  - Preview/WhatsApp/Email buttons: disabled when not approved */
function poUpdateApprovalUI() {
    var isApproved = (_poCurrentApprovalStatus || 'pending').toLowerCase() === 'approved';
    var isSaved    = !!_poEditId;
    var badge      = document.getElementById('poApprovalBadge');
    var badgeText  = document.getElementById('poApprovalBadgeText');
    var approveBtn = document.getElementById('poApproveBtn');
    var revokeBtn  = document.getElementById('poRevokeApprovalBtn');
    var previewBtn = document.getElementById('poPreviewPrintBtn');
    var waBtn      = document.getElementById('poWhatsAppBtn');
    var emailBtn   = document.getElementById('poEmailBtn');

    /* Badge — only show on saved POs */
    if (badge) {
        if (!isSaved) {
            badge.style.display = 'none';
        } else {
            badge.style.display = 'inline-flex';
            if (isApproved) {
                badge.style.background = 'rgba(16,185,129,.12)';
                badge.style.color      = '#059669';
                badge.style.border     = '1px solid rgba(16,185,129,.3)';
                badgeText.textContent  = 'APPROVED' + (_poCurrentApprovedBy ? ' by ' + _poCurrentApprovedBy : '');
            } else {
                badge.style.background = 'rgba(245,158,11,.12)';
                badge.style.color      = '#b45309';
                badge.style.border     = '1px solid rgba(245,158,11,.3)';
                badgeText.textContent  = 'PENDING APPROVAL';
            }
        }
    }

    /* Approve button — visible to approvers when PO is pending */
    if (approveBtn) {
        approveBtn.style.display = (isSaved && !isApproved && _poCanApprove) ? 'inline-flex' : 'none';
    }
    /* Revoke button — visible to approvers when PO is approved */
    if (revokeBtn) {
        revokeBtn.style.display = (isSaved && isApproved && _poCanApprove) ? 'inline-flex' : 'none';
    }

    /* Disable Preview/WhatsApp/Email until approved */
    var disable = function(btn, why){
        if (!btn) return;
        if (isApproved || !isSaved) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor  = '';
            btn.title         = btn.dataset.origTitle || btn.title || '';
        } else {
            if (!btn.dataset.origTitle && btn.title) btn.dataset.origTitle = btn.title;
            btn.disabled = true;
            btn.style.opacity = '.45';
            btn.style.cursor  = 'not-allowed';
            btn.title         = why;
        }
    };
    var why = 'PO must be approved before printing/sending';
    disable(previewBtn, why);
    disable(waBtn,      why);
    disable(emailBtn,   why);
}

/* ── State tracking for GST inter-state detection ──
 * Set on supplier select / billing-address load. Used by poCheckGstStates()
 * to show the banner and disable Save, and by poCalcGrandTotal() / save path
 * to decide CGST/SGST vs IGST. */
var _poCompanyState  = '';
var _poSupplierState = '';
var _poSupplierName  = '';
function poIsInterState() {
    var c = (_poCompanyState  || '').trim().toLowerCase();
    var s = (_poSupplierState || '').trim().toLowerCase();
    if (!c || !s) return false;  // safe default when unknown
    return c !== s;
}
function poCheckGstStates() {
    var banner = document.getElementById('poGstStateBanner');
    var msgEl  = document.getElementById('poGstStateBannerMsg');
    var saveBtn = document.querySelector('[onclick="savePoModal()"]');
    var missing = [];
    if (!(_poCompanyState || '').trim())  missing.push('company billing address state');
    // Only require supplier state if a supplier has actually been picked.
    if (_poSupplierName && !(_poSupplierState || '').trim()) missing.push('supplier state for "' + _poSupplierName + '"');
    if (missing.length) {
        if (banner) banner.style.display = '';
        if (msgEl)  msgEl.innerHTML = 'Please set the ' + missing.join(' and ') + ' before saving. ' +
            (missing[0].indexOf('company') === 0
                ? '<a href="#" onclick="event.preventDefault();openGodownManager()" style="color:#92400e;text-decoration:underline;font-weight:600">Open Godown &amp; Address manager</a>'
                : (_poSupplierName ? '<a href="#" onclick="event.preventDefault();poEditCurrentSupplier()" style="color:#92400e;text-decoration:underline;font-weight:600">Edit supplier</a>' : ''));
        if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '.5'; saveBtn.style.cursor = 'not-allowed'; }
        return false;
    } else {
        if (banner) banner.style.display = 'none';
        if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; saveBtn.style.cursor = ''; }
        return true;
    }
}
/* Open the supplier edit modal for the currently-selected supplier (used by banner link) */
function poEditCurrentSupplier() {
    if (!_poSupplierName) { toast('No supplier selected','error'); return; }
    var s = (_supRows||[]).find(function(r){ return (r.supplier_name||'').toLowerCase() === _poSupplierName.toLowerCase(); });
    if (s && typeof openSupModal === 'function') openSupModal(s);
    else toast('Open Supplier Master and edit "' + _poSupplierName + '" to add state','warning');
}
var _poEditId = null;

function loadPoData() {
    document.getElementById('poTbody').innerHTML =
        '<tr><td colspan="9"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    fetch('/api/procurement/po/list')
        .then(function(r){ return r.json(); })
        .then(function(data) {
            if (data.status !== 'ok') throw new Error(data.message || 'Load failed');
            _poRows = (data.orders || []).map(function(o) {
                return {
                    id:               o.id,
                    po_num:           o.po_num || '—',
                    supplier:         o.supplier_name || '—',
                    supplier_name:    o.supplier_name || '—',
                    material:         '—',
                    item_count:       o.item_count || 0,
                    qty:              null,
                    rate:             null,
                    total:            o.grand_total || null,
                    status:           o.status || 'draft',
                    approval_status:  o.approval_status || 'pending',
                    approved_by:      o.approved_by || '',
                    po_date:          o.po_date || '',
                    expected:         o.delivery_date || '',
                    remarks:          o.remarks || '',
                    pending_items:    o.pending_items || [],
                    voucher_type_name: o.voucher_type_name || ''
                };
            });
            var b = document.getElementById('poBadge');
            if (b) { b.textContent = _poRows.length; b.style.display = _poRows.length ? '' : 'none'; }
            poApplyFilters();
        })
        .catch(function(err) {
            document.getElementById('poTbody').innerHTML =
                '<tr><td colspan="9"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>' + escHtml(err.message) + '</p></div></td></tr>';
        });
}

function poSetFilter(f) {
    _poFilter = f;
    // Update "All" pill
    var allPill = document.getElementById('poFAll');
    if (allPill) allPill.classList.toggle('active', f === 'all');
    // Update dropdown button label
    var labels = {all:'', open:'Open', approved:'Approved', not_approved:'Not Approved', partial:'Partial', closed:'Closed', cancelled:'Cancelled'};
    var lbl = document.getElementById('poFilterLabel');
    if (lbl) lbl.textContent = labels[f] || '';
    var dropBtn = document.getElementById('poFilterDropBtn');
    if (dropBtn) dropBtn.classList.toggle('active', f !== 'all');
    _poPage = 1; poApplyFilters();
}

function poToggleFilterDrop(e) {
    var drop = document.getElementById('poFilterDrop');
    if (!drop) return;
    var showing = drop.style.display !== 'none';
    drop.style.display = showing ? 'none' : 'block';
    if (e) e.stopPropagation();
}

document.addEventListener('click', function(e) {
    var drop = document.getElementById('poFilterDrop');
    if (drop && drop.style.display !== 'none') {
        var container = drop.parentElement;
        if (container && !container.contains(e.target)) drop.style.display = 'none';
    }
    // Also close material dropdowns
    ['matExcelDrop','matAssignDrop','matFilterDrop'].forEach(function(id) {
        var d = document.getElementById(id);
        if (d && d.style.display !== 'none') {
            var c = d.parentElement;
            if (c && !c.contains(e.target)) d.style.display = 'none';
        }
    });
});

function poApplyFilters() {
    var q = (document.getElementById('poSearchInput').value || '').toLowerCase();
    _poFiltered = _poRows.filter(function(r) {
        if (_poFilter !== 'all' && r.status !== _poFilter) return false;
        if (!q) return true;
        // Search across all useful text fields
        var haystack = [
            r.po_num||'',
            r.supplier||'',
            r.supplier_name||'',
            r.material||'',
            r.remarks||'',
            r.po_date||'',
            r.status||''
        ].join(' ').toLowerCase();
        return haystack.includes(q);
    });
    document.getElementById('poRowBadge').textContent = _poFiltered.length + ' orders';
    _poPage = 1; poRenderTable();
}

function poRenderTable() {
    var ps = _poPageSize === 0 ? _poFiltered.length : _poPageSize;
    var start = (_poPage - 1) * ps;
    var rows = ps ? _poFiltered.slice(start, start + ps) : _poFiltered;
    if (!rows.length) {
        document.getElementById('poTbody').innerHTML =
            '<tr><td colspan="11"><div class="state-box"><div class="state-icon">🛒</div><h3>No Purchase Orders</h3><p>Materials with suppliers will appear here.</p></div></td></tr>';
    } else {
        document.getElementById('poTbody').innerHTML = rows.map(function(r, i) {
            var total = r.total ? '₹ ' + parseFloat(r.total).toLocaleString('en-IN', {maximumFractionDigits: 2}) : '—';
            var statusCls = {open:'pending', approved:'received', not_approved:'draft', partial:'partial', closed:'received', cancelled:'cancelled'}[r.status] || 'pending';
            var statusLabel = (r.status === 'draft' ? 'open' : (r.status||'open')).replace('_',' ').toUpperCase();
            var absIdx = start + i;
            var poDateFmt = r.po_date ? fmtDate(r.po_date) : '—';
            var expFmt    = r.expected ? fmtDate(r.expected) : '—';
            var isCancelled = r.status === 'cancelled';
            var isClosed    = r.status === 'closed';
            var isLocked    = isCancelled || isClosed;  // no edit/cancel/delete
            return '<tr data-po-idx="' + absIdx + '" ondblclick="openPoModalByIdx(' + absIdx + ')" style="cursor:pointer;' + (isCancelled ? 'opacity:0.6;' : '') + '" title="' + (isClosed ? 'Closed — double-click to view & print' : isCancelled ? 'Cancelled' : 'Double-click to edit') + '">'
                + '<td style="width:36px;text-align:center;padding:6px 8px" onclick="event.stopPropagation()">'
                +   '<input type="checkbox" class="po-grn-cb" data-idx="' + absIdx + '" data-supplier="' + escHtml((r.supplier||r.supplier_name||'').toLowerCase()) + '" data-id="' + r.id + '"'
                +   (isLocked ? ' disabled title="' + (isClosed ? 'Closed PO' : 'Cancelled PO') + ' cannot be added to GRN"' : ' onclick="poGrnCbChange(this)"')
                +   ' style="cursor:pointer;width:15px;height:15px">'
                + '</td>'
                + '<td class="td-sr">' + (absIdx + 1) + '</td>'
                + '<td style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:' + (isCancelled ? 'var(--muted)' : 'var(--teal)') + '">' + escHtml(r.po_num) + (isCancelled ? ' <span style="font-size:9px;font-weight:400">(blank)</span>' : '') + '</td>'
                + '<td style="font-weight:600">' + escHtml(r.supplier || r.supplier_name || '—') + '</td>'
                + '<td style="font-size:12px">'
                + (function() {
                    var base = r.item_count ? r.item_count + ' item(s)' : escHtml(r.material || '—');
                    // For partial POs show pending items inline
                    if ((r.status === 'partial') && r.pending_items && r.pending_items.length) {
                        var tooltip = r.pending_items.map(function(p) {
                            return p.material + ': ' + parseFloat(p.pending_qty).toLocaleString('en-IN', {maximumFractionDigits:3}) + ' pending';
                        }).join('\n');
                        return '<div title="' + escHtml(tooltip) + '" style="cursor:help">'
                            + base
                            + '<div style="font-size:9.5px;color:var(--muted);margin-top:2px;font-style:italic">↷ Hover to see pending qty</div>'
                            + '</div>';
                    }
                    // For fully closed POs show all received
                    if (r.status === 'closed' && r.item_count) {
                        return '<div>' + base + '</div>'
                            + '<div style="font-size:10.5px;color:var(--green-text,#16a34a);margin-top:2px">✓ Fully received</div>';
                    }
                    return base;
                  })()
                + '</td>'
                + '<td class="td-mono" style="font-weight:600">' + total + '</td>'
                + '<td><span class="po-status ' + statusCls + '">' + statusLabel + '</span></td>'
                + '<td class="td-mono" style="color:var(--muted)">' + poDateFmt + '</td>'
                + '<td class="td-mono" style="color:var(--muted)">' + expFmt + '</td>'
                + '<td style="font-size:11px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(r.remarks || '—') + '</td>'
                + '<td style="white-space:nowrap">'
                +   (isClosed
                        ? '<button class="act-btn" style="padding:4px 10px;font-size:11px" onclick="event.stopPropagation();openPoModalByIdx(' + absIdx + ')">🖨 View &amp; Print</button>'
                        : isCancelled
                            ? '<button class="act-btn" style="padding:4px 10px;font-size:11px;margin-right:4px" onclick="event.stopPropagation();openPoModalByIdx(' + absIdx + ')">↩ Reuse</button>'
                            : '<button class="act-btn" style="padding:4px 10px;font-size:11px;margin-right:4px" onclick="event.stopPropagation();openPoModalByIdx(' + absIdx + ')">✎ Edit</button>'
                                + '<button class="act-btn" style="padding:4px 8px;font-size:11px;margin-right:4px;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3);color:var(--amber-text)" onclick="event.stopPropagation();poCancelRow(' + absIdx + ')" title="Cancel PO">✕ Cancel</button>'
                                + '<button class="act-btn" style="padding:4px 10px;font-size:11px;background:rgba(244,63,94,.08);border-color:rgba(244,63,94,.3);color:var(--red-text)" onclick="event.stopPropagation();poDeleteRow(' + absIdx + ')">✕</button>'
                    )
                + '</td>'
                + '</tr>';
        }).join('');
    }
    // Reset select-all checkbox
    var sa = document.getElementById('poSelectAll');
    if (sa) sa.checked = false;
    poUpdateGrnBtn();
    // Pagination
    var total = _poFiltered.length;
    var tp = _poPageSize === 0 ? 1 : Math.max(1, Math.ceil(total / _poPageSize));
    var s = _poPageSize === 0 ? 1 : (_poPage - 1) * _poPageSize + 1;
    var e = _poPageSize === 0 ? total : Math.min(_poPage * _poPageSize, total);
    document.getElementById('poPgInfo').textContent = total === 0 ? 'No orders' : s + '–' + e + ' of ' + total;
    var wrap = document.getElementById('poPgButtons');
    if (tp <= 1) { wrap.innerHTML = ''; return; }
    var h = '<button class="pg-btn" onclick="poGoPage(' + (_poPage - 1) + ')" ' + (_poPage === 1 ? 'disabled' : '') + '>‹</button>';
    for (var p = 1; p <= Math.min(tp, 7); p++) h += '<button class="pg-page-btn ' + (p === _poPage ? 'active' : '') + '" onclick="poGoPage(' + p + ')">' + p + '</button>';
    h += '<button class="pg-btn" onclick="poGoPage(' + (_poPage + 1) + ')" ' + (_poPage === tp ? 'disabled' : '') + '>›</button>';
    wrap.innerHTML = h;
}

/* ── GRN Selection Logic ── */
function poGrnCbChange(cb) {
    var checked = document.querySelectorAll('.po-grn-cb:checked');
    if (!checked.length) { poUpdateGrnBtn(); return; }
    // Enforce same-supplier rule
    var firstSup = checked[0].dataset.supplier;
    var allSame  = Array.from(checked).every(function(c){ return c.dataset.supplier === firstSup; });
    if (!allSame) {
        cb.checked = false;
        toast('All selected POs must belong to the same supplier', 'error', 3500);
        poUpdateGrnBtn();
        return;
    }
    poUpdateGrnBtn();
}

function poToggleSelectAll(masterCb) {
    var cbs = document.querySelectorAll('.po-grn-cb:not(:disabled)');
    // Determine dominant supplier if any already checked
    var firstChecked = document.querySelector('.po-grn-cb:checked');
    var filterSup = firstChecked ? firstChecked.dataset.supplier : null;

    cbs.forEach(function(cb){
        if (masterCb.checked) {
            // Only select same supplier
            if (!filterSup || cb.dataset.supplier === filterSup) {
                cb.checked = true;
                filterSup = filterSup || cb.dataset.supplier;
            }
        } else {
            cb.checked = false;
        }
    });
    poUpdateGrnBtn();
}

function poUpdateGrnBtn() {
    var checked = document.querySelectorAll('.po-grn-cb:checked');
    var btn     = document.getElementById('poCreateGrnBtn');
    var cntEl   = document.getElementById('poGrnSelCount');
    if (!btn) return;
    if (checked.length > 0) {
        btn.style.display = 'inline-flex';
        if (cntEl) cntEl.textContent = checked.length;
    } else {
        btn.style.display = 'none';
    }
}

async function poCreateGrnFromSelected() {
    var checked  = document.querySelectorAll('.po-grn-cb:checked');
    if (!checked.length) { toast('Select at least one PO', 'error'); return; }

    // Validate same supplier
    var suppliers = Array.from(checked).map(function(c){ return c.dataset.supplier; });
    if (new Set(suppliers).size > 1) {
        toast('All selected POs must belong to the same supplier', 'error', 3500);
        return;
    }

    // Collect selected PO ids and fetch items for each
    var poIds    = Array.from(checked).map(function(c){ return parseInt(c.dataset.id); });
    var poObjs   = poIds.map(function(id){ return _poRows.find(function(r){ return r.id === id; }); }).filter(Boolean);
    var supplier = poObjs[0] ? (poObjs[0].supplier || poObjs[0].supplier_name || '') : '';

    toast('Loading PO items…', 'info', 2000);

    // Fetch full items for all selected POs in parallel
    try {
        var fetches  = poIds.map(function(id){ return fetch('/api/procurement/po/get?id='+id).then(function(r){ return r.json(); }); });
        var results  = await Promise.all(fetches);
        var allLines = [];
        results.forEach(function(d, i){
            if (d.status !== 'ok') return;
            var o = d.order;
            (o.items||[]).forEach(function(item){
                // Check if same material already in list (merge from multiple POs)
                var existing = allLines.find(function(l){ return l.material.toLowerCase() === (item.material||'').toLowerCase(); });
                if (existing) {
                    existing.po_qty       = (parseFloat(existing.po_qty)||0)       + (parseFloat(item.qty)||0);
                    existing.received_qty = (parseFloat(existing.received_qty)||0) + (parseFloat(item.qty)||0);
                } else {
                    var mr = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(item.material||'').toLowerCase(); });
                    allLines.push({
                        material:     item.material||'',
                        po_qty:       parseFloat(item.qty)||0,
                        received_qty: parseFloat(item.qty)||0,
                        rate:         parseFloat(item.rate)||0,
                        hsn_code:     item.hsn_code || (mr&&mr.hsn_code||''),
                        gst_rate:     item.gst_rate != null ? parseFloat(item.gst_rate) : (mr&&mr.gst_rate!=null?parseFloat(mr.gst_rate):0)
                    });
                }
            });
        });

        // Build the linked PO reference (first PO if single, else note multiple)
        var linkedPoId  = poIds.length === 1 ? poIds[0] : null;
        var linkedPoNum = poIds.length === 1 ? (poObjs[0]&&poObjs[0].po_num||'') : '';

        // Switch to GRN tab and open form with prefilled data
        switchTab('grn'); setSidebarActive('grn');
        setTimeout(function(){
            openGrnFormWithData({
                supplier_name: supplier,
                po_id:         linkedPoId,
                po_num:        linkedPoNum,
                items:         allLines,
                _selectedPoIds: poIds
            });
        }, 150);

    } catch(e) {
        toast('Failed to load PO items: '+e.message, 'error');
    }
}
function poGoPage(p) { _poPage = Math.max(1, Math.min(p, Math.ceil(_poFiltered.length / (_poPageSize || 1)))); poRenderTable(); }
function poOnPageSizeChange() { _poPageSize = parseInt(document.getElementById('poPgSizeSelect').value); _poPage = 1; poRenderTable(); }

/* ── PO line items helpers ── */
var _poLines = [];

function poAddLine(mat, qty, rate) {
    _poLines.push({ material: mat||'', qty: qty||'', rate: rate||'' });
    var newIdx = _poLines.length - 1;
    poRenderLines(newIdx);
}

/* Recalculate total qty from pkgs × qty_per_pkg */
function poCalcLineTotal(idx) {
    var qtyEl   = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-qty-inp');
    if (!qtyEl) return;
    var qty = parseFloat(qtyEl.value) || 0;
    _poLines[idx].qty = qtyEl.value;
    // Keep these in sync with qty for backward compat with anything reading them
    _poLines[idx].total_qty   = qty;
    _poLines[idx].qty_per_pkg = qty;
    _poLines[idx].packages    = qty > 0 ? 1 : null;
    // Recalc amount (net of per-line discount)
    var rt  = parseFloat(_poLines[idx].rate) || 0;
    var disc = parseFloat(_poLines[idx].discount) || 0;
    if (disc < 0) disc = 0; if (disc > 100) disc = 100;
    var amt = qty * rt * (1 - disc/100);
    var aCell = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-amt-cell');
    if (aCell) {
        aCell.textContent = amt > 0 ? '\u20b9\u00a0' + amt.toLocaleString('en-IN',{maximumFractionDigits:2}) : '\u2014';
        aCell.style.color = amt > 0 ? 'var(--text)' : 'var(--muted)';
    }
    poCalcGrandTotal();
}

function poRemoveLine(idx) { _poLines.splice(idx, 1); poRenderLines(); }
function poLineChange(idx, field, val) { _poLines[idx][field] = val; poCalcGrandTotal(); }

/* ── Custom autocomplete dropdown for PO material fields ── */
var _poAcActive = -1;

function poMatSearch(idx, q) {
    var dd = document.getElementById('poAcDd_' + idx);
    if (!dd) return;
    if (!q || q.length < 1) { dd.style.display = 'none'; return; }
    var ql = q.toLowerCase();
    var results = (_allRows || []).filter(function(r) {
        if ((r.material_name || '').toLowerCase().indexOf(ql) >= 0) return true;
        if (r.aliases) return r.aliases.toLowerCase().split(',').some(function(a){ return a.trim().indexOf(ql) >= 0; });
        return false;
    }).slice(0, 35);
    if (!results.length) { dd.style.display = 'none'; return; }
    dd.innerHTML = results.map(function(r) {
        var esc = escHtml(r.material_name);
        var rateStr = r.last_purchase_rate != null
            ? '<span style="float:right;color:var(--teal);font-family:var(--font-mono);font-size:11px;font-weight:700">\u20b9' + r.last_purchase_rate + '</span>'
            : '';
        var aliasTip = '';
        if (r.aliases && (r.material_name||'').toLowerCase().indexOf(ql) < 0) {
            var matched = r.aliases.split(',').find(function(a){ return a.trim().toLowerCase().indexOf(ql) >= 0; });
            if (matched) aliasTip = '<div style="font-size:9.5px;color:var(--teal);font-style:italic">aka: ' + escHtml(matched.trim()) + '</div>';
        }
        var descStr = r.description ? '<div style="font-size:9.5px;color:var(--muted);font-style:italic;margin-top:1px">' + escHtml(r.description) + '</div>' : '';
        return '<div class="po-ac-item"'
            + ' data-idx="' + idx + '"'
            + ' data-name="' + esc + '"'
            + ' data-rate="' + (r.last_purchase_rate != null ? r.last_purchase_rate : '') + '"'
            + ' data-sup="' + escHtml(r.supplier_name || '') + '">'
            + rateStr + esc + aliasTip + descStr + '</div>';
    }).join('');
    dd.style.display = 'block';
    _poAcActive = idx;
}

function poMatPick(idx, name, rate, supplier) {
    _poLines[idx].material = name;

    /* If dropdown has rate, use it immediately */
    var hasRate = rate !== '' && rate != null && parseFloat(rate) > 0;
    if (hasRate) {
        _poLines[idx].rate = String(rate);
    }

    /* Update material input */
    var mInp = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-mat-inp');
    if (mInp) mInp.value = name;

    /* Update rate input */
    var rInp = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-rate-inp');
    if (rInp && hasRate) {
        rInp.value = rate;
        rInp.style.borderColor = '';
        rInp.style.background = '';
        rInp.style.color = '';
    }

    /* Update amount cell */
    var qty = parseFloat(_poLines[idx].qty) || 0;
    var rt  = parseFloat(_poLines[idx].rate) || 0;
    var disc = parseFloat(_poLines[idx].discount) || 0;
    if (disc < 0) disc = 0; if (disc > 100) disc = 100;
    var amt = qty * rt * (1 - disc/100);
    var aCell = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-amt-cell');
    if (aCell) {
        aCell.textContent = amt > 0
            ? '\u20b9\u00a0' + amt.toLocaleString('en-IN', {maximumFractionDigits: 2})
            : '\u2014';
        aCell.style.color = amt > 0 ? 'var(--text)' : 'var(--muted)';
    }
    poCalcGrandTotal();

    /* Set UOM from material master */
    var matRow = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase() === name.toLowerCase(); });
    var uom = matRow ? (matRow.uom || 'KG') : 'KG';
    _poLines[idx].uom = uom;
    var uomEl = document.getElementById('poUom_' + idx);
    if (uomEl) uomEl.textContent = uom;

    /* Auto-fill supplier */
    if (supplier) {
        var supEl = document.getElementById('poModalSupplier');
        if (supEl && !supEl.value) {
            supEl.value = supplier;
            if (typeof poFillSupplierDetails === 'function') poFillSupplierDetails(supplier);
        }
    }

    /* Close dropdown and move focus to qty */
    var dd = document.getElementById('poAcDd_' + idx);
    if (dd) dd.style.display = 'none';
    _poAcActive = -1;

    /* If no rate yet — fetch last used rate from server (po_items history) */
    if (!hasRate) {
        fetch('/api/procurement/po/last_rate?material=' + encodeURIComponent(name))
            .then(function(r){ return r.json(); })
            .then(function(d){
                if (d.status === 'ok' && d.rate && parseFloat(d.rate) > 0) {
                    var fetchedRate = parseFloat(d.rate);
                    _poLines[idx].rate = String(fetchedRate);
                    var rInp2 = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-rate-inp');
                    if (rInp2) {
                        rInp2.value = fetchedRate;
                        rInp2.style.borderColor = '';
                        rInp2.style.background  = '';
                        rInp2.style.color       = '';
                    }
                    var qty2 = parseFloat(_poLines[idx].qty) || 0;
                    var amt2 = qty2 * fetchedRate;
                    var aCell2 = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-amt-cell');
                    if (aCell2) {
                        aCell2.textContent = amt2 > 0
                            ? '\u20b9\u00a0' + amt2.toLocaleString('en-IN',{maximumFractionDigits:2})
                            : '\u2014';
                        aCell2.style.color = amt2 > 0 ? 'var(--text)' : 'var(--muted)';
                    }
                    poCalcGrandTotal();
                } else {
                    /* Still no rate — focus the rate field so user can type */
                    setTimeout(function() {
                        var rInp3 = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-rate-inp');
                        if (rInp3) rInp3.focus();
                    }, 60);
                }
            })
            .catch(function(){
                setTimeout(function() {
                    var qInp = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-qty-inp');
                    if (qInp) qInp.focus();
                }, 40);
            });
        return; /* don't focus qty yet — wait for rate fetch */
    }

    setTimeout(function() {
        var qInp = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-qty-inp');
        if (qInp) qInp.focus();
    }, 40);
}

/* mousedown so it fires before blur closes the dropdown */
document.addEventListener('mousedown', function(e) {
    var item = e.target.closest('.po-ac-item');
    if (!item) return;
    e.preventDefault();
    poMatPick(
        parseInt(item.dataset.idx),
        item.dataset.name,
        item.dataset.rate,
        item.dataset.sup
    );
});

/* Close all dropdowns on outside click */
document.addEventListener('click', function(e) {
    var delBtn = e.target.closest('.po-li-del');
    if (delBtn) { poRemoveLine(parseInt(delBtn.dataset.li)); return; }
    if (!e.target.closest('#poLinesTbody') && !e.target.closest('.po-ac-dd')) {
        document.querySelectorAll('.po-ac-dd').forEach(function(d) { d.style.display = 'none'; });
        _poAcActive = -1;
    }
});

function poRenderLines(focusIdx) {
    var tb = document.getElementById('poLinesTbody');
    if (!tb) return;
    if (!_poLines.length) {
        tb.innerHTML = '<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No items \u2014 click &ldquo;+ Add Item&rdquo; above</td></tr>';
        document.getElementById('poLineCount').textContent = '0 items';
        document.getElementById('poGrandTotal').textContent = '\u2014';
        return;
    }
    var IS = 'width:100%;height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-body);outline:none;font-size:12.5px';
    var MS = IS + ';font-family:var(--font-mono);text-align:right';
    tb.innerHTML = _poLines.map(function(line, i) {
        var gstPct = line.gst_rate != null ? parseFloat(line.gst_rate) : 0;
        // Look up GST% from material master if not on line
        if (!gstPct && line.material && _allRows && _allRows.length) {
            var mr = _allRows.find(function(r){ return (r.material_name||'').toLowerCase() === line.material.toLowerCase(); });
            if (mr && mr.gst_rate != null) gstPct = parseFloat(mr.gst_rate);
        }
        var gstStr = gstPct > 0 ? gstPct + '%' : '\u2014';
        var discPct = parseFloat(line.discount) || 0;
        var amt = (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0) * (1 - discPct/100);
        var amtStr = amt > 0 ? '\u20b9\u00a0' + amt.toLocaleString('en-IN', {maximumFractionDigits: 2}) : '\u2014';
        var amtCol = amt > 0 ? 'var(--text)' : 'var(--muted)';
        return '<tr style="border-bottom:1px solid var(--border);background:' + (i % 2 ? 'var(--surface2)' : 'var(--surface)') + '" data-li="' + i + '">'
            + '<td style="padding:7px 10px;color:var(--muted);font-size:11px;width:32px;text-align:center">' + (i + 1) + '</td>'
            + '<td style="padding:4px 8px;position:relative">'
            +   '<input class="po-li-inp po-mat-inp" data-li="' + i + '" data-field="material" autocomplete="off" value="' + escHtml(line.material) + '" placeholder="Type material name\u2026" style="' + IS + ';width:100%;min-width:200px">'
            +   '<div id="poAcDd_' + i + '" class="po-ac-dd" style="display:none;position:absolute;top:100%;left:0;right:0;min-width:100%;background:var(--surface);border:1px solid var(--border2);border-top:none;border-radius:0 0 8px 8px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:9999;max-height:220px;overflow-y:auto;font-size:12.5px"></div>'
            + '</td>'
            + '<td style="padding:4px 8px;width:140px"><input type="number" class="po-li-inp po-qty-inp" data-li="' + i + '" data-field="qty" value="' + (line.qty || '') + '" placeholder="0.000" min="0" step="0.001" style="' + MS + ';width:100%" oninput="poCalcLineTotal(' + i + ')"></td>'
            + '<td style="padding:4px 8px;width:55px;text-align:center"><span id="poUom_' + i + '" style="font-size:11.5px;font-weight:600;color:var(--muted);display:block;padding:6px 0">' + escHtml(line.uom||'KG') + '</span></td>'
            + '<td style="padding:4px 8px;width:130px"><input type="number" class="po-li-inp po-rate-inp po-li-calc" data-li="' + i + '" data-field="rate" value="' + (line.rate || '') + '" placeholder="Enter rate" min="0" step="0.0001" style="' + MS + ';width:100%' + (line.material && (!line.rate || parseFloat(line.rate) === 0) ? ';border-color:var(--amber);background:var(--amber-bg);color:var(--amber-text)' : '') + '"></td>'
            + '<td style="padding:4px 8px;width:80px"><input type="number" class="po-li-inp po-disc-inp po-li-calc" data-li="' + i + '" data-field="discount" value="' + (line.discount || '') + '" placeholder="0" min="0" max="100" step="0.01" title="Discount %" style="' + MS + ';width:100%"></td>'
            + '<td style="padding:7px 8px;text-align:center;width:72px;font-family:var(--font-mono);font-size:12px;color:' + (gstPct > 0 ? 'var(--text)' : 'var(--muted)') + '">' + gstStr + '</td>'
            + '<td class="po-amt-cell" style="padding:8px 12px;text-align:right;font-family:var(--font-mono);font-size:13px;font-weight:700;white-space:nowrap;color:' + amtCol + '">' + amtStr + '</td>'
            + '<td style="padding:4px 8px;text-align:center;width:36px"><button class="po-li-del" data-li="' + i + '" style="width:24px;height:24px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center">\u00d7</button></td>'
            + '</tr>';
    }).join('');
    document.getElementById('poLineCount').textContent = _poLines.length + ' item' + (_poLines.length !== 1 ? 's' : '');
    poCalcGrandTotal();
    if (focusIdx != null) {
        setTimeout(function() {
            var inp = document.querySelector('#poLinesTbody tr[data-li="' + focusIdx + '"] .po-mat-inp');
            if (inp) inp.focus();
        }, 40);
    }
}

/* Input delegation for PO line items */
document.addEventListener('input', function(e) {
    var inp = e.target;
    if (!inp.classList.contains('po-li-inp')) return;
    var idx   = parseInt(inp.dataset.li);
    var field = inp.dataset.field;
    _poLines[idx][field] = inp.value;
    if (inp.classList.contains('po-mat-inp')) {
        poMatSearch(idx, inp.value);
        return;
    }
    if (inp.classList.contains('po-li-calc')) {
        var qty = parseFloat(_poLines[idx].qty) || 0;
        var rt  = parseFloat(_poLines[idx].rate) || 0;
        var disc = parseFloat(_poLines[idx].discount) || 0;
        if (disc < 0) disc = 0; if (disc > 100) disc = 100;
        var amt = qty * rt * (1 - disc/100);
        var aCell = document.querySelector('#poLinesTbody tr[data-li="' + idx + '"] .po-amt-cell');
        if (aCell) {
            aCell.textContent = amt > 0 ? '\u20b9\u00a0' + amt.toLocaleString('en-IN', {maximumFractionDigits: 2}) : '\u2014';
            aCell.style.color = amt > 0 ? 'var(--text)' : 'var(--muted)';
        }
        poCalcGrandTotal();
    }
});
document.addEventListener('focus', function(e) {
    if (e.target.classList.contains('po-li-inp')) e.target.style.borderColor = '#2563eb';
    if (e.target.classList.contains('po-mat-inp') && _poLines[parseInt(e.target.dataset.li)]) {
        if (e.target.value) poMatSearch(parseInt(e.target.dataset.li), e.target.value);
    }
}, true);
document.addEventListener('blur', function(e) {
    if (e.target.classList.contains('po-li-inp')) e.target.style.borderColor = '';
}, true);

/* Keyboard navigation inside PO material autocomplete */
var _poAcIdx = -1;  // highlighted item index inside dropdown
document.addEventListener('keydown', function(e) {
    if (!e.target.classList.contains('po-mat-inp')) return;
    var idx = parseInt(e.target.dataset.li);
    var dd  = document.getElementById('poAcDd_' + idx);
    if (!dd || dd.style.display === 'none') {
        if (e.key === 'ArrowDown') { e.preventDefault(); poMatSearch(idx, e.target.value); }
        return;
    }
    var items = dd.querySelectorAll('.po-ac-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _poAcIdx = Math.min(_poAcIdx + 1, items.length - 1);
        items.forEach(function(it, i) { it.classList.toggle('active', i === _poAcIdx); });
        if (items[_poAcIdx]) items[_poAcIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _poAcIdx = Math.max(_poAcIdx - 1, 0);
        items.forEach(function(it, i) { it.classList.toggle('active', i === _poAcIdx); });
        if (items[_poAcIdx]) items[_poAcIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (_poAcIdx >= 0 && items[_poAcIdx]) {
            e.preventDefault();
            var item = items[_poAcIdx];
            poMatPick(parseInt(item.dataset.idx), item.dataset.name, item.dataset.rate, item.dataset.sup);
            _poAcIdx = -1;
        } else if (e.key === 'Enter' && items.length === 1) {
            e.preventDefault();
            var item = items[0];
            poMatPick(parseInt(item.dataset.idx), item.dataset.name, item.dataset.rate, item.dataset.sup);
            _poAcIdx = -1;
        }
    } else if (e.key === 'Escape') {
        dd.style.display = 'none';
        _poAcIdx = -1;
        e.stopPropagation();  // don't close PO modal
    }
}, true);

/* Reset highlight index when search results change */
var _origPoMatSearch = poMatSearch;
poMatSearch = function(idx, q) {
    _poAcIdx = -1;
    _origPoMatSearch(idx, q);
};

function poLineAutoFill() {} /* replaced by poMatPick */
function poCalcGrandTotal() {
    var inter = poIsInterState();
    var totalCGST = 0, totalSGST = 0, totalIGST = 0;
    // Read overall order-level discount (₹ off the whole order)
    var odEl = document.getElementById('poOrderDiscount');
    var orderDisc = (odEl && odEl.value) ? (parseFloat(odEl.value) || 0) : 0;
    if (orderDisc < 0) orderDisc = 0;
    // Freight / packing charges
    var freightEl = document.getElementById('poFreightAmt');
    var packingEl = document.getElementById('poPackingAmt');
    var freight   = (freightEl && !freightEl.disabled) ? (parseFloat(freightEl.value) || 0) : 0;
    var packing   = (packingEl && !packingEl.disabled) ? (parseFloat(packingEl.value) || 0) : 0;

    // 1) Items subtotal = sum of line amounts (each already net of its per-line disc%)
    var itemsSubtotal = 0;
    var lineNet = _poLines.map(function(l){
        var d = parseFloat(l.discount) || 0;
        if (d < 0) d = 0; if (d > 100) d = 100;
        var amt = (parseFloat(l.qty)||0)*(parseFloat(l.rate)||0)*(1 - d/100);
        itemsSubtotal += amt;
        return amt;
    });
    // 2) Taxable base = items + freight + packing − order discount
    if (orderDisc > itemsSubtotal + freight + packing) orderDisc = itemsSubtotal + freight + packing;
    var taxable = itemsSubtotal + freight + packing - orderDisc;
    if (taxable < 0) taxable = 0;
    // 3) GST on the taxable base. Freight/packing/discount are spread across the
    //    item lines proportionally, so each line is taxed at its own GST rate.
    //    addBase = freight + packing − discount, distributed by each line's share.
    var addBase = freight + packing - orderDisc;
    _poLines.forEach(function(l, i){
        var base = lineNet[i];
        if (itemsSubtotal > 0) base += addBase * (lineNet[i] / itemsSubtotal);
        if (base <= 0) return;
        // Resolve GST% exactly like the row renderer and print builder do:
        // use the line's gst_rate, but if it's missing OR zero, fall back to the
        // material master (_allRows). This keeps the live Grand Total in lock-step
        // with the printed Total.
        var gstPct = parseFloat(l.gst_rate) || 0;
        if (!gstPct && l.material && _allRows && _allRows.length) {
            var mat = _allRows.find(function(r){ return (r.material_name||'').toLowerCase()===(l.material||'').trim().toLowerCase(); });
            if (mat && mat.gst_rate != null) gstPct = parseFloat(mat.gst_rate) || 0;
        }
        if (gstPct > 0 && gstPct < 1) gstPct = gstPct * 100;
        if (gstPct > 0) {
            if (inter) {
                totalIGST += Math.round(base*gstPct/100*100)/100;
            } else {
                var half = Math.round(base*(gstPct/2)/100*100)/100;
                totalCGST += half; totalSGST += half;
            }
        }
    });
    var grand = taxable + totalCGST + totalSGST + totalIGST;
    var fi = function(n){ return '\u20b9 '+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.textContent=v; };
    var sd = function(id,show){ var e=document.getElementById(id); if(e) e.style.display=show?'':'none'; };
    // Summary rows, in order: Items Subtotal → Freight → Packing → Discount → Taxable
    var hasExtras = (freight>0 || packing>0 || orderDisc>0);
    sv('poFootGross',     itemsSubtotal>0 ? fi(itemsSubtotal) : '\u2014');
    sd('poFootRowGross',  hasExtras && itemsSubtotal>0);
    sv('poFootFreightSum', freight>0 ? fi(freight) : '\u2014');
    sd('poFootRowFreightSum', freight>0);
    sv('poFootPackingSum', packing>0 ? fi(packing) : '\u2014');
    sd('poFootRowPackingSum', packing>0);
    sv('poFootOrderDisc', orderDisc>0 ? '- '+fi(orderDisc) : '\u2014');
    sd('poFootRowOrderDisc', orderDisc>0);
    sv('poFootTaxable',  taxable>0   ? fi(taxable)   : '\u2014');
    sv('poFootCGST',     totalCGST>0 ? fi(totalCGST) : '\u2014');
    sv('poFootSGST',     totalSGST>0 ? fi(totalSGST) : '\u2014');
    sv('poFootIGST',     totalIGST>0 ? fi(totalIGST) : '\u2014');
    sv('poGrandTotal',   grand>0     ? fi(grand)     : '\u2014');
    sd('poFootRowCGST',  totalCGST>0);
    sd('poFootRowSGST',  totalSGST>0);
    sd('poFootRowIGST',  totalIGST>0);
}

/* Toggle freight/packing charge input on/off */
function poToggleCharge(type) {
    var cb  = document.getElementById('po' + (type==='freight' ? 'Freight' : 'Packing') + 'Enabled');
    var inp = document.getElementById('po' + (type==='freight' ? 'Freight' : 'Packing') + 'Amt');
    if (!cb || !inp) return;
    inp.disabled    = !cb.checked;
    inp.style.opacity = cb.checked ? '1' : '.4';
    if (cb.checked) { inp.focus(); } else { inp.value = ''; }
    poCalcGrandTotal();
}

function poLineAutoFill(idx, matName) {
    var typed = (matName||'').trim();
    if (!typed) return;
    var typedLow = typed.toLowerCase();
    var m = (_allRows||[]).find(function(r){
        return (r.material_name||'').toLowerCase() === typedLow;
    });
    var localRate = m && m.last_purchase_rate != null && parseFloat(m.last_purchase_rate) > 0
        ? parseFloat(m.last_purchase_rate) : 0;

    if (localRate > 0) {
        _poFillRate(idx, localRate);
        /* Also fill supplier */
        var supEl = document.getElementById('poModalSupplier');
        if (supEl && !supEl.value && m && m.supplier_name && m.supplier_name !== '\u2014') {
            supEl.value = m.supplier_name;
            if (typeof poFillSupplierDetails === 'function') poFillSupplierDetails(m.supplier_name);
        }
    } else {
        /* No local rate — ask server */
        fetch('/api/procurement/po/last_rate?material=' + encodeURIComponent(typed))
            .then(function(r){ return r.json(); })
            .then(function(d){
                if (d.status === 'ok' && d.rate && parseFloat(d.rate) > 0) {
                    _poFillRate(idx, parseFloat(d.rate));
                }
            }).catch(function(){});
    }
}

/* Helper: fill rate field and recalc amount for a line */
function _poFillRate(idx, rate) {
    _poLines[idx].rate = String(rate);
    var rateInp = document.querySelector('#poLinesTbody tr[data-li="'+idx+'"] .po-rate-inp');
    if (rateInp) {
        rateInp.value = rate;
        rateInp.style.borderColor = '';
        rateInp.style.background  = '';
        rateInp.style.color       = '';
    }
    var qty = parseFloat(_poLines[idx].qty) || 0;
    var amt = qty * rate;
    var amtCell = document.querySelector('#poLinesTbody tr[data-li="'+idx+'"] .po-amt-cell');
    if (amtCell) {
        amtCell.textContent = amt > 0
            ? '\u20b9\u00a0' + amt.toLocaleString('en-IN',{maximumFractionDigits:2})
            : '\u2014';
        amtCell.style.color = amt > 0 ? 'var(--text)' : 'var(--muted)';
    }
    poCalcGrandTotal();
}


function openPoModal(row, prefillSupplier, prefillLines) {
    _poEditId = row ? row.id : null;
    document.getElementById('poModalTitle').textContent = row ? 'Edit Purchase Order' : 'New Purchase Order';
    document.getElementById('poModalEyebrow').textContent = row ? 'EDIT PO' : 'NEW PO';
    var supListEl = document.getElementById('poSupplierList');
    if (_supRows.length) {
        supListEl.innerHTML = _supRows.map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
    } else {
        fetch('/api/procurement/suppliers').then(function(r){ return r.json(); }).then(function(d){
            if (d.status==='ok') supListEl.innerHTML=(d.suppliers||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
        }).catch(function(){});
    }
    var today = new Date().toISOString().slice(0,10);
    document.getElementById('poModalNum').value = row ? row.po_num : '';
    if (!row) {
        var _numEl = document.getElementById('poModalNum');
        if (_numEl) { _numEl.placeholder='Auto-assigned on save'; _numEl.style.color='var(--muted)'; _numEl.style.fontStyle='italic'; }
        // Preview next voucher number from active numbering style
        if (typeof _vnPreviewNextPO === 'function') {
            _vnPreviewNextPO(function(preview) {
                var el = document.getElementById('poModalNum');
                if (el && !el.value && preview) el.placeholder = 'Next: ' + preview;
            });
        }
    }
    document.getElementById('poModalDate').value     = today;
    document.getElementById('poModalSupplier').value = row ? row.supplier : (prefillSupplier||'');
    document.getElementById('poModalExpected').value = row ? (row.expected||'') : '';
    document.getElementById('poModalRemarks').value  = row ? (row.remarks||'') : '';
    _poSetStatus(row ? (row.status||'open') : 'open');
    _poLines = [];
    if (prefillLines && prefillLines.length) {
        prefillLines.forEach(function(l){ _poLines.push(l); });
        poRenderLines();
        var _ml = document.getElementById('poMaterialList');
        if (_ml && _allRows && _allRows.length) {
            _ml.innerHTML = _allRows.map(function(r){ return '<option value="'+escHtml(r.material_name)+'">'; }).join('');
        }
        document.getElementById('poModal').classList.add('open');
    } else if (row && row.id) {
        // Fetch full PO with items from API
        poRenderLines();
        document.getElementById('poModal').classList.add('open');
        fetch('/api/procurement/po/get?id=' + row.id)
            .then(function(r){ return r.json(); })
            .then(function(d){
                if (d.status !== 'ok') throw new Error(d.message);
                var o = d.order;
                document.getElementById('poModalNum').value      = o.po_num || '';
                document.getElementById('poModalDate').value     = o.po_date || '';
                document.getElementById('poModalSupplier').value = o.supplier_name || '';
                document.getElementById('poModalExpected').value = o.delivery_date || '';
                document.getElementById('poModalRemarks').value  = o.remarks || '';
                _poSetStatus(o.status || 'open');
                _poLines = (o.items||[]).map(function(i){
                    var mr = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(i.material||'').toLowerCase(); });
                    return {material:i.material||'', qty:i.qty||'', qty_per_pkg:i.qty_per_pkg||i.qty||'', packages:i.packages||'', total_qty:parseFloat(i.qty)||0, rate:i.rate||'', uom:i.uom||(mr&&mr.uom)||'KG'};
                });
                if (!_poLines.length) _poLines.push({material:'',qty:'',qty_per_pkg:'',packages:'',total_qty:0,rate:'',uom:'KG'});
                poRenderLines();
            })
            .catch(function(err){ toast('Could not load PO items: '+err.message,'error'); });
    } else {
        _poLines.push({material:'', qty:'', rate:''});
        poRenderLines();
        // Populate material datalist from material master
        var _ml = document.getElementById('poMaterialList');
        if (_ml && _allRows && _allRows.length) {
            _ml.innerHTML = _allRows.map(function(r){ return '<option value="'+escHtml(r.material_name)+'">'; }).join('');
        }
        document.getElementById('poModal').classList.add('open');
    }
}
function closePoModal() { document.getElementById('poModal').classList.remove('open'); }

async function poClearAllOrders() {
    if (!confirm('ADMIN ACTION\n\nDelete ALL Purchase Orders permanently?\n\nThis cannot be undone.')) return;
    var token = prompt('Type CONFIRM-DELETE to proceed:');
    if (token !== 'CONFIRM-DELETE') { toast('Cancelled — wrong confirmation','info'); return; }
    try {
        var res = await fetch('/api/procurement/admin/reset', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({scope:['purchase_orders'], confirm_token:'CONFIRM-DELETE'})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message||'Failed');
        toast('All Purchase Orders deleted','success');
        loadPoData();
    } catch(e) { toast('Error: '+e.message,'error'); }
}
function openPoModalByIdx(idx) {
    var row = _poFiltered[parseInt(idx)];
    if (!row) return;
    openPoModal(row);
}

async function poDeleteRow(idx) {
    var row = _poFiltered[parseInt(idx)];
    if (!row || !row.id) return;
    if (row.status === 'closed') { toast('Closed POs cannot be deleted', 'error'); return; }
    if (!confirm('Delete PO ' + row.po_num + '?\nThis cannot be undone.')) return;
    try {
        var res = await fetch('/api/procurement/po/delete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id: row.id})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        toast('PO ' + row.po_num + ' deleted', 'success');
        loadPoData();
    } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
}

async function poCancelRow(idx) {
    var row = _poFiltered[parseInt(idx)];
    if (!row || !row.id) return;
    if (row.status === 'closed') { toast('Closed POs cannot be cancelled', 'error'); return; }
    if (!confirm(
        'Cancel PO ' + row.po_num + '?\n\n' +
        'This will clear all line items and details.\n' +
        'The PO number is kept — you can reuse it by clicking Edit/Reuse.'
    )) return;
    try {
        var res = await fetch('/api/procurement/po/cancel', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id: row.id})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        toast('PO ' + row.po_num + ' cancelled — number kept for reuse', 'success', 5000);
        loadPoData();
    } catch(e) { toast('Cancel failed: ' + e.message, 'error'); }
}

function poModalSupplierChange() {
    var sup = document.getElementById('poModalSupplier').value.trim();
    var match = _poRows.find(function(r){ return r.supplier && r.supplier.toLowerCase()===sup.toLowerCase(); });

}
async function savePoModal() {
    var supplier = (document.getElementById('poModalSupplier').value||'').trim();
    if (!supplier) { toast('Supplier name is required','error'); return; }
    var validLines = _poLines.filter(function(l){ return l.material && l.material.trim(); });
    if (!validLines.length) { toast('Add at least one line item','error'); return; }
    var missingRate = validLines.find(function(l){ return !l.rate || parseFloat(l.rate) <= 0; });
    if (missingRate) { toast('Rate (₹/kg) is required for: ' + missingRate.material, 'error'); return; }

    var isNew = !_poEditId;
    // ── Precompute taxable apportionment so GST matches the live form ──
    // GST is charged on (items + freight + packing − discount); freight/packing/
    // discount are spread across the lines proportionally to each line's amount.
    var _svFreight = (function(){ var e=document.getElementById('poFreightAmt'); return (e&&!e.disabled&&e.value) ? (parseFloat(e.value)||0) : 0; })();
    var _svPacking = (function(){ var e=document.getElementById('poPackingAmt'); return (e&&!e.disabled&&e.value) ? (parseFloat(e.value)||0) : 0; })();
    var _svOrderDisc = (function(){ var e=document.getElementById('poOrderDiscount'); return (e&&e.value) ? (parseFloat(e.value)||0) : 0; })();
    if (_svOrderDisc < 0) _svOrderDisc = 0;
    var _svSubtotal = 0;
    validLines.forEach(function(l){
        var d = parseFloat(l.discount)||0; if(d<0)d=0; if(d>100)d=100;
        _svSubtotal += (parseFloat(l.total_qty||l.qty)||0)*(parseFloat(l.rate)||0)*(1-d/100);
    });
    if (_svOrderDisc > _svSubtotal + _svFreight + _svPacking) _svOrderDisc = _svSubtotal + _svFreight + _svPacking;
    var _svAddBase = _svFreight + _svPacking - _svOrderDisc;
    var payload = {
        id:            _poEditId || null,
        po_date:       document.getElementById('poModalDate').value || '',
        supplier_name: supplier,
        status:        (function(){ var s = window._poCurrentStatus || 'open'; return s === 'draft' ? 'open' : s; })(),
        delivery_days: parseInt(document.getElementById('poModalDeliveryDays') ? document.getElementById('poModalDeliveryDays').value : '') || null,
        delivery_date: document.getElementById('poModalExpected').value || '',
        remarks:       document.getElementById('poModalRemarks').value || '',
        tc_list_id:    parseInt(document.getElementById('poModalTCList') ? document.getElementById('poModalTCList').value : '') || null,
        declaration_id: parseInt(document.getElementById('poModalDeclaration') ? document.getElementById('poModalDeclaration').value : '') || null,
        billing_addr:  document.getElementById('poBillingAddr') ? document.getElementById('poBillingAddr').value : '',
        shipping_addr: document.getElementById('poShippingAddr') ? document.getElementById('poShippingAddr').value : '',
        freight_charge: (function(){ var e=document.getElementById('poFreightAmt'); return (e&&!e.disabled&&e.value) ? parseFloat(e.value)||null : null; })(),
        packing_charge: (function(){ var e=document.getElementById('poPackingAmt'); return (e&&!e.disabled&&e.value) ? parseFloat(e.value)||null : null; })(),
        order_discount: (function(){ var e=document.getElementById('poOrderDiscount'); return (e&&e.value) ? parseFloat(e.value)||null : null; })(),
        voucher_type_name: (document.getElementById('poVoucherType') ? document.getElementById('poVoucherType').value : '') || null,
        items: validLines.map(function(l){
            var qtyN  = parseFloat(l.total_qty||l.qty)||0;
            var rateN = parseFloat(l.rate)||0;
            var discN = parseFloat(l.discount)||0;
            if (discN < 0) discN = 0; if (discN > 100) discN = 100;
            var amt   = qtyN * rateN * (1 - discN/100);   // line amount shown in the table
            // Taxable base for this line = line amount + its apportioned share of
            // (freight + packing − order discount). GST is charged on this base.
            var taxBase = amt + (_svSubtotal > 0 ? _svAddBase * (amt / _svSubtotal) : 0);
            if (taxBase < 0) taxBase = 0;
            // Resolve GST% the same way the table/totals do: line value, else material master.
            var gstP = parseFloat(l.gst_rate) || 0;
            if (!gstP && l.material && _allRows && _allRows.length) {
                var _mm = _allRows.find(function(r){ return (r.material_name||'').toLowerCase()===(l.material||'').trim().toLowerCase(); });
                if (_mm && _mm.gst_rate != null) gstP = parseFloat(_mm.gst_rate) || 0;
            }
            if (gstP > 0 && gstP < 1) gstP = gstP * 100; // defensive fraction → percent
            var inter = poIsInterState();
            var cgst_amount = null, sgst_amount = null, igst_amount = null;
            if (gstP > 0 && taxBase > 0) {
                if (inter) {
                    igst_amount = Math.round(taxBase * gstP / 100 * 10000) / 10000;
                } else {
                    var half = Math.round(taxBase * (gstP/2) / 100 * 10000) / 10000;
                    cgst_amount = half;
                    sgst_amount = half;
                }
            }
            return {
                material:    l.material.trim(),
                qty:         qtyN,
                qty_per_pkg: parseFloat(l.qty_per_pkg)||0,
                packages:    l.packages ? parseInt(l.packages) : null,
                rate:        rateN,
                discount:    discN || 0,
                uom:         l.uom || 'KG',
                hsn_code:    l.hsn_code || '',
                gst_rate:    gstP || 0,
                cgst_amount: cgst_amount,
                sgst_amount: sgst_amount,
                igst_amount: igst_amount
            };
        })
    };

    if (isNew) {
        // New PO: send numbering config — server assigns number atomically
        // Use the active voucher numbering style configured in Voucher Numbering settings
        var cfg = (typeof _vNumGetActive === 'function') ? _vNumGetActive('po') : {};
        payload.num_cfg = { prefix: cfg.prefix||'', suffix: cfg.suffix||'', digits: cfg.digits||4 };
        // Don't send po_num for new POs — server assigns it
    } else {
        // Existing PO: send existing po_num to allow update
        payload.po_num = (document.getElementById('poModalNum').value||'').trim();
    }

    var btn = document.querySelector('[onclick="savePoModal()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        var res = await fetch('/api/procurement/po/save', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message || 'Save failed');

        // Update the PO number field with server-assigned number
        var numEl = document.getElementById('poModalNum');
        if (numEl && d.po_num) numEl.value = d.po_num;

        if (isNew) {
            // ERP-style toast with assigned voucher number
            toast('✅ PO Saved — Voucher No: ' + d.po_num, 'success', 6000);
        } else {
            toast('PO updated — ' + d.po_num, 'success');
        }
        poCloseFormPane();
    } catch(e) {
        toast('Save failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Record'; }
    }
}

/* ── Create PO from selected materials in Material Master ── */
function openPoFromMaterials() {
    // Use the virtual selection set from materials.js (_selectedMats)
    var names = (typeof _selectedMats !== 'undefined') ? [..._selectedMats] : [];
    if (!names.length) { toast('Select materials first','warning'); return; }
    var matData = names.map(function(name){
        // Look up from _allRows (all pages)
        return (typeof _allRows !== 'undefined') ? _allRows.find(function(r){ return r.material_name===name; }) : null;
    }).filter(Boolean);
    var suppliers = [...new Set(matData.map(function(m){ return (m.supplier_name||'').trim(); }).filter(Boolean))];
    if (!suppliers.length) { toast('Selected materials have no supplier set','error'); return; }
    if (suppliers.length > 1) { toast('All selected materials must have the same supplier','error'); return; }
    var lines = matData.map(function(m){
        var stk=parseFloat(m.in_stock_qty)||0, ord=parseFloat(m.ordered_qty)||0, req=parseFloat(m.required_qty)||0;
        var buf=(m.in_stock_qty!=null||m.ordered_qty!=null||m.required_qty!=null)?Math.round((stk+ord-req)*1000)/1000:null;
        return {
            material: m.material_name||'',
            qty:      buf!==null&&buf>0 ? String(buf) : '',
            rate:     m.last_purchase_rate ? String(m.last_purchase_rate) : '',
            hsn_code: m.hsn_code||'',
            gst_rate: m.gst_rate!=null ? parseFloat(m.gst_rate) : 0
        };
    });
    var supplier = suppliers[0];

    // Switch to PO tab but suppress the auto-reload so our form open isn't clobbered
    window._poSkipAutoLoad = true;
    switchTab('po'); setSidebarActive('po');

    // Open the form after a short tick to let the tab render
    setTimeout(function(){
        window._poSkipAutoLoad = false;
        openPoFormPane(null, supplier, lines);
    }, 80);
}

/* ════════════════════════════════════════════════════════════════
   PO PRINT
════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════
   GODOWN & ADDRESS MANAGER
════════════════════════════════════════════════════════════════ */
var _gdGodowns    = [];   // [{id, name, address, contact, phone, email, is_default}]
var _gdBilling    = {};   // {name, addr1, addr2, contact, phone, email, gst, pan}
var _gdEditIdx    = -1;   // index in _gdGodowns being edited (-1 = new)

/* Load godowns + billing from DB. Returns a Promise. */
function gdLoad() {
    return Promise.all([
        fetch('/api/procurement/godowns').then(function(r){ return r.json(); }).then(function(d){
            if (d.status === 'ok') {
                _gdGodowns = (d.godowns || []).map(function(g) {
                    g.is_default = !!g.is_default;
                    if (!g.addressData) g.addressData = {street:g.address||'',city:'',state:'',pin:''};
                    return g;
                });
            }
        }).catch(function(){}),
        fetch('/api/procurement/billing').then(function(r){ return r.json(); }).then(function(d){
            if (d.status === 'ok') {
                var b = d.billing || {};
                _gdBilling = {
                    name:b.name||'', contact:b.contact||'', phone:b.phone||'', email:b.email||'',
                    gst:b.gst||'', pan:b.pan||'',
                    addr1:b.addr1||b.address||'', addr2:b.addr2||'',
                    address:b.addr1||b.address||'',
                    city:b.city||'', state:b.state||'', pin:b.pin||'',
                };
                // Track company state for GST inter-state detection
                _poCompanyState = (b.state || '').trim();
                if (typeof poCheckGstStates === 'function') poCheckGstStates();
            }
        }).catch(function(){})
    ]);
}
function gdPersist() {}

async function openGodownManager() {
    try {
        await gdLoad();
        gdSwitchTab('godowns');
        gdRenderGodowns();
        gdLoadBillingForm();
        var modal = document.getElementById('godownModal');
        if (modal) modal.classList.add('open');
        else toast('Godown manager not available','warning');
    } catch(e) {
        console.error('openGodownManager error:', e);
        toast('Could not open Godown Manager: '+e.message,'error');
    }
}
function closeGodownModal() {
    document.getElementById('godownModal').classList.remove('open');
}

function gdSwitchTab(tab) {
    // Support both ID formats: gdPane-X and gdPaneX, gdTab-X and gdTabX
    ['godowns','billing'].forEach(function(t){
        var pane = document.getElementById('gdPane-'+t) || document.getElementById('gdPane'+t.charAt(0).toUpperCase()+t.slice(1));
        if(pane) pane.style.display = t===tab ? 'block' : 'none';
        var btn = document.getElementById('gdTab-'+t) || document.getElementById('gdTab'+t.charAt(0).toUpperCase()+t.slice(1));
        if(btn){
            btn.style.color        = t===tab ? 'var(--teal)' : 'var(--muted)';
            btn.style.borderBottom = t===tab ? '2px solid var(--teal)' : '2px solid transparent';
            btn.style.fontWeight   = t===tab ? '700' : '600';
        }
    });
    var gf = document.getElementById('gdGodownForm');
    if(gf && tab!=='godowns') gf.style.display='none';
}

function gdRenderGodowns() {
    var el = document.getElementById('gdGodownsList');
    var addBtn = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'
        + '<span style="font-size:11px;color:var(--muted)">Shipping / delivery destinations</span>'
        + '<button onclick="gdAddGodown()" style="height:28px;padding:0 14px;border-radius:7px;border:1px solid rgba(37,99,235,.3);background:rgba(37,99,235,.08);color:#1d4ed8;font-size:11.5px;font-weight:700;cursor:pointer;font-family:var(--font-body)">+ Add Godown</button>'
        + '</div>';
    if (!_gdGodowns.length) {
        el.innerHTML = addBtn + '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No godowns yet — click &ldquo;Add Godown&rdquo;</div>';
        return;
    }
    el.innerHTML = addBtn + _gdGodowns.map(function(g,i){
        return '<div style="border:1px solid var(--border2);border-radius:9px;padding:12px 14px;background:var(--surface);margin-bottom:8px;border-left:3px solid '+(g.is_default?'var(--teal)':'var(--border2)')+'">'
            + '<div style="display:flex;align-items:flex-start;justify-content:space-between">'
            + '<div><div style="font-size:13px;font-weight:700;color:var(--text)">' + escHtml(g.name) + (g.is_default?'<span style="margin-left:8px;font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;background:var(--teal-glow);color:var(--teal)">DEFAULT</span>':'') + '</div>'
            + '<div style="font-size:11.5px;color:var(--muted);margin-top:4px">' + escHtml([g.address,g.city,g.state,g.pin].filter(Boolean).join(', ')||'—') + '</div>'
            + '<div style="font-size:11px;color:var(--muted);margin-top:3px;display:flex;gap:16px">'
            + (g.contact?'<span>&#128100; '+escHtml(g.contact)+'</span>':'')
            + (g.phone?'<span>&#128222; '+escHtml(g.phone)+'</span>':'')
            + (g.email?'<span>&#9993; '+escHtml(g.email)+'</span>':'')
            + '</div></div>'
            + '<div style="display:flex;gap:6px;flex-shrink:0">'
            + (!g.is_default?'<button onclick="gdSetDefault('+i+')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--muted2);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Set Default</button>':'')
            + '<button onclick="gdOpenEditGodown('+i+')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--muted2);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#9998; Edit</button>'
            + '<button onclick="gdDeleteGodown('+i+')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#10005;</button>'
            + '</div></div></div>';
    }).join('');
}

function gdAddGodown() { gdOpenEditGodown(null); }
function gdAddrStateChanged() { addrStateChange('gd','form-input'); }
function gdOpenEditGodown(idx) {
    _gdEditIdx = idx;
    var g = idx !== null ? _gdGodowns[idx] : {};
    var isEdit = idx !== null;
    var stateOpts = '<option value="">— Select State —</option>' +
        _IND_STATES.map(function(s){ return '<option value="'+s+'">'+s+'</option>'; }).join('');
    var formDiv = document.getElementById('gdGodownForm');
    var html = '<div style="border:1px solid var(--border2);border-radius:10px;padding:14px;background:var(--surface2);margin-top:10px">';
    html += '<div style="font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">'+(isEdit?'Edit Godown':'Add Godown')+'</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">';
    html += '<div class="form-group"><label class="form-label">Godown Name <span class="req">*</span></label><input class="form-input" type="text" id="gdGdName" placeholder="e.g. Main Factory"></div>';
    html += '<div class="form-group"><label class="form-label">Contact Person</label><input class="form-input" type="text" id="gdGdContact" placeholder="Name"></div>';
    html += '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" type="text" id="gdGdPhone" placeholder="+91"></div>';
    html += '<div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="gdGdEmail" placeholder="godown@company.com"></div>';
    html += '</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">';
    html += '<div class="form-group" style="grid-column:1/-1"><label class="form-label">Street / Area <span class="req">*</span></label><input class="form-input" type="text" id="gdAddrStreet" placeholder="Street, locality, landmark"></div>';
    html += '<div class="form-group"><label class="form-label">State <span class="req">*</span></label><select class="form-input combo" id="gdAddrState" onchange="gdAddrStateChanged()">'+stateOpts+'</select></div>';
    html += '<div class="form-group"><label class="form-label">City <span class="req">*</span></label><select class="form-input combo" id="gdAddrCity"><option value="">— Select State first —</option></select></div>';
    html += '<div class="form-group"><label class="form-label">PIN Code</label><input class="form-input" type="text" id="gdAddrPin" placeholder="380015" maxlength="6"></div>';
    html += '</div>';
    html += '<div style="margin-bottom:12px"><select class="form-input combo" id="gdGdDefault" style="height:30px;padding:0 8px;font-size:11px;width:auto">';
    html += '<option value="0">Not default</option><option value="1">Set as default shipping</option></select></div>';
    html += '<div style="display:flex;gap:8px">';
    html += '<button onclick="gdSaveGodown()" style="height:32px;padding:0 18px;border-radius:7px;border:none;background:#1d4ed8;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-body)">&#10003; Save Godown</button>';
    html += '<button onclick="gdCancelGodown()" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--border2);background:transparent;color:var(--muted2);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Cancel</button>';
    html += '</div></div>';
    formDiv.innerHTML = html;
    if (typeof comboboxAutoInit === 'function') comboboxAutoInit(formDiv);
    document.getElementById('gdGdName').value    = g.name    || '';
    document.getElementById('gdGdContact').value = g.contact || '';
    document.getElementById('gdGdPhone').value   = g.phone   || '';
    document.getElementById('gdGdEmail').value   = g.email   || '';
    var _gdDefEl = document.getElementById('gdGdDefault');
    _gdDefEl.value = g.is_default ? '1' : '0';
    if (typeof comboboxSyncDisplay === 'function') comboboxSyncDisplay(_gdDefEl);
    setAddressWidgetData('gd', {street:g.address||'', state:g.state||'', city:g.city||'', pin:g.pin||''});
    formDiv.style.display = 'block';
    document.getElementById('gdGdName').focus();
}
function gdCancelGodown() {
    document.getElementById('gdGodownForm').style.display = 'none';
    _gdEditIdx = -1;
}
function gdSaveGodown() {
    var name = document.getElementById('gdGdName').value.trim();
    var addrData = getAddressWidgetData('gd');
    if (!name)           { toast('Godown name is required','error'); return; }
    if (!addrData.street){ toast('Street / Area is required','error'); return; }
    if (!addrData.state) { toast('State is required','error'); return; }
    if (!addrData.city)  { toast('City is required','error'); return; }
    var fullAddr = formatAddress(addrData);
    var isDefault = document.getElementById('gdGdDefault').value === '1';
    var editId = (_gdEditIdx !== null && _gdEditIdx >= 0) ? (_gdGodowns[_gdEditIdx].id || null) : null;
    fetch('/api/procurement/godowns/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id:editId, name:name, address:addrData.street||'',
            contact:document.getElementById('gdGdContact').value.trim(),
            phone:document.getElementById('gdGdPhone').value.trim(),
            email:document.getElementById('gdGdEmail').value.trim(),
            state: addrData.state || '',
            city:  addrData.city  || '',
            pin:   addrData.pin   || '',
            is_default: isDefault ? 1 : 0})
    }).then(function(r){ return r.json(); }).then(function(data){
        if (data.status !== 'ok') throw new Error(data.message);
        toast(editId ? 'Godown updated' : 'Godown added', 'success');
        var gf = document.getElementById('gdGodownForm'); if (gf) gf.style.display='none';
        _gdEditIdx = -1;
        gdLoad().then(function(){ gdRenderGodowns(); poLoadAddresses(); });
    }).catch(function(e){ toast('Save failed: '+e.message,'error'); });
}
function gdDeleteGodown(idx) {
    if (!confirm('Delete this godown?')) return;
    var gid = _gdGodowns[idx] && _gdGodowns[idx].id;
    if (!gid) { toast('Godown ID not found — please refresh','error'); return; }
    fetch('/api/procurement/godowns/delete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id: gid})
    }).then(function(r){ return r.json(); }).then(function(data){
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Godown deleted','success');
        gdLoad().then(function(){ gdRenderGodowns(); poLoadAddresses(); });
    }).catch(function(e){ toast('Delete failed: '+e.message,'error'); });
}
function gdSetDefault(idx) {
    var g = _gdGodowns[idx];
    if (!g || !g.id) { toast('Godown ID not found — please refresh','error'); return; }
    fetch('/api/procurement/godowns/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id:g.id, name:g.name, address:g.address,
            contact:g.contact||'', phone:g.phone||'', email:g.email||'',
            state:g.state||'', city:g.city||'', pin:g.pin||'', is_default:1})
    }).then(function(r){ return r.json(); }).then(function(data){
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Default godown set','success');
        gdLoad().then(function(){ gdRenderGodowns(); poLoadAddresses(); });
    }).catch(function(e){ toast('Failed: '+e.message,'error'); });
}
function gdSetDefaults() { gdPersist(); }

function gdLoadBillingForm() {
    var b = _gdBilling;
    // Populate state dropdowns
    var stateOpts = '<option value="">— Select State —</option>' + _IND_STATES.map(function(s){ return '<option value="'+s+'">'+s+'</option>'; }).join('');
    var billState = document.getElementById('billAddrState');
    if (billState) { billState.innerHTML = stateOpts; if (typeof comboboxRefresh === 'function') comboboxRefresh(billState); }
    document.getElementById('gdBillName').value    = b.name||'HCP Wellness Pvt Ltd';
    document.getElementById('gdBillContact').value = b.contact||'';
    document.getElementById('gdBillPhone').value   = b.phone||'';
    document.getElementById('gdBillEmail').value   = b.email||'';
    document.getElementById('gdBillGST').value     = b.gst||'';
    document.getElementById('gdBillPAN').value     = b.pan||'';
    var sv = function(id,v){ var e=document.getElementById(id); if(e) e.value=v||''; };
    sv('billAddrStreet', b.addr1||b.address||'');
    sv('billAddrCity',   b.city||'');
    sv('billAddrPin',    b.pin||'');
    // Populate state dropdown and set value
    var stateEl = document.getElementById('billAddrState');
    if (stateEl && stateEl.options.length <= 1) {
        stateEl.innerHTML = '<option value="">— Select State —</option>' + _IND_STATES.map(function(s){return '<option value="'+s+'">'+s+'</option>';}).join('');
        if (typeof comboboxRefresh === 'function') comboboxRefresh(stateEl);
    }
    if (stateEl) { stateEl.value = b.state||''; if (typeof comboboxSyncDisplay === 'function') comboboxSyncDisplay(stateEl); }
}
function gdSaveBilling() {
    var gv2 = function(id){ var e=document.getElementById(id); return e?e.value.trim():''; };
    var addr = { street:gv2('billAddrStreet'), city:gv2('billAddrCity'), state:gv2('billAddrState'), pin:gv2('billAddrPin') };
    if (!addr.street) { toast('Address line 1 is required','error'); return; }
    _gdBilling = {
        name:    document.getElementById('gdBillName').value.trim(),
        address: addr.street,
        addr1:   addr.street,
        addr2:   [addr.city, addr.state, addr.pin].filter(Boolean).join(', '),
        contact: document.getElementById('gdBillContact').value.trim(),
        phone:   document.getElementById('gdBillPhone').value.trim(),
        email:   document.getElementById('gdBillEmail').value.trim(),
        gst:     document.getElementById('gdBillGST').value.trim(),
        pan:     document.getElementById('gdBillPAN').value.trim(),
        city:    addr.city,
        state:   addr.state,
        pin:     addr.pin,
    };
    if (!_gdBilling.addr1) { toast('Address is required','error'); return; }
    // Update the in-memory company state immediately so the PO form picks it up
    _poCompanyState = addr.state || '';
    fetch('/api/procurement/billing', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(_gdBilling)
    }).then(function(r){ return r.json(); }).then(function(data){
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Billing address saved','success');
        poLoadAddresses();
        if (typeof poCheckGstStates === 'function') poCheckGstStates();
        if (typeof poCalcGrandTotal === 'function') poCalcGrandTotal();
    }).catch(function(e){ toast('Save failed: '+e.message,'error'); });
}

/* ════ Wire PO modal address selects ════ */
function poLoadAddresses() {
    gdLoad().then(function(){ _poFillAddressSelects(); });
}
function _poFillAddressSelects() {
    // Billing select
    var bSel = document.getElementById('poBillingAddr');
    var sSel = document.getElementById('poShippingAddr');
    if (!bSel || !sSel) return;

    var bOpts = '<option value="">— Select Billing Address —</option>';
    if (_gdBilling.addr1) {
        bOpts += '<option value="billing">' + escHtml((_gdBilling.name||'Company') + ' — ' + _gdBilling.addr1) + '</option>';
    }
    bSel.innerHTML = bOpts;

    var sOpts = '<option value="">— Select Shipping Address —</option>';
    _gdGodowns.forEach(function(g,i){
        sOpts += '<option value="'+i+'">' + escHtml(g.name + ' — ' + [g.address,g.city,g.state,g.pin].filter(Boolean).join(', ')) + '</option>';
    });
    sSel.innerHTML = sOpts;

    // Auto-select defaults
    if (_gdBilling.addr1) bSel.value = 'billing';
    var defGd = _gdGodowns.findIndex(function(g){ return g.is_default; });
    if (defGd >= 0) sSel.value = String(defGd);

    if (typeof comboboxRefresh === 'function') { comboboxRefresh(bSel); comboboxRefresh(sSel); }

    poUpdateAddressDisplay('billing');
    poUpdateAddressDisplay('shipping');
}

function poUpdateAddressDisplay(which) {
    if (which === 'billing') {
        var disp = document.getElementById('poBillingDisplay');
        var b = _gdBilling;
        if (b.addr1) {
            disp.innerHTML = '<strong>' + escHtml(b.name||'') + '</strong><br>' + escHtml(b.addr1) + (b.addr2 ? '<br>'+escHtml(b.addr2) : '') + (b.gst ? '<br><span style="font-family:var(--font-mono);font-size:10px">GST: '+escHtml(b.gst)+'</span>' : '');
        } else { disp.innerHTML = ''; }
    } else {
        var disp2 = document.getElementById('poShippingDisplay');
        var sel = document.getElementById('poShippingAddr');
        if (!sel) return;
        var idx = parseInt(sel.value);
        var g = !isNaN(idx) && _gdGodowns[idx] ? _gdGodowns[idx] : null;
        if (g) {
            disp2.innerHTML = '<strong>' + escHtml(g.name) + '</strong><br>' + escHtml([g.address,g.city,g.state,g.pin].filter(Boolean).join(', ')) + (g.contact ? '<br>'+escHtml(g.contact) : '') + (g.phone ? ' &middot; '+escHtml(g.phone) : '');
        } else { disp2.innerHTML = ''; }
    }
}

/* Auto-fill supplier details when supplier name changes */
function poFillSupplierDetails(supplierName) {
    // Find in _supRows first, else fetch
    var found = (_supRows||[]).find(function(s){ return s.supplier_name && s.supplier_name.toLowerCase()===supplierName.toLowerCase(); });
    if (found) {
        _poApplySupplierFields(found);
    } else if (supplierName) {
        fetch('/api/procurement/suppliers?q=' + encodeURIComponent(supplierName))
            .then(function(r){ return r.json(); })
            .then(function(d){
                var s = (d.suppliers||[]).find(function(s){ return s.supplier_name.toLowerCase()===supplierName.toLowerCase(); });
                if (s) _poApplySupplierFields(s);
            }).catch(function(){});
    } else {
        _poApplySupplierFields({});
    }
}
function _poApplySupplierFields(s) {
    var f = function(id, val){ var el=document.getElementById(id); if(el) el.value=val||''; };
    f('poSupContact',    s.contact_person);
    f('poSupPhone',      s.phone);
    f('poSupEmail',      s.email);
    f('poSupAddress',    s.address);
    f('poSupGST',        s.gst_number);
    f('poSupPAN',        s.pan_number);
    f('poSupPayTerms',   s.payment_type || s.payment_terms || '');
    f('poSupCreditDays', s.credit_days  ? String(s.credit_days) : '');
    // Store supplier's tc_list_id on a data attribute for print builder
    var supEl = document.getElementById('poModalSupplier');
    if (supEl) supEl.dataset.supTcId = s.tc_list_id || '';
    // Track supplier state for GST inter-state detection
    _poSupplierName  = s.supplier_name || (supEl && supEl.value) || '';
    _poSupplierState = (s.state || '').trim();
    // Update banner + Save button state, then recompute totals (CGST/SGST vs IGST)
    poCheckGstStates();
    if (typeof poCalcGrandTotal === 'function') poCalcGrandTotal();
}

/* Hook into poModalSupplierChange */
function poModalSupplierChange() {
    var sup = document.getElementById('poModalSupplier').value.trim();
    poFillSupplierDetails(sup);
}

/* On PO modal open, load addresses + supplier details */
var _origPoModalOpen = openPoModal;
openPoModal = async function(row, prefillSupplier, prefillLines) {
    // Reset supplier state tracking — re-set if a supplier is preselected below
    _poSupplierName  = '';
    _poSupplierState = '';
    await gdLoad();
    await _origPoModalOpen(row, prefillSupplier, prefillLines);
    if (prefillSupplier) poFillSupplierDetails(prefillSupplier);
    else if (row && row.supplier) poFillSupplierDetails(row.supplier);
    // No supplier yet → just check company state (banner will still show if billing state missing)
    if (typeof poCheckGstStates === 'function') poCheckGstStates();
};

/* Validate billing/shipping + GST states before save */
var _origSavePoModal = savePoModal;
savePoModal = function() {
    var billing  = document.getElementById('poBillingAddr')?.value;
    var shipping = document.getElementById('poShippingAddr')?.value;
    if (!billing) {
        if (!_gdBilling.addr1) {
            if (!confirm('No billing address is set.\n\nOpen Godown & Address manager now?')) return;
            openGodownManager();
            return;
        }
        toast('Please select a Billing Address','error'); return;
    }
    if (!shipping) {
        if (!_gdGodowns.length) {
            if (!confirm('No shipping godown is set.\n\nOpen Godown & Address manager now?')) return;
            openGodownManager();
            return;
        }
        toast('Please select a Shipping Address','error'); return;
    }
    // Hard-block save if state info is missing — banner already shown by
    // poCheckGstStates(); this is the last-line safety net for the case where
    // a user somehow re-enabled the Save button via DevTools or similar.
    if (typeof poCheckGstStates === 'function' && !poCheckGstStates()) {
        toast('Set state info before saving (see banner at top of form)','error');
        return;
    }
    _origSavePoModal();
};

/* Init on page load */
document.addEventListener('DOMContentLoaded', function(){
    _gdMigrateLocalStorageToDB().then(function(){ gdLoad(); });
    // Load approval permission once — sets _poCanApprove + _poIsAdmin globals
    if (typeof poLoadApprovalPerms === 'function') poLoadApprovalPerms();
});

function _gdMigrateLocalStorageToDB() {
    var godowns = null, billing = null;
    try {
        var g = localStorage.getItem('hcp_godowns');
        var b = localStorage.getItem('hcp_billing');
        if (g) godowns = JSON.parse(g);
        if (b) billing  = JSON.parse(b);
    } catch(e) {}
    if ((!godowns || !godowns.length) && (!billing || !billing.addr1)) return Promise.resolve();
    return fetch('/api/procurement/godowns/seed', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({godowns: godowns||[], billing: billing||{}})
    }).then(function(r){ return r.json(); }).then(function(d){
        if (d.status==='ok' && (d.seeded_godowns>0 || d.seeded_billing))
            console.log('[HCP] Migrated localStorage to DB:', d);
    }).catch(function(){});
}


/* ════════════════════════════════════════════════════════════════
   INDIAN STATES & CITIES DATA
════════════════════════════════════════════════════════════════ */
var _IND_STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Andaman & Nicobar Islands","Chandigarh","Dadra & Nagar Haveli","Daman & Diu","Delhi","Jammu & Kashmir","Ladakh","Lakshadweep","Puducherry"];

var _IND_CITIES = {
  "Gujarat":["Ahmedabad","Surat","Vadodara","Rajkot","Bhavnagar","Jamnagar","Gandhinagar","Anand","Navsari","Morbi","Nadiad","Bharuch","Mehsana","Surendranagar","Junagadh","Porbandar","Amreli","Botad","Dahod","Godhra","Palanpur","Patan","Vapi","Veraval","Gandhidham"],
  "Maharashtra":["Mumbai","Pune","Nagpur","Thane","Nashik","Aurangabad","Solapur","Kolhapur","Amravati","Nanded","Sangli","Malegaon","Jalgaon","Akola","Latur","Dhule","Ahmednagar","Chandrapur","Parbhani","Nandurbar","Satara","Wardha","Yavatmal","Osmanabad","Beed"],
  "Delhi":["New Delhi","Delhi","Dwarka","Rohini","Noida","Gurugram","Faridabad","Ghaziabad"],
  "Karnataka":["Bengaluru","Mysuru","Hubballi","Mangaluru","Belagavi","Kalaburagi","Davanagere","Ballari","Vijayapura","Shivamogga","Tumakuru","Raichur","Bidar","Hassan","Udupi","Dharwad"],
  "Tamil Nadu":["Chennai","Coimbatore","Madurai","Tiruchirappalli","Salem","Tirunelveli","Tiruppur","Vellore","Erode","Thoothukudi","Dindigul","Thanjavur","Ranipet","Sivakasi","Karur","Hosur"],
  "Telangana":["Hyderabad","Warangal","Karimnagar","Nizamabad","Khammam","Ramagundam","Mahbubnagar","Nalgonda","Adilabad","Suryapet"],
  "Rajasthan":["Jaipur","Jodhpur","Udaipur","Kota","Bikaner","Ajmer","Bhilwara","Alwar","Bharatpur","Sikar","Pali","Sri Ganganagar","Barmer","Tonk","Churu"],
  "Uttar Pradesh":["Lucknow","Kanpur","Agra","Varanasi","Meerut","Allahabad","Ghaziabad","Noida","Bareilly","Aligarh","Moradabad","Saharanpur","Gorakhpur","Firozabad","Mathura","Muzaffarnagar","Faizabad"],
  "Madhya Pradesh":["Bhopal","Indore","Gwalior","Jabalpur","Ujjain","Sagar","Ratlam","Satna","Dewas","Murwara","Chhindwara","Rewa","Singrauli","Burhanpur","Khandwa"],
  "Punjab":["Ludhiana","Amritsar","Jalandhar","Patiala","Bathinda","Pathankot","Hoshiarpur","Moga","Firozpur","Muktsar","Sangrur","Phagwara"],
  "Haryana":["Faridabad","Gurugram","Panipat","Ambala","Yamunanagar","Rohtak","Hisar","Karnal","Sonipat","Panchkula","Bhiwani","Sirsa"],
  "West Bengal":["Kolkata","Howrah","Durgapur","Asansol","Siliguri","Malda","Bardhaman","Kharagpur","Haldia","Raiganj"],
  "Andhra Pradesh":["Visakhapatnam","Vijayawada","Guntur","Nellore","Kurnool","Kakinada","Tirupati","Rajahmundry","Kadapa","Anantapur","Vizianagaram","Eluru","Ongole","Nandyal","Machilipatnam"],
  "Kerala":["Thiruvananthapuram","Kochi","Kozhikode","Thrissur","Kollam","Palakkad","Alappuzha","Malappuram","Kannur","Kottayam","Kasaragod","Pathanamthitta","Idukki"],
  "Bihar":["Patna","Gaya","Bhagalpur","Muzaffarpur","Darbhanga","Arrah","Begusarai","Chhapra","Katihar","Munger","Purnia","Saharsa","Hajipur","Bihar Sharif"],
  "Odisha":["Bhubaneswar","Cuttack","Rourkela","Brahmapur","Sambalpur","Puri","Baripada","Balasore","Bhadrak","Jharsuguda"],
  "Jharkhand":["Ranchi","Jamshedpur","Dhanbad","Bokaro","Deoghar","Phusro","Hazaribagh","Giridih","Ramgarh","Medininagar"],
  "Assam":["Guwahati","Silchar","Dibrugarh","Jorhat","Nagaon","Tinsukia","Tezpur","Bongaigaon","Dhubri","Diphu"],
  "Himachal Pradesh":["Shimla","Solan","Dharamsala","Mandi","Baddi","Palampur","Nahan","Kullu","Hamirpur","Una"],
  "Goa":["Panaji","Vasco da Gama","Margao","Mapusa","Ponda","Bicholim","Curchorem","Sanquelim"],
  "Chandigarh":["Chandigarh"],
  "Uttarakhand":["Dehradun","Haridwar","Roorkee","Haldwani","Kashipur","Rudrapur","Rishikesh","Kotdwar","Ramnagar","Mussoorie"],
  "Chhattisgarh":["Raipur","Bhilai","Bilaspur","Korba","Durg","Rajnandgaon","Jagdalpur","Ambikapur","Dhamtari","Raigarh"],
  "Jammu & Kashmir":["Srinagar","Jammu","Anantnag","Sopore","Baramulla","Kathua","Udhampur","Punch"],
  "Tripura":["Agartala","Dharmanagar","Udaipur","Kailasahar","Belonia"],
  "Manipur":["Imphal","Thoubal","Bishnupur","Churachandpur"],
  "Meghalaya":["Shillong","Tura","Nongstoin","Jowai"],
  "Nagaland":["Kohima","Dimapur","Mokokchung","Tuensang"],
  "Mizoram":["Aizawl","Lunglei","Champhai","Serchhip"],
  "Arunachal Pradesh":["Itanagar","Naharlagun","Tawang","Ziro","Pasighat"],
  "Sikkim":["Gangtok","Namchi","Mangan","Gyalshing"],
  "Puducherry":["Puducherry","Karaikal","Mahe","Yanam"],
  "Andaman & Nicobar Islands":["Port Blair","Diglipur","Rangat"],
  "Lakshadweep":["Kavaratti","Agatti","Amini"],
  "Ladakh":["Leh","Kargil"],
  "Dadra & Nagar Haveli":["Silvassa","Amli","Dapada"],
  "Daman & Diu":["Daman","Diu","Moti Daman"]
};

/* Build address widget HTML — returns HTML string for inserting into forms
   prefix: unique prefix for element IDs (e.g. 'sup', 'bill', 'gd')
   inputClass: CSS class for inputs ('form-input' or 'form-input-styled')
*/
function buildAddressWidget(prefix, inputClass) {
    var ic = inputClass || 'form-input';
    return `
    <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Street / Area <span class="req">*</span></label>
        <input class="${ic}" type="text" id="${prefix}AddrStreet" placeholder="Street, locality, landmark">
    </div>
    <div class="form-group">
        <label class="form-label">State <span class="req">*</span></label>
        <select class="${ic} combo" id="${prefix}AddrState" onchange="addrStateChange('${prefix}','${ic}')">
            <option value="">— Select State —</option>
            ${_IND_STATES.map(function(s){ return '<option value="'+s+'">'+s+'</option>'; }).join('')}
        </select>
    </div>
    <div class="form-group">
        <label class="form-label">City <span class="req">*</span></label>
        <select class="${ic} combo" id="${prefix}AddrCity">
            <option value="">— Select State first —</option>
        </select>
    </div>
    <div class="form-group">
        <label class="form-label">PIN Code</label>
        <input class="${ic}" type="text" id="${prefix}AddrPin" placeholder="e.g. 380015" maxlength="6" pattern="[0-9]{6}">
    </div>`;
}

function addrStateChange(prefix, inputClass) {
    var ic = inputClass || 'form-input';
    var state = document.getElementById(prefix+'AddrState').value;
    var cityEl = document.getElementById(prefix+'AddrCity');
    var cities = _IND_CITIES[state] || [];
    if (!cities.length) {
        cityEl.innerHTML = '<option value="">— No cities listed —</option>';
        if (typeof comboboxRefresh === 'function') comboboxRefresh(cityEl);
        return;
    }
    cityEl.innerHTML = '<option value="">— Select City —</option>' +
        cities.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join('');
    if (typeof comboboxRefresh === 'function') comboboxRefresh(cityEl);
}

/* Get address object from widget fields */
function getAddressWidgetData(prefix) {
    return {
        street: (document.getElementById(prefix+'AddrStreet')?.value||'').trim(),
        state:  (document.getElementById(prefix+'AddrState')?.value||'').trim(),
        city:   (document.getElementById(prefix+'AddrCity')?.value||'').trim(),
        pin:    (document.getElementById(prefix+'AddrPin')?.value||'').trim(),
    };
}

/* Set address widget from stored data */
function setAddressWidgetData(prefix, data) {
    if (!data) return;
    var ic = 'form-input';
    var sEl = document.getElementById(prefix+'AddrStreet');
    var stEl= document.getElementById(prefix+'AddrState');
    var cEl = document.getElementById(prefix+'AddrCity');
    var pEl = document.getElementById(prefix+'AddrPin');
    if (sEl) sEl.value = data.street||'';
    if (stEl && data.state) {
        stEl.value = data.state;
        if (typeof comboboxSyncDisplay === 'function') comboboxSyncDisplay(stEl);
        // Populate cities
        var cities = _IND_CITIES[data.state]||[];
        if (cEl) {
            cEl.innerHTML = '<option value="">— Select City —</option>' + cities.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join('');
            cEl.value = data.city||'';
            if (typeof comboboxRefresh === 'function') comboboxRefresh(cEl);
        }
    }
    if (pEl) pEl.value = data.pin||'';
}

/* Format full address for display */
function formatAddress(data) {
    if (!data) return '';
    var parts = [data.street, data.city, data.state, data.pin].filter(Boolean);
    return parts.join(', ');
}


/* ════════════════════════════════════════════════════════════════
   TERMS & CONDITIONS MODULE
════════════════════════════════════════════════════════════════ */
var _tcLists = [];          // loaded from DB
var _tcEditId = null;       // null = new, db id = editing
var _tcOtherTerms = [];     // [{text}] for current edit session

/* Load T&C lists from DB */
async function _tcLoadFromDB() {
    try {
        var r = await fetch('/api/procurement/tc/list');
        var d = await r.json();
        if (d.status === 'ok') _tcLists = d.tc_lists || [];
    } catch(e) {}
}

function _tcSave() { /* no-op — saving is done via API in tcSaveList */ }

/* Populate any T&C <select> by id */
function tcPopulateSelect(selectId, selectedId) {
    var el = document.getElementById(selectId);
    if (!el) return;
    el.innerHTML = '<option value="">— None —</option>' +
        _tcLists.map(function(t){
            return '<option value="'+t.id+'"'+(String(t.id)===String(selectedId)?' selected':'')+'>'+escHtml(t.name)+'</option>';
        }).join('');
    if (typeof comboboxRefresh === 'function') comboboxRefresh(el);
}

