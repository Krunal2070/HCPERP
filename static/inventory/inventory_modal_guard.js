/* ═══════════════════════════════════════════════════════════════════════
   inventory_modal_guard.js
   ───────────────────────────────────────────────────────────────────────
   Inventory-wide modal behavior enforcement. Loaded once, applies three
   rules to every fixed-position modal scrim in the inventory module:

     1. BACKDROP-CLICK BLOCKED — clicking the dark area around a modal
        does NOT dismiss it. Modals only close via explicit ×/Close/Cancel
        buttons (or the Escape key, which we leave intact for accessibility).

     2. FOCUS TRAP — while a modal is open, Tab / Shift+Tab cycle only
        within the modal. Focus cannot escape to background elements.

     3. DRAGGABLE — click-and-hold anywhere on the modal's header strip
        (or on an element with [data-modal-drag]) lets the user drag the
        modal anywhere on screen. While dragging, the rest of the page
        remains inert (handled by the scrim).

   WHY A MUTATION OBSERVER
   ───────────────────────
   The inventory module has dozens of modals across many files, each
   built differently. Rather than patch every modal definition, this
   file watches the DOM, detects new modal-shaped overlays, and applies
   the three rules automatically. New modals get the behavior for free.

   OPT-OUT
   ───────
   An element can declare itself NOT a modal with:
       <div data-modal-guard="off">…</div>
   This is for toasts, popovers, dropdowns, the command palette, etc. —
   anything fixed-position that shouldn't be treated as a blocking modal.

   DETECTION HEURISTIC
   ───────────────────
   An element is a "modal scrim" when ALL of these are true:
     • position: fixed
     • Covers most of the viewport (top<=20px, left<=20px,
                                    right<=20px, bottom<=20px from edges)
     • display !== 'none' AND not visibility:hidden
     • Does not opt out via data-modal-guard='off'
     • Has at least one child element (the modal box)

   This heuristic intentionally excludes small fixed elements like
   toasts and floating action buttons.
═══════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // ── Per-scrim state record ──────────────────────────────────────────
  // We tag each scrim element with a property holding its guard state so
  // we know which listeners to remove when the modal closes.
  const STATE_KEY = '__invModalGuard';

  // Stack of currently-open guarded modals, oldest at index 0, topmost
  // at the end. Used so when modals stack, only the topmost traps focus
  // — otherwise multiple traps would steal focus from each other.
  const modalStack = [];

  function topmostModal(){
    return modalStack.length ? modalStack[modalStack.length - 1] : null;
  }

  /* ── HEURISTIC: is this element a modal scrim? ──────────────────── */
  function isModalScrim(el){
    if(!el || el.nodeType !== 1) return false;
    if(el.getAttribute('data-modal-guard') === 'off') return false;
    const cs = getComputedStyle(el);
    if(cs.position !== 'fixed') return false;
    if(cs.display === 'none' || cs.visibility === 'hidden') return false;
    // Approximate full-viewport coverage. We allow a small slack so a
    // modal with `padding:50px 20px 20px` (like the FEFO popup) still
    // qualifies — the SCRIM is full-viewport even if the inner box is
    // padded inwards.
    const r = el.getBoundingClientRect();
    if(r.width  < window.innerWidth  * 0.6) return false;
    if(r.height < window.innerHeight * 0.6) return false;
    if(r.top    > 60) return false;
    if(r.left   > 60) return false;
    // Must have at least one child container (the modal box).
    if(!el.firstElementChild) return false;
    return true;
  }

  /* ── ATTACH guard behaviors to a scrim ───────────────────────────── */
  function attach(scrim){
    if(scrim[STATE_KEY]) return;  // already guarded
    const box = scrim.firstElementChild;  // the inner modal box
    if(!box) return;

    const state = {
      scrim, box,
      handlers: [],   // [{target, type, fn, opts}]
      // Save anything we mutate so we can restore on detach.
      prevBoxTransform: box.style.transform,
      prevBoxPosition:  box.style.position,
      prevBoxLeft:      box.style.left,
      prevBoxTop:       box.style.top,
      dragOffset:       null,   // {dx, dy} during a drag
    };

    /* 1) BACKDROP-CLICK BLOCKED ──────────────────────────────────────
       Capture-phase listeners run before the modal's own handlers, so
       even if the modal had its own backdrop-close logic, we stop the
       event from reaching it. */
    const blockBackdrop = (ev) => {
      // Only swallow events that targeted the scrim itself (the dark
      // area). Clicks INSIDE the box (target = box or its descendant)
      // pass through normally — that's how OK / Cancel / × keep working.
      if(ev.target === scrim){
        ev.stopPropagation();
        ev.preventDefault();
      }
    };
    // mousedown AND click — some modals close on either; cover both.
    scrim.addEventListener('mousedown', blockBackdrop, true);
    scrim.addEventListener('click',     blockBackdrop, true);
    state.handlers.push(
      {target: scrim, type: 'mousedown', fn: blockBackdrop, opts: true},
      {target: scrim, type: 'click',     fn: blockBackdrop, opts: true},
    );

    /* 2) FOCUS TRAP ──────────────────────────────────────────────────
       Tab / Shift+Tab cycle through focusable elements within the box.
       At the ends, wrap around. We use the capture phase so we beat any
       global Tab handlers the page might have. */
    const focusableSelector = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled])',
      'select:not([disabled])', 'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const trapTab = (ev) => {
      if(ev.key !== 'Tab') return;
      // Only the topmost open modal traps focus. If another modal opened
      // on top of this one (stacked), defer to it. This avoids ping-pong
      // refocusing between competing traps.
      if(topmostModal() !== scrim) return;
      const focusables = Array.from(box.querySelectorAll(focusableSelector))
        .filter(el => {
          // Filter out invisible focusables (e.g. inside display:none subtrees).
          if(el.disabled) return false;
          const fs = getComputedStyle(el);
          if(fs.display === 'none' || fs.visibility === 'hidden') return false;
          return el.offsetParent !== null || fs.position === 'fixed';
        });
      if(!focusables.length){
        // Nothing focusable — at least keep focus on the box so Tab
        // doesn't escape outside the modal.
        ev.preventDefault();
        box.focus && box.focus();
        return;
      }
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      const active = document.activeElement;
      if(ev.shiftKey){
        if(active === first || !box.contains(active)){
          ev.preventDefault();
          last.focus();
        }
      } else {
        if(active === last || !box.contains(active)){
          ev.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', trapTab, true);
    state.handlers.push({target: document, type: 'keydown', fn: trapTab, opts: true});

    // Make box itself focusable (for the no-focusables fallback above).
    if(!box.hasAttribute('tabindex')){
      box.setAttribute('tabindex', '-1');
      state._addedTabindex = true;
    }

    /* 3) DRAGGABLE ──────────────────────────────────────────────────
       Find the "header" — the strip the user grabs to drag. Preference:
         a) element marked [data-modal-drag]
         b) box's first child if it contains text and is not a form input
         c) box itself (fall back)
       We do NOT make form inputs / buttons / textareas draggable — only
       the bare header strip. Clicking an input must focus it, not drag. */
    let header = box.querySelector('[data-modal-drag]');
    if(!header){
      // Take the first element child of the box — typically the header
      // strip with the title and × button.
      header = box.firstElementChild;
    }
    if(!header) header = box;

    // Mark the header visually as draggable. We use cursor:move on the
    // header but a data-attr lets a global CSS rule override the cursor
    // back to normal on interactive children (buttons, inputs, etc.).
    header.style.cursor = 'move';
    header.style.userSelect = 'none';
    header.setAttribute('data-inv-modal-header', '');
    state._headerHadAttr = false;  // we added it just now

    // Position the box absolutely-within-scrim so we can move it freely.
    // We capture the box's CURRENT visual position first, then switch to
    // explicit left/top so transforms don't fight us.
    function ensurePositioned(){
      if(box.style.position && box.style.left) return;
      const r = box.getBoundingClientRect();
      const sr = scrim.getBoundingClientRect();
      box.style.position = 'absolute';
      box.style.left = (r.left - sr.left) + 'px';
      box.style.top  = (r.top  - sr.top)  + 'px';
      box.style.margin = '0';
    }

    const onDragStart = (ev) => {
      // Don't start a drag from interactive controls — buttons, inputs,
      // selects, textareas, anchors. The user expects clicking those to
      // do their normal job.
      const t = ev.target;
      if(!t || !(t instanceof Element)) return;
      if(t.closest('button, input, select, textarea, a, [contenteditable]')) return;
      if(ev.button !== 0) return;  // only left mouse button

      ensurePositioned();
      const r = box.getBoundingClientRect();
      state.dragOffset = {
        dx: ev.clientX - r.left,
        dy: ev.clientY - r.top,
      };
      // Visual feedback during drag
      box.style.transition = 'none';
      document.body.style.userSelect = 'none';
      ev.preventDefault();
    };
    const onDragMove = (ev) => {
      if(!state.dragOffset) return;
      const sr = scrim.getBoundingClientRect();
      const r  = box.getBoundingClientRect();
      let nx = ev.clientX - state.dragOffset.dx - sr.left;
      let ny = ev.clientY - state.dragOffset.dy - sr.top;
      // Keep at least 40px of the modal on screen so it can't be lost.
      const minX = -r.width + 80;
      const minY = 0;
      const maxX = window.innerWidth  - 80;
      const maxY = window.innerHeight - 40;
      nx = Math.max(minX, Math.min(maxX, nx));
      ny = Math.max(minY, Math.min(maxY, ny));
      box.style.left = nx + 'px';
      box.style.top  = ny + 'px';
    };
    const onDragEnd = () => {
      if(!state.dragOffset) return;
      state.dragOffset = null;
      document.body.style.userSelect = '';
      box.style.transition = '';
    };

    header.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup',   onDragEnd);
    state.handlers.push(
      {target: header,   type: 'mousedown', fn: onDragStart},
      {target: document, type: 'mousemove', fn: onDragMove},
      {target: document, type: 'mouseup',   fn: onDragEnd},
    );
    state._headerEl = header;
    state._prevHeaderCursor    = header.style.cursor;
    state._prevHeaderUserSel   = header.style.userSelect;

    /* ── FOCUS the modal's first focusable so keyboard users start
          inside the modal, not somewhere on the page behind it. ──── */
    setTimeout(() => {
      const first = box.querySelector(focusableSelector);
      if(first && !box.contains(document.activeElement)){
        try { first.focus(); } catch(e) {}
      }
    }, 0);

    scrim[STATE_KEY] = state;
    modalStack.push(scrim);
  }

  /* ── DETACH all guard behaviors when modal closes ──────────────── */
  function detach(scrim){
    const state = scrim[STATE_KEY];
    if(!state) return;
    state.handlers.forEach(h => {
      try { h.target.removeEventListener(h.type, h.fn, h.opts); } catch(e) {}
    });
    // Restore mutated styles on the box.
    state.box.style.transform = state.prevBoxTransform || '';
    state.box.style.position  = state.prevBoxPosition  || '';
    state.box.style.left      = state.prevBoxLeft      || '';
    state.box.style.top       = state.prevBoxTop       || '';
    if(state._addedTabindex){
      state.box.removeAttribute('tabindex');
    }
    if(state._headerEl){
      state._headerEl.style.cursor     = state._prevHeaderCursor || '';
      state._headerEl.style.userSelect = state._prevHeaderUserSel || '';
      state._headerEl.removeAttribute('data-inv-modal-header');
    }
    delete scrim[STATE_KEY];
    const idx = modalStack.indexOf(scrim);
    if(idx !== -1) modalStack.splice(idx, 1);
  }

  /* ── DOM OBSERVER ─────────────────────────────────────────────────
     Watches for two things:
       a) New elements added to the DOM that match isModalScrim().
       b) Existing fixed elements whose `display` becomes 'flex'/'block'
          (the common "show modal" pattern is `.style.display='flex'`).
     For (b) we use a polling sweep on mutations since CSS-property
     changes don't fire mutation events. The performance cost is tiny
     because we only sweep when SOME mutation fires AND the candidate
     set is small (we only revisit elements we already know about). */
  const candidateScrims = new Set();  // elements we've seen at least once

  function consider(el){
    if(!el || el.nodeType !== 1) return;
    // Stop traversal at common non-modal containers.
    if(el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    // Add to candidate set if it might be a modal scrim later.
    const cs = getComputedStyle(el);
    if(cs.position === 'fixed' && el.getAttribute('data-modal-guard') !== 'off'){
      candidateScrims.add(el);
    }
    // Descend into children — a scrim might be appended deep, not at root.
    for(const child of el.children){
      consider(child);
    }
  }

  function sweep(){
    for(const el of candidateScrims){
      if(!document.body.contains(el)){
        // Element removed from DOM — clean up if guarded.
        if(el[STATE_KEY]) detach(el);
        candidateScrims.delete(el);
        continue;
      }
      const open = isModalScrim(el);
      const guarded = !!el[STATE_KEY];
      if(open && !guarded){
        attach(el);
      } else if(!open && guarded){
        detach(el);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    // Track new fixed-position elements.
    for(const m of mutations){
      m.addedNodes && m.addedNodes.forEach(n => consider(n));
    }
    // Also sweep on any style/attribute change of known candidates so we
    // catch `.style.display = 'flex'` toggling existing modals open.
    sweep();
  });

  function boot(){
    // Inject a style rule that prevents cursor:move on the modal header
    // from bleeding into interactive children (buttons, inputs, etc.) —
    // those should keep their normal cursor for affordance reasons.
    if(!document.getElementById('inv-modal-guard-style')){
      const st = document.createElement('style');
      st.id = 'inv-modal-guard-style';
      st.textContent = (
        '[data-inv-modal-header] button,'
      + '[data-inv-modal-header] input,'
      + '[data-inv-modal-header] select,'
      + '[data-inv-modal-header] textarea,'
      + '[data-inv-modal-header] a,'
      + '[data-inv-modal-header] [contenteditable] {'
      +   'cursor: auto;'
      + '}'
      + '[data-inv-modal-header] button { cursor: pointer; }'
      );
      document.head.appendChild(st);
    }
    // Initial scan of the existing DOM.
    consider(document.body);
    sweep();
    observer.observe(document.body, {
      childList: true,
      subtree:   true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });
    console.log('✅ inventory_modal_guard.js armed — backdrop-block, focus-trap, draggable');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────
     For modules that want to manually trigger a sweep right after
     they've shown/hidden a modal (rarely needed — the observer is
     usually fast enough). */
  window.invModalGuard = {
    refresh: sweep,
    attach,
    detach,
  };
})();
