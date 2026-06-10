/*
   inventory_box_split.js - Box Split (RM)
   HCP Wellness - adapted from pm_stock_split.js, pm-themed

   Divide an in-stock parent box into N children whose qtys sum to the
   parent's qty. No stock moves. Parent -> superseded; children get fresh
   codes. Self-injecting "Box Split" sidebar item (Stock section).

   Backend: inventory_box_split.py -> POST /api/inventory_mgmt/boxes/<id>/split
*/

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const nf = (n) => Number(n||0).toLocaleString('en-IN');

  let _parent = null, _result = null;

  function _ensure(){
    if($('invSplitModal')) return;
    const html = `
<div class="modal-overlay" id="invSplitModal">
  <div class="modal-card lg" style="max-width:560px">
    <div class="modal-head">
      <div class="modal-title"><span>✂️</span> Box Split</div>
      <button class="modal-close" onclick="invSplitClose()">&times;</button>
    </div>
    <div class="modal-body" style="padding-top:14px">
      <label style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--nb-text-muted,#444746);display:block;margin-bottom:5px">Scan / type the box code to split</label>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input type="text" id="sb-code" placeholder="RM-XXXX" autocomplete="off"
          onkeydown="if(event.key==='Enter'){event.preventDefault();invSplitLookup();}"
          style="flex:1;padding:9px 11px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;font-family:var(--font-mono,monospace);font-size:13px;font-weight:600;background:var(--white,#fff);color:var(--text,#1F1F1F);outline:none">
        <button class="btn btn-primary" onclick="invSplitLookup()"><i class="fas fa-search"></i> Look up</button>
      </div>

      <div id="sb-parent" style="display:none;background:var(--bg,#FAF9F5);border:1px solid var(--border,rgba(0,0,0,.12));border-radius:10px;padding:12px 14px;margin-bottom:14px"></div>

      <div id="sb-splits" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--nb-text-muted,#444746)">Children</span>
          <button class="btn" style="padding:5px 11px;font-size:11px" onclick="invSplitAddRow()"><i class="fas fa-plus"></i> Add child</button>
        </div>
        <div id="sb-rows" style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:8px;overflow:hidden"></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:8px;padding:0 4px">
          <span>Target: <strong id="sb-target" style="font-family:var(--font-mono,monospace)">0</strong></span>
          <span>Sum: <strong id="sb-sum" style="font-family:var(--font-mono,monospace)">0</strong> <span id="sb-bal" style="font-weight:800;margin-left:6px"></span></span>
        </div>
        <label style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--nb-text-muted,#444746);display:block;margin:12px 0 5px">Reason (optional)</label>
        <input type="text" id="sb-reason" placeholder="e.g. send only half to factory"
          style="width:100%;padding:8px 10px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;font-size:12.5px;background:var(--white,#fff);color:var(--text,#1F1F1F);outline:none">
      </div>

      <div id="sb-result" style="display:none;background:rgba(22,163,74,.06);border:1px solid rgba(22,163,74,.25);border-radius:10px;padding:12px 14px;margin-top:6px"></div>
    </div>
    <div class="modal-foot">
      <div style="flex:1"></div>
      <button class="btn" onclick="invSplitClose()">Close</button>
      <button class="btn btn-primary" id="sb-save" style="display:none" onclick="invSplitDo()"><i class="fas fa-cut"></i> Split &amp; Print</button>
    </div>
  </div>
</div>`;
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    document.body.appendChild(tmp.firstElementChild);
  }

  function open(){ _ensure(); $('invSplitModal').classList.add('show'); reset(); setTimeout(()=>$('sb-code')?.focus(),80); }
  function close(){ $('invSplitModal')?.classList.remove('show'); }
  function reset(){
    _parent=null; _result=null;
    if($('sb-code')){ $('sb-code').value=''; $('sb-code').disabled=false; }
    $('sb-parent').style.display='none';
    $('sb-splits').style.display='none';
    $('sb-result').style.display='none';
    $('sb-save').style.display='none';
    $('sb-rows').innerHTML=''; if($('sb-reason')) $('sb-reason').value='';
  }

  async function lookup(){
    const raw = ($('sb-code').value||'').trim().toUpperCase();
    if(!raw){ toast('Enter or scan a box code','error'); return; }
    try {
      const r = await fetch('/api/inventory_mgmt/boxes/by_code?code='+encodeURIComponent(raw));
      const d = await r.json();
      if(d.status!=='ok' || !d.box){ toast(d.message||`Box ${raw} not found`,'error',4000); return; }
      const b = d.box;
      if(b.current_status==='superseded'){ toast('That box was already split — look up one of its children.','error',5000); return; }
      if(b.current_status!=='in_stock'){ toast(`Box status is "${b.current_status}" — only in_stock boxes can be split.`,'error',5000); return; }
      _parent = b;
      renderParent(b);
      buildRows(b);
      $('sb-save').style.display='inline-flex';
    } catch(e){ toast('Lookup failed: '+e.message,'error',4000); }
  }

  function renderParent(b){
    const meta=[];
    if(b.godown_name) meta.push('At: '+esc(b.godown_name));
    if(b.grn_no) meta.push('Lot: '+esc(b.grn_no));
    if(b.batch_num) meta.push('Batch: '+esc(b.batch_num));
    $('sb-parent').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
         <div><div style="font-family:var(--font-mono,monospace);font-weight:800;font-size:14px;color:var(--blue,#1A73E8)">${esc(b.box_code)}</div>
         <div style="font-size:13px;font-weight:600;margin-top:2px">${esc(b.material_name||'')}</div></div>
         <div style="text-align:right"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--nb-text-muted,#444746)">Qty</div>
         <div style="font-family:var(--font-mono,monospace);font-weight:800;font-size:16px">${nf(b.per_box_qty)} <span style="font-size:11px">${esc(b.uom||'')}</span></div></div>
       </div>
       <div style="font-size:11px;color:var(--text2,#5F6368);margin-top:6px">${meta.join('  ·  ')}</div>`;
    $('sb-parent').style.display='block';
    $('sb-splits').style.display='block';
    $('sb-target').textContent = nf(b.per_box_qty);
  }

  function buildRows(b){
    $('sb-rows').innerHTML='';
    const half = (Number(b.per_box_qty)||0)/2;
    addRow(half); addRow(half);
  }

  function addRow(initial){
    const c = $('sb-rows');
    const div = document.createElement('div');
    div.className='sb-row';
    div.style.cssText='display:grid;grid-template-columns:70px 1fr 32px;gap:10px;padding:9px 12px;border-top:1px solid var(--border,rgba(0,0,0,.06));align-items:center';
    const idx = c.children.length+1;
    div.innerHTML =
      `<div style="font-weight:800;color:var(--blue,#1A73E8);font-size:12px">Child #${idx}</div>
       <input type="number" class="sb-q" min="0" step="any" value="${initial!=null?initial:0}"
         style="width:100%;text-align:right;font-size:14px;padding:7px 10px;font-weight:700;font-family:var(--font-mono,monospace);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;outline:none;background:var(--white,#fff);color:var(--text,#1F1F1F)">
       <button title="Remove" onclick="this.closest('.sb-row').remove(); invSplitRenumber(); invSplitRecalc()"
         style="width:26px;height:26px;border-radius:5px;background:rgba(220,38,38,.1);border:1px solid rgba(220,38,38,.3);color:#dc2626;cursor:pointer;font-size:13px">✕</button>`;
    c.appendChild(div);
    div.querySelector('.sb-q').addEventListener('input', recalc);
    recalc();
  }
  function renumber(){ document.querySelectorAll('#sb-rows .sb-row').forEach((r,i)=>{ const l=r.querySelector('div'); if(l) l.textContent='Child #'+(i+1); }); }

  function recalc(){
    const target = Number(_parent?.per_box_qty||0);
    let sum=0; document.querySelectorAll('#sb-rows .sb-q').forEach(i=>sum+=Number(i.value)||0);
    $('sb-sum').textContent = nf(Math.round(sum*1000)/1000);
    const bal=$('sb-bal'), save=$('sb-save');
    if(Math.abs(sum-target)<0.001){ bal.textContent='✓'; bal.style.color='#137333'; save.disabled=false; }
    else if(sum>target){ bal.textContent=`over by ${nf(Math.round((sum-target)*1000)/1000)}`; bal.style.color='#C5221F'; save.disabled=true; }
    else { bal.textContent=`short by ${nf(Math.round((target-sum)*1000)/1000)}`; bal.style.color='#B06000'; save.disabled=true; }
  }

  async function doSplit(){
    if(!_parent){ toast('Look up a box first','error'); return; }
    const splits=[]; document.querySelectorAll('#sb-rows .sb-q').forEach(i=>{ const q=Number(i.value)||0; if(q>0) splits.push({qty:q}); });
    if(splits.length<2){ toast('At least 2 children with positive qty are required','error'); return; }
    const target=Number(_parent.per_box_qty||0), sum=splits.reduce((a,s)=>a+s.qty,0);
    if(Math.abs(sum-target)>0.001){ toast(`Sum (${nf(sum)}) must equal parent qty (${nf(target)})`,'error',4500); return; }
    const reason=($('sb-reason').value||'').trim();
    let msg=`Split ${_parent.box_code} (${nf(target)}) into ${splits.length} children?\n\n`;
    splits.forEach((s,i)=>{ msg+=`  Child #${i+1}: ${nf(s.qty)}\n`; });
    msg+=`\nThe parent label will be invalidated. New child labels follow.\nProceed?`;
    if(!confirm(msg)) return;
    const btn=$('sb-save'); btn.disabled=true; btn.innerHTML='Splitting…';
    try {
      const r = await fetch(`/api/inventory_mgmt/boxes/${_parent.box_id}/split`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({splits, reason})
      });
      const d = await r.json();
      if(d.status==='ok'){ _result=d; renderResult(d); toast(`✓ Split into ${d.children.length} children`,'success',4000); }
      else { toast(d.message||'Split failed','error',5000); btn.disabled=false; btn.innerHTML='<i class="fas fa-cut"></i> Split & Print'; }
    } catch(e){ toast('Error: '+e.message,'error'); btn.disabled=false; btn.innerHTML='<i class="fas fa-cut"></i> Split & Print'; }
  }

  function renderResult(d){
    $('sb-parent').style.display='none';
    $('sb-splits').style.display='none';
    $('sb-save').style.display='none';
    if($('sb-code')) $('sb-code').disabled=true;
    const kids = d.children.map((c,i)=>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12.5px">
         <span>Child #${i+1}: <strong style="font-family:var(--font-mono,monospace);color:var(--blue,#1A73E8)">${esc(c.box_code)}</strong></span>
         <span style="font-family:var(--font-mono,monospace)">${nf(c.qty)} ${esc(d.parent?.uom||'')}</span></div>`).join('');
    const codes = d.children.map(c=>c.box_code);
    $('sb-result').innerHTML =
      `<div style="font-weight:800;font-size:13px;color:#137333;margin-bottom:6px">✓ ${esc(d.parent?.box_code||'')} split into ${d.children.length} children</div>
       ${kids}
       <div style="margin-top:10px;display:flex;gap:8px">
         <button class="btn btn-primary" style="padding:6px 13px;font-size:12px" onclick='invSplitPrint(${JSON.stringify(codes)})'><i class="fas fa-print"></i> Print child labels</button>
         <button class="btn" style="padding:6px 13px;font-size:12px" onclick="invSplitOpen()"><i class="fas fa-redo"></i> Split another</button>
       </div>`;
    $('sb-result').style.display='block';
  }

  function printChildren(codes){
    // Reuse the existing per-box label printer if present.
    if(typeof window.invGrnPrintBoxLabel === 'function'){
      (codes||[]).forEach(code => { try { window.invGrnPrintBoxLabel(code); } catch(e){} });
    } else {
      toast('Child boxes created. Print labels from the box/label screen.','info',4500);
    }
  }

  /* ── nav (Stock section) ──────────────────────────────────────────── */
  function _injectNav(){
    if($('split-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body'); if(!navBody) return;
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Stock');
    if(!section){ section=document.createElement('div'); section.className='inv-nav-section';
      section.innerHTML='<div class="inv-nav-section-label">Stock</div>'; navBody.appendChild(section); }
    const item=document.createElement('div'); item.className='inv-nav-item'; item.id='split-nav-item';
    item.setAttribute('data-cap','box_split');
    item.onclick=()=>open();
    item.innerHTML='<span class="ico">✂️</span><span>Box Split</span>';
    section.appendChild(item);
  }
  function _applyAccess(){
    const item=$('split-nav-item'); if(!item) return;
    const a=window._invAccess;
    const ok=!a||!a.ready||a.is_admin||(a.access&&a.access.box_split!=='off'&&a.access.box_split!==false);
    item.style.display=ok?'':'none';
  }
  document.addEventListener('inv-access-ready', _applyAccess);
  function _boot(){ _injectNav(); _applyAccess(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invSplitOpen=open; window.invSplitClose=close;
  window.invSplitLookup=lookup; window.invSplitAddRow=()=>addRow(0);
  window.invSplitRenumber=renumber; window.invSplitRecalc=recalc;
  window.invSplitDo=doSplit; window.invSplitPrint=printChildren;

  console.log('✅ inventory_box_split.js loaded');
})();
