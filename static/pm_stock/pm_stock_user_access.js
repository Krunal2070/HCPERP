/* ═══════════════════════════════════════════════════════════════════════
   pm_stock_user_access.js — User Access Control modal
   ═══════════════════════════════════════════════════════════════════════

   Admin-only modal accessible from sidebar → 🛡️ User Access Control.
   Allows fine-grained per-user gating of 7 broad feature categories:

     voucher_log          — Voucher Log tab
     reprint_requests     — Reprint requests sidebar
     opening_labels       — Opening Stock labels
     grn_labels           — GRN label printing
     material_request     — Material Request feature
     stock_pages          — Stock view tabs
     new_voucher_entries  — Voucher creation buttons (master switch)

   Data model: pm_user_access table with one row per customised user.
   Users without a row default to all-allowed (legacy behaviour). Admins
   always bypass these checks regardless of their row.

   State machine:
     _uacState.user        — selected username (or null)
     _uacState.access      — current toggle values {category: bool}
     _uacState.original    — server snapshot (used to detect dirty state)
     _uacState.hasRow      — whether this user currently has a DB row
                              (controls whether "Reset to defaults"
                              button is enabled)
   =================================================================== */

window._uacState = {
  user:     null,
  access:   {},
  original: {},
  hasRow:   false,
  users:    [],   // cached user list from /user_access/users
};

// Display labels + descriptions for the access categories. Order here is
// the order they appear in the modal — grouped logically. Sidebar
// fine-grained flags (combined_view, products, suppliers, etc.) are at
// the top since they're the most-toggled by admins setting up new users.
const _UAC_CATEGORIES = [
  // ── Sidebar fine-grained flags ──
  { key:'stock_pages',         label:'Stock View',            desc:'Default Stock View tab (godown / floor stock summary)' },
  { key:'combined_view',       label:'Combined View',         desc:'Combined godown+floor view tab' },
  { key:'split_box',           label:'Split Box',             desc:'Split Box tool — break one physical box into multiple boxes' },
  { key:'products',            label:'Products',              desc:'Products master tab' },
  { key:'suppliers',           label:'Suppliers',             desc:'Supplier Directory + Supplier PM Ledger tabs' },
  { key:'voucher_log',         label:'Voucher Log',           desc:'Voucher Log tab + voucher detail view + bottom Log tab' },
  { key:'new_voucher_entries', label:'New Voucher Entries',   desc:'Create new GRN / DN / Allotment / Audit (Add New launcher)' },
  { key:'voucher_settings',    label:'Voucher # Settings',    desc:'Configure voucher numbering prefixes (Voucher # sidebar)' },
  { key:'grn_labels',          label:'GRN Label Prints',      desc:'GRN label printing after save' },
  { key:'opening_labels',      label:'Opening Label Prints',  desc:'Opening Stock voucher + opening labels' },
  { key:'reprint_requests',    label:'Label Reprint Requests',desc:'Submit reprint requests for existing labels' },
  { key:'material_request',    label:'Material Request',      desc:'Material Request tab + create requests' },
  { key:'material_movement',   label:'Material Movement',     desc:'Material Movement tab (IN / OUT vouchers)' },
  { key:'purchase_orders',     label:'Purchase Orders',       desc:'Purchase Orders tab — create / approve / receive' },
  { key:'stock_adjustment',    label:'Stock Adjustment',      desc:'Create stock adjustment vouchers (admin approval required)' },
  { key:'pm_trs',              label:'PM TRS',                desc:'Generate Testing Requisition Slips from GRN; view PM TRS grid' },
  { key:'reports',             label:'Reports',               desc:'Reports hub (sidebar Reports section)' },
  { key:'command_palette',     label:'Command Palette / Dock', desc:'Quick-action dock at the top of the page (Stock View / New GRN / etc.) and the Ctrl+K command search' },
  // ── Sensitive control features (default DENY — admin grants explicitly) ──
  { key:'material_lock',       label:'Material Lock',         desc:'Lock / allow material from Material OUT (by date or GRN, per location)' },
  { key:'label_reissue',       label:'Label Reissue Approvals', desc:'Approve / reject damaged-QR label reissue requests' },
  { key:'fifo_override',       label:'FIFO Override Approvals', desc:'Approve / reject non-admin FIFO bypass requests' },
  { key:'bom_manage',          label:'BOM Manager',           desc:'Create / edit Bill-of-Materials recipes for finished-goods products' },
];

