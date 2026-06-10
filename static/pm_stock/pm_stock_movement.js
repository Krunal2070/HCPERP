/* ════════════════════════════════════════════════════════════════
   MATERIAL TRANSFER  (Voucher-Based)
   - OUT voucher: scan boxes → adds/updates line items → save → source decrement
   - IN  voucher: open in-transit voucher → scan at destination → save
   - If OUT/IN match per product → status='received' (complete)
   - Else → has_discrepancy=1 → sticky red banner on every screen until reconciled
════════════════════════════════════════════════════════════════ */

/* ── Voice feedback for box scans ──────────────────────────────
   Hands-free audio cue so the operator can keep eyes on the
   physical box rather than the screen. Uses the browser's built-in
   Web Speech API (no audio files to host). If the browser doesn't
   support speech synthesis, this becomes a no-op — toast still
   fires.

   Operators can mute via the toggle on the IN/OUT scan card,
   which flips localStorage 'pm_voice_scan_enabled' = '0'. Default
   is enabled on first visit. */
function _voiceSay(text, opts){
  try {
    if(typeof window.speechSynthesis === 'undefined') return;
    if(localStorage.getItem('pm_voice_scan_enabled') === '0') return;
    // Cancel any in-flight utterance so rapid scans don't queue up
    // a long backlog — newest scan always wins.
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text || ''));
    u.rate   = (opts && opts.rate)   || 1.15; // slightly fast for warehouse pace
    u.volume = (opts && opts.volume) || 1.0;
    u.pitch  = (opts && opts.pitch)  || 1.0;
    window.speechSynthesis.speak(u);
  } catch(_e){
    // Speech is best-effort; never let a TTS failure interrupt the scan flow.
  }
}

/* Convenience wrappers used at every scan branch */
function _voiceScanned()    { _voiceSay('Added'); }
function _voiceNotScanned() { _voiceSay('Not added'); }

/* Voice toggle (called by the mute button on the scan card) */
function pmToggleScanVoice(){
  const cur = localStorage.getItem('pm_voice_scan_enabled') !== '0';
  localStorage.setItem('pm_voice_scan_enabled', cur ? '0' : '1');
  // Update any visible toggle indicators
  document.querySelectorAll('.pm-voice-toggle').forEach(el => {
    el.textContent = cur ? '🔇' : '🔊';
    el.title = cur ? 'Voice OFF — click to enable' : 'Voice ON — click to mute';
  });
  // Speak a confirmation when turning ON so the operator knows it works
  if(!cur){
    setTimeout(() => _voiceSay('Voice on'), 50);
  }
}

/* Restore toggle button state from localStorage when the page first
   builds. Runs once on script load; subsequent visits-during-session
   are handled by pmToggleScanVoice. Wrapped in DOMContentLoaded so it
   works whether the toggles are present on first paint or injected
   later. */
document.addEventListener('DOMContentLoaded', function(){
  const muted = localStorage.getItem('pm_voice_scan_enabled') === '0';
  if(!muted) return;  // default state in the HTML is already 🔊
  document.querySelectorAll('.pm-voice-toggle').forEach(el => {
    el.textContent = '🔇';
    el.title = 'Voice OFF — click to enable';
  });
});

/* iOS speech-unlock — Apple requires the first speechSynthesis.speak()
   call to be a direct response to a user gesture. Once that first
   speak has fired, subsequent calls work without further gestures.
   On Android/desktop this is a no-op safety net; on iOS it ensures
   the first scan after focusing the input gets voiced.

   Listens on any scan input ever rendered (delegated via document so
   we catch inputs that come from modals which mount later). The
   trigger is the first focus event; afterwards we remove the
   listener so we don't keep firing silent utterances. */
