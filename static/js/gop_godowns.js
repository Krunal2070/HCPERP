/* gop_godowns.js — Godowns & Addresses for General OP
   API: /api/gop/godowns/*  and  /api/gop/billing
   Depends on: utils.js, general_op.js                   */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _gopGodowns      = [];
var _gopGodownFilter = 'all';
var _gopGodownSearch = '';
var _gopGodownEditId = null;
var _gopGodownTab    = 'godowns';  // 'godowns' | 'billing'
var _gopBilling      = {};         // billing address object

var _GOP_STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh",
    "Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala",
    "Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha",
    "Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh",
    "Uttarakhand","West Bengal","Andaman & Nicobar Islands","Chandigarh",
    "Dadra & Nagar Haveli","Daman & Diu","Delhi","Jammu & Kashmir","Ladakh",
    "Lakshadweep","Puducherry"];

/* ══════════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════════ */
async function gopLoadGodowns() {
    var pane = document.getElementById('godown-list-pane');
    if (!pane) return;
    pane.innerHTML = '<div class="state-box"><div class="spinner"></div><h3>Loading\u2026</h3></div>';
    try {
        var [gdRes, billRes] = await Promise.all([
            fetch('/api/gop/godowns'),
            fetch('/api/gop/billing')
        ]);
        var gdData   = await gdRes.json();
        var billData = await billRes.json();
        if (gdData.status !== 'ok') throw new Error(gdData.message);
        _gopGodowns = gdData.godowns || [];
        _gopBilling = (billData.status === 'ok' ? billData.billing : {}) || {};
        _gopRenderGodownsPage();
    } catch (e) {
        pane.innerHTML = '<div class="state-box"><h3>Error loading</h3><p>' + escHtml(e.message) + '</p></div>';
    }
}

/* ══════════════════════════════════════════════════════
   TAB SWITCHER — renders the whole godown-list-pane
══════════════════════════════════════════════════════ */
function _gopRenderGodownsPage() {
    // With new HTML layout, the tab bar is in the toolbar (segmented control)
    // We just need to inject a content container into the list pane
    var pane = document.getElementById('godown-list-pane');
    if (!pane) return;
    if (!document.getElementById('gopGdContent')) {
        pane.innerHTML = '<div id="gopGdContent"></div>';
    }
    _gopRenderActiveTab();
}

function gopGodownSwitchTab(tab) {
    _gopGodownTab = tab;
    // Update segmented control
    ['godowns','billing'].forEach(function(t) {
        var btn = document.getElementById('gopGdTab' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === tab);
    });
    _gopRenderActiveTab();
}

function _gopRenderActiveTab() {
    var content = document.getElementById('gopGdContent');
    if (!content) return;
    if (_gopGodownTab === 'godowns') {
        _gopRenderGodownsTab(content);
    } else {
        _gopRenderBillingTab(content);
    }
}

/* ══════════════════════════════════════════════════════
   GODOWNS TAB
══════════════════════════════════════════════════════ */
function gopGodownSearch() {
    _gopGodownSearch = (document.getElementById('godownSearchInput') ?
        document.getElementById('godownSearchInput').value : '').toLowerCase().trim();
    if (_gopGodownTab === 'godowns') _gopRenderGodownsTab(document.getElementById('gopGdContent'));
}

function gopGodownFilter(f) {
    _gopGodownFilter = f;
    document.querySelectorAll('#tc-godowns .filter-pill').forEach(function(b) {
        b.classList.toggle('active', b.dataset.f === f);
    });
    if (_gopGodownTab === 'godowns') _gopRenderGodownsTab(document.getElementById('gopGdContent'));
}

