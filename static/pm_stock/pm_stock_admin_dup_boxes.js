/**
 * pm_stock_admin_dup_boxes.js
 *
 * Admin diagnostic + cleanup for "duplicate boxes" — GRN lines where
 * pm_boxes has more rows than the line's no_of_box says it should.
 *
 * Symptom seen in production (PM-GRN/0343/26-27, Jun 2026): one
 * pm_grn_items row with no_of_box=164, but pm_boxes had 328 rows tied
 * to two orphan grn_item_ids. Likely cause: a double-save inserted two
 * item rows + two box batches; the seq-continuation logic appended the
 * second batch from seq 165, leaving the GRN with 328 boxes.
 *
 * This module:
 *   • lists every GRN line where the box count disagrees with no_of_box
 *     or where pm_boxes has multiple distinct grn_item_id values,
 *   • opens a per-line preview showing each batch with seq range, created_at,
 *     move-status, and first/last box codes,
 *   • lets the admin pick which batch(es) to delete (radio: keep / delete),
 *   • soft-deletes via /admin/duplicate_boxes/cleanup — recoverable from
 *     the Recycle Bin.
 *
 * Loaded only when role == 'admin' (gated in pm_stock.html). All UI is in
 * #duplicateBoxesModal and #dupBoxPreviewModal.
 */
