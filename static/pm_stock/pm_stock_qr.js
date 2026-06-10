/* ════════════════════════════════════════════════════════════════
   QR SCANNER ENGINE  —  HANDHELD-ONLY EDITION
   HCP Wellness · pm_stock_qr.js
   ────────────────────────────────────────────────────────────────
   Hardware: USB / Bluetooth barcode scanners only. No camera.
   Scanners emulate a keyboard — they type the code at high speed
   and end with Enter. We intercept those bursts globally.

   Scanned QR contains a box_code (e.g. "BEARTUBE12-G0234-B003").
   The scanner looks up the box server-side, then dispatches to:
   - GRN form (new or edit) → adds item row pre-filled
   - MTV form (new or edit) → adds item row pre-filled
   - Stock Entry tab → fills ge- (Godown) or fe- (Factory) form
   - Inventory Godown View → opens box history modal
   - Material OUT / IN screens
════════════════════════════════════════════════════════════════ */

let _qrTarget = 'auto';

// A valid box_code looks like:  PRODUCTCODE-G####-B###  (GRN-created box)
//                            or  PRODUCTCODE-OP####-B### (Opening-stock box)
// Product part is alphanumeric uppercase, 1-12 chars (we use 10).
const _BOX_CODE_RE = /^[A-Z0-9]{1,12}-(?:G|OP)\d{3,5}-B\d{2,4}$/i;
// Short-code format: compact 6-12 alphanumeric code (A0006058, B123456, etc.).
// Newer GRN/OP labels encode the short_code in the QR for tighter density.
// The backend's /boxes/by_code endpoint resolves both formats (OR-clause on
// short_code OR box_code), so any short scan goes through the same look-up.
//
// Anchored to A-Z0-9, length 6-12, with no dashes — sharp enough to avoid
// matching arbitrary strings while accepting all generated short codes.
const _SHORT_CODE_RE = /^[A-Z0-9]{6,12}$/i;
// A valid group/bag code looks like: BAG-PRODUCTCODE-G####-L###
// Scanned group codes route through the group endpoint which fans out to
// each member box. The MTV/transfer scan inputs detect the BAG- prefix and
// dispatch via _scanCodeWithGroupSupport (defined in pm_stock_movement.js);
// the global QR pipeline below treats bag scans as a special look-up case
// that displays group info rather than single-box info.
const _GROUP_CODE_RE = /^BAG-[A-Z0-9]{1,12}-(?:G|OP)\d{3,5}-L\d{2,4}$/i;

// Helper: true if the scanned string looks like ANY valid box code format
// (long box_code OR compact short_code). Used everywhere we previously
// called _BOX_CODE_RE.test() to gate the lookup. Bag codes are checked
// separately via _GROUP_CODE_RE.
function _looksLikeBoxCode(s){
  if(!s) return false;
  return _BOX_CODE_RE.test(s) || _SHORT_CODE_RE.test(s);
}

/* ── Global handheld scanner interceptor ─────────────────────
   Scanners type very fast (<80ms per char), end with Enter.
   We buffer chars; on Enter, if the buffer matches a box code → intercept.

   This is the ONLY input mode for QR codes. There is no camera.
───────────────────────────────────────────────────────────── */
(function(){
  let buf = '', lastT = 0;
  // IDs of inputs where we want scanner bursts to be redirected to qrHandleRaw
  // instead of being typed into the input.
  const _ALLOW_IDS = new Set(['qrs-paste-input', 'ct-search']);
  // IDs where the input itself handles scans natively (its own onkeydown
  // reads the input value on Enter). For these we want chars to flow
  // into the input AS-IS and we explicitly do NOT intercept the Enter
  // burst — the input's handler will fire on its own.
  //
  // To register a new native-scan input from another module, push its ID:
  //   window._NATIVE_SCAN_IDS && window._NATIVE_SCAN_IDS.add('my-scan-input');
  const _NATIVE_SCAN_IDS = new Set([
    'mvin-scan-input',
    'mvout-scan-input',
    'gv-scan-input',
    'inv-godown-scan-input',   // inventory module — Godown View scan field
  ]);
  // Expose so other modules can register their own native-scan inputs
  window._NATIVE_SCAN_IDS = _NATIVE_SCAN_IDS;

  document.addEventListener('keypress', function(e) {
    const now  = Date.now();
    const fast = (now - lastT) < 80;   // typical scanner inter-char delay
    if(now - lastT > 300) buf = '';
    lastT = now;

    const el   = document.activeElement;
    const inAllowed = el && _ALLOW_IDS.has(el.id);
    const inNative  = el && _NATIVE_SCAN_IDS.has(el.id);

    // When focus is on an input that handles scans natively, get out of
    // the way completely — don't accumulate, don't intercept. Otherwise
    // there's a risk the buf logic interferes with the native flow.
    if(inNative){ buf = ''; return; }

    if(e.key === 'Enter') {
      const raw = buf.trim();
      buf = '';
      // Only intercept text that looks like a box code
      if(!_looksLikeBoxCode(raw) && !_GROUP_CODE_RE.test(raw)) return;
      // Don't intercept if a regular form input is active (unless it's our paste box
      // or the Combined-tab search box — those WANT scans routed through qrHandleRaw)
      const skip = el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT') && !inAllowed;
      if(skip) return;
      e.preventDefault();
      // If chars leaked into #ct-search before we knew it was a scan, scrub them
      if(inAllowed && el.id === 'ct-search') {
        el.value = '';
      }
      qrHandleRaw(raw, 'handheld');
    } else {
      buf += e.key;
      // Inside an allowed input, suppress fast bursts so the scanned code
      // doesn't leak in and trigger the input's oninput handler.
      // Only swallow when the buffer is shaping up like a box code.
      if(inAllowed && fast && buf.length > 1 && /^[A-Z0-9\-]+$/i.test(buf)) {
        e.preventDefault();
      }
    }
  });
})();

