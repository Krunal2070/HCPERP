/* ═══════════════════════════════════════════════════════════════════════════
   HCP NotebookLM Theme — Companion JavaScript
   ─────────────────────────────────────────────────────────────────────────
   Adds interactive animations that CSS alone can't do:
     • Click ripple effect (Material-style expanding circle on click)
     • Subtle 3D tilt parallax on cards (rotation toward cursor)
     • Scroll-triggered reveal for cards below the fold
     • MutationObserver — auto-wires animations to dynamically added elements

   Usage:
     <script src="/static/hcp-notebooklm.js" defer></script>

   What it targets:
     .nb-card           → ripple + tilt + scroll-reveal
     .stat-card         → ripple + tilt
     .filter-chip       → ripple
     .nb-chip           → ripple
     .nb-btn            → ripple (if not [data-no-ripple])

   The script is theme-aware: animations only run when data-theme="light".
   Switching to dark/midnight/ocean/sage automatically suppresses them.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── Helpers ─────────────────────────────────────────────────────────────
    var isLight = function () {
        return document.documentElement.getAttribute('data-theme') === 'light';
    };
    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var isTouchOnly = window.matchMedia('(hover: none)').matches;

    // ── 1. Click ripple ─────────────────────────────────────────────────────
    function attachRipple(el, color) {
        if (el.dataset.nbRipple === 'attached') return;
        el.dataset.nbRipple = 'attached';

        el.addEventListener('click', function (e) {
            if (!isLight()) return;
            var rect = this.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var y = e.clientY - rect.top;
            var r = document.createElement('span');
            r.style.cssText =
                'position:absolute;left:' + x + 'px;top:' + y + 'px;' +
                'width:8px;height:8px;border-radius:50%;' +
                'background:' + color + ';' +
                'transform:translate(-50%,-50%) scale(0);' +
                'pointer-events:none;z-index:5;' +
                'transition:transform .6s cubic-bezier(.22,1,.36,1),opacity .6s;';
            // Make sure parent can host an absolutely positioned child
            if (getComputedStyle(this).position === 'static') {
                this.style.position = 'relative';
            }
            // Don't let ripple visually spill out of rounded containers
            if (getComputedStyle(this).overflow === 'visible') {
                this.style.overflow = 'hidden';
            }
            this.appendChild(r);
            requestAnimationFrame(function () {
                r.style.transform = 'translate(-50%,-50%) scale(60)';
                r.style.opacity = '0';
            });
            setTimeout(function () { if (r.parentNode) r.remove(); }, 600);
        });
    }

    // ── 2. 3D tilt parallax ─────────────────────────────────────────────────
    function attachTilt(el, maxDeg) {
        if (prefersReducedMotion || isTouchOnly) return;
        if (el.dataset.nbTilt === 'attached') return;
        el.dataset.nbTilt = 'attached';

        var max = maxDeg || 4;
        var rafId = null;

        el.addEventListener('mousemove', function (e) {
            if (!isLight()) return;
            var rect = this.getBoundingClientRect();
            var x = (e.clientX - rect.left) / rect.width  - 0.5;
            var y = (e.clientY - rect.top)  / rect.height - 0.5;
            var self = this;
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(function () {
                // Don't clobber lift transforms — combine them
                var lift = self.classList.contains('nb-card') ? -5 : -4;
                self.style.transform =
                    'translateY(' + lift + 'px) ' +
                    'perspective(800px) ' +
                    'rotateY(' + (x * max) + 'deg) ' +
                    'rotateX(' + (-y * max) + 'deg)';
            });
        });
        el.addEventListener('mouseleave', function () {
            cancelAnimationFrame(rafId);
            this.style.transform = '';
        });
    }

    // ── 3. Scroll-triggered reveal ──────────────────────────────────────────
    function attachScrollReveal(els) {
        if (!('IntersectionObserver' in window)) return;
        if (prefersReducedMotion) return;

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0) scale(1)';
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });

        els.forEach(function (el) {
            var rect = el.getBoundingClientRect();
            // Only handle cards that started off-screen
            if (rect.top > window.innerHeight && el.dataset.nbReveal !== 'attached') {
                el.dataset.nbReveal = 'attached';
                el.style.opacity = '0';
                el.style.transform = 'translateY(20px) scale(.97)';
                el.style.transition =
                    'opacity .55s cubic-bezier(.22,1,.36,1),' +
                    'transform .55s cubic-bezier(.22,1,.36,1)';
                el.style.animation = 'none';
                observer.observe(el);
            }
        });
    }

    // ── 4. Wire up everything for a given root ──────────────────────────────
    function wireUp(root) {
        root = root || document;

        var nbCards    = root.querySelectorAll ? root.querySelectorAll('.nb-card')     : [];
        var statCards  = root.querySelectorAll ? root.querySelectorAll('.stat-card')   : [];
        var chips      = root.querySelectorAll ? root.querySelectorAll('.filter-chip, .nb-chip') : [];
        var buttons    = root.querySelectorAll ? root.querySelectorAll('.nb-btn:not([data-no-ripple])') : [];

        nbCards.forEach(function (c) {
            attachRipple(c, 'rgba(26,115,232,.35)');
            attachTilt(c, 4);
        });
        statCards.forEach(function (c) {
            attachRipple(c, 'rgba(26,115,232,.35)');
            attachTilt(c, 3.5);
        });
        chips.forEach(function (c) {
            attachRipple(c, 'rgba(26,115,232,.25)');
        });
        buttons.forEach(function (b) {
            attachRipple(b, 'rgba(255,255,255,.4)');
        });

        // Scroll-reveal applies to grids of nb-card or stat-card
        var revealables = [];
        nbCards.forEach(function (c) { revealables.push(c); });
        statCards.forEach(function (c) { revealables.push(c); });
        attachScrollReveal(revealables);
    }

    // ── 5. Initial setup ────────────────────────────────────────────────────
    function init() { wireUp(document); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ── 6. Watch for dynamically added elements ─────────────────────────────
    // Many pages re-render stat cards or filter chips after filtering/loading.
    // This makes sure new ones get the same animations.
    if ('MutationObserver' in window) {
        var observerRoot = document.body;
        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return; // element nodes only
                    // Did this new node itself match? Or contain matches?
                    var matchesSelf =
                        node.matches && node.matches('.nb-card, .stat-card, .filter-chip, .nb-chip, .nb-btn');
                    if (matchesSelf || (node.querySelectorAll && (
                            node.querySelectorAll('.nb-card, .stat-card, .filter-chip, .nb-chip, .nb-btn').length > 0
                        ))) {
                        wireUp(node);
                    }
                });
            });
        }).observe(observerRoot, { childList: true, subtree: true });
    }

    // ── 7. Public API (in case a page wants to manually re-trigger) ─────────
    window.HCPNotebookLM = {
        rewire: wireUp,
        attachRipple: attachRipple,
        attachTilt: attachTilt
    };
})();
