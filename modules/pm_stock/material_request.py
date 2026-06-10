"""
Material Request feature — pre-order workflow for PM stock.

Why this is a separate file
---------------------------
The pm_stock package's __init__.py has grown to ~13k lines covering GRN,
MTV, DN, transfers, opening stock, audit, reprint, suppliers, godowns,
products, voucher numbering. Adding another non-trivial domain (Material
Request) into the same file makes it harder to read, harder to grep, and
noisier to diff. This feature is:

  - Self-contained (its own 3 tables, ~8 routes).
  - Cleanly bounded (one cross-domain touchpoint: the Material OUT save
    endpoint calls _link_transfer_to_request when a request_id is on
    the payload).
  - Likely to evolve over time (workflow tweaks, notifications, etc.).

Routes are registered onto the EXISTING `pm_stock_bp` blueprint via
`register_routes(bp)` rather than creating a sibling blueprint, so the
parent Flask app's import wiring needs no changes. __init__.py imports
this module and calls `register_routes(pm_stock_bp)` once at module load.

Domain model
------------
Three tables (defined in helpers.ensure_pm_tables):

  pm_material_requests       — one row per request voucher (header).
  pm_material_request_items  — one row per line item (product + qty_requested).
  pm_material_request_links  — junction; ties a request line to one or more
                               Material OUT transfer rows. The sum of
                               links.qty_fulfilled per request item drives
                               that item's qty_fulfilled column AND the
                               parent request's status.

Status auto-progression (see _recompute_status):
  - 0  fulfilled       → 'pending'
  - some, not all      → 'in_progress'
  - every line covered → 'fulfilled'
  - manual override    → 'cancelled' (only while still at 0 fulfilled)

Integration with Material OUT
-----------------------------
The Material OUT save endpoint accepts an optional `request_id` parameter
on its payload. When present, after the transfer and its items are
committed, the OUT handler calls _link_transfer_to_request() which creates
one link row per matched item and recomputes the parent request's status.
Reverse (admin delete of an OUT) calls _unlink_transfer_from_request().
"""

from flask import request, jsonify
from datetime import datetime, date
import sampling_portal


# Imported lazily inside register_routes() to avoid a circular import when
# helpers.py itself does `from .helpers import *` somewhere upstream.
_helpers = None
def _load_helpers():
    global _helpers
    if _helpers is None:
        from . import helpers as _h
        _helpers = _h
    return _helpers


# ════════════════════════════════════════════════════════════════════
# Internal helpers — exported for use by Material OUT integration
# ════════════════════════════════════════════════════════════════════

def _recompute_status(conn, request_id):
    """Recompute (and persist) the status of one request based on its
    items' qty_fulfilled vs qty_requested.

    Called by _link_transfer_to_request and the unlink endpoint. Does
    NOT touch an already-cancelled request — cancel is terminal.
    """
    cur = conn.execute(
        "SELECT status FROM pm_material_requests WHERE id=%s",
        (request_id,)
    ).fetchone()
    if not cur or cur['status'] in ('cancelled', 'closed'):
        return
    items = conn.execute(
        "SELECT qty_requested, qty_fulfilled FROM pm_material_request_items WHERE request_id=%s",
        (request_id,)
    ).fetchall()
    if not items:
        return
    EPS = 0.001
    any_fulfilled = False
    all_complete  = True
    for it in items:
        req = float(it['qty_requested'] or 0)
        ful = float(it['qty_fulfilled'] or 0)
        if ful > EPS:
            any_fulfilled = True
        if ful + EPS < req:
            all_complete = False
    new_status = 'fulfilled' if all_complete else ('in_progress' if any_fulfilled else 'pending')
    if new_status != cur['status']:
        conn.execute(
            "UPDATE pm_material_requests SET status=%s WHERE id=%s",
            (new_status, request_id)
        )


