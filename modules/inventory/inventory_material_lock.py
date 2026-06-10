r"""
inventory_material_lock.py  –  Material Lock  (Inventory Phase 4)
================================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's Material Lock, adapted to inventory's RM box model.

A manager/admin creates rules that BLOCK (or explicitly ALLOW) a specific RM
material from being scanned OUT of stock, scoped by one of two parameter
types, optionally per-godown:

  • before_date — block stock that ENTERED before a cutoff date. Opening-stock
                  boxes (no GRN) are the oldest possible stock, so they always
                  count as "before" any cutoff.
  • grn         — block one specific GRN's stock of that material.

Modes:  block (locked)  |  allow (explicitly permitted — overrides a block).

This is INDEPENDENT of FEFO. The transfer scan_out route runs both checks.

Table (created here, idempotently):
  inventory_material_locks

Gated by the Phase 1 'material_lock' access category (admins always allowed).

Enforcement helper (importable by inventory_transfers):
  material_lock_check(conn, *, material_id, godown_id, grn_id, grn_date,
                      is_opening=False) -> (blocked: bool, reason: str|None)

Register: auto-called from register_inventory_mgmt() (guarded). No app.py
change needed. API prefix: /api/inventory_mgmt/material_locks*
"""

from __future__ import annotations

from functools import wraps

from flask import session, jsonify, request

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# AUTH
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


def _can_manage():
    """Manage material locks if admin or holds the 'material_lock' category."""
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
        return _ia._inv_user_has_access("material_lock")
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# TABLE INIT
# ─────────────────────────────────────────────────────────────────────────────

