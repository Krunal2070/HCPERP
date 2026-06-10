/* general_op.js — Core shell for General Operations page
   Clock, theme, tab switching, sidebar, section header
   Depends on: utils.js                                    */

/* ══════════════════════════════════════════════════════
   CLOCK
══════════════════════════════════════════════════════ */
function _gopClock() {
    var el = document.getElementById('gopClockDisplay');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}
_gopClock();
setInterval(_gopClock, 1000);

/* ══════════════════════════════════════════════════════
   THEME
══════════════════════════════════════════════════════ */
var _GOP_THEMES = ['dark','light','midnight','ocean','sage'];
var _gopTheme   = localStorage.getItem('hcp_procurement_theme') ||
                  localStorage.getItem('hcp_theme') || 'dark';

function _gopApplyTheme(t) {
    _gopTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('hcp_procurement_theme', t);
    var icons = { dark:'🌙', light:'☀️', midnight:'🔮', ocean:'🌊', sage:'🌿' };
    var btn = document.getElementById('gopThemeBtn');
    if (btn) btn.innerHTML = (icons[t]||'🎨') + '<span class="ib-tip">Theme · Ctrl+D</span>';
}
function gopCycleTheme() {
    var idx = (_GOP_THEMES.indexOf(_gopTheme) + 1) % _GOP_THEMES.length;
    _gopApplyTheme(_GOP_THEMES[idx]);
    if (typeof toast === 'function') toast('Theme: ' + _GOP_THEMES[idx], 'info', 1800);
}
_gopApplyTheme(_gopTheme);

/* ══════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════ */
var _gopSidebarOpen = true;
function gopToggleSidebar() {
    _gopSidebarOpen = !_gopSidebarOpen;
    var sb = document.getElementById('gopSidebar');
    var mc = document.getElementById('gopMainContent');
    if (sb) sb.classList.toggle('collapsed', !_gopSidebarOpen);
    if (mc) mc.classList.toggle('sidebar-collapsed', !_gopSidebarOpen);
}

function gopSetActive(id) {
    document.querySelectorAll('.sidebar-item').forEach(function(el) {
        el.classList.remove('active');
    });
    var el = document.getElementById('sb-' + id);
    if (el) el.classList.add('active');
}

/* ══════════════════════════════════════════════════════
   SECTION META
══════════════════════════════════════════════════════ */
var _GOP_SECTION_META = {
    godowns: {
        label: 'GENERAL OP',
        title: 'Godowns & Addresses',
        icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'
    },
    vtypes: {
        label: 'GENERAL OP',
        title: 'Voucher Types',
        icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2z"/><path d="M7 7h.01"/></svg>'
    },
    vnumbering: {
        label: 'GENERAL OP',
        title: 'Voucher Numbering',
        icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>'
    },
    shortcuts: {
        label: 'GENERAL OP',
        title: 'Keyboard Shortcuts',
        icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h4M14 8h4M6 12h2M10 12h2M14 12h4M6 16h12"/></svg>'
    },
    mtv: {
        label: 'GENERAL OP',
        title: 'Material Transfer',
        icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>'
    }
};

/* ══════════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════════ */
var _gopActiveTab   = 'godowns';
var _gopTabInited   = {};