def _link_transfer_to_request(conn, request_id, transfer_id, transfer_items, fulfilled_by):
    """Wire a freshly-saved Material OUT transfer to a Material Request.

    Called by the Material OUT save endpoint AFTER both the parent transfer
    row and its child transfer items are committed. Matches each transfer
    item to the request's line for the same product_id and writes a link
    row. If the request has multiple lines for one product (unusual via
    the UI), only the first match consumes the transfer item.

    transfer_items: list of dicts each with at least {'id', 'product_id', 'qty'}
    fulfilled_by:   login name of the user who saved the OUT

    Best-effort: any failure logs to stderr and returns 0 so the OUT save
    never fails because of a request-link issue.
    """
    if not request_id or not transfer_id or not transfer_items:
        return 0
    try:
        req_items = conn.execute(
            """SELECT id, product_id, qty_requested, qty_fulfilled
               FROM pm_material_request_items
               WHERE request_id=%s""",
            (request_id,)
        ).fetchall()
        if not req_items:
            return 0
        ri_by_pid = {}
        for ri in req_items:
            ri_by_pid.setdefault(int(ri['product_id']), dict(ri))

        linked = 0
        for ti in transfer_items:
            pid = int(ti.get('product_id') or 0)
            qty = float(ti.get('qty') or 0)
            tid = int(ti.get('id') or 0)
            if not pid or qty <= 0:
                continue
            ri = ri_by_pid.get(pid)
            if not ri:
                continue
            conn.execute(
                """INSERT INTO pm_material_request_links
                     (request_item_id, transfer_id, transfer_item_id,
                      qty_fulfilled, fulfilled_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                (int(ri['id']), int(transfer_id), tid, qty, fulfilled_by or 'unknown')
            )
            conn.execute(
                "UPDATE pm_material_request_items SET qty_fulfilled = qty_fulfilled + %s WHERE id=%s",
                (qty, int(ri['id']))
            )
            linked += 1
        _recompute_status(conn, int(request_id))
        return linked
    except Exception as e:
        import sys
        print(f"[material_request] _link_transfer_to_request failed: {e}", file=sys.stderr)
        return 0


def _unlink_transfer_from_request(conn, transfer_id):
    """Reverse the linking when a Material OUT transfer is force-deleted /
    admin-deleted. Removes the link rows, decrements qty_fulfilled,
    recomputes status for each affected request. Best-effort.
    """
    if not transfer_id:
        return 0
    try:
        links = conn.execute(
            """SELECT l.id, l.request_item_id, l.qty_fulfilled, ri.request_id
               FROM pm_material_request_links l
               JOIN pm_material_request_items ri ON ri.id = l.request_item_id
               WHERE l.transfer_id=%s""",
            (int(transfer_id),)
        ).fetchall()
        if not links:
            return 0
        affected_reqs = set()
        for ln in links:
            conn.execute(
                "UPDATE pm_material_request_items SET qty_fulfilled = GREATEST(0, qty_fulfilled - %s) WHERE id=%s",
                (float(ln['qty_fulfilled'] or 0), int(ln['request_item_id']))
            )
            conn.execute("DELETE FROM pm_material_request_links WHERE id=%s", (int(ln['id']),))
            affected_reqs.add(int(ln['request_id']))
        for rid in affected_reqs:
            _recompute_status(conn, rid)
        return len(links)
    except Exception as e:
        import sys
        print(f"[material_request] _unlink_transfer_from_request failed: {e}", file=sys.stderr)
        return 0


# ════════════════════════════════════════════════════════════════════
# Routes — registered via register_routes(bp) called from __init__.py
# ════════════════════════════════════════════════════════════════════

def register_routes(bp):
    """Mount the Material Request endpoints onto the given blueprint.

    The blueprint is the main pm_stock_bp; routes share the existing
    /api/pm_stock/... namespace.
    """
    H = _load_helpers()
    _login_required = H._login_required
    _user           = H._user
    _is_admin       = H._is_admin
    _next_voucher_no= H._next_voucher_no
    _audit_record   = H._audit_record

    # Defensive migration: ensure the per-item product_version column exists
    # even if the helpers' startup migration didn't run (e.g. helpers.py not
    # redeployed, or the worker hadn't restarted). Idempotent — safe to run on
    # every register_routes(). Prevents "Unknown column 'ri.product_version'".
    try:
        _mc = sampling_portal.get_db_connection()
        try:
            _mc.execute("ALTER TABLE pm_material_request_items ADD COLUMN product_version VARCHAR(60) DEFAULT NULL")
            _mc.commit()
        except Exception:
            pass  # already exists
        finally:
            try: _mc.close()
            except Exception: pass
    except Exception:
        pass

    @bp.route('/api/pm_stock/material_request/save', methods=['POST'])
    @_login_required
    def api_mr_save():
        """Create a new Material Request.

        Body
        ----
        {
          "request_date":   "YYYY-MM-DD",  // defaults to today
          "dest_godown_id": <int>,         // where the material is needed
          "remarks":        "...",         // optional
          "items": [
            { "product_id": <int>, "qty_requested": <float>, "remarks": "..." },
            ...
          ]
        }
        """
        d = request.get_json() or {}
        request_date  = d.get('request_date') or str(date.today())
        dest_godown_id= d.get('dest_godown_id')
        # Optional — requester can suggest where material should come
        # from. NULL means fulfiller decides at OUT-creation time.
        source_godown_id = d.get('source_godown_id')
        try:
            source_godown_id = int(source_godown_id) if source_godown_id else None
        except Exception:
            source_godown_id = None
        # Optional BOM source-tracking. When the MR was auto-built from
        # a BOM via the "From BOM" shortcut, the frontend posts the BOM
        # id, the version it saw at calc time, and the FG quantity that
        # generated these line items. Stored verbatim — the MR items
        # themselves are the actual recipe snapshot; these are the
        # audit trail showing where the recipe came from.
        source_bom_id      = d.get('source_bom_id')
        source_bom_version = d.get('source_bom_version')
        source_bom_qty     = d.get('source_bom_qty')
        try:    source_bom_id      = int(source_bom_id) if source_bom_id else None
        except Exception: source_bom_id = None
        try:    source_bom_version = int(source_bom_version) if source_bom_version else None
        except Exception: source_bom_version = None
        try:    source_bom_qty     = float(source_bom_qty) if source_bom_qty else None
        except Exception: source_bom_qty = None

        remarks       = (d.get('remarks') or '').strip() or None
        items         = d.get('items') or []
        if not dest_godown_id:
            return jsonify({'status':'error','message':'Destination location required'}), 400
        if not items:
            return jsonify({'status':'error','message':'Add at least one item'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            clean_items = []
            for it in items:
                pid = int(it.get('product_id') or 0)
                qty = float(it.get('qty_requested') or 0)
                if pid <= 0 or qty <= 0:
                    continue
                # UOM (Phase 3) — the requester may have typed in the product's
                # alternate UOM (e.g. "45000 Nos" when primary is Kg). The
                # frontend has already converted to primary in qty_requested;
                # entered_uom + entered_qty preserve user intent so the voucher
                # print can show "45,000 Nos = 3 Kg".
                e_uom = (it.get('entered_uom') or '').strip() or None
                try:
                    e_qty = float(it.get('entered_qty')) if it.get('entered_qty') not in (None, '') else None
                except (TypeError, ValueError):
                    e_qty = None
                # Defensive: if frontend sent entered_uom but no entered_qty,
                # drop the UOM tag — we won't make up a number. Conversely if
                # entered_qty came without a UOM, drop it too (meaningless).
                if not e_uom or e_qty is None or e_qty <= 0:
                    e_uom = None; e_qty = None
                clean_items.append({
                    'product_id':      pid,
                    'qty_requested':   qty,
                    'remarks':         (it.get('remarks') or '').strip() or None,
                    'product_version': (it.get('product_version') or '').strip() or None,
                    'entered_uom':     e_uom,
                    'entered_qty':     e_qty,
                })
            if not clean_items:
                conn.close()
                return jsonify({'status':'error','message':'No valid items in payload'}), 400

            request_no = _next_voucher_no(conn, 'PM-MR', request_date)
            cur = conn.execute(
                """INSERT INTO pm_material_requests
                     (request_no, request_date, dest_godown_id, source_godown_id,
                      requested_by, status, remarks,
                      source_bom_id, source_bom_version, source_bom_qty)
                   VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s, %s, %s)""",
                (request_no, request_date, int(dest_godown_id), source_godown_id,
                 _user(), remarks,
                 source_bom_id, source_bom_version, source_bom_qty)
            )
            rid = cur.lastrowid
            for it in clean_items:
                conn.execute(
                    """INSERT INTO pm_material_request_items
                         (request_id, product_id, qty_requested, remarks, product_version,
                          entered_uom, entered_qty)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (rid, it['product_id'], it['qty_requested'], it['remarks'], it['product_version'],
                     it['entered_uom'], it['entered_qty'])
                )

            try:
                _audit_record(
                    conn,
                    action='material_request.create',
                    entity='material_request',
                    entity_id=rid,
                    summary=f"Material Request {request_no} · {len(clean_items)} item(s) · for godown_id={dest_godown_id}",
                    before=None,
                    after={
                        'request_no':   request_no,
                        'request_date': str(request_date),
                        'dest_godown_id': int(dest_godown_id),
                        'item_count':   len(clean_items),
                    }
                )
            except Exception: pass

            conn.commit(); conn.close()
            return jsonify({'status':'ok', 'id': rid, 'request_no': request_no})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/list', methods=['GET'])
    @_login_required
    def api_mr_list():
        """List requests with optional filters. Query params:
           status, from_date, to_date, requested_by, search, mine=1.
        """
        conn = sampling_portal.get_db_connection()
        try:
            st     = (request.args.get('status') or '').strip()
            fdate  = (request.args.get('from_date') or '').strip()
            tdate  = (request.args.get('to_date') or '').strip()
            reqby  = (request.args.get('requested_by') or '').strip()
            search = (request.args.get('search') or '').strip()
            mine   = request.args.get('mine') == '1'

            where = []
            params = []
            if st == 'open':
                where.append("r.status IN ('pending','in_progress')")
            elif st:
                where.append("r.status=%s"); params.append(st)
            if fdate:
                where.append("r.request_date >= %s"); params.append(fdate)
            if tdate:
                where.append("r.request_date <= %s"); params.append(tdate)
            if reqby:
                where.append("r.requested_by LIKE %s"); params.append(f'%{reqby}%')
            if mine:
                where.append("r.requested_by=%s"); params.append(_user() or '')
            if search:
                # Search hits request_no, remarks, OR any product name/code
                # inside the request's items. Surfaces requests by mentioned
                # SKU (e.g. typing "shampoo" finds requests containing a
                # shampoo line item even if the request_no/remarks don't
                # mention it).
                like = f'%{search}%'
                where.append("""(
                    r.request_no LIKE %s
                    OR r.remarks LIKE %s
                    OR EXISTS (
                        SELECT 1 FROM pm_material_request_items ri
                        LEFT JOIN pm_products p ON p.id = ri.product_id
                        WHERE ri.request_id = r.id
                          AND (p.product_name LIKE %s
                               OR p.product_code LIKE %s)
                    )
                )""")
                params.extend([like, like, like, like])
            where_sql = (" WHERE " + " AND ".join(where)) if where else ""

            rows = conn.execute(
                f"""SELECT r.id, r.request_no, r.request_date, r.dest_godown_id,
                           r.requested_by, r.status, r.remarks, r.created_at,
                           COALESCE(g.name,'') AS dest_godown_name,
                           (SELECT COUNT(*) FROM pm_material_request_items WHERE request_id=r.id) AS item_count,
                           COALESCE((SELECT SUM(qty_requested) FROM pm_material_request_items WHERE request_id=r.id), 0) AS total_requested,
                           COALESCE((SELECT SUM(qty_fulfilled) FROM pm_material_request_items WHERE request_id=r.id), 0) AS total_fulfilled
                    FROM pm_material_requests r
                    LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
                    {where_sql}
                    ORDER BY r.id DESC""",
                tuple(params)
            ).fetchall()

            out = []
            _healed = False
            for r in rows:
                d = dict(r)
                if hasattr(d.get('request_date'), 'isoformat'):
                    d['request_date'] = d['request_date'].isoformat()
                if hasattr(d.get('created_at'), 'isoformat'):
                    d['created_at'] = str(d['created_at'])
                # Cast Decimal → float for JSON
                d['total_requested'] = float(d.get('total_requested') or 0)
                d['total_fulfilled'] = float(d.get('total_fulfilled') or 0)
                # Self-heal: if a request shows in_progress but is actually
                # fully fulfilled per its items, recompute it so the status
                # matches reality (e.g. _recompute_status didn't run after the
                # final fulfilment). Only attempt when it looks complete.
                if (d.get('status') == 'in_progress'
                        and d['total_requested'] > 0
                        and d['total_fulfilled'] + 0.001 >= d['total_requested']):
                    try:
                        _recompute_status(conn, d['id'])
                        nr = conn.execute("SELECT status FROM pm_material_requests WHERE id=%s", (d['id'],)).fetchone()
                        if nr and nr['status'] != d['status']:
                            d['status'] = nr['status']; _healed = True
                    except Exception:
                        pass
                out.append(d)
            if _healed:
                try: conn.commit()
                except Exception: pass

            conn.close()
            return jsonify({'status':'ok', 'requests': out, 'count': len(out)})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/<int:rid>', methods=['GET'])
    @_login_required
    def api_mr_detail(rid):
        """Detail of one request — header, items, and fulfillment story."""
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                """SELECT r.*, COALESCE(g.name,'') AS dest_godown_name
                   FROM pm_material_requests r
                   LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
                   WHERE r.id=%s""",
                (rid,)
            ).fetchone()
            if not r:
                conn.close()
                return jsonify({'status':'error','message':'Request not found'}), 404
            items = conn.execute(
                """SELECT ri.id, ri.product_id, ri.qty_requested, ri.qty_fulfilled, ri.remarks,
                          COALESCE(ri.product_version,'') AS product_version,
                          COALESCE(ri.entered_uom,'')     AS entered_uom,
                          ri.entered_qty                  AS entered_qty,
                          p.product_name, p.pm_type,
                          COALESCE(p.primary_uom,'Nos')   AS primary_uom,
                          COALESCE(p.alt_uom,'')          AS alt_uom,
                          p.alt_to_primary_ratio          AS alt_to_primary_ratio
                   FROM pm_material_request_items ri
                   LEFT JOIN pm_products p ON p.id = ri.product_id
                   WHERE ri.request_id=%s
                   ORDER BY ri.id""",
                (rid,)
            ).fetchall()
            story = conn.execute(
                """SELECT l.id, l.request_item_id, l.transfer_id, l.qty_fulfilled,
                          l.fulfilled_by, l.fulfilled_at,
                          t.transfer_no, t.status AS transfer_status,
                          t.in_by    AS received_by,
                          t.in_at    AS received_at,
                          ri.product_id, p.product_name
                   FROM pm_material_request_links l
                   JOIN pm_material_request_items ri ON ri.id = l.request_item_id
                   LEFT JOIN pm_transfers  t ON t.transfer_id = l.transfer_id
                   LEFT JOIN pm_products   p ON p.id = ri.product_id
                   WHERE ri.request_id=%s
                   ORDER BY l.fulfilled_at, l.id""",
                (rid,)
            ).fetchall()

            rh = dict(r)
            for k in ('request_date', 'cancelled_at', 'created_at'):
                if hasattr(rh.get(k), 'isoformat'):
                    rh[k] = str(rh[k]) if k != 'request_date' else rh[k].isoformat()

            item_list = []
            for it in items:
                d = dict(it)
                d['qty_requested'] = float(d.get('qty_requested') or 0)
                d['qty_fulfilled'] = float(d.get('qty_fulfilled') or 0)
                item_list.append(d)
            story_list = []
            for s in story:
                sd = dict(s)
                if hasattr(sd.get('fulfilled_at'), 'isoformat'):
                    sd['fulfilled_at'] = str(sd['fulfilled_at'])
                # Same stringification for the IN-side timestamp.
                if hasattr(sd.get('received_at'), 'isoformat'):
                    sd['received_at'] = str(sd['received_at'])
                sd['qty_fulfilled'] = float(sd.get('qty_fulfilled') or 0)
                story_list.append(sd)

            conn.close()
            return jsonify({'status':'ok', 'request': rh, 'items': item_list, 'story': story_list})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/cancel', methods=['POST'])
    @_login_required
    def api_mr_cancel():
        """Cancel a request. Allowed only when status is 'pending' AND
        the current user is the requester OR is an admin. Once any
        fulfillment exists, the OUT vouchers must be reversed first.
        """
        d = request.get_json() or {}
        rid = int(d.get('id') or 0)
        reason = (d.get('reason') or '').strip() or None
        if not rid:
            return jsonify({'status':'error','message':'id required'}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by FROM pm_material_requests WHERE id=%s",
                (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
            if r['status'] == 'cancelled':
                conn.close(); return jsonify({'status':'error','message':'Already cancelled.'}), 400
            if r['status'] == 'fulfilled':
                conn.close(); return jsonify({'status':'error','message':"Already fulfilled — can't cancel."}), 400

            is_admin = _is_admin()
            is_requester = (r['requested_by'] == _user())

            # Status-based authorisation matrix:
            #   pending     → requester OR admin can cancel
            #   in_progress → ONLY admin can cancel (requester is locked out
            #                 once fulfilment activity has started, even if
            #                 only one box has been scanned into an OUT)
            #
            # The frontend already hides the Cancel button for non-admins
            # when status != 'pending'; this server check is the defensive
            # second line so a manually-crafted POST can't bypass the UI.
            if r['status'] == 'pending':
                if not (is_admin or is_requester):
                    conn.close(); return jsonify({'status':'error','message':'Only the requester or an admin can cancel.'}), 403
            elif r['status'] == 'in_progress':
                if not is_admin:
                    conn.close(); return jsonify({
                        'status':'error',
                        'message':'Fulfilment has started on this request — only an admin can cancel now. Ask an admin to reverse the OUT vouchers first if you need a full rollback.'
                    }), 403
            else:
                conn.close(); return jsonify({'status':'error','message':f"Cannot cancel — status is '{r['status']}'."}), 400

            # If admin is force-cancelling an in_progress request, we leave
            # the existing fulfilment link rows in place — they're a
            # historical record. An admin who wants to UNLINK the transfers
            # too should use api_mr_unlink_transfer separately.
            conn.execute(
                """UPDATE pm_material_requests
                     SET status='cancelled', cancelled_by=%s, cancelled_at=NOW(), cancel_reason=%s
                   WHERE id=%s""",
                (_user(), reason, rid)
            )
            try:
                _audit_record(
                    conn,
                    action='material_request.cancel',
                    entity='material_request',
                    entity_id=rid,
                    summary=f"Material Request {r['request_no']} cancelled (was {r['status']})",
                    before={'status': r['status']},
                    after={'status': 'cancelled', 'reason': reason, 'cancelled_by': _user()},
                )
            except Exception: pass

            conn.commit(); conn.close()
            return jsonify({'status':'ok'})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/close', methods=['POST'])
    @_login_required
    def api_mr_close():
        """PRE-CLOSE a request early, with a mandatory reason.

        Unlike cancel (only at 0 fulfilment), pre-close means "stop here — I
        don't need the rest." It's allowed while the request is 'pending' or
        'in_progress', by the REQUESTER or an admin. Whatever has already been
        fulfilled stays on the record; the request moves to terminal status
        'closed' and will not auto-progress again.

        Body: { id, reason }  (reason required)
        """
        d = request.get_json() or {}
        rid = int(d.get('id') or 0)
        reason = (d.get('reason') or '').strip()
        if not rid:
            return jsonify({'status':'error','message':'id required'}), 400
        if not reason:
            return jsonify({'status':'error','message':'A reason is required to pre-close a request.'}), 400
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by FROM pm_material_requests WHERE id=%s",
                (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
            if r['status'] in ('fulfilled', 'cancelled', 'closed'):
                conn.close(); return jsonify({
                    'status':'error',
                    'message': f"Can't pre-close — request is already '{r['status']}'."
                }), 400

            # Requester or admin only (same trust boundary as cancel/edit).
            if not (_is_admin() or r['requested_by'] == _user()):
                conn.close(); return jsonify({'status':'error','message':'Only the requester or an admin can pre-close this request.'}), 403

            # Move to terminal 'closed'. We reuse the cancelled_* columns to
            # record who closed it + why (they read naturally as "ended by /
            # ended at / reason"); the status disambiguates close vs cancel.
            conn.execute(
                """UPDATE pm_material_requests
                     SET status='closed', cancelled_by=%s, cancelled_at=NOW(), cancel_reason=%s
                   WHERE id=%s""",
                (_user(), reason, rid)
            )
            try:
                _audit_record(
                    conn, action='material_request.close', entity='material_request',
                    entity_id=rid,
                    summary=f"Material Request {r['request_no']} pre-closed (was {r['status']})",
                    before={'status': r['status']},
                    after={'status': 'closed', 'reason': reason, 'closed_by': _user()},
                )
            except Exception: pass
            conn.commit(); conn.close()
            return jsonify({'status':'ok'})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/update', methods=['POST'])
    @_login_required
    def api_mr_update():
        """Edit a request's header + items. Allowed ONLY while the request is
        still 'pending' (no fulfilment has started) AND the current user is the
        requester or an admin. Once any line has been fulfilled (status
        'in_progress'/'fulfilled'), editing is refused — the items are locked.

        Because a pending request has zero fulfilment, it is safe to fully
        replace its item rows (no qty_fulfilled to preserve, no link rows).

        Body: { id, request_date?, dest_godown_id, source_godown_id?, remarks?,
                items:[{product_id, qty_requested, remarks?}, ...] }
        """
        d = request.get_json() or {}
        rid = int(d.get('id') or 0)
        if not rid:
            return jsonify({'status':'error','message':'id required'}), 400
        items = d.get('items') or []
        dest_godown_id = d.get('dest_godown_id')
        if not dest_godown_id:
            return jsonify({'status':'error','message':'Destination location required'}), 400
        if not items:
            return jsonify({'status':'error','message':'Add at least one item'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by FROM pm_material_requests WHERE id=%s",
                (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404

            # Lifecycle guard — editing only before fulfilment starts.
            if r['status'] != 'pending':
                conn.close(); return jsonify({
                    'status':'error',
                    'message': (f"This request is '{r['status']}' — fulfilment has started, so its items "
                                "can no longer be edited. Ask an admin to reverse the OUT vouchers first if a change is needed.")
                }), 409

            # Authorisation — requester or admin only.
            if not (_is_admin() or r['requested_by'] == _user()):
                conn.close(); return jsonify({'status':'error','message':'Only the requester or an admin can edit this request.'}), 403

            # Validate items.
            clean_items = []
            for it in items:
                pid = int(it.get('product_id') or 0)
                qty = float(it.get('qty_requested') or 0)
                if pid <= 0 or qty <= 0:
                    continue
                e_uom = (it.get('entered_uom') or '').strip() or None
                try:
                    e_qty = float(it.get('entered_qty')) if it.get('entered_qty') not in (None, '') else None
                except (TypeError, ValueError):
                    e_qty = None
                if not e_uom or e_qty is None or e_qty <= 0:
                    e_uom = None; e_qty = None
                clean_items.append({
                    'product_id':      pid,
                    'qty_requested':   qty,
                    'remarks':         (it.get('remarks') or '').strip() or None,
                    'product_version': (it.get('product_version') or '').strip() or None,
                    'entered_uom':     e_uom,
                    'entered_qty':     e_qty,
                })
            if not clean_items:
                conn.close(); return jsonify({'status':'error','message':'No valid items in payload'}), 400

            # Optional header fields.
            request_date = d.get('request_date') or None
            remarks = (d.get('remarks') or '').strip() or None
            src = d.get('source_godown_id')
            try: src = int(src) if src else None
            except Exception: src = None

            # Update header.
            sets = ["dest_godown_id=%s", "source_godown_id=%s", "remarks=%s"]
            params = [int(dest_godown_id), src, remarks]
            if request_date:
                sets.append("request_date=%s"); params.append(request_date)
            params.append(rid)
            conn.execute(f"UPDATE pm_material_requests SET {', '.join(sets)} WHERE id=%s", tuple(params))

            # Replace items (safe: pending → no fulfilment/link rows exist).
            conn.execute("DELETE FROM pm_material_request_items WHERE request_id=%s", (rid,))
            for it in clean_items:
                conn.execute(
                    """INSERT INTO pm_material_request_items
                         (request_id, product_id, qty_requested, remarks, product_version,
                          entered_uom, entered_qty)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (rid, it['product_id'], it['qty_requested'], it['remarks'], it['product_version'],
                     it['entered_uom'], it['entered_qty'])
                )

            try:
                _audit_record(
                    conn, action='material_request.update', entity='material_request',
                    entity_id=rid,
                    summary=f"Material Request {r['request_no']} edited · {len(clean_items)} item(s)",
                    before={'status': 'pending'},
                    after={'dest_godown_id': int(dest_godown_id), 'item_count': len(clean_items),
                           'edited_by': _user()},
                )
            except Exception: pass

            conn.commit(); conn.close()
            return jsonify({'status':'ok', 'id': rid, 'item_count': len(clean_items)})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/remove_item', methods=['POST'])
    @_login_required
    def api_mr_remove_item():
        """Remove a SINGLE line item from a request, as long as fulfilment has
        not started FOR THAT ITEM (its qty_fulfilled is 0). This works even
        when the overall request is 'in_progress' because other items were
        started — the boundary here is per-item, not per-request.

        Allowed for the requester or an admin. Refuses to remove the last
        remaining item (use cancel / pre-close for that instead).

        Body: { request_id, item_id }
        """
        d = request.get_json() or {}
        rid = int(d.get('request_id') or 0)
        item_id = int(d.get('item_id') or 0)
        if not rid or not item_id:
            return jsonify({'status':'error','message':'request_id and item_id required'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status, requested_by FROM pm_material_requests WHERE id=%s",
                (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
            if r['status'] in ('fulfilled', 'cancelled', 'closed'):
                conn.close(); return jsonify({
                    'status':'error',
                    'message': f"Request is '{r['status']}' — items can no longer be changed."
                }), 409
            if not (_is_admin() or r['requested_by'] == _user()):
                conn.close(); return jsonify({'status':'error','message':'Only the requester or an admin can remove items.'}), 403

            it = conn.execute(
                "SELECT id, product_id, qty_requested, qty_fulfilled FROM pm_material_request_items WHERE id=%s AND request_id=%s",
                (item_id, rid)
            ).fetchone()
            if not it:
                conn.close(); return jsonify({'status':'error','message':'Item not found on this request'}), 404

            # Per-item fulfilment guard — the whole point of this endpoint.
            if float(it['qty_fulfilled'] or 0) > 0:
                conn.close(); return jsonify({
                    'status':'error',
                    'message': "This item can't be removed — fulfilment has already started for it. "
                               "You can only remove items that haven't been fulfilled at all."
                }), 409

            # Don't allow emptying the request via item removal.
            total = conn.execute(
                "SELECT COUNT(*) AS n FROM pm_material_request_items WHERE request_id=%s", (rid,)
            ).fetchone()
            if int(total['n'] or 0) <= 1:
                conn.close(); return jsonify({
                    'status':'error',
                    'message': "This is the only item left — cancel or pre-close the whole request instead of removing it."
                }), 409

            # Safe to delete: no fulfilment on this line, so no links exist.
            conn.execute("DELETE FROM pm_material_request_links WHERE request_item_id=%s", (item_id,))
            conn.execute("DELETE FROM pm_material_request_items WHERE id=%s AND request_id=%s", (item_id, rid))

            # The request may need its status recomputed (e.g. removing an
            # unstarted item from an otherwise-fulfilled set could complete it).
            try: _recompute_status(conn, rid)
            except Exception: pass

            try:
                _audit_record(
                    conn, action='material_request.remove_item', entity='material_request',
                    entity_id=rid,
                    summary=f"Removed an unfulfilled item from Material Request {r['request_no']}",
                    before={'item_id': item_id, 'product_id': it['product_id'],
                            'qty_requested': float(it['qty_requested'] or 0)},
                    after={'removed_by': _user()},
                )
            except Exception: pass

            conn.commit(); conn.close()
            return jsonify({'status':'ok', 'request_id': rid, 'item_id': item_id})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/<int:rid>/status_diag', methods=['GET'])
    @_login_required
    def api_mr_status_diag(rid):
        """Diagnostic: per-item requested vs fulfilled for a request, plus the
        status the recompute logic derives. Read-only — explains why a request
        is/isn't 'fulfilled' even when the aggregate totals look complete."""
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                "SELECT id, request_no, status FROM pm_material_requests WHERE id=%s", (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Not found'}), 404
            items = conn.execute(
                """SELECT i.id, i.product_id, COALESCE(p.product_name,'') AS product_name,
                          i.qty_requested, i.qty_fulfilled
                   FROM pm_material_request_items i
                   LEFT JOIN pm_products p ON p.id=i.product_id
                   WHERE i.request_id=%s ORDER BY i.id""", (rid,)
            ).fetchall()
            EPS = 0.001
            rows = []; all_complete = True; any_ful = False
            tot_req = 0.0; tot_ful = 0.0
            for it in items:
                req = float(it['qty_requested'] or 0); ful = float(it['qty_fulfilled'] or 0)
                tot_req += req; tot_ful += ful
                complete = (ful + EPS >= req)
                over = (ful > req + EPS)
                if ful > EPS: any_ful = True
                if not complete: all_complete = False
                rows.append({
                    'item_id': it['id'], 'product_name': it['product_name'],
                    'qty_requested': req, 'qty_fulfilled': ful,
                    'complete': complete, 'over_fulfilled': over,
                    'short_by': round(max(0, req - ful), 3),
                })
            derived = 'fulfilled' if all_complete else ('in_progress' if any_ful else 'pending')
            conn.close()
            return jsonify({
                'status': 'ok',
                'request_no': r['request_no'],
                'current_status': r['status'],
                'derived_status': derived,
                'aggregate': {'requested': tot_req, 'fulfilled': tot_ful,
                              'aggregate_complete': tot_ful + EPS >= tot_req},
                'items': rows,
                'explanation': (
                    'Aggregate looks complete but at least one ITEM is still short, '
                    'so status stays in_progress (per-item rule).'
                    if (tot_ful + EPS >= tot_req and not all_complete)
                    else ('All items complete — should be fulfilled.' if all_complete
                          else 'Some items still short.')
                ),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/recompute_status', methods=['POST'])
    @_login_required
    def api_mr_recompute_status():
        """Re-derive status for non-terminal requests from their items'
        qty_fulfilled vs qty_requested. Fixes stale statuses (e.g. a request
        that became fully fulfilled but wasn't flipped to 'fulfilled' because
        _recompute_status didn't run after the last fulfilment).

        Body (optional): { id } to recompute a single request; omit for all.
        Returns the ids whose status changed.
        """
        d = request.get_json() or {}
        rid = d.get('id')
        conn = sampling_portal.get_db_connection()
        try:
            if rid:
                ids = [int(rid)]
            else:
                rows = conn.execute(
                    "SELECT id FROM pm_material_requests WHERE status IN ('pending','in_progress')"
                ).fetchall()
                ids = [r['id'] for r in rows]
            changed = []
            for _id in ids:
                before = conn.execute(
                    "SELECT status FROM pm_material_requests WHERE id=%s", (_id,)
                ).fetchone()
                if not before:
                    continue
                _recompute_status(conn, _id)
                after = conn.execute(
                    "SELECT status FROM pm_material_requests WHERE id=%s", (_id,)
                ).fetchone()
                if after and after['status'] != before['status']:
                    changed.append({'id': _id, 'from': before['status'], 'to': after['status']})
            conn.commit(); conn.close()
            return jsonify({'status': 'ok', 'checked': len(ids), 'changed': changed})
        except Exception as e:
            conn.close()
            return jsonify({'status': 'error', 'message': str(e)}), 500


    @bp.route('/api/pm_stock/material_request/product_version_options', methods=['GET'])
    @_login_required
    def api_mr_product_version_options():
        """Flat list of pickable product+version lines for the Material Request
        item picker, so the requester can choose a specific in-stock variant
        directly (e.g. "[Box] Beardo Oil · OLD DESIGN").

        For each product, returns:
          - one line per distinct in-stock version (product_version != ''),
          - PLUS a base line with version='' (any/unversioned) so products
            with no version tags — or when the requester doesn't care — are
            still pickable.
        Optional ?source_godown_id=<id> scopes stock to one location.
        Products with NO stock at all still appear as a base ('any') line so
        the requester isn't blocked from requesting something out of stock.
        """
        src = request.args.get('source_godown_id')
        conn = sampling_portal.get_db_connection()
        try:
            # All active products (base lines).
            prods = conn.execute(
                """SELECT id, product_name, pm_type,
                          COALESCE(product_code,'') AS product_code,
                          COALESCE(primary_uom,'Nos') AS primary_uom,
                          COALESCE(alt_uom,'')        AS alt_uom,
                          alt_to_primary_ratio        AS alt_to_primary_ratio
                   FROM pm_products WHERE COALESCE(is_active,1)=1
                   ORDER BY product_name"""
            ).fetchall()

            # Per-product TOTAL in-stock quantity (units) — shown beside the
            # name on the base "any version" line. Sums per_box_qty over all
            # in-stock boxes regardless of version.
            tparams = []
            twhere = "current_status='in_stock'"
            if src:
                twhere += " AND current_godown_id=%s"; tparams.append(int(src))
            trows = conn.execute(
                f"""SELECT product_id,
                           COUNT(*) AS box_count,
                           COALESCE(SUM(per_box_qty),0) AS qty
                    FROM pm_boxes
                    WHERE {twhere}
                    GROUP BY product_id""",
                tparams
            ).fetchall()
            tot_map = {int(r['product_id']): {'box_count': int(r['box_count'] or 0),
                                              'qty': float(r['qty'] or 0)} for r in trows}

            # In-stock versions per product (with box count + qty).
            vparams = []
            vwhere = "b.current_status='in_stock' AND TRIM(COALESCE(b.product_version,'')) <> ''"
            if src:
                vwhere += " AND b.current_godown_id=%s"; vparams.append(int(src))
            vrows = conn.execute(
                f"""SELECT b.product_id,
                           TRIM(b.product_version) AS version,
                           COUNT(*) AS box_count,
                           COALESCE(SUM(b.per_box_qty),0) AS qty
                    FROM pm_boxes b
                    WHERE {vwhere}
                    GROUP BY b.product_id, TRIM(b.product_version)
                    ORDER BY box_count DESC""",
                vparams
            ).fetchall()
            conn.close()
            ver_map = {}
            for r in vrows:
                ver_map.setdefault(int(r['product_id']), []).append(
                    {'version': r['version'], 'box_count': int(r['box_count'] or 0),
                     'qty': float(r['qty'] or 0)})
            options = []
            for p in prods:
                pid = int(p['id'])
                base = {
                    'product_id': pid,
                    'product_name': p['product_name'] or '',
                    'pm_type': p['pm_type'] or '',
                    'product_code': p['product_code'] or '',
                    # UOM (Phase 3) — let the frontend show stock and qty
                    # entry in the alternate unit when configured.
                    # stock_qty stays in primary; the frontend converts
                    # for display + reverses on save.
                    'primary_uom': p.get('primary_uom') or 'Nos',
                    'alt_uom':     p.get('alt_uom') or '',
                    'alt_to_primary_ratio': (float(p['alt_to_primary_ratio'])
                                             if p.get('alt_to_primary_ratio') is not None else None),
                }
                tot = tot_map.get(pid, {'box_count': 0, 'qty': 0})
                # Base (any/unversioned) line first — carries the product's
                # total available stock qty so it shows beside the name.
                options.append({**base, 'version': '', 'box_count': None,
                                'stock_qty': tot['qty'], 'total_box_count': tot['box_count']})
                # Then a line per in-stock version (with that version's qty).
                for v in ver_map.get(pid, []):
                    options.append({**base, 'version': v['version'],
                                    'box_count': v['box_count'], 'stock_qty': v['qty']})
            return jsonify({'status': 'ok', 'options': options, 'count': len(options)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500


    @bp.route('/api/pm_stock/material_request/product_versions/<int:product_id>', methods=['GET'])
    @_login_required
    def api_mr_product_versions(product_id):
        """Return the distinct product_version values for a product that are
        currently IN STOCK (boxes with status in_stock), so the requester can
        pick the specific version they want — and the fulfiller ships it.

        Optional ?source_godown_id=<id> restricts to one location's stock.
        Returns versions with a rough available box count, plus whether any
        unversioned ('') stock exists.
        """
        src = request.args.get('source_godown_id')
        conn = sampling_portal.get_db_connection()
        try:
            params = [product_id]
            where = "b.product_id=%s AND b.current_status='in_stock'"
            if src:
                where += " AND b.current_godown_id=%s"; params.append(int(src))
            rows = conn.execute(
                f"""SELECT COALESCE(NULLIF(TRIM(b.product_version),''),'') AS version,
                           COUNT(*) AS box_count
                    FROM pm_boxes b
                    WHERE {where}
                    GROUP BY COALESCE(NULLIF(TRIM(b.product_version),''),'')
                    ORDER BY box_count DESC""",
                params
            ).fetchall()
            conn.close()
            versions = []
            has_unversioned = False
            for r in rows:
                v = (r['version'] or '').strip()
                if not v:
                    has_unversioned = True
                    continue
                versions.append({'version': v, 'box_count': int(r['box_count'] or 0)})
            return jsonify({
                'status': 'ok',
                'product_id': product_id,
                'versions': versions,             # named versions in stock
                'has_unversioned': has_unversioned # plain stock with no version tag
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500


    @bp.route('/api/pm_stock/material_request/pending_count', methods=['GET'])
    @_login_required
    def api_mr_pending_count():
        """Cheap counter for the sidebar badge. Returns count of requests
        anyone could still fulfill — status IN (pending, in_progress).
        """
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM pm_material_requests WHERE status IN ('pending','in_progress')"
            ).fetchone()
            conn.close()
            return jsonify({'status':'ok', 'count': int(row.get('c', 0)) if row else 0})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/<int:rid>/prefill_out', methods=['GET'])
    @_login_required
    def api_mr_prefill_out(rid):
        """Return data to pre-fill a Material OUT modal from this request.
        Items returned only include lines with remaining qty.
        """
        conn = sampling_portal.get_db_connection()
        try:
            r = conn.execute(
                """SELECT r.id, r.request_no, r.dest_godown_id, r.status, r.remarks,
                          COALESCE(g.name,'') AS dest_godown_name
                   FROM pm_material_requests r
                   LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
                   WHERE r.id=%s""",
                (rid,)
            ).fetchone()
            if not r:
                conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
            if r['status'] in ('fulfilled','cancelled'):
                conn.close(); return jsonify({'status':'error','message':f"Cannot fulfill — request is {r['status']}."}), 400

            items = conn.execute(
                """SELECT ri.id, ri.product_id, ri.qty_requested, ri.qty_fulfilled,
                          ri.remarks, COALESCE(ri.product_version,'') AS product_version,
                          COALESCE(ri.entered_uom,'')   AS entered_uom,
                          ri.entered_qty                AS entered_qty,
                          p.product_name, p.pm_type,
                          COALESCE(p.primary_uom,'Nos') AS primary_uom,
                          COALESCE(p.alt_uom,'')        AS alt_uom,
                          p.alt_to_primary_ratio        AS alt_to_primary_ratio
                   FROM pm_material_request_items ri
                   LEFT JOIN pm_products p ON p.id = ri.product_id
                   WHERE ri.request_id=%s
                     AND ri.qty_requested > ri.qty_fulfilled
                   ORDER BY ri.id""",
                (rid,)
            ).fetchall()
            out_items = []
            for it in items:
                req = float(it['qty_requested'] or 0)
                ful = float(it['qty_fulfilled'] or 0)
                remaining = max(0.0, req - ful)
                if remaining > 0:
                    _r = it.get('alt_to_primary_ratio')
                    out_items.append({
                        'product_id':   int(it['product_id']),
                        'product_name': it.get('product_name') or '',
                        'pm_type':      it.get('pm_type') or '',
                        'qty':          remaining,           # primary
                        'remarks':      it.get('remarks') or '',
                        'product_version': it.get('product_version') or '',
                        # UOM (Phase 3) — fulfiller-side display data.
                        'primary_uom':  it.get('primary_uom') or 'Nos',
                        'alt_uom':      it.get('alt_uom') or '',
                        'alt_to_primary_ratio': float(_r) if _r is not None else None,
                        'entered_uom':  it.get('entered_uom') or '',
                        'entered_qty':  float(it['entered_qty']) if it.get('entered_qty') is not None else None,
                    })
            conn.close()
            return jsonify({
                'status': 'ok',
                'request_id':       int(r['id']),
                'request_no':       r['request_no'],
                'dest_godown_id':   int(r['dest_godown_id']),
                'dest_godown_name': r.get('dest_godown_name') or '',
                'remarks':          r.get('remarks') or '',
                'items':            out_items,
            })
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/<int:rid>/suggest_boxes', methods=['GET'])
    @_login_required
    def api_mr_suggest_boxes(rid):
        """Suggest specific boxes to scan to fulfill the remaining qty
        for each line item on a Material Request. Used by the OUT modal
        when the fulfiller arrives via the "Fulfill MR" button to help
        them pick the right physical boxes without manual math.

        Algorithm per line item:
          1. Compute qty_remaining = qty_requested - qty_fulfilled.
             Skip lines where remaining <= 0.
          2. Pull all in-stock boxes at the source godown for the line's
             product, ordered FIFO by created_at (oldest box first).
             Excludes already-consumed / in-transit boxes.
          3. Greedy pack from FIFO order. Stop when accumulated qty
             matches or EXCEEDS remaining (i.e. minimum boxes meeting
             the target). The final box may push the picked total over
             by less than one box's worth.
          4. Return the box list + summary (boxes_to_pick, qty_picked,
             over_by, partial_hint flag).

        Query parameter `source_godown_id` is required so we know which
        location's stock to pull from. The frontend passes the same
        godown the OUT voucher was created with.

        Returns 200 with status:ok and an array of per-product
        suggestions. Items where insufficient stock exists at source
        get marked with `shortage` > 0 and `boxes_to_pick` = however
        many were available.
        """
        try:
            source_id = int(request.args.get('source_godown_id') or 0)
        except Exception:
            source_id = 0
        if source_id <= 0:
            return jsonify({'status':'error','message':'source_godown_id required'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            req_row = conn.execute(
                "SELECT id, request_no, status FROM pm_material_requests WHERE id=%s",
                (rid,)
            ).fetchone()
            if not req_row:
                conn.close()
                return jsonify({'status':'error','message':'Request not found'}), 404

            # Per-item remaining qty
            items = conn.execute(
                """SELECT ri.id AS item_id, ri.product_id, ri.qty_requested, ri.remarks,
                          COALESCE(ri.product_version,'') AS product_version,
                          COALESCE(SUM(l.qty_fulfilled), 0) AS qty_fulfilled,
                          p.product_name, p.product_code, p.pm_type
                   FROM pm_material_request_items ri
                   LEFT JOIN pm_material_request_links l ON l.request_item_id = ri.id
                   LEFT JOIN pm_products p ON p.id = ri.product_id
                   WHERE ri.request_id = %s
                   GROUP BY ri.id, ri.product_id, ri.qty_requested, ri.remarks, ri.product_version,
                            p.product_name, p.product_code, p.pm_type""",
                (rid,)
            ).fetchall()

            suggestions = []
            for it in items:
                requested = float(it['qty_requested'] or 0)
                fulfilled = float(it['qty_fulfilled'] or 0)
                remaining = requested - fulfilled
                if remaining <= 0:
                    continue

                product_id = int(it['product_id'])

                # Pull in-stock boxes at the source for this product,
                # FIFO by created_at then box_id. Only in_stock status —
                # in_transit / consumed boxes are unavailable.
                #
                # NOTE: `current_status='in_stock'` is the canonical
                # availability flag. The godown_id on the box row is
                # kept current by the stock movement code, so filtering
                # by it gives us the live source location.
                boxes = conn.execute(
                    """SELECT b.box_id, b.box_code, b.short_code,
                              b.per_box_qty, b.grn_no, b.grn_id,
                              b.created_at, b.box_seq
                       FROM pm_boxes b
                       WHERE b.product_id = %s
                         AND b.current_godown_id = %s
                         AND b.current_status = 'in_stock'
                       ORDER BY b.created_at, b.box_id""",
                    (product_id, source_id)
                ).fetchall()

                # Greedy pack
                picked = []
                acc = 0.0
                for b in boxes:
                    if acc >= remaining:
                        break
                    qty = float(b['per_box_qty'] or 0)
                    if qty <= 0:
                        continue
                    picked.append({
                        'box_id':       int(b['box_id']),
                        'box_code':     b['box_code'] or '',
                        'short_code':   b['short_code'] or '',
                        'per_box_qty':  qty,
                        'grn_no':       b['grn_no'] or '',
                        'box_seq':      int(b['box_seq'] or 0),
                        'created_at':   str(b['created_at']) if b.get('created_at') else None,
                    })
                    acc += qty

                # Compute summary
                per_box = float(picked[0]['per_box_qty']) if picked else 0
                # "Partial hint" applies when:
                #   - We picked enough (acc >= remaining)
                #   - The picked total exceeds remaining (acc > remaining)
                #   - AND remaining isn't a whole-box multiple at per_box
                partial_hint = (
                    acc >= remaining
                    and acc > remaining
                    and per_box > 0
                )

                suggestions.append({
                    'item_id':        int(it['item_id']),
                    'product_id':     product_id,
                    'product_name':   it.get('product_name') or '',
                    'product_code':   it.get('product_code') or '',
                    'pm_type':        it.get('pm_type') or '',
                    'remarks':        it.get('remarks') or '',
                    'product_version': it.get('product_version') or '',
                    'qty_requested':  requested,
                    'qty_fulfilled':  fulfilled,
                    'qty_remaining':  remaining,
                    'per_box_qty':    per_box,
                    'boxes_to_pick':  len(picked),
                    'qty_picked':     acc,
                    'over_by':        max(0, acc - remaining),
                    'shortage':       max(0, remaining - acc),
                    'partial_hint':   partial_hint,
                    'boxes':          picked,
                })

            conn.close()
            return jsonify({
                'status':       'ok',
                'request_id':   rid,
                'request_no':   req_row.get('request_no'),
                'source_godown_id': source_id,
                'suggestions':  suggestions,
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500


    @bp.route('/api/pm_stock/material_request/<int:rid>/unlink_transfer', methods=['POST'])
    @_login_required
    def api_mr_unlink_transfer(rid):
        """Admin-only: manually unlink a transfer from a request without
        deleting the OUT itself. Decrements qty_fulfilled, recomputes status.
        """
        if not _is_admin():
            return jsonify({'status':'error','message':'Admin only'}), 403
        d = request.get_json() or {}
        tid = int(d.get('transfer_id') or 0)
        if not tid:
            return jsonify({'status':'error','message':'transfer_id required'}), 400
        conn = sampling_portal.get_db_connection()
        try:
            links = conn.execute(
                """SELECT l.id, l.request_item_id, l.qty_fulfilled
                   FROM pm_material_request_links l
                   JOIN pm_material_request_items ri ON ri.id = l.request_item_id
                   WHERE l.transfer_id=%s AND ri.request_id=%s""",
                (tid, rid)
            ).fetchall()
            if not links:
                conn.close(); return jsonify({'status':'error','message':'No links found between this transfer and this request.'}), 404
            for ln in links:
                conn.execute(
                    "UPDATE pm_material_request_items SET qty_fulfilled = GREATEST(0, qty_fulfilled - %s) WHERE id=%s",
                    (float(ln['qty_fulfilled'] or 0), int(ln['request_item_id']))
                )
                conn.execute("DELETE FROM pm_material_request_links WHERE id=%s", (int(ln['id']),))
            _recompute_status(conn, rid)
            conn.commit(); conn.close()
            return jsonify({'status':'ok', 'unlinked': len(links)})
        except Exception as e:
            conn.close()
            return jsonify({'status':'error','message':str(e)}), 500


from flask import Blueprint, request, jsonify
from datetime import datetime, date
import json
import sampling_portal

from .helpers import (
    _login_required, _user, _is_admin,
    _next_voucher_no,
    _audit_record,    # for the audit trail story
)

# Single blueprint; mounted at the same /api/pm_stock/... prefix as the main
# pm_stock blueprint. We use a distinct name ('pm_stock_mr') so url_for
# collisions aren't possible even though the route URLs share a namespace.
pm_mr_bp = Blueprint('pm_stock_mr', __name__)


# ════════════════════════════════════════════════════════════════════
# Internal helpers
# ════════════════════════════════════════════════════════════════════

def _recompute_status(conn, request_id):
    """Recompute (and persist) the status of a single request based on its
    items' qty_fulfilled vs qty_requested.

    Called by:
      - _link_transfer_to_request (fulfillment hook from Material OUT save)
      - api_mr_unlink (admin reverts a link)

    Does NOT change status of an already-cancelled request — cancel is a
    terminal manual state that should not be overwritten by fulfillment
    activity (an admin would have to un-cancel first, but currently we
    only cancel when nothing has been fulfilled, so this is mostly a
    defensive guard).
    """
    cur = conn.execute(
        "SELECT status FROM pm_material_requests WHERE id=%s",
        (request_id,)
    ).fetchone()
    if not cur or cur['status'] in ('cancelled', 'closed'):
        return
    items = conn.execute(
        "SELECT qty_requested, qty_fulfilled FROM pm_material_request_items WHERE request_id=%s",
        (request_id,)
    ).fetchall()
    if not items:
        return
    EPS = 0.001
    any_fulfilled = False
    all_complete  = True
    for it in items:
        req = float(it['qty_requested'] or 0)
        ful = float(it['qty_fulfilled'] or 0)
        if ful > EPS:
            any_fulfilled = True
        if ful + EPS < req:
            all_complete = False
    new_status = 'fulfilled' if all_complete else ('in_progress' if any_fulfilled else 'pending')
    if new_status != cur['status']:
        conn.execute(
            "UPDATE pm_material_requests SET status=%s WHERE id=%s",
            (new_status, request_id)
        )


def _link_transfer_to_request(conn, request_id, transfer_id, transfer_items, fulfilled_by):
    """Wire a freshly-saved Material OUT transfer to a Material Request.

    Called by the Material OUT save endpoint in __init__.py AFTER both the
    parent transfer row and its child transfer items have been committed.
    Matches each transfer item to the request's line for the same
    product_id and writes a link row. If a single OUT row covers multiple
    request lines for the same product, only the first match consumes
    that transfer item — the remainder gets logged but doesn't double-
    count. (In practice this is fine because requests don't have two
    lines for the same product.)

    Parameters
    ----------
    transfer_items : list of dicts each with at least {'id', 'product_id', 'qty'}
    fulfilled_by   : login name of the user who saved the OUT

    Side effects
    ------------
    - Inserts into pm_material_request_links (one row per matched item)
    - Bumps qty_fulfilled on pm_material_request_items (cached sum)
    - Recomputes parent request status via _recompute_status

    Best-effort: any single failure logs to stderr and continues so an OUT
    save never fails because of a request-linking issue.
    """
    if not request_id or not transfer_id or not transfer_items:
        return 0
    try:
        req_items = conn.execute(
            """SELECT id, product_id, qty_requested, qty_fulfilled
               FROM pm_material_request_items
               WHERE request_id=%s""",
            (request_id,)
        ).fetchall()
        if not req_items:
            return 0
        # Index request items by product_id for fast lookup. If duplicates
        # exist (shouldn't happen via the UI, but be defensive), we accept
        # only the FIRST line per product — sum across duplicates is
        # ambiguous.
        ri_by_pid = {}
        for ri in req_items:
            ri_by_pid.setdefault(int(ri['product_id']), dict(ri))

        linked = 0
        for ti in transfer_items:
            pid = int(ti.get('product_id') or 0)
            qty = float(ti.get('qty') or 0)
            tid = int(ti.get('id') or 0)
            if not pid or qty <= 0:
                continue
            ri = ri_by_pid.get(pid)
            if not ri:
                continue  # this transfer item doesn't correspond to any request line
            conn.execute(
                """INSERT INTO pm_material_request_links
                     (request_item_id, transfer_id, transfer_item_id,
                      qty_fulfilled, fulfilled_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                (int(ri['id']), int(transfer_id), tid, qty, fulfilled_by or 'unknown')
            )
            conn.execute(
                "UPDATE pm_material_request_items SET qty_fulfilled = qty_fulfilled + %s WHERE id=%s",
                (qty, int(ri['id']))
            )
            linked += 1
        _recompute_status(conn, int(request_id))
        return linked
    except Exception as e:
        import sys
        print(f"[material_request] _link_transfer_to_request failed: {e}", file=sys.stderr)
        return 0


def _unlink_transfer_from_request(conn, transfer_id):
    """Reverse the linking when a Material OUT transfer is force-deleted /
    admin-deleted. Removes the link rows and decrements qty_fulfilled.
    Recomputes status for each affected request.

    Best-effort like _link — never raises into the caller.
    """
    if not transfer_id:
        return 0
    try:
        links = conn.execute(
            """SELECT l.id, l.request_item_id, l.qty_fulfilled, ri.request_id
               FROM pm_material_request_links l
               JOIN pm_material_request_items ri ON ri.id = l.request_item_id
               WHERE l.transfer_id=%s""",
            (int(transfer_id),)
        ).fetchall()
        if not links:
            return 0
        affected_reqs = set()
        for ln in links:
            conn.execute(
                "UPDATE pm_material_request_items SET qty_fulfilled = GREATEST(0, qty_fulfilled - %s) WHERE id=%s",
                (float(ln['qty_fulfilled'] or 0), int(ln['request_item_id']))
            )
            conn.execute("DELETE FROM pm_material_request_links WHERE id=%s", (int(ln['id']),))
            affected_reqs.add(int(ln['request_id']))
        for rid in affected_reqs:
            _recompute_status(conn, rid)
        return len(links)
    except Exception as e:
        import sys
        print(f"[material_request] _unlink_transfer_from_request failed: {e}", file=sys.stderr)
        return 0


# ════════════════════════════════════════════════════════════════════
# Endpoints
# ════════════════════════════════════════════════════════════════════

@pm_mr_bp.route('/api/pm_stock/material_request/save', methods=['POST'])
@_login_required
def api_mr_save():
    """Create a new Material Request.

    Body
    ----
    {
      "request_date":   "YYYY-MM-DD",  // defaults to today
      "dest_godown_id": <int>,         // where the material is needed
      "remarks":        "...",         // optional
      "items": [
        { "product_id": <int>, "qty_requested": <float>, "remarks": "..." },
        ...
      ]
    }
    """
    d = request.get_json() or {}
    request_date  = d.get('request_date') or str(date.today())
    dest_godown_id= d.get('dest_godown_id')
    remarks       = (d.get('remarks') or '').strip() or None
    items         = d.get('items') or []
    if not dest_godown_id:
        return jsonify({'status':'error','message':'Destination location required'}), 400
    if not items:
        return jsonify({'status':'error','message':'Add at least one item'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        # Defensive validation
        clean_items = []
        for it in items:
            pid = int(it.get('product_id') or 0)
            qty = float(it.get('qty_requested') or 0)
            if pid <= 0 or qty <= 0:
                continue
            clean_items.append({
                'product_id':    pid,
                'qty_requested': qty,
                'remarks':       (it.get('remarks') or '').strip() or None,
            })
        if not clean_items:
            conn.close()
            return jsonify({'status':'error','message':'No valid items in payload'}), 400

        request_no = _next_voucher_no(conn, 'PM-MR', request_date)
        cur = conn.execute(
            """INSERT INTO pm_material_requests
                 (request_no, request_date, dest_godown_id, requested_by, status, remarks)
               VALUES (%s, %s, %s, %s, 'pending', %s)""",
            (request_no, request_date, int(dest_godown_id), _user(), remarks)
        )
        rid = cur.lastrowid
        for it in clean_items:
            conn.execute(
                """INSERT INTO pm_material_request_items
                     (request_id, product_id, qty_requested, remarks)
                   VALUES (%s, %s, %s, %s)""",
                (rid, it['product_id'], it['qty_requested'], it['remarks'])
            )

        # Audit
        try:
            _audit_record(
                conn,
                action='material_request.create',
                entity='material_request',
                entity_id=rid,
                summary=f"Material Request {request_no} · {len(clean_items)} item(s) · for godown_id={dest_godown_id}",
                before=None,
                after={
                    'request_no':   request_no,
                    'request_date': str(request_date),
                    'dest_godown_id': int(dest_godown_id),
                    'item_count':   len(clean_items),
                }
            )
        except Exception: pass

        conn.commit(); conn.close()
        return jsonify({'status':'ok', 'id': rid, 'request_no': request_no})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/list', methods=['GET'])
@_login_required
def api_mr_list():
    """List requests with optional filters.

    Query params: status, from_date, to_date, requested_by, search, mine
      - mine=1 limits to the current user's own requests.
    """
    conn = sampling_portal.get_db_connection()
    try:
        st     = (request.args.get('status') or '').strip()
        fdate  = (request.args.get('from_date') or '').strip()
        tdate  = (request.args.get('to_date') or '').strip()
        reqby  = (request.args.get('requested_by') or '').strip()
        search = (request.args.get('search') or '').strip()
        mine   = request.args.get('mine') == '1'

        where = []
        params = []
        if st:
            where.append("r.status=%s"); params.append(st)
        if fdate:
            where.append("r.request_date >= %s"); params.append(fdate)
        if tdate:
            where.append("r.request_date <= %s"); params.append(tdate)
        if reqby:
            where.append("r.requested_by LIKE %s"); params.append(f'%{reqby}%')
        if mine:
            where.append("r.requested_by=%s"); params.append(_user() or '')
        if search:
            # Search hits request_no, remarks, OR any product name/code
            # inside the request's items.
            like = f'%{search}%'
            where.append("""(
                r.request_no LIKE %s
                OR r.remarks LIKE %s
                OR EXISTS (
                    SELECT 1 FROM pm_material_request_items ri
                    LEFT JOIN pm_products p ON p.id = ri.product_id
                    WHERE ri.request_id = r.id
                      AND (p.product_name LIKE %s
                           OR p.product_code LIKE %s)
                )
            )""")
            params.extend([like, like, like, like])
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""

        rows = conn.execute(
            f"""SELECT r.id, r.request_no, r.request_date, r.dest_godown_id,
                       r.requested_by, r.status, r.remarks, r.created_at,
                       COALESCE(g.name,'') AS dest_godown_name,
                       (SELECT COUNT(*) FROM pm_material_request_items WHERE request_id=r.id) AS item_count,
                       COALESCE((SELECT SUM(qty_requested) FROM pm_material_request_items WHERE request_id=r.id), 0) AS total_requested,
                       COALESCE((SELECT SUM(qty_fulfilled) FROM pm_material_request_items WHERE request_id=r.id), 0) AS total_fulfilled
                FROM pm_material_requests r
                LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
                {where_sql}
                ORDER BY r.id DESC""",
            tuple(params)
        ).fetchall()

        out = []
        for r in rows:
            d = dict(r)
            if hasattr(d.get('request_date'), 'isoformat'):
                d['request_date'] = d['request_date'].isoformat()
            if hasattr(d.get('created_at'), 'isoformat'):
                d['created_at'] = str(d['created_at'])
            out.append(d)

        conn.close()
        return jsonify({'status':'ok', 'requests': out, 'count': len(out)})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/<int:rid>', methods=['GET'])
@_login_required
def api_mr_detail(rid):
    """Full detail of one request — header + items + fulfillment story.

    The story is built from pm_material_request_links joined with transfer
    + item metadata so the UI can render a timeline like:
      "Bhavesh delivered 30 of CM-PERFORA on 17/05 via MIO/0034"
    """
    conn = sampling_portal.get_db_connection()
    try:
        r = conn.execute(
            """SELECT r.*, COALESCE(g.name,'') AS dest_godown_name
               FROM pm_material_requests r
               LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
               WHERE r.id=%s""",
            (rid,)
        ).fetchone()
        if not r:
            conn.close()
            return jsonify({'status':'error','message':'Request not found'}), 404
        items = conn.execute(
            """SELECT ri.id, ri.product_id, ri.qty_requested, ri.qty_fulfilled, ri.remarks,
                      p.product_name, p.pm_type
               FROM pm_material_request_items ri
               LEFT JOIN pm_products p ON p.id = ri.product_id
               WHERE ri.request_id=%s
               ORDER BY ri.id""",
            (rid,)
        ).fetchall()
        story = conn.execute(
            """SELECT l.id, l.request_item_id, l.transfer_id, l.qty_fulfilled,
                      l.fulfilled_by, l.fulfilled_at,
                      t.transfer_no, t.status AS transfer_status,
                      ri.product_id, p.product_name
               FROM pm_material_request_links l
               JOIN pm_material_request_items ri ON ri.id = l.request_item_id
               LEFT JOIN pm_transfers  t ON t.transfer_id = l.transfer_id
               LEFT JOIN pm_products   p ON p.id = ri.product_id
               WHERE ri.request_id=%s
               ORDER BY l.fulfilled_at, l.id""",
            (rid,)
        ).fetchall()

        rh = dict(r)
        for k in ('request_date', 'cancelled_at', 'created_at'):
            if hasattr(rh.get(k), 'isoformat'):
                rh[k] = str(rh[k]) if k != 'request_date' else rh[k].isoformat()

        item_list = [dict(it) for it in items]
        story_list = []
        for s in story:
            sd = dict(s)
            if hasattr(sd.get('fulfilled_at'), 'isoformat'):
                sd['fulfilled_at'] = str(sd['fulfilled_at'])
            story_list.append(sd)

        conn.close()
        return jsonify({'status':'ok', 'request': rh, 'items': item_list, 'story': story_list})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/cancel', methods=['POST'])
@_login_required
def api_mr_cancel():
    """Cancel a request. Allowed only when:
      - status is 'pending' (nothing fulfilled yet), AND
      - current user is the requester OR is an admin.

    Once anything has been fulfilled, the request must be processed by
    deleting/reversing the OUT vouchers individually — we don't silently
    erase fulfillment activity from the ledger by cancelling.
    """
    d = request.get_json() or {}
    rid = int(d.get('id') or 0)
    reason = (d.get('reason') or '').strip() or None
    if not rid:
        return jsonify({'status':'error','message':'id required'}), 400
    conn = sampling_portal.get_db_connection()
    try:
        r = conn.execute(
            "SELECT id, request_no, status, requested_by FROM pm_material_requests WHERE id=%s",
            (rid,)
        ).fetchone()
        if not r:
            conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
        if r['status'] != 'pending':
            conn.close(); return jsonify({'status':'error','message':f"Cannot cancel — status is '{r['status']}'. Reverse the fulfillment first."}), 400
        if r['requested_by'] != _user() and not _is_admin():
            conn.close(); return jsonify({'status':'error','message':'Only the requester or an admin can cancel.'}), 403
        # Defensive double-check that no fulfillment exists
        any_filled = conn.execute(
            "SELECT COUNT(*) AS c FROM pm_material_request_links l JOIN pm_material_request_items ri ON ri.id=l.request_item_id WHERE ri.request_id=%s",
            (rid,)
        ).fetchone()
        if any_filled and int(any_filled.get('c', 0)) > 0:
            conn.close(); return jsonify({'status':'error','message':'Some lines already fulfilled — cannot cancel.'}), 400

        conn.execute(
            """UPDATE pm_material_requests
                 SET status='cancelled', cancelled_by=%s, cancelled_at=NOW(), cancel_reason=%s
               WHERE id=%s""",
            (_user(), reason, rid)
        )
        try:
            _audit_record(
                conn,
                action='material_request.cancel',
                entity='material_request',
                entity_id=rid,
                summary=f"Material Request {r['request_no']} cancelled",
                before={'status': 'pending'},
                after={'status': 'cancelled', 'reason': reason},
            )
        except Exception: pass

        conn.commit(); conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/pending_count', methods=['GET'])
@_login_required
def api_mr_pending_count():
    """Cheap counter for the sidebar badge.

    Returns the count of requests that anyone could fulfill — i.e. status
    in (pending, in_progress). Includes 'in_progress' because those still
    have remaining qty waiting to be sent out.
    """
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM pm_material_requests WHERE status IN ('pending','in_progress')"
        ).fetchone()
        conn.close()
        return jsonify({'status':'ok', 'count': int(row.get('c', 0)) if row else 0})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/<int:rid>/prefill_out', methods=['GET'])
@_login_required
def api_mr_prefill_out(rid):
    """Return the data needed to pre-fill a Material OUT modal from this
    request. Used by the Fulfill button on the requests list.

    Lines returned only include items with remaining qty (qty_requested
    minus qty_fulfilled > 0). If everything's fulfilled, returns empty
    items[] and the frontend should refuse to open the OUT modal.
    """
    conn = sampling_portal.get_db_connection()
    try:
        r = conn.execute(
            """SELECT r.id, r.request_no, r.dest_godown_id, r.status, r.remarks,
                      COALESCE(g.name,'') AS dest_godown_name
               FROM pm_material_requests r
               LEFT JOIN procurement_godowns g ON g.id = r.dest_godown_id
               WHERE r.id=%s""",
            (rid,)
        ).fetchone()
        if not r:
            conn.close(); return jsonify({'status':'error','message':'Request not found'}), 404
        if r['status'] in ('fulfilled','cancelled'):
            conn.close(); return jsonify({'status':'error','message':f"Cannot fulfill — request is {r['status']}."}), 400

        items = conn.execute(
            """SELECT ri.id, ri.product_id, ri.qty_requested, ri.qty_fulfilled,
                      COALESCE(ri.entered_uom,'')   AS entered_uom,
                      ri.entered_qty                AS entered_qty,
                      p.product_name, p.pm_type,
                      COALESCE(p.primary_uom,'Nos') AS primary_uom,
                      COALESCE(p.alt_uom,'')        AS alt_uom,
                      p.alt_to_primary_ratio        AS alt_to_primary_ratio
               FROM pm_material_request_items ri
               LEFT JOIN pm_products p ON p.id = ri.product_id
               WHERE ri.request_id=%s
                 AND ri.qty_requested > ri.qty_fulfilled
               ORDER BY ri.id""",
            (rid,)
        ).fetchall()
        out_items = []
        for it in items:
            req = float(it['qty_requested'] or 0)
            ful = float(it['qty_fulfilled'] or 0)
            remaining = max(0.0, req - ful)
            if remaining > 0:
                _r = it.get('alt_to_primary_ratio')
                out_items.append({
                    'product_id':   int(it['product_id']),
                    'product_name': it.get('product_name') or '',
                    'pm_type':      it.get('pm_type') or '',
                    'qty':          remaining,
                    'primary_uom':  it.get('primary_uom') or 'Nos',
                    'alt_uom':      it.get('alt_uom') or '',
                    'alt_to_primary_ratio': float(_r) if _r is not None else None,
                    'entered_uom':  it.get('entered_uom') or '',
                    'entered_qty':  float(it['entered_qty']) if it.get('entered_qty') is not None else None,
                })
        conn.close()
        return jsonify({
            'status': 'ok',
            'request_id':       int(r['id']),
            'request_no':       r['request_no'],
            'dest_godown_id':   int(r['dest_godown_id']),
            'dest_godown_name': r.get('dest_godown_name') or '',
            'remarks':          r.get('remarks') or '',
            'items':            out_items,
        })
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500


@pm_mr_bp.route('/api/pm_stock/material_request/<int:rid>/unlink_transfer', methods=['POST'])
@_login_required
def api_mr_unlink_transfer(rid):
    """Admin-only: manually unlink a transfer from a request.

    Used when an admin wants to disconnect a wrongly-linked OUT voucher
    from a Request without deleting the OUT itself. Decrements
    qty_fulfilled and recomputes status.
    """
    if not _is_admin():
        return jsonify({'status':'error','message':'Admin only'}), 403
    d = request.get_json() or {}
    tid = int(d.get('transfer_id') or 0)
    if not tid:
        return jsonify({'status':'error','message':'transfer_id required'}), 400
    conn = sampling_portal.get_db_connection()
    try:
        # Restrict to links that actually belong to THIS request
        links = conn.execute(
            """SELECT l.id, l.request_item_id, l.qty_fulfilled
               FROM pm_material_request_links l
               JOIN pm_material_request_items ri ON ri.id = l.request_item_id
               WHERE l.transfer_id=%s AND ri.request_id=%s""",
            (tid, rid)
        ).fetchall()
        if not links:
            conn.close(); return jsonify({'status':'error','message':'No links found between this transfer and this request.'}), 404
        for ln in links:
            conn.execute(
                "UPDATE pm_material_request_items SET qty_fulfilled = GREATEST(0, qty_fulfilled - %s) WHERE id=%s",
                (float(ln['qty_fulfilled'] or 0), int(ln['request_item_id']))
            )
            conn.execute("DELETE FROM pm_material_request_links WHERE id=%s", (int(ln['id']),))
        _recompute_status(conn, rid)
        conn.commit(); conn.close()
        return jsonify({'status':'ok', 'unlinked': len(links)})
    except Exception as e:
        conn.close()
        return jsonify({'status':'error','message':str(e)}), 500
