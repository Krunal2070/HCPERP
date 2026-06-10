/* po_form.js — Declarations mgr, TC mgr, openPoFormPane, supplier autofill
   Depends on: utils.js, po.js, suppliers.js, godowns_tc_decl.js */

/* ═══════════════════════════════════════════════════════════════
   DECLARATIONS
════════════════════════════════════════════════════════════════ */
var _declLists = [], _declEditId = null;

async function _declLoadFromDB() {
    try {
        var r = await fetch('/api/procurement/declarations');
        var d = await r.json();
        if (d.status === 'ok') _declLists = d.declarations || [];
    } catch(e) { _declLists = []; }
}
function declPopulateSelect(sid, selId) {
    var el = document.getElementById(sid);
    if (!el) return;
    el.innerHTML = '<option value="">\u2014 None \u2014</option>'
        + _declLists.map(function(d) {
            return '<option value="' + d.id + '"'
                + (String(d.id) === String(selId) ? ' selected' : '')
                + '>' + escHtml(d.name) + '</option>';
          }).join('');
    if (typeof comboboxRefresh === 'function') comboboxRefresh(el);
}
async function openDeclManager() {
    await _declLoadFromDB();
    declRenderLists();
    /* Refresh selects while preserving current selection */
    declPopulateSelect('poModalDeclaration',  document.getElementById('poModalDeclaration')  ? document.getElementById('poModalDeclaration').value  : null);
    declPopulateSelect('supModalDeclaration', document.getElementById('supModalDeclaration') ? document.getElementById('supModalDeclaration').value : null);
    var m = document.getElementById('declManagerModal');
    if (m) m.classList.add('open');
    else toast('Declaration manager not available', 'warning');
}
function closeDeclManager() {
    var m = document.getElementById('declManagerModal');
    if (m) m.classList.remove('open');
    _declEditId = null;
    var ef = document.getElementById('declEditForm');
    if (ef) ef.style.display = 'none';
}
function declRenderLists() {
    var el = document.getElementById('declListsContainer');
    if (!el) return;
    if (!_declLists.length) {
        el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No declarations yet \u2014 click \u201c+ New Declaration\u201d</div>';
        return;
    }
    el.innerHTML = _declLists.map(function(d) {
        return '<div style="border:1px solid var(--border2);border-radius:9px;padding:12px 14px;margin-bottom:8px;background:var(--surface)">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
            + '<div style="flex:1;min-width:0">'
            + '<div style="font-size:13px;font-weight:700;color:var(--text)">' + escHtml(d.name) + '</div>'
            + '<div style="font-size:11px;color:var(--muted);margin-top:4px;max-height:60px;overflow:hidden">' + escHtml((d.text || '').substring(0, 250)) + '</div>'
            + '</div>'
            + '<div style="display:flex;gap:6px;flex-shrink:0;margin-left:10px">'
            + '<button onclick="declOpenForm(\'' + d.id + '\')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--muted2);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#9998; Edit</button>'
            + '<button onclick="declDelete(\'' + d.id + '\')" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#10005;</button>'
            + '</div></div></div>';
    }).join('');
}
function declOpenForm(id) {
    _declEditId = id || null;
    var d = id ? _declLists.find(function(x) { return String(x.id) === String(id); }) : {};
    d = d || {};
    document.getElementById('declFormTitle').textContent = id ? 'Edit Declaration' : 'New Declaration';
    document.getElementById('declName').value = d.name || '';
    document.getElementById('declText').value = d.text || '';
    document.getElementById('declEditForm').style.display = 'block';
    document.getElementById('declEditForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('declName').focus();
}
function declCancelForm() {
    document.getElementById('declEditForm').style.display = 'none';
    _declEditId = null;
}
async function declSave() {
    var name = document.getElementById('declName').value.trim();
    var text = document.getElementById('declText').value.trim();
    if (!name) { toast('Declaration name is required', 'error'); return; }
    try {
        var res = await fetch('/api/procurement/declarations/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: _declEditId || null, name: name, text: text })
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message || 'Save failed');
        toast(_declEditId ? 'Declaration updated' : 'Declaration saved', 'success');
        await _declLoadFromDB();
        declRenderLists();
        document.getElementById('declEditForm').style.display = 'none';
        _declEditId = null;
        /* Preserve current selection — don't reset to null */
        var curPO  = document.getElementById('poModalDeclaration')  ? document.getElementById('poModalDeclaration').value  : null;
        var curSup = document.getElementById('supModalDeclaration') ? document.getElementById('supModalDeclaration').value : null;
        declPopulateSelect('poModalDeclaration',  curPO  || null);
        declPopulateSelect('supModalDeclaration', curSup || null);
    } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}
async function declDelete(id) {
    if (!confirm('Delete this declaration?')) return;
    try {
        var res = await fetch('/api/procurement/declarations/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message || 'Delete failed');
        toast('Declaration deleted', 'success');
        await _declLoadFromDB();
        declRenderLists();
        /* Preserve current selection — deleted item will naturally fall to None */
        var curPO2  = document.getElementById('poModalDeclaration')  ? document.getElementById('poModalDeclaration').value  : null;
        var curSup2 = document.getElementById('supModalDeclaration') ? document.getElementById('supModalDeclaration').value : null;
        declPopulateSelect('poModalDeclaration',  curPO2  || null);
        declPopulateSelect('supModalDeclaration', curSup2 || null);
    } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
}

async function openTCManager() {
    await _tcLoadFromDB();
    tcRenderLists();
    document.getElementById('tcEditForm').style.display = 'none';
    document.getElementById('tcManagerModal').classList.add('open');
}
function closeTCManager() {
    document.getElementById('tcManagerModal').classList.remove('open');
}

function tcRenderLists() {
    var el = document.getElementById('tcListsContainer');
    if (!_tcLists.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">No T&amp;C lists yet — click &ldquo;New T&amp;C List&rdquo;</div>';
        return;
    }
    el.innerHTML = _tcLists.map(function(t){
        var summary = [];
        if (t.delivery_mode) summary.push('Mode: '+t.delivery_mode);
        if (t.other_terms && t.other_terms.length) summary.push(t.other_terms.length+' clause'+(t.other_terms.length!==1?'s':''));
        var tid = escHtml(t.id);
        var clauses = (t.other_terms || []);
        var clausesHtml = '';
        if (clauses.length) {
            clausesHtml = '<ol style="margin:10px 0 0;padding-left:20px;font-size:11.5px;color:var(--text);line-height:1.7">'
                + clauses.map(function(c){ return '<li style="margin-bottom:3px">'+escHtml(c)+'</li>'; }).join('')
                + '</ol>';
        } else {
            clausesHtml = '<div style="margin-top:8px;font-size:11px;color:var(--muted);font-style:italic">No clauses added yet.</div>';
        }
        return '<div style="border:1px solid var(--border2);border-radius:9px;padding:12px 14px;background:var(--surface);margin-bottom:8px">'
            + '<div style="display:flex;align-items:flex-start;justify-content:space-between">'
            + '<div>'
            + '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:5px">'+escHtml(t.name)+'</div>'
            + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
            + summary.map(function(s){ return '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:var(--surface2);border:1px solid var(--border2);color:var(--muted2)">'+s+'</span>'; }).join('')
            + '</div></div>'
            + '<div style="display:flex;gap:6px;flex-shrink:0">'
            + '<button data-tcid="'+tid+'" class="tc-edit-btn" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--muted2);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#9998; Edit</button>'
            + '<button data-tcid="'+tid+'" class="tc-del-btn" style="height:26px;padding:0 10px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);font-size:10.5px;font-weight:600;cursor:pointer;font-family:var(--font-body)">&#10005;</button>'
            + '</div></div>'
            + clausesHtml
            + '</div>';
    }).join('');
}

function tcOpenForm(id) {
    _tcEditId = id;
    var t = (id !== null && id !== undefined && id !== '')
        ? _tcLists.find(function(x){ return String(x.id) === String(id); })
        : {};
    t = t || {};
    document.getElementById('tcFormTitle').textContent = id ? 'Edit T&C List' : 'New T&C List';
    document.getElementById('tcName').value = t.name||'';
    _tcOtherTerms = (t.other_terms||[]).map(function(x){ return {text:x}; });
    tcRenderOtherTerms();
    document.getElementById('tcEditForm').style.display = 'block';
    document.getElementById('tcEditForm').scrollIntoView({behavior:'smooth',block:'nearest'});
    document.getElementById('tcName').focus();
}
function tcCancelForm() {
    document.getElementById('tcEditForm').style.display = 'none';
    _tcEditId = null;
}
function tcToggleCredit() {
    /* payment type moved to supplier ledger — no-op */
}
function tcRenderOtherTerms() {
    var el = document.getElementById('tcOtherTermsList');
    if (!_tcOtherTerms.length) { el.innerHTML = ''; return; }
    el.innerHTML = _tcOtherTerms.map(function(t,i){
        return '<div style="display:flex;gap:8px;align-items:flex-start">'
            + '<input class="form-input" type="text" value="'+escHtml(t.text)+'" placeholder="Enter term…"'
            + ' oninput="_tcOtherTerms['+i+'].text=this.value" style="flex:1">'
            + '<button onclick="_tcOtherTerms.splice('+i+',1);tcRenderOtherTerms()" style="height:34px;width:34px;border-radius:6px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.08);color:var(--red-text);cursor:pointer;font-size:14px;flex-shrink:0">&#10005;</button>'
            + '</div>';
    }).join('');
}
function tcAddOtherTerm() {
    _tcOtherTerms.push({text:''});
    tcRenderOtherTerms();
    // Focus last input
    var inputs = document.getElementById('tcOtherTermsList').querySelectorAll('input');
    if (inputs.length) inputs[inputs.length-1].focus();
}
async function tcSaveList() {
    var name = document.getElementById('tcName').value.trim();
    if (!name) { toast('List name is required','error'); return; }
    var payload = {
        id:            _tcEditId || null,
        name:          name,
        delivery_days: null,
        delivery_mode: null,
        delivery_notes:null,
        payment_type:  null,
        credit_days:   null,
        payment_notes: null,
        other_terms:   _tcOtherTerms.map(function(t){ return t.text.trim(); }).filter(Boolean),
    };
    try {
        var res = await fetch('/api/procurement/tc/save', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message||'Save failed');
        toast(_tcEditId ? 'T&C list updated' : 'T&C list saved', 'success');
        await _tcLoadFromDB();
        tcRenderLists();
        document.getElementById('tcEditForm').style.display = 'none';
        _tcEditId = null;
        tcPopulateSelect('supModalTCList', null);
        tcPopulateSelect('poModalTCList', null);
    } catch(e) { toast('Save failed: '+e.message, 'error'); }
}
async function tcDeleteList(id) {
    if (!confirm('Delete this T&C list? This cannot be undone.')) return;
    try {
        var res = await fetch('/api/procurement/tc/delete', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id:id})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message||'Delete failed');
        toast('T&C list deleted','success');
        await _tcLoadFromDB();
        tcRenderLists();
        tcPopulateSelect('supModalTCList', null);
        tcPopulateSelect('poModalTCList', null);
    } catch(e) { toast('Delete failed: '+e.message,'error'); }
}