async function openUserAccessModal(){
  document.getElementById('userAccessModal')?.classList.add('open');
  // Reset state on open so re-opens always start clean.
  _uacState.user     = null;
  _uacState.access   = {};
  _uacState.original = {};
  _uacState.hasRow   = false;
  document.getElementById('uac-user-meta').textContent = '';
  document.getElementById('uac-status').textContent    = '';
  document.getElementById('uac-save-btn').disabled  = true;
  document.getElementById('uac-reset-btn').disabled = true;
  // Reset typeahead input
  const inp = document.getElementById('uac-user-input');
  if(inp) inp.value = '';
  document.getElementById('uac-user-clear').style.display = 'none';
  document.getElementById('uac-user-dd').style.display    = 'none';
  document.getElementById('uac-toggles').innerHTML  =
    `<div style="padding:30px 16px;font-size:12px;color:var(--hmuted,#9ca3af);text-align:center;font-style:italic">Select a user to see access settings.</div>`;
  // Fetch user list (always — admins may have created new users since last open)
  try {
    const res = await fetch('/api/pm_stock/user_access/users');
    const d   = await res.json();
    if(d.status === 'ok'){
      _uacState.users = d.users || [];
      _uacState.meta  = d.meta  || {};
      // Focus the input so the admin can start typing immediately.
      setTimeout(() => inp?.focus(), 50);
    } else {
      showToast(d.message || 'Failed to load users', 'error', 4000);
    }
  } catch(e){
    showToast('Network error loading users', 'error', 4000);
  }
}

// ── Typeahead helpers ───────────────────────────────────────────────
//
// Free-text input that filters the cached _uacState.users list on every
// keystroke and renders matches in a dropdown panel below the input.
// Keyboard navigation: ArrowUp / ArrowDown move highlight, Enter picks
// the highlighted entry, Escape closes the dropdown.
//
// Matching is permissive — substring match (case-insensitive) against
// username + display_name + role + department. The admin can find
// users by any of those fields.

let _uacHighlightIdx = -1;   // index within the currently filtered list

function _uacMatchUsers(q){
  // Show ALL loaded users from user_tbl by default (empty input). Earlier
  // versions capped at 50 / 100 for perf, but the admin needs to see
  // every user that exists, including ones whose name they don't yet
  // know. The full list is typically a few dozen rows so rendering
  // them all is fine.
  const lq = (q || '').toLowerCase().trim();
  const all = _uacState.users || [];
  if(!lq) return all.slice();   // empty input: every user
  return all.filter(u => {
    const hay = [u.user_name, u.display_name, u.role, u.user_type, u.department]
      .map(v => String(v || '').toLowerCase()).join(' ');
    return hay.includes(lq);
  });
}

