/* fvq_edit.js — Formulations: add/deduct, update log, inline edit, excel upload
   Depends on: utils.js, fvq_viewer.js */




/* ═══════════════════════════════════════════════════════
   FVQ RADIAL CONTEXT MENU
═══════════════════════════════════════════════════════ */
let _fvqCtxBatch = null;

const FVQ_MENU_ITEMS = [
    { cls:'fvq-ri-view',   icon:'👁',  label:'View',    angle: 270, action: ()=>{ openFvqDetail(_fvqCtxBatch); closeFvqRadial(); } },
    { cls:'fvq-ri-add',    icon:'➕',  label:'Add',     angle: 0,   action: ()=>{ openFvqProcure('add',_fvqCtxBatch); closeFvqRadial(); } },
    { cls:'fvq-ri-deduct', icon:'➖',  label:'Deduct',  angle: 90,  action: ()=>{ openFvqProcure('deduct',_fvqCtxBatch); closeFvqRadial(); } },
    { cls:'fvq-ri-delete', icon:'🗑',  label:'Delete',  angle: 180, action: ()=>{ closeFvqRadial(); deleteFvqBatch(_fvqCtxBatch); } },
    { cls:'fvq-ri-link',   icon:'🔗',  label:'Link',    angle: 315, action: ()=>{ closeFvqRadial(); openLinkFvqModal(_fvqCtxBatch); } },
];

function openFvqCtx(e, batchName){
    e.preventDefault();
    e.stopPropagation();
    _fvqCtxBatch = batchName;

    const menu = document.getElementById('fvqRadialMenu');
    const R = 68; // radius in px from centre — increased for 5 items
    const cx = e.clientX, cy = e.clientY;

    // Position menu centred on click
    menu.style.left = cx + 'px';
    menu.style.top  = cy + 'px';
    menu.style.width  = '0';
    menu.style.height = '0';

    // Build item buttons
    const existing = menu.querySelectorAll('.fvq-radial-item');
    existing.forEach(el=>el.remove());

    FVQ_MENU_ITEMS.forEach(item=>{
        const rad = item.angle * Math.PI / 180;
        const x   = Math.round(R * Math.cos(rad));
        const y   = Math.round(R * Math.sin(rad));
        const btn = document.createElement('button');
        btn.className = `fvq-radial-item ${item.cls}`;
        btn.innerHTML = `<span style="font-size:13px;line-height:1">${item.icon}</span><span class="ri-label">${item.label}</span>`;
        btn.style.marginLeft = x + 'px';
        btn.style.marginTop  = y + 'px';
        btn.title = item.label;
        btn.onclick = (ev)=>{ ev.stopPropagation(); item.action(); };
        menu.appendChild(btn);
    });

    menu.classList.add('open');

    // Close on any outside click
    setTimeout(()=>document.addEventListener('click', _fvqRadialClose, {once:true}), 10);
}

function _fvqRadialClose(){ closeFvqRadial(); }

function closeFvqRadial(){
    const menu = document.getElementById('fvqRadialMenu');
    if(menu) menu.classList.remove('open');
    document.removeEventListener('click', _fvqRadialClose);
}

/* ═══════════════════════════════════════════════════════
   FVQ PROCUREMENT — Add / Deduct
   "Procurement Size" is stored in batch_size column.
   Add:    batch_size = current + qty
   Deduct: batch_size = current - qty  (min 0)
   Both update via DB and reload the table.
═══════════════════════════════════════════════════════ */
let _fvqProcureMode = 'add'; // 'add' | 'deduct'
let _fvqProcureBatch = null;

function openFvqProcure(mode, batchName){
    _fvqProcureMode  = mode;
    _fvqProcureBatch = batchName;

    const meta = _fvqBatches.find(b=>b.batch_name===batchName)||{};
    const current = meta.batch_size ? parseFloat(meta.batch_size) : 0;
    const isAdd   = mode === 'add';

    // Hide the batch autocomplete — not needed when batch is pre-selected
    document.getElementById('fvqProcureBatchWrap').style.display = 'none';
    _fpAcClose();

    document.getElementById('fvqProcureEyebrow').textContent = isAdd ? 'Add Procurement' : 'Deduct Procurement';
    document.getElementById('fvqProcureTitle').textContent   = batchName;
    document.getElementById('fvqProcureSub').textContent     = isAdd
        ? 'Enter quantity to add to the procurement size'
        : 'Enter quantity to deduct from the procurement size';
    document.getElementById('fvqProcureNote').innerHTML = isAdd
        ? `Current procurement size: <strong>${isNaN(current)?'—':fmtNum(current,3)+' KG'}</strong>`
        : `Current: <strong>${isNaN(current)?'—':fmtNum(current,3)+' KG'}</strong> &nbsp;·&nbsp; Result will be <strong style="color:var(--amber-text)">≥ 0 KG</strong>`;

    const btn = document.getElementById('fvqProcureConfirmBtn');
    btn.style.background = isAdd
        ? 'linear-gradient(135deg,var(--green),#059669)'
        : 'linear-gradient(135deg,var(--amber),#d97706)';

    document.getElementById('fvqProcureQtyInput').value = '';
    document.getElementById('fvqProcureModal').classList.add('open');
    setTimeout(()=>document.getElementById('fvqProcureQtyInput').focus(), 60);
}

function closeFvqProcureModal(){
    document.getElementById('fvqProcureModal').classList.remove('open');
}

document.getElementById('fvqProcureModal').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); confirmFvqProcure(); }
});
document.getElementById('fvqProcureModal').addEventListener('click', e=>{
    if(e.target===document.getElementById('fvqProcureModal')) closeFvqProcureModal();
});

async function confirmFvqProcure(){
    // If batch autocomplete is showing, ensure a batch is selected
    if(document.getElementById('fvqProcureBatchWrap')?.style.display !== 'none' && !_fvqProcureBatch){
        toast('Select a batch first','warning');
        document.getElementById('fvqProcureBatchInput').focus();
        return;
    }
    const qty = parseFloat(document.getElementById('fvqProcureQtyInput').value);
    if(!qty || isNaN(qty) || qty <= 0){ toast('Enter a valid quantity','warning'); return; }

    const meta    = _fvqBatches.find(b=>b.batch_name===_fvqProcureBatch)||{};
    // Parse current batch_size — strip non-numeric suffix like " KG"
    const current = meta.batch_size ? parseFloat(String(meta.batch_size).replace(/[^\d.]/g,'')) : 0;
    let   newSize = _fvqProcureMode==='add' ? current+qty : Math.max(0, current-qty);
    // Round to 3 decimal places
    newSize = Math.round(newSize*1000)/1000;

    try{
        const res = await fetch('/api/procurement/formulations/update_batch_size',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                batch_name:  _fvqProcureBatch,
                batch_size:  newSize+' KG',
                action_type: _fvqProcureMode,
                qty_changed: qty,
                size_before: current
            })
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        closeFvqProcureModal();
        const verb = _fvqProcureMode==='add' ? 'Added' : 'Deducted';
        toast(`${verb} ${fmtNum(qty,3)} KG → Procurement Size now ${fmtNum(newSize,3)} KG`, 'success');
        await loadFvqData();
    }catch(err){
        toast('Failed: '+err.message,'error');
    }
}