/* Build T&C text preview */
function tcBuildPreview(id) {
    var t = _tcLists.find(function(x){ return String(x.id)===String(id); });
    if (!t) return '';
    var lines = [];
    if (t.delivery_mode) lines.push('&#128666; <strong>Delivery Mode:</strong> '+escHtml(t.delivery_mode)+(t.delivery_notes?' &mdash; '+escHtml(t.delivery_notes):''));
    if (t.other_terms && t.other_terms.length) {
        lines.push('&#128221; <strong>Other Terms:</strong>');
        t.other_terms.forEach(function(term,i){ lines.push('&nbsp;&nbsp;'+(i+1)+'. '+escHtml(term)); });
    }
    return lines.join('<br>');
}

/* T&C list buttons — event delegation to avoid quoting issues */
document.addEventListener('click', function(e){
    var editBtn = e.target.closest('.tc-edit-btn');
    var delBtn  = e.target.closest('.tc-del-btn');
    if (editBtn) tcOpenForm(editBtn.dataset.tcid);
    if (delBtn)  tcDeleteList(delBtn.dataset.tcid);
});

/* Supplier modal T&C preview */
function supPreviewTC(id) {
    var box = document.getElementById('supTCPreviewBox');
    var txt = document.getElementById('supTCPreviewText');
    if (!id || !box || !txt) { if(box) box.style.display='none'; return; }
    var preview = tcBuildPreview(id);
    if (preview) { txt.innerHTML = preview; box.style.display = 'block'; }
    else { box.style.display = 'none'; }
}

/* PO modal T&C preview */
function poPreviewTC(id) {
    var box = document.getElementById('poTCPreviewBox');
    var txt = document.getElementById('poTCPreviewText');
    if (!id || !box || !txt) { if(box) box.style.display='none'; return; }
    var preview = tcBuildPreview(id);
    if (preview) { txt.innerHTML = preview; box.style.display = 'block'; }
    else { box.style.display = 'none'; }
}

/* Populate T&C selects when modals open */
function tcLoadSelects() {
    tcPopulateSelect('supModalTCList', null);
    tcPopulateSelect('poModalTCList', null);
}

/* ════════════════════════════════════════════════════════════════
   QUICK-ADD NEW SUPPLIER / NEW MATERIAL FROM PO MODAL
════════════════════════════════════════════════════════════════ */
var _poReturnToPoModal = false;  // flag to re-open PO modal after quick-add

function poQuickNewSupplier() {
    // Remember current PO modal state
    _poReturnToPoModal = true;
    // Open supplier modal for new entry — PO modal stays open behind it
    openSupModal(null);
    // Move supplier modal z-index above PO modal
    var supM = document.getElementById('supModal');
    if (supM) supM.style.zIndex = '900';
}

function poQuickNewMaterial() {
    _poReturnToPoModal = true;
    // Open material edit modal for new entry
    openEditModal(null);
    var editM = document.getElementById('editModal');
    if (editM) editM.style.zIndex = '900';
}

