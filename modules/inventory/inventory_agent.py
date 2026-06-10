"""
inventory_agent.py
═══════════════════════════════════════════════════════════════════════════════
Read-only "agent" that surfaces pending tasks for the inventory module.
Powers the toast that fires up to ~5 times a day reminding the user of
things waiting on them.

What it checks
──────────────
  1. EXPIRY  — boxes expiring within EXPIRY_WARN_DAYS (default 60).
  2. BELOW_MSL — materials whose total in-stock qty is at/below the
                 procurement_materials.msl threshold.
  3. MR_PENDING — Material Requests in 'pending' or 'in_progress' status.
  4. IN_TRANSIT — Stock Transfers in 'in_pending' status (Material IN
                  side not yet completed).
  5. AUDIT_STALE — last audit session created more than
                   AUDIT_STALE_DAYS ago (default 90).

Design
──────
  • READ-ONLY. Never writes anything. No DB schema changes. Safe to run
    on any frequency.
  • SCHEMA-DEFENSIVE. Every check probes the table/column exists before
    querying. A missing table makes that check return 0 silently — does
    NOT raise.
  • NO LOGIN-WALL FRAMEWORK NEEDED. The endpoint uses the inventory
    module's standard @_login_required pattern. Available to any logged-
    in user; non-login users get 401.
  • CHEAP. Five small SELECTs, all indexed columns. Total cost is
    typically < 50ms on the LAN ERP.

Endpoint
────────
  GET /api/inventory_mgmt/agent/pending
  → { status:'ok',
      checked_at: '<iso>',
      pending: [
        {type:'expiry',      count:4, message:'…'},
        {type:'below_msl',   count:7, message:'…'},
        {type:'mr_pending',  count:2, message:'…'},
        {type:'in_transit',  count:3, message:'…'},
        {type:'audit_stale', count:1, message:'…'},
      ]
    }
  Only types with count>0 are returned. If nothing is pending, `pending`
  is an empty list and the frontend skips the toast entirely.
"""

from functools import wraps
from datetime import datetime, timedelta, date

from flask import jsonify, session

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

EXPIRY_WARN_DAYS = 60   # warn when expiry_date is within this many days
AUDIT_STALE_DAYS = 90   # flag if no audit session in this many days


# ─────────────────────────────────────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS  (schema probes — every check uses these)
# ─────────────────────────────────────────────────────────────────────────────

def _table_exists(conn, table_name: str) -> bool:
    """True if the given table exists. We probe via SHOW TABLES LIKE
    rather than INFORMATION_SCHEMA so MySQL/MariaDB versions agree."""
    try:
        row = conn.execute("SHOW TABLES LIKE %s", (table_name,)).fetchone()
        return row is not None
    except Exception:
        return False


def _columns_of(conn, table_name: str):
    """Set of column names on a table, lowercased. Empty set on failure."""
    try:
        rows = conn.execute(f"SHOW COLUMNS FROM `{table_name}`").fetchall()
        out = set()
        for r in rows:
            name = None
            if isinstance(r, dict):
                name = r.get("Field") or r.get("field")
            else:
                try:    name = r["Field"]
                except Exception: name = r[0] if len(r) else None
            if name:
                out.add(str(name).lower())
        return out
    except Exception:
        return set()


def _safe_int(row, key='n'):
    """Pull a count from a single-row SELECT result robustly."""
    if not row:
        return 0
    try:
        v = row[key] if isinstance(row, dict) else row[0]
        return int(v or 0)
    except Exception:
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# CHECKS
# Each returns either None (skip — table missing or check failed) or an
# int count. The endpoint maps each non-None positive count into a
# `pending` entry with a human-readable message.
# ─────────────────────────────────────────────────────────────────────────────