(function(){
  let _unlocked = false;
  document.addEventListener('focusin', function(ev){
    if(_unlocked) return;
    const id = ev.target && ev.target.id;
    if(!id) return;
    // Match any of the three scan inputs (OUT modal / IN modal / inbox)
    if(id !== 'mvout-scan-input' && id !== 'mvin-scan-input' && id !== 'inbox-scan-input') return;
    _unlocked = true;
    try {
      // Speak an empty utterance to satisfy iOS's first-gesture rule.
      // Silent on every platform but registers the gesture so iOS allows
      // subsequent speech without further taps.
      if(typeof window.speechSynthesis !== 'undefined'){
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch(_e){}
  }, true);
})();

let _mmSubTab           = 'out';
let _mvOut              = null;
let _mvIn               = null;
let _mvDiscrepancyShown = false;

function mmSwitchSubTab(name){
  _mmSubTab = name;
  ['out','in','history','mr'].forEach(t => {
    const btn = document.getElementById(`mm-tab-${t}-btn`);
    const pan = document.getElementById(`mm-sub-${t}`);
    if(btn){
      const on = (t === name);
      btn.style.background = on ? 'var(--teal,#0d9488)' : 'transparent';
      btn.style.color      = on ? '#fff' : 'var(--hmuted2,#6b7280)';
    }
    if(pan) pan.style.display = (t === name ? '' : 'none');
  });
  if(name === 'out'){    mmLoadOutList(); }
  if(name === 'in'){     mvLoadInTransit(); mmLoadInCompletedList(); }
  if(name === 'history') mmLoadHistory();
  if(name === 'mr'){
    if(typeof mrLoadList === 'function') mrLoadList();
    if(typeof refreshMrBadge === 'function') refreshMrBadge();
  }
}

// Forwarder used by openMrFulfill so it can switch to the OUT subtab.
function setMmSubTab(name){ mmSwitchSubTab(name); }

function _isAdmin(){ return !!document.getElementById('prodCodeRegenBtn'); }

function _populateGodownSelects(){
  // List all godowns from the DB. The SOURCE select gets the full list
  // (Factory, Bhayla Old, NBG, Floor). The DESTINATION select excludes
  // the Floor godown specifically — Material OUT vouchers are not meant
  // to dispatch INTO Floor; that's handled by Dispatch Entry instead.
  //
  // NOTE: we cannot rely on `is_floor` / `godown_type` to detect Floor
  // because in production, `procurement_godowns.type = 'godown'` for ALL
  // rows including Floor, and `is_floor` is computed from pm_floor_txn
  // history — which incorrectly flags Factory if it has any historic
  // floor-style transactions. The only reliable signal is the godown
  // name being exactly "Floor".
  const list = (window._godowns || []);
  const isFloorRow = g => (g.name || '').trim().toLowerCase() === 'floor';
  const opts = list.map(g => {
    const label = isFloorRow(g) ? `🏭 ${g.name}` : `📦 ${g.name}`;
    return `<option value="${g.id}">${label}</option>`;
  }).join('');
  const optsNoFloor = list
    .filter(g => !isFloorRow(g))
    .map(g => `<option value="${g.id}">📦 ${g.name}</option>`)
    .join('');
  const fromEl = document.getElementById('mout-from');
  if(fromEl) fromEl.innerHTML = '<option value="">— Select location —</option>' + opts;
  const toEl = document.getElementById('mout-to');
  if(toEl)   toEl.innerHTML   = '<option value="">— Select destination —</option>' + optsNoFloor;
  // Apply per-user home godown lock (no-op if user is admin / unlocked)
  _applyTransferHomeLock();
}

function _godownName(id){
  const g = (window._godowns || []).find(x => x.id === parseInt(id));
  return g ? g.name : '—';
}

// Source-side lock for the new-transfer form.
//
// New behaviour (per Tarak's spec — Nov 2026 update):
//   When a non-admin user is mapped to a home godown, the "From"
//   (source) select is locked to that godown and the "To"
//   (destination) select hides the home godown from its options
//   (since you can't transfer to yourself).
//
//   Old behaviour offered a radio toggle that let the user pick
//   whether home was the source or the destination. That added
//   ambiguity — Tarak only wants senders. Receivers don't go
//   through Material OUT at all; they wait for an incoming
//   transfer and complete it via Material IN.
//
//   Admins are unaffected — they keep full freedom on both selects.
function _applyTransferHomeLock(){
  const h = window._pmUserHome;
  const fromSel = document.getElementById('mout-from');
  const toSel   = document.getElementById('mout-to');
  if(!fromSel || !toSel) return;

  // Cleanup any stale toggle from the old behaviour
  const oldToggle = document.getElementById('mout-home-toggle');
  if(oldToggle) oldToggle.remove();

  if(!h || h.is_admin || !h.home_godown_id) {
    // Admin or unmapped user — no restrictions
    fromSel.disabled = false;
    fromSel.removeAttribute('data-pm-home-locked');
    toSel.disabled = false;
    toSel.removeAttribute('data-pm-home-locked');
    // Clear any existing source-lock badge
    const oldBadge = document.getElementById('mout-home-badge');
    if(oldBadge) oldBadge.remove();
    // Repopulate destination with all options (in case it was filtered earlier)
    _refreshTransferDestOptions(null);
    return;
  }

  const homeId   = String(h.home_godown_id);
  const homeName = h.home_godown_name || `#${homeId}`;

  // Show a static lock badge so the user knows what's going on.
  // We render this once at the top of the form — replaces the old radio toggle.
  let badge = document.getElementById('mout-home-badge');
  if(!badge){
    badge = document.createElement('div');
    badge.id = 'mout-home-badge';
    badge.style.cssText = 'background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.35);border-left:4px solid #d97706;border-radius:8px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:11.5px;color:#92400e';
    const grid = fromSel.closest('div[style*="grid-template-columns"]');
    if(grid && grid.parentElement){
      grid.parentElement.insertBefore(badge, grid);
    }
  }
  badge.innerHTML = `🔒 <strong>Source locked to ${_escForBadge(homeName)}</strong>
    <span style="color:#a16207">— transfers can only originate from your assigned location.</span>`;

  // Hard-lock source to home
  fromSel.value = homeId;
  fromSel.disabled = true;
  fromSel.dataset.pmHomeLocked = '1';

  // Filter destination options so the home godown isn't a choice
  // (you can't transfer to yourself).
  _refreshTransferDestOptions(parseInt(homeId));
  // If the destination was previously set to home, clear it
  if(toSel.value === homeId) toSel.value = '';
  toSel.disabled = false;
  toSel.removeAttribute('data-pm-home-locked');

  if(typeof moutValidateForm === 'function') moutValidateForm();
}

// Repopulate the destination select with all godowns *except* the
// optional excludeId. Preserves the current selection if still valid.
function _refreshTransferDestOptions(excludeId){
  const toSel = document.getElementById('mout-to');
  if(!toSel) return;
  const cur = toSel.value;
  // Filter out the Floor godown AND any excludeId (typically the chosen
  // source). Floor is matched by name (not by is_floor / godown_type)
  // because the production DB has type='godown' on ALL rows including
  // Floor, and is_floor is computed from pm_floor_txn history which can
  // incorrectly flag Factory.
  const isFloorRow = g => (g.name || '').trim().toLowerCase() === 'floor';
  const list = (window._godowns || []).filter(g => {
    if (isFloorRow(g)) return false;
    if (excludeId != null && Number(g.id) === Number(excludeId)) return false;
    return true;
  });
  const opts = list.map(g =>
    `<option value="${g.id}">📦 ${g.name}</option>`
  ).join('');
  toSel.innerHTML = '<option value="">— Select destination —</option>' + opts;
  // Restore prior selection if still valid
  if(cur && Array.from(toSel.options).some(o => o.value === cur)){
    toSel.value = cur;
  }
}

// Tiny escape for the badge — avoids depending on a global helper here.
function _escForBadge(s){
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Stub kept for back-compat in case any cached HTML still calls it
function _setTransferDirection(_dir){ /* no-op — direction is fixed to "from" now */ }

/* ────────────── OUT VOUCHER ────────────── */

function moutValidateForm(){
  const f = parseInt(document.getElementById('mout-from')?.value)||0;
  const t = parseInt(document.getElementById('mout-to')?.value)||0;

  // Keep the destination dropdown clean — never list the source as a
  // valid destination. This prevents users with no home-godown lock
  // from picking the same location for both fields. The home-locked
  // case is handled separately in _applyTransferHomeLock (which
  // pre-filters once at load time using the locked home id).
  const h = window._pmUserHome;
  const isHomeLocked = h && !h.is_admin && h.home_godown_id;
  if(!isHomeLocked){
    // Admin or unmapped user — refilter destination to exclude the
    // currently-chosen source. _refreshTransferDestOptions preserves
    // the dropdown's current selection if it's still valid; if not,
    // it falls back to the empty placeholder.
    if(typeof _refreshTransferDestOptions === 'function'){
      _refreshTransferDestOptions(f || null);
    }
  }

  const btn = document.getElementById('mout-create-btn');
  if(!btn) return;
  const ok = f && t && f !== t;
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
  btn.title = (f && t && f === t) ? 'Source and destination must differ' : '';
}

async function moutCreateVoucher(){
  // If a Material Request fulfill is pending, the destination, items
  // and request_id were pre-stashed by openMrFulfill. We pull them and
  // attach to the create call so the back-end stamps request_id on
  // pm_transfers — that's the link the save_out hook reads later.
  const mrPrefill = window._mrPendingPrefill || null;

  // When fulfilling, force the destination dropdown to the request's
  // dest_godown so the user can't accidentally send to the wrong place.
  if(mrPrefill && mrPrefill.dest_godown_id){
    const toSel = document.getElementById('mout-to');
    if(toSel && String(toSel.value) !== String(mrPrefill.dest_godown_id)){
      toSel.value = String(mrPrefill.dest_godown_id);
    }
  }

  const f = parseInt(document.getElementById('mout-from')?.value)||0;
  const t = parseInt(document.getElementById('mout-to')?.value)||0;
  const remarks = (document.getElementById('mout-remarks')?.value || '').trim();
  if(!f || !t || f === t){ showToast('Pick valid source and destination','error'); return; }

  // Safety: if fulfilling, source != dest is guaranteed by the request
  // (request's dest is the to_godown; user picks any other source).
  if(mrPrefill && mrPrefill.dest_godown_id && parseInt(t) !== parseInt(mrPrefill.dest_godown_id)){
    if(!confirm(`This OUT is for Request ${mrPrefill.request_no}, destination should be "${mrPrefill.dest_godown_name}". Continue with a different destination?`)) return;
  }

  const btn = document.getElementById('mout-create-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
  btn.disabled = true;
  try {
    const body = {from_godown_id:f, to_godown_id:t, remarks};
    if(mrPrefill && mrPrefill.request_id){
      body.request_id = mrPrefill.request_id;
      if(!body.remarks) body.remarks = `Fulfilling Request ${mrPrefill.request_no}`;
    }
    const res = await fetch('/api/pm_stock/transfers/voucher/create',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await res.json();
    if(d.status !== 'ok'){ showToast(d.message || 'Failed','error'); return; }
    await mvOpenOutVoucher(d.transfer_id);

    // Show a "Fulfilling Request" banner inside the OUT modal so the user
    // knows what they're working on. The prefill items are listed for
    // reference — the user still has to scan the actual boxes; we don't
    // auto-create stock movements just from the request payload.
    if(mrPrefill){
      _mvOutShowMrBanner(mrPrefill);
    }
  } catch(e){ showToast('Error: '+e.message,'error'); }
  finally {
    btn.innerHTML = orig;
    moutValidateForm();
    // Clear the prefill — single use only. If the user reopens later,
    // they re-trigger via the Material Request tab's Fulfill button.
    window._mrPendingPrefill = null;
  }
}

// Helper used by moutCreateVoucher to surface the Request context inside
// the OUT modal. The banner shows the request number + remaining items
// list so the operator knows exactly what to scan.
function _mvOutShowMrBanner(mrPrefill){
  if(!mrPrefill) return;
  const host = document.getElementById('mvOutModal');
  if(!host) return;
  // Find or create the banner element
  let banner = host.querySelector('.mvout-mr-banner');
  if(!banner){
    banner = document.createElement('div');
    banner.className = 'mvout-mr-banner';
    banner.style.cssText = 'margin:10px 14px;padding:10px 14px;background:linear-gradient(135deg,rgba(13,148,136,.08),rgba(13,148,136,.02));border:1.5px solid rgba(13,148,136,.3);border-radius:8px;font-size:11.5px;color:var(--htxtb,#111)';
    // Insert near the top of the modal body
    const body = host.querySelector('.modal') || host;
    const firstChild = body.firstElementChild;
    if(firstChild) body.insertBefore(banner, firstChild.nextSibling);
    else body.appendChild(banner);
  }
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  const _e = s => String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const itemsList = (mrPrefill.items || []).map(it =>
    `<li><strong>${_e(it.product_name || ('#'+it.product_id))}</strong> — remaining qty <strong style="color:var(--teal,#0d9488)">${fmtN(it.qty)}</strong>`
    + (it.remarks ? ` <span style="color:#6d28d9;font-style:italic">📝 ${_e(it.remarks)}</span>` : '')
    + `</li>`
  ).join('');
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <span style="font-size:18px">📝</span>
      <div style="flex:1">
        <div style="font-size:11px;color:var(--hmuted,#9ca3af);font-weight:700;letter-spacing:.5px;text-transform:uppercase">Fulfilling</div>
        <div style="font-size:13px;font-weight:800;font-family:monospace;color:var(--teal,#0d9488)">${mrPrefill.request_no}</div>
      </div>
      <div style="font-size:10.5px;color:var(--hmuted2,#6b7280)">Destination locked to <strong>${mrPrefill.dest_godown_name}</strong></div>
    </div>
    <div style="font-size:11px;color:var(--hmuted2,#6b7280);margin-bottom:4px">Scan boxes for the items below — only matched products will count toward request fulfillment:</div>
    <ul style="margin:4px 0 0 18px;font-size:11px;color:var(--htxtb,#111);line-height:1.6">${itemsList}</ul>`;
}

async function mvOpenOutVoucher(tid){
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${tid}`);
    const d   = await res.json();
    if(d.status !== 'ok'){ showToast(d.message || 'Load failed','error'); return; }
    _mvOut = { ...d.header, items: d.out_items || [], in_items: d.in_items || [] };
    _mvOutRender();
    document.getElementById('mvOutModal')?.classList.add('open');
    setTimeout(() => document.getElementById('mvout-scan-input')?.focus(), 100);
    // Material Request linkage: if this OUT was created via "Fulfill MR",
    // the transfer carries request_id + from_godown_id. Pull the per-item
    // box suggestions from the backend and render the suggestion panel.
    // Errors are swallowed — the panel just stays hidden and the
    // fulfiller can still scan manually.
    _mvOutLoadMrSuggestions().catch(_ => {});
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

// ── Material Request suggestion panel loader ──────────────────────────
//
// Fetches /api/pm_stock/material_request/<rid>/suggest_boxes for the
// linked request (or hides the panel if there's no linkage). Renders
// one card per request item with the suggested FIFO box list. Read-only
// — operators still scan the physical box; this is a guidance overlay
// to remove the need for manual math.
async function _mvOutLoadMrSuggestions(){
  const panel = document.getElementById('mvout-mr-suggestions');
  if(!panel) return;
  const rid    = _mvOut && _mvOut.request_id;
  const srcId  = _mvOut && _mvOut.from_godown_id;
  if(!rid || !srcId){
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  // Show loading state immediately so the panel doesn't pop in mid-scan
  panel.style.display = 'block';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--hmuted2,#6b7280)">
      <span class="spinner"></span> Loading box suggestions for fulfilment…
    </div>`;
  try {
    const res = await fetch(
      `/api/pm_stock/material_request/${rid}/suggest_boxes?source_godown_id=${srcId}`
    );
    const d = await res.json();
    if(d.status !== 'ok'){
      panel.innerHTML = `
        <div style="font-size:12px;color:#dc2626">Could not load suggestions: ${(d.message || 'unknown error')}</div>`;
      return;
    }
    _mvOutRenderMrSuggestions(d);
  } catch(e){
    panel.innerHTML = `
      <div style="font-size:12px;color:#dc2626">Could not load suggestions: ${e.message}</div>`;
  }
}

function _mvOutRenderMrSuggestions(d){
  const panel = document.getElementById('mvout-mr-suggestions');
  if(!panel) return;
  const suggestions = d.suggestions || [];
  if(!suggestions.length){
    // No items remaining — request fully fulfilled
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#16a34a;font-weight:700">
        <span style="font-size:16px">✓</span>
        Request ${esc(d.request_no || '')} is fully fulfilled — no boxes needed.
      </div>`;
    return;
  }
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN');
  // Header
  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:var(--teal,#0d9488)">
        💡 Suggested boxes for ${esc(d.request_no || '')}
      </div>
      <div style="font-size:10px;color:var(--hmuted,#9ca3af);font-style:italic">
        FIFO order · scan these or pick replacements
      </div>
    </div>`;

  // Per-product cards
  html += suggestions.map(s => {
    // Shortage warning style
    const hasShortage = s.shortage > 0;
    const stripColor  = hasShortage ? '#dc2626' : 'var(--teal,#0d9488)';
    const stripBg     = hasShortage ? 'rgba(220,38,38,.05)' : 'rgba(13,148,136,.02)';
    const summary = hasShortage
      ? `<span style="color:#dc2626;font-weight:700">⚠ Only ${fmt(s.qty_picked)} available at source · short by ${fmt(s.shortage)}</span>`
      : `<span>Suggested: <strong>${s.boxes_to_pick}</strong> ${s.boxes_to_pick === 1 ? 'box' : 'boxes'} × <strong>${fmt(s.per_box_qty)}</strong> = <strong style="color:var(--teal,#0d9488)">${fmt(s.qty_picked)}</strong></span>`;

    // Box chips — codes are intentionally NOT shown. Operators scan the
    // physical box; the panel only conveys how many boxes to pick and in
    // what FIFO order. We render numbered position pills (#1, #2, …) in
    // FIFO sequence. The real code stays in the hover title for reference
    // (e.g. if someone needs to cross-check a specific suggested box).
    const chips = (s.boxes || []).map((b, i) => {
      const code = b.short_code || b.box_code || '';
      return `
        <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;background:#fff;border:1px solid rgba(13,148,136,.30);font-size:10.5px;font-weight:700;color:var(--teal,#0d9488)"
              title="FIFO #${i + 1} · ${fmt(b.per_box_qty)} units · GRN ${esc(b.grn_no || '')}">#${i + 1}</span>`;
    }).join(' ');

    // Partial-transfer hint
    const hint = s.partial_hint ? `
      <div style="margin-top:6px;padding:6px 10px;border-radius:5px;background:rgba(245,158,11,.10);border-left:3px solid #f59e0b;font-size:10.5px;color:#92400e">
        <strong>Note:</strong> Last box overshoots by ${fmt(s.over_by)} units. Consider splitting the final box or accepting the slight over-fulfilment (${fmt(s.qty_picked)} delivered vs ${fmt(s.qty_remaining)} requested).
      </div>` : '';

    return `
      <div style="margin-bottom:8px;padding:10px 12px;border-radius:6px;background:${stripBg};border-left:3px solid ${stripColor}">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--htxtb,#111)">
              ${s.pm_type ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;background:rgba(0,0,0,.05);border-radius:3px;margin-right:4px;color:var(--hmuted2,#6b7280)">${esc(s.pm_type)}</span>` : ''}
              ${esc(s.product_name || '#'+s.product_id)}
            </div>
            <div style="font-size:10.5px;color:var(--hmuted2,#6b7280);margin-top:2px">
              Need <strong>${fmt(s.qty_remaining)}</strong>${s.qty_fulfilled > 0 ? ` (out of ${fmt(s.qty_requested)} · ${fmt(s.qty_fulfilled)} already fulfilled)` : ''}
            </div>
            ${s.remarks ? `<div style="font-size:10.5px;color:#6d28d9;margin-top:3px;font-style:italic">📝 Requester note: ${esc(s.remarks)}</div>` : ''}
          </div>
          <div style="font-size:11px;text-align:right">${summary}</div>
        </div>
        ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>` : ''}
        ${hint}
      </div>`;
  }).join('');

  panel.innerHTML = html;

  // Local esc helper if the outer scope's esc isn't accessible from here.
  // The render uses `esc` — defined inside mvCloseOutVoucher's scope in
  // some flows but missing in others. We rely on a global esc; if it
  // doesn't exist, define a minimal one once.
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
}

function mvCloseOutVoucher(){
  document.getElementById('mvOutModal')?.classList.remove('open');
  _mvOut = null;
  // Reset the overscan acknowledgement set — the next OUT voucher
  // should warn on the first overscan even if the user clicked
  // "continue" on the previous one. Tracked here rather than in close
  // because mvOpenOutVoucher is called repeatedly during scanning to
  // refresh the modal contents.
  if(typeof _resetOverscanAck === 'function') _resetOverscanAck();
  mvRefreshInTransitCount();
  if(_mmSubTab === 'out' && typeof mmLoadOutList === 'function') mmLoadOutList();
}

function _mvOutRender(){
  if(!_mvOut) return;
  const setText = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };
  // Build voucher-number display with the OUT date appended after a pipe.
  // Format: "PMT/26-27/0082 | 10/05/2026". OUT-side vouchers always have
  // an out_at (the row exists from the moment the voucher is created), so
  // we don't need a "pending" fallback like the IN side does.
  const _vnoEl = document.getElementById('mvout-vno');
  if(_vnoEl){
    const vno   = _mvOut.transfer_no || '—';
    const outAt = _mvOut.out_at || null;
    if(outAt){
      const dateStr = (typeof fmtDateTime === 'function')
        ? (fmtDateTime(outAt).split(' ')[0] || fmtDateTime(outAt))
        : String(outAt).slice(0,10);
      _vnoEl.textContent = `${vno} | ${dateStr}`;
      _vnoEl.title = `OUT: ${fmtDateTime ? fmtDateTime(outAt) : outAt}${_mvOut.out_by ? ' · by ' + _mvOut.out_by : ''}`;
    } else {
      _vnoEl.textContent = vno;
      _vnoEl.title = '';
    }
  }
  setText('mvout-from',  _mvOut.from_name  || _godownName(_mvOut.from_godown_id));
  setText('mvout-to',    _mvOut.to_name    || _godownName(_mvOut.to_godown_id));

  const tbody = document.getElementById('mvout-items');
  const items = _mvOut.items || [];
  const isAdmin  = _isAdmin();
  // `editable` = "is this voucher in a state where line changes are allowed at all?"
  // It does NOT mean "this user can edit everything". The per-control checks
  // below split the rules:
  //   • Quantity inputs (no_of_box, per_box_qty) → admin only
  //   • Delete-line button (🗑)                  → any user on a DRAFT,
  //                                                 admin always
  // This matches the backend permission model in api_voucher_edit_line:
  // PATCH stays admin-only, DELETE is opened up for non-admins on drafts
  // so a scanning operator can clean up a mis-scanned product themselves.
  const editable     = (_mvOut.status === 'out_started') || isAdmin;
  const canDeleteRow = editable;                                    // already covers both cases above
  const canEditQty   = editable && isAdmin;                         // tighter — admin only

  if(!items.length){
    tbody.innerHTML = `<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      No products yet. Scan a box below to add the first line.
    </td></tr>`;
  } else {
    // Render each line as a main <tr> + a hidden detail <tr> showing the
    // individual scanned-box chips (with × to unscan one). The detail row
    // toggles via the chevron next to the box-count cell. Chevron only
    // shows when there are boxes to expand AND the user is allowed to
    // remove (canDeleteRow) — read-only viewers don't get the affordance.
    function _escHtml(s){
      return String(s||'').replace(/[<>&"']/g, c =>
        ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function _boxChipsHtml(r){
      const boxes = Array.isArray(r.boxes) ? r.boxes : [];
      if(!boxes.length){
        return `<div style="padding:10px 14px;color:var(--hmuted,#9ca3af);font-size:11px;font-style:italic">
          No box-level scan records on file for this line.
        </div>`;
      }
      const chips = boxes.map(b => {
        // Prefer the short_code when it exists — easier to read at a glance
        // (8 chars vs ~22 chars). Fall back to the long box_code for legacy
        // boxes that have no short_code yet.
        const display = b.short_code || b.box_code || ('#' + b.box_id);
        const removeBtn = canDeleteRow
          ? `<span onclick="mvOutUnscanBox(${b.box_id})"
                   title="Remove this box from the voucher — it goes back to in-stock and can be re-scanned"
                   style="cursor:pointer;color:#dc2626;font-weight:800;padding:0 4px;margin-left:4px;border-radius:3px"
                   onmouseover="this.style.background='rgba(220,38,38,.15)'"
                   onmouseout="this.style.background='transparent'">×</span>`
          : '';
        return `<div style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;
                     background:rgba(13,148,136,.08);border:1px solid rgba(13,148,136,.25);
                     border-radius:12px;font-family:monospace;font-size:10.5px;color:#0d9488;
                     font-weight:700">
                  ${_escHtml(display)}${removeBtn}
                </div>`;
      }).join(' ');
      return `<div style="display:flex;flex-wrap:wrap;gap:5px;padding:10px 14px;
                   background:rgba(13,148,136,.03);border-top:1px dashed var(--hbdr,rgba(0,0,0,.07))">
                ${chips}
              </div>`;
    }

    tbody.innerHTML = items.map((r,i) => {
      const boxCount = Array.isArray(r.boxes) ? r.boxes.length : 0;
      const detailRowId = `mvout-boxes-row-${r.item_id}`;
      const chevron = (boxCount > 0)
        ? `<span onclick="mvOutToggleBoxes('${detailRowId}', this)"
                 title="Show / hide individual scanned boxes (${boxCount})"
                 style="cursor:pointer;margin-right:6px;color:#0d9488;font-weight:800;
                        display:inline-block;width:14px;text-align:center;user-select:none">▸</span>`
        : `<span style="display:inline-block;width:14px"></span>`;
      return `
      <tr>
        <td style="text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">${i+1}</td>
        <td>
          <strong>${r.product_name}</strong>
          ${r.product_code ? `<br><span style="font-family:monospace;font-size:9.5px;color:#888">${r.product_code}</span>` : ''}
          <br><span style="font-size:9.5px;color:#999">[${r.pm_type}]${r.brand_name?' · '+r.brand_name:''}</span>
        </td>
        <td style="text-align:right;font-family:monospace">
          ${chevron}${canEditQty
            ? `<input type="number" min="0" step="1" value="${r.no_of_box}" onchange="mvOutEditLine(${r.item_id},'no_of_box',this.value)" style="width:70px;text-align:right;background:var(--hinput,#fff);border:1px solid var(--hbdr,#ddd);border-radius:4px;padding:4px 8px;font-family:monospace;font-size:12px">`
            : `<strong>${r.no_of_box}</strong>`}
        </td>
        <td style="text-align:right;font-family:monospace">
          ${canEditQty ? `<input type="number" min="0" step="0.001" value="${r.per_box_qty}" onchange="mvOutEditLine(${r.item_id},'per_box_qty',this.value)" style="width:90px;text-align:right;background:var(--hinput,#fff);border:1px solid var(--hbdr,#ddd);border-radius:4px;padding:4px 8px;font-family:monospace;font-size:12px">`
            : (r.per_box_qty||0).toLocaleString('en-IN')}
        </td>
        <td style="text-align:right;font-family:monospace;font-weight:800;color:var(--teal,#0d9488)">${(r.total_qty||0).toLocaleString('en-IN')}</td>
        <td>
          <input type="text" value="${_escHtml(r.remarks||'')}" maxlength="255"
                 placeholder="add note…"
                 onchange="mvOutEditLine(${r.item_id},'remarks',this.value)"
                 style="width:150px;background:var(--hinput,#fff);border:1px solid var(--hbdr,#ddd);border-radius:4px;padding:4px 8px;font-size:11px;font-family:inherit;color:var(--htxtb,#111)">
        </td>
        <td style="text-align:center">
          ${canDeleteRow ? `<button onclick="mvOutDeleteLine(${r.item_id})" style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer" title="Remove this product from the voucher">🗑</button>` : ''}
        </td>
      </tr>
      <tr id="${detailRowId}" style="display:none">
        <td colspan="7" style="padding:0">${_boxChipsHtml(r)}</td>
      </tr>`;
    }).join('');
  }

  const totBoxes = items.reduce((s,r) => s + (r.no_of_box||0), 0);
  const totQty   = items.reduce((s,r) => s + (r.total_qty||0), 0);
  setText('mvout-tot-boxes',    totBoxes);
  setText('mvout-tot-products', items.length);
  setText('mvout-tot-qty',      totQty.toLocaleString('en-IN'));

  const saveBtn   = document.getElementById('mvout-save-btn');
  const cancelBtn = document.getElementById('mvout-cancel-btn');
  const printBtn  = document.getElementById('mvout-print-btn');
  if(saveBtn){
    if(_mvOut.status === 'out_started'){
      saveBtn.style.display = '';
      saveBtn.disabled = items.length === 0;
      saveBtn.style.opacity = items.length === 0 ? '.5' : '1';
    } else { saveBtn.style.display = 'none'; }
  }
  if(cancelBtn) cancelBtn.style.display = (_mvOut.status === 'out_started') ? '' : 'none';
  if(printBtn)  printBtn.style.display = (_mvOut.status !== 'out_started') ? '' : 'none';

  const banner = document.getElementById('mvout-status-banner');
  if(banner){
    if(_mvOut.status === 'out_started'){
      banner.innerHTML = `<strong>DRAFT</strong> · Stock will not change until you click Save Voucher`;
      banner.style.cssText += ';background:rgba(245,158,11,.10);border-left-color:#f59e0b;color:#92400e';
    } else if(_mvOut.has_discrepancy){
      banner.innerHTML = `⚠ <strong>DISCREPANCY</strong> · IN counts don't match OUT. Reconcile required.`;
      banner.style.cssText += ';background:rgba(220,38,38,.10);border-left-color:#dc2626;color:#991b1b';
    } else if(_mvOut.status === 'in_pending'){
      banner.innerHTML = `<strong>IN-TRANSIT</strong> · Source stock decremented · Awaiting destination IN`;
      banner.style.cssText += ';background:rgba(59,130,246,.10);border-left-color:#3b82f6;color:#1e40af';
    } else if(_mvOut.status === 'received'){
      banner.innerHTML = `✓ <strong>COMPLETE</strong> · IN matched OUT`;
      banner.style.cssText += ';background:rgba(22,163,74,.10);border-left-color:#16a34a;color:#15803d';
    } else {
      banner.innerHTML = `<strong>${(_mvOut.status||'').toUpperCase()}</strong>`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP-AWARE SCAN ROUTING
   ─────────────────────────────────────────────────────────────────────────
   When operator scans a code, it could be either:
   • A box code:    BEARTUBE12-G0234-B003   (existing flow)
   • A group/bag:   BAG-PLIXTRAY40-G0068-L001
   This helper detects the prefix and either:
   • Forwards to the existing /scan_box endpoint (single box), OR
   • Looks up the group, iterates each member through /scan_box, then
     calls /scan_complete to update group state + write the audit row.

   Returns:
     {ok:true, single:true,  result}                  — single-box scan ok
     {ok:false,single:true,  message, code, fifo?}    — single-box scan failed
     {ok:true, single:false, group, succeeded, failed}— group scan complete
     {ok:false,single:false, message}                 — group lookup failed
═══════════════════════════════════════════════════════════════════════════ */

// Group code shape: BAG-<PRODUCTCODE>-<G####|OP####>-L###
const _BAG_RX = /^BAG-[A-Z0-9]{1,12}-(?:G|OP)\d{3,5}-L\d{2,4}$/;

// ── Helper: overscan check used by both OUT scan handlers ──────────
//
// Examines the request_target object returned by api_voucher_scan_box. If
// the scan put us over the requested qty for this product (or the box's
// product wasn't on the request at all), we show a blocking modal:
// "Continue anyway?" — clicking Yes sets a sticky ack flag so we don't
// nag the operator again for the same product within this OUT session.
//
// Sticky ack lives on window._mvOutOverscanAck (Set). It's keyed by
// product_id for qty-exceeded warnings, and by 'NOT_IN_'+pid for the
// not-on-request warning so the two ack states stay independent.
function _mvOutCheckRequestOverscan(result){
  const rt = result && result.request_target;
  if(!rt) return;
  window._mvOutOverscanAck = window._mvOutOverscanAck || new Set();
  const pid   = result.box.product_id;
  const pname = result.box.product_name || ('#'+pid);
  if(rt.not_in_request){
    if(window._mvOutOverscanAck.has('NOT_IN_'+pid)) return;
    _showRequestOverscanModal({
      kind:        'not_in_request',
      productName: pname,
      productId:   pid,
      scannedQty:  rt.qty_scanned_so_far,
    });
  } else if(rt.exceeded){
    if(window._mvOutOverscanAck.has(pid)) return;
    _showRequestOverscanModal({
      kind:         'qty_exceeded',
      productName:  pname,
      productId:    pid,
      requestedQty: rt.qty_remaining_at_start,
      scannedQty:   rt.qty_scanned_so_far,
      overBy:       rt.over_by,
    });
  }
}

// Renders / shows the overscan confirmation modal. Two variants:
//   - kind='qty_exceeded': "scanned X but only Y requested. Continue?"
//   - kind='not_in_request': "this product wasn't on the request. Continue?"
//
// User actions:
//   - "Yes, continue scanning"  → set sticky ack, close modal, focus scan input
//   - "Stop here"               → close modal, blur scan input (operator
//                                  decides what to do — typically removes
//                                  the just-scanned box via the chip ✕)
function _showRequestOverscanModal(opts){
  const fmtN = n => (Number(n)||0).toLocaleString('en-IN');
  let modal = document.getElementById('reqOverscanModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'reqOverscanModal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'z-index:1200';  // above OUT modal + fifo modal
    modal.innerHTML = `
      <div class="modal" style="width:520px;max-width:95vw;background:var(--surface,#fff);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.35);overflow:hidden">
        <div style="padding:18px 22px;background:#f59e0b;color:#fff;display:flex;align-items:center;gap:12px">
          <div style="font-size:28px">⚠️</div>
          <div style="flex:1">
            <div id="ros-title" style="font-size:15px;font-weight:800;letter-spacing:.2px">Request limit reached</div>
            <div id="ros-sub" style="font-size:11px;opacity:.95;margin-top:2px"></div>
          </div>
        </div>
        <div id="ros-body" style="padding:18px 22px;font-size:13px;color:var(--htxtb,#111);line-height:1.55"></div>
        <div style="padding:12px 22px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));display:flex;justify-content:flex-end;gap:8px;background:var(--hsurf2,#f8fafc)">
          <button id="ros-stop"     class="btn btn-outline btn-sm">⏸ Stop here</button>
          <button id="ros-continue" class="btn btn-primary btn-sm" style="background:#f59e0b;border-color:#f59e0b">Yes, continue scanning</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  const title = document.getElementById('ros-title');
  const sub   = document.getElementById('ros-sub');
  const body  = document.getElementById('ros-body');
  if(opts.kind === 'qty_exceeded'){
    title.textContent = '⚠ Scanned qty exceeds requested qty';
    sub.textContent   = `Product: ${opts.productName}`;
    body.innerHTML    = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div style="padding:10px;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.30);border-radius:8px">
          <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Requested</div>
          <div style="font-size:18px;font-weight:800;color:#92400e;font-variant-numeric:tabular-nums">${fmtN(opts.requestedQty)}</div>
        </div>
        <div style="padding:10px;background:rgba(220,38,38,.10);border:1px solid rgba(220,38,38,.30);border-radius:8px">
          <div style="font-size:10px;color:var(--hmuted2,#6b7280);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Scanned so far</div>
          <div style="font-size:18px;font-weight:800;color:#7f1d1d;font-variant-numeric:tabular-nums">${fmtN(opts.scannedQty)}</div>
        </div>
      </div>
      <div style="padding:10px 12px;background:rgba(220,38,38,.05);border-left:3px solid #dc2626;border-radius:5px;color:#7f1d1d;font-size:12px">
        Over by <strong>${fmtN(opts.overBy)}</strong>. You can continue scanning beyond the request, OR stop here and remove this box (click the ✕ on its chip).
      </div>`;
  } else if(opts.kind === 'not_in_request'){
    title.textContent = '⚠ Product not on this request';
    sub.textContent   = `Product: ${opts.productName}`;
    body.innerHTML    = `
      <div style="padding:10px 12px;background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;border-radius:5px;color:#92400e;font-size:12.5px;line-height:1.55">
        The box you just scanned is for a product that <strong>wasn't on this Material Request</strong>.
        If this is intentional (the request needed adjusting), continue scanning; otherwise stop and remove the box.
      </div>`;
  }
  modal.classList.add('open');

  const goStop = () => {
    modal.classList.remove('open');
    const el = document.getElementById('mvout-scan-input');
    if(el) el.blur();
  };
  const goContinue = () => {
    window._mvOutOverscanAck = window._mvOutOverscanAck || new Set();
    if(opts.kind === 'qty_exceeded')   window._mvOutOverscanAck.add(opts.productId);
    if(opts.kind === 'not_in_request') window._mvOutOverscanAck.add('NOT_IN_'+opts.productId);
    modal.classList.remove('open');
    setTimeout(() => {
      const el = document.getElementById('mvout-scan-input');
      if(el) el.focus();
    }, 50);
  };
  document.getElementById('ros-stop').onclick     = goStop;
  document.getElementById('ros-continue').onclick = goContinue;
}

// Reset the overscan ack set when a new OUT modal opens, so the modal
// re-prompts on the FIRST overscan of every new fulfillment session.
function _resetOverscanAck(){
  window._mvOutOverscanAck = new Set();
}


async function _scanCodeWithGroupSupport(transferId, code, side){
  const c = (code || '').trim().toUpperCase();
  if(!c) return {ok:false, single:true, message:'Empty code'};

  // Not a bag — fall through to the original single-box endpoint.
  if(!_BAG_RX.test(c)){
    try {
      const r = await fetch(`/api/pm_stock/transfers/voucher/${transferId}/scan_box`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({box_code: c, side})
      });
      const d = await r.json();
      if(d.status === 'ok') return {ok:true, single:true, result:d, autoCorrected: d.auto_corrected === true};
      return {ok:false, single:true, message:d.message, code:d.code, fifo:d.fifo,
              box_id:d.box_id, pending:d.pending};
    } catch(e){
      return {ok:false, single:true, message:'Network error: '+e.message};
    }
  }

  // Bag — look up the group, iterate members.
  let group, members;
  try {
    const r = await fetch(`/api/pm_stock/groups/by_code?code=${encodeURIComponent(c)}`);
    const d = await r.json();
    if(d.status !== 'ok'){
      return {ok:false, single:false,
        message:d.message || `Group ${c} not found`};
    }
    group   = d.group;
    members = d.members || [];
  } catch(e){
    return {ok:false, single:false, message:'Group lookup error: '+e.message};
  }
  if(!members.length){
    return {ok:false, single:false, message:`Group ${c} has no members`};
  }

  // Walk members. Permissive — collect successes and failures, never abort.
  const succeeded = [];
  const failed    = [];
  let _bagAutoCorrected = 0;     // count of members auto-healed during bag walk
  for(const m of members){
    try {
      const r = await fetch(`/api/pm_stock/transfers/voucher/${transferId}/scan_box`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({box_code: m.box_code, side})
      });
      const d = await r.json();
      if(d.status === 'ok'){
        succeeded.push({box_code: m.box_code, product_name: d.box?.product_name});
        if(d.auto_corrected === true) _bagAutoCorrected++;
      } else {
        failed.push({box_code: m.box_code, reason: d.message || 'Failed',
                     code: d.code || null});
      }
    } catch(e){
      failed.push({box_code: m.box_code, reason: 'Network error: '+e.message});
    }
  }

  // Tell the backend we're done — it recomputes group status and writes
  // ONE audit entry covering the whole group scan (rather than N individual
  // scan-box audit rows that would clutter the log).
  try {
    await fetch(`/api/pm_stock/groups/${group.group_id}/scan_complete`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        tid:       transferId,
        side:      side,
        succeeded: succeeded.map(s => s.box_code),
        failed:    failed,
      })
    });
  } catch(e){
    // Non-fatal — the per-box scans already ran. We just lose the
    // group-level status refresh + the consolidated audit row.
    console.warn('[group-scan] scan_complete failed:', e);
  }

  return {ok:true, single:false, group, succeeded, failed,
          autoCorrectedCount: _bagAutoCorrected};
}

/* ── Toast/modal renderer for group-scan summary ─────────────────────────
   For full-success groups we just show a single success toast.
   For mixed/failed groups we show a small modal listing what failed and
   why, so the operator can investigate (and rescan individual boxes if
   the group's still in a usable state).
*/
function _showGroupScanSummary(result, side){
  const {group, succeeded, failed, autoCorrectedCount} = result;
  const total = succeeded.length + failed.length;
  if(failed.length === 0){
    _voiceSay(`All ${succeeded.length} added`);
    showToast(
      `🛍️ Bag ${group.group_code}: all ${succeeded.length} boxes scanned for ${side.toUpperCase()}`,
      'success', 4000
    );
    if(autoCorrectedCount > 0){
      // Bag had at least one box whose location row was stale and got healed.
      showToast(
        `🔧 ${autoCorrectedCount} box${autoCorrectedCount===1?'':'es'} in this bag had stale locations — auto-corrected from ledger`,
        'info', 4500
      );
    }
    return;
  }
  // Some failures — announce the partial result so operator knows to look
  _voiceSay(`${succeeded.length} added, ${failed.length} not added`);
  // Build a modal listing the failures
  let modal = document.getElementById('groupScanResultModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'groupScanResultModal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  const failRows = failed.map(f =>
    `<div style="padding:7px 12px;border-top:1px solid var(--border,rgba(0,0,0,.06));font-size:11.5px">
       <div style="font-family:var(--font-mono,monospace);font-weight:700;color:var(--text,#0f172a)">${f.box_code}</div>
       <div style="color:#b91c1c;font-size:10.5px;margin-top:1px">${(f.reason||'failed').replace(/</g,'&lt;')}</div>
     </div>`).join('');
  modal.innerHTML = `
    <div class="modal" style="max-width:min(96vw,600px);width:min(96vw,600px);
      border-top:3px solid #7c3aed;display:flex;flex-direction:column;max-height:90vh">
      <div class="modal-title" style="display:flex;align-items:center;gap:10px;color:#5b21b6;flex-shrink:0">
        🛍️ Bag scan: partial success
        <span style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--teal,#0d9488);
          background:rgba(13,148,136,.1);padding:2px 8px;border-radius:5px">${group.group_code}</span>
        <button class="modal-close" onclick="this.closest('.modal-overlay').classList.remove('open')" style="margin-left:auto">✕</button>
      </div>
      <div style="overflow-y:auto;padding:6px 4px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
          <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);
            border-radius:8px;padding:10px 14px">
            <div style="font-size:10px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.5px">✓ Scanned</div>
            <div style="font-size:24px;font-weight:800;color:#047857;font-family:var(--font-mono,monospace)">${succeeded.length}</div>
            <div style="font-size:10px;color:var(--text2,#475569)">of ${total} member boxes</div>
          </div>
          <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);
            border-radius:8px;padding:10px 14px">
            <div style="font-size:10px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.5px">✗ Failed</div>
            <div style="font-size:24px;font-weight:800;color:#b91c1c;font-family:var(--font-mono,monospace)">${failed.length}</div>
            <div style="font-size:10px;color:var(--text2,#475569)">need investigation</div>
          </div>
        </div>
        <div style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:8px;
          background:#fff;overflow:hidden">
          <div style="padding:7px 12px;background:rgba(239,68,68,.06);font-size:10px;
            font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.5px">
            Failed boxes
          </div>
          ${failRows}
        </div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border,rgba(0,0,0,.1));
        display:flex;justify-content:flex-end">
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').classList.remove('open')"
          style="padding:7px 18px">Got it</button>
      </div>
    </div>`;
  modal.classList.add('open');
}

async function mvOutHandleScanInput(ev){
  if(ev && ev.type === 'keydown' && ev.key !== 'Enter') return;
  const inp = document.getElementById('mvout-scan-input');
  const code = (inp.value || '').trim().toUpperCase();
  if(!code) return;
  inp.value = '';
  if(!_mvOut){ showToast('No active voucher','error'); return; }
  try {
    // Group-aware: if the scanner sees a BAG-... code, it iterates the
    // group's members through /scan_box. Otherwise this is just a regular
    // single-box scan with the same return shape as before.
    const result = await _scanCodeWithGroupSupport(_mvOut.transfer_id, code, 'out');
    if(result.single){
      if(!result.ok){
        if(result.code === 'fifo_violation' && result.fifo){
          _showFifoViolationModal(result.fifo, code, _mvOut.transfer_id);
          return;
        }
        if(result.code === 'fifo_override_requestable' && result.fifo){
          _showFifoViolationModal(result.fifo, code, _mvOut.transfer_id, result.box_id, result.pending);
          return;
        }
        _voiceNotScanned();
        showToast(result.message || 'Scan failed','error', 4000);
        setTimeout(() => {
          const el = document.getElementById('mvout-scan-input');
          if(el) el.focus();
        }, 50);
        return;
      }
      _voiceScanned();
      showToast(`✓ ${result.result.box.product_name} +1 box`, 'success', 2000);
      // Show an info toast when the backend silently healed the box's
      // location row. The scan still succeeded, but the operator should
      // know that the system corrected a drift behind the scenes — so
      // they can investigate if it keeps happening (sign of a real bug
      // somewhere else in the flow).
      if(result.autoCorrected){
        showToast(
          `🔧 Box location auto-corrected — the box's stored location was stale, healed from ledger`,
          'info', 4500
        );
      }
      _mvOutCheckRequestOverscan(result.result);
    } else {
      // Group scan completed (possibly with some failures)
      _showGroupScanSummary(result, 'out');
    }
    await mvOpenOutVoucher(_mvOut.transfer_id);
  } catch(e){
    showToast('Error: '+e.message,'error');
  }
  // Re-fetch the input AFTER mvOpenOutVoucher rebuilds the modal — without
  // this, focus() lands on a detached node and the next handheld burst
  // gets swallowed (see "scanning stopped" debugging notes).
  setTimeout(() => {
    const el = document.getElementById('mvout-scan-input');
    if(el) el.focus();
  }, 50);
}

/* ── FIFO violation modal ────────────────────────────────────────────
   Shown when the server rejects an OUT scan because an older FIFO lot
   still has stock at this source location. Tells the operator exactly
   which lot to pull next + how many boxes are pending.

   For admins, offers a "Force send anyway" button that re-sends the
   scan with `force_fifo_override: true`. The override is logged on the
   transfer's audit history. Non-admins see only an OK button.
─────────────────────────────────────────────────────────────────────── */
function _showFifoViolationModal(fifo, scannedCode, transferId, boxId, pending){
  const isAdminUser = (typeof _isAdmin === 'function') ? _isAdmin() : false;
  let modal = document.getElementById('fifoViolationModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'fifoViolationModal';
    modal.className = 'modal-overlay';
    // Sit above the OUT modal (z-index 1050) but below the toast (99999).
    modal.style.cssText = 'z-index:1100';
    modal.innerHTML = `
      <div class="modal" style="width:480px;max-width:95vw;background:var(--surface,#fff);
        border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.35);overflow:hidden">
        <div id="fvm-header" style="padding:18px 22px;background:#dc2626;color:#fff;
          display:flex;align-items:center;gap:12px">
          <div style="font-size:28px">🚫</div>
          <div style="flex:1">
            <div style="font-size:15px;font-weight:800;letter-spacing:.2px">FIFO VIOLATION</div>
            <div style="font-size:11px;opacity:.9;margin-top:2px">An older lot must be sent first.</div>
          </div>
          <button onclick="document.getElementById('fifoViolationModal').classList.remove('open')"
            style="background:rgba(255,255,255,.2);border:none;color:#fff;width:30px;height:30px;
              border-radius:50%;font-size:18px;cursor:pointer;line-height:1">✕</button>
        </div>
        <div id="fvm-body" style="padding:20px 22px"></div>
        <div id="fvm-footer" style="padding:12px 20px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));
          background:var(--hsurf2,#f9fafb);display:flex;gap:10px;justify-content:flex-end"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  const body = modal.querySelector('#fvm-body');
  const footer = modal.querySelector('#fvm-footer');

  const sf = fifo.scanned_fifo_code || '(no FIFO)';
  const of = fifo.oldest_fifo_code  || '(no FIFO)';
  const fmtDate = (s) => {
    if(!s) return '';
    const p = String(s).slice(0,10).split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
  };
  // ── Tiny helper: render the metadata block (voucher / supplier / date)
  // for one side of the modal. Used twice — once for the scanned lot,
  // once for the oldest pending lot. Each row is hidden when the data
  // isn't available (e.g. supplier blank for an OP lot).
  const renderMetaRows = (voucher, supplier, dateStr, accentColor) => {
    const rows = [];
    if(voucher){
      rows.push(`
        <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed rgba(0,0,0,.06)">
          <span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">GRN No</span>
          <strong style="font-family:monospace;color:${accentColor};font-size:11px;text-align:right">${voucher}</strong>
        </div>`);
    }
    if(dateStr){
      rows.push(`
        <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed rgba(0,0,0,.06)">
          <span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">Inward Date</span>
          <strong style="font-size:11px;text-align:right">${fmtDate(dateStr)}</strong>
        </div>`);
    }
    if(supplier){
      rows.push(`
        <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0">
          <span style="color:var(--muted,#9ca3af);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">Supplier</span>
          <strong style="font-size:11px;text-align:right;line-height:1.3">${supplier}</strong>
        </div>`);
    }
    return rows.length
      ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,.6);border-radius:6px;text-align:left">${rows.join('')}</div>`
      : '';
  };
  const scannedMeta = renderMetaRows(
    fifo.scanned_voucher,
    fifo.scanned_supplier,
    fifo.scanned_date,
    '#dc2626'
  );
  const oldestMeta = renderMetaRows(
    fifo.oldest_voucher,
    fifo.oldest_supplier,
    fifo.oldest_date,
    '#0d9488'
  );

  body.innerHTML = `
    <div style="font-size:13px;color:var(--text,#111);margin-bottom:16px;line-height:1.5">
      You scanned a box from lot <strong style="font-family:monospace;color:#dc2626">${sf}</strong>,
      but this product still has older stock at this location.
      <strong>Send the older lot first.</strong>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
      <div style="background:rgba(220,38,38,.06);border:1.5px solid rgba(220,38,38,.25);
        border-radius:10px;padding:12px 14px">
        <div style="text-align:center">
          <div style="font-size:9px;font-weight:800;color:#991b1b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">You scanned</div>
          <div style="font-family:monospace;font-size:24px;font-weight:900;color:#dc2626;line-height:1">${sf}</div>
          <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);margin-top:6px;font-family:monospace">${scannedCode || ''}</div>
        </div>
        ${scannedMeta}
      </div>
      <div style="background:rgba(13,148,136,.06);border:1.5px solid rgba(13,148,136,.35);
        border-radius:10px;padding:12px 14px">
        <div style="text-align:center">
          <div style="font-size:9px;font-weight:800;color:#0d9488;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Send these first</div>
          <div style="font-family:monospace;font-size:24px;font-weight:900;color:#0d9488;line-height:1">${of}</div>
          <div style="font-size:11px;color:var(--text,#111);margin-top:6px;font-weight:700">
            ${fifo.oldest_box_count} box${fifo.oldest_box_count===1?'':'es'} ·
            ${(Number(fifo.oldest_total_qty)||0).toLocaleString('en-IN')} pcs
          </div>
        </div>
        ${oldestMeta}
      </div>
    </div>

    <div style="margin-top:14px;padding:10px 12px;background:rgba(245,158,11,.08);
      border-left:3px solid #f59e0b;border-radius:4px;font-size:11.5px;color:#92400e;line-height:1.5">
      💡 Look for boxes with the FIFO number <strong style="font-family:monospace">${of}</strong>
      printed below the QR code. Send all ${fifo.oldest_box_count} of them before scanning ${sf}.
    </div>
  `;

  let footerHtml = `
    <button onclick="document.getElementById('fifoViolationModal').classList.remove('open')"
      class="btn btn-primary" style="background:#0d9488;border-color:#0d9488;color:#fff;
        padding:8px 22px;font-weight:700">OK</button>`;
  if(isAdminUser){
    footerHtml = `
      <button onclick="_fifoForceOverride('${(scannedCode||'').replace(/'/g,'')}', ${transferId})"
        class="btn btn-outline" style="border-color:rgba(220,38,38,.4);color:#dc2626;
          padding:8px 16px;font-weight:700"
        title="Admin only — override is logged">⚠ Force send anyway</button>
    ` + footerHtml;
  } else {
    // Non-admin: queue-based override-request flow. Each violating box can
    // be added to a request basket (with its own reason); the operator
    // submits all queued requests to admins at once. If this box already
    // has an open/rejected request, we show that state instead.
    const sc = (scannedCode || '').replace(/'/g, '');
    window._fifoOverrideQueue = window._fifoOverrideQueue || [];
    // Stash the box this modal is currently showing, so submit can auto-add
    // it if the operator typed a reason but didn't tap "Add to request list".
    window._fifoCurrentBox = (boxId && pending?.status !== 'pending')
      ? { box_id: boxId, box_code: scannedCode } : null;
    if(pending && pending.status === 'pending'){
      body.insertAdjacentHTML('beforeend', `
        <div style="margin-top:14px;padding:11px 13px;background:rgba(13,148,136,.07);
          border:1px solid rgba(13,148,136,.3);border-radius:8px;font-size:12px;color:#0f766e;line-height:1.5">
          ⏳ You already requested an override for this box (request <strong>#${pending.req_id}</strong>).
          It's waiting for an admin. Re-scan this box once it's approved.
        </div>`);
    } else {
      if(pending && pending.status === 'rejected'){
        body.insertAdjacentHTML('beforeend', `
          <div style="margin-top:14px;padding:11px 13px;background:rgba(220,38,38,.06);
            border:1px solid rgba(220,38,38,.25);border-radius:8px;font-size:12px;color:#991b1b;line-height:1.5">
            ✗ A previous override request for this box (#${pending.req_id}) was rejected. You can submit a new one with more detail.
          </div>`);
      }
      const alreadyQueued = window._fifoOverrideQueue.some(q => q.box_id === boxId);
      body.insertAdjacentHTML('beforeend', `
        <div id="fvm-request-block" style="margin-top:14px">
          <label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;
            letter-spacing:.5px;color:var(--hmuted2,#6b7280);margin-bottom:5px">
            Reason for this box's override *
          </label>
          <textarea id="fvm-reason" rows="2" ${alreadyQueued ? 'disabled' : ''}
            placeholder="e.g. older lot is damaged / customer-specific batch / physically unavailable"
            style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--hbdr,rgba(0,0,0,.18));
              border-radius:7px;font-size:12.5px;font-family:inherit;resize:vertical">${alreadyQueued ? (window._fifoOverrideQueue.find(q=>q.box_id===boxId)?.reason || '') : ''}</textarea>
          ${alreadyQueued ? `<div style="font-size:11px;color:#0f766e;margin-top:5px">✓ This box is already in your request list.</div>` : ''}
        </div>
        <div id="fvm-queue-summary" style="margin-top:10px"></div>`);
      footerHtml = `
        <button onclick="document.getElementById('fifoViolationModal').classList.remove('open')"
          class="btn btn-outline" style="padding:8px 16px;font-weight:600">Close</button>
        ${alreadyQueued ? '' : `
        <button id="fvm-add-btn"
          onclick="_fifoQueueAdd('${sc}', ${transferId}, ${boxId || 'null'})"
          class="btn btn-outline" style="border-color:rgba(245,158,11,.5);color:#d97706;
            padding:8px 16px;font-weight:700"
          title="Add this box to your override request list">＋ Add to request list</button>`}
        <button id="fvm-submit-btn"
          onclick="_fifoQueueSubmit(${transferId})"
          class="btn btn-primary" style="background:#f59e0b;border-color:#f59e0b;color:#fff;
            padding:8px 18px;font-weight:700"
          title="Send all queued override requests to an admin">📨 Submit requests</button>`;
    }
  }
  footer.innerHTML = footerHtml;
  // Render the running queue summary (if the non-admin block is present)
  if(typeof _fifoRenderQueueSummary === 'function') _fifoRenderQueueSummary();
  modal.classList.add('open');
}

/* ── Non-admin bulk override-request queue ───────────────────────────────
   Boxes that fail FIFO are collected into window._fifoOverrideQueue, each
   with its own reason. The operator submits them all to admins in one
   request_bulk call. After submission the queue is cleared; the operator
   re-scans each approved box individually to push the OUT through. */
window._fifoOverrideQueue = window._fifoOverrideQueue || [];

function _fifoRenderQueueSummary(){
  const host = document.getElementById('fvm-queue-summary');
  if(!host) return;
  const q = window._fifoOverrideQueue || [];
  if(!q.length){ host.innerHTML = ''; return; }
  const rows = q.map((item, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;
      border-top:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:11.5px">
      <span style="font-family:monospace;font-weight:700;color:var(--text,#0f172a);flex:0 0 auto">${item.box_code}</span>
      <span style="color:var(--hmuted,#9ca3af);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(item.reason||'').replace(/</g,'&lt;')}</span>
      <button onclick="_fifoQueueRemove(${i})" title="Remove from list"
        style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto">✕</button>
    </div>`).join('');
  host.innerHTML = `
    <div style="border:1px solid rgba(245,158,11,.35);border-radius:8px;overflow:hidden;background:rgba(245,158,11,.04)">
      <div style="padding:6px 10px;background:rgba(245,158,11,.1);font-size:10px;font-weight:800;
        color:#92400e;text-transform:uppercase;letter-spacing:.5px">
        Override request list · ${q.length} box${q.length===1?'':'es'}
      </div>
      ${rows}
    </div>`;
  const sb = document.getElementById('fvm-submit-btn');
  if(sb) sb.textContent = `📨 Submit ${q.length} request${q.length===1?'':'s'}`;
}

function _fifoQueueAdd(scannedCode, transferId, boxId){
  if(!boxId){ showToast('Could not identify the box — please re-scan','error', 3500); return; }
  const ta = document.getElementById('fvm-reason');
  const reason = (ta && ta.value || '').trim();
  if(!reason){
    showToast('Enter a reason before adding this box','error', 3500);
    if(ta) ta.focus();
    return;
  }
  window._fifoOverrideQueue = window._fifoOverrideQueue || [];
  if(window._fifoOverrideQueue.some(q => q.box_id === boxId)){
    showToast('This box is already in your request list','info', 2500);
    return;
  }
  window._fifoOverrideQueue.push({ box_id: boxId, box_code: scannedCode, reason });
  showToast(`＋ ${scannedCode} added to override request list`, 'success', 2500);
  // Close so the operator can keep scanning more boxes; their violations
  // re-open this modal and the queue persists.
  document.getElementById('fifoViolationModal')?.classList.remove('open');
  setTimeout(() => {
    const el = document.getElementById('mvout-scan-input');
    if(el) el.focus();
  }, 50);
}

function _fifoQueueRemove(idx){
  if(!window._fifoOverrideQueue) return;
  window._fifoOverrideQueue.splice(idx, 1);
  _fifoRenderQueueSummary();
  if(!window._fifoOverrideQueue.length){
    const sb = document.getElementById('fvm-submit-btn');
    if(sb) sb.textContent = '📨 Submit requests';
  }
}

async function _fifoQueueSubmit(transferId){
  // Auto-add the current modal's box if the operator typed a reason but
  // never tapped "Add to request list".
  const ta = document.getElementById('fvm-reason');
  const cur = window._fifoCurrentBox;
  if(ta && !ta.disabled && cur && cur.box_id){
    const reason = (ta.value || '').trim();
    const already = (window._fifoOverrideQueue || []).some(q => q.box_id === cur.box_id);
    if(reason && !already){
      window._fifoOverrideQueue = window._fifoOverrideQueue || [];
      window._fifoOverrideQueue.push({ box_id: cur.box_id, box_code: cur.box_code, reason });
    }
  }
  const q = window._fifoOverrideQueue || [];
  if(!q.length){
    showToast('Enter a reason and add at least one box first','error', 3500);
    if(ta && !ta.disabled) ta.focus();
    return;
  }
  const btn = document.getElementById('fvm-submit-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await fetch('/api/pm_stock/fifo_override/request_bulk', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        transfer_id: transferId,
        items: q.map(x => ({ box_id: x.box_id, reason: x.reason }))
      })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      const created = d.created || 0;
      const skipped = d.skipped || 0;
      let msg = `📨 ${created} override request${created===1?'':'s'} sent to admin`;
      if(skipped) msg += ` · ${skipped} skipped`;
      showToast(msg, 'success', 4500);
      window._fifoOverrideQueue = [];
      window._fifoCurrentBox = null;
      document.getElementById('fifoViolationModal')?.classList.remove('open');
      if(typeof refreshFifoOverrideBadge === 'function') refreshFifoOverrideBadge();
    } else {
      showToast(d.message || 'Request failed','error', 4500);
      if(btn){ btn.disabled = false; _fifoRenderQueueSummary(); }
    }
  } catch(e){
    showToast('Network error: '+(e.message||e),'error', 4500);
    if(btn){ btn.disabled = false; _fifoRenderQueueSummary(); }
  }
}

async function _fifoForceOverride(scannedCode, transferId){
  if(!confirm('Override FIFO and send this newer-lot box anyway?\n\nThis will be logged on the transfer\'s audit history. Make sure you have a real reason (damaged old stock, customer-specific batch, etc.) — production traceability depends on FIFO discipline.')){
    return;
  }
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${transferId}/scan_box`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ box_code: scannedCode, side: 'out', force_fifo_override: true })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`⚠ FIFO override · ${d.box.product_name} +1 box (logged)`, 'success', 3500);
      document.getElementById('fifoViolationModal')?.classList.remove('open');
      if(_mvOut) mvOpenOutVoucher(_mvOut.transfer_id);
    } else {
      showToast(d.message || 'Override failed','error', 4500);
    }
  } catch(e){
    showToast('Network error: '+(e.message||e),'error', 4500);
  }
}

// Extract the first valid box code from arbitrary scanner input.
// Scanners can append \r\n, send tab-separated payloads, or carry JSON
// envelopes from legacy labels. We accept any of these and pull the
// first PRODUCT-G/OPnnnn-Bnnn token.
function _extractBoxCode(raw){
  const RE = /\b[A-Z0-9]{1,12}-(?:G|OP)\d{3,5}-B\d{2,4}\b/i;
  const s  = String(raw || '').toUpperCase();
  // Direct match anywhere in the string
  const m  = s.match(RE);
  if(m) return m[0].toUpperCase();
  // Fall back: try parsing as JSON and look at common keys
  try {
    const idx = s.indexOf('{');
    if(idx >= 0){
      const obj = JSON.parse(s.slice(idx));
      for(const k of ['box_code','code','boxCode','box']){
        if(obj && obj[k] && RE.test(obj[k])) return String(obj[k]).toUpperCase();
      }
    }
  } catch(_){}
  return '';
}

async function mvOutEditLine(itemId, field, value){
  if(!_mvOut) return;
  const body = {};
  if(field === 'no_of_box')   body.no_of_box   = parseInt(value)||0;
  if(field === 'per_box_qty') body.per_box_qty = parseFloat(value)||0;
  if(field === 'remarks')     body.remarks     = String(value||'');
  // Remarks edits are silent (no full reload) so the fulfiller can keep
  // typing across rows without the table flashing/refetching each blur.
  const silent = (field === 'remarks');
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${_mvOut.transfer_id}/lines/${itemId}`,{
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await res.json();
    if(d.status === 'ok'){
      if(silent){
        // Reflect locally without a reload.
        const it = (_mvOut.items||[]).find(x => x.item_id === itemId);
        if(it) it.remarks = body.remarks;
        showToast('✓ Note saved','success',1200);
      } else {
        showToast('✓ Updated','success',1500);
        mvOpenOutVoucher(_mvOut.transfer_id);
      }
    } else showToast(d.message || 'Update failed','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

async function mvOutDeleteLine(itemId){
  if(!_mvOut) return;
  if(!confirm('Remove this line from the voucher?\n\n' +
              'All scanned boxes on this line will be released back to in-stock ' +
              'so you can scan them again later if needed.')) return;
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${_mvOut.transfer_id}/lines/${itemId}`,{method:'DELETE'});
    const d = await res.json();
    if(d.status === 'ok'){ showToast('✓ Removed','success'); mvOpenOutVoucher(_mvOut.transfer_id); }
    else showToast(d.message || 'Delete failed','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

// Toggle the per-row "scanned boxes" detail panel. Pure DOM toggle — no
// server round-trip. The arrow flips ▸ ↔ ▾ to mirror the panel state.
function mvOutToggleBoxes(rowId, arrowEl){
  const tr = document.getElementById(rowId);
  if(!tr) return;
  const shown = tr.style.display !== 'none';
  tr.style.display = shown ? 'none' : '';
  if(arrowEl) arrowEl.textContent = shown ? '▸' : '▾';
}

// Remove ONE scanned box from a draft Material Out voucher. Backed by
// /api/pm_stock/transfers/voucher/<tid>/unscan_box. Server reverts the
// box to in_stock and decrements the line's no_of_box / total_qty (or
// removes the line entirely if this was the last box).
//
// Permission mirror: server gates non-admins to out_started + OUT side,
// matching the line-delete policy. So if the chevron is visible to the
// user, this call should always succeed.
async function mvOutUnscanBox(boxId){
  if(!_mvOut || !boxId) return;
  try {
    const res = await fetch(
      `/api/pm_stock/transfers/voucher/${_mvOut.transfer_id}/unscan_box`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ box_id: boxId })
      }
    );
    const d = await res.json();
    if(d.status === 'ok'){
      const msg = d.line_deleted
        ? '✓ Box removed (line cleared)'
        : `✓ Box removed (${d.remaining_boxes} left on line)`;
      showToast(msg, 'success', 2500);
      mvOpenOutVoucher(_mvOut.transfer_id);
    } else {
      showToast(d.message || 'Remove failed', 'error');
    }
  } catch(e){
    showToast('Error: ' + e.message, 'error');
  }
}

