r"""
inventory_delivery_note.py  -  Delivery Note (DN)  (RM)
=======================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's DN workflow, adapted to RM boxes.

A Delivery Note records material going OUT from HCP to a supplier (returns /
rejections / dispatch). Scanning a box marks it 'consumed' (stock leaves the
godown). Editing/deleting a DN restores the scanned boxes back to in_stock at
their prior godown.

Tables (auto-created):
  inventory_dn            - header (dn_no, dn_date, supplier, godown, reference,
                            reason, remarks, supervisor, status, created_by)
  inventory_dn_items      - one row per material line (qty_delivered, no_of_box)
  inventory_dn_box_scans  - junction: which boxes were consumed on this DN,
                            with prior_godown_id snapshot for restore

Stock model: a DN box scan flips rm_boxes.current_status in_stock -> consumed
and logs an 'out' movement. Unscan / DN delete reverses it.

Gated by a new 'delivery_note' access category (admins always allowed).
Register: auto-called from register_inventory_mgmt() (guarded).

API (all under /api/inventory_mgmt/dn):
  GET  /list                 - list DNs (date / supplier / godown filters)
  GET  /<dn_id>              - DN detail with items + scanned boxes
  POST /box/check            - validate a box can be scanned for this DN
  POST /save                 - create a DN (+ consume scanned boxes)
  POST /delete               - delete a DN (restore its boxes)
"""

from __future__ import annotations

from functools import wraps
from datetime import datetime

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


def _can_dn():
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
        return _ia._inv_user_has_access("delivery_note")
    except Exception:
        return False


# ── tables ───────────────────────────────────────────────────────────────────

