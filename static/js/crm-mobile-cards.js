/*!
 * CRM Mobile Cards (cardify) v3
 * Har listing table ko mobile par card view me convert karta hai +
 * mobile "Select All" bar add karta hai (existing checkAll/toggleAll se wired).
 * Desktop par koi visual change nahi.  Pair file: crm-mobile-cards.css
 */
(function () {
  'use strict';

  /* ===================== CONFIG ===================== */
  var SELECTOR = 'table:not(.no-cardify)';
  /* ================================================== */

  function norm(t){ return (t || '').replace(/\s+/g, ' ').trim(); }
  function low(t){ return norm(t).toLowerCase(); }
  function esc(s){ var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function roleFor(label, th, index){
    if (th && th.querySelector('input[type="checkbox"]')) return 'check';
    var l = low(label);
    if (l === '' && index === 0) return 'check';
    if (l === '#' || l === 'sr' || l === 'sr.' || l === 'no' || l === 's.no' || l === 'sno') return 'serial';
    if (l.indexOf('action')  !== -1) return 'actions';
    if (l.indexOf('company') !== -1) return 'sub';
    if (l.indexOf('name')    !== -1) return 'title';
    if (l.indexOf('status')  !== -1) return 'status';
    if (l.indexOf('product') !== -1) return 'product';
    if (l.indexOf('day') !== -1 || l.indexOf('age') !== -1) return 'age';
    return 'field';
  }

  function statusClass(text){
    var t = low(text);
    if (/won|close\b|complete|approve|active|paid|deliver/.test(t)) return 'cf-st-green';
    if (/process|pending|progress|hold|review/.test(t))            return 'cf-st-amber';
    if (/cancel|reject|lost|inactive|fail|delete/.test(t))         return 'cf-st-red';
    if (/open|new|fresh/.test(t))                                  return 'cf-st-blue';
    return 'cf-st-default';
  }

  function processRow(row, headers){
    if (row.__cf) return;
    row.classList.add('cf-card');
    var cells = row.cells;
    for (var c = 0; c < cells.length && c < headers.length; c++){
      var td = cells[c];
      var h  = headers[c];
      var role = roleFor(h.text, h.el, c);
      td.classList.add('cf-' + role);

      if (role === 'field' || role === 'product'){
        td.setAttribute('data-label', norm(h.text));
      }
      if (role === 'status'){
        var el = td.querySelector('.sbadge, .badge, .label, .chip, span, a, b, strong');
        if (el){ el.classList.add('cf-pill'); }
        else { var txt = norm(td.textContent); if (txt) td.innerHTML = '<span class="cf-pill">' + esc(txt) + '</span>'; }
        td.classList.add(statusClass(td.textContent));
      }
      if (role === 'age'){
        var ael = td.querySelector('.age-pill, .badge, .label, .chip, span, a, b, strong');
        if (ael){ ael.classList.add('cf-age-pill'); }
        else {
          var atxt = norm(td.textContent);
          if (atxt && atxt !== '-' && atxt !== '\u2014')
            td.innerHTML = '<span class="cf-age-pill">' + esc(atxt) + '</span>';
        }
      }
    }
    row.__cf = true;
  }

  /* Mobile "Select All" bar — table ke upar */
  function addSelectBar(table){
    if (table.__cfbar) return;
    var head = table.tHead;
    var headCb = head ? head.querySelector('input[type="checkbox"]') : null;

    // count noun table id se
    var id = (table.id || '');
    var noun = 'records';
    if (/lead/i.test(id))       noun = 'leads';
    else if (/client/i.test(id))noun = 'clients';
    else if (/quot/i.test(id))  noun = 'quotations';
    else if (/sample|order/i.test(id)) noun = 'orders';

    var count = table.querySelectorAll('tbody tr.cf-card').length;

    var bar = document.createElement('div');
    bar.className = 'cf-selectbar';
    bar.innerHTML =
      '<label class="cf-sb-left"><input type="checkbox" class="cf-sb-cb"> Select All</label>' +
      '<span class="cf-sb-count">' + count + ' ' + noun + '</span>';

    table.parentNode.insertBefore(bar, table);

    var cb = bar.querySelector('.cf-sb-cb');
    cb.addEventListener('change', function(){
      var checked = cb.checked;
      if (headCb){
        headCb.checked = checked;
        headCb.dispatchEvent(new Event('change', { bubbles: true }));  // aapka toggleAll() chalega
      } else {
        table.querySelectorAll('tbody input[type="checkbox"]').forEach(function(x){
          if (x.checked !== checked){ x.checked = checked; x.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      }
    });

    // individual row checkbox change par bar ka state sync
    table.addEventListener('change', function(e){
      if (e.target && e.target.matches('tbody input[type="checkbox"]')){
        var all = table.querySelectorAll('tbody input[type="checkbox"]');
        var on  = table.querySelectorAll('tbody input[type="checkbox"]:checked');
        cb.checked = (all.length > 0 && all.length === on.length);
      }
    });

    table.__cfbar = true;
  }

  function cardify(table){
    var thead = table.tHead;
    if (!thead || !thead.rows.length) return;
    var headRow = thead.rows[thead.rows.length - 1];
    if (headRow.cells.length < 2) return;

    var headers = [];
    for (var i = 0; i < headRow.cells.length; i++){
      headers.push({ text: headRow.cells[i].textContent, el: headRow.cells[i] });
    }
    table.classList.add('cf-ready');

    var bodies = table.tBodies;
    for (var b = 0; b < bodies.length; b++){
      var rows = bodies[b].rows;
      for (var r = 0; r < rows.length; r++){ processRow(rows[r], headers); }
    }

    addSelectBar(table);
  }

  function run(){
    var tables = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < tables.length; i++){ cardify(tables[i]); }
  }

  function init(){
    run();
    if (window.MutationObserver){
      var obs = new MutationObserver(function(){
        clearTimeout(init.__t);
        init.__t = setTimeout(run, 150);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CRMCardify = { refresh: run };
})();
