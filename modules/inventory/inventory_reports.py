"""
inventory_reports.py - Reports (RM)
HCP Wellness

Report 1: Godown-wise Stock Summary
  - User picks a godown; lists each material with stock in that godown.
  - with_cost toggle: shows rate + value; total stock value at bottom.

Report 2: Group-wise Stock Summary
  - User picks a material group; lists items in that group with total stock
    (across all godowns).
  - with_cost toggle: rate + value; total stock value at bottom.

Stock is derived from rm_boxes (in_stock boxes) — the same source as the
items grid (real package-level stock). Cost rate = procurement_materials
.last_purchase_rate.

Routes (prefix /api/inventory_mgmt/reports):
  GET  /godowns                       list godowns (for the picker)
  GET  /groups                        list material groups (for the picker)
  GET  /godown_stock?godown_id=&with_cost=
  GET  /group_stock?group_id=&with_cost=
"""

import sampling_portal
from flask import request, jsonify, session
from datetime import date


def _rep_logged_in():
    return bool(session.get("logged_in") or session.get("UID") or session.get("User_Name"))


def _table_columns(conn, table):
    """Return a set of column names for `table` (empty set on any error)."""
    try:
        rows = conn.execute("SHOW COLUMNS FROM " + table).fetchall()
        out = set()
        for r in rows:
            out.add(r["Field"] if hasattr(r, "get") else r[0])
        return out
    except Exception:
        return set()


def _expiry_expr(conn):
    """Build the SQL expiry/batch expressions for rm_boxes, tolerating installs
    where rm_boxes lacks the opening-stock columns (expiry_date / batch_num) —
    referencing a missing column would throw 'Unknown column'. Mirrors the
    agent's defensive approach so report + agent never disagree.

    Returns (expiry_expr, batch_expr). gi.* is always available via the GRN
    items join; b.* parts are only included when those columns exist."""
    bcols = _table_columns(conn, "rm_boxes")
    has_b_exp   = "expiry_date" in bcols
    has_b_batch = "batch_num"   in bcols
    expiry_expr = "COALESCE(gi.expiry_date, b.expiry_date)" if has_b_exp else "gi.expiry_date"
    batch_expr  = "COALESCE(gi.batch_num, b.batch_num)"     if has_b_batch else "gi.batch_num"
    return expiry_expr, batch_expr


