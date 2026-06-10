/* ════════════════════════════════════════════════════════════
   INVENTORY · RM GODOWN-WISE STOCK MANAGEMENT  (Phase 1)
   HCP Wellness · inventory_godown.js
   ────────────────────────────────────────────────────────────
   Adds three panels to inventory_mgmt:
     • Godown View          — three-pane drill-down + QR scan
     • Manage Godowns       — CRUD on procurement_godowns
     • Opening Stock Entry  — single-material box creator

   QR handheld scanner: this module sets up its own global
   keypress interceptor (independent of pm_stock_qr.js) so it
   works WITHOUT depending on the PM Stock module being loaded.

   Box code format: RM-MATCODE-G####-B###  or RM-MATCODE-OP####-B###
═══════════════════════════════════════════════════════════ */

(function(){

  /* ── State ────────────────────────────────────────────────── */
  let _gvGodowns      = [];
  let _gvActiveGid    = 0;
  let _gvItems        = [];
  let _gvActiveMid    = 0;
  let _gvBoxes        = [];
  let _gvStatus       = 'in_stock';

  let _mgGodowns      = [];
  let _mgEditId       = null;

  // Tiny helpers
  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const fmtN  = (n, dec=0) => Number(n || 0).toLocaleString('en-IN', {maximumFractionDigits: dec});
  const fmtQty = (n, uom) => `${fmtN(n, 3)} <span style="color:var(--nb-text-muted);font-size:10px">${esc(uom||'')}</span>`;

  // Regex for RM box codes
  // Accepts BOTH the new short codes (RM-A0000035 from GRN/opening) AND the
  // legacy long codes (RM-A-G001-B01 / RM-...-OP001-B01).
  const RM_BOX_RE = /^RM-(?:[A-Z0-9]{1,10}-(?:G|OP)\d{3,5}-B\d{2,4}|[A-Z0-9]{3,12})$/i;

  /* ─────────────────────────────────────────────────────────────
     GLOBAL HANDHELD SCANNER INTERCEPTOR
     Buffers fast keypress bursts (USB/Bluetooth scanners), and
     on Enter, if the buffer matches an RM box code, opens the
     box-history modal. Stays out of the way of normal inputs.
  ─────────────────────────────────────────────────────────────── */
  (function setupScanInterceptor(){
    let buf = '', lastT = 0;
    const NATIVE_IDS = new Set(['inv-godown-scan-input']);

    document.addEventListener('keypress', function(e){
      const now  = Date.now();
      const fast = (now - lastT) < 80;
      if(now - lastT > 300) buf = '';
      lastT = now;

      const el = document.activeElement;
      const inNative = el && NATIVE_IDS.has(el.id);
      if(inNative){ buf = ''; return; }  // native input handles its own Enter

      if(e.key === 'Enter'){
        const raw = buf.trim();
        buf = '';
        if(!RM_BOX_RE.test(raw)) return;
        // Don't intercept if a form input is active
        const skip = el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT');
        if(skip) return;
        e.preventDefault();
        // Only fire if the Godown View panel is open
        const panel = document.getElementById('panel-godown-view');
        if(panel && panel.classList.contains('active')){
          window.invGvScanLookup(raw);
        }
      } else {
        buf += e.key;
      }
    });
  })();

  /* ═══════════════════════════════════════════════════════════════
     PANEL ACTIVATION HOOK
     We wrap the existing invSwitchPanel from inventory_mgmt.js so
     when the user opens one of our new panels, we lazy-load data.
  ═══════════════════════════════════════════════════════════════ */
  const _origSwitch = window.invSwitchPanel;
  window.invSwitchPanel = function(name){
    if(typeof _origSwitch === 'function') _origSwitch(name);

    // The original function may not handle our new panel IDs — do it ourselves.
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.inv-nav-item').forEach(n => n.classList.remove('active'));
    const panel = document.getElementById('panel-' + name);
    if(panel) panel.classList.add('active');
    const nav = document.querySelector(`.inv-nav-item[data-panel="${name}"]`);
    if(nav) nav.classList.add('active');

    if(name === 'godown-view')      invGvLoad();
    if(name === 'manage-godowns')   invMgLoad();
    if(name === 'opening-stock')    invOpInit();
    // invTrInit is defined in inventory_transfers.js — call it only if loaded
    if(name === 'stock-transfers' && typeof window.invTrInit === 'function') {
      window.invTrInit();
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     GODOWN VIEW
  ═══════════════════════════════════════════════════════════════ */

  window.invGvLoad = async function(){
    const wrap = $('gv-godowns-pane-body');
    if(wrap) wrap.innerHTML = `<div class="igd-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      _gvGodowns = j.godowns || [];
      _renderGvGodownsPane();
      if(!_gvActiveGid){
        const first = _gvGodowns.find(g => (g.total_boxes||0) > 0) || _gvGodowns[0];
        if(first) invGvSelectGodown(first.id);
      } else {
        await _gvLoadItems();
      }
      setTimeout(() => { const sc = $('inv-godown-scan-input'); if(sc) sc.focus(); }, 100);
    } catch(e){
      if(wrap) wrap.innerHTML = `<div class="igd-loading" style="color:var(--nb-danger)">⚠ ${esc(e.message)}</div>`;
    }
  };

  function _renderGvGodownsPane(){
    const wrap = $('gv-godowns-pane-body');
    if(!wrap) return;

    if(!_gvGodowns.length){
      wrap.innerHTML = `
        <div class="igd-empty">
          <i class="fas fa-warehouse" style="font-size:32px;color:var(--nb-border-strong)"></i>
          <p>No godowns yet</p>
          <button class="igd-btn igd-btn-primary igd-btn-sm" onclick="invSwitchPanel('manage-godowns')">
            <i class="fas fa-plus"></i> Add a godown
          </button>
        </div>`;
      return;
    }

    const total_q = _gvGodowns.reduce((s,g) => s + (g.total_qty || 0), 0);
    const total_i = _gvGodowns.reduce((s,g) => s + (g.distinct_items || 0), 0);
    const total_b = _gvGodowns.reduce((s,g) => s + (g.total_boxes || 0), 0);

    let html = _gvCardHtml({
      id: 0, name: 'All Godowns', type: 'all',
      distinct_items: total_i, total_boxes: total_b, total_qty: total_q,
    }, _gvActiveGid === 0);

    for(const g of _gvGodowns){
      html += _gvCardHtml(g, _gvActiveGid === g.id);
    }
    wrap.innerHTML = html;
  }

  function _gvCardHtml(g, active){
    const typeStyles = {
      godown:   'background:#0ea5e91a;color:var(--nb-primary)',
      floor:    'background:#f59e0b1a;color:var(--nb-warning)',
      billing:  'background:#6b72801a;color:var(--nb-text-muted)',
      shipping: 'background:#8b5cf61a;color:var(--nb-purple)',
      all:      'background:#7c3aed1a;color:var(--nb-purple)',
    };
    return `
      <div class="igd-gd-card ${active ? 'active' : ''}" onclick="invGvSelectGodown(${g.id})">
        <div class="igd-gd-head">
          <div class="igd-gd-name">${esc(g.name)}</div>
          <span class="igd-type-chip" style="${typeStyles[g.type]||typeStyles.godown}">${esc(g.type||'godown')}</span>
        </div>
        <div class="igd-gd-meta">
          <span><i class="fas fa-cube"></i> ${fmtN(g.distinct_items)} items</span>
          <span><i class="fas fa-box"></i> ${fmtN(g.total_boxes)} pkg.</span>
        </div>
      </div>`;
  }

  window.invGvSelectGodown = function(gid){
    _gvActiveGid = parseInt(gid) || 0;
    _gvActiveMid = 0;
    _gvBoxes     = [];
    _renderGvGodownsPane();
    _gvLoadItems();
    _renderGvBoxesPane();
  };

  async function _gvLoadItems(){
    const wrap = $('gv-items-pane-body');
    const ttl  = $('gv-items-pane-title');
    if(ttl){
      const g = _gvGodowns.find(x => x.id === _gvActiveGid);
      ttl.textContent = _gvActiveGid === 0 ? 'Items (all godowns)' : `Items at ${g ? g.name : '?'}`;
    }
    if(wrap) wrap.innerHTML = `<div class="igd-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    try {
      const params = new URLSearchParams({
        godown_id: String(_gvActiveGid || 0),
        status:    _gvStatus,
      });
      const r = await fetch('/api/inventory_godown/items_at?' + params);
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      _gvItems = j.items || [];
      _renderGvItemsPane();
    } catch(e){
      if(wrap) wrap.innerHTML = `<div class="igd-loading" style="color:var(--nb-danger)">⚠ ${esc(e.message)}</div>`;
    }
  }

  function _renderGvItemsPane(){
    const wrap = $('gv-items-pane-body');
    if(!wrap) return;
    if(!_gvItems.length){
      wrap.innerHTML = `
        <div class="igd-empty">
          <i class="fas fa-cube" style="font-size:28px;color:var(--nb-border-strong)"></i>
          <p>No items here yet</p>
          <button class="igd-btn igd-btn-primary igd-btn-sm" onclick="invSwitchPanel('opening-stock')">
            <i class="fas fa-plus"></i> Add opening stock
          </button>
        </div>`;
      return;
    }
    const q = ($('gv-items-search')?.value || '').trim().toLowerCase();
    const list = q
      ? _gvItems.filter(it => (it.material_name||'').toLowerCase().includes(q)
                           || (it.group_name||'').toLowerCase().includes(q))
      : _gvItems;
    if(!list.length){
      wrap.innerHTML = `<div class="igd-empty"><p>No items match "${esc(q)}"</p></div>`;
      return;
    }
    wrap.innerHTML = list.map(it => `
      <div class="igd-it-card ${it.material_id === _gvActiveMid ? 'active' : ''}"
           onclick="invGvSelectItem(${it.material_id})"
           oncontextmenu="invGvItemMenu(event, ${it.material_id}); return false;"
           data-mid="${it.material_id}" data-mname="${esc(it.material_name)}" data-uom="${esc(it.uom||'')}">
        <div class="igd-it-name">${esc(it.material_name)}</div>
        ${it.group_name ? `<div class="igd-it-group">${esc(it.group_name)}</div>` : ''}
        <div class="igd-it-meta">
          <span class="igd-it-qty">${fmtQty(it.total_qty, it.uom)}</span>
          <span class="igd-it-boxes">${fmtN(it.box_count)} pkg.</span>
        </div>
      </div>
    `).join('');
  }

  window.invGvItemsSearchInput = function(){ _renderGvItemsPane(); };

  window.invGvSelectItem = async function(mid){
    _gvActiveMid = parseInt(mid) || 0;
    _renderGvItemsPane();
    await _gvLoadBoxes();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ADD TO REQUEST — right-click an item → add it to one of MY draft requests
  // ═══════════════════════════════════════════════════════════════════════
  let _gvMenuEl = null;
  window.invGvItemMenu = function(ev, mid){
    ev.preventDefault();
    _gvCloseMenu();
    const card = ev.currentTarget;
    const mname = card?.getAttribute('data-mname') || '';
    const uom   = card?.getAttribute('data-uom') || '';
    const m = document.createElement('div');
    m.className = 'gv-ctx-menu';
    m.style.cssText = `position:fixed;z-index:9500;left:${ev.clientX}px;top:${ev.clientY}px;
      background:#fff;border:1px solid #e3e3e0;border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.22);
      padding:6px;min-width:180px;font-size:13px`;
    m.innerHTML = `
      <div style="padding:6px 10px;font-weight:700;color:#1f1f1f;border-bottom:1px solid #f0f0f0;margin-bottom:4px;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">${esc(mname)}</div>
      <button class="gv-ctx-item" style="display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;
              padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13px;color:#4648d4;text-align:left">
        <i class="fas fa-cart-plus"></i> Add to request…
      </button>`;
    m.querySelector('.gv-ctx-item').onclick = () => { _gvCloseMenu(); invGvAddToRequest(mid, mname, uom); };
    m.querySelector('.gv-ctx-item').onmouseenter = e => e.target.style.background = '#eef0ff';
    m.querySelector('.gv-ctx-item').onmouseleave = e => e.target.style.background = 'none';
    document.body.appendChild(m);
    _gvMenuEl = m;
    // reposition if off right/bottom edge
    const r = m.getBoundingClientRect();
    if(r.right > innerWidth)  m.style.left = (ev.clientX - r.width) + 'px';
    if(r.bottom > innerHeight) m.style.top  = (ev.clientY - r.height) + 'px';
    setTimeout(() => document.addEventListener('click', _gvCloseMenu, { once:true }), 0);
  };
  function _gvCloseMenu(){ if(_gvMenuEl){ _gvMenuEl.remove(); _gvMenuEl = null; } }

  window.invGvAddToRequest = async function(mid, mname, uom){
    const srcGid = _gvActiveGid || 0;   // godown the item is viewed at (0 = all)
    const srcName = (_gvGodowns.find(g => g.id === srcGid)||{}).name || '';
    // Fetch the current user's drafts.
    let drafts = [];
    try {
      const r = await fetch('/api/inventory_mgmt/material_request/list?status=draft&mine=1');
      const j = await r.json();
      drafts = (j.requests || []);
    } catch(e){ drafts = []; }

    const host = document.getElementById('gvAddReqModal') || (() => {
      const d = document.createElement('div'); d.id = 'gvAddReqModal'; document.body.appendChild(d); return d;
    })();

    // Godown options for "create new draft" (exclude the source godown — you
    // can't request a material into the very godown it's already in).
    const godownOpts = _gvGodowns
      .filter(g => g.id && g.id !== srcGid)
      .map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');

    // Draft <option>s. Mark drafts whose destination == source godown as
    // disabled (same-location → pointless / hard-stopped).
    const draftOpts = drafts.map(d => {
      const clash = srcGid && Number(d.dest_godown_id) === Number(srcGid);
      return `<option value="${d.id}" data-dest="${d.dest_godown_id}" ${clash?'disabled':''}>`
        + `${esc(d.request_no)} — ${esc(d.dest_godown_name||('#'+d.dest_godown_id))} (${d.item_count||0} items)`
        + `${clash?'  — same location, cannot add':''}</option>`;
    }).join('');
    const hasUsableDraft = drafts.some(d => !(srcGid && Number(d.dest_godown_id) === Number(srcGid)));

    host.innerHTML = `
      <div style="position:fixed;inset:0;z-index:9600;background:rgba(17,24,39,.5);
                  display:flex;align-items:center;justify-content:center;padding:20px"
           onclick="if(event.target===this) invGvAddReqClose()">
        <div style="background:#fff;border-radius:16px;width:min(460px,94vw);overflow:hidden;
                    box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <div style="background:linear-gradient(135deg,#4648d4,#6d28d9);color:#fff;padding:14px 18px;font-weight:800">
            <i class="fas fa-cart-plus"></i> Add to request
          </div>
          <div style="padding:18px">
            <div style="font-size:13px;color:#5f6368;margin-bottom:4px">Material${srcName?(' · at '+esc(srcName)):''}</div>
            <div style="font-weight:700;font-size:15px;margin-bottom:16px">${esc(mname)}</div>

            <div id="gvAddReqModeWrap" style="display:flex;gap:8px;margin-bottom:14px">
              <button type="button" id="gvModeExisting" class="btn" style="flex:1;${(drafts.length)?'':'display:none'}"
                onclick="invGvAddReqMode('existing')">Add to existing draft</button>
              <button type="button" id="gvModeNew" class="btn" style="flex:1"
                onclick="invGvAddReqMode('new')"><i class="fas fa-plus"></i> New draft</button>
            </div>

            <!-- EXISTING-DRAFT mode -->
            <div id="gvAddReqExisting" style="display:${drafts.length?'block':'none'}">
              ${drafts.length ? `
                <label style="font-size:12px;font-weight:700;color:#5f6368">Add to draft</label>
                <select id="gvAddReqDraft" style="width:100%;padding:9px 11px;border:1.5px solid #d6d9e0;border-radius:9px;margin:5px 0 14px;font-size:14px">
                  ${draftOpts}
                </select>
                ${!hasUsableDraft ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:10px;font-size:12.5px;color:#b91c1c;margin-bottom:12px">
                   All your drafts are destined for <b>${esc(srcName)}</b> — the same location this material is in. Create a draft for a different destination instead.</div>` : ''}
                <label style="font-size:12px;font-weight:700;color:#5f6368">Quantity${uom?(' ('+esc(uom)+')'):''}</label>
                <input id="gvAddReqQty" type="number" min="0" step="any" placeholder="0"
                       style="width:100%;padding:9px 11px;border:1.5px solid #d6d9e0;border-radius:9px;margin-top:5px;font-size:14px">
              ` : ''}
            </div>

            <!-- NEW-DRAFT mode -->
            <div id="gvAddReqNew" style="display:${drafts.length?'none':'block'}">
              ${godownOpts ? `
                <label style="font-size:12px;font-weight:700;color:#5f6368">Destination godown (new draft)</label>
                <select id="gvNewDraftDest" style="width:100%;padding:9px 11px;border:1.5px solid #d6d9e0;border-radius:9px;margin:5px 0 14px;font-size:14px">
                  ${godownOpts}
                </select>
                <label style="font-size:12px;font-weight:700;color:#5f6368">Quantity${uom?(' ('+esc(uom)+')'):''}</label>
                <input id="gvNewDraftQty" type="number" min="0" step="any" placeholder="0"
                       style="width:100%;padding:9px 11px;border:1.5px solid #d6d9e0;border-radius:9px;margin-top:5px;font-size:14px">
                <div style="font-size:12px;color:#6b7280;margin-top:8px">A new draft will be created${srcName?(' (destination cannot be '+esc(srcName)+', the source)'):''} and this item added to it.</div>
              ` : `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;padding:12px;font-size:13px;color:#9a3412">
                   No other godown is available as a destination.</div>`}
            </div>
          </div>
          <div style="padding:14px 18px;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" onclick="invGvAddReqClose()">Cancel</button>
            <button class="btn btn-primary" id="gvAddReqGo"
              onclick="invGvAddReqConfirm(${mid}, ${srcGid})">Add</button>
          </div>
        </div>
      </div>`;
    // Default to whichever mode is sensible.
    invGvAddReqMode(drafts.length ? 'existing' : 'new');
    setTimeout(() => document.getElementById(drafts.length?'gvAddReqQty':'gvNewDraftQty')?.focus(), 50);
  };

  window.invGvAddReqMode = function(mode){
    const ex = document.getElementById('gvAddReqExisting');
    const nw = document.getElementById('gvAddReqNew');
    const be = document.getElementById('gvModeExisting');
    const bn = document.getElementById('gvModeNew');
    const on = '#4648d4', onTxt = '#fff';
    if(ex) ex.style.display = (mode==='existing') ? 'block' : 'none';
    if(nw) nw.style.display = (mode==='new') ? 'block' : 'none';
    if(be){ be.style.background = mode==='existing'?on:''; be.style.color = mode==='existing'?onTxt:''; }
    if(bn){ bn.style.background = mode==='new'?on:''; bn.style.color = mode==='new'?onTxt:''; }
    document.getElementById('gvAddReqModeWrap')?.setAttribute('data-mode', mode);
  };

  window.invGvAddReqClose = function(){
    const h = document.getElementById('gvAddReqModal'); if(h) h.innerHTML = '';
  };

  window.invGvAddReqConfirm = async function(mid, srcGid){
    const _toast = (m,t) => { if(window.invToast) window.invToast(m,t||'info'); else console.log(m); };
    const mode = document.getElementById('gvAddReqModeWrap')?.getAttribute('data-mode') || 'existing';

    if(mode === 'new'){
      const dest = parseInt(document.getElementById('gvNewDraftDest')?.value || 0);
      const qty  = parseFloat(document.getElementById('gvNewDraftQty')?.value || 0);
      if(!dest){ _toast('Select a destination godown','warn'); return; }
      // Hard stop: destination can't be the source location.
      if(srcGid && dest === Number(srcGid)){ _toast('Destination is the same location the material is in — choose a different godown.','error'); return; }
      if(!(qty > 0)){ _toast('Enter a quantity','warn'); return; }
      try {
        // Create the draft, then add the item to it.
        const cr = await fetch('/api/inventory_mgmt/material_request/save', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ dest_godown_id: dest, items: [], as_draft: true })
        });
        const cj = await cr.json();
        if(cj.status !== 'ok'){ _toast(cj.message || 'Could not create draft','error'); return; }
        const add = await fetch(`/api/inventory_mgmt/material_request/${cj.id}/add_item`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ material_id: mid, qty_requested: qty, src_godown_id: srcGid })
        });
        const aj = await add.json();
        if(aj.status === 'ok'){ _toast(`✓ New draft ${cj.request_no} created & item added`,'success'); invGvAddReqClose(); }
        else { _toast(aj.message || 'Draft created but add failed','error'); }
      } catch(e){ _toast('Network error','error'); }
      return;
    }

    // existing-draft mode
    const sel = document.getElementById('gvAddReqDraft');
    const rid = parseInt(sel?.value || 0);
    const destGid = parseInt(sel?.selectedOptions?.[0]?.getAttribute('data-dest') || 0);
    const qty = parseFloat(document.getElementById('gvAddReqQty')?.value || 0);
    if(!rid){ _toast('Select a draft','warn'); return; }
    // Hard stop: same-location guard.
    if(srcGid && destGid === Number(srcGid)){ _toast('That draft is destined for the same location this material is in — pick another draft or create one for a different godown.','error'); return; }
    if(!(qty > 0)){ _toast('Enter a quantity','warn'); return; }
    try {
      const r = await fetch(`/api/inventory_mgmt/material_request/${rid}/add_item`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ material_id: mid, qty_requested: qty, src_godown_id: srcGid })
      });
      const d = await r.json();
      if(d.status === 'ok'){ _toast(`✓ Added to ${d.request_no}`,'success'); invGvAddReqClose(); }
      else { _toast(d.message || 'Add failed','error'); }
    } catch(e){ _toast('Network error','error'); }
  };

  async function _gvLoadBoxes(){
    const wrap = $('gv-boxes-pane-body');
    const ttl  = $('gv-boxes-pane-title');
    if(!_gvActiveMid){
      if(wrap) wrap.innerHTML = `<div class="igd-empty"><p>Pick an item to see its packages</p></div>`;
      if(ttl) ttl.textContent = 'Packages';
      return;
    }
    const it = _gvItems.find(x => x.material_id === _gvActiveMid);
    if(ttl) ttl.textContent = it ? `Packages — ${it.material_name}` : 'Packages';
    if(wrap) wrap.innerHTML = `<div class="igd-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;
    try {
      const params = new URLSearchParams({
        godown_id:   String(_gvActiveGid || 0),
        material_id: String(_gvActiveMid),
        status:      _gvStatus,
      });
      const r = await fetch('/api/inventory_godown/boxes_at?' + params);
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      _gvBoxes = j.boxes || [];
      _renderGvBoxesPane();
    } catch(e){
      if(wrap) wrap.innerHTML = `<div class="igd-loading" style="color:var(--nb-danger)">⚠ ${esc(e.message)}</div>`;
    }
  }

  function _renderGvBoxesPane(){
    const wrap = $('gv-boxes-pane-body');
    if(!wrap) return;
    if(!_gvActiveMid){
      wrap.innerHTML = `<div class="igd-empty"><p>Pick an item to see its packages</p></div>`;
      return;
    }
    if(!_gvBoxes.length){
      wrap.innerHTML = `<div class="igd-empty"><p>No packages</p></div>`;
      return;
    }
    const statusStyles = {
      in_stock:   'background:var(--nb-success-light);color:var(--nb-success)',
      in_transit: 'background:var(--nb-amber-light);color:var(--nb-warning)',
      consumed:   'background:var(--nb-indigo-light);color:var(--nb-indigo)',
      damaged:    'background:var(--nb-danger-light);color:var(--nb-danger)',
      lost:       'background:var(--nb-danger-light);color:var(--nb-danger)',
    };
    wrap.innerHTML = _gvBoxes.map(b => `
      <div class="igd-bx-card" data-box-id="${b.box_id}"
           ondblclick="invGvOpenBoxHistory(${b.box_id})"
           onclick="invGvHighlightBox(${b.box_id})">
        <div class="igd-bx-head">
          <code class="igd-bx-code">${esc(b.box_code)}</code>
          <span class="igd-bx-status" style="${statusStyles[b.current_status]||statusStyles.in_stock}">
            ${esc((b.current_status||'').replace('_',' ').toUpperCase())}
          </span>
        </div>
        <div class="igd-bx-meta">
          <span>${fmtN(b.per_box_qty, 3)} ${esc(b.uom||'')}</span>
          <span>${b.source === 'opening' ? '<i class="fas fa-flag" title="Opening stock"></i> Opening' : `GRN ${esc(b.grn_no||'—')}`}</span>
          <span style="color:var(--nb-text-muted)">${esc(_invOpFmtDate(b.created_at))}</span>
        </div>
        ${_gvActiveGid === 0 && b.godown_name ? `
          <div class="igd-bx-loc"><i class="fas fa-warehouse"></i> ${esc(b.godown_name)}</div>` : ''}
      </div>
    `).join('');
  }

  window.invGvHighlightBox = function(boxId){
    document.querySelectorAll('.igd-bx-card').forEach(el => el.classList.remove('flash'));
    const el = document.querySelector(`.igd-bx-card[data-box-id="${boxId}"]`);
    if(el){
      el.classList.add('flash');
      el.scrollIntoView({block:'nearest', behavior:'smooth'});
    }
  };

  /* ─────────────────────────────────────────────────────────────
     SCAN INPUT (native handler in the scan bar)
  ─────────────────────────────────────────────────────────────── */

  window.invGvScanKey = function(ev){
    if(ev.key !== 'Enter') return;
    ev.preventDefault();
    const inp = $('inv-godown-scan-input');
    const raw = (inp?.value || '').trim().toUpperCase();
    if(!raw) return;
    invGvScanLookup(raw);
  };

  window.invGvScanLookup = async function(raw){
    const inp = $('inv-godown-scan-input');
    const fb  = $('inv-godown-scan-feedback');
    if(fb){ fb.textContent = `🔎 Looking up ${raw}…`; fb.style.color = 'var(--nb-text-muted)'; }
    if(inp) inp.disabled = true;
    try {
      if(!RM_BOX_RE.test(raw)){
        if(fb){ fb.textContent = `✗ Not a valid RM box code`; fb.style.color = 'var(--nb-danger)'; }
        return;
      }
      const r = await fetch('/api/inventory_godown/box_history?code=' + encodeURIComponent(raw));
      const j = await r.json();
      if(j.status === 'not_found'){
        if(fb){ fb.textContent = `✗ Box ${raw} not found`; fb.style.color = 'var(--nb-danger)'; }
        return;
      }
      if(j.status !== 'ok') throw new Error(j.message || 'Lookup failed');
      if(fb){
        fb.textContent = `✓ ${j.box.material_name} · ${j.box.current_godown_name || '(unassigned)'}`;
        fb.style.color = 'var(--nb-success)';
      }
      if(inp) inp.value = '';
      // Drill the three panes all the way down to this box, then flash it.
      await invGvDrillToBox(j.box);
    } catch(e){
      if(fb){ fb.textContent = `✗ ${e.message}`; fb.style.color = 'var(--nb-danger)'; }
    } finally {
      if(inp){ inp.disabled = false; inp.focus(); }
    }
  };

  /* Walk Godown → Item → Package panes to the scanned box and highlight it.
     Uses the box's current_godown_id / material_id / box_id from box_history. */
  window.invGvDrillToBox = async function(box){
    if(!box) return;
    const gid = parseInt(box.current_godown_id) || 0;
    const mid = parseInt(box.material_id) || 0;
    const bid = parseInt(box.box_id) || 0;
    try {
      // 1) Select the box's godown (scopes the item list) and wait for items.
      _gvActiveGid = gid;
      _gvActiveMid = 0;
      _gvBoxes     = [];
      _renderGvGodownsPane();
      await _gvLoadItems();
      // 2) Select the item and wait for its packages to load.
      if(mid){
        _gvActiveMid = mid;
        _renderGvItemsPane();
        await _gvLoadBoxes();
      }
      // 3) Highlight (flash) the scanned package, scroll it into view.
      if(bid){
        // small delay so the freshly-rendered cards exist in the DOM
        setTimeout(() => invGvHighlightBox(bid), 60);
      }
    } catch(e){
      // Drill is best-effort; the feedback line already confirmed the box.
    }
  };

  /* ─────────────────────────────────────────────────────────────
     BOX HISTORY MODAL
  ─────────────────────────────────────────────────────────────── */

  window.invGvOpenBoxHistory = async function(boxId){
    const modal = $('boxHistoryModal');
    if(!modal) return;
    $('bhm-body').innerHTML = `<div class="igd-loading"><i class="fas fa-spinner fa-spin"></i> Loading history…</div>`;
    $('bhm-title').textContent = 'Package history';
    if(typeof invOpenModal === 'function') invOpenModal('boxHistoryModal');
    else modal.classList.add('open');
    try {
      const r = await fetch('/api/inventory_godown/box_history?box_id=' + encodeURIComponent(boxId));
      const j = await r.json();
      if(j.status === 'not_found'){
        $('bhm-body').innerHTML = `<div class="igd-empty">Package not found</div>`;
        return;
      }
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      invGvShowHistoryModal(j);
    } catch(e){
      $('bhm-body').innerHTML = `<div class="igd-empty" style="color:var(--nb-danger)">⚠ ${esc(e.message)}</div>`;
    }
  };

  window.invGvShowHistoryModal = function(payload){
    const box = payload.box || {};
    const grn = payload.grn || null;
    const movements = payload.movements || [];

    $('bhm-title').innerHTML = `<code style="font-family:'Courier New',monospace;font-size:14px">${esc(box.box_code)}</code>`;

    const statusColor = ({
      in_stock:   {bg:'var(--nb-success-light)', fg:'var(--nb-success)'},
      in_transit: {bg:'var(--nb-amber-light)', fg:'var(--nb-warning)'},
      consumed:   {bg:'var(--nb-indigo-light)', fg:'var(--nb-indigo)'},
      damaged:    {bg:'var(--nb-danger-light)', fg:'var(--nb-danger)'},
      lost:       {bg:'var(--nb-danger-light)', fg:'var(--nb-danger)'},
    })[box.current_status] || {bg:'var(--nb-bg)', fg:'var(--nb-text-muted)'};

    const mvType = (t) => ({
      grn_create: { icon:'fa-plus-circle',   label:'GRN received',    color:'var(--nb-success)' },
      opening:    { icon:'fa-flag',          label:'Opening stock',   color:'var(--nb-cyan)' },
      out:        { icon:'fa-arrow-right',   label:'Transferred out', color:'var(--nb-amber)' },
      in:         { icon:'fa-arrow-down',    label:'Transferred in',  color:'var(--nb-teal)' },
      consume:    { icon:'fa-flask',         label:'Consumed',        color:'var(--nb-purple)' },
      adjust:     { icon:'fa-pen-to-square', label:'Adjusted',        color:'var(--nb-text-muted)' },
      cancel:     { icon:'fa-rotate-left',   label:'Cancelled',       color:'var(--nb-text-subtle)' },
    })[t] || { icon:'fa-circle-info', label:t, color:'var(--nb-text-muted)' };

    let html = '';
    html += `
      <div class="bhm-hero">
        <div class="bhm-hero-row">
          <div>
            <div class="bhm-product-name">${esc(box.material_name)}</div>
            <div class="bhm-product-sub">RM · Box ${esc(String(box.box_seq||''))} of ${esc(String(box.total_boxes||''))}</div>
          </div>
          <span class="bhm-status-chip" style="background:${statusColor.bg};color:${statusColor.fg}">
            ${esc((box.current_status||'').replace('_',' ').toUpperCase())}
          </span>
        </div>
        <div class="bhm-hero-stats">
          <div class="bhm-stat">
            <div class="bhm-stat-lbl">Per box qty</div>
            <div class="bhm-stat-val">${fmtN(box.per_box_qty, 3)} <span style="color:var(--nb-text-muted);font-size:11px">${esc(box.uom||box.m_uom||'')}</span></div>
          </div>
          <div class="bhm-stat">
            <div class="bhm-stat-lbl">Current location</div>
            <div class="bhm-stat-val"><i class="fas fa-warehouse" style="color:var(--nb-purple);margin-right:4px"></i>${esc(box.current_godown_name||'(unassigned)')}</div>
          </div>
          <div class="bhm-stat">
            <div class="bhm-stat-lbl">Source</div>
            <div class="bhm-stat-val">${box.source === 'opening' ? '🏁 Opening stock' : `📦 GRN ${esc(box.grn_no||'—')}`}</div>
          </div>
        </div>
      </div>`;

    if(grn){
      html += `
        <div class="bhm-section">
          <div class="bhm-section-title"><i class="fas fa-truck-loading" style="color:var(--nb-success)"></i> Received via GRN</div>
          <div class="bhm-grn-card">
            <div class="bhm-grn-row"><span class="bhm-grn-lbl">GRN No</span><span class="bhm-grn-val"><strong>${esc(grn.grn_no||'—')}</strong></span></div>
            <div class="bhm-grn-row"><span class="bhm-grn-lbl">Date</span><span class="bhm-grn-val">${esc(_invOpFmtDate(grn.grn_date))}</span></div>
            <div class="bhm-grn-row"><span class="bhm-grn-lbl">Supplier</span><span class="bhm-grn-val">${esc(grn.supplier_name||'—')}</span></div>
          </div>
        </div>`;
    }

    if(movements.length){
      html += `<div class="bhm-section">
        <div class="bhm-section-title"><i class="fas fa-route" style="color:var(--nb-purple)"></i> Movement timeline (${movements.length})</div>
        <div class="bhm-timeline">`;
      for(const m of movements){
        const t = mvType(m.movement_type);
        const route = (m.from_name || m.to_name)
          ? `${m.from_name ? esc(m.from_name) : '—'} <i class="fas fa-arrow-right" style="color:var(--nb-text-muted);font-size:10px"></i> ${m.to_name ? esc(m.to_name) : '—'}`
          : '';
        html += `
          <div class="bhm-tl-item">
            <div class="bhm-tl-icon" style="background:${t.color}1a;color:${t.color}"><i class="fas ${t.icon}"></i></div>
            <div class="bhm-tl-body">
              <div class="bhm-tl-head">
                <span class="bhm-tl-label" style="color:${t.color}">${esc(t.label)}</span>
                <span class="bhm-tl-time">${esc(_invOpFmtDateTime(m.movement_at))}</span>
              </div>
              ${route ? `<div class="bhm-tl-route">${route}</div>` : ''}
              <div class="bhm-tl-foot">
                ${m.qty ? `<span>${fmtN(m.qty, 3)} units</span>` : ''}
                ${m.moved_by ? `<span>by ${esc(m.moved_by)}</span>` : ''}
                ${m.remarks ? `<span class="bhm-tl-remarks">${esc(m.remarks)}</span>` : ''}
              </div>
            </div>
          </div>`;
      }
      html += `</div></div>`;
    }

    $('bhm-body').innerHTML = html;
  };

  /* ═══════════════════════════════════════════════════════════════
     MANAGE GODOWNS
  ═══════════════════════════════════════════════════════════════ */

  window.invMgLoad = async function(){
    const tbody = $('mg-tbody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="9" class="igd-empty">Loading…</td></tr>`;
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      _mgGodowns = j.godowns || [];
      _renderMgTable();
    } catch(e){
      if(tbody) tbody.innerHTML = `<tr><td colspan="9" class="igd-empty" style="color:var(--nb-danger)">⚠ ${esc(e.message)}</td></tr>`;
    }
  };

  function _renderMgTable(){
    const tbody = $('mg-tbody');
    if(!tbody) return;
    if(!_mgGodowns.length){
      tbody.innerHTML = `<tr><td colspan="9" class="igd-empty">No godowns yet.</td></tr>`;
      return;
    }
    const canEdit = window._INV_CAN_EDIT === true;
    tbody.innerHTML = _mgGodowns.map(g => `
      <tr>
        <td><strong>${esc(g.name)}</strong>${g.is_default ? ' <span class="mg-default-pill">DEFAULT</span>' : ''}</td>
        <td><span class="mg-type-pill mg-type-${esc(g.type||'godown')}">${esc(g.type||'godown')}</span></td>
        <td>${esc(g.contact||'')}</td>
        <td style="font-family:monospace">${esc(g.phone||'')}</td>
        <td style="font-family:monospace;font-size:11px">${esc(g.gst_number||'')}</td>
        <td>${esc(g.city||'')}${g.city && g.state ? ', ' : ''}${esc(g.state||'')}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtN(g.distinct_items)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtN(g.total_boxes)}</td>
        <td style="white-space:nowrap;text-align:right">
          ${canEdit ? `
            <button class="igd-btn-ghost" onclick="invMgEdit(${g.id})" title="Edit"><i class="fas fa-pen"></i></button>
            <button class="igd-btn-ghost" onclick="invMgDelete(${g.id})" title="Delete" style="color:var(--nb-danger)"><i class="fas fa-trash"></i></button>
          ` : ''}
        </td>
      </tr>
    `).join('');
  }

  window.invMgNew = function(){
    _mgEditId = null;
    $('mg-modal-title').textContent = 'New Godown';
    $('mg-form').reset();
    $('mg-form [name=type]').value = 'godown';
    if(typeof invOpenModal === 'function') invOpenModal('godownFormModal');
    else $('godownFormModal').classList.add('open');
  };

  window.invMgEdit = function(gid){
    const g = _mgGodowns.find(x => x.id === gid);
    if(!g) return;
    _mgEditId = gid;
    $('mg-modal-title').textContent = `Edit — ${g.name}`;
    const f = $('mg-form');
    f.name.value       = g.name || '';
    f.type.value       = g.type || 'godown';
    f.contact.value    = g.contact || '';
    f.phone.value      = g.phone || '';
    f.email.value      = g.email || '';
    f.gst_number.value = g.gst_number || '';
    f.is_default.checked = !!g.is_default;
    f.address.value    = g.address || '';
    f.city.value       = g.city || '';
    f.state.value      = g.state || '';
    f.pin.value        = g.pin || '';
    if(typeof invOpenModal === 'function') invOpenModal('godownFormModal');
    else $('godownFormModal').classList.add('open');
  };

  window.invMgSave = async function(ev){
    if(ev) ev.preventDefault();
    const f = $('mg-form');
    const payload = {
      id:         _mgEditId,
      name:       f.name.value.trim(),
      type:       f.type.value,
      contact:    f.contact.value.trim(),
      phone:      f.phone.value.trim(),
      email:      f.email.value.trim(),
      gst_number: f.gst_number.value.trim(),
      is_default: f.is_default.checked ? 1 : 0,
      address:    f.address.value.trim(),
      city:       f.city.value.trim(),
      state:      f.state.value.trim(),
      pin:        f.pin.value.trim(),
    };
    if(!payload.name){ alert('Name is required'); return false; }
    try {
      const r = await fetch('/api/inventory_godown/godowns/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Save failed');
      if(typeof invCloseModal === 'function') invCloseModal('godownFormModal');
      else $('godownFormModal').classList.remove('open');
      await invMgLoad();
    } catch(e){ alert(e.message); }
    return false;
  };

  window.invMgDelete = async function(gid){
    const g = _mgGodowns.find(x => x.id === gid);
    if(!g) return;
    if(!confirm(`Delete godown "${g.name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/inventory_godown/godowns/delete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({id: gid}),
      });
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Delete failed');
      await invMgLoad();
    } catch(e){ alert(e.message); }
  };

  /* ═══════════════════════════════════════════════════════════════
     OPENING STOCK ENTRY  (creates N boxes for a material at a godown)
  ═══════════════════════════════════════════════════════════════ */

  let _opMaterial = null;

  window.invOpInit = async function(){
    // Load godowns into the godown dropdown
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      const sel = $('op-godown');
      if(sel && j.godowns){
        sel.innerHTML = '<option value="">— select godown —</option>' +
          j.godowns.map(g => `<option value="${g.id}"${g.is_default?' selected':''}>${esc(g.name)}</option>`).join('');
      }
    } catch(e){ console.error(e); }

    // Clear form
    _opMaterial = null;
    $('op-material-search').value = '';
    $('op-material-result').innerHTML = '';
    $('op-no-of-box').value = '1';
    $('op-per-box-qty').value = '';
    $('op-remarks').value = '';
    $('op-summary').innerHTML = '';
    $('op-recent-boxes').innerHTML = '';
    // Load the opening stock log (grouped entries) below the form
    if(typeof window.invOpLoadLog === 'function') window.invOpLoadLog();
  };

  // Debounced material search
  let _opSearchTimer = null;
  let _opHi = -1;   // highlighted result index for keyboard nav

  function _opResultEls(){
    const wrap = $('op-material-result');
    return wrap ? Array.from(wrap.querySelectorAll('.op-mat-result')) : [];
  }
  function _opApplyHi(){
    const els = _opResultEls();
    els.forEach((el, i) => {
      if(i === _opHi){
        el.classList.add('op-mat-hi');
        el.style.background = 'var(--nb-blue-light,#E8F0FE)';
        el.scrollIntoView({block:'nearest'});
      } else {
        el.classList.remove('op-mat-hi');
        el.style.background = '';
      }
    });
  }
  // Arrow-key navigation + Enter to select, on the material search input.
  window.invOpMaterialKeydown = function(ev){
    const els = _opResultEls();
    if(!els.length) return;
    if(ev.key === 'ArrowDown'){
      ev.preventDefault();
      _opHi = Math.min(els.length - 1, _opHi + 1);
      _opApplyHi();
    } else if(ev.key === 'ArrowUp'){
      ev.preventDefault();
      _opHi = Math.max(0, _opHi - 1);
      _opApplyHi();
    } else if(ev.key === 'Enter'){
      // pick highlighted (or first result if none highlighted yet)
      ev.preventDefault();
      const idx = _opHi >= 0 ? _opHi : 0;
      if(els[idx]) invOpPickMaterialEl(els[idx]);
    } else if(ev.key === 'Escape'){
      $('op-material-result').innerHTML = '';
      _opHi = -1;
    }
  };

  window.invOpSearchMaterial = function(){
    clearTimeout(_opSearchTimer);
    _opSearchTimer = setTimeout(async () => {
      const q = $('op-material-search').value.trim();
      if(!q){
        $('op-material-result').innerHTML = '';
        return;
      }
      try {
        const r = await fetch('/api/inventory_godown/materials/search?q=' + encodeURIComponent(q));
        const j = await r.json();
        if(j.status === 'ok'){
          if(!j.materials.length){
            $('op-material-result').innerHTML = '<div class="op-mat-result-none">No matches</div>';
          } else {
            $('op-material-result').innerHTML = j.materials.slice(0,8).map(m => `
              <div class="op-mat-result"
                   data-id="${m.id}"
                   data-name="${esc(m.material_name)}"
                   data-uom="${esc(m.uom||'')}"
                   onclick="invOpPickMaterialEl(this)">
                <span>${esc(m.material_name)}</span>
                <span class="op-mat-uom">${esc(m.uom||'')}</span>
              </div>
            `).join('');
            _opHi = -1;  // reset highlight for fresh results
          }
        }
      } catch(e){ console.error(e); }
    }, 200);
  };

  window.invOpPickMaterialEl = function(el){
    invOpPickMaterial(
      parseInt(el.dataset.id),
      el.dataset.name || '',
      el.dataset.uom || ''
    );
  };

  window.invOpPickMaterial = function(id, name, uom){
    _opMaterial = { id, name, uom };
    $('op-material-search').value = name;
    $('op-material-result').innerHTML = '';
    $('op-per-box-uom').textContent = uom || '';
    $('op-per-box-qty').focus();
    invOpUpdateSummary();
  };

  window.invOpUpdateSummary = function(){
    const nb = parseInt($('op-no-of-box').value) || 0;
    const pq = parseFloat($('op-per-box-qty').value) || 0;
    const total = nb * pq;
    if(_opMaterial && nb > 0 && pq > 0){
      $('op-summary').innerHTML = `
        <i class="fas fa-circle-info"></i>
        Will create <strong>${nb}</strong> box${nb===1?'':'es'} totalling
        <strong>${fmtN(total, 3)} ${esc(_opMaterial.uom||'')}</strong>
      `;
      $('op-submit').disabled = false;
    } else {
      $('op-summary').innerHTML = '';
      $('op-submit').disabled = true;
    }
  };

  /* ─── OPENING STOCK LOG (grouped per entry) ─── */
  window.invOpLoadLog = async function(){
    const body = $('op-log-body');
    if(!body) return;
    body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--nb-text-muted);font-size:13px">Loading…</div>';
    try {
      const r = await fetch('/api/inventory_godown/opening/log');
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');
      window._invOpLog = j.entries || [];
      window._invOpLogPage = 1;
      _invOpRenderLog();
    } catch(e){
      body.innerHTML = '<div style="padding:14px;border:1px solid var(--nb-danger);background:var(--nb-danger-light);color:var(--nb-danger);border-radius:8px;font-size:12.5px"><i class="fas fa-exclamation-triangle"></i> ' + esc(e.message) + '</div>';
    }
  };

  function _invOpFmtDate(iso){
    if(!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? (m[3]+'/'+m[2]+'/'+m[1]) : iso;
  }
  // Datetime variant — produces "DD/MM/YYYY HH:MM" from ISO/MySQL strings
  // like 2026-05-29 14:23 or 2026-05-29T14:23:00. Falls back gracefully if
  // the input shape is unfamiliar.
  function _invOpFmtDateTime(iso){
    if(!iso) return '—';
    var s = String(iso).replace('T',' ');
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
    if(!m) return s;
    var d = m[3]+'/'+m[2]+'/'+m[1];
    return m[4] ? (d+' '+m[4]+':'+m[5]) : d;
  }

  window._invOpLogPage = 1;
  window._invOpLogPageSize = 10;
  window._invOpLogSearch = '';
  window._invOpLogGodown = '';   // godown name filter ('' = all)
  window._invOpLogFrom = '';     // date from (YYYY-MM-DD, '' = no lower bound)
  window._invOpLogTo = '';       // date to   (YYYY-MM-DD, '' = no upper bound)

  function _invOpRenderLog(){
    const body = $('op-log-body');
    if(!body) return;
    let entries = window._invOpLog || [];
    if(!entries.length){
      body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--nb-text-muted);font-size:13px;border:1px dashed var(--nb-border-strong);border-radius:8px">No opening stock entries yet.</div>';
      return;
    }
    // Apply filters: text search (material / godown / batch), godown, date range
    const q = (window._invOpLogSearch || '').trim().toLowerCase();
    const gd = (window._invOpLogGodown || '').trim();
    const df = (window._invOpLogFrom || '').trim();   // YYYY-MM-DD
    const dt = (window._invOpLogTo || '').trim();      // YYYY-MM-DD
    let filtered = entries.filter(e => {
      if(q){
        const hit = (e.material||'').toLowerCase().includes(q) ||
                    (e.godown||'').toLowerCase().includes(q) ||
                    (e.batch_num||'').toLowerCase().includes(q);
        if(!hit) return false;
      }
      if(gd && (e.godown||'') !== gd) return false;
      if(df || dt){
        const d = (e.created_at||'').slice(0,10);   // ISO date, string-comparable
        if(df && d < df) return false;
        if(dt && d > dt) return false;
      }
      return true;
    });
    // Distinct godowns present in the data (for the filter dropdown)
    const godownOpts = Array.from(new Set(entries.map(e => e.godown).filter(Boolean))).sort();
    const total = filtered.length;
    const pageSize = window._invOpLogPageSize || 10;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if(window._invOpLogPage > pages) window._invOpLogPage = pages;
    if(window._invOpLogPage < 1) window._invOpLogPage = 1;
    const page = window._invOpLogPage;
    const start = (page - 1) * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);

    const anyFilter = !!(q || gd || df || dt);

    // Toolbar: search + filters + page-size
    let html = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">'
      + '<input type="text" id="op-log-search" placeholder="Search material / godown / batch…" value="' + esc(window._invOpLogSearch||'') + '" oninput="invOpLogSearchInput(this.value)" '
      +   'style="flex:1;min-width:180px;padding:7px 11px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:12.5px">'
      + '<div id="op-log-godown-mount" style="min-width:160px"></div>'
      + '<select onchange="invOpLogSetPageSize(this.value)" style="padding:7px 10px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:12.5px">'
      +   ['10','25','50','100'].map(n => '<option value="'+n+'"'+(String(pageSize)===n?' selected':'')+'>'+n+' / page</option>').join('')
      + '</select>'
      + '</div>';
    // Second row: date range + count + clear
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">'
      + '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--nb-text-muted)">Date</span>'
      + '<input type="date" id="op-log-from" value="' + esc(df) + '" onchange="invOpLogSetDate(\'from\',this.value)" '
      +   'style="padding:6px 9px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:12.5px">'
      + '<span style="color:var(--nb-text-muted)">→</span>'
      + '<input type="date" id="op-log-to" value="' + esc(dt) + '" onchange="invOpLogSetDate(\'to\',this.value)" '
      +   'style="padding:6px 9px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:12.5px">'
      + (anyFilter ? '<button type="button" class="igd-btn" style="font-size:11.5px;padding:6px 11px" onclick="invOpLogClearFilters()"><i class="fas fa-xmark"></i> Clear filters</button>' : '')
      + '<button type="button" class="igd-btn" id="op-edit-approvals-btn" style="font-size:11.5px;padding:6px 11px" onclick="invOpEditApprovals()"><i class="fas fa-clipboard-check"></i> Edit Approvals <span id="op-edit-pending-badge" style="display:none;background:#C5221F;color:#fff;border-radius:9px;padding:0 6px;font-size:10px;font-weight:800;margin-left:4px">0</span></button>'
      + '<span style="margin-left:auto;font-size:12px;color:var(--nb-text-muted)">' + total + ' entr' + (total===1?'y':'ies') + (anyFilter?(' of '+entries.length):'') + '</span>'
      + '</div>';

    html += '<div style="border:1px solid var(--nb-border-strong);border-radius:10px;overflow-x:auto">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12.5px;white-space:nowrap;min-width:900px">';
    html += '<thead style="background:var(--nb-bg);position:sticky;top:0;z-index:1"><tr>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Material</th>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Godown</th>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Batch</th>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Expiry</th>'
      + '<th style="text-align:right;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Pkgs</th>'
      + '<th style="text-align:right;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Qty</th>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Date</th>'
      + '<th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">By</th>'
      + '<th style="text-align:center;padding:8px 10px;font-weight:700;color:var(--nb-text-muted)">Labels</th>'
      + '</tr></thead><tbody>';
    pageRows.forEach((e) => {
      const i = entries.indexOf(e);  // absolute index for handlers
      const codes = (e.boxes||[]).map(b => b.box_code);
      const expBit = e.expiry_date ? (' \u00b7 EXP ' + _invOpFmtDate(e.expiry_date)) : '';
      html += '<tr style="border-top:1px solid var(--nb-bg)">'
        + '<td style="padding:8px 10px;font-weight:600">' + esc(e.material||'\u2014') + '</td>'
        + '<td style="padding:8px 10px">' + esc(e.godown||'\u2014') + '</td>'
        + '<td style="padding:8px 10px">' + esc(e.batch_num||'\u2014') + '</td>'
        + '<td style="padding:8px 10px">' + (e.expiry_date ? _invOpFmtDate(e.expiry_date) : '\u2014') + '</td>'
        + '<td style="padding:8px 10px;text-align:right;font-family:monospace">' + e.no_of_box + (e.active_box!==e.no_of_box?(' <span style="color:var(--nb-text-muted)">('+e.active_box+' live)</span>'):'') + '</td>'
        + '<td style="padding:8px 10px;text-align:right;font-family:monospace">' + (e.total_qty||0) + ' ' + esc(e.uom||'') + '</td>'
        + '<td style="padding:8px 10px">' + _invOpFmtDate(e.created_at) + '</td>'
        + '<td style="padding:8px 10px;color:var(--nb-text-muted)">' + esc(e.created_by||'\u2014') + '</td>'
        + '<td style="padding:8px 10px;text-align:center;white-space:nowrap">'
        +   '<button type="button" class="igd-btn" style="font-size:11px;padding:4px 9px" onclick="invOpLogToggleCodes(' + i + ')"><i class="fas fa-list"></i> ' + codes.length + '</button> '
        +   '<button type="button" class="igd-btn" style="font-size:11px;padding:4px 9px" onclick="invOpEditOpen(' + i + ')"><i class="fas fa-pen"></i> Edit</button> '
        +   '<button type="button" class="igd-btn igd-btn-primary" style="font-size:11px;padding:4px 9px" onclick="invOpLogReprint(' + i + ')"><i class="fas fa-print"></i> Reprint</button>'
        + '</td>'
        + '</tr>';
      html += '<tr id="op-log-codes-' + i + '" style="display:none;background:var(--nb-bg)"><td colspan="9" style="padding:8px 12px">'
        + '<div style="font-size:11px;color:var(--nb-text-muted);margin-bottom:4px">Package codes' + expBit + (e.manufacturer?(' \u00b7 MFR '+esc(e.manufacturer)):'') + ':</div>'
        + codes.map(c => '<code style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;background:var(--nb-surface);border:1px solid var(--nb-border-strong);border-radius:5px;font-size:11px">' + esc(c) + '</code>').join('')
        + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // Pagination controls
    if(pages > 1){
      html += '<div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;font-size:12.5px">';
      html += '<button type="button" class="igd-btn" style="padding:5px 10px" ' + (page<=1?'disabled':'') + ' onclick="invOpLogGoPage(' + (page-1) + ')">‹ Prev</button>';
      // page numbers (compact)
      for(let p=1; p<=pages; p++){
        if(p===1 || p===pages || Math.abs(p-page)<=2){
          html += '<button type="button" class="igd-btn' + (p===page?' igd-btn-primary':'') + '" style="padding:5px 10px;min-width:34px" onclick="invOpLogGoPage(' + p + ')">' + p + '</button>';
        } else if(Math.abs(p-page)===3){
          html += '<span style="color:var(--nb-text-muted)">…</span>';
        }
      }
      html += '<button type="button" class="igd-btn" style="padding:5px 10px" ' + (page>=pages?'disabled':'') + ' onclick="invOpLogGoPage(' + (page+1) + ')">Next ›</button>';
      html += '<span style="margin-left:8px;color:var(--nb-text-muted)">Page ' + page + ' of ' + pages + '</span>';
      html += '</div>';
    }
    body.innerHTML = html;
    _invOpMountGodownFilter(godownOpts);
    if(typeof window.invOpEditRefreshBadge === 'function') window.invOpEditRefreshBadge();
  }

  // Mount the godown filter as a searchable combo (project standard), with a
  // plain-select fallback if invCombo isn't available.
  function _invOpMountGodownFilter(godownOpts){
    const mount = $('op-log-godown-mount');
    if(!mount) return;
    const cur = window._invOpLogGodown || '';
    const opts = [{value:'', label:'— All godowns —'}].concat(
      (godownOpts||[]).map(g => ({value:g, label:g})));
    mount.innerHTML = '';
    if(window.invCombo){
      window.invCombo({
        mount, placeholder:'Filter godown…', options:opts, value:cur,
        onChange:(val)=>{ window._invOpLogGodown = val||''; window._invOpLogPage = 1; _invOpRenderLog(); }
      });
    } else {
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:7px 10px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:12.5px;min-width:160px';
      sel.innerHTML = opts.map(o => '<option value="'+esc(o.value)+'"'+(o.value===cur?' selected':'')+'>'+esc(o.label)+'</option>').join('');
      sel.onchange = () => { window._invOpLogGodown = sel.value||''; window._invOpLogPage = 1; _invOpRenderLog(); };
      mount.appendChild(sel);
    }
  }

  window.invOpLogGoPage = function(p){ window._invOpLogPage = p; _invOpRenderLog(); };
  window.invOpLogSetPageSize = function(n){ window._invOpLogPageSize = parseInt(n)||10; window._invOpLogPage = 1; _invOpRenderLog(); };
  window.invOpLogSetDate = function(which, v){
    if(which === 'from') window._invOpLogFrom = v || '';
    else if(which === 'to') window._invOpLogTo = v || '';
    window._invOpLogPage = 1;
    _invOpRenderLog();
  };
  window.invOpLogClearFilters = function(){
    window._invOpLogSearch = '';
    window._invOpLogGodown = '';
    window._invOpLogFrom = '';
    window._invOpLogTo = '';
    window._invOpLogPage = 1;
    _invOpRenderLog();
  };
  let _opLogSearchTimer = null;
  window.invOpLogSearchInput = function(v){
    window._invOpLogSearch = v;
    window._invOpLogPage = 1;
    clearTimeout(_opLogSearchTimer);
    _opLogSearchTimer = setTimeout(() => {
      _invOpRenderLog();
      // keep focus + caret in the search box after re-render
      const s = $('op-log-search');
      if(s){ s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 220);
  };

  window.invOpLogToggleCodes = function(i){
    const row = $('op-log-codes-' + i);
    if(row) row.style.display = (row.style.display === 'none' ? '' : 'none');
  };

  // Reprint = raise a reprint REQUEST (non-admin) which an admin approves.
  window.invOpLogReprint = async function(i){
    const e = (window._invOpLog || [])[i];
    if(!e){ return; }
    const liveCodes = (e.boxes||[]).filter(b => b.status === 'in_stock').map(b => b.box_code);
    const codes = liveCodes.length ? liveCodes : (e.boxes||[]).map(b => b.box_code);
    if(!codes.length){ alert('No package codes to reprint.'); return; }
    const reason = prompt('Reason for reprint request (e.g. label damaged / lost):', '');
    if(reason === null) return;            // cancelled
    if(!reason.trim()){ alert('A reason is required to raise a reprint request.'); return; }
    try {
      const r = await fetch('/api/inventory_mgmt/label_reprint/request', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ scope_type:'boxes', box_codes: codes, reason: reason.trim() }),
      });
      const j = await r.json();
      if(j.status !== 'ok'){ alert(j.message || 'Could not raise reprint request'); return; }
      if(j.duplicate){
        alert('You already have a pending reprint request for these packages.');
      } else {
        alert('\u2713 Reprint request raised for ' + codes.length + ' label(s). An admin will approve it.');
      }
    } catch(err){
      alert('Error: ' + err.message);
    }
  };

  window.invOpPrintBulkLabels = function(){
    const labels = window._invOpBulkLabels || [];
    if(!labels.length){ alert('No labels to print.'); return; }
    if(typeof window.invPrintLabels === 'function') window.invPrintLabels(labels);
    else alert('Label printer not loaded.');
  };

  window.invOpPrintLabels = function(){
    const labels = window._invOpLastLabels || [];
    if(!labels.length){ alert('No labels to print — create opening stock first.'); return; }
    if(typeof window.invPrintLabels === 'function'){
      window.invPrintLabels(labels);
    } else {
      alert('Label printer not loaded. Make sure the GRN module is available.');
    }
  };

  window.invOpSubmit = async function(ev){
    if(ev) ev.preventDefault();
    if(!_opMaterial){ alert('Pick a material first'); return false; }
    const godown_id = parseInt($('op-godown').value) || 0;
    if(!godown_id){ alert('Pick a godown'); return false; }
    const no_of_box   = parseInt($('op-no-of-box').value) || 0;
    const per_box_qty = parseFloat($('op-per-box-qty').value) || 0;
    if(no_of_box <= 0 || per_box_qty <= 0){ alert('Enter valid Number of Packages and Quantity per Package'); return false; }
    const batch_num  = ($('op-batch-num') ? $('op-batch-num').value.trim() : '');
    const expiry_date = ($('op-expiry-date') ? $('op-expiry-date').value : '');
    const manufacturer = ($('op-manufacturer') ? $('op-manufacturer').value.trim() : '');

    // Label-only fields — NOT sent to the backend (see /create_boxes body
    // below). They live in JS only, flow into the label render, and are
    // discarded after the form resets. A later reprint via the Label
    // Reprint module will NOT have these values because they aren't stored.
    const lbl_supplier    = ($('op-supplier-name') ? $('op-supplier-name').value.trim() : '');
    const lbl_grn_no      = ($('op-grn-no')        ? $('op-grn-no').value.trim()        : '');
    const lbl_grn_date    = ($('op-grn-date')      ? $('op-grn-date').value             : '');
    const lbl_invoice_no  = ($('op-invoice-no')    ? $('op-invoice-no').value.trim()    : '');
    const lbl_invoice_dt  = ($('op-invoice-date')  ? $('op-invoice-date').value         : '');

    // ── Two-level near-expiry warning ──────────────────────────────────
    // If the entered expiry is within 2 months (or already past), require the
    // user to clear two confirmations before the boxes are actually created.
    const _doCreate = async function(){
    $('op-submit').disabled = true;
    $('op-submit').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
    try {
      const r = await fetch('/api/inventory_godown/opening/create_boxes', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          material_id: _opMaterial.id,
          godown_id,
          no_of_box,
          per_box_qty,
          batch_num,
          expiry_date,
          manufacturer,
          remarks: $('op-remarks').value.trim(),
        }),
      });
      const j = await r.json();
      if(j.status !== 'ok') throw new Error(j.message || 'Failed');

      // Stash the just-created label data so the Print button can build labels
      // (reusing RM's GRN label printer via window.invPrintLabels).
      const matName = j.material || (_opMaterial ? _opMaterial.material_name : '') || '';
      const uom     = (_opMaterial && _opMaterial.uom) || j.uom || 'KG';
      const opDate  = (new Date()).toISOString().slice(0,10);
      window._invOpLastLabels = (j.boxes || []).map((b, i) => ({
        materialName: matName,
        qrCode:       b.box_code,
        // Label-only fields fall back to the OPENING defaults when blank,
        // matching the existing behaviour. When the user fills them in,
        // they override the defaults so the printed label looks like a
        // regular GRN-style label.
        grnNo:        lbl_grn_no   || 'OPENING',
        grnDate:      lbl_grn_date || opDate,
        batchNo:      batch_num || '',
        boxNum:       i + 1,
        totalBoxes:   j.boxes.length,
        perPkgQty:    per_box_qty,
        uom:          uom,
        invoiceNo:    lbl_invoice_no || '',
        invoiceDate:  lbl_invoice_dt || '',
        mfgDate:      '',
        expiryDate:   expiry_date || '',
        manufacturer: manufacturer || '',
        supplier:     lbl_supplier  || 'Opening Stock',
        supervisor:   (window.INV_CTX && window.INV_CTX.userName) || '',
      }));

      // Show created packages + a Print Labels button
      $('op-recent-boxes').innerHTML = `
        <div class="op-success">
          <i class="fas fa-check-circle" style="color:var(--nb-success)"></i>
          Created <strong>${j.boxes.length}</strong> package${j.boxes.length===1?'':'s'} for
          <strong>${esc(j.material)}</strong> at <strong>${esc(j.godown)}</strong>
        </div>
        <div style="margin:10px 0">
          <button type="button" class="btn btn-primary" onclick="invOpPrintLabels()"
            style="padding:8px 16px;font-size:13px">
            <i class="fas fa-print"></i> Print Labels (${j.boxes.length})
          </button>
        </div>
        <div class="op-codes">
          <div class="op-codes-head">
            Pkg. codes — print labels and stick on physical packages:
          </div>
          ${j.boxes.map(b => `<code class="op-code">${esc(b.box_code)}</code>`).join('')}
        </div>
      `;

      // Reset form for next entry (but keep godown)
      _opMaterial = null;
      $('op-material-search').value = '';
      $('op-per-box-qty').value = '';
      $('op-remarks').value = '';
      if($('op-batch-num')) $('op-batch-num').value = '';
      if($('op-expiry-date')) $('op-expiry-date').value = '';
      if($('op-manufacturer')) $('op-manufacturer').value = '';
      // Reset the label-only fields too — they're per-entry, not sticky.
      if($('op-supplier-name')) $('op-supplier-name').value = '';
      if($('op-grn-no'))        $('op-grn-no').value        = '';
      if($('op-grn-date'))      $('op-grn-date').value      = '';
      if($('op-invoice-no'))    $('op-invoice-no').value    = '';
      if($('op-invoice-date'))  $('op-invoice-date').value  = '';
      $('op-summary').innerHTML = '';
      $('op-material-search').focus();
      if(typeof window.invOpLoadLog === 'function') window.invOpLoadLog();
    } catch(e){
      alert(e.message);
    } finally {
      $('op-submit').disabled = false;
      $('op-submit').innerHTML = '<i class="fas fa-save"></i> Create Packages';
      invOpUpdateSummary();
    }
    }; // end _doCreate

    // Gate the create behind the two-level near-expiry warning. If the expiry
    // is more than 2 months out (or blank), invExpiryGuard proceeds at once.
    if(typeof window.invExpiryGuard === 'function'){
      window.invExpiryGuard(
        [{ expiry_date: expiry_date, label: (_opMaterial && _opMaterial.material_name) || '' }],
        _doCreate,
        { context: 'opening stock entry' }
      );
    } else {
      _doCreate();
    }
    return false;
  };

  // ─── Bulk Excel upload mode ───────────────────────────────────────

  window.invOpSetMode = function(mode){
    // Toggle which form is visible. Default mode is 'single'.
    var single = $('op-single-mode');
    var bulk   = $('op-bulk-mode');
    if (!single || !bulk) return;
    if (mode === 'bulk'){
      single.style.display = 'none';
      bulk.style.display   = '';
    } else {
      single.style.display = '';
      bulk.style.display   = 'none';
    }
    // Update tab styling
    document.querySelectorAll('.op-mode-tab').forEach(function(t){
      t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });
    // Clear any results from the other mode
    var resEl = $('op-bulk-results');
    if (resEl && mode !== 'bulk') resEl.innerHTML = '';
  };

  window.invOpBulkFileChange = function(){
    var f   = $('op-bulk-file');
    var btn = $('op-bulk-submit');
    if (!f || !btn) return;
    btn.disabled = !(f.files && f.files.length);
  };

  // Render the success summary + per-row breakdown + label print button.
  // Used by both the direct upload path and the post-confirmation path.
  function _invOpRenderBulkResult(j){
    var resEl = $('op-bulk-results');
    if (!resEl) return;
    var s = j.summary || {};
    var html = '';
    html += '<div style="padding:12px 14px;border:1px solid var(--nb-success-light);background:var(--nb-success-light);border-radius:8px;margin-bottom:10px">';
    html += '  <div style="font-size:13px;font-weight:700;color:var(--nb-success);margin-bottom:6px"><i class="fas fa-check-circle"></i> Upload complete</div>';
    html += '  <div style="font-size:12px;color:var(--nb-text-muted);line-height:1.7">';
    html += '    Total rows: <b>' + (s.rows_total||0) + '</b> · ';
    html += '    Created: <b style="color:var(--nb-success)">' + (s.rows_ok||0) + '</b> · ';
    if (s.rows_error)   html += 'Errors: <b style="color:var(--nb-danger)">' + s.rows_error + '</b> · ';
    if (s.rows_skipped) html += 'Skipped: <b>' + s.rows_skipped + '</b> · ';
    html += '    Packages created: <b style="color:var(--nb-success)">' + (s.boxes_created||0) + '</b>';
    if (s.boxes_replaced) html += ' · Packages replaced: <b style="color:var(--nb-warning)">' + s.boxes_replaced + '</b>';
    html += '  </div></div>';

    var allLabels = [];
    (j.results || []).forEach(function(r){
      if (r.status !== 'ok' || !Array.isArray(r.codes)) return;
      var total = r.codes.length;
      var rowGrnNo    = r.label_grn_no     || 'OPENING';
      var rowGrnDate  = r.label_grn_date   || (new Date()).toISOString().slice(0,10);
      var rowSupplier = r.label_supplier   || 'Opening Stock';
      var rowInvNo    = r.label_invoice_no || '';
      var rowInvDt    = r.label_invoice_dt || '';
      r.codes.forEach(function(code, i){
        allLabels.push({
          materialName: r.material || '', qrCode: code,
          grnNo: rowGrnNo, grnDate: rowGrnDate, batchNo: r.batch_num || '',
          boxNum: i + 1, totalBoxes: total, perPkgQty: r.per_box_qty || '',
          uom: r.uom || 'KG', invoiceNo: rowInvNo, invoiceDate: rowInvDt,
          mfgDate: '', expiryDate: r.expiry_date || '',
          manufacturer: r.manufacturer || '', supplier: rowSupplier,
          supervisor: (window.INV_CTX && window.INV_CTX.userName) || '',
        });
      });
    });
    window._invOpBulkLabels = allLabels;
    if (allLabels.length){
      html += '<div style="margin:4px 0 12px"><button type="button" class="btn btn-primary" onclick="invOpPrintBulkLabels()" style="padding:8px 16px;font-size:13px"><i class="fas fa-print"></i> Print All Labels (' + allLabels.length + ')</button></div>';
    }

    var rows = j.results || [];
    if (rows.length){
      html += '<div style="border:1px solid var(--nb-border-strong);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">';
      html += '<thead style="background:var(--nb-bg);position:sticky;top:0"><tr>';
      html += '<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--nb-border-strong);font-weight:700;color:var(--nb-text-muted)">Row</th>';
      html += '<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--nb-border-strong);font-weight:700;color:var(--nb-text-muted)">Material</th>';
      html += '<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--nb-border-strong);font-weight:700;color:var(--nb-text-muted)">Godown</th>';
      html += '<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--nb-border-strong);font-weight:700;color:var(--nb-text-muted)">Status</th>';
      html += '</tr></thead><tbody>';
      rows.forEach(function(r){
        var color = (r.status === 'ok') ? 'var(--nb-success)' : (r.status === 'skipped' ? 'var(--nb-text-muted)' : 'var(--nb-danger)');
        var icon  = (r.status === 'ok') ? 'check-circle' : (r.status === 'skipped' ? 'minus-circle' : 'exclamation-triangle');
        var bgColor = (r.status === 'ok') ? 'var(--nb-surface)' : (r.status === 'skipped' ? 'var(--nb-bg)' : 'var(--nb-danger-light)');
        html += '<tr style="background:' + bgColor + '">';
        html += '<td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg);color:var(--nb-text-muted);font-family:monospace">' + r.row + '</td>';
        html += '<td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg)">' + _esc(r.material || '—') + '</td>';
        html += '<td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg)">' + _esc(r.godown || '—') + '</td>';
        html += '<td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg);color:' + color + '"><i class="fas fa-' + icon + '"></i> ' + _esc(r.message || r.status) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
    resEl.innerHTML = html;
  }
  window._invOpRenderBulkResult = _invOpRenderBulkResult;

  // POST the bulk file. confirm=true sends confirm=1; exclude is a CSV of
  // 1-based Excel row numbers to skip. Returns the parsed JSON.
  async function _invOpBulkPost(file, replace, confirm, excludeCsv){
    var form = new FormData();
    form.append('file', file);
    if (replace) form.append('replace', '1');
    if (confirm) form.append('confirm', '1');
    if (excludeCsv) form.append('exclude_rows', excludeCsv);
    var r = await fetch('/api/inventory_godown/opening/upload', {
      method: 'POST', body: form,
    });
    return await r.json();
  }
  window._invOpBulkPost = _invOpBulkPost;

  // Render the per-batch conflict review. Each batch group gets a checkbox;
  // CONFLICT groups start UNTICKED (so the safe default is "don't import the
  // bad data"), WARN/OK groups start ticked. "Create selected" re-submits
  // with the unticked rows excluded.
  function _invOpRenderReview(j, file, replace){
    var resEl = $('op-bulk-results');
    if (!resEl) return;
    window._invOpReviewFile = file;
    window._invOpReviewReplace = replace;
    var groups = j.analysis || [];

    var html = '';
    html += '<div style="padding:12px 14px;border:1px solid var(--nb-warning);background:var(--nb-warning-light);border-radius:8px;margin-bottom:12px">';
    html += '  <div style="font-size:13px;font-weight:700;color:var(--nb-warning);margin-bottom:4px"><i class="fas fa-exclamation-triangle"></i> Review needed before import</div>';
    html += '  <div style="font-size:12px;color:var(--nb-text-muted);line-height:1.6">Some batches have <b>conflicting expiry dates</b> (a batch can only have one expiry) or other things to confirm. Untick anything you don\'t want to import, fix the sheet, and re-upload — or import the rest now.</div>';
    html += '</div>';

    html += '<div style="border:1px solid var(--nb-border-strong);border-radius:8px;overflow:hidden;max-height:360px;overflow-y:auto">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:11.5px">';
    html += '<thead style="background:var(--nb-bg);position:sticky;top:0"><tr>';
    html += '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--nb-border-strong)">Import?</th>';
    html += '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--nb-border-strong);color:var(--nb-text-muted)">Material</th>';
    html += '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--nb-border-strong);color:var(--nb-text-muted)">Batch</th>';
    html += '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--nb-border-strong);color:var(--nb-text-muted)">Rows</th>';
    html += '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--nb-border-strong);color:var(--nb-text-muted)">Status</th>';
    html += '</tr></thead><tbody>';

    groups.forEach(function(g, idx){
      var isConflict = (g.flag === 'conflict');
      var isWarn     = (g.flag === 'warn');
      var color = isConflict ? 'var(--nb-danger)' : (isWarn ? 'var(--nb-warning)' : 'var(--nb-success)');
      var bg    = isConflict ? 'var(--nb-danger-light)' : (isWarn ? 'var(--nb-warning-light)' : 'var(--nb-surface)');
      var icon  = isConflict ? 'times-circle' : (isWarn ? 'exclamation-circle' : 'check-circle');
      var rowsCsv = (g.rows || []).join(',');
      // conflict groups default OFF; others default ON
      var checked = isConflict ? '' : 'checked';
      html += '<tr style="background:' + bg + '">';
      html += '  <td style="text-align:center;padding:5px 10px;border-bottom:1px solid var(--nb-bg)">';
      html += '    <input type="checkbox" class="op-review-cb" data-rows="' + rowsCsv + '" ' + checked + '>';
      html += '  </td>';
      html += '  <td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg)">' + _esc(g.material || '—') + '</td>';
      html += '  <td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg);font-family:monospace">' + _esc(g.batch || '—') + '</td>';
      html += '  <td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg);color:var(--nb-text-muted);font-family:monospace">' + _esc(rowsCsv) + '</td>';
      html += '  <td style="padding:5px 10px;border-bottom:1px solid var(--nb-bg);color:' + color + '">';
      html += '    <i class="fas fa-' + icon + '"></i> ' + _esc(g.note || g.flag);
      html += '  </td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';

    html += '<div style="margin-top:12px;display:flex;gap:8px">';
    html += '  <button type="button" class="btn btn-primary" onclick="invOpBulkConfirm()" style="padding:8px 16px;font-size:13px"><i class="fas fa-check"></i> Create selected</button>';
    html += '  <button type="button" class="btn" onclick="document.getElementById(\'op-bulk-results\').innerHTML=\'\'" style="padding:8px 16px;font-size:13px">Cancel</button>';
    html += '</div>';

    resEl.innerHTML = html;
  }
  window._invOpRenderReview = _invOpRenderReview;

  // Re-submit the reviewed file with confirm=1, excluding rows from any
  // unticked batch group.
  window.invOpBulkConfirm = async function(){
    var resEl = $('op-bulk-results');
    var file  = window._invOpReviewFile;
    if (!file){ if (resEl) resEl.innerHTML = '<div style="padding:12px;color:var(--nb-danger)">Session expired — please re-upload the file.</div>'; return; }

    // Collect excluded rows from unticked checkboxes.
    var excluded = [];
    document.querySelectorAll('.op-review-cb').forEach(function(cb){
      if (!cb.checked){
        (cb.getAttribute('data-rows') || '').split(',').forEach(function(x){
          x = x.trim(); if (x) excluded.push(x);
        });
      }
    });

    if (resEl) resEl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--nb-text-muted);font-size:12.5px">Creating — please wait…</div>';
    try {
      var j = await _invOpBulkPost(file, !!window._invOpReviewReplace, true, excluded.join(','));
      if (j.status !== 'ok') throw new Error(j.message || 'Create failed');
      _invOpRenderBulkResult(j);   // reuse the normal success renderer
    } catch(e){
      if (resEl) resEl.innerHTML = '<div style="padding:14px;border:1px solid var(--nb-danger);background:var(--nb-danger-light);color:var(--nb-danger);border-radius:8px;font-size:12.5px"><i class="fas fa-exclamation-triangle"></i> ' + _esc(e.message || String(e)) + '</div>';
    }
  };

  window.invOpBulkUpload = async function(){
    var fileInput = $('op-bulk-file');
    var btn       = $('op-bulk-submit');
    var resEl     = $('op-bulk-results');
    var replaceCb = $('op-bulk-replace');
    if (!fileInput || !fileInput.files || !fileInput.files.length){
      alert('Please choose an Excel file first');
      return;
    }
    var f = fileInput.files[0];
    if (!/\.(xlsx|xls)$/i.test(f.name)){
      alert('Please choose an .xlsx or .xls file');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';
    if (resEl) resEl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--nb-text-muted);font-size:12.5px">Processing — please wait…</div>';

    try {
      var j = await _invOpBulkPost(f, (replaceCb && replaceCb.checked), false, '');

      // Backend found expiry conflicts → show per-batch review screen instead
      // of importing. User ticks which rows to import, then confirms.
      if (j.status === 'needs_confirmation'){
        _invOpRenderReview(j, f, (replaceCb && replaceCb.checked));
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-upload"></i> Upload &amp; Create Packages';
        return;
      }
      if (j.status !== 'ok'){
        throw new Error(j.message || 'Upload failed');
      }

      // Render the results summary + per-row breakdown
      _invOpRenderBulkResult(j);
      // Reset file input so re-upload works
      if (fileInput) fileInput.value = '';
    } catch(e){
      if (resEl){
        resEl.innerHTML = '<div style="padding:14px;border:1px solid var(--nb-danger);background:var(--nb-danger-light);color:var(--nb-danger);border-radius:8px;font-size:12.5px"><i class="fas fa-exclamation-triangle"></i> ' + _esc(e.message || String(e)) + '</div>';
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-upload"></i> Upload &amp; Create Packages';
    }
  };

  // Local HTML-escape helper — used by the bulk-results renderer
  function _esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ════════════════════════════════════════════════════════════════════
  // STOCK TRANSFERS  →  see static/inventory/inventory_transfers.js
  // ────────────────────────────────────────────────────────────────────
  // The transfer voucher handlers moved to inventory_transfers.js in
  // May 2026 to keep this file focused on godown view + opening stock.
  // ════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════
  // OPENING-STOCK EDIT (request → admin approve → apply)
  // ────────────────────────────────────────────────────────────────────
  // Any user can request changes to an opening-stock entry (all its boxes)
  // with a reason. Admins approve (changes apply to every box) or reject.
  // ════════════════════════════════════════════════════════════════════
  let _opEditGodowns = null;   // cached godown list for the edit dropdown

  async function _opEditLoadGodowns(){
    if(_opEditGodowns) return _opEditGodowns;
    try{
      const r = await fetch('/api/inventory_godown/godowns/list');
      const j = await r.json();
      _opEditGodowns = (j.status==='ok') ? (j.godowns||j.items||[]) : [];
    }catch(e){ _opEditGodowns = []; }
    return _opEditGodowns;
  }

  function _opEditEnsureModal(){
    if($('opEditOv')) return;
    const ov = document.createElement('div');
    ov.id = 'opEditOv';
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-card" style="max-width:92vw;width:560px">'
      + '<div class="modal-head"><div class="modal-title"><span>✏️</span> <span>Request opening-stock edit</span></div>'
      +   '<button class="modal-close" onclick="invOpEditClose()">&times;</button></div>'
      + '<div class="modal-body" id="opEditBody" style="padding:18px"></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e)=>{ if(e.target===ov) invOpEditClose(); });
  }

  window.invOpEditClose = function(){ const o=$('opEditOv'); if(o) o.classList.remove('show'); };

  window.invOpEditOpen = async function(i){
    const e = (window._invOpLog||[])[i];
    if(!e){ alert('Entry not found'); return; }
    _opEditEnsureModal();
    const gds = await _opEditLoadGodowns();
    const gOpts = (gds||[]).map(g =>
      '<option value="'+g.id+'"'+((String(g.id)===String(e.godown_id))?' selected':'')+'>'+esc(g.name)+'</option>').join('');
    const fld = (label, inner) =>
      '<div style="margin-bottom:12px"><label style="display:block;font-size:11px;font-weight:700;'
      + 'text-transform:uppercase;letter-spacing:.05em;color:var(--nb-text-muted);margin-bottom:4px">'
      + label + '</label>' + inner + '</div>';
    const inpCss = 'width:100%;padding:9px 11px;border:1px solid var(--nb-border-strong);border-radius:8px;font-size:13px;background:var(--white,#fff);color:var(--text,#1F1F1F)';

    $('opEditBody').innerHTML =
      '<div style="font-size:12.5px;color:var(--nb-text-muted);margin-bottom:14px;line-height:1.5">'
      + 'Editing <strong>' + esc(e.material||'') + '</strong> · ' + (e.no_of_box||0) + ' package(s) · '
      + 'created ' + _invOpFmtDate(e.created_at) + '.<br>Changes apply to <strong>all boxes</strong> in this '
      + 'entry after an admin approves.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">'
      +   fld('Qty per package', '<input type="number" step="0.001" id="opEdit-qty" style="'+inpCss+'" value="'+(e.per_box_qty||0)+'">')
      +   fld('UOM', '<input type="text" id="opEdit-uom" style="'+inpCss+'" value="'+esc(e.uom||'')+'">')
      +   fld('Batch number', '<input type="text" id="opEdit-batch" style="'+inpCss+'" value="'+esc(e.batch_num||'')+'">')
      +   fld('Expiry date', '<input type="date" id="opEdit-exp" style="'+inpCss+'" value="'+esc(e.expiry_date||'')+'">')
      +   fld('Manufacturer', '<input type="text" id="opEdit-mfr" style="'+inpCss+'" value="'+esc(e.manufacturer||'')+'">')
      +   fld('Godown', '<select id="opEdit-godown" style="'+inpCss+'">'+gOpts+'</select>')
      + '</div>'
      + fld('Reason for change (required)', '<textarea id="opEdit-reason" rows="3" style="'+inpCss+';resize:vertical" placeholder="Why does this entry need to be corrected?"></textarea>')
      + '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px">'
      +   '<button class="igd-btn" onclick="invOpEditClose()">Cancel</button>'
      +   '<button class="igd-btn igd-btn-primary" id="opEdit-submit" onclick="invOpEditSubmit('+i+')"><i class="fas fa-paper-plane"></i> Submit request</button>'
      + '</div>';
    $('opEditOv').classList.add('show');
  };

  window.invOpEditSubmit = async function(i){
    const e = (window._invOpLog||[])[i];
    if(!e) return;
    const reason = ($('opEdit-reason').value||'').trim();
    if(!reason){ alert('Please enter a reason for the change.'); return; }
    // Only send fields that actually changed from the current values.
    const changes = {};
    const newQty = parseFloat($('opEdit-qty').value);
    if(!isNaN(newQty) && newQty !== parseFloat(e.per_box_qty||0)) changes.per_box_qty = newQty;
    const newUom = ($('opEdit-uom').value||'').trim();
    if(newUom !== (e.uom||'')) changes.uom = newUom;
    const newBatch = ($('opEdit-batch').value||'').trim();
    if(newBatch !== (e.batch_num||'')) changes.batch_num = newBatch;
    const newExp = ($('opEdit-exp').value||'');
    if(newExp !== (e.expiry_date||'')) changes.expiry_date = newExp;
    const newMfr = ($('opEdit-mfr').value||'').trim();
    if(newMfr !== (e.manufacturer||'')) changes.manufacturer = newMfr;
    const newGd = parseInt($('opEdit-godown').value)||0;
    if(newGd && newGd !== parseInt(e.godown_id||0)) changes.godown_id = newGd;

    if(!Object.keys(changes).length){ alert('No changes detected. Edit a field before submitting.'); return; }

    const btn = $('opEdit-submit'); if(btn){ btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Submitting…'; }
    try{
      const r = await fetch('/api/inventory_godown/opening/edit/request', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ box_ids: e.box_ids||[], reason, changes })
      });
      const j = await r.json();
      if(j.status!=='ok') throw new Error(j.message||'Failed');
      invOpEditClose();
      if(window.invToast) window.invToast(j.message||'Edit request submitted','success');
      else alert(j.message||'Edit request submitted');
      _opEditRefreshBadge();
    }catch(err){
      alert('Could not submit: '+err.message);
      if(btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Submit request'; }
    }
  };

  // ── Approvals view (list + approve/reject) ──────────────────────────
  function _opApprEnsureModal(){
    if($('opApprOv')) return;
    const ov = document.createElement('div');
    ov.id = 'opApprOv';
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-card" style="max-width:94vw;width:760px">'
      + '<div class="modal-head"><div class="modal-title"><span>📋</span> <span>Opening-stock edit approvals</span></div>'
      +   '<button class="modal-close" onclick="invOpEditApprClose()">&times;</button></div>'
      + '<div class="modal-body" id="opApprBody" style="padding:0;max-height:72vh;overflow:auto"><div style="padding:30px;text-align:center;color:var(--nb-text-muted)">Loading…</div></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e)=>{ if(e.target===ov) invOpEditApprClose(); });
  }
  window.invOpEditApprClose = function(){ const o=$('opApprOv'); if(o) o.classList.remove('show'); };

  window.invOpEditApprovals = function(){ _opApprEnsureModal(); $('opApprOv').classList.add('show'); _opApprLoad(); };

  function _opChangeRows(ov, nv){
    const labels = {per_box_qty:'Qty/pkg', uom:'UOM', godown_id:'Godown', batch_num:'Batch', expiry_date:'Expiry', manufacturer:'Manufacturer'};
    return Object.keys(nv).map(k=>{
      const oldV = (ov && ov[k]!=null) ? ov[k] : '\u2014';
      let nVal = nv[k];
      if(k==='expiry_date'){ nVal = nVal ? _invOpFmtDate(nVal) : '\u2014'; }
      const oVal = (k==='expiry_date' && oldV && oldV!=='\u2014') ? _invOpFmtDate(oldV) : oldV;
      return '<div style="font-size:12px;margin:2px 0"><span style="color:var(--nb-text-muted)">'+esc(labels[k]||k)+':</span> '
        + '<span style="text-decoration:line-through;color:var(--nb-text-muted)">'+esc(String(oVal))+'</span> '
        + '<i class="fas fa-arrow-right" style="font-size:9px;color:var(--nb-text-muted)"></i> '
        + '<strong>'+esc(String(nVal===''?'\u2014':nVal))+'</strong></div>';
    }).join('');
  }

  async function _opApprLoad(){
    const body = $('opApprBody');
    try{
      const r = await fetch('/api/inventory_godown/opening/edit/requests');
      const j = await r.json();
      if(j.status!=='ok'){ body.innerHTML='<div style="padding:24px;color:#C5221F">'+esc(j.message||'Failed')+'</div>'; return; }
      const isAdmin = !!j.is_admin;
      const items = j.items||[];
      if(!items.length){ body.innerHTML='<div style="padding:30px;text-align:center;color:var(--nb-text-muted)">No edit requests.</div>'; return; }
      const stColor = {pending:'#B06000', approved:'#137333', rejected:'#C5221F'};
      body.innerHTML = items.map(it=>{
        const sc = stColor[it.status]||'#5F6368';
        const act = (isAdmin && it.status==='pending')
          ? '<div style="display:flex;gap:8px;margin-top:10px">'
            + '<button class="igd-btn igd-btn-primary" style="font-size:12px;padding:6px 13px" onclick="invOpEditDecide('+it.id+',\'approve\')"><i class="fas fa-check"></i> Approve &amp; apply</button>'
            + '<button class="igd-btn" style="font-size:12px;padding:6px 13px;color:#C5221F;border-color:#C5221F55" onclick="invOpEditDecide('+it.id+',\'reject\')"><i class="fas fa-xmark"></i> Reject</button>'
            + '</div>'
          : (it.decided_by ? '<div style="font-size:11px;color:var(--nb-text-muted);margin-top:8px">'+esc(it.status)+' by '+esc(it.decided_by)+' \u00b7 '+_invOpFmtDate(it.decided_at)+(it.decide_note?(' \u00b7 '+esc(it.decide_note)):'')+'</div>' : '');
        return '<div style="padding:14px 16px;border-bottom:1px solid var(--nb-bg)">'
          + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
          +   '<strong style="font-size:13px">'+esc(it.material_name||'(material)')+'</strong>'
          +   '<span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border-radius:8px;color:'+sc+';background:'+sc+'18">'+esc(it.status)+'</span>'
          +   '<span style="font-size:11px;color:var(--nb-text-muted)">'+it.box_count+' pkg(s)</span>'
          +   '<span style="margin-left:auto;font-size:11px;color:var(--nb-text-muted)">'+esc(it.requested_by)+' \u00b7 '+_invOpFmtDate(it.requested_at)+'</span>'
          + '</div>'
          + _opChangeRows(it.old_values, it.new_values)
          + '<div style="font-size:12px;margin-top:8px;background:var(--nb-bg);padding:8px 10px;border-radius:8px"><span style="color:var(--nb-text-muted)">Reason:</span> '+esc(it.reason)+'</div>'
          + act
          + '</div>';
      }).join('');
    }catch(e){ body.innerHTML='<div style="padding:24px;color:#C5221F">'+esc(e.message)+'</div>'; }
  }

  window.invOpEditDecide = async function(rid, action){
    let note = '';
    if(action==='reject'){ note = prompt('Reason for rejection (optional):')||''; }
    try{
      const r = await fetch('/api/inventory_godown/opening/edit/'+rid+'/'+action, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ note })
      });
      const j = await r.json();
      if(j.status!=='ok') throw new Error(j.message||'Failed');
      if(window.invToast) window.invToast(j.message||'Done','success');
      _opApprLoad();
      _opEditRefreshBadge();
      if(action==='approve' && typeof window.invOpLoadLog==='function') window.invOpLoadLog();
    }catch(err){ alert('Failed: '+err.message); }
  };

  async function _opEditRefreshBadge(){
    try{
      const r = await fetch('/api/inventory_godown/opening/edit/pending_count');
      const j = await r.json();
      const b = $('op-edit-pending-badge');
      if(b && j.status==='ok'){
        if(j.count>0){ b.textContent = j.count; b.style.display=''; }
        else b.style.display='none';
      }
    }catch(e){}
  }
  // Refresh the badge shortly after the log renders.
  window.invOpEditRefreshBadge = _opEditRefreshBadge;

  // Open the opening-stock entry that contains the given box ids — used by
  // deep-links (e.g. the Expiry report's clickable item name). Switches to the
  // Opening Stock panel, loads the log, finds the matching entry by box id
  // overlap, and opens its edit form (which shows the expiry field).
  window.invOpOpenEntryByBoxIds = async function(boxIds){
    boxIds = (boxIds || []).map(function(x){ return parseInt(x, 10); }).filter(Boolean);
    if(typeof window.invSwitchPanel === 'function') window.invSwitchPanel('opening-stock');
    // Ensure the log is loaded, then locate the entry.
    const findAndOpen = function(){
      const entries = window._invOpLog || [];
      let idx = -1;
      for(let i=0;i<entries.length;i++){
        const eb = (entries[i].box_ids || []).map(function(x){ return parseInt(x,10); });
        if(eb.some(function(b){ return boxIds.indexOf(b) !== -1; })){ idx = i; break; }
      }
      if(idx >= 0){
        if(typeof window.invOpEditOpen === 'function') window.invOpEditOpen(idx);
        else if(window.invToast) window.invToast('Found the entry in the Opening Stock log.', 'info');
      } else {
        if(window.invToast) window.invToast('Opening-stock entry not found in the log (it may be filtered out).', 'warn');
      }
    };
    if(typeof window.invOpLoadLog === 'function'){
      try { await window.invOpLoadLog(); } catch(e){}
      // log render is async-ish; give the DOM/state a tick.
      setTimeout(findAndOpen, 120);
    } else {
      setTimeout(findAndOpen, 300);
    }
  };

  console.log('✅ inventory_godown.js (RM phase 1) loaded');

})();
