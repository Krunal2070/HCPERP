"""
BOM (Bill of Materials) feature — FG → component recipe management.

A Finished-Goods (FG) product is a sellable SKU (e.g. "Beardo De Tan Body
Wash 200ml"). Its recipe is a list of pm_products (the packaging-material
catalogue) plus per-unit ratios — e.g. one FG unit needs 1 bottle, 1
front label, 1 back label, 2 pumps.

Tables (defined in helpers.ensure_pm_tables — see the BOM section there):

  pm_fg_products    — FG catalogue (separate from pm_products). Plain-text
                      brand_name (free-typed when not in procurement_brands,
                      otherwise picked from the typeahead). client_name
                      column kept for backward compat with rows created
                      before the feature was simplified.
  pm_bom            — One row per FG. Holds the current version number.
  pm_bom_items      — Current recipe lines (replaced on every save).
  pm_bom_history    — Append-only JSON snapshots of every prior version,
                      so old MRs (which stamp source_bom_id +
                      source_bom_version) can recover the recipe they
                      were built from.

When an MR is auto-built via the "From BOM" shortcut, the MR's line items
ARE the recipe snapshot — denormalised quantities × FG qty. The
source_bom_id / source_bom_version stamps on pm_material_requests are
just the audit trail; no runtime BOM lookup is needed to render an old MR.

Access control
--------------
All endpoints require the new `bom_manage` access flag (deny-by-default,
admins always allowed). The /calculate endpoint is read-only and used by
the Material Request modal's "From BOM" picker; it requires the looser
`material_request` flag instead so any requester can use a published BOM.
"""

from flask import request, jsonify
from datetime import datetime
import json
import sampling_portal


_helpers = None
def _load_helpers():
    global _helpers
    if _helpers is None:
        from . import helpers as _h
        _helpers = _h
    return _helpers


# ════════════════════════════════════════════════════════════════════
# Internal helpers — fetch + snapshot
# ════════════════════════════════════════════════════════════════════

def _fetch_bom_with_items(conn, bom_id):
    """Return a dict with the BOM header (joined to FG product) plus its
    current items, or None if the BOM doesn't exist. Items are joined to
    pm_products so the response carries product_name + product_code +
    pm_type alongside qty_per_unit."""
    header = conn.execute("""
        SELECT b.bom_id, b.fg_id, b.version, b.notes,
               b.created_by, b.created_at, b.updated_by, b.updated_at,
               f.fg_code, f.fg_name, f.brand_name,
               f.description AS fg_description, f.is_active
        FROM pm_bom b
        JOIN pm_fg_products f ON f.fg_id = b.fg_id
        WHERE b.bom_id = %s
    """, (bom_id,)).fetchone()
    if not header:
        return None
    d = dict(header) if hasattr(header, 'keys') else header
    items = conn.execute("""
        SELECT i.item_id, i.product_id, i.qty_per_unit, i.sort_order, i.note,
               COALESCE(p.product_name, '(deleted)')  AS product_name,
               COALESCE(p.product_code, '')           AS product_code,
               COALESCE(p.pm_type, '')                AS pm_type
        FROM pm_bom_items i
        LEFT JOIN pm_products p ON p.id = i.product_id
        WHERE i.bom_id = %s
        ORDER BY i.sort_order, i.item_id
    """, (bom_id,)).fetchall() or []
    d['items'] = [
        {
            'item_id':       int(r['item_id']),
            'product_id':    int(r['product_id']),
            'product_name':  r['product_name'],
            'product_code':  r['product_code'],
            'pm_type':       r['pm_type'],
            'qty_per_unit':  float(r['qty_per_unit'] or 0),
            'sort_order':    int(r['sort_order'] or 0),
            'note':          r['note'] or '',
        }
        for r in (dict(x) if hasattr(x, 'keys') else x for x in items)
    ]
    return d


def _snapshot_bom_version(conn, bom_id, edited_by, edit_summary=''):
    """Write the CURRENT pm_bom_items + version into pm_bom_history.
    Called BEFORE replacing items on a save so the prior version is
    preserved. The history row carries product_code/name denormalised
    so it stays readable even if products are later renamed."""
    head = conn.execute(
        "SELECT bom_id, fg_id, version, notes FROM pm_bom WHERE bom_id=%s",
        (bom_id,)
    ).fetchone()
    if not head:
        return
    head_d = dict(head) if hasattr(head, 'keys') else head
    items = conn.execute("""
        SELECT i.product_id, i.qty_per_unit, i.sort_order, i.note,
               COALESCE(p.product_name, '') AS product_name,
               COALESCE(p.product_code, '') AS product_code
        FROM pm_bom_items i
        LEFT JOIN pm_products p ON p.id = i.product_id
        WHERE i.bom_id = %s
        ORDER BY i.sort_order, i.item_id
    """, (bom_id,)).fetchall() or []
    items_payload = [
        {
            'product_id':   int(r['product_id']),
            'product_code': r['product_code'],
            'product_name': r['product_name'],
            'qty_per_unit': float(r['qty_per_unit'] or 0),
            'sort_order':   int(r['sort_order'] or 0),
            'note':         r['note'] or '',
        }
        for r in (dict(x) if hasattr(x, 'keys') else x for x in items)
    ]
    conn.execute("""
        INSERT INTO pm_bom_history
            (bom_id, fg_id, version, items_json, notes, edited_by, edit_summary)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (
        bom_id,
        head_d['fg_id'],
        head_d['version'],
        json.dumps(items_payload, ensure_ascii=False),
        head_d.get('notes') or '',
        edited_by,
        edit_summary[:300] if edit_summary else '',
    ))


# ════════════════════════════════════════════════════════════════════
# Routes
# ════════════════════════════════════════════════════════════════════

def register_routes(bp):
    H = _load_helpers()
    _login_required = H._login_required
    _user           = H._user
    _is_admin       = H._is_admin
    _audit_record   = H._audit_record
    _user_has_access  = H._user_has_access
    _block_if_no_access = H._block_if_no_access

    # ════════════════════════════════════════════════════════════════
    # BOM LIST + DETAIL (read endpoints — bom_manage OR material_request)
    # ════════════════════════════════════════════════════════════════

    @bp.route('/api/pm_stock/bom/list', methods=['GET'])
    @_login_required
    def api_bom_list():
        """List all BOMs with FG details + item count + version.

        Returns rows ordered by fg_name. Includes inactive FGs too —
        list filtering by is_active is left to the UI.
        """
        # Read access: anyone with bom_manage OR material_request can see
        # the list (so requesters can browse before using "From BOM").
        if not (_is_admin() or _user_has_access('bom_manage') or _user_has_access('material_request')):
            return jsonify({'status': 'error', 'message': 'Access denied'}), 403
        try:
            conn = sampling_portal.get_db_connection()
            rows = conn.execute("""
                SELECT b.bom_id, b.fg_id, b.version,
                       b.created_at, b.updated_at, b.updated_by,
                       f.fg_code, f.fg_name, f.brand_name,
                       f.is_active,
                       (SELECT COUNT(*) FROM pm_bom_items WHERE bom_id = b.bom_id) AS item_count
                FROM pm_bom b
                JOIN pm_fg_products f ON f.fg_id = b.fg_id
                ORDER BY f.fg_name
            """).fetchall() or []
            out = []
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                # Datetime → string for JSON
                for k in ('created_at', 'updated_at'):
                    if d.get(k):
                        try:    d[k] = d[k].strftime('%Y-%m-%d %H:%M:%S')
                        except Exception: d[k] = str(d[k])
                d['item_count'] = int(d.get('item_count') or 0)
                d['version']    = int(d.get('version') or 1)
                d['is_active']  = int(d.get('is_active') or 0)
                out.append(d)
            conn.close()
            return jsonify({'status': 'ok', 'boms': out})
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    @bp.route('/api/pm_stock/bom/<int:bom_id>', methods=['GET'])
    @_login_required
    def api_bom_detail(bom_id):
        """Return full BOM detail: FG header + current items + version."""
        if not (_is_admin() or _user_has_access('bom_manage') or _user_has_access('material_request')):
            return jsonify({'status': 'error', 'message': 'Access denied'}), 403
        try:
            conn = sampling_portal.get_db_connection()
            d = _fetch_bom_with_items(conn, bom_id)
            conn.close()
            if not d:
                return jsonify({'status': 'error', 'message': 'BOM not found'}), 404
            for k in ('created_at', 'updated_at'):
                if d.get(k):
                    try:    d[k] = d[k].strftime('%Y-%m-%d %H:%M:%S')
                    except Exception: d[k] = str(d[k])
            return jsonify({'status': 'ok', 'bom': d})
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    @bp.route('/api/pm_stock/bom/<int:bom_id>/calculate', methods=['GET'])
    @_login_required
    def api_bom_calculate(bom_id):
        """Multiply the BOM's per-unit recipe by a target FG quantity and
        return the resulting component list. Used by the Material Request
        modal's "From BOM" picker.

        Query: ?fg_qty=<float>
        """
        if not (_is_admin() or _user_has_access('bom_manage') or _user_has_access('material_request')):
            return jsonify({'status': 'error', 'message': 'Access denied'}), 403
        try:
            fg_qty = float(request.args.get('fg_qty') or 0)
        except Exception:
            return jsonify({'status': 'error', 'message': 'fg_qty must be a number'}), 400
        if fg_qty <= 0:
            return jsonify({'status': 'error', 'message': 'fg_qty must be > 0'}), 400
        try:
            conn = sampling_portal.get_db_connection()
            d = _fetch_bom_with_items(conn, bom_id)
            conn.close()
            if not d:
                return jsonify({'status': 'error', 'message': 'BOM not found'}), 404
            calc_items = []
            for it in d['items']:
                # Round to 3 decimals to match DECIMAL(14,3) precision.
                # We keep the float multiplication but clamp via round so
                # downstream MR items don't store noise like 9999.9999996.
                total = round(it['qty_per_unit'] * fg_qty, 3)
                calc_items.append({
                    'product_id':   it['product_id'],
                    'product_name': it['product_name'],
                    'product_code': it['product_code'],
                    'pm_type':      it['pm_type'],
                    'qty_per_unit': it['qty_per_unit'],
                    'total_qty':    total,
                    'note':         it['note'],
                })
            return jsonify({
                'status':         'ok',
                'bom_id':         d['bom_id'],
                'bom_version':    d['version'],
                'fg_id':          d['fg_id'],
                'fg_name':        d['fg_name'],
                'fg_code':        d['fg_code'],
                'fg_qty':         fg_qty,
                'item_count':     len(calc_items),
                'items':          calc_items,
            })
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    @bp.route('/api/pm_stock/bom/<int:bom_id>/history', methods=['GET'])
    @_login_required
    def api_bom_history(bom_id):
        """Return version history (most recent first). Heavy reads only —
        the items_json is parsed back into a list per row."""
        if not (_is_admin() or _user_has_access('bom_manage')):
            return jsonify({'status': 'error', 'message': 'Access denied'}), 403
        try:
            conn = sampling_portal.get_db_connection()
            rows = conn.execute("""
                SELECT history_id, bom_id, fg_id, version, items_json,
                       notes, edited_by, edited_at, edit_summary
                FROM pm_bom_history
                WHERE bom_id = %s
                ORDER BY version DESC, history_id DESC
            """, (bom_id,)).fetchall() or []
            conn.close()
            out = []
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                if d.get('edited_at'):
                    try:    d['edited_at'] = d['edited_at'].strftime('%Y-%m-%d %H:%M:%S')
                    except Exception: d['edited_at'] = str(d['edited_at'])
                try:
                    d['items'] = json.loads(d.get('items_json') or '[]')
                except Exception:
                    d['items'] = []
                # Don't ship the raw JSON string back — wastes bytes.
                d.pop('items_json', None)
                out.append(d)
            return jsonify({'status': 'ok', 'history': out})
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ════════════════════════════════════════════════════════════════
    # BOM SAVE (create or update; admin OR bom_manage)
    # ════════════════════════════════════════════════════════════════

    @bp.route('/api/pm_stock/bom/save', methods=['POST'])
    @_login_required
    def api_bom_save():
        """Create or update a BOM (with its FG header inline).

        Body
        ----
        {
          "bom_id":     <int|null>,            // omit/null for create
          "fg":         {                       // FG header fields
            "fg_id":       <int|null>,          // omit for create
            "fg_code":     "BEARDETAN200",
            "fg_name":     "Beardo De Tan Body Wash 200ml",
            "brand_name":  "Beardo",
            "description": "..."
          },
          "items": [                            // recipe lines
            { "product_id": <int>, "qty_per_unit": <float>, "note": "..." },
            ...
          ],
          "notes":       "..."                  // BOM-level notes
        }

        On update: snapshots the current pm_bom_items into pm_bom_history,
        then replaces items wholesale and bumps version.
        """
        blocked = _block_if_no_access('bom_manage')
        if blocked is not None:
            # Admins are exempt — the access helper already lets them through,
            # but we re-allow here for clarity.
            if not _is_admin():
                return blocked

        d = request.get_json() or {}
        fg = d.get('fg') or {}
        items = d.get('items') or []
        notes = (d.get('notes') or '').strip()[:500]
        bom_id_in = d.get('bom_id')

        # ── Validate FG header ──────────────────────────────────────
        fg_code = (fg.get('fg_code') or '').strip()
        fg_name = (fg.get('fg_name') or '').strip()
        if not fg_code:
            return jsonify({'status': 'error', 'message': 'FG code is required'}), 400
        if not fg_name:
            return jsonify({'status': 'error', 'message': 'FG name is required'}), 400
        if len(fg_code) > 40:
            return jsonify({'status': 'error', 'message': 'FG code max 40 chars'}), 400
        if len(fg_name) > 200:
            return jsonify({'status': 'error', 'message': 'FG name max 200 chars'}), 400
        brand_name = (fg.get('brand_name') or '').strip()[:120]
        # Note: client_name column still exists on pm_fg_products for
        # backward compat with rows saved before the feature was
        # simplified, but it's no longer collected from the FE or
        # written to on save. Existing values in the DB are preserved
        # as-is until an admin clears them manually.
        description = (fg.get('description') or '').strip()[:500]

        # ── Validate items ──────────────────────────────────────────
        if not isinstance(items, list) or not items:
            return jsonify({'status': 'error', 'message': 'At least one component is required'}), 400
        # Deduplicate product_id within the request (UNIQUE KEY would catch
        # this anyway, but rejecting early gives a clearer error).
        seen_pids = set()
        clean_items = []
        for it in items:
            try:
                pid  = int(it.get('product_id') or 0)
                qty  = float(it.get('qty_per_unit') or 0)
            except Exception:
                return jsonify({'status': 'error',
                                'message': 'Each item needs numeric product_id + qty_per_unit'}), 400
            if pid <= 0 or qty <= 0:
                return jsonify({'status': 'error',
                                'message': 'Each item needs a product and positive qty_per_unit'}), 400
            if pid in seen_pids:
                return jsonify({'status': 'error',
                                'message': f'Duplicate component product_id={pid} — combine into one line instead'}), 400
            seen_pids.add(pid)
            clean_items.append({
                'product_id':   pid,
                'qty_per_unit': qty,
                'sort_order':   int(it.get('sort_order') or len(clean_items) + 1),
                'note':         (it.get('note') or '').strip()[:200],
            })

        try:
            conn = sampling_portal.get_db_connection()
            try:
                # ── Verify all referenced products exist + are active ──
                pids = [it['product_id'] for it in clean_items]
                placeholders = ','.join(['%s'] * len(pids))
                existing = conn.execute(
                    f"SELECT id FROM pm_products WHERE id IN ({placeholders}) AND is_active=1",
                    tuple(pids)
                ).fetchall() or []
                existing_ids = {int(r['id']) for r in existing}
                missing = [p for p in pids if p not in existing_ids]
                if missing:
                    return jsonify({
                        'status':  'error',
                        'message': f'Component product(s) not found or inactive: {missing}',
                    }), 400

                user_name = _user()
                now_str   = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')

                # ════════════════════════════════════════════════════
                # PATH A — UPDATE existing BOM
                # ════════════════════════════════════════════════════
                if bom_id_in:
                    bom_id = int(bom_id_in)
                    head = conn.execute(
                        "SELECT bom_id, fg_id, version FROM pm_bom WHERE bom_id=%s",
                        (bom_id,)
                    ).fetchone()
                    if not head:
                        return jsonify({'status': 'error', 'message': 'BOM not found'}), 404
                    head_d = dict(head) if hasattr(head, 'keys') else head
                    fg_id = int(head_d['fg_id'])
                    prev_version = int(head_d['version'] or 1)

                    # Snapshot current version BEFORE overwriting items.
                    edit_summary = f'Updated to version {prev_version + 1}'
                    _snapshot_bom_version(conn, bom_id, user_name, edit_summary)

                    # ── Update FG header ─────────────────────────────
                    # fg_code uniqueness — if the user is changing it,
                    # make sure no OTHER FG already has the new code.
                    dup = conn.execute(
                        "SELECT fg_id FROM pm_fg_products WHERE fg_code=%s AND fg_id<>%s",
                        (fg_code, fg_id)
                    ).fetchone()
                    if dup:
                        return jsonify({
                            'status':  'error',
                            'message': f'FG code "{fg_code}" already used by another FG product',
                        }), 409
                    conn.execute("""
                        UPDATE pm_fg_products
                        SET fg_code=%s, fg_name=%s, brand_name=%s,
                            description=%s, updated_by=%s
                        WHERE fg_id=%s
                    """, (fg_code, fg_name, brand_name,
                          description, user_name, fg_id))

                    # ── Replace items wholesale ──────────────────────
                    conn.execute("DELETE FROM pm_bom_items WHERE bom_id=%s", (bom_id,))
                    for it in clean_items:
                        conn.execute("""
                            INSERT INTO pm_bom_items
                                (bom_id, product_id, qty_per_unit, sort_order, note)
                            VALUES (%s, %s, %s, %s, %s)
                        """, (bom_id, it['product_id'], it['qty_per_unit'],
                              it['sort_order'], it['note']))

                    # ── Bump version + notes ────────────────────────
                    new_version = prev_version + 1
                    conn.execute("""
                        UPDATE pm_bom
                        SET version=%s, notes=%s, updated_by=%s
                        WHERE bom_id=%s
                    """, (new_version, notes, user_name, bom_id))
                    conn.commit()

                    try:
                        _audit_record(conn, action='bom.update', entity='pm_bom',
                                      entity_id=str(bom_id),
                                      summary=f'Updated BOM for {fg_name} (v{prev_version} → v{new_version})',
                                      before={'version': prev_version},
                                      after={'version': new_version,
                                             'item_count': len(clean_items)})
                    except Exception:
                        pass

                    return jsonify({
                        'status':      'ok',
                        'action':      'updated',
                        'bom_id':      bom_id,
                        'fg_id':       fg_id,
                        'new_version': new_version,
                    })

                # ════════════════════════════════════════════════════
                # PATH B — CREATE new FG + BOM
                # ════════════════════════════════════════════════════
                # Reject duplicate fg_code up front.
                dup = conn.execute(
                    "SELECT fg_id FROM pm_fg_products WHERE fg_code=%s",
                    (fg_code,)
                ).fetchone()
                if dup:
                    dup_d = dict(dup) if hasattr(dup, 'keys') else dup
                    return jsonify({
                        'status':  'error',
                        'message': f'FG code "{fg_code}" already exists',
                        'existing_fg_id': int(dup_d['fg_id']),
                    }), 409

                cur = conn.execute("""
                    INSERT INTO pm_fg_products
                        (fg_code, fg_name, brand_name, description,
                         is_active, created_by)
                    VALUES (%s, %s, %s, %s, 1, %s)
                """, (fg_code, fg_name, brand_name, description, user_name))
                fg_id = cur.lastrowid
                if not fg_id:
                    row = conn.execute(
                        "SELECT fg_id FROM pm_fg_products WHERE fg_code=%s", (fg_code,)
                    ).fetchone()
                    fg_id = int((dict(row) if hasattr(row, 'keys') else row)['fg_id'])

                cur = conn.execute("""
                    INSERT INTO pm_bom (fg_id, version, notes, created_by)
                    VALUES (%s, 1, %s, %s)
                """, (fg_id, notes, user_name))
                bom_id = cur.lastrowid
                if not bom_id:
                    row = conn.execute(
                        "SELECT bom_id FROM pm_bom WHERE fg_id=%s", (fg_id,)
                    ).fetchone()
                    bom_id = int((dict(row) if hasattr(row, 'keys') else row)['bom_id'])

                # Items
                for it in clean_items:
                    conn.execute("""
                        INSERT INTO pm_bom_items
                            (bom_id, product_id, qty_per_unit, sort_order, note)
                        VALUES (%s, %s, %s, %s, %s)
                    """, (bom_id, it['product_id'], it['qty_per_unit'],
                          it['sort_order'], it['note']))

                # Initial history row — version 1 snapshot. So that
                # "version 1" always has a history entry too.
                _snapshot_bom_version(conn, bom_id, user_name, edit_summary='Initial creation')
                conn.commit()

                try:
                    _audit_record(conn, action='bom.create', entity='pm_bom',
                                  entity_id=str(bom_id),
                                  summary=f'Created BOM for {fg_name} ({fg_code})',
                                  before=None,
                                  after={'fg_id': fg_id,
                                         'item_count': len(clean_items)})
                except Exception:
                    pass

                return jsonify({
                    'status':      'ok',
                    'action':      'created',
                    'bom_id':      bom_id,
                    'fg_id':       fg_id,
                    'new_version': 1,
                })
            finally:
                try: conn.close()
                except Exception: pass
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ════════════════════════════════════════════════════════════════
    # BOM DELETE — admin only (cascades through FG + items + history)
    # ════════════════════════════════════════════════════════════════

    @bp.route('/api/pm_stock/bom/<int:bom_id>', methods=['DELETE'])
    @_login_required
    def api_bom_delete(bom_id):
        """Hard-delete a BOM (cascades to items + history). Also marks
        the underlying FG inactive — we DON'T hard-delete the FG row
        because old MRs may still reference source_bom_id, and we want
        the audit trail to resolve the FG name.

        Admin only.
        """
        if not _is_admin():
            return jsonify({'status': 'error', 'message': 'Admin only'}), 403
        try:
            conn = sampling_portal.get_db_connection()
            try:
                head = conn.execute("""
                    SELECT b.bom_id, b.fg_id, f.fg_name
                    FROM pm_bom b
                    JOIN pm_fg_products f ON f.fg_id = b.fg_id
                    WHERE b.bom_id = %s
                """, (bom_id,)).fetchone()
                if not head:
                    return jsonify({'status': 'error', 'message': 'BOM not found'}), 404
                head_d = dict(head) if hasattr(head, 'keys') else head

                # Refuse if any pm_material_requests references this BOM —
                # we want the audit trail intact, so refuse rather than
                # orphan an MR's source_bom_id.
                ref = conn.execute(
                    "SELECT COUNT(*) AS n FROM pm_material_requests WHERE source_bom_id=%s",
                    (bom_id,)
                ).fetchone()
                ref_d = dict(ref) if hasattr(ref, 'keys') else ref
                if int(ref_d.get('n') or 0) > 0:
                    return jsonify({
                        'status':  'error',
                        'message': (f'Cannot delete: {ref_d["n"]} Material Request(s) '
                                    f'reference this BOM. Deactivate it instead.'),
                    }), 409

                conn.execute("DELETE FROM pm_bom WHERE bom_id=%s", (bom_id,))
                # FG row stays; flip is_active=0 so it stops appearing in
                # the BOM list but the name resolves for any historical
                # references.
                conn.execute(
                    "UPDATE pm_fg_products SET is_active=0, updated_by=%s WHERE fg_id=%s",
                    (_user(), head_d['fg_id'])
                )
                conn.commit()

                try:
                    _audit_record(conn, action='bom.delete', entity='pm_bom',
                                  entity_id=str(bom_id),
                                  summary=f'Deleted BOM for {head_d["fg_name"]}',
                                  before={'fg_id': head_d['fg_id']},
                                  after=None)
                except Exception:
                    pass
                return jsonify({'status': 'ok', 'deleted_bom_id': bom_id})
            finally:
                try: conn.close()
                except Exception: pass
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500
