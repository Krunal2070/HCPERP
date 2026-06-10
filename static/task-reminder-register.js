// ═══════════════════════════════════════════════════════════════
// HCP PORTAL — Service Worker Registration
// Include this in index.html and task_reminders.html
// ═══════════════════════════════════════════════════════════════

(function() {
    // Only run for admin / Purchase users (set by Flask template)
    if (typeof HCP_USER === 'undefined') return;
    if (!['admin', 'Purchase'].includes(HCP_USER.role)) return;
    if (!('serviceWorker' in navigator)) {
        console.warn('HCP: Service Workers not supported in this browser');
        return;
    }

    let swRegistration = null;

    // ── 1. Register Service Worker ────────────────────────────────
    async function registerSW() {
        try {
            swRegistration = await navigator.serviceWorker.register('/sw.js', {
                scope: '/'
            });
            console.log('HCP SW registered:', swRegistration.scope);

            // Wait for SW to be active
            if (swRegistration.installing) {
                await new Promise(resolve => {
                    swRegistration.installing.addEventListener('statechange', e => {
                        if (e.target.state === 'activated') resolve();
                    });
                });
            }

            // Tell SW who is logged in
            sendToSW({ type: 'REGISTER_USER', uid: HCP_USER.uid, role: HCP_USER.role });

        } catch (err) {
            console.error('HCP SW registration failed:', err);
        }
    }

    // ── 2. Request notification permission ───────────────────────
    async function requestPermission() {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission === 'granted') return 'granted';
        if (Notification.permission === 'denied')  return 'denied';

        const result = await Notification.requestPermission();
        return result;
    }

    // ── 3. Send message to Service Worker ────────────────────────
    function sendToSW(message) {
        if (!navigator.serviceWorker.controller) return;
        navigator.serviceWorker.controller.postMessage(message);
    }

    // ── 4. Listen for SW messages (show popup) ───────────────────
    navigator.serviceWorker.addEventListener('message', event => {
        const { type, tasks } = event.data || {};
        if (type === 'SHOW_POPUP' && tasks && tasks.length > 0) {
            // SW is telling us to show the in-page popup
            if (typeof showHCPReminderPopup === 'function') {
                showHCPReminderPopup(tasks);
            }
        }
    });

    // ── 5. Expose helper for snooze/done actions from page ───────
    window.HCP_SW = {
        snooze: function(minutes) {
            sendToSW({ type: 'SNOOZE', minutes: minutes || 30 });
        },
        taskDone: function(id) {
            sendToSW({ type: 'TASK_DONE', id: id });
        },
        logout: function() {
            sendToSW({ type: 'USER_LOGOUT' });
        }
    };

    // ── 6. Boot ───────────────────────────────────────────────────
    async function boot() {
        const permission = await requestPermission();

        if (permission === 'granted') {
            await registerSW();
        } else if (permission === 'denied') {
            console.warn('HCP: Notifications denied — SW reminders will not fire');
        } else {
            // User dismissed — still register SW but without notifications
            await registerSW();
        }
    }

    // Run after DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
