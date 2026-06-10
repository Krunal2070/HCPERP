/*
   inventory_qr.js - QR Scanner Engine (handheld) (RM)
   HCP Wellness - adapted from pm_stock_qr.js

   Hardware: USB / Bluetooth barcode scanners (no camera). Scanners emulate a
   keyboard — they type the box code very fast and end with Enter. We intercept
   those bursts globally.

   RM box codes look like:  RM-XXXX  or  RM-A0000001  (allocator format).
   On a valid scan we look the box up via /api/inventory_mgmt/boxes/by_code and:
     - if a scan-aware field is focused (Box Split #sb-code, DN .dnf-scan), let
       that field handle it natively (we don't intercept).
     - otherwise show a Box Info popup (code, material, qty, godown, status,
       batch, expiry) with quick actions.

   A small "Ready to scan" status pill sits in the page (optional mount).
   Gated by a new 'qr_scanner' access category.
*/

(function(){
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  const toast = (m,k,ms) => (window.invToast ? window.invToast(m,k,ms) : alert(m));
  const nf = (n) => Number(n||0).toLocaleString('en-IN');

  // RM box code shapes: "RM-A0000001" (allocator) or generic "RM-XXXX".
  const _BOX_RE = /^RM-[A-Z0-9]{3,12}$/i;
  function _looksLikeBox(s){ return _BOX_RE.test((s||'').trim()); }

  // Inputs that handle scans on their own (don't steal their bursts).
  const _NATIVE_IDS = new Set(['sb-code']);
  function _isNativeScanField(el){
    if(!el) return false;
    if(el.id && _NATIVE_IDS.has(el.id)) return true;
    if(el.classList && el.classList.contains('dnf-scan')) return true;
    if(el.classList && el.classList.contains('inv-qr-native')) return true; // opt-in
    return false;
  }

  function _hasAccess(){
    const a=window._invAccess;
    if(!a||!a.ready) return true;
    if(a.is_admin) return true;
    return a.access && a.access.qr_scanner!=='off' && a.access.qr_scanner!==false;
  }

  /* ── Global handheld interceptor ─────────────────────────────────────
     Scanners type fast (<80ms/char), end with Enter. Buffer chars; on Enter,
     if the buffer looks like a box code AND we're not in a native scan field
     or a normal text input the user is typing into, intercept it. */
  let _buf='', _lastT=0;
  function _onKeydown(e){
    if(!_hasAccess()) return;
    const now=Date.now();
    const tgt=e.target;

    // If focus is in a native scan field, let it do its own thing.
    if(_isNativeScanField(tgt)) return;

    if(e.key==='Enter'){
      const raw=_buf.trim();
      _buf='';
      if(raw.length>=4 && _looksLikeBox(raw)){
        // Only intercept if NOT actively typing into a regular text input,
        // OR if the burst was clearly scanner-speed.
        const inText = tgt && (tgt.tagName==='INPUT' || tgt.tagName==='TEXTAREA' || tgt.isContentEditable);
        if(!inText){
          e.preventDefault();
          _handle(raw);
        }
      }
      return;
    }
    // printable single char
    if(e.key && e.key.length===1){
      if(now-_lastT>120) _buf='';   // gap too long → start fresh (human typing)
      _buf+=e.key; _lastT=now;
      if(_buf.length>40) _buf=_buf.slice(-40);
    }
  }
  document.addEventListener('keydown', _onKeydown, true);

  /* ── Look up + dispatch ──────────────────────────────────────────── */
  async function _handle(rawCode){
    const code=(rawCode||'').trim().toUpperCase();
    if(!code) return;
    _setStatus('Looking up '+code+'…','busy');
    try {
      const r=await fetch('/api/inventory_mgmt/boxes/by_code?code='+encodeURIComponent(code));
      const d=await r.json();
      if(d.status!=='ok' || !d.box){ _setStatus('Not found: '+code,'err'); toast(d.message||('Box '+code+' not found'),'error',4000); return; }
      _setStatus('Scanned '+code,'ok');
      // If a scan-aware modal is open, prefer feeding it.
      if(_routeToOpenModal(d.box)) return;
      _showBoxInfo(d.box);
    } catch(e){ _setStatus('Scan error','err'); toast('Scan failed: '+e.message,'error'); }
  }

  // If Box Split or DN modal is open, route the scan into it.
  function _routeToOpenModal(box){
    const split=document.getElementById('invSplitModal');
    if(split && split.classList.contains('show')){
      const inp=document.getElementById('sb-code');
      if(inp){ inp.value=box.box_code; if(window.invSplitLookup) window.invSplitLookup(); return true; }
    }
    const dn=document.getElementById('invDnNewModal');
    if(dn && dn.classList.contains('show')){
      // feed the first visible DN scan input
      const inp=dn.querySelector('.dnf-scan');
      if(inp){
        inp.value=box.box_code;
        inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        return true;
      }
    }
    return false;
  }

  /* ── Box info popup ──────────────────────────────────────────────── */
  function _showBoxInfo(b){
    let ov=document.getElementById('invQrInfo');
    if(!ov){
      ov=document.createElement('div'); ov.id='invQrInfo';
      ov.style.cssText='position:fixed;inset:0;z-index:9500;background:rgba(15,23,42,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px';
      ov.addEventListener('mousedown',(e)=>{ if(e.target.id==='invQrInfo') ov.remove(); });
      document.body.appendChild(ov);
    }
    const statusColor = b.current_status==='in_stock' ? '#137333'
      : (b.current_status==='consumed'||b.current_status==='superseded') ? '#80868B' : '#C5221F';
    ov.innerHTML=`
      <div style="width:420px;max-width:92vw;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden;position:relative;font-family:var(--font-body,Inter,sans-serif)">
        <div style="height:3px;background:linear-gradient(90deg,var(--blue,#1A73E8),transparent)"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 8px">
          <div style="display:flex;align-items:center;gap:9px"><span style="font-size:18px">📦</span>
            <span style="font-family:var(--font-mono,monospace);font-weight:800;font-size:16px;color:var(--blue,#1A73E8)">${esc(b.box_code)}</span></div>
          <button onclick="document.getElementById('invQrInfo').remove()" style="width:28px;height:28px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:7px;background:none;cursor:pointer;color:var(--text3,#80868B)">&times;</button>
        </div>
        <div style="padding:4px 18px 16px">
          <div style="font-size:14px;font-weight:600;margin-bottom:10px">${esc(b.material_name||'')}</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12.5px">
            <span style="color:var(--text2,#5F6368)">Quantity</span><strong style="font-family:var(--font-mono,monospace)">${nf(b.per_box_qty)} ${esc(b.uom||'')}</strong>
            <span style="color:var(--text2,#5F6368)">Godown</span><span>${esc(b.godown_name||'—')}</span>
            <span style="color:var(--text2,#5F6368)">Status</span><span style="font-weight:700;color:${statusColor};text-transform:uppercase;font-size:11px">${esc(b.current_status||'')}</span>
            ${b.grn_no?`<span style="color:var(--text2,#5F6368)">GRN</span><span style="font-family:var(--font-mono,monospace)">${esc(b.grn_no)}</span>`:''}
            ${b.batch_num?`<span style="color:var(--text2,#5F6368)">Batch</span><span>${esc(b.batch_num)}</span>`:''}
            ${b.expiry_date?`<span style="color:var(--text2,#5F6368)">Expiry</span><span>${esc(b.expiry_date)}</span>`:''}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            <button class="btn" style="padding:7px 13px;font-size:12px" onclick="invQrTrackBox('${esc(b.box_code)}')"><i class="fas fa-route"></i> Track box</button>
            <button class="btn" style="padding:7px 13px;font-size:12px" onclick="invQrItemStock('${esc(b.box_code)}')"><i class="fas fa-warehouse"></i> Item stock</button>
            ${b.current_status==='in_stock'?`<button class="btn btn-primary" style="padding:7px 13px;font-size:12px" onclick="invQrSplitThis('${esc(b.box_code)}')"><i class="fas fa-cut"></i> Split</button>`:''}
            <button class="btn" style="padding:7px 13px;font-size:12px" onclick="document.getElementById('invQrInfo').remove()">Close</button>
          </div>
        </div>
      </div>`;
  }
  window.invQrSplitThis=function(code){
    document.getElementById('invQrInfo')?.remove();
    if(window.invSplitOpen){ window.invSplitOpen(); setTimeout(()=>{ const i=document.getElementById('sb-code'); if(i){ i.value=code; if(window.invSplitLookup) window.invSplitLookup(); } },120); }
  };

  /* ── A small shared overlay used by both Track & Item-stock ── */
  function _qrModal(title, icon, bodyHtml){
    let ov=document.getElementById('invQrSub');
    if(!ov){
      ov=document.createElement('div'); ov.id='invQrSub';
      ov.style.cssText='position:fixed;inset:0;z-index:9600;background:rgba(15,23,42,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px';
      ov.addEventListener('mousedown',(e)=>{ if(e.target.id==='invQrSub') ov.remove(); });
      document.body.appendChild(ov);
    }
    ov.innerHTML=`
      <div style="width:520px;max-width:94vw;max-height:86vh;overflow:auto;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);font-family:var(--font-body,Inter,sans-serif)">
        <div style="height:3px;background:linear-gradient(90deg,var(--blue,#1A73E8),transparent)"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 10px">
          <div style="display:flex;align-items:center;gap:9px;font-size:15px;font-weight:800"><span>${icon}</span>${esc(title)}</div>
          <button onclick="document.getElementById('invQrSub').remove()" style="width:28px;height:28px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:7px;background:none;cursor:pointer;color:var(--text3,#80868B)">&times;</button>
        </div>
        <div style="padding:2px 18px 18px">${bodyHtml}</div>
      </div>`;
  }
  function _fmtDate(s){ // YYYY-MM-DD[ HH:MM] → DD/MM/YYYY[ HH:MM]
    if(!s) return '';
    const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]||''}` : s;
  }

  /* ── Feature 1: Box tracker ── */
  window.invQrTrackBox=async function(code){
    _qrModal('Box Tracker','🧭','<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>');
    try{
      const r=await fetch('/api/inventory_mgmt/box_track?code='+encodeURIComponent(code));
      const d=await r.json();
      if(d.status!=='ok'){ _qrModal('Box Tracker','🧭',`<div style="padding:18px;color:#C5221F">${esc(d.message||'Not found')}</div>`); return; }
      const b=d.box;
      const tl=(d.timeline||[]);
      const mt=(t)=>({grn_create:'Created (GRN)',opening:'Opening stock',in:'Received In',out:'Sent Out',consume:'Consumed',adjust:'Adjusted',cancel:'Cancelled'}[t]||t);
      const dot=(t)=> (t==='out'||t==='consume'||t==='cancel') ? '#C5221F' : (t==='in'||t==='grn_create'||t==='opening') ? '#137333' : '#F57C00';
      const steps = tl.length ? tl.map((e,i)=>{
        const route = (e.from||e.to) ? `<span style="color:var(--text2,#5F6368)">${esc(e.from||'—')} → ${esc(e.to||'—')}</span>` : '';
        return `<div style="display:flex;gap:11px;${i<tl.length-1?'padding-bottom:14px':''}">
          <div style="display:flex;flex-direction:column;align-items:center">
            <span style="width:11px;height:11px;border-radius:50%;background:${dot(e.type)};margin-top:3px"></span>
            ${i<tl.length-1?'<span style="flex:1;width:2px;background:var(--border,#e5e7eb);margin-top:2px"></span>':''}
          </div>
          <div style="flex:1;font-size:12.5px">
            <div style="font-weight:700">${esc(mt(e.type))} <span style="font-weight:400;font-family:var(--font-mono,monospace);color:var(--text3,#80868B)">${nf(e.qty)} ${esc(b.uom||'')}</span></div>
            <div style="margin:1px 0">${route}</div>
            <div style="color:var(--text3,#80868B);font-size:11px">${esc(_fmtDate(e.at))}${e.by?' · '+esc(e.by):''}${e.remarks?' · '+esc(e.remarks):''}</div>
          </div></div>`;
      }).join('') : '<div style="padding:14px;color:var(--text2,#5F6368);text-align:center">No movement history recorded for this box.</div>';
      const statusColor = b.status==='in_stock'?'#137333':(b.status==='consumed'||b.status==='superseded')?'#80868B':'#C5221F';
      const body=`
        <div style="background:var(--bg,#FAF9F5);border-radius:10px;padding:11px 13px;margin-bottom:14px;font-size:12.5px">
          <div style="font-weight:700;margin-bottom:4px">${esc(b.material_name||'')}</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px">
            <span style="color:var(--text2,#5F6368)">Box</span><span style="font-family:var(--font-mono,monospace)">${esc(b.box_code)}</span>
            <span style="color:var(--text2,#5F6368)">Now at</span><span>${esc(b.godown||'—')} · <strong style="color:${statusColor};text-transform:uppercase;font-size:11px">${esc(b.status||'')}</strong></span>
            <span style="color:var(--text2,#5F6368)">Qty</span><span style="font-family:var(--font-mono,monospace)">${nf(b.qty)} ${esc(b.uom||'')}</span>
            ${b.grn_no?`<span style="color:var(--text2,#5F6368)">GRN</span><span style="font-family:var(--font-mono,monospace)">${esc(b.grn_no)}</span>`:''}
          </div>
        </div>
        <div style="font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);margin-bottom:10px">Journey</div>
        ${steps}`;
      _qrModal('Box Tracker','🧭',body);
    }catch(e){ _qrModal('Box Tracker','🧭',`<div style="padding:18px;color:#C5221F">Network error</div>`); }
  };

  /* ── Feature 2: Item stock (godown-wise) — by box code ── */
  window.invQrItemStock=async function(code){
    _qrModal('Item Stock','🏬','<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>');
    try{
      const r=await fetch('/api/inventory_mgmt/item_godown_stock?code='+encodeURIComponent(code));
      const d=await r.json();
      if(d.status!=='ok'){ _qrModal('Item Stock','🏬',`<div style="padding:18px;color:#C5221F">${esc(d.message||'Not found')}</div>`); return; }
      _renderItemStock(d);
    }catch(e){ _qrModal('Item Stock','🏬',`<div style="padding:18px;color:#C5221F">Network error</div>`); }
  };
  function _renderItemStock(d){
    const m=d.material, bd=(d.breakdown||[]);
    const rows = bd.length ? bd.map(x=>`
        <tr><td style="padding:7px 10px;font-size:12.5px;border-top:1px solid var(--border,rgba(0,0,0,.06))">${esc(x.godown)}</td>
        <td style="padding:7px 10px;font-size:12.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));text-align:right;color:var(--text3,#80868B)">${x.boxes}</td>
        <td style="padding:7px 10px;font-size:12.5px;border-top:1px solid var(--border,rgba(0,0,0,.06));text-align:right;font-family:var(--font-mono,monospace);font-weight:700">${nf(x.qty)}</td></tr>`).join('')
      : '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text2,#5F6368)">No stock in any godown.</td></tr>';
    const mslWarn = (m.msl>0 && d.total<=m.msl) ? `<span style="color:#C5221F;font-weight:700"> · below MSL (${nf(m.msl)})</span>` : '';
    const body=`
        <div style="margin-bottom:6px;font-size:14px;font-weight:700">${esc(m.name||'')}</div>
        <div style="margin-bottom:14px;font-size:12.5px;color:var(--text2,#5F6368)">Total stock: <strong style="color:var(--text,#1F1F1F);font-family:var(--font-mono,monospace)">${nf(d.total)} ${esc(m.uom||'')}</strong>${mslWarn}</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:7px 10px;text-align:left;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Godown</th>
            <th style="padding:7px 10px;text-align:right;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Boxes</th>
            <th style="padding:7px 10px;text-align:right;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3,#80868B);background:var(--bg,#FAF9F5)">Qty</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    _qrModal('Item Stock','🏬',body);
  }

  /* ── Status pill (optional, mounts into #invQrStatusMount if present) ── */
  function _setStatus(text,kind){
    const el=document.getElementById('invQrStatusText');
    if(el){ el.textContent=text; }
    const dot=document.getElementById('invQrStatusDot');
    if(dot){ dot.style.background = kind==='ok'?'#137333':kind==='err'?'#C5221F':kind==='busy'?'#F57C00':'#1A73E8'; }
  }
  function _mountStatus(){
    const mount=document.getElementById('invQrStatusMount');
    if(!mount || document.getElementById('invQrStatusPill')) return;
    const pill=document.createElement('div'); pill.id='invQrStatusPill';
    pill.style.cssText='display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:99px;background:var(--blue-lt,#E8F0FE);font-size:11px;font-weight:600;color:var(--text2,#5F6368)';
    pill.innerHTML='<span id="invQrStatusDot" style="width:8px;height:8px;border-radius:50%;background:#1A73E8"></span><span id="invQrStatusText">Ready to scan</span>';
    mount.appendChild(pill);
  }

  /* ── Sidebar menu entry points (no physical scan needed) ──────────────
     Adds "Box Tracker" and "Stock Check" under the Stock section. Each opens
     a small type-or-scan lookup. Gated by the same qr_scanner access. */
  function _injectNav(){
    if(document.getElementById('invQrNavTrack')) return;
    const navBody=document.querySelector('.inv-nav-body');
    if(!navBody) return;
    const a=window._invAccess||{};
    const ready=!!a.ready, isAdmin=!!a.is_admin;
    const hasQr=a.access && a.access.qr_scanner!=='off' && a.access.qr_scanner!==false;
    if(ready && !isAdmin && !hasQr) return;   // no access → no menu
    // Prefer the Stock section; else Manage; else append.
    let section=Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s=>(s.querySelector('.inv-nav-section-label')||{}).textContent==='Stock');
    if(!section) section=Array.from(navBody.querySelectorAll('.inv-nav-section'))
      .find(s=>(s.querySelector('.inv-nav-section-label')||{}).textContent==='Manage');
    if(!section){
      section=document.createElement('div'); section.className='inv-nav-section';
      section.innerHTML='<div class="inv-nav-section-label">Stock</div>';
      navBody.appendChild(section);
    }
    const mk=(id,icon,label,fn)=>{
      const it=document.createElement('div');
      it.className='inv-nav-item'; it.id=id; it.onclick=fn;
      it.innerHTML=`<span class="ico">${icon}</span><span>${label}</span>`;
      section.appendChild(it);
    };
    mk('invQrNavTrack','🧭','Box Tracker', ()=>invBoxTrackerOpen());
    mk('invQrNavStock','🏬','Stock Check', ()=>invStockCheckOpen());
  }

  /* ───────────────────────────────────────────────────────────────────
     Box Tracker — dedicated modal: enter/scan a box code → movement timeline.
     ─────────────────────────────────────────────────────────────────── */
  window.invBoxTrackerOpen=function(){
    let ov=document.getElementById('invQrLookup');
    if(!ov){
      ov=document.createElement('div'); ov.id='invQrLookup';
      ov.style.cssText='position:fixed;inset:0;z-index:9550;background:rgba(15,23,42,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:80px 20px';
      ov.addEventListener('mousedown',(e)=>{ if(e.target.id==='invQrLookup') ov.remove(); });
      document.body.appendChild(ov);
    }
    ov.innerHTML=`
      <div style="width:460px;max-width:94vw;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden;font-family:var(--font-body,Inter,sans-serif)">
        <div style="height:3px;background:linear-gradient(90deg,var(--blue,#1A73E8),transparent)"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 8px">
          <div style="display:flex;align-items:center;gap:9px;font-size:15px;font-weight:800"><span>🧭</span>Box Tracker</div>
          <button onclick="document.getElementById('invQrLookup').remove()" style="width:28px;height:28px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:7px;background:none;cursor:pointer;color:var(--text3,#80868B)">&times;</button>
        </div>
        <div style="padding:6px 18px 18px">
          <label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);display:block;margin-bottom:5px">Scan or type a box code</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="invQrLookupInput" placeholder="e.g. RM-A0000001" autocomplete="off"
              style="flex:1;padding:9px 11px;border:1px solid var(--border,#d1d5db);border-radius:9px;font-size:14px;font-family:var(--font-mono,monospace);text-transform:uppercase">
            <button class="btn btn-primary" style="padding:9px 16px;font-size:13px" onclick="invBoxTrackerGo()"><i class="fas fa-route"></i> Track</button>
          </div>
          <div style="font-size:11px;color:var(--text3,#80868B);margin-top:7px">Shows this box full movement history across godowns.</div>
          <div id="invQrLookupErr" style="color:#C5221F;font-size:12px;margin-top:8px"></div>
        </div>
      </div>`;
    setTimeout(()=>{ const i=document.getElementById('invQrLookupInput'); if(i){ i.focus();
      i.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); invBoxTrackerGo(); } }); } },40);
  };
  window.invBoxTrackerGo=async function(){
    const inp=document.getElementById('invQrLookupInput');
    const err=document.getElementById('invQrLookupErr');
    const code=(inp&&inp.value||'').trim().toUpperCase();
    if(err) err.textContent='';
    if(!code){ if(err) err.textContent='Please enter a box code.'; return; }
    try{
      const r=await fetch('/api/inventory_mgmt/boxes/by_code?code='+encodeURIComponent(code));
      const d=await r.json();
      if(d.status!=='ok'){ if(err) err.textContent=d.message||('Box '+code+' not found'); return; }
      document.getElementById('invQrLookup')?.remove();
      invQrTrackBox(code);
    }catch(e){ if(err) err.textContent='Network error — try again.'; }
  };

  /* ───────────────────────────────────────────────────────────────────
     Stock Check — dedicated modal: search a MATERIAL → godown-wise stock.
     Uses the searchable combobox (window.invCombo) per house style.
     ─────────────────────────────────────────────────────────────────── */
  let _scMaterialId=0;
  window.invStockCheckOpen=function(){
    let ov=document.getElementById('invScLookup');
    if(!ov){
      ov=document.createElement('div'); ov.id='invScLookup';
      ov.style.cssText='position:fixed;inset:0;z-index:9550;background:rgba(15,23,42,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:80px 20px';
      ov.addEventListener('mousedown',(e)=>{ if(e.target.id==='invScLookup') ov.remove(); });
      document.body.appendChild(ov);
    }
    _scMaterialId=0;
    ov.innerHTML=`
      <div style="width:460px;max-width:94vw;background:var(--white,#fff);border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:visible;font-family:var(--font-body,Inter,sans-serif)">
        <div style="height:3px;background:linear-gradient(90deg,var(--blue,#1A73E8),transparent)"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 8px">
          <div style="display:flex;align-items:center;gap:9px;font-size:15px;font-weight:800"><span>🏬</span>Stock Check</div>
          <button onclick="document.getElementById('invScLookup').remove()" style="width:28px;height:28px;border:1px solid var(--border2,rgba(0,0,0,.13));border-radius:7px;background:none;cursor:pointer;color:var(--text3,#80868B)">&times;</button>
        </div>
        <div style="padding:6px 18px 18px">
          <label style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--text3,#80868B);display:block;margin-bottom:5px">Choose a material</label>
          <div style="display:flex;gap:8px;align-items:flex-start">
            <div id="invScCombo" style="flex:1"></div>
            <button class="btn btn-primary" style="padding:9px 16px;font-size:13px" onclick="invStockCheckGo()"><i class="fas fa-warehouse"></i> Check</button>
          </div>
          <div style="font-size:11px;color:var(--text3,#80868B);margin-top:7px">Shows this item across all godowns. (Or scan any box label for the same view.)</div>
          <div id="invScErr" style="color:#C5221F;font-size:12px;margin-top:8px"></div>
        </div>
      </div>`;
    // Populate the searchable material combo from the items endpoint.
    fetch('/api/inventory_mgmt/items?department=RM').then(r=>r.json()).then(d=>{
      const list=(d.items||d.materials||d.rows||[]).map(m=>({
        value:String(m.id||m.material_id||''),
        label:(m.material_name||m.name||''),
      })).filter(o=>o.value && o.label);
      if(window.invCombo){
        window.invCombo({ mount:document.getElementById('invScCombo'), placeholder:'Search material…',
          options:list, onChange:(v)=>{ _scMaterialId=parseInt(v)||0; } });
      } else {
        // fallback: plain select
        const sel=document.createElement('select'); sel.style.cssText='width:100%;padding:9px';
        list.forEach(o=>{ const op=document.createElement('option'); op.value=o.value; op.textContent=o.label; sel.appendChild(op); });
        sel.onchange=()=>{ _scMaterialId=parseInt(sel.value)||0; };
        const mt=document.getElementById('invScCombo'); if(mt){ mt.innerHTML=''; mt.appendChild(sel); _scMaterialId=parseInt(list[0]&&list[0].value)||0; }
      }
    }).catch(()=>{ const e=document.getElementById('invScErr'); if(e) e.textContent='Could not load materials.'; });
  };
  window.invStockCheckGo=function(){
    const err=document.getElementById('invScErr');
    if(err) err.textContent='';
    if(!_scMaterialId){ if(err) err.textContent='Please choose a material.'; return; }
    document.getElementById('invScLookup')?.remove();
    invQrItemStockByMaterial(_scMaterialId);
  };
  // Stock check by material_id (used by the dedicated Stock Check modal).
  window.invQrItemStockByMaterial=async function(materialId){
    _qrModal('Item Stock','🏬','<div style="padding:24px;text-align:center;color:var(--text2,#5F6368)">Loading…</div>');
    try{
      const r=await fetch('/api/inventory_mgmt/item_godown_stock?material_id='+encodeURIComponent(materialId));
      const d=await r.json();
      if(d.status!=='ok'){ _qrModal('Item Stock','🏬',`<div style="padding:18px;color:#C5221F">${esc(d.message||'Not found')}</div>`); return; }
      _renderItemStock(d);
    }catch(e){ _qrModal('Item Stock','🏬',`<div style="padding:18px;color:#C5221F">Network error</div>`); }
  };

  function _boot(){ _mountStatus(); _injectNav(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_boot); else _boot();
  document.addEventListener('inv-access-ready', function(){ _mountStatus(); _injectNav(); });

  // Manual entry hook (e.g. type a code and call this)
  window.invQrScan = _handle;

  console.log('inventory_qr.js loaded (handheld scanner)');
})();
