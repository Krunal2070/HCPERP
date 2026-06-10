/* =========================================================================
   hcp-modals.js — Unified modal behavior for HCP Portal
   --------------------------------------------------------------------------
   Adds to EVERY modal background marked with class `hcp-modal-bg`:
     1. Disables background-click-to-close (user must use X / Esc / a button)
     2. Press Escape to close the topmost open modal
     3. Locks page scroll while any modal is open
     4. Aria-hides background content (page is "inert" to assistive tech)
     5. Auto-focuses the modal on open; returns focus on close
     6. Focus-trap: Tab and Shift+Tab stay inside the modal

   How it works
   ------------
   * Watches every element matching `.hcp-modal-bg` for the "is-open" state.
     A modal is considered open if it has one of these CSS classes:
         .show .open .iac-show
     OR its computed display style is not 'none'.
   * Uses a MutationObserver so it picks up class changes made by *any* code
     (jQuery, vanilla setters, etc.) — without needing those callers to be
     modified.
   * Stacks: if more than one modal is open, Esc closes only the topmost
     (the most recently opened one).

   How to opt a modal in
   ---------------------
   Just add the marker class `hcp-modal-bg` to the modal's outer background
   element (the dimmed full-screen wrapper). That's it. The script will
   handle the rest automatically on the next class change.

   Notes
   -----
   * The script REMOVES any existing `onclick="if(event.target===this)…"`
     attribute from each registered modal background, so the
     click-outside-to-close behavior is killed in one place.
   * Inputs inside modals continue to work normally — Esc still closes the
     modal even when an input is focused. This matches browser convention.
   ========================================================================= */