def _check_expiry(conn) -> int:
    """Count distinct BATCHES expiring within EXPIRY_WARN_DAYS — matching the
    Expiry/FEFO report exactly (it groups by material+batch+expiry and counts
    those groups). Previously this counted boxes, so the notification said
    "21 batches" when the report showed 2 (those 2 batches held 21 boxes).
    Uses COALESCE(gi.*, b.*) so both GRN boxes and opening-stock boxes count.
    Only IN-STOCK boxes matter."""
    if not _table_exists(conn, 'rm_boxes'):
        return 0
    box_cols  = _columns_of(conn, 'rm_boxes')
    has_b_exp = 'expiry_date' in box_cols
    has_b_bat = 'batch_num'   in box_cols
    has_status = 'current_status' in box_cols
    if not has_b_exp and not _table_exists(conn, 'procurement_grn_items'):
        return 0
    item_cols = _columns_of(conn, 'procurement_grn_items') if _table_exists(conn, 'procurement_grn_items') else set()
    has_gi_exp = 'expiry_date' in item_cols
    has_gi_bat = 'batch_num'   in item_cols

    # Expiry expression + join — mirror the report's _expiry_expr().
    if has_gi_exp and has_b_exp:
        expr = "COALESCE(gi.expiry_date, b.expiry_date)"
        join = "LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id"
    elif has_gi_exp:
        expr = "gi.expiry_date"
        join = "LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id"
    elif has_b_exp:
        expr = "b.expiry_date"
        join = ""
    else:
        return 0

    # Batch expression — same COALESCE logic the report uses.
    if has_gi_bat and has_b_bat and join:
        bat = "COALESCE(gi.batch_num, b.batch_num)"
    elif has_gi_bat and join:
        bat = "gi.batch_num"
    elif has_b_bat:
        bat = "b.batch_num"
    else:
        bat = "''"   # no batch columns → group by material+expiry only

    status_filter = "AND b.current_status='in_stock'" if has_status else ""
    today    = date.today()
    cutoff   = today + timedelta(days=EXPIRY_WARN_DAYS)
    try:
        # Count distinct (material, batch, expiry) groups — i.e. batches —
        # exactly as the FEFO report does, so the two never disagree.
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM ("
            f"  SELECT 1 FROM rm_boxes b "
            f"  {join} "
            f"  WHERE {expr} IS NOT NULL "
            f"    AND {expr} BETWEEN %s AND %s "
            f"    {status_filter} "
            f"  GROUP BY b.material_id, {bat}, {expr} "
            f") AS batches",
            (today.isoformat(), cutoff.isoformat()),
        ).fetchone()
        return _safe_int(row)
    except Exception:
        return 0


def _check_below_msl(conn) -> int:
    """Count materials whose total in-stock qty across all godowns is at
    or below their MSL. Materials with msl=NULL or msl=0 are excluded
    (no threshold means no alert)."""
    if not _table_exists(conn, 'procurement_materials'):
        return 0
    if not _table_exists(conn, 'rm_boxes'):
        return 0
    mat_cols = _columns_of(conn, 'procurement_materials')
    if 'msl' not in mat_cols:
        return 0
    box_cols = _columns_of(conn, 'rm_boxes')
    has_status = 'current_status' in box_cols
    status_filter = "AND b.current_status='in_stock'" if has_status else ""
    try:
        # For each material with MSL > 0, sum per_box_qty over in-stock
        # boxes. If sum < msl, count it.
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM ("
            f"  SELECT m.id, m.msl, "
            f"         COALESCE(SUM(b.per_box_qty), 0) AS stock "
            f"  FROM procurement_materials m "
            f"  LEFT JOIN rm_boxes b ON b.material_id = m.id {status_filter} "
            f"  WHERE m.msl IS NOT NULL AND m.msl > 0 "
            f"  GROUP BY m.id, m.msl "
            f"  HAVING stock <= m.msl"
            f") AS x"
        ).fetchone()
        return _safe_int(row)
    except Exception:
        return 0