/* ═══════════════════════════════════════════════════════
   TOOLBAR PROCURE HELPER
   openFvqProcureToolbar: opens procure modal; if only 1 batch exists
   selects it automatically; otherwise prompts a select dropdown.
═══════════════════════════════════════════════════════ */
function openFvqProcureToolbar(mode){
    const _activeBatches = (_fvqBatches||[]).filter(b=>b.is_active !== 0);
    if(!_activeBatches.length){ toast('No active formulations available','warning'); return; }
    if(_activeBatches.length===1){
        openFvqProcure(mode, _activeBatches[0].batch_name);
        return;
    }
    _fvqProcureMode  = mode;
    _fvqProcureBatch = null;
    const isAdd = mode === 'add';
    document.getElementById('fvqProcureEyebrow').textContent = isAdd ? 'Add Procurement' : 'Deduct Procurement';
    document.getElementById('fvqProcureTitle').textContent   = isAdd ? 'Add Procurement' : 'Deduct Procurement';
    document.getElementById('fvqProcureSub').textContent     = isAdd
        ? 'Search and select a batch, then enter quantity to add'
        : 'Search and select a batch, then enter quantity to deduct';
    document.getElementById('fvqProcureNote').textContent    = '← Search and select a batch above first';
    const btn = document.getElementById('fvqProcureConfirmBtn');
    btn.style.background = isAdd
        ? 'linear-gradient(135deg,var(--green),#059669)'
        : 'linear-gradient(135deg,var(--amber),#d97706)';
    // Show batch autocomplete, reset it
    document.getElementById('fvqProcureBatchWrap').style.display = 'block';
    document.getElementById('fvqProcureBatchInput').value = '';
    document.getElementById('fvqProcureBatchClear').style.display = 'none';
    _fpAcClose();
    document.getElementById('fvqProcureQtyInput').value = '';
    document.getElementById('fvqProcureModal').classList.add('open');
    setTimeout(()=>document.getElementById('fvqProcureBatchInput').focus(), 60);
}

function fvqProcureBatchSelected(){
    // legacy — kept for compatibility; now handled by _fpAcPick
}

/* ── Procurement batch autocomplete ── */
let _fpAcIdx = -1;

function _fpAcFilter(inp){
    const q  = (inp.value||'').trim().toLowerCase();
    const dd = document.getElementById('fvqProcureBatchDd');
    if(!dd) return;
    const pool = (_fvqBatches||[]).filter(b=>b.is_active !== 0);
    const matches = q
        ? pool.filter(b=>(b.batch_name||'').toLowerCase().includes(q) || (b.product_code||'').toLowerCase().includes(q)).slice(0,16)
        : pool.slice(0,16);
    if(!matches.length){
        dd.innerHTML = '<div style="padding:10px 12px;color:var(--muted);font-size:11px">No batches found</div>';
        dd.classList.add('open');
        _fpAcIdx = -1;
        return;
    }
    dd.innerHTML = matches.map((b,i)=>{
        const hiName = _fpHighlight(b.batch_name||'', q);
        const sub    = [b.product_code, b.batch_size ? b.batch_size+' KG' : ''].filter(Boolean).join(' · ');
        return `<div class="uf-ac-item${i===_fpAcIdx?' focused':''}"
                     data-batch="${escHtml(b.batch_name)}"
                     onmousedown="_fpAcPick(event,'${escHtml(b.batch_name).replace(/'/g,"\\'")}')" >
            <span class="uf-ac-mat">${hiName}</span>
            ${sub ? `<span class="uf-ac-sup">${escHtml(sub)}</span>` : ''}
        </div>`;
    }).join('');
    dd.classList.add('open');
    _fpAcIdx = -1;
}

function _fpHighlight(text, q){
    if(!q) return escHtml(text);
    const idx = text.toLowerCase().indexOf(q);
    if(idx < 0) return escHtml(text);
    return escHtml(text.slice(0,idx))
        + '<strong style="color:var(--teal)">' + escHtml(text.slice(idx,idx+q.length)) + '</strong>'
        + escHtml(text.slice(idx+q.length));
}

function _fpAcPick(e, batchName){
    if(e) e.preventDefault();
    document.getElementById('fvqProcureBatchInput').value = batchName;
    document.getElementById('fvqProcureBatchClear').style.display = 'block';
    _fpAcClose();
    _fvqProcureBatch = batchName;
    const meta    = (_fvqBatches||[]).find(b=>b.batch_name===batchName)||{};
    const current = meta.batch_size ? parseFloat(String(meta.batch_size).replace(/[^\d.]/g,'')) : 0;
    const isAdd   = _fvqProcureMode === 'add';
    document.getElementById('fvqProcureNote').innerHTML = isAdd
        ? `Current procurement size: <strong>${isNaN(current)?'—':fmtNum(current,3)+' KG'}</strong>`
        : `Current: <strong>${isNaN(current)?'—':fmtNum(current,3)+' KG'}</strong> &nbsp;·&nbsp; Result will be <strong style="color:var(--amber-text)">≥ 0 KG</strong>`;
    setTimeout(()=>document.getElementById('fvqProcureQtyInput').focus(), 60);
}

function _fpAcClose(){
    const dd = document.getElementById('fvqProcureBatchDd');
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _fpAcIdx = -1;
}

function _fpAcClear(){
    document.getElementById('fvqProcureBatchInput').value = '';
    document.getElementById('fvqProcureBatchClear').style.display = 'none';
    _fvqProcureBatch = null;
    document.getElementById('fvqProcureNote').textContent = '← Search and select a batch above first';
    _fpAcClose();
    document.getElementById('fvqProcureBatchInput').focus();
}