/* Hook into saveSupplier to refresh PO supplier list after quick-add */
var _origSaveSupplier = typeof saveSupplier !== 'undefined' ? saveSupplier : null;
if (_origSaveSupplier) {
    var _patchedSaveSupplier = _origSaveSupplier;
}
/* After supplier saved — refresh PO supplier datalist and auto-fill */
function _poAfterQuickSupplier(supplierName) {
    if (!_poReturnToPoModal) return;
    _poReturnToPoModal = false;
    // Refresh supplier datalist in PO modal
    fetch('/api/procurement/suppliers')
        .then(function(r){ return r.json(); })
        .then(function(d){
            var supListEl = document.getElementById('poSupplierList');
            if (supListEl && d.status==='ok') {
                supListEl.innerHTML = (d.suppliers||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
            }
            // Auto-fill the new supplier name
            if (supplierName) {
                var supEl = document.getElementById('poModalSupplier');
                if (supEl) { supEl.value = supplierName; poModalSupplierChange(); }
            }
        }).catch(function(){});
}

/* After material saved — refresh material datalist in PO modal */
function _poAfterQuickMaterial(materialName) {
    if (!_poReturnToPoModal) return;
    _poReturnToPoModal = false;
    // Refresh _allRows and datalist
    loadData();
    setTimeout(function(){
        var matListEl = document.getElementById('poMaterialList');
        if (matListEl) {
            var matOpts = _allRows.map(function(r){ return '<option value="'+escHtml(r.material_name)+'">'; }).join('');
            matListEl.innerHTML = matOpts;
        }
        // Find the last empty line and fill it
        if (materialName) {
            var emptyLine = _poLines.findIndex(function(l){ return !l.material.trim(); });
            if (emptyLine >= 0) {
                _poLines[emptyLine].material = materialName;
                poRenderLines();
            }
        }
        toast('Material added — you can now select it in the PO', 'success');
    }, 800);
}

/* Init T&C selects on load */
document.addEventListener('DOMContentLoaded', async function(){
    await _tcLoadFromDB();
    tcLoadSelects();
});


/* ════════════════════════════════════════════════════════════════
   PO FORM PANE — replaces the modal
════════════════════════════════════════════════════════════════ */

/* Inject form HTML once on first open */
var _poFormInjected = false;
function _poInjectForm() {
    if (_poFormInjected) return;
    _poFormInjected = true;
    document.getElementById('po-form-body').innerHTML = '\n\n            <!-- GST State Warning Banner (shown by poCheckGstStates when missing) -->\n            <div id="poGstStateBanner" style="display:none;margin:14px 16px 0;padding:10px 14px;border-radius:8px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:12px;line-height:1.6"><div style="display:flex;align-items:flex-start;gap:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><div><strong>State information missing &mdash; cannot save PO.</strong><br><span id="poGstStateBannerMsg" style="font-weight:400">&mdash;</span></div></div></div>\n\n            <!-- PO Header -->\n            <div class="form-card" style="margin:14px 16px 0;border-radius:10px">\n                <div class="form-card-head">\n                    <div class="form-card-head-title">\n                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/></svg>\n                        PO DETAILS\n                    </div>\n                    <div style="display:flex;align-items:center;gap:8px">\n                        <span class="form-card-badge" id="poModalStatusBadge">DRAFT</span>\n                        \n                    </div>\n                </div>\n                <div class="form-card-body" style="padding:12px 14px">\n                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 2fr 100px;gap:12px">\n                        <div class="form-group">\n                            <label class="form-label">PO Type</label>\n                            <select class="form-input-styled combo" id="poVoucherType" onchange="poVoucherTypeChange()">\n                                <option value="">— Select Type —</option>\n                            </select>\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">PO Number</label>\n                            <input class="form-input-styled" type="text" id="poModalNum" placeholder="Generating&#8230;" readonly\n                                style="font-family:var(--font-mono);font-weight:700;color:var(--teal)">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">PO Date</label>\n                            <input class="form-input-styled" type="date" id="poModalDate">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Supplier Name <span class="req">*</span></label>\n                            <div style="display:flex;gap:6px;align-items:center">\n                                <input class="form-input-styled" type="text" id="poModalSupplier" placeholder="Select or type supplier&#8230;" list="poSupplierList" autocomplete="off" oninput="poModalSupplierChange()" style="flex:1">\n                                <button onclick="poQuickNewSupplier()" title="Add new supplier" type="button"\n                                    style="height:36px;padding:0 10px;border-radius:7px;border:1px solid rgba(37,99,235,.3);background:rgba(37,99,235,.08);color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body);white-space:nowrap;flex-shrink:0">\n                                    + New Supplier\n                                <kbd style="margin-left:4px;font-size:8px;padding:1px 5px;border-radius:3px;border:1px solid rgba(37,99,235,.4);background:rgba(37,99,235,.08);color:#1d4ed8;font-family:monospace;letter-spacing:0;line-height:1.4">Alt+S</kbd>\n                                </button>\n                            </div>\n                            <datalist id="poSupplierList"></datalist>\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Status</label>\n                            <input type="hidden" id="poModalStatus" value="open">                            <span id="poStatusChip" style="font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;text-transform:uppercase;letter-spacing:.6px;display:inline-block;background:rgba(14,165,233,.12);color:#0284c7">OPEN</span>\n                        </div>\n                    </div>\n                </div>\n            </div>\n\n            <!-- Line Items — Pack Size removed, Amount auto-calculates -->\n            <div class="form-card" style="margin:10px 16px 0;border-radius:10px">\n                <div class="form-card-head">\n                    <div class="form-card-head-title">\n                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>\n                        LINE ITEMS\n                    </div>\n                    <div style="display:flex;align-items:center;gap:8px">\n                        <span id="poLineCount" style="font-size:10px;color:rgba(255,255,255,.7)">0 items</span>\n                        <button onclick="poAddLine()" style="height:26px;padding:0 12px;border-radius:6px;border:none;background:#fff;color:#1d4ed8;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px">\n                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>\n                            + Add Item\n                        </button>\n                        <button onclick="poQuickNewMaterial()" title="Add new material to database" type="button"\n                            style="height:26px;padding:0 10px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;font-size:10.5px;font-weight:700;cursor:pointer;font-family:var(--font-body)">\n                            + New Material\n                            <kbd style="margin-left:4px;font-size:8px;padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.2);font-family:monospace;letter-spacing:0;line-height:1.4">Alt+M</kbd>\n                        </button>\n                    </div>\n                </div>\n                <div style="overflow-x:auto">\n                    <table style="width:100%;border-collapse:collapse;font-size:12.5px">\n                        <thead>\n                            <tr style="background:var(--surface2);border-bottom:1px solid var(--border2)">\n                                <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:32px">#</th>\n                                <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">Material Name *</th>\n                                <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:140px">Quantity</th>\n                                <th style="padding:9px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:55px">UOM</th>\n                                <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:140px">Rate per UOM (&#x20b9;)</th>\n                                <th style="padding:9px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:80px">Disc %</th>\n                                <th style="padding:9px 10px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:72px">GST %</th>\n                                <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;width:150px">Amount (&#x20b9;)</th>\n                                <th style="padding:9px 8px;width:36px"></th>\n                            </tr>\n                        </thead>\n                        <tbody id="poLinesTbody">\n                            <tr><td colspan="9" style="padding:24px;text-align:center;color:var(--muted);font-size:12px">No items &#8212; click &ldquo;+ Add Item&rdquo; above</td></tr>\n                        </tbody>\n                        <tfoot>\n                            <tr style="border-top:1px solid var(--border)">\n                                <td colspan="9" style="padding:5px 10px">\n                                    <button onclick="poAddLine()" style="height:26px;padding:0 12px;border-radius:6px;border:1px dashed var(--border2);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font-body);display:flex;align-items:center;gap:4px"\n                                        onmouseover="this.style.borderColor=\'#2563eb\';this.style.color=\'#2563eb\';this.style.background=\'rgba(37,99,235,.04)\'"\n                                        onmouseout="this.style.borderColor=\'\';this.style.color=\'\';this.style.background=\'transparent\'">\n                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>\n                                        Add another item\n                                    </button>\n                                </td>\n                            </tr>\n                            <tr id="poFreightRow" style="border-top:1px solid var(--border);background:var(--surface)">\n                                <td colspan="6" style="padding:5px 14px;text-align:right;font-size:10.5px;color:var(--muted)">\n                                    <label style="display:flex;align-items:center;gap:6px;justify-content:flex-end;cursor:pointer">\n                                        <input type="checkbox" id="poFreightEnabled" onchange="poToggleCharge(\'freight\')" style="cursor:pointer">\n                                        <span style="font-weight:600">Freight Charges (&#x20b9;)</span>\n                                    </label>\n                                </td>\n                                <td style="padding:4px 8px;text-align:center;color:var(--muted)">&#8212;</td>\n                                <td style="padding:4px 8px;">\n                                    <input type="number" id="poFreightAmt" min="0" step="0.01" placeholder="0.00" disabled\n                                        onchange="poCalcGrandTotal()" oninput="poCalcGrandTotal()"\n                                        style="width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);text-align:right;font-size:12.5px;opacity:.4">\n                                </td>\n                                <td></td>\n                            </tr>\n                            <tr id="poPackingRow" style="background:var(--surface)">\n                                <td colspan="6" style="padding:5px 14px;text-align:right;font-size:10.5px;color:var(--muted)">\n                                    <label style="display:flex;align-items:center;gap:6px;justify-content:flex-end;cursor:pointer">\n                                        <input type="checkbox" id="poPackingEnabled" onchange="poToggleCharge(\'packing\')" style="cursor:pointer">\n                                        <span style="font-weight:600">Packing Charges (&#x20b9;)</span>\n                                    </label>\n                                </td>\n                                <td style="padding:4px 8px;text-align:center;color:var(--muted)">&#8212;</td>\n                                <td style="padding:4px 8px;">\n                                    <input type="number" id="poPackingAmt" min="0" step="0.01" placeholder="0.00" disabled\n                                        onchange="poCalcGrandTotal()" oninput="poCalcGrandTotal()"\n                                        style="width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);text-align:right;font-size:12.5px;opacity:.4">\n                                </td>\n                                <td></td>\n                            </tr>\n                            <tr id="poOrderDiscRow" style="border-top:1px solid var(--border);background:var(--surface)">\n                                <td colspan="6" style="padding:5px 14px;text-align:right;font-size:10.5px;color:var(--muted);font-weight:600">Discount (&#x20b9; off order)</td>\n                                <td style="padding:4px 8px;">\n                                    <input type="number" id="poOrderDiscount" min="0" step="0.01" placeholder="0.00"\n                                        onchange="poCalcGrandTotal()" oninput="poCalcGrandTotal()"\n                                        style="width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-family:var(--font-mono);text-align:right;font-size:12.5px">\n                                </td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowGross" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">Items Subtotal</td>\n                                <td id="poFootGross" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowFreightSum" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">Freight Charges</td>\n                                <td id="poFootFreightSum" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowPackingSum" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">Packing Charges</td>\n                                <td id="poFootPackingSum" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowOrderDisc" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">Discount</td>\n                                <td id="poFootOrderDisc" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--red-text)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowTax" style="border-top:1px solid var(--border);background:var(--surface2)">\n                                <td colspan="7" style="padding:7px 14px;font-size:10.5px;font-weight:600;color:var(--muted);text-align:right">Taxable Amount</td>\n                                <td id="poFootTaxable" style="padding:7px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowCGST" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">CGST</td>\n                                <td id="poFootCGST" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowSGST" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">SGST</td>\n                                <td id="poFootSGST" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr id="poFootRowIGST" style="display:none;background:var(--surface2)">\n                                <td colspan="7" style="padding:4px 14px;font-size:10.5px;color:var(--muted);text-align:right">IGST</td>\n                                <td id="poFootIGST" style="padding:4px 14px;text-align:right;font-family:var(--font-mono);font-size:12px;color:var(--muted)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                            <tr style="border-top:2px solid var(--border2);background:var(--surface2)">\n                                <td colspan="7" style="padding:12px 14px;font-size:11px;font-weight:800;color:var(--text);text-align:right;text-transform:uppercase;letter-spacing:.5px">Grand Total</td>\n                                <td id="poGrandTotal" style="padding:12px 14px;text-align:right;font-weight:800;font-size:16px;color:var(--text);font-family:var(--font-mono)">&#8212;</td>\n                                <td></td>\n                            </tr>\n                        </tfoot>\n                    </table>\n                </div>\n                <datalist id="poMaterialList"></datalist>\n            </div>\n\n            <!-- Supplier Details -->\n            <div class="form-card" style="margin:10px 16px 0;border-radius:10px">\n                <div class="form-card-head">\n                    <div class="form-card-head-title">\n                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>\n                        SUPPLIER DETAILS\n                    </div>\n                    <span style="font-size:10px;color:rgba(255,255,255,.7)">Auto-filled from Supplier Master</span>\n                </div>\n                <div class="form-card-body" style="padding:12px 14px">\n                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">\n                        <div class="form-group">\n                            <label class="form-label">Contact Person</label>\n                            <input class="form-input-styled" id="poSupContact" readonly placeholder="—" style="background:var(--surface2)">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Phone</label>\n                            <input class="form-input-styled" id="poSupPhone" readonly placeholder="—" style="background:var(--surface2)">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Email</label>\n                            <input class="form-input-styled" id="poSupEmail" readonly placeholder="—" style="background:var(--surface2)">\n                        </div>\n                    </div>\n                    <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">\n                        <div class="form-group">\n                            <label class="form-label">Address</label>\n                            <input class="form-input-styled" id="poSupAddress" readonly placeholder="—" style="background:var(--surface2)">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">GST Number</label>\n                            <input class="form-input-styled" id="poSupGST" readonly placeholder="—" style="background:var(--surface2);font-family:var(--font-mono);letter-spacing:.5px">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">PAN Number</label>\n                            <input class="form-input-styled" id="poSupPAN" readonly placeholder="—" style="background:var(--surface2);font-family:var(--font-mono);letter-spacing:.5px">\n                        </div>\n                    </div>\n                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">\n                        <div class="form-group">\n                            <label class="form-label">Payment Terms <span style="font-weight:400;font-size:9px;color:var(--muted)">(from Supplier Ledger)</span></label>\n                            <input class="form-input-styled" id="poSupPayTerms" readonly placeholder="—" style="background:var(--surface2)">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Credit Days <span style="font-weight:400;font-size:9px;color:var(--muted)">(from Supplier Ledger)</span></label>\n                            <input class="form-input-styled" id="poSupCreditDays" readonly placeholder="—" style="background:var(--surface2);font-family:var(--font-mono)">\n                        </div>\n                    </div>\n                </div>\n            </div>\n\n            <!-- Billing & Shipping Addresses -->\n            <div class="form-card" style="margin:10px 16px 0;border-radius:10px">\n                <div class="form-card-head">\n                    <div class="form-card-head-title">\n                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>\n                        BILLING &amp; SHIPPING\n                    </div>\n                    <button onclick="openGodownManager()" style="height:22px;padding:0 9px;border-radius:5px;border:none;background:#fff;color:#1d4ed8;font-size:10px;font-weight:700;cursor:pointer;font-family:var(--font-body)">&#9881; Manage</button>\n                </div>\n                <div class="form-card-body" style="padding:12px 14px">\n                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">\n                        <div class="form-group">\n                            <label class="form-label">Billing Address <span class="req">*</span></label>\n                            <select class="form-input-styled combo" id="poBillingAddr" onchange="poUpdateAddressDisplay(\'billing\')">\n                                <option value="">— Select Billing Address —</option>\n                            </select>\n                            <div id="poBillingDisplay" style="font-size:11px;color:var(--muted);margin-top:5px;line-height:1.6;padding:0 2px"></div>\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Shipping Address <span class="req">*</span></label>\n                            <select class="form-input-styled combo" id="poShippingAddr" onchange="poUpdateAddressDisplay(\'shipping\')">\n                                <option value="">— Select Shipping Address —</option>\n                            </select>\n                            <div id="poShippingDisplay" style="font-size:11px;color:var(--muted);margin-top:5px;line-height:1.6;padding:0 2px"></div>\n                        </div>\n                    </div>\n                </div>\n            </div>\n\n            <!-- Delivery Date & Remarks -->\n            <div class="form-card" style="margin:10px 16px 14px;border-radius:10px">\n                <div class="form-card-head">\n                    <div class="form-card-head-title">\n                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>\n                        DELIVERY &amp; REMARKS\n                    </div>\n                </div>\n                <div class="form-card-body" style="padding:12px 14px">\n                    <div style="display:grid;grid-template-columns:160px 1fr 1fr 1fr;gap:12px">\n                        <div class="form-group">\n                            <label class="form-label">Delivery Date</label>\n                            <input class="form-input-styled" type="date" id="poModalExpected">\n                        </div>\n                        <div class="form-group">\n                            <label class="form-label">Terms &amp; Conditions\n                                <button type="button" onclick="openTCManager()" style="margin-left:6px;height:18px;padding:0 7px;border-radius:4px;border:1px solid rgba(37,99,235,.3);background:rgba(37,99,235,.08);color:#1d4ed8;font-size:9px;font-weight:700;cursor:pointer;font-family:var(--font-body);vertical-align:middle">Manage</button>\n                            </label>\n                            <select class="form-input-styled combo" id="poModalTCList" onchange="poPreviewTC(this.value)">\n                                <option value="">— None —</option>\n                            </select>\n                     <div class="form-group">\n                            <label class="form-label">Declaration                                 <button type="button" onclick="openDeclManager()" style="margin-left:6px;height:18px;padding:0 7px;border-radius:4px;border:1px solid rgba(37,99,235,.3);background:rgba(37,99,235,.08);color:#1d4ed8;font-size:9px;font-weight:700;cursor:pointer;font-family:var(--font-body);vertical-align:middle">Manage</button>\n                            </label>\n                            <select class="form-input-styled combo" id="poModalDeclaration">\n                                <option value="">— None —</option>\n                            </select>\n                        </div>\n                           </div>\n                        <div class="form-group">\n                            <label class="form-label">Remarks</label>\n                            <textarea class="form-input-styled" id="poModalRemarks" placeholder="Any special instructions&#8230;" rows="1" style="min-height:36px;resize:none"></textarea>\n                        </div>\n                    </div>\n                    <div id="poTCPreviewBox" style="display:none;margin-top:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px">\n                        <div style="font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">T&amp;C Preview</div>\n                        <div id="poTCPreviewText" style="font-size:11px;color:var(--text);line-height:1.7"></div>\n                    </div>\n                </div>\n            </div>\n\n        </div>';
    // Re-wire datalists etc
    _poRefreshMatDatalist();
    // Initialize comboboxes for the freshly-rendered <select class="combo"> nodes
    if (typeof comboboxAutoInit === 'function') comboboxAutoInit(document.getElementById('po-form-body'));
}

/* ── PO Auto-Status chip ─────────────────────────────────────────── */
var _poStatusColors = {
    open:         {bg:'rgba(14,165,233,.12)',  color:'#0284c7'},
    approved:     {bg:'rgba(16,185,129,.12)',  color:'var(--green-text)'},
    not_approved: {bg:'rgba(245,158,11,.12)',  color:'var(--amber-text)'},
    partial:      {bg:'rgba(245,158,11,.12)',  color:'var(--amber-text)'},
    closed:       {bg:'rgba(16,185,129,.2)',   color:'var(--green-text)'},
    cancelled:    {bg:'var(--text-08)',        color:'var(--muted)'}
};

/* Auto-calculate PO status based on context:
   - cancelled: PO is cancelled (set by cancel action)
   - closed:    set by backend when all items fully GRN-received
   - partial:   set by backend when some items received
   - open:      new PO or no GRN yet
*/
function _poCalcStatus(existingStatus) {
    // If cancelled, always stay cancelled
    if (existingStatus === 'cancelled') return 'cancelled';
    // If backend has set partial/closed via GRN, preserve it
    if (existingStatus === 'partial' || existingStatus === 'closed') return existingStatus;
    // approved/not_approved are manual workflow states — preserve them
    if (existingStatus === 'approved' || existingStatus === 'not_approved') return existingStatus;
    // New PO or no GRN yet → open
    return 'open';
}

function _poInstallStatusChip() {
    var sel = document.getElementById('poModalStatus');
    if (!sel) return;
    if (sel.tagName !== 'SELECT') return; // already replaced on previous open

    // Replace SELECT with: hidden input (keeps value) + visible chip span
    var hidden = document.createElement('input');
    hidden.type  = 'hidden';
    hidden.id    = 'poModalStatus';
    hidden.value = sel.value || 'open';

    var chip = document.createElement('span');
    chip.id = 'poStatusChip';
    chip.style.cssText = 'display:inline-block;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;text-transform:uppercase;letter-spacing:.6px;cursor:default';

    sel.parentNode.insertBefore(hidden, sel);
    sel.parentNode.replaceChild(chip, sel);
}

function _poSetStatus(status) {
    var hidden = document.getElementById('poModalStatus');
    var chip   = document.getElementById('poStatusChip');
    var badge  = document.getElementById('poModalStatusBadge');
    if (hidden) hidden.value = status || 'open';
    var s = status || 'open';
    var c = _poStatusColors[s] || _poStatusColors.open;
    if (chip) {
        chip.textContent   = s.replace('_',' ').toUpperCase();
        chip.style.background = c.bg;
        chip.style.color      = c.color;
    }
    if (badge) {
        badge.textContent  = s.replace('_',' ').toUpperCase();
    }
    window._poCurrentStatus = s;
}

/* ── PO Save — read status from hidden input ── */

async function openPoFormPane(row, prefillSupplier, prefillLines) {
    _poInjectForm();
    var pane = document.getElementById('po-form-pane');
    var list = document.getElementById('po-list-pane');

    // Install status chip (replaces SELECT with chip on first call)
    _poInstallStatusChip();

    // Set title
    _poEditId = row ? row.id : null;
    _poUpdateShareButtons();
    document.getElementById('poFormEyebrow').textContent = row ? 'EDIT PO' : 'NEW PO';
    document.getElementById('poFormTitle').textContent   = row ? 'Edit Purchase Order' : 'New Purchase Order';

    // Sync eyebrow/title in old modal elements (used by savePoModal etc)
    if (document.getElementById('poModalEyebrow')) document.getElementById('poModalEyebrow').textContent = row ? 'EDIT PO' : 'NEW PO';
    if (document.getElementById('poModalTitle'))   document.getElementById('poModalTitle').textContent   = row ? 'Edit Purchase Order' : 'New Purchase Order';

    // Show/hide delete and cancel buttons
    var delBtn = document.getElementById('poFormDeleteBtn');
    if (delBtn) delBtn.style.display = row ? 'inline-flex' : 'none';
    var cancelBtn = document.getElementById('poFormCancelBtn');
    if (cancelBtn) cancelBtn.style.display = (row && row.status !== 'cancelled') ? 'inline-flex' : 'none';

    // Ensure declarations and T&C lists are loaded BEFORE populating selects
    if (!_declLists || !_declLists.length) {
        try { await _declLoadFromDB(); } catch(e) {}
    }
    if (!_tcLists || !_tcLists.length) {
        try { await _tcLoadFromDB(); } catch(e) {}
    }

    // Populate supplier datalist
    var supListEl = document.getElementById('poSupplierList');
    if (supListEl) {
        if (_supRows && _supRows.length) {
            supListEl.innerHTML = _supRows.map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
        } else {
            fetch('/api/procurement/suppliers').then(function(r){ return r.json(); }).then(function(d){
                if (d.status==='ok' && supListEl) supListEl.innerHTML=(d.suppliers||[]).map(function(s){ return '<option value="'+escHtml(s.supplier_name)+'">'; }).join('');
                if (d.status==='ok') _supRows = d.suppliers||[];
            }).catch(function(){});
        }
    }

    // Fill fields
    var today = new Date().toISOString().slice(0,10);
    var setV = function(id, v){
        var e=document.getElementById(id);
        if(e){
            e.value=v||'';
            if(e._comboInit && typeof comboboxSyncDisplay === 'function') comboboxSyncDisplay(e);
        }
    };

    // For cancelled POs: show blank form, keep only po_num
    var isCancelledReuse = row && row.status === 'cancelled';
    if (isCancelledReuse) {
        // Reuse mode: blank everything, keep po_num, reset status to draft
        setV('poModalNum',      row.po_num || '');
        var numElC = document.getElementById('poModalNum');
        if (numElC) { numElC.style.color = 'var(--teal)'; numElC.style.fontStyle = ''; numElC.placeholder = ''; }
        setV('poModalDate',     today);
        setV('poModalSupplier', '');
        setV('poModalExpected', '');
        setV('poModalRemarks',  '');
        setV('poModalDeliveryDays', '');
        declPopulateSelect('poModalDeclaration', null);
        _poSetStatus('open');
        tcPopulateSelect('poModalTCList', null);
        poLoadAddresses();
        // Reset charges
        ['Freight','Packing'].forEach(function(t){
            var cb=document.getElementById('po'+t+'Enabled'); var inp=document.getElementById('po'+t+'Amt');
            if(cb){cb.checked=false;} if(inp){inp.disabled=true;inp.style.opacity='.4';inp.value='';}
        });
        _poLines = [{material:'',qty:'',qty_per_pkg:'',packages:'',total_qty:0,rate:'',uom:'KG'}];
        poRenderLines(0);
        list.style.display = 'none';
        pane.style.display = 'block';
        toast('PO ' + row.po_num + ' ready to reuse — fill in new details', 'info', 4000);

    } else {
        // Normal new/edit flow
        if (!row) {
            var numEl = document.getElementById('poModalNum');
            if (numEl) {
                numEl.placeholder = 'Auto-assigned on save';
                numEl.style.color = 'var(--muted)';
                numEl.style.fontStyle = 'italic';
            }
            // Preview the next voucher number from active numbering style
            if (typeof _vnPreviewNextPO === 'function') {
                _vnPreviewNextPO(function(preview) {
                    var el = document.getElementById('poModalNum');
                    if (el && !el.value && preview) {
                        el.placeholder = 'Next: ' + preview;
                    }
                });
            }
        } else {
            var numEl2 = document.getElementById('poModalNum');
            if (numEl2) { numEl2.placeholder = ''; numEl2.style.color = 'var(--teal)'; numEl2.style.fontStyle = ''; }
        }
        setV('poModalDate',     row ? (row.po_date||today) : today);
        setV('poModalSupplier', row ? (row.supplier||row.supplier_name||'') : (prefillSupplier||''));
        setV('poModalExpected', row ? (row.expected||row.delivery_date||'') : '');
        setV('poModalRemarks',  row ? (row.remarks||'') : '');
        setV('poModalDeliveryDays', row ? (row.delivery_days||'') : '');
        declPopulateSelect('poModalDeclaration', row ? (row.declaration_id||null) : null);
        _poSetStatus(_poCalcStatus(row ? (row.status||'open') : 'open'));

        // Load voucher types from General OP
        poLoadVoucherTypes(row ? (row.voucher_type_name||'') : '');

        // Load T&C select — restore saved value if editing existing PO
        tcPopulateSelect('poModalTCList', row ? (row.tc_list_id||null) : null);
        // For new POs: auto-select first T&C and first declaration as defaults
        if (!row && !isCancelledReuse) {
            if (_tcLists && _tcLists.length) {
                var defaultTc = document.getElementById('poModalTCList');
                if (defaultTc && !defaultTc.value) {
                    defaultTc.value = _tcLists[0].id;
                    poPreviewTC(_tcLists[0].id);
                }
            }
            if (_declLists && _declLists.length) {
                var defaultDecl = document.getElementById('poModalDeclaration');
                if (defaultDecl && !defaultDecl.value) defaultDecl.value = _declLists[0].id;
            }
        }
        poLoadAddresses();

        // Load lines
        _poLines = [];
        if (prefillLines && prefillLines.length) {
            prefillLines.forEach(function(l){ _poLines.push(l); });
            poRenderLines();
            list.style.display  = 'none';
            pane.style.display  = 'block';
            if (row && row.supplier) poFillSupplierDetails(row.supplier||row.supplier_name||'');
            if (prefillSupplier)    poFillSupplierDetails(prefillSupplier);
            // New PO from prefill — no approval yet
            _poCurrentApprovalStatus = 'pending';
            _poCurrentApprovedBy     = '';
            _poCurrentApprovedAt     = '';
            if (typeof poUpdateApprovalUI === 'function') poUpdateApprovalUI();
        } else if (row && row.id) {
            _poLines.push({material:'',qty:'',rate:''});
            poRenderLines();
            list.style.display = 'none';
            pane.style.display = 'block';
            fetch('/api/procurement/po/get?id=' + row.id)
                .then(function(r){ return r.json(); })
                .then(function(d){
                    if (d.status!=='ok') throw new Error(d.message);
                    var o = d.order;
                    setV('poModalNum',      o.po_num||'');
                    setV('poModalDate',     o.po_date||'');
                    setV('poModalSupplier', o.supplier_name||'');
                    setV('poModalExpected', o.delivery_date||'');
                    setV('poModalRemarks',  o.remarks||'');
                    setV('poModalDeliveryDays', o.delivery_days||'');
                    tcPopulateSelect('poModalTCList', o.tc_list_id||null);
                    declPopulateSelect('poModalDeclaration', o.declaration_id||null);
                    _poSetStatus(o.status||'open');
                    // Restore voucher type (re-load list then set value)
                    poLoadVoucherTypes(o.voucher_type_name||'');
                    // ── Capture approval status from the loaded PO ──
                    _poCurrentApprovalStatus = (o.approval_status || 'pending');
                    _poCurrentApprovedBy     = o.approved_by || '';
                    _poCurrentApprovedAt     = o.approved_at || '';
                    if (typeof poUpdateApprovalUI === 'function') poUpdateApprovalUI();
                    _poLines = (o.items||[]).map(function(i){
                        var mr = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(i.material||'').toLowerCase(); });
                        var qtyNum = parseFloat(i.qty) || 0;
                        var qppNum = parseFloat(i.qty_per_pkg) || 0;
                        var pkgsNum = parseInt(i.packages) || 0;
                        // Back-fill legacy POs that only have total qty (no packages / qty_per_pkg)
                        // so the user sees what the PO contains. Default: 1 pkg × total qty.
                        if (qtyNum > 0 && pkgsNum === 0 && qppNum === 0) {
                            pkgsNum = 1;
                            qppNum  = qtyNum;
                        }
                        return {
                            material:    i.material||'',
                            qty:         i.qty||'',
                            qty_per_pkg: qppNum  > 0 ? String(qppNum)  : '',
                            packages:    pkgsNum > 0 ? String(pkgsNum) : '',
                            total_qty:   qtyNum,
                            uom:         i.uom || (mr && mr.uom) || 'KG',
                            rate:        i.rate||'',
                            discount:    i.discount != null ? String(parseFloat(i.discount)||'') : '',
                            hsn_code:    i.hsn_code||'',
                            gst_rate:    i.gst_rate != null ? parseFloat(i.gst_rate) : 0,
                            cgst_amount: i.cgst_amount != null ? parseFloat(i.cgst_amount) : 0,
                            sgst_amount: i.sgst_amount != null ? parseFloat(i.sgst_amount) : 0
                        };
                    });
                    if (!_poLines.length) _poLines.push({material:'',qty:'',rate:''});

                    // Restore freight/packing charges
                    var setCharge = function(type, val) {
                        var cb  = document.getElementById('po'+(type==='freight'?'Freight':'Packing')+'Enabled');
                        var inp = document.getElementById('po'+(type==='freight'?'Freight':'Packing')+'Amt');
                        if (!cb || !inp) return;
                        if (val && parseFloat(val) > 0) {
                            cb.checked = true;
                            inp.disabled = false;
                            inp.style.opacity = '1';
                            inp.value = parseFloat(val).toFixed(2);
                        } else {
                            cb.checked = false;
                            inp.disabled = true;
                            inp.style.opacity = '.4';
                            inp.value = '';
                        }
                    };
                    setCharge('freight', o.freight_charge);
                    setCharge('packing', o.packing_charge);
                    // Restore order-level discount
                    var odInp = document.getElementById('poOrderDiscount');
                    if (odInp) odInp.value = (o.order_discount && parseFloat(o.order_discount) > 0) ? parseFloat(o.order_discount).toFixed(2) : '';

                    // For items with missing rate, try _allRows first then API
                    var ratePromises = _poLines.map(function(line, idx) {
                        if (line.material && (!line.rate || parseFloat(line.rate) <= 0)) {
                            // Check _allRows first (instant, no network)
                            var mr = (_allRows||[]).find(function(r){
                                return (r.material_name||'').toLowerCase() === line.material.toLowerCase();
                            });
                            if (mr && mr.last_purchase_rate && parseFloat(mr.last_purchase_rate) > 0) {
                                line.rate = String(mr.last_purchase_rate);
                                return Promise.resolve();
                            }
                            // Fallback: ask server
                            return fetch('/api/procurement/po/last_rate?material=' + encodeURIComponent(line.material))
                                .then(function(r){ return r.json(); })
                                .then(function(d){
                                    if (d.status==='ok' && d.rate && parseFloat(d.rate) > 0) {
                                        line.rate = String(d.rate);
                                    }
                                })
                                .catch(function(){});
                        }
                        return Promise.resolve();
                    });

                    Promise.all(ratePromises).then(function(){
                        poRenderLines();
                        if (o.supplier_name) poFillSupplierDetails(o.supplier_name);
                    });
                })
                .catch(function(err){ toast('Could not load PO: '+err.message,'error'); });
        } else {
            _poLines.push({material:'',qty:'',rate:''});
            poRenderLines(0);
            list.style.display = 'none';
            pane.style.display = 'block';
            if (prefillSupplier) poFillSupplierDetails(prefillSupplier);
            // Fresh PO — no approval yet
            _poCurrentApprovalStatus = 'pending';
            _poCurrentApprovedBy     = '';
            _poCurrentApprovedAt     = '';
            if (typeof poUpdateApprovalUI === 'function') poUpdateApprovalUI();
        }
    } // end if/else isCancelledReuse
    // Scroll form to top
    pane.scrollTo(0,0);
}

