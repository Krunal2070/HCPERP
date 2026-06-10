/* ═══════════════════════════════════════════════════════════════════════
   pm_stock_palette.js — Command Palette (Ctrl+K / ⌘K)
   ═══════════════════════════════════════════════════════════════════════

   A keyboard-driven launcher for navigation, creation modals, settings,
   and data search. Open via Ctrl+K (Windows/Linux) or ⌘K (Mac).

   Architecture:
     1. ACTIONS registry — static list of every navigable destination.
        Each action has { id, label, category, hint, icon, run() }.
     2. Recents — backend tracks per-user most-used action IDs. Top 6
        shown when the palette opens empty.
     3. Search — fuzzy match across actions on every keystroke. When the
        query is 2+ chars, ALSO fires a debounced data search against
        vouchers + products.
     4. Render — flat list with category badges, keyboard nav (↑/↓/Enter),
        highlighted match characters in result labels.
     5. Tracking — every action invocation POSTs to /palette/track so
        the recents list reflects actual use.

   Risk surface is small: every action wraps an existing global function
   (switchTab, pmvOpen, openMrCreateModal, etc.). The palette doesn't
   reimplement navigation — it just dispatches to existing handlers.
   =================================================================== */

window._palState = {
  open:        false,
  query:       '',
  highlight:   0,
  recents:     [],     // array of action_id strings (most recent first)
  results:     [],     // current rendered result objects
  searchTimer: null,
  dataResults: { vouchers: [], products: [] },
};

/* ── ACTIONS REGISTRY ────────────────────────────────────────────────
   The canonical list of palette-invokable actions. Each entry:
     id        — stable string identifier (used for recents tracking)
     label     — what the user sees
     keywords  — extra strings to match against (synonyms, abbrev)
     category  — 'Navigate' | 'Create' | 'Open' | 'Admin'
     hint      — optional kbd shortcut shown on the right (e.g. 'Alt+B')
     iconHtml  — small SVG/HTML for the leading icon
     adminOnly — if true, hidden for non-admins
     guard     — optional function returning true when action is available
     run       — invoked on Enter / click
─────────────────────────────────────────────────────────────────────── */
/* ─── Access-flag guard helpers ─────────────────────────────────────
   The palette mirrors the sidebar; every action that opens a feature
   the sidebar gates should also be gated here. The window._userAccess
   global is populated by pm_stock.html at page boot from the Jinja
   `access` dict, so these guards stay in sync with the template gates.

   Two helpers: _palAccess(key) checks the boolean flag, _palIsAdmin()
   short-circuits admin (so an admin loses no actions if their user-row
   ever has a False flag set — admins always have full access). */
function _palAccess(key){
  try {
    if(_palIsAdmin()) return true;
    const a = window._userAccess || {};
    return a[key] === true;
  } catch(_) { return false; }
}
function _palIsAdmin(){
  try {
    if(window._isAdmin === true) return true;
    if(typeof window.__pmIsAdmin === 'function' && window.__pmIsAdmin()) return true;
    return String(window.__pmRole || '').toLowerCase() === 'admin';
  } catch(_) { return false; }
}

