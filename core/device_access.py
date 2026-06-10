"""
device_access.py — Device Access Control module
=================================================

Cookie-based device allowlist for hcperp.co.in.

What it does
------------
* Issues a long-lived `hcp_device_id` cookie on first visit
* Server-side allowlist: only approved devices can log in
* Admin-only KPI card on the index page opens a 4-tab modal (Pending /
  Approved / Settings / Revoked) for approving and managing devices
* Smart auto-approval when a new cookie matches a recently-approved
  device of the same user (same IP + similar browser/OS)
* Recovery codes: each approved device gets a one-time code so the user
  can re-approve themselves after a browser reinstall or device wipe
* Master ON/OFF toggle so admin can disable the whole check anytime
* Bypass usernames list (e.g. 'admin', 'sonal') that always skip the check
* Confirmation phrase required for sensitive settings changes
* Audit log of every approve/revoke/settings change

How to wire it in (already done in the app.py we'll ship):

    from device_access import (
        device_access_bp,
        ensure_device_access_tables,
        device_check_at_login,
        get_or_issue_device_cookie,
        get_admin_dashboard_context,
    )
    app.register_blueprint(device_access_bp)
    # Tables are created lazily on first use, not at import.
"""

from flask import (
    Blueprint, request, jsonify, session, render_template, make_response,
    redirect, url_for
)
from functools import wraps
import secrets
import hashlib
import json
import sys as _sys
import re
from datetime import datetime, timedelta

import sampling_portal

device_access_bp = Blueprint('device_access', __name__)

COOKIE_NAME = 'hcp_device_id'
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2   # 2 years
CONFIRMATION_PHRASE = 'I understand this bypasses device security'
DEFAULT_BYPASS_USERNAMES = ['admin', 'sonal']
GRANDFATHER_DAYS = 30
AUDIT_LOG_MAX = 200


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _now():
    return datetime.now()

def _now_iso():
    return _now().strftime('%Y-%m-%d %H:%M:%S')

def _gen_device_id():
    """Long random cookie value — 32 chars urlsafe."""
    return secrets.token_urlsafe(24)

def _gen_recovery_code():
    """User-facing recovery code, e.g. HCP-7K2M-9X4P (uppercase, no ambiguous chars)."""
    alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    a = ''.join(secrets.choice(alphabet) for _ in range(4))
    b = ''.join(secrets.choice(alphabet) for _ in range(4))
    return f'HCP-{a}-{b}'

def _hash_code(code):
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()

def _client_ip():
    """Get the real client IP, honouring nginx's X-Forwarded-For."""
    xff = request.headers.get('X-Forwarded-For', '')
    if xff:
        return xff.split(',')[0].strip()
    return request.remote_addr or ''

def _parse_ua(ua_string):
    """Cheap browser/OS detection — good enough for labelling. Returns (kind, browser, os)."""
    ua = (ua_string or '').lower()
    # kind
    if any(t in ua for t in ['ipad', 'tablet']):
        kind = 'tablet'
    elif any(t in ua for t in ['iphone', 'android', 'mobile']):
        kind = 'mobile'
    else:
        kind = 'desktop'
    # browser
    if 'edg/' in ua:        browser = 'Edge'
    elif 'opr/' in ua or 'opera' in ua: browser = 'Opera'
    elif 'chrome/' in ua and 'safari/' in ua: browser = 'Chrome'
    elif 'firefox/' in ua:  browser = 'Firefox'
    elif 'safari/' in ua:   browser = 'Safari'
    else:                   browser = 'Other'
    # os
    if 'windows nt 10' in ua or 'windows nt 11' in ua: os_ = 'Windows'
    elif 'windows' in ua:   os_ = 'Windows'
    elif 'mac os x' in ua or 'macintosh' in ua: os_ = 'macOS'
    elif 'iphone' in ua or 'ipad' in ua or 'ipod' in ua: os_ = 'iOS'
    elif 'android' in ua:   os_ = 'Android'
    elif 'linux' in ua:     os_ = 'Linux'
    else:                   os_ = 'Other'
    return kind, browser, os_

def _row_to_dict(row, cursor=None):
    """Normalize a DB row to a plain dict — mirrors user_admin._row_to_dict."""
    if row is None: return {}
    if isinstance(row, dict): return dict(row)
    try: return {k: row[k] for k in row.keys()}
    except Exception: pass
    if cursor is not None and getattr(cursor, 'description', None):
        cols = [c[0] for c in cursor.description]
        return {cols[i]: row[i] for i in range(min(len(cols), len(row)))}
    return {}

def _rows(cursor):
    rows = cursor.fetchall()
    return [_row_to_dict(r, cursor) for r in rows]

def _one(cursor):
    return _row_to_dict(cursor.fetchone(), cursor)


# ─────────────────────────────────────────────────────────────────────────────
# Schema bootstrap (idempotent, lazy)
# ─────────────────────────────────────────────────────────────────────────────
_tables_ready = {'done': False}

