/* ════════════════════════════════════════════════════════════════════════
   inventory_transfers.js — QR Stock Transfer Voucher (RM phase 2)
   PM-Stock-parity, three-pill internal flow.
   ────────────────────────────────────────────────────────────────────────
   Workflow (unchanged at backend level):
       out_started → in_pending → received
                   ↘ cancelled (any stage)

   LAYOUT (three internal pill tabs at the top of the panel):
     📤 Material OUT  → Create-OUT card + Pending-OUT scanning list
     📥 Material IN   → In-Transit dashboard cards (click to receive)
     🗂 History       → Received + Cancelled vouchers, searchable

   Each tab refreshes its own slice of data when the panel is opened or
   when the user switches tabs. The IN tab's count badge is updated on
   every refresh so operators see at-a-glance how many vouchers await
   receipt.

   The wide modal overlay is unchanged from before — opens with the
   appropriate mode (amber for OUT scanning, blue for IN scanning,
   green for received, red for cancelled).

   "Simple Voucher (manual)" has been removed from this module — it now
   lives as its own sidebar panel, driven by inventory_simple_transfer.js,
   which self-registers a new nav item on load.

   API (unchanged):
     POST  /api/inventory_godown/transfers/start
     POST  /api/inventory_godown/transfers/<tid>/scan_out
     POST  /api/inventory_godown/transfers/<tid>/unscan_out
     POST  /api/inventory_godown/transfers/<tid>/submit_out
     POST  /api/inventory_godown/transfers/<tid>/scan_in
     POST  /api/inventory_godown/transfers/<tid>/unscan_in
     POST  /api/inventory_godown/transfers/<tid>/confirm_receipt
     POST  /api/inventory_godown/transfers/<tid>/cancel
     GET   /api/inventory_godown/transfers/list
     GET   /api/inventory_godown/transfers/in_transit
     GET   /api/inventory_godown/transfers/get?transfer_id=
═════════════════════════════════════════════════════════════════════════ */

