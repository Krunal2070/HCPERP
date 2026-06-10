/* ════════════════════════════════════════════════════════════════════════
   inventory_dashboard.js  —  Home / "Today" dashboard for the Inventory ERP
   ────────────────────────────────────────────────────────────────────────
   A single landing view that answers "what needs my attention right now",
   built entirely from existing endpoints via one aggregator call:
       GET /api/inventory_mgmt/dashboard/summary

   Three sections of clickable tiles:
     • Tasks    — pending material requests, in-transit transfers, and
                  pending approvals (FEFO override / label reprint / reissue).
     • Alerts   — stock conditions: below MSL, zero, negative, expiring, expired.
     • Activity — today's GRNs, transfers received, boxes created.

   Tiles deep-link into the relevant report/module. Every deep-link is guarded
   with a typeof check so a missing opener degrades to a toast rather than an
   error. Self-injects its own sidebar nav item; opens as a modal (consistent
   with Reports). No backend change beyond the aggregator endpoint.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  const $ = (id)=>document.getElementById(id);
  const esc = (s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast = (m,k,ms)=> (window.invToast?window.invToast(m,k,ms):alert(m));

  let _lastSummary = null;

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;          // before access loads, show it
    if(a.is_admin) return true;
    // any logged-in user can see the dashboard (read-only overview)
    return true;
  }

  async function _api(url){
    const r=await fetch(url, {credentials:'same-origin'});
    const txt=await r.text();
    let j; try{ j=JSON.parse(txt); }catch(e){ throw new Error('Bad response from '+url); }
    if(j.status && j.status!=='ok') throw new Error(j.message||'Request failed');
    return j;
  }

  /* ── Sidebar nav injection (placed at the very top of the Stock section) ── */
  function _injectNav(){
    if($('invDashboardNav')) return;
    const section=document.querySelector('.inv-nav-section[data-section="Stock"] .inv-nav-body')
      || document.querySelector('.inv-nav-body');
    if(!section) return;
    const a=document.createElement('div');
    a.className='inv-nav-item'; a.id='invDashboardNav';
    a.innerHTML='<span class="ico">🏠</span> Home';
    a.onclick=openDashboard;
    section.insertBefore(a, section.firstChild);  // top of the list
  }

  /* ── Tile definitions ──────────────────────────────────────────────────
     Each tile: key into summary section, label, icon, accent, and an action
     (a function run on click). Actions deep-link via guarded global openers. */
  function _openReport(id){
    if(typeof window.invReportsOpen==='function'){
      window.invReportsOpen();
      // give the modal a tick to mount, then pick the report
      setTimeout(()=>{ if(typeof window.invReportsPick==='function') window.invReportsPick(id); }, 120);
      _close();
    } else { toast('Reports module not available','error'); }
  }
  function _openVia(fnName, label){
    const fn = window[fnName];
    if(typeof fn==='function'){ try{ fn(); _close(); }catch(e){ toast('Could not open '+label,'error'); } }
    else { toast((label||'That feature')+' is not available','info'); }
  }

  const TASK_TILES = [
    { key:'material_requests',    label:'Material Requests',  sub:'pending / in-progress', icon:'fa-clipboard-list', color:'#1A73E8', bg:'#E8F0FE', action:()=>_openVia('invMRActivate','Material Requests') },
    { key:'transfers_in_transit', label:'Transfers In-Transit',sub:'awaiting receipt',      icon:'fa-truck-fast',     color:'#F57C00', bg:'#FEF3E0', action:()=>_openVia('invStmActivate','Transfers') },
    { key:'simple_in_transit',    label:'Simple Vouchers',    sub:'awaiting receipt',      icon:'fa-receipt',        color:'#F57C00', bg:'#FEF3E0', action:()=>_openVia('invStmActivate','Simple Vouchers') },
    { key:'fefo_overrides',       label:'FEFO Overrides',     sub:'pending approval',      icon:'fa-shield-halved',  color:'#9334E6', bg:'#F3E8FD', action:()=>_openVia('invFefoOpen','FEFO Overrides') },
    { key:'label_reprints',       label:'Label Reprints',     sub:'pending approval',      icon:'fa-print',          color:'#9334E6', bg:'#F3E8FD', action:()=>_openVia('invReprintOpen','Label Reprints') },
    { key:'label_reissues',       label:'Label Reissues',     sub:'pending approval',      icon:'fa-qrcode',         color:'#9334E6', bg:'#F3E8FD', action:()=>_openVia('invReissueOpen','Label Reissues') },
  ];
  const ALERT_TILES = [
    { key:'below_msl',      label:'Below MSL',      sub:'reorder needed',        icon:'fa-cart-arrow-down',      color:'#C5221F', bg:'#FCE8E6', action:()=>_openReport('reorder') },
    { key:'zero_stock',     label:'Zero Stock',     sub:'tracked items at zero', icon:'fa-ban',                  color:'#C5221F', bg:'#FCE8E6', action:()=>_openReport('negzero') },
    { key:'negative_stock', label:'Negative Stock', sub:'data-integrity flag',   icon:'fa-triangle-exclamation', color:'#C5221F', bg:'#FCE8E6', action:()=>_openReport('negzero') },
    { key:'expiring_30',    label:'Expiring ≤30d',  sub:'use first (FEFO)',      icon:'fa-calendar-xmark',       color:'#F57C00', bg:'#FEF3E0', action:()=>_openReport('expiry') },
    { key:'expired',        label:'Expired',        sub:'quarantine',            icon:'fa-skull-crossbones',     color:'#C5221F', bg:'#FCE8E6', action:()=>_openReport('expiry') },
  ];
  const ACTIVITY_TILES = [
    { key:'grns_today',       label:'GRNs Today',        icon:'fa-file-import',       color:'#137333', bg:'#E6F4EA' },
    { key:'transfers_today',  label:'Transfers Received',icon:'fa-arrows-turn-right', color:'#137333', bg:'#E6F4EA' },
    { key:'boxes_today',      label:'Boxes Created',     icon:'fa-boxes-stacked',     color:'#137333', bg:'#E6F4EA' },
  ];

  /* ── Modal ─────────────────────────────────────────────────────────────── */
  function _ensureModal(){
    if($('invDashboardModal')) return;
    const html=`
<div class="modal-overlay" id="invDashboardModal">
  <div class="modal-card lg" style="max-width:96vw;width:1100px">
    <div class="modal-head">
      <div class="modal-title"><span>🏠</span> <span>Home</span> <span id="dash-date" style="font-size:12px;color:var(--text2,#5F6368);font-weight:400"></span></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" onclick="invDashboardRefresh()" title="Refresh"><i class="fas fa-rotate"></i></button>
        <button class="modal-close" onclick="invDashboardClose()">&times;</button>
      </div>
    </div>
    <div class="modal-body" id="dash-body">
      <div style="padding:32px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
    const ov=$('invDashboardModal');
    ov.addEventListener('click',(e)=>{ if(e.target===ov) _close(); });
    document.addEventListener('keydown',(e)=>{ if(e.key==='Escape' && ov.classList.contains('show')) _close(); });
  }

  function _section(title, tiles, summarySection, clickable){
    const cards = tiles.map(t=>{
      const n = (summarySection && summarySection[t.key]!=null) ? summarySection[t.key] : 0;
      const dim = n===0;
      const cursor = (clickable && t.action && !dim) ? 'cursor:pointer' : 'cursor:default';
      const id = 'dash-tile-'+t.key;
      return `<div id="${id}" class="dash-tile" data-key="${esc(t.key)}"
        style="position:relative;border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:14px 16px;background:#fff;${cursor};opacity:${dim?'.55':'1'};transition:transform .08s,box-shadow .08s">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:34px;height:34px;border-radius:9px;background:${t.bg};color:${t.color};display:flex;align-items:center;justify-content:center;flex:0 0 auto"><i class="fas ${t.icon}"></i></div>
          <div style="min-width:0">
            <div style="font-size:22px;font-weight:800;line-height:1;color:${dim?'var(--text2,#5F6368)':t.color}">${n}</div>
            <div style="font-size:12px;font-weight:600;color:var(--text,#1F1F1F);margin-top:3px">${esc(t.label)}</div>
            ${t.sub?`<div style="font-size:10.5px;color:var(--text3,#80868B);margin-top:1px">${esc(t.sub)}</div>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);margin-bottom:8px">${esc(title)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px">${cards}</div>
    </div>`;
  }

  function _render(j){
    const body=$('dash-body'); if(!body) return;
    _lastSummary=j;
    const dd=$('dash-date'); if(dd){ dd.textContent = '· '+_fmtToday(j.date); }
    const tasksTotal = j.tasks_total||0;
    const alertsTotal = j.alerts_total||0;
    const banner = (tasksTotal===0 && alertsTotal===0)
      ? `<div style="padding:12px 16px;border-radius:10px;background:#E6F4EA;border:1px solid #13733322;color:#137333;font-size:13px;margin-bottom:18px"><i class="fas fa-circle-check"></i> All clear — no pending tasks or stock alerts right now.</div>`
      : `<div style="padding:12px 16px;border-radius:10px;background:#FEF7E0;border:1px solid #F57C0022;color:#92610A;font-size:13px;margin-bottom:18px"><i class="fas fa-bell"></i> <b>${tasksTotal}</b> task${tasksTotal===1?'':'s'} need action · <b>${alertsTotal}</b> stock alert${alertsTotal===1?'':'s'}.</div>`;
    body.innerHTML = banner
      + _section('Tasks — needs action', TASK_TILES, j.tasks, true)
      + _section('Alerts — stock conditions', ALERT_TILES, j.alerts, true)
      + _section("Today's activity", ACTIVITY_TILES, j.activity, false);
    // Wire clicks (avoid inline-string handlers so closures stay intact)
    const wire = (tiles, sectionData)=>{
      tiles.forEach(t=>{
        const el=$('dash-tile-'+t.key); if(!el || !t.action) return;
        const n=(sectionData||{})[t.key]||0;
        if(n>0){
          el.onclick=t.action;
          el.onmouseenter=()=>{ el.style.transform='translateY(-2px)'; el.style.boxShadow='0 4px 14px rgba(0,0,0,.08)'; };
          el.onmouseleave=()=>{ el.style.transform=''; el.style.boxShadow=''; };
        }
      });
    };
    wire(TASK_TILES, j.tasks);
    wire(ALERT_TILES, j.alerts);
  }

  function _fmtToday(iso){
    if(!iso) return '';
    const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? (m[3]+'/'+m[2]+'/'+m[1]) : String(iso);   // DD/MM/YYYY
  }

  async function _load(){
    const body=$('dash-body'); if(body) body.innerHTML='<div style="padding:32px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>';
    try{
      const j=await _api('/api/inventory_mgmt/dashboard/summary');
      _render(j);
    }catch(e){
      if(body) body.innerHTML='<div style="padding:24px;color:#C5221F">'+esc(e.message)+'</div>';
    }
  }

  function openDashboard(){
    _ensureModal();
    const ov=$('invDashboardModal'); ov.classList.add('show');
    _load();
  }
  function _close(){ const ov=$('invDashboardModal'); if(ov) ov.classList.remove('show'); }

  window.invDashboardOpen=openDashboard;
  window.invDashboardClose=_close;
  window.invDashboardRefresh=_load;

  function _boot(){ if(_hasAccess()) _injectNav(); }
  document.addEventListener('inv-access-ready',()=>{ if(_hasAccess()) _injectNav(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  console.log('inventory_dashboard.js loaded');
})();
