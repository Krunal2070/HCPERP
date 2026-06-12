/*!
 * HCP themed modal — native alert()/confirm() ki jagah.
 * - confirmModal(title, msg, okLabel, kind, onOk)  : Cancel + OK
 * - cmAlert(msg, title?)                           : sirf OK
 * - cmConfirm(msg, onOk, okLabel?, kind?)          : shortcut
 * - window.alert override -> saare purane alert() calls auto-modal
 * Self-contained: CSS khud inject karta hai, kisi page-CSS pe depend nahi.
 */
(function () {
  'use strict';

  /* ── styles (ek hi baar) ── */
  if (!document.getElementById('hcpModalCss')) {
    var st = document.createElement('style');
    st.id = 'hcpModalCss';
    st.textContent = ''
      + '.cm-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.45);'
      + 'display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .18s;'
      + 'backdrop-filter:blur(2px);padding:18px}'
      + '.cm-overlay.show{opacity:1}'
      + '.cm-box{width:380px;max-width:100%;background:var(--surface,#fff);color:var(--text,#0f172a);'
      + 'border:1px solid var(--border,#e2e8f0);border-radius:16px;'
      + 'box-shadow:0 22px 60px rgba(0,0,0,.28);padding:22px;text-align:center;'
      + 'transform:scale(.94);transition:transform .18s;font-family:inherit}'
      + '.cm-overlay.show .cm-box{transform:scale(1)}'
      + '.cm-title{font-size:1.02rem;font-weight:800;margin-bottom:6px}'
      + '.cm-msg{font-size:.84rem;color:var(--muted2,#64748b);margin-bottom:18px;word-break:break-word}'
      + '.cm-actions{display:flex;gap:10px;justify-content:center}'
      + '.cm-btn{height:40px;padding:0 22px;border-radius:10px;font-size:.85rem;font-weight:700;'
      + 'font-family:inherit;cursor:pointer;border:1px solid var(--border2,#cbd5e1);'
      + 'background:var(--surface,#fff);color:var(--text,#0f172a)}'
      + '.cm-btn.primary{background:#0d9488;border-color:#0d9488;color:#fff}'
      + '.cm-btn.purple{background:#7c3aed;border-color:#7c3aed;color:#fff}'
      + '.cm-btn.danger{background:#dc2626;border-color:#dc2626;color:#fff}';
    document.head.appendChild(st);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = (s === undefined || s === null) ? '' : String(s);
    return d.innerHTML;
  }

  /* ── core ── */
  function confirmModal(title, msg, okLabel, kind, onOk, alertMode) {
    var ov = document.createElement('div');
    ov.className = 'cm-overlay';
    ov.innerHTML = '<div class="cm-box">'
      + '<div class="cm-title">' + esc(title) + '</div>'
      + '<div class="cm-msg">' + esc(msg) + '</div>'
      + '<div class="cm-actions">'
      + (alertMode ? '' : '<button type="button" class="cm-btn cm-cancel">Cancel</button>')
      + '<button type="button" class="cm-btn cm-ok ' + (kind || 'primary') + '">'
      + esc(okLabel || 'OK') + '</button></div></div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    function close() {
      ov.classList.remove('show');
      setTimeout(function () { ov.remove(); }, 200);
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    var cancel = ov.querySelector('.cm-cancel');
    if (cancel) cancel.onclick = close;
    ov.querySelector('.cm-ok').onclick = function () { close(); if (onOk) onOk(); };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', onEsc);
    ov.querySelector('.cm-ok').focus();
  }

  function cmAlert(msg, title) {
    confirmModal(title || 'Notice', msg, 'OK', 'primary', null, true);
  }
  function cmConfirm(msg, onOk, okLabel, kind) {
    confirmModal('Confirm', msg, okLabel || 'OK', kind || 'danger', onOk);
  }

  /* expose (pehle se defined ho to override mat karo — e.g. leads.html ka local) */
  if (!window.confirmModal) window.confirmModal = confirmModal;
  if (!window.cmAlert) window.cmAlert = cmAlert;
  if (!window.cmConfirm) window.cmConfirm = cmConfirm;

  /* native alert -> themed modal (drop-in; return value kisi ko nahi chahiye) */
  window.alert = function (msg) { cmAlert(msg); };
})();
