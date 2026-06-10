/* ════════════════════════════════════════════════════════════════════════
   pm_stock_inline_boot.js
   Extracted from pm_stock.html inline <script> blocks for maintainability.
   Each section below was previously a standalone inline block; concatenated
   here in original order so initialization sequencing is preserved.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Was inline block 1: Force light theme + embed param detection ── */
(function(){
  // Force light theme on this page — ignore any stored dark/other themes
  document.documentElement.setAttribute('data-theme','light');

    // Detect whether the page was loaded inside an iframe modal (?embed=1).
    // Without this, the Escape relay below threw "embed is not defined".
    const _embedParam = new URLSearchParams(window.location.search).get('embed');
    const embed = _embedParam || '0';

    // Relay Escape key to parent so it can close the iframe modal
    window.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && embed === '1'){
        // Only relay if no open modal on THIS page (let local close run first)
        const hasOpen = document.querySelector('.modal-overlay.open');
        if(!hasOpen){
          // notifyParent helper may not be defined — guard it
          if(typeof notifyParent === 'function') notifyParent('escape', {});
        }
      }
    });
})();

/* ── Was inline block 9: Auto-open URL params ── */
(function(){
  const q = new URLSearchParams(location.search);
  const auto = q.get('auto'); const embed = q.get('embed');
  if(!auto) return;

  if(embed === '1'){
    const css = document.createElement('style');
    css.textContent = `
      header, .sidebar, .topbar, .nav, .navbar, #sidebar, .page-nav,
      .app-header, .main-header, .breadcrumbs, .footer, footer { display:none !important; }
      body { background: transparent !important; padding: 0 !important; margin: 0 !important; }
      .main-content, main, .content-wrap, .page-wrap { margin:0 !important; padding:0 !important; max-width:100% !important; }
      .modal-overlay.open { background: transparent !important; }
    `;
    document.head.appendChild(css);
  }

  function notifyParent(type, payload){
    try{ parent.postMessage({source:'inventory-iframe', type, payload}, '*'); }catch(e){}
  }

  function wireSaveDetection(){
    const origFetch = window.fetch;
    window.fetch = async function(...args){
      const res = await origFetch.apply(this, args);
      try{
        const url = (args[0] && args[0].url) || args[0];
        if(typeof url === 'string' && /\/api\/pm_stock\/(add_product|update_product)/.test(url)){
          const clone = res.clone();
          clone.json().then(data => {
            if(data && (data.status === 'ok' || data.success === true)){
              notifyParent('saved', {url, data});
            }
          }).catch(()=>{});
        }
      }catch(e){}
      return res;
    };
  }

  function ready(cb){
    if(document.readyState === 'complete' || document.readyState === 'interactive'){
      setTimeout(cb, 200);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(cb, 200));
    }
  }

  ready(function(){
    wireSaveDetection();
    // Wait for page to load products so edit-by-id finds it
    const trigger = function(attempts){
      if(auto === 'new-item'){
        if(typeof openAddProductModal === 'function'){ openAddProductModal(); return; }
      } else if(auto === 'edit'){
        const id = parseInt(q.get('id') || '0');
        if(typeof openEditProduct === 'function' && id){ openEditProduct(id); return; }
      }
      if(attempts > 0) setTimeout(() => trigger(attempts-1), 400);
    };
    trigger(12);
  });
})();

/* ── Was inline block 10: Sidebar width drag-resize ── */
(function(){
  'use strict';
  const MIN_W = 200, MAX_W = 420, DEFAULT_W = 260;
  const STORAGE_KEY = 'pm.sidebarWidth';
  const root = document.documentElement;

  function applyWidth(w){
    const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
    root.style.setProperty('--sw', clamped + 'px');
    return clamped;
  }

  // Restore saved width on load. Mobile (≤768px) uses the drawer behaviour
  // defined in the CSS @media block above and ignores the persisted width.
  function isMobile(){ return window.matchMedia('(max-width: 768px)').matches; }

  function init(){
    if(isMobile()) return;
    let saved = null;
    try { saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10); }
    catch(_){ saved = null; }
    if(saved && !isNaN(saved)) applyWidth(saved);
  }

  // Drag logic. Uses pointer events so it works the same way for mouse
  // and pen/touch on devices that emulate pointers (e.g. Surface laptops
  // and Chrome on Android-tablet desktops). On phones the handle is
  // hidden via the mobile CSS, so we don't need a separate touch path.
  function startDrag(handle){
    let dragging = false;
    let startX   = 0;
    let startW   = 0;

    handle.addEventListener('pointerdown', (e) => {
      if(isMobile()) return;
      // Left button only (button === 0 for primary mouse / pen / touch)
      if(e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      // Read the current --sw value as the drag's starting width.
      const cs = getComputedStyle(root).getPropertyValue('--sw').trim();
      const px = parseInt(cs, 10);
      startW = (!isNaN(px) && px > 0) ? px : DEFAULT_W;
      document.body.classList.add('sb-resizing');
      // Capture so we keep getting move events even if the pointer
      // strays off the handle during the drag.
      try { handle.setPointerCapture(e.pointerId); } catch(_){}
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if(!dragging) return;
      const dx = e.clientX - startX;
      applyWidth(startW + dx);
    });

    function endDrag(e){
      if(!dragging) return;
      dragging = false;
      document.body.classList.remove('sb-resizing');
      try { handle.releasePointerCapture(e.pointerId); } catch(_){}
      // Persist the final width.
      const cs = getComputedStyle(root).getPropertyValue('--sw').trim();
      const px = parseInt(cs, 10);
      if(!isNaN(px) && px > 0){
        try { localStorage.setItem(STORAGE_KEY, String(px)); } catch(_){}
      }
    }
    handle.addEventListener('pointerup',     endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);

    // Double-click → reset to default width.
    handle.addEventListener('dblclick', () => {
      if(isMobile()) return;
      applyWidth(DEFAULT_W);
      try { localStorage.setItem(STORAGE_KEY, String(DEFAULT_W)); } catch(_){}
    });
  }

  function ready(){
    init();
    const handle = document.getElementById('sbResizeHandle');
    if(handle) startDrag(handle);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }

  // If the viewport crosses the mobile threshold during the session,
  // re-apply the saved width when transitioning back to desktop. (No
  // need to clear it on the way to mobile — the @media rule overrides.)
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if(wasMobile && !nowMobile){
      // Switched back to desktop — restore saved width
      let saved = null;
      try { saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10); }
      catch(_){}
      if(saved && !isNaN(saved)) applyWidth(saved);
    }
    wasMobile = nowMobile;
  });
})();

