/* gop_vnumbering.js — Voucher Numbering for General OP
   Redesigned: two-column layout (type tree sidebar + styles main panel)
   Depends on: utils.js, general_op.js, gop_vtypes.js               */

var _gopVnStyles     = [];
var _gopVnActiveTab  = '';
var _gopVnEditId     = null;
var _gopVnTabList    = [];
var _gopVnSearch     = '';
var _gopVnFullTypes  = [];    // full voucher type list with material_type_id

/* ══════════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════════ */
async function gopLoadVn() {
    var sidebar  = document.getElementById('vnTypeSidebar');
    var mainPane = document.getElementById('vnMainPane');
    if (!sidebar || !mainPane) return;
    mainPane.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div>';

    try {
        var [vnRes, vtRes] = await Promise.all([
            fetch('/api/gop/voucher_numbering/list'),
            fetch('/api/gop/voucher_types')
        ]);
        var vnData = await vnRes.json();
        var vtData = await vtRes.json();
        if (vnData.status !== 'ok') throw new Error(vnData.message);
        _gopVnStyles = vnData.styles || [];

        var parents     = (vtData.status === 'ok' ? vtData.parents : []) || [];
        var customTypes = (vtData.status === 'ok' ? vtData.types   : []) || [];

        // Build tab list: parent types + active custom types with styles
        _gopVnTabList = parents.map(function(p) {
            return { key: p.key, label: p.label, isParent: true };
        });
        customTypes.forEach(function(t) {
            if (!t.is_active) return;
            var hasStyles = _gopVnStyles.some(function(s) { return s.voucher_type === t.name; });
            if (hasStyles || t.abbreviation) {
                _gopVnTabList.push({
                    key: t.name, label: t.name,
                    abbr: t.abbreviation, isParent: false,
                    parentKey: t.parent_type
                });
            }
        });

        // Default to first tab
        if (!_gopVnActiveTab || !_gopVnTabList.find(function(t) { return t.key === _gopVnActiveTab; })) {
            _gopVnActiveTab = _gopVnTabList.length ? _gopVnTabList[0].key : 'po';
        }

        _gopVnRenderSidebar();
        _gopVnRenderMain();

    } catch (e) {
        if (mainPane) mainPane.innerHTML = '<div class="state-box"><h3>Error</h3><p>' + escHtml(e.message) + '</p></div>';
    }
}