function _fpAcKeydown(e){
    const dd    = document.getElementById('fvqProcureBatchDd');
    const items = [...(dd?.querySelectorAll('.uf-ac-item')||[])];
    if(!dd?.classList.contains('open')){
        if(e.key==='ArrowDown'){ e.preventDefault(); _fpAcFilter(document.getElementById('fvqProcureBatchInput')); }
        return;
    }
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _fpAcIdx = Math.min(_fpAcIdx+1, items.length-1);
        items.forEach((el,i)=>el.classList.toggle('focused', i===_fpAcIdx));
        items[_fpAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _fpAcIdx = Math.max(_fpAcIdx-1, 0);
        items.forEach((el,i)=>el.classList.toggle('focused', i===_fpAcIdx));
        items[_fpAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='Enter'||e.key==='Tab'){
        if(_fpAcIdx>=0 && items[_fpAcIdx]){
            e.preventDefault();
            _fpAcPick(null, items[_fpAcIdx].dataset.batch);
        } else { _fpAcClose(); }
    } else if(e.key==='Escape'){
        _fpAcClose();
    }
}

/* ═══════════════════════════════════════════════════════
   UPDATE LOG MODAL
═══════════════════════════════════════════════════════ */
async function openUpdateLog(){
    // Populate batch filter dropdown
    const sel = document.getElementById('fvqLogBatchFilter');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Batches</option>' +
        (_fvqBatches||[]).map(b=>`<option value="${escHtml(b.batch_name)}">${escHtml(b.batch_name)}${b.is_active===0?' (Inactive)':''}</option>`).join('');
    if(prev) sel.value = prev;
    comboboxRefresh(sel);
    document.getElementById('fvqUpdateLogModal').classList.add('open');
    await loadUpdateLog();
}

function closeUpdateLog(){
    document.getElementById('fvqUpdateLogModal').classList.remove('open');
}
document.getElementById('fvqUpdateLogModal').addEventListener('click', e=>{
    if(e.target===document.getElementById('fvqUpdateLogModal')) closeUpdateLog();
});

async function loadUpdateLog(){
    const batchFilter = document.getElementById('fvqLogBatchFilter').value;
    document.getElementById('fvqLogTbody').innerHTML =
        `<tr><td colspan="8"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>`;
    try{
        const url = '/api/procurement/formulations/update_log' + (batchFilter ? '?batch_name='+encodeURIComponent(batchFilter) : '');
        const res  = await fetch(url);
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const rows = data.rows || [];
        document.getElementById('fvqLogCount').textContent = rows.length + ' record' + (rows.length!==1?'s':'');
        if(!rows.length){
            document.getElementById('fvqLogTbody').innerHTML =
                `<tr><td colspan="8"><div class="state-box">
                    <div class="state-icon">📭</div>
                    <h3>No records yet</h3>
                    <p>Use Add / Deduct Procurement to create entries.</p>
                </div></td></tr>`;
            return;
        }
        document.getElementById('fvqLogTbody').innerHTML = rows.map(r=>{
            const isAdd = (r.action_type||'').toLowerCase()==='add';
            const acBg  = isAdd ? 'var(--green-bg)' : 'var(--amber-bg)';
            const acCol = isAdd ? 'var(--green-text)' : 'var(--amber-text)';
            const acTxt = isAdd ? '＋ Add' : '－ Deduct';
            const dt    = r.action_at ? String(r.action_at).slice(0,16).replace('T',' ') : '—';
            return `<tr style="border-bottom:1px solid var(--border);transition:background .1s"
                        onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
                <td style="padding:9px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${r.sr_no}</td>
                <td style="padding:9px 14px;font-weight:500;color:var(--text);font-size:12px;border-right:1px solid var(--border)">${escHtml(r.batch_name)}</td>
                <td style="padding:9px 14px;border-right:1px solid var(--border)">
                    <span style="font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:20px;background:${acBg};color:${acCol}">${acTxt}</span>
                </td>
                <td style="padding:9px 14px;font-family:var(--font-mono);font-size:11.5px;font-weight:700;color:${acCol};text-align:right;border-right:1px solid var(--border)">${r.qty_changed!=null?fmtNum(r.qty_changed,3)+' KG':'—'}</td>
                <td style="padding:9px 14px;font-family:var(--font-mono);font-size:11px;color:var(--muted2);text-align:right;border-right:1px solid var(--border)">${r.size_before!=null?fmtNum(r.size_before,3)+' KG':'—'}</td>
                <td style="padding:9px 14px;font-family:var(--font-mono);font-size:11.5px;font-weight:600;color:var(--text);text-align:right;border-right:1px solid var(--border)">${r.size_after!=null?fmtNum(r.size_after,3)+' KG':'—'}</td>
                <td style="padding:9px 14px;font-size:11px;color:var(--muted2);border-right:1px solid var(--border)">${escHtml(r.action_by||'—')}</td>
                <td style="padding:9px 14px;font-size:10.5px;color:var(--muted);font-family:var(--font-mono)">${dt}</td>
            </tr>`;
        }).join('');
    }catch(err){
        document.getElementById('fvqLogTbody').innerHTML =
            `<tr><td colspan="8"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>${escHtml(err.message)}</p></div></td></tr>`;
    }
}


/* ═══════════════════════════════════════════════════════
   FVQ CHECKBOX + BULK DELETE
═══════════════════════════════════════════════════════ */
function fvqToggleSelectAll(cb){
    const checked = cb.checked;
    document.querySelectorAll('.fvq-row-cb').forEach(el=>{
        el.checked = checked;
    });
    fvqUpdateDeleteBtn();
}

function fvqUpdateDeleteBtn(){
    const sel = [...document.querySelectorAll('.fvq-row-cb:checked')];
    const btn = document.getElementById('fvqDeleteSelBtn');
    if(btn){
        btn.disabled  = sel.length === 0;
        btn.style.opacity = sel.length > 0 ? '1' : '.4';
        btn.style.cursor  = sel.length > 0 ? 'pointer' : 'not-allowed';
    }
    // Also uncheck "select all" if not all are checked
    const all   = document.querySelectorAll('.fvq-row-cb');
    const allCb = document.getElementById('fvqSelectAll');
    if(allCb) allCb.checked = all.length > 0 && sel.length === all.length;
}

// Wire up change event on dynamically rendered checkboxes (event delegation)
document.getElementById('fvqTbody').addEventListener('change', e=>{
    if(e.target.classList.contains('fvq-row-cb')) fvqUpdateDeleteBtn();
});

async function deleteSelectedFvq(){
    const sel = [...document.querySelectorAll('.fvq-row-cb:checked')].map(el=>el.dataset.batch);
    if(!sel.length){ toast('Select at least one batch to delete','warning'); return; }
    const msg = sel.length===1
        ? `Delete batch:\n"${sel[0]}"?`
        : `Delete ${sel.length} selected batches?\n\nThis cannot be undone.`;
    if(!confirm(msg)) return;
    try{
        const res  = await fetch('/api/procurement/formulations/delete_batches',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({batch_names: sel})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast(`Deleted ${data.deleted} batch${data.deleted!==1?'es':''}`, 'success');
        await loadFvqData();
    }catch(err){ toast('Delete failed: '+err.message,'error'); }
}


/* ═══════════════════════════════════════════════════════
   UPDATE FORMULATION MODAL
   Two flows:
     1. Inline edit  — select batch, edit rows in a table, save
     2. Excel upload — select target batch, upload .xlsx, pick sheet, confirm
═══════════════════════════════════════════════════════ */

let _ufOption      = '';       // 'inline' | 'excel'
let _ufBasename    = '';       // uploaded file basename (excel flow)
let _ufFileSheets  = [];       // sheets from inspect (excel flow)

/* ── Open / close ─────────────────────────────────────── */

/* ═══════════════════════════════════════════════════════
   UPDATE FORMULATION — MATERIAL AUTOCOMPLETE
   _allRows is the Tab-1 material list (material_name + supplier_name).
   Typing in a .uf-mat-input filters _allRows by name.
   Clicking/selecting a match:
     • fills the material name input
     • auto-fills the sibling .uf-sup-input with supplier from Tab-1
═══════════════════════════════════════════════════════ */

let _ufAcFocusIdx = -1;

function _ufAcFilter(inp){
    const q = (inp.value||'').trim().toLowerCase();
    const dd = inp.closest('.uf-ac-wrap')?.querySelector('.uf-ac-dd');
    if(!dd) return;

    if(!q){
        dd.innerHTML='';
        dd.classList.remove('open');
        _ufAcFocusIdx=-1;
        return;
    }

    const matches = (_allRows||[])
        .filter(m=>(m.material_name||'').toLowerCase().includes(q))
        .slice(0,12);

    if(!matches.length){
        dd.innerHTML='<div style="padding:10px 12px;color:var(--muted);font-size:11px">No materials found</div>';
        dd.classList.add('open');
        _ufAcFocusIdx=-1;
        return;
    }

    dd.innerHTML = matches.map((m,i)=>`
        <div class="uf-ac-item${i===_ufAcFocusIdx?' focused':''}"
             data-mat="${escHtml(m.material_name||'')}"
             data-sup="${escHtml(m.supplier_name||'')}"
             onmousedown="_ufAcSelect(event,this)">
            <span class="uf-ac-mat">${_ufAcHighlight(m.material_name||'',q)}</span>
            ${m.supplier_name?`<span class="uf-ac-sup">${escHtml(m.supplier_name)}</span>`:''}
        </div>`).join('');
    dd.classList.add('open');
    _ufAcFocusIdx=-1;
}

function _ufAcHighlight(text, query){
    // Bold the matching substring — returned as plain text, escHtml wraps the whole string
    // We do a simple prefix-agnostic match highlight using a marker approach
    // Since escHtml is applied AFTER, we return raw HTML here
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if(idx<0) return escHtml(text);
    return escHtml(text.slice(0,idx))
        + '<strong style="color:var(--teal)">' + escHtml(text.slice(idx,idx+query.length)) + '</strong>'
        + escHtml(text.slice(idx+query.length));
}
// Override: _ufAcHighlight returns HTML, not plain text — remove the outer escHtml in the template
// (already done above by having escHtml inside the fn)

function _ufAcSelect(e, item){
    e.preventDefault();
    const inp  = item.closest('.uf-ac-wrap')?.querySelector('.uf-mat-input');
    const supI = item.closest('tr')?.querySelector('.uf-sup-input');
    if(inp)  inp.value  = item.dataset.mat;
    if(supI && item.dataset.sup) supI.value = item.dataset.sup;
    _ufAcClose(inp);
    inp?.style && (inp.style.borderColor = '');
    // Move focus to conc field
    item.closest('tr')?.querySelector('.uf-conc-input')?.focus();
}

function _ufAcClose(inp){
    const dd = inp?.closest('.uf-ac-wrap')?.querySelector('.uf-ac-dd');
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _ufAcFocusIdx=-1;
}

function _ufAcKeydown(e, inp){
    const dd    = inp.closest('.uf-ac-wrap')?.querySelector('.uf-ac-dd');
    const items = [...(dd?.querySelectorAll('.uf-ac-item')||[])];
    if(!dd?.classList.contains('open') || !items.length){
        if(e.key==='Tab') _ufAcClose(inp);
        return;
    }
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _ufAcFocusIdx = Math.min(_ufAcFocusIdx+1, items.length-1);
        _ufAcHilite(items);
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _ufAcFocusIdx = Math.max(_ufAcFocusIdx-1, 0);
        _ufAcHilite(items);
    } else if(e.key==='Enter' || e.key==='Tab'){
        if(_ufAcFocusIdx>=0 && items[_ufAcFocusIdx]){
            e.preventDefault();
            _ufAcSelect({preventDefault:()=>{}}, items[_ufAcFocusIdx]);
        } else {
            _ufAcClose(inp);
        }
    } else if(e.key==='Escape'){
        _ufAcClose(inp);
    }
}

function _ufAcHilite(items){
    items.forEach((el,i)=>el.classList.toggle('focused', i===_ufAcFocusIdx));
    items[_ufAcFocusIdx]?.scrollIntoView({block:'nearest'});
}


/* ═══════════════════════════════════════════════════════
   LINK FORMULATION — JS
   openLinkFvqModal: opens the Link Formulation modal
   confirmLinkFvq:   creates the linked batch via API
   propagateChoice:  handles post-save dialog for linked batches
═══════════════════════════════════════════════════════ */

/* ── Modal open/close ─────────────────────────────────── */
function openLinkFvqModal(prefillSource){
    if(!_fvqBatches.length){ toast('No formulations available — import one first','warning'); return; }
    // Reset autocomplete source input
    document.getElementById('linkSrcInput').value  = '';
    document.getElementById('linkSrcSelect').value = '';
    document.getElementById('linkSrcInfo').textContent = '';
    document.getElementById('linkSrcClearBtn').style.display = 'none';
    const linkSrcDd = document.getElementById('linkSrcDd');
    if(linkSrcDd){ linkSrcDd.innerHTML=''; linkSrcDd.classList.remove('open'); }
    // Start with two empty rows
    document.getElementById('linkRowsContainer').innerHTML = '';
    linkAddRow();
    linkAddRow();
    linkUpdateCount();
    if(prefillSource){
        document.getElementById('linkSrcSelect').value = prefillSource;
        linkSrcChanged();
    }
    document.getElementById('linkFvqModal').classList.add('open');
    setTimeout(()=>document.querySelector('#linkRowsContainer .link-name-input')?.focus(), 60);
}

function closeLinkFvqModal(){
    document.getElementById('linkFvqModal').classList.remove('open');
}
document.getElementById('linkFvqModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('linkFvqModal')) closeLinkFvqModal();
});
document.getElementById('linkFvqModal').addEventListener('keydown',e=>{
    if(e.key==='Enter'){ e.preventDefault(); confirmLinkFvq(); }
});


