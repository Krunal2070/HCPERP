/* materials.js — Material Master: table, edit modal, import/export
   Depends on: utils.js, app.js */

/* ═══════════════════════ TABLE BUILD ═══════════════════════ */
function cellVal(v,cls='td-mono'){
    if(v===null||v===undefined||v==='')return`<td><span class="td-dim">—</span></td>`;
    return`<td class="${cls}">${escHtml(v)}</td>`;
}
function buildRows(rows){
    if(!rows||!rows.length){
        return`<tr><td colspan="15"><div class="state-box">
            <div class="state-icon">📋</div>
            <h3>No materials found</h3>
            <p>Try clearing your search, or add your first material.</p>
        </div></td></tr>`;
    }
    return rows.map(r=>`
        <tr data-mat='${escHtml(JSON.stringify(r))}' ondblclick="openEditFromRow(this)">
            <td style="padding:8px 6px;text-align:center;border-right:1px solid var(--border)">
                <input type="checkbox" class="mat-row-cb" data-mat="${escHtml(r.material_name)}"
                    onclick="event.stopPropagation();_matRowClick(this)"
                    ${_selectedMats.has(r.material_name)?'checked':''}
                    style="cursor:pointer;width:14px;height:14px;accent-color:var(--teal)">
            </td>
            <td>${r.sr_no}</td>
            <td class="td-name">${escHtml(r.material_name)}${r.description?`<br><span style="font-size:10px;font-style:italic;color:var(--muted);font-weight:400">${escHtml(r.description)}</span>`:''}</td>
            <td>${r.group_name?`<span style="padding:2px 8px;border-radius:10px;background:var(--text-05);font-size:10px;color:var(--teal);font-weight:600;white-space:nowrap">${escHtml(r.group_name)}</span>`:'<span class="td-dim">—</span>'}</td>
            <td>${stockBadge(r.in_stock_qty)}</td>
            ${cellVal(r.ordered_qty!==null?fmtNum(r.ordered_qty):null)}
            ${r.required_qty!=null?`<td class="td-mono" style="color:var(--amber-text);font-weight:600">${fmtNum(r.required_qty,3)}</td>`:`<td><span class="td-dim">—</span></td>`}
            ${(()=>{
                // Compute live: In Stock + Ordered - Required
                const stk = parseFloat(r.in_stock_qty)||0;
                const ord = parseFloat(r.ordered_qty)||0;
                const req = parseFloat(r.required_qty)||0;
                if(r.in_stock_qty==null && r.ordered_qty==null && r.required_qty==null)
                    return `<td><span class="td-dim">—</span></td>`;
                const buf = stk + ord - req;
                const col = buf < 0 ? 'var(--red-text)' : buf === 0 ? 'var(--amber-text)' : 'var(--green-text)';
                const sign = buf > 0 ? '+' : '';
                return `<td class="td-mono" style="color:${col};font-weight:600">${sign}${fmtNum(buf,3)}</td>`;
            })()}
            ${cellVal(r.supplier_name,'td-name')}
            ${cellVal(r.last_purchase_rate!==null?fmtNum(r.last_purchase_rate,4):null)}
            ${cellVal(r.gst_rate!=null&&r.gst_rate!==''?r.gst_rate+'%':null)}
            ${cellVal(r.std_pack_size)}
            ${cellVal(r.msl!==null?fmtNum(r.msl):null)}
            ${cellVal(r.lead_time_days!==null?r.lead_time_days+' d':null)}
            <td><button class="row-edit-btn" title="Edit" onclick="openEditFromRow(this.closest('tr'));event.stopPropagation()">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button></td>
        </tr>`).join('');
}
function openEditFromRow(tr){
    try{ openEditModal(JSON.parse(tr.getAttribute('data-mat'))); }catch(e){}
}

