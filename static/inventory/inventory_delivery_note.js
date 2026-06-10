/*
   inventory_delivery_note.js - Delivery Note (DN) (RM)
   HCP Wellness - adapted from pm_stock_dn.js, pm-themed

   HCP -> supplier outward note. Scanning a box marks it consumed (stock
   leaves). Self-injecting "Delivery Note" sidebar item (Vouchers section).

   Backend: inventory_delivery_note.py -> /api/inventory_mgmt/dn
*/

(function(){
  'use strict';

  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const nf = (n) => Number(n||0).toLocaleString('en-IN');
  const fmtDate = (iso) => { if(!iso) return '-'; const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso)); return m? m[3]+'/'+m[2]+'/'+m[1] : iso; };

  let _items = [], _godowns = [], _suppliers = [];
  let _rows = [];   // [{material_id, boxes:[{box_code, per_box_qty}]}]

  async function _loadRefs(){
    try {
      if(!_items.length){
        const r = await fetch('/api/inventory_mgmt/items?department=RM'); const j = await r.json();
        _items = (j.items||j.rows||[]).map(x=>({id:x.id, name:x.name||x.material_name, uom:x.uom}));
      }
      if(!_godowns.length){
        const r = await fetch('/api/inventory_godown/godowns/list'); const j = await r.json();
        _godowns = j.godowns || j.rows || [];
      }
      if(!_suppliers.length){
        const r = await fetch('/api/inventory_mgmt/suppliers?department=RM'); const j = await r.json();
        _suppliers = j.suppliers || j.rows || [];
      }
    } catch(e){ /* non-fatal */ }
  }

  /* ── List view ─────────────────────────────────────────────────────── */
  async function openList(){
    _ensureListModal();
    $('invDnListModal').classList.add('show');
    loadList();
  }
  function _ensureListModal(){
    if($('invDnListModal')) return;
    const html = `
<div class="modal-overlay" id="invDnListModal">
  <div class="modal-card xl" style="max-width:min(1400px,95vw)">
    <div class="modal-head">
      <div class="modal-title"><span>📤</span> Delivery Notes</div>
      <button class="modal-close" onclick="invDnCloseList()">&times;</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
        <button class="btn btn-primary" onclick="invDnNew()"><i class="fas fa-plus"></i> New Delivery Note</button>
        <input type="search" id="dn-search" placeholder="Search DN no / supplier" oninput="invDnRenderList()"
          style="flex:1;max-width:280px;padding:8px 12px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;font-size:12.5px;background:var(--white,#fff);color:var(--text,#1F1F1F)">
      </div>
      <div style="border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;overflow:auto;max-height:52vh">
        <table style="width:100%;border-collapse:collapse" id="dn-list-table">
          <thead><tr>
            <th>DN No</th><th>Date</th><th>Supplier</th><th>Godown</th>
            <th style="text-align:right">Lines</th><th style="text-align:right">Boxes</th><th>Status</th>
          </tr></thead>
          <tbody id="dn-list-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
  }
  let _list = [];
  async function loadList(){
    try {
      const r = await fetch('/api/inventory_mgmt/dn/list'); const j = await r.json();
      _list = (j.status==='ok') ? (j.rows||[]) : [];
    } catch(e){ _list=[]; }
    renderList();
  }
  function renderList(){
    const q = ($('dn-search')?.value||'').trim().toLowerCase();
    const rows = _list.filter(d => !q || (d.dn_no||'').toLowerCase().includes(q) || (d.supplier_name||'').toLowerCase().includes(q));
    const tb = $('dn-list-body'); if(!tb) return;
    if(!rows.length){ tb.innerHTML = '<tr><td colspan="7" style="padding:18px;text-align:center;color:var(--text2,#5F6368)">No delivery notes yet.</td></tr>'; return; }
    tb.innerHTML = rows.map(d => {
      const chip = d.status==='cancelled'
        ? '<span class="badge grey">CANCELLED</span>'
        : '<span class="badge green">ISSUED</span>';
      return `<tr ondblclick="invDnOpenDetail(${d.id})" style="cursor:pointer;border-top:1px solid var(--border,rgba(0,0,0,.06))">
        <td style="padding:10px 14px;font-family:var(--font-mono,monospace);font-weight:700;color:var(--blue,#1A73E8)">${esc(d.dn_no)}</td>
        <td style="padding:10px 14px">${fmtDate(d.dn_date)}</td>
        <td style="padding:10px 14px">${esc(d.supplier_name||'-')}</td>
        <td style="padding:10px 14px">${esc(d.godown_name||'-')}</td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--font-mono,monospace)">${d.line_count||0}</td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--font-mono,monospace)">${d.box_count||0}</td>
        <td style="padding:10px 14px">${chip}</td>
      </tr>`;
    }).join('');
  }
  async function openDetail(id){
    try {
      const r = await fetch('/api/inventory_mgmt/dn/'+id); const j = await r.json();
      if(j.status!=='ok'){ toast(j.message||'Not found','error'); return; }
      const d=j.dn, items=j.items||[];
      let msg = `DN ${d.dn_no}  (${fmtDate(d.dn_date)})\nSupplier: ${d.supplier_name||'-'}\nGodown: ${d.godown_name||'-'}\nStatus: ${d.status}\n\n`;
      items.forEach(it=>{ msg += `- ${it.material_name}: ${nf(it.qty_delivered)} (${(it.boxes||[]).length} boxes)\n`; });
      if(d.status!=='cancelled' && confirm(msg+`\nClick OK to DELETE this DN (restores its boxes to stock), or Cancel to close.`)){
        invDnDelete(id);
      }
    } catch(e){ toast('Error: '+e.message,'error'); }
  }
  async function del(id){
    try {
      const r = await fetch('/api/inventory_mgmt/dn/delete', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dn_id:id})});
      const j = await r.json();
      if(j.status==='ok'){ toast(`DN cancelled, ${j.restored} box(es) restored`,'success'); loadList(); }
      else toast(j.message||'Delete failed','error');
    } catch(e){ toast('Error: '+e.message,'error'); }
  }

  /* ── Create modal ──────────────────────────────────────────────────── */
  let _supCombo=null, _godCombo=null;
  async function openNew(){
    await _loadRefs();
    _ensureNewModal();
    _rows = [];
    const today = new Date().toISOString().slice(0,10);
    $('dnf-date').value = today;
    // Searchable comboboxes for supplier + godown
    _supCombo = window.invCombo({
      mount: $('dnf-supplier-combo'), placeholder:'Search supplier…',
      options: _suppliers.map(s=>({value:String(s.id), label:(s.supplier_name||s.name||''), sub:s.gstin||s.city||''})),
      onChange:(v,o)=>{ $('dnf-supplier').value=v||''; $('dnf-supplier-name').value=o?o.label:''; }
    });
    _godCombo = window.invCombo({
      mount: $('dnf-godown-combo'), placeholder:'Search godown…',
      options: _godowns.filter(g=>!g.is_floor).map(g=>({value:String(g.id), label:g.name})),
      onChange:(v)=>{ $('dnf-godown').value=v||''; }
    });
    $('dnf-ref').value=''; $('dnf-refdate').value=''; $('dnf-reason').value=''; $('dnf-remarks').value='';
    $('dnf-rows').innerHTML='';
    addRow();
    $('invDnNewModal').classList.add('show');
  }
  function _ensureNewModal(){
    if($('invDnNewModal')) return;
    const inputCss = 'padding:8px 11px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;font-size:12.5px;background:var(--white,#fff);color:var(--text,#1F1F1F);outline:none';
    const lblCss = 'font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--nb-text-muted,#444746);display:block;margin-bottom:5px';
    const html = `