(function() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  // _dup.rows           — last API result from /admin/duplicate_boxes
  // _dup.byKey          — index keyed by "grn_id:product_id" for O(1) lookup
  // _dup.previewKey     — which row the preview modal is showing
  // _dup.selection      — Set of grn_item_ids currently marked for deletion
  const _dup = { rows: [], byKey: {}, previewKey: null, selection: new Set() };

  // Small toast wrapper — fall back to alert if the global isn't loaded yet.
  function _t(msg, type, ms) {
    if (typeof showToast === 'function') showToast(msg, type || 'info', ms || 3000);
    else try { alert(msg); } catch(_){}
  }

  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _fmtDateTime(s) {
    if (!s) return '—';
    // Accept "YYYY-MM-DD HH:MM:SS" (server returns this for created_at) or ISO.
    const t = String(s).replace('T', ' ').slice(0, 19);
    return t;
  }

  function _fmtN(n) {
    return Number(n || 0).toLocaleString('en-IN');
  }

  // ── Open & load ────────────────────────────────────────────────────
  function openDuplicateBoxesModal() {
    const m = document.getElementById('duplicateBoxesModal');
    if (!m) { _t('Duplicate-boxes modal not found', 'error'); return; }
    m.classList.add('open');
    loadDuplicateBoxes();
  }

  async function loadDuplicateBoxes() {
    const body = document.getElementById('dup-boxes-body');
    if (!body) return;
    body.innerHTML = `<div style="padding:30px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
      <i class="fas fa-spinner fa-spin"></i> Scanning…
    </div>`;
    try {
      const r = await fetch('/api/pm_stock/admin/duplicate_boxes');
      const d = await r.json();
      if (d.status !== 'ok') {
        body.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;font-size:12px">
          ${_esc(d.message || 'Scan failed')}
        </div>`;
        return;
      }
      _dup.rows  = d.rows || [];
      _dup.byKey = {};
      _dup.rows.forEach(r => { _dup.byKey[r.grn_id + ':' + r.product_id] = r; });
      _renderDupList();
    } catch(e) {
      body.innerHTML = `<div style="padding:30px;text-align:center;color:#dc2626;font-size:12px">
        Network error: ${_esc(e.message)}
      </div>`;
    }
  }

  // ── List render ───────────────────────────────────────────────────
  function _renderDupList() {
    const body = document.getElementById('dup-boxes-body');
    if (!body) return;
    if (!_dup.rows.length) {
      body.innerHTML = `<div style="padding:40px;text-align:center;color:#16a34a;font-size:13px">
        ✓ No duplicate boxes found. All GRN lines have a matching pm_boxes count.
      </div>`;
      return;
    }
    // KPI strip — total affected lines + total extras
    let totalExtra = 0;
    _dup.rows.forEach(r => { totalExtra += Math.max(0, Number(r.extra) || 0); });
    const kpiBar = `<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <div style="background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);padding:8px 14px;border-radius:8px;min-width:140px">
        <div style="font-size:9.5px;color:#991b1b;font-weight:700;letter-spacing:.4px;text-transform:uppercase">Affected GRN lines</div>
        <div style="font-size:18px;font-weight:800;color:#dc2626;margin-top:2px">${_fmtN(_dup.rows.length)}</div>
      </div>
      <div style="background:rgba(217,119,6,.07);border:1px solid rgba(217,119,6,.25);padding:8px 14px;border-radius:8px;min-width:140px">
        <div style="font-size:9.5px;color:#92400e;font-weight:700;letter-spacing:.4px;text-transform:uppercase">Extra box rows</div>
        <div style="font-size:18px;font-weight:800;color:#d97706;margin-top:2px">${_fmtN(totalExtra)}</div>
      </div>
    </div>`;

    const tableHead = `
      <thead style="background:var(--hsurf2,#f8fafc);position:sticky;top:0;z-index:2">
        <tr>
          ${['GRN','Date','Product','Expected','Actual','Extra','Batches','Action']
            .map(h => `<th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:800;letter-spacing:.4px;color:#64748b;text-transform:uppercase;border-bottom:1px solid var(--hbdr,rgba(0,0,0,.1));white-space:nowrap">${h}</th>`)
            .join('')}
        </tr>
      </thead>`;

    const tableRows = _dup.rows.map(r => {
      const orphans = (r.batches || []).filter(b => b.is_orphan).length;
      const moved   = (r.batches || []).filter(b => b.any_moved).length;
      const badges = [];
      if (orphans) badges.push(`<span style="background:rgba(220,38,38,.12);color:#991b1b;font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;margin-left:4px">${orphans} orphan</span>`);
      if (moved)   badges.push(`<span style="background:rgba(217,119,6,.12);color:#92400e;font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;margin-left:4px">moves</span>`);
      // Disable Review if every batch has moved (nothing we can safely delete).
      const allMoved = (r.batches || []).length > 0 && (r.batches || []).every(b => b.any_moved);
      return `<tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.05))">
        <td style="padding:7px 10px;font-family:monospace;font-size:11px;white-space:nowrap;color:#0d9488;font-weight:700">${_esc(r.grn_no)}</td>
        <td style="padding:7px 10px;font-size:11.5px;white-space:nowrap">${_esc(r.grn_date || '—')}</td>
        <td style="padding:7px 10px;font-size:11.5px">
          <div style="font-weight:700;color:var(--htxtb,#111)">${_esc(r.product_name || '—')}</div>
          <div style="font-family:monospace;font-size:10px;color:var(--hmuted,#9ca3af)">${_esc(r.product_code || '')}</div>
        </td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums">${_fmtN(r.expected_no_of_box)}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700">${_fmtN(r.actual_box_count)}</td>
        <td style="padding:7px 10px;text-align:right;color:#dc2626;font-weight:800;font-variant-numeric:tabular-nums">+${_fmtN(r.extra)}</td>
        <td style="padding:7px 10px;font-size:11px">
          ${(r.batches || []).length}
          ${badges.join('')}
        </td>
        <td style="padding:6px 10px;text-align:center">
          ${allMoved
            ? `<span style="font-size:10.5px;color:var(--hmuted,#9ca3af);font-style:italic" title="All batches have movement history — manual investigation needed">locked</span>`
            : `<button class="btn btn-sm" onclick="previewDupCleanup(${r.grn_id},${r.product_id})" style="padding:3px 10px;font-size:11px;background:#0d9488;color:#fff;border:none;border-radius:5px">
                <i class="fas fa-search"></i> Review
              </button>`
          }
        </td>
      </tr>`;
    }).join('');

    body.innerHTML = kpiBar
      + `<div style="border:1px solid var(--hbdr,rgba(0,0,0,.08));border-radius:8px;overflow:hidden">
           <table style="width:100%;border-collapse:collapse">
             ${tableHead}
             <tbody>${tableRows}</tbody>
           </table>
         </div>
         <div style="margin-top:12px;font-size:11px;color:var(--hmuted,#9ca3af);line-height:1.5">
           <b>How to read this:</b> Expected = sum of <code>no_of_box</code> across this GRN's lines for the product.
           Actual = real row count in <code>pm_boxes</code>. "Orphan" batches reference a <code>grn_item_id</code>
           that no longer exists in <code>pm_grn_items</code> — these are leftovers from old saves.
           "Moves" means at least one box already has movement history — cleanup is locked for safety.
           All cleanups are soft-deleted: recoverable from the Recycle Bin.
         </div>`;
  }

  // ── Preview a single GRN's batches ────────────────────────────────
  function previewDupCleanup(grnId, productId) {
    const key = grnId + ':' + productId;
    const r = _dup.byKey[key];
    if (!r) { _t('Row not found — re-scan and try again', 'error'); return; }
    _dup.previewKey = key;
    _dup.selection  = new Set();

    document.getElementById('dup-preview-title').textContent =
      `🧹 ${r.grn_no} — ${r.product_name}`;
    document.getElementById('dup-preview-sub').innerHTML =
      `Expected <b>${_fmtN(r.expected_no_of_box)}</b> boxes, found <b style="color:#dc2626">${_fmtN(r.actual_box_count)}</b> (extra <b style="color:#dc2626">+${_fmtN(r.extra)}</b>). Mark batches to delete:`;

    // Heuristic suggestion: keep the FIRST batch (lowest min_seq) that has
    // no movements; mark all later non-moved batches for deletion. Operator
    // can override before applying.
    const candidates = (r.batches || []).filter(b => !b.any_moved);
    let firstKeepable = null;
    candidates.forEach(b => {
      if (firstKeepable === null || b.min_seq < firstKeepable.min_seq) firstKeepable = b;
    });
    candidates.forEach(b => {
      if (b !== firstKeepable) _dup.selection.add(_batchKey(b));
    });

    _renderPreviewBody();
  }

  function _batchKey(b) {
    // grn_item_id can be null (orphan with no item id). Use a safe synthetic key.
    return b.grn_item_id == null ? '__null__:' + b.min_seq : String(b.grn_item_id);
  }

  function _renderPreviewBody() {
    const body = document.getElementById('dup-preview-body');
    const r = _dup.byKey[_dup.previewKey];
    if (!body || !r) return;

    const rowsHTML = (r.batches || []).map(b => {
      const bk      = _batchKey(b);
      const checked = _dup.selection.has(bk);
      const tooltip = b.any_moved
        ? 'This batch has movement history — cannot delete'
        : (b.is_orphan ? 'Orphan — references a deleted grn_item_id' : 'Tied to a current grn_item_id');
      const tagBits = [];
      if (b.is_orphan) tagBits.push(`<span style="background:rgba(220,38,38,.12);color:#991b1b;font-size:9px;font-weight:800;padding:1px 6px;border-radius:9px">ORPHAN</span>`);
      if (b.any_moved) tagBits.push(`<span style="background:rgba(217,119,6,.12);color:#92400e;font-size:9px;font-weight:800;padding:1px 6px;border-radius:9px">HAS MOVES</span>`);
      const tagsHTML = tagBits.join(' ');

      return `<div style="border:1.5px solid ${checked ? 'rgba(220,38,38,.35)' : 'var(--hbdr,rgba(0,0,0,.1))'};
        background:${checked ? 'rgba(220,38,38,.04)' : 'var(--surface,#fff)'};
        border-radius:8px;padding:12px 14px;margin-bottom:10px;display:grid;grid-template-columns:36px 1fr;gap:12px;align-items:start" title="${_esc(tooltip)}">
        <div style="padding-top:2px">
          <input type="checkbox" class="dup-batch-cb" data-bk="${_esc(bk)}"
            ${checked ? 'checked' : ''} ${b.any_moved ? 'disabled' : ''}
            onchange="dupToggleBatch(this)"
            style="width:18px;height:18px;cursor:${b.any_moved?'not-allowed':'pointer'};accent-color:#dc2626">
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <div style="font-size:12px;font-weight:800;color:var(--htxtb,#111)">
              Batch · ${b.box_count} boxes · seq ${b.min_seq}–${b.max_seq}
            </div>
            ${tagsHTML}
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px;font-size:11px;color:var(--hmuted2,#475569)">
            <div><b style="color:var(--htxtb,#111);font-weight:700">grn_item_id:</b> ${b.grn_item_id == null ? '<i>null</i>' : '#' + b.grn_item_id}</div>
            <div><b style="color:var(--htxtb,#111);font-weight:700">created:</b> ${_fmtDateTime(b.first_created)} → ${_fmtDateTime(b.last_created)}</div>
            <div><b style="color:var(--htxtb,#111);font-weight:700">first code:</b> <span style="font-family:monospace">${_esc(b.first_box_code || '—')}</span></div>
            <div><b style="color:var(--htxtb,#111);font-weight:700">last code:</b> <span style="font-family:monospace">${_esc(b.last_box_code || '—')}</span></div>
          </div>
        </div>
      </div>`;
    }).join('');

    body.innerHTML = `
      <div style="margin-bottom:14px;padding:10px 12px;background:rgba(13,148,136,.06);border:1px solid rgba(13,148,136,.2);border-radius:8px;font-size:11.5px;color:#0f766e;line-height:1.5">
        <b>Tip:</b> Check the batches to <b>delete</b>. The default suggestion keeps the earliest non-moved batch and marks the rest for deletion. Adjust if you have a reason to prefer a different batch (e.g. labels already printed for a specific seq range).
      </div>
      ${rowsHTML}
      <div style="margin-top:6px">
        <label style="font-size:11.5px;color:var(--htxtb,#111);font-weight:700;display:block;margin-bottom:4px">Reason (optional)</label>
        <textarea id="dup-cleanup-reason" rows="2" placeholder="e.g. PM-GRN/0343 double-save Jun 2026"
          style="width:100%;background:var(--hinput,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text,#111);outline:none;resize:vertical"></textarea>
      </div>
    `;

    _updatePreviewSummary();

    // Open modal if it isn't already
    const m = document.getElementById('dupBoxPreviewModal');
    if (m && !m.classList.contains('open')) m.classList.add('open');
  }

  function _updatePreviewSummary() {
    const r = _dup.byKey[_dup.previewKey];
    if (!r) return;
    // Count selected boxes
    let selBoxes = 0;
    (r.batches || []).forEach(b => {
      if (_dup.selection.has(_batchKey(b))) selBoxes += (Number(b.box_count) || 0);
    });
    const after = (Number(r.actual_box_count) || 0) - selBoxes;
    const expected = Number(r.expected_no_of_box) || 0;
    const willMatch = after === expected;
    const sum = document.getElementById('dup-preview-summary');
    if (sum) {
      sum.innerHTML = `Will delete <b style="color:#dc2626">${_fmtN(selBoxes)}</b> box${selBoxes===1?'':'es'}. After cleanup: <b>${_fmtN(after)}</b> remain ${willMatch ? '<span style="color:#16a34a">✓ matches expected ' + _fmtN(expected) + '</span>' : '<span style="color:#d97706">⚠ won\'t match expected ' + _fmtN(expected) + '</span>'}.`;
    }
    const btn = document.getElementById('dup-preview-apply-btn');
    if (btn) btn.disabled = selBoxes === 0;
  }

  function dupToggleBatch(cb) {
    const bk = cb.dataset.bk;
    if (cb.checked) _dup.selection.add(bk);
    else            _dup.selection.delete(bk);
    _renderPreviewBody();  // re-render to update outline + summary
  }

  // ── Apply cleanup ─────────────────────────────────────────────────
  async function applyDupCleanup() {
    const r = _dup.byKey[_dup.previewKey];
    if (!r) return;
    if (!_dup.selection.size) { _t('Nothing selected', 'error'); return; }

    const btn = document.getElementById('dup-preview-apply-btn');
    const origHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working…'; }

    try {
      // For each selected batch, fetch its box_ids via the dedicated endpoint.
      // (We don't ship ids in the initial diagnostic to keep that payload
      // small — but cleanup needs them explicitly, since the cleanup POST
      // validates each id belongs to (grn_id, product_id) and refuses moved
      // boxes. So we fetch fresh ids right before submitting.)
      const allIds = [];
      for (const bk of _dup.selection) {
        const params = new URLSearchParams();
        params.set('grn_id',     r.grn_id);
        params.set('product_id', r.product_id);
        // bk format: either a numeric string (grn_item_id) or "__null__:<seq>"
        if (bk.startsWith('__null__:')) {
          params.set('grn_item_id', '');  // empty → null/orphan batch
        } else {
          params.set('grn_item_id', bk);
        }
        const ir = await fetch('/api/pm_stock/admin/duplicate_boxes/batch_ids?' + params.toString());
        const id = await ir.json();
        if (id.status !== 'ok') {
          _t(`Failed to fetch batch ids: ${id.message || 'unknown error'}`, 'error', 5000);
          if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
          return;
        }
        (id.box_ids || []).forEach(x => allIds.push(x));
      }
      if (!allIds.length) {
        _t('No box_ids fetched — re-scan and retry', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
        return;
      }

      // Final confirm
      if (!confirm(`Delete ${allIds.length} duplicate boxes from ${r.grn_no} (${r.product_name})?\n\nReversible via Recycle Bin.`)) {
        if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
        return;
      }

      const reason = document.getElementById('dup-cleanup-reason')?.value?.trim() || null;
      const resp = await fetch('/api/pm_stock/admin/duplicate_boxes/cleanup', {
        method:  'POST',
        headers: {'Content-Type': 'application/json'},
        body:    JSON.stringify({
          grn_id:     r.grn_id,
          product_id: r.product_id,
          box_ids:    allIds,
          reason:     reason
        })
      });
      const result = await resp.json();
      if (result.status === 'ok') {
        _t(result.message || `Deleted ${result.deleted} boxes`, 'success', 4500);
        if (typeof closeModal === 'function') closeModal('dupBoxPreviewModal');
        else document.getElementById('dupBoxPreviewModal').classList.remove('open');
        loadDuplicateBoxes();
      } else {
        _t(result.message || 'Cleanup failed', 'error', 6000);
      }
    } catch(e) {
      _t('Network error: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
  }

  // ── Globals ───────────────────────────────────────────────────────
  window.openDuplicateBoxesModal = openDuplicateBoxesModal;
  window.loadDuplicateBoxes      = loadDuplicateBoxes;
  window.previewDupCleanup       = previewDupCleanup;
  window.dupToggleBatch          = dupToggleBatch;
  window.applyDupCleanup         = applyDupCleanup;
})();