const _PAL_ACTIONS = [
  // ── Navigate ─────────────────────────────────────────────────────
  { id:'nav:stock',     label:'Stock View',          category:'Navigate', hint:'Alt+1',
    keywords:'stock view inventory godown', iconHtml:'📦',
    guard: () => _palAccess('stock_pages'),
    run: () => { switchTab && switchTab('stock'); setSidebarActive && setSidebarActive('stock'); } },
  { id:'nav:combined',  label:'Combined View',       category:'Navigate', hint:'Alt+2',
    keywords:'combined per-godown all locations', iconHtml:'🔲',
    guard: () => _palAccess('combined_view'),
    run: () => { switchTab && switchTab('combined'); setSidebarActive && setSidebarActive('combined'); } },
  { id:'nav:products',  label:'Products',            category:'Navigate', hint:'Alt+5',
    keywords:'products master items skus', iconHtml:'📋',
    guard: () => _palAccess('products'),
    run: () => { switchTab && switchTab('products'); setSidebarActive && setSidebarActive('products'); } },
  { id:'nav:suppliers', label:'Supplier Directory',  category:'Navigate', hint:'Alt+9',
    keywords:'suppliers vendors partners', iconHtml:'🏢',
    guard: () => _palAccess('suppliers'),
    run: () => { switchTab && switchTab('suppliers'); setSidebarActive && setSidebarActive('suppliers'); } },
  { id:'nav:sup-ledger',label:'Supplier PM Ledger',  category:'Navigate', hint:'Alt+0',
    keywords:'supplier ledger statement balance', iconHtml:'📒',
    guard: () => _palAccess('suppliers'),
    run: () => { switchTab && switchTab('sup-ledger'); setSidebarActive && setSidebarActive('sup-ledger'); } },
  { id:'nav:grn',       label:'Voucher Log',         category:'Navigate', hint:'Alt+3',
    keywords:'voucher log grn dn mtv history', iconHtml:'📑',
    guard: () => _palAccess('voucher_log'),
    run: () => { switchTab && switchTab('grn'); setSidebarActive && setSidebarActive('grn'); } },
  { id:'nav:mm',        label:'Material Movement',   category:'Navigate', hint:'Alt+6',
    keywords:'mtv material movement transfer in out', iconHtml:'🔄',
    guard: () => _palAccess('material_movement'),
    run: () => { switchTab && switchTab('mm'); setSidebarActive && setSidebarActive('mm'); } },
  { id:'nav:mr',        label:'Material Requests',   category:'Navigate',
    keywords:'material request requisition pre-order', iconHtml:'📝',
    guard: () => _palAccess('material_request'),
    run: () => { (typeof gotoMrTab === 'function') ? gotoMrTab() : (switchTab && switchTab('mm')); } },
  { id:'nav:log',       label:'Activity Log',        category:'Navigate', hint:'Alt+4',
    keywords:'log activity audit history', iconHtml:'📜',
    guard: () => _palAccess('voucher_log'),
    run: () => { switchTab && switchTab('log'); setSidebarActive && setSidebarActive('log'); } },
  { id:'nav:reports',   label:'Reports',     category:'Navigate', hint:'Alt+Y',
    keywords:'reports factory print export', iconHtml:'📊',
    guard: () => _palAccess('reports'),
    run: () => { switchTab && switchTab('reports'); setSidebarActive && setSidebarActive('reports'); } },
  { id:'nav:audit',     label:'Physical Stock Check',category:'Navigate', hint:'Alt+U',
    keywords:'audit physical check count', iconHtml:'🔎',
    guard: () => _palAccess('new_voucher_entries'),
    run: () => { window.location.href = '/pm_stock/audit'; } },

  // ── Create ───────────────────────────────────────────────────────
  // All Create actions are gated by new_voucher_entries (the master switch
  // for voucher creation). Individual feature gates layer on top if needed.
  { id:'create:grn',    label:'New GRN',             category:'Create', hint:'Alt+B',
    keywords:'new grn goods receipt inward', iconHtml:'➕',
    guard: () => _palAccess('new_voucher_entries'),
    run: () => pmvOpen && pmvOpen('grn') },
  { id:'create:dn',     label:'New Delivery Note',   category:'Create', hint:'Alt+E',
    keywords:'new delivery note dn outward dispatch', iconHtml:'🚚',
    guard: () => _palAccess('new_voucher_entries'),
    run: () => openDnModal && openDnModal() },
  { id:'create:allot',  label:'New Allotment',       category:'Create', hint:'Alt+J',
    keywords:'new allotment material packing fg', iconHtml:'📦',
    guard: () => _palAccess('new_voucher_entries'),
    run: () => openAllotmentPicker && openAllotmentPicker() },
  { id:'create:mr',     label:'New Material Request',category:'Create',
    keywords:'new material request requisition', iconHtml:'📝',
    guard: () => _palAccess('material_request'),
    run: () => openMrCreateModal && openMrCreateModal() },
  { id:'create:split',  label:'Split a Box',         category:'Create',
    keywords:'split box divide repack', iconHtml:'✂️',
    guard: () => _palAccess('split_box'),
    run: () => openSplitBoxModal && openSplitBoxModal() },

  // ── Open / Settings ──────────────────────────────────────────────
  { id:'open:vno',      label:'Voucher Numbering',   category:'Open', hint:'Alt+T',
    keywords:'voucher numbering prefix suffix series', iconHtml:'🏷️',
    guard: () => _palAccess('voucher_settings'),
    run: () => pmvOpenVoucherSettings && pmvOpenVoucherSettings() },
  { id:'open:reprint-mine',label:'My Reprint Requests', category:'Open',
    keywords:'reprint requests labels mine', iconHtml:'🖨️',
    guard: () => _palAccess('reprint_requests'),
    run: () => openMyReprintRequestsModal && openMyReprintRequestsModal() },
  { id:'open:perms',    label:'Voucher Permissions', category:'Admin', hint:'Alt+P',
    keywords:'permissions roles voucher type', iconHtml:'🛡️', adminOnly:true,
    run: () => openVoucherPermsModal && openVoucherPermsModal() },
  { id:'open:user-access',label:'User Access Control', category:'Admin',
    keywords:'user access per-user control permissions', iconHtml:'👥', adminOnly:true,
    run: () => openUserAccessModal && openUserAccessModal() },
  { id:'open:reprint-approvals',label:'Reprint Approvals', category:'Admin', hint:'Alt+O',
    keywords:'reprint approvals admin pending', iconHtml:'✅', adminOnly:true,
    run: () => openReprintApprovalsModal && openReprintApprovalsModal() },
  { id:'open:recycle',  label:'Recycle Bin',         category:'Admin', hint:'Alt+Z',
    keywords:'recycle bin deleted trash restore', iconHtml:'🗑️', adminOnly:true,
    run: () => openRecycleBinModal && openRecycleBinModal() },
  { id:'open:fifo',     label:'FIFO Settings',       category:'Admin',
    keywords:'fifo settings rotation expiry', iconHtml:'⚙️', adminOnly:true,
    run: () => openFifoSettingsModal && openFifoSettingsModal() },
];

