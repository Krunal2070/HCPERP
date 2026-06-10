"""
inventory_voucher_numbering.py
═══════════════════════════════════════════════════════════════════════════════
Inventory-only voucher numbering admin (multi-style, PM-style UX).

This module manages voucher number formats for inventory vouchers
(currently just Material Request, voucher_type='inv_mr'). Multiple
styles per type are supported, each with its own validity window
(valid_from, valid_to). At allocation time, the style where today falls
inside the validity window is the "active" one — and that's the one
used to format the next number.

Self-contained:
  • Owns its own table `inventory_voucher_numbering` (created on first
    registration). Does NOT touch PM Stock's procurement_voucher_numbering.
  • Zero dependency on PM Stock's helpers.py or any code outside the
    inventory module.

Endpoints (all admin-only):
  GET  /api/inventory_mgmt/voucher_numbering/list
       → { status:'ok', styles:[ {id, voucher_type, prefix, suffix,
                                  digits, start_num, valid_from, valid_to,
                                  preview}, … ],
           types:[ {voucher_type, label}, … ] }
  POST /api/inventory_mgmt/voucher_numbering/save
       Body: { voucher_type, id?, prefix, suffix, digits, start_num,
               valid_from, valid_to }
  POST /api/inventory_mgmt/voucher_numbering/delete
       Body: { id }
  POST /api/inventory_mgmt/voucher_numbering/preview
       Body: { voucher_type, prefix, suffix, digits, start_num }

Allocation (called by consumer modules):
  next_voucher_no(conn, vtype) → str    # picks the active style for today

Future voucher types: add to INV_TYPES + INV_TYPE_LABELS + INV_DEFAULTS +
_SOURCE_TBL_MAP below.
"""

from functools import wraps
from datetime import date

from flask import jsonify, request, session

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

INV_TYPES = (
    'inv_mr',       # Material Request
    'inv_mt',       # Material Transfer — OUT voucher (transfer_no)
    'inv_mt_in',    # Material Transfer — IN voucher  (in_voucher_no)
    'inv_st',       # Material Transfer (Simple — intra-warehouse)
    'inv_dn',       # Delivery Note
    'inv_aud',      # Audit Session
)

INV_TYPE_LABELS = {
    'inv_mr':    'Material Request',
    'inv_mt':    'Material Transfer (OUT voucher)',
    'inv_mt_in': 'Material Transfer (IN voucher)',
    'inv_st':    'Material Transfer (Simple)',
    'inv_dn':    'Delivery Note',
    'inv_aud':   'Audit Session',
}

INV_DEFAULTS = {
    'inv_mr':    {'prefix': 'INV-MR',  'suffix': '', 'digits': 4, 'start_num': 1},
    # 2026-05-30: two-number scheme. 'inv_mt' is the OUT side (stored on
    # rm_stock_transfers.transfer_no), 'inv_mt_in' is the IN side
    # (rm_stock_transfers.in_voucher_no, allocated at submit_out).
    # New prefixes: OUT/RM and IN/RM. Legacy rows with TR/RM/... still
    # work — inventory_transfers.py's allocator scans both prefixes so
    # the OUT sequence continues from where TR/RM left off within an FY.
    'inv_mt':    {'prefix': 'OUT/RM',  'suffix': '', 'digits': 4, 'start_num': 1},
    'inv_mt_in': {'prefix': 'IN/RM',   'suffix': '', 'digits': 4, 'start_num': 1},
    'inv_st':    {'prefix': 'ST/RM',   'suffix': '', 'digits': 4, 'start_num': 1},
    'inv_dn':    {'prefix': 'DN',      'suffix': '', 'digits': 4, 'start_num': 1},
    'inv_aud':   {'prefix': 'AUD',     'suffix': '', 'digits': 4, 'start_num': 1},
}

