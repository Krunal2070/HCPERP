/* ════════════════════════════════════════════════════════════════════════
   pm_stock_dock.js — Floating pinnable Dock + fixed Global Search bar
   ────────────────────────────────────────────────────────────────────────
   A floating bar pinned to the top of the page that contains:

     1. A FIXED global search box (cannot be removed). Searches everything —
        actions/pages (from the palette's _PAL_ACTIONS registry) AND data
        (vouchers, products) via /api/pm_stock/palette/search. Keyboard
        navigable (↑/↓/Enter), click to open.

     2. A row of ACTION CHIPS. By default these are the user's most-used
        actions (usage-ranked, from /api/pm_stock/palette/recent). The user
        can EDIT the dock: pin/unpin actions and reorder. Pins persist per
        user via /api/pm_stock/dock/pins. With no pins, the dock auto-fills
        from usage; with pins, the pinned set takes over (and the rest of
        the slots, if any, fill from usage).

   It is built ENTIRELY on top of the existing command-palette infrastructure
   (pm_stock_palette.js exposes _PAL_ACTIONS + run/track/route helpers), so
   there's one source of truth for "what can be done / searched".
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  var MAX_CHIPS = 6;          // how many action chips the dock shows
  var _pins = null;           // array of action_id (user's pinned set); null=unloaded
  var _hidden = [];           // action_ids the user removed from auto-fill
  var _recents = [];          // usage-ranked action_id list
  var _editMode = false;
  var _searchTimer = null;
  var _searchSeq = 0;
  var _kbdIdx = -1;
  var _results = [];          // current search results [{type,...}]

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function _toast(m,k){ if(typeof showToast==='function') showToast(m,k||'info',2500); }

  function _actions(){ return (window._palVisibleActions ? window._palVisibleActions() : (window._PAL_ACTIONS||[])); }
  function _actById(id){ return window._palActionById ? window._palActionById(id) : null; }

  /* ── Mount ─────────────────────────────────────────────────────────── */
  function _mount(){
    if(document.getElementById('pmDock')) return;
    var dock = document.createElement('div');
    dock.id = 'pmDock';
    dock.innerHTML =
      '<div class="dock-inner">'
      + '<span class="dock-grip" id="dockGrip" title="Drag to move the dock">⠿</span>'
      + '<div class="dock-search">'
      +   '<span class="dock-search-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>'
      +   '<input id="dockSearch" type="text" autocomplete="off" spellcheck="false" '
      +     'placeholder="Search vouchers, products, pages… (press /)" '
      +     'oninput="_dockSearchInput(this.value)" onkeydown="_dockSearchKey(event)" onfocus="_dockSearchInput(this.value)">'
      +   '<div id="dockResults" class="dock-results" style="display:none"></div>'
      + '</div>'
      + '<div id="dockChips" class="dock-chips"></div>'
      + '<div class="dock-edit-sep"></div>'
      + '<button id="dockEditBtn" class="dock-edit-btn" title="Customize dock — add / remove / reorder chips" onclick="_dockToggleEdit()">⚙</button>'
      + '<button id="dockPinBtn" class="dock-pin-btn" title="Pin the dock in place (unpin to drag it)" onclick="_dockTogglePinned()">'
      +   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>'
      + '</button>'
      + '</div>';
    document.body.appendChild(dock);
    // close search results on outside click
    document.addEventListener('mousedown', function(e){
      var s = document.getElementById('dockResults');
      var w = document.querySelector('#pmDock .dock-search');
      if(s && w && !w.contains(e.target)) s.style.display='none';
    });
    _initDrag(dock);
    _applyPinnedState();
  }

  /* ── Pin + drag ────────────────────────────────────────────────────────
     Pinned (default): the dock sits centered at the top, fixed. Unpinned:
     the user can drag it anywhere by the grip; its position is remembered
     in localStorage. Re-pinning snaps it back to the default top spot. */
  var _pinned = true;
  var _dockPos = null;   // {left, top} when free-floating

  function _loadDockPrefs(){
    try {
      _pinned = localStorage.getItem('pmDockPinned') !== '0';
      var p = localStorage.getItem('pmDockPos');
      _dockPos = p ? JSON.parse(p) : null;
    } catch(_){ _pinned = true; _dockPos = null; }
  }
  function _saveDockPrefs(){
    try {
      localStorage.setItem('pmDockPinned', _pinned ? '1' : '0');
      if(_dockPos) localStorage.setItem('pmDockPos', JSON.stringify(_dockPos));
    } catch(_){}
  }
  function _applyPinnedState(){
    var dock = document.getElementById('pmDock');
    var pinBtn = document.getElementById('dockPinBtn');
    var grip = document.getElementById('dockGrip');
    if(!dock) return;
    dock.classList.toggle('pinned', _pinned);
    dock.classList.toggle('floating', !_pinned);
    if(pinBtn){ pinBtn.classList.toggle('on', _pinned); pinBtn.title = _pinned ? 'Pinned — click to unpin and drag' : 'Click to pin in place'; }
    if(grip) grip.style.display = _pinned ? 'none' : '';
    if(_pinned){
      // Snap back to the default top-centered position.
      dock.style.left = ''; dock.style.top = ''; dock.style.right = ''; dock.style.transform = '';
    } else if(_dockPos){
      dock.style.left = _dockPos.left + 'px';
      dock.style.top  = _dockPos.top + 'px';
      dock.style.right = 'auto';
      dock.style.transform = 'none';
    }
  }
  window._dockTogglePinned = function(){
    _pinned = !_pinned;
    if(_pinned) _dockPos = null;       // re-pinning clears the free position
    _applyPinnedState();
    _saveDockPrefs();
  };
  function _initDrag(dock){
    var grip = document.getElementById('dockGrip');
    if(!grip) return;
    var sx, sy, ox, oy, dragging = false;
    grip.addEventListener('mousedown', function(e){
      if(_pinned) return;             // only draggable when unpinned
      dragging = true;
      var r = dock.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dock.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e){
      if(!dragging) return;
      var nl = Math.max(4, Math.min(window.innerWidth  - dock.offsetWidth  - 4, ox + (e.clientX - sx)));
      var nt = Math.max(4, Math.min(window.innerHeight - dock.offsetHeight - 4, oy + (e.clientY - sy)));
      dock.style.left = nl + 'px'; dock.style.top = nt + 'px';
      dock.style.right = 'auto'; dock.style.transform = 'none';
      _dockPos = { left: nl, top: nt };
    });
    document.addEventListener('mouseup', function(){
      if(!dragging) return;
      dragging = false; dock.style.transition = '';
      _saveDockPrefs();
    });
  }

  /* ── Load pins + recents, then render chips ────────────────────────── */
  function _load(){
    Promise.all([
      fetch('/api/pm_stock/dock/pins').then(function(r){return r.json();}).catch(function(){return {pins:[]};}),
      fetch('/api/pm_stock/palette/recent?n=20').then(function(r){return r.json();}).catch(function(){return {actions:[]};})
    ]).then(function(arr){
      // Stored "pins" payload encodes two things: plain ids = pinned;
      // ids prefixed with '!' = hidden from auto-fill. Split them out.
      var raw = (arr[0] && arr[0].pins) || [];
      _pins = []; _hidden = [];
      raw.forEach(function(x){
        x = String(x);
        if(x.charAt(0) === '!') _hidden.push(x.slice(1));
        else _pins.push(x);
      });
      _recents = ((arr[1] && arr[1].actions) || []).map(function(a){ return a.action_id; });
      _renderChips();
    });
  }

  // The chip set: pinned actions first (in pinned order), then usage-ranked
  // recents (minus any the user removed), then defaults — all skipping hidden.
  function _chipIds(){
    var ids = [];
    (_pins||[]).forEach(function(id){ if(_actById(id) && ids.indexOf(id)<0) ids.push(id); });
    _recents.forEach(function(id){
      if(ids.length>=MAX_CHIPS) return;
      if(_hidden.indexOf(id)>-1) return;             // user removed this auto-chip
      if(_actById(id) && ids.indexOf(id)<0) ids.push(id);
    });
    if(ids.length < MAX_CHIPS){
      ['nav:stock','create:grn','nav:mr','nav:log','nav:products','nav:mm']
        .forEach(function(id){
          if(ids.length>=MAX_CHIPS) return;
          if(_hidden.indexOf(id)>-1) return;
          if(_actById(id) && ids.indexOf(id)<0) ids.push(id);
        });
    }
    return ids.slice(0, MAX_CHIPS);
  }

  function _renderChips(){
    var host = document.getElementById('dockChips');
    if(!host) return;
    var ids = _chipIds();
    host.innerHTML = ids.map(function(id){
      var a = _actById(id); if(!a) return '';
      var pinned = (_pins||[]).indexOf(id) > -1;
      var icon = a.iconHtml || '•';
      if(_editMode){
        return '<span class="dock-chip editing" data-id="'+_esc(id)+'">'
          + '<span class="dock-chip-ic">'+icon+'</span>'
          + '<span class="dock-chip-lbl">'+_esc(a.label)+'</span>'
          + '<button class="dock-pin-toggle '+(pinned?'on':'')+'" title="'+(pinned?'Pinned — click to unpin':'Pin so it stays put')+'" '
          +   'onclick="event.stopPropagation();_dockTogglePin(\''+_esc(id)+'\')">'+(pinned?'📌':'📍')+'</button>'
          + '<button class="dock-remove-btn" title="Remove from dock" '
          +   'onclick="event.stopPropagation();_dockRemove(\''+_esc(id)+'\')">✕</button>'
          + '</span>';
      }
      return '<button class="dock-chip" title="'+_esc(a.label)+(a.hint?(' ('+_esc(a.hint)+')'):'')+'" '
        + 'onclick="_dockRun(\''+_esc(id)+'\')">'
        + '<span class="dock-chip-ic">'+icon+'</span>'
        + '<span class="dock-chip-lbl">'+_esc(a.label)+'</span>'
        + '</button>';
    }).join('');
    if(_editMode){
      host.innerHTML += '<button class="dock-add-btn" onclick="_dockOpenAdd()" title="Add an action to the dock">＋ Add</button>';
    }
    // Only show the right-edge fade when the chips actually overflow.
    setTimeout(function(){
      if(host.scrollWidth > host.clientWidth + 2) host.classList.add('scrolls');
      else host.classList.remove('scrolls');
    }, 0);
  }

  window._dockRun = function(id){
    if(window._palRunActionById) window._palRunActionById(id);
    // optimistic: bump it to front of recents so the dock adapts immediately
    _recents = [id].concat(_recents.filter(function(x){return x!==id;}));
  };

  /* ── Edit mode ─────────────────────────────────────────────────────── */
  window._dockToggleEdit = function(){
    _editMode = !_editMode;
    var btn = document.getElementById('dockEditBtn');
    var dock = document.getElementById('pmDock');
    if(dock) dock.classList.toggle('editing', _editMode);
    if(btn){ btn.classList.toggle('active', _editMode); btn.textContent = _editMode ? '✓' : '⚙'; btn.title = _editMode?'Done editing':'Customize dock'; }
    _renderChips();
    if(!_editMode) _savePins();
  };

  window._dockTogglePin = function(id){
    if(!_pins) _pins = [];
    var i = _pins.indexOf(id);
    if(i > -1) _pins.splice(i,1);
    else {
      _pins.push(id);
      // pinning something that was hidden un-hides it
      var h = _hidden.indexOf(id); if(h>-1) _hidden.splice(h,1);
    }
    _renderChips();
  };

  // Remove a chip from the dock entirely. If it was pinned, unpin it; if it
  // was an auto/recent chip, add it to the hidden list so it doesn't return.
  window._dockRemove = function(id){
    if(!_pins) _pins = [];
    var p = _pins.indexOf(id); if(p>-1) _pins.splice(p,1);
    if(_hidden.indexOf(id)<0) _hidden.push(id);
    _renderChips();
  };

  function _savePins(){
    // Encode hidden ids with a leading '!' so both sets persist in one field.
    var payload = (_pins||[]).slice().concat((_hidden||[]).map(function(x){ return '!'+x; }));
    fetch('/api/pm_stock/dock/pins', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pins: payload })
    }).then(function(r){return r.json();}).then(function(d){
      if(d.status==='ok') _toast('✓ Dock saved','success');
    }).catch(function(){});
  }

  // "Add action" picker — a small searchable list of all available actions.
  window._dockOpenAdd = function(){
    var existing = document.getElementById('dockAddModal');
    if(existing) existing.remove();
    var m = document.createElement('div');
    m.id = 'dockAddModal';
    m.className = 'modal-overlay open';
    m.style.zIndex = 12000;
    var acts = _actions();
    m.innerHTML =
      '<div class="modal" style="width:480px;max-width:94vw;max-height:80vh;display:flex;flex-direction:column;background:var(--surface,#fff);border-radius:14px;overflow:hidden">'
      + '<div style="padding:14px 18px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));display:flex;justify-content:space-between;align-items:center">'
      +   '<strong style="font-size:14px;color:var(--htxtb,#111)">Add to dock</strong>'
      +   '<button onclick="document.getElementById(\'dockAddModal\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--hmuted,#9ca3af)">✕</button>'
      + '</div>'
      + '<input id="dockAddFilter" placeholder="Filter actions…" oninput="_dockAddFilter(this.value)" '
      +   'style="margin:12px 18px;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:8px;font-size:13px;outline:none">'
      + '<div id="dockAddList" style="overflow-y:auto;padding:0 10px 12px;flex:1"></div>'
      + '</div>';
    document.body.appendChild(m);
    m.addEventListener('mousedown', function(e){ if(e.target===m) m.remove(); });
    window._dockAddAll = acts;
    _dockAddFilter('');
    setTimeout(function(){ var f=document.getElementById('dockAddFilter'); if(f) f.focus(); }, 30);
  };

  window._dockAddFilter = function(q){
    q = (q||'').toLowerCase().trim();
    var host = document.getElementById('dockAddList');
    if(!host) return;
    var list = (window._dockAddAll||[]).filter(function(a){
      var s = (a.label+' '+(a.keywords||'')+' '+(a.category||'')).toLowerCase();
      return !q || s.indexOf(q) > -1;
    });
    host.innerHTML = list.map(function(a){
      var pinned = (_pins||[]).indexOf(a.id) > -1;
      return '<div class="dock-add-row" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer" '
        + 'onclick="_dockAddPick(\''+_esc(a.id)+'\')" onmouseover="this.style.background=\'rgba(70,72,212,.07)\'" onmouseout="this.style.background=\'\'">'
        + '<span style="font-size:15px">'+(a.iconHtml||'•')+'</span>'
        + '<span style="flex:1;font-size:12.5px;color:var(--text,#0f172a)">'+_esc(a.label)
        +   '<span style="color:var(--hmuted,#9ca3af);font-size:10px;margin-left:6px">'+_esc(a.category||'')+'</span></span>'
        + (pinned?'<span style="font-size:11px;color:var(--nb-primary,#4648D4);font-weight:700">📌 pinned</span>':'<span style="font-size:11px;color:var(--hmuted,#9ca3af)">add ＋</span>')
        + '</div>';
    }).join('') || '<div style="padding:18px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">No actions match.</div>';
  };

  window._dockAddPick = function(id){
    if(!_pins) _pins = [];
    if(_pins.indexOf(id) < 0) _pins.push(id);
    _renderChips();
    _dockAddFilter(document.getElementById('dockAddFilter') ? document.getElementById('dockAddFilter').value : '');
  };

  /* ── Global search ─────────────────────────────────────────────────── */
  window._dockSearchInput = function(q){
    q = (q||'').trim();
    _kbdIdx = -1;
    var box = document.getElementById('dockResults');
    if(!box) return;
    if(!q){ box.style.display='none'; box.innerHTML=''; return; }

    // 1) Action matches (instant, local).
    var ql = q.toLowerCase();
    var actHits = _actions().filter(function(a){
      return (a.label+' '+(a.keywords||'')).toLowerCase().indexOf(ql) > -1;
    }).slice(0, 6).map(function(a){ return { type:'action', a:a }; });

    _results = actHits.slice();
    _renderResults(q, true);   // show actions immediately, data loading

    // 2) Data matches (debounced backend search) when q >= 2 chars.
    clearTimeout(_searchTimer);
    if(q.length >= 2){
      var seq = ++_searchSeq;
      _searchTimer = setTimeout(function(){
        fetch('/api/pm_stock/palette/search?q=' + encodeURIComponent(q))
          .then(function(r){return r.json();})
          .then(function(d){
            if(seq !== _searchSeq) return;   // a newer query superseded this
            var data = [];
            (d.vouchers||[]).forEach(function(v){ data.push({ type:'voucher', v:v }); });
            (d.products||[]).forEach(function(p){ data.push({ type:'product', p:p }); });
            _results = actHits.concat(data);
            _renderResults(q, false);
          }).catch(function(){});
      }, 160);
    }
  };

  function _kindLabel(k){
    return { grn:'GRN', dn:'Delivery Note', mtv:'Transfer', mr:'Material Request' }[k] || k.toUpperCase();
  }

  function _renderResults(q, loading){
    var box = document.getElementById('dockResults');
    if(!box) return;
    if(!_results.length && !loading){
      box.innerHTML = '<div class="dock-res-empty">No matches for “'+_esc(q)+'”</div>';
      box.style.display='block'; return;
    }
    var html = '';
    var lastType = null;
    _results.forEach(function(r, i){
      var sectionHdr = '';
      var t = (r.type==='action') ? 'Pages & Actions'
            : (r.type==='voucher') ? 'Vouchers' : 'Products';
      if(t !== lastType){ html += '<div class="dock-res-sec">'+t+'</div>'; lastType = t; }
      var active = (i===_kbdIdx) ? ' active' : '';
      if(r.type==='action'){
        html += '<div class="dock-res-row'+active+'" data-i="'+i+'" onmousedown="_dockPickResult(event,'+i+')">'
          + '<span class="dock-res-ic">'+(r.a.iconHtml||'•')+'</span>'
          + '<span class="dock-res-lbl">'+_esc(r.a.label)+'</span>'
          + '<span class="dock-res-tag">'+_esc(r.a.category||'')+'</span></div>';
      } else if(r.type==='voucher'){
        var v = r.v;
        html += '<div class="dock-res-row'+active+'" data-i="'+i+'" onmousedown="_dockPickResult(event,'+i+')">'
          + '<span class="dock-res-ic">🧾</span>'
          + '<span class="dock-res-lbl">'+_esc(v.voucher_no||'')
          +   '<span class="dock-res-sub"> · '+_esc(v.detail1||'')+'</span></span>'
          + '<span class="dock-res-tag">'+_esc(_kindLabel(v.kind))+'</span></div>';
      } else {
        var p = r.p;
        html += '<div class="dock-res-row'+active+'" data-i="'+i+'" onmousedown="_dockPickResult(event,'+i+')">'
          + '<span class="dock-res-ic">📦</span>'
          + '<span class="dock-res-lbl">'+_esc(p.product_name||'')
          +   (p.product_code?('<span class="dock-res-sub"> · '+_esc(p.product_code)+'</span>'):'')+'</span>'
          + '<span class="dock-res-tag">Product</span></div>';
      }
    });
    if(loading && q.length>=2){
      html += '<div class="dock-res-loading">Searching data…</div>';
    }
    box.innerHTML = html;
    box.style.display='block';
  }

  window._dockPickResult = function(ev, i){
    if(ev) ev.preventDefault();
    var r = _results[i];
    if(!r) return;
    var box = document.getElementById('dockResults');
    if(box) box.style.display='none';
    var inp = document.getElementById('dockSearch');
    if(inp) inp.blur();
    if(r.type==='action'){
      if(window._palRunActionById) window._palRunActionById(r.a.id);
    } else if(r.type==='voucher'){
      if(window._palRouteDataHit) window._palRouteDataHit({ kind:'voucher', data:r.v });
    } else if(r.type==='product'){
      if(window._palRouteDataHit) window._palRouteDataHit({ kind:'product', data:r.p });
    }
  };

  window._dockSearchKey = function(e){
    var box = document.getElementById('dockResults');
    var visible = box && box.style.display !== 'none' && _results.length;
    if(e.key === 'ArrowDown'){ e.preventDefault(); if(visible){ _kbdIdx = Math.min(_kbdIdx+1, _results.length-1); _renderResults(document.getElementById('dockSearch').value, false); _scrollActive(); } }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); if(visible){ _kbdIdx = Math.max(_kbdIdx-1, 0); _renderResults(document.getElementById('dockSearch').value, false); _scrollActive(); } }
    else if(e.key === 'Enter'){ e.preventDefault(); if(_results.length){ _dockPickResult(null, _kbdIdx>=0 ? _kbdIdx : 0); } }
    else if(e.key === 'Escape'){ if(box) box.style.display='none'; e.target.blur(); }
  };
  function _scrollActive(){
    var el = document.querySelector('#dockResults .dock-res-row.active');
    if(el) el.scrollIntoView({block:'nearest'});
  }

  // Global "/" focuses the dock search (when not already typing).
  document.addEventListener('keydown', function(e){
    if(e.key !== '/') return;
    var t = e.target;
    if(t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable)) return;
    var inp = document.getElementById('dockSearch');
    if(inp){ e.preventDefault(); inp.focus(); inp.select(); }
  });

  /* ── Access guard helper ───────────────────────────────────────────
     Returns true when the current user should see the dock. Admins
     always pass. Non-admins need access.command_palette = true.
     window._userAccess + window._isAdmin are populated by pm_stock.html
     at page boot from the Jinja `access` dict. */
  function _dockAllowed(){
    try {
      if(window._isAdmin === true) return true;
      var a = window._userAccess || {};
      return a.command_palette === true;
    } catch(_) { return false; }
  }

  /* ── Init ──────────────────────────────────────────────────────────── */
  function _init(){
    // Hard gate: non-admins without the command_palette flag get no dock
    // at all — no mount, no event listeners, no keyboard shortcut. The
    // `/` focus shortcut bound earlier is harmless when the search box
    // doesn't exist (it just no-ops because document.getElementById
    // returns null).
    if(!_dockAllowed()) return;
    _loadDockPrefs();
    // Wait until the palette registry is available (it exposes the actions).
    var tries = 0;
    (function waitPal(){
      if(window._PAL_ACTIONS && window._palActionById){ _mount(); _load(); return; }
      if(tries++ > 40) { _mount(); _load(); return; }   // mount anyway after ~4s
      setTimeout(waitPal, 100);
    })();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();
})();
