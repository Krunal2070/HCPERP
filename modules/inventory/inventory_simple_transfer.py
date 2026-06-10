"""
inventory.inventory_simple_transfer
───────────────────────────────────
Simple (manual / non-QR) Stock Transfer Voucher module for RM.

This module sits ALONGSIDE inventory_transfers.py (the QR-scan based
two-stage transfer system). It exposes a separate set of API endpoints
under /api/inventory_simple_transfer/* and a separate set of database
tables prefixed rm_simple_*.

WHY A SEPARATE MODULE?
    The QR voucher operates at per-box granularity — every package has a
    unique code, scan history, and physical state ('in_stock' / 'in_transit'
    / 'consumed' / etc.). It cannot represent loose / non-boxed stock.

    Many real-world transfers happen BEFORE the operator has time to QR
    every package — bulk material shifted on pallets, partial drum
    fillings, mid-shift transfers. For these we need a way to record
    the transfer in qty terms only, without forcing the operator to
    print and scan a label for each.

    "Loose" stock recorded via Simple Transfer is tracked via an
    aggregate movements ledger (rm_simple_movements), one row per
    out-or-in event. The current qty at (material, godown) is computed
    as SUM(in) − SUM(out) over RECEIVED vouchers only (in_pending qty
    is "in transit" — not yet at destination).

WORKFLOW (matches QR voucher state machine):
    out_started   Header + lines saved at source. Not yet final.
    in_pending    User clicked "Submit OUT" — qty is debited from
                  source-godown loose-stock and marked in-transit.
    received      Destination user clicked "Confirm Receipt" — qty is
                  credited to destination-godown loose-stock.
    cancelled     From any prior stage; reversal logic depends on stage.

TABLES (auto-created on first call to _ensure_schema()):
    rm_simple_transfers          voucher headers
    rm_simple_transfer_items     voucher line items (material, pkg, qty)
    rm_simple_movements          aggregate stock-movement ledger
    rm_simple_edit_log           per-voucher audit trail (action + by_user)

URL ROUTES — all under /api/inventory_simple_transfer/*:
    GET   /list                   — list all (filters: status, from_id, to_id)
    GET   /in_transit             — quick count + minimal payload for badges
    GET   /get?voucher_id=N       — full voucher (header + lines)
    GET   /materials/search?q=… — typeahead search for procurement_materials
    GET   /loose_stock?material_id&godown_id  — current loose qty at one location
    POST  /save                   — create OR update a draft (out_started)
    POST  /<vid>/submit_out       — flip out_started → in_pending
    POST  /<vid>/confirm_receipt  — flip in_pending → received
    POST  /<vid>/cancel           — cancel with stage-aware reversal
    GET   /<vid>/print_data       — voucher data for the print view
    GET   /<vid>/whatsapp_text    — pre-formatted text payload for WA share

PERMISSIONS
    /list, /get, /loose_stock, /materials/search,
    /print_data, /whatsapp_text                 →  any logged-in user
    /save, /submit_out, /confirm_receipt,
    /cancel                                     →  @_edit_required
                                                    (admin / sonal / tarak)

VOUCHER NUMBER FORMAT
    ST/RM/####/YY-YY      (e.g. ST/RM/0001/26-27)
    Year boundary is April 1 (Indian financial year), matching the
    sibling QR voucher (TR/RM/####/YY-YY) and PM Stock conventions.
"""

from __future__ import annotations
import re
import json
import traceback
from functools import wraps
from datetime import date, datetime

from flask import jsonify, request, session

import sampling_portal


# ════════════════════════════════════════════════════════════════════════
# PERMISSION HELPERS — match the rest of the inventory module
# ════════════════════════════════════════════════════════════════════════

def _can_inventory() -> bool:
    return bool(session.get("logged_in"))


def _can_edit_inventory() -> bool:
    """True when the current user is allowed to create / modify simple
    transfers. Order: admin/power-user → True; otherwise honour the
    'simple_transfer' per-feature access cap from User Access Control.
    Failing the lookup keeps the legacy admin-only behaviour for safety.
    """
    if not session.get("logged_in"):
        return False
    role = (session.get("User_Type") or "").strip().lower()
    uid  = (session.get("UID") or "").strip().lower()
    if role in {"admin"} or uid in {"sonal", "tarak"}:
        return True
    try:
        try:
            from inventory import inventory_access as _ia
        except Exception:
            import inventory_access as _ia
        return bool(_ia._inv_user_has_access("simple_transfer"))
    except Exception:
        return False


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
    return (session.get("UID") or session.get("Name") or "system").strip()