(function(){
  'use strict';
  const $ = id => document.getElementById(id);

  // ─── State ──────────────────────────────────────────────────────────
  let _trList = [];           // full /list result
  let _trGodowns = [];        // cached godown master (non-floor)
  let _trActiveTab = 'out';   // 'out' | 'in' | 'history'

  // Modal state (one open voucher at a time)
  let _trEditId   = null;
  let _trStatus   = null;
  let _trPackages = [];
  let _trVoucherMeta = {};

  // ─── Helpers ────────────────────────────────────────────────────────
  function _esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function _fmtQty(q, uom){
    const n = Number(q || 0).toLocaleString('en-IN', {
      minimumFractionDigits:3, maximumFractionDigits:3
    });
    return uom ? (n + ' ' + uom) : n;
  }
  function _fmtNum(n){ return Number(n || 0).toLocaleString('en-IN'); }
  function _fmtDateShort(s){
    if (!s) return '—';
    const m = String(s).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s).slice(0,10);
  }
  function _toast(msg, kind){
    let el = document.querySelector('.tr-toast');
    if (!el){
      el = document.createElement('div');
      el.className = 'tr-toast';
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;'
        + 'transform:translateX(-50%);padding:10px 18px;border-radius:8px;'
        + 'color:var(--nb-surface);font-size:13px;font-weight:700;z-index:1100;'
        + 'box-shadow:0 4px 18px rgba(0,0,0,.18);';
      document.body.appendChild(el);
    }
    el.style.background = (kind === 'error') ? 'var(--nb-danger)'
                        : (kind === 'warn')  ? 'var(--nb-amber)'
                        : 'var(--nb-success)';
    el.textContent = msg;
    el.style.display = '';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 3200);
  }

  async function _trLoadGodowns(){
    if (_trGodowns.length) return _trGodowns;
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      if (j.status === 'ok'){
        _trGodowns = (j.godowns || []).filter(g => (g.type || '') !== 'floor');
      }
    } catch(e){}
    return _trGodowns;
  }

  function _trFillGodownDropdown(selectEl, excludeId){
    if (!selectEl) return;
    const cur = selectEl.value;
    selectEl.innerHTML = '<option value="">— select —</option>' +
      _trGodowns
        .filter(g => String(g.id) !== String(excludeId))
        .map(g => `<option value="${g.id}">${_esc(g.name)}</option>`)
        .join('');
    if (cur) selectEl.value = cur;
  }

  function _trFillCreateCardGodowns(){
    _trFillGodownDropdown($('tr-create-from'), $('tr-create-to')?.value);
    _trFillGodownDropdown($('tr-create-to'),   $('tr-create-from')?.value);
  }

  function _trFillModalGodowns(){
    _trFillGodownDropdown($('trmFromGodown'), $('trmToGodown')?.value);
    _trFillGodownDropdown($('trmToGodown'),   $('trmFromGodown')?.value);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PANEL ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════
  window.invTrInit = async function(){
    await _trLoadGodowns();
    _trFillCreateCardGodowns();
    // Bind create-card dropdowns to mutually-exclude each other
    const fromSel = $('tr-create-from');
    const toSel   = $('tr-create-to');
    if (fromSel && !fromSel._wired){
      fromSel.addEventListener('change', _trFillCreateCardGodowns);
      fromSel._wired = true;
    }
    if (toSel && !toSel._wired){
      toSel.addEventListener('change', _trFillCreateCardGodowns);
      toSel._wired = true;
    }
    await window.invTrLoadList();
    // Defensive close in case modal was left open
    invTrCloseModal();
  };

  // ═══════════════════════════════════════════════════════════════════
  // PILL TAB SWITCHER (Material OUT / Material IN / History)
  // ═══════════════════════════════════════════════════════════════════
  window.invTrSwitchPillTab = function(name){
    name = ['out','in','history','request'].includes(name) ? name : 'out';
    _trActiveTab = name;
    document.querySelectorAll('#tr-pills .tr-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    ['out','in','history','request'].forEach(t => {
      const pane = $('tr-pane-' + t);
      if (pane) pane.classList.toggle('active', t === name);
    });
    // Each tab can refresh itself on demand if needed
    if (name === 'in')      _trRenderInTransitCards();
    if (name === 'history') invTrRenderHistory();
    if (name === 'out')     _trRenderOutPending();
    if (name === 'request' && typeof window.invMRRenderIntoTab === 'function') {
      window.invMRRenderIntoTab();
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // LIST LOADER — fetches once, dispatches to all three tabs
  // ═══════════════════════════════════════════════════════════════════
  window.invTrLoadList = async function(){
    try {
      const r = await fetch('/api/inventory_godown/transfers/list');
      const j = await r.json();
      _trList = (j.status === 'ok') ? (j.transfers || []) : [];
    } catch(e){
      _trList = [];
    }
    _trUpdatePillBadges();
    _trRenderOutPending();
    _trRenderInTransitCards();
    invTrRenderHistory();
  };

  function _trUpdatePillBadges(){
    const inCount = _trList.filter(t => t.status === 'in_pending').length;
    const badge = $('tr-pill-in-count');
    if (badge){
      badge.textContent = inCount;
      badge.style.display = inCount > 0 ? '' : 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MATERIAL OUT PANE — create card + pending-OUT list
  // ═══════════════════════════════════════════════════════════════════
  window.invTrCreateOutClick = async function(){
    const fromId = parseInt($('tr-create-from').value) || 0;
    const toId   = parseInt($('tr-create-to').value)   || 0;
    const remarks = ($('tr-create-remarks').value || '').trim();
    if (!fromId || !toId){
      _toast('Pick both From and To godowns', 'warn'); return;
    }
    if (fromId === toId){
      _toast('From and To must be different', 'warn'); return;
    }
    // Open a fresh modal in NEW mode — voucher gets created on first scan
    // via invTrScanKey → /start. This mirrors the original flow exactly,
    // BUT we pre-populate the modal's header from the create card so the
    // operator just starts scanning.
    await _trLoadGodowns();
    _trEditId   = null;
    _trStatus   = 'out_started';
    _trPackages = [];
    _trVoucherMeta = {};
    _trFillModalGodowns();
    $('trmDate').value = new Date().toISOString().slice(0,10);
    $('trmFromGodown').value = String(fromId);
    $('trmToGodown').value   = String(toId);
    $('trmRemarks').value    = remarks;
    $('trmScanInput').value  = '';
    $('trmVno').textContent  = 'AUTO ON FIRST SCAN';
    const fromName = _trGodowns.find(g => String(g.id) === String(fromId))?.name || '—';
    const toName   = _trGodowns.find(g => String(g.id) === String(toId))?.name   || '—';
    $('trmFromName').textContent = fromName;
    $('trmToName').textContent   = toName;
    _trApplyStageUI('out_started', false);
    _trRenderPackages();
    _trUpdateTotals();
    _trFeedback('✓ Ready — scan the first package to lock the voucher', 'ok');
    _trOpenOverlay();
    // Clear the create-card inputs so the next create starts fresh
    $('tr-create-from').value = '';
    $('tr-create-to').value   = '';
    $('tr-create-remarks').value = '';
    _trFillCreateCardGodowns();
    setTimeout(() => $('trmScanInput').focus(), 100);
  };

  function _trRenderOutPending(){
    const body = $('tr-out-pending-body');
    const meta = $('tr-out-pending-meta');
    if (!body) return;
    const rows = _trList.filter(t => t.status === 'out_started');
    if (meta) meta.textContent = rows.length
      ? `${rows.length} draft${rows.length === 1 ? '' : 's'}`
      : '';
    if (!rows.length){
      body.innerHTML = `<tr><td colspan="8" class="no-data">
        <i class="fas fa-check-circle"></i> No drafts — all clear
      </td></tr>`;
      return;
    }
    body.innerHTML = rows.map((t, i) => `
      <tr ondblclick="invTrOpenExisting(${t.transfer_id})">
        <td class="muted-cell">${i+1}</td>
        <td><strong style="font-family:JetBrains Mono,monospace">${_esc(t.transfer_no)}</strong></td>
        <td>${_fmtDateShort(t.transfer_date)}</td>
        <td>${_esc(t.from_godown_name || '—')}</td>
        <td>${_esc(t.to_godown_name || '—')}</td>
        <td style="text-align:right">${_fmtNum(t.total_boxes)}</td>
        <td style="text-align:right">${_fmtQty(t.total_qty)}</td>
        <td class="td-center">
          <button onclick="invTrOpenExisting(${t.transfer_id})"
                  style="background:none;border:none;color:var(--nb-indigo);
                         font-size:12px;font-weight:700;cursor:pointer">
            Continue →
          </button>
        </td>
      </tr>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // When every expected package on a voucher has been scanned IN, finalize
  // the receipt automatically (status in_pending → received) so the operator
  // doesn't have to open the voucher and press Confirm. Returns a short status
  // the caller can fold into its on-screen prompt:
  //   'received'  — auto-confirmed, voucher closed
  //   'awaiting'  — fully scanned but this user created the OUT, so a
  //                 different user must confirm (separation of duties)
  //   'partial'   — not all packages scanned yet, nothing to do
  //   'error'     — confirm attempt failed for another reason
  async function _trMaybeAutoConfirm(tid, sc){
    const expected   = Number(sc?.expected   || 0);
    const scannedIn  = Number(sc?.scanned_in || 0);
    if (!expected || scannedIn < expected) return { state:'partial' };
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${tid}/confirm_receipt`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status === 'ok') return { state:'received', received: j.total_received };
      // 403 = separation of duties (OUT creator can't confirm own receipt).
      if (r.status === 403)  return { state:'awaiting', message: j.message };
      return { state:'error', message: j.message };
    } catch(e){
      return { state:'error', message: e.message || String(e) };
    }
  }

  // AUTO-ROUTE: scan any in-transit box → receive it straight into its
  // voucher's Material-IN, WITHOUT opening the voucher screen. The operator
  // just keeps scanning; each scan flashes a brief "added" confirmation for
  // ~2s and the in-transit card counts refresh in the background.
  // ═══════════════════════════════════════════════════════════════════
  let _trAutoMsgTimer = null;
  function _trAutoMsg(text, ok){
    const msg = $('tr-autoroute-msg');
    if (!msg) return;
    msg.style.color = ok ? '#0f766e' : '#b91c1c';
    msg.textContent = text;
    if (_trAutoMsgTimer){ clearTimeout(_trAutoMsgTimer); _trAutoMsgTimer = null; }
    // Auto-clear success prompts after ~2s; keep errors until the next scan.
    if (ok){ _trAutoMsgTimer = setTimeout(()=>{ if(msg) msg.textContent=''; }, 2000); }
  }
  window.invTrAutoRoute = async function(){
    const inp = $('tr-autoroute-input');
    const code = (inp?.value || '').trim().toUpperCase();
    if (!code) return;
    _trAutoMsg('Looking up ' + code + '…', true);
    try {
      // 1) Resolve the scanned package to its in-transit voucher.
      const r = await fetch('/api/inventory_godown/transfers/find_by_box?code='
                            + encodeURIComponent(code));
      const j = await r.json();
      if (j.status !== 'ok'){
        // not_found / not_in_transit / invalid → show the reason, keep input.
        _trAutoMsg('✕ ' + (j.message || 'Could not route ' + code), false);
        if (inp){ inp.focus(); inp.select(); }
        return;
      }
      // 2) Receive it straight into that voucher. scan_in matches on the
      //    canonical box_code, so use the code find_by_box resolved (the
      //    scanned value may have been a QR short_code).
      const scanCode = j.box_code || code;
      const sr = await fetch(`/api/inventory_godown/transfers/${j.transfer_id}/scan_in`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_code: scanCode })
      });
      const sj = await sr.json();
      if (inp){ inp.value = ''; inp.focus(); }
      const vno = j.in_voucher_no || j.transfer_no;
      if (sj.status === 'ok'){
        const sc = sj.scan_counts || {};
        // If this scan completed the voucher (in == out), finalize the receipt
        // automatically so the entry is auto-submitted — no need to open it.
        const auto = await _trMaybeAutoConfirm(j.transfer_id, sc);
        if (auto.state === 'received'){
          _trAutoMsg(`✓ ${scanCode} added — ${vno} fully received (${sc.scanned_in}/${sc.expected})`, true);
        } else if (auto.state === 'awaiting'){
          // Fully scanned, but this user issued the OUT, so a different user
          // must confirm. Don't block scanning; just say so.
          _trAutoMsg(`✓ ${scanCode} added — ${vno} complete (${sc.scanned_in}/${sc.expected}); another user must confirm receipt`, true);
        } else if (auto.state === 'error'){
          _trAutoMsg(`✓ ${scanCode} added (${sc.scanned_in}/${sc.expected}) — auto-confirm failed: ${auto.message||'unknown'}`, false);
        } else {
          _trAutoMsg(`✓ ${scanCode} added to ${vno} (${sc.scanned_in}/${sc.expected})`, true);
        }
        // Refresh the in-transit cards so counts stay live. invTrLoadList
        // re-fetches and re-renders all tabs (and drops vouchers that just
        // completed). It does not steal focus, so scanning continues smoothly.
        if (typeof window.invTrLoadList === 'function') window.invTrLoadList();
      } else if (sj.status === 'blocked'){
        // Already scanned in, or not on this voucher — surface the reason.
        _trAutoMsg('⚠ ' + (sj.message || 'Could not add ' + scanCode), false);
      } else {
        _trAutoMsg('✕ ' + (sj.message || 'Could not add ' + scanCode), false);
      }
    } catch(e){
      _trAutoMsg('✕ ' + (e.message || 'Lookup failed'), false);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // MATERIAL IN PANE — In-Transit dashboard cards
  // ═══════════════════════════════════════════════════════════════════
  function _trRenderInTransitCards(){
    const grid = $('tr-it-grid');
    const meta = $('tr-it-meta');
    if (!grid) return;
    const rows = _trList.filter(t => t.status === 'in_pending');
    if (meta) meta.textContent = rows.length
      ? `${rows.length} voucher${rows.length === 1 ? '' : 's'}`
      : '';
    if (!rows.length){
      grid.innerHTML = `
        <div class="no-data" style="grid-column:1 / -1;text-align:center;
                                    color:var(--nb-text-subtle);font-style:italic;
                                    padding:40px 12px">
          <i class="fas fa-truck"></i> Nothing in transit — all packages received
        </div>`;
      return;
    }
    grid.innerHTML = rows.map(t => `
      <div class="tr-it-card" onclick="invTrOpenExisting(${t.transfer_id})">
        <div class="icon">📦</div>
        <div class="info">
          <div class="num">${_esc(t.in_voucher_no || t.transfer_no)}</div>
          <div class="route">${_esc(t.from_godown_name || '—')} → ${_esc(t.to_godown_name || '—')}</div>
          <div class="meta">${_fmtDateShort(t.transfer_date)}${t.out_by ? ' · by ' + _esc(t.out_by) : ''}</div>
        </div>
        <div class="boxes">
          <div class="lbl">Boxes</div>
          <div class="val">${_fmtNum(t.total_boxes)}</div>
        </div>
      </div>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // HISTORY PANE — received + cancelled, searchable
  // ═══════════════════════════════════════════════════════════════════
  window.invTrRenderHistory = function(){
    const body = $('tr-hist-body');
    const meta = $('tr-hist-meta');
    if (!body) return;
    const filt   = ($('tr-hist-status-filter')?.value || '').trim();
    const search = ($('tr-hist-search')?.value || '').toLowerCase().trim();
    let rows = _trList.filter(t => t.status === 'received' || t.status === 'cancelled');
    if (filt) rows = rows.filter(t => t.status === filt);
    if (search){
      rows = rows.filter(t => {
        const bag = [t.transfer_no, t.in_voucher_no,
                     t.from_godown_name, t.to_godown_name, t.remarks]
          .filter(Boolean).join(' ').toLowerCase();
        return bag.includes(search);
      });
    }
    if (meta) meta.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
    if (!rows.length){
      body.innerHTML = `<tr><td colspan="9" class="no-data">
        <i class="fas fa-archive"></i> No history ${search?'matches':'yet'}
      </td></tr>`;
      return;
    }
    body.innerHTML = rows.map((t, i) => {
      const statusCls = 'tr-status-' + t.status;
      const statusLabel = t.status.toUpperCase();
      // Received → ended as the IN voucher. Cancelled → whichever number
      // was active (IN if it had been issued before cancellation, else
      // OUT). Always fall back to transfer_no for legacy single-number
      // rows from before the two-voucher scheme.
      const shownVno = (t.status === 'received')
        ? (t.in_voucher_no || t.transfer_no)
        : (t.in_voucher_no || t.transfer_no);
      // Side for the print icon: received → IN-side print; cancelled
      // → OUT-side (the only thing actually printable historically).
      const printSide = (t.status === 'received') ? 'in' : 'out';
      return `<tr ondblclick="invTrOpenExisting(${t.transfer_id})">
        <td class="muted-cell">${i+1}</td>
        <td><strong style="font-family:JetBrains Mono,monospace">${_esc(shownVno)}</strong></td>
        <td>${_fmtDateShort(t.transfer_date)}</td>
        <td>${_esc(t.from_godown_name || '—')}</td>
        <td>${_esc(t.to_godown_name || '—')}</td>
        <td style="text-align:right">${_fmtNum(t.total_boxes)}</td>
        <td style="text-align:right">${_fmtQty(t.total_qty)}</td>
        <td><span class="tr-status-badge ${statusCls}">${statusLabel}</span></td>
        <td class="td-center">
          <button class="icon-btn-sm" onclick="invTrOpenExisting(${t.transfer_id})" title="View">
            <i class="fas fa-eye"></i>
          </button>
          <button class="icon-btn-sm" onclick="invTrPrint(${t.transfer_id}, '${printSide}')" title="Print voucher"
                  style="margin-left:4px">
            <i class="fas fa-print"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  };

  // ═══════════════════════════════════════════════════════════════════
  // PRINT — Material Transfer voucher (OUT or IN side)
  // ───────────────────────────────────────────────────────────────────
  // Fetches /print_data for this transfer, builds a print-friendly HTML
  // document, opens it in a new window, and triggers window.print().
  // The window stays open after print so the user can re-print without
  // re-rendering. Closes on the user's choice (Cancel from print dialog
  // returns control; they can close the tab when done).
  //
  // FEFO traceability: every box row shows its batch + expiry so the
  // printed voucher is a complete chain-of-custody record. Per-material
  // summary at the top totals boxes + qty for at-a-glance reconciliation.
  // ═══════════════════════════════════════════════════════════════════
  window.invTrPrint = async function(transferId, side){
    if (!transferId){
      _toast('No transfer to print', 'error'); return;
    }
    side = (side || 'out').toLowerCase();
    if (side !== 'in') side = 'out';
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${transferId}/print_data?side=${side}`);
      const d = await r.json();
      if (d.status !== 'ok'){
        _toast(d.message || 'Could not load print data', 'error', 4500);
        return;
      }
      // Refuse to print empty drafts — voucher exists but no boxes were
      // ever attached. Common case: an OUT was started, /start created the
      // header row, but the scan failed before any box landed in
      // rm_stock_transfer_boxes. Printing zero rows isn't useful and
      // confuses the operator. Suggest cancel-or-scan instead.
      const _boxCount = (d.boxes || []).length;
      if (_boxCount === 0){
        _toast(
          'This voucher has no packages yet — nothing to print. '
        + 'Scan boxes first, or click "Cancel transfer" to discard the draft.',
          'warn', 6000
        );
        return;
      }
      const html = _trBuildPrintHtml(d);
      // Pop the print window. Some browsers block popups on async callers
      // (after the initial click). The user clicked Print right before
      // this; most browsers tolerate one async hop. If it gets blocked,
      // we fall back to opening the HTML in-place (same tab) — they can
      // print with Ctrl+P.
      const w = window.open('', '_blank', 'width=900,height=1100');
      if (!w){
        _toast('Pop-up blocked — allow pop-ups for this site to print.', 'error', 6000);
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
      // window.print() needs the document to finish layout; a microtask
      // is usually enough but we give it a beat on slower machines.
      w.focus();
      setTimeout(() => { try { w.print(); } catch(_){} }, 200);
    } catch(e){
      _toast('Error: ' + (e.message || e), 'error', 4500);
    }
  };

  // Build the print-friendly HTML document for one transfer voucher.
  // Self-contained (no external CSS / fonts) so it opens identically in
  // the popup. Layout: header block (voucher #, dates, godowns) → per-
  // material summary table → full per-box detail table.
  function _trBuildPrintHtml(d){
    const h = d.header || {};
    const items = d.items || [];
    const boxes = d.boxes || [];
    const side = (d.side === 'in') ? 'in' : 'out';
    const sideLabel = (side === 'in') ? 'MATERIAL IN' : 'MATERIAL OUT';
    // Per spec: the OUT print shows the OUT voucher number, the IN print
    // shows the IN voucher number. Each side also shows the counterpart
    // for chain-of-custody traceability (so an operator holding the IN
    // print can reconcile against the OUT print and vice versa).
    const primaryVno     = (side === 'in')
      ? (h.in_voucher_no || h.transfer_no || '')
      : (h.transfer_no   || '');
    const counterpartVno = (side === 'in')
      ? (h.transfer_no || '')
      : (h.in_voucher_no || '');
    const counterpartLbl = (side === 'in') ? 'OUT voucher' : 'IN voucher';

    const esc = s => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const fmtN = n => (Number(n) || 0).toLocaleString('en-IN',
      { maximumFractionDigits: 3 });

    const itemRows = items.map((it, i) => `
      <tr>
        <td style="text-align:center">${i+1}</td>
        <td>${esc(it.material_name)}</td>
        <td style="text-align:right">${fmtN(it.boxes)}</td>
        <td style="text-align:right">${fmtN(it.total_qty)}</td>
        <td>${esc(it.uom || '')}</td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="text-align:center;padding:14px;color:#9ca3af;font-style:italic">No materials on this voucher</td></tr>`;
    const totBoxes = items.reduce((s,r) => s + Number(r.boxes||0), 0);
    const totQty   = items.reduce((s,r) => s + Number(r.total_qty||0), 0);

    const boxRows = boxes.map((b, i) => `
      <tr>
        <td style="text-align:center">${i+1}</td>
        <td style="font-family:monospace;font-size:11px"><strong>${esc(b.box_code)}</strong></td>
        <td>${esc(b.material_name || '')}</td>
        <td>${esc(b.batch_num || '—')}</td>
        <td>${esc(b.expiry_date_fmt || '—')}</td>
        <td style="text-align:right">${fmtN(b.per_box_qty)} ${esc(b.uom || '')}</td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="text-align:center;padding:14px;color:#9ca3af;font-style:italic">No boxes scanned</td></tr>`;

    // Status pill colour. We render it in print as a plain bordered chip
    // so b/w printers still show it clearly without colour dependency.
    const statusText = String(h.status || '').toUpperCase().replace(/_/g, ' ');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${sideLabel} Voucher ${esc(primaryVno || '')}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 12px; line-height: 1.4; color: #111;
    margin: 0; padding: 0;
  }
  .doc-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 12px;
  }
  .doc-title { font-size: 16px; font-weight: 800; letter-spacing: .3px; }
  .doc-subtitle { font-size: 11px; color: #4b5563; margin-top: 2px; }
  .vno {
    font-family: monospace; font-size: 16px; font-weight: 800;
    padding: 4px 10px; border: 1.5px solid #111; border-radius: 4px;
  }
  .status-chip {
    display: inline-block; padding: 2px 8px; border: 1px solid #111;
    border-radius: 3px; font-size: 10px; font-weight: 700; margin-left: 8px;
    text-transform: uppercase; letter-spacing: .4px;
  }
  .grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    margin-bottom: 14px;
  }
  .field { font-size: 11px; }
  .field .lbl { color: #6b7280; text-transform: uppercase; letter-spacing: .4px; font-size: 9.5px; font-weight: 700; }
  .field .val { font-size: 12.5px; font-weight: 600; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 11px; }
  th {
    background: #f3f4f6; font-weight: 700; text-align: left;
    text-transform: uppercase; letter-spacing: .3px; font-size: 10px;
  }
  tfoot td { font-weight: 700; background: #f9fafb; }
  .section-title {
    font-size: 11px; font-weight: 800; text-transform: uppercase;
    letter-spacing: .5px; color: #374151;
    margin: 16px 0 6px 0;
    border-left: 3px solid #111; padding-left: 8px;
  }
  .footer-sign {
    margin-top: 32px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 32px;
  }
  .footer-sign .col { border-top: 1px solid #111; padding-top: 4px; font-size: 10px; text-align: center; color: #4b5563; }
  .remarks-block {
    background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px;
    padding: 8px 10px; font-size: 11px; margin-bottom: 12px;
  }
  .remarks-block .lbl {
    font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
    font-size: 9.5px; color: #6b7280; margin-bottom: 2px;
  }
  .print-btn {
    position: fixed; top: 10px; right: 10px;
    padding: 8px 14px; font-size: 12px; font-weight: 700;
    background: #4648D4; color: #fff; border: none; border-radius: 6px;
    cursor: pointer;
  }
  @media print {
    .print-btn { display: none; }
  }
</style>
</head>
<body>

<button class="print-btn" onclick="window.print()">🖨 Print</button>

<div class="doc-head">
  <div>
    <div class="doc-title">${sideLabel} — STOCK TRANSFER</div>
    <div class="doc-subtitle">HCP Wellness Pvt Ltd · Inventory</div>
  </div>
  <div style="text-align:right">
    <div class="vno">${esc(primaryVno || '—')}</div>
    <div style="margin-top:6px">
      <span class="status-chip">${esc(statusText || '—')}</span>
    </div>
  </div>
</div>

<div class="grid">
  <div class="field"><div class="lbl">Date</div><div class="val">${esc(h.transfer_date_fmt || '—')}</div></div>
  <div class="field"><div class="lbl">Linked ${esc(counterpartLbl)}</div><div class="val" style="font-family:monospace">${esc(counterpartVno || '—')}</div></div>
  <div class="field"><div class="lbl">From Godown</div><div class="val">${esc(h.from_godown_name || '—')}</div></div>
  <div class="field"><div class="lbl">To Godown</div><div class="val">${esc(h.to_godown_name || '—')}</div></div>
  <div class="field"><div class="lbl">OUT By / At</div><div class="val">${esc(h.out_by || '—')} · ${esc(h.out_at_fmt || '—')}</div></div>
  <div class="field"><div class="lbl">IN By / At</div><div class="val">${esc(h.in_by || '—')} · ${esc(h.in_at_fmt || '—')}</div></div>
  <div class="field" style="grid-column:1 / -1"><div class="lbl">Linked Material Request</div><div class="val">${esc(h.request_no || '—')}</div></div>
</div>

${h.remarks ? `<div class="remarks-block"><div class="lbl">Remarks</div>${esc(h.remarks)}</div>` : ''}

<div class="section-title">Material Summary</div>
<table>
  <thead>
    <tr>
      <th style="width:36px">#</th>
      <th>Material</th>
      <th style="width:80px;text-align:right">Boxes</th>
      <th style="width:110px;text-align:right">Total Qty</th>
      <th style="width:60px">UOM</th>
    </tr>
  </thead>
  <tbody>${itemRows}</tbody>
  <tfoot>
    <tr>
      <td colspan="2" style="text-align:right">TOTAL</td>
      <td style="text-align:right">${fmtN(totBoxes)}</td>
      <td style="text-align:right">${fmtN(totQty)}</td>
      <td></td>
    </tr>
  </tfoot>
</table>

<div class="section-title">Box-Level Detail (FEFO Traceability)</div>
<table>
  <thead>
    <tr>
      <th style="width:36px">#</th>
      <th style="width:130px">Box Code</th>
      <th>Material</th>
      <th style="width:120px">Batch</th>
      <th style="width:100px">Expiry</th>
      <th style="width:130px;text-align:right">Qty</th>
    </tr>
  </thead>
  <tbody>${boxRows}</tbody>
</table>

<div class="footer-sign">
  <div class="col">Issued By<br>${esc(h.out_by || '—')}</div>
  <div class="col">Received By<br>${esc(h.in_by || '—')}</div>
  <div class="col">Authorised By<br>&nbsp;</div>
</div>

</body>
</html>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MODAL — OPEN EXISTING (from any tab)
  // ═══════════════════════════════════════════════════════════════════
  window.invTrOpenExisting = async function(transferId){
    await _trLoadGodowns();
    try {
      const r = await fetch('/api/inventory_godown/transfers/get?transfer_id=' + transferId);
      const j = await r.json();
      if (j.status !== 'ok'){
        _toast(j.message || 'Transfer not found', 'error'); return;
      }
      const t = j.transfer;
      _trEditId   = transferId;
      _trStatus   = t.status;
      _trPackages = (t.packages || []);
      _trVoucherMeta = t;
      _trFillModalGodowns();
      $('trmDate').value = (t.transfer_date || '').slice(0,10);
      $('trmFromGodown').value = t.from_godown_id || '';
      $('trmToGodown').value   = t.to_godown_id   || '';
      $('trmRemarks').value    = t.remarks || '';
      $('trmScanInput').value  = '';
      // trmVno is set by _trApplyStageUI based on status (OUT vno for the
      // OUT side, IN vno for the IN/received side). Do NOT pre-set it
      // here — that would flash the OUT number briefly for an IN voucher.
      $('trmFromName').textContent = t.from_godown_name || '—';
      $('trmToName').textContent   = t.to_godown_name   || '—';
      const readOnly = (t.status === 'received' || t.status === 'cancelled');
      _trApplyStageUI(t.status, readOnly);
      _trRenderPackages();
      _trUpdateTotals();
      _trOpenOverlay();
      if (!readOnly) setTimeout(() => $('trmScanInput').focus(), 60);
    } catch(e){
      _toast(e.message || String(e), 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // STAGE-AWARE UI APPLIER
  // ═══════════════════════════════════════════════════════════════════
  function _trApplyStageUI(status, readOnly){
    const modal = $('trmModal');
    if (!modal) return;
    modal.classList.remove('mode-in','mode-done','mode-cancelled');
    if (status === 'in_pending')     modal.classList.add('mode-in');
    else if (status === 'received')  modal.classList.add('mode-done');
    else if (status === 'cancelled') modal.classList.add('mode-cancelled');

    const titleEl = $('trmHeadTitle');
    const badgeEl = $('trmStatusBadge');
    let titleTxt, badgeTxt;
    if (status === 'out_started'){
      titleTxt = '📤 Material OUT voucher';
      badgeTxt = 'OUT STARTED';
    } else if (status === 'in_pending'){
      titleTxt = '📥 Material IN voucher';
      badgeTxt = 'IN TRANSIT';
    } else if (status === 'received'){
      titleTxt = '✅ Completed transfer';
      badgeTxt = 'RECEIVED';
    } else if (status === 'cancelled'){
      titleTxt = '✖ Cancelled transfer';
      badgeTxt = 'CANCELLED';
    } else {
      titleTxt = 'Stock transfer';
      badgeTxt = String(status || '').toUpperCase();
    }
    if (titleEl) titleEl.textContent = titleTxt;
    if (badgeEl){
      badgeEl.innerHTML = `<span class="tr-status-badge tr-status-${status}">${badgeTxt}</span>`;
    }

    // Pick which voucher number to show in the header. The transfer row
    // carries two numbers:
    //   • transfer_no   → Material OUT voucher  (e.g. OUT/RM/0001/26-27)
    //   • in_voucher_no → Material IN voucher   (e.g. IN/RM/0001/26-27),
    //                     allocated when status flips out_started→in_pending
    // The modal's title and number switch together: OUT side shows OUT vno,
    // IN side shows IN vno, completed transfers end as the IN voucher (per
    // spec: "when received at the material in location, it ends as material
    // in voucher"). Cancelled keeps whichever side reached it (IN if it had
    // been issued, else OUT).
    const vnoEl = $('trmVno');
    if (vnoEl){
      const m = _trVoucherMeta || {};
      const outVno = m.transfer_no || '';
      const inVno  = m.in_voucher_no || '';
      let shownVno = outVno;
      if (status === 'in_pending' || status === 'received'){
        shownVno = inVno || outVno || '—';
      } else if (status === 'cancelled'){
        shownVno = inVno || outVno || '—';
      } else {
        shownVno = outVno || '—';
      }
      vnoEl.textContent = shownVno || '—';
    }

    const bn = $('trmBanner');
    if (bn){
      if (status === 'out_started'){
        bn.innerHTML = _trEditId
          ? `OUT in progress — keep scanning packages, then click <strong>Submit OUT</strong> when done.`
          : `Scan the first package to assign a voucher number. The From/To and Date are locked.`;
      } else if (status === 'in_pending'){
        const total = _trPackages.length;
        const scanned = _trPackages.filter(p => p.scanned_in).length;
        bn.innerHTML = `Receive each package at the destination — <strong>${scanned}/${total}</strong> scanned IN. Click <strong>Confirm Receipt</strong> after all packages are scanned.`;
      } else if (status === 'received'){
        bn.innerHTML = `<strong>Completed.</strong> All ${_trPackages.length} package(s) received at destination.`;
      } else if (status === 'cancelled'){
        bn.innerHTML = `<strong>Cancelled.</strong> Stock movement reversed.`;
      }
    }

    const strip = $('trmScanStrip');
    if (strip) strip.style.display = readOnly ? 'none' : '';
    const scanLbl = $('trmScanLabel');
    const scanHelp = $('trmScanHelp');
    const scanInp = $('trmScanInput');
    if (status === 'out_started'){
      if (scanLbl)  scanLbl.textContent  = 'Scan package OUT (or paste code + Enter)';
      if (scanHelp) scanHelp.textContent = 'Each scan attaches the package to this transfer and flips it to "in transit".';
      if (scanInp)  scanInp.placeholder  = 'e.g. RM-A0000001';
    } else if (status === 'in_pending'){
      if (scanLbl)  scanLbl.textContent  = 'Scan package IN at destination';
      if (scanHelp) scanHelp.textContent = 'Each scan confirms the package has arrived. Progress is tracked above.';
      if (scanInp)  scanInp.placeholder  = 'Scan QR or paste code…';
    }
    if (scanInp) scanInp.disabled = readOnly;

    // Once a voucher exists, header is locked (always — From/To/Date are
    // pre-bound from the Create-OUT card before the modal opens).
    const formLocked = !!_trEditId || (status === 'out_started');
    ['trmDate','trmFromGodown','trmToGodown'].forEach(id => {
      const el = $(id);
      if (el) el.disabled = formLocked || readOnly;
    });
    $('trmRemarks').disabled = (status === 'received' || status === 'cancelled');

    const lbl = $('trmPackagesHeadLabel');
    if (lbl){
      lbl.textContent =
          status === 'out_started' ? 'Packages being scanned OUT'
        : status === 'in_pending'  ? 'Packages to receive'
        : status === 'received'    ? 'Packages received'
        : status === 'cancelled'   ? 'Packages on this cancelled transfer'
        : 'Packages';
    }
    const colIn = $('trmColScanIn');
    if (colIn){
      colIn.style.display = (status === 'in_pending' || status === 'received') ? '' : 'none';
    }
    $('trmTotProgress').style.display = (status === 'in_pending') ? '' : 'none';
    $('trmSubmitOutBtn').style.display = (status === 'out_started') ? '' : 'none';
    $('trmConfirmInBtn').style.display = (status === 'in_pending')  ? '' : 'none';
    // Admins get a Reconcile action on in-transit transfers (to resolve
    // OUT/IN package mismatches by declaring which voucher is authoritative).
    const recBtn = $('trmReconcileBtn');
    if (recBtn) recBtn.style.display =
      (status === 'in_pending' && window._INV_CAN_EDIT === true) ? '' : 'none';
    $('trmCancelBtn').style.display    =
        (status === 'out_started' || status === 'in_pending' || status === 'received')
        ? '' : 'none';
    // Print button: visible once a voucher number exists (i.e. an actual
    // transfer row has been created). Hidden in pre-scan NEW mode where
    // there's literally nothing to print yet.
    _trEnsurePrintButton();
    const pb = $('trmPrintBtn');
    if (pb){
      pb.style.display = _trEditId ? '' : 'none';
      // Print the side that matches the modal's current identity:
      //   out_started  → OUT voucher (only side that exists yet)
      //   in_pending   → IN voucher (the number the destination scans)
      //   received     → IN voucher (the transfer "ended" as the IN side)
      //   cancelled    → OUT (the IN may never have been issued)
      pb._printSide = (status === 'in_pending' || status === 'received') ? 'in' : 'out';
    }
  }

  // Lazy-inject the Print button into the modal footer. Modal HTML is
  // pre-rendered as part of _transfers.html; rather than fork that
  // template for a small change, we add the button at runtime once.
  function _trEnsurePrintButton(){
    if ($('trmPrintBtn')) return;
    // Insert before trmSubmitOutBtn so the visual order is:
    //   [Cancel] ... [Close] [Print] [Submit OUT / Confirm IN]
    const anchor = $('trmSubmitOutBtn');
    if (!anchor || !anchor.parentNode) return;
    const btn = document.createElement('button');
    btn.id = 'trmPrintBtn';
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.style.display = 'none';
    btn.innerHTML = '<i class="fas fa-print"></i> Print';
    btn.onclick = () => {
      if (!_trEditId){ _toast('No voucher to print yet', 'warn'); return; }
      const side = btn._printSide || 'out';
      window.invTrPrint(_trEditId, side);
    };
    anchor.parentNode.insertBefore(btn, anchor);
  }

  // ═══════════════════════════════════════════════════════════════════
  // OVERLAY OPEN / CLOSE
  // ═══════════════════════════════════════════════════════════════════
  function _trOpenOverlay(){
    const ov = $('trmOverlay');
    if (ov) ov.classList.add('open');
  }
  window.invTrCloseModal = function(){
    const ov = $('trmOverlay');
    if (ov) ov.classList.remove('open');
    _trEditId = null; _trStatus = null;
    _trPackages = []; _trVoucherMeta = {};
  };
  window.invTrModalBgClick = function(ev){
    if (ev.target === ev.currentTarget) invTrCloseModal();
  };

  // ═══════════════════════════════════════════════════════════════════
  // DROPDOWN HANDLERS (modal — From/To exclude each other)
  // ═══════════════════════════════════════════════════════════════════
  window.invTrFromChanged = function(){
    if (_trEditId){
      _toast('From godown is locked after the first scan', 'warn'); return;
    }
    _trFillModalGodowns();
  };
  window.invTrToChanged = function(){
    if (_trEditId){
      _toast('To godown is locked after the first scan', 'warn'); return;
    }
    _trFillModalGodowns();
  };

  // ═══════════════════════════════════════════════════════════════════
  // SCAN INPUT (mode-aware)
  // ═══════════════════════════════════════════════════════════════════
  window.invTrScanKey = async function(ev){
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const inp = $('trmScanInput');
    const code = (inp.value || '').trim().toUpperCase();
    if (!code) return;
    if (_trStatus === 'out_started'){
      await _trScanOut(code);
    } else if (_trStatus === 'in_pending'){
      await _trScanIn(code);
    }
  };

  async function _trScanOut(code){
    const fromId = parseInt($('trmFromGodown').value) || 0;
    const toId   = parseInt($('trmToGodown').value)   || 0;
    if (!fromId || !toId){
      _trFeedback('⚠ Select both From and To godowns first', 'error'); return;
    }
    if (fromId === toId){
      _trFeedback('⚠ From and To must be different', 'error'); return;
    }
    try {
      if (!_trEditId){
        // ── MR-fulfilment hook ──────────────────────────────────────────
        // When the user clicked "Fulfill" on a Material Request, the MR
        // module stashed window._invMRPendingPrefill with the request_id.
        // Include it in the /start payload so the resulting transfer is
        // linked to the request — backend updates qty_fulfilled when the
        // IN side completes. After /start succeeds we clear the prefill
        // so a non-MR transfer started right after doesn't accidentally
        // re-use it.
        const _mrPrefill = window._invMRPendingPrefill || null;
        const _startBody = {
          from_godown_id: fromId,
          to_godown_id:   toId,
          transfer_date:  $('trmDate').value || new Date().toISOString().slice(0,10),
          remarks: ($('trmRemarks').value || '').trim(),
          box_ids: [],
        };
        if (_mrPrefill && _mrPrefill.request_id){
          _startBody.request_id = _mrPrefill.request_id;
        }
        const startRes = await fetch('/api/inventory_godown/transfers/start', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(_startBody)
        });
        const startJson = await startRes.json();
        if (startJson.status !== 'ok'){
          _trFeedback('⚠ ' + (startJson.message || 'Could not start transfer'), 'error');
          return;
        }
        _trEditId = startJson.transfer_id;
        // Seed _trVoucherMeta so any later _trApplyStageUI call picks
        // the correct number for the header. At this stage there's only
        // an OUT vno — IN vno is allocated on submit_out.
        _trVoucherMeta = Object.assign({}, _trVoucherMeta || {}, {
          transfer_id:   startJson.transfer_id,
          transfer_no:   startJson.transfer_no,
          in_voucher_no: null,
          status:        'out_started',
        });
        $('trmVno').textContent = startJson.transfer_no;
        ['trmDate','trmFromGodown','trmToGodown'].forEach(id => {
          const el = $(id); if (el) el.disabled = true;
        });
        const bn = $('trmBanner');
        if (bn){
          bn.innerHTML = `OUT in progress — keep scanning packages, then click <strong>Submit OUT</strong> when done.`;
        }
        // Clear MR prefill — request is now linked at the DB level via
        // the request_id stored on the transfer row.
        if (_mrPrefill && typeof window.invMRClearPrefill === 'function'){
          window.invMRClearPrefill();
        }
      }
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/scan_out`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_code: code })
      });
      const j = await r.json();
      if (j.status === 'ok' && j.package){
        _trPackages.push({
          box_id:        j.package.box_id,
          box_code:      j.package.box_code,
          material_name: j.package.material_name || '',
          per_box_qty:   j.package.per_box_qty || 0,
          uom:           j.package.uom || '',
          batch_num:     j.package.batch_num || '',
          scanned_in:    false,
        });
        _trRenderPackages();
        _trUpdateTotals();
        _trFeedback('✓ Added ' + j.package.box_code + ' — ' +
          _fmtQty(j.package.per_box_qty, j.package.uom), 'ok');
      } else if (j.status === 'fefo_blocked'){
        // FEFO violation — offer to raise an override request for approval.
        _trFeedback('⚠ ' + (j.message || 'FEFO violation'), 'error');
        const reason = prompt(
          'FEFO violation — an earlier-expiry package (' +
          (j.fefo && j.fefo.earliest_box_code || '') + ', exp ' +
          (j.fefo && j.fefo.earliest_expiry || '') + ') should be used first.\n\n' +
          'To scan ' + (j.box_code || code) + ' anyway, enter a reason to request an admin override:'
        );
        if (reason && reason.trim()){
          try {
            const orr = await fetch('/api/inventory_mgmt/fefo/override/request', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ box_id: j.box_id, box_code: j.box_code, reason: reason.trim() })
            });
            const ord = await orr.json();
            if (ord.status === 'ok'){
              _trFeedback('Override request submitted — once an admin approves, re-scan this package.', 'ok');
            } else {
              _trFeedback('⚠ ' + (ord.message || 'Could not submit override'), 'error');
            }
          } catch(e2){ _trFeedback('⚠ ' + (e2.message || e2), 'error'); }
        }
      } else {
        _trFeedback('⚠ ' + (j.message || 'Scan failed'), 'error');
      }
    } catch(e){
      _trFeedback('⚠ ' + (e.message || e), 'error');
    } finally {
      const inp = $('trmScanInput');
      inp.value = ''; inp.focus();
    }
  }

  async function _trScanIn(code){
    if (!_trEditId) return;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/scan_in`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_code: code })
      });
      const j = await r.json();
      if (j.status === 'ok' && j.package){
        const p = _trPackages.find(p => p.box_id === j.package.box_id);
        if (p) p.scanned_in = true;
        _trRenderPackages();
        _trUpdateTotals();
        const sc = j.scan_counts || {};
        // If this scan completed the voucher, finalize the receipt
        // automatically instead of making the operator press Confirm.
        if (Number(sc.expected||0) && Number(sc.scanned_in||0) >= Number(sc.expected||0)){
          const auto = await _trMaybeAutoConfirm(_trEditId, sc);
          if (auto.state === 'received'){
            _trFeedback(`✓ ${j.package.box_code} received — all ${sc.expected} scanned, receipt confirmed`, 'ok');
            _toast(`Receipt confirmed — ${auto.received} package(s) received`, 'ok');
            invTrCloseModal();
            await invTrLoadList();
            return;
          }
          if (auto.state === 'awaiting'){
            // OUT creator can't self-confirm — leave it for another user.
            _trFeedback(`✓ ${j.package.box_code} received (${sc.scanned_in}/${sc.expected}) — another user must confirm receipt`, 'ok');
          } else if (auto.state === 'error'){
            _trFeedback(`✓ ${j.package.box_code} received (${sc.scanned_in}/${sc.expected}) — auto-confirm failed: ${auto.message||'unknown'}`, 'error');
          } else {
            _trFeedback(`✓ ${j.package.box_code} received (${sc.scanned_in}/${sc.expected})`, 'ok');
          }
        } else {
          _trFeedback(`✓ ${j.package.box_code} received (${sc.scanned_in}/${sc.expected})`, 'ok');
        }
      } else {
        _trFeedback('⚠ ' + (j.message || 'Scan failed'), 'error');
      }
    } catch(e){
      _trFeedback('⚠ ' + (e.message || e), 'error');
    } finally {
      // After an auto-confirm the modal may have closed and the input removed.
      const inp = $('trmScanInput');
      if (inp){ inp.value = ''; inp.focus(); }
    }
  }

  function _trFeedback(text, kind){
    const fb = $('trmScanFeedback');
    if (!fb) return;
    fb.textContent = text;
    fb.className = 'trm-scan-feedback' + (kind ? ' ' + kind : '');
  }

  function _trUpdateTotals(){
    const totalBoxes = _trPackages.length;
    const totalQty = _trPackages.reduce(
      (s, p) => s + (parseFloat(p.per_box_qty) || 0), 0
    );
    $('trmTotPackages').textContent = _fmtNum(totalBoxes);
    $('trmTotQty').textContent      = _fmtQty(totalQty);

    if (_trStatus === 'in_pending'){
      const scanned = _trPackages.filter(p => p.scanned_in).length;
      const expected = _trPackages.length;
      $('trmProgressText').textContent = `${scanned} / ${expected}`;
      const fill = $('trmProgressFill');
      if (fill){
        const pct = expected > 0 ? (scanned / expected) * 100 : 0;
        fill.style.width = pct.toFixed(1) + '%';
      }
      const bn = $('trmBanner');
      if (bn){
        bn.innerHTML = `Receive each package at the destination — <strong>${scanned}/${expected}</strong> scanned IN. Click <strong>Confirm Receipt</strong> after all packages are scanned.`;
      }
    }
  }

  function _trRenderPackages(){
    const body = $('trmPackagesBody');
    if (!body) return;
    const stage = _trStatus;
    const showInCol = (stage === 'in_pending' || stage === 'received');
    if (!_trPackages.length){
      body.innerHTML = `<tr><td colspan="7" class="no-data">No packages yet${stage === 'out_started' ? ' — scan one above' : ''}</td></tr>`;
      return;
    }
    body.innerHTML = _trPackages.map((p, i) => {
      const scannedIn = !!p.scanned_in;
      const inCell = showInCol
        ? `<td class="center">${scannedIn
            ? '<span class="trm-pkg-tick"><i class="fas fa-check-circle"></i></span>'
            : '<span class="trm-pkg-x">—</span>'}</td>`
        : '<td style="display:none"></td>';
      let removeBtn = '';
      if (stage === 'out_started'){
        removeBtn = `<button class="trm-pkg-del" onclick="invTrUnscanOut(${p.box_id})" title="Remove from OUT">×</button>`;
      } else if (stage === 'in_pending' && scannedIn){
        removeBtn = `<button class="trm-pkg-del" onclick="invTrUnscanIn(${p.box_id})" title="Undo IN scan">↶</button>`;
      }
      return `<tr>
        <td class="muted">${i+1}</td>
        <td><strong style="font-family:JetBrains Mono,monospace">${_esc(p.box_code)}</strong></td>
        <td>${_esc(p.material_name || '—')}</td>
        <td>${_esc(p.batch_num || '—')}</td>
        <td class="right">${_fmtQty(p.per_box_qty, p.uom)}</td>
        ${inCell}
        <td>${removeBtn}</td>
      </tr>`;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // UNDO SCANS
  // ═══════════════════════════════════════════════════════════════════
  window.invTrUnscanOut = async function(boxId){
    if (!_trEditId) return;
    if (!confirm('Remove this package from the OUT scan?')) return;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/unscan_out`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_id: boxId })
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Could not undo', 'error'); return; }
      _trPackages = _trPackages.filter(p => p.box_id !== boxId);
      _trRenderPackages();
      _trUpdateTotals();
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };
  window.invTrUnscanIn = async function(boxId){
    if (!_trEditId) return;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/unscan_in`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_id: boxId })
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Could not undo', 'error'); return; }
      const p = _trPackages.find(p => p.box_id === boxId);
      if (p) p.scanned_in = false;
      _trRenderPackages();
      _trUpdateTotals();
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SUBMIT OUT / CONFIRM RECEIPT / CANCEL
  // ═══════════════════════════════════════════════════════════════════
  window.invTrSubmitOut = async function(){
    if (!_trEditId){ _toast('Scan at least one package first', 'warn'); return; }
    if (!_trPackages.length){ _toast('Scan at least one package first', 'warn'); return; }
    if (!confirm(`Submit OUT for ${_trPackages.length} package(s)? They will move to "in transit" until the destination scans them in.`)) return;
    const btn = $('trmSubmitOutBtn'); if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/submit_out`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Submit failed', 'error'); return; }
      // Surface the newly-issued IN voucher number so the operator knows
      // which voucher to look for in the In-Transit list — that's the
      // number the destination will scan against, not the OUT number.
      const _inVno = (j.in_voucher_no || '').trim();
      _toast(
        _inVno
          ? `OUT submitted — IN voucher ${_inVno} now IN TRANSIT`
          : 'OUT submitted — voucher is now IN TRANSIT',
        'ok'
      );
      invTrCloseModal();
      await invTrLoadList();
      invTrSwitchPillTab('in');  // jump to the IN tab so the operator
                                  // sees the card they just created
    } catch(e){
      _toast(e.message || e, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.invTrConfirmIn = async function(){
    if (!_trEditId){ _toast('No transfer to confirm', 'warn'); return; }
    const scanned = _trPackages.filter(p => p.scanned_in).length;
    const total   = _trPackages.length;
    if (scanned < total){
      // Mismatch: a normal receipt is blocked. Admins can resolve it via the
      // reconciliation flow (declare which voucher is authoritative).
      if (window._INV_CAN_EDIT === true){
        invTrReconcileOpen();
      } else {
        _toast(`Scan all ${total} packages first (${total - scanned} missing)`, 'warn');
      }
      return;
    }
    if (!confirm(`Confirm receipt of ${total} package(s) at the destination godown?`)) return;
    const btn = $('trmConfirmInBtn'); if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/confirm_receipt`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Confirm failed', 'error'); return; }
      _toast(`Receipt confirmed — ${j.total_received} package(s) received`, 'ok');
      invTrCloseModal();
      await invTrLoadList();
    } catch(e){
      _toast(e.message || e, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ── RECONCILE (admin) ────────────────────────────────────────────────
  // Resolve an OUT/IN package mismatch by declaring which voucher is the
  // truth. Builds a small modal on first use.
  function _trReconcileEnsureModal(){
    if ($('trReconcileOv')) return;
    const ov = document.createElement('div');
    ov.id = 'trReconcileOv';
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-card" style="max-width:92vw;width:520px">'
      + '<div class="modal-head"><div class="modal-title"><span>⚖️</span> <span>Reconcile transfer mismatch</span></div>'
      +   '<button class="modal-close" onclick="invTrReconcileClose()">&times;</button></div>'
      + '<div class="modal-body" id="trReconcileBody" style="padding:18px"></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e)=>{ if(e.target===ov) invTrReconcileClose(); });
  }
  window.invTrReconcileClose = function(){ const o=$('trReconcileOv'); if(o) o.classList.remove('show'); };

  window.invTrReconcileOpen = function(){
    if (!_trEditId){ _toast('No transfer selected', 'warn'); return; }
    _trReconcileEnsureModal();
    const total   = _trPackages.length;
    const scanned = _trPackages.filter(p => p.scanned_in).length;
    const missing = total - scanned;
    const inpCss = 'width:100%;padding:9px 11px;border:1px solid var(--border,rgba(0,0,0,.15));border-radius:8px;font-size:13px;resize:vertical;background:var(--card,#fff);color:var(--text,#1F1F1F)';
    const optCard = (mode, title, desc, accent) =>
      '<label style="display:block;border:1px solid var(--border,rgba(0,0,0,.14));border-radius:10px;'
      + 'padding:12px 14px;margin-bottom:10px;cursor:pointer">'
      + '<div style="display:flex;align-items:flex-start;gap:10px">'
      +   '<input type="radio" name="trRecMode" value="'+mode+'" style="margin-top:3px">'
      +   '<div><div style="font-weight:700;font-size:13px;color:'+accent+'">'+title+'</div>'
      +   '<div style="font-size:12px;color:var(--text2,#5F6368);margin-top:2px;line-height:1.45">'+desc+'</div></div>'
      + '</div></label>';

    $('trReconcileBody').innerHTML =
      '<div style="background:#FEF7E0;border:1px solid rgba(176,96,0,.25);border-radius:10px;'
      + 'padding:11px 13px;font-size:12.5px;color:#7a4400;margin-bottom:14px;line-height:1.5">'
      + '<strong>Mismatch:</strong> OUT lists <strong>'+total+'</strong> package(s); '
      + '<strong>'+scanned+'</strong> scanned IN, <strong>'+missing+'</strong> not received. '
      + 'Choose which voucher is authoritative — stock will be adjusted to match.</div>'
      + optCard('out_accurate', 'Material OUT is accurate',
          'Treat all '+total+' package(s) as received at the destination (the '+missing+' un-scanned one(s) are auto-received).',
          '#137333')
      + optCard('in_accurate', 'Material IN is accurate',
          'Only the '+scanned+' scanned package(s) are received. The '+missing+' extra OUT package(s) are set off — reverted to the source godown.',
          '#1A73E8')
      + '<div style="margin:6px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3,#80868B)">Reason (required)</div>'
      + '<textarea id="trRecReason" rows="3" style="'+inpCss+'" placeholder="Explain the discrepancy and the decision…"></textarea>'
      + '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">'
      +   '<button class="btn btn-ghost" onclick="invTrReconcileClose()">Cancel</button>'
      +   '<button class="btn btn-primary" id="trRecSubmit" onclick="invTrReconcileSubmit()">Apply reconciliation</button>'
      + '</div>';
    $('trReconcileOv').classList.add('show');
  };

  window.invTrReconcileSubmit = async function(){
    const sel = document.querySelector('input[name="trRecMode"]:checked');
    if (!sel){ _toast('Choose which voucher is accurate', 'warn'); return; }
    const reason = ($('trRecReason').value || '').trim();
    if (!reason){ _toast('A reconciliation reason is required', 'warn'); return; }
    if (!confirm('Apply this reconciliation? Stock will be adjusted and the transfer closed.')) return;
    const btn = $('trRecSubmit'); if (btn){ btn.disabled = true; btn.textContent = 'Applying…'; }
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/reconcile`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ mode: sel.value, reason })
      });
      const j = await r.json();
      if (j.status === 'blocked'){ _toast(j.message, 'warn'); if(btn){btn.disabled=false;btn.textContent='Apply reconciliation';} return; }
      if (j.status !== 'ok'){ _toast(j.message || 'Reconcile failed', 'error'); if(btn){btn.disabled=false;btn.textContent='Apply reconciliation';} return; }
      _toast(j.message || 'Reconciled', 'ok');
      invTrReconcileClose();
      invTrCloseModal();
      await invTrLoadList();
    } catch(e){
      _toast(e.message || e, 'error');
      if(btn){ btn.disabled=false; btn.textContent='Apply reconciliation'; }
    }
  };

  window.invTrCancelCurrent = async function(){
    if (!_trEditId) return;
    const msg = (_trStatus === 'received')
      ? 'Cancel this received transfer? Packages will move back to the FROM godown.'
      : 'Cancel this transfer? Packages will return to the FROM godown.';
    if (!confirm(msg)) return;
    try {
      const r = await fetch(`/api/inventory_godown/transfers/${_trEditId}/cancel`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Cancel failed', 'error'); return; }
      _toast(`Transfer cancelled — ${j.reversed_count} package(s) returned`, 'ok');
      invTrCloseModal();
      await invTrLoadList();
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };

  // ESC key closes the modal (suppressed when scan input is focused —
  // many barcode scanners send ESC as a suffix character).
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Escape') return;
    const ov = $('trmOverlay');
    if (!ov || !ov.classList.contains('open')) return;
    const active = document.activeElement;
    if (active && (active.id === 'trmScanInput')) return;
    invTrCloseModal();
  });

  console.log('✅ inventory_transfers.js (three-pill PM-style) loaded');

  // ═══════════════════════════════════════════════════════════════════
  // LEGACY COMPATIBILITY SHIMS
  // ═══════════════════════════════════════════════════════════════════
  // Some older builds of inventory_mgmt.html embedded a duplicate copy
  // of the Stock Transfers panel with buttons that called the now-
  // removed helpers (invTrOpenNew, invTrSwitchSubTab, invTrSetFilter,
  // invTrRenderList). Those legacy buttons now raise ReferenceError on
  // click. We define no-op shims that redirect to the new flow so the
  // page doesn't crash — the user gets the correct UI either way.
  // Safe to keep indefinitely (idempotent — only defines if missing).
  if (typeof window.invTrOpenNew !== 'function'){
    window.invTrOpenNew = function(){
      // OLD: opened a "New Transfer" dialog. NEW flow expects the user
      // to pick From + To in the Create-OUT card before opening the
      // modal. If the old "+ New Transfer" button is still rendered
      // somewhere (legacy template fragment), this shim opens a
      // minimal new-voucher prompt that asks for the godowns.
      //
      // We can't call invTrCreateOutClick() directly because it reads
      // values from #tr-create-from / #tr-create-to — those exist only
      // when the NEW template is rendered, and even then the user
      // hasn't picked anything yet. So we just switch to the OUT tab,
      // scroll the create card into view, and focus the From dropdown.
      if (typeof window.invTrSwitchPillTab === 'function'){
        window.invTrSwitchPillTab('out');
      }
      const fromSel = document.getElementById('tr-create-from');
      if (fromSel){
        if (typeof fromSel.scrollIntoView === 'function'){
          fromSel.scrollIntoView({ behavior:'smooth', block:'center' });
        }
        setTimeout(() => {
          fromSel.focus();
          // Pulse the create card so the user notices where to go next.
          const card = fromSel.closest('.tr-create-card');
          if (card){
            card.style.transition = 'box-shadow .35s';
            card.style.boxShadow = '0 0 0 3px rgba(13,148,136,.4), 0 4px 18px rgba(13,148,136,.25)';
            setTimeout(() => { card.style.boxShadow = ''; }, 1400);
          }
        }, 250);
      } else {
        // The new template isn't rendered — the old "+ New Transfer"
        // button is on screen but the new create card isn't. This is
        // the symptom of dual-render. Warn so we can debug.
        console.warn('[invTrOpenNew shim] No #tr-create-from found — new template not rendered. The old "+ New Transfer" button is showing but the new Create card is not. Check for duplicate _transfers.html includes.');
        alert('The Stock Transfers panel needs to be refreshed.\n\nPlease hard-refresh the page (Ctrl+Shift+R) and try again.\n\nIf the problem persists, restart Flask — the template appears to be partially loaded.');
      }
    };
  }
  if (typeof window.invTrSwitchSubTab !== 'function'){
    window.invTrSwitchSubTab = function(name){
      // OLD: switched between QR / Manual sub-tabs. NEW flow lives in
      // separate sidebar panels. If the user clicks the legacy "Manual"
      // sub-tab, route to the Simple Voucher panel.
      if (name === 'manual' || name === 'simple'){
        if (typeof window.invSwitchPanel === 'function'){
          window.invSwitchPanel('simple-voucher');
        }
      } else {
        if (typeof window.invTrSwitchPillTab === 'function'){
          window.invTrSwitchPillTab('out');
        }
      }
    };
  }
  if (typeof window.invTrSetFilter !== 'function'){
    window.invTrSetFilter = function(status){
      // OLD: chip filter on All/Out Started/In Transit/Received/Cancelled.
      // NEW: pill tabs roughly map to: out_started→out, in_pending→in,
      // received/cancelled→history.
      if (typeof window.invTrSwitchPillTab !== 'function') return;
      if (status === 'out_started')      window.invTrSwitchPillTab('out');
      else if (status === 'in_pending')  window.invTrSwitchPillTab('in');
      else if (status === 'received' || status === 'cancelled')
        window.invTrSwitchPillTab('history');
      else
        window.invTrSwitchPillTab('out');
    };
  }
  if (typeof window.invTrRenderList !== 'function'){
    window.invTrRenderList = function(){
      // OLD: rendered the single filtered table. NEW: three section
      // renderers handle their own panes. Just kick the list loader.
      if (typeof window.invTrLoadList === 'function') window.invTrLoadList();
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // PLUG-AND-PLAY AUTO-LOADER for inventory_simple_transfer.js
  // ═══════════════════════════════════════════════════════════════════
  // The Simple Voucher module is a separate sidebar panel. To avoid a
  // template edit (no <script> tag in inventory_mgmt.html), we inject
  // its <script> at runtime here. It self-registers a sidebar nav item
  // and panel mount on DOMContentLoaded, so the user sees a working
  // "Simple Voucher" item in the sidebar with no manual wiring.
  //
  // Idempotent — only injects once per page load.
  (function _loadSimpleVoucherModule(){
    if (typeof window.invStmActivate === 'function') return;  // already loaded
    if (document.querySelector('script[data-inv-stm-loader]')) return;  // already injected
    let stmSrc = '/static/inventory/inventory_simple_transfer.js?v=6';
    const selfTag = document.querySelector('script[src*="inventory_transfers.js"]');
    if (selfTag){
      try {
        const u = new URL(selfTag.src, window.location.href);
        u.pathname = u.pathname.replace(/inventory_transfers\.js$/, 'inventory_simple_transfer.js');
        u.search = "?v=6";
        stmSrc = u.toString();
      } catch(_) {}
    }
    const tag = document.createElement('script');
    tag.src = stmSrc;
    tag.async = false;  // execute in document order so its bootstrap
                        // runs before any user click could fire
    tag.setAttribute('data-inv-stm-loader', '1');
    tag.addEventListener('error', () => {
      console.warn('[inventory_transfers] Could not load simple voucher module from', stmSrc);
    });
    document.head.appendChild(tag);
  })();
})();
