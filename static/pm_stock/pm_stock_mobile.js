/* ════════════════════════════════════════════════════════════════
   MOBILE BOOTSTRAP for PM Stock
   - Detects mobile (touch device OR window < 768px)
   - Adds .is-mobile body class so CSS / JS can branch
   - Builds a bottom tab bar for one-handed quick navigation
   - Closes the sidebar on outside-tap when sidebar is open
   Mobile CSS itself lives inline inside pm_stock.html — no external
   CSS file is fetched here. The previous build referenced a
   /static/css/pm_stock_mobile.css that never existed; that
   indirection has been removed.
═══════════════════════════════════════════════════════════════ */
(function() {

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
        || window.innerWidth < 768;
  }

  var _active = false;

  function enableMobile() {
    if(_active) return;
    document.body.classList.add('is-mobile');
    _active = true;
    buildTabBar();
    enableSidebarDismiss();
  }

  function disableMobile() {
    if(!_active) return;
    document.body.classList.remove('is-mobile');
    _active = false;
    var bar = document.getElementById('mob-tab-bar');
    if(bar) bar.remove();
  }

  function check() {
    isMobile() ? enableMobile() : disableMobile();
  }

  document.addEventListener('DOMContentLoaded', check);
  window.addEventListener('resize', (function(){
    var t; return function(){ clearTimeout(t); t = setTimeout(check, 200); };
  })());

  /* ── Bottom tab bar ────────────────────────────────────── */
  function buildTabBar() {
    if(document.getElementById('mob-tab-bar')) return;

    // Inject CSS for the tab bar once
    if(!document.getElementById('mob-tab-bar-css')){
      var st = document.createElement('style');
      st.id = 'mob-tab-bar-css';
      st.textContent = ''
        + '#mob-tab-bar{position:fixed;left:0;right:0;bottom:0;z-index:150;'
        +              'display:flex;align-items:flex-end;justify-content:space-around;'
        +              'background:var(--surface,#fff);border-top:1px solid var(--border2,rgba(0,0,0,.13));'
        +              'box-shadow:0 -4px 14px rgba(0,0,0,.08);padding:6px 4px 8px;'
        +              'font-family:var(--font-body,inherit);'
        +              'padding-bottom:max(8px,env(safe-area-inset-bottom));}'
        + '#mob-tab-bar .mob-tab{flex:1;display:flex;flex-direction:column;align-items:center;'
        +              'justify-content:center;gap:3px;background:transparent;border:0;cursor:pointer;'
        +              'padding:6px 2px;color:var(--muted2,#6b7280);min-height:48px;'
        +              'font-family:inherit;}'
        + '#mob-tab-bar .mob-tab.active{color:var(--teal,#0d9488)}'
        + '#mob-tab-bar .mob-tab.active .mob-tab-icon{transform:scale(1.06)}'
        + '#mob-tab-bar .mob-tab:active{opacity:.55}'
        + '/* Push body content up so the bar does not cover footer/buttons */'
        + 'body.is-mobile{padding-bottom:64px}';
      document.head.appendChild(st);
    }

    var tabs = [
      { tab:'stock',  icon:'📦', label:'Stock'    },
      { tab:'grn',    icon:'📋', label:'Vouchers' },
      { tab:'new',    icon:'➕', label:'New',  fab:true },
      { tab:'mm',     icon:'🔄', label:'Move'    },
      { tab:'_menu',  icon:'☰',  label:'Menu'     },
    ];
    var bar = document.createElement('nav');
    bar.id = 'mob-tab-bar';
    bar.innerHTML = tabs.map(function(t) {
      var onclick;
      if(t.fab)               onclick = "if(typeof pmvOpen==='function') pmvOpen('grn'); else if(typeof openGrnModal==='function') openGrnModal();";
      else if(t.tab==='_menu') onclick = "if(typeof toggleSidebar==='function') toggleSidebar();";
      else                     onclick = "if(typeof switchTab==='function') switchTab('"+t.tab+"'); if(typeof setSidebarActive==='function') setSidebarActive('"+t.tab+"'); mobSetActive('"+t.tab+"');";
      var iconEl = t.fab
        ? '<span class="mob-tab-icon" style="display:flex;align-items:center;justify-content:center;'
          + 'width:48px;height:48px;background:var(--teal,#0d9488);border-radius:50%;'
          + 'font-size:22px;color:#fff;box-shadow:0 3px 12px rgba(26,115,232,.4);margin-top:-18px">' + t.icon + '</span>'
        : '<span class="mob-tab-icon" style="font-size:19px;line-height:1;transition:transform .15s">' + t.icon + '</span>';
      return '<button class="mob-tab" id="mob-btn-' + t.tab + '" onclick="' + onclick + '"' +
             (t.fab ? ' style="position:relative"' : '') + '>' +
             iconEl + '<span style="font-size:9.5px;font-weight:600">' + t.label + '</span></button>';
    }).join('');
    document.body.appendChild(bar);
    mobSetActive('stock');
  }

  /* ── Dismiss sidebar on outside tap ───────────────────── */
  var _dismissAttached = false;
  function enableSidebarDismiss() {
    if(_dismissAttached) return;
    _dismissAttached = true;
    document.addEventListener('click', function(e) {
      if(!_active) return;
      var sb  = document.getElementById('appSidebar');
      var tog = document.getElementById('sidebarToggleBtn');
      if(!sb || sb.classList.contains('collapsed')) return;
      if(!sb.contains(e.target) && !(tog && tog.contains(e.target))) {
        // Use the global toggleSidebar so the existing _sidebarOpen state stays in sync
        if(typeof toggleSidebar === 'function') toggleSidebar();
      }
    });
  }
})();

/* Active state for bottom tab bar */
function mobSetActive(tabId) {
  document.querySelectorAll('#mob-tab-bar .mob-tab').forEach(function(b) {
    b.classList.remove('active');
  });
  var btn = document.getElementById('mob-btn-' + tabId);
  if(btn) btn.classList.add('active');
}