# ════════════════════════════════════════════════════════════════════════
# SCHEMA (auto-create)
# ════════════════════════════════════════════════════════════════════════

def _ensure_schema():
    """Create the three rm_simple_* tables on first call (idempotent)."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("⚠️  [InventorySimpleTransfer] DB connection unavailable at startup")
        return
    try:
        # ── Header: one row per voucher ────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_simple_transfers (
                voucher_id      INT AUTO_INCREMENT PRIMARY KEY,
                voucher_no      VARCHAR(40) NOT NULL UNIQUE,
                voucher_date    DATE NOT NULL,
                from_godown_id  INT NOT NULL,
                to_godown_id    INT NOT NULL,
                status          ENUM('out_started','in_pending',
                                     'received','cancelled')
                                  NOT NULL DEFAULT 'out_started',
                total_items     INT NOT NULL DEFAULT 0,
                total_pkgs      DECIMAL(14,3) NOT NULL DEFAULT 0,
                total_qty       DECIMAL(14,3) NOT NULL DEFAULT 0,
                remarks         TEXT,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_by      VARCHAR(64) DEFAULT NULL,
                out_at          DATETIME DEFAULT NULL,
                out_by          VARCHAR(64) DEFAULT NULL,
                in_at           DATETIME DEFAULT NULL,
                in_by           VARCHAR(64) DEFAULT NULL,
                cancelled_at    DATETIME DEFAULT NULL,
                cancelled_by    VARCHAR(64) DEFAULT NULL,
                cancel_reason   VARCHAR(500) DEFAULT NULL,
                INDEX ix_rm_st_from   (from_godown_id),
                INDEX ix_rm_st_to     (to_godown_id),
                INDEX ix_rm_st_date   (voucher_date),
                INDEX ix_rm_st_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Line items: one row per material on the voucher ───────────
        # qty fields kept independent so the user can override
        # per_pkg_qty × num_pkgs ≠ total_qty if needed (e.g. last pkg
        # is short). UI computes total_qty from the two but lets the
        # user edit it directly.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_simple_transfer_items (
                item_id        INT AUTO_INCREMENT PRIMARY KEY,
                voucher_id     INT NOT NULL,
                material_id    INT NOT NULL,
                num_pkgs       DECIMAL(14,3) NOT NULL DEFAULT 0,
                per_pkg_qty    DECIMAL(14,3) NOT NULL DEFAULT 0,
                total_qty      DECIMAL(14,3) NOT NULL DEFAULT 0,
                uom            VARCHAR(20)  DEFAULT NULL,
                remarks        VARCHAR(255) DEFAULT NULL,
                line_no        INT NOT NULL DEFAULT 1,
                INDEX ix_rm_sti_voucher (voucher_id),
                INDEX ix_rm_sti_material (material_id),
                FOREIGN KEY (voucher_id)
                  REFERENCES rm_simple_transfers(voucher_id)
                  ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Movement ledger ────────────────────────────────────────────
        # Two rows per item per submit_out (out at source) and per
        # confirm_receipt (in at destination). Negative qty NOT used —
        # movement_type discriminates. NET stock at (material, godown):
        #   SUM(qty WHERE movement_type='in'  AND to_godown_id=g) 
        # − SUM(qty WHERE movement_type='out' AND from_godown_id=g)
        # over voucher rows whose status='received' (or 'in_pending' if
        # you want pending stock to count as "still at source"; we
        # treat in_pending as already-debited from source / not-yet-
        # credited to destination — matches the QR flow).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_simple_movements (
                movement_id     INT AUTO_INCREMENT PRIMARY KEY,
                voucher_id      INT NOT NULL,
                item_id         INT DEFAULT NULL,
                material_id     INT NOT NULL,
                movement_type   ENUM('out','in','reverse_out','reverse_in')
                                  NOT NULL,
                from_godown_id  INT DEFAULT NULL,
                to_godown_id    INT DEFAULT NULL,
                qty             DECIMAL(14,3) NOT NULL,
                moved_by        VARCHAR(64) DEFAULT NULL,
                moved_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
                remarks         VARCHAR(255) DEFAULT NULL,
                INDEX ix_rm_sm_voucher  (voucher_id),
                INDEX ix_rm_sm_material (material_id),
                INDEX ix_rm_sm_from     (from_godown_id),
                INDEX ix_rm_sm_to       (to_godown_id),
                INDEX ix_rm_sm_type     (movement_type),
                FOREIGN KEY (voucher_id)
                  REFERENCES rm_simple_transfers(voucher_id)
                  ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Edit audit log (action + free-text detail per voucher) ─────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rm_simple_edit_log (
                log_id       INT AUTO_INCREMENT PRIMARY KEY,
                voucher_id   INT NOT NULL,
                action       VARCHAR(40) NOT NULL,
                detail       TEXT,
                by_user      VARCHAR(64) DEFAULT NULL,
                at_ts        DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_rm_sel_voucher (voucher_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception:
        traceback.print_exc()
        try: conn.rollback()
        except Exception: pass
    finally:
        try: conn.close()
        except Exception: pass


# ════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════

def _next_voucher_no(conn) -> str:
    """ST/RM/####/YY-YY  — year boundary April 1."""
    today = date.today()
    fy_start = today.year if today.month >= 4 else today.year - 1
    fy_label = f"{str(fy_start)[2:]}-{str(fy_start + 1)[2:]}"
    prefix = "ST/RM/"
    suffix = f"/{fy_label}"
    row = conn.execute(
        "SELECT voucher_no FROM rm_simple_transfers "
        "WHERE voucher_no LIKE %s "
        "ORDER BY voucher_id DESC LIMIT 1",
        (f"{prefix}%{suffix}",)
    ).fetchone()
    next_seq = 1
    if row and row["voucher_no"]:
        m = re.search(r"ST/RM/(\d+)/", row["voucher_no"])
        if m:
            next_seq = int(m.group(1)) + 1
    return f"{prefix}{next_seq:04d}{suffix}"


