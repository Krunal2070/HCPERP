/* pm_stock_state.js — globals + locations + tabs + brand/pm-type pickers */

// ── lines 1..16 (originally L1..L16) ─────────────────────────
/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
let _products    = [];
window._products = _products;  // Expose for cross-module access; updated in loadProducts
let _pmTypes     = [];
let _brands      = [];   // [{id,name,color}]
window._brands   = _brands;  // Expose for cross-module access; updated in loadBrands
let _godowns     = [];   // [{id,name,address,godown_type}]
let _summary     = [];
let _logRows     = [];
let _grnRows     = [];
let _mtvRows     = [];
let _selectedRows= {};
let _selectedLog = {};
let _selectedProd= {};


// ── lines 17..53 (originally L17..L53) ─────────────────────────
function _loadPagSize(grid){ return parseInt(localStorage.getItem('pm_pag_'+grid)) || 25; }
const _pag = {
  godown:    {page:1, size:_loadPagSize('godown')},
  floor:     {page:1, size:_loadPagSize('floor')},
  combined:  {page:1, size:_loadPagSize('combined')},
  log:       {page:1, size:_loadPagSize('log')},
  prod:      {page:1, size:_loadPagSize('prod')},
  grn:       {page:1, size:_loadPagSize('grn')},
  mtv:       {page:1, size:_loadPagSize('mtv')},
  suppliers: {page:1, size:25},
  rpt:       {page:1, size:50},
  // Movement-tab list pagination — Transfer History uses its own _mmHistory
  // state and is already paginated; these three are the previously-unpaginated
  // flat lists on Material OUT / Material IN sub-tabs.
  inTransit:     {page:1, size:_loadPagSize('inTransit')},
  inCompleted:   {page:1, size:_loadPagSize('inCompleted')},
  outCompleted:  {page:1, size:_loadPagSize('outCompleted')},
  // Sidebar / admin grids that previously rendered every row at once.
  // Pagination is purely client-side: the loaders fetch the full set once,
  // then paginate() slices it. If any of these ever return >5k rows we'd
  // switch them to server-side pagination, but with current usage the
  // client-side approach is simpler and faster (no extra round-trips on
  // every page click).
  bin:       {page:1, size:_loadPagSize('bin')},        // Recycle bin entries
  myreq:     {page:1, size:_loadPagSize('myreq')},      // My reprint requests
  pendreq:   {page:1, size:_loadPagSize('pendreq')},    // Pending reprint requests
  opening:   {page:1, size:_loadPagSize('opening')},    // Opening stock list
  idmTxn:    {page:1, size:_loadPagSize('idmTxn')},     // Item-detail-modal txn list
  // Material Request list (4th tab next to Material OUT/IN/History).
  // 'mreq' (not 'mr') because renderPag composes 're'+grid+'()' as the
  // button onclick — `remreq()` reads better and avoids collision with
  // any future 'mr' acronym.
  mreq:      {page:1, size:_loadPagSize('mreq')},
};

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('tbDate').textContent = fmtDate(new Date());
  ['ge-date','fe-date','log-from','log-to','sv-to-date','grn-date','grn-from','grn-to','mtv-date','mtv-from-date','mtv-to-date'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = today;
  });
  const xlsInput = document.getElementById('import-xlsx');
  if(xlsInput) xlsInput.addEventListener('change', previewXlsx);
  loadGodowns();      // load locations first
  loadProducts();
  loadPmTypes();
  loadSummary();
  loadUserHome();     // per-user home godown lock (non-admins only)
  switchStockTab('godown');
  // Wait a moment for godowns to load, then refresh pending transfer badge
  setTimeout(() => { if(typeof minRefreshPendingCount === 'function') minRefreshPendingCount(); }, 1500);
});

/* ═══════════════════════════════════════════════════════════
   GODOWNS / LOCATIONS
═══════════════════════════════════════════════════════════ */

// ── loadGodowns (originally L54..L73) ─────────────────────────
async function loadGodowns() {
  try {
    const res = await fetch('/api/pm_stock/godowns');
    if(!res.ok) { console.error('loadGodowns HTTP', res.status); _godowns=[]; }
    else { _godowns = await res.json(); }
    window._godowns = _godowns;  // Expose for cross-module (movement, etc.)
    console.log('loadGodowns:', _godowns.length, 'locations loaded', _godowns);
  } catch(e) { console.error('loadGodowns error:', e); _godowns = []; window._godowns = []; }
  populateGodownSelects();
  buildGodownTabs(); // build dynamic godown sub-tabs in stock view
  // Re-apply lock now that selects have options (no-op if user is admin or unlocked)
  applyHomeGodownLock();
}

