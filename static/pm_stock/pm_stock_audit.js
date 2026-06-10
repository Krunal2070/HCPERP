/* pm_stock_audit.js
 * ────────────────────────────────────────────────────────────────
 * Physical Stock Check page logic.
 *
 * Tabs:
 *   new      — start a session (pick godown + product scope)
 *   open     — sessions currently being scanned; click to keep scanning
 *   pending  — submitted for settlement; admin reviews & settles
 *   history  — settled/rejected sessions
 *
 * All state is per-tab; on session open the modal shows scan input,
 * live variance table, and action buttons (Submit / Reopen / Settle / Reject)
 * depending on session status + user role.
 */

(function(){
'use strict';

const $  = id => document.getElementById(id);
const fmtN = n => Number(n||0).toLocaleString('en-IN');
const fmtNum = n => Number(n||0).toLocaleString('en-IN', {maximumFractionDigits:2});

const ROLE = ($('user-role')?.dataset?.role || '').toLowerCase();
const IS_ADMIN = (ROLE === 'admin');

// ────────────────────────────────────────────────────────────────
// Tab navigation
// ────────────────────────────────────────────────────────────────
window.audSetTab = function(name){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if(name === 'open')     loadSessionList('open',                    'list-open');
  if(name === 'pending')  loadSessionList('pending_settlement',      'list-pending');
  if(name === 'history')  loadSessionList('settled,rejected',        'list-history');
};

// ────────────────────────────────────────────────────────────────
// Safe fetch helper — surfaces HTML-error-page issues clearly
// ────────────────────────────────────────────────────────────────
async function api(url, opts){
  let res;
  try {
    res = await fetch(url, opts || {});
  } catch(e){
    throw new Error('Network error: ' + (e.message || e));
  }
  const text = await res.text();
  if((text||'').trimStart().startsWith('<')){
    throw new Error(res.status === 404
      ? 'endpoint not found — Flask may need a restart'
      : `server returned HTML error (HTTP ${res.status})`);
  }
  let j;
  try { j = JSON.parse(text); } catch(_){ throw new Error(`bad JSON (HTTP ${res.status})`); }
  if(j && j.status === 'error') throw new Error(j.message || 'request failed');
  return j;
}

function toast(msg, kind){
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || 'ok');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ────────────────────────────────────────────────────────────────
// Tab counts in header
// ────────────────────────────────────────────────────────────────
async function refreshCounts(){
  try {
    const j = await api('/api/pm_stock/audit/list?status=open,pending_settlement&limit=200');
    const open = j.sessions.filter(s => s.status==='open').length;
    const pend = j.sessions.filter(s => s.status==='pending_settlement').length;
    $('cnt-open').textContent    = open || '·';
    $('cnt-pending').textContent = pend || '·';
  } catch(_){}
}

// ────────────────────────────────────────────────────────────────
// NEW SESSION TAB
// ────────────────────────────────────────────────────────────────
const _picked = new Map(); // product_id -> {product_name, product_code, pm_type}
let _searchTimer = null;

async function initGodowns(){
  try {
    const j = await api('/api/pm_stock/audit/godowns');
    const sel = $('new-godown');
    sel.innerHTML = '<option value="">— Select location —</option>' +
      j.godowns.map(g => {
        const ic = (g.godown_type === 'floor') ? '🏭' : '📦';
        return `<option value="${g.id}">${ic} ${escHtml(g.name)}</option>`;
      }).join('');
  } catch(e){
    toast('Failed to load locations: ' + e.message, 'err');
  }
}

window.audOnGodownChange = function(){
  // Re-run search so product list reflects products available at this godown
  audProductSearchDebounced(true);
  refreshStartButton();
};

window.audProductSearchDebounced = function(immediate){
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(audProductSearch, immediate ? 0 : 250);
};

async function audProductSearch(){
  const q = $('prod-search').value.trim();
  const gid = $('new-godown').value;
  if(!q && !gid){
    $('picker-results').classList.add('hidden');
    return;
  }
  try {
    const params = new URLSearchParams();
    if(q)    params.set('q', q);
    if(gid)  params.set('godown_id', gid);
    params.set('limit', '30');
    const j = await api('/api/pm_stock/audit/products/search?' + params.toString());
    const list = j.products || [];
    if(!list.length){
      $('picker-results').classList.remove('hidden');
      $('picker-results').innerHTML = '<div class="picker-result" style="color:var(--hmuted,#9ca3af); cursor:default">No products found.</div>';
      return;
    }
    $('picker-results').classList.remove('hidden');
    $('picker-results').innerHTML = list.map(p => {
      const sel = _picked.has(p.product_id);
      return `<div class="picker-result" onclick="audPickProduct(${p.product_id}, '${escAttr(p.product_name)}', '${escAttr(p.product_code||'')}', '${escAttr(p.pm_type||'')}')">
        <div class="pname">${sel ? '✓ ' : ''}${escHtml(p.product_name)}</div>
        <div class="pmeta">${escHtml(p.product_code||'')} · ${escHtml(p.pm_type||'')}</div>
      </div>`;
    }).join('');
  } catch(e){
    toast(e.message, 'err');
  }
}

window.audPickProduct = function(id, name, code, pmtype){
  if(_picked.has(id)) _picked.delete(id);
  else _picked.set(id, {product_id:id, product_name:name, product_code:code, pm_type:pmtype});
  renderPicked();
  refreshStartButton();
  // Re-render the picker results so the checkmark updates
  audProductSearch();
};

function renderPicked(){
  const box = $('picker-selected');
  if(!_picked.size){
    box.innerHTML = '<span style="font-size:11px; color:var(--hmuted,#9ca3af);">No products selected yet — search and click to add.</span>';
    return;
  }
  box.innerHTML = Array.from(_picked.values()).map(p =>
    `<span class="pchip">${escHtml(p.product_name)} <span class="x" onclick="audUnpickProduct(${p.product_id})">✕</span></span>`
  ).join('');
}

window.audUnpickProduct = function(id){
  _picked.delete(id);
  renderPicked();
  refreshStartButton();
};

function refreshStartButton(){
  $('btn-start-session').disabled = !($('new-godown').value && _picked.size > 0);
}

window.audStartSession = async function(){
  const gid = $('new-godown').value;
  const note = $('new-note').value.trim();
  const product_ids = Array.from(_picked.keys());
  if(!gid || !product_ids.length){
    toast('Pick a location and at least one product', 'warn');
    return;
  }
  const btn = $('btn-start-session');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting…';
  try {
    const j = await api('/api/pm_stock/audit/start', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({godown_id:Number(gid), product_ids, note})
    });
    toast(`✓ ${j.session_no} created`, 'ok');
    _picked.clear();
    renderPicked();
    $('prod-search').value = '';
    $('picker-results').classList.add('hidden');
    $('new-note').value = '';
    openSessionModal(j.session_id);
    refreshCounts();
  } catch(e){
    toast(e.message, 'err');
  } finally {
    btn.innerHTML = '<i class="fas fa-play"></i> Start Session & Begin Scanning';
    refreshStartButton();
  }
};

// ────────────────────────────────────────────────────────────────
// SESSION LIST RENDERING (open / pending / history tabs)
// ────────────────────────────────────────────────────────────────
async function loadSessionList(statusCsv, mountId){
  const mount = $(mountId);
  mount.innerHTML = '<div style="color:var(--hmuted,#9ca3af); padding:14px;">Loading…</div>';
  try {
    const j = await api('/api/pm_stock/audit/list?status=' + encodeURIComponent(statusCsv) + '&limit=100');
    if(!j.sessions.length){
      mount.innerHTML = '<div class="card" style="text-align:center; color:var(--hmuted,#9ca3af);">No sessions in this state.</div>';
      return;
    }
    mount.innerHTML = j.sessions.map(s => {
      const chip = chipFor(s.status);
      const when = (s.created_at || '').slice(0,16).replace('T',' ');
      return `
        <div class="session-row" onclick="openSessionModal(${s.session_id})">
          <div class="sno">${escHtml(s.session_no)}</div>
          <div class="meta">
            📦 <strong>${escHtml(s.godown_name||'?')}</strong>
            · ${s.product_count} product${s.product_count===1?'':'s'}
            · ${s.scan_count} scan${s.scan_count===1?'':'s'}
            ${s.note ? `<div style="font-size:10.5px; color:var(--hmuted,#9ca3af); margin-top:2px">${escHtml(s.note)}</div>` : ''}
          </div>
          <div class="meta">${chip}</div>
          <div class="meta"><span class="who">${escHtml(s.created_by||'')}</span><br>${escHtml(when)}</div>
          <div style="text-align:right;"><span class="btn btn-outline btn-sm">Open →</span></div>
        </div>`;
    }).join('');
  } catch(e){
    mount.innerHTML = `<div class="card" style="color:#dc2626;">${escHtml(e.message)}</div>`;
  }
}

function chipFor(st){
  const map = {
    open:                ['chip-open',     'OPEN'],
    pending_settlement:  ['chip-pending',  'PENDING'],
    settled:             ['chip-settled',  'SETTLED'],
    rejected:            ['chip-rejected', 'REJECTED'],
  };
  const [cls, lbl] = map[st] || ['chip-open', st];
  return `<span class="chip ${cls}">${lbl}</span>`;
}

// ────────────────────────────────────────────────────────────────
// SESSION DETAIL MODAL
// ────────────────────────────────────────────────────────────────
let _activeSid = null;
let _activeData = null;

window.openSessionModal = async function(sid){
  _activeSid = sid;
  $('session-modal').classList.add('open');
  $('sm-title').textContent = 'Loading…';
  $('sm-body').innerHTML = 'Loading…';
  $('sm-ftr').innerHTML = '';
  try {
    await reloadSessionModal();
  } catch(e){
    $('sm-body').innerHTML = `<div style="color:#dc2626;">${escHtml(e.message)}</div>`;
  }
};

async function reloadSessionModal(){
  const j = await api('/api/pm_stock/audit/' + _activeSid);
  _activeData = j;
  const s = j.session;
  const v = j.variance || {per_product:[], missing_boxes:[], extra_boxes:[], totals:{}};

  $('sm-title').innerHTML = `Session <span style="font-family:monospace; color:#4f46e5">${escHtml(s.session_no)}</span> ${chipFor(s.status)}`;

  // Body: stats + scan input (if open) + variance table + box lists
  const canScan = (s.status === 'open');
  const isAdminEffective = j.is_admin;

  let body = '';

  // Header meta line
  body += `<div style="font-size:11.5px; color:var(--hmuted2,#6b7280); margin-bottom:14px;">
    📦 <strong>${escHtml(s.godown_name||'')}</strong>
    · started by <strong>${escHtml(s.created_by||'')}</strong> at ${escHtml((s.created_at||'').slice(0,16).replace('T',' '))}
    ${s.submitted_by ? `· submitted by <strong>${escHtml(s.submitted_by)}</strong>` : ''}
    ${s.settled_by   ? `· settled by <strong>${escHtml(s.settled_by)}</strong> at ${escHtml((s.settled_at||'').slice(0,16).replace('T',' '))}` : ''}
    ${s.rejected_by  ? `· rejected by <strong>${escHtml(s.rejected_by)}</strong>` : ''}
    ${s.note ? `<div style="margin-top:3px; font-style:italic;">📝 ${escHtml(s.note)}</div>` : ''}
    ${s.settle_note ? `<div style="margin-top:3px; font-style:italic;">⚙️ ${escHtml(s.settle_note)}</div>` : ''}
  </div>`;

  // Stats
  const t = v.totals || {};
  body += `<div class="stats">
    <div class="stat"><div class="lbl-sm">Products in scope</div><div class="val">${fmtN(t.products_in_scope||0)}</div></div>
    <div class="stat"><div class="lbl-sm">System Boxes</div><div class="val">${fmtN(t.expected_box_total||0)}</div><div class="sub">expected</div></div>
    <div class="stat"><div class="lbl-sm">Scanned Boxes</div><div class="val">${fmtN(t.scanned_box_total||0)}</div><div class="sub">${j.scans.length} scan event${j.scans.length===1?'':'s'}</div></div>
    <div class="stat ${t.missing_count > 0 ? 'miss' : (t.extra_count > 0 ? 'extra' : '')}"><div class="lbl-sm">Discrepancies</div><div class="val">${fmtN((t.missing_count||0) + (t.extra_count||0))}</div><div class="sub">${t.missing_count||0} missing · ${t.extra_count||0} extra</div></div>
  </div>`;

  // Scan input (only if open)
  if(canScan){
    body += `<div class="card scan-card">
      <div class="scan-row">
        <div class="icon">📷</div>
        <div style="flex:1">
          <label class="lbl">Scan box at this location</label>
          <input type="text" id="sm-scan" placeholder="e.g. PLIXBOTT91-G0003-B001" autocomplete="off"
            onkeydown="audHandleScan(event)">
        </div>
      </div>
      <div id="sm-scan-feedback" class="scan-feedback"></div>
    </div>`;
  }

  // Per-product variance table
  if(v.per_product && v.per_product.length){
    body += `<div class="card">
      <h3>📊 Per-Product Variance</h3>
      <table class="vt">
        <thead><tr>
          <th>Product</th>
          <th class="num">System Boxes</th>
          <th class="num">Scanned Boxes</th>
          <th class="num">Δ Boxes</th>
          <th class="num">System Qty</th>
          <th class="num">Scanned Qty</th>
          <th class="num">Δ Qty</th>
        </tr></thead>
        <tbody>${v.per_product.map(p => {
          const dq = Number(p.delta_qty)||0;
          const db = Number(p.delta_box)||0;
          const matched = (Math.abs(dq) < 0.001 && db === 0);
          const dqClass = matched ? 'delta-zero' : (dq > 0 ? 'delta-pos' : 'delta-neg');
          const dbClass = matched ? 'delta-zero' : (db > 0 ? 'delta-pos' : 'delta-neg');
          return `<tr class="${matched ? 'match-ok' : ''}">
            <td class="product-cell" title="${escHtml(p.product_name||'')}">
              <span class="pname">${escHtml(p.product_name||'')}</span>
              ${p.product_code ? `<span class="pcode">${escHtml(p.product_code)}</span>` : ''}
              ${p.pm_type ? `<span class="pmtype">${escHtml(p.pm_type)}</span>` : ''}
            </td>
            <td class="num">${fmtN(p.expected_box||0)}</td>
            <td class="num">${fmtN(p.scanned_box||0)}</td>
            <td class="num ${dbClass}">${db>0?'+':''}${fmtN(db)}</td>
            <td class="num">${fmtNum(p.expected_qty||0)}</td>
            <td class="num">${fmtNum(p.scanned_qty||0)}</td>
            <td class="num ${dqClass}">${dq>0?'+':''}${fmtNum(dq)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  }

  // Missing boxes
  if(v.missing_boxes && v.missing_boxes.length){
    body += `<div class="card">
      <h3>⚠️ Missing Boxes <span style="color:#dc2626; font-weight:800">(${v.missing_boxes.length})</span></h3>
      <div class="hint">System says these boxes should be here, but they weren't scanned.</div>
      <table class="vt">
        <thead><tr><th>Box Code</th><th>Product</th><th class="num">Qty</th></tr></thead>
        <tbody>${v.missing_boxes.map(b => `
          <tr>
            <td style="font-family:monospace; font-weight:700; color:#dc2626;">${escHtml(b.box_code)}</td>
            <td><span class="pname">${escHtml(b.product_name||'?')}</span>${b.pm_type ? ` <span class="pmtype">${escHtml(b.pm_type)}</span>` : ''}</td>
            <td class="num">${fmtNum(b.per_box_qty||0)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  // Extra boxes
  if(v.extra_boxes && v.extra_boxes.length){
    const reasonLabels = {
      wrong_godown: 'wrong godown',
      not_in_scope: 'not in audit scope',
      not_in_stock: 'system says not in stock',
      unknown_box:  'unknown box code',
      unknown:      'unexpected'
    };
    body += `<div class="card">
      <h3>➕ Extra Boxes <span style="color:#d97706; font-weight:800">(${v.extra_boxes.length})</span></h3>
      <div class="hint">These boxes were scanned but the system didn't expect them here.</div>
      <table class="vt">
        <thead><tr><th>Box Code</th><th>Product</th><th>System Says</th><th class="num">Qty</th></tr></thead>
        <tbody>${v.extra_boxes.map(b => `
          <tr>
            <td style="font-family:monospace; font-weight:700; color:#d97706;">${escHtml(b.box_code)}</td>
            <td><span class="pname">${escHtml(b.product_name||'?')}</span>${b.pm_type ? ` <span class="pmtype">${escHtml(b.pm_type)}</span>` : ''}</td>
            <td style="font-size:11px; color:var(--hmuted2,#6b7280);">
              ${escHtml(reasonLabels[b.reason]||b.reason||'')}
              ${b.system_godown_name ? `<br><span style="font-size:10px;">at ${escHtml(b.system_godown_name)}</span>` : ''}
              ${b.system_status      ? `<br><span style="font-size:10px;">status: ${escHtml(b.system_status)}</span>` : ''}
            </td>
            <td class="num">${fmtNum(b.per_box_qty||0)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  // Scans table (compact)
  if(j.scans && j.scans.length){
    body += `<div class="card">
      <h3>🔍 Scans <span style="color:var(--hmuted,#9ca3af); font-weight:600">(${j.scans.length})</span></h3>
      <table class="vt">
        <thead><tr><th>Box Code</th><th>Product</th><th>Scanned By</th><th>When</th>${canScan ? '<th></th>' : ''}</tr></thead>
        <tbody>${j.scans.slice(0,200).map(s => `
          <tr>
            <td style="font-family:monospace; font-weight:700;">${escHtml(s.box_code)}</td>
            <td>${escHtml(s.product_name||'(unknown)')}</td>
            <td>${escHtml(s.scanned_by||'')}</td>
            <td style="font-size:11px;">${escHtml((s.scanned_at||'').slice(0,16).replace('T',' '))}</td>
            ${canScan ? `<td><button class="btn btn-outline btn-sm" onclick="audUnscan(${s.scan_id})">undo</button></td>` : ''}
          </tr>`).join('')}</tbody>
      </table>
      ${j.scans.length > 200 ? `<div class="hint" style="margin-top:6px">Showing latest 200 of ${j.scans.length} scans.</div>` : ''}
    </div>`;
  }

  $('sm-body').innerHTML = body;

  // Footer actions per status + role
  const f = $('sm-ftr');
  let ftr = `<button class="btn btn-outline" onclick="audCloseModal()">Close</button>`;
  if(s.status === 'open'){
    ftr += `<button class="btn btn-warning" onclick="audSubmit()">📨 Submit for Settlement</button>`;
  }
  if(s.status === 'pending_settlement' && isAdminEffective){
    ftr += `<button class="btn btn-outline" onclick="audReopen()">↶ Reopen for More Scans</button>`;
    ftr += `<button class="btn btn-danger"  onclick="audReject()">✕ Reject</button>`;
    ftr += `<button class="btn btn-success" onclick="audSettle()">✓ Settle Variance</button>`;
  }
  if(s.status === 'pending_settlement' && !isAdminEffective){
    ftr += `<span style="font-size:11px; color:var(--hmuted2,#6b7280); align-self:center;">Waiting for admin to settle…</span>`;
  }
  if(s.status === 'settled' && isAdminEffective){
    // Admin can reverse a settled session — restores box states, deletes
    // posted ledger txns, sets status back to pending_settlement. The
    // scans themselves stay intact so admin can review and re-settle.
    ftr += `<button class="btn btn-danger" onclick="audReverse()" title="Roll back this settlement: restore boxes + delete ledger txns. Session returns to pending_settlement.">⏪ Reverse Settlement</button>`;
  }
  f.innerHTML = ftr;

  // Focus scan input
  if(canScan){
    setTimeout(() => $('sm-scan')?.focus(), 100);
  }
}

window.audCloseModal = function(){
  $('session-modal').classList.remove('open');
  _activeSid = null;
  _activeData = null;
  refreshCounts();
};

window.audHandleScan = async function(ev){
  if(ev.key !== 'Enter') return;
  ev.preventDefault();
  const inp = $('sm-scan');
  const code = (inp.value || '').trim().toUpperCase();
  if(!code) return;
  const fb = $('sm-scan-feedback');
  fb.className = 'scan-feedback';
  fb.textContent = 'Looking up ' + code + '…';
  inp.disabled = true;
  try {
    const j = await api(`/api/pm_stock/audit/${_activeSid}/scan`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({box_code: code})
    });
    // Three states (mirrors the Inventory module's audit scanner):
    //   duplicate         → yellow,  "↻ X already in session"
    //   known_box=false   → yellow,  "⚠ X added (unknown — will show as extra)"
    //   known_box=true    → green,   "✓ X · <product>"
    // Unknown codes are kept (not rejected) so the operator can scan
    // whatever they physically have; the admin reviews extras at
    // settlement time.
    if (j.duplicate) {
      fb.className = 'scan-feedback warn';
      fb.textContent = `↻ ${code} already in session`;
    } else if (!j.known_box) {
      fb.className = 'scan-feedback warn';
      fb.textContent = `⚠ ${code} added — unknown box (will show as extra)`;
    } else {
      fb.className = 'scan-feedback ok';
      const name = j.box?.product_name || '(unknown product)';
      fb.textContent = `✓ ${code} · ${name}`;
    }
    inp.value = '';
    await reloadSessionModal();
  } catch(e){
    fb.className = 'scan-feedback err';
    fb.textContent = '✗ ' + (e.message || 'Scan failed');
    inp.select();
  } finally {
    inp.disabled = false;
    inp.focus();
  }
};

window.audUnscan = async function(scanId){
  if(!confirm('Undo this scan?')) return;
  try {
    await api(`/api/pm_stock/audit/${_activeSid}/scan/${scanId}`, {method:'DELETE'});
    toast('Scan removed', 'ok');
    await reloadSessionModal();
  } catch(e){ toast(e.message, 'err'); }
};

window.audSubmit = async function(){
  const t = _activeData?.variance?.totals || {};
  const totalDisc = (t.missing_count||0) + (t.extra_count||0);
  let msg = 'Submit this session for settlement?\n\n';
  msg += `Scanned ${t.scanned_box_total||0} boxes · ${t.products_in_scope||0} product(s)`;
  if(totalDisc) msg += `\n\n⚠️ ${totalDisc} discrepancy line(s) will need admin settlement.`;
  if(!confirm(msg)) return;
  try {
    await api(`/api/pm_stock/audit/${_activeSid}/submit`, {method:'POST', headers:{'Content-Type':'application/json'}, body: '{}'});
    toast('Submitted — admin will review.', 'ok');
    await reloadSessionModal();
    refreshCounts();
  } catch(e){ toast(e.message, 'err'); }
};

window.audReopen = async function(){
  if(!confirm('Reopen this session for more scanning?')) return;
  try {
    await api(`/api/pm_stock/audit/${_activeSid}/reopen`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    toast('Reopened', 'ok');
    await reloadSessionModal();
    refreshCounts();
  } catch(e){ toast(e.message, 'err'); }
};

window.audReject = async function(){
  const note = prompt('Reason for rejection (will be recorded):');
  if(!note || !note.trim()){
    toast('Rejection note is required', 'warn'); return;
  }
  try {
    await api(`/api/pm_stock/audit/${_activeSid}/reject`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({note: note.trim()})
    });
    toast('Rejected', 'ok');
    await reloadSessionModal();
    refreshCounts();
  } catch(e){ toast(e.message, 'err'); }
};

window.audSettle = async function(){
  const t = _activeData?.variance?.totals || {};
  const products = _activeData?.variance?.per_product?.filter(p => Math.abs(Number(p.delta_qty)||0) > 0.001) || [];
  let msg = 'Settle this audit — confirm the actions below cannot be reverted automatically:\n\n';
  msg += `• ${products.length} ledger adjustment txn(s) will be posted\n`;
  msg += `• ${t.missing_count||0} box(es) will be marked LOST\n`;
  msg += `• ${t.extra_count||0} box(es) will be moved IN-STOCK at this godown\n\n`;
  msg += 'Proceed?';
  if(!confirm(msg)) return;
  const note = prompt('Settlement note (optional, recorded in audit log):') || '';
  try {
    const j = await api(`/api/pm_stock/audit/${_activeSid}/settle`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({note: note.trim()})
    });
    toast(`✓ Settled · ${j.product_adjustments} adj · ${j.missing_boxes_lost} lost · ${j.extra_boxes_moved} moved`, 'ok');
    await reloadSessionModal();
    refreshCounts();
  } catch(e){ toast(e.message, 'err'); }
};

window.audReverse = async function(){
  // Admin-only: undo a settled session. Restores box states, deletes
  // ledger txns, sets status back to pending_settlement. Scans stay
  // intact so admin can re-settle if desired.
  let msg = '⚠ REVERSE this settled audit?\n\n';
  msg += 'This will:\n';
  msg += '• Delete the ledger adjustment txns posted by this audit\n';
  msg += '• Restore each touched box to its pre-settlement status and godown\n';
  msg += '• Move the session back to "pending_settlement" so it can be re-settled\n';
  msg += '• Keep all scans intact for review\n\n';
  msg += 'This action is itself audit-logged. Continue?';
  if(!confirm(msg)) return;
  const note = prompt('Reversal reason (optional, recorded in audit log):') || '';
  try {
    const j = await api(`/api/pm_stock/audit/session/${_activeSid}/reverse`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({note: note.trim()})
    });
    toast(`⏪ Reversed · ${j.boxes_restored} box(es) restored · ${j.ledger_rows_deleted} ledger row(s) deleted`, 'ok', 4500);
    await reloadSessionModal();
    refreshCounts();
  } catch(e){ toast(e.message, 'err'); }
};

// ────────────────────────────────────────────────────────────────
// HTML escaping
// ────────────────────────────────────────────────────────────────
function escHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(s){ return escHtml(s).replace(/\\/g, '\\\\'); }

// ────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initGodowns();
  renderPicked();
  refreshCounts();
  // Esc closes modal
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && $('session-modal').classList.contains('open')){
      audCloseModal();
    }
  });
});
})();
