/* pm_stock_combined.js — Combined tab + filters + WhatsApp */

// ── loadCombinedPerGodown (originally L1990..L2002) ─────────────────────────
async function loadCombinedPerGodown() {
  const toDate = document.getElementById('sv-to-date')?.value || new Date().toISOString().slice(0,10);
  const tbody  = document.getElementById('combinedTbody');
  if(tbody) tbody.innerHTML = `<tr><td colspan="8" class="no-data"><span class="spinner"></span> Loading…</td></tr>`;
  try {
    const res = await fetch(`/api/pm_stock/summary/per_godown?to_date=${toDate}`);
    _perGodownData = await res.json();
    renderCombinedPerGodown();
  } catch(e) {
    showToast('Error loading combined data: '+e.message, 'error');
  }
}


// ── renderCombined (originally L2003..L2004) ─────────────────────────
function renderCombined() { loadCombinedPerGodown(); } // override old function


// ── renderCombinedPerGodown (originally L2005..L2142) ─────────────────────────
function renderCombinedPerGodown() {
  if(!_perGodownData) return;
  const { godowns, rows } = _perGodownData;

  // Apply filters
  const search    = (document.getElementById('ct-search')?.value||'').toLowerCase();
  const pmType    = document.getElementById('ct-pm-type')?.value||'';
  const brandId   = parseInt(document.getElementById('ct-brand')?.value)||0;
  const stockFilt = document.getElementById('ct-stock-filter')?.value||'';

  let data = rows;
  if(search)   data = data.filter(r =>
    (r.product_name || '').toLowerCase().includes(search) ||
    (r.pm_type      || '').toLowerCase().includes(search) ||
    (r.product_code || '').toLowerCase().includes(search)
  );
  if(pmType)   data = data.filter(r=>r.pm_type===pmType);
  if(brandId)  data = data.filter(r=>_brands.find(b=>b.id===brandId&&b.name===r.brand_name));
  if(stockFilt==='nonzero') data = data.filter(r=>r.total_godown_stock>0);
  if(stockFilt==='zero')    data = data.filter(r=>r.total_godown_stock<=0);

  // Inject dynamic godown columns into thead
  const thead = document.getElementById('combinedThead');
  if(thead) {
    // Remove any previously-injected godown cols
    thead.querySelectorAll('th.gd-col').forEach(th => th.remove());
    const theadRow = thead.querySelector('tr') || thead;
    // Find the "TOTAL STOCK" header by text content — safer than positional indexing
    const allThs = [...theadRow.querySelectorAll('th')];
    const totalTh = allThs.find(th =>
      (th.textContent || '').trim().toUpperCase().replace(/\s+/g,' ') === 'TOTAL STOCK'
    );
    console.log('[Combined] Injecting godown headers:', godowns.length, 'godowns. Found TOTAL STOCK th?', !!totalTh, 'Existing ths:', allThs.length);
    godowns.forEach(g => {
      const th = document.createElement('th');
      th.className = 'num gd-col';
      th.style.cssText = 'background:rgba(14,165,233,.07);color:var(--godown-clr,#0ea5e9);white-space:nowrap';
      th.textContent = `🏢 ${g.name}`;
      if(totalTh && totalTh.parentNode === theadRow) {
        theadRow.insertBefore(th, totalTh);
      } else {
        theadRow.appendChild(th);
        console.warn('[Combined] Fallback: appended godown header at end — TOTAL STOCK th not found!');
      }
    });
  } else {
    console.error('[Combined] #combinedThead not found');
  }

  // Totals
  const totStock = data.reduce((s,r)=>s+r.total_godown_stock,0);
  const totFloor = Array.isArray(_summary) ? _summary.reduce((s,r)=>s+(r.remaining||0),0) : 0;
  const totByGd  = {};
  godowns.forEach(g => {
    totByGd[g.id] = data.reduce((s,r)=>{
      const byGd = r.by_godown || {};
      return s + (byGd[String(g.id)] || 0);
    }, 0);
  });

  // Stats band
  document.getElementById('ct-totals-band').innerHTML = [
    ...godowns.map(g=>`
      <div class="stat-card godown" style="padding:12px">
        <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">${g.name}</div>
        <div style="font-size:20px;font-weight:800;color:var(--godown-clr)">${fmt(totByGd[g.id]||0)}</div>
      </div>`),
    `<div class="stat-card floor" style="padding:12px">
        <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Factory Remaining</div>
        <div style="font-size:20px;font-weight:800;color:var(--floor-clr)">${fmt(totFloor)}</div>
      </div>`,
    `<div class="stat-card total" style="padding:12px">
        <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Total Stock</div>
        <div style="font-size:20px;font-weight:800;color:var(--green)">${fmt(totStock+totFloor)}</div>
      </div>`,
    `<div class="stat-card" style="padding:12px;border-top:3px solid var(--purple)">
        <div style="font-size:9.5px;color:var(--hmuted,#9ca3af);font-weight:700;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Items</div>
        <div style="font-size:20px;font-weight:800;color:var(--purple)">${data.length}</div>
      </div>`
  ].join('');

  const {slice,total,pages,page,start} = paginate(data,'combined');
  const tbody = document.getElementById('combinedTbody');

  if(!data.length){
    tbody.innerHTML=`<tr><td colspan="${5+godowns.length+2}" class="no-data"><i class="fas fa-chart-bar"></i> No data</td></tr>`;
    document.getElementById('combinedPag').innerHTML='';
    document.getElementById('combinedTfoot').innerHTML=''; return;
  }

  // Find matching _summary row for factory remaining
  const floorIdx = {};
  (_summary||[]).forEach(r=>{ floorIdx[r.id]=r.remaining||0; });

  tbody.innerHTML = slice.map((r,i)=>{
    const totalStock  = r.total_godown_stock + (floorIdx[r.product_id]||0);
    const chipCls     = totalStock>100?'ok':totalStock>0?'warn':'danger';
    const bBadge      = r.brand_name
      ? `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${r.brand_color||'#6366f1'}22;color:${r.brand_color||'#6366f1'};border:1px solid ${r.brand_color||'#6366f1'}44">${r.brand_name}</span>`
      : '<span style="color:var(--hmuted,#9ca3af);font-size:10px">—</span>';
    // Per-godown cells
    const gdCells = godowns.map(g => {
      const byGd = r.by_godown || {};
      const s = byGd[String(g.id)] || 0;
      return `<td class="num" style="background:rgba(14,165,233,.04)">${s!==0?fmt(s):'<span style="color:var(--muted,#9ca3af)">—</span>'}</td>`;
    }).join('');
    return `<tr class="dbl-hint" ondblclick="openItemDetail(${r.product_id})" title="Double-click for item details">
      <td><input type="checkbox" class="row-select" data-id="${r.product_id}" data-type="combined"
        onchange="onRowCheck(this,${r.product_id},'combined',${JSON.stringify(r).replace(/"/g,'&quot;')})"
        style="accent-color:var(--brand)"></td>
      <td style="color:var(--hmuted,#9ca3af);text-align:center">${start+i+1}</td>
      <td>${bBadge}</td>
      <td class="td-name">${r.product_name}</td>
      <td><span class="pm-badge">${r.pm_type}</span></td>
      ${gdCells}
      <td class="num" style="background:rgba(13,148,136,0.08)"><span class="stock-chip ${chipCls}">${fmt(totalStock)}</span></td>
      <td class="num" style="background:rgba(245,158,11,0.06);color:var(--floor-clr)">${fmt(floorIdx[r.product_id]||0)}</td>
    </tr>`;
  }).join('');

  // Tfoot
  const gdTotCells = godowns.map(g=>`<td class="num" style="color:var(--godown-clr)">${fmt(totByGd[g.id]||0)}</td>`).join('');
  document.getElementById('combinedTfoot').innerHTML=`
    <tr style="background:rgba(13,148,136,0.1);font-weight:800">
      <td colspan="5" style="padding:10px 14px;font-size:11px;color:var(--brand)">TOTAL (${data.length} items)</td>
      ${gdTotCells}
      <td class="num" style="color:var(--brand);background:rgba(13,148,136,0.12);font-size:13px">${fmt(totStock+totFloor)}</td>
      <td class="num" style="color:var(--floor-clr)">${fmt(totFloor)}</td>
    </tr>`;
  renderPag('combinedPag','combined',total,pages,page);
}

