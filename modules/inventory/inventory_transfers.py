"""
inventory.inventory_transfers
─────────────────────────────
Stock Transfer Voucher module for RM (Raw Material) packages.

Workflow (mirrors PM Stock's pm_transfers exactly):
    out_started  →  in_pending  →  received
                 ↘  cancelled (from any state)

Stages
    out_started   Voucher created at source. User is actively scanning
                  packages OUT. Each scan flips the package to
                  'in_transit' and writes a movement row.
    in_pending    OUT submitted. Packages physically moving between
                  godowns. Awaiting destination receipt scan.
    received      Destination scanned every package IN. Packages flip
                  back to 'in_stock' at the destination godown.
    cancelled     Cancelled from any prior state. Reversal logic
                  depends on which state we were in.

Tables (auto-created on first call to _ensure_schema())
    rm_stock_transfers           voucher headers
    rm_stock_transfer_boxes      voucher line items (which packages)
    rm_box_movements             reused — audit trail of every scan

URL routes — all under /api/inventory_godown/transfers/* (unchanged
prefix, so the frontend nav/CSS doesn't need to track which Python
module owns each endpoint):

    GET  /list
    GET  /in_transit                 (for dashboard chip)
    GET  /get?transfer_id=N
    POST /start                      → status='out_started'
    POST /<tid>/scan_out             → scan one package OUT
    POST /<tid>/unscan_out           → undo a scan (during OUT session)
    POST /<tid>/submit_out           → finalize OUT, status='in_pending'
    POST /<tid>/scan_in              → scan one package IN at destination
    POST /<tid>/unscan_in            → undo IN scan
    POST /<tid>/confirm_receipt      → finalize IN, status='received'
    POST /<tid>/cancel               → cancel, with stage-aware reversal
    GET  /lookup_package?code=&from_godown_id=  → validate before scan_out

PM Stock parity rules enforced (per Tarak's choices):
    1. Anti-fraud: the user who submitted the OUT cannot confirm the IN.
       A different user must do the IN side.
    2. Strict reconciliation: confirm_receipt requires every scanned-OUT
       package to also be scanned-IN. No partial confirm.
    3. Each side requires per-package scanning (not single-click).

Permissions
    /list, /in_transit, /get, /lookup_package  →  any logged-in user
    /start, /scan_out, /unscan_out, /submit_out,
    /scan_in, /unscan_in, /confirm_receipt,
    /cancel                                     →  @_edit_required
                                                    (admin / sonal / tarak)
"""

from __future__ import annotations
import re
import traceback
from functools import wraps
from datetime import date

from flask import jsonify, request, session

import sampling_portal


# ════════════════════════════════════════════════════════════════════════
# PERMISSION HELPERS — match the rest of the inventory module
# ════════════════════════════════════════════════════════════════════════

def _can_inventory() -> bool:
    return bool(session.get("logged_in"))


def _can_edit_inventory() -> bool:
    """True when the current user is allowed to create / modify transfers.

    Order of precedence:
      1. Not logged in → False
      2. Admin role / hard-coded power users (sonal, tarak) → True (legacy
         bypass; matches the rest of the inventory module).
      3. Per-feature access cap 'stock_transfer' enabled on the user's
         row in inventory_user_access → True. This is what the User Access
         Control modal toggles. Fail-open on lookup errors so a missing
         table or import doesn't lock out admins.

    Without (3), a manager with stock_transfer enabled would still see
    "Edit permission required" on every action — which was the original
    bug. The cap is the source of truth; the legacy role check is just a
    fast-path for admins.
    """
    if not session.get("logged_in"):
        return False
    role = (session.get("User_Type") or "").strip().lower()
    uid  = (session.get("UID") or "").strip().lower()
    if role in {"admin"} or uid in {"sonal", "tarak"}:
        return True
    # Per-feature access cap. Best-effort import — the inventory_access
    # module may not be present in every deployment.
    try:
        try:
            from inventory import inventory_access as _ia
        except Exception:
            import inventory_access as _ia
        return bool(_ia._inv_user_has_access("stock_transfer"))
    except Exception:
        # If anything goes wrong, fail closed only for non-admins. We
        # already excluded admins above, so this returns False — which
        # matches the old behaviour exactly.
        return False


# ════════════════════════════════════════════════════════════════════════
# DEPLOYMENT MARKER — prints on Flask startup so the user can confirm the
# new cap-aware code is actually loaded. Look for this in your Flask logs:
#   [InventoryTransfers] cap-aware edit gate v3 — stock_transfer
# If you DON'T see it, Flask is still running the old file. Restart it.
# ════════════════════════════════════════════════════════════════════════
print("✅ [InventoryTransfers] cap-aware edit gate v7 — adds inspect_transfer diagnostic")


def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _can_inventory():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


def _edit_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _can_edit_inventory():
            return jsonify({"status": "error",
                            "message": "Edit permission required"}), 403
        return f(*args, **kwargs)
    return wrapper


def _user() -> str:
    return (session.get("UID") or session.get("User_Name") or "system")[:64]


# ════════════════════════════════════════════════════════════════════════
# RM BOX-CODE REGEX  (matches inventory_godown.py for consistency)
# ════════════════════════════════════════════════════════════════════════
_RM_BOX_CODE_RE = re.compile(
    r"^RM-("
    r"[A-Z]{1,3}\d{7}"
    r"|"
    r"[A-Z0-9]{1,10}-(?:G|OP)\d{3,5}-B\d{2,4}"
    r")$",
    re.IGNORECASE,
)


# ════════════════════════════════════════════════════════════════════════
# SCHEMA  — idempotent, runs at app startup
# ════════════════════════════════════════════════════════════════════════

