/* fvq_viewer.js — Formulations: display, search, nav, rename, print, radial
   Depends on: utils.js, app.js */

/* ══════════════════════════════════════════════════════
   FORMULATIONS VS QTY
══════════════════════════════════════════════════════ */
let _fvqBatches=[], _fvqFiltered=[], _fvqDetail=[], _fvqDetailFiltered=[];
let _fvqSelectedBatches = new Set(); // persists across pages
let _fvqPage=1, _fvqPageSize=25;
let _fvqBasename='', _fvqDetailBatch=null;
// Brand management globals
let _fvqBrands      = [];
let _fvqBrandFilter = '';
let _brandReportData= [];
let _brActiveBrandId= null;
let _manualIngredients = [];
let _manualMode        = 'create';  // 'create' | 'link'
let _manualInputMode   = 'pct';     // 'pct' | 'qty'

/* ── open file dialog ── */
let _fvqImportBothMode = false;
function openFvqImportBoth(){
    _fvqImportBothMode = true;
    let inp = document.getElementById('_fvqFileInputBoth');
    if(!inp){
        inp = document.createElement('input');
        inp.type='file'; inp.id='_fvqFileInputBoth'; inp.accept='.xlsx'; inp.style.display='none';
        inp.addEventListener('change', e=>{ if(e.target.files[0]) fvqInspectFile(e.target.files[0]); e.target.value=''; });
        document.body.appendChild(inp);
    }
    inp.click();
}
function openFvqImport(){
    _fvqImportBothMode = false;
    let inp=document.getElementById('_fvqFileInput');
    if(!inp){
        inp=document.createElement('input');
        inp.type='file'; inp.id='_fvqFileInput'; inp.accept='.xlsx'; inp.style.display='none';
        inp.addEventListener('change',e=>{if(e.target.files[0])fvqInspectFile(e.target.files[0]);e.target.value='';});
        document.body.appendChild(inp);
    }
    inp.click();
}

/* ── Step 1: inspect ── */
// stores last File for Refresh button
let _lastFvqFile        = null;
// stores sheet ingredients from inspect for dupe check
let _fvqSheetIngredients = {};

async function fvqInspectFile(file){
    _lastFvqFile         = file;
    _fvqBasename         = file.name.replace(/\.xlsx$/i,'');
    _fvqSheetIngredients = {};
    document.getElementById('fvqFileName').textContent    = file.name;
    document.getElementById('fvqSheetCount').textContent  = 'Reading file…';
    document.getElementById('fvqReadingIndicator').style.display = 'flex';
    document.getElementById('fvqSheetList').style.display        = 'none';
    const btn = document.getElementById('fvqImportBtn');
    btn.disabled=true; btn.style.opacity='.45'; btn.style.cursor='not-allowed';
    document.getElementById('fvqSelectedCount').textContent = '0 worksheets selected';
    // Populate brand selector in import modal
    const _importBrandSel = document.getElementById('fvqImportBrandSel');
    if(_importBrandSel){
        _importBrandSel.innerHTML = '<option value="">— No Brand (assign later) —</option>'
            + (_fvqBrands||[]).map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
        if(typeof comboboxRefresh==='function') comboboxRefresh(_importBrandSel);
    }
    document.getElementById('fvqSheetModal').classList.add('open');

    const fd = new FormData(); fd.append('file', file);
    try{
        const res  = await fetch('/api/procurement/formulations/inspect',{method:'POST',body:fd});
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);

        _fvqBasename         = data.basename;
        _fvqSheetIngredients = data.sheet_ingredients||{};

        const validSheets   = data.sheets||[];
        const invalidSheets = data.invalid_sheets||{};
        const totalSheets   = validSheets.length + Object.keys(invalidSheets).length;

        document.getElementById('fvqSheetCount').textContent =
            `${validSheets.length} valid · ${Object.keys(invalidSheets).length} invalid · ${totalSheets} total`;
        document.getElementById('fvqSheetModalSub').textContent =
            `${data.basename} · ${totalSheets} sheet${totalSheets!==1?'s':''}`;

        function _autoBatchName(sheet){
            const base = _fvqBasename;
            if(sheet.trim().toLowerCase().split(/\s+/).every(w=>base.toLowerCase().includes(w.toLowerCase())))
                return base;
            return base + ' – ' + sheet;
        }

        const list = document.getElementById('fvqCheckboxList');

        // Valid sheets
        const validHtml = validSheets.map(s=>`
            <div class="sheet-item checked" data-sheet="${escHtml(s)}" onclick="fvqToggleSheet(this)">
                <div style="display:flex;align-items:center;gap:8px;width:100%">
                    <div class="sheet-cb">✓</div>
                    <div style="flex:1;min-width:0">
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            <span class="sheet-name">${escHtml(s)}</span>
                            <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;
                                         background:var(--teal-glow);color:var(--teal);
                                         border:1px solid rgba(0,201,177,.25)">✓ Valid</span>
                            <span id="dupeBadge_${escHtml(s.replace(/[^a-z0-9]/gi,'_'))}"
                                  style="display:none;font-size:9px;font-weight:700;padding:1px 7px;
                                         border-radius:20px;background:var(--amber-bg);color:var(--amber-text);
                                         border:1px solid rgba(245,158,11,.3)">⚠ Duplicate</span>
                        </div>
                        <input class="fvq-bname-input"
                               data-sheet="${escHtml(s)}"
                               value="${escHtml(_autoBatchName(s))}"
                               placeholder="Batch name…"
                               onclick="event.stopPropagation()"
                               oninput="_fvqOnBatchNameChange(this,'${escHtml(s).replace(/'/g,"\\'")}')"
                               style="width:100%;margin-top:4px;height:26px;padding:0 8px;
                                      border-radius:4px;border:1px solid var(--border2);
                                      background:var(--surface);color:var(--text);
                                      font-family:var(--font-mono);font-size:10.5px;outline:none"
                               onfocus="this.style.borderColor='var(--teal-dim)'"
                               onblur="this.style.borderColor='var(--border2)'">
                        <div id="dupeDetail_${escHtml(s.replace(/[^a-z0-9]/gi,'_'))}"
                             style="display:none;margin-top:3px;font-size:10px;color:var(--amber-text)"></div>
                    </div>
                </div>
            </div>`).join('');

        // Invalid sheets
        const invalidHtml = Object.entries(invalidSheets).map(([s,reason])=>`
            <div class="sheet-item" data-sheet="${escHtml(s)}" data-invalid="1"
                 style="opacity:.7;cursor:not-allowed;pointer-events:none;
                        border-color:rgba(244,63,94,.3);background:rgba(244,63,94,.04)">
                <div style="display:flex;align-items:flex-start;gap:8px;width:100%">
                    <div class="sheet-cb" style="background:var(--red-bg);border-color:rgba(244,63,94,.4);
                                                  color:var(--red-text);font-size:11px">✕</div>
                    <div style="flex:1;min-width:0">
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            <span class="sheet-name" style="color:var(--red-text)">${escHtml(s)}</span>
                            <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;
                                         background:var(--red-bg);color:var(--red-text);
                                         border:1px solid rgba(244,63,94,.3)">✕ Invalid Structure</span>
                        </div>
                        <div style="margin-top:4px;font-size:10.5px;color:var(--red-text);line-height:1.5">
                            ⚠ ${escHtml(reason)}
                        </div>
                        <div style="margin-top:4px;padding:4px 8px;border-radius:4px;
                                    background:var(--text-05);font-size:10px;color:var(--muted)">
                            Expected: Col A row 13 = 1 &middot; Col B = Ingredient &middot;
                            Col C = Supplier &middot; Col D = % w/w &middot; Col E = Qty KG
                        </div>
                    </div>
                </div>
            </div>`).join('');

        list.innerHTML = validHtml + invalidHtml;

        if(Object.keys(invalidSheets).length > 0){
            const n = Object.keys(invalidSheets).length;
            toast(`${n} sheet${n>1?'s have':' has'} invalid structure and will be skipped`, 'warning', 6000);
        }

        document.getElementById('fvqReadingIndicator').style.display = 'none';
        document.getElementById('fvqSheetList').style.display        = 'flex';

        // Show Refresh button
        const rfBtn = document.getElementById('fvqSheetRefreshBtn');
        if(rfBtn) rfBtn.style.display = 'inline-flex';

        fvqUpdateImportBtn();

        // Run duplicate check for valid sheets
        if(validSheets.length > 0) _fvqRunDupeCheck(validSheets, _autoBatchName);

    }catch(err){
        document.getElementById('fvqReadingIndicator').style.display = 'none';
        document.getElementById('fvqSheetList').style.display        = 'flex';
        document.getElementById('fvqCheckboxList').innerHTML =
            `<div style="grid-column:1/-1;padding:16px;color:var(--red-text);font-size:12px">❌ ${escHtml(err.message)}</div>`;
        toast('Failed: '+err.message,'error');
    }
}

// Tracks which sheets are in "link mode": { sheetName: matchingBatchName }
const _fvqLinkMode = {};

async function _fvqRunDupeCheck(sheets, autoBatchNameFn){
    try{
        const payload = sheets.map(s=>({
            batch_name:  document.querySelector(`.fvq-bname-input[data-sheet="${escHtml(s)}"]`)?.value
                         || autoBatchNameFn(s),
            ingredients: (_fvqSheetIngredients[s]||[])
        }));
        const res  = await fetch('/api/procurement/formulations/check_duplicates',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({sheets: payload})
        });
        const data = await res.json();
        if(data.status!=='ok') return;
        let dupeCount = 0;
        (data.results||[]).forEach((r,idx)=>{
            const sheet  = sheets[idx];
            const safeId = (sheet||'').replace(/[^a-z0-9]/gi,'_');
            const badge  = document.getElementById('dupeBadge_'  + safeId);
            const detail = document.getElementById('dupeDetail_' + safeId);
            if(!badge) return;

            if(r.exact_exists){
                // HARD BLOCK — batch name already exists, no import or link allowed
                dupeCount++;
                badge.style.display='inline-block'; badge.textContent='🚫 Already Exists';
                badge.style.background='var(--red-bg)'; badge.style.color='var(--red-text)';
                badge.style.border='1px solid rgba(244,63,94,.4)';
                const si=badge.closest('.sheet-item');
                if(si){
                    si.classList.remove('checked'); si.style.pointerEvents='none';
                    si.style.opacity='.55'; si.style.borderColor='rgba(244,63,94,.4)';
                    si.style.background='rgba(244,63,94,.04)';
                    const cb=si.querySelector('.sheet-cb');
                    if(cb){cb.textContent='🚫';cb.style.background='var(--red-bg)';cb.style.color='var(--red-text)';}
                    const inp2=si.querySelector('.fvq-bname-input'); if(inp2) inp2.disabled=true;
                }
                delete _fvqLinkMode[safeId];
                if(detail){
                    detail.style.display='block'; detail.dataset.exactBlocked='1';
                    detail.innerHTML='<div style="padding:5px 8px;border-radius:4px;background:var(--red-bg);border:1px solid rgba(244,63,94,.3);font-size:10px;color:var(--red-text);font-weight:600">🚫 Import blocked — <strong>'+escHtml(r.batch_name||'')+'</strong> already exists. Rename the batch above to import as new.</div>';
                }
            } else if(r.is_duplicate){
                dupeCount++;
                badge.style.display = 'inline-block';
                if(detail){
                    detail.style.display = 'block';
                    detail.dataset.exactBlocked = '';
                    const matchName = r.matching_batch || '';
                    const isLinked  = !!_fvqLinkMode[safeId];
                    detail.dataset.matchName = matchName;
                    detail.dataset.sheet     = sheet;
                    detail.innerHTML = `
                        <div style="margin-bottom:5px;color:var(--amber-text);font-size:10px">
                            ⚠ Identical ingredients as <strong>${escHtml(matchName)}</strong>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <div style="display:flex;border-radius:20px;overflow:hidden;border:1px solid rgba(139,92,246,.35);font-size:10px;font-weight:700">
                                <button id="fvqDupeModeImport_${safeId}"
                                        onclick="event.stopPropagation();_fvqSetDupeModeById('${safeId}','import')"
                                        style="padding:3px 10px;border:none;cursor:pointer;font-size:10px;font-weight:700;font-family:var(--font-body);transition:all .15s;background:${isLinked?'transparent':'var(--amber-bg)'};color:${isLinked?'var(--muted)':'var(--amber-text)'}">
                                    ↓ Import (new entry)
                                </button>
                                <button id="fvqDupeModeLink_${safeId}"
                                        onclick="event.stopPropagation();_fvqSetDupeModeById('${safeId}','link')"
                                        style="padding:3px 10px;border:none;cursor:pointer;font-size:10px;font-weight:700;font-family:var(--font-body);transition:all .15s;background:${isLinked?'rgba(139,92,246,.2)':'transparent'};color:${isLinked?'#a78bfa':'var(--muted)'}">
                                    🔗 Link to existing
                                </button>
                            </div>
                            <span id="fvqLinkLabel_${safeId}" style="font-size:9.5px;color:#a78bfa;display:${isLinked?'inline':'none'}">
                                Will link to: <strong>${escHtml(matchName)}</strong>
                            </span>
                        </div>`;
                }
            } else {
                delete _fvqLinkMode[safeId];
                badge.style.display = 'none';
                if(detail){ detail.style.display='none'; detail.dataset.exactBlocked=''; }
                const si2=badge.closest('.sheet-item');
                if(si2){
                    si2.style.pointerEvents=''; si2.style.opacity=''; si2.style.borderColor=''; si2.style.background='';
                    const cb2=si2.querySelector('.sheet-cb'); if(cb2){cb2.textContent='✓';cb2.style.background='';cb2.style.color='';}
                    const inp3=si2.querySelector('.fvq-bname-input'); if(inp3) inp3.disabled=false;
                }
            }
        });
        if(dupeCount > 0)
            toast(`${dupeCount} duplicate${dupeCount>1?'s':''} found — choose Import or Link for each`, 'warning', 5000);
    }catch(e){ /* best-effort */ }
}

function _fvqSetDupeModeById(safeId, mode){
    const detail    = document.getElementById('dupeDetail_' + safeId);
    const sheet     = detail?.dataset.sheet     || '';
    const matchName = detail?.dataset.matchName || '';
    const isLink    = mode === 'link';
    if(isLink)
        _fvqLinkMode[safeId] = { newName: '', sourceName: matchName, sheet: sheet };
    else
        delete _fvqLinkMode[safeId];

    // Update button styles
    const importBtn = document.getElementById('fvqDupeModeImport_' + safeId);
    const linkBtn   = document.getElementById('fvqDupeModeLink_'   + safeId);
    if(importBtn){
        importBtn.style.background = isLink ? 'transparent' : 'var(--amber-bg)';
        importBtn.style.color      = isLink ? 'var(--muted)' : 'var(--amber-text)';
    }
    if(linkBtn){
        linkBtn.style.background = isLink ? 'rgba(139,92,246,.2)' : 'transparent';
        linkBtn.style.color      = isLink ? '#a78bfa' : 'var(--muted)';
    }

    // Show/hide "Will link to" label
    const label = document.getElementById('fvqLinkLabel_' + safeId);
    if(label) label.style.display = isLink ? 'inline' : 'none';

    fvqUpdateImportBtn();
}

let _fvqDupeCheckTimer = null;
function _fvqOnBatchNameChange(inp, sheet){
    clearTimeout(_fvqDupeCheckTimer);
    _fvqDupeCheckTimer = setTimeout(()=>{
        const validSheets = [...document.querySelectorAll('#fvqCheckboxList .sheet-item:not([data-invalid])')].map(el=>el.dataset.sheet);
        const fn = s => document.querySelector(`.fvq-bname-input[data-sheet="${escHtml(s)}"]`)?.value || s;
        _fvqRunDupeCheck(validSheets, fn);
    }, 600);
}