/* ═══════════════════════════════════════════════════════
   LINK MODAL — Source Formulation Autocomplete
   Filters _fvqBatches by batch_name as the user types.
   On select: fills the hidden #linkSrcSelect value,
   shows the clear button, fires linkSrcChanged().
═══════════════════════════════════════════════════════ */
let _linkSrcAcIdx = -1;

function _linkSrcFilter(inp){
    const q   = (inp.value||'').trim().toLowerCase();
    const dd  = document.getElementById('linkSrcDd');
    if(!dd) return;

    const pool = (_fvqBatches||[]).filter(b=>b.is_active !== 0);
    const matches = q
        ? pool.filter(b=>(b.batch_name||'').toLowerCase().includes(q)).slice(0,14)
        : pool.slice(0,14);

    if(!matches.length){
        dd.innerHTML = q
            ? '<div style="padding:10px 12px;color:var(--muted);font-size:11px">No formulations found</div>'
            : '';
        dd.classList.toggle('open', !!q);
        _linkSrcAcIdx = -1;
        return;
    }

    dd.innerHTML = matches.map((b,i)=>{
        const linked = (_fvqBatches||[]).filter(x=>x.source_batch_name===b.batch_name).length;
        return `<div class="uf-ac-item${i===_linkSrcAcIdx?' focused':''}"
                     data-val="${escHtml(b.batch_name)}"
                     onmousedown="_linkSrcSelect(event,'${escHtml(b.batch_name).replace(/'/g,"\\'")}')">
            <span class="uf-ac-mat">${_linkSrcHighlight(b.batch_name,q)}</span>
            <span class="uf-ac-sup">
                ${b.item_count||0} ingredients
                ${b.batch_size?' · '+escHtml(b.batch_size):''}
                ${linked>0?' · 🔗 '+linked+' linked':''}
            </span>
        </div>`;
    }).join('');
    dd.classList.add('open');
    _linkSrcAcIdx = -1;
}

function _linkSrcHighlight(text, q){
    if(!q) return escHtml(text);
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if(idx < 0) return escHtml(text);
    return escHtml(text.slice(0,idx))
        + '<strong style="color:var(--teal)">' + escHtml(text.slice(idx,idx+q.length)) + '</strong>'
        + escHtml(text.slice(idx+q.length));
}

function _linkSrcSelect(e, batchName){
    if(e) e.preventDefault();
    document.getElementById('linkSrcInput').value  = batchName;
    document.getElementById('linkSrcSelect').value = batchName;
    document.getElementById('linkSrcClearBtn').style.display = 'block';
    _linkSrcClose();
    linkSrcChanged();   // update info strip + button state
}

function _linkSrcClose(){
    const dd = document.getElementById('linkSrcDd');
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _linkSrcAcIdx = -1;
}

function _linkSrcClear(){
    document.getElementById('linkSrcInput').value  = '';
    document.getElementById('linkSrcSelect').value = '';
    document.getElementById('linkSrcClearBtn').style.display = 'none';
    document.getElementById('linkSrcInfo').textContent = '';
    _linkSrcClose();
    linkUpdateCount();
}