def _ensure_schema():
    """Create or migrate rm_stock_transfers and rm_stock_transfer_boxes."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("⚠️  [InventoryTransfers] DB connection unavailable at startup")
        return
    try:
        # ── Header table ───────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_stock_transfers (
                transfer_id     INT AUTO_INCREMENT PRIMARY KEY,
                transfer_no     VARCHAR(40) NOT NULL UNIQUE,
                in_voucher_no   VARCHAR(40) DEFAULT NULL UNIQUE,
                transfer_date   DATE NOT NULL,
                from_godown_id  INT NOT NULL,
                to_godown_id    INT NOT NULL,
                status          ENUM('draft','out_started','in_pending',
                                     'received','cancelled','posted')
                                  NOT NULL DEFAULT 'out_started',
                total_boxes     INT NOT NULL DEFAULT 0,
                total_qty       DECIMAL(14,3) NOT NULL DEFAULT 0,
                request_id      INT DEFAULT NULL,
                remarks         TEXT,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_by      VARCHAR(64) DEFAULT NULL,
                out_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
                out_by          VARCHAR(64) DEFAULT NULL,
                in_at           DATETIME DEFAULT NULL,
                in_by           VARCHAR(64) DEFAULT NULL,
                cancelled_at    DATETIME DEFAULT NULL,
                cancelled_by    VARCHAR(64) DEFAULT NULL,
                INDEX ix_rm_tr_from   (from_godown_id),
                INDEX ix_rm_tr_to     (to_godown_id),
                INDEX ix_rm_tr_date   (transfer_date),
                INDEX ix_rm_tr_status (status),
                INDEX ix_rm_tr_dest_status (to_godown_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # ── Voucher lines (which boxes go on this voucher) ─────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_stock_transfer_boxes (
                transfer_id  INT NOT NULL,
                box_id       INT NOT NULL,
                PRIMARY KEY (transfer_id, box_id),
                INDEX ix_rm_tr_box_box (box_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # ── Edit-audit log (mirrors PM Stock's pattern) ────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_transfer_edit_log (
                log_id       INT AUTO_INCREMENT PRIMARY KEY,
                transfer_id  INT NOT NULL,
                action       VARCHAR(40) NOT NULL,
                detail       TEXT,
                by_user      VARCHAR(64) DEFAULT NULL,
                at_ts        DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_rm_trel_transfer (transfer_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # ── Migration: legacy single-stage schema → two-stage ──────────
        # If rm_stock_transfers existed pre-May-16-2026 (single-stage
        # version), add the new columns and broaden the status enum.
        # All ALTERs are guarded by SHOW COLUMNS so they're idempotent.
        try:
            cols = conn.execute("SHOW COLUMNS FROM rm_stock_transfers").fetchall()
            col_names = {
                (c["Field"] if isinstance(c, dict) else c[0]).lower()
                for c in cols
            }
            adds = []
            if "out_at"       not in col_names:
                adds.append("ADD COLUMN out_at DATETIME DEFAULT CURRENT_TIMESTAMP "
                            "AFTER created_by")
            if "out_by"       not in col_names:
                adds.append("ADD COLUMN out_by VARCHAR(64) DEFAULT NULL AFTER out_at")
            if "in_at"        not in col_names:
                adds.append("ADD COLUMN in_at DATETIME DEFAULT NULL AFTER out_by")
            if "in_by"        not in col_names:
                adds.append("ADD COLUMN in_by VARCHAR(64) DEFAULT NULL AFTER in_at")
            if "total_boxes"  not in col_names:
                adds.append("ADD COLUMN total_boxes INT NOT NULL DEFAULT 0")
            if "request_id"   not in col_names:
                # Phase 2: optional link to the Material Request this transfer
                # fulfils (stamped when created via the Fulfill button).
                adds.append("ADD COLUMN request_id INT DEFAULT NULL")
            if "in_voucher_no" not in col_names:
                # 2026-05-30: two-number scheme. OUT side keeps `transfer_no`
                # (allocated at /start), IN side gets its own number stamped
                # at /submit_out when status flips out_started → in_pending.
                # NULL on legacy rows + on drafts that never reached IN.
                # UNIQUE index added separately because some MySQL versions
                # reject UNIQUE inside an ADD COLUMN list when mixed with
                # other adds; we do it as a follow-up ALTER below.
                adds.append("ADD COLUMN in_voucher_no VARCHAR(40) DEFAULT NULL")
            if adds:
                conn.execute("ALTER TABLE rm_stock_transfers "
                             + ", ".join(adds))
                print(f"✅ [InventoryTransfers] migrated rm_stock_transfers "
                      f"(+{len(adds)} columns)")
            # Always try to broaden status enum (idempotent — MySQL allows
            # re-running MODIFY COLUMN; if the enum already has these values
            # nothing changes).
            try:
                conn.execute("""
                    ALTER TABLE rm_stock_transfers
                    MODIFY COLUMN status
                    ENUM('draft','out_started','in_pending',
                         'received','cancelled','posted')
                    NOT NULL DEFAULT 'out_started'
                """)
            except Exception:
                pass
            # Also rename 'package_count' → 'total_boxes' if it exists
            # (used in earlier single-stage version of the schema).
            if "package_count" in col_names and "total_boxes" in col_names:
                # Both exist — copy data, then drop package_count
                try:
                    conn.execute("UPDATE rm_stock_transfers "
                                 "SET total_boxes = package_count "
                                 "WHERE total_boxes = 0 AND package_count > 0")
                    conn.execute("ALTER TABLE rm_stock_transfers "
                                 "DROP COLUMN package_count")
                    print("✅ [InventoryTransfers] migrated package_count → total_boxes")
                except Exception:
                    pass
            # UNIQUE index on in_voucher_no — added separately so it works
            # whether the column was just created above or was already
            # present from a fresh CREATE TABLE. Check information_schema
            # before adding so reruns don't bleat on duplicate-key errors.
            try:
                idx_row = conn.execute("""
                    SELECT COUNT(*) AS n
                    FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME   = 'rm_stock_transfers'
                      AND INDEX_NAME   = 'ix_rm_tr_in_vno'
                """).fetchone()
                _has_idx = int((idx_row or {}).get("n") or 0) > 0
            except Exception:
                _has_idx = False
            if not _has_idx:
                try:
                    conn.execute(
                        "ALTER TABLE rm_stock_transfers "
                        "ADD UNIQUE INDEX ix_rm_tr_in_vno (in_voucher_no)"
                    )
                    print("✅ [InventoryTransfers] added UNIQUE index ix_rm_tr_in_vno")
                except Exception as e:
                    print(f"ℹ️  [InventoryTransfers] in_voucher_no uniq idx skipped: {e}")
        except Exception as e:
            print(f"ℹ️  [InventoryTransfers] schema migration skipped: {e}")

        conn.commit()
    except Exception as ex:
        traceback.print_exc()
        try: conn.rollback()
        except Exception: pass
    finally:
        try: conn.close()
        except Exception: pass


# ════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════

def _next_out_voucher_no(conn) -> str:
    """
    Allocate the next Material OUT voucher number in OUT/RM/####/YY-YY
    format. Year boundary is April 1 (Indian financial year).

    Backward-compat: scans BOTH the new OUT/RM/... prefix and the legacy
    TR/RM/... prefix within the same FY, then picks max(seq)+1. That way
    when an install switches over mid-year, the OUT numbering continues
    from wherever TR/RM/... left off instead of restarting at 0001 and
    colliding-by-eye with the older numbers in the same list.
    """
    today = date.today()
    fy_start = today.year if today.month >= 4 else today.year - 1
    fy_label = f"{str(fy_start)[2:]}-{str(fy_start + 1)[2:]}"
    suffix = f"/{fy_label}"
    # Pull every voucher (old or new prefix) in this FY, take max seq
    rows = conn.execute(
        "SELECT transfer_no FROM rm_stock_transfers "
        "WHERE (transfer_no LIKE %s OR transfer_no LIKE %s) "
        "  AND transfer_no LIKE %s",
        (f"OUT/RM/%", f"TR/RM/%", f"%{suffix}")
    ).fetchall() or []
    max_seq = 0
    for r in rows:
        vno = r["transfer_no"] if hasattr(r, "get") else r[0]
        if not vno:
            continue
        m = re.search(r"(?:OUT|TR)/RM/(\d+)/", vno)
        if m:
            try:
                n = int(m.group(1))
                if n > max_seq:
                    max_seq = n
            except ValueError:
                pass
    return f"OUT/RM/{max_seq + 1:04d}{suffix}"


def _next_in_voucher_no(conn) -> str:
    """
    Allocate the next Material IN voucher number in IN/RM/####/YY-YY
    format. Independent FY-scoped sequence from the OUT side — IN/RM/0001
    can coexist with OUT/RM/0017 in the same financial year.
    """
    today = date.today()
    fy_start = today.year if today.month >= 4 else today.year - 1
    fy_label = f"{str(fy_start)[2:]}-{str(fy_start + 1)[2:]}"
    suffix = f"/{fy_label}"
    rows = conn.execute(
        "SELECT in_voucher_no FROM rm_stock_transfers "
        "WHERE in_voucher_no IS NOT NULL "
        "  AND in_voucher_no LIKE %s "
        "  AND in_voucher_no LIKE %s",
        (f"IN/RM/%", f"%{suffix}")
    ).fetchall() or []
    max_seq = 0
    for r in rows:
        vno = r["in_voucher_no"] if hasattr(r, "get") else r[0]
        if not vno:
            continue
        m = re.search(r"IN/RM/(\d+)/", vno)
        if m:
            try:
                n = int(m.group(1))
                if n > max_seq:
                    max_seq = n
            except ValueError:
                pass
    return f"IN/RM/{max_seq + 1:04d}{suffix}"


# Legacy alias — callers that still say _next_transfer_no get the OUT
# allocator. Kept until every reference is migrated; do NOT rely on this
# in new code, call _next_out_voucher_no directly.
def _next_transfer_no(conn) -> str:
    return _next_out_voucher_no(conn)


def _log_transfer_edit(conn, transfer_id: int, action: str, detail: str = ""):
    """Insert a row in rm_transfer_edit_log for audit history."""
    try:
        conn.execute(
            "INSERT INTO rm_transfer_edit_log "
            "(transfer_id, action, detail, by_user) VALUES (%s,%s,%s,%s)",
            (transfer_id, action[:40], (detail or "")[:1000], _user())
        )
    except Exception:
        # Audit failures should never break the main operation
        pass


def _rm_boxes_has_batch(conn) -> bool:
    """
    rm_boxes.batch_num is added by inventory_godown only on installs that
    ran the opening-stock paths, so it may be absent. inventory_godown
    guards every reference (sel_batch = "b.batch_num" if ... else "NULL");
    we mirror that here so transfer queries don't 500 on installs lacking
    the column. Probed per-call (cheap SHOW COLUMNS) for correctness.
    """
    try:
        for c in conn.execute("SHOW COLUMNS FROM rm_boxes").fetchall():
            name = c["Field"] if hasattr(c, "get") else c[0]
            if str(name).lower() == "batch_num":
                return True
    except Exception:
        pass
    return False


def _is_out_creator(conn, transfer_id: int) -> bool:
    """
    Returns True if the current user submitted the OUT side of this
    transfer (i.e. they created or finalized the out_started → in_pending
    transition). Used to enforce PM Stock's separation-of-duties rule.
    """
    user = _user().lower()
    if not user:
        return False
    row = conn.execute(
        "SELECT out_by, created_by FROM rm_stock_transfers WHERE transfer_id=%s",
        (transfer_id,)
    ).fetchone()
    if not row:
        return False
    out_by     = (row["out_by"]     or "").strip().lower()
    created_by = (row["created_by"] or "").strip().lower()
    return user == out_by or user == created_by


def _set_short_lock_timeout(conn):
    """
    Set a short InnoDB row-lock wait timeout (3 seconds) for the current
    session. Used by endpoints that take row-level FOR UPDATE locks on
    rm_boxes — if another concurrent request is holding the lock, we
    prefer to fail fast with a clear error rather than hang the user's
    browser for the default 50 seconds.

    Safe to call on every request (it's session-scoped, not persistent).
    Wrapped in try/except so a permissions issue here can't break the
    main request flow.
    """
    try:
        conn.execute("SET SESSION innodb_lock_wait_timeout = 3")
    except Exception:
        pass


def _is_lock_error(exc) -> bool:
    """
    Detect MySQL lock-related errors so we can return a user-friendly
    'Another user is editing this — try again in a moment' instead of a
    raw 500. Covers:
      1205 — Lock wait timeout exceeded
      1213 — Deadlock found when trying to get lock
    """
    msg = str(exc).lower()
    return ("lock wait timeout" in msg or
            "deadlock" in msg or
            "1205" in msg or "1213" in msg)


# ════════════════════════════════════════════════════════════════════════
# REGISTER ROUTES
# ════════════════════════════════════════════════════════════════════════

def register_inventory_transfers(app):
    """Wire all transfer endpoints onto the given Flask app. Idempotent."""
    if getattr(app, "_inventory_transfers_registered", False):
        return
    app._inventory_transfers_registered = True

    _ensure_schema()

    # ─── DIAGNOSTIC (temporary — remove after the cap-gate bug is closed) ─
    # Tells the truth about what the backend thinks of the current user.
    # Open it logged in as the affected user:
    #   http://192.168.2.91/api/inventory_godown/_diag/edit_gate
    # The response shows session keys, the cap value the access module is
    # returning, and what _can_edit_inventory() decides. If the cap is
    # 'on' but _can_edit_inventory() is False, the issue is in the cap
    # lookup, not session. If the cap is missing/off, the issue is in
    # User Access Control persistence. If session is empty, the user
    # isn't really logged in.
    @app.route("/api/inventory_godown/_diag/edit_gate", methods=["GET"])
    def api_diag_edit_gate():
        sess_view = {
            "logged_in": bool(session.get("logged_in")),
            "UID":       session.get("UID"),
            "User_Name": session.get("User_Name"),
            "User_Type": session.get("User_Type"),
        }
        cap_value = None
        cap_error = None
        try:
            try:
                from inventory import inventory_access as _ia
            except Exception:
                import inventory_access as _ia
            try:
                cap_value = bool(_ia._inv_user_has_access("stock_transfer"))
            except Exception as e:
                cap_error = f"cap lookup raised: {e}"
            # Also dump the raw row so we can see what's stored
            raw_row = None
            try:
                d = _ia._inv_user_access_dict()
                raw_row = {k: d.get(k) for k in ("stock_transfer","simple_transfer","manage_godown","material_request")}
            except Exception as e:
                raw_row = f"dict lookup raised: {e}"
        except Exception as e:
            cap_error = f"inventory_access import failed: {e}"
            raw_row = None
        return jsonify({
            "session":          sess_view,
            "stock_transfer_cap_says_yes": cap_value,
            "raw_access_row":   raw_row,
            "cap_error":        cap_error,
            "can_edit_now":     _can_edit_inventory(),
            "module_version":   "cap-aware edit gate v6 (print_data + movement_at)",
        })

    # ─── DIAGNOSTIC: inspect a transfer's raw DB state ───────────────────
    # Open this URL with ?vno=OUT/RM/0001/26-27 or ?vno=IN/RM/0001/26-27
    # (or any legacy TR/RM/... number) and you'll get back the exact rows
    # in the database for that voucher: the header row, every junction
    # row in rm_stock_transfer_boxes, and every movement in
    # rm_box_movements. This bypasses the JS rendering and tells the
    # truth — useful when a voucher visually looks empty but might
    # actually have rows somewhere.
    @app.route("/api/inventory_godown/_diag/inspect_transfer", methods=["GET"])
    def api_diag_inspect_transfer():
        vno = (request.args.get("vno") or "").strip()
        if not vno:
            return jsonify({"status": "error",
                            "message": "Pass ?vno=OUT/RM/.... or ?vno=IN/RM/...."}), 400
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB unavailable"}), 500
        try:
            header = conn.execute(
                "SELECT * FROM rm_stock_transfers "
                "WHERE transfer_no=%s OR in_voucher_no=%s",
                (vno, vno)
            ).fetchone()
            if not header:
                conn.close()
                return jsonify({"status": "not_found",
                                "message": f"No voucher matching {vno} "
                                           "(checked transfer_no and in_voucher_no)"}), 404
            h = dict(header)
            tid = int(h.get("transfer_id") or 0)
            # Stringify timestamps so jsonify can serialise
            for k in list(h.keys()):
                v = h[k]
                if v is not None and not isinstance(v, (int, float, str, bool)):
                    h[k] = str(v)

            junction = conn.execute(
                "SELECT * FROM rm_stock_transfer_boxes WHERE transfer_id=%s",
                (tid,)
            ).fetchall()
            jrows = []
            for r in junction:
                d = dict(r)
                for k in list(d.keys()):
                    v = d[k]
                    if v is not None and not isinstance(v, (int, float, str, bool)):
                        d[k] = str(v)
                jrows.append(d)

            movements = conn.execute(
                "SELECT * FROM rm_box_movements WHERE transfer_id=%s "
                "ORDER BY movement_id",
                (tid,)
            ).fetchall()
            mrows = []
            for r in movements:
                d = dict(r)
                for k in list(d.keys()):
                    v = d[k]
                    if v is not None and not isinstance(v, (int, float, str, bool)):
                        d[k] = str(v)
                mrows.append(d)

            # Also show what boxes are currently sitting at the FROM godown
            # of this transfer in 'in_stock' state — context for why a scan
            # might have failed.
            from_id = h.get("from_godown_id")
            available = []
            if from_id:
                rows = conn.execute(
                    "SELECT box_id, box_code, material_id, current_status, "
                    "       per_box_qty, uom "
                    "FROM rm_boxes "
                    "WHERE current_godown_id=%s AND current_status='in_stock' "
                    "LIMIT 50",
                    (from_id,)
                ).fetchall()
                available = [dict(r) for r in rows]

            return jsonify({
                "status":              "ok",
                "header":              h,
                "junction_count":      len(jrows),
                "junction_rows":       jrows,
                "movement_count":      len(mrows),
                "movement_rows":       mrows,
                "available_at_source": available,
            })
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ─── PRINT DATA ────────────────────────────────────────────────────
    # Returns the voucher header + per-box rows formatted for printing.
    # The frontend opens a popup window, injects the response into a
    # print-friendly HTML template, and calls window.print(). Distinct
    # from /get because:
    #   • includes expiry_date alongside batch_num (FEFO traceability)
    #   • groups can be filtered by side: out vs in (scan timing)
    #   • date columns are pre-stringified to DD/MM/YYYY (the standing
    #     inventory date format)
    # Side parameter ('out' | 'in') controls which scan-side is shown
    # as the "primary" timestamp. Both sides always include the full
    # box list since the voucher number covers both phases.
    @app.route("/api/inventory_godown/transfers/<int:tid>/print_data",
               methods=["GET"])
    @_login_required
    def api_transfer_print_data(tid):
        side = (request.args.get("side") or "out").strip().lower()
        if side not in ("out", "in"):
            side = "out"
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error",
                            "message": "DB connection failed"}), 500
        try:
            header = conn.execute("""
                SELECT t.transfer_id, t.transfer_no, t.in_voucher_no,
                       t.transfer_date,
                       t.status, t.remarks, t.request_id,
                       t.created_at, t.created_by,
                       t.out_at, t.out_by,
                       t.in_at,  t.in_by,
                       t.total_boxes, t.total_qty,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name
                FROM rm_stock_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.transfer_id = %s
            """, (tid,)).fetchone()
            if not header:
                return jsonify({"status": "not_found",
                                "message": "Transfer not found"}), 404
            h = dict(header)
            # Stringify dates → DD/MM/YYYY for consistent display
            def _ddmmyyyy(v):
                if v is None: return ""
                s = str(v)[:10]
                if len(s) == 10 and s[4] == "-" and s[7] == "-":
                    return f"{s[8:10]}/{s[5:7]}/{s[0:4]}"
                return s
            h["transfer_date_fmt"] = _ddmmyyyy(h.get("transfer_date"))
            h["created_at_fmt"]    = str(h.get("created_at") or "")
            h["out_at_fmt"]        = str(h.get("out_at") or "")
            h["in_at_fmt"]         = str(h.get("in_at") or "")
            # Linked Material Request (so the print can show it)
            mr_no = None
            if h.get("request_id"):
                try:
                    mr_row = conn.execute(
                        "SELECT request_no FROM inventory_material_requests "
                        "WHERE id=%s", (h["request_id"],)
                    ).fetchone()
                    if mr_row:
                        mr_no = mr_row["request_no"] if hasattr(mr_row, "get") else mr_row[0]
                except Exception:
                    mr_no = None
            h["request_no"] = mr_no

            # Per-box rows with batch + expiry (FEFO traceability for the print)
            _have_b_batch = _rm_boxes_has_batch(conn)
            _batch_expr = (
                "COALESCE(gi.batch_num, b.batch_num)"
                if _have_b_batch else
                "gi.batch_num"
            )
            # Probe for box-level expiry column; if absent, use the GRN-item one only
            _have_b_exp = False
            try:
                for c in conn.execute("SHOW COLUMNS FROM rm_boxes").fetchall():
                    name = c["Field"] if hasattr(c, "get") else c[0]
                    if str(name).lower() == "expiry_date":
                        _have_b_exp = True
                        break
            except Exception:
                pass
            _exp_expr = (
                "COALESCE(gi.expiry_date, b.expiry_date)"
                if _have_b_exp else
                "gi.expiry_date"
            )
            box_rows = conn.execute(f"""
                SELECT b.box_id, b.box_code, b.material_id,
                       COALESCE(m.material_name,'') AS material_name,
                       b.per_box_qty, b.uom,
                       {_batch_expr} AS batch_num,
                       {_exp_expr}   AS expiry_date,
                       (SELECT MAX(mv.movement_at) FROM rm_box_movements mv
                        WHERE mv.box_id = b.box_id
                          AND mv.transfer_id = %s
                          AND mv.movement_type = 'out') AS out_at,
                       (SELECT MAX(mv.movement_at) FROM rm_box_movements mv
                        WHERE mv.box_id = b.box_id
                          AND mv.transfer_id = %s
                          AND mv.movement_type = 'in')  AS in_at
                FROM rm_stock_transfer_boxes tb
                JOIN rm_boxes b ON b.box_id = tb.box_id
                LEFT JOIN procurement_materials  m  ON m.id  = b.material_id
                LEFT JOIN procurement_grn_items  gi ON gi.id = b.grn_item_id
                WHERE tb.transfer_id = %s
                ORDER BY b.material_id, b.box_code
            """, (tid, tid, tid)).fetchall()
            boxes = []
            for b in box_rows:
                d = dict(b)
                d["box_id"]      = int(d["box_id"])
                d["material_id"] = int(d.get("material_id") or 0)
                d["per_box_qty"] = float(d.get("per_box_qty") or 0)
                d["batch_num"]   = (d.get("batch_num") or "") or "—"
                d["expiry_date_fmt"] = _ddmmyyyy(d.get("expiry_date"))
                d["out_at_fmt"]      = str(d.get("out_at") or "")
                d["in_at_fmt"]       = str(d.get("in_at") or "")
                boxes.append(d)

            # Aggregate per-material totals for the summary block
            agg_map = {}
            for b in boxes:
                k = b["material_id"]
                if k not in agg_map:
                    agg_map[k] = {
                        "material_id":   k,
                        "material_name": b["material_name"],
                        "uom":           b.get("uom") or "",
                        "boxes":         0,
                        "total_qty":     0.0,
                    }
                agg_map[k]["boxes"]     += 1
                agg_map[k]["total_qty"] += b["per_box_qty"]
            items = list(agg_map.values())

            return jsonify({
                "status":  "ok",
                "header":  h,
                "items":   items,
                "boxes":   boxes,
                "side":    side,
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ─── LIST + DASHBOARDS ─────────────────────────────────────────────

    @app.route("/api/inventory_godown/transfers/list", methods=["GET"])
    @_login_required
    def api_transfers_list():
        """List transfers with optional filters."""
        status_filter = (request.args.get("status") or "").strip().lower()
        try:    from_id = int(request.args.get("from_id") or 0)
        except: from_id = 0
        try:    to_id   = int(request.args.get("to_id") or 0)
        except: to_id   = 0
        try:    limit   = max(1, min(int(request.args.get("limit") or 200), 1000))
        except: limit   = 200

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            where, params = [], []
            if status_filter in {"draft","out_started","in_pending",
                                 "received","cancelled","posted"}:
                where.append("t.status = %s"); params.append(status_filter)
            if from_id:
                where.append("t.from_godown_id = %s"); params.append(from_id)
            if to_id:
                where.append("t.to_godown_id = %s"); params.append(to_id)
            sql_where = (" WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(f"""
                SELECT t.*,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name
                FROM rm_stock_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                {sql_where}
                ORDER BY t.transfer_id DESC
                LIMIT {limit}
            """, params).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                for k in ("transfer_date","created_at","out_at","in_at",
                          "cancelled_at"):
                    if d.get(k) is not None:
                        d[k] = str(d[k])
                d["total_boxes"] = int(d.get("total_boxes") or 0)
                d["total_qty"]   = float(d.get("total_qty")   or 0)
                out.append(d)
            return jsonify({"status":"ok","transfers": out, "total": len(out)})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/in_transit", methods=["GET"])
    @_login_required
    def api_transfers_in_transit():
        """Quick endpoint for the 'In Transit' filter chip count."""
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM rm_stock_transfers WHERE status='in_pending'"
            ).fetchone()
            return jsonify({"status":"ok", "count": int((row or {}).get("n") or 0)})
        except Exception as e:
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/find_by_box", methods=["GET"])
    @_login_required
    def api_transfer_find_by_box():
        """Auto-route a scanned package to its in-transit (IN-pending) voucher.

        The destination operator scans ANY in-transit box; this finds which
        IN-pending voucher carries it and returns the transfer_id so the UI can
        open that voucher's Material-IN screen directly — no need to know the
        voucher number. Matches both the QR short_code and the printed box_code.

        Query: ?code=RM-A0000003
        Returns: {status:'ok', transfer_id, transfer_no, in_voucher_no,
                  from_godown_name, to_godown_name, box_code}
                 or {status:'not_found'} / {status:'invalid'}.
        """
        code = (request.args.get("code") or "").strip().upper()
        if not code:
            return jsonify({"status": "error", "message": "code required"}), 400
        if not _RM_BOX_CODE_RE.match(code):
            return jsonify({"status": "invalid",
                            "message": f"'{code}' isn't a recognized RM package code"}), 200
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            # Resolve the scanned value to a box. New QR labels encode the
            # short_code; printed/older labels use box_code. Probe whether the
            # column exists so this is safe on installs without short_code.
            _has_sc = False
            try:
                _has_sc = any(
                    (c["Field"] if hasattr(c, "get") else c[0]) == "short_code"
                    for c in conn.execute("SHOW COLUMNS FROM rm_boxes").fetchall()
                )
            except Exception:
                _has_sc = False
            if _has_sc:
                box = conn.execute(
                    "SELECT box_id, box_code FROM rm_boxes WHERE short_code=%s OR box_code=%s LIMIT 1",
                    (code, code),
                ).fetchone()
            else:
                box = conn.execute(
                    "SELECT box_id, box_code FROM rm_boxes WHERE box_code=%s LIMIT 1", (code,),
                ).fetchone()
            if not box:
                return jsonify({"status": "not_found",
                                "message": f"No package found with code {code}"}), 200

            # Find the IN-pending voucher that carries this box.
            row = conn.execute("""
                SELECT t.transfer_id, t.transfer_no, t.in_voucher_no,
                       gf.name AS from_godown_name, gt.name AS to_godown_name
                FROM rm_stock_transfer_boxes tb
                JOIN rm_stock_transfers t ON t.transfer_id = tb.transfer_id
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE tb.box_id = %s AND t.status = 'in_pending'
                LIMIT 1
            """, (box["box_id"],)).fetchone()
            if not row:
                return jsonify({"status": "not_in_transit",
                                "message": f"{box['box_code']} is not on any in-transit voucher"}), 200
            return jsonify({
                "status": "ok",
                "transfer_id":      int(row["transfer_id"]),
                "transfer_no":      row["transfer_no"],
                "in_voucher_no":    row["in_voucher_no"],
                "from_godown_name": row["from_godown_name"],
                "to_godown_name":   row["to_godown_name"],
                "box_code":         box["box_code"],
            })
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    @app.route("/api/inventory_godown/transfers/get", methods=["GET"])
    @_login_required
    def api_transfer_get():
        """Return full transfer + packages + scan counts."""
        try:
            tid = int(request.args.get("transfer_id") or 0)
        except: tid = 0
        if not tid:
            return jsonify({"status":"error","message":"transfer_id required"}), 400

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            row = conn.execute("""
                SELECT t.*,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name
                FROM rm_stock_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.transfer_id = %s
            """, (tid,)).fetchone()
            if not row:
                return jsonify({"status":"not_found",
                                "message":"Transfer not found"}), 404
            tr = dict(row)
            for k in ("transfer_date","created_at","out_at","in_at","cancelled_at"):
                if tr.get(k) is not None:
                    tr[k] = str(tr[k])
            tr["total_boxes"] = int(tr.get("total_boxes") or 0)
            tr["total_qty"]   = float(tr.get("total_qty")   or 0)

            # Packages on this voucher + per-package scan status.
            # Batch lookup: GRN-created boxes carry their batch on
            # procurement_grn_items.batch_num (via b.grn_item_id), while
            # opening-stock boxes store batch on rm_boxes.batch_num (a
            # later-added column we probe for). COALESCE picks whichever
            # is non-NULL, so the BATCH column populates correctly for
            # both kinds of boxes.
            _have_b_batch = _rm_boxes_has_batch(conn)
            _batch_expr = (
                "COALESCE(gi.batch_num, b.batch_num)"
                if _have_b_batch else
                "gi.batch_num"
            )
            box_rows = conn.execute(f"""
                SELECT b.box_id, b.box_code, b.material_id, m.material_name,
                       b.per_box_qty, b.uom, {_batch_expr} AS batch_num,
                       b.current_godown_id, b.current_status,
                       gc.name AS current_godown_name,
                       (SELECT COUNT(*) FROM rm_box_movements mv
                        WHERE mv.box_id = b.box_id
                          AND mv.transfer_id = %s
                          AND mv.movement_type = 'out')  AS out_count,
                       (SELECT COUNT(*) FROM rm_box_movements mv
                        WHERE mv.box_id = b.box_id
                          AND mv.transfer_id = %s
                          AND mv.movement_type = 'in')   AS in_count
                FROM rm_stock_transfer_boxes tb
                JOIN rm_boxes b ON b.box_id = tb.box_id
                LEFT JOIN procurement_materials  m  ON m.id  = b.material_id
                LEFT JOIN procurement_godowns    gc ON gc.id = b.current_godown_id
                LEFT JOIN procurement_grn_items  gi ON gi.id = b.grn_item_id
                WHERE tb.transfer_id = %s
                ORDER BY b.material_id, b.box_code
            """, (tid, tid, tid)).fetchall()
            packages = []
            for b in box_rows:
                d = dict(b)
                d["box_id"]      = int(d["box_id"])
                d["material_id"] = int(d.get("material_id") or 0)
                d["per_box_qty"] = float(d.get("per_box_qty") or 0)
                d["out_count"]   = int(d.get("out_count") or 0)
                d["in_count"]    = int(d.get("in_count")  or 0)
                d["scanned_out"] = d["out_count"] > 0
                d["scanned_in"]  = d["in_count"]  > 0
                packages.append(d)

            tr["packages"] = packages
            tr["scan_counts"] = {
                "expected": len(packages),
                "scanned_out": sum(1 for p in packages if p["scanned_out"]),
                "scanned_in":  sum(1 for p in packages if p["scanned_in"]),
            }
            return jsonify({"status":"ok","transfer": tr})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    # ─── PACKAGE LOOKUP (used by both scan_out and scan_in) ───────────

    @app.route("/api/inventory_godown/transfers/lookup_package",
               methods=["GET"])
    @_login_required
    def api_transfer_lookup_package():
        """
        Validate a scanned QR for the OUT side (before the voucher exists).
        Used by the New Transfer flow's package picker.

        Query: ?code=RM-A0000003&from_godown_id=12
        """
        code = (request.args.get("code") or "").strip().upper()
        try:    from_id = int(request.args.get("from_godown_id") or 0)
        except: from_id = 0
        if not code:
            return jsonify({"status":"error","message":"code required"}), 400
        if not from_id:
            return jsonify({"status":"error",
                            "message":"Select From Godown first"}), 400
        if not _RM_BOX_CODE_RE.match(code):
            return jsonify({"status":"invalid",
                            "message":f"'{code}' isn't a recognized RM package code"}), 200

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            # Same batch-source fallback as scan_out / transfers_get:
            # COALESCE GRN-side batch with rm_boxes.batch_num so both
            # box origins display correctly. See those endpoints' notes
            # for the rationale.
            _have_b_batch = _rm_boxes_has_batch(conn)
            _batch_expr = (
                "COALESCE(gi.batch_num, b.batch_num)"
                if _have_b_batch else
                "gi.batch_num"
            )
            row = conn.execute(f"""
                SELECT b.box_id, b.box_code, b.material_id,
                       m.material_name, b.per_box_qty, b.uom,
                       {_batch_expr} AS batch_num,
                       b.current_godown_id, b.current_status,
                       g.name AS current_godown_name
                FROM rm_boxes b
                LEFT JOIN procurement_materials m  ON m.id = b.material_id
                LEFT JOIN procurement_godowns   g  ON g.id = b.current_godown_id
                LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
                WHERE b.box_code = %s
            """, (code,)).fetchone()
            if not row:
                return jsonify({"status":"not_found",
                                "message":f"No package found with code {code}"}), 200
            r = dict(row)
            if r["current_status"] != "in_stock":
                return jsonify({"status":"blocked",
                                "message":f"Package {code} is in status "
                                          f"'{r['current_status']}' — cannot transfer"}), 200
            if int(r["current_godown_id"] or 0) != from_id:
                return jsonify({"status":"blocked",
                                "message":f"Package {code} is at "
                                          f"'{r['current_godown_name'] or 'unknown'}', "
                                          f"not the selected From Godown"}), 200
            return jsonify({"status":"ok", "package": {
                "box_id":      int(r["box_id"]),
                "box_code":    r["box_code"],
                "material_id": int(r["material_id"] or 0),
                "material_name": r["material_name"] or "",
                "per_box_qty": float(r["per_box_qty"] or 0),
                "uom":         r["uom"] or "",
                "batch_num":   r["batch_num"] or "",
            }})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    # ─── START / OUT-SIDE WORKFLOW ─────────────────────────────────────

    @app.route("/api/inventory_godown/transfers/start", methods=["POST"])
    @_edit_required
    def api_transfer_start():
        """
        Create a new transfer at status='out_started'. Body:
          { from_godown_id, to_godown_id, transfer_date?, remarks?, box_ids[] }

        If box_ids is supplied, each package is validated, attached to the
        voucher, and a corresponding 'out' movement is logged in
        rm_box_movements (so the OUT side is essentially completed in one
        atomic call). Otherwise the voucher is created empty and the user
        can scan packages via /<tid>/scan_out.
        """
        d = request.get_json(silent=True) or {}
        try:
            from_id = int(d.get("from_godown_id") or 0)
            to_id   = int(d.get("to_godown_id")   or 0)
        except (TypeError, ValueError):
            from_id = to_id = 0
        date_str = (d.get("transfer_date") or "").strip()
        remarks  = (d.get("remarks") or "").strip()
        raw_box_ids = d.get("box_ids") or []
        # Phase 2: optional Material Request this transfer fulfils.
        try:
            req_link_id = int(d.get("request_id") or 0) or None
        except (TypeError, ValueError):
            req_link_id = None

        if not from_id or not to_id:
            return jsonify({"status":"error",
                            "message":"From and To godowns are required"}), 400
        if from_id == to_id:
            return jsonify({"status":"error",
                            "message":"From and To godowns must be different"}), 400
        if not date_str:
            date_str = date.today().isoformat()

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            user = _user()
            transfer_no = _next_out_voucher_no(conn)
            cur = conn.execute("""
                INSERT INTO rm_stock_transfers
                    (transfer_no, transfer_date, from_godown_id, to_godown_id,
                     status, remarks, created_by, out_by, request_id)
                VALUES (%s, %s, %s, %s, 'out_started', %s, %s, %s, %s)
            """, (transfer_no, date_str, from_id, to_id,
                  remarks, user, user, req_link_id))
            tid = cur.lastrowid

            # If box_ids provided, validate + attach + log OUT movements
            attached = 0
            attached_qty = 0.0
            for raw_bid in raw_box_ids:
                try:
                    bid = int(raw_bid)
                except (TypeError, ValueError):
                    continue
                # FOR UPDATE — same race-prevention as scan_out (see comment
                # there). Locks the row so concurrent /start or /scan_out
                # calls on the same package can't both proceed.
                box = conn.execute("""
                    SELECT box_id, box_code, current_godown_id,
                           current_status, per_box_qty
                    FROM rm_boxes WHERE box_id=%s
                    FOR UPDATE
                """, (bid,)).fetchone()
                if not box:
                    continue
                if box["current_status"] != "in_stock":
                    continue
                if int(box["current_godown_id"] or 0) != from_id:
                    continue
                # Attach to voucher
                try:
                    conn.execute(
                        "INSERT INTO rm_stock_transfer_boxes "
                        "(transfer_id, box_id) VALUES (%s, %s)",
                        (tid, bid)
                    )
                except Exception:
                    continue  # duplicate
                qty = float(box["per_box_qty"] or 0)
                # Flip package to in_transit, write OUT movement
                conn.execute(
                    "UPDATE rm_boxes SET current_status='in_transit' "
                    "WHERE box_id=%s",
                    (bid,)
                )
                conn.execute("""
                    INSERT INTO rm_box_movements
                      (box_id, transfer_id, movement_type, from_godown_id,
                       to_godown_id, qty, moved_by, remarks)
                    VALUES (%s, %s, 'out', %s, %s, %s, %s, %s)
                """, (bid, tid, from_id, to_id, qty, user,
                      f"Transfer OUT ({transfer_no})"))
                attached += 1
                attached_qty += qty

            # Update header totals
            conn.execute(
                "UPDATE rm_stock_transfers "
                "SET total_boxes=%s, total_qty=%s WHERE transfer_id=%s",
                (attached, attached_qty, tid)
            )
            _log_transfer_edit(conn, tid, "start_out",
                               f"From={from_id} → To={to_id}; "
                               f"attached {attached} pkg")
            conn.commit()
            return jsonify({"status":"ok",
                            "transfer_id": tid,
                            "transfer_no": transfer_no,
                            "attached":    attached,
                            "total_qty":   attached_qty})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            if _is_lock_error(e):
                return jsonify({"status":"blocked",
                                "message":"Another user is editing one of "
                                          "these packages right now. Try "
                                          "again in a moment."}), 200
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/<int:tid>/scan_out",
               methods=["POST"])
    @_edit_required
    def api_transfer_scan_out(tid):
        """
        Scan a single package OUT for an already-started transfer.
        Validates that:
          - transfer is still in 'out_started' state
          - package exists, is in_stock at the FROM godown
          - not already on this voucher
        Then attaches it, flips to in_transit, writes OUT movement.
        """
        d = request.get_json(silent=True) or {}
        code = (d.get("box_code") or "").strip().upper()
        if not code:
            return jsonify({"status":"error","message":"box_code required"}), 400
        if not _RM_BOX_CODE_RE.match(code):
            return jsonify({"status":"invalid",
                            "message":f"'{code}' isn't a recognized RM package code"}), 200

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "out_started":
                return jsonify({"status":"error",
                                "message":f"Transfer is in '{t['status']}' "
                                          f"state — cannot scan OUT"}), 409

            # Box lookup with FOR UPDATE — locks the rm_boxes row so two
            # concurrent scans of the same QR can't both pass the status
            # check. The lock releases on conn.commit() at the end of the
            # request. Connection has autocommit=False (set in
            # sampling_portal), so this is wrapped in an implicit txn.
            # Batch lookup: GRN-created boxes carry their batch on
            # procurement_grn_items.batch_num (the GRN line). Opening-stock
            # boxes (and any other non-GRN source) store batch directly on
            # rm_boxes.batch_num — but that column was added later, so we
            # probe for it. COALESCE picks whichever is non-NULL.
            _have_b_batch = _rm_boxes_has_batch(conn)
            _batch_expr = (
                "COALESCE(gi.batch_num, b.batch_num)"
                if _have_b_batch else
                "gi.batch_num"
            )
            box = conn.execute(f"""
                SELECT b.box_id, b.box_code, b.current_godown_id,
                       b.current_status, b.per_box_qty, b.uom,
                       b.material_id, b.grn_id, b.source,
                       m.material_name, g.grn_date,
                       {_batch_expr} AS batch_num
                FROM rm_boxes b
                LEFT JOIN procurement_materials m ON m.id = b.material_id
                LEFT JOIN procurement_grn g ON g.id = b.grn_id
                LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
                WHERE b.box_code = %s
                FOR UPDATE
            """, (code,)).fetchone()
            if not box:
                return jsonify({"status":"not_found",
                                "message":f"No package with code {code}"}), 200
            if box["current_status"] != "in_stock":
                return jsonify({"status":"blocked",
                                "message":f"Package {code} is in status "
                                          f"'{box['current_status']}'"}), 200
            if int(box["current_godown_id"] or 0) != int(t["from_godown_id"]):
                return jsonify({"status":"blocked",
                                "message":f"Package {code} is not at the "
                                          f"From Godown"}), 200

            # ── Phase 4: Material Lock enforcement ──
            # A manager/admin lock can block this material from issue (by
            # before-date cutoff or specific GRN). Applies to everyone
            # including admins (a deliberate hold). Checked before FEFO.
            try:
                try:
                    from inventory import inventory_material_lock as _iml
                except Exception:
                    import inventory_material_lock as _iml
                _locked, _why = _iml.material_lock_check(
                    conn,
                    material_id=int(box["material_id"] or 0),
                    godown_id=int(box["current_godown_id"] or 0),
                    grn_id=(int(box["grn_id"]) if box.get("grn_id") else None),
                    grn_date=box.get("grn_date"),
                    batch_no=box.get("batch_num"),
                    is_opening=(str(box.get("source") or "") == "opening"),
                )
            except Exception:
                _locked, _why = (False, None)
            if _locked:
                return jsonify({
                    "status": "locked",
                    "message": f"Package {code} is locked: {_why}",
                }), 200
            # Block scanning a later-expiry box while earlier-expiry stock of
            # the same material is still in stock here — unless the user holds
            # an approved override (consumed here) or is an admin.
            try:
                try:
                    from inventory import inventory_fefo as _ife
                except Exception:
                    import inventory_fefo as _ife
                _fefo = _ife.fefo_check_box(conn, int(box["box_id"]), user=_user())
            except Exception:
                _fefo = {"allowed": True}
            if not _fefo.get("allowed"):
                return jsonify({
                    "status": "fefo_blocked",
                    "message": (f"FEFO violation: package {code} expires "
                                f"{_fefo.get('box_expiry') or '(no expiry)'}, but an "
                                f"earlier-expiry package ({_fefo.get('earliest_box_code')}, "
                                f"exp {_fefo.get('earliest_expiry')}) is still in stock. "
                                f"Use the earlier one first, or request an override."),
                    "fefo": _fefo,
                    "box_id": int(box["box_id"]),
                    "box_code": code,
                }), 200

            # Duplicate-scan check
            dup = conn.execute(
                "SELECT 1 FROM rm_stock_transfer_boxes "
                "WHERE transfer_id=%s AND box_id=%s",
                (tid, int(box["box_id"]))
            ).fetchone()
            if dup:
                return jsonify({"status":"blocked",
                                "message":f"Package {code} already scanned for this transfer"}), 200

            bid = int(box["box_id"])
            qty = float(box["per_box_qty"] or 0)
            conn.execute(
                "INSERT INTO rm_stock_transfer_boxes "
                "(transfer_id, box_id) VALUES (%s, %s)",
                (tid, bid)
            )
            conn.execute(
                "UPDATE rm_boxes SET current_status='in_transit' "
                "WHERE box_id=%s",
                (bid,)
            )
            conn.execute("""
                INSERT INTO rm_box_movements
                  (box_id, transfer_id, movement_type, from_godown_id,
                   to_godown_id, qty, moved_by, remarks)
                VALUES (%s, %s, 'out', %s, %s, %s, %s, %s)
            """, (bid, tid, int(t["from_godown_id"]), int(t["to_godown_id"]),
                  qty, _user(), f"Transfer OUT ({t['transfer_no']})"))

            # Update header running totals
            conn.execute(
                "UPDATE rm_stock_transfers "
                "SET total_boxes = total_boxes + 1, total_qty = total_qty + %s "
                "WHERE transfer_id=%s",
                (qty, tid)
            )
            _log_transfer_edit(conn, tid, "scan_out", f"box={code}")
            conn.commit()
            # Response must include batch_num so the JS package row shows it
            # in the "BATCH" column. Two possible sources for batch:
            #   • box["batch_num"] — populated for boxes joined via grn_item
            #     (the main path; GRN-created boxes carry their batch on
            #      procurement_grn_items)
            #   • box["batch_num"] may also already be set if rm_boxes has
            #     its own batch_num column (opening-stock path).
            # The SELECT at the top of this endpoint reads gi.batch_num as
            # an alias, so either source ends up in box["batch_num"].
            return jsonify({"status":"ok", "package": {
                "box_id":        bid,
                "box_code":      box["box_code"],
                "material_name": box["material_name"] or "",
                "per_box_qty":   qty,
                "uom":           box["uom"] or "",
                "batch_num":     (box.get("batch_num") if hasattr(box, "get") else box["batch_num"]) or "",
            }})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            # Concurrency-related errors get a friendly retry message,
            # not a raw 500. Probably caused by another user scanning the
            # same QR at the same moment.
            if _is_lock_error(e):
                return jsonify({"status":"blocked",
                                "message":"Another user is scanning this "
                                          "package right now. Try again in "
                                          "a moment."}), 200
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/<int:tid>/unscan_out",
               methods=["POST"])
    @_edit_required
    def api_transfer_unscan_out(tid):
        """
        Undo a single OUT scan (during OUT session only, i.e. status
        must still be out_started).
        Body: { box_id: int }   OR   { box_code: "RM-..." }
        """
        d = request.get_json(silent=True) or {}
        try:    bid = int(d.get("box_id") or 0)
        except: bid = 0
        code = (d.get("box_code") or "").strip().upper()

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "out_started":
                return jsonify({"status":"error",
                                "message":"Can only undo scans while transfer is in out_started state"}), 409
            if not bid and code:
                row = conn.execute(
                    "SELECT box_id FROM rm_boxes WHERE box_code=%s", (code,)
                ).fetchone()
                bid = int(row["box_id"]) if row else 0
            if not bid:
                return jsonify({"status":"error","message":"box_id or box_code required"}), 400

            # Get box qty for total adjustment
            box = conn.execute(
                "SELECT per_box_qty FROM rm_boxes WHERE box_id=%s", (bid,)
            ).fetchone()
            qty = float((box or {}).get("per_box_qty") or 0)

            conn.execute(
                "DELETE FROM rm_stock_transfer_boxes "
                "WHERE transfer_id=%s AND box_id=%s",
                (tid, bid)
            )
            conn.execute(
                "DELETE FROM rm_box_movements "
                "WHERE transfer_id=%s AND box_id=%s AND movement_type='out'",
                (tid, bid)
            )
            # Flip package back to in_stock
            conn.execute(
                "UPDATE rm_boxes SET current_status='in_stock' WHERE box_id=%s",
                (bid,)
            )
            # Decrement header totals
            conn.execute(
                "UPDATE rm_stock_transfers "
                "SET total_boxes = GREATEST(total_boxes - 1, 0), "
                "    total_qty   = GREATEST(total_qty   - %s, 0) "
                "WHERE transfer_id=%s",
                (qty, tid)
            )
            _log_transfer_edit(conn, tid, "unscan_out", f"box_id={bid}")
            conn.commit()
            return jsonify({"status":"ok"})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/<int:tid>/submit_out",
               methods=["POST"])
    @_edit_required
    def api_transfer_submit_out(tid):
        """
        Finalize the OUT side. Flips status out_started → in_pending.
        Requires at least one scanned package.
        """
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "out_started":
                return jsonify({"status":"error",
                                "message":f"Transfer is in '{t['status']}' state"}), 409
            if int(t.get("total_boxes") or 0) <= 0:
                return jsonify({"status":"error",
                                "message":"Add at least one package before submitting OUT"}), 400

            # Allocate the Material IN voucher number now — at this point
            # the OUT side is sealed and the transfer enters the IN-pending
            # phase. The IN number is what the destination scans against
            # and what appears in the In-Transit list / IN modal header.
            # Defensive: if the row already has an in_voucher_no (e.g.
            # someone re-submitted via an admin tool), keep it.
            in_vno_existing = (t.get("in_voucher_no") or "").strip() if hasattr(t, "get") else ""
            if in_vno_existing:
                in_voucher_no = in_vno_existing
            else:
                in_voucher_no = _next_in_voucher_no(conn)

            conn.execute(
                "UPDATE rm_stock_transfers SET status='in_pending', "
                "in_voucher_no=%s, out_at=NOW(), out_by=%s "
                "WHERE transfer_id=%s",
                (in_voucher_no, _user(), tid)
            )
            _log_transfer_edit(conn, tid, "submit_out",
                               f"{t['total_boxes']} pkg · qty {t['total_qty']} · "
                               f"IN vno={in_voucher_no}")
            conn.commit()
            return jsonify({"status":"ok",
                            "transfer_no":   t["transfer_no"],
                            "in_voucher_no": in_voucher_no,
                            "total_boxes":   int(t["total_boxes"] or 0),
                            "total_qty":     float(t["total_qty"]  or 0)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    # ─── IN-SIDE WORKFLOW ──────────────────────────────────────────────

    @app.route("/api/inventory_godown/transfers/<int:tid>/scan_in",
               methods=["POST"])
    @_edit_required
    def api_transfer_scan_in(tid):
        """
        Scan a single package IN at the destination. Validates that:
          - transfer is still in 'in_pending' state
          - package is on this voucher (was scanned OUT)
          - hasn't already been scanned IN for this voucher
        Writes IN movement (does NOT yet flip current_godown_id —
        that happens at confirm_receipt).
        """
        d = request.get_json(silent=True) or {}
        code = (d.get("box_code") or "").strip().upper()
        if not code:
            return jsonify({"status":"error","message":"box_code required"}), 400

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "in_pending":
                return jsonify({"status":"error",
                                "message":f"Transfer is in '{t['status']}' state"}), 409

            # Find the package
            box = conn.execute("""
                SELECT b.box_id, b.box_code, b.per_box_qty, b.uom,
                       m.material_name
                FROM rm_boxes b
                LEFT JOIN procurement_materials m ON m.id = b.material_id
                WHERE b.box_code = %s
            """, (code,)).fetchone()
            if not box:
                return jsonify({"status":"not_found",
                                "message":f"No package with code {code}"}), 200

            bid = int(box["box_id"])
            # Must be on this voucher
            on_voucher = conn.execute(
                "SELECT 1 FROM rm_stock_transfer_boxes "
                "WHERE transfer_id=%s AND box_id=%s",
                (tid, bid)
            ).fetchone()
            if not on_voucher:
                return jsonify({"status":"blocked",
                                "message":f"Package {code} isn't on this transfer voucher"}), 200

            # Duplicate-IN check
            already_in = conn.execute(
                "SELECT 1 FROM rm_box_movements "
                "WHERE transfer_id=%s AND box_id=%s AND movement_type='in'",
                (tid, bid)
            ).fetchone()
            if already_in:
                return jsonify({"status":"blocked",
                                "message":f"Package {code} already scanned IN"}), 200

            qty = float(box["per_box_qty"] or 0)
            # Audit-trail label: prefer the IN voucher number (allocated at
            # submit_out and only relevant for the IN side). Fall back to
            # transfer_no on legacy rows that pre-date the two-number scheme.
            _in_vno = (t.get("in_voucher_no") if hasattr(t, "get") else None) or t["transfer_no"]
            conn.execute("""
                INSERT INTO rm_box_movements
                  (box_id, transfer_id, movement_type, from_godown_id,
                   to_godown_id, qty, moved_by, remarks)
                VALUES (%s, %s, 'in', NULL, %s, %s, %s, %s)
            """, (bid, tid, int(t["to_godown_id"]), qty, _user(),
                  f"Transfer IN ({_in_vno})"))
            _log_transfer_edit(conn, tid, "scan_in", f"box={code}")
            conn.commit()

            # Return updated scan counts
            counts = conn.execute("""
                SELECT
                  (SELECT COUNT(*) FROM rm_stock_transfer_boxes WHERE transfer_id=%s) AS expected,
                  (SELECT COUNT(*) FROM rm_box_movements
                   WHERE transfer_id=%s AND movement_type='in') AS scanned_in
            """, (tid, tid)).fetchone()
            return jsonify({"status":"ok", "package": {
                "box_id":        bid,
                "box_code":      box["box_code"],
                "material_name": box["material_name"] or "",
                "per_box_qty":   qty,
                "uom":           box["uom"] or "",
            }, "scan_counts": {
                "expected":   int(counts["expected"]   or 0),
                "scanned_in": int(counts["scanned_in"] or 0),
            }})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/<int:tid>/unscan_in",
               methods=["POST"])
    @_edit_required
    def api_transfer_unscan_in(tid):
        """Undo a single IN scan (in_pending state only)."""
        d = request.get_json(silent=True) or {}
        try:    bid = int(d.get("box_id") or 0)
        except: bid = 0
        code = (d.get("box_code") or "").strip().upper()

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            t = conn.execute(
                "SELECT status FROM rm_stock_transfers WHERE transfer_id=%s",
                (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "in_pending":
                return jsonify({"status":"error",
                                "message":f"Transfer is in '{t['status']}' state"}), 409

            if not bid and code:
                row = conn.execute(
                    "SELECT box_id FROM rm_boxes WHERE box_code=%s", (code,)
                ).fetchone()
                bid = int(row["box_id"]) if row else 0
            if not bid:
                return jsonify({"status":"error",
                                "message":"box_id or box_code required"}), 400

            conn.execute(
                "DELETE FROM rm_box_movements "
                "WHERE transfer_id=%s AND box_id=%s AND movement_type='in'",
                (tid, bid)
            )
            _log_transfer_edit(conn, tid, "unscan_in", f"box_id={bid}")
            conn.commit()
            return jsonify({"status":"ok"})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    @app.route("/api/inventory_godown/transfers/<int:tid>/confirm_receipt",
               methods=["POST"])
    @_edit_required
    def api_transfer_confirm_receipt(tid):
        """
        Finalize the IN side. Status in_pending → received.

        Rules:
          1. Anti-fraud: OUT creator cannot confirm receipt
          2. Strict reconciliation: every voucher package must have an
             'in' movement (no partial receipt)
          3. On success: rm_boxes.current_status='in_stock',
                         current_godown_id = TO godown
        """
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] != "in_pending":
                return jsonify({"status":"error",
                                "message":f"Transfer is in '{t['status']}' state"}), 409

            # Rule 1: Separation of duties
            if _is_out_creator(conn, tid):
                return jsonify({
                    "status":"error",
                    "message":"Separation of duties: you created the Material OUT "
                              "for this transfer, so a different user must confirm "
                              "receipt. You can still view or print the voucher "
                              "after it is received."
                }), 403

            # Rule 2: Strict reconciliation
            counts = conn.execute("""
                SELECT
                  (SELECT COUNT(*) FROM rm_stock_transfer_boxes WHERE transfer_id=%s) AS expected,
                  (SELECT COUNT(*) FROM rm_box_movements
                   WHERE transfer_id=%s AND movement_type='in') AS scanned_in
            """, (tid, tid)).fetchone()
            expected   = int(counts["expected"]   or 0)
            scanned_in = int(counts["scanned_in"] or 0)
            if scanned_in < expected:
                missing = expected - scanned_in
                return jsonify({
                    "status":"error",
                    "message":f"Cannot confirm — {missing} package(s) still missing. "
                              f"Scan all {expected} expected packages first.",
                    "expected":   expected,
                    "scanned_in": scanned_in,
                }), 409

            # Apply: flip every package to in_stock at the TO godown.
            # FOR UPDATE is defensive — packages are already in_transit so
            # no other transfer should be able to grab them, but locking
            # them here protects against admin-tool manual edits during
            # the receipt window.
            to_id = int(t["to_godown_id"])
            box_rows = conn.execute(
                "SELECT box_id FROM rm_stock_transfer_boxes "
                "WHERE transfer_id=%s FOR UPDATE",
                (tid,)
            ).fetchall()
            for r in box_rows:
                conn.execute(
                    "UPDATE rm_boxes "
                    "SET current_status='in_stock', current_godown_id=%s "
                    "WHERE box_id=%s",
                    (to_id, int(r["box_id"]))
                )

            conn.execute(
                "UPDATE rm_stock_transfers SET status='received', "
                "in_at=NOW(), in_by=%s WHERE transfer_id=%s",
                (_user(), tid)
            )
            _log_transfer_edit(conn, tid, "confirm_receipt",
                               f"In={scanned_in}/Out={expected}")

            # ── Phase 2: Material Request auto-fulfilment ──
            # Best-effort: credit the just-received boxes toward any open
            # Material Request lines for the same material at this destination.
            # Never let a fulfilment hiccup break the receipt itself.
            try:
                try:
                    from inventory import inventory_material_request as _imr
                except Exception:
                    import inventory_material_request as _imr
                _imr.fulfill_from_transfer(conn, tid, fulfilled_by=_user())
            except Exception:
                pass

            conn.commit()
            return jsonify({"status":"ok",
                            "transfer_no":   t["transfer_no"],
                            "in_voucher_no": t.get("in_voucher_no") if hasattr(t, "get") else None,
                            "total_received": scanned_in})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            if _is_lock_error(e):
                return jsonify({"status":"blocked",
                                "message":"Another user is editing one of "
                                          "these packages right now. Try "
                                          "again in a moment."}), 200
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    # ─── RECONCILE (admin) ──────────────────────────────────────────────
    @app.route("/api/inventory_godown/transfers/<int:tid>/reconcile",
               methods=["POST"])
    @_edit_required
    def api_transfer_reconcile(tid):
        """Admin-only resolution for a MISMATCHED in_pending transfer, where the
        number of packages scanned IN differs from the OUT voucher.

        The admin declares which voucher is authoritative; stock is moved to
        match that decision and the transfer is closed as 'received'.

          mode='out_accurate'  → the Material OUT voucher is the truth. EVERY
              OUT package (scanned-in or not) is received into the destination
              godown (in_stock @ TO). Unscanned ones get a reconciliation 'in'
              movement so the ledger balances.

          mode='in_accurate'   → the Material IN scan is the truth. Packages
              actually scanned in are received (in_stock @ TO). The EXTRA OUT
              packages that were never scanned in are SET OFF — reverted to
              in_stock at the SOURCE godown (treated as never having left), so
              total stock matches what IN actually received.

        Body: { mode: 'out_accurate'|'in_accurate', reason: '<required>' }
        Admin only; requires status='in_pending'. No-op if there's no mismatch
        (falls through to a normal full receipt under out_accurate).
        """
        if not _can_edit_inventory():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        d = request.get_json(silent=True) or {}
        mode   = (d.get("mode") or "").strip().lower()
        reason = (d.get("reason") or "").strip()
        if mode not in ("out_accurate", "in_accurate"):
            return jsonify({"status": "error",
                            "message": "mode must be 'out_accurate' or 'in_accurate'"}), 400
        if not reason:
            return jsonify({"status": "error", "message": "A reconciliation reason is required"}), 400

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status": "error", "message": "Transfer not found"}), 404
            if t["status"] != "in_pending":
                return jsonify({"status": "error",
                                "message": f"Transfer is in '{t['status']}' state — "
                                           "only in-transit transfers can be reconciled"}), 409

            from_id = int(t["from_godown_id"])
            to_id   = int(t["to_godown_id"])

            # All OUT packages on the voucher.
            out_rows = conn.execute(
                "SELECT b.box_id, b.per_box_qty FROM rm_stock_transfer_boxes tb "
                "JOIN rm_boxes b ON b.box_id=tb.box_id "
                "WHERE tb.transfer_id=%s FOR UPDATE", (tid,)
            ).fetchall()
            out_ids = {int(r["box_id"]): float(r["per_box_qty"] or 0) for r in out_rows}

            # Which were actually scanned IN (have an 'in' movement on this transfer).
            in_rows = conn.execute(
                "SELECT DISTINCT box_id FROM rm_box_movements "
                "WHERE transfer_id=%s AND movement_type='in'", (tid,)
            ).fetchall()
            in_ids = {int(r["box_id"]) for r in in_rows}

            scanned_in  = sorted(in_ids & set(out_ids.keys()))
            not_scanned = sorted(set(out_ids.keys()) - in_ids)
            expected    = len(out_ids)

            tno = t["transfer_no"]

            if mode == "out_accurate":
                # Receive EVERY package at the destination.
                for bid in out_ids:
                    conn.execute(
                        "UPDATE rm_boxes SET current_status='in_stock', current_godown_id=%s "
                        "WHERE box_id=%s", (to_id, bid))
                # Ledger: log a reconciliation 'in' for the ones never scanned.
                for bid in not_scanned:
                    conn.execute("""
                        INSERT INTO rm_box_movements
                          (box_id, transfer_id, movement_type, from_godown_id,
                           to_godown_id, qty, moved_by, remarks)
                        VALUES (%s, %s, 'in', %s, %s, %s, %s, %s)
                    """, (bid, tid, from_id, to_id, out_ids[bid], _user(),
                          f"Reconcile (OUT accurate): auto-received ({tno})"))
                detail = (f"mode=out_accurate; received_all={expected}; "
                          f"auto_received={len(not_scanned)}; reason={reason}")
                applied_msg = (f"OUT treated as accurate — all {expected} package(s) "
                               f"received at destination ({len(not_scanned)} auto-received).")

            else:  # in_accurate
                # Scanned-in packages → received at destination.
                for bid in scanned_in:
                    conn.execute(
                        "UPDATE rm_boxes SET current_status='in_stock', current_godown_id=%s "
                        "WHERE box_id=%s", (to_id, bid))
                # Extra OUT packages never scanned in → set off, revert to SOURCE.
                for bid in not_scanned:
                    conn.execute(
                        "UPDATE rm_boxes SET current_status='in_stock', current_godown_id=%s "
                        "WHERE box_id=%s", (from_id, bid))
                    conn.execute("""
                        INSERT INTO rm_box_movements
                          (box_id, transfer_id, movement_type, from_godown_id,
                           to_godown_id, qty, moved_by, remarks)
                        VALUES (%s, %s, 'adjust', %s, %s, %s, %s, %s)
                    """, (bid, tid, to_id, from_id, out_ids[bid], _user(),
                          f"Reconcile (IN accurate): set-off, reverted to source ({tno})"))
                detail = (f"mode=in_accurate; received={len(scanned_in)}; "
                          f"set_off={len(not_scanned)}; reason={reason}")
                applied_msg = (f"IN treated as accurate — {len(scanned_in)} package(s) "
                               f"received, {len(not_scanned)} reverted to source.")

            # Close the transfer. Use 'received' so it flows through existing
            # history/UI; the edit log records that it was reconciled.
            conn.execute(
                "UPDATE rm_stock_transfers SET status='received', "
                "in_at=NOW(), in_by=%s WHERE transfer_id=%s",
                (_user(), tid))
            _log_transfer_edit(conn, tid, "reconcile", detail)

            # Best-effort MR auto-fulfilment, mirroring confirm_receipt.
            try:
                try:
                    from inventory import inventory_material_request as _imr
                except Exception:
                    import inventory_material_request as _imr
                _imr.fulfill_from_transfer(conn, tid, fulfilled_by=_user())
            except Exception:
                pass

            conn.commit()
            return jsonify({"status": "ok", "message": applied_msg,
                            "mode": mode, "expected": expected,
                            "scanned_in": len(scanned_in),
                            "resolved": len(not_scanned)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            if _is_lock_error(e):
                return jsonify({"status": "blocked",
                                "message": "Another user is editing one of these "
                                           "packages right now. Try again in a moment."}), 200
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass
        """
        Cancel a transfer. Reversal logic depends on current state:
          out_started  → packages in_transit → restored to in_stock at FROM
          in_pending   → same — packages return to FROM
          received     → packages already at TO → moved back to FROM
        """
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            t = conn.execute(
                "SELECT * FROM rm_stock_transfers WHERE transfer_id=%s", (tid,)
            ).fetchone()
            if not t:
                return jsonify({"status":"error","message":"Transfer not found"}), 404
            if t["status"] == "cancelled":
                return jsonify({"status":"error","message":"Already cancelled"}), 400

            from_id = int(t["from_godown_id"])
            to_id   = int(t["to_godown_id"])
            # FOR UPDATE — locks every box row that's on this voucher
            # before we read their status. Prevents a concurrent scan_out
            # on a different voucher from "stealing" a box mid-cancellation.
            box_rows = conn.execute(
                "SELECT b.box_id, b.box_code, b.current_godown_id, "
                "       b.current_status, b.per_box_qty "
                "FROM rm_stock_transfer_boxes tb "
                "JOIN rm_boxes b ON b.box_id = tb.box_id "
                "WHERE tb.transfer_id=%s "
                "FOR UPDATE",
                (tid,)
            ).fetchall()

            user = _user()
            reversed_count = 0
            for r in box_rows:
                bid = int(r["box_id"])
                qty = float(r["per_box_qty"] or 0)
                cur_status = r["current_status"]
                cur_godown = int(r["current_godown_id"] or 0)
                # Determine what needs to happen
                if cur_status == "in_transit":
                    # Still flagged in_transit (out_started or in_pending state)
                    # → restore to in_stock at FROM
                    conn.execute(
                        "UPDATE rm_boxes "
                        "SET current_status='in_stock', current_godown_id=%s "
                        "WHERE box_id=%s",
                        (from_id, bid)
                    )
                    reversed_count += 1
                elif cur_status == "in_stock" and cur_godown == to_id:
                    # received state — package is at TO. Move back.
                    conn.execute(
                        "UPDATE rm_boxes SET current_godown_id=%s WHERE box_id=%s",
                        (from_id, bid)
                    )
                    reversed_count += 1
                # else: package was moved elsewhere after receipt; leave it
                # alone (audit trail still records the original transfer)

                conn.execute("""
                    INSERT INTO rm_box_movements
                      (box_id, transfer_id, movement_type, from_godown_id,
                       to_godown_id, qty, moved_by, remarks)
                    VALUES (%s, %s, 'cancel', %s, %s, %s, %s, %s)
                """, (bid, tid, cur_godown or from_id, from_id, qty, user,
                      f"Transfer CANCELLED ({t['transfer_no']})"))

            conn.execute(
                "UPDATE rm_stock_transfers SET status='cancelled', "
                "cancelled_at=NOW(), cancelled_by=%s WHERE transfer_id=%s",
                (user, tid)
            )
            _log_transfer_edit(conn, tid, "cancel",
                               f"reversed {reversed_count} pkg")

            # ── Phase 2: reverse any Material Request fulfilment this
            # transfer created (only matters if it had been received). ──
            try:
                try:
                    from inventory import inventory_material_request as _imr
                except Exception:
                    import inventory_material_request as _imr
                _imr.unlink_transfer(conn, tid)
            except Exception:
                pass

            conn.commit()
            return jsonify({"status":"ok",
                            "reversed_count": reversed_count})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            if _is_lock_error(e):
                return jsonify({"status":"blocked",
                                "message":"Another user is editing one of "
                                          "these packages right now. Try "
                                          "again in a moment."}), 200
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass


    print("✅ [InventoryTransfers] routes registered (out → in_pending → received)")
