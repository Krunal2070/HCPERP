/*
   inventory_reports.js - Reports (RM)
   HCP Wellness

   Self-registering sidebar "Reports" item → opens a modal with:
     • report selector (Godown-wise / Group-wise stock summary)
     • godown OR group picker (searchable combobox if available)
     • With cost / Without cost toggle
     • Generate → renders a print-friendly table with totals
     • Print button (opens a clean print window)

   Gated by 'reports'. Backend: /api/inventory_mgmt/reports/*
*/
(function(){
  'use strict';

  const $ = (id)=>document.getElementById(id);
  const esc = (s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const nf = (n)=>Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:3});
  const money = (n)=>'₹'+Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  // Format dates as DD/MM/YYYY. Accepts 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'
  // (keeps the time part if present). Leaves anything unrecognized as-is.
  const fmtDate = (s)=>{
    if(!s) return '';
    const str=String(s);
    const m=str.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
    if(!m) return str;
    const time=(m[4]||'').trim();
    return `${m[3]}/${m[2]}/${m[1]}`+(time?(' '+time):'');
  };
  const toast = (m,k,ms)=> (window.invToast?window.invToast(m,k,ms):alert(m));

  let _report='godown';   // 'godown' | 'group'
  let _withCost=false;
  let _lastData=null;
  let _boxListQuery='';   // current Box List search text (client-side filter)
  let _hubQuery='';       // Reports hub search text
  let _hubAud='all';      // Reports hub audience filter: all|user|auditor|accountant

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;
    if(a.is_admin) return true;
    return a.access && a.access.reports!=='off' && a.access.reports!==false;
  }
  async function _api(url){
    const r=await fetch(url);
    const txt=await r.text();
    if((txt||'').trimStart().startsWith('<'))
      throw new Error(r.status===404?'endpoint not found — restart Flask':('server error '+r.status));
    const j=JSON.parse(txt);
    if(j.status!=='ok') throw new Error(j.message||'request failed');
    return j;
  }

  /* ── Sidebar nav ─────────────────────────────────────────── */
  function _injectNav(){
    if($('invReportsNav')) return;
    const section=document.querySelector('.inv-nav-section[data-section="Stock"] .inv-nav-body')
      || document.querySelector('.inv-nav-body');
    if(!section) return;
    const a=document.createElement('div');
    a.className='inv-nav-item'; a.id='invReportsNav';
    a.setAttribute('data-cap','reports');
    a.innerHTML='<span class="ico">📊</span> Reports';
    a.onclick=openReports;
    section.appendChild(a);
  }

  /* ── Modal ───────────────────────────────────────────────── */
  // Report registry — drives the hub grid. `kind` groups for the accent color.
  // status: 'ready' = built; 'soon' = placeholder until built.
  // audience: who the report is most useful for — drives the suggestion pills.
  //   'user' = inventory/store operator, 'auditor' = stock auditor / control,
  //   'accountant' = finance / valuation. Primary audience listed first.
  const REPORTS = [
    { id:'godown',    title:'Godown-wise Stock',    desc:'Stock summary by godown',          icon:'fa-warehouse',         cls:'inv-stat-card-total', status:'ready', audience:['user','accountant'] },
    { id:'group',     title:'Group-wise Stock',     desc:'Stock summary by group',           icon:'fa-layer-group',       cls:'inv-stat-card-with',  status:'ready', audience:['user','accountant'] },
    { id:'ledger',    title:'Movement Ledger',      desc:'In/out history for a material',    icon:'fa-right-left',        cls:'inv-stat-card-value', status:'ready', audience:['auditor','user'] },
    { id:'audit',     title:'Audit Variance',       desc:'Physical count vs system',         icon:'fa-clipboard-check',   cls:'inv-stat-card-low',   status:'ready', audience:['auditor','accountant'] },
    { id:'nonmoving', title:'Non-Moving Stock',     desc:'No outward movement in N days',    icon:'fa-hourglass-half',    cls:'inv-stat-card-zero',  status:'ready', audience:['accountant','user'] },
    { id:'expiry',    title:'Expiry / FEFO',        desc:'Boxes expiring soon',              icon:'fa-calendar-xmark',    cls:'inv-stat-card-low',   status:'ready', audience:['user','auditor'] },
    { id:'negzero',   title:'Negative / Zero',      desc:'Data-integrity stock flags',       icon:'fa-triangle-exclamation', cls:'inv-stat-card-zero', status:'ready', audience:['auditor','user'] },
    { id:'reorder',   title:'Reorder (Below MSL)',  desc:'Items under minimum level',        icon:'fa-cart-arrow-down',   cls:'inv-stat-card-low',   status:'ready', audience:['user'] },
    { id:'grnreg',    title:'GRN Register',         desc:'Goods received in a period',       icon:'fa-file-import',       cls:'inv-stat-card-with',  status:'ready', audience:['accountant','auditor'] },
    { id:'dnreg',     title:'Delivery Register',    desc:'Outward deliveries in a period',   icon:'fa-file-export',       cls:'inv-stat-card-value', status:'ready', audience:['accountant','auditor'] },
    { id:'trreg',     title:'Transfer Register',    desc:'Godown-to-godown transfers',       icon:'fa-arrows-turn-right', cls:'inv-stat-card-total', status:'ready', audience:['auditor','user'] },
    { id:'stockcard', title:'Item Stock Card',      desc:'One material, all godowns',        icon:'fa-id-card',           cls:'inv-stat-card-with',  status:'ready', audience:['user','auditor'] },
    { id:'boxlist',   title:'Box List',             desc:'All active boxes / labels',        icon:'fa-boxes-stacked',     cls:'inv-stat-card-total', status:'ready', audience:['user','auditor'] },
    { id:'ageing',    title:'Stock Ageing',         desc:'How long stock has sat',           icon:'fa-clock-rotate-left', cls:'inv-stat-card-value', status:'ready', audience:['accountant','auditor'] },
    { id:'abc',       title:'ABC Analysis',         desc:'Rank materials by value',          icon:'fa-ranking-star',      cls:'inv-stat-card-with',  status:'ready', audience:['accountant'] },
    { id:'batchtrace',title:'Batch Traceability',   desc:'Where did a batch go',             icon:'fa-barcode',           cls:'inv-stat-card-low',   status:'ready', audience:['auditor','user'] },
  ];

  // Visual + label config for the audience suggestion pills.
  const AUDIENCE_META = {
    user:       { label:'User',       icon:'fa-user',        color:'#1A73E8', bg:'#E8F0FE' },
    auditor:    { label:'Auditor',    icon:'fa-user-shield', color:'#137333', bg:'#E6F4EA' },
    accountant: { label:'Accountant', icon:'fa-calculator',  color:'#9334E6', bg:'#F3E8FD' },
  };
  function _audiencePills(audience){
    if(!audience || !audience.length) return '';
    const pills = audience.map(a=>{
      const m = AUDIENCE_META[a]; if(!m) return '';
      return `<span title="Most useful for: ${esc(m.label)}" style="display:inline-flex;align-items:center;gap:3px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${m.color};background:${m.bg};padding:2px 6px;border-radius:99px;white-space:nowrap"><i class="fas ${m.icon}" style="font-size:8px"></i>${esc(m.label)}</span>`;
    }).join('');
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">${pills}</div>`;
  }

  function _ensureModal(){
    if($('invReportsModal')) return;
    const html=`
<div class="modal-overlay" id="invReportsModal">
  <div class="modal-card lg" style="max-width:96vw;width:1200px">
    <div class="modal-head">
      <div class="modal-title"><span>📊</span> <span id="rep-modal-title">Reports</span></div>
      <button class="modal-close" onclick="invReportsClose()">&times;</button>
    </div>
    <div class="modal-body">
      <!-- HUB: report picker grid -->
      <div id="rep-hub">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
          <div style="position:relative;flex:1;min-width:200px;max-width:380px">
            <i class="fas fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text3,#80868B);font-size:12px"></i>
            <input id="rep-hub-search" type="text" autocomplete="off" placeholder="Search reports…"
              oninput="invReportsHubSearch(this.value)"
              style="width:100%;padding:9px 12px 9px 32px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;box-sizing:border-box">
          </div>
          <div id="rep-hub-filter" style="display:flex;gap:6px;flex-wrap:wrap">
            ${['all','user','auditor','accountant'].map(a=>{
              const lbl = a==='all'?'All':(a.charAt(0).toUpperCase()+a.slice(1));
              const active = a==='all'; // default
              return `<button type="button" class="rep-aud-chip${active?' is-active':''}" data-aud="${a}" onclick="invReportsHubFilter('${a}')"
                style="padding:7px 14px;border:1px solid var(--border,#e5e7eb);border-radius:99px;background:#fff;color:var(--text,#1F1F1F);font-size:12px;font-weight:600;cursor:pointer">${lbl}</button>`;
            }).join('')}
          </div>
        </div>
        <div id="rep-hub-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px"></div>
        <div id="rep-hub-empty" style="display:none;padding:24px;text-align:center;color:var(--text2,#5F6368);font-size:13px">No reports match your search.</div>
      </div>
      <!-- DETAIL: a chosen report's filters + output -->
      <div id="rep-detail" style="display:none">
        <button class="btn" onclick="invReportsBackToHub()" style="margin-bottom:12px"><i class="fas fa-arrow-left"></i> All reports</button>
        <div id="rep-toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border,rgba(0,0,0,.08))"></div>
        <div id="rep-output" style="overflow-x:auto"><div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Pick options and click Generate.</div></div>
      </div>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
    _renderHub();
  }

  function _renderHub(){
    const grid=$('rep-hub-grid'); if(!grid) return;
    const q=_hubQuery.trim().toLowerCase();
    const list=REPORTS.filter(r=>{
      if(_hubAud!=='all' && !(r.audience||[]).includes(_hubAud)) return false;
      if(q){
        const hay=(r.title+' '+r.desc).toLowerCase();
        if(hay.indexOf(q)===-1) return false;
      }
      return true;
    });
    grid.innerHTML=list.map(r=>`
      <div class="inv-stat-card ${r.cls}" onclick="invReportsPick('${r.id}')"
           style="cursor:pointer;min-height:112px;padding:14px;position:relative;display:flex;flex-direction:column">
        <div class="inv-stat-card-label"><i class="fas ${r.icon}"></i> ${esc(r.title)}</div>
        <div style="font-size:11.5px;color:var(--text2,#5F6368);margin-top:6px;line-height:1.35;flex:1">${esc(r.desc)}</div>
        ${_audiencePills(r.audience)}
        ${r.status==='soon'?'<span style="position:absolute;top:10px;right:10px;font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#F57C00;background:#FEF3E0;padding:2px 6px;border-radius:99px">soon</span>':''}
      </div>`).join('');
    const empty=$('rep-hub-empty'); if(empty) empty.style.display = list.length?'none':'';
  }

  window.invReportsHubSearch=function(v){ _hubQuery=v||''; _renderHub(); };
  window.invReportsHubFilter=function(a){
    _hubAud=a||'all';
    // toggle the active class — the gradient theme styles .is-active
    document.querySelectorAll('#rep-hub-filter .rep-aud-chip').forEach(btn=>{
      btn.classList.toggle('is-active', btn.getAttribute('data-aud')===_hubAud);
    });
    _renderHub();
  };

  function _showHub(){
    $('rep-hub').style.display='';
    $('rep-detail').style.display='none';
    $('rep-modal-title').textContent='Reports';
    // reset search + filter for a clean hub each time
    _hubQuery=''; _hubAud='all';
    const s=$('rep-hub-search'); if(s) s.value='';
    if(typeof window.invReportsHubFilter==='function') window.invReportsHubFilter('all');
  }
  function _showDetail(title){
    $('rep-hub').style.display='none';
    $('rep-detail').style.display='';
    $('rep-modal-title').textContent=title;
  }
  window.invReportsBackToHub=_showHub;

  window.invReportsPick=function(id){
    const r=REPORTS.find(x=>x.id===id); if(!r) return;
    if(r.status==='soon'){ toast(r.title+' — coming soon','info',2000); return; }
    _report=id;
    _showDetail(r.title);
    _buildToolbar(id);
  };

  // Builds the filter toolbar for the chosen report. For now only godown/group
  // are 'ready'; each new report will add its toolbar here as we build it.
  function _buildToolbar(id){
    const tb=$('rep-toolbar');
    const costToggle=`
      <div>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">Cost</label>
        <div style="display:flex;border:1px solid var(--border,#e5e7eb);border-radius:9px;overflow:hidden">
          <button type="button" id="rep-cost-without" onclick="invReportsCost(false)" style="padding:8px 13px;border:0;background:var(--blue,#1A73E8);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Without cost</button>
          <button type="button" id="rep-cost-with" onclick="invReportsCost(true)" style="padding:8px 13px;border:0;background:transparent;color:var(--text,#1F1F1F);font-size:12px;font-weight:600;cursor:pointer">With cost</button>
        </div>
      </div>`;
    const period=`
      <div><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">From</label>
        <input type="date" id="rep-from" style="padding:7px 10px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px"></div>
      <div><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">To</label>
        <input type="date" id="rep-to" style="padding:7px 10px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px"></div>`;
    const pickerLabel = (id==='godown') ? 'Godown' : ((id==='ledger'||id==='stockcard') ? 'Material' : (id==='audit' ? 'Audit Session' : (id==='batchtrace' ? 'Batch' : 'Group')));
    const picker=`
      <div id="rep-picker-wrap"><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">${pickerLabel}</label>
        <div id="rep-picker-mount" style="min-width:360px;max-width:520px"></div></div>`;
    // Box List: a status filter (searchable combo) controlling which boxes show.
    const boxStatus=`
      <div id="rep-boxstatus-wrap"><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">Status</label>
        <div id="rep-boxstatus-mount" style="min-width:200px;max-width:260px"></div></div>`;
    // Group-wise Stock: optional godown filter (scope the stock to one godown).
    const groupGodown=`
      <div id="rep-ggodown-wrap"><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">Godown</label>
        <div id="rep-ggodown-mount" style="min-width:240px;max-width:340px"></div></div>`;
    const daysLabel = (id==='expiry') ? 'Expiring in (days)' : 'Idle days ≥';
    const daysDefault = (id==='expiry') ? 60 : 90;
    const daysInput=`
      <div><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">${daysLabel}</label>
        <input type="number" id="rep-days" value="${daysDefault}" min="1" style="padding:7px 10px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;width:90px"></div>`;
    const showFilter=`
      <div><label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);margin-bottom:4px">Show</label>
        <div style="display:flex;border:1px solid var(--border,#e5e7eb);border-radius:9px;overflow:hidden">
          <button type="button" id="nz-both" onclick="invNzShow('both')" style="padding:8px 12px;border:0;background:var(--blue,#1A73E8);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Both</button>
          <button type="button" id="nz-neg" onclick="invNzShow('neg')" style="padding:8px 12px;border:0;background:transparent;color:var(--text,#1F1F1F);font-size:12px;font-weight:600;cursor:pointer">Negative</button>
          <button type="button" id="nz-zero" onclick="invNzShow('zero')" style="padding:8px 12px;border:0;background:transparent;color:var(--text,#1F1F1F);font-size:12px;font-weight:600;cursor:pointer">Zero</button>
        </div></div>`;
    const actions=`
      <button class="btn btn-primary" onclick="invReportsGenerate()"><i class="fas fa-play"></i> Generate</button>
      <button class="btn" id="rep-print-btn" onclick="invReportsPrint()" disabled><i class="fas fa-print"></i> Print</button>`;
    // Cost toggle for value-bearing reports. Period only for time-ranged reports.
    const showCost = (id==='godown' || id==='group' || id==='audit' || id==='nonmoving' || id==='expiry' || id==='negzero' || id==='reorder' || id==='grnreg' || id==='dnreg' || id==='stockcard' || id==='boxlist' || id==='ageing' || id==='batchtrace');
    const showPeriod = (id==='godown' || id==='group' || id==='ledger' || id==='grnreg' || id==='dnreg' || id==='trreg' || id==='stockcard');
    // stockcard needs a material picker (required); boxlist's picker is optional (godown).
    const showPicker = (id==='godown' || id==='group' || id==='ledger' || id==='audit' || id==='stockcard' || id==='batchtrace');
    const showDays = (id==='nonmoving' || id==='expiry');
    const showShowFilter = (id==='negzero');
    const showBoxStatus = (id==='boxlist');
    const showGroupGodown = (id==='group');
    tb.innerHTML = (showPicker?picker:'') + (showGroupGodown?groupGodown:'') + (showBoxStatus?boxStatus:'') + (showDays?daysInput:'') + (showShowFilter?showFilter:'') + (showPeriod?period:'') + (showCost?costToggle:'') + actions;
    // default period = current month
    const now=new Date(); const first=new Date(now.getFullYear(), now.getMonth(), 1);
    const iso=(d)=>d.toISOString().slice(0,10);
    if($('rep-from')) $('rep-from').value=iso(first);
    if($('rep-to')) $('rep-to').value=iso(now);
    if(showCost) invReportsCost(false);
    if(showPicker) _populatePicker(id);
    if(showGroupGodown) _populateGroupGodown();
    if(showBoxStatus) _populateBoxStatus();
    $('rep-output').innerHTML='<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Pick options and click Generate.</div>';
  }

  let _pickerCombo=null, _pickerValue='';
  async function _populatePicker(id){
    const mount=$('rep-picker-mount'); if(!mount) return;
    _pickerValue='';
    mount.innerHTML='<div style="padding:8px 11px;color:var(--text3,#80868B);font-size:13px">Loading…</div>';
    let opts=[], placeholder='Search & select…';
    try {
      if(id==='godown'){
        const j=await _api('/api/inventory_mgmt/reports/godowns');
        opts=(j.godowns||[]).map(g=>({value:String(g.id), label:(g.name||'')+(g.is_default?' (default)':'')}));
        placeholder='Search godown…';
      } else if(id==='group'){
        const j=await _api('/api/inventory_mgmt/reports/groups');
        opts=[{value:'all', label:'— All Groups (all stock) —'}].concat(
          (j.groups||[]).map(g=>({value:String(g.id), label:g.group_name||''})));
        placeholder='Search group…';
      } else if(id==='ledger' || id==='stockcard'){
        const j=await _api('/api/inventory_mgmt/reports/material_search');
        opts=(j.materials||[]).map(g=>({value:String(g.id), label:g.name||''}));
        placeholder='Search material…';
      } else if(id==='audit'){
        const j=await _api('/api/inventory_mgmt/reports/audit_sessions');
        opts=(j.sessions||[]).map(s=>({value:String(s.id),
          label:`${s.session_no} · ${s.godown_name} · ${s.status}`}));
        placeholder='Search audit session…';
      } else if(id==='batchtrace'){
        const j=await _api('/api/inventory_mgmt/reports/batch_search');
        opts=(j.batches||[]).map(b=>({value:b.batch,
          label:`${b.batch} · ${b.material||''} (${b.box_count} box${b.box_count===1?'':'es'})`}));
        placeholder='Search batch…';
      }
    } catch(e){ mount.innerHTML='<div style="padding:8px 11px;color:#C5221F;font-size:12px">'+esc(e.message)+'</div>'; return; }
    mount.innerHTML='';
    if(!window.invCombo){ // fallback to a select if combo missing
      const sel=document.createElement('select'); sel.id='rep-picker';
      sel.style.cssText='padding:8px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;min-width:240px';
      sel.innerHTML='<option value="">Select…</option>'+opts.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
      sel.onchange=()=>{ _pickerValue=sel.value; };
      mount.appendChild(sel); return;
    }
    _pickerCombo=window.invCombo({
      mount, placeholder, options:opts,
      onChange:(val)=>{ _pickerValue=val||''; }
    });
  }
  function _pickerGet(){
    if(_pickerCombo && _pickerCombo.getValue) return _pickerCombo.getValue() || _pickerValue;
    const sel=$('rep-picker'); return sel ? sel.value : _pickerValue;
  }

  // Box List status filter — a searchable combo of rm_boxes statuses.
  let _boxStatusCombo=null, _boxStatusValue='in_stock';
  function _populateBoxStatus(){
    const mount=$('rep-boxstatus-mount'); if(!mount) return;
    _boxStatusValue='in_stock';
    const opts=[
      {value:'in_stock',   label:'In Stock'},
      {value:'in_transit', label:'In Transit'},
      {value:'consumed',   label:'Consumed'},
      {value:'damaged',    label:'Damaged'},
      {value:'lost',       label:'Lost'},
      {value:'cancelled',  label:'Cancelled'},
      {value:'all',        label:'— All statuses —'},
    ];
    mount.innerHTML='';
    if(!window.invCombo){
      const sel=document.createElement('select'); sel.id='rep-boxstatus';
      sel.style.cssText='padding:8px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;min-width:180px';
      sel.innerHTML=opts.map(o=>`<option value="${esc(o.value)}"${o.value==='in_stock'?' selected':''}>${esc(o.label)}</option>`).join('');
      sel.onchange=()=>{ _boxStatusValue=sel.value; };
      mount.appendChild(sel); return;
    }
    _boxStatusCombo=window.invCombo({
      mount, placeholder:'Search status…', options:opts, value:'in_stock',
      onChange:(val)=>{ _boxStatusValue=val||'in_stock'; }
    });
  }
  function _boxStatusGet(){
    if(_boxStatusCombo && _boxStatusCombo.getValue) return _boxStatusCombo.getValue() || _boxStatusValue;
    const sel=$('rep-boxstatus'); return sel ? sel.value : _boxStatusValue;
  }

  // Group-wise Stock — optional godown filter (searchable combo of godowns).
  let _gGodownCombo=null, _gGodownValue='';
  async function _populateGroupGodown(){
    const mount=$('rep-ggodown-mount'); if(!mount) return;
    _gGodownValue='';
    mount.innerHTML='<div style="padding:8px 11px;color:var(--text3,#80868B);font-size:13px">Loading…</div>';
    let opts=[{value:'', label:'— All Godowns —'}];
    try {
      const j=await _api('/api/inventory_mgmt/reports/godowns');
      opts=opts.concat((j.godowns||[]).map(g=>({value:String(g.id), label:(g.name||'')+(g.is_default?' (default)':'')})));
    } catch(e){ mount.innerHTML='<div style="padding:8px 11px;color:#C5221F;font-size:12px">'+esc(e.message)+'</div>'; return; }
    mount.innerHTML='';
    if(!window.invCombo){
      const sel=document.createElement('select'); sel.id='rep-ggodown';
      sel.style.cssText='padding:8px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;min-width:220px';
      sel.innerHTML=opts.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
      sel.onchange=()=>{ _gGodownValue=sel.value; };
      mount.appendChild(sel); return;
    }
    _gGodownCombo=window.invCombo({
      mount, placeholder:'Search godown…', options:opts, value:'',
      onChange:(val)=>{ _gGodownValue=val||''; }
    });
  }
  function _gGodownGet(){
    if(_gGodownCombo && _gGodownCombo.getValue) return _gGodownCombo.getValue() || _gGodownValue;
    const sel=$('rep-ggodown'); return sel ? sel.value : _gGodownValue;
  }

  async function openReports(){
    try {
      _ensureModal();
      const ov=$('invReportsModal');
      ov.classList.add('show');
      // Safety: clicking the dimmed backdrop or pressing Esc always closes,
      // so a render hiccup can never leave the screen stuck behind an overlay.
      if(!ov._dismissWired){
        ov._dismissWired=true;
        ov.addEventListener('mousedown',(e)=>{ if(e.target===ov) invReportsClose(); });
        document.addEventListener('keydown',(e)=>{ if(e.key==='Escape' && ov.classList.contains('show')) invReportsClose(); });
      }
      _showHub();
    } catch(err){
      console.error('[reports] openReports failed:', err);
      try { $('invReportsModal')?.classList.remove('show'); } catch(e){}
      toast('Could not open Reports — see console','error');
    }
  }
  window.invReportsClose=()=>$('invReportsModal')?.classList.remove('show');

  let _nzShow='both';
  window.invNzShow=function(which){
    _nzShow=which;
    [['both','nz-both'],['neg','nz-neg'],['zero','nz-zero']].forEach(([w,id])=>{
      const b=$(id); if(!b) return;
      const on=(w===which);
      b.style.background=on?'var(--blue,#1A73E8)':'transparent';
      b.style.color=on?'#fff':'var(--text,#1F1F1F)';
    });
  };

  // Open the underlying voucher from a register row. Closes the reports modal,
  // switches to the voucher's own panel/view (so its form elements exist), then
  // opens the specific voucher.
  window.invReportsOpenVoucher=function(kind,id){
    try { invReportsClose(); } catch(e){}
    // Switch to the right sidebar panel first — opening the form into a hidden
    // panel silently no-ops, which looks like "nothing happened".
    function gotoPanel(panel){
      try {
        if(window.invSwitchPanel){ window.invSwitchPanel(panel); return; }
        var nav=document.querySelector('.inv-nav-item[data-panel="'+panel+'"]');
        if(nav) nav.click();
      } catch(e){}
    }
    if(kind==='grn'){
      gotoPanel('grn');
      // give the panel a moment to render its list/form panes, then open.
      setTimeout(function(){ try { if(window.invGrnOpenById) window.invGrnOpenById(id); } catch(e){ toast('Could not open GRN: '+e.message,'error'); } }, 350);
    } else if(kind==='dn'){
      setTimeout(function(){ try { if(window.invDnOpenDetail) window.invDnOpenDetail(id); else toast('Delivery Note view unavailable','error'); } catch(e){ toast('Could not open DN: '+e.message,'error'); } }, 250);
    } else {
      toast('Cannot open this voucher here','error');
    }
  };

  // Clicking a material name in the Expiry/FEFO report jumps to where that
  // batch's expiry was recorded: the GRN form for GRN boxes, or the Opening
  // Stock entry's edit form for opening-stock boxes.
  window.invRepExpiryOpen=function(i){
    var items = window._invRepExpiryItems || [];
    var it = items[i];
    if(!it){ toast('Could not resolve that row','error'); return; }
    if(it.source==='grn' && it.grn_id){
      // Reuse the existing voucher opener (closes modal, switches panel, opens GRN).
      window.invReportsOpenVoucher('grn', it.grn_id);
      return;
    }
    // Opening-stock batch → open its opening-stock entry by box ids.
    try { invReportsClose(); } catch(e){}
    if(window.invOpOpenEntryByBoxIds && (it.box_ids||[]).length){
      setTimeout(function(){ window.invOpOpenEntryByBoxIds(it.box_ids); }, 250);
    } else if(it.grn_id){
      window.invReportsOpenVoucher('grn', it.grn_id);
    } else {
      toast('No source entry recorded for this batch','warn');
    }
  };

  window.invReportsCost=function(on){
    _withCost=!!on;
    const w=$('rep-cost-with'), wo=$('rep-cost-without');
    if(!w||!wo) return;
    w.style.background = on?'var(--blue,#1A73E8)':'transparent';
    w.style.color = on?'#fff':'var(--text,#1F1F1F)';
    wo.style.background = on?'transparent':'var(--blue,#1A73E8)';
    wo.style.color = on?'var(--text,#1F1F1F)':'#fff';
  };

  window.invReportsGenerate=async function(){
    // stockcard requires a material; boxlist/ageing/abc need no picker.
    const needsPicker = (_report==='godown' || _report==='group' || _report==='ledger' || _report==='audit' || _report==='stockcard' || _report==='batchtrace');
    const id = needsPicker ? _pickerGet() : '';
    if(needsPicker && !id){ toast('Please make a selection','error'); return; }
    const out=$('rep-output');
    out.innerHTML='<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Generating…</div>';
    try {
      const df=$('rep-from')?.value||'', dt=$('rep-to')?.value||'';
      const period=`&from=${encodeURIComponent(df)}&to=${encodeURIComponent(dt)}`;
      let url;
      if(_report==='godown') url=`/api/inventory_mgmt/reports/godown_stock?godown_id=${id}&with_cost=${_withCost?1:0}${period}`;
      else if(_report==='group'){ const gg=_gGodownGet(); url=`/api/inventory_mgmt/reports/group_stock?group_id=${id}&with_cost=${_withCost?1:0}${period}`+(gg?`&godown_id=${encodeURIComponent(gg)}`:''); }
      else if(_report==='ledger') url=`/api/inventory_mgmt/reports/movement_ledger?material_id=${id}${period}`;
      else if(_report==='audit') url=`/api/inventory_mgmt/reports/audit_variance?session_id=${id}&with_cost=${_withCost?1:0}`;
      else if(_report==='nonmoving'){ const dys=$('rep-days')?.value||90; url=`/api/inventory_mgmt/reports/non_moving?days=${dys}&with_cost=${_withCost?1:0}`; }
      else if(_report==='expiry'){ const dys=$('rep-days')?.value||60; url=`/api/inventory_mgmt/reports/expiry?days=${dys}&with_cost=${_withCost?1:0}`; }
      else if(_report==='negzero'){ url=`/api/inventory_mgmt/reports/neg_zero?show=${_nzShow}&with_cost=${_withCost?1:0}`; }
      else if(_report==='reorder'){ url=`/api/inventory_mgmt/reports/reorder?with_cost=${_withCost?1:0}`; }
      else if(_report==='grnreg'){ url=`/api/inventory_mgmt/reports/grn_register?with_cost=${_withCost?1:0}${period}`; }
      else if(_report==='dnreg'){ url=`/api/inventory_mgmt/reports/dn_register?with_cost=${_withCost?1:0}${period}`; }
      else if(_report==='trreg'){ url=`/api/inventory_mgmt/reports/transfer_register?${period.slice(1)}`; }
      else if(_report==='stockcard') url=`/api/inventory_mgmt/reports/stock_card?material_id=${id}&with_cost=${_withCost?1:0}${period}`;
      else if(_report==='boxlist') url=`/api/inventory_mgmt/reports/box_list?status=${encodeURIComponent(_boxStatusGet())}&with_cost=${_withCost?1:0}`;
      else if(_report==='ageing') url=`/api/inventory_mgmt/reports/ageing?with_cost=${_withCost?1:0}`;
      else if(_report==='abc') url=`/api/inventory_mgmt/reports/abc`;
      else if(_report==='batchtrace') url=`/api/inventory_mgmt/reports/batch_trace?batch=${encodeURIComponent(id)}&with_cost=${_withCost?1:0}`;
      const j=await _api(url);
      _lastData=j;
      out.innerHTML = (j.report==='movement_ledger') ? _renderLedger(j)
        : (j.report==='audit_variance') ? _renderAudit(j)
        : (j.report==='non_moving') ? _renderNonMoving(j)
        : (j.report==='expiry') ? _renderExpiry(j)
        : (j.report==='neg_zero') ? _renderNegZero(j)
        : (j.report==='reorder') ? _renderReorder(j)
        : (j.report==='grn_register') ? _renderGrnReg(j)
        : (j.report==='dn_register') ? _renderDnReg(j)
        : (j.report==='transfer_register') ? _renderTrReg(j)
        : (j.report==='stock_card') ? _renderStockCard(j)
        : (j.report==='box_list') ? _renderBoxList(j)
        : (j.report==='ageing') ? _renderAgeing(j)
        : (j.report==='abc') ? _renderAbc(j)
        : (j.report==='batch_trace') ? _renderBatchTrace(j)
        : _renderReport(j);
      $('rep-print-btn').disabled=false;
    } catch(e){ out.innerHTML=`<div style="padding:20px;color:#C5221F">${esc(e.message)}</div>`; }
  };

  function _renderTrReg(j){
    const cols=['#','Type','Voucher No','Date','From','To','Status','Boxes','Qty'];
    const rows=(j.items||[]).map((it,i)=>{
      const statusColor = it.status==='received'?'#137333':(it.status==='cancelled'?'#C5221F':'#F57C00');
      const cells=[i+1, esc(it.type), esc(it.voucher_no), esc(fmtDate(it.date)), esc(it.from||'—'), esc(it.to||'—'),
        `<span style="color:${statusColor};font-weight:600">${esc(it.status)}</span>`, it.boxes, nf(it.qty)];
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=7?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=7?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow=`<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="7" style="padding:9px 9px;text-align:right">TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${j.total_boxes}</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(j.total_qty)}</td></tr>`;
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Transfer Register</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(fmtDate(j.from))} → ${esc(fmtDate(j.to))} · ${j.item_count} transfers</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No transfers in this period.</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderDnReg(j){
    const wc=j.with_cost;
    const cols=['#','DN No','Date','To (Supplier)','Reason','Status','Lines','Total Qty'].concat(wc?['Value']:[]);
    const colspan=cols.length;
    const rows=(j.items||[]).map((it,i)=>{
      const statusPill = it.status==='cancelled'
        ? '<span style="color:#fff;background:#C5221F;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700">CANCELLED</span>'
        : '<span style="color:#137333">issued</span>';
      const dnLink = `<a href="#" onclick="invReportsOpenVoucher('dn',${it.id});return false" style="color:var(--blue,#1A73E8);text-decoration:none;font-weight:600" title="Open this Delivery Note">${esc(it.dn_no)}</a>`;
      const cells=[i+1, dnLink, esc(fmtDate(it.dn_date)), esc(it.supplier||'—'), esc(it.reason||'—'),
        statusPill, it.line_count, nf(it.total_qty)].concat(wc?[money(it.dn_value)]:[]);
      const headRow=`<tr style="background:var(--bg,#FAF9F5);${it.status==='cancelled'?'opacity:.6':''}">`+cells.map((c,ci)=>`<td style="padding:7px 9px;font-size:11.5px;font-weight:600;border-top:2px solid var(--border,rgba(0,0,0,.1));${ci>=6?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
      const liCols=['Material','UOM','Boxes','Qty'].concat(wc?['Rate','Amount']:[]);
      const liWidths = wc ? ['40%','8%','12%','12%','14%','14%'] : ['54%','12%','16%','18%'];
      const subHead=`<tr><td colspan="${colspan}" style="padding:0 9px 8px 28px;border-top:0">
        <table style="width:100%;border-collapse:collapse;table-layout:fixed">
          <colgroup>${liWidths.map(w=>`<col style="width:${w}">`).join('')}</colgroup>
          <thead><tr>${liCols.map((h,hi)=>`<th style="padding:3px 8px;font-size:8.5px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);text-align:${hi>=1?'right':'left'};border-bottom:1px solid var(--border,rgba(0,0,0,.08))">${h}</th>`).join('')}</tr></thead>
          <tbody>${(it.lines||[]).map(li=>{
            const lc=[esc(li.material), esc(li.uom), li.boxes, nf(li.qty)].concat(wc?[money(li.rate),money(li.amount)]:[]);
            return '<tr>'+lc.map((v,vi)=>`<td style="padding:3px 8px;font-size:11px;color:var(--text2,#5F6368);${vi>=1?'text-align:right;font-family:var(--font-mono,monospace)':''};${vi===0?'white-space:nowrap;overflow:hidden;text-overflow:ellipsis':''}">${v}</td>`).join('')+'</tr>';
          }).join('')}</tbody>
        </table></td></tr>`;
      return headRow+subHead;
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=6?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow = wc ? `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="8" style="padding:9px 9px;text-align:right">GRAND TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.grand_value)}</td></tr>` : '';
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Delivery Register</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(fmtDate(j.from))} → ${esc(fmtDate(j.to))} · ${j.item_count} delivery notes</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${colspan}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No deliveries in this period.</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderGrnReg(j){
    const wc=j.with_cost;
    const cols=['#','GRN No','Date','Supplier','Invoice','Lines','Total Qty'].concat(wc?['Value']:[]);
    const colspan = cols.length;
    const rows=(j.items||[]).map((it,i)=>{
      const grnLink = `<a href="#" onclick="invReportsOpenVoucher('grn',${it.id});return false" style="color:var(--blue,#1A73E8);text-decoration:none;font-weight:600" title="Open this GRN">${esc(it.grn_num)}</a>`;
      const cells=[i+1, grnLink, esc(fmtDate(it.grn_date)), esc(it.supplier), esc(it.invoice_num||'—'),
        it.line_count, nf(it.total_qty)].concat(wc?[money(it.total_value)]:[]);
      const headRow='<tr style="background:var(--bg,#FAF9F5)">'+cells.map((c,ci)=>`<td style="padding:7px 9px;font-size:11.5px;font-weight:600;border-top:2px solid var(--border,rgba(0,0,0,.1));${ci>=5?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
      // item sub-rows
      const liCols = ['Material','Batch','UOM','Qty'].concat(wc?['Rate','Amount']:[]);
      const liWidths = wc ? ['34%','22%','8%','12%','12%','12%'] : ['46%','30%','10%','14%'];
      const subHead = `<tr><td colspan="${colspan}" style="padding:0 9px 8px 28px;border-top:0">
        <table style="width:100%;border-collapse:collapse;table-layout:fixed">
          <colgroup>${liWidths.map(w=>`<col style="width:${w}">`).join('')}</colgroup>
          <thead><tr>${liCols.map((h,hi)=>`<th style="padding:3px 8px;font-size:8.5px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);text-align:${hi>=2?'right':'left'};border-bottom:1px solid var(--border,rgba(0,0,0,.08))">${h}</th>`).join('')}</tr></thead>
          <tbody>${(it.lines||[]).map(li=>{
            const lc=[esc(li.material), esc(li.batch||'—'), esc(li.uom), nf(li.qty)].concat(wc?[money(li.rate),money(li.amount)]:[]);
            return '<tr>'+lc.map((v,vi)=>`<td style="padding:3px 8px;font-size:11px;color:var(--text2,#5F6368);${vi>=2?'text-align:right;font-family:var(--font-mono,monospace)':''};${vi===0?'white-space:nowrap;overflow:hidden;text-overflow:ellipsis':''}">${v}</td>`).join('')+'</tr>';
          }).join('')}</tbody>
        </table></td></tr>`;
      return headRow+subHead;
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=5?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow = wc ? `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="7" style="padding:9px 9px;text-align:right">GRAND TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.grand_value)}</td></tr>` : '';
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">GRN Register</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(fmtDate(j.from))} → ${esc(fmtDate(j.to))} · ${j.item_count} GRNs</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${colspan}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No GRNs in this period.</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderReorder(j){
    const wc=j.with_cost;
    const cols=['#','Material','Group','Supplier','UOM','Stock','MSL','To Order'].concat(wc?['Rate','Order Value']:[]);
    const rows=(j.items||[]).map((it,i)=>{
      const cells=[i+1, esc(it.name), esc(it.group||''), esc(it.supplier||'—'), esc(it.uom),
        `<span style="${it.is_zero?'color:#C5221F;font-weight:700':''}">${nf(it.qty)}</span>`,
        nf(it.msl),
        `<span style="color:#C5221F;font-weight:700">${nf(it.shortfall)}</span>`].concat(wc?[money(it.rate),money(it.order_value)]:[]);
      return `<tr style="${it.is_zero?'background:#FEF1F0':''}">`+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=5?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=5?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow = wc ? `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="9" style="padding:9px 9px;text-align:right">TOTAL ORDER VALUE</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_shortfall_value)}</td></tr>` : '';
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Reorder Report — items at / below MSL</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${j.item_count} to reorder${j.zero_count?` · <span style="color:#C5221F">${j.zero_count} out of stock</span>`:''}</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">Everything is at or above MSL. 🎉</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderNegZero(j){
    const wc=j.with_cost;
    const cols=['#','Material','Group','UOM','Stock','MSL','Flag'].concat(wc?['Rate','Value']:[]);
    const rows=(j.items||[]).map((it,i)=>{
      const flag = it.bucket==='negative'
        ? `<span style="color:#fff;background:#C5221F;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700">NEGATIVE</span>`
        : `<span style="color:#8a5200;background:#FEF3E0;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700">ZERO</span>`;
      const cells=[i+1, esc(it.name), esc(it.group||''), esc(it.uom), nf(it.qty), (it.msl?nf(it.msl):'—'), flag].concat(wc?[money(it.rate),money(it.value)]:[]);
      return `<tr style="${it.bucket==='negative'?'background:#FEF1F0':''}">`+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${(ci>=4&&ci<=5)||ci>=7?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${(i>=4&&i<=5)||i>=7?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Negative / Zero Stock</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)"><span style="color:#C5221F">${j.neg_count} negative</span> · <span style="color:#8a5200">${j.zero_count} zero</span></div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No negative or zero-stock issues. 🎉</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  function _renderExpiry(j){
    const wc=j.with_cost;
    // Stash items so the clickable name can resolve its navigation target.
    window._invRepExpiryItems = j.items || [];
    const cols=['#','Material','Group','Batch','UOM','Boxes','Stock','Expiry','Days Left'].concat(wc?['Rate','Value']:[]);
    const rows=(j.items||[]).map((it,i)=>{
      const dl = it.expired
        ? `<span style="color:#fff;background:#C5221F;padding:1px 7px;border-radius:99px;font-size:10.5px;font-weight:700">EXPIRED</span>`
        : (it.days_left<=14
            ? `<span style="color:#C5221F;font-weight:700">${it.days_left}d</span>`
            : `<span style="color:#F57C00;font-weight:600">${it.days_left}d</span>`);
      // Clickable material name → jump to where this batch's expiry was set
      // (the GRN for GRN boxes, or the Opening Stock entry for opening boxes).
      const nameCell = `<a href="#" onclick="invRepExpiryOpen(${i});return false" `
        + `title="Open the ${it.source==='grn'?'GRN':'Opening Stock entry'} where this expiry was recorded" `
        + `style="color:var(--blue,#1A73E8);text-decoration:none;font-weight:600;cursor:pointer">`
        + `${esc(it.name)}</a>`;
      const cells=[i+1, nameCell, esc(it.group||''), esc(it.batch||'—'), esc(it.uom),
        it.box_count, nf(it.qty), esc(fmtDate(it.expiry)), dl].concat(wc?[money(it.rate),money(it.value)]:[]);
      const numFrom=5;
      return `<tr style="${it.expired?'background:#FEF1F0':''}">`+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=numFrom?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=5?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow=`<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="6" style="padding:9px 9px;text-align:right">TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf(j.total_qty)}</td>
      <td></td><td></td>
      ${wc?`<td></td><td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_value)}</td>`:''}
    </tr>`;
    const expiredNote = j.expired_count ? `<span style="color:#C5221F;font-weight:600"> · ${j.expired_count} already expired</span>` : '';
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Expiry / FEFO — within ${j.days} days</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${j.item_count} batches${expiredNote}</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">Nothing expiring in this window. 🎉</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderNonMoving(j){
    const wc=j.with_cost;
    const cols=['#','Material','Group','UOM','Stock','Last Out','Idle Days'].concat(wc?['Rate','Value']:[]);
    const rows=(j.items||[]).map((it,i)=>{
      const idle = it.idle_days==null ? '<span style="color:#C5221F;font-weight:600">never moved</span>' : (it.idle_days+'d');
      const cells=[i+1, esc(it.name), esc(it.group||''), esc(it.uom), nf(it.qty),
        (it.last_out?esc(fmtDate(it.last_out)):'—'), idle].concat(wc?[money(it.rate),money(it.value)]:[]);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=4?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=4?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow = `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="4" style="padding:9px 9px;text-align:right">TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf(j.total_qty)}</td>
      <td></td><td></td>
      ${wc?`<td></td><td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_value)}</td>`:''}
    </tr>`;
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Non-Moving Stock — no outward in ${j.days}+ days</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${j.item_count} items</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No non-moving stock — everything moved recently. 🎉</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderLedger(j){
    const mt=(t)=>({grn_create:'GRN',opening:'Opening',in:'Transfer In',adjust:'Adjust',out:'Out',consume:'Consume',cancel:'Cancel'}[t]||t);
    const rows=(j.lines||[]).map((L,i)=>`
      <tr>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));white-space:nowrap">${esc(fmtDate(L.date))}</td>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));white-space:nowrap">${esc(mt(L.type))}</td>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06))">${esc(L.godown)}</td>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));text-align:right;font-family:var(--font-mono,monospace);color:#137333;white-space:nowrap">${L.in?nf(L.in):''}</td>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));text-align:right;font-family:var(--font-mono,monospace);color:#C5221F;white-space:nowrap">${L.out?nf(L.out):''}</td>
        <td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));text-align:right;font-family:var(--font-mono,monospace);font-weight:600;white-space:nowrap">${nf(L.balance)}</td>
        <td style="padding:6px 9px;font-size:11px;border-top:1px solid var(--border,rgba(0,0,0,.06));color:var(--text2,#5F6368)">${esc(L.remarks)}</td>
      </tr>`).join('');
    const head=['Date','Type','Godown','In','Out','Balance','Remarks']
      .map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${(i>=3&&i<=5)?'right':'left'}">${c}</th>`).join('');
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Movement Ledger — ${esc(j.material.name)}</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(fmtDate(j.from))} → ${esc(fmtDate(j.to))} · ${j.line_count} movements</div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:10px;font-size:12px">
          <span>Opening: <b style="font-family:var(--font-mono,monospace)">${nf(j.opening)} ${esc(j.material.uom)}</b></span>
          <span style="color:#137333">In: <b style="font-family:var(--font-mono,monospace)">${nf(j.total_in)}</b></span>
          <span style="color:#C5221F">Out: <b style="font-family:var(--font-mono,monospace)">${nf(j.total_out)}</b></span>
          <span>Closing: <b style="font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(j.closing)} ${esc(j.material.uom)}</b></span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No movements in this period.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  function _renderAudit(j){
    const wc=j.with_cost;
    const c=j.counts||{};
    const chip=(label,val,color)=>`<span style="font-size:12px">${label}: <b style="font-family:var(--font-mono,monospace);color:${color||'inherit'}">${val}</b></span>`;
    const cols=['Material','Exp Box','Cnt Box','Var Box','Exp Qty','Cnt Qty','Var Qty'].concat(wc?['Rate','Var Value']:[]);
    const rows=(j.items||[]).map(it=>{
      const vb=it.var_box, vq=it.var_qty;
      const vbColor = vb===0?'inherit':(vb>0?'#137333':'#C5221F');
      const vqColor = vq===0?'inherit':(vq>0?'#137333':'#C5221F');
      const cells=[esc(it.name), it.exp_box, it.cnt_box,
        `<span style="color:${vbColor};font-weight:600">${vb>0?'+':''}${vb}</span>`,
        nf(it.exp_qty), nf(it.cnt_qty),
        `<span style="color:${vqColor};font-weight:600">${vq>0?'+':''}${nf(vq)}</span>`]
        .concat(wc?[money(it.rate), `<span style="color:${vqColor}">${money(it.var_value)}</span>`]:[]);
      return '<tr>'+cells.map((v,i)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${i>=1?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${v}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c2,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=1?'right':'left'};white-space:nowrap">${c2}</th>`).join('');
    const missList = (j.missing||[]).length ? `<div style="margin-top:10px;font-size:11.5px"><b style="color:#C5221F">Missing boxes (${j.missing.length}):</b> <span style="font-family:var(--font-mono,monospace)">${j.missing.map(esc).join(', ')}</span></div>` : '';
    const extraList = (j.extra||[]).length ? `<div style="margin-top:6px;font-size:11.5px"><b style="color:#137333">Extra boxes (${j.extra.length}):</b> <span style="font-family:var(--font-mono,monospace)">${j.extra.map(esc).join(', ')}</span></div>` : '';
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Audit Variance — ${esc(j.session.session_no)}</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(j.session.godown)} · ${esc(j.session.status)}${j.session.settled_at?(' · settled '+esc(fmtDate(j.session.settled_at))):''}</div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:10px;flex-wrap:wrap">
          ${chip('Expected boxes',c.expected_boxes)}
          ${chip('Counted boxes',c.counted_boxes)}
          ${chip('Missing',c.missing_boxes,'#C5221F')}
          ${chip('Extra',c.extra_boxes,'#137333')}
          ${wc?chip('Variance value',money(j.total_var_value),(j.total_var_value<0?'#C5221F':'#137333')):''}
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No materials in this audit.</td></tr>`}</tbody>
        </table>
        ${missList}${extraList}
      </div>`;
  }

  function _renderReport(j){
    const wc=j.with_cost;
    const isG = j.report==='godown_stock';
    const title = isG
      ? `Godown-wise Stock Summary — ${esc(j.godown.name)}`
      : `Group-wise Stock Summary — ${esc(j.group.name)}${j.godown&&j.godown.name?` @ ${esc(j.godown.name)}`:''}`;
    // columns: #, Material, [Group], UOM, Opening, Inward, Outward, Closing, [Rate, Value]
    const lead = isG ? ['#','Material','Group','UOM'] : ['#','Material','UOM'];
    const cols = lead.concat(['Opening','Inward','Outward','Closing']).concat(wc?['Rate','Value']:[]);
    const leadLen = lead.length;  // first right-aligned numeric col index
    const rows=(j.items||[]).map((it,i)=>{
      const lc = isG ? [i+1, esc(it.name), esc(it.group||''), esc(it.uom)] : [i+1, esc(it.name), esc(it.uom)];
      const nums = [nf(it.opening), nf(it.inward), nf(it.outward), `<b>${nf(it.closing)}</b>`].concat(wc?[money(it.rate),money(it.value)]:[]);
      const cells = lc.concat(nums);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:12px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=leadLen?'text-align:right;font-family:var(--font-mono,monospace)':''}">${c}</td>`).join('')+'</tr>';
    }).join('');
    const t=j.totals||{opening:0,inward:0,outward:0,closing:0};
    const totalRow = `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="${leadLen}" style="padding:9px 9px;text-align:right;font-size:12px">TOTAL</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf(t.opening)}</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf(t.inward)}</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf(t.outward)}</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(t.closing)}</td>
      ${wc?`<td></td><td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_value)}</td>`:''}
    </tr>`;
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">${title}</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(fmtDate(j.from||''))} → ${esc(fmtDate(j.to||''))} · ${j.item_count} items</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${cols.map((c,ci)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${ci>=leadLen?'right':'left'}">${c}</th>`).join('')}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No movement in this period.</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderStockCard(j){
    const wc=j.with_cost, m=j.material||{}, L=j.ledger||{};
    const cols=['#','Godown','Boxes','Qty'].concat(wc?['Value']:[]);
    const rows=(j.locations||[]).map((loc,i)=>{
      const cells=[i+1, esc(loc.godown), loc.box_count, nf(loc.qty)].concat(wc?[money(loc.value)]:[]);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=2?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=2?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const totalRow=`<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="2" style="padding:9px 9px;text-align:right">TOTAL (in stock)</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${j.total_boxes}</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(j.total_qty)}</td>
      ${wc?`<td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_value)}</td>`:''}</tr>`;
    const chip=(label,val,color)=>`<span style="font-size:12px">${label}: <b style="font-family:var(--font-mono,monospace);color:${color||'inherit'}">${val}</b></span>`;
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Item Stock Card — ${esc(m.name)}</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc(m.group||'')}${m.group?' · ':''}UOM ${esc(m.uom||'')} · MSL ${nf(m.msl)}</div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:10px;flex-wrap:wrap">
          ${chip('Opening',nf(L.opening))}
          ${chip('Inward',nf(L.inward),'#137333')}
          ${chip('Outward',nf(L.outward),'#C5221F')}
          ${chip('Closing (ledger)',nf(L.closing),'#1A73E8')}
          <span style="font-size:11px;color:var(--text3,#80868B)">${esc(fmtDate(j.from))} → ${esc(fmtDate(j.to))}</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No in-stock boxes for this material.</td></tr>`}</tbody>
          <tfoot>${(j.locations||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderBoxList(j){
    _boxListQuery=''; // reset search each time the report is regenerated
    const wc=j.with_cost;
    const cols=['#','Box Code','Material','Status','Godown','Batch','Expiry','GRN','Created','UOM','Qty'].concat(wc?['Rate','Value']:[]);
    const search=`
      <div style="margin-bottom:10px">
        <div style="position:relative;max-width:360px">
          <i class="fas fa-magnifying-glass" style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text3,#80868B);font-size:12px"></i>
          <input id="rep-boxlist-search" type="text" autocomplete="off" placeholder="Search box code, material, godown, batch, GRN…"
            oninput="invBoxListSearch(this.value)"
            style="width:100%;padding:8px 11px 8px 30px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;box-sizing:border-box">
        </div>
      </div>`;
    return `
      ${search}
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Box List</div>
          <div id="rep-boxlist-meta" style="font-size:11px;color:var(--text2,#5F6368)">Status: ${esc(j.status_filter)} · ${j.item_count} boxes</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${_boxListHead(cols,wc)}</tr></thead>
          <tbody id="rep-boxlist-body">${_boxListBody(j.items||[],wc,cols.length)}</tbody>
          <tfoot id="rep-boxlist-foot">${_boxListFoot(j.items||[],wc)}</tfoot>
        </table>
      </div>`;
  }
  function _boxListHead(cols,wc){
    const firstNum=10;
    return cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=firstNum?'right':'left'};white-space:nowrap">${c}</th>`).join('');
  }
  function _boxListBody(items,wc,colCount){
    const firstNum=10;
    const statusColor=(s)=> s==='in_stock'?'#137333':(s==='in_transit'?'#F57C00':(s==='consumed'?'#5F6368':'#C5221F'));
    const rows=items.map((it,i)=>{
      const cells=[i+1, `<span style="font-family:var(--font-mono,monospace)">${esc(it.box_code)}</span>`,
        esc(it.material), `<span style="color:${statusColor(it.status)};font-weight:600">${esc(it.status)}</span>`,
        esc(it.godown), esc(it.batch||'—'), esc(it.expiry?fmtDate(it.expiry):'—'),
        esc(it.grn_no||'—'), esc(it.created_at?fmtDate(it.created_at):'—'), esc(it.uom), nf(it.qty)]
        .concat(wc?[money(it.rate),money(it.value)]:[]);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=firstNum?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    return rows || `<tr><td colspan="${colCount}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No boxes match this filter.</td></tr>`;
  }
  function _boxListFoot(items,wc){
    if(!items.length) return '';
    const firstNum=10;
    const totQty=items.reduce((s,it)=>s+Number(it.qty||0),0);
    const totVal=items.reduce((s,it)=>s+Number(it.value||0),0);
    return `<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="${firstNum}" style="padding:9px 9px;text-align:right">TOTAL · ${items.length} boxes</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(totQty)}</td>
      ${wc?`<td></td><td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(totVal)}</td>`:''}</tr>`;
  }
  // Live client-side filter over the already-loaded Box List rows.
  window.invBoxListSearch=function(q){
    _boxListQuery=String(q||'').trim().toLowerCase();
    const j=_lastData; if(!j || j.report!=='box_list') return;
    const wc=j.with_cost;
    const all=j.items||[];
    const filtered = !_boxListQuery ? all : all.filter(it=>{
      const hay=[it.box_code,it.material,it.status,it.godown,it.batch,it.grn_no]
        .map(v=>String(v==null?'':v).toLowerCase()).join(' ');
      return hay.indexOf(_boxListQuery)!==-1;
    });
    const colCount = 11 + (wc?2:0);
    const body=$('rep-boxlist-body'); if(body) body.innerHTML=_boxListBody(filtered,wc,colCount);
    const foot=$('rep-boxlist-foot'); if(foot) foot.innerHTML=_boxListFoot(filtered,wc);
    const meta=$('rep-boxlist-meta');
    if(meta){
      meta.textContent = _boxListQuery
        ? `Status: ${j.status_filter} · showing ${filtered.length} of ${all.length} boxes`
        : `Status: ${j.status_filter} · ${all.length} boxes`;
    }
  };

  function _renderAgeing(j){
    const wc=j.with_cost;
    const bands=j.bands||[];
    // columns: #, Material, Group, UOM, [each band qty], Total Qty, Oldest(d), [Value]
    const cols=['#','Material','Group','UOM'].concat(bands.map(b=>b+' d')).concat(['Total Qty','Oldest (d)']).concat(wc?['Value']:[]);
    const leadLen=4;
    const rows=(j.items||[]).map((it,i)=>{
      const bandCells=bands.map(b=>nf((it.bands[b]||{}).qty||0));
      const cells=[i+1, esc(it.name), esc(it.group||''), esc(it.uom)]
        .concat(bandCells)
        .concat([`<b>${nf(it.total_qty)}</b>`, `<span style="${it.max_age>=180?'color:#C5221F;font-weight:700':''}">${it.max_age}</span>`])
        .concat(wc?[money(it.total_value)]:[]);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=leadLen?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=leadLen?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const bt=j.band_totals||{};
    const totalRow=`<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="${leadLen}" style="padding:9px 9px;text-align:right">TOTAL</td>
      ${bands.map(b=>`<td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace)">${nf((bt[b]||{}).qty||0)}</td>`).join('')}
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(j.grand_qty)}</td>
      <td></td>
      ${wc?`<td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.grand_value)}</td>`:''}</tr>`;
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Stock Ageing</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">In-stock boxes by age (days) · ${j.item_count} materials</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No in-stock boxes.</td></tr>`}</tbody>
          <tfoot>${(j.items||[]).length?totalRow:''}</tfoot>
        </table>
      </div>`;
  }

  function _renderAbc(j){
    const cc=j.class_counts||{}, cv=j.class_values||{};
    const cols=['#','Class','Material','Group','UOM','Qty','Rate','Value','Value %','Cum %'];
    const clsColor=(c)=> c==='A'?'#137333':(c==='B'?'#F57C00':'#C5221F');
    const rows=(j.items||[]).map((it,i)=>{
      const cells=[i+1,
        `<span style="display:inline-block;min-width:18px;text-align:center;font-weight:800;color:#fff;background:${clsColor(it.class)};border-radius:5px;padding:1px 6px">${esc(it.class)}</span>`,
        esc(it.name), esc(it.group||''), esc(it.uom),
        nf(it.qty), money(it.rate), money(it.value), nf(it.value_pct)+'%', nf(it.cum_pct)+'%'];
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=5?'text-align:right;font-family:var(--font-mono,monospace)':''};${ci===1?'text-align:center':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const head=cols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=5?'right':(i===1?'center':'left')};white-space:nowrap">${c}</th>`).join('');
    const summary=['A','B','C'].map(k=>{
      const pct = j.grand_value>0 ? ((cv[k]||0)/j.grand_value*100) : 0;
      return `<span style="font-size:12px">Class <b style="color:${clsColor(k)}">${k}</b>: ${cc[k]||0} items · ${money(cv[k]||0)} (${nf(pct)}%)</span>`;
    }).join('');
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">ABC Analysis</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">By closing stock value · ${j.item_count} ranked · total ${money(j.grand_value)}</div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:10px;flex-wrap:wrap">${summary}</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${head}</tr></thead>
          <tbody>${rows||`<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No materials with stock value.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  function _renderBatchTrace(j){
    const wc=j.with_cost;
    if(!j.box_count){
      return `<div id="rep-printable"><div style="font-size:14px;font-weight:700;margin-bottom:8px">Batch Traceability — ${esc(j.batch)}</div>
        <div style="padding:18px;text-align:center;color:var(--text2,#5F6368)">No boxes found for batch "${esc(j.batch)}".</div></div>`;
    }
    const src=j.source||{};
    const statusColor=(s)=> s==='in_stock'?'#137333':(s==='in_transit'?'#F57C00':(s==='consumed'?'#5F6368':'#C5221F'));
    // status chips
    const chips=Object.keys(j.status_breakdown||{}).map(s=>
      `<span style="font-size:11.5px;font-weight:600;color:${statusColor(s)};background:${statusColor(s)}14;padding:3px 9px;border-radius:99px">${esc(s)}: ${j.status_breakdown[s]}</span>`
    ).join(' ');
    // box table
    const bCols=['#','Box Code','Material','Status','Godown','Created','UOM','Qty'].concat(wc?['Rate','Value']:[]);
    const bFirstNum=7;
    const bRows=(j.boxes||[]).map((b,i)=>{
      const cells=[i+1, `<span style="font-family:var(--font-mono,monospace)">${esc(b.box_code)}</span>`,
        esc(b.material), `<span style="color:${statusColor(b.status)};font-weight:600">${esc(b.status)}</span>`,
        esc(b.godown), esc(b.created_at?fmtDate(b.created_at):'—'), esc(b.uom), nf(b.qty)]
        .concat(wc?[money(b.rate),money(b.value)]:[]);
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci>=bFirstNum?'text-align:right;font-family:var(--font-mono,monospace)':''};white-space:nowrap">${c}</td>`).join('')+'</tr>';
    }).join('');
    const bHead=bCols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i>=bFirstNum?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    const bTotal=`<tr style="font-weight:700;background:var(--bg,#FAF9F5)">
      <td colspan="${bFirstNum}" style="padding:9px 9px;text-align:right">TOTAL · ${j.box_count} boxes</td>
      <td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${nf(j.total_qty)}</td>
      ${wc?`<td></td><td style="padding:9px 9px;text-align:right;font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${money(j.total_value)}</td>`:''}</tr>`;
    // movement history table
    const mvTypeColor=(t)=> (t==='grn_create'||t==='opening'||t==='in')?'#137333':((t==='out'||t==='consume')?'#C5221F':(t==='cancel'?'#9334E6':'#5F6368'));
    const mvCols=['Box Code','Action','From','To','Qty','When','By','Remarks'];
    const mvRows=(j.movements||[]).map(m=>{
      const when=m.at?fmtDate(m.at.slice(0,10))+(m.at.length>10?(' '+m.at.slice(11,16)):''):'—';
      const cells=[`<span style="font-family:var(--font-mono,monospace)">${esc(m.box_code)}</span>`,
        `<span style="color:${mvTypeColor(m.type)};font-weight:600">${esc(m.type)}</span>`,
        esc(m.from||'—'), esc(m.to||'—'), nf(m.qty), esc(when), esc(m.by||'—'), esc(m.remarks||'')];
      return '<tr>'+cells.map((c,ci)=>`<td style="padding:6px 9px;font-size:11px;border-top:1px solid var(--border,rgba(0,0,0,.06));${ci===4?'text-align:right;font-family:var(--font-mono,monospace)':''};${ci===7?'':'white-space:nowrap'}">${c}</td>`).join('')+'</tr>';
    }).join('');
    const mvHead=mvCols.map((c,i)=>`<th style="padding:8px 9px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);text-align:${i===4?'right':'left'};white-space:nowrap">${c}</th>`).join('');
    return `
      <div id="rep-printable">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:14px;font-weight:700">Batch Traceability — ${esc(j.batch)}</div>
          <div style="font-size:11px;color:var(--text2,#5F6368)">${esc((j.materials||[]).join(', '))} · ${j.box_count} box${j.box_count===1?'':'es'} · ${nf(j.total_qty)} total</div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
          ${chips}
          ${src.grn_num?`<span style="font-size:11.5px;color:var(--text2,#5F6368)">Source: <b>${esc(src.grn_num)}</b>${src.supplier?(' · '+esc(src.supplier)):''}${src.grn_date?(' · '+esc(fmtDate(src.grn_date))):''}${src.expiry?(' · EXP '+esc(fmtDate(src.expiry))):''}</span>`:''}
        </div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3,#80868B);margin:14px 0 6px">Boxes in this batch</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${bHead}</tr></thead>
          <tbody>${bRows}</tbody>
          <tfoot>${bTotal}</tfoot>
        </table>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3,#80868B);margin:18px 0 6px">Movement history (${(j.movements||[]).length})</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${mvHead}</tr></thead>
          <tbody>${mvRows||`<tr><td colspan="${mvCols.length}" style="padding:14px;text-align:center;color:var(--text2,#5F6368)">No movements recorded.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  window.invReportsPrint=function(){
    if(!_lastData){ return; }
    const j=_lastData;
    const printable=$('rep-printable'); if(!printable) return;
    const title = j.report==='godown_stock' ? 'Godown-wise Stock Summary — '+(j.godown.name||'')
      : j.report==='group_stock' ? 'Group-wise Stock Summary — '+(j.group.name||'')+(j.godown&&j.godown.name?' @ '+j.godown.name:'')
      : j.report==='movement_ledger' ? 'Movement Ledger — '+(j.material.name||'')
      : j.report==='audit_variance' ? 'Audit Variance — '+(j.session.session_no||'')
      : j.report==='non_moving' ? 'Non-Moving Stock ('+j.days+'+ days)'
      : j.report==='expiry' ? 'Expiry / FEFO (within '+j.days+' days)'
      : j.report==='neg_zero' ? 'Negative / Zero Stock'
      : j.report==='reorder' ? 'Reorder Report (Below MSL)'
      : j.report==='grn_register' ? 'GRN Register'
      : j.report==='dn_register' ? 'Delivery Register'
      : j.report==='transfer_register' ? 'Transfer Register'
      : j.report==='stock_card' ? 'Item Stock Card — '+((j.material&&j.material.name)||'')
      : j.report==='box_list' ? 'Box List'
      : j.report==='ageing' ? 'Stock Ageing'
      : j.report==='abc' ? 'ABC Analysis'
      : j.report==='batch_trace' ? 'Batch Traceability — '+(j.batch||'')
      : 'Report';
    const tableHtml = (j.report==='movement_ledger'||j.report==='audit_variance'||j.report==='non_moving'||j.report==='expiry'||j.report==='neg_zero'||j.report==='reorder'||j.report==='grn_register'||j.report==='dn_register'||j.report==='transfer_register'||j.report==='stock_card'||j.report==='box_list'||j.report==='ageing'||j.report==='abc'||j.report==='batch_trace') ? printable.innerHTML : _printTable(j);
    const w=window.open('','_blank','width=900,height=700');
    if(!w){ toast('Pop-up blocked — allow pop-ups to print','error'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>
        *{font-family:Arial,Helvetica,sans-serif}
        body{margin:24px;color:#111}
        .company{font-size:11px;font-weight:600;color:#666;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}
        h1{font-size:18px;margin:0 0 2px;color:#111}
        .sub{font-size:11px;color:#666;margin-bottom:14px}
        table{width:100%;border-collapse:collapse}
        th{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:#444;background:#f2f2f2;padding:6px 8px;border:1px solid #ddd}
        td{font-size:11.5px;padding:5px 8px;border:1px solid #e5e5e5}
        .r{text-align:right;font-family:'Courier New',monospace}
        tfoot td{font-weight:bold;background:#f7f7f7}
        .brand{margin-top:20px;font-size:10px;color:#888;text-align:center}
      </style></head><body>
      <div class="company">HCP Wellness Pvt. Ltd.</div>
      <h1>${esc(title)}</h1>
      <div class="sub">${(j.from||j.to)?('Period '+esc(fmtDate(j.from||''))+' to '+esc(fmtDate(j.to||''))+' · '):''}Generated ${new Date().toLocaleString('en-IN')}</div>
      ${tableHtml}
      <div class="brand">— Generated by HCP Inventory —</div>
      <script>window.onload=function(){window.print();}<\/script>
      </body></html>`);
    w.document.close();
  };
  function _printTable(j){
    const wc=j.with_cost;
    const isG = j.report==='godown_stock';
    const lead = isG ? ['#','Material','Group','UOM'] : ['#','Material','UOM'];
    const cols = lead.concat(['Opening','Inward','Outward','Closing']).concat(wc?['Rate','Value']:[]);
    const leadLen=lead.length;
    const head='<tr>'+cols.map((c,i)=>`<th class="${i>=leadLen?'r':''}">${c}</th>`).join('')+'</tr>';
    const body=(j.items||[]).map((it,i)=>{
      const lc = isG ? [i+1, it.name, it.group||'', it.uom] : [i+1, it.name, it.uom];
      const nums = [nf(it.opening),nf(it.inward),nf(it.outward),nf(it.closing)].concat(wc?[money(it.rate),money(it.value)]:[]);
      const cells=lc.concat(nums);
      return '<tr>'+cells.map((c,ci)=>`<td class="${ci>=leadLen?'r':''}">${esc(String(c))}</td>`).join('')+'</tr>';
    }).join('');
    const t=j.totals||{opening:0,inward:0,outward:0,closing:0};
    const foot = `<tr><td colspan="${leadLen}" class="r">TOTAL</td>`+
      `<td class="r">${nf(t.opening)}</td><td class="r">${nf(t.inward)}</td><td class="r">${nf(t.outward)}</td><td class="r">${nf(t.closing)}</td>`+
      (wc?`<td></td><td class="r">${money(j.total_value)}</td>`:'')+`</tr>`;
    return `<table><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  }

  function _boot(){ if(_hasAccess()) _injectNav(); }
  document.addEventListener('inv-access-ready',()=>{ if(_hasAccess()) _injectNav(); else $('invReportsNav')?.remove(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invReportsOpen=openReports;
  console.log('inventory_reports.js loaded');
})();