/* ═══════════════════════════════════════════════════════════
   FACTORY REPORTS TAB
═══════════════════════════════════════════════════════════ */
let _reportType = 'dispatch';
let _reportRows = [];


// ── renderCombined (originally L2306..L2310) ─────────────────────────
function renderCombined(){
  // legacy alias — now delegates to per-godown version
  renderCombinedPerGodown();
}


// ── syncCombinedFilters (originally L1895..L1902) ─────────────────────────
function syncCombinedFilters(){
  const svSearch=document.getElementById('sv-search')?.value||'';
  const svPm=document.getElementById('sv-pm-type')?.value||'';
  const svBrand=document.getElementById('sv-brand')?.value||'';
  if(svSearch) document.getElementById('ct-search').value=svSearch;
  if(svPm)     document.getElementById('ct-pm-type').value=svPm;
  if(svBrand)  { const ctb=document.getElementById('ct-brand'); if(ctb) ctb.value=svBrand; }
}

// ── clearCombinedFilters (originally L1903..L1913) ─────────────────────────
function clearCombinedFilters(){
  document.getElementById('ct-search').value='';
  document.getElementById('ct-pm-type').value='';
  const ctb=document.getElementById('ct-brand'); if(ctb) ctb.value='';
  const csf=document.getElementById('ct-stock-filter'); if(csf) csf.value='';
  renderCombined();
}