/* ── Open ─────────────────────────────────────────────────────
   Opens the manual-entry modal (for when the scanner isn't
   available — operator types or pastes the code).
   The handheld scanner works WITHOUT this modal being open.
─────────────────────────────────────────────────────────────── */
function qrScanOpen(target) {
  _qrTarget = target || 'auto';
  const labels = {
    grn:        'Adding to New GRN',
    mtv:        'Adding to Transfer Voucher',
    egrn:       'Adding to Edit GRN',
    emtv:       'Adding to Edit MTV',
    'stock-ge': 'Fill Godown Entry',
    'stock-fe': 'Fill Factory Entry',
    combined:   'Find product in Combined Stock',
    'inv-godown': 'Open box history',
    auto:       'Auto-detect open form',
  };
  const hint = document.getElementById('qrs-target-hint');
  if(hint) hint.textContent = labels[_qrTarget] || '';
  const result = document.getElementById('qrs-result');
  if(result) result.style.display = 'none';
  const input = document.getElementById('qrs-paste-input');
  if(input) input.value = '';
  const status = document.getElementById('qrs-paste-status');
  if(status) status.textContent = 'Waiting for scan…';
  const modal = document.getElementById('qrScanModal');
  if(modal) modal.classList.add('open');
  // Auto-focus the input so handheld bursts and typing both work immediately
  setTimeout(() => {
    const inp = document.getElementById('qrs-paste-input');
    if(inp) inp.focus();
  }, 80);
}

function qrScanClose() {
  if(typeof closeModal === 'function') {
    closeModal('qrScanModal');
  } else {
    const m = document.getElementById('qrScanModal');
    if(m) m.classList.remove('open');
  }
}

/* ── Manual / paste input ─────────────────────────────────────
   Triggered by typing or by pasting from the OS clipboard.
─────────────────────────────────────────────────────────────── */
function qrPasteCheck(el) {
  const v = (el.value || '').trim();
  const st = document.getElementById('qrs-paste-status');
  if(!st) return;
  if(_BOX_CODE_RE.test(v))        { st.textContent='✅ Looks like a box code — press Enter or click Apply'; st.style.color='var(--teal,#0d9488)'; }
  else if(_SHORT_CODE_RE.test(v)) { st.textContent='✅ Looks like a short box code — press Enter or click Apply'; st.style.color='var(--teal,#0d9488)'; }
  else if(_GROUP_CODE_RE.test(v)) { st.textContent='🛍️ Looks like a bag/lot code — press Enter or click Apply'; st.style.color='#7c3aed'; }
  else if(v.length)               { st.textContent='⚠️ Not a box or bag code (e.g. BEARTUBE12-G0234-B003, A0006058, or BAG-PLIXTRAY-G0068-L001)'; st.style.color='#f59e0b'; }
  else                            { st.textContent='Waiting for scan…'; st.style.color='var(--muted,#9ca3af)'; }
}

function qrParsePaste() {
  const el = document.getElementById('qrs-paste-input');
  if(!el) return;
  const raw = (el.value || '').trim();
  if(raw) qrHandleRaw(raw, 'paste');
}

