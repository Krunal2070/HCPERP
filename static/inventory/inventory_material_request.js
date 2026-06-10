/* ═══════════════════════════════════════════════════════════════════════
   inventory_material_request.js — Material Request  (Inventory Phase 2)
   HCP Wellness · ported & adapted from pm_material_request.js
   ───────────────────────────────────────────────────────────────────────
   A self-contained panel + sidebar nav item for the Material Request
   workflow. Requesters create requests for RM materials to be delivered to
   a destination godown; the request auto-fulfills as stock transfers are
   received at that godown (handled server-side).

   Gated behind the Phase 1 'material_request' access flag.

   Backend: inventory_material_request.py → /api/inventory_mgmt/material_request/*
   =================================================================== */

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const fmtQty = (n) => Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:3});
  // DD/MM/YYYY formatter (inventory ERP standard). Accepts 'YYYY-MM-DD',
  // ISO datetimes, or anything Date can parse; returns input unchanged on fail.
  const fmtDMY = (v) => {
    if(!v) return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);   // YYYY-MM-DD[...]
    if(m) return `${m[3]}/${m[2]}/${m[1]}`;
    const d = new Date(s);
    if(!isNaN(d)){
      const p = (x)=>String(x).padStart(2,'0');
      return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
    }
    return s;
  };

  const API = '/api/inventory_mgmt/material_request';

  // Render target. The Material Request UI now lives as the 4th pill tab on
  // the Stock Transfers panel (#tr-pane-request) instead of its own panel.
  // _mrHost() returns that pane; falls back to the legacy standalone panel
  // if the transfers pane isn't present (defensive).
  function _mrHost(){
    return document.getElementById('tr-pane-request')
        || document.getElementById('panel-material-request');
  }

  const S = {
    requests:[], godowns:[], rmItems:[], lines:[],
    detail:null, view:'list',  // 'list' | 'create' | 'detail'
    statusFilter:'',
    srcStock:{},          // material_id -> qty at the chosen source godown
    srcGodownId:'',       // currently selected source godown
    openCombo:null,       // index of the line whose material combo is open
    nonZeroOnly:false,    // filter combobox to materials with stock at source
  };

  // Default godown matching. Names vary in word order across installs
  // (e.g. "BHAYLA OLD GODOWN" vs "Old Bhayla Godown"), so we match on a set
  // of keywords ALL being present rather than an exact substring.
  const DEFAULT_SOURCE_KEYWORDS = ['bhayla', 'old'];
  const DEFAULT_DEST_KEYWORDS   = ['factory'];
  function _findGodownByKeywords(keywords){
    const kw = keywords.map(k => k.toLowerCase());
    // Prefer a godown whose name contains ALL keywords.
    let hit = S.godowns.find(g => {
      const n = String(g.name || '').toLowerCase();
      return kw.every(k => n.includes(k));
    });
    // Fallback: any godown containing the first keyword.
    if(!hit && kw.length){
      hit = S.godowns.find(g => String(g.name || '').toLowerCase().includes(kw[0]));
    }
    return hit ? hit.id : '';
  }
  function _findGodownByName(frag){  // kept for compatibility
    return _findGodownByKeywords([frag]);
  }

  /* ── status pill ──────────────────────────────────────────────────── */
  function statusPill(st){
    const map = {
      draft:       ['#7c3aed','rgba(124,58,237,.12)','Draft'],
      pending:     ['#92400e','rgba(217,119,6,.14)','Pending'],
      in_progress: ['#1e40af','rgba(37,99,235,.14)','In Progress'],
      fulfilled:   ['#166534','rgba(22,163,74,.16)','Fulfilled'],
      cancelled:   ['#6b7280','rgba(107,114,128,.14)','Cancelled'],
      preclosed:   ['#7c3aed','rgba(124,58,237,.14)','Pre-closed'],
    };
    const [fg,bg,txt] = map[st] || ['#374151','#eee',st];
    return `<span style="padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700;color:${fg};background:${bg}">${txt}</span>`;
  }

  /* ════════════════════════════════════════════════════════════════════
     DATA LOADERS
  ════════════════════════════════════════════════════════════════════ */
  async function loadGodowns(){
    if(S.godowns.length) return S.godowns;
    try {
      const r = await fetch('/api/inventory_godown/godowns/list');
      const d = await r.json();
      S.godowns = (d.godowns || d.rows || []).map(g => ({ id:g.id, name:g.name }));
    } catch(e){ S.godowns = []; }
    return S.godowns;
  }
  async function loadRmItems(){
    if(S.rmItems.length) return S.rmItems;
    try {
      const r = await fetch('/api/inventory_mgmt/items?department=RM');
      const d = await r.json();
      const arr = d.items || d.rows || [];
      S.rmItems = arr.map(it => ({ id:it.id, name:it.name || it.material_name || '', uom:it.uom || '' }));
    } catch(e){ S.rmItems = []; }
    return S.rmItems;
  }
  async function loadGodownStock(gid){
    S.srcGodownId = gid || '';
    try {
      const qs = gid ? ('?godown_id=' + encodeURIComponent(gid)) : '';
      const r = await fetch(API + '/godown_stock' + qs);
      const d = await r.json();
      S.srcStock = (d.status === 'ok') ? (d.stock || {}) : {};
    } catch(e){ S.srcStock = {}; }
    return S.srcStock;
  }
  function srcQty(materialId){
    const q = S.srcStock[String(materialId)];
    return (q === undefined || q === null) ? null : Number(q);
  }
  async function loadList(){
    const qs = S.statusFilter ? ('?status=' + encodeURIComponent(S.statusFilter)) : '';
    try {
      const r = await fetch(API + '/list' + qs);
      const d = await r.json();
      if(d.status === 'ok'){ S.requests = d.requests || []; }
      else { toast(d.message || 'Failed to load requests','error',4000); S.requests = []; }
    } catch(e){ toast('Network error loading requests','error',4000); S.requests = []; }
  }

  /* ════════════════════════════════════════════════════════════════════
     RENDER — LIST
  ════════════════════════════════════════════════════════════════════ */
  function renderList(){
    const panel = _mrHost();
    if(!panel) return;
    const filters = ['', 'draft', 'pending', 'in_progress', 'fulfilled', 'preclosed', 'cancelled'];
    const flabel  = { '':'All', draft:'Drafts', pending:'Pending', in_progress:'In Progress', fulfilled:'Fulfilled', preclosed:'Pre-closed', cancelled:'Cancelled' };
    const chips = filters.map(f =>
      `<button class="btn ${S.statusFilter===f?'btn-primary':''}" style="padding:5px 12px;font-size:12px"
        onclick="invMRSetFilter('${f}')">${flabel[f]}</button>`).join('');

    const rows = S.requests.length ? S.requests.map(r => {
      const pct = r.total_requested > 0 ? Math.round(100 * r.total_fulfilled / r.total_requested) : 0;
      return `
        <tr style="cursor:pointer" ondblclick="invMROpenDetail(${r.id})" title="Double-click to open">
          <td style="font-weight:700;white-space:nowrap">${esc(r.request_no)}</td>
          <td style="white-space:nowrap">${fmtDMY(r.request_date)}</td>
          <td>${esc(r.dest_godown_name || ('#'+r.dest_godown_id))}</td>
          <td style="white-space:nowrap">${esc(r.requested_by)}</td>
          <td style="text-align:right;white-space:nowrap">${r.item_count}</td>
          <td style="text-align:right;white-space:nowrap">${fmtQty(r.total_fulfilled)} / ${fmtQty(r.total_requested)}
            <div style="height:5px;background:var(--surface,#eef2f7);border-radius:3px;margin-top:3px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:var(--brand,#2563eb)"></div></div>
          </td>
          <td style="white-space:nowrap">${statusPill(r.status)}</td>
          <td style="white-space:nowrap" onclick="event.stopPropagation()">
            <button class="btn" style="padding:4px 10px;font-size:12px" onclick="invMROpenDetail(${r.id})"><i class="fas fa-eye"></i> View</button>
            ${r.status==='draft'
              ? `<button class="btn" style="padding:4px 10px;font-size:12px;color:#7c3aed;border-color:#c4b5fd" onclick="invMRSubmitDraft(${r.id})"><i class="fas fa-paper-plane"></i> Submit</button>`
              : ''}
            ${(r.status==='pending'||r.status==='in_progress')
              ? `<button class="btn" style="padding:4px 10px;font-size:12px;color:#7c3aed;border-color:#c4b5fd" onclick="invMRPreclose(${r.id},'${esc((r.request_no||'').replace(/'/g,''))}')"><i class="fas fa-flag-checkered"></i> Pre-close</button>`
              : ''}
          </td>
        </tr>`;
    }).join('') : `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--muted,#9ca3af);font-style:italic">No material requests yet.</td></tr>`;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:18px;font-weight:800">Material Requests</h2>
        <div style="flex:1"></div>
        <button class="btn btn-primary" onclick="invMRShowCreate()"><i class="fas fa-plus"></i> New Request</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">${chips}</div>
      <div class="inv-table-wrap"><div class="inv-table-scroll">
        <table class="inv-table" style="width:100%;table-layout:auto">
          <colgroup>
            <col style="width:1%"><col style="width:1%"><col><col style="width:1%">
            <col style="width:1%"><col style="width:220px"><col style="width:1%"><col style="width:1%">
          </colgroup>
          <thead><tr>
            <th style="white-space:nowrap">Request No</th><th style="white-space:nowrap">Date</th><th>Destination</th><th style="white-space:nowrap">Requested By</th>
            <th style="text-align:right;white-space:nowrap">Items</th><th style="text-align:right;white-space:nowrap">Fulfilled / Requested</th><th style="white-space:nowrap">Status</th><th style="white-space:nowrap">Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div></div>`;
  }

  /* ════════════════════════════════════════════════════════════════════
     RENDER — CREATE
  ════════════════════════════════════════════════════════════════════ */
  /* ── searchable material combobox per line ────────────────────────────
     A custom dropdown (native <select> can't do type-to-search the way we
     want). Shows each material with its qty at the chosen source godown.
     Arrow keys navigate, Enter selects, Esc closes. */
  function _lineSelectedLabel(line){
    if(!line.material_id) return '';
    const it = S.rmItems.find(x => String(x.id) === String(line.material_id));
    if(!it) return '';
    // Show material + UOM only. Stock qty is visible in the picker dropdown's
    // right-aligned badge during selection, and in the FEFO popup that opens
    // after pick. Showing qty here made the line look like saved/bound data.
    return `${esc(it.name)}${it.uom?(' ('+esc(it.uom)+')'):''}`;
  }
  function lineRowHtml(line, idx){
    const sel = _lineSelectedLabel(line);
    return `
      <tr data-line="${idx}">
        <td style="position:relative;width:auto;min-width:320px">
          <input type="text" id="mr-mat-input-${idx}" autocomplete="off"
            value="${sel}" placeholder="Type to search material…"
            onfocus="invMRComboOpen(${idx})" oninput="invMRComboInput(${idx})" onkeydown="invMRComboKey(${idx},event)"
            style="width:100%;padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111)">
          <div id="mr-mat-dd-${idx}" style="display:none;position:absolute;top:calc(100% + 3px);left:0;right:0;max-height:280px;overflow-y:auto;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.14);z-index:30"></div>
        </td>
        <td style="width:120px"><input type="number" min="0" step="any" value="${line.qty_requested||''}"
          oninput="invMRLineSet(${idx},'qty_requested',this.value)" placeholder="Qty"
          style="width:100%;padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111);text-align:right"></td>
        <td style="width:240px"><input type="text" value="${esc(line.remarks||'')}"
          oninput="invMRLineSet(${idx},'remarks',this.value)" placeholder="Remarks (optional)"
          style="width:100%;padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111)"></td>
        <td style="width:46px;text-align:center"><button class="btn" style="padding:4px 9px" onclick="invMRLineRemove(${idx})" title="Remove">&times;</button></td>
      </tr>`;
  }

  function _comboMatches(q){
    const lq = (q||'').toLowerCase().trim();
    let arr = S.rmItems;
    if(S.nonZeroOnly){
      // Keep only materials with a positive qty at the chosen source godown.
      arr = arr.filter(it => { const v = srcQty(it.id); return v !== null && v > 0; });
    }
    if(lq) arr = arr.filter(it => String(it.name||'').toLowerCase().includes(lq));
    return arr.slice(0, 200);
  }
  function invMRComboOpen(idx){
    S.openCombo = idx;
    invMRComboRender(idx, _comboMatches($('mr-mat-input-'+idx)?.value || ''), -1);
  }
  function invMRComboInput(idx){
    // typing clears the current selection until they pick again
    if(S.lines[idx]) S.lines[idx].material_id = '';
    invMRComboRender(idx, _comboMatches($('mr-mat-input-'+idx)?.value || ''), 0);
  }
  function invMRComboRender(idx, matches, hi){
    const dd = $('mr-mat-dd-'+idx);
    if(!dd) return;
    dd._hi = hi;
    if(!matches.length){
      dd.innerHTML = `<div style="padding:11px 13px;font-size:12px;color:var(--muted,#9ca3af);font-style:italic">No materials match</div>`;
      dd.style.display = 'block'; return;
    }
    dd.innerHTML = matches.map((it,i) => {
      const q = srcQty(it.id);
      const qbadge = (q !== null)
        ? `<span style="margin-left:auto;font-size:11px;font-weight:700;color:${q>0?'#166534':'#9ca3af'};background:${q>0?'rgba(22,163,74,.12)':'rgba(148,163,184,.14)'};padding:1px 8px;border-radius:9px">${fmtQty(q)} ${esc(it.uom||'')}</span>`
        : `<span style="margin-left:auto;font-size:10.5px;color:var(--muted,#cbd5e1)">${esc(it.uom||'')}</span>`;
      return `<div class="mr-mat-opt" data-i="${i}" data-id="${it.id}"
        onmousedown="invMRComboPick(${idx}, ${it.id})"
        style="display:flex;align-items:center;gap:8px;padding:8px 13px;cursor:pointer;border-bottom:1px solid var(--border,rgba(0,0,0,.05));background:${i===hi?'rgba(37,99,235,.08)':''}">
        <span style="font-size:13px;font-weight:600;color:var(--text,#111)">${esc(it.name)}</span>${qbadge}</div>`;
    }).join('');
    dd.style.display = 'block';
    dd._matches = matches;
  }
  function invMRComboKey(idx, ev){
    const dd = $('mr-mat-dd-'+idx);
    if(!dd || dd.style.display === 'none'){ if(ev.key==='ArrowDown'){ invMRComboOpen(idx); ev.preventDefault(); } return; }
    const opts = Array.from(dd.querySelectorAll('.mr-mat-opt'));
    if(!opts.length) return;
    let hi = dd._hi == null ? -1 : dd._hi;
    const paint = () => opts.forEach((o,i)=>o.style.background = i===hi?'rgba(37,99,235,.08)':'');
    if(ev.key==='ArrowDown'){ hi=Math.min(opts.length-1,hi+1); dd._hi=hi; paint(); opts[hi].scrollIntoView({block:'nearest'}); ev.preventDefault(); }
    else if(ev.key==='ArrowUp'){ hi=Math.max(0,hi-1); dd._hi=hi; paint(); opts[hi].scrollIntoView({block:'nearest'}); ev.preventDefault(); }
    else if(ev.key==='Enter'){ if(hi<0) hi=0; const id=opts[hi]?.getAttribute('data-id'); if(id) invMRComboPick(idx, Number(id)); ev.preventDefault(); }
    else if(ev.key==='Escape'){ dd.style.display='none'; ev.preventDefault(); }
  }
  function invMRComboPick(idx, materialId){
    if(S.lines[idx]) S.lines[idx].material_id = materialId;
    const it = S.rmItems.find(x => String(x.id) === String(materialId));
    const inp = $('mr-mat-input-'+idx);
    if(inp && it) inp.value = _lineSelectedLabel(S.lines[idx]);
    const dd = $('mr-mat-dd-'+idx); if(dd) dd.style.display = 'none';
    S.openCombo = null;
    // FEFO popup: gated by mr_batch_popup access (default ON). Admins
    // always pass. Skip if no source godown set — popup needs one.
    if(materialId && S.srcGodownId && _mrBatchPopupAllowed()){
      _invMROpenBatchPopup(idx, materialId, S.srcGodownId);
    }
  }

  // Returns true if the FEFO batch popup is allowed for the current user.
  // Defaults to TRUE (helpful for new users); admins or anyone with the
  // mr_batch_popup permission gets it. Falsy/'off' string disables it.
  function _mrBatchPopupAllowed(){
    const acc = window._invAccess;
    if(!acc || !acc.ready) return true;   // not loaded yet — fail open
    if(acc.is_admin) return true;
    const v = acc.access && acc.access.mr_batch_popup;
    return !(v === 'off' || v === false);
  }

  /* ════════════════════════════════════════════════════════════════════
     FEFO BATCH POPUP
     ────────────────────────────────────────────────────────────────────
     Pops up after material pick (when source godown is set). Shows
     in-stock batches at that source ordered first-expiring-first. Same
     ORDER BY as /suggest_boxes uses at fulfilment, so what the user sees
     is what they'll get. Click OK to dismiss.
  ════════════════════════════════════════════════════════════════════ */
  function _ensureBatchPopup(){
    let m = $('invMRBatchModal');
    if(m) return m;
    m = document.createElement('div');
    m.id = 'invMRBatchModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);'
      + 'display:none;align-items:flex-start;justify-content:center;z-index:9999;'
      + 'padding:50px 20px 20px;overflow-y:auto';
    m.innerHTML = `
      <div style="background:var(--card,#fff);border-radius:14px;width:min(820px,100%);
                  box-shadow:0 30px 60px rgba(0,0,0,.25);overflow:hidden;
                  border:1px solid var(--border,rgba(0,0,0,.08))">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border,rgba(0,0,0,.06));
                    background:linear-gradient(135deg,rgba(70,72,212,.06),rgba(124,58,237,.02));
                    display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <i class="fas fa-layer-group" style="color:var(--brand,#4648D4)"></i>
          <div style="flex:1;min-width:0">
            <div id="invMRBatchTitle" style="font-size:14px;font-weight:800;color:var(--text,#111);line-height:1.3"></div>
            <div id="invMRBatchSubtitle" style="font-size:11.5px;color:var(--muted,#6b7280);margin-top:2px"></div>
          </div>
          <button onclick="document.getElementById('invMRBatchModal').style.display='none'"
                  class="btn" style="padding:4px 9px;font-size:12px">&times;</button>
        </div>
        <div id="invMRBatchBody" style="padding:14px 18px;max-height:60vh;overflow-y:auto"></div>
        <div style="padding:12px 18px;border-top:1px solid var(--border,rgba(0,0,0,.06));
                    display:flex;justify-content:space-between;align-items:center;gap:12px;
                    background:rgba(0,0,0,.015)">
          <div id="invMRBatchFooter" style="font-size:11.5px;color:var(--muted,#6b7280)"></div>
          <button class="btn btn-primary" onclick="document.getElementById('invMRBatchModal').style.display='none'">OK</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (ev) => { if(ev.target === m) m.style.display = 'none'; });
    document.addEventListener('keydown', (ev) => {
      if(ev.key === 'Escape' && m.style.display === 'flex') m.style.display = 'none';
    });
    return m;
  }

  async function _invMROpenBatchPopup(idx, materialId, sourceId){
    const m = _ensureBatchPopup();
    const it = S.rmItems.find(x => String(x.id) === String(materialId));
    const matName = it ? it.name : '';
    const srcName = (S.godowns.find(g => String(g.id) === String(sourceId)) || {}).name || '';
    $('invMRBatchTitle').textContent = matName || 'Material batches';
    $('invMRBatchSubtitle').textContent = srcName
      ? `FEFO order at ${srcName} — boxes will be consumed top-to-bottom`
      : 'FEFO order — boxes will be consumed top-to-bottom';
    $('invMRBatchBody').innerHTML =
      `<div style="padding:20px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">Loading batches…</div>`;
    $('invMRBatchFooter').textContent = '';
    m.style.display = 'flex';
    try {
      const r = await fetch(API + '/material_batches'
        + '?material_id=' + encodeURIComponent(materialId)
        + '&source_godown_id=' + encodeURIComponent(sourceId));
      const d = await r.json();
      if(d.status !== 'ok'){
        $('invMRBatchBody').innerHTML =
          `<div style="padding:18px;color:var(--danger,#dc2626);font-size:12.5px">${esc(d.message || 'Failed to load batches')}</div>`;
        return;
      }
      const batches = d.batches || [];
      if(!batches.length){
        $('invMRBatchBody').innerHTML =
          `<div style="padding:24px;text-align:center;color:var(--muted,#9ca3af);font-size:13px">
             <i class="fas fa-box-open" style="font-size:24px;color:#cbd5e1;margin-bottom:8px;display:block"></i>
             No in-stock boxes for this material at the selected source godown.
           </div>`;
        $('invMRBatchFooter').textContent = '0 batches · 0 boxes';
        return;
      }
      const uom = d.uom || '';
      const rows = batches.map((b, i) => {
        const boxChips = (b.boxes || []).slice(0, 30).map(box =>
          `<span style="display:inline-block;padding:2px 7px;margin:1px;border-radius:6px;
                        background:rgba(70,72,212,.07);color:var(--text2,#374151);
                        font-size:10.5px;font-family:monospace">${esc(box.box_code)}
            <span style="opacity:.6">·${fmtQty(box.per_box_qty)}</span></span>`).join('');
        const moreChip = b.boxes && b.boxes.length > 30
          ? `<span style="display:inline-block;padding:2px 7px;margin:1px;font-size:10.5px;
                          color:var(--muted,#9ca3af);font-style:italic">+${b.boxes.length-30} more</span>`
          : '';
        return `
          <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:11px 13px;margin-bottom:9px;
                      background:${i===0?'rgba(22,163,74,.05)':'var(--card,#fff)'}">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
              <div>
                <span style="display:inline-block;padding:2px 7px;border-radius:5px;
                             background:${i===0?'#16a34a':'var(--muted,#9ca3af)'};color:#fff;
                             font-size:10px;font-weight:800;letter-spacing:.4px;margin-right:8px">#${i+1}${i===0?' · FIRST OUT':''}</span>
                <strong style="font-size:12.5px;color:var(--text,#111)">Batch ${esc(b.batch_num || '—')}</strong>
                <span style="font-size:11px;color:var(--muted,#6b7280);margin-left:8px">${esc(b.grn_no || '—')}</span>
              </div>
              <div style="font-size:11.5px;color:var(--text2,#374151);text-align:right">
                <strong>${fmtQty(b.total_qty)} ${esc(uom)}</strong>
                <span style="color:var(--muted,#9ca3af)"> · ${b.box_count} box(es)</span>
              </div>
            </div>
            <div style="margin-top:6px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;
                        font-size:11px;color:var(--muted,#6b7280)">
              ${b.expiry_date ? `<div><strong style="color:#dc2626">EXP ${esc(_invMRFmtDate(b.expiry_date))}</strong></div>` : `<div style="font-style:italic;color:#9ca3af">No expiry</div>`}
              ${b.mfg_date    ? `<div>MFG ${esc(_invMRFmtDate(b.mfg_date))}</div>` : ''}
              ${b.grn_date    ? `<div>GRN ${esc(_invMRFmtDate(b.grn_date))}</div>` : ''}
              ${b.supplier    ? `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(b.supplier)}">Supplier: ${esc(b.supplier)}</div>` : ''}
            </div>
            <div style="margin-top:8px;line-height:1.7">${boxChips}${moreChip}</div>
          </div>`;
      }).join('');
      $('invMRBatchBody').innerHTML = rows;
      const t = d.totals || {};
      $('invMRBatchFooter').textContent =
        `${batches.length} batch(es) · ${t.total_boxes||0} box(es) · ${fmtQty(t.total_qty||0)} ${uom} available`;
    } catch(e){
      $('invMRBatchBody').innerHTML =
        `<div style="padding:18px;color:var(--danger,#dc2626);font-size:12.5px">Network error: ${esc(e.message||e)}</div>`;
    }
  }

  // Local DD/MM/YYYY formatter (inventory module's standing rule).
  function _invMRFmtDate(iso){
    if(!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
  }
  // close any open combo on outside click
  document.addEventListener('click', (ev) => {
    if(S.openCombo === null) return;
    const inp = $('mr-mat-input-'+S.openCombo), dd = $('mr-mat-dd-'+S.openCombo);
    if(!inp || !dd) return;
    if(ev.target === inp || dd.contains(ev.target)) return;
    dd.style.display = 'none'; S.openCombo = null;
  });

  function renderCreate(){
    const panel = _mrHost();
    if(!panel) return;
    // ── Location lock (May 2026) ──
    // If this user is pinned to a godown, destination MUST be that
    // godown. We pre-select it, drop all other options, and disable
    // the picker. Server enforces the same rule on /save so a manual
    // POST can't bypass it.
    const acc      = window._invAccess || {};
    const lockedId = acc.locked_godown_id;
    const lockedNm = acc.locked_godown_name || '';
    const isLocked = !!lockedId && !acc.is_admin;

    const godOpts = (selId, opts = {}) => {
      // When destination is locked, render ONLY the locked godown as the
      // single option (defensive — the disabled attr is the primary UX).
      const list = (opts.lockedOnly && isLocked)
        ? S.godowns.filter(g => String(g.id) === String(lockedId))
        : S.godowns;
      return list.map(g =>
        `<option value="${g.id}" ${String(selId)===String(g.id)?'selected':''}>${esc(g.name)}</option>`
      ).join('');
    };

    const today = new Date().toISOString().slice(0,10);
    if(!S.lines.length) S.lines = [{ material_id:'', qty_requested:'', remarks:'' }];
    const lineRows = S.lines.map((l,i) => lineRowHtml(l,i)).join('');
    const defSrc  = S.srcGodownId || _findGodownByKeywords(DEFAULT_SOURCE_KEYWORDS);
    // When locked, destination defaults to the locked godown unconditionally.
    const defDest = isLocked ? lockedId : _findGodownByKeywords(DEFAULT_DEST_KEYWORDS);

    // Header action buttons live on the same row as the "Next MR" chip.
    // The grid is given a larger fixed height + overflow:auto so the
    // table can scroll independently when the operator adds lots of
    // items, without pushing the page-level form controls offscreen.
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn" onclick="invMRShowList()"><i class="fas fa-arrow-left"></i> Back</button>
        <h2 style="margin:0;font-size:18px;font-weight:800">New Material Request</h2>
        <div style="flex:1"></div>
        <button class="btn" id="mr-draft-btn" onclick="invMRSave(true)" style="border-color:#c4b5fd;color:#7c3aed">
          <i class="fas fa-file-pen"></i> Save as Draft
        </button>
        <button class="btn btn-primary" id="mr-save-btn" onclick="invMRSave(false)">
          <i class="fas fa-paper-plane"></i> Submit Request
        </button>
        <button class="btn" onclick="invMRShowList()">Cancel</button>
        <span id="mr-next-no-chip"
              title="Allocated on submit. If another user submits first, your number bumps up."
              style="display:inline-flex;align-items:center;gap:8px;padding:5px 12px;
                     background:linear-gradient(135deg,rgba(70,72,212,.08),rgba(124,58,237,.04));
                     border:1px solid rgba(70,72,212,.2);border-radius:999px;
                     font-size:11px;font-weight:700;letter-spacing:.3px;color:var(--brand,#4648D4)">
          <i class="fas fa-hashtag" style="font-size:10px;opacity:.7"></i>
          <span style="color:var(--muted,#6b7280);text-transform:uppercase;font-size:10px">Next MR</span>
          <span id="mr-next-no-value" style="font-family:monospace;color:var(--brand,#4648D4)">…</span>
        </span>
      </div>
      <div style="width:100%">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:16px">
          <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#6b7280);display:block;margin-bottom:4px">Request Date</label>
            <input type="date" id="mr-date" value="${today}" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)"></div>
          <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#6b7280);display:block;margin-bottom:4px">Source Godown</label>
            <select id="mr-source" onchange="invMRSourceChanged(this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)"><option value="">— any —</option>${godOpts(defSrc)}</select></div>
          <div><label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#6b7280);display:block;margin-bottom:4px">
              Destination Godown *
              ${isLocked ? `<span style="text-transform:none;font-weight:600;color:var(--brand,#4648D4);margin-left:6px"><i class="fas fa-lock" style="font-size:9px"></i> Locked to ${esc(lockedNm)}</span>` : ''}
            </label>
            <select id="mr-dest"
                    ${isLocked ? 'disabled title="Your account is pinned to this godown — admin can change the lock."' : ''}
                    style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:${isLocked?'var(--surface,#f1f5f9)':'var(--card,#fff)'};color:var(--text,#111);${isLocked?'cursor:not-allowed;font-weight:600':''}">
              ${isLocked ? '' : '<option value="">— select —</option>'}
              ${godOpts(defDest, { lockedOnly: true })}
            </select></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:700">Items</span>
          <span style="font-weight:400;color:var(--muted,#9ca3af);font-size:11px">— qty shown is available stock at the selected source godown</span>
          <label style="margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);cursor:pointer;user-select:none">
            <input type="checkbox" id="mr-nonzero" ${S.nonZeroOnly?'checked':''} onchange="invMRToggleNonZero(this.checked)"
              style="width:15px;height:15px;cursor:pointer;accent-color:var(--brand,#2563eb)">
            Show only materials in stock
          </label>
        </div>
        <!-- Items grid: explicit min/max height so the operator can scroll
             through many lines without the page-level Submit button getting
             pushed below the fold. -->
        <div class="inv-table-wrap" style="border:1px solid var(--border,#d1d5db);border-radius:8px;overflow:hidden">
          <div class="inv-table-scroll" style="min-height:340px;max-height:calc(100vh - 380px);overflow-y:auto">
            <table class="inv-table" style="width:100%;table-layout:auto;margin:0">
              <thead style="position:sticky;top:0;z-index:2">
                <tr>
                  <th style="width:auto">Material (RM)</th>
                  <th style="text-align:right;width:120px">Qty</th>
                  <th style="width:240px">Remarks</th>
                  <th style="width:46px"></th>
                </tr>
              </thead>
              <tbody id="mr-line-body">${lineRows}</tbody>
            </table>
          </div>
        </div>
        <button class="btn" style="margin-top:8px" onclick="invMRLineAdd()"><i class="fas fa-plus"></i> Add item</button>
        <div style="margin-top:14px;max-width:680px">
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#6b7280);display:block;margin-bottom:4px">Remarks (optional)</label>
          <textarea id="mr-remarks" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--card,#fff);color:var(--text,#111)"></textarea>
        </div>
      </div>`;

    // Load stock for the default/current source godown so qty shows immediately.
    if(defSrc){ loadGodownStock(defSrc).then(() => { /* re-render line inputs' labels */
      S.lines.forEach((l,i)=>{ const inp=$('mr-mat-input-'+i); if(inp && l.material_id) inp.value=_lineSelectedLabel(l); });
    }); }
    // Populate the "Next MR" chip. Fails silently if the endpoint isn't
    // reachable — shouldn't block the form.
    fetch(API + '/preview_next_no')
      .then(r => r.json())
      .then(d => {
        const el = $('mr-next-no-value');
        if(el && d && d.status === 'ok' && d.request_no) el.textContent = d.request_no;
        else if(el) el.textContent = '—';
      })
      .catch(() => { const el = $('mr-next-no-value'); if(el) el.textContent = '—'; });
  }
  async function invMRSourceChanged(gid){
    await loadGodownStock(gid);
    // refresh selected-line labels so they show the new godown's qty
    S.lines.forEach((l,i)=>{ const inp=$('mr-mat-input-'+i); if(inp && l.material_id) inp.value=_lineSelectedLabel(l); });
    // if a combo is open, refresh its filtered list (qty/visibility changed)
    if(S.openCombo !== null){ invMRComboInput(S.openCombo); }
  }
  function invMRToggleNonZero(on){
    S.nonZeroOnly = !!on;
    // re-filter the open combo immediately if one is showing
    if(S.openCombo !== null){
      const inp = $('mr-mat-input-'+S.openCombo);
      invMRComboRender(S.openCombo, _comboMatches(inp ? inp.value : ''), 0);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     RENDER — DETAIL
  ════════════════════════════════════════════════════════════════════ */
  function renderDetail(){
    const panel = _mrHost();
    if(!panel || !S.detail) return;
    const { request:r, items, story } = S.detail;
    const _acc = window._invAccess || {};
    const _me  = (_acc.user_name || '').toLowerCase();
    const _canEditItems = (r.status === 'pending' || r.status === 'in_progress')
                          && ((_me && _me === (r.requested_by||'').toLowerCase()) || !!_acc.is_admin)
                          && items.length > 1;
    const itemRows = items.map(it => {
      const pct = it.qty_requested > 0 ? Math.round(100*it.qty_fulfilled/it.qty_requested) : 0;
      const notStarted = Number(it.qty_fulfilled || 0) <= 0.0005;
      const rmCell = _canEditItems
        ? `<td style="text-align:center;white-space:nowrap">${
            notStarted
              ? `<button class="btn" title="Remove this item" style="padding:3px 8px;font-size:12px;color:#dc2626;border-color:#fca5a5"
                   onclick="invMRRemoveItem(${r.id},${it.id},'${esc((it.material_name||'').replace(/'/g,''))}')"><i class="fas fa-times"></i></button>`
              : `<span style="font-size:11px;color:var(--muted,#9ca3af)" title="Fulfilment started — can't remove">—</span>`
          }</td>`
        : '';
      return `<tr>
        <td style="font-weight:600;word-break:break-word">${esc(it.material_name || ('#'+it.material_id))}</td>
        <td style="text-align:right;white-space:nowrap">${fmtQty(it.qty_requested)} ${esc(it.uom||'')}</td>
        <td style="text-align:right;white-space:nowrap">${fmtQty(it.qty_fulfilled)} ${esc(it.uom||'')}</td>
        <td style="text-align:right">${pct}%
          <div style="height:5px;background:var(--surface,#eef2f7);border-radius:3px;margin-top:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--brand,#2563eb)"></div></div></td>
        <td style="word-break:break-word">${esc(it.remarks||'')}</td>
        ${rmCell}
      </tr>`;
    }).join('');

    const storyRows = story.length ? story.map(s => `
      <tr>
        <td style="white-space:nowrap">${esc(s.transfer_no || ('TR#'+s.transfer_id))}</td>
        <td style="white-space:nowrap">${esc(s.material_name||'')}</td>
        <td style="white-space:nowrap">${esc(s.box_code||'')}</td>
        <td style="text-align:right;white-space:nowrap">${fmtQty(s.qty_fulfilled)}</td>
        <td style="white-space:nowrap">${esc(s.received_by || s.fulfilled_by || '')}</td>
        <td style="white-space:nowrap">${esc((s.received_at || s.fulfilled_at || '').slice(0,16))}</td>
      </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--muted,#9ca3af);font-style:italic">No fulfilment yet — will populate as transfers are received at the destination godown.</td></tr>`;

    const isDraft    = (r.status === 'draft');
    const canCancel = (r.status === 'pending' || r.status === 'in_progress' || isDraft);
    // Ownership check (May 2026): Cancel is owner-or-admin only. The
    // server enforces this independently (returns 403 to non-owners)
    // but we also hide the button to make the rule obvious in the UI.
    // Fulfil stays open to anyone with MR access — the fulfiller is
    // typically a DIFFERENT user from the requester (Ask 2 use-case:
    // Punam requests, Ashish ships).
    const acc        = window._invAccess || {};
    const me         = (acc.user_name || '').toLowerCase();
    const ownerLower = (r.requested_by || '').toLowerCase();
    const isOwner    = me && (me === ownerLower);
    const isAdmin    = !!acc.is_admin;
    const canSeeCancel = canCancel && (isOwner || isAdmin);

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn" onclick="invMRShowList()"><i class="fas fa-arrow-left"></i> Back</button>
        <h2 style="margin:0;font-size:18px;font-weight:800">${esc(r.request_no)}</h2>
        ${statusPill(r.status)}
        <div style="flex:1"></div>
        <button class="btn" onclick="invMRPrint(${r.id})"><i class="fas fa-print"></i> Print</button>
        ${isDraft && (isOwner||isAdmin)
          ? `<button class="btn btn-primary" style="background:#7c3aed;border-color:#7c3aed" onclick="invMRSubmitDraft(${r.id})"><i class="fas fa-paper-plane"></i> Submit Request</button>`
          : ''}
        ${(!isDraft && canCancel) ? `<button class="btn btn-primary" onclick="invMROpenFulfill(${r.id})"><i class="fas fa-truck"></i> Fulfill</button>` : ''}
        ${canSeeCancel ? `<button class="btn" style="color:#dc2626" onclick="invMRCancel(${r.id})"><i class="fas fa-ban"></i> ${isDraft?'Discard Draft':'Cancel Request'}</button>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:18px">
        ${[['Date',fmtDMY(r.request_date)],['Destination',r.dest_godown_name||('#'+r.dest_godown_id)],
           ['Source',r.source_godown_name||'Any'],['Requested By',r.requested_by]]
          .map(([k,v])=>`<div><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted,#9ca3af)">${k}</div><div style="font-size:13.5px;font-weight:600;margin-top:2px">${esc(v)}</div></div>`).join('')}
      </div>
      ${r.remarks ? `<div style="margin-bottom:16px;font-size:13px;color:var(--muted,#6b7280)"><b>Remarks:</b> ${esc(r.remarks)}</div>` : ''}
      ${r.status==='cancelled' && r.cancel_reason ? `<div style="margin-bottom:16px;font-size:13px;color:#dc2626"><b>Cancelled:</b> ${esc(r.cancel_reason)} (by ${esc(r.cancelled_by||'')})</div>` : ''}

      <div style="font-size:13px;font-weight:700;margin-bottom:8px">Requested Items</div>
      <div class="inv-table-wrap"><div class="inv-table-scroll"><table class="inv-table" style="width:100%;table-layout:fixed">
        <colgroup>
          <col style="width:32%"><col style="width:14%"><col style="width:14%"><col style="width:10%"><col style="width:${_canEditItems?'24%':'30%'}">${_canEditItems?'<col style="width:6%">':''}
        </colgroup>
        <thead><tr>
          <th>Material</th>
          <th style="text-align:right">Requested</th>
          <th style="text-align:right">Fulfilled</th>
          <th style="text-align:right">Progress</th>
          <th>Remarks</th>
          ${_canEditItems?'<th style="text-align:center">Remove</th>':''}
        </tr></thead>
        <tbody>${itemRows}</tbody></table></div></div>

      <div style="font-size:13px;font-weight:700;margin:20px 0 8px">Fulfilment Story</div>
      <div class="inv-table-wrap"><div class="inv-table-scroll"><table class="inv-table" style="width:100%;table-layout:auto">
        <thead><tr>
          <th style="white-space:nowrap">Transfer</th>
          <th style="white-space:nowrap">Material</th>
          <th style="white-space:nowrap">Box</th>
          <th style="text-align:right;white-space:nowrap">Qty</th>
          <th style="white-space:nowrap">Received By</th>
          <th style="width:100%;white-space:nowrap">When</th>
        </tr></thead>
        <tbody>${storyRows}</tbody></table></div></div>`;
  }

  /* ════════════════════════════════════════════════════════════════════
     ACTIONS
  ════════════════════════════════════════════════════════════════════ */
  async function showList(){
    S.view = 'list';
    await loadList();
    renderList();
  }
  async function showCreate(){
    S.view = 'create';
    S.lines = [{ material_id:'', qty_requested:'', remarks:'' }];
    S.srcStock = {}; S.srcGodownId = '';
    await Promise.all([loadGodowns(), loadRmItems()]);
    // Preload default source godown stock before first render.
    const defSrc = _findGodownByKeywords(DEFAULT_SOURCE_KEYWORDS);
    if(defSrc) await loadGodownStock(defSrc);
    renderCreate();
  }
  async function openDetail(id){
    S.view = 'detail';
    try {
      const r = await fetch(`${API}/${id}`);
      const d = await r.json();
      if(d.status === 'ok'){ S.detail = d; renderDetail(); }
      else { toast(d.message || 'Failed to load request','error',4000); }
    } catch(e){ toast('Network error','error',4000); }
  }
  function lineAdd(){ S.lines.push({ material_id:'', qty_requested:'', remarks:'' }); renderCreate(); }
  function lineRemove(idx){ S.lines.splice(idx,1); if(!S.lines.length) S.lines=[{material_id:'',qty_requested:'',remarks:''}]; renderCreate(); }
  function lineSet(idx,field,val){ if(S.lines[idx]) S.lines[idx][field]=val; }
  function setFilter(f){ S.statusFilter = f; showList(); }

  async function save(asDraft){
    const dest = $('mr-dest')?.value;
    if(!dest){ toast('Select a destination godown','warn',3000); return; }
    const items = S.lines
      .filter(l => l.material_id && Number(l.qty_requested) > 0)
      .map(l => ({ material_id:Number(l.material_id), qty_requested:Number(l.qty_requested), remarks:l.remarks||'' }));
    // A draft may be saved with no items yet (items can be added later, e.g.
    // from Godown View). Submitting requires at least one item.
    if(!asDraft && !items.length){ toast('Add at least one item with a quantity','warn',3000); return; }
    const btn = asDraft ? $('mr-draft-btn') : $('mr-save-btn');
    const restore = asDraft
      ? '<i class="fas fa-file-pen"></i> Save as Draft'
      : '<i class="fas fa-paper-plane"></i> Submit Request';
    if(btn){ btn.disabled = true; btn.innerHTML = asDraft ? 'Saving…' : 'Submitting…'; }
    try {
      const r = await fetch(API + '/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          request_date: $('mr-date')?.value || undefined,
          dest_godown_id: Number(dest),
          source_godown_id: $('mr-source')?.value ? Number($('mr-source').value) : null,
          remarks: $('mr-remarks')?.value || '',
          items,
          as_draft: !!asDraft,
        })
      });
      const d = await r.json();
      if(d.status === 'ok'){
        if(asDraft){
          // Saved as a draft — go to its detail so the user can add items /
          // submit when ready.
          toast(`✓ Draft saved (${d.request_no})`,'success',2800);
          openDetail(d.id);
        } else {
          toast(`✓ Request ${d.request_no} submitted`,'success',2500);
          showList();
        }
      }
      else { toast(d.message || 'Save failed','error',5000); if(btn){ btn.disabled=false; btn.innerHTML=restore; } }
    } catch(e){ toast('Network error: '+e.message,'error',4000); if(btn){ btn.disabled=false; btn.innerHTML=restore; } }
  }

  async function cancel(id){
    const reason = prompt('Reason for cancelling this request? (optional)');
    if(reason === null) return; // user hit Cancel on the prompt
    try {
      const r = await fetch(API + '/cancel', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id, reason })
      });
      const d = await r.json();
      if(d.status === 'ok'){ toast('✓ Request cancelled','success',2500); openDetail(id); }
      else { toast(d.message || 'Cancel failed','error',5000); }
    } catch(e){ toast('Network error','error',4000); }
  }

  /* Submit a draft → assigns the real RM-MR number, sends it to fulfillers. */
  async function submitDraft(rid){
    if(!confirm('Submit this draft?\n\nIt will be finalized with a request number and become visible to fulfillers.')) return;
    try {
      const r = await fetch(`${API}/${rid}/submit`, { method:'POST' });
      const d = await r.json();
      if(d.status === 'ok'){
        toast(`✓ Submitted as ${d.request_no}`,'success',3000);
        openDetail(rid);
      } else { toast(d.message || 'Submit failed','error',5000); }
    } catch(e){ toast('Network error','error',4000); }
  }

  /* Remove an item line (requester/admin, only if not yet fulfilled).
     Server hard-blocks if fulfilment started; alerts the live fulfiller. */
  async function removeItem(rid, itemId, matName){
    if(!confirm(`Remove “${matName||'this item'}” from the request?\n\nThis is only allowed because fulfilment hasn't started for it. If someone is fulfilling this request right now, they'll get an on-screen alert to skip it.`)) return;
    try {
      const r = await fetch(`${API}/${rid}/remove_item`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ item_id:itemId })
      });
      const d = await r.json();
      if(d.status === 'ok'){
        toast(d.alerted ? `✓ Item removed — fulfiller alerted` : '✓ Item removed','success',2800);
        openDetail(rid);
      } else { toast(d.message || 'Remove failed','error',5000); }
    } catch(e){ toast('Network error','error',4000); }
  }

  /* Pre-close: requester closes a request early — keep what's fulfilled,
     stop further fulfilment. Invoked from the list Actions column. */
  async function preclose(id, requestNo){
    const reason = prompt(`Pre-close ${requestNo || 'this request'}?\n\nThis keeps whatever has already been fulfilled and stops further fulfilment.\n\nReason (optional):`);
    if(reason === null) return; // user cancelled the prompt
    try {
      const r = await fetch(API + '/preclose', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id, reason })
      });
      const d = await r.json();
      if(d.status === 'ok'){
        toast('✓ Request pre-closed','success',2500);
        await loadList(); renderList();
      } else { toast(d.message || 'Pre-close failed','error',5000); }
    } catch(e){ toast('Network error','error',4000); }
  }

  /* ════════════════════════════════════════════════════════════════════
     FULFILL FLOW  (PM-style — jump straight to Material OUT)
     ────────────────────────────────────────────────────────────────────
     Mirrors pm_stock's openMrFulfill exactly:
       1. Call /<rid>/prefill_out for items + locked destination godown.
       2. Switch to the Transfers panel + Material OUT pill tab.
       3. Pre-fill the OUT create-card with destination + remarks; let the
          user pick the SOURCE godown themselves.
       4. Stash the request_id so when the OUT voucher is created (via
          /api/inventory_godown/transfers/start) it gets linked to this
          request — fulfillment progress updates automatically when the
          IN side completes.

     FEFO is the FULFILLER'S RESPONSIBILITY — no boxes are pre-selected
     and no qty modal is shown. The fulfiller scans whichever boxes they
     physically grab, in the FEFO order they choose. The FEFO popup that
     fires when they later pick materials elsewhere shows them the
     consumption order (FIRST OUT batch is highlighted green).

     Backend changes: none. /prefill_out already exists; transfers/start
     already accepts request_id.
  ════════════════════════════════════════════════════════════════════ */

  // Last-fulfill prefill stashed for the OUT form. Module global on
  // window so the transfers JS (different file) can pick it up too.
  // Cleared after one successful OUT-create or when the user manually
  // navigates away from the Transfers panel.
  async function openFulfill(rid){
    let d;
    try {
      const r = await fetch(`${API}/${rid}/prefill_out`);
      d = await r.json();
    } catch(e){
      toast('Network error: ' + (e.message || e), 'error', 4500);
      return;
    }
    if(d.status !== 'ok'){
      toast(d.message || 'Cannot prefill OUT', 'error', 4500);
      return;
    }
    if(!(d.items || []).length){
      toast('Nothing left to fulfil on this request', 'info', 4000);
      return;
    }
    // Register as the live fulfiller of this request (heartbeat) so the
    // requester's item-removal can alert us on-screen. Kept alive on a timer.
    _startFulfillHeartbeat(rid);
    _startAlertPoll();   // ensure we're watching for OK-required alerts
    // Stash prefill — picked up by invTrCreateOutClick (which sends
    // request_id on /start) and by the banner injector below.
    window._invMRPendingPrefill = {
      request_id:         d.request_id,
      request_no:         d.request_no,
      dest_godown_id:     d.dest_godown_id,
      dest_godown_name:   d.dest_godown_name,
      source_godown_id:   d.source_godown_id || null,
      source_godown_name: d.source_godown_name || '',
      source_locked:      !!d.source_locked,
      remarks:            d.remarks || '',
      items:              d.items,
    };

    // Switch to the Stock Transfers panel. The inventory module's panel
    // key for this is 'stock-transfers' (defined in inventory_mgmt.html
    // as id="panel-stock-transfers"), NOT 'transfers' — getting the key
    // right is critical, otherwise invSwitchPanel deactivates all panels.
    // The Material OUT pill is then activated via invTrSwitchPillTab once
    // the panel mounts.
    if(typeof window.invSwitchPanel === 'function'){
      window.invSwitchPanel('stock-transfers');
    }
    // invTrInit() is async — it loads godowns + transfer list before the
    // create-card dropdowns are populated. We poll briefly for the TO
    // dropdown to have actual <option> rows, then apply the prefill.
    // 1500ms cap is generous on a fast LAN; if we still don't see options
    // by then, we set values anyway (the select widget will accept the
    // value and the user can re-pick if the option is genuinely missing).
    _waitForElementReady('tr-create-to', el => el && el.options && el.options.length > 1, 1500)
      .then(() => _applyMRPrefillToOutForm(d));
  }

  /* ── Helpers used by openFulfill ──────────────────────────────────── */

  // Resolves after `pred(el)` returns truthy OR after `timeoutMs` elapses.
  // Element is looked up by id on every poll so we don't lock onto a node
  // that gets re-rendered while we wait.
  function _waitForElementReady(elementId, pred, timeoutMs){
    const startedAt = Date.now();
    return new Promise(resolve => {
      const tick = () => {
        const el = document.getElementById(elementId);
        if(pred && pred(el)){ resolve(el); return; }
        if(Date.now() - startedAt > timeoutMs){ resolve(el || null); return; }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  // Applies the prefill payload (from /prefill_out) to the Transfers
  // create-OUT card: locks the TO godown, pre-selects FROM if hinted,
  // sets remarks, switches to the OUT pill, and drops the banner above
  // the card. Defensive: if any control is missing, we toast a clear
  // error rather than throwing into a black hole.
  function _applyMRPrefillToOutForm(d){
    try {
      if(typeof window.invTrSwitchPillTab === 'function'){
        window.invTrSwitchPillTab('out');
      }
      const toSel   = document.getElementById('tr-create-to');
      const fromSel = document.getElementById('tr-create-from');
      const remIn   = document.getElementById('tr-create-remarks');
      if(toSel){
        toSel.value = String(d.dest_godown_id);
        // Visual lock: discourage accidental change.
        toSel.setAttribute('data-mr-locked', '1');
        toSel.title = `Locked to Material Request ${d.request_no} destination`;
      }
      if(fromSel && d.source_godown_id){
        fromSel.value = String(d.source_godown_id);
        // If the server says the fulfiller is location-locked
        // (source_locked: true), enforce the lock in the UI too. Server
        // would still reject any transfer from a different godown.
        if(d.source_locked){
          fromSel.disabled = true;
          fromSel.setAttribute('data-mr-locked-source', '1');
          fromSel.title = `Locked to your pinned godown — admin can change this in User Access.`;
          // Make the lock visually obvious.
          fromSel.style.background = 'var(--surface,#f1f5f9)';
          fromSel.style.fontWeight = '600';
          fromSel.style.cursor = 'not-allowed';
        } else {
          // Source was a hint, not a constraint — leave editable.
          fromSel.disabled = false;
          fromSel.removeAttribute('data-mr-locked-source');
        }
      }
      if(remIn && !remIn.value){
        remIn.value = `Fulfilling ${d.request_no}`;
      }
      _injectMRPrefillBanner(window._invMRPendingPrefill);
      // Tweak the toast message based on whether source is locked.
      const sourceMsg = d.source_locked
        ? `Source is locked to your pinned godown. Start scanning boxes (FEFO — first-expiring-first).`
        : `Pick a SOURCE godown, then start scanning boxes (FEFO — first-expiring-first).`;
      toast(`${sourceMsg} Items to send: ${d.items.length}.`, 'info', 6500);
    } catch(e){
      toast('Couldn\u2019t prefill OUT form: ' + (e.message || e), 'error', 4500);
    }
  }

  /* ── BANNER: shown above the Transfers OUT create-card ─────────────
     Tells the fulfiller WHICH request they're fulfilling + lists the
     remaining items with their per-line qty. Stays visible until either
     the OUT voucher is created (cleared on /start success) or the user
     dismisses it manually. */
  function _injectMRPrefillBanner(prefill){
    if(!prefill) return;
    // Find the OUT create card container. Look for tr-create-from's
    // ancestor card — that's the natural anchor.
    const fromEl = document.getElementById('tr-create-from');
    if(!fromEl) return;
    let host = fromEl.closest('.card, .panel-card, .tr-create-card');
    if(!host) host = fromEl.parentElement?.parentElement || fromEl.parentElement;
    if(!host) return;
    let banner = document.getElementById('inv-mr-prefill-banner');
    if(banner) banner.remove();   // refresh if already shown
    banner = document.createElement('div');
    banner.id = 'inv-mr-prefill-banner';
    banner.style.cssText = [
      'margin-bottom:12px',
      'padding:10px 14px',
      'background:linear-gradient(135deg,rgba(70,72,212,.10),rgba(70,72,212,.02))',
      'border:1.5px solid rgba(70,72,212,.35)',
      'border-radius:10px',
      'font-size:12px',
      'color:var(--text,#111)',
      'display:flex',
      'gap:12px',
      'align-items:flex-start',
      'flex-wrap:wrap',
    ].join(';');
    const items = (prefill.items || []).map(it => {
      const u = it.uom ? (' ' + esc(it.uom)) : '';
      return `<li>${esc(it.material_name)} — <strong>${fmtQty(it.qty_remaining)}${u}</strong></li>`;
    }).join('');
    banner.innerHTML = `
      <div style="font-size:18px;line-height:1.1">📋</div>
      <div style="flex:1;min-width:240px">
        <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:var(--brand,#4648D4);margin-bottom:4px">
          Fulfilling Material Request
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text,#111);margin-bottom:6px">
          ${esc(prefill.request_no)} → ${esc(prefill.dest_godown_name)}
        </div>
        <div style="font-size:11.5px;color:var(--muted,#6b7280);margin-bottom:4px">
          Pick the SOURCE godown and scan boxes in <strong>FEFO order</strong> (first-expiring batch first).
        </div>
        <ul style="margin:6px 0 0 18px;padding:0;font-size:11.5px;color:var(--text2,#374151);line-height:1.6">${items}</ul>
      </div>
      <button onclick="invMRClearPrefill()" title="Dismiss (does NOT cancel the request)"
              style="background:transparent;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;cursor:pointer;
                     padding:3px 8px;font-size:11px;color:var(--muted,#6b7280)">Dismiss</button>
    `;
    host.insertBefore(banner, host.firstChild);
  }

  // Public: clear the prefill banner + state. Called from the banner's
  // Dismiss button, and ALSO from the transfers JS after the OUT voucher
  // is successfully created (window._invMRClearPrefill()).
  window.invMRClearPrefill = function(){
    window._invMRPendingPrefill = null;
    const b = document.getElementById('inv-mr-prefill-banner');
    if(b) b.remove();
    // Unlock the destination dropdown so the next OUT voucher (not from
    // an MR) can pick any destination.
    const toSel = document.getElementById('tr-create-to');
    if(toSel){
      toSel.removeAttribute('data-mr-locked');
      toSel.title = '';
    }
  };


  function _injectPanel(){
    // No-op: the Material Request UI now renders into #tr-pane-request, the
    // 4th pill tab on the Stock Transfers panel (declared in _transfers.html).
    // The legacy standalone #panel-material-request is no longer created.
  }
  function _injectNav(){
    if($('mr-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    // Append into the existing "Manage" section if present, else make one.
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Manage');
    if(!section){
      section = document.createElement('div');
      section.className = 'inv-nav-section';
      section.innerHTML = `<div class="inv-nav-section-label">Manage</div>`;
      navBody.appendChild(section);
    }
    const item = document.createElement('div');
    item.className = 'inv-nav-item';
    item.id = 'mr-nav-item';
    item.setAttribute('data-panel','material-request');
    item.setAttribute('data-cap','material_request');
    item.onclick = () => invMRActivate();
    item.innerHTML = `<span class="ico">📋</span><span>Material Request</span>
      <span id="mr-nav-badge" style="display:none;margin-left:auto;background:#dc2626;color:#fff;font-size:10px;font-weight:800;border-radius:9px;padding:1px 7px"></span>`;
    section.appendChild(item);
  }

  // Activate our panel: hide others, show ours, mark nav active.
  // Activate Material Request: switch to the Stock Transfers panel, then the
  // Material Request pill tab. The pill switcher calls invMRRenderIntoTab(),
  // which shows the list. Kept as a single entry point so the sidebar item
  // (if present) and any deep links land on the right place.
  function invMRActivate(){
    _startAlertPoll();   // begin watching for OK-required alerts addressed to us
    if(typeof window.invSwitchPanel === 'function'){
      window.invSwitchPanel('stock-transfers');
    }
    // Defer so the transfers panel/template has mounted before we flip the pill.
    setTimeout(() => {
      if(typeof window.invTrSwitchPillTab === 'function'){
        window.invTrSwitchPillTab('request');
      } else {
        // Fallback: render directly if the transfers switcher isn't loaded.
        invMRRenderIntoTab();
      }
    }, 0);
  }

  // Called by invTrSwitchPillTab('request') (and the fallback above) to render
  // the Material Request list into the #tr-pane-request pane.
  function invMRRenderIntoTab(){
    showList();
  }

  async function refreshBadge(){
    try {
      const r = await fetch(API + '/pending_count');
      const d = await r.json();
      const badge = $('mr-nav-badge');
      if(badge && d.status === 'ok'){
        if(d.count > 0){ badge.textContent = d.count; badge.style.display = ''; }
        else { badge.style.display = 'none'; }
      }
    } catch(e){}
  }

  /* Hide the nav item if the user lacks material_request access. */
  function _applyAccess(){
    const item = $('mr-nav-item');
    if(!item) return;
    const a = window._invAccess;
    const allowed = !a || !a.ready || a.is_admin || (a.access && a.access.material_request !== 'off' && a.access.material_request !== false);
    item.style.display = allowed ? '' : 'none';
  }
  document.addEventListener('inv-access-ready', _applyAccess);

  function _boot(){
    _injectPanel();
    // _injectNav() removed — Material Request is now reached via the 4th pill
    // tab on the Stock Transfers panel, not a standalone sidebar item.
    _applyAccess();
    refreshBadge();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();

  /* ════════════════════════════════════════════════════════════════════
     PRINT  — clean A4 sheet for the currently-open Material Request.
     Uses S.detail (already loaded by openDetail). Dates in DD/MM/YYYY.
  ════════════════════════════════════════════════════════════════════ */
  function printRequest(id){
    if(!S.detail || !S.detail.request || (id != null && S.detail.request.id !== id)){
      toast('Open the request first, then print.','warn',2500); return;
    }
    const { request:r, items, story } = S.detail;
    const company = 'HCP Wellness Pvt Ltd';
    const now = fmtDMY(new Date().toISOString().slice(0,10));

    const itemRows = (items||[]).map((it,i)=>{
      const pct = it.qty_requested > 0 ? Math.round(100*it.qty_fulfilled/it.qty_requested) : 0;
      return `<tr>
        <td style="text-align:center">${i+1}</td>
        <td>${esc(it.material_name || ('#'+it.material_id))}</td>
        <td style="text-align:right">${fmtQty(it.qty_requested)} ${esc(it.uom||'')}</td>
        <td style="text-align:right">${fmtQty(it.qty_fulfilled)} ${esc(it.uom||'')}</td>
        <td style="text-align:right">${pct}%</td>
        <td>${esc(it.remarks||'')}</td>
      </tr>`;
    }).join('');

    const storyRows = (story||[]).length ? story.map(s=>`
      <tr>
        <td>${esc(s.transfer_no || ('TR#'+s.transfer_id))}</td>
        <td>${esc(s.material_name||'')}</td>
        <td>${esc(s.box_code||'')}</td>
        <td style="text-align:right">${fmtQty(s.qty_fulfilled)}</td>
        <td>${esc(s.received_by || s.fulfilled_by || '')}</td>
        <td>${fmtDMY((s.received_at || s.fulfilled_at || '').slice(0,10))}</td>
      </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:#888;font-style:italic;padding:14px">No fulfilment yet.</td></tr>`;

    const meta = (k,v)=>`<div class="mr-meta"><span class="mr-meta-k">${k}</span><span class="mr-meta-v">${esc(v)}</span></div>`;
    const statusTxt = String(r.status||'').replace(/_/g,' ').toUpperCase();

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>Material Request ${esc(r.request_no)}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:24px;font-size:12.5px}
        .mr-top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f3a8a;padding-bottom:10px;margin-bottom:14px}
        .mr-co{font-size:18px;font-weight:800;color:#1f3a8a}
        .mr-sub{font-size:12px;color:#555;margin-top:2px}
        .mr-title{text-align:right}
        .mr-title h1{margin:0;font-size:16px;letter-spacing:.5px}
        .mr-no{font-size:14px;font-weight:700;margin-top:2px}
        .mr-status{display:inline-block;margin-top:4px;font-size:10.5px;font-weight:700;border:1px solid #1f3a8a;color:#1f3a8a;padding:2px 8px;border-radius:10px}
        .mr-metawrap{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 28px;margin:12px 0 18px}
        .mr-meta{display:flex;gap:8px;font-size:12.5px}
        .mr-meta-k{min-width:110px;text-transform:uppercase;font-size:10px;letter-spacing:.4px;color:#777;padding-top:2px}
        .mr-meta-v{font-weight:600}
        h2.sec{font-size:12.5px;text-transform:uppercase;letter-spacing:.5px;color:#1f3a8a;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
        table{width:100%;border-collapse:collapse;margin-bottom:6px}
        th,td{border:1px solid #cfd6e4;padding:6px 8px;font-size:12px;vertical-align:top}
        th{background:#eef2fb;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px}
        .mr-remarks{font-size:12px;margin:8px 0}
        .mr-sign{display:flex;justify-content:space-between;margin-top:48px}
        .mr-sign div{width:30%;border-top:1px solid #444;padding-top:5px;text-align:center;font-size:11px;color:#444}
        .mr-foot{margin-top:24px;font-size:10px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:6px}
        @media print{body{padding:10mm} .mr-noprint{display:none}}
      </style></head><body>
      <div class="mr-top">
        <div><div class="mr-co">${esc(company)}</div><div class="mr-sub">Inventory — Raw Materials</div></div>
        <div class="mr-title"><h1>MATERIAL REQUEST</h1><div class="mr-no">${esc(r.request_no)}</div>
          <div class="mr-status">${esc(statusTxt)}</div></div>
      </div>
      <div class="mr-metawrap">
        ${meta('Date', fmtDMY(r.request_date))}
        ${meta('Requested By', r.requested_by||'')}
        ${meta('Destination', r.dest_godown_name || ('#'+r.dest_godown_id))}
        ${meta('Source', r.source_godown_name || 'Any')}
      </div>
      ${r.remarks ? `<div class="mr-remarks"><b>Remarks:</b> ${esc(r.remarks)}</div>` : ''}
      ${r.status==='cancelled' && r.cancel_reason ? `<div class="mr-remarks" style="color:#c0392b"><b>Cancelled:</b> ${esc(r.cancel_reason)} (by ${esc(r.cancelled_by||'')})</div>` : ''}

      <h2 class="sec">Requested Items</h2>
      <table>
        <thead><tr><th style="width:32px;text-align:center">#</th><th>Material</th>
          <th style="text-align:right">Requested</th><th style="text-align:right">Fulfilled</th>
          <th style="text-align:right">Progress</th><th>Remarks</th></tr></thead>
        <tbody>${itemRows || `<tr><td colspan="6" style="text-align:center;color:#888;padding:14px">No items.</td></tr>`}</tbody>
      </table>

      <h2 class="sec">Fulfilment Story</h2>
      <table>
        <thead><tr><th>Transfer</th><th>Material</th><th>Box</th>
          <th style="text-align:right">Qty</th><th>Received By</th><th>When</th></tr></thead>
        <tbody>${storyRows}</tbody>
      </table>

      <div class="mr-sign">
        <div>Requested By</div><div>Issued / Fulfilled By</div><div>Authorised By</div>
      </div>
      <div class="mr-foot">Printed on ${now} · ${esc(company)} — HCP ERP</div>
      <script>window.onload=function(){window.print();};<\/script>
      </body></html>`;

    const w = window.open('', '_blank');
    if(!w){ toast('Allow pop-ups to print.','warn',3000); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  /* ════════════════════════════════════════════════════════════════════
     LIVE FULFILLER PRESENCE + ACKNOWLEDGEMENT ALERTS
     ────────────────────────────────────────────────────────────────────
     • When a user opens the fulfill flow, we heartbeat presence for that
       request so the requester's item-removal can target us.
     • A global poll checks for OK-required alerts addressed to us and shows
       a BLOCKING modal that must be acknowledged (OK) before it clears.
  ════════════════════════════════════════════════════════════════════ */
  let _hbTimer = null, _hbRid = null, _alertTimer = null, _alertShowing = false;

  function _startFulfillHeartbeat(rid){
    _hbRid = rid;
    const beat = () => {
      if(!_hbRid) return;
      fetch(`${API}/${_hbRid}/fulfill_heartbeat`, { method:'POST' }).catch(()=>{});
    };
    beat();                              // immediate
    if(_hbTimer) clearInterval(_hbTimer);
    _hbTimer = setInterval(beat, 15000); // every 15s (server TTL is 35s)
  }
  function _stopFulfillHeartbeat(){
    _hbRid = null;
    if(_hbTimer){ clearInterval(_hbTimer); _hbTimer = null; }
  }
  // Stop heartbeat if the user navigates away from the module/tab.
  window.addEventListener('beforeunload', _stopFulfillHeartbeat);

  async function _pollAlerts(){
    if(_alertShowing) return;            // one modal at a time
    let d;
    try {
      const r = await fetch(`${API}/alerts_poll`);
      d = await r.json();
    } catch(e){ return; }
    if(d.status !== 'ok' || !(d.alerts||[]).length) return;
    _showAlertModal(d.alerts[0]);        // show oldest; others follow next poll
  }

  function _showAlertModal(a){
    _alertShowing = true;
    let host = document.getElementById('invMRAlertModal');
    if(!host){
      host = document.createElement('div');
      host.id = 'invMRAlertModal';
      document.body.appendChild(host);
    }
    host.innerHTML = `
      <div style="position:fixed;inset:0;z-index:99999;background:rgba(17,24,39,.55);
                  display:flex;align-items:center;justify-content:center;padding:20px">
        <div style="background:#fff;border-radius:14px;max-width:440px;width:100%;
                    box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">
          <div style="background:#dc2626;color:#fff;padding:14px 18px;font-weight:800;font-size:15px">
            <i class="fas fa-triangle-exclamation"></i> Request changed
          </div>
          <div style="padding:18px;font-size:14px;line-height:1.5;color:#111">
            ${esc(a.message)}
            <div style="margin-top:10px;font-size:12px;color:#6b7280">
              From ${esc(a.created_by||'requester')} · ${esc((a.created_at||'').slice(0,16))}
            </div>
          </div>
          <div style="padding:14px 18px;border-top:1px solid #eee;text-align:right">
            <button class="btn btn-primary" style="padding:8px 22px;font-weight:700"
                    onclick="invMRAckAlert(${a.id})">OK</button>
          </div>
        </div>
      </div>`;
  }

  window.invMRAckAlert = async function(id){
    try { await fetch(`${API}/alert_ack`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id })
    }); } catch(e){}
    const host = document.getElementById('invMRAlertModal');
    if(host) host.innerHTML = '';
    _alertShowing = false;
    // If the removed item affects the open fulfill/detail view, refresh it.
    if(_hbRid) { try { /* detail/fulfill screens re-fetch on next action */ } catch(e){} }
    setTimeout(_pollAlerts, 400);        // surface any queued alerts
  };

  // Start the global alert poll once the module is active. Lightweight (one
  // GET per interval) and only acts when an alert is actually addressed to us.
  function _startAlertPoll(){
    if(_alertTimer) return;
    _alertTimer = setInterval(_pollAlerts, 8000);
    setTimeout(_pollAlerts, 1500);       // quick first check
  }

  /* expose globals for inline handlers */
  window.invMRShowList    = showList;
  window.invMRShowCreate  = showCreate;
  window.invMROpenDetail  = openDetail;
  window.invMRLineAdd     = lineAdd;
  window.invMRLineRemove  = lineRemove;
  window.invMRLineSet     = lineSet;
  window.invMRSetFilter   = setFilter;
  window.invMRSave        = save;
  window.invMRCancel      = cancel;
  window.invMRPreclose    = preclose;
  window.invMRSubmitDraft = submitDraft;
  window.invMRRemoveItem  = removeItem;
  window.invMRActivate    = invMRActivate;
  window.invMRRenderIntoTab = invMRRenderIntoTab;
  window.invMRSourceChanged = invMRSourceChanged;
  window.invMRToggleNonZero = invMRToggleNonZero;
  window.invMRComboOpen   = invMRComboOpen;
  window.invMRComboInput  = invMRComboInput;
  window.invMRComboKey    = invMRComboKey;
  window.invMRComboPick   = invMRComboPick;
  window.invMROpenFulfill = openFulfill;
  window.invMRPrint       = printRequest;

  console.log('✅ inventory_material_request.js loaded (Phase 2)');
})();