/* ── PUBLIC API ──────────────────────────────────────────────────── */

async function openPalette(){
  if(_palState.open) return;
  // Access gate: same check as the dock. Non-admins without
  // command_palette get nothing — no overlay, no toast, just a silent
  // no-op (the same as a keystroke being ignored). Admins always pass.
  if(!_palIsAdmin() && !_palAccess('command_palette')) return;
  _palState.open      = true;
  _palState.query     = '';
  _palState.highlight = 0;
  _palState.dataResults = { vouchers: [], products: [] };
  const ov = document.getElementById('palOverlay');
  if(!ov){ console.warn('Palette overlay not in DOM'); return; }
  ov.style.display = 'flex';
  // Focus the input next tick so the keyDown that opened us doesn't
  // get re-handled by the input.
  setTimeout(() => {
    const inp = document.getElementById('palInput');
    if(inp){ inp.value = ''; inp.focus(); }
  }, 0);
  // Pull recents in background. If it fails, the recents section just
  // stays empty and the user sees the default action list.
  try {
    const res = await fetch('/api/pm_stock/palette/recent?n=6');
    const d   = await res.json();
    if(d.status === 'ok' && Array.isArray(d.actions)){
      _palState.recents = d.actions.map(a => a.action_id);
    } else {
      _palState.recents = [];
    }
  } catch(_){
    _palState.recents = [];
  }
  _palRender();
}

function closePalette(){
  _palState.open = false;
  const ov = document.getElementById('palOverlay');
  if(ov) ov.style.display = 'none';
}

/* ── INTERNAL: matching, rendering, dispatch ─────────────────────── */

// Visible actions for the current user (filters out adminOnly when needed).
function _palVisibleActions(){
  const isAdmin = _palIsAdmin();
  return _PAL_ACTIONS.filter(a => {
    if(a.adminOnly && !isAdmin) return false;
    if(typeof a.guard === 'function' && !a.guard()) return false;
    return true;
  });
}

