/*
   inventory_combo.js - reusable searchable combobox (RM)
   HCP Wellness - type-to-search dropdown to replace plain <select> wherever
   a selection is made (materials, suppliers, godowns, ...). pm-themed.

   Usage:
     const combo = invCombo({
       mount: someDivElement,          // container to render into
       placeholder: 'Select material',
       options: [{value, label, sub}], // sub = optional muted second line
       value: '',                      // initial value
       onChange: (value, option) => {} // fires on selection
     });
     combo.setOptions([...]);  combo.setValue(v);  combo.getValue();  combo.clear();
*/

(function(){
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
  let _seq = 0;

  function invCombo(cfg){
    const id = 'cmb' + (++_seq);
    let options = cfg.options || [];
    let value   = cfg.value || '';
    let open    = false;
    let active  = -1;   // keyboard-highlighted index in the filtered list

    const wrap = cfg.mount;
    wrap.classList.add('inv-combo');
    wrap.style.position = 'relative';
    wrap.innerHTML = `
      <input type="text" id="${id}-inp" autocomplete="off" placeholder="${esc(cfg.placeholder||'Search…')}"
        style="width:100%;padding:8px 30px 8px 11px;border:1.5px solid var(--border2,rgba(0,0,0,.13));border-radius:8px;font-size:12.5px;background:var(--white,#fff);color:var(--text,#1F1F1F);outline:none">
      <span id="${id}-car" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:var(--text3,#80868B);pointer-events:none;font-size:11px">▾</span>
      <div id="${id}-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:1200;background:var(--white,#fff);border:1.5px solid var(--border2,rgba(0,0,0,.15));border-top:none;border-radius:0 0 8px 8px;max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>`;

    const inp = wrap.querySelector(`#${id}-inp`);
    const dd  = wrap.querySelector(`#${id}-dd`);

    function labelFor(v){ const o = options.find(o => String(o.value) === String(v)); return o ? o.label : ''; }
    function filtered(){
      const q = (inp.value || '').trim().toLowerCase();
      if(!q) return options.slice(0, 50);
      return options.filter(o =>
        (o.label||'').toLowerCase().includes(q) || (o.sub||'').toLowerCase().includes(q)
      ).slice(0, 50);
    }
    function render(){
      const list = filtered();
      if(!list.length){ dd.innerHTML = `<div style="padding:10px 12px;color:var(--text3,#80868B);font-size:12px">No matches</div>`; return; }
      dd.innerHTML = list.map((o,i) => `
        <div class="inv-combo-opt" data-val="${esc(o.value)}" data-i="${i}"
          style="padding:8px 12px;cursor:pointer;font-size:12.5px;border-bottom:1px solid var(--border2,rgba(0,0,0,.05));${i===active?'background:var(--blue-lt,#E8F0FE)':''}">
          <div style="font-weight:600;color:var(--text,#1F1F1F)">${esc(o.label)}</div>
          ${o.sub?`<div style="font-size:10.5px;color:var(--text2,#5F6368)">${esc(o.sub)}</div>`:''}
        </div>`).join('');
      dd.querySelectorAll('.inv-combo-opt').forEach(el => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(el.dataset.val); });
      });
    }
    function show(){ open=true; active=-1; render(); dd.style.display='block'; }
    function hide(){ open=false; dd.style.display='none'; }
    function pick(v){
      value = v;
      const o = options.find(o => String(o.value) === String(v));
      inp.value = o ? o.label : '';
      hide();
      if(cfg.onChange) cfg.onChange(value, o || null);
    }

    inp.addEventListener('focus', () => { inp.select(); show(); });
    inp.addEventListener('input', () => { value=''; active=-1; show(); });
    inp.addEventListener('blur',  () => { setTimeout(() => { if(!value) inp.value=labelFor(value); hide(); }, 120); });
    inp.addEventListener('keydown', (e) => {
      const list = filtered();
      if(e.key === 'ArrowDown'){ e.preventDefault(); active=Math.min(active+1, list.length-1); render(); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); active=Math.max(active-1, 0); render(); }
      else if(e.key === 'Enter'){ if(open && active>=0 && list[active]){ e.preventDefault(); pick(list[active].value); } }
      else if(e.key === 'Escape'){ hide(); }
    });

    if(value) inp.value = labelFor(value);

    return {
      setOptions(o){ options = o || []; if(value) inp.value = labelFor(value); },
      setValue(v){ value = v; inp.value = labelFor(v); },
      getValue(){ return value; },
      clear(){ value=''; inp.value=''; },
      focus(){ inp.focus(); },
      el: wrap,
    };
  }

  window.invCombo = invCombo;
  console.log('inventory_combo.js loaded');
})();