function _uacUserInput(){
  const inp = document.getElementById('uac-user-input');
  const dd  = document.getElementById('uac-user-dd');
  const clr = document.getElementById('uac-user-clear');
  if(!inp || !dd) return;
  const q = inp.value;
  clr.style.display = q ? 'inline' : 'none';
  const matches = _uacMatchUsers(q);
  const totalCount = (_uacState.users || []).length;
  const meta = _uacState.meta || {};
  _uacHighlightIdx = -1;
  if(!matches.length){
    const msg = !totalCount
      ? `No users loaded from <code>User_Tbl</code>. Check that the table exists and is populated.`
      : `No users match "<b>${q}</b>" out of ${totalCount} total. Clear the search box to see every user.`;
    dd.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--hmuted,#9ca3af);line-height:1.5">${msg}</div>`;
    dd.style.display = 'block';
    return;
  }
  // Header row on empty search shows diagnostic counts so admin can
  // spot data issues at a glance (e.g. "expected 30 users, see 14").
  let headerHtml = '';
  if(!q.trim()){
    const breakdown = meta.from_user_tbl != null
      ? ` <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--hmuted,#9ca3af)">· ${meta.from_user_tbl} from User_Tbl${meta.stubs_added ? ` + ${meta.stubs_added} stubs` : ''}</span>`
      : '';
    headerHtml = `<div style="padding:6px 14px;font-size:10.5px;color:var(--hmuted2,#6b7280);background:var(--hsurf2,#f8fafc);border-bottom:1px solid var(--hbdr,rgba(0,0,0,.08));text-transform:uppercase;letter-spacing:.5px;font-weight:700">All ${matches.length} user${matches.length===1?'':'s'}${breakdown}</div>`;
  }
  dd.innerHTML = headerHtml + matches.map((u, i) => {
    const bits = [];
    if(u.display_name && u.display_name !== u.user_name) bits.push(`<span style="color:var(--hmuted2,#6b7280)">${u.display_name}</span>`);
    if(u.role)       bits.push(`<span style="padding:1px 6px;border-radius:8px;background:rgba(59,130,246,.10);color:#1e40af;font-size:10px;font-weight:700">${u.role}</span>`);
    if(u.department) bits.push(`<span style="color:var(--hmuted,#9ca3af);font-size:11px">${u.department}</span>`);
    // Inactive users still shown so the admin can see they exist, but
    // dimmed + with an "INACTIVE" tag so they're not picked by accident.
    const isInactive = u.is_active === false || u.is_active === 0;
    const rowStyle = isInactive
      ? 'padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.04));display:flex;align-items:center;gap:8px;flex-wrap:wrap;opacity:.55'
      : 'padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.04));display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const inactiveTag = isInactive
      ? `<span style="padding:1px 6px;border-radius:8px;background:rgba(239,68,68,.10);color:#dc2626;font-size:9px;font-weight:700;letter-spacing:.5px">INACTIVE</span>`
      : '';
    return `
      <div class="uac-user-item" data-username="${u.user_name}" data-idx="${i}"
        onclick="_uacUserPick('${u.user_name.replace(/'/g, "\\'")}')"
        style="${rowStyle}">
        <span style="font-weight:700;color:var(--htxtb,#111);font-size:13px">${u.user_name}</span>
        ${inactiveTag}
        ${bits.join(' ')}
      </div>`;
  }).join('');
  dd.style.display = 'block';
}

function _uacUserClear(){
  const inp = document.getElementById('uac-user-input');
  if(inp){ inp.value = ''; inp.focus(); }
  document.getElementById('uac-user-clear').style.display = 'none';
  _uacUserInput();
}

