/* ═══════════════════════════════════════════════════════════════════════════
   pm_stock_split.js
   ─────────────────────────────────────────────────────────────────────────
   Box-split workflow: divide a parent box's qty into N children,
   auto-print labels for the new children.

   Backend: POST /api/pm_stock/boxes/<id>/split
   Modal:   #splitBoxModal
   Trigger: openSplitBoxModal()  — sidebar item under Stock section
═══════════════════════════════════════════════════════════════════════════ */

// State for the open modal — cleared each time the modal opens.
let _sbParent     = null;   // last looked-up parent {box_id, box_code, ...}
let _sbResultData = null;   // server response after a successful split

function openSplitBoxModal(){
  const modal = document.getElementById('splitBoxModal');
  if(!modal) return;
  modal.classList.add('open');
  sbReset();
  // Focus the scan input so handheld scanners can fire straight away
  setTimeout(() => {
    const inp = document.getElementById('sb-code-input');
    if(inp) inp.focus();
  }, 80);
}

function sbReset(){
  _sbParent = null;
  _sbResultData = null;
  const inp = document.getElementById('sb-code-input');
  if(inp){ inp.value = ''; inp.disabled = false; }
  document.getElementById('sb-parent-card').style.display    = 'none';
  document.getElementById('sb-splits-section').style.display = 'none';
  document.getElementById('sb-result-card').style.display    = 'none';
  document.getElementById('sb-save-btn').style.display       = 'none';
  document.getElementById('sb-rows').innerHTML = '';
  document.getElementById('sb-reason').value   = '';
  setTimeout(() => {
    const i = document.getElementById('sb-code-input');
    if(i) i.focus();
  }, 50);
}

async function sbLookupBox(){
  const inp = document.getElementById('sb-code-input');
  const raw = (inp.value || '').trim().toUpperCase();
  if(!raw){ showToast('Enter or scan a box code','error'); return; }
  try {
    // /api/pm_stock/boxes/by_code returns the box + product/godown info.
    // Useful here: we can show the user what they're about to split before
    // they commit.
    const r = await fetch('/api/pm_stock/boxes/by_code?code=' + encodeURIComponent(raw));
    const d = await r.json();
    if(d.status !== 'ok' || !d.box){
      showToast(d.message || `Box ${raw} not found`, 'error', 4000);
      return;
    }
    const b = d.box;
    if(b.current_status === 'superseded'){
      showToast(`That box was already split. Look up one of its children instead.`, 'error', 5000);
      return;
    }
    if(b.current_status !== 'in_stock'){
      showToast(`Box status is "${b.current_status}" — only in_stock boxes can be split.`, 'error', 5000);
      return;
    }
    _sbParent = b;
    _sbRenderParent(b);
    _sbBuildInitialRows(b);
    document.getElementById('sb-save-btn').style.display = 'inline-flex';
  } catch(e){
    showToast('Lookup failed: '+e.message,'error', 4000);
  }
}

function _sbRenderParent(b){
  document.getElementById('sb-parent-code').textContent    = b.box_code;
  document.getElementById('sb-parent-product').textContent =
    `[${b.pm_type||'?'}] ${b.product_name||''}`;
  const meta = [];
  if(b.godown_name) meta.push(`At: ${b.godown_name}`);
  if(b.grn_no)      meta.push(`Lot: ${b.grn_no}`);
  if(b.fifo_code)   meta.push(`FIFO: ${b.fifo_code}`);
  document.getElementById('sb-parent-meta').textContent = meta.join('  ·  ');
  document.getElementById('sb-parent-qty').textContent  =
    Number(b.per_box_qty || 0).toLocaleString('en-IN');
  document.getElementById('sb-parent-card').style.display = 'block';
  document.getElementById('sb-splits-section').style.display = 'block';
  document.getElementById('sb-target').textContent =
    Number(b.per_box_qty || 0).toLocaleString('en-IN');
}

function _sbBuildInitialRows(b){
  // Default to 2 children, each half the parent's qty.
  document.getElementById('sb-rows').innerHTML = '';
  const half = (Number(b.per_box_qty)||0) / 2;
  sbAddRow(half);
  sbAddRow(half);
}