/* ═══════════════════════ PAGINATION ═══════════════════════ */
function getTotalPages(){
    if(_pageSize===0)return 1;
    return Math.max(1,Math.ceil(_filteredRows.length/_pageSize));
}
function getPageRows(){
    if(_pageSize===0)return _filteredRows;
    const start=(_currentPage-1)*_pageSize;
    return _filteredRows.slice(start,start+_pageSize);
}
function renderPagination(){
    const total=_filteredRows.length;
    const totalPages=getTotalPages();
    const start=_pageSize===0?1:(_currentPage-1)*_pageSize+1;
    const end=_pageSize===0?total:Math.min(_currentPage*_pageSize,total);
    document.getElementById('pgInfo').textContent=
        total===0?'No rows':`${start}–${end} of ${total} rows`;

    const wrap=document.getElementById('pgButtons');
    if(totalPages<=1){wrap.innerHTML='';return;}

    let html='';
    // prev
    html+=`<button class="pg-btn" onclick="goPage(${_currentPage-1})" ${_currentPage===1?'disabled':''} title="Previous page (PageUp)">‹</button>`;
    // page numbers — show max 7 buttons
    const pages=[];
    if(totalPages<=7){
        for(let i=1;i<=totalPages;i++)pages.push(i);
    } else {
        pages.push(1);
        if(_currentPage>3)pages.push('…');
        for(let i=Math.max(2,_currentPage-1);i<=Math.min(totalPages-1,_currentPage+1);i++)pages.push(i);
        if(_currentPage<totalPages-2)pages.push('…');
        pages.push(totalPages);
    }
    pages.forEach(p=>{
        if(p==='…'){html+=`<span style="padding:0 4px;color:var(--muted);font-size:12px">…</span>`;return;}
        html+=`<button class="pg-page-btn ${p===_currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
    });
    // next
    html+=`<button class="pg-btn" onclick="goPage(${_currentPage+1})" ${_currentPage===totalPages?'disabled':''} title="Next page (PageDown)">›</button>`;
    wrap.innerHTML=html;
}
function goPage(p){
    const total=getTotalPages();
    _currentPage=Math.max(1,Math.min(p,total));
    renderTable();
}
function onPageSizeChange(){
    _pageSize=parseInt(document.getElementById('pgSizeSelect').value);
    _currentPage=1;
    renderTable();
}
function renderTable(){
    const pageRows=getPageRows();
    document.getElementById('procTbody').innerHTML=buildRows(pageRows);
    renderPagination();
    document.getElementById('rowCountBadge').textContent=
        _filteredRows.length+' / '+_allRows.length+' rows';
    _focusedIdx=-1;
    _syncSelectAllCheckbox();
    matUpdateDeleteBtn();
}

/* ═══════════════════════ FILTER ═══════════════════════ */
function setFilter(f){
    _activeFilter=f;
    document.querySelectorAll('.filter-pill').forEach(p=>p.classList.remove('active'));
    // Map filter key → element id
    var idMap = {all:'fAll',good:'fGood',low:'fLow',zero:'fZero',req_nonzero:'fReqNonZero',req_zero:'fReqZero'};
    var btn = document.getElementById(idMap[f] || ('f'+f[0].toUpperCase()+f.slice(1)));
    if(btn) btn.classList.add('active');
    applyFilters();
    if(typeof _updateFilterDot==='function') _updateFilterDot();
    if(typeof fmSyncStock==='function') fmSyncStock();
}

/* ═══════════════════════════════════════════════════════
   COLUMN FILTERS — type-and-select autocomplete
   Two filter types:
     supplier — autocomplete from _allRows supplier names
     buffer   — fixed options: All / +ve / -ve / Not set
═══════════════════════════════════════════════════════ */

// Hidden value holders (actual filter values, not display text)
let _colFilterValues = { supplier: '', buffer: '', group: '', gst: '' };
let _colAcIdx        = { supplier: -1, buffer: -1, group: -1 };

/* ── Cross-page virtual selection ── */
let _selectedMats = new Set(); // Set<material_name>

const _bufferOptions = [
    { label: 'All',       value: '',         hint: 'Show all' },
    { label: '▲ +ve',     value: 'positive', hint: 'Buffer > 0' },
    { label: '▼ −ve',     value: 'negative', hint: 'Buffer < 0' },
    { label: '— Not set', value: 'none',     hint: 'No buffer entered' },
];

/* ── Open dropdown ────────────────────────────────────── */
function colAcOpen(type){
    if(type==='buffer'){
        _renderColDd('buffer', _bufferOptions.map(o=>({
            display: o.label, value: o.value, sub: o.hint
        })));
    } else if(type==='group'){
        const items = [
            { display:'All Groups',    value:'',        sub:'Clear filter' },
            { display:'— Ungrouped —', value:'__none__',sub:'No group assigned' },
            ..._matGroups.map(g=>({ display:g.group_name, value:String(g.id), sub:g.mat_count?`${g.mat_count} materials`:'' }))
        ];
        _renderColDd('group', items);
    } else {
        colAcFilter('supplier');
    }
}

/* ── Filter supplier list as user types ──────────────── */
function colAcFilter(type){
    const inp = document.getElementById('colFilterSupplier');
    const q   = (inp?.value||'').trim().toLowerCase();
    const suppliers = [...new Set(
        (_allRows||[]).map(r=>r.supplier_name).filter(Boolean).sort()
    )];
    const matches = q
        ? suppliers.filter(s=>s.toLowerCase().includes(q))
        : suppliers;
    const items = [
        { display:'All Suppliers', value:'', sub:'Clear filter' },
        ...matches.map(s=>({ display:s, value:s, sub:'' }))
    ].slice(0,20);
    _renderColDd('supplier', items);
    // Don't apply filter while typing — wait for selection
}

/* ── Render dropdown ──────────────────────────────────── */
function _renderColDd(type, items){
    const dd = document.getElementById('colAcDd_'+type);
    const inp = document.getElementById(type==='supplier'?'colFilterSupplier':type==='group'?'colFilterGroup':'colFilterBuffer');
    if(!dd||!inp) return;
    if(!items.length){
        dd.innerHTML='<div style="padding:9px 12px;color:var(--muted);font-size:11px">No matches</div>';
        dd.classList.add('open');
    } else {
        dd.innerHTML = items.map((item,i)=>`
            <div class="col-ac-item${i===_colAcIdx[type]?' col-focused':''}"
                 data-val="${escHtml(item.value)}"
                 onmousedown="_colAcSelect(event,'${type}','${escHtml(item.value).replace(/'/g,"\\'")}','${escHtml(item.display).replace(/'/g,"\\'")}')">
                <span>${escHtml(item.display)}</span>
                ${item.sub?`<span style="font-size:9.5px;color:var(--muted);margin-left:auto">${escHtml(item.sub)}</span>`:''}
            </div>`).join('');
        dd.classList.add('open');
    }
    // Position dropdown below the input cell
    const rect = inp.getBoundingClientRect();
    dd.style.left  = rect.left + 'px';
    dd.style.top   = (rect.bottom + 2) + 'px';
    dd.style.width = Math.max(rect.width, 180) + 'px';
    _colAcIdx[type] = -1;
}

/* ── Select an item ───────────────────────────────────── */
function _colAcSelect(e, type, value, display){
    if(e) e.preventDefault();
    _colFilterValues[type] = value;
    const inp = document.getElementById(type==='supplier'?'colFilterSupplier':'colFilterBuffer');
    if(inp) inp.value = value ? display : '';
    if(inp && !value) inp.style.borderColor = '';
    else if(inp) inp.style.borderColor = 'var(--teal-dim)';
    colAcClose(type);
    applyFilters();
}

/* ── Close dropdown ───────────────────────────────────── */
function colAcClose(type){
    const dd = document.getElementById('colAcDd_'+type);
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _colAcIdx[type] = -1;
}

/* ── Keyboard nav (↑↓ Enter Esc) ─────────────────────── */
function colFilterKeydown(e, type){
    if(type==='colFilterMaterial'){
        if(e.key==='Escape'){ document.getElementById('colFilterMaterial').value=''; applyFilters(); }
        return;
    }
    const dd    = document.getElementById('colAcDd_'+type);
    const items = [...(dd?.querySelectorAll('.col-ac-item')||[])];
    if(!dd?.classList.contains('open')){
        if(e.key==='ArrowDown'||e.key==='Enter'){ e.preventDefault(); colAcOpen(type); }
        if(e.key==='Escape') _colAcSelect(null, type, '', '');
        return;
    }
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _colAcIdx[type] = Math.min(_colAcIdx[type]+1, items.length-1);
        items.forEach((el,i)=>el.classList.toggle('col-focused',i===_colAcIdx[type]));
        items[_colAcIdx[type]]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _colAcIdx[type] = Math.max(_colAcIdx[type]-1, 0);
        items.forEach((el,i)=>el.classList.toggle('col-focused',i===_colAcIdx[type]));
        items[_colAcIdx[type]]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='Enter'||e.key==='Tab'){
        if(_colAcIdx[type]>=0 && items[_colAcIdx[type]]){
            e.preventDefault();
            const item = items[_colAcIdx[type]];
            _colAcSelect(null, type, item.dataset.val,
                         item.querySelector('span')?.textContent||'');
        } else { colAcClose(type); }
    } else if(e.key==='Escape'){
        _colAcSelect(null, type, '', '');
    }
}

/* Close all col dropdowns on outside click */
document.addEventListener('click', e=>{
    if(!e.target.closest('.col-ac-wrap')){
        colAcClose('supplier');
        colAcClose('buffer');
        colAcClose('group');
    }
});

function _matchesMat(r, term){
    if((r.material_name||'').toLowerCase().includes(term)) return true;
    if(r.aliases) return r.aliases.toLowerCase().split(',').some(function(a){ return a.trim().includes(term); });
    return false;
}

function applyFilters(){
    const q         = (document.getElementById('searchInput').value||'').trim().toLowerCase();
    const colMat    = (document.getElementById('colFilterMaterial')?.value||'').trim().toLowerCase();
    const supplier  = (_colFilterValues.supplier||'').trim().toLowerCase();
    const bufFilter = _colFilterValues.buffer||'';
    const groupFilter = _colFilterValues.group||'';
    let rows = _allRows;

    if(q)      rows = rows.filter(r=>_matchesMat(r,q));
    if(colMat) rows = rows.filter(r=>_matchesMat(r,colMat));

    if(_activeFilter==='req_nonzero')
        rows = rows.filter(r=>r.required_qty!=null && parseFloat(r.required_qty)>0);
    else if(_activeFilter==='req_zero')
        rows = rows.filter(r=>r.required_qty==null || parseFloat(r.required_qty)===0 || isNaN(parseFloat(r.required_qty)));
    else if(_activeFilter!=='all')
        rows = rows.filter(r=>getQtyStatus(r.in_stock_qty)===_activeFilter);

    if(bufFilter==='positive')
        rows = rows.filter(r=>r.buffer_qty!=null && parseFloat(r.buffer_qty) > 0);
    else if(bufFilter==='negative')
        rows = rows.filter(r=>r.buffer_qty!=null && parseFloat(r.buffer_qty) < 0);
    else if(bufFilter==='none')
        rows = rows.filter(r=>r.buffer_qty==null || r.buffer_qty==='' || r.buffer_qty===0);

    if(supplier) rows = rows.filter(r=>(r.supplier_name||'').toLowerCase().includes(supplier));

    if(groupFilter==='__none__')
        rows = rows.filter(r=>!r.group_id);
    else if(groupFilter)
        rows = rows.filter(r=>String(r.group_id||'')===groupFilter);

    const gstFilter = _colFilterValues.gst||'';
    if(gstFilter==='__none__')
        rows = rows.filter(r=>r.gst_rate==null || r.gst_rate==='');
    else if(gstFilter!=='')
        rows = rows.filter(r=>String(parseFloat(r.gst_rate||'x'))===gstFilter || String(r.gst_rate)===gstFilter);

    _filteredRows = rows;
    _currentPage  = 1;
    renderTable();
}

/* ═══════════════════════ SEARCH + KB NAV ═══════════════════════ */
function onSearchInput(){ applyFilters(); buildDropdown(); }
function buildDropdown(){
    const q=(document.getElementById('searchInput').value||'').trim().toLowerCase();
    const dd=document.getElementById('searchDropdown');
    if(!q){dd.innerHTML='';dd.classList.remove('open');return;}
    const matches=_allRows.filter(r=>_matchesMat(r,q)).slice(0,10);
    if(!matches.length){dd.innerHTML='';dd.classList.remove('open');return;}
    dd.innerHTML=matches.map(r=>{
        // Show which alias matched (if match isn't in material_name itself)
        let aliasTip = '';
        if(r.aliases && !(r.material_name||'').toLowerCase().includes(q)){
            const matched = r.aliases.split(',').find(a=>a.trim().toLowerCase().includes(q));
            if(matched) aliasTip = `<span style="font-size:9.5px;color:var(--teal);margin-left:6px;font-style:italic">aka: ${escHtml(matched.trim())}</span>`;
        }
        return `<div class="dd-item" data-mat='${escHtml(JSON.stringify(r))}' ondblclick="openEditFromRow(this)">
            <span class="dd-mat">${escHtml(r.material_name)}</span>${aliasTip}
            <span>${stockBadge(r.in_stock_qty)}</span>
        </div>`;
    }).join('');
    dd.classList.add('open'); _ddFocusIdx=-1;
}
function onSearchKeydown(e){
    const dd=document.getElementById('searchDropdown');
    const items=[...dd.querySelectorAll('.dd-item')];
    if(dd.classList.contains('open')&&items.length){
        if(e.key==='ArrowDown'){e.preventDefault();_ddFocusIdx=Math.min(_ddFocusIdx+1,items.length-1);hdd(items);return;}
        if(e.key==='ArrowUp'){e.preventDefault();_ddFocusIdx=Math.max(_ddFocusIdx-1,0);hdd(items);return;}
        if(e.key==='Enter'&&_ddFocusIdx>=0){
            e.preventDefault();
            try{openEditModal(JSON.parse(items[_ddFocusIdx].getAttribute('data-mat')));}catch(ex){}
            closeDropdown();return;
        }
    } else {
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();navRows(e.key==='ArrowDown'?1:-1);return;}
        if(e.key==='Enter'&&_focusedIdx>=0&&getPageRows()[_focusedIdx]){
            e.preventDefault();openEditModal(getPageRows()[_focusedIdx]);return;
        }
    }
    if(e.key==='Escape')closeDropdown();
}
function hdd(items){ items.forEach((el,i)=>el.classList.toggle('focused',i===_ddFocusIdx)); items[_ddFocusIdx]?.scrollIntoView({block:'nearest'}); }
function navRows(dir){
    const rows=[...document.querySelectorAll('#procTbody tr[data-mat]')];
    if(!rows.length)return;
    _focusedIdx=Math.max(0,Math.min(_focusedIdx+dir,rows.length-1));
    rows.forEach((tr,i)=>tr.classList.toggle('row-selected',i===_focusedIdx));
    rows[_focusedIdx]?.scrollIntoView({block:'nearest'});
}
function closeDropdown(){ document.getElementById('searchDropdown').classList.remove('open'); _ddFocusIdx=-1; }
document.addEventListener('click',e=>{ if(!document.getElementById('searchInput').closest('.search-shell').contains(e.target))closeDropdown(); });

/* ═══════════════════════ GLOBAL SHORTCUTS ═══════════════════════ */
document.addEventListener('keydown',e=>{
    // Don't fire when typing in an input/textarea
    const tag=document.activeElement?.tagName;
    const inInput=(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT');

    if(e.ctrlKey){
        switch(e.key.toLowerCase()){
            // Ctrl+, — Settings (browser doesn't intercept this)
            case ',': e.preventDefault(); openSettings(); return;
        }
    }
    // Alt shortcuts for material master (avoids browser Ctrl conflicts)
    if(e.altKey && !inInput){
        switch(e.key.toLowerCase()){
            case 'f': e.preventDefault(); focusSearch(); return;
            case 'n': e.preventDefault(); if(!document.querySelector('.modal-overlay.open'))openEditModal(null); return;
            case 'e': e.preventDefault(); doExport(); return;
            case 'i': e.preventDefault(); openImportModal(); return;
            case 'r': e.preventDefault(); loadData(); return;
            case 'd': e.preventDefault(); cycleTheme(); return;
        }
    }
    if(e.altKey){
        const fvqActive=document.getElementById('tc-fvq')?.classList.contains('active');
        if(e.key==='1'){e.preventDefault();switchTab('mqsd');return;}
        if(e.key==='2'){e.preventDefault();switchTab('fvq');return;}
        if(e.key.toLowerCase()==='f'){
            e.preventDefault();
            if(fvqActive){
                const si=document.getElementById('fvqSearchInput');
                si?.focus(); si?.select();
            } else {
                openFvqImport();
            }
            return;
        }
        if(e.key.toLowerCase()==='a'&&fvqActive){e.preventDefault();openFvqProcureToolbar('add');return;}
        if(e.key.toLowerCase()==='d'&&fvqActive){e.preventDefault();openFvqProcureToolbar('deduct');return;}
        if(e.key.toLowerCase()==='l'&&fvqActive){e.preventDefault();toggleReportsMenu();return;}
        if(e.key.toLowerCase()==='r'&&fvqActive){e.preventDefault();loadFvqData();return;}
        if(e.key.toLowerCase()==='u'&&fvqActive){e.preventDefault();openUpdateFvqModal();return;}
    }
    // Del key — delete selected batches when FVQ tab active and no modal open
    if(e.key==='Delete'&&!inInput&&!document.querySelector('.modal-overlay.open')){
        const fvqActive=document.getElementById('tc-fvq')?.classList.contains('active');
        if(fvqActive){ e.preventDefault(); deleteSelectedFvq(); return; }
    }
    if(!inInput){
        if(e.key==='PageDown'){e.preventDefault();goPage(_currentPage+1);return;}
        if(e.key==='PageUp'){e.preventDefault();goPage(_currentPage-1);return;}
    }
    if(e.key==='Escape'){ closeDropdown();closeCfDiff();closeCorrectFvqModal();closeUsedIn();closeEditModal();closeImportModal();closeSettings();closeFvqDetail();closeFvqSheetModal();closeLinkedReport();closeCostPerKgReport();closeChangeLog();closeCostImpact();closeCostImpactWhatIf();closeFvqProcureModal();closeFvqRadial();closeUpdateLog();closeUpdateFvqModal();closeLinkFvqModal();closeRMRequirement();closePossibleBatch();closeAdminReset();closePoModal();closePONumSettings();closeSupModal();closeSupImportModal();if(typeof closeGodownModal==='function')closeGodownModal();closeTCManager();if(typeof closeDeclManager==='function')closeDeclManager();if(typeof closeBulkAssignGroup==='function')closeBulkAssignGroup();if(typeof closeGroupsManager==='function')closeGroupsManager();if(typeof closeBulkAssignGst==='function')closeBulkAssignGst();closeFilterMenu(); }
});
function focusSearch(){ const i=document.getElementById('searchInput');i.focus();i.select(); }

/* ═══════════════════════ LOAD DATA ═══════════════════════ */

/* ═══════════════════════════════════════════════════════
   TAB 1 — MATERIAL CHECKBOXES + DELETE
═══════════════════════════════════════════════════════ */
function matToggleSelectAll(cb){
    if(cb.checked){ _filteredRows.forEach(r=>_selectedMats.add(r.material_name)); }
    else           { _filteredRows.forEach(r=>_selectedMats.delete(r.material_name)); }
    document.querySelectorAll('.mat-row-cb').forEach(el=>{ el.checked=_selectedMats.has(el.dataset.mat); });
    matUpdateDeleteBtn();
}

function _matRowClick(el){
    if(el.checked) _selectedMats.add(el.dataset.mat);
    else           _selectedMats.delete(el.dataset.mat);
    _syncSelectAllCheckbox(); matUpdateDeleteBtn();
}

function _syncSelectAllCheckbox(){
    const allCb=document.getElementById('matSelectAll'); if(!allCb)return;
    const filteredNames=new Set(_filteredRows.map(r=>r.material_name));
    const n=[...filteredNames].filter(x=>_selectedMats.has(x)).length;
    if(n===0){allCb.checked=false;allCb.indeterminate=false;}
    else if(n===filteredNames.size){allCb.checked=true;allCb.indeterminate=false;}
    else{allCb.checked=false;allCb.indeterminate=true;}
}

function matUpdateDeleteBtn(){
    const count=_selectedMats.size;
    const bar=document.getElementById('matSelectionBar');
    if(bar) bar.style.display=count>0?'flex':'none';
    const lbl=document.getElementById('matSelCountLabel');
    if(lbl) lbl.textContent=count>0?`${count} selected${count>getPageRows().length?' (across all pages)':''}`:'0 selected';
    const btn=document.getElementById('matDeleteSelBtn');
    if(btn){btn.disabled=count===0;btn.style.opacity=count>0?'1':'.4';btn.style.cursor=count>0?'pointer':'not-allowed';}
    const grpBtn=document.getElementById('matAssignGroupBtn');
    if(grpBtn){grpBtn.disabled=count===0;grpBtn.style.opacity=count>0?'1':'.4';grpBtn.style.cursor=count>0?'pointer':'not-allowed';}
    const gstBtn=document.getElementById('matAssignGstBtn');
    if(gstBtn){gstBtn.disabled=count===0;gstBtn.style.opacity=count>0?'1':'.4';gstBtn.style.cursor=count>0?'pointer':'not-allowed';}
    const poBtn=document.getElementById('matCreatePoBtn');
    if(poBtn){
        if(!count){poBtn.disabled=true;poBtn.style.opacity='.4';poBtn.style.cursor='not-allowed';poBtn.title='Select materials to create a PO (must be same supplier)';}
        else{
            const suppliers=[..._selectedMats].map(name=>(_allRows.find(x=>x.material_name===name)?.supplier_name||''));
            const unique=[...new Set(suppliers.filter(Boolean))];
            if(unique.length===1){poBtn.disabled=false;poBtn.style.opacity='1';poBtn.style.cursor='pointer';poBtn.title=`Create PO for ${count} item(s) — ${unique[0]}`;}
            else{poBtn.disabled=true;poBtn.style.opacity='.4';poBtn.style.cursor='not-allowed';poBtn.title=unique.length===0?'No supplier set on selection':'Different suppliers selected — must be same';}
        }
    }
}

// Wire up change event via delegation on procTbody
document.getElementById('procTbody').addEventListener('change', e=>{
    if(e.target.classList.contains('mat-row-cb')){
        if(e.target.checked) _selectedMats.add(e.target.dataset.mat);
        else                 _selectedMats.delete(e.target.dataset.mat);
        _syncSelectAllCheckbox(); matUpdateDeleteBtn();
    }
});

async function deleteSelectedMaterials(){
    const sel = [..._selectedMats];
    if(!sel.length){ toast('Select at least one material to delete','warning'); return; }
    const msg = sel.length===1
        ? `Delete material:\n"${sel[0]}"?\n\nThis cannot be undone.`
        : `Delete ${sel.length} selected materials?\n\nMaterials used in any formulation will be skipped.\nThis cannot be undone.`;
    if(!confirm(msg)) return;
    try{
        const res  = await fetch('/api/procurement/delete_materials',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({material_names: sel})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const deleted = data.deleted||[];
        const blocked = data.blocked||[];
        if(deleted.length > 0)
            toast(`Deleted ${deleted.length} material${deleted.length>1?'s':''}`, 'success');
        if(blocked.length > 0){
            const names = blocked.map(b=>`"${b.material_name}" (${b.batch_count} formulation${b.batch_count>1?'s':''})`).join('\n');
            toast(`${blocked.length} material${blocked.length>1?'s':''} skipped — in use:\n${names}`, 'warning', 7000);
        }
        deleted.forEach(n=>_selectedMats.delete(n));
        await loadData();
    }catch(err){ toast('Delete failed: '+err.message,'error'); }
}

async function loadData(){
    document.getElementById('procTbody').innerHTML=`<tr><td colspan="15"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>`;
    const dot=document.getElementById('refreshDot');
    dot.style.background='var(--amber)';
    document.getElementById('lastUpdatedTag').textContent='Refreshing…';
    try{
        const res=await fetch('/api/procurement/stock_summary');
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message||'Server error');
        _allRows=data.rows||[];
        updateStats(_allRows);
        // Show formulation count immediately (lazy load fills it precisely later)
        if(data.formulation_count !== undefined){
            const kpiF = document.getElementById('statFormulations');
            if(kpiF && kpiF.textContent === '–') kpiF.textContent = data.formulation_count;
        }
        // Supplier list is built dynamically in colAcFilter from _allRows
        applyFilters();
        dot.style.background='var(--green)';
        document.getElementById('lastUpdatedTag').textContent='Updated '+new Date().toLocaleTimeString('en-IN');
    }catch(err){
        _allRows=[];
        document.getElementById('procTbody').innerHTML=`<tr><td colspan="13"><div class="state-box"><div class="state-icon">⚠</div><h3>Failed to load</h3><p>${escHtml(err.message)}</p></div></td></tr>`;
        dot.style.background='var(--red)';
        document.getElementById('lastUpdatedTag').textContent='Error';
        updateStats([]);
    }
}

/* ═══════════════════════ EDIT / ADD MODAL ═══════════════════════ */

/* ═══════════════════════════════════════════════════════
   USED-IN PANEL — shows formulations using this material
   Uses _fvqDetail (already loaded) for instant results.
   Falls back to fetching if FVQ data not yet loaded.
═══════════════════════════════════════════════════════ */
async function openUsedInPanel(){
    const matName = document.getElementById('editMatKey').value;
    if(!matName) return;

    document.getElementById('usedInTitle').textContent = matName;
    document.getElementById('usedInSub').textContent = 'Loading…';
    document.getElementById('usedInTbody').innerHTML =
        '<tr><td colspan="6"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    document.getElementById('usedInModal').classList.add('open');

    // If _fvqDetail not yet loaded, fetch it first
    if(!_fvqDetail || _fvqDetail.length === 0){
        try{
            const res  = await fetch('/api/procurement/formulations/list');
            const data = await res.json();
            if(data.status==='ok'){
                _fvqBatches = data.batches||[];
                _fvqDetail  = data.detail ||[];
            }
        }catch(e){ /* proceed with empty, will show not-found */ }
    }

    document.getElementById('usedInSub').textContent = 'Formulations containing this material';

    // Search _fvqDetail (case-insensitive)
    const key = matName.trim().toLowerCase();
    const matchRows = (_fvqDetail||[]).filter(r=>
        (r.material_name||'').trim().toLowerCase() === key
    );

    // Group by batch to get one row per batch
    const batchMap = {};
    matchRows.forEach(r=>{
        if(!batchMap[r.batch_name]){
            const meta = (_fvqBatches||[]).find(b=>b.batch_name===r.batch_name)||{};
            batchMap[r.batch_name] = {
                batch_name:    r.batch_name,
                concentration: r.concentration,
                batch_size:    meta.batch_size || r.batch_size || null
            };
        }
    });
    const batches = Object.values(batchMap).sort((a,b)=>a.batch_name.localeCompare(b.batch_name));

    document.getElementById('usedInCount').textContent =
        `${batches.length} formulation${batches.length!==1?'s':''} use this material`;

    if(!batches.length){
        document.getElementById('usedInTbody').innerHTML =
            `<tr><td colspan="6"><div class="state-box">
                <div class="state-icon">🔍</div>
                <h3>Not used in any formulation</h3>
                <p>This material does not appear in any imported formulation.</p>
            </div></td></tr>`;
        return;
    }

    document.getElementById('usedInTbody').innerHTML = batches.map((b,i)=>{
        const conc_f   = b.concentration ? parseFloat(b.concentration) : null;
        const bs_str   = b.batch_size ? String(b.batch_size) : '';
        const bs_match = bs_str.match(/[\d.]+/);
        const bs_f     = bs_match ? parseFloat(bs_match[0]) : null;
        const totalQty = (conc_f!=null && bs_f!=null) ? conc_f * bs_f : null;

        const concPct   = conc_f!=null ? fmtNum(conc_f*100,4)+'%' : '<span class="td-dim">—</span>';
        const qtyPer1kg = conc_f!=null ? fmtNum(conc_f,4)+' KG'    : '<span class="td-dim">—</span>';
        const procSize  = bs_f!=null
            ? `<span style="color:var(--teal);font-weight:600">${fmtNum(bs_f,3)} KG</span>`
            : '<span class="td-dim">—</span>';
        const totalCell = totalQty!=null
            ? `<span style="color:var(--amber-text);font-weight:700">${fmtNum(totalQty,3)} KG</span>`
            : '<span class="td-dim">—</span>';

        return `<tr style="border-bottom:1px solid var(--border);cursor:pointer"
                    onmouseover="this.style.background='var(--text-05)'"
                    onmouseout="this.style.background=''"
                    ondblclick="closeUsedIn();closeEditModal();openFvqDetail('${escHtml(b.batch_name).replace(/'/g,"\\'")}')">
            <td style="padding:9px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${i+1}</td>
            <td style="padding:9px 14px;font-weight:600;color:var(--text);border-right:1px solid var(--border)">
                ${escHtml(b.batch_name)}
                <div style="font-size:9.5px;color:var(--muted);margin-top:1px">Double-click to view formulation</div>
            </td>
            <td style="padding:9px 14px;font-family:var(--font-mono);color:var(--teal);text-align:right;border-right:1px solid var(--border)">${concPct}</td>
            <td style="padding:9px 14px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border)">${qtyPer1kg}</td>
            <td style="padding:9px 14px;text-align:right;border-right:1px solid var(--border)">${procSize}</td>
            <td style="padding:9px 14px;text-align:right">${totalCell}</td>
        </tr>`;
    }).join('');

    // Grand total row
    const grandTotal = batches.reduce((sum, b)=>{
        const c = b.concentration ? parseFloat(b.concentration) : null;
        const bs_s = b.batch_size ? String(b.batch_size).match(/[\d.]+/) : null;
        const bs = bs_s ? parseFloat(bs_s[0]) : null;
        return (c!=null && bs!=null) ? sum + c*bs : sum;
    }, 0);
    const hasAnyTotal = batches.some(b=>{
        const c=b.concentration?parseFloat(b.concentration):null;
        const bs_s=b.batch_size?String(b.batch_size).match(/[\d.]+/):null;
        return c!=null && bs_s!=null;
    });
    if(hasAnyTotal){
        document.getElementById('usedInTbody').innerHTML +=
            `<tr style="background:var(--surface2);border-top:2px solid var(--border2);font-weight:700">
                <td colspan="2" style="padding:9px 14px;border-right:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.5px">
                    Total Required
                </td>
                <td style="border-right:1px solid var(--border)"></td>
                <td style="border-right:1px solid var(--border)"></td>
                <td style="border-right:1px solid var(--border)"></td>
                <td style="padding:9px 14px;text-align:right;font-family:var(--font-mono);color:var(--amber-text);font-size:13px">
                    ${fmtNum(grandTotal,3)} KG
                </td>
            </tr>`;
    }

    document.getElementById('usedInModal').classList.add('open');
}


/* ═══════════════════════════════════════════════════════
   USED-IN PANEL — WhatsApp message
   Summarises material usage across all formulations.
═══════════════════════════════════════════════════════ */
function usedInWhatsApp(){
    const matName = document.getElementById('usedInTitle').textContent;
    const rows    = [...document.querySelectorAll('#usedInTbody tr')].filter(tr=>
        !tr.style.background.includes('surface2')   // skip total row
    );
    if(!rows.length){ toast('No formulation data to share','warning'); return; }

    let msg = `*Material Usage Report*\n`;
    msg    += `Material : *${matName}*\n`;
    msg    += `────────────────────────\n`;

    rows.forEach((tr,i)=>{
        const cells = [...tr.querySelectorAll('td')];
        if(cells.length < 6) return;
        // batch name is a direct text node; the sub-div holds the "Double-click" hint
        const batchName  = (()=>{
            const td = cells[1];
            if(!td) return '';
            for(const node of td.childNodes){
                if(node.nodeType===3 && node.textContent.trim()) return node.textContent.trim();
            }
            return td.firstChild?.textContent?.trim() || td.textContent?.trim().split('\n')[0].trim() || '';
        })();
        const conc       = cells[2]?.textContent?.trim();
        const procSize   = cells[4]?.textContent?.trim();
        const totalQty   = cells[5]?.textContent?.trim();
        msg += `${i+1}. *${batchName}*\n`;
        msg += `   Conc: ${conc}`;
        if(procSize && procSize!=='—') msg += `  |  Proc: ${procSize}`;
        if(totalQty && totalQty!=='—') msg += `  |  *Needed: ${totalQty}*`;
        msg += `\n`;
    });

    // Grand total
    const totalRow = document.querySelector('#usedInTbody tr[style*="surface2"]');
    if(totalRow){
        const cells = [...totalRow.querySelectorAll('td')];
        const grand = cells[cells.length-1]?.textContent?.trim();
        if(grand && grand!=='—') msg += `────────────────────────\n*Total Required: ${grand}*\n`;
    }

    const encoded = encodeURIComponent(msg);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
}


/* ═══════════════════════════════════════════════════════
   CORRECT FORMULATION MODAL
   Two modes via radio buttons:
   1. Rename Materials — add From→To rules, preview, apply
   2. Missing Suppliers — materials in formulations with
      no supplier set in the procurement_materials table
═══════════════════════════════════════════════════════ */
let _cfRuleCount    = 0;
let _cfPreviewData  = [];    // results from last preview
let _cfMissingData  = [];    // missing supplier list

/* ── Open / close ─────────────────────────────────────── */
function openCorrectFvqModal(){
    // Reset to rename mode
    document.getElementById('cfModeRename').checked = true;
    cfSwitchMode('rename');
    // Add 2 default rename rules pre-filled with common aliases
    document.getElementById('cfRulesTbody').innerHTML = '';
    _cfRuleCount = 0;
    cfAddRule('DM Water',  'Demineralized Water');
    cfAddRule('D M Water', 'Demineralized Water');
    cfAddRule('',          '');   // one empty row for custom
    document.getElementById('cfApplyBtn').disabled = true;
    document.getElementById('cfApplyBtn').style.opacity = '.45';
    document.getElementById('cfApplyBtn').style.cursor  = 'not-allowed';
    document.getElementById('cfRenameHint').textContent = 'Add rules then click Preview';
    document.getElementById('correctFvqModal').classList.add('open');
}
function closeCorrectFvqModal(){
    document.getElementById('correctFvqModal').classList.remove('open');
}
document.getElementById('correctFvqModal').addEventListener('click', e=>{
    if(e.target === document.getElementById('correctFvqModal')) closeCorrectFvqModal();
});

/* ── Mode switch ─────────────────────────────────────── */
function cfSwitchMode(mode){
    const isRename   = mode === 'rename';
    const renamePanel  = document.getElementById('cfRenamePanel');
    const supplierPanel= document.getElementById('cfSupplierPanel');
    renamePanel.style.display   = isRename ? 'flex' : 'none';
    supplierPanel.style.display = isRename ? 'none' : 'flex';

    // Active radio label styling
    document.getElementById('cfRadioRenameLabel').style.borderColor =
        isRename ? '#eab308' : 'var(--border2)';
    document.getElementById('cfRadioRenameLabel').style.background =
        isRename ? 'rgba(234,179,8,.1)' : 'var(--surface2)';
    document.getElementById('cfRadioSupplierLabel').style.borderColor =
        !isRename ? '#eab308' : 'var(--border2)';
    document.getElementById('cfRadioSupplierLabel').style.background =
        !isRename ? 'rgba(234,179,8,.1)' : 'var(--surface2)';

    if(!isRename) cfLoadMissingSupplier();
}

/* ── Rename rules ────────────────────────────────────── */
function cfAddRule(fromVal='', toVal=''){
    const tbody = document.getElementById('cfRulesTbody');
    const idx   = _cfRuleCount++;
    const tr    = document.createElement('tr');
    tr.id       = 'cfRule_' + idx;
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML = `
        <td style="padding:6px 12px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border);text-align:center">${idx+1}</td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <input class="cf-from-input" type="text" value="${escHtml(fromVal)}" placeholder="e.g. DM Water"
                   oninput="cfClearPreview()"
                   style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;outline:none"
                   onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        </td>
        <td style="padding:5px 8px;border-right:1px solid var(--border)">
            <input class="cf-to-input" type="text" value="${escHtml(toVal)}" placeholder="e.g. Demineralized Water"
                   oninput="cfClearPreview()"
                   style="width:100%;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:12px;outline:none"
                   onfocus="this.style.borderColor='var(--teal-dim)'" onblur="this.style.borderColor='var(--border2)'">
        </td>
        <td id="cfPreview_${idx}" style="padding:6px 12px;font-size:11px;color:var(--muted);border-right:1px solid var(--border)">—</td>
        <td style="padding:6px 8px;text-align:center">
            <button onclick="document.getElementById('cfRule_${idx}').remove();cfClearPreview()" title="Remove"
                    style="width:22px;height:22px;border-radius:50%;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center"
                    onmouseover="this.style.color='var(--red-text)';this.style.borderColor='var(--red-text)'"
                    onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border2)'">✕</button>
        </td>`;
    tbody.appendChild(tr);
}

function cfClearPreview(){
    _cfPreviewData = [];
    document.querySelectorAll('[id^="cfPreview_"]').forEach(td=>{ td.textContent='—'; td.style.color='var(--muted)'; });
    document.getElementById('cfApplyBtn').disabled = true;
    document.getElementById('cfApplyBtn').style.opacity = '.45';
    document.getElementById('cfApplyBtn').style.cursor  = 'not-allowed';
    document.getElementById('cfRenameHint').textContent = 'Click Preview to check changes';
}

/* ── Collect rules from the table ───────────────────── */
function cfGetRules(){
    const rows = [...document.querySelectorAll('#cfRulesTbody tr[id^="cfRule_"]')];
    return rows.map(tr=>({
        type: 'rename',
        from: tr.querySelector('.cf-from-input')?.value.trim() || '',
        to:   tr.querySelector('.cf-to-input')?.value.trim()   || '',
    })).filter(r=>r.from && r.to && r.from !== r.to);
}

/* ── Preview ────────────────────────────────────────── */
async function cfPreview(){
    const rules = cfGetRules();
    if(!rules.length){ toast('Add at least one From→To rename rule','warning'); return; }
    document.getElementById('cfRenameHint').textContent = 'Previewing…';
    try{
        const res  = await fetch('/api/procurement/formulations/correct',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({action:'preview', tasks:rules})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _cfPreviewData = data.rename_preview || [];

        let totalAffected = 0;
        // Update each row's preview cell
        const rows = [...document.querySelectorAll('#cfRulesTbody tr[id^="cfRule_"]')];
        rows.forEach((tr,i)=>{
            const from  = tr.querySelector('.cf-from-input')?.value.trim()||'';
            const to    = tr.querySelector('.cf-to-input')?.value.trim()||'';
            if(!from||!to||from===to) return;
            // find matching preview entry
            const previewRow = _cfPreviewData.find(p=>
                p.from.toLowerCase()===from.toLowerCase() && p.to.toLowerCase()===to.toLowerCase()
            );
            // Find the preview TD by index
            const previewTd = tr.querySelector('td:nth-child(4)');
            if(!previewTd) return;
            if(!previewRow || previewRow.count===0){
                previewTd.innerHTML = '<span style="color:var(--muted)">Not found in DB</span>';
                return;
            }
            totalAffected += previewRow.count;
            const batchList = previewRow.batches.map(b=>`<em>${escHtml(b)}</em>`).join(', ');
            const extra = previewRow.extra > 0 ? ` +${previewRow.extra} more` : '';
            previewTd.innerHTML = `<span style="color:var(--teal);font-weight:600">${previewRow.count} row${previewRow.count!==1?'s':''}</span>
                <div style="font-size:9.5px;color:var(--muted);margin-top:2px">${batchList}${extra}</div>`;
        });

        document.getElementById('cfRenameHint').textContent =
            totalAffected > 0
                ? `${totalAffected} row${totalAffected!==1?'s':''} will be renamed — review and click Apply`
                : 'No matching rows found in the database';

        if(totalAffected > 0){
            document.getElementById('cfApplyBtn').disabled = false;
            document.getElementById('cfApplyBtn').style.opacity = '1';
            document.getElementById('cfApplyBtn').style.cursor  = 'pointer';
        }
    }catch(err){
        toast('Preview failed: '+err.message,'error');
        document.getElementById('cfRenameHint').textContent = 'Preview failed';
    }
}

/* ── Apply ───────────────────────────────────────────── */
// Shows the diff confirm modal before actually applying
function cfApply(){
    const rules = cfGetRules();
    if(!rules.length){ toast('No rules to apply','warning'); return; }
    if(!_cfPreviewData.length){ toast('Click Preview Changes first','warning'); return; }

    // Only include rules that have matches
    const toApply = _cfPreviewData.filter(p=>p.count > 0);
    if(!toApply.length){ toast('No matching rows found — nothing to apply','info'); return; }

    // Build side-by-side diff table
    const totalRows = toApply.reduce((s,p)=>s+p.count,0);
    document.getElementById('cfDiffSub').textContent =
        `${toApply.length} rename rule${toApply.length!==1?'s':''} · ${totalRows} row${totalRows!==1?'s':''} will be updated`;
    document.getElementById('cfDiffHint').textContent =
        `This will permanently rename ${totalRows} ingredient row${totalRows!==1?'s':''} in the formulations database.`;

    document.getElementById('cfDiffTbody').innerHTML = toApply.map((p,i)=>{
        const batchList = p.batches.map(b=>
            `<span style="display:inline-block;margin:1px 3px 1px 0;padding:1px 6px;border-radius:3px;background:var(--text-08);font-size:10px;color:var(--text)">${escHtml(b)}</span>`
        ).join('');
        const extra = p.extra > 0
            ? `<span style="font-size:10px;color:var(--muted)">+${p.extra} more batch${p.extra>1?'es':''}</span>`
            : '';
        return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:10px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border);vertical-align:top">${i+1}</td>
            <td style="padding:10px 14px;border-right:1px solid var(--border);vertical-align:top">
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:9px;padding:2px 7px;border-radius:3px;background:rgba(244,63,94,.1);color:var(--red-text);font-weight:700;white-space:nowrap">BEFORE</span>
                    <span style="font-weight:600;color:var(--red-text);font-family:var(--font-mono);font-size:12px">${escHtml(p.from)}</span>
                </div>
                <div style="margin-top:5px;font-size:10.5px;color:var(--muted)">${p.count} row${p.count!==1?'s':''} in database</div>
            </td>
            <td style="padding:10px 14px;border-right:1px solid var(--border);vertical-align:top">
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:9px;padding:2px 7px;border-radius:3px;background:rgba(16,185,129,.1);color:var(--green-text);font-weight:700;white-space:nowrap">AFTER</span>
                    <span style="font-weight:600;color:var(--green-text);font-family:var(--font-mono);font-size:12px">${escHtml(p.to)}</span>
                </div>
                <div style="margin-top:5px;font-size:10px;color:var(--muted)">All ${p.count} row${p.count!==1?'s':''} renamed</div>
            </td>
            <td style="padding:10px 14px;vertical-align:top">
                <div style="display:flex;flex-wrap:wrap;gap:2px;align-items:flex-start">
                    ${batchList}${extra}
                </div>
            </td>
        </tr>`;
    }).join('');

    document.getElementById('cfDiffModal').classList.add('open');
}

function closeCfDiff(){
    document.getElementById('cfDiffModal').classList.remove('open');
}
document.getElementById('cfDiffModal').addEventListener('click', e=>{
    if(e.target===document.getElementById('cfDiffModal')) closeCfDiff();
});

async function cfConfirmApply(){
    const rules = cfGetRules();
    const btn   = document.getElementById('cfDiffConfirmBtn');
    btn.disabled=true; btn.textContent='Applying…';
    try{
        const res  = await fetch('/api/procurement/formulations/correct',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({action:'apply', tasks:rules})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const applied = data.applied || [];
        const total   = applied.reduce((s,a)=>s+a.rows_updated,0);
        closeCfDiff();
        if(total > 0){
            toast(`Applied ${applied.length} rename${applied.length!==1?'s':''} — ${total} rows updated`, 'success');
            cfClearPreview();
            await loadFvqData();
            // Show result in hint
            document.getElementById('cfRenameHint').innerHTML =
                `<span style="color:var(--green-text)">✓ Applied: </span>` +
                applied.map(a=>`<em>${escHtml(a.from)}</em> → <em>${escHtml(a.to)}</em> (${a.rows_updated})`).join(' · ');
        } else {
            toast('No rows were updated', 'info');
        }
    }catch(err){
        toast('Apply failed: '+err.message,'error');
    }finally{
        btn.disabled=false;
        btn.textContent='Confirm & Apply';
        btn.style.opacity='1';
        btn.style.cursor='pointer';
    }
}

/* ── Missing Supplier ────────────────────────────────── */
async function cfLoadMissingSupplier(){
    document.getElementById('cfMissingTbody').innerHTML =
        '<tr><td colspan="3"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    document.getElementById('cfModalHint').textContent = 'Loading missing suppliers…';
    try{
        const res  = await fetch('/api/procurement/formulations/correct',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({action:'preview', tasks:[]})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _cfMissingData = data.missing_supplier || [];
        document.getElementById('cfSupplierSearch').value = '';
        cfRenderMissingSupplier();
    }catch(err){
        document.getElementById('cfMissingTbody').innerHTML =
            `<tr><td colspan="3" style="padding:24px;text-align:center;color:var(--red-text)">${escHtml(err.message)}</td></tr>`;
    }
}

function cfRenderMissingSupplier(){
    const q = (document.getElementById('cfSupplierSearch').value||'').trim().toLowerCase();
    const rows = q
        ? _cfMissingData.filter(r=>r.material_name.toLowerCase().includes(q))
        : _cfMissingData;
    const n = rows.length;
    document.getElementById('cfSupplierCount').textContent = `${n} material${n!==1?'s':''} without supplier`;
    document.getElementById('cfModalHint').textContent     = `${n} material${n!==1?'s':''} in formulations with no supplier in the database`;

    if(!rows.length){
        document.getElementById('cfMissingTbody').innerHTML =
            '<tr><td colspan="3"><div class="state-box"><div class="state-icon">✅</div><h3>All materials have suppliers</h3><p>Every material in your formulations has a supplier set in the procurement database.</p></div></td></tr>';
        return;
    }
    document.getElementById('cfMissingTbody').innerHTML = rows.map((r,i)=>`
        <tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:9px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${i+1}</td>
            <td style="padding:9px 14px;font-weight:600;color:var(--text);border-right:1px solid var(--border)">
                ${escHtml(r.material_name)}
            </td>
            <td style="padding:9px 14px;font-family:var(--font-mono);font-weight:600;color:var(--amber-text);text-align:right">
                ${r.batch_count} batch${r.batch_count!==1?'es':''}
            </td>
        </tr>`).join('');
}

function closeUsedIn(){
    document.getElementById('usedInModal').classList.remove('open');
}
document.getElementById('usedInModal').addEventListener('click', e=>{
    if(e.target===document.getElementById('usedInModal')) closeUsedIn();
});

function openEditModal(r){
    const isNew=!r;
    document.getElementById('editEyebrow').textContent =isNew?'New Record':'Edit Record';
    document.getElementById('editTitle').textContent   =isNew?'Add New Material':'Edit Material';
    document.getElementById('editSub').textContent     =isNew?'Enter the procurement details':'Update the details below';
    document.getElementById('editMatKey').value        =isNew?'':r.material_name;
    document.getElementById('editMatDisplay').textContent=isNew?'':r.material_name;
    document.getElementById('editMatBanner').style.display=isNew?'none':'flex';
    document.getElementById('matNameGroup').style.display=isNew?'block':'none';
    document.getElementById('editMatName').value       =isNew?'':(r.material_name??'');
    document.getElementById('editOrderedQty').value   =isNew?'':(r.ordered_qty??'');
    document.getElementById('editBufferQty').value    =isNew?'':(r.buffer_qty??'');
    document.getElementById('editMSL').value          =isNew?'':(r.msl??'');
    document.getElementById('editLastRate').value     =isNew?'':(r.last_purchase_rate??'');
    document.getElementById('editAliases').value      =isNew?'':(r.aliases??'');
    document.getElementById('editDescription').value  =isNew?'':(r.description??'');
    // Supplier fields — null-safe in case HTML not yet updated
    const _supNameEl = document.getElementById('editSupplierName');
    const _supHintEl = document.getElementById('editSupplierHint');
    const _supDdEl   = document.getElementById('editSupplierAcDd');
    if(_supNameEl) _supNameEl.value = isNew ? '' : (r.supplier_name ?? '');
    // Supplier code: set hidden input + update display badge
    const _supHiddenCode = document.getElementById('editSupplierCode');
    if(_supHiddenCode) _supHiddenCode.value = isNew ? '' : (r.supplier_code ?? '');
    _setSupplierCodeDisplay(isNew ? '' : (r.supplier_code ?? ''), !isNew && !!(r.supplier_code));
    if(_supHintEl){ _supHintEl.textContent=''; _supHintEl.style.color=''; }
    if(_supDdEl)  { _supDdEl.innerHTML=''; _supDdEl.classList.remove('open'); }
    if(!isNew && r.supplier_name && _supNameEl) _validateSupplierName();
    // Material Group
    const _groupSel  = document.getElementById('editGroupId');
    const _groupHint = document.getElementById('editGroupHint');
    if(_groupSel){
        _populateGroupSelect(_groupSel, isNew ? null : (r.group_id ?? null));
        if(!isNew && r.group_id) _groupSel.value = r.group_id;
        if(_groupHint){
            if(!isNew && r.group_id){
                const g = _matGroups.find(x=>String(x.id)===String(r.group_id));
                _groupHint.textContent = g ? `✓ ${g.group_name}` : '';
                _groupHint.style.color = 'var(--green-text)';
            } else {
                _groupHint.textContent = isNew ? '⚠ Please select a material group' : '';
                _groupHint.style.color = 'var(--amber-text)';
            }
        }
    }
    // For new records: attempt to auto-fill supplier from last GRN
    if(isNew && _supNameEl){
        const matName = document.getElementById('editMatName').value.trim();
        if(matName) _prefillSupplierFromGrn(matName);
    }
    // GST & Statutory fields
    const _hsnEl  = document.getElementById('editHsnCode');
    const _gstEl  = document.getElementById('editGstRate');
    const _taxEl  = document.getElementById('editTaxability');
    const _tosEl  = document.getElementById('editTypeOfSupply');
    if(_hsnEl) _hsnEl.value = isNew ? '' : (r.hsn_code ?? '');
    if(_gstEl){
        // gst_rate stored as number (e.g. 18); option values are '0','5','12','18','28'
        const gstVal = (r?.gst_rate!=null && r?.gst_rate!=='') ? String(parseFloat(r.gst_rate)) : '';
        _gstEl.value = gstVal;
        // If value didn't match any option, reset to blank
        if(_gstEl.value !== gstVal) _gstEl.value = '';
    }
    if(_taxEl) _taxEl.value = isNew ? 'Taxable' : (r.taxability ?? 'Taxable');
    if(_tosEl) _tosEl.value = isNew ? 'Goods'   : (r.type_of_supply ?? 'Goods');
    const usedInBtn = document.getElementById('editUsedInBtn');
    if(usedInBtn) usedInBtn.style.display = isNew ? 'none' : 'inline-flex';
    document.getElementById('editModal').classList.add('open');
    setTimeout(()=>{
        (isNew?document.getElementById('editMatName'):document.getElementById('editOrderedQty'))?.focus();
    },50);
}
function closeEditModal(){ document.getElementById('editModal').classList.remove('open'); }
document.getElementById('editModal').addEventListener('click',e=>{ if(e.target===document.getElementById('editModal'))closeEditModal(); });
document.getElementById('editModal').addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.tagName==='INPUT'){e.preventDefault();saveEditModal();} });

async function saveEditModal(){
    const isNew=!document.getElementById('editMatKey').value;
    const mat=isNew?document.getElementById('editMatName').value.trim():document.getElementById('editMatKey').value;
    if(!mat){toast('Material name is required','error');return;}
    const payload={
        material_name:      mat,
        ordered_qty:        nv(document.getElementById('editOrderedQty').value),
        buffer_qty:         nv(document.getElementById('editBufferQty').value),
        msl:                nv(document.getElementById('editMSL').value),
        last_purchase_rate: nv(document.getElementById('editLastRate').value),
        aliases:            nv(document.getElementById('editAliases').value),
        description:        nv(document.getElementById('editDescription').value),
        supplier_name:      nv((document.getElementById('editSupplierName')||{}).value),
        supplier_code:      nv((document.getElementById('editSupplierCode')||{}).value),
        group_id:           (document.getElementById('editGroupId')||{}).value || null,
        hsn_code:           nv((document.getElementById('editHsnCode')||{}).value),
        gst_rate:           nv((document.getElementById('editGstRate')||{}).value),
        taxability:         nv((document.getElementById('editTaxability')||{}).value),
        type_of_supply:     nv((document.getElementById('editTypeOfSupply')||{}).value),
    };
    try{
        const res=await fetch('/api/procurement/save_material',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        closeEditModal();
        toast((isNew?'Added':'Updated')+' — '+mat,'success');
        // Update in-memory _allRows immediately so PO print has fresh GST data
        const existIdx = _allRows.findIndex(r=>r.material_name===mat);
        if(existIdx>=0){
            Object.assign(_allRows[existIdx], payload);
        }
        applyFilters(); // instant visual refresh
        // Sync supplier to formulations table if supplier changed
        if(payload.supplier_name!==undefined){
            fetch('/api/procurement/formulations/update_supplier',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({material_name:mat,supplier_name:payload.supplier_name})
            }).then(r=>r.json()).then(d=>{
                if(d.status==='ok'&&d.updated_rows>0)
                    toast(`Supplier updated in ${d.updated_rows} formulation row${d.updated_rows!==1?'s':''}`,
                          'info',2500);
            }).catch(()=>{});
        }
        // Full reload in background to get server-computed fields (in_stock_qty etc)
        loadData();
    }catch(err){toast('Save failed: '+err.message,'error');}
}

