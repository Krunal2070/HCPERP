/* ════════════════════════════════════════════════════════════════════════
   pm_stock_access_groups.js — Access Groups (admin)
   ────────────────────────────────────────────────────────────────────────
   Admin defines named GROUPS, sets feature access on the group, and assigns
   users to a group. Members inherit the group's access UNLESS they have an
   explicit per-user row (which still wins). Layered on top of the existing
   per-user User Access Control modal — opened via its "👥 Manage Groups"
   button.

   Endpoints (see __init__.py):
     GET    /api/pm_stock/access_groups
     POST   /api/pm_stock/access_groups/save           {group_id?,group_name,note,access}
     DELETE /api/pm_stock/access_groups/<id>
     GET    /api/pm_stock/access_groups/<id>/members
     POST   /api/pm_stock/access_groups/assign         {user_name, group_id}
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  function _toast(m,k,ms){ if(typeof showToast==='function') showToast(m,k||'info',ms||3000); }
  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  // Same feature set + labels as the per-user modal (keep in sync).
  var CATS = [
    // Sidebar fine-grained flags
    { key:'stock_pages',         label:'Stock View',             desc:'Default Stock View tab' },
    { key:'combined_view',       label:'Combined View',          desc:'Combined godown+floor view tab' },
    { key:'split_box',           label:'Split Box',              desc:'Split Box tool' },
    { key:'products',            label:'Products',               desc:'Products master tab' },
    { key:'suppliers',           label:'Suppliers',              desc:'Supplier Directory + PM Ledger' },
    { key:'voucher_log',         label:'Voucher Log',            desc:'Voucher Log + Log tabs' },
    { key:'new_voucher_entries', label:'New Voucher Entries',    desc:'Create GRN / DN / Allotment / Audit' },
    { key:'voucher_settings',    label:'Voucher # Settings',     desc:'Configure voucher numbering' },
    { key:'grn_labels',          label:'GRN Label Prints',       desc:'GRN label printing after save' },
    { key:'opening_labels',      label:'Opening Label Prints',   desc:'Opening Stock voucher + labels' },
    { key:'reprint_requests',    label:'Label Reprint Requests', desc:'Submit reprint requests' },
    { key:'material_request',    label:'Material Request',       desc:'Material Request tab + create' },
    { key:'material_movement',   label:'Material Movement',      desc:'Material Movement tab (IN/OUT)' },
    { key:'purchase_orders',     label:'Purchase Orders',        desc:'Purchase Orders tab' },
    { key:'stock_adjustment',    label:'Stock Adjustment',       desc:'Create stock adjustment vouchers' },
    { key:'pm_trs',              label:'PM TRS',                 desc:'PM Testing Requisition Slips' },
    { key:'reports',             label:'Reports',                desc:'Reports hub' },
    { key:'command_palette',     label:'Command Palette / Dock', desc:'Quick-action dock + Ctrl+K search' },
    // Sensitive
    { key:'material_lock',       label:'Material Lock',          desc:'Lock / allow material from OUT' },
    { key:'label_reissue',       label:'Label Reissue Approvals',desc:'Approve / reject reissue requests' },
    { key:'fifo_override',       label:'FIFO Override Approvals', desc:'Approve / reject FIFO bypass' },
    { key:'bom_manage',          label:'BOM Manager',            desc:'Create / edit FG product recipes (BOMs)' },
  ];

  var _groups = [], _editing = null;   // _editing = group object or {} for new

  function _modal(){
    var id='accessGroupsModal';
    var m=document.getElementById(id);
    if(m) return m;
    m=document.createElement('div'); m.id=id; m.className='modal-overlay'; m.style.cssText='z-index:1100';
    m.innerHTML =
      '<div class="modal" style="width:780px;max-width:96vw;max-height:90vh;display:flex;flex-direction:column;'
      + 'background:var(--surface,#fff);border-radius:14px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.32)">'
      + '<div style="padding:15px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));display:flex;align-items:center;'
      + 'justify-content:space-between;background:linear-gradient(135deg,rgba(70,72,212,.07),rgba(129,39,207,.02))">'
      + '<div><div style="font-size:14px;font-weight:800;color:var(--htxtb,#111)">👥 Access Groups</div>'
      + '<div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:2px">Create a group, set its feature access, and assign users. '
      + 'A user\'s own per-user settings (if any) override their group.</div></div>'
      + '<button onclick="document.getElementById(\'accessGroupsModal\').classList.remove(\'open\')" '
      + 'style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hmuted,#9ca3af)">✕</button>'
      + '</div>'
      + '<div id="ag-body" style="overflow-y:auto;padding:16px 20px;flex:1"></div>'
      + '<div id="ag-footer" style="padding:12px 20px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));'
      + 'background:var(--hsurf2,#f9fafb);display:flex;gap:10px;justify-content:flex-end"></div>'
      + '</div>';
    document.body.appendChild(m);
    return m;
  }

  window.openAccessGroupsModal = function(){
    _modal().classList.add('open');
    _loadGroups();
  };

  function _loadGroups(){
    _editing = null;
    var body=document.getElementById('ag-body'), footer=document.getElementById('ag-footer');
    if(body) body.innerHTML='<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>';
    fetch('/api/pm_stock/access_groups').then(function(r){return r.json();}).then(function(d){
      if(d.status!=='ok'){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">'+_esc(d.message||'Load failed')+'</div>'; return; }
      _groups=d.groups||[];
      _renderList();
    }).catch(function(e){ if(body) body.innerHTML='<div style="padding:20px;color:#b91c1c">Network error: '+_esc(e.message)+'</div>'; });
  }

  function _renderList(){
    var body=document.getElementById('ag-body'), footer=document.getElementById('ag-footer');
    if(footer) footer.innerHTML='<button onclick="_agNewGroup()" class="btn btn-primary" style="margin-right:auto">＋ New group</button>'
      + '<button onclick="document.getElementById(\'accessGroupsModal\').classList.remove(\'open\')" class="btn btn-outline">Close</button>';
    if(!_groups.length){
      body.innerHTML='<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">No groups yet.<br>'
        + '<span style="font-size:11px">Create a group to grant a set of features to many users at once.</span></div>';
      return;
    }
    body.innerHTML=_groups.map(function(g){
      var on=CATS.filter(function(c){return g.access[c.key];}).length;
      return '<div style="padding:13px;border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;margin-bottom:10px;background:#fff">'
        + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        + '<strong style="font-size:14px;color:var(--text,#0f172a)">'+_esc(g.group_name)+'</strong>'
        + '<span style="font-size:10px;font-weight:700;color:var(--nb-primary,#4648D4);background:rgba(70,72,212,.1);padding:2px 9px;border-radius:20px">'+on+' / '+CATS.length+' features</span>'
        + '<span style="font-size:10px;font-weight:700;color:#0f766e;background:rgba(13,148,136,.1);padding:2px 9px;border-radius:20px">'+(g.member_count||0)+' member'+((g.member_count==1)?'':'s')+'</span>'
        + '</div>'
        + (g.note?('<div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:4px">'+_esc(g.note)+'</div>'):'')
        + '<div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">'
        + '<button onclick="_agEditGroup('+g.group_id+')" class="btn btn-sm btn-outline">Edit features</button>'
        + '<button onclick="_agManageMembers('+g.group_id+')" class="btn btn-sm btn-outline">Assign users</button>'
        + '<button onclick="_agDeleteGroup('+g.group_id+',\''+_esc(g.group_name).replace(/'/g,'')+'\')" class="btn btn-sm btn-danger">Delete</button>'
        + '</div></div>';
    }).join('');
  }

  // ── Create / edit group ────────────────────────────────────────────
  window._agNewGroup = function(){ _editing={ group_id:null, group_name:'', note:'', access:{} }; _renderEditor(); };
  window._agEditGroup = function(gid){
    var g=_groups.find(function(x){return x.group_id===gid;});
    if(!g) return;
    _editing={ group_id:g.group_id, group_name:g.group_name, note:g.note||'', access:Object.assign({},g.access) };
    _renderEditor();
  };

  function _renderEditor(){
    var body=document.getElementById('ag-body'), footer=document.getElementById('ag-footer');
    var e=_editing;
    var inp='width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;font-size:13px';
    var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);margin:14px 0 5px';
    body.innerHTML =
      '<div style="font-size:13px;font-weight:800;color:var(--htxtb,#111)">'+(e.group_id?'Edit group':'New group')+'</div>'
      + '<label style="'+lbl+';margin-top:6px">Group name *</label>'
      + '<input id="ag-name" type="text" value="'+_esc(e.group_name)+'" placeholder="e.g. Floor Operators" style="'+inp+'">'
      + '<label style="'+lbl+'">Note (optional)</label>'
      + '<input id="ag-note" type="text" value="'+_esc(e.note)+'" placeholder="What this group is for" style="'+inp+'">'
      + '<label style="'+lbl+'">Feature access</label>'
      + '<div style="border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;overflow:hidden">'
      + CATS.map(function(c,i){
          var on=!!e.access[c.key];
          return '<div style="display:flex;align-items:center;gap:12px;padding:10px 13px;'
            + (i?'border-top:1px solid var(--hbdr,rgba(0,0,0,.06));':'')+'">'
            + '<div style="flex:1"><div style="font-size:12.5px;font-weight:700;color:var(--text,#0f172a)">'+_esc(c.label)+'</div>'
            + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af)">'+_esc(c.desc)+'</div></div>'
            + '<label class="ag-switch" style="position:relative;display:inline-block;width:42px;height:23px;flex:0 0 auto">'
            + '<input type="checkbox" data-key="'+c.key+'" '+(on?'checked':'')+' style="opacity:0;width:0;height:0">'
            + '<span class="ag-slider" style="position:absolute;cursor:pointer;inset:0;background:'+(on?'#4648D4':'#cbd5e1')+';'
            + 'border-radius:23px;transition:.2s"></span></label>'
            + '</div>';
        }).join('')
      + '</div>';
    // wire switch visuals
    Array.prototype.forEach.call(body.querySelectorAll('.ag-switch input'), function(cb){
      cb.addEventListener('change', function(){
        var sl=cb.nextElementSibling;
        if(sl) sl.style.background = cb.checked ? '#4648D4' : '#cbd5e1';
      });
    });
    if(footer) footer.innerHTML='<button onclick="_loadGroupsBack()" class="btn btn-outline" style="margin-right:auto">← Back</button>'
      + '<button onclick="_agSaveGroup()" class="btn btn-primary">Save group</button>';
  }
  window._loadGroupsBack = function(){ _loadGroups(); };

  window._agSaveGroup = function(){
    var body=document.getElementById('ag-body');
    var name=(document.getElementById('ag-name').value||'').trim();
    if(!name){ _toast('Group name is required','error',3000); return; }
    var note=(document.getElementById('ag-note').value||'').trim();
    var access={};
    Array.prototype.forEach.call(body.querySelectorAll('.ag-switch input'), function(cb){ access[cb.getAttribute('data-key')]=cb.checked; });
    fetch('/api/pm_stock/access_groups/save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ group_id:_editing.group_id, group_name:name, note:note, access:access })})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){ _toast('✓ Group saved','success',2500); _loadGroups(); }
        else _toast(d.message||'Save failed','error',4500);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4500); });
  };

  window._agDeleteGroup = function(gid,name){
    if(!confirm('Delete group "'+name+'"? Its members revert to default access.')) return;
    fetch('/api/pm_stock/access_groups/'+gid,{method:'DELETE'}).then(function(r){return r.json();}).then(function(d){
      if(d.status==='ok'){ _toast('✓ Deleted','success',2200); _loadGroups(); }
      else _toast(d.message||'Failed','error',4000);
    }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };

  // ── Assign users to a group ─────────────────────────────────────────
  var _agUsers=null;
  function _ensureUsers(cb){
    if(_agUsers){ cb(_agUsers); return; }
    fetch('/api/pm_stock/user_access/users').then(function(r){return r.json();}).then(function(d){
      _agUsers=(d.users||d.rows||[]).map(function(u){ return (typeof u==='string')?{user_name:u}:u; });
      cb(_agUsers);
    }).catch(function(){ _agUsers=[]; cb(_agUsers); });
  }

  window._agManageMembers = function(gid){
    var g=_groups.find(function(x){return x.group_id===gid;});
    if(!g) return;
    var body=document.getElementById('ag-body'), footer=document.getElementById('ag-footer');
    body.innerHTML='<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading members…</div>';
    Promise.all([
      fetch('/api/pm_stock/access_groups/'+gid+'/members').then(function(r){return r.json();}),
      new Promise(function(res){ _ensureUsers(res); })
    ]).then(function(arr){
      var members=(arr[0].members||[]).map(function(m){return m.user_name;});
      var memberSet={}; members.forEach(function(u){memberSet[u]=true;});
      var lbl='display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--hmuted2,#6b7280);margin:6px 0 8px';
      body.innerHTML='<div style="font-size:13px;font-weight:800;color:var(--htxtb,#111)">Assign users → '+_esc(g.group_name)+'</div>'
        + '<input id="ag-user-filter" placeholder="Filter users…" oninput="_agFilterUsers(this.value)" '
        + 'style="width:100%;box-sizing:border-box;margin-top:10px;padding:8px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;font-size:12.5px">'
        + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin:8px 0">Toggling a user assigns them to this group (or removes them). A user can be in one group at a time.</div>'
        + '<div id="ag-user-list" style="border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:10px;max-height:46vh;overflow-y:auto"></div>';
      window._agCurGroup=gid; window._agMemberSet=memberSet;
      _renderUserList('');
      if(footer) footer.innerHTML='<button onclick="_loadGroupsBack()" class="btn btn-outline" style="margin-right:auto">← Back</button>'
        + '<button onclick="document.getElementById(\'accessGroupsModal\').classList.remove(\'open\')" class="btn btn-primary">Done</button>';
    });
  };

  window._agFilterUsers=function(q){ _renderUserList(q||''); };

  function _renderUserList(q){
    var host=document.getElementById('ag-user-list'); if(!host) return;
    q=(q||'').toLowerCase();
    var list=(_agUsers||[]).filter(function(u){
      var s=((u.user_name||'')+' '+(u.full_name||'')+' '+(u.role||'')+' '+(u.department||'')).toLowerCase();
      return !q || s.indexOf(q)>-1;
    });
    if(!list.length){ host.innerHTML='<div style="padding:18px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">No matching users.</div>'; return; }
    host.innerHTML=list.map(function(u,i){
      var on=!!_agMemberSet[u.user_name];
      return '<div style="display:flex;align-items:center;gap:10px;padding:9px 13px;'+(i?'border-top:1px solid var(--hbdr,rgba(0,0,0,.06));':'')+'">'
        + '<div style="flex:1"><div style="font-size:12.5px;font-weight:600;color:var(--text,#0f172a)">'+_esc(u.user_name)
        + (u.full_name?(' <span style="color:var(--hmuted,#9ca3af);font-weight:400">· '+_esc(u.full_name)+'</span>'):'')+'</div>'
        + (u.role||u.department?('<div style="font-size:10px;color:var(--hmuted,#9ca3af)">'+_esc(u.role||'')+(u.department?(' · '+_esc(u.department)):'')+'</div>'):'')+'</div>'
        + '<button onclick="_agToggleMember(\''+_esc(u.user_name).replace(/'/g,'')+'\',this)" class="btn btn-sm '+(on?'btn-primary':'btn-outline')+'" '
        + 'style="min-width:92px">'+(on?'✓ In group':'Add')+'</button>'
        + '</div>';
    }).join('');
  }

  window._agToggleMember=function(uname,btn){
    var on=!_agMemberSet[uname];
    fetch('/api/pm_stock/access_groups/assign',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ user_name:uname, group_id: on?_agCurGroup:0 })})
      .then(function(r){return r.json();}).then(function(d){
        if(d.status==='ok'){
          _agMemberSet[uname]=on;
          if(btn){ btn.className='btn btn-sm '+(on?'btn-primary':'btn-outline'); btn.textContent=on?'✓ In group':'Add'; btn.style.minWidth='92px'; }
          _toast(on?('✓ Added '+uname):('Removed '+uname),'success',2000);
        } else _toast(d.message||'Failed','error',4000);
      }).catch(function(e){ _toast('Network error: '+(e.message||e),'error',4000); });
  };

})();
