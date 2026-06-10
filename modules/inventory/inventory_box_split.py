r"""
inventory_box_split.py  –  Box Split  (RM)
==========================================
HCP Wellness Pvt Ltd

Ported from pm_stock's box-split workflow, adapted to RM boxes.

Divide one in-stock parent box into N children whose quantities sum exactly
to the parent's per_box_qty. No stock moves — the same quantity stays at the
same godown, just repackaged. The parent is marked 'superseded'; children are
fresh rm_boxes rows inheriting material / grn / grn_item / godown, each with a
new box_code (via inventory_godown.allocate_next_box_code) and parent_box_id
pointing at the parent. A 'split' movement row is logged for audit.

Children inherit the parent's grn_item, so their expiry / FEFO code / batch
are identical — the label code derives the same F-code automatically.

Idempotent migrations (run on register):
  • rm_boxes: add parent_box_id, split_at; extend current_status enum with
    'superseded'.
  • rm_box_movements: extend movement_type enum with 'split'.

Gated by a new 'box_split' access category (admins always allowed).

Register: auto-called from register_inventory_mgmt() (guarded).
API: POST /api/inventory_mgmt/boxes/<box_id>/split
     GET  /api/inventory_mgmt/boxes/by_code?code=RM-XXXX
"""

from __future__ import annotations

from functools import wraps

from flask import session, jsonify, request

import sampling_portal


# ── auth ─────────────────────────────────────────────────────────────────────

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


def _can_split():
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
        return _ia._inv_user_has_access("box_split")
    except Exception:
        return False


def _alloc_box_code(conn):
    try:
        from inventory import inventory_godown as _ig
    except Exception:
        import inventory_godown as _ig
    return _ig.allocate_next_box_code(conn)


# ── migrations ───────────────────────────────────────────────────────────────