function _linkSrcKeydown(e, inp){
    const dd    = document.getElementById('linkSrcDd');
    const items = [...(dd?.querySelectorAll('.uf-ac-item')||[])];
    if(!dd?.classList.contains('open') || !items.length){
        if(e.key==='Escape') _linkSrcClear();
        return;
    }
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _linkSrcAcIdx = Math.min(_linkSrcAcIdx+1, items.length-1);
        items.forEach((el,i)=>el.classList.toggle('focused',i===_linkSrcAcIdx));
        items[_linkSrcAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _linkSrcAcIdx = Math.max(_linkSrcAcIdx-1, 0);
        items.forEach((el,i)=>el.classList.toggle('focused',i===_linkSrcAcIdx));
        items[_linkSrcAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='Enter'||e.key==='Tab'){
        if(_linkSrcAcIdx>=0 && items[_linkSrcAcIdx]){
            e.preventDefault();
            _linkSrcSelect(null, items[_linkSrcAcIdx].dataset.val);
        } else {
            _linkSrcClose();
        }
    } else if(e.key==='Escape'){
        _linkSrcClose();
    }
}

function linkSrcChanged(){
    const bn = document.getElementById('linkSrcSelect').value;
    const info = document.getElementById('linkSrcInfo');
    if(!bn){ info.textContent=''; linkUpdateCount(); return; }
    const meta = _fvqBatches.find(b=>b.batch_name===bn)||{};
    const linkedCount = _fvqBatches.filter(b=>b.source_batch_name===bn).length;
    info.innerHTML =
        `<span style="color:var(--teal)">${meta.item_count||0} ingredients</span>` +
        (meta.batch_size ? ` · Source size: <strong>${escHtml(meta.batch_size)}</strong>` : '') +
        (linkedCount > 0 ? ` · <span style="color:#a78bfa">🔗 ${linkedCount} batch${linkedCount>1?'es':''} already linked</span>` : '');
    linkUpdateCount();
}

function linkAddRow(){
    const container = document.getElementById('linkRowsContainer');
    const idx = container.querySelectorAll('.link-row').length;
    const isEven = idx % 2 === 0;
    const row = document.createElement('div');
    row.className = 'link-row';
    row.style.cssText = `display:grid;grid-template-columns:1fr 110px 28px;gap:6px;
        padding:5px 8px;border-bottom:1px solid var(--border);
        background:${isEven ? 'transparent' : 'var(--surface2)'}`;
    row.innerHTML = `
        <input class="link-name-input" type="text" placeholder="Batch / product name…"
               oninput="linkUpdateCount()"
               style="height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                      background:var(--surface);color:var(--text);font-size:12px;outline:none;width:100%"
               onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        <input class="link-size-input" type="number" step="0.001" min="0" placeholder="KG"
               style="height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                      background:var(--surface);color:var(--teal);font-size:12px;
                      font-family:var(--font-mono);text-align:right;outline:none;width:100%"
               onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        <button onclick="linkRemoveRow(this)" title="Remove"
                style="width:24px;height:24px;border-radius:50%;border:1px solid var(--border2);
                       background:transparent;color:var(--muted);cursor:pointer;font-size:12px;
                       display:flex;align-items:center;justify-content:center;margin-top:2px;flex-shrink:0"
                onmouseover="this.style.color='var(--red-text)';this.style.borderColor='var(--red-text)'"
                onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border2)'">✕</button>`;
    container.appendChild(row);
    linkUpdateCount();
    // Focus the new input
    row.querySelector('.link-name-input')?.focus();
}

function linkRemoveRow(btn){
    const row = btn.closest('.link-row');
    if(!row) return;
    // Keep at least 1 row
    const container = document.getElementById('linkRowsContainer');
    if(container.querySelectorAll('.link-row').length <= 1){
        toast('Keep at least one batch name row','warning');
        return;
    }
    row.remove();
    // Re-stripe rows
    container.querySelectorAll('.link-row').forEach((r,i)=>{
        r.style.background = i%2===0 ? 'transparent' : 'var(--surface2)';
    });
    linkUpdateCount();
}

function linkUpdateCount(){
    const src  = document.getElementById('linkSrcSelect').value;
    const rows = [...document.querySelectorAll('#linkRowsContainer .link-name-input')]
                 .map(i=>i.value.trim()).filter(Boolean);
    const n    = rows.length;
    const hint = document.getElementById('linkBatchCountHint');
    if(hint) hint.textContent = n === 0 ? '0 batches to create'
                              : n === 1 ? '1 batch to create'
                              : `${n} batches to create`;
    const btn  = document.getElementById('linkConfirmBtn');
    const ready = !!(src && n > 0);
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '.45';
    btn.style.cursor  = ready ? 'pointer' : 'not-allowed';
    if(btn && n > 0) btn.textContent = n === 1 ? 'Create 1 Linked Batch' : `Create ${n} Linked Batches`;
    else if(btn) btn.textContent = 'Create Linked Batches';
}

async function confirmLinkFvq(){
    const src = document.getElementById('linkSrcSelect').value;
    if(!src){ toast('Select a source formulation','warning'); return; }

    // Collect all filled rows
    const nameRows = [...document.querySelectorAll('#linkRowsContainer .link-row')];
    const batches  = nameRows.map(row=>({
        name: row.querySelector('.link-name-input')?.value.trim()||'',
        size: row.querySelector('.link-size-input')?.value.trim()||''
    })).filter(b=>b.name);

    if(!batches.length){ toast('Add at least one batch name','warning'); return; }

    // Validate: no duplicates within the list
    const names = batches.map(b=>b.name.toLowerCase());
    const dupes = names.filter((n,i)=>names.indexOf(n)!==i);
    if(dupes.length){ toast(`Duplicate batch name: "${batches[names.indexOf(dupes[0])].name}"`, 'warning'); return; }

    // Validate: none equal to source
    if(batches.some(b=>b.name===src)){ toast('Batch name cannot be the same as the source','warning'); return; }

    const btn = document.getElementById('linkConfirmBtn');
    btn.disabled=true; btn.textContent='Creating…';

    let created=0, failed=[];
    for(const b of batches){
        try{
            const res  = await fetch('/api/procurement/formulations/link_batch',{
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({new_batch_name:b.name, source_batch_name:src, batch_size:b.size||null})
            });
            const data = await res.json();
            if(data.status!=='ok') throw new Error(data.message);
            created++;
        }catch(err){
            failed.push(`"${b.name}": ${err.message}`);
        }
    }

    if(created > 0){
        closeLinkFvqModal();
        toast(`Created ${created} linked batch${created>1?'es':''} from "${src}"`, 'success');
        await loadFvqData();
    }
    if(failed.length){
        failed.forEach(msg=>toast(msg,'error',6000));
        if(created===0){
            btn.disabled=false;
            btn.textContent=batches.length===1?'Create 1 Linked Batch':`Create ${batches.length} Linked Batches`;
        }
    }
}

/* ── Propagation dialog (shown after saving changes to a batch with linked children) ── */
let _propagatePendingRows    = null;  // the new ingredient rows just saved
let _propagateSourceBatch    = null;  // the batch that was edited
let _propagateLinkedBatches  = [];    // linked batches that will be affected

function _showPropagateDialog(sourceBatch, linkedBatches, savedRows){
    _propagateSourceBatch   = sourceBatch;
    _propagateLinkedBatches = linkedBatches;
    _propagatePendingRows   = savedRows;

    document.getElementById('propagateSub').textContent =
        `"${sourceBatch}" has ${linkedBatches.length} linked batch${linkedBatches.length>1?'es':''}.`;

    document.getElementById('propagateList').innerHTML =
        linkedBatches.map(bn=>`
            <div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
                <span style="font-size:1rem">🔗</span>
                <span style="font-size:12px;font-weight:600;color:var(--text)">${escHtml(bn)}</span>
                ${(()=>{ const m=_fvqBatches.find(b=>b.batch_name===bn); return m?.batch_size?`<span style="font-size:10.5px;color:var(--muted)"> · ${escHtml(m.batch_size)}</span>`:''; })()}
            </div>`).join('');

    document.getElementById('propagateFvqModal').classList.add('open');
}

async function propagateChoice(choice){
    document.getElementById('propagateFvqModal').classList.remove('open');
    if(choice === 'cancel') return;

    if(choice === 'propagate'){
        // Push ingredient changes to all linked batches
        try{
            const res  = await fetch('/api/procurement/formulations/propagate_to_linked',{
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({source_batch_name:_propagateSourceBatch, rows:_propagatePendingRows})
            });
            const data = await res.json();
            if(data.status!=='ok') throw new Error(data.message);
            toast(`Updated ${data.count} linked batch${data.count>1?'es':''} with new ingredients`, 'success');
        }catch(err){
            toast('Propagation failed: '+err.message,'error');
        }
    } else if(choice === 'unlink'){
        // Unlink all child batches (make them independent copies)
        const promises = _propagateLinkedBatches.map(bn=>
            fetch('/api/procurement/formulations/unlink_batch',{
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({batch_name:bn})
            })
        );
        await Promise.all(promises);
        toast(`${_propagateLinkedBatches.length} batch${_propagateLinkedBatches.length>1?'es':''} unlinked — now independent`, 'info');
    }
    await loadFvqData();
    _propagatePendingRows=null; _propagateSourceBatch=null; _propagateLinkedBatches=[];
}

/* ── Inline-edit batch autocomplete ── */
let _ufInlineAcIdx = -1;

function ufInlineBatchAcFilter(q){
    const list  = document.getElementById('ufInlineBatchAcList');
    const hid   = document.getElementById('ufBatchSelect');
    if(!list) return;
    const names = window._ufBatchNames || [];
    const ql = q.trim().toLowerCase();
    const matches = ql ? names.filter(n=>n.toLowerCase().includes(ql)) : names;
    if(!matches.length){ list.style.display='none'; return; }
    _ufInlineAcIdx = -1;
    list.innerHTML = matches.map((n,i)=>{
        const hi = ql
            ? escHtml(n).replace(new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),
                m=>`<mark style="background:rgba(20,184,166,.25);color:var(--teal);border-radius:2px">${m}</mark>`)
            : escHtml(n);
        return `<div class="uf-ac-item-il" data-val="${escHtml(n)}" data-idx="${i}"
                     onclick="ufInlineBatchAcSelect(this.dataset.val)"
                     onmouseenter="ufInlineBatchAcHover(this)"
                     style="padding:7px 12px;font-size:12px;cursor:pointer;color:var(--text);
                            border-bottom:1px solid var(--border);transition:background .1s">${hi}</div>`;
    }).join('');
    list.style.display = 'block';
    if(hid){ hid.value=''; }
    setTimeout(()=>document.addEventListener('click',function _c(e){
        const wrap=document.getElementById('ufInlineBatchAcWrap');
        if(wrap&&!wrap.contains(e.target)){
            list.style.display='none';
            document.removeEventListener('click',_c);
        }
    }),10);
}

