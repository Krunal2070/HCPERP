r"""
inventory_fefo_code.py  –  FEFO Label Code  (RM labels)
=======================================================
HCP Wellness Pvt Ltd

Generates the short FEFO code printed on RM box labels (e.g. "F2608").

Design (per the agreed spec):
  • Derived from the EXPIRY DATE, not a running arrival sequence. Format is
    F + YYMM  →  expiry Aug 2026 → "F2608". This is:
      - stable: the expiry never changes, so a printed sticker never goes stale;
      - naturally FEFO-ordered: sorting the codes sorts by expiry;
      - never needs renumbering when newer/earlier stock arrives.
  • Scoped per material (FEFO picking is always within one material).
  • Boxes with NO expiry get the fixed token "F----" (non-expiring stock).

A mapping row is stored per (material_id, expiry_date) so the code is
consistent across reprints and lookups. The code itself is deterministic
from the expiry, so the table is really just an audit/cache — but keeping it
lets us attach a per-material running index later if ever needed without
breaking printed labels.

Importable helper (used by the label builder / GRN box flow):
    fefo_code_for(expiry_date) -> "F2608" | "F----"
    get_or_store_fefo_code(conn, material_id, expiry_date) -> same, and caches

Register: auto-called from register_inventory_mgmt() (guarded). Also exposes
a tiny API the frontend label code can call if it doesn't already have the
expiry on hand:  GET /api/inventory_mgmt/fefo_code?expiry=YYYY-MM-DD
"""

from __future__ import annotations

from functools import wraps

from flask import session, jsonify, request

import sampling_portal


NO_EXPIRY_TOKEN = "F----"


# ── core code derivation (pure, no DB) ───────────────────────────────────────

def fefo_code_for(expiry_date) -> str:
    """F + YYMM from an expiry date. 'F----' when there is no expiry.

    Accepts a date/datetime or an ISO-ish string ('2026-08-14', '2026-08',
    '2026-08-14 00:00:00'). Returns the fixed no-expiry token otherwise.
    """
    if not expiry_date:
        return NO_EXPIRY_TOKEN
    s = str(expiry_date).strip()
    # Pull the leading YYYY-MM out of whatever form we got.
    import re
    m = re.match(r"^(\d{4})-(\d{2})", s)
    if not m:
        # Try a date/datetime object.
        try:
            return f"F{expiry_date.year % 100:02d}{expiry_date.month:02d}"
        except Exception:
            return NO_EXPIRY_TOKEN
    yyyy, mm = int(m.group(1)), int(m.group(2))
    return f"F{yyyy % 100:02d}{mm:02d}"


# ── auth (for the tiny lookup endpoint) ──────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


# ── table ────────────────────────────────────────────────────────────────────

def _init_fefo_code_table():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryFefoCode] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_fefo_codes (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                material_id INT          NOT NULL,
                expiry_date DATE         DEFAULT NULL,
                fefo_code   VARCHAR(16)  NOT NULL,
                created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_inv_fefo (material_id, expiry_date),
                INDEX ix_inv_fefo_mat (material_id, expiry_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        print("✅ [InventoryFefoCode] fefo-code table ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── cache/store (idempotent) ─────────────────────────────────────────────────

def get_or_store_fefo_code(conn, material_id, expiry_date) -> str:
    """Return the FEFO code for (material, expiry), caching it. The code is
    deterministic from the expiry; the row is an audit/cache. Safe to call
    repeatedly. Caller commits."""
    code = fefo_code_for(expiry_date)
    if not material_id:
        return code
    # Normalise expiry to a DATE string or None for the unique key.
    exp = None
    if expiry_date:
        s = str(expiry_date).strip()[:10]
        import re
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            exp = s
        elif re.match(r"^\d{4}-\d{2}$", s):
            exp = s + "-01"
    try:
        existing = conn.execute(
            "SELECT fefo_code FROM inventory_fefo_codes "
            "WHERE material_id=%s AND expiry_date <=> %s LIMIT 1",
            (int(material_id), exp),
        ).fetchone()
        if existing:
            return (existing["fefo_code"] if hasattr(existing, "get") else existing[0]) or code
        conn.execute(
            "INSERT INTO inventory_fefo_codes (material_id, expiry_date, fefo_code) "
            "VALUES (%s,%s,%s)",
            (int(material_id), exp, code),
        )
    except Exception:
        # Never fail a label/GRN flow over the cache; the deterministic code
        # is still correct.
        pass
    return code


# ── routes ───────────────────────────────────────────────────────────────────

def register_inventory_fefo_code(app):
    if getattr(app, "_inventory_fefocode_registered", False):
        return
    app._inventory_fefocode_registered = True
    _init_fefo_code_table()

    @app.route("/api/inventory_mgmt/fefo_code", methods=["GET"])
    @_login_required
    def api_inv_fefo_code():
        """Tiny helper: derive the code from an expiry the client already has.
        Optionally caches it if material_id is supplied."""
        expiry = request.args.get("expiry") or ""
        try:
            material_id = int(request.args.get("material_id") or 0) or None
        except Exception:
            material_id = None
        if material_id:
            conn = sampling_portal.get_db_connection()
            try:
                code = get_or_store_fefo_code(conn, material_id, expiry)
                conn.commit(); conn.close()
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                code = fefo_code_for(expiry)
        else:
            code = fefo_code_for(expiry)
        return jsonify({"status": "ok", "fefo_code": code})

    print("✅ [InventoryFefoCode] routes registered (/api/inventory_mgmt/fefo_code)")