function poCloseFormPane() {
    document.getElementById('po-form-pane').style.display = 'none';
    document.getElementById('po-list-pane').style.display = '';
    loadPoData();
}

function poFormDelete() {
    if (!_poEditId) return;
    var row = _poRows.find(function(r){ return r.id===_poEditId; }) || {po_num: 'this PO'};
    if (!confirm('Delete ' + (row.po_num||'this PO') + '?\nThis cannot be undone.')) return;
    fetch('/api/procurement/po/delete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id:_poEditId})
    }).then(function(r){ return r.json(); })
    .then(function(d){
        if (d.status!=='ok') throw new Error(d.message);
        toast('PO deleted','success');
        poCloseFormPane();
    }).catch(function(e){ toast('Delete failed: '+e.message,'error'); });
}

async function poCancelPO() {
    if (!_poEditId) return;
    var row = (_poRows||[]).find(function(r){ return r.id===_poEditId; }) || {};
    var poNum = row.po_num || 'this PO';
    if (!confirm(
        'Cancel ' + poNum + '?\n\n' +
        'All line items and details will be cleared.\n' +
        'The PO number is kept — you can reuse it by editing this PO.'
    )) return;
    var btn = document.getElementById('poFormCancelBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    try {
        var res = await fetch('/api/procurement/po/cancel', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id: _poEditId})
        });
        var d = await res.json();
        if (d.status !== 'ok') throw new Error(d.message);
        toast(poNum + ' cancelled — number kept for reuse', 'success', 5000);
        poCloseFormPane();
    } catch(e) {
        toast('Cancel failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✕ Cancel PO'; }
    }
}