function ufInlineBatchAcHover(el){
    document.querySelectorAll('.uf-ac-item-il').forEach(i=>i.style.background='');
    el.style.background='var(--teal-glow,rgba(20,184,166,.1))';
    _ufInlineAcIdx = parseInt(el.dataset.idx);
}

function ufInlineBatchAcSelect(val){
    const inp  = document.getElementById('ufBatchInput');
    const hid  = document.getElementById('ufBatchSelect');
    const list = document.getElementById('ufInlineBatchAcList');
    if(inp)  inp.value  = val;
    if(hid)  hid.value  = val;
    if(list) list.style.display = 'none';
    ufLoadBatchForEdit(); // trigger existing load logic
}

function ufInlineBatchAcKey(e){
    const list  = document.getElementById('ufInlineBatchAcList');
    const items = [...document.querySelectorAll('.uf-ac-item-il')];
    if(!items.length || list.style.display==='none') return;
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _ufInlineAcIdx = Math.min(_ufInlineAcIdx+1, items.length-1);
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _ufInlineAcIdx = Math.max(_ufInlineAcIdx-1, 0);
    } else if(e.key==='Enter'){
        e.preventDefault();
        if(_ufInlineAcIdx>=0 && items[_ufInlineAcIdx])
            ufInlineBatchAcSelect(items[_ufInlineAcIdx].dataset.val);
        return;
    } else if(e.key==='Escape'){
        list.style.display='none'; return;
    } else { return; }
    items.forEach((it,i)=>{
        const active = i===_ufInlineAcIdx;
        it.style.background = active ? 'var(--teal-glow,rgba(20,184,166,.1))' : '';
        if(active) it.scrollIntoView({block:'nearest'});
    });
}

/* ── Batch autocomplete for Update Formulation modal ── */
/* ── Batch autocomplete for Excel screen ── */
let _ufAcIdx = -1;

function ufBatchAcFilter(q){
    const list = document.getElementById('ufBatchAcList');
    const hid  = document.getElementById('ufExcelBatchSelect');
    if(!list) return;
    const names = window._ufBatchNames || [];
    const ql = q.trim().toLowerCase();
    const matches = ql ? names.filter(n=>n.toLowerCase().includes(ql)) : names;
    if(!matches.length){ list.style.display='none'; return; }
    _ufAcIdx = -1;
    list.innerHTML = matches.map((n,i)=>{
        const hi = ql
            ? escHtml(n).replace(new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),
                m=>`<mark style="background:rgba(20,184,166,.25);color:var(--teal);border-radius:2px">${m}</mark>`)
            : escHtml(n);
        return `<div class="uf-ac-item" data-val="${escHtml(n)}" data-idx="${i}"
                     onclick="ufBatchAcSelect(this.dataset.val)"
                     onmouseenter="ufBatchAcHover(this)"
                     style="padding:7px 12px;font-size:12px;cursor:pointer;color:var(--text);
                            border-bottom:1px solid var(--border);transition:background .1s">${hi}</div>`;
    }).join('');
    list.style.display = 'block';
    if(hid) hid.value = '';
    _ufCheckExcelReady();
    setTimeout(()=>document.addEventListener('click',function _c(e){
        const wrap=document.getElementById('ufBatchAcWrap');
        if(wrap&&!wrap.contains(e.target)){
            list.style.display='none';
            document.removeEventListener('click',_c);
        }
    }),10);
}
function ufBatchAcHover(el){
    document.querySelectorAll('.uf-ac-item').forEach(i=>i.style.background='');
    el.style.background='var(--teal-glow,rgba(20,184,166,.1))';
    _ufAcIdx = parseInt(el.dataset.idx);
}
function ufBatchAcSelect(val){
    const inp=document.getElementById('ufExcelBatchInput');
    const hid=document.getElementById('ufExcelBatchSelect');
    const list=document.getElementById('ufBatchAcList');
    if(inp) inp.value=val; if(hid) hid.value=val;
    if(list) list.style.display='none';
    _ufCheckExcelReady();
}
function ufBatchAcKey(e){
    const list=document.getElementById('ufBatchAcList');
    const items=[...document.querySelectorAll('.uf-ac-item')];
    if(!items.length||list.style.display==='none') return;
    if(e.key==='ArrowDown'){e.preventDefault();_ufAcIdx=Math.min(_ufAcIdx+1,items.length-1);}
    else if(e.key==='ArrowUp'){e.preventDefault();_ufAcIdx=Math.max(_ufAcIdx-1,0);}
    else if(e.key==='Enter'){e.preventDefault();if(_ufAcIdx>=0&&items[_ufAcIdx])ufBatchAcSelect(items[_ufAcIdx].dataset.val);return;}
    else if(e.key==='Escape'){list.style.display='none';return;} else return;
    items.forEach((it,i)=>{it.style.background=i===_ufAcIdx?'var(--teal-glow,rgba(20,184,166,.1))':'';if(i===_ufAcIdx)it.scrollIntoView({block:'nearest'});});
}

async function openUpdateFvqModal(){
    // Lazy-load batches if not yet populated (DOMContentLoaded race / first open)
    if((!_fvqBatches || !_fvqBatches.length) && typeof loadFvqData==='function'){
        try { await loadFvqData(); } catch(e){ console.error('openUpdateFvqModal: loadFvqData failed', e); }
    }
    if(!_fvqBatches.length){
        toast('No formulations available — import one first','warning');
        return;
    }
    // Reset to choice screen
    ufShowScreen('choice');
    // Populate batch dropdowns
    // Store batch names for both autocomplete widgets (active only)
    const _activeBatchesUF = (_fvqBatches||[]).filter(b=>b.is_active !== 0);
    window._ufBatchNames = _activeBatchesUF.map(b=>b.batch_name);
    // Build <option> markup for the native <select> dropdowns
    const _ufOpts = '<option value="">— Select target batch —</option>'
        + _activeBatchesUF
            .map(b=>`<option value="${escHtml(b.batch_name)}">${escHtml(b.batch_name)}</option>`)
            .join('');
    // Reset inline batch autocomplete
    const _ib=document.getElementById('ufBatchInput');
    const _ih=document.getElementById('ufBatchSelect');
    if(_ib){_ib.value='';}
    if(_ih){
        _ih.innerHTML='<option value="">— Select a batch —</option>'
            + _activeBatchesUF
                .map(b=>`<option value="${escHtml(b.batch_name)}">${escHtml(b.batch_name)}</option>`)
                .join('');
        _ih.value='';
    }
    // Reset excel batch autocomplete
    const _ei=document.getElementById('ufExcelBatchInput');
    const _eh=document.getElementById('ufExcelBatchSelect');
    if(_ei){_ei.value='';}
    if(_eh){
        _eh.innerHTML=_ufOpts;
        _eh.value='';
    }
    // Reset excel screen
    document.getElementById('ufFileStatus').textContent       = 'No file selected';
    document.getElementById('ufSheetPickerWrap').style.display= 'none';
    document.getElementById('ufFileInput').value              = '';
    _ufCheckExcelReady();
    // Reset inline screen
    document.getElementById('ufEditTbody').innerHTML =
        '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--muted);font-size:12px">Select a batch above to edit</td></tr>';
    document.getElementById('ufSaveInlineBtn').disabled = true;
    document.getElementById('ufSaveInlineBtn').style.opacity = '.45';
    document.getElementById('ufSaveInlineBtn').style.cursor  = 'not-allowed';
    document.getElementById('ufRowCount').textContent = '0 ingredients';

    document.getElementById('updateFvqModal').classList.add('open');
}

