/* portal.js — HCP Portal Shared Scripts */

// ── Theme ──────────────────────────────────────────
const THEMES = ['light','dark','ocean','rose','slate'];
const THEME_ICONS = { light:'☀️', dark:'🌙', ocean:'🌊', rose:'🌸', slate:'🪨' };

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('hcp_theme', t);
  const btn = document.getElementById('themeIcon');
  if (btn) btn.textContent = THEME_ICONS[t] || '🎨';
}

function initTheme() {
  applyTheme(localStorage.getItem('hcp_theme') || 'light');
}

function cycleTheme() {
  const cur = localStorage.getItem('hcp_theme') || 'light';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
}

// Theme menu
document.addEventListener('click', e => {
  const opt = e.target.closest('.theme-opt');
  if (opt) { applyTheme(opt.dataset.theme); closeThemeMenu(); return; }

  const btn = e.target.closest('#themeToggleBtn');
  if (btn) { toggleThemeMenu(); return; }

  // close menus if clicking outside
  if (!e.target.closest('.theme-dropdown')) closeThemeMenu();
});

function toggleThemeMenu() {
  document.getElementById('themeMenu')?.classList.toggle('open');
}
function closeThemeMenu() {
  document.getElementById('themeMenu')?.classList.remove('open');
}

// ── Sidebar ────────────────────────────────────────
function initSidebar() {
  const ham = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!ham || !sidebar) return;

  ham.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay?.addEventListener('click', closeSidebar);
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('open');
}

// ── Modals ─────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('open'); document.body.style.overflow = ''; }
}
// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
    document.body.style.overflow = '';
  }
  const closer = e.target.closest('[data-close-modal]');
  if (closer) closeModal(closer.dataset.closeModal);
});
// Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.classList.remove('open'); document.body.style.overflow = '';
    });
  }
});

// ── Toast ──────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; toast.style.transition = '0.3s'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ── Table search/filter ────────────────────────────
function initTableSearch(inputId, tableId) {
  const inp = document.getElementById(inputId);
  const tbl = document.getElementById(tableId);
  if (!inp || !tbl) return;
  inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase();
    tbl.querySelectorAll('tbody tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

// ── Column filter inputs ───────────────────────────
function initColumnFilters(tableId) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  tbl.querySelectorAll('.th-filter input, .th-filter select').forEach((inp, idx) => {
    inp.addEventListener('input', () => filterTable(tbl));
  });
}
function filterTable(tbl) {
  const filterInputs = [...tbl.querySelectorAll('.th-filter input, .th-filter select')];
  const rows = tbl.querySelectorAll('tbody tr');
  rows.forEach(row => {
    const cells = [...row.querySelectorAll('td')];
    const show = filterInputs.every((inp, i) => {
      if (!inp.value) return true;
      const cell = cells[i];
      return cell && cell.textContent.toLowerCase().includes(inp.value.toLowerCase());
    });
    row.style.display = show ? '' : 'none';
  });
}

// ── Pagination ─────────────────────────────────────
function initPagination(tableId, pageSize = 15) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  const bar = tbl.closest('.card')?.querySelector('.page-btns');
  const info = tbl.closest('.card')?.querySelector('.page-info');
  let page = 1;

  function render() {
    const rows = [...tbl.querySelectorAll('tbody tr')].filter(r => r.style.display !== 'none');
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, pages);
    rows.forEach((r, i) => r.style.display = (i >= (page-1)*pageSize && i < page*pageSize) ? '' : 'none');
    if (info) info.textContent = `Showing ${Math.min((page-1)*pageSize+1,total)}–${Math.min(page*pageSize,total)} of ${total}`;
    if (bar) {
      bar.innerHTML = '';
      if (page > 1) addPageBtn(bar, '‹', () => { page--; render(); });
      for (let p = 1; p <= pages; p++) {
        if (pages > 7 && Math.abs(p - page) > 2 && p !== 1 && p !== pages) { if (p === 2 || p === pages-1) bar.innerHTML += '<span style="padding:5px 3px;color:var(--hmuted)">…</span>'; continue; }
        addPageBtn(bar, p, () => { page = p; render(); }, p === page);
      }
      if (page < pages) addPageBtn(bar, '›', () => { page++; render(); });
    }
  }
  function addPageBtn(bar, label, onClick, active = false) {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.onclick = onClick;
    bar.appendChild(btn);
  }
  render();
  // Re-render on filter change
  const observer = new MutationObserver(render);
  tbl.querySelectorAll('tbody tr').forEach(r => observer.observe(r, { attributes: true, attributeFilter: ['style'] }));
}

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSidebar();
});