function fvqRefreshInspect(){
    if(!_lastFvqFile){ toast('No file loaded — please upload the file again','warning'); return; }
    const rfBtn = document.getElementById('fvqSheetRefreshBtn');
    if(rfBtn){
        rfBtn.disabled=true; rfBtn.style.opacity='.5';
        rfBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.2" style="animation:spin 1s linear infinite">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg> Scanning…`;
    }
    fvqInspectFile(_lastFvqFile).finally(()=>{
        if(rfBtn){
            rfBtn.disabled=false; rfBtn.style.opacity='1';
            rfBtn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg> Refresh`;
        }
    });
}
function fvqToggleSheet(el){
    const det=el.querySelector('[id^="dupeDetail_"]');
    if(det && det.dataset.exactBlocked==='1') return;
    el.classList.toggle('checked'); fvqUpdateImportBtn();
}
function fvqToggleSelectAll(cb){
    const checked = cb.checked;
    if(checked){
        // Select every batch in the current filtered set (all pages)
        (_fvqFiltered||[]).forEach(b=>_fvqSelectedBatches.add(b.batch_name));
    } else {
        _fvqSelectedBatches.clear();
        _fvqHideAllPagesNote();
    }
    // Reflect on visible checkboxes
    document.querySelectorAll('.fvq-row-cb').forEach(c=>{
        c.checked = checked;
        if(checked) _fvqSelectedBatches.add(c.dataset.batch);
    });
    _fvqSyncBulkBar();
    if(checked && (_fvqFiltered||[]).length > (_fvqPageSize||25)){
        _fvqShowAllPagesNote();
    }
}

function _fvqShowAllPagesNote(){
    let note = document.getElementById('fvqAllPagesNote');
    const total = (_fvqFiltered||[]).length;
    const sel   = _fvqSelectedBatches.size;
    if(!note){
        note = document.createElement('div');
        note.id = 'fvqAllPagesNote';
        note.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;padding:7px 16px;'
            +'background:rgba(20,184,166,.10);border-bottom:1px solid rgba(20,184,166,.25);'
            +'font-size:11.5px;color:var(--teal);font-weight:500;';
        const tableWrap = document.getElementById('fvqTableWrap') || document.querySelector('#tc-fvq .table-wrap');
        if(tableWrap) tableWrap.parentNode.insertBefore(note, tableWrap);
    }
    note.innerHTML = '<span>All <strong>'+sel+'</strong> formulations across all pages are selected.</span>'
        +'<button onclick="_fvqClearAllSelection()" style="margin-left:4px;padding:2px 10px;border-radius:5px;'
        +'border:1px solid rgba(20,184,166,.4);background:transparent;color:var(--teal);font-size:11px;cursor:pointer;font-weight:600">Clear selection</button>';
    note.style.display = 'flex';
}

function _fvqHideAllPagesNote(){
    const note = document.getElementById('fvqAllPagesNote');
    if(note) note.style.display = 'none';
}

function _fvqClearAllSelection(){
    _fvqSelectedBatches.clear();
    document.querySelectorAll('.fvq-row-cb').forEach(c=>c.checked=false);
    const sa = document.getElementById('fvqSelectAll'); if(sa) sa.checked=false;
    _fvqHideAllPagesNote();
    _fvqSyncBulkBar();
}

function _fvqSyncBulkBar(){
    const any = _fvqSelectedBatches.size > 0;
    const bar  = document.getElementById('fvqBulkBrandBar');
    const bsel = document.getElementById('fvqBulkBrandSel');
    if(bar) bar.style.display = any ? 'inline-flex' : 'none';
    const lbl = document.getElementById('fvqBulkSelCount');
    if(lbl) lbl.textContent = any ? _fvqSelectedBatches.size+' selected:' : 'Brand selected rows:';
    const opts = '<option value="">— No Brand —</option>'
        +(_fvqBrands||[]).map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
    ['fvqBulkBrandSel','fvqBulkBrandBarSel'].forEach(sid=>{
        const s=document.getElementById(sid); if(s&&any) { s.innerHTML=opts; if(typeof comboboxRefresh==='function') comboboxRefresh(s); }
    });
}

function fvqSelectAll(v){
    document.querySelectorAll('#fvqCheckboxList .sheet-item').forEach(el=>{
        if(v){
            const det=el.querySelector('[id^="dupeDetail_"]');
            if(det && det.dataset.exactBlocked==='1') return;
            el.classList.add('checked');
        } else { el.classList.remove('checked'); }
    });
    fvqUpdateImportBtn();
}
function fvqUpdateImportBtn(){
    const sel=[...document.querySelectorAll('#fvqCheckboxList .sheet-item.checked')];
    const n=sel.length; const btn=document.getElementById('fvqImportBtn');
    document.getElementById('fvqSelectedCount').textContent=`${n} worksheet${n!==1?'s':''} selected`;
    if(n>0){
        btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';
        const linkCount   = Object.keys(_fvqLinkMode||{}).length; // keyed by safeId
        const importCount = n - linkCount;
        if(linkCount>0 && importCount>0)
            btn.textContent=`Import ${importCount} + Link ${linkCount}`;
        else if(linkCount>0)
            btn.textContent=`Link ${linkCount} Batch${linkCount>1?'es':''}`;
        else
            btn.textContent=`Import ${n} Sheet${n!==1?'s':''}`;
    }
    else{btn.disabled=true;btn.style.opacity='.45';btn.style.cursor='not-allowed';btn.textContent='Import Selected';}
}
function closeFvqSheetModal(){document.getElementById('fvqSheetModal').classList.remove('open');}
document.getElementById('fvqSheetModal')?.addEventListener('click',e=>{if(e.target===document.getElementById('fvqSheetModal'))closeFvqSheetModal();});

/* Shows a blocking OK-dismiss alert for import failures */
function _fvqImportAlert(title, message){
    var existing = document.getElementById('fvqImportAlertModal');
    if(!existing){
        var el = document.createElement('div');
        el.id = 'fvqImportAlertModal';
        el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);align-items:center;justify-content:center;';
        el.innerHTML =
            '<div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;max-width:520px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden">' +
              '<div style="background:rgba(244,63,94,.1);border-bottom:1px solid rgba(244,63,94,.25);padding:14px 18px;display:flex;align-items:center;gap:10px">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
                '<span id="fvqImportAlertTitle" style="font-weight:700;font-size:14px;color:var(--text)"></span>' +
              '</div>' +
              '<div id="fvqImportAlertBody" style="padding:16px 18px;font-size:12px;line-height:1.75;color:var(--text);white-space:pre-wrap;max-height:340px;overflow-y:auto;font-family:var(--font-mono)"></div>' +
              '<div style="padding:12px 18px;border-top:1px solid var(--border2);display:flex;justify-content:flex-end">' +
                '<button onclick="document.getElementById(\'fvqImportAlertModal\').style.display=\'none\'" ' +
                  'style="padding:7px 24px;border-radius:7px;border:none;background:var(--teal);color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:var(--font-body)">OK</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(el);
        existing = el;
    }
    document.getElementById('fvqImportAlertTitle').textContent = title;
    document.getElementById('fvqImportAlertBody').textContent  = message;
    existing.style.display = 'flex';
}

/* ── Step 2: import ── */
async function confirmFvqImport(){
    const checkedItems=[...document.querySelectorAll('#fvqCheckboxList .sheet-item.checked')];
    if(!checkedItems.length){toast('Select at least one worksheet','warning');return;}

    // HARD GUARD — abort if any checked sheet is name-blocked
    const blocked=checkedItems.filter(el=>{const d=el.querySelector('[id^="dupeDetail_"]');return d&&d.dataset.exactBlocked==='1';});
    if(blocked.length){ toast('Import blocked — rename existing batch names first','error',6000); return; }

    // Split sheets into two groups: normal import vs link
    const toImport = [];
    const toLink   = [];

    checkedItems.forEach(el=>{
        const sheetName = el.dataset.sheet;
        const inp       = el.querySelector('.fvq-bname-input');
        const batchName = (inp?.value||'').trim() || sheetName;
        // safeId derived same way as in _fvqSetDupeModeById
        const safeId    = (sheetName||'').replace(/[^a-z0-9]/gi,'_');
        const linkEntry = _fvqLinkMode[safeId];
        if(linkEntry){
            toLink.push({ newName: batchName, sourceName: linkEntry.sourceName });
        } else {
            toImport.push({ sheet: sheetName, batch_name: batchName });
        }
    });

    const btn = document.getElementById('fvqImportBtn');
    btn.disabled = true; btn.textContent = 'Processing…';

    let importMsg = '', linkMsg = '', hasError = false;

    // ── Run normal imports ────────────────────────────────────────────────────
    if(toImport.length){
        try{
            const _impBrandEl = document.getElementById('fvqImportBrandSel');
        const _impBrandId = _impBrandEl && _impBrandEl.value ? parseInt(_impBrandEl.value) : null;
        const res  = await fetch('/api/procurement/formulations/import',{
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({basename:_fvqBasename, sheets:toImport, brand_id:_impBrandId})
            });
            const data = await res.json();
            if(data.status!=='ok') throw new Error(data.message);

            if(data.total_imported === 0){
                // Build a clear explanation of why nothing was imported
                const lines = [];
                if(data.errors && data.errors.length){
                    lines.push('Errors encountered:');
                    data.errors.forEach(e => lines.push('  • ' + e));
                }
                if(data.sheet_results && data.sheet_results.length){
                    lines.push('');
                    lines.push('Per-sheet summary:');
                    data.sheet_results.forEach(r => {
                        if(r.note === 'not found'){
                            lines.push(`  • "${r.sheet}" — sheet not found in file`);
                        } else {
                            lines.push(`  • "${r.batch||r.sheet}" — ${r.imported} imported, ${r.skipped} skipped`);
                        }
                    });
                }
                if(!lines.length) lines.push('No rows were found to import. Check that the file format is correct and rows start at row 13.');
                hasError = true;
                // Use a modal-style alert that requires OK press
                _fvqImportAlert('Nothing Imported', lines.join('\n'));
            } else {
                importMsg = `Imported ${data.total_imported} rows across ${data.sheet_results.length} sheet${data.sheet_results.length!==1?'s':''}`;
                // Warn about any skipped rows too
                if(data.total_skipped > 0)
                    importMsg += ` (${data.total_skipped} row${data.total_skipped!==1?'s':''} skipped)`;
            }
        }catch(err){
            toast('Import failed: '+err.message, 'error');
            hasError = true;
        }
    }

    // ── Run link operations ───────────────────────────────────────────────────
    if(toLink.length){
        let linkedOk = 0, linkedFail = [];
        for(const lk of toLink){
            try{
                const res  = await fetch('/api/procurement/formulations/link_batch',{
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({
                        new_batch_name:    lk.newName,
                        source_batch_name: lk.sourceName
                    })
                });
                const data = await res.json();
                if(data.status!=='ok') throw new Error(data.message);
                linkedOk++;
            }catch(err){
                linkedFail.push(`"${lk.newName}": ${err.message}`);
            }
        }
        if(linkedOk > 0)
            linkMsg = `Linked ${linkedOk} batch${linkedOk>1?'es':''}`;
        if(linkedFail.length){
            hasError = true;
            linkedFail.forEach(m=>toast('Link failed: '+m,'error',8000));
        }
    }

    if(_fvqImportBothMode && _lastFvqFile && !hasError){
        try{
            toast('Also importing manufacturing process…','info',3000);
            const fd2=new FormData(); fd2.append('file',_lastFvqFile);
            const mpRes=await fetch('/api/procurement/formulations/import_manuf_process',{method:'POST',body:fd2});
            const mpData=await mpRes.json();
            if(mpData.status!=='ok') throw new Error(mpData.message);
            const mpU=(mpData.results||[]).filter(r=>r.status==='updated').length;
            const mpS=(mpData.results||[]).filter(r=>r.status==='skipped').length;
            toast(mpU>0?'Mfg process imported for '+mpU+' batch'+(mpU!==1?'es':'')+(mpS?' ('+mpS+' skipped)':''):'Mfg process: nothing new','info',4000);
        }catch(err){ toast('Mfg import failed: '+err.message,'error',6000); }
    }
    _fvqImportBothMode = false;
    closeFvqSheetModal();
    Object.keys(_fvqLinkMode).forEach(k=>delete _fvqLinkMode[k]);
    const combined = [importMsg, linkMsg].filter(Boolean).join(' · ');
    if(combined) toast(combined, 'success', 5000);
    switchTab('fvq');
    await loadFvqData();
}

/* ── Load batch list ── */
async function loadFvqData(){
    document.getElementById('fvqTbody').innerHTML=
        '<tr><td colspan="9"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    if(typeof loadBrands==='function') await loadBrands();
    try{
        const res=await fetch('/api/procurement/formulations/list');
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        _fvqBatches=data.batches||[];
        _fvqSelectedBatches.clear(); // fresh data load resets selection
        _fvqHideAllPagesNote();
        _fvqSyncBulkBar();
        const _sa=document.getElementById('fvqSelectAll'); if(_sa) _sa.checked=false;
        _fvqDetail =data.detail ||[];
        const badge=document.getElementById('fvqBadge');
        badge.textContent=_fvqBatches.length;
        badge.style.display=_fvqBatches.length>0?'':'none';
        const kpiF=document.getElementById('statFormulations');
        if(kpiF) kpiF.textContent=_fvqBatches.length;
        fvqApplyFilters();
    }catch(err){
        document.getElementById('fvqTbody').innerHTML=
            `<tr><td colspan="8"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed</h3><p>${escHtml(err.message)}</p></div></td></tr>`;
    }
}


/* ════════════ FVQ SEARCH KEYBOARD NAVIGATION ════════════ */
let _fvqNavIdx = -1;   // currently highlighted row index in _fvqFiltered

function fvqSearchKeydown(e){
    const rows = document.querySelectorAll('#fvqTbody .fvq-row');
    const total = rows.length;
    if(!total && e.key !== 'Escape') return;

    if(e.key === 'ArrowDown'){
        e.preventDefault();
        _fvqNavIdx = Math.min(_fvqNavIdx + 1, total - 1);
        _fvqHighlightRow(rows);
    } else if(e.key === 'ArrowUp'){
        e.preventDefault();
        _fvqNavIdx = Math.max(_fvqNavIdx - 1, 0);
        _fvqHighlightRow(rows);
    } else if(e.key === 'Enter'){
        e.preventDefault();
        if(_fvqNavIdx >= 0 && rows[_fvqNavIdx]){
            const batchName = rows[_fvqNavIdx].dataset.batch;
            if(batchName) openFvqDetail(batchName);
        }
    } else if(e.key === 'Escape'){
        document.getElementById('fvqSearchInput').value = '';
        _fvqNavIdx = -1;
        fvqClearSelectionAndFilter();
    }
}

function _fvqHighlightRow(rows){
    rows.forEach((tr, i) => {
        if(i === _fvqNavIdx){
            tr.style.background = 'var(--teal-glow)';
            tr.style.outline    = '1px solid var(--teal-dim)';
            tr.scrollIntoView({block:'nearest', behavior:'smooth'});
        } else {
            tr.style.background = '';
            tr.style.outline    = '';
        }
    });
}

let _fvqMfgFilter = 'all'; // 'all' | 'has_mfg' | 'no_mfg'
let _fvqActiveFilter = 'all'; // 'all' | 'active' | 'inactive'

function fvqSetMfgFilter(f){
    _fvqMfgFilter = f;
    document.querySelectorAll('.fvq-mfg-pill').forEach(p=>{
        p.classList.toggle('active', p.dataset.filter === f);
    });
    _fvqPage = 1;
    fvqClearSelectionAndFilter();
}

function fvqSetActiveFilter(f){
    _fvqActiveFilter = f;
    document.querySelectorAll('.fvq-active-pill').forEach(p=>{
        p.classList.toggle('active', p.dataset.filter === f);
    });
    _fvqPage = 1;
    fvqClearSelectionAndFilter();
}

function fvqClearSelectionAndFilter(){
    // Called only by explicit user filter actions (search, MFG pill, brand dropdown)
    _fvqSelectedBatches.clear();
    _fvqHideAllPagesNote();
    const sa=document.getElementById('fvqSelectAll'); if(sa) sa.checked=false;
    _fvqSyncBulkBar();
    fvqApplyFilters();
}

function fvqApplyFilters(){
    const q=(document.getElementById('fvqSearchInput').value||'').trim().toLowerCase();
    let filtered = q
        ? _fvqBatches.filter(b=>b.batch_name.toLowerCase().includes(q)||(b.product_code||'').toLowerCase().includes(q))
        : _fvqBatches;

    if(_fvqMfgFilter === 'has_mfg')
        filtered = filtered.filter(b=>b.manuf_process && b.manuf_process.trim());
    else if(_fvqMfgFilter === 'no_mfg')
        filtered = filtered.filter(b=>!b.manuf_process || !b.manuf_process.trim());
    if(_fvqActiveFilter === 'active')
        filtered = filtered.filter(b=>b.is_active !== 0);
    else if(_fvqActiveFilter === 'inactive')
        filtered = filtered.filter(b=>b.is_active === 0);
    if(typeof _fvqBrandFilter !== 'undefined' && _fvqBrandFilter){
        if(_fvqBrandFilter === '__none__')
            filtered = filtered.filter(b=>!b.brand_id);
        else
            filtered = filtered.filter(b=>String(b.brand_id||'')=== String(_fvqBrandFilter));
    }

    _fvqFiltered=filtered;
    _fvqPage=1;
    _fvqNavIdx=-1;
    fvqRenderTable();
}
function fvqGetPageRows(){if(_fvqPageSize===0)return _fvqFiltered;const s=(_fvqPage-1)*_fvqPageSize;return _fvqFiltered.slice(s,s+_fvqPageSize);}
function fvqTotalPages(){return _fvqPageSize===0?1:Math.max(1,Math.ceil(_fvqFiltered.length/_fvqPageSize));}

function fvqRowCheckboxClick(cb){
    // Called via onclick on each row checkbox - no closure/stale reference issues
    const batch = cb.dataset.batch;
    if(cb.checked){
        _fvqSelectedBatches.add(batch);
    } else {
        _fvqSelectedBatches.delete(batch);
        _fvqHideAllPagesNote();
    }
    // Sync header checkbox
    const allOnPage = [...document.querySelectorAll('.fvq-row-cb')];
    const sa = document.getElementById('fvqSelectAll');
    if(sa) sa.checked = allOnPage.length > 0 && allOnPage.every(c => c.checked);
    _fvqSyncBulkBar();
}

function fvqRenderTable(){
    const rows=fvqGetPageRows();
    if(!rows.length){
        document.getElementById('fvqTbody').innerHTML=
            `<tr><td colspan="8"><div class="state-box"><div class="state-icon">🧪</div><h3>No formulations found</h3><p>${_fvqMfgFilter==='no_mfg'?'All formulations have a manufacturing process. 🎉':'Use "Import Formulation" to load your first Excel file.'}</p></div></td></tr>`;
    }else{
        document.getElementById('fvqTbody').innerHTML=rows.map(b=>{
            const hasMfg = b.manuf_process && b.manuf_process.trim();
            const isActive = b.is_active !== 0;
            const mfgBadge = hasMfg
                ? `<span title="Manufacturing process available"
                       style="margin-left:5px;font-size:9px;padding:1px 6px;border-radius:20px;
                              background:rgba(16,185,129,.12);color:var(--green-text);
                              border:1px solid rgba(16,185,129,.25);font-weight:600;vertical-align:middle">⚙ MFG</span>`
                : '';
            const activeBadge = isActive
                ? `<span title="Active — can be used in procurement" style="margin-left:5px;font-size:9px;padding:1px 6px;border-radius:20px;background:rgba(16,185,129,.12);color:var(--green-text);border:1px solid rgba(16,185,129,.25);font-weight:700;vertical-align:middle">● Active</span>`
                : `<span title="Inactive — excluded from procurement selections" style="margin-left:5px;font-size:9px;padding:1px 6px;border-radius:20px;background:var(--text-08);color:var(--muted);border:1px solid var(--border2);font-weight:700;vertical-align:middle">○ Inactive</span>`;
            const rowStyle = isActive
                ? (hasMfg ? 'cursor:pointer;border-left:3px solid var(--green);' : 'cursor:pointer;border-left:3px solid transparent;')
                : (hasMfg ? 'cursor:pointer;border-left:3px solid var(--green);opacity:.6;' : 'cursor:pointer;border-left:3px solid transparent;opacity:.6;');
            return `
            <tr class="fvq-row" data-batch="${escHtml(b.batch_name)}" style="${rowStyle}" ondblclick="openFvqDetail('${escHtml(b.batch_name).replace(/'/g,"\'")}')" oncontextmenu="openFvqCtx(event,this.dataset.batch);event.preventDefault()">
                <td style="padding:8px 6px;text-align:center;border-right:1px solid var(--border)">
                    <input type="checkbox" class="fvq-row-cb" data-batch="${escHtml(b.batch_name)}"
                        onclick="event.stopPropagation();fvqRowCheckboxClick(this)"
                        ${_fvqSelectedBatches.has(b.batch_name)?'checked':''}
                        style="cursor:pointer;width:14px;height:14px;accent-color:var(--teal)">
                </td>
                <td class="td-sr">${b.sr_no}</td>
                <td style="font-weight:600;color:var(--text);white-space:nowrap" title="Double-click to view">
                    ${escHtml(b.batch_name)}
                    ${mfgBadge}
                    ${activeBadge}
                    ${b.source_batch_name?`<span
                        title="Click to see source: ${escHtml(b.source_batch_name)}"
                        data-batch="${escHtml(b.batch_name)}"
                        data-source="${escHtml(b.source_batch_name)}"
                        onclick="event.stopPropagation();openLinkedDetail(this)"
                        onmouseover="this.style.background='rgba(139,92,246,.28)'"
                        onmouseout="this.style.background='rgba(139,92,246,.12)'"
                        style="margin-left:5px;font-size:10px;vertical-align:middle;
                               padding:1px 7px;border-radius:20px;
                               background:rgba(139,92,246,.12);color:#a78bfa;
                               border:1px solid rgba(139,92,246,.25);font-weight:600;cursor:pointer">🔗 Linked</span>`:''}
                </td>
                <td style="font-size:11px;color:var(--muted2);font-family:var(--font-mono)">${b.product_code?escHtml(b.product_code):'<span class="td-dim">—</span>'}</td>
                <td>${(()=>{ const br=(typeof getBrandById!=='undefined')?getBrandById(b.brand_id):null; if(!br) return '<span class="td-dim">—</span>'; const c=br.color||'#6366f1'; const tc=br.text_color||'#ffffff'; return '<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:10px;font-weight:700;background:'+c+';color:'+tc+';border:1px solid '+c+'55">'+escHtml(br.name)+'</span>'; })()}</td>
                <td class="td-mono">${b.batch_size?`<span style="color:var(--teal)">${escHtml(b.batch_size)}</span>`:'<span class="td-dim">—</span>'}</td>
                <td style="font-size:11px;color:var(--muted2);font-family:var(--font-mono)">${escHtml(b.batch_date||'—')}</td>
                <td><span style="font-family:var(--font-mono);font-size:11px;background:var(--text-08);padding:2px 8px;border-radius:20px">${b.item_count}</span></td>
                <td style="font-size:10.5px;color:var(--muted);font-family:var(--font-mono)">${b.imported_at?String(b.imported_at).slice(0,16).replace('T',' '):'—'}</td>
            </tr>`;
        }).join('');
    }
    // Sync header checkbox state after render
    setTimeout(()=>{
        const allOnPage=[...document.querySelectorAll('.fvq-row-cb')];
        const sa=document.getElementById('fvqSelectAll');
        if(sa) sa.checked = allOnPage.length>0 && allOnPage.every(c=>c.checked);
        _fvqSyncBulkBar();
    },0);

    // pagination
    const total=_fvqFiltered.length,tp=fvqTotalPages();
    const s=_fvqPageSize===0?1:(_fvqPage-1)*_fvqPageSize+1;
    const e=_fvqPageSize===0?total:Math.min(_fvqPage*_fvqPageSize,total);
    document.getElementById('fvqPgInfo').textContent=total===0?'No batches':`${s}–${e} of ${total}`;
    document.getElementById('fvqRowCountBadge').textContent=_fvqFiltered.length+' / '+_fvqBatches.length+' batches';
    const wrap=document.getElementById('fvqPgButtons');
    if(tp<=1){wrap.innerHTML='';return;}
    let h=`<button class="pg-btn" onclick="fvqGoPage(${_fvqPage-1})" ${_fvqPage===1?'disabled':''}>‹</button>`;
    const pages=[];
    if(tp<=7){for(let i=1;i<=tp;i++)pages.push(i);}
    else{pages.push(1);if(_fvqPage>3)pages.push('…');for(let i=Math.max(2,_fvqPage-1);i<=Math.min(tp-1,_fvqPage+1);i++)pages.push(i);if(_fvqPage<tp-2)pages.push('…');pages.push(tp);}
    pages.forEach(p=>{if(p==='…'){h+=`<span style="padding:0 4px;color:var(--muted)">…</span>`;return;}h+=`<button class="pg-page-btn ${p===_fvqPage?'active':''}" onclick="fvqGoPage(${p})">${p}</button>`;});
    h+=`<button class="pg-btn" onclick="fvqGoPage(${_fvqPage+1})" ${_fvqPage===tp?'disabled':''}>›</button>`;
    wrap.innerHTML=h;
}
function fvqGoPage(p){_fvqPage=Math.max(1,Math.min(p,fvqTotalPages()));fvqRenderTable();}
function fvqOnPageSizeChange(){_fvqPageSize=parseInt(document.getElementById('fvqPgSizeSelect').value);_fvqPage=1;fvqRenderTable();}

/* ── Formulation detail popup ── */
function openFvqDetail(batchName){
    const rows=_fvqDetail.filter(r=>r.batch_name===batchName);
    if(!rows.length){toast('No detail found for this batch','warning');return;}
    const meta=_fvqBatches.find(b=>b.batch_name===batchName)||{};
    _fvqDetailBatch=batchName;
    _fvqDetailFiltered=[...rows];

    // Header
    document.getElementById('fvqDetailTitle').textContent=batchName;

    // Meta chips
    const sizeChip=document.getElementById('fvqDetailSizeChip');
    const dateChip=document.getElementById('fvqDetailDateChip');
    const batchChip=document.getElementById('fvqDetailBatchChip');
    if(meta.batch_size){sizeChip.textContent='📦 '+meta.batch_size;sizeChip.style.display='';}else{sizeChip.style.display='none';}
    if(meta.batch_date){dateChip.textContent='📅 '+meta.batch_date;dateChip.style.display='';}else{dateChip.style.display='none';}
    if(meta.num_batches){batchChip.textContent='🔢 '+meta.num_batches;batchChip.style.display='';}else{batchChip.style.display='none';}

    // Summary bar — shows ingredient count only; column totals are in the table totals row
    document.getElementById('fvqDetailSummaryBar').innerHTML=`
        <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;font-weight:600;color:var(--muted)">Ingredients</span>
            <span style="font-family:var(--font-mono);font-size:1.1rem;font-weight:700;color:var(--text)">${rows.length}</span>
        </div>
        <div style="width:1px;background:var(--border);height:28px;flex-shrink:0"></div>
        <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;font-weight:600;color:var(--muted)">Batch Size</span>
            <div style="display:flex;align-items:center;gap:5px">
                <input type="number" id="fvqBatchSizeInput" step="0.001" min="0"
                       value="${escHtml(String(meta.batch_size||'').replace(/[^\d.]/g,''))}"
                       oninput="fvqRecalcQty()"
                       style="width:80px;height:28px;padding:0 8px;border-radius:var(--radius-sm);
                              border:1px solid var(--border2);background:var(--surface2);
                              color:var(--text);font-family:var(--font-mono);font-size:12px;outline:none"
                       onfocus="this.style.borderColor='var(--teal-dim)';this.style.boxShadow='0 0 0 3px var(--teal-glow2)'"
                       onblur="this.style.borderColor='';this.style.boxShadow=''">
                <span style="font-size:11px;color:var(--muted)">KG</span>
            </div>
        </div>`;

    document.getElementById('fvqDetailCount').textContent=rows.length+' ingredient'+( rows.length!==1?'s':'');
    // Build supplier lookup from Tab-1 (_allRows = Material Qty/Supplier Details)
    const _supplierMap = {};
    const _rateMap     = {};
    (_allRows||[]).forEach(m=>{
        const k = (m.material_name||'').trim().toLowerCase();
        if(m.supplier_name)      _supplierMap[k] = m.supplier_name.trim();
        if(m.last_purchase_rate!=null) _rateMap[k] = parseFloat(m.last_purchase_rate);
    });
    fvqDetailRender(rows, _supplierMap, _rateMap);
    document.getElementById('fvqDetailModal').classList.add('open');
    loadManufProcess(batchName);
    // Sync Active/Inactive toggle button
    _syncFvqActiveBtn(meta.is_active !== 0);
}

/* ═══════════════════════════════════════════════════════
   BATCH RENAME — inline edit in the FVQ detail modal
═══════════════════════════════════════════════════════ */
function fvqStartRename(){
    const currentName = document.getElementById('fvqDetailTitle').textContent.trim();
    const inp = document.getElementById('fvqRenameInput');
    inp.value = currentName;
    document.getElementById('fvqDetailTitle').style.display  = 'none';
    document.getElementById('fvqRenameBtn').style.display    = 'none';
    document.getElementById('fvqRenameRow').style.display    = 'flex';
    setTimeout(()=>{ inp.focus(); inp.select(); }, 50);
}

function fvqCancelRename(){
    document.getElementById('fvqDetailTitle').style.display  = '';
    document.getElementById('fvqRenameBtn').style.display    = '';
    document.getElementById('fvqRenameRow').style.display    = 'none';
}

function fvqRenameKeydown(e){
    if(e.key === 'Enter')   { e.preventDefault(); fvqConfirmRename(); }
    if(e.key === 'Escape')  { e.preventDefault(); fvqCancelRename();  }
}

async function fvqConfirmRename(){
    const oldName = _fvqDetailBatch;
    const newName = document.getElementById('fvqRenameInput').value.trim();
    if(!newName)               { toast('Batch name cannot be empty','warning'); return; }
    if(newName === oldName)    { fvqCancelRename(); return; }

    const saveBtn = document.getElementById('fvqRenameRow').querySelector('button');
    if(saveBtn){ saveBtn.disabled=true; saveBtn.textContent='Saving…'; }

    try{
        const res  = await fetch('/api/procurement/formulations/rename_batch',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({old_name:oldName, new_name:newName})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);

        // Update modal title + internal state
        document.getElementById('fvqDetailTitle').textContent = newName;
        _fvqDetailBatch = newName;

        // Update _fvqDetail rows (so print/calc still works)
        _fvqDetail.forEach(r=>{ if(r.batch_name===oldName) r.batch_name=newName; });
        // Update _fvqBatches
        const bm = _fvqBatches.find(b=>b.batch_name===oldName);
        if(bm) bm.batch_name = newName;
        // Also fix source_batch_name references in linked batches
        _fvqBatches.forEach(b=>{ if(b.source_batch_name===oldName) b.source_batch_name=newName; });

        fvqCancelRename();
        toast(`Renamed to "${newName}"`, 'success');

        // Refresh table so the new name shows immediately
        fvqApplyFilters();
    }catch(err){
        toast('Rename failed: '+err.message,'error');
    }finally{
        if(saveBtn){ saveBtn.disabled=false; saveBtn.textContent='✓ Save'; }
    }
}

async function toggleFvqActive(){
    const batchName = _fvqDetailBatch;
    if(!batchName) return;
    const btn = document.getElementById('fvqActiveToggleBtn');
    if(btn){ btn.disabled=true; btn.textContent='…'; }
    try{
        const res = await fetch('/api/procurement/formulations/toggle_active',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({batch_name: batchName})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        // Update in-memory
        const m = (_fvqBatches||[]).find(b=>b.batch_name===batchName);
        if(m) m.is_active = data.is_active;
        const isNowActive = data.is_active === 1;
        if(btn){
            btn.disabled = false;
            btn.textContent = isNowActive ? '● Active' : '○ Set Active';
            btn.style.background    = isNowActive ? 'var(--green-bg)'  : 'var(--text-08)';
            btn.style.color         = isNowActive ? 'var(--green-text)': 'var(--muted)';
            btn.style.borderColor   = isNowActive ? 'rgba(16,185,129,.3)' : 'var(--border2)';
            btn.title = isNowActive ? 'Click to mark Inactive' : 'Click to mark Active';
        }
        fvqRenderTable();
        toast((isNowActive ? 'Marked Active' : 'Marked Inactive') + ' — "'+batchName+'"', 'success');
    }catch(err){
        toast('Toggle failed: '+err.message,'error');
        if(btn){ btn.disabled=false; }
        // Re-sync btn label from memory
        const m2 = (_fvqBatches||[]).find(b=>b.batch_name===batchName);
        _syncFvqActiveBtn(m2?.is_active !== 0);
    }
}

function _syncFvqActiveBtn(isActive){
    const btn = document.getElementById('fvqActiveToggleBtn');
    if(!btn) return;
    btn.textContent  = isActive ? '● Active' : '○ Inactive';
    btn.style.background  = isActive ? 'var(--green-bg)'  : 'var(--text-08)';
    btn.style.color        = isActive ? 'var(--green-text)': 'var(--muted)';
    btn.style.borderColor  = isActive ? 'rgba(16,185,129,.3)' : 'var(--border2)';
    btn.title = isActive ? 'Click to mark Inactive' : 'Click to mark Active';
}

function closeFvqDetail(){
    document.getElementById('fvqDetailModal').classList.remove('open');
    // Reset editor for next open
    const ed = document.getElementById('fvqManufEditor');
    if(ed) ed.innerHTML = '';
    const saveBtn = document.getElementById('fvqManufSaveBtn');
    if(saveBtn) saveBtn.style.display = 'none';
}
document.getElementById('fvqDetailModal')?.addEventListener('click',e=>{if(e.target===document.getElementById('fvqDetailModal'))closeFvqDetail();});

// fvqDetailFilter removed (no search in popup)
function fvqDetailRender(rows, supplierMap, rateMap){
    supplierMap = supplierMap || {};  // safe default
    rateMap     = rateMap     || {};  // { material_name_lower: last_purchase_rate }
    if(!rows.length){
        document.getElementById('fvqDetailTbody').innerHTML=
            `<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--muted);font-size:12px">No matching ingredients</td></tr>`;
        return;
    }
    // Build totals
    const bs_r=parseFloat(document.getElementById('fvqBatchSizeInput')?.value||'0');
    let totC=0,totQ=0,totCost=0;
    rows.forEach(r=>{
        const c=parseFloat(r.concentration||'0'); if(!isNaN(c)) totC+=c;
        const rate=rateMap[(r.material_name||'').trim().toLowerCase()];
        if(bs_r&&!isNaN(c)){ const q=c*bs_r; totQ+=q; if(rate!=null&&!isNaN(rate)) totCost+=q*rate; }
    });

    document.getElementById('fvqDetailTbody').innerHTML=rows.map((r,i)=>`
        <tr style="border-bottom:1px solid var(--border);transition:background .1s" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:10px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${i+1}</td>
            <td style="padding:10px 14px;font-weight:500;color:var(--text);border-right:1px solid var(--border);white-space:nowrap">${escHtml(r.material_name)}</td>
            <td style="padding:10px 14px;font-size:11.5px;color:var(--text-60);border-right:1px solid var(--border)">${(function(){
                const key=(r.material_name||'').trim().toLowerCase();
                const fromTab1 = supplierMap&&supplierMap[key];
                const fromForm = r.supplier_name;
                if(fromTab1){
                    return '<span style="color:var(--text-60)">'+escHtml(fromTab1)+'</span>';
                } else if(fromForm){
                    return '<span style="color:var(--muted2)">'+escHtml(fromForm)+'</span>';
                } else {
                    return '<span style="color:var(--muted);font-style:italic">—</span>';
                }
            })()}</td>
            <td style="padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--teal);border-right:1px solid var(--border)">${r.concentration?fmtNum(parseFloat(r.concentration)*100,4)+'%':'<span style=\'color:var(--muted)\'>—</span>'}</td>
            <td id="fvqQtyCell_${i}"  style="padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--text);border-right:1px solid var(--border)">${fvqCalcQtyCell(r.concentration)}</td>
            <td id="fvqRateCell_${i}" style="padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--muted2);border-right:1px solid var(--border)">${(function(){ const rt=rateMap[(r.material_name||'').trim().toLowerCase()]; return rt!=null?'₹ '+fmtNum(rt,4):'<span style=\'color:var(--muted)\'>—</span>'; })()}</td>
            <td id="fvqCostCell_${i}" style="padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--text)">${fvqCalcCostCell(r.concentration,rateMap[(r.material_name||'').trim().toLowerCase()])}</td>
        </tr>`).join('')
    // Totals row (sticky at bottom, always visible)
    +`<tr id="fvqTotalsRow" style="border-top:2px solid var(--border2);background:var(--surface2)">
        <td style="padding:10px 14px;border-right:1px solid var(--border)"></td>
        <td style="padding:10px 14px;font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--text);border-right:1px solid var(--border)">TOTAL</td>
        <td style="padding:10px 14px;border-right:1px solid var(--border)"></td>
        <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--teal);border-right:1px solid var(--border)" id="fvqTotalConc">${fmtNum(totC*100,2)}%</td>
        <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--text);border-right:1px solid var(--border)" id="fvqTotalQty">${bs_r?fmtNum(totQ,3)+' KG':'—'}</td>
        <td style="padding:10px 14px;font-family:var(--font-mono);font-size:11.5px;color:var(--muted2);border-right:1px solid var(--border)"></td>
        <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--green-text)" id="fvqTotalCost">${(bs_r&&totCost>0)?'₹ '+fmtNum(totCost,2):'—'}</td>
    </tr>`;
}

/* Qty (KG) = Concentration × Batch Size (live calculation) */
function fvqCalcQtyCell(concentration){
    const bs = parseFloat(document.getElementById('fvqBatchSizeInput')?.value||'0');
    const c  = parseFloat(concentration||'0');
    if(!bs || isNaN(bs) || isNaN(c)) return '<span style="color:var(--muted)">—</span>';
    const qty = c * bs;
    return '<span style="color:var(--text)">' + fmtNum(qty, 3) + ' KG</span>';
}

function fvqCalcCostCell(concentration, rate){
    const bs = parseFloat(document.getElementById('fvqBatchSizeInput')?.value||'0');
    const c  = parseFloat(concentration||'0');
    if(!bs || isNaN(bs) || isNaN(c) || rate==null || isNaN(rate))
        return '<span style="color:var(--muted)">—</span>';
    const cost = c * bs * rate;
    return '<span style="color:var(--text)">₹ ' + fmtNum(cost, 2) + '</span>';
}

function fvqRecalcQty(){
    // Re-render Qty, Cost and Totals row without full redraw
    const rows = _fvqDetail.filter(r=>r.batch_name===_fvqDetailBatch);
    // Rebuild rateMap from _allRows
    const rm={};
    (_allRows||[]).forEach(m=>{ if(m.last_purchase_rate!=null) rm[(m.material_name||'').trim().toLowerCase()]=parseFloat(m.last_purchase_rate); });
    let totalConc=0, totalQty=0, totalCost=0;
    const bs=parseFloat(document.getElementById('fvqBatchSizeInput')?.value||'0');
    rows.forEach((r,i)=>{
        const c=parseFloat(r.concentration||'0');
        const rate=rm[(r.material_name||'').trim().toLowerCase()];
        const qty=(!isNaN(c)&&bs)?c*bs:null;
        const cost=(qty!=null&&rate!=null&&!isNaN(rate))?qty*rate:null;
        const qc=document.getElementById('fvqQtyCell_'+i);
        const cc=document.getElementById('fvqCostCell_'+i);
        if(qc) qc.innerHTML=fvqCalcQtyCell(r.concentration);
        if(cc) cc.innerHTML=fvqCalcCostCell(r.concentration,rate);
        if(!isNaN(c)) totalConc+=c;
        if(qty!=null) totalQty+=qty;
        if(cost!=null) totalCost+=cost;
    });
    // Update totals row
    const tr=document.getElementById('fvqTotalsRow');
    if(tr){
        document.getElementById('fvqTotalConc').textContent = fmtNum(totalConc*100,2)+'%';
        document.getElementById('fvqTotalQty').textContent  = bs ? fmtNum(totalQty,3)+' KG' : '—';
        document.getElementById('fvqTotalCost').textContent = (bs&&totalCost>0) ? '₹ '+fmtNum(totalCost,2) : '—';
    }
}


/* ═══════════════════════════════════════════════════════
   WHATSAPP SHARE
═══════════════════════════════════════════════════════ */
/* Single batch — called from detail modal */
function fvqWhatsApp(){
    const batchName = _fvqDetailBatch;
    if(!batchName){ toast('No formulation open','warning'); return; }
    const msg = _fvqBuildWhatsAppMsg([batchName]);
    window.open('https://web.whatsapp.com/send?text=' + encodeURIComponent(msg), '_blank');
}

/* Multiple batches — called from grid selection bar */
function fvqWhatsAppSelected(){
    const batches = _fvqSelectedBatches.size>0 ? [..._fvqSelectedBatches] : [...document.querySelectorAll('.fvq-row-cb:checked')].map(cb=>cb.dataset.batch);
    if(!batches.length){ toast('Select at least one batch','warning'); return; }
    const msg = _fvqBuildWhatsAppMsg(batches);
    window.open('https://web.whatsapp.com/send?text=' + encodeURIComponent(msg), '_blank');
}

/* Shared message builder — groups batches by brand */
function _fvqBuildWhatsAppMsg(batchNames){
    // Build rate map from material master
    const rateMap = {};
    (_allRows||[]).forEach(m=>{
        const k = (m.material_name||'').trim().toLowerCase();
        if(m.last_purchase_rate!=null) rateMap[k] = parseFloat(m.last_purchase_rate);
    });

    // Group batches by brand
    const brandMap = {};   // brand_key → { brandName, batches[] }
    const noBrand  = [];

    batchNames.forEach(batchName=>{
        const meta  = _fvqBatches.find(b=>b.batch_name===batchName)||{};
        const brand = (typeof getBrandById!=='undefined') ? getBrandById(meta.brand_id) : null;
        const entry = { batchName, meta, brand };

        if(brand?.name){
            const key = String(meta.brand_id);
            if(!brandMap[key]) brandMap[key] = { brandName: brand.name, batches: [] };
            brandMap[key].batches.push(entry);
        } else {
            noBrand.push(entry);
        }
    });

    const lines = [];
    lines.push('🧪 *Formulation Cost Summary*');
    lines.push('');

    const renderBatch = (entry, idx, total)=>{
        const { batchName, meta } = entry;
        const rows = _fvqDetail.filter(r=>r.batch_name===batchName);

        // Cost per KG
        let costPerKg = 0, hasCost = false;
        rows.forEach(r=>{
            const c    = parseFloat(r.concentration||'0');
            const rate = rateMap[(r.material_name||'').trim().toLowerCase()];
            if(!isNaN(c) && rate!=null && !isNaN(rate)){ costPerKg += c * rate; hasCost = true; }
        });

        lines.push((total>1?(idx+1)+'. ':'') + '*' + batchName + '*');
        if(meta.product_code) lines.push('   🔖 ' + meta.product_code);
        lines.push('   💰 Cost/KG: ' + (hasCost ? '₹ ' + fmtNum(costPerKg, 2) : '—'));
    };

    // Branded groups
    Object.values(brandMap).forEach(group=>{
        lines.push('🏷 *' + group.brandName + '*');
        group.batches.forEach((e,i)=>renderBatch(e, i, group.batches.length));
        lines.push('');
    });

    // Unbranded
    if(noBrand.length){
        if(Object.keys(brandMap).length) lines.push('📋 *Unbranded*');
        noBrand.forEach((e,i)=>renderBatch(e, i, noBrand.length));
        lines.push('');
    }

    lines.push('_Sent from HCP Procurement Portal_');
    return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════
   PRINT FORMULATION
   Opens a new window with a professionally formatted
   print layout using the CURRENT batch size & qty values.
═══════════════════════════════════════════════════════ */
function printFormulation(printType){
    // printType: 'production' | 'costing'
    const isCosting = (printType === 'costing');
    const batchName = _fvqDetailBatch;
    const rows      = _fvqDetail.filter(r=>r.batch_name===batchName);
    if(!rows.length){ toast('No data to print','warning'); return; }

    const batchSize   = parseFloat(document.getElementById('fvqBatchSizeInput')?.value||'0');
    const printDate   = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const meta        = _fvqBatches.find(b=>b.batch_name===batchName)||{};
    const productCode = meta.product_code||'';

    // Build lookup maps from Tab-1
    const smap={}, rmap={};
    (_allRows||[]).forEach(m=>{
        const k=(m.material_name||'').trim().toLowerCase();
        if(m.supplier_name)           smap[k]=m.supplier_name.trim();
        if(m.last_purchase_rate!=null) rmap[k]=parseFloat(m.last_purchase_rate);
    });

    // Totals
    let totalConc=0, totalQty=0, totalCost=0;
    rows.forEach(r=>{
        const c=parseFloat(r.concentration||'0');
        if(!isNaN(c)){
            totalConc+=c;
            if(batchSize){ const q=c*batchSize; totalQty+=q;
                const rt=rmap[(r.material_name||'').trim().toLowerCase()];
                if(rt!=null) totalCost+=q*rt;
            }
        }
    });

    // ── PRODUCTION SHEET ────────────────────────────────────────
    if(!isCosting){
        const extraHeaders = '<th></th><th></th><th></th><th></th><th></th>';
        const extraCells   = '<td></td><td></td><td></td><td></td><td></td>';
        const rowsHtml = rows.map((r,i)=>{
            const key     = (r.material_name||'').trim().toLowerCase();
            const supplier= smap[key] || r.supplier_name || '';
            const showConc = document.getElementById('printConcToggle') ? document.getElementById('printConcToggle').checked : true;
            const concPct = (showConc && r.concentration) ? fmtNum(parseFloat(r.concentration)*100,4)+'%' : '';
            const qty     = (batchSize&&r.concentration) ? fmtNum(parseFloat(r.concentration)*batchSize,3) : '';
            return `<tr class="${i%2===0?'alt':''}">
                <td class="sr">${i+1}</td>
                <td class="ing">${r.material_name||''}</td>
                <td class="sup">${supplier}</td>
                <td class="con">${concPct}</td>
                <td class="qty">${qty}</td>
                ${extraCells}
            </tr>`;
        }).join('');
        const totalRow = `<tr class="tot">
            <td></td><td style="font-weight:700">TOTAL</td><td></td>
            <td class="con" style="font-weight:700">${fmtNum(totalConc*100,2)}%</td>
            <td class="qty" style="font-weight:700">${batchSize?fmtNum(totalQty,3):''}</td>
            ${extraCells}
        </tr>`;
        var _mpMeta = (_fvqBatches||[]).find(function(b){ return b.batch_name===batchName; });
        const manufProcess = (_mpMeta && _mpMeta.manuf_process) ? _mpMeta.manuf_process : '';
        _doPrint(_buildPrintHtml({batchName,productCode,batchSize,printDate,rowsHtml,totalRow,totalConc,totalQty,isCosting:false,extraHeaders,rowCount:rows.length,manufProcess}));
    }
    // ── COSTING SHEET ────────────────────────────────────────────
    else {
        const rowsHtml = rows.map((r,i)=>{
            const key     = (r.material_name||'').trim().toLowerCase();
            const supplier= smap[key] || r.supplier_name || '';
            const showConc2 = document.getElementById('printConcToggle') ? document.getElementById('printConcToggle').checked : true;
            const concPct = (showConc2 && r.concentration) ? fmtNum(parseFloat(r.concentration)*100,4)+'%' : '';
            const qty     = (batchSize&&r.concentration) ? fmtNum(parseFloat(r.concentration)*batchSize,3)+' KG' : '—';
            const rt      = rmap[key];
            const rate    = rt!=null ? '₹ '+fmtNum(rt,4) : '—';
            const cost    = (batchSize&&r.concentration&&rt!=null)
                ? '₹ '+fmtNum(parseFloat(r.concentration)*batchSize*rt,2) : '—';
            return `<tr class="${i%2===0?'alt':''}">
                <td class="sr">${i+1}</td>
                <td class="ing">${r.material_name||''}</td>
                <td class="sup">${supplier}</td>
                <td class="con">${concPct}</td>
                <td class="qty">${qty}</td>
                <td class="rate">${rate}</td>
                <td class="cost">${cost}</td>
            </tr>`;
        }).join('');
        const totalRow = `<tr class="tot">
            <td></td><td style="font-weight:700">TOTAL</td><td></td>
            <td class="con" style="font-weight:700">${fmtNum(totalConc*100,2)}%</td>
            <td class="qty" style="font-weight:700">${batchSize?fmtNum(totalQty,3)+' KG':'—'}</td>
            <td class="rate"></td>
            <td class="cost" style="font-weight:700">${(batchSize&&totalCost>0)?'₹ '+fmtNum(totalCost,2):'—'}</td>
        </tr>`;
        var _mpMeta2 = (_fvqBatches||[]).find(function(b){ return b.batch_name===batchName; });
        const manufProcess2 = (_mpMeta2 && _mpMeta2.manuf_process) ? _mpMeta2.manuf_process : '';
        _doPrint(_buildPrintHtml({batchName,productCode,batchSize,printDate,rowsHtml,totalRow,totalConc,totalQty,totalCost,isCosting:true,rowCount:rows.length,manufProcess:manufProcess2}));
    }
}

function togglePrintMenu(){
    const menu = document.getElementById('printMenu');
    if(!menu) return;
    const open = menu.style.display !== 'none';
    menu.style.display = open ? 'none' : 'block';
    if(!open){
        setTimeout(()=>document.addEventListener('click', _closePrintMenu, {once:true}), 10);
    }
}
function _closePrintMenu(){ const m=document.getElementById('printMenu'); if(m) m.style.display='none'; }

function _buildPrintHtml({batchName,productCode,batchSize,printDate,rowsHtml,totalRow,totalConc,totalQty,totalCost,isCosting,extraHeaders,rowCount,manufProcess}){
    const typeLabel = isCosting ? 'Costing Sheet' : 'Production Sheet';
    const costingCols = isCosting ? `
        <col style="width:22mm">  <!-- rate -->
        <col style="width:24mm">  <!-- cost -->` : '';
    const thead5extra = isCosting
        ? `<th style="text-align:right">Rate / KG (₹)</th><th style="text-align:right">Total Cost (₹)</th>`
        : (extraHeaders||'<th></th><th></th><th></th><th></th><th></th>');
    return `<!DOCTYPE html>
<!-- HCP Procurement v3.9 - 20260327-0413 -->
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${typeLabel} — ${batchName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
@page{ size:A4 landscape; margin:8mm 10mm; }
html,body{ width:277mm; font-family:'DM Sans','Segoe UI',sans-serif; font-size:8pt; color:#1a2035; background:#fff; }
.hdr{ margin-bottom:2.5mm; display:flex; justify-content:space-between; align-items:flex-start; }
.hdr-left .co{ font-size:6.5pt; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#94a3b8; margin-bottom:1mm; }
.hdr-left .ti{ font-size:12pt; font-weight:700; color:#0f172a; line-height:1.2; }
.hdr-left .pc{ font-size:7.5pt; color:#64748b; margin-top:1mm; font-family:'DM Mono',monospace; }
.hdr-left .pc-inline{ font-size:8pt; color:#64748b; font-weight:500; font-family:'DM Mono',monospace; }
.hdr-left .pc-inline .pc-label{ color:#94a3b8; font-weight:600; }
.hdr-left .pc-inline strong{ color:#0f172a; font-weight:700; }
.hdr-right{ text-align:right; font-size:7pt; color:#64748b; line-height:1.7; }
.hdr-right .bs{ font-size:10pt; font-weight:700; color:#0d9488; font-family:'DM Mono',monospace; }
.type-badge{ display:inline-block; font-size:6.5pt; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; padding:1.5px 7px; border-radius:3px; margin-bottom:2mm;
    background:${isCosting?'#fef3c7':'#f0fdf4'}; color:${isCosting?'#92400e':'#065f46'};
    border:1pt solid ${isCosting?'#fde68a':'#bbf7d0'}; }
.meta{ display:flex; gap:6mm; align-items:center; padding:1.6mm 4mm; background:#f8fafc;
    border:1pt solid #e2e8f0; border-radius:3px; margin-bottom:2.5mm; font-size:7pt; }
.meta-item{ display:flex; flex-direction:column; gap:0.5px; }
.ml{ font-size:6pt; font-weight:700; letter-spacing:.9px; text-transform:uppercase; color:#94a3b8; }
.mv{ font-family:'DM Mono',monospace; font-weight:600; color:#0f172a; font-size:8pt; }
.mv.hi{ color:#0d9488; }
.mv.cost{ color:#92400e; }
.meta-sep{ width:1pt; background:#e2e8f0; align-self:stretch; margin:0 1mm; }
table{ width:100%; border-collapse:collapse; font-size:7.5pt; table-layout:fixed; }
col.c-sr { width:8mm; } col.c-ing { width:52mm; } col.c-sup { width:45mm; }
col.c-con { width:20mm; } col.c-qty { width:20mm; }
col.c-rate{ width:22mm; } col.c-cost{ width:24mm; } col.c-ex{ width:auto; }
thead tr{ background:#1a2238; }
thead th{ padding:1.6mm 2.5mm; font-size:6.5pt; font-weight:700; letter-spacing:.8px;
    text-transform:uppercase; color:#fff; text-align:left;
    border-right:1pt solid rgba(255,255,255,.15); white-space:nowrap; overflow:hidden; }
thead th:last-child{ border-right:none; }
tbody tr{ border-bottom:.5pt solid #e8ecf2; }
tbody tr.alt td{ background:#f8fafc; }
tbody td{ padding:0.9mm 2.5mm; vertical-align:middle; border-right:.5pt solid #eef0f4; overflow:hidden; white-space:nowrap; }
tbody td:last-child{ border-right:none; }
td.sr{ color:#94a3b8; font-family:'DM Mono',monospace; font-size:7pt; text-align:center; }
td.ing{ font-weight:500; }
td.sup{ color:#475569; font-size:7pt; }
td.con{ font-family:'DM Mono',monospace; color:#0d9488; font-weight:600; text-align:right; }
td.qty{ font-family:'DM Mono',monospace; font-weight:600; text-align:right; }
td.rate{ font-family:'DM Mono',monospace; color:#64748b; text-align:right; }
td.cost{ font-family:'DM Mono',monospace; font-weight:700; text-align:right; color:#0f172a; }
tr.tot td{ padding:1.4mm 2.5mm; background:${isCosting?'#fffbeb':'#f0fdf4'};
    border-top:1.5pt solid ${isCosting?'#fde68a':'#86efac'};
    border-bottom:1.5pt solid ${isCosting?'#fde68a':'#86efac'};
    font-size:8pt; border-right:.5pt solid ${isCosting?'#fef3c7':'#d1fae5'}; }
tr.tot td.con{ color:#059669; }
tr.tot td.cost{ color:#92400e; }
.ftr{ margin-top:2mm; padding-top:1.5mm; border-top:1pt solid #e2e8f0;
    display:flex; justify-content:space-between; align-items:flex-end;
    font-size:6.5pt; color:#94a3b8; }
.sign-row{ display:flex; gap:14mm; }
.sb{ text-align:center; min-width:36mm; }
.sl{ border-top:.75pt solid #cbd5e1; padding-top:1mm; margin-top:6mm; font-weight:600; color:#475569; font-size:7pt; }

/* ── AUTO-SCALE SHELL (Page 1: Formulation) ── */
#form-shell{ width:277mm; height:194mm; overflow:hidden; }
#form-wrap{ width:100%; transform-origin:top left; }

/* ── MANUFACTURING PROCESS PAGE (Page 2) ── */
#mp-page{ }
#mp-shell{ width:277mm; height:194mm; overflow:hidden; }
#mp-wrap{ width:100%; transform-origin:top left; }
.mp-hdr{ margin-bottom:2.5mm; display:flex; justify-content:space-between; align-items:flex-start;
    border-bottom:2pt solid #0d9488; padding-bottom:2mm; }
.mp-hdr-left .mp-co{ font-size:6.5pt; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#94a3b8; margin-bottom:1mm; }
.mp-hdr-left .mp-ti{ font-size:11pt; font-weight:700; color:#0f172a; line-height:1.2; }
.mp-hdr-left .mp-pc{ font-size:7.5pt; color:#64748b; font-weight:500; font-family:'DM Mono',monospace; }
.mp-hdr-left .mp-pc .mp-pc-l{ color:#94a3b8; font-weight:600; }
.mp-hdr-left .mp-pc strong{ color:#0f172a; font-weight:700; }
.mp-hdr-right{ text-align:right; font-size:7pt; color:#64748b; line-height:1.7; }
.mp-hdr-right .mp-bs{ font-size:10pt; font-weight:700; color:#0d9488; font-family:'DM Mono',monospace; }
.mp-body{ font-size:7.5pt; color:#1a2035; line-height:1.5; }
.mp-body p{ margin:0.6mm 0; }
.mp-body ol, .mp-body ul{ margin:0.8mm 0 1.5mm 7mm; padding:0; }
.mp-body li{ margin:0.4mm 0; padding-left:1mm; }
.mp-body b, .mp-body strong{ font-weight:700; }
/* Generic fallback (legacy / ad-hoc tables) */
.mp-body table{ border-collapse:collapse; width:100%; max-width:100%; font-size:7pt;
    table-layout:auto; margin:1.5mm 0; word-wrap:break-word; }
.mp-body td, .mp-body th{ border:.75pt solid #cbd5e1; padding:1mm 2mm;
    vertical-align:top; word-wrap:break-word; overflow-wrap:break-word;
    hyphens:auto; word-break:break-word; }
.mp-body th{ background:#f1f5f9; font-weight:700; text-align:center; }
/* Canonical tables produced by the importer / cleaner */
.mp-body table.mp-spec{ table-layout:fixed; font-size:7.5pt; margin:0 0 3mm 0; }
.mp-body table.mp-spec th{ background:#f1f5f9; padding:1mm 2mm; font-size:7pt; }
.mp-body table.mp-spec td{ padding:0.8mm 2mm; font-size:7.5pt; line-height:1.3; }
.mp-body table.mp-steps{ table-layout:fixed; font-size:7.5pt; margin:0 0 2mm 0; }
.mp-body table.mp-steps th{ background:#f1f5f9; padding:1mm 2mm; font-size:7pt; }
.mp-body table.mp-steps td{ padding:0.8mm 2mm; font-size:7.5pt; line-height:1.4; }
.mp-body table.mp-steps td.sr{ text-align:center; color:#64748b;
    font-family:'DM Mono',monospace; font-size:6.5pt; padding:0.8mm 1mm; }
.mp-body table.mp-steps td strong{ display:inline-block; margin-bottom:0.4mm; color:#0f172a; }
.mp-body img{ max-width:100%; height:auto; }
.mp-ftr{ margin-top:3mm; padding-top:2mm; border-top:1pt solid #e2e8f0;
    display:flex; justify-content:space-between; align-items:flex-end;
    font-size:6.5pt; color:#94a3b8; }
</style>

<style>
/* ══ LIGHT THEME POLISH — matches reference image style ══ */
[data-theme="light"] body { background:#f0f4f8; }
[data-theme="light"] .topbar {
    background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 60%,#2563eb 100%);
    border-bottom:none;
    box-shadow:0 2px 12px rgba(30,58,138,.25);
}
[data-theme="light"] .brand-mark { background:rgba(255,255,255,.22); color:#fff; box-shadow:none; }
[data-theme="light"] .brand-name,
[data-theme="light"] .brand-sub  { color:rgba(255,255,255,.9); }
[data-theme="light"] .topbar-sep { background:rgba(255,255,255,.2); }
[data-theme="light"] .page-icon  { background:rgba(255,255,255,.15); border-color:rgba(255,255,255,.2); }
[data-theme="light"] .page-label { color:#fff; font-weight:700; }
[data-theme="light"] .page-sublabel { color:rgba(255,255,255,.7); }
[data-theme="light"] .topbar-time { background:rgba(255,255,255,.15); border-color:rgba(255,255,255,.2); color:rgba(255,255,255,.85); }
[data-theme="light"] .user-pill  { background:rgba(255,255,255,.15); border-color:rgba(255,255,255,.2); }
[data-theme="light"] .user-av    { background:rgba(255,255,255,.3); color:#1e3a8a; }
[data-theme="light"] .user-name  { color:#fff; }
[data-theme="light"] .user-role  { color:rgba(255,255,255,.65); }
[data-theme="light"] .icon-btn   { background:rgba(255,255,255,.15); border-color:rgba(255,255,255,.2); color:rgba(255,255,255,.85); }
[data-theme="light"] .icon-btn:hover { background:rgba(255,255,255,.25); border-color:rgba(255,255,255,.4); color:#fff; }
[data-theme="light"] .back-btn   { background:rgba(255,255,255,.15); border-color:rgba(255,255,255,.2); color:#fff; }
[data-theme="light"] .back-btn:hover { background:rgba(255,255,255,.25); }

/* ── Page section cards ── */
[data-theme="light"] .page-root { padding:24px 28px 16px; }
[data-theme="light"] .page-header { background:#fff; border-radius:12px; padding:18px 22px; margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,.07); border:1px solid #e2e8f0; }
[data-theme="light"] .kpi-strip .kpi-card { background:#fff; border:1px solid #e2e8f0; box-shadow:0 1px 4px rgba(0,0,0,.06); border-radius:10px; }
[data-theme="light"] .tab-rail { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:6px; box-shadow:0 1px 3px rgba(0,0,0,.05); margin-bottom:14px; }
[data-theme="light"] .tab-btn { border-radius:7px; color:#64748b; }
[data-theme="light"] .tab-btn.active { background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; }
[data-theme="light"] .tab-btn.active .tab-badge { background:rgba(255,255,255,.25); color:#fff; }
[data-theme="light"] .table-shell { background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,.06); }
[data-theme="light"] .toolbar { background:#f8fafc; border-bottom:1px solid #e2e8f0; border-radius:10px 10px 0 0; }
[data-theme="light"] thead tr:first-child { background:#f1f5f9; }
[data-theme="light"] tbody tr:hover { background:#f0f9ff; }
[data-theme="light"] .act-btn.primary { background:linear-gradient(135deg,#1e3a8a,#2563eb); border-color:#1d4ed8; color:#fff; }
[data-theme="light"] .act-btn.primary:hover { background:linear-gradient(135deg,#1e40af,#1d4ed8); }

/* ══ PO & SUPPLIER TAB STYLES ══ */
.po-grid { display:grid; gap:14px; }
.po-card {
    background:var(--surface); border:1px solid var(--border2); border-radius:12px;
    padding:18px 20px; cursor:pointer; transition:all .18s;
    border-left:4px solid var(--teal);
}
.po-card:hover { box-shadow:var(--shadow-sm); transform:translateY(-1px); }
.po-card-head { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.po-num { font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--teal); }
.po-status { font-size:10px; font-weight:700; padding:2px 9px; border-radius:20px; letter-spacing:.5px; text-transform:uppercase; }
.po-status.draft    { background:var(--text-08); color:var(--muted2); }
.po-status.pending  { background:var(--amber-bg); color:var(--amber-text); }
.po-status.received { background:var(--green-bg); color:var(--green-text); }
.po-status.partial  { background:rgba(14,165,233,.12); color:#0284c7; }
.po-fields { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
.po-field label { font-size:9.5px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; display:block; margin-bottom:3px; }
.po-field span  { font-size:13px; color:var(--text); font-weight:500; }

/* Form card style (matches reference image) */
.form-card {
    background:var(--surface); border:1px solid var(--border2); border-radius:10px;
    overflow:hidden; margin-bottom:14px;
}
.form-card-head {
    background:linear-gradient(135deg,#1e3a8a,#2563eb);
    padding:11px 18px; display:flex; align-items:center; justify-content:space-between;
}
[data-theme="light"] .form-card-head { /* already blue */ }
[data-theme="dark"] .form-card-head  { background:linear-gradient(135deg,rgba(30,58,138,.7),rgba(37,99,235,.5)); }
.form-card-head-title { font-size:12px; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:.8px; display:flex; align-items:center; gap:7px; }
.form-card-badge { font-size:9px; font-weight:800; padding:2px 9px; border-radius:20px; background:rgba(255,255,255,.2); color:#fff; letter-spacing:.5px; text-transform:uppercase; }
.form-card-body { padding:18px; }
.form-row { display:grid; gap:12px; margin-bottom:12px; }
.form-row.cols-2 { grid-template-columns:1fr 1fr; }
.form-row.cols-3 { grid-template-columns:1fr 1fr 1fr; }
.form-row.cols-4 { grid-template-columns:1fr 1fr 1fr 1fr; }
.form-group { display:flex; flex-direction:column; gap:4px; }
.form-label { font-size:9.5px; font-weight:700; color:var(--muted2); text-transform:uppercase; letter-spacing:.6px; }
.form-label .req { color:#e11d48; }
.form-input-styled {
    height:36px; padding:0 12px; border-radius:7px;
    border:1px solid var(--border2); background:var(--surface2);
    color:var(--text); font-size:13px; font-family:var(--font-body);
    outline:none; transition:border-color .15s, box-shadow .15s; width:100%;
}
.form-input-styled:focus { border-color:var(--teal-dim); box-shadow:0 0 0 3px var(--teal-glow); }
.form-input-styled::placeholder { color:var(--muted); }
select.form-input-styled { cursor:pointer; }
.form-input-styled[readonly] { background:var(--text-05); color:var(--muted2); cursor:default; }
textarea.form-input-styled { height:auto; padding:10px 12px; resize:vertical; min-height:60px; }

/* Supplier card grid */
.sup-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
.sup-card {
    background:var(--surface); border:1px solid var(--border2); border-radius:10px;
    padding:16px 18px; cursor:pointer; transition:all .18s;
    border-top:3px solid var(--teal);
}
.sup-card:hover { box-shadow:var(--shadow-sm); transform:translateY(-1px); }
.sup-name  { font-size:14px; font-weight:700; color:var(--text); margin-bottom:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sup-stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
.sup-stat  { font-size:11px; color:var(--muted2); }
.sup-stat strong { color:var(--text); font-size:12px; }
.sup-mats  { font-size:10.5px; color:var(--muted); line-height:1.5; }

/* Shared modal footer actions */
.modal-footer-actions { display:flex; align-items:center; justify-content:flex-end; gap:9px; padding:14px 20px; border-top:1px solid var(--border); background:var(--surface2); border-radius:0 0 14px 14px; }
.btn-close-modal { padding:8px 18px; border-radius:7px; border:1px solid var(--border2); background:transparent; color:var(--muted2); font-size:12.5px; font-weight:600; cursor:pointer; font-family:var(--font-body); transition:all .15s; }
.btn-close-modal:hover { background:var(--text-08); color:var(--text); }
.btn-save-modal { padding:8px 20px; border-radius:7px; border:none; background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; font-size:12.5px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:all .15s; display:flex; align-items:center; gap:6px; }
.btn-save-modal:hover { background:linear-gradient(135deg,#1e40af,#1d4ed8); box-shadow:0 4px 12px rgba(30,58,138,.3); }
.btn-save-add { padding:8px 20px; border-radius:7px; border:1px solid var(--teal-dim); background:var(--teal-glow); color:var(--teal); font-size:12.5px; font-weight:700; cursor:pointer; font-family:var(--font-body); transition:all .15s; display:flex; align-items:center; gap:6px; }
.btn-save-add:hover { background:var(--teal-glow2); }
</style>

</head>
<body>
<div id="form-shell"><div id="form-wrap">
<div class="hdr">
    <div class="hdr-left">
        <div class="co">HCP Wellness Pvt Ltd &nbsp;·&nbsp; Formulation Sheet</div>
        <div class="type-badge">${typeLabel}</div>
        <div class="ti">${batchName}${productCode?`<span class="pc-inline"> &nbsp;·&nbsp; <span class="pc-label">Product Code:</span> <strong>${productCode}</strong></span>`:''}</div>
    </div>
    <div class="hdr-right">
        <div>Date: <strong>${printDate}</strong></div>
        ${batchSize?`<div class="bs">${fmtNum(batchSize,3)} KG</div><div style="font-size:6pt">Batch Size</div>`:''}
    </div>
</div>
<div class="meta">
    <div class="meta-item"><span class="ml">Ingredients</span><span class="mv">${rowCount}</span></div>
    <div class="meta-sep"></div>
    <div class="meta-item"><span class="ml">Total Conc.</span><span class="mv hi">${fmtNum(totalConc*100,2)}%</span></div>
    ${(isCosting&&totalCost>0)?`<div class="meta-sep"></div><div class="meta-item"><span class="ml">Total Cost</span><span class="mv cost">₹ ${fmtNum(totalCost,2)}</span></div>`:''}
</div>
<table>
    <colgroup>
        <col class="c-sr"><col class="c-ing"><col class="c-sup">
        <col class="c-con"><col class="c-qty">
        ${isCosting?'<col class="c-rate"><col class="c-cost">':'<col class="c-ex"><col class="c-ex"><col class="c-ex"><col class="c-ex"><col class="c-ex">'}
    </colgroup>
    <thead><tr>
        <th>#</th>
        <th>Ingredient / Material</th>
        <th>Supplier</th>
        <th style="text-align:right">Conc. % w/w</th>
        <th style="text-align:right">Qty (KG)</th>
        ${thead5extra}
    </tr></thead>
    <tbody>${rowsHtml}${totalRow}</tbody>
</table>
<div class="ftr">
    <div>
        <div><strong>HCP Wellness Pvt Ltd</strong> &nbsp;·&nbsp; ${typeLabel} &nbsp;·&nbsp; Printed: ${printDate}</div>
    </div>
    <div class="sign-row">
        <div class="sb"><div style="height:8mm"></div><div class="sl">Batch Dispenser</div></div>
        <div class="sb"><div style="height:8mm"></div><div class="sl">Batch Incharge</div></div>
        <div class="sb"><div style="height:8mm"></div><div class="sl">Approved By</div></div>
    </div>
</div>
</div></div>
${manufProcess ? (
'<div id="mp-page" style="page-break-before:always"><div id="mp-shell"><div id="mp-wrap">'
+'<div class="mp-hdr">'
+'<div class="mp-hdr-left">'
+'<div class="mp-co">HCP Wellness Pvt Ltd &nbsp;·&nbsp; Manufacturing Process</div>'
+'<div class="mp-ti">'+batchName+(productCode?'<span class="mp-pc"> &nbsp;·&nbsp; <span class="mp-pc-l">Product Code:</span> <strong>'+productCode+'</strong></span>':'')+'</div>'
+'</div>'
+'<div class="mp-hdr-right"><div>Date: <strong>'+printDate+'</strong></div>'+(batchSize?'<div class="mp-bs">'+fmtNum(batchSize,3)+' KG</div><div style="font-size:6pt">Batch Size</div>':'')+'</div>'
+'</div>'
+'<div class="mp-body">'+manufProcess+'</div>'
+'<div class="mp-ftr">'
+'<div><strong>HCP Wellness Pvt Ltd</strong> &nbsp;·&nbsp; Manufacturing Process &nbsp;·&nbsp; Printed: '+printDate+'</div>'
+'<div class="sign-row">'
+'<div class="sb"><div style="height:8mm"></div><div class="sl">Batch Dispenser</div></div>'
+'<div class="sb"><div style="height:8mm"></div><div class="sl">Batch Incharge</div></div>'
+'<div class="sb"><div style="height:8mm"></div><div class="sl">Approved By</div></div>'
+'</div>'
+'</div>'
+'</div></div></div>'
) : ''}
<script>
window.onload=function(){
    function fit(shellId,wrapId){
        var s=document.getElementById(shellId),w=document.getElementById(wrapId);
        if(!s||!w)return;
        w.style.transform='';w.style.width='';w.style.height='';
        var sw=s.clientWidth,sh=s.clientHeight,ww=w.scrollWidth,wh=w.scrollHeight;
        if(wh>sh||ww>sw){
            var r=Math.min(sw/ww,sh/wh);
            w.style.transformOrigin='top left';
            w.style.transform='scale('+r+')';
            w.style.width=(100/r)+'%';
        }
    }
    function doFit(){ fit('form-shell','form-wrap'); fit('mp-shell','mp-wrap'); }
    doFit();
    if(document.fonts&&document.fonts.ready){
        document.fonts.ready.then(function(){ doFit(); setTimeout(function(){ doFit(); window.print(); },120); });
    } else {
        setTimeout(function(){ doFit(); window.print(); },400);
    }
};
<\/script>
</body></html>`;
}

function _doPrint(htmlContent){
    const pw=window.open('','_blank','width=1120,height=800');
    if(!pw){ toast('Pop-up blocked — please allow pop-ups for this page','error',5000); return; }
    pw.document.write(htmlContent);
    pw.document.close();
}

/* ═══════════════════════════════════════════════════════
   MANUFACTURING PROCESS — pure contenteditable
   No third-party library. Works immediately with zero init.
   mpCmd()   → execCommand wrapper for toolbar buttons
   mpPaste() → intercepts paste, cleans HTML, keeps tables/bold/alignment
   mpDirty() → shows Save button on any change
═══════════════════════════════════════════════════════ */

function loadManufProcess(batchName){
    const meta = (_fvqBatches||[]).find(b=>b.batch_name===batchName)||{};
    const html = meta.manuf_process || '';
    const ed   = document.getElementById('fvqManufEditor');
    const btn  = document.getElementById('fvqManufSaveBtn');
    if(ed) ed.innerHTML = html;
    if(btn) btn.style.display = 'none';
}

/** Toolbar button handler */
function mpCmd(cmd){
    document.getElementById('fvqManufEditor').focus();
    document.execCommand(cmd, false, null);
    mpDirty();
}

/** Show Save button whenever content changes */
function mpDirty(){
    const btn = document.getElementById('fvqManufSaveBtn');
    if(btn){ btn.style.display = 'inline-flex'; }
}

/**
 * Paste handler — strips Word/Excel noise but keeps:
 * table structure, bold, italic, underline, text-align, numbered/bullet lists
 */
function mpPaste(e){
    e.preventDefault();
    const html  = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');

    if(html){
        const tmp = document.createElement('div');
        tmp.innerHTML = html;

        // Remove junk (o:p = Word empty tag, can't use CSS selector for namespaced tags)
        tmp.querySelectorAll('script,style,img,meta,link,head,title').forEach(el=>el.remove());
        tmp.querySelectorAll('*').forEach(el=>{
            if(el.tagName && el.tagName.toLowerCase()==='o:p') el.remove();
        });

        // ── Pass 1: capture alignment/formatting BEFORE wiping attributes ────
        const styleMap = new Map();
        tmp.querySelectorAll('*').forEach(el=>{
            // Read computed style values before any attribute removal
            const ta = el.style.textAlign || el.getAttribute('align') || '';
            const fw = el.style.fontWeight || '';
            const fs = el.style.fontStyle  || '';
            const td = el.style.textDecoration || '';
            styleMap.set(el, { ta, fw, fs, td });
        });

        // ── Pass 2: wipe all attributes except structural ones ────────────────
        tmp.querySelectorAll('*').forEach(el=>{
            const keep = ['colspan','rowspan','href'];
            [...el.attributes].forEach(a=>{
                if(!keep.includes(a.name)) el.removeAttribute(a.name);
            });
        });

        // ── Pass 3: restore only meaningful styles ────────────────────────────
        tmp.querySelectorAll('*').forEach(el=>{
            const tag = el.tagName.toLowerCase();
            const info = styleMap.get(el) || {};
            const s = [];
            if(info.ta && info.ta!=='start' && info.ta!=='left')
                s.push('text-align:'+info.ta);
            if(info.fw && (info.fw==='bold'||parseInt(info.fw)>=600))
                s.push('font-weight:bold');
            if(info.fs==='italic')
                s.push('font-style:italic');
            if(info.td && info.td.includes('underline'))
                s.push('text-decoration:underline');
            // Table cells always get border/padding
            if(tag==='td'||tag==='th'){
                s.push('border:1px solid #cbd5e1');
                s.push('padding:4px 8px');
                s.push('vertical-align:top');
                s.push('min-width:40px');
            }
            if(tag==='th'){
                s.push('font-weight:bold');
                s.push('background:#f1f5f9');
                if(!info.ta) s.push('text-align:center');
            }
            if(tag==='table'){
                s.push('border-collapse:collapse');
                s.push('width:100%');
                s.push('margin:4px 0');
                s.push('font-size:12px');
            }
            if(s.length) el.setAttribute('style', s.join(';'));
        });

        // ── Pass 4: unwrap cosmetic spans with no style ───────────────────────
        tmp.querySelectorAll('span').forEach(span=>{
            if(!span.getAttribute('style')){
                const p = span.parentNode;
                if(p){ while(span.firstChild) p.insertBefore(span.firstChild,span); p.removeChild(span); }
            }
        });

        document.execCommand('insertHTML', false, tmp.innerHTML);
    } else {
        // Plain text — preserve line breaks
        const lines = plain.split('\n').map(l=>escHtml(l)).join('<br>');
        document.execCommand('insertHTML', false, lines);
    }
    mpDirty();
}

async function saveManufProcess(){
    // ── Defensive: get batch name from variable OR title element ──────
    const batchName = _fvqDetailBatch
        || document.getElementById('fvqDetailTitle')?.textContent?.trim()
        || null;

    if(!batchName){
        toast('Cannot save — no batch is open','error');
        console.error('[saveManufProcess] _fvqDetailBatch is null');
        return;
    }

    const ed  = document.getElementById('fvqManufEditor');
    const btn = document.getElementById('fvqManufSaveBtn');

    if(!ed){
        toast('Editor element not found','error');
        console.error('[saveManufProcess] #fvqManufEditor not found in DOM');
        return;
    }

    const rawHtml = ed.innerHTML.trim();
    const plainText = rawHtml.replace(/<[^>]*>/g,'').replace(/&nbsp;/g,'').trim();
    const html = plainText ? rawHtml : '';
    console.log('[saveManufProcess] batch:', batchName, ' empty:', !plainText);

    if(btn){ btn.disabled=true; btn.innerHTML='Saving&hellip;'; }

    try{
        const res = await fetch('/api/procurement/formulations/manuf_process',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({action:'save', batch_name:batchName, text:html})
        });

        let data;
        try{ data = await res.json(); }
        catch(jsonErr){
            throw new Error('Server returned non-JSON response (status '+res.status+')');
        }

        console.log('[saveManufProcess] server response:', data);

        if(data.status!=='ok') throw new Error(data.message||'Server returned error');

        const m = (_fvqBatches||[]).find(b=>b.batch_name===batchName);
        if(m) m.manuf_process = html;

        // Sync cache for all linked batches the backend propagated to
        const propagated = data.propagated_to || [];
        for(const pName of propagated){
            try{
                const pr=await fetch('/api/procurement/formulations/manuf_process',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({action:'get',batch_name:pName})
                });
                const pd=await pr.json();
                if(pd.status==='ok'){
                    const pm=(_fvqBatches||[]).find(b=>b.batch_name===pName);
                    if(pm) pm.manuf_process=pd.text||'';
                    if(_fvqDetailBatch===pName){
                        const ed2=document.getElementById('fvqManufEditor');
                        if(ed2) ed2.innerHTML=pd.text||'';
                    }
                }
            }catch(e){}
        }
        fvqRenderTable();
        const pc=propagated.length;
        toast('Manufacturing process saved'+(pc?' · synced to '+pc+' linked batch'+(pc!==1?'es':''):''),'success');
        if(btn){ btn.style.display='none'; btn.disabled=false; btn.innerHTML='&#10003; Save Process'; }

    }catch(err){
        console.error('[saveManufProcess] error:', err);
        toast('Save failed: '+err.message, 'error');
        if(btn){ btn.disabled=false; btn.innerHTML='&#10003; Save Process'; }
    }
}

