"""pm_stock_report_routes.py — additional report endpoints for the Reports hub.

Mounts onto the existing pm_stock_bp blueprint via register_report_routes(bp).
All endpoints are READ-ONLY (no writes) and login-gated. They reuse the same
ledger tables that drive stock totals (pm_godown_txn / pm_floor_txn) so the
numbers always match the rest of the module.

Cards backed here (data-backed only):
  • godown_stock      — Godown-wise stock summary (current / as-of)
  • group_stock       — Stock grouped by pm_type (group)
  • movement_ledger   — In/out history for ONE material (godown ledger)
  • non_moving        — Products with no outward movement in N days
  • neg_zero          — Negative / zero stock (data integrity)
  • reorder           — Items at or below min_stock (MSL)
  • grn_register      — GRNs received in a period
  • delivery_register — Outward deliveries (DN) in a period
  • transfer_register — Godown→godown transfers (MTV) in a period
  • item_card         — One material, all locations, opening→closing
  • stock_ageing      — How long current stock has sat (by last inward)
  • box_list          — All active boxes / labels

Data-gap cards (ABC, expiry/FEFO, audit-variance) are handled in the
frontend with a "needs setup" state — they require cost / expiry / physical
count fields the schema does not yet capture, so we do NOT fabricate numbers.
"""

from flask import request, jsonify
from datetime import datetime, date, timedelta
import sampling_portal


def _load_helpers():
    from . import helpers as H
    return H


