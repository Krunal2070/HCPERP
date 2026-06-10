/* ════════════════════════════════════════════════════════════════════════
   inventory_simple_transfer.js — Simple (manual / non-QR) Voucher (RM)
   ────────────────────────────────────────────────────────────────────────
   This module is SELF-REGISTERING. It does three things at load time
   that make it truly plug-and-play — drop the file in, no HTML edit:

     1. Injects its own sidebar nav item under the Stock section, between
        "Stock Transfers" and "Manage Godowns".
     2. Injects an empty panel mount-point (.panel#panel-simple-voucher)
        into .inv-wrap.
     3. Wraps window.invSwitchPanel so clicking the new nav item routes
        through and calls our init.

   LAYOUT (matches the QR voucher panel, PM Stock parity):
     Three pill tabs at the top:
       📤 Material OUT  → Create-OUT card (with line items grid) +
                          pending-OUT drafts list
       📥 Material IN   → In-Transit dashboard cards
       🗂 History       → Received + Cancelled, searchable

   The wide modal overlay opens on:
     - Create OUT (new) → modal with editable header + items grid
     - Click a draft row → same modal with saved data, editable
     - Click an in-transit card → modal in "IN" mode, items shown,
       Confirm Receipt button visible
     - Click a history row → modal in read-only mode

   API (unchanged from before, all under /api/inventory_simple_transfer/*):
     GET  /list, /in_transit, /get
     GET  /materials/search, /loose_stock
     POST /save, /<vid>/submit_out, /<vid>/confirm_receipt, /<vid>/cancel
     GET  /<vid>/print_data, /<vid>/whatsapp_text
═════════════════════════════════════════════════════════════════════════ */

