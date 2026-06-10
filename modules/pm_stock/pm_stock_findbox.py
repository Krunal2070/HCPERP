"""
Find Box — drill-down explorer for the package inventory.

Three panes (left → middle → right):

  1. Godowns         — count of active products + active boxes per godown
                       (status='in_stock' OR 'in_transit' counted as live)
  2. Items at godown — per-product summary at the selected godown: total qty
                       and number of boxes
  3. Packages of item— individual pm_boxes rows for that godown + product

Plus a direct scan endpoint that, given a code (long box_code or short_code),
returns the box's location + ancestry so the UI can jump straight to it.

Read-only feature; no writes. Cheap to call (single godown_id index hit
each query). Cached at the page level — the UI can fetch godowns once,
fetch items when godown selection changes, fetch packages on item-select.
"""

from flask import request, jsonify
import sampling_portal


_helpers = None
def _load_helpers():
    global _helpers
    if _helpers is None:
        from . import helpers as _h
        _helpers = _h
    return _helpers


# Box statuses that count as "currently in inventory" — i.e. the box is
# physically somewhere and could be located. We include 'in_transit'
# because such a box is still part of someone's inventory (the
# destination's expected stock); excluding it would hide work-in-progress
# transfers from the explorer.
LIVE_STATUSES = ('in_stock', 'in_transit')


