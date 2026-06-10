/* pm_stock_admin.js — User → Home Godown admin modal */

// ── openUserHomeModal (originally L149..L169) ─────────────────────────
async function openUserHomeModal(){
  const modal = document.getElementById('userHomeModal');
  if(!modal) return;
  modal.classList.add('open');
  // Populate the godown dropdown with all locations
  const sel = document.getElementById('uhg-godown-id');
  if(sel){
    sel.innerHTML = '<option value="">— Select —</option>' +
      (window._godowns || []).map(g => {
        const isFloor = (g.godown_type === 'floor' || g.is_floor);
        const label   = isFloor ? `🏭 ${g.name}` : `📦 ${g.name}`;
        return `<option value="${g.id}">${label}</option>`;
      }).join('');
  }
  // Clear any previous form values
  const userInp = document.getElementById('uhg-user-name');
  if(userInp) userInp.value = '';
  if(sel) sel.value = '';
  await uhgLoadList();
}


// ── uhgLoadList (originally L170..L216) ─────────────────────────
async function uhgLoadList(){
  const list = document.getElementById('uhg-list');
  if(!list) return;
  list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px"><span class="spinner"></span> Loading…</div>`;
  try {
    const res = await fetch('/api/pm_stock/user_home/list');
    const d = await res.json();
    if(d.status !== 'ok'){
      list.innerHTML = `<div style="padding:24px;color:var(--red)">${d.message||'Failed'}</div>`;
      return;
    }
    if(!d.mappings || !d.mappings.length){
      list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hmuted,#9ca3af);font-size:12px">
        No user locks set yet. Add one above to lock a user's voucher location.
      </div>`;
      return;
    }
    list.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:rgba(245,158,11,.08);border-bottom:1.5px solid rgba(245,158,11,.25)">
          <th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.4px">User</th>
          <th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.4px">Locked Godown</th>
          <th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.4px">Updated By</th>
          <th style="text-align:right;padding:8px 10px;width:80px"></th>
        </tr></thead>
        <tbody>
          ${d.mappings.map(m => `<tr style="border-bottom:1px solid var(--hbdr,rgba(0,0,0,.06))">
            <td style="padding:8px 10px;font-weight:700;color:var(--htxtb,#111)">${_esc(m.user_name)}</td>
            <td style="padding:8px 10px"><span style="background:rgba(245,158,11,.1);color:#92400e;padding:2px 8px;border-radius:4px;font-weight:700">${_esc(m.godown_name||'#'+m.godown_id)}</span></td>
            <td style="padding:8px 10px;font-size:10px;color:var(--hmuted2,#6b7280)">
              ${_esc(m.updated_by||'—')}
              <br><span style="color:var(--hmuted,#9ca3af)">${fmtDateTime(m.updated_at)}</span>
            </td>
            <td style="padding:8px 10px;text-align:right;white-space:nowrap">
              <button onclick="uhgEdit('${_esc(m.user_name)}',${m.godown_id})" title="Edit"
                style="background:rgba(13,148,136,.08);border:1px solid rgba(13,148,136,.25);color:var(--teal,#0d9488);border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;cursor:pointer;margin-right:3px">✏</button>
              <button onclick="uhgDelete('${_esc(m.user_name)}')" title="Remove lock"
                style="background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);color:#dc2626;border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;cursor:pointer">🗑</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e){
    list.innerHTML = `<div style="padding:24px;color:var(--red)">Error: ${e.message}</div>`;
  }
}


// ── _esc (originally L217..L218) ─────────────────────────
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }


// ── uhgEdit (originally L219..L225) ─────────────────────────
function uhgEdit(userName, godownId){
  document.getElementById('uhg-user-name').value = userName;
  document.getElementById('uhg-godown-id').value = String(godownId);
  // Scroll to the form
  document.getElementById('uhg-user-name').focus();
}


// ── uhgAddOrUpdate (originally L226..L247) ─────────────────────────
async function uhgAddOrUpdate(){
  const userName = (document.getElementById('uhg-user-name').value || '').trim();
  const godownId = parseInt(document.getElementById('uhg-godown-id').value) || 0;
  if(!userName){ showToast('Enter a user name','error'); return; }
  if(!godownId){ showToast('Pick a godown','error'); return; }
  try {
    const res = await fetch('/api/pm_stock/user_home/set',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({user_name: userName, godown_id: godownId})
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`✓ ${userName} locked to ${d.godown_name}`,'success');
      document.getElementById('uhg-user-name').value = '';
      document.getElementById('uhg-godown-id').value = '';
      await uhgLoadList();
    } else {
      showToast(d.message || 'Save failed','error');
    }
  } catch(e){ showToast('Error: '+e.message,'error'); }
}


// ── uhgDelete (originally L248..L264) ─────────────────────────
async function uhgDelete(userName){
  if(!confirm(`Remove location lock for "${userName}"?\n\nThey will be able to pick any location on voucher forms after this.`)) return;
  try {
    const res = await fetch('/api/pm_stock/user_home/delete',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({user_name: userName})
    });
    const d = await res.json();
    if(d.status === 'ok'){
      showToast(`✓ Lock removed for ${userName}`,'success');
      await uhgLoadList();
    } else {
      showToast(d.message || 'Delete failed','error');
    }
  } catch(e){ showToast('Error: '+e.message,'error'); }
}



/* ═══════════════════════════════════════════════════════════
   AUDIT REPORT — admin-only modal
   ─────────────────────────────────────────────────────────────
   Opens from the sidebar (ADMIN section).
   Backend endpoints:
     GET  /api/pm_stock/audit/summary?from=&to=
     GET  /api/pm_stock/audit/feed?from=&to=&user=&action=&page=&size=
     POST /api/pm_stock/audit/<id>/reverse
═══════════════════════════════════════════════════════════ */

let _arPage = 1;
const _arSize = 50;
// Cache the latest summary + feed rows so the WhatsApp builder can reuse
// them without refetching. Refreshed on every auditRefresh / page change.
let _arLatestSummary = null;
let _arLatestRows    = [];
let _arLatestRange   = { from: '', to: '' };

function openAuditReportModal(){
  const modal = document.getElementById('auditReportModal');
  if(!modal){ showToast('Audit Report is admin-only','error'); return; }
  // Default range: last 30 days
  if(!document.getElementById('audit-from').value){
    auditResetRange();
  }
  modal.classList.add('open');
  _arPage = 1;
  auditRefresh();
}