(function(){
  'use strict';
  const $ = id => document.getElementById(id);

  // ─── State ──────────────────────────────────────────────────────────
  let _stmList    = [];
  let _stmGodowns = [];
  let _stmActiveTab = 'out';

  // Modal state
  let _stmEditId   = null;
  let _stmStatus   = null;
  let _stmItems    = [];
  let _stmMeta     = {};

  // Typeahead state (per row)
  let _stmMatRows = [];
  const _stmMatHighlight = {};

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
    // Display dates as DD/MM/YYYY (the inventory module's standing rule).
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s).slice(0,10);
  }
  function _toast(msg, kind){
    let el = document.querySelector('.stm-toast');
    if (!el){
      el = document.createElement('div');
      el.className = 'stm-toast';
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;'
        + 'transform:translateX(-50%);padding:10px 18px;border-radius:8px;'
        + 'color:#fff;font-size:13px;font-weight:700;z-index:1100;'
        + 'box-shadow:0 4px 18px rgba(0,0,0,.18);';
      document.body.appendChild(el);
    }
    el.style.background = (kind === 'error') ? '#dc2626'
                        : (kind === 'warn')  ? '#d97706'
                        : '#16a34a';
    el.textContent = msg;
    el.style.display = '';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 3200);
  }

  // ═══════════════════════════════════════════════════════════════════
  // BOOTSTRAP — runs on module load
  // ═══════════════════════════════════════════════════════════════════
  // Adds sidebar nav item + panel mount + hooks invSwitchPanel. We wait
  // until DOMContentLoaded (or fire immediately if already loaded) so
  // the existing inventory_mgmt + inventory_godown injection runs first.
  function _stmBootstrap(){
    // Don't double-bootstrap if loaded twice
    if (window._invStmBootstrapped) return;
    window._invStmBootstrapped = true;

    // 0) Inject defensive CSS FIRST, before any DOM elements that use
    //    the classes. We create a dedicated <style> element rather than
    //    going through innerHTML so the browser is guaranteed to parse
    //    and apply the rules immediately. This is critical because:
    //    - some live builds of inventory_mgmt.html have an old inline
    //      Stock Transfers UI that we'd otherwise look broken next to;
    //    - the panel HTML below uses these classes immediately on
    //      first activation, so they must be present when it inserts.
    if (!document.getElementById('inv-stm-defensive-css')){
      const styleEl = document.createElement('style');
      styleEl.id = 'inv-stm-defensive-css';
      styleEl.textContent = _STM_DEFENSIVE_CSS;
      // Append to <head> so it's parsed as soon as possible. Using
      // appendChild (not innerHTML) avoids any reflow gotchas.
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // 1) Inject the sidebar nav item — gated on the 'simple_transfer'
    //    access cap (not on the admin-only _INV_CAN_EDIT flag). A non-
    //    admin user granted simple_transfer=on in User Access Control
    //    must be able to see this nav item; otherwise the toggle is
    //    purely cosmetic for them. Admins implicitly pass via
    //    window.invHasAccess (the helper short-circuits for admins).
    var _canSimple = false;
    if (typeof window.invHasAccess === 'function'){
      _canSimple = !!window.invHasAccess('simple_transfer');
    } else {
      // Bootstrap-time fallback: read _invAccess directly if
      // invHasAccess hasn't been defined yet. (Shouldn't happen — the
      // gating script in inventory_mgmt.html runs before this — but
      // be defensive in case load order changes.)
      var _a = window._invAccess;
      if (_a && _a.is_admin) _canSimple = true;
      else if (_a && _a.access){
        var _v = _a.access.simple_transfer;
        _canSimple = (_v === 'on' || _v === 'edit' || _v === 'view');
      }
    }
    if (_canSimple){
      const sidebar = document.querySelector('.inv-sidebar') ||
                      document.querySelector('.inv-nav') ||
                      document.querySelector('.inv-side');
      // The actual sidebar is built by inventory_mgmt.html via JS, so
      // we find the existing "Stock Transfers" nav item and insert ours
      // right after it.
      const stockTransfersNav = document.querySelector(
        '.inv-nav-item[data-panel="stock-transfers"]'
      );
      if (stockTransfersNav && stockTransfersNav.parentNode){
        const newNav = document.createElement('div');
        newNav.className = 'inv-nav-item';
        newNav.setAttribute('data-panel', 'simple-voucher');
        // data-cap so the gating layer can re-apply on access changes
        // (e.g. inv-access-ready re-fires after an in-page rights save).
        newNav.setAttribute('data-cap', 'simple_transfer');
        newNav.setAttribute('onclick', "invSwitchPanel('simple-voucher')");
        newNav.setAttribute('title',
          'Simple Voucher — manual stock transfer without QR scan');
        newNav.innerHTML = '<span class="ico"><i class="fas fa-file-alt"></i></span><span>Simple Voucher</span>';
        stockTransfersNav.parentNode.insertBefore(newNav, stockTransfersNav.nextSibling);
      }
    }

    // 2) Inject an empty panel mount-point into .inv-wrap. The UI HTML
    //    is rendered into it on first activation (lazy-render).
    const wrap = document.querySelector('.inv-wrap');
    if (wrap && !document.getElementById('panel-simple-voucher')){
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = 'panel-simple-voucher';
      // Don't fill innerHTML here — wait for first activation
      wrap.appendChild(panel);
    }

    // 3) Inject the modal overlay into <body> (position:fixed, so location
    //    doesn't matter — but the panel is display:none when inactive,
    //    so we can't host the modal inside it).
    if (!document.getElementById('stmModalOverlay')){
      const modalDiv = document.createElement('div');
      modalDiv.innerHTML = _STM_MODAL_HTML;
      while (modalDiv.firstChild) document.body.appendChild(modalDiv.firstChild);
    }

    // 4) Hook invSwitchPanel so the new panel ID routes through us.
    //    We wrap the same way inventory_godown.js does (preserving the
    //    original behaviour for all other panel keys).
    const _origSwitch = window.invSwitchPanel;
    window.invSwitchPanel = function(name){
      if (typeof _origSwitch === 'function') _origSwitch(name);
      // The original wrapper in inventory_godown.js already toggles
      // .panel / .inv-nav-item active states for arbitrary names —
      // including ours, since we set the right IDs. We just need to
      // run the lazy-init / refresh side of the activation.
      if (name === 'simple-voucher'){
        window.invStmActivate();
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // LAZY UI RENDER (runs on first activation of the panel)
  // ═══════════════════════════════════════════════════════════════════
  window.invStmActivate = async function(){
    const panel = $('panel-simple-voucher');
    if (!panel) return;
    if (!panel._uiInjected){
      panel.innerHTML = _STM_PANEL_HTML;
      panel._uiInjected = true;
    }
    await _stmLoadGodowns();
    _stmFillCreateGodowns();
    // Bind the create-card dropdowns once
    const fromSel = $('stm-create-from');
    const toSel   = $('stm-create-to');
    if (fromSel && !fromSel._wired){
      fromSel.addEventListener('change', _stmFillCreateGodowns);
      fromSel._wired = true;
    }
    if (toSel && !toSel._wired){
      toSel.addEventListener('change', _stmFillCreateGodowns);
      toSel._wired = true;
    }
    await window.invStmLoadList();
    invStmCloseModal();
  };

  // ═══════════════════════════════════════════════════════════════════
  // GODOWNS
  // ═══════════════════════════════════════════════════════════════════
  async function _stmLoadGodowns(){
    if (_stmGodowns.length) return _stmGodowns;
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      if (j.status === 'ok'){
        _stmGodowns = (j.godowns || []).filter(g => (g.type || '') !== 'floor');
      }
    } catch(e){}
    return _stmGodowns;
  }

  function _stmFillDropdown(selectEl, excludeId){
    if (!selectEl) return;
    const cur = selectEl.value;
    selectEl.innerHTML = '<option value="">— select —</option>' +
      _stmGodowns
        .filter(g => String(g.id) !== String(excludeId))
        .map(g => `<option value="${g.id}">${_esc(g.name)}</option>`)
        .join('');
    if (cur) selectEl.value = cur;
  }
  function _stmFillCreateGodowns(){
    _stmFillDropdown($('stm-create-from'), $('stm-create-to')?.value);
    _stmFillDropdown($('stm-create-to'),   $('stm-create-from')?.value);
  }
  function _stmFillModalGodowns(){
    _stmFillDropdown($('stmFromGodown'), $('stmToGodown')?.value);
    _stmFillDropdown($('stmToGodown'),   $('stmFromGodown')?.value);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PILL TABS
  // ═══════════════════════════════════════════════════════════════════
  window.invStmSwitchPillTab = function(name){
    name = ['out','in','history'].includes(name) ? name : 'out';
    _stmActiveTab = name;
    document.querySelectorAll('#stm-pills .tr-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    ['out','in','history'].forEach(t => {
      const pane = $('stm-pane-' + t);
      if (pane) pane.classList.toggle('active', t === name);
    });
    if (name === 'in')      _stmRenderInTransitCards();
    if (name === 'history') invStmRenderHistory();
    if (name === 'out')     _stmRenderOutPending();
  };

  // ═══════════════════════════════════════════════════════════════════
  // LIST LOADER
  // ═══════════════════════════════════════════════════════════════════
  window.invStmLoadList = async function(){
    try {
      const r = await fetch('/api/inventory_simple_transfer/list');
      const j = await r.json();
      _stmList = (j.status === 'ok') ? (j.vouchers || []) : [];
    } catch(e){
      _stmList = [];
    }
    _stmUpdatePillBadges();
    _stmRenderOutPending();
    _stmRenderInTransitCards();
    invStmRenderHistory();
  };

  function _stmUpdatePillBadges(){
    const inCount = _stmList.filter(v => v.status === 'in_pending').length;
    const badge = $('stm-pill-in-count');
    if (badge){
      badge.textContent = inCount;
      badge.style.display = inCount > 0 ? '' : 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MATERIAL OUT PANE — "+ New Voucher" button + draft list
  // ═══════════════════════════════════════════════════════════════════
  window.invStmCreateNewClick = async function(){
    const fromId = parseInt($('stm-create-from').value) || 0;
    const toId   = parseInt($('stm-create-to').value)   || 0;
    const remarks = ($('stm-create-remarks').value || '').trim();
    if (!fromId || !toId){
      _toast('Pick both From and To godowns', 'warn'); return;
    }
    if (fromId === toId){
      _toast('From and To must be different', 'warn'); return;
    }
    // Open a fresh modal in NEW mode
    _stmEditId = null;
    _stmStatus = 'out_started';
    _stmItems = [_stmBlankItem()];
    _stmMeta = {};
    _stmFillModalGodowns();
    $('stmDate').value = new Date().toISOString().slice(0,10);
    $('stmFromGodown').value = String(fromId);
    $('stmToGodown').value   = String(toId);
    $('stmRemarks').value    = remarks;
    const fromName = _stmGodowns.find(g => String(g.id) === String(fromId))?.name || '—';
    const toName   = _stmGodowns.find(g => String(g.id) === String(toId))?.name   || '—';
    $('stmFromName').textContent = fromName;
    $('stmToName').textContent   = toName;
    $('stmVno').textContent      = 'AUTO ON SAVE';
    _stmApplyStageUI('out_started', false);
    _stmRenderItems();
    _stmRecomputeTotals();
    _stmOpenOverlay();
    // Clear create-card inputs
    $('stm-create-from').value = '';
    $('stm-create-to').value   = '';
    $('stm-create-remarks').value = '';
    _stmFillCreateGodowns();
    // Focus first material input
    setTimeout(() => {
      const inputs = document.querySelectorAll('.stm-mat-input');
      if (inputs.length) inputs[0].focus();
    }, 100);
  };

  function _stmBlankItem(){
    return {
      item_id: null, material_id: null, material_name: '',
      num_pkgs: '', per_pkg_qty: '', total_qty: '',
      uom: '', remarks: '',
    };
  }

  function _stmRenderOutPending(){
    const body = $('stm-out-pending-body');
    const meta = $('stm-out-pending-meta');
    if (!body) return;
    const rows = _stmList.filter(v => v.status === 'out_started');
    if (meta) meta.textContent = rows.length
      ? `${rows.length} draft${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length){
      body.innerHTML = `<tr><td colspan="9" class="no-data">
        <i class="fas fa-check-circle"></i> No drafts — all clear
      </td></tr>`;
      return;
    }
    body.innerHTML = rows.map((v, i) => `
      <tr ondblclick="invStmOpenExisting(${v.voucher_id})">
        <td class="muted-cell">${i+1}</td>
        <td><strong style="font-family:JetBrains Mono,monospace">${_esc(v.voucher_no)}</strong></td>
        <td>${_fmtDateShort(v.voucher_date)}</td>
        <td>${_esc(v.from_godown_name || '—')}</td>
        <td>${_esc(v.to_godown_name || '—')}</td>
        <td style="text-align:right">${_fmtNum(v.total_items)}</td>
        <td style="text-align:right">${_fmtQty(v.total_qty)}</td>
        <td class="td-center">
          <button onclick="invStmOpenExisting(${v.voucher_id})"
                  style="background:none;border:none;color:#4f46e5;
                         font-size:12px;font-weight:700;cursor:pointer">
            Continue →
          </button>
        </td>
        <td class="td-center">
          <button class="icon-btn-sm" onclick="invStmPrint(${v.voucher_id})" title="Print">
            <i class="fas fa-print"></i>
          </button>
          <button class="icon-btn-sm" onclick="invStmWhatsApp(${v.voucher_id})" title="WhatsApp" style="color:#25D366">
            <i class="fab fa-whatsapp"></i>
          </button>
        </td>
      </tr>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // MATERIAL IN PANE — In-Transit cards
  // ═══════════════════════════════════════════════════════════════════
  function _stmRenderInTransitCards(){
    const grid = $('stm-it-grid');
    const meta = $('stm-it-meta');
    if (!grid) return;
    const rows = _stmList.filter(v => v.status === 'in_pending');
    if (meta) meta.textContent = rows.length
      ? `${rows.length} voucher${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length){
      grid.innerHTML = `
        <div class="no-data" style="grid-column:1 / -1;text-align:center;
                                    color:#9ca3af;font-style:italic;
                                    padding:40px 12px">
          <i class="fas fa-truck"></i> Nothing in transit — all vouchers received
        </div>`;
      return;
    }
    grid.innerHTML = rows.map(v => `
      <div class="tr-it-card" onclick="invStmOpenExisting(${v.voucher_id})">
        <div class="icon">📋</div>
        <div class="info">
          <div class="num">${_esc(v.voucher_no)}</div>
          <div class="route">${_esc(v.from_godown_name || '—')} → ${_esc(v.to_godown_name || '—')}</div>
          <div class="meta">${_fmtDateShort(v.voucher_date)}${v.out_by ? ' · by ' + _esc(v.out_by) : ''}</div>
        </div>
        <div class="boxes">
          <div class="lbl">Items</div>
          <div class="val">${_fmtNum(v.total_items)}</div>
        </div>
      </div>
    `).join('');
  }

  // ═══════════════════════════════════════════════════════════════════
  // HISTORY PANE
  // ═══════════════════════════════════════════════════════════════════
  window.invStmRenderHistory = function(){
    const body = $('stm-hist-body');
    const meta = $('stm-hist-meta');
    if (!body) return;
    const filt   = ($('stm-hist-status-filter')?.value || '').trim();
    const search = ($('stm-hist-search')?.value || '').toLowerCase().trim();
    let rows = _stmList.filter(v => v.status === 'received' || v.status === 'cancelled');
    if (filt) rows = rows.filter(v => v.status === filt);
    if (search){
      rows = rows.filter(v => {
        const bag = [v.voucher_no, v.from_godown_name, v.to_godown_name, v.remarks]
          .filter(Boolean).join(' ').toLowerCase();
        return bag.includes(search);
      });
    }
    if (meta) meta.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
    if (!rows.length){
      body.innerHTML = `<tr><td colspan="10" class="no-data">
        <i class="fas fa-archive"></i> No history ${search?'matches':'yet'}
      </td></tr>`;
      return;
    }
    body.innerHTML = rows.map((v, i) => {
      const statusCls = 'tr-status-' + v.status;
      const statusLabel = v.status.toUpperCase();
      return `<tr ondblclick="invStmOpenExisting(${v.voucher_id})">
        <td class="muted-cell">${i+1}</td>
        <td><strong style="font-family:JetBrains Mono,monospace">${_esc(v.voucher_no)}</strong></td>
        <td>${_fmtDateShort(v.voucher_date)}</td>
        <td>${_esc(v.from_godown_name || '—')}</td>
        <td>${_esc(v.to_godown_name || '—')}</td>
        <td style="text-align:right">${_fmtNum(v.total_items)}</td>
        <td style="text-align:right">${_fmtQty(v.total_qty)}</td>
        <td><span class="tr-status-badge ${statusCls}">${statusLabel}</span></td>
        <td class="td-center">
          <button class="icon-btn-sm" onclick="invStmOpenExisting(${v.voucher_id})" title="View">
            <i class="fas fa-eye"></i>
          </button>
        </td>
        <td class="td-center">
          <button class="icon-btn-sm" onclick="invStmPrint(${v.voucher_id})" title="Print">
            <i class="fas fa-print"></i>
          </button>
          <button class="icon-btn-sm" onclick="invStmWhatsApp(${v.voucher_id})" title="WhatsApp" style="color:#25D366">
            <i class="fab fa-whatsapp"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  };

  // ═══════════════════════════════════════════════════════════════════
  // MODAL — OPEN EXISTING
  // ═══════════════════════════════════════════════════════════════════
  window.invStmOpenExisting = async function(voucherId){
    await _stmLoadGodowns();
    try {
      const r = await fetch('/api/inventory_simple_transfer/get?voucher_id=' + voucherId);
      const j = await r.json();
      if (j.status !== 'ok'){
        _toast(j.message || 'Voucher not found', 'error'); return;
      }
      const v = j.voucher;
      _stmEditId = voucherId;
      _stmStatus = v.status;
      _stmItems  = (v.items || []).map(it => ({
        item_id:       it.item_id,
        material_id:   it.material_id,
        material_name: it.material_name || '',
        num_pkgs:      it.num_pkgs,
        per_pkg_qty:   it.per_pkg_qty,
        total_qty:     it.total_qty,
        uom:           it.uom || '',
        remarks:       it.remarks || '',
      }));
      _stmMeta = v;
      _stmFillModalGodowns();
      $('stmDate').value = (v.voucher_date || '').slice(0,10);
      $('stmFromGodown').value = v.from_godown_id || '';
      $('stmToGodown').value   = v.to_godown_id   || '';
      $('stmRemarks').value    = v.remarks || '';
      $('stmVno').textContent  = v.voucher_no || '—';
      $('stmFromName').textContent = v.from_godown_name || '—';
      $('stmToName').textContent   = v.to_godown_name   || '—';
      const readOnly = (v.status === 'received' || v.status === 'cancelled');
      _stmApplyStageUI(v.status, readOnly);
      _stmRenderItems();
      _stmRecomputeTotals();
      _stmOpenOverlay();
    } catch(e){
      _toast(e.message || String(e), 'error');
    }
  };

  function _stmApplyStageUI(status, readOnly){
    const modal = $('stmModal');
    if (!modal) return;
    modal.classList.remove('mode-in','mode-done','mode-cancelled');
    if (status === 'in_pending')     modal.classList.add('mode-in');
    else if (status === 'received')  modal.classList.add('mode-done');
    else if (status === 'cancelled') modal.classList.add('mode-cancelled');

    const titleEl = $('stmHeadTitle');
    const badgeEl = $('stmStatusBadge');
    let titleTxt, badgeTxt;
    if (status === 'out_started'){
      titleTxt = '📋 Simple stock transfer';
      badgeTxt = _stmEditId ? 'DRAFT' : 'NEW';
    } else if (status === 'in_pending'){
      titleTxt = '📋 Simple transfer (in transit)';
      badgeTxt = 'IN TRANSIT';
    } else if (status === 'received'){
      titleTxt = '✅ Completed simple transfer';
      badgeTxt = 'RECEIVED';
    } else if (status === 'cancelled'){
      titleTxt = '✖ Cancelled simple transfer';
      badgeTxt = 'CANCELLED';
    } else {
      titleTxt = 'Simple transfer';
      badgeTxt = String(status || '').toUpperCase();
    }
    if (titleEl) titleEl.textContent = titleTxt;
    if (badgeEl){
      badgeEl.innerHTML = `<span class="tr-status-badge tr-status-${status}">${badgeTxt}</span>`;
    }

    const bn = $('stmBanner');
    if (bn){
      if (status === 'out_started'){
        bn.innerHTML = _stmEditId
          ? `<strong>Draft.</strong> Edit the voucher freely. Click <strong>Submit OUT</strong> to mark items in-transit.`
          : `Fill in the items, then click <strong>Save</strong>. Inventory effects happen on <strong>Submit OUT</strong>.`;
      } else if (status === 'in_pending'){
        bn.innerHTML = `<strong>In transit.</strong> Stock is debited from the source godown. Click <strong>Confirm Receipt</strong> when items arrive at destination.`;
      } else if (status === 'received'){
        bn.innerHTML = `<strong>Completed.</strong> Stock has been credited to the destination godown.`;
      } else if (status === 'cancelled'){
        bn.innerHTML = `<strong>Cancelled.</strong> All stock movements reversed.`;
      }
    }
    const headerLocked = !!_stmEditId;
    ['stmDate','stmFromGodown','stmToGodown'].forEach(id => {
      const el = $(id); if (el) el.disabled = headerLocked || readOnly;
    });
    $('stmRemarks').disabled = readOnly;
    const itemsEditable = (status === 'out_started');
    $('stmAddItemBtn').style.display = itemsEditable ? '' : 'none';
    $('stmSaveBtn').style.display         = (status === 'out_started') ? '' : 'none';
    $('stmSubmitOutBtn').style.display    = (status === 'out_started' && _stmEditId) ? '' : 'none';
    $('stmConfirmInBtn').style.display    = (status === 'in_pending')  ? '' : 'none';
    $('stmCancelBtn').style.display       =
        (status === 'out_started' || status === 'in_pending' || status === 'received')
        ? '' : 'none';
    $('stmPrintBtn').style.display    = _stmEditId ? '' : 'none';
    $('stmWhatsAppBtn').style.display = _stmEditId ? '' : 'none';
  }

  function _stmOpenOverlay(){ $('stmModalOverlay')?.classList.add('open'); }
  window.invStmCloseModal = function(){
    $('stmModalOverlay')?.classList.remove('open');
    _stmEditId = null; _stmStatus = null;
    _stmItems = []; _stmMeta = {};
  };
  window.invStmModalBgClick = function(ev){
    if (ev.target === ev.currentTarget) window.invStmCloseModal();
  };

  window.invStmFromChanged = function(){
    if (_stmEditId){ _toast('From godown is locked after save', 'warn'); return; }
    _stmFillModalGodowns();
  };
  window.invStmToChanged = function(){
    if (_stmEditId){ _toast('To godown is locked after save', 'warn'); return; }
    _stmFillModalGodowns();
  };

  // ═══════════════════════════════════════════════════════════════════
  // ITEMS GRID
  // ═══════════════════════════════════════════════════════════════════
  function _stmRenderItems(){
    const body = $('stmItemsBody');
    if (!body) return;
    const editable = (_stmStatus === 'out_started');
    if (!_stmItems.length){
      body.innerHTML = `<tr><td colspan="8" class="no-data">No items yet — click <strong>+ Add Item</strong> below</td></tr>`;
      return;
    }
    body.innerHTML = _stmItems.map((it, idx) => _stmRenderItemRow(it, idx, editable)).join('');
  }

  function _stmRenderItemRow(it, idx, editable){
    if (!editable){
      return `<tr>
        <td class="muted">${idx+1}</td>
        <td>${_esc(it.material_name || '—')}</td>
        <td style="text-align:right">${_fmtQty(it.num_pkgs)}</td>
        <td style="text-align:right">${_fmtQty(it.per_pkg_qty, it.uom)}</td>
        <td style="text-align:right"><strong>${_fmtQty(it.total_qty, it.uom)}</strong></td>
        <td>${_esc(it.uom || '—')}</td>
        <td>${_esc(it.remarks || '—')}</td>
        <td></td>
      </tr>`;
    }
    return `<tr data-row="${idx}">
      <td class="muted">${idx+1}</td>
      <td style="position:relative">
        <input type="text" class="stm-cell stm-mat-input"
               value="${_esc(it.material_name)}"
               data-row="${idx}"
               placeholder="Type to search material…"
               oninput="invStmMatInput(${idx}, this)"
               onfocus="invStmMatInput(${idx}, this)"
               onkeydown="invStmMatKey(event, ${idx})"
               onblur="setTimeout(()=>invStmMatBlur(${idx}),200)"
               autocomplete="off">
        <div class="stm-mat-dd" id="stm-mat-dd-${idx}"></div>
      </td>
      <td><input type="number" min="0" step="0.001"
                 class="stm-cell stm-num-right"
                 value="${it.num_pkgs}"
                 oninput="invStmCellChange(${idx},'num_pkgs',this.value)"></td>
      <td><input type="number" min="0" step="0.001"
                 class="stm-cell stm-num-right"
                 value="${it.per_pkg_qty}"
                 oninput="invStmCellChange(${idx},'per_pkg_qty',this.value)"></td>
      <td><input type="number" min="0" step="0.001"
                 class="stm-cell stm-num-right stm-total"
                 value="${it.total_qty}"
                 oninput="invStmCellChange(${idx},'total_qty',this.value)"
                 title="Auto = num_pkgs × per_pkg_qty (you can override)"></td>
      <td><div class="stm-uom-static" id="stm-uom-${idx}"
              title="UOM is set from the material master and cannot be changed here">${_esc(it.uom || '—')}</div></td>
      <td><input type="text" class="stm-cell"
                 value="${_esc(it.remarks)}"
                 oninput="invStmCellChange(${idx},'remarks',this.value)"
                 placeholder="Optional"></td>
      <td class="td-center">
        <button class="trm-pkg-del" onclick="invStmRemoveItem(${idx})" title="Remove row">×</button>
      </td>
    </tr>`;
  }

  window.invStmAddItem = function(){
    _stmItems.push(_stmBlankItem());
    _stmRenderItems();
    _stmRecomputeTotals();
    setTimeout(() => {
      const inputs = document.querySelectorAll('.stm-mat-input');
      if (inputs.length) inputs[inputs.length-1].focus();
    }, 40);
  };

  window.invStmRemoveItem = function(idx){
    _stmItems.splice(idx, 1);
    _stmRenderItems();
    _stmRecomputeTotals();
  };

  window.invStmCellChange = function(idx, field, val){
    if (!_stmItems[idx]) return;
    _stmItems[idx][field] = val;
    if (field === 'num_pkgs' || field === 'per_pkg_qty'){
      const n = parseFloat(_stmItems[idx].num_pkgs)    || 0;
      const p = parseFloat(_stmItems[idx].per_pkg_qty) || 0;
      const computed = +(n * p).toFixed(3);
      _stmItems[idx].total_qty = computed > 0 ? String(computed) : '';
      const row = document.querySelector(`#stmItemsBody tr[data-row="${idx}"]`);
      if (row){
        const totalInp = row.querySelector('.stm-total');
        if (totalInp) totalInp.value = _stmItems[idx].total_qty;
      }
    }
    _stmRecomputeTotals();
  };

  function _stmRecomputeTotals(){
    const items = _stmItems;
    const totalPkgs = items.reduce((s,it) => s + (parseFloat(it.num_pkgs) || 0), 0);
    const totalQty  = items.reduce((s,it) => s + (parseFloat(it.total_qty) || 0), 0);
    $('stmTotItems').textContent = _fmtNum(items.length);
    $('stmTotPkgs').textContent  = _fmtQty(totalPkgs);
    $('stmTotQty').textContent   = _fmtQty(totalQty);
  }

  // ═══════════════════════════════════════════════════════════════════
  // MATERIAL TYPEAHEAD (arrow keys + Enter, auto-fetch UOM)
  // ═══════════════════════════════════════════════════════════════════
  function _stmRenderMatDropdown(idx){
    const dd = $('stm-mat-dd-' + idx);
    if (!dd) return;
    const rows = _stmMatRows[idx] || [];
    if (!rows.length){
      dd.innerHTML = `<div class="stm-dd-item stm-dd-empty">No matches</div>`;
      return;
    }
    const hi = _stmMatHighlight[idx];
    dd.innerHTML = rows.map((m, i) => `
      <div class="stm-dd-item${i === hi ? ' active' : ''}"
           data-hit="${i}"
           onmousedown="invStmMatPick(${idx}, ${i})"
           onmouseenter="invStmMatHover(${idx}, ${i})">
        <strong>${_esc(m.material_name)}</strong>
        ${m.uom ? `<span class="stm-dd-uom">${_esc(m.uom)}</span>` : ''}
      </div>
    `).join('');
    if (hi >= 0){
      const cur = dd.querySelector('.stm-dd-item.active');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  window.invStmMatInput = async function(idx, inp){
    const q = (inp.value || '').trim();
    const dd = $('stm-mat-dd-' + idx);
    if (!dd) return;
    const cur = _stmItems[idx];
    if (cur && cur.material_id && cur.material_name && q !== cur.material_name){
      cur.material_id = null;
      cur.material_name = q;
      cur.uom = '';
      const uomCell = $('stm-uom-' + idx);
      if (uomCell) uomCell.textContent = '—';
    } else if (cur){
      cur.material_name = q;
    }
    if (q.length < 1 && !inp._stmShowAll){
      dd.style.display = 'none'; return;
    }
    try {
      const r = await fetch('/api/inventory_simple_transfer/materials/search?q=' +
                            encodeURIComponent(q) + '&limit=30');
      const j = await r.json();
      const rows = (j.status === 'ok') ? (j.materials || []) : [];
      _stmMatRows[idx] = rows;
      _stmMatHighlight[idx] = rows.length ? 0 : -1;
      _stmRenderMatDropdown(idx);
      dd.style.display = 'block';
    } catch(e){
      dd.innerHTML = `<div class="stm-dd-item stm-dd-empty">⚠ ${_esc(e.message||'Search failed')}</div>`;
      dd.style.display = 'block';
    }
  };

  window.invStmMatKey = function(ev, idx){
    const dd = $('stm-mat-dd-' + idx);
    const open = dd && dd.style.display !== 'none';
    const rows = _stmMatRows[idx] || [];
    if (ev.key === 'ArrowDown'){
      ev.preventDefault();
      if (!open || !rows.length) return;
      const c = _stmMatHighlight[idx];
      _stmMatHighlight[idx] = (c < 0 || c >= rows.length - 1) ? 0 : c + 1;
      _stmRenderMatDropdown(idx); return;
    }
    if (ev.key === 'ArrowUp'){
      ev.preventDefault();
      if (!open || !rows.length) return;
      const c = _stmMatHighlight[idx];
      _stmMatHighlight[idx] = (c <= 0) ? rows.length - 1 : c - 1;
      _stmRenderMatDropdown(idx); return;
    }
    if (ev.key === 'Enter'){
      ev.preventDefault();
      if (!open || !rows.length) return;
      const hi = _stmMatHighlight[idx];
      if (hi >= 0 && hi < rows.length) window.invStmMatPick(idx, hi);
      return;
    }
    if (ev.key === 'Escape'){
      if (!open) return;
      ev.preventDefault();
      dd.style.display = 'none';
      _stmMatHighlight[idx] = -1; return;
    }
    if (ev.key === 'Tab' && open) dd.style.display = 'none';
  };

  window.invStmMatHover = function(idx, hitIdx){
    if (_stmMatHighlight[idx] !== hitIdx){
      _stmMatHighlight[idx] = hitIdx;
      _stmRenderMatDropdown(idx);
    }
  };

  window.invStmMatBlur = function(idx){
    const dd = $('stm-mat-dd-' + idx);
    if (dd) dd.style.display = 'none';
  };

  window.invStmMatPick = function(idx, hitIdx){
    const rows = _stmMatRows[idx] || [];
    const m = rows[hitIdx];
    if (!m) return;
    _stmItems[idx].material_id   = m.id;
    _stmItems[idx].material_name = m.material_name;
    _stmItems[idx].uom = m.uom || '';
    const dd = $('stm-mat-dd-' + idx);
    if (dd) dd.style.display = 'none';
    _stmMatHighlight[idx] = -1;
    _stmRenderItems();
    _stmRecomputeTotals();
    setTimeout(() => {
      const row = document.querySelector(`#stmItemsBody tr[data-row="${idx}"]`);
      if (!row) return;
      const numInp = row.querySelectorAll('.stm-num-right')[0];
      if (numInp){ numInp.focus(); numInp.select(); }
    }, 30);
  };

  // ═══════════════════════════════════════════════════════════════════
  // SAVE
  // ═══════════════════════════════════════════════════════════════════
  window.invStmSave = async function(){
    if (_stmStatus !== 'out_started'){ _toast('Voucher is not editable', 'warn'); return; }
    const fromId = parseInt($('stmFromGodown').value) || 0;
    const toId   = parseInt($('stmToGodown').value)   || 0;
    if (!fromId || !toId){ _toast('Pick both From and To godowns', 'warn'); return; }
    if (fromId === toId){ _toast('From and To must be different', 'warn'); return; }
    if (!_stmItems.length){ _toast('Add at least one item', 'warn'); return; }
    const cleaned = [];
    for (let i = 0; i < _stmItems.length; i++){
      const it = _stmItems[i];
      if (!it.material_id){ _toast(`Item ${i+1}: pick a material`, 'warn'); return; }
      const np = parseFloat(it.num_pkgs)    || 0;
      const pp = parseFloat(it.per_pkg_qty) || 0;
      let   tq = parseFloat(it.total_qty)   || 0;
      if (tq <= 0) tq = +(np * pp).toFixed(3);
      if (tq <= 0){ _toast(`Item ${i+1}: total qty must be > 0`, 'warn'); return; }
      cleaned.push({
        material_id: it.material_id,
        num_pkgs: np, per_pkg_qty: pp, total_qty: tq,
        uom: (it.uom || '').trim() || null,
        remarks: (it.remarks || '').trim() || null,
        line_no: i + 1,
      });
    }
    const body = {
      voucher_id: _stmEditId || 0,
      voucher_date: $('stmDate').value || new Date().toISOString().slice(0,10),
      from_godown_id: fromId, to_godown_id: toId,
      remarks: ($('stmRemarks').value || '').trim(),
      items: cleaned,
    };
    const btn = $('stmSaveBtn');
    const orig = btn?.innerHTML;
    if (btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }
    try {
      const r = await fetch('/api/inventory_simple_transfer/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Save failed', 'error'); return; }
      _toast(j.created ? 'Voucher created' : 'Voucher updated', 'ok');
      await window.invStmLoadList();
      await window.invStmOpenExisting(j.voucher_id);
    } catch(e){
      _toast(e.message || e, 'error');
    } finally {
      if (btn){ btn.disabled = false; btn.innerHTML = orig; }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SUBMIT / CONFIRM / CANCEL
  // ═══════════════════════════════════════════════════════════════════
  window.invStmSubmitOut = async function(){
    if (!_stmEditId){ _toast('Save the voucher first', 'warn'); return; }
    if (!confirm(`Submit OUT? Stock will be debited from the source godown and marked in-transit.`)) return;
    const btn = $('stmSubmitOutBtn'); if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/inventory_simple_transfer/${_stmEditId}/submit_out`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Submit failed', 'error'); return; }
      _toast('OUT submitted — voucher is now IN TRANSIT', 'ok');
      await window.invStmLoadList();
      await window.invStmOpenExisting(_stmEditId);
      invStmSwitchPillTab('in');
    } catch(e){
      _toast(e.message || e, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.invStmConfirmIn = async function(){
    if (!_stmEditId) return;
    if (!confirm(`Confirm receipt at destination? Stock will be credited to the destination godown.`)) return;
    const btn = $('stmConfirmInBtn'); if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/inventory_simple_transfer/${_stmEditId}/confirm_receipt`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Confirm failed', 'error'); return; }
      _toast(`Receipt confirmed — ${j.items_count} item(s) received`, 'ok');
      await window.invStmLoadList();
      await window.invStmOpenExisting(_stmEditId);
    } catch(e){
      _toast(e.message || e, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.invStmCancelCurrent = async function(){
    if (!_stmEditId) return;
    const reason = prompt('Reason for cancelling? (optional)') || '';
    if (reason === null) return;
    if (!confirm(`Cancel this voucher? Any inventory movements will be reversed.`)) return;
    try {
      const r = await fetch(`/api/inventory_simple_transfer/${_stmEditId}/cancel`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ reason })
      });
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Cancel failed', 'error'); return; }
      _toast(`Cancelled — ${j.reversed_count} movement(s) reversed`, 'ok');
      window.invStmCloseModal();
      await window.invStmLoadList();
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // PRINT + WHATSAPP
  // ═══════════════════════════════════════════════════════════════════
  window.invStmPrint = async function(voucherId){
    voucherId = voucherId || _stmEditId;
    if (!voucherId){ _toast('No voucher to print', 'warn'); return; }
    try {
      const r = await fetch('/api/inventory_simple_transfer/' + voucherId + '/print_data');
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'Print failed', 'error'); return; }
      const html = _stmBuildPrintHTML(j.voucher, j.company || {});
      const w = window.open('', '_blank', 'width=900,height=1100');
      if (!w){ _toast('Popup blocked — allow popups for this site', 'error'); return; }
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.onload = () => setTimeout(() => w.print(), 250);
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };

  function _stmBuildPrintHTML(v, company){
    const companyName = (company.name || 'HCP Wellness Pvt Ltd');
    const itemsRows = (v.items || []).map((it, i) => `
      <tr>
        <td style="text-align:center">${i+1}</td>
        <td>${_esc(it.material_name)}</td>
        <td style="text-align:right">${_fmtQty(it.num_pkgs)}</td>
        <td style="text-align:right">${_fmtQty(it.per_pkg_qty)} ${_esc(it.uom||'')}</td>
        <td style="text-align:right"><strong>${_fmtQty(it.total_qty)} ${_esc(it.uom||'')}</strong></td>
        <td>${_esc(it.remarks || '')}</td>
      </tr>
    `).join('');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${_esc(v.voucher_no)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color:#111; margin:0; padding:0; font-size:12px; }
  .v-wrap { max-width:780px; margin:0 auto; padding:20px; }
  .v-head { display:flex; justify-content:space-between; align-items:flex-start;
            border-bottom:2.5px solid #111; padding-bottom:10px; margin-bottom:14px; }
  .v-company { font-size:20px; font-weight:800; letter-spacing:.4px; }
  .v-title  { font-size:14px; font-weight:700; color:#444; margin-top:2px; }
  .v-meta-tbl { font-size:11.5px; text-align:right; }
  .v-meta-tbl td { padding:1px 6px 1px 0; }
  .v-meta-tbl td:first-child { color:#666; font-weight:600; text-transform:uppercase; font-size:9.5px; letter-spacing:.5px; }
  .v-route { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:12px; }
  .v-rb { padding:8px 10px; border:1px solid #ccc; border-radius:4px; }
  .v-rb .l { font-size:9.5px; color:#666; font-weight:700; text-transform:uppercase; letter-spacing:.5px; }
  .v-rb .v { font-size:13px; font-weight:700; margin-top:2px; }
  .v-rb .a { font-size:10.5px; color:#555; margin-top:2px; }
  table.v-items { width:100%; border-collapse:collapse; margin-top:8px; }
  table.v-items th { background:#f3f4f6; font-size:10.5px; color:#222; text-transform:uppercase;
                     letter-spacing:.4px; padding:7px 8px; border:1px solid #ccc; text-align:left; }
  table.v-items td { padding:7px 8px; border:1px solid #ddd; font-size:11.5px; }
  table.v-items tfoot td { background:#fafafa; font-weight:800; font-size:12.5px; }
  .v-remarks { margin-top:12px; padding:8px 10px; border:1px dashed #ccc; font-size:11px; color:#444; }
  .v-sign { display:grid; grid-template-columns:1fr 1fr 1fr; gap:20px; margin-top:50px; }
  .v-sign .box { border-top:1px solid #555; padding-top:6px; font-size:10.5px; color:#444; text-align:center; }
  .v-status { display:inline-block; padding:2px 8px; border:1px solid #555; border-radius:10px;
              font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
  <div class="v-wrap">
    <div class="v-head">
      <div>
        <div class="v-company">${_esc(companyName)}</div>
        <div class="v-title">Stock Transfer Voucher (Simple)</div>
      </div>
      <table class="v-meta-tbl"><tbody>
        <tr><td>Voucher No.</td><td><strong>${_esc(v.voucher_no)}</strong></td></tr>
        <tr><td>Date</td><td>${_fmtDateShort(v.voucher_date)}</td></tr>
        <tr><td>Status</td><td><span class="v-status">${_esc((v.status||'').toUpperCase())}</span></td></tr>
      </tbody></table>
    </div>
    <div class="v-route">
      <div class="v-rb"><div class="l">From godown</div>
        <div class="v">${_esc(v.from_godown_name || '—')}</div>
        ${v.from_godown_address ? `<div class="a">${_esc(v.from_godown_address)}</div>` : ''}</div>
      <div class="v-rb"><div class="l">To godown</div>
        <div class="v">${_esc(v.to_godown_name || '—')}</div>
        ${v.to_godown_address ? `<div class="a">${_esc(v.to_godown_address)}</div>` : ''}</div>
    </div>
    <table class="v-items">
      <thead><tr>
        <th style="width:32px;text-align:center">#</th>
        <th>Material</th>
        <th style="width:80px;text-align:right">No. of Pkg</th>
        <th style="width:110px;text-align:right">Per Pkg Qty</th>
        <th style="width:110px;text-align:right">Total Qty</th>
        <th>Remarks</th>
      </tr></thead>
      <tbody>${itemsRows || '<tr><td colspan="6" style="text-align:center;color:#888">No items</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="2" style="text-align:right">TOTALS</td>
        <td style="text-align:right">${_fmtQty(v.total_pkgs)}</td>
        <td></td>
        <td style="text-align:right">${_fmtQty(v.total_qty)}</td>
        <td></td>
      </tr></tfoot>
    </table>
    ${v.remarks ? `<div class="v-remarks"><strong>Remarks:</strong> ${_esc(v.remarks)}</div>` : ''}
    <div class="v-sign">
      <div class="box">Prepared By<br><small>${_esc(v.created_by || '—')}</small></div>
      <div class="box">Issued By<br><small>${_esc(v.out_by || '—')}</small></div>
      <div class="box">Received By<br><small>${_esc(v.in_by || '—')}</small></div>
    </div>
  </div>
</body></html>`;
  }

  window.invStmWhatsApp = async function(voucherId){
    voucherId = voucherId || _stmEditId;
    if (!voucherId){ _toast('No voucher to share', 'warn'); return; }
    try {
      const r = await fetch('/api/inventory_simple_transfer/' + voucherId + '/whatsapp_text');
      const j = await r.json();
      if (j.status !== 'ok'){ _toast(j.message || 'WhatsApp text not available', 'error'); return; }
      const url = 'https://web.whatsapp.com/send?text=' + encodeURIComponent(j.text || '');
      window.open(url, '_blank');
    } catch(e){
      _toast(e.message || e, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // INJECTED MARKUP
  // ═══════════════════════════════════════════════════════════════════
  const _STM_PANEL_HTML = `
    <!-- PM-style internal pill tabs (reuses .tr-pill / .tr-pill-pane CSS
         from _transfers.html — same look, separate state). -->
    <div class="tr-pills" id="stm-pills">
      <button class="tr-pill active" data-tab="out"
              onclick="invStmSwitchPillTab('out')">
        <span class="icon">📤</span> Material OUT
      </button>
      <button class="tr-pill" data-tab="in"
              onclick="invStmSwitchPillTab('in')">
        <span class="icon">📥</span> Material IN
        <span class="count" id="stm-pill-in-count" style="display:none">0</span>
      </button>
      <button class="tr-pill" data-tab="history"
              onclick="invStmSwitchPillTab('history')">
        <span class="icon">🗂</span> History
      </button>
    </div>

    <!-- ═══ MATERIAL OUT PANE ═══════════════════════════════════════ -->
    <div id="stm-pane-out" class="tr-pill-pane active">

      <!-- Create-new card — picks godowns, opens the item-grid modal -->
      <div class="tr-create-card">
        <div class="tr-create-head">
          <span class="tr-create-title">📋 Create new simple voucher</span>
          <span style="font-size:10.5px;color:#9ca3af;font-weight:600">
            Pick from + to, then add items in the modal that opens.
          </span>
        </div>
        <div class="tr-create-grid">
          <div>
            <label>From godown <span style="color:#dc2626">*</span></label>
            <select id="stm-create-from"><option value="">— select —</option></select>
          </div>
          <div>
            <label>To godown <span style="color:#dc2626">*</span></label>
            <select id="stm-create-to"><option value="">— select —</option></select>
          </div>
          <div>
            <label>Remarks</label>
            <input type="text" id="stm-create-remarks"
                   placeholder="Optional…" maxlength="255">
          </div>
          <div>
            <label>&nbsp;</label>
            <button class="tr-create-btn" onclick="invStmCreateNewClick()"
                    style="background:#4f46e5">
              <i class="fas fa-plus"></i> New voucher
            </button>
          </div>
        </div>
      </div>

      <div class="tr-section-title">
        Pending drafts (not yet submitted)
        <span class="tr-section-meta" id="stm-out-pending-meta">—</span>
      </div>
      <div class="inv-table-wrap">
        <div class="inv-table-scroll">
          <table class="inv-table">
            <thead><tr>
              <th style="width:50px">#</th>
              <th style="width:170px">Voucher no.</th>
              <th style="width:110px">Date</th>
              <th>From godown</th>
              <th>To godown</th>
              <th style="width:80px;text-align:right">Items</th>
              <th style="width:120px;text-align:right">Total qty</th>
              <th style="width:110px" class="td-center">Edit</th>
              <th style="width:80px" class="td-center">Share</th>
            </tr></thead>
            <tbody id="stm-out-pending-body">
              <tr><td colspan="9" class="no-data">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ═══ MATERIAL IN PANE ════════════════════════════════════════ -->
    <div id="stm-pane-in" class="tr-pill-pane">
      <div class="tr-section-title">
        <span class="pulse"></span>
        In transit — awaiting receipt at destination
        <span class="tr-section-meta" id="stm-it-meta">—</span>
      </div>
      <div class="tr-it-grid" id="stm-it-grid">
        <div class="no-data" style="grid-column:1 / -1;text-align:center;
                                    color:#9ca3af;font-style:italic;
                                    padding:40px 12px">
          Loading…
        </div>
      </div>
    </div>

    <!-- ═══ HISTORY PANE ════════════════════════════════════════════ -->
    <div id="stm-pane-history" class="tr-pill-pane">
      <div class="tr-hist-toolbar">
        <div class="search">
          <input type="search" id="stm-hist-search"
                 placeholder="Search by voucher #, godown, remarks…"
                 oninput="invStmRenderHistory()">
        </div>
        <div>
          <select id="stm-hist-status-filter"
                  onchange="invStmRenderHistory()"
                  style="padding:7px 10px;border:1px solid #d1d5db;
                         border-radius:6px;font-size:12px;background:#fff">
            <option value="">All completed</option>
            <option value="received">Received only</option>
            <option value="cancelled">Cancelled only</option>
          </select>
        </div>
        <div style="margin-left:auto;font-size:10.5px;color:#9ca3af;font-weight:600"
             id="stm-hist-meta">—</div>
      </div>
      <div class="inv-table-wrap">
        <div class="inv-table-scroll">
          <table class="inv-table">
            <thead><tr>
              <th style="width:50px">#</th>
              <th style="width:170px">Voucher no.</th>
              <th style="width:110px">Date</th>
              <th>From godown</th>
              <th>To godown</th>
              <th style="width:80px;text-align:right">Items</th>
              <th style="width:120px;text-align:right">Total qty</th>
              <th style="width:110px">Status</th>
              <th style="width:60px" class="td-center">View</th>
              <th style="width:80px" class="td-center">Share</th>
            </tr></thead>
            <tbody id="stm-hist-body">
              <tr><td colspan="10" class="no-data">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Modal HTML + scoped CSS (items grid + typeahead dropdown)
  // ────────────────────────────────────────────────────────────────
  // DEFENSIVE CSS — injected directly via a <style> element in
  // bootstrap so that even on a stale templates/_transfers.html the
  // Simple Voucher panel renders with the correct PM-style layout.
  // Identical to the rules already in _transfers.html — duplicates
  // are harmless (same property, same value, no conflict).
  // ────────────────────────────────────────────────────────────────
  const _STM_DEFENSIVE_CSS = `
/* ──────────────────────────────────────────────────────────────
   DEFENSIVE PANEL CSS
   These rules duplicate the layout styles defined in
   templates/inventory/_transfers.html (tr-pill, tr-pill-pane,
   tr-create-card, tr-section-title, tr-it-grid, tr-it-card,
   tr-hist-toolbar, tr-status-badge). If the user has updated
   this JS file but not yet deployed the new _transfers.html, the
   Simple Voucher panel still renders correctly. When the new
   _transfers.html IS deployed, these rules harmlessly duplicate
   it (identical declarations — no override conflicts).
────────────────────────────────────────────────────────────── */
.tr-pills{
  display:inline-flex; gap:4px;
  background:#f1f5f9; padding:4px;
  border-radius:10px; margin-bottom:14px;
}
.tr-pill{
  display:inline-flex; align-items:center; gap:6px;
  padding:8px 18px;
  font-size:12px; font-weight:800;
  color:#6b7280; background:transparent;
  border:none; border-radius:7px;
  cursor:pointer; font-family:inherit;
  transition:all .12s;
}
.tr-pill:hover{ color:#111; background:rgba(0,0,0,.04); }
.tr-pill.active{
  background:#0d9488; color:#fff;
  box-shadow:0 1px 3px rgba(13,148,136,.25);
}
.tr-pill .icon{ font-size:11px; }
.tr-pill .count{
  display:inline-flex; align-items:center; justify-content:center;
  min-width:18px; height:16px; padding:0 6px;
  border-radius:9px;
  background:#f59e0b; color:#fff;
  font-size:9px; font-weight:800;
}
.tr-pill.active .count{ background:rgba(255,255,255,.25); }
.tr-pill-pane{ display:none; }
.tr-pill-pane.active{ display:block; }

.tr-create-card{
  background:#fff; border:1.5px solid #e5e7eb;
  border-radius:10px; padding:14px 18px;
  margin-bottom:18px;
  box-shadow:0 1px 3px rgba(0,0,0,.04);
}
.tr-create-head{
  display:flex; align-items:center; gap:10px;
  margin-bottom:12px;
}
.tr-create-title{
  font-size:13px; font-weight:800; color:#111;
}
.tr-create-grid{
  display:grid; grid-template-columns:1fr 1fr 2fr auto;
  gap:10px; align-items:end;
}
@media (max-width:760px){
  .tr-create-grid{ grid-template-columns:1fr; }
}
.tr-create-grid label{
  font-size:10px; font-weight:800; color:#6b7280;
  text-transform:uppercase; letter-spacing:.4px;
  display:block; margin-bottom:4px;
}
.tr-create-grid select,
.tr-create-grid input{
  width:100%; padding:8px 11px; font-size:12.5px;
  background:#fff;
  border:1.5px solid #d1d5db; border-radius:7px;
  outline:none; box-sizing:border-box; font-weight:600;
}
.tr-create-grid select:focus,
.tr-create-grid input:focus{
  border-color:#0d9488;
  box-shadow:0 0 0 3px rgba(13,148,136,.10);
}
.tr-create-btn{
  background:#0d9488; color:#fff;
  border:none; border-radius:7px;
  padding:9px 18px;
  font-size:12px; font-weight:800;
  cursor:pointer; white-space:nowrap;
  font-family:inherit;
}
.tr-create-btn:hover{ background:#0f766e; }
.tr-create-btn:disabled{ background:#9ca3af; cursor:not-allowed; }

.tr-section-title{
  font-size:12px; font-weight:800; color:#111;
  margin:14px 0 8px;
  display:flex; align-items:center; gap:8px;
  text-transform:uppercase; letter-spacing:.4px;
}
.tr-section-title .pulse{
  display:inline-block; width:8px; height:8px;
  border-radius:50%; background:#f59e0b;
  animation:trPulseStm 1.4s infinite;
}
@keyframes trPulseStm{
  0%,100%{ opacity:1; transform:scale(1); }
  50%    { opacity:.4; transform:scale(1.3); }
}
.tr-section-meta{
  margin-left:auto;
  font-size:10.5px; color:#9ca3af; font-weight:600;
  text-transform:none; letter-spacing:0;
}

.tr-it-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:10px;
}
.tr-it-card{
  display:flex; align-items:center; gap:12px;
  padding:12px 14px;
  background:linear-gradient(135deg,#fff7ed,#ffedd5);
  border:1.5px solid #fdba74;
  border-radius:10px;
  cursor:pointer; transition:all .15s;
}
.tr-it-card:hover{
  border-color:#f59e0b;
  box-shadow:0 2px 10px rgba(245,158,11,.22);
  transform:translateY(-1px);
}
.tr-it-card .icon{ font-size:22px; }
.tr-it-card .info{ flex:1; min-width:0; }
.tr-it-card .num{
  font-size:12.5px; font-weight:800; color:#111;
  font-family:'JetBrains Mono',monospace;
}
.tr-it-card .route{
  font-size:11px; color:#6b7280; margin-top:2px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.tr-it-card .meta{ font-size:10px; color:#9ca3af; margin-top:2px; }
.tr-it-card .boxes{ text-align:right; }
.tr-it-card .boxes .lbl{
  font-size:9px; color:#9ca3af; font-weight:700;
  text-transform:uppercase; letter-spacing:.4px;
}
.tr-it-card .boxes .val{
  font-size:18px; font-weight:800; color:#c2410c;
  font-family:'JetBrains Mono',monospace;
}

.tr-hist-toolbar{
  display:flex; gap:8px; align-items:center;
  flex-wrap:wrap; margin-bottom:12px;
}
.tr-hist-toolbar .search{
  flex:1; min-width:200px; max-width:360px;
}
.tr-hist-toolbar input[type="search"],
.tr-hist-toolbar input[type="date"]{
  width:100%; padding:7px 10px;
  border:1px solid #d1d5db; border-radius:6px;
  font-size:12px; box-sizing:border-box;
}

/* Status badges (used in History table) */
.tr-status-badge{
  display:inline-block; padding:3px 10px;
  border-radius:14px; font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:.5px;
}
.tr-status-out_started{ background:#fff7ed; color:#9a3412; border:1px solid #fdba74; }
.tr-status-in_pending  { background:#fef3c7; color:#92400e; border:1px solid #fcd34d; }
.tr-status-received    { background:#dcfce7; color:#15803d; border:1px solid #86efac; }
.tr-status-cancelled   { background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; }
.tr-status-draft       { background:#f3f4f6; color:#374151; border:1px solid #d1d5db; }
.tr-status-posted      { background:#dbeafe; color:#1e40af; border:1px solid #93c5fd; }

/* ──────────────────────────────────────────────────────────────
   MODAL CSS (also defined in _transfers.html — same defensive
   strategy. Critical for the items grid + typeahead to render
   even on a stale template).
────────────────────────────────────────────────────────────── */
.trm-overlay{
  position:fixed; inset:0;
  background:rgba(15,23,42,.55);
  display:none;
  align-items:flex-start; justify-content:center;
  z-index:1050; padding:20px;
  overflow-y:auto;
}
.trm-overlay.open{ display:flex; }
.trm-modal{
  background:#fff;
  width:min(98vw,1400px); max-width:1400px;
  max-height:calc(100vh - 40px);
  border-radius:14px;
  display:flex; flex-direction:column;
  overflow:hidden;
  box-shadow:0 24px 64px rgba(0,0,0,.35);
}
.trm-head{
  padding:14px 20px;
  border-bottom:2.5px solid #92400e;
  background:linear-gradient(135deg,#92400e 0%,#b45309 100%);
  color:#fff; flex-shrink:0;
}
.trm-modal.mode-in .trm-head{
  border-bottom-color:#1e40af;
  background:linear-gradient(135deg,#1e40af 0%,#3b82f6 100%);
}
.trm-modal.mode-done .trm-head{
  border-bottom-color:#15803d;
  background:linear-gradient(135deg,#15803d 0%,#22c55e 100%);
}
.trm-modal.mode-cancelled .trm-head{
  border-bottom-color:#b91c1c;
  background:linear-gradient(135deg,#b91c1c 0%,#dc2626 100%);
}
.trm-head-row{ display:flex; align-items:center; justify-content:space-between; gap:14px; }
.trm-head-title-lbl{ font-size:11px; font-weight:700; opacity:.85; letter-spacing:.5px; text-transform:uppercase; }
.trm-head-vno{ font-size:18px; font-weight:900; font-family:monospace; margin-top:2px; }
.trm-head-route{ text-align:right; }
.trm-head-route .l{ font-size:10px; opacity:.85; margin-top:2px; }
.trm-head-route .l strong{ font-weight:800; }
.trm-close{
  background:rgba(255,255,255,.2); color:#fff;
  border:1px solid rgba(255,255,255,.3);
  border-radius:6px; width:32px; height:32px;
  font-size:18px; cursor:pointer; flex-shrink:0; line-height:1;
}
.trm-close:hover{ background:rgba(255,255,255,.3); }
.trm-body{ padding:14px 20px; overflow-y:auto; flex:1; }
.trm-banner{
  padding:8px 12px; border-radius:5px;
  border-left:3px solid #f59e0b;
  background:rgba(245,158,11,.10);
  color:#92400e; font-size:12px; font-weight:700;
  margin-bottom:14px;
}
.trm-modal.mode-in .trm-banner{ border-left-color:#3b82f6; background:rgba(59,130,246,.10); color:#1e40af; }
.trm-modal.mode-done .trm-banner{ border-left-color:#22c55e; background:rgba(34,197,94,.10); color:#15803d; }
.trm-modal.mode-cancelled .trm-banner{ border-left-color:#dc2626; background:rgba(220,38,38,.10); color:#b91c1c; }
.trm-form-row{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:14px; }
.trm-form-row.full{ grid-template-columns:1fr; }
@media (max-width:760px){ .trm-form-row{ grid-template-columns:1fr; } }
.trm-field label{
  font-size:10px; font-weight:800; color:#6b7280;
  text-transform:uppercase; letter-spacing:.5px;
  display:block; margin-bottom:5px;
}
.trm-field label .req{ color:#dc2626; }
.trm-field input, .trm-field select{
  width:100%; padding:9px 12px; font-size:13.5px;
  border:1.5px solid #d1d5db; border-radius:7px;
  box-sizing:border-box; outline:none; font-weight:600;
}
.trm-field input:focus, .trm-field select:focus{
  border-color:#4f46e5;
  box-shadow:0 0 0 3px rgba(79,70,229,.08);
}
.trm-field input:disabled, .trm-field select:disabled{
  background:#f9fafb; cursor:not-allowed; color:#6b7280;
}
.trm-totals{
  display:grid; grid-template-columns:1fr 1fr 1fr;
  gap:8px; margin-bottom:10px;
}
.trm-tot{
  padding:10px 14px; border-radius:6px;
  background:rgba(146,64,14,.06);
  border:1px solid rgba(146,64,14,.2);
}
.trm-tot.t-qty{ background:rgba(13,148,136,.06); border-color:rgba(13,148,136,.2); }
.trm-tot .lbl{ font-size:9px; font-weight:800; color:#92400e; text-transform:uppercase; letter-spacing:.4px; }
.trm-tot.t-qty .lbl{ color:#0d9488; }
.trm-tot .val{ font-size:18px; font-weight:800; color:#92400e; font-family:'JetBrains Mono',monospace; }
.trm-tot.t-qty .val{ color:#0d9488; }
.trm-packages-wrap{
  border:1px solid #e5e7eb; border-radius:8px;
  background:#fff; overflow:hidden;
}
.trm-packages-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:9px 14px;
  background:#f9fafb; border-bottom:1px solid #e5e7eb;
  font-weight:700; font-size:12.5px; color:#374151;
}
.trm-pkg-del{
  border:none; background:transparent; color:#dc2626;
  cursor:pointer; font-size:16px; padding:3px 8px;
  border-radius:4px; line-height:1;
}
.trm-pkg-del:hover{ background:#fee2e2; }
.trm-foot{
  display:flex; align-items:center; gap:10px;
  padding:14px 20px;
  background:#fafbfc; border-top:1px solid #e5e7eb;
  flex-shrink:0;
}
.trm-foot .btn{ padding:9px 18px; }
.trm-spacer{ flex:1; }

/* ─── Items grid (Simple Voucher specific) ─────────────────── */
.stm-items-tbl{ width:100%; border-collapse:collapse; font-size:12.5px; }
.stm-items-tbl thead th{
  background:#fafbfc; border-bottom:1px solid #e5e7eb;
  padding:8px 10px; font-weight:700; font-size:10.5px;
  color:#374151; text-transform:uppercase; letter-spacing:.4px;
  text-align:left; white-space:nowrap;
}
.stm-items-tbl tbody td{
  padding:5px 8px; border-bottom:1px solid #f3f4f6; vertical-align:middle;
}
.stm-items-tbl tbody tr:last-child td{ border-bottom:none; }
.stm-items-tbl .no-data{ text-align:center; color:#9ca3af; font-style:italic; padding:24px 8px; }
.stm-items-tbl .muted{ color:#9ca3af; }
.stm-cell{
  width:100%; padding:6px 8px; font-size:12.5px;
  border:1px solid #d1d5db; border-radius:6px;
  outline:none; font-family:inherit; box-sizing:border-box;
  background:#fff; color:#111;
}
.stm-cell:focus{ border-color:#4f46e5; box-shadow:0 0 0 2px rgba(79,70,229,.08); }
.stm-num-right{ text-align:right; font-family:'JetBrains Mono', monospace; font-weight:600; }
.stm-total{ background:#f9fafb; font-weight:700; color:#0d9488; }
.stm-uom-static{
  padding:6px 10px; font-size:12.5px;
  background:#f3f4f6; color:#374151; font-weight:700;
  border:1px solid #e5e7eb; border-radius:6px;
  text-align:center; text-transform:lowercase;
  font-family:'JetBrains Mono', monospace;
  cursor:not-allowed; user-select:none;
  min-height:30px; line-height:18px;
}
.stm-mat-input{ font-weight:600; }
.stm-mat-dd{
  position:absolute; top:100%; left:0; right:0;
  background:#fff; border:1px solid #d1d5db; border-radius:6px;
  box-shadow:0 6px 18px rgba(0,0,0,.12);
  z-index:1100; max-height:240px; overflow-y:auto;
  display:none; margin-top:2px;
}
.stm-dd-item{
  padding:7px 10px; font-size:12.5px; cursor:pointer;
  border-bottom:1px solid #f3f4f6;
  transition:background .08s;
}
.stm-dd-item:last-child{ border-bottom:none; }
.stm-dd-item:hover{ background:#f3f4f6; }
.stm-dd-item.active{ background:#4f46e5 !important; color:#fff !important; }
.stm-dd-item.active .stm-dd-uom{ background:rgba(255,255,255,.22) !important; color:#fff !important; }
.stm-dd-item .stm-dd-uom{
  float:right; font-size:10.5px; color:#6b7280; font-weight:600;
  background:#f3f4f6; padding:1px 6px; border-radius:8px;
}
.stm-dd-empty{ color:#9ca3af; font-style:italic; cursor:default; }
.stm-dd-empty:hover{ background:transparent; }
.stm-add-item-row{ padding:6px 10px; background:#fafbfc; border-top:1px solid #e5e7eb; }
.stm-add-item-row .btn{ font-size:11.5px; padding:5px 11px; }

/* ──────────────────────────────────────────────────────────────────
   COMPACT-MODE OVERRIDES — mirror of the same block in _transfers.html.
   Shrinks every dimension ~30% so the Simple Voucher modal sits well
   on 1440px laptops instead of dominating the screen.
   ────────────────────────────────────────────────────────────────── */
.trm-modal{
  width:min(96vw,1100px); max-width:1100px;
  max-height:calc(100vh - 30px);
  border-radius:10px;
}
.trm-head{ padding:10px 16px; border-bottom-width:2px; }
.trm-head-title-lbl{ font-size:10px; letter-spacing:.4px; }
.trm-head-vno{ font-size:14px; margin-top:1px; }
.trm-head-route{ font-size:11px; }
.trm-head-route .l{ font-size:9.5px; margin-top:1px; }
.trm-close{ width:26px; height:26px; font-size:15px; }
.tr-status-badge{ padding:2px 7px; font-size:9.5px; letter-spacing:.3px; }
.trm-body{ padding:10px 16px; }
.trm-banner{ padding:6px 10px; font-size:11px; margin-bottom:10px; }
.trm-form-row{ gap:10px; margin-bottom:10px; }
.trm-field label{ font-size:9.5px; letter-spacing:.4px; margin-bottom:3px; }
.trm-field input, .trm-field select{
  padding:7px 10px; font-size:12.5px; border-radius:6px;
}
.trm-totals{ gap:6px; margin-bottom:8px; }
.trm-tot{ padding:6px 10px; border-radius:5px; }
.trm-tot .lbl{ font-size:8.5px; letter-spacing:.3px; }
.trm-tot .val{ font-size:14px; }
.trm-packages-wrap{ border-radius:6px; }
.trm-packages-head{ padding:6px 10px; font-size:11px; }
.trm-foot{ padding:8px 16px; gap:8px; }
.trm-foot .btn{ padding:6px 13px; font-size:12px; }

/* Items table inside Simple Voucher modal — tighter rows */
.stm-items-tbl thead th{ padding:6px 8px; font-size:9.5px; letter-spacing:.3px; }
.stm-items-tbl tbody td{ padding:4px 6px; font-size:12px; }
.stm-items-tbl .no-data{ padding:14px 8px; font-size:11px; }
.stm-cell{ padding:5px 7px; font-size:12px; border-radius:5px; }
.stm-uom-static{
  padding:5px 8px; font-size:11.5px;
  min-height:26px; line-height:16px; border-radius:5px;
}
.stm-dd-item{ padding:6px 9px; font-size:12px; }
.stm-dd-item .stm-dd-uom{ font-size:10px; padding:1px 5px; }

/* Panel chrome */
.tr-pills{ padding:3px; margin-bottom:10px; }
.tr-pill{ padding:6px 14px; font-size:11.5px; }
.tr-pill .count{ min-width:16px; height:14px; padding:0 5px; font-size:8.5px; }
.tr-section-title{ font-size:11px; margin:10px 0 6px; }
.tr-create-card{ padding:10px 14px; margin-bottom:12px; border-radius:8px; }
.tr-create-title{ font-size:12px; }
.tr-create-grid{ gap:8px; }
.tr-create-grid label{ font-size:9.5px; margin-bottom:3px; }
.tr-create-grid select, .tr-create-grid input{
  padding:6px 9px; font-size:11.5px; border-width:1px;
}
.tr-create-btn{ padding:7px 14px; font-size:11.5px; }
.tr-it-card{ padding:9px 11px; border-radius:8px; }
.tr-it-card .icon{ font-size:18px; }
.tr-it-card .num{ font-size:11.5px; }
.tr-it-card .route{ font-size:10.5px; }
.tr-it-card .meta{ font-size:9.5px; }
.tr-it-card .boxes .val{ font-size:15px; }
  `;

  const _STM_MODAL_HTML = `
    <div class="trm-overlay" id="stmModalOverlay" onclick="invStmModalBgClick(event)">
      <div class="trm-modal" id="stmModal" onclick="event.stopPropagation()">
        <div class="trm-head">
          <div class="trm-head-row">
            <div>
              <div class="trm-head-title-lbl" id="stmHeadTitle">📋 Simple stock transfer</div>
              <div class="trm-head-vno"><span id="stmVno">—</span></div>
            </div>
            <div class="trm-head-route">
              <div class="l">FROM <strong><span id="stmFromName">—</span></strong></div>
              <div class="l">TO <strong><span id="stmToName">—</span></strong></div>
            </div>
            <div id="stmStatusBadge"></div>
            <button class="trm-close" onclick="invStmCloseModal()" title="Close">×</button>
          </div>
        </div>
        <div class="trm-body">
          <div class="trm-banner" id="stmBanner">Loading…</div>
          <div class="trm-form-row">
            <div class="trm-field"><label>Date <span class="req">*</span></label>
              <input type="date" id="stmDate"></div>
            <div class="trm-field"><label>From godown <span class="req">*</span></label>
              <select id="stmFromGodown" onchange="invStmFromChanged()"><option value="">— select —</option></select></div>
            <div class="trm-field"><label>To godown <span class="req">*</span></label>
              <select id="stmToGodown" onchange="invStmToChanged()"><option value="">— select —</option></select></div>
          </div>
          <div class="trm-form-row full">
            <div class="trm-field"><label>Remarks</label>
              <input type="text" id="stmRemarks" maxlength="255" placeholder="Optional…"></div>
          </div>
          <div class="trm-totals">
            <div class="trm-tot"><div class="lbl">Items</div><div class="val" id="stmTotItems">0</div></div>
            <div class="trm-tot"><div class="lbl">Total Pkgs</div><div class="val" id="stmTotPkgs">0</div></div>
            <div class="trm-tot t-qty"><div class="lbl">Total Qty</div><div class="val" id="stmTotQty">0</div></div>
          </div>
          <div class="trm-packages-wrap">
            <div class="trm-packages-head"><span>Voucher items</span></div>
            <table class="stm-items-tbl">
              <thead><tr>
                <th style="width:42px">#</th>
                <th style="min-width:260px">Material <span style="color:#dc2626">*</span></th>
                <th style="width:90px;text-align:right">No. Pkg</th>
                <th style="width:110px;text-align:right">Per Pkg Qty</th>
                <th style="width:110px;text-align:right">Total Qty <span style="color:#dc2626">*</span></th>
                <th style="width:80px">UOM</th>
                <th style="min-width:180px">Remarks</th>
                <th style="width:40px"></th>
              </tr></thead>
              <tbody id="stmItemsBody">
                <tr><td colspan="8" class="no-data">Click + Add Item below</td></tr>
              </tbody>
            </table>
            <div class="stm-add-item-row" id="stmAddItemBtn">
              <button class="btn" onclick="invStmAddItem()" type="button">
                <i class="fas fa-plus"></i> Add Item
              </button>
              <span style="font-size:10.5px;color:#9ca3af;margin-left:10px">
                Tip: Total Qty auto-calculates as Pkg × Per-Pkg, but you can override it.
              </span>
            </div>
          </div>
        </div>
        <div class="trm-foot">
          <button class="btn btn-ghost" id="stmCancelBtn"
                  onclick="invStmCancelCurrent()" style="display:none">
            <i class="fas fa-times-circle"></i> Cancel voucher
          </button>
          <button class="btn btn-ghost" id="stmPrintBtn"
                  onclick="invStmPrint()" style="display:none">
            <i class="fas fa-print"></i> Print
          </button>
          <button class="btn btn-ghost" id="stmWhatsAppBtn"
                  onclick="invStmWhatsApp()" style="display:none;color:#25D366">
            <i class="fab fa-whatsapp"></i> WhatsApp
          </button>
          <div class="trm-spacer"></div>
          <button class="btn btn-ghost" onclick="invStmCloseModal()">Close</button>
          <button class="btn" id="stmSaveBtn"
                  onclick="invStmSave()" style="display:none;background:#4f46e5;color:#fff;border-color:#4f46e5">
            <i class="fas fa-save"></i> Save
          </button>
          <button class="btn btn-primary" id="stmSubmitOutBtn"
                  onclick="invStmSubmitOut()" style="display:none">
            <i class="fas fa-paper-plane"></i> Submit OUT
          </button>
          <button class="btn btn-primary" id="stmConfirmInBtn"
                  onclick="invStmConfirmIn()"
                  style="display:none;background:#16a34a;border-color:#16a34a">
            <i class="fas fa-check-circle"></i> Confirm receipt
          </button>
        </div>
      </div>
    </div>
  `;

  // Run bootstrap once the DOM is ready (matches inventory_godown.js pattern)
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _stmBootstrap);
  } else {
    _stmBootstrap();
  }

  console.log('✅ inventory_simple_transfer.js loaded — self-registering sidebar panel');
})();
