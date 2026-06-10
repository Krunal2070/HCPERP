/* gop_mtv.js — Material Transfer Voucher tab for General OP
   Reuses all functions from mtv.js (loadMtvList, openMtvForm, saveMtv etc.)
   This file only handles:
     • Type-filter sidebar rendering
     • Override of openMtvForm close → returns to General OP list
     • Voucher type filter pills in the toolbar
   Depends on: utils.js, general_op.js, mtv.js                             */

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _gopMtvTypes     = [];   // [{name, abbreviation, is_active}]
var _gopMtvTypeFilter = 'all'; // 'all' | type name

/* ══════════════════════════════════════════════════════
   INIT — called once on first tab visit
══════════════════════════════════════════════════════ */
async function gopMtvInit() {
    // Load voucher types for filter pills
    try {
        var res  = await fetch('/api/gop/voucher_types?parent_type=mtv');
        var data = await res.json();
        _gopMtvTypes = (data.status === 'ok' ? data.types : []).filter(function(t){ return t.is_active; });
    } catch(e) { _gopMtvTypes = []; }

    gopMtvRenderToolbar();
    await loadMtvList();
}

/* ══════════════════════════════════════════════════════
   TOOLBAR — type filter pills + action buttons
   Injected into #gopMtvToolbar
══════════════════════════════════════════════════════ */
function gopMtvRenderToolbar() {
    var tb = document.getElementById('gopMtvTypeFilter');
    if (!tb) return;

    var html = '<button class="filter-pill' + (_gopMtvTypeFilter === 'all' ? ' active' : '') + '" '
             + 'data-f="all" onclick="gopMtvSetTypeFilter(\'all\')">All Types</button>';

    _gopMtvTypes.forEach(function(t) {
        var active = _gopMtvTypeFilter === t.name;
        html += '<button class="filter-pill' + (active ? ' active' : '') + '" '
              + 'data-f="' + escHtml(t.name) + '" onclick="gopMtvSetTypeFilter(\'' + t.name.replace(/'/g, "\\'") + '\')">'
              + escHtml(t.name)
              + (t.abbreviation ? ' <span style="font-size:9px;font-family:var(--font-mono);opacity:.7">(' + escHtml(t.abbreviation) + ')</span>' : '')
              + '</button>';
    });

    tb.innerHTML = html;
}

function gopMtvSetTypeFilter(typeName) {
    _gopMtvTypeFilter = typeName;
    gopMtvRenderToolbar();
    _gopMtvApplyTypeFilter();
}

/* Apply voucher type filter on top of existing MTV filter logic */
function _gopMtvApplyTypeFilter() {
    // Patch into MTV's render — override _mtvVouchers filter
    _mtvRenderListFiltered();
}

/* ══════════════════════════════════════════════════════
   PATCHED RENDER — wraps _mtvRenderList with type filter
══════════════════════════════════════════════════════ */
async function _mtvRenderListFiltered() {
    // Temporarily filter _mtvVouchers by type before render
    var origVouchers = _mtvVouchers.slice();
    if (_gopMtvTypeFilter !== 'all') {
        _mtvVouchers = _mtvVouchers.filter(function(v) {
            return (v.voucher_type_name || '') === _gopMtvTypeFilter;
        });
    }
    await _mtvRenderList();
    _mtvVouchers = origVouchers; // restore
}

/* ══════════════════════════════════════════════════════
   OVERRIDE mtvSetFilter to also apply type filter
══════════════════════════════════════════════════════ */
var _gopMtvOrigSetFilter = null;
function _gopMtvPatchFilters() {
    // Patch mtvApplyFilter to go through type filter too
    var origApply = mtvApplyFilter;
    mtvApplyFilter = function() {
        _mtvSearch = (document.getElementById('mtvSearchInput') ?
            document.getElementById('mtvSearchInput').value : '').toLowerCase().trim();
        _mtvRenderListFiltered();
    };
    var origSetFilter = mtvSetFilter;
    mtvSetFilter = function(f) {
        _mtvFilter = f;
        document.querySelectorAll('#mtvFilterGroup .filter-pill').forEach(function(b) {
            b.classList.toggle('active', b.dataset.f === f);
        });
        _mtvRenderListFiltered();
    };
}

/* ══════════════════════════════════════════════════════
   OVERRIDE _mtvCloseForm to stay in General OP
   (Original closes to procurement MTV list pane)
══════════════════════════════════════════════════════ */
function _mtvCloseForm() {
    // Show GOP MTV list pane, hide form pane
    var listPane = document.getElementById('gopMtvListPane');
    var formPane = document.getElementById('mtv-form-pane');
    if (listPane) listPane.style.display = '';
    if (formPane) formPane.style.display = 'none';
    loadMtvList();
}

/* ══════════════════════════════════════════════════════
   LOAD / REFRESH
══════════════════════════════════════════════════════ */
async function gopMtvRefresh() {
    await loadMtvList();
    if (_gopMtvTypeFilter !== 'all') _gopMtvApplyTypeFilter();
}

/* ══════════════════════════════════════════════════════
   INIT CALL — patches applied once on tab first open
══════════════════════════════════════════════════════ */
var _gopMtvPatched = false;
function _gopMtvEnsurePatched() {
    if (_gopMtvPatched) return;
    _gopMtvPatched = true;
    _gopMtvPatchFilters();
    // Note: openMtvForm pane switching now handled in mtv.js directly
}
