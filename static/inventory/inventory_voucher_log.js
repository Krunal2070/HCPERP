/* ═══════════════════════════════════════════════════════════════════════
   inventory_voucher_log.js — Voucher Log  (Inventory Phase 5)
   HCP Wellness · adapted from pm_stock_log.js
   ───────────────────────────────────────────────────────────────────────
   A unified, filterable transaction list of every RM voucher: GRNs, Stock
   Transfers, and Material Requests. Reads the existing list endpoints,
   merges them client-side, sorts by date, and shows type badges + per-row
   actions. No new backend.

   Filter tabs: All · GRN · Transfer · Request
   Filters: date from/to + free-text search.

   Self-injecting "🧾 Voucher Log" sidebar item (Vouchers section).
   =================================================================== */

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s)  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const fdate = (s) => { if(!s) return ''; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?`${m[3]}/${m[2]}/${m[1]}`:String(s); };

  const V = { rows:[], filter:'all', from:'', to:'', search:'' };

  /* ── badges per voucher type ──────────────────────────────────────── */
  function typeBadge(t){
    const map = {
      grn:     ['GRN',      '#0d9488','rgba(13,148,136,.12)'],
      transfer:['TRANSFER', '#d97706','rgba(217,119,6,.12)'],
      request: ['REQUEST',  '#2563eb','rgba(37,99,235,.12)'],
    };
    const [txt,fg,bg] = map[t] || [t,'#374151','#eee'];
    return `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;color:${fg};background:${bg};letter-spacing:.5px">${txt}</span>`;
  }
  function statusPill(st){
    if(!st) return '';
    const map = {
      pending:['#92400e','rgba(217,119,6,.14)'], in_progress:['#1e40af','rgba(37,99,235,.14)'],
      fulfilled:['#166534','rgba(22,163,74,.16)'], cancelled:['#6b7280','rgba(107,114,128,.14)'],
      out_started:['#92400e','rgba(217,119,6,.14)'], in_pending:['#1e40af','rgba(37,99,235,.14)'],
      received:['#166534','rgba(22,163,74,.16)'],
    };
    const [fg,bg] = map[st] || ['#374151','#eee'];
    return `<span style="padding:2px 8px;border-radius:9px;font-size:10.5px;font-weight:700;color:${fg};background:${bg}">${esc(String(st).replace(/_/g,' '))}</span>`;
  }

  /* ── load + merge ─────────────────────────────────────────────────── */
  async function load(){
    const tbody = $('vlog-tbody');
    if(tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--muted,#9ca3af)">Loading…</td></tr>`;
    const g = new URLSearchParams(); if(V.from) g.set('from_date',V.from); if(V.to) g.set('to_date',V.to); if(V.search) g.set('search',V.search);
    try {
      const [grnR, trR, mrR] = await Promise.all([
        fetch('/api/inventory_mgmt/grn/list').then(r=>r.json()).catch(()=>null),
        fetch('/api/inventory_godown/transfers/list').then(r=>r.json()).catch(()=>null),
        fetch('/api/inventory_mgmt/material_request/list').then(r=>r.json()).catch(()=>null),
      ]);
      const grns = ((grnR && grnR.status === 'ok' && grnR.grns) ||
                    (Array.isArray(grnR) ? grnR : (grnR && grnR.rows) || [])
                   ).map(r => ({
        _type:'grn', id:r.id, no:r.grn_num || r.grn_no, date:r.grn_date,
        from:r.supplier_name||r.supplier||'—', to:r.godown_name||'—',
        status:'', extra:`${r.item_count||0} item(s)`,
      }));
      const trs = ((trR && trR.status==='ok' && trR.transfers) || []).map(r => ({
        _type:'transfer', id:r.transfer_id, no:r.transfer_no,
        date:(r.transfer_date||(r.out_at||'').slice(0,10)),
        from:r.from_godown_name||'—', to:r.to_godown_name||'—',
        status:r.status, extra:`${r.total_boxes||0} box(es)`,
      }));
      const mrs = ((mrR && mrR.status==='ok' && mrR.requests) || []).map(r => ({
        _type:'request', id:r.id, no:r.request_no, date:r.request_date,
        from:r.source_godown_name||'Any', to:r.dest_godown_name||'—',
        status:r.status, extra:`${r.item_count||0} item(s)`,
      }));
      V.rows = [...grns, ...trs, ...mrs].sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
    } catch(e){ V.rows = []; }
    render();
  }

  /* ── client-side filter (date/search applied here too) ────────────── */
  function _filtered(){
    let rows = V.filter==='all' ? V.rows : V.rows.filter(r=>r._type===V.filter);
    if(V.from) rows = rows.filter(r => String(r.date||'') >= V.from);
    if(V.to)   rows = rows.filter(r => String(r.date||'') <= V.to);
    if(V.search){
      const q = V.search.toLowerCase();
      rows = rows.filter(r => [r.no,r.from,r.to].some(x => String(x||'').toLowerCase().includes(q)));
    }
    return rows;
  }

  function render(){
    const panel = $('panel-voucher-log');
    if(!panel) return;
    const tabs = [['all','All'],['grn','GRN'],['transfer','Transfer'],['request','Request']];
    const chips = tabs.map(([k,label]) =>
      `<button class="btn ${V.filter===k?'btn-primary':''}" style="padding:5px 14px;font-size:12px" onclick="invVLogFilter('${k}')">${label}</button>`).join('');

    const rows = _filtered();
    const body = rows.length ? rows.map(r => `
      <tr ondblclick="invVLogOpen('${r._type}',${r.id})" style="cursor:pointer" title="Double-click to open">
        <td style="white-space:nowrap">${typeBadge(r._type)}</td>
        <td style="white-space:nowrap;font-weight:700">${esc(r.no||'')}</td>
        <td style="white-space:nowrap">${esc(fdate(r.date))}</td>
        <td style="white-space:nowrap">${esc(r.from)}</td>
        <td style="white-space:nowrap">${esc(r.to)}</td>
        <td style="white-space:nowrap">${esc(r.extra||'')}</td>
        <td style="white-space:nowrap">${statusPill(r.status)}</td>
      </tr>`).join('')
      : `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--muted,#9ca3af);font-style:italic">No vouchers found.</td></tr>`;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:18px;font-weight:800">Voucher Log</h2>
        <div style="flex:1"></div>
        <span style="font-size:12px;color:var(--muted,#9ca3af)">${rows.length} voucher(s)</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">${chips}</div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">
        <div><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">From</label>
          <input type="date" value="${V.from}" onchange="invVLogSet('from',this.value)" style="padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111)"></div>
        <div><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">To</label>
          <input type="date" value="${V.to}" onchange="invVLogSet('to',this.value)" style="padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111)"></div>
        <div style="flex:1;min-width:180px"><label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted,#9ca3af);display:block;margin-bottom:3px">Search</label>
          <input type="text" value="${esc(V.search)}" placeholder="Voucher no / godown / supplier…" oninput="invVLogSet('search',this.value)" style="width:100%;padding:7px 9px;border:1px solid var(--border,#d1d5db);border-radius:7px;background:var(--card,#fff);color:var(--text,#111)"></div>
        <button class="btn" onclick="invVLogReload()"><i class="fas fa-sync"></i> Refresh</button>
      </div>
      <div class="inv-table-wrap"><div class="inv-table-scroll">
        <table class="inv-table" style="width:100%;table-layout:auto">
          <thead><tr>
            <th>Type</th><th>Voucher No</th><th>Date</th><th>From</th><th>To</th><th>Detail</th><th style="width:100%">Status</th>
          </tr></thead>
          <tbody id="vlog-tbody">${body}</tbody>
        </table>
      </div></div>`;
  }

  function setFilter(f){ V.filter = f; render(); }
  function setField(field,val){ V[field] = val; render(); }
  function reload(){ load(); }

  /* Open a voucher in its own module. Each voucher type lives in a different
     panel/module, so we route to the right one and call its open handler. */
  function openVoucher(type, id){
    try {
      if(type === 'transfer'){
        if(typeof window.invTrOpenExisting === 'function'){ window.invTrOpenExisting(id); return; }
      } else if(type === 'request'){
        // Activate the Material Request panel, then open the detail.
        if(typeof window.invMRActivate === 'function') window.invMRActivate();
        if(typeof window.invMROpenDetail === 'function'){ window.invMROpenDetail(id); return; }
      } else if(type === 'grn'){
        // Switch to the GRN panel/tab if a nav item exists, then open the form.
        var grnNav = Array.from(document.querySelectorAll('.inv-nav-item'))
          .find(function(n){ return /grn|goods receipt/i.test(n.textContent||''); });
        if(grnNav) grnNav.click();
        if(typeof window.invGrnOpenForm === 'function'){
          setTimeout(function(){ window.invGrnOpenForm({ id: id }); }, 120);
          return;
        }
      }
      // Fallback: nothing to open with.
      if(window.invToast) window.invToast('Open handler for this voucher type isn\'t available here — open it from its own tab.', 'info', 4000);
    } catch(e){
      if(window.invToast) window.invToast('Could not open voucher: ' + (e.message||e), 'error', 4000);
    }
  }

  /* ── panel + nav ──────────────────────────────────────────────────── */
  function _injectPanel(){
    if($('panel-voucher-log')) return;
    const wrap = document.querySelector('.inv-wrap');
    if(!wrap) return;
    const div = document.createElement('div');
    div.className = 'panel'; div.id = 'panel-voucher-log';
    wrap.appendChild(div);
  }
  function _injectNav(){
    if($('vlog-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Vouchers');
    if(!section){
      section = document.createElement('div'); section.className = 'inv-nav-section';
      section.innerHTML = `<div class="inv-nav-section-label">Vouchers</div>`;
      navBody.appendChild(section);
    }
    const item = document.createElement('div');
    item.className = 'inv-nav-item'; item.id = 'vlog-nav-item';
    // Gated by the 'voucher_log' capability via the page's data-cap machinery
    // (hidden when the user lacks access; admins always pass).
    item.setAttribute('data-cap', 'voucher_log');
    item.onclick = () => activate();
    item.innerHTML = `<span class="ico">🧾</span><span>Voucher Log</span>`;
    section.appendChild(item);
    // Re-apply gating now that the item exists (covers the case where the
    // access state resolved before this item was injected).
    if (typeof window.invApplyAccessGating === 'function') window.invApplyAccessGating();
  }
  function activate(){
    document.querySelectorAll('.inv-wrap .panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.inv-nav-item').forEach(n => n.classList.remove('active'));
    $('panel-voucher-log')?.classList.add('active');
    $('vlog-nav-item')?.classList.add('active');
    render(); load();
  }

  function _boot(){ _injectPanel(); _injectNav(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();

  window.invVLogFilter = setFilter;
  window.invVLogSet    = setField;
  window.invVLogReload = reload;
  window.invVLogActivate = activate;
  window.invVLogOpen   = openVoucher;

  console.log('✅ inventory_voucher_log.js loaded (Phase 5)');
})();
