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

/* ═══════════════════════ COMBOBOX (type-to-search dropdown) ═══════════════════════
   Non-invasive: wraps an existing <select>. The original <select> stays in the
   DOM (hidden) so any code that does selectEl.value, selectEl.innerHTML='<option…>',
   selectEl.onchange, etc. keeps working unchanged. The combobox <input> mirrors
   the select's options, filters on typing, and writes back to selectEl.value
   (then dispatches a 'change' event) when an option is picked.

   Usage:
     <select id="mySel" class="combo">…options…</select>
     comboboxRefresh('mySel');   // call once after the options are in place,
                                 // and again any time you replace innerHTML

   Existing callers continue to work:
     document.getElementById('mySel').value = '42';
     comboboxSyncDisplay('mySel');   // optional — keeps the visible text in sync
*/
function comboboxInit(selectEl){
    if(!selectEl || selectEl._comboInit) return;
    if(selectEl.tagName !== 'SELECT') return;
    selectEl._comboInit = true;

    // Read layout-relevant inline styles from the original <select> BEFORE we overwrite them.
    // The wrapper needs to inherit flex sizing so the combobox sits correctly in flex/grid layouts.
    const origCs = window.getComputedStyle(selectEl);
    const origInline = selectEl.style;
    const inheritedStyles = [];
    // Prefer inline style values (intentional from the markup), fall back to computed if needed.
    const pickProp = function(prop){
        if (origInline[prop]) return origInline[prop];
        return null;
    };
    const flexVal      = pickProp('flex')      || (origInline.flexGrow ? origInline.flexGrow : null);
    const flexGrowVal  = pickProp('flexGrow');
    const minWidthVal  = pickProp('minWidth');
    const maxWidthVal  = pickProp('maxWidth');
    const widthVal     = pickProp('width');
    if (flexVal)     inheritedStyles.push('flex:'+flexVal);
    if (flexGrowVal && !flexVal) inheritedStyles.push('flex-grow:'+flexGrowVal);
    if (minWidthVal) inheritedStyles.push('min-width:'+minWidthVal);
    if (maxWidthVal) inheritedStyles.push('max-width:'+maxWidthVal);
    if (widthVal)    inheritedStyles.push('width:'+widthVal);

    // Capture the ORIGINAL inline style attribute BEFORE we mutate the select below
    // (which would otherwise contaminate the input with position:absolute;opacity:0 etc.).
    // Strip layout-sizing props (those go to the wrapper, not the input).
    const _origStyleAttr = selectEl.getAttribute('style') || '';
    let inheritedInputStyle = '';
    if (_origStyleAttr) {
        inheritedInputStyle = _origStyleAttr
            .split(';')
            .filter(function(decl){
                const k = decl.split(':')[0].trim().toLowerCase();
                return k && k!=='flex' && k!=='flex-grow' && k!=='min-width' && k!=='max-width' && k!=='width';
            })
            .join(';');
    }

    // Wrap
    const wrap = document.createElement('span');
    wrap.className = 'combo-wrap';
    // Use inline-block by default (works inline alongside labels); the wrapper itself
    // sizes via inherited flex/width. The visible input ALWAYS fills the wrapper.
    let wrapStyle = 'position:relative;display:inline-block;vertical-align:middle';
    const hasFlex  = inheritedStyles.some(s => s.startsWith('flex:') || s.startsWith('flex-grow:'));
    const hasWidth = inheritedStyles.some(s => s.startsWith('width:'));
    // Only force width:100% when neither flex nor explicit width was specified on the select.
    if (!hasFlex && !hasWidth) wrapStyle += ';width:100%';
    if (inheritedStyles.length) wrapStyle += ';' + inheritedStyles.join(';');
    wrap.style.cssText = wrapStyle;
    selectEl.parentNode.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);

    // Hide the native select but keep it in the DOM (a11y + value source)
    selectEl.setAttribute('tabindex','-1');
    selectEl.style.position = 'absolute';
    selectEl.style.opacity = '0';
    selectEl.style.pointerEvents = 'none';
    selectEl.style.height = '1px';
    selectEl.style.width = '1px';
    selectEl.style.left = '0';
    selectEl.style.top = '0';
    selectEl.setAttribute('aria-hidden','true');

    // Build the visible input
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.className = selectEl.className.replace(/\bcombo\b/g,'').trim() || 'form-input-styled';
    inp.placeholder = selectEl.getAttribute('data-combo-placeholder') || 'Type to search…';
    // Apply the ORIGINAL inline style hints (captured above before mutation) so the input
    // lines up with the original. The input must always fill its wrapper width.
    inp.setAttribute('style', (inheritedInputStyle ? inheritedInputStyle + ';' : '')
        + 'width:100%;box-sizing:border-box;padding-right:24px');
    inp.setAttribute('role','combobox');
    inp.setAttribute('aria-autocomplete','list');
    inp.setAttribute('aria-expanded','false');
    if(selectEl.disabled) inp.disabled = true;
    wrap.appendChild(inp);

    // Chevron indicator
    const chev = document.createElement('span');
    chev.textContent = '▾';
    chev.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);font-size:10px';
    wrap.appendChild(chev);

    // Dropdown panel
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    panel.style.cssText = 'position:absolute;left:0;right:0;top:100%;margin-top:2px;background:var(--surface);border:1px solid var(--border2);border-radius:7px;box-shadow:0 6px 22px rgba(0,0,0,.18);max-height:240px;overflow-y:auto;z-index:1000;display:none';
    wrap.appendChild(panel);

    let highlightIdx = -1;
    let filtered = [];   // array of {value, label, idx}

    function readOptions(){
        const opts = [];
        for(let i=0;i<selectEl.options.length;i++){
            const o = selectEl.options[i];
            opts.push({value:o.value, label:o.textContent || '', idx:i});
        }
        return opts;
    }

    function renderPanel(query){
        const q = (query||'').toLowerCase().trim();
        const all = readOptions();
        filtered = q ? all.filter(o => o.label.toLowerCase().includes(q)) : all;
        if(!filtered.length){
            panel.innerHTML = '<div style="padding:8px 10px;color:var(--muted);font-size:11px;font-style:italic">No matches</div>';
            highlightIdx = -1;
            return;
        }
        panel.innerHTML = filtered.map(function(o,i){
            const sel = String(selectEl.value) === String(o.value);
            return '<div class="combo-opt" data-vidx="'+i+'" '
                + 'style="padding:6px 10px;cursor:pointer;font-size:12px;'
                + (sel?'background:rgba(13,148,136,.10);color:var(--teal);font-weight:600':'color:var(--text)')
                + '">'+escHtml(o.label)+'</div>';
        }).join('');
        // Default highlight: the currently selected one if visible, else first
        highlightIdx = 0;
        for(let i=0;i<filtered.length;i++){
            if(String(filtered[i].value) === String(selectEl.value)){ highlightIdx = i; break; }
        }
        applyHighlight();
    }

    function applyHighlight(){
        const items = panel.querySelectorAll('.combo-opt');
        items.forEach(function(el,i){
            if(i===highlightIdx){
                el.style.background = 'var(--surface2)';
                el.style.outline = '1px solid var(--teal)';
                el.scrollIntoView({block:'nearest'});
            } else if(String(filtered[i].value) !== String(selectEl.value)){
                el.style.background = '';
                el.style.outline = '';
            }
        });
    }

    function openPanel(){
        renderPanel(inp.value === currentLabel() ? '' : inp.value);
        panel.style.display = 'block';
        inp.setAttribute('aria-expanded','true');
    }
    function closePanel(){
        panel.style.display = 'none';
        inp.setAttribute('aria-expanded','false');
        // Restore the display text from the actual selected option
        inp.value = currentLabel();
    }

    function currentLabel(){
        const v = selectEl.value;
        for(let i=0;i<selectEl.options.length;i++){
            if(String(selectEl.options[i].value) === String(v)) return selectEl.options[i].textContent || '';
        }
        return '';
    }

    function pickByFilteredIndex(i){
        if(i<0 || i>=filtered.length) return;
        const o = filtered[i];
        if(String(selectEl.value) !== String(o.value)){
            selectEl.value = o.value;
            selectEl.dispatchEvent(new Event('change', {bubbles:true}));
        }
        inp.value = o.label;
        closePanel();
    }

    // Events
    inp.addEventListener('focus', openPanel);
    inp.addEventListener('click', openPanel);
    inp.addEventListener('input', function(){
        renderPanel(inp.value);
        panel.style.display = 'block';
        inp.setAttribute('aria-expanded','true');
    });
    inp.addEventListener('keydown', function(e){
        if(e.key === 'ArrowDown'){
            e.preventDefault();
            if(panel.style.display === 'none') openPanel();
            else { highlightIdx = Math.min(highlightIdx+1, filtered.length-1); applyHighlight(); }
        } else if(e.key === 'ArrowUp'){
            e.preventDefault();
            highlightIdx = Math.max(highlightIdx-1, 0);
            applyHighlight();
        } else if(e.key === 'Enter'){
            if(panel.style.display !== 'none' && highlightIdx >= 0){
                e.preventDefault();
                pickByFilteredIndex(highlightIdx);
            }
        } else if(e.key === 'Escape'){
            closePanel();
            inp.blur();
        } else if(e.key === 'Tab'){
            // Commit on Tab if a single match is highlighted
            if(panel.style.display !== 'none' && filtered.length === 1) pickByFilteredIndex(0);
            closePanel();
        }
    });
    panel.addEventListener('mousedown', function(e){
        // Prevent input blur before click registers
        const opt = e.target.closest('.combo-opt');
        if(!opt) return;
        e.preventDefault();
        const i = parseInt(opt.getAttribute('data-vidx'),10);
        pickByFilteredIndex(i);
    });
    inp.addEventListener('blur', function(){
        // Slight delay so a click on a panel item still fires
        setTimeout(function(){
            if(panel.style.display !== 'none') closePanel();
        }, 120);
    });
    // Outside-click close
    document.addEventListener('mousedown', function(e){
        if(!wrap.contains(e.target)) closePanel();
    });

    // Public helpers attached to the select for external sync
    selectEl._comboSync = function(){
        inp.value = currentLabel();
        if(selectEl.disabled){ inp.disabled = true; }
        else { inp.disabled = false; }
    };

    // Initial display
    inp.value = currentLabel();
}

/* Initialize / refresh any combobox by select id. Safe to call repeatedly:
   first call wires it up; subsequent calls just sync the display from the
   current selectEl.value (use after innerHTML re-populate). */
function comboboxRefresh(idOrEl){
    const el = (typeof idOrEl === 'string') ? document.getElementById(idOrEl) : idOrEl;
    if(!el) return;
    if(!el._comboInit) comboboxInit(el);
    else if(typeof el._comboSync === 'function') el._comboSync();
}

/* Re-sync just the visible text after `selectEl.value = …` set programmatically */
function comboboxSyncDisplay(idOrEl){
    const el = (typeof idOrEl === 'string') ? document.getElementById(idOrEl) : idOrEl;
    if(!el || !el._comboInit) return;
    if(typeof el._comboSync === 'function') el._comboSync();
}

/* Auto-init: any <select class="combo"> in the document becomes a combobox
   automatically when its <option>s are present. Re-run after dynamic option
   injection by calling comboboxRefresh(id). */
function comboboxAutoInit(root){
    (root||document).querySelectorAll('select.combo:not([data-combo-skip])').forEach(function(s){
        if(!s._comboInit) comboboxInit(s);
    });
}
document.addEventListener('DOMContentLoaded', function(){ comboboxAutoInit(); });


