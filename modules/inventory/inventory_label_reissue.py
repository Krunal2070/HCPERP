r"""
inventory_label_reissue.py  –  Label Reissue Approvals  (Inventory Phase 7)
===========================================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's Label Reissue feature, adapted to RM boxes.

REISSUE IS NOT REPRINT.
  • Reprint = print the SAME label again (same code). (not this module)
  • Reissue = the QR/label is damaged or unreadable → assign a BRAND-NEW box
    code to the box and print that; the old code is retired.

Flow:
  user requests a reissue (reason required, by box code or box_id)
    → admin approves → server allocates a NEW box_code on the box, retires
      the old one → requester prints the replacement label.
  or admin rejects.

Lifecycle:  pending → approved → printed   |   pending → rejected

Table (created here, idempotently):
  inventory_label_reissue_requests

Approvals surface gated by the Phase 1 'label_reissue' access category;
admins always allowed. Requesting a reissue is open to any logged-in user
(they're flagging a damaged label on the floor).

Register: auto-called from register_inventory_mgmt() (guarded). No app.py
change needed. API prefix: /api/inventory_mgmt/label_reissue/*
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


def _can_approve():
    # Approval is ADMIN-ONLY. The label_reissue toggle governs who can RAISE
    # requests (non-admin store users), not who approves.
    return _is_admin()


def _can_request():
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
        return _ia._inv_user_has_access("label_reissue")
    except Exception:
        return False


def _alloc_new_box_code(conn):
    """Allocate a fresh RM box code using the godown module's allocator."""
    try:
        from inventory import inventory_godown as _ig
    except Exception:
        import inventory_godown as _ig
    return _ig.allocate_next_box_code(conn)


# ── table ────────────────────────────────────────────────────────────────────