/* Enter key inside the paste textarea = Apply */
function qrPasteKey(e) {
  if(e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    qrParsePaste();
  }
}

/* ── Core handler ─────────────────────────────────────────── */
async function qrHandleRaw(raw, source) {
  const code = String(raw || '').trim().toUpperCase();

  // Verify-GRN modal short-circuit: if the operator has the verify modal
  // open and the scan is a plausible box-code shape, hand off directly to
  // the modal's own scan ingester. That handler does the short-code →
  // long-code resolution against the current GRN's expected boxes and
  // either flags ✓ scanned, ⚠ duplicate, or ✗ not part of this GRN —
  // all WITHOUT a server round-trip, so it's fast and works offline.
  //
  // Check before the global box-code regex so short_codes (which the old
  // _BOX_CODE_RE rejected) still reach the verify handler even on installs
  // where qrHandleRaw is the only path scans flow through.
  try {
    const verifyModal = document.getElementById('grnVerifyModal');
    if(verifyModal && verifyModal.classList.contains('open') &&
       typeof gvIngestCode === 'function' &&
       (_looksLikeBoxCode(code) || _GROUP_CODE_RE.test(code))){
      gvIngestCode(code);
      return;
    }
  } catch(_){}

  // Bag/group code: when scanned outside an MTV modal context, look it up
  // and display group info. Inside an MTV modal, the modal's own scan
  // handler intercepts BAG- codes via _scanCodeWithGroupSupport before
  // we ever reach this global handler.
  if(_GROUP_CODE_RE.test(code)){
    return qrHandleGroup(code);
  }

  if(!_looksLikeBoxCode(code)){
    if(typeof showToast === 'function') showToast('Not a valid box or bag code','error');
    const rc = document.getElementById('qrs-result-content');
    if(rc){
      rc.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 4px">
          <div style="font-size:24px">🚫</div>
          <div>
            <div style="font-size:12px;font-weight:800;color:#dc2626">Unrecognised code</div>
            <div style="font-size:10.5px;color:var(--htxtb,#111);margin-top:2px;line-height:1.4">
              Expected a box code like <code>BEARTUBE12-G0234-B003</code>,
              a short code like <code>A0006058</code>,
              or a bag code like <code>BAG-PLIXTRAY-G0068-L001</code>.
            </div>
          </div>
        </div>`;
      const r = document.getElementById('qrs-result');
      if(r) r.style.display = 'block';
    }
    return;
  }

  // ── Look up the box server-side ──────────────────────────
  let box = null;
  try {
    const r = await fetch('/api/pm_stock/boxes/by_code?code=' + encodeURIComponent(code));
    const d = await r.json();
    if(d.status === 'ok' && d.box) box = d.box;
  } catch(_){}

  if(!box){
    const rc = document.getElementById('qrs-result-content');
    if(rc){
      rc.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 4px">
          <div style="font-size:24px">❓</div>
          <div>
            <div style="font-size:12px;font-weight:800;color:#dc2626">Box not found</div>
            <div style="font-size:10.5px;color:var(--htxtb,#111);margin-top:2px;line-height:1.4">
              Code <code>${code}</code> isn't in the system. The label may be from a
              GRN that was deleted, or boxes for it haven't been generated yet.
            </div>
          </div>
        </div>`;
      const r = document.getElementById('qrs-result');
      if(r) r.style.display = 'block';
    }
    if(typeof showToast === 'function') showToast(`Box "${code}" not found`,'error');
    return;
  }

  // ── Dispatch to the right consumer ───────────────────────
  //
  // First chance: an inventory_mgmt-style "inv-godown" target opens the
  // box-history modal in the inventory page.
  if(_qrTarget === 'inv-godown'){
    qrScanClose();
    if(typeof window.invOpenBoxHistory === 'function'){
      window.invOpenBoxHistory(box.box_id, box);
    } else if(typeof showToast === 'function'){
      showToast('Inventory module not loaded','error');
    }
    return;
  }

  // Auto-detect: if the inventory Godown View is the active panel, route there.
  if(_qrTarget === 'auto' && typeof window.invIsGodownViewActive === 'function' && window.invIsGodownViewActive()){
    qrScanClose();
    if(typeof window.invOpenBoxHistory === 'function'){
      window.invOpenBoxHistory(box.box_id, box);
    }
    return;
  }

  // Original PM Stock dispatch (unchanged from camera version) — preserved
  // so the legacy GRN / MTV / Stock-Entry flows keep working.
  const perBox  = parseFloat(box.per_box_qty) || 0;
  const noOfBox = 1;          // one scan = one physical box
  const qty     = perBox * noOfBox;

  if(typeof _qrDispatchToTarget === 'function'){
    // Provided by pm_stock_movement.js / pm_stock_grn_mtv.js
    _qrDispatchToTarget(box, qty, source);
    return;
  }

  // Fallback: just show the result preview
  const rc = document.getElementById('qrs-result-content');
  if(rc){
    const _bid = box.box_id != null ? box.box_id : 'null';
    const _bcode = (box.box_code || '').replace(/'/g, '');
    rc.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 10px;font-size:11px">
        <span style="color:var(--muted,#9ca3af)">Box:</span>
        <span style="font-family:'Courier New',monospace;font-weight:700">${box.box_code}</span>
        <span style="color:var(--muted,#9ca3af)">Product:</span>
        <span style="font-weight:600">${box.product_name || ''}</span>
        <span style="color:var(--muted,#9ca3af)">Qty:</span>
        <span>${qty.toLocaleString('en-IN')} ${box.uom || ''}</span>
        <span style="color:var(--muted,#9ca3af)">Location:</span>
        <span>${box.current_godown_name || '(unassigned)'} <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(0,0,0,.06)">${box.current_status || ''}</span></span>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border,rgba(0,0,0,.12))">
        <div style="font-size:10px;color:var(--muted,#9ca3af);margin-bottom:6px">QR damaged or won't scan?</div>
        <button onclick="(window.reissueBoxLabel && window.reissueBoxLabel({box_id:${_bid},box_code:'${_bcode}'}))"
          style="width:100%;padding:8px 12px;border:1px solid #f59e0b;background:rgba(245,158,11,.08);
            color:#b45309;border-radius:7px;font-weight:700;font-size:12px;cursor:pointer">
          🏷️ Request replacement label (new QR · needs admin approval)
        </button>
      </div>`;
    const r = document.getElementById('qrs-result');
    if(r) r.style.display = 'block';
  }
  if(typeof showToast === 'function') showToast(`✓ ${box.product_name || box.box_code}`,'success');
}

/* ── Bag/group code handler ─────────────────────────────────── */
async function qrHandleGroup(code){
  let group = null;
  try {
    const r = await fetch('/api/pm_stock/groups/by_code?code=' + encodeURIComponent(code));
    const d = await r.json();
    if(d.status === 'ok' && d.group) group = d.group;
  } catch(_){}

  const rc = document.getElementById('qrs-result-content');
  if(!group){
    if(rc){
      rc.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 4px">
          <div style="font-size:24px">❓</div>
          <div>
            <div style="font-size:12px;font-weight:800;color:#dc2626">Bag not found</div>
            <div style="font-size:10.5px;color:var(--htxtb,#111);margin-top:2px;line-height:1.4">
              Code <code>${code}</code> doesn't match any bag/lot.
            </div>
          </div>
        </div>`;
      const r = document.getElementById('qrs-result');
      if(r) r.style.display = 'block';
    }
    if(typeof showToast === 'function') showToast(`Bag "${code}" not found`,'error');
    return;
  }

  if(rc){
    rc.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 10px;font-size:11px">
        <span style="color:var(--muted,#9ca3af)">Bag:</span>
        <span style="font-family:'Courier New',monospace;font-weight:700">${group.group_code}</span>
        <span style="color:var(--muted,#9ca3af)">Product:</span>
        <span style="font-weight:600">${group.product_name || ''}</span>
        <span style="color:var(--muted,#9ca3af)">Boxes:</span>
        <span>${group.box_count || 0} box${(group.box_count||0)===1?'':'es'}</span>
        <span style="color:var(--muted,#9ca3af)">Total qty:</span>
        <span>${(parseFloat(group.total_qty)||0).toLocaleString('en-IN')} ${group.uom || ''}</span>
      </div>`;
    const r = document.getElementById('qrs-result');
    if(r) r.style.display = 'block';
  }
  if(typeof showToast === 'function') showToast(`✓ Bag ${group.group_code}`,'success');
}

/* ────────────────────────────────────────────────────────────
   END.
   Camera-related code removed in this revision:
   - qrCamStart, qrCamStop, qrSwitchCam, qrScanTick
   - qrSwitchTab (no more tabs — single paste/manual pane)
   - BarcodeDetector usage, getUserMedia, _qrStream, _qrDetector,
     _qrScanLoop, _qrCamIdx, _qrCamList
   The corresponding markup in pm_stock.html must also be replaced
   — see pm_stock_qr_modal.html for the new modal.
──────────────────────────────────────────────────────────── */
