/*
   inventory_audit.js - Physical Stock Audit (RM)
   HCP Wellness - adapted from pm_stock_audit.js

   Self-registering sidebar panel + session modal. Tabs: New / Open / Pending /
   History. A session: pick godown (+ optional materials), scan boxes, see live
   variance (missing / extra / per-material), submit for settlement; admin
   settles (applies adjustments) or rejects.

   Gated by 'stock_audit'. Backend: /api/inventory_mgmt/audit/*
*/

(function(){
  'use strict';

  const $ = (id)=>document.getElementById(id);
  const esc = (s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const nf = (n)=>Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:3});
  const toast = (m,k,ms)=> (window.invToast?window.invToast(m,k,ms):alert(m));

  let _curSid=null, _curStatus=null, _isAdmin=false, _tab='new';

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;
    if(a.is_admin) return true;
    return a.access && a.access.stock_audit!=='off' && a.access.stock_audit!==false;
  }

  async function _api(url,opts){
    const r=await fetch(url,opts||{});
    const txt=await r.text();
    if((txt||'').trimStart().startsWith('<'))
      throw new Error(r.status===404?'endpoint not found — restart Flask':('server error '+r.status));
    let j; try{ j=JSON.parse(txt); }catch(e){ throw new Error('bad response'); }
    if(j.status!=='ok') throw new Error(j.message||'request failed');
    return j;
  }

  /* ── Sidebar nav injection ──────────────────────────────── */
  function _injectNav(){
    if(document.getElementById('invAuditNav')) return;
    const section=document.querySelector('.inv-nav-section[data-section="Stock"] .inv-nav-body')
      || document.querySelector('.inv-nav-body');
    if(!section) return;
    const a=document.createElement('div');
    a.className='inv-nav-item'; a.id='invAuditNav';
    a.innerHTML='<span class="ico">📋</span> Physical Audit';
    a.onclick=openHub;
    section.appendChild(a);
  }

  /* ── Modal scaffold ─────────────────────────────────────── */
  function _ensureModal(){
    if($('invAuditModal')) return;
    const html=`
<div class="modal-overlay" id="invAuditModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>📋</span> Physical Stock Audit</div>
      <button class="modal-close" onclick="invAuditClose()">&times;</button>
    </div>
    <div class="modal-body">
      <div id="invAuditTabs" style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn aud-tab" data-tab="new"     onclick="invAuditTab('new')">＋ New</button>
        <button class="btn aud-tab" data-tab="open"    onclick="invAuditTab('open')">Open</button>
        <button class="btn aud-tab" data-tab="pending" onclick="invAuditTab('pending')">Pending</button>
        <button class="btn aud-tab" data-tab="history" onclick="invAuditTab('history')">History</button>
      </div>
      <div id="invAuditPane"></div>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
  }

  function openHub(){ _ensureModal(); $('invAuditModal').classList.add('show'); invAuditTab('new'); }
  window.invAuditClose=()=>$('invAuditModal')?.classList.remove('show');

  window.invAuditTab=function(name){
    _tab=name; _curSid=null;
    document.querySelectorAll('#invAuditTabs .aud-tab').forEach(b=>{
      b.classList.toggle('btn-primary', b.dataset.tab===name);
    });
    if(name==='new')      _renderNew();
    if(name==='open')     _renderList('open','Open sessions — click to continue scanning');
    if(name==='pending')  _renderList('pending_settlement','Submitted for settlement');
    if(name==='history')  _renderList('settled,rejected,cancelled','Settled / rejected / cancelled');
  };

  /* ── New session ────────────────────────────────────────── */
  async function _renderNew(){
    const pane=$('invAuditPane');
    pane.innerHTML='<div style="padding:20px;color:var(--text2,#5F6368)">Loading godowns…</div>';
    let godowns=[];
    try {
      const r=await fetch('/api/inventory_godown/godowns/list'); const j=await r.json();
      godowns=j.godowns||j.rows||[];
    } catch(e){}
    pane.innerHTML=`
      <div style="max-width:520px">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px">Godown to count <span style="color:#C5221F">*</span></label>
        <select id="aud-godown" style="width:100%;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;margin-bottom:14px">
          <option value="">Select godown…</option>
          ${godowns.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}
        </select>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px">Item(s) to verify <span style="color:#C5221F">*</span></label>
        <div style="font-size:11.5px;color:var(--text2,#5F6368);margin-bottom:6px">Pick the item(s) you will physically count. Only these items' packages will be scannable and shown.</div>
        <div id="aud-mat-combo" style="margin-bottom:6px"></div>
        <div id="aud-mat-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px"></div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:5px">Note</label>
        <input id="aud-note" placeholder="e.g. Month-end count" style="width:100%;padding:9px 11px;border:1px solid var(--border,#e5e7eb);border-radius:9px;font-size:13px;margin-bottom:18px">
        <button class="btn btn-primary" onclick="invAuditStart()"><i class="fas fa-play"></i> Start session</button>
      </div>`;
    _wireMatScope();
  }

  let _scopeMats=[];
  function _wireMatScope(){
    _scopeMats=[];
    const mount=$('aud-mat-combo'); if(!mount || !window.invCombo) return;
    fetch('/api/inventory_mgmt/items?department=RM').then(r=>r.json()).then(j=>{
      const opts=(j.items||[]).map(i=>({value:String(i.id), label:i.name||i.material_name||'', sub:''}));
      window.invCombo({
        mount, placeholder:'Add a material to scope…', options:opts,
        onChange:(val,opt)=>{
          // invCombo passes (value, optionObject) — use opt.label for the
          // display name, not the object itself (which renders [object Object]).
          const nm=(opt&&opt.label)?opt.label:String(val);
          if(val && !_scopeMats.find(m=>m.id==val)){ _scopeMats.push({id:val,name:nm}); _renderChips(); }
        }
      });
    });
  }
  function _renderChips(){
    const box=$('aud-mat-chips'); if(!box) return;
    box.innerHTML=_scopeMats.map(m=>
      `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:99px;background:var(--blue-lt,#E8F0FE);font-size:11.5px">
        ${esc(m.name)}<b style="cursor:pointer;color:#C5221F" onclick="invAuditRmScope('${m.id}')">&times;</b></span>`).join('');
  }
  window.invAuditRmScope=(id)=>{ _scopeMats=_scopeMats.filter(m=>m.id!=id); _renderChips(); };

  window.invAuditStart=async function(){
    const gid=$('aud-godown')?.value;
    if(!gid){ toast('Pick a godown','error'); return; }
    if(!_scopeMats.length){ toast('Select at least one item to verify','error'); return; }
    try {
      const j=await _api('/api/inventory_mgmt/audit/start',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({godown_id:+gid, material_ids:_scopeMats.map(m=>+m.id), note:$('aud-note')?.value||''})
      });
      toast('Session '+j.session_no+' started','success');
      _openSession(j.session_id);
    } catch(e){ toast('Could not start: '+e.message,'error'); }
  };

  /* ── Session lists ──────────────────────────────────────── */
  async function _renderList(statusCsv, subtitle){
    const pane=$('invAuditPane');
    pane.innerHTML='<div style="padding:20px;color:var(--text2,#5F6368)">Loading…</div>';
    try {
      const j=await _api('/api/inventory_mgmt/audit/list?status='+encodeURIComponent(statusCsv));
      const list=j.sessions||[];
      if(!list.length){ pane.innerHTML=`<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">No sessions.</div>`; return; }
      pane.innerHTML=`<div style="font-size:12px;color:var(--text2,#5F6368);margin-bottom:8px">${esc(subtitle)}</div>`+
        '<div style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;overflow:hidden">'+
        list.map(s=>`
          <div onclick="invAuditOpen(${s.session_id})" style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--border,rgba(0,0,0,.06));cursor:pointer">
            <span style="font-family:var(--font-mono,monospace);font-weight:700;color:var(--blue,#1A73E8)">${esc(s.session_no)}</span>
            <span style="flex:1;font-size:12.5px">${esc(s.godown_name||'')}</span>
            <span style="font-size:11px;color:var(--text2,#5F6368)">${s.scan_count||0} scans</span>
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:99px;background:var(--blue-lt,#E8F0FE)">${esc((s.status||'').replace('_',' '))}</span>
          </div>`).join('')+'</div>';
    } catch(e){ pane.innerHTML=`<div style="padding:20px;color:#C5221F">${esc(e.message)}</div>`; }
  }
  window.invAuditOpen=(sid)=>_openSession(sid);

  /* ── Session detail (scan + variance) ───────────────────── */
  async function _openSession(sid){
    _curSid=sid;
    const pane=$('invAuditPane');
    pane.innerHTML='<div style="padding:20px;color:var(--text2,#5F6368)">Loading session…</div>';
    try {
      const j=await _api('/api/inventory_mgmt/audit/'+sid);
      _curStatus=j.session.status; _isAdmin=j.is_admin;
      _renderSession(j);
      _updateScanBar(j);   // keep the persistent scan bar in sync
    } catch(e){ pane.innerHTML=`<div style="padding:20px;color:#C5221F">${esc(e.message)}</div>`; }
  }
  function _renderSession(j){
    const s=j.session, v=j.variance, c=v.counts;
    const open=(s.status==='open');
    const pending=(s.status==='pending_settlement');
    const settled=(s.status==='settled');
    // Only the person who started the session, or an admin, may cancel it —
    // and only while it's still open. The backend re-enforces this; this is
    // just the matching UX gate.
    const ctx=window.INV_CTX||{};
    const _me=String(ctx.userName||'').trim().toLowerCase();
    const _owner=String(s.created_by||'').trim().toLowerCase();
    const canCancel=open && (ctx.isAdmin || (_me && _me===_owner));
    const pane=$('invAuditPane');
    pane.innerHTML=`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <button class="btn" onclick="invAuditTab('${_tab}')">&larr; Back</button>
        <span style="font-family:var(--font-mono,monospace);font-weight:800;color:var(--blue,#1A73E8)">${esc(s.session_no)}</span>
        <span style="font-size:12.5px;color:var(--text2,#5F6368)">${esc(s.godown_name||'')}</span>
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:99px;background:var(--blue-lt,#E8F0FE)">${esc((s.status||'').replace('_',' '))}</span>
      </div>

      ${open?`
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input id="aud-scan" class="inv-qr-native" placeholder="Scan or type box code (RM-XXXX) + Enter" autocomplete="off"
          style="flex:1;padding:10px 13px;border:2px solid var(--blue,#1A73E8);border-radius:10px;font-size:14px;font-family:var(--font-mono,monospace)"
          onkeydown="if(event.key==='Enter'){event.preventDefault();invAuditScan();}">
        <button class="btn btn-primary" onclick="invAuditScan()">Add</button>
      </div>`:''}

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
        ${_kpi('Expected', c.expected_boxes, '#1A73E8')}
        ${_kpi('Counted',  c.counted_boxes, '#137333')}
        ${_kpi('Missing',  c.missing_boxes, '#C5221F')}
        ${_kpi('Extra',    c.extra_boxes,   '#F57C00')}
      </div>

      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3,#80868B);margin:6px 0">Per-material variance</div>
      <div style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;overflow:auto;max-height:30vh;margin-bottom:14px">
        <table style="width:auto;min-width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap">
          <thead><tr>${['Material','Exp box','Cnt box','Var box','Var qty'].map(h=>`<th style="text-align:${h==='Material'?'left':'right'};padding:7px 12px;font-size:9.5px;text-transform:uppercase;color:var(--text3,#80868B);background:var(--bg,#FAF9F5);white-space:nowrap">${h}</th>`).join('')}</tr></thead>
          <tbody>${(v.materials||[]).map(m=>`
            <tr style="border-top:1px solid var(--border,rgba(0,0,0,.06))">
              <td style="padding:7px 12px;white-space:nowrap">${esc(m.name||'(unknown)')}</td>
              <td style="padding:7px 12px;text-align:right;white-space:nowrap;font-family:var(--font-mono,monospace)">${m.expected_box}</td>
              <td style="padding:7px 12px;text-align:right;white-space:nowrap;font-family:var(--font-mono,monospace)">${m.counted_box}</td>
              <td style="padding:7px 12px;text-align:right;white-space:nowrap;font-family:var(--font-mono,monospace);font-weight:700;color:${m.var_box===0?'#137333':'#C5221F'}">${m.var_box>0?'+':''}${m.var_box}</td>
              <td style="padding:7px 12px;text-align:right;white-space:nowrap;font-family:var(--font-mono,monospace);color:${m.var_qty===0?'#137333':'#C5221F'}">${m.var_qty>0?'+':''}${nf(m.var_qty)}</td>
            </tr>`).join('')||'<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text2,#5F6368)">No data yet</td></tr>'}</tbody>
        </table>
      </div>

      ${(v.missing&&v.missing.length)?`<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;color:#C5221F;font-weight:600">Missing boxes (${v.missing.length})</summary>
        <div style="font-family:var(--font-mono,monospace);font-size:11px;color:var(--text2,#5F6368);padding:6px 0">${v.missing.map(b=>esc(b.box_code)).join(', ')}</div></details>`:''}
      ${(v.extra&&v.extra.length)?`<details style="margin-bottom:12px"><summary style="cursor:pointer;font-size:12px;color:#F57C00;font-weight:600">Extra boxes (${v.extra.length})</summary>
        <div style="font-family:var(--font-mono,monospace);font-size:11px;color:var(--text2,#5F6368);padding:6px 0">${v.extra.map(b=>esc(b.box_code)).join(', ')}</div></details>`:''}

      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--border,rgba(0,0,0,.08));padding-top:14px">
        <div style="display:flex;gap:8px">
          ${canCancel?`<button class="btn btn-danger" onclick="invAuditCancel()" title="Cancel this audit session (no stock changes)"><i class="fas fa-ban"></i> Cancel session</button>`:''}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${open?`<button class="btn btn-primary" onclick="invAuditSubmit()">Submit for settlement</button>`:''}
          ${(pending&&_isAdmin)?`
            <button class="btn" onclick="invAuditReopen()">Reopen</button>
            <button class="btn btn-danger" onclick="invAuditReject()">Reject</button>
            <button class="btn btn-success" onclick="invAuditSettle()">Settle &amp; adjust</button>`:''}
          ${(pending&&!_isAdmin)?`<span style="font-size:12px;color:var(--text2,#5F6368);align-self:center">Waiting for admin settlement</span>`:''}
          ${(settled&&_isAdmin)?`<button class="btn btn-danger" onclick="invAuditRevert()">Revert settlement</button>`:''}
        </div>
      </div>`;
    if(open) setTimeout(()=>$('aud-scan')?.focus(),80);
  }
  function _kpi(label,val,color){
    return `<div style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;padding:10px 12px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${color};font-family:var(--font-mono,monospace)">${val}</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3,#80868B)">${label}</div></div>`;
  }

  /* ── Persistent / common scan bar ─────────────────────────────
     Once a count session is open, a fixed bar sits at the bottom of the
     page so the user can keep scanning the selected item(s) without
     re-entering the modal. Each scan posts to the same endpoint; the
     backend matches it against the selected items and rejects others. The
     bar shows live counted/expected and the result of the last scan, and
     refreshes the session modal's variance if it happens to be open. */
  function _ensureScanBar(){
    if($('invAuditScanBar')) return;
    const bar=document.createElement('div');
    bar.id='invAuditScanBar';
    bar.style.cssText=[
      'position:fixed','left:0','right:0','bottom:0','z-index:1400',
      'display:none','align-items:center','gap:10px','flex-wrap:wrap',
      'padding:10px 16px','background:#1A1A2E','color:#fff',
      'box-shadow:0 -4px 18px rgba(0,0,0,.25)','font-size:13px'
    ].join(';');
    bar.innerHTML=`
      <span style="font-weight:800;font-family:var(--font-mono,monospace);color:#8ab4f8" id="audbar-sno"></span>
      <span id="audbar-items" style="font-size:12px;color:#cbd5e1;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <span id="audbar-counts" style="font-family:var(--font-mono,monospace);font-size:12px;color:#a7f3d0"></span>
      <input id="audbar-scan" class="inv-qr-native" placeholder="Scan box code + Enter" autocomplete="off"
        style="flex:1;min-width:160px;padding:9px 12px;border:2px solid #4338ca;border-radius:9px;font-size:14px;font-family:var(--font-mono,monospace);background:#0f1021;color:#fff"
        onkeydown="if(event.key==='Enter'){event.preventDefault();invAuditBarScan();}">
      <span id="audbar-last" style="font-size:12px;min-width:120px"></span>
      <button class="btn" onclick="invAuditBarOpen()" style="background:#fff;color:#1A1A2E;padding:7px 12px">Open</button>
      <button class="btn" onclick="invAuditBarHide()" style="background:transparent;color:#cbd5e1;border:1px solid #475569;padding:7px 12px">Hide</button>`;
    document.body.appendChild(bar);
  }
  function _updateScanBar(j){
    const s=j.session, v=j.variance, c=(v&&v.counts)||{};
    if(!s || s.status!=='open'){ _hideScanBar(); return; }
    _ensureScanBar();
    _barSid=s.session_id;
    const names=(v.materials||[]).map(m=>m.name).filter(Boolean).join(', ');
    $('audbar-sno').textContent=s.session_no||'';
    $('audbar-items').textContent=names?('Items: '+names):'';
    $('audbar-items').title=names;
    $('audbar-counts').textContent='Counted '+(c.counted_boxes||0)+' / Exp '+(c.expected_boxes||0);
    const bar=$('invAuditScanBar'); bar.style.display='flex';
    // Don't steal focus while typing elsewhere; only focus if modal is closed.
    if(!$('invAuditModal')?.classList.contains('show')) setTimeout(()=>$('audbar-scan')?.focus(),120);
  }
  function _hideScanBar(){ const b=$('invAuditScanBar'); if(b) b.style.display='none'; _barSid=null; }
  let _barSid=null;

  window.invAuditBarHide=()=>{ const b=$('invAuditScanBar'); if(b) b.style.display='none'; };
  window.invAuditBarOpen=()=>{ if(_barSid){ openHub(); _openSession(_barSid); } };
  window.invAuditBarScan=async function(){
    const inp=$('audbar-scan'); const code=(inp?.value||'').trim().toUpperCase();
    const last=$('audbar-last');
    if(!code || !_barSid) return;
    inp.value='';
    try {
      const j=await _api('/api/inventory_mgmt/audit/'+_barSid+'/scan',{
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({box_code:code})
      });
      if(j.duplicate){ if(last){ last.style.color='#fcd34d'; last.textContent=code+' (dup)'; } }
      else if(!j.known_box){ if(last){ last.style.color='#fcd34d'; last.textContent=code+' (unknown)'; } }
      else { if(last){ last.style.color='#a7f3d0'; last.textContent='✓ '+code; } }
      // Refresh: re-pull session so bar counts (and modal, if open) stay live.
      const sj=await _api('/api/inventory_mgmt/audit/'+_barSid);
      _updateScanBar(sj);
      if($('invAuditModal')?.classList.contains('show') && _curSid===_barSid) _renderSession(sj);
    } catch(e){
      if(last){ last.style.color='#fca5a5'; last.textContent='✕ '+e.message; }
    }
    setTimeout(()=>$('audbar-scan')?.focus(),60);
  };

  window.invAuditScan=async function(){
    const inp=$('aud-scan'); const code=(inp?.value||'').trim().toUpperCase();
    if(!code) return;
    inp.value='';
    try {
      const j=await _api('/api/inventory_mgmt/audit/'+_curSid+'/scan',{
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({box_code:code})
      });
      if(j.duplicate) toast(code+' already scanned','info',1500);
      else if(!j.known_box) toast(code+' added (unknown box — will show as extra)','info',2500);
      else toast(code+' counted','success',1200);
      _openSession(_curSid);   // refresh variance
    } catch(e){
      // Backend rejects boxes that aren't one of the selected items.
      toast(e.message,'error',3000);
    }
    setTimeout(()=>$('aud-scan')?.focus(),60);
  };
  window.invAuditSubmit=async function(){
    if(!confirm('Submit this count for admin settlement? You will not be able to scan further.')) return;
    try { await _api('/api/inventory_mgmt/audit/'+_curSid+'/submit',{method:'POST'}); toast('Submitted','success'); _openSession(_curSid); }
    catch(e){ toast(e.message,'error'); }
  };
  window.invAuditReopen=async function(){
    try { await _api('/api/inventory_mgmt/audit/'+_curSid+'/reopen',{method:'POST'}); toast('Reopened','success'); _openSession(_curSid); }
    catch(e){ toast(e.message,'error'); }
  };
  window.invAuditCancel=async function(){
    if(!confirm('Cancel this audit session?\n\nThis closes the session without making any stock changes. Scans are kept for the record, and the session will move out of the Open tab. This cannot be undone.')) return;
    const note=prompt('Reason for cancelling (optional):')||'';
    try {
      await _api('/api/inventory_mgmt/audit/'+_curSid+'/cancel',{
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({note})
      });
      toast('Session cancelled','success');
      // Session is no longer open — drop the persistent scan bar if it was tied to this one.
      if(_barSid===_curSid){ const b=$('invAuditScanBar'); if(b) b.style.display='none'; _barSid=null; }
      invAuditTab('open');
    } catch(e){ toast(e.message,'error'); }
  };
  window.invAuditReject=async function(){
    const note=prompt('Reason for rejection (optional):')||'';
    try { await _api('/api/inventory_mgmt/audit/'+_curSid+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note})}); toast('Rejected','success'); invAuditTab('pending'); }
    catch(e){ toast(e.message,'error'); }
  };
  window.invAuditSettle=async function(){
    if(!confirm('Settle this count?\n\nThis applies adjustments:\n• Missing boxes → marked lost\n• Extra boxes → moved into this godown\n\nAn admin can revert this later if needed.')) return;
    const note=prompt('Settlement note (optional):')||'';
    try {
      const j=await _api('/api/inventory_mgmt/audit/'+_curSid+'/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apply_adjustments:true,note})});
      toast(`Settled — ${j.adjustments.missing_marked} marked lost, ${j.adjustments.extra_moved} moved in`,'success',5000);
      invAuditTab('history');
    } catch(e){ toast(e.message,'error'); }
  };
  window.invAuditRevert=async function(){
    if(!confirm('Revert this settlement?\n\nThis undoes the stock changes it made:\n• Boxes marked lost → restored to their prior status\n• Boxes moved in → returned to their prior godown\n\nThe session goes back to pending for re-review.')) return;
    try {
      const j=await _api('/api/inventory_mgmt/audit/'+_curSid+'/revert',{method:'POST'});
      const u=j.undone||{};
      toast(`Reverted — ${u.missing_restored||0} restored, ${u.extra_moved_back||0} moved back`,'success',5000);
      if(j.note) setTimeout(()=>toast(j.note,'info',7000),300);
      invAuditTab('pending');
    } catch(e){ toast(e.message,'error'); }
  };

  /* ── Boot ───────────────────────────────────────────────── */
  function _boot(){
    if(_hasAccess()) _injectNav();
  }
  document.addEventListener('inv-access-ready',()=>{ if(_hasAccess()) _injectNav(); else $('invAuditNav')?.remove(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invAuditOpenHub=openHub;
  console.log('inventory_audit.js loaded (Physical Stock Audit)');
})();
