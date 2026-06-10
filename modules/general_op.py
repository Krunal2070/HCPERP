"""
general_op.py  —  General Operations Module  (Phase 1)
=======================================================
A department-agnostic operations hub that owns:
  • Godowns & Addresses  (moved from procurement)
  • Voucher Type Master   (new — Tally-style named types)
  • Voucher Numbering     (global, shared across modules)
  • User Keyboard Shortcuts (proxied from client localStorage,
                             server just serves the page)

URL  : /general_op
API  : /api/gop/*

DB tables used (shared with procurement — no renames):
  procurement_godowns              (unchanged schema)
  procurement_voucher_numbering    (unchanged schema)
  gop_voucher_type_masters         (NEW — created on init)

Access: same as procurement for Phase 1 (admin role or sonal uid).
        Can be widened later per-department.
"""

from __future__ import annotations

import traceback
from functools import wraps

from flask import render_template, session, jsonify, redirect, url_for, request

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# ACCESS
# ─────────────────────────────────────────────────────────────────────────────

GOP_ALLOWED_ROLES = {"admin"}
GOP_ALLOWED_UIDS  = {"sonal"}

# Predefined parent types — these are the fixed "types" like Tally's parents.
# Custom user-created types must belong to one of these parents.
GOP_PARENT_TYPES = [
    {"key": "po",           "label": "Purchase Order",        "module": "procurement"},
    {"key": "grn",          "label": "Purchase Receipt (GRN)", "module": "procurement"},
    {"key": "mtv",          "label": "Material Transfer",      "module": "general_op"},
    {"key": "receipt_note", "label": "Receipt Note",           "module": "general_op"},
    {"key": "stock_adj",    "label": "Stock Adjustment",       "module": "general_op"},
]


def _can_gop() -> bool:
    if not session.get("logged_in"):
        return False
    role = (session.get("User_Type") or "").strip().lower()
    uid  = (session.get("UID")       or "").strip().lower()
    return role in GOP_ALLOWED_ROLES or uid in GOP_ALLOWED_UIDS


def gop_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        if not _can_gop():
            return (
                """<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:48px 56px;text-align:center;
box-shadow:0 8px 32px rgba(0,0,0,.1);max-width:420px}
h1{color:#e11d48;font-size:1.8rem;margin-bottom:12px}p{color:#64748b;line-height:1.6}
a{color:#0d9488;text-decoration:none;font-weight:700}</style></head>
<body><div class="box"><h1>🔒 Access Denied</h1>
<p>You do not have permission to view <strong>General Operations</strong>.</p>
<p style="margin-top:24px"><a href="/">&#8592; Back to Portal</a></p>
</div></body></html>""",
                403,
            )
        return f(*args, **kwargs)
    return wrapper


# ─────────────────────────────────────────────────────────────────────────────
# DB INIT
# ─────────────────────────────────────────────────────────────────────────────