function sbAddRow(initialQty){
  const container = document.getElementById('sb-rows');
  const div = document.createElement('div');
  div.className = 'sb-row';
  div.style.cssText = 'display:grid;grid-template-columns:60px 1fr 32px;gap:10px;padding:9px 14px;border-top:1px solid var(--border,rgba(0,0,0,.06));align-items:center';
  const idx = container.children.length + 1;
  div.innerHTML = `
    <div style="font-weight:800;color:var(--teal,#0d9488);font-size:12px">Child #${idx}</div>
    <input type="number" class="sb-row-qty" min="0" step="any"
      value="${initialQty != null ? initialQty : 0}"
      style="width:100%;text-align:right;font-size:14px;padding:7px 10px;
      font-weight:700;font-family:var(--font-mono,monospace);
      border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;outline:none">
    <button onclick="this.closest('.sb-row').remove(); _sbRenumber(); sbRecalc()"
      title="Remove this child"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);
      border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;
      font-size:13px;display:flex;align-items:center;justify-content:center">✕</button>`;
  container.appendChild(div);
  div.querySelector('.sb-row-qty').addEventListener('input', sbRecalc);
  sbRecalc();
}

function _sbRenumber(){
  // Re-label children #1, #2, … after a removal so the list stays in sync.
  document.querySelectorAll('#sb-rows .sb-row').forEach((row, i) => {
    const lbl = row.querySelector('div');
    if(lbl) lbl.textContent = `Child #${i+1}`;
  });
}

function sbRecalc(){
  const target = Number(_sbParent?.per_box_qty || 0);
  let sum = 0;
  document.querySelectorAll('#sb-rows .sb-row-qty').forEach(inp => {
    sum += Number(inp.value) || 0;
  });
  document.getElementById('sb-sum').textContent = sum.toLocaleString('en-IN');
  const bal = document.getElementById('sb-balance');
  // Allow a small float epsilon before flagging mismatch
  if(Math.abs(sum - target) < 0.001){
    bal.textContent = '✓';
    bal.style.color = '#10b981';
    document.getElementById('sb-save-btn').disabled = false;
  } else if(sum > target){
    bal.textContent = `over by ${(sum - target).toLocaleString('en-IN')}`;
    bal.style.color = '#dc2626';
    document.getElementById('sb-save-btn').disabled = true;
  } else {
    bal.textContent = `short by ${(target - sum).toLocaleString('en-IN')}`;
    bal.style.color = '#d97706';
    document.getElementById('sb-save-btn').disabled = true;
  }
}

async function sbDoSplit(){
  if(!_sbParent){ showToast('Look up a box first','error'); return; }
  const rows = document.querySelectorAll('#sb-rows .sb-row-qty');
  const splits = [];
  rows.forEach(r => {
    const q = Number(r.value) || 0;
    if(q > 0) splits.push({qty: q});
  });
  if(splits.length < 2){
    showToast('At least 2 children with positive qty are required','error');
    return;
  }
  const target = Number(_sbParent.per_box_qty || 0);
  const sum    = splits.reduce((a,s)=>a+s.qty, 0);
  if(Math.abs(sum - target) > 0.001){
    showToast(`Sum (${sum}) must equal parent qty (${target})`,'error', 4500);
    return;
  }

  const reason = (document.getElementById('sb-reason').value || '').trim();

  // Final confirm — splitting is destructive (parent becomes superseded)
  let msg = `Split ${_sbParent.box_code} (${target}) into ${splits.length} children?\n\n`;
  splits.forEach((s,i) => { msg += `  Child #${i+1}: ${s.qty}\n`; });
  msg += `\nThe parent label will be invalidated. New labels will print automatically.\nProceed?`;
  if(!confirm(msg)) return;

  const btn = document.getElementById('sb-save-btn');
  btn.disabled = true; btn.textContent = 'Splitting…';
  try {
    const r = await fetch(`/api/pm_stock/boxes/${_sbParent.box_id}/split`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ splits, reason })
    });
    const d = await r.json();
    if(d.status === 'ok'){
      _sbResultData = d;
      _sbRenderResult(d);
      showToast(`✓ Split into ${d.children.length} children — printing labels`, 'success', 4000);
      // Auto-print labels for the new children. The print pipeline below
      // is shared with the post-GRN label flow.
      setTimeout(() => sbPrintChildren(d), 250);
    } else {
      showToast(d.message || 'Split failed','error', 5000);
      btn.disabled = false;
      btn.textContent = '✂️ Split & Print →';
    }
  } catch(e){
    showToast('Error: '+e.message,'error');
    btn.disabled = false;
    btn.textContent = '✂️ Split & Print →';
  }
}

