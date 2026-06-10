/* utils.js — Shared state, helpers, badges, stats, toast
   Load FIRST — all other files depend on these */

/* ═══════════════════════ STATE ═══════════════════════ */
let _allRows=[], _filteredRows=[], _activeFilter='all',
    _focusedIdx=-1, _importRows=[], _ddFocusIdx=-1,
    _currentPage=1, _pageSize=25;

/* ═══════════════════════ HELPERS ═══════════════════════ */
function escHtml(s){ if(!s&&s!==0)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
/* Format date as dd/MMM/yyyy */
function fmtDate(d){
    if(!d) return '—';
    var dt = new Date(d);
    if(isNaN(dt.getTime())) return String(d);
    var M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return String(dt.getDate()).padStart(2,'0')+'/'+M[dt.getMonth()]+'/'+dt.getFullYear();
}
function fmtNum(v,d=3){ if(v===null||v===undefined||v==='')return''; const n=parseFloat(v); return isNaN(n)?'':n.toLocaleString('en-IN',{maximumFractionDigits:d}); }
function nv(v){ if(v===null||v===undefined)return null; const s=String(v).trim(); return s===''||s==='None'?null:s; }

/* ═══════════════════════ BADGES ═══════════════════════ */
function stockBadge(qty){
    if(qty===null||qty===undefined)return`<span class="badge badge-na">N/A</span>`;
    const n=parseFloat(qty);
    if(isNaN(n)) return`<span class="badge badge-na">N/A</span>`;
    if(n<=0)     return`<span class="badge badge-zero">${fmtNum(n)}</span>`;
    if(n<50)     return`<span class="badge badge-low">${fmtNum(n)}</span>`;
                 return`<span class="badge badge-good">${fmtNum(n)}</span>`;
}
function getQtyStatus(q){ if(q===null||q===undefined)return'na'; const n=parseFloat(q); if(isNaN(n)||n<=0)return'zero'; if(n<50)return'low'; return'good'; }
function hasProcData(r){ return r.ordered_qty!==null||r.buffer_qty!==null||r.supplier_name!==null||r.last_purchase_rate!==null||r.std_pack_size!==null||r.msl!==null||r.lead_time_days!==null; }

/* ═══════════════════════ STATS ═══════════════════════ */
function updateStats(rows){
    document.getElementById('statTotal').textContent =rows.length;
    document.getElementById('statGood').textContent  =rows.filter(r=>getQtyStatus(r.in_stock_qty)==='good').length;
    document.getElementById('statLow').textContent   =rows.filter(r=>getQtyStatus(r.in_stock_qty)==='low').length;
    document.getElementById('statZero').textContent  =rows.filter(r=>getQtyStatus(r.in_stock_qty)==='zero').length;
    document.getElementById('statFilled').textContent=rows.filter(r=>hasProcData(r)).length;
    document.getElementById('tabBadge').textContent  =rows.length;
}

/* ═══════════════════════ TOAST ═══════════════════════ */
function toast(msg,type='info',ms=3500){
    const icons={success:'✓',error:'✕',info:'●',warning:'!'};
    const el=document.createElement('div');
    el.className=`toast ${type}`;
    el.innerHTML=`<span class="toast-icon">${icons[type]||'●'}</span><span class="toast-msg">${escHtml(msg)}</span>`;
    document.getElementById('toastStack').appendChild(el);
    setTimeout(()=>{el.classList.add('dying');setTimeout(()=>el.remove(),280);},ms);
}