(function () {
  'use strict';
  if (window.__hcpModalsLoaded) return;
  window.__hcpModalsLoaded = true;

  var OPEN_CLASSES = ['show', 'open', 'iac-show'];

  // Stack of currently-open modal backgrounds (most-recent last)
  var stack = [];
  // Saved scroll position + body styles, so we can restore on close
  var savedBodyOverflow = null;
  var savedScrollY = 0;
  // The element that had focus before the *first* modal in the stack opened.
  var openerFocus = null;

  function isOpen(el) {
    if (!el) return false;
    for (var i = 0; i < OPEN_CLASSES.length; i++) {
      if (el.classList.contains(OPEN_CLASSES[i])) return true;
    }
    // Fallback: open if its computed display isn't 'none'
    try {
      var s = window.getComputedStyle(el);
      if (s && s.display !== 'none' && s.visibility !== 'hidden') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function focusableInside(modal) {
    if (!modal) return [];
    var sel = [
      'a[href]', 'area[href]', 'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])', 'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    var nodes = modal.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      // Skip elements that aren't actually visible
      if (n.offsetParent === null && n.tagName !== 'AREA') continue;
      out.push(n);
    }
    return out;
  }

  function topModal() {
    return stack.length ? stack[stack.length - 1] : null;
  }

  function tryClose(el) {
    if (!el) return;
    // 1) If the modal has a close button, click it (this fires the original close handler)
    var candidates = el.querySelectorAll(
      '[data-hcp-close], .dac-h .x, .iac-close, .mu-modal-h .x, .cu-modal-h .x, .hcp-settings-close, .modal-close'
    );
    if (candidates.length) {
      try { candidates[0].click(); return; } catch (e) { /* fall through */ }
    }
    // 2) Otherwise just remove the open classes
    for (var i = 0; i < OPEN_CLASSES.length; i++) {
      el.classList.remove(OPEN_CLASSES[i]);
    }
  }

  function lockBodyScroll() {
    if (savedBodyOverflow !== null) return;        // already locked
    savedBodyOverflow = document.body.style.overflow || '';
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.overflow = 'hidden';
  }

  function unlockBodyScroll() {
    if (savedBodyOverflow === null) return;
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = null;
  }

  function hideBackgroundFromAT(modal) {
    // Mark everything that ISN'T the modal as aria-hidden so screen-readers
    // ignore the page behind. Skip <script>, <style>, and the modal itself.
    var sibs = document.body.children;
    for (var i = 0; i < sibs.length; i++) {
      var n = sibs[i];
      if (n === modal) continue;
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
      if (n.contains(modal)) continue;
      // Don't disturb other open modals
      if (n.classList && n.classList.contains('hcp-modal-bg') && isOpen(n)) continue;
      if (!n.hasAttribute('data-hcp-prev-aria-hidden')) {
        n.setAttribute('data-hcp-prev-aria-hidden', n.getAttribute('aria-hidden') || '');
      }
      n.setAttribute('aria-hidden', 'true');
    }
  }

  function restoreBackgroundForAT() {
    var marked = document.querySelectorAll('[data-hcp-prev-aria-hidden]');
    for (var i = 0; i < marked.length; i++) {
      var prev = marked[i].getAttribute('data-hcp-prev-aria-hidden');
      if (prev) marked[i].setAttribute('aria-hidden', prev);
      else marked[i].removeAttribute('aria-hidden');
      marked[i].removeAttribute('data-hcp-prev-aria-hidden');
    }
  }

  function onModalOpened(el) {
    if (stack.indexOf(el) !== -1) return;          // already in stack
    if (stack.length === 0) {
      openerFocus = document.activeElement;
      lockBodyScroll();
    }
    stack.push(el);
    hideBackgroundFromAT(el);
    // Move focus inside the modal so Esc + keyboard nav work immediately.
    // Skip if focus is already inside (e.g. an input was auto-focused by the
    // page's own open code).
    try {
      if (!el.contains(document.activeElement)) {
        var nodes = focusableInside(el);
        // Prefer the first non-close-button, else first focusable, else the modal itself
        var target = null;
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (!n.classList.contains('x') && !n.classList.contains('iac-close')) { target = n; break; }
        }
        if (!target) target = nodes[0];
        if (target) target.focus({ preventScroll: true });
        else { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
      }
    } catch (e) { /* ignore */ }
  }

  function onModalClosed(el) {
    var idx = stack.indexOf(el);
    if (idx === -1) return;
    stack.splice(idx, 1);
    if (stack.length === 0) {
      unlockBodyScroll();
      restoreBackgroundForAT();
      // Return focus to whatever opened the modal
      try {
        if (openerFocus && document.contains(openerFocus) && typeof openerFocus.focus === 'function') {
          openerFocus.focus({ preventScroll: true });
        }
      } catch (e) { /* ignore */ }
      openerFocus = null;
    }
  }

  // Strip the inline `onclick="if(event.target===this)..."` attribute that
  // every existing modal has. This is the actual "no close on outside click"
  // behavior change.
  function stripBackgroundCloseHandler(el) {
    var oc = el.getAttribute('onclick') || '';
    if (oc.indexOf('event.target===this') !== -1 || oc.indexOf('event.target === this') !== -1) {
      el.removeAttribute('onclick');
      el.setAttribute('data-hcp-stripped', '1');
    }
    // Also stop clicks on the background from bubbling — defensive
    if (!el.__hcpClickBound) {
      el.addEventListener('click', function (e) {
        if (e.target === el) {
          // do nothing — background clicks are inert now
          e.stopPropagation();
        }
      });
      el.__hcpClickBound = true;
    }
  }

  function register(el) {
    if (!el || el.__hcpModalRegistered) return;
    el.__hcpModalRegistered = true;
    stripBackgroundCloseHandler(el);
    // Watch its class list for open/close transitions
    var lastOpen = isOpen(el);
    if (lastOpen) onModalOpened(el);
    var mo = new MutationObserver(function () {
      var now = isOpen(el);
      if (now === lastOpen) return;
      lastOpen = now;
      if (now) onModalOpened(el);
      else onModalClosed(el);
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    el.__hcpModalObserver = mo;
  }

  function registerAll() {
    var all = document.querySelectorAll('.hcp-modal-bg');
    for (var i = 0; i < all.length; i++) register(all[i]);
  }

  // Watch for modals being added to the DOM after page load
  var rootMo = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('hcp-modal-bg')) register(n);
        if (n.querySelectorAll) {
          var inner = n.querySelectorAll('.hcp-modal-bg');
          for (var k = 0; k < inner.length; k++) register(inner[k]);
        }
      }
    }
  });

  // ─── Escape key → close topmost modal ───────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    var top = topModal();
    if (!top) return;
    // Stop the event from interfering with anything else
    e.stopPropagation();
    e.preventDefault();
    tryClose(top);
  }, true);   // capture phase so we beat input handlers

  // ─── Focus-trap: keep Tab cycling inside the modal ──────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' && e.keyCode !== 9) return;
    var top = topModal();
    if (!top) return;
    var nodes = focusableInside(top);
    if (!nodes.length) { e.preventDefault(); top.focus({ preventScroll: true }); return; }
    var first = nodes[0], last = nodes[nodes.length - 1];
    var active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !top.contains(active)) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  }, true);

  // ─── Boot ───────────────────────────────────────────────────────────────
  function boot() {
    registerAll();
    rootMo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose a tiny debug surface
  window.HCPModals = {
    stack: function () { return stack.slice(); },
    closeTop: function () { var t = topModal(); if (t) tryClose(t); },
    registerAll: registerAll,
  };
})();