// Score a string against a query. Lower score = better match. Returns
// null if there's no plausible match.
function _palScore(text, q){
  if(!q) return 0;
  const t = String(text || '').toLowerCase();
  const lq = q.toLowerCase();
  if(!t) return null;
  if(t === lq)            return 0;
  if(t.startsWith(lq))    return 1;
  // Word-boundary prefix match (e.g. "vp" matches "Voucher Permissions"
  // via initials, "vp" -> v + p)
  const words = t.split(/[\s\-_]+/).filter(Boolean);
  const initials = words.map(w => w[0] || '').join('');
  if(initials.startsWith(lq)) return 2;
  if(t.indexOf(lq) >= 0)      return 3;
  // Subsequence match — every char of q appears in t in order, but not
  // necessarily contiguous. e.g. "vpm" matches "Voucher PerMissions".
  let qi = 0;
  for(let i = 0; i < t.length && qi < lq.length; i++){
    if(t[i] === lq[qi]) qi++;
  }
  if(qi === lq.length) return 4 + (t.length / 100);
  return null;
}

// Score an action against the query. Considers label + keywords.
function _palMatchAction(a, q){
  if(!q){
    return { score: 100, highlight: [] };   // placeholder for empty-query render
  }
  const labelScore = _palScore(a.label, q);
  const kwScore    = a.keywords ? _palScore(a.keywords, q) : null;
  const idScore    = _palScore(a.id, q);
  const candidates = [labelScore, kwScore, idScore].filter(s => s !== null);
  if(!candidates.length) return null;
  return { score: Math.min(...candidates) };
}

// Bold the matched substring of `text` for display (case-insensitive).
function _palHighlight(text, q){
  if(!q) return text;
  const t = String(text || '');
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if(i < 0) return t;
  return t.substring(0, i) +
    '<strong style="color:#1A73E8;font-weight:800">' + t.substring(i, i + q.length) + '</strong>' +
    t.substring(i + q.length);
}

// Main result builder — call after every input change.
function _palBuildResults(){
  const q = (_palState.query || '').trim();
  const visible = _palVisibleActions();
  let results = [];

  if(!q){
    // Empty palette: recents first, then everything else by category order.
    const recentIds = new Set(_palState.recents);
    const recentItems = [];
    for(const id of _palState.recents){
      const a = visible.find(x => x.id === id);
      if(a) recentItems.push({ action: a, isRecent: true });
    }
    const rest = visible.filter(a => !recentIds.has(a.id))
      .map(a => ({ action: a, isRecent: false }));
    results = recentItems.concat(rest);
  } else {
    // Query: rank by score, drop nulls
    const scored = [];
    for(const a of visible){
      const m = _palMatchAction(a, q);
      if(m) scored.push({ action: a, score: m.score });
    }
    scored.sort((x, y) => x.score - y.score);
    results = scored.map(s => ({ action: s.action, isRecent: false }));
    // Append data results if any
    for(const v of (_palState.dataResults.vouchers || [])){
      results.push({ data: v, kind: 'voucher' });
    }
    for(const p of (_palState.dataResults.products || [])){
      results.push({ data: p, kind: 'product' });
    }
  }
  _palState.results = results;
  if(_palState.highlight >= results.length) _palState.highlight = Math.max(0, results.length - 1);
}

