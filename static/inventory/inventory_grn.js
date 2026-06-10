/* inventory_grn.js — Goods Receipt Note module for the Inventory page
   ────────────────────────────────────────────────────────────────────
   Self-contained: no dependency on procurement/po.js/utils.js globals.
   Talks exclusively to /api/inventory_mgmt/* endpoints.
   Reads/writes the SAME procurement_grn / procurement_grn_items tables
   via the inventory-scoped backend wrappers in inventory_mgmt.py.

   Public API (all hung off window.* so the HTML onclicks resolve):
     invGrnLoadList()              — refresh & render list
     invGrnApplyFilter()           — search + status filter
     invGrnOpenForm(row|null)      — open form (edit / new)
     invGrnCloseForm()             — back to list
     invGrnSave()                  — save current form
     invGrnDeleteCurrent()         — delete the GRN open in the form
     invGrnDelete(idx)             — delete by row index in filtered list
     invGrnPrint()                 — open print preview window
     invGrnVoucherTypeChange()     — type dropdown handler
     invGrnPoChange()              — PO dropdown handler
     invGrnAddManualInvoice()      — push empty PO row
     invGrnRemoveInvoice(i)        — remove one PO row
     invGrnAddLine()               — push empty line item
     invGrnToggleCharge(type)      — enable/disable freight/packing
     invGrnCalcTotal()             — recompute footer totals
     invGrnCalcLineTotal(i)        — recompute one line's total
*/
(function(){
  'use strict';

  /* ══════════════════════ STATE ══════════════════════ */
  var _grnRows       = [];   // all GRNs from server
  var _grnFiltered   = [];   // after filter
  var _grnEditId     = null; // null = new GRN
  var _grnLines         = [];   // [{material, po_qty, received_qty, grn_item_id, coa_files, ...}]
  var _grnPoInvoices    = [];   // [{po_id, po_num, invoice_num, invoice_date, po_date}]
  var _grnInvoiceFiles  = [];   // GRN-level invoice attachments: [{id, original_name, mime_type, size_bytes}]
  var _grnAutoStatus    = 'open';

  // Lookups (populated lazily)
  var _supRows         = [];
  var _poRows          = [];
  var _matRows         = [];
  var _godowns         = [];
  var _voucherTypeList = [];
  var _poTypeList      = [];
  var _matGroupFilter  = null;     // 'rm' | 'pm' | 'fg' | null

  /* ══════════════════════ HELPERS ══════════════════════ */
  function esc(s){
    if (s === null || s === undefined || s === 0) return s === 0 ? '0' : '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fd(d){
    if (!d) return '—';
    var p = String(d).split('-');
    if (p.length < 3) return String(d);
    var y = p[0], m = parseInt(p[1],10), day = p[2].split(' ')[0]; // strip time if present
    if (isNaN(m) || m < 1 || m > 12) return String(d);
    return day + '/' + MONTHS[m-1] + '/' + y;
  }
  function fi(n){
    var v = parseFloat(n);
    if (!isFinite(v)) return '—';
    return '\u20B9 ' + v.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  function fnum(n, dec){
    var v = parseFloat(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString('en-IN', {maximumFractionDigits: (dec==null?3:dec)});
  }
  function _toast(msg, type, ms){
    type = type || 'info'; ms = ms || 3500;
    var stack = document.getElementById('invToastStack');
    if (!stack){
      // fall back to alert if container missing — should never happen
      console.log('[GRN]', type, msg); return;
    }
    var el = document.createElement('div');
    el.className = 'inv-toast ' + type;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function(){
      el.classList.add('dying');
      setTimeout(function(){ el.remove(); }, 280);
    }, ms);
  }
  function todayISO(){
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  /* ══════════════════════ LIST ══════════════════════ */
  function loadList(){
    var body = document.getElementById('grnListBody');
    if (body) body.innerHTML = '<tr><td colspan="11" class="no-data">Loading…</td></tr>';
    fetch('/api/inventory_mgmt/grn/list')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message || 'Failed');
        _grnRows = d.grns || [];
        applyFilter();
      })
      .catch(function(e){
        if (body) body.innerHTML = '<tr><td colspan="11" class="no-data">Failed to load: ' + esc(e.message) + '</td></tr>';
      });
  }

  function applyFilter(){
    var qEl = document.getElementById('grnSearchInput');
    var sEl = document.getElementById('grnFilterStatus');
    var q = (qEl ? qEl.value : '').toLowerCase().trim();
    var statusFilter = sEl ? sEl.value : 'all';
    _grnFiltered = _grnRows.filter(function(r){
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      var hay = [r.grn_num||'', r.supplier_name||'', r.po_num||'',
                 r.invoice_num||'', r.grn_date||'', r.remarks||'',
                 r.supervisor_name||''].join(' ').toLowerCase();
      // Items inside the GRN (material names) + their manufacturers.
      if (r.line_materials && r.line_materials.length){
        hay += ' ' + r.line_materials.join(' ').toLowerCase();
      }
      if (r.line_manufacturers && r.line_manufacturers.length){
        hay += ' ' + r.line_manufacturers.join(' ').toLowerCase();
      }
      if (r.po_invoices && r.po_invoices.length){
        r.po_invoices.forEach(function(inv){
          hay += ' ' + (inv.invoice_num||'') + ' ' + (inv.po_num||'');
        });
      }
      // Also search by line-item invoice numbers (the common case).
      if (r.line_invoices && r.line_invoices.length){
        r.line_invoices.forEach(function(inv){
          hay += ' ' + (inv.invoice_num||'');
        });
      }
      return hay.indexOf(q) !== -1;
    });
    renderList();
  }

  function renderList(){
    var body = document.getElementById('grnListBody');
    if (!body) return;
    // Pull per-feature GRN capabilities from the page-load context. The
    // template gates buttons by these (can_create_grn / can_edit_grn /
    // can_delete_grn), and we mirror them on the JS side so row-action
    // icons can be hidden / shown without resorting to fragile DOM probes
    // like "is the New GRN button present in the toolbar".
    var _grnCaps = (window.INV_CTX && window.INV_CTX.grn) || {};
    var canCreate = !!_grnCaps.canCreate;
    var canEdit   = !!_grnCaps.canEdit;
    var canDelete = !!_grnCaps.canDelete;

    if (!_grnFiltered.length){
      // Tailor the empty-state CTA to what this user can actually do.
      // A view-only user seeing "Click New GRN to create one" is confusing
      // because they have no such button.
      var emptyMsg = canCreate
        ? 'No GRNs found. Click <strong>New GRN</strong> to create one.'
        : 'No GRNs found.';
      body.innerHTML = '<tr><td colspan="10" class="no-data">'
        + '<i class="fas fa-clipboard-list"></i>'
        + emptyMsg
        + '</td></tr>';
      return;
    }

    body.innerHTML = _grnFiltered.map(function(r, idx){
      // PO numbers cell
      var poNums = [];
      if (r.po_num) poNums.push(r.po_num);
      if (r.po_invoices && r.po_invoices.length){
        r.po_invoices.forEach(function(inv){
          if (inv.po_num && poNums.indexOf(inv.po_num) === -1) poNums.push(inv.po_num);
        });
      }
      var poCell = poNums.length
        ? poNums.map(function(p){ return '<span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--nb-primary)">' + esc(p) + '</span>'; }).join('<br>')
        : '<span class="muted-cell">—</span>';
      // Invoice cell — three sources, in priority order:
      //   1. po_invoices (per-PO header invoices) — but only entries that
      //      actually have a non-empty invoice_num. A linked PO with no
      //      header-level invoice still gets stored as a po_invoices entry
      //      with empty invoice_num, so we filter those out.
      //   2. r.invoice_num (single header invoice, legacy)
      //   3. line_invoices (aggregated from line items via SQL in /grn/list)
      //
      // Most users today enter the invoice number on each line item, so
      // #3 is what actually shows up in the list for current GRNs.
      var invs;
      var poInvsWithNum = (r.po_invoices || []).filter(function(inv){
        return inv && (inv.invoice_num || '').trim();
      });
      if (poInvsWithNum.length){
        invs = poInvsWithNum;
      } else if (r.invoice_num){
        invs = [{po_num:r.po_num||'', invoice_num:r.invoice_num, invoice_date:r.invoice_date}];
      } else if (r.line_invoices && r.line_invoices.length){
        invs = r.line_invoices;
      } else {
        invs = [];
      }
      var invCell = invs.length
        ? invs.map(function(inv){
            return esc(inv.invoice_num||'—') + (inv.invoice_date ? '<span style="color:var(--nb-text-muted);font-size:10px"> ' + fd(inv.invoice_date) + '</span>' : '');
          }).join('<br>')
        : '<span class="muted-cell">—</span>';

      // ── Attachment badges (📎 invoices · 📋 COAs) ──────────────────
      // Counts come from /grn/list (invoice_file_count + coa_file_count).
      // Click → open the GRN for viewing/editing — same as the row's edit
      // action — keeps things consistent and saves one click.
      var invFileCount = parseInt(r.invoice_file_count) || 0;
      var coaFileCount = parseInt(r.coa_file_count)     || 0;
      if (invFileCount > 0 || coaFileCount > 0){
        var badges = '';
        if (invFileCount > 0){
          badges += '<span class="grn-list-file-badge grn-list-file-badge-inv" '
                  + 'title="' + invFileCount + ' invoice file' + (invFileCount===1?'':'s') + ' attached"'
                  + '>'
                  + '<i class="fas fa-paperclip"></i> ' + invFileCount
                  + '</span>';
        }
        if (coaFileCount > 0){
          badges += '<span class="grn-list-file-badge grn-list-file-badge-coa" '
                  + 'title="' + coaFileCount + ' COA file' + (coaFileCount===1?'':'s') + ' attached"'
                  + '>'
                  + '<i class="fas fa-clipboard-check"></i> ' + coaFileCount
                  + '</span>';
        }
        invCell += '<div class="grn-list-file-badges">' + badges + '</div>';
      }

      // NOTE: Status column was removed from the list view (May 2026).
      // The status field is still stored on the record and the status
      // filter dropdown still filters by it — only the visible column went away.
      // Edit icon is shown for everyone with GRN view rights (view-only
      // users land on a read-only form). Delete is gated separately:
      // it's an edit-class action, so requires the same right.
      var actionBtns = '<button class="icon-btn-sm" onclick="invGrnOpenFormByIdx(' + idx + ')" title="Edit"><i class="fas fa-edit"></i></button>';
      if (canDelete){
        actionBtns += ' <button class="icon-btn-sm" onclick="invGrnDelete(' + idx + ')" title="Delete" style="color:var(--nb-danger)"><i class="fas fa-trash"></i></button>';
      }

      // ── Row tint based on TRS completion ───────────────────────────
      //   trs_status='all'     → soft green (every line has a TRS)
      //   trs_status='partial' → soft amber (some lines have TRS)
      //   trs_status='none'    → default white (or stripe)
      // Inline styles so this works regardless of which stylesheet
      // version is loaded and doesn't conflict with hover states.
      var rowTint = '';
      if (r.trs_status === 'all'){
        rowTint = 'background-color:rgba(22,163,74,.08)';   // soft green
      } else if (r.trs_status === 'partial'){
        rowTint = 'background-color:rgba(217,119,6,.10)';   // soft amber
      }
      var rowStyle = 'cursor:pointer' + (rowTint ? ';' + rowTint : '');

      // Tooltip showing the actual TRS counts so users can see what
      // the colour means without guessing.
      var trsTitle = '';
      if (r.trs_status === 'all'){
        trsTitle = 'TRS generated for all ' + (r.combo_total || r.item_count || 0) + ' material/batch group(s)';
      } else if (r.trs_status === 'partial'){
        trsTitle = 'TRS generated for ' + (r.combo_done || 0) + ' of ' + (r.combo_total || r.item_count || 0) + ' material/batch group(s)';
      }
      var trTitleAttr = trsTitle ? ' title="' + esc(trsTitle) + '"' : '';

      return '<tr ondblclick="invGrnOpenFormByIdx(' + idx + ')" style="' + rowStyle + '"' + trTitleAttr + '>'
        + '<td class="td-center muted-cell">' + (idx+1) + '</td>'
        + '<td style="font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--nb-primary)">' + esc(r.grn_num||'—') + '</td>'
        + '<td class="td-name">' + esc(r.supplier_name||'—') + '</td>'
        + '<td>' + fd(r.grn_date||'') + '</td>'
        + '<td style="font-size:11.5px">' + poCell + '</td>'
        + '<td style="font-size:11.5px">' + invCell + '</td>'
        + '<td class="td-num">' + (r.grand_total != null ? fi(r.grand_total) : '—') + '</td>'
        + '<td class="td-center muted-cell">' + (r.item_count != null ? r.item_count : '—') + '</td>'
        + '<td style="font-size:11.5px">' + esc(r.created_by || '—') + '</td>'
        + '<td class="td-center"><div class="row-actions">' + actionBtns + '</div></td>'
        + '</tr>';
    }).join('');
  }

  function openFormByIdx(idx){ openForm(_grnFiltered[idx]); }

  function deleteByIdx(idx){
    var r = _grnFiltered[idx];
    if (!r || !r.id) return;
    if (!confirm('Delete GRN ' + r.grn_num + '?\nThis cannot be undone — the received stock will be reversed.')) return;
    fetch('/api/inventory_mgmt/grn/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({id: r.id})
    })
    .then(function(res){ return res.json(); })
    .then(function(d){
      if (d.status !== 'ok') throw new Error(d.message || 'Delete failed');
      _toast('GRN ' + r.grn_num + ' deleted', 'success');
      loadList();
    })
    .catch(function(e){ _toast('Delete failed: ' + e.message, 'error'); });
  }

  /* ══════════════════════ FORM ══════════════════════ */
  function openForm(row){
    _grnEditId        = row ? row.id : null;
    _grnLines         = [];
    _grnPoInvoices    = [];
    _grnInvoiceFiles  = [];

    var listView = document.getElementById('grn-list-view');
    var formPane = document.getElementById('grn-form-pane');
    if (!listView || !formPane) return;

    // Reset visible form fields
    setVal('grnDate', todayISO());
    setVal('grnSupplier', '');
    setVal('grnRemarks', '');
    setVal('grnFreightAmt', '');
    setVal('grnPackingAmt', '');
    var fe = document.getElementById('grnFreightEnabled'); if (fe){ fe.checked = false; toggleCharge('freight'); }
    var pe = document.getElementById('grnPackingEnabled'); if (pe){ pe.checked = false; toggleCharge('packing'); }
    var oe = document.getElementById('grnOtherEnabled');   if (oe){ oe.checked = false; toggleCharge('other'); }
    var delBtn = document.getElementById('grnDeleteBtn');
    if (delBtn) delBtn.style.display = _grnEditId ? '' : 'none';

    // Per-state visibility of the Save button. The Jinja-level gate
    // shows it when (can_create_grn OR can_edit_grn). Refine here:
    // when editing an existing GRN but the user has ONLY create rights
    // (not edit), hide Save so they don't submit and hit a server 403.
    var saveBtn = document.getElementById('grnSaveBtn');
    if (saveBtn){
      // Reset the button out of any leftover "Saving…" state from a prior
      // save. The success path calls closeForm() without restoring the
      // button, so without this the button stays disabled/"Saving…" the
      // next time the form opens.
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save GRN';
      var ctx = (window.INV_CTX && window.INV_CTX.grn) || {};
      var canSaveThis = _grnEditId
        ? !!ctx.canEdit                      // editing → needs edit cap
        : !!(ctx.canCreate || ctx.canEdit);  // new     → either works
      saveBtn.style.display = canSaveThis ? '' : 'none';
    }

    Promise.all([
      ensureSuppliersLoaded(),
      ensureMaterialsLoaded(),
      ensureGodownsLoaded(),
      ensurePoListLoaded(),
      ensureVoucherTypesLoaded()
    ]).then(function(){
      refreshSupplierDatalist();
      refreshMaterialDatalist();
      populateVoucherTypes(row && row.voucher_type_name || '');
      populatePOSelect(row ? row.po_id : null);

      if (row && row.id){
        // Edit existing
        document.getElementById('grnFormEyebrow').textContent = 'EDIT GRN';
        document.getElementById('grnFormTitle').textContent   = 'Edit Goods Receipt Note';
        loadGrnForEdit(row.id);
      } else {
        // New
        document.getElementById('grnFormEyebrow').textContent = 'NEW GRN';
        document.getElementById('grnFormTitle').textContent   = 'New Goods Receipt Note';
        document.getElementById('grnFormNum').textContent     = 'Auto-assigned on save';
        // Re-enable GRN type dropdown (it gets locked when editing existing GRNs).
        var typeSelNew = document.getElementById('grnVoucherType');
        if (typeSelNew) {
          typeSelNew.disabled = false;
          typeSelNew.title = '';
          typeSelNew.style.cursor = '';
          typeSelNew.style.background = '';
          typeSelNew.style.color = '';

          // ── Default to RM GRN for new GRNs (NEW-only — never overrides
          // an edited GRN's saved type). Match priority:
          //   1. mat_type_abbr === 'RM' (the structured signal)
          //   2. abbreviation === 'RM GRN'
          //   3. name starts with 'Raw Material'
          // Only auto-selects if the dropdown is still on the default
          // "— Default —" option, so it doesn't override a user-typed
          // value if some other code path got here first.
          if (!typeSelNew.value) {
            var rmType = (_voucherTypeList || []).find(function(t){
              return (t.mat_type_abbr || '').toUpperCase() === 'RM';
            }) || (_voucherTypeList || []).find(function(t){
              return (t.abbreviation || '').toUpperCase() === 'RM GRN';
            }) || (_voucherTypeList || []).find(function(t){
              return /^raw\s+material/i.test(t.name || '');
            });
            if (rmType && rmType.name) {
              typeSelNew.value = rmType.name;
              // Trigger the change handler so the linked-PO list and
              // material-type filter pick up the new selection.
              voucherTypeChange();
            }
          }
        }
        setVal('grnSupervisor', '');
        _grnOtherDetails = {};
        _grnChecklist    = {};
        _refreshOtherDetailsBadge();
        _refreshChecklistBadge();
        _grnPoInvoices = [];
        _grnInvoiceFiles = [];
        renderInvoiceFiles();
        renderPoInvoices();
        if (!_grnLines.length) _grnLines.push(emptyLine());
        renderLines();
      }
    });

    listView.style.display = 'none';
    formPane.classList.add('open');
    formPane.scrollTo && formPane.scrollTo(0,0);
  }

  function loadGrnForEdit(id){
    fetch('/api/inventory_mgmt/grn/get?id=' + id)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message);
        var o = d.grn;
        document.getElementById('grnFormNum').textContent = o.grn_num || '—';
        setVal('grnDate',     o.grn_date || todayISO());
        setVal('grnSupplier', o.supplier_name || '');
        setVal('grnSupervisor', o.supervisor_name || '');
        setVal('grnRemarks',  o.remarks || '');
        // Load other-details + checklist (both optional, default to empty)
        _grnOtherDetails = o.other_details || {};
        _grnChecklist    = o.unload_checklist || {};
        _refreshOtherDetailsBadge();
        _refreshChecklistBadge();
        var typeSel = document.getElementById('grnVoucherType');
        if (typeSel) {
          typeSel.value = o.voucher_type_name || '';
          // Once saved, GRN type is fixed — disable the dropdown to prevent changes.
          // (We still POST the original value back on save because <select disabled>
          // is not in the form-data — but our save handler uses getVal() which reads
          // .value regardless of disabled state, so this is safe.)
          typeSel.disabled = true;
          typeSel.title = 'GRN Type cannot be changed after the GRN is saved';
          typeSel.style.cursor = 'not-allowed';
          typeSel.style.background = 'var(--nb-bg)';
          typeSel.style.color = 'var(--nb-text-muted)';
        }
        // PO invoices
        if (o.po_invoices && o.po_invoices.length){
          _grnPoInvoices = o.po_invoices.map(function(inv){
            return {
              po_id: inv.po_id || null,
              po_num: inv.po_num || '',
              po_date: inv.po_date || '',
              invoice_num: inv.invoice_num || '',
              invoice_date: inv.invoice_date || ''
            };
          });
        } else if (o.po_id || o.po_num){
          _grnPoInvoices = [{
            po_id: o.po_id || null, po_num: o.po_num || '',
            invoice_num: o.invoice_num || '', invoice_date: o.invoice_date || ''
          }];
        } else {
          _grnPoInvoices = [];
        }
        renderPoInvoices();
        // Charges
        setCharge('freight', o.freight_charge);
        setCharge('packing', o.packing_charge);
        setCharge('other',   o.other_charge, o.other_charge_label);
        // Lines
        var coaByItem = o.coa_by_item || {};
        _grnLines = (o.items || []).map(function(i){
          var matRow = matchMaterial(i.material);
          // Look up COA files attached to this line (keyed by DB item id).
          var itemId = i.id != null ? parseInt(i.id) : null;
          var coaList = (itemId && coaByItem[itemId]) ? coaByItem[itemId] : [];
          return {
            grn_item_id:  itemId,
            coa_files:    coaList,  // [{id, original_name, mime_type, size_bytes}]
            material:     i.material || '',
            po_qty:       i.po_qty       != null ? parseFloat(i.po_qty)       : '',
            received_qty: i.received_qty != null ? parseFloat(i.received_qty) : '',
            qty_per_pkg:  i.qty_per_pkg  != null ? parseFloat(i.qty_per_pkg)  : '',
            packages:     i.packages != null ? i.packages : '',
            total_qty:    i.received_qty != null ? parseFloat(i.received_qty) : 0,
            rate:         i.rate         != null ? parseFloat(i.rate)         : '',
            hsn_code:     i.hsn_code || '',
            gst_rate:     i.gst_rate     != null ? parseFloat(i.gst_rate)     : 0,
            location:     i.location || '',
            invoice_num:  i.invoice_num || '',
            invoice_date: i.invoice_date || '',
            batch_num:    i.batch_num || '',
            mfg_date:     i.mfg_date || '',
            expiry_date:  i.expiry_date || '',
            manufacturer: i.manufacturer || '',
            uom:          i.uom || (matRow && matRow.uom) || 'KG',
            pending_qty:  null,
            already_rcvd: 0
          };
        });
        if (!_grnLines.length) _grnLines.push(emptyLine());
        // GRN-level invoice files (multiple allowed).
        _grnInvoiceFiles = o.invoices || [];
        renderInvoiceFiles();
        renderLines();
        populatePOSelect(o.po_id);

        // Fetch any TRS slips already generated for this GRN so the line
        // rows can show a ✅ TRS badge in the row-number cell. Done after
        // the initial render so the form opens fast — the badges appear a
        // moment later when the list lands.
        _loadTrsBadges(id);
      })
      .catch(function(e){ _toast('Could not load GRN: ' + e.message, 'error'); });
  }

  // Fetch /api/inventory_mgmt/trs/list and stamp each _grnLines entry with
  // its TRS metadata (trs_num, trs_id, trs_status). Re-runs renderLines so
  // the row-number cells flip to badges. Safe to call multiple times — it
  // simply overwrites the existing stamps with fresh ones.
  //
  // Matching strategy (with fallback for legacy orphaned data):
  //   Primary: TRS.grn_item_id === line.grn_item_id  (fast, exact)
  //   Fallback: TRS.material + TRS.batch_num matches the line  (covers
  //             the case where a GRN was edited before the server-side
  //             repair was deployed, so the TRS row still points at a
  //             stale grn_item_id even though the data is recoverable).
  function _loadTrsBadges(grnId){
    if (!grnId) return;
    fetch('/api/inventory_mgmt/trs/list?grn_id=' + encodeURIComponent(grnId))
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || d.status !== 'ok' || !Array.isArray(d.trs)) return;
        var byItem = {};
        d.trs.forEach(function(t){
          if (t.grn_item_id) byItem[t.grn_item_id] = t;
        });

        // Helper: case/whitespace-insensitive (material, batch) match.
        function _matchByMatBatch(line){
          var lm = (line.material  || '').trim().toLowerCase();
          var lb = (line.batch_num || '').trim();
          if (!lm) return null;
          for (var i = 0; i < d.trs.length; i++){
            var t  = d.trs[i];
            var tm = (t.material  || '').trim().toLowerCase();
            var tb = (t.batch_num || '').trim();
            if (tm === lm && tb === lb) return t;
          }
          return null;
        }

        // Mutate _grnLines in place; preserve any unsaved edits the user
        // may have already typed.
        _grnLines.forEach(function(line){
          var t = line.grn_item_id && byItem[line.grn_item_id];
          if (!t){
            // Primary lookup missed — try material+batch as a fallback.
            t = _matchByMatBatch(line);
            if (t){
              // Log so the diagnostic trail makes sense if anything else
              // looks off — this branch firing means the server-side
              // lazy repair didn't kick in (or the data has drifted in
              // a way the repair can't see).
              console.warn('[GRN] TRS matched by material+batch fallback '
                + 'for line', line.grn_item_id,
                '→ trs_id', t.id, t.trs_num);
            }
          }
          if (t){
            line.trs_id     = t.id;
            line.trs_num    = t.trs_num;
            line.trs_status = t.approval_status || 'Pending';
          } else {
            // Explicitly clear in case a TRS was deleted in another tab.
            line.trs_id = line.trs_num = line.trs_status = null;
          }
        });
        renderLines();
      })
      .catch(function(){ /* badges are best-effort — don't disturb the form */ });
  }

  function closeForm(){
    var listView = document.getElementById('grn-list-view');
    var formPane = document.getElementById('grn-form-pane');
    if (formPane) formPane.classList.remove('open');
    if (listView) listView.style.display = '';
    _grnEditId = null;
    loadList();
  }

  function emptyLine(){
    return {
      grn_item_id:null, coa_files:[],
      material:'', po_qty:'', received_qty:'', qty_per_pkg:'', packages:'',
      total_qty:0, rate:'', hsn_code:'', gst_rate:0,
      location:'', invoice_num:'', invoice_date:'',
      batch_num:'', mfg_date:'', expiry_date:'', manufacturer:'',
      uom:'KG', pending_qty:null, already_rcvd:0
    };
  }

  /* ══════════════════════ LOOKUPS ══════════════════════ */
  function ensureSuppliersLoaded(){
    if (_supRows.length) return Promise.resolve();
    return fetch('/api/inventory_mgmt/suppliers')
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.status === 'ok') _supRows = d.suppliers || []; })
      .catch(function(){});
  }
  function ensureMaterialsLoaded(){
    if (_matRows.length) return Promise.resolve();
    return fetch('/api/inventory_mgmt/grn_materials')
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.status === 'ok') _matRows = d.rows || []; })
      .catch(function(){});
  }
  function ensureGodownsLoaded(){
    if (_godowns.length) return Promise.resolve();
    return fetch('/api/inventory_mgmt/godowns')
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.status === 'ok') _godowns = d.godowns || []; })
      .catch(function(){});
  }
  function ensurePoListLoaded(){
    if (_poRows.length) return Promise.resolve();
    return fetch('/api/inventory_mgmt/po/list')
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.status === 'ok') _poRows = d.orders || []; })
      .catch(function(){});
  }
  function ensureVoucherTypesLoaded(){
    if (_voucherTypeList.length || _poTypeList.length) return Promise.resolve();
    // Voucher types live in gop_voucher_types and are read by TWO endpoints:
    //   • /api/inventory_mgmt/voucher_types  — login-only, works for every
    //     logged-in user (admin and non-admin alike).
    //   • /api/gop/voucher_types             — same data but the procurement
    //     blueprint enforces additional role gates that 403 non-admins.
    //
    // We hit the inventory passthrough FIRST so the GRN Type dropdown
    // populates correctly for non-admin users (they're the common case).
    // Fall back to the procurement endpoint only if the passthrough is
    // missing/errors — that should never happen in normal operation
    // but lets the page survive an inventory-module misconfiguration.
    function fetchTypes(parentType){
      return fetch('/api/inventory_mgmt/voucher_types?parent_type=' + parentType)
        .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(d){
          if (d && d.status === 'ok' && Array.isArray(d.types) && d.types.length > 0){
            return d;
          }
          // Passthrough returned empty — try procurement as a last resort.
          return fetch('/api/gop/voucher_types?parent_type=' + parentType)
            .then(function(r2){ if (!r2.ok) throw new Error('HTTP ' + r2.status); return r2.json(); })
            .then(function(d2){
              if (d2 && d2.status === 'ok' && (d2.types||[]).length > 0) return d2;
              return d;
            })
            .catch(function(){ return d; });
        })
        .catch(function(){
          // Inventory passthrough unreachable — fall back to procurement.
          return fetch('/api/gop/voucher_types?parent_type=' + parentType)
            .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .catch(function(){ return {status:'ok', types:[]}; });
        });
    }
    return Promise.all([
      fetchTypes('grn').then(function(d){
        if (d.status === 'ok') {
          _voucherTypeList = (d.types || []).filter(function(t){ return t.is_active; });
          console.log('[GRN] voucher types loaded:', _voucherTypeList.length, 'of', (d.types||[]).length, 'rows');
        } else {
          console.warn('[GRN] voucher_types load failed:', d);
        }
      }),
      fetchTypes('po').then(function(d){
        if (d.status === 'ok') _poTypeList = d.types || [];
      })
    ]);
  }

  function refreshSupplierDatalist(){
    var dl = document.getElementById('grnSupplierList');
    if (!dl) return;
    dl.innerHTML = (_supRows||[]).map(function(s){
      return '<option value="' + esc(s.supplier_name || '') + '">';
    }).join('');
  }
  function refreshMaterialDatalist(){
    var dl = document.getElementById('grnMatList');
    if (!dl) return;
    var matched = (_matRows || []).filter(function(r){
      if (!_matGroupFilter) return true;
      var abbr = (r.mat_type_abbr || '').toUpperCase();
      if (abbr){
        if (_matGroupFilter === 'rm') return abbr === 'RM';
        if (_matGroupFilter === 'pm') return abbr === 'PM';
        if (_matGroupFilter === 'fg') return abbr === 'FG';
      }
      var grp = (r.group_name || '').toLowerCase();
      if (_matGroupFilter === 'rm') return grp.indexOf('raw') !== -1;
      if (_matGroupFilter === 'pm') return grp.indexOf('pack') !== -1;
      if (_matGroupFilter === 'fg') return grp.indexOf('finish') !== -1 || grp.indexOf('fg') !== -1;
      return true;
    });
    if (_matGroupFilter && matched.length === 0) matched = (_matRows || []).slice();
    dl.innerHTML = matched.map(function(r){
      return '<option value="' + esc(r.material_name || '') + '">';
    }).join('');
  }
  function matchMaterial(name){
    if (!name) return null;
    var n = name.toLowerCase();
    return (_matRows || []).find(function(r){ return (r.material_name||'').toLowerCase() === n; }) || null;
  }

  function populateVoucherTypes(currentTypeName){
    var sel = document.getElementById('grnVoucherType');
    if (!sel) return;

    // ── BULLETPROOF PATH FOR NON-ADMINS ──
    // The server now renders <option> tags directly into the dropdown
    // from inventory_mgmt.py's voucher_types_grn list. This means the
    // dropdown is usable from page-load, with no JS dependency. The
    // logic below treats those server-rendered options as authoritative
    // when the JS-side fetch produced no rows.
    //
    // Step 1: seed _voucherTypeList from the DOM when it's empty (covers
    // the non-admin case where /api/inventory_mgmt/voucher_types and
    // /api/gop/voucher_types both return [] but the SERVER prefetched
    // rows into the HTML).
    if (!_voucherTypeList.length){
      var seeded = [];
      for (var k = 0; k < sel.options.length; k++){
        var o = sel.options[k];
        if (!o.value) continue;  // skip the "— Default —" sentinel
        seeded.push({
          name:          o.value,
          abbreviation:  o.getAttribute('data-abbr') || '',
          mat_type_abbr: o.getAttribute('data-mat-type') || '',
          is_active:     true,
        });
      }
      if (seeded.length){
        _voucherTypeList = seeded;
        console.log('[GRN] voucher types seeded from server-rendered DOM:',
                    seeded.length, 'options');
        // Don't touch the select markup — server already rendered it.
        // Just sync the selection.
        if (currentTypeName){
          for (var j = 0; j < sel.options.length; j++){
            if (sel.options[j].value === currentTypeName){
              sel.selectedIndex = j; break;
            }
          }
        }
        // Auto-select if only one active option (same as fresh-build path)
        if (!currentTypeName && sel.options.length === 2) sel.selectedIndex = 1;
        voucherTypeChange();
        return;
      }
    }

    // Step 2: if STILL no types available (no DOM, no JS fetch result),
    // bail without wiping. Leaves the lone "— Default —" option intact.
    if (!_voucherTypeList.length){
      voucherTypeChange();
      return;
    }

    // Step 3: standard rebuild path (admin or any caller with real types).
    sel.innerHTML = '<option value="">— Default —</option>';
    _voucherTypeList.forEach(function(t){
      var opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name + (t.abbreviation ? ' (' + t.abbreviation + ')' : '');
      if (t.name === currentTypeName) opt.selected = true;
      sel.appendChild(opt);
    });
    // Match procurement: if creating a new GRN and there's exactly one
    // active type available, auto-select it so the user doesn't have to.
    if (!currentTypeName && sel.options.length === 2) sel.selectedIndex = 1;
    voucherTypeChange();
  }

  function voucherTypeChange(){
    var sel = document.getElementById('grnVoucherType');
    var typeName = sel ? sel.value : '';

    // Update preview number for new GRNs only
    if (!_grnEditId && typeName){
      var numEl = document.getElementById('grnFormNum');
      if (numEl && (numEl.textContent === 'Auto-assigned on save' || /\(preview\)/.test(numEl.textContent))){
        fetch('/api/inventory_mgmt/voucher_numbering/next?voucher_type=' + encodeURIComponent(typeName))
          .then(function(r){return r.json();})
          .then(function(d){
            if (d.status === 'ok' && numEl){
              var parts = [];
              if (d.prefix) parts.push(d.prefix);
              parts.push(String(d.next).padStart(d.digits||4,'0'));
              if (d.suffix) parts.push(d.suffix);
              numEl.textContent = parts.join('/') + ' (preview)';
            }
          })
          .catch(function(){});
      }
    }

    // Material-type filter for autocomplete
    var typeInfo = _voucherTypeList.find(function(t){ return t.name === typeName; });
    var matAbbr = typeInfo ? (typeInfo.mat_type_abbr || '').toUpperCase() : '';
    if (!matAbbr && typeInfo && typeInfo.abbreviation){
      var va = typeInfo.abbreviation.toUpperCase();
      if (va.indexOf('RM') === 0) matAbbr = 'RM';
      else if (va.indexOf('PM') === 0) matAbbr = 'PM';
      else if (va.indexOf('FG') === 0) matAbbr = 'FG';
    }
    if      (matAbbr === 'RM') _matGroupFilter = 'rm';
    else if (matAbbr === 'PM') _matGroupFilter = 'pm';
    else if (matAbbr === 'FG') _matGroupFilter = 'fg';
    else                       _matGroupFilter = null;
    refreshMaterialDatalist();
    populatePOSelect(null);
  }

  function populatePOSelect(selectedPoId){
    var sel = document.getElementById('grnPoSelect');
    if (!sel) return;
    var grnTypeSel = document.getElementById('grnVoucherType');
    var grnTypeName = grnTypeSel ? grnTypeSel.value : '';
    var grnTypeInfo = _voucherTypeList.find(function(t){ return t.name === grnTypeName; });
    var grnMatAbbr  = grnTypeInfo ? (grnTypeInfo.mat_type_abbr || '').toUpperCase() : '';

    // Symmetric mat-type match (mirrors procurement.js behavior). When no
    // GRN type is set, all open POs are eligible.
    var matched = (_poRows || []).filter(function(r){
      if (r.status === 'cancelled' || r.status === 'closed') return false;
      if (!grnTypeName) return true;
      var poTypeInfo = _poTypeList.find(function(t){ return t.name === (r.voucher_type_name||''); });
      var poMatAbbr = poTypeInfo ? (poTypeInfo.mat_type_abbr || '').toUpperCase() : '';
      return poMatAbbr === grnMatAbbr;
    });

    var opts = '<option value="">— Manual (no linked PO) —</option>';
    if (matched.length === 0 && grnTypeName){
      opts += '<option value="" disabled>— No open POs for ' + esc(grnTypeName) + ' —</option>';
    } else {
      matched.forEach(function(r){
        var selAttr = (String(r.id) === String(selectedPoId)) ? ' selected' : '';
        opts += '<option value="' + r.id + '"' + selAttr + '>' + esc(r.po_num) + ' – ' + esc(r.supplier_name||'') + '</option>';
      });
    }
    sel.innerHTML = opts;
  }

  function poChange(){
    var sel = document.getElementById('grnPoSelect');
    var poId = sel ? sel.value : '';
    if (!poId) return;
    var po = _poRows.find(function(r){ return String(r.id) === String(poId); });
    if (!po) return;
    setVal('grnSupplier', po.supplier_name || '');
    // Add to invoice list if not present
    var exists = _grnPoInvoices.find(function(inv){ return String(inv.po_id) === String(poId); });
    if (!exists){
      _grnPoInvoices.push({po_id: po.id, po_num: po.po_num || '', po_date: po.po_date || '', invoice_num:'', invoice_date:''});
      renderPoInvoices();
    }
    // Fetch full PO with pending qty
    fetch('/api/inventory_mgmt/po/get?id=' + poId)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message);
        var o = d.order;
        _grnLines = (o.items || []).map(function(i){
          var mr = matchMaterial(i.material);
          var poQty       = i.qty != null ? parseFloat(i.qty) : '';
          var pendingQty  = i.pending_qty  != null ? parseFloat(i.pending_qty)  : poQty;
          var alreadyRcvd = i.received_qty != null ? parseFloat(i.received_qty) : 0;
          return {
            material:     i.material || '',
            po_qty:       poQty,
            pending_qty:  pendingQty,
            already_rcvd: alreadyRcvd,
            received_qty: pendingQty,
            qty_per_pkg:  '',
            packages:     '',
            total_qty:    0,
            rate:         i.rate     != null ? parseFloat(i.rate)     : '',
            hsn_code:     i.hsn_code || (mr && mr.hsn_code) || '',
            gst_rate:     i.gst_rate != null ? parseFloat(i.gst_rate) : (mr && mr.gst_rate != null ? parseFloat(mr.gst_rate) : 0),
            location:'', invoice_num:'', invoice_date:'',
            batch_num:'', mfg_date:'', expiry_date:'', manufacturer:'',
            uom: (mr && mr.uom) || 'KG'
          };
        }).filter(function(line){
          return line.pending_qty === '' || line.pending_qty === null || parseFloat(line.pending_qty) > 0;
        });
        if (!_grnLines.length) _grnLines.push(emptyLine());
        renderLines();
        calcStatus();
        _toast('Items loaded from ' + o.po_num, 'success', 2500);
      })
      .catch(function(e){ _toast('Could not load PO: ' + e.message, 'error'); });
  }

  /* ══════════════════════ PO INVOICES TABLE ══════════════════════ */
  function renderPoInvoices(){
    var container = document.getElementById('grnPoInvoicesContainer');
    if (!container) return;
    if (!_grnPoInvoices.length){
      container.innerHTML = '<div style="padding:10px;color:var(--nb-text-muted);font-size:12px">No PO linked — select a PO above or add manually.</div>';
      return;
    }

    var html = '<table class="grn-poinv-tbl" style="table-layout:auto;width:100%">'
             + '<thead><tr>'
             + '<th style="width:auto">PO Number</th>'
             + '<th style="width:1%;white-space:nowrap">PO Date</th>'
             + '</tr></thead><tbody>';
    _grnPoInvoices.forEach(function(inv, i){
      var po = _poRows.find(function(r){ return String(r.id) === String(inv.po_id); });
      var poDate = po ? (po.po_date || '') : (inv.po_date || '');
      var isLinked = !!inv.po_id;
      // Every PO row gets a remove button now — linked or manual.
      // (Previously linked rows had no × when they were the only row.)
      var removeBtn = '<button class="grn-li-del"'
                    + ' onclick="invGrnRemoveInvoice(' + i + ')"'
                    + ' title="Remove this PO row"'
                    + ' style="margin-left:8px;vertical-align:middle">×</button>';
      var poNumCell = isLinked
        ? '<span style="font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--nb-primary);font-size:12.5px;vertical-align:middle">' + esc(inv.po_num||'') + '</span>' + removeBtn
        : '<input type="text" data-inv-idx="' + i + '" data-inv-field="po_num" value="' + esc(inv.po_num||'') + '" placeholder="PO Number (manual)" oninput="window.__invGrnInvFieldChange(' + i + ',\'po_num\',this.value)" style="vertical-align:middle;width:auto;min-width:160px">' + removeBtn;
      var poDateCell = isLinked
        ? '<span style="font-size:12px;color:var(--nb-text-muted)">' + fd(poDate) + '</span>'
        : '<input type="date" data-inv-idx="' + i + '" data-inv-field="po_date" value="' + esc(poDate) + '" onchange="window.__invGrnInvFieldChange(' + i + ',\'po_date\',this.value)">';
      html += '<tr>'
            + '<td>' + poNumCell + '</td>'
            + '<td>' + poDateCell + '</td>'
            + '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // Exposed via window for the inline oninput handlers above
  window.__invGrnInvFieldChange = function(idx, field, val){
    if (_grnPoInvoices[idx]) _grnPoInvoices[idx][field] = val;
  };

  function addManualInvoice(){
    _grnPoInvoices.push({po_id:null, po_num:'', po_date:'', invoice_num:'', invoice_date:''});
    renderPoInvoices();
    setTimeout(function(){
      var inputs = document.querySelectorAll('#grnPoInvoicesContainer input[data-inv-field="po_num"]');
      if (inputs.length) inputs[inputs.length-1].focus();
    }, 40);
  }

  function removeInvoice(idx){
    _grnPoInvoices.splice(idx, 1);
    renderPoInvoices();
    // Drop materials linked to that PO from lines? — match procurement: leave them.
  }

  /* ══════════════════════ LINE ITEMS ══════════════════════ */
  // NEW LAYOUT (May 2026):
  //   Each line renders as TWO <tr> rows:
  //     row 1 (main)  : #, Material, Pkgs × Qty/Pkg UOM, = Total, PO Qty, Rate, GST%, Amount, Location, ×
  //     row 2 (sub)   : Invoice No, Invoice Date, Batch No, Mfg Date, Expiry  (single colspan strip)
  //   Recd Qty column was removed — Total Qty (pkgs × qty/pkg) serves the
  //   same purpose. received_qty is still stored on the line object and
  //   kept in sync with total_qty for downstream save/calc compatibility.
  function renderLines(){
    var tb = document.getElementById('grnLinesTbody');
    if (!tb) return;
    if (!_grnLines.length){
      tb.innerHTML = '<tr><td colspan="13" style="padding:24px;text-align:center;color:var(--nb-text-muted);font-size:12px">No items — select a PO above or click "+ Add Item"</td></tr>';
      calcTotal();
      updateLineCount();
      return;
    }
    var defGd = _godowns.find(function(g){ return g.is_default; }) || _godowns[0] || null;
    var defGdName = defGd ? defGd.name : '';

    tb.innerHTML = _grnLines.map(function(line, i){
      // Make sure received_qty mirrors total_qty for any line that has a total.
      // This single source of truth removes the need for a separate Recd Qty input.
      var tot = parseFloat(line.total_qty) || 0;
      if (tot > 0) line.received_qty = String(tot);

      var rqty = parseFloat(line.received_qty) || 0;
      var rate = parseFloat(line.rate) || 0;
      var amt  = rqty * rate;
      var amtStr = amt > 0 ? fi(amt) : '—';

      // GST rate (auto from material master if not explicitly set on the line)
      var gstPct = line.gst_rate != null ? parseFloat(line.gst_rate) : 0;
      if ((!gstPct || gstPct === 0) && line.material){
        var mr = matchMaterial(line.material);
        if (mr && mr.gst_rate != null) gstPct = parseFloat(mr.gst_rate);
      }

      var isPO = line.po_qty !== '' && line.po_qty !== null;

      // Location dropdown options
      var locOpts = '<option value="">— Location —</option>'
        + _godowns.map(function(g){
            var isSel = (line.location && line.location === g.name) || (!line.location && g.name === defGdName);
            return '<option value="' + esc(g.name) + '"' + (isSel ? ' selected' : '') + '>' + esc(g.name) + '</option>';
          }).join('');

      // PO qty display + tooltip
      var pq          = isPO ? parseFloat(line.po_qty) : null;
      var pendingQty  = line.pending_qty  != null ? parseFloat(line.pending_qty)  : pq;
      var alreadyRcvd = line.already_rcvd != null ? parseFloat(line.already_rcvd) : 0;
      var hasPartial  = alreadyRcvd > 0;
      var displayQty  = pendingQty !== null && pendingQty !== '' ? pendingQty : pq;
      var poQtyTitle  = pq != null
        ? 'PO Qty: ' + pq + (hasPartial ? ' | Already received: ' + alreadyRcvd + ' | Pending: ' + pendingQty : '')
        : '';
      var poQtyExtra  = '';
      if (hasPartial) poQtyExtra = ';color:var(--nb-warning);border-color:rgba(217,119,6,.5);background:rgba(255,251,235,.7)';
      else if (pq === null) poQtyExtra = ';opacity:.5';

      var totalCell = (line.total_qty || rqty) > 0
        ? fnum(line.total_qty || rqty, 3)
        : '—';

      // ─── ROW 1: main item details ─────────────────────────────────
      // The leftmost cell normally shows the row number. When a TRS slip
      // has been generated for this line we replace it with a small
      // colour-coded badge so operators can see at a glance which items
      // have already been routed to QC for testing. The row number is
      // tucked into the badge as a tooltip prefix so it's still
      // recoverable.
      var trsBadge = '';
      if (line.trs_num){
        var st     = line.trs_status || 'Pending';
        // Map approval status → colour cue. Pending = teal (matches the
        // flask icon used on the Generate TRS menu item).
        var col    = (st === 'Approved') ? '#0e7490'    // teal-dark = ok
                   : (st === 'Rejected') ? '#b91c1c'    // red-dark
                   :                       '#0891b2';   // teal-mid = pending / under review
        var bg     = (st === 'Approved') ? 'rgba(8,145,178,.14)'
                   : (st === 'Rejected') ? 'rgba(185,28,28,.10)'
                   :                       'rgba(8,145,178,.10)';
        var ic     = (st === 'Approved') ? 'fa-check-circle'
                   : (st === 'Rejected') ? 'fa-times-circle'
                   :                       'fa-flask';
        trsBadge = '<div title="TRS ' + esc(line.trs_num) + ' · ' + esc(st) + '" '
                 + 'style="display:inline-flex;align-items:center;gap:4px;'
                 +        'padding:3px 7px;border-radius:999px;'
                 +        'background:' + bg + ';color:' + col + ';'
                 +        'font-size:9.5px;font-weight:700;letter-spacing:.3px;'
                 +        'white-space:nowrap;font-family:Inter,system-ui,sans-serif">'
                 + '<i class="fas ' + ic + '" style="font-size:9px"></i>'
                 + '<span>TRS</span>'
                 + '</div>'
                 + '<div style="font-size:9px;color:var(--nb-text-muted);'
                 +        'margin-top:2px;font-family:JetBrains Mono,monospace">'
                 + esc(line.trs_num)
                 + '</div>';
      }
      var firstCell = trsBadge
        ? '<td class="td-center" style="vertical-align:middle;line-height:1.2">' + trsBadge + '</td>'
        : '<td class="td-center muted-cell" style="vertical-align:middle">' + (i+1) + '</td>';

      var mainRow = '<tr data-gi="' + i + '" class="grn-row-main">'
        + firstCell
        + '<td><input class="grn-li-inp grn-mat-inp" list="grnMatList" data-gi="' + i + '" value="' + esc(line.material||'') + '" placeholder="Material…"' + (isPO ? ' readonly' : '') + '></td>'
        + '<td><input type="number" class="grn-li-inp grn-pkgs-inp mono" data-gi="' + i + '" value="' + esc(line.packages||'') + '" placeholder="—" min="1" step="1" title="No. of packages" style="text-align:center"></td>'
        + '<td class="td-center muted-cell" style="vertical-align:middle;font-weight:300">×</td>'
        + '<td><input type="number" class="grn-li-inp grn-qpp-inp mono" data-gi="' + i + '" value="' + esc(line.qty_per_pkg||'') + '" placeholder="0.000" min="0" step="0.001"></td>'
        + '<td class="td-center" style="vertical-align:middle"><span class="grn-uom-cell" data-gi="' + i + '" style="font-size:10.5px;font-weight:600;color:var(--nb-text-muted)">' + esc(line.uom||'KG') + '</span></td>'
        + '<td style="text-align:right;vertical-align:middle"><span class="grn-total-cell" data-gi="' + i + '" style="font-size:11.5px;font-weight:800;color:var(--nb-primary);font-family:\'JetBrains Mono\',monospace">' + totalCell + '</span></td>'
        + '<td><input type="number" class="grn-li-inp grn-poqty-inp mono" data-gi="' + i + '" value="' + (displayQty != null && displayQty !== '' ? displayQty : '') + '" readonly tabindex="-1"' + (poQtyTitle ? ' title="' + esc(poQtyTitle) + '"' : '') + ' style="' + poQtyExtra + '"></td>'
        + '<td><input type="number" class="grn-li-inp grn-rate-inp mono" data-gi="' + i + '" value="' + esc(line.rate||'') + '" placeholder="0.00" min="0" step="0.0001"></td>'
        + '<td class="td-center mono" style="vertical-align:middle;font-size:10.5px;color:' + (gstPct > 0 ? 'var(--nb-text)' : 'var(--nb-text-muted)') + '">' + (gstPct > 0 ? gstPct + '%' : '—') + '</td>'
        + '<td class="grn-amt-cell mono" style="text-align:right;vertical-align:middle;font-size:11.5px;font-weight:700;color:' + (amt > 0 ? 'var(--nb-text)' : 'var(--nb-text-muted)') + ';white-space:nowrap">' + amtStr + '</td>'
        + '<td><select class="grn-li-inp grn-loc-inp" data-gi="' + i + '">' + locOpts + '</select></td>'
        + '<td class="td-center" style="vertical-align:middle"><button class="grn-li-del" data-gi="' + i + '" title="Remove">×</button></td>'
        + '</tr>';

      // ─── ROW 2: invoice / batch / dates (sub-row) ─────────────────
      // COA cell: shows attached file (with view/remove) OR an Upload button.
      // Button is disabled until the line has a saved grn_item_id (i.e. the
      // GRN must be saved at least once first — we can't link a file to an
      // unsaved row).
      var coaChips = '';
      if (line.coa_files && line.coa_files.length){
        coaChips = line.coa_files.map(function(cf){
          return '<a class="grn-file-chip" target="_blank" '
                + 'href="/api/inventory_mgmt/grn/file/' + cf.id + '" '
                + 'title="' + esc(cf.original_name) + ' — click to view">'
                + '<i class="fas fa-paperclip"></i> '
                + esc(_trimName(cf.original_name, 18))
                + '<button class="grn-file-chip-del" onclick="event.preventDefault();event.stopPropagation();invGrnDeleteFile(' + cf.id + ',' + i + ');return false;" title="Remove file">×</button>'
                + '</a>';
        }).join('');
      }
      var coaCanUpload = !!line.grn_item_id;
      var coaBtnAttrs  = coaCanUpload
        ? 'onclick="invGrnPickCoaFile(' + i + ')"'
        : 'disabled title="Save the GRN first, then attach COA"';
      var coaUploadBtn = '<button type="button" class="grn-coa-upload-btn" ' + coaBtnAttrs + '>'
                       + '<i class="fas fa-cloud-upload-alt"></i> '
                       + (line.coa_files && line.coa_files.length ? 'Add more' : 'Upload COA')
                       + '</button>';

      var subRow = '<tr data-gi="' + i + '" class="grn-row-sub">'
        + '<td></td>'
        + '<td colspan="12" class="grn-sub-cell">'
        +   '<div class="grn-sub-strip">'
        +     '<span class="grn-sub-field">'
        +       '<label>Invoice No.</label>'
        +       '<input type="text" class="grn-li-inp grn-invnum-inp mono" data-gi="' + i + '" value="' + esc(line.invoice_num||'') + '" placeholder="INV#">'
        +     '</span>'
        +     '<span class="grn-sub-field">'
        +       '<label>Invoice Date</label>'
        +       '<input type="date" class="grn-li-inp grn-invdate-inp" data-gi="' + i + '" value="' + esc(line.invoice_date||'') + '">'
        +     '</span>'
        +     '<span class="grn-sub-field grn-sub-field-mfr">'
        +       '<label>Manufacturer <span style="color:var(--nb-danger)">*</span></label>'
        +       '<input type="text" class="grn-li-inp grn-mfr-inp" data-gi="' + i + '" value="' + esc(line.manufacturer||'') + '" placeholder="Manufacturer name">'
        +     '</span>'
        +     '<span class="grn-sub-field">'
        +       '<label>Batch No.</label>'
        +       '<input type="text" class="grn-li-inp grn-batch-inp mono" data-gi="' + i + '" value="' + esc(line.batch_num||'') + '" placeholder="Batch#">'
        +     '</span>'
        +     '<span class="grn-sub-field">'
        +       '<label>Mfg Date</label>'
        +       '<input type="date" class="grn-li-inp grn-mfg-inp" data-gi="' + i + '" value="' + esc(line.mfg_date||'') + '">'
        +     '</span>'
        +     '<span class="grn-sub-field">'
        +       '<label>Expiry</label>'
        +       '<input type="date" class="grn-li-inp grn-exp-inp" data-gi="' + i + '" value="' + esc(line.expiry_date||'') + '">'
        +     '</span>'
        +     '<span class="grn-sub-field grn-sub-field-coa">'
        +       '<label>COA</label>'
        +       '<span class="grn-coa-cell">' + coaChips + coaUploadBtn + '</span>'
        +     '</span>'
        +   '</div>'
        + '</td>'
        + '</tr>';

      return mainRow + subRow;
    }).join('');
    calcTotal();
    updateLineCount();
  }

  // Trim a long filename like "very_long_invoice_2026_05_13.pdf" to a chip-friendly form
  // by keeping the start + extension and inserting an ellipsis.
  function _trimName(name, maxLen){
    name = String(name || '');
    if (name.length <= maxLen) return name;
    var dot = name.lastIndexOf('.');
    var ext = dot > 0 ? name.slice(dot) : '';
    var stem = dot > 0 ? name.slice(0, dot) : name;
    if (ext.length >= maxLen - 2) return name.slice(0, maxLen - 1) + '…';
    var keep = Math.max(3, maxLen - ext.length - 1);
    return stem.slice(0, keep) + '…' + ext;
  }

  function updateLineCount(){
    var el = document.getElementById('grnLineCount');
    if (el) el.textContent = _grnLines.length + ' item' + (_grnLines.length !== 1 ? 's' : '');
  }

  function addLine(){
    // Guard: don't add a new line if the most recent line is still empty
    // (no material selected). Forces the user to fill in line N before
    // jumping to line N+1. Empty array is fine — the first line is allowed.
    if (_grnLines.length > 0){
      var last = _grnLines[_grnLines.length - 1];
      if (!last.material || !String(last.material).trim()){
        _toast('Fill in line ' + _grnLines.length + ' before adding a new one', 'warning');
        // Focus the empty material input so the user can start typing.
        var lastIdx = _grnLines.length - 1;
        var matInp = document.querySelector('#grnLinesTbody tr[data-gi="' + lastIdx + '"].grn-row-main .grn-mat-inp');
        if (matInp) matInp.focus();
        return;
      }
    }
    _grnLines.push(emptyLine());
    renderLines();
    var idx = _grnLines.length - 1;
    setTimeout(function(){
      var inp = document.querySelector('#grnLinesTbody tr[data-gi="' + idx + '"].grn-row-main .grn-mat-inp');
      if (inp) inp.focus();
    }, 40);
  }

  /* ══════════════════════════════════════════════════════════
     FILE ATTACHMENTS — COA (per line) + Invoice (per GRN)
  ══════════════════════════════════════════════════════════ */

  var _GRN_FILE_ACCEPT     = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';
  var _GRN_FILE_MAX_BYTES  = 10 * 1024 * 1024;   // 10 MB — mirror server cap

  // Common validate + upload routine.
  function _grnUploadFile(file, formExtras, onDone){
    if (!file){ return; }
    if (file.size > _GRN_FILE_MAX_BYTES){
      _toast('File too large: ' + (file.size/1024/1024).toFixed(1) + ' MB (max 10 MB)', 'error');
      return;
    }
    var mime = (file.type || '').toLowerCase();
    var okMime = ['application/pdf','image/jpeg','image/jpg','image/png'].indexOf(mime) !== -1;
    if (!okMime){
      _toast('Unsupported file type: ' + (mime || 'unknown') + ' (PDF/JPG/PNG only)', 'error');
      return;
    }
    var fd = new FormData();
    fd.append('file', file);
    Object.keys(formExtras||{}).forEach(function(k){
      if (formExtras[k] != null) fd.append(k, formExtras[k]);
    });
    fetch('/api/inventory_mgmt/grn/file/upload', { method: 'POST', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message || 'Upload failed');
        onDone && onDone(d.file);
      })
      .catch(function(e){
        _toast('Upload failed: ' + (e.message || e), 'error');
      });
  }

  // ── COA upload from a line's "Upload COA" button ────────────────
  function pickCoaFile(lineIdx){
    var line = _grnLines[lineIdx];
    if (!line){ return; }
    if (!_grnEditId){
      _toast('Save the GRN first, then attach a COA', 'warning');
      return;
    }
    if (!line.grn_item_id){
      _toast('Save the GRN first so this line gets an ID, then attach a COA', 'warning');
      return;
    }
    // Hidden file picker — single file at a time.
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = _GRN_FILE_ACCEPT;
    input.style.display = 'none';
    input.onchange = function(){
      var f = input.files && input.files[0];
      if (!f) return;
      _grnUploadFile(f, {
        kind:        'coa',
        grn_id:      _grnEditId,
        grn_item_id: line.grn_item_id,
      }, function(meta){
        if (!_grnLines[lineIdx]) return;
        _grnLines[lineIdx].coa_files = (_grnLines[lineIdx].coa_files || []).concat([meta]);
        _toast('COA attached', 'success');
        renderLines();
      });
      document.body.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  }

  // ── Delete a single file (COA or Invoice) by id ─────────────────
  function deleteFile(fileId, lineIdx){
    if (!confirm('Remove this attachment?')) return;
    fetch('/api/inventory_mgmt/grn/file/' + fileId, { method: 'DELETE' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message || 'Delete failed');
        // Remove from local state.
        // If we know which line it belongs to, scrub there; else search both line COAs and the invoice list.
        var removed = false;
        if (lineIdx != null && _grnLines[lineIdx]){
          var arr = _grnLines[lineIdx].coa_files || [];
          var n = arr.length;
          _grnLines[lineIdx].coa_files = arr.filter(function(f){ return f.id !== fileId; });
          if (_grnLines[lineIdx].coa_files.length !== n) removed = true;
        }
        if (!removed){
          for (var i=0; i<_grnLines.length; i++){
            var arr = _grnLines[i].coa_files || [];
            var n = arr.length;
            _grnLines[i].coa_files = arr.filter(function(f){ return f.id !== fileId; });
            if (_grnLines[i].coa_files.length !== n) { removed = true; break; }
          }
        }
        var n2 = _grnInvoiceFiles.length;
        _grnInvoiceFiles = _grnInvoiceFiles.filter(function(f){ return f.id !== fileId; });
        if (_grnInvoiceFiles.length !== n2) removed = true;

        renderLines();
        renderInvoiceFiles();
        _toast('Attachment removed', 'success');
      })
      .catch(function(e){ _toast('Delete failed: ' + e.message, 'error'); });
  }

  // ── Invoice file panel (GRN-level, multiple files) ──────────────
  function renderInvoiceFiles(){
    var listEl = document.getElementById('grnInvoicesList');
    var btnEl  = document.getElementById('grnInvoiceUploadBtn');
    var hintEl = document.getElementById('grnInvoiceHint');
    if (!listEl) return;
    if (!_grnInvoiceFiles.length){
      listEl.innerHTML = '<span class="grn-no-invoices">No invoice files attached yet.</span>';
    } else {
      listEl.innerHTML = _grnInvoiceFiles.map(function(f){
        var sizeKb = Math.round((f.size_bytes || 0) / 1024);
        var iconClass = (f.mime_type || '').indexOf('pdf') !== -1
          ? 'fa-file-pdf' : 'fa-file-image';
        return '<a class="grn-invoice-chip" target="_blank" '
              + 'href="/api/inventory_mgmt/grn/file/' + f.id + '" '
              + 'title="' + esc(f.original_name) + ' (' + sizeKb + ' KB)">'
              + '<i class="fas ' + iconClass + '"></i> '
              + esc(_trimName(f.original_name, 28))
              + ' <span class="grn-invoice-chip-size">' + sizeKb + ' KB</span>'
              + '<button class="grn-invoice-chip-del" onclick="event.preventDefault();event.stopPropagation();invGrnDeleteFile(' + f.id + ');return false;" title="Remove">×</button>'
              + '</a>';
      }).join('');
    }
    var canUpload = !!_grnEditId;
    if (btnEl){
      btnEl.disabled = !canUpload;
      btnEl.title = canUpload
        ? 'Attach an invoice PDF or image'
        : 'Save the GRN first, then attach invoices';
    }
    if (hintEl){
      hintEl.style.display = canUpload ? 'none' : '';
    }
  }

  function pickInvoiceFile(){
    if (!_grnEditId){
      _toast('Save the GRN first, then attach invoices', 'warning');
      return;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = _GRN_FILE_ACCEPT;
    input.multiple = true;   // allow selecting multiple invoices in one go
    input.style.display = 'none';
    input.onchange = function(){
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      var pending = files.length;
      files.forEach(function(f){
        _grnUploadFile(f, { kind: 'invoice', grn_id: _grnEditId }, function(meta){
          _grnInvoiceFiles.push(meta);
          pending -= 1;
          if (pending === 0){
            renderInvoiceFiles();
            _toast(files.length + ' invoice file' + (files.length>1?'s':'') + ' attached', 'success');
          }
        });
      });
      document.body.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  }

  function calcLineTotal(i){
    var pkgsEl  = document.querySelector('#grnLinesTbody tr[data-gi="' + i + '"].grn-row-main .grn-pkgs-inp');
    var qppEl   = document.querySelector('#grnLinesTbody tr[data-gi="' + i + '"].grn-row-main .grn-qpp-inp');
    var totalEl = document.querySelector('#grnLinesTbody tr[data-gi="' + i + '"].grn-row-main .grn-total-cell');
    if (!pkgsEl || !qppEl || !_grnLines[i]) return;
    var pkgs   = parseFloat(pkgsEl.value) || 0;
    var qtyPkg = parseFloat(qppEl.value)  || 0;
    var total  = pkgs * qtyPkg;
    _grnLines[i].packages    = pkgsEl.value;
    _grnLines[i].qty_per_pkg = qppEl.value;
    _grnLines[i].total_qty   = total;
    // Total Qty IS the received qty now — Recd Qty column was removed.
    _grnLines[i].received_qty = total > 0 ? String(total) : '';
    if (totalEl){
      totalEl.textContent = total > 0 ? fnum(total, 3) : '—';
      totalEl.style.color = total > 0 ? 'var(--nb-primary)' : 'var(--nb-text-muted)';
    }
    // Recompute line amount cell + grand totals.
    var aCell = document.querySelector('#grnLinesTbody tr[data-gi="' + i + '"].grn-row-main .grn-amt-cell');
    if (aCell){
      var rate = parseFloat(_grnLines[i].rate) || 0;
      var amt  = total * rate;
      aCell.textContent = amt > 0 ? fi(amt) : '—';
      aCell.style.color = amt > 0 ? 'var(--nb-text)' : 'var(--nb-text-muted)';
    }
    calcTotal();
  }

  function calcTotal(){
    var taxable = 0, cgstTotal = 0, sgstTotal = 0;
    _grnLines.forEach(function(l){
      var amt = (parseFloat(l.received_qty)||0) * (parseFloat(l.rate)||0);
      taxable += amt;
      if (amt > 0){
        var mr = matchMaterial(l.material);
        var gstPct = (l.gst_rate != null && parseFloat(l.gst_rate) > 0)
                       ? parseFloat(l.gst_rate)
                       : (mr && mr.gst_rate != null ? parseFloat(mr.gst_rate) : 0);
        if (gstPct > 0){
          var c = Math.round(amt * (gstPct/2) / 100 * 100) / 100;
          cgstTotal += c; sgstTotal += c;
        }
      }
    });
    var fe = document.getElementById('grnFreightAmt');
    var pe = document.getElementById('grnPackingAmt');
    var oe = document.getElementById('grnOtherAmt');
    var freight = (fe && !fe.disabled) ? (parseFloat(fe.value)||0) : 0;
    var packing = (pe && !pe.disabled) ? (parseFloat(pe.value)||0) : 0;
    var other   = (oe && !oe.disabled) ? (parseFloat(oe.value)||0) : 0;
    var chargesTotal = freight + packing + other;
    taxable += chargesTotal;
    // Charges (freight/packing/other) are taxable at 18% GST → split CGST/SGST.
    if (chargesTotal > 0){
      var chargeGstHalf = Math.round(chargesTotal * (18/2) / 100 * 100) / 100;
      cgstTotal += chargeGstHalf;
      sgstTotal += chargeGstHalf;
    }
    var grand = taxable + cgstTotal + sgstTotal;
    var sv = function(id, txt){ var e=document.getElementById(id); if (e) e.textContent = txt; };
    var sd = function(id, show){ var e=document.getElementById(id); if (e) e.style.display = show ? '' : 'none'; };
    sv('grnFootTaxable', taxable > 0 ? fi(taxable) : '—');
    sv('grnFootCGST',    cgstTotal > 0 ? fi(cgstTotal) : '—');
    sv('grnFootSGST',    sgstTotal > 0 ? fi(sgstTotal) : '—');
    sv('grnGrandTotal',  grand > 0 ? fi(grand) : '—');
    sd('grnFootRowCGST', cgstTotal > 0);
    sd('grnFootRowSGST', sgstTotal > 0);
    calcStatus();
  }

  function calcStatus(){
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    var status = 'open';
    var sel = document.getElementById('grnPoSelect');
    if (sel && sel.value){
      var po = _poRows.find(function(r){ return String(r.id) === String(sel.value); });
      if (po && po.status === 'cancelled') status = 'cancelled';
    }
    if (status !== 'cancelled' && validLines.length){
      var anyReceived = validLines.some(function(l){ return parseFloat(l.received_qty||0) > 0; });
      if (!anyReceived) {
        status = 'open';
      } else {
        var allFull = validLines.every(function(l){
          var rq = parseFloat(l.received_qty||0);
          var pq = parseFloat(l.po_qty||0);
          if (!pq) return rq > 0;
          return rq >= pq - 0.001;
        });
        status = allFull ? 'received' : 'partial';
      }
    }
    _grnAutoStatus = status;
  }

  function toggleCharge(type){
    var key = ({freight:'Freight', packing:'Packing', other:'Other'})[type] || type;
    var cb  = document.getElementById('grn' + key + 'Enabled');
    var inp = document.getElementById('grn' + key + 'Amt');
    if (!cb || !inp) return;
    inp.disabled = !cb.checked;
    inp.style.opacity = cb.checked ? '1' : '.5';
    // For "Other" there's an additional free-text label input that needs to be
    // enabled/disabled in sync with the amount.
    if (type === 'other'){
      var lbl = document.getElementById('grnOtherLabel');
      if (lbl){
        lbl.disabled = !cb.checked;
        lbl.style.opacity = cb.checked ? '1' : '.5';
        if (!cb.checked) lbl.value = '';
      }
    }
    if (cb.checked) inp.focus();
    else inp.value = '';
    calcTotal();
  }

  function setCharge(type, val, label){
    var key = ({freight:'Freight', packing:'Packing', other:'Other'})[type] || type;
    var cb  = document.getElementById('grn' + key + 'Enabled');
    var inp = document.getElementById('grn' + key + 'Amt');
    if (!cb || !inp) return;
    var v = val ? parseFloat(val) : 0;
    if (v > 0){
      cb.checked = true; inp.disabled = false; inp.style.opacity = '1';
      inp.value = v.toFixed(2);
    } else {
      cb.checked = false; inp.disabled = true; inp.style.opacity = '.5'; inp.value = '';
    }
    // Apply label for "Other"
    if (type === 'other'){
      var lblEl = document.getElementById('grnOtherLabel');
      if (lblEl){
        if (v > 0){
          lblEl.disabled = false; lblEl.style.opacity = '1';
          lblEl.value = label || '';
        } else {
          lblEl.disabled = true; lblEl.style.opacity = '.5'; lblEl.value = '';
        }
      }
    }
  }

  /* ══════════════════════ EVENT DELEGATION ══════════════════════ */
  // Single document-level listeners so they survive table re-renders.
  document.addEventListener('input', function(e){
    var inp = e.target;
    if (!inp.classList || !inp.classList.contains('grn-li-inp')) return;
    var idx = parseInt(inp.dataset.gi);
    if (isNaN(idx) || !_grnLines[idx]) return;
    if (inp.classList.contains('grn-pkgs-inp')) { _grnLines[idx].packages = inp.value; calcLineTotal(idx); return; }
    if (inp.classList.contains('grn-qpp-inp'))  { _grnLines[idx].qty_per_pkg = inp.value; calcLineTotal(idx); return; }
    if (inp.classList.contains('grn-mat-inp')) {
      _grnLines[idx].material = inp.value;
      var mr = matchMaterial(inp.value);
      if (mr && mr.uom){
        _grnLines[idx].uom = mr.uom;
        var uomCell = document.querySelector('#grnLinesTbody tr[data-gi="' + idx + '"].grn-row-main .grn-uom-cell');
        if (uomCell) uomCell.textContent = mr.uom;
      }
      if (mr && mr.gst_rate != null) _grnLines[idx].gst_rate = parseFloat(mr.gst_rate);
      if (mr && mr.hsn_code) _grnLines[idx].hsn_code = mr.hsn_code;
    }
    if (inp.classList.contains('grn-rate-inp'))   _grnLines[idx].rate         = inp.value;
    if (inp.classList.contains('grn-invnum-inp')) _grnLines[idx].invoice_num  = inp.value;
    if (inp.classList.contains('grn-batch-inp'))  _grnLines[idx].batch_num    = inp.value;

    if (inp.classList.contains('grn-rate-inp')) {
      var qty = parseFloat(_grnLines[idx].received_qty)||0;
      var rt  = parseFloat(_grnLines[idx].rate)||0;
      var amt = qty * rt;
      // Two <tr>'s share data-gi=idx now (main + sub). Target main row only.
      var aCell = document.querySelector('#grnLinesTbody tr[data-gi="' + idx + '"].grn-row-main .grn-amt-cell');
      if (aCell){
        aCell.textContent = amt > 0 ? fi(amt) : '—';
        aCell.style.color = amt > 0 ? 'var(--nb-text)' : 'var(--nb-text-muted)';
      }
      calcTotal();
    }
  });

  document.addEventListener('change', function(e){
    var inp = e.target;
    if (!inp.classList || !inp.classList.contains('grn-li-inp')) return;
    var idx = parseInt(inp.dataset.gi);
    if (isNaN(idx) || !_grnLines[idx]) return;
    if (inp.classList.contains('grn-loc-inp'))     _grnLines[idx].location     = inp.value;
    if (inp.classList.contains('grn-invdate-inp')) _grnLines[idx].invoice_date = inp.value;
    if (inp.classList.contains('grn-mfg-inp'))     _grnLines[idx].mfg_date     = inp.value;
    if (inp.classList.contains('grn-exp-inp'))     _grnLines[idx].expiry_date  = inp.value;
    if (inp.classList.contains('grn-mfr-inp'))     _grnLines[idx].manufacturer = inp.value;
  });

  document.addEventListener('click', function(e){
    var btn = e.target.closest('.grn-li-del');
    if (!btn || !document.getElementById('grnLinesTbody').contains(btn)) return;
    var idx = parseInt(btn.dataset.gi);
    if (isNaN(idx)) return;
    _grnLines.splice(idx, 1);
    if (!_grnLines.length) _grnLines.push(emptyLine());
    renderLines();
  });

  /* ══════════════════════ SAVE ══════════════════════ */
  function save(){
    var supplier = (getVal('grnSupplier')||'').trim();
    if (!supplier){ _toast('Supplier name is required', 'error'); return; }
    var supervisor = (getVal('grnSupervisor')||'').trim();
    if (!supervisor){ _toast('Supervisor name is required', 'error'); return; }
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    if (!validLines.length){ _toast('Add at least one line item', 'error'); return; }
    // Manufacturer required on every line item
    var missingMfr = validLines.filter(function(l){ return !(l.manufacturer && l.manufacturer.trim()); });
    if (missingMfr.length){
      _toast('Manufacturer is required on every item (missing on ' + missingMfr.length + ' line' + (missingMfr.length===1?'':'s') + ')', 'error');
      return;
    }

    var fe  = document.getElementById('grnFreightAmt');
    var pe  = document.getElementById('grnPackingAmt');
    var oe  = document.getElementById('grnOtherAmt');
    var ol  = document.getElementById('grnOtherLabel');
    var sel = document.getElementById('grnPoSelect');

    var defGd = _godowns.find(function(g){ return g.is_default; }) || _godowns[0];
    var defLoc = defGd ? defGd.name : '';

    var payload = {
      id:             _grnEditId || null,
      supplier_name:  supplier,
      supervisor_name: supervisor,
      grn_date:       getVal('grnDate') || '',
      invoice_num:    (_grnPoInvoices.length === 1 ? (_grnPoInvoices[0].invoice_num||'') : ''),
      invoice_date:   (_grnPoInvoices.length === 1 ? (_grnPoInvoices[0].invoice_date||'') : ''),
      po_invoices:    _grnPoInvoices.filter(function(inv){ return inv.po_id || inv.invoice_num || inv.po_num; }),
      po_id:          sel && sel.value ? parseInt(sel.value) : (_grnPoInvoices.length === 1 && _grnPoInvoices[0].po_id ? _grnPoInvoices[0].po_id : null),
      po_num:         (function(){
        if (sel && sel.value){
          var po = _poRows.find(function(r){ return String(r.id) === String(sel.value); });
          return po ? po.po_num : '';
        }
        return _grnPoInvoices.length === 1 ? (_grnPoInvoices[0].po_num||'') : '';
      })(),
      voucher_type_name: getVal('grnVoucherType') || null,
      status:         _grnAutoStatus || 'open',
      remarks:        getVal('grnRemarks') || '',
      unload_location: defLoc,
      freight_charge: (fe && !fe.disabled && fe.value) ? parseFloat(fe.value) || null : null,
      packing_charge: (pe && !pe.disabled && pe.value) ? parseFloat(pe.value) || null : null,
      other_charge:   (oe && !oe.disabled && oe.value) ? parseFloat(oe.value) || null : null,
      other_charge_label: (ol && !ol.disabled && ol.value) ? (ol.value || '').trim().slice(0,60) : null,
      other_details:    _grnOtherDetails || {},
      unload_checklist: _grnChecklist    || {},
      items: validLines.map(function(l){
        return {
          material:     l.material.trim(),
          po_qty:       parseFloat(l.po_qty)       || 0,
          received_qty: parseFloat(l.total_qty || l.received_qty) || 0,
          qty_per_pkg:  parseFloat(l.qty_per_pkg)  || 0,
          packages:     l.packages ? parseInt(l.packages) : null,
          rate:         parseFloat(l.rate)         || 0,
          hsn_code:     l.hsn_code     || '',
          gst_rate:     l.gst_rate     || 0,
          location:     l.location || defLoc,
          invoice_num:  l.invoice_num  || '',
          invoice_date: l.invoice_date || '',
          batch_num:    l.batch_num    || '',
          mfg_date:     l.mfg_date     || '',
          expiry_date:  l.expiry_date  || '',
          manufacturer: (l.manufacturer || '').trim(),
          uom:          l.uom || 'KG'
        };
      })
    };

    var _doSave = function(){
    var btn = document.getElementById('grnSaveBtn');
    if (btn){ btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    fetch('/api/inventory_mgmt/grn/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.status !== 'ok') throw new Error(d.message || 'Save failed');
      if (!_grnEditId) _toast('✅ GRN Saved — ' + d.grn_num, 'success', 5000);
      else             _toast('GRN updated', 'success');
      closeForm();
    })
    .catch(function(e){
      _toast('Save failed: ' + e.message, 'error');
      if (btn){ btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save GRN'; }
    });
    }; // end _doSave

    // ── Two-level near-expiry warning ──────────────────────────────────
    // Scan every line's expiry; if any is within 2 months (or already past),
    // require the user to clear two confirmations before saving the GRN.
    if (typeof window.invExpiryGuard === 'function'){
      var _expItems = validLines.map(function(l){
        return { expiry_date: l.expiry_date || '', label: (l.material||'').trim() };
      });
      window.invExpiryGuard(_expItems, _doSave, { context: 'GRN' });
    } else {
      _doSave();
    }
  }

  function deleteCurrent(){
    if (!_grnEditId) return;
    var grn = _grnRows.find(function(r){ return r.id === _grnEditId; });
    if (!confirm('Delete GRN ' + (grn ? grn.grn_num : 'this GRN') + '?\nThis cannot be undone — the received stock will be reversed.')) return;
    fetch('/api/inventory_mgmt/grn/delete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({id: _grnEditId})
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.status !== 'ok') throw new Error(d.message || 'Delete failed');
      _toast('GRN deleted', 'success');
      closeForm();
    })
    .catch(function(e){ _toast('Delete failed: ' + e.message, 'error'); });
  }

  /* ══════════════════════ PRINT ══════════════════════ */
  function buildPrintHTML(){
    var grn_num  = (document.getElementById('grnFormNum').textContent || '—').trim();
    var grn_date = getVal('grnDate');
    var supplier = (getVal('grnSupplier')||'').trim() || '—';
    var remarks  = (getVal('grnRemarks')||'').trim();
    var fe = document.getElementById('grnFreightAmt');
    var pe = document.getElementById('grnPackingAmt');
    var oe = document.getElementById('grnOtherAmt');
    var ol = document.getElementById('grnOtherLabel');
    var freightVal = (fe && !fe.disabled && fe.value) ? parseFloat(fe.value)||0 : 0;
    var packingVal = (pe && !pe.disabled && pe.value) ? parseFloat(pe.value)||0 : 0;
    var otherVal   = (oe && !oe.disabled && oe.value) ? parseFloat(oe.value)||0 : 0;
    var otherLabel = (ol && !ol.disabled && ol.value) ? (ol.value||'').trim() : '';

    var poInvoices = (_grnPoInvoices||[]).filter(function(inv){ return inv.invoice_num || inv.po_num; });
    var sup = (_supRows||[]).find(function(s){ return (s.supplier_name||'').toLowerCase() === supplier.toLowerCase(); }) || {};
    var validLines = _grnLines.filter(function(l){ return l.material && l.material.trim(); });
    if (!validLines.length){ _toast('No items to print', 'error'); return null; }

    var total = 0, cgstTotal = 0, sgstTotal = 0;
    var lineData = validLines.map(function(l){
      var rqty = parseFloat(l.received_qty)||0;
      var pqty = parseFloat(l.po_qty)||0;
      var rate = parseFloat(l.rate)||0;
      var amt  = rqty * rate;
      total += amt;
      var mr = matchMaterial(l.material);
      var gstPct = l.gst_rate != null && parseFloat(l.gst_rate) > 0
        ? parseFloat(l.gst_rate)
        : (mr && mr.gst_rate != null ? parseFloat(mr.gst_rate) : 0);
      var cgst = (gstPct > 0 && amt > 0) ? Math.round(amt*(gstPct/2)/100*100)/100 : 0;
      return {
        material: l.material, rqty:rqty, pqty:pqty, rate:rate, amt:amt,
        gstPct:gstPct, cgst:cgst, sgst:cgst,
        hsnCode: l.hsn_code || (mr && mr.hsn_code) || '',
        location: l.location || '',
        invoice_num: l.invoice_num || '',
        invoice_date: l.invoice_date || '',
        batch_num: l.batch_num || '',
        mfg_date: l.mfg_date || '',
        expiry_date: l.expiry_date || '',
        manufacturer: l.manufacturer || '',
        packages: l.packages ? parseInt(l.packages) : null,
        qty_per_pkg: (l.qty_per_pkg != null && l.qty_per_pkg !== '') ? parseFloat(l.qty_per_pkg) : null,
        uom: l.uom || 'KG'
      };
    });
    cgstTotal = lineData.reduce(function(s,r){ return s + r.cgst; }, 0);
    sgstTotal = cgstTotal;
    var chargesTotal = freightVal + packingVal + otherVal;
    // Charges are taxable at 18% GST → add to CGST/SGST (matches live footer).
    if (chargesTotal > 0){
      var chargeGstHalf = Math.round(chargesTotal * (18/2) / 100 * 100) / 100;
      cgstTotal += chargeGstHalf;
      sgstTotal += chargeGstHalf;
    }
    var taxable    = total + chargesTotal;
    var grandTotal = taxable + cgstTotal + sgstTotal;

    function numToWords(n){
      if (!n || n === 0) return 'Zero';
      var ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
      var tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
      function h(n){
        if(n<20) return ones[n];
        if(n<100) return tens[Math.floor(n/10)] + (ones[n%10] ? ' ' + ones[n%10] : '');
        return ones[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' ' + h(n%100) : '');
      }
      n = Math.round(n);
      if (n>=10000000) return h(Math.floor(n/10000000)) + ' Crore'  + (n%10000000?' '+numToWords(n%10000000):'');
      if (n>=100000)   return h(Math.floor(n/100000))   + ' Lakh'   + (n%100000  ?' '+numToWords(n%100000)  :'');
      if (n>=1000)     return h(Math.floor(n/1000))     + ' Thousand'+(n%1000   ?' '+numToWords(n%1000)    :'');
      return h(n);
    }
    var grandWords = 'INR ' + numToWords(Math.floor(grandTotal)) + ' Only';

    var itemRows = lineData.map(function(r, i){
      var fRqty = r.rqty > 0 ? r.rqty.toLocaleString('en-IN', {minimumFractionDigits:3,maximumFractionDigits:3}) + ' ' + r.uom : '—';

      // Per-line packaging cells — used in the dedicated columns now.
      var fBoxes = (r.packages && r.packages > 0)
        ? String(r.packages)
        : '—';
      var fPerBox = (r.qty_per_pkg != null && r.qty_per_pkg > 0)
        ? r.qty_per_pkg.toLocaleString('en-IN', {minimumFractionDigits:3, maximumFractionDigits:3}) + ' ' + r.uom
        : '—';

      var sub = [];
      if (r.hsnCode)     sub.push('HSN: ' + esc(r.hsnCode));
      if (r.invoice_num) sub.push('Inv: <strong>' + esc(r.invoice_num) + '</strong>' + (r.invoice_date ? ' (' + fd(r.invoice_date) + ')' : ''));
      if (r.batch_num)   sub.push('Batch: <strong>' + esc(r.batch_num) + '</strong>');
      if (r.mfg_date)    sub.push('Mfg: ' + fd(r.mfg_date));
      if (r.expiry_date) sub.push('Exp: ' + fd(r.expiry_date));
      if (r.manufacturer) sub.push('Mfr: <strong>' + esc(r.manufacturer) + '</strong>');
      if (r.location)    sub.push('📍 ' + esc(r.location));
      var subLine = sub.length ? '<br><span style="font-size:10px;color:#555">' + sub.join(' &nbsp;|&nbsp; ') + '</span>' : '';
      return '<tr class="item-row">'
        + '<td class="ctr">' + (i+1) + '</td>'
        + '<td class="tl"><strong>' + esc(r.material) + '</strong>' + subLine + '</td>'
        + '<td class="rr">' + fBoxes + '</td>'
        + '<td class="rr">' + fPerBox + '</td>'
        + '<td class="rr">' + fRqty + '</td>'
        + '<td class="rr">' + (r.rate > 0 ? fi(r.rate) : '—') + '</td>'
        + '<td class="rr">' + (r.amt  > 0 ? fi(r.amt)  : '—') + '</td>'
        + '</tr>';
    }).join('');
    if (freightVal > 0) itemRows += '<tr class="item-row" style="background:var(--nb-bg)"><td class="ctr">—</td><td class="tl" style="font-style:italic;color:var(--nb-text-muted)">Freight Charges</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">' + fi(freightVal) + '</td></tr>';
    if (packingVal > 0) itemRows += '<tr class="item-row" style="background:var(--nb-bg)"><td class="ctr">—</td><td class="tl" style="font-style:italic;color:var(--nb-text-muted)">Packing Charges</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">' + fi(packingVal) + '</td></tr>';
    if (otherVal > 0)   itemRows += '<tr class="item-row" style="background:var(--nb-bg)"><td class="ctr">—</td><td class="tl" style="font-style:italic;color:var(--nb-text-muted)">' + esc(otherLabel || 'Other Charges') + '</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">—</td><td class="rr">' + fi(otherVal) + '</td></tr>';

    var invoiceRowsHTML = poInvoices.map(function(inv){
      var po = _poRows.find(function(r){ return String(r.id) === String(inv.po_id); });
      var poDate = po ? (po.po_date||'') : (inv.po_date||'');
      return '<tr>'
        + '<td style="padding:5px 8px;font-size:12px;font-weight:700;color:var(--nb-primary);font-family:monospace">' + esc(inv.po_num||'—') + '</td>'
        + '<td style="padding:5px 8px;font-size:12px;color:#444">' + fd(poDate) + '</td>'
        + '</tr>';
    }).join('');

    var supLines = ['<strong>' + esc(supplier) + '</strong>'];
    if (sup.address)        supLines.push(esc(sup.address));
    if (sup.gst_number)     supLines.push('GSTIN: <strong>' + esc(sup.gst_number) + '</strong>');
    if (sup.contact_person) supLines.push('Contact: ' + esc(sup.contact_person) + (sup.phone ? ' | ' + esc(sup.phone) : ''));
    if (sup.email)          supLines.push('E-Mail: ' + esc(sup.email));

    var CSS = '*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      +'body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;background:#FFFFFF;padding:20px 28px}'
      +'.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #137333;padding-bottom:8px;margin-bottom:0}'
      +'.co{font-size:23px;font-weight:900;color:#137333}'
      +'.cosub{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px}'
      +'.pnum{font-size:15px;font-weight:800;font-family:monospace;text-align:right;color:#137333}'
      +'.pdate{font-size:12px;font-weight:600;font-family:monospace;text-align:right;color:#555;margin-top:2px}'
      +'.bar{display:grid;border:1px solid #ccc;border-top:none}'
      +'.bar3{grid-template-columns:1fr 1fr 1fr}'
      +'.bc{padding:5px 9px;border-right:1px solid #ccc}.bc:last-child{border-right:none}'
      +'.bl{font-size:9px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:1px}'
      +'.bv{font-size:12.5px;font-weight:600}'
      +'.adg{display:grid;grid-template-columns:1fr 1fr;border:1px solid #ccc;border-top:none}'
      +'.ab{padding:8px 10px;border-right:1px solid #ccc;font-size:12px;line-height:1.65}'
      +'.ab:last-child{border-right:none}'
      +'.al{font-size:9px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px;padding-bottom:3px;border-bottom:1px solid #eee}'
      +'table{width:100%;border-collapse:collapse}'
      +'thead tr{background:#137333}'
      +'th{color:#FFFFFF;padding:7px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-right:1px solid rgba(255,255,255,.2);text-align:right}'
      +'th:first-child{text-align:center}th:nth-child(2){text-align:left}th:last-child{border-right:none}'
      +'tbody tr.item-row{border-bottom:1px solid #ddd}'
      +'tbody tr.item-row:nth-child(odd){background:#FAF9F5}'
      +'td{padding:7px 8px;font-size:12.5px;vertical-align:top;border-right:1px solid #eee}'
      +'td:last-child{border-right:none}'
      +'.ctr{text-align:center;color:#888;width:22px}'
      +'.tl{text-align:left}'
      +'.rr{text-align:right;font-family:monospace}'
      +'.ftrow td{padding:5px 8px;border-right:1px solid #eee;font-size:12px}'
      +'.ftrow td:last-child{border-right:none}'
      +'.ftrow-total td{font-weight:800;font-size:14px;background:#E6F4EA;border-top:2px solid #137333}'
      +'.amt-words{border:1px solid #ccc;border-top:none;padding:7px 10px;font-size:12px}'
      +'.sig{display:grid;grid-template-columns:1fr 1fr;border:1px solid #ccc;border-top:none}'
      +'.sb{padding:9px 10px;border-right:1px solid #ccc;min-height:48px}.sb:last-child{border-right:none;text-align:right}'
      +'.sl{font-size:9px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}'
      +'.footer{text-align:center;font-size:10px;color:#80868B;margin-top:6px;border-top:1px solid #eee;padding-top:5px}'
      +'@media print{body{padding:8px 14px}button{display:none!important}}';

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(grn_num) + '</title>'
      +'<style>' + CSS + '</style></head><body>'
      +'<div class="hdr">'
      +'<div><div class="co">Goods Receipt Note</div><div class="cosub">HCP WELLNESS PVT LTD</div></div>'
      +'<div style="text-align:right"><div class="pnum">' + esc(grn_num) + '</div><div class="pdate">' + fd(grn_date) + '</div></div>'
      +'</div>'
      +'<div class="adg">'
      +'<div class="ab"><div class="al">Supplier Details</div>' + supLines.join('<br>') + '</div>'
      +'<div class="ab"><div class="al">Linked PO Details</div>'
      + (invoiceRowsHTML
          ? '<table style="width:100%;border-collapse:collapse;margin-top:2px">'
            +'<thead><tr style="background:var(--nb-bg)"><th style="padding:4px 8px;text-align:left;font-size:10px;color:#666;font-weight:700">PO NUMBER</th><th style="padding:4px 8px;text-align:left;font-size:10px;color:#666;font-weight:700">PO DATE</th></tr></thead>'
            +'<tbody>' + invoiceRowsHTML + '</tbody></table>'
          : '<span style="color:#999;font-size:10px">—</span>')
      +'</div>'
      +'</div>'
      +'<table><thead><tr>'
      +'<th style="width:22px;text-align:center">Sl</th>'
      +'<th style="text-align:left">Material Description &amp; Details</th>'
      +'<th style="width:70px">No. of Boxes</th>'
      +'<th style="width:90px">Qty per Box</th>'
      +'<th style="width:95px">Total Qty</th>'
      +'<th style="width:80px">Rate (\u20B9)</th>'
      +'<th style="width:95px">Amount (\u20B9)</th>'
      +'</tr></thead>'
      +'<tbody>' + itemRows + '</tbody>'
      +'<tfoot>'
      +'<tr class="ftrow"><td colspan="6" style="text-align:right;color:#555">Taxable Amount</td><td class="rr">' + fi(taxable) + '</td></tr>'
      + (cgstTotal > 0 ? '<tr class="ftrow"><td colspan="6" style="text-align:right;color:#555">CGST</td><td class="rr">' + fi(cgstTotal) + '</td></tr>' : '')
      + (sgstTotal > 0 ? '<tr class="ftrow"><td colspan="6" style="text-align:right;color:#555">SGST</td><td class="rr">' + fi(sgstTotal) + '</td></tr>' : '')
      +'<tr class="ftrow-total"><td colspan="6" style="text-align:right;text-transform:uppercase;letter-spacing:.5px">Grand Total</td><td class="rr" style="font-size:15px">' + fi(grandTotal) + '</td></tr>'
      +'</tfoot></table>'
      +'<div class="amt-words"><strong>Amount in Words:</strong>&nbsp; ' + esc(grandWords) + '</div>'
      + (remarks ? '<div style="border:1px solid #ccc;border-top:none;padding:5px 9px;font-size:12px;color:#555"><strong>Remarks:</strong> ' + esc(remarks) + '</div>' : '')
      +'<div class="sig">'
      +'<div class="sb"><div class="sl">Received By (Store)</div><div style="margin-top:28px;font-size:11px;color:#888">Name &amp; Signature</div></div>'
      +'<div class="sb"><div class="sl">Authorised By</div><div style="margin-top:28px;font-size:11px;color:#888">for HCP Wellness Pvt Ltd</div></div>'
      +'</div>'
      +'<div class="footer">SUBJECT TO AHMEDABAD JURISDICTION &nbsp;|&nbsp; This is a Computer Generated Document</div>'
      +'</body></html>';
  }

  function printGrn(){
    var html = buildPrintHTML();
    if (!html) return;
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win){ _toast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.onload = function(){ win.focus(); win.print(); };
  }

  /* ══════════════════════ TINY DOM HELPERS ══════════════════════ */
  function getVal(id){ var e = document.getElementById(id); return e ? e.value : ''; }
  function setVal(id, v){ var e = document.getElementById(id); if (e) e.value = (v==null?'':v); }

  /* ══════════════════════════════════════════════════════════════════
     NEW (May 2026) — supplier-filtered PO picker, print-with-PO,
     label print modal, supplier-typed PO picker UI.
  ══════════════════════════════════════════════════════════════════ */

  // ─── Supplier-filtered, typeable PO picker ───────────────────────
  // Replaces the static <select id="grnPoSelect">. The user types into
  // #grnPoSelectFilter, we show a dropdown of POs that match BOTH the
  // typed query AND the currently-entered supplier.
  function _grnCurrentSupplier(){
    return (getVal('grnSupplier') || '').trim().toLowerCase();
  }

  function _grnPoMatches(po, q){
    if (po.status === 'cancelled' || po.status === 'closed') return false;
    var sup = _grnCurrentSupplier();
    if (sup && (po.supplier_name || '').toLowerCase() !== sup) return false;
    if (!q) return true;
    var ql = q.toLowerCase();
    return (po.po_num || '').toLowerCase().indexOf(ql) !== -1
        || (po.supplier_name || '').toLowerCase().indexOf(ql) !== -1;
  }

  function _grnRenderPoPicker(q){
    var list = document.getElementById('grnPoPickerList');
    if (!list) return;
    var matches = (_poRows || []).filter(function(p){ return _grnPoMatches(p, q); });

    // Drop POs already linked to this GRN to prevent dupes
    var linkedIds = (_grnPoInvoices || []).map(function(inv){ return String(inv.po_id||''); });
    matches = matches.filter(function(p){ return linkedIds.indexOf(String(p.id)) === -1; });

    if (!matches.length){
      var sup = _grnCurrentSupplier();
      list.innerHTML = '<div class="grn-po-picker-empty">'
        + (sup
            ? 'No open POs for this supplier'
            : 'Pick a supplier first (or type to search across all suppliers)')
        + '</div>';
      return;
    }

    list.innerHTML = matches.slice(0, 30).map(function(p){
      return '<div class="grn-po-picker-item" data-po-id="' + p.id + '"'
           + ' onmousedown="window.__invGrnPoPickerSelect(' + p.id + ')">'
           + '<span class="po-num">' + esc(p.po_num || '') + '</span>'
           + '<span class="po-date">' + esc(fd(p.po_date)) + '</span>'
           + '</div>';
    }).join('');
  }

  function poPickerInput(){
    var inp = document.getElementById('grnPoSelectFilter');
    if (!inp) return;
    _grnRenderPoPicker(inp.value.trim());
    document.getElementById('grnPoPickerList').style.display = 'block';
  }

  function poPickerFocus(){
    var inp = document.getElementById('grnPoSelectFilter');
    if (!inp) return;
    _grnRenderPoPicker(inp.value.trim());
    document.getElementById('grnPoPickerList').style.display = 'block';
  }

  function poPickerBlur(){
    // Delay so onmousedown of an item fires first
    setTimeout(function(){
      var list = document.getElementById('grnPoPickerList');
      if (list) list.style.display = 'none';
    }, 150);
  }

  window.__invGrnPoPickerSelect = function(poId){
    var sel = document.getElementById('grnPoSelect');
    if (sel){
      // Make sure the hidden select has this option (so existing logic works)
      var opt = sel.querySelector('option[value="' + poId + '"]');
      if (!opt){
        var po = (_poRows||[]).find(function(p){ return String(p.id) === String(poId); });
        if (po){
          var newOpt = document.createElement('option');
          newOpt.value = String(po.id);
          newOpt.textContent = (po.po_num || '') + ' – ' + (po.supplier_name || '');
          sel.appendChild(newOpt);
        }
      }
      sel.value = String(poId);
      poChange();
    }
    // Reset the typed text and hide dropdown
    var inp = document.getElementById('grnPoSelectFilter');
    if (inp) inp.value = '';
    var list = document.getElementById('grnPoPickerList');
    if (list) list.style.display = 'none';
  };

  // ─── Print dropdown menu (open/close) ──────────────────────────────
  function togglePrintMenu(ev){
    if (ev) ev.stopPropagation();
    var menu = document.getElementById('grnPrintMenu');
    if (!menu) return;
    var isOpen = menu.classList.contains('open');
    closePrintMenu();
    if (!isOpen){
      menu.classList.add('open');
      // Close on outside click — bind once
      setTimeout(function(){
        document.addEventListener('click', _onPrintMenuOutsideClick, { once:true });
      }, 0);
    }
  }
  function closePrintMenu(){
    var menu = document.getElementById('grnPrintMenu');
    if (menu) menu.classList.remove('open');
  }
  function _onPrintMenuOutsideClick(){
    closePrintMenu();
  }

  // ─── Print GRN with linked POs ─────────────────────────────────────
  // Strategy: build the regular GRN HTML, then append one section per
  // linked PO with its full details fetched from /api/inventory_mgmt/po/get.
  function printGrnWithPos(){
    var html = buildPrintHTML();
    if (!html) return;
    var poIds = (_grnPoInvoices || [])
      .filter(function(inv){ return inv.po_id; })
      .map(function(inv){ return inv.po_id; });

    if (!poIds.length){
      // No linked POs — just print the GRN as usual
      var w0 = window.open('', '_blank', 'width=900,height=700');
      if (!w0){ _toast('Pop-up blocked', 'error'); return; }
      w0.document.open(); w0.document.write(html); w0.document.close();
      w0.onload = function(){ w0.focus(); w0.print(); };
      return;
    }

    // Fetch each PO in parallel
    Promise.all(poIds.map(function(id){
      return fetch('/api/inventory_mgmt/po/get?id=' + id)
        .then(function(r){ return r.json(); })
        .then(function(d){ return d.status === 'ok' ? d.order : null; })
        .catch(function(){ return null; });
    })).then(function(orders){
      var poHtml = orders.filter(Boolean).map(_grnBuildPoHTML).join('<div style="page-break-before:always"></div>');
      // Inject the PO blocks just before the closing </body>
      var finalHtml = html.replace('</body>', '<div style="page-break-before:always"></div>' + poHtml + '</body>');
      var win = window.open('', '_blank', 'width=900,height=700');
      if (!win){ _toast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
      win.document.open();
      win.document.write(finalHtml);
      win.document.close();
      win.onload = function(){ win.focus(); win.print(); };
    });
  }

  function _grnBuildPoHTML(po){
    if (!po) return '';
    var lineRows = (po.items || []).map(function(it, i){
      var qty  = parseFloat(it.qty) || 0;
      var rate = parseFloat(it.rate) || 0;
      return '<tr>'
        + '<td class="ctr">' + (i+1) + '</td>'
        + '<td class="tl"><strong>' + esc(it.material||'') + '</strong></td>'
        + '<td class="rr">' + (qty > 0 ? qty.toLocaleString('en-IN', {minimumFractionDigits:3}) + ' ' + esc(it.uom||'KG') : '—') + '</td>'
        + '<td class="rr">' + (rate > 0 ? fi(rate) : '—') + '</td>'
        + '<td class="rr">' + (qty*rate > 0 ? fi(qty*rate) : '—') + '</td>'
        + '</tr>';
    }).join('');
    return '<div style="margin-top:24px">'
      + '<div class="hdr"><div><div class="co">PURCHASE ORDER</div><div class="cosub">Linked PO Detail</div></div>'
      + '<div><div class="pnum">' + esc(po.po_num||'') + '</div></div></div>'
      + '<div class="bar bar3">'
      + '<div class="bc"><div class="bl">PO Number</div><div class="bv">' + esc(po.po_num||'—') + '</div></div>'
      + '<div class="bc"><div class="bl">PO Date</div><div class="bv">' + fd(po.po_date||'') + '</div></div>'
      + '<div class="bc"><div class="bl">Supplier</div><div class="bv">' + esc(po.supplier_name||'—') + '</div></div>'
      + '</div>'
      + '<table style="margin-top:8px"><thead><tr>'
      + '<th style="width:22px;text-align:center">Sl</th>'
      + '<th style="text-align:left">Material</th>'
      + '<th style="width:110px">Qty</th>'
      + '<th style="width:85px">Rate (\u20B9)</th>'
      + '<th style="width:105px">Amount (\u20B9)</th>'
      + '</tr></thead><tbody>' + (lineRows || '<tr><td colspan="5" style="text-align:center;color:#999;padding:14px">No items on this PO</td></tr>') + '</tbody></table>'
      + '</div>';
  }

  // ─── Item Label Print Modal ────────────────────────────────────────
  var _grnLabelSelected = {};  // { lineIndex: bool }
  var _grnLabelEscBound = false;

  function _bindLabelModalEscape(){
    if (_grnLabelEscBound) return;
    _grnLabelEscBound = true;
    document.addEventListener('keydown', function(e){
      if (e.key !== 'Escape') return;
      var modal = document.getElementById('grnLabelPrintModal');
      if (modal && modal.classList.contains('open')){
        closeLabelPrint();
      }
    });
  }

  function openLabelPrint(){
    var validLines = _grnLines
      .map(function(l, idx){ return { line:l, idx:idx }; })
      .filter(function(r){ return r.line.material && r.line.material.trim(); });

    if (!validLines.length){
      _toast('No items to print labels for', 'error');
      return;
    }

    // Pre-select every item by default. The previous behaviour started
    // with everything unchecked, which on slow remote-desktop sessions
    // led to users hunting for tiny checkboxes (and losing the modal to
    // mis-clicks). Default-select makes the common "print all" path one
    // click, and partial selection is still possible via row clicks.
    _grnLabelSelected = {};
    validLines.forEach(function(r){ _grnLabelSelected[r.idx] = true; });

    var html = validLines.map(function(r){
      var l = r.line;
      var pkgs = parseInt(l.packages) || 1;
      var pq   = parseFloat(l.qty_per_pkg) || 0;
      var meta = [
        '<span><b>' + pkgs + '</b> pkg' + (pkgs===1?'':'s') + '</span>',
        pq > 0 ? '<span><b>' + pq + '</b> ' + esc(l.uom||'KG') + ' / pkg</span>' : '',
        l.batch_num ? '<span>Batch: <b>' + esc(l.batch_num) + '</b></span>' : '',
        l.invoice_num ? '<span>Inv: <b>' + esc(l.invoice_num) + '</b></span>' : '',
      ].filter(Boolean).join('');
      // The whole row is clickable, not just the 16x16 checkbox. Big
      // hit-target = much friendlier on slow VNC where mouse movements
      // lag. The checkbox still works as a checkbox; the row label is a
      // <label for=…> wrapping it, so clicking the row text toggles too.
      var cbId = 'grnLblCb-' + r.idx;
      return '<label class="lpm-item lpm-item-clickable" for="' + cbId + '">'
        + '<input type="checkbox" id="' + cbId + '" checked '
        +   'data-line-idx="' + r.idx + '" '
        +   'onchange="invGrnLabelToggle(' + r.idx + ', this.checked)">'
        + '<div class="lpm-item-body">'
        + '<div class="lpm-item-name">' + esc(l.material) + '</div>'
        + '<div class="lpm-item-meta">' + meta + '</div>'
        + '</div></label>';
    }).join('');

    document.getElementById('grnLabelItemsList').innerHTML = html;
    _updateLabelCount();
    _refreshLabelRowStates();
    document.getElementById('grnLabelPrintModal').classList.add('open');
    _bindLabelModalEscape();
  }

  function closeLabelPrint(){
    document.getElementById('grnLabelPrintModal').classList.remove('open');
  }

  function labelToggle(idx, checked){
    _grnLabelSelected[idx] = checked;
    _updateLabelCount();
    _refreshLabelRowStates();
  }

  function labelSelectAll(checked){
    document.querySelectorAll('#grnLabelItemsList input[type="checkbox"]').forEach(function(cb){
      cb.checked = checked;
      _grnLabelSelected[parseInt(cb.dataset.lineIdx)] = checked;
    });
    _updateLabelCount();
    _refreshLabelRowStates();
  }

  function _refreshLabelRowStates(){
    // Visual highlight for selected rows. Pure presentation — no impact
    // on counting or printing.
    document.querySelectorAll('#grnLabelItemsList .lpm-item').forEach(function(row){
      var cb = row.querySelector('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) row.classList.add('lpm-item-selected');
      else row.classList.remove('lpm-item-selected');
    });
  }

  function _updateLabelCount(){
    var items = 0, labels = 0;
    Object.keys(_grnLabelSelected).forEach(function(k){
      if (_grnLabelSelected[k]){
        items++;
        var l = _grnLines[parseInt(k)];
        labels += parseInt(l.packages) || 1;
      }
    });
    document.getElementById('grnLabelSelectedCount').textContent =
      items + ' item' + (items===1?'':'s') + ' · ' + labels + ' label' + (labels===1?'':'s');
    document.getElementById('grnLabelPrintBtn').disabled = items === 0;
  }

  async function doLabelPrint(){
    var grnNum     = (document.getElementById('grnFormNum').textContent || '').trim();
    var grnDate    = getVal('grnDate');
    var supplier   = (getVal('grnSupplier')||'').trim() || '—';
    var supervisor = (getVal('grnSupervisor')||'').trim() || '—';

    // Codes are persisted against (grn_id, grn_item_id) on the server.
    // Once a GRN has been printed, reprints return the SAME codes — no
    // counter advance, no surprise relabeling.
    //
    // Requirements per the design:
    //   - GRN must be saved (has _grnEditId)
    //   - Each selected line must have a grn_item_id (was saved)
    if (!_grnEditId){
      _toast('Save the GRN before printing labels — codes are tied to the saved record', 'error');
      return;
    }

    // Group selected lines into per-line buckets keyed by grn_item_id.
    // Also build the metadata needed to render the labels themselves.
    // pendingByLine: { <grn_item_id>: { line, count, labels:[{b, pkgs, pq, ...}] } }
    var pendingByLine = {};
    var hadUnsavedLine = false;
    Object.keys(_grnLabelSelected).forEach(function(k){
      if (!_grnLabelSelected[k]) return;
      var l = _grnLines[parseInt(k)];
      if (!l.grn_item_id){
        hadUnsavedLine = true;
        return;
      }
      var pkgs = parseInt(l.packages) || 1;
      var pq   = parseFloat(l.qty_per_pkg) || 0;
      var key = String(l.grn_item_id);
      if (!pendingByLine[key]){
        pendingByLine[key] = { line: l, count: pkgs, packages_meta: [] };
      }
      // Build the per-package metadata for label rendering. The server
      // returns codes in the same order — we'll zip them together below.
      for (var b = 1; b <= pkgs; b++){
        pendingByLine[key].packages_meta.push({ b: b, pkgs: pkgs, pq: pq });
      }
    });

    if (hadUnsavedLine){
      _toast('One or more selected items haven\'t been saved yet. Save the GRN and try again.', 'error');
      return;
    }
    var lineKeys = Object.keys(pendingByLine);
    if (!lineKeys.length){ _toast('No labels to print', 'error'); return; }

    // Build the persistent-mode request payload: per-line item_id + count
    var requestLines = lineKeys.map(function(k){
      return {
        grn_item_id: parseInt(k),
        count:       pendingByLine[k].count,
      };
    });

    // Fetch (and persist) codes from the server. Same call on a reprint
    // returns the SAME codes.
    var codesByLine = {};   // grn_item_id (string) → [codes]
    try {
      var r = await fetch('/api/inventory_godown/allocate_codes', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ grn_id: _grnEditId, lines: requestLines })
      });
      var j = await r.json();
      if (j.status !== 'ok' || !Array.isArray(j.lines)){
        throw new Error(j.message || 'Bad response shape');
      }
      j.lines.forEach(function(ln){
        codesByLine[String(ln.grn_item_id)] = ln.codes || [];
      });
    } catch(e){
      _toast('Could not allocate codes: ' + (e.message || e), 'error');
      return;
    }

    // Stitch codes into label data. The codes array for each line is in
    // box_seq order (1..N), and packages_meta is also 1..N, so we zip.
    var labels = [];
    lineKeys.forEach(function(k){
      var bucket = pendingByLine[k];
      var codes  = codesByLine[k] || [];
      var l      = bucket.line;
      bucket.packages_meta.forEach(function(pm, idx){
        labels.push({
          materialName:  l.material,
          qrCode:        codes[idx] || ('RM-?' + String(idx+1).padStart(7,'0')),
          grnNo:         grnNum,
          grnDate:       grnDate,
          batchNo:       l.batch_num || '',
          boxNum:        pm.b,
          totalBoxes:    pm.pkgs,
          perPkgQty:     pm.pq,
          uom:           l.uom || 'KG',
          invoiceNo:     l.invoice_num || '',
          invoiceDate:   l.invoice_date || '',
          mfgDate:       l.mfg_date || '',
          expiryDate:    l.expiry_date || '',
          manufacturer:  (l.manufacturer || '').trim(),
          supplier:      supplier,
          supervisor:    supervisor,
        });
      });
    });

    if (!labels.length){ _toast('No labels to print', 'error'); return; }

    var html = _buildLabelPrintHTML(labels);
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win){ _toast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // No win.print() here — the embedded boot script in the print HTML
    // waits for all QR images to be rendered (locally via qrcode-generator
    // or via the api.qrserver.com fallback) before firing print() itself.
    win.focus();
    closeLabelPrint();
  }

  /* Reusable label printer for OTHER modules (e.g. opening stock).
     Pass an array of label objects in the same shape doLabelPrint builds:
       { materialName, qrCode, grnNo, grnDate, batchNo, boxNum, totalBoxes,
         perPkgQty, uom, invoiceNo, mfgDate, expiryDate, manufacturer,
         supplier, supervisor }
     For opening stock, leave GRN/invoice/MFR blank and set grnNo to the
     opening label (e.g. "OPENING") — the renderer handles blanks as "—". */
  window.invPrintLabels = function(labels){
    if(!Array.isArray(labels) || !labels.length){
      if(window.invToast) window.invToast('No labels to print','error'); else alert('No labels to print');
      return;
    }
    var html = _buildLabelPrintHTML(labels);
    var win = window.open('', '_blank', 'width=900,height=700');
    if(!win){
      if(window.invToast) window.invToast('Pop-up blocked — allow pop-ups and try again','error'); else alert('Pop-up blocked');
      return;
    }
    win.document.open(); win.document.write(html); win.document.close(); win.focus();
  };

  /* ───────────────────────────────────────────────────────────────────
     window.invGrnPrintBoxLabel(boxCodeOrCodes)
     -------------------------------------------------------------------
     Print the LABEL for one or more existing boxes by their box_code.
     Used by:
       • Label Reprint  — when an approved request is printed (per-box / all)
       • Label Reissue  — to print the replacement label after approval
       • Box Split      — to print labels for the newly-created child boxes

     Reaches /api/inventory_mgmt/box_label_data to pull the full label
     payload (material, supplier, GRN/INV no+date, batch, MFG/EXP, qty…)
     and feeds the array into invPrintLabels(), reusing the exact same
     100×75mm template the GRN module uses for initial printing.

     Accepts:
       - a single string box code:   invGrnPrintBoxLabel('RM-A0001234')
       - an array of box codes:      invGrnPrintBoxLabel(['RM-A0001234',...])
       - a comma-separated string:   invGrnPrintBoxLabel('A,B,C')

     Resolves with the fetch promise so callers can await/.then if needed,
     though the existing call sites use fire-and-forget style.
     ─────────────────────────────────────────────────────────────────── */
  window.invGrnPrintBoxLabel = function(codes){
    // Normalise input → comma-separated, trimmed, de-duplicated, upper.
    var arr;
    if (Array.isArray(codes)){
      arr = codes;
    } else if (typeof codes === 'string'){
      arr = codes.split(/[,\n]/);
    } else {
      arr = [String(codes||'')];
    }
    var seen = {}, list = [];
    arr.forEach(function(c){
      var s = String(c||'').trim().toUpperCase();
      if(!s || seen[s]) return;
      seen[s] = true; list.push(s);
    });
    if (!list.length){
      if(window.invToast) window.invToast('No box code to print','error'); else alert('No box code to print');
      return Promise.resolve();
    }
    var qs = '?box_codes=' + encodeURIComponent(list.join(','));
    return fetch('/api/inventory_mgmt/box_label_data' + qs)
      .then(function(r){
        // Don't trust .json() to succeed on a 5xx — text-then-parse is safer.
        return r.text().then(function(txt){
          var parsed = null;
          try { parsed = JSON.parse(txt); } catch(_) {}
          if (!r.ok){
            // Build a clear error from whatever the server sent back.
            var detail = (parsed && (parsed.detail || parsed.message))
                       || (txt ? txt.slice(0,200) : ('HTTP ' + r.status));
            var where = parsed && parsed.where ? (' [' + parsed.where + ']') : '';
            throw new Error('Label data fetch failed' + where + ': ' + detail);
          }
          return parsed || {};
        });
      })
      .then(function(d){
        if (!d || d.status !== 'ok' || !Array.isArray(d.labels) || !d.labels.length){
          var msg = (d && (d.detail || d.message)) ? (d.message + (d.detail?(' — '+d.detail):'')) : 'Could not load label data';
          if(window.invToast) window.invToast(msg,'error',6000); else alert(msg);
          throw new Error(msg);
        }
        // Warn (but still print) if any code wasn't found in the DB.
        var missing = d.labels.filter(function(L){ return L._not_found; })
                             .map(function(L){ return L.qrCode; });
        if (missing.length){
          var m = 'Heads up — these codes were not found in stock: ' + missing.slice(0,5).join(', ') + (missing.length>5?' …':'');
          if(window.invToast) window.invToast(m,'warn',5000); else console.warn(m);
        }
        if (typeof window.invPrintLabels !== 'function'){
          var msg2 = 'Label printer unavailable';
          if(window.invToast) window.invToast(msg2,'error');
          else alert(msg2);
          throw new Error(msg2);
        }
        window.invPrintLabels(d.labels);
        return d;
      })
      .catch(function(e){
        // Surface the error so the caller (e.g. printAll) can SKIP the
        // "mark printed" step if the print never happened.
        var msg = 'Print failed: ' + (e && e.message || e);
        if(window.invToast) window.invToast(msg,'error',7000);
        else alert(msg);
        console.error('[invGrnPrintBoxLabel]', e);
        throw e;
      });
  };

  // Build the 100×75mm label sheet
  function _buildLabelPrintHTML(labels){
    function fmtDate(iso){
      if (!iso) return '—';
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
      if (!m) return iso;
      return m[3] + '/' + m[2] + '/' + m[1];
    }
    function nameSize(name){
      var L = (name || '').length;
      if (L <= 14) return 26;
      if (L <= 22) return 21;
      if (L <= 30) return 17;
      if (L <= 42) return 14;
      return 11;
    }
    // QR images: rendered locally in the print window via qrcode-generator
    // library (loaded from cdnjs). Each <img class="qrimg" data-qr-payload="…">
    // is filled by a boot script in the print window with a data: URL — no
    // per-QR network calls. Same approach PM Stock uses successfully.
    var qrFallback = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=2&ecc=H&data=';

    var labelDivs = labels.map(function(L){
      var fontSize = nameSize(L.materialName);
      var payload  = L.qrCode;
      var perQty   = (L.perPkgQty != null && L.perPkgQty !== '') ? L.perPkgQty : '—';
      // Total qty for this receipt = per-pkg qty × total packages (matches the
      // PM label's "No.of box × per-box qty = total qty" equation).
      var totalQty = '—';
      var pq = parseFloat(L.perPkgQty), tb = parseInt(L.totalBoxes, 10);
      if (!isNaN(pq) && !isNaN(tb)) {
        totalQty = (Math.round(pq * tb * 1000) / 1000);
      }
      // FEFO code — separate per item, ordered by EXPIRY (First-Expiry-First-Out).
      // Format: <ITEM>-F<MMYY>. The ITEM prefix must be UNIQUE per material so
      // two different materials expiring the same month never share a code.
      //   • If the name starts with a numeric material code (e.g.
      //     "20585 Healthy Hair…") that code is already unique → use it.
      //   • Otherwise build a readable-but-unique tag: a short alpha slug of
      //     the name PLUS a 2-char base-36 hash of the FULL name. This fixes
      //     the collision where "Sodium Gluconate" and "Sodium Fluoride" both
      //     reduced to "SODI" — the hash differs even when the slug matches.
      //     e.g. "Sodium Gluconate" → "SODGL3A", "Sodium Fluoride" → "SODFL7K".
      var fefo = '';
      var em = /^(\d{4})-(\d{2})/.exec(L.expiryDate || '');
      if (em) {
        var nm = (L.materialName || '').trim();
        var codeMatch = /^([0-9][0-9A-Za-z]*)\b/.exec(nm);   // leading numeric code
        var item;
        if (codeMatch) {
          item = codeMatch[1];                               // already unique
        } else {
          // Readable slug: up to 2 letters from each of the first two words,
          // capped at 5 chars (e.g. "Sodium Gluconate" → "SODGL").
          var words = nm.replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
          var slug = '';
          if (words.length >= 2) {
            slug = (words[0].slice(0, 3) + words[1].slice(0, 2)).toUpperCase();
          } else {
            slug = (words[0] || 'ITEM').slice(0, 5).toUpperCase();
          }
          // Deterministic 2-char base-36 hash of the full (lowercased) name so
          // even same-slug materials get distinct codes. Simple DJB2-style.
          var h = 5381, src = nm.toLowerCase();
          for (var ci = 0; ci < src.length; ci++) {
            h = ((h << 5) + h + src.charCodeAt(ci)) >>> 0;   // keep unsigned 32-bit
          }
          var tag = (h % 1296).toString(36).toUpperCase();   // 0..1295 → up to 2 chars
          while (tag.length < 2) tag = '0' + tag;
          item = slug + tag;
        }
        fefo = item + '-F' + em[2] + em[1].slice(2);
      }
      return ''
       + '<div class="label">'

       /* ── Product name + code (bordered, like PM top box) ── */
       +   '<div class="lbl-name-box">'
       +     '<div class="lbl-name" style="font-size:' + fontSize + 'px">' + esc(L.materialName) + '</div>'
       +     '<div class="lbl-code">' + esc(L.qrCode) + '</div>'
       +   '</div>'

       /* ── Supplier (line 1) + Manufacturer (line 2), left-aligned, full names ── */
       +   '<div class="lbl-mfr-box">'
       +     '<div class="lbl-supline"><span class="lbl-mfr-lbl">SUPP</span><span class="lbl-sup-val">' + esc(L.supplier || '—') + '</span></div>'
       +     '<div class="lbl-mfrline"><span class="lbl-mfr-lbl">MFR</span><span class="lbl-mfr-val">' + esc(L.manufacturer || '—') + '</span></div>'
       +   '</div>'

       /* ── Mid row: GRN(no+date) / INV(no+date) / BATCH on the left,
              QR + FEFO (vertically centred as a unit) on the right ── */
       +   '<div class="lbl-mid">'
       +     '<div class="lbl-datecol">'
       +       '<div class="dcell"><div class="dk">GRN NO</div><div class="dv mono">' + esc(L.grnNo || '—') + '</div></div>'
       +       '<div class="dcell sub"><div class="dk">GRN DATE</div><div class="dv">' + fmtDate(L.grnDate) + '</div></div>'
       +       '<div class="dcell"><div class="dk">INV NO</div><div class="dv mono">' + esc(L.invoiceNo || '—') + '</div></div>'
       +       '<div class="dcell sub"><div class="dk">INV DATE</div><div class="dv">' + fmtDate(L.invoiceDate) + '</div></div>'
       +       '<div class="dcell"><div class="dk">BATCH</div><div class="dv mono">' + esc(L.batchNo || '—') + '</div></div>'
       +     '</div>'
       +     '<div class="lbl-qrcol">'
       +       '<img class="qrimg lbl-qr"'
       +         ' data-qr-payload="' + esc(payload) + '"'
       +         ' data-qr-fallback-url="' + qrFallback + encodeURIComponent(payload) + '"'
       +         ' alt="QR">'
       +       (fefo ? '<div class="lbl-fefo"><span class="fefo-lbl">FEFO</span><span class="fefo-val">' + esc(fefo) + '</span></div>' : '')
       +     '</div>'
       +   '</div>'

       /* ── MFG / EXP — HIGHLIGHTED (inverted black fill) ── */
       +   '<div class="lbl-dates">'
       +     '<div class="dt-cell mfg"><span class="dt-lbl">MFG</span><span class="dt-val">' + fmtDate(L.mfgDate) + '</span></div>'
       +     '<div class="dt-cell exp"><span class="dt-lbl">EXP</span><span class="dt-val">' + fmtDate(L.expiryDate) + '</span></div>'
       +   '</div>'

       /* ── Quantity equation: PKG (n/total) × per-pkg = total ── */
       +   '<div class="lbl-qtybox">'
       +     '<div class="qcol"><div class="qk">NO. OF PKG</div><div class="qv">' + L.boxNum + ' / ' + L.totalBoxes + '</div></div>'
       +     '<div class="qop">&times;</div>'
       +     '<div class="qcol"><div class="qk">PER PKG QTY</div><div class="qv">' + perQty + ' ' + esc(L.uom || '') + '</div></div>'
       +     '<div class="qop">=</div>'
       +     '<div class="qcol"><div class="qk">TOTAL QTY</div><div class="qv">' + totalQty + ' ' + esc(L.uom || '') + '</div></div>'
       +   '</div>'

       /* ── Footer: supervisor | company ── */
       +   '<div class="lbl-foot">'
       +     '<span class="foot-supv"><span class="foot-k">SUPV</span> ' + esc(L.supervisor || '—') + '</span>'
       +     '<span class="foot-co">HCP WELLNESS PVT. LTD</span>'
       +   '</div>'

       + '</div>';
    }).join('');

    var CSS = ''
      + '@page { size: 100mm 75mm; margin: 0; }'
      + '*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + 'body{font-family:Arial,Helvetica,sans-serif;background:#FAF9F5}'
      + '.label{'
      +   'width:100mm; height:75mm;'
      +   'background:#FFFFFF; color:#000;'
      +   'padding:2mm 3mm; box-sizing:border-box;'
      +   'display:flex; flex-direction:column; gap:1mm;'
      +   'overflow:hidden;'                       /* safety clip, but content is sized to fit */
      +   'page-break-after:always; break-after:page;'
      +   'border:1px solid #999;'
      + '}'
      + '.label:last-child{page-break-after:auto}'

      /* ── Product name box (bordered, like PM top) ── */
      + '.lbl-name-box{ border:1.4pt solid #000; border-radius:1mm; padding:.6mm 2mm; text-align:center; }'
      + '.lbl-name{'
      +   'font-weight:900; line-height:1.0;'
      +   'word-wrap:break-word; overflow-wrap:break-word;'
      + '}'
      + '.lbl-code{'
      +   'font-family:"Courier New",monospace; font-weight:700;'
      +   'font-size:8.5pt; letter-spacing:.4px; margin-top:.2mm;'
      + '}'

      /* ── Manufacturer row (normal weight, inline label) ── */
      + '.lbl-mfr-box{'
      +   'padding:.3mm 0; display:flex; flex-direction:column; gap:.4mm; min-width:0;'
      + '}'
      + '.lbl-supline, .lbl-mfrline{ display:flex; align-items:baseline; gap:1.5mm; min-width:0; }'
      + '.lbl-mfr-lbl{ font-weight:700; font-size:7pt; letter-spacing:.4pt; flex-shrink:0; min-width:9mm; }'
      + '.lbl-sup-val, .lbl-mfr-val{'
      +   'font-family:Arial,Helvetica,sans-serif; font-weight:600;'
      +   'font-size:9pt; line-height:1.05; word-break:break-word;'
      + '}'

      /* ── Mid row: date column (left) + QR (right) ── */
      + '.lbl-mid{ display:grid; grid-template-columns:1fr 22mm; gap:2.5mm; flex:1; min-height:0; align-items:stretch; }'
      + '.lbl-datecol{ display:flex; flex-direction:column; justify-content:space-between; }'
      + '.dcell{ display:flex; justify-content:space-between; align-items:baseline; gap:2mm; padding:.15mm 0; }'
      + '.dcell.sub{ border-bottom:.5pt solid #bbb; padding-bottom:.4mm; margin-bottom:.3mm; }'
      + '.dk{ font-weight:900; font-size:6.5pt; letter-spacing:.3pt; color:#000; flex-shrink:0; }'
      + '.dv{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:8pt; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }'
      + '.dv.mono{ font-family:"Courier New",monospace; font-size:7.5pt; }'

      /* ── QR + FEFO column — vertically centred as one unit, NO box on FEFO ── */
      + '.lbl-qrcol{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.6mm; }'
      + '.lbl-qr{ width:20mm; height:20mm; display:block; }'
      + '.lbl-fefo{ display:flex; flex-direction:column; align-items:center; line-height:1; }'
      + '.fefo-lbl{ font-weight:700; font-size:6pt; letter-spacing:1pt; }'
      + '.fefo-val{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:10pt; letter-spacing:.2pt; white-space:nowrap; }'

      /* ── MFG / EXP — HIGHLIGHTED (inverted black fill, white text) ── */
      + '.lbl-dates{ display:grid; grid-template-columns:1fr 1fr; gap:2mm; }'
      + '.dt-cell{'
      +   'padding:.7mm 2mm; border:1.4pt solid #000; border-radius:1mm;'
      +   'text-align:center; display:flex; align-items:center; justify-content:center; gap:2mm;'
      +   'background:#000;'
      + '}'
      + '.dt-lbl{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:9pt; letter-spacing:.5pt; color:#FFFFFF; }'
      + '.dt-val{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:11.5pt; letter-spacing:.3pt; color:#FFFFFF; }'

      /* ── Quantity equation box ── */
      + '.lbl-qtybox{'
      +   'display:flex; align-items:center; justify-content:space-between;'
      +   'border:1.2pt solid #000; border-radius:1mm; padding:.6mm 2mm; gap:1mm;'
      + '}'
      + '.qcol{ text-align:center; flex:1; }'
      + '.qk{ font-weight:900; font-size:6pt; letter-spacing:.3pt; color:#333; }'
      + '.qv{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:10pt; line-height:1.05; }'
      + '.qop{ font-weight:900; font-size:11pt; flex-shrink:0; }'

      /* ── Footer: supervisor | company ── */
      + '.lbl-foot{ display:flex; justify-content:space-between; align-items:baseline; gap:2mm; }'
      + '.foot-supv{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:7.5pt; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }'
      + '.foot-k{ font-size:6pt; letter-spacing:.3pt; }'
      + '.foot-co{ font-family:"Arial Black",Arial,sans-serif; font-weight:900; font-size:7.5pt; flex-shrink:0; }'

      + '@media print { body { background:#FFFFFF } .label { border:none } }';

    // Boot script runs in the print window after page load:
    //   1) Try to render each QR via the qrcode-generator library
    //   2) If the library failed to load (offline), fall back to
    //      api.qrserver.com (batched, with retry, per PM Stock pattern)
    //   3) After all QRs are filled, trigger window.print()
    var bootScript = ''
      + '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/2.0.4/qrcode.min.js"><\/script>'
      + '<script>'
      + '(function(){'
      +   'function makeQrDataUrl(payload){'
      +     'if(typeof qrcode === "undefined") return null;'
      +     'try { var qr = qrcode(0, "H"); qr.addData(String(payload||"")); qr.make();'
      +          'return qr.createDataURL(8, 2); } catch(e){ return null; }'
      +   '}'
      +   'function loadFallback(img, url, attempt){'
      +     'return new Promise(function(resolve){'
      +       'img.onload = function(){ resolve(true); };'
      +       'img.onerror = function(){'
      +         'if(attempt < 1){ setTimeout(function(){ loadFallback(img, url, attempt+1).then(resolve); }, 600); }'
      +         'else { resolve(false); }'
      +       '};'
      +       'img.src = url;'
      +     '});'
      +   '}'
      +   'function loadBatches(imgs, n){'
      +     'var i=0;'
      +     'function next(){ if(i>=imgs.length) return Promise.resolve();'
      +       'var slice = imgs.slice(i, i+n); i += n;'
      +       'return Promise.all(slice.map(function(img){'
      +         'return loadFallback(img, img.getAttribute("data-qr-fallback-url")||"", 0);'
      +       '})).then(next);'
      +     '}'
      +     'return next();'
      +   '}'
      +   'window.addEventListener("load", function(){'
      +     'var imgs = Array.prototype.slice.call(document.querySelectorAll(".qrimg"));'
      +     'if(!imgs.length){ window.print(); return; }'
      +     'var unfilled = [];'
      +     'imgs.forEach(function(img){'
      +       'var payload = img.getAttribute("data-qr-payload") || "";'
      +       'var data = makeQrDataUrl(payload);'
      +       'if(data){ img.src = data; } else { unfilled.push(img); }'
      +     '});'
      +     'var work = (unfilled.length === 0) ? Promise.resolve() : loadBatches(unfilled, 4);'
      +     'work.then(function(){ setTimeout(function(){ window.print(); }, 200); });'
      +   '});'
      + '})();'
      + '<\/script>';

    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Labels — ' + esc(labels[0].grnNo||'GRN') + '</title>'
      + '<style>' + CSS + '</style></head><body>'
      + labelDivs
      + bootScript
      + '</body></html>';
  }

  /* ════════════════════════════════════════════════════════════════════
     NEW (May 2026) — Other Details + Unloading Checklist modals
  ════════════════════════════════════════════════════════════════════ */

  // Persistent state shared across renders / load / save
  var _grnOtherDetails = {};   // { unload_time, gate_in_no, gate_in_at, logistic_name, lr_no, lr_date, delivery_location, delivery_type, driver_name, driver_contact }
  var _grnChecklist    = {};   // { test:{status,remark}, physical:{...}, label:{...}, batch:{...}, expiry:{...}, rejection_remarks:'' }

  var _CHECKLIST_ITEMS = [
    { key:'test',     label:'Test',                states:['ok','bad','na'] },
    { key:'physical', label:'Physical Condition',  states:['ok','warn','bad'] },
    { key:'label',    label:'Label',               states:['ok','warn','bad'] },
    { key:'batch',    label:'Batch on Product',    states:['ok','warn','bad'] },
    { key:'expiry',   label:'Expiry Date',         states:['ok','warn','bad'] },
  ];
  var _STATE_TEXT = { ok:'OK', warn:'Issue', bad:'Fail', na:'N/A' };

  /* ─── Keyboard shortcuts ─────────────────────────────────────────
     When the GRN form is open AND the user isn't currently typing
     into a form field:
       O → open Other Details
       C → open Checklist
       Esc → close whichever modal is open
     We attach the listener once at module load. The handler bails out
     fast if the focused element is an input/textarea/select, so it
     never interferes with normal typing. We also bail if a modifier
     key (Ctrl/Alt/Meta) is held — only the bare key triggers. */
  (function attachGrnShortcuts(){
    document.addEventListener('keydown', function(ev){
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

      // Only fire when the GRN form pane is open
      var formPane = document.getElementById('grn-form-pane');
      if (!formPane || !formPane.classList.contains('open')) return;

      // Don't intercept typing — bail if the focused element is editable
      var ae = document.activeElement;
      if (ae){
        var tag = (ae.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (ae.isContentEditable) return;
      }

      // If any modal is open, only handle Escape (let other keys pass through)
      var odOpen  = document.getElementById('otherDetailsModal');
      var chkOpen = document.getElementById('checklistModal');
      var anyOpen = (odOpen && odOpen.classList.contains('open'))
                 || (chkOpen && chkOpen.classList.contains('open'));

      if (ev.key === 'Escape' && anyOpen){
        if (odOpen  && odOpen.classList.contains('open'))  closeOtherDetails();
        if (chkOpen && chkOpen.classList.contains('open')) closeChecklist();
        ev.preventDefault();
        return;
      }
      if (anyOpen) return;  // modals own their own keys

      var k = (ev.key || '').toLowerCase();
      if (k === 'o'){ ev.preventDefault(); openOtherDetails(); return; }
      if (k === 'c'){ ev.preventDefault(); openChecklist();    return; }
    });
  })();

  // ─── Other Details modal ─────────────────────────────────────────
  function openOtherDetails(){
    var d = _grnOtherDetails || {};
    setVal('odUnloadTime',       d.unload_time       || '');
    setVal('odGateInNo',         d.gate_in_no        || '');
    setVal('odGateInAt',         d.gate_in_at        || '');
    setVal('odLogisticName',     d.logistic_name     || '');
    setVal('odLrNo',             d.lr_no             || '');
    setVal('odLrDate',           d.lr_date           || '');
    setVal('odDeliveryLocation', d.delivery_location || '');
    setVal('odDeliveryType',     d.delivery_type     || '');
    setVal('odDriverName',       d.driver_name       || '');
    setVal('odDriverContact',    d.driver_contact    || '');
    document.getElementById('otherDetailsModal').classList.add('open');
  }
  function closeOtherDetails(){
    document.getElementById('otherDetailsModal').classList.remove('open');
  }
  function saveOtherDetails(){
    _grnOtherDetails = {
      unload_time:       (getVal('odUnloadTime')       || '').trim(),
      gate_in_no:        (getVal('odGateInNo')         || '').trim(),
      gate_in_at:        (getVal('odGateInAt')         || '').trim(),
      logistic_name:     (getVal('odLogisticName')     || '').trim(),
      lr_no:             (getVal('odLrNo')             || '').trim(),
      lr_date:           (getVal('odLrDate')           || '').trim(),
      delivery_location: (getVal('odDeliveryLocation') || '').trim(),
      delivery_type:     (getVal('odDeliveryType')     || '').trim(),
      driver_name:       (getVal('odDriverName')       || '').trim(),
      driver_contact:    (getVal('odDriverContact')    || '').trim(),
    };
    _refreshOtherDetailsBadge();
    closeOtherDetails();
    _toast('Other details saved (will be stored on GRN save)', 'success');
  }
  function _refreshOtherDetailsBadge(){
    // Highlight the button if any field has data
    var btn = document.querySelector('[onclick="invGrnOpenOtherDetails()"]');
    if (!btn) return;
    var hasData = Object.values(_grnOtherDetails || {}).some(function(v){ return v && String(v).trim(); });
    if (hasData) btn.classList.add('has-data');
    else         btn.classList.remove('has-data');
  }

  // ─── Unloading Checklist modal ───────────────────────────────────
  function openChecklist(){
    _renderChecklist();
    document.getElementById('checklistModal').classList.add('open');
  }
  function closeChecklist(){
    document.getElementById('checklistModal').classList.remove('open');
  }
  function _renderChecklist(){
    var c = _grnChecklist || {};
    var html = _CHECKLIST_ITEMS.map(function(item){
      var cur = c[item.key] || {};
      var st  = cur.status || '';
      var rk  = cur.remark || '';
      var buttons = item.states.map(function(s){
        var on = (s === st);
        var cls = 'chk-btn ' + (on ? ('on-' + s) : '');
        return '<button type="button" class="' + cls + '"'
             + ' onclick="invGrnChkSet(\'' + item.key + '\',\'' + s + '\')">'
             + esc(_STATE_TEXT[s] || s.toUpperCase()) + '</button>';
      }).join('');
      return '<div class="chk-item">'
        + '<div class="chk-label">' + esc(item.label) + '</div>'
        + '<div class="chk-toggle">' + buttons + '</div>'
        + '<input type="text" class="chk-remark" placeholder="Remark (optional)"'
        + ' value="' + esc(rk) + '"'
        + ' oninput="invGrnChkSetRemark(\'' + item.key + '\', this.value)">'
        + '</div>';
    }).join('');
    // Rejection Remarks block at the end
    html += '<div class="chk-item" style="grid-template-columns:160px 1fr">'
         + '<div class="chk-label" style="color:var(--nb-danger)">Rejection Remarks</div>'
         + '<textarea class="chk-remark" rows="3"'
         + ' placeholder="Reason for rejection if any item or whole consignment is rejected"'
         + ' oninput="invGrnChkSet(\'rejection_remarks\',\'\',this.value)">' + esc(c.rejection_remarks || '') + '</textarea>'
         + '</div>';
    document.getElementById('checklistList').innerHTML = html;
  }
  function chkSet(key, status, remark){
    if (!_grnChecklist[key]) _grnChecklist[key] = {};
    if (key === 'rejection_remarks'){
      // Special: only remark, no status
      _grnChecklist.rejection_remarks = remark || '';
      return;
    }
    _grnChecklist[key].status = status;
    _renderChecklist();
  }
  function chkSetRemark(key, remark){
    if (!_grnChecklist[key]) _grnChecklist[key] = {};
    _grnChecklist[key].remark = remark || '';
  }
  function saveChecklist(){
    _refreshChecklistBadge();
    closeChecklist();
    _toast('Checklist saved (will be stored on GRN save)', 'success');
  }
  function _refreshChecklistBadge(){
    var btn = document.querySelector('[onclick="invGrnOpenChecklist()"]');
    if (!btn) return;
    var c = _grnChecklist || {};
    var hasData = _CHECKLIST_ITEMS.some(function(it){ return (c[it.key] && c[it.key].status); })
                  || (c.rejection_remarks && c.rejection_remarks.trim());
    if (hasData) btn.classList.add('has-data');
    else         btn.classList.remove('has-data');
  }

  /* ══════════════════════ EXPOSE PUBLIC API ══════════════════════ */
  // Open a GRN by its id (used by the dock global-search). Works regardless
  // of current filter/pagination. If the list hasn't loaded yet (e.g. the dock
  // just opened the GRN screen), fetch it first, then open.
  function openById(id){
    id = parseInt(id, 10);
    if (!id) return;
    var row = _grnRows.find(function(r){ return parseInt(r.id,10) === id; });
    if (row){ openForm(row); return; }
    // not loaded yet → fetch list, then open
    fetch('/api/inventory_mgmt/grn/list')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.status !== 'ok') throw new Error(d.message || 'Failed');
        _grnRows = d.grns || [];
        applyFilter();
        var row2 = _grnRows.find(function(r){ return parseInt(r.id,10) === id; });
        if (row2) openForm(row2);
        else _toast('GRN not found (it may have been deleted).', 'error');
      })
      .catch(function(e){ _toast('Could not open GRN: ' + e.message, 'error'); });
  }

  // ─── TRS (Testing Requisition Slip) ────────────────────────────────
  // Per-GRN-line QC test request slip. Generated only after the GRN is
  // saved (we need grn_item_id as the FK). The UI mirrors the Print Item
  // Labels modal pattern (single-modal picker) so operators see a
  // consistent interaction.
  //
  // Flow:
  //   openTrs()
  //     → fetch /trs/list?grn_id=X to learn which lines already have a TRS
  //     → render radios for ungenerated lines, ✅ + click-to-print for
  //       generated ones
  //   onPickTrs(idx)
  //     → updates the Generate button label (Generate vs Re-print)
  //   doGenerateTrs()
  //     → if the line has all required fields from the GRN, POST to
  //       /trs/generate and open the print preview
  //     → else, open the missing-fields modal to collect
  //       physical_state / sample_qty / previous_supplier / new_or_old,
  //       then POST → print

  var _trsGeneratedByLine = {}; // { grn_item_id: trs row }
  var _trsAllForGrn       = []; // full TRS list for current GRN — used
                                // by _trsForLine() as a mat+batch
                                // fallback when grn_item_id is orphaned.
  var _trsPickedLineIdx   = -1;
  var _trsPendingFields   = null; // { grn_item_id, ... } during prompt

  // Fields the operator must supply (not on the GRN line). If we ever
  // add columns to procurement_grn_items for these, change this list
  // and the prompt modal will skip the now-known ones automatically.
  var TRS_PROMPT_FIELDS = [
    { key: 'physical_state',    label: 'Physical State',
      type: 'select',
      options: ['Solid', 'Liquid', 'Powder', 'Granules', 'Paste', 'Gas', 'Other'] },
    { key: 'sample_qty',        label: 'Sample Qty (in KG)',
      type: 'number', step: '0.001', min: '0' },
    { key: 'previous_supplier', label: 'Previous Supplier',
      type: 'text', placeholder: 'Type previous supplier name (optional)' },
    { key: 'new_or_old',        label: 'NEW / OLD Material',
      type: 'select',
      options: ['NEW', 'OLD'] },
  ];

  function _trsFmtDate(iso){
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    return m[3] + '-' + m[2] + '-' + m[1];   // DD-MM-YYYY to match screenshot
  }

  function _trsValidLines(){
    return _grnLines
      .map(function(l, idx){ return { line:l, idx:idx }; })
      .filter(function(r){
        // Need an actual saved line (grn_item_id) AND a material name.
        return r.line.material && r.line.material.trim()
            && r.line.grn_item_id;
      });
  }

  function openTrs(){
    // Guard: only meaningful for a saved GRN. Surface a clear toast if
    // the operator tries to generate from an unsaved form.
    if (!_grnEditId){
      _toast('Save the GRN first — TRS needs saved line items', 'error');
      return;
    }
    var validLines = _trsValidLines();
    if (!validLines.length){
      _toast('No saved line items to generate TRS for', 'error');
      return;
    }

    _trsPickedLineIdx = -1;
    _trsGeneratedByLine = {};
    _trsAllForGrn = [];   // full list, used by the mat+batch fallback below

    // Fetch existing TRS rows for this GRN so we can show ✅ badges and
    // pre-populate the "re-print" path. Don't block the modal — show
    // the list immediately and update badges when the fetch returns.
    _renderTrsPicker(validLines);   // initial render (no badges)
    document.getElementById('grnTrsPickerModal').classList.add('open');

    fetch('/api/inventory_mgmt/trs/list?grn_id=' + encodeURIComponent(_grnEditId))
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.status === 'ok' && Array.isArray(d.trs)){
          _trsAllForGrn = d.trs.slice();
          d.trs.forEach(function(t){
            if (t.grn_item_id){
              _trsGeneratedByLine[t.grn_item_id] = t;
            }
          });
          _renderTrsPicker(validLines);  // re-render with badges
        }
      })
      .catch(function(){ /* surface no error — picker still works */ });
  }

  // Find the TRS row for a given GRN line. Tries the primary
  // grn_item_id lookup first; falls back to material+batch matching
  // for legacy orphans where /grn/save wiped the line ids before the
  // re-link patch was deployed.
  // Resolve the TRS for a given GRN line.
  //   1. Exact grn_item_id link (the normal path).
  //   2. Fallback by material+batch.
  // BUSINESS RULE: when a GRN has multiple lines with the SAME material AND
  // SAME batch number, they share ONE TRS — every such line shows the same
  // TRS number and is marked generated. So the fallback intentionally returns
  // the same TRS for identical lines (e.g. GRN/0017's two "Orange Tango
  // Perfume" 260529079 lines both → TRS .../2). This is correct, not a bug.
  function _trsForLine(line){
    if (!line) return null;
    if (line.grn_item_id && _trsGeneratedByLine[line.grn_item_id]){
      return _trsGeneratedByLine[line.grn_item_id];
    }
    if (!_trsAllForGrn || !_trsAllForGrn.length) return null;
    var lm = (line.material  || '').trim().toLowerCase();
    var lb = (line.batch_num || '').trim();
    if (!lm) return null;
    for (var i = 0; i < _trsAllForGrn.length; i++){
      var t  = _trsAllForGrn[i];
      var tm = (t.material  || '').trim().toLowerCase();
      var tb = (t.batch_num || '').trim();
      if (tm === lm && tb === lb) return t;
    }
    return null;
  }

  function _renderTrsPicker(validLines){
    var html = validLines.map(function(r){
      var l = r.line;
      // Use the fallback-aware resolver so orphaned grn_item_id links
      // (legacy data from before the re-link patch) still produce a
      // ✅ Generated badge.
      var existing = _trsForLine(l);
      var pkgs = parseInt(l.packages) || 0;
      var pq   = parseFloat(l.qty_per_pkg) || 0;
      var totalQty = (pkgs && pq) ? (pkgs * pq).toFixed(3) : '—';
      var meta = [
        l.batch_num ? '<span>Batch: <b>' + esc(l.batch_num) + '</b></span>' : '',
        (pkgs ? '<span><b>' + pkgs + '</b> pkg' + (pkgs===1?'':'s') + '</span>' : ''),
        (totalQty !== '—' ? '<span>Total: <b>' + totalQty + '</b> ' + esc(l.uom||'KG') + '</span>' : ''),
        l.manufacturer ? '<span>Mfr: <b>' + esc(l.manufacturer) + '</b></span>' : '',
      ].filter(Boolean).join('');
      var rid = 'grnTrsRadio-' + r.idx;
      var doneBadge = '';
      if (existing){
        doneBadge = '<span class="lpm-trs-done-badge">'
                  + '<i class="fas fa-check-circle"></i> Generated '
                  + '<span class="lpm-trs-num">' + esc(existing.trs_num || '') + '</span>'
                  + '</span>';
      }
      return '<label class="lpm-item lpm-item-clickable' + (existing ? ' lpm-trs-done' : '') + '" for="' + rid + '">'
        + '<input type="radio" name="grnTrsPick" id="' + rid + '" '
        +   'data-line-idx="' + r.idx + '" '
        +   'onchange="invGrnTrsPick(' + r.idx + ')">'
        + '<div class="lpm-item-body">'
        +   '<div class="lpm-item-name">' + esc(l.material) + '</div>'
        +   '<div class="lpm-item-meta">' + meta + '</div>'
        + '</div>'
        + doneBadge
        + '</label>';
    }).join('');
    document.getElementById('grnTrsItemsList').innerHTML = html;
    _trsUpdateButtonState();
  }

  function _trsUpdateButtonState(){
    var btn   = document.getElementById('grnTrsGenerateBtn');
    var label = document.getElementById('grnTrsGenerateBtnLabel');
    var hint  = document.getElementById('grnTrsSelectedHint');
    if (!btn) return;
    function _setLabel(t){ if (label) label.textContent = t; }
    function _setHint(t){ if (hint) hint.textContent = t; }
    if (_trsPickedLineIdx < 0){
      btn.disabled = true;
      _setLabel('Generate TRS');
      _setHint('No item selected');
      return;
    }
    var l = _grnLines[_trsPickedLineIdx];
    var existing = l && _trsForLine(l);
    btn.disabled = false;
    if (existing){
      _setLabel('Re-print TRS');
      _setHint('Re-print existing slip ' + (existing.trs_num || ''));
    } else {
      _setLabel('Generate TRS');
      _setHint('Generate slip for ' + (l.material || '?'));
    }
  }

  function pickTrs(idx){
    _trsPickedLineIdx = idx;
    _trsUpdateButtonState();
  }

  function closeTrs(){
    // Close both the picker and the fields modal — on success the user
    // wants a clean exit; on cancel the picker close button calls this
    // too so both go away together.
    document.getElementById('grnTrsPickerModal').classList.remove('open');
    document.getElementById('grnTrsFieldsModal').classList.remove('open');
  }
  function closeTrsFields(){
    document.getElementById('grnTrsFieldsModal').classList.remove('open');
  }

  function doGenerateTrs(){
    if (_trsPickedLineIdx < 0) return;
    var line = _grnLines[_trsPickedLineIdx];
    if (!line || !line.grn_item_id){
      _toast('This line has no saved grn_item_id — re-save the GRN', 'error');
      return;
    }
    var existing = _trsForLine(line);
    if (existing){
      // Re-print path: fetch the canonical row (fresh, in case it was
      // updated in another tab) and open the print window.
      fetch('/api/inventory_mgmt/trs/get/' + encodeURIComponent(existing.id))
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.status === 'ok' && d.trs){
            _openTrsPrintWindow(d.trs);
            closeTrs();
          } else {
            _toast(d && d.message ? d.message : 'Could not load TRS', 'error');
          }
        })
        .catch(function(e){ _toast('Network error: ' + e.message, 'error'); });
      return;
    }

    // First-time generate. Decide whether we need to prompt for any of
    // the operator-supplied fields. Today ALL four are operator-supplied
    // (no column on procurement_grn_items for any of them) so we always
    // show the prompt — but we still consult TRS_PROMPT_FIELDS so the
    // code naturally supports adding new sources later.
    var missing = TRS_PROMPT_FIELDS.filter(function(f){
      // Check the line — if a future schema adds columns for any of
      // these, having the value here lets us skip prompting.
      var v = line[f.key];
      return v === undefined || v === null || v === '';
    });
    if (!missing.length){
      _submitTrsGenerate(line.grn_item_id, {});
      return;
    }
    _openTrsFieldsPrompt(line, missing);
  }

  function _openTrsFieldsPrompt(line, missing){
    _trsPendingFields = { grn_item_id: line.grn_item_id, fields: missing };
    var body = document.getElementById('grnTrsFieldsBody');
    var rows = missing.map(function(f){
      var inputHtml;
      if (f.type === 'select'){
        var opts = ['<option value="">— Select —</option>']
          .concat(f.options.map(function(o){
            return '<option value="' + esc(o) + '">' + esc(o) + '</option>';
          }))
          .join('');
        inputHtml = '<select data-trs-field="' + f.key + '">' + opts + '</select>';
      } else if (f.type === 'number'){
        inputHtml = '<input type="number" data-trs-field="' + f.key + '"'
                  + ' step="' + (f.step || 'any') + '"'
                  + (f.min !== undefined ? ' min="' + f.min + '"' : '')
                  + ' placeholder="0.000">';
      } else {
        inputHtml = '<input type="text" data-trs-field="' + f.key + '"'
                  + ' placeholder="' + esc(f.placeholder || '') + '">';
      }
      // Sample Qty + Previous Supplier feel one-line; State + NEW/OLD too.
      // Keep all in a 2-col grid — span the previous supplier full row.
      var fullCls = (f.key === 'previous_supplier') ? ' class="full"' : '';
      return '<div' + fullCls + '>'
        + '<label>' + esc(f.label) + '</label>'
        + inputHtml
        + '</div>';
    }).join('');
    body.innerHTML = '<div class="trs-fields-grid">'
      + '<div class="full" style="font-size:11.5px;color:var(--muted,#6b7280);margin-bottom:-4px">'
      + 'Item: <b style="color:var(--text,#111827)">' + esc(line.material) + '</b>'
      + (line.batch_num ? ' · Batch <b style="color:var(--text,#111827)">' + esc(line.batch_num) + '</b>' : '')
      + '</div>'
      + rows
      + '</div>';
    document.getElementById('grnTrsFieldsModal').classList.add('open');
    // Focus first input
    setTimeout(function(){
      var first = body.querySelector('[data-trs-field]');
      if (first) first.focus();
    }, 30);
  }

  function submitTrsFields(){
    if (!_trsPendingFields) return;
    var body = document.getElementById('grnTrsFieldsBody');
    var data = {};
    body.querySelectorAll('[data-trs-field]').forEach(function(el){
      var k = el.getAttribute('data-trs-field');
      var v = (el.value || '').trim();
      if (v !== '') data[k] = v;
    });
    // Validation: physical_state and new_or_old are required when prompted.
    if (_trsPendingFields.fields.some(function(f){ return f.key === 'physical_state'; })
        && !data.physical_state){
      _toast('Please select Physical State', 'error');
      return;
    }
    if (_trsPendingFields.fields.some(function(f){ return f.key === 'new_or_old'; })
        && !data.new_or_old){
      _toast('Please select NEW or OLD', 'error');
      return;
    }
    var gid = _trsPendingFields.grn_item_id;
    // NOTE: don't close the fields modal yet — _submitTrsGenerate
    // shows a spinner on the Generate button and an error banner
    // inside the modal if anything fails. The modal closes via
    // closeTrs() on the success path inside _submitTrsGenerate.
    _submitTrsGenerate(gid, data);
  }

  function _submitTrsGenerate(grn_item_id, extra){
    var btn = document.getElementById('grnTrsGenerateBtn');
    var lbl = document.getElementById('grnTrsGenerateBtnLabel');
    var fbtn = document.getElementById('grnTrsFieldsSubmitBtn');
    // Save original markup so we can restore on failure.
    var origBtnHtml = btn ? btn.innerHTML : '';
    var origLbl     = lbl ? lbl.textContent : '';
    var origFbtnHtml = fbtn ? fbtn.innerHTML : '';
    function _setBusy(busy){
      if (btn){
        btn.disabled = busy;
        if (busy){
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> '
                        + '<span id="grnTrsGenerateBtnLabel">Generating…</span>';
        } else {
          btn.innerHTML = origBtnHtml;
        }
      }
      if (fbtn){
        fbtn.disabled = busy;
        if (busy){
          fbtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…';
        } else {
          fbtn.innerHTML = origFbtnHtml;
        }
      }
    }
    _setBusy(true);
    // Clear any prior inline error banner.
    var errBanner = document.getElementById('grnTrsErrBanner');
    if (errBanner) errBanner.remove();

    var payload = Object.assign({ grn_item_id: grn_item_id }, extra || {});
    fetch('/api/inventory_mgmt/trs/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    .then(function(r){
      // We need both the status code AND the body to handle errors
      // properly — return both as a tuple-ish object.
      return r.json().then(function(d){ return { http: r.status, d: d }; });
    })
    .then(function(out){
      var d = out.d || {};
      if (out.http === 200 && d.status === 'ok' && d.trs){
        _trsGeneratedByLine[grn_item_id] = d.trs;
        if (_trsAllForGrn) _trsAllForGrn.push(d.trs);
        // Stamp the corresponding GRN line so renderLines() can show the
        // TRS badge in the row-number cell immediately — no refetch.
        var line = _grnLines.find(function(l){ return l.grn_item_id === grn_item_id; });
        if (line){
          line.trs_id     = d.trs.id;
          line.trs_num    = d.trs.trs_num;
          line.trs_status = d.trs.approval_status || 'Pending';
          renderLines();
        }
        // Restore the Generate/Submit buttons BEFORE closing. Without this
        // the button stays disabled + stuck on the "Generating…" spinner,
        // so generating a TRS for a SECOND line in the same GRN was blocked
        // until a full page refresh rebuilt the modal. (Bug fix.)
        _setBusy(false);
        _trsPickedLineIdx = -1;
        _toast('✓ TRS generated: ' + (d.trs.trs_num || ''), 'success', 3500);
        _openTrsPrintWindow(d.trs);
        closeTrs();
      } else {
        _setBusy(false);
        // Build a clear, persistent error message:
        //  - 401: session expired — they should re-login
        //  - 403: permission denied — show specific message
        //  - 500: server bug — show traceback message if present
        //  - other: generic with the server's text
        var msg = d.message || ('Server error ' + out.http);
        var hint = '';
        if (out.http === 401){
          hint = 'Your session may have expired — try refreshing the page and logging in again.';
        } else if (out.http === 403){
          hint = 'You don\u2019t have permission to generate TRS slips. Ask an admin to grant you GRN access in User Access Control.';
        } else if (out.http === 500){
          hint = 'A server error occurred. Share this message with an admin so they can check the Flask log:';
        }
        _showTrsErrBanner(msg, hint, d.error_type);
        // Still toast — but the banner is what the user reads.
        _toast(msg, 'error', 6000);
      }
    })
    .catch(function(e){
      _setBusy(false);
      _showTrsErrBanner(
        'Network error: ' + (e && e.message ? e.message : 'unknown'),
        'The request couldn\u2019t reach the server. Check your connection and try again.',
        null
      );
      _toast('Network error: ' + e.message, 'error', 6000);
    });
  }

  // Persistent inline error banner inside the picker modal. Survives
  // until the next attempt or the modal is closed, so non-admin users
  // can actually read the failure reason instead of a toast that
  // disappears after 6 seconds.
  function _showTrsErrBanner(message, hint, errorType){
    // Pick a host element: the picker modal body if visible, else the
    // fields modal body if visible.
    var picker  = document.getElementById('grnTrsPickerModal');
    var fields  = document.getElementById('grnTrsFieldsModal');
    var hostBody = null;
    if (fields && fields.classList.contains('open')){
      hostBody = document.getElementById('grnTrsFieldsBody');
    } else if (picker && picker.classList.contains('open')){
      hostBody = document.getElementById('grnTrsItemsList');
    }
    if (!hostBody) return;
    var existing = document.getElementById('grnTrsErrBanner');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = 'grnTrsErrBanner';
    banner.style.cssText = [
      'margin:10px 0',
      'padding:11px 14px',
      'background:rgba(220,38,38,.08)',
      'border:1px solid rgba(220,38,38,.32)',
      'border-radius:8px',
      'font-size:12px',
      'color:#991b1b',
      'display:flex',
      'gap:10px',
      'align-items:flex-start',
    ].join(';');
    var et = errorType ? ' <code style="background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;font-size:10.5px">' + esc(errorType) + '</code>' : '';
    banner.innerHTML =
      '<i class="fas fa-triangle-exclamation" style="font-size:14px;color:#dc2626;margin-top:2px"></i>'
      + '<div style="flex:1">'
      +   '<div style="font-weight:700;margin-bottom:3px">TRS generation failed' + et + '</div>'
      +   (hint ? '<div style="font-size:11.5px;color:#7f1d1d;margin-bottom:4px">' + esc(hint) + '</div>' : '')
      +   '<div style="font-family:JetBrains Mono,monospace;font-size:11px;color:#7f1d1d;word-break:break-word">' + esc(message) + '</div>'
      + '</div>'
      + '<button onclick="this.parentElement.remove()" style="border:0;background:transparent;color:#991b1b;cursor:pointer;font-size:14px;padding:0 4px">&times;</button>';
    hostBody.parentNode.insertBefore(banner, hostBody);
    // Log to console too — non-admins reporting issues can be asked to
    // open DevTools and paste this line.
    console.error('[TRS] Generate failed:', { message: message, errorType: errorType, hint: hint });
  }

  function _openTrsPrintWindow(trs){
    // Build a printable HTML document themed to match the system
    // (HCP purple header bar, system font stack, bordered tables) but
    // structured like the reference TRS slip. Opens in a new window
    // and triggers the browser print dialog.
    var html = _buildTrsPrintHtml(trs);
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win){
      _toast('Pop-up blocked — allow pop-ups to print TRS', 'error', 5000);
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  function _buildTrsPrintHtml(t){
    function v(x){ return (x === null || x === undefined || x === '') ? '—' : String(x); }
    function num(x){
      if (x === null || x === undefined || x === '') return '—';
      var n = parseFloat(x);
      if (!isFinite(n)) return v(x);
      return n.toFixed(3).replace(/\.?0+$/, '');
    }
    var today = (new Date()).toISOString().slice(0,10);
    return ''
+ '<!DOCTYPE html><html><head><meta charset="utf-8">'
+ '<title>TRS ' + esc(t.trs_num || '') + '</title>'
+ '<style>'
+ '  *{box-sizing:border-box}'
+ '  body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
+ '       color:#111827;margin:0;padding:24px;background:#fff;font-size:12px}'
+ '  .sheet{max-width:780px;margin:0 auto;border:2px solid #111827}'
+ '  .head{display:grid;grid-template-columns:130px 1fr;'
+ '        border-bottom:2px solid #111827}'
+ '  .head .logo{padding:14px;border-right:2px solid #111827;'
+ '        display:flex;align-items:center;justify-content:center;'
+ '        font-weight:900;font-size:20px;color:#1e3a8a;letter-spacing:-1px}'
+ '  .head .logo small{display:block;font-size:8px;letter-spacing:.6px;'
+ '        color:#374151;margin-top:2px;font-weight:600}'
+ '  .head .title{padding:14px;display:flex;flex-direction:column;'
+ '        align-items:center;justify-content:center;text-align:center}'
+ '  .head .title h1{margin:0;font-size:16px;letter-spacing:1px;'
+ '        font-weight:800}'
+ '  .head .title .qr{margin-top:6px;font-size:11.5px;font-weight:700;'
+ '        color:#374151}'
+ '  table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}'
+ '  td{border:1px solid #111827;padding:8px 10px;vertical-align:middle;'
+ '      word-wrap:break-word;overflow-wrap:break-word}'
+ '  .lbl{background:#f9fafb;font-weight:700;white-space:nowrap}'
+ '  .lbl-narrow{}'
+ '  .center{text-align:center}'
+ '  .nowrap{white-space:nowrap}'
+ '  .pv-head td{background:#f3f4f6;font-weight:700;text-align:center;'
+ '        letter-spacing:1px}'
+ '  .sign-row td{height:42px}'
+ '  .actions{max-width:780px;margin:14px auto 0;display:flex;'
+ '        gap:10px;justify-content:flex-end}'
+ '  .btn{padding:8px 16px;font-size:12px;font-weight:700;'
+ '       border:1px solid #4338ca;border-radius:6px;cursor:pointer;'
+ '       background:#4338ca;color:#fff}'
+ '  .btn-ghost{background:#fff;color:#4338ca}'
+ '  @media print{ .actions{display:none} body{padding:0} }'
+ '</style></head><body>'
+ '<div class="sheet">'
+ '  <div class="head">'
+ '    <div class="logo">HCP'
+ '      <small style="display:block">WELLNESS PVT. LTD.</small>'
+ '    </div>'
+ '    <div class="title">'
+ '      <h1>TESTING REQUISITION SLIP (TRS)</h1>'
+ '    </div>'
+ '  </div>'
+ '  <table>'
+ '    <colgroup>'
+ '      <col style="width:19%">'   /* labels (TRS No / Name / GRN / Mfg ...) */
+ '      <col style="width:14%">'   /* 1st value start */
+ '      <col style="width:14%">'   /* 1st value continuation */
+ '      <col style="width:19%">'   /* 2nd label (Date / GRN Date / Total Qty ...) */
+ '      <col style="width:17%">'   /* 2nd value start */
+ '      <col style="width:17%">'   /* 2nd value end (also holds bottom-right Date) */
+ '    </colgroup>'
+ '    <tr><td class="lbl">TRS No</td><td>' + esc(t.trs_num || '') + '</td>'
+ '        <td class="lbl">Date</td><td class="nowrap">' + _trsFmtDate(today) + '</td>'
+ '        <td class="lbl">Department</td><td>R M STORE</td></tr>'
+ '    <tr>'
+ '      <td class="lbl">Name of Sample</td>'
+ '      <td colspan="5">' + esc(v(t.material)) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Batch No / Product Code</td>'
+ '      <td colspan="2">' + esc(v(t.batch_num)) + '</td>'
+ '      <td class="lbl">No of Pkt / Label</td>'
+ '      <td colspan="2" class="center">' + v(t.packages) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">GRN No</td>'
+ '      <td colspan="2">' + esc(v(t.grn_num)) + '</td>'
+ '      <td class="lbl">GRN Date</td>'
+ '      <td colspan="2" class="nowrap">' + _trsFmtDate(t.grn_date) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Physical State</td>'
+ '      <td colspan="2">' + esc(v(t.physical_state)) + '</td>'
+ '      <td class="lbl">Total Qty (in ' + esc(t.uom || 'KG') + ')</td>'
+ '      <td colspan="2" class="center">' + num(t.total_qty) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Sample Qty (in ' + esc(t.uom || 'KG') + ')</td>'
+ '      <td colspan="5" class="center">' + num(t.sample_qty) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Mfg. Name</td>'
+ '      <td colspan="2">' + esc(v(t.manufacturer)) + '</td>'
+ '      <td class="lbl">Mfg. Date</td>'
+ '      <td colspan="2" class="nowrap">' + _trsFmtDate(t.mfg_date) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Supplier Name</td>'
+ '      <td colspan="2">' + esc(v(t.supplier_name)) + '</td>'
+ '      <td class="lbl">Expiry Date</td>'
+ '      <td colspan="2" class="nowrap">' + _trsFmtDate(t.expiry_date) + '</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="lbl">Previous Supplier</td>'
+ '      <td colspan="2">' + esc(v(t.previous_supplier)) + '</td>'
+ '      <td class="lbl">NEW / OLD Material</td>'
+ '      <td colspan="2" class="center"><b>' + esc(v(t.new_or_old)) + '</b></td>'
+ '    </tr>'
+ '    <tr class="pv-head">'
+ '      <td colspan="6">PHYSICAL VERIFICATION</td>'
+ '    </tr>'
+ '    <tr>'
+ '      <td class="center" style="width:60px"><b>Sr No</b></td>'
+ '      <td colspan="2"><b>Parameter</b></td>'
+ '      <td colspan="3" class="center"><b>Observation</b></td>'
+ '    </tr>'
+ '    <tr><td class="center">1</td><td colspan="2">Appearance</td><td colspan="3"></td></tr>'
+ '    <tr><td class="center">2</td><td colspan="2">Odour</td><td colspan="3"></td></tr>'
+ '    <tr><td class="center">3</td><td colspan="2">COA Availability</td><td colspan="3"></td></tr>'
+ '    <tr class="sign-row">'
+ '      <td class="lbl">Verified By</td>'
+ '      <td colspan="2">' + esc(v(t.verified_by)) + '</td>'
+ '      <td colspan="2"></td>'
+ '      <td class="nowrap center">' + _trsFmtDate(today) + '</td>'
+ '    </tr>'
+ '    <tr class="sign-row pv-head">'
+ '      <td></td>'
+ '      <td colspan="2">Name of Incharge</td>'
+ '      <td colspan="2">Sign</td>'
+ '      <td>Date</td>'
+ '    </tr>'
+ '  </table>'
+ '</div>'
+ '<div class="actions">'
+ '  <button class="btn btn-ghost" onclick="window.close()">Close</button>'
+ '  <button class="btn" onclick="window.print()">Print</button>'
+ '</div>'
+ '<!-- No auto-print: opening the OS print dialog over a slow VNC link'
+ '     stalls the whole window. The Print button above triggers it on'
+ '     demand when the operator actually wants to print. -->'
+ '</body></html>';
  }


  window.invGrnLoadList         = loadList;
  window.invGrnApplyFilter      = applyFilter;
  window.invGrnOpenForm         = openForm;
  window.invGrnOpenFormByIdx    = openFormByIdx;
  window.invGrnOpenById         = openById;
  window.invGrnCloseForm        = closeForm;
  window.invGrnSave             = save;
  window.invGrnDeleteCurrent    = deleteCurrent;
  window.invGrnDelete           = deleteByIdx;
  window.invGrnPrint            = printGrn;
  window.invGrnPrintWithPos     = printGrnWithPos;
  window.invGrnTogglePrintMenu  = togglePrintMenu;
  window.invGrnClosePrintMenu   = closePrintMenu;
  window.invGrnVoucherTypeChange= voucherTypeChange;
  window.invGrnPoChange         = poChange;
  window.invGrnAddManualInvoice = addManualInvoice;
  window.invGrnRemoveInvoice    = removeInvoice;
  window.invGrnAddLine          = addLine;
  window.invGrnToggleCharge     = toggleCharge;
  window.invGrnCalcTotal        = calcTotal;
  window.invGrnCalcLineTotal    = calcLineTotal;
  // File attachment handlers (COA per line, Invoice per GRN).
  window.invGrnPickCoaFile      = pickCoaFile;
  window.invGrnPickInvoiceFile  = pickInvoiceFile;
  window.invGrnDeleteFile       = deleteFile;
  // Label printing
  window.invGrnOpenLabelPrint   = openLabelPrint;
  window.invGrnCloseLabelPrint  = closeLabelPrint;
  window.invGrnLabelToggle      = labelToggle;
  window.invGrnLabelSelectAll   = labelSelectAll;
  window.invGrnDoLabelPrint     = doLabelPrint;
  // Supplier-filtered PO picker
  window.invGrnPoFilterInput    = poPickerInput;
  window.invGrnPoFilterFocus    = poPickerFocus;
  window.invGrnPoFilterBlur     = poPickerBlur;

  // Other Details + Checklist
  window.invGrnOpenOtherDetails  = openOtherDetails;
  window.invGrnCloseOtherDetails = closeOtherDetails;
  window.invGrnSaveOtherDetails  = saveOtherDetails;
  window.invGrnOpenChecklist     = openChecklist;
  window.invGrnCloseChecklist    = closeChecklist;
  window.invGrnSaveChecklist     = saveChecklist;
  window.invGrnChkSet            = chkSet;
  window.invGrnChkSetRemark      = chkSetRemark;

  // TRS (Testing Requisition Slip)
  window.invGrnOpenTrs           = openTrs;
  window.invGrnCloseTrs          = closeTrs;
  window.invGrnTrsPick           = pickTrs;
  window.invGrnDoGenerateTrs     = doGenerateTrs;
  window.invGrnCloseTrsFields    = closeTrsFields;
  window.invGrnSubmitTrsFields   = submitTrsFields;

})();