def _init_gop_tables():
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            print("[GeneralOP] ⚠ Could not get DB connection for table init")
            return

        # Voucher Type Masters — Tally-style named types under parent types
        conn.execute("""
            CREATE TABLE IF NOT EXISTS gop_voucher_type_masters (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                name         VARCHAR(300) NOT NULL,
                parent_type  VARCHAR(50)  NOT NULL,
                abbreviation VARCHAR(30)  DEFAULT NULL,
                description  TEXT         DEFAULT NULL,
                is_active    TINYINT(1)   DEFAULT 1,
                sort_order   INT          DEFAULT 0,
                created_by   VARCHAR(200) DEFAULT NULL,
                created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_vtype_name (name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        # Migration: add material_type_id column
        try:
            conn.execute("ALTER TABLE gop_voucher_type_masters ADD COLUMN material_type_id INT DEFAULT NULL")
            conn.commit()
        except Exception:
            pass

        # Seed default voucher type masters if the table is empty
        existing = conn.execute("SELECT COUNT(*) AS n FROM gop_voucher_type_masters").fetchone()
        if existing and existing["n"] == 0:
            seeds = [
                ("Purchase Order",          "po",           "PO",      "Standard purchase order to suppliers"),
                ("Purchase Receipt",        "grn",          "GRN",     "Goods received against a purchase order"),
                ("RM Store Transfer",       "mtv",          "RM-MTV",  "Raw material transfer between locations"),
                ("FG Transfer",             "mtv",          "FG-MTV",  "Finished goods transfer between locations"),
                ("General Transfer",        "mtv",          "MTV",     "General internal material transfer"),
            ]
            for name, parent, abbr, desc in seeds:
                try:
                    conn.execute(
                        "INSERT IGNORE INTO gop_voucher_type_masters "
                        "(name, parent_type, abbreviation, description, created_by) "
                        "VALUES (%s, %s, %s, %s, 'system')",
                        (name, parent, abbr, desc)
                    )
                except Exception:
                    pass
            conn.commit()

        conn.close()
        print("✅ General OP tables ready")

    except Exception as e:
        print(f"[GeneralOP] ⚠ Table init (non-fatal): {e}")
        traceback.print_exc()


# ─────────────────────────────────────────────────────────────────────────────
# REGISTER
# ─────────────────────────────────────────────────────────────────────────────

def register_general_op(app):
    """Call once from app.py:  general_op.register_general_op(app)"""

    _init_gop_tables()

    # ── Main page ──────────────────────────────────────────────────────────
    @app.route("/general_op")
    @gop_required
    def general_op_main():
        return render_template("general_op.html")

    # ══════════════════════════════════════════════════════════════════════
    # GODOWNS  (proxied — same DB table, new API namespace)
    # ══════════════════════════════════════════════════════════════════════

    @app.route("/api/gop/godowns", methods=["GET"])
    @gop_required
    def gop_godowns_list():
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            rows = conn.execute(
                "SELECT * FROM procurement_godowns ORDER BY is_default DESC, name ASC"
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "godowns": [dict(r) for r in rows]})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/godowns/save", methods=["POST"])
    @gop_required
    def gop_godowns_save():
        d    = request.get_json() or {}
        gid  = d.get("id")
        name = (d.get("name") or "").strip()
        if not name:
            return jsonify({"status": "error", "message": "name required"}), 400
        state = (d.get("state")   or "").strip() or None
        city  = (d.get("city")    or "").strip() or None
        pin   = (d.get("pin")     or "").strip() or None
        gtype = (d.get("type")    or "godown").strip()
        gst   = (d.get("gst_number") or "").strip() or None
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            if d.get("is_default"):
                conn.execute("UPDATE procurement_godowns SET is_default=0")
            if gid:
                conn.execute(
                    "UPDATE procurement_godowns SET name=%s,address=%s,contact=%s,"
                    "phone=%s,email=%s,state=%s,city=%s,pin=%s,is_default=%s,"
                    "type=%s,gst_number=%s WHERE id=%s",
                    (name, d.get("address"), d.get("contact"), d.get("phone"),
                     d.get("email"), state, city, pin,
                     1 if d.get("is_default") else 0, gtype, gst, gid)
                )
            else:
                conn.execute(
                    "INSERT INTO procurement_godowns "
                    "(name,address,contact,phone,email,state,city,pin,is_default,type,gst_number) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (name, d.get("address"), d.get("contact"), d.get("phone"),
                     d.get("email"), state, city, pin,
                     1 if d.get("is_default") else 0, gtype, gst)
                )
                gid = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "id": gid})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/godowns/delete", methods=["POST"])
    @gop_required
    def gop_godowns_delete():
        d   = request.get_json() or {}
        gid = d.get("id")
        if not gid:
            return jsonify({"status": "error", "message": "id required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            conn.execute("DELETE FROM procurement_godowns WHERE id=%s", (gid,))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/godowns/set_default", methods=["POST"])
    @gop_required
    def gop_godowns_set_default():
        d   = request.get_json() or {}
        gid = d.get("id")
        if not gid:
            return jsonify({"status": "error", "message": "id required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            conn.execute("UPDATE procurement_godowns SET is_default=0")
            conn.execute("UPDATE procurement_godowns SET is_default=1 WHERE id=%s", (gid,))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ══════════════════════════════════════════════════════════════════════
    # VOUCHER TYPE MASTERS
    # ══════════════════════════════════════════════════════════════════════

    @app.route("/api/gop/voucher_types", methods=["GET"])
    @gop_required
    def gop_vtype_list():
        """List all voucher type masters, optionally filtered by parent_type."""
        parent = request.args.get("parent_type")
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            if parent:
                rows = conn.execute(
                    "SELECT v.*, mt.type_name AS mat_type_name, mt.abbreviation AS mat_type_abbr, mt.color AS mat_type_color "
                    "FROM gop_voucher_type_masters v "
                    "LEFT JOIN procurement_material_types mt ON v.material_type_id = mt.id "
                    "WHERE v.parent_type=%s ORDER BY v.sort_order, v.name", (parent,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT v.*, mt.type_name AS mat_type_name, mt.abbreviation AS mat_type_abbr, mt.color AS mat_type_color "
                    "FROM gop_voucher_type_masters v "
                    "LEFT JOIN procurement_material_types mt ON v.material_type_id = mt.id "
                    "ORDER BY v.parent_type, v.sort_order, v.name"
                ).fetchall()
            conn.close()
            return jsonify({
                "status": "ok",
                "types":  [dict(r) for r in rows],
                "parents": GOP_PARENT_TYPES
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/voucher_types/save", methods=["POST"])
    @gop_required
    def gop_vtype_save():
        d      = request.get_json() or {}
        tid    = d.get("id")
        name   = (d.get("name") or "").strip()
        parent = (d.get("parent_type") or "").strip()
        abbr          = (d.get("abbreviation") or "").strip() or None
        desc          = (d.get("description") or "").strip() or None
        active        = 1 if d.get("is_active", True) else 0
        order         = int(d.get("sort_order") or 0)
        mat_type_id   = d.get("material_type_id") or None
        if mat_type_id: mat_type_id = int(mat_type_id)
        uid           = session.get("UID", "system")

        if not name:
            return jsonify({"status": "error", "message": "name required"}), 400
        if not parent:
            return jsonify({"status": "error", "message": "parent_type required"}), 400
        valid_parents = [p["key"] for p in GOP_PARENT_TYPES]
        if parent not in valid_parents:
            return jsonify({"status": "error",
                            "message": f"parent_type must be one of: {', '.join(valid_parents)}"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            if tid:
                conn.execute(
                    "UPDATE gop_voucher_type_masters SET name=%s,parent_type=%s,"
                    "abbreviation=%s,description=%s,is_active=%s,sort_order=%s,material_type_id=%s WHERE id=%s",
                    (name, parent, abbr, desc, active, order, mat_type_id, tid)
                )
            else:
                cur = conn.execute(
                    "INSERT INTO gop_voucher_type_masters "
                    "(name,parent_type,abbreviation,description,is_active,sort_order,material_type_id,created_by) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (name, parent, abbr, desc, active, order, mat_type_id, uid)
                )
                tid = cur.lastrowid
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "id": tid})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/voucher_types/delete", methods=["POST"])
    @gop_required
    def gop_vtype_delete():
        d   = request.get_json() or {}
        tid = d.get("id")
        if not tid:
            return jsonify({"status": "error", "message": "id required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            conn.execute("DELETE FROM gop_voucher_type_masters WHERE id=%s", (tid,))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ══════════════════════════════════════════════════════════════════════
    # VOUCHER NUMBERING  (global — same table as procurement, new namespace)
    # ══════════════════════════════════════════════════════════════════════

    @app.route("/api/gop/voucher_numbering/list", methods=["GET"])
    @gop_required
    def gop_vn_list():
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            rows = conn.execute(
                "SELECT * FROM procurement_voucher_numbering "
                "ORDER BY voucher_type, valid_from DESC"
            ).fetchall()
            conn.close()
            styles = [{
                "id":           r["id"],
                "voucher_type": r["voucher_type"],
                "prefix":       r["prefix"] or "",
                "suffix":       r["suffix"] or "",
                "digits":       r["digits"] or 4,
                "start_num":    r["start_num"] or 1,
                "valid_from":   str(r["valid_from"])  if r["valid_from"]  else "",
                "valid_to":     str(r["valid_to"])    if r["valid_to"]    else "",
            } for r in rows]
            return jsonify({"status": "ok", "styles": styles})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/voucher_numbering/save", methods=["POST"])
    @gop_required
    def gop_vn_save():
        d      = request.get_json() or {}
        vtype  = (d.get("voucher_type") or "").strip()
        prefix = (d.get("prefix") or "").strip()
        suffix = (d.get("suffix") or "").strip()
        digits = int(d.get("digits") or 4)
        start  = int(d.get("start_num") or 1)
        vfrom  = (d.get("valid_from") or "").strip()
        vto    = (d.get("valid_to") or "").strip()
        sid    = d.get("id")
        if not vtype:
            return jsonify({"status": "error", "message": "voucher_type required"}), 400
        if not vfrom or not vto:
            return jsonify({"status": "error", "message": "valid_from and valid_to required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            if sid:
                conn.execute(
                    "UPDATE procurement_voucher_numbering SET voucher_type=%s,"
                    "prefix=%s,suffix=%s,digits=%s,start_num=%s,valid_from=%s,valid_to=%s "
                    "WHERE id=%s",
                    (vtype, prefix, suffix, digits, start, vfrom, vto, sid)
                )
            else:
                cur = conn.execute(
                    "INSERT INTO procurement_voucher_numbering "
                    "(voucher_type,prefix,suffix,digits,start_num,valid_from,valid_to) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (vtype, prefix, suffix, digits, start, vfrom, vto)
                )
                sid = cur.lastrowid
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "id": sid})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/voucher_numbering/delete", methods=["POST"])
    @gop_required
    def gop_vn_delete():
        d   = request.get_json() or {}
        sid = d.get("id")
        if not sid:
            return jsonify({"status": "error", "message": "id required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            conn.execute("DELETE FROM procurement_voucher_numbering WHERE id=%s", (sid,))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/gop/voucher_numbering/next", methods=["GET"])
    @gop_required
    def gop_vn_next():
        """Preview next sequence number for a voucher type.

        Honors the active numbering style's `start_num` as a hard floor: the
        returned next number is never below the style's start. Also filters
        existing-PO scans by BOTH prefix AND suffix so vouchers from a
        previous financial year (different suffix, e.g. '26-27' vs '27-27')
        don't pollute the count for the current year's style.
        """
        import re as _re
        vtype  = request.args.get("voucher_type", "")
        prefix = request.args.get("prefix", "")
        suffix = request.args.get("suffix", "")
        digits = int(request.args.get("digits", 4))
        start_num = 1                # populated from active style row below
        if not vtype:
            return jsonify({"status": "error", "message": "voucher_type required"}), 400
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500

            # Resolve the parent type FIRST. The procurement form sends the
            # voucher type's full name (e.g. "Raw Material Purchase Order"),
            # but the numbering table stores rows keyed by parent_type
            # ('po', 'grn', 'mtv'). Without this resolution, the active-style
            # SELECT below would never match.
            parent_table_map = {
                "po":  ("procurement_purchase_orders", "po_num"),
                "grn": ("procurement_grn",             "grn_num"),
                "mtv": ("procurement_mtv",              "mtv_num"),
            }
            pt = vtype
            if vtype not in parent_table_map:
                vtrow = conn.execute(
                    "SELECT parent_type FROM gop_voucher_type_masters WHERE name=%s OR abbreviation=%s LIMIT 1",
                    (vtype, vtype)
                ).fetchone()
                if vtrow and vtrow.get("parent_type"):
                    pt = vtrow["parent_type"]

            # Auto-detect active style if no prefix/suffix passed.
            # IMPORTANT: also read start_num — earlier versions of this route
            # ignored it, which caused the returned `next` to fall back to 1
            # whenever no existing POs matched the prefix. That made manually-
            # set start values (e.g. 431) silently ineffective.
            #
            # The lookup uses BOTH the resolved parent type (e.g. 'po') and
            # the raw passed vtype (e.g. 'Raw Material Purchase Order'). This
            # way it works whether the settings UI stored by parent key or
            # by full name — and is robust across both styles.
            if not prefix and not suffix:
                from datetime import date as _date
                today = _date.today().isoformat()
                vn_row = conn.execute(
                    "SELECT prefix,suffix,digits,start_num FROM procurement_voucher_numbering "
                    "WHERE voucher_type IN (%s,%s) AND valid_from<=%s AND valid_to>=%s "
                    "ORDER BY valid_from DESC, id DESC LIMIT 1",
                    (pt, vtype, today, today)
                ).fetchone()
                if vn_row:
                    prefix    = (vn_row["prefix"] or "").strip()
                    suffix    = (vn_row["suffix"] or "").strip()
                    digits    = int(vn_row["digits"] or 4)
                    try:    start_num = int(vn_row["start_num"] or 1)
                    except Exception: start_num = 1

            # max_seq starts as (start_num - 1) so that the style's start is
            # a hard floor: with no existing POs we get start_num itself; with
            # existing POs we get max(start_num, last_existing) + 1.
            max_seq = max(0, start_num - 1)
            if pt in parent_table_map:
                tbl, col = parent_table_map[pt]
                # Filter scan by BOTH prefix AND suffix when both are set.
                # This isolates vouchers belonging to THIS style only — e.g.
                # a style with suffix '26-27' won't see POs ending in '/27-27'.
                # When suffix is empty, we LIKE only on prefix.
                if prefix and suffix:
                    pattern = prefix + "/%/" + suffix
                elif prefix:
                    pattern = prefix + "/%"
                elif suffix:
                    pattern = "%/" + suffix
                else:
                    pattern = "%"
                existing = conn.execute(
                    f"SELECT {col} AS vnum FROM {tbl} WHERE {col} LIKE %s", (pattern,)
                ).fetchall()
                for row in existing:
                    nums = _re.findall(r"(\d{" + str(digits) + r",})", row["vnum"] or "")
                    if nums:
                        try:
                            max_seq = max(max_seq, int(nums[-1]))
                        except Exception:
                            pass

            conn.close()
            return jsonify({
                "status": "ok", "next": max_seq + 1,
                "prefix": prefix, "suffix": suffix, "digits": digits,
                "start_num": start_num
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ══════════════════════════════════════════════════════════════════════
    # BILLING ADDRESS  (proxy — same procurement_settings table)
    # ══════════════════════════════════════════════════════════════════════

    @app.route("/api/gop/billing", methods=["GET", "POST"])
    @gop_required
    def gop_billing():
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed"}), 500
            if request.method == "POST":
                d = request.get_json() or {}
                for k, v in d.items():
                    if isinstance(v, (dict, list)):
                        continue
                    conn.execute(
                        "INSERT INTO procurement_settings (setting_key, setting_value) "
                        "VALUES (%s,%s) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
                        ("billing_" + k, str(v) if v is not None else None)
                    )
                conn.commit()
                conn.close()
                return jsonify({"status": "ok"})
            else:
                rows = conn.execute(
                    "SELECT setting_key, setting_value FROM procurement_settings "
                    "WHERE setting_key LIKE %s",
                    ("billing_%%",)
                ).fetchall()
                conn.close()
                data = {r["setting_key"].replace("billing_", ""): r["setting_value"] for r in rows}
                return jsonify({"status": "ok", "billing": data})
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ══════════════════════════════════════════════════════════════════════
    # PARENT TYPES  (static list for UI)
    # ══════════════════════════════════════════════════════════════════════

    @app.route("/api/gop/parent_types", methods=["GET"])
    @gop_required
    def gop_parent_types():
        return jsonify({"status": "ok", "parents": GOP_PARENT_TYPES})
