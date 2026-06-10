/* ════════════════════════════════════════════════════════════════════
   pm_stock_findbox.js
   ────────────────────────────────────────────────────────────────────
   Find Box — drill-down explorer (Godown → Item → Packages).

   UI shape (matches screenshot reference):
     ┌────────────────────────────────────────────────────────────┐
     │  [scan input]                              "Ready to scan" │
     ├────────────┬────────────────────┬──────────────────────────┤
     │  Godowns   │  Items at <godown> │  Packages — <item>       │
     │  --------  │  ----------------  │  ------------------------│
     │  All       │  Filter items      │  RM-A0000623   20kg  ... │
     │  Factory   │  Acrylates...      │  RM-A0000622   20kg  ... │
     │  Bhayla    │  Acryset -P30      │  ...                     │
     │  ...       │  ...               │                          │
     └────────────┴────────────────────┴──────────────────────────┘

   Three async loads, each pane only fetches when its dependency
   (selection) changes. The scan input bypasses the drill-down and
   pre-selects all 3 panes to land on the scanned box's row.
   ──────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  let _fbxState = {
    godowns: [],         // [{godown_id, godown_name, item_count, package_count}]
    items: [],           // [{product_id, product_name, ...}]
    packages: [],        // [{box_id, box_code, ...}]
    selected_godown: null,
    selected_product: null,
    item_filter: '',
    highlighted_box_id: null,    // After a successful scan, scroll here.
  };

  function _fbxToast(msg, type, ms){
    if (typeof showToast === 'function') return showToast(msg, type, ms || 3000);
    if (type === 'error') console.error(msg); else console.log(msg);
  }

  function _fbxEsc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _fmt(n, decimals){
    if (n == null || n === '') return '';
    const v = Number(n);
    if (isNaN(v)) return String(n);
    return v.toLocaleString('en-IN', {
      maximumFractionDigits: decimals == null ? 3 : decimals,
    });
  }

  /* ── Open ────────────────────────────────────────────────────── */
  async function openFindBoxModal(){
    const m = document.getElementById('findBoxModal');
    if (!m){
      _fbxToast('Find Box modal not loaded — refresh the page.', 'error');
      return;
    }
    m.classList.add('open');
    // Refresh state and load godowns. The first godown gets auto-selected.
    _fbxState = {
      godowns: [], items: [], packages: [],
      selected_godown: null, selected_product: null,
      item_filter: '', highlighted_box_id: null,
    };
    _fbxRenderShell();
    await _fbxLoadGodowns();
    // Focus the scan input
    setTimeout(() => document.getElementById('fbx-scan')?.focus(), 100);
  }
  window.openFindBoxModal = openFindBoxModal;

  function closeFindBoxModal(){
    document.getElementById('findBoxModal')?.classList.remove('open');
  }
  window.closeFindBoxModal = closeFindBoxModal;

  /* ── Shell render (called once on open) ─────────────────────── */
  function _fbxRenderShell(){
    document.getElementById('fbx-godowns-list').innerHTML =
      '<div style="padding:18px;text-align:center;color:#9ca3af"><span class="spinner"></span> Loading godowns…</div>';
    document.getElementById('fbx-items-list').innerHTML =
      '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:11.5px">Pick a godown to see its products.</div>';
    document.getElementById('fbx-pkg-list').innerHTML =
      '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:11.5px">Pick a product to see its boxes.</div>';
    document.getElementById('fbx-items-title').textContent = 'Products';
    document.getElementById('fbx-pkg-title').textContent   = 'Boxes';
    document.getElementById('fbx-scan-status').textContent = 'Ready to scan';
  }

  /* ── Pane 1: Godowns ──────────────────────────────────────────── */
  async function _fbxLoadGodowns(){
    try {
      const r = await fetch('/api/pm_stock/findbox/godowns');
      const d = await r.json();
      if (d.status !== 'ok'){
        _fbxToast(d.message || 'Failed to load godowns', 'error');
        return;
      }
      _fbxState.godowns = d.rows || [];
      _fbxRenderGodowns();
      // Auto-select the first non-zero godown (or "All" if it has items)
      if (_fbxState.godowns.length > 0){
        // Prefer the first non-"All" godown with items; fall back to All
        const first = _fbxState.godowns.find(g => g.godown_id !== 0 && g.package_count > 0)
                   || _fbxState.godowns[0];
        await _fbxSelectGodown(first.godown_id);
      }
    } catch (e){
      _fbxToast('Network error: ' + e.message, 'error');
    }
  }

  function _fbxRenderGodowns(){
    const sel = _fbxState.selected_godown;
    document.getElementById('fbx-godowns-list').innerHTML =
      _fbxState.godowns.map(g => {
        const isActive = (sel != null && sel === g.godown_id);
        const tag = (g.godown_id === 0) ? 'ALL' : 'GODOWN';
        const tagColor = (g.godown_id === 0)
          ? 'background:#dbeafe;color:#1e40af'
          : 'background:#dcfce7;color:#166534';
        return `
          <div class="fbx-godown-row" onclick="_fbxPickGodown(${g.godown_id})"
               data-godown="${g.godown_id}"
               style="padding:12px 14px;cursor:pointer;border-radius:10px;margin-bottom:6px;
                      background:${isActive ? 'rgba(139,92,246,.10)' : 'transparent'};
                      border:1px solid ${isActive ? 'rgba(139,92,246,.4)' : 'transparent'};
                      transition: background .08s">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div style="font-weight:700;font-size:12.5px;color:var(--htxtb,#111);text-transform:uppercase;letter-spacing:.02em">
                ${_fbxEsc(g.godown_name)}
              </div>
              <span style="font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:999px;${tagColor};letter-spacing:.4px">
                ${tag}
              </span>
            </div>
            <div style="margin-top:4px;font-size:10.5px;color:var(--hmuted,#9ca3af);display:flex;gap:14px;font-family:monospace">
              <span><i class="fas fa-cubes"></i> ${_fmt(g.item_count, 0)} products</span>
              <span><i class="fas fa-box"></i> ${_fmt(g.package_count, 0)} boxes</span>
            </div>
          </div>
        `;
      }).join('');
  }

  window._fbxPickGodown = function(godown_id){
    _fbxSelectGodown(godown_id);
  };

  async function _fbxSelectGodown(godown_id){
    _fbxState.selected_godown  = godown_id;
    _fbxState.selected_product = null;
    _fbxState.items = [];
    _fbxState.packages = [];
    _fbxRenderGodowns();
    // Update middle-pane title
    const g = _fbxState.godowns.find(x => x.godown_id === godown_id);
    const gname = g ? g.godown_name : '';
    document.getElementById('fbx-items-title').textContent =
      'Products at ' + (gname || '?');
    document.getElementById('fbx-pkg-title').textContent = 'Boxes';
    document.getElementById('fbx-items-list').innerHTML =
      '<div style="padding:18px;text-align:center;color:#9ca3af"><span class="spinner"></span> Loading products…</div>';
    document.getElementById('fbx-pkg-list').innerHTML =
      '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:11.5px">Pick a product to see its boxes.</div>';
    await _fbxLoadItems();
  }

  /* ── Pane 2: Items at godown ─────────────────────────────────── */
  async function _fbxLoadItems(){
    const gid = _fbxState.selected_godown;
    if (gid == null) return;
    try {
      const url = '/api/pm_stock/findbox/items?godown_id=' + encodeURIComponent(gid)
        + (_fbxState.item_filter ? '&q=' + encodeURIComponent(_fbxState.item_filter) : '');
      const r = await fetch(url);
      const d = await r.json();
      if (d.status !== 'ok'){
        _fbxToast(d.message || 'Failed to load items', 'error');
        return;
      }
      _fbxState.items = d.rows || [];
      _fbxRenderItems();
    } catch (e){
      _fbxToast('Network error: ' + e.message, 'error');
    }
  }

  function _fbxRenderItems(){
    const sel = _fbxState.selected_product;
    if (_fbxState.items.length === 0){
      document.getElementById('fbx-items-list').innerHTML =
        '<div style="padding:32px;text-align:center;color:#9ca3af;font-size:11.5px">No products at this godown.</div>';
      return;
    }
    document.getElementById('fbx-items-list').innerHTML =
      _fbxState.items.map(p => {
        const isActive = (sel != null && sel === p.product_id);
        return `
          <div class="fbx-item-row" onclick="_fbxPickItem(${p.product_id})"
               data-product="${p.product_id}"
               style="padding:11px 14px;cursor:pointer;border-radius:10px;margin-bottom:5px;
                      background:${isActive ? 'rgba(139,92,246,.10)' : 'transparent'};
                      border:1px solid ${isActive ? 'rgba(139,92,246,.4)' : 'transparent'}">
            <div style="font-weight:600;font-size:12.5px;color:var(--htxtb,#111)">${_fbxEsc(p.product_name)}</div>
            ${p.pm_type ? `<div style="margin-top:2px;font-size:9.5px;color:#7c3aed;font-weight:700;letter-spacing:.4px;text-transform:uppercase">${_fbxEsc(p.pm_type)}</div>` : ''}
            <div style="margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:10px">
              <div style="font-family:monospace;font-size:13px;color:#16a34a;font-weight:700">
                ${_fmt(p.total_qty)} <span style="color:#9ca3af;font-size:10.5px;font-weight:600">${_fbxEsc(p.primary_uom)}</span>
              </div>
              <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);font-family:monospace">${_fmt(p.package_count, 0)} boxes</div>
            </div>
          </div>
        `;
      }).join('');
  }

  window._fbxPickItem = function(product_id){
    _fbxState.selected_product = product_id;
    _fbxState.packages = [];
    _fbxRenderItems();
    const p = _fbxState.items.find(x => x.product_id === product_id);
    document.getElementById('fbx-pkg-title').textContent =
      'Boxes — ' + (p ? p.product_name : '?');
    document.getElementById('fbx-pkg-list').innerHTML =
      '<div style="padding:18px;text-align:center;color:#9ca3af"><span class="spinner"></span> Loading boxes…</div>';
    _fbxLoadPackages();
  };

  let _fbxItemFilterT = null;
  window._fbxFilterItems = function(val){
    _fbxState.item_filter = val || '';
    clearTimeout(_fbxItemFilterT);
    _fbxItemFilterT = setTimeout(_fbxLoadItems, 250);
  };

  /* ── Pane 3: Packages ────────────────────────────────────────── */
  async function _fbxLoadPackages(){
    const gid = _fbxState.selected_godown;
    const pid = _fbxState.selected_product;
    if (gid == null || pid == null) return;
    try {
      const url = '/api/pm_stock/findbox/packages?godown_id=' + encodeURIComponent(gid)
                + '&product_id=' + encodeURIComponent(pid);
      const r = await fetch(url);
      const d = await r.json();
      if (d.status !== 'ok'){
        _fbxToast(d.message || 'Failed to load packages', 'error');
        return;
      }
      _fbxState.packages = d.rows || [];
      _fbxRenderPackages();
    } catch (e){
      _fbxToast('Network error: ' + e.message, 'error');
    }
  }

  function _fbxRenderPackages(){
    if (_fbxState.packages.length === 0){
      document.getElementById('fbx-pkg-list').innerHTML =
        '<div style="padding:32px;text-align:center;color:#9ca3af;font-size:11.5px">No boxes for this product at this godown.</div>';
      return;
    }
    const highlight = _fbxState.highlighted_box_id;
    document.getElementById('fbx-pkg-list').innerHTML =
      _fbxState.packages.map(b => {
        const isHi = (highlight != null && highlight === b.box_id);
        const statusColor = {
          'in_stock':    { bg:'#dcfce7', fg:'#166534', label:'IN STOCK' },
          'in_transit':  { bg:'#fef3c7', fg:'#92400e', label:'IN TRANSIT' },
          'consumed':    { bg:'#e0e7ff', fg:'#3730a3', label:'CONSUMED' },
          'damaged':     { bg:'#fee2e2', fg:'#991b1b', label:'DAMAGED' },
          'lost':        { bg:'#fee2e2', fg:'#991b1b', label:'LOST' },
        }[b.current_status] || { bg:'#f3f4f6', fg:'#4b5563', label:b.current_status };

        const dateStr = (b.created_at || '').slice(0,10);
        const code = b.short_code || b.box_code;
        return `
          <div class="fbx-pkg-row${isHi ? ' fbx-pkg-hi' : ''}"
               data-box="${b.box_id}"
               style="padding:11px 14px;border-bottom:1px solid rgba(0,0,0,.05);
                      background:${isHi ? 'rgba(139,92,246,.12)' : 'transparent'};
                      ${isHi ? 'border-left:3px solid #8b5cf6;' : ''}
                      transition: background .15s">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
              <div style="min-width:0;flex:1">
                <div style="font-family:monospace;font-weight:700;font-size:12.5px;color:var(--htxtb,#111)">
                  ${_fbxEsc(code || '(no code)')}
                </div>
                <div style="margin-top:2px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-family:monospace">
                  ${_fmt(b.per_box_qty)} ${_fbxEsc(b.primary_uom)}
                  ${b.is_opening ? ' · <span style="color:#7c3aed">⚑ Opening</span>' : ''}
                  ${b.is_split_child ? ' · <span style="color:#0ea5e9">⤴ Split child</span>' : ''}
                </div>
              </div>
              <div style="text-align:right;min-width:110px">
                <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${statusColor.bg};color:${statusColor.fg};font-size:9.5px;font-weight:700;letter-spacing:.4px">
                  ${statusColor.label}
                </span>
                <div style="margin-top:2px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-family:monospace">
                  ${_fbxEsc(dateStr)}
                </div>
              </div>
            </div>
          </div>
        `;
      }).join('');

    // Scroll the highlighted row into view
    if (highlight != null){
      setTimeout(() => {
        const el = document.querySelector(`#fbx-pkg-list .fbx-pkg-row[data-box="${highlight}"]`);
        if (el) el.scrollIntoView({behavior:'smooth', block:'center'});
      }, 60);
    }
  }

  /* ── Scan input: jump straight to a box ──────────────────────── */
  let _fbxScanT = null;
  window._fbxScanInput = function(val){
    // Debounce so multi-char scanner streams don't fire per-char.
    clearTimeout(_fbxScanT);
    _fbxScanT = setTimeout(() => _fbxScanResolve(val), 180);
  };
  window._fbxScanEnter = function(val){
    clearTimeout(_fbxScanT);
    _fbxScanResolve(val);
  };

  async function _fbxScanResolve(val){
    const code = (val || '').trim();
    if (!code) return;
    const statusEl = document.getElementById('fbx-scan-status');
    statusEl.textContent = 'Searching…';
    statusEl.style.color = '#9ca3af';
    try {
      const r = await fetch('/api/pm_stock/findbox/locate?code=' + encodeURIComponent(code));
      const d = await r.json();
      if (d.status === 'not_found'){
        statusEl.textContent = '✗ ' + (d.message || 'Not found');
        statusEl.style.color = '#dc2626';
        return;
      }
      if (d.status !== 'ok'){
        statusEl.textContent = '✗ ' + (d.message || 'Error');
        statusEl.style.color = '#dc2626';
        return;
      }
      const b = d.box;
      statusEl.textContent = `✓ Found in ${b.godown_name}`;
      statusEl.style.color = '#16a34a';
      // Drill down to it
      _fbxState.highlighted_box_id = b.box_id;
      const targetGid = (b.godown_id == null || b.godown_id === -1) ? -1 : b.godown_id;
      // Set selections in state, then load each pane in sequence
      if (_fbxState.selected_godown !== targetGid){
        _fbxState.selected_godown = targetGid;
        _fbxRenderGodowns();
        await _fbxLoadItems();
      }
      if (_fbxState.selected_product !== b.product_id){
        _fbxState.selected_product = b.product_id;
        _fbxRenderItems();
        document.getElementById('fbx-pkg-title').textContent = 'Boxes — ' + b.product_name;
        await _fbxLoadPackages();
      } else {
        // Same product — just re-render to apply highlight
        _fbxRenderPackages();
      }
      // Clear the scan input so the next scan starts fresh
      const input = document.getElementById('fbx-scan');
      if (input){ input.value = ''; input.focus(); }
    } catch (e){
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = '#dc2626';
    }
  }

})();
