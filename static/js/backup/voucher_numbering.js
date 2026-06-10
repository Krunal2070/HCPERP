/* voucher_numbering.js — Unified Voucher Numbering Settings
   Manages numbering styles (prefix/suffix/digits/date-range) for PO, GRN, etc.
   Persisted in DB via /api/procurement/voucher_numbering/* endpoints.
   Exposes _vNumGetActive(type) used by po.js on save.
   Depends on: utils.js (toast, escHtml, fmtDate)                           */

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
var _vnStyles   = [];           // all styles from server
var _vnActiveTab = 'po';        // current tab in modal
var _vnEditIdx   = -1;          // -1 = new, ≥0 = editing index
var _vnTypes     = ['po','grn','mtv']; // extensible — add via _vnRegisterType()

/* Register a new voucher type so it appears in Voucher Numbering settings.
   Called by any module that creates a new voucher type (e.g. mtv.js).
   Safe to call multiple times — deduplicates automatically.            */
function _vnRegisterType(type) {
    if (type && _vnTypes.indexOf(type) === -1) {
        _vnTypes.push(type);
    }
}

/* ═══════════════════════════════════════════════════════
   LOAD / SAVE — DB-backed
═══════════════════════════════════════════════════════ */
function _vnLoad(cb) {
    fetch('/api/procurement/voucher_numbering/list')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status === 'ok') _vnStyles = d.styles || [];
            if (typeof cb === 'function') cb();
        })
        .catch(function(e){ console.warn('vnLoad fail', e); if (typeof cb === 'function') cb(); });
}

function _vnSaveStyle(style, cb) {
    fetch('/api/procurement/voucher_numbering/save', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(style)
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
        if (d.status !== 'ok') { toast(d.message || 'Save failed', 'error'); return; }
        toast('Numbering style saved', 'success');
        _vnLoad(function(){ _vnRender(); });
        if (typeof cb === 'function') cb(d);
    })
    .catch(function(e){ toast('Save failed: ' + e.message, 'error'); });
}

function _vnDeleteStyle(id) {
    if (!confirm('Delete this numbering style?')) return;
    fetch('/api/procurement/voucher_numbering/delete', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({id: id})
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
        if (d.status !== 'ok') { toast(d.message || 'Delete failed', 'error'); return; }
        toast('Style deleted', 'success');
        _vnLoad(function(){ _vnRender(); });
    })
    .catch(function(e){ toast('Delete failed: ' + e.message, 'error'); });
}

/* ═══════════════════════════════════════════════════════
   _vNumGetActive(type)  — returns {prefix, suffix, digits}
   Called by po.js / grn.js when saving a new voucher.
   Finds the style whose valid_from ≤ today ≤ valid_to.
═══════════════════════════════════════════════════════ */
function _vNumGetActive(type) {
    var now = new Date();
    var today = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
    var matches = _vnStyles.filter(function(s){
        return s.voucher_type === type && s.valid_from <= today && s.valid_to >= today;
    });
    // If multiple match, pick the one most recently created (highest id)
    if (matches.length > 1) matches.sort(function(a,b){ return b.id - a.id; });
    if (matches.length) {
        var m = matches[0];
        return { prefix: m.prefix || '', suffix: m.suffix || '', digits: m.digits || 4, start: m.start_num || 1 };
    }
    return {};  // no active style → server assigns plain number
}

/* ═══════════════════════════════════════════════════════
   _vNumPreviewStr(prefix, suffix, digits, seq)
   Build a preview string like "HCP/RM/PO/0001/25-26"
═══════════════════════════════════════════════════════ */
function _vNumPreviewStr(prefix, suffix, digits, seq) {
    var num = String(seq || 1).padStart(digits || 4, '0');
    var parts = [];
    if (prefix) parts.push(prefix);
    parts.push(num);
    if (suffix) parts.push(suffix);
    return parts.join('/');
}

/* ═══════════════════════════════════════════════════════
   MODAL — OPEN / CLOSE
═══════════════════════════════════════════════════════ */
function openVoucherNumSettings() {
    _vnLoad(function(){
        _vnActiveTab = 'po';
        _vnRenderTabs();
        _vnRender();
        vNumCancelEdit();
        document.getElementById('voucherNumSettingsModal').classList.add('open');
    });
}

