/* ════════════════════════════════════════════════════════════════════════
   LABEL REISSUE APPROVALS  —  admin review + requester tracking
   ────────────────────────────────────────────────────────────────────────
   REISSUE IS NOT REPRINT.
     • Reprint = print the SAME label again (same QR/code). Separate feature.
     • Reissue = the QR is damaged/dead → assign a BRAND-NEW code + new QR to
       the box and print that; the old code is retired.

   Flow: a user requests a reissue (reason required) → an admin approves,
   which stamps a brand-new short code on the box server-side → the requester
   prints the replacement label from "My Reissue Requests"
   (printReissuedLabel() lives in pm_stock_vouchers.js).

   This module owns ONLY the reissue workflow. It never touches the reprint
   tables, endpoints, badges, or modals.

   Surfaces:
     • Admin : "Label Reissue Approvals" modal  (openLabelReissueApprovalsModal)
     • User  : "My Reissue Requests" modal       (openMyLabelReissuesModal)
     • Badge : refreshLabelReissueBadge()

   Endpoints (see __init__.py):
     POST /api/pm_stock/label_reissue/request          {code|box_id, reason}
     GET  /api/pm_stock/label_reissue/requests         ?status=
     GET  /api/pm_stock/label_reissue/pending_count
     POST /api/pm_stock/label_reissue/<id>/approve     {note}
     POST /api/pm_stock/label_reissue/<id>/reject      {note}
     POST /api/pm_stock/label_reissue/<id>/print
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  function _toast(msg, kind, ms){
    if(typeof showToast === 'function') showToast(msg, kind || 'info', ms || 3000);
  }
  function _esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
  function _fmtDateTime(s){
    if(!s) return '';
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? (m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5]) : String(s);
  }
  function _isAdminUser(){ return (typeof _isAdmin === 'function') ? _isAdmin() : false; }

  var STATUS_STYLE = {
    pending:  {bg:'rgba(245,158,11,.12)', fg:'#92400e', label:'PENDING'},
    approved: {bg:'rgba(13,148,136,.12)', fg:'#0f766e', label:'APPROVED · ready to print'},
    printed:  {bg:'rgba(100,116,139,.14)',fg:'#475569', label:'PRINTED'},
    rejected: {bg:'rgba(220,38,38,.10)',  fg:'#991b1b', label:'REJECTED'}
  };
  function _pill(status){
    var s = STATUS_STYLE[status] || {bg:'rgba(0,0,0,.06)', fg:'#374151', label:String(status||'').toUpperCase()};
    return '<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:9.5px;'
      + 'font-weight:800;letter-spacing:.3px;background:' + s.bg + ';color:' + s.fg + '">' + s.label + '</span>';
  }

  function _ensureModal(id, titleHtml, subtitleHtml){
    var modal = document.getElementById(id);
    if(modal) return modal;
    modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal-overlay';
    modal.style.cssText = 'z-index:1000';
    modal.innerHTML =
      '<div class="modal" style="width:720px;max-width:96vw;max-height:90vh;display:flex;'
      + 'flex-direction:column;background:var(--surface,#fff);border-radius:12px;overflow:hidden;'
      + 'box-shadow:0 24px 64px rgba(0,0,0,.3)">'
      + '<div style="padding:16px 20px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.09));'
      + 'display:flex;align-items:flex-start;gap:12px;flex-shrink:0">'
      + '<div style="flex:1">'
      + '<div style="font-size:15px;font-weight:800;color:var(--htxtb,#111);display:flex;align-items:center;gap:8px">' + titleHtml + '</div>'
      + '<div style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:2px">' + subtitleHtml + '</div>'
      + '</div>'
      + '<button onclick="document.getElementById(\'' + id + '\').classList.remove(\'open\')" '
      + 'class="modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;'
      + 'color:var(--hmuted,#9ca3af);line-height:1">✕</button>'
      + '</div>'
      + '<div id="' + id + '-toolbar" style="flex-shrink:0"></div>'
      + '<div id="' + id + '-body" style="overflow-y:auto;padding:14px 18px;flex:1"></div>'
      + '<div id="' + id + '-footer" style="padding:12px 18px;border-top:1px solid var(--hbdr,rgba(0,0,0,.09));'
      + 'background:var(--hsurf2,#f9fafb);display:flex;gap:10px;justify-content:flex-end;flex-shrink:0"></div>'
      + '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  function _rowMeta(r){
    var line;
    if(r.status === 'pending'){
      line = 'Current code <strong style="font-family:monospace">' + _esc(r.old_short_code || '—')
        + '</strong> · a new code is assigned when you approve';
    } else {
      line = 'Old <strong style="font-family:monospace;color:#991b1b">' + _esc(r.old_short_code || '—')
        + '</strong> → New <strong style="font-family:monospace;color:#0f766e">' + _esc(r.new_short_code || '—') + '</strong>';
    }
    if(r.new_per_box_qty != null){
      line += '<br><span style="display:inline-block;margin-top:3px;font-size:10.5px;font-weight:700;color:#0f766e;'
        + 'background:rgba(13,148,136,.1);padding:1px 8px;border-radius:10px">'
        + 'Per-box qty ' + (r.old_per_box_qty != null ? r.old_per_box_qty : '?') + ' → ' + r.new_per_box_qty
        + (r.status === 'pending' ? ' (applies on approval)' : '')
        + '</span>';
    }
    if(r.new_godown_id != null){
      line += '<br><span style="display:inline-block;margin-top:3px;font-size:10.5px;font-weight:700;color:#6d28d9;'
        + 'background:rgba(109,40,217,.1);padding:1px 8px;border-radius:10px">'
        + '📍 Location ' + _esc(r.old_godown_name || '?') + ' → ' + _esc(r.new_godown_name || '?')
        + (r.status === 'pending' ? ' (moves stock on approval)' : '')
        + '</span>';
    }
    return line;
  }

  function _rowShell(r, inner){
    return '<div style="padding:12px;border:1px solid var(--hbdr,rgba(0,0,0,.09));border-radius:9px;margin-bottom:9px;background:#fff">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<span style="font-family:monospace;font-weight:800;font-size:13px;color:var(--text,#0f172a)">' + _esc(r.box_code) + '</span>'
      + _pill(r.status)
      + '<span style="font-size:10.5px;color:var(--hmuted,#9ca3af)">#' + r.req_id + '</span>'
      + '</div>'
      + '<div style="font-size:11.5px;color:var(--htxt,#374151);margin-top:4px">'
      + _esc(r.product_name || '')
      + (r.grn_no ? ' · <span style="font-family:monospace;color:#0d9488">' + _esc(r.grn_no) + '</span>' : '')
      + '</div>'
      + (r.cur_godown_name
          ? '<div style="font-size:10.5px;color:var(--hmuted2,#6b7280);margin-top:4px">'
            + '<span style="display:inline-block;font-weight:700;color:#3730a3;'
            + 'background:rgba(70,72,212,.09);padding:2px 9px;border-radius:10px">'
            + '📍 ' + _esc(r.cur_godown_name)
            + (r.box_status && r.box_status !== 'in_stock' ? ' · ' + _esc(r.box_status) : '')
            + '</span></div>'
          : '')
      + '<div style="font-size:11px;color:var(--hmuted,#6b7280);margin-top:4px">' + _rowMeta(r) + '</div>'
      + '<div style="font-size:11.5px;color:var(--text,#0f172a);margin-top:6px;padding:7px 10px;'
      + 'background:var(--hsurf2,#f9fafb);border-radius:6px;border-left:3px solid #f59e0b">'
      + '<span style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#92400e">Reason</span><br>'
      + _esc(r.reason || '(none given)') + '</div>'
      + inner
      + '</div>';
  }

  // ════════════════════════════════════════════════════════════════════
  // ADMIN — approvals (with multi-select + bulk approve/reject)
  // ════════════════════════════════════════════════════════════════════
  var _adminRows = [], _adminFilter = 'pending', _adminSelected = {};

  window.openLabelReissueApprovalsModal = function(){
    if(!(window.__pmHasAccess && window.__pmHasAccess('label_reissue')) && !_isAdminUser()){ _toast('You do not have access to Label Reissue approvals','error'); return; }
    var modal = _ensureModal('labelReissueApprovalsModal', '🏷️ Label Reissue Approvals',
      'Approve to assign a NEW QR code to the box (requester then prints), or reject. Select multiple to approve/reject in bulk. Separate from Reprint.');
    modal.classList.add('open');
    _adminSelected = {};
    _adminLoad('pending');
  };

  function _adminLoad(statusFilter){
    _adminFilter = statusFilter;
    _adminSelected = {};
    var body = document.getElementById('labelReissueApprovalsModal-body');
    var tb = document.getElementById('labelReissueApprovalsModal-toolbar');
    if(body) body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>';
    if(tb){
      var tabs = [['pending','Pending'],['approved','Approved'],['printed','Printed'],['rejected','Rejected'],['','All']];
      tb.innerHTML = '<div style="display:flex;gap:6px;padding:10px 18px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));background:var(--hsurf2,#fafbfc);flex-wrap:wrap">'
        + tabs.map(function(t){
            return '<button onclick="_lriAdminFilter(\'' + t[0] + '\')" '
              + 'style="padding:5px 12px;border-radius:7px;border:1px solid var(--hbdr,rgba(0,0,0,.12));'
              + 'background:' + (t[0]===statusFilter?'#0d9488':'#fff') + ';color:' + (t[0]===statusFilter?'#fff':'var(--htxt,#374151)') + ';'
              + 'font-size:11.5px;font-weight:700;cursor:pointer">' + t[1] + '</button>';
          }).join('')
        + '</div>';
    }
    var qs = statusFilter ? ('?status=' + encodeURIComponent(statusFilter)) : '';
    fetch('/api/pm_stock/label_reissue/requests' + qs)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.status !== 'ok'){ if(body) body.innerHTML = '<div style="padding:20px;color:#b91c1c">' + _esc(d.message||'Load failed') + '</div>'; return; }
        _adminRows = d.requests || [];
        _adminRender();
      })
      .catch(function(e){ if(body) body.innerHTML = '<div style="padding:20px;color:#b91c1c">Network error: ' + _esc(e.message) + '</div>'; });
  }
  window._lriAdminFilter = function(v){ _adminLoad(v); };

  function _adminPendingRows(){ return _adminRows.filter(function(r){ return r.status === 'pending'; }); }
  function _adminSelectedIds(){
    return Object.keys(_adminSelected).filter(function(k){ return _adminSelected[k]; }).map(Number);
  }

  function _adminRender(){
    var body = document.getElementById('labelReissueApprovalsModal-body');
    var footer = document.getElementById('labelReissueApprovalsModal-footer');
    if(!body) return;
    if(!_adminRows.length){
      body.innerHTML = '<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">No requests in this view.</div>';
      if(footer) footer.innerHTML = '<button onclick="document.getElementById(\'labelReissueApprovalsModal\').classList.remove(\'open\')" class="btn btn-outline" style="padding:8px 18px">Close</button>';
      return;
    }
    var anyPending = _adminPendingRows().length > 0;
    body.innerHTML = _adminRows.map(_adminRowHtml).join('');
    if(footer){
      if(anyPending){
        footer.innerHTML =
          '<label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--htxt,#374151);margin-right:auto;cursor:pointer">'
          + '<input type="checkbox" id="lri-selectall" onchange="_lriAdminSelectAll(this.checked)"> Select all pending</label>'
          + '<button onclick="_lriAdminBulk(\'reject\')" class="btn btn-outline" '
          + 'style="border-color:rgba(220,38,38,.4);color:#dc2626;padding:8px 14px;font-weight:700">✗ Reject selected</button>'
          + '<button onclick="_lriAdminBulk(\'approve\')" class="btn btn-primary" '
          + 'style="background:#0d9488;border-color:#0d9488;padding:8px 16px;font-weight:700">✓ Approve selected</button>';
      } else {
        footer.innerHTML = '<button onclick="document.getElementById(\'labelReissueApprovalsModal\').classList.remove(\'open\')" class="btn btn-outline" style="padding:8px 18px">Close</button>';
      }
    }
    _adminSyncSelectAll();
  }

  function _adminRowHtml(r){
    var isPending = r.status === 'pending';
    var checkbox = isPending
      ? '<input type="checkbox" class="lri-row-chk" data-id="' + r.req_id + '" ' + (_adminSelected[r.req_id]?'checked':'')
        + ' onchange="_lriAdminToggle(' + r.req_id + ',this.checked)" style="margin-top:3px">'
      : '<span style="width:14px;display:inline-block"></span>';
    var decided = r.decided_by
      ? '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:4px">'
        + (r.status==='rejected'?'Rejected':'Approved') + ' by <strong>' + _esc(r.decided_by) + '</strong> · ' + _fmtDateTime(r.decided_at)
        + (r.decided_note ? ' · "' + _esc(r.decided_note) + '"' : '') + '</div>'
      : '';
    var printed = r.printed_at
      ? '<div style="font-size:10.5px;color:#475569;margin-top:2px">Printed ' + _fmtDateTime(r.printed_at)
        + (r.printed_by ? ' by ' + _esc(r.printed_by) : '') + '</div>'
      : '';
    var requested = '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">Requested by <strong>'
      + _esc(r.requested_by) + '</strong> · ' + _fmtDateTime(r.requested_at) + '</div>';
    var actions = isPending
      ? '<div style="display:flex;gap:8px;margin-top:9px">'
        + '<button onclick="_lriAdminDecide(' + r.req_id + ',\'approve\')" class="btn btn-sm btn-primary" '
        + 'style="background:#0d9488;border-color:#0d9488;padding:5px 14px;font-weight:700;font-size:11.5px">✓ Approve · new QR</button>'
        + '<button onclick="_lriAdminDecide(' + r.req_id + ',\'reject\')" class="btn btn-sm btn-outline" '
        + 'style="border-color:rgba(220,38,38,.4);color:#dc2626;padding:5px 14px;font-weight:700;font-size:11.5px">✗ Reject</button>'
        + '</div>'
      : '';
    // Row with a leading checkbox column
    return '<div style="display:flex;gap:10px;align-items:flex-start">'
      + checkbox
      + '<div style="flex:1;min-width:0">' + _rowShell(r, requested + decided + printed + actions) + '</div>'
      + '</div>';
  }

  window._lriAdminToggle = function(id, on){
    _adminSelected[id] = !!on;
    _adminSyncSelectAll();
  };
  window._lriAdminSelectAll = function(on){
    _adminSelected = {};
    if(on){ _adminPendingRows().forEach(function(r){ _adminSelected[r.req_id] = true; }); }
    var chks = document.querySelectorAll('#labelReissueApprovalsModal-body .lri-row-chk');
    Array.prototype.forEach.call(chks, function(c){ c.checked = on; });
  };
  function _adminSyncSelectAll(){
    var sa = document.getElementById('lri-selectall');
    if(!sa) return;
    var pend = _adminPendingRows().length;
    sa.checked = pend > 0 && _adminSelectedIds().length === pend;
  }

  window._lriAdminDecide = function(reqId, action){
    var note = null;
    if(action === 'reject'){
      note = prompt('Reason for rejecting this reissue request (optional):') || null;
    }
    fetch('/api/pm_stock/label_reissue/' + reqId + '/' + action, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({note: note})
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d.status === 'ok'){
        _toast(action === 'approve'
          ? ('✓ Approved · new code ' + (d.new_code || '') + ' assigned')
          : '✓ Rejected', 'success', 3500);
        _adminLoad(_adminFilter);
        if(typeof refreshLabelReissueBadge === 'function') refreshLabelReissueBadge();
      } else {
        _toast(d.message || 'Action failed', 'error', 4500);
      }
    }).catch(function(e){ _toast('Network error: ' + (e.message||e), 'error', 4500); });
  };

  window._lriAdminBulk = function(action){
    var ids = _adminSelectedIds();
    if(!ids.length){ _toast('Select at least one pending request','error', 3000); return; }
    var verb = (action === 'approve') ? 'Approve' : 'Reject';
    var note = prompt(verb + ' ' + ids.length + ' reissue request(s). Optional shared note:', '');
    if(note === null) return;          // cancelled
    note = (note || '').trim() || null;
    fetch('/api/pm_stock/label_reissue/' + action + '_bulk', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({req_ids: ids, note: note})
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d.status === 'ok'){
        var n = (d.approved != null) ? d.approved : d.rejected;
        var msg = n + ' request(s) ' + ((d.approved != null) ? 'approved' : 'rejected');
        if(d.skipped) msg += ' · ' + d.skipped + ' skipped';
        _toast('✓ ' + msg, 'success', 4000);
        _adminSelected = {};
        _adminLoad(_adminFilter);
        if(typeof refreshLabelReissueBadge === 'function') refreshLabelReissueBadge();
      } else {
        _toast(d.message || 'Bulk action failed', 'error', 4500);
      }
    }).catch(function(e){ _toast('Network error: ' + (e.message||e), 'error', 4500); });
  };

  // ════════════════════════════════════════════════════════════════════
  // USER — my reissue requests
  // ════════════════════════════════════════════════════════════════════
  window.openMyLabelReissuesModal = function(){
    var modal = _ensureModal('myLabelReissuesModal', '🏷️ My Reissue Requests',
      'Damaged-QR replacement labels. Once an admin approves, print the new label here — the new QR replaces the old one.');
    var tb = document.getElementById('myLabelReissuesModal-toolbar');
    if(tb){
      tb.innerHTML = '<div style="display:flex;justify-content:flex-end;padding:10px 18px;'
        + 'border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));background:var(--hsurf2,#fafbfc)">'
        + '<button onclick="_lriOpenNewRequest()" class="btn btn-sm btn-primary" '
        + 'style="background:#f59e0b;border-color:#f59e0b;color:#fff;padding:6px 14px;font-weight:700;font-size:12px">'
        + '＋ New reissue request</button></div>';
    }
    modal.classList.add('open');
    var footer = document.getElementById('myLabelReissuesModal-footer');
    if(footer) footer.innerHTML = '<button onclick="document.getElementById(\'myLabelReissuesModal\').classList.remove(\'open\')" class="btn btn-outline" style="padding:8px 18px">Close</button>';
    _lriLoadMyList();
  };

  function _lriLoadMyList(){
    var body = document.getElementById('myLabelReissuesModal-body');
    if(body) body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af)">Loading…</div>';
    fetch('/api/pm_stock/label_reissue/requests')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.status !== 'ok'){ if(body) body.innerHTML = '<div style="padding:20px;color:#b91c1c">' + _esc(d.message||'Load failed') + '</div>'; return; }
        var rows = d.requests || [];
        if(!rows.length){
          if(body) body.innerHTML = '<div style="padding:34px;text-align:center;color:var(--hmuted,#9ca3af);font-size:13px">'
            + 'No reissue requests yet.<br><span style="font-size:11px">Use “＋ New reissue request” above when a printed QR is damaged.</span></div>';
          return;
        }
        if(body) body.innerHTML = rows.map(_myRowHtml).join('');
      })
      .catch(function(e){ if(body) body.innerHTML = '<div style="padding:20px;color:#b91c1c">Network error: ' + _esc(e.message) + '</div>'; });
  }

  // ── New-request flow (no scan needed) ───────────────────────────────
  // Two ways to identify the box whose label needs reissuing:
  //   1. Type the printed code (box_code or short code) — when legible.
  //   2. Browse GRN → pick the box — when nothing on the label is readable.
  var _lriNewMode = 'type';
  var _lriPickedBox = null;
  var _lriBasket = [];
  var _lriGodowns = null;          // cached [{id,name,is_floor}]

  function _lriEnsureGodowns(cb){
    if(_lriGodowns){ cb(_lriGodowns); return; }
    fetch('/api/pm_stock/godowns')
      .then(function(r){ return r.json(); })
      .then(function(rows){
        _lriGodowns = Array.isArray(rows) ? rows : (rows.godowns || []);
        cb(_lriGodowns);
      })
      .catch(function(){ _lriGodowns = []; cb(_lriGodowns); });
  }

  function _lriGodownName(id){
    if(id == null || !_lriGodowns) return '';
    for(var i=0;i<_lriGodowns.length;i++){ if(String(_lriGodowns[i].id) === String(id)) return _lriGodowns[i].name; }
    return '#' + id;
  }

  window._lriOpenNewRequest = function(){
    _lriNewMode = 'type';
    _lriPickedBox = null;
    _lriBasket = [];
    var body = document.getElementById('myLabelReissuesModal-body');
    var footer = document.getElementById('myLabelReissuesModal-footer');
    if(!body) return;
    body.innerHTML =
      '<div style="margin-bottom:12px">'
      + '<div style="font-size:11.5px;color:var(--hmuted,#6b7280);margin-bottom:10px">'
      + 'Add one or more boxes (each with its own reason), then submit them all together.</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:12px">'
      + '<button id="lri-tab-type" onclick="_lriSetMode(\'type\')" class="lri-tab" '
      + 'style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--hbdr,rgba(0,0,0,.12));'
      + 'background:#0d9488;color:#fff;font-weight:700;font-size:12px;cursor:pointer">Type the printed code</button>'
      + '<button id="lri-tab-browse" onclick="_lriSetMode(\'browse\')" class="lri-tab" '
      + 'style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--hbdr,rgba(0,0,0,.12));'
      + 'background:#fff;color:var(--htxt,#374151);font-weight:700;font-size:12px;cursor:pointer">Browse GRN → box</button>'
      + '</div>'
      + '<div id="lri-new-panel"></div>'
      + '<div id="lri-basket"></div>'
      + '</div>';
    if(footer){
      footer.innerHTML =
        '<button onclick="_lriBackToList()" class="btn btn-outline" style="padding:8px 16px">← Back to my requests</button>';
    }
    _lriRenderModePanel();
    _lriRenderBasket();
  };

  window._lriBackToList = function(){
    var footer = document.getElementById('myLabelReissuesModal-footer');
    if(footer) footer.innerHTML = '<button onclick="document.getElementById(\'myLabelReissuesModal\').classList.remove(\'open\')" class="btn btn-outline" style="padding:8px 18px">Close</button>';
    _lriLoadMyList();
  };

  window._lriSetMode = function(mode){
    _lriNewMode = mode;
    _lriPickedBox = null;
    ['type','browse'].forEach(function(m){
      var btn = document.getElementById('lri-tab-' + m);
      if(btn){
        btn.style.background = (m === mode) ? '#0d9488' : '#fff';
        btn.style.color = (m === mode) ? '#fff' : 'var(--htxt,#374151)';
      }
    });
    _lriRenderModePanel();
  };

  function _lriRenderModePanel(){
    var panel = document.getElementById('lri-new-panel');
    if(!panel) return;
    if(_lriNewMode === 'type'){
      panel.innerHTML =
        '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
        + 'color:var(--hmuted2,#6b7280);margin-bottom:5px">Printed code on the box</label>'
        + '<input id="lri-code-input" type="text" placeholder="e.g. A0007296 or BEARTUBE12-G0234-B003" '
        + 'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));'
        + 'border-radius:7px;font-size:13px;font-family:monospace;text-transform:uppercase" '
        + 'oninput="_lriCodeLookup(this.value)" onkeydown="if(event.key===\'Enter\')_lriCodeLookup(this.value,true)">'
        + '<div id="lri-code-status" style="font-size:11px;color:var(--hmuted,#9ca3af);margin-top:6px">Type the human-readable code printed under the product name.</div>'
        + '<div id="lri-reason-block" style="margin-top:14px;display:none"></div>';
    } else {
      panel.innerHTML =
        '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
        + 'color:var(--hmuted2,#6b7280);margin-bottom:5px">1 · Pick the GRN</label>'
        + '<select id="lri-grn-select" onchange="_lriLoadGrnBoxes(this.value)" '
        + 'style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:7px;font-size:12.5px">'
        + '<option value="">Loading GRNs…</option></select>'
        + '<div id="lri-box-wrap" style="margin-top:12px"></div>'
        + '<div id="lri-reason-block" style="margin-top:14px;display:none"></div>';
      _lriLoadGrns();
    }
  }

  var _lriCodeTimer = null;
  window._lriCodeLookup = function(val, immediate){
    var code = (val || '').trim().toUpperCase();
    var st = document.getElementById('lri-code-status');
    var rb = document.getElementById('lri-reason-block');
    _lriPickedBox = null;
    if(rb){ rb.style.display = 'none'; rb.innerHTML = ''; }
    if(!code){ if(st){ st.textContent = 'Type the human-readable code printed under the product name.'; st.style.color = 'var(--hmuted,#9ca3af)'; } return; }
    if(st){ st.textContent = 'Looking up…'; st.style.color = 'var(--hmuted,#9ca3af)'; }
    if(_lriCodeTimer) clearTimeout(_lriCodeTimer);
    var run = function(){
      fetch('/api/pm_stock/boxes/by_code?code=' + encodeURIComponent(code))
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(d.status === 'ok' && d.box){
            _lriPickedBox = { box_id: d.box.box_id, box_code: d.box.box_code,
                              product_name: d.box.product_name, grn_no: d.box.grn_no,
                              per_box_qty: Number(d.box.per_box_qty) || 0,
                              current_godown_id: (d.box.current_godown_id != null ? d.box.current_godown_id : null),
                              current_godown_name: d.box.current_godown_name || '' };
            if(st){ st.innerHTML = '✓ Found: <strong>' + _esc(d.box.product_name||'') + '</strong> · '
              + '<span style="font-family:monospace">' + _esc(d.box.box_code) + '</span>'; st.style.color = '#0f766e'; }
            _lriShowReason();
          } else {
            if(st){ st.textContent = '✗ No box found for that code. Check the code, or use “Browse GRN → box”.'; st.style.color = '#b45309'; }
          }
        })
        .catch(function(){ if(st){ st.textContent = 'Lookup error — try again.'; st.style.color = '#b91c1c'; } });
    };
    if(immediate) run(); else _lriCodeTimer = setTimeout(run, 350);
  };

  function _lriLoadGrns(){
    var sel = document.getElementById('lri-grn-select');
    fetch('/api/pm_stock/grn/list')
      .then(function(r){ return r.json(); })
      .then(function(rows){
        if(!sel) return;
        var list = Array.isArray(rows) ? rows : (rows.grns || rows.requests || []);
        if(!list.length){ sel.innerHTML = '<option value="">No GRNs found</option>'; return; }
        sel.innerHTML = '<option value="">— select a GRN —</option>'
          + list.map(function(g){
              var label = (g.grn_no || ('GRN #' + g.id)) + (g.supplier ? (' · ' + g.supplier) : '');
              return '<option value="' + g.id + '">' + _esc(label) + '</option>';
            }).join('');
      })
      .catch(function(){ if(sel) sel.innerHTML = '<option value="">Could not load GRNs</option>'; });
  }

  window._lriLoadGrnBoxes = function(grnId){
    var wrap = document.getElementById('lri-box-wrap');
    var rb = document.getElementById('lri-reason-block');
    _lriPickedBox = null;
    if(rb){ rb.style.display = 'none'; rb.innerHTML = ''; }
    if(!wrap) return;
    if(!grnId){ wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<div style="font-size:12px;color:var(--hmuted,#9ca3af);padding:8px 0">Loading boxes…</div>';
    fetch('/api/pm_stock/boxes/list?grn_id=' + encodeURIComponent(grnId) + '&limit=500')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.status !== 'ok' || !(d.boxes||[]).length){ wrap.innerHTML = '<div style="font-size:12px;color:#b45309;padding:8px 0">No boxes found for this GRN.</div>'; return; }
        wrap.innerHTML =
          '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
          + 'color:var(--hmuted2,#6b7280);margin-bottom:5px">2 · Pick the box</label>'
          + '<div style="max-height:220px;overflow-y:auto;border:1px solid var(--hbdr,rgba(0,0,0,.1));border-radius:8px">'
          + d.boxes.map(function(b){
              return '<div onclick="_lriPickBox(' + b.box_id + ',\'' + _esc(b.box_code).replace(/'/g,'') + '\',\''
                + _esc(b.product_name||'').replace(/'/g,'') + '\',\'' + _esc(b.grn_no||'').replace(/'/g,'') + '\',' + (Number(b.per_box_qty)||0)
                + ',' + (b.current_godown_id != null ? b.current_godown_id : 'null') + ')" '
                + 'style="padding:8px 11px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));cursor:pointer;font-size:12px;display:flex;justify-content:space-between;gap:8px" '
                + 'onmouseover="this.style.background=\'rgba(13,148,136,.06)\'" onmouseout="this.style.background=\'\'">'
                + '<span style="font-family:monospace;font-weight:700;color:var(--text,#0f172a)">' + _esc(b.box_code) + '</span>'
                + '<span style="color:var(--hmuted,#9ca3af)">box ' + (b.box_seq||'?') + '/' + (b.total_boxes||'?') + ' · ' + (Number(b.per_box_qty)||0) + '/box · ' + (b.current_status||'') + '</span>'
                + '</div>';
            }).join('')
          + '</div>';
      })
      .catch(function(){ wrap.innerHTML = '<div style="font-size:12px;color:#b91c1c;padding:8px 0">Could not load boxes.</div>'; });
  };

  window._lriPickBox = function(boxId, boxCode, productName, grnNo, perBoxQty, curGodownId){
    _lriPickedBox = { box_id: boxId, box_code: boxCode, product_name: productName,
                      grn_no: grnNo, per_box_qty: Number(perBoxQty) || 0,
                      current_godown_id: (curGodownId != null ? curGodownId : null),
                      current_godown_name: _lriGodownName(curGodownId) };
    // Highlight selection
    var wrap = document.getElementById('lri-box-wrap');
    if(wrap){
      Array.prototype.forEach.call(wrap.querySelectorAll('div[onclick^="_lriPickBox"]'), function(el){
        el.style.background = (el.textContent.indexOf(boxCode) === 0 || el.textContent.indexOf(boxCode) > -1) ? 'rgba(13,148,136,.14)' : '';
      });
    }
    _lriShowReason();
  };

  function _lriShowReason(){
    var rb = document.getElementById('lri-reason-block');
    if(!rb || !_lriPickedBox) return;
    _lriEnsureGodowns(function(){ _lriRenderReason(); });
  }

  function _lriRenderReason(){
    var rb = document.getElementById('lri-reason-block');
    if(!rb || !_lriPickedBox) return;
    var already = _lriBasket.some(function(x){ return x.box_id === _lriPickedBox.box_id; });
    var curGid = _lriPickedBox.current_godown_id;
    var curLocName = _lriPickedBox.current_godown_name || _lriGodownName(curGid) || '(unknown)';
    var locOptions = '<option value="">— keep current (' + _esc(curLocName) + ') —</option>'
      + (_lriGodowns || []).map(function(g){
          var sel = '';
          return '<option value="' + g.id + '"' + sel + '>' + _esc(g.name)
            + (g.is_floor ? ' (Factory)' : '') + '</option>';
        }).join('');
    rb.style.display = 'block';
    rb.innerHTML =
      '<div style="padding:9px 11px;background:rgba(13,148,136,.06);border:1px solid rgba(13,148,136,.25);'
      + 'border-radius:7px;font-size:12px;color:#0f766e;margin-bottom:10px">Selected: <strong>'
      + _esc(_lriPickedBox.product_name||'') + '</strong> · <span style="font-family:monospace">' + _esc(_lriPickedBox.box_code) + '</span>'
      + ' · at <strong>' + _esc(curLocName) + '</strong></div>'
      + (already
          ? '<div style="font-size:11.5px;color:#0f766e">✓ This box is already in your request list below.</div>'
          : (
            '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
            + 'color:var(--hmuted2,#6b7280);margin-bottom:5px">Reason for reissue *</label>'
            + '<textarea id="lri-reason-text" rows="2" placeholder="e.g. QR torn / smudged / unreadable" '
            + 'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--hbdr,rgba(0,0,0,.18));'
            + 'border-radius:7px;font-size:12.5px;font-family:inherit;resize:vertical"></textarea>'
            + '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
            + 'color:var(--hmuted2,#6b7280);margin:12px 0 5px">Per-box quantity <span style="font-weight:600;text-transform:none;color:var(--hmuted,#9ca3af)">(change only if the printed count was wrong — needs admin approval)</span></label>'
            + '<input id="lri-qty-input" type="number" min="0" step="any" value="' + (Number(_lriPickedBox.per_box_qty)||0) + '" '
            + 'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--hbdr,rgba(0,0,0,.18));'
            + 'border-radius:7px;font-size:12.5px">'
            + '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:4px">Current: '
            + (Number(_lriPickedBox.per_box_qty)||0) + ' per box. Leave unchanged to keep stock as-is.</div>'
            + '<label style="display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
            + 'color:var(--hmuted2,#6b7280);margin:12px 0 5px">Location <span style="font-weight:600;text-transform:none;color:var(--hmuted,#9ca3af)">(change only if the box is recorded at the wrong place — moves stock, needs admin approval)</span></label>'
            + '<select id="lri-loc-input" style="width:100%;box-sizing:border-box;padding:8px 10px;'
            + 'border:1px solid var(--hbdr,rgba(0,0,0,.18));border-radius:7px;font-size:12.5px">' + locOptions + '</select>'
            + '<button onclick="_lriAddToBasket()" class="btn btn-outline" '
            + 'style="margin-top:14px;width:100%;border-color:rgba(245,158,11,.5);color:#d97706;padding:9px;font-weight:700">'
            + '＋ Add this box to the request list</button>'
          ));
  }

  // ── Multi-box basket ────────────────────────────────────────────────
  window._lriAddToBasket = function(){
    if(!_lriPickedBox){ _toast('Pick a box first','error', 3000); return; }
    var ta = document.getElementById('lri-reason-text');
    var reason = (ta && ta.value || '').trim();
    if(!reason){ _toast('Enter a reason for this box','error', 3000); if(ta) ta.focus(); return; }
    if(_lriBasket.some(function(x){ return x.box_id === _lriPickedBox.box_id; })){
      _toast('This box is already in your list','info', 2500); return;
    }
    // Optional corrected per-box qty — only carry it if it differs.
    var qi = document.getElementById('lri-qty-input');
    var curQty = Number(_lriPickedBox.per_box_qty) || 0;
    var newQty = null;
    if(qi && qi.value !== '' && qi.value != null){
      var v = Number(qi.value);
      if(!isNaN(v) && v > 0 && Math.abs(v - curQty) > 1e-9) newQty = v;
      if(!isNaN(v) && v <= 0){ _toast('Quantity must be greater than 0','error', 3000); qi.focus(); return; }
    }
    // Optional location change — only carry it if a different godown chosen.
    var li = document.getElementById('lri-loc-input');
    var curGid = _lriPickedBox.current_godown_id;
    var newGid = null, newLocName = null;
    if(li && li.value !== '' && li.value != null){
      var gv = parseInt(li.value, 10);
      if(!isNaN(gv) && (curGid == null || gv !== parseInt(curGid, 10))){
        newGid = gv;
        newLocName = _lriGodownName(gv);
      }
    }
    _lriBasket.push({
      box_id: _lriPickedBox.box_id, box_code: _lriPickedBox.box_code,
      product_name: _lriPickedBox.product_name, reason: reason,
      old_per_box_qty: curQty, new_per_box_qty: newQty,
      old_godown_name: _lriPickedBox.current_godown_name || _lriGodownName(curGid),
      new_godown_id: newGid, new_godown_name: newLocName
    });
    _toast('＋ ' + _lriPickedBox.box_code + ' added', 'success', 2200);
    // Reset the picker for the next box.
    _lriPickedBox = null;
    if(_lriNewMode === 'type'){
      var ci = document.getElementById('lri-code-input');
      if(ci){ ci.value = ''; ci.focus(); }
      var cs = document.getElementById('lri-code-status');
      if(cs){ cs.textContent = 'Type the next code, or submit the list below.'; cs.style.color = 'var(--hmuted,#9ca3af)'; }
    } else {
      // Browse mode: clear box highlight so another can be picked.
      var wrap = document.getElementById('lri-box-wrap');
      if(wrap){
        Array.prototype.forEach.call(wrap.querySelectorAll('div[onclick^="_lriPickBox"]'), function(el){ el.style.background = ''; });
      }
    }
    var rb = document.getElementById('lri-reason-block');
    if(rb){ rb.style.display = 'none'; rb.innerHTML = ''; }
    _lriRenderBasket();
  };

  window._lriRemoveFromBasket = function(idx){
    _lriBasket.splice(idx, 1);
    _lriRenderBasket();
  };

  function _lriRenderBasket(){
    var host = document.getElementById('lri-basket');
    if(!host) return;
    if(!_lriBasket.length){ host.innerHTML = ''; return; }
    var rows = _lriBasket.map(function(item, i){
      var qtyTag = (item.new_per_box_qty != null)
        ? '<span style="flex:0 0 auto;font-size:10px;font-weight:700;color:#0f766e;background:rgba(13,148,136,.1);padding:1px 7px;border-radius:10px">qty ' + item.old_per_box_qty + ' → ' + item.new_per_box_qty + '</span>'
        : '';
      var locTag = (item.new_godown_id != null)
        ? '<span style="flex:0 0 auto;font-size:10px;font-weight:700;color:#6d28d9;background:rgba(109,40,217,.1);padding:1px 7px;border-radius:10px">📍 ' + _esc(item.old_godown_name||'?') + ' → ' + _esc(item.new_godown_name||'?') + '</span>'
        : '';
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;'
        + 'border-top:1px solid var(--hbdr,rgba(0,0,0,.07));font-size:11.5px">'
        + '<span style="font-family:monospace;font-weight:700;color:var(--text,#0f172a);flex:0 0 auto">' + _esc(item.box_code) + '</span>'
        + qtyTag + locTag
        + '<span style="color:var(--hmuted,#9ca3af);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(item.reason) + '</span>'
        + '<button onclick="_lriRemoveFromBasket(' + i + ')" title="Remove" '
        + 'style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto">✕</button>'
        + '</div>';
    }).join('');
    host.innerHTML =
      '<div style="border:1px solid rgba(245,158,11,.35);border-radius:8px;overflow:hidden;background:rgba(245,158,11,.04);margin-top:14px">'
      + '<div style="padding:6px 10px;background:rgba(245,158,11,.1);font-size:10px;font-weight:800;'
      + 'color:#92400e;text-transform:uppercase;letter-spacing:.5px">Request list · ' + _lriBasket.length + ' box' + (_lriBasket.length===1?'':'es') + '</div>'
      + rows
      + '<div style="padding:10px">'
      + '<button onclick="_lriSubmitBasket()" class="btn btn-primary" '
      + 'style="width:100%;background:#f59e0b;border-color:#f59e0b;color:#fff;padding:9px;font-weight:700">'
      + '📨 Submit ' + _lriBasket.length + ' reissue request' + (_lriBasket.length===1?'':'s') + ' to admin</button>'
      + '</div></div>';
  }

  window._lriSubmitBasket = function(){
    if(!_lriBasket.length){ _toast('Add at least one box first','error', 3000); return; }
    fetch('/api/pm_stock/label_reissue/request_bulk', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ items: _lriBasket.map(function(x){
        var o = { box_id: x.box_id, reason: x.reason };
        if(x.new_per_box_qty != null) o.new_per_box_qty = x.new_per_box_qty;
        if(x.new_godown_id != null) o.new_godown_id = x.new_godown_id;
        return o;
      }) })
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d.status === 'ok'){
        var msg = (d.created||0) + ' reissue request' + ((d.created===1)?'':'s') + ' sent to admin';
        if(d.skipped) msg += ' · ' + d.skipped + ' skipped';
        _toast('📨 ' + msg, 'success', 4500);
        _lriBasket = [];
        if(typeof refreshLabelReissueBadge === 'function') refreshLabelReissueBadge();
        window.openMyLabelReissuesModal();
      } else {
        _toast(d.message || 'Submit failed', 'error', 4500);
      }
    }).catch(function(e){ _toast('Network error: ' + (e.message||e), 'error', 4500); });
  };

  function _myRowHtml(r){
    var requested = '<div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:5px">Requested ' + _fmtDateTime(r.requested_at) + '</div>';
    var inner = '';
    if(r.status === 'approved'){
      inner = '<div style="margin-top:9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        + '<button id="lri-print-' + r.req_id + '" onclick="_lriPrintOnce(' + r.req_id + ', this)" '
        + 'class="btn btn-sm btn-primary" style="background:#0d9488;border-color:#0d9488;padding:6px 16px;font-weight:700;font-size:12px">'
        + '🏷️ Print replacement label</button>'
        + '<span style="font-size:11px;color:#0f766e">New code <strong style="font-family:monospace">' + _esc(r.new_short_code || '') + '</strong> — prints once, then locks. Old label is invalid.</span>'
        + '</div>';
    } else if(r.status === 'pending'){
      inner = '<div style="margin-top:8px;font-size:11px;color:#92400e">⏳ Waiting for an admin to approve.</div>';
    } else if(r.status === 'printed'){
      // One-time use: the requester cannot reprint. Admins still can.
      var adminReprint = _isAdminUser()
        ? '<button onclick="_lriPrintOnce(' + r.req_id + ', this)" '
          + 'class="btn btn-sm btn-outline" style="padding:6px 14px;font-weight:700;font-size:12px">🖨️ Reprint (admin)</button>'
        : '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#475569;'
          + 'background:rgba(100,116,139,.12);padding:5px 12px;border-radius:7px">🔒 Printed — already used</span>';
      inner = '<div style="margin-top:9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        + adminReprint
        + '<span style="font-size:11px;color:#475569">Printed ' + _fmtDateTime(r.printed_at)
        + (r.printed_by ? ' by ' + _esc(r.printed_by) : '')
        + ' · code <strong style="font-family:monospace">' + _esc(r.new_short_code || '') + '</strong></span>'
        + '</div>';
    } else if(r.status === 'rejected'){
      inner = '<div style="margin-top:8px;padding:8px 11px;background:rgba(220,38,38,.06);border:1px solid rgba(220,38,38,.25);'
        + 'border-radius:7px;font-size:11.5px;color:#991b1b">✗ Rejected'
        + (r.decided_note ? ' — "' + _esc(r.decided_note) + '"' : '') + '. You can submit a new request.</div>';
    }
    return _rowShell(r, requested + inner);
  }

  // One-time print wrapper: disables the button immediately so it can't be
  // double-clicked, prints, then refreshes the list (which re-renders the row
  // as 'printed' — locked for non-admins). If the print fails server-side
  // (e.g. already printed), the list refresh reflects the true state.
  window._lriPrintOnce = function(reqId, btn){
    if(btn){
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
      btn.textContent = 'Printing…';
    }
    if(typeof window.printReissuedLabel === 'function'){
      var p = window.printReissuedLabel(reqId);
      var done = function(){ _lriLoadMyList(); };
      if(p && typeof p.then === 'function'){ p.then(done, done); }
      else { setTimeout(done, 1200); }
    }
  };

  // ════════════════════════════════════════════════════════════════════
  // BADGE
  // ════════════════════════════════════════════════════════════════════
  window.refreshLabelReissueBadge = function(){
    fetch('/api/pm_stock/label_reissue/pending_count')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.status !== 'ok') return;
        var c = d.count || 0;
        ['label-reissue-approvals-badge','my-label-reissue-badge'].forEach(function(id){
          var el = document.getElementById(id);
          if(el){
            el.style.display = c > 0 ? 'inline-block' : 'none';
            el.textContent = c > 9 ? '9+' : String(c);
          }
        });
      })
      .catch(function(){});
  };
  setTimeout(window.refreshLabelReissueBadge, 2000);
  setInterval(function(){
    if(document.visibilityState === 'visible') window.refreshLabelReissueBadge();
  }, 30000);

})();
