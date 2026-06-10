/* gop_vtypes.js — Voucher Type Masters for General OP
   API: /api/gop/voucher_types/*
   Tally-style: named child types under fixed parent types
   Depends on: utils.js, general_op.js                    */

var _gopVtypes       = [];
var _gopMatTypes     = [];  // cached from /api/procurement/material_types
var _gopParentTypes  = [];
var _gopVtypeFilter  = 'all';
var _gopVtypeEditId  = null;

/* ══════════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════════ */
async function gopLoadVtypes() {
    var pane = document.getElementById('vtype-list-pane');
    if (!pane) return;
    pane.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading\u2026</h3></div>';
    // Load material types for association dropdown
    if (!_gopMatTypes.length) {
        try {
            var mtr = await fetch('/api/procurement/material_types');
            var mtd = await mtr.json();
            if (mtd.status === 'ok') _gopMatTypes = mtd.types || [];
        } catch(e) {}
    }
    try {
        var res  = await fetch('/api/gop/voucher_types');
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        _gopVtypes      = data.types   || [];
        _gopParentTypes = data.parents || [];
        _gopBuildParentFilterPills();
        _gopRenderVtypes();
    } catch (e) {
        pane.innerHTML = '<div class="state-box"><h3>Error</h3><p>' + escHtml(e.message) + '</p></div>';
    }
}

function _gopBuildParentFilterPills() {
    var bar = document.getElementById('vtypeParentFilter');
    if (!bar) return;
    var html = '<button class="filter-pill' + (_gopVtypeFilter==='all'?' active':'') + '" data-p="all" onclick="gopVtypeFilter(\'all\')">All Types</button>';
    _gopParentTypes.forEach(function(p) {
        html += '<button class="filter-pill' + (_gopVtypeFilter===p.key?' active':'') + '" data-p="' + escHtml(p.key) + '" onclick="gopVtypeFilter(\'' + p.key + '\')">'
              + escHtml(p.label) + '</button>';
    });
    bar.innerHTML = html;
}

function gopVtypeFilter(f) {
    _gopVtypeFilter = f;
    _gopBuildParentFilterPills();
    _gopRenderVtypes();
}