/* ═══════════════════════ MATERIAL GROUPS ═══════════════════════ */
let _matGroups = [];   // loaded once, refreshed after add

async function loadMatGroups(){
    try{
        const res  = await fetch('/api/procurement/material_groups');
        const data = await res.json();
        if(data.status !== 'ok') return;
        _matGroups = (data.groups || []).filter(g => g.id !== 1); // exclude Father Group from selectable
        _populateGroupSelect(document.getElementById('editGroupId'), null);
    }catch(e){}
}

function _populateGroupSelect(sel, selectedId){
    if(!sel) return;
    const prev = selectedId !== null ? selectedId : (sel.value || null);
    sel.innerHTML = '<option value="">-- Select Group --</option>';
    _matGroups.forEach(g => {
        const opt = document.createElement('option');
        opt.value       = g.id;
        opt.textContent = g.group_name + (g.mat_count ? ` (${g.mat_count})` : '');
        sel.appendChild(opt);
    });
    if(prev) sel.value = prev;
}

function matGroupSelectChange(){
    const sel  = document.getElementById('editGroupId');
    const hint = document.getElementById('editGroupHint');
    if(!sel || !hint) return;
    if(!sel.value){
        hint.textContent = '⚠ Please select a material group';
        hint.style.color = 'var(--amber-text)';
    } else {
        const g = _matGroups.find(x => String(x.id) === String(sel.value));
        hint.textContent = g ? `✓ ${g.group_name}` : '';
        hint.style.color = 'var(--green-text)';
    }
}

function openMatGroupModalFromEdit(){
    document.getElementById('matGroupEditId').value    = '';
    document.getElementById('matGroupNameInput').value = '';
    document.getElementById('matGroupDescInput').value = '';
    document.getElementById('matGroupModalEyebrow').textContent = 'NEW GROUP';
    document.getElementById('matGroupModalTitle').textContent   = 'Add Material Group';
    document.getElementById('matGroupModal').classList.add('open');
    setTimeout(()=>document.getElementById('matGroupNameInput')?.focus(), 60);
}
function closeMatGroupModal(){
    document.getElementById('matGroupModal').classList.remove('open');
}
async function saveMatGroup(){
    const name = (document.getElementById('matGroupNameInput').value||'').trim();
    const desc = (document.getElementById('matGroupDescInput').value||'').trim();
    const gid  = document.getElementById('matGroupEditId').value;
    if(!name){ toast('Group name is required','error'); return; }
    try{
        const res  = await fetch('/api/procurement/material_groups/save',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id:gid||null, group_name:name, description:desc||null})
        });
        const data = await res.json();
        if(data.status !== 'ok') throw new Error(data.message);
        toast('Group saved: '+name,'success',2000);
        closeMatGroupModal();
        await loadMatGroups();
        if(_matGroupSaveContext === 'manager'){
            await loadGroupsManager();
            _matGroupSaveContext = 'edit';
        } else {
            // Auto-select the newly created group in the edit modal
            const sel = document.getElementById('editGroupId');
            if(sel && data.id){
                _populateGroupSelect(sel, data.id);
                sel.value = data.id;
                matGroupSelectChange();
            }
        }
    }catch(e){ toast('Save failed: '+e.message,'error'); }
}

// Load groups when page loads
loadMatGroups();

/* ═══════════════════════ BULK ASSIGN GROUP ═══════════════════════ */
function openBulkAssignGroup(){
    const sel = [..._selectedMats];
    if(!sel.length){ toast('Select at least one material','warning'); return; }
    document.getElementById('bulkGroupMatList').innerHTML =
        `<strong style="color:var(--text)">${sel.length} material${sel.length>1?'s':''} selected:</strong><br>` +
        sel.map(n=>`<span style="display:inline-block;margin:2px 4px 0 0;padding:1px 8px;border-radius:10px;background:var(--text-08);font-size:10.5px">${escHtml(n)}</span>`).join('');
    const sel2 = document.getElementById('bulkGroupSelect');
    sel2.innerHTML = '<option value="">-- Select Group --</option>';
    _matGroups.forEach(g=>{
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.group_name + (g.mat_count ? ` (${g.mat_count})` : '');
        sel2.appendChild(o);
    });
    document.getElementById('bulkGroupModal').classList.add('open');
}
function closeBulkAssignGroup(){
    document.getElementById('bulkGroupModal').classList.remove('open');
}
async function saveBulkAssignGroup(){
    const groupId = document.getElementById('bulkGroupSelect').value;
    if(!groupId){ toast('Please select a group','warning'); return; }
    const sel = [..._selectedMats];
    if(!sel.length){ toast('No materials selected','warning'); return; }
    try{
        const res  = await fetch('/api/procurement/material_groups/bulk_assign',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({group_id: groupId, material_names: sel})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const g = _matGroups.find(x=>String(x.id)===String(groupId));
        toast(`Assigned "${g?.group_name||groupId}" to ${data.updated} material${data.updated!==1?'s':''}`, 'success');
        closeBulkAssignGroup();
        _selectedMats.clear();
        await loadData();
        await loadMatGroups();
    }catch(e){ toast('Assign failed: '+e.message,'error'); }
}

/* ═══════════════════════ GROUPS MANAGER ═══════════════════════ */
async function openGroupsManager(){
    document.getElementById('groupsManagerModal').classList.add('open');
    await loadGroupsManager();
}
function closeGroupsManager(){
    document.getElementById('groupsManagerModal').classList.remove('open');
}
async function loadGroupsManager(){
    document.getElementById('grpMgrTbody').innerHTML =
        '<tr><td colspan="5"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    try{
        const res  = await fetch('/api/procurement/material_groups');
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        const groups = (data.groups||[]).filter(g=>g.id!==1);
        document.getElementById('grpMgrCount').textContent =
            `${groups.length} group${groups.length!==1?'s':''}`;
        const sbBadge = document.getElementById('sbBadge-matGroups');
        if(sbBadge) sbBadge.textContent = groups.length||'–';
        if(!groups.length){
            document.getElementById('grpMgrTbody').innerHTML =
                '<tr><td colspan="5"><div class="state-box"><div class="state-icon">📂</div><h3>No groups yet</h3><p>Click "New Group" to create your first material group.</p></div></td></tr>';
            return;
        }
        document.getElementById('grpMgrTbody').innerHTML = groups.map((g,i)=>`
            <tr style="border-bottom:1px solid var(--border)"
                onmouseover="this.style.background='var(--text-05)'"
                onmouseout="this.style.background=''">
                <td style="padding:9px 12px;color:var(--muted);font-size:10px;font-family:var(--font-mono)">${i+1}</td>
                <td style="padding:9px 12px;font-weight:600;color:var(--text)">${escHtml(g.group_name)}</td>
                <td style="padding:9px 12px;font-size:11px;color:var(--muted)">${escHtml(g.description||'—')}</td>
                <td style="padding:9px 12px;text-align:center">
                    <span style="padding:2px 9px;border-radius:10px;background:var(--text-05);font-size:10.5px;font-weight:700;color:${g.mat_count?'var(--teal)':'var(--muted)'}">${g.mat_count||0}</span>
                </td>
                <td style="padding:9px 12px">
                    <div style="display:flex;gap:6px;justify-content:flex-end">
                        <button onclick="editGroupFromManager(${g.id},'${escHtml(g.group_name).replace(/'/g,"\\'")}','${escHtml(g.description||'').replace(/'/g,"\\'")}')"
                                style="padding:3px 10px;border-radius:5px;border:1px solid var(--border2);background:transparent;color:var(--teal);cursor:pointer;font-size:11px">Edit</button>
                        <button onclick="deleteGroupFromManager(${g.id},'${escHtml(g.group_name).replace(/'/g,"\\'")}',${g.mat_count})"
                                ${g.mat_count?'disabled title="Reassign materials first"':''}
                                style="padding:3px 10px;border-radius:5px;border:1px solid ${g.mat_count?'var(--border)':'rgba(244,63,94,.3)'};background:transparent;color:${g.mat_count?'var(--muted)':'var(--red-text)'};cursor:${g.mat_count?'not-allowed':'pointer'};font-size:11px;opacity:${g.mat_count?.5:1}">Delete</button>
                    </div>
                </td>
            </tr>`).join('');
    }catch(e){
        document.getElementById('grpMgrTbody').innerHTML =
            `<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--red-text)">${escHtml(e.message)}</td></tr>`;
    }
}
function openMatGroupModalFromManager(){
    document.getElementById('matGroupEditId').value    = '';
    document.getElementById('matGroupNameInput').value = '';
    document.getElementById('matGroupDescInput').value = '';
    document.getElementById('matGroupModalEyebrow').textContent = 'NEW GROUP';
    document.getElementById('matGroupModalTitle').textContent   = 'Add Material Group';
    document.getElementById('matGroupModal').classList.add('open');
    setTimeout(()=>document.getElementById('matGroupNameInput')?.focus(), 60);
    // After save, refresh the manager instead of the edit modal
    _matGroupSaveContext = 'manager';
}
function editGroupFromManager(id, name, desc){
    document.getElementById('matGroupEditId').value    = id;
    document.getElementById('matGroupNameInput').value = name;
    document.getElementById('matGroupDescInput').value = desc;
    document.getElementById('matGroupModalEyebrow').textContent = 'EDIT GROUP';
    document.getElementById('matGroupModalTitle').textContent   = 'Edit Material Group';
    document.getElementById('matGroupModal').classList.add('open');
    setTimeout(()=>document.getElementById('matGroupNameInput')?.focus(), 60);
    _matGroupSaveContext = 'manager';
}
async function deleteGroupFromManager(id, name, matCount){
    if(matCount){ toast(`Cannot delete — ${matCount} material(s) assigned. Reassign them first.`,'warning',4000); return; }
    if(!confirm(`Delete group "${name}"?\n\nThis cannot be undone.`)) return;
    try{
        const res  = await fetch('/api/procurement/material_groups/delete',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({id})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast('Group deleted: '+name,'success',2000);
        await loadMatGroups();
        await loadGroupsManager();
    }catch(e){ toast('Delete failed: '+e.message,'error'); }
}

/* track where saveMatGroup should refresh after save */
let _matGroupSaveContext = 'edit'; // 'edit' | 'manager'

let _supAcIdx = -1;

function _buildSupplierAcList(q){
    const src = (typeof _supRows !== 'undefined' ? _supRows : [])
        .filter(s => s.status !== 'inactive');
    if(!q) return src.slice(0,12).map(s=>({name:s.supplier_name, code:s.supplier_code||''}));
    const ql = q.toLowerCase();
    return src
        .filter(s => (s.supplier_name||'').toLowerCase().includes(ql)
                  || (s.supplier_code||'').toLowerCase().includes(ql))
        .slice(0,12)
        .map(s=>({name:s.supplier_name, code:s.supplier_code||''}));
}

function onSupplierNameInput(){
    const q   = (document.getElementById('editSupplierName').value||'').trim();
    const dd  = document.getElementById('editSupplierAcDd');
    if(!dd) return;
    const items = _buildSupplierAcList(q);
    _supAcIdx = -1;
    if(!items.length || !q){ dd.innerHTML=''; dd.classList.remove('open'); _validateSupplierName(); return; }
    dd.innerHTML = items.map((s,i)=>`
        <div class="dd-item" data-idx="${i}"
             onmousedown="event.preventDefault();selectSupplierAc('${escHtml(s.name).replace(/'/g,"\\'").replace(/"/g,'&quot;')}','${escHtml(s.code).replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">
            <span style="font-weight:600">${escHtml(s.name)}</span>
            ${s.code?`<span style="font-size:10px;color:var(--teal);margin-left:8px;font-family:var(--font-mono)">${escHtml(s.code)}</span>`:''}
        </div>`).join('');
    dd.classList.add('open');
    _validateSupplierName();
}

function onSupplierNameKeydown(e){
    const dd    = document.getElementById('editSupplierAcDd');
    const items = [...(dd?.querySelectorAll('.dd-item')||[])];
    if(!dd?.classList.contains('open')) return;
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _supAcIdx = Math.min(_supAcIdx+1, items.length-1);
        items.forEach((el,i)=>el.classList.toggle('dd-focused',i===_supAcIdx));
        items[_supAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _supAcIdx = Math.max(_supAcIdx-1, 0);
        items.forEach((el,i)=>el.classList.toggle('dd-focused',i===_supAcIdx));
        items[_supAcIdx]?.scrollIntoView({block:'nearest'});
    } else if(e.key==='Enter'||e.key==='Tab'){
        if(_supAcIdx>=0 && items[_supAcIdx]){
            e.preventDefault();
            items[_supAcIdx].dispatchEvent(new MouseEvent('mousedown'));
        } else { dd.classList.remove('open'); }
    } else if(e.key==='Escape'){
        dd.innerHTML=''; dd.classList.remove('open');
    }
}

function selectSupplierAc(name, code){
    const el = document.getElementById('editSupplierName');
    const dd = document.getElementById('editSupplierAcDd');
    if(el) el.value = name;
    _setSupplierCodeDisplay(code, !!code);
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _validateSupplierName();
}

function _setSupplierCodeDisplay(code, matched){
    const disp   = document.getElementById('editSupplierCodeDisplay');
    const hidden = document.getElementById('editSupplierCode');
    if(!disp) return;
    if(matched && code){
        disp.textContent      = code;
        disp.style.color      = 'var(--teal)';
        disp.style.fontWeight = '700';
        disp.style.fontSize   = '12px';
    } else {
        disp.textContent      = '— not matched —';
        disp.style.color      = 'var(--muted)';
        disp.style.fontWeight = '400';
        disp.style.fontSize   = '11px';
    }
    if(hidden) hidden.value = (matched && code) ? code : '';
}

function _validateSupplierName(){
    const nameEl = document.getElementById('editSupplierName');
    const hint   = document.getElementById('editSupplierHint');
    if(!nameEl || !hint) return;
    const val  = (nameEl.value||'').trim();
    if(!val){
        hint.textContent=''; hint.style.color='';
        _setSupplierCodeDisplay('', false);
        return;
    }
    const src   = (typeof _supRows !== 'undefined' ? _supRows : []);
    const match = src.find(s=>(s.supplier_name||'').toLowerCase()===val.toLowerCase());
    if(match){
        const code = match.supplier_code || '';
        hint.textContent = `✓ Matched: ${match.supplier_name}` + (code ? ` · ${code}` : '');
        hint.style.color = 'var(--green-text)';
        _setSupplierCodeDisplay(code, true);
    } else {
        hint.textContent = '⚠ Not found in Supplier Directory — will be saved as typed';
        hint.style.color = 'var(--amber-text)';
        _setSupplierCodeDisplay('', false);
    }
}

async function _prefillSupplierFromGrn(materialName){
    if(!materialName) return;
    try{
        const res  = await fetch(`/api/procurement/grn/last_supplier_for_material?material=${encodeURIComponent(materialName)}`);
        const data = await res.json();
        if(data.status==='ok' && data.supplier_name){
            const el = document.getElementById('editSupplierName');
            if(el) el.value = data.supplier_name;
            _setSupplierCodeDisplay(data.supplier_code||'', !!data.supplier_code);
            _validateSupplierName();
            toast('Supplier auto-filled from last GRN','info',2500);
        }
    }catch(e){}
}

// Close supplier dropdown on outside click
document.addEventListener('click', e=>{
    if(!e.target.closest('#editSupplierWrap')){
        const dd = document.getElementById('editSupplierAcDd');
        if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    }
});

/* ═══════════════════════ EXPORT ═══════════════════════ */
function doExport(){
    const headers=['Material Name','Aliases','Description',
                   'Supplier Name','Supplier Code',
                   'Ordered Qty','MSL','Last Purchase Rate (₹/kg)',
                   'HSN/SAC Code','GST Rate (%)','Taxability','Type of Supply',
                   '[READ ONLY] In Stock Qty'];
    const wsData=[headers];
    _allRows.forEach(r=>{
        wsData.push([r.material_name,
            r.aliases??'', r.description??'',
            r.supplier_name??'', r.supplier_code??'',
            r.ordered_qty??'', r.msl??'', r.last_purchase_rate??'',
            r.hsn_code??'',r.gst_rate??'',r.taxability??'',r.type_of_supply??'',
            r.in_stock_qty??0]);
    });
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols']=[{wch:44},{wch:40},{wch:50},{wch:36},{wch:14},{wch:12},{wch:12},{wch:16},{wch:14},{wch:12},{wch:14},{wch:16},{wch:16}];
    XLSX.utils.book_append_sheet(wb,ws,'Procurement');
    XLSX.writeFile(wb,`Procurement_${new Date().toISOString().slice(0,10)}.xlsx`);
    toast('Exported '+(_allRows.length||0)+' rows','success');
}

/* ═══════════════════════ TEMPLATE DOWNLOAD ═══════════════════════ */
function downloadTemplate(){
    const headers=['Material Name','Aliases','Description',
                   'Supplier Name','Supplier Code',
                   'Ordered Qty','MSL','Last Purchase Rate (₹/kg)',
                   'HSN/SAC Code','GST Rate (%)','Taxability','Type of Supply'];
    const instructions=[
        '← REQUIRED: Exact material name',
        '← Comma-separated alternate names (e.g. NaCl, Salt)',
        '← Short description shown below name',
        '← Supplier name (must match Supplier Directory for auto-code fill)',
        '← Supplier code (auto-filled if name matches)',
        '← Opening balance qty',
        '← Min Stock Level',
        '← Rate per kg in ₹ (used to auto-fill PO)',
        '← e.g. 2905','← 0/5/12/18/28','← Taxable/Exempt','← Goods/Services'];
    const wsData=[headers, instructions,
        ['Sodium Chloride','NaCl, Salt, Rock Salt','Food-grade white crystalline powder','ABC Chemicals Pvt Ltd','SUP001','500','50','45.50','2501','5','Taxable','Goods'],
        ['Example Material B','','','','','','','','','','','']];
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols']=[{wch:44},{wch:40},{wch:50},{wch:36},{wch:14},{wch:12},{wch:12},{wch:16},{wch:14},{wch:12},{wch:14},{wch:16}];
    XLSX.utils.book_append_sheet(wb,ws,'Procurement Template');
    XLSX.writeFile(wb,'Procurement_Import_Template.xlsx');
    toast('Template downloaded','success');
}

/* ═══════════════════════ IMPORT ═══════════════════════ */
function openImportModal(){
    _importRows=[];
    document.getElementById('importFileInput').value='';
    document.getElementById('importPreview').style.display='none';
    document.getElementById('importStatus').textContent='';
    const btn=document.getElementById('importConfirmBtn');
    btn.disabled=true;btn.style.opacity='.45';btn.style.cursor='not-allowed';
    document.getElementById('importModal').classList.add('open');
}
function closeImportModal(){ document.getElementById('importModal').classList.remove('open'); }
document.getElementById('importModal').addEventListener('click',e=>{ if(e.target===document.getElementById('importModal'))closeImportModal(); });
function onDragOver(e){e.preventDefault();document.getElementById('importZone').classList.add('drag-over');}
function onDragLeave(){document.getElementById('importZone').classList.remove('drag-over');}
function onDrop(e){e.preventDefault();document.getElementById('importZone').classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f)onFileSelected(f);}

