/* ═══════════════════════════════════════════════════════════════════
   BOM Manager — Bill of Materials feature
   ──────────────────────────────────────────────────────────────────
   Opens from the "BOM Manager" KPI card in the Add New launcher,
   AND from the "From BOM" button on the Material Request modal.

   Two views inside one modal:
     • List view  — table of all BOMs, with Edit/Delete/History.
     • Form view  — FG header fields + items table with product picker.

   State (module-scope):
     _bomRows        — last fetched BOM list
     _bomEditState   — { bom_id, fg, items[], notes, version } when
                       editing. null when not in form view.
     _bomLastFocused — element to restore focus to on close.
   ═══════════════════════════════════════════════════════════════════ */

let _bomRows = [];
let _bomEditState = null;
let _bomSearch = '';

/* ── Tiny utilities ────────────────────────────────────────────── */
function _bomEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _bomFmtN(n){
  if(n == null || n === '') return '—';
  const v = Number(n);
  if(!isFinite(v)) return String(n);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
function _bomFmtDate(s){
  if(!s) return '';
  const ten = String(s).slice(0,10).split('-');
  return ten.length === 3 ? `${ten[2]}/${ten[1]}/${ten[0]}` : String(s);
}

/* ══════════════════════════════════════════════════════════════════
   FG CODE AUTO-GENERATION
   ──────────────────────────────────────────────────────────────────
   Derives a 10-character FG code from the FG name. Examples:
     "Beardo De Tan Body Wash 200ml"       → "BEDETBW200"
     "Plix Apple Cider Vinegar 30 Tablets" → "PLAPCIV30T"
     "Sunscreen SPF 50"                    → "SUNSCSPF50"
     "Mooleen Lip Balm 5gm Cap"            → "MOOLIBA5CA"

   Algorithm:
     1. Tokenise on whitespace. Each token is classified ONCE:
          - numeric: starts with a digit (e.g. "200ml" → "200",
            trailing units dropped so they don't pollute the code).
          - alpha:   has letters and no leading digit. Embedded digits
            in alpha tokens are dropped.
     2. Numeric tokens consume their digit-prefix chars verbatim.
     3. Letter tokens share the remaining budget (10 - digit chars):
          - Pass 1: 1 char per letter token in document order (first
            letter of each word) — so every word is represented.
          - Pass 2+: round-robin one more char per pass, preferring
            leftmost tokens, until budget exhausted.
     4. Reassemble in original token order; uppercase.
     5. Pad with 'X' if the result is shorter than targetLen
        (very short FG names). Truncate if longer (digit-heavy edge).
   ══════════════════════════════════════════════════════════════════ */
function _bomGenFgCode(name, targetLen = 10){
  const raw = String(name || '').trim();
  if(!raw) return '';

  // Tokenise. Each token is classified as ONE of:
  //   - numeric: starts with digits (e.g. "200ml" → "200", trailing
  //              units dropped to keep the code clean)
  //   - alpha:   contains letters (no leading digits)
  // Pure-symbol tokens like "-" or "/" are skipped.
  const tokens = raw.split(/\s+/).map(tok => {
    const numMatch = tok.match(/^(\d+)/);
    if(numMatch){
      return { raw: tok, alpha: '', numeric: numMatch[1] };
    }
    const alpha = (tok.match(/[A-Za-z]+/g) || []).join('');
    return { raw: tok, alpha, numeric: '' };
  }).filter(t => t.alpha || t.numeric);

  if(!tokens.length) return '';

  // Total digit characters consumed verbatim
  let digitChars = 0;
  for(const t of tokens) digitChars += (t.numeric || '').length;

  // Budget left for letter contributions
  let budget = Math.max(0, targetLen - digitChars);

  // Identify letter tokens (those with alpha content)
  const letterIdxs = [];
  for(let i = 0; i < tokens.length; i++){
    if(tokens[i].alpha) letterIdxs.push(i);
  }

  const alloc = new Array(tokens.length).fill(0);

  // Pass 1: give EACH letter word 1 char (first letter) so every word
  // is represented in the code. This is the key property: "BEDETBW200"
  // has B/D/T/B/W as the first letter of each of the 5 letter words.
  for(const idx of letterIdxs){
    if(budget <= 0) break;
    if(tokens[idx].alpha.length >= 1){
      alloc[idx] = 1;
      budget--;
    }
  }
  // Pass 2+: round-robin from the start, adding 1 more char each pass
  // (preferring leftmost words) until budget is exhausted. For the
  // user's example, this gives Beardo+De 2 chars each (BE/DE) while
  // Tan/Body/Wash stay at 1 char (T/B/W).
  while(budget > 0){
    let progress = false;
    for(const idx of letterIdxs){
      if(budget <= 0) break;
      if(alloc[idx] < tokens[idx].alpha.length){
        alloc[idx]++;
        budget--;
        progress = true;
      }
    }
    if(!progress) break;  // no token can accept more letters
  }

  // Build the code in original token order
  let out = '';
  for(let i = 0; i < tokens.length; i++){
    const t = tokens[i];
    if(t.alpha)   out += t.alpha.slice(0, alloc[i]);
    if(t.numeric) out += t.numeric;
  }
  out = out.toUpperCase();

  // Pad if short (rare: very short FG names without numerics)
  if(out.length < targetLen){
    let pad = '';
    if(letterIdxs.length){
      const last = tokens[letterIdxs[letterIdxs.length - 1]].alpha.toUpperCase();
      pad = last.slice(alloc[letterIdxs[letterIdxs.length - 1]]);
    }
    while(out.length + pad.length < targetLen) pad += 'X';
    out = (out + pad).slice(0, targetLen);
  }
  // Truncate if too long (digit-heavy edge case)
  if(out.length > targetLen) out = out.slice(0, targetLen);

  return out;
}
window._bomGenFgCode = _bomGenFgCode;

/* ── FG Name input handler — auto-fill the FG Code field ──────── */
function _bomOnFgNameInput(value){
  if(_bomEditState){
    _bomEditState.dirty = true;
  }
  // Don't overwrite a manually-edited code, or a code that's been
  // saved (i.e. when editing an existing BOM — code is read-only there
  // anyway, but defensive).
  if(_bomEditState?.codeManual) return;
  if(_bomEditState?.bom_id) return;   // editing existing — never auto-rewrite
  const codeEl = document.getElementById('bom-f-code');
  if(!codeEl) return;
  const generated = _bomGenFgCode(value);
  codeEl.value = generated;
}
window._bomOnFgNameInput = _bomOnFgNameInput;

/* ── FG Code input handler — flips codeManual flag ───────────── */
function _bomOnFgCodeInput(value){
  if(!_bomEditState) return;
  _bomEditState.dirty = true;
  // Empty code → user wants auto-mode back. Re-derive from current
  // FG Name immediately so the field doesn't sit empty.
  if(!value.trim()){
    _bomEditState.codeManual = false;
    if(!_bomEditState.bom_id){
      const nameEl = document.getElementById('bom-f-name');
      const codeEl = document.getElementById('bom-f-code');
      if(nameEl && codeEl){
        codeEl.value = _bomGenFgCode(nameEl.value);
      }
    }
  } else {
    _bomEditState.codeManual = true;
  }
}
window._bomOnFgCodeInput = _bomOnFgCodeInput;

/* ── Toast shim — fall back to alert if showToast isn't loaded ── */
function _bomToast(msg, type='info', dur=3000){
  if(typeof window.showToast === 'function'){ window.showToast(msg, type, dur); return; }
  if(typeof window.toast === 'function'){ window.toast(msg, type, dur); return; }
  if(type === 'error') console.error(msg); else console.log(msg);
}

/* ── Modal open / close ────────────────────────────────────────── */
async function openBomManagerModal(){
  // Defer module-level state init so we don't fetch on page boot.
  _bomEditState = null;
  _bomSearch    = '';
  const m = document.getElementById('bomManagerModal');
  if(!m){
    _bomToast('BOM Manager modal not in DOM','error');
    return;
  }
  m.classList.add('open');
  await _bomRefreshList();
}
window.openBomManagerModal = openBomManagerModal;

function closeBomManagerModal(){
  // If editing, ask for confirmation before discarding changes.
  if(_bomEditState && _bomEditState.dirty){
    if(!confirm('Discard your unsaved BOM changes?')) return;
  }
  const m = document.getElementById('bomManagerModal');
  if(m) m.classList.remove('open');
}
window.closeBomManagerModal = closeBomManagerModal;

/* ── Fetch BOM list ────────────────────────────────────────────── */
async function _bomRefreshList(){
  try{
    const res = await fetch('/api/pm_stock/bom/list');
    const d   = await res.json();
    if(d.status !== 'ok'){
      _bomToast(d.message || 'Failed to load BOM list', 'error');
      return;
    }
    _bomRows = d.boms || [];
    _bomRenderList();
  }catch(e){
    _bomToast('Network error: ' + e.message, 'error');
  }
}

/* ── Render list view ──────────────────────────────────────────── */
function _bomRenderList(){
  // Show list pane, hide form pane
  const listPane = document.getElementById('bom-list-pane');
  const formPane = document.getElementById('bom-form-pane');
  if(listPane) listPane.style.display = '';
  if(formPane) formPane.style.display = 'none';

  // Filter by search query (matches fg_name, fg_code, brand, client)
  const q = (_bomSearch || '').toLowerCase().trim();
  let rows = _bomRows;
  if(q){
    rows = rows.filter(r =>
      (r.fg_name     || '').toLowerCase().includes(q) ||
      (r.fg_code     || '').toLowerCase().includes(q) ||
      (r.brand_name  || '').toLowerCase().includes(q) ||
      (r.client_name || '').toLowerCase().includes(q)
    );
  }
  // Also hide inactive BOMs unless an explicit "show inactive" toggle is on.
  const showInactive = document.getElementById('bom-show-inactive')?.checked;
  if(!showInactive) rows = rows.filter(r => r.is_active);

  const tbody = document.getElementById('bom-list-tbody');
  if(!tbody) return;
  const info  = document.getElementById('bom-list-info');
  if(info) info.textContent = `${rows.length} BOM${rows.length === 1 ? '' : 's'}`;

  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <div style="font-size:24px;margin-bottom:8px">📋</div>
      ${q ? `No BOMs matching "${_bomEsc(q)}"` : 'No BOMs created yet'} — click "<b>+ New BOM</b>" to add the first one.
    </td></tr>`;
    return;
  }

  // Default access flags — only admins or bom_manage users see edit/delete.
  // The Jinja-rendered window._userAccess (set by the page boot) carries
  // these flags. _isAdmin too.
  const canEdit = (window._isAdmin === true) || ((window._userAccess || {}).bom_manage === true);

  tbody.innerHTML = rows.map((r, i) => {
    const updatedAt = r.updated_at ? r.updated_at.split(' ')[0].split('-').reverse().join('/') : '';
    return `
      <tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">
        <td style="padding:9px 12px;color:var(--hmuted2,#6b7280);font-size:11px">${i+1}</td>
        <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:#8b5cf6;font-size:11px">${_bomEsc(r.fg_code)}</td>
        <td style="padding:9px 12px;color:var(--htxtb,#111);font-weight:600">${_bomEsc(r.fg_name)}</td>
        <td style="padding:9px 12px;color:var(--hmuted2,#6b7280);font-size:11px">${_bomEsc(r.brand_name) || '—'}</td>
        <td style="padding:9px 12px;text-align:right;color:var(--htxtb,#111);font-weight:600">${r.item_count}</td>
        <td style="padding:9px 12px;text-align:center;color:var(--hmuted2,#6b7280);font-size:11px">
          <span style="padding:2px 7px;border-radius:999px;background:rgba(139,92,246,.12);color:#8b5cf6;font-weight:700;font-size:10.5px">v${r.version}</span>
          <div style="margin-top:2px;font-size:10px;color:var(--hmuted,#9ca3af)">${_bomEsc(updatedAt)}</div>
        </td>
        <td style="padding:9px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10.5px" onclick="_bomOpenEdit(${r.bom_id})" title="${canEdit ? 'Edit BOM' : 'View BOM'}">
            <i class="fas fa-${canEdit ? 'pen' : 'eye'}"></i> ${canEdit ? 'Edit' : 'View'}
          </button>
          ${canEdit ? `
            <button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10.5px;color:var(--hmuted2,#6b7280)" onclick="_bomOpenHistory(${r.bom_id})" title="View version history">
              <i class="fas fa-clock-rotate-left"></i>
            </button>
            ${(window._isAdmin === true) ? `
              <button class="btn btn-sm" style="padding:3px 8px;font-size:10.5px;background:var(--hsurf2,#f8fafc);color:#dc2626;border:1px solid rgba(239,68,68,.3)" onclick="_bomDelete(${r.bom_id})" title="Delete BOM">
                <i class="fas fa-trash"></i>
              </button>
            ` : ''}
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

/* ── Open EDIT form for an existing BOM ────────────────────────── */
async function _bomOpenEdit(bom_id){
  try{
    const res = await fetch('/api/pm_stock/bom/' + bom_id);
    const d   = await res.json();
    if(d.status !== 'ok'){
      _bomToast(d.message || 'Failed to load BOM','error');
      return;
    }
    const b = d.bom;
    _bomEditState = {
      bom_id:      b.bom_id,
      fg_id:       b.fg_id,
      version:     b.version,
      fg_code:     b.fg_code,
      fg_name:     b.fg_name,
      brand_name:  b.brand_name || '',
      client_name: b.client_name || '',     // kept on state for backward compat with old DB rows; not displayed
      description: b.fg_description || '',
      notes:       b.notes || '',
      items:       (b.items || []).map(it => ({
        product_id:   it.product_id,
        product_name: it.product_name,
        product_code: it.product_code,
        pm_type:      it.pm_type,
        qty_per_unit: it.qty_per_unit,
        note:         it.note || '',
      })),
      // Existing BOM — treat as manually-set code (skip auto-rewrite).
      // The FG Code input is also read-only in edit mode (see
      // _bomRenderForm), so this is belt-and-suspenders.
      codeManual:  true,
      dirty: false,
    };
    _bomRenderForm();
  }catch(e){
    _bomToast('Network error: ' + e.message, 'error');
  }
}
window._bomOpenEdit = _bomOpenEdit;

/* ── Open CREATE form ──────────────────────────────────────────── */
function _bomOpenNew(){
  _bomEditState = {
    bom_id:      null,
    fg_id:       null,
    version:     0,
    fg_code:     '',
    fg_name:     '',
    brand_name:  '',
    description: '',
    notes:       '',
    items:       [],
    // codeManual: tracks whether the user has typed into FG Code.
    // While false, the field auto-fills from FG Name. Flips to true
    // the moment user types in the code field directly. Reset on
    // fresh form open.
    codeManual:  false,
    dirty: false,
  };
  _bomRenderForm();
}
window._bomOpenNew = _bomOpenNew;

/* ── Render edit/create form ───────────────────────────────────── */
function _bomRenderForm(){
  const listPane = document.getElementById('bom-list-pane');
  const formPane = document.getElementById('bom-form-pane');
  if(listPane) listPane.style.display = 'none';
  if(formPane) formPane.style.display = '';

  const s = _bomEditState;
  const isCreate = !s.bom_id;
  const heading  = isCreate ? '+ New BOM' : `Edit BOM · ${_bomEsc(s.fg_name)}`;
  const sub      = isCreate
    ? 'Create a new Finished Goods product and define its component recipe.'
    : `Version <b style="color:#8b5cf6">v${s.version}</b> — saving will create v${s.version + 1}.`;

  document.getElementById('bom-form-title').innerHTML = heading;
  document.getElementById('bom-form-sub').innerHTML   = sub;

  // FG header fields
  document.getElementById('bom-f-code').value   = s.fg_code;
  document.getElementById('bom-f-name').value   = s.fg_name;
  // Brand is now a typeahead combo (input lives inside a wrap). The
  // input element has class .bom-brand-input — we set its value
  // verbatim. _initBomBrandCombo handles the dropdown wiring.
  const brandInput = document.querySelector('#bom-brand-combo-wrap .bom-brand-input');
  if(brandInput){
    brandInput.value = s.brand_name || '';
    brandInput.style.borderColor = '';
  }
  document.getElementById('bom-f-desc').value   = s.description;
  document.getElementById('bom-f-notes').value  = s.notes;

  // Clear the component picker too — stale values from a previous edit
  // session would otherwise leak in.
  const prodInput = document.querySelector('#bom-prod-combo-wrap .bom-prod-input');
  const prodHid   = document.querySelector('#bom-prod-combo-wrap .bom-prod-id');
  if(prodInput){ prodInput.value = ''; prodInput.style.borderColor = ''; }
  if(prodHid)  { prodHid.value = ''; }
  const qtyEl = document.getElementById('bom-add-qty');
  if(qtyEl) qtyEl.value = '1';

  // Wire combos if not already wired (idempotent on re-open).
  if(typeof _initBomProdCombo === 'function')  _initBomProdCombo();
  if(typeof _initBomBrandCombo === 'function') _initBomBrandCombo();

  // Editing an existing FG code? Lock it to prevent accidental collisions
  // — admins can still unlock with a click.
  const codeInput = document.getElementById('bom-f-code');
  if(!isCreate){
    codeInput.readOnly = true;
    codeInput.style.background = 'var(--hsurf2,#f8fafc)';
    codeInput.title = 'FG code is locked for existing BOMs. Click "Unlock" to edit.';
  } else {
    codeInput.readOnly = false;
    codeInput.style.background = '';
    codeInput.title = '';
  }

  _bomRenderItems();
}

/* ── Render items table inside the form ───────────────────────── */
function _bomRenderItems(){
  const tbody = document.getElementById('bom-items-tbody');
  if(!tbody) return;
  const items = _bomEditState.items;
  if(!items.length){
    tbody.innerHTML = `<tr><td colspan="5" style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <i class="fas fa-arrow-down" style="font-size:18px;display:block;margin-bottom:6px;opacity:.5"></i>
      Search a product below to add as a component.
    </td></tr>`;
    return;
  }
  tbody.innerHTML = items.map((it, i) => `
    <tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">
      <td style="padding:7px 10px;font-size:11px;color:var(--hmuted2,#6b7280);text-align:center">${i+1}</td>
      <td style="padding:7px 10px;color:var(--htxtb,#111)">
        <div style="font-weight:600;font-size:12px">${_bomEsc(it.product_name)}</div>
        <div style="font-size:10px;color:var(--hmuted,#9ca3af)">
          <span style="font-family:monospace;color:#7c3aed">${_bomEsc(it.product_code || '—')}</span>
          ${it.pm_type ? ` · ${_bomEsc(it.pm_type)}` : ''}
        </div>
      </td>
      <td style="padding:7px 10px;text-align:right">
        <input type="number" min="0" step="0.001" value="${it.qty_per_unit}"
          onchange="_bomSetItemQty(${i}, this.value)"
          style="width:100px;padding:4px 8px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:6px;font-family:monospace;text-align:right;font-size:12px;background:var(--hinput,#fff);color:var(--htxtb,#111)">
      </td>
      <td style="padding:7px 10px">
        <input type="text" value="${_bomEsc(it.note)}" placeholder="Optional note"
          onchange="_bomSetItemNote(${i}, this.value)"
          style="width:100%;padding:4px 8px;border:1px solid var(--hbdr2,rgba(0,0,0,.13));border-radius:6px;font-size:11px;background:var(--hinput,#fff);color:var(--htxtb,#111)">
      </td>
      <td style="padding:7px 10px;text-align:center">
        <button onclick="_bomRemoveItem(${i})" title="Remove from BOM"
          style="background:transparent;border:none;color:#dc2626;cursor:pointer;padding:4px;border-radius:4px;font-size:13px">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function _bomSetItemQty(idx, val){
  const q = parseFloat(val) || 0;
  _bomEditState.items[idx].qty_per_unit = q;
  _bomEditState.dirty = true;
}
window._bomSetItemQty = _bomSetItemQty;

function _bomSetItemNote(idx, val){
  _bomEditState.items[idx].note = (val || '').trim();
  _bomEditState.dirty = true;
}
window._bomSetItemNote = _bomSetItemNote;

function _bomRemoveItem(idx){
  _bomEditState.items.splice(idx, 1);
  _bomEditState.dirty = true;
  _bomRenderItems();
}
window._bomRemoveItem = _bomRemoveItem;

/* ══════════════════════════════════════════════════════════════════
   TYPEAHEAD COMBOBOXES — single-input pickers used by the BOM form
   ──────────────────────────────────────────────────────────────────
   Pattern: one text input + a floating dropdown div underneath.
   Typing filters; ArrowUp/Down highlights; Enter picks. On pick, the
   resolved id/object is stashed on a hidden field (or as a state
   dataset) so the caller can read it without a second lookup.

   Two combos: products and brands. They share most of the wiring
   (open/render/keys/blur) but differ in what's matched and what's
   stashed, so each gets its own init function for clarity.
   ══════════════════════════════════════════════════════════════════ */

/* ── Component product picker — single typeahead combo ────────── */
function _initBomProdCombo(){
  const wrap  = document.getElementById('bom-prod-combo-wrap');
  if(!wrap) return;
  const input = wrap.querySelector('.bom-prod-input');
  const dd    = wrap.querySelector('.bom-prod-dd');
  const hid   = wrap.querySelector('.bom-prod-id');     // hidden product_id
  if(!input || !dd || !hid) return;
  // Already wired? Avoid stacking listeners on modal re-open.
  if(wrap.dataset.wired === '1') return;
  wrap.dataset.wired = '1';

  let shown = [];
  let idx   = -1;
  const MAX = 60;

  function _matches(q){
    const all = (window._products || []);
    const used = new Set((_bomEditState?.items || []).map(it => it.product_id));
    const lq = (q || '').toLowerCase().trim();
    return all.filter(p => {
      if(used.has(p.id)) return false;
      if(!lq) return true;
      const hay = `[${p.pm_type||''}] ${p.product_name||''} ${p.product_code||''}`.toLowerCase();
      return hay.includes(lq);
    });
  }

  function _label(p){
    return `[${p.pm_type || ''}] ${p.product_name}${p.product_code ? ' · ' + p.product_code : ''}`;
  }

  function _render(q){
    idx = -1;
    const all = _matches(q);
    shown = all.slice(0, MAX);
    if(!(window._products || []).length){
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">Loading product catalogue…</div>`;
    } else if(!all.length){
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">${q ? `No products match "${_bomEsc(q)}"` : 'Type to search products…'}</div>`;
    } else {
      let html = shown.map((p, i) => `
        <div class="bom-prod-item" data-idx="${i}"
             style="padding:7px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <span style="color:var(--hmuted2,#6b7280);font-size:10px">[${_bomEsc(p.pm_type || '')}]</span>
          <span style="color:var(--htxtb,#111)">${_bomEsc(p.product_name)}</span>
          ${p.product_code ? `<span style="color:#7c3aed;font-family:monospace;font-size:10.5px;margin-left:4px">· ${_bomEsc(p.product_code)}</span>` : ''}
        </div>
      `).join('');
      if(all.length > MAX){
        html += `<div style="padding:6px 12px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-style:italic;text-align:center">+${all.length - MAX} more — keep typing</div>`;
      }
      dd.innerHTML = html;
    }
    dd.style.display = 'block';
  }

  function _setActive(i){
    const rows = dd.querySelectorAll('.bom-prod-item');
    rows.forEach(r => r.style.background = '');
    if(i >= 0 && i < rows.length){
      rows[i].style.background = 'rgba(139,92,246,.10)';
      rows[i].scrollIntoView({ block: 'nearest' });
    }
    idx = i;
  }

  function _pick(p){
    hid.value = p.id;
    input.value = _label(p);
    input.dataset.pmType = p.pm_type || '';
    input.dataset.code   = p.product_code || '';
    input.dataset.name   = p.product_name || '';
    input.style.borderColor = '#8b5cf6';
    dd.style.display = 'none';
    dd.innerHTML = '';
    idx = -1; shown = [];
    // Jump to qty field
    const qtyEl = document.getElementById('bom-add-qty');
    if(qtyEl) setTimeout(() => qtyEl.focus(), 0);
  }

  input.addEventListener('input', () => {
    hid.value = '';                     // typing again invalidates pick
    input.style.borderColor = '';
    _render(input.value.trim());
  });
  input.addEventListener('focus', () => _render(input.value.trim()));
  input.addEventListener('blur',  () => setTimeout(() => { dd.style.display = 'none'; }, 160));
  dd.addEventListener('mousedown', e => {
    if(e.target.closest('.bom-prod-item')) e.preventDefault();   // keep focus
  });
  dd.addEventListener('click', e => {
    const row = e.target.closest('.bom-prod-item');
    if(!row) return;
    const i = parseInt(row.dataset.idx, 10);
    if(!isNaN(i) && shown[i]) _pick(shown[i]);
  });
  input.addEventListener('keydown', e => {
    const rows = dd.querySelectorAll('.bom-prod-item');
    if(e.key === 'ArrowDown'){ e.preventDefault(); _setActive(Math.min(idx + 1, rows.length - 1)); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); _setActive(Math.max(idx - 1, 0)); }
    else if(e.key === 'Enter'){
      e.preventDefault();
      if(idx >= 0 && shown[idx]) _pick(shown[idx]);
    }
    else if(e.key === 'Escape'){ dd.style.display = 'none'; idx = -1; }
  });
}
window._initBomProdCombo = _initBomProdCombo;

/* ── Brand typeahead combo ────────────────────────────────────────
   Pulls from window._brands (populated by loadBrands() in
   pm_stock_state.js). Brand is stored as plain text on pm_fg_products
   for backward compat with existing rows, so we just stash the name
   onto the input itself — no hidden id needed. Free-text fallback is
   also accepted (user can type a brand name that isn't in the table
   yet and we save the typed value verbatim). */
function _initBomBrandCombo(){
  const wrap  = document.getElementById('bom-brand-combo-wrap');
  if(!wrap) return;
  const input = wrap.querySelector('.bom-brand-input');
  const dd    = wrap.querySelector('.bom-brand-dd');
  if(!input || !dd) return;
  if(wrap.dataset.wired === '1') return;
  wrap.dataset.wired = '1';

  let shown = [];
  let idx   = -1;
  const MAX = 50;

  function _matches(q){
    const all = (window._brands || []);
    const lq = (q || '').toLowerCase().trim();
    if(!lq) return all.slice();
    return all.filter(b => (b.name || '').toLowerCase().includes(lq));
  }

  function _render(q){
    idx = -1;
    const all = _matches(q);
    shown = all.slice(0, MAX);
    if(!(window._brands || []).length){
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">No brands loaded yet — you can still type a brand name.</div>`;
    } else if(!all.length){
      // No match — still show the free-text fallback hint so the user
      // knows their typed value will be accepted as-is.
      dd.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--hmuted,#9ca3af);font-style:italic">No brand matches "${_bomEsc(q)}". Press <b>Tab</b> to save as a free-typed brand, or pick a different value.</div>`;
    } else {
      dd.innerHTML = shown.map((b, i) => `
        <div class="bom-brand-item" data-idx="${i}"
             style="padding:7px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05));display:flex;align-items:center;gap:8px">
          ${b.color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${_bomEsc(b.color)};flex-shrink:0;border:1px solid rgba(0,0,0,.1)"></span>` : ''}
          <span style="color:var(--htxtb,#111)">${_bomEsc(b.name)}</span>
        </div>
      `).join('');
      if(all.length > MAX){
        dd.innerHTML += `<div style="padding:6px 12px;font-size:10.5px;color:var(--hmuted,#9ca3af);font-style:italic;text-align:center">+${all.length - MAX} more — keep typing</div>`;
      }
    }
    dd.style.display = 'block';
  }

  function _setActive(i){
    const rows = dd.querySelectorAll('.bom-brand-item');
    rows.forEach(r => r.style.background = '');
    if(i >= 0 && i < rows.length){
      rows[i].style.background = 'rgba(139,92,246,.10)';
      rows[i].scrollIntoView({ block: 'nearest' });
    }
    idx = i;
  }

  function _pick(b){
    input.value = b.name || '';
    if(_bomEditState) _bomEditState.dirty = true;
    input.style.borderColor = '#8b5cf6';
    dd.style.display = 'none';
    dd.innerHTML = '';
    idx = -1; shown = [];
  }

  input.addEventListener('input', () => {
    if(_bomEditState) _bomEditState.dirty = true;
    input.style.borderColor = '';
    _render(input.value.trim());
  });
  input.addEventListener('focus', () => _render(input.value.trim()));
  input.addEventListener('blur',  () => setTimeout(() => { dd.style.display = 'none'; }, 160));
  dd.addEventListener('mousedown', e => {
    if(e.target.closest('.bom-brand-item')) e.preventDefault();
  });
  dd.addEventListener('click', e => {
    const row = e.target.closest('.bom-brand-item');
    if(!row) return;
    const i = parseInt(row.dataset.idx, 10);
    if(!isNaN(i) && shown[i]) _pick(shown[i]);
  });
  input.addEventListener('keydown', e => {
    const rows = dd.querySelectorAll('.bom-brand-item');
    if(e.key === 'ArrowDown'){ e.preventDefault(); _setActive(Math.min(idx + 1, rows.length - 1)); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); _setActive(Math.max(idx - 1, 0)); }
    else if(e.key === 'Enter'){
      e.preventDefault();
      if(idx >= 0 && shown[idx]) _pick(shown[idx]);
      else { dd.style.display = 'none'; }    // free-text accepted as-is
    }
    else if(e.key === 'Escape'){ dd.style.display = 'none'; idx = -1; }
  });
}
window._initBomBrandCombo = _initBomBrandCombo;

/* ── Add a component via the typeahead combo ──────────────────── */
async function _bomAddItem(){
  const wrap   = document.getElementById('bom-prod-combo-wrap');
  const input  = wrap?.querySelector('.bom-prod-input');
  const hid    = wrap?.querySelector('.bom-prod-id');
  const qtyEl  = document.getElementById('bom-add-qty');
  const pid    = parseInt(hid?.value || '0', 10);
  const qty    = parseFloat(qtyEl?.value || '0');
  if(!pid){
    _bomToast('Pick a product first — type to search, then press Enter or click', 'error');
    input?.focus();
    return;
  }
  if(!(qty > 0)){
    _bomToast('Enter a positive qty per FG unit', 'error');
    qtyEl?.focus();
    return;
  }
  // Dedup
  if(_bomEditState.items.some(it => it.product_id === pid)){
    _bomToast('That product is already in this BOM — edit its qty instead', 'warn');
    return;
  }
  const prod = (window._products || []).find(p => p.id === pid);
  if(!prod){
    _bomToast('Product not found in catalogue cache — refresh the page', 'error');
    return;
  }
  _bomEditState.items.push({
    product_id:   pid,
    product_name: prod.product_name,
    product_code: prod.product_code || '',
    pm_type:      prod.pm_type      || '',
    qty_per_unit: qty,
    note:         '',
  });
  _bomEditState.dirty = true;
  // Reset picker fields
  if(input){
    input.value = '';
    input.style.borderColor = '';
    delete input.dataset.pmType;
    delete input.dataset.code;
    delete input.dataset.name;
  }
  if(hid) hid.value = '';
  if(qtyEl) qtyEl.value = '1';
  _bomRenderItems();
  // Refocus search input for rapid multi-add
  setTimeout(() => input?.focus(), 0);
}
window._bomAddItem = _bomAddItem;

/* ── Save (create or update) ───────────────────────────────────── */
async function _bomSubmit(){
  if(!_bomEditState) return;
  const s = _bomEditState;
  // Pull latest values from the FG header inputs in case the user
  // hasn't blurred out of them yet.
  s.fg_code     = document.getElementById('bom-f-code').value.trim();
  s.fg_name     = document.getElementById('bom-f-name').value.trim();
  // Brand: read from the typeahead combo's text input. Stored as plain
  // text on pm_fg_products; the value is whatever the user picked OR
  // typed (free-text fallback for new brands).
  const brandInput = document.querySelector('#bom-brand-combo-wrap .bom-brand-input');
  s.brand_name  = (brandInput?.value || '').trim();
  s.description = document.getElementById('bom-f-desc').value.trim();
  s.notes       = document.getElementById('bom-f-notes').value.trim();

  if(!s.fg_code){ _bomToast('FG code is required','error'); return; }
  if(!s.fg_name){ _bomToast('FG name is required','error'); return; }
  if(!s.items.length){ _bomToast('Add at least one component','error'); return; }

  const payload = {
    bom_id: s.bom_id || null,
    fg: {
      fg_id:       s.fg_id || null,
      fg_code:     s.fg_code,
      fg_name:     s.fg_name,
      brand_name:  s.brand_name,
      description: s.description,
    },
    items: s.items.map((it, i) => ({
      product_id:   it.product_id,
      qty_per_unit: it.qty_per_unit,
      sort_order:   i + 1,
      note:         it.note || '',
    })),
    notes: s.notes,
  };
  try{
    const btn = document.getElementById('bom-form-save-btn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }
    const res = await fetch('/api/pm_stock/bom/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const d = await res.json();
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save BOM'; }
    if(d.status !== 'ok'){
      _bomToast(d.message || 'Save failed','error', 5000);
      return;
    }
    _bomToast(d.action === 'created'
      ? `✓ Created BOM for ${s.fg_name}`
      : `✓ Updated BOM (v${d.new_version})`,
      'success', 2800);
    _bomEditState = null;
    await _bomRefreshList();
  }catch(e){
    _bomToast('Network error: ' + e.message, 'error');
    const btn = document.getElementById('bom-form-save-btn');
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save BOM'; }
  }
}
window._bomSubmit = _bomSubmit;

/* ── Cancel form → back to list ───────────────────────────────── */
function _bomCancelForm(){
  if(_bomEditState && _bomEditState.dirty){
    if(!confirm('Discard your unsaved BOM changes?')) return;
  }
  _bomEditState = null;
  _bomRenderList();
}
window._bomCancelForm = _bomCancelForm;

/* ── Delete ───────────────────────────────────────────────────── */
async function _bomDelete(bom_id){
  const b = _bomRows.find(r => r.bom_id === bom_id);
  if(!b) return;
  if(!confirm(`Delete BOM for "${b.fg_name}"?\n\nThis will:\n• Remove the BOM and all its recipe lines\n• Mark the FG product as inactive\n• Be blocked if any Material Request references this BOM\n\nContinue?`)) return;
  try{
    const res = await fetch('/api/pm_stock/bom/' + bom_id, { method: 'DELETE' });
    const d   = await res.json();
    if(d.status !== 'ok'){
      _bomToast(d.message || 'Delete failed','error', 5000);
      return;
    }
    _bomToast('✓ BOM deleted','success', 2500);
    await _bomRefreshList();
  }catch(e){
    _bomToast('Network error: ' + e.message, 'error');
  }
}
window._bomDelete = _bomDelete;

/* ── Version history viewer (read-only) ───────────────────────── */
async function _bomOpenHistory(bom_id){
  try{
    const res = await fetch('/api/pm_stock/bom/' + bom_id + '/history');
    const d   = await res.json();
    if(d.status !== 'ok'){
      _bomToast(d.message || 'Failed to load history','error');
      return;
    }
    const rows = d.history || [];
    if(!rows.length){
      _bomToast('No history yet','info');
      return;
    }
    // Lightweight HTML — render into the same modal as a list overlay.
    const body = document.getElementById('bom-history-body');
    if(!body){
      _bomToast('History viewer not in DOM','error');
      return;
    }
    body.innerHTML = rows.map(h => `
      <div style="padding:12px 14px;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.08))">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="font-weight:700;font-size:13px;color:var(--htxtb,#111)">
            Version ${h.version}
            <span style="font-weight:400;color:var(--hmuted2,#6b7280);font-size:11px;margin-left:8px">by ${_bomEsc(h.edited_by || '—')} on ${_bomEsc(h.edited_at || '—')}</span>
          </div>
        </div>
        ${h.edit_summary ? `<div style="font-size:11px;color:var(--hmuted2,#6b7280);margin-bottom:6px;font-style:italic">${_bomEsc(h.edit_summary)}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="background:var(--hsurf2,#fafbfc)">
              <th style="text-align:left;padding:5px 8px;color:var(--hmuted2,#6b7280);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">Product</th>
              <th style="text-align:right;padding:5px 8px;color:var(--hmuted2,#6b7280);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:700">Per Unit</th>
            </tr>
          </thead>
          <tbody>
            ${(h.items || []).map(it => `
              <tr>
                <td style="padding:4px 8px;border-top:1px solid var(--hbdr,rgba(0,0,0,.05))">
                  <span style="font-family:monospace;color:#7c3aed;font-size:10.5px">${_bomEsc(it.product_code || '—')}</span>
                  ${_bomEsc(it.product_name)}
                </td>
                <td style="padding:4px 8px;border-top:1px solid var(--hbdr,rgba(0,0,0,.05));text-align:right;font-family:monospace;font-weight:600">${_bomFmtN(it.qty_per_unit)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
    document.getElementById('bomHistoryModal').classList.add('open');
  }catch(e){
    _bomToast('Network error: ' + e.message, 'error');
  }
}
window._bomOpenHistory = _bomOpenHistory;

function _bomCloseHistory(){
  const m = document.getElementById('bomHistoryModal');
  if(m) m.classList.remove('open');
}
window._bomCloseHistory = _bomCloseHistory;