def register_report_routes(bp):
    H = _load_helpers()
    _login_required = H._login_required
    _godown_summary = H._godown_summary

    def _conn():
        return sampling_portal.get_db_connection()

    def _period():
        """Return (from_date, to_date) defaulting to month-to-date."""
        today = date.today()
        f = request.args.get('from_date') or str(today.replace(day=1))
        t = request.args.get('to_date') or str(today)
        return f, t

    # ── 1. Godown-wise stock summary ─────────────────────────────────────
    @bp.route('/api/pm_stock/reports/godown_stock')
    @_login_required
    def api_rpt_godown_stock():
        """Current (or as-of) stock per product at a location. godown_id
        optional; to_date optional (as-of date)."""
        godown_id = request.args.get('godown_id')
        to_date = request.args.get('to_date') or None
        gid = int(godown_id) if (godown_id and godown_id.isdigit()) else None
        conn = _conn()
        try:
            rows = _godown_summary(conn, to_date=to_date, godown_id=gid)
            conn.close()
            out = []
            tot_open = tot_in = tot_out = tot_close = 0.0
            for r in rows:
                close = float(r.get('godown_stock', 0) or 0)
                out.append({
                    'product_id': r['id'], 'product_name': r['product_name'],
                    'product_code': r.get('product_code', ''), 'pm_type': r.get('pm_type', ''),
                    'brand_name': r.get('brand_name', ''),
                    'opening': float(r.get('op', 0) or 0), 'inward': float(r.get('inward', 0) or 0),
                    'outward': float(r.get('outward', 0) or 0), 'closing': close,
                    'min_stock': int(r.get('min_stock', 0) or 0),
                })
                tot_open += float(r.get('op', 0) or 0); tot_in += float(r.get('inward', 0) or 0)
                tot_out += float(r.get('outward', 0) or 0); tot_close += close
            return jsonify({'status': 'ok', 'as_of': to_date, 'godown_id': gid,
                            'rows': out, 'count': len(out),
                            'totals': {'opening': tot_open, 'inward': tot_in,
                                       'outward': tot_out, 'closing': tot_close}})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 2. Group-wise stock (by pm_type) ─────────────────────────────────
    @bp.route('/api/pm_stock/reports/group_stock')
    @_login_required
    def api_rpt_group_stock():
        to_date = request.args.get('to_date') or None
        conn = _conn()
        try:
            rows = _godown_summary(conn, to_date=to_date)
            conn.close()
            groups = {}
            for r in rows:
                g = (r.get('pm_type') or 'Uncategorised')
                d = groups.setdefault(g, {'group': g, 'products': 0, 'opening': 0.0,
                                          'inward': 0.0, 'outward': 0.0, 'closing': 0.0})
                d['products'] += 1
                d['opening'] += float(r.get('op', 0) or 0)
                d['inward'] += float(r.get('inward', 0) or 0)
                d['outward'] += float(r.get('outward', 0) or 0)
                d['closing'] += float(r.get('godown_stock', 0) or 0)
            out = sorted(groups.values(), key=lambda x: x['group'])
            return jsonify({'status': 'ok', 'as_of': to_date, 'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 3. Movement ledger for one material (godown ledger) ──────────────
    @bp.route('/api/pm_stock/reports/movement_ledger')
    @_login_required
    def api_rpt_movement_ledger():
        pid = request.args.get('product_id', '')
        if not pid.isdigit():
            return jsonify({'status': 'error', 'message': 'product_id required'}), 400
        pid = int(pid)
        from_date, to_date = _period()
        conn = _conn()
        try:
            prod = conn.execute(
                "SELECT id, product_name, pm_type, COALESCE(product_code,'') AS code FROM pm_products WHERE id=%s",
                (pid,)
            ).fetchone()
            if not prod:
                conn.close(); return jsonify({'status': 'error', 'message': 'Product not found'}), 404
            # Opening = net before the period (godown ledger only).
            ob = conn.execute(
                """SELECT COALESCE(SUM(CASE WHEN txn_type IN ('opening','inward','pm_return') THEN qty
                                            WHEN txn_type IN ('outward','issue','dispatch','rejection') THEN -qty
                                            ELSE 0 END),0) AS net
                   FROM pm_godown_txn WHERE product_id=%s AND txn_date < %s""",
                (pid, from_date)
            ).fetchone()
            opening = float(ob['net'] or 0)
            rows = conn.execute(
                """SELECT txn_date, txn_type, qty, voucher_no, godown_id, remarks, created_at, created_by
                   FROM pm_godown_txn WHERE product_id=%s AND txn_date BETWEEN %s AND %s
                   ORDER BY txn_date ASC, created_at ASC""",
                (pid, from_date, to_date)
            ).fetchall()
            gids = sorted({r['godown_id'] for r in rows if r['godown_id']})
            gname = {}
            if gids:
                ph = ','.join(['%s'] * len(gids))
                for g in conn.execute(f"SELECT id,name FROM procurement_godowns WHERE id IN ({ph})", tuple(gids)).fetchall():
                    gname[g['id']] = g['name']
            conn.close()
            LBL = {'opening': 'Opening', 'inward': 'Inward (GRN)', 'outward': 'Outward (Transfer)',
                   'issue': 'Issue', 'dispatch': 'Dispatch', 'rejection': 'Rejection', 'pm_return': 'PM Return'}
            PLUS = ('opening', 'inward', 'pm_return')
            run = opening; tin = tout = 0.0; out = []
            for r in rows:
                q = float(r['qty'] or 0); is_in = r['txn_type'] in PLUS
                run += q if is_in else -q
                if is_in: tin += q
                else: tout += q
                out.append({'date': str(r['txn_date']), 'type': r['txn_type'],
                            'type_label': LBL.get(r['txn_type'], r['txn_type']),
                            'in_qty': q if is_in else 0, 'out_qty': q if not is_in else 0,
                            'balance': round(run, 2), 'voucher_no': r['voucher_no'] or '',
                            'location': gname.get(r['godown_id'], '') if r['godown_id'] else '',
                            'remarks': r['remarks'] or '', 'by': r['created_by'] or ''})
            return jsonify({'status': 'ok',
                            'product': {'id': prod['id'], 'name': prod['product_name'],
                                        'pm_type': prod['pm_type'], 'code': prod['code']},
                            'from_date': from_date, 'to_date': to_date,
                            'opening_balance': round(opening, 2), 'closing_balance': round(run, 2),
                            'total_in': round(tin, 2), 'total_out': round(tout, 2),
                            'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 4. Non-moving stock (no outward in N days) ───────────────────────
    @bp.route('/api/pm_stock/reports/non_moving')
    @_login_required
    def api_rpt_non_moving():
        days = request.args.get('days', '90')
        days = int(days) if days.isdigit() else 90
        cutoff = str(date.today() - timedelta(days=days))
        conn = _conn()
        try:
            rows = _godown_summary(conn)
            # Last outward date per product.
            last_out = {}
            for r in conn.execute(
                """SELECT product_id, MAX(txn_date) AS last_out
                   FROM pm_godown_txn WHERE txn_type IN ('outward')
                   GROUP BY product_id""").fetchall():
                last_out[int(r['product_id'])] = str(r['last_out']) if r['last_out'] else None
            conn.close()
            out = []
            for r in rows:
                stock = float(r.get('godown_stock', 0) or 0)
                if stock <= 0:
                    continue  # nothing sitting
                lo = last_out.get(int(r['id']))
                if lo is None or lo < cutoff:
                    out.append({'product_id': r['id'], 'product_name': r['product_name'],
                                'pm_type': r.get('pm_type', ''), 'brand_name': r.get('brand_name', ''),
                                'closing': stock, 'last_outward': lo or 'never'})
            out.sort(key=lambda x: (x['last_outward'] == 'never', x['last_outward']))
            return jsonify({'status': 'ok', 'days': days, 'cutoff': cutoff,
                            'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 5. Negative / zero stock ─────────────────────────────────────────
    @bp.route('/api/pm_stock/reports/neg_zero')
    @_login_required
    def api_rpt_neg_zero():
        conn = _conn()
        try:
            rows = _godown_summary(conn)
            conn.close()
            neg = []; zero = []
            for r in rows:
                s = float(r.get('godown_stock', 0) or 0)
                rec = {'product_id': r['id'], 'product_name': r['product_name'],
                       'pm_type': r.get('pm_type', ''), 'brand_name': r.get('brand_name', ''),
                       'closing': s}
                if s < 0: neg.append(rec)
                elif s == 0: zero.append(rec)
            neg.sort(key=lambda x: x['closing'])
            return jsonify({'status': 'ok', 'negative': neg, 'zero': zero,
                            'neg_count': len(neg), 'zero_count': len(zero)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 6. Reorder (below MSL) ───────────────────────────────────────────
    @bp.route('/api/pm_stock/reports/reorder')
    @_login_required
    def api_rpt_reorder():
        conn = _conn()
        try:
            rows = _godown_summary(conn)
            conn.close()
            out = []
            for r in rows:
                msl = int(r.get('min_stock', 0) or 0)
                if msl <= 0:
                    continue  # no reorder level set
                s = float(r.get('godown_stock', 0) or 0)
                if s <= msl:
                    out.append({'product_id': r['id'], 'product_name': r['product_name'],
                                'pm_type': r.get('pm_type', ''), 'brand_name': r.get('brand_name', ''),
                                'closing': s, 'min_stock': msl, 'shortfall': round(msl - s, 2)})
            out.sort(key=lambda x: -x['shortfall'])
            return jsonify({'status': 'ok', 'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 7. GRN register ──────────────────────────────────────────────────
    @bp.route('/api/pm_stock/reports/grn_register')
    @_login_required
    def api_rpt_grn_register():
        from_date, to_date = _period()
        search = (request.args.get('search') or '').strip()
        brand_id_raw = (request.args.get('brand_id') or '').strip()
        try:
            brand_id = int(brand_id_raw) if brand_id_raw else 0
        except (TypeError, ValueError):
            brand_id = 0
        conn = _conn()
        try:
            where = ["g.grn_date BETWEEN %s AND %s"]; params = [from_date, to_date]
            if search:
                # Search across GRN no, supplier name, and party invoice no
                where.append("(g.grn_no LIKE %s OR g.supplier LIKE %s OR COALESCE(g.party_invoice_no,'') LIKE %s)")
                like = f'%{search}%'
                params += [like, like, like]
            if brand_id:
                # Show only GRNs that have at least one line whose product belongs to the selected brand
                where.append(
                    "EXISTS (SELECT 1 FROM pm_grn_items gi "
                    "JOIN pm_products p ON p.id = gi.product_id "
                    "WHERE gi.grn_id = g.id AND p.brand_id = %s)"
                )
                params.append(brand_id)
            wc = "WHERE " + " AND ".join(where)
            grns = conn.execute(
                f"""SELECT g.id, g.grn_no, g.grn_date, g.supplier, g.po_number,
                           COALESCE(g.party_invoice_no,'') AS invoice_no,
                           COALESCE(gd.name,'') AS godown_name,
                           COALESCE(g.verification_status,'verified') AS vstatus,
                           (SELECT COUNT(*) FROM pm_grn_items gi WHERE gi.grn_id=g.id) AS item_count,
                           (SELECT COALESCE(SUM(gi.qty_received),0) FROM pm_grn_items gi WHERE gi.grn_id=g.id) AS total_qty
                    FROM pm_grn g LEFT JOIN procurement_godowns gd ON gd.id=g.godown_id
                    {wc} ORDER BY g.grn_date DESC, g.id DESC""",
                tuple(params)
            ).fetchall()
            conn.close()
            out = [{'id': g['id'], 'grn_no': g['grn_no'], 'grn_date': str(g['grn_date']),
                    'supplier': g['supplier'] or '', 'po_number': g['po_number'] or '',
                    'invoice_no': g['invoice_no'], 'godown_name': g['godown_name'],
                    'vstatus': g['vstatus'], 'item_count': int(g['item_count'] or 0),
                    'total_qty': float(g['total_qty'] or 0)} for g in grns]
            return jsonify({'status': 'ok', 'from_date': from_date, 'to_date': to_date,
                            'rows': out, 'count': len(out),
                            'grand_qty': sum(r['total_qty'] for r in out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 8. Delivery register (DN — outward deliveries) ───────────────────
    @bp.route('/api/pm_stock/reports/delivery_register')
    @_login_required
    def api_rpt_delivery_register():
        from_date, to_date = _period()
        conn = _conn()
        try:
            # pm_dn header + item count. Schema: pm_dn(id, dn_no, dn_date, ...).
            try:
                dns = conn.execute(
                    """SELECT d.id, d.dn_no, d.dn_date, COALESCE(d.remarks,'') AS to_party,
                              (SELECT COUNT(*) FROM pm_dn_items di WHERE di.dn_id=d.id) AS item_count,
                              (SELECT COALESCE(SUM(di.qty_delivered),0) FROM pm_dn_items di WHERE di.dn_id=d.id) AS total_qty
                       FROM pm_dn d
                       WHERE d.dn_date BETWEEN %s AND %s
                       ORDER BY d.dn_date DESC, d.id DESC""",
                    (from_date, to_date)
                ).fetchall()
            except Exception:
                dns = []
            conn.close()
            out = [{'id': d['id'], 'dn_no': d['dn_no'], 'dn_date': str(d['dn_date']),
                    'to_party': d['to_party'] or '', 'item_count': int(d['item_count'] or 0),
                    'total_qty': float(d['total_qty'] or 0)} for d in dns]
            return jsonify({'status': 'ok', 'from_date': from_date, 'to_date': to_date,
                            'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 9. Transfer register (MTV — godown→godown / godown→floor) ────────
    @bp.route('/api/pm_stock/reports/transfer_register')
    @_login_required
    def api_rpt_transfer_register():
        from_date, to_date = _period()
        conn = _conn()
        try:
            try:
                trs = conn.execute(
                    """SELECT t.transfer_id AS id, t.transfer_no, DATE(t.out_at) AS tdate,
                              t.status, t.total_qty, t.total_boxes,
                              COALESCE(fg.name,'') AS from_name, COALESCE(tg.name,'') AS to_name,
                              (SELECT COUNT(DISTINCT ti.product_id) FROM pm_transfer_items ti
                                 WHERE ti.transfer_id=t.transfer_id AND ti.side='out') AS item_count
                       FROM pm_transfers t
                       LEFT JOIN procurement_godowns fg ON fg.id=t.from_godown_id
                       LEFT JOIN procurement_godowns tg ON tg.id=t.to_godown_id
                       WHERE DATE(t.out_at) BETWEEN %s AND %s
                       ORDER BY t.out_at DESC, t.transfer_id DESC""",
                    (from_date, to_date)
                ).fetchall()
            except Exception:
                trs = []
            conn.close()
            out = [{'id': t['id'], 'voucher_no': t['transfer_no'], 'date': str(t['tdate']),
                    'from_name': t['from_name'] or '', 'to_name': t['to_name'] or '',
                    'status': t['status'], 'item_count': int(t['item_count'] or 0),
                    'total_qty': float(t['total_qty'] or 0)}
                   for t in trs]
            return jsonify({'status': 'ok', 'from_date': from_date, 'to_date': to_date,
                            'rows': out, 'count': len(out)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 10. Item stock card (one material, opening→closing, all locations) ─
    @bp.route('/api/pm_stock/reports/item_card')
    @_login_required
    def api_rpt_item_card():
        pid = request.args.get('product_id', '')
        if not pid.isdigit():
            return jsonify({'status': 'error', 'message': 'product_id required'}), 400
        pid = int(pid)
        from_date, to_date = _period()
        conn = _conn()
        try:
            prod = conn.execute(
                "SELECT id, product_name, pm_type, COALESCE(product_code,'') AS code, COALESCE(min_stock,0) AS min_stock FROM pm_products WHERE id=%s",
                (pid,)
            ).fetchone()
            if not prod:
                conn.close(); return jsonify({'status': 'error', 'message': 'Product not found'}), 404
            summ = _godown_summary(conn, product_id=pid, from_date=from_date, to_date=to_date)
            conn.close()
            row = summ[0] if summ else {}
            return jsonify({'status': 'ok', 'from_date': from_date, 'to_date': to_date,
                            'product': {'id': prod['id'], 'name': prod['product_name'],
                                        'pm_type': prod['pm_type'], 'code': prod['code'],
                                        'min_stock': int(prod['min_stock'] or 0)},
                            'opening': float(row.get('op', 0) or 0),
                            'inward': float(row.get('inward', 0) or 0),
                            'outward': float(row.get('outward', 0) or 0),
                            'closing': float(row.get('godown_stock', 0) or 0)})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 11. Stock ageing (how long current stock has sat) ────────────────
    @bp.route('/api/pm_stock/reports/stock_ageing')
    @_login_required
    def api_rpt_stock_ageing():
        conn = _conn()
        try:
            rows = _godown_summary(conn)
            # last INWARD date per product as the ageing anchor.
            last_in = {}
            for r in conn.execute(
                """SELECT product_id, MAX(txn_date) AS last_in
                   FROM pm_godown_txn WHERE txn_type IN ('opening','inward')
                   GROUP BY product_id""").fetchall():
                last_in[int(r['product_id'])] = str(r['last_in']) if r['last_in'] else None
            conn.close()
            today = date.today(); out = []
            buckets = {'0-30': 0, '31-60': 0, '61-90': 0, '90+': 0}
            for r in rows:
                s = float(r.get('godown_stock', 0) or 0)
                if s <= 0:
                    continue
                li = last_in.get(int(r['id']))
                age = None
                if li:
                    try: age = (today - datetime.strptime(li, '%Y-%m-%d').date()).days
                    except Exception: age = None
                b = '90+' if (age is None or age > 90) else ('0-30' if age <= 30 else ('31-60' if age <= 60 else '61-90'))
                buckets[b] += 1
                out.append({'product_id': r['id'], 'product_name': r['product_name'],
                            'pm_type': r.get('pm_type', ''), 'closing': s,
                            'last_inward': li or '—', 'age_days': age if age is not None else '—',
                            'bucket': b})
            out.sort(key=lambda x: -(x['age_days'] if isinstance(x['age_days'], int) else 99999))
            return jsonify({'status': 'ok', 'rows': out, 'count': len(out), 'buckets': buckets})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 12. Box list (active boxes / labels) ─────────────────────────────
    @bp.route('/api/pm_stock/reports/box_list')
    @_login_required
    def api_rpt_box_list():
        search = (request.args.get('search') or '').strip()
        limit = request.args.get('limit', '500')
        limit = min(int(limit), 2000) if limit.isdigit() else 500
        conn = _conn()
        try:
            where = ["b.current_status='in_stock'"]; params = []
            if search:
                where.append("(b.short_code LIKE %s OR b.box_code LIKE %s OR p.product_name LIKE %s)")
                params += [f'%{search}%', f'%{search}%', f'%{search}%']
            wc = "WHERE " + " AND ".join(where)
            params.append(limit)
            boxes = conn.execute(
                f"""SELECT COALESCE(NULLIF(b.short_code,''), b.box_code) AS code,
                           b.box_code, b.per_box_qty, COALESCE(b.product_version,'') AS version,
                           COALESCE(p.product_name,'') AS product_name, COALESCE(p.pm_type,'') AS pm_type,
                           COALESCE(g.name,'') AS location, COALESCE(b.grn_no,'') AS grn_no
                    FROM pm_boxes b
                    LEFT JOIN pm_products p ON p.id=b.product_id
                    LEFT JOIN procurement_godowns g ON g.id=b.current_godown_id
                    {wc} ORDER BY p.product_name, code LIMIT %s""",
                tuple(params)
            ).fetchall()
            conn.close()
            out = [{'code': b['code'], 'box_code': b['box_code'], 'product_name': b['product_name'],
                    'pm_type': b['pm_type'], 'per_box_qty': float(b['per_box_qty'] or 0),
                    'version': b['version'], 'location': b['location'], 'grn_no': b['grn_no']}
                   for b in boxes]
            return jsonify({'status': 'ok', 'rows': out, 'count': len(out), 'capped': len(out) >= limit})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── 13. ABC Analysis ────────────────────────────────────────────────
    @bp.route('/api/pm_stock/reports/abc_analysis')
    @_login_required
    def api_rpt_abc_analysis():
        """Rank products by total receipt value across the period and bucket
        them A/B/C by Pareto contribution. Math:

           value(p)        = Σ qty_received × rate   over GRNs in [from..to]
           total_value     = Σ value(p) over all p
           share(p)        = value(p) / total_value
           cumulative(p)   = Σ share over all rows up to p (sorted desc by value)

           class A = cumulative ≤ 80%  (vital few)
           class B = cumulative ≤ 95%
           class C = remainder

        Products with rate=0 (legacy GRN lines that pre-date the Rate column)
        contribute 0 to the value pool and land at the bottom as class 'N/A'
        (no value data) so the user can spot them and back-fill if needed.
        Optional `brand_id` narrows to one brand.
        """
        from_date, to_date = _period()
        brand_id_raw = (request.args.get('brand_id') or '').strip()
        try:
            brand_id = int(brand_id_raw) if brand_id_raw else 0
        except (TypeError, ValueError):
            brand_id = 0
        conn = _conn()
        try:
            where = ["g.grn_date BETWEEN %s AND %s"]
            params = [from_date, to_date]
            if brand_id:
                where.append("p.brand_id = %s")
                params.append(brand_id)
            wc = "WHERE " + " AND ".join(where)
            # Roll up by product. SUM(qty * rate) handles per-line variance
            # cleanly: two GRNs of the same product at different rates each
            # contribute their own value. Avg rate = SUM(qty*rate)/SUM(qty),
            # which is the proper weighted average (not a naive AVG(rate)).
            rows = conn.execute(
                f"""SELECT
                       p.id                                AS product_id,
                       COALESCE(p.product_code,'')         AS product_code,
                       COALESCE(p.product_name,'')         AS product_name,
                       COALESCE(b.name,'')                 AS brand_name,
                       COALESCE(p.primary_uom,'Nos')       AS primary_uom,
                       SUM(gi.qty_received)                AS qty_total,
                       SUM(gi.qty_received * gi.rate)      AS value_total,
                       SUM(gi.qty_received)                AS qty_for_avg,
                       SUM(CASE WHEN gi.rate > 0 THEN gi.qty_received ELSE 0 END) AS qty_with_rate
                    FROM pm_grn_items gi
                    JOIN pm_grn g  ON g.id = gi.grn_id
                    JOIN pm_products p ON p.id = gi.product_id
                    LEFT JOIN procurement_brands b ON b.id = p.brand_id
                    {wc}
                    GROUP BY p.id, p.product_code, p.product_name, b.name, p.primary_uom
                    HAVING SUM(gi.qty_received) > 0""",
                tuple(params)
            ).fetchall()

            out = []
            for r in rows:
                qty_total      = float(r['qty_total'] or 0)
                value_total    = float(r['value_total'] or 0)
                qty_with_rate  = float(r['qty_with_rate'] or 0)
                avg_rate = (value_total / qty_with_rate) if qty_with_rate > 0 else 0.0
                out.append({
                    'product_id':   r['product_id'],
                    'product_code': r['product_code'],
                    'product_name': r['product_name'],
                    'brand_name':   r['brand_name'],
                    'primary_uom':  r['primary_uom'],
                    'qty_total':    qty_total,
                    'avg_rate':     avg_rate,
                    'value_total':  value_total,
                    'has_rate':     value_total > 0,
                })
            # Sort: priced items first by value desc, then unpriced
            # alphabetically so the user can find them to back-fill rates.
            priced   = sorted([r for r in out if r['has_rate']],
                              key=lambda x: x['value_total'], reverse=True)
            unpriced = sorted([r for r in out if not r['has_rate']],
                              key=lambda x: x['product_name'])
            grand_value = sum(r['value_total'] for r in priced)
            cum = 0.0
            for i, r in enumerate(priced):
                r['rank'] = i + 1
                share = (r['value_total'] / grand_value) if grand_value > 0 else 0.0
                cum += share
                r['share_pct']      = share * 100.0
                r['cumulative_pct'] = cum * 100.0
                # 80/15/5 is the textbook split. We could expose these as
                # query params later if Tarak wants 70/20/10 or similar.
                if cum <= 0.80:
                    r['abc_class'] = 'A'
                elif cum <= 0.95:
                    r['abc_class'] = 'B'
                else:
                    r['abc_class'] = 'C'
            for i, r in enumerate(unpriced):
                r['rank']           = len(priced) + i + 1
                r['share_pct']      = 0.0
                r['cumulative_pct'] = 100.0 if grand_value > 0 else 0.0
                r['abc_class']      = 'N/A'
            rows_out = priced + unpriced
            # Quick counts for the KPI strip
            counts = {'A':0,'B':0,'C':0,'N/A':0}
            for r in rows_out: counts[r['abc_class']] = counts.get(r['abc_class'], 0) + 1
            conn.close()
            return jsonify({
                'status':       'ok',
                'from_date':    from_date,
                'to_date':      to_date,
                'rows':         rows_out,
                'count':        len(rows_out),
                'grand_value':  grand_value,
                'counts':       counts,
                'priced_count': len(priced),
                'unpriced_count': len(unpriced),
            })
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── HOME DASHBOARD counts ────────────────────────────────────────────
    @bp.route('/api/pm_stock/home_dashboard')
    @_login_required
    def api_home_dashboard():
        """Aggregate live counts for the Home dashboard tiles. Each value is a
        plain integer; the frontend links each tile to its filtered view.
        Expiry/expired are returned as None (needs-setup) since no expiry data."""
        conn = _conn()
        today = str(date.today())
        d = {}
        def _scalar(sql, params=()):
            try:
                r = conn.execute(sql, params).fetchone()
                if not r: return 0
                v = list(r.values())[0] if hasattr(r, 'values') else r[0]
                return int(v or 0)
            except Exception:
                return 0
        try:
            # Tasks
            d['material_requests'] = _scalar(
                "SELECT COUNT(*) FROM pm_material_requests WHERE status IN ('pending','in_progress')")
            d['transfers_in_transit'] = _scalar(
                "SELECT COUNT(*) FROM pm_transfers WHERE status='in_pending'")
            d['simple_vouchers'] = _scalar(
                "SELECT COUNT(*) FROM pm_transfers WHERE status='out_started'")
            d['fefo_overrides'] = _scalar(
                "SELECT COUNT(*) FROM pm_fifo_override_requests WHERE status='pending'")
            d['label_reprints'] = _scalar(
                "SELECT COUNT(*) FROM pm_label_reprint_requests WHERE status='pending'")
            d['label_reissues'] = _scalar(
                "SELECT COUNT(*) FROM pm_label_reissue_requests WHERE status='pending'")
            # Alerts — compute from summary
            rows = _godown_summary(conn)
            below = zero = neg = 0
            for r in rows:
                s = float(r.get('godown_stock', 0) or 0)
                msl = int(r.get('min_stock', 0) or 0)
                if s < 0: neg += 1
                elif s == 0: zero += 1
                if msl > 0 and s <= msl: below += 1
            d['below_msl'] = below; d['zero_stock'] = zero; d['negative_stock'] = neg
            d['expiring_30d'] = None  # needs expiry data
            d['expired'] = None       # needs expiry data
            # Today's activity
            d['grns_today'] = _scalar("SELECT COUNT(*) FROM pm_grn WHERE grn_date=%s", (today,))
            d['transfers_received'] = _scalar(
                "SELECT COUNT(*) FROM pm_transfers WHERE status='received' AND DATE(in_at)=%s", (today,))
            d['boxes_created'] = _scalar("SELECT COUNT(*) FROM pm_boxes WHERE DATE(created_at)=%s", (today,))
            conn.close()
            return jsonify({'status': 'ok', 'date': today, 'counts': d})
        except Exception as e:
            try: conn.close()
            except Exception: pass
            return jsonify({'status': 'error', 'message': str(e), 'counts': d}), 200
