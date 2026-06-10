/*
   inventory_mobile.js - Mobile bootstrap (RM)
   HCP Wellness - adapted from pm_stock_mobile.js

   - Detects mobile (touch UA OR window < 768px)
   - Adds .is-mobile body class so CSS/JS can branch
   - Builds a bottom tab bar for one-handed quick navigation
   - Dismisses the sidebar on outside-tap when it is open
   Mobile CSS is injected inline here; no external CSS file is fetched.

   Tabs route by matching RM sidebar nav items (.inv-nav-item) by text, the
   same robust approach used by the dock/palette.
*/
(function(){
  'use strict';

  function isMobile(){
    return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
        || window.innerWidth < 768;
  }

  var _active=false;

  function enableMobile(){
    if(_active) return;
    document.body.classList.add('is-mobile');
    _active=true;
    _injectCss();
    buildTabBar();
    enableSidebarDismiss();
  }
  function disableMobile(){
    if(!_active) return;
    document.body.classList.remove('is-mobile');
    _active=false;
    var bar=document.getElementById('inv-mob-tabbar'); if(bar) bar.remove();
  }
  function _hasAccess(){
    var a=window._invAccess;
    if(!a||!a.ready) return true;
    if(a.is_admin) return true;
    return a.access && a.access.mobile_view!=='off' && a.access.mobile_view!==false;
  }
  function check(){ (isMobile() && _hasAccess()) ? enableMobile() : disableMobile(); }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', check); else check();
  document.addEventListener('inv-access-ready', check);
  window.addEventListener('resize',(function(){ var t; return function(){ clearTimeout(t); t=setTimeout(check,200); }; })());

  /* ── Mobile CSS ──────────────────────────────────────────── */
  function _injectCss(){
    if(document.getElementById('inv-mob-css')) return;
    var st=document.createElement('style'); st.id='inv-mob-css';
    st.textContent = [
      '#inv-mob-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:6500;display:flex;align-items:flex-end;',
      'justify-content:space-around;background:var(--white,#fff);border-top:1px solid var(--border2,rgba(0,0,0,.12));',
      'box-shadow:0 -4px 14px rgba(0,0,0,.08);padding:6px 4px 8px;font-family:var(--font-body,inherit);',
      'padding-bottom:max(8px,env(safe-area-inset-bottom))}',
      '#inv-mob-tabbar .mob-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:3px;background:transparent;border:0;cursor:pointer;padding:6px 2px;color:var(--text2,#5F6368);min-height:48px;font-family:inherit}',
      '#inv-mob-tabbar .mob-tab.active{color:var(--blue,#1A73E8)}',
      '#inv-mob-tabbar .mob-tab.active .mob-tab-icon{transform:scale(1.08)}',
      '#inv-mob-tabbar .mob-tab:active{opacity:.55}',
      'body.is-mobile{padding-bottom:calc(78px + env(safe-area-inset-bottom))}',
      /* tighten layout on small screens */
      '@media (max-width:768px){',
      '  body.is-mobile .inv-toolbar{flex-direction:column;align-items:stretch}',
      '  body.is-mobile .inv-toolbar .search{max-width:none}',
      '  body.is-mobile #invDock{display:none!important}',  /* dock replaced by tab bar on mobile */
      '  body.is-mobile table.inv-table{font-size:12px}',

      /* ── MODALS (mobile) ─────────────────────────────────────────
         Scoped to body.is-mobile so desktop layout is untouched.
         Covers the standard .modal-overlay/.modal-card system plus the
         label-preview .lpm-* modal. Goals: use the full screen width,
         tighten the generous desktop padding, let the body scroll to a
         taller height, and stack footer buttons full-width so a row of
         actions never overflows a narrow phone. */
      /* Overlay: thin top gap, minimal sides, allow scroll. */
      '  body.is-mobile .modal-overlay{padding:12px 8px 80px !important;align-items:flex-start !important}',
      /* Card: fill the width regardless of md/lg/xl size class. */
      '  body.is-mobile .modal-card,',
      '  body.is-mobile .modal-card.md,',
      '  body.is-mobile .modal-card.lg{max-width:100% !important;width:100% !important;border-radius:14px}',
      /* Full-screen (xl / inline 96vw) cards: edge-to-edge. */
      '  body.is-mobile .modal-card.xl{max-width:100vw !important;width:100vw !important;border-radius:0}',
      /* Tighten the head / body / foot horizontal padding. */
      '  body.is-mobile .modal-head{padding:14px 16px}',
      '  body.is-mobile .modal-body{padding:16px;max-height:calc(100vh - 150px)}',
      '  body.is-mobile .modal-foot{padding:12px 16px}',
      '  body.is-mobile .modal-title{font-size:15px}',
      /* Footer: stack actions full-width; reverse so the primary action
         (usually last in source order) lands on top, under the thumb. */
      '  body.is-mobile .modal-foot{flex-direction:column-reverse;align-items:stretch;gap:8px}',
      '  body.is-mobile .modal-foot > button,',
      '  body.is-mobile .modal-foot > .btn,',
      '  body.is-mobile .modal-foot > a{width:100%;justify-content:center;text-align:center}',
      /* Form grids inside modals collapse to a single column. */
      '  body.is-mobile .modal-card .form-grid,',
      '  body.is-mobile .modal-card .form-grid.cols-2,',
      '  body.is-mobile .modal-card .form-grid.cols-3{grid-template-columns:1fr !important}',
      /* Label-preview modal: full-width, taller. */
      '  body.is-mobile .lpm-modal{width:96vw !important;max-width:96vw !important;max-height:90vh}',
      '}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ── Bottom tab bar ─────────────────────────────────────── */
  function _navClick(matchText){
    var items=document.querySelectorAll('.inv-nav-item');
    for(var i=0;i<items.length;i++){
      if((items[i].textContent||'').trim().toLowerCase().indexOf(matchText.toLowerCase())>-1){ items[i].click(); return true; }
    }
    return false;
  }
  function _toggleSidebar(){
    // RM uses a hamburger; try the common toggles.
    if(typeof window.toggleSidebar==='function'){ window.toggleSidebar(); return; }
    var ham=document.querySelector('.inv-hamburger, #sidebarToggleBtn, [onclick*="Sidebar"], .menu-toggle');
    if(ham) ham.click();
  }

  function buildTabBar(){
    if(document.getElementById('inv-mob-tabbar')) return;
    var tabs=[
      { id:'items', icon:'📦', label:'Items',    fn:function(){ _navClick('Items'); mobSetActive('items'); } },
      { id:'grn',   icon:'📋', label:'GRN',      fn:function(){ _navClick('Goods Receipt'); mobSetActive('grn'); } },
      { id:'new',   icon:'➕', label:'New',  fab:true, fn:function(){ _navClick('Goods Receipt'); setTimeout(function(){ if(window.invGrnOpenForm) window.invGrnOpenForm(null); },250); } },
      { id:'move',  icon:'🔄', label:'Move',     fn:function(){ _navClick('Stock Transfers'); mobSetActive('move'); } },
      { id:'menu',  icon:'☰',  label:'Menu',     fn:function(){ _toggleSidebar(); } },
    ];
    var bar=document.createElement('nav'); bar.id='inv-mob-tabbar';
    tabs.forEach(function(t){
      var btn=document.createElement('button');
      btn.className='mob-tab'; btn.id='inv-mob-'+t.id;
      var icon = t.fab
        ? '<span class="mob-tab-icon" style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;background:linear-gradient(180deg,#4648D4,#383AC0);border-radius:50%;font-size:22px;color:#fff;box-shadow:0 3px 12px rgba(70,72,212,.4);margin-top:-18px">'+t.icon+'</span>'
        : '<span class="mob-tab-icon" style="font-size:19px;line-height:1;transition:transform .15s">'+t.icon+'</span>';
      btn.innerHTML=icon+'<span style="font-size:9.5px;font-weight:600">'+t.label+'</span>';
      if(t.fab) btn.style.position='relative';
      btn.addEventListener('click', t.fn);
      bar.appendChild(btn);
    });
    document.body.appendChild(bar);
    mobSetActive('items');
  }

  /* ── Dismiss sidebar on outside tap ─────────────────────── */
  var _dismissAttached=false;
  function enableSidebarDismiss(){
    if(_dismissAttached) return;
    _dismissAttached=true;
    document.addEventListener('click', function(e){
      if(!_active) return;
      var sb=document.querySelector('.inv-sidebar, #appSidebar, .sidebar');
      if(!sb) return;
      var openCls = sb.classList.contains('open') || sb.classList.contains('show') || !sb.classList.contains('collapsed');
      // Only dismiss if visibly open AND tap is outside it (and not the hamburger)
      var ham=document.querySelector('.inv-hamburger, #sidebarToggleBtn, .menu-toggle');
      if(sb.classList.contains('open') || sb.classList.contains('show')){
        if(!sb.contains(e.target) && !(ham && ham.contains(e.target))) _toggleSidebar();
      }
    });
  }

  window.mobSetActive=function(id){
    var bar=document.getElementById('inv-mob-tabbar'); if(!bar) return;
    bar.querySelectorAll('.mob-tab').forEach(function(b){ b.classList.remove('active'); });
    var btn=document.getElementById('inv-mob-'+id); if(btn) btn.classList.add('active');
  };

  console.log('inventory_mobile.js loaded');
})();