function _gopRenderGodownsTab(container) {
    if (!container) return;

    var rows = _gopGodowns.slice();
    // Apply toolbar filter
    if (_gopGodownFilter === 'godown') {
        rows = rows.filter(function(g) { return (g.type || 'godown') !== 'billing'; });
    }
    // 'all' shows everything including billing-type godown records
    if (_gopGodownSearch) {
        rows = rows.filter(function(g) {
            return (g.name    || '').toLowerCase().includes(_gopGodownSearch) ||
                   (g.address || '').toLowerCase().includes(_gopGodownSearch) ||
                   (g.city    || '').toLowerCase().includes(_gopGodownSearch);
        });
    }

    // Update badges
    var badge    = document.getElementById('sbBadge-godowns');
    var rowBadge = document.getElementById('godownRowBadge');
    if (badge)    badge.textContent    = _gopGodowns.length;
    if (rowBadge) rowBadge.textContent = rows.length + ' locations';

    if (!rows.length) {
        container.innerHTML = '<div class="state-box"><h3>No godowns yet</h3>'
            + '<p>Click "+ New Godown" in the toolbar to add one.</p>'
            + '<button class="act-btn primary" onclick="gopNewGodown()" style="margin-top:12px">+ New Godown</button>'
            + '</div>';
        return;
    }

    var html = '<div class="gd-grid">';
    rows.forEach(function(g) {
        var accentColor = g.is_default ? 'var(--teal)' : 'var(--border2)';
        var addr = [g.address, g.city, g.state, g.pin].filter(Boolean).join(', ') || '—';

        html += '<div style="border:1px solid var(--border2);border-radius:10px;padding:14px 16px;'
              + 'background:var(--surface);border-left:3px solid ' + accentColor + ';'
              + 'cursor:pointer;transition:box-shadow .15s" '
              + 'onclick="gopEditGodown(' + g.id + ')" '
              + 'onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.1)\'" '
              + 'onmouseout="this.style.boxShadow=\'\'">'
              + '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">'
              +   '<div style="display:flex;align-items:center;gap:8px">'
              +     '<span style="font-size:13px;font-weight:700;color:var(--text)">' + escHtml(g.name) + '</span>'
              +     (g.is_default ? '<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;'
                  + 'background:var(--teal-glow,rgba(13,148,136,.12));color:var(--teal)">DEFAULT</span>' : '')
              +   '</div>'
              +   '<div style="display:flex;gap:4px" onclick="event.stopPropagation()">'
              +     (!g.is_default ?
                     '<button onclick="gopSetDefaultGodown(' + g.id + ')" title="Set as default" '
                   + 'style="height:24px;padding:0 8px;border-radius:5px;border:1px solid var(--border2);'
                   + 'background:transparent;color:var(--muted);font-size:10px;font-weight:600;cursor:pointer;font-family:var(--font-body)">'
                   + 'Set Default</button>' : '')
              +     '<button onclick="gopEditGodown(' + g.id + ')" '
              +       'style="height:24px;width:24px;border-radius:5px;border:1px solid var(--border2);'
              +       'background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center" title="Edit">'
              +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
              +     '</button>'
              +     '<button onclick="gopDeleteGodown(' + g.id + ')" '
              +       'style="height:24px;width:24px;border-radius:5px;border:1px solid rgba(244,63,94,.3);'
              +       'background:rgba(244,63,94,.06);color:var(--red-text);cursor:pointer;display:flex;align-items:center;justify-content:center" title="Delete">'
              +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
              +     '</button>'
              +   '</div>'
              + '</div>'
              + '<div style="font-size:11.5px;color:var(--muted);line-height:1.5;margin-bottom:6px">' + escHtml(addr) + '</div>'
              + '<div style="display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--muted)">'
              + (g.contact    ? '<span>👤 ' + escHtml(g.contact)    + '</span>' : '')
              + (g.phone      ? '<span>📞 ' + escHtml(g.phone)      + '</span>' : '')
              + (g.email      ? '<span>✉️ ' + escHtml(g.email)      + '</span>' : '')
              + (g.gst_number ? '<span style="font-family:var(--font-mono)">GST: ' + escHtml(g.gst_number) + '</span>' : '')
              + '</div>'
              + '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   BILLING ADDRESS TAB
══════════════════════════════════════════════════════ */
function _gopRenderBillingTab(container) {
    if (!container) return;

    var b = _gopBilling || {};
    var stateOpts = '<option value="">— Select State —</option>'
        + _GOP_STATES.map(function(s){ return '<option value="' + escHtml(s) + '">' + escHtml(s) + '</option>'; }).join('');

    container.innerHTML = '<div style="padding:20px 28px;max-width:860px">'
        + '<p style="font-size:11.5px;color:var(--muted);margin-bottom:16px">'
        + 'This address appears as <strong>Invoice To</strong> on all Purchase Orders.</p>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">Company Name <span class="req">*</span></label>'
        +     '<input class="form-input-styled" type="text" id="gopBillName" value="' + escHtml(b.name||'HCP Wellness Pvt Ltd') + '" placeholder="HCP Wellness Pvt Ltd"></div>'
        +   '<div class="form-group"><label class="form-label">Contact Person</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillContact" value="' + escHtml(b.contact||'') + '" placeholder="Purchase Manager"></div>'
        + '</div>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">Phone</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillPhone" value="' + escHtml(b.phone||'') + '" placeholder="+91\u2026"></div>'
        +   '<div class="form-group"><label class="form-label">Email</label>'
        +     '<input class="form-input-styled" type="email" id="gopBillEmail" value="' + escHtml(b.email||'') + '" placeholder="purchase@hcpwellness.in"></div>'
        +   '<div class="form-group"><label class="form-label">GSTIN</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillGST" value="' + escHtml(b.gst||b.gst_number||'') + '" placeholder="24AAFCH7246H1ZK" style="text-transform:uppercase;font-family:var(--font-mono)"></div>'
        + '</div>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">PAN</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillPAN" value="' + escHtml(b.pan||'') + '" placeholder="AAFCH7246H" style="text-transform:uppercase;font-family:var(--font-mono)"></div>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Address Line <span class="req">*</span></label>'
        +   '<input class="form-input-styled" type="text" id="gopBillStreet" value="' + escHtml(b.addr1||b.address||'') + '" placeholder="Street, area\u2026"></div>'

        + '<div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:12px;margin-bottom:20px">'
        +   '<div class="form-group"><label class="form-label">City</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillCity" value="' + escHtml(b.city||'') + '" placeholder="Ahmedabad"></div>'
        +   '<div class="form-group"><label class="form-label">State</label>'
        +     '<select class="form-input-styled" id="gopBillState">' + stateOpts + '</select></div>'
        +   '<div class="form-group"><label class="form-label">PIN</label>'
        +     '<input class="form-input-styled" type="text" id="gopBillPin" value="' + escHtml(b.pin||'') + '" placeholder="380054" maxlength="6" style="font-family:var(--font-mono)"></div>'
        + '</div>'

        + '<div style="display:flex;gap:10px;align-items:center">'
        +   '<button onclick="gopSaveBilling()" class="act-btn primary">'
        +     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/></svg>'
        +     ' Save Billing Address'
        +   '</button>'
        +   '<span id="gopBillSaveStatus" style="font-size:12px;color:var(--muted)"></span>'
        + '</div>'
        + '</div>';

    // Set state dropdown after render
    setTimeout(function() {
        var stateEl = document.getElementById('gopBillState');
        if (stateEl) stateEl.value = b.state || '';
    }, 20);
}

async function gopSaveBilling() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var street = get('gopBillStreet');
    if (!street) { toast('Address is required', 'error'); return; }

    var payload = {
        name:    get('gopBillName'),
        contact: get('gopBillContact'),
        phone:   get('gopBillPhone'),
        email:   get('gopBillEmail'),
        gst:     get('gopBillGST'),
        pan:     get('gopBillPAN'),
        addr1:   street,
        address: street,
        city:    get('gopBillCity'),
        state:   get('gopBillState'),
        pin:     get('gopBillPin')
    };

    var status = document.getElementById('gopBillSaveStatus');
    if (status) status.textContent = 'Saving\u2026';

    try {
        var res  = await fetch('/api/gop/billing', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        _gopBilling = payload;
        toast('Billing address saved', 'success');
        if (status) status.textContent = '';
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
        if (status) status.textContent = '';
    }
}

/* ══════════════════════════════════════════════════════
   GODOWN FORM — OPEN / CLOSE
══════════════════════════════════════════════════════ */
function gopNewGodown() {
    _gopGodownEditId = null;
    _gopShowGodownForm(null);
}

function gopEditGodown(id) {
    _gopGodownEditId = id;
    var g = _gopGodowns.find(function(x) { return x.id === id; }) || null;
    _gopShowGodownForm(g);
}

function _gopShowGodownForm(g) {
    var fp = document.getElementById('godown-form-pane');
    var fb = document.getElementById('godown-form-body');
    if (!fp || !fb) return;
    fp.style.display = 'block';

    var v     = g || {};
    var isNew = !g;
    var gtype = v.type || 'godown';

    fb.innerHTML = ''
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">'
        +   '<div>'
        +     '<div style="font-size:9px;font-weight:800;color:var(--teal);text-transform:uppercase;letter-spacing:.8px">' + (isNew ? 'NEW LOCATION' : 'EDIT LOCATION') + '</div>'
        +     '<div style="font-size:16px;font-weight:800;color:var(--text)">' + (isNew ? 'Add New' : escHtml(v.name||'')) + '</div>'
        +   '</div>'
        +   '<button onclick="_gopCloseGodownForm()" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center" title="Close (Esc)">'
        +     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        +   '</button>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Location Type</label>'
        +   '<select class="form-input-styled" id="gdTypeInput">'
        +     '<option value="godown"'  + (gtype==='godown' ?' selected':'') + '>Godown / Ship-To</option>'
        +     '<option value="billing"' + (gtype==='billing'?' selected':'') + '>Billing Address</option>'
        +   '</select>'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Name <span class="req">*</span></label>'
        +   '<input class="form-input-styled" type="text" id="gdNameInput" value="' + escHtml(v.name||'') + '" placeholder="Factory / Store / Lab\u2026" autocomplete="off">'
        + '</div>'

        + '<div class="form-group" style="margin-bottom:12px">'
        +   '<label class="form-label">Full Address</label>'
        +   '<textarea class="form-input-styled" id="gdAddressInput" rows="2" placeholder="Street, area\u2026" style="resize:vertical;min-height:60px">' + escHtml(v.address||'') + '</textarea>'
        + '</div>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr 90px;gap:10px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">City</label><input class="form-input-styled" id="gdCityInput" value="' + escHtml(v.city||'') + '" placeholder="Ahmedabad\u2026"></div>'
        +   '<div class="form-group"><label class="form-label">State</label><input class="form-input-styled" id="gdStateInput" value="' + escHtml(v.state||'') + '" placeholder="Gujarat\u2026"></div>'
        +   '<div class="form-group"><label class="form-label">PIN</label><input class="form-input-styled" id="gdPinInput" value="' + escHtml(v.pin||'') + '" placeholder="382220" style="font-family:var(--font-mono)"></div>'
        + '</div>'

        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">Contact Person</label><input class="form-input-styled" id="gdContactInput" value="' + escHtml(v.contact||'') + '" placeholder="Name\u2026"></div>'
        +   '<div class="form-group"><label class="form-label">Phone</label><input class="form-input-styled" id="gdPhoneInput" value="' + escHtml(v.phone||'') + '" placeholder="+91\u2026"></div>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">'
        +   '<div class="form-group"><label class="form-label">Email</label><input class="form-input-styled" id="gdEmailInput" value="' + escHtml(v.email||'') + '" placeholder="office@\u2026"></div>'
        +   '<div class="form-group"><label class="form-label">GST Number</label><input class="form-input-styled" id="gdGstInput" value="' + escHtml(v.gst_number||'') + '" placeholder="27XXXXX\u2026" style="font-family:var(--font-mono);letter-spacing:.5px"></div>'
        + '</div>'

        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">'
        +   '<input type="checkbox" id="gdDefaultInput"' + (v.is_default?' checked':'') + ' style="cursor:pointer">'
        +   '<label for="gdDefaultInput" style="font-size:12px;font-weight:600;cursor:pointer;color:var(--text)">Set as default godown</label>'
        + '</div>'

        + '<div style="display:flex;gap:8px">'
        +   '<button onclick="gopSaveGodown()" class="act-btn primary" style="flex:1">'
        +     '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13"/></svg>'
        +     (isNew ? ' Save Godown' : ' Update')
        +   '</button>'
        +   (!isNew ?
              '<button onclick="gopDeleteGodown(' + g.id + ')" style="height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(244,63,94,.3);background:rgba(244,63,94,.07);color:var(--red-text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">'
            + 'Delete</button>' : '')
        + '</div>';

    setTimeout(function() {
        var ni = document.getElementById('gdNameInput');
        if (ni) ni.focus();
    }, 50);
}

function _gopCloseGodownForm() {
    var fp = document.getElementById('godown-form-pane');
    if (fp) fp.style.display = 'none';
    _gopGodownEditId = null;
}

/* ══════════════════════════════════════════════════════
   SAVE / DELETE / SET DEFAULT
══════════════════════════════════════════════════════ */
async function gopSaveGodown() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var name = get('gdNameInput');
    if (!name) { toast('Name is required', 'error'); return; }

    var payload = {
        id:         _gopGodownEditId || null,
        name:       name,
        type:       get('gdTypeInput') || 'godown',
        address:    get('gdAddressInput'),
        city:       get('gdCityInput'),
        state:      get('gdStateInput'),
        pin:        get('gdPinInput'),
        contact:    get('gdContactInput'),
        phone:      get('gdPhoneInput'),
        email:      get('gdEmailInput'),
        gst_number: get('gdGstInput'),
        is_default: document.getElementById('gdDefaultInput') ?
                    document.getElementById('gdDefaultInput').checked : false
    };

    try {
        var res  = await fetch('/api/gop/godowns/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast(_gopGodownEditId ? 'Location updated' : 'Location saved', 'success');
        _gopCloseGodownForm();
        gopLoadGodowns();
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
    }
}

async function gopDeleteGodown(id) {
    var g = _gopGodowns.find(function(x) { return x.id === id; }) || {};
    if (!confirm('Delete "' + (g.name || 'this location') + '"? This cannot be undone.')) return;
    try {
        var res  = await fetch('/api/gop/godowns/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Location deleted', 'info');
        _gopCloseGodownForm();
        gopLoadGodowns();
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    }
}

async function gopSetDefaultGodown(id) {
    try {
        var res  = await fetch('/api/gop/godowns/set_default', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.status !== 'ok') throw new Error(data.message);
        toast('Default godown updated', 'success');
        gopLoadGodowns();
    } catch (e) {
        toast('Failed: ' + e.message, 'error');
    }
}