def register_routes(bp):
    h = _load_helpers()
    _login_required = h._login_required

    # ── 1. Godown summary ───────────────────────────────────────────
    @bp.route('/api/pm_stock/findbox/godowns', methods=['GET'])
    @_login_required
    def api_fbx_godowns():
        """Return per-godown rollup. Always includes an 'All Godowns'
        synthetic row at the top (id=0).
        """
        conn = sampling_portal.get_db_connection()
        try:
            in_clause = ','.join(['%s'] * len(LIVE_STATUSES))

            # Per-godown counts. Box rows with current_godown_id IS NULL
            # are still counted under the godown they were last associated
            # with via pm_box_movements; for simplicity we treat NULLs as
            # "unassigned" and DO surface them as a synthetic id=-1 row so
            # admins can spot drift.
            rows = conn.execute(f"""
                SELECT b.current_godown_id AS godown_id,
                       COALESCE(g.name, '(unassigned)') AS godown_name,
                       COUNT(DISTINCT b.product_id) AS item_count,
                       COUNT(*) AS package_count
                FROM pm_boxes b
                LEFT JOIN procurement_godowns g ON g.id = b.current_godown_id
                WHERE b.current_status IN ({in_clause})
                GROUP BY b.current_godown_id, g.name
                ORDER BY (b.current_godown_id IS NULL), g.name
            """, LIVE_STATUSES).fetchall() or []

            # Totals across all godowns
            total = conn.execute(f"""
                SELECT COUNT(DISTINCT product_id) AS item_count,
                       COUNT(*)                   AS package_count
                FROM pm_boxes
                WHERE current_status IN ({in_clause})
            """, LIVE_STATUSES).fetchone() or {'item_count':0,'package_count':0}

            out = []
            out.append({
                'godown_id':     0,
                'godown_name':   'All Godowns',
                'item_count':    int(total.get('item_count') or 0),
                'package_count': int(total.get('package_count') or 0),
            })
            for r in rows:
                d = dict(r) if hasattr(r,'keys') else r
                out.append({
                    'godown_id':     int(d['godown_id']) if d.get('godown_id') is not None else -1,
                    'godown_name':   d.get('godown_name') or '(unassigned)',
                    'item_count':    int(d.get('item_count') or 0),
                    'package_count': int(d.get('package_count') or 0),
                })
            return jsonify({'status':'ok','rows':out})
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 2. Items at a godown ───────────────────────────────────────
    @bp.route('/api/pm_stock/findbox/items', methods=['GET'])
    @_login_required
    def api_fbx_items():
        """Return per-product summary for a single godown.

        Query params:
          godown_id (required) — int. 0 = all godowns. -1 = unassigned.
          q         (optional) — substring to filter product_name / code.
        """
        try:
            gid = int(request.args.get('godown_id') or 0)
        except (TypeError, ValueError):
            return jsonify({'status':'error','message':'Invalid godown_id'}), 400

        q = (request.args.get('q') or '').strip()

        conn = sampling_portal.get_db_connection()
        try:
            in_clause = ','.join(['%s'] * len(LIVE_STATUSES))
            where = [f"b.current_status IN ({in_clause})"]
            params = list(LIVE_STATUSES)
            if gid == 0:
                pass  # No godown filter
            elif gid == -1:
                where.append("b.current_godown_id IS NULL")
            else:
                where.append("b.current_godown_id = %s")
                params.append(gid)
            if q:
                where.append("(p.product_name LIKE %s OR p.product_code LIKE %s)")
                params += [f'%{q}%', f'%{q}%']

            rows = conn.execute(f"""
                SELECT b.product_id,
                       COALESCE(p.product_name,'(deleted)') AS product_name,
                       COALESCE(p.product_code,'')          AS product_code,
                       COALESCE(p.pm_type,'')               AS pm_type,
                       COALESCE(p.primary_uom,'Nos')        AS primary_uom,
                       COUNT(*)                             AS package_count,
                       SUM(b.per_box_qty)                   AS total_qty
                FROM pm_boxes b
                LEFT JOIN pm_products p ON p.id = b.product_id
                WHERE {' AND '.join(where)}
                GROUP BY b.product_id, p.product_name, p.product_code, p.pm_type, p.primary_uom
                ORDER BY p.product_name
                LIMIT 500
            """, params).fetchall() or []
            out = []
            for r in rows:
                d = dict(r) if hasattr(r,'keys') else r
                out.append({
                    'product_id':    int(d['product_id']),
                    'product_name':  d.get('product_name') or '',
                    'product_code':  d.get('product_code') or '',
                    'pm_type':       d.get('pm_type') or '',
                    'primary_uom':   d.get('primary_uom') or 'Nos',
                    'package_count': int(d.get('package_count') or 0),
                    'total_qty':     float(d.get('total_qty') or 0),
                })
            return jsonify({'status':'ok','rows':out,'count':len(out)})
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 3. Packages of an item at a godown ─────────────────────────
    @bp.route('/api/pm_stock/findbox/packages', methods=['GET'])
    @_login_required
    def api_fbx_packages():
        """Return individual pm_boxes rows for product_id × godown_id.

        Query:
          godown_id  (required) — 0 = all, -1 = unassigned, else int
          product_id (required) — int
        """
        try:
            gid = int(request.args.get('godown_id') or 0)
            pid = int(request.args.get('product_id') or 0)
        except (TypeError, ValueError):
            return jsonify({'status':'error','message':'Invalid id'}), 400
        if pid <= 0:
            return jsonify({'status':'error','message':'product_id required'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            in_clause = ','.join(['%s'] * len(LIVE_STATUSES))
            where = [f"b.current_status IN ({in_clause})", "b.product_id = %s"]
            params = list(LIVE_STATUSES) + [pid]
            if gid == 0:
                pass
            elif gid == -1:
                where.append("b.current_godown_id IS NULL")
            else:
                where.append("b.current_godown_id = %s")
                params.append(gid)

            rows = conn.execute(f"""
                SELECT b.box_id, b.box_code, b.short_code,
                       b.grn_id, b.grn_no, b.box_seq, b.total_boxes,
                       b.per_box_qty, b.current_status, b.current_godown_id,
                       COALESCE(g.name,'(unassigned)') AS godown_name,
                       b.created_at, b.parent_box_id, b.split_at,
                       COALESCE(p.primary_uom,'Nos') AS primary_uom
                FROM pm_boxes b
                LEFT JOIN procurement_godowns g ON g.id = b.current_godown_id
                LEFT JOIN pm_products p         ON p.id = b.product_id
                WHERE {' AND '.join(where)}
                ORDER BY b.box_id DESC
                LIMIT 2000
            """, params).fetchall() or []
            out = []
            for r in rows:
                d = dict(r) if hasattr(r,'keys') else r
                created = d.get('created_at')
                if created is not None and not isinstance(created, str):
                    try: created = created.isoformat()
                    except Exception: created = str(created)
                split_at = d.get('split_at')
                if split_at is not None and not isinstance(split_at, str):
                    try: split_at = split_at.isoformat()
                    except Exception: split_at = str(split_at)
                out.append({
                    'box_id':          int(d['box_id']),
                    'box_code':        d.get('box_code') or '',
                    'short_code':      d.get('short_code') or '',
                    'grn_id':          int(d.get('grn_id') or 0),
                    'grn_no':          d.get('grn_no') or '',
                    'box_seq':         int(d.get('box_seq') or 0),
                    'total_boxes':     int(d.get('total_boxes') or 0),
                    'per_box_qty':     float(d.get('per_box_qty') or 0),
                    'current_status':  d.get('current_status') or '',
                    'godown_id':       int(d.get('current_godown_id')) if d.get('current_godown_id') is not None else None,
                    'godown_name':     d.get('godown_name') or '',
                    'primary_uom':     d.get('primary_uom') or 'Nos',
                    'parent_box_id':   int(d['parent_box_id']) if d.get('parent_box_id') else None,
                    'is_split_child':  bool(d.get('parent_box_id')),
                    'is_opening':      (d.get('grn_no') or '').startswith('PM-OP/'),
                    'created_at':      created,
                    'split_at':        split_at,
                })
            return jsonify({'status':'ok','rows':out,'count':len(out)})
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 4. Scan/locate by code ─────────────────────────────────────
    @bp.route('/api/pm_stock/findbox/locate', methods=['GET'])
    @_login_required
    def api_fbx_locate():
        """Resolve a scanned/typed code to godown + product so the UI can
        auto-select the right panes.

        Query: code (required) — long box_code OR short_code.
        """
        code = (request.args.get('code') or '').strip()
        if not code:
            return jsonify({'status':'error','message':'code required'}), 400
        conn = sampling_portal.get_db_connection()
        try:
            row = conn.execute("""
                SELECT b.box_id, b.box_code, b.short_code, b.product_id,
                       b.current_godown_id, b.current_status, b.per_box_qty,
                       b.grn_no, b.box_seq,
                       COALESCE(g.name,'(unassigned)') AS godown_name,
                       COALESCE(p.product_name,'(deleted)') AS product_name
                FROM pm_boxes b
                LEFT JOIN procurement_godowns g ON g.id = b.current_godown_id
                LEFT JOIN pm_products p         ON p.id = b.product_id
                WHERE b.box_code = %s OR b.short_code = %s
                LIMIT 1
            """, (code, code)).fetchone()
            if not row:
                return jsonify({'status':'not_found',
                                'message':f'No box matches "{code}"'}), 404
            d = dict(row) if hasattr(row,'keys') else row
            return jsonify({
                'status':'ok',
                'box': {
                    'box_id':         int(d['box_id']),
                    'box_code':       d.get('box_code') or '',
                    'short_code':     d.get('short_code') or '',
                    'product_id':     int(d['product_id']),
                    'product_name':   d.get('product_name') or '',
                    'godown_id':      int(d['current_godown_id']) if d.get('current_godown_id') else -1,
                    'godown_name':    d.get('godown_name') or '',
                    'current_status': d.get('current_status') or '',
                    'per_box_qty':    float(d.get('per_box_qty') or 0),
                    'grn_no':         d.get('grn_no') or '',
                    'box_seq':        int(d.get('box_seq') or 0),
                }
            })
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass
