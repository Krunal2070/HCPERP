/* rm_cart.js — Linked detail, cost reports, what-if, INIT, RM requirement, cart
   Depends on: utils.js, materials.js, fvq_viewer.js */

/* ═══════════════════════════════════════════════════════
   1. LINKED BATCH DETAIL (click on 🔗 Linked badge)
═══════════════════════════════════════════════════════ */
function openLinkedDetail(elOrName, sourceBatchName){
    let batchName;
    if(elOrName && typeof elOrName === 'object' && elOrName.dataset){
        batchName       = elOrName.dataset.batch  || '';
        sourceBatchName = elOrName.dataset.source || '';
    } else { batchName = elOrName || ''; }
    document.getElementById('linkedDetailTitle').textContent = batchName;
    const sourceMeta = (_fvqBatches||[]).find(b=>b.batch_name===sourceBatchName)||{};
    document.getElementById('linkedDetailBody').innerHTML = `
        <div style="padding:4px 0">
            <div style="font-size:11px;color:var(--muted);margin-bottom:10px">This batch uses the same formulation as:</div>
            <div style="padding:12px 14px;background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.2);
                        border-radius:var(--radius-md);display:flex;align-items:center;gap:10px">
                <span style="font-size:1.4rem">🔗</span>
                <div>
                    <div style="font-weight:700;color:var(--text);font-size:13px">${escHtml(sourceBatchName)}</div>
                    ${sourceMeta.item_count?`<div style="font-size:11px;color:var(--muted);margin-top:2px">${sourceMeta.item_count} ingredients${sourceMeta.batch_size?' · '+escHtml(sourceMeta.batch_size):''}</div>`:''}
                </div>
            </div>
            <div style="margin-top:12px;font-size:11px;color:var(--muted);line-height:1.6">
                When the source formulation ingredients are updated, this batch will be asked to sync.
            </div>
        </div>`;
    const viewBtn = document.getElementById('linkedDetailViewBtn');
    viewBtn.onclick = ()=>{
        document.getElementById('linkedDetailModal').classList.remove('open');
        openFvqDetail(sourceBatchName);
    };
    document.getElementById('linkedDetailModal').classList.add('open');
}

/* ═══════════════════════════════════════════════════════
   2. LINKED FORMULATIONS REPORT
═══════════════════════════════════════════════════════ */
let _linkedReportData = [];

async function openLinkedReport(){
    document.getElementById('linkedReportModal').classList.add('open');
    document.getElementById('linkedReportTbody').innerHTML =
        '<tr><td colspan="3"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    try{
        const res  = await fetch('/api/procurement/formulations/linked_report');
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _linkedReportData = data.rows||[];
        document.getElementById('linkedReportSearch').value = '';
        renderLinkedReport();
    }catch(e){
        document.getElementById('linkedReportTbody').innerHTML =
            `<tr><td colspan="3" style="padding:24px;text-align:center;color:var(--red-text)">${escHtml(e.message)}</td></tr>`;
    }
}
function closeLinkedReport(){ document.getElementById('linkedReportModal').classList.remove('open'); }
document.getElementById('linkedReportModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('linkedReportModal')) closeLinkedReport();
});

function renderLinkedReport(){
    const q = (document.getElementById('linkedReportSearch').value||'').trim().toLowerCase();
    const rows = q ? _linkedReportData.filter(r=>
        r.batch_name.toLowerCase().includes(q) || r.source_batch_name.toLowerCase().includes(q)
    ) : _linkedReportData;
    document.getElementById('linkedReportCount').textContent = `${rows.length} link${rows.length!==1?'s':''}`;
    if(!rows.length){
        document.getElementById('linkedReportTbody').innerHTML =
            '<tr><td colspan="3"><div class="state-box"><div class="state-icon">🔗</div><h3>No linked batches yet</h3><p>Use Link Formulation to create linked batches.</p></div></td></tr>';
        return;
    }
    document.getElementById('linkedReportTbody').innerHTML = rows.map((r,i)=>`
        <tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:9px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${i+1}</td>
            <td style="padding:9px 14px;font-weight:600;color:var(--teal);border-right:1px solid var(--border);cursor:pointer"
                onclick="closeLinkedReport();openFvqDetail('${escHtml(r.source_batch_name).replace(/'/g,"\\'")}')">
                ${escHtml(r.source_batch_name)}
            </td>
            <td style="padding:9px 14px;color:var(--text);cursor:pointer;white-space:nowrap"
                onclick="closeLinkedReport();openFvqDetail('${escHtml(r.batch_name).replace(/'/g,"\\'")}')">
                <span style="margin-right:6px;font-size:10px;padding:1px 6px;border-radius:20px;background:rgba(139,92,246,.12);color:#a78bfa">🔗</span>
                ${escHtml(r.batch_name)}
            </td>
        </tr>`).join('');
}

/* ═══════════════════════════════════════════════════════
   3. BATCH COST PER KG REPORT
═══════════════════════════════════════════════════════ */
let _costPerKgData = [];

async function openCostPerKgReport(){
    document.getElementById('costPerKgModal').classList.add('open');
    document.getElementById('costPerKgTbody').innerHTML =
        '<tr><td colspan="4"><div class="state-box"><div class="spinner"></div><h3>Calculating…</h3></div></td></tr>';
    try{
        const res  = await fetch('/api/procurement/formulations/cost_per_kg');
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _costPerKgData = data.batches||[];
        document.getElementById('costPerKgSearch').value = '';
        renderCostPerKg();
    }catch(e){
        document.getElementById('costPerKgTbody').innerHTML =
            `<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--red-text)">${escHtml(e.message)}</td></tr>`;
    }
}
function closeCostPerKgReport(){ document.getElementById('costPerKgModal').classList.remove('open'); }
document.getElementById('costPerKgModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('costPerKgModal')) closeCostPerKgReport();
});

function renderCostPerKg(){
    const q = (document.getElementById('costPerKgSearch').value||'').trim().toLowerCase();
    const rows = q ? _costPerKgData.filter(r=>r.batch_name.toLowerCase().includes(q)||(r.product_code||'').toLowerCase().includes(q)) : _costPerKgData;
    document.getElementById('costPerKgCount').textContent = `${rows.length} batch${rows.length!==1?'es':''}`;
    if(!rows.length){
        document.getElementById('costPerKgTbody').innerHTML =
            '<tr><td colspan="4"><div class="state-box"><div class="state-icon">💰</div><h3>No data</h3></div></td></tr>';
        return;
    }
    document.getElementById('costPerKgTbody').innerHTML = rows.map((r,i)=>`
        <tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:9px 10px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border);text-align:center">${i+1}</td>
            <td style="padding:9px 14px;font-weight:600;color:var(--text);border-right:1px solid var(--border)">
                ${escHtml(r.batch_name)}
                ${r.missing_rate&&r.missing_rate.length?`<span title="Missing rate for: ${escHtml(r.missing_rate.join(', '))}" style="margin-left:6px;font-size:9px;padding:1px 6px;border-radius:20px;background:var(--amber-bg);color:var(--amber-text);border:1px solid rgba(245,158,11,.25)">⚠ partial</span>`:''}
            </td>
            <td style="padding:9px 12px;font-family:var(--font-mono);font-size:11px;color:var(--teal);border-right:1px solid var(--border);width:216px;min-width:216px;max-width:216px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.product_code||'—')}</td>
            <td style="padding:9px 14px;font-family:var(--font-mono);font-weight:700;color:var(--green-text);text-align:right">
                ${r.cost_per_kg?'₹ '+fmtNum(r.cost_per_kg,4):'<span class="td-dim">—</span>'}
            </td>
        </tr>`).join('');
}

function exportCostPerKgExcel(){
    if(!_costPerKgData||!_costPerKgData.length){ toast('No data to export','warning'); return; }
    const q = (document.getElementById('costPerKgSearch').value||'').trim().toLowerCase();
    const rows = q ? _costPerKgData.filter(r=>r.batch_name.toLowerCase().includes(q)||(r.product_code||'').toLowerCase().includes(q)) : _costPerKgData;
    if(!rows.length){ toast('No rows match current search','warning'); return; }

    const headers = ['#', 'Product Code', 'Batch Name', 'Cost / KG (₹)', 'Status', 'Missing Rates'];
    const wsData  = [headers];
    rows.forEach((r,i)=>{
        const isPartial = r.missing_rate && r.missing_rate.length > 0;
        wsData.push([
            i + 1,
            r.product_code || '',
            r.batch_name,
            r.cost_per_kg != null ? parseFloat(r.cost_per_kg) : '',
            isPartial ? 'Partial' : 'Complete',
            isPartial ? r.missing_rate.join(', ') : '',
        ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [{wch:5},{wch:18},{wch:60},{wch:18},{wch:12},{wch:60}];

    // Style header row
    const range = XLSX.utils.decode_range(ws['!ref']);
    for(let C = range.s.c; C <= range.e.c; C++){
        const cell = ws[XLSX.utils.encode_cell({r:0, c:C})];
        if(cell){
            if(!cell.s) cell.s = {};
            cell.s.font = {bold:true, color:{rgb:'FFFFFF'}};
            cell.s.fill = {fgColor:{rgb:'1E3A5F'}, patternType:'solid'};
            cell.s.alignment = {horizontal: C===3 ? 'right' : 'left'};
        }
    }

    // Right-align cost column (col 3), style partial rows amber
    for(let R = 1; R <= rows.length; R++){
        const costCell = ws[XLSX.utils.encode_cell({r:R, c:3})];
        if(costCell){ if(!costCell.s) costCell.s={}; costCell.s.alignment={horizontal:'right'}; costCell.s.font={bold:true}; }
        const statusCell = ws[XLSX.utils.encode_cell({r:R, c:4})];
        if(statusCell && statusCell.v === 'Partial'){
            if(!statusCell.s) statusCell.s={};
            statusCell.s.font = {color:{rgb:'B45309'}};
        }
        // Zebra stripe
        for(let C = 0; C <= 5; C++){
            const cell = ws[XLSX.utils.encode_cell({r:R, c:C})];
            if(cell){ if(!cell.s) cell.s={}; if(R%2===0){ cell.s.fill={fgColor:{rgb:'F1F5F9'},patternType:'solid'}; } }
        }
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Batch Cost per KG');
    const dateStr = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}).replace(/ /g,'-');
    XLSX.writeFile(wb, `BatchCostPerKG_${dateStr}.xlsx`);
    toast(`Exported ${rows.length} batch${rows.length!==1?'es':''}`, 'success');
}

function costPerKgWhatsApp(){
    if(!_costPerKgData||!_costPerKgData.length){ toast('No data to share','warning'); return; }
    const q = (document.getElementById('costPerKgSearch').value||'').trim().toLowerCase();
    const rows = q ? _costPerKgData.filter(r=>r.batch_name.toLowerCase().includes(q)||(r.product_code||'').toLowerCase().includes(q)) : _costPerKgData;
    if(!rows.length){ toast('No rows match current search','warning'); return; }

    const today = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const lines = [`💰 *Batch Cost per KG — HCP Wellness*`, `_${today}_`, ''];
    rows.forEach((r,i)=>{
        const code = r.product_code ? `[${r.product_code}] ` : '';
        const cost = r.cost_per_kg ? `₹ ${fmtNum(r.cost_per_kg,2)}` : '—';
        const flag = (r.missing_rate&&r.missing_rate.length) ? ' ⚠' : '';
        lines.push(`${i+1}. ${code}${r.batch_name}`);
        lines.push(`   Cost/KG: *${cost}*${flag}`);
    });
    lines.push('', `_Total: ${rows.length} batch${rows.length!==1?'es':''}_`);
    const url = 'https://web.whatsapp.com/send?text=' + encodeURIComponent(lines.join('\n'));
    window.open(url, '_blank');
}

function costPerKgEmail(){
    if(!_costPerKgData||!_costPerKgData.length){ toast('No data to share','warning'); return; }
    const q = (document.getElementById('costPerKgSearch').value||'').trim().toLowerCase();
    const rows = q ? _costPerKgData.filter(r=>r.batch_name.toLowerCase().includes(q)||(r.product_code||'').toLowerCase().includes(q)) : _costPerKgData;
    if(!rows.length){ toast('No rows match current search','warning'); return; }

    const today = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const subj  = encodeURIComponent(`Batch Cost per KG — HCP Wellness — ${today}`);
    const lines = [`Batch Cost per KG Report — HCP Wellness Pvt Ltd`, `Date: ${today}`, ''];
    rows.forEach((r,i)=>{
        const code = r.product_code ? ` (${r.product_code})` : '';
        const cost = r.cost_per_kg ? `Rs. ${fmtNum(r.cost_per_kg,2)}` : '—';
        const flag = (r.missing_rate&&r.missing_rate.length) ? ' [partial — missing rates]' : '';
        lines.push(`${i+1}. ${r.batch_name}${code}`);
        lines.push(`   Cost/KG: ${cost}${flag}`);
    });
    lines.push('', `Total: ${rows.length} batch${rows.length!==1?'es':''}`, '', 'Regards,', 'HCP Wellness Pvt Ltd');
    window.location.href = `mailto:?subject=${subj}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/* ═══════════════════════════════════════════════════════
   4. FORMULATION CHANGE LOG
═══════════════════════════════════════════════════════ */
let _changeLogData = [];

async function openChangeLog(){
    document.getElementById('changeLogModal').classList.add('open');
    // Populate batch filter
    const sel = document.getElementById('changeLogBatchFilter');
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Batches</option>' +
        (_fvqBatches||[]).map(b=>`<option value="${escHtml(b.batch_name)}">${escHtml(b.batch_name)}${b.is_active===0?' (Inactive)':''}</option>`).join('');
    if(prev) sel.value=prev;
    await loadChangeLog();
}
function closeChangeLog(){ document.getElementById('changeLogModal').classList.remove('open'); }
document.getElementById('changeLogModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('changeLogModal')) closeChangeLog();
});

async function loadChangeLog(){
    const batchFilter = document.getElementById('changeLogBatchFilter').value;
    document.getElementById('changeLogTbody').innerHTML =
        '<tr><td colspan="6"><div class="state-box"><div class="spinner"></div><h3>Loading…</h3></div></td></tr>';
    try{
        const url = '/api/procurement/formulations/changelog' + (batchFilter?'?batch_name='+encodeURIComponent(batchFilter):'');
        const res  = await fetch(url);
        const data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        _changeLogData = data.rows||[];
        document.getElementById('changeLogSearch').value='';
        renderChangeLog();
    }catch(e){
        document.getElementById('changeLogTbody').innerHTML =
            `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--red-text)">${escHtml(e.message)}</td></tr>`;
    }
}

function renderChangeLog(){
    const q = (document.getElementById('changeLogSearch').value||'').trim().toLowerCase();
    const rows = q ? _changeLogData.filter(r=>r.batch_name.toLowerCase().includes(q)) : _changeLogData;
    document.getElementById('changeLogCount').textContent = `${rows.length} record${rows.length!==1?'s':''}`;
    if(!rows.length){
        document.getElementById('changeLogTbody').innerHTML =
            '<tr><td colspan="6"><div class="state-box"><div class="state-icon">📋</div><h3>No changes logged yet</h3><p>Edit a formulation to start the log.</p></div></td></tr>';
        return;
    }
    const typeStyle = t => ({
        update: 'background:var(--teal-glow);color:var(--teal)',
        import: 'background:rgba(59,130,246,.1);color:#60a5fa',
        link:   'background:rgba(139,92,246,.1);color:#a78bfa',
    }[t]||'background:var(--text-08);color:var(--muted)');

    document.getElementById('changeLogTbody').innerHTML = rows.map((r,i)=>{
        let before=[],after=[];
        try{ before=JSON.parse(r.ingredients_before||'[]')||[]; }catch(e){}
        try{ after =JSON.parse(r.ingredients_after ||'[]')||[]; }catch(e){}
        const diff = after.length - before.length;
        const diffStr = diff>0?`+${diff} ingredient${diff>1?'s':''}`
                      : diff<0?`${diff} ingredient${Math.abs(diff)>1?'s':''}`
                      : after.length>0?`${after.length} updated`:'';
        return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:9px 12px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${r.sr_no}</td>
            <td style="padding:9px 12px;font-weight:600;color:var(--text);font-size:12px;border-right:1px solid var(--border)">${escHtml(r.batch_name)}</td>
            <td style="padding:9px 12px;border-right:1px solid var(--border)">
                <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;${typeStyle(r.change_type)}">${r.change_type||'update'}</span>
            </td>
            <td style="padding:9px 12px;font-size:11px;color:var(--muted2);border-right:1px solid var(--border)">${escHtml(r.changed_by||'—')}</td>
            <td style="padding:9px 12px;font-size:10.5px;color:var(--muted);font-family:var(--font-mono);border-right:1px solid var(--border)">${r.changed_at?String(r.changed_at).slice(0,16).replace('T',' '):'—'}</td>
            <td style="padding:9px 12px;font-size:11px;color:var(--muted2)">${diffStr||'—'}</td>
        </tr>`;
    }).join('');
}

/* ═══════════════════════════════════════════════════════
   5. COST IMPACT REPORT (shown when material rate changes)
═══════════════════════════════════════════════════════ */
let _costImpactData = null;

async function checkCostImpact(materialName, oldRate, newRate){
    if(oldRate===null||newRate===null||Math.abs(oldRate-newRate)<0.0001) return;
    try{
        const res  = await fetch('/api/procurement/formulations/cost_impact',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({material_name:materialName,old_rate:oldRate,new_rate:newRate})
        });
        const data = await res.json();
        if(data.status!=='ok'||!data.affected_batches?.length) return;
        _costImpactData = data;
        renderCostImpact(data);
        document.getElementById('costImpactModal').classList.add('open');
    }catch(e){ /* silent */ }
}

function closeCostImpact(){
    document.getElementById('costImpactModal').classList.remove('open');
    _costImpactData = null;
}
document.getElementById('costImpactModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('costImpactModal')) closeCostImpact();
});

function renderCostImpact(data){
    const batches = data.affected_batches||[];
    document.getElementById('costImpactTitle').textContent = `📈 Rate Change Impact — ${data.material_name}`;
    document.getElementById('costImpactSub').innerHTML =
        `Rate: <strong>₹ ${fmtNum(data.old_rate,4)}</strong> → <strong>₹ ${fmtNum(data.new_rate,4)}</strong> &nbsp;·&nbsp; ${batches.length} formulation${batches.length!==1?'s':''} affected`;
    document.getElementById('costImpactCount').textContent = `${batches.length} affected batch${batches.length!==1?'es':''}`;

    // Per-1KG cost = SUM(concentration × rate) for affected ingredient only
    // (already computed server-side in affected_ingredient old/new_cost)
    // We compute 1KG totals client-side across ALL ingredients for each batch
    // old_cost_per_kg and new_cost_per_kg are returned by the API
    const totalOldProc = batches.reduce((s,b)=>s+(b.old_total_cost||0),0);
    const totalNewProc = batches.reduce((s,b)=>s+(b.new_total_cost||0),0);
    const totalDiffProc = totalNewProc - totalOldProc;

    const totalOld1kg = batches.reduce((s,b)=>s+(b.old_cost_per_kg||0),0);
    const totalNew1kg = batches.reduce((s,b)=>s+(b.new_cost_per_kg||0),0);
    const totalDiff1kg = totalNew1kg - totalOld1kg;

    document.getElementById('costImpactTbody').innerHTML = batches.map((b,i)=>{
        const oldCpk  = b.old_cost_per_kg;
        const newCpk  = b.new_cost_per_kg;
        const cpkDiff = (newCpk!=null&&oldCpk!=null) ? newCpk-oldCpk : null;
        const cpkCol  = cpkDiff==null?'var(--muted)':cpkDiff>0?'var(--red-text)':'var(--green-text)';
        const procCol = b.cost_diff>0?'var(--red-text)':b.cost_diff<0?'var(--green-text)':'var(--muted)';
        return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--text-05)'" onmouseout="this.style.background=''">
            <td style="padding:9px 14px;color:var(--muted);font-family:var(--font-mono);font-size:10px;border-right:1px solid var(--border)">${i+1}</td>
            <td style="padding:9px 14px;font-weight:600;color:var(--text);border-right:1px solid var(--border2)">${escHtml(b.batch_name)}</td>
            <!-- 1KG columns -->
            <td style="padding:9px 14px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border);color:var(--muted2)">
                ${oldCpk!=null?'₹ '+fmtNum(oldCpk,4):'—'}
            </td>
            <td style="padding:9px 14px;font-family:var(--font-mono);font-weight:700;text-align:right;border-right:1px solid var(--border2);color:${cpkCol}">
                ${newCpk!=null?'₹ '+fmtNum(newCpk,4):'—'}
                ${cpkDiff!=null?`<div style="font-size:9.5px;font-weight:600">${cpkDiff>=0?'+':''}₹${fmtNum(cpkDiff,4)}</div>`:''}
            </td>
            <!-- Procurement size columns -->
            <td class="ci-proc-col" style="padding:9px 14px;font-family:var(--font-mono);color:var(--teal);text-align:right;border-right:1px solid var(--border)">${b.batch_size?fmtNum(b.batch_size,3)+' KG':'—'}</td>
            <td class="ci-proc-col" style="padding:9px 14px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border)">₹ ${fmtNum(b.old_total_cost,2)}</td>
            <td class="ci-proc-col" style="padding:9px 14px;font-family:var(--font-mono);font-weight:700;text-align:right;color:${procCol}">
                ₹ ${fmtNum(b.new_total_cost,2)}
                <div style="font-size:9.5px">${b.cost_diff>=0?'+':''}₹${fmtNum(b.cost_diff,2)}</div>
            </td>
        </tr>`;
    }).join('') +
    // Totals row
    `<tr style="background:var(--surface2);font-weight:700;border-top:2px solid var(--border2)">
        <td colspan="2" style="padding:9px 14px;border-right:1px solid var(--border2)">TOTAL</td>
        <td style="padding:9px 14px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border);color:var(--muted2)">₹ ${fmtNum(totalOld1kg,4)}</td>
        <td style="padding:9px 14px;font-family:var(--font-mono);font-weight:700;text-align:right;border-right:1px solid var(--border2);color:${totalDiff1kg>=0?'var(--red-text)':'var(--green-text)'}">${totalDiff1kg>=0?'+':''}₹ ${fmtNum(totalNew1kg,4)}</td>
        <td class="ci-proc-col" style="border-right:1px solid var(--border)"></td>
        <td class="ci-proc-col" style="padding:9px 14px;font-family:var(--font-mono);text-align:right;border-right:1px solid var(--border)">₹ ${fmtNum(totalOldProc,2)}</td>
        <td class="ci-proc-col" style="padding:9px 14px;font-family:var(--font-mono);font-weight:700;text-align:right;color:${totalDiffProc>=0?'var(--red-text)':'var(--green-text)'}">₹ ${fmtNum(totalNewProc,2)}</td>
    </tr>`;
}

/* Toggle procurement size columns visibility */
function ciToggleProcurement(show){
    document.querySelectorAll('.ci-proc-col').forEach(el=>{
        el.style.display = show ? '' : 'none';
    });
    const lbl = document.getElementById('ciProcurementGroupLabel');
    if(lbl) lbl.style.display = show ? '' : 'none';
}

function costImpactEmail(){
    if(!_costImpactData) return;
    const d        = _costImpactData;
    const mat      = d.material_name;
    const batches  = d.affected_batches||[];
    const inclProc = document.getElementById('ciIncludeProcurement')?.checked ?? true;

    // Only TO in URL — CC causes URL length overflow (Error 400)
    const to   = 'radhika@hcpwellness.in,account@hcpwellness.in,account1@hcpwellness.in';
    const ccList = 'info@hcpwellness.in, tarak@hcpwellness.in, riddhi@hcpwellness.in, operation@hcpwellness.in, support@hcpwellness.in, shital@hcpwellness.in, purchase2@hcpwellness.in, jaydip.s@hcpwellness.in, priti@hcpwellness.in';
    const subj = 'RATE INCREASE INTIMATION : ' + mat;
    const today = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});

    // Sort all batches by highest absolute cost impact per KG
    const sorted = [...batches].sort((a,b)=>{
        const da = Math.abs((a.new_cost_per_kg||0)-(a.old_cost_per_kg||0));
        const db = Math.abs((b.new_cost_per_kg||0)-(b.old_cost_per_kg||0));
        return db - da;
    });
    const TOP      = 15;
    const topBatch = sorted.slice(0, TOP);
    const hasMore  = sorted.length > TOP;

    // Build compact body — CC addresses as text, top-15 only
    let body = 'RATE INCREASE INTIMATION\n';
    body += '='.repeat(50) + '\n';
    // Show each material's old/new rate separately for multi-material
    if(d.changes && d.changes.length > 1){
        body += 'Rate Changes :\n';
        d.changes.forEach(function(c, ci){
            var oldR = c.old_rate!=null ? 'Rs.' + fmtNum(c.old_rate,4) : 'N/A';
            var newR = c.new_rate!=null ? 'Rs.' + fmtNum(c.new_rate,4) : 'N/A';
            var diff = (c.old_rate!=null && c.new_rate!=null) ? c.new_rate - c.old_rate : null;
            var pct  = (diff!=null && c.old_rate>0) ? ' (' + (diff>=0?'+':'') + ((diff/c.old_rate)*100).toFixed(2) + '%)' : '';
            body += (ci+1) + '. ' + c.material_name + '\n';
            body += '   Old: ' + oldR + '  ->  New: ' + newR + (diff!=null?' ('+(diff>=0?'+':'')+'Rs.'+fmtNum(diff,4)+')':'') + pct + '\n';
        });
    } else {
        body += 'Material : ' + mat + '\n';
        body += 'Old Rate : Rs.' + fmtNum(d.old_rate,4) + ' / KG\n';
        body += 'New Rate : Rs.' + fmtNum(d.new_rate,4) + ' / KG\n';
    }
    body += 'Date     : ' + today + '\n';
    body += 'CC       : ' + ccList + '\n';
    body += '='.repeat(50) + '\n\n';
    body += 'TOP ' + Math.min(TOP, batches.length) + ' MOST IMPACTED (Cost per 1 KG):\n';
    body += '-'.repeat(50) + '\n';
    topBatch.forEach((b,i)=>{
        const o   = b.old_cost_per_kg;
        const n   = b.new_cost_per_kg;
        const d2  = (n!=null&&o!=null) ? n-o : null;
        const ds  = d2!=null ? ' (' + (d2>=0?'+':'') + 'Rs.' + fmtNum(d2,2) + ')' : '';
        body += (i+1) + '. ' + b.batch_name + '\n';
        body += '   Rs.' + (o!=null?fmtNum(o,2):'?') + ' -> Rs.' + (n!=null?fmtNum(n,2):'?') + ds + '\n';
    });
    if(hasMore){
        body += '\n* ' + (sorted.length-TOP) + ' more formulations — see attached Excel.\n';
    }
    body += '\n' + '-'.repeat(50) + '\n';
    body += 'Please add CC manually and attach the Excel file.\n\nHCP Wellness Procurement';

    // Download full Excel (all batches, both sheets)
    _ciDownloadExcel(d, sorted, inclProc, mat, today);

    // Open Gmail compose — CC omitted from URL to stay under 2000-char limit
    setTimeout(function(){
        const gmailUrl = 'https://mail.google.com/mail/?view=cm'
            + '&to='  + encodeURIComponent(to)
            + '&su='  + encodeURIComponent(subj)
            + '&body='+ encodeURIComponent(body);
        window.open(gmailUrl, '_blank');
    }, 500);

    toast('Excel downloaded \u00b7 Gmail opening \u00b7 Add CC & attach the Excel file', 'success', 8000);
}

function _ciDownloadExcel(d, batches, inclProc, mat, today){
    const wb = XLSX.utils.book_new();

    // Sheet 1: Cost Per KG — all batches
    const h1 = ['RATE INCREASE INTIMATION — ' + mat];
    const h2 = ['Date: ' + today + '  |  Old Rate: Rs.' + fmtNum(d.old_rate,4) + '  |  New Rate: Rs.' + fmtNum(d.new_rate,4)];
    const cpkRows = [h1, h2, [],
        ['#','Batch Name','Old Cost/KG (Rs.)','New Cost/KG (Rs.)','Diff (Rs.)','Diff (%)']
    ];
    batches.forEach((b,i)=>{
        const o    = b.old_cost_per_kg||0;
        const n    = b.new_cost_per_kg||0;
        const diff = n - o;
        const pct  = o>0 ? +((diff/o)*100).toFixed(2) : '';
        cpkRows.push([i+1, b.batch_name,
            o ? +fmtNum(o,4).replace(/,/g,'') : '',
            n ? +fmtNum(n,4).replace(/,/g,'') : '',
            +fmtNum(diff,4).replace(/,/g,''),
            pct
        ]);
    });
    const ws1 = XLSX.utils.aoa_to_sheet(cpkRows);
    ws1['!cols'] = [{wch:4},{wch:44},{wch:18},{wch:18},{wch:14},{wch:10}];
    ws1['!merges'] = [{s:{r:0,c:0},e:{r:0,c:5}},{s:{r:1,c:0},e:{r:1,c:5}}];
    XLSX.utils.book_append_sheet(wb, ws1, 'Cost Per KG');

    // Sheet 2: Procurement Size Cost
    if(inclProc){
        const pb = batches.filter(b=>b.batch_size);
        if(pb.length){
            const procRows = [h1, h2, [],
                ['#','Batch Name','Batch Size (KG)','Old Cost (Rs.)','New Cost (Rs.)','Diff (Rs.)']
            ];
            pb.forEach((b,i)=>{
                const diff = b.cost_diff||0;
                procRows.push([i+1, b.batch_name,
                    +String(b.batch_size).replace(/[^\d.]/g,''),
                    +fmtNum(b.old_total_cost,2).replace(/,/g,''),
                    +fmtNum(b.new_total_cost,2).replace(/,/g,''),
                    +fmtNum(diff,2).replace(/,/g,'')
                ]);
            });
            const ws2 = XLSX.utils.aoa_to_sheet(procRows);
            ws2['!cols'] = [{wch:4},{wch:44},{wch:16},{wch:20},{wch:20},{wch:14}];
            ws2['!merges'] = [{s:{r:0,c:0},e:{r:0,c:5}},{s:{r:1,c:0},e:{r:1,c:5}}];
            XLSX.utils.book_append_sheet(wb, ws2, 'Procurement Cost');
        }
    }

    const fname = 'Rate_Impact_' + mat.replace(/[^a-zA-Z0-9]/g,'_') + '_' + new Date().toISOString().slice(0,10) + '.xlsx';
    XLSX.writeFile(wb, fname);
}

/* ── Hook saveEditModal to trigger cost impact check ─────────────────────────*/

/* ═══════════════════════════════════════════════════════
   COST IMPACT — WHAT-IF MODAL
   User selects a material + proposed new rate.
   Shows old rate, computes diff, generates the report.
   Rate is NEVER saved to DB — preview only.
═══════════════════════════════════════════════════════ */
let _ciAcIdx = -1;

/* ═══════════════════════════════════════════════════════
   COST IMPACT — MULTI-MATERIAL WHAT-IF
   Rows built with string concat (no template literals)
   to avoid backtick imbalance with _buildPrintHtml.
═══════════════════════════════════════════════════════ */
let _ciRows = [];      // [{matName, oldRate, newRate}]
let _ciRowIdx = 0;

function openCostImpactWhatIf(){
    _ciRows = [];
    _ciRowIdx = 0;
    document.getElementById('ciRowsContainer').innerHTML = '';
    ciAddRow();
    ciCheckReady();
    document.getElementById('costImpactWhatIfModal').classList.add('open');
    setTimeout(function(){ var inp = document.querySelector('#ciRowsContainer .ci-mat-inp'); if(inp) inp.focus(); }, 60);
}

function closeCostImpactWhatIf(){
    document.getElementById('costImpactWhatIfModal').classList.remove('open');
}
document.getElementById('costImpactWhatIfModal').addEventListener('click', function(e){
    if(e.target === document.getElementById('costImpactWhatIfModal')) closeCostImpactWhatIf();
});

/* Build one row using createElement — zero backticks */
function ciAddRow(){
    var container = document.getElementById('ciRowsContainer');
    var n = _ciRowIdx++;
    var isEven = (container.childElementCount % 2 === 0);

    var wrap = document.createElement('div');
    wrap.id = 'ciRow' + n;
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr 200px 32px;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);align-items:center;background:' + (isEven ? 'transparent' : 'var(--surface2)');

    // Material input cell
    var matCell = document.createElement('div');
    matCell.className = 'uf-ac-wrap';
    matCell.style.position = 'relative';

    var matInp = document.createElement('input');
    matInp.type = 'text';
    matInp.autocomplete = 'off';
    matInp.className = 'ci-mat-inp form-input';
    matInp.placeholder = 'Search material…';
    matInp.dataset.row = n;
    matInp.style.cssText = 'height:32px;padding:0 10px;font-size:12px';
    matInp.addEventListener('input',  function(){ ciRowFilter(this); });
    matInp.addEventListener('focus',  function(){ ciRowFilter(this); });
    matInp.addEventListener('keydown',function(e){ ciRowKeydown(e, this); });
    matInp.addEventListener('blur',   function(){ var r=this.dataset.row; setTimeout(function(){ ciRowCloseDd(r); }, 150); });

    var matHidden = document.createElement('input');
    matHidden.type = 'hidden';
    matHidden.className = 'ci-mat-val';
    matHidden.dataset.rate = '';

    var dd = document.createElement('div');
    dd.className = 'uf-ac-dd';
    dd.id = 'ciDd' + n;
    dd.style.zIndex = '10002';

    matCell.appendChild(matInp);
    matCell.appendChild(matHidden);
    matCell.appendChild(dd);

    // Rate input cell
    var rateCell = document.createElement('div');
    rateCell.className = 'form-input-pfx';
    rateCell.style.margin = '0';

    var ratePfx = document.createElement('span');
    ratePfx.className = 'pfx-tag';
    ratePfx.textContent = '₹';

    var rateInp = document.createElement('input');
    rateInp.type = 'number';
    rateInp.step = '0.0001';
    rateInp.min = '0';
    rateInp.className = 'ci-rate-inp form-input';
    rateInp.placeholder = 'New rate';
    rateInp.dataset.row = n;
    rateInp.style.cssText = 'height:32px;font-size:12px;font-family:var(--font-mono);text-align:right';
    rateInp.addEventListener('input', ciCheckReady);

    rateCell.appendChild(ratePfx);
    rateCell.appendChild(rateInp);

    // Remove button
    var rmBtn = document.createElement('button');
    rmBtn.title = 'Remove';
    rmBtn.textContent = '✕';
    rmBtn.style.cssText = 'width:26px;height:26px;border-radius:50%;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;justify-self:center';
    rmBtn.addEventListener('mouseover', function(){ this.style.color='var(--red-text)'; this.style.borderColor='var(--red-text)'; });
    rmBtn.addEventListener('mouseout',  function(){ this.style.color='var(--muted)';    this.style.borderColor='var(--border2)'; });
    rmBtn.addEventListener('click', function(){ ciRemoveRow(n); });

    wrap.appendChild(matCell);
    wrap.appendChild(rateCell);
    wrap.appendChild(rmBtn);

    // Old rate info row (hidden until material selected)
    var infoRow = document.createElement('div');
    infoRow.style.cssText = 'grid-column:1/-1;padding:0 2px 4px 2px';
    var oldRateSpan = document.createElement('span');
    oldRateSpan.className = 'ci-old-rate';
    oldRateSpan.style.cssText = 'display:none;font-size:10.5px;color:var(--muted);font-family:var(--font-mono)';
    infoRow.appendChild(oldRateSpan);
    wrap.appendChild(infoRow);
    // Make wrap a proper grid with subrow
    wrap.style.gridTemplateColumns = '1fr 200px 32px';
    wrap.style.gridTemplateRows = 'auto auto';

    container.appendChild(wrap);
    matInp.focus();
}

function ciRemoveRow(n){
    var container = document.getElementById('ciRowsContainer');
    if(container.childElementCount <= 1){ toast('Keep at least one row','warning'); return; }
    var row = document.getElementById('ciRow'+n);
    if(row) row.remove();
    // Re-stripe
    var rows = container.children;
    for(var i=0;i<rows.length;i++) rows[i].style.background = i%2===0?'transparent':'var(--surface2)';
    ciCheckReady();
}

/* Autocomplete per row */
var _ciAcFocused = {};

function ciRowFilter(inp){
    var n  = inp.dataset.row;
    var q  = (inp.value||'').trim().toLowerCase();
    var dd = document.getElementById('ciDd'+n);
    var hid = inp.parentElement.querySelector('.ci-mat-val');
    if(hid) hid.value = '';
    ciCheckReady();
    if(!dd) return;
    var matches = (_allRows||[]).filter(function(m){ return (m.material_name||'').toLowerCase().indexOf(q)>=0; }).slice(0,14);
    if(!matches.length){ dd.innerHTML = q?'<div style="padding:9px 12px;color:var(--muted);font-size:11px">No materials found</div>':''; dd.classList.toggle('open',!!q); return; }
    _ciAcFocused[n] = -1;
    var html2 = '';
    matches.forEach(function(m,i){
        var name = escHtml(m.material_name||'');
        var rate = m.last_purchase_rate!=null ? '₹'+fmtNum(m.last_purchase_rate,4)+'/KG' : 'No rate';
        var rval = m.last_purchase_rate!=null ? m.last_purchase_rate : '';
        html2 += '<div class="uf-ac-item" data-mat="'+name+'" data-rate="'+rval+'" data-row="'+n+'" onmousedown="ciRowPick(event,this)"><span class="uf-ac-mat">'+name+'</span><span class="uf-ac-sup">'+rate+'</span></div>';
    });
    dd.innerHTML = html2;
    dd.classList.add('open');
}

function ciRowPick(e, item){
    if(e) e.preventDefault();
    var n   = item.dataset.row;
    var mat = item.dataset.mat;
    var rt  = item.dataset.rate;
    var row = document.getElementById('ciRow'+n);
    if(!row) return;
    var inp = row.querySelector('.ci-mat-inp');
    var hid = row.querySelector('.ci-mat-val');
    var rateInp = row.querySelector('.ci-rate-inp');
    if(inp) inp.value = mat;
    if(hid){ hid.value = mat; hid.dataset.rate = rt; }
    if(rateInp && !rateInp.value && rt) rateInp.value = rt;
    // Show old rate and wire up live diff
    var oldRateDiv = row.querySelector('.ci-old-rate');
    if(oldRateDiv){
        if(rt && parseFloat(rt) > 0){
            oldRateDiv.innerHTML = '<span style="color:var(--muted)">Current: <strong style="font-family:var(--font-mono)">₹' + fmtNum(parseFloat(rt), 4) + '</strong></span>';
            oldRateDiv.style.display = 'flex';
            oldRateDiv.style.gap = '10px';
            oldRateDiv.style.alignItems = 'center';
        } else {
            oldRateDiv.innerHTML = '<span style="color:var(--amber-text)">No rate set in database</span>';
            oldRateDiv.style.display = 'flex';
        }
    }
    // Wire live diff to the rate input
    if(rateInp){
        rateInp.addEventListener('input', function(){
            ciUpdateDiff(this, parseFloat(rt)||0, row);
        });
    }
    ciRowCloseDd(n);
    ciCheckReady();
    if(rateInp) setTimeout(function(){ rateInp.focus(); }, 40);
}

function ciRowCloseDd(n){
    var dd = document.getElementById('ciDd'+n);
    if(dd){ dd.innerHTML=''; dd.classList.remove('open'); }
    _ciAcFocused[n] = -1;
}

function ciRowKeydown(e, inp){
    var n     = inp.dataset.row;
    var dd    = document.getElementById('ciDd'+n);
    var items = dd ? Array.from(dd.querySelectorAll('.uf-ac-item')) : [];
    if(!dd || !dd.classList.contains('open') || !items.length){
        if(e.key==='Escape') ciRowCloseDd(n);
        return;
    }
    if(!_ciAcFocused[n]) _ciAcFocused[n] = -1;
    if(e.key==='ArrowDown'){
        e.preventDefault();
        _ciAcFocused[n] = Math.min(_ciAcFocused[n]+1, items.length-1);
        items.forEach(function(el,i){ el.classList.toggle('focused', i===_ciAcFocused[n]); });
        if(items[_ciAcFocused[n]]) items[_ciAcFocused[n]].scrollIntoView({block:'nearest'});
    } else if(e.key==='ArrowUp'){
        e.preventDefault();
        _ciAcFocused[n] = Math.max(_ciAcFocused[n]-1, 0);
        items.forEach(function(el,i){ el.classList.toggle('focused', i===_ciAcFocused[n]); });
        if(items[_ciAcFocused[n]]) items[_ciAcFocused[n]].scrollIntoView({block:'nearest'});
    } else if(e.key==='Enter' || e.key==='Tab'){
        if(_ciAcFocused[n]>=0 && items[_ciAcFocused[n]]){
            e.preventDefault();
            ciRowPick(null, items[_ciAcFocused[n]]);
        } else { ciRowCloseDd(n); }
    } else if(e.key==='Escape'){
        ciRowCloseDd(n);
    }
}

function ciCheckReady(){
    var rows  = document.querySelectorAll('#ciRowsContainer > div');
    var valid = 0;
    rows.forEach(function(row){
        var mat  = (row.querySelector('.ci-mat-val')  ? row.querySelector('.ci-mat-val').value  : '').trim();
        var rate = (row.querySelector('.ci-rate-inp') ? row.querySelector('.ci-rate-inp').value : '').trim();
        if(mat && rate && parseFloat(rate)>=0) valid++;
    });
    var btn = document.getElementById('ciGenerateBtn');
    btn.disabled      = valid===0;
    btn.style.opacity = valid>0 ? '1' : '.45';
    btn.style.cursor  = valid>0 ? 'pointer' : 'not-allowed';
}

function ciUpdateDiff(rateInp, oldRate, row){
    var newRate = parseFloat(rateInp.value);
    var oldRateDiv = row.querySelector('.ci-old-rate');
    if(!oldRateDiv) return;
    // Remove old diff span if exists
    var existingDiff = oldRateDiv.querySelector('.ci-diff-span');
    if(existingDiff) existingDiff.remove();
    if(isNaN(newRate) || oldRate <= 0) return;
    var diff = newRate - oldRate;
    var pct  = ((diff / oldRate) * 100).toFixed(2);
    var isUp = diff >= 0;
    var diffSpan = document.createElement('span');
    diffSpan.className = 'ci-diff-span';
    diffSpan.style.cssText = 'font-size:11px;font-weight:700;font-family:var(--font-mono);color:' + (isUp ? 'var(--red-text)' : 'var(--green-text)');
    diffSpan.textContent = (isUp ? '▲ +' : '▼ ') + '₹' + fmtNum(Math.abs(diff), 4) + '  (' + (isUp ? '+' : '') + pct + '%)';
    oldRateDiv.appendChild(diffSpan);
}

async function ciGenerate(){
    var rows    = document.querySelectorAll('#ciRowsContainer > div');
    var changes = [];
    rows.forEach(function(row){
        var matName  = (row.querySelector('.ci-mat-val')  ? row.querySelector('.ci-mat-val').value  : '').trim();
        var newRateS = (row.querySelector('.ci-rate-inp') ? row.querySelector('.ci-rate-inp').value : '').trim();
        if(!matName || !newRateS) return;
        var newRate = parseFloat(newRateS);
        if(isNaN(newRate) || newRate<0) return;
        var rtStr = row.querySelector('.ci-mat-val') ? row.querySelector('.ci-mat-val').dataset.rate : '';
        var oldRate = rtStr ? parseFloat(rtStr) : null;
        if(isNaN(oldRate)) oldRate = null;
        changes.push({material_name:matName, old_rate:oldRate, new_rate:newRate});
    });
    if(!changes.length){ toast('Add at least one valid material + rate','warning'); return; }
    var btn = document.getElementById('ciGenerateBtn');
    btn.disabled=true; btn.textContent='Generating…';
    try{
        var isSingle  = changes.length===1;
        var endpoint  = isSingle ? '/api/procurement/formulations/cost_impact' : '/api/procurement/formulations/cost_impact_multi';
        var payload   = isSingle
            ? {material_name:changes[0].material_name, old_rate:changes[0].old_rate, new_rate:changes[0].new_rate}
            : {changes:changes};
        var res  = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        var data = await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        closeCostImpactWhatIf();
        if(!data.affected_batches || !data.affected_batches.length){
            toast('No formulations affected','info',4000);
            return;
        }
        _costImpactData = {
            material_name: changes.map(function(c){return c.material_name;}).join(' + '),
            old_rate: isSingle ? changes[0].old_rate : null,
            new_rate: isSingle ? changes[0].new_rate : null,
            changes:  changes,
            affected_batches: data.affected_batches
        };
        renderCostImpact(_costImpactData);
        document.getElementById('costImpactModal').classList.add('open');
    }catch(err){
        toast('Failed: '+err.message,'error');
    }finally{
        btn.disabled=false; btn.textContent='Generate Report';
    }
}



async function deleteFvqBatch(batchName){
    if(!confirm(`Delete all rows for batch:\n"${batchName}"?\n\nThis cannot be undone.`))return;
    try{
        const res=await fetch('/api/procurement/formulations/delete_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_name:batchName})});
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        toast('Deleted: '+batchName,'success');
        await loadFvqData();
    }catch(err){toast('Delete failed: '+err.message,'error');}
}

/* Override switchTab to lazy-load fvq */
const _origSwitchTab=switchTab;
window.switchTab=function(id){_origSwitchTab(id);if(id==='fvq'&&_fvqBatches.length===0)loadFvqData();};

/* ═══════════════════════ INIT ═══════════════════════ */

/* ═══════════════════════════════════════════════════════
   ADMIN RESET  — 3-layer + 120-second countdown
   Uses only DOM methods, NO template literals.
═══════════════════════════════════════════════════════ */
var _arLayer  = 1;
var _arScope  = [];
var _arTimer  = null;
var _arSecs   = 120;
var _arLabels = {
    formulations: 'Formulations (procurement_formulations)',
    materials:    'Materials & Suppliers (procurement_materials)',
    update_log:   'Procurement Log (procurement_update_log)',
    changelog:    'Change Log (procurement_formulation_changelog)',
    settings:     'Settings (procurement_settings)'
};

function openAdminReset(){
    var role = (document.querySelector('.user-role') ? document.querySelector('.user-role').textContent : '').trim().toLowerCase();
    if(role !== 'admin'){ toast('Admin access only','error'); return; }
    _arLayer = 1; _arScope = []; _arSecs = 120;
    clearInterval(_arTimer);
    // Reset layers
    document.getElementById('arLayer1').style.display = 'block';
    document.getElementById('arLayer2').style.display = 'none';
    document.getElementById('arLayer3').style.display = 'none';
    // Uncheck all
    document.querySelectorAll('.ar-scope-item input').forEach(function(cb){ cb.checked = false; });
    document.querySelectorAll('.ar-scope-item').forEach(function(el){ el.classList.remove('ar-selected'); });
    // Reset phrase
    document.getElementById('arPhraseInput').value = '';
    document.getElementById('arPhraseHint').textContent = '';
    // Reset button
    var btn = document.getElementById('arActionBtn');
    btn.textContent = 'Next \u2192';
    btn.disabled = true; btn.style.opacity = '.4'; btn.style.cursor = 'not-allowed';
    btn.style.background = 'rgba(244,63,94,.1)'; btn.style.color = 'var(--red-text)';
    btn.style.border = '1px solid rgba(244,63,94,.35)';
    btn.onclick = arNextLayer;
    document.getElementById('arFootHint').textContent = 'Select data to delete above';
    document.getElementById('adminResetModal').classList.add('open');
}

function closeAdminReset(){
    clearInterval(_arTimer);
    document.getElementById('adminResetModal').classList.remove('open');
}
document.getElementById('adminResetModal').addEventListener('click', function(e){
    if(e.target === document.getElementById('adminResetModal')) closeAdminReset();
});

function arToggle(cb){
    var label = cb.closest('.ar-scope-item');
    if(label) label.classList.toggle('ar-selected', cb.checked);
    _arScope = [];
    document.querySelectorAll('.ar-scope-item input:checked').forEach(function(c){ _arScope.push(c.value); });
    var btn = document.getElementById('arActionBtn');
    btn.disabled      = _arScope.length === 0;
    btn.style.opacity = _arScope.length > 0 ? '1' : '.4';
    btn.style.cursor  = _arScope.length > 0 ? 'pointer' : 'not-allowed';
    document.getElementById('arFootHint').textContent = _arScope.length > 0
        ? _arScope.length + ' item' + (_arScope.length > 1 ? 's' : '') + ' selected'
        : 'Select data to delete above';
}

function arNextLayer(){
    if(_arLayer === 1){
        if(!_arScope.length){ toast('Select at least one item to delete','warning'); return; }
        var scopeText = _arScope.map(function(k){ return _arLabels[k] || k; }).join('\n');
        document.getElementById('arScopeLabel').textContent = scopeText;
        document.getElementById('arLayer1').style.display = 'none';
        document.getElementById('arLayer2').style.display = 'block';
        var btn = document.getElementById('arActionBtn');
        btn.disabled = true; btn.style.opacity = '.4'; btn.style.cursor = 'not-allowed';
        document.getElementById('arFootHint').textContent = 'Type the confirmation phrase';
        _arLayer = 2;
        setTimeout(function(){ document.getElementById('arPhraseInput').focus(); }, 60);

    } else if(_arLayer === 2){
        document.getElementById('arFinalLabel').textContent = _arScope.map(function(k){ return _arLabels[k]||k; }).join('  +  ');
        document.getElementById('arLayer2').style.display = 'none';
        document.getElementById('arLayer3').style.display = 'block';
        var btn = document.getElementById('arActionBtn');
        btn.textContent = '\uD83D\uDDD1 Delete Now';
        btn.disabled = true; btn.style.opacity = '.4'; btn.style.cursor = 'not-allowed';
        btn.onclick = arExecuteReset;
        document.getElementById('arFootHint').textContent = 'Wait for the countdown to complete\u2026';
        _arLayer = 3;
        _arSecs = 120;
        document.getElementById('arCountdownNum').textContent = '120';
        document.getElementById('arCountdownBar').style.width = '100%';
        _arTimer = setInterval(function(){
            _arSecs--;
            document.getElementById('arCountdownNum').textContent = _arSecs;
            document.getElementById('arCountdownBar').style.width = (_arSecs / 120 * 100) + '%';
            if(_arSecs <= 0){
                clearInterval(_arTimer);
                var b = document.getElementById('arActionBtn');
                b.disabled = false; b.style.opacity = '1'; b.style.cursor = 'pointer';
                b.style.background = 'var(--red-text)'; b.style.color = '#fff';
                b.style.border = 'none';
                document.getElementById('arFootHint').textContent = '\u26a0 Now active \u2014 this will permanently delete selected data!';
                document.getElementById('arCountdownNum').style.color = '#fff';
            }
        }, 1000);
    }
}

function arCheckPhrase(){
    var ok = document.getElementById('arPhraseInput').value.trim() === 'DELETE CONFIRM';
    var btn = document.getElementById('arActionBtn');
    var hint = document.getElementById('arPhraseHint');
    btn.disabled      = !ok;
    btn.style.opacity = ok ? '1' : '.4';
    btn.style.cursor  = ok ? 'pointer' : 'not-allowed';
    if(ok){
        hint.textContent = '\u2713 Confirmed \u2014 click Next to start countdown';
        hint.style.color = 'var(--green-text)';
    } else {
        hint.textContent = '';
    }
}

async function arExecuteReset(){
    clearInterval(_arTimer);
    var btn = document.getElementById('arActionBtn');
    btn.disabled = true; btn.textContent = 'Deleting\u2026';
    try{
        var res = await fetch('/api/procurement/admin/reset', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({scope: _arScope, confirm_token: 'CONFIRM-DELETE'})
        });
        var data = await res.json();

        // Handle fully blocked (nothing deleted)
        if (data.status === 'blocked') {
            var reasons = Object.values(data.blocked||{}).join('\n\n');
            _arShowBlockedResult(data.blocked, data.deleted);
            btn.disabled = false; btn.textContent = '\uD83D\uDDD1 Delete Now';
            return;
        }

        // Handle partial (some succeeded, some blocked)
        if (data.status === 'partial') {
            _arShowBlockedResult(data.blocked, data.deleted);
            await loadData(); await loadFvqData();
            return;
        }

        if (data.status !== 'ok') throw new Error(data.message);

        closeAdminReset();
        var summary = Object.entries(data.deleted||{}).map(function(e){ return e[0]+': '+e[1]+' rows'; }).join(' \u00b7 ');
        toast('Reset complete \u2014 ' + summary, 'success', 8000);
        await loadData();
        await loadFvqData();
    } catch(err){
        toast('Reset failed: ' + err.message, 'error');
        btn.disabled = false; btn.textContent = '\uD83D\uDDD1 Delete Now';
        btn.style.background = 'var(--red-text)'; btn.style.color = '#fff';
    }
}

function _arShowBlockedResult(blocked, deleted) {
    // Replace layer 3 content with result report
    var layer3 = document.getElementById('arLayer3');
    if (!layer3) return;

    var deletedKeys = Object.keys(deleted||{});
    var blockedEntries = Object.entries(blocked||{});

    var html = '<div style="text-align:left;padding:4px 0">';

    if (blockedEntries.length) {
        html += '<div style="background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.3);border-radius:8px;padding:12px 14px;margin-bottom:12px">';
        html += '<div style="font-size:11px;font-weight:800;color:var(--red-text);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">&#9888; Could Not Clear</div>';
        blockedEntries.forEach(function(e){
            html += '<div style="font-size:12px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(244,63,94,.15)">'
                 +  '<strong style="color:var(--red-text)">' + escHtml(e[0]) + '</strong>'
                 +  '<br><span style="color:var(--muted);font-size:11px">' + escHtml(e[1]) + '</span>'
                 +  '</div>';
        });
        html += '</div>';
    }

    if (deletedKeys.length) {
        html += '<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);border-radius:8px;padding:12px 14px">';
        html += '<div style="font-size:11px;font-weight:800;color:var(--green-text);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">&#10003; Successfully Cleared</div>';
        deletedKeys.forEach(function(k){
            html += '<div style="font-size:12px;color:var(--text);margin-bottom:3px">&#10003; ' + escHtml(k) + '</div>';
        });
        html += '</div>';
    }

    html += '</div>';
    html += '<button onclick="closeAdminReset()" style="margin-top:16px;width:100%;height:36px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-body)">Close</button>';

    layer3.innerHTML = html;
}


/* ═══════════════════════════════════════════════════════
   RM REQUIREMENT — cart-style batch selection
   Zero backticks throughout.
═══════════════════════════════════════════════════════ */
var _rmData      = null;
var _rmFiltered  = [];
var _rmSortMode  = 'name';
var _rmShortOnly = false;
var _rmCart      = [];
var _rmAcIdx     = -1;

function openRMRequirement(){
    if(!_fvqBatches||!_fvqBatches.length){ toast('No formulations available','warning'); return; }
    _rmData=null; _rmFiltered=[]; _rmSortMode='name'; _rmShortOnly=false;
    // Try to restore draft — keep existing cart if already populated
    if(!_rmCart.length){
        var hadDraft = rmLoadDraft();
        if(hadDraft){
            toast('Draft restored — '+_rmCart.length+' batch'+(_rmCart.length!==1?'es':'')+' from last session','info',3000);
        }
    }
    document.getElementById('rmPossibleBtn').style.display='none';
    document.getElementById('rmStep1').style.display='flex';
    document.getElementById('rmStep2').style.display='none';
    document.getElementById('rmBatchSearch').value='';
    document.getElementById('rmSearch').value='';
    var btn=document.getElementById('rmGenerateBtn');
    btn.disabled=true; btn.style.opacity='.45'; btn.style.cursor='not-allowed';
    btn.textContent='Generate Report'; btn.onclick=rmGenerate;
    rmRenderCart();
    document.getElementById('rmReqModal').classList.add('open');
    setTimeout(function(){ document.getElementById('rmBatchSearch').focus(); },60);
}
function closeRMRequirement(){ document.getElementById('rmReqModal').classList.remove('open'); }
document.getElementById('rmReqModal').addEventListener('click',function(e){
    if(e.target===document.getElementById('rmReqModal')) closeRMRequirement();
});

