"""
inventory_fefo_global.py
========================

Global FEFO on/off switch — admin-only.

Why this exists
---------------
The existing FEFO enforcement (in inventory_fefo.py) blocks scans that
would consume newer-expiry stock when older-expiry stock is available.
Admins are individually exempt server-side. But there's no system-wide
"turn FEFO off temporarily" capability — useful during:

  • Bulk migration / data corrections where every scan would otherwise
    raise an override request
  • Audit operations that need to inspect stock without triggering
    enforcement
  • Emergency operations where the operator needs to bypass FEFO and
    the override-request workflow is too slow

This module adds a single row of global state:

    inventory_fefo_global_state
      id              INT PK
      is_disabled     TINYINT(1)        — 0 = FEFO ON (normal), 1 = OFF
      changed_by      VARCHAR(128)      — last admin to flip the switch
      changed_at      DATETIME          — IST timestamp of last flip
      reason          TEXT              — admin-supplied justification
      expires_at      DATETIME NULL     — auto-re-enable cut-off (safety)

The table holds at most ONE row. We INSERT it once at boot and then UPDATE
it in place. Reading is a single-row SELECT, fast enough to do on every
FEFO check without caching (and a tiny in-process TTL cache makes it
effectively free for hot paths).

API
---
GET  /api/inventory_mgmt/fefo/global_state
     Any logged-in user — returns current state for the page banner.
     Response: {
         "status": "ok",
         "is_disabled": false|true,
         "changed_by": "...",
         "changed_at": "YYYY-MM-DD HH:MM:SS" (IST),
         "reason": "...",
         "expires_at": "YYYY-MM-DD HH:MM:SS" or null,
         "expired": false|true   ← if a previous OFF state auto-expired,
                                   this flag is true and is_disabled is
                                   reported as false. The server has
                                   already self-healed the row.
     }

POST /api/inventory_mgmt/fefo/global_state
     Admin only. Body: {
         "disable": true|false,
         "reason":  "Brief justification, shown in the banner and audit log",
         "duration_hours": 4    ← optional, only honoured when disable=true
                                  Defaults to 4 hours. Max 24.
                                  Auto-re-enable safety net so a forgotten
                                  switch doesn't leave the warehouse running
                                  without FEFO indefinitely.
     }
     Response: same shape as GET, plus "previous_state" for the audit trail.

Server enforcement
------------------
inventory_fefo.py's fefo_check_box() must call fefo_globally_disabled()
(exported here) BEFORE the admin check. If the global switch is on,
fefo_check_box() should return {"allowed": True, "global_disabled": True}
immediately. The one-line patch is documented at the bottom of this file.
"""

from __future__ import annotations

import time
import traceback
from datetime import datetime, timedelta
from functools import wraps

from flask import jsonify, request, session

# We rely on sampling_portal for the DB connection — the same module
# every other inventory file uses. This avoids invention of a parallel
# connection-pool path.
try:
    import sampling_portal
except Exception:  # pragma: no cover — sampling_portal is always present
    sampling_portal = None  # type: ignore


# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

# Cap on how long a single "disable FEFO" can stay in effect before the
# safety auto-re-enable kicks in. Admin can re-disable immediately if
# they truly need longer.
_MAX_DURATION_HOURS = 24
_DEFAULT_DURATION_HOURS = 4

# Short in-process TTL for the global-state read so the FEFO check path
# isn't doing one DB query per scan. State changes are rare (manual admin
# action) so 5s of staleness is acceptable.
_STATE_CACHE = {"value": None, "expires_at": 0.0}
_STATE_TTL_SECONDS = 5


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def _user() -> str:
    """Best-effort current username for audit fields."""
    return (
        session.get("User_Name")
        or session.get("UID")
        or session.get("user_name")
        or session.get("username")
        or "Unknown"
    )


def _is_admin() -> bool:
    role = session.get("User_Type") or session.get("user_type") or ""
    uid = (_user() or "").lower()
    return str(role).lower() == "admin" or uid in {"sonal", "tarak"}


