/* ═══════════════════════════════════════════════════════════════════════
   inventory_material_lock.js — Material Lock  (Inventory Phase 4)
   HCP Wellness · LAYOUT/DESIGN copied exactly from pm_stock_material_lock.js,
   adapted for RM stock (material/godown/GRN instead of pm product).
   ───────────────────────────────────────────────────────────────────────
   Manager/admin locks (or explicitly allows) an RM material from being
   issued (scanned OUT), by entry date or specific GRN, per location.
   Independent of FEFO. Gated by the 'material_lock' access category.

   Backend: inventory_material_lock.py → /api/inventory_mgmt/material_locks*
   =================================================================== */
(function(){
  'use strict';

  function _toast(m,k,ms){ if(window.invToast) window.invToast(m,k||'info',ms||3000); else alert(m); }
  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function _fmtDate(s){ if(!s) return ''; var m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?(m[3]+'/'+m[2]+'/'+m[1]):String(s); }

  var _mlGodowns=null, _mlMaterials=null, _mlCanManage=false;

  /* ── Reusable type-search combobox with keyboard nav (from pm) ──────── */
  function _mlMountCombo(hostId, opts){
    var host=document.getElementById(hostId);
    if(!host) return null;
    var items=opts.items||[];
    var getLabel=opts.getLabel||function(x){return String(x);};
    var getValue=opts.getValue||function(x){return x;};
    var onSelect=opts.onSelect||function(){};
    var inpCss='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,rgba(0,0,0,.18));'
      + 'border-radius:8px;font-size:12.5px;background:var(--card,#fff);color:var(--text,#111);outline:none';
    host.style.position='relative';
    host.innerHTML =
      '<input type="text" autocomplete="off" placeholder="'+_esc(opts.placeholder||'Type to search…')+'" style="'+inpCss+'">'
      + '<div class="ml-combo-dd" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 3px);z-index:60;'
      + 'background:var(--card,#fff);border:1px solid var(--border,rgba(0,0,0,.18));border-radius:8px;'
      + 'box-shadow:0 12px 30px rgba(0,0,0,.16);max-height:240px;overflow-y:auto"></div>';
    var input=host.querySelector('input');
    var dd=host.querySelector('.ml-combo-dd');
    var idx=-1, filtered=[], chosen=false;
    function _render(q){
      q=(q||'').toLowerCase().trim();
      filtered = !q ? items.slice(0,200)
                    : items.filter(function(it){ return getLabel(it).toLowerCase().indexOf(q)>-1; }).slice(0,200);
      idx=-1;
      if(!filtered.length){ dd.innerHTML='<div style="padding:10px 12px;font-size:12px;color:var(--muted,#9ca3af);font-style:italic">No matches</div>'; dd.style.display='block'; return; }
      dd.innerHTML=filtered.map(function(it,i){
        return '<div class="ml-opt" data-i="'+i+'" style="padding:8px 12px;cursor:pointer;font-size:12.5px;border-bottom:1px solid var(--border,rgba(0,0,0,.05))">'+_esc(getLabel(it))+'</div>';
      }).join('');
      dd.style.display='block';
      Array.prototype.forEach.call(dd.querySelectorAll('.ml-opt'),function(el){
        el.addEventListener('mousedown',function(e){ e.preventDefault(); _pick(parseInt(el.getAttribute('data-i'),10)); });
      });
    }
    function _hl(){ Array.prototype.forEach.call(dd.querySelectorAll('.ml-opt'),function(el,i){ el.style.background=(i===idx)?'rgba(37,99,235,.08)':''; }); var a=dd.querySelector('.ml-opt[data-i="'+idx+'"]'); if(a) a.scrollIntoView({block:'nearest'}); }
    function _pick(i){ var it=filtered[i]; if(!it) return; chosen=true; input.value=getLabel(it); dd.style.display='none'; onSelect(getValue(it), it); }
    input.addEventListener('focus',function(){ _render(input.value); });
    input.addEventListener('input',function(){ chosen=false; onSelect(null,null); _render(input.value); });
    input.addEventListener('keydown',function(e){
      if(dd.style.display==='none'){ if(e.key==='ArrowDown'){ _render(input.value); e.preventDefault(); } return; }
      if(e.key==='ArrowDown'){ idx=Math.min(filtered.length-1,idx+1); _hl(); e.preventDefault(); }
      else if(e.key==='ArrowUp'){ idx=Math.max(0,idx-1); _hl(); e.preventDefault(); }
      else if(e.key==='Enter'){ if(idx<0) idx=0; _pick(idx); e.preventDefault(); }
      else if(e.key==='Escape'){ dd.style.display='none'; e.preventDefault(); }
    });
    var _outside=function(e){ if(!document.body.contains(host)){ document.removeEventListener('mousedown',_outside); return; } if(!host.contains(e.target)) dd.style.display='none'; };
    document.addEventListener('mousedown',_outside);
    return { focus:function(){ input.focus(); }, setItems:function(n){ items=n||[]; if(document.activeElement===input) _render(input.value); } };
  }

  function _ensureGodowns(cb){
    if(_mlGodowns){ cb(_mlGodowns); return; }
    fetch('/api/inventory_godown/godowns/list').then(function(r){return r.json();})
      .then(function(d){ _mlGodowns=(d.godowns||d.rows||[]); cb(_mlGodowns); })
      .catch(function(){ _mlGodowns=[]; cb(_mlGodowns); });
  }
  function _ensureMaterials(cb){
    if(_mlMaterials){ cb(_mlMaterials); return; }
    fetch('/api/inventory_mgmt/items?department=RM').then(function(r){return r.json();})
      .then(function(d){ _mlMaterials=(d.items||[]).map(function(it){return {id:it.id,name:it.name||it.material_name||''};}); cb(_mlMaterials); })
      .catch(function(){ _mlMaterials=[]; cb(_mlMaterials); });
  }

  function _ensureModal(){
    var id='materialLocksModal';
    var modal=document.getElementById(id);
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id=id; modal.className='modal-overlay'; modal.style.cssText='z-index:1000';
    modal.innerHTML=
      '<div class="modal" style="width:780px;max-width:96vw;max-height:90vh;display:flex;'
      + 'flex-direction:column;background:var(--card,#fff);border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 24px 64px rgba(0,0,0,.3)">'
      + '<div style="padding:16px 20px;border-bottom:1px solid var(--border,rgba(0,0,0,.09));'
      + 'display:flex;align-items:flex-start;gap:12px;flex-shrink:0;'
      + 'background:linear-gradient(135deg,rgba(70,72,212,.06),rgba(129,39,207,.02))">'
      + '<div style="flex:1">'
      + '<div style="font-size:15px;font-weight:800;color:var(--text,#111)">🔒 Material Lock</div>'
      + '<div style="font-size:11px;color:var(--muted,#9ca3af);margin-top:2px">'
      + 'Lock or allow a specific material for issue — by entry date or GRN, per location. Independent of FEFO.</div>'
      + '</div>'
      + '<button onclick="document.getElementById(\'materialLocksModal\').classList.remove(\'open\',\'show\')" '
      + 'style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted,#9ca3af);line-height:1">✕</button>'
      + '</div>'
      + '<div id="ml-toolbar" style="flex-shrink:0"></div>'
      + '<div id="ml-body" style="overflow-y:auto;padding:14px 18px;flex:0 1 auto"></div>'
      + '<div id="ml-footer" style="padding:12px 18px;border-top:1px solid var(--border,rgba(0,0,0,.09));'
      + 'background:var(--surface,#f9fafb);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0"></div>'
      + '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  window.openMaterialLocksModal=function(){ var m=_ensureModal(); m.classList.add('open'); m.classList.add('show'); _mlLoadList(); };
  function _close(){ var m=document.getElementById('materialLocksModal'); if(m){ m.classList.remove('open'); m.classList.remove('show'); } }
  window._mlClose=_close;

  // ── List view ────────────────────────────────────────────────────────
  window._mlLoadList=function(){
    var body=document.getElementById('ml-body');
    var tb=document.getElementById('ml-toolbar');
    var footer=document.getElementById('ml-footer');
    if(body) body.innerHTML='<div style="padding:30px;text-align:center;color:var(--muted,#9ca3af)">Loading…</div>';
    if(tb) tb.innerHTML='';
    fetch('/api/inventory_mgmt/material_locks').then(function(r){return r.json();})
      .then(function(d){
        if(d.status!=='ok'){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">'+_esc(d.message||'Load failed')+'</div>'; return; }
        _mlCanManage=!!d.can_manage;
        var locks=d.locks||[];
        if(footer){
          footer.innerHTML =
            (_mlCanManage
              ? '<button onclick="_mlOpenNew()" class="btn btn-primary" style="margin-right:auto">＋ New lock rule</button>'
              : '<span style="margin-right:auto;font-size:11px;color:var(--muted,#9ca3af)">View only — a Manager can edit these rules.</span>')
            + '<button onclick="_mlClose()" class="btn">Close</button>';
        }
        if(!locks.length){
          if(body) body.innerHTML='<div style="padding:34px;text-align:center;color:var(--muted,#9ca3af);font-size:13px">'
            + 'No lock rules yet.'+(_mlCanManage?'<br><span style="font-size:11px">Use “＋ New lock rule” to lock a material for issue.</span>':'')+'</div>';
          return;
        }
        if(body) body.innerHTML=locks.map(_mlRowHtml).join('');
      })
      .catch(function(e){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">Network error: '+_esc(e.message)+'</div>'; });
  };

  function _mlRowHtml(r){
    var isBlock=r.mode==='block';
    var modePill='<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:9.5px;font-weight:800;letter-spacing:.3px;'
      + (isBlock?'background:rgba(220,38,38,.10);color:#991b1b">🔒 BLOCK':'background:rgba(13,148,136,.12);color:#0f766e">✓ ALLOW')+'</span>';
    var param=(r.param_type==='grn')
      ? 'GRN <strong style="font-family:monospace;color:#0d9488">'+_esc(r.grn_no||('#'+r.grn_id))+'</strong>'
      : (r.param_type==='batch')
        ? 'Batch <strong style="font-family:monospace;color:#0d9488">'+_esc(r.batch_no||'')+'</strong>'
        : 'Entered <strong>before '+_fmtDate(r.cutoff_date)+'</strong> <span style="color:var(--muted,#9ca3af)">(incl. opening stock)</span>';
    var loc=r.godown_id?_esc(r.godown_name||('#'+r.godown_id)):'All locations';
    var dim=r.is_active?'':'opacity:.5;';
    var actions=_mlCanManage
      ? '<div style="display:flex;gap:6px;margin-top:8px">'
        + '<button onclick="_mlToggle('+r.lock_id+')" class="btn" style="padding:4px 11px">'+(r.is_active?'Deactivate':'Activate')+'</button>'
        + '<button onclick="_mlDelete('+r.lock_id+')" class="btn" style="padding:4px 11px;color:#dc2626">Delete</button>'
        + '</div>'
      : '';
    return '<div style="padding:12px;border:1px solid var(--border,rgba(0,0,0,.09));border-radius:9px;margin-bottom:9px;background:var(--card,#fff);'+dim+'">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + modePill
      + '<strong style="font-size:13px;color:var(--text,#0f172a)">'+_esc(r.material_name||('Material #'+r.material_id))+'</strong>'
      + (r.is_active?'':'<span style="font-size:9.5px;font-weight:700;color:var(--muted,#9ca3af);text-transform:uppercase">· inactive</span>')
      + '</div>'
      + '<div style="font-size:11.5px;color:var(--text,#374151);margin-top:5px">'+param+'</div>'
      + '<div style="font-size:11px;color:var(--muted,#6b7280);margin-top:3px">📍 '+loc+(r.note?(' · '+_esc(r.note)):'')+'</div>'
      + '<div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:4px">By '+_esc(r.created_by)+' · '+_fmtDate(r.created_at)+'</div>'
      + actions
      + '</div>';
  }

  window._mlToggle=function(id){
    fetch('/api/inventory_mgmt/material_locks/'+id+'/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Updated','success',2200); _mlLoadList(); } else _toast(d.message||'Failed','error',4000);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };
  window._mlDelete=function(id){
    if(!confirm('Delete this lock rule? Material it was blocking will become scannable again.')) return;
    fetch('/api/inventory_mgmt/material_locks/'+id,{method:'DELETE'})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Deleted','success',2200); _mlLoadList(); } else _toast(d.message||'Failed','error',4000);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };

  // ── New-rule form ──────────────────────────────────────────────────────
  var _mlForm={ material_id:null, mode:'block', param_type:'before_date', godown_id:'', cutoff_date:'', grn_id:null, batch_no:'' };

  window._mlOpenNew=function(){
    if(!_mlCanManage){ _toast('Only a Manager can manage material locks','error'); return; }
    _mlForm={ material_id:null, mode:'block', param_type:'before_date', godown_id:'', cutoff_date:'', grn_id:null, batch_no:'' };
    _ensureGodowns(function(){ _ensureMaterials(function(){ _mlRenderForm(); }); });
  };

  function _mlRenderForm(){
    var body=document.getElementById('ml-body');
    var footer=document.getElementById('ml-footer');
    if(!body) return;
    var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--muted,#6b7280);margin:14px 0 5px';
    var inp='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,rgba(0,0,0,.18));border-radius:8px;font-size:12.5px;background:var(--card,#fff);color:var(--text,#111)';
    body.innerHTML =
      '<div style="font-size:13px;font-weight:800;color:var(--text,#111);margin-bottom:4px">New lock rule</div>'
      + '<label style="'+lbl+';margin-top:6px">Parameter</label>'
      + '<div style="display:flex;gap:8px">'
      + '<button type="button" id="ml-pt-before_date" onclick="_mlSetParam(\'before_date\')" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.12));background:#0d9488;color:#fff;font-weight:700;font-size:12px;cursor:pointer">Before a date</button>'
      + '<button type="button" id="ml-pt-grn" onclick="_mlSetParam(\'grn\')" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.12));background:var(--card,#fff);color:var(--text,#374151);font-weight:700;font-size:12px;cursor:pointer">Specific GRN</button>'
      + '<button type="button" id="ml-pt-batch" onclick="_mlSetParam(\'batch\')" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.12));background:var(--card,#fff);color:var(--text,#374151);font-weight:700;font-size:12px;cursor:pointer">Specific batch</button>'
      + '</div>'
      + '<label style="'+lbl+'">Material * <span style="font-weight:600;text-transform:none;color:var(--muted,#9ca3af);letter-spacing:0">— type to search, ↑/↓ then Enter</span></label>'
      + '<div style="display:flex;gap:10px;align-items:stretch">'
      + '<div id="ml-material-combo" style="flex:1;min-width:0"></div>'
      + '<div id="ml-mode-toggle" role="switch" tabindex="0" onclick="_mlToggleMode()" '
      + 'onkeydown="if(event.key===\' \'||event.key===\'Enter\'){event.preventDefault();_mlToggleMode();}" title="Toggle Block / Allow" '
      + 'style="flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;'
      + 'border:1px solid var(--border,rgba(0,0,0,.18));border-radius:8px;padding:0 12px;background:var(--card,#fff);white-space:nowrap">'
      + '<span id="ml-mode-icon" style="font-size:13px">🔒</span>'
      + '<span id="ml-mode-text" style="font-size:12px;font-weight:800;letter-spacing:.2px">Block</span>'
      + '<span style="position:relative;width:38px;height:21px;flex:0 0 auto">'
      + '<span id="ml-mode-track" style="position:absolute;inset:0;border-radius:21px;background:#ef4444;transition:background .2s"></span>'
      + '<span id="ml-mode-knob" style="position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .2s"></span>'
      + '</span></div></div>'
      + '<div id="ml-param-panel"></div>'
      + '<label style="'+lbl+'">Note (optional)</label>'
      + '<input id="ml-note" type="text" placeholder="Reason for this rule" style="'+inp+'">';
    if(footer){
      footer.innerHTML='<button onclick="_mlLoadList()" class="btn" style="margin-right:auto">← Back</button>'
        + '<button onclick="_mlSubmit()" class="btn btn-primary">Save rule</button>';
    }
    _mlForm.material_id=null;
    _mlMountCombo('ml-material-combo',{
      items:_mlMaterials||[],
      placeholder:'— type to search a material —',
      getLabel:function(p){ return p.name; },
      getValue:function(p){ return p.id; },
      onSelect:function(v){ _mlForm.material_id=v?parseInt(v,10):null; _mlForm.grn_id=null; _mlForm.batch_no=''; _mlForm.godown_id=''; _mlLoadItemLocations(); if(_mlForm.param_type==='grn') _mlLoadGrns(); if(_mlForm.param_type==='batch') _mlLoadBatches(); }
    });
    _mlSetMode('block'); _mlSetParam('before_date'); _mlRenderParamPanel();
  }

  function _mlLoadItemLocations(){
    var sel=document.getElementById('ml-godown');
    if(!sel) return;
    if(!_mlForm.material_id){ sel.innerHTML='<option value="">All locations</option>'; return; }
    var prev=sel.value;
    sel.innerHTML='<option value="">Loading…</option>';
    fetch('/api/inventory_mgmt/material_locks/item_locations/'+_mlForm.material_id)
      .then(function(r){return r.json();}).then(function(d){
        var locs=(d&&d.locations)||[];
        if(!locs.length){ sel.innerHTML='<option value="">No live stock of this material anywhere</option>'; return; }
        sel.innerHTML='<option value="">All locations where it resides</option>'
          + locs.map(function(l){ return '<option value="'+l.id+'">'+_esc(l.name||('#'+l.id))+' · '+l.box_count+' box'+(l.box_count==1?'':'es')+'</option>'; }).join('');
        if(prev && sel.querySelector('option[value="'+prev+'"]')) sel.value=prev;
      }).catch(function(){ sel.innerHTML='<option value="">Could not load locations</option>'; });
  }

  window._mlToggleMode=function(){ _mlSetMode(_mlForm.mode==='block'?'allow':'block'); };
  window._mlSetMode=function(m){
    _mlForm.mode=m; var block=(m==='block');
    var icon=document.getElementById('ml-mode-icon'), text=document.getElementById('ml-mode-text');
    var track=document.getElementById('ml-mode-track'), knob=document.getElementById('ml-mode-knob');
    if(icon) icon.textContent=block?'🔒':'✓';
    if(text){ text.textContent=block?'Block':'Allow'; text.style.color=block?'#b91c1c':'#0f766e'; }
    if(track) track.style.background=block?'#ef4444':'#0d9488';
    if(knob) knob.style.transform=block?'translateX(0)':'translateX(17px)';
  };
  window._mlSetParam=function(p){
    _mlForm.param_type=p;
    var ids={before_date:'ml-pt-before_date', grn:'ml-pt-grn', batch:'ml-pt-batch'};
    Object.keys(ids).forEach(function(k){
      var el=document.getElementById(ids[k]); if(!el) return;
      var on=(p===k);
      el.style.background=on?'#0d9488':'var(--card,#fff)';
      el.style.color=on?'#fff':'var(--text,#374151)';
    });
    _mlRenderParamPanel();
  };

  function _mlLocSelectHtml(inp){
    var locOpts='<option value="">All locations</option>'
      + (_mlGodowns||[]).map(function(g){ return '<option value="'+g.id+'">'+_esc(g.name)+'</option>'; }).join('');
    return '<select id="ml-godown" style="'+inp+'">'+locOpts+'</select>';
  }

  function _mlRenderParamPanel(){
    var panel=document.getElementById('ml-param-panel');
    if(!panel) return;
    var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--muted,#6b7280);margin:0 0 5px';
    var inp='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,rgba(0,0,0,.18));border-radius:8px;font-size:12.5px;background:var(--card,#fff);color:var(--text,#111)';
    if(_mlForm.param_type==='before_date'){
      panel.innerHTML=
        '<div style="display:flex;gap:12px;margin-top:14px">'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Cutoff date *</label><input id="ml-cutoff" type="date" style="'+inp+'"></div>'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Location</label>'+_mlLocSelectHtml(inp)+'</div>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:5px">Material of this item entered <strong>before</strong> this date is affected. Opening stock always counts as before.</div>';
    } else if(_mlForm.param_type==='batch'){
      panel.innerHTML=
        '<div style="display:flex;gap:12px;margin-top:14px;align-items:flex-start">'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Batch * <span style="font-weight:600;text-transform:none;color:var(--muted,#9ca3af);letter-spacing:0">— in-stock batches only</span></label><div id="ml-batch-combo"></div></div>'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Location</label>'+_mlLocSelectHtml(inp)+'</div>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:5px">Only this batch of the selected material is affected. Shows batches with positive stock only.</div>';
      _mlForm.batch_no=''; _mlLoadBatches();
    } else {
      panel.innerHTML=
        '<div style="display:flex;gap:12px;margin-top:14px;align-items:flex-start">'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">GRN * <span style="font-weight:600;text-transform:none;color:var(--muted,#9ca3af);letter-spacing:0">— type, ↑/↓, Enter</span></label><div id="ml-grn-combo"></div></div>'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Location</label>'+_mlLocSelectHtml(inp)+'</div>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--muted,#9ca3af);margin-top:5px">Only this material on the selected GRN is affected.</div>';
      _mlForm.grn_id=null; _mlLoadGrns();
    }
    _mlLoadItemLocations();
  }

  function _mlLoadGrns(){
    var combo=_mlMountCombo('ml-grn-combo',{
      items:[], placeholder:'Loading GRNs…',
      getLabel:function(g){ return (g.grn_no||('GRN #'+g.grn_id))+(g.grn_date?(' · '+_fmtDate(g.grn_date)):''); },
      getValue:function(g){ return g.grn_id; },
      onSelect:function(v){ _mlForm.grn_id=v?parseInt(v,10):null; }
    });
    if(!_mlForm.material_id){ var hi=document.querySelector('#ml-grn-combo input'); if(hi){ hi.placeholder='Select a material first'; hi.disabled=true; } return; }
    var hi0=document.querySelector('#ml-grn-combo input'); if(hi0) hi0.disabled=false;
    fetch('/api/inventory_mgmt/material_locks/grns?material_id='+_mlForm.material_id)
      .then(function(r){return r.json();}).then(function(d){
        var list=(d&&d.grns)||[];
        if(combo) combo.setItems(list);
        var hostInput=document.querySelector('#ml-grn-combo input');
        if(hostInput) hostInput.placeholder=list.length?'— type to search this material\'s GRNs —':'No GRNs contain this material';
      }).catch(function(){ var hostInput=document.querySelector('#ml-grn-combo input'); if(hostInput) hostInput.placeholder='Could not load GRNs'; });
  }

  function _mlLoadBatches(){
    var combo=_mlMountCombo('ml-batch-combo',{
      items:[], placeholder:'Loading batches…',
      getLabel:function(b){ return b.batch_no + '  ·  ' + (b.qty||0) + (b.uom?(' '+b.uom):'') + ' (' + b.box_count + ' box' + (b.box_count==1?'':'es') + ')'; },
      getValue:function(b){ return b.batch_no; },
      onSelect:function(v){ _mlForm.batch_no = v || ''; }
    });
    if(!_mlForm.material_id){ var hi=document.querySelector('#ml-batch-combo input'); if(hi){ hi.placeholder='Select a material first'; hi.disabled=true; } return; }
    var hi0=document.querySelector('#ml-batch-combo input'); if(hi0) hi0.disabled=false;
    fetch('/api/inventory_mgmt/material_locks/batches?material_id='+_mlForm.material_id)
      .then(function(r){return r.json();}).then(function(d){
        var list=(d&&d.batches)||[];
        if(combo) combo.setItems(list);
        var hostInput=document.querySelector('#ml-batch-combo input');
        if(hostInput) hostInput.placeholder=list.length?'— type to search in-stock batches —':'No in-stock batches for this material';
      }).catch(function(){ var hostInput=document.querySelector('#ml-batch-combo input'); if(hostInput) hostInput.placeholder='Could not load batches'; });
  }

  window._mlSubmit=function(){
    var pid=_mlForm.material_id;
    if(!pid){ _toast('Select a material','error',3000); return; }
    var payload={ material_id:pid, mode:_mlForm.mode, param_type:_mlForm.param_type };
    var g=document.getElementById('ml-godown'); if(g&&g.value) payload.godown_id=parseInt(g.value,10);
    var n=document.getElementById('ml-note'); if(n&&n.value.trim()) payload.note=n.value.trim();
    if(_mlForm.param_type==='before_date'){
      var c=document.getElementById('ml-cutoff');
      if(!c||!c.value){ _toast('Pick a cutoff date','error',3000); return; }
      payload.cutoff_date=c.value;
    } else if(_mlForm.param_type==='batch'){
      if(!_mlForm.batch_no){ _toast('Select a batch','error',3000); return; }
      payload.batch_no=_mlForm.batch_no;
    } else {
      if(!_mlForm.grn_id){ _toast('Select a GRN','error',3000); return; }
      payload.grn_id=_mlForm.grn_id;
    }
    fetch('/api/inventory_mgmt/material_locks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Lock rule saved','success',3000); _mlLoadList(); } else _toast(d.message||'Save failed','error',4500);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4500); });
  };

  /* ── nav (Admin section) ──────────────────────────────────────────── */
  function _injectNav(){
    if(document.getElementById('mlk-nav-item')) return;
    var navBody=document.querySelector('.inv-nav-body'); if(!navBody) return;
    var section=Array.prototype.slice.call(navBody.querySelectorAll('.inv-nav-section')).find(function(s){
      var l=s.querySelector('.inv-nav-section-label'); return l && l.textContent==='Admin'; });
    if(!section){ section=document.createElement('div'); section.className='inv-nav-section';
      section.innerHTML='<div class="inv-nav-section-label">Admin</div>'; navBody.appendChild(section); }
    var item=document.createElement('div'); item.className='inv-nav-item'; item.id='mlk-nav-item';
    item.onclick=function(){ openMaterialLocksModal(); };
    item.innerHTML='<span class="ico">🔒</span><span>Material Lock</span>';
    section.appendChild(item);
  }
  function _applyAccess(){
    var item=document.getElementById('mlk-nav-item'); if(!item) return;
    var a=window._invAccess;
    var allowed=!a||!a.ready||a.is_admin||(a.access&&a.access.material_lock!=='off'&&a.access.material_lock!==false);
    item.style.display=allowed?'':'none';
  }
  document.addEventListener('inv-access-ready',_applyAccess);
  function _boot(){ _injectNav(); _applyAccess(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  console.log('✅ inventory_material_lock.js loaded (Phase 4, pm layout)');
})();
