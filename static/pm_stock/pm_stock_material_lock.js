/* ════════════════════════════════════════════════════════════════════════
   MATERIAL LOCK  —  Manager/admin lock or allow a SPECIFIC item from OUT
   ────────────────────────────────────────────────────────────────────────
   A Manager (by designation) or admin creates rules that BLOCK or ALLOW a
   specific packaging-material item from being scanned into a Material OUT
   voucher at a chosen location. Fully INDEPENDENT of FIFO.

   Per-item rule, two parameter types:
     • before_date — that item's material entered before a cutoff date
                     (opening stock always counts as "before").
     • grn         — that item on one specific GRN.
   Modes: block (locked) | allow (explicitly permitted; overrides a block).

   Surface: openMaterialLocksModal()   (sidebar, manager/admin only)

   Endpoints (see __init__.py):
     GET    /api/pm_stock/material_locks
     POST   /api/pm_stock/material_locks                 {product_id,mode,param_type,...}
     POST   /api/pm_stock/material_locks/<id>/toggle
     DELETE /api/pm_stock/material_locks/<id>
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  function _toast(m,k,ms){ if(typeof showToast==='function') showToast(m,k||'info',ms||3000); }
  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function _fmtDate(s){
    if(!s) return '';
    var m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (m[3]+'/'+m[2]+'/'+m[1]) : String(s);
  }

  var _mlGodowns=null, _mlProducts=null, _mlCanManage=false;

  /* ── Reusable type-search combobox with keyboard nav ──────────────────
     mountCombo(hostId, {items, placeholder, getLabel, getValue, onSelect})
       items     : array of objects
       getLabel  : fn(item) → display string (searched + shown)
       getValue  : fn(item) → value stored on select
       onSelect  : fn(value, item|null) called on pick/clear
     Renders a text input + an absolutely-positioned results list.
     Keys: ArrowDown/ArrowUp move the highlight, Enter selects the
     highlighted row, Escape closes. Typing filters (case-insensitive,
     substring). Picking fills the input and stores the value. Clearing the
     text resets the value to null. */
  function _mlMountCombo(hostId, opts){
    var host=document.getElementById(hostId);
    if(!host) return null;
    var items=opts.items||[];
    var getLabel=opts.getLabel||function(x){return String(x);};
    var getValue=opts.getValue||function(x){return x;};
    var onSelect=opts.onSelect||function(){};
    var inpCss='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));'
      + 'border-radius:8px;font-size:12.5px;background:var(--hinput,#fff);color:var(--text,#111);outline:none';
    host.style.position='relative';
    host.innerHTML =
      '<input type="text" autocomplete="off" placeholder="'+_esc(opts.placeholder||'Type to search…')+'" '
      + 'style="'+inpCss+'">'
      + '<div class="ml-combo-dd" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 3px);z-index:60;'
      + 'background:var(--surface,#fff);border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;'
      + 'box-shadow:0 12px 30px rgba(0,0,0,.16);max-height:240px;overflow-y:auto"></div>';
    var input=host.querySelector('input');
    var dd=host.querySelector('.ml-combo-dd');
    var idx=-1, filtered=[], chosen=false;

    function _render(q){
      q=(q||'').toLowerCase().trim();
      filtered = !q ? items.slice(0,200)
                    : items.filter(function(it){ return getLabel(it).toLowerCase().indexOf(q)>-1; }).slice(0,200);
      if(!filtered.length){
        dd.innerHTML='<div style="padding:10px 12px;font-size:12px;color:var(--hmuted,#9ca3af)">No match</div>';
      } else {
        dd.innerHTML=filtered.map(function(it,i){
          return '<div class="ml-combo-row" data-i="'+i+'" '
            + 'style="padding:8px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));'
            + (i===idx?'background:rgba(70,72,212,.12);':'')+'color:var(--text,#0f172a)">'+_esc(getLabel(it))+'</div>';
        }).join('');
      }
      dd.style.display='block';
    }
    function _setActive(n){
      idx=n;
      Array.prototype.forEach.call(dd.querySelectorAll('.ml-combo-row'), function(el){
        var on=(parseInt(el.getAttribute('data-i'),10)===idx);
        el.style.background = on ? 'rgba(70,72,212,.12)' : '';
        if(on) el.scrollIntoView({block:'nearest'});
      });
    }
    function _pick(it){
      chosen=true;
      input.value=getLabel(it);
      onSelect(getValue(it), it);
      dd.style.display='none'; idx=-1;
    }
    input.addEventListener('focus', function(){ _render(input.value); });
    input.addEventListener('input', function(){
      chosen=false; onSelect(null, null);   // typing invalidates a prior pick
      idx=-1; _render(input.value);
    });
    input.addEventListener('keydown', function(e){
      if(dd.style.display==='none' && (e.key==='ArrowDown'||e.key==='ArrowUp')){ _render(input.value); }
      if(e.key==='ArrowDown'){ e.preventDefault(); if(filtered.length) _setActive(Math.min(idx+1, filtered.length-1)); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); if(filtered.length) _setActive(Math.max(idx-1, 0)); }
      else if(e.key==='Enter'){
        e.preventDefault();
        if(idx>=0 && filtered[idx]) _pick(filtered[idx]);
        else if(filtered.length===1) _pick(filtered[0]);
      }
      else if(e.key==='Escape'){ dd.style.display='none'; idx=-1; }
    });
    dd.addEventListener('mousedown', function(e){
      var row=e.target.closest('.ml-combo-row');
      if(!row) return;
      e.preventDefault();
      var i=parseInt(row.getAttribute('data-i'),10);
      if(filtered[i]) _pick(filtered[i]);
    });
    var _outside = function(e){
      if(!document.body.contains(host)){      // host was re-rendered away
        document.removeEventListener('mousedown', _outside); return;
      }
      if(!host.contains(e.target)) dd.style.display='none';
    };
    document.addEventListener('mousedown', _outside);
    return {
      focus:function(){ input.focus(); },
      setItems:function(newItems){ items=newItems||[]; if(document.activeElement===input) _render(input.value); }
    };
  }

  function _ensureGodowns(cb){
    if(_mlGodowns){ cb(_mlGodowns); return; }
    fetch('/api/pm_stock/godowns').then(function(r){return r.json();})
      .then(function(rows){ _mlGodowns=Array.isArray(rows)?rows:(rows.godowns||[]); cb(_mlGodowns); })
      .catch(function(){ _mlGodowns=[]; cb(_mlGodowns); });
  }
  function _ensureProducts(cb){
    if(_mlProducts){ cb(_mlProducts); return; }
    fetch('/api/pm_stock/products').then(function(r){return r.json();})
      .then(function(rows){ _mlProducts=Array.isArray(rows)?rows:[]; cb(_mlProducts); })
      .catch(function(){ _mlProducts=[]; cb(_mlProducts); });
  }

  function _ensureModal(){
    var id='materialLocksModal';
    var modal=document.getElementById(id);
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id=id; modal.className='modal-overlay'; modal.style.cssText='z-index:1000';
    modal.innerHTML=
      '<div class="modal" style="width:780px;max-width:96vw;max-height:90vh;display:flex;'
      + 'flex-direction:column;background:var(--surface,#fff);border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 24px 64px rgba(0,0,0,.3)">'
      + '<div style="padding:16px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));'
      + 'display:flex;align-items:flex-start;gap:12px;flex-shrink:0;'
      + 'background:linear-gradient(135deg,rgba(70,72,212,.06),rgba(129,39,207,.02))">'
      + '<div style="flex:1">'
      + '<div style="font-size:15px;font-weight:800;color:var(--htxtb,#111)">🔒 Material Lock</div>'
      + '<div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:2px">'
      + 'Lock or allow a specific item for Material OUT — by entry date or GRN, per location. Independent of FIFO.</div>'
      + '</div>'
      + '<button onclick="document.getElementById(\'materialLocksModal\').classList.remove(\'open\')" '
      + 'style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hmuted,#9ca3af);line-height:1">✕</button>'
      + '</div>'
      + '<div id="ml-toolbar" style="flex-shrink:0"></div>'
      + '<div id="ml-body" style="overflow-y:auto;padding:14px 18px;flex:0 1 auto"></div>'
      + '<div id="ml-footer" style="padding:12px 18px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));'
      + 'background:var(--hsurf2,#f9fafb);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0"></div>'
      + '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  window.openMaterialLocksModal=function(){
    _ensureModal().classList.add('open');
    _mlLoadList();
  };

  // ── List view ───────────────────────────────────────────────────────
  window._mlLoadList = function(){
    var body=document.getElementById('ml-body');
    var tb=document.getElementById('ml-toolbar');
    var footer=document.getElementById('ml-footer');
    if(body) body.innerHTML='<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>';
    if(tb) tb.innerHTML='';
    fetch('/api/pm_stock/material_locks').then(function(r){return r.json();})
      .then(function(d){
        if(d.status!=='ok'){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">'+_esc(d.message||'Load failed')+'</div>'; return; }
        _mlCanManage=!!d.can_manage;
        var locks=d.locks||[];
        if(footer){
          footer.innerHTML =
            (_mlCanManage
              ? '<button onclick="_mlOpenNew()" class="btn btn-primary" style="margin-right:auto">＋ New lock rule</button>'
              : '<span style="margin-right:auto;font-size:11px;color:var(--hmuted,#9ca3af)">View only — a Manager can edit these rules.</span>')
            + '<button onclick="document.getElementById(\'materialLocksModal\').classList.remove(\'open\')" class="btn btn-outline">Close</button>';
        }
        if(!locks.length){
          if(body) body.innerHTML='<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">'
            + 'No lock rules yet.'+(_mlCanManage?'<br><span style="font-size:11px">Use “＋ New lock rule” to lock an item for Material OUT.</span>':'')+'</div>';
          return;
        }
        if(body) body.innerHTML=locks.map(_mlRowHtml).join('');
      })
      .catch(function(e){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">Network error: '+_esc(e.message)+'</div>'; });
  }

  function _mlRowHtml(r){
    var isBlock=r.mode==='block';
    var modePill='<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:9.5px;font-weight:800;letter-spacing:.3px;'
      + (isBlock?'background:rgba(220,38,38,.10);color:#991b1b">🔒 BLOCK':'background:rgba(13,148,136,.12);color:#0f766e">✓ ALLOW')+'</span>';
    var param = (r.param_type==='grn')
      ? 'GRN <strong style="font-family:monospace;color:#0d9488">'+_esc(r.grn_no||('#'+r.grn_id))+'</strong>'
      : 'Entered <strong>before '+_fmtDate(r.cutoff_date)+'</strong> <span style="color:var(--hmuted,#9ca3af)">(incl. opening stock)</span>';
    var loc = r.godown_id ? _esc(r.godown_name||('#'+r.godown_id)) : 'All locations';
    var dim = r.is_active ? '' : 'opacity:.5;';
    var actions = _mlCanManage
      ? '<div style="display:flex;gap:6px;margin-top:8px">'
        + '<button onclick="_mlToggle('+r.lock_id+')" class="btn btn-sm btn-outline" style="padding:4px 11px">'
        + (r.is_active?'Deactivate':'Activate')+'</button>'
        + '<button onclick="_mlDelete('+r.lock_id+')" class="btn btn-sm btn-danger" style="padding:4px 11px">Delete</button>'
        + '</div>'
      : '';
    return '<div style="padding:12px;border:1px solid var(--hbdr,rgba(0,0,0,.09));border-radius:9px;margin-bottom:9px;background:#fff;'+dim+'">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + modePill
      + '<strong style="font-size:13px;color:var(--text,#0f172a)">'+_esc(r.product_name_live||r.product_name||('Product #'+r.product_id))+'</strong>'
      + (r.is_active?'':'<span style="font-size:9.5px;font-weight:700;color:var(--hmuted,#9ca3af);text-transform:uppercase">· inactive</span>')
      + '</div>'
      + '<div style="font-size:11.5px;color:var(--htxt,#374151);margin-top:5px">'+param+'</div>'
      + '<div style="font-size:11px;color:var(--hmuted,#6b7280);margin-top:3px">📍 '+loc
      + (r.note?(' · '+_esc(r.note)):'')+'</div>'
      + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:4px">By '+_esc(r.created_by)+' · '+_fmtDate(r.created_at)+'</div>'
      + actions
      + '</div>';
  }

  window._mlToggle=function(id){
    fetch('/api/pm_stock/material_locks/'+id+'/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Updated','success',2200); _mlLoadList(); }
        else _toast(d.message||'Failed','error',4000);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };
  window._mlDelete=function(id){
    if(!confirm('Delete this lock rule? Material it was blocking will become scannable again.')) return;
    fetch('/api/pm_stock/material_locks/'+id,{method:'DELETE'})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Deleted','success',2200); _mlLoadList(); }
        else _toast(d.message||'Failed','error',4000);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };

  // ── New-rule form ─────────────────────────────────────────────────────
  var _mlForm={ product_id:null, product_name:'', mode:'block', param_type:'before_date', godown_id:'', cutoff_date:'', grn_id:null, grn_no:'' };

  window._mlOpenNew=function(){
    if(!_mlCanManage){ _toast('Only a Manager can manage material locks','error'); return; }
    _mlForm={ product_id:null, product_name:'', mode:'block', param_type:'before_date', godown_id:'', cutoff_date:'', grn_id:null, grn_no:'' };
    _ensureGodowns(function(){ _ensureProducts(function(){ _mlRenderForm(); }); });
  };

  function _mlRenderForm(){
    var body=document.getElementById('ml-body');
    var footer=document.getElementById('ml-footer');
    if(!body) return;
    var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);margin:14px 0 5px';
    var inp='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;font-size:12.5px';
    body.innerHTML =
      '<div style="font-size:13px;font-weight:800;color:var(--htxtb,#111);margin-bottom:4px">New lock rule</div>'

      // ① Parameter on top
      + '<label style="'+lbl+';margin-top:6px">Parameter</label>'
      + '<div style="display:flex;gap:8px">'
      + '<button type="button" id="ml-pt-before_date" onclick="_mlSetParam(\'before_date\')" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--hbdr,rgba(0,0,0,.12));background:#0d9488;color:#fff;font-weight:700;font-size:12px;cursor:pointer">Before a date</button>'
      + '<button type="button" id="ml-pt-grn" onclick="_mlSetParam(\'grn\')" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--hbdr,rgba(0,0,0,.12));background:#fff;color:var(--htxt,#374151);font-weight:700;font-size:12px;cursor:pointer">Specific GRN</button>'
      + '</div>'

      // ② Item + Block/Allow toggle on one row (toggle beside the name)
      + '<label style="'+lbl+'">Item / material * <span style="font-weight:600;text-transform:none;color:var(--hmuted,#9ca3af);letter-spacing:0">— type to search, ↑/↓ then Enter</span></label>'
      + '<div style="display:flex;gap:10px;align-items:stretch">'
      + '<div id="ml-product-combo" style="flex:1;min-width:0"></div>'
      + '<div id="ml-mode-toggle" role="switch" tabindex="0" onclick="_mlToggleMode()" '
      + 'onkeydown="if(event.key===\' \'||event.key===\'Enter\'){event.preventDefault();_mlToggleMode();}" '
      + 'title="Toggle Block / Allow" '
      + 'style="flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;'
      + 'border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;padding:0 12px;background:var(--hinput,#fff);white-space:nowrap">'
      + '<span id="ml-mode-icon" style="font-size:13px">🔒</span>'
      + '<span id="ml-mode-text" style="font-size:12px;font-weight:800;letter-spacing:.2px">Block</span>'
      + '<span style="position:relative;width:38px;height:21px;flex:0 0 auto">'
      + '<span id="ml-mode-track" style="position:absolute;inset:0;border-radius:21px;background:#ef4444;transition:background .2s"></span>'
      + '<span id="ml-mode-knob" style="position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .2s"></span>'
      + '</span>'
      + '</div>'
      + '</div>'

      // ③ Parameter-specific fields (each pairs its main field with Location)
      + '<div id="ml-param-panel"></div>'

      + '<label style="'+lbl+'">Note (optional)</label>'
      + '<input id="ml-note" type="text" placeholder="Reason for this rule" style="'+inp+'">';
    if(footer){
      footer.innerHTML='<button onclick="_mlLoadList()" class="btn btn-outline" style="margin-right:auto">← Back</button>'
        + '<button onclick="_mlSubmit()" class="btn btn-primary">Save rule</button>';
    }
    // Mount the searchable Item combobox (keyboard-navigable).
    _mlForm.product_id=null;
    _mlMountCombo('ml-product-combo', {
      items: _mlProducts||[],
      placeholder: '— type to search an item —',
      getLabel: function(p){ return p.product_name + (p.product_code?(' ['+p.product_code+']'):''); },
      getValue: function(p){ return p.id; },
      onSelect: function(v){
        _mlForm.product_id = v ? parseInt(v,10) : null;
        // Item changed → its GRNs and current locations change too.
        _mlForm.grn_id = null; _mlForm.godown_id = '';
        _mlLoadItemLocations();
        if(_mlForm.param_type === 'grn') _mlLoadGrns();
      }
    });
    _mlSetMode('block'); _mlSetParam('before_date'); _mlRenderParamPanel();
  }

  /* Populate the Location dropdown with ONLY the places the selected item
     currently resides (live in_stock). With no item picked, show a prompt. */
  function _mlLoadItemLocations(){
    var sel=document.getElementById('ml-godown');
    if(!sel) return;
    if(!_mlForm.product_id){
      sel.innerHTML='<option value="">All locations</option>';
      return;
    }
    var prev=sel.value;
    sel.innerHTML='<option value="">Loading…</option>';
    fetch('/api/pm_stock/material_locks/item_locations/'+_mlForm.product_id)
      .then(function(r){return r.json();}).then(function(d){
        var locs=(d&&d.locations)||[];
        if(!locs.length){
          sel.innerHTML='<option value="">No live stock of this item anywhere</option>';
          return;
        }
        sel.innerHTML='<option value="">All locations where it resides</option>'
          + locs.map(function(l){
              return '<option value="'+l.id+'">'+_esc(l.name||('#'+l.id))
                + (l.is_floor?' (Factory)':'')+' · '+l.box_count+' box'+(l.box_count==1?'':'es')+'</option>';
            }).join('');
        if(prev && sel.querySelector('option[value="'+prev+'"]')) sel.value=prev;
      }).catch(function(){ sel.innerHTML='<option value="">Could not load locations</option>'; });
  }

  window._mlSetProduct=function(v){ _mlForm.product_id=v?parseInt(v,10):null; };
  window._mlToggleMode=function(){ _mlSetMode(_mlForm.mode==='block'?'allow':'block'); };
  window._mlSetMode=function(m){
    _mlForm.mode=m;
    var block=(m==='block');
    var icon=document.getElementById('ml-mode-icon');
    var text=document.getElementById('ml-mode-text');
    var track=document.getElementById('ml-mode-track');
    var knob=document.getElementById('ml-mode-knob');
    if(icon) icon.textContent=block?'🔒':'✓';
    if(text){ text.textContent=block?'Block':'Allow'; text.style.color=block?'#b91c1c':'#0f766e'; }
    if(track) track.style.background=block?'#ef4444':'#0d9488';
    if(knob) knob.style.transform=block?'translateX(0)':'translateX(17px)';
  };
  window._mlSetParam=function(p){
    _mlForm.param_type=p;
    var bd=document.getElementById('ml-pt-before_date'), gn=document.getElementById('ml-pt-grn');
    if(bd){ bd.style.background=p==='before_date'?'#0d9488':'#fff'; bd.style.color=p==='before_date'?'#fff':'var(--htxt,#374151)'; }
    if(gn){ gn.style.background=p==='grn'?'#0d9488':'#fff'; gn.style.color=p==='grn'?'#fff':'var(--htxt,#374151)'; }
    _mlRenderParamPanel();
  };

  function _mlLocSelectHtml(inp){
    var locOpts='<option value="">All locations</option>'
      + (_mlGodowns||[]).map(function(g){
          return '<option value="'+g.id+'">'+_esc(g.name)+(g.is_floor?' (Factory)':'')+'</option>';
        }).join('');
    return '<select id="ml-godown" style="'+inp+'">'+locOpts+'</select>';
  }

  function _mlRenderParamPanel(){
    var panel=document.getElementById('ml-param-panel');
    if(!panel) return;
    var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);margin:0 0 5px';
    var inp='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;font-size:12.5px';
    if(_mlForm.param_type==='before_date'){
      // Cutoff date + Location side by side (half width each)
      panel.innerHTML=
        '<div style="display:flex;gap:12px;margin-top:14px">'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Cutoff date *</label>'
        + '<input id="ml-cutoff" type="date" style="'+inp+'"></div>'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Location</label>'
        + _mlLocSelectHtml(inp)+'</div>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">Material of this item entered <strong>before</strong> this date is affected. Opening stock always counts as before.</div>';
    } else {
      // GRN + Location side by side (half width each)
      panel.innerHTML=
        '<div style="display:flex;gap:12px;margin-top:14px;align-items:flex-start">'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">GRN * <span style="font-weight:600;text-transform:none;color:var(--hmuted,#9ca3af);letter-spacing:0">— type, ↑/↓, Enter</span></label>'
        + '<div id="ml-grn-combo"></div></div>'
        + '<div style="flex:1;min-width:0"><label style="'+lbl+'">Location</label>'
        + _mlLocSelectHtml(inp)+'</div>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">Only this item on the selected GRN is affected.</div>';
      _mlForm.grn_id=null;
      _mlLoadGrns();
    }
    // Whichever parameter mode, refresh the Location list to the item's
    // current locations (or the prompt if no item is chosen yet).
    _mlLoadItemLocations();
  }

  function _mlLoadGrns(){
    // Show a placeholder combo immediately, then populate once GRNs load.
    var combo=_mlMountCombo('ml-grn-combo', {
      items: [],
      placeholder: 'Loading GRNs…',
      getLabel: function(g){ return (g.grn_no||('GRN #'+g.id)) + (g.supplier?(' · '+g.supplier):''); },
      getValue: function(g){ return g.id; },
      onSelect: function(v){ _mlForm.grn_id = v ? parseInt(v,10) : null; }
    });
    // GRNs must be scoped to the selected item — pick an item first.
    if(!_mlForm.product_id){
      var hi=document.querySelector('#ml-grn-combo input');
      if(hi){ hi.placeholder='Select an item first'; hi.disabled=true; }
      return;
    }
    var hi0=document.querySelector('#ml-grn-combo input'); if(hi0) hi0.disabled=false;
    fetch('/api/pm_stock/material_locks/item_grns/'+_mlForm.product_id)
      .then(function(r){return r.json();})
      .then(function(d){
        var list=(d&&d.grns)||[];
        if(combo) combo.setItems(list);
        var hostInput=document.querySelector('#ml-grn-combo input');
        if(hostInput) hostInput.placeholder = list.length ? '— type to search this item\'s GRNs —' : 'No GRNs contain this item';
      })
      .catch(function(){
        var hostInput=document.querySelector('#ml-grn-combo input');
        if(hostInput) hostInput.placeholder='Could not load GRNs';
      });
  }

  window._mlSubmit=function(){
    var pid=_mlForm.product_id;
    if(!pid){ _toast('Select an item','error',3000); return; }
    var payload={ product_id:pid, mode:_mlForm.mode, param_type:_mlForm.param_type };
    var g=document.getElementById('ml-godown'); if(g&&g.value) payload.godown_id=parseInt(g.value,10);
    var n=document.getElementById('ml-note'); if(n&&n.value.trim()) payload.note=n.value.trim();
    if(_mlForm.param_type==='before_date'){
      var c=document.getElementById('ml-cutoff');
      if(!c||!c.value){ _toast('Pick a cutoff date','error',3000); return; }
      payload.cutoff_date=c.value;
    } else {
      if(!_mlForm.grn_id){ _toast('Select a GRN','error',3000); return; }
      payload.grn_id=_mlForm.grn_id;
    }
    fetch('/api/pm_stock/material_locks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Lock rule saved','success',3000); _mlLoadList(); }
        else _toast(d.message||'Save failed','error',4500);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4500); });
  };

})();
