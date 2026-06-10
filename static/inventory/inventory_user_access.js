/* ═══════════════════════════════════════════════════════════════════════
   inventory_user_access.js — User Access Control  (Inventory Phase 1)
   HCP Wellness · ported from pm_stock_user_access.js
   ───────────────────────────────────────────────────────────────────────
   Admin-only modal accessible from sidebar → 🛡️ User Access Control.
   Fine-grained per-user gating of inventory feature categories, plus an
   optional Access Groups layer.

   Self-contained:
     • Injects its own modal markup + a sidebar nav item at runtime.
     • Bundles a small invToast() helper (inventory has no toast system).
     • Exposes window._invAccess (the CURRENT user's flags + is_admin) and
       window.invHasAccess(category) for later phases to gate their UI.

   Backend: inventory_access.py  →  /api/inventory_mgmt/access/*
   =================================================================== */

(function(){
  'use strict';

  /* ── tiny helpers ─────────────────────────────────────────────────── */
  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  /* ── self-contained toast (inventory has none) ────────────────────── */
  function invToast(msg, kind, ms){
    kind = kind || 'info';
    ms   = ms || 2800;
    let host = $('inv-toast-host');
    if(!host){
      host = document.createElement('div');
      host.id = 'inv-toast-host';
      host.style.cssText =
        'position:fixed;top:18px;right:18px;z-index:2000;display:flex;'+
        'flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(host);
    }
    const colors = {
      success:'#16a34a', error:'#dc2626', info:'#2563eb', warn:'#d97706'
    };
    const el = document.createElement('div');
    el.style.cssText =
      'pointer-events:auto;min-width:220px;max-width:380px;padding:11px 15px;'+
      'border-radius:10px;color:#fff;font-size:13px;font-weight:600;'+
      'box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transform:translateX(20px);'+
      'transition:opacity .18s,transform .18s;background:'+(colors[kind]||colors.info);
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity='1'; el.style.transform='translateX(0)'; });
    setTimeout(() => {
      el.style.opacity='0'; el.style.transform='translateX(20px)';
      setTimeout(() => el.remove(), 220);
    }, ms);
  }
  // expose so later phases can reuse one consistent toast
  window.invToast = window.invToast || invToast;

  /* ── category metadata (must mirror INV_ACCESS_CATEGORIES in backend) ──
     All categories are simple Enable/Disable toggles. All default 'off'. */
  const _IAC_CATEGORIES = [
    { key:'brands',          label:'Brands',          kind:'boolean', desc:'View / manage Brands tab' },
    { key:'suppliers',       label:'Suppliers',       kind:'boolean', desc:'View / manage Suppliers tab' },
    { key:'items',           label:'Items (RM Master)', kind:'level',
      desc:'Items grid. Off = hidden · View = see items only · Edit = full CRUD (New / Edit / Delete)' },
    { key:'godown_view',     label:'Godown View',     kind:'boolean', desc:'Godown-wise stock view + box drill-down' },
    { key:'stock_transfer',  label:'Stock Transfer',  kind:'boolean', desc:'Stock Transfer vouchers (full transfer flow)' },
    { key:'simple_transfer', label:'Simple Transfer', kind:'boolean', desc:'Quick / simple stock transfer' },
    { key:'manage_godown',   label:'Manage Godown',   kind:'boolean', desc:'Add / edit / delete godowns' },
    { key:'material_request', label:'Material Request', kind:'boolean', desc:'Material Request tab — create / view / fulfill requests' },
    { key:'opening_stock',   label:'Opening Stock',   kind:'boolean', desc:'Opening Stock entry + opening labels' },
    { key:'opening_stock_view_print', label:'Opening Stock — View / Print Only', kind:'boolean',
      desc:'Restrict to view + print; no create / edit / delete', parent:'opening_stock', sub:true },
    { key:'grn',             label:'GRN',             kind:'boolean', desc:'Goods Receipt Notes tab (list + open)' },
    { key:'grn_view_print',  label:'GRN — View / Print Only', kind:'boolean',
      desc:'Restrict to view + print; no edit / delete (overrides Edit/New GRN)', parent:'grn', sub:true },
    { key:'grn_edit',        label:'Edit GRN',        kind:'boolean', desc:'Edit / modify an existing GRN', parent:'grn', sub:true },
    { key:'grn_new',         label:'New GRN',         kind:'boolean', desc:'Create a new GRN voucher', parent:'grn', sub:true },
    { key:'fefo_override',   label:'FEFO Override Approvals', kind:'boolean', desc:'Review & approve FEFO override requests' },
    { key:'material_lock',   label:'Material Lock',   kind:'boolean', desc:'Manage material lock rules' },
    { key:'label_reissue',   label:'Label Reissue Approvals', kind:'boolean', desc:'Review & approve label reissue requests' },
    { key:'label_reprint',   label:'Label Reprint Approvals', kind:'boolean', desc:'Review & approve label reprint requests' },
    { key:'box_split',       label:'Box Split',       kind:'boolean', desc:'Split a box into smaller child boxes' },
    { key:'delivery_note',   label:'Delivery Note',   kind:'boolean', desc:'Issue delivery notes (HCP to supplier, reduces stock)' },
    { key:'command_palette', label:'Command Palette (Ctrl+K)', kind:'boolean', desc:'Keyboard launcher to search & jump to any screen' },
    { key:'floating_dock',   label:'Floating Dock',   kind:'boolean', desc:'Movable, pinnable quick-action toolbar' },
    { key:'qr_scanner',      label:'QR Scanner (Handheld)', kind:'boolean', desc:'Scan box QR labels with a USB/Bluetooth scanner' },
    { key:'low_stock_alerts',label:'Low Stock Alerts', kind:'boolean', desc:'View items below their minimum stock level' },
    { key:'stock_audit',     label:'Physical Stock Audit', kind:'boolean', desc:'Run physical count sessions and reconcile variance' },
    { key:'mobile_view',     label:'Mobile View',     kind:'boolean', desc:'Phone-friendly layout with a bottom tab bar' },
    { key:'reports',         label:'Reports',         kind:'boolean', desc:'View & print stock reports (godown-wise, group-wise)' },
    { key:'voucher_log',     label:'Voucher Log',     kind:'boolean', desc:'View the voucher log / activity history (read-only)' },
    { key:'db_reset',        label:'Database Reset (Admin)', kind:'boolean', desc:'Reset transactional data & voucher sequence (destructive)' },
    { key:'mr_batch_popup', label:'MR — FEFO Batch Popup', kind:'boolean',
      desc:'Show batch list (FEFO order) when picking material on the New MR screen' },
    { key:'pending_tasks_toast', label:'Pending Tasks Reminder', kind:'boolean',
      desc:'Top-right reminder toast every ~90 min for pending tasks (expiring batches, below-MSL items, pending MRs, in-transit transfers, stale audits)' },
    { key:'user_control',    label:'User Control',    kind:'boolean', desc:'Open the User Access Control tool' },
    { key:'view_only',       label:'View-Only (Stocks)', kind:'boolean',
      desc:'Master read-only lock: user can VIEW stocks/reports but cannot create, edit, transfer, approve, split, issue, reconcile or reset anything. Overrides all action permissions.' },
  ];
  const _IAC_KIND    = Object.fromEntries(_IAC_CATEGORIES.map(c => [c.key, c.kind]));
  const _IAC_DEFAULT = {};  // everything defaults 'off'
  function _iacDef(key){ return _IAC_DEFAULT[key] || 'off'; }
  function _iacIsEnabled(v){ return String(v||'off').toLowerCase() !== 'off'; }

  /* ── modal state ──────────────────────────────────────────────────── */
  window._iacState = {
    user:null, access:{}, original:{}, hasRow:false, users:[], _pickedUser:null,
    // Location lock state (May 2026): selected lock + original for dirty
    // detection. godowns is loaded once per modal open and cached.
    locked_godown_id: null,
    original_locked_godown_id: null,
    godowns: [],
  };
  let _iacHighlightIdx = -1;

  /* ════════════════════════════════════════════════════════════════════
     OPEN
  ════════════════════════════════════════════════════════════════════ */
  async function openUserAccessModal(){
    $('inventoryUserAccessModal')?.classList.add('show');
    const S = window._iacState;
    S.user = null; S.access = {}; S.original = {}; S.hasRow = false; S._pickedUser = null;
    S.locked_godown_id = null;
    S.original_locked_godown_id = null;
    $('iac-user-meta').textContent = '';
    $('iac-status').textContent    = '';
    $('iac-save-btn').disabled  = true;
    $('iac-reset-btn').disabled = true;
    const inp = $('iac-user-input');
    if(inp) inp.value = '';
    $('iac-user-clear').style.display = 'none';
    $('iac-user-dd').style.display    = 'none';
    $('iac-toggles').innerHTML =
      `<div style="padding:30px 16px;font-size:12px;color:var(--muted,#9ca3af);text-align:center;font-style:italic">Select a user to see access settings.</div>`;
    // Hide the lock section until a user is picked.
    const lockSec = $('iac-lock-section');
    if(lockSec) lockSec.style.display = 'none';
    // Load godowns once per modal open. The list is small; we cache it
    // on the state so the dropdown populates instantly on each user pick.
    _iacLoadGodowns();
    try {
      const res = await fetch('/api/inventory_mgmt/access/users', { credentials:'same-origin' });
      let d = {};
      let raw = '';
      try { raw = await res.text(); d = JSON.parse(raw); } catch(_){ d = {}; }
      // ── Diagnostic: only surfaced in the meta line on FAILURE; on success
      //    the meta line is cleared so the selected-user info can use it. ──
      const diag = $('iac-user-meta');
      const okLoad = (res.ok && d.status==='ok' && (d.users||[]).length);
      const dbg = `HTTP ${res.status} · status=${d.status||'?'} · count=${d.count!=null?d.count:(d.users?d.users.length:'?')}${d.debug?(' · debug='+d.debug):''}${d.message?(' · msg='+d.message):''}`;
      if(diag){
        diag.textContent = okLoad ? '' : dbg;
        diag.style.color = okLoad ? 'var(--muted,#9ca3af)' : '#dc2626';
      }
      console.log('[user-access] /users →', res.status, d, raw.slice(0,300));

      if(res.status === 403){
        invToast('Admin only — your account cannot manage user access.', 'error', 5000);
        S.users = [];
      } else if(res.status === 401){
        invToast('Session expired — please log in again.', 'error', 5000);
        S.users = [];
      } else if(d.status === 'ok'){
        S.users = d.users || [];
        if(d.debug) console.warn('[user-access] users debug:', d.debug);
        if(!S.users.length){
          invToast('No users found in user_tbl' + (d.debug ? ' — see console' : ''), 'warn', 4500);
        }
        setTimeout(() => { inp?.focus(); _iacUserInput(); }, 60);
      } else {
        invToast(d.message || 'Failed to load users', 'error', 4500);
        if(d.debug) console.warn('[user-access] error debug:', d.debug);
        S.users = [];
      }
    } catch(e){
      const diag = $('iac-user-meta');
      if(diag){ diag.textContent = 'fetch failed: ' + e.message; diag.style.color = '#dc2626'; }
      invToast('Network error loading users', 'error', 4000);
    }
  }
  function closeUserAccessModal(){
    $('inventoryUserAccessModal')?.classList.remove('show');
  }

  /* ── typeahead ────────────────────────────────────────────────────── */
  function _iacMatchUsers(q){
    const lq  = (q || '').toLowerCase().trim();
    const all = window._iacState.users || [];
    if(!lq) return all.slice(0, 50);
    return all.filter(u => {
      const statusTag = (u.is_active === 0) ? 'inactive' : 'active';
      const hay = [u.user_name, u.display_name, u.role, u.user_type, u.department, u.designation, statusTag]
        .map(v => String(v || '').toLowerCase()).join(' ');
      return hay.includes(lq);
    }).slice(0, 100);
  }
  function _iacUserInput(){
    const inp = $('iac-user-input'), dd = $('iac-user-dd'), clr = $('iac-user-clear');
    if(!inp || !dd) return;
    const q = inp.value;
    clr.style.display = q ? 'inline' : 'none';
    const matches = _iacMatchUsers(q);
    _iacHighlightIdx = -1;
    if(!matches.length){
      dd.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--muted,#9ca3af);font-style:italic">No users match "${esc(q)}"</div>`;
      dd.style.display = 'block';
      return;
    }
    dd.innerHTML = matches.map((u, i) => {
      const bits = [];
      // Inactive users still appear in the picker but are visibly tagged so
      // admins can tell them apart at a glance.
      const inactive = (u.is_active === 0);
      if(inactive) bits.push(`<span style="padding:1px 6px;border-radius:8px;background:rgba(220,38,38,.12);color:#991b1b;font-size:10px;font-weight:700;letter-spacing:.3px">INACTIVE</span>`);
      if(u.display_name && u.display_name !== u.user_name) bits.push(`<span style="color:var(--muted,#6b7280)">${esc(u.display_name)}</span>`);
      if(u.role)       bits.push(`<span style="padding:1px 6px;border-radius:8px;background:rgba(37,99,235,.10);color:#1e40af;font-size:10px;font-weight:700">${esc(u.role)}</span>`);
      if(u.department) bits.push(`<span style="color:var(--muted,#9ca3af);font-size:11px">${esc(u.department)}</span>`);
      const rowStyle = inactive
        ? 'padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--border,rgba(0,0,0,.06));display:flex;align-items:center;gap:8px;flex-wrap:wrap;opacity:.65'
        : 'padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--border,rgba(0,0,0,.06));display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      return `
        <div class="iac-user-item" data-username="${esc(u.user_name)}" data-idx="${i}"
          onclick="_iacUserPick('${String(u.user_name).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')"
          style="${rowStyle}">
          <span style="font-weight:700;color:var(--text,#111);font-size:13px">${esc(u.user_name)}</span>
          ${bits.join(' ')}
        </div>`;
    }).join('');
    dd.style.display = 'block';
  }
  function _iacUserClear(){
    const inp = $('iac-user-input');
    if(inp){ inp.value = ''; inp.focus(); }
    $('iac-user-clear').style.display = 'none';
    _iacUserInput();
  }
  function _iacUserKeyDown(ev){
    const dd = $('iac-user-dd');
    if(!dd || dd.style.display === 'none'){
      if(ev.key === 'ArrowDown'){ _iacUserInput(); ev.preventDefault(); }
      return;
    }
    const items = Array.from(dd.querySelectorAll('.iac-user-item'));
    if(!items.length) return;
    const setHi = (idx) => {
      items.forEach((it, i) => { it.style.background = (i === idx) ? 'rgba(37,99,235,.08)' : ''; });
      if(idx >= 0 && items[idx]) items[idx].scrollIntoView({ block:'nearest' });
    };
    if(ev.key === 'ArrowDown'){
      _iacHighlightIdx = Math.min(items.length - 1, _iacHighlightIdx + 1); setHi(_iacHighlightIdx); ev.preventDefault();
    } else if(ev.key === 'ArrowUp'){
      _iacHighlightIdx = Math.max(0, _iacHighlightIdx - 1); setHi(_iacHighlightIdx); ev.preventDefault();
    } else if(ev.key === 'Enter'){
      if(_iacHighlightIdx < 0) _iacHighlightIdx = 0;
      const un = items[_iacHighlightIdx]?.getAttribute('data-username');
      if(un) _iacUserPick(un); ev.preventDefault();
    } else if(ev.key === 'Escape'){
      dd.style.display = 'none'; ev.preventDefault();
    }
  }
  function _iacUserPick(username){
    const u = (window._iacState.users || []).find(x => x.user_name === username);
    const inp = $('iac-user-input');
    if(inp){
      inp.value = (u && u.display_name && u.display_name !== u.user_name)
        ? `${u.user_name} · ${u.display_name}` : username;
    }
    $('iac-user-clear').style.display = 'inline';
    $('iac-user-dd').style.display = 'none';
    _iacHighlightIdx = -1;
    window._iacState._pickedUser = username;
    iacLoadUser();
  }

  /* close dropdown on outside click */
  document.addEventListener('click', (ev) => {
    const dd = $('iac-user-dd'), inp = $('iac-user-input');
    if(!dd || !inp) return;
    if(ev.target === inp || dd.contains(ev.target)) return;
    dd.style.display = 'none';
  });

  /* ── load one user ────────────────────────────────────────────────── */
  async function iacLoadUser(){
    const S = window._iacState;
    let user = S._pickedUser || '';
    S._pickedUser = null;
    if(!user){
      S.user = null;
      S.locked_godown_id = null;
      S.original_locked_godown_id = null;
      $('iac-toggles').innerHTML =
        `<div style="padding:30px 16px;font-size:12px;color:var(--muted,#9ca3af);text-align:center;font-style:italic">Select a user to see access settings.</div>`;
      $('iac-save-btn').disabled  = true;
      $('iac-reset-btn').disabled = true;
      $('iac-user-meta').textContent = '';
      const lockSec = $('iac-lock-section');
      if(lockSec) lockSec.style.display = 'none';
      return;
    }
    S.user = user;
    try {
      const res = await fetch(`/api/inventory_mgmt/access/user/${encodeURIComponent(user)}`);
      const d   = await res.json();
      if(d.status !== 'ok'){ invToast(d.message || 'Failed to load user access', 'error', 4000); return; }
      S.access   = { ...(d.access || {}) };
      S.original = { ...(d.access || {}) };
      // Location lock — server returns null when no lock is set.
      S.locked_godown_id          = (d.locked_godown_id == null) ? null : parseInt(d.locked_godown_id, 10);
      S.original_locked_godown_id = S.locked_godown_id;
      _iacRenderLockPicker();
      const lockSec = $('iac-lock-section');
      if(lockSec) lockSec.style.display = '';
      // hasRow heuristic: any value differing from its default OR a lock
      // present means a row exists (so Reset → defaults can clear it).
      S.hasRow = _IAC_CATEGORIES.some(c =>
        String(S.access[c.key] || _iacDef(c.key)) !== _iacDef(c.key)
      ) || (S.locked_godown_id != null);
      const meta = (S.users || []).find(u => u.user_name === user);
      if(meta){
        const bits = [];
        if(meta.display_name && meta.display_name !== user) bits.push(meta.display_name);
        if(meta.role)       bits.push(`Role: ${meta.role}`);
        if(meta.department) bits.push(meta.department);
        let line = bits.join(' · ');
        if((meta.role || '').toLowerCase() === 'admin'){
          line += (line ? '  ·  ' : '') + '⚠ Admin — these settings are NOT enforced for admins; they always bypass.';
        }
        $('iac-user-meta').textContent = line;
      } else {
        $('iac-user-meta').textContent = '';
      }
      _iacRender();
      _iacUpdateDirtyState();
      $('iac-reset-btn').disabled = !S.hasRow;
    } catch(e){
      invToast('Network error: ' + e.message, 'error', 4000);
    }
  }

  /* ── render rows ──────────────────────────────────────────────────────
     boolean → an On/Off pill toggle.
     level   → an Off / View / Edit segmented control. */
  function _iacRender(){
    const wrap = $('iac-toggles');
    if(!wrap) return;
    const S = window._iacState;
    wrap.innerHTML = _IAC_CATEGORIES.map((cat, i) => {
      const val   = String(S.access[cat.key] || _iacDef(cat.key)).toLowerCase();
      const bgRow = (i % 2 === 0) ? 'var(--surface,#f9fafb)' : 'var(--card,#fff)';

      let control;
      // Sub-rows (grn_view_print, grn_edit, grn_new, opening_stock_view_print)
      // are only meaningful when their parent is enabled. Disable + grey them
      // when the parent is off.
      const parentOff = cat.parent && !_iacIsEnabled(String(S.access[cat.parent] || _iacDef(cat.parent)));

      if(cat.kind === 'level'){
        const seg = (lvl, txt) => {
          const active = (val === lvl);
          const bg = active ? (lvl==='off' ? '#94a3b8' : 'var(--brand,#2563eb)') : 'transparent';
          const fg = active ? '#fff' : 'var(--muted,#6b7280)';
          return `<button type="button" onclick="iacSetLevel('${cat.key}','${lvl}')"
            style="border:0;background:${bg};color:${fg};font-size:11px;font-weight:700;
            padding:5px 11px;cursor:pointer;transition:background .12s,color .12s">${txt}</button>`;
        };
        control = `<div style="display:inline-flex;border:1px solid var(--border,#d1d5db);
          border-radius:8px;overflow:hidden">${seg('off','Off')}${seg('view','View')}${seg('edit','Edit')}</div>`;
      } else {
        const on = _iacIsEnabled(val);
        const dim = parentOff ? 'opacity:.4;pointer-events:none;' : '';
        control = `<button type="button" onclick="iacToggleKey('${cat.key}')"
          style="${dim}width:46px;height:24px;border-radius:12px;border:0;position:relative;cursor:pointer;
          background:${on ? 'var(--brand,#2563eb)' : '#cbd5e1'};transition:background .15s;padding:0">
          <span style="position:absolute;top:2px;left:${on ? '24px' : '2px'};width:20px;height:20px;
          background:#fff;border-radius:50%;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
        </button>`;
      }

      // Indent + lighter background for sub-rows so the hierarchy reads.
      const pad   = cat.sub ? '10px 14px 10px 30px' : '11px 14px';
      const accent = cat.sub ? 'border-left:2px solid var(--brand,#2563eb);' : '';
      const labelColor = (cat.sub && parentOff) ? 'var(--muted,#9ca3af)' : 'var(--text,#111)';
      return `
        <div style="display:grid;grid-template-columns:1fr auto;gap:12px;padding:${pad};${accent}background:${bgRow};border-bottom:1px solid var(--border,rgba(0,0,0,.05));align-items:center">
          <div>
            <div style="font-size:${cat.sub?'12px':'12.5px'};font-weight:700;color:${labelColor}">${esc(cat.label)}</div>
            <div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:1px">${esc(cat.desc)}${parentOff?' · (enable parent first)':''}</div>
          </div>
          <div style="display:flex;justify-content:flex-end;align-items:center">${control}</div>
        </div>`;
    }).join('');
  }
  function iacToggleKey(key){
    const S = window._iacState;
    const cur = String(S.access[key] || _iacDef(key)).toLowerCase();
    S.access[key] = _iacIsEnabled(cur) ? 'off' : 'on';
    _iacRender();
    _iacUpdateDirtyState();
  }
  function iacSetLevel(key, lvl){
    const S = window._iacState;
    S.access[key] = lvl;
    _iacRender();
    _iacUpdateDirtyState();
  }
  /* ── Godown loading + lock picker (May 2026) ─────────────────────────
     The Location Lock picker is populated from /api/inventory_mgmt/godowns.
     We load once per modal open and cache on _iacState.godowns. */
  async function _iacLoadGodowns(){
    const S = window._iacState;
    const sel = $('iac-locked-godown');
    if(!sel) return;
    try {
      const res = await fetch('/api/inventory_mgmt/godowns', { credentials:'same-origin' });
      const d   = await res.json();
      if(d && d.status === 'ok' && Array.isArray(d.godowns)){
        S.godowns = d.godowns;
      }
    } catch(_){ /* fail-open: keeps existing options */ }
    _iacRenderLockPicker();
  }

  function _iacRenderLockPicker(){
    const S   = window._iacState;
    const sel = $('iac-locked-godown');
    if(!sel) return;
    const cur = S.locked_godown_id;
    const opts = ['<option value="">— No lock —</option>']
      .concat((S.godowns || []).map(g =>
        `<option value="${g.id}" ${String(cur)===String(g.id)?'selected':''}>${esc(g.name||'')}</option>`
      ));
    sel.innerHTML = opts.join('');
  }

  function _iacOnLockChange(val){
    const S = window._iacState;
    const v = (val === '' || val === null) ? null : parseInt(val, 10);
    S.locked_godown_id = isFinite(v) ? v : null;
    _iacUpdateDirtyState();
  }

  function _iacUpdateDirtyState(){
    const S = window._iacState;
    const accessDirty = JSON.stringify(S.access) !== JSON.stringify(S.original);
    // Lock is dirty when the picker value differs from what was loaded.
    // Coerce both sides to string so null/undefined/int compare cleanly.
    const a = (S.locked_godown_id == null) ? '' : String(S.locked_godown_id);
    const b = (S.original_locked_godown_id == null) ? '' : String(S.original_locked_godown_id);
    const lockDirty = (a !== b);
    const dirty = accessDirty || lockDirty;
    $('iac-save-btn').disabled = !dirty;
    $('iac-status').textContent = dirty ? '◆ Unsaved changes' : '';
  }

  /* ── save / reset ─────────────────────────────────────────────────── */
  async function iacSaveUser(){
    const S = window._iacState;
    if(!S.user) return;
    const btn = $('iac-save-btn');
    if(btn){ btn.disabled = true; btn.innerHTML = 'Saving…'; }
    try {
      const res = await fetch('/api/inventory_mgmt/access/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          user_name: S.user,
          access: S.access,
          // Lock is a top-level field — server stores it on the same row
          // but via a separate UPDATE (it's not one of the toggle keys).
          locked_godown_id: S.locked_godown_id,
        })
      });
      const d = await res.json();
      if(d.status === 'ok'){
        S.access   = { ...(d.access || S.access) };
        S.original = { ...S.access };
        S.hasRow   = true;
        // Sync the locked-godown original from what the server actually
        // stored. The server returns locked_godown_id in the response;
        // accept it as the new baseline.
        if(d.locked_godown_id !== undefined){
          S.locked_godown_id = (d.locked_godown_id == null) ? null : d.locked_godown_id;
        }
        S.original_locked_godown_id = S.locked_godown_id;
        _iacRenderLockPicker();
        $('iac-reset-btn').disabled = false;
        _iacRender();
        _iacUpdateDirtyState();
        invToast(`✓ Access settings saved for ${S.user}`, 'success', 2500);

        // If the admin just edited their OWN access (rare but possible),
        // refresh window._invAccess and re-gate the page so they don't
        // have to reload to see the effect. Match either the picked
        // username or the display name vs the currently-bootstrapped
        // user, case-insensitive.
        try {
          const me = (window._invAccess && window._invAccess.user_name) || '';
          if (me && me.toLowerCase() === String(S.user || '').toLowerCase()){
            await _iacRefreshSelfAccess();
          }
        } catch(_){}
      } else {
        invToast(d.message || 'Save failed', 'error', 5000);
      }
    } catch(e){
      invToast('Network error: ' + e.message, 'error', 4000);
    } finally {
      if(btn){ btn.innerHTML = '<i class="fas fa-save"></i> Save changes'; }
      _iacUpdateDirtyState();
    }
  }

  /* Re-fetch /access/me and overwrite window._invAccess + INV_CTX.caps,
     then dispatch inv-access-ready so all dependent modules re-gate. */
  async function _iacRefreshSelfAccess(){
    try {
      const res = await fetch('/api/inventory_mgmt/access/me', { credentials:'same-origin' });
      const d   = await res.json();
      if (d && d.status === 'ok'){
        window._invAccess = {
          ready:    true,
          is_admin: !!d.is_admin,
          access:   d.access || {},
          user_name: d.user_name || '',
          source:   d.source || 'defaults',
          matched:  d.matched_name || null,
          group_id: d.group_id || null,
        };
        // Keep INV_CTX in sync — its `caps` is what window.invHasAccess
        // reads each call (closure over the original reference). To
        // avoid the closure-staleness, mutate the original object in
        // place rather than replacing it.
        if (window.INV_CTX){
          window.INV_CTX.isAdmin = !!d.is_admin;
          window.INV_CTX.canEdit = !!d.is_admin;
          // Mutate in place so closures over .caps still see updates.
          if (window.INV_CTX.caps){
            Object.keys(window.INV_CTX.caps).forEach(k => {
              delete window.INV_CTX.caps[k];
            });
            Object.assign(window.INV_CTX.caps, d.access || {});
          } else {
            window.INV_CTX.caps = d.access || {};
          }
        }
        document.dispatchEvent(new CustomEvent('inv-access-ready',
          { detail: window._invAccess }));
        if (typeof window.invApplyAccessGating === 'function'){
          window.invApplyAccessGating();
        }
        console.log('[InventoryAccess] self-access refreshed:', window._invAccess);
      }
    } catch(e){
      console.warn('[InventoryAccess] self-refresh failed:', e);
    }
  }
  async function iacResetUser(){
    const S = window._iacState;
    if(!S.user) return;
    if(!confirm(`Reset ${S.user}'s access to defaults? This removes their custom row entirely.`)) return;
    try {
      const res = await fetch('/api/inventory_mgmt/access/delete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ user_name: S.user })
      });
      const d = await res.json();
      if(d.status === 'ok'){
        S._pickedUser = S.user;
        await iacLoadUser();
        S.hasRow = false;
        $('iac-reset-btn').disabled = true;
        invToast(`✓ ${S.user}'s access reset to defaults`, 'success', 2500);
      } else {
        invToast(d.message || 'Reset failed', 'error', 5000);
      }
    } catch(e){
      invToast('Network error: ' + e.message, 'error', 4000);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     CURRENT-USER ACCESS CACHE  (for later phases to gate UI)
  ════════════════════════════════════════════════════════════════════ */
  window._invAccess = window._invAccess || { ready:false, is_admin:false, access:{} };
  // Returns the raw level string for a category ('off'/'on'/'view'/'edit').
  window.invAccessLevel = function(category){
    const a = window._invAccess;
    if(!a || !a.ready) return 'edit';        // fail-open briefly until loaded
    if(a.is_admin) return 'edit';
    const v = a.access[category];
    if(v === undefined || v === null) return 'off';
    return String(v).toLowerCase();
  };
  // True when the category is enabled at all (not 'off').
  window.invHasAccess = function(category){
    return window.invAccessLevel(category) !== 'off';
  };
  // True when this user is under the master View-Only (read-only) lock.
  // Admins are never locked. Used to hide every action affordance.
  window.invIsViewOnly = function(){
    const a = window._invAccess;
    if(!a || !a.ready) return false;
    if(a.is_admin) return false;
    const v = a.access && a.access['view_only'];
    return String(v == null ? '' : v).toLowerCase() === 'on'
        || String(v == null ? '' : v).toLowerCase() === 'edit'
        || String(v == null ? '' : v).toLowerCase() === 'view'
        || v === true;
  };
  // True when the user may act on a category. All categories are boolean
  // now, so this is equivalent to invHasAccess; kept as a distinct name so
  // later phases can call invCanEdit() at edit/save points without churn.
  window.invCanEdit = function(category){
    const a = window._invAccess;
    if(a && a.is_admin) return true;
    // Master read-only lock blocks every action capability.
    if(window.invIsViewOnly()) return false;
    return window.invAccessLevel(category) !== 'off';
  };
  // GRN capabilities, encoding the View/Print-only restriction.
  window.invGrnCaps = function(){
    const a = window._invAccess;
    if(a && a.is_admin) return { view:true, print:true, edit:true, create:true, delete:true };
    const locked    = window.invIsViewOnly();
    const on        = window.invHasAccess('grn');
    const viewOnly  = window.invHasAccess('grn_view_print') || locked;
    const canEdit   = on && window.invHasAccess('grn_edit') && !viewOnly;
    const canNew    = on && window.invHasAccess('grn_new')  && !viewOnly;
    return { view:on, print:on, edit:canEdit, create:canNew, delete:canEdit };
  };
  // Opening Stock capabilities.
  window.invOpeningCaps = function(){
    const a = window._invAccess;
    if(a && a.is_admin) return { view:true, print:true, edit:true };
    const locked   = window.invIsViewOnly();
    const on       = window.invHasAccess('opening_stock');
    const viewOnly = window.invHasAccess('opening_stock_view_print') || locked;
    return { view:on, print:on, edit:on && !viewOnly };
  };
  async function _iacLoadMyAccess(){
    // Fast path: if window._invAccess was bootstrapped server-side by
    // inventory_mgmt.html (the redesigned May-2026 flow), we already
    // have correct values from page-load 0. Skip the fetch — saves a
    // network round-trip and prevents the brief window where modules
    // booted off of stale/missing data.
    //
    // We still dispatch inv-access-ready so any module that registered
    // a listener (e.g. _applyAdminVisibility) gets the canonical event.
    //
    // Note (May 2026): we no longer eagerly background-revalidate on
    // every page load. The server-rendered values are authoritative,
    // and the previous "validate in background" call added a redundant
    // /access/me round-trip to every load that the non-admin user paid
    // for in latency. Stale data across tabs is handled by an explicit
    // page reload, which inventory operators do naturally between
    // tasks anyway.
    if (window._invAccess && window._invAccess.ready){
      try {
        document.dispatchEvent(new CustomEvent('inv-access-ready',
          { detail: window._invAccess }));
      } catch(_){}
      return;
    }
    try {
      const res = await fetch('/api/inventory_mgmt/access/me');
      const d   = await res.json();
      if(d.status === 'ok'){
        window._invAccess = {
          ready:    true,
          is_admin: !!d.is_admin,
          access:   d.access || {},
          user_name: d.user_name,
          source:   d.source || 'defaults',
          matched:  d.matched_name || null,
          group_id: d.group_id || null,
        };
        document.dispatchEvent(new CustomEvent('inv-access-ready',
          { detail: window._invAccess }));
      }
    } catch(e){ /* fail-open */ }
  }

  /* ════════════════════════════════════════════════════════════════════
     INJECT MODAL + SIDEBAR NAV ITEM
  ════════════════════════════════════════════════════════════════════ */
  function _injectModal(){
    if($('inventoryUserAccessModal')) return;
    const html = `
<div class="modal-overlay" id="inventoryUserAccessModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>🛡️</span> User Access Control</div>
      <button class="modal-close" onclick="closeUserAccessModal()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:14px">
      <div style="position:relative;margin-bottom:6px">
        <label style="font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:5px">Select user</label>
        <div style="position:relative">
          <input type="text" id="iac-user-input" autocomplete="off"
            placeholder="Type a username, name, role…"
            oninput="_iacUserInput()" onkeydown="_iacUserKeyDown(event)" onfocus="_iacUserInput()"
            style="width:100%;padding:9px 32px 9px 11px;border:1px solid var(--border,#d1d5db);border-radius:8px;font-size:13px;background:var(--card,#fff);color:var(--text,#111827)">
          <span id="iac-user-clear" onclick="_iacUserClear()" title="Clear"
            style="display:none;position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted,#9ca3af);font-size:16px;font-weight:700">&times;</span>
          <div id="iac-user-dd"
            style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:280px;overflow-y:auto;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.14);z-index:20"></div>
        </div>
        <div id="iac-user-meta" style="font-size:11px;color:var(--muted,#9ca3af);margin-top:6px;min-height:14px"></div>
      </div>
      <div id="iac-toggles"
        style="border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden;margin-top:8px"></div>

      <!-- Location lock — pins this user to a single godown so material
           requests and fulfilments anchor to it. Admins are never locked
           regardless of value. -->
      <div id="iac-lock-section"
           style="margin-top:12px;border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:11px 14px;background:var(--surface,#f9fafb);display:none">
        <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
          <div>
            <div style="font-size:12.5px;font-weight:700;color:var(--text,#111)">
              <i class="fas fa-lock" style="font-size:10px;color:var(--brand,#4648D4);margin-right:4px"></i>
              Location lock
            </div>
            <div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:1px">
              Pin this user to one godown. New material requests force destination here; fulfilling other users' requests forces source here.
            </div>
          </div>
          <div>
            <select id="iac-locked-godown" onchange="_iacOnLockChange(this.value)"
                    style="min-width:200px;padding:6px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;font-size:12px;background:var(--card,#fff)">
              <option value="">— No lock —</option>
            </select>
          </div>
        </div>
      </div>

      <div id="iac-status" style="font-size:11.5px;color:#d97706;font-weight:700;margin-top:10px;min-height:14px"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="iac-reset-btn" onclick="iacResetUser()" disabled
        title="Remove this user's custom row, reverting to defaults">
        <i class="fas fa-undo"></i> Reset to defaults
      </button>
      <div style="flex:1"></div>
      <button class="btn" onclick="closeUserAccessModal()">Close</button>
      <button class="btn btn-primary" id="iac-save-btn" onclick="iacSaveUser()" disabled>
        <i class="fas fa-save"></i> Save changes
      </button>
    </div>
  </div>
</div>`;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    document.body.appendChild(tmp.firstElementChild);
  }

  function _injectNavItem(){
    // Only admins see the tool. Use the cached flag once known; otherwise
    // inject and let the backend reject non-admins (defence in depth).
    const navBody = document.querySelector('.inv-nav-body') || document.querySelector('.inv-nav');
    if(!navBody) return;
    if(document.getElementById('iac-nav-item')) return;

    const section = document.createElement('div');
    section.className = 'inv-nav-section';
    section.id = 'iac-nav-section';
    // Fail CLOSED: start hidden. Only revealed once we positively confirm the
    // user is an admin (see _applyAdminVisibility). This prevents a non-admin
    // from briefly — or permanently, if the access event is missed — seeing
    // the User Access Control button.
    section.style.display = 'none';
    section.innerHTML = `
      <div class="inv-nav-section-label">Admin</div>
      <div class="inv-nav-item" id="iac-nav-item" onclick="openUserAccessModal()" title="User Access Control">
        <span class="ico">🛡️</span>
        <span>User Access Control</span>
      </div>`;
    navBody.appendChild(section);
  }

  /* show/hide the admin nav section. Fail CLOSED: visible ONLY when we have a
     resolved access state that says is_admin. Any other state (not ready,
     unknown, non-admin) keeps it hidden. */
  function _applyAdminVisibility(){
    const sec = document.getElementById('iac-nav-section');
    if(!sec) return;
    const a = window._invAccess;
    const isAdmin = !!(a && a.ready && a.is_admin === true);
    sec.style.display = isAdmin ? '' : 'none';
  }
  document.addEventListener('inv-access-ready', _applyAdminVisibility);

  /* ── boot ─────────────────────────────────────────────────────────── */
  function _boot(){
    _injectModal();
    _injectNavItem();
    _iacLoadMyAccess().then(_applyAdminVisibility);
    // Escape closes the modal when it's open.
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && $('inventoryUserAccessModal')?.classList.contains('show')){
        closeUserAccessModal();
      }
    });
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  /* ── expose globals used by inline handlers ───────────────────────── */
  window.openUserAccessModal  = openUserAccessModal;
  window.closeUserAccessModal = closeUserAccessModal;
  window._iacUserInput   = _iacUserInput;
  window._iacUserClear   = _iacUserClear;
  window._iacUserKeyDown = _iacUserKeyDown;
  window._iacUserPick    = _iacUserPick;
  window.iacLoadUser     = iacLoadUser;
  window.iacToggleKey    = iacToggleKey;
  window.iacSetLevel     = iacSetLevel;
  window.iacSaveUser     = iacSaveUser;
  window.iacResetUser    = iacResetUser;
  window._iacOnLockChange = _iacOnLockChange;

  console.log('✅ inventory_user_access.js loaded (Phase 1)');
})();