/* ── Search dropdown ── */
function rmSearchFilter(inp){
    var q=(inp.value||'').trim().toLowerCase();
    var dd=document.getElementById('rmSearchDd');
    if(!q){ dd.innerHTML=''; dd.classList.remove('open'); return; }
    var matches=(_fvqBatches||[]).filter(function(b){
        return b.batch_name.toLowerCase().includes(q)||(b.product_code||'').toLowerCase().includes(q);
    }).slice(0,16);
    if(!matches.length){ dd.innerHTML='<div style="padding:10px 14px;color:var(--muted);font-size:11px">No batches found</div>'; dd.classList.add('open'); _rmAcIdx=-1; return; }
    _rmAcIdx=-1;
    var h='';
    matches.forEach(function(b,i){
        var bs=b.batch_size?parseFloat(String(b.batch_size).replace(/[^0-9.]/g,'')):null;
        var bsLabel=bs?fmtNum(bs,3)+' KG':'<span style="color:var(--amber-text);font-size:10px">No size</span>';
        h+='<div class="uf-ac-item" style="display:flex;align-items:center;justify-content:space-between;gap:8px" onmousedown="rmCartAdd(event,\''+escHtml(b.batch_name).replace(/'/g,"\\'")+'\','+( bs||'null' )+')">'
         +'<div style="min-width:0"><div style="font-size:12px;font-weight:600;color:var(--text)">'+escHtml(b.batch_name)+'</div>'
         +(b.product_code?'<div style="font-size:10px;color:var(--muted)">'+escHtml(b.product_code)+'</div>':'')+'</div>'
         +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">'
         +'<span style="font-size:10.5px;font-family:var(--font-mono);color:var(--muted2)">'+bsLabel+'</span>'
         +'<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:var(--teal-glow);color:var(--teal)">+ Add</span>'
         +'</div></div>';
    });
    dd.innerHTML=h; dd.classList.add('open');
}
function rmSearchClose(){ var dd=document.getElementById('rmSearchDd'); if(dd){dd.innerHTML='';dd.classList.remove('open');} _rmAcIdx=-1; }
function rmSearchKeydown(e){
    var dd=document.getElementById('rmSearchDd');
    var items=dd?Array.from(dd.querySelectorAll('.uf-ac-item')):[];
    if(!dd||!dd.classList.contains('open')||!items.length){ if(e.key==='Escape') rmSearchClose(); return; }
    if(e.key==='ArrowDown'){ e.preventDefault(); _rmAcIdx=Math.min(_rmAcIdx+1,items.length-1); items.forEach(function(el,i){el.classList.toggle('focused',i===_rmAcIdx);}); if(items[_rmAcIdx])items[_rmAcIdx].scrollIntoView({block:'nearest'}); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); _rmAcIdx=Math.max(_rmAcIdx-1,0); items.forEach(function(el,i){el.classList.toggle('focused',i===_rmAcIdx);}); if(items[_rmAcIdx])items[_rmAcIdx].scrollIntoView({block:'nearest'}); }
    else if(e.key==='Enter'){ e.preventDefault(); if(_rmAcIdx>=0&&items[_rmAcIdx]) items[_rmAcIdx].dispatchEvent(new MouseEvent('mousedown')); }
    else if(e.key==='Escape') rmSearchClose();
}

/* ── Cart ── */
function rmCartAdd(e, batchName, defaultSize){
    if(e) e.preventDefault();
    _rmCart.push({batch_name:batchName, batch_size:defaultSize});
    document.getElementById('rmBatchSearch').value='';
    rmSearchClose();
    rmRenderCart();
}
function rmCartRemove(idx){ _rmCart.splice(idx,1); rmRenderCart(); }
function rmCartClear(){ _rmCart=[]; rmRenderCart(); }

function rmRenderCart(){
    var container=document.getElementById('rmCartList');
    var empty=document.getElementById('rmCartEmpty');
    var countEl=document.getElementById('rmCartCount');
    var selCount=document.getElementById('rmSelectedCount');
    var btn=document.getElementById('rmGenerateBtn');
    countEl.textContent=_rmCart.length?'('+_rmCart.length+')':'';
    selCount.textContent=_rmCart.length+' batch'+(_rmCart.length!==1?'es':'')+' in list';
    btn.disabled=_rmCart.length===0; btn.style.opacity=_rmCart.length>0?'1':'.45'; btn.style.cursor=_rmCart.length>0?'pointer':'not-allowed';
    var upBtn=document.getElementById('rmUpdateProcBtn'); if(upBtn){upBtn.style.display=_rmCart.length?'':'none';}
    if(!_rmCart.length){ if(empty)empty.style.display='block'; Array.from(container.children).forEach(function(c){if(c.id!=='rmCartEmpty')c.remove();}); return; }
    if(empty)empty.style.display='none';
    Array.from(container.children).forEach(function(c){if(c.id!=='rmCartEmpty')c.remove();});
    // Auto-save draft
    rmSaveDraft();
    _rmCart.forEach(function(item,idx){
        var row=document.createElement('div');
        row.style.cssText='display:grid;grid-template-columns:1fr 160px 32px;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);background:'+(idx%2===0?'transparent':'var(--surface2)');
        var nameDiv=document.createElement('div');
        var nameEl=document.createElement('div'); nameEl.style.cssText='font-size:12px;font-weight:600;color:var(--text)'; nameEl.textContent=item.batch_name;
        nameDiv.appendChild(nameEl);
        var sizeWrap=document.createElement('div'); sizeWrap.style.cssText='display:flex;align-items:center;border:1px solid var(--border2);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface2)';
        var pfx=document.createElement('span'); pfx.style.cssText='padding:0 8px;font-size:10px;font-weight:700;color:var(--muted);background:var(--surface2);border-right:1px solid var(--border2);white-space:nowrap;flex-shrink:0'; pfx.textContent='KG';
        var sizeInp=document.createElement('input'); sizeInp.type='number'; sizeInp.step='0.001'; sizeInp.min='0.001';
        sizeInp.style.cssText='height:30px;font-size:12px;font-family:var(--font-mono);text-align:right;border:none;background:var(--surface);color:var(--text);padding:0 8px;width:100%;outline:none'; sizeInp.placeholder='Size';
        if(item.batch_size) sizeInp.value=item.batch_size;
        (function(i){ sizeInp.addEventListener('input',function(){ _rmCart[i].batch_size=parseFloat(this.value)||null; }); })(idx);
        sizeWrap.appendChild(pfx); sizeWrap.appendChild(sizeInp);
        var rmBtn=document.createElement('button'); rmBtn.textContent='\u2715'; rmBtn.title='Remove';
        rmBtn.style.cssText='width:26px;height:26px;border-radius:50%;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0';
        rmBtn.addEventListener('mouseover',function(){this.style.color='var(--red-text)';this.style.borderColor='var(--red-text)';});
        rmBtn.addEventListener('mouseout', function(){this.style.color='var(--muted)';this.style.borderColor='var(--border2)';});
        (function(i){ rmBtn.addEventListener('click',function(){ rmCartRemove(i); }); })(idx);
        row.appendChild(nameDiv); row.appendChild(sizeWrap); row.appendChild(rmBtn);
        container.appendChild(row);
    });
}

/* ── Generate ── */
async function rmGenerate(){
    if(!_rmCart.length){ toast('Add at least one batch to the list','warning'); return; }
    var noSize=_rmCart.filter(function(c){ return !c.batch_size||c.batch_size<=0; });
    if(noSize.length){ toast(noSize[0].batch_name+' \u2014 enter a batch size (KG)','warning'); return; }
    var btn=document.getElementById('rmGenerateBtn');
    btn.disabled=true; btn.textContent='Generating\u2026';
    try{
        var cartItems=_rmCart.map(function(c){ return {batch_name:c.batch_name,batch_size:c.batch_size}; });
        var res=await fetch('/api/procurement/formulations/rm_requirement',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cart_items:cartItems})});
        var data=await res.json();
        if(data.status!=='ok') throw new Error(data.message);
        // Filter ignored materials
        var _rmIgnore = ['demineralized water','d.m. water','dm water','demineralised water'];
        data.materials = data.materials.filter(function(m){
            return !_rmIgnore.includes(m.name.trim().toLowerCase());
        });
        _rmData=data; _rmFiltered=data.materials.slice(); _rmSortMode='name'; _rmShortOnly=false;
        document.getElementById('rmStep1').style.display='none';
        document.getElementById('rmStep2').style.display='flex';
        // Keep draft saved so user can come back
        rmRenderResults();
        document.getElementById('rmPossibleBtn').style.display='';
        document.getElementById('rmFootHint').textContent=data.materials.length+' materials \u00b7 '+_rmCart.length+' batch'+(_rmCart.length!==1?'es':'');
        btn.textContent='Generate Report'; btn.onclick=function(){rmGoBack();}; btn.disabled=false; btn.style.opacity='1'; btn.style.cursor='pointer';
    }catch(err){ toast('Failed: '+err.message,'error'); btn.disabled=false; btn.textContent='Generate Report'; }
}
function rmGoBack(){
    document.getElementById('rmStep2').style.display='none';
    document.getElementById('rmStep1').style.display='flex';
    document.getElementById('rmPossibleBtn').style.display='none';
    var btn=document.getElementById('rmGenerateBtn');
    btn.textContent='Generate Report'; btn.onclick=rmGenerate;
    rmRenderCart();
}