function auditResetRange(){
  const today = new Date();
  const from = new Date(today.getTime() - 30*24*60*60*1000);
  const fmt = d => d.toISOString().slice(0,10);
  const f = document.getElementById('audit-from'); if(f) f.value = fmt(from);
  const t = document.getElementById('audit-to');   if(t) t.value = fmt(today);
  document.getElementById('audit-user').value = '';
  document.getElementById('audit-action').value = '';
  _arPage = 1;
  auditRefresh();
}

function _arParams(){
  const p = new URLSearchParams();
  const f = document.getElementById('audit-from')?.value;
  const t = document.getElementById('audit-to')?.value;
  const u = document.getElementById('audit-user')?.value.trim();
  const a = document.getElementById('audit-action')?.value;
  if(f) p.set('from', f);
  if(t) p.set('to',   t);
  if(u) p.set('user', u);
  if(a) p.set('action', a);
  return p;
}

async function auditRefresh(){
  const lbl = document.getElementById('audit-rng-label');
  const f = document.getElementById('audit-from')?.value || '';
  const t = document.getElementById('audit-to')?.value   || '';
  if(lbl) lbl.textContent = f && t ? `${f} → ${t}` : '';
  _arLatestRange = { from: f, to: t };

  // Summary
  try {
    const r = await fetch('/api/pm_stock/audit/summary?' + _arParams().toString());
    const d = await r.json();
    if(d.status === 'ok'){
      _arLatestSummary = d;
      const fmtN = n => (parseInt(n)||0).toLocaleString('en-IN');
      document.getElementById('ar-products').textContent = fmtN(d.products_created);
      document.getElementById('ar-labels').textContent   = fmtN(d.labels_total);
      document.getElementById('ar-grn').textContent      = fmtN(d.grn_count);
      document.getElementById('ar-mtv-out').textContent  = fmtN(d.material_out_count);
      document.getElementById('ar-mtv-in').textContent   = fmtN(d.material_in_count);
      document.getElementById('ar-op').textContent       = fmtN(d.op_batches_created);
      document.getElementById('ar-edits').textContent    = fmtN(d.edits_total);

      // Compact subtitle on the Labels card — first kind only, plus rest count
      const kinds = Object.entries(d.labels_by_kind || {});
      const sub = document.getElementById('ar-labels-sub');
      if(sub){
        if(!kinds.length){ sub.textContent = ''; sub.title = ''; }
        else {
          const [k0, v0] = kinds[0];
          const restCount = kinds.length - 1;
          sub.textContent = restCount > 0
            ? `${k0}: ${v0.labels} · +${restCount} more`
            : `${k0}: ${v0.labels}`;
          sub.title = kinds.map(([k,v]) => `${k}: ${v.labels}`).join('\n');
        }
      }

      // Top editors → render into the popover (hidden until clicked)
      _arRenderTopEditors(d.top_editors || []);
    }
  } catch(e){ showToast('Audit summary failed: '+e.message,'error'); }

  await auditLoadFeed();
}

function _arRenderTopEditors(list){
  const el = document.getElementById('ar-top-editors-list');
  if(!el) return;
  if(!list.length){
    el.innerHTML = '<div style="color:var(--text3,#94a3b8);padding:8px 0;font-size:12px">No activity in range.</div>';
    return;
  }
  el.innerHTML = list.map((e,i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(15,23,42,.04)">
      <div style="flex:0 0 22px;font-size:11px;color:var(--text3,#94a3b8);font-weight:700">#${i+1}</div>
      <div style="flex:1;font-weight:600;color:var(--text,#0f172a);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.user)}</div>
      <div style="flex:0 0 50px;text-align:right;font-weight:700;font-family:monospace;font-size:12px">${e.count}</div>
    </div>`).join('');
}

function auditToggleTopEditors(ev){
  if(ev) ev.stopPropagation();
  const pop = document.getElementById('ar-top-editors-popover');
  if(!pop) return;
  pop.style.display = (pop.style.display === 'block') ? 'none' : 'block';
}

// Close the top-editors popover on outside click
document.addEventListener('click', (e) => {
  const pop = document.getElementById('ar-top-editors-popover');
  const btn = document.getElementById('ar-top-editors-btn');
  if(!pop || pop.style.display !== 'block') return;
  if(pop.contains(e.target) || (btn && btn.contains(e.target))) return;
  pop.style.display = 'none';
});

async function auditLoadFeed(){
  const params = _arParams();
  params.set('page', _arPage);
  params.set('size', _arSize);
  try {
    const r = await fetch('/api/pm_stock/audit/feed?' + params.toString());
    const d = await r.json();
    if(d.status !== 'ok'){
      document.getElementById('ar-feed-tbody').innerHTML =
        `<tr><td colspan="6" style="padding:30px;text-align:center;color:#dc2626">Error: ${escHtml(d.message||'')}</td></tr>`;
      _arLatestRows = [];
      return;
    }
    _arLatestRows = d.rows || [];
    const tb = document.getElementById('ar-feed-tbody');
    if(!d.rows || !d.rows.length){
      tb.innerHTML = `<tr><td colspan="6" style="padding:30px;text-align:center;color:var(--text3,#94a3b8)">No audit entries match the filters.</td></tr>`;
    } else {
      tb.innerHTML = d.rows.map(r => {
        const ts = (r.ts || '').replace('T',' ').slice(0,19);
        const cls = r.reversal_class || 'final';
        const reversed = !!r.reversed_at;
        let revBtn;
        if(reversed){
          revBtn = `<span style="font-size:10px;color:var(--text3,#94a3b8)">↩ reversed by ${escHtml(r.reversed_by||'?')}</span>`;
        } else if(cls === 'safe'){
          revBtn = `<button onclick="auditDoReverse(${r.id})" class="btn btn-sm"
            style="background:rgba(37,99,235,.1);color:var(--blue,#2563eb);
            border:1px solid rgba(37,99,235,.25);padding:3px 10px;font-size:10.5px;font-weight:700">↩ Reverse</button>`;
        } else if(cls === 'gated'){
          revBtn = `<button onclick="auditDoReverse(${r.id})" class="btn btn-sm" title="Stock-affecting — confirmation needed (coming soon)"
            style="background:rgba(245,158,11,.1);color:#b45309;
            border:1px solid rgba(245,158,11,.3);padding:3px 10px;font-size:10.5px;font-weight:700">⚠ Gated</button>`;
        } else {
          revBtn = `<span style="font-size:10px;color:var(--text3,#94a3b8)" title="Final action — cannot reverse">— final —</span>`;
        }
        const userPill = `<span style="background:var(--bg,#f1f5f9);font-family:monospace;
          font-size:10.5px;padding:1px 7px;border-radius:4px">${escHtml(r.user_name||'?')}</span>`;
        const actionPill = `<span style="font-family:monospace;font-size:10.5px;
          background:rgba(37,99,235,.08);color:var(--blue,#2563eb);
          padding:1px 7px;border-radius:4px;font-weight:700">${escHtml(r.action)}</span>`;
        return `
          <tr style="${reversed ? 'opacity:0.5' : ''}">
            <td style="padding:7px 10px;font-family:monospace;font-size:10.5px;
              border-bottom:1px solid rgba(15,23,42,.04);white-space:nowrap">${ts}</td>
            <td style="padding:7px 10px;border-bottom:1px solid rgba(15,23,42,.04);white-space:nowrap">${userPill}</td>
            <td style="padding:7px 10px;border-bottom:1px solid rgba(15,23,42,.04);white-space:nowrap">${actionPill}</td>
            <td style="padding:7px 10px;border-bottom:1px solid rgba(15,23,42,.04)">${escHtml(r.summary||'')}</td>
            <td style="padding:7px 10px;font-family:monospace;font-size:10px;
              color:var(--text3,#94a3b8);border-bottom:1px solid rgba(15,23,42,.04);white-space:nowrap">${escHtml(r.route_path||'')}</td>
            <td style="padding:7px 10px;text-align:right;border-bottom:1px solid rgba(15,23,42,.04);white-space:nowrap">${revBtn}</td>
          </tr>`;
      }).join('');
    }
    document.getElementById('ar-feed-meta').textContent = `${d.total} total · page ${d.page}/${d.pages}`;

    const pag = document.getElementById('ar-feed-pagination');
    pag.innerHTML = `
      <button class="btn btn-sm" ${d.page<=1?'disabled':''} onclick="_arGoto(${d.page-1})"
        style="padding:4px 10px;font-size:11px">← Prev</button>
      <span style="font-family:monospace">page ${d.page} / ${d.pages}</span>
      <button class="btn btn-sm" ${d.page>=d.pages?'disabled':''} onclick="_arGoto(${d.page+1})"
        style="padding:4px 10px;font-size:11px">Next →</button>
      <span style="margin-left:auto;color:var(--text3,#94a3b8)">${d.rows.length} of ${d.total}</span>
    `;
  } catch(e){
    showToast('Audit feed failed: '+e.message,'error');
  }
}