def _init_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryDN] DB connection failed - init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_dn (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                dn_no         VARCHAR(40)  NOT NULL UNIQUE,
                dn_date       DATE         NOT NULL,
                supplier_id   INT          DEFAULT NULL,
                supplier_name VARCHAR(200) DEFAULT NULL,
                godown_id     INT          DEFAULT NULL,
                reference_no  VARCHAR(80)  DEFAULT NULL,
                reference_date DATE        DEFAULT NULL,
                reason        VARCHAR(200) DEFAULT NULL,
                remarks       TEXT         DEFAULT NULL,
                supervisor    VARCHAR(120) DEFAULT NULL,
                status        ENUM('issued','cancelled') NOT NULL DEFAULT 'issued',
                created_by    VARCHAR(120) DEFAULT NULL,
                created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_dn_date (dn_date),
                INDEX ix_inv_dn_sup (supplier_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_dn_items (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                dn_id         INT NOT NULL,
                material_id   INT NOT NULL,
                qty_delivered DECIMAL(14,3) NOT NULL DEFAULT 0,
                no_of_box     INT DEFAULT 0,
                remarks       VARCHAR(200) DEFAULT NULL,
                INDEX ix_inv_dni_dn (dn_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_dn_box_scans (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                dn_id           INT NOT NULL,
                dn_item_id      INT DEFAULT NULL,
                box_id          INT NOT NULL,
                box_code        VARCHAR(50) DEFAULT NULL,
                material_id     INT DEFAULT NULL,
                per_box_qty     DECIMAL(14,3) DEFAULT 0,
                prior_godown_id INT DEFAULT NULL,
                created_by      VARCHAR(120) DEFAULT NULL,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_dnbs_dn (dn_id),
                INDEX ix_inv_dnbs_box (box_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        print("[InventoryDN] tables ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _next_dn_no(conn) -> str:
    """
    Allocate the next Delivery Note number.

    Order of preference:
      1. inventory_voucher_numbering.next_voucher_no(conn, 'inv_dn')
      2. Legacy DN-YYYYMM-NNNN (monthly running sequence)
    """
    # Step 1: admin-configured style
    try:
        try:
            from inventory import inventory_voucher_numbering as _ivn
        except Exception:
            import inventory_voucher_numbering as _ivn
        no = _ivn.next_voucher_no(conn, 'inv_dn')
        if no:
            return no
    except Exception:
        pass

    # Step 2: legacy DN-YYYYMM-NNNN
    ym = datetime.now().strftime("%Y%m")
    prefix = f"DN-{ym}-"
    row = conn.execute(
        "SELECT dn_no FROM inventory_dn WHERE dn_no LIKE %s ORDER BY id DESC LIMIT 1",
        (prefix + "%",),
    ).fetchone()
    if row:
        last = (row["dn_no"] if hasattr(row, "get") else row[0]) or ""
        try:
            n = int(last.split("-")[-1]) + 1
        except Exception:
            n = 1
    else:
        n = 1
    return f"{prefix}{n:04d}"


# ── box scan validation + consume / restore ─────────────────────────────────

def _validate_box_for_scan(conn, code, from_godown_id):
    code = (code or "").strip().upper()
    b = conn.execute(
        """SELECT box_id, box_code, material_id, per_box_qty, uom,
                  current_godown_id, current_status
           FROM rm_boxes WHERE box_code=%s LIMIT 1""",
        (code,),
    ).fetchone()
    if not b:
        return None, f"Box {code} not found"
    b = dict(b)
    if b["current_status"] != "in_stock":
        return None, f"Box {code} is '{b['current_status']}' - only in_stock boxes can be delivered"
    if from_godown_id and b["current_godown_id"] and int(b["current_godown_id"]) != int(from_godown_id):
        return None, f"Box {code} is not in the selected godown"
    return b, None


def _consume_box(conn, dn_id, dn_no, dn_item_id, box, supplier):
    prior = int(box["current_godown_id"] or 0) or None
    conn.execute(
        "UPDATE rm_boxes SET current_status='consumed' "
        "WHERE box_id=%s AND current_status='in_stock'",
        (box["box_id"],),
    )
    try:
        conn.execute(
            """INSERT INTO rm_box_movements
                 (box_id, movement_type, from_godown_id, to_godown_id,
                  qty, moved_by, remarks)
               VALUES (%s,'out',%s,NULL,%s,%s,%s)""",
            (box["box_id"], prior, float(box["per_box_qty"] or 0), _user(),
             f"[DN {dn_no}] To: {supplier} - box {box['box_code']}"),
        )
    except Exception:
        pass
    conn.execute(
        """INSERT INTO inventory_dn_box_scans
             (dn_id, dn_item_id, box_id, box_code, material_id, per_box_qty,
              prior_godown_id, created_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
        (dn_id, dn_item_id, box["box_id"], box["box_code"], box["material_id"],
         float(box["per_box_qty"] or 0), prior, _user()),
    )


def _restore_box(conn, dn_id, scan):
    prior = scan.get("prior_godown_id")
    if prior:
        conn.execute(
            "UPDATE rm_boxes SET current_status='in_stock', current_godown_id=%s "
            "WHERE box_id=%s AND current_status='consumed'",
            (int(prior), int(scan["box_id"])),
        )
    else:
        conn.execute(
            "UPDATE rm_boxes SET current_status='in_stock' "
            "WHERE box_id=%s AND current_status='consumed'",
            (int(scan["box_id"]),),
        )
    try:
        conn.execute(
            """INSERT INTO rm_box_movements
                 (box_id, movement_type, from_godown_id, to_godown_id,
                  qty, moved_by, remarks)
               VALUES (%s,'cancel',NULL,%s,%s,%s,%s)""",
            (int(scan["box_id"]), prior, float(scan.get("per_box_qty") or 0),
             _user(), f"DN scan reversed (dn_id={dn_id}, box {scan.get('box_code')})"),
        )
    except Exception:
        pass
    conn.execute(
        "DELETE FROM inventory_dn_box_scans WHERE dn_id=%s AND box_id=%s",
        (dn_id, int(scan["box_id"])),
    )


# ── routes ───────────────────────────────────────────────────────────────────

def register_inventory_delivery_note(app):
    if getattr(app, "_inventory_dn_registered", False):
        return
    app._inventory_dn_registered = True
    _init_tables()

    @app.route("/api/inventory_mgmt/dn/list", methods=["GET"])
    @_login_required
    def api_inv_dn_list():
        conn = sampling_portal.get_db_connection()
        try:
            where, params = [], []
            if request.args.get("from"):
                where.append("d.dn_date >= %s"); params.append(request.args["from"])
            if request.args.get("to"):
                where.append("d.dn_date <= %s"); params.append(request.args["to"])
            if request.args.get("supplier_id"):
                where.append("d.supplier_id = %s"); params.append(int(request.args["supplier_id"]))
            if request.args.get("godown_id"):
                where.append("d.godown_id = %s"); params.append(int(request.args["godown_id"]))
            wsql = ("WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                f"""SELECT d.*, COALESCE(g.name,'') AS godown_name,
                           (SELECT COUNT(*) FROM inventory_dn_items i WHERE i.dn_id=d.id) AS line_count,
                           (SELECT COUNT(*) FROM inventory_dn_box_scans s WHERE s.dn_id=d.id) AS box_count
                    FROM inventory_dn d
                    LEFT JOIN procurement_godowns g ON g.id=d.godown_id
                    {wsql}
                    ORDER BY d.id DESC LIMIT 500""",
                tuple(params),
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                for k in ("dn_date", "reference_date", "created_at"):
                    if d.get(k) is not None:
                        d[k] = str(d[k])
                out.append(d)
            conn.close()
            return jsonify({"status": "ok", "rows": out})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/dn/<int:dn_id>", methods=["GET"])
    @_login_required
    def api_inv_dn_detail(dn_id):
        conn = sampling_portal.get_db_connection()
        try:
            head = conn.execute(
                """SELECT d.*, COALESCE(g.name,'') AS godown_name
                   FROM inventory_dn d LEFT JOIN procurement_godowns g ON g.id=d.godown_id
                   WHERE d.id=%s""", (dn_id,)
            ).fetchone()
            if not head:
                conn.close()
                return jsonify({"status": "error", "message": "DN not found"}), 404
            h = dict(head)
            for k in ("dn_date", "reference_date", "created_at"):
                if h.get(k) is not None:
                    h[k] = str(h[k])
            items = [dict(r) for r in conn.execute(
                """SELECT i.*, COALESCE(m.material_name,'') AS material_name
                   FROM inventory_dn_items i
                   LEFT JOIN procurement_materials m ON m.id=i.material_id
                   WHERE i.dn_id=%s ORDER BY i.id""", (dn_id,)
            ).fetchall()]
            for it in items:
                it["qty_delivered"] = float(it.get("qty_delivered") or 0)
                it["boxes"] = [dict(b) for b in conn.execute(
                    "SELECT box_id, box_code, per_box_qty FROM inventory_dn_box_scans "
                    "WHERE dn_id=%s AND dn_item_id=%s", (dn_id, it["id"])
                ).fetchall()]
                for b in it["boxes"]:
                    b["per_box_qty"] = float(b.get("per_box_qty") or 0)
            conn.close()
            return jsonify({"status": "ok", "dn": h, "items": items})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/dn/box/check", methods=["POST"])
    @_login_required
    def api_inv_dn_box_check():
        d = request.get_json(silent=True) or {}
        conn = sampling_portal.get_db_connection()
        try:
            box, err = _validate_box_for_scan(conn, d.get("code"), d.get("godown_id"))
            conn.close()
            if err:
                return jsonify({"status": "error", "message": err}), 400
            box["per_box_qty"] = float(box.get("per_box_qty") or 0)
            return jsonify({"status": "ok", "box": box})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/dn/save", methods=["POST"])
    @_login_required
    def api_inv_dn_save():
        if not _can_dn():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        items = d.get("items") or []
        if not items:
            return jsonify({"status": "error", "message": "Add at least one item"}), 400
        godown_id = d.get("godown_id") or None
        supplier = (d.get("supplier_name") or "").strip()
        conn = sampling_portal.get_db_connection()
        try:
            dn_no = _next_dn_no(conn)
            cur = conn.execute(
                """INSERT INTO inventory_dn
                     (dn_no, dn_date, supplier_id, supplier_name, godown_id,
                      reference_no, reference_date, reason, remarks, supervisor,
                      status, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'issued',%s)""",
                (dn_no, d.get("dn_date") or datetime.now().strftime("%Y-%m-%d"),
                 d.get("supplier_id") or None, supplier, godown_id,
                 d.get("reference_no") or None, d.get("reference_date") or None,
                 d.get("reason") or None, d.get("remarks") or None,
                 d.get("supervisor") or _user(), _user()),
            )
            dn_id = cur.lastrowid
            if not dn_id:
                r = conn.execute("SELECT id FROM inventory_dn WHERE dn_no=%s", (dn_no,)).fetchone()
                dn_id = (r["id"] if hasattr(r, "get") else r[0]) if r else None

            consumed = 0
            for it in items:
                mat_id = it.get("material_id")
                if not mat_id:
                    continue
                boxes = it.get("boxes") or []
                qty = float(it.get("qty_delivered") or 0)
                if not qty and boxes:
                    qty = sum(float(b.get("per_box_qty") or 0) for b in boxes)
                icur = conn.execute(
                    """INSERT INTO inventory_dn_items
                         (dn_id, material_id, qty_delivered, no_of_box, remarks)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (dn_id, int(mat_id), qty, len(boxes), it.get("remarks") or None),
                )
                dn_item_id = icur.lastrowid
                # Consume each scanned box
                for b in boxes:
                    code = (b.get("box_code") or "").strip().upper()
                    box, err = _validate_box_for_scan(conn, code, godown_id)
                    if err or not box:
                        conn.rollback(); conn.close()
                        return jsonify({"status": "error",
                                        "message": f"{code}: {err or 'invalid'}"}), 400
                    _consume_box(conn, dn_id, dn_no, dn_item_id, box, supplier)
                    consumed += 1

            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "dn_id": dn_id, "dn_no": dn_no,
                            "boxes_consumed": consumed})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/dn/delete", methods=["POST"])
    @_login_required
    def api_inv_dn_delete():
        if not _can_dn():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        dn_id = d.get("dn_id")
        if not dn_id:
            return jsonify({"status": "error", "message": "dn_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            scans = [dict(s) for s in conn.execute(
                "SELECT * FROM inventory_dn_box_scans WHERE dn_id=%s", (int(dn_id),)
            ).fetchall()]
            for s in scans:
                _restore_box(conn, int(dn_id), s)
            conn.execute("DELETE FROM inventory_dn_items WHERE dn_id=%s", (int(dn_id),))
            conn.execute("UPDATE inventory_dn SET status='cancelled' WHERE id=%s", (int(dn_id),))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "restored": len(scans)})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("[InventoryDN] routes registered (/api/inventory_mgmt/dn/*)")
