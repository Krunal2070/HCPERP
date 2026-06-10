/**
 * inventory_fefo_global.js
 * ─────────────────────────────────────────────────────────────────────
 * Global FEFO on/off switch — client side.
 *
 * Two surfaces:
 *
 *   1. ADMIN PILL — small control in the inventory page topbar (or top
 *      of the page if no .topbar element is found). Shows the current
 *      global FEFO state; clicking opens a modal where admin can flip
 *      it. Only visible to admin (the server's GET response carries
 *      the is_admin flag).
 *
 *   2. UNIVERSAL BANNER — when FEFO is globally OFF, a prominent red
 *      banner is injected at the very top of the page for ALL users.
 *      It shows who turned it off, when, why, and when it will
 *      auto-re-enable. Prevents the "forgot to turn it back on"
 *      failure mode.
 *
 * Polls the GET endpoint every 30s so banner state stays fresh across
 * tabs and so the auto-re-enable expiry is reflected promptly.
 *
 * Drop-in: include this file once in inventory_mgmt.html, after
 * inventory_mgmt.js. No markup changes elsewhere required.
 */

(function(){
  'use strict';

  // Don't double-initialise (defensive against duplicate <script> tags).
  if (window._invFefoGlobalInit) return;
  window._invFefoGlobalInit = true;

  // ───────────────────────────────────────────────────────────────────
  // State + DOM nodes
  // ───────────────────────────────────────────────────────────────────
  let _state    = null;         // last GET response
  let _pollMs   = 30000;        // polling cadence
  let _bannerEl = null;         // injected banner element (or null)
  let _pillEl   = null;         // injected admin pill (or null)

  // ───────────────────────────────────────────────────────────────────
  // Utilities
  // ───────────────────────────────────────────────────────────────────
  function esc(s){
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, m =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function fmtDt(s){
    if (!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/.exec(String(s));
    if (!m) return String(s);
    return `${m[3]}-${m[2]}-${m[1]} ${m[4]}`;
  }
  function minutesUntil(s){
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(String(s));
    if (!m) return null;
    // Build naive IST date; the server timestamps are already in IST,
    // so use Date.UTC + IST offset to construct an absolute comparison.
    const target = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4]-5, +m[5]-30);
    const now = Date.now();
    const diff = Math.round((target - now) / 60000);
    return diff;
  }

  // ───────────────────────────────────────────────────────────────────
  // Banner — universal, shown when FEFO is globally OFF
  // ───────────────────────────────────────────────────────────────────
  function renderBanner(state){
    // Remove existing banner first.
    if (_bannerEl){ _bannerEl.remove(); _bannerEl = null; }
    if (!state || !state.is_disabled) return;

    const mins = minutesUntil(state.expires_at);
    let timeStr;
    if (mins == null)         timeStr = 'no auto-re-enable';
    else if (mins <= 0)       timeStr = 'expiring now';
    else if (mins < 60)       timeStr = `auto-re-enables in ${mins} min`;
    else if (mins < 24*60)    timeStr = `auto-re-enables in ${Math.round(mins/60*10)/10} h`;
    else                      timeStr = `auto-re-enables at ${fmtDt(state.expires_at)}`;

    _bannerEl = document.createElement('div');
    _bannerEl.id = 'inv-fefo-global-banner';
    _bannerEl.setAttribute('role', 'alert');
    _bannerEl.style.cssText = [
      'position:sticky',
      'top:0',
      'z-index:9000',
      'background:linear-gradient(180deg,#fef2f2 0%,#fee2e2 100%)',
      'border-bottom:2px solid #dc2626',
      'color:#7f1d1d',
      'padding:8px 16px',
      'font-family:Inter,system-ui,sans-serif',
      'font-size:13px',
      'font-weight:600',
      'display:flex',
      'align-items:center',
      'gap:14px',
      'box-shadow:0 2px 8px rgba(220,38,38,.18)',
      'animation:invFefoBannerPulse 2.4s ease-in-out infinite',
    ].join(';');
    _bannerEl.innerHTML = `
      <i class="fa fa-triangle-exclamation"
         style="font-size:18px;color:#dc2626;flex-shrink:0"></i>
      <div style="flex:1;line-height:1.35">
        <div style="font-weight:800;letter-spacing:.3px;text-transform:uppercase;font-size:11.5px;color:#991b1b;margin-bottom:2px">
          FEFO Enforcement Is OFF
        </div>
        <div>
          Turned off by
          <b style="color:#7f1d1d">${esc(state.changed_by || 'admin')}</b>
          at <b>${esc(fmtDt(state.changed_at))}</b>
          ${state.reason ? `· Reason: <i>${esc(state.reason)}</i>` : ''}
          · <span style="font-weight:700">${esc(timeStr)}</span>
        </div>
      </div>
      ${state.is_admin ? `
        <button type="button"
                onclick="window._invFefoOpenModal()"
                style="
                  padding:7px 14px;
                  background:#fff;
                  border:1px solid #dc2626;
                  color:#dc2626;
                  font-weight:700;
                  font-size:11.5px;
                  border-radius:8px;
                  cursor:pointer;
                  white-space:nowrap;
                  display:inline-flex;
                  align-items:center;
                  gap:5px;
                ">
          <i class="fa fa-shield-halved"></i> Re-enable FEFO
        </button>` : ''}
    `;

    // Inject keyframes once.
    if (!document.getElementById('inv-fefo-global-style')){
      const st = document.createElement('style');
      st.id = 'inv-fefo-global-style';
      st.textContent = `
        @keyframes invFefoBannerPulse {
          0%,100%{ box-shadow:0 2px 8px rgba(220,38,38,.18); }
          50%   { box-shadow:0 2px 14px rgba(220,38,38,.30); }
        }
        #inv-fefo-global-modal {
          position:fixed; inset:0; z-index:9100;
          background:rgba(15,23,42,.55);
          display:none; align-items:center; justify-content:center;
          padding:20px;
        }
        #inv-fefo-global-modal.open { display:flex; }
        #inv-fefo-global-modal .box {
          background:#fff; border-radius:12px; width:min(540px,100%);
          box-shadow:0 24px 60px rgba(15,23,42,.34);
          border:1px solid #e5e7eb;
          font-family:Inter,system-ui,sans-serif;
        }
        #inv-fefo-global-modal .hd {
          padding:14px 18px; border-bottom:1px solid #e5e7eb;
          display:flex; align-items:center; gap:8px;
          background:linear-gradient(135deg,#4648d4 0%,#7c3aed 100%);
          color:#fff;
          border-radius:12px 12px 0 0;
          font-weight:700; font-size:14px;
        }
        #inv-fefo-global-modal .bd {
          padding:18px; font-size:13px; color:#1e293b; line-height:1.5;
        }
        #inv-fefo-global-modal .bd label {
          display:block; font-weight:700; font-size:11px;
          color:#64748b; text-transform:uppercase; letter-spacing:.5px;
          margin:10px 0 4px;
        }
        #inv-fefo-global-modal .bd input,
        #inv-fefo-global-modal .bd textarea,
        #inv-fefo-global-modal .bd select {
          width:100%; padding:8px 10px; border:1px solid #cbd5e1;
          border-radius:8px; font-size:13px; font-family:inherit;
          color:#1e293b; box-sizing:border-box;
        }
        #inv-fefo-global-modal .bd textarea { resize:vertical; min-height:64px; }
        #inv-fefo-global-modal .ft {
          padding:12px 18px; border-top:1px solid #e5e7eb;
          display:flex; gap:8px; justify-content:flex-end;
          background:#f8fafc; border-radius:0 0 12px 12px;
        }
        #inv-fefo-global-modal .ft button {
          padding:8px 16px; border-radius:8px; cursor:pointer;
          font-size:12.5px; font-weight:700; font-family:inherit;
        }
        #inv-fefo-global-modal .ft .btn-cancel {
          background:#fff; color:#475569; border:1px solid #cbd5e1;
        }
        #inv-fefo-global-modal .ft .btn-confirm {
          color:#fff; border:1px solid transparent;
          background:linear-gradient(180deg,#dc2626 0%,#991b1b 100%);
        }
        #inv-fefo-global-modal .ft .btn-confirm.enable {
          background:linear-gradient(180deg,#10b981 0%,#047857 100%);
        }
        #inv-fefo-pill {
          display:inline-flex; align-items:center; gap:6px;
          padding:4px 10px; border-radius:9999px;
          font-size:11px; font-weight:700;
          cursor:pointer; font-family:Inter,system-ui,sans-serif;
          letter-spacing:.3px; text-transform:uppercase;
          transition:all .15s;
          border:1px solid transparent;
        }
        #inv-fefo-pill.on {
          background:rgba(16,185,129,.14); color:#047857;
          border-color:rgba(16,185,129,.32);
        }
        #inv-fefo-pill.on:hover {
          background:rgba(16,185,129,.22); border-color:#047857;
        }
        #inv-fefo-pill.off {
          background:rgba(220,38,38,.14); color:#b91c1c;
          border-color:rgba(220,38,38,.36);
          animation:invFefoBannerPulse 2.4s ease-in-out infinite;
        }
        #inv-fefo-pill.off:hover {
          background:rgba(220,38,38,.22); border-color:#dc2626;
        }
        #inv-fefo-pill .dot {
          width:8px; height:8px; border-radius:50%;
        }
        #inv-fefo-pill.on  .dot { background:#10b981; box-shadow:0 0 0 2px rgba(16,185,129,.22); }
        #inv-fefo-pill.off .dot { background:#dc2626; box-shadow:0 0 0 2px rgba(220,38,38,.22); }
      `;
      document.head.appendChild(st);
    }

    document.body.insertBefore(_bannerEl, document.body.firstChild);
  }

  // ───────────────────────────────────────────────────────────────────
  // Admin pill — appears in the topbar (or top-right corner fallback)
  // ───────────────────────────────────────────────────────────────────
  function renderPill(state){
    if (_pillEl){ _pillEl.remove(); _pillEl = null; }
    // Only admins see the pill — non-admin status is conveyed by the
    // banner when FEFO is off, and by nothing when it's on (no signal
    // needed since FEFO is the default).
    if (!state || !state.is_admin) return;

    _pillEl = document.createElement('button');
    _pillEl.id = 'inv-fefo-pill';
    _pillEl.type = 'button';
    _pillEl.className = state.is_disabled ? 'off' : 'on';
    _pillEl.title = state.is_disabled
      ? 'Click to re-enable FEFO enforcement system-wide'
      : 'Click to disable FEFO enforcement system-wide (admin only)';
    _pillEl.innerHTML = state.is_disabled
      ? '<span class="dot"></span>FEFO: OFF'
      : '<span class="dot"></span>FEFO: ON';
    _pillEl.onclick = openModal;

    // Find a host. Try the inventory topbar's right-side cluster first,
    // then the .topbar element itself, then fall back to a fixed
    // top-right corner overlay.
    const hosts = [
      document.querySelector('.topbar .topbar-right'),
      document.querySelector('.topbar .tb-actions'),
      document.querySelector('.topbar'),
    ];
    let placed = false;
    for (const h of hosts){
      if (h){
        // Insert as the first child of the host so it sits before
        // existing widgets like the clock / user pill.
        h.insertBefore(_pillEl, h.firstChild);
        _pillEl.style.marginRight = '8px';
        placed = true;
        break;
      }
    }
    if (!placed){
      // No topbar found → corner-pin it. Keeps the control discoverable
      // on pages that don't share the standard inventory chrome.
      _pillEl.style.position = 'fixed';
      _pillEl.style.top      = '10px';
      _pillEl.style.right    = '12px';
      _pillEl.style.zIndex   = '8900';
      document.body.appendChild(_pillEl);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Modal — admin confirmation dialog
  // ───────────────────────────────────────────────────────────────────
  function ensureModal(){
    let m = document.getElementById('inv-fefo-global-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'inv-fefo-global-modal';
    m.innerHTML = `
      <div class="box">
        <div class="hd">
          <i class="fa fa-shield-halved"></i>
          <span id="inv-fefo-modal-title">FEFO Switch</span>
          <button type="button" onclick="window._invFefoCloseModal()"
                  style="margin-left:auto;background:rgba(255,255,255,.18);
                         border:1px solid rgba(255,255,255,.32);color:#fff;
                         width:26px;height:26px;border-radius:6px;cursor:pointer;
                         font-size:13px">&times;</button>
        </div>
        <div class="bd" id="inv-fefo-modal-body"></div>
        <div class="ft">
          <button type="button" class="btn-cancel" onclick="window._invFefoCloseModal()">
            Cancel
          </button>
          <button type="button" class="btn-confirm" id="inv-fefo-modal-confirm">
            Confirm
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    return m;
  }

  function openModal(){
    if (!_state || !_state.is_admin){
      // Defensive — non-admin shouldn't be able to reach this.
      return;
    }
    const m = ensureModal();
    const disabling = !_state.is_disabled;   // if currently ON, we're going to DISABLE
    document.getElementById('inv-fefo-modal-title').textContent =
      disabling ? 'Disable FEFO Enforcement' : 'Re-enable FEFO Enforcement';

    const body = document.getElementById('inv-fefo-modal-body');
    if (disabling){
      body.innerHTML = `
        <div style="background:#fef2f2;border-left:3px solid #dc2626;
                    padding:10px 12px;border-radius:0 6px 6px 0;
                    margin-bottom:14px">
          <b style="color:#991b1b">You are about to disable FEFO system-wide.</b>
          <div style="margin-top:4px;font-size:12px;color:#7f1d1d">
            Every operator (not just admins) will be able to consume any
            batch regardless of expiry. Use only for migration, audit,
            or emergency operations.
          </div>
        </div>
        <label for="inv-fefo-reason">Reason (required)</label>
        <textarea id="inv-fefo-reason"
                  placeholder="e.g. Audit count — disable FEFO so scans don't raise overrides"></textarea>
        <label for="inv-fefo-duration">Auto-re-enable after</label>
        <select id="inv-fefo-duration">
          <option value="1">1 hour</option>
          <option value="2">2 hours</option>
          <option value="4" selected>4 hours (recommended)</option>
          <option value="8">8 hours</option>
          <option value="24">24 hours (max)</option>
        </select>
        <div style="margin-top:6px;font-size:11px;color:#64748b">
          Safety net: FEFO will turn back on automatically after this duration.
          You can re-disable immediately if needed.
        </div>
      `;
      const btn = document.getElementById('inv-fefo-modal-confirm');
      btn.className = 'btn-confirm';
      btn.innerHTML = '<i class="fa fa-power-off"></i> Disable FEFO';
      btn.onclick = () => submitChange(true);
    } else {
      body.innerHTML = `
        <div style="background:#ecfdf5;border-left:3px solid #10b981;
                    padding:10px 12px;border-radius:0 6px 6px 0;
                    margin-bottom:14px">
          <b style="color:#047857">Re-enable FEFO enforcement.</b>
          <div style="margin-top:4px;font-size:12px;color:#065f46">
            FEFO violations will once again block scans until override
            requests are approved.
          </div>
        </div>
        <div style="font-size:12.5px;color:#475569">
          Currently OFF since <b>${esc(fmtDt(_state.changed_at))}</b>
          by <b>${esc(_state.changed_by || '—')}</b>.
          ${_state.reason ? `<br>Reason: <i>${esc(_state.reason)}</i>` : ''}
        </div>
        <label for="inv-fefo-reason">Note (optional)</label>
        <input id="inv-fefo-reason" placeholder="e.g. Audit complete, resuming normal operations">
      `;
      const btn = document.getElementById('inv-fefo-modal-confirm');
      btn.className = 'btn-confirm enable';
      btn.innerHTML = '<i class="fa fa-shield-halved"></i> Re-enable FEFO';
      btn.onclick = () => submitChange(false);
    }
    m.classList.add('open');
  }

  function closeModal(){
    const m = document.getElementById('inv-fefo-global-modal');
    if (m) m.classList.remove('open');
  }

  // Exposed globally so the banner's inline onclick can reach them.
  window._invFefoOpenModal  = openModal;
  window._invFefoCloseModal = closeModal;

  function submitChange(disable){
    const reasonEl = document.getElementById('inv-fefo-reason');
    const durEl    = document.getElementById('inv-fefo-duration');
    const reason   = (reasonEl && reasonEl.value || '').trim();
    const duration = durEl ? parseFloat(durEl.value) || 4 : 4;

    if (disable && !reason){
      reasonEl.style.borderColor = '#dc2626';
      reasonEl.focus();
      return;
    }
    const btn = document.getElementById('inv-fefo-modal-confirm');
    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Working…';

    fetch('/api/inventory_mgmt/fefo/global_state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        disable: disable,
        reason:  reason,
        duration_hours: duration,
      }),
    })
    .then(r => r.json())
    .then(d => {
      if (d.status !== 'ok'){
        alert(d.message || 'Failed to update FEFO state');
        btn.disabled = false; btn.innerHTML = origHtml;
        return;
      }
      _state = d;
      renderBanner(d);
      renderPill(d);
      closeModal();
    })
    .catch(e => {
      alert('Network error: ' + (e && e.message ? e.message : e));
      btn.disabled = false; btn.innerHTML = origHtml;
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Polling
  // ───────────────────────────────────────────────────────────────────
  function fetchState(){
    fetch('/api/inventory_mgmt/fefo/global_state', {
      credentials: 'same-origin',
    })
    .then(r => r.json())
    .then(d => {
      if (d.status !== 'ok') return;
      // Only re-render if something meaningful changed (avoid flicker
      // on the pulsing banner).
      const changed = !_state
        || _state.is_disabled !== d.is_disabled
        || _state.changed_at  !== d.changed_at
        || _state.expires_at  !== d.expires_at
        || _state.is_admin    !== d.is_admin;
      _state = d;
      if (changed){
        renderBanner(d);
        renderPill(d);
      }
    })
    .catch(() => { /* silent — the next poll will retry */ });
  }

  // ───────────────────────────────────────────────────────────────────
  // Boot
  // ───────────────────────────────────────────────────────────────────
  function boot(){
    fetchState();
    setInterval(fetchState, _pollMs);
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
