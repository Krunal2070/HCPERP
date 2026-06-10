/* gop_shortcuts.js — Keyboard Shortcut Manager for General OP
   • User picks shortcuts for any registered action
   • Saved to localStorage (per browser, zero DB needed)
   • _gopShortcutMap = { "Alt+T": "new-mtv", ... } used by general_op.js
   • gopApplyScBadges() updates <kbd class="sc-badge"> elements across the page
   • Other modules call gopRegisterAction(key, label, defaultCombo) to add entries
   Depends on: utils.js, general_op.js                                        */

/* ══════════════════════════════════════════════════════
   ACTION REGISTRY
   Any module can call gopRegisterAction() before DOMContentLoaded completes.
   Built-in actions are seeded below.
══════════════════════════════════════════════════════ */
var _gopActions = [
    // key              label                               default combo   group
    { key:'tab-godowns',   label:'Open Godowns tab',          def:'Alt+1',    group:'Navigation' },
    { key:'tab-vtypes',    label:'Open Voucher Types tab',    def:'Alt+2',    group:'Navigation' },
    { key:'tab-vnumbering',label:'Open Voucher Numbering tab',def:'Alt+3',    group:'Navigation' },
    { key:'tab-shortcuts', label:'Open Shortcuts tab',        def:'Alt+4',    group:'Navigation' },
    { key:'tab-mtv',       label:'Open Material Transfer tab',def:'Alt+5',    group:'Navigation' },
    { key:'new-godown',    label:'New Godown',                def:'Alt+G',    group:'Godowns' },
    { key:'new-vtype',     label:'New Voucher Type',          def:'Alt+V',    group:'Voucher Types' },
    { key:'new-vn',        label:'New Numbering Style',       def:'Alt+N',    group:'Voucher Numbering' },
    { key:'new-mtv',       label:'New Material Transfer',     def:'Alt+T',    group:'Procurement' },
    { key:'new-po',        label:'New Purchase Order',        def:'Alt+P',    group:'Procurement' },
    { key:'new-grn',       label:'New GRN',                   def:'Alt+R',    group:'Procurement' },
    { key:'edit-item',     label:'Edit selected / focused item', def:'Alt+Enter', group:'Material Master' },
];

/* Live map: combo → action key. Rebuilt on every save/reset. */
var _gopShortcutMap = {};

/* ══════════════════════════════════════════════════════
   STORAGE
══════════════════════════════════════════════════════ */
var _GOP_SC_STORAGE_KEY = 'hcp_gop_shortcuts_v1';