<div class="modal-overlay" id="invDnNewModal">
  <div class="modal-card lg" style="max-width:680px">
    <div class="modal-head">
      <div class="modal-title"><span>📤</span> New Delivery Note</div>
      <button class="modal-close" onclick="invDnCloseNew()">&times;</button>
    </div>
    <div class="modal-body">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
        <div><label style="${lblCss}">DN Date</label><input type="date" id="dnf-date" style="${inputCss};width:100%"></div>
        <div><label style="${lblCss}">From Godown</label><div id="dnf-godown-combo"></div><input type="hidden" id="dnf-godown"></div>
        <div><label style="${lblCss}">Supplier</label><div id="dnf-supplier-combo"></div><input type="hidden" id="dnf-supplier"><input type="hidden" id="dnf-supplier-name"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
        <div><label style="${lblCss}">Reference No</label><input type="text" id="dnf-ref" style="${inputCss};width:100%"></div>
        <div><label style="${lblCss}">Reference Date</label><input type="date" id="dnf-refdate" style="${inputCss};width:100%"></div>
        <div><label style="${lblCss}">Reason</label><input type="text" id="dnf-reason" placeholder="e.g. rejection return" style="${inputCss};width:100%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--nb-text-muted,#444746)">Items</span>
        <button class="btn" style="padding:5px 11px;font-size:11px" onclick="invDnAddRow()"><i class="fas fa-plus"></i> Add item</button>
      </div>
      <div id="dnf-rows"></div>
      <label style="${lblCss};margin-top:12px">Remarks</label>
      <input type="text" id="dnf-remarks" style="${inputCss};width:100%">
    </div>
    <div class="modal-foot">
      <div style="flex:1"></div>
      <button class="btn" onclick="invDnCloseNew()">Cancel</button>
      <button class="btn btn-primary" id="dnf-save" onclick="invDnSave()"><i class="fas fa-paper-plane"></i> Issue DN</button>
    </div>
  </div>