function _sbRenderResult(d){
  // Hide the input/splits, show result card + reset button.
  document.getElementById('sb-parent-card').style.display    = 'none';
  document.getElementById('sb-splits-section').style.display = 'none';
  document.getElementById('sb-save-btn').style.display       = 'none';
  const card = document.getElementById('sb-result-card');
  const list = document.getElementById('sb-result-children');
  list.innerHTML = d.children.map((c,i) =>
    `<div>Child #${i+1}: <strong style="color:var(--teal,#0d9488)">${c.box_code}</strong> · qty ${Number(c.qty).toLocaleString('en-IN')}</div>`
  ).join('');
  card.style.display = 'block';
  // Disable + reset the input
  const inp = document.getElementById('sb-code-input');
  if(inp){ inp.disabled = true; }
}

function sbReprintChildren(){
  if(_sbResultData) sbPrintChildren(_sbResultData);
}

/* ── Auto-print labels for child boxes ────────────────────────────────────
   Reuses the existing GRN-label print pipeline. We construct the same
   data shape that grnLabelDoPrint() expects:
     { grnNo, grnDate, grnDateFmt, supervisor, location, istStr,
       items: [{ productId, productCode, productName, pmType, brandName,
                 noOfBox, boxCount, qty, fifoCode }] }
   For a split, "items" is just one row per child: noOfBox=1, boxCount=qty,
   qty=qty. The code-renderer in grnLabelDoPrint will use the child's
   actual box_code (passed via a child-specific override below).
─────────────────────────────────────────────────────────────────────── */
function sbPrintChildren(d){
  // Stash on the (potentially absent) grnLabelModal element so
  // grnLabelDoPrint can find it. Reusing the existing modal/render code
  // means split labels look identical to GRN labels — same banner,
  // same QR, same FIFO box, same paper size.
  let modal = document.getElementById('grnLabelModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'grnLabelModal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }

  const today = new Date();
  const istStr = today.toLocaleString('en-IN', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
  const product = d.product || {};
  const items = d.children.map(c => ({
    productId:    product.id,
    productCode:  product.product_code || '',
    productName:  product.name || '',
    pmType:       product.pm_type || '',
    brandName:    '',          // not returned by split endpoint; minor cost
    noOfBox:      1,
    boxCount:     Number(c.qty),
    qty:          Number(c.qty),
    boxCode:      c.box_code,  // override: print this code on the label
    fifoCode:     '',          // no FIFO info from split endpoint; will be empty
  }));

  modal._labelData = {
    grnNo:           d.grn_no || '',
    grnDate:         today.toISOString().slice(0,10),
    grnDateFmt:      today.toLocaleDateString('en-IN'),
    supervisor:      (typeof _loginUserName === 'function' ? _loginUserName() : ''),
    location:        d.godown || '',
    istStr:          istStr,
    items:           items,
    supplierText:    'SPLIT',
    invoiceNo:       d.parent?.box_code || '',
    invoiceDateFmt:  today.toLocaleDateString('en-IN'),
    splitMode:       true,    // flag for label renderer if it wants to badge the labels
  };

  if(typeof grnLabelDoPrint === 'function'){
    grnLabelDoPrint();
  } else {
    showToast('Print pipeline unavailable — open the box manually to print','error');
  }
}