function _palRender(){
  _palBuildResults();
  const list = document.getElementById('palList');
  if(!list) return;
  const q = _palState.query || '';
  if(!_palState.results.length){
    list.innerHTML = `<div style="padding:30px 18px;font-size:12.5px;color:var(--hmuted,#9ca3af);text-align:center;font-style:italic">No matches for "${q}"</div>`;
    return;
  }
  // Group rendering — section header + items
  // For the empty-query case we split into "Recently used" + categories.
  // For querying we show a single flat ranked list.
  let html = '';
  let i = 0;
  if(!q){
    const recents = _palState.results.filter(r => r.isRecent);
    const others  = _palState.results.filter(r => !r.isRecent);
    if(recents.length){
      html += `<div style="padding:6px 16px 4px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px">Recently used</div>`;
      for(const r of recents){
        html += _palRowHtml(r, i, q);
        i++;
      }
    }
    if(others.length){
      // Group "others" by category
      const cats = ['Navigate', 'Create', 'Open', 'Admin'];
      for(const cat of cats){
        const inCat = others.filter(r => (r.action || {}).category === cat);
        if(!inCat.length) continue;
        html += `<div style="padding:8px 16px 4px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px">${cat}</div>`;
        for(const r of inCat){
          html += _palRowHtml(r, i, q);
          i++;
        }
      }
    }
  } else {
    // Query mode — single flat list. Insert section divider before
    // first data result so user sees the action/data boundary.
    let lastKind = null;
    for(const r of _palState.results){
      const thisKind = r.data ? r.kind : 'action';
      if(thisKind !== lastKind){
        if(thisKind === 'voucher'){
          html += `<div style="padding:8px 16px 4px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px">Vouchers</div>`;
        } else if(thisKind === 'product'){
          html += `<div style="padding:8px 16px 4px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px">Products</div>`;
        } else if(thisKind === 'action' && lastKind === null){
          html += `<div style="padding:6px 16px 4px;font-size:10px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.5px">Actions</div>`;
        }
        lastKind = thisKind;
      }
      html += _palRowHtml(r, i, q);
      i++;
    }
  }
  list.innerHTML = html;
  // Scroll highlighted row into view
  const hi = list.querySelector(`.pal-row[data-idx="${_palState.highlight}"]`);
  if(hi) hi.scrollIntoView({ block: 'nearest' });
}

function _palRowHtml(r, idx, q){
  const isHi = (idx === _palState.highlight);
  const rowBg = isHi ? 'background:rgba(26,115,232,.08)' : '';
  if(r.action){
    const a = r.action;
    const labelH = _palHighlight(a.label, q);
    const hint = a.hint
      ? `<span style="font-size:10px;color:var(--hmuted,#9ca3af);padding:2px 6px;border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:4px;font-family:monospace">${a.hint}</span>`
      : '';
    const cat = `<span style="font-size:9.5px;font-weight:800;color:var(--hmuted2,#6b7280);text-transform:uppercase;letter-spacing:.4px">${a.category}</span>`;
    return `
      <div class="pal-row" data-idx="${idx}" data-action="${a.id}"
           onclick="_palInvokeIdx(${idx})"
           onmouseover="_palState.highlight=${idx};_palRender()"
           style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;${rowBg}">
        <div style="font-size:16px;min-width:22px;text-align:center">${a.iconHtml || '·'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--htxtb,#111)">${labelH}</div>
          <div style="margin-top:1px">${cat}</div>
        </div>
        ${hint}
      </div>`;
  }
  // Data row (voucher / product)
  if(r.data){
    if(r.kind === 'voucher'){
      const v = r.data;
      const vnH = _palHighlight(v.voucher_no || '', q);
      const det = (v.detail1 ? String(v.detail1) : '') + (v.detail2 ? ' · ' + String(v.detail2) : '');
      const kindLabel = ({grn:'GRN',dn:'DN',mtv:'MTV',mr:'Material Request'}[v.kind]) || v.kind;
      return `
        <div class="pal-row" data-idx="${idx}"
             onclick="_palInvokeIdx(${idx})"
             onmouseover="_palState.highlight=${idx};_palRender()"
             style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;${rowBg}">
          <div style="font-size:16px;min-width:22px;text-align:center">📄</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;font-family:monospace;color:var(--teal,#0d9488)">${vnH}</div>
            <div style="margin-top:1px;font-size:10.5px;color:var(--hmuted,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${kindLabel}${det ? ' · '+det : ''}</div>
          </div>
        </div>`;
    }
    if(r.kind === 'product'){
      const p = r.data;
      const nameH = _palHighlight(p.product_name || '', q);
      const codeH = _palHighlight(p.product_code || '', q);
      const type  = p.pm_type ? `[${p.pm_type}] ` : '';
      return `
        <div class="pal-row" data-idx="${idx}"
             onclick="_palInvokeIdx(${idx})"
             onmouseover="_palState.highlight=${idx};_palRender()"
             style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;${rowBg}">
          <div style="font-size:16px;min-width:22px;text-align:center">📦</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--htxtb,#111)">${type}${nameH}</div>
            <div style="margin-top:1px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-family:monospace">${codeH}</div>
          </div>
        </div>`;
    }
  }
  return '';
}