/* ══════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════ */
function _gopRenderVtypes() {
    var pane = document.getElementById('vtype-list-pane');
    if (!pane) return;

    var rows = _gopVtypes.slice();
    if (_gopVtypeFilter !== 'all') {
        rows = rows.filter(function(t) { return t.parent_type === _gopVtypeFilter; });
    }

    var badge    = document.getElementById('sbBadge-vtypes');
    var rowBadge = document.getElementById('vtypeRowBadge');
    if (badge)    badge.textContent    = _gopVtypes.length;
    if (rowBadge) rowBadge.textContent = rows.length + ' types';

    if (!rows.length) {
        pane.innerHTML = '<div class="state-box"><h3>No voucher types</h3>'
            + '<p>Create named types under any parent to get started.</p>'
            + '<button class="act-btn primary" onclick="gopNewVtype()" style="margin-top:12px">+ New Voucher Type</button></div>';
        return;
    }

    // Group by parent
    var groups = {};
    _gopParentTypes.forEach(function(p) { groups[p.key] = []; });
    rows.forEach(function(t) {
        if (!groups[t.parent_type]) groups[t.parent_type] = [];
        groups[t.parent_type].push(t);
    });

    var parentLabel = {};
    _gopParentTypes.forEach(function(p) { parentLabel[p.key] = p.label; });

    var html = '';
    Object.keys(groups).forEach(function(pk) {
        var grp = groups[pk];
        if (!grp.length) return;
        html += '<div class="vt-section">'
              + '<div class="vt-section-head">'
              + escHtml(parentLabel[pk] || pk.toUpperCase())
              + '<span class="vt-section-line"></span>'
              + '<span class="vt-section-count">' + grp.length + ' type' + (grp.length > 1 ? 's' : '') + '</span>'
              + '</div>'
              + '<div class="vt-grid">';

        grp.forEach(function(t) {
            html += '<div class="vt-card' + (t.is_active ? '' : ' inactive') + '" '
                  + 'onclick="gopEditVtype(' + t.id + ')">'
                  + '<div class="vt-card-top">'
                  +   '<div style="display:flex;align-items:center;gap:8px">'
                  +     '<span class="vt-card-name">' + escHtml(t.name) + '</span>'
                  +     (t.abbreviation ? '<span class="vt-card-abbr">' + escHtml(t.abbreviation) + '</span>' : '')
                  +     (!t.is_active ?
                         '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;'
                       + 'background:rgba(220,38,38,.1);color:var(--red-text)">INACTIVE</span>' : '')
                  +   '</div>'
                  +   '<div class="vt-card-acts" onclick="event.stopPropagation()">'
                  +     '<button onclick="gopEditVtype(' + t.id + ')" title="Edit" class="gd-act-btn">'
                  +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
                  +     '</button>'
                  +     '<button onclick="gopDeleteVtype(' + t.id + ')" title="Delete" class="gd-act-btn del">'
                  +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
                  +     '</button>'
                  +   '</div>'
                  + '</div>'
                  + (t.description ? '<div class="vt-card-desc">' + escHtml(t.description) + '</div>' : '')
                  + (t.mat_type_name ? '<div style="margin-top:5px"><span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px;color:#fff;background:' + escHtml(t.mat_type_color||'#6b7280') + '">' + escHtml(t.mat_type_abbr||t.mat_type_name) + '</span></div>' : '')
                  + '</div>';
        });
        html += '</div></div>';
    });

    pane.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   FORM
══════════════════════════════════════════════════════ */
function gopNewVtype() {
    _gopVtypeEditId = null;
    _gopShowVtypeForm(null);
}

function gopEditVtype(id) {
    _gopVtypeEditId = id;
    var t = _gopVtypes.find(function(x) { return x.id === id; }) || null;
    _gopShowVtypeForm(t);
}

function _gopShowVtypeForm(t) {
    var fp = document.getElementById('vtype-form-pane');
    var fb = document.getElementById('vtype-form-body');
    if (!fp || !fb) return;
    fp.style.display = 'block';
    fp.style.width = '420px';
    fp.style.borderLeftWidth = '1px';
    fp.style.padding = '0';

    // Ensure material types are loaded before rendering form
    if (!_gopMatTypes.length) {
        fetch('/api/procurement/material_types')
            .then(function(r){ return r.json(); })
            .then(function(d){
                if (d.status === 'ok') _gopMatTypes = d.types || [];
                _gopRenderVtypeFormBody(t, fp, fb);
            })
            .catch(function(){ _gopRenderVtypeFormBody(t, fp, fb); });
        return;
    }
    _gopRenderVtypeFormBody(t, fp, fb);
}

function _gopRenderVtypeFormBody(t, fp, fb) {
    var v     = t || {};
    var isNew = !t;

    var parentOptions = _gopParentTypes.map(function(p) {
        return '<option value="' + escHtml(p.key) + '"'
             + (v.parent_type === p.key ? ' selected' : '') + '>'
             + escHtml(p.label) + '</option>';
    }).join('');

    fb.innerHTML = ''
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">'
        +   '<div>'
        +     '<div style="font-size:9px;font-weight:800;color:var(--teal);text-transform:uppercase;letter-spacing:.8px">' + (isNew ? 'NEW TYPE' : 'EDIT TYPE') + '</div>'
        +     '<div style="font-size:16px;font-weight:800;color:var(--text)">' + (isNew ? 'New Voucher Type' : escHtml(v.name||'')) + '</div>'
        +   '</div>'
        +   '<button onclick="_gopCloseVtypeForm()" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center" title="Close (Esc)">'
        +     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        +   '</button>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Parent Type <span class="req">*</span></label>'
        +   '<select class="form-input-styled" id="vtParentInput">' + parentOptions + '</select>'
        +   '<div style="font-size:10.5px;color:var(--muted);margin-top:4px">Like Tally — your type inherits parent behaviour</div>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Type Name <span class="req">*</span></label>'
        +   '<input class="form-input-styled" type="text" id="vtNameInput" value="' + escHtml(v.name||'') + '" placeholder="e.g. RM Store Transfer\u2026" autocomplete="off">'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Abbreviation</label>'
        +   '<input class="form-input-styled" type="text" id="vtAbbrInput" value="' + escHtml(v.abbreviation||'') + '" placeholder="e.g. RM-MTV" style="font-family:var(--font-mono)" maxlength="20" autocomplete="off">'
        +   '<div style="font-size:10.5px;color:var(--muted);margin-top:4px">Used as prefix in voucher numbers if no numbering style configured</div>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Description</label>'
        +   '<input class="form-input-styled" type="text" id="vtDescInput" value="' + escHtml(v.description||'') + '" placeholder="Optional description\u2026" autocomplete="off">'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:16px">'
        +   '<label class="form-label">Material Type Association'
        +     '<span style="font-weight:400;font-size:9.5px;color:var(--muted);margin-left:6px">— filters materials when this voucher type is selected</span>'
        +   '</label>'
        +   '<select class="form-input-styled" id="vtMatTypeId">'
        +     '<option value="">— All Materials (no filter) —</option>'
        +     _gopMatTypes.map(function(t) {
                var sel = (v.material_type_id && String(v.material_type_id) === String(t.id)) ? ' selected' : '';
                return '<option value="' + t.id + '"' + sel + '>' + escHtml(t.type_name) + (t.abbreviation ? ' (' + t.abbreviation + ')' : '') + '</option>';
              }).join('')
        +   '</select>'
        +   '<div style="font-size:10.5px;color:var(--muted);margin-top:4px">e.g. Raw Material PO → Raw Material · RM Store Transfer → Raw Material</div>'
        + '</div>'

        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">'
        +   '<input type="checkbox" id="vtActiveInput"' + (isNew || v.is_active ? ' checked' : '') + ' style="cursor:pointer">'
        +   '<label for="vtActiveInput" style="font-size:12px;font-weight:600;cursor:pointer;color:var(--text)">Active</label>'
        + '</div>'

        + '<div style="display:flex;gap:8px">'
        +   '<button onclick="gopSaveVtype()" class="act-btn primary" style="flex:1">'
        +     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/></svg>'
        +     (isNew ? ' Create Type' : ' Update')
        +   '</button>'
        +   (!isNew ?
              '<button onclick="gopDeleteVtype(' + t.id + ')" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.07);color:var(--red-text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Delete</button>' : '')
        + '</div>';

    setTimeout(function() {
        var ni = document.getElementById('vtNameInput');
        if (ni) ni.focus();
    }, 50);
}

function _gopCloseVtypeForm() {
    var fp = document.getElementById('vtype-form-pane');
    if (fp) fp.style.display = 'none';
    _gopVtypeEditId = null;
}

/* ══════════════════════════════════════════════════════
   SAVE / DELETE
══════════════════════════════════════════════════════ */
async function gopSaveVtype() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var name   = get('vtNameInput');
    var parent = get('vtParentInput');
    if (!name)   { toast('Name is required', 'error');        return; }
    if (!parent) { toast('Parent type is required', 'error'); return; }

    var payload = {
        id:               _gopVtypeEditId || null,
        name:             name,
        parent_type:      parent,
        abbreviation:     get('vtAbbrInput'),
        description:      get('vtDescInput'),
        material_type_id: (document.getElementById('vtMatTypeId') ? document.getElementById('vtMatTypeId').value : '') || null,
        is_active:        document.getElementById('vtActiveInput') ?
                          document.getElementById('vtActiveInput').checked : true
    };

    try {
        var res  = await fetch('/api/gop/voucher_types/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast(_gopVtypeEditId ? 'Voucher type updated' : 'Voucher type created', 'success');
        _gopCloseVtypeForm();
        gopLoadVtypes();
        // Also refresh numbering tabs since new type was added
        if (typeof gopLoadVn === 'function') { _gopTabInited['vnumbering'] = false; }
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
    }
}

async function gopDeleteVtype(id) {
    var t = _gopVtypes.find(function(x) { return x.id === id; }) || {};
    if (!confirm('Delete voucher type "' + (t.name || 'this type') + '"?\n\nExisting vouchers using this type are not affected.')) return;
    try {
        var res  = await fetch('/api/gop/voucher_types/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Voucher type deleted', 'info');
        _gopCloseVtypeForm();
        gopLoadVtypes();
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    }
}