function closeVoucherNumSettings() {
    document.getElementById('voucherNumSettingsModal').classList.remove('open');
    vNumCancelEdit();
}

/* ═══════════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════════ */
function _vnRenderTabs() {
    var bar = document.getElementById('vNumTabBar');
    if (!bar) return;
    var labels = { po: 'Purchase Order', grn: 'GRN', mtv: 'Material Transfer' };
    bar.innerHTML = _vnTypes.map(function(t){
        var active = t === _vnActiveTab;
        return '<button onclick="_vnSwitchTab(\'' + t + '\')" style="'
            + 'height:30px;padding:0 16px;border-radius:7px;border:1px solid '
            + (active ? '#2563eb' : 'var(--border2)') + ';'
            + 'background:' + (active ? 'rgba(37,99,235,.1)' : 'transparent') + ';'
            + 'color:' + (active ? '#2563eb' : 'var(--muted)') + ';'
            + 'font-size:11.5px;font-weight:700;cursor:pointer;font-family:var(--font-body);'
            + 'text-transform:uppercase;letter-spacing:.5px">'
            + (labels[t] || t.toUpperCase()) + '</button>';
    }).join('');
}

function _vnSwitchTab(type) {
    _vnActiveTab = type;
    _vnRenderTabs();
    _vnRender();
    vNumCancelEdit();
}

/* ═══════════════════════════════════════════════════════
   RENDER STYLES LIST
═══════════════════════════════════════════════════════ */
function _vnRender() {
    var list = document.getElementById('vNumStylesList');
    if (!list) return;
    var filtered = _vnStyles.filter(function(s){ return s.voucher_type === _vnActiveTab; });
    if (!filtered.length) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">'
            + 'No numbering styles configured for <strong>' + _vnActiveTab.toUpperCase() + '</strong>.<br>'
            + 'Click "Add Numbering Style" below to create one.</div>';
        return;
    }
    var now = new Date();
    var today = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
    list.innerHTML = filtered.map(function(s){
        var preview = _vNumPreviewStr(s.prefix, s.suffix, s.digits, s.start_num || 1);
        var isActive = s.valid_from <= today && s.valid_to >= today;
        var fromFmt = typeof fmtDate === 'function' ? fmtDate(s.valid_from) : s.valid_from;
        var toFmt   = typeof fmtDate === 'function' ? fmtDate(s.valid_to) : s.valid_to;
        return '<div style="padding:12px 14px;border:1px solid ' + (isActive ? 'rgba(37,99,235,.4)' : 'var(--border2)') + ';'
            + 'border-radius:9px;background:' + (isActive ? 'rgba(37,99,235,.04)' : 'var(--surface)') + ';'
            + 'display:flex;align-items:center;gap:12px">'
            + '<div style="flex:1;min-width:0">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">'
            + '<span style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:'
            + (isActive ? '#2563eb' : 'var(--text)') + '">' + escHtml(preview) + '</span>'
            + (isActive ? '<span style="font-size:9px;font-weight:800;padding:2px 8px;border-radius:10px;background:#2563eb;color:#fff;text-transform:uppercase;letter-spacing:.5px">Active</span>' : '')
            + '</div>'
            + '<div style="font-size:10.5px;color:var(--muted)">'
            + 'Prefix: <strong>' + escHtml(s.prefix || '—') + '</strong> · '
            + 'Suffix: <strong>' + escHtml(s.suffix || '—') + '</strong> · '
            + escHtml(s.digits) + ' digits · '
            + fromFmt + ' → ' + toFmt
            + '</div></div>'
            + '<button onclick="_vnEditStyle(' + s.id + ')" title="Edit" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center" '
            + 'onmouseover="this.style.color=\'#2563eb\';this.style.borderColor=\'#2563eb\'" '
            + 'onmouseout="this.style.color=\'var(--muted)\';this.style.borderColor=\'var(--border2)\'">'
            + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
            + '<button onclick="_vnDeleteStyle(' + s.id + ')" title="Delete" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center" '
            + 'onmouseover="this.style.color=\'var(--red-text)\';this.style.borderColor=\'var(--red-text)\'" '
            + 'onmouseout="this.style.color=\'var(--muted)\';this.style.borderColor=\'var(--border2)\'">'
            + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
            + '</div>';
    }).join('');
}