function closeUpdateFvqModal(){
    document.getElementById('updateFvqModal').classList.remove('open');
}
document.getElementById('updateFvqModal').addEventListener('click', e=>{
    if(e.target===document.getElementById('updateFvqModal')) closeUpdateFvqModal();
});

/* ── Screen switching ─────────────────────────────────── */
function ufShowScreen(screen){
    document.getElementById('ufChoiceScreen').style.display  = screen==='choice'  ? 'block' : 'none';
    document.getElementById('ufInlineScreen').style.display  = screen==='inline'  ? 'flex'  : 'none';
    document.getElementById('ufExcelScreen').style.display   = screen==='excel'   ? 'flex'  : 'none';
    _ufOption = screen;
}

function ufSelectOption(opt){
    if(opt==='link'){
        // Close the Update Formulation modal and open the Link modal
        closeUpdateFvqModal();
        openLinkFvqModal();
        return;
    }
    ufShowScreen(opt);
}

function ufGoBack(){
    ufShowScreen('choice');
}

/* ══════════════════════════════════════════════════════════
   INLINE EDIT FLOW
══════════════════════════════════════════════════════════ */
function ufLoadBatchForEdit(){
    const bn = document.getElementById('ufBatchSelect').value;
    if(!bn){
        document.getElementById('ufEditTbody').innerHTML =
            '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--muted);font-size:12px">Select a batch above to edit</td></tr>';
        document.getElementById('ufSaveInlineBtn').disabled = true;
        document.getElementById('ufSaveInlineBtn').style.opacity = '.45';
        document.getElementById('ufSaveInlineBtn').style.cursor  = 'not-allowed';
        document.getElementById('ufRowCount').textContent = '0 ingredients';
        return;
    }
    // Load rows from _fvqDetail
    const rows = _fvqDetail.filter(r=>r.batch_name===bn);
    if(!rows.length){ toast('No ingredient data found for this batch','warning'); return; }
    // Build supplier lookup from Tab-1
    const sm = {};
    (_allRows||[]).forEach(m=>{
        const k=(m.material_name||'').trim().toLowerCase();
        if(m.supplier_name) sm[k]=m.supplier_name.trim();
    });
    _ufRenderEditRows(rows, sm);
    document.getElementById('ufSaveInlineBtn').disabled = false;
    document.getElementById('ufSaveInlineBtn').style.opacity = '1';
    document.getElementById('ufSaveInlineBtn').style.cursor  = 'pointer';
}

function _ufRenderEditRows(rows, sm){
    sm = sm || {};
    document.getElementById('ufEditTbody').innerHTML = rows.map((r,i)=>{
        const key = (r.material_name||'').trim().toLowerCase();
        const sup = sm[key] || r.supplier_name || '';
        const concPct = r.concentration ? (parseFloat(r.concentration)*100).toFixed(6).replace(/\.?0+$/,'') : '';
        const qty = r.qty_kg || '';
        return `<tr id="ufRow_${i}" style="border-bottom:1px solid var(--border)">
            <td style="padding:7px 10px;color:var(--muted);font-size:10px;font-family:var(--font-mono);border-right:1px solid var(--border);text-align:center">${i+1}</td>
            <td style="padding:5px 8px;border-right:1px solid var(--border)">
                <div class="uf-ac-wrap">
                    <input class="uf-mat-input" autocomplete="off"
                           value="${escHtml(r.material_name||'')}"
                           style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                                  background:var(--surface);color:var(--text);font-size:12px;outline:none"
                           oninput="_ufAcFilter(this)"
                           onkeydown="_ufAcKeydown(event,this)"
                           onfocus="this.style.borderColor='var(--teal-dim)';_ufAcFilter(this)"
                           onblur="setTimeout(()=>_ufAcClose(this),150)">
                    <div class="uf-ac-dd"></div>
                </div>
            </td>
            <td style="padding:5px 8px;border-right:1px solid var(--border)">
                <input class="uf-sup-input" value="${escHtml(sup)}"
                       style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                              background:var(--surface);color:var(--text);font-size:12px;outline:none"
                       onfocus="this.style.borderColor='var(--teal-dim)'"
                       onblur="this.style.borderColor='var(--border2)'">
            </td>
            <td style="padding:5px 8px;border-right:1px solid var(--border)">
                <input class="uf-conc-input" type="number" step="any" min="0" value="${escHtml(concPct)}"
                       placeholder="% e.g. 5.5"
                       style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                              background:var(--surface);color:var(--teal);font-size:12px;font-family:var(--font-mono);
                              text-align:right;outline:none"
                       onfocus="this.style.borderColor='var(--teal-dim)'"
                       onblur="this.style.borderColor='var(--border2)'">
            </td>
            <td style="padding:5px 8px;border-right:1px solid var(--border)">
                <input class="uf-qty-input" type="number" step="any" min="0" value="${escHtml(qty)}"
                       placeholder="KG"
                       style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                              background:var(--surface);color:var(--text);font-size:12px;font-family:var(--font-mono);
                              text-align:right;outline:none"
                       onfocus="this.style.borderColor='var(--teal-dim)'"
                       onblur="this.style.borderColor='var(--border2)'">
            </td>
            <td style="padding:5px 8px;text-align:center">
                <button onclick="ufRemoveRow(${i})" title="Remove row"
                        style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border2);
                               background:transparent;color:var(--muted);cursor:pointer;font-size:13px;
                               display:inline-flex;align-items:center;justify-content:center;line-height:1"
                        onmouseover="this.style.color='var(--red-text)';this.style.borderColor='var(--red-text)'"
                        onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border2)'">✕</button>
            </td>
        </tr>`;
    }).join('');
    _ufUpdateRowCount();
}

function ufRemoveRow(idx){
    document.getElementById('ufRow_'+idx)?.remove();
    _ufUpdateRowCount();
    _ufReindexRows();
}

function ufAddRow(){
    const bn = document.getElementById('ufBatchSelect').value;
    if(!bn){ toast('Select a batch first','warning'); return; }
    const tbody = document.getElementById('ufEditTbody');
    // Remove "select batch" placeholder if present
    if(tbody.querySelector('td[colspan="6"]')){
        tbody.innerHTML='';
        document.getElementById('ufSaveInlineBtn').disabled = false;
        document.getElementById('ufSaveInlineBtn').style.opacity = '1';
        document.getElementById('ufSaveInlineBtn').style.cursor  = 'pointer';
    }
    const i = tbody.querySelectorAll('tr').length;
    const tr = document.createElement('tr');
    tr.id = 'ufRow_'+i;
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML = `
        <td style="padding:7px 10px;color:var(--muted);font-size:10px;font-family:var(--font-mono);border-right:1px solid var(--border);text-align:center">${i+1}</td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <div class="uf-ac-wrap">
                <input class="uf-mat-input" placeholder="Type to search material…" autocomplete="off"
                       style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                              background:var(--surface);color:var(--text);font-size:12px;outline:none"
                       oninput="_ufAcFilter(this)"
                       onkeydown="_ufAcKeydown(event,this)"
                       onfocus="this.style.borderColor='var(--teal-dim)';_ufAcFilter(this)"
                       onblur="setTimeout(()=>_ufAcClose(this),150)">
                <div class="uf-ac-dd"></div>
            </div>
        </td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <input class="uf-sup-input" placeholder="Supplier"
                   style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                          background:var(--surface);color:var(--text);font-size:12px;outline:none"
                   onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        </td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <input class="uf-conc-input" type="number" step="any" min="0" placeholder="% e.g. 5.5"
                   style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                          background:var(--surface);color:var(--teal);font-size:12px;font-family:var(--font-mono);
                          text-align:right;outline:none"
                   onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        </td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <input class="uf-qty-input" type="number" step="any" min="0" placeholder="KG"
                   style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);
                          background:var(--surface);color:var(--text);font-size:12px;font-family:var(--font-mono);
                          text-align:right;outline:none"
                   onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        </td>
        <td style="padding:5px 8px;text-align:center">
            <button onclick="ufRemoveRow(${i})" title="Remove"
                    style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border2);
                           background:transparent;color:var(--muted);cursor:pointer;font-size:13px;
                           display:inline-flex;align-items:center;justify-content:center"
                    onmouseover="this.style.color='var(--red-text)';this.style.borderColor='var(--red-text)'"
                    onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border2)'">✕</button>
        </td>`;
    tbody.appendChild(tr);
    tr.querySelector('.uf-mat-input')?.focus();
    _ufUpdateRowCount();
}

