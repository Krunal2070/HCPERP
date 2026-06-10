"""
inventory_reset.py - Admin DB Reset (RM)  [DESTRUCTIVE — admin only]
HCP Wellness

Dependency model: INTERPRETATION B.
  A group can be reset ONLY when nothing depends on it. If any dependent group
  still has rows, the reset is BLOCKED and the user is told what to clear first.
  This guarantees we never orphan referencing rows.

Master/config data (materials, godowns, groups, suppliers, brands, users/access,
voucher-number CONFIG) is NEVER resettable here.

Voucher numbering:
  • Manual reset option (truncate rm_box_code_seq → next code starts fresh).
  • Automatic reset whenever the Boxes group is cleared (orphan seq is useless).

Routes (prefix /api/inventory_mgmt/reset):
  GET   /groups            list resettable groups + current row counts + blocked status
  POST  /preview           {groups:[...]} → per-table row counts that WOULD be deleted
  POST  /run               {groups:[...], confirm:'RESET'} → perform reset (admin)
  POST  /voucher_seq       reset box-code sequence to start (admin)
"""

import sys
from datetime import datetime

import sampling_portal
from flask import request, jsonify, session


def _rst_user():
    return (session.get("UID") or session.get("User_Name") or session.get("user") or "system")


def _rst_is_admin():
    role = (session.get("User_Type") or "").strip().lower()
    uid = (session.get("UID") or "").strip().lower()
    return role == "admin" or uid in ("sonal", "tarak")


# ── Resettable groups ────────────────────────────────────────────────────────
# tables: cleared (child-first order WITHIN the group)
# depends_on_me: groups that reference THIS group's data — if any of those still
#                have rows, this group is BLOCKED (Interpretation B).
RESET_GROUPS = {
    "movements": {
        "label": "Box Movements",
        "tables": ["rm_box_movements"],
        "blocked_by": [],   # leaf — nothing depends on movements
    },
    "audit": {
        "label": "Physical Audits",
        "tables": ["inventory_audit_scans", "inventory_audit_materials", "inventory_audit_sessions"],
        "blocked_by": [],
    },
    "delivery_notes": {
        "label": "Delivery Notes",
        "tables": ["inventory_dn_box_scans", "inventory_dn_items", "inventory_dn"],
        "blocked_by": [],
    },
    "transfers": {
        "label": "Stock Transfers",
        "tables": ["rm_stock_transfer_boxes", "rm_transfer_edit_log", "rm_stock_transfers",
                   "rm_simple_transfer_items", "rm_simple_movements", "rm_simple_edit_log", "rm_simple_transfers"],
        "blocked_by": [],
    },
    "material_requests": {
        "label": "Material Requests",
        "tables": ["inventory_material_request_items", "inventory_material_request_links", "inventory_material_requests"],
        "blocked_by": [],
    },
    "labels": {
        "label": "Label Requests",
        "tables": ["inventory_label_reissue_requests", "inventory_label_reprint_box_status",
                   "inventory_label_reprint_requests"],
        "blocked_by": [],
    },
    "boxes": {
        "label": "Boxes",
        "tables": ["rm_boxes", "rm_grn_box_codes", "inventory_fefo_codes"],
        # Boxes can't be cleared while anything still references box_id.
        "blocked_by": ["movements", "audit", "delivery_notes", "transfers"],
        "also_reset_voucher_seq": True,  # auto-reset box-code sequence after clearing boxes
    },
    "grns": {
        "label": "GRNs (Goods Receipt)",
        "tables": ["procurement_grn_items", "procurement_grn_files", "procurement_grn"],
        # GRNs can't be cleared while boxes created from them still exist.
        "blocked_by": ["boxes"],
    },
}

# group → tables whose row-count determines if it's "non-empty" (the parent table)
_GROUP_PARENT_TABLE = {
    "movements": "rm_box_movements",
    "audit": "inventory_audit_sessions",
    "delivery_notes": "inventory_dn",
    "transfers": "rm_stock_transfers",
    "material_requests": "inventory_material_requests",
    "labels": "inventory_label_reissue_requests",
    "boxes": "rm_boxes",
    "grns": "procurement_grn",
}


def _count(conn, table):
    try:
        r = conn.execute(f"SELECT COUNT(*) AS n FROM `{table}`").fetchone()
        return int(r["n"] if hasattr(r, "get") else r[0])
    except Exception:
        return 0  # table may not exist on this install


def _group_has_rows(conn, gkey):
    g = RESET_GROUPS.get(gkey)
    if not g:
        return False
    for t in g["tables"]:
        if _count(conn, t) > 0:
            return True
    return False


