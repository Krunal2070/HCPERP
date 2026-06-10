"""
inventory_audit.py - Physical Stock Audit (RM)
HCP Wellness - adapted from pm_stock_audit_routes.py

Workflow:
  1. A user starts an audit SESSION for a godown (+ optional material scope).
  2. They physically scan each box (handheld QR) into the session. Re-scans
     are no-ops (UNIQUE on session+box_code).
  3. The session shows live VARIANCE vs the system's expected in_stock boxes:
        - missing : expected boxes (in_stock at the godown) NOT scanned
        - extra   : scanned boxes that aren't expected here
        - per-material box/qty expected vs counted
  4. A non-admin SUBMITS the session for settlement (open -> pending). They
     cannot settle their own.
  5. An ADMIN reviews variance and SETTLES (applies adjustments: missing boxes
     -> marked 'lost'/adjusted; extras -> moved in) or REJECTS.

Tables (idempotent on register):
  inventory_audit_sessions  — one row per session
  inventory_audit_materials — material scope chosen at start
  inventory_audit_scans     — one row per box scan (UNIQUE session+box_code)

Routes (prefix /api/inventory_mgmt/audit):
  GET   /list?status=open            list sessions by status
  POST  /start                       create a session
  GET   /<id>                        session detail + variance
  POST  /<id>/scan                   add a box scan
  POST  /<id>/unscan                 remove a scan
  POST  /<id>/submit                 submit for settlement (open->pending)
  POST  /<id>/reopen                 admin: pending->open
  POST  /<id>/settle                 admin: apply adjustments, settle
  POST  /<id>/reject                 admin: reject
"""

import sys
from datetime import date, datetime

import sampling_portal
from flask import request, jsonify, session


def _aud_user():
    return (session.get("UID") or session.get("User_Name") or session.get("user") or "system")


def _aud_is_admin():
    ut = (session.get("User_Type") or "").lower()
    uid = (session.get("UID") or "").lower()
    return ut == "admin" or uid in ("sonal", "tarak")


def _aud_logged_in():
    return bool(session.get("logged_in") or session.get("UID") or session.get("User_Name"))