def _check_mr_pending(conn) -> int:
    """Material Requests waiting for fulfilment — status pending or
    in_progress. Note this is a count of *vouchers*, not line items."""
    if not _table_exists(conn, 'inventory_material_requests'):
        return 0
    cols = _columns_of(conn, 'inventory_material_requests')
    if 'status' not in cols:
        return 0
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM inventory_material_requests "
            "WHERE status IN ('pending','in_progress')"
        ).fetchone()
        return _safe_int(row)
    except Exception:
        return 0


def _check_in_transit(conn) -> int:
    """Stock Transfers where OUT side completed but IN side not yet —
    status 'in_pending'. These are the cards on the Material IN tab."""
    if not _table_exists(conn, 'rm_stock_transfers'):
        return 0
    cols = _columns_of(conn, 'rm_stock_transfers')
    if 'status' not in cols:
        return 0
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM rm_stock_transfers "
            "WHERE status='in_pending'"
        ).fetchone()
        return _safe_int(row)
    except Exception:
        return 0


def _check_audit_stale(conn) -> int:
    """Return 1 if the last audit session was more than AUDIT_STALE_DAYS
    ago (or never), else 0. Different from the other checks which
    count entities — this one is a boolean nudge."""
    if not _table_exists(conn, 'inventory_audit_sessions'):
        return 0
    cols = _columns_of(conn, 'inventory_audit_sessions')
    # Pick the best timestamp column available.
    ts_col = None
    for cand in ('created_at', 'submitted_at', 'settled_at'):
        if cand in cols:
            ts_col = cand
            break
    if not ts_col:
        return 0
    try:
        cutoff = (date.today() - timedelta(days=AUDIT_STALE_DAYS)).isoformat()
        # Count of audits in the recent window — if zero, it's stale.
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM inventory_audit_sessions "
            f"WHERE {ts_col} >= %s",
            (cutoff,),
        ).fetchone()
        recent = _safe_int(row)
        return 0 if recent > 0 else 1
    except Exception:
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# MESSAGE FORMATTING
# Templated. Kept short — the toast only shows for 5 seconds.
# ─────────────────────────────────────────────────────────────────────────────

def _format_message(check_type: str, count: int) -> str:
    if check_type == 'expiry':
        plural = 'es' if count != 1 else ''
        return f"{count} batch{plural} expiring within {EXPIRY_WARN_DAYS} days"
    if check_type == 'below_msl':
        return f"{count} material{'s' if count != 1 else ''} at or below MSL"
    if check_type == 'mr_pending':
        return f"{count} Material Request{'s' if count != 1 else ''} awaiting fulfilment"
    if check_type == 'in_transit':
        return f"{count} transfer{'s' if count != 1 else ''} in transit (Material IN pending)"
    if check_type == 'audit_stale':
        return f"No audit session in the last {AUDIT_STALE_DAYS} days"
    return f"{count} pending"


# ─────────────────────────────────────────────────────────────────────────────
# NOTIFICATION LOGGING
# Mirror the agent's pending items into the shared notification store so they
# appear in the topbar bell + history, each with a deep-link. The agent owns
# the 'agent:' dedupe-key namespace (distinct from the dashboard's task:/alert:).
# ─────────────────────────────────────────────────────────────────────────────

# Map each agent check type → how it's logged as a notification.
#   • Overlapping signals reuse the DASHBOARD's dedupe_key so they update the
#     SAME row instead of creating a duplicate (mr_pending, in_transit). Their
#     queries are identical to the dashboard's, so the count is consistent.
#   • 'below_msl' is intentionally NOT logged here: the dashboard already
#     surfaces those materials via its (mutually-exclusive) Below MSL + Zero
#     Stock notifications, and the agent's definition differs (includes zero),
#     so logging it would both duplicate and conflict.
#   • Agent-unique signals keep the 'agent:' namespace (expiry 60d, audit).
_AGENT_NOTIF_META = {
    'expiry':      {'key': 'agent:expiry',            'cat': 'agent', 'link': 'expiry',
                    'sev': 'warn',  'title': 'Batches expiring soon'},
    'mr_pending':  {'key': 'task:material_requests',  'cat': 'task',  'link': 'material_requests',
                    'sev': 'info',  'title': 'Material Requests'},
    'in_transit':  {'key': 'task:transfers_in_transit','cat': 'task', 'link': 'transfers_in_transit',
                    'sev': 'warn',  'title': 'Transfers In-Transit'},
    'audit_stale': {'key': 'agent:audit_stale',       'cat': 'agent', 'link': 'audit',
                    'sev': 'error', 'title': 'Stock audit overdue'},
    # 'below_msl' deliberately omitted — covered by the dashboard.
}