/* ═══════════════════════════════════════════════════════
   ADD / EDIT / CANCEL / SAVE
═══════════════════════════════════════════════════════ */
function vNumAddNew() {
    _vnEditIdx = -1;
    document.getElementById('vNumFormTitle').textContent = 'New Style — ' + _vnActiveTab.toUpperCase();
    document.getElementById('vNumPrefix').value = '';
    document.getElementById('vNumSuffix').value = '';
    document.getElementById('vNumDigits').value = '4';
    document.getElementById('vNumStart').value  = '1';
    document.getElementById('vNumFrom').value   = '';
    document.getElementById('vNumTo').value     = '';
    updateVNumPreview();
    document.getElementById('voucherNumEditForm').style.display = 'block';
    document.getElementById('vNumPrefix').focus();
}

function _vnEditStyle(id) {
    var style = _vnStyles.find(function(s){ return s.id === id; });
    if (!style) return;
    _vnEditIdx = id;
    document.getElementById('vNumFormTitle').textContent = 'Edit Style #' + id;
    document.getElementById('vNumPrefix').value = style.prefix || '';
    document.getElementById('vNumSuffix').value = style.suffix || '';
    document.getElementById('vNumDigits').value = style.digits || 4;
    document.getElementById('vNumStart').value  = style.start_num || 1;
    document.getElementById('vNumFrom').value   = style.valid_from || '';
    document.getElementById('vNumTo').value     = style.valid_to || '';
    updateVNumPreview();
    document.getElementById('voucherNumEditForm').style.display = 'block';
    document.getElementById('vNumPrefix').focus();
}

function vNumCancelEdit() {
    _vnEditIdx = -1;
    var form = document.getElementById('voucherNumEditForm');
    if (form) form.style.display = 'none';
}

function updateVNumPreview() {
    var prefix = (document.getElementById('vNumPrefix').value || '').trim();
    var suffix = (document.getElementById('vNumSuffix').value || '').trim();
    var digits = parseInt(document.getElementById('vNumDigits').value) || 4;
    var start  = parseInt(document.getElementById('vNumStart').value) || 1;
    var el = document.getElementById('vNumPreview');
    if (el) el.textContent = _vNumPreviewStr(prefix, suffix, digits, start);
}

function vNumSaveStyle() {
    var prefix  = (document.getElementById('vNumPrefix').value || '').trim();
    var suffix  = (document.getElementById('vNumSuffix').value || '').trim();
    var digits  = parseInt(document.getElementById('vNumDigits').value) || 4;
    var start   = parseInt(document.getElementById('vNumStart').value) || 1;
    var from    = document.getElementById('vNumFrom').value || '';
    var to      = document.getElementById('vNumTo').value || '';

    if (!from || !to) { toast('Valid From and Valid To dates are required', 'warning'); return; }
    if (from > to)    { toast('Valid From must be before Valid To', 'warning'); return; }

    var payload = {
        voucher_type: _vnActiveTab,
        prefix: prefix,
        suffix: suffix,
        digits: digits,
        start_num: start,
        valid_from: from,
        valid_to: to
    };
    if (_vnEditIdx > 0) payload.id = _vnEditIdx;

    _vnSaveStyle(payload, function(){
        vNumCancelEdit();
    });
}

/* ═══════════════════════════════════════════════════════
   PREVIEW NEXT PO NUMBER — called when opening new PO
   Server looks up active style itself, returns prefix/suffix/digits/next
═══════════════════════════════════════════════════════ */
function _vnPreviewNextPO(callback) {
    fetch('/api/procurement/voucher_numbering/next?voucher_type=po')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (d.status === 'ok' && (d.prefix || d.suffix)) {
                var preview = _vNumPreviewStr(d.prefix, d.suffix, d.digits, d.next);
                if (typeof callback === 'function') callback(preview);
            } else {
                if (typeof callback === 'function') callback('');
            }
        })
        .catch(function(){ if (typeof callback === 'function') callback(''); });
}

/* ═══════════════════════════════════════════════════════
   INIT — load styles on page load
═══════════════════════════════════════════════════════ */
(function(){
    _vnLoad();
})();