def _audit_ensure_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_audit_sessions (
                session_id   INT AUTO_INCREMENT PRIMARY KEY,
                session_no   VARCHAR(40) NOT NULL UNIQUE,
                godown_id    INT NOT NULL,
                status       ENUM('open','pending_settlement','settled','rejected','cancelled')
                             NOT NULL DEFAULT 'open',
                created_by   VARCHAR(80) NOT NULL,
                created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                submitted_by VARCHAR(80) DEFAULT NULL,
                submitted_at DATETIME DEFAULT NULL,
                settled_by   VARCHAR(80) DEFAULT NULL,
                settled_at   DATETIME DEFAULT NULL,
                rejected_by  VARCHAR(80) DEFAULT NULL,
                rejected_at  DATETIME DEFAULT NULL,
                cancelled_by VARCHAR(80) DEFAULT NULL,
                cancelled_at DATETIME DEFAULT NULL,
                note         VARCHAR(1000) DEFAULT NULL,
                settle_note  VARCHAR(1000) DEFAULT NULL,
                INDEX ix_inv_audit_godown_status (godown_id, status),
                INDEX ix_inv_audit_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_audit_materials (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                session_id  INT NOT NULL,
                material_id INT NOT NULL,
                UNIQUE KEY uq_inv_audit_mat (session_id, material_id),
                INDEX ix_inv_audit_mat_s (session_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # Per-box record of exactly what a settlement changed, so a settled
        # session can be reverted precisely (restore each box's prior godown +
        # status). One row per box touched at settle time.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_audit_settle_log (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                session_id    INT NOT NULL,
                box_id        INT DEFAULT NULL,
                box_code      VARCHAR(40) DEFAULT NULL,
                action        ENUM('missing_lost','extra_moved') NOT NULL,
                prev_status   VARCHAR(30) DEFAULT NULL,
                prev_godown   INT DEFAULT NULL,
                new_status    VARCHAR(30) DEFAULT NULL,
                new_godown    INT DEFAULT NULL,
                reverted      TINYINT(1) NOT NULL DEFAULT 0,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_audit_settlelog_s (session_id),
                INDEX ix_inv_audit_settlelog_box (box_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_audit_scans (
                scan_id     INT AUTO_INCREMENT PRIMARY KEY,
                session_id  INT NOT NULL,
                box_code    VARCHAR(40) NOT NULL,
                box_id      INT DEFAULT NULL,
                material_id INT DEFAULT NULL,
                qty         DECIMAL(14,3) DEFAULT 0,
                scanned_by  VARCHAR(80) NOT NULL,
                scanned_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_inv_audit_scan (session_id, box_code),
                INDEX ix_inv_audit_scan_s (session_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # ── Migrations for installs that predate the 'cancelled' state ──
        # CREATE TABLE IF NOT EXISTS never alters an existing table, so widen
        # the enum and add the cancelled_* columns idempotently here.
        try:
            conn.execute(
                "ALTER TABLE inventory_audit_sessions "
                "MODIFY COLUMN status ENUM('open','pending_settlement','settled','rejected','cancelled') "
                "NOT NULL DEFAULT 'open'"
            )
        except Exception:
            pass
        for _col_sql in (
            "ADD COLUMN cancelled_by VARCHAR(80) DEFAULT NULL",
            "ADD COLUMN cancelled_at DATETIME DEFAULT NULL",
        ):
            try:
                conn.execute("ALTER TABLE inventory_audit_sessions " + _col_sql)
            except Exception:
                pass  # column already exists
        conn.commit()
    except Exception as e:
        print(f"[inventory_audit] schema bootstrap failed: {e}", file=sys.stderr)
    finally:
        try: conn.close()
        except Exception: pass


def _next_session_no(conn, ref_date=None):
    """
    Allocate the next audit session number.

    Order of preference:
      1. inventory_voucher_numbering.next_voucher_no(conn, 'inv_aud')
      2. Legacy AUD/YY-YY/NNNN (Indian FY, April boundary)
    """
    # Step 1: admin-configured style
    try:
        try:
            from inventory import inventory_voucher_numbering as _ivn
        except Exception:
            import inventory_voucher_numbering as _ivn
        no = _ivn.next_voucher_no(conn, 'inv_aud')
        if no:
            return no
    except Exception:
        pass

    # Step 2: legacy AUD/YY-YY/NNNN
    ref_date = ref_date or date.today()
    y = ref_date.year
    if ref_date.month < 4:
        fy = f"{str(y-1)[-2:]}-{str(y)[-2:]}"
    else:
        fy = f"{str(y)[-2:]}-{str(y+1)[-2:]}"
    prefix = f"AUD/{fy}/"
    try:
        row = conn.execute(
            "SELECT session_no FROM inventory_audit_sessions "
            "WHERE session_no LIKE %s ORDER BY session_id DESC LIMIT 1",
            (prefix + "%",),
        ).fetchone()
        n = 1
        if row and row["session_no"]:
            try: n = int(str(row["session_no"]).split("/")[-1]) + 1
            except Exception: n = 1
    except Exception:
        n = 1
    return f"{prefix}{n:04d}"


def _row_dates(d):
    for k in ("created_at", "submitted_at", "settled_at", "rejected_at"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    return d


def _compute_variance(conn, sid, godown_id, mat_ids):
    """expected = in_stock boxes of the scoped item(s) AT THIS GODOWN
    (= opening + GRN received - sent elsewhere, in boxes, for this location,
    which is exactly what rm_boxes.current_status/current_godown_id track);
    counted = scanned boxes. Returns per-material rows + missing/extra boxes."""
    # Expected boxes
    if mat_ids:
        ph = ",".join(["%s"] * len(mat_ids))
        expected = conn.execute(
            f"SELECT b.box_code, b.box_id, b.material_id, b.per_box_qty AS qty, "
            f"m.material_name AS name "
            f"FROM rm_boxes b LEFT JOIN procurement_materials m ON m.id=b.material_id "
            f"WHERE b.current_status='in_stock' AND b.current_godown_id=%s "
            f"AND b.material_id IN ({ph})",
            tuple([godown_id] + list(mat_ids)),
        ).fetchall()
    else:
        expected = conn.execute(
            "SELECT b.box_code, b.box_id, b.material_id, b.per_box_qty AS qty, "
            "m.material_name AS name "
            "FROM rm_boxes b LEFT JOIN procurement_materials m ON m.id=b.material_id "
            "WHERE b.current_status='in_stock' AND b.current_godown_id=%s",
            (godown_id,),
        ).fetchall()
    expected_by_code = {r["box_code"]: dict(r) for r in expected}

    scans = conn.execute(
        "SELECT box_code, box_id, material_id, qty FROM inventory_audit_scans WHERE session_id=%s",
        (sid,),
    ).fetchall()
    scanned_codes = {r["box_code"]: dict(r) for r in scans}

    # Missing: expected - scanned
    missing = [v for code, v in expected_by_code.items() if code not in scanned_codes]
    # Extra: scanned - expected
    extra = []
    for code, s in scanned_codes.items():
        if code in expected_by_code:
            continue
        # look up the scanned box for context
        info = conn.execute(
            "SELECT b.box_code, b.box_id, b.material_id, b.per_box_qty AS qty, "
            "b.current_status, b.current_godown_id, m.material_name AS name "
            "FROM rm_boxes b LEFT JOIN procurement_materials m ON m.id=b.material_id "
            "WHERE b.box_code=%s", (code,)
        ).fetchone()
        extra.append(dict(info) if info else {"box_code": code, "name": "(unknown box)", "qty": 0})

    # Per-material expected vs counted
    mat = {}
    for r in expected:
        d = mat.setdefault(r["material_id"], {"material_id": r["material_id"], "name": r["name"] or "",
                                              "expected_box": 0, "expected_qty": 0.0,
                                              "counted_box": 0, "counted_qty": 0.0})
        d["expected_box"] += 1
        d["expected_qty"] += float(r["qty"] or 0)

    # Resolve material names for every scanned material_id (not just the
    # scoped/expected ones), so extra boxes show their real material instead
    # of "(unknown)". NULL material_id = a box code not found in rm_boxes.
    scanned_mids = {s.get("material_id") for s in scanned_codes.values() if s.get("material_id")}
    name_by_mid = {}
    if scanned_mids:
        ph = ",".join(["%s"] * len(scanned_mids))
        for row in conn.execute(
            f"SELECT id, material_name FROM procurement_materials WHERE id IN ({ph})",
            tuple(scanned_mids),
        ).fetchall():
            name_by_mid[row["id"]] = row["material_name"] or ""

    for code, s in scanned_codes.items():
        mid = s.get("material_id")
        nm = (expected_by_code.get(code, {}).get("name", "")
              or name_by_mid.get(mid, "")
              or ("(unknown box)" if not mid else ""))
        d = mat.setdefault(mid, {"material_id": mid, "name": nm,
                                 "expected_box": 0, "expected_qty": 0.0,
                                 "counted_box": 0, "counted_qty": 0.0})
        if not d["name"] and nm:
            d["name"] = nm
        d["counted_box"] += 1
        d["counted_qty"] += float(s.get("qty") or 0)
    rows = []
    for d in mat.values():
        d["var_box"] = d["counted_box"] - d["expected_box"]
        d["var_qty"] = round(d["counted_qty"] - d["expected_qty"], 3)
        rows.append(d)
    rows.sort(key=lambda x: (0 if x["var_box"] != 0 else 1, x["name"]))

    return {
        "materials": rows,
        "missing": missing,
        "extra": extra,
        "counts": {
            "expected_boxes": len(expected_by_code),
            "counted_boxes": len(scanned_codes),
            "missing_boxes": len(missing),
            "extra_boxes": len(extra),
        },
    }


def register_inventory_audit(app):
    if getattr(app, "_inventory_audit_registered", False):
        return
    app._inventory_audit_registered = True
    _audit_ensure_tables()

    def _scope_mat_ids(conn, sid):
        rows = conn.execute(
            "SELECT material_id FROM inventory_audit_materials WHERE session_id=%s", (sid,)
        ).fetchall()
        return [r["material_id"] for r in rows]

    @app.route("/api/inventory_mgmt/audit/list")
    def api_inv_audit_list():
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        statuses = (request.args.get("status") or "open").split(",")
        statuses = [s.strip() for s in statuses if s.strip()]
        if not statuses:
            statuses = ["open"]   # guard against ?status= producing an empty IN ()
        conn = sampling_portal.get_db_connection()
        try:
            ph = ",".join(["%s"] * len(statuses))
            rows = conn.execute(
                f"SELECT s.*, g.name AS godown_name, "
                f"(SELECT COUNT(*) FROM inventory_audit_scans x WHERE x.session_id=s.session_id) AS scan_count "
                f"FROM inventory_audit_sessions s "
                f"LEFT JOIN procurement_godowns g ON g.id=s.godown_id "
                f"WHERE s.status IN ({ph}) ORDER BY s.session_id DESC",
                tuple(statuses),
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "sessions": [_row_dates(dict(r)) for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/start", methods=["POST"])
    def api_inv_audit_start():
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d = request.get_json(silent=True) or {}
        try:
            godown_id = int(d.get("godown_id") or 0)
        except (TypeError, ValueError):
            godown_id = 0
        if not godown_id:
            return jsonify({"status": "error", "message": "godown_id required"}), 400
        mat_ids = []
        for m in (d.get("material_ids") or []):
            try: mat_ids.append(int(m))
            except (TypeError, ValueError): pass
        note = (d.get("note") or "").strip()[:1000]
        conn = sampling_portal.get_db_connection()
        try:
            # ── STRONG BLOCK: a material may be in only ONE active audit at a
            # time. "Active" = any session not yet in History, i.e. status in
            # ('open','pending_settlement'). Settled / rejected / cancelled are
            # terminal (History) and free the material again. This prevents the
            # same item being counted on two overlapping sessions, which would
            # let two settlements both adjust the same boxes.
            if mat_ids:
                ph = ",".join(["%s"] * len(mat_ids))
                clash = conn.execute(
                    "SELECT am.material_id, s.session_no, s.status, "
                    "       COALESCE(pm.material_name, CONCAT('#', am.material_id)) AS material_name "
                    "FROM inventory_audit_materials am "
                    "JOIN inventory_audit_sessions s ON s.session_id = am.session_id "
                    "LEFT JOIN procurement_materials pm ON pm.id = am.material_id "
                    "WHERE s.status IN ('open','pending_settlement') "
                    f"  AND am.material_id IN ({ph}) "
                    "ORDER BY s.session_id DESC",
                    tuple(mat_ids),
                ).fetchall()
                if clash:
                    seen, parts = set(), []
                    for r in clash:
                        r = dict(r)
                        key = (r["material_name"], r["session_no"])
                        if key in seen:
                            continue
                        seen.add(key)
                        parts.append(f"{r['material_name']} (already in {r['session_no']})")
                    conn.close()
                    return jsonify({
                        "status": "error",
                        "message": "These item(s) are already in an active audit and can't be "
                                   "added to a new one until that session is settled, rejected "
                                   "or cancelled: " + "; ".join(parts),
                    }), 409
            sno = _next_session_no(conn)
            conn.execute(
                "INSERT INTO inventory_audit_sessions (session_no, godown_id, status, created_by, note) "
                "VALUES (%s,%s,'open',%s,%s)",
                (sno, godown_id, _aud_user(), note or None),
            )
            sid = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
            for mid in mat_ids:
                try:
                    conn.execute(
                        "INSERT INTO inventory_audit_materials (session_id, material_id) VALUES (%s,%s)",
                        (sid, mid),
                    )
                except Exception:
                    pass
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "session_id": int(sid), "session_no": sno})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/<int:sid>")
    def api_inv_audit_detail(sid):
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute(
                "SELECT s.*, g.name AS godown_name FROM inventory_audit_sessions s "
                "LEFT JOIN procurement_godowns g ON g.id=s.godown_id WHERE s.session_id=%s",
                (sid,),
            ).fetchone()
            if not s:
                conn.close()
                return jsonify({"status": "error", "message": "Session not found"}), 404
            s = _row_dates(dict(s))
            mat_ids = _scope_mat_ids(conn, sid)
            var = _compute_variance(conn, sid, s["godown_id"], mat_ids)
            scans = conn.execute(
                "SELECT box_code, qty, scanned_by, scanned_at FROM inventory_audit_scans "
                "WHERE session_id=%s ORDER BY scan_id DESC", (sid,)
            ).fetchall()
            conn.close()
            return jsonify({
                "status": "ok", "session": s, "variance": var,
                "scans": [_row_dates(dict(r)) for r in scans],
                "is_admin": _aud_is_admin(),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/<int:sid>/scan", methods=["POST"])
    def api_inv_audit_scan(sid):
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d = request.get_json(silent=True) or {}
        code = (d.get("box_code") or "").strip().upper()
        if not code:
            return jsonify({"status": "error", "message": "box_code required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute("SELECT status FROM inventory_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
            if not s:
                conn.close(); return jsonify({"status": "error", "message": "Session not found"}), 404
            if s["status"] != "open":
                conn.close(); return jsonify({"status": "error", "message": "Session is not open for scanning"}), 400
            # Resolve the scanned value against short_code (new QR) and
            # box_code (legacy/printed). short_code may not exist on older
            # installs — probe before using it. Store the canonical box_code
            # so it matches the expected set (which is keyed on box_code).
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
                    "SELECT box_id, box_code, material_id, per_box_qty FROM rm_boxes "
                    "WHERE short_code=%s OR box_code=%s LIMIT 1", (code, code)
                ).fetchone()
            else:
                box = conn.execute(
                    "SELECT box_id, box_code, material_id, per_box_qty FROM rm_boxes "
                    "WHERE box_code=%s LIMIT 1", (code,)
                ).fetchone()
            box_id = box["box_id"] if box else None
            mat_id = box["material_id"] if box else None
            qty = float(box["per_box_qty"]) if box else 0.0
            store_code = box["box_code"] if box else code   # canonical code
            # No scan-time rejection: the user scans whatever they physically
            # have. Boxes that aren't part of the selected item(s) — or aren't
            # known at all — are recorded and surface as "extra" for the admin
            # to review and approve (or reject) at settlement time.
            try:
                conn.execute(
                    "INSERT INTO inventory_audit_scans (session_id, box_code, box_id, material_id, qty, scanned_by) "
                    "VALUES (%s,%s,%s,%s,%s,%s)",
                    (sid, store_code, box_id, mat_id, qty, _aud_user()),
                )
                conn.commit()
                dup = False
            except Exception:
                dup = True  # UNIQUE violation = already scanned
            conn.close()
            return jsonify({"status": "ok", "duplicate": dup, "known_box": bool(box)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/<int:sid>/unscan", methods=["POST"])
    def api_inv_audit_unscan(sid):
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d = request.get_json(silent=True) or {}
        code = (d.get("box_code") or "").strip().upper()
        conn = sampling_portal.get_db_connection()
        try:
            # The stored scan uses the canonical box_code; if the user unscans
            # by the QR short_code, resolve it back to box_code first (only if
            # the short_code column exists on this install).
            del_code = code
            try:
                _has_sc = any(
                    (c["Field"] if hasattr(c, "get") else c[0]) == "short_code"
                    for c in conn.execute("SHOW COLUMNS FROM rm_boxes").fetchall()
                )
            except Exception:
                _has_sc = False
            if _has_sc:
                row = conn.execute(
                    "SELECT box_code FROM rm_boxes WHERE short_code=%s OR box_code=%s LIMIT 1",
                    (code, code),
                ).fetchone()
                if row:
                    del_code = row["box_code"]
            conn.execute("DELETE FROM inventory_audit_scans WHERE session_id=%s AND box_code=%s", (sid, del_code))
            conn.commit(); conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    def _set_status(sid, new_status, who_col, extra_note_col=None, note=None):
        conn = sampling_portal.get_db_connection()
        try:
            sets = [f"status=%s", f"{who_col}=%s", f"{who_col.replace('_by','_at')}=NOW()"]
            vals = [new_status, _aud_user()]
            if extra_note_col and note is not None:
                sets.append(f"{extra_note_col}=%s"); vals.append(note)
            vals.append(sid)
            conn.execute(f"UPDATE inventory_audit_sessions SET {', '.join(sets)} WHERE session_id=%s", tuple(vals))
            conn.commit(); conn.close()
            return True, None
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return False, str(e)

    @app.route("/api/inventory_mgmt/audit/<int:sid>/submit", methods=["POST"])
    def api_inv_audit_submit(sid):
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        ok, err = _set_status(sid, "pending_settlement", "submitted_by")
        return jsonify({"status": "ok"} if ok else {"status": "error", "message": err}), (200 if ok else 500)

    @app.route("/api/inventory_mgmt/audit/<int:sid>/reopen", methods=["POST"])
    def api_inv_audit_reopen(sid):
        if not _aud_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        ok, err = _set_status(sid, "open", "submitted_by")
        return jsonify({"status": "ok"} if ok else {"status": "error", "message": err}), (200 if ok else 500)

    @app.route("/api/inventory_mgmt/audit/<int:sid>/cancel", methods=["POST"])
    def api_inv_audit_cancel(sid):
        # The person who started a session (or an admin) can cancel it while it
        # is still open. Cancelling makes no stock changes — it simply closes
        # the session out so it stops showing under the Open tab. Scans are
        # kept for the record. Only 'open' sessions may be cancelled.
        if not _aud_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d = request.get_json(silent=True) or {}
        note = (d.get("note") or "").strip()
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute(
                "SELECT status, created_by FROM inventory_audit_sessions WHERE session_id=%s",
                (sid,),
            ).fetchone()
            if not s:
                conn.close(); return jsonify({"status": "error", "message": "Session not found"}), 404
            if s["status"] != "open":
                conn.close()
                return jsonify({"status": "error", "message": "Only open sessions can be cancelled"}), 400
            me = (_aud_user() or "").strip().lower()
            owner = (s["created_by"] or "").strip().lower()
            if not (_aud_is_admin() or me == owner):
                conn.close()
                return jsonify({"status": "error", "message": "Only the initiator or an admin can cancel this session"}), 403
            sets = ["status='cancelled'", "cancelled_by=%s", "cancelled_at=NOW()"]
            vals = [_aud_user()]
            if note:
                sets.append("note=CONCAT(COALESCE(note,''), %s)")
                vals.append("\n[cancelled] " + note)
            vals.append(sid)
            conn.execute(
                "UPDATE inventory_audit_sessions SET " + ", ".join(sets) + " WHERE session_id=%s",
                tuple(vals),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/<int:sid>/reject", methods=["POST"])
    def api_inv_audit_reject(sid):
        if not _aud_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        d = request.get_json(silent=True) or {}
        ok, err = _set_status(sid, "rejected", "rejected_by", "settle_note", (d.get("note") or "").strip()[:1000])
        return jsonify({"status": "ok"} if ok else {"status": "error", "message": err}), (200 if ok else 500)

    @app.route("/api/inventory_mgmt/audit/<int:sid>/settle", methods=["POST"])
    def api_inv_audit_settle(sid):
        if not _aud_is_admin():
            return jsonify({"status": "error", "message": "Admin only — cannot settle your own count"}), 403
        d = request.get_json(silent=True) or {}
        apply_adjust = bool(d.get("apply_adjustments", True))
        note = (d.get("note") or "").strip()[:1000]
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute("SELECT * FROM inventory_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
            if not s:
                conn.close(); return jsonify({"status": "error", "message": "Session not found"}), 404
            if s["status"] not in ("pending_settlement", "open"):
                conn.close(); return jsonify({"status": "error", "message": "Only a pending session can be settled"}), 400

            adjustments = {"missing_marked": 0, "extra_moved": 0}
            if apply_adjust:
                mat_ids = _scope_mat_ids(conn, sid)
                var = _compute_variance(conn, sid, s["godown_id"], mat_ids)
                # Missing boxes: mark as 'lost' (they weren't physically found).
                for mb in var["missing"]:
                    try:
                        # Snapshot prior state so this can be reverted precisely.
                        prev = conn.execute(
                            "SELECT box_id, current_status, current_godown_id FROM rm_boxes WHERE box_code=%s",
                            (mb["box_code"],),
                        ).fetchone()
                        conn.execute(
                            "UPDATE rm_boxes SET current_status='lost' WHERE box_code=%s AND current_status='in_stock'",
                            (mb["box_code"],),
                        )
                        if prev:
                            conn.execute(
                                "INSERT INTO inventory_audit_settle_log "
                                "(session_id, box_id, box_code, action, prev_status, prev_godown, new_status, new_godown) "
                                "VALUES (%s,%s,%s,'missing_lost',%s,%s,'lost',%s)",
                                (sid, prev["box_id"], mb["box_code"], prev["current_status"],
                                 prev["current_godown_id"], prev["current_godown_id"]),
                            )
                        _log_movement(conn, mb.get("box_id"), "adjust",
                                      f"Audit {s['session_no']}: not found in count, marked lost")
                        adjustments["missing_marked"] += 1
                    except Exception:
                        pass
                # Extra boxes found here: move them into this godown + in_stock.
                for eb in var["extra"]:
                    try:
                        if eb.get("box_id"):
                            # Snapshot prior godown/status before the move.
                            prev = conn.execute(
                                "SELECT current_status, current_godown_id FROM rm_boxes WHERE box_id=%s",
                                (eb["box_id"],),
                            ).fetchone()
                            conn.execute(
                                "UPDATE rm_boxes SET current_godown_id=%s, current_status='in_stock' WHERE box_id=%s",
                                (s["godown_id"], eb["box_id"]),
                            )
                            conn.execute(
                                "INSERT INTO inventory_audit_settle_log "
                                "(session_id, box_id, box_code, action, prev_status, prev_godown, new_status, new_godown) "
                                "VALUES (%s,%s,%s,'extra_moved',%s,%s,'in_stock',%s)",
                                (sid, eb["box_id"], eb.get("box_code"),
                                 (prev["current_status"] if prev else None),
                                 (prev["current_godown_id"] if prev else None),
                                 s["godown_id"]),
                            )
                            _log_movement(conn, eb.get("box_id"), "adjust",
                                          f"Audit {s['session_no']}: found in count, moved to godown {s['godown_id']}")
                            adjustments["extra_moved"] += 1
                    except Exception:
                        pass

            conn.execute(
                "UPDATE inventory_audit_sessions SET status='settled', settled_by=%s, settled_at=NOW(), "
                "settle_note=%s WHERE session_id=%s",
                (_aud_user(), note or None, sid),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok", "adjustments": adjustments})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/audit/<int:sid>/revert", methods=["POST"])
    def api_inv_audit_revert(sid):
        """Admin: revert a SETTLED session. Reverses every stock change the
        settlement made (restores each box's prior godown + status from the
        settle-log), then returns the session to pending_settlement so it can
        be re-reviewed. Sessions settled before the settle-log existed have no
        recorded changes; for those the stock can't be auto-reversed, so we
        only revert the status and report that no stock changes were undone."""
        if not _aud_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute("SELECT * FROM inventory_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
            if not s:
                conn.close(); return jsonify({"status": "error", "message": "Session not found"}), 404
            if s["status"] != "settled":
                conn.close(); return jsonify({"status": "error", "message": "Only a settled session can be reverted"}), 400

            logs = conn.execute(
                "SELECT * FROM inventory_audit_settle_log WHERE session_id=%s AND reverted=0",
                (sid,),
            ).fetchall()

            undone = {"missing_restored": 0, "extra_moved_back": 0}
            for lg in logs:
                try:
                    box_id = lg["box_id"]
                    if not box_id:
                        continue
                    if lg["action"] == "missing_lost":
                        # Was in_stock, settle marked it lost → restore in_stock
                        # at its prior godown. Only if still 'lost' (don't clobber
                        # a later manual change).
                        conn.execute(
                            "UPDATE rm_boxes SET current_status=%s, current_godown_id=%s "
                            "WHERE box_id=%s AND current_status='lost'",
                            (lg["prev_status"] or "in_stock", lg["prev_godown"], box_id),
                        )
                        _log_movement(conn, box_id, "adjust",
                                      f"Audit {s['session_no']}: settlement reverted — restored from lost")
                        undone["missing_restored"] += 1
                    elif lg["action"] == "extra_moved":
                        # Settle moved it into this godown → send it back to its
                        # prior godown/status. prev_godown may be NULL (the box
                        # had no godown before); restore exactly what was saved.
                        conn.execute(
                            "UPDATE rm_boxes SET current_godown_id=%s, current_status=%s WHERE box_id=%s",
                            (lg["prev_godown"], lg["prev_status"] or "in_stock", box_id),
                        )
                        _log_movement(conn, box_id, "adjust",
                                      f"Audit {s['session_no']}: settlement reverted — moved back to prior godown")
                        undone["extra_moved_back"] += 1
                    conn.execute("UPDATE inventory_audit_settle_log SET reverted=1 WHERE id=%s", (lg["id"],))
                except Exception:
                    # Skip a box that can't be reverted (e.g. since transferred);
                    # leave its log row un-reverted so it's visible it wasn't undone.
                    pass

            # Return the session to pending so it can be re-reviewed/re-settled.
            conn.execute(
                "UPDATE inventory_audit_sessions SET status='pending_settlement', "
                "settled_by=NULL, settled_at=NULL WHERE session_id=%s",
                (sid,),
            )
            conn.commit(); conn.close()
            had_log = len(logs) > 0
            return jsonify({
                "status": "ok",
                "undone": undone,
                "note": (None if had_log else
                         "This session was settled before change-tracking existed, "
                         "so no stock changes were recorded to undo — only its status was reverted."),
            })
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    def _log_movement(conn, box_id, mtype, detail):
        if not box_id:
            return
        try:
            conn.execute(
                "INSERT INTO rm_box_movements (box_id, movement_type, qty, moved_by, remarks) "
                "VALUES (%s,%s,%s,%s,%s)",
                (box_id, mtype, 0, _aud_user(), detail),
            )
        except Exception:
            # movements table shape may differ; fail silently so settle still works
            pass

    print("✅ [InventoryAudit] registered — /api/inventory_mgmt/audit/*")
