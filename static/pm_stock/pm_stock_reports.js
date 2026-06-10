/* pm_stock_reports.js — Reports hub + Home dashboard (HCP PM Stock)
   • 15-card Reports hub with USER / ACCOUNTANT / AUDITOR role tags + filter.
   • A single generic "report viewer" modal renders every report.
   • 3 data-gap cards (ABC / Expiry-FEFO / Audit-Variance) show "Needs setup".
   • Home dashboard: Tasks / Alerts / Today's Activity, clickable tiles. */
(function(){
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtN = n => (Number(n) || 0).toLocaleString('en-IN');
  const fmtDate = d => { const s = String(d||'').slice(0,10).split('-'); return s.length===3 ? `${s[2]}/${s[1]}/${s[0]}` : (d||''); };
  const monthStart = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; };
  const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const openM = id => document.getElementById(id)?.classList.add('open');
  const closeM = id => document.getElementById(id)?.classList.remove('open');
  const toast = (m,t,ms) => { if(typeof showToast==='function') showToast(m,t||'info',ms||2500); };

  const REPORTS = [
    { id:'godown_stock',     icon:'🏢', title:'Godown-wise Stock',   meta:'Stock summary by godown',          roles:['u','c'], tint:'teal' },
    { id:'group_stock',      icon:'🧱', title:'Group-wise Stock',    meta:'Stock summary by group',           roles:['u','c'], tint:'indigo' },
    { id:'movement_ledger',  icon:'🔁', title:'Movement Ledger',     meta:'In/out history for a material',    roles:['a','u'], tint:'sky' },
    { id:'audit_variance',   icon:'⚖️', title:'Audit Variance',      meta:'Physical count vs system',         roles:['a','c'], tint:'amber', status:'setup', need:'a physical stock-count record (no count data captured yet)' },
    { id:'non_moving',       icon:'🐢', title:'Non-Moving Stock',    meta:'No outward movement in N days',    roles:['c','u'], tint:'slate' },
    { id:'expiry_fefo',      icon:'⏳', title:'Expiry / FEFO',       meta:'Boxes expiring soon',              roles:['u','a'], tint:'amber', status:'setup', need:'an expiry / shelf-life date on stock (not captured yet)' },
    { id:'neg_zero',         icon:'⚠️', title:'Negative / Zero',     meta:'Data-integrity stock flags',       roles:['a','u'], tint:'rose' },
    { id:'reorder',          icon:'🛒', title:'Reorder (Below MSL)', meta:'Items under minimum level',        roles:['u'],     tint:'orange' },
    { id:'grn_register',     icon:'📥', title:'GRN Register',        meta:'Goods received in a period',       roles:['c','a'], tint:'green' },
    { id:'delivery_register',icon:'🚚', title:'Delivery Register',   meta:'Outward deliveries in a period',   roles:['c','a'], tint:'cyan' },
    { id:'transfer_register',icon:'🔀', title:'Transfer Register',   meta:'Godown-to-godown transfers',       roles:['a','u'], tint:'violet' },
    { id:'item_card',        icon:'🗂️', title:'Item Stock Card',     meta:'One material, all godowns',        roles:['u','a'], tint:'teal' },
    { id:'box_list',         icon:'🔖', title:'Box List',            meta:'All active boxes / labels',        roles:['u','a'], tint:'sky' },
    { id:'stock_ageing',     icon:'⏱️', title:'Stock Ageing',        meta:'How long stock has sat',           roles:['c','a'], tint:'amber' },
    { id:'abc_analysis',     icon:'📊', title:'ABC Analysis',        meta:'Rank materials by receipt value',  roles:['c'],     tint:'indigo' },
  ];
  const ROLE_LABEL = { u:'USER', c:'ACCOUNTANT', a:'AUDITOR' };
  const ROLE_CLR   = { u:'#2563eb', c:'#7c3aed', a:'#0d9488' };
  let _hubFilter = 'all';
  window.openReportsHub = function(){ _renderHub(); openM('reportsHubModal'); };
  window.reportsHubFilter = function(role){ _hubFilter = role; _renderHub(); };
  function _renderHub(){
    const grid = document.getElementById('rpt-grid'); if(!grid) return;
    const list = REPORTS.filter(r => _hubFilter==='all' || r.roles.includes(_hubFilter));
    grid.innerHTML = list.map(r => {
      const tags = r.roles.map(ro => `<span class="rpt-tag" style="color:${ROLE_CLR[ro]}">${ROLE_LABEL[ro]}</span>`).join('');
      const setup = r.status==='setup';
      return `<button class="rpt-card ${r.tint}${setup?' rpt-setup':''}" onclick="${setup?`reportNeedsSetup('${esc(r.title)}','${esc(r.need||'')}')`:`openReport('${r.id}')`}">
        <div class="rpt-cover"><span class="rpt-icon">${r.icon}</span>${setup?'<span class="rpt-setup-badge">Needs setup</span>':''}</div>
        <div class="rpt-body"><div class="rpt-title">${esc(r.title)}</div><div class="rpt-desc">${esc(r.meta)}</div><div class="rpt-foot">${tags}</div></div></button>`;
    }).join('');
    ['all','u','c','a'].forEach(k => { const b=document.getElementById('rptf-'+k); if(b) b.classList.toggle('on', _hubFilter===k); });
  }
  window.reportNeedsSetup = function(title, need){ alert(`"${title}" needs setup.\n\nThis report requires ${need}.\n\nOnce that data is captured, this report will populate automatically.`); };

  let _viewer = { id:null, data:null, def:null };
  const PERIOD_REPORTS = ['movement_ledger','grn_register','delivery_register','transfer_register','item_card','abc_analysis'];
  const ITEM_REPORTS   = ['movement_ledger','item_card'];
  const SEARCH_REPORTS = ['grn_register','box_list'];
  // Reports that get a brand filter (filters rows where the underlying product belongs to the chosen brand)
  const BRAND_REPORTS = ['grn_register','abc_analysis'];
  window.openReport = function(id){
    const def = REPORTS.find(r => r.id===id); if(!def) return;
    _viewer = { id, data:null, def }; closeM('reportsHubModal');
    const needItem=ITEM_REPORTS.includes(id), needPeriod=PERIOD_REPORTS.includes(id), needSearch=SEARCH_REPORTS.includes(id), needDays=(id==='non_moving'), needGodown=(id==='godown_stock'), needBrand=BRAND_REPORTS.includes(id);
    let f='';
    if(needItem){ f += `<div style="flex:1;min-width:230px"><label class="rv-lbl">Item</label><div class="prod-combo-wrap" id="rv-prod-wrap" style="position:relative"><input type="hidden" id="rv-product-id" value=""><input type="text" class="prod-combo-input" placeholder="Type to search product…" autocomplete="off" style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text,#111);outline:none"><div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;background:var(--surface,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;border-radius:0 0 7px 7px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div></div></div>`; }
    if(needGodown){ const opts=(window._godowns||[]).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join(''); f += `<div><label class="rv-lbl">Location</label><select id="rv-godown" class="rv-inp"><option value="">All locations</option>${opts}</select></div>`; }
    if(needPeriod){ f += `<div><label class="rv-lbl">From</label><input type="date" id="rv-from" class="rv-inp" value="${monthStart()}"></div><div><label class="rv-lbl">To</label><input type="date" id="rv-to" class="rv-inp" value="${today()}"></div>`; }
    else if(needGodown){ f += `<div><label class="rv-lbl">As of</label><input type="date" id="rv-to" class="rv-inp" value="${today()}"></div>`; }
    if(needDays){ f += `<div><label class="rv-lbl">No movement for</label><select id="rv-days" class="rv-inp"><option value="30">30 days</option><option value="60">60 days</option><option value="90" selected>90 days</option><option value="180">180 days</option></select></div>`; }
    if(needBrand){ const bopts=(window._brands||[]).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join(''); f += `<div><label class="rv-lbl">Brand</label><select id="rv-brand" class="rv-inp"><option value="">All brands</option>${bopts}</select></div>`; }
    if(needSearch){ f += `<div style="flex:1;min-width:200px"><label class="rv-lbl">Search</label><input type="text" id="rv-search" class="rv-inp" placeholder="GRN no, supplier or invoice…" style="width:100%"></div>`; }
    f += `<button class="btn btn-sm" onclick="reportRun()" style="background:var(--nb-primary,#4648D4);color:#fff;border:none"><i class="fas fa-search"></i> Show</button><button class="btn btn-outline btn-sm" onclick="reportPrint()"><i class="fas fa-print"></i> Print</button>`;
    document.getElementById('rv-title').textContent = `${def.icon}  ${def.title}`;
    // Reset modal to natural width before next render — _autoFitModal() will resize after data loads.
    const rvModal = document.querySelector('#reportViewerModal .modal');
    if(rvModal){ rvModal.style.maxWidth = 'min(97vw,1180px)'; rvModal.style.width = ''; }
    // Zero out #rv-body's top padding — without this, the body's padding-top creates a gap
    // through which scrolled rows can peek ABOVE the sticky table header. Inner content provides
    // its own top spacer (see reportRun()).
    const rvBody0 = document.getElementById('rv-body');
    if(rvBody0){ rvBody0.style.paddingTop = '0'; }
    document.getElementById('rv-filters').innerHTML = f;
    document.getElementById('rv-body').innerHTML = `<div class="rv-empty">${needItem?'Pick an item and press Show.':'Press Show to load.'}</div>`;
    openM('reportViewerModal');
    // Enter key in the search box triggers Show
    const sb = document.getElementById('rv-search');
    if(sb){ sb.addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); reportRun(); } }); }
    // Brand select change triggers Show automatically (matches how period filters feel)
    const bs = document.getElementById('rv-brand');
    if(bs){ bs.addEventListener('change', ()=>reportRun()); }
    if(needItem && typeof _initProdCombo==='function'){ _initProdCombo(document.getElementById('rv-prod-wrap'), null, (p)=>{ if(p&&p.id) document.getElementById('rv-product-id').value=p.id; reportRun(); }); setTimeout(()=>document.querySelector('#rv-prod-wrap .prod-combo-input')?.focus(),60); }
    else if(!needItem){ reportRun(); }
  };
  function _qs(){ const p=new URLSearchParams(); const pid=document.getElementById('rv-product-id')?.value; if(pid) p.set('product_id',pid); const gid=document.getElementById('rv-godown')?.value; if(gid) p.set('godown_id',gid); const bid=document.getElementById('rv-brand')?.value; if(bid) p.set('brand_id',bid); const fr=document.getElementById('rv-from')?.value; if(fr) p.set('from_date',fr); const to=document.getElementById('rv-to')?.value; if(to) p.set('to_date',to); const dy=document.getElementById('rv-days')?.value; if(dy) p.set('days',dy); const s=document.getElementById('rv-search')?.value?.trim(); if(s) p.set('search',s); return p.toString(); }
  window.reportRun = async function(){
    const id=_viewer.id; if(!id) return; const body=document.getElementById('rv-body');
    if(ITEM_REPORTS.includes(id) && !document.getElementById('rv-product-id')?.value){ body.innerHTML=`<div class="rv-empty" style="color:#dc2626">Pick an item first.</div>`; return; }
    body.innerHTML=`<div class="rv-empty">Loading…</div>`;
    try{ const res=await fetch(`/api/pm_stock/reports/${id}?${_qs()}`); const d=await res.json();
      if(d.status!=='ok'){ body.innerHTML=`<div class="rv-empty" style="color:#dc2626">${esc(d.message||'Failed to load')}</div>`; return; }
      _viewer.data=d;
      // 14px top spacer replaces the body's removed padding-top — content sits below the filter bar
      // with normal breathing room, and the table's sticky header has nothing above it to leak through.
      const inner = RENDER[id] ? RENDER[id](d) : `<pre>${esc(JSON.stringify(d,null,2))}</pre>`;
      body.innerHTML = `<div style="height:14px"></div>${inner}`;
      // After paint, size the modal to fit the table's natural content width (capped to viewport).
      requestAnimationFrame(_autoFitModal);
    }catch(e){ body.innerHTML=`<div class="rv-empty" style="color:#dc2626">Error: ${esc(e.message)}</div>`; }
  };
  // Resize the report viewer modal so its content area matches the table's natural width.
  // Floor: 1180px (the default look). Ceiling: 97vw (never go past the viewport).
  function _autoFitModal(){
    const modal = document.querySelector('#reportViewerModal .modal');
    const table = document.querySelector('#rv-body .rv-tbl');
    if(!modal || !table) return;
    // Horizontal padding of #rv-body is 22px on each side (see template). Plus a small breathing margin.
    const bodyPad = 22 * 2;
    const breathe = 8;
    // scrollWidth reflects the table's natural content width even if it overflows.
    const tableW = table.scrollWidth || 0;
    const desired = tableW + bodyPad + breathe;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const ceiling = Math.floor(vw * 0.97);
    const floor   = 1180;
    const target = Math.min(ceiling, Math.max(floor, desired));
    modal.style.maxWidth = target + 'px';
    modal.style.width    = target + 'px';
  }
  function tbl(cols, rows){
    // Default left-aligned text columns to NOWRAP so the table's natural width matches its content;
    // opt-in to wrapping per column with `wrap:true` (e.g. long supplier names where wrapping is acceptable).
    // Header style matches the canonical NotebookLM grid look used by the rest of the module:
    //   gradient bg from --nb-surface to --nb-surface-2, muted charcoal uppercase text, hairline bottom rule.
    // !important on the inline rules because the module's external sheets (procurement.css / hcptheme.css /
    // theme.css) paint a solid blue header bar via .modal-overlay table thead th with !important; inline
    // !important wins per CSS specificity.
    // Sticky: top:0 of #rv-body. #rv-body's padding-top is zeroed in openReport() so the header pins flush.
    const headerBg = 'linear-gradient(to bottom,var(--nb-surface,#f8f9fa) 0%,var(--nb-surface-2,#f1f3f4) 100%) !important';
    const headerTxt = 'color:var(--nb-text-muted,#444746) !important;font-size:10px !important;font-weight:700 !important;text-transform:uppercase !important;letter-spacing:.12em !important';
    const headerBdr = 'box-shadow:inset 0 -1px 0 var(--nb-border-strong,rgba(70,72,212,.14)) !important';
    const th = cols.map(c =>
      `<th style="text-align:${c.align||'left'} !important;padding:13px 16px !important;white-space:nowrap !important;`+
      `position:sticky !important;top:0 !important;z-index:3 !important;background:${headerBg};${headerTxt};${headerBdr}">${esc(c.label)}</th>`
    ).join('');
    const tr = (rows||[]).map(r => `<tr>${cols.map(c=>{
      let v=r[c.k]; v=c.fmt?c.fmt(v,r):(v==null?'':v);
      // Non-wrap cells: nowrap + keep-all + normal overflow-wrap so slashes/hyphens don't act as break points.
      const cellStyle = c.wrap
        ? `text-align:${c.align||'left'};padding:7px 12px;white-space:normal;max-width:${c.maxWidth||320}px;`
        : `text-align:${c.align||'left'};padding:7px 12px;white-space:nowrap;word-break:keep-all;overflow-wrap:normal;`;
      return `<td style="${cellStyle}">${v}</td>`;
    }).join('')}</tr>`).join('');
    // width:max-content + min-width:100% — table is exactly as wide as it needs to be, but never narrower than the body.
    return `<div class="rv-tbl-wrap"><table class="rv-tbl" style="width:max-content;min-width:100%;border-collapse:separate;border-spacing:0">`+
           `<thead><tr>${th}</tr></thead><tbody>${tr||`<tr><td colspan="${cols.length}" class="rv-empty">No rows.</td></tr>`}</tbody></table></div>`;
  }
  function kpis(items){ return `<div class="rv-kpis">${items.map(i=>`<div class="rv-kpi"><div class="rv-kpi-l">${esc(i.label)}</div><div class="rv-kpi-v" style="color:${i.clr||'#111'}">${i.val}</div></div>`).join('')}</div>`; }
  const num = v => `<span style="font-family:monospace">${fmtN(v)}</span>`;
  const RENDER = {
    godown_stock(d){ const t=d.totals||{}; return kpis([{label:'Products',val:fmtN(d.count),clr:'#2563eb'},{label:'Opening',val:fmtN(t.opening),clr:'#6b7280'},{label:'Inward',val:fmtN(t.inward),clr:'#16a34a'},{label:'Outward',val:fmtN(t.outward),clr:'#dc2626'},{label:'Closing',val:fmtN(t.closing),clr:'#0d9488'}]) + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'opening',label:'Opening',align:'right',fmt:num},{k:'inward',label:'Inward',align:'right',fmt:num},{k:'outward',label:'Outward',align:'right',fmt:num},{k:'closing',label:'Closing',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`},{k:'min_stock',label:'MSL',align:'right',fmt:v=>v?fmtN(v):'—'}], d.rows); },
    group_stock(d){ return tbl([{k:'group',label:'Group',align:'left',fmt:v=>`<b>${esc(v)}</b>`},{k:'products',label:'Products',align:'right',fmt:num},{k:'opening',label:'Opening',align:'right',fmt:num},{k:'inward',label:'Inward',align:'right',fmt:num},{k:'outward',label:'Outward',align:'right',fmt:num},{k:'closing',label:'Closing',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`}], d.rows); },
    movement_ledger(d){ const p=d.product||{}; return `<div class="rv-sub"><b>${esc(p.name)}</b> <span style="color:#999">[${esc(p.pm_type)}]${p.code?' · '+esc(p.code):''}</span> <span style="margin-left:auto;color:#888">${fmtDate(d.from_date)} → ${fmtDate(d.to_date)}</span></div>` + kpis([{label:'Opening',val:fmtN(d.opening_balance),clr:'#6b7280'},{label:'Total In',val:fmtN(d.total_in),clr:'#16a34a'},{label:'Total Out',val:fmtN(d.total_out),clr:'#dc2626'},{label:'Closing',val:fmtN(d.closing_balance),clr:'#2563eb'}]) + tbl([{k:'date',label:'Date',align:'left',fmt:v=>fmtDate(v)},{k:'type_label',label:'Type',align:'left',fmt:v=>esc(v)},{k:'voucher_no',label:'Voucher',align:'left',fmt:v=>`<span style="font-family:monospace;font-size:11px">${esc(v)}</span>`},{k:'location',label:'Location',align:'left',fmt:v=>esc(v)},{k:'in_qty',label:'In',align:'right',fmt:v=>v?`<span style="color:#16a34a;font-weight:700">${fmtN(v)}</span>`:''},{k:'out_qty',label:'Out',align:'right',fmt:v=>v?`<span style="color:#dc2626;font-weight:700">${fmtN(v)}</span>`:''},{k:'balance',label:'Balance',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`},{k:'remarks',label:'Remarks',align:'left',fmt:v=>esc(v)}], d.rows); },
    item_card(d){ const p=d.product||{}; return `<div class="rv-sub"><b>${esc(p.name)}</b> <span style="color:#999">[${esc(p.pm_type)}]${p.code?' · '+esc(p.code):''}</span></div>` + kpis([{label:'Opening',val:fmtN(d.opening),clr:'#6b7280'},{label:'Inward',val:fmtN(d.inward),clr:'#16a34a'},{label:'Outward',val:fmtN(d.outward),clr:'#dc2626'},{label:'Closing',val:fmtN(d.closing),clr:'#0d9488'},{label:'MSL',val:fmtN(p.min_stock),clr:'#d97706'}]) + `<div class="rv-note">Period ${fmtDate(d.from_date)} → ${fmtDate(d.to_date)}. For the line-by-line history, use the <b>Movement Ledger</b> report.</div>`; },
    non_moving(d){ return kpis([{label:`Idle > ${d.days}d`,val:fmtN(d.count),clr:'#dc2626'}]) + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'closing',label:'Stock',align:'right',fmt:num},{k:'last_outward',label:'Last Outward',align:'left',fmt:v=>v==='never'?'<span style="color:#dc2626">never</span>':fmtDate(v)}], d.rows); },
    neg_zero(d){ return kpis([{label:'Negative',val:fmtN(d.neg_count),clr:'#dc2626'},{label:'Zero',val:fmtN(d.zero_count),clr:'#d97706'}]) + `<div class="rv-section">Negative stock (data-integrity flag)</div>` + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'closing',label:'Stock',align:'right',fmt:v=>`<span style="color:#dc2626;font-weight:800">${fmtN(v)}</span>`}], d.negative) + `<div class="rv-section" style="margin-top:14px">Zero stock</div>` + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)}], d.zero); },
    reorder(d){ return kpis([{label:'Below MSL',val:fmtN(d.count),clr:'#d97706'}]) + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'closing',label:'In Stock',align:'right',fmt:num},{k:'min_stock',label:'MSL',align:'right',fmt:num},{k:'shortfall',label:'Shortfall',align:'right',fmt:v=>`<span style="color:#dc2626;font-weight:700">${fmtN(v)}</span>`}], d.rows); },
    grn_register(d){ return kpis([{label:'GRNs',val:fmtN(d.count),clr:'#16a34a'},{label:'Total Qty',val:fmtN(d.grand_qty),clr:'#0d9488'}]) + tbl([{k:'grn_no',label:'GRN No',align:'left',fmt:v=>`<button class="rv-link" style="white-space:nowrap;word-break:keep-all;overflow-wrap:normal;display:inline-block" onclick="reportOpenGrn('${esc(v)}')">${esc(v)}</button>`},{k:'grn_date',label:'Date',align:'left',fmt:v=>fmtDate(v)},{k:'supplier',label:'Supplier',align:'left',wrap:true,maxWidth:280,fmt:v=>esc(v)},{k:'invoice_no',label:'Invoice',align:'left',fmt:v=>esc(v)||'—'},{k:'godown_name',label:'Location',align:'left',fmt:v=>esc(v)},{k:'item_count',label:'Items',align:'right',fmt:num},{k:'total_qty',label:'Total Qty',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`},{k:'vstatus',label:'Status',align:'left',fmt:v=>v==='pending'?'<span style="color:#d97706">Pending</span>':'<span style="color:#16a34a">Verified</span>'}], d.rows); },
    delivery_register(d){ return kpis([{label:'Deliveries',val:fmtN(d.count),clr:'#0891b2'}]) + tbl([{k:'dn_no',label:'DN No',align:'left',fmt:v=>`<span style="font-family:monospace">${esc(v)}</span>`},{k:'dn_date',label:'Date',align:'left',fmt:v=>fmtDate(v)},{k:'to_party',label:'To / Remarks',align:'left',fmt:v=>esc(v)},{k:'item_count',label:'Items',align:'right',fmt:num},{k:'total_qty',label:'Total Qty',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`}], d.rows); },
    transfer_register(d){ return kpis([{label:'Transfers',val:fmtN(d.count),clr:'#7c3aed'}]) + tbl([{k:'voucher_no',label:'Voucher',align:'left',fmt:v=>`<span style="font-family:monospace">${esc(v)}</span>`},{k:'date',label:'Date',align:'left',fmt:v=>fmtDate(v)},{k:'from_name',label:'From',align:'left',fmt:v=>esc(v)},{k:'to_name',label:'To',align:'left',fmt:v=>esc(v)},{k:'status',label:'Status',align:'left',fmt:v=>esc(v)},{k:'item_count',label:'Items',align:'right',fmt:num},{k:'total_qty',label:'Total Qty',align:'right',fmt:v=>`<b>${fmtN(v)}</b>`}], d.rows); },
    box_list(d){ return kpis([{label:'Boxes',val:fmtN(d.count),clr:'#2563eb'}]) + (d.capped?`<div class="rv-note">Showing first ${d.count} — narrow with search.</div>`:'') + tbl([{k:'code',label:'Box Code',align:'left',fmt:v=>`<span style="font-family:monospace">${esc(v)}</span>`},{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'version',label:'Version',align:'left',fmt:v=>esc(v)||'—'},{k:'per_box_qty',label:'Per-box Qty',align:'right',fmt:num},{k:'location',label:'Location',align:'left',fmt:v=>esc(v)},{k:'grn_no',label:'GRN',align:'left',fmt:v=>`<span style="font-family:monospace;font-size:11px">${esc(v)}</span>`}], d.rows); },
    stock_ageing(d){ const b=d.buckets||{}; return kpis([{label:'0-30d',val:fmtN(b['0-30']),clr:'#16a34a'},{label:'31-60d',val:fmtN(b['31-60']),clr:'#65a30d'},{label:'61-90d',val:fmtN(b['61-90']),clr:'#d97706'},{label:'90+ d',val:fmtN(b['90+']),clr:'#dc2626'}]) + tbl([{k:'product_name',label:'Product',align:'left',fmt:v=>esc(v)},{k:'pm_type',label:'Group',align:'left',fmt:v=>esc(v)},{k:'closing',label:'Stock',align:'right',fmt:num},{k:'last_inward',label:'Last Inward',align:'left',fmt:v=>v==='—'?'—':fmtDate(v)},{k:'age_days',label:'Age (days)',align:'right',fmt:v=>v==='—'?'—':`<b>${fmtN(v)}</b>`},{k:'bucket',label:'Bucket',align:'left',fmt:v=>esc(v)}], d.rows); },
    abc_analysis(d){
      // KPI strip — class counts + grand value. We show unpriced-line count
      // prominently because it's actionable: those items are missing rate
      // data and the operator can back-fill via GRN edit.
      const c = d.counts || {};
      const fmtRupees = v => '₹ ' + Number(v||0).toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:0});
      const fmtRate   = v => '₹ ' + Number(v||0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
      const fmtPct    = v => (Number(v||0)).toFixed(1) + '%';
      const classPill = cls => {
        // Visually anchor the class: green=A (vital few), amber=B, slate=C, red=N/A
        const m = {
          'A':   {bg:'#16a34a',  label:'A'},
          'B':   {bg:'#d97706',  label:'B'},
          'C':   {bg:'#64748b',  label:'C'},
          'N/A': {bg:'#dc2626',  label:'—'},
        }[cls] || {bg:'#999',label:cls};
        return `<span style="display:inline-block;min-width:24px;padding:2px 7px;border-radius:9px;background:${m.bg};color:#fff;font-weight:800;font-size:11px;text-align:center">${m.label}</span>`;
      };
      const kpiBlock = kpis([
        {label:'Total Items', val:fmtN(d.count),               clr:'#2563eb'},
        {label:'Class A',     val:fmtN(c.A||0),                clr:'#16a34a'},
        {label:'Class B',     val:fmtN(c.B||0),                clr:'#d97706'},
        {label:'Class C',     val:fmtN(c.C||0),                clr:'#64748b'},
        {label:'No Rate',     val:fmtN(c['N/A']||0),           clr:'#dc2626'},
        {label:'Total Value', val:fmtRupees(d.grand_value),    clr:'#0d9488'},
      ]);
      // Note row — explains the "N/A" class and how to fix it.
      const note = (d.unpriced_count > 0)
        ? `<div class="rv-note" style="background:rgba(220,38,38,.06);border-color:rgba(220,38,38,.25);color:#991b1b">⚠️ ${d.unpriced_count} item${d.unpriced_count>1?'s':''} have no rate captured on any GRN line in this period — they contribute ₹ 0 to value totals and rank as <b>N/A</b>. Back-fill rates by editing the relevant GRN, or wait for new receipts to record rates.</div>`
        : '';
      return kpiBlock + note + tbl([
        {k:'rank',           label:'#',          align:'right', fmt:v=>`<span style="color:#9ca3af">${v}</span>`},
        {k:'product_code',   label:'Code',       align:'left',  fmt:v=>v?`<span style="font-family:monospace;font-size:11px">${esc(v)}</span>`:''},
        {k:'product_name',   label:'Product',    align:'left',  wrap:true, maxWidth:260, fmt:v=>esc(v)},
        {k:'brand_name',     label:'Brand',      align:'left',  fmt:v=>esc(v)||'—'},
        {k:'qty_total',      label:'Qty (period)', align:'right', fmt:num},
        {k:'avg_rate',       label:'Avg Rate',   align:'right', fmt:v=>v>0?fmtRate(v):'<span style="color:#dc2626">—</span>'},
        {k:'value_total',    label:'Value',      align:'right', fmt:v=>`<b>${fmtRupees(v)}</b>`},
        {k:'share_pct',      label:'Share %',    align:'right', fmt:v=>fmtPct(v)},
        {k:'cumulative_pct', label:'Cum %',      align:'right', fmt:v=>`<span style="color:#666">${fmtPct(v)}</span>`},
        {k:'abc_class',      label:'Class',      align:'center', fmt:v=>classPill(v)},
      ], d.rows);
    },
  };
  window.reportOpenGrn = function(grnNo){
    closeM('reportViewerModal');
    if(typeof switchTab==='function') switchTab('grn');
    if(typeof setSidebarActive==='function') setSidebarActive('grn');
    setTimeout(()=>{ const df=document.getElementById('grn-from'); if(df) df.value=''; const dt=document.getElementById('grn-to'); if(dt) dt.value=''; const sb=document.getElementById('grn-search'); if(sb){ sb.value=grnNo; if(typeof loadVoucherLog==='function') loadVoucherLog(); } },250);
    let tries=0;
    const go=()=>{ const btn=[...document.querySelectorAll('[data-expand-btn^="grn-"]')].find(b=>(b.closest('tr')?.textContent||'').includes(grnNo));
      if(btn){ const row=btn.closest('tr'); if(btn.dataset.expanded!=='1'&&typeof toggleVoucherDetails==='function'){const a=btn.dataset.expandBtn.split('-');toggleVoucherDetails(a[0],parseInt(a[1],10),btn,true);} if(row){row.scrollIntoView({block:'center',behavior:'smooth'});} return; }
      if(tries++<25) setTimeout(go,160); else toast(`${grnNo} is filtered in the GRN log`,'info',3500); };
    setTimeout(go,550);
  };
  window.reportPrint = function(){
    if(!_viewer.data){ toast('Show the report first','error'); return; }
    const def=_viewer.def, bodyHtml=document.getElementById('rv-body').innerHTML;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(def.title)}</title><style>body{font-family:Arial,sans-serif;margin:20px;color:#111;font-size:12px}h1{font-size:17px;margin:0 0 2px}.sub{color:#555;font-size:11px;margin-bottom:12px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #bbb;padding:5px 7px;font-size:11px}th{background:#f0f0f0;text-align:left}.rv-kpis{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 4px}.rv-kpi{border:1px solid #ccc;border-radius:6px;padding:6px 12px}.rv-kpi-l{font-size:9px;text-transform:uppercase;color:#666}.rv-kpi-v{font-size:15px;font-weight:800}.rv-sub{margin:4px 0 8px;font-size:12px;display:flex}.rv-section{font-weight:800;margin:10px 0 4px}.rv-link{border:none;background:none;font-family:monospace;color:#1A73E8;padding:0}.rv-note{font-size:10px;color:#666;margin:6px 0}button{display:none!important}@media print{body{margin:10mm}}</style></head><body><h1>${esc(def.title)}</h1><div class="sub">HCP Wellness Pvt Ltd · PM Stock · printed ${new Date().toLocaleString('en-IN')}</div>${bodyHtml}<script>window.onload=function(){window.print();}<\/script></body></html>`;
    const w=window.open('','_blank','width=1000,height=720'); if(!w){ toast('Allow pop-ups to print','error'); return; } w.document.open(); w.document.write(html); w.document.close();
  };

  const HOME_TASKS = [
    {k:'material_requests', icon:'📋', label:'Material Requests', sub:'pending / in-progress', go:()=>{closeM('homeModal'); if(typeof switchTab==='function'){switchTab('mm'); if(typeof mmSwitchSubTab==='function') setTimeout(()=>mmSwitchSubTab('mr'),200);} }},
    {k:'transfers_in_transit', icon:'🚛', label:'Transfers In-Transit', sub:'awaiting receipt', go:()=>{closeM('homeModal'); if(typeof switchTab==='function') switchTab('mm');}},
    {k:'simple_vouchers', icon:'🧾', label:'Simple Vouchers', sub:'awaiting receipt', go:()=>{closeM('homeModal'); if(typeof switchTab==='function') switchTab('mm');}},
    {k:'fefo_overrides', icon:'🛡️', label:'FEFO Overrides', sub:'pending approval'},
    {k:'label_reprints', icon:'🖨️', label:'Label Reprints', sub:'pending approval'},
    {k:'label_reissues', icon:'🔖', label:'Label Reissues', sub:'pending approval'},
  ];
  const HOME_ALERTS = [
    {k:'below_msl', icon:'🛒', label:'Below MSL', sub:'reorder needed', alert:true, go:()=>{closeM('homeModal');openReport('reorder');}},
    {k:'zero_stock', icon:'🚫', label:'Zero Stock', sub:'tracked items at zero', alert:true, go:()=>{closeM('homeModal');openReport('neg_zero');}},
    {k:'negative_stock', icon:'⚠️', label:'Negative Stock', sub:'data-integrity flag', alert:true, go:()=>{closeM('homeModal');openReport('neg_zero');}},
    {k:'expiring_30d', icon:'📅', label:'Expiring ≤30d', sub:'needs expiry data', setup:true},
    {k:'expired', icon:'⛔', label:'Expired', sub:'needs expiry data', setup:true},
  ];
  const HOME_ACTIVITY = [
    {k:'grns_today', icon:'📥', label:'GRNs Today'},
    {k:'transfers_received', icon:'🔀', label:'Transfers Received'},
    {k:'boxes_created', icon:'📦', label:'Boxes Created'},
  ];
  window.openHome = async function(){ openM('homeModal'); _renderHome(null); try{ const res=await fetch('/api/pm_stock/home_dashboard'); const d=await res.json(); _renderHome((d&&d.counts)||{}); }catch(e){ _renderHome({}); } };
  window.refreshHome = ()=>openHome();
  function _homeTile(t, counts){ const v=counts?counts[t.k]:null; const loading=counts===null; const isSetup=t.setup||v===null; const n=(typeof v==='number')?v:0; const danger=t.alert&&n>0; const vTxt=loading?'…':(isSetup?'—':fmtN(n));
    return `<button class="home-tile${danger?' danger':''}${isSetup?' setup':''}" ${t.go&&!isSetup?'data-go="1"':''} data-k="${t.k}"><span class="home-ic">${t.icon}</span><span class="home-v" style="${danger?'color:#dc2626':''}">${vTxt}</span><span class="home-l">${esc(t.label)}</span><span class="home-s">${esc(t.sub||'')}</span>${isSetup?'<span class="home-setup">needs setup</span>':''}</button>`; }
  function _renderHome(counts){ const wrap=document.getElementById('home-body'); if(!wrap) return;
    const anyTask=counts&&HOME_TASKS.some(t=>(counts[t.k]||0)>0); const anyAlert=counts&&HOME_ALERTS.some(t=>t.alert&&(counts[t.k]||0)>0);
    const banner=counts?((anyTask||anyAlert)?`<div class="home-banner warn">⚠️ You have pending tasks or stock alerts — see below.</div>`:`<div class="home-banner ok">✓ All clear — no pending tasks or stock alerts right now.</div>`):`<div class="home-banner">Loading dashboard…</div>`;
    wrap.innerHTML = banner + `<div class="home-sec">Tasks — Needs Action</div><div class="home-grid">${HOME_TASKS.map(t=>_homeTile(t,counts)).join('')}</div>` + `<div class="home-sec">Alerts — Stock Conditions</div><div class="home-grid">${HOME_ALERTS.map(t=>_homeTile(t,counts)).join('')}</div>` + `<div class="home-sec">Today's Activity</div><div class="home-grid">${HOME_ACTIVITY.map(t=>_homeTile(t,counts)).join('')}</div>`;
    wrap.querySelectorAll('.home-tile[data-go]').forEach(btn=>{ const def=[...HOME_TASKS,...HOME_ALERTS].find(t=>t.k===btn.dataset.k); if(def&&def.go) btn.onclick=def.go; });
  }
  // Keep the modal auto-fit on browser resize (debounced)
  let _fitT = null;
  window.addEventListener('resize', () => {
    if(_fitT) clearTimeout(_fitT);
    _fitT = setTimeout(() => {
      if(document.getElementById('reportViewerModal')?.classList.contains('open')) _autoFitModal();
    }, 120);
  });
})();
