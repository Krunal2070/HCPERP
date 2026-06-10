/* ════════════════════════════════════════════════════════════════════════
   inventory_expiry_guard.js — Two-level near-expiry warning on entry
   HCP Wellness
   ────────────────────────────────────────────────────────────────────────
   When stock is entered (Opening Stock or GRN) with an expiry date within
   2 months (≤ 60 days from today, or already expired), the user must pass
   TWO sequential confirmation prompts before the save proceeds. This guards
   against accidentally taking in near-expiry / expired material.

   Usage (wrap the real save):
     window.invExpiryGuard(items, onConfirmed, opts)
       items       : array of { expiry_date:'YYYY-MM-DD', label?:'name' }
                     (label optional — used in the warning list)
       onConfirmed : called once the user clears BOTH levels (or when nothing
                     is near expiry, in which case it's called immediately)
       opts        : { days?:60, context?:'GRN'|'Opening Stock' }

   Self-contained: injects its own modal + styles. Theme-token aware.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  var WARN_DAYS = 60;   // "within 2 months"
  var esc = function(s){ return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };

  function _id(x){ return document.getElementById(x); }

  /* Parse 'YYYY-MM-DD' (or ISO) → Date at local midnight, or null. */
  function _parseDate(s){
    if(!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if(!m) return null;
    var d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    return isNaN(d.getTime()) ? null : d;
  }
  function _fmtDMY(d){
    if(!d) return '';
    var dd = String(d.getDate()).padStart(2,'0');
    var mm = String(d.getMonth()+1).padStart(2,'0');
    return dd + '/' + mm + '/' + d.getFullYear();
  }
  function _daysLeft(d){
    var today = new Date(); today.setHours(0,0,0,0);
    return Math.round((d - today) / 86400000);
  }

  /* Inspect items; return the subset that is near-expiry/expired with details. */
  function _flagged(items, days){
    var out = [];
    (items||[]).forEach(function(it){
      var d = _parseDate(it && it.expiry_date);
      if(!d) return;                          // no expiry → nothing to warn
      var dl = _daysLeft(d);
      if(dl <= days){                          // within window OR already past
        out.push({ label: (it.label||'').trim(), date: d, days_left: dl,
                   expired: dl < 0 });
      }
    });
    // Soonest first.
    out.sort(function(a,b){ return a.days_left - b.days_left; });
    return out;
  }

  function _injectStyles(){
    if(_id('inv-exg-styles')) return;
    var st = document.createElement('style');
    st.id = 'inv-exg-styles';
    st.textContent = ''
      + '.inv-exg-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);'
      + '  display:none;align-items:center;justify-content:center;z-index:4000}'
      + '.inv-exg-ov.show{display:flex}'
      + '.inv-exg-card{background:var(--card,#fff);border-radius:16px;width:480px;'
      + '  max-width:92vw;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;'
      + '  border:1px solid var(--border,rgba(0,0,0,.12))}'
      + '.inv-exg-head{display:flex;align-items:center;gap:11px;padding:16px 18px;'
      + '  background:linear-gradient(180deg,#FEF7E0,#FDECC8);'
      + '  border-bottom:1px solid rgba(176,96,0,.22)}'
      + '.inv-exg-head.lvl2{background:linear-gradient(180deg,#FCE8E6,#F9D9D6);'
      + '  border-bottom-color:rgba(197,34,31,.25)}'
      + '.inv-exg-ic{width:38px;height:38px;border-radius:10px;flex:0 0 auto;'
      + '  display:flex;align-items:center;justify-content:center;font-size:18px;'
      + '  background:#fff;color:#B06000;box-shadow:0 2px 6px rgba(176,96,0,.18)}'
      + '.inv-exg-head.lvl2 .inv-exg-ic{color:#C5221F;box-shadow:0 2px 6px rgba(197,34,31,.2)}'
      + '.inv-exg-ttl{font-size:15px;font-weight:800;color:#1F1F1F}'
      + '.inv-exg-sub{font-size:11.5px;font-weight:700;letter-spacing:.04em;'
      + '  text-transform:uppercase;color:#B06000}'
      + '.inv-exg-head.lvl2 .inv-exg-sub{color:#C5221F}'
      + '.inv-exg-body{padding:16px 18px;font-size:13px;color:var(--text,#1F1F1F);line-height:1.5}'
      + '.inv-exg-list{margin:12px 0 4px;max-height:180px;overflow:auto;'
      + '  border:1px solid var(--border2,rgba(0,0,0,.08));border-radius:10px}'
      + '.inv-exg-list table{width:100%;border-collapse:collapse;font-size:12px}'
      + '.inv-exg-list th{text-align:left;padding:7px 10px;background:var(--surface2,#FAF9F5);'
      + '  font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3,#80868B);'
      + '  font-weight:700;position:sticky;top:0}'
      + '.inv-exg-list td{padding:7px 10px;border-top:1px solid var(--border2,rgba(0,0,0,.06))}'
      + '.inv-exg-list td.d{font-weight:700;white-space:nowrap}'
      + '.inv-exg-list td.d.exp{color:#C5221F}'
      + '.inv-exg-list td.d.soon{color:#B06000}'
      + '.inv-exg-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;'
      + '  border-top:1px solid var(--border2,rgba(0,0,0,.07))}'
      + '.inv-exg-btn{padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;'
      + '  cursor:pointer;border:1px solid var(--border,rgba(0,0,0,.15));'
      + '  background:var(--card,#fff);color:var(--text,#1F1F1F)}'
      + '.inv-exg-btn:hover{background:var(--surface2,#FAF9F5)}'
      + '.inv-exg-btn.warn{border:none;color:#fff;'
      + '  background:linear-gradient(180deg,#C5221F,#A11815)}'
      + '.inv-exg-btn.warn:hover{filter:brightness(1.06)}';
    document.head.appendChild(st);
  }

  function _ensureModal(){
    if(_id('invExgOv')) return;
    _injectStyles();
    var ov = document.createElement('div');
    ov.className = 'inv-exg-ov';
    ov.id = 'invExgOv';
    ov.innerHTML =
      '<div class="inv-exg-card" role="alertdialog" aria-modal="true">'
      + '<div class="inv-exg-head" id="invExgHead">'
      +   '<div class="inv-exg-ic" id="invExgIc">⏳</div>'
      +   '<div><div class="inv-exg-sub" id="invExgSub">Near-expiry warning</div>'
      +   '<div class="inv-exg-ttl" id="invExgTtl"></div></div>'
      + '</div>'
      + '<div class="inv-exg-body" id="invExgBody"></div>'
      + '<div class="inv-exg-foot">'
      +   '<button class="inv-exg-btn" id="invExgCancel">Cancel</button>'
      +   '<button class="inv-exg-btn warn" id="invExgProceed"></button>'
      + '</div></div>';
    document.body.appendChild(ov);
    // Clicking the backdrop cancels (safer default for a warning).
    ov.addEventListener('click', function(e){ if(e.target===ov) _resolve(false); });
  }

  var _pending = null;   // resolver for the current prompt

  function _resolve(ok){
    var ov = _id('invExgOv'); if(ov) ov.classList.remove('show');
    var fn = _pending; _pending = null;
    if(typeof fn === 'function') fn(ok);
  }

  /* Show one prompt; resolves the returned promise true(proceed)/false(cancel). */
  function _prompt(level, flagged, context){
    return new Promise(function(resolve){
      _ensureModal();
      _pending = resolve;
      var head = _id('invExgHead');
      head.className = 'inv-exg-head' + (level===2 ? ' lvl2' : '');
      _id('invExgIc').textContent  = level===2 ? '⚠️' : '⏳';
      _id('invExgSub').textContent = level===2 ? 'Final confirmation' : 'Near-expiry warning';

      var n = flagged.length;
      var anyExpired = flagged.some(function(f){ return f.expired; });
      var ctx = context ? (' in this ' + esc(context)) : '';

      if(level===1){
        _id('invExgTtl').textContent =
          n + ' item' + (n===1?'':'s') + (anyExpired?' expired / expiring soon':' expiring within 2 months');
      } else {
        _id('invExgTtl').textContent = 'Take in near-expiry stock?';
      }

      var rows = flagged.map(function(f){
        var cls = f.expired ? 'd exp' : 'd soon';
        var txt = f.expired ? ('Expired ' + Math.abs(f.days_left) + 'd ago')
                            : (f.days_left + 'd left');
        return '<tr><td>' + (f.label ? esc(f.label) : '<span style="color:var(--text3,#80868B)">(item)</span>')
             + '</td><td>' + _fmtDMY(f.date) + '</td>'
             + '<td class="' + cls + '">' + txt + '</td></tr>';
      }).join('');

      var lead = level===1
        ? ('The following' + ctx + ' ' + (n===1?'has an expiry date':'have expiry dates')
           + ' within 2 months' + (anyExpired?' (some already expired)':'') + ':')
        : ('You are about to save stock that is near or past expiry. This will be '
           + 'tracked under FEFO and flagged in expiry reports. Please confirm you '
           + 'intend to take in this material.');

      _id('invExgBody').innerHTML =
        '<div>' + lead + '</div>'
        + '<div class="inv-exg-list"><table>'
        + '<thead><tr><th>Item</th><th>Expiry</th><th>Status</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>';

      _id('invExgProceed').textContent = level===1 ? 'Continue' : 'Yes, save anyway';

      // (Re)bind buttons fresh each prompt.
      var pBtn = _id('invExgProceed'), cBtn = _id('invExgCancel');
      pBtn.onclick = function(){ _resolve(true); };
      cBtn.onclick = function(){ _resolve(false); };

      _id('invExgOv').classList.add('show');
    });
  }

  /* Public API: gate `onConfirmed` behind the two-level warning. */
  window.invExpiryGuard = function(items, onConfirmed, opts){
    opts = opts || {};
    var days = (typeof opts.days === 'number') ? opts.days : WARN_DAYS;
    var context = opts.context || '';
    var flagged = _flagged(items, days);

    // Nothing near expiry → proceed straight away.
    if(!flagged.length){ if(typeof onConfirmed==='function') onConfirmed(); return; }

    // Two sequential confirmations.
    _prompt(1, flagged, context).then(function(ok1){
      if(!ok1) return;                          // cancelled at level 1
      _prompt(2, flagged, context).then(function(ok2){
        if(!ok2) return;                        // cancelled at level 2
        if(typeof onConfirmed==='function') onConfirmed();
      });
    });
  };

  console.log('inventory_expiry_guard.js loaded');
})();