def _log_edit(conn, voucher_id: int, action: str, detail: str = ""):
    """Insert an entry into rm_simple_edit_log."""
    try:
        conn.execute(
            "INSERT INTO rm_simple_edit_log "
            "(voucher_id, action, detail, by_user) VALUES (%s, %s, %s, %s)",
            (voucher_id, action, detail, _user())
        )
    except Exception:
        # Never let an audit failure abort the underlying action
        traceback.print_exc()


def _recompute_totals(conn, voucher_id: int):
    """Refresh total_items / total_pkgs / total_qty on the header."""
    row = conn.execute("""
        SELECT COUNT(*)              AS total_items,
               COALESCE(SUM(num_pkgs), 0) AS total_pkgs,
               COALESCE(SUM(total_qty), 0) AS total_qty
        FROM rm_simple_transfer_items
        WHERE voucher_id = %s
    """, (voucher_id,)).fetchone()
    if not row:
        return
    conn.execute("""
        UPDATE rm_simple_transfers
           SET total_items = %s,
               total_pkgs  = %s,
               total_qty   = %s
         WHERE voucher_id  = %s
    """, (int(row["total_items"] or 0),
          float(row["total_pkgs"] or 0),
          float(row["total_qty"] or 0),
          voucher_id))


def _set_short_lock_timeout(conn):
    """Same as inventory_transfers — avoid hanging on row locks."""
    try:
        conn.execute("SET innodb_lock_wait_timeout = 5")
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════
# REGISTRATION
# ════════════════════════════════════════════════════════════════════════

