r"""
inventory_fefo.py  –  FEFO (First Expiry First Out)  (Inventory Phase 3)
========================================================================
HCP Wellness Pvt Ltd

Replaces FIFO with FEFO for RM stock picking. Boxes carry their expiry via
the GRN line they came from:

    rm_boxes.grn_item_id  →  procurement_grn_items.expiry_date

FEFO ordering rule (used everywhere boxes are auto-picked or validated):
    1. Boxes WITH an expiry date, earliest expiry first.
    2. Boxes with NO expiry date sort LAST (a box with a known expiry must
       always be consumed before an undated one).
    3. Tiebreak: oldest created_at, then box_id  (FIFO within equal expiry).

Three layers (full pm_stock-style model):
  • ORDERING   — _fefo_order_sql() gives the ORDER BY fragment; the Material
                 Request box-suggestion and any other auto-pick uses it.
  • ENFORCEMENT— _fefo_check_box() decides whether scanning a given box
                 violates FEFO (i.e. an earlier-expiry box of the same
                 material is still in stock at that godown). The transfer
                 scan_out route calls it and blocks violations.
  • OVERRIDE   — non-admins raise an override request (box + reason); an
                 admin approves/rejects. An approved request is a single-use
                 pass letting that user scan that exact box once. Gated by
                 the Phase 1 'fefo_override' access category.

Table (created here, idempotently):
  inventory_fefo_overrides — one row per override request.

Admins bypass FEFO entirely (no enforcement, no override needed).

Register: auto-called from register_inventory_mgmt() (guarded). No app.py
change needed. API prefix: /api/inventory_mgmt/fefo/*
"""

from __future__ import annotations

from functools import wraps
from datetime import datetime

from flask import session, jsonify, request

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# AUTH HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _user() -> str:
    return session.get("User_Name") or session.get("UID") or "Unknown"


def _is_admin() -> bool:
    if not session.get("logged_in"):
        return False
    role = (session.get("User_Type") or "").strip().lower()
    uid = (session.get("UID") or "").strip().lower()
    return role == "admin" or uid in {"sonal", "tarak"}


def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


def _admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        if not _is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        return f(*args, **kwargs)
    return wrapper


def _has_override_access():
    """Gate the approvals surface behind the Phase 1 'fefo_override' category.
    Admins always pass. Best-effort (fail-closed for non-admins if the access
    module is missing, since this is a sensitive approval surface)."""
    if _is_admin():
        return True
    try:
        from inventory import inventory_access as _ia
    except Exception:
        try:
            import inventory_access as _ia
        except Exception:
            return False
    try:
        return _ia._inv_user_has_access("fefo_override")
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# FEFO ORDERING  (the shared rule)
# ─────────────────────────────────────────────────────────────────────────────
# A reusable ORDER BY fragment. Assumes the query joins rm_boxes (alias `b`)
# to procurement_grn_items (alias `gi`) on b.grn_item_id = gi.id and selects
# gi.expiry_date. Undated boxes sort last; FIFO tiebreak within equal expiry.
def _fefo_order_sql(box_alias="b", item_alias="gi"):
    return (
        f"ORDER BY ({item_alias}.expiry_date IS NULL), "
        f"{item_alias}.expiry_date ASC, "
        f"{box_alias}.created_at ASC, {box_alias}.box_id ASC"
    )


# The SELECT/JOIN fragment to attach expiry to a box query.
def _fefo_join_sql():
    return "LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id"


# ─────────────────────────────────────────────────────────────────────────────
# TABLE INIT
# ─────────────────────────────────────────────────────────────────────────────