def _log_agent_notifications(conn, pending):
    """Upsert agent pending items as notifications. Overlapping items merge
    into the dashboard's row (shared key); unique ones live under 'agent:'.
    Resolves ONLY cleared 'agent:'-owned rows — the dashboard owns task:/alert:
    resolution, so merged rows are left for it to clear. Best-effort; the
    caller wraps this in try/except. Imports the shared helpers lazily."""
    try:
        from inventory import inventory_reports as _irep
    except ImportError:
        import inventory_reports as _irep

    _irep.ensure_notification_tables(conn)

    items = []
    for p in (pending or []):
        ctype = p.get("type")
        meta = _AGENT_NOTIF_META.get(ctype)
        if not meta:
            continue  # not logged (e.g. below_msl)
        items.append({
            "dedupe_key": meta['key'],
            "category":   meta['cat'],
            "count":      int(p.get("count") or 0),
            "title":      meta['title'],
            "body":       p.get("message") or "",
            "link_key":   meta['link'],
            "severity":   meta['sev'],
        })
    # Resolve ONLY agent-owned rows here. Merged task:/alert: rows are managed
    # (and resolved when cleared) by the dashboard sync, so we don't touch them.
    _irep.upsert_notifications(conn, items, ("agent:",))
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRATION
# ─────────────────────────────────────────────────────────────────────────────

def register_inventory_agent(app):
    """Mount the agent endpoint. Idempotent."""
    if getattr(app, "_inventory_agent_registered", False):
        return
    app._inventory_agent_registered = True

    @app.route("/api/inventory_mgmt/agent/pending", methods=["GET"])
    @_login_required
    def api_inv_agent_pending():
        conn = sampling_portal.get_db_connection()
        if not conn:
            # Don't 500 — return empty so the frontend silently skips its toast.
            return jsonify({"status": "ok", "pending": [],
                            "checked_at": datetime.now().isoformat(timespec='seconds'),
                            "note": "DB unavailable"})
        pending = []
        try:
            checks = [
                ('expiry',      _check_expiry),
                ('below_msl',   _check_below_msl),
                ('mr_pending',  _check_mr_pending),
                ('in_transit',  _check_in_transit),
                ('audit_stale', _check_audit_stale),
            ]
            for name, fn in checks:
                try:
                    n = int(fn(conn) or 0)
                except Exception:
                    n = 0
                if n > 0:
                    pending.append({
                        "type":    name,
                        "count":   n,
                        "message": _format_message(name, n),
                    })

            # ── Log these into the shared notification store ──────────────
            # The agent owns the 'agent:' dedupe-key namespace. Each pending
            # item becomes (or refreshes) one notification row with a deep-link;
            # cleared checks resolve automatically. Kept best-effort so a
            # logging hiccup never breaks the agent's own response.
            try:
                _log_agent_notifications(conn, pending)
            except Exception as _e:
                print("⚠️ [InventoryAgent] notification logging skipped:", _e)
        finally:
            try: conn.close()
            except Exception: pass
        return jsonify({
            "status":     "ok",
            "checked_at": datetime.now().isoformat(timespec='seconds'),
            "pending":    pending,
            "config": {
                "expiry_warn_days": EXPIRY_WARN_DAYS,
                "audit_stale_days": AUDIT_STALE_DAYS,
            },
        })

    print("✅ [InventoryAgent] route registered (/api/inventory_mgmt/agent/pending)")