async function mvOutCancelDraft(){
  if(!_mvOut || _mvOut.status !== 'out_started') return;
  if(!confirm(`Cancel draft voucher ${_mvOut.transfer_no}?\nAll scanned boxes will revert to in_stock at source.`)) return;
  try {
    const res = await fetch(`/api/pm_stock/transfers/${_mvOut.transfer_id}/cancel`,{method:'POST'});
    const d = await res.json();
    if(d.status === 'ok'){ showToast(`Cancelled · ${d.reverted_boxes} reverted`,'info'); mvCloseOutVoucher(); }
    else showToast(d.message || 'Cancel failed','error');
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

async function mvOutSaveVoucher(){
  if(!_mvOut) return;
  if(!_mvOut.items || !_mvOut.items.length){ showToast('Add at least one item','error'); return; }
  const tot = _mvOut.items.reduce((s,r) => s + (r.total_qty||0), 0);
  // Allotment vouchers (same source + destination, or explicit type)
  // auto-complete on save — no IN-side handshake. Surface that in the
  // confirm so the user knows what they're committing to.
  const isAllot = (_mvOut.voucher_type === 'allotment')
              || (Number(_mvOut.from_godown_id) === Number(_mvOut.to_godown_id));
  const tail = isAllot
    ? 'Source stock decrements AND boxes are immediately marked consumed at destination (allotment auto-complete — no IN scan needed).'
    : 'Source stock decrements immediately. Destination will scan IN to receive.';
  if(!confirm(`Save voucher ${_mvOut.transfer_no}?\n\n${_mvOut.items.length} product(s) · qty ${tot.toLocaleString('en-IN')}\n${tail}`)) return;
  const btn = document.getElementById('mvout-save-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${_mvOut.transfer_id}/save_out`,{method:'POST'});
    const d = await res.json();
    if(d.status === 'ok'){
      // Server tells us if it auto-completed (allotment) vs left in-transit
      // (regular transfer). Toast accordingly so the user knows the
      // voucher is done — they won't see it in the "in-transit" grid for
      // an allotment because it skipped that state.
      if(d.auto_completed){
        showToast(`✓ ${d.transfer_no} consumed (allotment auto-completed)`, 'success', 4500);
      } else {
        showToast(`✓ ${d.transfer_no} saved · in-transit`, 'success', 4000);
      }
      mvCloseOutVoucher();
      if(typeof loadSummary === 'function') loadSummary();
      // If this OUT was tied to a Material Request, the save_out hook
      // on the server has already written link rows + bumped status.
      // Clear the prefill banner and refresh the MR badge + list so the
      // UI reflects the new fulfillment.
      document.getElementById('mr-prefill-banner')?.remove();
      window._mrPendingPrefill = null;
      if(typeof refreshMrBadge === 'function') refreshMrBadge();
      if(typeof mrLoadList === 'function' && _mmSubTab === 'mr') mrLoadList();
    } else { showToast(d.message || 'Save failed','error'); btn.innerHTML = orig; btn.disabled = false; }
  } catch(e){ showToast('Error: '+e.message,'error'); btn.innerHTML = orig; btn.disabled = false; }
}

/* ────────────── IN-TRANSIT GRID ────────────── */

async function mvLoadInTransit(){
  const list = document.getElementById('min-pending-list');
  if(!list) return;
  list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">Loading…</div>`;
  try {
    const res = await fetch('/api/pm_stock/transfers/in_transit');
    const d   = await res.json();
    if(d.status !== 'ok'){ list.innerHTML = `<div style="padding:24px;color:#dc2626">Error: ${d.message||'load failed'}</div>`; return; }
    const cnt = d.count || 0;
    [document.getElementById('sb-mm-pending'), document.getElementById('mm-tab-in-count')].forEach(b => {
      if(b){ b.textContent = String(cnt); b.style.display = cnt ? '' : 'none'; }
    });
    // Stash the full list on a global so pagination shims (renderInTransit
    // called by reinTransit) can re-render any page without re-fetching.
    window._mvInTransitRows = d.transfers || [];
    if(_pag && _pag.inTransit) _pag.inTransit.page = 1;
    renderInTransit();
  } catch(e){
    list.innerHTML = `<div style="padding:24px;color:#dc2626">Error: ${e.message}</div>`;
  }
}

// Paginated renderer for the In-Transit cards. Reads window._mvInTransitRows
// (set by mvLoadInTransit) and slices via paginate(). Pagination control
// renders into #inTransitPag (added in pm_stock.html below the list).
function renderInTransit(){
  const list = document.getElementById('min-pending-list');
  if(!list) return;
  const rows = window._mvInTransitRows || [];
  if(!rows.length){
    list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px;background:var(--hsurf,#fff);border:1.5px dashed var(--hbdr,rgba(0,0,0,.15));border-radius:10px">No transfers in transit.</div>`;
    const pag = document.getElementById('inTransitPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const p = paginate(rows, 'inTransit');
  list.innerHTML = p.slice.map(t => `
      <div onclick="mvOpenInVoucher(${t.transfer_id})"
        style="background:var(--hsurf,#fff);border:1.5px solid ${t.has_discrepancy?'#dc2626':'var(--hbdr,rgba(0,0,0,.1))'};
          border-radius:10px;padding:14px 16px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:14px;
          ${t.has_discrepancy?'background:rgba(220,38,38,.04);box-shadow:0 0 0 3px rgba(220,38,38,.08);':''}">
        <div style="font-size:24px">${t.has_discrepancy?'⚠':'📦'}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:800;color:var(--htxtb,#111);font-family:monospace">${t.transfer_no}</div>
          <div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:2px">
            <strong>${t.from_name}</strong> → <strong>${t.to_name}</strong>
          </div>
          <div style="font-size:10px;color:var(--hmuted2,#6b7280);margin-top:2px">
            Sent ${fmtDateTime(t.out_at)} · by ${t.out_by||'—'}
          </div>
          ${t.has_discrepancy?`<div style="font-size:10.5px;color:#991b1b;font-weight:700;margin-top:4px">⚠ DISCREPANCY: ${(t.discrepancy_note||'').slice(0,140)}${(t.discrepancy_note||'').length>140?'…':''}</div>`:''}
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;color:var(--hmuted2,#6b7280);text-transform:uppercase;font-weight:700">Boxes</div>
          <div style="font-size:18px;font-weight:800;color:${t.has_discrepancy?'#dc2626':'#f59e0b'}">${t.total_boxes}</div>
          <div style="font-size:10px;color:var(--hmuted,#9ca3af)">qty ${(t.total_qty||0).toLocaleString('en-IN')}</div>
        </div>
        <div style="font-size:14px;color:var(--hmuted,#9ca3af)">›</div>
      </div>
    `).join('');
  renderPag('inTransitPag', 'inTransit', p.total, p.pages, p.page);
}

async function mvRefreshInTransitCount(){
  try {
    const res = await fetch('/api/pm_stock/transfers/in_transit');
    const d = await res.json();
    if(d.status !== 'ok') return;
    const cnt = d.count || 0;
    [document.getElementById('sb-mm-pending'), document.getElementById('mm-tab-in-count')].forEach(b => {
      if(b){ b.textContent = String(cnt); b.style.display = cnt ? '' : 'none'; }
    });
    mvRefreshDiscrepancyBanner();
  } catch(_){}
}

/* ────────────── IN VOUCHER ────────────── */

async function mvOpenInVoucher(tid){
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${tid}`);
    const d   = await res.json();
    if(d.status !== 'ok'){ showToast(d.message || 'Load failed','error'); return; }
    _mvIn = {
      ...d.header,
      out_items: d.out_items || [],
      in_items:  d.in_items  || [],
      mismatches: d.mismatches || [],
      in_locked_for_user: !!d.in_locked_for_user,
      in_locked_reason:   d.in_locked_reason || ''
    };
    _mvInRender();
    document.getElementById('mvInModal')?.classList.add('open');
    if(!_mvIn.in_locked_for_user){
      setTimeout(() => document.getElementById('mvin-scan-input')?.focus(), 100);
    }
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

function mvCloseInVoucher(){
  document.getElementById('mvInModal')?.classList.remove('open');
  _mvIn = null;
  mvLoadInTransit();
  mvRefreshDiscrepancyBanner();
  if(_mmSubTab === 'in' && typeof mmLoadInCompletedList === 'function') mmLoadInCompletedList();
  if(_mmSubTab === 'out' && typeof mmLoadOutList === 'function') mmLoadOutList();
}

function _mvInRender(){
  if(!_mvIn) return;
  const setText = (id,t) => { const el=document.getElementById(id); if(el) el.textContent=t; };
  // Build voucher-number display with the IN date appended after a pipe.
  // Format: "PMT/26-27/0082 | 10/05/2026". The IN date can be missing for
  // a freshly-loaded voucher that hasn't been saved yet — in that case we
  // render "(in pending)" as a faint suffix so the operator sees that the
  // IN side hasn't been committed. We update the voucher-number span in
  // place AND set its title to expose the full datetime + scanner info on
  // hover, matching the row-level affordance used elsewhere in this modal.
  const _vnoEl = document.getElementById('mvin-vno');
  if(_vnoEl){
    const vno   = _mvIn.transfer_no || '—';
    const inAt  = _mvIn.in_at || null;
    if(inAt){
      // Use _mvbsFmtTs to extract just the date portion (DD/MM/YYYY) so the
      // header stays compact — full timestamp goes into the title tooltip.
      const dateStr = (typeof fmtDateTime === 'function')
        ? (fmtDateTime(inAt).split(' ')[0] || fmtDateTime(inAt))
        : String(inAt).slice(0,10);
      _vnoEl.textContent = `${vno} | ${dateStr}`;
      _vnoEl.title = `IN: ${fmtDateTime ? fmtDateTime(inAt) : inAt}${_mvIn.in_by ? ' · by ' + _mvIn.in_by : ''}`;
    } else {
      _vnoEl.innerHTML = `${vno} <span style="opacity:.55;font-weight:700;font-size:13px"> | (in pending)</span>`;
      _vnoEl.title = 'Voucher not yet saved as IN';
    }
  }
  setText('mvin-from',  _mvIn.from_name   || _godownName(_mvIn.from_godown_id));
  setText('mvin-to',    _mvIn.to_name     || _godownName(_mvIn.to_godown_id));

  // ── Aggregate by product_id ───────────────────────────────────────────
  // Earlier versions stored one ledger row per scan in pm_transfer_items,
  // and on some installations (where the uq_pm_xfer_item unique key was
  // missing at insert time) we still find multiple rows per
  // (transfer_id, side, product_id). The previous renderer naively did
  // `map[pid].out = r` which was last-write-wins: when product 3262
  // had two OUT rows (1 box × 1,140 and 1 box × 1,130 = 2,270 total),
  // the modal would only show one of them and the row would falsely
  // show as ✅ OK against a single matching IN row.
  //
  // Sum no_of_box and total_qty per side, per product so the modal
  // reflects the real totals — matching what _check_discrepancy (and
  // the Reconcile modal) compute on the server.
  const map = {};
  const _accumulate = (sideKey, r) => {
    const pid = r.product_id;
    if(!map[pid]) map[pid] = { out: null, in: null, productName: r.product_name, productCode: r.product_code, pmType: r.pm_type, brandName: r.brand_name };
    const acc = map[pid][sideKey] || {
      product_id:  pid,
      product_name: r.product_name,
      product_code: r.product_code,
      pm_type:      r.pm_type,
      brand_name:   r.brand_name,
      no_of_box:   0,
      total_qty:   0,
      per_box_qty: 0,   // mixed — see comment below
      _row_count:  0,
    };
    acc.no_of_box  += Number(r.no_of_box  || 0);
    acc.total_qty  += Number(r.total_qty  || 0);
    acc._row_count += 1;
    // per_box_qty on the aggregated row is meaningless when individual
    // ledger rows have different per_box values (the partial-box case).
    // We carry the per_box_qty of the FIRST row only — the modal mostly
    // uses total_qty/no_of_box anyway. _row_count is exposed so future
    // tooltips can flag "this product was scanned in N separate ledger
    // entries" if useful.
    if(acc._row_count === 1) acc.per_box_qty = Number(r.per_box_qty || 0);
    map[pid][sideKey] = acc;
  };
  (_mvIn.out_items||[]).forEach(r => _accumulate('out', r));
  (_mvIn.in_items ||[]).forEach(r => _accumulate('in',  r));

  // Once reconciled (status='received' AND has_discrepancy=0 AND there
  // exists a "RECONCILED:" prefix in discrepancy_note), per-row counts
  // may still legitimately differ — the admin accepted the difference.
  // The row status should reflect that acceptance, not flag MISSING again.
  const noteRaw = String(_mvIn.discrepancy_note || '');
  const isReconciled = (_mvIn.status === 'received')
                    && !_mvIn.has_discrepancy
                    && /RECONCILED:/i.test(noteRaw);
  // Pull the human-readable note out of the audit-style stored string for tooltips
  const reconciledNote = (() => {
    const m = noteRaw.match(/RECONCILED:\s*([\s\S]*?)\s*\[was:/i);
    return m ? m[1].trim() : '';
  })();

  const tbody = document.getElementById('mvin-items');
  const productIds = Object.keys(map);
  if(!productIds.length){
    tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">No items yet. Scan a box at destination to begin.</td></tr>`;
  } else {
    tbody.innerHTML = productIds.map((pid, i) => {
      const o = map[pid].out;
      const inL = map[pid].in;
      const ref = o || inL;
      const outBox = o ? o.no_of_box : 0;
      const inBox  = inL ? inL.no_of_box : 0;
      const outQty = o ? o.total_qty : 0;
      const inQty  = inL ? inL.total_qty : 0;
      const matches = (outBox === inBox) && (Math.abs(outQty-inQty) < 0.001);
      const isExtra   = !o && inL;
      const isMissing = o && !inL;
      // After reconciliation, override the visual state. The mismatch is
      // acknowledged so we don't keep yelling MISSING/MISMATCH at the user.
      const showReconciled = isReconciled && !matches;
      const rowBg = matches
        ? ''
        : showReconciled
          ? 'background:rgba(13,148,136,.06)'
          : (isExtra ? 'background:rgba(124,58,237,.06)'
                     : (isMissing ? 'background:rgba(245,158,11,.06)'
                                  : 'background:rgba(220,38,38,.06)'));
      // Pick the status label, glyph, and color
      let statusLbl, statusIcon, statusColor;
      if(matches){
        statusLbl = 'OK'; statusIcon = '✅'; statusColor = '#16a34a';
      } else if(showReconciled){
        statusLbl = 'RECONCILED'; statusIcon = '🔧'; statusColor = '#0d9488';
      } else if(isExtra){
        statusLbl = 'EXTRA'; statusIcon = '➕'; statusColor = '#7c3aed';
      } else if(isMissing){
        statusLbl = 'MISSING'; statusIcon = '⏳'; statusColor = '#f59e0b';
      } else {
        statusLbl = 'MISMATCH'; statusIcon = '⚠'; statusColor = '#dc2626';
      }
      const inColor = matches
        ? '#16a34a'
        : showReconciled
          ? '#0d9488'
          : (isExtra ? '#7c3aed' : (isMissing ? '#f59e0b' : '#dc2626'));

      // For reconciled rows the IN column should show the accepted value.
      // The reconciliation closes the voucher at the OUT quantity (with
      // source-side stock corrected by the server). We show the OUT
      // figures with a clear "via reconcile" marker so the user can tell
      // this isn't a raw scan count. If physical IN scans existed, those
      // win — show them as the literal received count.
      const showOutInIn = showReconciled && !inL;
      const inBoxDisplay = showOutInIn ? outBox : inBox;
      const inQtyDisplay = showOutInIn ? outQty : inQty;
      // Row is clickable IFF we have OUT scans for this product (rows that
      // are pure IN-side EXTRAs have no OUT-scans to inspect). We forward
      // the click to mvShowOutBoxScans, which opens the detail modal.
      // Tooltip preference: a reconciled note (when present) is more
      // useful than the generic "click to view" hint, so we keep it.
      const hasOutScans = (outBox > 0);
      const hoverTitle = (showReconciled && reconciledNote)
        ? `Reconciled: ${reconciledNote.replace(/"/g,'&quot;')}`
        : (hasOutScans ? 'Click to view OUT-scanned boxes for this product' : '');
      const titleAttr = hoverTitle ? ` title="${hoverTitle}"` : '';
      const clickAttrs = hasOutScans
        ? ` onclick="mvShowOutBoxScans(${pid})" style="cursor:pointer;${rowBg}"`
        : ` style="${rowBg}"`;
      // Hover affordance — a tiny info hint inside the product cell so the
      // operator notices the row is clickable. Hidden when no OUT scans.
      const hint = hasOutScans
        ? `<span class="mvin-hint" style="display:inline-block;margin-left:6px;font-size:9px;color:#1e40af;font-weight:700;letter-spacing:.3px;text-transform:uppercase;opacity:.65">📋 Click for boxes</span>`
        : '';
      return `<tr${clickAttrs}${titleAttr}>
        <td style="text-align:center;color:var(--hmuted,#9ca3af);font-size:11px">${i+1}</td>
        <td>
          <strong>${ref.product_name}</strong>${hint}
          ${ref.product_code ? `<br><span style="font-family:monospace;font-size:9.5px;color:#888">${ref.product_code}</span>` : ''}
          <br><span style="font-size:9.5px;color:#999">[${ref.pm_type}]${ref.brand_name?' · '+ref.brand_name:''}</span>
        </td>
        <td style="text-align:right;font-family:monospace">
          <div style="font-weight:700">${outBox}</div>
          <div style="font-size:9px;color:#999">${(outQty||0).toLocaleString('en-IN')}</div>
        </td>
        <td style="text-align:right;font-family:monospace">
          <div style="font-weight:700;color:${inColor}">${inBoxDisplay}</div>
          <div style="font-size:9px;color:#999">${(inQtyDisplay||0).toLocaleString('en-IN')}</div>
          ${showOutInIn ? `<div style="font-size:8.5px;color:#0d9488;font-weight:700;margin-top:2px;letter-spacing:.3px">VIA RECONCILE</div>` : ''}
        </td>
        <td style="text-align:center;font-size:14px">${statusIcon}</td>
        <td style="text-align:center;font-size:10px;color:${statusColor};font-weight:700">
          ${statusLbl}
        </td>
      </tr>`;
    }).join('');
  }

  const banner = document.getElementById('mvin-status-banner');
  const confirmBtn = document.getElementById('mvin-save-btn');
  const reconcileBtn = document.getElementById('mvin-reconcile-btn');
  const recalcBtn = document.getElementById('mvin-recalc-btn');
  // Admin "Recalc from Boxes" recomputes OUT line totals from scanned boxes.
  // It's a data-repair on the OUT side, so it's available to any admin
  // regardless of the IN separation-of-duties lock.
  if(recalcBtn) recalcBtn.style.display = _isAdmin() ? '' : 'none';
  const hasInItems = (_mvIn.in_items||[]).length > 0;

  // Separation of duties: if the current user created the OUT, IN actions are
  // blocked. The voucher is view/print only for them.
  const scanInput = document.getElementById('mvin-scan-input');
  if(_mvIn.in_locked_for_user){
    if(banner){
      banner.innerHTML = `🔒 <strong>VIEW / PRINT ONLY</strong> · ${_mvIn.in_locked_reason || 'You created the Material OUT for this transfer; a different user must perform the Material IN.'}`;
      banner.style.cssText += ';background:rgba(99,102,241,.10);border-left-color:#6366f1;color:#3730a3';
    }
    if(confirmBtn)   confirmBtn.style.display = 'none';
    if(reconcileBtn) reconcileBtn.style.display = 'none';
    if(scanInput){
      scanInput.disabled = true;
      scanInput.placeholder = 'Locked — a different user must scan IN for this voucher';
      scanInput.style.opacity = '.55';
      scanInput.style.cursor = 'not-allowed';
    }
    return;
  } else if(scanInput){
    // Re-enable in case modal is reused for an unlocked voucher
    scanInput.disabled = false;
    scanInput.placeholder = 'e.g. BEARTUBE12-G0003-B001';
    scanInput.style.opacity = '';
    scanInput.style.cursor = '';
  }

  if(_mvIn.status === 'received'){
    // A transfer can be `received` AND still have an unresolved discrepancy
    // (e.g. an EXTRA box arrived that wasn't in the OUT). In that case we
    // must NOT show "Transfer is complete" — that's misleading — and we
    // must keep the reconcile button visible so the admin can resolve.
    if(_mvIn.has_discrepancy){
      if(banner){
        const mm = (_mvIn.mismatches||[]).length;
        banner.innerHTML = `⚠ <strong>RECEIVED · DISCREPANCY</strong> · Transfer was completed but ${mm} product(s) still mismatch — admin can reconcile to clear the alert`;
        banner.style.cssText += ';background:rgba(220,38,38,.10);border-left-color:#dc2626;color:#991b1b';
      }
      if(confirmBtn) confirmBtn.style.display = 'none';
      if(reconcileBtn) reconcileBtn.style.display = _isAdmin() ? '' : 'none';
    } else {
      if(banner){ banner.innerHTML = `✓ <strong>RECEIVED</strong> · Transfer is complete`; banner.style.cssText += ';background:rgba(22,163,74,.10);border-left-color:#16a34a;color:#15803d'; }
      if(confirmBtn) confirmBtn.style.display = 'none';
      if(reconcileBtn) reconcileBtn.style.display = 'none';
    }
  } else if(_mvIn.has_discrepancy){
    if(banner){ banner.innerHTML = `⚠ <strong>DISCREPANCY</strong> · ${(_mvIn.mismatches||[]).length} product(s) mismatch · Resolve before completing`; banner.style.cssText += ';background:rgba(220,38,38,.10);border-left-color:#dc2626;color:#991b1b'; }
    if(confirmBtn){
      confirmBtn.textContent = '✓ Save IN (will retain discrepancy flag)';
      confirmBtn.disabled = !hasInItems;
      confirmBtn.style.opacity = hasInItems ? '1' : '.5';
      confirmBtn.style.display = '';
    }
    if(reconcileBtn) reconcileBtn.style.display = _isAdmin() ? '' : 'none';
  } else {
    if(banner){ banner.innerHTML = `<strong>RECEIVING</strong> · Scan boxes at destination · Match OUT counts to complete`; banner.style.cssText += ';background:rgba(245,158,11,.10);border-left-color:#f59e0b;color:#92400e'; }
    if(confirmBtn){
      confirmBtn.textContent = '✓ Save IN & Confirm Receipt';
      confirmBtn.disabled = !hasInItems;
      confirmBtn.style.opacity = hasInItems ? '1' : '.5';
      confirmBtn.style.display = '';
    }
    if(reconcileBtn) reconcileBtn.style.display = 'none';
  }
}

async function mvInHandleScanInput(ev){
  // DIAGNOSTIC LOGGING — temporary. Remove once IN-scan issue is fixed.
  // Each line tells us where in the function we got to. If you scan and see
  // NOTHING in the console, the handler isn't firing at all (HTML wiring
  // issue). If you see line A but not B, we know exactly which check is
  // returning silently.
  console.log('[IN-scan A] handler fired', { type: ev?.type, key: ev?.key });
  if(ev && ev.type === 'keydown' && ev.key !== 'Enter') return;
  console.log('[IN-scan B] enter detected');
  const inp = document.getElementById('mvin-scan-input');
  const code = (inp.value || '').trim().toUpperCase();
  console.log('[IN-scan C] read code:', JSON.stringify(code), 'inp present?', !!inp);
  if(!code) { console.log('[IN-scan X] code is empty — silent return'); return; }
  inp.value = '';
  if(!_mvIn){ console.log('[IN-scan X] no _mvIn'); showToast('No active voucher','error'); return; }
  console.log('[IN-scan D] _mvIn ok, transfer_id:', _mvIn.transfer_id, 'locked?', _mvIn.in_locked_for_user);
  if(_mvIn.in_locked_for_user){
    showToast(_mvIn.in_locked_reason || 'Locked: a different user must scan IN for this voucher','error', 4000);
    return;
  }
  try {
    console.log('[IN-scan E] calling _scanCodeWithGroupSupport');
    const result = await _scanCodeWithGroupSupport(_mvIn.transfer_id, code, 'in');
    console.log('[IN-scan F] result:', result);
    if(result.single){
      if(!result.ok){
        _voiceNotScanned();
        showToast(result.message || 'Scan failed','error', 4000);
        setTimeout(() => {
          const el = document.getElementById('mvin-scan-input');
          if(el) el.focus();
        }, 50);
        return;
      }
      _voiceScanned();
      showToast(`✓ ${result.result.box.product_name} +1 IN`, 'success', 2000);
    } else {
      _showGroupScanSummary(result, 'in');
    }
    await mvOpenInVoucher(_mvIn.transfer_id);
  } catch(e){
    console.error('[IN-scan ERR]', e);
    showToast('Error: '+e.message,'error');
  }
  // Re-fetch the input AFTER mvOpenInVoucher rebuilds the modal.
  setTimeout(() => {
    const el = document.getElementById('mvin-scan-input');
    if(el) el.focus();
  }, 50);
}

async function mvInSaveVoucher(){
  if(!_mvIn) return;
  if(_mvIn.in_locked_for_user){
    showToast(_mvIn.in_locked_reason || 'Locked: a different user must save IN for this voucher','error', 4000);
    return;
  }
  if(!_mvIn.in_items || !_mvIn.in_items.length){ showToast('Scan at least one box','error'); return; }
  const btn = document.getElementById('mvin-save-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/pm_stock/transfers/voucher/${_mvIn.transfer_id}/save_in`,{method:'POST'});
    const d = await res.json();
    if(d.status === 'ok'){
      if(d.has_discrepancy){
        showToast(`⚠ Saved with ${d.mismatches.length} discrepancy. Both screens flagged until reconciled.`,'error', 6000);
      } else {
        showToast(`✓ ${d.transfer_no} complete · destination updated`,'success', 4000);
      }
      mvCloseInVoucher();
      if(typeof loadSummary === 'function') loadSummary();
    } else { showToast(d.message || 'Save failed','error'); btn.innerHTML = orig; btn.disabled = false; }
  } catch(e){ showToast('Error: '+e.message,'error'); btn.innerHTML = orig; btn.disabled = false; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Reconcile Discrepancy — admin-only, side-aware
   ─────────────────────────────────────────────────────────────────────────
   Old behavior was a prompt() asking for a note and silently posting one
   side's settlement. New behavior:
     1. Fetch a per-product impact preview from the backend
     2. Show modal with both options (Settle to OUT / Settle to IN), each
        with its own impact details. Admin must explicitly pick a side.
     3. Reason textarea (required, min 4 chars).
     4. On submit, final confirm dialog summarizing the choice + impact.
     5. Server posts stock movements, rewrites items, audits.
═══════════════════════════════════════════════════════════════════════════ */

let _rcTransfer = null;     // {tid, transfer_no, mismatches, from_godown, to_godown}
let _rcChosenSide = null;   // 'out' | 'in' | null

// Admin: recompute OUT line totals from the actual scanned boxes (boxes are
// the source of truth). Fixes vouchers where the line total drifted from the
// physical box count (e.g. 154 shown vs 155 scanned).
async function mvRecalcFromBoxes(tid){
  if(!tid){ showToast('No voucher','error'); return; }
  if(!confirm('Recalculate this voucher\'s OUT line totals from the actual scanned boxes?\n\nThe scanned boxes are treated as the source of truth.')) return;
  try{
    const r = await fetch(`/api/pm_stock/transfers/${tid}/recalc_out_from_boxes`, {method:'POST'});
    const d = await r.json();
    if(d.status !== 'ok'){ showToast(d.message || 'Recalc failed','error',4000); return; }
    let msg;
    if(d.lines_updated > 0){
      const parts = d.updated.map(u => `• boxes ${u.boxes.from}→${u.boxes.to}, qty ${u.qty.from}→${u.qty.to}`);
      msg = `Recalculated ${d.lines_updated} line(s) from scanned boxes:\n${parts.join('\n')}\n\nHeader: ${d.header_boxes} boxes · qty ${d.header_qty}`;
    } else {
      msg = 'Already matches the scanned boxes — nothing to change.';
    }
    if((d.orphan_box_groups||[]).length) msg += `\n\n⚠️ ${d.orphan_box_groups.length} scanned box-group(s) have NO matching line — needs attention.`;
    if((d.stale_lines||[]).length)       msg += `\n\n⚠️ ${d.stale_lines.length} line(s) have NO scanned boxes — needs attention.`;
    alert(msg);
    // Reload the voucher so the corrected totals show immediately.
    if(typeof mvOpenInVoucher === 'function' && _mvIn){ mvOpenInVoucher(tid); }
    else { showToast('Recalc done — reopen the voucher to see updated totals','success'); }
  }catch(e){ showToast('Recalc error: '+e.message,'error'); }
}

async function mvInReconcile(){
  if(!_mvIn) return;
  const tid = _mvIn.transfer_id;
  const modal = document.getElementById('reconcileModal');
  if(!modal){ showToast('Reconcile is admin-only','error'); return; }

  // Fetch the impact preview
  let preview;
  try {
    const r = await fetch(`/api/pm_stock/transfers/voucher/${tid}/reconcile/preview`);
    preview = await r.json();
    if(preview.status !== 'ok'){
      showToast(preview.message || 'Preview failed','error', 4000);
      return;
    }
  } catch(e){
    showToast('Preview error: '+e.message,'error');
    return;
  }
  if(!preview.mismatches || preview.mismatches.length === 0){
    showToast('No discrepancy to reconcile','info');
    return;
  }

  _rcTransfer = {tid, ...preview};
  _rcChosenSide = null;
  _rcRender();
  modal.classList.add('open');
}

function _rcRender(){
  const t = _rcTransfer;
  if(!t) return;
  document.getElementById('rcVno').textContent = t.transfer_no || '';

  // Mismatch table
  const tbl = document.getElementById('rc-mismatch-table');
  const headerHtml = `
    <div style="display:grid;grid-template-columns:2.4fr 1fr 1fr 1fr;gap:10px;padding:8px 12px;
      background:rgba(0,0,0,.04);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2,#475569)">
      <span>Product</span>
      <span style="text-align:right">OUT sent</span>
      <span style="text-align:right">IN received</span>
      <span style="text-align:right">Delta</span>
    </div>`;
  const rowsHtml = t.mismatches.map(m => {
    const dColor = m.qty_delta > 0 ? '#dc2626' : (m.qty_delta < 0 ? '#d97706' : '#475569');
    const dSign  = m.qty_delta > 0 ? '+' : '';
    return `
    <div style="display:grid;grid-template-columns:2.4fr 1fr 1fr 1fr;gap:10px;padding:9px 12px;border-top:1px solid var(--border,rgba(0,0,0,.06));align-items:center">
      <div style="min-width:0"><strong>[${m.pm_type||''}]</strong> ${m.product_name}</div>
      <div style="text-align:right;font-family:var(--font-mono,monospace);font-weight:700">${m.out_qty.toLocaleString('en-IN')}</div>
      <div style="text-align:right;font-family:var(--font-mono,monospace);font-weight:700">${m.in_qty.toLocaleString('en-IN')}</div>
      <div style="text-align:right;font-family:var(--font-mono,monospace);font-weight:800;color:${dColor}">${dSign}${m.qty_delta.toLocaleString('en-IN')}</div>
    </div>`;
  }).join('');
  tbl.innerHTML = headerHtml + rowsHtml;

  // Reset radio state
  document.querySelectorAll('input[name="rc-side"]').forEach(r => r.checked = false);
  document.querySelectorAll('.rc-side-card').forEach(c => {
    c.style.borderColor = 'var(--border,rgba(0,0,0,.1))';
    c.style.background = '#fff';
  });
  document.getElementById('rc-out-impact').style.display = 'none';
  document.getElementById('rc-in-impact').style.display  = 'none';
  document.getElementById('rc-note').value = '';

  const btn = document.getElementById('rc-save-btn');
  btn.disabled = true;
  btn.style.opacity = '.5';
  btn.textContent = 'Pick a side first →';
}

function rcSideChosen(side){
  _rcChosenSide = side;
  // Highlight chosen card
  document.querySelectorAll('.rc-side-card').forEach(c => {
    if(c.dataset.side === side){
      c.style.borderColor = side === 'out' ? '#d97706' : '#3b82f6';
      c.style.background  = side === 'out' ? 'rgba(245,158,11,.04)' : 'rgba(59,130,246,.04)';
    } else {
      c.style.borderColor = 'var(--border,rgba(0,0,0,.1))';
      c.style.background  = '#fff';
    }
  });

  // Build per-product impact text for the chosen side
  const t = _rcTransfer;
  const impactBox = document.getElementById('rc-' + side + '-impact');
  const otherBox  = document.getElementById('rc-' + (side==='out'?'in':'out') + '-impact');
  const lines = t.mismatches.map(m => {
    const act = m['settle_' + side + '_action'];
    return `• ${m.product_name} → ${act.description || 'no change'}`;
  });
  impactBox.innerHTML = lines.join('<br>');
  impactBox.style.display = 'block';
  otherBox.style.display  = 'none';

  // Enable button
  const btn = document.getElementById('rc-save-btn');
  btn.disabled = false;
  btn.style.opacity = '1';
  btn.textContent = `🔧 Settle to ${side.toUpperCase()} →`;
}

async function rcSubmit(){
  if(!_rcChosenSide){
    showToast('Pick a settlement side first','error');
    return;
  }
  const note = (document.getElementById('rc-note').value || '').trim();
  if(note.length < 4){
    showToast('Reason is required (min 4 chars)','error', 3500);
    document.getElementById('rc-note').focus();
    return;
  }

  // Final confirm with full summary
  const t = _rcTransfer;
  const side = _rcChosenSide;
  let confirmMsg = `Reconcile ${t.transfer_no}\n\n`;
  confirmMsg += `Settling to: ${side.toUpperCase()} side\n`;
  confirmMsg += `─────────────────────────────────\n`;
  confirmMsg += `Stock postings will be made:\n\n`;
  t.mismatches.forEach(m => {
    const act = m['settle_' + side + '_action'];
    if(act && act.qty > 0){
      confirmMsg += `  • ${m.product_name}\n    ${act.description}\n`;
    }
  });
  confirmMsg += `\nBoth sides of the voucher will be rewritten to match.\n`;
  confirmMsg += `\n⚠ This action CANNOT be reverted automatically.\n`;
  confirmMsg += `\nReason: "${note}"\n\nProceed?`;
  if(!confirm(confirmMsg)) return;

  const btn = document.getElementById('rc-save-btn');
  btn.disabled = true;
  btn.textContent = 'Reconciling…';
  try {
    const r = await fetch(`/api/pm_stock/transfers/voucher/${t.tid}/reconcile`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({side, note})
    });
    const d = await r.json();
    if(d.status === 'ok'){
      showToast(`✓ Reconciled (settled to ${d.side.toUpperCase()})`, 'success', 4000);
      closeModal('reconcileModal');
      mvCloseInVoucher();
      // Refresh every visible state.
      if(typeof mvRefreshDiscrepancyBanner === 'function') mvRefreshDiscrepancyBanner();
      if(typeof mmLoadHistory === 'function')               mmLoadHistory();
      if(typeof loadVoucherLog === 'function')              loadVoucherLog();
      if(typeof loadSummary === 'function')                  loadSummary();
    } else {
      showToast(d.message || 'Reconcile failed','error', 5000);
      btn.disabled = false;
      btn.textContent = `🔧 Settle to ${side.toUpperCase()} →`;
    }
  } catch(e){
    showToast('Error: '+e.message,'error');
    btn.disabled = false;
    btn.textContent = `🔧 Settle to ${_rcChosenSide.toUpperCase()} →`;
  }
}

/* ────────────── STICKY DISCREPANCY BANNER ────────────── */

async function mvRefreshDiscrepancyBanner(){
  try {
    const res = await fetch('/api/pm_stock/transfers/discrepancies');
    const d = await res.json();
    if(d.status !== 'ok') return;
    const cnt = d.count || 0;
    let banner = document.getElementById('discrepancyBanner');
    if(cnt === 0){
      if(banner) banner.remove();
      // Recompute the unified offset — other banners (unbranded, negative)
      // may still be present and still need their share of the top space.
      if(typeof _refreshBannerOffset === 'function') _refreshBannerOffset();
      _mvDiscrepancyShown = false;
      return;
    }
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'discrepancyBanner';
      banner.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:9999;
        background:linear-gradient(90deg,#dc2626,#b91c1c);color:#fff;
        padding:10px 18px;font-size:13px;font-weight:700;
        display:flex;align-items:center;gap:14px;flex-wrap:wrap;
        box-shadow:0 3px 14px rgba(220,38,38,.4);
        animation:mvBannerPulse 2.4s ease-in-out infinite;
      `;
      const style = document.createElement('style');
      style.textContent = `
        @keyframes mvBannerPulse {
          0%,100% { box-shadow: 0 3px 14px rgba(220,38,38,.4); }
          50%     { box-shadow: 0 3px 22px rgba(220,38,38,.85); }
        }
      `;
      document.head.appendChild(style);
      document.body.appendChild(banner);
    }
    const items = (d.discrepancies || []).slice(0, 3).map(x =>
      `<a href="javascript:mvOpenInVoucher(${x.transfer_id})" style="color:#fff;text-decoration:underline;font-family:monospace;font-weight:800">${x.transfer_no}</a>`
    ).join(', ');
    banner.innerHTML = `
      <span style="font-size:18px">⚠</span>
      <strong>${cnt} TRANSFER ${cnt===1?'HAS':'HAVE'} A DISCREPANCY</strong>
      <span style="opacity:.9">— ${items}${cnt>3?` (+${cnt-3} more)`:''}</span>
      <span style="opacity:.85;font-size:11px;margin-left:auto">Click a transfer number to open · This banner stays until resolved</span>
    `;
    // Expose the banner's height as part of --banner-offset by calling the
    // unified offset calculator. It walks all banners present (negative,
    // unbranded, discrepancy) and stacks them in order.
    requestAnimationFrame(() => {
      if(typeof _refreshBannerOffset === 'function') _refreshBannerOffset();
    });
    _mvDiscrepancyShown = true;
  } catch(_){}
}

setInterval(() => {
  if(document.visibilityState === 'visible'){
    mvRefreshInTransitCount();
    mvRefreshDiscrepancyBanner();
  }
}, 30000);

/* ────────────── HISTORY ──────────────
   Strategy: server returns up to LIMIT 500 transfers in one shot. We
   filter and paginate ENTIRELY client-side so the date filter can match
   "either OUT or IN date" without needing a backend change. With ~100
   vouchers this is comfortably fast; if the count grows past ~500 we'll
   need to push pagination server-side and that'll require an __init__.py
   redeploy. Until then, client-side is the right trade-off.
*/

// State for the history view — populated by mmLoadHistory() and consumed
// by mmHistoryRender(). Kept on window so it survives across user
// interactions and can be inspected from the console for debugging.
window._mmHistory = {
  all:        [],   // raw rows from the server
  filtered:   [],   // current filter result (cached so pagination is cheap)
  page:       1,
  pageSize:   50,
};

async function mmLoadHistory(){
  const tbody = document.getElementById('mm-history-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="no-data">Loading…</td></tr>`;
  try {
    const res = await fetch('/api/pm_stock/transfers/list');
    const d   = await res.json();
    if(d.status !== 'ok'){ tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${d.message||'load failed'}</td></tr>`; return; }
    window._mmHistory.all  = d.transfers || [];
    window._mmHistory.page = 1;
    // Vanilla fetch — turn off the deep-mode flag so the search badge
    // reflects reality. If the user still has text in the search box,
    // mmHistoryApplyFilters will re-apply it locally below.
    window._mmHistory.deepActive = false;
    mmHistoryApplyFilters();
  } catch(e){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${e.message}</td></tr>`;
  }
}

// Apply current filter inputs against window._mmHistory.all and stash the
// result. Always resets to page 1 — when the user changes a filter they
// expect to see the top of the new result set, not page 5 of stale data.
//
// Search behaviour
// ────────────────
// The "Search" textbox has TWO modes:
//   1. INSTANT (this function): every keystroke locally filters the
//      already-loaded transfers by transfer_no, from/to godown name,
//      and remarks. Zero latency.
//   2. DEEP (mmHistoryDeepSearchNow): debounced 600ms idle OR explicit
//      Enter press. Fetches from the server with ?search=&deep=1 which
//      additionally matches product names AND box QR codes. Replaces
//      _mmHistory.all entirely. Mode badge updates so the user knows
//      they're viewing the deep result.
function mmHistoryApplyFilters(){
  const status = (document.getElementById('mm-history-status')?.value || '').trim();
  const from   = (document.getElementById('mm-history-from')?.value   || '').trim();
  const to     = (document.getElementById('mm-history-to')?.value     || '').trim();
  const q      = (document.getElementById('mm-history-search')?.value || '').trim().toLowerCase();
  // Helper: extract YYYY-MM-DD from a "YYYY-MM-DD HH:MM:SS" timestamp
  // string (or empty/null). Returns '' for missing values.
  const dateOf = ts => (ts ? String(ts).slice(0, 10) : '');
  // The "Discrepancy" pseudo-status filters by the has_discrepancy flag
  // regardless of the underlying status value. Other status values match
  // the row's literal status field.
  const filtered = (window._mmHistory.all || []).filter(t => {
    if(status === 'discrepancy'){
      if(!t.has_discrepancy) return false;
    } else if(status){
      if(t.status !== status) return false;
    }
    // Date filter: match if EITHER out_at OR in_at falls within the range.
    // Empty from/to means "no lower/upper bound" on that side.
    if(from || to){
      const dOut = dateOf(t.out_at);
      const dIn  = dateOf(t.in_at);
      const inRange = (d) => {
        if(!d) return false;            // missing dates can't satisfy a range
        if(from && d < from) return false;
        if(to   && d > to)   return false;
        return true;
      };
      if(!inRange(dOut) && !inRange(dIn)) return false;
    }
    // Instant search across header-level text fields. Product names and
    // box codes aren't on the row object, so a user looking for those
    // either has to wait for the debounced deep search OR press Enter.
    // We don't gate this on the deep-mode flag — even after a deep
    // fetch loaded broader results, the user can refine further by
    // continuing to type and the local filter narrows in real time.
    if(q){
      const hay = [
        t.transfer_no, t.from_name, t.to_name, t.remarks
      ].map(v => String(v||'').toLowerCase()).join(' ');
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  window._mmHistory.filtered = filtered;
  window._mmHistory.page     = 1;
  mmHistoryRender();
}

// Instant-search keystroke handler. Runs the local filter immediately
// AND schedules a deep server search after 600ms of idle typing. If
// the user keeps typing the timer is reset, so we never spam the
// server. Empty search clears the deep-mode badge and re-loads the
// vanilla list.
let _mmHistorySearchTimer = null;
function mmHistorySearchInput(){
  // Always run the instant local filter so feedback is immediate even
  // if the deep search is still cooling down.
  mmHistoryApplyFilters();
  // Reset / reschedule the debounce timer for the deep search.
  if(_mmHistorySearchTimer){ clearTimeout(_mmHistorySearchTimer); }
  const q = (document.getElementById('mm-history-search')?.value || '').trim();
  if(!q){
    // Search box was emptied — wipe the deep-mode badge and reload the
    // vanilla list so we're back to the full 500 transfers.
    _mmHistorySetSearchMode('off');
    if(window._mmHistory && window._mmHistory.deepActive){
      window._mmHistory.deepActive = false;
      mmLoadHistory();
    }
    return;
  }
  // Don't waste a server hit on too-short queries (the local filter
  // already handles them).
  if(q.length < 3){
    _mmHistorySetSearchMode('local');
    return;
  }
  _mmHistorySetSearchMode('pending');
  _mmHistorySearchTimer = setTimeout(() => {
    mmHistoryDeepSearchNow();
  }, 600);
}

// Fire the deep server search immediately — called by the debounce
// timer AND by the Enter key. Pulls vouchers that contain matching
// product names OR box QR codes in addition to the header-level fields.
async function mmHistoryDeepSearchNow(){
  if(_mmHistorySearchTimer){ clearTimeout(_mmHistorySearchTimer); _mmHistorySearchTimer = null; }
  const q = (document.getElementById('mm-history-search')?.value || '').trim();
  if(!q){ _mmHistorySetSearchMode('off'); return; }
  const spin = document.getElementById('mm-history-search-spinner');
  if(spin) spin.style.display = '';
  _mmHistorySetSearchMode('searching');
  try {
    const params = new URLSearchParams();
    params.append('search', q);
    params.append('deep', '1');
    // Carry over any active status/date filters so deep search respects
    // them rather than blowing them away.
    const status = (document.getElementById('mm-history-status')?.value || '').trim();
    const from   = (document.getElementById('mm-history-from')?.value   || '').trim();
    const to     = (document.getElementById('mm-history-to')?.value     || '').trim();
    if(status && status !== 'discrepancy') params.append('status', status);
    if(from) params.append('from_date', from);
    if(to)   params.append('to_date',   to);
    const res = await fetch('/api/pm_stock/transfers/list?' + params.toString());
    const d = await res.json();
    if(d.status !== 'ok'){
      _mmHistorySetSearchMode('error');
      return;
    }
    window._mmHistory.all  = d.transfers || [];
    window._mmHistory.deepActive = true;
    window._mmHistory.page = 1;
    mmHistoryApplyFilters();   // re-applies status/date/search locally for consistency
    _mmHistorySetSearchMode('deep', (d.transfers||[]).length);
  } catch(e){
    _mmHistorySetSearchMode('error');
  } finally {
    if(spin) spin.style.display = 'none';
  }
}

// Update the small mode badge next to the Search label so the user
// knows what they're looking at: local-only, pending deep, deep-active,
// or off. Cheap visual cue — keeps the input clean.
function _mmHistorySetSearchMode(mode, count){
  const el = document.getElementById('mm-history-search-mode');
  if(!el) return;
  const styles = {
    off:       { txt: '',                                 bg: '',          fg: '' },
    local:     { txt: 'LOCAL ONLY · type 3+ to deep search', bg: 'rgba(245,158,11,.10)', fg: '#92400e' },
    pending:   { txt: 'TYPING…',                          bg: 'rgba(107,114,128,.10)', fg: '#6b7280' },
    searching: { txt: 'DEEP SEARCHING…',                  bg: 'rgba(59,130,246,.10)',  fg: '#1e40af' },
    deep:      { txt: `DEEP · ${count != null ? count : '—'} match${count===1?'':'es'}`, bg: 'rgba(13,148,136,.10)', fg: 'var(--teal,#0d9488)' },
    error:     { txt: 'SEARCH FAILED',                    bg: 'rgba(220,38,38,.10)',   fg: '#dc2626' },
  };
  const s = styles[mode] || styles.off;
  if(!s.txt){ el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'inline-block';
  el.style.background = s.bg;
  el.style.color = s.fg;
  el.style.fontWeight = '800';
  el.textContent = s.txt;
}

function mmHistoryClearFilters(){
  const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  setVal('mm-history-status', '');
  setVal('mm-history-from',   '');
  setVal('mm-history-to',     '');
  setVal('mm-history-search', '');
  if(_mmHistorySearchTimer){ clearTimeout(_mmHistorySearchTimer); _mmHistorySearchTimer = null; }
  _mmHistorySetSearchMode('off');
  // Reload from server so the deep-mode result set (if any) is replaced
  // by the vanilla 500-transfer list. mmHistoryApplyFilters would only
  // re-filter the deep result set against blank filters.
  if(window._mmHistory && window._mmHistory.deepActive){
    window._mmHistory.deepActive = false;
    mmLoadHistory();
  } else {
    mmHistoryApplyFilters();
  }
}

function mmHistorySetPageSize(v){
  const n = parseInt(v, 10);
  if(!Number.isFinite(n) || n <= 0) return;
  window._mmHistory.pageSize = n;
  window._mmHistory.page     = 1;
  mmHistoryRender();
}

function mmHistoryGoFirst(){ window._mmHistory.page = 1; mmHistoryRender(); }
function mmHistoryGoPrev() { if(window._mmHistory.page > 1){ window._mmHistory.page--; mmHistoryRender(); } }
function mmHistoryGoNext() {
  const total = window._mmHistory.filtered.length;
  const sz    = window._mmHistory.pageSize;
  const last  = Math.max(1, Math.ceil(total / sz));
  if(window._mmHistory.page < last){ window._mmHistory.page++; mmHistoryRender(); }
}
function mmHistoryGoLast() {
  const total = window._mmHistory.filtered.length;
  const sz    = window._mmHistory.pageSize;
  window._mmHistory.page = Math.max(1, Math.ceil(total / sz));
  mmHistoryRender();
}

function mmHistoryRender(){
  const tbody = document.getElementById('mm-history-tbody');
  if(!tbody) return;
  const rows  = window._mmHistory.filtered || [];
  const sz    = window._mmHistory.pageSize || 50;
  const total = rows.length;
  const last  = Math.max(1, Math.ceil(total / sz));
  // Clamp page in case the filter shrank the result set below the current page.
  if(window._mmHistory.page > last) window._mmHistory.page = last;
  if(window._mmHistory.page < 1)    window._mmHistory.page = 1;
  const cur   = window._mmHistory.page;
  const start = (cur - 1) * sz;
  const slice = rows.slice(start, start + sz);

  // Update pager footer (info + page indicator)
  const pInfo = document.getElementById('mm-history-pager-info');
  if(pInfo){
    if(total === 0){
      pInfo.textContent = 'No transfers match the current filter.';
    } else {
      pInfo.textContent = `Showing ${start + 1}–${Math.min(start + sz, total)} of ${total}` +
        (total !== (window._mmHistory.all || []).length ? ` (filtered from ${(window._mmHistory.all || []).length})` : '');
    }
  }
  const pPage = document.getElementById('mm-history-pageinfo');
  if(pPage) pPage.textContent = `Page ${cur} / ${last}`;

  if(!slice.length){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">${total === 0 ? 'No transfers match the current filter.' : 'No rows on this page.'}</td></tr>`;
    return;
  }

  const sBadge = (s, hasD) => {
    if(hasD) return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:#dc26261a;color:#dc2626;border:1px solid #dc262644">⚠ Discrepancy</span>`;
    const map = { out_started:['#3b82f6','Draft'], in_pending:['#f59e0b','In-Transit'], received:['#16a34a','Complete'], cancelled:['#6b7280','Cancelled'] };
    const [c,l] = map[s] || ['#6b7280', s];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${c}1a;color:${c};border:1px solid ${c}44">${l}</span>`;
  };
  tbody.innerHTML = slice.map(t => `
    <tr>
      <td><a href="javascript:mvOpenAnyVoucher(${t.transfer_id},'${t.status}')" style="font-family:monospace;font-weight:700;color:var(--teal,#0d9488);text-decoration:none">${t.transfer_no}</a></td>
      <td><strong>${t.from_name}</strong> → <strong>${t.to_name}</strong></td>
      <td>${sBadge(t.status, t.has_discrepancy)}</td>
      <td style="text-align:right">${t.total_boxes||0}</td>
      <td style="text-align:right">${(t.total_qty||0).toLocaleString('en-IN')}</td>
      <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${fmtDateTime(t.out_at)}<br><span style="color:var(--hmuted2,#6b7280)">${t.out_by||''}</span></td>
      <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${t.in_at ? (fmtDateTime(t.in_at) + '<br><span style="color:var(--hmuted2,#6b7280)">'+(t.in_by||'')+'</span>') : '—'}</td>
      <td style="text-align:center;white-space:nowrap">
        <button onclick="event.stopPropagation();printTransferVoucher(${t.transfer_id},'out')" title="Print OUT voucher" style="background:rgba(146,64,14,.08);border:1px solid rgba(146,64,14,.3);color:#92400e;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">🖨 OUT</button>
        ${(t.status === 'in_pending' || t.status === 'received') ? `
        <button onclick="event.stopPropagation();printTransferInVoucher(${t.transfer_id})" title="Print IN voucher" style="background:rgba(30,64,175,.08);border:1px solid rgba(30,64,175,.3);color:#1e40af;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">🖨 IN</button>` : ''}
        ${_isAdmin() ? `
        <button onclick="event.stopPropagation();adminDeleteTransfer(${t.transfer_id},'${(t.transfer_no||'').replace(/'/g,'')}','${t.status}',${t.total_boxes||0},${t.total_qty||0})"
          title="Admin: delete voucher and revert all stock movements"
          style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-left:3px">🗑 Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
}

function mvOpenAnyVoucher(tid, status){
  if(status === 'out_started')      mvOpenOutVoucher(tid);
  else if(status === 'in_pending')  mvOpenInVoucher(tid);
  else                              printTransferVoucher(tid, 'out');
}

// Open a voucher for view (used by the OUT/IN list rows). Unlike
// mvOpenAnyVoucher (which jumps to print for received), this routes received
// vouchers into the IN modal so the user sees full OUT/IN details with Print
// OUT and Print IN buttons available in the footer.
function mvViewAnyVoucher(tid, status){
  if(status === 'out_started')                          mvOpenOutVoucher(tid);
  else if(status === 'in_pending' || status === 'received') mvOpenInVoucher(tid);
  else                                                  printTransferVoucher(tid, 'out');
}

/* ────────────── OUT VOUCHER LIST (under OUT subtab form) ────────────── */
function mmClearOutListFilters(){
  ['mout-list-search','mout-list-from','mout-list-to'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  mmLoadOutList();
}
async function mmLoadOutList(){
  const tbody = document.getElementById('mout-list-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  const s = (document.getElementById('mout-list-search')?.value || '').trim();
  const f = (document.getElementById('mout-list-from')?.value   || '').trim();
  const t = (document.getElementById('mout-list-to')?.value     || '').trim();
  if(s) params.append('search', s);
  if(f) params.append('from_date', f);
  if(t) params.append('to_date', t);
  try {
    const res = await fetch('/api/pm_stock/transfers/list' + (params.toString() ? '?'+params.toString() : ''));
    const d   = await res.json();
    if(d.status !== 'ok'){ tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${d.message||'load failed'}</td></tr>`; return; }
    window._mvOutListRows = d.transfers || [];
    if(_pag && _pag.outCompleted) _pag.outCompleted.page = 1;
    renderOutCompleted();
  } catch(e){ tbody.innerHTML = `<tr><td colspan="8" class="no-data" style="color:#dc2626">${e.message}</td></tr>`; }
}

// Paginated renderer — same shape as renderInCompleted. Status badge
// builder + edit-button helper inlined here too so the slice mapping
// stays self-contained.
function renderOutCompleted(){
  const tbody = document.getElementById('mout-list-tbody');
  if(!tbody) return;
  const rows = window._mvOutListRows || [];
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">No transfers found.</td></tr>`;
    const pag = document.getElementById('outCompletedPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const sBadge = (s, hasD) => {
    if(hasD) return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:#dc26261a;color:#dc2626;border:1px solid #dc262644">⚠ Discrepancy</span>`;
    const map = { out_started:['#3b82f6','Draft'], in_pending:['#f59e0b','In-Transit'], received:['#16a34a','Complete'], cancelled:['#6b7280','Cancelled'] };
    const [c,l] = map[s] || ['#6b7280', s];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;background:${c}1a;color:${c};border:1px solid ${c}44">${l}</span>`;
  };
  const p = paginate(rows, 'outCompleted');
  tbody.innerHTML = p.slice.map(t => {
      const editBtn = (t.status === 'out_started')
        ? `<button onclick="event.stopPropagation();mvOpenOutVoucher(${t.transfer_id})" title="Edit draft — add/remove boxes, change items" style="background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.3);color:#3b82f6;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">✎ Edit</button>`
        : (t.status === 'in_pending')
        ? `<button onclick="event.stopPropagation();mvOpenInVoucher(${t.transfer_id})" title="Resume IN scanning" style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:#f59e0b;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">✎ Resume IN</button>`
        : '';
      return `
      <tr>
        <td><a href="javascript:mvViewAnyVoucher(${t.transfer_id},'${t.status}')" style="font-family:monospace;font-weight:700;color:var(--teal,#0d9488);text-decoration:none">${t.transfer_no}</a></td>
        <td><strong>${t.from_name||''}</strong> → <strong>${t.to_name||''}</strong></td>
        <td>${sBadge(t.status, t.has_discrepancy)}</td>
        <td style="text-align:right">${t.total_boxes||0}</td>
        <td style="text-align:right">${(t.total_qty||0).toLocaleString('en-IN')}</td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${fmtDateTime(t.out_at)}<br><span style="color:var(--hmuted2,#6b7280)">${t.out_by||''}</span></td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${t.in_at ? (fmtDateTime(t.in_at) + '<br><span style="color:var(--hmuted2,#6b7280)">'+(t.in_by||'')+'</span>') : '—'}</td>
        <td style="text-align:center;white-space:nowrap">
          ${editBtn}
          <button onclick="event.stopPropagation();mvViewAnyVoucher(${t.transfer_id},'${t.status}')" title="View voucher" style="background:rgba(13,148,136,.08);border:1px solid rgba(13,148,136,.3);color:var(--teal,#0d9488);border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">👁 View</button>
          <button onclick="event.stopPropagation();printTransferVoucher(${t.transfer_id},'out')" title="Print OUT voucher" style="background:rgba(146,64,14,.08);border:1px solid rgba(146,64,14,.3);color:#92400e;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">🖨 OUT</button>
          ${(t.status === 'in_pending' || t.status === 'received') ? `
          <button onclick="event.stopPropagation();printTransferInVoucher(${t.transfer_id})" title="Print IN voucher" style="background:rgba(30,64,175,.08);border:1px solid rgba(30,64,175,.3);color:#1e40af;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">🖨 IN</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  renderPag('outCompletedPag', 'outCompleted', p.total, p.pages, p.page);
}

/* ────────────── IN VOUCHER LIST (completed, under IN subtab) ────────────── */
function mmClearInListFilters(){
  ['min-list-search','min-list-from','min-list-to'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  mmLoadInCompletedList();
}
async function mmLoadInCompletedList(){
  const tbody = document.getElementById('min-list-tbody');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="no-data">Loading…</td></tr>`;
  const params = new URLSearchParams();
  params.append('status','received');                 // only completed IN
  const s = (document.getElementById('min-list-search')?.value || '').trim();
  const f = (document.getElementById('min-list-from')?.value   || '').trim();
  const t = (document.getElementById('min-list-to')?.value     || '').trim();
  if(s) params.append('search', s);
  if(f) params.append('from_date', f);
  if(t) params.append('to_date', t);
  try {
    const res = await fetch('/api/pm_stock/transfers/list?' + params.toString());
    const d   = await res.json();
    if(d.status !== 'ok'){ tbody.innerHTML = `<tr><td colspan="7" class="no-data" style="color:#dc2626">${d.message||'load failed'}</td></tr>`; return; }
    window._mvInCompletedRows = d.transfers || [];
    if(_pag && _pag.inCompleted) _pag.inCompleted.page = 1;
    renderInCompleted();
  } catch(e){ tbody.innerHTML = `<tr><td colspan="7" class="no-data" style="color:#dc2626">${e.message}</td></tr>`; }
}

// Paginated renderer — slices window._mvInCompletedRows by _pag.inCompleted.
// Re-entered by reinCompleted() (page-button onclicks) without re-fetching.
function renderInCompleted(){
  const tbody = document.getElementById('min-list-tbody');
  if(!tbody) return;
  const rows = window._mvInCompletedRows || [];
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="7" class="no-data">No completed IN vouchers yet.</td></tr>`;
    const pag = document.getElementById('inCompletedPag'); if(pag) pag.innerHTML = '';
    return;
  }
  const p = paginate(rows, 'inCompleted');
  tbody.innerHTML = p.slice.map(t => `
      <tr>
        <td><a href="javascript:mvViewAnyVoucher(${t.transfer_id},'${t.status}')" style="font-family:monospace;font-weight:700;color:#1e40af;text-decoration:none">${t.transfer_no}</a></td>
        <td><strong>${t.from_name||''}</strong> → <strong>${t.to_name||''}</strong></td>
        <td style="text-align:right">${t.total_boxes||0}</td>
        <td style="text-align:right">${(t.total_qty||0).toLocaleString('en-IN')}</td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${fmtDateTime(t.out_at)}<br><span style="color:var(--hmuted2,#6b7280)">${t.out_by||''}</span></td>
        <td style="font-size:10px;color:var(--hmuted,#9ca3af)">${t.in_at ? (fmtDateTime(t.in_at) + '<br><span style="color:var(--hmuted2,#6b7280)">'+(t.in_by||'')+'</span>') : '—'}</td>
        <td style="text-align:center;white-space:nowrap">
          <button onclick="event.stopPropagation();mvViewAnyVoucher(${t.transfer_id},'${t.status}')" title="View voucher" style="background:rgba(30,64,175,.08);border:1px solid rgba(30,64,175,.3);color:#1e40af;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">👁 View</button>
          <button onclick="event.stopPropagation();printTransferInVoucher(${t.transfer_id})" title="Print IN voucher" style="background:rgba(30,64,175,.08);border:1px solid rgba(30,64,175,.3);color:#1e40af;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">🖨 IN</button>
          <button onclick="event.stopPropagation();printTransferVoucher(${t.transfer_id},'out')" title="Print OUT voucher" style="background:rgba(146,64,14,.08);border:1px solid rgba(146,64,14,.3);color:#92400e;border-radius:5px;padding:4px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">🖨 OUT</button>
        </td>
      </tr>
    `).join('');
  renderPag('inCompletedPag', 'inCompleted', p.total, p.pages, p.page);
}

async function forceDeleteTransfer(tid, label){
  if(!confirm(`Force-delete transfer ${label}?\nOnly works for 'out_started' transfers with no scanned boxes.`)) return;
  try {
    const res = await fetch(`/api/pm_stock/transfers/${tid}/force_delete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`✓ Deleted ${label}`,'success');
      // Refresh both views so the deleted row vanishes immediately
      // regardless of which tab the user clicked from.
      if(typeof mmLoadHistory === 'function')             mmLoadHistory();
      if(typeof loadVoucherLog === 'function')            loadVoucherLog();
      if(typeof mvRefreshInTransitCount === 'function')   mvRefreshInTransitCount();
    }
    else showToast(d.message || 'Failed','error', 4500);
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

// Full admin delete with stock reversal — works for ANY transfer status.
async function adminDeleteTransfer(tid, label, status, totalBoxes, totalQty){
  // Build a state-aware warning so admin understands what stock will revert
  const statusLabels = {
    out_started:  'DRAFT (no stock posted yet)',
    in_pending:   'IN-TRANSIT (source stock will be REFUNDED)',
    received:     'COMPLETE (source REFUNDED + destination UN-RECEIVED)',
    cancelled:    'CANCELLED (no stock to revert)'
  };
  const statusDesc = statusLabels[status] || status;

  let confirmMsg = `🗑 ADMIN DELETE — Transfer ${label}\n\n`;
  confirmMsg += `Current state: ${statusDesc}\n`;
  confirmMsg += `Boxes: ${totalBoxes} · Qty: ${(totalQty||0).toLocaleString('en-IN')}\n\n`;
  if(status === 'in_pending'){
    confirmMsg += `Source stock will be REFUNDED automatically.\n`;
  } else if(status === 'received'){
    confirmMsg += `Source stock will be REFUNDED and destination stock UN-RECEIVED.\n`;
    confirmMsg += `(Net effect: this transfer is fully un-done.)\n`;
  }
  confirmMsg += `\nThis cannot be undone. Continue?`;

  if(!confirm(confirmMsg)) return;

  // Find the row in the DOM (Voucher Log tab) and dim it during the request.
  // After success we remove it outright. After failure we restore it.
  // The row is identified by the inline onclick ‟adminDeleteTransfer(${tid}…”
  // — a brittle but reliable lookup since the table is rendered server-side.
  let domRow = null;
  try {
    domRow = document.querySelector(
      `[onclick*="adminDeleteTransfer(${tid},"]`
    )?.closest('tr');
    if(domRow) domRow.style.opacity = '0.4';
  } catch(_){}

  console.log(`[adminDeleteTransfer] tid=${tid} label=${label} status=${status} starting…`);

  try {
    const res = await fetch(`/api/pm_stock/transfers/${tid}/admin_delete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})   // empty body, but the Content-Type header is what
                                 // Flask's request.get_json() requires — without it,
                                 // Flask 3.x returns 415 Unsupported Media Type.
    });
    const d = await res.json();
    console.log(`[adminDeleteTransfer] response:`, d);

    if(d.status === 'ok'){
      const r = d.reversal || {};
      let toastMsg = `✓ ${label} deleted`;
      if(r.source_refunded > 0) toastMsg += ` · refunded ${r.source_refunded.toLocaleString('en-IN')} to source`;
      if(r.dest_unreceived > 0) toastMsg += ` · removed ${r.dest_unreceived.toLocaleString('en-IN')} from destination`;
      if(r.boxes_reverted > 0)  toastMsg += ` · ${r.boxes_reverted} box(es) reverted`;
      showToast(toastMsg, 'success', 6000);

      // Optimistic UI: remove the row immediately so the user sees the
      // deletion reflected without waiting for a re-fetch. The full
      // refresh below brings the rest of the list back into sync (totals,
      // pagination counters, etc.).
      if(domRow && domRow.parentNode){
        domRow.style.transition = 'opacity .25s, transform .25s';
        domRow.style.opacity = '0';
        domRow.style.transform = 'translateX(-12px)';
        setTimeout(() => { try { domRow.remove(); } catch(_){} }, 280);
      }

      // Full refresh of every view that might show transfers. Each is
      // guarded by typeof so missing functions don't throw.
      if(typeof mmLoadHistory === 'function')               mmLoadHistory();
      if(typeof loadVoucherLog === 'function')              loadVoucherLog();
      if(typeof mvRefreshInTransitCount === 'function')     mvRefreshInTransitCount();
      if(typeof mvRefreshDiscrepancyBanner === 'function')  mvRefreshDiscrepancyBanner();
      if(typeof loadSummary === 'function')                 loadSummary();
    } else {
      // Restore the row so user sees what they're trying to delete.
      if(domRow) domRow.style.opacity = '';
      console.error(`[adminDeleteTransfer] backend error:`, d);
      showToast(d.message || 'Delete failed','error', 5000);
    }
  } catch(e){
    if(domRow) domRow.style.opacity = '';
    console.error(`[adminDeleteTransfer] network/parse error:`, e);
    showToast('Error: '+e.message,'error');
  }
}

/* ────────────── PRINT VOUCHER ────────────── */
async function printTransferVoucher(transferId, voucherType){
  if(!transferId){ showToast('No transfer to print','error'); return; }
  voucherType = (voucherType || 'out').toLowerCase();
  try {
    // We fetch TWO endpoints in parallel:
    //
    //   /voucher_data — includes everything the print needs (header, edit
    //     history, discrepancy banner) AND a per-product expandable list
    //     of every physical scan ever made for this voucher. The catch:
    //     its `items[]` array aggregates from pm_box_movements, which
    //     means it counts ALL scans ever recorded — including scans that
    //     were later reverted by a cancel or excluded by an admin edit.
    //     So the headline qty on the print would show the original-scan
    //     total, not the current saved total.
    //
    //   /voucher/<tid> — reads from pm_transfer_items, which is the
    //     current authoritative state (what cancel / admin_edit have
    //     left the voucher at). Same data the admin-edit modal reads.
    //
    // We use voucher_data for everything EXCEPT item totals, then
    // overlay the live pm_transfer_items totals from /voucher/<tid> on
    // top so the printed headline qty matches the modal and matches
    // what stock movement actually recorded. The expandable scan-history
    // sublist still shows every physical scan (preserved as forensic
    // detail under a "Scan history" label).
    //
    // This is a frontend-only fix. The right place to fix this is on
    // the server (change the items SQL in api_transfer_voucher_data),
    // but until __init__.py deployment is solved we patch on the client.
    const [resData, resTruth] = await Promise.all([
      fetch(`/api/pm_stock/transfers/${transferId}/voucher_data?type=${encodeURIComponent(voucherType)}`),
      fetch(`/api/pm_stock/transfers/voucher/${transferId}`),
    ]);
    const data  = await resData.json();
    const truth = await resTruth.json();
    if(data.status !== 'ok'){ showToast(data.message || 'Could not load','error'); return; }

    // Overlay pm_transfer_items totals onto the print's items array. We
    // match by product_id. If a product appears in voucher_data items but
    // is missing from voucher/<tid> (very unusual — would mean ALL its
    // movements were reverted), we drop it from the print. If a product
    // appears in voucher/<tid> but not voucher_data, we add it (with no
    // box-history detail since voucher_data didn't return any).
    if(truth && truth.status === 'ok'){
      const truthArr = (voucherType === 'in') ? (truth.in_items || []) : (truth.out_items || []);
      const truthMap = {};
      truthArr.forEach(r => { truthMap[String(r.product_id)] = r; });
      const dataMap = {};
      (data.items || []).forEach(r => { dataMap[String(r.product_id)] = r; });

      const merged = [];
      // Start from the authoritative list — this gives us the right
      // line count and the right per-product totals.
      truthArr.forEach(tr => {
        const pid = String(tr.product_id);
        const orig = dataMap[pid] || {};
        merged.push({
          // Identity + display fields (prefer truth, fall back to data)
          product_id:    tr.product_id,
          product_name:  tr.product_name || orig.product_name || '',
          pm_type:       tr.pm_type      || orig.pm_type      || '',
          product_code:  tr.product_code || orig.product_code || '',
          brand_name:    tr.brand_name   || orig.brand_name   || '',
          // Authoritative totals (current state, post any cancel/edit)
          no_of_box:    Number(tr.no_of_box   || 0),
          per_box_qty:  Number(tr.per_box_qty || 0),
          total_qty:    Number(tr.total_qty   || 0),
          remarks:      tr.remarks || orig.remarks || '',
          // UOM (Phase 3) — primary always; alt + conversion only when this
          // line was fulfilling a Material Request entered in alt UOM.
          primary_uom:        tr.primary_uom || 'Nos',
          alt_uom:            tr.alt_uom || '',
          alt_to_primary_ratio: (tr.alt_to_primary_ratio != null) ? Number(tr.alt_to_primary_ratio) : null,
          linked_entered_uom:        tr.linked_entered_uom || '',
          linked_entered_qty_total:  (tr.linked_entered_qty_total != null) ? Number(tr.linked_entered_qty_total) : null,
          // Original physical-scan history (kept for the expandable detail)
          boxes:        orig.boxes || [],
        });
      });
      data.items = merged;
      // The header total_qty on the original voucher_data response was
      // computed from the box-movement aggregation. Recompute from the
      // merged truth so the print's "Total" footer also reflects current
      // state.
      const newTotalQty = merged.reduce((s, r) => s + (r.total_qty || 0), 0);
      const newTotalBox = merged.reduce((s, r) => s + (r.no_of_box || 0), 0);
      if(data.header){
        data.header.total_qty   = newTotalQty;
        data.header.total_boxes = newTotalBox;
      }
    } else {
      // truth fetch failed — fall through with voucher_data as-is. Print
      // will show original-scan totals; better than no print at all.
      console.warn('[printTransferVoucher] truth fetch failed; falling back to scan-aggregate totals',
                   truth && truth.message);
    }

    if(voucherType === 'in' && (!data.items || !data.items.length)){
      // Reconciled vouchers may have zero IN scans by design (the admin
      // accepted "nothing arrived"). Allow printing such vouchers — the
      // print template will show an explanatory empty-state row plus
      // the reconciliation note. For non-reconciled vouchers with zero
      // IN scans, keep the original block since printing a blank IN
      // voucher would be misleading.
      const h = data.header || {};
      const noteRaw = String(h.discrepancy_note || '');
      const isReconciled = (h.status === 'received')
                       && !h.has_discrepancy
                       && /RECONCILED:/i.test(noteRaw);
      if(!isReconciled){
        showToast('No IN scans yet','error', 5000); return;
      }
      // Reconciled with zero IN scans — fall through to render. The
      // print template renders an explicit "No boxes received"
      // explanation row using the OUT items as the reference.
    }
    _renderTransferVoucher(data, voucherType);
  } catch(e){ showToast('Error: ' + e.message, 'error'); }
}

function printTransferInVoucher(transferId){ printTransferVoucher(transferId, 'in'); }

function _renderTransferVoucher(payload, voucherType){
  const h     = payload.header || {};
  const items = payload.items  || [];
  const edits = payload.edits  || [];
  const creator       = payload.creator       || h.out_by || '';
  const lastEditor    = payload.last_editor   || creator;
  const editorsDiffer = !!payload.editors_differ;
  const distinctEditors = payload.distinct_editors || [];
  const isIn  = (voucherType === 'in');

  // Theme MUST be defined before we build `rows` since the detail-row HTML
  // references themeColor / themeBg via template literal. JS const has a
  // temporal dead zone — accessing before declaration throws.
  const themeColor = isIn ? '#1e40af' : '#92400e';
  const themeBg    = isIn ? '#eef2ff' : '#fef3c7';

  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fdt = (s) => { if(!s) return '—'; const dt = String(s).slice(0,10).split('-'); return dt.length===3?`${dt[2]}/${dt[1]}/${dt[0]}`:s; };
  const ftime = (s) => s ? (String(s).slice(11,16) || '—') : '—';
  const fdttime = (s) => s ? `${fdt(s)} ${ftime(s)}` : '—';
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const rows = items.map((it, i) => {
    const boxesRaw = Array.isArray(it.boxes) ? it.boxes : [];
    // Sort by the numeric suffix after the final "B" in the box code so the
    // printed/expanded scan history reads B001, B002, B003... regardless of
    // the order the boxes were physically scanned. Falls back to the box_id
    // for synthetic / non-matching codes so the order remains deterministic.
    const _boxNumKey = (b) => {
      const m = String(b.box_code || '').match(/B(\d+)\s*$/i);
      return m ? parseInt(m[1], 10) : (Number(b.box_id) || 0);
    };
    const boxes = boxesRaw.slice().sort((a, b) => _boxNumKey(a) - _boxNumKey(b));
    const hasBoxes = boxes.length > 0;
    // Headline count is `it.no_of_box` (current truth from pm_transfer_items
    // after any cancel/admin_edit). Sublist `boxes` is the physical scan
    // history from pm_box_movements — preserved as forensic detail. When
    // those numbers differ (because a cancel/edit changed the totals), be
    // explicit about it so the auditor isn't confused by mismatched figures.
    const scanCount    = boxes.length;
    const currentCount = Number(it.no_of_box || 0);
    const countsDiffer = (scanCount !== currentCount);
    const subListLabel = countsDiffer
      ? `📋 Scan history — ${scanCount} physical scan(s) recorded; current count is ${currentCount} after edits`
      : `📦 Scanned Boxes (${scanCount})`;
    const detailRowHtml = hasBoxes ? `
      <tr class="detail-row" id="detail-${i}" style="display:none;background:#f8f9fb">
        <td colspan="8" style="padding:0">
          <div style="padding:10px 16px 12px 56px;border-left:3px solid ${themeColor};background:${themeBg}">
            <div style="font-size:8.5px;font-weight:800;color:${countsDiffer ? '#92400e' : themeColor};text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">
              ${subListLabel}
            </div>
            <table style="width:100%;border:1px solid #d4d7dc;background:#fff;border-collapse:collapse">
              <thead>
                <tr style="background:#eef0f3 !important">
                  <th style="background:#eef0f3;color:#4b5563;font-size:8pt;padding:5px 8px;text-align:center;width:34px">#</th>
                  <th style="background:#eef0f3;color:#4b5563;font-size:8pt;padding:5px 8px;text-align:left">Box Code</th>
                  <th style="background:#eef0f3;color:#4b5563;font-size:8pt;padding:5px 8px;text-align:right;width:90px">Qty</th>
                  <th style="background:#eef0f3;color:#4b5563;font-size:8pt;padding:5px 8px;text-align:center;width:130px">Scanned At</th>
                  <th style="background:#eef0f3;color:#4b5563;font-size:8pt;padding:5px 8px;text-align:left;width:140px">By</th>
                </tr>
              </thead>
              <tbody>
                ${boxes.map((b, bi) => `
                  <tr style="border-bottom:1px solid #eef0f3">
                    <td style="padding:4px 8px;font-size:9pt;text-align:center;color:#9ca3af">${bi+1}</td>
                    <td style="padding:4px 8px;font-size:9pt;font-family:monospace;font-weight:700;color:#111;border-bottom:none">${esc(b.box_code)}</td>
                    <td style="padding:4px 8px;font-size:9pt;text-align:right;font-family:monospace;font-weight:700">${(b.per_box_qty||0).toLocaleString('en-IN')}</td>
                    <td style="padding:4px 8px;font-size:8.5pt;text-align:center;color:#6b7280">${fdttime(b.movement_at)}</td>
                    <td style="padding:4px 8px;font-size:8.5pt;color:#6b7280">${esc(b.moved_by)||'—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </td>
      </tr>` : '';

    // UOM (Phase 3) — show the conversion matrix when this transfer line
    // was fulfilling a Material Request entered in alt UOM. The total qty
    // cell renders as "120 Nos" with "= 0.008 Kg" below; the UOM column
    // shows the unit label. Direct (non-MR) transfers show just primary.
    const _pu  = (it.primary_uom || 'Nos');
    const _au  = (it.alt_uom || '');
    const _r   = (it.alt_to_primary_ratio != null) ? Number(it.alt_to_primary_ratio) : 0;
    const _leu = (it.linked_entered_uom || '').trim();
    const _hasAltLink = !!(_leu && _r > 0);
    // Total qty in alt UOM when this transfer line fulfilled an alt-entered
    // MR line. Always derive from total_qty × ratio so the matrix stays in
    // sync with the current transfer total even after admin edits.
    const _qtyAlt = _hasAltLink ? (Number(it.total_qty||0) * _r) : 0;
    const _qtyAltFmt = Math.abs(_qtyAlt - Math.round(_qtyAlt)) < 0.0005
                     ? Math.round(_qtyAlt).toLocaleString('en-IN')
                     : Number(_qtyAlt.toFixed(4)).toLocaleString('en-IN');
    const totalCell = _hasAltLink
      ? `<strong>${(it.total_qty||0).toLocaleString('en-IN')}</strong>`
        + `<div style="font-size:8.5pt;color:#666;font-weight:600;margin-top:1px">= ${_qtyAltFmt} ${esc(_leu)}</div>`
      : `<strong>${(it.total_qty||0).toLocaleString('en-IN')}</strong>`;
    const uomCell = _pu;

    return `
    <tr>
      <td class="exp-cell">
        ${hasBoxes ? `<button type="button" class="exp-btn" onclick="this.closest('tr').nextElementSibling && this.closest('tr').nextElementSibling.classList.contains('detail-row') && (this.closest('tr').nextElementSibling.style.display = this.closest('tr').nextElementSibling.style.display==='none' ? '' : 'none', this.classList.toggle('open'))" title="Show / hide individual scanned boxes">▸</button>` : ''}
      </td>
      <td class="c">${i+1}</td>
      <td><strong>${esc(it.product_name)}</strong>
        ${it.product_code ? `<br><span style="font-family:monospace;font-size:8.5px;color:#888;font-weight:700">${esc(it.product_code)}</span>` : ''}
        <br><span style="font-size:8.5px;color:#666">${esc(it.pm_type||'')}${it.brand_name?' · '+esc(it.brand_name):''}</span>
      </td>
      <td class="r">${it.no_of_box}</td>
      <td class="r">${(it.per_box_qty||0).toLocaleString('en-IN')}</td>
      <td class="r">${totalCell}</td>
      <td style="text-align:center;font-weight:700;font-size:9.5pt">${esc(uomCell)}</td>
      <td style="font-size:9.5px;color:#444">${esc(it.remarks||'')}</td>
    </tr>${detailRowHtml}`;
  }).join('');

  const totalBoxes = items.reduce((s,r)=>s+(r.no_of_box||0), 0);
  const totalQty   = items.reduce((s,r)=>s+(r.total_qty||0), 0);
  const statusColors = { out_started:['#3b82f6','Draft'], in_pending:['#f59e0b','In-Transit'], received:['#16a34a','Complete'], cancelled:['#6b7280','Cancelled'] };
  let [statusColor, statusLabel] = statusColors[h.status] || ['#6b7280', h.status];
  if(h.has_discrepancy){ statusColor = '#dc2626'; statusLabel = '⚠ Discrepancy'; }
  const voucherTitle = isIn ? 'MATERIAL IN VOUCHER' : 'MATERIAL OUT VOUCHER';

  const CSS = `*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:18px 24px}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid ${themeColor};padding-bottom:10px}
.voucher-title{font-size:22px;font-weight:900;color:${themeColor};letter-spacing:-.4px;line-height:1.05}
.co{font-size:9.5px;font-weight:700;color:#666;letter-spacing:.4px;margin-top:3px;text-transform:uppercase}
.co-sub{font-size:7.5px;color:#999;letter-spacing:.6px;margin-top:1px;text-transform:uppercase}
.vno{font-size:14px;font-weight:800;font-family:monospace;color:${themeColor};text-align:right}
.status-pill{display:inline-block;margin-top:4px;padding:2px 10px;border-radius:10px;font-size:9px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:.5px;background:${statusColor}}
.bar{display:grid;grid-template-columns:1.2fr 1fr 1fr 1.3fr 1.3fr;border:1px solid #ccc;margin-bottom:8px;margin-top:10px}
.bc{padding:6px 10px;border-right:1px solid #ccc}
.bc:last-child{border-right:none}
.bl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}
.bv{font-size:12px;font-weight:700;color:#111}
table{width:100%;border-collapse:collapse}
thead tr{background:${themeColor} !important}
th{color:#fff;padding:7px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:${themeColor}}
tr{border-bottom:1px solid #e5e7eb}
tbody tr:nth-child(even):not(.detail-row){background:#fafaf8}
td{padding:6px 8px;font-size:10.5px;vertical-align:middle}
.c{text-align:center;color:#9ca3af;width:28px;font-size:10px}
.r{text-align:right;font-family:monospace;font-weight:700}

/* Expand-arrow column */
.exp-cell{width:26px;text-align:center;padding:0 !important}
th.exp-cell{background:${themeColor}}
.exp-btn{
  width:20px;height:20px;border:1px solid ${themeColor};background:#fff;
  color:${themeColor};border-radius:4px;cursor:pointer;
  font-size:11px;font-weight:900;line-height:1;display:inline-flex;
  align-items:center;justify-content:center;padding:0;
  transition:transform .15s, background .15s;
}
.exp-btn:hover{background:${themeBg}}
.exp-btn.open{transform:rotate(90deg);background:${themeColor};color:#fff}
.detail-row td{padding:0 !important;background:transparent}

tfoot tr{background:${themeBg}!important;border-top:2px solid ${themeColor}}
tfoot td{font-weight:800;font-size:11px}
.discrep-warn{margin-top:10px;padding:10px 14px;background:rgba(220,38,38,.08);border:2px solid #dc2626;border-radius:5px;color:#991b1b;font-weight:800;font-size:11px}
.edits-banner{margin-top:10px;padding:8px 12px;background:#fff7ed;border:1px solid #fdba74;border-left:3px solid #ea580c;border-radius:4px}
.edits-title{font-size:7.5px;font-weight:800;color:#9a3412;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.edits-summary{font-size:10.5px;color:#111;font-weight:600}
.edits-list{margin-top:6px;display:flex;flex-direction:column;gap:2px}
.edits-row{display:flex;gap:8px;font-size:9px;color:#555;font-family:'Courier New',monospace}
.edits-row .et{color:#888;min-width:120px}
.edits-row .ea{color:#9a3412;font-weight:800;min-width:90px}

/* Print mode: hide the expand-toggle column entirely. Detail rows stay
   hidden by default and only the summary row prints — keeping the
   printed copy compact. Users can expand a row on screen to inspect
   individual scanned boxes before deciding to print. */
@media print {
  .exp-btn    { display: none !important; }
  .exp-cell   { width: 0; padding: 0 !important; }
  thead th.exp-cell { width: 0; padding: 0 !important; }
}
.edits-row .eu{color:#111;font-weight:700}
.edits-row .ed{color:#666;flex:1}
.sig{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #ccc;margin-top:20px}
.sb{padding:12px 10px;border-right:1px solid #ccc;min-height:52px}
.sb:last-child{border-right:none}
.sl{font-size:7px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.ft{text-align:center;font-size:8.5px;color:#9ca3af;margin-top:10px;border-top:1px solid #eee;padding-top:6px}
@media print{body{padding:8px 14px}button{display:none!important}}`;

  // Detect reconciled state and pull the human-readable note out of the
  // server-saved string ("RECONCILED: <note> [was: <orig_note>]").
  const reconciledNote = (() => {
    const raw = String(h.discrepancy_note || '');
    if(!/RECONCILED:/i.test(raw)) return '';
    const m = raw.match(/RECONCILED:\s*([\s\S]*?)\s*\[was:/i);
    return m ? m[1].trim() : '';
  })();
  const isReconciled = (h.status === 'received') && !h.has_discrepancy && !!reconciledNote;
  // Surface the reconciliation prominently on the print so anyone reading
  // the voucher (months later) immediately sees the explanation.
  const reconBannerHtml = isReconciled ? `<div style="margin:10px 0;padding:10px 14px;background:rgba(13,148,136,.06);border:1.5px solid rgba(13,148,136,.30);border-left:4px solid #0d9488;border-radius:4px"><div style="font-size:8px;font-weight:800;color:#0d9488;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">🔧 Reconciled (admin override)</div><div style="font-size:10.5px;color:#111;line-height:1.4"><strong>Note:</strong> ${esc(reconciledNote)}</div><div style="font-size:9px;color:#666;margin-top:4px;font-style:italic">Source-side stock has been corrected to balance. Difference between OUT and IN counts has been formally accepted.</div></div>` : '';

  // Empty-state for an IN voucher of a reconciled transfer (zero IN scans
  // is legitimate after reconcile — admin accepted "nothing arrived").
  // Render an explicit row instead of a blank table.
  const isEmptyReconciledIn = isIn && isReconciled && items.length === 0;
  const emptyRowHtml = isEmptyReconciledIn
    ? `<tr><td colspan="8" style="padding:24px;text-align:center;background:rgba(13,148,136,.04)"><div style="font-size:11px;color:#0d9488;font-weight:700">No boxes were scanned at destination</div><div style="font-size:9.5px;color:#6b7280;margin-top:3px">The discrepancy was reconciled by an admin — see note above.</div></td></tr>`
    : '';

  const barTimeBlock = isIn
    ? `<div class="bc"><div class="bl">IN Date</div><div class="bv">${fdt(h.in_at)}</div></div><div class="bc"><div class="bl">IN Time</div><div class="bv">${ftime(h.in_at)}</div></div>`
    : `<div class="bc"><div class="bl">OUT Date</div><div class="bv">${fdt(h.out_at)}</div></div><div class="bc"><div class="bl">OUT Time</div><div class="bv">${ftime(h.out_at)}</div></div>`;

  // Edit history: filter out per-box scan_out/scan_in events (they're
  // already shown via the expandable detail rows under each item). Keep
  // only meaningful state transitions: voucher_create, save_out,
  // save_in_*, edit, delete, reconcile, etc. This drops 30+ noise lines
  // on a typical 16-box voucher and keeps the banner concise.
  const NOISY_ACTIONS = new Set(['scan_out', 'scan_in', 'unscan_out', 'unscan_in']);
  const meaningfulEdits = edits.filter(e => !NOISY_ACTIONS.has((e.action || '').toLowerCase()));

  const editorBannerHtml = (editorsDiffer || meaningfulEdits.length > 1) ? `<div class="edits-banner">
    <div class="edits-title">Edit History · ${meaningfulEdits.length} action${meaningfulEdits.length===1?'':'s'} by ${distinctEditors.length} user${distinctEditors.length===1?'':'s'}</div>
    <div class="edits-summary">Created by <strong>${esc(creator)}</strong>${editorsDiffer ? ` · Last edited by <strong>${esc(lastEditor)}</strong>` : ''}</div>
    <div class="edits-list">
      ${meaningfulEdits.map(e => `<div class="edits-row"><span class="et">${esc(fdttime(e.edited_at))}</span><span class="ea">${esc(e.action)}</span><span class="eu">${esc(e.edited_by)}</span><span class="ed">${esc(e.details||'')}</span></div>`).join('')}
    </div>
  </div>` : '';

  const win = window.open('','_blank','width=860,height=720');
  if(!win){ showToast('Pop-up blocked','error'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${isIn?'IN':'OUT'} ${esc(h.transfer_no)}</title><style>${CSS}</style></head><body>
<div class="hd">
  <div>
    <div class="voucher-title">${voucherTitle}</div>
    <div class="co">HCP Wellness Pvt Ltd</div>
    <div class="co-sub">PM Material ${isIn ? 'Receipt' : 'Dispatch'} Voucher</div>
    <div class="status-pill">${statusLabel}</div>
  </div>
  <div class="vno">${esc(h.transfer_no)}</div>
</div>
<div class="bar">
  <div class="bc"><div class="bl">Transfer No.</div><div class="bv">${esc(h.transfer_no)}</div></div>
  ${barTimeBlock}
  <div class="bc"><div class="bl">Source</div><div class="bv">${esc(h.from_name||'—')}</div></div>
  <div class="bc"><div class="bl">Destination</div><div class="bv">${esc(h.to_name||'—')}</div></div>
</div>
${h.has_discrepancy ? `<div class="discrep-warn">⚠ DISCREPANCY: ${esc(h.discrepancy_note || 'Counts mismatch')}</div>` : ''}
${reconBannerHtml}
<table>
  <thead><tr><th class="exp-cell"></th><th class="c">#</th><th style="text-align:left">Product</th><th class="r" style="width:80px">${isIn ? 'Boxes In' : 'No. of Box'}</th><th class="r" style="width:90px">Per Box Qty</th><th class="r" style="width:110px">Total Qty</th><th class="c" style="width:60px">UOM</th><th style="text-align:left;width:150px">Remarks</th></tr></thead>
  <tbody>${rows}${emptyRowHtml}</tbody>
  <tfoot><tr><td colspan="3">Total — ${items.length} product(s)</td><td class="r">${totalBoxes}</td><td class="r">—</td><td class="r">${totalQty.toLocaleString('en-IN')}</td><td></td><td></td></tr></tfoot>
</table>
${h.remarks ? `<div style="margin-top:8px;padding:8px 10px;background:${themeBg};border-left:3px solid ${themeColor};border-radius:3px"><div style="font-size:7px;font-weight:800;color:${themeColor};text-transform:uppercase">Remarks</div><div style="font-size:10.5px;margin-top:2px">${esc(h.remarks)}</div></div>` : ''}
${editorBannerHtml}
<div class="sig">
  <div class="sb"><div class="sl">Issued By</div><div style="font-size:9.5px;font-weight:700;margin-top:2px">${esc(h.out_by||'')}</div></div>
  <div class="sb"><div class="sl">Carried / Driver</div></div>
  <div class="sb"><div class="sl">Received By</div><div style="font-size:9.5px;font-weight:700;margin-top:2px">${esc(h.in_by||'')}</div></div>
</div>
<div class="ft">${esc(voucherTitle)} · ${esc(h.transfer_no)} · HCP Wellness Pvt Ltd · Printed ${new Date().toLocaleString('en-IN')}</div>
<br><button onclick="window.print()" style="padding:6px 14px;background:${themeColor};color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700">🖨 Print</button>
</body></html>`);
  win.document.close();
  win.onload = () => { win.focus(); win.print(); };
}

function mmOnTabActivate(){
  _populateGodownSelects();
  moutValidateForm();
  if(_mmSubTab === 'out')     mmLoadOutList();
  if(_mmSubTab === 'in')      { mvLoadInTransit(); mmLoadInCompletedList(); }
  else                        mvRefreshInTransitCount();
  if(_mmSubTab === 'history') mmLoadHistory();
  mvRefreshDiscrepancyBanner();
}

setTimeout(() => mvRefreshDiscrepancyBanner(), 2000);

// Periodic banner refresh — picks up reconciliations done in another
// session/tab. 60s feels right: not so fast it hammers the API, not so
// slow that an admin in another tab leaves their colleague staring at
// a stale "1 transfer has a discrepancy" banner.
if(!window._mvBannerInterval){
  window._mvBannerInterval = setInterval(() => {
    if(typeof mvRefreshDiscrepancyBanner === 'function') mvRefreshDiscrepancyBanner();
  }, 60_000);
}

// On tab refocus, immediately re-check. Catches the case where a user
// reconciles in another tab and switches back here — the banner updates
// within a second instead of waiting for the next 60s tick.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible'){
    if(typeof mvRefreshDiscrepancyBanner === 'function') mvRefreshDiscrepancyBanner();
  }
});


/* ══════════════════════════════════════════════════════════════
   QR-pipeline scan handlers for Material Movement vouchers
   ──────────────────────────────────────────────────────────────
   The global QR pipeline (qrHandleRaw in pm_stock_qr.js) routes
   scans to these functions when the active modal is mvOutModal
   or mvInModal. Without these, scans triggered via the camera
   modal or global handheld interceptor would fall through to
   "stock-ge" (Godown Entry) and silently do nothing useful from
   the user's perspective. The handlers reuse the same backend
   /scan_box endpoint as the modal-local input, so behavior is
   identical regardless of how the scan arrived.
══════════════════════════════════════════════════════════════ */
async function moutHandleScan(box, code){
  if(!_mvOut){ showToast('No active OUT voucher','error'); return; }
  try {
    const result = await _scanCodeWithGroupSupport(_mvOut.transfer_id, code, 'out');
    if(result.single){
      if(!result.ok){
        if(result.code === 'fifo_violation' && result.fifo){
          _showFifoViolationModal(result.fifo, code, _mvOut.transfer_id);
          return;
        }
        if(result.code === 'fifo_override_requestable' && result.fifo){
          _showFifoViolationModal(result.fifo, code, _mvOut.transfer_id, result.box_id, result.pending);
          return;
        }
        _voiceNotScanned();
        showToast(result.message || 'Scan failed','error', 4500);
        return;
      }
      _voiceScanned();
      showToast(`✓ ${result.result.box.product_name} +1 box`, 'success', 2000);
      _mvOutCheckRequestOverscan(result.result);
    } else {
      _showGroupScanSummary(result, 'out');
    }
    mvOpenOutVoucher(_mvOut.transfer_id);
  } catch(e){
    showToast('Network error: '+(e.message||e),'error', 4500);
  }
}

async function minHandleScan(box, code){
  if(!_mvIn){ showToast('No active IN voucher','error'); return; }
  if(_mvIn.in_locked_for_user){
    showToast(_mvIn.in_locked_reason || 'Locked: a different user must scan IN','error', 4000);
    return;
  }
  try {
    const result = await _scanCodeWithGroupSupport(_mvIn.transfer_id, code, 'in');
    if(result.single){
      if(!result.ok){
        _voiceNotScanned();
        showToast(result.message || 'Scan failed','error', 4500);
        return;
      }
      _voiceScanned();
      showToast(`✓ ${result.result.box.product_name} +1 IN`, 'success', 2000);
    } else {
      _showGroupScanSummary(result, 'in');
    }
    mvOpenInVoucher(_mvIn.transfer_id);
  } catch(e){
    showToast('Network error: '+(e.message||e),'error', 4500);
  }
}

/* ════════════════════════════════════════════════════════════════
   OUT-SIDE BOX SCAN DETAIL (per-product drilldown)
   Triggered when the operator clicks a row in the IN voucher modal.
   Opens a small modal listing every physical box scanned OUT for
   that product on this transfer, with timestamp + scanner identity,
   plus a Print button that opens a clean printable view.
   Read-only — no scanning happens here.
════════════════════════════════════════════════════════════════ */

let _mvBoxScans = { tid:null, productId:null, transfer:null, product:null, boxes:[], qtyTotal:0 };

function _mvbsEnsureModal(){
  if(document.getElementById('mvBoxScansModal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="modal-overlay" id="mvBoxScansModal" style="z-index:1100">
    <div class="modal" style="width:min(96vw,820px);max-width:820px;max-height:88vh;padding:0;overflow:hidden;display:flex;flex-direction:column;border-radius:12px">
      <div style="padding:12px 18px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));background:linear-gradient(135deg,#1e40af 0%,#3b82f6 100%);color:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0">
        <div>
          <div style="font-size:10.5px;font-weight:700;opacity:.85;letter-spacing:.5px;text-transform:uppercase">📦 OUT-Scanned Boxes</div>
          <div style="font-size:14px;font-weight:800;margin-top:2px"><span id="mvbs-product">—</span></div>
          <div style="font-size:10px;opacity:.85;margin-top:2px"><span id="mvbs-vno">—</span></div>
        </div>
        <button onclick="closeModal('mvBoxScansModal')" style="background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;width:30px;height:30px;font-size:16px;cursor:pointer">×</button>
      </div>

      <div style="padding:12px 18px;display:flex;gap:14px;flex-wrap:wrap;background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07));flex-shrink:0">
        <div style="flex:1;min-width:120px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Boxes</div>
          <div id="mvbs-count" style="font-size:14px;font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-variant-numeric:tabular-nums">0</div>
        </div>
        <div style="flex:1;min-width:120px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Total Qty</div>
          <div id="mvbs-qty" style="font-size:14px;font-weight:800;color:var(--htxtb,#111);margin-top:2px;font-variant-numeric:tabular-nums">0.00</div>
        </div>
        <div style="flex:2;min-width:200px">
          <div style="font-size:9.5px;font-weight:800;color:var(--hmuted,#9ca3af);text-transform:uppercase;letter-spacing:.6px">Source → Destination</div>
          <div id="mvbs-route" style="font-size:11.5px;font-weight:700;color:var(--htxtb,#111);margin-top:2px">—</div>
        </div>
      </div>

      <div style="flex:1;overflow:auto;padding:0">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:linear-gradient(to bottom,var(--nb-surface,#f8f9fa) 0%,var(--nb-surface-2,#f1f3f4) 100%);color:var(--nb-text-muted,#444746);position:sticky;top:0;border-bottom:1px solid var(--nb-border-strong,rgba(70,72,212,.14))">
              <th style="text-align:left;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;width:40px">#</th>
              <th style="text-align:left;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Box Code</th>
              <th style="text-align:right;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;width:90px">Qty / Box</th>
              <th style="text-align:left;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;width:130px">Scanned By</th>
              <th style="text-align:left;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;width:160px">Timestamp</th>
              <!-- Remove column: lets any user pull a wrong-scanned box back to in-stock.
                   Rendered empty for non-removable rows (server-side status doesn't allow
                   unscan on this voucher, OR the user is read-only). -->
              <th style="text-align:center;padding:11px 14px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;width:60px">Remove</th>
            </tr>
          </thead>
          <tbody id="mvbs-tbody">
            <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:10px 18px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));background:var(--hsurf2,#f8fafc);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="closeModal('mvBoxScansModal')">Close</button>
        <button class="btn btn-primary btn-sm" onclick="mvPrintBoxScans()" id="mvbs-print-btn"
          style="background:#1e40af;border-color:#1e40af">
          <i class="fas fa-print"></i> Print
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap.firstElementChild);
}

async function mvShowOutBoxScans(productId){
  if(!_mvIn || !_mvIn.transfer_id){
    if(typeof showToast==='function') showToast('Voucher not loaded','error');
    return;
  }
  const tid = _mvIn.transfer_id;
  _mvbsEnsureModal();
  // Reset modal state for the new fetch
  _mvBoxScans = { tid, productId, transfer:null, product:null, boxes:[], qtyTotal:0 };
  document.getElementById('mvbs-product').textContent = '—';
  document.getElementById('mvbs-vno').textContent     = '—';
  document.getElementById('mvbs-count').textContent   = '0';
  document.getElementById('mvbs-qty').textContent     = '0.00';
  document.getElementById('mvbs-route').textContent   = '—';
  document.getElementById('mvbs-tbody').innerHTML =
    `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af)"><span class="spinner"></span> Loading box scans…</td></tr>`;
  document.getElementById('mvbs-print-btn').disabled = true;
  document.getElementById('mvBoxScansModal').classList.add('open');

  try {
    // We use the EXISTING /voucher_data endpoint which is already deployed
    // and is already used by the printed voucher (the print template you
    // already have shows "SCANNED BOXES" rows under each product line).
    // It returns header + items[*].boxes[*]{box_code, per_box_qty,
    // movement_at, moved_by} — exactly the shape we need. We filter to
    // one product client-side. This avoids needing a new endpoint or a
    // Flask restart.
    const url = `/api/pm_stock/transfers/${tid}/voucher_data?type=out`;
    const res = await fetch(url);
    const raw = await res.text();
    let d;
    try {
      d = JSON.parse(raw);
    } catch (_parseErr) {
      console.error('[mvShowOutBoxScans] non-JSON response',
        {status: res.status, url, preview: raw.slice(0, 200)});
      let hint;
      if (res.status === 404)      hint = 'Voucher endpoint not found (404).';
      else if (res.status === 401 || res.status === 403)
                                   hint = `Not authorized (${res.status}). Try refreshing and logging in.`;
      else if (res.status >= 500)  hint = `Server error (${res.status}). Check Flask logs.`;
      else if (!raw.trim())        hint = `Empty response (status ${res.status}).`;
      else                         hint = `Unexpected response (status ${res.status}). Check console.`;
      document.getElementById('mvbs-tbody').innerHTML =
        `<tr><td colspan="6" style="padding:24px;text-align:center;color:#dc2626;line-height:1.5">${hint}</td></tr>`;
      return;
    }
    if(!d || d.status !== 'ok'){
      document.getElementById('mvbs-tbody').innerHTML =
        `<tr><td colspan="6" style="padding:24px;text-align:center;color:#dc2626">${(d && d.message) || 'Failed to load'}</td></tr>`;
      return;
    }
    // Find the requested product line in the items array. Match on
    // product_id (loose equality so number/string both work).
    const item = (d.items || []).find(it => String(it.product_id) === String(productId));
    if(!item){
      document.getElementById('mvbs-tbody').innerHTML =
        `<tr><td colspan="6" style="padding:24px;text-align:center;color:#dc2626">No OUT scans for this product on voucher ${(d.header && d.header.transfer_no) || ''}.</td></tr>`;
      return;
    }
    const boxes = item.boxes || [];
    const qtyTotal = boxes.reduce((s, b) => s + Number(b.per_box_qty || 0), 0);
    _mvBoxScans = {
      tid, productId,
      transfer: d.header || {},
      product: {
        id:           item.product_id,
        product_name: item.product_name || '',
        product_code: item.product_code || '',
        pm_type:      item.pm_type      || '',
      },
      boxes:    boxes,
      qtyTotal: qtyTotal,
    };
    _mvbsRender();
  } catch(e){
    console.error('[mvShowOutBoxScans] fetch failed', e);
    document.getElementById('mvbs-tbody').innerHTML =
      `<tr><td colspan="6" style="padding:24px;text-align:center;color:#dc2626">Network error: ${e.message}</td></tr>`;
  }
}

function _mvbsFmtTs(s){
  if(!s) return '—';
  // Backend gives 'YYYY-MM-DD HH:MM:SS'. Render as DD/MM/YYYY HH:MM
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if(!m) return s;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}
function _mvbsEsc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _mvbsRender(){
  const t = _mvBoxScans.transfer || {};
  const p = _mvBoxScans.product  || {};
  const boxes = _mvBoxScans.boxes || [];
  document.getElementById('mvbs-product').textContent =
    `${p.product_name || '—'}${p.product_code ? ' · ' + p.product_code : ''}`;
  document.getElementById('mvbs-vno').textContent = `Voucher: ${t.transfer_no || '—'}`;
  document.getElementById('mvbs-count').textContent = boxes.length.toString();
  document.getElementById('mvbs-qty').textContent   = _mvBoxScans.qtyTotal.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  document.getElementById('mvbs-route').textContent = `${t.from_name || '—'}  →  ${t.to_name || '—'}`;
  const tbody = document.getElementById('mvbs-tbody');
  if(!boxes.length){
    tbody.innerHTML = `<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--hmuted,#9ca3af)">No OUT scans recorded for this product on this voucher.</td></tr>`;
    document.getElementById('mvbs-print-btn').disabled = true;
    return;
  }
  // ── Should we offer per-row "Remove" buttons? ────────────────────
  // Two gates the server will also enforce, mirrored here for nice UI:
  //   1. Voucher must be in the OUT-editing window (status='out_started').
  //      Once OUT is saved (status moves to 'in_pending' or beyond), an
  //      operator-level unscan would desync the already-posted stock txn,
  //      so the server rejects it for non-admins. We hide the × for
  //      anyone not admin in that case.
  //   2. Voucher type — even for non-admins, removing a scanned box on
  //      a draft is fine; the per-line cleanup runs server-side.
  // If a future call needs admin-only override regardless of status,
  // we'd need a separate "is admin" hint in the response. For now we
  // keep it simple: anyone can remove on 'out_started', no one can after.
  const xferStatus = (t.status || '').toLowerCase();
  const removalEnabled = (xferStatus === 'out_started');
  tbody.innerHTML = boxes.map((b, i) => {
    // Prefer the compact short_code in the visible cell when one exists
    // (matches what the QR encodes and what an operator would type
    // manually). Fall back to the long box_code for legacy rows.
    const displayCode = b.short_code || b.box_code || '';
    const removeCell = removalEnabled && b.box_id
      ? `<button onclick="mvbsRemoveBox(${b.box_id})"
                  title="Remove this box from the voucher — it returns to in-stock and can be re-scanned"
                  style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#dc2626;
                         border-radius:5px;padding:3px 9px;font-size:11px;font-weight:800;cursor:pointer;line-height:1"
                  onmouseover="this.style.background='rgba(220,38,38,.18)'"
                  onmouseout="this.style.background='rgba(220,38,38,.08)'">×</button>`
      : `<span style="color:var(--hmuted,#cbd5e1);font-size:10.5px" title="Removable only while voucher is in draft (out_started)">—</span>`;
    return `
    <tr style="${i%2 ? 'background:var(--hsurf2,#f9fafb)' : ''}">
      <td style="padding:7px 10px;color:var(--hmuted,#9ca3af);font-size:11px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${i+1}</td>
      <td style="padding:7px 10px;font-family:var(--font-mono,monospace);font-size:11.5px;font-weight:700;color:#1e40af;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${_mvbsEsc(displayCode)}</td>
      <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${Number(b.per_box_qty || 0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
      <td style="padding:7px 10px;color:var(--htxtb,#111);font-size:11.5px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${_mvbsEsc(b.moved_by || '—')}</td>
      <td style="padding:7px 10px;color:var(--htxtb,#111);font-size:11px;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${_mvbsFmtTs(b.movement_at)}</td>
      <td style="padding:5px 10px;text-align:center;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">${removeCell}</td>
    </tr>`;
  }).join('');
  document.getElementById('mvbs-print-btn').disabled = false;
}

// Remove ONE scanned box from the OUT-Scanned Boxes modal. Backed by the
// existing /api/pm_stock/transfers/voucher/<tid>/unscan_box endpoint —
// server reverts the box to in_stock and decrements the line, or deletes
// the line entirely if it was the last box.
//
// On success we re-fetch this modal's data so the row vanishes and the
// header counters (boxes, total qty) refresh. We don't close the modal —
// the user might want to remove more.
async function mvbsRemoveBox(boxId){
  if(!boxId) return;
  const tid = _mvBoxScans && _mvBoxScans.tid;
  if(!tid){
    if(typeof showToast === 'function') showToast('Voucher not loaded','error');
    return;
  }
  if(!confirm('Remove this box from the voucher?\n\n' +
              'It will return to in-stock and can be scanned again.')) return;
  try {
    const res = await fetch(
      `/api/pm_stock/transfers/voucher/${tid}/unscan_box`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ box_id: boxId })
      }
    );
    const d = await res.json();
    if(d.status === 'ok'){
      const msg = d.line_deleted
        ? '✓ Box removed (line cleared)'
        : `✓ Box removed (${d.remaining_boxes} left on line)`;
      if(typeof showToast === 'function') showToast(msg, 'success', 2500);
      // Re-fetch the modal data so the row disappears and counters update.
      // If the line itself was deleted (last box on the line), there's no
      // product to drill back into — close the modal in that case.
      if(d.line_deleted){
        if(typeof closeModal === 'function') closeModal('mvBoxScansModal');
        // Refresh the parent IN voucher view so the missing line shows
        // up correctly there too.
        if(_mvIn && _mvIn.transfer_id && typeof mvOpenInVoucher === 'function'){
          mvOpenInVoucher(_mvIn.transfer_id);
        }
      } else if(_mvBoxScans.productId){
        // Re-pull the OUT-scanned list for this product.
        mvShowOutBoxScans(_mvBoxScans.productId);
        // Also nudge the parent IN voucher to refresh totals.
        if(_mvIn && _mvIn.transfer_id && typeof mvOpenInVoucher === 'function'){
          mvOpenInVoucher(_mvIn.transfer_id);
        }
      }
    } else {
      if(typeof showToast === 'function') showToast(d.message || 'Remove failed', 'error');
    }
  } catch(e){
    if(typeof showToast === 'function') showToast('Error: ' + e.message, 'error');
  }
}

function mvPrintBoxScans(){
  const t = _mvBoxScans.transfer || {};
  const p = _mvBoxScans.product  || {};
  const boxes = _mvBoxScans.boxes || [];
  if(!boxes.length){
    if(typeof showToast==='function') showToast('Nothing to print','error');
    return;
  }
  const esc = _mvbsEsc;
  const fmtTs = _mvbsFmtTs;
  const qtyTotal = _mvBoxScans.qtyTotal;
  const printedAt = (() => { const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const printedBy = (window.__pmLoginUser || window.__pmUser || (typeof _loginUserName==='function' ? _loginUserName() : '')) || '';

  const w = window.open('', '_blank', 'width=860,height=720');
  if(!w){ if(typeof showToast==='function') showToast('Pop-up blocked','error'); return; }
  const css = `
    *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:18px 24px}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #1e40af;padding-bottom:10px;margin-bottom:14px}
    h1{font-size:20px;font-weight:900;color:#1e40af;letter-spacing:-.3px;line-height:1.05}
    .co{font-size:9.5px;font-weight:700;color:#666;letter-spacing:.4px;margin-top:3px;text-transform:uppercase}
    .vno{font-size:13px;font-weight:800;font-family:monospace;color:#1e40af;text-align:right}
    .vsub{font-size:9.5px;color:#666;text-align:right;margin-top:2px}
    .info{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;border:1px solid #d1d5db;margin-bottom:12px}
    .ic{padding:6px 10px;border-right:1px solid #d1d5db}
    .ic:last-child{border-right:none}
    .il{font-size:7.5px;font-weight:800;color:#888;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px}
    .iv{font-size:11.5px;font-weight:700;color:#111}
    table{width:100%;border-collapse:collapse;margin-top:4px}
    thead tr{background:#1e40af !important}
    th{color:#fff;padding:7px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#1e40af;text-align:left}
    th.r{text-align:right}
    td{padding:6px 9px;font-size:10.5px;border-bottom:1px solid #e5e7eb;vertical-align:middle}
    tbody tr:nth-child(even){background:#fafaf8}
    .mono{font-family:monospace;font-weight:700;color:#1e40af}
    .r{text-align:right;font-variant-numeric:tabular-nums}
    tfoot td{font-weight:800;background:#eff6ff;border-top:2px solid #1e40af;font-size:11px}
    .ft{margin-top:14px;padding-top:8px;border-top:1px dashed #d1d5db;display:flex;justify-content:space-between;font-size:9px;color:#888}
    .sig{margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:30px}
    .sb{border-top:1px solid #888;padding-top:4px;text-align:center}
    .sl{font-size:8px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.5px}
    @media print{button,.no-print{display:none}}
  `;
  const rows = boxes.map((b, i) => `
    <tr>
      <td style="text-align:center;color:#9ca3af">${i+1}</td>
      <td class="mono">${esc(b.box_code)}</td>
      <td class="r">${Number(b.per_box_qty || 0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
      <td>${esc(b.moved_by || '—')}</td>
      <td>${esc(fmtTs(b.movement_at))}</td>
    </tr>
  `).join('');

  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>OUT Box Scans · ${esc(t.transfer_no || '')}</title><style>${css}</style></head><body>
    <div class="hd">
      <div>
        <h1>OUT-Scanned Boxes</h1>
        <div class="co">HCP Wellness Pvt Ltd · PM Stock Management</div>
      </div>
      <div>
        <div class="vno">${esc(t.transfer_no || '—')}</div>
        <div class="vsub">${esc(t.from_name || '—')} → ${esc(t.to_name || '—')}</div>
      </div>
    </div>

    <div class="info">
      <div class="ic"><div class="il">Product</div><div class="iv">${esc(p.product_name || '—')}</div></div>
      <div class="ic"><div class="il">Product Code</div><div class="iv">${esc(p.product_code || '—')}</div></div>
      <div class="ic"><div class="il">Boxes</div><div class="iv">${boxes.length}</div></div>
      <div class="ic"><div class="il">Total Qty</div><div class="iv">${qtyTotal.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
    </div>

    <table>
      <thead><tr>
        <th style="text-align:center;width:32px">#</th>
        <th>Box Code</th>
        <th class="r" style="width:90px">Qty / Box</th>
        <th style="width:130px">Scanned By</th>
        <th style="width:140px">Timestamp</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="2">Total — ${boxes.length} box(es)</td>
        <td class="r">${qtyTotal.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table>

    <div class="sig">
      <div class="sb"><div class="sl">Operator / Verified By</div></div>
      <div class="sb"><div class="sl">Supervisor</div></div>
    </div>

    <div class="ft">
      <div>Printed: ${esc(printedAt)}${printedBy ? ' · by ' + esc(printedBy) : ''}</div>
      <div>HCP Wellness Pvt Ltd</div>
    </div>

    <script>setTimeout(function(){ window.print(); }, 200);</${'script'}>
  </body></html>`);
  w.document.close();
}