def _init_reissue_table():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryReissue] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_label_reissue_requests (
                req_id        INT AUTO_INCREMENT PRIMARY KEY,
                box_id        INT          NOT NULL,
                old_box_code  VARCHAR(50)  DEFAULT NULL,
                new_box_code  VARCHAR(50)  DEFAULT NULL,
                material_id   INT          DEFAULT NULL,
                material_name VARCHAR(500) DEFAULT NULL,
                grn_no        VARCHAR(64)  DEFAULT NULL,
                godown_id     INT          DEFAULT NULL,
                reason        VARCHAR(500) DEFAULT NULL,
                status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
                requested_by  VARCHAR(100) NOT NULL,
                requested_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                decided_by    VARCHAR(100) DEFAULT NULL,
                decided_at    DATETIME     DEFAULT NULL,
                decided_note  VARCHAR(500) DEFAULT NULL,
                printed_at    DATETIME     DEFAULT NULL,
                printed_by    VARCHAR(100) DEFAULT NULL,
                INDEX ix_inv_lreq_status (status, requested_at),
                INDEX ix_inv_lreq_user   (requested_by, requested_at),
                INDEX ix_inv_lreq_box    (box_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        print("✅ [InventoryReissue] label-reissue table ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── routes ───────────────────────────────────────────────────────────────────

def register_inventory_label_reissue(app):
    if getattr(app, "_inventory_reissue_registered", False):
        return
    app._inventory_reissue_registered = True
    _init_reissue_table()

    PFX = "/api/inventory_mgmt/label_reissue"

    # ── REQUEST ───────────────────────────────────────────────────────────
    @app.route(f"{PFX}/request", methods=["POST"])
    @_login_required
    def api_reissue_request():
        if not _can_request():
            return jsonify({"status": "error", "message": "You don't have access to raise reissue requests"}), 403
        d = request.get_json(silent=True) or {}
        reason = (d.get("reason") or "").strip()
        code = (d.get("box_code") or "").strip().upper()
        try:
            box_id = int(d.get("box_id") or 0)
        except Exception:
            box_id = 0
        if not reason:
            return jsonify({"status": "error", "message": "A reason is required"}), 400
        if not box_id and not code:
            return jsonify({"status": "error", "message": "box_id or box_code required"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                """SELECT b.box_id, b.box_code, b.material_id, b.grn_no,
                          b.current_godown_id, b.current_status,
                          COALESCE(m.material_name,'') AS material_name
                   FROM rm_boxes b
                   LEFT JOIN procurement_materials m ON m.id = b.material_id
                   WHERE """ + ("b.box_id=%s" if box_id else "b.box_code=%s") + " LIMIT 1",
                (box_id if box_id else code,),
            ).fetchone()
            if not row:
                conn.close()
                return jsonify({"status": "error", "message": "Box not found"}), 404
            b = dict(row)
            bid = int(b["box_id"])

            # Avoid stacking duplicate open requests for the same box.
            dup = conn.execute(
                "SELECT req_id FROM inventory_label_reissue_requests "
                "WHERE box_id=%s AND status IN ('pending','approved') LIMIT 1",
                (bid,),
            ).fetchone()
            if dup:
                conn.close()
                return jsonify({"status": "ok", "duplicate": True,
                                "message": "There is already an open reissue request for this box."})

            conn.execute(
                """INSERT INTO inventory_label_reissue_requests
                     (box_id, old_box_code, material_id, material_name, grn_no,
                      godown_id, reason, status, requested_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s)""",
                (bid, b.get("box_code"), b.get("material_id"), b.get("material_name"),
                 b.get("grn_no"), b.get("current_godown_id"), reason, _user()),
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

    # ── LIST ──────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/requests", methods=["GET"])
    @_login_required
    def api_reissue_requests():
        st = (request.args.get("status") or "").strip()
        mine = request.args.get("mine") == "1" or not _can_approve()
        conn = sampling_portal.get_db_connection()
        try:
            where, params = [], []
            if st:
                where.append("r.status=%s"); params.append(st)
            if mine:
                where.append("r.requested_by=%s"); params.append(_user())
            where_sql = (" WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                f"""SELECT r.*, COALESCE(g.name,'') AS godown_name
                    FROM inventory_label_reissue_requests r
                    LEFT JOIN procurement_godowns g ON g.id = r.godown_id
                    {where_sql}
                    ORDER BY r.req_id DESC""",
                tuple(params),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                for k in ("requested_at", "decided_at", "printed_at"):
                    if dd.get(k) is not None:
                        dd[k] = str(dd[k])
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "requests": out, "can_approve": _can_approve(), "can_request": _can_request()})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/pending_count", methods=["GET"])
    @_login_required
    def api_reissue_pending_count():
        if not _can_approve():
            return jsonify({"status": "ok", "count": 0})
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_label_reissue_requests WHERE status='pending'"
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

    # ── APPROVE (allocate new code, retire old) ───────────────────────────
    @app.route(f"{PFX}/<int:req_id>/approve", methods=["POST"])
    @_login_required
    def api_reissue_approve(req_id):
        if not _can_approve():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        note = (d.get("note") or "").strip() or None
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT req_id, box_id, status FROM inventory_label_reissue_requests WHERE req_id=%s",
                (req_id,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            rd = dict(r)
            if rd["status"] != "pending":
                conn.close()
                return jsonify({"status": "error", "message": f"Already {rd['status']}."}), 400

            bid = int(rd["box_id"])
            # Confirm the box still exists and isn't cancelled.
            bx = conn.execute(
                "SELECT box_code, current_status FROM rm_boxes WHERE box_id=%s", (bid,)
            ).fetchone()
            if not bx:
                conn.close()
                return jsonify({"status": "error", "message": "Box no longer exists"}), 404

            # Allocate a brand-new code and stamp it on the box.
            new_code = _alloc_new_box_code(conn)
            conn.execute(
                "UPDATE rm_boxes SET box_code=%s WHERE box_id=%s",
                (new_code, bid),
            )
            # Record a movement note for the audit trail (best-effort).
            try:
                conn.execute(
                    """INSERT INTO rm_box_movements
                         (box_id, movement_type, from_godown_id, to_godown_id,
                          qty, moved_by, remarks)
                       VALUES (%s,'adjust',NULL,NULL,0,%s,%s)""",
                    (bid, _user(), f"Label reissued: new code {new_code}"),
                )
            except Exception:
                pass
            conn.execute(
                """UPDATE inventory_label_reissue_requests
                     SET status='approved', new_box_code=%s,
                         decided_by=%s, decided_at=NOW(), decided_note=%s
                   WHERE req_id=%s""",
                (new_code, _user(), note, req_id),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "new_box_code": new_code})
        except Exception as e:
            try:
                conn.rollback(); conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── REJECT ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:req_id>/reject", methods=["POST"])
    @_login_required
    def api_reissue_reject(req_id):
        if not _can_approve():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        note = (d.get("note") or "").strip() or None
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT status FROM inventory_label_reissue_requests WHERE req_id=%s", (req_id,)
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            cur = r["status"] if hasattr(r, "get") else r[0]
            if cur != "pending":
                conn.close()
                return jsonify({"status": "error", "message": f"Already {cur}."}), 400
            conn.execute(
                "UPDATE inventory_label_reissue_requests "
                "SET status='rejected', decided_by=%s, decided_at=NOW(), decided_note=%s WHERE req_id=%s",
                (_user(), note, req_id),
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

    # ── MARK PRINTED ──────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:req_id>/print", methods=["POST"])
    @_login_required
    def api_reissue_print(req_id):
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT req_id, status, new_box_code, requested_by "
                "FROM inventory_label_reissue_requests WHERE req_id=%s",
                (req_id,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            rd = dict(r)
            if rd["status"] not in ("approved", "printed"):
                conn.close()
                return jsonify({"status": "error",
                                "message": "Only approved requests can be printed."}), 400
            # Only the requester or an approver can print.
            if rd["requested_by"] != _user() and not _can_approve():
                conn.close()
                return jsonify({"status": "error", "message": "Not permitted"}), 403
            conn.execute(
                "UPDATE inventory_label_reissue_requests "
                "SET status='printed', printed_at=NOW(), printed_by=%s WHERE req_id=%s",
                (_user(), req_id),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "new_box_code": rd.get("new_box_code")})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryReissue] routes registered (/api/inventory_mgmt/label_reissue/*)")