function _uacUserKeyDown(ev){
  const dd = document.getElementById('uac-user-dd');
  if(!dd || dd.style.display === 'none'){
    if(ev.key === 'ArrowDown'){ _uacUserInput(); ev.preventDefault(); }
    return;
  }
  const items = Array.from(dd.querySelectorAll('.uac-user-item'));
  if(!items.length) return;
  const setHi = (idx) => {
    items.forEach((it, i) => {
      it.style.background = (i === idx) ? 'rgba(26,115,232,.08)' : '';
    });
    if(idx >= 0 && items[idx]){
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  };
  if(ev.key === 'ArrowDown'){
    _uacHighlightIdx = Math.min(items.length - 1, _uacHighlightIdx + 1);
    setHi(_uacHighlightIdx); ev.preventDefault();
  } else if(ev.key === 'ArrowUp'){
    _uacHighlightIdx = Math.max(0, _uacHighlightIdx - 1);
    setHi(_uacHighlightIdx); ev.preventDefault();
  } else if(ev.key === 'Enter'){
    if(_uacHighlightIdx < 0) _uacHighlightIdx = 0;   // pick first match
    const un = items[_uacHighlightIdx]?.getAttribute('data-username');
    if(un) _uacUserPick(un);
    ev.preventDefault();
  } else if(ev.key === 'Escape'){
    dd.style.display = 'none';
    ev.preventDefault();
  }
}

// Picked an entry — set input text to "username · full_name" for clarity,
// hide dropdown, then run uacLoadUser to fetch their access flags.
function _uacUserPick(username){
  const u = (_uacState.users || []).find(x => x.user_name === username);
  const inp = document.getElementById('uac-user-input');
  if(inp){
    if(u && u.display_name && u.display_name !== u.user_name){
      inp.value = `${u.user_name} · ${u.display_name}`;
    } else {
      inp.value = username;
    }
  }
  document.getElementById('uac-user-clear').style.display = 'inline';
  document.getElementById('uac-user-dd').style.display = 'none';
  _uacHighlightIdx = -1;
  // The original uacLoadUser used the select element; pass the username
  // through a temporary state property so we can keep the load logic
  // unchanged but cleanly decoupled from the DOM source.
  _uacState._pickedUser = username;
  uacLoadUser();
}

// Close the dropdown when clicking outside the input/dropdown.
document.addEventListener('click', (ev) => {
  const dd = document.getElementById('uac-user-dd');
  const inp = document.getElementById('uac-user-input');
  if(!dd || !inp) return;
  if(ev.target === inp || dd.contains(ev.target)) return;
  dd.style.display = 'none';
});

async function uacLoadUser(){
  // Accept the username from either the typeahead pick (preferred) or
  // legacy select element (kept for safety, currently unused).
  let user = _uacState._pickedUser || '';
  if(!user){
    const sel = document.getElementById('uac-user-select');
    user = sel?.value || '';
  }
  // Clear the one-shot picker state so subsequent calls don't reuse it.
  _uacState._pickedUser = null;
  if(!user){
    _uacState.user = null;
    document.getElementById('uac-toggles').innerHTML =
      `<div style="padding:30px 16px;font-size:12px;color:var(--hmuted,#9ca3af);text-align:center;font-style:italic">Select a user to see access settings.</div>`;
    document.getElementById('uac-save-btn').disabled  = true;
    document.getElementById('uac-reset-btn').disabled = true;
    document.getElementById('uac-user-meta').textContent = '';
    return;
  }
  _uacState.user = user;
  // Load this user's current access dict.
  try {
    const res = await fetch(`/api/pm_stock/user_access/${encodeURIComponent(user)}`);
    const d   = await res.json();
    if(d.status !== 'ok'){
      showToast(d.message || 'Failed to load user access', 'error', 4000);
      return;
    }
    _uacState.access   = { ...(d.access || {}) };
    _uacState.original = { ...(d.access || {}) };
    // Detect whether a row exists. The list endpoint is the source of
    // truth for hasRow — pull the snapshot once on open and check.
    // Cheaper: any non-all-true row means hasRow=true. Better: ask the
    // list endpoint; we do that lazily on the next save/reset to keep
    // load fast.
    _uacState.hasRow = Object.values(_uacState.access).some(v => v === false);
    // Display rich meta line from the cached user record.
    const meta = (_uacState.users || []).find(u => u.user_name === user);
    if(meta){
      const bits = [];
      if(meta.display_name && meta.display_name !== user) bits.push(meta.display_name);
      if(meta.role)       bits.push(`Role: ${meta.role}`);
      if(meta.department) bits.push(meta.department);
      let line = bits.join(' · ');
      // Admin warning — admins bypass these controls entirely.
      if((meta.role || '').toLowerCase() === 'admin'){
        line += (line ? '  ·  ' : '') + '⚠ Admin — these settings are NOT enforced for admins; they always bypass.';
      }
      document.getElementById('uac-user-meta').textContent = line;
    } else {
      document.getElementById('uac-user-meta').textContent = '';
    }
    _uacRender();
    _uacUpdateDirtyState();
    document.getElementById('uac-reset-btn').disabled = !_uacState.hasRow;
  } catch(e){
    showToast('Network error: '+e.message, 'error', 4000);
  }
}

// Renders the toggle list from current _uacState.access.
function _uacRender(){
  const wrap = document.getElementById('uac-toggles');
  if(!wrap) return;
  wrap.innerHTML = _UAC_CATEGORIES.map((cat, i) => {
    const on = !!_uacState.access[cat.key];
    const bgRow = (i % 2 === 0) ? 'var(--hsurf2,#f9fafb)' : 'var(--hinput,#fff)';
    return `
      <label style="display:grid;grid-template-columns:1fr 60px;gap:12px;padding:10px 14px;background:${bgRow};border-bottom:1px solid var(--hbdr,rgba(0,0,0,.04));cursor:pointer;align-items:center" onclick="event.preventDefault()">
        <div>
          <div style="font-size:12.5px;font-weight:700;color:var(--htxtb,#111)">${cat.label}</div>
          <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:1px">${cat.desc}</div>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button type="button" id="uac-tg-${cat.key}" onclick="uacToggleKey('${cat.key}')"
            style="width:46px;height:24px;border-radius:12px;border:0;position:relative;cursor:pointer;background:${on ? 'var(--teal,#0d9488)' : '#cbd5e1'};transition:background .15s;padding:0">
            <span style="position:absolute;top:2px;left:${on ? '24px' : '2px'};width:20px;height:20px;background:#fff;border-radius:50%;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
          </button>
        </div>
      </label>`;
  }).join('');
}

// Flip one toggle locally (no server hit yet) and update dirty state.
function uacToggleKey(key){
  if(!(key in _uacState.access)){
    // Defensive: initialise to true if unknown (matches DB default)
    _uacState.access[key] = true;
  }
  _uacState.access[key] = !_uacState.access[key];
  _uacRender();
  _uacUpdateDirtyState();
}

// Enables/disables Save button + status hint based on dirty state.
function _uacUpdateDirtyState(){
  const dirty = JSON.stringify(_uacState.access) !== JSON.stringify(_uacState.original);
  document.getElementById('uac-save-btn').disabled = !dirty;
  document.getElementById('uac-status').textContent = dirty
    ? '◆ Unsaved changes'
    : '';
}

async function uacSaveUser(){
  if(!_uacState.user) return;
  const btn = document.getElementById('uac-save-btn');
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…'; }
  try {
    const res = await fetch('/api/pm_stock/user_access/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ user_name: _uacState.user, access: _uacState.access })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      _uacState.access   = { ...(d.access || _uacState.access) };
      _uacState.original = { ...(_uacState.access) };
      _uacState.hasRow   = true;
      document.getElementById('uac-reset-btn').disabled = false;
      _uacRender();
      _uacUpdateDirtyState();
      showToast(`✓ Access settings saved for ${_uacState.user}`, 'success', 2500);
    } else {
      showToast(d.message || 'Save failed', 'error', 5000);
    }
  } catch(e){
    showToast('Network error: '+e.message, 'error', 4000);
  } finally {
    if(btn){ btn.innerHTML = '<i class="fas fa-save"></i> Save changes'; }
    _uacUpdateDirtyState();
  }
}

async function uacResetUser(){
  if(!_uacState.user) return;
  if(!confirm(`Reset ${_uacState.user}'s access to defaults (all features allowed)? This removes their custom row entirely.`)){
    return;
  }
  try {
    const res = await fetch('/api/pm_stock/user_access/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ user_name: _uacState.user })
    });
    const d = await res.json();
    if(d.status === 'ok'){
      // Reload to pick up the all-true defaults from the server.
      // Pass the username through the picker state slot since the
      // input element no longer drives uacLoadUser directly.
      _uacState._pickedUser = _uacState.user;
      await uacLoadUser();
      _uacState.hasRow = false;
      document.getElementById('uac-reset-btn').disabled = true;
      showToast(`✓ ${_uacState.user}'s access reset to defaults`, 'success', 2500);
    } else {
      showToast(d.message || 'Reset failed', 'error', 5000);
    }
  } catch(e){
    showToast('Network error: '+e.message, 'error', 4000);
  }
}
