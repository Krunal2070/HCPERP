/*
   inventory_nav_access.js — Compatibility shim (May 2026)
   ─────────────────────────────────────────────────────────────────
   HCP Wellness · HCP Inventory

   This file used to gate static nav items via the `data-cat` attribute,
   but the actual template uses `data-cap` — so the old code queried for
   zero elements and did nothing useful.

   As part of the May-2026 User-Access-Control redesign the canonical
   gating implementation lives inline inside inventory_mgmt.html (the
   IIFE that defines window.invHasAccess and window.invApplyAccessGating).
   That implementation handles every nav item correctly via `data-cap`.

   This file is retained as a no-op so any deployment that still
   references it via <script src="inventory_nav_access.js"> doesn't 404.
   It also re-exports invApplyAccessGating under the historical name
   invNavAccessApply so external callers don't break.

   To remove permanently: delete the <script> tag in app.py or the
   relevant template, then delete this file.
*/
(function(){
  'use strict';

  // Re-export under the legacy name. invApplyAccessGating is defined in
  // inventory_mgmt.html and may not yet be available at this script's
  // execution time, so resolve lazily.
  window.invNavAccessApply = function(){
    if (typeof window.invApplyAccessGating === 'function'){
      window.invApplyAccessGating();
    }
  };

  // If the canonical gating hasn't run yet for any reason, schedule a
  // retry so anything depending on the legacy hook still works.
  if (typeof window.invApplyAccessGating !== 'function'){
    document.addEventListener('DOMContentLoaded', function(){
      if (typeof window.invApplyAccessGating === 'function'){
        window.invApplyAccessGating();
      }
    });
  }

  console.log('inventory_nav_access.js loaded (compat shim — no-op)');
})();