function _arGoto(p){
  if(!p || p < 1) return;
  _arPage = p;
  auditLoadFeed();
}

async function auditDoReverse(audit_id){
  if(!confirm('Reverse this audit entry?\n\nThis will undo the change and stamp it on the audit log. The reversal itself is logged.')) return;
  try {
    const r = await fetch(`/api/pm_stock/audit/${audit_id}/reverse`, { method:'POST' });
    const d = await r.json();
    if(d.status === 'ok'){
      showToast('Reversed','success');
      auditRefresh();
    } else if(d.code === 'reversal_not_yet_implemented'){
      alert('Stock-affecting reversals will be enabled in a follow-up update. The action is logged for now.');
    } else {
      showToast(d.message || 'Reverse failed','error');
    }
  } catch(e){
    showToast('Reverse error: '+e.message,'error');
  }
}

/* ───────────────────────────────────────────────────────────
   WhatsApp share — opens web.whatsapp.com with KPI summary
   plus the recent activity rows currently visible on screen.
   No phone number — user picks contact in WhatsApp.
─────────────────────────────────────────────────────────── */

function _arFmtN(n){ return (parseInt(n)||0).toLocaleString('en-IN'); }

function _arFmtDate(s){
  if(!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function _arFmtRowTs(s){
  // "2026-05-05T17:01:55" → "05/05 17:01"
  if(!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if(!m) return s;
  return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
}

function auditSendWhatsapp(){
  const s = _arLatestSummary;
  if(!s){
    showToast('Apply a date range first so the summary is loaded.','error');
    return;
  }

  // Header
  const lines = [];
  lines.push('📊 *PM Stock — Audit Report*');
  lines.push(`🗓 ${_arFmtDate(_arLatestRange.from || s.from)} → ${_arFmtDate(_arLatestRange.to || s.to)}`);
  lines.push('');

  // KPI summary
  lines.push('*Summary*');
  lines.push(`• Products created: ${_arFmtN(s.products_created)}`);
  lines.push(`• Labels printed:   ${_arFmtN(s.labels_total)}`);
  lines.push(`• GRN created:      ${_arFmtN(s.grn_count)}`);
  lines.push(`• Material OUT:     ${_arFmtN(s.material_out_count)}`);
  lines.push(`• Material IN:      ${_arFmtN(s.material_in_count)}`);
  lines.push(`• OP batches:       ${_arFmtN(s.op_batches_created)}`);
  lines.push(`• Edits total:      ${_arFmtN(s.edits_total)}`);
  lines.push('');

  // Recent activity rows currently visible
  const rows = _arLatestRows || [];
  if(rows.length){
    lines.push(`*Recent activity* (${rows.length} on screen)`);
    // WhatsApp message length is generous but URLs above ~6000 chars start
    // failing in some browsers. Cap at 40 rows to stay comfortably under that.
    const MAX = 40;
    const shown = rows.slice(0, MAX);
    shown.forEach(r => {
      const t = _arFmtRowTs(r.ts);
      const u = (r.user_name || '?').slice(0, 16);
      const a = r.action || '';
      const sm = (r.summary || '').slice(0, 90);
      const tag = r.reversed_at ? ' ↩' : '';
      lines.push(`${t} · ${u} · ${a}${tag}`);
      if(sm) lines.push(`   ${sm}`);
    });
    if(rows.length > MAX){
      lines.push('');
      lines.push(`…and ${rows.length - MAX} more rows (open the Audit Report to see all)`);
    }
  } else {
    lines.push('_No activity in this range._');
  }

  lines.push('');
  lines.push('— HCP Wellness PM Stock');

  const text = lines.join('\n');

  // Open WhatsApp Web — user picks the contact in WhatsApp itself.
  const url = 'https://web.whatsapp.com/send?text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'noopener');
}


/* ───────────────────────────────────────────────────────────
   FIFO Settings — admin-only modal
   Toggles enforcement and sets a "start date" for FIFO.
─────────────────────────────────────────────────────────── */

let _fifoSettingsLoaded = null;  // last GET response, used to compute diff on save

async function openFifoSettingsModal(){
  const modal = document.getElementById('fifoSettingsModal');
  if(!modal){ showToast('FIFO Settings is admin-only','error'); return; }
  modal.classList.add('open');
  await fifoSettingsRefresh();
}

async function fifoSettingsRefresh(){
  try {
    const r = await fetch('/api/pm_stock/settings/fifo');
    const d = await r.json();
    if(d.status !== 'ok'){
      showToast(d.message || 'Load failed','error');
      return;
    }
    _fifoSettingsLoaded = d;
    document.getElementById('fifo-enabled-toggle').checked = !!d.enabled;
    _fifoSettingsBadge(d.enabled);
    document.getElementById('fifo-start-date').value = d.start_date || '';
    document.getElementById('fifo-settings-meta').textContent =
      d.updated_by
        ? `Last changed by ${d.updated_by} at ${(d.updated_at||'').slice(0,19)}`
        : 'Default settings (never changed).';
  } catch(e){ showToast('Error: '+e.message,'error'); }
}

function _fifoSettingsBadge(enabled){
  const el = document.getElementById('fifo-enabled-badge');
  if(!el) return;
  if(enabled){
    el.textContent = 'ENABLED';
    el.style.background = 'rgba(16,185,129,.12)';
    el.style.color      = '#047857';
  } else {
    el.textContent = 'DISABLED';
    el.style.background = 'rgba(239,68,68,.12)';
    el.style.color      = '#b91c1c';
  }
}

// Live badge update on toggle (visual only — actual save still required)
document.addEventListener('change', (e) => {
  if(e.target && e.target.id === 'fifo-enabled-toggle'){
    _fifoSettingsBadge(e.target.checked);
  }
});

function fifoSettingsClearStartDate(){
  document.getElementById('fifo-start-date').value = '';
}

function fifoSettingsResetFromNow(){
  if(!confirm('Reset FIFO start date to TODAY?\n\nAll current stock will be treated as "outside FIFO scope" — they can be scanned out without FIFO enforcement.\nNew stock from today onwards will be enforced normally.\n\nExisting FIFO labels stay valid (no reprint needed).')) return;
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('fifo-start-date').value = today;
}

async function fifoSettingsSave(){
  const enabled    = document.getElementById('fifo-enabled-toggle').checked;
  const startDate  = document.getElementById('fifo-start-date').value || null;
  const wasReset   = (_fifoSettingsLoaded && _fifoSettingsLoaded.start_date !== startDate);

  const btn = document.getElementById('fifo-settings-save-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const r = await fetch('/api/pm_stock/settings/fifo', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ enabled, start_date: startDate })
    });
    const d = await r.json();
    if(d.status === 'ok'){
      let msg = `FIFO ${d.enabled ? 'enabled' : 'disabled'}`;
      if(d.start_date) msg += ` · cutoff ${d.start_date}`;
      showToast('✓ '+msg, 'success', 4000);
      await fifoSettingsRefresh();
    } else {
      showToast(d.message || 'Save failed','error', 4500);
    }
  } catch(e){
    showToast('Error: '+e.message,'error');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = '💾 Save Changes'; }
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   TRANSFER ADMIN-EDIT — full edit power for any transfer voucher
   ─────────────────────────────────────────────────────────────────────────
   Backend: POST /api/pm_stock/transfers/<tid>/admin_edit
   Modal:   #transferAdminEditModal (admin-only, jinja-gated)
   Trigger: openTransferAdminEdit(tid) — wired into the voucher log
═══════════════════════════════════════════════════════════════════════════ */

let _taeBefore   = null;   // snapshot of state when modal opened — used for diff
let _taeTransferId = null;
let _taeGodowns  = [];     // godown list for the selects
let _taeProducts = [];     // product list, mirrors _products

async function openTransferAdminEdit(tid){
  const modal = document.getElementById('transferAdminEditModal');
  if(!modal){ showToast('Admin edit unavailable','error'); return; }
  _taeTransferId = tid;
  _taeBefore     = null;
  modal.classList.add('open');

  // Reset modal
  document.getElementById('tae-reason').value = '';
  document.getElementById('tae-out-items').innerHTML = '';
  document.getElementById('tae-in-items').innerHTML = '';
  document.getElementById('taeDiffPanel').style.display = 'none';
  document.getElementById('taeDiffBody').innerHTML = '';

  try {
    // Load fresh state from backend
    const r = await fetch(`/api/pm_stock/transfers/voucher/${tid}`);
    const d = await r.json();
    if(d.status !== 'ok'){
      showToast(d.message || 'Load failed','error');
      closeTransferAdminEdit();
      return;
    }
    _taeBefore = d;
    await _taePopulate(d);
  } catch(e){
    showToast('Error: '+e.message,'error');
    closeTransferAdminEdit();
  }
}

function closeTransferAdminEdit(){
  const modal = document.getElementById('transferAdminEditModal');
  if(modal) modal.classList.remove('open');
  _taeBefore = null;
  _taeTransferId = null;
}

async function _taePopulate(d){
  // d.header = { transfer_no, status, out_at, from_godown_id, to_godown_id, remarks, ... }
  // The schema column for the transfer's date is `out_at` (DATETIME).
  // We slice :10 to get the YYYY-MM-DD portion for the date input.
  const h = d.header || {};
  document.getElementById('taeModalVno').textContent    = h.transfer_no || '';
  const statusEl = document.getElementById('taeModalStatus');
  statusEl.textContent = (h.status || '').toUpperCase();
  statusEl.style.background = {
    'out_started': 'rgba(245,158,11,.12)', 'in_pending': 'rgba(59,130,246,.12)',
    'received': 'rgba(16,185,129,.12)', 'cancelled': 'rgba(107,114,128,.12)'
  }[h.status] || 'rgba(107,114,128,.12)';
  statusEl.style.color = {
    'out_started': '#92400e', 'in_pending': '#1e40af',
    'received': '#047857', 'cancelled': '#374151'
  }[h.status] || '#374151';

  // Risk banner — varies by status
  const banner = document.getElementById('taeRiskBanner');
  const outScn = (d.out_items || []).reduce((a,r)=>a+(parseInt(r.no_of_box)||0),0);
  const inScn  = (d.in_items  || []).reduce((a,r)=>a+(parseInt(r.no_of_box)||0),0);
  let bannerHtml = '';
  if(h.status === 'received'){
    bannerHtml = `<strong>⚠ This transfer is fully RECEIVED.</strong> Editing item totals will create a discrepancy with the ${outScn} OUT and ${inScn} IN scanned boxes (orphans). Header changes (date, godowns) will refund/re-post stock automatically. <strong>Use with extreme care.</strong>`;
  } else if(h.status === 'in_pending'){
    bannerHtml = `<strong>⚠ This transfer is in TRANSIT.</strong> ${outScn} OUT boxes have been scanned. Editing OUT item totals creates a discrepancy with scanned boxes. Source stock will be refunded and re-posted to match new totals.`;
  } else if(h.status === 'cancelled'){
    bannerHtml = `<strong>This transfer is CANCELLED.</strong> Edits update the record only — no stock changes will occur (already reversed at cancellation).`;
  }
  if(bannerHtml){
    banner.innerHTML = bannerHtml;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  // Header fields
  document.getElementById('tae-date').value    = (h.out_at || '').slice(0,10);
  document.getElementById('tae-remarks').value = h.remarks || '';

  // Load godowns + products if not already.
  // Prefer the globally-loaded _godowns (loaded once at page init via
  // pm_stock_state.js' loadGodowns()) so we don't hit the network twice
  // and so we use the same shape the rest of the app uses.
  if(window._godowns && window._godowns.length){
    _taeGodowns = window._godowns;
  } else if(!_taeGodowns.length){
    try {
      const gr = await fetch('/api/pm_stock/godowns');
      const gd = await gr.json();
      // /api/pm_stock/godowns returns a plain array (jsonify(gdwns)),
      // not an object with a .godowns key. Handle both shapes defensively.
      _taeGodowns = Array.isArray(gd) ? gd : (gd.godowns || []);
    } catch(_){}
  }
  if(!_taeProducts.length){
    // Reuse the global _products if loaded
    _taeProducts = (window._products || []);
    if(!_taeProducts.length){
      try {
        const pr = await fetch('/api/pm_stock/products');
        const pd = await pr.json();
        // Same here — products endpoint returns a plain array.
        _taeProducts = Array.isArray(pd) ? pd : (pd.products || []);
      } catch(_){}
    }
  }
  console.log('[admin-edit] _taeGodowns has', _taeGodowns.length, 'entries; _taeProducts has', _taeProducts.length);

  // Populate godown selects. Each godown has .id and .name (and optionally
  // .godown_type / .is_floor — for floor locations we suffix " · Factory"
  // to make them visually distinct).
  const fromSel = document.getElementById('tae-from');
  const toSel   = document.getElementById('tae-to');
  fromSel.innerHTML = '';
  toSel.innerHTML   = '';
  _taeGodowns.forEach(g => {
    const isFloor = (g.godown_type === 'floor') || g.is_floor;
    const label = (g.name || `Godown #${g.id}`) + (isFloor ? ' · Factory' : '');
    fromSel.add(new Option(label, String(g.id)));
    toSel.add(new Option(label, String(g.id)));
  });
  // Set selected values — coerce to string because <option value> stores
  // strings and the header IDs come back as ints.
  if(h.from_godown_id != null) fromSel.value = String(h.from_godown_id);
  if(h.to_godown_id   != null) toSel.value   = String(h.to_godown_id);

  // Populate items
  const outBox = document.getElementById('tae-out-items');
  const inBox  = document.getElementById('tae-in-items');
  outBox.innerHTML = '';
  inBox.innerHTML  = '';
  (d.out_items || []).forEach(r => taeAddItem('out', r));
  (d.in_items  || []).forEach(r => taeAddItem('in',  r));
  _taeUpdateCounts();
}

function taeAddItem(side, item){
  const container = document.getElementById(`tae-${side}-items`);
  const div = document.createElement('div');
  div.className = 'tae-row';
  div.dataset.side = side;
  // More breathing room: 10px vertical padding (was 6), 14px horizontal (was 10),
  // 10px column gap (was 6). Each column also has padding inside its inputs.
  div.style.cssText = 'display:grid;grid-template-columns:2.4fr 90px 100px 110px 28px;gap:10px;padding:10px 14px;border-top:1px solid var(--border,rgba(0,0,0,.06));align-items:center';

  // Pre-compute the visible label for the selected product (if any). The
  // product picker uses a type-and-search combo (same _initProdCombo helper
  // as the GRN/MTV modals) so users can search by name, PM type, or code,
  // and use ↑/↓/Enter to navigate the filtered results.
  let prefillText = '';
  let prefillId   = '';
  if(item && item.product_id){
    const p = (_taeProducts || []).find(x => String(x.id) === String(item.product_id));
    if(p){
      prefillText = `[${p.pm_type||''}] ${p.product_name||''}`;
      prefillId   = String(p.id);
    } else {
      // Fall back to the raw product_name from the API response
      prefillText = `[${item.pm_type||''}] ${item.product_name||''}`;
      prefillId   = String(item.product_id);
    }
  }

  div.innerHTML = `
    <div class="prod-combo-wrap" style="position:relative;min-width:0">
      <input type="hidden" class="gi-product tae-prod" value="${prefillId}">
      <input type="text" class="prod-combo-input" placeholder="Type to search product…"
        autocomplete="off" value="${prefillText.replace(/"/g,'&quot;')}"
        style="width:100%;background:#fff;border:1.5px solid var(--border2,rgba(0,0,0,.13));
        border-radius:6px;padding:7px 10px;font-size:12px;outline:none;
        text-overflow:ellipsis;overflow:hidden">
      <div class="prod-combo-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;
        background:#fff;border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;
        border-radius:0 0 7px 7px;max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
    </div>
    <input type="number" class="tae-nob" min="0" step="1" value="${item ? (item.no_of_box||0) : 0}"
      style="width:100%;text-align:right;font-size:12px;padding:7px 8px;
      border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;outline:none">
    <input type="number" class="tae-pbq" min="0" step="0.01" value="${item ? (item.per_box_qty||0) : 0}"
      style="width:100%;text-align:right;font-size:12px;padding:7px 8px;
      border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:6px;outline:none">
    <input type="number" class="tae-tot" min="0" step="0.01" value="${item ? (item.total_qty||0) : 0}"
      style="width:100%;text-align:right;font-size:13px;padding:7px 8px;font-weight:700;
      background:rgba(13,148,136,.08);border:1.5px solid rgba(13,148,136,.3);
      border-radius:6px;outline:none;color:var(--teal,#0d9488)">
    <button onclick="this.closest('.tae-row').remove(); _taeUpdateCounts()"
      style="width:26px;height:26px;border-radius:5px;background:rgba(239,68,68,.1);
      border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;
      font-size:13px;display:flex;align-items:center;justify-content:center"
      title="Remove this line">✕</button>`;
  container.appendChild(div);

  // Wire up the type-and-search combo. _initProdCombo expects:
  //   • .prod-combo-wrap  — the container we just built
  //   • '.tae-tot'        — the next field to focus after picking a product
  // It reads from the global _products list (loaded at page init) so the
  // combo always shows the latest active products even if _taeProducts
  // got stale.
  if(typeof _initProdCombo === 'function'){
    _initProdCombo(div.querySelector('.prod-combo-wrap'), '.tae-tot');
  }

  // Auto-recompute total when no_of_box * per_box_qty change
  const nob = div.querySelector('.tae-nob');
  const pbq = div.querySelector('.tae-pbq');
  const tot = div.querySelector('.tae-tot');
  const recompute = () => {
    const v = (parseFloat(nob.value)||0) * (parseFloat(pbq.value)||0);
    if(v > 0) tot.value = v.toFixed(2).replace(/\.?0+$/,'');
  };
  nob.addEventListener('input', recompute);
  pbq.addEventListener('input', recompute);

  _taeUpdateCounts();
}

function _taeUpdateCounts(){
  const out = document.querySelectorAll('#tae-out-items .tae-row').length;
  const inn = document.querySelectorAll('#tae-in-items .tae-row').length;
  document.getElementById('tae-out-count').textContent = `· ${out} line${out===1?'':'s'}`;
  document.getElementById('tae-in-count').textContent  = `· ${inn} line${inn===1?'':'s'}`;
}

function _taeCollectItems(side){
  const rows = document.querySelectorAll(`#tae-${side}-items .tae-row`);
  const items = [];
  rows.forEach(row => {
    const pid = parseInt(row.querySelector('.tae-prod').value);
    if(!pid) return;
    items.push({
      product_id:  pid,
      no_of_box:   parseInt(row.querySelector('.tae-nob').value) || 0,
      per_box_qty: parseFloat(row.querySelector('.tae-pbq').value) || 0,
      total_qty:   parseFloat(row.querySelector('.tae-tot').value) || 0,
    });
  });
  return items;
}

function _taeProductLabel(pid){
  const p = (_taeProducts || []).find(x => String(x.id) === String(pid));
  return p ? `[${p.pm_type||'?'}] ${p.product_name||''}` : `(product #${pid})`;
}

function _taeGodownLabel(gid){
  const g = (_taeGodowns || []).find(x => String(x.id) === String(gid));
  return g ? g.name : `(godown #${gid})`;
}

function taeRefreshDiff(){
  if(!_taeBefore){ return; }
  const h = _taeBefore.header || {};
  const beforeOut = _taeBefore.out_items || [];
  const beforeIn  = _taeBefore.in_items  || [];

  const newDate    = document.getElementById('tae-date').value;
  const newFrom    = parseInt(document.getElementById('tae-from').value);
  const newTo      = parseInt(document.getElementById('tae-to').value);
  const newRemarks = document.getElementById('tae-remarks').value;
  const newOut     = _taeCollectItems('out');
  const newIn      = _taeCollectItems('in');

  const diffs = [];
  const oldDate = (h.out_at || '').slice(0,10);
  if(oldDate !== newDate)
    diffs.push(`<span style="color:#475569">date</span> ${oldDate || '(none)'} → <strong>${newDate}</strong>`);
  if(parseInt(h.from_godown_id) !== newFrom)
    diffs.push(`<span style="color:#475569">from</span> ${_taeGodownLabel(h.from_godown_id)} → <strong>${_taeGodownLabel(newFrom)}</strong>`);
  if(parseInt(h.to_godown_id) !== newTo)
    diffs.push(`<span style="color:#475569">to</span> ${_taeGodownLabel(h.to_godown_id)} → <strong>${_taeGodownLabel(newTo)}</strong>`);
  if((h.remarks || '') !== newRemarks)
    diffs.push(`<span style="color:#475569">remarks</span> changed`);

  // Items diff: simple count + per-product totals
  const sumByProduct = (arr) => {
    const m = {};
    arr.forEach(r => { m[r.product_id] = (m[r.product_id] || 0) + (parseFloat(r.total_qty)||0); });
    return m;
  };
  const compareItems = (oldArr, newArr, sideLabel) => {
    const oM = sumByProduct(oldArr); const nM = sumByProduct(newArr);
    const allPids = new Set([...Object.keys(oM), ...Object.keys(nM)]);
    allPids.forEach(pid => {
      const o = oM[pid] || 0; const n = nM[pid] || 0;
      if(Math.abs(o - n) > 0.001){
        diffs.push(`<span style="color:#475569">${sideLabel}</span> ${_taeProductLabel(pid)}: ${o.toFixed(2)} → <strong>${n.toFixed(2)}</strong>`);
      }
    });
  };
  compareItems(beforeOut, newOut, 'OUT');
  compareItems(beforeIn,  newIn,  'IN');

  const panel = document.getElementById('taeDiffPanel');
  const body  = document.getElementById('taeDiffBody');
  if(diffs.length === 0){
    body.innerHTML = '<em>No changes detected.</em>';
  } else {
    body.innerHTML = diffs.map(d => `• ${d}`).join('<br>');
  }
  panel.style.display = 'block';
}

async function taeSave(){
  const reason = (document.getElementById('tae-reason').value || '').trim();
  if(reason.length < 4){
    showToast('Reason is required (min 4 characters)','error', 4000);
    document.getElementById('tae-reason').focus();
    return;
  }

  const newDate    = document.getElementById('tae-date').value;
  const newFrom    = parseInt(document.getElementById('tae-from').value);
  const newTo      = parseInt(document.getElementById('tae-to').value);
  const newRemarks = document.getElementById('tae-remarks').value;
  const newOut     = _taeCollectItems('out');
  const newIn      = _taeCollectItems('in');

  if(!newDate){ showToast('Transfer date is required','error'); return; }
  if(!newFrom || !newTo){ showToast('Both source and destination are required','error'); return; }
  if(newFrom === newTo){ showToast('Source and destination cannot be the same','error'); return; }

  // Final confirm dialog with summary
  const h = _taeBefore?.header || {};
  let summary = `Apply admin edit to ${h.transfer_no || `#${_taeTransferId}`}?\n\n`;
  if((h.out_at || '').slice(0,10) !== newDate)
    summary += `• Date: ${(h.out_at||'').slice(0,10)} → ${newDate}\n`;
  if(parseInt(h.from_godown_id) !== newFrom)
    summary += `• From: ${_taeGodownLabel(h.from_godown_id)} → ${_taeGodownLabel(newFrom)}\n`;
  if(parseInt(h.to_godown_id) !== newTo)
    summary += `• To: ${_taeGodownLabel(h.to_godown_id)} → ${_taeGodownLabel(newTo)}\n`;
  summary += `• OUT items: ${newOut.length}, IN items: ${newIn.length}\n`;
  summary += `\nReason: "${reason}"\n\n`;
  summary += `Stock postings will be REVERSED and RE-POSTED.\n`;
  summary += `This is logged in the audit report. Proceed?`;
  if(!confirm(summary)) return;

  const btn = document.getElementById('taeSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const r = await fetch(`/api/pm_stock/transfers/${_taeTransferId}/admin_edit`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        transfer_date:  newDate,
        from_godown_id: newFrom,
        to_godown_id:   newTo,
        remarks:        newRemarks,
        out_items:      newOut,
        in_items:       newIn,
        reason:         reason,
      })
    });
    const d = await r.json();
    if(d.status === 'ok'){
      let msg = `✓ ${d.transfer_no} updated`;
      if(d.warnings && d.warnings.length){
        msg += ` (with ${d.warnings.length} warning${d.warnings.length>1?'s':''})`;
      }
      showToast(msg, 'success', 5000);
      if(d.warnings && d.warnings.length){
        // Show warnings in a follow-up alert so they're not missed
        setTimeout(() => alert('Discrepancy warnings:\n\n' + d.warnings.join('\n\n')), 200);
      }
      closeTransferAdminEdit();
      // Refresh whichever views might be open
      if(typeof loadVoucherLog === 'function')           loadVoucherLog();
      if(typeof mmLoadHistory === 'function')            mmLoadHistory();
      if(typeof mvRefreshInTransitCount === 'function')  mvRefreshInTransitCount();
      if(typeof loadSummary === 'function')              loadSummary();
    } else {
      showToast(d.message || 'Save failed','error', 5000);
    }
  } catch(e){
    showToast('Error: '+e.message,'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save (admin edit) →';
  }
}