def register_inventory_simple_transfer(app):
    """Register all routes under /api/inventory_simple_transfer/* and run
    schema migrations on first call. Idempotent."""
    if getattr(app, "_inventory_simple_transfer_registered", False):
        return
    app._inventory_simple_transfer_registered = True

    _ensure_schema()

    # ────────────────────────────────────────────────────────────────────
    # LIST
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/list", methods=["GET"])
    @_login_required
    def api_simple_list():
        status_filter = (request.args.get("status") or "").strip().lower()
        try: from_id = int(request.args.get("from_id") or 0)
        except: from_id = 0
        try: to_id = int(request.args.get("to_id") or 0)
        except: to_id = 0
        try: limit = max(1, min(int(request.args.get("limit") or 200), 1000))
        except: limit = 200

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            where, params = [], []
            if status_filter in {"out_started","in_pending","received","cancelled"}:
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
                FROM rm_simple_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                {sql_where}
                ORDER BY t.voucher_id DESC
                LIMIT {limit}
            """, params).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                for k in ("voucher_date","created_at","out_at","in_at",
                          "cancelled_at"):
                    if d.get(k) is not None:
                        d[k] = str(d[k])
                d["total_items"] = int(d.get("total_items") or 0)
                d["total_pkgs"]  = float(d.get("total_pkgs") or 0)
                d["total_qty"]   = float(d.get("total_qty") or 0)
                out.append(d)
            return jsonify({"status":"ok", "vouchers": out, "total": len(out)})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    @app.route("/api/inventory_simple_transfer/in_transit", methods=["GET"])
    @_login_required
    def api_simple_in_transit():
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            rows = conn.execute("""
                SELECT t.voucher_id, t.voucher_no, t.voucher_date,
                       t.from_godown_id, t.to_godown_id,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name,
                       t.total_items, t.total_pkgs, t.total_qty,
                       t.out_by, t.out_at
                FROM rm_simple_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.status = 'in_pending'
                ORDER BY t.out_at DESC
            """).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                for k in ("voucher_date","out_at"):
                    if d.get(k) is not None:
                        d[k] = str(d[k])
                d["total_items"] = int(d.get("total_items") or 0)
                d["total_pkgs"]  = float(d.get("total_pkgs") or 0)
                d["total_qty"]   = float(d.get("total_qty") or 0)
                out.append(d)
            return jsonify({"status":"ok", "vouchers": out, "count": len(out)})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # GET (header + items)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/get", methods=["GET"])
    @_login_required
    def api_simple_get():
        try:
            vid = int(request.args.get("voucher_id") or 0)
        except: vid = 0
        if not vid:
            return jsonify({"status":"error","message":"voucher_id required"}), 400

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            row = conn.execute("""
                SELECT t.*,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name
                FROM rm_simple_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.voucher_id = %s
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"not_found",
                                "message":"Voucher not found"}), 404
            v = dict(row)
            for k in ("voucher_date","created_at","out_at","in_at",
                      "cancelled_at"):
                if v.get(k) is not None:
                    v[k] = str(v[k])
            v["total_items"] = int(v.get("total_items") or 0)
            v["total_pkgs"]  = float(v.get("total_pkgs") or 0)
            v["total_qty"]   = float(v.get("total_qty") or 0)

            items = conn.execute("""
                SELECT i.*, m.material_name
                FROM rm_simple_transfer_items i
                LEFT JOIN procurement_materials m ON m.id = i.material_id
                WHERE i.voucher_id = %s
                ORDER BY i.line_no ASC, i.item_id ASC
            """, (vid,)).fetchall()
            v["items"] = [
                {
                    "item_id":      int(it["item_id"]),
                    "material_id":  int(it["material_id"] or 0),
                    "material_name": it["material_name"] or "",
                    "num_pkgs":     float(it["num_pkgs"] or 0),
                    "per_pkg_qty":  float(it["per_pkg_qty"] or 0),
                    "total_qty":    float(it["total_qty"] or 0),
                    "uom":          it["uom"] or "",
                    "remarks":      it["remarks"] or "",
                    "line_no":      int(it["line_no"] or 1),
                }
                for it in items
            ]
            return jsonify({"status":"ok", "voucher": v})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # MATERIAL SEARCH (typeahead, reuses procurement_materials master)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/materials/search",
               methods=["GET"])
    @_login_required
    def api_simple_materials_search():
        q = (request.args.get("q") or "").strip()
        try: limit = max(1, min(int(request.args.get("limit") or 30), 100))
        except: limit = 30

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            if q:
                like = f"%{q}%"
                rows = conn.execute("""
                    SELECT id, material_name, uom
                    FROM procurement_materials
                    WHERE material_name LIKE %s
                    ORDER BY material_name ASC
                    LIMIT %s
                """, (like, limit)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT id, material_name, uom
                    FROM procurement_materials
                    ORDER BY material_name ASC
                    LIMIT %s
                """, (limit,)).fetchall()
            return jsonify({"status":"ok",
                            "materials":[dict(r) for r in rows]})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # LOOSE STOCK (current qty at material × godown — for display & checks)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/loose_stock", methods=["GET"])
    @_login_required
    def api_simple_loose_stock():
        try: mid = int(request.args.get("material_id") or 0)
        except: mid = 0
        try: gid = int(request.args.get("godown_id") or 0)
        except: gid = 0
        if not mid or not gid:
            return jsonify({"status":"error",
                            "message":"material_id and godown_id required"}), 400

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            # Inbound to this godown
            in_row = conn.execute("""
                SELECT COALESCE(SUM(qty), 0) AS qty
                FROM rm_simple_movements
                WHERE material_id = %s
                  AND to_godown_id = %s
                  AND movement_type IN ('in','reverse_out')
            """, (mid, gid)).fetchone()
            # Outbound from this godown
            out_row = conn.execute("""
                SELECT COALESCE(SUM(qty), 0) AS qty
                FROM rm_simple_movements
                WHERE material_id = %s
                  AND from_godown_id = %s
                  AND movement_type IN ('out','reverse_in')
            """, (mid, gid)).fetchone()
            qty_in  = float(in_row["qty"] or 0)
            qty_out = float(out_row["qty"] or 0)
            return jsonify({
                "status": "ok",
                "material_id": mid,
                "godown_id":   gid,
                "qty_in":   qty_in,
                "qty_out":  qty_out,
                "qty_net":  qty_in - qty_out,
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # SAVE (create new draft OR update existing out_started voucher)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/save", methods=["POST"])
    @_edit_required
    def api_simple_save():
        """
        Body:
        {
          voucher_id?: <int>,  # omit for new; required for update
          voucher_date?: 'YYYY-MM-DD',
          from_godown_id: <int>,
          to_godown_id:   <int>,
          remarks?:       str,
          items: [
            { material_id, num_pkgs, per_pkg_qty, total_qty,
              uom?, remarks?, line_no? },
            ...
          ]
        }
        Only allowed when status='out_started' (or new). Inventory effects
        happen on submit_out / confirm_receipt, NOT on save.
        """
        d = request.get_json(silent=True) or {}
        try:    vid = int(d.get("voucher_id") or 0)
        except: vid = 0
        try:    from_id = int(d.get("from_godown_id") or 0)
        except: from_id = 0
        try:    to_id = int(d.get("to_godown_id") or 0)
        except: to_id = 0
        date_str = (d.get("voucher_date") or "").strip() or date.today().isoformat()
        remarks  = (d.get("remarks") or "").strip()
        raw_items = d.get("items") or []

        if not from_id or not to_id:
            return jsonify({"status":"error",
                            "message":"From and To godowns are required"}), 400
        if from_id == to_id:
            return jsonify({"status":"error",
                            "message":"From and To godowns must be different"}), 400
        if not isinstance(raw_items, list) or not raw_items:
            return jsonify({"status":"error",
                            "message":"At least one item required"}), 400

        # Normalize + validate items
        items = []
        for idx, raw in enumerate(raw_items, start=1):
            try:
                mid = int(raw.get("material_id") or 0)
            except: mid = 0
            if not mid:
                return jsonify({"status":"error",
                                "message":f"Item {idx}: material_id required"}), 400
            try:    num_pkgs = float(raw.get("num_pkgs") or 0)
            except: num_pkgs = 0.0
            try:    per_pkg = float(raw.get("per_pkg_qty") or 0)
            except: per_pkg = 0.0
            try:    total = float(raw.get("total_qty") or 0)
            except: total = 0.0
            if total <= 0:
                # Allow client to send only num_pkgs × per_pkg_qty and
                # we'll compute. If that's also zero, reject.
                total = round(num_pkgs * per_pkg, 3)
            if total <= 0:
                return jsonify({"status":"error",
                                "message":f"Item {idx}: qty must be > 0"}), 400
            items.append({
                "material_id": mid,
                "num_pkgs":    round(num_pkgs, 3),
                "per_pkg_qty": round(per_pkg, 3),
                "total_qty":   round(total, 3),
                "uom":         (raw.get("uom") or "").strip() or None,
                "remarks":     (raw.get("remarks") or "").strip() or None,
                "line_no":     int(raw.get("line_no") or idx),
            })

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            user = _user()
            is_new = (vid <= 0)

            if is_new:
                voucher_no = _next_voucher_no(conn)
                cur = conn.execute("""
                    INSERT INTO rm_simple_transfers
                        (voucher_no, voucher_date, from_godown_id, to_godown_id,
                         status, remarks, created_by)
                    VALUES (%s, %s, %s, %s, 'out_started', %s, %s)
                """, (voucher_no, date_str, from_id, to_id, remarks, user))
                vid = cur.lastrowid
            else:
                # Update only if still editable
                row = conn.execute(
                    "SELECT status FROM rm_simple_transfers WHERE voucher_id=%s",
                    (vid,)
                ).fetchone()
                if not row:
                    conn.rollback()
                    return jsonify({"status":"error",
                                    "message":"Voucher not found"}), 404
                if row["status"] != "out_started":
                    conn.rollback()
                    return jsonify({"status":"error",
                                    "message":f"Voucher is {row['status']} — cannot edit"}), 400
                conn.execute("""
                    UPDATE rm_simple_transfers
                       SET voucher_date   = %s,
                           from_godown_id = %s,
                           to_godown_id   = %s,
                           remarks        = %s
                     WHERE voucher_id = %s
                """, (date_str, from_id, to_id, remarks, vid))
                # Clear existing items — full-replace pattern
                conn.execute(
                    "DELETE FROM rm_simple_transfer_items WHERE voucher_id=%s",
                    (vid,)
                )

            # Insert items
            for it in items:
                conn.execute("""
                    INSERT INTO rm_simple_transfer_items
                        (voucher_id, material_id, num_pkgs, per_pkg_qty,
                         total_qty, uom, remarks, line_no)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (vid, it["material_id"], it["num_pkgs"], it["per_pkg_qty"],
                      it["total_qty"], it["uom"], it["remarks"], it["line_no"]))

            _recompute_totals(conn, vid)
            _log_edit(conn, vid, "save",
                      f"{'created' if is_new else 'updated'} "
                      f"with {len(items)} item(s)")
            conn.commit()

            # Re-read voucher_no for the response
            r = conn.execute(
                "SELECT voucher_no FROM rm_simple_transfers WHERE voucher_id=%s",
                (vid,)
            ).fetchone()
            return jsonify({"status":"ok",
                            "voucher_id": vid,
                            "voucher_no": r["voucher_no"] if r else None,
                            "created":   is_new})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # SUBMIT OUT  (out_started → in_pending; write OUT movements)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/<int:vid>/submit_out",
               methods=["POST"])
    @_edit_required
    def api_simple_submit_out(vid):
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            row = conn.execute("""
                SELECT status, from_godown_id, to_godown_id
                FROM rm_simple_transfers WHERE voucher_id=%s
                FOR UPDATE
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"error","message":"Voucher not found"}), 404
            if row["status"] != "out_started":
                return jsonify({"status":"error",
                                "message":f"Voucher is {row['status']} — cannot submit OUT"}), 400

            items = conn.execute("""
                SELECT item_id, material_id, total_qty
                FROM rm_simple_transfer_items
                WHERE voucher_id=%s
            """, (vid,)).fetchall()
            if not items:
                return jsonify({"status":"error",
                                "message":"Voucher has no items"}), 400

            from_id = int(row["from_godown_id"])
            to_id   = int(row["to_godown_id"])
            user = _user()
            remarks_tag = f"Simple Transfer OUT voucher_id={vid}"
            for it in items:
                conn.execute("""
                    INSERT INTO rm_simple_movements
                        (voucher_id, item_id, material_id, movement_type,
                         from_godown_id, to_godown_id, qty, moved_by, remarks)
                    VALUES (%s, %s, %s, 'out', %s, %s, %s, %s, %s)
                """, (vid, int(it["item_id"]), int(it["material_id"]),
                      from_id, to_id, float(it["total_qty"] or 0),
                      user, remarks_tag))

            conn.execute("""
                UPDATE rm_simple_transfers
                   SET status='in_pending', out_at=NOW(), out_by=%s
                 WHERE voucher_id=%s
            """, (user, vid))
            _log_edit(conn, vid, "submit_out",
                      f"{len(items)} item(s) marked in-transit")
            conn.commit()
            return jsonify({"status":"ok", "voucher_id": vid,
                            "items_count": len(items)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # CONFIRM RECEIPT  (in_pending → received; write IN movements)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/<int:vid>/confirm_receipt",
               methods=["POST"])
    @_edit_required
    def api_simple_confirm_receipt(vid):
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            row = conn.execute("""
                SELECT status, from_godown_id, to_godown_id, out_by
                FROM rm_simple_transfers WHERE voucher_id=%s
                FOR UPDATE
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"error","message":"Voucher not found"}), 404
            if row["status"] != "in_pending":
                return jsonify({"status":"error",
                                "message":f"Voucher is {row['status']} — cannot confirm"}), 400

            # Anti-fraud: PM Stock convention — the user who submitted
            # OUT cannot confirm IN. A different user must do it.
            user = _user()
            out_by = (row.get("out_by") or "").strip().lower()
            this_user_lower = user.strip().lower()
            # Admins bypass the check (same as PM Stock)
            user_role = (session.get("User_Type") or "").strip().lower()
            if out_by and out_by == this_user_lower and user_role != "admin":
                return jsonify({"status":"error",
                                "message":"OUT and IN must be done by different users (anti-fraud check)"}), 403

            items = conn.execute("""
                SELECT item_id, material_id, total_qty
                FROM rm_simple_transfer_items
                WHERE voucher_id=%s
            """, (vid,)).fetchall()

            from_id = int(row["from_godown_id"])
            to_id   = int(row["to_godown_id"])
            remarks_tag = f"Simple Transfer IN voucher_id={vid}"
            for it in items:
                conn.execute("""
                    INSERT INTO rm_simple_movements
                        (voucher_id, item_id, material_id, movement_type,
                         from_godown_id, to_godown_id, qty, moved_by, remarks)
                    VALUES (%s, %s, %s, 'in', %s, %s, %s, %s, %s)
                """, (vid, int(it["item_id"]), int(it["material_id"]),
                      from_id, to_id, float(it["total_qty"] or 0),
                      user, remarks_tag))

            conn.execute("""
                UPDATE rm_simple_transfers
                   SET status='received', in_at=NOW(), in_by=%s
                 WHERE voucher_id=%s
            """, (user, vid))
            _log_edit(conn, vid, "confirm_receipt",
                      f"{len(items)} item(s) received at destination")
            conn.commit()
            return jsonify({"status":"ok", "voucher_id": vid,
                            "items_count": len(items)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # CANCEL  (stage-aware reversal)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/<int:vid>/cancel",
               methods=["POST"])
    @_edit_required
    def api_simple_cancel(vid):
        """
        Cancel a voucher. Stage-aware reversal:
          - out_started: nothing to reverse (no movements yet)
          - in_pending:  write reverse_out for each OUT movement
                         → stock returns to source godown
          - received:    write reverse_in for each IN + reverse_out
                         for each OUT → net zero everywhere
          - cancelled:   no-op (already cancelled)
        Reason is taken from body { reason: '...' } (optional).
        """
        d = request.get_json(silent=True) or {}
        reason = (d.get("reason") or "").strip()[:500]

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            _set_short_lock_timeout(conn)
            row = conn.execute("""
                SELECT status, from_godown_id, to_godown_id
                FROM rm_simple_transfers WHERE voucher_id=%s
                FOR UPDATE
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"error","message":"Voucher not found"}), 404
            cur_status = row["status"]
            if cur_status == "cancelled":
                return jsonify({"status":"error",
                                "message":"Already cancelled"}), 400

            user = _user()
            reversed_count = 0
            reverse_tag = f"Cancel voucher_id={vid}"

            if cur_status in ("in_pending", "received"):
                # Reverse OUT movements (always present if we got past
                # out_started)
                outs = conn.execute("""
                    SELECT item_id, material_id, from_godown_id,
                           to_godown_id, qty
                    FROM rm_simple_movements
                    WHERE voucher_id=%s AND movement_type='out'
                """, (vid,)).fetchall()
                for m in outs:
                    conn.execute("""
                        INSERT INTO rm_simple_movements
                            (voucher_id, item_id, material_id, movement_type,
                             from_godown_id, to_godown_id, qty, moved_by, remarks)
                        VALUES (%s, %s, %s, 'reverse_out', %s, %s, %s, %s, %s)
                    """, (vid, m["item_id"], m["material_id"],
                          m["from_godown_id"], m["to_godown_id"],
                          float(m["qty"] or 0), user, reverse_tag))
                    reversed_count += 1

            if cur_status == "received":
                # Also reverse the IN movements so destination is debited
                ins = conn.execute("""
                    SELECT item_id, material_id, from_godown_id,
                           to_godown_id, qty
                    FROM rm_simple_movements
                    WHERE voucher_id=%s AND movement_type='in'
                """, (vid,)).fetchall()
                for m in ins:
                    conn.execute("""
                        INSERT INTO rm_simple_movements
                            (voucher_id, item_id, material_id, movement_type,
                             from_godown_id, to_godown_id, qty, moved_by, remarks)
                        VALUES (%s, %s, %s, 'reverse_in', %s, %s, %s, %s, %s)
                    """, (vid, m["item_id"], m["material_id"],
                          m["from_godown_id"], m["to_godown_id"],
                          float(m["qty"] or 0), user, reverse_tag))
                    reversed_count += 1

            conn.execute("""
                UPDATE rm_simple_transfers
                   SET status='cancelled',
                       cancelled_at=NOW(),
                       cancelled_by=%s,
                       cancel_reason=%s
                 WHERE voucher_id=%s
            """, (user, reason or None, vid))
            _log_edit(conn, vid, "cancel",
                      f"from {cur_status}; {reversed_count} movement(s) reversed"
                      + (f"; reason: {reason}" if reason else ""))
            conn.commit()
            return jsonify({"status":"ok", "voucher_id": vid,
                            "reversed_count": reversed_count,
                            "from_status": cur_status})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # PRINT DATA  (returns the same shape as /get but with the company
    # context fields the print template needs).
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/<int:vid>/print_data",
               methods=["GET"])
    @_login_required
    def api_simple_print_data(vid):
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            row = conn.execute("""
                SELECT t.*,
                       gf.name AS from_godown_name,
                       gf.address AS from_godown_address,
                       gt.name AS to_godown_name,
                       gt.address AS to_godown_address
                FROM rm_simple_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.voucher_id = %s
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"not_found"}), 404
            v = dict(row)
            for k in ("voucher_date","created_at","out_at","in_at","cancelled_at"):
                if v.get(k) is not None:
                    v[k] = str(v[k])
            v["total_items"] = int(v.get("total_items") or 0)
            v["total_pkgs"]  = float(v.get("total_pkgs") or 0)
            v["total_qty"]   = float(v.get("total_qty") or 0)

            items = conn.execute("""
                SELECT i.line_no, m.material_name, i.num_pkgs,
                       i.per_pkg_qty, i.total_qty, i.uom, i.remarks
                FROM rm_simple_transfer_items i
                LEFT JOIN procurement_materials m ON m.id = i.material_id
                WHERE i.voucher_id = %s
                ORDER BY i.line_no, i.item_id
            """, (vid,)).fetchall()
            v["items"] = [
                {
                    "line_no":      int(it["line_no"] or 1),
                    "material_name": it["material_name"] or "",
                    "num_pkgs":     float(it["num_pkgs"] or 0),
                    "per_pkg_qty":  float(it["per_pkg_qty"] or 0),
                    "total_qty":    float(it["total_qty"] or 0),
                    "uom":          it["uom"] or "",
                    "remarks":      it["remarks"] or "",
                }
                for it in items
            ]
            return jsonify({"status":"ok", "voucher": v,
                            "company": {
                                "name": "HCP Wellness Pvt Ltd"
                            }})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ────────────────────────────────────────────────────────────────────
    # WHATSAPP TEXT  (returns the pre-formatted message ready to URL-encode)
    # ────────────────────────────────────────────────────────────────────
    @app.route("/api/inventory_simple_transfer/<int:vid>/whatsapp_text",
               methods=["GET"])
    @_login_required
    def api_simple_whatsapp_text(vid):
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status":"error","message":"DB connection failed"}), 500
        try:
            row = conn.execute("""
                SELECT t.voucher_no, t.voucher_date, t.status,
                       t.total_items, t.total_pkgs, t.total_qty, t.remarks,
                       gf.name AS from_godown_name,
                       gt.name AS to_godown_name
                FROM rm_simple_transfers t
                LEFT JOIN procurement_godowns gf ON gf.id = t.from_godown_id
                LEFT JOIN procurement_godowns gt ON gt.id = t.to_godown_id
                WHERE t.voucher_id = %s
            """, (vid,)).fetchone()
            if not row:
                return jsonify({"status":"not_found"}), 404
            items = conn.execute("""
                SELECT m.material_name, i.num_pkgs, i.per_pkg_qty,
                       i.total_qty, i.uom
                FROM rm_simple_transfer_items i
                LEFT JOIN procurement_materials m ON m.id = i.material_id
                WHERE i.voucher_id = %s
                ORDER BY i.line_no, i.item_id
            """, (vid,)).fetchall()

            def fmt_num(n, places=3):
                # Strip trailing zeros but keep at least 0 places after the dot
                s = f"{float(n or 0):,.{places}f}"
                if "." in s:
                    s = s.rstrip("0").rstrip(".")
                return s

            d_str = str(row["voucher_date"] or "")
            # Convert YYYY-MM-DD to DD-MM-YYYY for the message
            try:
                dd, mm, yyyy = d_str.split("-")[2], d_str.split("-")[1], d_str.split("-")[0]
                d_disp = f"{dd}-{mm}-{yyyy}"
            except Exception:
                d_disp = d_str

            lines = []
            lines.append("📋 *Stock Transfer Voucher*")
            lines.append(f"🗓 {d_disp}  |  No: {row['voucher_no']}")
            lines.append("━━━━━━━━━━━━━━━━━━━━")
            lines.append(f"FROM: *{row['from_godown_name'] or '—'}*")
            lines.append(f"TO:   *{row['to_godown_name']   or '—'}*")
            lines.append(f"Status: *{(row['status'] or '').upper()}*")
            lines.append("━━━━━━━━━━━━━━━━━━━━")
            for i, it in enumerate(items, start=1):
                uom = (it["uom"] or "").strip()
                tail = f" {uom}" if uom else ""
                np_ = fmt_num(it["num_pkgs"])
                pp  = fmt_num(it["per_pkg_qty"])
                tq  = fmt_num(it["total_qty"])
                lines.append(f"{i}. *{it['material_name']}*")
                lines.append(f"   {np_} pkg × {pp}{tail} = *{tq}{tail}*")
            lines.append("━━━━━━━━━━━━━━━━━━━━")
            lines.append(f"Total items: *{int(row['total_items'] or 0)}*")
            lines.append(f"Total qty:   *{fmt_num(row['total_qty'])}*")
            if row["remarks"]:
                lines.append("")
                lines.append(f"📝 {row['remarks']}")
            lines.append("")
            lines.append("_HCP Wellness Pvt Ltd_")
            text = "\n".join(lines)
            return jsonify({"status":"ok", "text": text})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status":"error","message":str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    print("✅ [InventorySimpleTransfer] routes registered "
          "(/api/inventory_simple_transfer/*)")