def _blockers(conn, gkey):
    """Return list of dependent groups that still hold rows (Interpretation B)."""
    g = RESET_GROUPS.get(gkey, {})
    out = []
    for dep in g.get("blocked_by", []):
        if _group_has_rows(conn, dep):
            out.append({"key": dep, "label": RESET_GROUPS[dep]["label"]})
    return out


def register_inventory_reset(app):
    if getattr(app, "_inventory_reset_registered", False):
        return
    app._inventory_reset_registered = True

    @app.route("/api/inventory_mgmt/reset/groups")
    def api_reset_groups():
        if not _rst_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        conn = sampling_portal.get_db_connection()
        try:
            out = []
            for key, g in RESET_GROUPS.items():
                rows = _count(conn, _GROUP_PARENT_TABLE[key])
                blockers = _blockers(conn, key)
                out.append({
                    "key": key, "label": g["label"],
                    "rows": rows,
                    "blocked": len(blockers) > 0,
                    "blockers": blockers,
                    "tables": g["tables"],
                })
            conn.close()
            return jsonify({"status": "ok", "groups": out})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/reset/preview", methods=["POST"])
    def api_reset_preview():
        if not _rst_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        d = request.get_json(silent=True) or {}
        groups = [g for g in (d.get("groups") or []) if g in RESET_GROUPS]
        conn = sampling_portal.get_db_connection()
        try:
            preview, blocked = [], []
            for gkey in groups:
                blockers = _blockers(conn, gkey)
                if blockers:
                    blocked.append({"key": gkey, "label": RESET_GROUPS[gkey]["label"],
                                    "blockers": blockers})
                    continue
                tbls = [{"table": t, "rows": _count(conn, t)} for t in RESET_GROUPS[gkey]["tables"]]
                preview.append({"key": gkey, "label": RESET_GROUPS[gkey]["label"], "tables": tbls})
            conn.close()
            return jsonify({"status": "ok", "preview": preview, "blocked": blocked})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/reset/run", methods=["POST"])
    def api_reset_run():
        if not _rst_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        d = request.get_json(silent=True) or {}
        if (d.get("confirm") or "") != "RESET":
            return jsonify({"status": "error", "message": "Type RESET to confirm"}), 400
        groups = [g for g in (d.get("groups") or []) if g in RESET_GROUPS]
        if not groups:
            return jsonify({"status": "error", "message": "No valid groups selected"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            # Re-check blockers at run time — refuse any blocked group.
            for gkey in groups:
                b = _blockers(conn, gkey)
                if b:
                    conn.close()
                    return jsonify({
                        "status": "error",
                        "message": f"'{RESET_GROUPS[gkey]['label']}' is blocked — clear "
                                   + ", ".join(x["label"] for x in b) + " first."
                    }), 409

            deleted = {}
            seq_reset = False
            for gkey in groups:
                for t in RESET_GROUPS[gkey]["tables"]:
                    try:
                        n = _count(conn, t)
                        conn.execute(f"DELETE FROM `{t}`")
                        deleted[t] = n
                    except Exception as te:
                        deleted[t] = f"error: {te}"
                # Auto voucher-seq reset when boxes are cleared
                if RESET_GROUPS[gkey].get("also_reset_voucher_seq"):
                    try:
                        conn.execute("DELETE FROM `rm_box_code_seq`")
                        seq_reset = True
                    except Exception:
                        pass
            conn.commit()
            print(f"[inventory_reset] {_rst_user()} reset groups={groups} deleted={deleted} "
                  f"seq_reset={seq_reset} at {datetime.now()}", file=sys.stderr)
            conn.close()
            return jsonify({"status": "ok", "deleted": deleted, "voucher_seq_reset": seq_reset})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/reset/voucher_seq", methods=["POST"])
    def api_reset_voucher_seq():
        """Manual reset of the box-code sequence (start codes fresh)."""
        if not _rst_is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        conn = sampling_portal.get_db_connection()
        try:
            # Blocked if boxes still exist (codes would clash with live boxes).
            if _count(conn, "rm_boxes") > 0:
                conn.close()
                return jsonify({"status": "error",
                                "message": "Boxes still exist — clear Boxes before resetting the sequence."}), 409
            try:
                conn.execute("DELETE FROM `rm_box_code_seq`")
            except Exception:
                pass
            conn.commit()
            print(f"[inventory_reset] {_rst_user()} reset box-code sequence at {datetime.now()}", file=sys.stderr)
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryReset] registered — /api/inventory_mgmt/reset/* (admin, dependency-blocked)")