/* ═══════════════════════════════════════════════════════════
   PER-USER HOME GODOWN LOCK
   When a non-admin user is mapped to a home godown, every voucher's
   location field is auto-set to that godown and made readonly. The
   admin sees no lock at all (is_admin=true).
═══════════════════════════════════════════════════════════ */

// ── loadUserHome (originally L74..L94) ─────────────────────────
async function loadUserHome() {
  try {
    const res = await fetch('/api/pm_stock/user_home');
    const d   = await res.json();
    if(d.status === 'ok'){
      window._pmUserHome = {
        is_admin:         !!d.is_admin,
        user_name:        d.user_name || '',
        home_godown_id:   d.home_godown_id || null,
        home_godown_name: d.home_godown_name || ''
      };
    } else {
      window._pmUserHome = {is_admin:false, user_name:'', home_godown_id:null, home_godown_name:''};
    }
  } catch(e){
    window._pmUserHome = {is_admin:false, user_name:'', home_godown_id:null, home_godown_name:''};
  }
  applyHomeGodownLock();
}

// Returns true if a lock is in effect (non-admin with a home set).

// ── pmIsLocked (originally L95..L103) ─────────────────────────
function pmIsLocked(){
  const h = window._pmUserHome || {};
  return !h.is_admin && !!h.home_godown_id;
}

// Locks all voucher location fields based on the user's home godown.
// Each entry: {selectId, mode}. mode='single' = always set + disable.
//             mode='transfer-from' / 'transfer-to' = on a transfer modal,
//             one of these is the locked side (the other stays free).

// ── applyHomeGodownLock (originally L104..L135) ─────────────────────────
function applyHomeGodownLock(){
  const h = window._pmUserHome;
  if(!h) return;
  if(h.is_admin || !h.home_godown_id) {
    // Admin or no lock — make sure nothing stays locked from a previous session
    document.querySelectorAll('[data-pm-home-locked]').forEach(el => {
      el.disabled = false;
      el.removeAttribute('data-pm-home-locked');
    });
    document.querySelectorAll('.pm-home-lock-hint').forEach(el => el.remove());
    return;
  }

  const homeId   = String(h.home_godown_id);
  const homeName = h.home_godown_name || `#${homeId}`;

  // Single-godown selects (GRN, DN — both new + edit)
  const singleIds = ['grn-godown','egrn-godown','dn-godown','edn-godown'];
  singleIds.forEach(id => {
    const sel = document.getElementById(id);
    if(!sel) return;
    // Make sure the option exists (godowns may not have loaded yet)
    const opt = sel.querySelector(`option[value="${homeId}"]`);
    if(!opt) return; // godown options not built yet — will retry next call
    sel.value = homeId;
    sel.disabled = true;
    sel.dataset.pmHomeLocked = '1';
    _ensureLockHint(sel, homeName);
  });
}

// Adds a small "🔒 Locked to your home location: NAME" hint underneath a select.

// ── _ensureLockHint (originally L136..L148) ─────────────────────────
function _ensureLockHint(el, homeName){
  // Re-use existing hint if there is one
  let hint = el.parentElement.querySelector('.pm-home-lock-hint');
  if(!hint){
    hint = document.createElement('div');
    hint.className = 'pm-home-lock-hint';
    hint.style.cssText = 'font-size:10px;color:#92400e;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:4px;padding:3px 8px;margin-top:4px;display:inline-flex;align-items:center;gap:5px';
    el.parentElement.appendChild(hint);
  }
  hint.innerHTML = `🔒 Locked to your home location: <strong>${homeName}</strong>`;
}

/* ── Admin: User Home Locations modal ────────────────────────────────── */

// ── godownLabel (originally L265..L270) ─────────────────────────
function godownLabel(g) {
  // procurement_godowns type: 'godown', 'billing', 'shipping', 'floor'
  if(g.godown_type === 'floor' || g.is_floor) return `🏭 FACTORY — ${g.name}${g.city?' · '+g.city:''}`;
  return `🏢 ${g.name}${g.city?' · '+g.city:''}`;
}