/* ═══════════════════════════════════════════════════════════
   BUILD DYNAMIC GODOWN SUB-TABS in Stock View
═══════════════════════════════════════════════════════════ */

// ── sendWhatsappCombined (originally L2311..L2334) ─────────────────────────
function sendWhatsappCombined(){
  const search=(document.getElementById('ct-search')?.value||'').toLowerCase();
  const pmType=document.getElementById('ct-pm-type')?.value||'';
  let rows=_summary;
  if(search) rows=rows.filter(r =>
    (r.product_name || '').toLowerCase().includes(search) ||
    (r.pm_type      || '').toLowerCase().includes(search) ||
    (r.product_code || '').toLowerCase().includes(search)
  );
  if(pmType) rows=rows.filter(r=>r.pm_type===pmType);
  if(!rows.length){showToast('No rows to share','error');return;}
  const today=fmtDate(new Date());
  const tot=rows.reduce((a,r)=>({godown:a.godown+r.godown_stock,remaining:a.remaining+r.remaining,total:a.total+r.godown_stock+r.remaining,rejection:a.rejection+r.rejection,dispatch:a.dispatch+r.dispatch}),{godown:0,remaining:0,total:0,rejection:0,dispatch:0});
  let msg=`📊 *PM Stock — Combined Total*\n🗓 ${today}\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg+=`🏭 Godown : *${fmt(tot.godown)}*\n🏗️ Floor : *${fmt(tot.remaining)}*\n✅ TOTAL : *${fmt(tot.total)}*\n🚀 Dispatched : ${fmt(tot.dispatch)}\n❌ Rejections : ${fmt(tot.rejection)}\n━━━━━━━━━━━━━━━━━━━━\n`;
  if(rows.length<=20) rows.forEach(r=>{msg+=`• ${r.product_name} [${r.pm_type}]\n  G:${fmt(r.godown_stock)} F:${fmt(r.remaining)} T:*${fmt(r.godown_stock+r.remaining)}*\n`;});
  else msg+=`_(${rows.length} items — see portal)_\n`;
  msg+=`\n_HCP Wellness Pvt Ltd_`;
  window.open('https://web.whatsapp.com/send?text='+encodeURIComponent(msg),'_blank');
}

/* ═══════════════════════════════════════════════════════════
   DOUBLE-CLICK EDIT — TRANSACTIONS
═══════════════════════════════════════════════════════════ */