def _migrate():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryBoxSplit] ⚠️  DB connection failed — migrate skipped.")
        return
    try:
        # parent_box_id + split_at on rm_boxes
        try:
            conn.execute("ALTER TABLE rm_boxes ADD COLUMN parent_box_id INT DEFAULT NULL")
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE rm_boxes ADD COLUMN split_at DATETIME DEFAULT NULL")
            conn.commit()
        except Exception:
            pass
        # extend current_status enum with 'superseded'
        try:
            conn.execute(
                "ALTER TABLE rm_boxes MODIFY COLUMN current_status "
                "ENUM('in_stock','in_transit','consumed','damaged','lost','cancelled','superseded') "
                "NOT NULL DEFAULT 'in_stock'"
            )
            conn.commit()
        except Exception:
            pass
        # extend movement_type enum with 'split'
        try:
            conn.execute(
                "ALTER TABLE rm_box_movements MODIFY COLUMN movement_type "
                "ENUM('grn_create','opening','out','in','consume','adjust','cancel','split') NOT NULL"
            )
            conn.commit()
        except Exception:
            pass
        print("✅ [InventoryBoxSplit] migrations ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── routes ───────────────────────────────────────────────────────────────────

def register_inventory_box_split(app):
    if getattr(app, "_inventory_boxsplit_registered", False):
        return
    app._inventory_boxsplit_registered = True
    _migrate()

    # ── Lookup a box by code (for the modal preview) ──────────────────────
    @app.route("/api/inventory_mgmt/boxes/by_code", methods=["GET"])
    @_login_required
    def api_inv_box_by_code():
        code = (request.args.get("code") or "").strip().upper()
        if not code:
            return jsonify({"status": "error", "message": "code required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            # Newly-printed labels encode the 8-char short_code in their QR;
            # older labels (and the printed RM-… text used for manual entry)
            # use box_code. Match BOTH so every label scans. The short_code
            # column may not exist on older installs, so probe before using it.
            _has_sc = False
            try:
                _has_sc = any(
                    (c["Field"] if hasattr(c, "get") else c[0]) == "short_code"
                    for c in conn.execute("SHOW COLUMNS FROM rm_boxes").fetchall()
                )
            except Exception:
                _has_sc = False
            _where = "b.short_code = %s OR b.box_code = %s" if _has_sc else "b.box_code = %s"
            _params = (code, code) if _has_sc else (code,)
            b = conn.execute(
                """SELECT b.box_id, b.box_code, b.material_id, b.grn_id, b.grn_no,
                          b.grn_item_id, b.per_box_qty, b.uom, b.current_status,
                          b.current_godown_id,
                          COALESCE(m.material_name,'') AS material_name,
                          COALESCE(g.name,'')          AS godown_name,
                          gi.expiry_date, gi.batch_num
                   FROM rm_boxes b
                   LEFT JOIN procurement_materials m ON m.id = b.material_id
                   LEFT JOIN procurement_godowns g   ON g.id = b.current_godown_id
                   LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
                   WHERE """ + _where + " LIMIT 1",
                _params,
            ).fetchone()
            if not b:
                conn.close()
                return jsonify({"status": "error", "message": f"Box {code} not found"}), 404
            d = dict(b)
            for k in ("expiry_date",):
                if d.get(k) is not None:
                    d[k] = str(d[k])
            d["per_box_qty"] = float(d.get("per_box_qty") or 0)
            conn.close()
            return jsonify({"status": "ok", "box": d, "can_split": _can_split()})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Split ─────────────────────────────────────────────────────────────
    @app.route("/api/inventory_mgmt/boxes/<int:box_id>/split", methods=["POST"])
    @_login_required
    def api_inv_box_split(box_id):
        if not _can_split():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        splits = d.get("splits") or []
        reason = (d.get("reason") or "").strip()

        if not isinstance(splits, list) or len(splits) < 2:
            return jsonify({"status": "error", "message": "At least 2 child splits are required"}), 400
        if len(splits) > 50:
            return jsonify({"status": "error", "message": "Maximum 50 children per split"}), 400
        try:
            child_qtys = []
            for i, s in enumerate(splits):
                q = float(s.get("qty") or 0)
                if q <= 0:
                    return jsonify({"status": "error", "message": f"Child #{i+1}: qty must be > 0"}), 400
                child_qtys.append(round(q, 3))
        except Exception as e:
            return jsonify({"status": "error", "message": f"Invalid split qty: {e}"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            parent = conn.execute(
                """SELECT b.*, COALESCE(m.material_name,'') AS material_name,
                          COALESCE(g.name,'') AS godown_name
                   FROM rm_boxes b
                   LEFT JOIN procurement_materials m ON m.id = b.material_id
                   LEFT JOIN procurement_godowns g   ON g.id = b.current_godown_id
                   WHERE b.box_id = %s FOR UPDATE""",
                (box_id,),
            ).fetchone()
            if not parent:
                conn.close()
                return jsonify({"status": "error", "message": "Box not found"}), 404
            p = dict(parent)
            if p["current_status"] != "in_stock":
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Cannot split — box is '{p['current_status']}'. "
                                           f"Only in_stock boxes can be split."}), 400

            parent_qty = round(float(p["per_box_qty"] or 0), 3)
            total_split = round(sum(child_qtys), 3)
            if abs(total_split - parent_qty) > 0.001:
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Splits must total parent qty ({parent_qty:g}). "
                                           f"You entered {total_split:g}."}), 400

            children = []
            for q in child_qtys:
                child_code = _alloc_box_code(conn)
                cur = conn.execute(
                    """INSERT INTO rm_boxes
                         (box_code, parent_box_id, grn_id, grn_no, grn_item_id,
                          material_id, material_code, box_seq, per_box_qty, uom,
                          current_godown_id, current_status, source, created_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in_stock',%s,%s)""",
                    (child_code, p["box_id"], p.get("grn_id"), p.get("grn_no"),
                     p.get("grn_item_id"), p["material_id"], p.get("material_code"),
                     p.get("box_seq") or 0, q, p.get("uom"),
                     p.get("current_godown_id"), (p.get("source") or "grn"), _user()),
                )
                try:
                    child_id = cur.lastrowid
                except Exception:
                    child_id = None
                if not child_id:
                    row = conn.execute(
                        "SELECT box_id FROM rm_boxes WHERE box_code=%s", (child_code,)
                    ).fetchone()
                    child_id = (row["box_id"] if hasattr(row, "get") else row[0]) if row else None
                children.append({"box_id": child_id, "box_code": child_code, "qty": q})

            # Supersede parent
            conn.execute(
                "UPDATE rm_boxes SET current_status='superseded', split_at=NOW() WHERE box_id=%s",
                (p["box_id"],),
            )

            # Audit movement
            child_codes_str = ", ".join(c["box_code"] for c in children)
            try:
                conn.execute(
                    """INSERT INTO rm_box_movements
                         (box_id, movement_type, from_godown_id, to_godown_id,
                          qty, moved_by, remarks)
                       VALUES (%s,'split',%s,%s,%s,%s,%s)""",
                    (p["box_id"], p.get("current_godown_id"), p.get("current_godown_id"),
                     parent_qty, _user(),
                     f"Split into {len(children)} children: {child_codes_str}"
                     + (f" — Reason: {reason}" if reason else "")),
                )
            except Exception:
                pass

            conn.commit()
            conn.close()
            return jsonify({
                "status": "ok",
                "children": children,
                "parent": {
                    "box_code": p["box_code"],
                    "material_name": p.get("material_name"),
                    "godown_name": p.get("godown_name"),
                    "uom": p.get("uom"),
                },
            })
        except Exception as e:
            try:
                conn.rollback(); conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryBoxSplit] routes registered (/api/inventory_mgmt/boxes/*/split)")