// ── populateGodownSelects (originally L271..L308) ─────────────────────────
function populateGodownSelects() {
  const opts = _godowns.map(g => `<option value="${g.id}">${godownLabel(g)}</option>`).join('');
  const allOpts = '<option value="">All Locations</option>' + opts;
  const reqOpts = '<option value="">— Select Location —</option>' + opts;
  // Global location filter — auto-select default godown on first load
  const glLoc = document.getElementById('gl-location');
  if(glLoc) {
    const prev = glLoc.value;
    glLoc.innerHTML = allOpts;
    if(prev) {
      glLoc.value = prev;  // preserve existing selection
    } else {
      // First load: auto-select the default godown
      const def = _godowns.find(g => g.is_default && g.godown_type !== 'floor' && !g.is_floor);
      if(def) { glLoc.value = String(def.id); onLocationChange(); }
    }
  }
  // Entry forms location selects
  ['ge-godown','fe-godown'].forEach(id => {
    const el = document.getElementById(id); if(!el) return;
    const c = el.value;
    el.innerHTML = '<option value="">— Use global filter —</option>' + opts;
    if(c) el.value = c;
  });
  // GRN and MTV specific selects
  ['grn-godown','mtv-from','mtv-to'].forEach(id => {
    const el = document.getElementById(id); if(!el) return;
    const c = el.value; el.innerHTML = reqOpts; if(c) el.value = c;
  });
  // Opening balance godown selects (add product + import + backfill + edit opening modals)
  ['ap-op-godown','backfill-godown','eop-godown'].forEach(id => {
    const el = document.getElementById(id); if(!el) return;
    const c = el.value;
    el.innerHTML = '<option value="">— Select Godown —</option>' + opts;
    if(c) el.value = c;
  });
}


// ── onLocationChange (originally L309..L324) ─────────────────────────
function onLocationChange() {
  const godownId = document.getElementById('gl-location')?.value || '';
  const badge = document.getElementById('gl-loc-badge');
  if(badge) {
    if(godownId) {
      const g = _godowns.find(x=>String(x.id)===godownId);
      badge.textContent = g ? godownLabel(g) : '';
      badge.style.display = g ? '' : 'none';
    } else { badge.style.display = 'none'; }
  }
  loadSummary();
}

/* ═══════════════════════════════════════════════════════════
   TABS — 7 tabs: stock, combined, grn, mtv, entry, log, products
═══════════════════════════════════════════════════════════ */

// ── switchTab (originally L325..L352) ─────────────────────────
// Set of tabs a requester (FACTORY user) is allowed to access. Anything
// else gets redirected to 'stock' with a friendly toast. The actual UI
// already hides the off-limits sidebar items via {% if not is_requester %}
// blocks; this is a JS-level belt-and-braces in case something (a
// keyboard shortcut, a programmatic call from another module, etc.)
// tries to navigate there anyway.
const _REQUESTER_ALLOWED_TABS = new Set(['stock', 'mm']);

function switchTab(name) {
  // Requester guard. window._isRequester is set inline by the template
  // (see the inline <script> block in pm_stock.html). Admins and
  // fulfiller users have it as false / undefined and pass through.
  if(window._isRequester && !_REQUESTER_ALLOWED_TABS.has(name)){
    if(typeof showToast === 'function'){
      showToast('🔒 That section isn\'t available for requester accounts.', 'info', 2500);
    }
    // Redirect to a tab they CAN see. Prefer Stock unless they were
    // trying to reach Material Movement (where IN scanning lives).
    name = 'stock';
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });
  // Find and activate by onclick content
  document.querySelectorAll('.tab').forEach(t => {
    if(t.getAttribute('onclick') && t.getAttribute('onclick').includes(`'${name}'`))
      t.classList.add('active');
  });
  const panel = document.getElementById('tab-'+name);
  if(panel) { panel.classList.add('active'); panel.style.display = ''; }
  if(name === 'combined')  { loadCombinedPerGodown(); }
  if(name === 'log')       loadLog();
  if(name === 'products')  renderProductTable();
  if(name === 'mm' && typeof mmOnTabActivate === 'function') mmOnTabActivate();
  if(name === 'grn')       { closeGrnForm(); loadVoucherLog(); }
  if(name === 'mtv')       { switchTab('grn'); return; }  // MTV merged into GRN log
  if(name === 'suppliers') loadSuppliers();
  if(name === 'sup-ledger') loadSupLedgerDropdown();
  if(name === 'reports')   initReportsTab();
  if(name === 'adj' && typeof loadAdjList === 'function') loadAdjList();
  if(name === 'trs' && typeof loadTrsList === 'function') loadTrsList();
  if(typeof setSidebarActive === 'function') setSidebarActive(name);
}

/* ═══════════════════════════════════════════════════════════
   PM TYPES
═══════════════════════════════════════════════════════════ */

// ── loadPmTypes (originally L353..L367) ─────────────────────────
async function loadPmTypes() {
  const res = await fetch('/api/pm_stock/pm_types');
  _pmTypes  = await res.json();
  ['sv-pm-type','log-pm-type','prod-pm-type','ct-pm-type','rpt-pm-type'].forEach(id => {
    const sel = document.getElementById(id); if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All PM Types</option>' + _pmTypes.map(t=>`<option value="${t}">${t}</option>`).join('');
    if(cur) sel.value = cur;
  });
  const dl = document.getElementById('ap-pm-list');
  if(dl) dl.innerHTML = _pmTypes.map(t=>`<option value="${t}">`).join('');
  // Load brands
  await loadBrands();
}