/* ══════════════════════════════════════════════════════
   SIDEBAR — type tree
══════════════════════════════════════════════════════ */
function _gopVnRenderSidebar() {
    var sidebar = document.getElementById('vnTypeSidebar');
    if (!sidebar) return;
    var today = new Date().toISOString().substring(0, 10);

    // Group custom types by parent
    var customByParent = {};
    _gopVnTabList.filter(function(t) { return !t.isParent; }).forEach(function(t) {
        var pk = t.parentKey || 'other';
        if (!customByParent[pk]) customByParent[pk] = [];
        customByParent[pk].push(t);
    });

    var html = '';
    _gopVnTabList.filter(function(t) { return t.isParent; }).forEach(function(p) {
        var stylesForParent = _gopVnStyles.filter(function(s) { return s.voucher_type === p.key; });
        var hasActive = stylesForParent.some(function(s) { return s.valid_from <= today && s.valid_to >= today; });
        var count = stylesForParent.length;
        var isActive = p.key === _gopVnActiveTab;

        html += '<div class="vn-sidebar-item' + (isActive ? ' active' : '') + '" onclick="gopVnSwitchTab(\'' + p.key.replace(/'/g, "\\'") + '\')">'
            + '<span>' + escHtml(p.label) + '</span>'
            + (count > 0
                ? '<span class="vn-sidebar-badge' + (hasActive ? ' has-active' : '') + '">' + count + '</span>'
                : '')
            + '</div>';

        // Custom child types under this parent
        var children = customByParent[p.key] || [];
        children.forEach(function(c) {
            var childStyles = _gopVnStyles.filter(function(s) { return s.voucher_type === c.key; });
            var childActive = childStyles.some(function(s) { return s.valid_from <= today && s.valid_to >= today; });
            var childCount  = childStyles.length;
            var isChildActive = c.key === _gopVnActiveTab;
            html += '<div class="vn-sidebar-item custom-type' + (isChildActive ? ' active' : '') + '" onclick="gopVnSwitchTab(\'' + c.key.replace(/'/g, "\\'") + '\')">'
                + (c.abbr ? '<span style="font-family:var(--font-mono);font-size:10px;background:rgba(37,99,235,.1);color:#2563eb;padding:1px 6px;border-radius:4px">' + escHtml(c.abbr) + '</span> ' : '')
                + '<span style="flex:1">' + escHtml(c.label) + '</span>'
                + (childCount > 0
                    ? '<span class="vn-sidebar-badge' + (childActive ? ' has-active' : '') + '">' + childCount + '</span>'
                    : '')
                + '</div>';
        });
    });

    sidebar.innerHTML = html || '<div style="padding:16px;font-size:12px;color:var(--muted)">No types defined.</div>';
}

/* ══════════════════════════════════════════════════════
   MAIN PANEL — style cards
══════════════════════════════════════════════════════ */
function _gopVnRenderMain() {
    var mainPane = document.getElementById('vnMainPane');
    if (!mainPane) return;
    var today = new Date().toISOString().substring(0, 10);

    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fd(d) {
        if (!d) return '—';
        var p = String(d).split('-');
        return p.length === 3 ? p[2] + '/' + MONTHS[parseInt(p[1]) - 1] + '/' + p[0] : d;
    }
    function preview(s) {
        var num   = String(s.start_num || 1).padStart(s.digits || 4, '0');
        var parts = [];
        if (s.prefix) parts.push(s.prefix);
        parts.push(num);
        if (s.suffix) parts.push(s.suffix);
        return parts.join('/');
    }
    function progressPct(s) {
        var from = new Date(s.valid_from).getTime();
        var to   = new Date(s.valid_to).getTime();
        var now  = new Date(today).getTime();
        if (now < from) return 0;
        if (now > to)   return 100;
        return Math.round((now - from) / (to - from) * 100);
    }

    // Filter by active tab or search
    var filtered;
    if (_gopVnSearch) {
        filtered = _gopVnStyles.filter(function(s) {
            return (s.voucher_type || '').toLowerCase().includes(_gopVnSearch) ||
                   (s.prefix       || '').toLowerCase().includes(_gopVnSearch) ||
                   (s.suffix       || '').toLowerCase().includes(_gopVnSearch) ||
                   preview(s).toLowerCase().includes(_gopVnSearch);
        });
    } else {
        // Show only styles explicitly saved under this type key
        filtered = _gopVnStyles.filter(function(s) { return s.voucher_type === _gopVnActiveTab; });
    }

    // Find active tab info
    var activeTab = _gopVnTabList.find(function(t) { return t.key === _gopVnActiveTab; });
    var tabLabel  = activeTab ? activeTab.label : _gopVnActiveTab;

    if (!filtered.length) {
        mainPane.innerHTML = '<div class="vn-main-header">'
            + '<div class="vn-main-title">' + escHtml(tabLabel) + '</div>'
            + '</div>'
            + '<div class="state-box" style="margin:40px auto">'
            + (_gopVnSearch
                ? '<h3>No matches for &ldquo;' + escHtml(_gopVnSearch) + '&rdquo;</h3>'
                : '<h3>No numbering styles</h3><p>Define prefix, suffix &amp; digit format for <strong>' + escHtml(tabLabel) + '</strong></p>'
                  + '<button class="act-btn primary" onclick="gopVnAddNew()" style="margin-top:12px">+ Add Numbering Style</button>')
            + '</div>';
        return;
    }

    // Sort: active first, then by valid_from desc
    filtered.sort(function(a, b) {
        var aActive = a.valid_from <= today && a.valid_to >= today ? 1 : 0;
        var bActive = b.valid_from <= today && b.valid_to >= today ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        return (b.valid_from || '').localeCompare(a.valid_from || '');
    });

    var html = '<div class="vn-main-header">'
        + '<div class="vn-main-title">' + escHtml(tabLabel) + '</div>'
        + '<span style="font-size:11px;color:var(--muted);font-weight:500">' + filtered.length + ' style' + (filtered.length > 1 ? 's' : '') + '</span>'
        + '</div>';

    html += '<div class="vn-styles-list">';

    filtered.forEach(function(s) {
        var isActive   = s.valid_from <= today && s.valid_to >= today;
        var isSelected = _gopVnEditId === s.id;
        var pct        = progressPct(s);

        html += '<div class="vn-style-card'
            + (isActive   ? ' active-style'   : '')
            + (isSelected ? ' selected-style' : '')
            + '" onclick="gopVnSelect(' + s.id + ')">'

        // Card header: voucher number preview + active chip
        + '<div class="vn-style-card-head">'
        +   '<div class="vn-voucher-preview">' + escHtml(preview(s)) + '</div>'
        +   (isActive ? '<span class="vn-active-chip">ACTIVE</span>' : '')
        +   '<div style="display:flex;gap:4px;margin-left:12px" onclick="event.stopPropagation()">'
        +     '<button onclick="gopVnEdit(' + s.id + ')" title="Edit" class="gd-act-btn">'
        +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
        +     '</button>'
        +     '<button onclick="gopVnDelete(' + s.id + ')" title="Delete" class="gd-act-btn del">'
        +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
        +     '</button>'
        +   '</div>'
        + '</div>'

        // Card body: 4 meta cells
        + '<div class="vn-style-card-body">'
        +   '<div class="vn-meta-cell"><div class="vn-meta-label">Prefix</div><div class="vn-meta-value">' + escHtml(s.prefix || '—') + '</div></div>'
        +   '<div class="vn-meta-cell"><div class="vn-meta-label">Suffix</div><div class="vn-meta-value">' + escHtml(s.suffix || '—') + '</div></div>'
        +   '<div class="vn-meta-cell"><div class="vn-meta-label">Digits</div><div class="vn-meta-value">' + (s.digits || 4) + '</div></div>'
        +   '<div class="vn-meta-cell"><div class="vn-meta-label">Valid Period</div>'
        +     '<div class="vn-meta-value" style="font-size:11px;font-family:var(--font-body)">' + fd(s.valid_from) + ' → ' + fd(s.valid_to) + '</div>'
        +   '</div>'
        + '</div>'

        // Period progress bar (only for active/in-range styles)
        + (isActive
            ? '<div class="vn-period-bar"><div class="vn-period-fill" style="width:' + pct + '%"></div></div>'
            : '')

        + '</div>';
    });

    html += '</div>';
    mainPane.innerHTML = html;
}


/* ══════════════════════════════════════════════════════
   MATERIAL TYPE INDICATOR — shown in form below type selector
══════════════════════════════════════════════════════ */
async function _gopVnEnsureFullTypes() {
    if (_gopVnFullTypes.length) return;
    try {
        var res  = await fetch('/api/gop/voucher_types');
        var data = await res.json();
        if (data.status === 'ok') _gopVnFullTypes = data.types || [];
    } catch(e) {}
}

function _gopVnShowMatTypeIndicator() {
    var sel = document.getElementById('vnVoucherTypeSelect');
    var ind = document.getElementById('vnMatTypeIndicator');
    if (!sel || !ind) return;

    var typeName = sel.value;
    var typeInfo = _gopVnFullTypes.find(function(t){ return t.name === typeName || t.key === typeName; });

    if (!typeInfo) {
        // Try to fetch if not cached
        _gopVnEnsureFullTypes().then(function(){
            typeInfo = _gopVnFullTypes.find(function(t){ return t.name === typeName; });
            _gopVnRenderMatTypeIndicator(ind, typeInfo, typeName);
        });
        return;
    }
    _gopVnRenderMatTypeIndicator(ind, typeInfo, typeName);
}

var _gopVnMatTypes = [];  // cached material types

async function _gopVnLoadMatTypes() {
    if (_gopVnMatTypes.length) return;
    try {
        var res = await fetch('/api/procurement/material_types');
        var d   = await res.json();
        if (d.status === 'ok') _gopVnMatTypes = d.types || [];
    } catch(e) {}
}

function _gopVnRenderMatTypeIndicator(ind, typeInfo, typeName) {
    // Populate the inline material type select
    var sel    = document.getElementById('vnMatTypeAssocSelect');
    var status = document.getElementById('vnMatTypeAssocStatus');
    _gopVnLoadMatTypes().then(function() {
        if (sel && _gopVnMatTypes.length) {
            var curId = typeInfo ? (typeInfo.material_type_id || '') : '';
            sel.innerHTML = '<option value="">— All Materials (no filter) —</option>'
                + _gopVnMatTypes.map(function(t) {
                    var sel2 = String(curId) === String(t.id) ? ' selected' : '';
                    return '<option value="' + t.id + '"' + sel2 + '>'
                        + escHtml(t.type_name) + (t.abbreviation ? ' (' + t.abbreviation + ')' : '')
                        + '</option>';
                }).join('');
        }
    });

    if (!ind) return;
    if (!typeInfo || !typeInfo.mat_type_name) {
        ind.innerHTML = '<span style="font-size:10px;color:var(--muted)">No material type set — select below to associate one</span>';
        return;
    }
    var color = typeInfo.mat_type_color || '#6b7280';
    ind.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px">'
        + '<span style="padding:1px 7px;border-radius:6px;font-size:9px;font-weight:700;color:#fff;background:' + color + '">'
        + escHtml(typeInfo.mat_type_abbr || typeInfo.mat_type_name) + '</span>'
        + '<span style="color:var(--muted)">currently linked</span>'
        + '</span>';
}

async function _gopVnSaveMatTypeAssoc() {
    var typeSel   = document.getElementById('vnVoucherTypeSelect');
    var matSel    = document.getElementById('vnMatTypeAssocSelect');
    var status    = document.getElementById('vnMatTypeAssocStatus');
    if (!typeSel || !matSel) return;

    var typeName   = typeSel.value;
    var matTypeId  = matSel.value || null;
    if (!typeName) return;

    // Find the voucher type id by name
    var vtInfo = _gopVnFullTypes.find(function(t){ return t.name === typeName; });
    if (!vtInfo || !vtInfo.id) {
        if (status) status.textContent = '⚠ Type not found';
        return;
    }

    if (status) status.textContent = 'Saving…';
    try {
        var res  = await fetch('/api/gop/voucher_types/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id:               vtInfo.id,
                name:             vtInfo.name,
                parent_type:      vtInfo.parent_type,
                abbreviation:     vtInfo.abbreviation || null,
                description:      vtInfo.description || null,
                is_active:        vtInfo.is_active !== 0,
                material_type_id: matTypeId ? parseInt(matTypeId) : null
            })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        // Update cache
        vtInfo.material_type_id = matTypeId ? parseInt(matTypeId) : null;
        var mt = _gopVnMatTypes.find(function(t){ return String(t.id) === String(matTypeId); });
        vtInfo.mat_type_name  = mt ? mt.type_name  : null;
        vtInfo.mat_type_abbr  = mt ? mt.abbreviation : null;
        vtInfo.mat_type_color = mt ? mt.color : null;
        if (status) { status.textContent = '✓ Saved'; setTimeout(function(){ if(status) status.textContent=''; }, 2000); }
        // Refresh indicator
        _gopVnRenderMatTypeIndicator(document.getElementById('vnMatTypeIndicator'), vtInfo, typeName);
        // Reload full types to propagate
        _gopVnFullTypes = [];
        _gopVnEnsureFullTypes();
    } catch(e) {
        if (status) status.textContent = '⚠ ' + e.message;
        toast('Save failed: ' + e.message, 'error');
    }
}

function gopVnSwitchTab(key) {
    _gopVnActiveTab = key;
    _gopVnEditId    = null;
    _gopVnSearch    = '';
    var si = document.getElementById('vnSearchInput');
    if (si) si.value = '';
    var fp = document.getElementById('vn-form-pane');
    if (fp) fp.style.display = 'none';
    _gopVnRenderSidebar();
    _gopVnRenderMain();
}

function gopVnSearch() {
    _gopVnSearch = (document.getElementById('vnSearchInput') ?
        document.getElementById('vnSearchInput').value : '').toLowerCase().trim();
    _gopVnRenderMain();
}

function gopVnSelect(id) {
    _gopVnEditId = id;
    _gopVnRenderMain();
    var s = _gopVnStyles.find(function(x) { return x.id === id; });
    _gopShowVnForm(s || null);
}

/* ══════════════════════════════════════════════════════
   FORM (slide-in panel)
══════════════════════════════════════════════════════ */
function gopVnAddNew() {
    _gopVnEditId = null;
    _gopShowVnForm(null);
}

function gopVnEdit(id) {
    _gopVnEditId = id;
    var s = _gopVnStyles.find(function(x) { return x.id === id; }) || null;
    _gopShowVnForm(s);
}

function _gopShowVnForm(s) {
    var fp = document.getElementById('vn-form-pane');
    var fb = document.getElementById('vn-form-body');
    var layout = document.getElementById('vnLayout');
    if (!fp || !fb) return;
    fp.style.display = 'block';
    if (layout) layout.classList.add('form-open');

    var v     = s || {};
    var isNew = !s;
    var today   = new Date().toISOString().substring(0, 10);
    var yearEnd = new Date().getFullYear() + '-03-31';

    // Build voucher type options for the selector
    var typeOptions = _gopVnTabList.map(function(t) {
        var selected = (s ? s.voucher_type : _gopVnActiveTab) === t.key;
        return '<option value="' + escHtml(t.key) + '"' + (selected ? ' selected' : '') + '>'
            + (t.isParent ? '' : '    ') + escHtml(t.label) + '</option>';
    }).join('');

    fb.innerHTML = ''
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">'
        +   '<div>'
        +     '<div style="font-size:9px;font-weight:800;color:var(--teal);text-transform:uppercase;letter-spacing:.8px">'
        +       (isNew ? 'NEW STYLE' : 'EDIT STYLE') + ' — ' + escHtml(_gopVnActiveTab.toUpperCase())
        +     '</div>'
        +     '<div style="font-size:16px;font-weight:800;color:var(--text)">'
        +       (isNew ? 'New Numbering Style' : 'Edit Style')
        +     '</div>'
        +   '</div>'
        +   '<button onclick="_gopCloseVnForm()" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center">'
        +     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        +   '</button>'
        + '</div>'

        // Voucher Type selector — allows reassigning to correct type
        + '<div class="form-group" style="margin-bottom:14px;padding:10px 12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">'
        +   '<label class="form-label" style="margin-bottom:5px">Voucher Type <span style="font-size:9px;font-weight:400;color:var(--muted)">(which type this numbering belongs to)</span></label>'
        +   '<select class="form-input-styled" id="vnVoucherTypeSelect" style="font-size:12px" onchange="_gopVnShowMatTypeIndicator()">' + typeOptions + '</select>'
        +   '<div id="vnMatTypeIndicator" style="margin-top:8px;min-height:22px"></div>'
        +   '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">'
        +     '<label class="form-label" style="margin-bottom:4px">Material Type Association '
        +       '<span style="font-size:9px;font-weight:400;color:var(--muted)">— filters materials when used in forms</span>'
        +     '</label>'
        +     '<div style="display:flex;gap:6px;align-items:center">'
        +       '<select class="form-input-styled" id="vnMatTypeAssocSelect" style="font-size:12px;flex:1" onchange="_gopVnSaveMatTypeAssoc()">'
        +         '<option value="">— All Materials (no filter) —</option>'
        +       '</select>'
        +       '<span id="vnMatTypeAssocStatus" style="font-size:10px;color:var(--muted);flex-shrink:0"></span>'
        +     '</div>'
        +   '</div>'
        + '</div>'

        // Live preview
        + '<div style="background:rgba(37,99,235,.06);border:1px solid rgba(37,99,235,.2);border-radius:10px;padding:14px 18px;margin-bottom:18px;text-align:center">'
        +   '<div style="font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Live Preview</div>'
        +   '<div id="vnPreviewBox" style="font-family:var(--font-mono);font-size:20px;font-weight:800;color:#2563eb;letter-spacing:.02em">—</div>'
        + '</div>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">Prefix</label>'
        +     '<input class="form-input-styled" id="vnPrefixInput" value="' + escHtml(v.prefix||'') + '" '
        +     'placeholder="e.g. HCP/RM" style="font-family:var(--font-mono)" oninput="_gopVnUpdatePreview()" autocomplete="off"></div>'
        +   '<div class="form-group"><label class="form-label">Suffix</label>'
        +     '<input class="form-input-styled" id="vnSuffixInput" value="' + escHtml(v.suffix||'') + '" '
        +     'placeholder="e.g. 25-26" style="font-family:var(--font-mono)" oninput="_gopVnUpdatePreview()" autocomplete="off"></div>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">'
        +   '<div class="form-group"><label class="form-label">Digits</label>'
        +     '<input class="form-input-styled" id="vnDigitsInput" type="number" min="1" max="8" value="' + (v.digits||4) + '" oninput="_gopVnUpdatePreview()"></div>'
        +   '<div class="form-group"><label class="form-label">Starting Number</label>'
        +     '<input class="form-input-styled" id="vnStartInput" type="number" min="1" value="' + (v.start_num||1) + '" style="font-family:var(--font-mono)" oninput="_gopVnUpdatePreview()"></div>'
        + '</div>'

        + '<div style="background:var(--surface2);border-radius:8px;padding:12px 14px;margin-bottom:16px">'
        +   '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Active Period</div>'
        +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
        +     '<div class="form-group"><label class="form-label">Valid From <span class="req">*</span></label>'
        +       '<input class="form-input-styled" type="date" id="vnFromInput" value="' + (v.valid_from||today) + '"></div>'
        +     '<div class="form-group"><label class="form-label">Valid To <span class="req">*</span></label>'
        +       '<input class="form-input-styled" type="date" id="vnToInput" value="' + (v.valid_to||yearEnd) + '"></div>'
        +   '</div>'
        +   '<div style="font-size:10.5px;color:var(--muted);margin-top:6px">Overlapping ranges use the most recent one.</div>'
        + '</div>'

        + '<div style="display:flex;gap:8px;margin-top:4px">'
        +   '<button onclick="gopVnSave()" class="act-btn primary" style="flex:1">'
        +     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/></svg>'
        +     (isNew ? ' Save Style' : ' Update Style')
        +   '</button>'
        +   (!isNew
              ? '<button onclick="gopVnDelete(' + s.id + ')" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.07);color:var(--red-text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Delete</button>'
              : '')
        + '</div>';

    _gopVnUpdatePreview();
    // Load full type list and show material type indicator
    _gopVnEnsureFullTypes().then(function(){ _gopVnShowMatTypeIndicator(); });
    setTimeout(function() {
        var pi = document.getElementById('vnPrefixInput');
        if (pi) pi.focus();
    }, 50);
}

function _gopVnUpdatePreview() {
    var prefix = document.getElementById('vnPrefixInput') ? document.getElementById('vnPrefixInput').value.trim() : '';
    var suffix = document.getElementById('vnSuffixInput') ? document.getElementById('vnSuffixInput').value.trim() : '';
    var digits = parseInt(document.getElementById('vnDigitsInput') ? document.getElementById('vnDigitsInput').value : 4) || 4;
    var start  = parseInt(document.getElementById('vnStartInput')  ? document.getElementById('vnStartInput').value  : 1) || 1;
    var num    = String(start).padStart(digits, '0');
    var parts  = [];
    if (prefix) parts.push(prefix);
    parts.push(num);
    if (suffix) parts.push(suffix);
    var prev = document.getElementById('vnPreviewBox');
    if (prev) prev.textContent = parts.join('/');
}

function _gopCloseVnForm() {
    var fp = document.getElementById('vn-form-pane');
    var layout = document.getElementById('vnLayout');
    if (fp) fp.style.display = 'none';
    if (layout) layout.classList.remove('form-open');
    _gopVnEditId = null;
    _gopVnRenderMain();
}

/* ══════════════════════════════════════════════════════
   SAVE / DELETE
══════════════════════════════════════════════════════ */
async function gopVnSave() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var vfrom  = get('vnFromInput');
    var vto    = get('vnToInput');
    var prefix = get('vnPrefixInput').toLowerCase();
    var suffix = get('vnSuffixInput').toLowerCase();
    var vtype  = document.getElementById('vnVoucherTypeSelect') ? document.getElementById('vnVoucherTypeSelect').value : _gopVnActiveTab;

    if (!vfrom || !vto) { toast('Valid From and Valid To dates are required', 'warning'); return; }
    if (vfrom > vto)    { toast('Valid From must be before Valid To', 'warning'); return; }

    // ── Client-side duplicate / period clash check ──
    var duplicate = _gopVnStyles.find(function(s) {
        if (s.id === _gopVnEditId) return false; // skip self when editing
        if ((s.voucher_type || '') !== vtype) return false;
        // Block ANY date overlap for the same voucher type
        return s.valid_from <= vto && s.valid_to >= vfrom;
    });
    if (duplicate) {
        var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        function fd(d) { if(!d) return '—'; var p=String(d).split('-'); return p.length===3?p[2]+'/'+MONTHS[parseInt(p[1])-1]+'/'+p[0]:d; }
        var samePrefixSuffix = (duplicate.prefix||'').toLowerCase().trim() === prefix &&
                               (duplicate.suffix||'').toLowerCase().trim() === suffix;
        toast(
            (samePrefixSuffix
                ? 'Duplicate: a style with prefix "' + (duplicate.prefix||'—') + '" / suffix "' + (duplicate.suffix||'—') + '"'
                : 'Period clash: another style (' + (duplicate.prefix||'—') + '/' + (duplicate.suffix||'—') + ')'
            ) + ' already covers ' + fd(duplicate.valid_from) + ' → ' + fd(duplicate.valid_to) +
            '. Adjust the date range so periods don\'t overlap.',
            'error', 7000
        );
        return;
    }

    var payload = {
        id:           _gopVnEditId || null,
        voucher_type: (document.getElementById('vnVoucherTypeSelect') ? document.getElementById('vnVoucherTypeSelect').value : _gopVnActiveTab) || _gopVnActiveTab,
        prefix:       get('vnPrefixInput'),
        suffix:       get('vnSuffixInput'),
        digits:       parseInt(get('vnDigitsInput')) || 4,
        start_num:    parseInt(get('vnStartInput'))  || 1,
        valid_from:   vfrom,
        valid_to:     vto
    };

    try {
        var res  = await fetch('/api/gop/voucher_numbering/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Numbering style saved', 'success');
        // Switch to the type tab where the style was saved
        var savedType = (document.getElementById('vnVoucherTypeSelect') ? document.getElementById('vnVoucherTypeSelect').value : _gopVnActiveTab) || _gopVnActiveTab;
        _gopVnActiveTab = savedType;
        _gopCloseVnForm();
        gopLoadVn();
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
    }
}

async function gopVnDelete(id) {
    if (!confirm('Delete this numbering style? Existing vouchers keep their numbers.')) return;
    try {
        var res  = await fetch('/api/gop/voucher_numbering/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Style deleted', 'info');
        _gopCloseVnForm();
        gopLoadVn();
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    }
}