/* Print preview in pane 2 */
async function poFormPrint() {
    if ((!_tcLists||!_tcLists.length) && typeof _tcLoadFromDB==='function') await _tcLoadFromDB();
    if ((!_declLists||!_declLists.length) && typeof _declLoadFromDB==='function') await _declLoadFromDB();
    if (!_supRows||!_supRows.length) {
        try { var _sr=await fetch('/api/procurement/suppliers'); var _sd=await _sr.json(); if(_sd.status==='ok') _supRows=_sd.suppliers||[]; } catch(e){}
    }
    if (!_allRows||!_allRows.length) {
        try { var _mr=await fetch('/api/procurement/stock_summary'); var _md=await _mr.json(); if(_md.status==='ok') _allRows=_md.rows||[]; } catch(e){}
    }
    var doc = _poBuildPrintHTML();
    if (!doc) return;
    var printPane = document.getElementById('po-print-pane');
    var iframe    = document.getElementById('poPrintIframe');
    var formPane  = document.getElementById('po-form-pane');
    formPane.style.display  = 'none';
    printPane.style.display = 'block';
    var iDoc = iframe.contentDocument || iframe.contentWindow.document;
    iDoc.open(); iDoc.write(doc); iDoc.close();
}
function printPO() { poFormPrint(); }

/* ── Show/hide share buttons based on whether a saved PO is open ── */
function _poUpdateShareButtons() {
    var hasSaved = !!_poEditId;
    var waBtn  = document.getElementById('poWhatsAppBtn');
    var emBtn  = document.getElementById('poEmailBtn');
    if (waBtn) {
        waBtn.style.display  = 'inline-flex';
        waBtn.disabled       = !hasSaved;
        waBtn.style.opacity  = hasSaved ? '1' : '.4';
        waBtn.title          = hasSaved ? 'Send PO summary via WhatsApp' : 'Save PO first';
    }
    if (emBtn) {
        emBtn.style.display  = 'inline-flex';
        emBtn.disabled       = !hasSaved;
        emBtn.style.opacity  = hasSaved ? '1' : '.4';
        emBtn.title          = hasSaved ? 'Email PO as PDF' : 'Save PO first';
    }
}

/* ── WhatsApp ── */
function poSendWhatsApp() {
    if (!_poEditId) { toast('Save the PO first', 'warning'); return; }
    // Approval gate (UI also disables the button, but defense in depth)
    if ((_poCurrentApprovalStatus || 'pending').toLowerCase() !== 'approved') {
        toast('PO must be approved before sharing via WhatsApp', 'warning');
        return;
    }
    var poNum    = (document.getElementById('poModalNum')?.value || '').trim();
    var poDate   = (document.getElementById('poModalDate')?.value || '').trim();
    var supplier = (document.getElementById('poModalSupplier')?.value || '').trim();
    var sup      = (_supRows||[]).find(function(s){ return s.supplier_name===supplier; }) || {};

    var grandText = (document.getElementById('poGrandTotal')?.textContent || '').replace(/[^\d.]/g, '');
    var grandNum  = parseFloat(grandText) || 0;

    var ctx = {
        po_id:          _poEditId,
        po_num:         poNum,
        po_date:        poDate,
        supplier_name:  supplier,
        contact_person: sup.contact_person || '',
        supplier_phone: sup.phone || '',
        grand_total:    grandNum
    };

    if (typeof openSendPoWhatsAppModal === 'function') {
        openSendPoWhatsAppModal(ctx);
    } else {
        toast('WhatsApp dialog not available — please refresh the page', 'error');
    }
}

/* ── Email with PDF ── */
async function poSendEmail() {
    if (!_poEditId) { toast('Save the PO first', 'warning'); return; }
    // Approval gate (UI-level — backend enforces too)
    if ((_poCurrentApprovalStatus || 'pending').toLowerCase() !== 'approved') {
        toast('PO must be approved before emailing', 'warning');
        return;
    }
    var poNum    = (document.getElementById('poModalNum')?.value || '').trim();
    var poDate   = (document.getElementById('poModalDate')?.value || '').trim();
    var supplier = (document.getElementById('poModalSupplier')?.value || '').trim();
    var sup      = (_supRows||[]).find(function(s){ return s.supplier_name===supplier; }) || {};

    // Compute grand total from the current form for the {grand_total} placeholder
    var grandText = (document.getElementById('poGrandTotal')?.textContent || '').replace(/[^\d.]/g, '');
    var grandNum  = parseFloat(grandText) || 0;

    var ctx = {
        po_id:          _poEditId,
        po_num:         poNum,
        po_date:        poDate,
        supplier_name:  supplier,
        contact_person: sup.contact_person || '',
        supplier_email: sup.email || '',
        grand_total:    grandNum
    };

    // Hand off to the compose-preview modal defined in procurement.html
    if (typeof openSendPoEmailModal === 'function') {
        openSendPoEmailModal(ctx);
    } else {
        toast('Send dialog not available — please refresh the page', 'error');
    }
}

