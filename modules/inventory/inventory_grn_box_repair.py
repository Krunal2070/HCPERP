"""
inventory_grn_box_repair.py
============================

GRN → rm_boxes repair + diagnostics.

Background
----------
When a GRN is saved, inventory_mgmt.py calls _grn_create_boxes_for_line()
for each line item to create the per-package rows in rm_boxes. Those
rows are what the Stock Transfer OUT/IN scanner looks up when an
operator scans a printed package code (e.g. "RM-A0000467").

The original implementation has a SILENT-FAILURE path: if the GRN
line's material name doesn't match procurement_materials.material_name
case-and-whitespace-EXACTLY, the lookup returns no row, _grn_create_boxes_for_line
is never called, and zero boxes are created. The GRN save itself
still returns "ok" because every box-creation step is wrapped in a
swallowing try/except. The operator prints labels, sticks them on
barrels, and weeks later — when scanning at OUT — the system says
"⚠ No package with code RM-A0000467". The labels are "ghost"
allocations: codes were reserved (and printed) but no box rows ever
got inserted.

This module ships three things:

  1. RESOLVE_MATERIAL_ID(conn, name)
       Case-and-whitespace tolerant material lookup. Drop-in
       replacement for the bare exact-match query. To be used by
       inventory_mgmt.py at the two box-creation call sites.

  2. /api/inventory_mgmt/grn/box_audit  (GET, admin/QC-or-inventory)
       Scans GRNs for "ghost" allocations: line items where
       packages > 0 but rm_boxes rows for that line are fewer than
       packages. Returns a list grouped by GRN with counts of
       expected vs actual.

  3. /api/inventory_mgmt/grn/repair_boxes  (POST, admin only)
       Creates the missing rm_boxes rows for the specified GRNs
       (or all of them if `all=true` is passed). Uses the
       inventory_godown.allocate_next_box_code helper so new
       codes are issued in the standard sequence.

Note: the repair issues NEW codes for the missing boxes. Labels
already printed with the old (ghost) codes will NOT match — those
labels need to be reprinted. The audit response makes this clear so
operators don't reuse ghost stickers.

This module is purely additive — no existing inventory_mgmt.py code
is modified by registering this module. The recommended
material-lookup patch (item 1 above) is a 2-line change in
inventory_mgmt.py; see the bottom of this file for the exact diff.
"""

from __future__ import annotations

import traceback
from functools import wraps

from flask import jsonify, request, session

try:
    import sampling_portal
except Exception:  # pragma: no cover
    sampling_portal = None  # type: ignore


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def _user():
    return (session.get("User_Name") or session.get("UID")
            or session.get("user_name") or "Unknown")


def _is_admin():
    role = session.get("User_Type") or session.get("user_type") or ""
    uid = (_user() or "").lower()
    return str(role).lower() == "admin" or uid in {"sonal", "tarak"}


def _login_required(f):
    @wraps(f)
    def gate(*a, **kw):
        if not session.get("logged_in") and not session.get("UID"):
            return jsonify({"status": "error", "message": "Login required"}), 401
        return f(*a, **kw)
    return gate


def _admin_required(f):
    @wraps(f)
    def gate(*a, **kw):
        if not _is_admin():
            return jsonify({
                "status": "error",
                "message": "Admin-only — repair is restricted to administrators."
            }), 403
        return f(*a, **kw)
    return gate


# ──────────────────────────────────────────────────────────────────────
# Public: case-tolerant material lookup
# ──────────────────────────────────────────────────────────────────────

def resolve_material_id(conn, name):
    """Look up procurement_materials.id by name, tolerating differences
    in case and whitespace. Returns int or None.

    Tries three matches in order:
      1. Exact (the original behaviour, so existing call sites that
         already worked continue to be fast).
      2. LOWER(TRIM(material_name)) = LOWER(TRIM(name)).
      3. Same as (2) but also collapses internal whitespace to a
         single space — catches "FOO  BAR" vs "FOO BAR" type drift.

    This is the function that should replace the bare query in
    inventory_mgmt.py's two box-creation call sites. The same lookup
    in three flavours costs at most three indexed SELECTs and only on
    the GRN-save hot path, so the perf impact is negligible.
    """
    if not name:
        return None
    name = str(name).strip()
    if not name:
        return None

    try:
        # Pass 1: exact match (cheapest, hits the index)
        r = conn.execute(
            "SELECT id FROM procurement_materials WHERE material_name=%s LIMIT 1",
            (name,),
        ).fetchone()
        if r:
            return int(r["id"] if hasattr(r, "get") else r[0])

        # Pass 2: case/whitespace-insensitive
        r = conn.execute(
            "SELECT id FROM procurement_materials "
            "WHERE LOWER(TRIM(material_name)) = LOWER(TRIM(%s)) LIMIT 1",
            (name,),
        ).fetchone()
        if r:
            mid = int(r["id"] if hasattr(r, "get") else r[0])
            print(f"⚠️ [InventoryBoxRepair] material '{name!r}' matched "
                  f"case/whitespace-insensitively → id={mid}. "
                  f"Consider normalising the materials table.")
            return mid

        # Pass 3: collapse internal whitespace too
        r = conn.execute(
            "SELECT id FROM procurement_materials "
            "WHERE LOWER(REGEXP_REPLACE(TRIM(material_name), '[[:space:]]+', ' ')) "
            "= LOWER(REGEXP_REPLACE(TRIM(%s), '[[:space:]]+', ' ')) LIMIT 1",
            (name,),
        ).fetchone()
        if r:
            mid = int(r["id"] if hasattr(r, "get") else r[0])
            print(f"⚠️ [InventoryBoxRepair] material '{name!r}' matched "
                  f"after collapsing internal whitespace → id={mid}.")
            return mid
    except Exception:
        # REGEXP_REPLACE may not exist on older MariaDB. The first two
        # passes already cover the common cases; we don't want a missing
        # function to break the box-creation flow.
        traceback.print_exc()

    return None


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────

