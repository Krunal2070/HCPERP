/* app.js — Clock, theme switcher, tab switching, settings
   Depends on: utils.js */

/* ═══════════════════════ CLOCK ═══════════════════════ */
function updateClock(){
    document.getElementById('clockDisplay').textContent=
        new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
updateClock(); setInterval(updateClock,1000);

/* ═══════════════════════ THEME ═══════════════════════ */
const THEMES = ['dark','light','midnight','ocean','sage'];
let _currentTheme = localStorage.getItem('hcp_procurement_theme') ||
                    localStorage.getItem('hcp_theme') || 'dark';

function applyTheme(t){
    _currentTheme=t;
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem('hcp_procurement_theme',t);
    const icons={dark:'🌙',light:'☀️',midnight:'🔮',ocean:'🌊',sage:'🌿'};
    const btn=document.getElementById('themeToggleBtn');
    if(btn)btn.querySelector(':not(.ib-tip)') || (btn.textContent='') ;
    if(btn){btn.innerHTML = (icons[t]||'🎨')+'<span class="ib-tip">Theme · Ctrl+D</span>';}
    // Update swatch selection
    document.querySelectorAll('.theme-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.theme===t));
}
function cycleTheme(){
    const idx=(THEMES.indexOf(_currentTheme)+1)%THEMES.length;
    applyTheme(THEMES[idx]);
    toast('Theme: '+THEMES[idx],'info',1800);
}
function selectTheme(t){ applyTheme(t); }
applyTheme(_currentTheme);

/* ═══════════════════════ TABS ═══════════════════════ */
/* Section header config per tab */
var _SECTION_META = {
    'mqsd': {
        label:'MATERIALS', title:'Material Master',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        badgeId:'tabBadge'
    },
    'fvq': {
        label:'FORMULATIONS', title:'Formulations vs Qty',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/></svg>',
        badgeId:'fvqBadge'
    },
    'po': {
        label:'PURCHASE ORDERS', title:'Purchase Orders',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
        badgeId:'poBadge'
    },
    'sup': {
        label:'SUPPLIERS', title:'Supplier Directory',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        badgeId:'supBadge'
    },
    'sup-ledger': {
        label:'SUPPLIERS', title:'Supplier PO Ledger',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        badgeId:'supBadge'
    },
    'fg': {
        label:'FINISHED GOODS', title:'Finished Goods Registry',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>',
        badgeId:'fgBadge'
    },
    'grn': {
        label:'GOODS RECEIPT', title:'Goods Receipt Notes',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
        badgeId:'grnBadge'
    },
    'mtv': {
        label:'TRANSFERS', title:'Material Transfer Vouchers',
        icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/><path d="M19 12l-7-7"/></svg>',
        badgeId:'mtvBadge'
    }
};
function switchTab(id){
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    const tabBtn = document.getElementById('tab-'+id);
    if (tabBtn) tabBtn.classList.add('active');
    const tc = document.getElementById('tc-'+id);
    if (tc) tc.classList.add('active');
    // Update section header bar
    var meta = _SECTION_META[id];
    if (meta) {
        var iconEl   = document.getElementById('sectionIcon');
        var labelEl  = document.getElementById('sectionLabel');
        var titleEl  = document.getElementById('sectionTitle');
        var badgeEl  = document.getElementById('sectionBadge');
        if (iconEl)  iconEl.innerHTML  = meta.icon;
        if (labelEl) labelEl.textContent = meta.label;
        if (titleEl) titleEl.textContent = meta.title;
        if (badgeEl && meta.badgeId) {
            var srcBadge = document.getElementById(meta.badgeId);
            badgeEl.textContent = srcBadge ? (srcBadge.textContent || '–') : '–';
        }
    }
}

/* ═══════════════════════ SETTINGS ═══════════════════════ */
async function openSettings(){
    // Load current settings from server
    try{
        const res=await fetch('/api/procurement/settings');
        const data=await res.json();
        if(data.status==='ok'){
            document.getElementById('stkSumPathInput').value = data.settings.stksum_path||'';
        }
    }catch(e){}
    document.getElementById('testResult').className='test-result';
    document.getElementById('testResult').style.display='none';
    // Update swatch selection
    document.querySelectorAll('.theme-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.theme===_currentTheme));
    document.getElementById('settingsModal').classList.add('open');
}
function closeSettings(){ document.getElementById('settingsModal').classList.remove('open'); }
document.getElementById('settingsModal').addEventListener('click',e=>{
    if(e.target===document.getElementById('settingsModal'))closeSettings();
});

async function testStkSumPath(){
    const path=document.getElementById('stkSumPathInput').value.trim();
    const res=document.getElementById('testResult');
    res.textContent='Testing…'; res.className='test-result ok'; res.style.display='block';
    try{
        const r=await fetch('/api/procurement/test_stksum_path',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path})
        });
        const d=await r.json();
        if(d.exists){
            res.className='test-result ok';
            res.textContent=`✅ File found · ${d.row_count} material rows detected`;
        } else {
            res.className='test-result fail';
            res.textContent=`❌ File not found at: ${d.path}`;
        }
    }catch(e){
        res.className='test-result fail';
        res.textContent='❌ Test failed: '+e.message;
    }
}

async function saveSettings(){
    const path=document.getElementById('stkSumPathInput').value.trim();
    try{
        const res=await fetch('/api/procurement/settings',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({stksum_path:path})
        });
        const data=await res.json();
        if(data.status!=='ok')throw new Error(data.message);
        closeSettings();
        toast('Settings saved — refresh to apply new path','success');
    }catch(e){ toast('Save failed: '+e.message,'error'); }
}

