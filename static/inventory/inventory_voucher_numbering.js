/* ═══════════════════════════════════════════════════════════════════════
   inventory_voucher_numbering.js
   ───────────────────────────────────────────────────────────────────────
   Admin-only panel for configuring inventory voucher number formats.
   Matches PM Voucher Numbering's UI exactly: tab bar at top per voucher
   type, list of styles per active tab, Active badge on whichever style
   has today inside its [valid_from, valid_to] window, edit pencil +
   delete buttons, "Add Numbering Style" button at bottom-left, Close
   button at bottom-right. Slide-in form for add/edit with live preview.

   Endpoints used:
     GET  /api/inventory_mgmt/voucher_numbering/list
          → { status, styles:[…], types:[{voucher_type,label}, …] }
     POST /api/inventory_mgmt/voucher_numbering/save
          Body: { voucher_type, id?, prefix, suffix, digits,
                  start_num, valid_from, valid_to }
     POST /api/inventory_mgmt/voucher_numbering/delete
          Body: { id }
     POST /api/inventory_mgmt/voucher_numbering/preview
          Body: { voucher_type, prefix, suffix, digits, start_num }
═══════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const API = '/api/inventory_mgmt/voucher_numbering';
  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const toast = (m, k, ms) => (window.invToast
    ? window.invToast(m, k, ms)
    : alert(m));

  /* ── State ────────────────────────────────────────────────────────── */
  let _types     = [];          // [{voucher_type, label}, …]
  let _styles    = [];          // [{id, voucher_type, prefix, …}, …]
  let _activeVT  = 'inv_mr';    // currently selected tab
  let _editId    = null;        // null = adding; integer = editing that row id
  let _previewDeb = null;

  /* ── DD/MM/YYYY date formatter (inventory standing rule) ────────── */
  function _fmtDate(iso){
    if(!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(iso);
  }
  function _todayISO(){ return new Date().toISOString().slice(0,10); }

  /* ── Nav injection ──────────────────────────────────────────────── */
  function _injectNav(){
    if($('inv-vn-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body');
    if(!navBody) return;
    const ready   = !!(window._invAccess && window._invAccess.ready);
    const isAdmin = !!(window._invAccess && window._invAccess.is_admin);
    if(ready && !isAdmin) return;  // admin-only menu

    // Prefer "Admin" section; fall back to "Vouchers"; else create one.
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Admin');
    if(!section){
      section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
        .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Vouchers');
    }
    if(!section){
      section = document.createElement('div');
      section.className = 'inv-nav-section';
      section.innerHTML = '<div class="inv-nav-section-label">Admin</div>';
      navBody.appendChild(section);
    }
    const item = document.createElement('div');
    item.className = 'inv-nav-item';
    item.id        = 'inv-vn-nav-item';
    item.title     = 'Voucher Numbering — configure inventory voucher number formats';
    item.onclick   = openModal;
    item.innerHTML = '<span class="ico">🔢</span><span>Voucher Numbering</span>';
    section.appendChild(item);
  }

  /* ── Modal scaffold ─────────────────────────────────────────────── */
  function _ensureModal(){
    let m = $('invVnModal');
    if(m) return m;
    m = document.createElement('div');
    m.id = 'invVnModal';
    m.style.cssText =
      'position:fixed;inset:0;background:rgba(15,23,42,.45);'
      + 'display:none;align-items:flex-start;justify-content:center;'
      + 'z-index:9999;padding:50px 20px 20px;overflow-y:auto';
    m.innerHTML =
        '<div style="background:var(--card,#fff);border-radius:16px;'
      +   'width:min(740px,100%);box-shadow:0 30px 60px rgba(0,0,0,.25);'
      +   'overflow:hidden;border:1px solid var(--border,rgba(0,0,0,.08));'
      +   'display:flex;flex-direction:column;max-height:calc(100vh - 80px)">'

      // header
      +   '<div style="padding:16px 20px;display:flex;align-items:flex-start;'
      +     'gap:12px;border-bottom:1px solid var(--border,rgba(0,0,0,.06))">'
      +     '<span style="font-size:22px">🏷️</span>'
      +     '<div style="flex:1;min-width:0">'
      +       '<div style="font-size:16px;font-weight:800;color:var(--text,#111)">'
      +         'Inventory Voucher Numbering</div>'
      +       '<div style="font-size:11.5px;color:var(--muted,#6b7280);margin-top:3px">'
      +         'Inventory-only · '
      +         '<a href="#" onclick="return false" '
      +              'style="color:var(--brand,#4648D4);font-family:monospace">'
      +           'inventory_voucher_numbering</a> table · '
      +         'Format: <strong>PREFIX / NNNN / SUFFIX</strong>'
      +       '</div>'
      +     '</div>'
      +     '<button onclick="invVnClose()" '
      +             'style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border2,rgba(0,0,0,.13));'
      +                    'background:transparent;cursor:pointer;font-size:14px;color:var(--muted,#6b7280)">×</button>'
      +   '</div>'

      // tab bar
      +   '<div id="invVnTabs" style="padding:14px 20px;border-bottom:1px solid var(--border,rgba(0,0,0,.06));'
      +     'display:flex;flex-wrap:wrap;gap:8px"></div>'

      // body (list + form area)
      +   '<div style="flex:1;overflow-y:auto;padding:14px 20px">'
      +     '<div id="invVnList"></div>'
      +     '<div id="invVnForm" style="display:none;margin-top:14px;padding:14px;'
      +       'border:1px solid var(--brand,#4648D4);border-radius:10px;'
      +       'background:rgba(70,72,212,.04)"></div>'
      +   '</div>'

      // footer
      +   '<div style="padding:14px 20px;border-top:1px solid var(--border,rgba(0,0,0,.06));'
      +     'display:flex;justify-content:space-between;align-items:center;gap:12px;'
      +     'background:rgba(0,0,0,.015)">'
      +     '<button id="invVnAddBtn" onclick="invVnStartAdd()" class="btn" '
      +             'style="padding:8px 14px;font-size:12.5px;font-weight:700">'
      +       '<i class="fas fa-plus" style="margin-right:6px"></i> Add Numbering Style'
      +     '</button>'
      +     '<button onclick="invVnClose()" class="btn" '
      +             'style="padding:8px 18px;font-size:12.5px">Close</button>'
      +   '</div>'

      + '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', (ev) => { if(ev.target === m) closeModal(); });
    document.addEventListener('keydown', (ev) => {
      if(ev.key === 'Escape' && m.style.display === 'flex') closeModal();
    });
    return m;
  }

  /* ── Lifecycle ──────────────────────────────────────────────────── */
  async function openModal(){
    const m = _ensureModal();
    m.style.display = 'flex';
    _editId = null;
    $('invVnList').innerHTML =
      '<div style="padding:30px;text-align:center;color:var(--muted,#9ca3af);font-style:italic">Loading…</div>';
    $('invVnForm').style.display = 'none';
    await reload();
  }
  function closeModal(){
    const m = $('invVnModal');
    if(m) m.style.display = 'none';
  }
  window.invVnClose = closeModal;
  window.invVnOpen  = openModal;

  /* ── Load + render ──────────────────────────────────────────────── */
  async function reload(){
    try {
      const r = await fetch(API + '/list');
      const d = await r.json();
      if(d.status !== 'ok'){
        $('invVnList').innerHTML =
          '<div style="padding:18px;color:var(--danger,#dc2626);font-size:12.5px">'
          + esc(d.message || 'Failed to load voucher numbering styles') + '</div>';
        return;
      }
      _types  = d.types  || [];
      _styles = d.styles || [];
      // First time loading? Default active tab to first type.
      if(!_types.find(t => t.voucher_type === _activeVT) && _types.length){
        _activeVT = _types[0].voucher_type;
      }
      renderTabs();
      renderList();
    } catch(e){
      $('invVnList').innerHTML =
        '<div style="padding:18px;color:var(--danger,#dc2626);font-size:12.5px">'
        + 'Network error: ' + esc(e.message || e) + '</div>';
    }
  }

  /* ── Tab bar ────────────────────────────────────────────────────── */
  function renderTabs(){
    const bar = $('invVnTabs');
    if(!bar) return;
    bar.innerHTML = _types.map(t => {
      const active = t.voucher_type === _activeVT;
      return ''
      + '<button onclick="invVnSwitchTab(\'' + esc(t.voucher_type) + '\')" '
      +         'style="height:32px;padding:0 14px;border-radius:7px;'
      +                'font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;'
      +                'border:1px solid ' + (active ? 'var(--brand,#4648D4)' : 'var(--border2,rgba(0,0,0,.13))') + ';'
      +                'background:' + (active ? 'rgba(70,72,212,.1)' : 'transparent') + ';'
      +                'color:' + (active ? 'var(--brand,#4648D4)' : 'var(--muted,#6b7280)') + '">'
      +   esc(t.label)
      + '</button>';
    }).join('');
  }

  window.invVnSwitchTab = function(vt){
    _activeVT = vt;
    _editId   = null;
    $('invVnForm').style.display = 'none';
    renderTabs();
    renderList();
  };

  /* ── List of styles for the active tab ──────────────────────────── */
  function renderList(){
    const list = $('invVnList');
    if(!list) return;
    const today = _todayISO();
    const rows  = _styles.filter(s => s.voucher_type === _activeVT);
    const label = (_types.find(t => t.voucher_type === _activeVT) || {}).label || _activeVT;

    if(!rows.length){
      list.innerHTML =
        '<div style="padding:30px;text-align:center;color:var(--muted,#9ca3af);font-size:13px">'
        + '<i class="fas fa-hashtag" style="font-size:24px;color:#cbd5e1;margin-bottom:8px;display:block"></i>'
        + 'No styles configured for <strong>' + esc(label) + '</strong>.'
        + '<br><span style="font-size:11.5px;color:var(--muted,#6b7280)">Click "Add Numbering Style" below to create one.</span>'
        + '</div>';
      return;
    }

    list.innerHTML = rows.map(s => {
      const isActive = s.valid_from <= today && s.valid_to >= today;
      const preview  = s.preview ||
        [s.prefix, String(s.start_num || 1).padStart(s.digits || 4, '0'), s.suffix]
          .filter(Boolean).join('/');

      return ''
      + '<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;margin-bottom:8px;'
      +             'border:1px solid ' + (isActive ? 'rgba(70,72,212,.4)' : 'var(--border2,rgba(0,0,0,.13))') + ';'
      +             'border-radius:10px;'
      +             'background:' + (isActive ? 'rgba(70,72,212,.04)' : 'var(--card,#fff)') + '">'
      +   '<div style="flex:1;min-width:0">'
      +     '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">'
      +       '<span style="font-family:monospace;font-size:14px;font-weight:800;'
      +                    'color:' + (isActive ? 'var(--brand,#4648D4)' : 'var(--text,#111)') + '">'
      +         esc(preview)
      +       '</span>'
      +       (isActive
        ? '<span style="font-size:9.5px;font-weight:800;padding:2px 9px;border-radius:10px;'
          + 'background:var(--brand,#4648D4);color:#fff;letter-spacing:.3px">Active</span>'
        : '')
      +     '</div>'
      +     '<div style="font-size:11px;color:var(--muted,#6b7280)">'
      +       'Prefix: <strong>' + esc(s.prefix || '—') + '</strong>'
      +       ' · Suffix: <strong>' + esc(s.suffix || '—') + '</strong>'
      +       ' · ' + esc(s.digits || 4) + ' digits'
      +       ' · ' + esc(_fmtDate(s.valid_from)) + ' → ' + esc(_fmtDate(s.valid_to))
      +     '</div>'
      +   '</div>'
      +   '<button onclick="invVnStartEdit(' + s.id + ')" '
      +           'title="Edit" '
      +           'style="width:32px;height:32px;border-radius:7px;'
      +                  'border:1px solid var(--border2,rgba(0,0,0,.13));background:transparent;'
      +                  'cursor:pointer;font-size:13px;color:#d97706">'
      +     '<i class="fas fa-pencil-alt"></i>'
      +   '</button>'
      +   '<button onclick="invVnDelete(' + s.id + ')" '
      +           'title="Delete" '
      +           'style="width:32px;height:32px;border-radius:7px;'
      +                  'background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);'
      +                  'cursor:pointer;font-size:13px;color:#ef4444">'
      +     '<i class="fas fa-trash-alt"></i>'
      +   '</button>'
      + '</div>';
    }).join('');
  }

  /* ── Add / Edit form ─────────────────────────────────────────────── */
  function _showForm(title){
    const f = $('invVnForm');
    if(!f) return;
    const today = _todayISO();
    // Sensible default validity: today → today + 1 year. Admin can edit.
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const oneYearOut = nextYear.toISOString().slice(0,10);

    f.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px;flex-wrap:wrap">'
      +   '<div style="font-size:13px;font-weight:800;color:var(--text,#111)">' + esc(title) + '</div>'
      +   '<div style="display:flex;align-items:center;gap:8px">'
      +     '<span style="font-size:10px;font-weight:700;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.4px">Preview</span>'
      +     '<span id="invVnFormPreview" '
      +           'style="display:inline-block;padding:4px 11px;border-radius:999px;'
      +                  'background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.25);'
      +                  'font-family:monospace;font-size:13px;font-weight:800;color:#166534">—</span>'
      +   '</div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">'
      +   _formField('Prefix',     'invVnPrefix',   'text',   '',          'e.g. INV-MR')
      +   _formField('Suffix',     'invVnSuffix',   'text',   '',          'e.g. 26-27')
      +   _formField('Digits',     'invVnDigits',   'number', 4,           '4', {min:1,max:8})
      +   _formField('Start at',   'invVnStartNum', 'number', 1,           '1', {min:1})
      +   _formField('Valid From', 'invVnFrom',     'date',   today,       '')
      +   _formField('Valid To',   'invVnTo',       'date',   oneYearOut,  '')
      + '</div>'
      + '<div style="margin-top:14px;display:flex;gap:8px;align-items:center">'
      +   '<button class="btn btn-primary" id="invVnSaveBtn" onclick="invVnSaveStyle()" '
      +           'style="padding:8px 18px;font-size:12.5px;font-weight:700">'
      +     '<i class="fas fa-save" style="margin-right:6px"></i> Save'
      +   '</button>'
      +   '<button class="btn" onclick="invVnCancelForm()" '
      +           'style="padding:8px 14px;font-size:12.5px">Cancel</button>'
      + '</div>';
    f.style.display = '';
    // Live preview hookup
    ['invVnPrefix','invVnSuffix','invVnDigits','invVnStartNum'].forEach(id => {
      const el = $(id);
      if(el) el.addEventListener('input', _schedulePreview);
    });
    _schedulePreview();
  }

  function _formField(label, id, type, value, placeholder, extra){
    extra = extra || {};
    const attrs = Object.keys(extra).map(k => k + '="' + extra[k] + '"').join(' ');
    return ''
    + '<div>'
    +   '<label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;'
    +                 'letter-spacing:.4px;color:var(--muted,#6b7280);margin-bottom:4px">'
    +     esc(label) + '</label>'
    +   '<input id="' + id + '" type="' + type + '" '
    +          'value="' + esc(value) + '" '
    +          'placeholder="' + esc(placeholder) + '" '
    +          (attrs ? attrs + ' ' : '')
    +          'style="width:100%;padding:8px 10px;border:1px solid var(--border,#d1d5db);'
    +                 'border-radius:7px;background:var(--card,#fff);color:var(--text,#111);'
    +                 'font-size:12.5px">'
    + '</div>';
  }

  function _formValues(){
    return {
      voucher_type: _activeVT,
      prefix:       ($('invVnPrefix')   || {}).value || '',
      suffix:       ($('invVnSuffix')   || {}).value || '',
      digits:       Number(($('invVnDigits')   || {}).value) || 4,
      start_num:    Number(($('invVnStartNum') || {}).value) || 1,
      valid_from:   ($('invVnFrom') || {}).value || null,
      valid_to:     ($('invVnTo')   || {}).value || null,
    };
  }

  function _schedulePreview(){
    clearTimeout(_previewDeb);
    _previewDeb = setTimeout(_refreshFormPreview, 250);
  }
  async function _refreshFormPreview(){
    try {
      const r = await fetch(API + '/preview', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(_formValues()),
      });
      const d = await r.json();
      const el = $('invVnFormPreview');
      if(el) el.textContent = (d.status === 'ok' && d.preview) ? d.preview : '—';
    } catch(e){ /* silent */ }
  }

  window.invVnStartAdd = function(){
    _editId = null;
    const lbl = (_types.find(t => t.voucher_type === _activeVT) || {}).label || _activeVT;
    _showForm('New Numbering Style — ' + lbl);
    setTimeout(() => { const p = $('invVnPrefix'); if(p) p.focus(); }, 50);
  };

  window.invVnStartEdit = function(id){
    const s = _styles.find(x => x.id === id);
    if(!s) return;
    _editId = id;
    _showForm('Edit Numbering Style #' + id);
    $('invVnPrefix').value   = s.prefix || '';
    $('invVnSuffix').value   = s.suffix || '';
    $('invVnDigits').value   = s.digits || 4;
    $('invVnStartNum').value = s.start_num || 1;
    $('invVnFrom').value     = s.valid_from || '';
    $('invVnTo').value       = s.valid_to || '';
    _schedulePreview();
  };

  window.invVnCancelForm = function(){
    _editId = null;
    $('invVnForm').style.display = 'none';
  };

  window.invVnSaveStyle = async function(){
    const v = _formValues();
    if(!v.valid_from || !v.valid_to){
      toast('Valid From and Valid To are required', 'error', 4000);
      return;
    }
    if(v.valid_from > v.valid_to){
      toast('Valid From must be on or before Valid To', 'error', 4000);
      return;
    }
    const btn = $('invVnSaveBtn');
    const orig = btn ? btn.innerHTML : '';
    if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }
    try {
      const payload = Object.assign({}, v);
      if(_editId) payload.id = _editId;
      const r = await fetch(API + '/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if(d.status === 'ok'){
        toast('✓ Saved · next number: ' + (d.preview || '—'), 'success', 3000);
        _editId = null;
        $('invVnForm').style.display = 'none';
        await reload();
      } else {
        toast(d.message || 'Save failed', 'error', 4000);
      }
    } catch(e){
      toast('Network error: ' + (e.message || e), 'error', 4000);
    } finally {
      if(btn){ btn.disabled = false; btn.innerHTML = orig; }
    }
  };

  window.invVnDelete = async function(id){
    const s = _styles.find(x => x.id === id);
    if(!s) return;
    const lbl = (_types.find(t => t.voucher_type === s.voucher_type) || {}).label
                || s.voucher_type;
    if(!confirm('Delete this numbering style for "' + lbl + '"?')){
      return;
    }
    try {
      const r = await fetch(API + '/delete', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if(d.status === 'ok'){
        toast('✓ Style deleted', 'success', 2500);
        await reload();
      } else {
        toast(d.message || 'Delete failed', 'error', 4500);
      }
    } catch(e){
      toast('Network error: ' + (e.message || e), 'error', 4000);
    }
  };

  /* ── Boot ─────────────────────────────────────────────────────────── */
  function _boot(){ _injectNav(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot);
  else _boot();
  document.addEventListener('inv-access-ready', _boot);

  console.log('✅ inventory_voucher_numbering.js loaded (PM-style multi-style admin)');
})();