/* ════════════════════════════════════════════════════════════════════════
   VOUCHER SYNC CHECK (admin)
   Wraps /api/pm_stock/transfers/sync_check (read-only audit) and
   /api/pm_stock/transfers/heal_line_items_bulk (consolidates duplicate
   pm_transfer_items rows). The audit must run before heal is enabled,
   so admins always see what they're about to change.
   See the same-named modal in pm_stock.html for the UI shell.
   ════════════════════════════════════════════════════════════════════════ */
function openVoucherSyncModal(){
  // Reset state every time the modal is opened so a stale audit from a
  // previous session can't unlock the heal button.
  const resEl = document.getElementById('vsync-result');
  const sumEl = document.getElementById('vsync-summary');
  const healBtn = document.getElementById('vsync-heal-btn');
  if(resEl)   resEl.innerHTML = '<div style="padding:30px;text-align:center;color:#9ca3af;font-size:11px">Click <strong>Run Audit</strong> to see vouchers with line-ledger drift.</div>';
  if(sumEl)   sumEl.textContent = '';
  if(healBtn){ healBtn.disabled = true; healBtn.style.opacity = .55; }
  const ov = document.getElementById('voucherSyncModal');
  if(ov) ov.classList.add('open');
}

async function runVsyncAudit(){
  const btn = document.getElementById('vsync-audit-btn');
  const res = document.getElementById('vsync-result');
  const sum = document.getElementById('vsync-summary');
  const healBtn = document.getElementById('vsync-heal-btn');
  if(!btn || !res) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⏳ Auditing…';
  res.innerHTML = '<div style="padding:30px;text-align:center;color:#6b7280">Scanning every active voucher…</div>';
  try {
    const r = await fetch('/api/pm_stock/transfers/sync_check');
    const d = await r.json();
    if(d.status !== 'ok'){
      res.innerHTML = `<div style="padding:14px;color:#dc2626;background:rgba(220,38,38,.08);border-radius:6px">Error: ${d.message||'audit failed'}</div>`;
      return;
    }
    const list = d.affected || [];
    sum.textContent = `${list.length} issue${list.length===1?'':'s'} found`;
    if(!list.length){
      res.innerHTML = `<div style="padding:30px;text-align:center;color:#16a34a;font-weight:700">✅ All vouchers in sync. No action needed.</div>`;
      if(healBtn){ healBtn.disabled = true; healBtn.style.opacity = .55; }
      return;
    }
    // Group issues by transfer for cleaner display
    const byVoucher = {};
    list.forEach(r => {
      const k = r.transfer_no || `<tid=${r.transfer_id}>`;
      if(!byVoucher[k]) byVoucher[k] = { transfer_id: r.transfer_id, transfer_no: k,
                                          status: r.status, has_disc: r.has_discrepancy,
                                          rows: [] };
      byVoucher[k].rows.push(r);
    });
    const vouchers = Object.values(byVoucher);
    // Count how many vouchers have any duplicate_rows issue (those are the
    // ones the heal button can actually fix; qty/box drift between the two
    // ledgers can't be auto-resolved).
    const healable = vouchers.filter(v =>
      v.rows.some(r => (r.issues||[]).some(i => i.startsWith('duplicate_rows')))
    ).length;
    res.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:700;color:#5b21b6">${vouchers.length} voucher(s) affected</span>
        <span style="font-size:11px;color:#6b7280">${healable} can be auto-healed</span>
        <span style="font-size:11px;color:#6b7280">${vouchers.length - healable} need human review</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="background:rgba(124,58,237,.08);text-align:left">
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#5b21b6">VOUCHER</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#5b21b6">SIDE / PRODUCT</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#5b21b6;text-align:right">LEDGER</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#5b21b6;text-align:right">SCANS</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#5b21b6">ISSUES</th>
          </tr>
        </thead>
        <tbody>
          ${vouchers.map(v => v.rows.map((r,i) => `
            <tr style="border-bottom:1px solid rgba(0,0,0,.05);background:${
              (r.issues||[]).some(x=>x.startsWith('duplicate_rows')) ? 'rgba(245,158,11,.04)' : 'rgba(220,38,38,.04)'
            }">
              ${i===0 ? `<td style="padding:8px;font-family:monospace;font-weight:700;color:#1e40af;vertical-align:top" rowspan="${v.rows.length}">${v.transfer_no}<br><span style="font-size:9px;font-weight:600;color:#6b7280">${v.status}${v.has_disc?' · ⚠ disc':''}</span></td>` : ''}
              <td style="padding:6px 8px"><span style="font-weight:700;color:${r.side==='out'?'#92400e':'#1e40af'}">${(r.side||'').toUpperCase()}</span> · ${r.product_name||''}</td>
              <td style="padding:6px 8px;text-align:right">${r.ledger_boxes||0} box / ${(r.ledger_qty||0).toLocaleString('en-IN')}</td>
              <td style="padding:6px 8px;text-align:right">${r.scanned_boxes==null?'—':r.scanned_boxes+' box / '+(r.scanned_qty||0).toLocaleString('en-IN')}</td>
              <td style="padding:6px 8px;font-size:10px;color:#92400e">${(r.issues||[]).map(x=>`<span style="background:rgba(245,158,11,.12);padding:1px 5px;border-radius:3px;margin-right:3px;display:inline-block">${x}</span>`).join('')}</td>
            </tr>
          `).join('')).join('')}
        </tbody>
      </table>
      ${healable > 0 ? `
      <div style="margin-top:12px;padding:10px 12px;background:rgba(220,38,38,.06);border:1px solid rgba(220,38,38,.2);border-radius:6px;font-size:11px;color:#7f1d1d">
        <strong>Note:</strong> Heal will merge duplicate ledger rows but will NOT touch real qty discrepancies.
        Vouchers with <code>qty_drift</code> or <code>box_count_drift</code> issues need physical recount or
        admin reconcile — heal won't fix those.
      </div>` : ''}
    `;
    if(healBtn){
      healBtn.disabled = (healable === 0);
      healBtn.style.opacity = (healable === 0) ? .55 : 1;
    }
  } catch(e){
    res.innerHTML = `<div style="padding:14px;color:#dc2626">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function runVsyncHealBulk(){
  if(!confirm('Consolidate duplicate pm_transfer_items rows across all affected vouchers?\n\n' +
              'This modifies the DB (merges rows by summing totals into MIN(item_id), deletes the rest).\n' +
              'It does NOT fix real qty discrepancies — those remain flagged.\n\n' +
              'Idempotent, but cannot be auto-reverted. Continue?')) return;
  const btn = document.getElementById('vsync-heal-btn');
  const res = document.getElementById('vsync-result');
  const sum = document.getElementById('vsync-summary');
  if(!btn || !res) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⏳ Healing…';
  try {
    const r = await fetch('/api/pm_stock/transfers/heal_line_items_bulk', {method:'POST'});
    const d = await r.json();
    if(d.status !== 'ok'){
      res.innerHTML = `<div style="padding:14px;color:#dc2626;background:rgba(220,38,38,.08);border-radius:6px">Error: ${d.message||'heal failed'}</div>`;
      return;
    }
    sum.textContent = `Healed ${d.vouchers_touched} voucher(s)`;
    res.innerHTML = `
      <div style="padding:14px;background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.2);border-radius:6px;margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;color:#15803d;margin-bottom:4px">✅ Heal complete</div>
        <div style="font-size:11px;color:#15803d">
          ${d.vouchers_touched} voucher(s) touched ·
          ${d.total_groups} group(s) consolidated ·
          ${d.total_rows_dropped} row(s) dropped
        </div>
      </div>
      ${(d.per_voucher||[]).length ? `
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="background:rgba(22,163,74,.08);text-align:left">
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#15803d">VOUCHER</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#15803d;text-align:right">GROUPS</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#15803d;text-align:right">ROWS DROPPED</th>
            <th style="padding:6px 8px;font-size:10px;letter-spacing:.4px;color:#15803d">DISCREPANCY AFTER</th>
          </tr>
        </thead>
        <tbody>
          ${d.per_voucher.map(v => `
            <tr style="border-bottom:1px solid rgba(0,0,0,.05)">
              <td style="padding:6px 8px;font-family:monospace;font-weight:700;color:#1e40af">${v.transfer_no}</td>
              <td style="padding:6px 8px;text-align:right">${v.groups_consolidated}</td>
              <td style="padding:6px 8px;text-align:right">${v.rows_dropped}</td>
              <td style="padding:6px 8px">${
                v.has_discrepancy_after === true  ? '<span style="color:#dc2626;font-weight:700">⚠ Real discrepancy remains</span>' :
                v.has_discrepancy_after === false ? '<span style="color:#15803d;font-weight:700">✅ Clear</span>' :
                                                    '<span style="color:#6b7280">—</span>'
              }</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top:10px;font-size:11px;color:#6b7280">
        Refresh the In-Transit list / Voucher Log to see updated banner states.
        Click <strong>Run Audit</strong> again to confirm nothing remains.
      </div>` : ''}
    `;
    btn.disabled = true; btn.style.opacity = .55;
    btn.textContent = orig;
    // Best-effort refresh of caller-side state so the user sees clean lists
    // without having to manually reload. None of these are required.
    try { if(typeof loadVoucherLog === 'function') loadVoucherLog(); } catch(_e){}
    try { if(typeof mmLoadHistory   === 'function') mmLoadHistory();   } catch(_e){}
    try { if(typeof mvRefreshInTransitCount === 'function') mvRefreshInTransitCount(); } catch(_e){}
  } catch(e){
    res.innerHTML = `<div style="padding:14px;color:#dc2626">Error: ${e.message}</div>`;
    btn.textContent = orig;
    btn.disabled = false;
  }
}