# Voucher-type → (source_table, voucher_no_column). Used to scan existing
# voucher numbers and compute "what's next" under a given style.
# When you add a new voucher type, update all four config maps above AND
# add the source-table row here, otherwise allocation falls back to the
# style's start_num because the scan has nowhere to look.
_SOURCE_TBL_MAP = {
    'inv_mr':    ('inventory_material_requests', 'request_no'),
    'inv_mt':    ('rm_stock_transfers',          'transfer_no'),
    'inv_mt_in': ('rm_stock_transfers',          'in_voucher_no'),
    'inv_st':    ('rm_simple_transfers',         'voucher_no'),
    'inv_dn':    ('inventory_dn',                'dn_no'),
    'inv_aud':   ('inventory_audit_sessions',    'session_no'),
}


# ─────────────────────────────────────────────────────────────────────────────
# AUTH  (mirrors inventory_label_reprint.py)
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
            return jsonify({"status": "error",
                            "message": "Admin access required"}), 403
        return f(*args, **kwargs)
    return wrapper


# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA + SEEDING
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_table(conn) -> None:
    """Create inventory_voucher_numbering if missing. Idempotent.

    Seeds a sensible default row for every voucher type in INV_TYPES that
    doesn't yet have ANY rows, so the admin UI is never empty on first
    open. Default validity window: today → today + 50 years."""
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_voucher_numbering (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                voucher_type VARCHAR(32)  NOT NULL,
                prefix       VARCHAR(32)  NOT NULL DEFAULT '',
                suffix       VARCHAR(32)  NOT NULL DEFAULT '',
                digits       TINYINT      NOT NULL DEFAULT 4,
                start_num    INT          NOT NULL DEFAULT 1,
                valid_from   DATE         NOT NULL,
                valid_to     DATE         NOT NULL,
                created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                            ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_vt (voucher_type),
                KEY idx_validity (voucher_type, valid_from, valid_to)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        for vt in INV_TYPES:
            row = conn.execute(
                "SELECT id FROM inventory_voucher_numbering "
                "WHERE voucher_type=%s LIMIT 1",
                (vt,),
            ).fetchone()
            if row:
                continue
            d = INV_DEFAULTS.get(vt, {})
            conn.execute(
                "INSERT INTO inventory_voucher_numbering "
                "(voucher_type, prefix, suffix, digits, start_num, "
                " valid_from, valid_to) "
                "VALUES (%s, %s, %s, %s, %s, "
                "        CURDATE(), DATE_ADD(CURDATE(), INTERVAL 50 YEAR))",
                (vt, d.get('prefix', ''), d.get('suffix', ''),
                 int(d.get('digits', 4)), int(d.get('start_num', 1))),
            )
        conn.commit()
    except Exception:
        import traceback
        traceback.print_exc()


# ─────────────────────────────────────────────────────────────────────────────
# PREVIEW
# ─────────────────────────────────────────────────────────────────────────────

def _preview_next(conn, vtype: str, style: dict) -> str:
    """Compute the next-number string under a given style. Read-only.

    Scans the source table for existing voucher numbers matching the
    style's prefix, finds the highest trailing sequence, adds 1. Falls
    back to start_num if no matches."""
    import re
    prefix  = (style.get('prefix') or '').strip()
    suffix  = (style.get('suffix') or '').strip()
    try:    digits = int(style.get('digits') or 4)
    except Exception: digits = 4
    try:    start  = int(style.get('start_num') or 1)
    except Exception: start = 1

    tbl, col = _SOURCE_TBL_MAP.get(vtype, (None, None))
    max_seq = start - 1
    if tbl and col:
        try:
            pattern = (prefix + '/%') if prefix else '%'
            rows = conn.execute(
                f"SELECT {col} FROM {tbl} WHERE {col} LIKE %s",
                (pattern,),
            ).fetchall()
            for r in rows:
                v = r[col] if isinstance(r, dict) else r[0]
                nums = re.findall(r'(\d{' + str(digits) + r',})', str(v or ''))
                if nums:
                    try:
                        max_seq = max(max_seq, int(nums[-1]))
                    except Exception:
                        pass
        except Exception:
            pass
    next_seq = max_seq + 1
    return '/'.join(p for p in [prefix, str(next_seq).zfill(digits), suffix] if p)


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRATION
# ─────────────────────────────────────────────────────────────────────────────

def register_inventory_voucher_numbering(app):
    """Mount the admin endpoints. Idempotent — skips if already registered.
    Auto-creates inventory_voucher_numbering on first call."""
    if getattr(app, "_inventory_vn_registered", False):
        return
    app._inventory_vn_registered = True

    # ── one-time schema setup ───────────────────────────────────────────
    try:
        conn = sampling_portal.get_db_connection()
        if conn:
            _ensure_table(conn)
            conn.close()
    except Exception:
        print("[InventoryVoucherNumbering] ⚠️  Schema setup deferred — DB unavailable")

    # ── LIST ──────────────────────────────────────────────────────────────
    # Returns ALL styles across ALL inventory voucher types, flattened.
    # Frontend filters by tabs. Shape matches PM's voucher_numbering/list
    # (key 'styles'), with an extra 'types' list for tab labels.
    @app.route("/api/inventory_mgmt/voucher_numbering/list", methods=["GET"])
    @_admin_required
    def api_inv_vn_list():
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            _ensure_table(conn)
            placeholders = ",".join(["%s"] * len(INV_TYPES))
            rows = conn.execute(
                f"SELECT id, voucher_type, prefix, suffix, digits, start_num, "
                f"       valid_from, valid_to "
                f"FROM inventory_voucher_numbering "
                f"WHERE voucher_type IN ({placeholders}) "
                f"ORDER BY voucher_type, valid_from DESC, id DESC",
                tuple(INV_TYPES),
            ).fetchall()
            styles = []
            for r in rows:
                rd = dict(r)
                if rd.get("valid_from") is not None:
                    rd["valid_from"] = str(rd["valid_from"])[:10]
                if rd.get("valid_to") is not None:
                    rd["valid_to"] = str(rd["valid_to"])[:10]
                rd["preview"] = _preview_next(conn, rd["voucher_type"], rd)
                styles.append(rd)
            conn.close()
            return jsonify({
                "status": "ok",
                "styles": styles,
                "types":  [{"voucher_type": vt, "label": INV_TYPE_LABELS.get(vt, vt)}
                           for vt in INV_TYPES],
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            import traceback; traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── SAVE ──────────────────────────────────────────────────────────────
    @app.route("/api/inventory_mgmt/voucher_numbering/save", methods=["POST"])
    @_admin_required
    def api_inv_vn_save():
        d = request.get_json() or {}
        vt = (d.get("voucher_type") or "").strip().lower()
        if vt not in INV_TYPES:
            return jsonify({
                "status": "error",
                "message": f"voucher_type must be one of: {', '.join(INV_TYPES)}"
            }), 400
        prefix = (d.get("prefix") or "").strip()[:32]
        suffix = (d.get("suffix") or "").strip()[:32]
        try:    digits = max(1, min(8, int(d.get("digits", 4))))
        except Exception: digits = 4
        try:    start_num = max(1, int(d.get("start_num", 1)))
        except Exception: start_num = 1
        valid_from = d.get("valid_from") or None
        valid_to   = d.get("valid_to") or None
        if not valid_from or not valid_to:
            return jsonify({"status": "error",
                            "message": "valid_from and valid_to are required"}), 400
        if str(valid_from) > str(valid_to):
            return jsonify({"status": "error",
                            "message": "valid_from must be on or before valid_to"}), 400
        sid = d.get("id")

        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            _ensure_table(conn)
            if sid:
                row = conn.execute(
                    "SELECT voucher_type FROM inventory_voucher_numbering WHERE id=%s",
                    (sid,),
                ).fetchone()
                if not row:
                    conn.close()
                    return jsonify({"status": "error", "message": "Style id not found"}), 404
                existing_vt = row["voucher_type"] if isinstance(row, dict) else row[0]
                if (existing_vt or "").lower() != vt:
                    conn.close()
                    return jsonify({"status": "error",
                                    "message": "voucher_type mismatch with stored row"}), 400
                conn.execute(
                    "UPDATE inventory_voucher_numbering "
                    "SET prefix=%s, suffix=%s, digits=%s, start_num=%s, "
                    "    valid_from=%s, valid_to=%s "
                    "WHERE id=%s",
                    (prefix, suffix, digits, start_num, valid_from, valid_to, sid),
                )
            else:
                conn.execute(
                    "INSERT INTO inventory_voucher_numbering "
                    "(voucher_type, prefix, suffix, digits, start_num, "
                    " valid_from, valid_to) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (vt, prefix, suffix, digits, start_num, valid_from, valid_to),
                )
            conn.commit()
            preview = _preview_next(conn, vt, {
                "prefix": prefix, "suffix": suffix,
                "digits": digits, "start_num": start_num,
            })
            conn.close()
            return jsonify({
                "status":       "ok",
                "voucher_type": vt,
                "preview":      preview,
                "saved_by":     _user(),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            import traceback; traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── DELETE ────────────────────────────────────────────────────────────
    @app.route("/api/inventory_mgmt/voucher_numbering/delete", methods=["POST"])
    @_admin_required
    def api_inv_vn_delete():
        d = request.get_json() or {}
        sid = d.get("id")
        if not sid:
            return jsonify({"status": "error", "message": "id required"}), 400
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            row = conn.execute(
                "SELECT voucher_type FROM inventory_voucher_numbering WHERE id=%s",
                (sid,),
            ).fetchone()
            if not row:
                conn.close()
                return jsonify({"status": "error", "message": "Style id not found"}), 404
            vt = (row["voucher_type"] if isinstance(row, dict) else row[0]) or ""
            if vt.lower() not in INV_TYPES:
                conn.close()
                return jsonify({"status": "error",
                                "message": "Not an inventory voucher type"}), 403
            cnt_row = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_voucher_numbering "
                "WHERE voucher_type=%s",
                (vt,),
            ).fetchone()
            cnt = int((cnt_row["c"] if isinstance(cnt_row, dict) else cnt_row[0]) or 0)
            if cnt <= 1:
                conn.close()
                return jsonify({
                    "status": "error",
                    "message": f"Cannot delete the only style for "
                               f"{INV_TYPE_LABELS.get(vt, vt)}. "
                               f"Add another style first, then delete this one."
                }), 400
            conn.execute(
                "DELETE FROM inventory_voucher_numbering WHERE id=%s",
                (sid,),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            import traceback; traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── PREVIEW (live, no DB write) ───────────────────────────────────────
    @app.route("/api/inventory_mgmt/voucher_numbering/preview", methods=["POST"])
    @_admin_required
    def api_inv_vn_preview():
        d = request.get_json() or {}
        vt = (d.get("voucher_type") or "").strip().lower()
        if vt not in INV_TYPES:
            return jsonify({"status": "error",
                            "message": f"voucher_type must be one of: {', '.join(INV_TYPES)}"}), 400
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            preview = _preview_next(conn, vt, {
                "prefix":    d.get("prefix", ""),
                "suffix":    d.get("suffix", ""),
                "digits":    d.get("digits", 4),
                "start_num": d.get("start_num", 1),
            })
            conn.close()
            return jsonify({"status": "ok", "preview": preview})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryVoucherNumbering] routes registered "
          "(/api/inventory_mgmt/voucher_numbering/*)")


# ─────────────────────────────────────────────────────────────────────────────
# SHARED ALLOCATOR  (called by consumer modules — e.g. inventory_material_request)
# ─────────────────────────────────────────────────────────────────────────────

def next_voucher_no(conn, vtype: str) -> str:
    """Allocate the next voucher number for the given inventory voucher
    type, using the style whose validity window contains today. Returns
    '' if no active style exists (caller should fall back to its own
    legacy format)."""
    if vtype not in INV_TYPES:
        return ''
    try:
        _ensure_table(conn)
        today_iso = date.today().isoformat()
        row = conn.execute(
            "SELECT prefix, suffix, digits, start_num "
            "FROM inventory_voucher_numbering "
            "WHERE voucher_type=%s AND valid_from <= %s AND valid_to >= %s "
            "ORDER BY id DESC LIMIT 1",
            (vtype, today_iso, today_iso),
        ).fetchone()
        if not row:
            return ''
        style = dict(row) if not isinstance(row, dict) else row
        return _preview_next(conn, vtype, style)
    except Exception:
        return ''