function _ufReindexRows(){
    document.querySelectorAll('#ufEditTbody tr').forEach((tr,i)=>{
        tr.id='ufRow_'+i;
        const numTd=tr.querySelector('td:first-child');
        if(numTd) numTd.textContent=i+1;
        const delBtn=tr.querySelector('button[onclick^="ufRemoveRow"]');
        if(delBtn) delBtn.setAttribute('onclick','ufRemoveRow('+i+')');
    });
}

function _ufUpdateRowCount(){
    const n = document.querySelectorAll('#ufEditTbody tr[id^="ufRow"]').length;
    document.getElementById('ufRowCount').textContent = n+' ingredient'+(n!==1?'s':'');
}

async function ufSaveInline(){
    const bn = document.getElementById('ufBatchSelect').value;
    if(!bn){ toast('Select a batch first','warning'); return; }
    const trs = [...document.querySelectorAll('#ufEditTbody tr[id^="ufRow"]')];
    const rows = [];
    for(const tr of trs){
        const mat  = tr.querySelector('.uf-mat-input')?.value.trim()||'';
        if(!mat) continue;
        const sup  = tr.querySelector('.uf-sup-input')?.value.trim()||'';
        const conc = tr.querySelector('.uf-conc-input')?.value.trim();
        const qty  = tr.querySelector('.uf-qty-input')?.value.trim();
        // concentration stored as decimal (0-1), user entered as %
        const concDec = conc ? (parseFloat(conc)/100).toFixed(8).replace(/\.?0+$/,'') : '';
        rows.push({ material_name:mat, supplier_name:sup||null,
                    concentration:concDec||null, qty_kg:qty||null });
    }
    if(!rows.length){ toast('Add at least one ingredient row','warning'); return; }
    const btn = document.getElementById('ufSaveInlineBtn');
    btn.disabled=true; btn.textContent='Saving…';
    try{
        const res = await fetch('/api/procurement/formulations/update_rows',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({batch_name:bn, rows})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        closeUpdateFvqModal();
        toast(`Updated "${bn}" — ${data.imported} ingredient${data.imported!==1?'s':''}`, 'success');
        // Log the change
        fetch('/api/procurement/formulations/log_change',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({batch_name:bn,change_type:'update',
                ingredients_after:rows.map(r=>({material_name:r.material_name,concentration:r.concentration}))})
        }).catch(()=>{});
        await loadFvqData();
        // If this batch has linked children, show propagation dialog
        if(data.linked_batches && data.linked_batches.length > 0){
            _showPropagateDialog(bn, data.linked_batches, rows);
        }
    }catch(err){
        toast('Save failed: '+err.message,'error');
        btn.disabled=false; btn.textContent='Save Changes';
    }
}

/* ══════════════════════════════════════════════════════════
   EXCEL UPLOAD FLOW
══════════════════════════════════════════════════════════ */
async function ufHandleFile(file){
    if(!file) return;
    if(!file.name.toLowerCase().endsWith('.xlsx')){ toast('Please select a .xlsx file','error'); return; }
    _ufBasename = file.name.replace(/\.xlsx$/i,'');
    document.getElementById('ufFileStatus').textContent = 'Uploading…';
    document.getElementById('ufSheetPickerWrap').style.display = 'none';
    _ufCheckExcelReady();
    const fd = new FormData(); fd.append('file', file);
    try{
        const res  = await fetch('/api/procurement/formulations/inspect',{method:'POST',body:fd});
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _ufFileSheets = data.sheets||[];
        document.getElementById('ufFileStatus').textContent =
            `✅ ${file.name} · ${_ufFileSheets.length} sheet${_ufFileSheets.length!==1?'s':''} found`;
        // Populate sheet selector
        const sel = document.getElementById('ufSheetSelect');
        sel.innerHTML = _ufFileSheets.map(s=>`<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        comboboxRefresh(sel);
        document.getElementById('ufSheetPickerWrap').style.display = 'block';
    }catch(err){
        document.getElementById('ufFileStatus').textContent = '❌ '+err.message;
        _ufFileSheets=[];
        document.getElementById('ufSheetPickerWrap').style.display = 'none';
    }
    _ufCheckExcelReady();
}

function _ufCheckExcelReady(){
    const hasBatch  = !!document.getElementById('ufExcelBatchSelect')?.value;
    const hasSheets = _ufFileSheets.length > 0;
    const btn = document.getElementById('ufSaveExcelBtn');
    if(!btn) return;
    const ready = hasBatch && hasSheets;
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '.45';
    btn.style.cursor  = ready ? 'pointer' : 'not-allowed';
}

// Excel batch select is now a hidden input — change triggered via ufBatchAcSelect()

async function ufSaveExcel(){
    const bn    = document.getElementById('ufExcelBatchSelect').value;
    const sheet = document.getElementById('ufSheetSelect').value;
    if(!bn)    { toast('Select a target batch','warning'); return; }
    if(!sheet) { toast('Select a worksheet','warning'); return; }
    const btn = document.getElementById('ufSaveExcelBtn');
    btn.disabled=true; btn.textContent='Updating…';
    try{
        // Use the existing import route with the selected sheet
        // The import route does ON DUPLICATE KEY UPDATE, so same batch_name
        // will overwrite existing ingredient rows
        const res = await fetch('/api/procurement/formulations/import',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                basename: _ufBasename,
                sheets:   [{sheet, batch_name: bn}]
            })
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        closeUpdateFvqModal();
        toast(`Updated "${bn}" from sheet "${sheet}" — ${data.total_imported} row${data.total_imported!==1?'s':''}`, 'success');
        await loadFvqData();
    }catch(err){
        toast('Update failed: '+err.message,'error');
        btn.disabled=false; btn.textContent='Update Formulation';
    }
}


/* ═══════════════════════════════════════════════════════
   TOOLBAR DROPDOWN TOGGLES
═══════════════════════════════════════════════════════ */
function toggleProcureMenu(){
    const m=document.getElementById('procureMenu');
    if(!m) return;
    const open=m.style.display!=='none';
    m.style.display=open?'none':'block';
    if(!open) setTimeout(()=>document.addEventListener('click',_closeProcureMenu,{once:true}),10);
}
function _closeProcureMenu(){ const m=document.getElementById('procureMenu'); if(m) m.style.display='none'; }

function toggleReportsMenu(){
    const m=document.getElementById('reportsMenu');
    if(!m) return;
    const open=m.style.display!=='none';
    m.style.display=open?'none':'block';
    if(!open) setTimeout(()=>document.addEventListener('click',_closeReportsMenu,{once:true}),10);
}
function _closeReportsMenu(){ const m=document.getElementById('reportsMenu'); if(m) m.style.display='none'; }