def _init_lock_table():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryMatLock] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_material_locks (
                lock_id       INT AUTO_INCREMENT PRIMARY KEY,
                material_id   INT          NOT NULL,
                material_name VARCHAR(500) DEFAULT NULL,
                mode          VARCHAR(10)  NOT NULL DEFAULT 'block',
                param_type    VARCHAR(20)  NOT NULL,
                godown_id     INT          DEFAULT NULL,
                cutoff_date   DATE         DEFAULT NULL,
                grn_id        INT          DEFAULT NULL,
                grn_no        VARCHAR(64)  DEFAULT NULL,
                batch_no      VARCHAR(120) DEFAULT NULL,
                note          VARCHAR(500) DEFAULT NULL,
                is_active     TINYINT(1)   NOT NULL DEFAULT 1,
                created_by    VARCHAR(100) NOT NULL,
                created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
                updated_by    VARCHAR(100) DEFAULT NULL,
                updated_at    DATETIME     DEFAULT NULL,
                INDEX ix_invlock_active (is_active, material_id, godown_id),
                INDEX ix_invlock_grn    (grn_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        # Idempotent migration: add batch_no for installs created before the
        # batch-lock feature.
        try:
            conn.execute("ALTER TABLE inventory_material_locks "
                         "ADD COLUMN batch_no VARCHAR(120) DEFAULT NULL")
            conn.commit()
        except Exception:
            pass  # already exists
        print("✅ [InventoryMatLock] material-lock table ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# ENFORCEMENT  (importable by inventory_transfers scan_out)
# ─────────────────────────────────────────────────────────────────────────────

def material_lock_check(conn, *, material_id, godown_id, grn_id, grn_date,
                        batch_no=None, is_opening=False):
    """Decide whether a box may be OUT-scanned per Material Lock rules.

    Returns (blocked: bool, reason: str|None). FEFO is NOT consulted here.

    Only rules for THIS material and this location (rule.godown_id IS NULL →
    global, or equals the box's godown) are considered. Blocked if any 'block'
    rule matches, UNLESS an 'allow' rule also matches (allow wins).

    Param types:
      • before_date — material's ENTRY date before the cutoff (opening stock
                      counts as oldest → always "before").
      • grn         — one specific GRN.
      • batch       — one specific batch number (case-insensitive match).
    """
    if not material_id:
        return (False, None)
    try:
        rules = conn.execute(
            """SELECT mode, param_type, cutoff_date, grn_id, grn_no, batch_no
               FROM inventory_material_locks
               WHERE is_active=1 AND material_id=%s
                 AND (godown_id IS NULL OR godown_id=%s)""",
            (int(material_id), godown_id),
        ).fetchall()
    except Exception:
        return (False, None)  # never hard-fail a scan on lock-table error
    if not rules:
        return (False, None)

    bdate = str(grn_date)[:10] if grn_date is not None else None
    opening = bool(is_opening) or (grn_id is None)
    box_batch = (str(batch_no).strip().lower() if batch_no is not None else "")

    def _matches(r):
        d = dict(r)
        pt = d.get("param_type")
        if pt == "grn":
            return (d.get("grn_id") is not None and grn_id is not None
                    and int(d["grn_id"]) == int(grn_id))
        if pt == "batch":
            rb = (str(d.get("batch_no")).strip().lower() if d.get("batch_no") else "")
            return bool(rb) and bool(box_batch) and rb == box_batch
        if pt == "before_date":
            cutoff = d.get("cutoff_date")
            if not cutoff:
                return False
            if opening:
                return True
            if not bdate:
                return False
            return bdate < str(cutoff)[:10]
        return False

    # allow wins
    for r in rules:
        d = dict(r)
        if d.get("mode") == "allow" and _matches(r):
            return (False, None)
    for r in rules:
        d = dict(r)
        if d.get("mode") == "block" and _matches(r):
            pt = d.get("param_type")
            if pt == "grn":
                why = f"GRN {d.get('grn_no') or d.get('grn_id')} is locked for issue"
            elif pt == "batch":
                why = f"Batch {d.get('batch_no')} is locked for issue"
            else:
                why = (f"Material entered before {str(d.get('cutoff_date'))[:10]} "
                       f"is locked for issue")
            return (True, why)
    return (False, None)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

def register_inventory_material_lock(app):
    if getattr(app, "_inventory_matlock_registered", False):
        return
    app._inventory_matlock_registered = True
    _init_lock_table()

    PFX = "/api/inventory_mgmt/material_locks"

    # ── LIST ──────────────────────────────────────────────────────────────
    @app.route(PFX, methods=["GET"])
    @_login_required
    def api_inv_locks_list():
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                """SELECT l.lock_id, l.material_id, l.material_name, l.mode,
                          l.param_type, l.godown_id, l.cutoff_date, l.grn_id,
                          l.grn_no, l.batch_no, l.note, l.is_active, l.created_by,
                          l.created_at,
                          COALESCE(g.name,'') AS godown_name
                   FROM inventory_material_locks l
                   LEFT JOIN procurement_godowns g ON g.id = l.godown_id
                   ORDER BY l.is_active DESC, l.lock_id DESC""",
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                for k in ("cutoff_date", "created_at"):
                    if dd.get(k) is not None:
                        dd[k] = str(dd[k])
                dd["is_active"] = int(dd.get("is_active") or 0)
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "locks": out, "can_manage": _can_manage()})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── CREATE ────────────────────────────────────────────────────────────
    @app.route(PFX, methods=["POST"])
    @_login_required
    def api_inv_locks_create():
        if not _can_manage():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        d = request.get_json(silent=True) or {}
        try:
            material_id = int(d.get("material_id") or 0)
        except Exception:
            material_id = 0
        mode = (d.get("mode") or "block").strip().lower()
        ptype = (d.get("param_type") or "").strip().lower()
        note = (d.get("note") or "").strip() or None
        godown_id = d.get("godown_id")
        try:
            godown_id = int(godown_id) if godown_id else None
        except Exception:
            godown_id = None

        if material_id <= 0:
            return jsonify({"status": "error", "message": "material_id required"}), 400
        if mode not in ("block", "allow"):
            return jsonify({"status": "error", "message": "mode must be block/allow"}), 400
        if ptype not in ("before_date", "grn", "batch"):
            return jsonify({"status": "error", "message": "param_type must be before_date/grn/batch"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            # material name
            mn = conn.execute(
                "SELECT material_name FROM procurement_materials WHERE id=%s", (material_id,)
            ).fetchone()
            material_name = (mn["material_name"] if hasattr(mn, "get") else mn[0]) if mn else None

            cutoff_date = None
            grn_id = None
            grn_no = None
            batch_no = None
            if ptype == "before_date":
                cutoff_date = (d.get("cutoff_date") or "").strip() or None
                if not cutoff_date:
                    conn.close()
                    return jsonify({"status": "error", "message": "cutoff_date required"}), 400
            elif ptype == "batch":
                batch_no = (d.get("batch_no") or "").strip() or None
                if not batch_no:
                    conn.close()
                    return jsonify({"status": "error", "message": "batch_no required"}), 400
            else:  # grn
                try:
                    grn_id = int(d.get("grn_id") or 0) or None
                except Exception:
                    grn_id = None
                if not grn_id:
                    conn.close()
                    return jsonify({"status": "error", "message": "grn_id required"}), 400
                gr = conn.execute("SELECT grn_no FROM procurement_grn WHERE id=%s", (grn_id,)).fetchone()
                grn_no = (gr["grn_no"] if hasattr(gr, "get") else gr[0]) if gr else None

            conn.execute(
                """INSERT INTO inventory_material_locks
                     (material_id, material_name, mode, param_type, godown_id,
                      cutoff_date, grn_id, grn_no, batch_no, note, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (material_id, material_name, mode, ptype, godown_id,
                 cutoff_date, grn_id, grn_no, batch_no, note, _user()),
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

    # ── TOGGLE active ─────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:lock_id>/toggle", methods=["POST"])
    @_login_required
    def api_inv_locks_toggle(lock_id):
        if not _can_manage():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT is_active FROM inventory_material_locks WHERE lock_id=%s", (lock_id,)
            ).fetchone()
            if not row:
                conn.close()
                return jsonify({"status": "error", "message": "Lock not found"}), 404
            cur = int((row["is_active"] if hasattr(row, "get") else row[0]) or 0)
            conn.execute(
                "UPDATE inventory_material_locks SET is_active=%s, updated_by=%s, "
                "updated_at=NOW() WHERE lock_id=%s",
                (0 if cur else 1, _user(), lock_id),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "is_active": 0 if cur else 1})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── DELETE ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:lock_id>", methods=["DELETE"])
    @_login_required
    def api_inv_locks_delete(lock_id):
        if not _can_manage():
            return jsonify({"status": "error", "message": "Not permitted"}), 403
        conn = sampling_portal.get_db_connection()
        try:
            conn.execute("DELETE FROM inventory_material_locks WHERE lock_id=%s", (lock_id,))
            conn.commit()
            conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── GRN lookup for a material (to populate the GRN picker) ─────────────
    @app.route(f"{PFX}/grns", methods=["GET"])
    @_login_required
    def api_inv_locks_grns():
        try:
            material_id = int(request.args.get("material_id") or 0)
        except Exception:
            material_id = 0
        if material_id <= 0:
            return jsonify({"status": "error", "message": "material_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            # Distinct GRNs that contain this material (boxes link grn → material).
            rows = conn.execute(
                """SELECT DISTINCT g.id AS grn_id, g.grn_no, g.grn_date
                   FROM rm_boxes b
                   JOIN procurement_grn g ON g.id = b.grn_id
                   WHERE b.material_id=%s
                   ORDER BY g.grn_date DESC, g.id DESC
                   LIMIT 200""",
                (material_id,),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                if dd.get("grn_date") is not None:
                    dd["grn_date"] = str(dd["grn_date"])
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "grns": out})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Item locations (godowns where this material currently resides) ────
    @app.route(f"{PFX}/item_locations/<int:material_id>", methods=["GET"])
    @_login_required
    def api_inv_locks_item_locations(material_id):
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                """SELECT b.current_godown_id AS id, COALESCE(g.name,'') AS name,
                          COUNT(*) AS box_count
                   FROM rm_boxes b
                   LEFT JOIN procurement_godowns g ON g.id = b.current_godown_id
                   WHERE b.material_id=%s AND b.current_status='in_stock'
                     AND b.current_godown_id IS NOT NULL
                   GROUP BY b.current_godown_id, g.name
                   ORDER BY g.name""",
                (material_id,),
            ).fetchall()
            out = [dict(r) for r in rows]
            conn.close()
            return jsonify({"status": "ok", "locations": out})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Batch lookup for a material (in-stock, POSITIVE qty only) ─────────
    @app.route(f"{PFX}/batches", methods=["GET"])
    @_login_required
    def api_inv_locks_batches():
        try:
            material_id = int(request.args.get("material_id") or 0)
        except Exception:
            material_id = 0
        if material_id <= 0:
            return jsonify({"status": "error", "message": "material_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            # Batch lives on the GRN line (procurement_grn_items.batch_num),
            # reached from the box via grn_item_id. Group in-stock boxes by
            # batch and keep only batches with a positive total quantity.
            rows = conn.execute(
                """SELECT gi.batch_num AS batch_no,
                          COUNT(*)                  AS box_count,
                          COALESCE(SUM(b.per_box_qty),0) AS qty,
                          COALESCE(b.uom,'')        AS uom
                   FROM rm_boxes b
                   JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
                   WHERE b.material_id=%s
                     AND b.current_status='in_stock'
                     AND gi.batch_num IS NOT NULL AND gi.batch_num <> ''
                   GROUP BY gi.batch_num, b.uom
                   HAVING COALESCE(SUM(b.per_box_qty),0) > 0
                   ORDER BY gi.batch_num""",
                (material_id,),
            ).fetchall()
            out = []
            for r in rows:
                dd = dict(r)
                dd["qty"] = float(dd.get("qty") or 0)
                dd["box_count"] = int(dd.get("box_count") or 0)
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "batches": out})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryMatLock] routes registered (/api/inventory_mgmt/material_locks*)")
