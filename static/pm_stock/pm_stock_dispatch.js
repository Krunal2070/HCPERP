/* ════════════════════════════════════════════════════════════════════
   pm_stock_dispatch.js
   ────────────────────────────────────────────────────────────────────
   Frontend for Dispatch Entry vouchers (PM-DSP).

   Flow:
     1. openDispatchModal()                 — create new draft OR open existing
     2. _dspPickFgRow(line_idx)            — opens the FG picker for a row
     3. _dspExpandLine(line_idx)           — fetch BOM expansion, show comps
     4. _dspSaveDraft() | _dspSubmit()     — persist
     5. _dspPrint(voucher_id)              — open print view in new tab

   State is held in window._dspState:
     {
       voucher_id, voucher_no, voucher_date, location_id, state,
       remarks, editable, needs_admin_unlock,
       lines: [
         { line_id?, fg_id, fg_code, fg_name, fg_qty,
           bom_id, bom_version, components: [...] }
       ]
     }

   Persistence model:
     - "Save Draft" creates the voucher row on the server if it doesn't
       exist yet, then upserts each line individually (add-or-update).
       Lines that exist on the server but no longer in state get deleted.
     - "Submit" validates state, saves any pending edits, then calls the
       submit endpoint.
   ──────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const FACTORY_LOC = 1;
  const FLOOR_LOC   = 4;

  let _dspState = null;

  /* ── Toast shim ───────────────────────────────────────────────── */
  function _dspToast(msg, type, ms){
    if (typeof showToast === 'function') return showToast(msg, type, ms || 3500);
    if (type === 'error') console.error(msg); else console.log(msg);
    alert(msg);
  }

  function _dspEsc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _fmt(n){
    if (n == null || n === '') return '';
    const v = Number(n);
    if (isNaN(v)) return String(n);
    return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  }

  /* ── Open the dispatch modal ──────────────────────────────────── */
  // mode: 'new' (creates a fresh draft) or { voucher_id: N } (loads existing)
  async function openDispatchModal(mode){
    const modal = document.getElementById('dispatchModal');
    if (!modal) {
      _dspToast('Dispatch modal HTML not loaded — refresh the page.', 'error');
      return;
    }
    modal.classList.add('open');

    // Warm the FG cache so the combobox is instant. Awaited so first
    // render of a line has the datalist ready.
    await _dspLoadFgCache();

    if (mode && typeof mode === 'object' && mode.voucher_id) {
      await _dspLoad(mode.voucher_id);
    } else {
      // Reset to a blank new-draft form
      _dspState = {
        voucher_id: null,
        voucher_no: null,
        voucher_date: (new Date()).toISOString().slice(0,10),
        location_id: FACTORY_LOC,
        state: 'draft',
        remarks: '',
        editable: true,
        needs_admin_unlock: false,
        lines: [],
      };
      _dspRender();
    }
  }
  window.openDispatchModal = openDispatchModal;

  function closeDispatchModal(){
    const modal = document.getElementById('dispatchModal');
    if (modal) modal.classList.remove('open');
  }
  window.closeDispatchModal = closeDispatchModal;

  /* ── Load existing voucher ──────────────────────────────────── */
  async function _dspLoad(voucher_id){
    try {
      const r = await fetch(`/api/pm_stock/dispatch/${voucher_id}`);
      const d = await r.json();
      if (d.status !== 'ok'){
        _dspToast(d.message || 'Failed to load voucher', 'error');
        closeDispatchModal();
        return;
      }
      const v = d.voucher;
      _dspState = {
        voucher_id:   v.voucher_id,
        voucher_no:   v.voucher_no,
        voucher_date: (v.voucher_date || '').slice(0,10),
        location_id:  parseInt(v.location_id) || FACTORY_LOC,
        state:        (v.state || 'draft').toLowerCase(),
        remarks:      v.remarks || '',
        editable:     !!v.editable,
        edit_block_reason: v.edit_block_reason || '',
        needs_admin_unlock: !!v.needs_admin_unlock,
        admin_password: '', // not stored client-side except per-edit
        lines: (v.lines || []).map(L => ({
          line_id:   L.line_id,
          fg_id:     L.fg_id,
          fg_code:   L.fg_code,
          fg_name:   L.fg_name,
          fg_qty:    parseFloat(L.fg_qty) || 0,
          bom_id:    L.bom_id,
          bom_version: L.bom_version,
          components: (L.components || []).map(c => ({
            cons_id:      c.cons_id,
            product_id:   c.product_id,
            product_name: c.product_name,
            product_code: c.product_code,
            pm_type:      c.pm_type,
            qty:          parseFloat(c.qty) || 0,
            bom_qty:      parseFloat(c.bom_qty) || 0,
            note:         c.note || '',
          })),
          _dirty: false,
        })),
        _meta: {
          submitted_at: v.submitted_at,
          submitted_by: v.submitted_by,
          created_by:   v.created_by,
          created_at:   v.created_at,
        },
      };
      _dspRender();
    } catch (e) {
      _dspToast('Network error: ' + e.message, 'error');
      closeDispatchModal();
    }
  }

  /* ── Render the modal ─────────────────────────────────────────── */
  function _dspRender(){
    const s = _dspState;
    if (!s) return;
    const readOnly = !s.editable;

    // Header bits
    document.getElementById('dsp-voucher-no').textContent =
      s.voucher_no ? s.voucher_no : (s.state === 'draft' ? 'New Draft' : '—');
    document.getElementById('dsp-state-pill').innerHTML = _dspStatePill(s.state);
    document.getElementById('dsp-voucher-date').value = s.voucher_date;
    document.getElementById('dsp-voucher-date').disabled = readOnly;
    document.getElementById('dsp-location').value = String(s.location_id);
    document.getElementById('dsp-location').disabled = readOnly || (s.lines && s.lines.length > 0);
    document.getElementById('dsp-remarks').value = s.remarks || '';
    document.getElementById('dsp-remarks').disabled = readOnly;

    // Show edit-block banner if needed
    const banner = document.getElementById('dsp-edit-banner');
    if (!s.editable && s.edit_block_reason){
      banner.style.display = '';
      banner.innerHTML = `
        <i class="fas fa-lock" style="margin-right:6px"></i>
        ${_dspEsc(s.edit_block_reason)}
        ${s.needs_admin_unlock ? `
          <button class="btn btn-sm" style="margin-left:10px;background:#7c3aed;color:#fff;border:none;padding:4px 10px"
                  onclick="_dspUnlock()">🔐 Admin Unlock</button>
        ` : ''}
      `;
    } else {
      banner.style.display = 'none';
    }

    // Lines table
    const tbody = document.getElementById('dsp-lines-tbody');
    if (s.lines.length === 0){
      tbody.innerHTML = `
        <tr><td colspan="5" style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af)">
          No FG lines yet — click <b>+ Add FG Line</b> below to start.
        </td></tr>`;
    } else {
      tbody.innerHTML = s.lines.map((L, idx) => _dspRenderLine(L, idx, readOnly)).join('');
    }

    // Footer buttons
    const addBtn   = document.getElementById('dsp-add-line-btn');
    const saveBtn  = document.getElementById('dsp-save-btn');
    const submitBtn= document.getElementById('dsp-submit-btn');
    const printBtn = document.getElementById('dsp-print-btn');
    const cancelBtn= document.getElementById('dsp-cancel-btn');

    addBtn.disabled    = readOnly;
    saveBtn.style.display    = (s.state === 'draft' || s.editable) ? '' : 'none';
    saveBtn.disabled         = readOnly;
    saveBtn.textContent      = (s.state === 'draft') ? '💾 Save Draft' : '💾 Save Changes';
    submitBtn.style.display  = (s.state === 'draft') ? '' : 'none';
    submitBtn.disabled       = readOnly;
    printBtn.style.display   = (s.state === 'submitted' || s.state === 'locked') ? '' : 'none';
    cancelBtn.style.display  = (s.state === 'submitted' || s.state === 'locked') ? '' : 'none';

    // Keep the page-level datalist in sync with which FGs are still pickable
    _dspSyncDatalist();
  }

  function _dspStatePill(state){
    const map = {
      'draft':     { bg:'#fef3c7', fg:'#92400e', label:'Draft' },
      'submitted': { bg:'#d1fae5', fg:'#065f46', label:'Submitted' },
      'locked':    { bg:'#e0e7ff', fg:'#3730a3', label:'Locked (24h)' },
      'cancelled': { bg:'#fee2e2', fg:'#991b1b', label:'Cancelled' },
    };
    const c = map[state] || map['draft'];
    return `<span style="padding:2px 9px;border-radius:999px;background:${c.bg};color:${c.fg};font-weight:700;font-size:10.5px">${c.label}</span>`;
  }

  function _dspRenderLine(L, idx, readOnly){
    const expanded = (L._expanded !== false);  // default open
    const compsHtml = expanded ? _dspRenderComponents(L, idx, readOnly) : '';
    const compsTotal = (L.components || []).reduce((s, c) => s + (parseFloat(c.qty) || 0), 0);
    return `
      <tr style="background:rgba(139,92,246,.04)">
        <td style="padding:10px 12px;width:32px;vertical-align:top">
          <button class="btn btn-sm" onclick="_dspToggleLine(${idx})"
                  style="padding:2px 6px;background:transparent;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:4px">
            ${expanded ? '▾' : '▸'}
          </button>
        </td>
        <td style="padding:10px 12px;vertical-align:top">
          ${L.fg_id ? `
            <div style="display:flex;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;color:var(--htxtb,#111);font-size:12.5px">${_dspEsc(L.fg_name)}</div>
                <div style="font-family:monospace;font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px">${_dspEsc(L.fg_code || '')}</div>
              </div>
              ${readOnly ? '' : `
                <button class="btn btn-sm" onclick="_dspChangeFg(${idx})"
                        title="Change FG product"
                        style="background:transparent;border:1px solid var(--hbdr2,rgba(0,0,0,.13));padding:3px 8px;font-size:11px;color:var(--hmuted2,#6b7280);border-radius:5px">
                  <i class="fas fa-pen"></i>
                </button>
              `}
            </div>
          ` : `
            <input type="text" list="dsp-fg-options" autocomplete="off" spellcheck="false"
                   placeholder="Type FG code or name…"
                   oninput="_dspFgComboInput(${idx}, this.value)"
                   onchange="_dspFgComboCommit(${idx}, this.value)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"
                   ${readOnly ? 'disabled' : ''}
                   style="width:100%;padding:6px 10px;border:1.5px solid #8b5cf6;border-radius:6px;background:var(--hinput,#fff);color:var(--htxtb,#111);font-size:12.5px;box-sizing:border-box">
          `}
        </td>
        <td style="padding:10px 12px;vertical-align:top;width:140px">
          <input type="number" min="0.001" step="0.001"
                 value="${L.fg_qty || ''}"
                 onchange="_dspChangeFgQty(${idx}, this.value)"
                 ${readOnly ? 'disabled' : ''}
                 style="width:100%;padding:5px 8px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:6px;font-family:monospace;text-align:right;font-size:12px;background:var(--hinput,#fff);color:var(--htxtb,#111)">
        </td>
        <td style="padding:10px 12px;vertical-align:top;width:160px;text-align:right">
          <div style="font-family:monospace;color:#16a34a;font-weight:700;font-size:12px">${_fmt(compsTotal)} units</div>
          <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px">${L.components.length} components</div>
        </td>
        <td style="padding:10px 12px;vertical-align:top;width:36px;text-align:right">
          ${readOnly ? '' : `
            <button class="btn btn-sm" onclick="_dspDeleteLine(${idx})"
                    style="background:transparent;border:none;color:#dc2626;cursor:pointer;padding:4px;font-size:13px">
              <i class="fas fa-trash"></i>
            </button>
          `}
        </td>
      </tr>
      ${expanded && L.fg_id ? `
        <tr>
          <td></td>
          <td colspan="4" style="padding:0 12px 16px 12px">
            ${compsHtml}
          </td>
        </tr>
      ` : ''}
    `;
  }

  function _dspRenderComponents(L, lineIdx, readOnly){
    if (!L.components || L.components.length === 0){
      return `<div style="padding:10px;font-size:11.5px;color:var(--hmuted,#9ca3af);font-style:italic">No components yet — set FG qty and they'll auto-populate from BOM.</div>`;
    }
    return `
      <div style="background:var(--hsurf2,#f9fafb);border:1px solid var(--hbdr,rgba(0,0,0,.07));border-radius:8px;overflow:hidden">
        <div style="padding:8px 12px;font-size:10.5px;font-weight:700;color:var(--hmuted2,#6b7280);background:var(--hsurf,#fff);text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.07))">
          PM Components (will be deducted on submit)
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px">
          <thead>
            <tr style="background:var(--hsurf,#fff);color:var(--hmuted2,#6b7280);font-size:10px">
              <th style="padding:6px 10px;text-align:left;font-weight:600">Component</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;width:120px">BOM Qty</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;width:120px">Actual Qty</th>
              <th style="padding:6px 10px;text-align:left;font-weight:600;width:180px">Note</th>
            </tr>
          </thead>
          <tbody>
            ${L.components.map((c, cIdx) => `
              <tr style="border-top:1px solid var(--hbdr,rgba(0,0,0,.05))">
                <td style="padding:6px 10px;color:var(--htxtb,#111)">
                  <div>${_dspEsc(c.product_name)}</div>
                  <div style="font-size:10px;color:var(--hmuted,#9ca3af);font-family:monospace">${_dspEsc(c.product_code || '')} · ${_dspEsc(c.pm_type || '')}</div>
                </td>
                <td style="padding:6px 10px;text-align:right;font-family:monospace;color:var(--hmuted,#9ca3af)">${_fmt(c.bom_qty)}</td>
                <td style="padding:6px 10px;text-align:right">
                  <input type="number" min="0" step="0.001"
                         value="${c.qty || 0}"
                         onchange="_dspChangeCompQty(${lineIdx}, ${cIdx}, this.value)"
                         ${readOnly ? 'disabled' : ''}
                         style="width:100%;padding:3px 6px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:4px;font-family:monospace;text-align:right;font-size:11px;background:var(--hinput,#fff);color:${Math.abs((c.qty||0)-(c.bom_qty||0))>0.001 ? '#d97706' : 'var(--htxtb,#111)'};font-weight:${Math.abs((c.qty||0)-(c.bom_qty||0))>0.001 ? '700' : '400'}">
                </td>
                <td style="padding:6px 10px">
                  <input type="text" maxlength="200"
                         value="${_dspEsc(c.note || '')}"
                         onchange="_dspChangeCompNote(${lineIdx}, ${cIdx}, this.value)"
                         ${readOnly ? 'disabled' : ''}
                         style="width:100%;padding:3px 6px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:4px;font-size:11px;background:var(--hinput,#fff);color:var(--htxtb,#111)">
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ── Line operations ─────────────────────────────────────────── */
  window._dspToggleLine = function(idx){
    const L = _dspState.lines[idx];
    L._expanded = !(L._expanded !== false);
    _dspRender();
  };

  window._dspAddLine = function(){
    _dspState.lines.push({
      fg_id: null, fg_code: '', fg_name: '',
      fg_qty: 0, bom_id: null, bom_version: null,
      components: [],
      _dirty: true, _expanded: true,
    });
    _dspSyncDatalist();
    _dspRender();
  };

  // Clear the FG selection on a line so the combobox reappears for re-pick.
  window._dspChangeFg = function(idx){
    const L = _dspState.lines[idx];
    if (!L) return;
    if (L.components && L.components.length){
      if (!confirm('Changing FG will clear the component list for this line. Continue?')) return;
    }
    L.fg_id = null; L.fg_code = ''; L.fg_name = '';
    L.bom_id = null; L.bom_version = null;
    L.components = [];
    L._dirty = true;
    _dspSyncDatalist();
    _dspRender();
  };

  window._dspDeleteLine = async function(idx){
    const L = _dspState.lines[idx];
    if (!confirm(`Remove FG line "${L.fg_name || '(empty)'}" from voucher?`)) return;

    // If the line exists on the server (has line_id), delete it remotely first
    if (L.line_id && _dspState.voucher_id){
      const body = { admin_password: _dspState.admin_password || '' };
      try {
        const r = await fetch(`/api/pm_stock/dispatch/${_dspState.voucher_id}/lines/${L.line_id}/delete`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.status !== 'ok'){
          _dspToast(d.message || 'Delete failed', 'error');
          return;
        }
      } catch (e){
        _dspToast('Network error: ' + e.message, 'error');
        return;
      }
    }
    _dspState.lines.splice(idx, 1);
    _dspRender();
  };

  window._dspChangeFgQty = async function(idx, val){
    const L = _dspState.lines[idx];
    const v = parseFloat(val) || 0;
    if (v <= 0){
      _dspToast('FG qty must be greater than 0', 'error');
      _dspRender();
      return;
    }
    L.fg_qty = v;
    L._dirty = true;
    // Auto-recompute components from BOM (only if FG is set)
    if (L.fg_id){
      await _dspRecomputeBom(idx);
    }
    _dspRender();
  };

  window._dspChangeCompQty = function(lineIdx, compIdx, val){
    const c = _dspState.lines[lineIdx].components[compIdx];
    const v = parseFloat(val) || 0;
    if (v < 0){
      _dspToast('Component qty cannot be negative', 'error');
      _dspRender();
      return;
    }
    c.qty = v;
    _dspState.lines[lineIdx]._dirty = true;
    _dspRender();
  };

  window._dspChangeCompNote = function(lineIdx, compIdx, val){
    _dspState.lines[lineIdx].components[compIdx].note = (val || '').slice(0,200);
    _dspState.lines[lineIdx]._dirty = true;
  };

  async function _dspRecomputeBom(lineIdx){
    const L = _dspState.lines[lineIdx];
    if (!L.fg_id || !L.fg_qty) return;
    try {
      const r = await fetch('/api/pm_stock/dispatch/expand_bom', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ fg_id: L.fg_id, fg_qty: L.fg_qty }),
      });
      const d = await r.json();
      if (d.status !== 'ok'){
        _dspToast(d.message || 'BOM expansion failed', 'error');
        return;
      }
      L.bom_id      = d.bom_id;
      L.bom_version = d.bom_version;
      L.components  = d.items.map(it => ({
        product_id:   it.product_id,
        product_name: it.product_name,
        product_code: it.product_code,
        pm_type:      it.pm_type,
        bom_qty:      it.bom_qty,
        qty:          it.bom_qty,   // Default to BOM qty (user can edit)
        note:         it.note || '',
      }));
    } catch (e){
      _dspToast('Network error: ' + e.message, 'error');
    }
  }

  /* ── FG cache for combobox ───────────────────────────────────── */
  // Loaded once per modal open. Shape: [{fg_id, fg_code, fg_name,
  // brand_name, bom_id, bom_version}, ...].
  let _dspFgCache = [];
  let _dspFgCacheLoaded = false;

  async function _dspLoadFgCache(force){
    if (_dspFgCacheLoaded && !force) return;
    try {
      // Empty query returns first 50 — for a fuller list we'd paginate.
      // 50 is enough for the typeahead's datalist suggestion list to
      // be useful; the user's typed text still searches server-side
      // on every change via _dspFgDatalistInput.
      const r = await fetch('/api/pm_stock/dispatch/fg_picker?q=');
      const d = await r.json();
      _dspFgCache = (d && d.status === 'ok') ? (d.rows || []) : [];
      _dspFgCacheLoaded = true;
      _dspSyncDatalist();
    } catch (e){
      console.error('FG cache load failed:', e);
    }
  }

  // Sync the page-level <datalist> element so every <input list="dsp-fg-options">
  // sees the cached suggestions.
  function _dspSyncDatalist(){
    const dl = document.getElementById('dsp-fg-options');
    if (!dl) return;
    // Exclude FGs already on the voucher
    const taken = new Set((_dspState && _dspState.lines || []).map(L => L.fg_id).filter(Boolean));
    dl.innerHTML = _dspFgCache
      .filter(f => !taken.has(f.fg_id))
      .map(f => `<option value="${_dspEsc(f.fg_code)}">${_dspEsc(f.fg_code)} — ${_dspEsc(f.fg_name)}${f.brand_name ? ' · ' + _dspEsc(f.brand_name) : ''}</option>`)
      .join('');
  }

  // Find a cached FG by an arbitrary user typed string. Match strategy:
  //   1) exact fg_code match (case-insensitive)
  //   2) "code — name" prefix match (what datalist returns on select)
  //   3) full fg_name case-insensitive match
  // Returns the matched cache row or null.
  function _dspMatchFgFromText(text){
    if (!text) return null;
    const t = text.trim();
    const lower = t.toLowerCase();
    // Strip the " — name…" suffix some users get when they accept the
    // datalist suggestion as the full label (Firefox does this on some
    // platforms).
    const codeOnly = t.split(/\s+[—-]\s+/)[0].trim();
    for (const f of _dspFgCache){
      if (!f.fg_code) continue;
      if (f.fg_code.toLowerCase() === codeOnly.toLowerCase()) return f;
    }
    for (const f of _dspFgCache){
      if (f.fg_name && f.fg_name.toLowerCase() === lower) return f;
    }
    return null;
  }

  // Server search-as-you-type: refreshes the cache when the user types
  // something not in the initial 50. Throttled.
  let _dspComboT = null;
  window._dspFgComboInput = function(lineIdx, val){
    clearTimeout(_dspComboT);
    _dspComboT = setTimeout(async () => {
      const q = (val || '').trim();
      if (!q || q.length < 2) return;
      try {
        const r = await fetch('/api/pm_stock/dispatch/fg_picker?q=' + encodeURIComponent(q));
        const d = await r.json();
        if (d && d.status === 'ok' && Array.isArray(d.rows)){
          // Merge into cache (dedupe by fg_id)
          const seen = new Set(_dspFgCache.map(f => f.fg_id));
          for (const row of d.rows){
            if (!seen.has(row.fg_id)){ _dspFgCache.push(row); seen.add(row.fg_id); }
          }
          _dspSyncDatalist();
        }
      } catch (e){ /* ignore */ }
    }, 220);
  };

  // Called on input blur / Enter / datalist-accept. If text matches a
  // cached FG, commit it; else show a small hint and reset.
  window._dspFgComboCommit = async function(lineIdx, val){
    const L = _dspState.lines[lineIdx];
    if (!L) return;
    const text = (val || '').trim();
    if (!text){
      // User cleared the box — reset the line back to "no FG"
      L.fg_id = null; L.fg_code = ''; L.fg_name = '';
      L.bom_id = null; L.bom_version = null; L.components = [];
      L._dirty = true;
      _dspRender();
      return;
    }
    const match = _dspMatchFgFromText(text);
    if (!match){
      _dspToast('No FG matches "' + text + '". Type or select from the list.', 'error', 3000);
      // Re-render to clear the input (user can try again)
      _dspRender();
      return;
    }
    // Block dup-FG on the client side (mirror server check)
    const taken = (_dspState.lines || []).find((LL, idx) =>
      idx !== lineIdx && LL.fg_id === match.fg_id);
    if (taken){
      _dspToast('That FG is already on the voucher. Edit that line instead.', 'error', 3500);
      _dspRender();
      return;
    }
    L.fg_id       = match.fg_id;
    L.fg_code     = match.fg_code;
    L.fg_name     = match.fg_name;
    L.bom_id      = match.bom_id;
    L.bom_version = match.bom_version;
    L._dirty      = true;
    if (L.fg_qty > 0){
      await _dspRecomputeBom(lineIdx);
    }
    _dspSyncDatalist();   // FG is now "taken" — remove from datalist
    _dspRender();
  };

  /* ── FG picker (legacy modal — kept for backward compat) ────── */
  let _dspPickerLineIdx = -1;
  window._dspPickFgRow = function(idx){
    _dspPickerLineIdx = idx;
    const m = document.getElementById('dspFgPickerModal');
    m.classList.add('open');
    document.getElementById('dsp-fg-search').value = '';
    _dspFgSearch('');
    setTimeout(() => document.getElementById('dsp-fg-search')?.focus(), 100);
  };

  window._dspCloseFgPicker = function(){
    document.getElementById('dspFgPickerModal').classList.remove('open');
  };

  let _dspFgSearchT = null;
  window._dspFgSearchInput = function(val){
    clearTimeout(_dspFgSearchT);
    _dspFgSearchT = setTimeout(() => _dspFgSearch(val), 200);
  };

  async function _dspFgSearch(q){
    const list = document.getElementById('dsp-fg-list');
    list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--hmuted,#9ca3af)"><span class="spinner"></span> Searching…</div>`;
    try {
      const url = '/api/pm_stock/dispatch/fg_picker?q=' + encodeURIComponent(q || '');
      const r = await fetch(url);
      const d = await r.json();
      if (d.status !== 'ok'){
        list.innerHTML = `<div style="padding:16px;color:#dc2626">${_dspEsc(d.message || 'Failed')}</div>`;
        return;
      }
      if (!d.rows || d.rows.length === 0){
        list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--hmuted,#9ca3af)">No FG products with a BOM matched.</div>`;
        return;
      }

      // Exclude FGs already on the voucher
      const taken = new Set((_dspState.lines || []).map(L => L.fg_id).filter(Boolean));
      list.innerHTML = d.rows.map(r => {
        const dup = taken.has(r.fg_id) && taken.has(r.fg_id) !== false;
        const alreadyOn = taken.has(r.fg_id);
        return `
          <div class="dsp-fg-row" ${alreadyOn ? '' : `onclick="_dspPickFg(${r.fg_id}, ${JSON.stringify(r.fg_code).replace(/"/g,'&quot;')}, ${JSON.stringify(r.fg_name).replace(/"/g,'&quot;')}, ${r.bom_id}, ${r.bom_version})"`}
               style="padding:10px 14px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));cursor:${alreadyOn ? 'not-allowed' : 'pointer'};opacity:${alreadyOn ? '.45' : '1'}"
               onmouseover="if(!${alreadyOn}) this.style.background='rgba(139,92,246,.08)'"
               onmouseout="this.style.background=''">
            <div style="font-weight:600;color:var(--htxtb,#111);font-size:12.5px">${_dspEsc(r.fg_name)}</div>
            <div style="font-size:10.5px;color:var(--hmuted,#9ca3af);margin-top:2px;font-family:monospace">
              ${_dspEsc(r.fg_code)} ${r.brand_name ? ' · ' + _dspEsc(r.brand_name) : ''} · BOM v${r.bom_version}
              ${alreadyOn ? ' <span style="color:#dc2626;font-family:inherit">· already on voucher</span>' : ''}
            </div>
          </div>
        `;
      }).join('');
    } catch (e){
      list.innerHTML = `<div style="padding:16px;color:#dc2626">${_dspEsc('Network error: ' + e.message)}</div>`;
    }
  }

  window._dspPickFg = async function(fg_id, fg_code, fg_name, bom_id, bom_version){
    if (_dspPickerLineIdx < 0) return;
    const L = _dspState.lines[_dspPickerLineIdx];
    L.fg_id = fg_id;
    L.fg_code = fg_code;
    L.fg_name = fg_name;
    L.bom_id = bom_id;
    L.bom_version = bom_version;
    L._dirty = true;
    if (L.fg_qty > 0){
      await _dspRecomputeBom(_dspPickerLineIdx);
    }
    _dspCloseFgPicker();
    _dspRender();
  };

  /* ── Save / Submit ────────────────────────────────────────────── */
  // Persist the entire state to the server. Creates voucher row if
  // missing, upserts lines, deletes server-only lines that are no
  // longer in state.
  async function _dspPersist(){
    const s = _dspState;
    if (!s) return false;

    // Header values (read from DOM in case user just typed)
    s.voucher_date = document.getElementById('dsp-voucher-date').value || s.voucher_date;
    s.location_id  = parseInt(document.getElementById('dsp-location').value) || s.location_id;
    s.remarks      = document.getElementById('dsp-remarks').value || '';

    // Validate all lines have FG + qty + at least one component
    for (let i = 0; i < s.lines.length; i++){
      const L = s.lines[i];
      if (!L.fg_id){
        _dspToast(`Line ${i+1}: pick an FG product`, 'error');
        return false;
      }
      if (!L.fg_qty || L.fg_qty <= 0){
        _dspToast(`Line ${i+1}: FG qty must be > 0`, 'error');
        return false;
      }
      if (!L.components || L.components.length === 0){
        _dspToast(`Line ${i+1}: no components`, 'error');
        return false;
      }
      const totalQty = L.components.reduce((sum, c) => sum + (c.qty || 0), 0);
      if (totalQty <= 0){
        _dspToast(`Line ${i+1}: total component qty must be > 0`, 'error');
        return false;
      }
    }

    // Step 1: ensure voucher exists
    if (!s.voucher_id){
      try {
        const r = await fetch('/api/pm_stock/dispatch/create', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            voucher_date: s.voucher_date,
            location_id:  s.location_id,
            remarks:      s.remarks,
          }),
        });
        const d = await r.json();
        if (d.status !== 'ok'){
          _dspToast(d.message || 'Could not create voucher', 'error');
          return false;
        }
        s.voucher_id = d.voucher_id;
      } catch (e){
        _dspToast('Network error: ' + e.message, 'error');
        return false;
      }
    }

    // Step 2: upsert each line (only dirty ones, OR every line that has no line_id yet)
    for (let i = 0; i < s.lines.length; i++){
      const L = s.lines[i];
      if (!L._dirty && L.line_id) continue;

      const body = {
        fg_qty: L.fg_qty,
        components: L.components.filter(c => (c.qty || 0) > 0).map(c => ({
          product_id: c.product_id,
          qty: c.qty,
          note: c.note || '',
        })),
        admin_password: s.admin_password || '',
      };

      try {
        const url = L.line_id
          ? `/api/pm_stock/dispatch/${s.voucher_id}/lines/${L.line_id}/update`
          : `/api/pm_stock/dispatch/${s.voucher_id}/lines/add`;
        if (!L.line_id) body.fg_id = L.fg_id;

        const r = await fetch(url, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.status !== 'ok'){
          if (d.shortfalls){
            _dspShowShortfalls(d.shortfalls);
            return false;
          }
          _dspToast(`Line ${i+1}: ${d.message || 'Save failed'}`, 'error');
          return false;
        }
        if (d.line_id) L.line_id = d.line_id;
        L._dirty = false;
      } catch (e){
        _dspToast(`Line ${i+1}: ${e.message}`, 'error');
        return false;
      }
    }

    return true;
  }

  window._dspSaveDraft = async function(){
    const btn = document.getElementById('dsp-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const ok = await _dspPersist();
    btn.disabled = false; btn.textContent = '💾 Save Draft';
    if (!ok) return;
    _dspToast('Draft saved.', 'success');
    // Reload to refresh state (line_ids, etc.)
    if (_dspState.voucher_id) await _dspLoad(_dspState.voucher_id);
  };

  window._dspSubmit = async function(){
    if (!confirm(
      'Submit this voucher? Stock will be deducted from the chosen location.\n\n' +
      'Voucher will be editable for 24 hours after submit. After that, ' +
      'admin password is required to edit.'
    )) return;

    const btn = document.getElementById('dsp-submit-btn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      // First persist everything
      const persisted = await _dspPersist();
      if (!persisted){
        btn.disabled = false; btn.textContent = '✅ Submit';
        return;
      }
      // Now submit
      const r = await fetch(`/api/pm_stock/dispatch/${_dspState.voucher_id}/submit`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
      });
      const d = await r.json();
      btn.disabled = false; btn.textContent = '✅ Submit';
      if (d.status !== 'ok'){
        if (d.shortfalls){
          _dspShowShortfalls(d.shortfalls);
          return;
        }
        _dspToast(d.message || 'Submit failed', 'error');
        return;
      }
      _dspToast(`Submitted as ${d.voucher_no}.`, 'success', 5000);
      await _dspLoad(_dspState.voucher_id);
    } catch (e){
      btn.disabled = false; btn.textContent = '✅ Submit';
      _dspToast('Network error: ' + e.message, 'error');
    }
  };

  function _dspShowShortfalls(shortfalls){
    const lines = shortfalls.map(s =>
      `• ${s.product_name} — need ${_fmt(s.need)}, have ${_fmt(s.have)}, short ${_fmt(s.short)}`
    ).join('\n');
    alert('Stock shortfall — cannot submit:\n\n' + lines);
  }

  window._dspCancel = async function(){
    if (!confirm('Cancel this voucher? Stock will be returned to the source location. This requires admin permission.')) return;
    let admin_password = '';
    // Non-admin path: ask for password inline
    if (!window.__pmIsAdmin || !window.__pmIsAdmin()){
      admin_password = prompt('Admin password to cancel this voucher:') || '';
      if (!admin_password) return;
    }
    try {
      const r = await fetch(`/api/pm_stock/dispatch/${_dspState.voucher_id}/cancel`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ admin_password }),
      });
      const d = await r.json();
      if (d.status !== 'ok'){
        _dspToast(d.message || 'Cancel failed', 'error');
        return;
      }
      _dspToast('Voucher cancelled.', 'success');
      await _dspLoad(_dspState.voucher_id);
    } catch (e){
      _dspToast('Network error: ' + e.message, 'error');
    }
  };

  window._dspUnlock = function(){
    const pwd = prompt('Admin password:');
    if (!pwd) return;
    _dspState.admin_password = pwd;
    _dspToast('Admin password staged — try the edit again.', 'info', 3000);
    _dspState.editable = true;
    _dspState.edit_block_reason = '';
    _dspRender();
  };

  /* ── Print ────────────────────────────────────────────────────── */
  window._dspPrint = function(){
    if (!_dspState || !_dspState.voucher_id){
      _dspToast('Save the voucher first', 'error');
      return;
    }
    // Render a printable HTML view in a new window
    const s = _dspState;
    const win = window.open('', '_blank', 'width=800,height=900');
    if (!win){
      _dspToast('Popup blocked — allow popups for this site', 'error');
      return;
    }
    win.document.write(_dspBuildPrintHtml(s));
    win.document.close();
    setTimeout(() => { try { win.print(); } catch(e){} }, 400);
  };

  function _dspBuildPrintHtml(s){
    const locName = (s.location_id === FACTORY_LOC) ? 'FACTORY' : 'Floor';
    const totalsByProduct = {};
    s.lines.forEach(L => {
      L.components.forEach(c => {
        const k = c.product_id;
        if (!totalsByProduct[k]){
          totalsByProduct[k] = { product_name: c.product_name, product_code: c.product_code, pm_type: c.pm_type, qty: 0 };
        }
        totalsByProduct[k].qty += parseFloat(c.qty) || 0;
      });
    });
    const totals = Object.values(totalsByProduct).sort((a,b) => a.product_name.localeCompare(b.product_name));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Dispatch ${_dspEsc(s.voucher_no || 'Draft')}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; color:#222; }
  h1 { font-size: 22px; margin: 0 0 4px 0; }
  .meta { display:grid; grid-template-columns: 1fr 1fr; gap:8px 24px; margin: 16px 0 24px; font-size: 13px; }
  .meta b { color:#555; font-weight:600; }
  table { width:100%; border-collapse: collapse; margin: 8px 0 18px; font-size: 12.5px; }
  th, td { padding: 7px 10px; border: 1px solid #ddd; text-align:left; }
  th { background:#f5f5f7; font-weight:700; font-size:11.5px; }
  td.num { text-align:right; font-family: monospace; }
  h2 { font-size:14px; color:#444; margin-top: 24px; }
  .foot { margin-top: 36px; font-size: 11px; color:#666; border-top:1px solid #ddd; padding-top: 10px; }
</style></head><body>
<h1>Dispatch Voucher</h1>
<div style="font-size:14px;font-family:monospace;color:#7c3aed;font-weight:700">${_dspEsc(s.voucher_no || '(Draft)')}</div>
<div class="meta">
  <div><b>Date:</b> ${_dspEsc(s.voucher_date || '')}</div>
  <div><b>Location:</b> ${locName}</div>
  <div><b>State:</b> ${_dspEsc(s.state || '')}</div>
  <div><b>Submitted:</b> ${_dspEsc((s._meta && s._meta.submitted_at || '').replace('T',' '))}</div>
  <div><b>Created by:</b> ${_dspEsc((s._meta && s._meta.created_by) || '')}</div>
  <div><b>Submitted by:</b> ${_dspEsc((s._meta && s._meta.submitted_by) || '')}</div>
  ${s.remarks ? `<div style="grid-column:1/-1"><b>Remarks:</b> ${_dspEsc(s.remarks)}</div>` : ''}
</div>

<h2>Finished Goods Lines</h2>
<table>
  <thead><tr><th>#</th><th>FG Code</th><th>FG Name</th><th style="text-align:right">FG Qty</th><th style="text-align:right">Components</th></tr></thead>
  <tbody>
    ${s.lines.map((L,i) => `
      <tr>
        <td>${i+1}</td>
        <td style="font-family:monospace">${_dspEsc(L.fg_code)}</td>
        <td>${_dspEsc(L.fg_name)}</td>
        <td class="num">${_fmt(L.fg_qty)}</td>
        <td class="num">${L.components.length}</td>
      </tr>
    `).join('')}
  </tbody>
</table>

<h2>Components Consumed (aggregated)</h2>
<table>
  <thead><tr><th>#</th><th>Component</th><th>Code</th><th>PM Type</th><th style="text-align:right">Total Qty</th></tr></thead>
  <tbody>
    ${totals.map((t,i) => `
      <tr>
        <td>${i+1}</td>
        <td>${_dspEsc(t.product_name)}</td>
        <td style="font-family:monospace">${_dspEsc(t.product_code)}</td>
        <td>${_dspEsc(t.pm_type)}</td>
        <td class="num">${_fmt(t.qty)}</td>
      </tr>
    `).join('')}
  </tbody>
</table>

<div class="foot">Generated by PM Stock Management · ${new Date().toLocaleString('en-IN')}</div>
</body></html>`;
  }

})();