def _init_fefo_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryFEFO] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_fefo_overrides (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                box_id          INT          NOT NULL,
                box_code        VARCHAR(50)  DEFAULT NULL,
                material_id     INT          DEFAULT NULL,
                godown_id       INT          DEFAULT NULL,
                box_expiry      DATE         DEFAULT NULL,
                earliest_expiry DATE         DEFAULT NULL,
                reason          VARCHAR(500) NOT NULL,
                status          ENUM('pending','approved','used','rejected')
                                NOT NULL DEFAULT 'pending',
                requested_by    VARCHAR(80)  NOT NULL,
                requested_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                decided_by      VARCHAR(80)  DEFAULT NULL,
                decided_at      DATETIME     DEFAULT NULL,
                decide_note     VARCHAR(500) DEFAULT NULL,
                used_at         DATETIME     DEFAULT NULL,
                INDEX ix_inv_fefo_status (status),
                INDEX ix_inv_fefo_box    (box_id),
                INDEX ix_inv_fefo_by     (requested_by)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        print("✅ [InventoryFEFO] override table ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# ENFORCEMENT  (importable by inventory_transfers scan_out)
# ─────────────────────────────────────────────────────────────────────────────

def _box_expiry(conn, box_id):
    """Return (expiry_date_or_None, material_id, godown_id) for a box."""
    row = conn.execute(
        """SELECT b.material_id, b.current_godown_id, gi.expiry_date
           FROM rm_boxes b
           LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
           WHERE b.box_id=%s""",
        (int(box_id),),
    ).fetchone()
    if not row:
        return None, None, None
    d = dict(row)
    return d.get("expiry_date"), d.get("material_id"), d.get("current_godown_id")


def _earliest_expiry_for(conn, material_id, godown_id, exclude_box_id=None):
    """Return (earliest_expiry_date, earliest_box_code) among in-stock boxes of
    this material at this godown that HAVE an expiry. None if none dated."""
    params = [int(material_id), int(godown_id)]
    excl = ""
    if exclude_box_id:
        excl = "AND b.box_id <> %s"
        params.append(int(exclude_box_id))
    row = conn.execute(
        f"""SELECT gi.expiry_date, b.box_code
            FROM rm_boxes b
            JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
            WHERE b.material_id=%s AND b.current_godown_id=%s
              AND b.current_status='in_stock'
              AND gi.expiry_date IS NOT NULL
              {excl}
            ORDER BY gi.expiry_date ASC, b.box_id ASC
            LIMIT 1""",
        tuple(params),
    ).fetchone()
    if not row:
        return None, None
    d = dict(row)
    return d.get("expiry_date"), d.get("box_code")


def _consume_override(conn, box_id, user):
    """If `user` holds an APPROVED, unused override for `box_id`, mark it used
    and return True. Otherwise False."""
    row = conn.execute(
        """SELECT id FROM inventory_fefo_overrides
           WHERE box_id=%s AND requested_by=%s AND status='approved'
           ORDER BY id DESC LIMIT 1""",
        (int(box_id), user),
    ).fetchone()
    if not row:
        return False
    oid = row["id"] if hasattr(row, "get") else row[0]
    conn.execute(
        "UPDATE inventory_fefo_overrides SET status='used', used_at=NOW() WHERE id=%s",
        (int(oid),),
    )
    return True


def fefo_check_box(conn, box_id, user=None, is_admin=None):
    """Decide whether scanning `box_id` is allowed under FEFO.

    Returns a dict:
      {'allowed': True}                              → proceed
      {'allowed': True, 'override_used': True}       → proceed (consumed a pass)
      {'allowed': False, 'reason':..., 'box_expiry':..., 'earliest_expiry':...,
       'earliest_box_code':...}                       → caller should block

    Admins always allowed. A box whose expiry is the earliest (or there is no
    earlier-expiry stock) is allowed. A FEFO-violating box is allowed only if
    the user holds an approved override (which is then consumed).
    """
    user = user if user is not None else _user()
    is_admin = _is_admin() if is_admin is None else is_admin
    if is_admin:
        return {"allowed": True}

    box_exp, mat_id, god_id = _box_expiry(conn, box_id)
    if mat_id is None or god_id is None:
        return {"allowed": True}  # can't evaluate → don't block

    # FIFO-fallback policy: a box with NO expiry is never blocked. FEFO only
    # governs boxes that HAVE an expiry — undated stock falls back to FIFO,
    # which guides ordering (suggestions) but does not hard-block scanning.
    if box_exp is None:
        return {"allowed": True}

    earliest, earliest_code = _earliest_expiry_for(conn, mat_id, god_id, exclude_box_id=box_id)

    # No other dated stock exists → nothing earlier to violate.
    if earliest is None:
        return {"allowed": True}

    # Violation only if a strictly-earlier expiry exists elsewhere in stock.
    if not (earliest < box_exp):
        return {"allowed": True}

    # Violation — does the user hold an approved override?
    if _consume_override(conn, box_id, user):
        return {"allowed": True, "override_used": True}

    return {
        "allowed": False,
        "reason": "fefo_violation",
        "box_expiry": str(box_exp) if box_exp else None,
        "earliest_expiry": str(earliest) if earliest else None,
        "earliest_box_code": earliest_code,
        "material_id": int(mat_id),
        "godown_id": int(god_id),
    }


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

def register_inventory_fefo(app):
    if getattr(app, "_inventory_fefo_registered", False):
        return
    app._inventory_fefo_registered = True
    _init_fefo_tables()

    PFX = "/api/inventory_mgmt/fefo"

    # ── Raise an override request (non-admin) ─────────────────────────────
    @app.route(f"{PFX}/override/request", methods=["POST"])
    @_login_required
    def api_fefo_override_request():
        d = request.get_json(silent=True) or {}
        reason = (d.get("reason") or "").strip()
        box_code = (d.get("box_code") or "").strip().upper()
        try:
            box_id = int(d.get("box_id") or 0)
        except Exception:
            box_id = 0
        if not reason:
            return jsonify({"status": "error", "message": "A reason is required"}), 400
        if not box_id and not box_code:
            return jsonify({"status": "error", "message": "box_id or box_code required"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            if not box_id and box_code:
                row = conn.execute(
                    "SELECT box_id FROM rm_boxes WHERE box_code=%s LIMIT 1", (box_code,)
                ).fetchone()
                if not row:
                    conn.close()
                    return jsonify({"status": "error", "message": "Box not found"}), 404
                box_id = int(row["box_id"] if hasattr(row, "get") else row[0])

            box_exp, mat_id, god_id = _box_expiry(conn, box_id)
            earliest, _ = _earliest_expiry_for(conn, mat_id, god_id, exclude_box_id=box_id) if mat_id else (None, None)

            bc = box_code
            if not bc:
                br = conn.execute("SELECT box_code FROM rm_boxes WHERE box_id=%s", (box_id,)).fetchone()
                bc = (br["box_code"] if hasattr(br, "get") else br[0]) if br else None

            # Avoid stacking duplicate pending requests for the same box+user.
            dup = conn.execute(
                "SELECT id FROM inventory_fefo_overrides "
                "WHERE box_id=%s AND requested_by=%s AND status IN ('pending','approved') LIMIT 1",
                (box_id, _user()),
            ).fetchone()
            if dup:
                conn.close()
                return jsonify({"status": "ok", "duplicate": True,
                                "message": "You already have a pending/approved override for this box."})

            conn.execute(
                """INSERT INTO inventory_fefo_overrides
                     (box_id, box_code, material_id, godown_id, box_expiry,
                      earliest_expiry, reason, status, requested_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s)""",
                (box_id, bc, mat_id, god_id, box_exp, earliest, reason, _user()),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── List override requests (admin sees all; user sees own) ────────────
    @app.route(f"{PFX}/override/requests", methods=["GET"])
    @_login_required
    def api_fefo_override_requests():
        st = (request.args.get("status") or "").strip()
        mine = request.args.get("mine") == "1" or not _has_override_access()
        conn = sampling_portal.get_db_connection()
        try:
            where, params = [], []
            if st:
                where.append("o.status=%s"); params.append(st)
            if mine:
                where.append("o.requested_by=%s"); params.append(_user())
            where_sql = (" WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                f"""SELECT o.*, COALESCE(m.material_name,'') AS material_name,
                           COALESCE(g.name,'') AS godown_name
                    FROM inventory_fefo_overrides o
                    LEFT JOIN procurement_materials m ON m.id = o.material_id
                    LEFT JOIN procurement_godowns   g ON g.id = o.godown_id
                    {where_sql}
                    ORDER BY o.id DESC""",
                tuple(params),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                for k in ("requested_at", "decided_at", "used_at", "box_expiry", "earliest_expiry"):
                    if dd.get(k) is not None:
                        dd[k] = str(dd[k])
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "requests": out, "can_approve": _has_override_access()})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/override/pending_count", methods=["GET"])
    @_login_required
    def api_fefo_override_pending_count():
        if not _has_override_access():
            return jsonify({"status": "ok", "count": 0})
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_fefo_overrides WHERE status='pending'"
            ).fetchone()
            conn.close()
            c = (row["c"] if hasattr(row, "get") else row[0]) if row else 0
            return jsonify({"status": "ok", "count": int(c or 0)})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    def _decide(oid, new_status, note):
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT status FROM inventory_fefo_overrides WHERE id=%s", (oid,)
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            cur = r["status"] if hasattr(r, "get") else r[0]
            if cur != "pending":
                conn.close()
                return jsonify({"status": "error", "message": f"Already {cur}."}), 400
            conn.execute(
                "UPDATE inventory_fefo_overrides "
                "SET status=%s, decided_by=%s, decided_at=NOW(), decide_note=%s WHERE id=%s",
                (new_status, _user(), (note or "").strip() or None, oid),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/override/<int:oid>/approve", methods=["POST"])
    @_login_required
    def api_fefo_override_approve(oid):
        if not _has_override_access():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        return _decide(oid, "approved", d.get("note"))

    @app.route(f"{PFX}/override/<int:oid>/reject", methods=["POST"])
    @_login_required
    def api_fefo_override_reject(oid):
        if not _has_override_access():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        return _decide(oid, "rejected", d.get("note"))

    print("✅ [InventoryFEFO] routes registered (/api/inventory_mgmt/fefo/*)")