function gopSwitchTab(id) {
    _gopActiveTab = id;

    document.querySelectorAll('.tab-content').forEach(function(tc) {
        tc.classList.remove('active');
    });
    var tc = document.getElementById('tc-' + id);
    if (tc) tc.classList.add('active');

    // Update section header
    var meta = _GOP_SECTION_META[id];
    if (meta) {
        var icon  = document.getElementById('gopSectionIcon');
        var label = document.getElementById('gopSectionLabel');
        var title = document.getElementById('gopSectionTitle');
        if (icon)  icon.innerHTML    = meta.icon;
        if (label) label.textContent = meta.label;
        if (title) title.textContent = meta.title;
    }

    // Lazy-init each tab on first visit
    if (!_gopTabInited[id]) {
        _gopTabInited[id] = true;
        if (id === 'godowns'    && typeof gopLoadGodowns    === 'function') gopLoadGodowns();
        if (id === 'vtypes'     && typeof gopLoadVtypes     === 'function') gopLoadVtypes();
        if (id === 'vnumbering' && typeof gopLoadVn         === 'function') gopLoadVn();
        if (id === 'shortcuts'  && typeof gopRenderShortcuts === 'function') gopRenderShortcuts();
        if (id === 'mtv' && typeof gopMtvInit === 'function') {
            _gopMtvEnsurePatched();
            gopMtvInit();
        }
    }

    // Apply shortcut badges
    if (typeof gopApplyScBadges === 'function') gopApplyScBadges();
}

/* ══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS — global bindings
══════════════════════════════════════════════════════ */
document.addEventListener('keydown', function(e) {
    // Skip if focused in an input/textarea/select
    var tag = (document.activeElement || {}).tagName || '';
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;

    if (typeof _gopShortcutMap !== 'undefined') {
        var combo = _gopComboStr(e);
        var action = _gopShortcutMap[combo];
        if (action) {
            e.preventDefault();
            _gopFireAction(action);
        }
    }

    // Fixed: Alt+M = toggle sidebar
    if (e.altKey && e.key === 'm') { e.preventDefault(); gopToggleSidebar(); }
    // Fixed: Ctrl+D = cycle theme
    if (e.ctrlKey && e.key === 'd') { e.preventDefault(); gopCycleTheme(); }
    // Fixed: Escape closes any open form pane
    if (e.key === 'Escape') { _gopEscapeAll(); }
});

function _gopEscapeAll() {
    ['godown','vtype','vn'].forEach(function(pane) {
        var fp = document.getElementById(pane + '-form-pane');
        if (fp) fp.style.display = 'none';
    });
    // Close MTV form and return to list
    var mtvForm = document.getElementById('mtv-form-pane');
    var mtvList = document.getElementById('gopMtvListPane');
    if (mtvForm && mtvForm.style.display !== 'none') {
        mtvForm.style.display = 'none';
        if (mtvList) mtvList.style.display = '';
    }
}

function _gopComboStr(e) {
    var parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    var k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
}

function _gopFireAction(action) {
    var map = {
        'new-godown':   function() { if(typeof gopNewGodown==='function')   gopNewGodown(); },
        'new-vtype':    function() { if(typeof gopNewVtype==='function')     gopNewVtype(); },
        'new-vn':       function() { if(typeof gopVnAddNew==='function')     gopVnAddNew(); },
        'tab-godowns':  function() { gopSwitchTab('godowns');  gopSetActive('godowns'); },
        'tab-vtypes':   function() { gopSwitchTab('vtypes');   gopSetActive('vtypes'); },
        'tab-vnumbering': function() { gopSwitchTab('vnumbering'); gopSetActive('vnumbering'); },
        'tab-shortcuts':  function() { gopSwitchTab('shortcuts');  gopSetActive('shortcuts'); },
        'tab-mtv':        function() { gopSwitchTab('mtv');        gopSetActive('mtv'); },
        'new-mtv':        function() { if(_gopActiveTab==='mtv' && typeof openMtvForm==='function') openMtvForm(null); },
    };
    if (map[action]) map[action]();
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
    // Hash-based deep linking: /general_op#vnumbering opens that tab directly
    var hash    = (window.location.hash || '').replace('#', '').trim();
    var validTabs = ['godowns', 'vtypes', 'vnumbering', 'shortcuts', 'mtv'];
    var startTab  = validTabs.includes(hash) ? hash : 'godowns';

    gopSwitchTab(startTab);
    gopSetActive(startTab);

    // Bind shortcuts after all modules load
    setTimeout(function() {
        if (typeof gopBindShortcuts  === 'function') gopBindShortcuts();
        if (typeof gopApplyScBadges  === 'function') gopApplyScBadges();
    }, 100);
});