function onFileSelected(file){
    if(!file)return;
    if(!file.name.endsWith('.xlsx')){toast('Please select a .xlsx file','error');return;}
    document.getElementById('importStatus').textContent='Reading file…';
    const reader=new FileReader();
    reader.onload=e=>{
        try{
            const wb=XLSX.read(e.target.result,{type:'array'});
            const ws=wb.Sheets[wb.SheetNames[0]];
            const raw=XLSX.utils.sheet_to_json(ws,{defval:''});
            if(!raw.length){toast('File is empty','error');return;}
            if(!Object.keys(raw[0]).includes('Material Name')){
                toast('"Material Name" column not found','error');
                document.getElementById('importStatus').textContent='❌ Missing "Material Name" column.';
                return;
            }
            _importRows=raw.map(row=>({
                material_name:  String(row['Material Name']||'').trim(),
                aliases:        nv(row['Aliases']),
                description:    nv(row['Description']),
                supplier_name:  nv(row['Supplier Name']),
                supplier_code:  nv(row['Supplier Code']),
                ordered_qty:    nv(row['Ordered Qty']),
                buffer_qty:     nv(row['Buffer / Required Qty']),
                msl:            nv(row['MSL']),
                last_purchase_rate: nv(row['Last Purchase Rate (₹/kg)']) || nv(row['Last Purchase Rate']),
                hsn_code:       nv(row['HSN/SAC Code']),
                gst_rate:       nv(row['GST Rate (%)']),
                taxability:     nv(row['Taxability']),
                type_of_supply: nv(row['Type of Supply']),
                // Legacy columns — still imported if present in old files
                std_pack_size:  nv(row['Std Pack Size']),
                lead_time_days: nv(row['Lead Time (Days)']),
            })).filter(r=>r.material_name!=='');
            if(!_importRows.length){toast('No valid rows found','error');return;}
            // Validate supplier names against known directory
            const knownSuppliers = new Set(
                (typeof _supRows!=='undefined'?_supRows:[]).map(s=>(s.supplier_name||'').toLowerCase())
            );
            const unknownSuppliers = [...new Set(
                _importRows.filter(r=>r.supplier_name && !knownSuppliers.has(r.supplier_name.toLowerCase()))
                           .map(r=>r.supplier_name)
            )];
            const cols=['material_name','supplier_name','supplier_code','aliases','description','ordered_qty','msl','last_purchase_rate'];
            const labels=['Material Name','Supplier Name','Code','Aliases','Description','Ordered Qty','MSL','Rate (₹/kg)'];
            let html=`<table><thead><tr>${labels.map(l=>`<th>${l}</th>`).join('')}</tr></thead><tbody>`;
            _importRows.slice(0,8).forEach(r=>{
                const isUnknown = r.supplier_name && unknownSuppliers.includes(r.supplier_name);
                html+='<tr>'+cols.map((c,ci)=>{
                    const v = escHtml(r[c])||'—';
                    if(ci===1 && isUnknown) return `<td style="color:var(--amber-text)" title="Not in Supplier Directory">⚠ ${v}</td>`;
                    return `<td>${v}</td>`;
                }).join('')+'</tr>';
            });
            html+='</tbody></table>';
            if(unknownSuppliers.length){
                html+=`<div style="margin-top:8px;padding:7px 10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:5px;font-size:11px;color:var(--amber-text)">
                    ⚠ ${unknownSuppliers.length} supplier name${unknownSuppliers.length>1?'s':''} not found in Supplier Directory: <em>${unknownSuppliers.slice(0,3).map(s=>escHtml(s)).join(', ')}${unknownSuppliers.length>3?' +more':''}</em>.
                    They will be saved as typed.
                </div>`;
            }
            document.getElementById('importPreview').innerHTML=html;
            document.getElementById('importPreview').style.display='block';
            document.getElementById('importStatus').textContent=`✅ ${_importRows.length} rows ready.`;
            const btn=document.getElementById('importConfirmBtn');
            btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';
        }catch(err){toast('Failed to read: '+err.message,'error');}
    };
    reader.readAsArrayBuffer(file);
}
async function confirmImport(){
    if(!_importRows.length)return;
    const btn=document.getElementById('importConfirmBtn');
    btn.disabled=true;btn.textContent='Importing…';
    try{
        const res=await fetch('/api/procurement/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:_importRows})});
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        closeImportModal();
        toast(`Imported ${data.imported} · ${data.skipped} skipped`,'success');
        await loadData();
    }catch(err){toast('Import failed: '+err.message,'error');btn.disabled=false;btn.textContent='Import Data';}
}


/* ═══════════════════════ FILTER MENU ═══════════════════════ */
let _filterMenuOpen = false;

function toggleFilterMenu(){
    _filterMenuOpen = !_filterMenuOpen;
    const panel = document.getElementById('filterMenuPanel');
    const btn   = document.getElementById('filterMenuBtn');
    if(!panel) return;
    if(_filterMenuOpen){
        const rect = btn.getBoundingClientRect();
        panel.style.left = rect.left + 'px';
        panel.style.top  = (rect.bottom + 4) + 'px';
        panel.style.display = 'block';
        fmRefreshGroupItems();
        fmSyncAll();
    } else {
        panel.style.display = 'none';
    }
}
window._toggleFilterMenuFull = toggleFilterMenu;

function closeFilterMenu(){
    _filterMenuOpen = false;
    const panel = document.getElementById('filterMenuPanel');
    if(panel) panel.style.display = 'none';
}

document.addEventListener('click', e=>{
    if(_filterMenuOpen && !e.target.closest('#filterMenuWrap')) closeFilterMenu();
}, true);
window.addEventListener('resize', ()=>{ if(_filterMenuOpen) closeFilterMenu(); });

function fmToggle(id){
    const el = document.getElementById(id);
    const arrow = document.getElementById(id+'Arrow');
    if(!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if(arrow) arrow.classList.toggle('open', !open);
}

function fmRefreshGroupItems(){
    const container = document.getElementById('fmGroupItems');
    if(!container) return;
    container.innerHTML = (_matGroups||[]).map(g=>
        `<div class="fm-item" id="fmi-grp-${g.id}" onclick="fmSetGroup('${g.id}')">` +
        escHtml(g.group_name) +
        (g.mat_count ? ` <span style="font-size:9.5px;color:var(--muted)">(${g.mat_count})</span>` : '') +
        ' <span class="fm-check">\u2713</span></div>'
    ).join('');
    fmSyncGroup();
}

function fmSetStock(val){ setFilter(val); }
function fmSyncStock(){
    ['all','good','low','zero','req_nonzero','req_zero'].forEach(v=>{
        const el = document.getElementById('fmi-'+v);
        if(el) el.classList.toggle('active', _activeFilter===v);
    });
    const badge = document.getElementById('fmStockBadge');
    if(badge){ const a = _activeFilter !== 'all'; badge.style.display = a?'':'none'; if(a) badge.textContent = _activeFilter.replace('_',' '); }
}

function fmSetGroup(val){
    _colFilterValues.group = val;
    const inp = document.getElementById('colFilterGroup');
    if(inp){
        if(!val){ inp.value=''; inp.style.borderColor=''; }
        else{
            const label = val==='__none__' ? '\u2014 Ungrouped \u2014' : ((_matGroups||[]).find(g=>String(g.id)===String(val))?.group_name||val);
            inp.value = label; inp.style.borderColor = 'var(--teal-dim)';
        }
    }
    applyFilters(); fmSyncGroup(); _updateFilterDot();
}
function fmSyncGroup(){
    const val = _colFilterValues.group||'';
    document.querySelectorAll('[id^="fmi-grp-"]').forEach(el=>el.classList.remove('active'));
    const a = document.getElementById('fmi-grp-'+val); if(a) a.classList.add('active');
    const badge = document.getElementById('fmGroupBadge');
    if(badge){
        badge.style.display = val?'':'none';
        if(val) badge.textContent = val==='__none__'?'Ungrouped':((_matGroups||[]).find(g=>String(g.id)===String(val))?.group_name||val);
    }
}

function fmSetGst(val){
    _colFilterValues.gst = val; applyFilters(); fmSyncGst(); _updateFilterDot();
}
function fmSyncGst(){
    const val = _colFilterValues.gst||'';
    document.querySelectorAll('[id^="fmi-gst-"]').forEach(el=>el.classList.remove('active'));
    const a = document.getElementById('fmi-gst-'+val); if(a) a.classList.add('active');
    const badge = document.getElementById('fmGstBadge');
    if(badge){ badge.style.display=val?'':'none'; if(val) badge.textContent = val==='__none__'?'Not Set':val+'%'; }
}

function fmSetBuffer(val){
    _colFilterValues.buffer = val;
    const inp = document.getElementById('colFilterBuffer');
    if(inp){
        const labels = {positive:'\u25b2 +ve', negative:'\u25bc \u2212ve', none:'\u2014 Not set'};
        if(!val){ inp.value=''; inp.style.borderColor=''; }
        else { inp.value = labels[val]||val; inp.style.borderColor = 'var(--teal-dim)'; }
    }
    applyFilters(); fmSyncBuffer(); _updateFilterDot();
}
function fmSyncBuffer(){
    const val = _colFilterValues.buffer||'';
    document.querySelectorAll('[id^="fmi-buf-"]').forEach(el=>el.classList.remove('active'));
    const a = document.getElementById('fmi-buf-'+val); if(a) a.classList.add('active');
    const badge = document.getElementById('fmBufferBadge');
    if(badge){
        const labels={positive:'+ve',negative:'\u2212ve',none:'Not Set'};
        badge.style.display=val?'':'none'; if(val) badge.textContent=labels[val]||val;
    }
}

function fmSyncAll(){ fmSyncStock(); fmSyncGroup(); fmSyncGst(); fmSyncBuffer(); }

function _updateFilterDot(){
    const active = _activeFilter!=='all' || !!_colFilterValues.group || !!_colFilterValues.gst || !!_colFilterValues.buffer;
    const dot = document.getElementById('filterMenuDot');
    if(dot) dot.style.display = active ? 'block' : 'none';
    const btn = document.getElementById('filterMenuBtn');
    if(btn){ btn.style.borderColor = active?'var(--teal-dim)':''; btn.style.color = active?'var(--teal)':''; }
}

function clearAllFilters(){
    setFilter('all');
    _colFilterValues.buffer=''; _colFilterValues.group=''; _colFilterValues.gst=''; _colFilterValues.supplier='';
    ['colFilterMaterial','colFilterBuffer','colFilterGroup','colFilterSupplier'].forEach(id=>{
        const el = document.getElementById(id); if(el){ el.value=''; el.style.borderColor=''; }
    });
    const si = document.getElementById('searchInput'); if(si) si.value='';
    applyFilters(); fmSyncAll(); _updateFilterDot(); closeFilterMenu();
    toast('All filters cleared','info',1800);
}

/* ═══════════════════════ BULK ASSIGN GST ═══════════════════════ */
function openBulkAssignGst(){
    const sel = [..._selectedMats];
    if(!sel.length){ toast('Select at least one material','warning'); return; }
    const listEl = document.getElementById('bulkGstMatList');
    if(listEl) listEl.innerHTML =
        '<strong style="color:var(--text)">' + sel.length + ' material' + (sel.length>1?'s':'') + ' selected:</strong><br>' +
        sel.map(n=>{
            const row = _allRows.find(r=>r.material_name===n);
            const gst = (row?.gst_rate!=null && row?.gst_rate!=='')
                ? '<span style="color:var(--teal);font-weight:600">' + row.gst_rate + '%</span>'
                : '<span style="color:var(--muted)">\u2014</span>';
            return '<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 4px 0 0;padding:1px 8px;border-radius:10px;background:var(--text-08);font-size:10.5px">' + escHtml(n) + ' ' + gst + '</span>';
        }).join('');
    const selEl = document.getElementById('bulkGstSelect');
    if(selEl) selEl.value = '';
    document.getElementById('bulkGstModal').classList.add('open');
}
function closeBulkAssignGst(){ document.getElementById('bulkGstModal').classList.remove('open'); }
async function saveBulkAssignGst(){
    const gstRate = document.getElementById('bulkGstSelect').value;
    if(gstRate===''){ toast('Please select a GST rate','warning'); return; }
    const sel = [..._selectedMats];
    if(!sel.length){ toast('No materials selected','warning'); return; }
    try{
        const res = await fetch('/api/procurement/bulk_assign_gst',{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({gst_rate:gstRate, material_names:sel})
        });
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        toast('GST ' + gstRate + '% assigned to ' + data.updated + ' material' + (data.updated!==1?'s':''), 'success');
        closeBulkAssignGst();
        sel.forEach(name=>{ const r=_allRows.find(x=>x.material_name===name); if(r) r.gst_rate=parseFloat(gstRate); });
        _selectedMats.clear(); applyFilters(); loadData();
    }catch(e){ toast('Assign failed: '+e.message,'error'); }
}