def _admin_required(f):
    @wraps(f)
    def gate(*a, **kw):
        if not _is_admin():
            return jsonify({
                "status": "error",
                "message": "Admin-only — you do not have permission to "
                           "change the global FEFO switch.",
            }), 403
        return f(*a, **kw)
    return gate


def _login_required(f):
    """Reused locally so this module is self-contained — no import from
    other inventory modules whose internals may shift."""
    @wraps(f)
    def gate(*a, **kw):
        if not session.get("logged_in") and not session.get("UID"):
            return jsonify({
                "status": "error",
                "message": "Login required",
            }), 401
        return f(*a, **kw)
    return gate


def _now_ist_str() -> str:
    """ISO-8601-ish IST timestamp. We try to use the inventory_fefo
    helper if it's already present; otherwise fall back to local naive
    time which is fine for an audit field."""
    try:
        from inventory_fefo import _ist_now_str  # type: ignore
        return _ist_now_str()
    except Exception:
        pass
    try:
        from datetime import timezone, timedelta
        IST = timezone(timedelta(hours=5, minutes=30))
        return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _parse_dt(v):
    """Tolerant datetime parser — DB drivers may return datetime objects
    OR strings depending on the connector."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v
    s = str(v)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt)
        except Exception:
            pass
    return None


def _now_ist_dt():
    """Naive IST datetime, matching the format used in _now_ist_str."""
    try:
        from datetime import timezone, timedelta
        IST = timezone(timedelta(hours=5, minutes=30))
        return datetime.now(IST).replace(tzinfo=None)
    except Exception:
        return datetime.utcnow()


# ──────────────────────────────────────────────────────────────────────
# Schema bootstrap
# ──────────────────────────────────────────────────────────────────────

def _ensure_table():
    """Idempotent. Creates the single-row state table on first use and
    inserts the initial row if it isn't present yet."""
    if sampling_portal is None:
        return
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS inventory_fefo_global_state (
                    id          INT PRIMARY KEY,
                    is_disabled TINYINT(1) NOT NULL DEFAULT 0,
                    changed_by  VARCHAR(128) NULL,
                    changed_at  DATETIME NULL,
                    reason      TEXT NULL,
                    expires_at  DATETIME NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            # Seed the single row if it doesn't exist.
            existing = conn.execute(
                "SELECT id FROM inventory_fefo_global_state WHERE id=1"
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO inventory_fefo_global_state "
                    "(id, is_disabled) VALUES (1, 0)"
                )
            conn.commit()
            print("✅ [InventoryFEFOGlobal] state table ready")
        finally:
            try: conn.close()
            except Exception: pass
    except Exception:
        traceback.print_exc()


# ──────────────────────────────────────────────────────────────────────
# State read / write
# ──────────────────────────────────────────────────────────────────────

def _read_state_raw():
    """Read the single row. Returns dict with keys
    is_disabled / changed_by / changed_at / reason / expires_at,
    or None on DB error."""
    if sampling_portal is None:
        return None
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return None
        try:
            row = conn.execute(
                "SELECT is_disabled, changed_by, changed_at, "
                "       reason, expires_at "
                "FROM inventory_fefo_global_state WHERE id=1"
            ).fetchone()
            if not row:
                return None
            d = dict(row) if hasattr(row, "keys") else row
            d["is_disabled"] = bool(d.get("is_disabled"))
            return d
        finally:
            try: conn.close()
            except Exception: pass
    except Exception:
        traceback.print_exc()
        return None


def _expire_if_needed(state):
    """If the state is `disabled` and has passed its `expires_at`, flip
    it back to enabled in the DB and return the updated state. Returns
    a 2-tuple: (state, expired_just_now_bool)."""
    if not state or not state.get("is_disabled"):
        return state, False
    exp = _parse_dt(state.get("expires_at"))
    if not exp:
        return state, False
    if _now_ist_dt() < exp:
        return state, False
    # Past the cut-off. Auto-re-enable.
    if sampling_portal is None:
        return state, False
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return state, False
        try:
            conn.execute(
                "UPDATE inventory_fefo_global_state "
                "SET is_disabled=0, expires_at=NULL "
                "WHERE id=1"
            )
            conn.commit()
            print(f"⏰ [InventoryFEFOGlobal] auto-re-enabled FEFO "
                  f"(was disabled by {state.get('changed_by')!r} "
                  f"at {state.get('changed_at')!r}, expired at {exp})")
        finally:
            try: conn.close()
            except Exception: pass
    except Exception:
        traceback.print_exc()
        return state, False
    # Read back so callers see the post-expire state.
    fresh = _read_state_raw() or state
    return fresh, True


def _read_state_cached():
    """Read with a 5s TTL cache. Auto-expires the disabled state if
    needed. Returns the state dict (never None — falls back to default
    enabled state on DB error)."""
    now = time.monotonic()
    if _STATE_CACHE["value"] and _STATE_CACHE["expires_at"] > now:
        return _STATE_CACHE["value"]
    raw = _read_state_raw()
    if raw is None:
        # DB hiccup — return a safe default but don't cache it.
        return {"is_disabled": False, "changed_by": None,
                "changed_at": None, "reason": None, "expires_at": None}
    expired_now = False
    raw, expired_now = _expire_if_needed(raw)
    raw["expired"] = bool(expired_now)
    _STATE_CACHE["value"] = raw
    _STATE_CACHE["expires_at"] = now + _STATE_TTL_SECONDS
    return raw


def _invalidate_cache():
    _STATE_CACHE["value"] = None
    _STATE_CACHE["expires_at"] = 0.0


# ──────────────────────────────────────────────────────────────────────
# Public — called by inventory_fefo.fefo_check_box()
# ──────────────────────────────────────────────────────────────────────

def fefo_globally_disabled() -> bool:
    """Single function the existing FEFO check function should call to
    decide if global enforcement is currently OFF. Returns True iff the
    admin has flipped the global switch (and the safety cut-off hasn't
    expired yet)."""
    try:
        st = _read_state_cached()
        return bool(st and st.get("is_disabled"))
    except Exception:
        traceback.print_exc()
        # Fail closed — when we can't tell, assume FEFO is ON so we
        # don't silently disable enforcement due to a DB blip.
        return False


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────

def register_inventory_fefo_global(app):
    """Idempotent registration. Call this from your app factory just
    like other inventory modules are registered."""
    if getattr(app, "_inventory_fefo_global_registered", False):
        return
    setattr(app, "_inventory_fefo_global_registered", True)

    _ensure_table()

    # ── GET state — any logged-in user ──
    @app.route("/api/inventory_mgmt/fefo/global_state", methods=["GET"])
    @_login_required
    def api_inv_fefo_global_state_get():
        st = _read_state_cached()
        # Normalise timestamps to strings for JSON.
        def _s(v):
            if v is None: return None
            if isinstance(v, datetime):
                return v.strftime("%Y-%m-%d %H:%M:%S")
            return str(v)
        return jsonify({
            "status":      "ok",
            "is_disabled": bool(st.get("is_disabled")),
            "changed_by":  st.get("changed_by"),
            "changed_at":  _s(st.get("changed_at")),
            "reason":      st.get("reason"),
            "expires_at":  _s(st.get("expires_at")),
            "expired":     bool(st.get("expired")),
            "is_admin":    _is_admin(),
        })

    # ── POST state change — admin only ──
    @app.route("/api/inventory_mgmt/fefo/global_state", methods=["POST"])
    @_login_required
    @_admin_required
    def api_inv_fefo_global_state_set():
        body = request.get_json(silent=True) or {}
        want_disable = bool(body.get("disable"))
        reason = (body.get("reason") or "").strip()
        try:
            duration_hours = float(body.get("duration_hours")
                                   or _DEFAULT_DURATION_HOURS)
        except Exception:
            duration_hours = _DEFAULT_DURATION_HOURS
        # Clamp duration to safe range.
        if duration_hours <= 0:
            duration_hours = _DEFAULT_DURATION_HOURS
        if duration_hours > _MAX_DURATION_HOURS:
            duration_hours = _MAX_DURATION_HOURS

        if want_disable and not reason:
            return jsonify({
                "status": "error",
                "message": "A reason is required to disable FEFO. Please "
                           "describe why enforcement is being switched off.",
            }), 400

        # Capture previous state for the audit response.
        previous = _read_state_raw() or {}

        # Compute expires_at if disabling.
        expires_at = None
        if want_disable:
            expires_at = _now_ist_dt() + timedelta(hours=duration_hours)

        if sampling_portal is None:
            return jsonify({"status": "error",
                            "message": "DB unavailable"}), 503
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error",
                                "message": "DB connection failed"}), 503
            try:
                if want_disable:
                    conn.execute(
                        "UPDATE inventory_fefo_global_state "
                        "SET is_disabled=1, changed_by=%s, changed_at=%s, "
                        "    reason=%s, expires_at=%s "
                        "WHERE id=1",
                        (_user(), _now_ist_str(), reason,
                         expires_at.strftime("%Y-%m-%d %H:%M:%S"))
                    )
                else:
                    conn.execute(
                        "UPDATE inventory_fefo_global_state "
                        "SET is_disabled=0, changed_by=%s, changed_at=%s, "
                        "    reason=%s, expires_at=NULL "
                        "WHERE id=1",
                        (_user(), _now_ist_str(),
                         reason or "Re-enabled by admin")
                    )
                conn.commit()
            finally:
                try: conn.close()
                except Exception: pass
        except Exception as e:
            traceback.print_exc()
            return jsonify({
                "status": "error",
                "message": f"DB write failed: {type(e).__name__}: {e}",
            }), 500

        _invalidate_cache()
        action = "DISABLED" if want_disable else "ENABLED"
        print(f"🚨 [InventoryFEFOGlobal] FEFO {action} by {_user()!r}: "
              f"reason={reason!r} expires_at={expires_at}")

        new_state = _read_state_cached()
        def _s(v):
            if v is None: return None
            if isinstance(v, datetime):
                return v.strftime("%Y-%m-%d %H:%M:%S")
            return str(v)
        return jsonify({
            "status":      "ok",
            "is_disabled": bool(new_state.get("is_disabled")),
            "changed_by":  new_state.get("changed_by"),
            "changed_at":  _s(new_state.get("changed_at")),
            "reason":      new_state.get("reason"),
            "expires_at":  _s(new_state.get("expires_at")),
            "previous_state": {
                "is_disabled": bool(previous.get("is_disabled")),
                "changed_by":  previous.get("changed_by"),
                "changed_at":  _s(previous.get("changed_at")),
            },
        })

    print("✅ [InventoryFEFOGlobal] routes registered")


# ──────────────────────────────────────────────────────────────────────
# Integration patch for inventory_fefo.py
# ──────────────────────────────────────────────────────────────────────
#
# Add this near the top of inventory_fefo.py, after the existing imports:
#
#     try:
#         from inventory_fefo_global import fefo_globally_disabled
#     except Exception:
#         def fefo_globally_disabled():  # safe fallback if module absent
#             return False
#
# Then inside fefo_check_box(), insert ONE check immediately AFTER the
# is_admin block:
#
#     if is_admin:
#         return {"allowed": True}
#
#     # ─── NEW: respect the global FEFO off-switch ───
#     if fefo_globally_disabled():
#         return {"allowed": True, "global_disabled": True}
#
#     box_exp, mat_id, god_id = _box_expiry(conn, box_id)
#     ...
#
# That's it — two lines + a try/import block. Admins keep their always-on
# bypass, AND the global switch additionally exempts EVERYONE while it's
# active.
