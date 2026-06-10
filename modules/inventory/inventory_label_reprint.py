r"""
inventory_label_reprint.py  –  Label Reprint Approvals  (Inventory Phase 7)
===========================================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's Label Reprint feature, adapted to RM boxes.

REPRINT IS NOT REISSUE.
  • Reissue = QR damaged → assign a BRAND-NEW code. (inventory_label_reissue.py)
  • Reprint = label lost / torn but the code is valid → print the SAME label
    again. No new code. Approval required so people can't freely create
    duplicate physical QR codes for the same box (stock-integrity risk).

Scope per request (BOTH supported):
  • boxes — a chosen set of box codes (single or many).
  • grn   — every in-stock box of a GRN (whole-voucher reprint).

Flow:  user requests (reason) → approver approves → per-box print-tracking
rows are created → requester prints each (or all) replacement labels.

Lifecycle:  pending → approved → (boxes printed) → printed (all done)
            pending → rejected

Tables (created here, idempotently):
  inventory_label_reprint_requests       (header)
  inventory_label_reprint_box_status     (one row per box, tracks printed)

Approvals gated by the Phase 1 'label_reprint' access category; admins always
allowed. Requesting is open to any logged-in user.

Register: auto-called from register_inventory_mgmt() (guarded). No app.py
change needed. API prefix: /api/inventory_mgmt/label_reprint/*
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
    # Approval is ADMIN-ONLY. The label_reprint access toggle governs who can
    # RAISE requests (non-admin store users), not who can approve them.
    return _is_admin()


def _can_request():
    # Any logged-in user with the label_reprint access toggle (admins always).
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
        return _ia._inv_user_has_access("label_reprint")
    except Exception:
        return False


# ── tables ───────────────────────────────────────────────────────────────────

def _init_reprint_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryReprint] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_label_reprint_requests (
                req_id        INT AUTO_INCREMENT PRIMARY KEY,
                scope_type    VARCHAR(20)  NOT NULL DEFAULT 'boxes',  -- boxes | grn
                grn_id        INT          DEFAULT NULL,
                grn_no        VARCHAR(64)  DEFAULT NULL,
                box_codes_csv MEDIUMTEXT   DEFAULT NULL,
                box_count     INT          NOT NULL DEFAULT 0,
                reason        VARCHAR(500) DEFAULT NULL,
                status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
                requested_by  VARCHAR(100) NOT NULL,
                requested_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                decided_by    VARCHAR(100) DEFAULT NULL,
                decided_at    DATETIME     DEFAULT NULL,
                decided_note  VARCHAR(500) DEFAULT NULL,
                INDEX ix_inv_rpr_status (status, requested_at),
                INDEX ix_inv_rpr_user   (requested_by, requested_at),
                INDEX ix_inv_rpr_grn    (grn_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_label_reprint_box_status (
                req_id     INT          NOT NULL,
                box_code   VARCHAR(50)  NOT NULL,
                printed    TINYINT(1)   NOT NULL DEFAULT 0,
                printed_at DATETIME     DEFAULT NULL,
                printed_by VARCHAR(100) DEFAULT NULL,
                PRIMARY KEY (req_id, box_code),
                INDEX ix_inv_rprb_req (req_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        print("✅ [InventoryReprint] label-reprint tables ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── routes ───────────────────────────────────────────────────────────────────

def register_inventory_label_reprint(app):
    if getattr(app, "_inventory_reprint_registered", False):
        return
    app._inventory_reprint_registered = True
    _init_reprint_tables()

    PFX = "/api/inventory_mgmt/label_reprint"

    def _resolve_grn_boxes(conn, grn_id):
        """Box codes for every in-stock box of a GRN."""
        rows = conn.execute(
            "SELECT box_code FROM rm_boxes WHERE grn_id=%s AND current_status='in_stock' "
            "ORDER BY box_id",
            (int(grn_id),),
        ).fetchall()
        return [(r["box_code"] if hasattr(r, "get") else r[0]) for r in rows]

    # ── REQUEST (scope = boxes | grn) ─────────────────────────────────────
    @app.route(f"{PFX}/request", methods=["POST"])
    @_login_required
    def api_reprint_request():
        if not _can_request():
            return jsonify({"status": "error", "message": "You don't have access to raise reprint requests"}), 403
        d = request.get_json(silent=True) or {}
        reason = (d.get("reason") or "").strip()
        scope = (d.get("scope_type") or "boxes").strip().lower()
        if not reason:
            return jsonify({"status": "error", "message": "A reason is required"}), 400
        if scope not in ("boxes", "grn"):
            return jsonify({"status": "error", "message": "scope_type must be boxes/grn"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            grn_id = None
            grn_no = None
            codes = []
            if scope == "grn":
                try:
                    grn_id = int(d.get("grn_id") or 0) or None
                except Exception:
                    grn_id = None
                if not grn_id:
                    conn.close()
                    return jsonify({"status": "error", "message": "grn_id required for GRN reprint"}), 400
                gr = conn.execute("SELECT grn_no FROM procurement_grn WHERE id=%s", (grn_id,)).fetchone()
                grn_no = (gr["grn_no"] if hasattr(gr, "get") else gr[0]) if gr else None
                codes = _resolve_grn_boxes(conn, grn_id)
                if not codes:
                    conn.close()
                    return jsonify({"status": "error", "message": "No in-stock boxes found for this GRN"}), 400
                # Reject duplicate pending GRN reprint from same user.
                dup = conn.execute(
                    "SELECT req_id FROM inventory_label_reprint_requests "
                    "WHERE status='pending' AND requested_by=%s AND scope_type='grn' AND grn_id=%s LIMIT 1",
                    (_user(), grn_id),
                ).fetchone()
                if dup:
                    conn.close()
                    return jsonify({"status": "ok", "duplicate": True,
                                    "message": "You already have a pending reprint request for this GRN."})
            else:  # boxes
                raw = d.get("box_codes") or []
                if isinstance(raw, str):
                    raw = [x for x in raw.replace("\n", ",").split(",")]
                codes = []
                seen = set()
                for c in raw:
                    cc = str(c or "").strip().upper()
                    if cc and cc not in seen:
                        seen.add(cc); codes.append(cc)
                if not codes:
                    conn.close()
                    return jsonify({"status": "error", "message": "Add at least one box code"}), 400
                # Validate codes exist.
                placeholders = ",".join(["%s"] * len(codes))
                found = conn.execute(
                    f"SELECT box_code FROM rm_boxes WHERE box_code IN ({placeholders})",
                    tuple(codes),
                ).fetchall()
                found_set = {(r["box_code"] if hasattr(r, "get") else r[0]) for r in found}
                missing = [c for c in codes if c not in found_set]
                if missing:
                    conn.close()
                    return jsonify({"status": "error",
                                    "message": "Unknown box code(s): " + ", ".join(missing[:10])}), 400

            csv = ",".join(codes)
            if len(csv) > 5_000_000:
                conn.close()
                return jsonify({"status": "error",
                                "message": "Too many boxes — split into multiple requests."}), 400

            conn.execute(
                """INSERT INTO inventory_label_reprint_requests
                     (scope_type, grn_id, grn_no, box_codes_csv, box_count,
                      reason, status, requested_by)
                   VALUES (%s,%s,%s,%s,%s,%s,'pending',%s)""",
                (scope, grn_id, grn_no, csv, len(codes), reason, _user()),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "box_count": len(codes)})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── LIST ──────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/requests", methods=["GET"])
    @_login_required
    def api_reprint_requests():
        st = (request.args.get("status") or "").strip()
        mine = request.args.get("mine") == "1" or not _can_approve()
        conn = sampling_portal.get_db_connection()
        try:
            where, params = [], []
            if st:
                where.append("status=%s"); params.append(st)
            if mine:
                where.append("requested_by=%s"); params.append(_user())
            where_sql = (" WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                f"""SELECT req_id, scope_type, grn_id, grn_no, box_count, reason,
                           status, requested_by, requested_at, decided_by,
                           decided_at, decided_note
                    FROM inventory_label_reprint_requests
                    {where_sql} ORDER BY req_id DESC""",
                tuple(params),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                for k in ("requested_at", "decided_at"):
                    if dd.get(k) is not None:
                        dd[k] = str(dd[k])
                # printed progress
                if dd["status"] in ("approved", "printed"):
                    pr = conn.execute(
                        "SELECT COUNT(*) AS n, COALESCE(SUM(printed),0) AS p "
                        "FROM inventory_label_reprint_box_status WHERE req_id=%s",
                        (dd["req_id"],),
                    ).fetchone()
                    prd = dict(pr) if pr else {}
                    dd["printed_count"] = int(prd.get("p") or 0)
                    dd["total_count"] = int(prd.get("n") or dd.get("box_count") or 0)
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "requests": out, "can_approve": _can_approve(), "can_request": _can_request()})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/<int:req_id>/boxes", methods=["GET"])
    @_login_required
    def api_reprint_boxes(req_id):
        """Per-box print status for one (approved) request."""
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT box_code, printed, printed_at, printed_by "
                "FROM inventory_label_reprint_box_status WHERE req_id=%s ORDER BY box_code",
                (req_id,),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                dd["printed"] = int(dd.get("printed") or 0)
                if dd.get("printed_at") is not None:
                    dd["printed_at"] = str(dd["printed_at"])
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "boxes": out})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/pending_count", methods=["GET"])
    @_login_required
    def api_reprint_pending_count():
        if not _can_approve():
            return jsonify({"status": "ok", "count": 0})
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_label_reprint_requests WHERE status='pending'"
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

    def _approve_one(conn, req_id, note):
        row = conn.execute(
            "SELECT status, box_codes_csv FROM inventory_label_reprint_requests WHERE req_id=%s",
            (req_id,),
        ).fetchone()
        if not row:
            return False, f"Request #{req_id} not found"
        rd = dict(row)
        if rd["status"] != "pending":
            return False, f"Request #{req_id} is '{rd['status']}', not pending"
        conn.execute(
            "UPDATE inventory_label_reprint_requests "
            "SET status='approved', decided_by=%s, decided_at=NOW(), decided_note=%s WHERE req_id=%s",
            (_user(), note, req_id),
        )
        csv = (rd.get("box_codes_csv") or "").strip()
        if csv:
            seen = set()
            for raw in csv.split(","):
                code = raw.strip()
                if not code or code in seen:
                    continue
                seen.add(code)
                try:
                    conn.execute(
                        "INSERT INTO inventory_label_reprint_box_status (req_id, box_code) VALUES (%s,%s)",
                        (req_id, code[:50]),
                    )
                except Exception:
                    pass
        return True, "ok"

    # ── APPROVE single ────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:req_id>/approve", methods=["POST"])
    @_login_required
    def api_reprint_approve(req_id):
        if not _can_approve():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        note = (d.get("note") or "").strip() or None
        conn = sampling_portal.get_db_connection()
        try:
            ok, msg = _approve_one(conn, req_id, note)
            if not ok:
                conn.close()
                return jsonify({"status": "error", "message": msg}), 400
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try:
                conn.rollback(); conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── APPROVE bulk ──────────────────────────────────────────────────────
    @app.route(f"{PFX}/approve_bulk", methods=["POST"])
    @_login_required
    def api_reprint_approve_bulk():
        if not _can_approve():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        ids = d.get("req_ids") or []
        note = (d.get("note") or "").strip() or None
        if not ids:
            return jsonify({"status": "error", "message": "req_ids required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            done = 0
            for rid in ids:
                try:
                    ok, _ = _approve_one(conn, int(rid), note)
                    if ok:
                        done += 1
                except Exception:
                    pass
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "approved": done})
        except Exception as e:
            try:
                conn.rollback(); conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── REJECT ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:req_id>/reject", methods=["POST"])
    @_login_required
    def api_reprint_reject(req_id):
        if not _can_approve():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        note = (d.get("note") or "").strip() or None
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT status FROM inventory_label_reprint_requests WHERE req_id=%s", (req_id,)
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            cur = r["status"] if hasattr(r, "get") else r[0]
            if cur != "pending":
                conn.close()
                return jsonify({"status": "error", "message": f"Already {cur}."}), 400
            conn.execute(
                "UPDATE inventory_label_reprint_requests "
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

    # ── MARK PRINTED (one box, or all in request) ─────────────────────────
    @app.route(f"{PFX}/<int:req_id>/print", methods=["POST"])
    @_login_required
    def api_reprint_print(req_id):
        d = request.get_json(silent=True) or {}
        box_code = (d.get("box_code") or "").strip().upper() or None
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT status FROM inventory_label_reprint_requests WHERE req_id=%s", (req_id,)
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            cur = r["status"] if hasattr(r, "get") else r[0]
            if cur not in ("approved", "printed"):
                conn.close()
                return jsonify({"status": "error", "message": "Only approved requests can be printed."}), 400

            if box_code:
                conn.execute(
                    "UPDATE inventory_label_reprint_box_status "
                    "SET printed=1, printed_at=NOW(), printed_by=%s WHERE req_id=%s AND box_code=%s",
                    (_user(), req_id, box_code),
                )
            else:
                conn.execute(
                    "UPDATE inventory_label_reprint_box_status "
                    "SET printed=1, printed_at=NOW(), printed_by=%s WHERE req_id=%s AND printed=0",
                    (_user(), req_id),
                )
            # If all boxes printed, flip request to 'printed'.
            pr = conn.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(printed),0) AS p "
                "FROM inventory_label_reprint_box_status WHERE req_id=%s",
                (req_id,),
            ).fetchone()
            prd = dict(pr) if pr else {}
            if int(prd.get("n") or 0) > 0 and int(prd.get("p") or 0) >= int(prd.get("n") or 0):
                conn.execute(
                    "UPDATE inventory_label_reprint_requests SET status='printed' WHERE req_id=%s",
                    (req_id,),
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

    # ── BOX LABEL DATA (for client-side reprinting) ──────────────────────
    # Given one or many box codes, returns the full label-render payload in
    # the EXACT shape window.invPrintLabels() expects (same fields as the
    # GRN doLabelPrint label objects). This is what powers actual physical
    # reprint output — reprint approval just marks the box printed; this
    # endpoint provides the data to *actually* re-render the label.
    #
    # SCHEMA-DEFENSIVE: probes for every column on rm_boxes /
    # procurement_grn_items / procurement_grn before SELECTing. Different
    # HCP installs have slightly different column sets (May 2026 migrations
    # didn't run everywhere), and the alternative of hard-coding columns
    # gives 500s in production. We adapt instead.
    #
    # Handles both regular RM boxes (joined via procurement_grn_items) and
    # opening-stock boxes (which have no grn_item_id; we use box-level
    # columns as the fallback).
    #
    # Query params:  ?box_code=XXX           (single, comma-separated also ok)
    #                ?box_codes=A,B,C        (csv list — preferred for many)
    # Returns on success: { status:'ok', labels:[ {...label object...} ] }
    # On error: { status:'error', message:'…', detail:'…', where:'…' }
    #   with HTTP 500 — detail/where are populated so the browser DevTools
    #   network panel reveals the root cause (column missing, table absent,
    #   etc.) without needing server log access.
    @app.route("/api/inventory_mgmt/box_label_data", methods=["GET"])
    @_login_required
    def api_box_label_data():
        raw = request.args.get("box_codes") or request.args.get("box_code") or ""
        codes = []
        seen = set()
        for c in str(raw).replace("\n", ",").split(","):
            cc = c.strip().upper()
            if cc and cc not in seen:
                seen.add(cc); codes.append(cc)
        if not codes:
            return jsonify({"status": "error", "message": "box_code required"}), 400
        if len(codes) > 500:
            return jsonify({"status": "error", "message": "Max 500 codes per call"}), 400

        # Track which step we're on so a thrown exception identifies itself.
        stage = "init"
        conn = None
        try:
            conn = sampling_portal.get_db_connection()
            if not conn:
                return jsonify({"status": "error", "message": "DB connection failed",
                                "where": stage}), 500

            # ── Schema discovery ─────────────────────────────────────────
            # SHOW COLUMNS returns a list — for each table we want, build a
            # lowercase set of column names. If a table doesn't exist, we
            # treat that as "no columns" (callers fall back to defaults).
            def _cols(table):
                try:
                    rows = conn.execute(f"SHOW COLUMNS FROM `{table}`").fetchall()
                    out = set()
                    for r in rows:
                        # row shape differs across DB drivers (dict vs tuple
                        # vs Row), so try several access patterns
                        name = None
                        if isinstance(r, dict):
                            name = r.get("Field") or r.get("field")
                        else:
                            try:
                                name = r["Field"]
                            except Exception:
                                try:
                                    name = r[0]
                                except Exception:
                                    name = None
                        if name:
                            out.add(str(name).lower())
                    return out
                except Exception:
                    return set()

            stage = "probe rm_boxes"
            box_cols = _cols("rm_boxes")
            if not box_cols:
                return jsonify({"status": "error",
                                "message": "rm_boxes table not found or has no columns",
                                "where": stage}), 500

            stage = "probe procurement_grn_items"
            item_cols = _cols("procurement_grn_items")
            stage = "probe procurement_grn"
            grn_cols  = _cols("procurement_grn")
            stage = "probe procurement_materials"
            mat_cols  = _cols("procurement_materials")

            # ── Build the SELECT list defensively ────────────────────────
            # For each (alias_prefix, table_cols, wanted_col, output_alias)
            # we add the column only if it really exists; else we add a
            # literal NULL so the result row still has the key. This means
            # downstream code can read rd.get('batch_num') etc. without
            # branching on what the schema looks like.
            def _opt(prefix, table_cols, col, alias=None):
                a = alias or col
                if col.lower() in table_cols:
                    return f"{prefix}.{col} AS {a}"
                return f"NULL AS {a}"

            # rm_boxes b — these are the columns we'll attempt to read
            b_parts = [
                _opt("b", box_cols, "box_id"),
                _opt("b", box_cols, "box_code"),
                _opt("b", box_cols, "material_id"),
                _opt("b", box_cols, "grn_id"),
                _opt("b", box_cols, "grn_item_id"),
                _opt("b", box_cols, "grn_no", "box_grn_no"),
                _opt("b", box_cols, "source"),
                _opt("b", box_cols, "per_box_qty"),
                _opt("b", box_cols, "uom"),
                _opt("b", box_cols, "box_seq"),
                _opt("b", box_cols, "batch_num", "box_batch_num"),
                _opt("b", box_cols, "expiry_date", "box_expiry_date"),
                _opt("b", box_cols, "mfg_date", "box_mfg_date"),
                _opt("b", box_cols, "manufacturer", "box_manufacturer"),
            ]
            # procurement_grn_items gi
            gi_parts = [
                _opt("gi", item_cols, "batch_num"),
                _opt("gi", item_cols, "invoice_num"),
                _opt("gi", item_cols, "invoice_date"),
                _opt("gi", item_cols, "mfg_date"),
                _opt("gi", item_cols, "expiry_date"),
                _opt("gi", item_cols, "manufacturer"),
            ]
            # procurement_grn h
            h_parts = [
                _opt("h", grn_cols, "grn_no", "h_grn_no"),
                _opt("h", grn_cols, "grn_num", "h_grn_num"),   # older installs
                _opt("h", grn_cols, "grn_date", "h_grn_date"),
                _opt("h", grn_cols, "supplier_name", "h_supplier_name"),
                _opt("h", grn_cols, "supervisor_name", "h_supervisor_name"),
            ]
            # procurement_materials m
            m_parts = [
                _opt("m", mat_cols, "material_name"),
                _opt("m", mat_cols, "name", "material_name_alt"),  # rare alt
            ]

            select_list = ",\n                    ".join(b_parts + gi_parts + h_parts + m_parts)

            # ── Build the query — joins skip cleanly if table is empty ───
            joins = []
            if mat_cols:
                joins.append("LEFT JOIN procurement_materials m ON m.id = b.material_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, '' AS material_name, '' AS material_name_alt) m ON 1=0")
            if item_cols and "grn_item_id" in box_cols:
                joins.append("LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, '' AS batch_num, '' AS invoice_num, "
                             "NULL AS invoice_date, NULL AS mfg_date, NULL AS expiry_date, '' AS manufacturer) "
                             "gi ON 1=0")
            if grn_cols and "grn_id" in box_cols:
                joins.append("LEFT JOIN procurement_grn h ON h.id = b.grn_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, '' AS h_grn_no, '' AS h_grn_num, "
                             "NULL AS h_grn_date, '' AS h_supplier_name, '' AS h_supervisor_name) "
                             "h ON 1=0")

            placeholders = ",".join(["%s"] * len(codes))
            sql = (
                f"SELECT {select_list}\n"
                f"FROM rm_boxes b\n"
                + "\n".join(joins) + "\n"
                f"WHERE b.box_code IN ({placeholders})"
            )

            stage = "main query"
            rows = conn.execute(sql, tuple(codes)).fetchall()

            stage = "row processing"

            # Total-boxes lookup — defensive. If grn_item_id col exists, use
            # it; otherwise fall back to total=1 (single-package fallback).
            totals_by_key = {}
            has_grn_item_id = "grn_item_id" in box_cols

            def _total_for(b):
                if not has_grn_item_id:
                    return 1
                gi_id = b.get("grn_item_id")
                if not gi_id:
                    return 1
                key = int(gi_id)
                if key in totals_by_key:
                    return totals_by_key[key]
                try:
                    cnt = conn.execute(
                        "SELECT COUNT(*) AS c FROM rm_boxes WHERE grn_item_id=%s",
                        (key,),
                    ).fetchone()
                    n = int((cnt["c"] if isinstance(cnt, dict) else cnt[0]) or 1) if cnt else 1
                except Exception:
                    n = 1
                totals_by_key[key] = n
                return n

            def _fmt_date(v):
                if v is None:
                    return ""
                s = str(v)
                # MySQL returns YYYY-MM-DD or YYYY-MM-DD HH:MM:SS; keep YYYY-MM-DD
                # so the JS renderer's fmtDate (which converts to DD/MM/YYYY) works.
                return s[:10]

            def _pick(rd, *keys):
                """First non-empty value across the listed dict keys."""
                for k in keys:
                    v = rd.get(k)
                    if v not in (None, "", 0):
                        return v
                return ""

            session_user = (session.get("User_Name") or session.get("UID") or "").strip()

            # Index returned rows by code for stable ordering / not-found
            # placeholder handling.
            by_code = {}
            for r in rows:
                rd = dict(r) if not isinstance(r, dict) else r
                code = (rd.get("box_code") or "").strip()
                if not code:
                    continue
                by_code[code.upper()] = rd

            labels = []
            for code in codes:
                rd = by_code.get(code)
                if not rd:
                    labels.append({
                        "materialName": "", "qrCode": code, "grnNo": "—",
                        "grnDate": "", "batchNo": "", "boxNum": 1, "totalBoxes": 1,
                        "perPkgQty": "", "uom": "", "invoiceNo": "", "invoiceDate": "",
                        "mfgDate": "", "expiryDate": "", "manufacturer": "",
                        "supplier": "", "supervisor": session_user, "_not_found": True,
                    })
                    continue
                is_opening = (str(rd.get("source") or "").lower() == "opening") or (not rd.get("grn_id"))
                grn_no   = _pick(rd, "h_grn_no", "h_grn_num", "box_grn_no")
                grn_date = _fmt_date(rd.get("h_grn_date"))
                supplier = rd.get("h_supplier_name") or ""
                supv     = (rd.get("h_supervisor_name") or "").strip() or session_user
                if is_opening:
                    grn_no = "OPENING"
                    if not supplier:
                        supplier = "Opening Stock"
                box_num = int(rd.get("box_seq") or 1)
                total   = _total_for(rd)
                # batch_num / mfg / expiry / manufacturer — prefer gi.* over
                # box-level fallback (opening stock writes these to the box
                # directly when there's no grn_item).
                batch_num    = _pick(rd, "batch_num", "box_batch_num")
                mfg_date     = _fmt_date(_pick(rd, "mfg_date", "box_mfg_date"))
                expiry_date  = _fmt_date(_pick(rd, "expiry_date", "box_expiry_date"))
                manufacturer = _pick(rd, "manufacturer", "box_manufacturer")
                material     = _pick(rd, "material_name", "material_name_alt")

                try:
                    per_box_qty = float(rd.get("per_box_qty")) if rd.get("per_box_qty") not in (None, "") else ""
                except Exception:
                    per_box_qty = ""

                labels.append({
                    "materialName": material or "",
                    "qrCode":       rd.get("box_code") or code,
                    "grnNo":        grn_no or "",
                    "grnDate":      grn_date,
                    "batchNo":      batch_num or "",
                    "boxNum":       box_num,
                    "totalBoxes":   total,
                    "perPkgQty":    per_box_qty,
                    "uom":          rd.get("uom") or "KG",
                    "invoiceNo":    rd.get("invoice_num") or "",
                    "invoiceDate":  _fmt_date(rd.get("invoice_date")),
                    "mfgDate":      mfg_date,
                    "expiryDate":   expiry_date,
                    "manufacturer": manufacturer or "",
                    "supplier":     supplier or "",
                    "supervisor":   supv,
                })
            conn.close()
            return jsonify({"status": "ok", "labels": labels,
                            "schema_seen": {
                                "rm_boxes": sorted(box_cols),
                                "procurement_grn_items": sorted(item_cols),
                                "procurement_grn": sorted(grn_cols),
                                "procurement_materials": sorted(mat_cols),
                            }})
        except Exception as e:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            import traceback
            tb = traceback.format_exc()
            # Print to server log (still useful if you ever do get terminal),
            # but more importantly return the message in JSON so the browser
            # network panel reveals it.
            print(f"[box_label_data] FAILED at stage={stage}: {e}\n{tb}")
            return jsonify({"status": "error",
                            "message": f"box_label_data failed at stage '{stage}'",
                            "detail": str(e),
                            "where": stage}), 500

    # ── BOX CODES for a reprint request ───────────────────────────────────
    # Used when "Print all" is clicked on an approved reprint request — JS
    # needs the actual codes to feed into invPrintLabels. We already expose
    # /<rid>/boxes (which returns codes + printed flags), but that endpoint
    # is fine for this purpose. No new route needed.

    print("✅ [InventoryReprint] routes registered (/api/inventory_mgmt/label_reprint/*, /box_label_data)")