function _gopScLoad() {
    try {
        var raw = localStorage.getItem(_GOP_SC_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch(e) { return {}; }
}

function _gopScSave(map) {
    try { localStorage.setItem(_GOP_SC_STORAGE_KEY, JSON.stringify(map)); }
    catch(e) {}
}

/* Returns user-assigned combo for an action key, falling back to default. */
function _gopScGet(actionKey) {
    var stored = _gopScLoad();
    var action = _gopActions.find(function(a) { return a.key === actionKey; });
    return stored[actionKey] || (action ? action.def : '');
}

/* Rebuilds the runtime map and re-applies badges. */
function gopBindShortcuts() {
    var stored = _gopScLoad();
    _gopShortcutMap = {};
    _gopActions.forEach(function(a) {
        var combo = stored[a.key] || a.def;
        if (combo) _gopShortcutMap[combo] = a.key;
    });
    gopApplyScBadges();
}

/* ══════════════════════════════════════════════════════
   BADGE RENDERING
   Elements: <kbd class="sc-badge" id="sc-{actionKey}"></kbd>
   These are sprinkled next to buttons throughout the page.
══════════════════════════════════════════════════════ */
function gopApplyScBadges() {
    _gopActions.forEach(function(a) {
        var combo = _gopScGet(a.key);
        document.querySelectorAll('.sc-badge[id="sc-' + a.key + '"]').forEach(function(el) {
            el.textContent = combo || '';
            el.style.display = combo ? 'inline-flex' : 'none';
        });
    });
}

/* ══════════════════════════════════════════════════════
   PUBLIC API — other modules register their actions
══════════════════════════════════════════════════════ */
function gopRegisterAction(key, label, defaultCombo, group) {
    if (_gopActions.find(function(a) { return a.key === key; })) return; // already registered
    _gopActions.push({ key: key, label: label, def: defaultCombo || '', group: group || 'Other' });
    gopBindShortcuts();
    if (_gopActiveTab === 'shortcuts') gopRenderShortcuts();
}

/* ══════════════════════════════════════════════════════
   AVAILABLE KEY POOL
   Combos that are safe to assign — excludes browser/OS reserved ones.
══════════════════════════════════════════════════════ */
var _gopAvailableCombos = (function() {
    var combos = [];
    // Alt + 1-9
    for (var i = 1; i <= 9; i++) combos.push('Alt+' + i);
    // Alt + A-Z (exclude M = sidebar toggle, D = theme already fixed)
    'ABCEFGHIJKLNOPQRSTUVWXYZ'.split('').forEach(function(c) {
        combos.push('Alt+' + c);
    });
    // Ctrl+Shift + A-Z
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function(c) {
        combos.push('Ctrl+Shift+' + c);
    });
    // F2-F9 (F1 = help, F10-F12 = browser)
    for (var f = 2; f <= 9; f++) combos.push('F' + f);
    return combos;
})();

function _gopUsedCombos(excludeKey) {
    var stored = _gopScLoad();
    var used   = {};
    _gopActions.forEach(function(a) {
        if (a.key === excludeKey) return;
        var combo = stored[a.key] || a.def;
        if (combo) used[combo] = a.label;
    });
    return used;
}

/* ══════════════════════════════════════════════════════
   RENDER SHORTCUTS TABLE
══════════════════════════════════════════════════════ */
function gopRenderShortcuts() {
    var body = document.getElementById('shortcutsBody');
    if (!body) return;

    var stored = _gopScLoad();

    // Group actions
    var groups = {};
    _gopActions.forEach(function(a) {
        if (!groups[a.group]) groups[a.group] = [];
        groups[a.group].push(a);
    });

    var html = '';

    Object.keys(groups).forEach(function(grp) {
        html += '<div style="margin-bottom:24px">'
              + '<div class="sc-group-head">'
              + escHtml(grp)
              + '<span class="sc-group-line"></span></div>'
              + '<div style="display:flex;flex-direction:column;gap:3px">';

        groups[grp].forEach(function(a) {
            var current = stored[a.key] || a.def;
            var isDefault = !stored[a.key] || stored[a.key] === a.def;

            html += '<div class="sc-row" id="scrow-' + a.key + '">'

                  // Action label
                  + '<div class="sc-action-label">'
                  + escHtml(a.label)
                  + (!isDefault ? '<span style="font-size:10px;color:var(--muted);margin-left:6px">(edited)</span>' : '')
                  + '</div>'

                  // Current shortcut display + click to change
                  + '<div style="display:flex;align-items:center;gap:8px">'
                  + '<kbd onclick="gopScOpenPicker(\'' + a.key + '\')" '
                  + 'class="sc-key-btn" title="Click to change shortcut">'
                  + escHtml(current || 'None')
                  + '</kbd>'

                  // Reset to default (only if overridden)
                  + (!isDefault ?
                    '<button onclick="gopScReset1(\'' + a.key + '\')" title="Reset to default: ' + escHtml(a.def) + '" '
                  + 'style="height:24px;padding:0 8px;border-radius:5px;border:1px solid var(--border2);'
                  + 'background:transparent;color:var(--muted);font-size:10px;font-weight:600;cursor:pointer;'
                  + 'font-family:var(--font-body)" '
                  + 'onmouseover="this.style.color=\'#2563eb\'" onmouseout="this.style.color=\'var(--muted)\'">'
                  + '↩ Default</button>' : '')

                  // Clear button
                  + (current ?
                    '<button onclick="gopScClear(\'' + a.key + '\')" title="Remove shortcut" '
                  + 'style="height:24px;width:24px;border-radius:5px;border:1px solid rgba(244,63,94,.3);'
                  + 'background:rgba(244,63,94,.06);color:var(--red-text);font-size:11px;cursor:pointer;'
                  + 'display:flex;align-items:center;justify-content:center">'
                  + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                  + '</button>' : '')
                  + '</div>'
                  + '</div>';
        });

        html += '</div></div>';
    });

    // Keyboard capture modal (hidden)
    html += '<div id="gopScPickerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);'
          + 'z-index:9000;display:none;align-items:center;justify-content:center">'
          + '<div style="background:var(--card);border-radius:14px;padding:28px 32px;min-width:340px;'
          + 'box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center">'
          + '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">ASSIGN SHORTCUT</div>'
          + '<div id="gopScPickerLabel" style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:20px"></div>'
          + '<div style="background:var(--surface2);border:2px dashed var(--border2);border-radius:10px;'
          + 'padding:20px;margin-bottom:16px;font-size:13px;color:var(--muted)" id="gopScPickerHint">'
          + 'Press any key combination&hellip;'
          + '</div>'
          + '<div id="gopScPickerCapture" style="font-family:var(--font-mono);font-size:22px;font-weight:800;'
          + 'color:#2563eb;min-height:32px;margin-bottom:20px;letter-spacing:.5px"></div>'
          + '<div id="gopScPickerConflict" style="font-size:11.5px;color:var(--red-text);margin-bottom:12px;min-height:16px"></div>'
          + '<div style="display:flex;gap:10px;justify-content:center">'
          + '<button id="gopScPickerSaveBtn" onclick="gopScPickerSave()" class="act-btn primary" disabled>Assign</button>'
          + '<button onclick="gopScPickerClose()" style="height:32px;padding:0 16px;border-radius:7px;border:1px solid var(--border2);background:transparent;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Cancel</button>'
          + '</div>'
          + '</div>'
          + '</div>';

    body.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   KEYBOARD CAPTURE PICKER
══════════════════════════════════════════════════════ */
var _gopScPickerKey     = null;  // action key being assigned
var _gopScPickerCombo   = null;  // combo currently captured

function gopScOpenPicker(actionKey) {
    _gopScPickerKey   = actionKey;
    _gopScPickerCombo = null;

    var action = _gopActions.find(function(a) { return a.key === actionKey; }) || {};
    var modal  = document.getElementById('gopScPickerModal');
    var label  = document.getElementById('gopScPickerLabel');
    var cap    = document.getElementById('gopScPickerCapture');
    var conf   = document.getElementById('gopScPickerConflict');
    var saveBtn = document.getElementById('gopScPickerSaveBtn');

    if (!modal) return;
    if (label)  label.textContent = action.label || actionKey;
    if (cap)    cap.textContent   = '';
    if (conf)   conf.textContent  = '';
    if (saveBtn) saveBtn.disabled = true;

    modal.style.display = 'flex';
    document.addEventListener('keydown', _gopScPickerKeyHandler);
}

function _gopScPickerKeyHandler(e) {
    // Ignore standalone modifier keys
    if (['Control','Alt','Shift','Meta'].includes(e.key)) return;
    e.preventDefault();

    var combo = _gopComboStr(e);
    _gopScPickerCombo = combo;

    var cap     = document.getElementById('gopScPickerCapture');
    var conf    = document.getElementById('gopScPickerConflict');
    var saveBtn = document.getElementById('gopScPickerSaveBtn');

    if (cap) cap.textContent = combo;

    // Check conflict
    var used     = _gopUsedCombos(_gopScPickerKey);
    var conflict = used[combo];

    if (conflict) {
        if (conf)    conf.textContent = '⚠ Already used by: ' + conflict;
        if (saveBtn) saveBtn.disabled = true;
    } else {
        if (conf)    conf.textContent = '';
        if (saveBtn) saveBtn.disabled = false;
    }
}

function gopScPickerSave() {
    if (!_gopScPickerKey || !_gopScPickerCombo) return;
    var stored = _gopScLoad();
    stored[_gopScPickerKey] = _gopScPickerCombo;
    _gopScSave(stored);
    gopScPickerClose();
    gopBindShortcuts();
    gopRenderShortcuts();
    toast('Shortcut assigned: ' + _gopScPickerCombo, 'success', 2500);
}

function gopScPickerClose() {
    var modal = document.getElementById('gopScPickerModal');
    if (modal) modal.style.display = 'none';
    document.removeEventListener('keydown', _gopScPickerKeyHandler);
    _gopScPickerKey   = null;
    _gopScPickerCombo = null;
}

/* ══════════════════════════════════════════════════════
   RESET / CLEAR INDIVIDUAL
══════════════════════════════════════════════════════ */
function gopScReset1(actionKey) {
    var stored = _gopScLoad();
    delete stored[actionKey];
    _gopScSave(stored);
    gopBindShortcuts();
    gopRenderShortcuts();
}

function gopScClear(actionKey) {
    var stored = _gopScLoad();
    stored[actionKey] = '';  // empty string = no shortcut
    _gopScSave(stored);
    gopBindShortcuts();
    gopRenderShortcuts();
}

/* ══════════════════════════════════════════════════════
   RESET ALL
══════════════════════════════════════════════════════ */
function gopScReset() {
    if (!confirm('Reset all keyboard shortcuts to defaults?')) return;
    localStorage.removeItem(_GOP_SC_STORAGE_KEY);
    gopBindShortcuts();
    gopRenderShortcuts();
    toast('All shortcuts reset to defaults', 'info');
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
    gopBindShortcuts();
});