function _palInvokeIdx(idx){
  const r = _palState.results[idx];
  if(!r) return;
  if(r.action){
    _palInvokeAction(r.action);
  } else if(r.data){
    _palInvokeData(r);
  }
}

function _palInvokeAction(a){
  // Track usage (fire-and-forget — failures don't block navigation)
  try {
    fetch('/api/pm_stock/palette/track', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action_id: a.id })
    });
  } catch(_){}
  closePalette();
  try { a.run && a.run(); }
  catch(e){
    if(typeof showToast === 'function') showToast('Action failed: '+e.message, 'error');
    console.error('Palette action failed:', e);
  }
}

function _palInvokeData(r){
  closePalette();
  if(r.kind === 'voucher'){
    const v = r.data;
    if(v.kind === 'mr'){
      // Material Requests have their own detail modal.
      if(typeof openMrDetail === 'function') { openMrDetail(v.id); return; }
    }
    // GRN, DN, and MTV all live in the voucher log ('grn' tab) and open via
    // their row's expand button (toggleVoucherDetails). The expand buttons
    // carry data-expand-btn="<vtype>-<vid>" where vtype is grn | mt | dn.
    const vtypeMap = { grn:'grn', dn:'dn', mtv:'mt' };
    const vtype = vtypeMap[v.kind];
    if(!vtype) return;
    switchTab && switchTab('grn');
    setSidebarActive && setSidebarActive('grn');
    // Pre-filter the voucher log to this voucher number so it lands on page 1
    // even if there are hundreds of vouchers, then expand its row.
    const vno = v.voucher_no || '';
    setTimeout(() => {
      // Clear the date range first — the log defaults to today's date, which
      // would hide a voucher from any other day. Then filter by voucher no.
      const df = document.getElementById('grn-from');
      const dt = document.getElementById('grn-to');
      if(df) df.value = '';
      if(dt) dt.value = '';
      const sb = document.getElementById('grn-search');
      if(sb && vno){
        sb.value = vno;
        if(typeof loadVoucherLog === 'function') loadVoucherLog();
      }
    }, 250);
    // Poll briefly for the row (the list reloads asynchronously after the
    // filter is applied), then expand it and scroll it into view.
    let tries = 0;
    const tryOpen = () => {
      const btn = document.querySelector(`[data-expand-btn="${vtype}-${v.id}"]`);
      if(btn){
        if(btn.dataset.expanded !== '1' && typeof toggleVoucherDetails === 'function'){
          toggleVoucherDetails(vtype, v.id, btn, true);
        }
        const row = btn.closest('tr');
        if(row){
          row.scrollIntoView({ block:'center', behavior:'smooth' });
          row.style.transition = 'background .3s';
          const old = row.style.background;
          row.style.background = 'rgba(70,72,212,.12)';
          setTimeout(() => { row.style.background = old; }, 1400);
        }
        return;
      }
      if(tries++ < 25) setTimeout(tryOpen, 160);   // ~4s max
      else if(typeof showToast === 'function'){
        showToast('Found ' + (vno||'voucher') + ', but couldn\'t open it automatically — it\'s now filtered in the voucher log.', 'info', 4000);
      }
    };
    setTimeout(tryOpen, 550);   // start after the filter reload kicks in
  } else if(r.kind === 'product'){
    // Switch to products tab + scroll to the product
    switchTab && switchTab('products');
    setSidebarActive && setSidebarActive('products');
    // Try to scroll/select the product row
    setTimeout(() => {
      const row = document.querySelector(`[data-product-id="${r.data.id}"]`);
      if(row) row.scrollIntoView({ block: 'center' });
    }, 300);
  }
}