def ensure_device_access_tables():
    """Create the two tables if missing. Idempotent. Lazy — called from
    device_check_at_login() and the admin endpoints, never at import time."""
    if _tables_ready['done']:
        return
    conn = sampling_portal.get_db_connection()
    if not conn:
        print('[device_access] no DB connection during ensure_tables', file=_sys.stderr)
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS device_registry (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                user_id         INT          NOT NULL,
                username        VARCHAR(100) DEFAULT '',
                device_id       VARCHAR(64)  NOT NULL,
                kind            VARCHAR(16)  DEFAULT 'desktop',
                browser         VARCHAR(50)  DEFAULT '',
                os              VARCHAR(50)  DEFAULT '',
                ua_string       VARCHAR(500) DEFAULT '',
                ip_address      VARCHAR(45)  DEFAULT '',
                mac_label       VARCHAR(50)  DEFAULT '',
                status          VARCHAR(20)  DEFAULT 'pending',
                recovery_hash   VARCHAR(128) DEFAULT '',
                recovery_used_at DATETIME    NULL,
                requested_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
                approved_at     DATETIME     NULL,
                approved_by     VARCHAR(100) DEFAULT '',
                revoked_at      DATETIME     NULL,
                revoked_by      VARCHAR(100) DEFAULT '',
                last_seen_at    DATETIME     NULL,
                note            VARCHAR(500) DEFAULT '',
                UNIQUE KEY uq_device_user (user_id, device_id),
                KEY idx_device_status (status),
                KEY idx_device_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception as e:
        print(f'[device_access] device_registry create failed: {e}', file=_sys.stderr)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS device_access_settings (
                k VARCHAR(64) PRIMARY KEY,
                v TEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception as e:
        print(f'[device_access] settings create failed: {e}', file=_sys.stderr)
    # login_audit table — one row per login / logout / failed-login event
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS login_audit (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                ts              DATETIME     DEFAULT CURRENT_TIMESTAMP,
                user_id         INT          NULL,
                username        VARCHAR(100) DEFAULT '',
                event_type      VARCHAR(32)  DEFAULT 'login_success',
                ip_address      VARCHAR(45)  DEFAULT '',
                device_id_short VARCHAR(32)  DEFAULT '',
                browser         VARCHAR(50)  DEFAULT '',
                os              VARCHAR(50)  DEFAULT '',
                kind            VARCHAR(16)  DEFAULT '',
                session_token   VARCHAR(32)  DEFAULT '',
                fail_reason     VARCHAR(200) DEFAULT '',
                logout_ts       DATETIME     NULL,
                KEY idx_audit_ts (ts),
                KEY idx_audit_user (username),
                KEY idx_audit_event (event_type),
                KEY idx_audit_session (session_token)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception as e:
        print(f'[device_access] login_audit create failed: {e}', file=_sys.stderr)
    # Seed default settings
    try:
        for k, v in [
            ('device_check_enabled', 'true'),
            ('auto_approve_enabled', 'true'),
            ('bypass_usernames', json.dumps(DEFAULT_BYPASS_USERNAMES)),
            ('audit_log', json.dumps([])),
            ('inactivity_lock_days', '10'),    # 0 disables auto-lock
            ('login_audit_retain_months', '12'),  # 0 = keep forever
            ('single_session_only', 'false'),  # if true, new login kicks out previous session
        ]:
            conn.execute(
                "INSERT IGNORE INTO device_access_settings (k, v) VALUES (%s, %s)",
                (k, v)
            )
        conn.commit()
    except Exception as e:
        print(f'[device_access] settings seed failed: {e}', file=_sys.stderr)

    # Grandfather devices that logged in in the last N days. We only do this once,
    # the first time the table is empty — so we don't keep re-grandfathering.
    try:
        cur = conn.execute("SELECT COUNT(*) AS n FROM device_registry")
        count = _one(cur).get('n') or 0
        if int(count) == 0:
            cutoff = (_now() - timedelta(days=GRANDFATHER_DAYS)).strftime('%Y-%m-%d %H:%M:%S')
            cur = conn.execute(
                "SELECT id, username, last_login FROM `User_Tbl` "
                "WHERE last_login IS NOT NULL AND last_login >= %s",
                (cutoff,)
            )
            grandfathered = _rows(cur)
            for u in grandfathered:
                dev_id = _gen_device_id()
                conn.execute("""
                    INSERT INTO device_registry
                        (user_id, username, device_id, kind, browser, os,
                         ip_address, status, requested_at, approved_at, approved_by,
                         last_seen_at, note)
                    VALUES (%s,%s,%s,'desktop','','','','approved', NOW(), NOW(),
                            'system-grandfather', %s, 'Grandfathered on rollout')
                """, (u['id'], u.get('username') or '', dev_id, u.get('last_login')))
            conn.commit()
            _audit_log_append({
                'action': 'grandfather_rollout',
                'by': 'system',
                'count': len(grandfathered),
            })
    except Exception as e:
        print(f'[device_access] grandfather skipped: {e}', file=_sys.stderr)

    _tables_ready['done'] = True
    # Add the lock columns on User_Tbl (idempotent, only adds if missing).
    try:
        ensure_lock_columns()
    except Exception as e:
        print(f'[device_access] ensure_lock_columns failed: {e}', file=_sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# Settings (read/write)
# ─────────────────────────────────────────────────────────────────────────────
def _get_setting(key, default=None):
    ensure_device_access_tables()
    conn = sampling_portal.get_db_connection()
    if not conn: return default
    try:
        cur = conn.execute(
            "SELECT v FROM device_access_settings WHERE k=%s", (key,)
        )
        row = _one(cur)
        if not row: return default
        return row.get('v', default)
    except Exception as e:
        print(f'[device_access] _get_setting({key}) failed: {e}', file=_sys.stderr)
        return default

def _set_setting(key, value):
    ensure_device_access_tables()
    conn = sampling_portal.get_db_connection()
    if not conn: return False
    try:
        conn.execute("""
            INSERT INTO device_access_settings (k, v) VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE v=VALUES(v)
        """, (key, str(value)))
        conn.commit()
        return True
    except Exception as e:
        print(f'[device_access] _set_setting({key}) failed: {e}', file=_sys.stderr)
        return False

def _check_enabled():
    return (_get_setting('device_check_enabled', 'true') or '').strip().lower() == 'true'

def _auto_approve_enabled():
    return (_get_setting('auto_approve_enabled', 'true') or '').strip().lower() == 'true'

def _bypass_usernames():
    raw = _get_setting('bypass_usernames', json.dumps(DEFAULT_BYPASS_USERNAMES))
    try:
        lst = json.loads(raw)
        return [str(x).strip().lower() for x in lst if str(x).strip()]
    except Exception:
        return [u.lower() for u in DEFAULT_BYPASS_USERNAMES]

def _is_bypass(username):
    return (username or '').strip().lower() in _bypass_usernames()


def _inactivity_lock_days():
    """How many days of inactivity before auto-lock. 0 disables the feature."""
    try:
        v = int((_get_setting('inactivity_lock_days', '10') or '10').strip())
        return max(0, v)
    except Exception:
        return 10


def inactivity_check_at_login(user_record):
    """Run AFTER password verification, BEFORE the device check.

    Returns:
      ('ok',     None)                        — proceed with login
      ('locked', {'days', 'already_locked'})  — refuse with message

    Behaviour:
      - Any admin (user_type='admin') is exempt — never auto-locks.
      - If inactivity_lock_days is 0, feature disabled — proceed.
      - If is_locked column is already 1, refuse immediately.
      - Else, if last_login is older than threshold, set is_locked=1 and refuse.
      - First-ever login (last_login NULL) is allowed.
    """
    # Admin exemption
    if (user_record.get('user_type') or '').strip().lower() == 'admin':
        return ('ok', None)

    days = _inactivity_lock_days()
    if days <= 0:
        return ('ok', None)

    # If already locked (column might not exist on older installs — handle gracefully)
    already_locked = False
    try:
        already_locked = int(user_record.get('is_locked') or 0) == 1
    except Exception:
        already_locked = False

    if already_locked:
        # Show how many days it's been (best effort)
        elapsed = days
        try:
            ll = user_record.get('last_login')
            if ll:
                if isinstance(ll, str):
                    ll = datetime.strptime(ll, '%Y-%m-%d %H:%M:%S')
                elapsed = max(days, (datetime.now() - ll).days)
        except Exception:
            pass
        return ('locked', {'days': elapsed, 'already_locked': True})

    # Compute inactivity
    ll = user_record.get('last_login')
    if not ll:
        return ('ok', None)   # never logged in — let them in
    try:
        if isinstance(ll, str):
            ll = datetime.strptime(ll, '%Y-%m-%d %H:%M:%S')
        elapsed_days = (datetime.now() - ll).days
    except Exception:
        return ('ok', None)

    if elapsed_days <= days:
        return ('ok', None)

    # Inactive too long — set is_locked=1
    try:
        conn = sampling_portal.get_db_connection()
        if conn:
            conn.execute(
                "UPDATE `User_Tbl` SET is_locked=1, locked_at=NOW() WHERE id=%s",
                (user_record['id'],)
            )
            conn.commit()
    except Exception as e:
        print(f'[device_access] mark locked failed: {e}', file=_sys.stderr)
    _audit_log_append({
        'action': 'auto_lock',
        'user': user_record.get('username') or '',
        'days': elapsed_days,
        'reason': f'{elapsed_days} days since last_login',
    })
    return ('locked', {'days': elapsed_days, 'already_locked': False})


def admin_unlock_user(user_id, admin_username):
    """Admin clears is_locked on a user. Returns (ok, message)."""
    ensure_device_access_tables()
    conn = sampling_portal.get_db_connection()
    if not conn:
        return False, 'Database unavailable.'
    try:
        cur = conn.execute(
            "SELECT username FROM `User_Tbl` WHERE id=%s", (user_id,)
        )
        u = _one(cur)
        if not u:
            return False, 'User not found.'
        conn.execute(
            "UPDATE `User_Tbl` SET is_locked=0, locked_at=NULL WHERE id=%s",
            (user_id,)
        )
        conn.commit()
        _audit_log_append({
            'action': 'admin_unlock',
            'by': admin_username,
            'user': u.get('username') or '',
        })
        return True, f"Unlocked {u.get('username') or 'user'}."
    except Exception as e:
        print(f'[device_access] admin_unlock failed: {e}', file=_sys.stderr)
        return False, 'Unlock failed.'


# ─────────────────────────────────────────────────────────────────────────────
# Single-session-only feature
# ─────────────────────────────────────────────────────────────────────────────
def single_session_enabled():
    """True if 'one login per user' enforcement is on."""
    return (_get_setting('single_session_only', 'false') or '').strip().lower() == 'true'


def set_active_session_token(user_id, token):
    """Stamp a new active-session token onto the user row. Called on each
    successful login. Any previous session token is invalidated by overwrite."""
    try:
        ensure_device_access_tables()
        conn = sampling_portal.get_db_connection()
        if not conn: return False
        conn.execute(
            "UPDATE `User_Tbl` SET active_session_token=%s WHERE id=%s",
            (token or '', user_id)
        )
        conn.commit()
        return True
    except Exception as e:
        print(f'[device_access] set_active_session_token failed: {e}', file=_sys.stderr)
        return False


def is_session_token_current(user_id, token):
    """Return True if the supplied token matches what's stored for this user.
    Returns True (allow) on DB errors so a glitch doesn't lock everyone out."""
    try:
        if not user_id or not token:
            return False
        conn = sampling_portal.get_db_connection()
        if not conn: return True
        cur = conn.execute(
            "SELECT active_session_token FROM `User_Tbl` WHERE id=%s", (user_id,)
        )
        row = _one(cur)
        if not row: return True
        stored = (row.get('active_session_token') or '').strip()
        if not stored:
            # Column may be empty for users who logged in before this feature
            # was enabled. Treat as current to avoid kicking them off.
            return True
        return stored == token
    except Exception as e:
        print(f'[device_access] is_session_token_current failed: {e}', file=_sys.stderr)
        return True


def clear_active_session_token(user_id):
    """Clear the user's active-session token (called on logout)."""
    try:
        conn = sampling_portal.get_db_connection()
        if not conn: return
        conn.execute(
            "UPDATE `User_Tbl` SET active_session_token='' WHERE id=%s",
            (user_id,)
        )
        conn.commit()
    except Exception as e:
        print(f'[device_access] clear_active_session_token failed: {e}', file=_sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# Login / logout audit log
# ─────────────────────────────────────────────────────────────────────────────
def _retain_months():
    """How many months of login audit to keep. 0 = forever."""
    try:
        return max(0, int((_get_setting('login_audit_retain_months', '12') or '12').strip()))
    except Exception:
        return 12


def _purge_old_audit():
    """Best-effort purge of rows older than retention window. Runs on the
    fetch path so we don't need a cron — at worst it's a noop."""
    months = _retain_months()
    if months <= 0:
        return
    try:
        conn = sampling_portal.get_db_connection()
        if not conn: return
        # Use INTERVAL because months is server-side computed
        conn.execute(
            "DELETE FROM login_audit WHERE ts < (NOW() - INTERVAL %s MONTH)",
            (months,)
        )
        conn.commit()
    except Exception as e:
        print(f'[device_access] purge_old_audit failed: {e}', file=_sys.stderr)


def log_login_event(event_type, user_record=None, username=None,
                    fail_reason='', session_token=''):
    """Insert a row in login_audit. Always silent — must never break login."""
    try:
        ensure_device_access_tables()
        conn = sampling_portal.get_db_connection()
        if not conn: return
        ua = request.headers.get('User-Agent', '') if request else ''
        kind, browser, os_ = _parse_ua(ua)
        ip = _client_ip() if request else ''
        did = ''
        try:
            full = request.cookies.get(COOKIE_NAME) if request else ''
            if full and len(full) > 12:
                did = full[:8] + '…' + full[-4:]
            elif full:
                did = full
        except Exception:
            did = ''
        uname = (user_record.get('username') if user_record else None) or username or ''
        uid = (user_record.get('id') if user_record else None) or None
        conn.execute("""
            INSERT INTO login_audit
              (ts, user_id, username, event_type, ip_address, device_id_short,
               browser, os, kind, session_token, fail_reason)
            VALUES (NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (uid, uname, event_type, ip, did, browser, os_, kind,
              session_token or '', (fail_reason or '')[:200]))
        conn.commit()
    except Exception as e:
        print(f'[device_access] log_login_event failed: {e}', file=_sys.stderr)


def log_logout_event(username, session_token=''):
    """Insert a logout row AND mark the paired login row's logout_ts so the
    admin UI can show 'login → logout' as a session."""
    try:
        ensure_device_access_tables()
        conn = sampling_portal.get_db_connection()
        if not conn: return
        ua = request.headers.get('User-Agent', '') if request else ''
        kind, browser, os_ = _parse_ua(ua)
        ip = _client_ip() if request else ''
        conn.execute("""
            INSERT INTO login_audit
              (ts, username, event_type, ip_address, browser, os, kind, session_token)
            VALUES (NOW(), %s, 'logout', %s, %s, %s, %s, %s)
        """, (username or '', ip, browser, os_, kind, session_token or ''))
        if session_token:
            conn.execute("""
                UPDATE login_audit SET logout_ts=NOW()
                WHERE session_token=%s AND event_type='login_success' AND logout_ts IS NULL
                ORDER BY ts DESC LIMIT 1
            """, (session_token,))
        conn.commit()
    except Exception as e:
        print(f'[device_access] log_logout_event failed: {e}', file=_sys.stderr)


def ensure_lock_columns():
    """Add is_locked + locked_at + active_session_token columns to User_Tbl on existing
    installs. Idempotent — uses IF NOT EXISTS where supported, falls back gracefully."""
    conn = sampling_portal.get_db_connection()
    if not conn: return
    for col, ddl in [
        ('is_locked',            "ALTER TABLE `User_Tbl` ADD COLUMN is_locked TINYINT(1) DEFAULT 0"),
        ('locked_at',            "ALTER TABLE `User_Tbl` ADD COLUMN locked_at DATETIME NULL"),
        ('active_session_token', "ALTER TABLE `User_Tbl` ADD COLUMN active_session_token VARCHAR(64) DEFAULT ''"),
    ]:
        try:
            # Check if column exists first (compatible with all MySQL versions)
            cur = conn.execute(
                "SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='User_Tbl' AND COLUMN_NAME=%s",
                (col,)
            )
            n = _one(cur).get('c') or 0
            if int(n) == 0:
                conn.execute(ddl)
                conn.commit()
                print(f'[device_access] added column User_Tbl.{col}', file=_sys.stderr)
        except Exception as e:
            print(f'[device_access] ensure_lock_columns({col}) skipped: {e}', file=_sys.stderr)

def _audit_log_append(entry):
    raw = _get_setting('audit_log', '[]')
    try:
        log = json.loads(raw)
    except Exception:
        log = []
    entry['ts'] = _now_iso()
    log.append(entry)
    log = log[-AUDIT_LOG_MAX:]
    _set_setting('audit_log', json.dumps(log))

def _audit_log_read():
    raw = _get_setting('audit_log', '[]')
    try:
        return list(reversed(json.loads(raw)))   # newest first
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Public API used by the login route (called from app.py)
# ─────────────────────────────────────────────────────────────────────────────
def get_or_issue_device_cookie(response):
    """Read the device_id cookie if present; if not, mint a new one and set it
    on the supplied response. Returns the device_id (existing or new).
    Use this on the GET /login page so first-time visitors get a cookie."""
    did = request.cookies.get(COOKIE_NAME)
    if did and re.match(r'^[A-Za-z0-9_\-]{16,64}$', did):
        return did, False
    did = _gen_device_id()
    response.set_cookie(
        COOKIE_NAME, did,
        max_age=COOKIE_MAX_AGE, httponly=True, samesite='Strict',
        secure=request.is_secure
    )
    return did, True


def device_check_at_login(user_record):
    """Run *after* password verification, *before* setting the session.

    Returns one of:
      ('allow', None)                — login may proceed
      ('pending', device_id)         — show 'awaiting approval' page
      ('blocked', reason)            — show generic blocked page

    Behaviour:
      - If master toggle is OFF → allow
      - If username is in bypass list → allow
      - Else look up the cookie:
          - approved → allow, update last_seen
          - pending  → 'pending'
          - revoked  → 'blocked'
          - unknown  → smart auto-approve OR create pending → 'pending'
    """
    ensure_device_access_tables()

    if not _check_enabled():
        return ('allow', None)

    username = (user_record.get('username') or '').strip()
    if _is_bypass(username):
        return ('allow', None)

    did = request.cookies.get(COOKIE_NAME)
    if not did or not re.match(r'^[A-Za-z0-9_\-]{16,64}$', did):
        # No cookie yet — we'll mint one on the response, but for login flow
        # treat as new device and create pending.
        did = _gen_device_id()

    conn = sampling_portal.get_db_connection()
    if not conn:
        # If DB is down, fail OPEN with a warning rather than locking everyone out.
        # This is the safer default for an internal portal.
        print('[device_access] DB unavailable during login check — fail-open', file=_sys.stderr)
        return ('allow', None)

    try:
        cur = conn.execute("""
            SELECT id, status FROM device_registry
            WHERE user_id=%s AND device_id=%s LIMIT 1
        """, (user_record['id'], did))
        row = _one(cur)

        if row and row.get('status') == 'approved':
            try:
                conn.execute(
                    "UPDATE device_registry SET last_seen_at=NOW(), ip_address=%s WHERE id=%s",
                    (_client_ip(), row['id'])
                )
                conn.commit()
            except Exception: pass
            return ('allow', did)

        if row and row.get('status') == 'pending':
            return ('pending', did)

        if row and row.get('status') == 'revoked':
            return ('blocked', did)

        # Unknown device for this user — try smart auto-approval first.
        ua = request.headers.get('User-Agent', '')
        kind, browser, os_ = _parse_ua(ua)
        ip = _client_ip()

        if _auto_approve_enabled():
            try:
                cur = conn.execute("""
                    SELECT id, ip_address, browser, os FROM device_registry
                    WHERE user_id=%s AND status='approved'
                      AND ip_address=%s AND browser=%s AND os=%s
                      AND last_seen_at >= (NOW() - INTERVAL 30 DAY)
                    LIMIT 1
                """, (user_record['id'], ip, browser, os_))
                similar = _one(cur)
                if similar:
                    conn.execute("""
                        INSERT INTO device_registry
                            (user_id, username, device_id, kind, browser, os, ua_string,
                             ip_address, status, approved_at, approved_by,
                             last_seen_at, note)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'approved', NOW(), %s, NOW(),
                                'Auto-approved: matched previous device')
                    """, (user_record['id'], username, did, kind, browser, os_, ua[:500],
                          ip, 'system-auto'))
                    conn.commit()
                    _audit_log_append({
                        'action': 'auto_approve',
                        'user': username,
                        'device_id': did[:8] + '…',
                        'reason': f'same ip+browser+os as device {similar["id"]}',
                    })
                    return ('allow', did)
            except Exception as e:
                print(f'[device_access] auto-approve check failed: {e}', file=_sys.stderr)

        # Create a pending request.
        try:
            conn.execute("""
                INSERT INTO device_registry
                    (user_id, username, device_id, kind, browser, os, ua_string,
                     ip_address, status, requested_at, note)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pending', NOW(), '')
            """, (user_record['id'], username, did, kind, browser, os_, ua[:500], ip))
            conn.commit()
        except Exception as e:
            # If the row already exists from a duplicate registration attempt, ignore
            print(f'[device_access] pending insert (ignored if dup): {e}', file=_sys.stderr)
        return ('pending', did)

    except Exception as e:
        print(f'[device_access] device_check_at_login failed: {e}', file=_sys.stderr)
        # Fail-open on errors so a bug here doesn't lock everyone out.
        return ('allow', did)


# ─────────────────────────────────────────────────────────────────────────────
# Pending / recover / cookie-status pages used by users
# ─────────────────────────────────────────────────────────────────────────────
@device_access_bp.route('/device_pending')
def device_pending_page():
    did = request.cookies.get(COOKIE_NAME, '')
    return render_template('device_pending.html', device_id=did)


@device_access_bp.route('/api/device/check-status', methods=['GET'])
def api_device_check_status():
    """Public (no auth) endpoint used by the pending page to poll for approval.
    Returns the status of the cookie-identified device, scoped to the most
    recent pending/approved row (any user) — we don't reveal which user owns it.
    Response: { status: 'pending'|'approved'|'revoked'|'unknown'|'disabled' }
    """
    try:
        ensure_device_access_tables()
        if not _check_enabled():
            return jsonify({'status': 'disabled'})
        did = request.cookies.get(COOKIE_NAME, '')
        if not did:
            return jsonify({'status': 'unknown'})
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'unknown'})
        cur = conn.execute("""
            SELECT status FROM device_registry
            WHERE device_id=%s
            ORDER BY (status='approved') DESC, requested_at DESC
            LIMIT 1
        """, (did,))
        row = _one(cur)
        if not row:
            return jsonify({'status': 'unknown'})
        return jsonify({'status': row.get('status') or 'unknown'})
    except Exception as e:
        print(f'[device_access] check-status failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'unknown'})


@device_access_bp.route('/device_recover', methods=['GET'])
def device_recover_page():
    return render_template('device_recover.html', error=None, success=None)


@device_access_bp.route('/api/device/recover', methods=['POST'])
def api_device_recover():
    """Username + password + recovery code → approve current cookie."""
    ensure_device_access_tables()
    d = request.get_json(silent=True) or request.form
    uid = (d.get('username') or '').strip()
    pwd = d.get('password') or ''
    code = (d.get('recovery_code') or '').strip().upper()

    if not uid or not pwd or not code:
        return jsonify({'status': 'error', 'message': 'All fields are required.'}), 400

    user = sampling_portal.get_user_for_auth(uid)
    if user is None:
        return jsonify({'status': 'error', 'message': 'Invalid username or password.'}), 401
    if user.get('password_hash') != sampling_portal.hash_password(pwd):
        return jsonify({'status': 'error', 'message': 'Invalid username or password.'}), 401

    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable.'}), 503

    code_hash = _hash_code(code)
    try:
        cur = conn.execute("""
            SELECT id FROM device_registry
            WHERE user_id=%s AND recovery_hash=%s AND recovery_used_at IS NULL
              AND status='approved'
            LIMIT 1
        """, (user['id'], code_hash))
        match = _one(cur)
        if not match:
            return jsonify({'status': 'error', 'message': 'Recovery code is invalid or already used.'}), 400

        # Issue a new device_id cookie and create an approved entry tied to it.
        did = request.cookies.get(COOKIE_NAME) or _gen_device_id()
        ua = request.headers.get('User-Agent', '')
        kind, browser, os_ = _parse_ua(ua)
        new_code = _gen_recovery_code()
        conn.execute("""
            INSERT INTO device_registry
                (user_id, username, device_id, kind, browser, os, ua_string,
                 ip_address, status, approved_at, approved_by,
                 recovery_hash, last_seen_at, note)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'approved', NOW(), 'system-recover',
                    %s, NOW(), 'Self-recovered using recovery code')
            ON DUPLICATE KEY UPDATE
                status='approved', approved_at=NOW(), approved_by='system-recover',
                recovery_hash=VALUES(recovery_hash), last_seen_at=NOW(),
                note='Self-recovered using recovery code'
        """, (user['id'], user.get('username') or '', did, kind, browser, os_, ua[:500],
              _client_ip(), _hash_code(new_code)))
        # Mark the old code as used.
        conn.execute(
            "UPDATE device_registry SET recovery_used_at=NOW() WHERE id=%s",
            (match['id'],)
        )
        conn.commit()
        _audit_log_append({
            'action': 'self_recover',
            'user': uid,
            'device_id': did[:8] + '…',
        })

        resp = make_response(jsonify({
            'status': 'ok',
            'message': 'Device approved. Save this NEW recovery code — you will need it if you lose access again.',
            'new_recovery_code': new_code,
        }))
        resp.set_cookie(
            COOKIE_NAME, did,
            max_age=COOKIE_MAX_AGE, httponly=True, samesite='Strict',
            secure=request.is_secure
        )
        return resp
    except Exception as e:
        print(f'[device_access] recover failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Recovery failed.'}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Admin endpoints (gated)
# ─────────────────────────────────────────────────────────────────────────────
def _admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
        if (session.get('User_Type', '') or '').strip().lower() != 'admin':
            return jsonify({'status': 'error', 'message': 'Admin only'}), 403
        return f(*args, **kwargs)
    return wrapper


@device_access_bp.route('/api/admin/devices', methods=['GET'])
@_admin_required
def api_admin_devices():
    """List devices, optionally filtered by status."""
    ensure_device_access_tables()
    status = request.args.get('status', '').strip()
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    try:
        if status in ('pending', 'approved', 'revoked'):
            cur = conn.execute(
                """SELECT id, user_id, username, device_id, kind, browser, os,
                          ip_address, mac_label, status, requested_at, approved_at,
                          approved_by, last_seen_at, note
                   FROM device_registry WHERE status=%s
                   ORDER BY requested_at DESC LIMIT 500""",
                (status,)
            )
        else:
            cur = conn.execute(
                """SELECT id, user_id, username, device_id, kind, browser, os,
                          ip_address, mac_label, status, requested_at, approved_at,
                          approved_by, last_seen_at, note
                   FROM device_registry
                   ORDER BY requested_at DESC LIMIT 500"""
            )
        items = _rows(cur)
        # Mask device_id for display
        for it in items:
            full = it.get('device_id') or ''
            it['device_id_short'] = (full[:8] + '…' + full[-4:]) if len(full) > 12 else full
        return jsonify({'status': 'ok', 'items': items})
    except Exception as e:
        print(f'[device_access] list devices failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Could not load devices.'}), 500


@device_access_bp.route('/api/admin/devices/approve', methods=['POST'])
@_admin_required
def api_admin_devices_approve():
    """Bulk approve. Body: {ids: [..]} — returns recovery codes."""
    ensure_device_access_tables()
    d = request.get_json(silent=True) or {}
    ids = d.get('ids') or []
    if not isinstance(ids, list) or not ids:
        return jsonify({'status': 'error', 'message': 'No device IDs supplied.'}), 400
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    approved = []
    admin_user = session.get('UID') or session.get('User_Name') or 'admin'
    try:
        for raw_id in ids:
            try: row_id = int(raw_id)
            except: continue
            code = _gen_recovery_code()
            conn.execute("""
                UPDATE device_registry
                SET status='approved', approved_at=NOW(), approved_by=%s,
                    recovery_hash=%s, recovery_used_at=NULL, revoked_at=NULL, revoked_by=''
                WHERE id=%s
            """, (admin_user, _hash_code(code), row_id))
            cur = conn.execute(
                "SELECT username, device_id FROM device_registry WHERE id=%s", (row_id,)
            )
            r = _one(cur)
            approved.append({
                'id': row_id,
                'username': r.get('username', ''),
                'device_id_short': (r.get('device_id') or '')[:8] + '…',
                'recovery_code': code,
            })
            _audit_log_append({
                'action': 'approve',
                'by': admin_user,
                'user': r.get('username', ''),
                'device_id': (r.get('device_id') or '')[:8] + '…',
            })
        conn.commit()
        return jsonify({
            'status': 'ok',
            'count': len(approved),
            'approved': approved,
            'message': f'Approved {len(approved)} device(s). Share the recovery codes with the users.',
        })
    except Exception as e:
        print(f'[device_access] approve failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Approval failed.'}), 500


@device_access_bp.route('/api/admin/devices/revoke', methods=['POST'])
@_admin_required
def api_admin_devices_revoke():
    """Bulk revoke. Body: {ids: [..]}"""
    ensure_device_access_tables()
    d = request.get_json(silent=True) or {}
    ids = d.get('ids') or []
    if not isinstance(ids, list) or not ids:
        return jsonify({'status': 'error', 'message': 'No device IDs supplied.'}), 400
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    admin_user = session.get('UID') or session.get('User_Name') or 'admin'
    try:
        ids = [int(x) for x in ids if str(x).isdigit()]
        for row_id in ids:
            cur = conn.execute(
                "SELECT username, device_id FROM device_registry WHERE id=%s", (row_id,)
            )
            r = _one(cur)
            conn.execute("""
                UPDATE device_registry
                SET status='revoked', revoked_at=NOW(), revoked_by=%s
                WHERE id=%s
            """, (admin_user, row_id))
            _audit_log_append({
                'action': 'revoke',
                'by': admin_user,
                'user': r.get('username', ''),
                'device_id': (r.get('device_id') or '')[:8] + '…',
            })
        conn.commit()
        return jsonify({'status': 'ok', 'count': len(ids), 'message': f'Revoked {len(ids)} device(s).'})
    except Exception as e:
        print(f'[device_access] revoke failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Revoke failed.'}), 500


@device_access_bp.route('/api/admin/devices/<int:row_id>', methods=['PUT'])
@_admin_required
def api_admin_devices_edit(row_id):
    """Edit MAC label or note for one device."""
    ensure_device_access_tables()
    d = request.get_json(silent=True) or {}
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    sets, params = [], []
    if 'mac_label' in d:
        sets.append('mac_label=%s'); params.append((d['mac_label'] or '')[:50])
    if 'note' in d:
        sets.append('note=%s'); params.append((d['note'] or '')[:500])
    if not sets:
        return jsonify({'status': 'error', 'message': 'Nothing to update.'}), 400
    params.append(row_id)
    try:
        conn.execute(f"UPDATE device_registry SET {', '.join(sets)} WHERE id=%s", tuple(params))
        conn.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
        print(f'[device_access] edit failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Edit failed.'}), 500


@device_access_bp.route('/api/admin/device-settings', methods=['GET'])
@_admin_required
def api_admin_device_settings_get():
    ensure_device_access_tables()
    return jsonify({
        'status': 'ok',
        'device_check_enabled': _check_enabled(),
        'auto_approve_enabled': _auto_approve_enabled(),
        'bypass_usernames': _bypass_usernames(),
        'inactivity_lock_days': _inactivity_lock_days(),
        'login_audit_retain_months': _retain_months(),
        'audit_log': _audit_log_read()[:50],
        'confirmation_phrase': CONFIRMATION_PHRASE,
    })


@device_access_bp.route('/api/admin/device-settings', methods=['PUT'])
@_admin_required
def api_admin_device_settings_set():
    """Update settings — requires confirmation phrase for sensitive changes
    (bypass list edit, master toggle off). Body:
      { device_check_enabled?, auto_approve_enabled?, bypass_usernames?, confirmation? }
    """
    ensure_device_access_tables()
    d = request.get_json(silent=True) or {}
    admin_user = session.get('UID') or session.get('User_Name') or 'admin'
    changes_log = []

    sensitive = False
    if 'device_check_enabled' in d and bool(d['device_check_enabled']) != _check_enabled():
        sensitive = True
    if 'bypass_usernames' in d:
        new_list = sorted([str(x).strip().lower() for x in (d['bypass_usernames'] or []) if str(x).strip()])
        old_list = sorted(_bypass_usernames())
        if new_list != old_list:
            sensitive = True

    if sensitive:
        confirm = (d.get('confirmation') or '').strip()
        if confirm != CONFIRMATION_PHRASE:
            return jsonify({
                'status': 'error',
                'message': f'Confirmation phrase required: "{CONFIRMATION_PHRASE}"',
                'requires_confirmation': True,
            }), 400

    try:
        if 'device_check_enabled' in d:
            v = 'true' if d['device_check_enabled'] else 'false'
            if v != _get_setting('device_check_enabled'):
                _set_setting('device_check_enabled', v)
                changes_log.append(f"master toggle → {v}")
        if 'auto_approve_enabled' in d:
            v = 'true' if d['auto_approve_enabled'] else 'false'
            if v != _get_setting('auto_approve_enabled'):
                _set_setting('auto_approve_enabled', v)
                changes_log.append(f"auto-approve → {v}")
        if 'bypass_usernames' in d:
            clean = [str(x).strip() for x in (d['bypass_usernames'] or []) if str(x).strip()]
            _set_setting('bypass_usernames', json.dumps(clean))
            changes_log.append(f"bypass list → {clean}")
        if 'inactivity_lock_days' in d:
            try:
                v = max(0, int(d['inactivity_lock_days']))
            except (TypeError, ValueError):
                return jsonify({'status': 'error',
                                'message': 'inactivity_lock_days must be a non-negative integer.'}), 400
            if v != _inactivity_lock_days():
                _set_setting('inactivity_lock_days', str(v))
                changes_log.append(f"inactivity-lock days → {v}" + (' (disabled)' if v == 0 else ''))
        if 'login_audit_retain_months' in d:
            try:
                v = max(0, int(d['login_audit_retain_months']))
            except (TypeError, ValueError):
                return jsonify({'status': 'error',
                                'message': 'login_audit_retain_months must be a non-negative integer.'}), 400
            if v != _retain_months():
                _set_setting('login_audit_retain_months', str(v))
                changes_log.append(f"audit retention → {v} months" + (' (forever)' if v == 0 else ''))
        for c in changes_log:
            _audit_log_append({'action': 'settings_change', 'by': admin_user, 'change': c})
        return jsonify({'status': 'ok', 'message': 'Settings updated.', 'changes': changes_log})
    except Exception as e:
        print(f'[device_access] settings update failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Update failed.'}), 500


@device_access_bp.route('/api/admin/users/<int:user_id>/unlock', methods=['POST'])
@_admin_required
def api_admin_user_unlock(user_id):
    """Admin clears the auto-lock flag on a user account."""
    admin_user = session.get('UID') or session.get('User_Name') or 'admin'
    ok, msg = admin_unlock_user(user_id, admin_user)
    if not ok:
        return jsonify({'status': 'error', 'message': msg}), 400
    return jsonify({'status': 'ok', 'message': msg})


@device_access_bp.route('/api/admin/single-session-toggle', methods=['GET', 'POST'])
@_admin_required
def api_admin_single_session_toggle():
    """GET → returns the current state of the global single-login toggle.
    POST → flips it to the supplied value. Body: {enabled: true|false}.

    When ON: a successful login invalidates any prior session that the same
    user account had on another device. Default: OFF."""
    ensure_device_access_tables()
    if request.method == 'GET':
        return jsonify({'status': 'ok', 'enabled': single_session_enabled()})
    d = request.get_json(silent=True) or {}
    new_val = bool(d.get('enabled'))
    if new_val == single_session_enabled():
        return jsonify({'status': 'ok', 'enabled': new_val, 'message': 'No change.'})
    _set_setting('single_session_only', 'true' if new_val else 'false')
    admin_user = session.get('UID') or session.get('User_Name') or 'admin'
    _audit_log_append({
        'action': 'single_session_toggle',
        'by': admin_user,
        'change': f"single-session-only → {'ON' if new_val else 'OFF'}",
    })
    return jsonify({
        'status': 'ok',
        'enabled': new_val,
        'message': ('Single-login enforcement turned ON. '
                    'When a user logs in, any other active session for that user will be signed out.'
                    if new_val else
                    'Single-login enforcement turned OFF. Users can be signed in on multiple devices.')
    })


@device_access_bp.route('/api/admin/login-audit', methods=['GET'])
@_admin_required
def api_admin_login_audit():
    """Fetch login/logout events in a date range.
    Query params:
      from=YYYY-MM-DD  (inclusive, defaults to first of current month)
      to=YYYY-MM-DD    (inclusive, defaults to today)
      user=<username>  (optional substring match)
      event=<type>     (optional: login_success | login_fail | logout | all)
      limit=<n>        (default 500, max 2000)
    """
    ensure_device_access_tables()
    _purge_old_audit()
    today = _now().date()
    first_of_month = today.replace(day=1)
    d_from = (request.args.get('from') or first_of_month.strftime('%Y-%m-%d')).strip()
    d_to   = (request.args.get('to')   or today.strftime('%Y-%m-%d')).strip()
    user_q = (request.args.get('user') or '').strip()
    event  = (request.args.get('event') or '').strip()
    try:
        limit = max(1, min(2000, int(request.args.get('limit') or 500)))
    except Exception:
        limit = 500

    # Validate dates loosely
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', d_from): d_from = first_of_month.strftime('%Y-%m-%d')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', d_to):   d_to   = today.strftime('%Y-%m-%d')

    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503

    where = ["ts >= %s", "ts < (DATE(%s) + INTERVAL 1 DAY)"]
    params = [d_from, d_to]
    if user_q:
        where.append("username LIKE %s")
        params.append(f"%{user_q}%")
    if event and event != 'all':
        where.append("event_type = %s")
        params.append(event)
    sql = (
        "SELECT id, ts, username, event_type, ip_address, device_id_short, "
        "       browser, os, kind, fail_reason, logout_ts "
        "FROM login_audit WHERE " + " AND ".join(where) +
        " ORDER BY ts DESC LIMIT %s"
    )
    params.append(limit)
    try:
        cur = conn.execute(sql, tuple(params))
        items = _rows(cur)
        # Summary counts for the same date range
        cur2 = conn.execute(
            "SELECT event_type, COUNT(*) AS c FROM login_audit "
            "WHERE ts >= %s AND ts < (DATE(%s) + INTERVAL 1 DAY) "
            + (" AND username LIKE %s" if user_q else "") +
            " GROUP BY event_type",
            tuple([d_from, d_to] + ([f"%{user_q}%"] if user_q else []))
        )
        summary = {r.get('event_type'): int(r.get('c') or 0) for r in _rows(cur2)}
        return jsonify({
            'status': 'ok',
            'from': d_from, 'to': d_to,
            'count': len(items),
            'limit': limit,
            'summary': summary,
            'items': items,
        })
    except Exception as e:
        print(f'[device_access] login-audit fetch failed: {e}', file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Could not load audit log.'}), 500



# ─────────────────────────────────────────────────────────────────────────────
# Counts for the KPI card on the index page
# ─────────────────────────────────────────────────────────────────────────────
def get_admin_dashboard_context():
    """Returns a small dict for the index template's KPI card.
       Safe to call on every home() render — fails to zeros if anything is off."""
    out = {'device_pending_count': 0, 'device_approved_count': 0,
           'device_check_enabled': True}
    try:
        ensure_device_access_tables()
        conn = sampling_portal.get_db_connection()
        if not conn: return out
        cur = conn.execute("SELECT status, COUNT(*) AS c FROM device_registry GROUP BY status")
        for r in _rows(cur):
            s = r.get('status', '')
            c = int(r.get('c') or 0)
            if s == 'pending':  out['device_pending_count']  = c
            if s == 'approved': out['device_approved_count'] = c
        out['device_check_enabled'] = _check_enabled()
    except Exception as e:
        print(f'[device_access] dashboard context failed: {e}', file=_sys.stderr)
    return out