/* ── Update Procurement: saves batch_size from RM cart → procurement_formulations.batch_size ── */
async function rmUpdateProcurement(){
    if(!_rmCart.length){ toast('No batches in list','warning'); return; }
    var noSize=_rmCart.filter(function(c){ return !c.batch_size||parseFloat(c.batch_size)<=0; });
    if(noSize.length){
        toast(noSize[0].batch_name+' — enter a batch size before updating','warning');
        return;
    }
    if(!confirm('Update Procurement Size (KG) for '+_rmCart.length+' batch(es) in the Formulations tab?\n\nThis will overwrite existing batch sizes.')) return;
    var btn=document.getElementById('rmUpdateProcBtn');
    btn.disabled=true; btn.textContent='Updating…';
    var done=0, failed=0;
    for(var i=0;i<_rmCart.length;i++){
        var item=_rmCart[i];
        try{
            // Get current batch_size from fvq data for size_before
            var meta = (_fvqBatches||[]).find(function(b){ return b.batch_name===item.batch_name; }) || {};
            var sizeBefore = meta.batch_size ? parseFloat(String(meta.batch_size).replace(/[^\d.]/g,'')) : 0;
            var newSize    = Math.round(parseFloat(item.batch_size) * 1000) / 1000;
            var payload = {
                batch_name:  item.batch_name,
                batch_size:  newSize + ' KG',      // API expects string e.g. "2500 KG"
                action_type: 'update',
                qty_changed: newSize - sizeBefore,
                size_before: sizeBefore
            };
            var res=await fetch('/api/procurement/formulations/update_batch_size',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify(payload)
            });
            var d=await res.json();
            if(d.status==='ok') done++;
            else { failed++; console.warn('Failed: '+item.batch_name+' — '+(d.message||'error')); }
        }catch(e){ failed++; console.error(e); }
    }
    btn.disabled=false;
    btn.innerHTML='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" style="margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>Update Procurement';
    if(failed===0){
        toast(done+' batch'+(done!==1?'es':'')+' updated in Formulations ✓','success');
        if(typeof loadFvqData==='function') loadFvqData();
    } else {
        toast(done+' updated, '+failed+' failed','error');
    }
}

/* ── Render results ── */
function rmRenderResults(){
    if(!_rmData) return;
    var d=_rmData;
    var chips='';
    d.batches.forEach(function(b){ chips+='<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 12px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);border-radius:20px;font-size:10.5px;color:#c4b5fd;white-space:nowrap">'+escHtml(b.batch_name)+(b.batch_size?'<span style="color:var(--muted);margin-left:4px">'+fmtNum(b.batch_size,3)+' KG</span>':'')+'</span>'; });
    document.getElementById('rmBatchChips').innerHTML=chips;
    var totalKg=d.materials.reduce(function(s,m){return s+m.total_qty;},0);
    var shortCount=d.materials.filter(function(m){return m.stock_diff!==null&&m.stock_diff<0;}).length;
    var noStockCount=d.materials.filter(function(m){return m.stock_diff===null;}).length;
    document.getElementById('rmStatsBar').innerHTML=
        rmStat('Total Materials',d.materials.length,'#a78bfa',false)+
        rmStat('Total RM (KG)',fmtNum(totalKg,3),'var(--teal)',false)+
        rmStat('Batches',d.batches.length,'#4ade80',false)+
        rmStat('Short / No Stock',shortCount+(noStockCount?' + '+noStockCount+' unknown':''),'#f87171',true);
    if(d.stk_error) document.getElementById('rmFootHint').textContent='\u26a0 StkSum could not be read \u2014 stock data unavailable';
    rmApplyFilter();
}
function rmStat(label,value,color,red){
    return '<div style="background:'+(red?'rgba(239,68,68,.07)':'var(--surface2)')+';border:1px solid '+(red?'rgba(239,68,68,.2)':'var(--border2)')+';border-radius:var(--radius-sm);padding:10px 14px;border-top:2px solid '+color+'">'
        +'<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--muted2);margin-bottom:4px">'+label+'</div>'
        +'<div style="font-size:1.4rem;font-weight:800;color:'+(red?'#f87171':'var(--text)')+'">'+value+'</div></div>';
}
function rmApplyFilter(){
    if(!_rmData) return;
    var q=(document.getElementById('rmSearch').value||'').toLowerCase().trim();
    var list=_rmData.materials.filter(function(m){
        var ok=!q||m.name.toLowerCase().includes(q)||(m.supplier||'').toLowerCase().includes(q);
        if(!ok) return false;
        if(_rmShortOnly) return m.stock_diff!==null?m.stock_diff<0:true;
        return true;
    });
    if(_rmSortMode==='qty') list.sort(function(a,b){return b.total_qty-a.total_qty;});
    else list.sort(function(a,b){return a.name.toLowerCase().localeCompare(b.name.toLowerCase());});
    _rmFiltered=list;
    rmRenderTable(list);
    document.getElementById('rmSortNameBtn').style.color=_rmSortMode==='name'?'var(--teal)':'';
    document.getElementById('rmSortQtyBtn').style.color=_rmSortMode==='qty'?'var(--teal)':'';
    document.getElementById('rmShortBtn').style.color=_rmShortOnly?'#f87171':'';
    document.getElementById('rmShortBtn').style.borderColor=_rmShortOnly?'rgba(239,68,68,.5)':'';
}
function rmSortBy(mode){ _rmSortMode=mode; rmApplyFilter(); }
function rmToggleShort(){ _rmShortOnly=!_rmShortOnly; rmApplyFilter(); }
function rmRenderTable(list){
    var tbody=document.getElementById('rmReqTbody');
    if(!list||!list.length){ tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--muted);font-size:12px">No materials match</td></tr>'; return; }
    var h='';
    list.forEach(function(m,i){
        var isShort=m.stock_diff!==null&&m.stock_diff<0;
        var noStock=m.stock_diff===null;
        var rowBg=isShort?'background:rgba(239,68,68,.06);':(i%2===0?'':'background:var(--surface2);');
        var lBdr=isShort?'border-left:3px solid rgba(239,68,68,.6);':'border-left:3px solid transparent;';
        var stockCell=noStock?'<span style="font-size:10px;color:var(--muted);font-style:italic">Not in StkSum</span>':'<span style="color:#38bdf8;font-weight:600;font-family:var(--font-mono)">'+fmtNum(m.current_stock,4)+'</span>';
        var diffCell=noStock?'<span style="font-size:10px;color:var(--muted)">&#8212;</span>':isShort?'<span style="color:#f87171;font-weight:700;font-family:var(--font-mono)">'+fmtNum(m.stock_diff,4)+' &#9660;</span>':'<span style="color:#4ade80;font-weight:600;font-family:var(--font-mono)">+'+fmtNum(m.stock_diff,4)+'</span>';
        var batchTags = '';
        if(m.batches && m.batches.length){
            m.batches.forEach(function(b){
                batchTags += '<span style="display:inline-block;margin:1px 2px;padding:1px 7px;border-radius:20px;font-size:9.5px;font-weight:600;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.25);color:#c4b5fd;white-space:nowrap">'+escHtml(b)+'</span> ';
            });
        } else {
            batchTags = '<span style="color:var(--muted);font-size:10px">—</span>';
        }
        h += '<tr style="border-bottom:1px solid var(--border);'+rowBg+lBdr+'">';
        h += '<td style="padding:8px 10px;color:var(--muted);font-size:10.5px;text-align:center">'+(i+1)+'</td>';
        h += '<td style="padding:8px 14px;font-weight:600;color:var(--text)">'+escHtml(m.name)+(isShort?' <span style="color:#f87171;font-size:10px">&#9888;</span>':'')+'</td>';
        h += '<td style="padding:8px 14px;font-size:11px;color:var(--muted2)">'+escHtml(m.supplier||'—')+'</td>';
        h += '<td style="padding:8px 14px;text-align:right;font-weight:700;color:#a78bfa;font-family:var(--font-mono);white-space:nowrap">'+fmtNum(m.total_qty,4)+'</td>';
        h += '<td style="padding:8px 14px;text-align:right;white-space:nowrap">'+stockCell+'</td>';
        h += '<td style="padding:8px 14px;text-align:right;white-space:nowrap;border-right:1px solid var(--border)">'+diffCell+'</td>';
        h += '<td style="padding:6px 14px">'+batchTags+'</td>';
        h += '</tr>';
    });
    tbody.innerHTML=h;
}
function rmCopyAll(){
    if(!_rmFiltered.length){ toast('No data to copy','warning'); return; }
    var lines=['RM Requirement Report',''];
    lines.push('Batches: '+_rmData.batches.map(function(b){return b.batch_name+' ('+fmtNum(b.batch_size,3)+' KG)';}).join(', '));
    lines.push('');
    lines.push('#\tMaterial\tSupplier\tRequired (KG)\tIn Stock (KG)\tDiff (KG)');
    _rmFiltered.forEach(function(m,i){
        var stock=m.current_stock!=null?fmtNum(m.current_stock,4):'N/A';
        var diff=m.stock_diff!=null?fmtNum(m.stock_diff,4):'N/A';
        lines.push((i+1)+'\t'+m.name+'\t'+(m.supplier||'')+'\t'+fmtNum(m.total_qty,4)+'\t'+stock+'\t'+diff);
    });
    navigator.clipboard.writeText(lines.join('\n')).then(function(){
        var btn=document.getElementById('rmCopyBtn');
        btn.textContent='\u2713 Copied!'; btn.style.color='var(--green-text)';
        setTimeout(function(){btn.textContent='\uD83D\uDCCB Copy';btn.style.color='';},2200);
    }).catch(function(){ toast('Copy failed','error'); });
}
function rmWhatsApp(){
    if(!_rmData||!_rmFiltered.length){ toast('No data','warning'); return; }
    var lines=['\uD83E\uDEA3 *RM Requirement Report*',''];
    _rmData.batches.forEach(function(b){ lines.push('\uD83D\uDCE6 *'+b.batch_name+'* \u2014 '+fmtNum(b.batch_size,3)+' KG'); });
    lines.push('\n*Raw Materials Required:*');
    _rmFiltered.forEach(function(m,i){
        var diff=m.stock_diff!=null?(m.stock_diff<0?' \u26a0 SHORT: '+fmtNum(m.stock_diff,3)+' KG':' \u2705 OK'):' \u2753 No stock data';
        lines.push((i+1)+'. '+m.name+' \u2014 *'+fmtNum(m.total_qty,4)+' KG*'+diff);
    });
    window.open('https://web.whatsapp.com/send?text='+encodeURIComponent(lines.join('\n')),'_blank');
    toast('WhatsApp Web opened','success');
}