// ── loadBrands (originally L368..L397) ─────────────────────────
async function loadBrands() {
  const res = await fetch('/api/pm_stock/brands');
  _brands   = await res.json();
  // Expose for cross-module access (BOM Manager brand combo, etc.) —
  // mirror the pattern used for _products at line 8.
  window._brands = _brands;
  const filterOpts = '<option value="">All Brands</option>' +
    _brands.map(b=>`<option value="${b.id}">${b.name}</option>`).join('');
  const assignOpts = '<option value="">— Assign Brand —</option>' +
    _brands.map(b=>`<option value="${b.id}">${b.name}</option>`).join('');

  // Stock view brand filter
  const svBrand = document.getElementById('sv-brand');
  if(svBrand){ const c=svBrand.value; svBrand.innerHTML=filterOpts; if(c) svBrand.value=c; }

  // Combined total brand filter
  const ctBrand = document.getElementById('ct-brand');
  if(ctBrand){ const c=ctBrand.value; ctBrand.innerHTML=filterOpts; if(c) ctBrand.value=c; }

  // Products tab: filter + assign dropdown
  const pfb = document.getElementById('prod-brand-filter');
  if(pfb){ const c=pfb.value; pfb.innerHTML=filterOpts; if(c) pfb.value=c; }
  const pab = document.getElementById('prod-assign-brand');
  if(pab){ const c=pab.value; pab.innerHTML=assignOpts; if(c) pab.value=c; }

  // Edit product modal brand select — re-populated on open, but seed it now
  const epb = document.getElementById('ep-brand');
  if(epb){ epb.innerHTML='<option value="">— No Brand —</option>'+
    _brands.map(b=>`<option value="${b.id}">${b.name}</option>`).join(''); }
}


// re-render shortcuts called by pagination buttons

// ── regodown (originally L398..L398) ─────────────────────────
function regodown()  { renderSummary(); }

// ── refloor (originally L399..L399) ─────────────────────────
function refloor()   { renderSummary(); }

// ── recombined (originally L400..L400) ─────────────────────────
function recombined(){ renderCombined(); }

// ── relog (originally L401..L401) ─────────────────────────
function relog()     { renderLog(_logRows); }

// ── reprod (originally L402..L402) ─────────────────────────
function reprod()    { renderProductTable(); }

// ── regrn (originally L403..L403) ─────────────────────────
function regrn()     { renderGrnList(_grnRows); }

// ── remtv (originally L404..L408) ─────────────────────────
function remtv()     { renderMtvList(_mtvRows); }

// ── Movement-tab + sidebar grid pagination shims ────────────────────
// Each of these is invoked by renderPag's page-button onclicks (built as
// inline HTML strings inside renderPag, so each shim MUST be a global).
// Each just re-runs its grid's renderer, which reads _pag[gridName].page
// off the global state to know which slice to draw.
//
// Loaders that fetch data and call the renderer (e.g. mmLoadInCompletedList)
// stash the full row list in a global so the shim can re-render without
// re-fetching. Shims are null-safe so they can't crash if data hasn't
// been fetched yet.
function reinTransit()    { if(typeof renderInTransit    === 'function') renderInTransit();    }
function reinCompleted()  { if(typeof renderInCompleted  === 'function') renderInCompleted();  }
function reoutCompleted() { if(typeof renderOutCompleted === 'function') renderOutCompleted(); }
function rerpt()          { if(typeof renderReport      === 'function') renderReport();        }
function rebin()          { if(typeof renderBinList     === 'function') renderBinList();       }
function remyreq()        { if(typeof renderMyReprintReqs      === 'function') renderMyReprintReqs();      }
function repenreq()       { if(typeof renderPendingReprintReqs === 'function') renderPendingReprintReqs(); }
function reopening()      { if(typeof renderOpeningList   === 'function') renderOpeningList(); }
function reidmTxn()       { if(typeof renderIdmTxnList    === 'function') renderIdmTxnList();  }

/* ═══════════════════════════════════════════════════════════
   LOAD SUMMARY — passes godown_id filter
═══════════════════════════════════════════════════════════ */

// ── _getEntryGodownId (originally L1139..L1144) ─────────────────────────
function _getEntryGodownId(prefix) {
  const sel = document.getElementById(prefix+'-godown');
  if(sel && sel.value) return parseInt(sel.value);
  const global = document.getElementById('gl-location');
  return (global && global.value) ? parseInt(global.value) : null;
}