# ════════════════════════════════════════════════════════════════════════
#  NOTIFICATION HELPERS (module-level so other modules — e.g. the agent —
#  can log into the same store). See the /notifications/* endpoints below.
# ════════════════════════════════════════════════════════════════════════
def ensure_notification_tables(conn):
    """Create the notification tables if they don't exist (idempotent)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS inventory_notifications (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            dedupe_key   VARCHAR(80)  NOT NULL,
            category     VARCHAR(20)  NOT NULL DEFAULT 'task',  -- task | alert | agent
            title        VARCHAR(160) NOT NULL,
            body         VARCHAR(255) DEFAULT NULL,
            count        INT          NOT NULL DEFAULT 0,
            link_key     VARCHAR(60)  DEFAULT NULL,
            severity     VARCHAR(12)  NOT NULL DEFAULT 'info',
            status       ENUM('active','resolved') NOT NULL DEFAULT 'active',
            created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
            seen_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            resolved_at  DATETIME     DEFAULT NULL,
            INDEX ix_inv_notif_status (status, seen_at),
            INDEX ix_inv_notif_key    (dedupe_key, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS inventory_notification_reads (
            notif_id  INT          NOT NULL,
            user_name VARCHAR(100) NOT NULL,
            read_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (notif_id, user_name),
            INDEX ix_inv_notifread_user (user_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.commit()


def upsert_notifications(conn, items, manage_prefixes):
    """Upsert a batch of notifications and resolve cleared ones.

    items: list of dicts/tuples with keys/positions:
        dedupe_key, category, count, title, body, link_key, severity
      Only items with count>0 create/refresh a row. (A count==0 / falsy item
      is treated as "condition absent" and lets its row resolve.)
    manage_prefixes: iterable of dedupe_key prefixes this caller OWNS. Only
      active rows whose key starts with one of these prefixes are eligible to
      be resolved here — so the agent never resolves the dashboard's rows and
      vice-versa.

    Caller is responsible for conn.commit(). Exceptions propagate.
    """
    def _f(it, key, idx):
        if isinstance(it, dict):
            return it.get(key)
        return it[idx]

    present_keys = set()
    for it in items:
        dk    = _f(it, "dedupe_key", 0)
        cat   = _f(it, "category",   1)
        cnt   = int(_f(it, "count",  2) or 0)
        title = _f(it, "title",      3)
        body  = _f(it, "body",       4)
        link  = _f(it, "link_key",   5)
        sev   = _f(it, "severity",   6) or "info"
        if cnt <= 0:
            continue
        present_keys.add(dk)
        row = conn.execute(
            "SELECT id FROM inventory_notifications "
            "WHERE dedupe_key=%s AND status='active' ORDER BY id DESC LIMIT 1",
            (dk,)).fetchone()
        if row:
            nid = row["id"] if hasattr(row, "get") else row[0]
            conn.execute(
                "UPDATE inventory_notifications "
                "SET count=%s, title=%s, body=%s, severity=%s, category=%s, "
                "    link_key=%s, seen_at=NOW() WHERE id=%s",
                (cnt, title, body, sev, cat, link, nid))
        else:
            conn.execute(
                "INSERT INTO inventory_notifications "
                "(dedupe_key, category, title, body, count, link_key, severity, status) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,'active')",
                (dk, cat, title, body, cnt, link, sev))

    # Resolve active rows we own whose condition is no longer present.
    prefixes = tuple(manage_prefixes)
    open_rows = conn.execute(
        "SELECT id, dedupe_key FROM inventory_notifications WHERE status='active'").fetchall()
    for r in open_rows:
        rid = r["id"] if hasattr(r, "get") else r[0]
        rdk = r["dedupe_key"] if hasattr(r, "get") else r[1]
        if any(rdk.startswith(p) for p in prefixes) and rdk not in present_keys:
            conn.execute(
                "UPDATE inventory_notifications "
                "SET status='resolved', resolved_at=NOW() WHERE id=%s", (rid,))


def _period():
    """Return (from, to) as YYYY-MM-DD strings. Defaults to current month."""
    today = date.today()
    d_from = request.args.get("from") or today.replace(day=1).isoformat()
    d_to = request.args.get("to") or today.isoformat()
    return d_from, d_to


def register_inventory_reports(app):
    if getattr(app, "_inventory_reports_registered", False):
        return
    app._inventory_reports_registered = True

    @app.route("/api/inventory_mgmt/reports/godowns")
    def api_rep_godowns():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT id, name, type, is_default FROM procurement_godowns "
                "ORDER BY is_default DESC, name ASC"
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "godowns": [
                {"id": int(r["id"]), "name": r["name"] or "", "type": r["type"] or "",
                 "is_default": bool(r["is_default"])} for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/reports/groups")
    def api_rep_groups():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT id, group_name FROM procurement_material_groups ORDER BY group_name ASC"
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "groups": [
                {"id": int(r["id"]), "group_name": r["group_name"] or ""} for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Movement classification for ledger reports ──────────────────────
    _INWARD = ("grn_create", "opening", "in", "adjust")
    _OUTWARD = ("out", "consume", "cancel")

    def _ledger_for_materials(conn, material_ids, d_from, d_to, godown_id=None):
        """Returns {material_id: {opening, inward, outward, closing}} from
        rm_box_movements over [d_from, d_to]. Opening = net movement before
        d_from; Inward/Outward = within window; Closing = opening+in-out."""
        if not material_ids:
            return {}
        ph = ",".join(["%s"] * len(material_ids))
        gd_clause, gd_params = "", []
        if godown_id:
            gd_clause = " AND (mv.to_godown_id=%s OR mv.from_godown_id=%s) "
            gd_params = [godown_id, godown_id]
        inward_sql = "','".join(_INWARD)
        outward_sql = "','".join(_OUTWARD)

        rows_open = conn.execute(
            f"SELECT b.material_id AS mid, "
            f"  COALESCE(SUM(CASE WHEN mv.movement_type IN ('{inward_sql}') THEN mv.qty "
            f"                    WHEN mv.movement_type IN ('{outward_sql}') THEN -mv.qty ELSE 0 END),0) AS net "
            f"FROM rm_box_movements mv JOIN rm_boxes b ON b.box_id=mv.box_id "
            f"WHERE b.material_id IN ({ph}) AND mv.movement_at < %s {gd_clause} "
            f"GROUP BY b.material_id",
            tuple(list(material_ids) + [d_from] + gd_params),
        ).fetchall()
        opening = {r["mid"]: float(r["net"] or 0) for r in rows_open}

        rows_win = conn.execute(
            f"SELECT b.material_id AS mid, "
            f"  COALESCE(SUM(CASE WHEN mv.movement_type IN ('{inward_sql}') THEN mv.qty ELSE 0 END),0) AS inq, "
            f"  COALESCE(SUM(CASE WHEN mv.movement_type IN ('{outward_sql}') THEN mv.qty ELSE 0 END),0) AS outq "
            f"FROM rm_box_movements mv JOIN rm_boxes b ON b.box_id=mv.box_id "
            f"WHERE b.material_id IN ({ph}) AND mv.movement_at >= %s "
            f"AND mv.movement_at < DATE_ADD(%s, INTERVAL 1 DAY) {gd_clause} "
            f"GROUP BY b.material_id",
            tuple(list(material_ids) + [d_from, d_to] + gd_params),
        ).fetchall()
        out = {}
        for r in rows_win:
            op = opening.get(r["mid"], 0.0)
            inq = float(r["inq"] or 0); outq = float(r["outq"] or 0)
            out[r["mid"]] = {"opening": round(op, 3), "inward": round(inq, 3),
                             "outward": round(outq, 3), "closing": round(op + inq - outq, 3)}
        for mid, op in opening.items():
            if mid not in out:
                out[mid] = {"opening": round(op, 3), "inward": 0.0, "outward": 0.0, "closing": round(op, 3)}
        return out

    # ── Report 1: Godown-wise stock ──────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/godown_stock")
    def api_rep_godown_stock():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            godown_id = int(request.args.get("godown_id") or 0)
        except (TypeError, ValueError):
            godown_id = 0
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        if not godown_id:
            return jsonify({"status": "error", "message": "godown_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            gd = conn.execute(
                "SELECT id, name FROM procurement_godowns WHERE id=%s", (godown_id,)
            ).fetchone()
            if not gd:
                conn.close(); return jsonify({"status": "error", "message": "Godown not found"}), 404

            d_from, d_to = _period()

            # Materials that have any box history at this godown (so the report
            # lists everything that moved through it, even if closing is 0).
            mrows = conn.execute(
                "SELECT DISTINCT b.material_id, m.material_name AS name, m.uom, "
                "m.last_purchase_rate AS rate, g.group_name "
                "FROM rm_boxes b "
                "LEFT JOIN procurement_materials m ON m.id=b.material_id "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "WHERE b.current_godown_id=%s OR b.box_id IN ("
                "   SELECT box_id FROM rm_box_movements WHERE to_godown_id=%s OR from_godown_id=%s) "
                "ORDER BY m.material_name ASC",
                (godown_id, godown_id, godown_id),
            ).fetchall()
            mat_meta = {r["material_id"]: dict(r) for r in mrows if r["material_id"] is not None}
            ledger = _ledger_for_materials(conn, list(mat_meta.keys()), d_from, d_to, godown_id=godown_id)

            items = []
            tot = {"opening": 0.0, "inward": 0.0, "outward": 0.0, "closing": 0.0, "value": 0.0}
            for mid, meta in mat_meta.items():
                L = ledger.get(mid, {"opening": 0, "inward": 0, "outward": 0, "closing": 0})
                # skip rows with no activity and no balance
                if not any([L["opening"], L["inward"], L["outward"], L["closing"]]):
                    continue
                rate = float(meta.get("rate") or 0)
                value = round(L["closing"] * rate, 2)
                for k in ("opening", "inward", "outward", "closing"):
                    tot[k] += L[k]
                tot["value"] += value
                row = {
                    "material_id": mid, "name": meta.get("name") or "",
                    "group": meta.get("group_name") or "", "uom": meta.get("uom") or "",
                    "opening": L["opening"], "inward": L["inward"],
                    "outward": L["outward"], "closing": L["closing"],
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["value"] = value
                items.append(row)
            items.sort(key=lambda x: x["name"])
            conn.close()
            return jsonify({
                "status": "ok", "report": "godown_stock",
                "godown": {"id": int(gd["id"]), "name": gd["name"]},
                "with_cost": with_cost, "from": d_from, "to": d_to,
                "items": items,
                "totals": {k: round(v, 3) for k, v in tot.items() if k != "value"},
                "total_value": round(tot["value"], 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 2: Group-wise stock ───────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/group_stock")
    def api_rep_group_stock():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        raw_gid = (request.args.get("group_id") or "").strip().lower()
        is_all = (raw_gid == "all")
        try:
            group_id = 0 if is_all else int(raw_gid or 0)
        except (TypeError, ValueError):
            group_id = 0
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        try:
            godown_id = int(request.args.get("godown_id") or 0)
        except (TypeError, ValueError):
            godown_id = 0
        if not is_all and not group_id:
            return jsonify({"status": "error", "message": "group_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            if is_all:
                grp = {"id": 0, "group_name": "All Groups"}
            else:
                grp = conn.execute(
                    "SELECT id, group_name FROM procurement_material_groups WHERE id=%s", (group_id,)
                ).fetchone()
                if not grp:
                    conn.close(); return jsonify({"status": "error", "message": "Group not found"}), 404

            d_from, d_to = _period()

            if is_all:
                # Every RM material.
                mrows = conn.execute(
                    "SELECT id AS material_id, material_name AS name, uom, last_purchase_rate AS rate "
                    "FROM procurement_materials ORDER BY material_name ASC"
                ).fetchall()
            else:
                # Materials in this group (and any child groups, if hierarchical).
                child_ids = [group_id]
                try:
                    kids = conn.execute(
                        "SELECT id FROM procurement_material_groups WHERE parent_id=%s", (group_id,)
                    ).fetchall()
                    child_ids += [r["id"] for r in kids]
                except Exception:
                    pass
                ph = ",".join(["%s"] * len(child_ids))
                mrows = conn.execute(
                    f"SELECT id AS material_id, material_name AS name, uom, last_purchase_rate AS rate "
                    f"FROM procurement_materials WHERE group_id IN ({ph}) ORDER BY material_name ASC",
                    tuple(child_ids),
                ).fetchall()
            mat_meta = {r["material_id"]: dict(r) for r in mrows}
            gd_name = None
            if godown_id:
                gd = conn.execute(
                    "SELECT name FROM procurement_godowns WHERE id=%s", (godown_id,)
                ).fetchone()
                gd_name = (gd["name"] if gd else None)
            ledger = _ledger_for_materials(conn, list(mat_meta.keys()), d_from, d_to,
                                           godown_id=(godown_id or None))

            items = []
            tot = {"opening": 0.0, "inward": 0.0, "outward": 0.0, "closing": 0.0, "value": 0.0}
            for mid, meta in mat_meta.items():
                L = ledger.get(mid, {"opening": 0, "inward": 0, "outward": 0, "closing": 0})
                if not any([L["opening"], L["inward"], L["outward"], L["closing"]]):
                    continue
                rate = float(meta.get("rate") or 0)
                value = round(L["closing"] * rate, 2)
                for k in ("opening", "inward", "outward", "closing"):
                    tot[k] += L[k]
                tot["value"] += value
                row = {
                    "material_id": mid, "name": meta.get("name") or "", "uom": meta.get("uom") or "",
                    "opening": L["opening"], "inward": L["inward"],
                    "outward": L["outward"], "closing": L["closing"],
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["value"] = value
                items.append(row)
            items.sort(key=lambda x: x["name"])
            conn.close()
            return jsonify({
                "status": "ok", "report": "group_stock",
                "group": {"id": int(grp["id"]), "name": grp["group_name"]},
                "godown": ({"id": godown_id, "name": gd_name or ""} if godown_id else None),
                "with_cost": with_cost, "from": d_from, "to": d_to,
                "items": items,
                "totals": {k: round(v, 3) for k, v in tot.items() if k != "value"},
                "total_value": round(tot["value"], 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Material search (for report pickers that need a material) ─────────
    @app.route("/api/inventory_mgmt/reports/material_search")
    def api_rep_material_search():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        q = (request.args.get("q") or "").strip()
        conn = sampling_portal.get_db_connection()
        try:
            if q:
                rows = conn.execute(
                    "SELECT id, material_name AS name, uom FROM procurement_materials "
                    "WHERE material_name LIKE %s ORDER BY material_name ASC LIMIT 30",
                    (f"%{q}%",),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, material_name AS name, uom FROM procurement_materials "
                    "ORDER BY material_name ASC LIMIT 30"
                ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "materials": [
                {"id": int(r["id"]), "name": r["name"] or "", "uom": r["uom"] or ""} for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 2: Movement Ledger (one material, in/out history) ─────────
    @app.route("/api/inventory_mgmt/reports/movement_ledger")
    def api_rep_movement_ledger():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            material_id = int(request.args.get("material_id") or 0)
        except (TypeError, ValueError):
            material_id = 0
        if not material_id:
            return jsonify({"status": "error", "message": "material_id required"}), 400
        d_from, d_to = _period()
        conn = sampling_portal.get_db_connection()
        try:
            mat = conn.execute(
                "SELECT id, material_name AS name, uom FROM procurement_materials WHERE id=%s",
                (material_id,),
            ).fetchone()
            if not mat:
                conn.close(); return jsonify({"status": "error", "message": "Material not found"}), 404

            inward_sql = "','".join(_INWARD)
            outward_sql = "','".join(_OUTWARD)

            # Opening balance = signed net of all movements before d_from.
            op_row = conn.execute(
                f"SELECT COALESCE(SUM(CASE WHEN mv.movement_type IN ('{inward_sql}') THEN mv.qty "
                f"  WHEN mv.movement_type IN ('{outward_sql}') THEN -mv.qty ELSE 0 END),0) AS net "
                f"FROM rm_box_movements mv JOIN rm_boxes b ON b.box_id=mv.box_id "
                f"WHERE b.material_id=%s AND mv.movement_at < %s",
                (material_id, d_from),
            ).fetchone()
            opening = float(op_row["net"] or 0)

            # Movements within the window, AGGREGATED by event
            # (timestamp + type + godown) so we show total quantity moved per
            # event rather than one row per box.
            mv = conn.execute(
                "SELECT mv.movement_at, mv.movement_type, "
                "  SUM(mv.qty) AS qty, COUNT(*) AS box_count, "
                "  fg.name AS from_godown, tg.name AS to_godown, "
                "  MAX(mv.remarks) AS remarks "
                "FROM rm_box_movements mv "
                "JOIN rm_boxes b ON b.box_id=mv.box_id "
                "LEFT JOIN procurement_godowns fg ON fg.id=mv.from_godown_id "
                "LEFT JOIN procurement_godowns tg ON tg.id=mv.to_godown_id "
                "WHERE b.material_id=%s AND mv.movement_at >= %s "
                "AND mv.movement_at < DATE_ADD(%s, INTERVAL 1 DAY) "
                "GROUP BY mv.movement_at, mv.movement_type, mv.from_godown_id, mv.to_godown_id "
                "ORDER BY mv.movement_at ASC",
                (material_id, d_from, d_to),
            ).fetchall()

            running = opening
            lines = []
            tot_in = tot_out = 0.0
            for r in mv:
                mt = r["movement_type"]
                is_in = mt in _INWARD
                qty = float(r["qty"] or 0)
                if is_in: running += qty; tot_in += qty
                elif mt in _OUTWARD: running -= qty; tot_out += qty
                lines.append({
                    "date": str(r["movement_at"])[:16],
                    "type": mt,
                    "box_count": int(r["box_count"] or 0),
                    "godown": (r["to_godown"] if is_in else r["from_godown"]) or "",
                    "in": round(qty, 3) if is_in else 0.0,
                    "out": round(qty, 3) if mt in _OUTWARD else 0.0,
                    "balance": round(running, 3),
                    "remarks": r["remarks"] or "",
                })
            conn.close()
            return jsonify({
                "status": "ok", "report": "movement_ledger",
                "material": {"id": int(mat["id"]), "name": mat["name"], "uom": mat["uom"] or ""},
                "from": d_from, "to": d_to,
                "opening": round(opening, 3),
                "lines": lines,
                "total_in": round(tot_in, 3), "total_out": round(tot_out, 3),
                "closing": round(running, 3),
                "line_count": len(lines),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 3: Audit Variance ─────────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/audit_sessions")
    def api_rep_audit_sessions():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT s.session_id, s.session_no, s.status, s.created_at, "
                "g.name AS godown_name "
                "FROM inventory_audit_sessions s "
                "LEFT JOIN procurement_godowns g ON g.id=s.godown_id "
                "ORDER BY s.session_id DESC LIMIT 200"
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "sessions": [
                {"id": int(r["session_id"]), "session_no": r["session_no"] or "",
                 "status": r["status"] or "", "godown_name": r["godown_name"] or "",
                 "created_at": str(r["created_at"])[:16] if r["created_at"] else ""}
                for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/reports/audit_variance")
    def api_rep_audit_variance():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            sid = int(request.args.get("session_id") or 0)
        except (TypeError, ValueError):
            sid = 0
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        if not sid:
            return jsonify({"status": "error", "message": "session_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            s = conn.execute(
                "SELECT s.*, g.name AS godown_name FROM inventory_audit_sessions s "
                "LEFT JOIN procurement_godowns g ON g.id=s.godown_id WHERE s.session_id=%s",
                (sid,),
            ).fetchone()
            if not s:
                conn.close(); return jsonify({"status": "error", "message": "Session not found"}), 404
            godown_id = s["godown_id"]

            # scoped materials (empty = whole godown)
            mat_ids = [r["material_id"] for r in conn.execute(
                "SELECT material_id FROM inventory_audit_materials WHERE session_id=%s", (sid,)
            ).fetchall()]

            # expected = in_stock boxes at godown for scoped materials
            if mat_ids:
                ph = ",".join(["%s"] * len(mat_ids))
                exp = conn.execute(
                    f"SELECT b.box_code, b.material_id, b.per_box_qty AS qty, m.material_name AS name, "
                    f"m.last_purchase_rate AS rate "
                    f"FROM rm_boxes b LEFT JOIN procurement_materials m ON m.id=b.material_id "
                    f"WHERE b.current_status='in_stock' AND b.current_godown_id=%s AND b.material_id IN ({ph})",
                    tuple([godown_id] + mat_ids),
                ).fetchall()
            else:
                exp = conn.execute(
                    "SELECT b.box_code, b.material_id, b.per_box_qty AS qty, m.material_name AS name, "
                    "m.last_purchase_rate AS rate "
                    "FROM rm_boxes b LEFT JOIN procurement_materials m ON m.id=b.material_id "
                    "WHERE b.current_status='in_stock' AND b.current_godown_id=%s",
                    (godown_id,),
                ).fetchall()
            exp_by_code = {r["box_code"]: dict(r) for r in exp}

            scans = conn.execute(
                "SELECT box_code, material_id, qty FROM inventory_audit_scans WHERE session_id=%s", (sid,)
            ).fetchall()
            scanned = {r["box_code"]: dict(r) for r in scans}

            # per-material aggregation
            mat = {}
            def _m(mid, name="", rate=0.0):
                d = mat.setdefault(mid, {"material_id": mid, "name": name, "rate": float(rate or 0),
                                         "exp_box": 0, "exp_qty": 0.0, "cnt_box": 0, "cnt_qty": 0.0})
                if name and not d["name"]: d["name"] = name
                if rate and not d["rate"]: d["rate"] = float(rate or 0)
                return d
            for r in exp:
                d = _m(r["material_id"], r["name"] or "", r["rate"]); d["exp_box"] += 1; d["exp_qty"] += float(r["qty"] or 0)
            for code, sc in scanned.items():
                d = _m(sc.get("material_id"), exp_by_code.get(code, {}).get("name", ""),
                       exp_by_code.get(code, {}).get("rate", 0))
                d["cnt_box"] += 1; d["cnt_qty"] += float(sc.get("qty") or 0)

            items = []
            tot = {"exp_box": 0, "cnt_box": 0, "var_qty": 0.0, "var_value": 0.0}
            for d in mat.values():
                var_box = d["cnt_box"] - d["exp_box"]
                var_qty = round(d["cnt_qty"] - d["exp_qty"], 3)
                var_value = round(var_qty * d["rate"], 2)
                tot["exp_box"] += d["exp_box"]; tot["cnt_box"] += d["cnt_box"]
                tot["var_qty"] += var_qty; tot["var_value"] += var_value
                row = {
                    "name": d["name"] or "(unknown)",
                    "exp_box": d["exp_box"], "cnt_box": d["cnt_box"], "var_box": var_box,
                    "exp_qty": round(d["exp_qty"], 3), "cnt_qty": round(d["cnt_qty"], 3),
                    "var_qty": var_qty,
                }
                if with_cost:
                    row["rate"] = round(d["rate"], 2); row["var_value"] = var_value
                items.append(row)
            items.sort(key=lambda x: (0 if x["var_box"] != 0 else 1, x["name"]))

            missing = [exp_by_code[c]["box_code"] for c in exp_by_code if c not in scanned]
            extra = [c for c in scanned if c not in exp_by_code]
            conn.close()
            return jsonify({
                "status": "ok", "report": "audit_variance",
                "session": {"id": sid, "session_no": s["session_no"], "status": s["status"],
                            "godown": s["godown_name"] or "",
                            "settled_by": s["settled_by"] or "", "settled_at": str(s["settled_at"])[:16] if s["settled_at"] else ""},
                "with_cost": with_cost,
                "items": items,
                "missing": missing, "extra": extra,
                "counts": {"expected_boxes": len(exp_by_code), "counted_boxes": len(scanned),
                           "missing_boxes": len(missing), "extra_boxes": len(extra)},
                "totals": {"exp_box": tot["exp_box"], "cnt_box": tot["cnt_box"],
                           "var_qty": round(tot["var_qty"], 3)},
                "total_var_value": round(tot["var_value"], 2) if with_cost else None,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 4: Non-Moving Stock ───────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/non_moving")
    def api_rep_non_moving():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            days = int(request.args.get("days") or 90)
        except (TypeError, ValueError):
            days = 90
        if days < 1:
            days = 90
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            outward_sql = "','".join(_OUTWARD)
            # Materials with current in_stock, plus their last OUTWARD movement
            # date (NULL if never). Non-moving = no outward within `days`.
            rows = conn.execute(
                f"SELECT b.material_id, m.material_name AS name, m.uom, "
                f"m.last_purchase_rate AS rate, g.group_name, "
                f"COALESCE(SUM(b.per_box_qty),0) AS qty, "
                f"(SELECT MAX(mv.movement_at) FROM rm_box_movements mv "
                f"   JOIN rm_boxes bb ON bb.box_id=mv.box_id "
                f"   WHERE bb.material_id=b.material_id "
                f"     AND mv.movement_type IN ('{outward_sql}')) AS last_out "
                f"FROM rm_boxes b "
                f"LEFT JOIN procurement_materials m ON m.id=b.material_id "
                f"LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                f"WHERE b.current_status='in_stock' "
                f"GROUP BY b.material_id "
                f"HAVING qty > 0",
            ).fetchall()

            from datetime import datetime, timedelta
            cutoff = datetime.now() - timedelta(days=days)
            items = []
            total_qty = total_value = 0.0
            for r in rows:
                last_out = r["last_out"]
                # Non-moving if never went out, or last outward older than cutoff
                if last_out is not None:
                    try:
                        lo = last_out if isinstance(last_out, datetime) else datetime.fromisoformat(str(last_out))
                    except Exception:
                        lo = None
                    if lo is not None and lo >= cutoff:
                        continue  # moved recently → skip
                    idle_days = (datetime.now() - lo).days if lo else None
                else:
                    idle_days = None  # never moved out
                qty = float(r["qty"] or 0)
                rate = float(r["rate"] or 0)
                value = round(qty * rate, 2)
                total_qty += qty; total_value += value
                row = {
                    "name": r["name"] or "", "group": r["group_name"] or "",
                    "uom": r["uom"] or "", "qty": round(qty, 3),
                    "last_out": str(last_out)[:10] if last_out else "",
                    "idle_days": idle_days,
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["value"] = value
                items.append(row)
            # most idle first (never-moved on top, then longest idle)
            items.sort(key=lambda x: (x["idle_days"] is not None, x["idle_days"] or 10**9), reverse=True)
            conn.close()
            return jsonify({
                "status": "ok", "report": "non_moving", "days": days,
                "with_cost": with_cost, "items": items,
                "total_qty": round(total_qty, 3),
                "total_value": round(total_value, 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 5: Expiry / FEFO ──────────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/expiry")
    def api_rep_expiry():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            days = int(request.args.get("days") or 60)
        except (TypeError, ValueError):
            days = 60
        if days < 0:
            days = 60
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        include_expired = (request.args.get("expired") or "1").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            # in_stock boxes joined to their GRN item's expiry/batch. Group by
            # material + batch + expiry so multiple boxes of the same batch
            # collapse into one line with summed qty and box count.
            #
            # Expiry source: COALESCE(gi.expiry_date, b.expiry_date) — GRN boxes
            # carry expiry on their GRN item, but OPENING-STOCK boxes (source=
            # 'opening', grn_item_id NULL) store expiry directly on rm_boxes.
            # Using only gi.expiry_date silently dropped every opening-stock box
            # from this report even though the agent counted them. Batch is
            # coalesced the same way. The expressions are built defensively so
            # an install whose rm_boxes lacks the opening-stock columns doesn't
            # error out. (Matches inventory_agent._check_expiry.)
            exp_e, bat_e = _expiry_expr(conn)
            rows = conn.execute(
                "SELECT b.material_id, m.material_name AS name, m.uom, "
                "m.last_purchase_rate AS rate, g.group_name, "
                f"{bat_e} AS batch_num, "
                f"{exp_e} AS expiry_date, "
                "COUNT(*) AS box_count, COALESCE(SUM(b.per_box_qty),0) AS qty, "
                # Navigation hints: where this batch's expiry was recorded.
                "MAX(b.source) AS src, MAX(b.grn_no) AS grn_no, "
                "MAX(b.grn_id) AS grn_id, MAX(b.grn_item_id) AS grn_item_id, "
                "GROUP_CONCAT(b.box_id) AS box_ids "
                "FROM rm_boxes b "
                "LEFT JOIN procurement_materials m ON m.id=b.material_id "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                "WHERE b.current_status='in_stock' "
                f"AND {exp_e} IS NOT NULL "
                f"GROUP BY b.material_id, {bat_e}, {exp_e} "
                f"ORDER BY {exp_e} ASC",
            ).fetchall()

            from datetime import datetime, date, timedelta
            today = date.today()
            cutoff = today + timedelta(days=days)
            items = []
            total_qty = total_value = 0.0
            for r in rows:
                exp = r["expiry_date"]
                if exp is None:
                    continue
                try:
                    ed = exp if isinstance(exp, date) and not isinstance(exp, datetime) else (
                        exp.date() if isinstance(exp, datetime) else datetime.fromisoformat(str(exp)).date())
                except Exception:
                    continue
                is_expired = ed < today
                if is_expired and not include_expired:
                    continue
                if ed > cutoff:
                    continue  # not near expiry yet
                days_left = (ed - today).days
                qty = float(r["qty"] or 0)
                rate = float(r["rate"] or 0)
                value = round(qty * rate, 2)
                total_qty += qty; total_value += value
                # Source-aware navigation target. GRN boxes link to their GRN;
                # opening-stock boxes link to the opening-stock entry (via its
                # box ids). 'src' may be 'opening', 'grn', or null (legacy) — we
                # treat "has grn_no/grn_item_id" as GRN, else opening.
                src = (r["src"] or "").lower() if r["src"] is not None else ""
                grn_no = r["grn_no"]
                grn_item_id = r["grn_item_id"]
                bids_raw = r["box_ids"] or ""
                try:
                    box_ids = [int(x) for x in str(bids_raw).split(",") if str(x).strip()]
                except Exception:
                    box_ids = []
                is_grn = bool(grn_no or grn_item_id) and src != "opening"
                row = {
                    "name": r["name"] or "", "group": r["group_name"] or "",
                    "uom": r["uom"] or "", "batch": r["batch_num"] or "",
                    "expiry": ed.isoformat(), "days_left": days_left,
                    "expired": is_expired,
                    "box_count": int(r["box_count"] or 0), "qty": round(qty, 3),
                    "material_id": int(r["material_id"]) if r["material_id"] is not None else None,
                    "source": "grn" if is_grn else "opening",
                    "grn_no": grn_no or "",
                    "grn_id": int(r["grn_id"]) if r["grn_id"] is not None else None,
                    "box_ids": box_ids,
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["value"] = value
                items.append(row)
            conn.close()
            return jsonify({
                "status": "ok", "report": "expiry", "days": days,
                "with_cost": with_cost, "items": items,
                "total_qty": round(total_qty, 3),
                "total_value": round(total_value, 2) if with_cost else None,
                "item_count": len(items),
                "expired_count": sum(1 for x in items if x["expired"]),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 6: Negative / Zero Stock ──────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/neg_zero")
    def api_rep_neg_zero():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        # which buckets to include
        want = (request.args.get("show") or "both").lower()  # 'neg' | 'zero' | 'both'
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            # Per-material box stock (sum of in_stock boxes). LEFT JOIN so
            # materials with no boxes show as zero. Only materials that are
            # "tracked" (have an MSL set) are considered for the zero bucket,
            # to avoid listing the entire catalog; negatives always shown.
            rows = conn.execute(
                "SELECT m.id AS material_id, m.material_name AS name, m.uom, "
                "m.msl, m.last_purchase_rate AS rate, g.group_name, "
                "COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "          WHERE b.material_id=m.id AND b.current_status='in_stock'),0) AS qty "
                "FROM procurement_materials m "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "ORDER BY m.material_name ASC",
            ).fetchall()

            items = []
            neg_n = zero_n = 0
            total_value = 0.0
            for r in rows:
                qty = float(r["qty"] or 0)
                msl = float(r["msl"] or 0)
                if qty < 0:
                    bucket = "negative"
                elif qty == 0 and msl > 0:
                    bucket = "zero"
                else:
                    continue
                if want == "neg" and bucket != "negative":
                    continue
                if want == "zero" and bucket != "zero":
                    continue
                if bucket == "negative": neg_n += 1
                else: zero_n += 1
                rate = float(r["rate"] or 0)
                value = round(qty * rate, 2)
                total_value += value
                row = {
                    "name": r["name"] or "", "group": r["group_name"] or "",
                    "uom": r["uom"] or "", "qty": round(qty, 3),
                    "msl": round(msl, 3), "bucket": bucket,
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["value"] = value
                items.append(row)
            # negatives first (errors), then zeros
            items.sort(key=lambda x: (0 if x["bucket"] == "negative" else 1, x["name"]))
            conn.close()
            return jsonify({
                "status": "ok", "report": "neg_zero", "show": want,
                "with_cost": with_cost, "items": items,
                "neg_count": neg_n, "zero_count": zero_n,
                "total_value": round(total_value, 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 7: Reorder (Below MSL) ────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/reorder")
    def api_rep_reorder():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            # Materials with an MSL set whose current box-stock is <= MSL.
            # shortfall = MSL - stock (how much to order to reach MSL).
            rows = conn.execute(
                "SELECT m.id AS material_id, m.material_name AS name, m.uom, "
                "m.msl, m.last_purchase_rate AS rate, m.supplier_name, g.group_name, "
                "COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "          WHERE b.material_id=m.id AND b.current_status='in_stock'),0) AS qty "
                "FROM procurement_materials m "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "WHERE m.msl IS NOT NULL AND m.msl > 0 "
                "ORDER BY m.material_name ASC",
            ).fetchall()

            items = []
            total_shortfall_value = 0.0
            for r in rows:
                qty = float(r["qty"] or 0)
                msl = float(r["msl"] or 0)
                if qty > msl:
                    continue  # at/above MSL → not a reorder candidate
                shortfall = round(msl - qty, 3)
                rate = float(r["rate"] or 0)
                order_value = round(shortfall * rate, 2)
                total_shortfall_value += order_value
                row = {
                    "name": r["name"] or "", "group": r["group_name"] or "",
                    "uom": r["uom"] or "", "supplier": r["supplier_name"] or "",
                    "qty": round(qty, 3), "msl": round(msl, 3),
                    "shortfall": shortfall,
                    "is_zero": qty <= 0,
                }
                if with_cost:
                    row["rate"] = round(rate, 2); row["order_value"] = order_value
                items.append(row)
            # biggest shortfall first
            items.sort(key=lambda x: x["shortfall"], reverse=True)
            conn.close()
            return jsonify({
                "status": "ok", "report": "reorder",
                "with_cost": with_cost, "items": items,
                "total_shortfall_value": round(total_shortfall_value, 2) if with_cost else None,
                "item_count": len(items),
                "zero_count": sum(1 for x in items if x["is_zero"]),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 8: GRN Register ───────────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/grn_register")
    def api_rep_grn_register():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d_from, d_to = _period()
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            # GRN headers in the period (exclude REJOUT/non-GRN vouchers), with
            # per-GRN line count, total received qty and total value from items.
            rows = conn.execute(
                "SELECT h.id, h.grn_num, h.grn_date, h.supplier_name, h.invoice_num, "
                "COUNT(i.id) AS line_count, "
                "COALESCE(SUM(i.received_qty),0) AS total_qty, "
                "COALESCE(SUM(i.amount),0) AS total_value "
                "FROM procurement_grn h "
                "LEFT JOIN procurement_grn_items i ON i.grn_id=h.id "
                "WHERE (h.grn_type IS NULL OR h.grn_type='GRN' OR h.grn_type='') "
                "AND h.grn_date >= %s AND h.grn_date < DATE_ADD(%s, INTERVAL 1 DAY) "
                "GROUP BY h.id "
                "ORDER BY h.grn_date ASC, h.id ASC",
                (d_from, d_to),
            ).fetchall()

            items = []
            grand_value = 0.0
            for r in rows:
                tv = float(r["total_value"] or 0)
                grand_value += tv
                # fetch line items for this GRN
                lines = conn.execute(
                    "SELECT material, received_qty, uom, batch_num, rate, amount "
                    "FROM procurement_grn_items WHERE grn_id=%s ORDER BY id ASC",
                    (r["id"],),
                ).fetchall()
                line_items = []
                for li in lines:
                    d = {
                        "material": li["material"] or "",
                        "qty": round(float(li["received_qty"] or 0), 3),
                        "uom": li["uom"] or "",
                        "batch": li["batch_num"] or "",
                    }
                    if with_cost:
                        d["rate"] = round(float(li["rate"] or 0), 2)
                        d["amount"] = round(float(li["amount"] or 0), 2)
                    line_items.append(d)
                row = {
                    "id": int(r["id"]),
                    "grn_num": r["grn_num"] or "",
                    "grn_date": str(r["grn_date"])[:10] if r["grn_date"] else "",
                    "supplier": r["supplier_name"] or "",
                    "invoice_num": r["invoice_num"] or "",
                    "line_count": int(r["line_count"] or 0),
                    "total_qty": round(float(r["total_qty"] or 0), 3),
                    "lines": line_items,
                }
                if with_cost:
                    row["total_value"] = round(tv, 2)
                items.append(row)
            conn.close()
            return jsonify({
                "status": "ok", "report": "grn_register",
                "from": d_from, "to": d_to, "with_cost": with_cost,
                "items": items,
                "grand_value": round(grand_value, 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 9: Delivery Register ──────────────────────────────────────
    @app.route("/api/inventory_mgmt/reports/dn_register")
    def api_rep_dn_register():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d_from, d_to = _period()
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT h.id, h.dn_no, h.dn_date, h.supplier_name, h.reason, h.status, "
                "g.name AS godown_name, "
                "COUNT(i.id) AS line_count, "
                "COALESCE(SUM(i.qty_delivered),0) AS total_qty, "
                "COALESCE(SUM(i.no_of_box),0) AS total_box "
                "FROM inventory_dn h "
                "LEFT JOIN inventory_dn_items i ON i.dn_id=h.id "
                "LEFT JOIN procurement_godowns g ON g.id=h.godown_id "
                "WHERE h.dn_date >= %s AND h.dn_date < DATE_ADD(%s, INTERVAL 1 DAY) "
                "GROUP BY h.id ORDER BY h.dn_date ASC, h.id ASC",
                (d_from, d_to),
            ).fetchall()

            items = []
            grand_value = 0.0
            for r in rows:
                lines = conn.execute(
                    "SELECT di.qty_delivered, di.no_of_box, di.remarks, "
                    "m.material_name AS name, m.uom, m.last_purchase_rate AS rate "
                    "FROM inventory_dn_items di "
                    "LEFT JOIN procurement_materials m ON m.id=di.material_id "
                    "WHERE di.dn_id=%s ORDER BY di.id ASC",
                    (r["id"],),
                ).fetchall()
                line_items = []
                dn_value = 0.0
                for li in lines:
                    qd = float(li["qty_delivered"] or 0)
                    rate = float(li["rate"] or 0)
                    amt = round(qd * rate, 2)
                    dn_value += amt
                    d = {"material": li["name"] or "", "uom": li["uom"] or "",
                         "qty": round(qd, 3), "boxes": int(li["no_of_box"] or 0)}
                    if with_cost:
                        d["rate"] = round(rate, 2); d["amount"] = amt
                    line_items.append(d)
                grand_value += dn_value
                row = {
                    "id": int(r["id"]),
                    "dn_no": r["dn_no"] or "",
                    "dn_date": str(r["dn_date"])[:10] if r["dn_date"] else "",
                    "supplier": r["supplier_name"] or "",
                    "godown": r["godown_name"] or "",
                    "reason": r["reason"] or "",
                    "status": r["status"] or "",
                    "line_count": int(r["line_count"] or 0),
                    "total_qty": round(float(r["total_qty"] or 0), 3),
                    "total_box": int(r["total_box"] or 0),
                    "lines": line_items,
                }
                if with_cost:
                    row["dn_value"] = round(dn_value, 2)
                items.append(row)
            conn.close()
            return jsonify({
                "status": "ok", "report": "dn_register",
                "from": d_from, "to": d_to, "with_cost": with_cost,
                "items": items,
                "grand_value": round(grand_value, 2) if with_cost else None,
                "item_count": len(items),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report 10: Transfer Register (full + simple) ─────────────────────
    @app.route("/api/inventory_mgmt/reports/transfer_register")
    def api_rep_transfer_register():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        d_from, d_to = _period()
        conn = sampling_portal.get_db_connection()
        try:
            # godown id→name map for resolving from/to
            gmap = {}
            try:
                for g in conn.execute("SELECT id, name FROM procurement_godowns").fetchall():
                    gmap[int(g["id"])] = g["name"] or ""
            except Exception:
                pass

            rows = []
            # Full transfers
            try:
                fr = conn.execute(
                    "SELECT transfer_no, transfer_date, from_godown_id, to_godown_id, "
                    "status, total_boxes, total_qty "
                    "FROM rm_stock_transfers "
                    "WHERE transfer_date >= %s AND transfer_date < DATE_ADD(%s, INTERVAL 1 DAY) "
                    "ORDER BY transfer_date ASC, transfer_id ASC",
                    (d_from, d_to),
                ).fetchall()
                for r in fr:
                    rows.append({
                        "type": "Full", "voucher_no": r["transfer_no"] or "",
                        "date": str(r["transfer_date"])[:10] if r["transfer_date"] else "",
                        "from": gmap.get(int(r["from_godown_id"] or 0), ""),
                        "to": gmap.get(int(r["to_godown_id"] or 0), ""),
                        "status": r["status"] or "",
                        "boxes": int(r["total_boxes"] or 0),
                        "qty": round(float(r["total_qty"] or 0), 3),
                    })
            except Exception:
                pass
            # Simple transfers
            try:
                sr = conn.execute(
                    "SELECT voucher_no, voucher_date, from_godown_id, to_godown_id, "
                    "status, total_pkgs, total_qty "
                    "FROM rm_simple_transfers "
                    "WHERE voucher_date >= %s AND voucher_date < DATE_ADD(%s, INTERVAL 1 DAY) "
                    "ORDER BY voucher_date ASC, voucher_id ASC",
                    (d_from, d_to),
                ).fetchall()
                for r in sr:
                    rows.append({
                        "type": "Simple", "voucher_no": r["voucher_no"] or "",
                        "date": str(r["voucher_date"])[:10] if r["voucher_date"] else "",
                        "from": gmap.get(int(r["from_godown_id"] or 0), ""),
                        "to": gmap.get(int(r["to_godown_id"] or 0), ""),
                        "status": r["status"] or "",
                        "boxes": int(r["total_pkgs"] or 0),
                        "qty": round(float(r["total_qty"] or 0), 3),
                    })
            except Exception:
                pass

            rows.sort(key=lambda x: (x["date"], x["voucher_no"]))
            total_qty = round(sum(x["qty"] for x in rows), 3)
            total_boxes = sum(x["boxes"] for x in rows)
            conn.close()
            return jsonify({
                "status": "ok", "report": "transfer_register",
                "from": d_from, "to": d_to,
                "items": rows, "item_count": len(rows),
                "total_qty": total_qty, "total_boxes": total_boxes,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report: Item Stock Card (one material, all godowns) ──────────────
    # Shows, for a single material, the in-stock quantity broken down by
    # godown (box count + qty), plus the period movement ledger (opening /
    # inward / outward / closing) across all godowns for context.
    @app.route("/api/inventory_mgmt/reports/stock_card")
    def api_rep_stock_card():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        try:
            material_id = int(request.args.get("material_id") or 0)
        except (TypeError, ValueError):
            material_id = 0
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        if not material_id:
            return jsonify({"status": "error", "message": "material_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            m = conn.execute(
                "SELECT m.id, m.material_name AS name, m.uom, m.msl, "
                "m.last_purchase_rate AS rate, g.group_name "
                "FROM procurement_materials m "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "WHERE m.id=%s", (material_id,)
            ).fetchone()
            if not m:
                conn.close(); return jsonify({"status": "error", "message": "Material not found"}), 404

            d_from, d_to = _period()

            # Per-godown in_stock breakdown for this material.
            rows = conn.execute(
                "SELECT b.current_godown_id AS gid, gd.name AS godown_name, "
                "COUNT(*) AS box_count, COALESCE(SUM(b.per_box_qty),0) AS qty "
                "FROM rm_boxes b "
                "LEFT JOIN procurement_godowns gd ON gd.id=b.current_godown_id "
                "WHERE b.material_id=%s AND b.current_status='in_stock' "
                "GROUP BY b.current_godown_id "
                "ORDER BY gd.name ASC",
                (material_id,),
            ).fetchall()
            rate = float(m["rate"] or 0)
            locations = []
            tot_boxes = 0
            tot_qty = 0.0
            for r in rows:
                qty = float(r["qty"] or 0)
                bc = int(r["box_count"] or 0)
                tot_boxes += bc; tot_qty += qty
                loc = {
                    "godown_id": int(r["gid"]) if r["gid"] is not None else 0,
                    "godown": r["godown_name"] or "(unassigned)",
                    "box_count": bc, "qty": round(qty, 3),
                }
                if with_cost:
                    loc["value"] = round(qty * rate, 2)
                locations.append(loc)

            # Period movement ledger (all godowns) for opening/in/out/closing.
            led = _ledger_for_materials(conn, [material_id], d_from, d_to).get(
                material_id, {"opening": 0, "inward": 0, "outward": 0, "closing": 0})

            conn.close()
            return jsonify({
                "status": "ok", "report": "stock_card",
                "material": {
                    "id": int(m["id"]), "name": m["name"] or "",
                    "uom": m["uom"] or "", "group": m["group_name"] or "",
                    "msl": round(float(m["msl"] or 0), 3),
                },
                "with_cost": with_cost, "from": d_from, "to": d_to,
                "locations": locations,
                "ledger": {k: round(float(led[k]), 3) for k in ("opening", "inward", "outward", "closing")},
                "total_boxes": tot_boxes, "total_qty": round(tot_qty, 3),
                "rate": round(rate, 2) if with_cost else None,
                "total_value": round(tot_qty * rate, 2) if with_cost else None,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report: Box List (all active boxes / labels) ─────────────────────
    # One row per physical box. Defaults to in_stock; ?status= widens it.
    # Optional ?godown_id= and ?material_id= filters.
    @app.route("/api/inventory_mgmt/reports/box_list")
    def api_rep_box_list():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        status = (request.args.get("status") or "in_stock").strip().lower()
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        try:
            godown_id = int(request.args.get("godown_id") or 0)
        except (TypeError, ValueError):
            godown_id = 0
        try:
            material_id = int(request.args.get("material_id") or 0)
        except (TypeError, ValueError):
            material_id = 0
        conn = sampling_portal.get_db_connection()
        try:
            where = []
            params = []
            valid_status = {"in_stock", "in_transit", "consumed",
                            "damaged", "lost", "cancelled"}
            if status and status != "all":
                if status not in valid_status:
                    status = "in_stock"
                where.append("b.current_status=%s"); params.append(status)
            if godown_id:
                where.append("b.current_godown_id=%s"); params.append(godown_id)
            if material_id:
                where.append("b.material_id=%s"); params.append(material_id)
            sql_where = (" WHERE " + " AND ".join(where)) if where else ""

            _le, _lb = _expiry_expr(conn)
            rows = conn.execute(
                "SELECT b.box_id, b.box_code, b.material_id, m.material_name AS name, "
                "b.uom, b.per_box_qty AS qty, b.current_status, "
                "b.current_godown_id, gd.name AS godown_name, "
                "b.grn_no, b.source, b.created_at, m.last_purchase_rate AS rate, "
                f"{_lb} AS batch_num, "
                f"{_le} AS expiry_date "
                "FROM rm_boxes b "
                "LEFT JOIN procurement_materials m ON m.id=b.material_id "
                "LEFT JOIN procurement_godowns gd ON gd.id=b.current_godown_id "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                f"{sql_where} "
                "ORDER BY b.created_at DESC, b.box_id DESC "
                "LIMIT 5000",
                tuple(params),
            ).fetchall()

            items = []
            tot_qty = 0.0
            tot_value = 0.0
            for r in rows:
                qty = float(r["qty"] or 0)
                rate = float(r["rate"] or 0)
                tot_qty += qty
                exp = r["expiry_date"]
                row = {
                    "box_id": int(r["box_id"]), "box_code": r["box_code"] or "",
                    "material": r["name"] or "", "uom": r["uom"] or "",
                    "qty": round(qty, 3), "status": r["current_status"] or "",
                    "godown": r["godown_name"] or "(unassigned)",
                    "grn_no": r["grn_no"] or "", "source": r["source"] or "",
                    "batch": r["batch_num"] or "",
                    "expiry": str(exp)[:10] if exp else "",
                    "created_at": str(r["created_at"])[:10] if r["created_at"] else "",
                }
                if with_cost:
                    val = round(qty * rate, 2)
                    tot_value += val
                    row["rate"] = round(rate, 2); row["value"] = val
                items.append(row)
            conn.close()
            return jsonify({
                "status": "ok", "report": "box_list",
                "status_filter": status, "with_cost": with_cost,
                "items": items, "item_count": len(items),
                "total_qty": round(tot_qty, 3),
                "total_value": round(tot_value, 2) if with_cost else None,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report: Stock Ageing (how long in_stock boxes have sat) ──────────
    # Buckets each in_stock box by age (days since created_at) into bands.
    @app.route("/api/inventory_mgmt/reports/ageing")
    def api_rep_ageing():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        conn = sampling_portal.get_db_connection()
        try:
            from datetime import datetime, date as _date
            # Age bands (days): 0-30, 31-60, 61-90, 91-180, 180+
            BANDS = [(0, 30, "0–30"), (31, 60, "31–60"),
                     (61, 90, "61–90"), (91, 180, "91–180"),
                     (181, 10 ** 9, "180+")]

            rows = conn.execute(
                "SELECT b.material_id, m.material_name AS name, m.uom, g.group_name, "
                "m.last_purchase_rate AS rate, b.per_box_qty AS qty, b.created_at "
                "FROM rm_boxes b "
                "LEFT JOIN procurement_materials m ON m.id=b.material_id "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "WHERE b.current_status='in_stock'",
            ).fetchall()

            today = _date.today()

            def _age_days(created):
                if not created:
                    return 0
                try:
                    if isinstance(created, datetime):
                        cd = created.date()
                    elif isinstance(created, _date):
                        cd = created
                    else:
                        cd = datetime.fromisoformat(str(created)[:19]).date()
                except Exception:
                    return 0
                return max(0, (today - cd).days)

            def _band(days):
                for lo, hi, label in BANDS:
                    if lo <= days <= hi:
                        return label
                return BANDS[-1][2]

            # Aggregate per material × band.
            agg = {}
            band_tot = {b[2]: {"qty": 0.0, "value": 0.0, "boxes": 0} for b in BANDS}
            for r in rows:
                mid = r["material_id"]
                if mid is None:
                    continue
                days = _age_days(r["created_at"])
                band = _band(days)
                qty = float(r["qty"] or 0)
                rate = float(r["rate"] or 0)
                value = round(qty * rate, 2)
                key = mid
                if key not in agg:
                    agg[key] = {
                        "name": r["name"] or "", "group": r["group_name"] or "",
                        "uom": r["uom"] or "", "rate": round(rate, 2),
                        "bands": {b[2]: {"qty": 0.0, "boxes": 0, "value": 0.0} for b in BANDS},
                        "total_qty": 0.0, "total_value": 0.0, "total_boxes": 0,
                        "max_age": 0,
                    }
                a = agg[key]
                a["bands"][band]["qty"] += qty
                a["bands"][band]["boxes"] += 1
                a["bands"][band]["value"] += value
                a["total_qty"] += qty
                a["total_value"] += value
                a["total_boxes"] += 1
                if days > a["max_age"]:
                    a["max_age"] = days
                band_tot[band]["qty"] += qty
                band_tot[band]["value"] += value
                band_tot[band]["boxes"] += 1

            items = []
            for a in agg.values():
                for b in a["bands"].values():
                    b["qty"] = round(b["qty"], 3); b["value"] = round(b["value"], 2)
                a["total_qty"] = round(a["total_qty"], 3)
                a["total_value"] = round(a["total_value"], 2)
                items.append(a)
            items.sort(key=lambda x: (-x["max_age"], x["name"]))
            for b in band_tot.values():
                b["qty"] = round(b["qty"], 3); b["value"] = round(b["value"], 2)

            conn.close()
            return jsonify({
                "status": "ok", "report": "ageing",
                "with_cost": with_cost,
                "bands": [b[2] for b in BANDS],
                "items": items, "item_count": len(items),
                "band_totals": band_tot,
                "grand_qty": round(sum(x["total_qty"] for x in items), 3),
                "grand_value": round(sum(x["total_value"] for x in items), 2) if with_cost else None,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report: ABC Analysis (rank materials by closing-stock value) ─────
    # A = top 80% of cumulative value, B = next 15%, C = last 5%.
    @app.route("/api/inventory_mgmt/reports/abc")
    def api_rep_abc():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT m.id AS material_id, m.material_name AS name, m.uom, "
                "g.group_name, m.last_purchase_rate AS rate, "
                "COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "          WHERE b.material_id=m.id AND b.current_status='in_stock'),0) AS qty "
                "FROM procurement_materials m "
                "LEFT JOIN procurement_material_groups g ON g.id=m.group_id "
                "ORDER BY m.material_name ASC",
            ).fetchall()

            scored = []
            grand = 0.0
            for r in rows:
                qty = float(r["qty"] or 0)
                rate = float(r["rate"] or 0)
                value = round(qty * rate, 2)
                if value <= 0:
                    continue  # no stock value → not ranked
                grand += value
                scored.append({
                    "material_id": int(r["material_id"]),
                    "name": r["name"] or "", "group": r["group_name"] or "",
                    "uom": r["uom"] or "", "qty": round(qty, 3),
                    "rate": round(rate, 2), "value": value,
                })
            scored.sort(key=lambda x: -x["value"])

            cum = 0.0
            counts = {"A": 0, "B": 0, "C": 0}
            values = {"A": 0.0, "B": 0.0, "C": 0.0}
            for it in scored:
                # Class is decided by the cumulative % BEFORE this item is added,
                # so the first (largest) item is always A even if it alone
                # exceeds 80% of total value. Standard Pareto ABC convention.
                pct_before = (cum / grand * 100.0) if grand > 0 else 0.0
                cls = "A" if pct_before < 80.0 else ("B" if pct_before < 95.0 else "C")
                cum += it["value"]
                pct_after = (cum / grand * 100.0) if grand > 0 else 0.0
                it["cum_pct"] = round(pct_after, 2)
                it["value_pct"] = round((it["value"] / grand * 100.0) if grand > 0 else 0.0, 2)
                it["class"] = cls
                counts[cls] += 1
                values[cls] += it["value"]

            conn.close()
            return jsonify({
                "status": "ok", "report": "abc",
                "basis": "closing_stock_value",
                "items": scored, "item_count": len(scored),
                "grand_value": round(grand, 2),
                "class_counts": counts,
                "class_values": {k: round(v, 2) for k, v in values.items()},
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Batch search (for the Batch Traceability picker) ─────────────────
    # Distinct batch numbers that actually have boxes, with the material they
    # belong to for disambiguation (same batch string can recur across items).
    @app.route("/api/inventory_mgmt/reports/batch_search")
    def api_rep_batch_search():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        q = (request.args.get("q") or "").strip()
        conn = sampling_portal.get_db_connection()
        try:
            where = "gi.batch_num IS NOT NULL AND gi.batch_num <> ''"
            params = []
            if q:
                where += " AND gi.batch_num LIKE %s"
                params.append(f"%{q}%")
            rows = conn.execute(
                "SELECT gi.batch_num, "
                "       MAX(m.material_name) AS material_name, "
                "       COUNT(DISTINCT b.box_id) AS box_count "
                "FROM procurement_grn_items gi "
                "JOIN rm_boxes b ON b.grn_item_id = gi.id "
                "LEFT JOIN procurement_materials m ON m.id = b.material_id "
                f"WHERE {where} "
                "GROUP BY gi.batch_num "
                "ORDER BY gi.batch_num ASC LIMIT 50",
                tuple(params),
            ).fetchall()
            conn.close()
            return jsonify({"status": "ok", "batches": [
                {"batch": r["batch_num"] or "",
                 "material": r["material_name"] or "",
                 "box_count": int(r["box_count"] or 0)} for r in rows]})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Report: Batch Traceability (where did batch X go) ────────────────
    # Given a batch number, returns every box of that batch, its current
    # location/status, source GRN/supplier/expiry, and full movement history.
    @app.route("/api/inventory_mgmt/reports/batch_trace")
    def api_rep_batch_trace():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        batch = (request.args.get("batch") or "").strip()
        with_cost = (request.args.get("with_cost") or "").lower() in ("1", "true", "yes", "on")
        if not batch:
            return jsonify({"status": "error", "message": "batch required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            # Boxes belonging to this batch, with source GRN + current location.
            boxes = conn.execute(
                "SELECT b.box_id, b.box_code, b.material_id, m.material_name AS material, "
                "b.uom, b.per_box_qty AS qty, b.current_status, "
                "b.current_godown_id, gd.name AS godown_name, "
                "b.grn_no, b.source, b.created_at, m.last_purchase_rate AS rate, "
                "gi.expiry_date, h.grn_num, h.grn_date, h.supplier_name, h.invoice_num "
                "FROM procurement_grn_items gi "
                "JOIN rm_boxes b ON b.grn_item_id = gi.id "
                "LEFT JOIN procurement_materials m ON m.id = b.material_id "
                "LEFT JOIN procurement_godowns gd ON gd.id = b.current_godown_id "
                "LEFT JOIN procurement_grn h ON h.id = b.grn_id "
                "WHERE gi.batch_num = %s "
                "ORDER BY b.material_id, b.box_code",
                (batch,),
            ).fetchall()

            if not boxes:
                conn.close()
                return jsonify({"status": "ok", "report": "batch_trace", "batch": batch,
                                "boxes": [], "box_count": 0, "total_qty": 0,
                                "status_breakdown": {}, "materials": [], "movements": []})

            box_ids = [int(b["box_id"]) for b in boxes]
            ph = ",".join(["%s"] * len(box_ids))

            # Movement history for every box of this batch (audit trail).
            mv_rows = conn.execute(
                "SELECT mv.box_id, b.box_code, mv.movement_type, mv.from_godown_id, "
                "mv.to_godown_id, mv.qty, mv.movement_at, mv.moved_by, mv.remarks, "
                "gf.name AS from_name, gt.name AS to_name "
                "FROM rm_box_movements mv "
                "JOIN rm_boxes b ON b.box_id = mv.box_id "
                "LEFT JOIN procurement_godowns gf ON gf.id = mv.from_godown_id "
                "LEFT JOIN procurement_godowns gt ON gt.id = mv.to_godown_id "
                f"WHERE mv.box_id IN ({ph}) "
                "ORDER BY mv.movement_at DESC, mv.movement_id DESC",
                tuple(box_ids),
            ).fetchall()

            box_list = []
            total_qty = 0.0
            total_value = 0.0
            status_breakdown = {}
            materials = set()
            source = None
            for b in boxes:
                qty = float(b["qty"] or 0)
                rate = float(b["rate"] or 0)
                total_qty += qty
                st = b["current_status"] or "unknown"
                status_breakdown[st] = status_breakdown.get(st, 0) + 1
                if b["material"]:
                    materials.add(b["material"])
                if source is None and (b["grn_num"] or b["supplier_name"]):
                    source = {
                        "grn_num": b["grn_num"] or "",
                        "grn_date": str(b["grn_date"])[:10] if b["grn_date"] else "",
                        "supplier": b["supplier_name"] or "",
                        "invoice": b["invoice_num"] or "",
                        "expiry": str(b["expiry_date"])[:10] if b["expiry_date"] else "",
                    }
                row = {
                    "box_id": int(b["box_id"]), "box_code": b["box_code"] or "",
                    "material": b["material"] or "", "uom": b["uom"] or "",
                    "qty": round(qty, 3), "status": st,
                    "godown": b["godown_name"] or "(unassigned)",
                    "grn_no": b["grn_no"] or "",
                    "created_at": str(b["created_at"])[:10] if b["created_at"] else "",
                }
                if with_cost:
                    val = round(qty * rate, 2)
                    total_value += val
                    row["rate"] = round(rate, 2); row["value"] = val
                box_list.append(row)

            movements = []
            for mv in mv_rows:
                movements.append({
                    "box_code": mv["box_code"] or "",
                    "type": mv["movement_type"] or "",
                    "from": mv["from_name"] or ("—" if mv["from_godown_id"] is None else str(mv["from_godown_id"])),
                    "to": mv["to_name"] or ("—" if mv["to_godown_id"] is None else str(mv["to_godown_id"])),
                    "qty": round(float(mv["qty"] or 0), 3),
                    "at": str(mv["movement_at"])[:19] if mv["movement_at"] else "",
                    "by": mv["moved_by"] or "",
                    "remarks": mv["remarks"] or "",
                })

            conn.close()
            return jsonify({
                "status": "ok", "report": "batch_trace", "batch": batch,
                "with_cost": with_cost,
                "boxes": box_list, "box_count": len(box_list),
                "total_qty": round(total_qty, 3),
                "total_value": round(total_value, 2) if with_cost else None,
                "status_breakdown": status_breakdown,
                "materials": sorted(materials),
                "source": source,
                "movements": movements,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Home Dashboard summary (aggregates task + alert + activity counts) ─
    # One call returns everything the dashboard tiles need, computed server-
    # side with lean COUNT queries. Every sub-query is wrapped so a missing
    # table on a given install yields 0 rather than failing the whole call.
    @app.route("/api/inventory_mgmt/dashboard/summary")
    def api_dashboard_summary():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500

        def _count(sql, params=()):
            # Every query below aliases its count AS c. Read that column directly;
            # fall back to positional [0] only if the row isn't a mapping. Any
            # genuine SQL error is logged (not silently swallowed as 0) so a
            # broken count surfaces instead of masquerading as "0".
            try:
                row = conn.execute(sql, params).fetchone()
                if not row:
                    return 0
                try:
                    v = row["c"]
                except (TypeError, KeyError, IndexError):
                    v = row[0]
                return int(v or 0)
            except Exception as _e:
                print("⚠️ [dashboard summary] count query failed:", _e)
                return 0

        try:
            from datetime import date as _date
            today = _date.today().isoformat()

            # ── Tasks (things awaiting action) ──
            tasks = {
                "material_requests": _count(
                    "SELECT COUNT(*) AS c FROM inventory_material_requests "
                    "WHERE status IN ('pending','in_progress')"),
                "transfers_in_transit": _count(
                    "SELECT COUNT(*) AS c FROM rm_stock_transfers WHERE status='in_pending'"),
                "simple_in_transit": _count(
                    "SELECT COUNT(*) AS c FROM rm_simple_transfers WHERE status='in_pending'"),
                "fefo_overrides": _count(
                    "SELECT COUNT(*) AS c FROM inventory_fefo_overrides WHERE status='pending'"),
                "label_reprints": _count(
                    "SELECT COUNT(*) AS c FROM inventory_label_reprint_requests WHERE status='pending'"),
                "label_reissues": _count(
                    "SELECT COUNT(*) AS c FROM inventory_label_reissue_requests WHERE status='pending'"),
            }

            # ── Alerts (stock conditions needing attention) ──
            # The three quantity buckets are mutually exclusive so the same
            # material is never counted twice and alerts_total isn't inflated:
            #   • Below MSL  → 0 < stock <= MSL   (low but still has stock)
            #   • Zero stock → stock == 0          (MSL-tracked, fully depleted)
            #   • Negative   → stock < 0           (data-integrity error)
            # Below MSL: MSL-tracked materials running low but not yet empty.
            below_msl = _count(
                "SELECT COUNT(*) AS c FROM procurement_materials m "
                "WHERE m.msl IS NOT NULL AND m.msl > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) <= m.msl")
            # Zero stock (MSL-tracked materials at EXACTLY 0 — negatives excluded,
            # they belong to the Negative bucket below).
            zero_stock = _count(
                "SELECT COUNT(*) AS c FROM procurement_materials m "
                "WHERE m.msl IS NOT NULL AND m.msl > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) = 0")
            # Negative stock (data-integrity flag): any material whose in_stock sum < 0
            negative_stock = _count(
                "SELECT COUNT(*) AS c FROM (SELECT b.material_id "
                "FROM rm_boxes b WHERE b.current_status='in_stock' "
                "GROUP BY b.material_id HAVING SUM(b.per_box_qty) < 0) t")
            # Expiring soon (in_stock boxes whose expiry <= today+30d, not yet
            # expired). Expiry source built defensively (GRN-item OR box-level)
            # so opening-stock boxes count and a missing column never errors.
            _de = _expiry_expr(conn)[0]
            expiring_30 = _count(
                "SELECT COUNT(*) AS c FROM rm_boxes b "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                "WHERE b.current_status='in_stock' "
                f"AND {_de} IS NOT NULL "
                f"AND {_de} >= CURDATE() "
                f"AND {_de} < DATE_ADD(CURDATE(), INTERVAL 30 DAY)")
            # Already expired (in_stock boxes past expiry — should be quarantined)
            expired = _count(
                "SELECT COUNT(*) AS c FROM rm_boxes b "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                "WHERE b.current_status='in_stock' "
                f"AND {_de} IS NOT NULL "
                f"AND {_de} < CURDATE()")
            alerts = {
                "below_msl": below_msl,
                "zero_stock": zero_stock,
                "negative_stock": negative_stock,
                "expiring_30": expiring_30,
                "expired": expired,
            }

            # ── Today's activity ──
            # Use a [today, today+1day) range rather than `= today` so DATE vs
            # DATETIME columns both match correctly (an exact `=` against a
            # DATETIME silently misses every row that carries a time component).
            activity = {
                # GRNs only — exclude REJOUT / rejection-out and other non-GRN
                # voucher types, matching the GRN Register report's filter.
                "grns_today": _count(
                    "SELECT COUNT(*) AS c FROM procurement_grn "
                    "WHERE (grn_type IS NULL OR grn_type='GRN' OR grn_type='') "
                    "AND grn_date >= %s AND grn_date < DATE_ADD(%s, INTERVAL 1 DAY)",
                    (today, today)),
                "transfers_today": _count(
                    "SELECT COUNT(*) AS c FROM rm_stock_transfers "
                    "WHERE status='received' "
                    "AND transfer_date >= %s AND transfer_date < DATE_ADD(%s, INTERVAL 1 DAY)",
                    (today, today)),
                "boxes_today": _count(
                    "SELECT COUNT(*) AS c FROM rm_boxes WHERE DATE(created_at) = %s", (today,)),
            }

            conn.close()
            return jsonify({
                "status": "ok",
                "date": today,
                "tasks": tasks,
                "alerts": alerts,
                "activity": activity,
                "tasks_total": sum(tasks.values()),
                "alerts_total": sum(alerts.values()),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ════════════════════════════════════════════════════════════════════
    #  NOTIFICATIONS  —  persistent, per-user-read log fed by the dashboard
    #  tasks & alerts. A topbar bell lists recent items; each links to the
    #  page/report that resolves it.
    #
    #  Design (no duplicate spam):
    #    • Each active condition maps to ONE notification row keyed by a
    #      stable `dedupe_key` (e.g. 'task:material_requests', 'alert:expired').
    #    • /sync recomputes the dashboard conditions and UPSERTS:
    #        - condition present  → insert (if new) or refresh count/seen_at
    #          on the still-open row; never a second row for the same key.
    #        - condition cleared  → the open row is marked resolved.
    #    • Notifications are global (conditions are system-wide); read-state
    #      is tracked PER USER in inventory_notification_reads.
    # ════════════════════════════════════════════════════════════════════
    def _notif_tables(conn):
        """Idempotent table creation — delegates to the module-level helper
        so the schema lives in exactly one place (shared with the agent)."""
        ensure_notification_tables(conn)

    def _notif_user():
        return session.get("User_Name") or session.get("UID") or "Unknown"

    @app.route("/api/inventory_mgmt/notifications/sync", methods=["POST", "GET"])
    def api_notifications_sync():
        """Recompute dashboard conditions and upsert notification rows.
        Returns the same payload as /list so the bell can refresh in one call."""
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500

        def _count(sql, params=()):
            try:
                row = conn.execute(sql, params).fetchone()
                if not row:
                    return 0
                try: v = row["c"]
                except (TypeError, KeyError, IndexError): v = row[0]
                return int(v or 0)
            except Exception as _e:
                print("⚠️ [notifications sync] count failed:", _e)
                return 0

        try:
            _notif_tables(conn)

            # Recompute the same conditions the dashboard uses. Each tuple:
            #   dedupe_key, category, count, title, body, link_key, severity
            conds = []

            # ── Tasks ──
            conds.append(("task:material_requests", "task", _count(
                "SELECT COUNT(*) AS c FROM inventory_material_requests "
                "WHERE status IN ('pending','in_progress')"),
                "Material Requests", "pending / in-progress", "material_requests", "info"))
            conds.append(("task:transfers_in_transit", "task", _count(
                "SELECT COUNT(*) AS c FROM rm_stock_transfers WHERE status='in_pending'"),
                "Transfers In-Transit", "awaiting receipt", "transfers_in_transit", "warn"))
            conds.append(("task:simple_in_transit", "task", _count(
                "SELECT COUNT(*) AS c FROM rm_simple_transfers WHERE status='in_pending'"),
                "Simple Vouchers", "awaiting receipt", "simple_in_transit", "warn"))
            conds.append(("task:fefo_overrides", "task", _count(
                "SELECT COUNT(*) AS c FROM inventory_fefo_overrides WHERE status='pending'"),
                "FEFO Overrides", "pending approval", "fefo_overrides", "warn"))
            conds.append(("task:label_reprints", "task", _count(
                "SELECT COUNT(*) AS c FROM inventory_label_reprint_requests WHERE status='pending'"),
                "Label Reprints", "pending approval", "label_reprints", "info"))
            conds.append(("task:label_reissues", "task", _count(
                "SELECT COUNT(*) AS c FROM inventory_label_reissue_requests WHERE status='pending'"),
                "Label Reissues", "pending approval", "label_reissues", "info"))

            # ── Alerts (mutually-exclusive buckets, same as dashboard) ──
            conds.append(("alert:below_msl", "alert", _count(
                "SELECT COUNT(*) AS c FROM procurement_materials m "
                "WHERE m.msl IS NOT NULL AND m.msl > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) <= m.msl"),
                "Below MSL", "reorder needed", "below_msl", "warn"))
            conds.append(("alert:zero_stock", "alert", _count(
                "SELECT COUNT(*) AS c FROM procurement_materials m "
                "WHERE m.msl IS NOT NULL AND m.msl > 0 "
                "AND COALESCE((SELECT SUM(b.per_box_qty) FROM rm_boxes b "
                "   WHERE b.material_id=m.id AND b.current_status='in_stock'),0) = 0"),
                "Zero Stock", "tracked items at zero", "zero_stock", "error"))
            conds.append(("alert:negative_stock", "alert", _count(
                "SELECT COUNT(*) AS c FROM (SELECT b.material_id FROM rm_boxes b "
                "WHERE b.current_status='in_stock' GROUP BY b.material_id "
                "HAVING SUM(b.per_box_qty) < 0) t"),
                "Negative Stock", "data-integrity flag", "negative_stock", "error"))
            _ne = _expiry_expr(conn)[0]
            conds.append(("alert:expiring_30", "alert", _count(
                "SELECT COUNT(*) AS c FROM rm_boxes b "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                "WHERE b.current_status='in_stock' "
                f"AND {_ne} IS NOT NULL "
                f"AND {_ne} >= CURDATE() "
                f"AND {_ne} < DATE_ADD(CURDATE(), INTERVAL 30 DAY)"),
                "Expiring ≤30d", "use first (FEFO)", "expiring_30", "warn"))
            conds.append(("alert:expired", "alert", _count(
                "SELECT COUNT(*) AS c FROM rm_boxes b "
                "LEFT JOIN procurement_grn_items gi ON gi.id=b.grn_item_id "
                "WHERE b.current_status='in_stock' "
                f"AND {_ne} IS NOT NULL "
                f"AND {_ne} < CURDATE()"),
                "Expired", "quarantine", "expired", "error"))

            present_keys = set()
            items_for_upsert = []
            for (dk, cat, cnt, title, body, link, sev) in conds:
                items_for_upsert.append({
                    "dedupe_key": dk, "category": cat, "count": cnt,
                    "title": title, "body": body, "link_key": link, "severity": sev,
                })
            # The dashboard owns the 'task:' and 'alert:' key namespaces; the
            # agent owns 'agent:'. Each only resolves its own cleared rows.
            upsert_notifications(conn, items_for_upsert, ("task:", "alert:"))

            conn.commit()
            conn.close()
            return _notifications_payload()
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    def _notifications_payload(scope=None):
        """Build the list payload for the current user.
        scope: 'active' (default for bell) or 'all' (history)."""
        user = _notif_user()
        conn = sampling_portal.get_db_connection()
        try:
            _notif_tables(conn)
            where = "" if scope == "all" else "WHERE n.status='active'"
            rows = conn.execute(
                "SELECT n.id, n.dedupe_key, n.category, n.title, n.body, n.count, "
                "       n.link_key, n.severity, n.status, n.created_at, n.seen_at, n.resolved_at, "
                "       (r.notif_id IS NOT NULL) AS is_read "
                "FROM inventory_notifications n "
                "LEFT JOIN inventory_notification_reads r "
                "  ON r.notif_id=n.id AND r.user_name=%s "
                + where +
                " ORDER BY n.seen_at DESC, n.id DESC LIMIT 200",
                (user,)).fetchall()

            def _g(r, k, i):
                return (r[k] if hasattr(r, "get") else r[i])

            items = []
            unread = 0
            for r in rows:
                is_read = bool(_g(r, "is_read", 12))
                st = _g(r, "status", 8)
                if st == "active" and not is_read:
                    unread += 1
                items.append({
                    "id": _g(r, "id", 0),
                    "dedupe_key": _g(r, "dedupe_key", 1),
                    "category": _g(r, "category", 2),
                    "title": _g(r, "title", 3),
                    "body": _g(r, "body", 4) or "",
                    "count": int(_g(r, "count", 5) or 0),
                    "link_key": _g(r, "link_key", 6) or "",
                    "severity": _g(r, "severity", 7) or "info",
                    "status": st,
                    "created_at": str(_g(r, "created_at", 9) or "")[:19],
                    "seen_at": str(_g(r, "seen_at", 10) or "")[:19],
                    "resolved_at": str(_g(r, "resolved_at", 11) or "")[:19],
                    "is_read": is_read,
                })
            conn.close()
            return jsonify({"status": "ok", "items": items, "unread": unread})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/notifications/list")
    def api_notifications_list():
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        scope = (request.args.get("scope") or "active").lower()
        return _notifications_payload("all" if scope == "all" else "active")

    @app.route("/api/inventory_mgmt/notifications/read", methods=["POST"])
    def api_notifications_read():
        """Mark one or all notifications read for the current user.
        Body: {id: <int>}  OR  {all: true}."""
        if not _rep_logged_in():
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        data = request.get_json(silent=True) or {}
        user = _notif_user()
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({"status": "error", "message": "DB connection failed"}), 500
        try:
            _notif_tables(conn)
            if data.get("all"):
                ids = conn.execute(
                    "SELECT id FROM inventory_notifications WHERE status='active'").fetchall()
                for r in ids:
                    nid = r["id"] if hasattr(r, "get") else r[0]
                    conn.execute(
                        "INSERT INTO inventory_notification_reads (notif_id, user_name) "
                        "VALUES (%s,%s) ON DUPLICATE KEY UPDATE read_at=NOW()", (nid, user))
            else:
                try:
                    nid = int(data.get("id") or 0)
                except (TypeError, ValueError):
                    nid = 0
                if not nid:
                    conn.close()
                    return jsonify({"status": "error", "message": "id required"}), 400
                conn.execute(
                    "INSERT INTO inventory_notification_reads (notif_id, user_name) "
                    "VALUES (%s,%s) ON DUPLICATE KEY UPDATE read_at=NOW()", (nid, user))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryReports] registered — /api/inventory_mgmt/reports/*")
