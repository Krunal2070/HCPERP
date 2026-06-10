r"""
inventory_material_request.py  –  Material Request  (Inventory Phase 2)
======================================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's Material Request feature, adapted to the Inventory
module's data model (RM materials + box-based stock transfers).

Domain model (3 tables, all created here, idempotently)
-------------------------------------------------------
  inventory_material_requests       — one row per request voucher (header)
  inventory_material_request_items  — one row per line item (material + qty)
  inventory_material_request_links  — junction; ties a request line to the
                                      RM transfer + box that fulfilled it

Items are RM materials (procurement_materials). Destination / source are
godowns (procurement_godowns).

Status auto-progression (see _recompute_status):
  - 0 fulfilled              → 'pending'
  - some, not all complete   → 'in_progress'
  - every line fully covered → 'fulfilled'
  - manual cancel            → 'cancelled' (terminal)

FULFILMENT INTEGRATION (the "full port")
-----------------------------------------
Inventory transfers are BOX-based, not quantity-line based: a transfer moves
specific rm_boxes between godowns and reaches status='received' when all its
boxes are scanned in and receipt is confirmed.

The single touchpoint is the transfer confirm_receipt route. After a transfer
flips to 'received', inventory_transfers calls:

    inventory_material_request.fulfill_from_transfer(conn, transfer_id)

which, for each box on the transfer, finds an OPEN request line whose
material_id matches the box's material AND whose dest_godown_id matches the
transfer's to_godown_id, then credits the box's per_box_qty toward that line
(writing a link row) until the line is satisfied. Status is recomputed.

The reverse (admin cancels a 'received' transfer, or otherwise unwinds it)
calls:

    inventory_material_request.unlink_transfer(conn, transfer_id)

Both are best-effort: a failure logs to stderr and never breaks the transfer
operation. They are module-level (not closure routes) so inventory_transfers
can import and call them directly.

Access control (Phase 1)
-------------------------
All routes require the 'material_request' category. Creating/cancelling also
require it. Admins bypass. The fulfilment hook itself is NOT gated — it runs
as a side-effect of a transfer receipt, which has its own permissions.

Register: called automatically from register_inventory_mgmt() (guarded), so
app.py needs no new lines. API prefix: /api/inventory_mgmt/material_request/*
"""

from __future__ import annotations

import sys
from functools import wraps
from datetime import date, datetime

from flask import session, jsonify, request

import sampling_portal


# ─────────────────────────────────────────────────────────────────────────────
# AUTH HELPERS  (mirror inventory_mgmt / inventory_access conventions)
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


def _block_if_no_mr_access():
    """Gate behind the Phase 1 'material_request' category. Best-effort: if the
    access module isn't importable, fail open (don't break the feature)."""
    try:
        from inventory import inventory_access as _ia
    except Exception:
        try:
            import inventory_access as _ia
        except Exception:
            return None
    try:
        return _ia._inv_block_if_no_access("material_request")
    except Exception:
        return None


def _user_locked_godown():
    """Returns the godown_id this user is pinned to, or None.
    Admins always None. Best-effort — failures here must not break
    the underlying flow (we just fall back to 'no lock' behaviour)."""
    try:
        from inventory import inventory_access as _ia
    except Exception:
        try:
            import inventory_access as _ia
        except Exception:
            return None
    try:
        return _ia._locked_godown_id()
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# TABLE INITIALISATION
# ─────────────────────────────────────────────────────────────────────────────

