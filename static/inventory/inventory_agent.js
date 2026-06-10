/* ═══════════════════════════════════════════════════════════════════════
   inventory_agent.js
   ───────────────────────────────────────────────────────────────────────
   Lightweight reminder agent for the inventory module. Polls
   /api/inventory_mgmt/agent/pending periodically and surfaces pending
   tasks via a top-right toast that auto-dismisses in 5 seconds.

   Cadence
   ───────
     • First check: 10 seconds after page ready (gives panels time to
       finish loading their own data — don't double up with their toasts).
     • Subsequent checks: every 90 minutes (so a user in for an 8-hour
       shift gets at most 5–6 reminders — matching the "~5 times a day"
       brief).
     • If pending count is 0, no toast — quiet wins.
     • Session-level dedup: same digest of {type→count} won't toast more
       than once. If the state CHANGES (count goes up, or new type
       appears) the toast fires again so the user notices the change.

   Toast UX
   ────────
     • Top-right corner of the viewport, fixed position.
     • One toast per check, listing 1–3 most important pending items.
     • Auto-dismisses after 5 seconds with a fade.
     • Click toast → dismiss immediately. (No navigation by default —
       this is a reminder, not a launchpad.)
     • Opted out of the inventory_modal_guard with data-modal-guard='off'
       (toasts aren't modals — they shouldn't trap focus or block clicks).

   Endpoint
   ────────
     GET /api/inventory_mgmt/agent/pending
       → { status, pending: [{type, count, message}, …], checked_at, config }
═══════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const API           = '/api/inventory_mgmt/agent/pending';
  const FIRST_DELAY   = 10 * 1000;          // 10 s after boot
  const INTERVAL_MS   = 90 * 60 * 1000;     // 90 min between checks
  const TOAST_TTL_MS  = 5 * 1000;           // 5-second toast lifetime
  const MAX_ITEMS     = 3;                  // most-important N shown

  // Priority ordering — items higher up are more time-sensitive.
  const TYPE_PRIORITY = {
    'expiry':      0,
    'in_transit':  1,
    'mr_pending':  2,
    'below_msl':   3,
    'audit_stale': 4,
  };

  // Friendly icon per type for the toast row.
  const TYPE_ICON = {
    'expiry':      '⏳',
    'below_msl':   '⚠️',
    'mr_pending':  '📥',
    'in_transit':  '🚚',
    'audit_stale': '🔎',
  };

  // Session state — survives panel switches but resets on page reload.
  let _timer       = null;
  let _lastDigest  = '';   // signature of the last pending payload we toasted
  let _toastEl     = null;
  let _toastHide   = null;

  /* ── Digest of pending payload — for session-dedup ──────────────── */
  function _digest(pending){
    if(!pending || !pending.length) return 'empty';
    return pending
      .slice()
      .sort((a, b) => a.type.localeCompare(b.type))
      .map(p => p.type + ':' + p.count)
      .join('|');
  }

  /* ── Build & show the toast ──────────────────────────────────────── */
  function _ensureToastRoot(){
    if(_toastEl) return _toastEl;
    const el = document.createElement('div');
    el.id = 'invAgentToast';
    // Opt OUT of modal_guard — this is a transient corner toast, not a modal.
    el.setAttribute('data-modal-guard', 'off');
    el.style.cssText = [
      'position:fixed',
      'top:20px',
      'right:20px',
      'z-index:10500',
      'max-width:360px',
      'min-width:280px',
      'padding:0',
      'background:#fff',
      'border:1px solid rgba(70,72,212,.18)',
      'border-left:4px solid var(--brand,#4648D4)',
      'border-radius:10px',
      'box-shadow:0 10px 30px rgba(15,23,42,.18)',
      'font-family:inherit',
      'cursor:pointer',
      'opacity:0',
      'transform:translateX(20px)',
      'transition:opacity .25s ease, transform .25s ease',
      'pointer-events:auto',
    ].join(';');
    el.addEventListener('click', _dismissNow);
    document.body.appendChild(el);
    _toastEl = el;
    return el;
  }

  function _showToast(pending){
    const el = _ensureToastRoot();

    // Sort by priority, take top N.
    const items = pending
      .slice()
      .sort((a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99))
      .slice(0, MAX_ITEMS);
    const extra = pending.length - items.length;

    const rows = items.map(p => {
      const icon = TYPE_ICON[p.type] || '•';
      return ''
        + '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0">'
        +   '<div style="font-size:14px;line-height:1.2;flex-shrink:0">' + icon + '</div>'
        +   '<div style="flex:1;font-size:12.5px;color:var(--text,#111);line-height:1.35">'
        +     _escapeHtml(p.message)
        +   '</div>'
        + '</div>';
    }).join('');

    const moreLine = extra > 0
      ? '<div style="margin-top:4px;font-size:11px;color:var(--muted,#6b7280);font-style:italic">'
        + '+ ' + extra + ' more'
        + '</div>'
      : '';

    el.innerHTML =
        '<div style="padding:12px 14px 10px 14px">'
      +   '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
      +     '<span style="font-size:11px;font-weight:800;letter-spacing:.5px;'
      +                  'color:var(--brand,#4648D4);text-transform:uppercase">'
      +       'Pending tasks'
      +     '</span>'
      +     '<span style="margin-left:auto;font-size:10px;color:var(--muted,#9ca3af)">'
      +       _now()
      +     '</span>'
      +   '</div>'
      +    rows
      +    moreLine
      + '</div>';

    // Animate in
    requestAnimationFrame(() => {
      el.style.opacity   = '1';
      el.style.transform = 'translateX(0)';
    });

    // Schedule auto-dismiss
    clearTimeout(_toastHide);
    _toastHide = setTimeout(_dismissNow, TOAST_TTL_MS);
  }

  function _dismissNow(){
    if(!_toastEl) return;
    clearTimeout(_toastHide);
    _toastEl.style.opacity   = '0';
    _toastEl.style.transform = 'translateX(20px)';
    setTimeout(() => {
      if(_toastEl && _toastEl.parentNode){
        _toastEl.parentNode.removeChild(_toastEl);
        _toastEl = null;
      }
    }, 250);
  }

  function _escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function _now(){
    const d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':'
         + d.getMinutes().toString().padStart(2,'0');
  }

  /* ── Poll the backend ────────────────────────────────────────────── */
  async function _check(){
    try {
      const r = await fetch(API, { credentials: 'same-origin' });
      if(!r.ok) return;  // 401, 500 — silently skip
      const d = await r.json();
      if(d.status !== 'ok') return;
      const pending = Array.isArray(d.pending) ? d.pending : [];
      if(!pending.length){
        // Nothing pending — don't toast, but DO update digest so a later
        // "nothing→something" transition triggers a toast.
        _lastDigest = 'empty';
        return;
      }
      const digest = _digest(pending);
      if(digest === _lastDigest){
        // Same state as last time — user already saw it this session.
        return;
      }
      _lastDigest = digest;
      _showToast(pending);
    } catch(e){
      // Network/parse errors silently ignored — agent is best-effort.
    }
  }

  /* ── Boot ─────────────────────────────────────────────────────────── */
  function _boot(){
    if(_timer) return;
    // Access gate: respect the pending_tasks_toast permission. Admins
    // always pass. If access hasn't loaded yet, defer; the
    // 'inv-access-ready' event below will re-boot once it has.
    const acc = window._invAccess;
    if(acc && acc.ready){
      const isAdmin = !!acc.is_admin;
      const allowed = isAdmin || (acc.access && acc.access.pending_tasks_toast !== 'off'
                                              && acc.access.pending_tasks_toast !== false);
      if(!allowed){
        console.log('ℹ️ inventory_agent.js disabled — no pending_tasks_toast access');
        return;
      }
    }
    // First check after FIRST_DELAY so we don't fight with page-load
    // toasts coming from other modules.
    setTimeout(_check, FIRST_DELAY);
    _timer = setInterval(_check, INTERVAL_MS);
    console.log('✅ inventory_agent.js armed — pending-task reminders every '
                + Math.round(INTERVAL_MS / 60000) + ' min');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }
  // Re-attempt boot after access loads (covers the race where agent.js
  // runs before user_access.js has fetched the user's permissions).
  document.addEventListener('inv-access-ready', _boot);

  // Small public API for manual trigger / testing.
  window.invAgent = {
    checkNow:    _check,
    dismissNow:  _dismissNow,
    _state: () => ({ lastDigest: _lastDigest, timer: !!_timer }),
  };
})();
