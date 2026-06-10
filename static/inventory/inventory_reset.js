/*
   inventory_reset.js - Admin DB Reset (RM)  [DESTRUCTIVE]
   HCP Wellness

   Admin-only. Lists resettable groups with live row counts. A group whose
   dependents still hold rows is BLOCKED (checkbox disabled) and shows what to
   clear first (Interpretation B). Select allowed groups → Preview row counts →
   type RESET → Run. Voucher numbering: auto-resets when Boxes are cleared, plus
   a manual "Reset voucher sequence" button.

   Gated by 'db_reset'. Backend: /api/inventory_mgmt/reset/*
*/
(function(){
  'use strict';

  const $=(id)=>document.getElementById(id);
  const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const toast=(m,k,ms)=>(window.invToast?window.invToast(m,k,ms):alert(m));

  function _isAdmin(){
    const a=window._invAccess;
    return !!(a && a.is_admin);
  }
  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return false;       // reset is admin-only; default hidden
    if(a.is_admin) return true;
    return a.access && (a.access.db_reset==='on' || a.access.db_reset===true);
  }

  async function _api(url,opts){
    const r=await fetch(url,opts||{});
    const txt=await r.text();
    if((txt||'').trimStart().startsWith('<')) throw new Error(r.status===404?'endpoint not found — restart Flask':('server error '+r.status));
    const j=JSON.parse(txt);
    if(j.status!=='ok') throw new Error(j.message||'request failed');
    return j;
  }

  function _injectNav(){
    if($('invResetNav')) return;
    if(!_hasAccess()) return;
    const section=document.querySelector('.inv-nav-section[data-section="Admin"] .inv-nav-body')
      || document.querySelector('.inv-nav-body');
    if(!section) return;
    const a=document.createElement('div');
    a.className='inv-nav-item'; a.id='invResetNav';
    a.innerHTML='<span class="ico">⚠️</span> Database Reset';
    a.onclick=openReset;
    section.appendChild(a);
  }

  function _ensureModal(){
    if($('invResetModal')) return;
    const html=`
<div class="modal-overlay" id="invResetModal">
  <div class="modal-card lg" style="max-width:640px">
    <div class="modal-head">
      <div class="modal-title"><span>⚠️</span> Database Reset</div>
      <button class="modal-close" onclick="invResetClose()">&times;</button>
    </div>
    <div class="modal-body">
      <div style="background:#FEF3E0;border:1px solid #F5C77E;border-radius:10px;padding:10px 12px;font-size:12px;color:#8a5200;margin-bottom:14px">
        <b>Destructive action.</b> This permanently deletes transactional data. Master data (materials, godowns, users, suppliers) is never touched. A group is locked until everything that depends on it is cleared first.
      </div>
      <div id="reset-groups"><div style="padding:18px;text-align:center;color:var(--text2,#5F6368)">Loading…</div></div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border,rgba(0,0,0,.08))">
        <button class="btn" onclick="invResetVoucherSeq()" style="font-size:12px"><i class="fas fa-rotate-left"></i> Reset voucher number sequence</button>
        <div style="font-size:11px;color:var(--text2,#5F6368);margin-top:4px">Resets box-code numbering to start fresh (only when no boxes exist). Auto-runs when Boxes are cleared.</div>
      </div>
    </div>
    <div class="modal-foot">
      <div style="flex:1;display:flex;align-items:center;gap:8px">
        <label style="font-size:12px;color:var(--text2,#5F6368)">Type <b>RESET</b> to confirm:</label>
        <input id="reset-confirm" placeholder="RESET" autocomplete="off" style="padding:6px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:13px;width:110px;font-family:var(--font-mono,monospace)">
      </div>
      <button class="btn" onclick="invResetClose()">Cancel</button>
      <button class="btn btn-danger" id="reset-run-btn" onclick="invResetRun()" disabled><i class="fas fa-trash"></i> Reset selected</button>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
    $('reset-confirm').addEventListener('input',_syncRunBtn);
  }

  let _groups=[];
  async function openReset(){
    if(!_hasAccess()){ toast('Admin only','error'); return; }
    _ensureModal();
    $('invResetModal').classList.add('show');
    $('reset-confirm').value='';
    await _loadGroups();
  }
  window.invResetClose=()=>$('invResetModal')?.classList.remove('show');

  async function _loadGroups(){
    const box=$('reset-groups');
    box.innerHTML='<div style="padding:18px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>';
    try {
      const j=await _api('/api/inventory_mgmt/reset/groups');
      _groups=j.groups||[];
      box.innerHTML=_groups.map(g=>{
        const disabled=g.blocked || g.rows===0;
        const blockNote=g.blocked
          ? `<div style="font-size:11px;color:#C5221F;margin-top:3px">🔒 Clear first: ${g.blockers.map(b=>esc(b.label)).join(', ')}</div>`
          : (g.rows===0 ? `<div style="font-size:11px;color:var(--text2,#5F6368);margin-top:3px">Already empty</div>` : '');
        return `
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;margin-bottom:8px;cursor:${disabled?'not-allowed':'pointer'};opacity:${disabled?'.6':'1'}">
          <input type="checkbox" class="reset-cb" value="${esc(g.key)}" ${disabled?'disabled':''} onchange="invResetSync()" style="margin-top:2px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${esc(g.label)} <span style="font-weight:400;color:var(--text2,#5F6368)">· ${g.rows} record${g.rows===1?'':'s'}</span></div>
            ${blockNote}
          </div>
        </label>`;
      }).join('');
    } catch(e){ box.innerHTML=`<div style="padding:18px;color:#C5221F">${esc(e.message)}</div>`; }
    _syncRunBtn();
  }

  window.invResetSync=_syncRunBtn;
  function _selected(){ return Array.from(document.querySelectorAll('.reset-cb:checked')).map(c=>c.value); }
  function _syncRunBtn(){
    const ok = _selected().length>0 && ($('reset-confirm')?.value||'')==='RESET';
    const btn=$('reset-run-btn'); if(btn) btn.disabled=!ok;
  }

  window.invResetRun=async function(){
    const groups=_selected();
    if(!groups.length){ toast('Select at least one group','error'); return; }
    if(($('reset-confirm').value||'')!=='RESET'){ toast('Type RESET to confirm','error'); return; }
    // show preview first
    let preview;
    try { preview=await _api('/api/inventory_mgmt/reset/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups})}); }
    catch(e){ toast(e.message,'error'); return; }
    if((preview.blocked||[]).length){
      toast('Some groups are blocked: '+preview.blocked.map(b=>b.label).join(', '),'error',5000);
      await _loadGroups(); return;
    }
    const lines=(preview.preview||[]).map(p=>p.label+': '+p.tables.reduce((s,t)=>s+t.rows,0)+' rows').join('\n');
    if(!confirm('This will permanently delete:\n\n'+lines+'\n\nThis cannot be undone. Continue?')) return;
    try {
      const j=await _api('/api/inventory_mgmt/reset/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups,confirm:'RESET'})});
      const total=Object.values(j.deleted||{}).reduce((s,n)=>s+(typeof n==='number'?n:0),0);
      toast(`Reset complete — ${total} rows deleted`+(j.voucher_seq_reset?' · voucher sequence reset':''),'success',5000);
      $('reset-confirm').value='';
      await _loadGroups();
    } catch(e){ toast(e.message,'error',6000); }
  };

  window.invResetVoucherSeq=async function(){
    if(!confirm('Reset the box-code voucher sequence to start fresh?\n(Only works when no boxes exist.)')) return;
    try { await _api('/api/inventory_mgmt/reset/voucher_seq',{method:'POST'}); toast('Voucher sequence reset','success'); }
    catch(e){ toast(e.message,'error',5000); }
  };

  function _boot(){ if(_hasAccess()) _injectNav(); }
  document.addEventListener('inv-access-ready',()=>{ if(_hasAccess()) _injectNav(); else $('invResetNav')?.remove(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invResetOpen=openReset;
  console.log('inventory_reset.js loaded (admin db reset)');
})();
