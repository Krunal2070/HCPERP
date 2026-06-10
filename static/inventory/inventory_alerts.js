/*
   inventory_alerts.js - Low Stock Alerts (RM)  [Stock View enhancement]
   HCP Wellness

   Surfaces items at/below their MSL (minimum stock level) as an actionable
   alert list, rather than only a filter you have to apply. Adds a bell button
   (with a count badge) into the toolbar; clicking opens a panel listing every
   below-MSL item with current stock, MSL, and shortfall — click an item to
   jump to it in the grid.

   Self-contained: fetches its own data from /api/inventory_mgmt/items so it
   doesn't depend on the grid's internal state. Gated by 'low_stock_alerts'.
*/

(function(){
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  const nf = (n) => Number(n||0).toLocaleString('en-IN', {maximumFractionDigits:3});

  let _alerts = [];

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;
    if(a.is_admin) return true;
    return a.access && a.access.low_stock_alerts!=='off' && a.access.low_stock_alerts!==false;
  }

  async function _load(){
    try {
      const r=await fetch('/api/inventory_mgmt/items?department=RM');
      const j=await r.json();
      const items=(j.items||j.rows||[]);
      _alerts = items
        .filter(i => i.msl!=null && Number(i.msl)>0 && Number(i.in_stock||0) < Number(i.msl))
        .map(i => ({
          id:i.id, name:i.name||i.material_name||'', uom:i.uom||'',
          stock:Number(i.in_stock||0), msl:Number(i.msl),
          shortfall: Number(i.msl) - Number(i.in_stock||0)
        }))
        .sort((a,b)=> b.shortfall - a.shortfall);
    } catch(e){ _alerts=[]; }
    _updateBadge();
  }

  function _mountButton(){
    if(document.getElementById('invAlertsBtn')) return;
    const toolbar=document.querySelector('.inv-toolbar');
    if(!toolbar) return;
    const btn=document.createElement('button');
    btn.id='invAlertsBtn'; btn.className='btn'; btn.type='button';
    btn.title='Low stock alerts';
    btn.style.position='relative';
    btn.innerHTML='<i class="fas fa-bell"></i> Alerts <span id="invAlertsBadge" style="display:none;position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:99px;background:#C5221F;color:#fff;font-size:10px;font-weight:800;display:none;align-items:center;justify-content:center;line-height:1"></span>';
    btn.onclick=_openPanel;
    // place it before the Export button if present
    const exportBtn=Array.from(toolbar.querySelectorAll('button')).find(b=>/export/i.test(b.textContent));
    if(exportBtn) toolbar.insertBefore(btn, exportBtn); else toolbar.appendChild(btn);
    _updateBadge();
  }
  function _updateBadge(){
    const badge=document.getElementById('invAlertsBadge'); if(!badge) return;
    if(_alerts.length){ badge.textContent=_alerts.length>99?'99+':_alerts.length; badge.style.display='flex'; }
    else badge.style.display='none';
  }

  function _ensurePanel(){
    if(document.getElementById('invAlertsModal')) return;
    const html=`
<div class="modal-overlay" id="invAlertsModal">
  <div class="modal-card lg" style="max-width:560px">
    <div class="modal-head">
      <div class="modal-title"><span>🔔</span> Low Stock Alerts</div>
      <button class="modal-close" onclick="invAlertsClose()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:10px">
      <div id="invAlertsSummary" style="font-size:12.5px;color:var(--text2,#5F6368);margin-bottom:10px"></div>
      <div id="invAlertsList" style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;overflow:auto;max-height:56vh"></div>
    </div>
    <div class="modal-foot">
      <div style="flex:1"></div>
      <button class="btn" onclick="invAlertsClose()">Close</button>
      <button class="btn btn-primary" onclick="invAlertsRefresh()"><i class="fas fa-sync"></i> Refresh</button>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
  }

  async function _openPanel(){
    _ensurePanel();
    document.getElementById('invAlertsModal').classList.add('show');
    if(!_alerts.length) await _load();
    _render();
  }
  function _render(){
    const sum=document.getElementById('invAlertsSummary');
    const list=document.getElementById('invAlertsList');
    if(!list) return;
    if(!_alerts.length){
      if(sum) sum.textContent='';
      list.innerHTML='<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)"><div style="font-size:28px;margin-bottom:6px">✅</div>No items below their minimum stock level.</div>';
      return;
    }
    if(sum) sum.innerHTML=`<strong style="color:#C5221F">${_alerts.length}</strong> item${_alerts.length>1?'s':''} below minimum stock level.`;
    list.innerHTML=
      '<table style="width:100%;border-collapse:collapse">'
      + '<thead><tr>'
      + '<th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Material</th>'
      + '<th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Stock</th>'
      + '<th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">MSL</th>'
      + '<th style="text-align:right;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Short by</th>'
      + '</tr></thead><tbody>'
      + _alerts.map(a=>`
        <tr onclick="invAlertsGoto('${esc(a.name).replace(/'/g,"\\'")}')" style="cursor:pointer;border-top:1px solid var(--border,rgba(0,0,0,.06))">
          <td style="padding:9px 12px;font-size:12.5px">${esc(a.name)}</td>
          <td style="padding:9px 12px;text-align:right;font-family:var(--font-mono,monospace);font-size:12px;color:${a.stock<=0?'#C5221F':'#B06000'}">${nf(a.stock)} ${esc(a.uom)}</td>
          <td style="padding:9px 12px;text-align:right;font-family:var(--font-mono,monospace);font-size:12px;color:var(--text2,#5F6368)">${nf(a.msl)}</td>
          <td style="padding:9px 12px;text-align:right;font-family:var(--font-mono,monospace);font-size:12px;font-weight:700;color:#C5221F">${nf(a.shortfall)}</td>
        </tr>`).join('')
      + '</tbody></table>';
  }

  function _goto(name){
    invAlertsClose();
    // jump to Items screen + filter to this material
    const itemsNav=Array.from(document.querySelectorAll('.inv-nav-item'))
      .find(n=>(n.textContent||'').trim().toLowerCase().includes('items'));
    if(itemsNav) itemsNav.click();
    setTimeout(()=>{
      const box=document.getElementById('itemSearch') || document.querySelector('input[placeholder*="Search items" i]');
      if(box){ box.value=name; box.dispatchEvent(new Event('input',{bubbles:true})); box.focus(); }
    },180);
  }

  function _applyAccess(){
    const btn=document.getElementById('invAlertsBtn');
    if(_hasAccess()){ if(!btn) _mountButton(); }
    else if(btn){ btn.remove(); }
  }
  document.addEventListener('inv-access-ready', _applyAccess);

  function _boot(){
    if(!_hasAccess()) return;
    // toolbar may render after this script — retry briefly
    let tries=0;
    const iv=setInterval(()=>{
      tries++;
      if(document.querySelector('.inv-toolbar')){ _mountButton(); _load(); clearInterval(iv); }
      if(tries>20) clearInterval(iv);
    },300);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invAlertsClose=()=>document.getElementById('invAlertsModal')?.classList.remove('show');
  window.invAlertsRefresh=async ()=>{ await _load(); _render(); };
  window.invAlertsGoto=_goto;
  window.invAlertsReload=_load;

  console.log('inventory_alerts.js loaded (low-stock alerts)');
})();