function _poBuildPrintHTML() {
    var gv = function(id){ var e=document.getElementById(id); return e?e.value||'':''; };
    var supplier  = gv('poModalSupplier').trim() || '\u2014';
    var poNum     = gv('poModalNum').trim()       || '\u2014';
    var poDate    = gv('poModalDate');
    var delivDate = gv('poModalExpected');
    var delivDays = gv('poModalDeliveryDays');
    var remarks   = gv('poModalRemarks').trim();
    var status    = (window._poCurrentStatus || 'open').toUpperCase();
    var tcId      = gv('poModalTCList');

    var validLines = _poLines.filter(function(l){ return l.material&&l.material.trim(); });
    if (!validLines.length) { toast('Add at least one line item before printing','warning'); return null; }

    /* ── Supplier lookup ── */
    var sup = (_supRows||[]).find(function(s){ return s.supplier_name===supplier; });
    if (!sup) sup = {
        address:gv('poSupAddress'), gst_number:gv('poSupGST'), pan_number:gv('poSupPAN'),
        contact_person:gv('poSupContact'), phone:gv('poSupPhone'), email:gv('poSupEmail'),
        payment_type:gv('poSupPayTerms'), credit_days:gv('poSupCreditDays'), payment_terms:gv('poSupPayTerms')
    };
    sup = sup||{};
    var _ok = function(v){ return !!(v&&String(v).trim()&&String(v).trim()!=='\u2014'); };

    /* Payment line */
    var payLine = _ok(sup.payment_type)
        ? escHtml(sup.payment_type)+(_ok(sup.credit_days)?' \u2014 '+sup.credit_days+' days':'')
        : (_ok(sup.payment_terms)?escHtml(sup.payment_terms)
          :(gv('poSupPayTerms')||'\u2014'));

    /* ── Addresses ── */
    gdLoad();
    var bill = _gdBilling||{};
    var billLines = [];
    if (bill.name)  billLines.push('<strong>'+escHtml(bill.name)+'</strong>');
    if (bill.addr1) billLines.push(escHtml(bill.addr1));
    if (bill.addr2) billLines.push(escHtml(bill.addr2));
    if (bill.email) billLines.push('E-Mail : '+escHtml(bill.email));
    if (bill.gst)   billLines.push('GSTIN/UIN: <strong>'+escHtml(bill.gst)+'</strong>');
    if (bill.phone) billLines.push('Ph: '+escHtml(bill.phone));

    var shipIdx = gv('poShippingAddr');
    var godown  = (!isNaN(parseInt(shipIdx))&&_gdGodowns[parseInt(shipIdx)])?_gdGodowns[parseInt(shipIdx)]:null;
    var shipLines = [];
    if (godown) {
        if (bill.name) shipLines.push('<strong>'+escHtml(bill.name)+' \u2014 Dispatch to</strong>');
        if (_ok(godown.address)) shipLines.push(escHtml(godown.address));
        if (_ok(godown.email)||_ok(bill.email)) shipLines.push('e-mail : '+escHtml(godown.email||bill.email||''));
        if (_ok(bill.gst))       shipLines.push('GSTIN/UIN : <strong>'+escHtml(bill.gst)+'</strong>');
        if (_ok(godown.contact)) shipLines.push(escHtml(godown.contact)+(_ok(godown.phone)?' | '+escHtml(godown.phone):''));
    } else {
        shipLines.push('<strong>HCP Wellness Pvt Ltd</strong>');
    }

    var supLines = [];
    supLines.push('<strong>'+escHtml(supplier)+'</strong>');
    if (_ok(sup.address))        supLines.push(escHtml(sup.address));
    if (_ok(sup.gst_number))     supLines.push('GSTIN/UIN : <strong>'+escHtml(sup.gst_number)+'</strong>');
    if (_ok(sup.pan_number))     supLines.push('PAN: '+escHtml(sup.pan_number));
    if (_ok(sup.contact_person)) supLines.push('Contact: '+escHtml(sup.contact_person)+(_ok(sup.phone)?' | '+escHtml(sup.phone):''));
    if (_ok(sup.email))          supLines.push('E-Mail: '+escHtml(sup.email));

    /* ── Line items + per-item CGST/SGST ── */
    var total = 0;
    // ── Determine inter-state vs intra-state ──
    // Same as the live form: compare company billing state vs supplier state.
    // If either is missing, treat as intra-state (safe default; the form
    // banner has already warned the user).
    var _coState  = (_gdBilling && _gdBilling.state ? _gdBilling.state : '').trim().toLowerCase();
    var _supState = (sup && sup.state ? sup.state : '').trim().toLowerCase();
    var _interState = !!(_coState && _supState && _coState !== _supState);

    // Order-level discount (₹ off whole order) from the form
    var _odEl = document.getElementById('poOrderDiscount');
    var orderDisc = (_odEl && _odEl.value) ? (parseFloat(_odEl.value)||0) : 0;
    if (orderDisc < 0) orderDisc = 0;
    // Freight / packing
    var freightEl2 = document.getElementById('poFreightAmt');
    var packingEl2 = document.getElementById('poPackingAmt');
    var freightVal = (freightEl2 && !freightEl2.disabled && freightEl2.value) ? (parseFloat(freightEl2.value)||0) : 0;
    var packingVal = (packingEl2 && !packingEl2.disabled && packingEl2.value) ? (parseFloat(packingEl2.value)||0) : 0;
    // Items subtotal (sum of per-line discounted amounts)
    var itemsSubtotal = 0;
    validLines.forEach(function(l){
        var d=parseFloat(l.discount)||0; if(d<0)d=0; if(d>100)d=100;
        itemsSubtotal += (parseFloat(l.qty)||0)*(parseFloat(l.rate)||0)*(1-d/100);
    });
    if (orderDisc > itemsSubtotal + freightVal + packingVal) orderDisc = itemsSubtotal + freightVal + packingVal;
    // GST base = items + freight + packing - discount, spread across lines by share
    var addBase = freightVal + packingVal - orderDisc;
    var lineData = validLines.map(function(l){
        var qty=parseFloat(l.qty)||0, rt=parseFloat(l.rate)||0;
        var disc=parseFloat(l.discount)||0; if(disc<0)disc=0; if(disc>100)disc=100;
        var amt=qty*rt*(1-disc/100);
        total += amt;
        var taxBase = amt + (itemsSubtotal>0 ? addBase*(amt/itemsSubtotal) : 0);
        if (taxBase < 0) taxBase = 0;
        var mat = (_allRows||[]).find(function(r){ return (r.material_name||'').toLowerCase()===(l.material||'').trim().toLowerCase(); });
        var gstPct  = mat&&mat.gst_rate!=null ? parseFloat(mat.gst_rate) : (l.gst_rate ? parseFloat(l.gst_rate) : 0);
        if (gstPct > 0 && gstPct < 1) gstPct = gstPct * 100;
        var hsnCode = mat&&mat.hsn_code       ? mat.hsn_code              : (l.hsn_code||'');
        var cgst = 0, sgst = 0, igst = 0;
        if (gstPct > 0 && taxBase > 0) {
            if (_interState) {
                igst = Math.round(taxBase * gstPct / 100 * 100) / 100;
            } else {
                cgst = Math.round(taxBase * (gstPct/2) / 100 * 100) / 100;
                sgst = cgst;
            }
        }
        return {material:l.material, qty:qty, rt:rt, disc:disc, amt:amt, gstPct:gstPct, cgst:cgst, sgst:sgst, igst:igst, hsnCode:hsnCode};
    });
    var totalCGST = lineData.reduce(function(s,r){return s+r.cgst;},0);
    var totalSGST = lineData.reduce(function(s,r){return s+r.sgst;},0);
    var totalIGST = lineData.reduce(function(s,r){return s+r.igst;},0);
    var taxableNet = itemsSubtotal + freightVal + packingVal - orderDisc;
    if (taxableNet < 0) taxableNet = 0;
    var grandTotal = taxableNet + totalCGST + totalSGST + totalIGST;
    var missingGST = lineData.filter(function(r){ return r.gstPct===0&&r.amt>0; }).map(function(r){ return r.material; });
    var fi = function(n){ return '\u20b9'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); };

    /* Row HTML — match Tally column structure */
    var itemRows = '';
    lineData.forEach(function(r,i){
        var fQty = r.qty>0?r.qty.toLocaleString('en-IN',{minimumFractionDigits:3,maximumFractionDigits:3})+' Kgs':'\u2014';
        var fRt  = r.rt>0 ?'\u20b9'+r.rt.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}):'\u2014';
        var fAmt = r.amt>0?fi(r.amt):'\u2014';
        var fGst = r.gstPct>0 ? r.gstPct+'%' : '\u2014';
        var fDisc = r.disc>0 ? r.disc+'%' : '\u2014';
        itemRows += '<tr class="item-row">'
            +'<td class="ctr">'+(i+1)+'</td>'
            +'<td class="tl"><strong>'+escHtml(r.material)+'</strong>'+(r.hsnCode?'<br><span style="font-size:10px;color:#000;font-weight:700">HSN: '+escHtml(r.hsnCode)+'</span>':'')+'</td>'
            +'<td class="rr">'+fQty+'</td>'
            +'<td class="rr">'+fRt+'</td>'
            +'<td style="text-align:center;font-family:monospace;font-size:11px">'+fDisc+'</td>'
            +'<td style="text-align:center;font-family:monospace;font-size:11px">'+fGst+'</td>'
            +'<td class="rr">'+fAmt+'</td>'
            +'</tr>';
    });
    // (Freight & packing are shown in the totals section, not as item rows)

        +(missingGST.length>0?'<div style="background:#fffbeb;border:1px solid #fde68a;border-top:none;padding:6px 11px;font-size:10px;color:#92400e;border-radius:0 0 4px 4px">&#9888;&nbsp; GST rate not configured for: <strong>'+missingGST.map(function(m){return escHtml(m);}).join(', ')+'</strong> &mdash; set in Material Master → Edit → GST Details</div>':'')
    /* ── Amount in words ── */
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

    var declId   = gv('poModalDeclaration');
    var declData = declId ? (_declLists||[]).find(function(d){return String(d.id)===String(declId);}) : null;
    var declText = declData ? (declData.text||'') : '';

    /* ── T&C Page 2 ── */
    var tcData = tcId ? (_tcLists||[]).find(function(t){return String(t.id)===String(tcId);}) : null;

    /* Read payment: T&C list first, then supplier ledger, then PO form DOM fields */
    var supPayType    = (tcData && _ok(tcData.payment_type))   ? tcData.payment_type
                      : (_ok(sup.payment_type)                 ? sup.payment_type
                      : gv('poSupPayTerms'));
    var supCreditDays = (tcData && _ok(String(tcData.credit_days||''))) ? String(tcData.credit_days)
                      : (_ok(String(sup.credit_days||''))               ? String(sup.credit_days)
                      : gv('poSupCreditDays'));
    var supPayNotes   = (tcData && _ok(tcData.payment_notes))  ? tcData.payment_notes
                      : (_ok(sup.payment_terms)                ? sup.payment_terms : '');

    /* Read delivery: T&C list first, then PO form delivery days field */
    var tcDelivDays  = (tcData && _ok(String(tcData.delivery_days||''))) ? String(tcData.delivery_days) : '';
    var tcDelivMode  = (tcData && _ok(tcData.delivery_mode))  ? tcData.delivery_mode  : '';
    var tcDelivNotes = (tcData && _ok(tcData.delivery_notes)) ? tcData.delivery_notes : '';
    var effectiveDelivDays = _ok(delivDays) ? delivDays : tcDelivDays;

    var p2rows = '';

    /* 1. Delivery Terms */
    var hasDelivery = _ok(effectiveDelivDays) || _ok(tcDelivMode) || _ok(tcDelivNotes);
    if (hasDelivery) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#fff;color:#000">DELIVERY TERMS</div>';
        if (_ok(effectiveDelivDays)) p2rows += '<div class="p2row"><b>Delivery Period:</b> Within <strong>'+escHtml(effectiveDelivDays)+' working days</strong> from PO date</div>';
        if (_ok(tcDelivMode))        p2rows += '<div class="p2row"><b>Mode:</b> '+escHtml(tcDelivMode)+'</div>';
        if (_ok(tcDelivNotes))       p2rows += '<div class="p2row"><b>Notes:</b> '+escHtml(tcDelivNotes)+'</div>';
        p2rows += '</div>';
    }

    /* 2. Payment Terms */
    var hasPayment = _ok(supPayType)||_ok(supCreditDays)||_ok(supPayNotes)||(payLine&&payLine!=='\u2014');
    if (hasPayment) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#f0fdf4;color:#166534">PAYMENT TERMS</div>';
        if (_ok(supPayType))    p2rows += '<div class="p2row"><b>Mode:</b> <strong>'+escHtml(supPayType)+'</strong></div>';
        if (_ok(supCreditDays)) p2rows += '<div class="p2row"><b>Credit Period:</b> '+escHtml(supCreditDays)+' days from material receipt</div>';
        if (_ok(supPayNotes))   p2rows += '<div class="p2row"><b>Notes:</b> '+escHtml(supPayNotes)+'</div>';
        p2rows += '</div>';
    }

    /* 3. General T&C from T&C Manager */
    if (tcData && tcData.other_terms && tcData.other_terms.length) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#faf5ff;color:#6d28d9">GENERAL TERMS &amp; CONDITIONS</div>';
        tcData.other_terms.forEach(function(term,i){
            p2rows += '<div class="p2row p2term"><span class="p2num">'+(i+1)+'.</span><span>'+escHtml(term)+'</span></div>';
        });
        p2rows += '<div class="p2row" style="font-size:10px;color:#000;font-style:italic">List: '+escHtml(tcData.name||'')+'</div>';
        p2rows += '</div>';
    } else if (tcId && !tcData) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#faf5ff;color:#6d28d9">GENERAL TERMS &amp; CONDITIONS</div>'
            +'<div class="p2row" style="color:#000;font-style:italic">T&amp;C list could not be loaded — please re-select from PO form.</div>'
            +'</div>';
    }

    /* 4. Remarks */
    if (_ok(remarks)) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#fffbeb;color:#92400e">REMARKS / SPECIAL INSTRUCTIONS</div>'
            +'<div class="p2row">'+escHtml(remarks)+'</div></div>';
    }

    /* 5. Supplier Ledger-specific T&C (from Supplier Master) */
    var supTcId = (document.getElementById('poModalSupplier') || {}).dataset && document.getElementById('poModalSupplier').dataset.supTcId;
    var supTcData = supTcId ? (_tcLists||[]).find(function(t){ return String(t.id)===String(supTcId); }) : null;
    // Only show if different from the already-selected PO T&C
    if (supTcData && String(supTcId) !== String(tcId)) {
        p2rows += '<div class="p2sec"><div class="p2head" style="background:#fff1f2;color:#be123c">SUPPLIER LEDGER — SPECIFIC TERMS (<span style="font-weight:400">'+escHtml(supTcData.name||'')+'</span>)</div>';
        if (_ok(String(supTcData.delivery_days||''))) p2rows += '<div class="p2row"><b>Delivery Period:</b> Within <strong>'+escHtml(String(supTcData.delivery_days))+' working days</strong></div>';
        if (_ok(supTcData.delivery_mode))  p2rows += '<div class="p2row"><b>Delivery Mode:</b> '+escHtml(supTcData.delivery_mode)+'</div>';
        if (_ok(supTcData.payment_type))   p2rows += '<div class="p2row"><b>Payment Mode:</b> '+escHtml(supTcData.payment_type)+'</div>';
        if (_ok(String(supTcData.credit_days||''))) p2rows += '<div class="p2row"><b>Credit Period:</b> '+escHtml(String(supTcData.credit_days))+' days</div>';
        if (_ok(supTcData.payment_notes))  p2rows += '<div class="p2row"><b>Payment Notes:</b> '+escHtml(supTcData.payment_notes)+'</div>';
        if (supTcData.other_terms && supTcData.other_terms.length) {
            supTcData.other_terms.forEach(function(term, i){
                p2rows += '<div class="p2row p2term"><span class="p2num">'+(i+1)+'.</span><span>'+escHtml(term)+'</span></div>';
            });
        }
        p2rows += '</div>';
    }

    /* Always show page 2 if T&C selected, delivery/payment data, or any content */
    var tcPage2 = '';
    if (!window._poPrintNoTC && (p2rows || tcId || hasDelivery || hasPayment)) {
        if (!p2rows) p2rows = '<div class="p2row" style="color:#000;font-style:italic">No additional terms configured.</div>';
        tcPage2 = '<div style="page-break-before:always;padding:24px 32px">'
            +'<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:16px">'
            +'<div><div style="font-size:21px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:.5px">Purchase Order</div>'
            +'<div style="font-size:9px;color:#000;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Terms &amp; Conditions</div>'
            +'<div class="iso-code">QR-843-01</div></div>'
            +'<div style="text-align:right">'
            +'<div style="font-size:13px;font-weight:900;font-family:monospace;color:#000">'+escHtml(poNum)+'</div>'
            +'<div style="font-size:9px;color:#000;margin-top:1px">Page 2 of 2</div></div></div>'
            +p2rows
            +'<div style="text-align:right;margin-top:40px;padding-top:12px;border-top:1px solid #e2e8f0">'
            +'<div style="font-size:9px;color:#888;margin-bottom:28px">for HCP Wellness Pvt Ltd</div>'
            +'<div style="font-size:10px;color:#475569;border-top:1px solid #cbd5e1;padding-top:6px;display:inline-block;min-width:200px;text-align:center">Authorised Signatory</div>'
            +'</div>'
            +'<div style="text-align:center;margin-top:16px;font-size:9px;font-weight:700;color:#000;border-top:1px solid #000;padding-top:6px">SUBJECT TO AHMEDABAD JURISDICTION &nbsp;|&nbsp; This is a Computer Generated Document</div>'
            +'</div>';
    }

        /* ── CSS ── */
    var CSS = '*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
        +'body{font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#000;background:#fff;padding:20px 28px}'
        /* Header */
        +'.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:9px;margin-bottom:0}'
        +'.co{font-size:21px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:.5px}'
        +'.cosub{font-size:12px;color:#000;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-top:3px}'
        +'.pstat{font-size:12px;font-weight:900;color:#000;text-align:right;letter-spacing:.8px;text-transform:uppercase;padding:3px 10px;border:2px solid #000;border-radius:4px}'
        +'.vno-top{font-size:17px;font-weight:900;color:#000;letter-spacing:.5px;font-family:monospace;white-space:nowrap}'
        +'.iso-code{font-size:11px;font-weight:700;color:#000;font-family:monospace;letter-spacing:1px;margin-top:3px}'
        /* Info bars */
        +'.bar{display:grid;border:1px solid #000;border-top:none}'
        +'.bar4{grid-template-columns:1fr 1fr 1fr 1fr}'
        +'.bar3{grid-template-columns:1fr 1fr 1fr}'
        +'.bar2{grid-template-columns:1fr 1fr}'
        +'.bc{padding:3px 9px;border-right:1px solid #000}.bc:last-child{border-right:none}'
        +'.bl{font-size:8px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:.6px;margin-bottom:1px}'
        +'.bv{font-size:10.5px;font-weight:700;color:#000}'
        /* Address grid */
        +'.adg{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #000;border-top:none}'
        +'.ab{padding:6px 9px;border-right:1px solid #000;font-size:10.5px;line-height:1.5;color:#000;vertical-align:top}'
        +'.ab:last-child{border-right:none}'
        +'.al{font-size:8.5px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #000}'
        /* Table */
        +'table{width:100%;border-collapse:collapse}'
        +'thead tr{background:#fff}'
        +'th{color:#000;padding:5px 8px;font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;border:1px solid #000;border-top:2px solid #000;border-bottom:2px solid #000;text-align:right}'
        +'th:first-child{text-align:center}th:nth-child(2){text-align:left}'
        +'tbody tr.item-row{border-bottom:1px solid #000}'
        +'tbody tr.item-row:nth-child(odd){background:#fff}'
        +'tbody td{border-left:1px solid #000}'
        +'td{padding:4px 8px;font-size:10.5px;font-weight:600;color:#000;vertical-align:middle;border-right:1px solid #000}'
        +'td:last-child{border-right:none}'
        +'.ctr{text-align:center;color:#000;font-weight:700;width:24px}'
        +'.tl{text-align:left}'
        +'.rr{text-align:right;font-family:monospace}'
        /* Footer table rows */
        +'.ftrow td{padding:3px 9px;border-right:1px solid #000;font-size:10.5px;font-weight:700;color:#000}'
        +'.ftrow td:last-child{border-right:none}'
        +'.ftrow-total td{font-weight:900;font-size:15px;background:#fff;border-top:3px solid #000;border-bottom:3px solid #000;color:#000}'
        /* Amt words, decl, sig */
        +'.amt-words{border:1px solid #000;border-top:none;padding:7px 10px;font-size:11.5px;font-weight:700;color:#000}'
        +'.decl{border:1px solid #000;border-top:none;padding:7px 10px;font-size:10.5px;color:#000;line-height:1.7}'
        +'.sig{display:grid;grid-template-columns:1fr 1fr;border:1px solid #000;border-top:none}'
        +'.sb{padding:9px 10px;border-right:1px solid #000;min-height:48px}.sb:last-child{border-right:none;text-align:right}'
        +'.sl{font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}'
        +'.footer{text-align:center;font-size:9px;font-weight:700;color:#000;margin-top:6px;border-top:1px solid #000;padding-top:5px}'
        /* Page 2 */
        +'.p2sec{margin-bottom:12px;border:1px solid #000;overflow:hidden}'
        +'.p2head{padding:7px 10px;font-size:9px;font-weight:900;letter-spacing:.8px;background:#fff;color:#000;border-bottom:1px solid #000;text-transform:uppercase}'
        +'.p2row{padding:7px 10px;font-size:11.5px;color:#000;border-top:1px solid #000;line-height:1.6}'
        +'@media print{body{padding:8px 14px}button{display:none!important}}';

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+escHtml(poNum)+'</title>'
        +'<style>'+CSS+'</style></head><body>'

        /* ── Header ── */
        +'<div class="hdr">'
        +'<div><div class="co">Purchase Order</div>'
        +'<div class="iso-code">QR-843-01</div></div>'
        +'<div style="text-align:right;padding-top:2px">'
        +'<div class="vno-top">'+escHtml(poNum)+'&nbsp;&nbsp;|&nbsp;&nbsp;'+(poDate?fmtDate(poDate):'\u2014')+'</div>'
        +'</div>'
        +'</div>'

        /* ── Voucher bar (2 cols) — Voucher No. + Dated moved to header ── */
        +'<div class="bar bar2">'
        +'<div class="bc"><div class="bl">Reference No. &amp; Date</div><div class="bv">'+escHtml(poNum)+'</div></div>'
        +'<div class="bc"><div class="bl">Mode / Terms of Payment</div><div class="bv">'+payLine+'</div></div>'
        +'</div>'

        /* ── Address grid (3 cols) ── */
        +'<div class="adg">'
        +'<div class="ab"><div class="al">Invoice To</div>'+billLines.join('<br>')+'</div>'
        +'<div class="ab"><div class="al">Consignee (Ship To)</div>'+shipLines.join('<br>')+'</div>'
        +'<div class="ab"><div class="al">Supplier (Bill From)</div>'+supLines.join('<br>')+'</div>'
        +'</div>'

        /* ── Items table ── */
        +'<table><thead><tr>'
        +'<th style="width:26px;text-align:center">Sl<br>No.</th>'
        +'<th style="text-align:left">Description of Goods</th>'
        +'<th style="width:95px">Quantity</th>'
        +'<th style="width:90px">Rate (&#x20b9;)</th>'
        +'<th style="width:50px;text-align:center">Disc %</th>'
        +'<th style="width:50px;text-align:center">GST %</th>'
        +'<th style="width:110px">Amount (\u20b9)</th>'
        +'</tr></thead>'
        +'<tbody>'+itemRows+'</tbody>'
        +'<tfoot>'
        +'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">Items Subtotal</td><td class="rr">'+fi(itemsSubtotal)+'</td></tr>'
        +(freightVal>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">Freight Charges</td><td class="rr">'+fi(freightVal)+'</td></tr>':'')
        +(packingVal>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">Packing Charges</td><td class="rr">'+fi(packingVal)+'</td></tr>':'')
        +(orderDisc>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">Discount</td><td class="rr">- '+fi(orderDisc)+'</td></tr>':'')
        +'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">Taxable Amount</td><td class="rr">'+fi(taxableNet)+'</td></tr>'
        +(totalCGST>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">CGST</td><td class="rr">'+fi(totalCGST)+'</td></tr>':'')
        +(totalSGST>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">SGST</td><td class="rr">'+fi(totalSGST)+'</td></tr>':'')
        +(totalIGST>0?'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#000;font-weight:700">IGST</td><td class="rr">'+fi(totalIGST)+'</td></tr>':'')
        +'<tr class="ftrow-total"><td colspan="6" style="text-align:right">Total</td>'
        +'<td class="rr" style="color:#000;font-size:15px;font-weight:900">'+fi(grandTotal)+'</td></tr>'
        +'</tfoot></table>'

        /* ── Amount in words ── */
        +'<div class="amt-words"><strong>Amount Chargeable (in words):</strong>&nbsp; '+grandWords+'</div>'

        /* ── Declaration ── */
        +(declText
            ? '<div class="decl"><strong>Declaration:</strong><br>'
              +declText.split(/\r?\n/).filter(function(l){return l.trim();}).map(function(l,i){return (i+1)+'. '+escHtml(l.trim());}).join('<br>')
              +'<br>E. &amp; O.E</div>'
            : '<div class="decl">E. &amp; O.E</div>'
        )

        /* ── Signature ── */
        +'<div class="sig">'
        +'<div class="sb"></div>'
        +'<div class="sb"><div class="sl">for HCP Wellness Pvt Ltd</div><br><div style="font-size:10px;color:#666;margin-top:16px">Authorised Signatory</div></div>'
        +'</div>'

        +'<div class="footer">SUBJECT TO AHMEDABAD JURISDICTION &nbsp;|&nbsp; This is a Computer Generated Document</div>'

        /* ── T&C Page 2 ── */
        +tcPage2
        +'</body></html>';
}
function poPrintBack() {
    document.getElementById('po-print-pane').style.display = 'none';
    document.getElementById('po-form-pane').style.display  = 'block';
}

/* Override openPoModal → openPoFormPane */
async function openPoModal(row, prefillSupplier, prefillLines) {
    await openPoFormPane(row, prefillSupplier, prefillLines);
}
function closePoModal() {
    poCloseFormPane();
}

/* Override openPoModalByIdx */
async function openPoModalByIdx(idx) {
    var row = _poFiltered[parseInt(idx)];
    if (!row) return;

    if (row.status === 'closed') {
        // Open for view / print only
        await openPoFormPane(row);
        // Disable all editing after form is populated
        var saveBtn   = document.getElementById('poFormSaveBtn');
        var delBtn    = document.getElementById('poFormDeleteBtn');
        var cancelBtn = document.getElementById('poFormCancelBtn');
        if (saveBtn)   { saveBtn.disabled = true; saveBtn.style.opacity = '.4'; saveBtn.title = 'Closed PO — view & print only'; }
        if (delBtn)    delBtn.style.display   = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
        var formPane = document.getElementById('po-form-pane');
        if (formPane) {
            formPane.querySelectorAll('input:not([type=checkbox]), select, textarea').forEach(function(el){
                el.setAttribute('readonly', true);
                el.style.pointerEvents = 'none';
                el.style.opacity = '.8';
            });
            formPane.querySelectorAll('input[type=checkbox]').forEach(function(el){ el.disabled = true; });
            // Disable action buttons inside form body (not the topbar print/back)
            var formBody = document.getElementById('po-form-body');
            if (formBody) {
                formBody.querySelectorAll('button').forEach(function(btn){
                    btn.disabled = true; btn.style.opacity = '.4'; btn.style.pointerEvents = 'none';
                });
            }
        }
        toast('Closed PO — view and print only', 'info', 2500);
        return;
    }

    openPoFormPane(row);
}

/* Extract printPO into _poBuildPrintHTML (returns HTML string) */


document.addEventListener('DOMContentLoaded', function(){
    loadData();
    _poUpdateShareButtons();
});

/* ═══════════════════════════════════════════════════════════════
   VOUCHER TYPE — Load from General OP, update numbering preview
═══════════════════════════════════════════════════════════════ */
var _poVoucherTypes = [];

async function poLoadVoucherTypes(currentTypeName) {
    var sel = document.getElementById('poVoucherType');
    if (!sel) return;
    try {
        var res  = await fetch('/api/gop/voucher_types?parent_type=po');
        var data = await res.json();
        _poVoucherTypes = (data.types || []).filter(function(t) { return t.is_active; });
    } catch(e) {
        _poVoucherTypes = [];
    }

    if (!_poVoucherTypes.length) {
        // No custom types defined — show a "Purchase Order (default)" option
        sel.innerHTML = '<option value="">Purchase Order (default)</option>';
        if (typeof comboboxRefresh === 'function') comboboxRefresh(sel);
        return;
    }

    sel.innerHTML = '<option value="">\u2014 Select Type \u2014</option>'
        + _poVoucherTypes.map(function(t) {
            var label = t.name + (t.abbreviation ? ' (' + t.abbreviation + ')' : '');
            var sel_attr = t.name === currentTypeName ? ' selected' : '';
            return '<option value="' + escHtml(t.name) + '"' + sel_attr + '>' + escHtml(label) + '</option>';
        }).join('');

    // Default for a NEW PO: Raw Material Purchase Order (RM PO).
    // For existing POs (currentTypeName already set), preserve whatever was saved.
    // Dropdown stays fully enabled so the user can switch types if needed.
    if (!currentTypeName && _poVoucherTypes.length) {
        var rmType = _poVoucherTypes.find(function(t){
            var a = (t.abbreviation || '').toUpperCase();
            return a === 'RM PO' || a.startsWith('RM');
        });
        sel.value = rmType ? rmType.name : _poVoucherTypes[0].name;
    }
    if (typeof comboboxRefresh === 'function') comboboxRefresh(sel);

    // Update numbering preview after loading
    poVoucherTypeChange();
}

/* Shared group-match helper — used by PO, GRN, MTV */
function _voucherMatGroupFilter(abbr) {
    var a = (abbr || '').toUpperCase();
    if (a.startsWith('RM'))      return 'rm';
    if (a.startsWith('PM'))      return 'pm';
    if (a.startsWith('FG') || a.startsWith('FG-')) return 'fg';
    return null; // show all
}
function _voucherMatMatchesGroup(mat, grpFilter) {
    if (!grpFilter) return true;
    // Primary: use mat_type_abbr (from material_types table JOIN)
    var abbr = (mat.mat_type_abbr || '').toUpperCase();
    if (abbr) {
        if (grpFilter === 'rm') return abbr === 'RM';
        if (grpFilter === 'pm') return abbr === 'PM';
        if (grpFilter === 'fg') return abbr === 'FG';
        return true; // other types shown for unrecognised filter
    }
    // Fallback: guess from group_name for materials without type set
    var grp = (mat.group_name || '').toLowerCase();
    if (grpFilter === 'rm') return grp.includes('raw');
    if (grpFilter === 'pm') return grp.includes('pack');
    if (grpFilter === 'fg') return grp.includes('finish') || grp.includes('fg');
    return true;
}

var _poMatGroupFilter = null;

var _poPrevVoucherType = '';

function poVoucherTypeChange() {
    var sel      = document.getElementById('poVoucherType');
    var typeName = sel ? sel.value : '';
    var numEl    = document.getElementById('poModalNum');

    // ── Confirm reset if lines already entered ──
    var hasData = (_poLines||[]).some(function(l){ return (l.material||'').trim(); });
    if (_poPrevVoucherType && typeName !== _poPrevVoucherType && hasData) {
        if (!confirm('Changing the PO type will clear all current line items. Continue?')) {
            sel.value = _poPrevVoucherType;
            return;
        }
        _poLines = [{material:'',qty:'',qty_per_pkg:'',packages:'',total_qty:0,rate:'',uom:'KG'}];
        poRenderLines();
        // Clear supplier too
        var supEl = document.getElementById('poModalSupplier');
        if (supEl) supEl.value = '';
    }
    _poPrevVoucherType = typeName;

    // ── Feature 1: Update numbering preview ──
    if (numEl && !numEl.value) {
        var vtKey = typeName || 'po';
        fetch('/api/gop/voucher_numbering/next?voucher_type=' + encodeURIComponent(vtKey))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d.status === 'ok') {
                    var parts = [];
                    if (d.prefix) parts.push(d.prefix);
                    parts.push(String(d.next).padStart(d.digits || 4, '0'));
                    if (d.suffix) parts.push(d.suffix);
                    numEl.placeholder = 'Next: ' + parts.join('/');
                }
            })
            .catch(function() {});
    }

    // ── Feature 2: Filter material datalist by material type association ──
    var typeInfo = (_poVoucherTypes || []).find(function(t){ return t.name === typeName; });
    var matAbbr  = typeInfo ? ((typeInfo.mat_type_abbr || '')).toUpperCase() : '';
    // Fall back to voucher abbreviation prefix if no explicit association
    if (!matAbbr && typeInfo && typeInfo.abbreviation) {
        var va = typeInfo.abbreviation.toUpperCase();
        if (va.startsWith('RM')) matAbbr = 'RM';
        else if (va.startsWith('PM')) matAbbr = 'PM';
        else if (va.startsWith('FG')) matAbbr = 'FG';
    }
    _poMatGroupFilter = matAbbr ? _voucherMatGroupFilter(matAbbr) : null;
    _poRefreshMatDatalist(); // also updates badge
}

function _poRefreshMatDatalist() {
    var matListEl = document.getElementById('poMaterialList');
    if (!matListEl || !_allRows) return;

    var allMatch = _allRows.filter(function(r){ return _voucherMatMatchesGroup(r, _poMatGroupFilter); });

    // Graceful fallback: if filter active but nothing matches (types not assigned yet), show all
    var showWarning = false;
    if (_poMatGroupFilter && allMatch.length === 0) {
        allMatch = _allRows.slice();
        showWarning = true;
    }

    matListEl.innerHTML = allMatch.map(function(r){
        return '<option value="' + escHtml(r.material_name) + '">';
    }).join('');

    // Update filter indicator badge next to LINE ITEMS header
    _poUpdateMatFilterIndicator(showWarning);
}

function _poUpdateMatFilterIndicator(warn) {
    // Dynamically inject badge next to poLineCount if not already there
    var lc = document.getElementById('poLineCount');
    if (lc && !document.getElementById('poMatFilterBadge')) {
        var badge = document.createElement('span');
        badge.id = 'poMatFilterBadge';
        badge.style.cssText = 'display:none;font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px';
        lc.parentNode.insertBefore(badge, lc.nextSibling);
    }
    var ind = document.getElementById('poMatFilterBadge');
    if (!ind) return;
    var filterLabel = { rm: 'RM only', pm: 'PM only', fg: 'FG only' };
    if (!_poMatGroupFilter) {
        ind.textContent = '';
        ind.style.display = 'none';
        return;
    }
    ind.style.display = 'inline-flex';
    if (warn) {
        ind.textContent = '⚠ No types assigned — showing all';
        ind.style.background = 'rgba(251,191,36,.2)';
        ind.style.color = '#b45309';
    } else {
        ind.textContent = '🔵 ' + (filterLabel[_poMatGroupFilter] || _poMatGroupFilter.toUpperCase());
        ind.style.background = 'rgba(255,255,255,.2)';
        ind.style.color = '#fff';
    }
}