</div>`;
    const t=document.createElement('div'); t.innerHTML=html; document.body.appendChild(t.firstElementChild);
  }

  function addRow(){
    const idx = _rows.length;
    _rows.push({material_id:'', boxes:[], combo:null});
    const c = $('dnf-rows');
    const div = document.createElement('div');
    div.className='dnf-row'; div.dataset.idx=idx;
    div.style.cssText='border:1px solid var(--border,rgba(0,0,0,.1));border-radius:8px;padding:10px 12px;margin-bottom:8px';
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div class="dnf-mat-combo" style="flex:1;min-width:0"></div>
        <span style="font-size:12px;white-space:nowrap;color:var(--text2,#5F6368)">Qty: <strong class="dnf-qty" style="font-family:var(--font-mono,monospace);color:var(--text,#1F1F1F)">0</strong></span>
        <button title="Remove item" onclick="invDnRemoveRow(${idx})"
          style="flex:0 0 auto;width:28px;height:28px;border-radius:6px;background:rgba(220,38,38,.1);border:1px solid rgba(220,38,38,.3);color:#dc2626;cursor:pointer;font-size:13px">✕</button>
      </div>
      <input type="text" class="dnf-scan" placeholder="Scan box code (RM-XXXX)" autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();invDnScan(${idx}, this);}"
        style="width:100%;padding:8px 11px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:7px;font-family:var(--font-mono,monospace);font-size:12px;background:var(--white,#fff);color:var(--text,#1F1F1F);outline:none">
      <div class="dnf-boxes" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>`;
    c.appendChild(div);
    // mount searchable material combo
    const mc = window.invCombo({
      mount: div.querySelector('.dnf-mat-combo'), placeholder:'Search material…',
      options: _items.map(m=>({value:String(m.id), label:m.name, sub:m.uom?('UOM: '+m.uom):''})),
      onChange:(v)=>{ if(_rows[idx]) _rows[idx].material_id = v?parseInt(v):''; }
    });
    if(_rows[idx]) _rows[idx].combo = mc;
  }
  function removeRow(idx){
    _rows[idx] = null;
    const el = document.querySelector(`.dnf-row[data-idx="${idx}"]`); if(el) el.remove();
  }
  function setMat(idx, val){ if(_rows[idx]) _rows[idx].material_id = val ? parseInt(val) : ''; }

  async function scan(idx, inp){
    const code = (inp.value||'').trim().toUpperCase();
    if(!code) return;
    const godown = $('dnf-godown').value || '';
    if(_rows[idx] && _rows[idx].boxes.some(b=>b.box_code===code)){ toast('Already scanned: '+code,'error'); inp.value=''; return; }
    try {
      const r = await fetch('/api/inventory_mgmt/dn/box/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code, godown_id:godown})});
      const j = await r.json();
      if(j.status!=='ok'){ toast(j.message||'Invalid box','error',4000); inp.value=''; return; }
      const b = j.box;
      // auto-set material from the box if not chosen
      if(_rows[idx] && !_rows[idx].material_id && b.material_id){
        _rows[idx].material_id = b.material_id;
        if(_rows[idx].combo) _rows[idx].combo.setValue(String(b.material_id));
      }
      _rows[idx].boxes.push({box_code:b.box_code, per_box_qty:b.per_box_qty, material_id:b.material_id});
      _renderBoxes(idx);
      inp.value=''; inp.focus();
    } catch(e){ toast('Scan error: '+e.message,'error'); }
  }
  function _renderBoxes(idx){
    const row = _rows[idx]; if(!row) return;
    const wrap = document.querySelector(`.dnf-row[data-idx="${idx}"] .dnf-boxes`);
    const qEl  = document.querySelector(`.dnf-row[data-idx="${idx}"] .dnf-qty`);
    if(wrap) wrap.innerHTML = row.boxes.map((b,i)=>
      `<span class="badge blue" style="cursor:pointer" title="Remove" onclick="invDnUnscan(${idx},${i})">${esc(b.box_code)} · ${nf(b.per_box_qty)} ✕</span>`).join('');
    if(qEl) qEl.textContent = nf(row.boxes.reduce((a,b)=>a+Number(b.per_box_qty||0),0));
  }
  function unscan(idx, i){ if(_rows[idx]){ _rows[idx].boxes.splice(i,1); _renderBoxes(idx); } }

  async function save(){
    const items = _rows.filter(r=>r && (r.material_id || (r.boxes&&r.boxes.length)))
      .map(r=>({material_id:r.material_id, boxes:r.boxes, qty_delivered:r.boxes.reduce((a,b)=>a+Number(b.per_box_qty||0),0)}));
    if(!items.length){ toast('Add at least one item with a scanned box','error'); return; }
    if(items.some(it=>!it.material_id)){ toast('Each item needs a material (scan a box or pick one)','error'); return; }
    const payload = {
      dn_date: $('dnf-date').value,
      supplier_id: $('dnf-supplier').value || null,
      supplier_name: $('dnf-supplier-name').value || '',
      godown_id: $('dnf-godown').value || null,
      reference_no: $('dnf-ref').value || null,
      reference_date: $('dnf-refdate').value || null,
      reason: $('dnf-reason').value || null,
      remarks: $('dnf-remarks').value || null,
      items
    };
    const totalBoxes = items.reduce((a,it)=>a+it.boxes.length,0);
    if(!confirm(`Issue this Delivery Note?\n\n${items.length} item(s), ${totalBoxes} box(es) will be marked consumed (stock leaves).\nProceed?`)) return;
    const btn=$('dnf-save'); btn.disabled=true; btn.innerHTML='Issuing…';
    try {
      const r = await fetch('/api/inventory_mgmt/dn/save', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const j = await r.json();
      if(j.status==='ok'){
        toast(`✓ ${j.dn_no} issued — ${j.boxes_consumed} box(es) consumed`,'success',4500);
        closeNew(); loadList();
      } else { toast(j.message||'Save failed','error',5000); btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Issue DN'; }
    } catch(e){ toast('Error: '+e.message,'error'); btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Issue DN'; }
  }

  /* ── nav (Vouchers section) ────────────────────────────────────────── */
  function _injectNav(){
    if($('dn-nav-item')) return;
    const navBody = document.querySelector('.inv-nav-body'); if(!navBody) return;
    let section = Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s => (s.querySelector('.inv-nav-section-label')||{}).textContent === 'Vouchers');
    if(!section){ section=document.createElement('div'); section.className='inv-nav-section';
      section.innerHTML='<div class="inv-nav-section-label">Vouchers</div>'; navBody.appendChild(section); }
    const item=document.createElement('div'); item.className='inv-nav-item'; item.id='dn-nav-item';
    item.onclick=()=>openList();
    item.innerHTML='<span class="ico">📤</span><span>Delivery Note</span>';
    section.appendChild(item);
  }
  function _applyAccess(){
    const item=$('dn-nav-item'); if(!item) return;
    const a=window._invAccess;
    const ok=!a||!a.ready||a.is_admin||(a.access&&a.access.delivery_note!=='off'&&a.access.delivery_note!==false);
    item.style.display=ok?'':'none';
  }
  document.addEventListener('inv-access-ready', _applyAccess);
  function _boot(){ _injectNav(); _applyAccess(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();

  window.invDnOpenList=openList; window.invDnCloseList=()=>$('invDnListModal')?.classList.remove('show');
  window.invDnRenderList=renderList; window.invDnOpenDetail=openDetail; window.invDnDelete=del;
  window.invDnNew=openNew; window.invDnCloseNew=()=>$('invDnNewModal')?.classList.remove('show');
  window.invDnAddRow=addRow; window.invDnRemoveRow=removeRow; window.invDnSetMat=setMat;
  window.invDnScan=scan; window.invDnUnscan=unscan; window.invDnSave=save;

  console.log('inventory_delivery_note.js loaded');
})();
