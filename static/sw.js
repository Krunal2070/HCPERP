// ═══════════════════════════════════════════════════════════════
// HCP PORTAL — Service Worker
// Handles background task reminders every 2 hours
// Even works when the browser tab / window is closed
// ═══════════════════════════════════════════════════════════════

const SW_VERSION      = 'hcp-sw-v1';
const REMIND_INTERVAL = 2 * 60 * 60 * 1000;   // 2 hours in ms
const CHECK_INTERVAL  = 5 * 60 * 1000;         // check every 5 min
const STORAGE_KEY     = 'hcp_sw_last_remind';

// ── Install ───────────────────────────────────────────────────────
self.addEventListener('install', event => {
    self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
    // Start the background check loop
    startReminderLoop();
});

// ── Message from page (register user session) ─────────────────────
self.addEventListener('message', event => {
    const { type, uid, role } = event.data || {};

    if (type === 'REGISTER_USER') {
        // Store user info in SW scope so we know who to remind
        self.currentUID  = uid;
        self.currentRole = role;
        // Immediately check on registration
        checkAndNotify();
    }

    if (type === 'USER_LOGOUT') {
        self.currentUID  = null;
        self.currentRole = null;
        if (self._reminderTimer) {
            clearInterval(self._reminderTimer);
            self._reminderTimer = null;
        }
    }

    if (type === 'TASK_DONE') {
        // Page told us a task was completed — re-check immediately
        checkAndNotify();
    }

    if (type === 'SNOOZE') {
        const snoozeMs = (event.data.minutes || 30) * 60 * 1000;
        // Push last remind time forward so it fires after snooze
        self._lastRemind = Date.now() - REMIND_INTERVAL + snoozeMs;
    }
});

// ── Notification click ────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();

    const action = event.action;
    const taskId = event.notification.data && event.notification.data.taskId;

    if (action === 'done' && taskId) {
        // Mark task done directly from notification action button
        event.waitUntil(
            fetch('/api/task_reminders/toggle_status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: taskId, status: 'Done' })
            }).then(() => {
                checkAndNotify(); // re-check remaining tasks
            }).catch(() => {})
        );
        return;
    }

    if (action === 'snooze') {
        self._lastRemind = Date.now() - REMIND_INTERVAL + (30 * 60 * 1000);
        return;
    }

    // Default click — open the task reminders page
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // Focus existing window if open
            for (const client of clients) {
                if (client.url.includes('/task_reminders') || client.url.includes('/')) {
                    client.focus();
                    client.navigate('/task_reminders');
                    return;
                }
            }
            // Otherwise open new window
            return self.clients.openWindow('/task_reminders');
        })
    );
});

// ── Background reminder loop ──────────────────────────────────────
function startReminderLoop() {
    if (self._reminderTimer) clearInterval(self._reminderTimer);
    self._reminderTimer = setInterval(() => {
        checkAndNotify();
    }, CHECK_INTERVAL);
}

// ── Core check & notify function ─────────────────────────────────
async function checkAndNotify() {
    // Only run for admin/Purchase users
    if (!self.currentUID || !['admin', 'Purchase'].includes(self.currentRole)) return;

    const now  = Date.now();
    const last = self._lastRemind || 0;

    if (now - last < REMIND_INTERVAL) return; // not time yet

    try {
        const res  = await fetch('/api/task_reminders/my_pending', {
            credentials: 'include'   // send session cookie
        });

        if (!res.ok) return;  // session expired / not logged in

        const data = await res.json();
        const tasks = data.tasks || [];

        if (tasks.length === 0) {
            self._lastRemind = now;
            return;
        }

        self._lastRemind = now;

        // Check if page is currently visible — if so, tell page to show popup
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const visibleClient = clients.find(c => c.visibilityState === 'visible');

        if (visibleClient) {
            // Page is open and visible — tell it to show its own popup
            visibleClient.postMessage({ type: 'SHOW_POPUP', tasks });
        }

        // ALWAYS fire Windows toast notifications (even if page is open)
        await fireNotifications(tasks);

    } catch (e) {
        // Network error or session expired — skip silently
    }
}

// ── Fire Windows toast notifications ─────────────────────────────
async function fireNotifications(tasks) {
    const overdueCount = tasks.filter(t => t.is_overdue).length;
    const toShow = tasks.slice(0, 3);

    for (let i = 0; i < toShow.length; i++) {
        const t = toShow[i];
        const priIcon = { Critical:'🔴', High:'🟠', Medium:'🟡', Low:'🟢' }[t.priority] || '📋';

        const bodyParts = [];
        if (t.description)  bodyParts.push(t.description.substring(0, 80));
        if (t.due_date)     bodyParts.push('📅 Due: ' + t.due_date);
        if (t.is_overdue)   bodyParts.push('⚠️ OVERDUE!');
        if (t.assigned_to)  bodyParts.push('👤 ' + t.assigned_to);

        await self.registration.showNotification(
            priIcon + ' HCP Task: ' + t.title,
            {
                body:    bodyParts.join('  ·  ') || 'Tap to open task page',
                icon:    '/static/hcp-icon.png',
                badge:   '/static/hcp-badge.png',
                tag:     'hcp-task-' + t.id,
                renotify: true,                // always re-notify even if same tag
                requireInteraction: true,      // stays until user acts
                data:    { taskId: t.id },
                actions: [
                    { action: 'done',   title: '✓ Mark Done'   },
                    { action: 'snooze', title: '😴 Snooze 30m'  }
                ]
            }
        );

        // Small delay between multiple notifications
        await new Promise(r => setTimeout(r, 800));
    }

    // Summary if more than 3 tasks
    if (tasks.length > 3) {
        await self.registration.showNotification(
            '⏰ HCP — ' + tasks.length + ' Pending Tasks',
            {
                body: (overdueCount > 0 ? '⚠️ ' + overdueCount + ' overdue  ·  ' : '') +
                      'Tap to view all pending tasks',
                icon:  '/static/hcp-icon.png',
                badge: '/static/hcp-badge.png',
                tag:   'hcp-task-summary',
                requireInteraction: true,
                actions: [
                    { action: 'snooze', title: '😴 Snooze 30m' }
                ]
            }
        );
    }
}