/* Legacy stubs — no longer used but kept so nothing throws */
function rteCmd(cmd){ mpCmd(cmd); }
function rteClearFormat(){ mpCmd('removeFormat'); }
function rteOnInput(){ mpDirty(); }
function rtePaste(e){ mpPaste(e); }
function fvqManufToggleEdit(){ document.getElementById('fvqManufEditor')?.focus(); }
let _manufQuill = null; // stub so printManufProcess fallback doesn't throw

/* ── Standalone process-only print ── */
function printManufProcess(){
    const batchName = _fvqDetailBatch;
    if(!batchName){ toast('No batch selected','warning'); return; }

    // Get content from contenteditable editor or cache
    const _mpEd = document.getElementById('fvqManufEditor');
    let html = _mpEd ? _mpEd.innerHTML.trim() : '';
    const meta = (_fvqBatches||[]).find(b=>b.batch_name===batchName)||{};
    const cached = meta.manuf_process || '';
    const content = html || cached;

    if(!content){ toast('No manufacturing process to print — enter the process first','warning'); return; }

    const printDate   = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const productCode = meta.product_code||'';
    const batchSize   = meta.batch_size||'';

    const printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Manufacturing Process — ${escHtml(batchName)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 portrait;margin:0}
html,body{width:210mm;height:297mm;overflow:hidden;font-family:'DM Sans','Segoe UI',sans-serif;color:#1a2035;background:#fff}
#shell{width:210mm;height:297mm;padding:12mm 14mm;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column}
#wrap{flex:1;display:flex;flex-direction:column;transform-origin:top left;min-height:0}
.hdr{margin-bottom:4mm;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2pt solid #0d9488;padding-bottom:3mm;flex-shrink:0}
.hdr-left .co{font-size:6pt;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#94a3b8;margin-bottom:1mm}
.hdr-left .ti{font-size:11pt;font-weight:700;color:#0f172a;line-height:1.2}
.hdr-left .pc{font-size:7pt;color:#64748b;margin-top:1mm;font-family:'DM Mono',monospace}
.hdr-right{text-align:right;font-size:6.5pt;color:#64748b;line-height:1.8}
.hdr-right .bs{font-size:9pt;font-weight:700;color:#0d9488;font-family:'DM Mono',monospace}
.type-badge{display:inline-block;font-size:5.5pt;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:1px 5px;border-radius:3px;margin-bottom:2mm;background:#ecfdf5;color:#065f46;border:1pt solid #6ee7b7}
.slabel{font-size:6pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;border-left:3pt solid #0d9488;padding-left:3mm;margin-bottom:2mm;flex-shrink:0}
.pbody{font-size:7.5pt;color:#1a2035;line-height:1.5;padding:3mm;background:#f8fafc;border:1pt solid #e2e8f0;border-radius:3px;flex:1;overflow:hidden}
.pbody ol,.pbody ul{margin:1mm 0 1mm 5mm;padding:0}
.pbody li{margin:.5mm 0}
.pbody b,.pbody strong{font-weight:700}
.pbody table{border-collapse:collapse;width:100%;font-size:7pt;margin:1mm 0;table-layout:fixed}
.pbody td,.pbody th{border:.75pt solid #cbd5e1;padding:1mm 2mm;vertical-align:top;word-wrap:break-word}
.pbody th{background:#f1f5f9;font-weight:700;text-align:center}
.ftr{margin-top:2mm;padding-top:2mm;border-top:1pt solid #e2e8f0;flex-shrink:0;display:flex;justify-content:space-between;align-items:flex-end;font-size:6pt;color:#94a3b8}
.sign-row{display:flex;gap:12mm}
.sb{text-align:center;min-width:32mm}
.sl{border-top:.75pt solid #cbd5e1;padding-top:1mm;margin-top:6mm;font-weight:600;color:#475569;font-size:6pt}
</style>
</head>
<body>
<div id="shell"><div id="wrap">
<div class="hdr">
    <div class="hdr-left">
        <div class="co">HCP Wellness Pvt Ltd · Manufacturing Process</div>
        <div class="type-badge">Process Sheet</div>
        <div class="ti">${escHtml(batchName)}</div>
        ${productCode?`<div class="pc">Product Code: <strong>${escHtml(productCode)}</strong></div>`:''}
    </div>
    <div class="hdr-right">
        <div>Date: <strong>${printDate}</strong></div>
        ${batchSize?`<div class="bs">${escHtml(batchSize)}</div><div style="font-size:5.5pt">Batch Size</div>`:''}
    </div>
</div>
<div class="slabel">Step-by-Step Manufacturing Process</div>
<div class="pbody">${content}</div>
<div class="ftr">
    <div><strong>HCP Wellness Pvt Ltd</strong> · Process Sheet · Printed: ${printDate}</div>
    <div class="sign-row">
        <div class="sb"><div class="sl">Batch Incharge</div></div>
        <div class="sb"><div class="sl">Approved By</div></div>
    </div>
</div>
</div></div>
<script>
window.onload=function(){
    function sc(){
        var s=document.getElementById('shell'),w=document.getElementById('wrap');
        if(!s||!w)return;
        w.style.transform='';w.style.width='';
        var sw=s.clientWidth,sh=s.clientHeight,ww=w.scrollWidth,wh=w.scrollHeight;
        if(wh>sh||ww>sw){var r=Math.min(sw/ww,sh/wh);w.style.transform='scale('+r+')';w.style.width=(100/r)+'%';w.style.transformOrigin='top left';}
    }
    sc();
    if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){sc();window.print();});
    else setTimeout(function(){sc();window.print();},400);
};
<\/script>
</body></html>`;

    _doPrint(printHtml);
}

/* ═══════════════════════════════════════════════════════
   IMPORT DROPDOWN — split button toggle
═══════════════════════════════════════════════════════ */
function toggleFvqImportMenu(){
    const m = document.getElementById('fvqImportMenu');
    if(!m) return;
    const open = m.style.display !== 'none';
    // Close actions menu if open
    const am = document.getElementById('fvqActionsMenu');
    if(am) am.style.display = 'none';
    m.style.display = open ? 'none' : 'block';
    if(!open) setTimeout(()=>document.addEventListener('click', _closeFvqImportMenu, {once:true}), 10);
}
function _closeFvqImportMenu(){
    const m = document.getElementById('fvqImportMenu');
    if(m) m.style.display = 'none';
}

function toggleFvqActionsMenu(){
    const m = document.getElementById('fvqActionsMenu');
    if(!m) return;
    const open = m.style.display !== 'none';
    // Close import menu if open
    const im = document.getElementById('fvqImportMenu');
    if(im) im.style.display = 'none';
    m.style.display = open ? 'none' : 'block';
    if(!open) setTimeout(()=>document.addEventListener('click', _closeFvqActionsMenu, {once:true}), 10);
}
function _closeFvqActionsMenu(){
    const m = document.getElementById('fvqActionsMenu');
    if(m) m.style.display = 'none';
}

/* ═══════════════════════════════════════════════════════
   IMPORT MANUFACTURING PROCESS — upload modal
═══════════════════════════════════════════════════════ */
function openFvqManufImport(){
    document.getElementById('fvqMpUploadZone').style.display = 'flex';
    document.getElementById('fvqMpSpinner').style.display    = 'none';
    document.getElementById('fvqMpHint').textContent = 'Select an Excel file to begin';
    document.getElementById('fvqManufImportModal').classList.add('open');
}
function closeFvqManufImport(){
    document.getElementById('fvqManufImportModal').classList.remove('open');
}
document.getElementById('fvqManufImportModal')?.addEventListener('click', e=>{
    if(e.target === document.getElementById('fvqManufImportModal')) closeFvqManufImport();
});

function fvqMpHandleDrop(e){
    const file = e.dataTransfer.files[0];
    if(file) fvqMpStartImport(file);
}

/* Step 1 — analyse file and show preview before committing */
let _fvqMpPendingFile = null;
let _fvqMpPreview      = [];   // preview rows for live status update

async function fvqMpStartImport(file){
    if(!file) return;
    if(!file.name.toLowerCase().endsWith('.xlsx')){
        toast('Only .xlsx files accepted','error'); return;
    }
    _fvqMpPendingFile = file;

    document.getElementById('fvqMpUploadZone').style.display = 'none';
    document.getElementById('fvqMpSpinner').style.display    = 'block';
    document.getElementById('fvqMpHint').textContent         = 'Analysing ' + file.name + '…';

    const fd = new FormData();
    fd.append('file', file);

    try{
        const res  = await fetch('/api/procurement/formulations/inspect', {method:'POST', body:fd});
        const data = await res.json();
        document.getElementById('fvqMpSpinner').style.display = 'none';

        if(data.status !== 'ok'){
            toast('Could not read file: '+(data.message||'Error'),'error');
            document.getElementById('fvqMpUploadZone').style.display = 'flex';
            document.getElementById('fvqMpHint').textContent = 'Error — try again';
            return;
        }

        const basename    = data.basename || file.name.replace(/\.xlsx$/i,'');
        const validSheets = data.sheets || [];
        const allSheets   = [...validSheets, ...Object.keys(data.invalid_sheets||{})];

        // Derive batch names + check status against in-memory cache
        const preview = allSheets.map(sname=>{
            const batchName = sname.trim().toLowerCase().split(/\s+/).every(w=>basename.toLowerCase().includes(w))
                ? basename.trim()
                : basename.trim() + ' \u2013 ' + sname;
            const isInvalid  = !validSheets.includes(sname);
            const existing   = (_fvqBatches||[]).find(b=>b.batch_name===batchName);
            const hasProcess = existing && existing.manuf_process && existing.manuf_process.trim();
            let status, message;
            if(isInvalid){         status='invalid';     message='Sheet structure invalid'; }
            else if(!existing){    status='not_found';   message='Batch not found in database'; }
            else if(hasProcess){   status='skip';        message='Already has manufacturing process — will be skipped'; }
            else{                  status='will_import'; message='Ready to import'; }
            return {sheet:sname, batch_name:batchName, status, message};
        });

        const willImport = preview.filter(r=>r.status==='will_import').length;
        const willSkip   = preview.filter(r=>r.status==='skip').length;
        const notFound   = preview.filter(r=>r.status==='not_found').length;
        const invalid    = preview.filter(r=>r.status==='invalid').length;

        document.getElementById('fvqMpConfirmSub').textContent =
            basename+' · '+allSheets.length+' sheet'+(allSheets.length!==1?'s':'');

        document.getElementById('fvqMpConfirmSummary').innerHTML = [
            {label:'Will Import', val:willImport, color:'var(--green-text)'},
            {label:'Already Have', val:willSkip,  color:'var(--muted2)'},
            {label:'Not Found',   val:notFound,   color:'var(--amber-text)'},
            {label:'Invalid',     val:invalid,    color:'var(--red-text)'},
        ].map(s=>`<div style="display:flex;flex-direction:column;gap:2px">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)">${s.label}</span>
            <span style="font-size:1.2rem;font-weight:700;color:${s.color}">${s.val}</span>
        </div>`).join('<div style="width:1px;background:var(--border);align-self:stretch"></div>');

        const colorMap = {will_import:'var(--green-text)',skip:'var(--muted2)',not_found:'var(--amber-text)',invalid:'var(--red-text)'};
        const iconMap  = {will_import:'✓',skip:'–',not_found:'?',invalid:'✕'};
        const bgMap    = {will_import:'var(--green-bg)',skip:'var(--text-08)',not_found:'var(--amber-bg)',invalid:'var(--red-bg)'};

        _fvqMpPreview = preview;
        document.getElementById('fvqMpConfirmList').innerHTML = preview.map((r,i)=>{
            return `<div id="fvqMpRow_${i}" style="display:flex;align-items:flex-start;gap:10px;padding:9px 20px;border-bottom:1px solid var(--border);${i%2?'background:var(--text-05)':''}">`
                +`<span id="fvqMpIcon_${i}" style="font-size:12px;font-weight:700;color:${colorMap[r.status]};flex-shrink:0;margin-top:1px">${iconMap[r.status]}</span>`
                +`<div style="flex:1;min-width:0">`
                +`<div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(r.batch_name)}">${escHtml(r.batch_name)}</div>`
                +`<div id="fvqMpMsg_${i}" style="font-size:10.5px;color:var(--muted);margin-top:1px">${escHtml(r.message)}</div>`
                +`</div>`
                +`<span id="fvqMpBadge_${i}" style="font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:20px;flex-shrink:0;background:${bgMap[r.status]};color:${colorMap[r.status]}">${r.status.replace('_',' ')}</span>`
                +`</div>`;
        }).join('');

        document.getElementById('fvqMpConfirmHint').textContent =
            willImport+' will be imported · '+(willSkip+notFound+invalid)+' skipped';
        const cb = document.getElementById('fvqMpConfirmBtn');
        cb.disabled = willImport===0; cb.style.opacity = willImport>0?'1':'.45';

        closeFvqManufImport();
        document.getElementById('fvqMpConfirmModal').classList.add('open');

    }catch(err){
        document.getElementById('fvqMpSpinner').style.display   = 'none';
        document.getElementById('fvqMpUploadZone').style.display = 'flex';
        toast('Error: '+err.message,'error');
        document.getElementById('fvqMpHint').textContent = 'Error — try again';
    }
}

function fvqMpCancelConfirm(){
    document.getElementById('fvqMpConfirmModal').classList.remove('open');
    _fvqMpPendingFile = null;
}
document.getElementById('fvqMpConfirmModal')?.addEventListener('click', e=>{
    if(e.target===document.getElementById('fvqMpConfirmModal')) fvqMpCancelConfirm();
});

/* Step 2 — confirmed: call bulk API then update each row live from response */
async function fvqMpRunImport(){
    if(!_fvqMpPendingFile){ toast('No file pending','error'); return; }
    const btn = document.getElementById('fvqMpConfirmBtn');
    btn.disabled=true; btn.textContent='Importing…';

    // Mark all "will_import" rows as pending (spinner dots)
    _fvqMpPreview.forEach((r,i)=>{
        if(r.status==='will_import'){
            const badge = document.getElementById('fvqMpBadge_'+i);
            const icon  = document.getElementById('fvqMpIcon_'+i);
            const msg   = document.getElementById('fvqMpMsg_'+i);
            if(badge){ badge.style.background='var(--text-08)'; badge.style.color='var(--muted2)'; badge.textContent='pending…'; }
            if(icon)  icon.textContent = '○';
            if(msg)   msg.textContent  = 'Waiting…';
        }
    });

    const fd = new FormData();
    fd.append('file', _fvqMpPendingFile);

    try{
        const res  = await fetch('/api/procurement/formulations/import_manuf_process',{method:'POST',body:fd});
        const data = await res.json();

        if(data.status!=='ok'){
            btn.disabled=false; btn.textContent='✓ Confirm Import';
            toast('Import failed: '+(data.message||'Error'),'error');
            return;
        }

        // Build a map of batch_name → result for quick lookup
        const resultMap = {};
        (data.results||[]).forEach(r=>{ resultMap[r.batch_name] = r; });

        // Update each row live
        let doneCount=0, total=_fvqMpPreview.filter(r=>r.status==='will_import').length;
        for(let i=0; i<_fvqMpPreview.length; i++){
            const pr = _fvqMpPreview[i];
            if(pr.status !== 'will_import') continue;

            const badge = document.getElementById('fvqMpBadge_'+i);
            const icon  = document.getElementById('fvqMpIcon_'+i);
            const msg   = document.getElementById('fvqMpMsg_'+i);
            const row   = document.getElementById('fvqMpRow_'+i);
            const result = resultMap[pr.batch_name];

            // Small stagger delay so updates are visually distinct
            await new Promise(res=>setTimeout(res, 60));

            if(result && result.status==='updated'){
                if(badge){ badge.style.background='var(--green-bg)'; badge.style.color='var(--green-text)'; badge.textContent='✓ imported'; }
                if(icon) { icon.style.color='var(--green-text)'; icon.textContent='✓'; }
                if(msg)  { msg.textContent='Imported successfully'; msg.style.color='var(--green-text)'; }
                if(row)  { row.style.borderLeft='3px solid var(--green-text)'; }
            } else if(result && result.status==='skipped'){
                if(badge){ badge.style.background='var(--text-08)'; badge.style.color='var(--muted2)'; badge.textContent='skipped'; }
                if(icon) { icon.style.color='var(--muted2)'; icon.textContent='–'; }
                if(msg)  { msg.textContent = result.message || 'Skipped'; }
            } else {
                if(badge){ badge.style.background='var(--amber-bg)'; badge.style.color='var(--amber-text)'; badge.textContent='failed'; }
                if(icon) { icon.style.color='var(--amber-text)'; icon.textContent='!'; }
                if(msg)  { msg.textContent = result ? result.message : 'No result returned'; }
            }
            doneCount++;
            document.getElementById('fvqMpConfirmHint').textContent =
                doneCount+' / '+total+' processed…';
        }

        // Final summary
        document.getElementById('fvqMpConfirmHint').textContent =
            data.updated+' imported · '+data.skipped+' skipped · '+data.not_found+' not found';
        btn.textContent='Done'; btn.style.background='var(--green)';
        setTimeout(()=>{
            btn.style.background=''; btn.textContent='✓ Confirm Import';
        }, 2000);

        if(data.updated>0) loadFvqData();
        _fvqMpPendingFile = null;

    }catch(err){
        btn.disabled=false; btn.textContent='✓ Confirm Import';
        toast('Import error: '+err.message,'error');
    }
}

/* ════════════════════════════════════════════════════════
   BRAND MANAGEMENT
════════════════════════════════════════════════════════ */
// _fvqBrands/_fvqBrandFilter declared at top

function getBrandById(id){
    if(!id) return null;
    return _fvqBrands.find(b=>b.id===id||b.id===Number(id))||null;
}

async function loadBrands(){
    try{
        const res=await fetch('/api/procurement/brands');
        const data=await res.json();
        if(data.status==='ok') _fvqBrands=data.brands||[];
        _renderBrandList();
        _populateBrandSelects();
    }catch(e){}
}

// Brand Manager UI state
let _brandMgrSearch  = '';
let _brandAddMode    = 'single';   // 'single' | 'bulk'

function _onBrandSearchInput(val){
    _brandMgrSearch = (val||'').trim();
    const clr = document.getElementById('brandMgrSearchClear');
    if(clr) clr.style.display = _brandMgrSearch ? 'flex' : 'none';
    _renderBrandList();
}

function _setBrandAddMode(mode){
    _brandAddMode = (mode==='bulk') ? 'bulk' : 'single';
    const sBtn  = document.getElementById('brandAddModeSingleBtn');
    const bBtn  = document.getElementById('brandAddModeBulkBtn');
    const sRow  = document.getElementById('brandAddSingleRow');
    const bRow  = document.getElementById('brandAddBulkRow');
    const hint  = document.getElementById('brandAddModeHint');
    if(sBtn){ sBtn.className = (mode==='single') ? 'btn-save' : 'btn-ghost'; }
    if(bBtn){ bBtn.className = (mode==='bulk')   ? 'btn-save' : 'btn-ghost'; }
    if(sRow) sRow.style.display = (mode==='single') ? 'flex' : 'none';
    if(bRow) bRow.style.display = (mode==='bulk')   ? 'block' : 'none';
    if(hint) hint.textContent = (mode==='bulk') ? 'Paste or type one brand per line' : 'Excel: column A = brand names. Colours are picked automatically.';
    if(mode==='single'){
        setTimeout(()=>document.getElementById('brandNewName')?.focus(), 30);
    } else {
        setTimeout(()=>document.getElementById('brandBulkText')?.focus(), 30);
    }
}

function _renderBrandList(){
    const el=document.getElementById('brandMgrList');
    if(!el) return;
    const total = _fvqBrands.length;

    // Apply search filter
    const q = (_brandMgrSearch||'').toLowerCase();
    const list = q ? _fvqBrands.filter(b => (b.name||'').toLowerCase().includes(q)) : _fvqBrands.slice();

    // Update count badge
    const cntEl = document.getElementById('brandMgrCount');
    if(cntEl){
        if(!total) cntEl.textContent = '';
        else if(q) cntEl.textContent = list.length+' of '+total+' brand'+(total!==1?'s':'');
        else       cntEl.textContent = total+' brand'+(total!==1?'s':'');
    }

    // Empty states
    if(!total){
        el.innerHTML='<div style="padding:32px 18px;text-align:center;color:var(--muted);font-size:12.5px">No brands yet — add one below</div>';
        return;
    }
    if(!list.length){
        const safeQ = escHtml(_brandMgrSearch);
        el.innerHTML='<div style="padding:32px 18px;text-align:center;color:var(--muted);font-size:12.5px">No brands match “'+safeQ+'”</div>';
        return;
    }

    // Multi-column responsive grid (auto-fit cards)
    const cards = list.map(b=>{
        const nm   = escHtml(b.name);
        const safe = b.name.replace(/'/g,"\\'");
        const c    = b.color||'#6366f1';
        const tc   = b.text_color||'#ffffff';
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);transition:background .12s,border-color .12s" '
              +'onmouseover="this.style.background=\'var(--text-05)\';this.style.borderColor=\'var(--border2)\'" '
              +'onmouseout="this.style.background=\'var(--surface)\';this.style.borderColor=\'var(--border)\'">'
            +'<div style="width:14px;height:14px;border-radius:50%;background:'+c+';flex-shrink:0;box-shadow:0 0 0 3px '+c+'33"></div>'
            +'<span style="flex:1;font-size:12px;font-weight:600;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+nm+'">'+nm+'</span>'
            +'<span style="font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:20px;background:'+c+';color:'+tc+';border:1px solid '+c+'55;flex-shrink:0;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+nm+'">'+nm+'</span>'
            +'<button onclick="editBrand('+b.id+',\''+safe+'\',\''+c+'\',\''+tc+'\')" class="btn-ghost" style="height:26px;padding:0 9px;font-size:10.5px;flex-shrink:0">Edit</button>'
            +'<button onclick="deleteBrand('+b.id+',\''+safe+'\')" class="btn-ghost" style="height:26px;padding:0 9px;font-size:10.5px;color:var(--red-text);border-color:rgba(244,63,94,.35);flex-shrink:0" title="Delete">&#10005;</button>'
            +'</div>';
    }).join('');

    el.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px">'+cards+'</div>';
}

function _populateBrandSelects(){
    const opts='<option value="">All Brands</option>'
        +'<option value="__none__">— No Brand —</option>'
        +_fvqBrands.map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
    const sel=document.getElementById('fvqBrandFilter');
    if(sel){const v=sel.value;sel.innerHTML=opts;sel.value=v;comboboxRefresh(sel);}

    const opts2='<option value="">— No Brand —</option>'
        +_fvqBrands.map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
    document.querySelectorAll('.fvq-brand-assign-sel').forEach(s=>{const v=s.value;s.innerHTML=opts2;s.value=v;if(typeof comboboxRefresh==='function')comboboxRefresh(s);});

    const mb=document.getElementById('manualFormBrand');
    if(mb){mb.innerHTML=opts2; if(typeof comboboxRefresh==='function') comboboxRefresh(mb);}
    const lb2=document.getElementById('manualLinkBrand');
    if(lb2){lb2.innerHTML=opts2; if(typeof comboboxRefresh==='function') comboboxRefresh(lb2);}
}

/* Shared dropdown toggle for Formulations/Brands/Procurement menus */
function toggleFvqMenu(id){
    const menus=['fvqFormulationsMenu','fvqBrandsMenu','fvqProcurementMenu'];
    menus.forEach(m=>{
        if(m!==id){ const el=document.getElementById(m); if(el) el.style.display='none'; }
    });
    const el=document.getElementById(id);
    if(!el) return;
    const open=el.style.display!=='none';
    el.style.display=open?'none':'block';

    // Always populate brand selects with latest data when opening Brands menu
    if(!open && id==='fvqBrandsMenu'){
        const opts='<option value="">— No Brand —</option>'
            +(_fvqBrands||[]).map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
        ['fvqBulkBrandSel','fvqBulkBrandBarSel'].forEach(sid=>{
            const s=document.getElementById(sid); if(s) { s.innerHTML=opts; if(typeof comboboxRefresh==='function') comboboxRefresh(s); }
        });
    }

    if(!open) setTimeout(()=>document.addEventListener('click',function _c(e){
        if(!el.contains(e.target)&&!el.previousElementSibling?.contains(e.target)){
            el.style.display='none'; document.removeEventListener('click',_c);
        }
    }),10);
}

/* Assign brand from the always-visible bulk bar (separate select from menu one) */
async function assignBrandToSelectedBar(){
    const checked = _fvqSelectedBatches.size > 0
        ? [..._fvqSelectedBatches]
        : [...document.querySelectorAll('.fvq-row-cb:checked')].map(c=>c.dataset.batch);
    if(!checked.length){toast('Select at least one formulation','warning');return;}
    const sel=document.getElementById('fvqBulkBrandBarSel');
    const brand_id=sel&&sel.value?parseInt(sel.value):null;
    try{
        const res=await fetch('/api/procurement/formulations/set_brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_names:checked,brand_id})});
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const bname=_fvqBrands.find(b=>b.id===brand_id)?.name||'(unbranded)';
        toast('Brand "'+bname+'" set on '+checked.length+' formulation'+(checked.length!==1?'s':''),'success');
        // Update in-memory, preserve page & selection
        checked.forEach(batchName=>{
            const m=(_fvqBatches||[]).find(b=>b.batch_name===batchName);
            if(m) m.brand_id=brand_id;
        });
        fvqRenderTable();
    }catch(e){toast('Error: '+e.message,'error');}
}

function fvqSetBrandFilter(val){ _fvqBrandFilter=val; fvqClearSelectionAndFilter(); }

function openBrandMgr(){
    // Reset transient UI state on every open
    _brandMgrSearch = '';
    const sIn = document.getElementById('brandMgrSearch');
    if(sIn) sIn.value = '';
    const clr = document.getElementById('brandMgrSearchClear');
    if(clr) clr.style.display = 'none';
    const cnt = document.getElementById('brandMgrCount');
    if(cnt) cnt.textContent = '';
    _setBrandAddMode('single');
    const ta = document.getElementById('brandBulkText');
    if(ta) ta.value = '';
    loadBrands();
    document.getElementById('brandMgrModal').classList.add('open');
}
function closeBrandMgr(){ document.getElementById('brandMgrModal').classList.remove('open'); }
document.getElementById('brandMgrModal')?.addEventListener('click',e=>{
    if(e.target===document.getElementById('brandMgrModal')) closeBrandMgr();
});

async function addBrand(){
    const name=(document.getElementById('brandNewName').value||'').trim();
    const color=document.getElementById('brandNewColor').value||'#6366f1';
    const text_color=document.getElementById('brandNewTextColor').value||'#ffffff';
    if(!name){toast('Enter brand name','warning');return;}
    try{
        const res=await fetch('/api/procurement/brands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,color,text_color})});
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        document.getElementById('brandNewName').value='';
        document.getElementById('brandNewColor').value='#6366f1';
        document.getElementById('brandNewTextColor').value='#ffffff';
        toast('Brand "'+name+'" added','success');
        await loadBrands();
        fvqRenderTable();
        document.getElementById('brandNewName')?.focus();
    }catch(e){toast('Error: '+e.message,'error');}
}

/* Bulk add: parse textarea (one brand per line, optional `name | #bg | #text` overrides),
   pre-detect duplicates against current _fvqBrands & within the input itself, then POST
   the unique set to the bulk endpoint. Reports added / skipped via toasts. */
async function addBrandsBulk(){
    const ta = document.getElementById('brandBulkText');
    if(!ta){toast('Bulk input not found','error');return;}
    const raw = (ta.value||'').split(/\r?\n/);
    const defColor = document.getElementById('brandBulkColor')?.value || '#6366f1';
    const defText  = document.getElementById('brandBulkTextColor')?.value || '#ffffff';

    const isHexColor = (s) => typeof s === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());

    // Parse + dedupe within the input (case-insensitive on name)
    const existingLower = new Set((_fvqBrands||[]).map(b => (b.name||'').toLowerCase()));
    const seenInBatch   = new Set();
    const toCreate = [];           // [{name,color,text_color}]
    const skippedDup = [];         // names duplicating existing brands or within batch
    const skippedBadColor = [];    // names where color override was malformed (still added with default)

    raw.forEach(line => {
        const t = (line||'').trim();
        if(!t) return;
        const parts = t.split('|').map(s => s.trim());
        const name  = parts[0];
        if(!name) return;
        if(name.length > 200){ skippedDup.push(name.slice(0,40)+'… (too long)'); return; }
        const lower = name.toLowerCase();
        if(existingLower.has(lower) || seenInBatch.has(lower)){
            skippedDup.push(name);
            return;
        }
        seenInBatch.add(lower);

        let color = defColor, text_color = defText, hadBadColor = false;
        if(parts.length >= 2 && parts[1]){
            if(isHexColor(parts[1])) color = parts[1];
            else hadBadColor = true;
        }
        if(parts.length >= 3 && parts[2]){
            if(isHexColor(parts[2])) text_color = parts[2];
            else hadBadColor = true;
        }
        if(hadBadColor) skippedBadColor.push(name);
        toCreate.push({name, color, text_color});
    });

    if(!toCreate.length){
        if(skippedDup.length) toast('All '+skippedDup.length+' line'+(skippedDup.length!==1?'s':'')+' already exist or are duplicates','warning');
        else toast('Enter at least one brand name','warning');
        return;
    }

    try{
        const res = await fetch('/api/procurement/brands/bulk',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({brands: toCreate})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message || 'Bulk add failed');

        const added   = Array.isArray(data.added)   ? data.added   : [];
        const srvSkip = Array.isArray(data.skipped) ? data.skipped : [];

        if(added.length){
            toast(added.length+' brand'+(added.length!==1?'s':'')+' added','success');
        }
        const totalSkipped = skippedDup.length + srvSkip.length;
        if(totalSkipped){
            const sample = [...skippedDup, ...srvSkip.map(s=>s.name||s)].slice(0,3).join(', ');
            const more   = totalSkipped > 3 ? ' +'+(totalSkipped-3)+' more' : '';
            toast('Skipped '+totalSkipped+' duplicate'+(totalSkipped!==1?'s':'')+': '+sample+more,'warning',4500);
        }
        if(skippedBadColor.length){
            toast(skippedBadColor.length+' line'+(skippedBadColor.length!==1?'s':'')+' had invalid colour codes — used defaults','warning',3500);
        }

        // Clear textarea on full success; otherwise keep failed lines in place
        if(!totalSkipped) ta.value = '';
        else {
            const failedSet = new Set([...skippedDup.map(s=>s.toLowerCase()), ...srvSkip.map(s=>(s.name||s||'').toLowerCase())]);
            ta.value = raw
                .map(l => l.trim())
                .filter(l => l && failedSet.has(l.split('|')[0].trim().toLowerCase()))
                .join('\n');
        }

        await loadBrands();
        fvqRenderTable();
    }catch(e){
        toast('Error: '+(e.message||e),'error');
    }
}

/* Import brands from an .xlsx file. Reads names from column A on the first
   sheet; backend assigns a random pleasant colour per brand and auto-picks a
   contrasting text colour for readability. */
async function importBrandsExcel(){
    let inp = document.getElementById('_brandImportFileInput');
    if(!inp){
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id   = '_brandImportFileInput';
        inp.accept = '.xlsx';
        inp.style.display = 'none';
        document.body.appendChild(inp);
    }
    inp.value = '';   // allow re-picking the same file

    const onPick = async () => {
        inp.removeEventListener('change', onPick);
        const file = inp.files && inp.files[0];
        if(!file) return;
        if(!file.name.toLowerCase().endsWith('.xlsx')){
            toast('Only .xlsx files accepted','error');
            return;
        }

        const btn = document.getElementById('brandImportXlsxBtn');
        const origLabel = btn ? btn.innerHTML : '';
        if(btn){ btn.disabled = true; btn.innerHTML = 'Importing…'; }

        try{
            const fd = new FormData();
            fd.append('file', file);
            const res  = await fetch('/api/procurement/brands/import_excel',{method:'POST',body:fd});
            const data = await res.json();
            if(data.status!=='ok') throw new Error(data.message || 'Import failed');

            const added   = Array.isArray(data.added)   ? data.added   : [];
            const skipped = Array.isArray(data.skipped) ? data.skipped : [];

            if(added.length){
                toast(added.length+' brand'+(added.length!==1?'s':'')+' imported from Excel','success');
            } else {
                toast('No new brands imported','warning');
            }
            if(skipped.length){
                const sample = skipped.slice(0,3).map(s=>s.name||s).join(', ');
                const more   = skipped.length > 3 ? ' +'+(skipped.length-3)+' more' : '';
                toast('Skipped '+skipped.length+' duplicate'+(skipped.length!==1?'s':'')+': '+sample+more,'warning',4500);
            }

            await loadBrands();
            fvqRenderTable();
        }catch(e){
            toast('Error: '+(e.message||e),'error');
        }finally{
            if(btn){ btn.disabled = false; btn.innerHTML = origLabel; }
        }
    };

    inp.addEventListener('change', onPick);
    inp.click();
}

async function editBrand(id, oldName, oldColor, oldTextColor){
    oldTextColor = oldTextColor || '#ffffff';
    const rowId='brandEditRow_'+id;
    if(document.getElementById(rowId)){_renderBrandList();return;}
    // The card is the div that has the edit-button as a DIRECT child
    // (the grid wrapper contains it only as a deeper descendant).
    const root = document.getElementById('brandMgrList');
    if(!root) return;
    const candidates = root.querySelectorAll('div');
    let row = null;
    for(const el of candidates){
        const direct = el.querySelector(':scope > button[onclick*="editBrand('+id+',"]');
        if(direct){ row = el; break; }
    }
    if(!row) return;

    row.id=rowId;
    const ni='brandEditName_'+id, ci='brandEditColor_'+id, di='brandEditDot_'+id, ti='brandEditTextColor_'+id;
    row.style.flexWrap = 'wrap';
    row.innerHTML=
        '<div id="'+di+'" style="width:16px;height:16px;border-radius:50%;flex-shrink:0;background:'+oldColor+';box-shadow:0 0 0 3px '+oldColor+'33"></div>'
        +'<input id="'+ni+'" type="text" value="'+escHtml(oldName)+'" maxlength="200" '
            +'style="flex:1;min-width:120px;height:32px;padding:0 9px;border-radius:5px;border:1px solid var(--teal-dim);background:var(--surface);color:var(--text);font-size:12px;outline:none">'
        +'<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0">'
        +'<input id="'+ci+'" type="color" value="'+oldColor+'" title="Background colour" '
            +'style="width:34px;height:26px;border:1px solid var(--border2);border-radius:5px;padding:2px;background:var(--surface);cursor:pointer">'
        +'<span style="font-size:9px;color:var(--muted);line-height:1">BG</span></div>'
        +'<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0">'
        +'<input id="'+ti+'" type="color" value="'+oldTextColor+'" title="Text colour" '
            +'style="width:34px;height:26px;border:1px solid var(--border2);border-radius:5px;padding:2px;background:var(--surface);cursor:pointer">'
        +'<span style="font-size:9px;color:var(--muted);line-height:1">Text</span></div>'
        +'<button onclick="_saveBrandEdit('+id+')" class="btn-save" style="height:28px;padding:0 12px;font-size:11px">Save</button>'
        +'<button onclick="_renderBrandList()" class="btn-ghost" style="height:28px;padding:0 10px;font-size:11px">Cancel</button>';
    // Wire events after insertion
    const nameEl=document.getElementById(ni);
    const colorEl=document.getElementById(ci);
    const dotEl=document.getElementById(di);
    if(nameEl){
        nameEl.addEventListener('keydown',e=>{
            if(e.key==='Enter'){e.preventDefault();_saveBrandEdit(id);}
            if(e.key==='Escape')_renderBrandList();
        });
        setTimeout(()=>nameEl.select(),30);
    }
    if(colorEl&&dotEl){
        colorEl.addEventListener('input',()=>{
            dotEl.style.background=colorEl.value;
            dotEl.style.boxShadow='0 0 0 3px '+colorEl.value+'33';
        });
    }
}
async function _saveBrandEdit(id){
    const name=(document.getElementById('brandEditName_'+id)?.value||'').trim();
    const color=document.getElementById('brandEditColor_'+id)?.value||'#6366f1';
    const text_color=document.getElementById('brandEditTextColor_'+id)?.value||'#ffffff';
    if(!name){toast('Brand name required','warning');document.getElementById('brandEditName_'+id)?.focus();return;}
    try{
        const res=await fetch('/api/procurement/brands/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,color,text_color})});
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        toast('Brand updated','success',2000);
        await loadBrands();fvqRenderTable();
    }catch(e){toast('Error: '+e.message,'error');}
}

async function deleteBrand(id, name){
    if(!confirm('Delete brand "'+name+'"? Formulations will be unbranded.')) return;
    try{
        const res=await fetch('/api/procurement/brands/'+id,{method:'DELETE'});
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast('Brand deleted','success');
        await loadBrands();
        await loadFvqData();
    }catch(e){toast('Error: '+e.message,'error');}
}

async function assignBrandToSelected(){
    const checked = _fvqSelectedBatches.size > 0
        ? [..._fvqSelectedBatches]
        : [...document.querySelectorAll('.fvq-row-cb:checked')].map(c=>c.dataset.batch);
    if(!checked.length){toast('Select at least one formulation','warning');return;}
    const sel=document.getElementById('fvqBulkBrandSel');
    const brand_id=sel&&sel.value?parseInt(sel.value):null;
    try{
        const res=await fetch('/api/procurement/formulations/set_brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_names:checked,brand_id})});
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const bname=_fvqBrands.find(b=>b.id===brand_id)?.name||'(unbranded)';
        toast('Brand "'+bname+'" assigned to '+checked.length+' formulation'+(checked.length!==1?'s':''),'success');
        // Update in-memory, preserve page & selection
        checked.forEach(batchName=>{
            const m=(_fvqBatches||[]).find(b=>b.batch_name===batchName);
            if(m) m.brand_id=brand_id;
        });
        fvqRenderTable();
    }catch(e){toast('Error: '+e.message,'error');}
}

async function assignBrandFromDetail(sel){
    const batchName=_fvqDetailBatch;
    if(!batchName) return;
    const brand_id=sel.value?parseInt(sel.value):null;
    try{
        const res=await fetch('/api/procurement/formulations/set_brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_names:[batchName],brand_id})});
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const m=(_fvqBatches||[]).find(b=>b.batch_name===batchName);
        if(m) m.brand_id=brand_id;
        fvqRenderTable();
        toast('Brand assigned','success');
    }catch(e){toast('Error: '+e.message,'error');}
}

/* ════════════════════════════════════════════════════════
   BRAND REPORT
════════════════════════════════════════════════════════ */
// _brandReportData declared at top

async function openBrandReport(){
    document.getElementById('brandReportModal').classList.add('open');
    document.getElementById('brandReportBody').innerHTML='<div style="padding:24px;text-align:center"><div class="spinner"></div></div>';
    try{
        const res=await fetch('/api/procurement/brands/report');
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _brandReportData=data.report||[];
        _brActiveBrandId=null;
        _renderBrandReport();
    }catch(e){
        document.getElementById('brandReportBody').innerHTML='<div style="padding:20px;color:var(--red-text)">Error: '+escHtml(e.message)+'</div>';
    }
}
function closeBrandReport(){document.getElementById('brandReportModal').classList.remove('open');}
document.getElementById('brandReportModal')?.addEventListener('click',e=>{
    if(e.target===document.getElementById('brandReportModal')) closeBrandReport();
});

function _renderBrandReport(){
    const body=document.getElementById('brandReportBody');
    if(!body) return;
    if(!_brandReportData.length){
        body.innerHTML='<div style="padding:24px;text-align:center;color:var(--muted)">No brands yet — create some first</div>';
        return;
    }
    body.style.cssText='display:flex;height:100%;overflow:hidden';
    body.innerHTML=
        '<div style="width:240px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;height:100%;overflow:hidden">'
          +'<div style="padding:8px 10px;border-bottom:1px solid var(--border);flex-shrink:0">'
            +'<input id="brBrandSearch" class="form-input" placeholder="Search brands…" style="width:100%;height:28px;font-size:11px" oninput="_brFilterBrands(this.value)">'
          +'</div>'
          +'<div id="brBrandList" style="flex:1;overflow-y:auto;height:0"></div>'
        +'</div>'
        +'<div id="brandReportDetail" style="flex:1;display:flex;flex-direction:column;height:100%;overflow:hidden">'
          +'<div style="color:var(--muted);text-align:center;margin-top:60px;font-size:12px">← Click a brand to see its formulations</div>'
        +'</div>';
    _brRenderBrandList('');
}

// _brActiveBrandId declared at top

function _brRenderBrandList(query){
    const el=document.getElementById('brBrandList');
    if(!el) return;
    const q=(query||'').toLowerCase();
    const filtered=_brandReportData.filter(b=>!q||b.name.toLowerCase().includes(q));
    if(!filtered.length){
        el.innerHTML='<div style="padding:16px;font-size:11px;color:var(--muted);text-align:center">No brands match</div>';
        return;
    }
    el.innerHTML=filtered.map(b=>{
        const active=_brActiveBrandId===b.id;
        const c=b.color||'#94a3b8';
        return '<div id="brItem_'+b.id+'" onclick="_renderBrandReportDetail('+JSON.stringify(b.id)+')"'
            +' style="padding:11px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);transition:background .1s;background:'+(active?'var(--teal-glow)':'transparent')+';border-left:3px solid '+(active?'var(--teal)':'transparent')+'"'
            +' onmouseover="this.style.background=\"var(--text-05)\"" onmouseout="this.style.background=\"'+(active?'var(--teal-glow)':'')+'\"">';
            +'<div style="width:10px;height:10px;border-radius:50%;background:'+c+';flex-shrink:0"></div>'
            +'<div style="flex:1;min-width:0;overflow:hidden">'
            +'<div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escHtml(b.name)+'</div>'
            +'<div style="font-size:10px;color:var(--muted)">'+b.batches.length+' formulation'+(b.batches.length!==1?'s':'')+'</div>'
            +'</div></div>';
    }).join('');
}

function _brFilterBrands(q){ _brRenderBrandList(q); }

function _renderBrandReportDetail(brandId){
    _brActiveBrandId = brandId;
    // Update active styles in-place — no full re-render
    document.querySelectorAll('#brBrandList > div').forEach(el=>{
        const active = el.id==='brItem_'+brandId;
        el.style.background = active ? 'var(--teal-glow)' : '';
        el.style.borderLeftColor = active ? 'var(--teal)' : 'transparent';
    });

    const panel = document.getElementById('brandReportDetail');
    const brand = _brandReportData.find(b=>b.id===brandId);
    if(!panel||!brand) return;

    const c = brand.color||'#94a3b8';
    let html = '<div style="padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;gap:10px;background:var(--text-05)">'
        +'<div style="width:12px;height:12px;border-radius:50%;background:'+c+';flex-shrink:0"></div>'
        +'<div style="flex:1">'
        +'<div style="font-size:13px;font-weight:700;color:var(--text)">'+escHtml(brand.name)+'</div>'
        +'<div style="font-size:10px;color:var(--muted)">'+brand.batches.length+' formulation'+(brand.batches.length!==1?'s':'')+'</div>'
        +'</div>'
        +'<input id="brFormSearch" class="form-input" placeholder="Search formulations…" style="width:180px;height:28px;font-size:11px"'
        +' oninput="_brFilterFormulations(this.value,'+JSON.stringify(brandId)+')">'
        +'</div>';

    if(!brand.batches.length){
        html += '<div style="color:var(--muted);text-align:center;margin-top:40px;font-size:12px">No formulations in this brand</div>';
        panel.innerHTML = html;
        return;
    }

    html += '<div id="brFormList" style="flex:1;overflow-y:auto;padding:10px 14px">' + _brFormListHtml(brand.batches,'') + '</div>';
    panel.innerHTML = html;
}

function _brFormListHtml(batches, query){
    const q=(query||'').toLowerCase();
    const filtered=batches.filter(bn=>!q||bn.toLowerCase().includes(q));
    if(!filtered.length) return '<div style="padding:12px;font-size:11px;color:var(--muted);text-align:center">No formulations match</div>';
    return filtered.map(bn=>{
        const nm=escHtml(bn);
        const safeJs=bn.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return '<div'
            +' onclick="closeBrandReport();setTimeout(()=>openFvqDetail(\''+safeJs+'\'),120)"'
            +' onmouseover="this.style.background=\'var(--teal-glow)\'"'
            +' onmouseout="this.style.background=\'\'"'
            +' style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:5px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text);transition:background .12s;display:flex;align-items:center;gap:8px">'
            +'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="2.5"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/></svg>'
            +nm+'</div>';
    }).join('');
}

function _brFilterFormulations(query, brandId){
    const brand=_brandReportData.find(b=>b.id===brandId);
    const el=document.getElementById('brFormList');
    if(!brand||!el) return;
    el.innerHTML=_brFormListHtml(brand.batches, query);
}


/* ════════════════════════════════════════════════════════
   MANUAL FORMULATION CREATOR
   Two modes:
     • create : build a new formulation from scratch
          ↳ input-mode toggle : % Concentration | Qty by Batch Size
     • link   : copy ingredients from an existing formulation
          ↳ uses /api/procurement/formulations/link_batch
   State flags declared at top of file: _manualMode, _manualInputMode
════════════════════════════════════════════════════════ */

async function openManualFormCreator(){
    // If formulations haven't been loaded yet (user opened modal from a non-Formulations tab),
    // fetch them now so Copy from / Link to Existing have something to populate from.
    if((!_fvqBatches || _fvqBatches.length===0) && typeof loadFvqData==='function'){
        try { await loadFvqData(); } catch(e){}
    }
    _manualIngredients=[];
    _manualMode='create';
    _manualInputMode='pct';
    ['manualFormName','manualFormCode','manualFormSize',
     'manualLinkNewName','manualLinkBatchSize'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.value='';
    });
    const brandOpts='<option value="">— No Brand —</option>'
        +_fvqBrands.map(b=>'<option value="'+b.id+'">'+escHtml(b.name)+'</option>').join('');
    const mb=document.getElementById('manualFormBrand');   if(mb) { mb.innerHTML=brandOpts; if(typeof comboboxRefresh==='function') comboboxRefresh(mb); }
    const lb=document.getElementById('manualLinkBrand');   if(lb) { lb.innerHTML=brandOpts; if(typeof comboboxRefresh==='function') comboboxRefresh(lb); }

    // Populate source-formulation dropdown with existing batches
    const src=document.getElementById('manualLinkSource');
    if(src){
        const names=[..._fvqBatches].map(b=>b.batch_name)
            .sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base'}));
        src.innerHTML='<option value="">— Select existing formulation —</option>'
            +names.map(n=>'<option value="'+escHtml(n)+'">'+escHtml(n)+'</option>').join('');
        src.onchange=_manualLinkPreview;
        if(typeof comboboxRefresh==='function') comboboxRefresh(src);
    }

    // Populate copy-source dropdown with existing batches
    const cpy=document.getElementById('manualCopySource');
    if(cpy){
        const names=[..._fvqBatches].map(b=>b.batch_name)
            .sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base'}));
        cpy.innerHTML='<option value="">— Select formulation to copy —</option>'
            +names.map(n=>'<option value="'+escHtml(n)+'">'+escHtml(n)+'</option>').join('');
        cpy.value='';
        cpy.onchange=_manualCopyFromSource;
        if(typeof comboboxRefresh==='function') comboboxRefresh(cpy);
    }
    const preview=document.getElementById('manualLinkPreview');
    if(preview) preview.style.display='none';

    _manualSetMode('create');
    _manualSetInputMode('pct');
    _renderManualIngRows();
    document.getElementById('manualFormModal').classList.add('open');
}
function closeManualFormCreator(){document.getElementById('manualFormModal').classList.remove('open');}
document.getElementById('manualFormModal')?.addEventListener('click',e=>{
    if(e.target===document.getElementById('manualFormModal')) closeManualFormCreator();
});

/* Switch between "Create New", "Copy from" and "Link to Existing" panes */
function _manualSetMode(mode){
    _manualMode=mode;
    const isCreate = mode==='create';
    const isCopy   = mode==='copy';
    const isLink   = mode==='link';
    // Create-like layout (meta fields + input toggle + ingredient table) is shown for both Create and Copy
    const showCreateLike = isCreate || isCopy;
    const btnC=document.getElementById('manualModeCreate');
    const btnP=document.getElementById('manualModeCopy');
    const btnL=document.getElementById('manualModeLink');
    if(btnC){
        btnC.style.background = isCreate?'var(--teal)':'transparent';
        btnC.style.color      = isCreate?'#fff':'var(--muted)';
    }
    if(btnP){
        btnP.style.background = isCopy?'rgba(245,158,11,.95)':'transparent';
        btnP.style.color      = isCopy?'#fff':'var(--muted)';
    }
    if(btnL){
        btnL.style.background = isLink?'rgba(139,92,246,.85)':'transparent';
        btnL.style.color      = isLink?'#fff':'var(--muted)';
    }
    // Toggle the panes
    const metaCreate = document.getElementById('manualMetaCreate');
    const inpModeBar = document.getElementById('manualInputModeBar');
    const ingWrap    = document.getElementById('manualIngWrap');
    const linkPane   = document.getElementById('manualLinkPane');
    const copyBar    = document.getElementById('manualCopyBar');
    const footLeft   = document.getElementById('manualFootLeft');
    const hint       = document.getElementById('manualModeHint');
    const sub        = document.getElementById('manualFormSub');
    const saveBtn    = document.getElementById('manualSaveBtn');

    if(metaCreate) metaCreate.style.display = showCreateLike?'grid':'none';
    if(inpModeBar) inpModeBar.style.display = showCreateLike?'flex':'none';
    if(ingWrap)    ingWrap.style.display    = showCreateLike?'block':'none';
    if(copyBar)    copyBar.style.display    = isCopy?'block':'none';
    if(linkPane)   linkPane.style.display   = isLink?'block':'none';
    if(footLeft)   footLeft.style.display   = showCreateLike?'flex':'none';
    if(hint){
        if(isCreate){
            hint.textContent='Build a new formulation from scratch by entering ingredients below.';
            hint.style.color='var(--muted)';
        } else if(isCopy){
            hint.textContent='Pick a source formulation — its details fill in below for editing. The new formulation will be independent of the source.';
            hint.style.color='#b45309';
        } else {
            hint.textContent='Pick an existing formulation — ingredients will be shared. Changes to the source propagate here.';
            hint.style.color='#a78bfa';
        }
    }
    if(sub){
        if(isCreate){
            sub.textContent='Manually add ingredients and set concentrations';
        } else if(isCopy){
            sub.textContent='Copy an existing formulation, then edit before saving';
        } else {
            sub.textContent='Link a new name to an existing formulation — shared ingredients';
        }
    }
    if(saveBtn){
        if(isLink) saveBtn.textContent='🔗 Create Link';
        else if(isCopy) saveBtn.textContent='✓ Save Copy';
        else saveBtn.textContent='✓ Save Formulation';
    }
}

/* Copy mode: when a source is picked, fill all meta + ingredient rows from it.
   The new formulation is saved as an independent batch via the regular
   create_manual endpoint — there is no link back to the source. */
function _manualCopyFromSource(){
    const sel=document.getElementById('manualCopySource');
    if(!sel) return;
    const name=sel.value;
    if(!name){
        _manualIngredients=[];
        _renderManualIngRows();
        return;
    }
    const meta=_fvqBatches.find(b=>b.batch_name===name)||{};
    // Pre-fill the form name with " (Copy)" suffix to avoid an immediate duplicate-name save
    const nameInput=document.getElementById('manualFormName');
    if(nameInput) nameInput.value = name + ' (Copy)';
    const codeInput=document.getElementById('manualFormCode');
    if(codeInput) codeInput.value = meta.product_code || '';
    const sizeInput=document.getElementById('manualFormSize');
    if(sizeInput) sizeInput.value = meta.batch_size || '';
    const brandSel=document.getElementById('manualFormBrand');
    if(brandSel) { brandSel.value = meta.brand_id ? String(meta.brand_id) : ''; if(typeof comboboxSyncDisplay==='function') comboboxSyncDisplay(brandSel); }

    // Fill ingredient rows from _fvqDetail
    const rows=_fvqDetail.filter(r=>r.batch_name===name);
    _manualIngredients = rows.map(r=>({
        material_name: r.material_name || '',
        supplier_name: r.supplier_name || '',
        concentration: r.concentration!=null ? String(r.concentration) : '',
        qty_kg       : r.qty_kg!=null ? String(r.qty_kg) : ''
    }));
    if(!_manualIngredients.length){
        _manualIngredients.push({material_name:'',supplier_name:'',concentration:'',qty_kg:''});
    }
    _renderManualIngRows();
    if(typeof toast==='function'){
        toast('Copied '+rows.length+' ingredient'+(rows.length===1?'':'s')+' from "'+name+'" — edit & save','success',4500);
    }
}

/* Switch % Concentration ↔ Qty-by-Batch-Size entry */
function _manualSetInputMode(m){
    _manualInputMode = (m==='qty') ? 'qty' : 'pct';
    const isPct = _manualInputMode==='pct';
    const btnP=document.getElementById('manualInpModePct');
    const btnQ=document.getElementById('manualInpModeQty');
    if(btnP){
        btnP.style.background =  isPct?'var(--teal)':'transparent';
        btnP.style.color      =  isPct?'#fff':'var(--muted)';
    }
    if(btnQ){
        btnQ.style.background = !isPct?'var(--teal)':'transparent';
        btnQ.style.color      = !isPct?'#fff':'var(--muted)';
    }
    const hint=document.getElementById('manualInpModeHint');
    if(hint){
        hint.textContent = isPct
            ? 'Enter concentration % directly for each ingredient.'
            : 'Enter the quantity used per batch — % will be auto-calculated from Batch Size.';
    }
    const thQty = document.getElementById('manualThQty');
    const thPct = document.getElementById('manualThPct');
    if(thQty) thQty.style.display = isPct?'none':'table-cell';
    if(thPct) thPct.style.display = isPct?'table-cell':'none';

    // Toggle Batch-Size required/optional markers
    const req=document.getElementById('manualBatchSizeReq');
    const opt=document.getElementById('manualBatchSizeOpt');
    if(req) req.style.display = isPct?'none':'inline';
    if(opt) opt.style.display = isPct?'inline':'none';

    _renderManualIngRows();
    _manualUpdateTotals();
}

/* Parse first numeric value out of a batch-size string like "500 KG" → 500 */
function _manualParseBatchSize(){
    const raw=(document.getElementById('manualFormSize')?.value||'').trim();
    if(!raw) return {num:0, unit:''};
    const m=raw.match(/([0-9]*\.?[0-9]+)/);
    const num=m?parseFloat(m[1]):0;
    const unit=raw.replace(/[0-9.\s]+/g,'').trim().toUpperCase(); // "KG" / "ML" etc
    return {num:isNaN(num)?0:num, unit:unit||''};
}

/* Compute & render totals footer */
function _manualUpdateTotals(){
    const tfoot=document.getElementById('manualIngTfoot');
    if(!tfoot) return;
    const rows=_manualIngredients.filter(i=>(i.material_name||'').trim());
    if(!rows.length){ tfoot.style.display='none'; return; }
    tfoot.style.display='';
    const isPct=_manualInputMode==='pct';
    const {num:bsNum,unit}=_manualParseBatchSize();
    let sumPct=0, sumQty=0;
    rows.forEach(r=>{
        if(isPct){
            const p=parseFloat(r.concentration); if(!isNaN(p)) sumPct+=p;
        }else{
            const q=parseFloat(r.qty_kg); if(!isNaN(q)) sumQty+=q;
            if(bsNum>0 && !isNaN(q)) sumPct += (q/bsNum*100);
        }
    });
    const pctEl=document.getElementById('manualTotPct');
    const qtyEl=document.getElementById('manualTotQty');
    if(pctEl){
        const display=sumPct>0?sumPct.toFixed(2)+' %':'—';
        pctEl.textContent=display;
        pctEl.style.color = (Math.abs(sumPct-100)<0.5 || sumPct===0) ? 'var(--teal)' : 'var(--amber-text)';
    }
    if(qtyEl){
        qtyEl.textContent = isPct ? '' : (sumQty>0?sumQty.toFixed(3)+(unit?' '+unit:''):'—');
    }
}

function _renderManualIngRows(){
    const tbody=document.getElementById('manualIngTbody');
    if(!tbody) return;
    const isPct=_manualInputMode==='pct';
    const colspan = isPct ? 5 : 6;
    if(!_manualIngredients.length){
        tbody.innerHTML='<tr><td colspan="'+colspan+'" style="padding:20px;text-align:center;color:var(--muted);font-size:12px">No ingredients yet — click <strong>+ Add Row</strong></td></tr>';
        _manualUpdateTotals();
        return;
    }
    const {num:bsNum, unit}=_manualParseBatchSize();
    const thQtyUnit=document.getElementById('manualThQtyUnit');
    if(thQtyUnit) thQtyUnit.textContent = unit?('('+unit+')'):'';

    tbody.innerHTML=_manualIngredients.map((ing,i)=>{
        // live % preview when in qty mode
        let livePct='';
        if(!isPct && bsNum>0){
            const q=parseFloat(ing.qty_kg);
            if(!isNaN(q) && q>0) livePct = (q/bsNum*100).toFixed(2)+' %';
        }
        const qtyCell = '<td style="padding:4px 6px;width:130px">'
            +'<div style="display:flex;flex-direction:column;gap:1px">'
            +'<input value="'+escHtml(ing.qty_kg||'')
                +'" oninput="_manualIngredients['+i+'].qty_kg=this.value;_manualRowRecalc('+i+')"'
                +' class="form-input" placeholder="Qty'+(unit?' '+unit:'')+'" '
                +'style="width:100%;height:30px;font-size:12px;color:var(--teal);text-align:right;font-family:var(--font-mono)">'
            +(livePct?'<div style="font-size:9px;color:var(--muted);text-align:right;font-family:var(--font-mono);padding-right:4px">= '+livePct+'</div>':'')
            +'</div></td>';
        const pctCell = '<td style="padding:4px 6px;width:110px"><input value="'+escHtml(ing.concentration||'')
            +'" oninput="_manualIngredients['+i+'].concentration=this.value;_manualUpdateTotals()"'
            +' class="form-input" placeholder="% w/w" '
            +'style="width:100%;height:30px;font-size:12px;color:var(--teal);text-align:right;font-family:var(--font-mono)"></td>';
        return '<tr style="border-bottom:1px solid var(--border)">'
            +'<td style="padding:6px 8px;color:var(--muted);font-size:11px;text-align:center;width:36px">'+(i+1)+'</td>'
            +'<td style="padding:4px 6px"><input value="'+escHtml(ing.material_name||'')+'" oninput="_manualIngredients['+i+'].material_name=this.value;_manualUpdateTotals()" class="form-input" placeholder="Material name…" style="width:100%;height:30px;font-size:12px"></td>'
            +'<td style="padding:4px 6px"><input value="'+escHtml(ing.supplier_name||'')+'" oninput="_manualIngredients['+i+'].supplier_name=this.value" class="form-input" placeholder="Supplier…" style="width:100%;height:30px;font-size:12px"></td>'
            +(isPct ? pctCell : qtyCell)
            +'<td style="padding:4px 8px;text-align:center;width:44px"><button onclick="_manualIngredients.splice('+i+',1);_renderManualIngRows()" class="modal-x" style="font-size:11px;width:26px;height:26px">✕</button></td>'
            +'</tr>';
    }).join('');
    _manualUpdateTotals();
}

/* Called on every keystroke of a Qty input — rerender just that row's live % and totals */
function _manualRowRecalc(i){
    const isPct=_manualInputMode==='pct';
    if(isPct){ _manualUpdateTotals(); return; }
    const {num:bsNum}=_manualParseBatchSize();
    const ing=_manualIngredients[i];
    if(!ing){ _manualUpdateTotals(); return; }
    // update the tiny "= X %" hint under the qty input without full rerender (preserves focus)
    const rows=document.querySelectorAll('#manualIngTbody tr');
    const row=rows[i];
    if(row){
        const qtyTd=row.children[3]; // # | Ingredient | Supplier | Qty
        if(qtyTd){
            let hint=qtyTd.querySelector('div>div');
            const q=parseFloat(ing.qty_kg||'');
            const livePct=(bsNum>0 && !isNaN(q) && q>0) ? (q/bsNum*100).toFixed(2)+' %' : '';
            if(livePct){
                if(!hint){
                    hint=document.createElement('div');
                    hint.style.cssText='font-size:9px;color:var(--muted);text-align:right;font-family:var(--font-mono);padding-right:4px';
                    qtyTd.firstElementChild.appendChild(hint);
                }
                hint.textContent='= '+livePct;
            } else if(hint){
                hint.remove();
            }
        }
    }
    _manualUpdateTotals();
}

function manualAddRow(){
    _manualIngredients.push({material_name:'',supplier_name:'',concentration:'',qty_kg:''});
    _renderManualIngRows();
    const inputs=document.querySelectorAll('#manualIngTbody input');
    // focus the first input of the newly-added last row (material name column)
    // row has: material, supplier, (pct OR qty)  →  3 inputs per row
    const perRow=3;
    if(inputs.length>=perRow) inputs[inputs.length-perRow]?.focus();
}

/* Also recompute totals when batch-size field is edited */
document.addEventListener('input',function(e){
    if(e.target && e.target.id==='manualFormSize'){
        _renderManualIngRows();
    }
});

/* Show a tiny ingredient preview when a source is picked in Link mode */
function _manualLinkPreview(){
    const src=document.getElementById('manualLinkSource');
    const preview=document.getElementById('manualLinkPreview');
    const body=document.getElementById('manualLinkPreviewBody');
    if(!src||!preview||!body) return;
    const name=src.value;
    if(!name){ preview.style.display='none'; return; }
    const rows=_fvqDetail.filter(r=>r.batch_name===name);
    if(!rows.length){ preview.style.display='none'; return; }
    preview.style.display='';
    const meta=_fvqBatches.find(b=>b.batch_name===name)||{};
    body.innerHTML =
        '<div style="font-weight:700;color:var(--teal);margin-bottom:6px">'+escHtml(name)
        +(meta.product_code?' <span style="font-weight:400;color:var(--muted);font-size:10.5px">('+escHtml(meta.product_code)+')</span>':'')
        +(meta.batch_size?' <span style="font-weight:400;color:var(--muted);font-size:10.5px">· '+escHtml(meta.batch_size)+'</span>':'')
        +'</div>'
        +'<div style="font-size:10.5px;color:var(--muted);margin-bottom:4px">'+rows.length+' ingredient'+(rows.length===1?'':'s')+':</div>'
        +'<ol style="margin:0;padding-left:20px;line-height:1.7">'
        +rows.slice(0,12).map(r=>
            '<li>'+escHtml(r.material_name||'')
            +(r.concentration?' <span style="color:var(--teal);font-family:var(--font-mono);font-size:10.5px">'+escHtml(r.concentration)+'</span>':'')
            +(r.supplier_name?' <span style="color:var(--muted);font-size:10.5px">· '+escHtml(r.supplier_name)+'</span>':'')
            +'</li>'
        ).join('')
        +(rows.length>12?'<li style="color:var(--muted);font-style:italic">… and '+(rows.length-12)+' more</li>':'')
        +'</ol>';
}

async function saveManualFormulation(){
    if(_manualMode==='link'){
        return _saveManualLink();
    }
    const batch_name=(document.getElementById('manualFormName').value||'').trim();
    const product_code=(document.getElementById('manualFormCode').value||'').trim();
    const batch_size=(document.getElementById('manualFormSize').value||'').trim();
    const brand_sel=document.getElementById('manualFormBrand');
    const brand_id=brand_sel&&brand_sel.value?parseInt(brand_sel.value):null;

    if(!batch_name){toast('Enter formulation name','warning');return;}
    const validIngs=_manualIngredients.filter(i=>(i.material_name||'').trim());
    if(!validIngs.length){toast('Add at least one ingredient','warning');return;}

    // If user is in Qty mode, compute concentration % from qty / batch_size
    let payloadIngs=validIngs;
    if(_manualInputMode==='qty'){
        const {num:bsNum}=_manualParseBatchSize();
        if(!bsNum || bsNum<=0){
            toast('Enter a valid Batch Size (e.g. 500 KG) to use Qty mode','warning',5000);
            return;
        }
        payloadIngs=validIngs.map(ing=>{
            const q=parseFloat(ing.qty_kg);
            const pct=(!isNaN(q) && q>=0) ? (q/bsNum*100) : null;
            return {
                material_name : ing.material_name,
                supplier_name : ing.supplier_name||'',
                concentration : pct!==null ? _trimFloat(pct,4) : '',
                qty_kg        : !isNaN(q) ? String(q) : ''
            };
        });
    }

    try{
        const res=await fetch('/api/procurement/formulations/create_manual',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({batch_name,product_code,batch_size,brand_id,ingredients:payloadIngs})
        });
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast('Formulation "'+batch_name+'" created with '+payloadIngs.length+' ingredients','success',4000);
        closeManualFormCreator();
        await loadFvqData();
    }catch(e){toast('Error: '+e.message,'error',6000);}
}

/* Trim trailing zeros from a decimal string (up to `decimals` places) */
function _trimFloat(n, decimals){
    if(!isFinite(n)) return '';
    return parseFloat(n.toFixed(decimals)).toString();
}

async function _saveManualLink(){
    const new_name=(document.getElementById('manualLinkNewName').value||'').trim();
    const source_name=(document.getElementById('manualLinkSource').value||'').trim();
    const batch_size=(document.getElementById('manualLinkBatchSize').value||'').trim();
    const brand_sel=document.getElementById('manualLinkBrand');
    const brand_id=brand_sel&&brand_sel.value?parseInt(brand_sel.value):null;

    if(!new_name){toast('Enter new formulation name','warning');return;}
    if(!source_name){toast('Select a source formulation to link to','warning');return;}
    if(new_name===source_name){toast('New name must differ from source','warning');return;}

    // Guard against overwriting an existing batch silently
    const clash=_fvqBatches.some(b=>b.batch_name===new_name);
    if(clash){
        const ok=confirm('A formulation named "'+new_name+'" already exists.\n\nContinuing will REPLACE it with a link to "'+source_name+'" (original ingredients will be deleted).\n\nContinue?');
        if(!ok) return;
    }

    try{
        const res=await fetch('/api/procurement/formulations/link_batch',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                new_batch_name:new_name,
                source_batch_name:source_name,
                batch_size:batch_size
            })
        });
        const data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);

        // If brand was chosen, assign it (link_batch does not accept brand_id directly)
        if(brand_id){
            try{
                await fetch('/api/procurement/formulations/set_brand',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({batch_names:[new_name],brand_id})
                });
            }catch(_){ /* non-fatal */ }
        }
        toast('Linked "'+new_name+'" → "'+source_name+'" ('+data.linked+' ingredients shared)','success',4500);
        closeManualFormCreator();
        await loadFvqData();
    }catch(e){toast('Error: '+e.message,'error',6000);}
}

/* ═══════════════════════════════════════════════════════
   AUTO-FORMAT MANUFACTURING PROCESS
   Converts any existing manuf_process HTML (from messy import,
   Excel paste, Word paste, contenteditable edits) into the
   CANONICAL CLEAN STRUCTURE — identical to what the backend
   /api/procurement/formulations/import_manuf_process produces.

   Canonical structure:
     <table class="mp-spec">  — spec block (PRODUCT SPECIFICATION)
     <table class="mp-steps"> — process block (numbered steps)
   Subheadings within step cells are detected and wrapped in <strong>.
═══════════════════════════════════════════════════════ */

/** Convert any DOM table into a 2D array of trimmed cell text. */
function _mpTableRows(tableEl){
    return [...tableEl.querySelectorAll('tr')].map(tr=>{
        const cells=[...tr.children].filter(c=>c.tagName==='TD'||c.tagName==='TH');
        return cells.map(c=>(c.innerText||c.textContent||'').trim());
    });
}

/** Strip empty leading columns from a 2D row array (mutates in place). */
function _mpStripLeftEmptyCols(rows){
    while(true){
        let any=false;
        for(const r of rows){ if(r && r.length && (r[0]||'').trim()){ any=true; break; } }
        if(any) break;
        let didStrip=false;
        for(const r of rows){ if(r && r.length){ r.shift(); didStrip=true; } }
        if(!didStrip) break;
    }
    return rows;
}

/** Does the row (a joined text) look like a spec-section header? */
function _mpIsSpecHeaderRow(rowText){
    const t=(rowText||'').toLowerCase();
    return t.includes('product specification');
}

/** Does the row look like a process-section header? */
function _mpIsProcHeaderRow(rowText){
    const t=(rowText||'').toLowerCase();
    return t.includes('manufacturing process') || /^mfg\.?\s*process/.test(t);
}

/** Convert a text string with embedded newlines into safe HTML.
    If first line is a short, Title-Case, no-ending-punct heading, bold it. */
function _mpCellToHtml(text){
    if(!text) return '';
    const lines=String(text).replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
        .map(l=>l.trim()).filter(l=>l.length>0);
    if(!lines.length) return '';
    if(lines.length===1) return escHtml(lines[0]);
    const first=lines[0], rest=lines.slice(1);
    const looksLikeHeading = (
        first.length<=60 &&
        /^[A-Z]/.test(first) &&
        !/[.?!;]$/.test(first)
    );
    if(looksLikeHeading){
        return '<strong>'+escHtml(first)+'</strong><br>'
            + rest.map(escHtml).join('<br>');
    }
    return lines.map(escHtml).join('<br>');
}

/** Given an arbitrary HTML blob, return an array of "row" objects:
    each is { cells: [string,...], sourceIsTable: bool }.
    This normalises paragraphs/lists/tables into a uniform row stream. */
function _mpHtmlToRowStream(html){
    const tmp=document.createElement('div');
    tmp.innerHTML=html;
    const rows=[];

    function walk(node){
        if(!node) return;
        if(node.nodeType===Node.TEXT_NODE){
            const t=node.textContent.trim();
            if(t) rows.push({cells:[t], sourceIsTable:false});
            return;
        }
        if(node.nodeName==='TABLE'){
            const tRows=_mpTableRows(node);
            _mpStripLeftEmptyCols(tRows);
            tRows.forEach(r=>{
                const nonEmpty=r.filter(c=>c && c.trim().length>0);
                if(nonEmpty.length) rows.push({cells:nonEmpty, sourceIsTable:true});
            });
            return;
        }
        if(node.nodeName==='OL'){
            [...node.children].forEach((li,i)=>{
                if(li.tagName!=='LI') return;
                // Preserve inner <br>/block structure as newlines for _mpCellToHtml
                const text=(li.innerText||li.textContent||'').trim();
                if(text) rows.push({cells:[String(i+1), text], sourceIsTable:false, isOlStep:true});
            });
            return;
        }
        if(node.nodeName==='UL'){
            [...node.children].forEach(li=>{
                if(li.tagName!=='LI') return;
                const text=(li.innerText||li.textContent||'').trim();
                if(text) rows.push({cells:[text], sourceIsTable:false});
            });
            return;
        }
        if(['P','DIV','H1','H2','H3','H4','H5','H6','LI'].includes(node.nodeName)){
            const text=(node.innerText||node.textContent||'').trim();
            if(text) rows.push({cells:[text], sourceIsTable:false});
            return;
        }
        // Default: recurse children
        [...node.childNodes].forEach(walk);
    }
    [...tmp.childNodes].forEach(walk);
    return rows;
}

/** Core cleaner — matches the backend's canonical output format. */
function _mpFormatHtml(html){
    if(!html || !html.trim()) return html;

    const rowStream=_mpHtmlToRowStream(html);
    if(!rowStream.length) return html;

    // Partition into spec block and process block (same logic as backend)
    const specRows=[];   // [[param, obs], ...]
    let   specHeader='';
    let   manufFor='';
    let   manufSub='';
    const stepRows=[];   // [[serial, content], ...]
    const extras=[];     // pre-content freeform

    let mode=null;       // null | 'spec' | 'steps'

    rowStream.forEach(row=>{
        const rt=row.cells.join(' ').trim();
        if(!rt) return;

        if(_mpIsSpecHeaderRow(rt)){
            specHeader=rt;
            mode='spec';
            return;
        }
        if(_mpIsProcHeaderRow(rt)){
            const rtl=rt.toLowerCase();
            const forIdx=rtl.indexOf('for');
            if(forIdx>=0 && forIdx<30 && rtl.indexOf('manufacturing process for')>=0){
                manufFor=rt;
            } else {
                manufSub=rt;
            }
            mode='steps';
            return;
        }

        if(mode==='spec'){
            const cells=row.cells.filter(c=>c && c.trim().length>0);
            if(cells.length>=2){
                specRows.push([cells[0], cells[1]]);
            } else if(cells.length===1){
                specRows.push([cells[0], '']);
            }
            return;
        }

        if(mode==='steps'){
            const cells=row.cells.filter(c=>c && c.trim().length>0);
            if(!cells.length) return;
            // If the source was an <ol>, the first cell is already the serial
            if(row.isOlStep){
                stepRows.push([parseInt(cells[0],10), cells[1]||'']);
                return;
            }
            const first=cells[0].trim();
            const m=first.match(/^(\d+)\.?$/);
            if(m && cells.length>=2){
                const serial=parseInt(m[1],10);
                // Content = longest cell after serial
                const rest=cells.slice(1);
                const content=rest.reduce((a,b)=>b.length>a.length?b:a, '');
                stepRows.push([serial, content]);
                return;
            }
            // Non-serial row: maybe a combined "1. content in one cell" line
            const m2=first.match(/^(\d+)[\.\)]\s+(.+)/s);
            if(m2){
                stepRows.push([parseInt(m2[1],10), m2[2].trim()]);
                return;
            }
            // Otherwise: continuation for previous step, or sub-heading
            const longest=cells.reduce((a,b)=>b.length>a.length?b:a, '');
            if(stepRows.length){
                const [prevS, prevC]=stepRows[stepRows.length-1];
                stepRows[stepRows.length-1]=[prevS, prevC ? (prevC+'\n'+longest) : longest];
            } else {
                extras.push(longest);
            }
            return;
        }

        // No mode yet → pre-content
        extras.push(rt);
    });

    // Build canonical HTML
    const pieces=[];

    extras.forEach(b=>{
        pieces.push('<p style="font-size:12px;margin:2px 0">'+escHtml(b)+'</p>');
    });

    // Spec table
    if(specHeader || specRows.length){
        const parts=['<table class="mp-spec" style="border-collapse:collapse;width:100%;font-size:11px;table-layout:fixed;margin:0 0 8px 0">'];
        parts.push('<colgroup><col style="width:35%"><col style="width:65%"></colgroup>');
        if(specHeader){
            parts.push('<tr><th colspan="2" style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f1f5f9;text-align:center;font-size:11px">'+escHtml(specHeader)+'</th></tr>');
        }
        // Detect whether first data row is the Parameters/Observation header
        const data=specRows.slice();
        let firstIsHeader=false;
        if(data.length){
            const [p0,o0]=data[0];
            const pl=(p0||'').toLowerCase(), ol=(o0||'').toLowerCase();
            if(pl.startsWith('parameter')||pl.startsWith('paramerter')||ol.startsWith('observation')){
                firstIsHeader=true;
            }
        }
        if(firstIsHeader){
            const [p0,o0]=data.shift();
            parts.push('<tr><th style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f8fafc;text-align:center;font-size:10px">'+escHtml(p0)+'</th><th style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f8fafc;text-align:center;font-size:10px">'+escHtml(o0)+'</th></tr>');
        } else {
            parts.push('<tr><th style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f8fafc;text-align:center;font-size:10px">Parameters</th><th style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f8fafc;text-align:center;font-size:10px">Observation (Result)</th></tr>');
        }
        data.forEach(([p,o])=>{
            parts.push('<tr><td style="border:1px solid #cbd5e1;padding:3px 6px;vertical-align:top;font-size:11px">'+escHtml(p||'')+'</td><td style="border:1px solid #cbd5e1;padding:3px 6px;vertical-align:top;font-size:11px">'+escHtml(o||'')+'</td></tr>');
        });
        parts.push('</table>');
        pieces.push(parts.join(''));
    }

    // Steps table
    if(manufFor || manufSub || stepRows.length){
        const parts=['<table class="mp-steps" style="border-collapse:collapse;width:100%;font-size:11px;table-layout:fixed;margin:0 0 6px 0">'];
        parts.push('<colgroup><col style="width:28px"><col></colgroup>');
        if(manufFor){
            parts.push('<tr><th colspan="2" style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;background:#f1f5f9;text-align:center;font-size:11px">'+escHtml(manufFor)+'</th></tr>');
        }
        if(manufSub){
            parts.push('<tr><th colspan="2" style="border:1px solid #cbd5e1;padding:3px 6px;font-weight:700;background:#f8fafc;text-align:center;font-size:10px">'+escHtml(manufSub)+'</th></tr>');
        }
        stepRows.forEach(([serial, content])=>{
            const cellHtml=_mpCellToHtml(content);
            parts.push('<tr><td class="sr" style="border:1px solid #cbd5e1;padding:3px 4px;text-align:center;color:#64748b;font-size:10px;vertical-align:top">'+serial+'</td><td style="border:1px solid #cbd5e1;padding:3px 6px;vertical-align:top;font-size:11px;line-height:1.5">'+cellHtml+'</td></tr>');
        });
        parts.push('</table>');
        pieces.push(parts.join(''));
    }

    const out=pieces.join('');
    return out || html;
}

// Format currently open batch in the editor
function mpAutoFormat(){
    const ed=document.getElementById('fvqManufEditor');
    if(!ed){toast('Editor not found','error');return;}
    const current=ed.innerHTML.trim();
    if(!current){toast('Nothing to format','warning');return;}
    const formatted=_mpFormatHtml(current);
    if(formatted===current){toast('Already well-formatted','info');return;}
    ed.innerHTML=formatted; mpDirty();
    toast('Auto-formatted ✓ — review then save','success',4000);
}

// Format selected rows (or all with MFG if none selected)
// Converts messy pasted tables into a clean numbered list + preserves spec tables.
// Saves the cleaned HTML back to the DB.
async function mpFormatSelected(){
    const checked=[..._fvqSelectedBatches];
    let targets;
    if(checked.length){
        targets=(_fvqBatches||[]).filter(b=>checked.includes(b.batch_name)&&b.manuf_process&&b.manuf_process.trim());
        if(!targets.length){toast('None of the selected batches have a manufacturing process','warning');return;}
        if(!confirm('Clean and reformat manufacturing process for '+targets.length+' selected batch'+(targets.length!==1?'es':'')+'?\n\nThis will convert step tables into a clean numbered list and save the result to the database.')) return;
    } else {
        targets=(_fvqBatches||[]).filter(b=>b.manuf_process&&b.manuf_process.trim());
        if(!targets.length){toast('No batches with manufacturing process found','warning');return;}
        if(!confirm('No rows selected — clean and reformat ALL '+targets.length+' batches with a manufacturing process?\n\nThis will convert step tables into a clean numbered list and save each result to the database.')) return;
    }
    toast('Cleaning '+targets.length+' batch'+(targets.length!==1?'es':'')+'…','info',3000);
    let done=0,skipped=0,errors=0;
    for(const b of targets){
        try{
            const formatted=_mpFormatHtml(b.manuf_process);
            if(!formatted||formatted===b.manuf_process){skipped++;continue;}
            const res=await fetch('/api/procurement/formulations/manuf_process',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({action:'save',batch_name:b.batch_name,text:formatted})
            });
            const data=await res.json();
            if(data.status!=='ok') throw new Error(data.message);
            b.manuf_process=formatted; done++;
        }catch(e){errors++;console.error('Format failed for',b.batch_name,e);}
    }
    fvqRenderTable();
    if(_fvqDetailBatch){
        const m=(_fvqBatches||[]).find(b=>b.batch_name===_fvqDetailBatch);
        if(m&&m.manuf_process){const ed=document.getElementById('fvqManufEditor');if(ed) ed.innerHTML=m.manuf_process;}
    }
    toast('Done — '+done+' formatted'+(skipped?' · '+skipped+' unchanged':'')+(errors?' · '+errors+' errors':''),errors?'warning':'success',6000);
}