/* ── INPUT HANDLERS ──────────────────────────────────────────────── */

function _palOnInput(){
  const inp = document.getElementById('palInput');
  _palState.query     = inp ? inp.value : '';
  _palState.highlight = 0;
  // Trigger debounced data search when query is meaningful
  clearTimeout(_palState.searchTimer);
  if(_palState.query.trim().length >= 2){
    _palState.searchTimer = setTimeout(_palRunDataSearch, 220);
  } else {
    _palState.dataResults = { vouchers: [], products: [] };
  }
  _palRender();
}

async function _palRunDataSearch(){
  const q = (_palState.query || '').trim();
  if(q.length < 2) return;
  try {
    const res = await fetch('/api/pm_stock/palette/search?q=' + encodeURIComponent(q));
    const d   = await res.json();
    if(d.status === 'ok'){
      _palState.dataResults = {
        vouchers: d.vouchers || [],
        products: d.products || [],
      };
      // Only re-render if the user hasn't changed the query in the meantime
      if((_palState.query || '').trim() === q){
        _palRender();
      }
    }
  } catch(_){}
}

function _palOnKey(ev){
  if(ev.key === 'Escape'){
    closePalette();
    ev.preventDefault();
    return;
  }
  if(ev.key === 'ArrowDown'){
    _palState.highlight = Math.min((_palState.results.length || 1) - 1, _palState.highlight + 1);
    _palRender();
    ev.preventDefault();
    return;
  }
  if(ev.key === 'ArrowUp'){
    _palState.highlight = Math.max(0, _palState.highlight - 1);
    _palRender();
    ev.preventDefault();
    return;
  }
  if(ev.key === 'Enter'){
    _palInvokeIdx(_palState.highlight);
    ev.preventDefault();
    return;
  }
}

// Global Ctrl+K / ⌘K handler. Bound at script load so it works from
// anywhere on the page.
document.addEventListener('keydown', (ev) => {
  const isCmdK = (ev.key === 'k' || ev.key === 'K') && (ev.ctrlKey || ev.metaKey);
  if(!isCmdK) return;
  ev.preventDefault();
  if(_palState.open) closePalette();
  else                openPalette();
});

// Click outside the inner palette closes it.
document.addEventListener('click', (ev) => {
  if(!_palState.open) return;
  const ov = document.getElementById('palOverlay');
  const inner = document.getElementById('palInner');
  if(ov && inner && ev.target === ov){
    closePalette();
  }
});


/* ── Exports for the floating Dock (pm_stock_dock.js) ──────────────────
   The dock reuses the palette's action registry, usage tracking, and the
   data-hit router so there's a single source of truth for "what can be
   done / searched" on this page. */
window._PAL_ACTIONS = _PAL_ACTIONS;

window._palActionById = function(id){
  return _PAL_ACTIONS.find(a => a.id === id) || null;
};

// Visible (allowed) actions for the current user — respects adminOnly + guard.
window._palVisibleActions = function(){
  const isAdmin = _palIsAdmin();
  return _PAL_ACTIONS.filter(a => {
    if(a.adminOnly && !isAdmin) return false;
    if(typeof a.guard === 'function'){ try { if(!a.guard()) return false; } catch(_){ return false; } }
    return true;
  });
};

// Run an action by id (tracks usage, then runs). Does NOT touch the palette.
window._palRunActionById = function(id){
  const a = window._palActionById(id);
  if(!a) return false;
  try {
    fetch('/api/pm_stock/palette/track', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action_id: a.id })
    });
  } catch(_){}
  try { a.run && a.run(); return true; }
  catch(e){
    if(typeof showToast === 'function') showToast('Action failed: '+e.message, 'error');
    console.error('Dock action failed:', e);
    return false;
  }
};

// Route a data hit (voucher/product) from the dock search to its detail view.
window._palRouteDataHit = function(hit){
  try { _palInvokeData(hit); } catch(e){ console.error('Dock data route failed:', e); }
};