def register_inventory_grn_box_repair(app):
    """Idempotent registration. Call from your app factory alongside the
    other inventory module registrations."""
    if getattr(app, "_inventory_grn_box_repair_registered", False):
        return
    setattr(app, "_inventory_grn_box_repair_registered", True)

    # ── Admin page: HTML tool for the audit + repair flow ──
    @app.route("/inventory/grn_box_repair", methods=["GET"])
    @_login_required
    @_admin_required
    def page_inv_grn_box_repair():
        """Renders the admin tool. Same gate as the POST endpoint —
        admin-only. Non-admins reaching this URL get a 403 JSON
        response (which the browser displays as a small error)."""
        from flask import render_template
        return render_template("inventory/grn_box_repair.html")

    # ── Audit endpoint: list GRNs missing rm_boxes rows ──
    @app.route("/api/inventory_mgmt/grn/box_audit", methods=["GET"])
    @_login_required
    def api_inv_grn_box_audit():
        """Returns the list of GRN line items where the expected
        per-package boxes are MISSING from rm_boxes.

        The source of truth for "what labels were printed" is the
        rm_grn_box_codes table (populated by /api/inventory_godown/
        allocate_codes when labels are printed). A row in
        rm_grn_box_codes without a matching rm_boxes row is a "ghost"
        allocation — the operator has a printed sticker but no
        scannable box in the system.

        Query params:
          limit=N    cap the result set (default 200)
          grn_id=N   restrict to one GRN (overrides days)
          days=N     only GRNs from the last N days (default 90)
          all=1      no time limit (overrides days)

        Response: see route docstring at module top.
        """
        if sampling_portal is None:
            return jsonify({"status": "error", "message": "DB unavailable"}), 503
        try:
            limit = int(request.args.get("limit") or 200)
        except Exception:
            limit = 200
        try:
            days = int(request.args.get("days") or 90)
        except Exception:
            days = 90
        try:
            grn_id_filter = int(request.args.get("grn_id") or 0)
        except Exception:
            grn_id_filter = 0
        scan_all = str(request.args.get("all") or "").strip() in ("1","true","yes")

        conn = sampling_portal.get_db_connection()
        if conn is None:
            return jsonify({"status": "error", "message": "DB connection failed"}), 503
        try:
            # ── Ghost-allocation query ──
            # For every code in rm_grn_box_codes (= every label that was
            # ever printed via the persistent allocation path), check
            # whether a matching rm_boxes row exists. If not → ghost.
            # Group by (grn_id, grn_item_id) for the UI.
            sql = """
                SELECT
                    rgc.grn_id,
                    rgc.grn_item_id        AS item_id,
                    rgc.box_code,
                    rgc.box_seq,
                    g.grn_num,
                    g.grn_date,
                    gi.material            AS gi_material,
                    gi.batch_num           AS gi_batch_num,
                    gi.qty_per_pkg         AS gi_qty_per_pkg,
                    gi.received_qty        AS gi_received_qty,
                    gi.uom                 AS gi_uom,
                    gi.location            AS gi_location,
                    gi.packages            AS gi_packages
                FROM rm_grn_box_codes rgc
                LEFT JOIN rm_boxes rb ON rb.box_code = rgc.box_code
                LEFT JOIN procurement_grn g ON g.id = rgc.grn_id
                LEFT JOIN procurement_grn_items gi ON gi.id = rgc.grn_item_id
                WHERE rb.box_id IS NULL
            """
            params = []
            if grn_id_filter:
                sql += " AND rgc.grn_id = %s"
                params.append(grn_id_filter)
            elif not scan_all:
                sql += " AND (g.grn_date >= DATE_SUB(CURDATE(), INTERVAL %s DAY) OR g.grn_date IS NULL)"
                params.append(days)
            sql += " ORDER BY g.grn_date DESC, rgc.grn_id DESC, rgc.grn_item_id ASC, rgc.box_seq ASC"

            rows = conn.execute(sql, params).fetchall() or []

            # ── Fallback line-item lookup ──
            # When rgc.grn_item_id points to a deleted/orphaned line
            # (which happens when a GRN is edited after labels are
            # printed — old line items get re-inserted with new IDs),
            # gi.* is NULL. We try to recover the material info by
            # looking up CURRENT line items in the same grn_id. If
            # there's exactly one current line, we assume the ghost
            # codes belong to it. If multiple, we surface all candidates
            # so the admin can pick.
            current_lines_by_grn = {}  # grn_id -> [{id, material, ...}, ...]
            orphan_grn_ids = sorted({int(r["grn_id"] if hasattr(r, "get") else r[0])
                                     for r in rows
                                     if (dict(r) if hasattr(r, "keys") else r)
                                          .get("gi_material") in (None, "")})
            if orphan_grn_ids:
                placeholders = ",".join(["%s"] * len(orphan_grn_ids))
                cur_rows = conn.execute(
                    f"""SELECT id, grn_id, material, batch_num,
                              qty_per_pkg, received_qty, uom, location, packages
                       FROM procurement_grn_items
                       WHERE grn_id IN ({placeholders})
                         AND material IS NOT NULL AND TRIM(material) <> ''""",
                    orphan_grn_ids,
                ).fetchall() or []
                for cr in cur_rows:
                    cd = dict(cr) if hasattr(cr, "keys") else cr
                    grn_id = int(cd["grn_id"])
                    current_lines_by_grn.setdefault(grn_id, []).append({
                        "item_id":      int(cd["id"]),
                        "material":     cd.get("material") or "",
                        "batch_num":    cd.get("batch_num") or "",
                        "qty_per_pkg": cd.get("qty_per_pkg"),
                        "received_qty": cd.get("received_qty"),
                        "uom":          cd.get("uom") or "KG",
                        "location":     cd.get("location") or "",
                        "packages":     cd.get("packages"),
                    })

            # Group: GRN → list of lines → each line has list of ghost codes
            by_grn = {}
            grn_order = []
            for r in rows:
                d = dict(r) if hasattr(r, "keys") else r
                gid = int(d.get("grn_id") or 0)
                iid = int(d.get("item_id") or 0)
                if gid not in by_grn:
                    by_grn[gid] = {
                        "grn_id":        gid,
                        "grn_num":       d.get("grn_num") or "(unknown GRN)",
                        "grn_date":      str(d["grn_date"]) if d.get("grn_date") else None,
                        "lines_by_id":   {},
                        "total_missing": 0,
                    }
                    grn_order.append(gid)
                line_key = iid

                # Material data for this line — prefer the direct join
                # result; if empty (orphan), fall back to the GRN's
                # CURRENT line items (collected in current_lines_by_grn
                # above). If exactly one current line, auto-pick it.
                # If multiple, the line remains "orphan with candidates"
                # and the admin can pick via the UI.
                gi_mat   = d.get("gi_material") or ""
                gi_batch = d.get("gi_batch_num") or ""
                resolved_item_id = iid       # which line to ATTACH boxes to
                orphan = False
                candidates = []
                if not gi_mat:
                    # Orphan — try fallback
                    candidates = current_lines_by_grn.get(gid, [])
                    if len(candidates) == 1:
                        c = candidates[0]
                        gi_mat   = c["material"]
                        gi_batch = c["batch_num"]
                        resolved_item_id = c["item_id"]
                    elif len(candidates) == 0:
                        # No current lines either — truly orphaned
                        orphan = True
                    else:
                        # Multiple candidates — admin needs to choose
                        orphan = True

                if line_key not in by_grn[gid]["lines_by_id"]:
                    by_grn[gid]["lines_by_id"][line_key] = {
                        "item_id":          resolved_item_id,
                        "original_item_id": iid,
                        "material":         gi_mat,
                        "batch_num":        gi_batch,
                        "ghost_codes":      [],
                        "orphan":           orphan,
                        "candidates":       candidates,
                    }
                by_grn[gid]["lines_by_id"][line_key]["ghost_codes"].append(d.get("box_code"))
                by_grn[gid]["total_missing"] += 1

            # Flatten lines_by_id → lines (list)
            grns_out = []
            # Batch-collect all item_ids we'll report so we can look up
            # existing rm_boxes counts in a single query — this lets the
            # UI flag "ALREADY HAS BOXES" rows that would duplicate if
            # repaired.
            all_item_ids = set()
            for gid in grn_order:
                for iid, ln in by_grn[gid]["lines_by_id"].items():
                    if ln["item_id"]:
                        all_item_ids.add(ln["item_id"])
            existing_by_item = {}
            if all_item_ids:
                try:
                    placeholders = ",".join(["%s"] * len(all_item_ids))
                    cnt_rows = conn.execute(
                        f"""SELECT grn_item_id, COUNT(*) AS n
                            FROM rm_boxes
                            WHERE grn_item_id IN ({placeholders})
                              AND source='grn'
                              AND current_status IN ('in_stock','reserved','in_transit')
                            GROUP BY grn_item_id""",
                        list(all_item_ids),
                    ).fetchall() or []
                    for c in cnt_rows:
                        cd = dict(c) if hasattr(c, "keys") else c
                        existing_by_item[int(cd["grn_item_id"])] = int(cd.get("n") or 0)
                except Exception:
                    traceback.print_exc()

            for gid in grn_order:
                g = by_grn[gid]
                lines = []
                for iid, ln in g["lines_by_id"].items():
                    codes = ln["ghost_codes"]
                    existing_cnt = existing_by_item.get(ln["item_id"], 0)
                    lines.append({
                        "item_id":          ln["item_id"],
                        "original_item_id": ln["original_item_id"],
                        "material":         ln["material"],
                        "batch_num":        ln["batch_num"],
                        "missing_boxes":    len(codes),
                        "ghost_codes":      codes,
                        "orphan":           ln["orphan"],
                        "candidates":       ln["candidates"],
                        # If the resolved line already has active rm_boxes,
                        # the ghosts are most likely extras from a second
                        # label-print — repairing would duplicate the line's
                        # stock. The UI uses this to disable the repair
                        # button and show a "already has boxes" badge.
                        "already_has_boxes": existing_cnt > 0,
                        "existing_boxes":    existing_cnt,
                        # Preview: show first/last so the UI can render a
                        # human-friendly "RM-A0000467 … RM-A0000496 (30 codes)".
                        "code_range":       (codes[0] + " … " + codes[-1]) if len(codes) > 1 else (codes[0] if codes else ""),
                    })
                grns_out.append({
                    "grn_id":        g["grn_id"],
                    "grn_num":       g["grn_num"],
                    "grn_date":      g["grn_date"],
                    "lines":         lines,
                    "total_missing": g["total_missing"],
                })

            # Cap to limit
            grns_out = grns_out[:limit]

            return jsonify({
                "status":               "ok",
                "grns":                 grns_out,
                "total_grns_with_gaps": len(grns_out),
                "total_missing_boxes":  sum(g["total_missing"] for g in grns_out),
                "scanned_days":         (None if (grn_id_filter or scan_all) else days),
                "scan_all":             scan_all,
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({
                "status": "error",
                "message": f"Audit failed: {type(e).__name__}: {e}",
            }), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── Repair endpoint: create missing rm_boxes rows ──
    @app.route("/api/inventory_mgmt/grn/repair_boxes", methods=["POST"])
    @_login_required
    @_admin_required
    def api_inv_grn_repair_boxes():
        """Create missing rm_boxes rows for the specified GRN line items.

        Body:
          { "grn_ids": [4, 5], "item_ids": [12, 13] }
            — repair only the specified items (item_ids takes priority
              if both are given; otherwise repair every gappy line in
              the listed GRNs).
          OR
          { "all": true, "days": 90 }
            — repair every gappy GRN in the last N days.

        Response:
          {
            "status": "ok",
            "repaired": [
              {"grn_id": 4, "grn_num": "GRN/0004",
               "item_id": 12, "material": "...", "created_boxes": 30,
               "preserved_codes": ["RM-A0000467", "RM-A0000468", ...]}
            ],
            "total_created": 30,
            "warnings": ["..."]
          }

        Repair uses the EXACT codes already saved in rm_grn_box_codes
        (i.e. the codes operators have already printed on labels), so
        existing printed labels will scan correctly after repair —
        nothing needs to be re-printed.
        """
        body = request.get_json(silent=True) or {}
        if sampling_portal is None:
            return jsonify({"status": "error", "message": "DB unavailable"}), 503

        conn = sampling_portal.get_db_connection()
        if conn is None:
            return jsonify({"status": "error", "message": "DB connection failed"}), 503

        repaired = []
        warnings = []
        total_created = 0
        uid = _user()

        try:
            # ── Build the list of ghost codes to repair, grouped by line ──
            # Pull every (rgc.*, gi.*, g.*) where rb.box_id IS NULL,
            # constrained by the body filters.
            base_sql = """
                SELECT
                    rgc.grn_id,
                    rgc.grn_item_id        AS item_id,
                    rgc.box_code,
                    rgc.box_seq,
                    g.grn_num,
                    g.grn_date,
                    gi.material,
                    gi.batch_num,
                    gi.qty_per_pkg,
                    gi.received_qty,
                    gi.uom,
                    gi.location,
                    gi.packages
                FROM rm_grn_box_codes rgc
                LEFT JOIN rm_boxes rb ON rb.box_code = rgc.box_code
                LEFT JOIN procurement_grn g ON g.id = rgc.grn_id
                LEFT JOIN procurement_grn_items gi ON gi.id = rgc.grn_item_id
                WHERE rb.box_id IS NULL
            """
            params = []
            if body.get("item_ids"):
                ids = [int(x) for x in body["item_ids"] if str(x).isdigit()]
                if not ids:
                    return jsonify({"status": "error",
                                    "message": "No valid item_ids supplied"}), 400
                placeholders = ",".join(["%s"] * len(ids))
                base_sql += f" AND rgc.grn_item_id IN ({placeholders})"
                params.extend(ids)
            elif body.get("grn_ids"):
                ids = [int(x) for x in body["grn_ids"] if str(x).isdigit()]
                if not ids:
                    return jsonify({"status": "error",
                                    "message": "No valid grn_ids supplied"}), 400
                placeholders = ",".join(["%s"] * len(ids))
                base_sql += f" AND rgc.grn_id IN ({placeholders})"
                params.extend(ids)
            elif body.get("all"):
                # No additional WHERE — repair every ghost code in the
                # system. Time-window optional.
                try:
                    days = int(body.get("days") or 0)
                except Exception:
                    days = 0
                if days > 0:
                    base_sql += (" AND (g.grn_date >= DATE_SUB(CURDATE(), "
                                 "INTERVAL %s DAY) OR g.grn_date IS NULL)")
                    params.append(days)
            else:
                return jsonify({
                    "status": "error",
                    "message": "Specify one of: item_ids, grn_ids, or all=true",
                }), 400

            base_sql += " ORDER BY rgc.grn_id, rgc.grn_item_id, rgc.box_seq"
            rows = conn.execute(base_sql, params).fetchall() or []

            if not rows:
                return jsonify({
                    "status":        "ok",
                    "repaired":      [],
                    "total_created": 0,
                    "warnings":      ["Nothing to repair — no ghost "
                                      "allocations match the requested filter."],
                })

            # ── Fallback line-item lookup (same as audit) ──
            # When rgc.grn_item_id is orphaned (line was deleted/re-inserted
            # after labels printed), pull the GRN's CURRENT line items so
            # we can recover the material info. If exactly one current
            # line, auto-bind ghost codes to it. If multiple, skip (the
            # admin must resolve via manual_mappings — TBD UI).
            current_lines_by_grn = {}
            orphan_grn_ids = sorted({
                int((dict(r) if hasattr(r, "keys") else r).get("grn_id") or 0)
                for r in rows
                if not (dict(r) if hasattr(r, "keys") else r).get("material")
            })
            if orphan_grn_ids:
                ph = ",".join(["%s"] * len(orphan_grn_ids))
                cr = conn.execute(
                    f"""SELECT id, grn_id, material, batch_num,
                              qty_per_pkg, received_qty, uom, location, packages
                       FROM procurement_grn_items
                       WHERE grn_id IN ({ph})
                         AND material IS NOT NULL AND TRIM(material) <> ''""",
                    orphan_grn_ids,
                ).fetchall() or []
                for c in cr:
                    cd = dict(c) if hasattr(c, "keys") else c
                    current_lines_by_grn.setdefault(
                        int(cd["grn_id"]), []
                    ).append(cd)

            # Group ghost codes by (grn_id, item_id) so we create boxes
            # per line with the right per-line metadata.
            groups = {}        # (grn_id, item_id) -> {"meta":..., "codes":[...]}
            for r in rows:
                d = dict(r) if hasattr(r, "keys") else r
                grn_id_i  = int(d.get("grn_id") or 0)
                orig_item = int(d.get("item_id") or 0)
                key = (grn_id_i, orig_item)
                if key not in groups:
                    # Start with the direct-join values
                    mat = (d.get("material") or "").strip()
                    batch = d.get("batch_num") or ""
                    qpp   = d.get("qty_per_pkg")
                    rqty  = d.get("received_qty")
                    uom   = d.get("uom") or "KG"
                    loc   = d.get("location") or ""
                    pkgs  = d.get("packages")
                    resolved_item_id = orig_item

                    # If direct join failed (no material), try fallback
                    if not mat:
                        cands = current_lines_by_grn.get(grn_id_i, [])
                        if len(cands) == 1:
                            c = cands[0]
                            mat   = c.get("material") or ""
                            batch = c.get("batch_num") or ""
                            qpp   = c.get("qty_per_pkg")
                            rqty  = c.get("received_qty")
                            uom   = c.get("uom") or "KG"
                            loc   = c.get("location") or ""
                            pkgs  = c.get("packages")
                            resolved_item_id = int(c["id"])
                        # else: leave mat empty → repair loop will skip
                        #       with a clear warning

                    groups[key] = {
                        "grn_id":       grn_id_i,
                        "item_id":      resolved_item_id,
                        "orig_item_id": orig_item,
                        "grn_num":      d.get("grn_num") or "",
                        "material":     mat,
                        "batch":        batch,
                        "qty_per_pkg":  qpp,
                        "received_qty": rqty,
                        "uom":          uom,
                        "location":     loc,
                        "packages":     pkgs,
                        "codes":        [],
                    }
                groups[key]["codes"].append((int(d.get("box_seq") or 0),
                                             d.get("box_code")))

            # ── Resolve godown id once per location string ──
            godown_cache = {}
            default_godown_id = None
            try:
                dr = conn.execute(
                    "SELECT id FROM procurement_godowns "
                    "ORDER BY is_default DESC, id ASC LIMIT 1"
                ).fetchone()
                if dr:
                    default_godown_id = int(dr["id"] if hasattr(dr, "get") else dr[0])
            except Exception:
                traceback.print_exc()

            def _resolve_godown(loc):
                if not loc:
                    return default_godown_id
                key = str(loc).strip().lower()
                if key in godown_cache:
                    return godown_cache[key]
                try:
                    r = conn.execute(
                        "SELECT id FROM procurement_godowns "
                        "WHERE LOWER(TRIM(name))=LOWER(TRIM(%s)) LIMIT 1",
                        (loc.strip(),),
                    ).fetchone()
                    gid = int(r["id"] if hasattr(r, "get") else r[0]) if r else default_godown_id
                except Exception:
                    traceback.print_exc()
                    gid = default_godown_id
                godown_cache[key] = gid
                return gid

            # ── Repair each group: create rm_boxes rows with the EXACT
            # codes that were already printed on labels. ──
            for grp in groups.values():
                codes = sorted(grp["codes"], key=lambda x: x[0])  # by box_seq
                if not codes:
                    continue

                mat = grp.get("material") or ""
                if not mat:
                    # Couldn't resolve material via direct join OR
                    # fallback (zero or multiple candidates in the same
                    # GRN). The admin needs to intervene.
                    cands = current_lines_by_grn.get(grp["grn_id"], [])
                    if not cands:
                        hint = ("This GRN has NO current line items with a "
                                "material name. The line was probably deleted. "
                                "Delete these ghost codes from rm_grn_box_codes "
                                "or re-create the line item.")
                    else:
                        hint = (f"This GRN has {len(cands)} current line "
                                f"items with material set "
                                f"({', '.join(repr(c.get('material')) for c in cands)}). "
                                f"Pick one via the 'Map manually' UI to "
                                f"bind the ghost codes to it.")
                    warnings.append(
                        f"GRN {grp.get('grn_num')} (codes {grp['codes'][0][1]}…): "
                        f"could not auto-resolve material. {hint}"
                    )
                    continue

                mid = resolve_material_id(conn, mat)
                if not mid:
                    warnings.append(
                        f"GRN {grp.get('grn_num')} line {grp.get('item_id')}: "
                        f"material {mat!r} not found in procurement_materials — "
                        f"skipped. Add this material to the materials table "
                        f"first, then retry."
                    )
                    continue

                godown_id = _resolve_godown(grp.get("location"))
                if godown_id is None:
                    warnings.append(
                        f"GRN {grp.get('grn_num')} line {grp.get('item_id')}: "
                        f"no godown could be resolved "
                        f"(location={grp.get('location')!r}) — skipped"
                    )
                    continue

                # Decide per-box qty. Falls back to received_qty/packages
                # if qty_per_pkg is missing.
                try:    per = float(grp.get("qty_per_pkg") or 0)
                except Exception: per = 0.0
                try:    rq  = float(grp.get("received_qty") or 0)
                except Exception: rq = 0.0
                pkgs = int(grp.get("packages") or 0) or len(codes)
                if per <= 0 and rq > 0 and pkgs > 0:
                    per = round(rq / pkgs, 3)
                if per <= 0:
                    # Last-resort: 0 qty box. Operators can correct later.
                    per = 0.0

                uom = str(grp.get("uom") or "KG").strip().upper() or "KG"
                preserved = []
                created_here = 0

                # ── DUPLICATION GUARD ──
                # Before creating any boxes, check whether this grn_item_id
                # ALREADY has rm_boxes rows with different codes. If yes,
                # the ghost codes in rm_grn_box_codes are extras from a
                # second label-print — NOT a missing-rm_boxes situation.
                # Creating new boxes here would duplicate the line's stock.
                # Instead, warn the admin and skip.
                try:
                    ex_cnt_row = conn.execute(
                        "SELECT COUNT(*) AS n FROM rm_boxes "
                        "WHERE grn_item_id=%s AND source='grn' "
                        "AND current_status IN ('in_stock','reserved','in_transit')",
                        (grp["item_id"],)
                    ).fetchone()
                    existing_cnt = int(
                        (ex_cnt_row["n"] if hasattr(ex_cnt_row, "get") else ex_cnt_row[0]) or 0
                    )
                except Exception:
                    existing_cnt = 0

                if existing_cnt > 0:
                    # Pull a sample of the existing codes for the warning.
                    try:
                        sample = conn.execute(
                            "SELECT box_code FROM rm_boxes "
                            "WHERE grn_item_id=%s AND source='grn' "
                            "ORDER BY box_seq LIMIT 3",
                            (grp["item_id"],)
                        ).fetchall() or []
                        sample_codes = ", ".join(
                            (dict(s) if hasattr(s, "keys") else s).get("box_code") or ""
                            for s in sample
                        )
                    except Exception:
                        sample_codes = ""
                    warnings.append(
                        f"GRN {grp.get('grn_num')} line {grp.get('item_id')}: "
                        f"SKIPPED to prevent DUPLICATION. Line already has "
                        f"{existing_cnt} active rm_boxes rows "
                        f"(e.g. {sample_codes}). The {len(codes)} ghost code(s) "
                        f"in rm_grn_box_codes appear to be from a second "
                        f"label-print; creating boxes for them would double the "
                        f"line's stock. If the existing labels are wrong and "
                        f"you want to re-bind to the ghost codes instead, "
                        f"cancel the existing boxes first."
                    )
                    continue

                try:
                    for box_seq, box_code in codes:
                        if not box_code:
                            continue
                        # Defensive: double-check the box really doesn't
                        # exist (race protection).
                        ex = conn.execute(
                            "SELECT box_id FROM rm_boxes WHERE box_code=%s LIMIT 1",
                            (box_code,)
                        ).fetchone()
                        if ex:
                            continue
                        cur = conn.execute(
                            "INSERT INTO rm_boxes "
                            "(box_code, grn_id, grn_no, grn_item_id, material_id, "
                            " box_seq, total_boxes, per_box_qty, uom, "
                            " current_godown_id, current_status, source, created_by) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in_stock','grn',%s)",
                            (box_code, grp["grn_id"], grp.get("grn_num") or "",
                             grp["item_id"], mid, box_seq,
                             len(codes), per, uom, godown_id, uid),
                        )
                        box_id = cur.lastrowid
                        conn.execute(
                            "INSERT INTO rm_box_movements "
                            "(box_id, movement_type, from_godown_id, to_godown_id, "
                            " qty, moved_by, remarks) "
                            "VALUES (%s,'grn_create',NULL,%s,%s,%s,%s)",
                            (box_id, godown_id, per, uid,
                             f"Repaired from GRN {grp.get('grn_num') or ''} "
                             f"(ghost-allocation fix)"),
                        )
                        preserved.append(box_code)
                        created_here += 1
                    conn.commit()
                except Exception as e:
                    traceback.print_exc()
                    try: conn.rollback()
                    except Exception: pass
                    warnings.append(
                        f"GRN {grp.get('grn_num')} line {grp.get('item_id')}: "
                        f"insert failed mid-repair after {created_here} of "
                        f"{len(codes)} boxes — {type(e).__name__}: {e}"
                    )

                if created_here > 0:
                    repaired.append({
                        "grn_id":         grp["grn_id"],
                        "grn_num":        grp.get("grn_num") or "",
                        "item_id":        grp["item_id"],
                        "material":       mat,
                        "batch_num":      grp.get("batch") or "",
                        "created_boxes":  created_here,
                        "preserved_codes": preserved,
                    })
                    total_created += created_here

            print(f"🔧 [InventoryBoxRepair] repaired {total_created} box(es) "
                  f"across {len(repaired)} line(s) by {uid!r} "
                  f"(preserved already-printed codes)")
            return jsonify({
                "status":        "ok",
                "repaired":      repaired,
                "total_created": total_created,
                "warnings":      warnings,
            })

        except Exception as e:
            traceback.print_exc()
            return jsonify({
                "status":  "error",
                "message": f"Repair failed: {type(e).__name__}: {e}",
            }), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── Manual map endpoint: admin binds specific ghost codes to a
    # specific GRN line item. Used when auto-resolution can't decide
    # because the original line was deleted/re-inserted and the GRN
    # now has multiple current lines (admin picks which one).
    @app.route("/api/inventory_mgmt/grn/map_ghost_codes", methods=["POST"])
    @_login_required
    @_admin_required
    def api_inv_grn_map_ghost_codes():
        """Bind specific ghost codes to a chosen GRN line item, creating
        the rm_boxes rows using the EXACT codes printed on the labels.

        Body: {
          "grn_id":     <int>,    # required — the GRN context
          "item_id":    <int>,    # required — the CURRENT line item id
                                  #            whose material/godown/qty
                                  #            should be used
          "box_codes":  ["RM-A0000467", ...]   # optional — if omitted,
                                  # ALL ghost codes for grn_id are
                                  # mapped to this item_id
        }
        """
        body = request.get_json(silent=True) or {}
        try:
            grn_id  = int(body.get("grn_id") or 0)
            item_id = int(body.get("item_id") or 0)
        except Exception:
            return jsonify({"status": "error",
                            "message": "Invalid grn_id or item_id"}), 400
        if not grn_id or not item_id:
            return jsonify({"status": "error",
                            "message": "grn_id and item_id are required"}), 400
        codes_filter = body.get("box_codes") or []
        if codes_filter and not isinstance(codes_filter, list):
            return jsonify({"status": "error",
                            "message": "box_codes must be an array"}), 400

        if sampling_portal is None:
            return jsonify({"status": "error", "message": "DB unavailable"}), 503
        conn = sampling_portal.get_db_connection()
        if conn is None:
            return jsonify({"status": "error", "message": "DB connection failed"}), 503

        uid = _user()
        try:
            # Pull the chosen line item's metadata.
            li = conn.execute(
                "SELECT id, grn_id, material, batch_num, qty_per_pkg, "
                "       received_qty, uom, location, packages "
                "FROM procurement_grn_items WHERE id=%s",
                (item_id,)
            ).fetchone()
            if not li:
                return jsonify({"status":"error",
                                "message":f"Line item {item_id} not found"}), 404
            ld = dict(li) if hasattr(li, "keys") else li
            if int(ld.get("grn_id") or 0) != grn_id:
                return jsonify({
                    "status": "error",
                    "message": f"Line item {item_id} belongs to a different "
                               f"GRN than {grn_id}",
                }), 400

            mat = (ld.get("material") or "").strip()
            if not mat:
                return jsonify({
                    "status": "error",
                    "message": "The chosen line item has no material name "
                               "set. Can't repair against an empty line.",
                }), 400
            mid = resolve_material_id(conn, mat)
            if not mid:
                return jsonify({
                    "status": "error",
                    "message": f"Material {mat!r} not found in "
                               f"procurement_materials. Add it first, "
                               f"then retry.",
                }), 400

            # Resolve godown
            loc = ld.get("location") or ""
            godown_id = None
            if loc:
                gr = conn.execute(
                    "SELECT id FROM procurement_godowns "
                    "WHERE LOWER(TRIM(name))=LOWER(TRIM(%s)) LIMIT 1",
                    (loc.strip(),)
                ).fetchone()
                if gr:
                    godown_id = int(gr["id"] if hasattr(gr, "get") else gr[0])
            if godown_id is None:
                dr = conn.execute(
                    "SELECT id FROM procurement_godowns "
                    "ORDER BY is_default DESC, id ASC LIMIT 1"
                ).fetchone()
                if dr:
                    godown_id = int(dr["id"] if hasattr(dr, "get") else dr[0])
            if godown_id is None:
                return jsonify({
                    "status": "error",
                    "message": "No godown could be resolved for this line.",
                }), 400

            # Decide per-box qty
            try:    per = float(ld.get("qty_per_pkg") or 0)
            except Exception: per = 0.0
            try:    rq  = float(ld.get("received_qty") or 0)
            except Exception: rq = 0.0
            pkgs = int(ld.get("packages") or 0)
            if per <= 0 and rq > 0 and pkgs > 0:
                per = round(rq / pkgs, 3)
            if per <= 0:
                per = 0.0

            uom = str(ld.get("uom") or "KG").strip().upper() or "KG"

            # Find the ghost codes for this GRN (and optionally
            # restrict to the codes_filter list).
            ghost_sql = """
                SELECT rgc.box_code, rgc.box_seq
                FROM rm_grn_box_codes rgc
                LEFT JOIN rm_boxes rb ON rb.box_code = rgc.box_code
                WHERE rgc.grn_id = %s AND rb.box_id IS NULL
            """
            ghost_params = [grn_id]
            if codes_filter:
                ph = ",".join(["%s"] * len(codes_filter))
                ghost_sql += f" AND rgc.box_code IN ({ph})"
                ghost_params.extend(codes_filter)
            ghost_sql += " ORDER BY rgc.box_seq"
            ghosts = conn.execute(ghost_sql, ghost_params).fetchall() or []
            if not ghosts:
                return jsonify({
                    "status": "ok",
                    "message": "No ghost codes to map — they may have been "
                               "repaired already.",
                    "created_boxes": 0,
                    "preserved_codes": [],
                })

            preserved = []
            created_here = 0
            grn_num = ""
            try:
                gr_row = conn.execute(
                    "SELECT grn_num FROM procurement_grn WHERE id=%s",
                    (grn_id,)
                ).fetchone()
                if gr_row:
                    grn_num = (dict(gr_row) if hasattr(gr_row, "keys") else gr_row).get("grn_num") or ""
            except Exception:
                pass

            # ── DUPLICATION GUARD ──
            # If the chosen item_id already has active rm_boxes (just with
            # different codes), creating boxes for the ghost codes would
            # double the stock for this line. Block it and tell the admin
            # what's going on.
            try:
                ex_cnt_row = conn.execute(
                    "SELECT COUNT(*) AS n FROM rm_boxes "
                    "WHERE grn_item_id=%s AND source='grn' "
                    "AND current_status IN ('in_stock','reserved','in_transit')",
                    (item_id,)
                ).fetchone()
                existing_cnt = int(
                    (ex_cnt_row["n"] if hasattr(ex_cnt_row, "get") else ex_cnt_row[0]) or 0
                )
            except Exception:
                existing_cnt = 0

            if existing_cnt > 0:
                try:
                    sample = conn.execute(
                        "SELECT box_code FROM rm_boxes "
                        "WHERE grn_item_id=%s AND source='grn' "
                        "ORDER BY box_seq LIMIT 3",
                        (item_id,)
                    ).fetchall() or []
                    sample_codes = ", ".join(
                        (dict(s) if hasattr(s, "keys") else s).get("box_code") or ""
                        for s in sample
                    )
                except Exception:
                    sample_codes = ""
                return jsonify({
                    "status": "error",
                    "message": (
                        f"Cannot map: line item {item_id} already has "
                        f"{existing_cnt} active rm_boxes rows "
                        f"(e.g. {sample_codes}). The {len(ghosts)} ghost "
                        f"code(s) you're trying to bind look like extras "
                        f"from a second label-print. Binding them would "
                        f"double the line's stock. If the existing labels "
                        f"are wrong, cancel those boxes first, then retry."
                    ),
                }), 409

            try:
                for g in ghosts:
                    gd = dict(g) if hasattr(g, "keys") else g
                    box_code = gd.get("box_code")
                    box_seq  = int(gd.get("box_seq") or 0)
                    if not box_code:
                        continue
                    # Race guard
                    ex = conn.execute(
                        "SELECT box_id FROM rm_boxes WHERE box_code=%s LIMIT 1",
                        (box_code,)
                    ).fetchone()
                    if ex:
                        continue
                    cur = conn.execute(
                        "INSERT INTO rm_boxes "
                        "(box_code, grn_id, grn_no, grn_item_id, material_id, "
                        " box_seq, total_boxes, per_box_qty, uom, "
                        " current_godown_id, current_status, source, created_by) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in_stock','grn',%s)",
                        (box_code, grn_id, grn_num, item_id, mid, box_seq,
                         len(ghosts), per, uom, godown_id, uid),
                    )
                    box_id = cur.lastrowid
                    conn.execute(
                        "INSERT INTO rm_box_movements "
                        "(box_id, movement_type, from_godown_id, to_godown_id, "
                        " qty, moved_by, remarks) "
                        "VALUES (%s,'grn_create',NULL,%s,%s,%s,%s)",
                        (box_id, godown_id, per, uid,
                         f"Manually mapped to line {item_id} from GRN {grn_num} "
                         f"(ghost-allocation fix, admin-resolved)"),
                    )
                    preserved.append(box_code)
                    created_here += 1
                conn.commit()
            except Exception as e:
                traceback.print_exc()
                try: conn.rollback()
                except Exception: pass
                return jsonify({
                    "status": "error",
                    "message": f"Map failed mid-insert after "
                               f"{created_here} of {len(ghosts)} boxes — "
                               f"{type(e).__name__}: {e}",
                }), 500

            print(f"🔧 [InventoryBoxRepair] manually mapped {created_here} "
                  f"code(s) to GRN {grn_num} line {item_id} by {uid!r}")
            return jsonify({
                "status":          "ok",
                "created_boxes":   created_here,
                "preserved_codes": preserved,
                "grn_num":         grn_num,
                "item_id":         item_id,
                "material":        mat,
            })
        except Exception as e:
            traceback.print_exc()
            return jsonify({
                "status":  "error",
                "message": f"Map failed: {type(e).__name__}: {e}",
            }), 500
        finally:
            try: conn.close()
            except Exception: pass

    print("✅ [InventoryBoxRepair] routes registered")


# ══════════════════════════════════════════════════════════════════════
# INTEGRATION PATCH for inventory_mgmt.py
# ══════════════════════════════════════════════════════════════════════
#
# The repair endpoint above fixes EXISTING gappy GRNs. To prevent NEW
# ones from being created, apply this 2-line patch at the two box-
# creation call sites in inventory_mgmt.py (around lines 4226-4232 and
# 4478-4484 in the current file):
#
# At the top of inventory_mgmt.py with the other imports:
#
#     try:
#         from inventory_grn_box_repair import resolve_material_id as _resolve_material_id
#     except Exception:
#         _resolve_material_id = None
#
# Then at EACH of the two box-creation call sites, REPLACE:
#
#     _mrow = conn.execute(
#         "SELECT id FROM procurement_materials WHERE material_name=%s LIMIT 1",
#         (mat,),
#     ).fetchone()
#     _mid = int(_mrow["id"] if hasattr(_mrow, "get") else _mrow[0]) if _mrow else 0
#
# WITH:
#
#     _mid = _resolve_material_id(conn, mat) if _resolve_material_id else 0
#     if not _mid:
#         # Fall back to the bare exact-match for legacy compatibility.
#         _mrow = conn.execute(
#             "SELECT id FROM procurement_materials WHERE material_name=%s LIMIT 1",
#             (mat,),
#         ).fetchone()
#         _mid = int(_mrow["id"] if hasattr(_mrow, "get") else _mrow[0]) if _mrow else 0
#     if not _mid:
#         print(f"⚠️  [InventoryMgmt] GRN box creation SKIPPED — material "
#               f"{mat!r} not found in procurement_materials. Boxes for "
#               f"this line will be 'ghost' allocations until the materials "
#               f"table is corrected.")
#
# That's it: case/whitespace-tolerant lookup + a loud log on failure.
# Same edit at both call sites (lines 4226 and 4478 area). Optionally,
# also register this module in your app factory:
#
#     try:
#         from inventory.inventory_grn_box_repair import register_inventory_grn_box_repair as _ibr
#     except Exception:
#         from inventory_grn_box_repair import register_inventory_grn_box_repair as _ibr
#     _ibr(app)