def _init_mr_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryMR] ⚠️  DB connection failed — init skipped.")
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_material_requests (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                request_no       VARCHAR(40)  NOT NULL UNIQUE,
                request_date     DATE         NOT NULL,
                dest_godown_id   INT          NOT NULL,
                source_godown_id INT          DEFAULT NULL,
                requested_by     VARCHAR(80)  NOT NULL,
                status           ENUM('pending','in_progress','fulfilled','cancelled')
                                 NOT NULL DEFAULT 'pending',
                remarks          VARCHAR(500) DEFAULT NULL,
                cancelled_by     VARCHAR(80)  DEFAULT NULL,
                cancelled_at     DATETIME     DEFAULT NULL,
                cancel_reason    VARCHAR(500) DEFAULT NULL,
                created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_mr_status (status),
                INDEX ix_inv_mr_date   (request_date),
                INDEX ix_inv_mr_by     (requested_by),
                INDEX ix_inv_mr_dest   (dest_godown_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_material_request_items (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                request_id      INT           NOT NULL,
                material_id     INT           NOT NULL,
                qty_requested   DECIMAL(14,3) NOT NULL,
                qty_fulfilled   DECIMAL(14,3) NOT NULL DEFAULT 0,
                remarks         VARCHAR(300)  DEFAULT NULL,
                INDEX ix_inv_mri_request  (request_id),
                INDEX ix_inv_mri_material (material_id),
                FOREIGN KEY (request_id) REFERENCES inventory_material_requests(id)
                    ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_material_request_links (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                request_item_id  INT           NOT NULL,
                transfer_id      INT           NOT NULL,
                box_id           INT           DEFAULT NULL,
                qty_fulfilled    DECIMAL(14,3) NOT NULL,
                fulfilled_by     VARCHAR(80)   NOT NULL,
                fulfilled_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_mrl_ri  (request_item_id),
                INDEX ix_inv_mrl_tx  (transfer_id),
                INDEX ix_inv_mrl_box (box_id),
                FOREIGN KEY (request_item_id)
                    REFERENCES inventory_material_request_items(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # ── Migration: add 'preclosed' status + columns (idempotent) ──
        # Pre-close lets the REQUESTER close a request early: keep whatever was
        # already fulfilled, stop further fulfilment. Distinct from 'cancelled'
        # (which is a full abort). Safe to run repeatedly.
        try:
            cols = {c["Field"] if hasattr(c, "get") else c[0]
                    for c in conn.execute("SHOW COLUMNS FROM inventory_material_requests").fetchall()}
            # Widen the status enum to include 'preclosed'.
            conn.execute(
                "ALTER TABLE inventory_material_requests "
                "MODIFY COLUMN status ENUM('draft','pending','in_progress','fulfilled','cancelled','preclosed') "
                "NOT NULL DEFAULT 'pending'"
            )
            adds = []
            if "preclosed_by"     not in cols: adds.append("ADD COLUMN preclosed_by VARCHAR(80) DEFAULT NULL")
            if "preclosed_at"     not in cols: adds.append("ADD COLUMN preclosed_at DATETIME DEFAULT NULL")
            if "preclose_reason"  not in cols: adds.append("ADD COLUMN preclose_reason VARCHAR(500) DEFAULT NULL")
            if adds:
                conn.execute("ALTER TABLE inventory_material_requests " + ", ".join(adds))
            conn.commit()
        except Exception as _ex:
            print(f"ℹ️  [InventoryMR] preclose migration skipped/partial: {_ex}")

        # ── Live-fulfiller presence + acknowledgement alerts ──────────
        # presence: who currently has a request's fulfill flow open (heartbeat).
        # alerts:   OK-required messages targeted at that live fulfiller (e.g.
        #           "requester removed item X"). Fulfiller's screen polls and
        #           must acknowledge (OK) to clear.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_mr_fulfill_presence (
                request_id  INT NOT NULL,
                user_name   VARCHAR(80) NOT NULL,
                last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (request_id, user_name),
                INDEX ix_mr_presence_seen (last_seen)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_mr_alerts (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                request_id   INT NOT NULL,
                target_user  VARCHAR(80) NOT NULL,
                message      VARCHAR(600) NOT NULL,
                created_by   VARCHAR(80) DEFAULT NULL,
                created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                acked        TINYINT(1) NOT NULL DEFAULT 0,
                acked_at     DATETIME DEFAULT NULL,
                INDEX ix_mr_alert_target (target_user, acked),
                INDEX ix_mr_alert_req (request_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        print("✅ [InventoryMR] material-request tables ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# VOUCHER NUMBERING
#
# Tries inventory_voucher_numbering.next_voucher_no() first so admins can
# configure the format via the inventory voucher-numbering admin. Falls
# back to legacy MR/RM/<n>/<FY> if no style is configured (or the helper
# isn't reachable). Fully self-contained — no PM Stock helpers used.
# ─────────────────────────────────────────────────────────────────────────────

def _next_request_no(conn) -> str:
    """Allocate the next request number.

    Order of preference:
      1. inventory_voucher_numbering.next_voucher_no(conn, 'inv_mr')
         (configured via the Inventory module's Voucher Numbering admin)
      2. Legacy MR/RM/<n>/<FY> format

    Either path keeps MR creation working — no hard failure if step 1
    can't resolve (table missing, helper not importable, no style row).
    """
    import re
    today = date.today()

    # Step 1: try the inventory voucher numbering admin
    try:
        try:
            from inventory import inventory_voucher_numbering as _ivn
        except Exception:
            import inventory_voucher_numbering as _ivn
        no = _ivn.next_voucher_no(conn, 'inv_mr')
        if no:
            return no
    except Exception:
        # Module not present (yet), table not created, etc. — fall through.
        pass

    # Step 2: legacy MR/RM/<n>/<FY> fallback
    fy_start = today.year if today.month >= 4 else today.year - 1
    fy_label = f"{str(fy_start)[2:]}-{str(fy_start + 1)[2:]}"
    like = f"MR/RM/%/{fy_label}"
    row = conn.execute(
        "SELECT request_no FROM inventory_material_requests "
        "WHERE request_no LIKE %s ORDER BY id DESC LIMIT 1",
        (like,),
    ).fetchone()
    nxt = 1
    if row and (row["request_no"] if hasattr(row, "get") else row[0]):
        rn = row["request_no"] if hasattr(row, "get") else row[0]
        m = re.search(r"MR/RM/(\d+)/", rn)
        if m:
            nxt = int(m.group(1)) + 1
    return f"MR/RM/{nxt}/{fy_label}"


def _preview_next_request_no(conn) -> str:
    """Read-only sibling of _next_request_no. Returns what the NEXT
    allocated number will look like, without committing anything.
    Implementation note: _next_request_no doesn't allocate either (no
    UPDATE/INSERT), so we just call it directly. If two users open the
    New MR form at the same time, both see the same preview; whichever
    submits second gets the next sequential number."""
    return _next_request_no(conn)


# ─────────────────────────────────────────────────────────────────────────────
# STATUS + FULFILMENT INTERNALS  (module-level; importable by inventory_transfers)
# ─────────────────────────────────────────────────────────────────────────────

_EPS = 0.001


def _recompute_status(conn, request_id):
    """Recompute and persist a request's status from its items' fulfilment.
    Never resurrects a cancelled request."""
    cur = conn.execute(
        "SELECT status FROM inventory_material_requests WHERE id=%s",
        (request_id,),
    ).fetchone()
    if not cur:
        return
    cur_status = cur["status"] if hasattr(cur, "get") else cur[0]
    if cur_status in ("cancelled", "preclosed"):
        return
    items = conn.execute(
        "SELECT qty_requested, qty_fulfilled "
        "FROM inventory_material_request_items WHERE request_id=%s",
        (request_id,),
    ).fetchall()
    if not items:
        return
    any_fulfilled = False
    all_complete = True
    for it in items:
        req = float((it["qty_requested"] if hasattr(it, "get") else it[0]) or 0)
        ful = float((it["qty_fulfilled"] if hasattr(it, "get") else it[1]) or 0)
        if ful > _EPS:
            any_fulfilled = True
        if ful + _EPS < req:
            all_complete = False
    new_status = "fulfilled" if all_complete else ("in_progress" if any_fulfilled else "pending")
    if new_status != cur_status:
        conn.execute(
            "UPDATE inventory_material_requests SET status=%s WHERE id=%s",
            (new_status, request_id),
        )


def fulfill_from_transfer(conn, transfer_id, fulfilled_by=None):
    """Called after a transfer reaches 'received'. Credits each received box's
    quantity toward a matching OPEN request line (same material_id, and the
    request's dest_godown_id == the transfer's to_godown_id).

    Box→line matching is greedy & FEFO-friendly: boxes are consumed in receipt
    order; a box only fills up to the line's remaining need (qty_requested −
    qty_fulfilled). A box can partially fill a line; leftover box qty is simply
    not linked (the box still physically arrives — linking is only a fulfilment
    record, it doesn't move stock).

    Best-effort. Returns the number of link rows written.
    """
    if not transfer_id:
        return 0
    fulfilled_by = fulfilled_by or _user() or "system"
    try:
        # The transfer + its destination godown (+ optional stamped request).
        t = conn.execute(
            "SELECT transfer_id, to_godown_id, status, "
            "       COALESCE(request_id, 0) AS request_id "
            "FROM rm_stock_transfers WHERE transfer_id=%s",
            (int(transfer_id),),
        ).fetchone()
        if not t:
            return 0
        to_gid = int(t["to_godown_id"] if hasattr(t, "get") else t[1])
        stamped_req = int((t["request_id"] if hasattr(t, "get") else t[3]) or 0)

        # Boxes on this transfer, with their material + qty.
        boxes = conn.execute(
            """SELECT b.box_id, b.material_id, b.per_box_qty
               FROM rm_stock_transfer_boxes tb
               JOIN rm_boxes b ON b.box_id = tb.box_id
               WHERE tb.transfer_id=%s
               ORDER BY b.box_id""",
            (int(transfer_id),),
        ).fetchall()
        if not boxes:
            return 0

        # Open request lines wanting these materials AT this destination.
        # Gather materials present on the transfer to scope the query.
        mat_ids = sorted({int(b["material_id"] if hasattr(b, "get") else b[1]) for b in boxes})
        if not mat_ids:
            return 0
        placeholders = ",".join(["%s"] * len(mat_ids))
        # When a transfer is explicitly stamped with a request_id (created via
        # the Fulfill button), restrict fulfilment to THAT request. Otherwise
        # fall back to matching any open request at this destination.
        if stamped_req:
            req_filter = "AND r.id = %s"
            req_params = [stamped_req]
        else:
            req_filter = "AND r.dest_godown_id = %s"
            req_params = [to_gid]
        open_lines = conn.execute(
            f"""SELECT ri.id, ri.material_id, ri.qty_requested, ri.qty_fulfilled,
                       r.id AS request_id, r.request_date
                FROM inventory_material_request_items ri
                JOIN inventory_material_requests r ON r.id = ri.request_id
                WHERE r.status IN ('pending','in_progress')
                  {req_filter}
                  AND ri.material_id IN ({placeholders})
                  AND ri.qty_fulfilled + {_EPS} < ri.qty_requested
                ORDER BY r.request_date, r.id, ri.id""",
            tuple(req_params + mat_ids),
        ).fetchall()
        if not open_lines:
            return 0

        # Index open lines by material → FIFO queue of (line dict).
        lines_by_mat = {}
        for ln in open_lines:
            d = dict(ln) if hasattr(ln, "keys") else {
                "id": ln[0], "material_id": ln[1], "qty_requested": ln[2],
                "qty_fulfilled": ln[3], "request_id": ln[4], "request_date": ln[5],
            }
            lines_by_mat.setdefault(int(d["material_id"]), []).append(d)

        linked = 0
        affected_reqs = set()
        for b in boxes:
            bid = int(b["box_id"] if hasattr(b, "get") else b[0])
            mid = int(b["material_id"] if hasattr(b, "get") else b[1])
            bqty = float((b["per_box_qty"] if hasattr(b, "get") else b[2]) or 0)
            if bqty <= 0:
                continue
            queue = lines_by_mat.get(mid)
            if not queue:
                continue
            remaining_box = bqty
            for line in queue:
                if remaining_box <= _EPS:
                    break
                need = float(line["qty_requested"]) - float(line["qty_fulfilled"])
                if need <= _EPS:
                    continue
                take = min(need, remaining_box)
                conn.execute(
                    """INSERT INTO inventory_material_request_links
                         (request_item_id, transfer_id, box_id, qty_fulfilled, fulfilled_by)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (int(line["id"]), int(transfer_id), bid, take, fulfilled_by),
                )
                conn.execute(
                    "UPDATE inventory_material_request_items "
                    "SET qty_fulfilled = qty_fulfilled + %s WHERE id=%s",
                    (take, int(line["id"])),
                )
                line["qty_fulfilled"] = float(line["qty_fulfilled"]) + take
                remaining_box -= take
                linked += 1
                affected_reqs.add(int(line["request_id"]))

        for rid in affected_reqs:
            _recompute_status(conn, rid)
        return linked
    except Exception as e:
        print(f"[InventoryMR] fulfill_from_transfer failed: {e}", file=sys.stderr)
        return 0


def unlink_transfer(conn, transfer_id):
    """Reverse fulfilment when a transfer is unwound (e.g. admin cancel of a
    received transfer). Removes link rows, decrements qty_fulfilled, recomputes
    status. Best-effort. Returns count of links removed."""
    if not transfer_id:
        return 0
    try:
        links = conn.execute(
            """SELECT l.id, l.request_item_id, l.qty_fulfilled, ri.request_id
               FROM inventory_material_request_links l
               JOIN inventory_material_request_items ri ON ri.id = l.request_item_id
               WHERE l.transfer_id=%s""",
            (int(transfer_id),),
        ).fetchall()
        if not links:
            return 0
        affected = set()
        for ln in links:
            d = dict(ln) if hasattr(ln, "keys") else {
                "id": ln[0], "request_item_id": ln[1],
                "qty_fulfilled": ln[2], "request_id": ln[3],
            }
            conn.execute(
                "UPDATE inventory_material_request_items "
                "SET qty_fulfilled = GREATEST(0, qty_fulfilled - %s) WHERE id=%s",
                (float(d["qty_fulfilled"] or 0), int(d["request_item_id"])),
            )
            conn.execute(
                "DELETE FROM inventory_material_request_links WHERE id=%s",
                (int(d["id"]),),
            )
            affected.add(int(d["request_id"]))
        for rid in affected:
            _recompute_status(conn, rid)
        return len(links)
    except Exception as e:
        print(f"[InventoryMR] unlink_transfer failed: {e}", file=sys.stderr)
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

def register_inventory_material_request(app):
    """Register Material Request routes + bootstrap tables. Idempotent."""
    if getattr(app, "_inventory_mr_registered", False):
        return
    app._inventory_mr_registered = True
    _init_mr_tables()

    PFX = "/api/inventory_mgmt/material_request"

    # ── CREATE ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/save", methods=["POST"])
    @_login_required
    def api_inv_mr_save():
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        d = request.get_json(silent=True) or {}
        request_date = d.get("request_date") or str(date.today())
        dest_godown_id = d.get("dest_godown_id")
        source_godown_id = d.get("source_godown_id")
        try:
            source_godown_id = int(source_godown_id) if source_godown_id else None
        except Exception:
            source_godown_id = None
        remarks = (d.get("remarks") or "").strip() or None
        items = d.get("items") or []
        as_draft = bool(d.get("as_draft"))   # draft = not yet submitted to fulfillers

        # ── Location lock enforcement (May 2026) ──
        # If the requester is pinned to a single godown, the destination
        # MUST be that godown — overrides whatever the client sent.
        # Defence-in-depth: the frontend also disables the destination
        # dropdown when a lock is in effect, but never trust the client.
        # Admins are never locked (helper returns None).
        try:
            locked_dest = _user_locked_godown()
            if locked_dest:
                dest_godown_id = locked_dest
        except Exception:
            pass

        if not dest_godown_id:
            return jsonify({"status": "error", "message": "Destination godown required"}), 400
        if not items and not as_draft:
            return jsonify({"status": "error", "message": "Add at least one item"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            clean = []
            for it in items:
                mid = int(it.get("material_id") or 0)
                qty = float(it.get("qty_requested") or 0)
                if mid <= 0 or qty <= 0:
                    continue
                clean.append({
                    "material_id": mid,
                    "qty_requested": qty,
                    "remarks": (it.get("remarks") or "").strip() or None,
                })
            if not clean and not as_draft:
                conn.close()
                return jsonify({"status": "error", "message": "No valid items in payload"}), 400

            if as_draft:
                # Drafts: status='draft', a TEMP request_no (real RM-MR number is
                # assigned only at Submit). request_no is UNIQUE, so we insert a
                # placeholder then set DRAFT-<id> once we have the row id.
                import uuid as _uuid
                tmp_no = "DRAFT-TMP-" + _uuid.uuid4().hex[:12]
                cur = conn.execute(
                    """INSERT INTO inventory_material_requests
                         (request_no, request_date, dest_godown_id, source_godown_id,
                          requested_by, status, remarks)
                       VALUES (%s, %s, %s, %s, %s, 'draft', %s)""",
                    (tmp_no, request_date, int(dest_godown_id), source_godown_id,
                     _user(), remarks),
                )
                rid = cur.lastrowid if hasattr(cur, "lastrowid") else None
                if rid is None:
                    rid = conn.execute("SELECT LAST_INSERT_ID() AS i").fetchone()
                    rid = rid["i"] if hasattr(rid, "get") else rid[0]
                request_no = f"DRAFT-{rid}"
                conn.execute(
                    "UPDATE inventory_material_requests SET request_no=%s WHERE id=%s",
                    (request_no, rid),
                )
                for it in clean:
                    conn.execute(
                        """INSERT INTO inventory_material_request_items
                             (request_id, material_id, qty_requested, remarks)
                           VALUES (%s, %s, %s, %s)""",
                        (rid, it["material_id"], it["qty_requested"], it["remarks"]),
                    )
                conn.commit(); conn.close()
                return jsonify({"status": "ok", "id": rid, "request_no": request_no, "draft": True})

            request_no = _next_request_no(conn)
            cur = conn.execute(
                """INSERT INTO inventory_material_requests
                     (request_no, request_date, dest_godown_id, source_godown_id,
                      requested_by, status, remarks)
                   VALUES (%s, %s, %s, %s, %s, 'pending', %s)""",
                (request_no, request_date, int(dest_godown_id), source_godown_id,
                 _user(), remarks),
            )
            rid = cur.lastrowid if hasattr(cur, "lastrowid") else None
            if rid is None:
                rid = conn.execute("SELECT LAST_INSERT_ID() AS i").fetchone()
                rid = rid["i"] if hasattr(rid, "get") else rid[0]
            for it in clean:
                conn.execute(
                    """INSERT INTO inventory_material_request_items
                         (request_id, material_id, qty_requested, remarks)
                       VALUES (%s, %s, %s, %s)""",
                    (rid, it["material_id"], it["qty_requested"], it["remarks"]),
                )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "id": rid, "request_no": request_no})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── SUBMIT A DRAFT ─────────────────────────────────────────────────────
    # Finalize a draft: assign the real RM-MR number and flip status to
    # 'pending' so fulfillers can see and fulfil it. Requester/admin only.
    @app.route(f"{PFX}/<int:rid>/submit", methods=["POST"])
    @_login_required
    def api_inv_mr_submit(rid):
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, status, requested_by FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not r:
                conn.close(); return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[1]
            requested_by = r["requested_by"] if hasattr(r, "get") else r[2]
            if status != "draft":
                conn.close()
                return jsonify({"status": "error", "message": "Only a draft can be submitted."}), 400
            if not (_is_admin() or requested_by == _user()):
                conn.close()
                return jsonify({"status": "error",
                                "message": "Only the requester or an admin can submit this draft."}), 403
            # Must have at least one item to submit.
            cnt = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_material_request_items WHERE request_id=%s", (rid,),
            ).fetchone()
            n = int((cnt["c"] if hasattr(cnt, "get") else cnt[0]) or 0)
            if n < 1:
                conn.close()
                return jsonify({"status": "error",
                                "message": "Add at least one item before submitting."}), 400

            real_no = _next_request_no(conn)
            conn.execute(
                "UPDATE inventory_material_requests SET request_no=%s, status='pending' WHERE id=%s",
                (real_no, rid),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok", "id": rid, "request_no": real_no})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── ADD AN ITEM TO A DRAFT ─────────────────────────────────────────────
    # Append a material line to an existing DRAFT (used by Godown View's
    # "Add to request"). Always adds a NEW line (no merge). Requester/admin,
    # draft only.
    @app.route(f"{PFX}/<int:rid>/add_item", methods=["POST"])
    @_login_required
    def api_inv_mr_add_item(rid):
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        d = request.get_json(silent=True) or {}
        mid = int(d.get("material_id") or 0)
        qty = float(d.get("qty_requested") or 0)
        src_godown_id = int(d.get("src_godown_id") or 0)  # godown the item is at
        remarks = (d.get("remarks") or "").strip() or None
        if mid <= 0 or qty <= 0:
            return jsonify({"status": "error", "message": "Valid material_id and qty required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, status, requested_by, request_no, dest_godown_id "
                "FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not r:
                conn.close(); return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[1]
            requested_by = r["requested_by"] if hasattr(r, "get") else r[2]
            req_no = r["request_no"] if hasattr(r, "get") else r[3]
            dest_gid = r["dest_godown_id"] if hasattr(r, "get") else r[4]
            if status != "draft":
                conn.close()
                return jsonify({"status": "error",
                                "message": "Items can only be added to a draft."}), 400
            if not (_is_admin() or requested_by == _user()):
                conn.close()
                return jsonify({"status": "error",
                                "message": "Only the draft's owner or an admin can add items."}), 403
            # Hard stop: don't request a material into the very godown it's
            # already in (source == destination is a no-op move).
            if src_godown_id and int(dest_gid or 0) == src_godown_id:
                conn.close()
                return jsonify({"status": "error",
                                "message": "This material is already at the request's destination godown — nothing to request."}), 400
            conn.execute(
                """INSERT INTO inventory_material_request_items
                     (request_id, material_id, qty_requested, remarks)
                   VALUES (%s, %s, %s, %s)""",
                (rid, mid, qty, remarks),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok", "request_no": req_no})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── LIST ──────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/list", methods=["GET"])
    @_login_required
    def api_inv_mr_list():
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        conn = sampling_portal.get_db_connection()
        try:
            st = (request.args.get("status") or "").strip()
            fdate = (request.args.get("from_date") or "").strip()
            tdate = (request.args.get("to_date") or "").strip()
            search = (request.args.get("search") or "").strip()
            mine = request.args.get("mine") == "1"

            where, params = [], []
            if st:
                where.append("r.status=%s"); params.append(st)
            if fdate:
                where.append("r.request_date >= %s"); params.append(fdate)
            if tdate:
                where.append("r.request_date <= %s"); params.append(tdate)
            if mine:
                where.append("r.requested_by=%s"); params.append(_user() or "")
            if search:
                where.append("(r.request_no LIKE %s OR r.remarks LIKE %s)")
                params.extend([f"%{search}%", f"%{search}%"])
            # Drafts are private to their creator (and admins). Everyone else
            # must not see another user's unsubmitted drafts in any list.
            if not _is_admin():
                where.append("(r.status <> 'draft' OR r.requested_by=%s)")
                params.append(_user() or "")
            where_sql = (" WHERE " + " AND ".join(where)) if where else ""

            rows = conn.execute(
                f"""SELECT r.id, r.request_no, r.request_date, r.dest_godown_id,
                           r.source_godown_id, r.requested_by, r.status, r.remarks,
                           r.created_at,
                           COALESCE(g.name,'')  AS dest_godown_name,
                           COALESCE(gs.name,'') AS source_godown_name,
                           (SELECT COUNT(*) FROM inventory_material_request_items
                              WHERE request_id=r.id) AS item_count,
                           COALESCE((SELECT SUM(qty_requested)
                              FROM inventory_material_request_items
                              WHERE request_id=r.id), 0) AS total_requested,
                           COALESCE((SELECT SUM(qty_fulfilled)
                              FROM inventory_material_request_items
                              WHERE request_id=r.id), 0) AS total_fulfilled
                    FROM inventory_material_requests r
                    LEFT JOIN procurement_godowns g  ON g.id  = r.dest_godown_id
                    LEFT JOIN procurement_godowns gs ON gs.id = r.source_godown_id
                    {where_sql}
                    ORDER BY r.id DESC""",
                tuple(params),
            ).fetchall()

            out = []
            for r in rows:
                dd = dict(r)
                if hasattr(dd.get("request_date"), "isoformat"):
                    dd["request_date"] = dd["request_date"].isoformat()
                if dd.get("created_at") is not None:
                    dd["created_at"] = str(dd["created_at"])
                dd["total_requested"] = float(dd.get("total_requested") or 0)
                dd["total_fulfilled"] = float(dd.get("total_fulfilled") or 0)
                out.append(dd)
            conn.close()
            return jsonify({"status": "ok", "requests": out, "count": len(out)})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── DETAIL ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/<int:rid>", methods=["GET"])
    @_login_required
    def api_inv_mr_detail(rid):
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                """SELECT r.*, COALESCE(g.name,'')  AS dest_godown_name,
                          COALESCE(gs.name,'') AS source_godown_name
                   FROM inventory_material_requests r
                   LEFT JOIN procurement_godowns g  ON g.id  = r.dest_godown_id
                   LEFT JOIN procurement_godowns gs ON gs.id = r.source_godown_id
                   WHERE r.id=%s""",
                (rid,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404

            items = conn.execute(
                """SELECT ri.id, ri.material_id, ri.qty_requested, ri.qty_fulfilled,
                          ri.remarks,
                          COALESCE(m.material_name, '') AS material_name,
                          COALESCE(m.uom, '')           AS uom
                   FROM inventory_material_request_items ri
                   LEFT JOIN procurement_materials m ON m.id = ri.material_id
                   WHERE ri.request_id=%s
                   ORDER BY ri.id""",
                (rid,),
            ).fetchall()

            story = conn.execute(
                """SELECT l.id, l.request_item_id, l.transfer_id, l.box_id,
                          l.qty_fulfilled, l.fulfilled_by, l.fulfilled_at,
                          t.transfer_no, t.status AS transfer_status,
                          t.in_by AS received_by, t.in_at AS received_at,
                          ri.material_id, COALESCE(m.material_name,'') AS material_name,
                          COALESCE(bx.box_code,'') AS box_code
                   FROM inventory_material_request_links l
                   JOIN inventory_material_request_items ri ON ri.id = l.request_item_id
                   LEFT JOIN rm_stock_transfers t ON t.transfer_id = l.transfer_id
                   LEFT JOIN procurement_materials m ON m.id = ri.material_id
                   LEFT JOIN rm_boxes bx ON bx.box_id = l.box_id
                   WHERE ri.request_id=%s
                   ORDER BY l.fulfilled_at, l.id""",
                (rid,),
            ).fetchall()

            rh = dict(r)
            for k in ("request_date", "cancelled_at", "created_at"):
                v = rh.get(k)
                if hasattr(v, "isoformat"):
                    rh[k] = v.isoformat() if k == "request_date" else str(v)

            item_list = []
            for it in items:
                dd = dict(it)
                dd["qty_requested"] = float(dd.get("qty_requested") or 0)
                dd["qty_fulfilled"] = float(dd.get("qty_fulfilled") or 0)
                item_list.append(dd)

            story_list = []
            for s in story:
                sd = dict(s)
                for k in ("fulfilled_at", "received_at"):
                    if hasattr(sd.get(k), "isoformat"):
                        sd[k] = str(sd[k])
                sd["qty_fulfilled"] = float(sd.get("qty_fulfilled") or 0)
                story_list.append(sd)

            conn.close()
            return jsonify({
                "status": "ok", "request": rh,
                "items": item_list, "story": story_list,
            })
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── CANCEL ────────────────────────────────────────────────────────────
    @app.route(f"{PFX}/cancel", methods=["POST"])
    @_login_required
    def api_inv_mr_cancel():
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        d = request.get_json(silent=True) or {}
        rid = int(d.get("id") or 0)
        reason = (d.get("reason") or "").strip() or None
        if not rid:
            return jsonify({"status": "error", "message": "id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by "
                "FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[2]
            requested_by = r["requested_by"] if hasattr(r, "get") else r[3]
            req_no = r["request_no"] if hasattr(r, "get") else r[1]

            if status == "cancelled":
                conn.close()
                return jsonify({"status": "error", "message": "Already cancelled."}), 400
            if status == "fulfilled":
                conn.close()
                return jsonify({"status": "error", "message": "Already fulfilled — can't cancel."}), 400

            is_admin = _is_admin()
            is_requester = (requested_by == _user())
            if status in ("draft", "pending"):
                if not (is_admin or is_requester):
                    conn.close()
                    return jsonify({"status": "error",
                                    "message": "Only the requester or an admin can cancel."}), 403
            elif status == "in_progress":
                if not is_admin:
                    conn.close()
                    return jsonify({
                        "status": "error",
                        "message": "Fulfilment has started — only an admin can cancel now. "
                                   "Reverse the transfer receipts first for a full rollback.",
                    }), 403
            else:
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Cannot cancel — status is '{status}'."}), 400

            conn.execute(
                """UPDATE inventory_material_requests
                     SET status='cancelled', cancelled_by=%s,
                         cancelled_at=NOW(), cancel_reason=%s
                   WHERE id=%s""",
                (_user(), reason, rid),
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

    # ── PRE-CLOSE ──────────────────────────────────────────────────────────
    # Requester (or admin) closes a request early: keep whatever was already
    # fulfilled, stop further fulfilment. Unlike cancel (a full abort), this is
    # the normal way to say "this is enough, don't fulfil the rest." Allowed
    # while the request is still open (pending or in_progress).
    @app.route(f"{PFX}/preclose", methods=["POST"])
    @_login_required
    def api_inv_mr_preclose():
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        d = request.get_json(silent=True) or {}
        rid = int(d.get("id") or 0)
        reason = (d.get("reason") or "").strip() or None
        if not rid:
            return jsonify({"status": "error", "message": "id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by "
                "FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[2]
            requested_by = r["requested_by"] if hasattr(r, "get") else r[3]

            if status in ("cancelled", "preclosed", "fulfilled"):
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Cannot pre-close — status is '{status}'."}), 400
            # Only the requester or an admin may pre-close.
            if not (_is_admin() or requested_by == _user()):
                conn.close()
                return jsonify({"status": "error",
                                "message": "Only the requester or an admin can pre-close."}), 403

            conn.execute(
                """UPDATE inventory_material_requests
                     SET status='preclosed', preclosed_by=%s,
                         preclosed_at=NOW(), preclose_reason=%s
                   WHERE id=%s""",
                (_user(), reason, rid),
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

    # ── FULFILL PRESENCE (heartbeat) ───────────────────────────────────────
    # The fulfiller's screen calls this on open and on a timer while the
    # fulfill flow for a request is active. Marks them the live fulfiller so
    # item-removal alerts can target them.
    _PRESENCE_TTL_SEC = 35  # a fulfiller seen within this window is "live"

    @app.route(f"{PFX}/<int:rid>/fulfill_heartbeat", methods=["POST"])
    @_login_required
    def api_inv_mr_fulfill_heartbeat(rid):
        u = _user() or ""
        conn = sampling_portal.get_db_connection()
        try:
            conn.execute(
                "INSERT INTO inventory_mr_fulfill_presence (request_id, user_name, last_seen) "
                "VALUES (%s,%s,NOW()) ON DUPLICATE KEY UPDATE last_seen=NOW()",
                (rid, u),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── REMOVE AN ITEM LINE ────────────────────────────────────────────────
    # Requester (or admin) removes one item line. Hard-blocked unless that
    # item's fulfilment hasn't started (qty_fulfilled = 0). Can't remove the
    # last remaining item. On success, raises an OK-required alert to whoever
    # is currently live-fulfilling this request.
    @app.route(f"{PFX}/<int:rid>/remove_item", methods=["POST"])
    @_login_required
    def api_inv_mr_remove_item(rid):
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        d = request.get_json(silent=True) or {}
        item_id = int(d.get("item_id") or 0)
        if not item_id:
            return jsonify({"status": "error", "message": "item_id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not r:
                conn.close(); return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[2]
            requested_by = r["requested_by"] if hasattr(r, "get") else r[3]
            req_no = r["request_no"] if hasattr(r, "get") else r[1]

            if not (_is_admin() or requested_by == _user()):
                conn.close()
                return jsonify({"status": "error",
                                "message": "Only the requester or an admin can remove items."}), 403
            if status in ("cancelled", "preclosed", "fulfilled"):
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Cannot edit items — status is '{status}'."}), 400

            it = conn.execute(
                "SELECT ri.id, ri.qty_fulfilled, COALESCE(m.material_name,'') AS material_name "
                "FROM inventory_material_request_items ri "
                "LEFT JOIN procurement_materials m ON m.id=ri.material_id "
                "WHERE ri.id=%s AND ri.request_id=%s",
                (item_id, rid),
            ).fetchone()
            if not it:
                conn.close(); return jsonify({"status": "error", "message": "Item not found on this request"}), 404
            qf = float((it["qty_fulfilled"] if hasattr(it, "get") else it[1]) or 0)
            mat_name = (it["material_name"] if hasattr(it, "get") else it[2]) or "an item"
            if qf > _EPS:
                conn.close()
                return jsonify({"status": "error",
                                "message": "Fulfilment has already started for this item — it can't be removed."}), 400

            # Don't allow removing the last item (that would empty the request —
            # use Cancel / Pre-close instead).
            cnt = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_material_request_items WHERE request_id=%s", (rid,),
            ).fetchone()
            n = int((cnt["c"] if hasattr(cnt, "get") else cnt[0]) or 0)
            if n <= 1:
                conn.close()
                return jsonify({"status": "error",
                                "message": "This is the only item — cancel or pre-close the request instead."}), 400

            conn.execute("DELETE FROM inventory_material_request_items WHERE id=%s AND request_id=%s",
                         (item_id, rid))

            # Alert the live fulfiller(s) of this request — anyone whose
            # presence heartbeat is within the TTL window.
            live = conn.execute(
                "SELECT user_name FROM inventory_mr_fulfill_presence "
                "WHERE request_id=%s AND last_seen >= (NOW() - INTERVAL %s SECOND) AND user_name <> %s",
                (rid, _PRESENCE_TTL_SEC, _user() or ""),
            ).fetchall()
            msg = (f"Requester removed item “{mat_name}” from {req_no}. "
                   f"It is no longer part of this request — please skip it.")
            for lv in live:
                tu = lv["user_name"] if hasattr(lv, "get") else lv[0]
                conn.execute(
                    "INSERT INTO inventory_mr_alerts (request_id, target_user, message, created_by) "
                    "VALUES (%s,%s,%s,%s)",
                    (rid, tu, msg, _user()),
                )

            # Recompute status (item set changed).
            _recompute_status(conn, rid)
            conn.commit(); conn.close()
            return jsonify({"status": "ok", "alerted": len(live)})
        except Exception as e:
            try: conn.rollback(); conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── ALERT POLL (fulfiller) ─────────────────────────────────────────────
    # The fulfiller's screen polls this; returns any unacked OK-required alerts
    # for the current user. Each must be acknowledged via /alert_ack.
    @app.route(f"{PFX}/alerts_poll", methods=["GET"])
    @_login_required
    def api_inv_mr_alerts_poll():
        u = _user() or ""
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT id, request_id, message, created_by, created_at "
                "FROM inventory_mr_alerts WHERE target_user=%s AND acked=0 ORDER BY id ASC",
                (u,),
            ).fetchall()
            out = []
            for a in rows:
                out.append({
                    "id":         a["id"]         if hasattr(a, "get") else a[0],
                    "request_id": a["request_id"] if hasattr(a, "get") else a[1],
                    "message":    a["message"]    if hasattr(a, "get") else a[2],
                    "created_by": a["created_by"] if hasattr(a, "get") else a[3],
                    "created_at": str(a["created_at"] if hasattr(a, "get") else a[4]),
                })
            conn.close()
            return jsonify({"status": "ok", "alerts": out})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route(f"{PFX}/alert_ack", methods=["POST"])
    @_login_required
    def api_inv_mr_alert_ack():
        d = request.get_json(silent=True) or {}
        aid = int(d.get("id") or 0)
        u = _user() or ""
        if not aid:
            return jsonify({"status": "error", "message": "id required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            # Only the targeted user can ack their own alert.
            conn.execute(
                "UPDATE inventory_mr_alerts SET acked=1, acked_at=NOW() WHERE id=%s AND target_user=%s",
                (aid, u),
            )
            conn.commit(); conn.close()
            return jsonify({"status": "ok"})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── PENDING COUNT (sidebar badge) ──────────────────────────────────────
    @app.route(f"{PFX}/pending_count", methods=["GET"])
    @_login_required
    def api_inv_mr_pending_count():
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM inventory_material_requests "
                "WHERE status IN ('pending','in_progress')"
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

    # ── SOURCE GODOWN STOCK (per material) ────────────────────────────────
    @app.route(f"{PFX}/godown_stock", methods=["GET"])
    @_login_required
    def api_inv_mr_godown_stock():
        """Return in-stock RM qty per material at a given godown, so the create
        form can show available quantity beside each material option.
        Query: ?godown_id=<int>   (omit/0 = all godowns combined)
        Returns: { status:'ok', godown_id, stock: { material_id: qty, ... } }
        """
        try:
            gid = int(request.args.get("godown_id") or 0)
        except Exception:
            gid = 0
        conn = sampling_portal.get_db_connection()
        try:
            where = ["current_status='in_stock'"]
            params = []
            if gid:
                where.append("current_godown_id=%s")
                params.append(gid)
            rows = conn.execute(
                f"""SELECT material_id, COALESCE(SUM(per_box_qty),0) AS qty
                    FROM rm_boxes
                    WHERE {' AND '.join(where)}
                    GROUP BY material_id""",
                tuple(params),
            ).fetchall()
            stock = {}
            for r in rows:
                mid = int(r["material_id"] if hasattr(r, "get") else r[0])
                qty = float((r["qty"] if hasattr(r, "get") else r[1]) or 0)
                stock[str(mid)] = qty
            conn.close()
            return jsonify({"status": "ok", "godown_id": gid, "stock": stock})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── PREFILL OUT (data to build a fulfilling transfer) ─────────────────
    @app.route(f"{PFX}/<int:rid>/prefill_out", methods=["GET"])
    @_login_required
    def api_inv_mr_prefill_out(rid):
        """Return data to pre-fill a fulfilling Stock Transfer for this request:
        destination godown + the request's still-unfulfilled line items."""
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                """SELECT r.id, r.request_no, r.dest_godown_id, r.source_godown_id,
                          r.status, r.remarks,
                          COALESCE(g.name,'')  AS dest_godown_name,
                          COALESCE(gs.name,'') AS source_godown_name
                   FROM inventory_material_requests r
                   LEFT JOIN procurement_godowns g  ON g.id  = r.dest_godown_id
                   LEFT JOIN procurement_godowns gs ON gs.id = r.source_godown_id
                   WHERE r.id=%s""",
                (rid,),
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404
            status = r["status"] if hasattr(r, "get") else r[4]
            if status in ("fulfilled", "cancelled"):
                conn.close()
                return jsonify({"status": "error",
                                "message": f"Cannot fulfill — request is {status}."}), 400

            items = conn.execute(
                """SELECT ri.id, ri.material_id, ri.qty_requested, ri.qty_fulfilled,
                          COALESCE(m.material_name,'') AS material_name,
                          COALESCE(m.uom,'')           AS uom
                   FROM inventory_material_request_items ri
                   LEFT JOIN procurement_materials m ON m.id = ri.material_id
                   WHERE ri.request_id=%s AND ri.qty_requested > ri.qty_fulfilled
                   ORDER BY ri.id""",
                (rid,),
            ).fetchall()
            out_items = []
            for it in items:
                d = dict(it)
                remaining = max(0.0, float(d.get("qty_requested") or 0) - float(d.get("qty_fulfilled") or 0))
                if remaining > 0:
                    out_items.append({
                        "material_id":   int(d["material_id"]),
                        "material_name": d.get("material_name") or "",
                        "uom":           d.get("uom") or "",
                        "qty_remaining": remaining,
                    })
            rd = dict(r)

            # ── Location lock for fulfiller (May 2026) ──
            # When the request was created, the source was whatever the
            # requester picked (or any). When the FULFILLER opens this
            # endpoint, the actual outbound vehicle is THEIR location —
            # so if they're pinned to a godown, override source to it.
            # The fulfiller's lock wins over the request's saved source.
            # We also return the fulfiller's lock explicitly so the
            # Stock Transfer modal can disable the source picker.
            fulfiller_lock = None
            try:
                fulfiller_lock = _user_locked_godown()
            except Exception:
                fulfiller_lock = None
            source_gid  = int(rd["source_godown_id"]) if rd.get("source_godown_id") else None
            source_name = rd.get("source_godown_name") or ""
            if fulfiller_lock:
                source_gid  = int(fulfiller_lock)
                source_name = ""  # will be looked up below
                try:
                    # Re-open since we closed above. Cheap (cached resolver).
                    nc = sampling_portal.get_db_connection()
                    if nc:
                        nrow = nc.execute(
                            "SELECT name FROM procurement_godowns WHERE id=%s",
                            (source_gid,)
                        ).fetchone()
                        if nrow:
                            source_name = nrow.get("name") if hasattr(nrow, "get") else nrow[0]
                        try: nc.close()
                        except Exception: pass
                except Exception:
                    pass

            conn.close()
            return jsonify({
                "status": "ok",
                "request_id":         int(rd["id"]),
                "request_no":         rd["request_no"],
                "dest_godown_id":     int(rd["dest_godown_id"]),
                "dest_godown_name":   rd.get("dest_godown_name") or "",
                "source_godown_id":   source_gid,
                "source_godown_name": source_name,
                # When non-null, frontend MUST disable the source picker
                # in the fulfilling Stock Transfer modal.
                "source_locked":      bool(fulfiller_lock),
                "remarks":            rd.get("remarks") or "",
                "items":              out_items,
            })
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── PREVIEW NEXT REQUEST NUMBER ───────────────────────────────────────
    # Read-only: returns what the next allocated MR number will look like.
    # Used by the New MR screen's "Next MR #" preview chip. Allocation only
    # happens on submit, so this is a hint, not a reservation.
    @app.route(f"{PFX}/preview_next_no", methods=["GET"])
    @_login_required
    def api_inv_mr_preview_next_no():
        conn = sampling_portal.get_db_connection()
        try:
            nxt = _preview_next_request_no(conn)
            conn.close()
            return jsonify({"status": "ok", "request_no": nxt})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── MATERIAL BATCHES (FEFO order at a specific source godown) ─────────
    # Returns in-stock batches for a material at the chosen source godown,
    # ordered first-expiring-first (with created_at as tiebreaker — same
    # ORDER BY as /suggest_boxes). Used by the New MR screen's post-pick
    # popup so users see which batches will be consumed.
    #
    # Query: ?material_id=<int>&source_godown_id=<int>
    @app.route(f"{PFX}/material_batches", methods=["GET"])
    @_login_required
    def api_inv_mr_material_batches():
        try:
            material_id = int(request.args.get("material_id") or 0)
            source_id   = int(request.args.get("source_godown_id") or 0)
        except Exception:
            return jsonify({"status": "error",
                            "message": "material_id and source_godown_id must be integers"}), 400
        if material_id <= 0 or source_id <= 0:
            return jsonify({"status": "error",
                            "message": "material_id and source_godown_id required"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            mat = conn.execute(
                "SELECT id, material_name, uom FROM procurement_materials WHERE id=%s",
                (material_id,),
            ).fetchone()
            if not mat:
                conn.close()
                return jsonify({"status": "error", "message": "Material not found"}), 404

            # ── Schema-defensive query build ─────────────────────────────
            # Different installs have different columns on procurement_grn
            # and procurement_grn_items. Probe what exists, only SELECT what
            # does — missing columns become NULL aliases so downstream code
            # can read `bd.get('h_grn_no')` without crashing.
            def _cols(table):
                try:
                    rows = conn.execute(f"SHOW COLUMNS FROM `{table}`").fetchall()
                    out = set()
                    for r in rows:
                        name = None
                        if isinstance(r, dict):
                            name = r.get("Field") or r.get("field")
                        else:
                            try:    name = r["Field"]
                            except: name = r[0] if len(r) else None
                        if name: out.add(str(name).lower())
                    return out
                except Exception:
                    return set()

            box_cols  = _cols("rm_boxes")
            item_cols = _cols("procurement_grn_items")
            grn_cols  = _cols("procurement_grn")
            sup_cols  = _cols("procurement_suppliers")

            def _opt(prefix, table_cols, col, alias=None):
                a = alias or col
                if col.lower() in table_cols:
                    return f"{prefix}.{col} AS {a}"
                return f"NULL AS {a}"

            # rm_boxes (always present — we just queried mat above so DB is up)
            b_parts = [
                "b.box_id", "b.box_code", "b.per_box_qty",
                _opt("b", box_cols, "grn_no", "box_grn_no"),
                _opt("b", box_cols, "box_seq"),
                _opt("b", box_cols, "created_at"),
                _opt("b", box_cols, "source"),
                _opt("b", box_cols, "batch_num",    "box_batch_num"),
                _opt("b", box_cols, "expiry_date",  "box_expiry_date"),
                _opt("b", box_cols, "manufacturer", "box_manufacturer"),
                _opt("b", box_cols, "grn_item_id"),
            ]
            # procurement_grn_items
            gi_parts = [
                _opt("gi", item_cols, "batch_num"),
                _opt("gi", item_cols, "mfg_date"),
                _opt("gi", item_cols, "expiry_date"),
                _opt("gi", item_cols, "manufacturer"),
                _opt("gi", item_cols, "invoice_num"),
                _opt("gi", item_cols, "invoice_date"),
                # gi.id needed for grouping
                _opt("gi", item_cols, "id", "grn_item_id_from_gi"),
            ]
            # procurement_grn — try grn_no first, then grn_num
            h_parts = [
                _opt("h", grn_cols, "grn_no",  "h_grn_no"),
                _opt("h", grn_cols, "grn_num", "h_grn_num"),
                _opt("h", grn_cols, "grn_date", "h_grn_date"),
                _opt("h", grn_cols, "supplier_name", "h_supplier_name_inline"),
                _opt("h", grn_cols, "supplier_id"),
            ]
            # procurement_suppliers (for supplier_name when only supplier_id is on h)
            s_parts = [
                _opt("s", sup_cols, "supplier_name", "s_supplier_name"),
                _opt("s", sup_cols, "name", "s_supplier_name_alt"),
            ]

            select_list = ", ".join(b_parts + gi_parts + h_parts + s_parts)

            # Build joins, skipping any table that doesn't exist.
            joins = []
            if item_cols and "grn_item_id" in box_cols:
                joins.append("LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, NULL AS batch_num, NULL AS mfg_date, "
                             "NULL AS expiry_date, NULL AS manufacturer, NULL AS invoice_num, "
                             "NULL AS invoice_date) gi ON 1=0")
            if grn_cols and "grn_id" in box_cols:
                joins.append("LEFT JOIN procurement_grn h ON h.id = b.grn_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, NULL AS grn_no, NULL AS grn_num, "
                             "NULL AS grn_date, NULL AS supplier_name, NULL AS supplier_id) h ON 1=0")
            if sup_cols and "supplier_id" in grn_cols:
                joins.append("LEFT JOIN procurement_suppliers s ON s.id = h.supplier_id")
            else:
                joins.append("LEFT JOIN (SELECT NULL AS id, NULL AS supplier_name, NULL AS name) s ON 1=0")

            # FEFO order: by expiry (gi or box-level), then by creation.
            order_by = "ORDER BY "
            if "expiry_date" in item_cols and "expiry_date" in box_cols:
                order_by += "(COALESCE(gi.expiry_date, b.expiry_date) IS NULL), " \
                            "COALESCE(gi.expiry_date, b.expiry_date) ASC, "
            elif "expiry_date" in item_cols:
                order_by += "(gi.expiry_date IS NULL), gi.expiry_date ASC, "
            elif "expiry_date" in box_cols:
                order_by += "(b.expiry_date IS NULL), b.expiry_date ASC, "
            if "created_at" in box_cols:
                order_by += "b.created_at ASC, "
            order_by += "b.box_id ASC"

            sql = (
                f"SELECT {select_list} "
                f"FROM rm_boxes b "
                + " ".join(joins)
                + " WHERE b.material_id=%s AND b.current_godown_id=%s "
                  "AND b.current_status='in_stock' "
                + order_by
            )
            boxes = conn.execute(sql, (material_id, source_id)).fetchall()

            def _date(v):
                if v is None: return ""
                return str(v)[:10]
            def _pick(d, *keys):
                for k in keys:
                    v = d.get(k)
                    if v not in (None, ""): return v
                return ""

            from collections import OrderedDict
            groups = OrderedDict()
            for r in boxes:
                bd = dict(r)
                gi_id = bd.get("grn_item_id") or bd.get("grn_item_id_from_gi")
                key = ("gi", gi_id) if gi_id else \
                      ("op", _pick(bd, "batch_num", "box_batch_num") or "—")
                if key not in groups:
                    grn_no = _pick(bd, "h_grn_no", "h_grn_num", "box_grn_no")
                    if not grn_no and key[0] == "op":
                        grn_no = "OPENING"
                    elif not grn_no:
                        grn_no = "—"
                    supplier = _pick(bd, "h_supplier_name_inline",
                                         "s_supplier_name", "s_supplier_name_alt")
                    if not supplier and key[0] == "op":
                        supplier = "Opening Stock"
                    groups[key] = {
                        "key":          str(key[0]) + ":" + str(key[1]),
                        "batch_num":    _pick(bd, "batch_num", "box_batch_num") or "—",
                        "grn_no":       grn_no,
                        "grn_date":     _date(bd.get("h_grn_date")),
                        "supplier":     supplier or "",
                        "invoice_no":   bd.get("invoice_num") or "",
                        "invoice_date": _date(bd.get("invoice_date")),
                        "mfg_date":     _date(bd.get("mfg_date")),
                        "expiry_date":  _date(_pick(bd, "expiry_date", "box_expiry_date")),
                        "manufacturer": _pick(bd, "manufacturer", "box_manufacturer") or "",
                        "uom":          mat["uom"] or "",
                        "boxes":        [],
                        "box_count":    0,
                        "total_qty":    0.0,
                    }
                qty = float(bd.get("per_box_qty") or 0)
                groups[key]["boxes"].append({
                    "box_id":      int(bd["box_id"]),
                    "box_code":    bd.get("box_code") or "",
                    "per_box_qty": qty,
                    "box_seq":     int(bd.get("box_seq") or 0),
                })
                groups[key]["box_count"] += 1
                groups[key]["total_qty"]  += qty

            batches = []
            for g in groups.values():
                qtys = [b["per_box_qty"] for b in g["boxes"]] or [0]
                g["per_box_qty_min"] = min(qtys)
                g["per_box_qty_max"] = max(qtys)
                batches.append(g)

            totals = {
                "total_qty":   sum(b["total_qty"]  for b in batches),
                "total_boxes": sum(b["box_count"]  for b in batches),
            }
            conn.close()
            return jsonify({
                "status":           "ok",
                "material_id":      material_id,
                "material_name":    mat["material_name"],
                "uom":               mat["uom"] or "",
                "source_godown_id": source_id,
                "batches":          batches,
                "totals":           totals,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            import traceback; traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── SUGGEST BOXES (FIFO pick to meet remaining qty) ───────────────────
    @app.route(f"{PFX}/<int:rid>/suggest_boxes", methods=["GET"])
    @_login_required
    def api_inv_mr_suggest_boxes(rid):
        """Suggest specific in-stock boxes at a source godown to fulfil each
        line's remaining qty. FIFO by created_at (oldest first) — Phase 3 will
        switch this to FEFO by expiry. Query: ?source_godown_id=<int>"""
        blocked = _block_if_no_mr_access()
        if blocked is not None:
            return blocked
        try:
            source_id = int(request.args.get("source_godown_id") or 0)
        except Exception:
            source_id = 0
        if source_id <= 0:
            return jsonify({"status": "error", "message": "source_godown_id required"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            req = conn.execute(
                "SELECT id, request_no, status FROM inventory_material_requests WHERE id=%s",
                (rid,),
            ).fetchone()
            if not req:
                conn.close()
                return jsonify({"status": "error", "message": "Request not found"}), 404

            items = conn.execute(
                """SELECT ri.id AS item_id, ri.material_id, ri.qty_requested,
                          ri.qty_fulfilled,
                          COALESCE(m.material_name,'') AS material_name,
                          COALESCE(m.uom,'')           AS uom
                   FROM inventory_material_request_items ri
                   LEFT JOIN procurement_materials m ON m.id = ri.material_id
                   WHERE ri.request_id=%s""",
                (rid,),
            ).fetchall()

            suggestions = []
            for it in items:
                d = dict(it)
                requested = float(d.get("qty_requested") or 0)
                fulfilled = float(d.get("qty_fulfilled") or 0)
                remaining = requested - fulfilled
                if remaining <= _EPS:
                    continue
                mid = int(d["material_id"])
                boxes = conn.execute(
                    """SELECT b.box_id, b.box_code, b.per_box_qty, b.grn_no,
                              b.box_seq, b.created_at, gi.expiry_date
                       FROM rm_boxes b
                       LEFT JOIN procurement_grn_items gi ON gi.id = b.grn_item_id
                       WHERE b.material_id=%s AND b.current_godown_id=%s
                         AND b.current_status='in_stock'
                       ORDER BY (gi.expiry_date IS NULL), gi.expiry_date ASC,
                                b.created_at ASC, b.box_id ASC""",
                    (mid, source_id),
                ).fetchall()
                picked, acc = [], 0.0
                for b in boxes:
                    if acc >= remaining:
                        break
                    bd = dict(b)
                    qty = float(bd.get("per_box_qty") or 0)
                    if qty <= 0:
                        continue
                    picked.append({
                        "box_id":      int(bd["box_id"]),
                        "box_code":    bd.get("box_code") or "",
                        "per_box_qty": qty,
                        "grn_no":      bd.get("grn_no") or "",
                        "box_seq":     int(bd.get("box_seq") or 0),
                        "expiry_date": str(bd.get("expiry_date")) if bd.get("expiry_date") else None,
                        "created_at":  str(bd.get("created_at")) if bd.get("created_at") else None,
                    })
                    acc += qty
                suggestions.append({
                    "item_id":       int(d["item_id"]),
                    "material_id":   mid,
                    "material_name": d.get("material_name") or "",
                    "uom":           d.get("uom") or "",
                    "qty_requested": requested,
                    "qty_fulfilled": fulfilled,
                    "qty_remaining": remaining,
                    "boxes_to_pick": len(picked),
                    "qty_picked":    acc,
                    "over_by":       max(0.0, acc - remaining),
                    "shortage":      max(0.0, remaining - acc),
                    "boxes":         picked,
                })
            conn.close()
            return jsonify({
                "status": "ok", "request_id": rid,
                "source_godown_id": source_id, "suggestions": suggestions,
            })
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryMR] routes registered (/api/inventory_mgmt/material_request/*)")
