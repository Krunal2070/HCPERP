/* ════════════════════════════════════════════════════════════════════════
   pm_stock_inline_userloc.js
   Extracted from pm_stock.html inline <script> blocks for maintainability.
   Each section below was previously a standalone inline block; concatenated
   here in original order so initialization sequencing is preserved.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Was inline block 7: User location manager modal ── */
(function(){
  // Local state — list of {user_name, home_godown_id, note, _dirty} rows
  // and the godowns list pulled from the cache or refetched.
  window._ulmRows = [];
  window._ulmSelected = new Set();   // selected user_names for bulk action

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // Build option list of godowns the system knows about.
  // We exclude billing/shipping types — they aren't physical stock locations.
  function _ulmGodownOptions(selectedId, includeBlank){
    const list = (window._godowns || []).filter(g =>
      g.godown_type !== 'billing' && g.godown_type !== 'shipping'
    );
    const blank = includeBlank ? `<option value="">— No location (no lock) —</option>` : '';
    return blank + list.map(g => {
      const isFloor = (g.godown_type === 'floor' || g.is_floor || (g.type||'').toLowerCase()==='floor');
      const label   = isFloor ? `${g.name} (Factory)` : g.name;
      const sel     = (Number(selectedId) === Number(g.id)) ? ' selected' : '';
      return `<option value="${g.id}"${sel}>${_esc(label)}</option>`;
    }).join('');
  }

  window.openUserLocationModal = async function(){
    if(typeof isAdminUser === 'function' && !isAdminUser()){
      if(typeof showToast==='function') showToast('Admin only','error');
      return;
    }
    const modal = document.getElementById('userLocModal');
    if(!modal) return;
    modal.classList.add('open');
    document.getElementById('ulm-search').value = '';
    document.getElementById('ulm-tbody').innerHTML =
      `<tr><td colspan="5" style="padding:32px;text-align:center;color:#9ca3af;font-size:12px"><i class="fas fa-spinner fa-spin"></i> Loading users…</td></tr>`;
    window._ulmSelected = new Set();

    try {
      // Make sure godowns are loaded (some pages may not have prefetched them)
      if(!window._godowns || !window._godowns.length){
        try {
          const gr = await fetch('/api/pm_stock/godowns');
          const gd = await gr.json();
          if(Array.isArray(gd)) window._godowns = gd;
        } catch(_){}
      }
      // Fill the bulk-action dropdown with the same godown list
      document.getElementById('ulm-bulk-godown').innerHTML =
        '<option value="">— Bulk assign location —</option>' +
        '<option value="__clear__">Clear (remove lock)</option>' +
        _ulmGodownOptions(null, false);

      const r = await fetch('/api/pm_stock/user_directory');
      const d = await r.json();
      if(d.status !== 'ok'){
        if(typeof showToast==='function') showToast(d.message || 'Failed to load users','error');
        return;
      }
      // Show which DB table is sourcing the names (or warn if fallback)
      const hint = document.getElementById('ulm-source-hint');
      if(hint){
        if(d.source_table){
          hint.textContent = `Source: ${d.source_table}`;
          hint.style.color = 'var(--hmuted2,#6b7280)';
        } else {
          hint.textContent = '⚠ No user master found — showing historical actors';
          hint.style.color = '#d97706';
        }
      }
      window._ulmRows = (d.users || []).map(u => ({
        user_name:      u.user_name,
        display_name:   u.display_name || '',
        user_role:      u.user_role || '',
        orphan:         !!u.orphan,
        home_godown_id: u.home_godown_id || null,
        note:           u.note || '',
        _dirty:         false,
        _orig_godown:   u.home_godown_id || null,
        _orig_note:     u.note || '',
      }));
      _ulmRender();
    } catch(e){
      if(typeof showToast==='function') showToast('Network error: '+(e.message||e),'error');
    }
  };

  function _ulmRender(){
    const filter = (document.getElementById('ulm-search')?.value || '').trim().toLowerCase();
    const rows = window._ulmRows.filter(r =>
      !filter || (r.user_name||'').toLowerCase().includes(filter)
        || (r.display_name||'').toLowerCase().includes(filter)
        || (r.note||'').toLowerCase().includes(filter)
    );
    const tbody = document.getElementById('ulm-tbody');
    if(!rows.length){
      tbody.innerHTML = `<tr><td colspan="5" style="padding:32px;text-align:center;color:#9ca3af;font-size:12px">No users match.</td></tr>`;
      _ulmUpdateSummary(); return;
    }
    tbody.innerHTML = rows.map(r => {
      const isSelected = window._ulmSelected.has(r.user_name);
      const dirtyBadge = r._dirty
        ? `<span style="margin-left:6px;font-size:8.5px;font-weight:800;padding:1px 6px;border-radius:3px;background:rgba(245,158,11,.15);color:#d97706;letter-spacing:.4px">UNSAVED</span>`
        : '';
      // "Orphan" rows — mappings that exist in pm_user_home_godown but the
      // user is no longer in the master table. Surface so admin can clear.
      const orphanBadge = r.orphan
        ? `<span style="margin-left:6px;font-size:8.5px;font-weight:800;padding:1px 6px;border-radius:3px;background:rgba(220,38,38,.12);color:#dc2626;letter-spacing:.4px" title="No longer in user master">ORPHAN</span>`
        : '';
      // Sub-line: display name + role if available
      const subBits = [];
      if(r.display_name) subBits.push(`<span style="color:#6b7280">${_esc(r.display_name)}</span>`);
      if(r.user_role)    subBits.push(`<span style="font-size:8.5px;font-weight:700;padding:0 5px;border-radius:3px;background:rgba(13,148,136,.10);color:var(--teal,#0d9488);text-transform:uppercase;letter-spacing:.4px">${_esc(r.user_role)}</span>`);
      const subLine = subBits.length
        ? `<div style="font-size:9.5px;margin-top:1px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">${subBits.join('')}</div>`
        : '';
      return `<tr data-user="${_esc(r.user_name)}" style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06));${r.orphan?'background:rgba(220,38,38,.03)':''}">
        <td style="padding:8px 10px;text-align:center">
          <input type="checkbox" class="ulm-cb" ${isSelected?'checked':''}
            onchange="ulmToggleRow('${_esc(r.user_name).replace(/'/g, "\\'")}', this.checked)"
            style="width:14px;height:14px;cursor:pointer;accent-color:var(--teal,#0d9488)">
        </td>
        <td style="padding:8px 10px">
          <div style="font-weight:700;font-size:12px;color:var(--htxtb,#111)">${_esc(r.user_name)}${dirtyBadge}${orphanBadge}</div>
          ${subLine}
        </td>
        <td style="padding:8px 10px">
          <select onchange="ulmEditGodown('${_esc(r.user_name).replace(/'/g, "\\'")}', this.value)"
            style="width:100%;background:var(--hinput,#fff);border:1.5px solid ${r._dirty?'rgba(245,158,11,.5)':'var(--hbdr2,rgba(0,0,0,.13))'};border-radius:5px;padding:5px 8px;font-size:12px;color:var(--htxtb,#111);outline:none">
            ${_ulmGodownOptions(r.home_godown_id, true)}
          </select>
        </td>
        <td style="padding:8px 10px">
          <input type="text" value="${_esc(r.note||'')}"
            placeholder="Optional note (e.g. shift, role)"
            oninput="ulmEditNote('${_esc(r.user_name).replace(/'/g, "\\'")}', this.value)"
            style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:5px;padding:5px 8px;font-size:12px;color:var(--htxtb,#111);outline:none">
        </td>
        <td style="padding:8px 10px;text-align:center">
          ${r.home_godown_id
            ? `<button onclick="ulmClearRow('${_esc(r.user_name).replace(/'/g, "\\'")}')" title="Clear this user's location lock" style="background:transparent;border:none;cursor:pointer;color:#ef4444;font-size:13px"><i class="fas fa-times-circle"></i></button>`
            : `<span style="color:#d1d5db;font-size:11px">—</span>`}
        </td>
      </tr>`;
    }).join('');
    _ulmUpdateSummary();
  }

  function _ulmUpdateSummary(){
    const total = window._ulmRows.length;
    const dirty = window._ulmRows.filter(r => r._dirty).length;
    const sel   = window._ulmSelected.size;
    const summary = document.getElementById('ulm-summary');
    if(summary){
      const parts = [`${total} user${total===1?'':'s'} total`];
      if(sel)   parts.push(`<strong style="color:var(--teal,#0d9488)">${sel} selected</strong>`);
      if(dirty) parts.push(`<strong style="color:#d97706">${dirty} unsaved change${dirty===1?'':'s'}</strong>`);
      summary.innerHTML = parts.join(' · ');
    }
    const btn = document.getElementById('ulm-save-btn');
    if(btn){ btn.disabled = !dirty; btn.style.opacity = dirty ? '1' : '.5'; }
  }

  // Per-row mutators
  window.ulmEditGodown = function(userName, val){
    const r = window._ulmRows.find(x => x.user_name === userName);
    if(!r) return;
    const newId = val ? parseInt(val) : null;
    if(newId !== r._orig_godown){
      r.home_godown_id = newId;
      r._dirty = true;
    } else {
      r.home_godown_id = newId;
      // Recalculate dirty by checking note too
      r._dirty = (r.note !== r._orig_note);
    }
    _ulmRender();
  };
  window.ulmEditNote = function(userName, val){
    const r = window._ulmRows.find(x => x.user_name === userName);
    if(!r) return;
    r.note = val;
    r._dirty = (r.note !== r._orig_note) || (r.home_godown_id !== r._orig_godown);
    _ulmUpdateSummary();
  };
  window.ulmClearRow = function(userName){
    const r = window._ulmRows.find(x => x.user_name === userName);
    if(!r) return;
    r.home_godown_id = null;
    r._dirty = (r._orig_godown !== null) || (r.note !== r._orig_note);
    _ulmRender();
  };

  // Selection
  window.ulmToggleRow = function(userName, checked){
    if(checked) window._ulmSelected.add(userName);
    else        window._ulmSelected.delete(userName);
    _ulmUpdateSummary();
  };
  window.ulmToggleAll = function(checked){
    window._ulmSelected = new Set();
    if(checked){
      const filter = (document.getElementById('ulm-search')?.value || '').trim().toLowerCase();
      window._ulmRows.forEach(r => {
        const matches = !filter || (r.user_name||'').toLowerCase().includes(filter)
                                || (r.note||'').toLowerCase().includes(filter);
        if(matches) window._ulmSelected.add(r.user_name);
      });
    }
    _ulmRender();
  };

  // Bulk action: assign the dropdown's chosen godown to all selected rows
  window.ulmBulkAssign = function(){
    const val = document.getElementById('ulm-bulk-godown').value;
    if(!val){ if(typeof showToast==='function') showToast('Pick a location to bulk-assign','error'); return; }
    if(!window._ulmSelected.size){ if(typeof showToast==='function') showToast('Select at least one user','error'); return; }
    const newId = (val === '__clear__') ? null : parseInt(val);
    window._ulmRows.forEach(r => {
      if(window._ulmSelected.has(r.user_name)){
        r.home_godown_id = newId;
        r._dirty = (r.home_godown_id !== r._orig_godown) || (r.note !== r._orig_note);
      }
    });
    _ulmRender();
    if(typeof showToast==='function') showToast(`✓ Updated ${window._ulmSelected.size} row(s) — review and save`,'success');
  };

  window.ulmFilter = function(){ _ulmRender(); };

  // Bulk save: send only dirty rows
  window.ulmSaveAll = async function(){
    const dirty = window._ulmRows.filter(r => r._dirty);
    if(!dirty.length){ if(typeof showToast==='function') showToast('No changes to save','info'); return; }

    const btn = document.getElementById('ulm-save-btn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    const mappings = dirty.map(r => ({
      user_name: r.user_name,
      godown_id: r.home_godown_id,   // null → server deletes
      note:      r.note || '',
    }));
    try {
      const r = await fetch('/api/pm_stock/user_home/bulk_set',{
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({mappings})
      });
      const d = await r.json();
      if(d.status !== 'ok'){
        if(typeof showToast==='function') showToast(d.message || 'Save failed','error');
        if(btn){ btn.disabled = false; btn.innerHTML = '💾 Save Changes'; }
        return;
      }
      if(typeof showToast==='function')
        showToast(`✓ Saved · ${d.upserted||0} upserted, ${d.deleted||0} cleared`,'success', 4000);
      // Mark all dirty rows as clean & update _orig_*
      window._ulmRows.forEach(r => {
        if(r._dirty){
          r._dirty = false;
          r._orig_godown = r.home_godown_id;
          r._orig_note   = r.note;
        }
      });
      _ulmRender();
    } catch(e){
      if(typeof showToast==='function') showToast('Network error: '+(e.message||e),'error');
    } finally {
      if(btn){ btn.disabled = false; btn.innerHTML = '💾 Save Changes'; }
    }
  };
})();

