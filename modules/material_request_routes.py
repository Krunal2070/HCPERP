# ══════════════════════════════════════════════════════════════════════════════
# material_request_routes.py
# Flask Blueprint — Material Request Form (MRF) system for
#   • Production Department  (voucher_type = 'mrf_pd', batch-linked)
#   • R & D Department       (voucher_type = 'mrf_rd', free-form)
# Admin approves/rejects per-item.
# RM Store (production_initiater) marks items as supplied.
#
# Register in app.py:
#     from material_request_routes import material_request_bp
#     app.register_blueprint(material_request_bp)
# ══════════════════════════════════════════════════════════════════════════════

from flask import Blueprint, render_template, request, jsonify, session, redirect, url_for
from functools import wraps
from datetime import datetime, date
import re
import traceback
import sampling_portal

material_request_bp = Blueprint('material_request', __name__)


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            if request.path.startswith('/api/'):
                return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def _role():
    return (session.get('User_Type') or '').strip()


def _role_lc():
    return _role().lower()


def _is_admin():
    return _role_lc() == 'admin'


def _is_production():
    return _role_lc() == 'production'


def _is_rd():
    return _role_lc() in ('rd', 'r&d', 'r & d', 'r_and_d')


def _is_rm_store():
    r = _role_lc()
    # Real system values seen in production_initiater_routes.py:
    #   'RM_Store', 'rm_store', 'Rm_Store', 'Stores'
    # Match these + common variants, case-insensitively.
    return r in ('rm_store', 'rm store', 'rmstore', 'rm-store',
                 'stores', 'store')


def _can_request_pd():
    return _is_admin() or _is_production()


def _can_request_rd():
    return _is_admin() or _is_rd()


def _can_approve():
    return _is_admin()


def _can_supply():
    return _is_admin() or _is_rm_store()


def _can_view_list():
    """Any logged-in user from a requesting / approving / supplying role."""
    return (_is_admin() or _is_production() or _is_rd() or _is_rm_store())


def _denied(msg='Access denied'):
    return jsonify({'status': 'error', 'message': msg}), 403


# ── DB bootstrap ──────────────────────────────────────────────────────────────

def _ensure_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print('[MRF] DB connection failed — tables not ensured')
        return
    try:
        # ── Header ────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS material_requests (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                voucher_no      VARCHAR(120)  NOT NULL UNIQUE,
                dept            VARCHAR(20)   NOT NULL,   -- 'PD' or 'RD'
                batch_log_id    INT           DEFAULT NULL,  -- FK → production_dept_log.id (PD only)
                batch_name      VARCHAR(500)  DEFAULT NULL,
                product_code    VARCHAR(200)  DEFAULT NULL,
                purpose         TEXT          DEFAULT NULL,
                status          VARCHAR(20)   NOT NULL DEFAULT 'Pending',
                                                 -- Pending / Approved / Rejected / Partial / Supplied / Closed
                requested_by    VARCHAR(150)  DEFAULT NULL,
                requested_on    DATETIME      DEFAULT CURRENT_TIMESTAMP,
                reviewed_by     VARCHAR(150)  DEFAULT NULL,
                reviewed_on     DATETIME      DEFAULT NULL,
                authorized_by   VARCHAR(150)  DEFAULT NULL,
                authorized_on   DATETIME      DEFAULT NULL,
                notes           TEXT          DEFAULT NULL,
                INDEX idx_mrf_dept (dept),
                INDEX idx_mrf_status (status),
                INDEX idx_mrf_requested_on (requested_on)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # ── Line items ────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS material_request_items (
                id                INT AUTO_INCREMENT PRIMARY KEY,
                mrf_id            INT           NOT NULL,
                sr_no             INT           NOT NULL,
                material_id       INT           DEFAULT NULL,   -- procurement_materials.id
                material_name     VARCHAR(500)  NOT NULL,
                supplier_name     VARCHAR(500)  DEFAULT NULL,
                uom               VARCHAR(20)   DEFAULT 'KG',
                qty_demand        DECIMAL(15,3) NOT NULL DEFAULT 0,
                qty_obtained      DECIMAL(15,3) DEFAULT NULL,
                remarks           TEXT          DEFAULT NULL,
                item_status       VARCHAR(20)   NOT NULL DEFAULT 'Pending',
                                                 -- Pending / Approved / Rejected / Supplied
                reject_reason     VARCHAR(500)  DEFAULT NULL,
                approved_by       VARCHAR(150)  DEFAULT NULL,
                approved_on       DATETIME      DEFAULT NULL,
                supplied_by       VARCHAR(150)  DEFAULT NULL,
                supplied_on       DATETIME      DEFAULT NULL,
                received_by       VARCHAR(150)  DEFAULT NULL,
                received_on       DATETIME      DEFAULT NULL,
                INDEX idx_mri_mrf (mrf_id),
                CONSTRAINT fk_mri_mrf FOREIGN KEY (mrf_id)
                    REFERENCES material_requests(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # ── Seed default voucher numbering styles if none exist ──────
        today = date.today().isoformat()
        try:
            for vt, pfx, sfx in [('mrf_pd', 'MRF/PD', '25-26'),
                                 ('mrf_rd', 'MRF/RD', '25-26')]:
                exists = conn.execute(
                    "SELECT id FROM procurement_voucher_numbering "
                    "WHERE voucher_type=%s LIMIT 1", (vt,)
                ).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO procurement_voucher_numbering "
                        "(voucher_type, prefix, suffix, digits, start_num, valid_from, valid_to) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (vt, pfx, sfx, 4, 1, '2025-04-01', '2099-03-31')
                    )
                    conn.commit()
        except Exception:
            pass  # procurement_voucher_numbering table may not exist yet (procurement.py will create)
    except Exception:
        traceback.print_exc()
    finally:
        try: conn.close()
        except Exception: pass


_ensure_tables()


# ── Voucher number generator ──────────────────────────────────────────────────

def _assign_voucher_no(conn, vtype):
    """Atomic voucher-number generator — mirrors procurement.py pattern.
    Reads active style from procurement_voucher_numbering (voucher_type = vtype),
    finds highest existing number in material_requests for that prefix, adds 1.
    """
    today_str = date.today().isoformat()
    prefix, suffix, digits = '', '', 4
    try:
        row = conn.execute(
            "SELECT prefix, suffix, digits FROM procurement_voucher_numbering "
            "WHERE voucher_type=%s AND valid_from <= %s AND valid_to >= %s "
            "ORDER BY id DESC LIMIT 1",
            (vtype, today_str, today_str)
        ).fetchone()
        if row:
            prefix = (row['prefix'] or '').strip()
            suffix = (row['suffix'] or '').strip()
            digits = int(row['digits'] or 4)
    except Exception:
        pass

    # Sensible fallback
    if not prefix:
        prefix = 'MRF/PD' if vtype == 'mrf_pd' else 'MRF/RD'
        suffix = '25-26'
        digits = 4

    pattern   = prefix + '/%'
    lock_name = f'mrf_num_lock_{vtype}'

    conn.execute("SELECT GET_LOCK(%s, 10) AS locked", (lock_name,))
    try:
        rows = conn.execute(
            "SELECT voucher_no FROM material_requests WHERE voucher_no LIKE %s",
            (pattern,)
        ).fetchall()
        max_seq = 0
        for r in rows:
            m = re.findall(r'(\d{' + str(digits) + r',})', r['voucher_no'])
            if m:
                try: max_seq = max(max_seq, int(m[-1]))
                except ValueError: pass
        next_seq = max_seq + 1
        num_str  = str(next_seq).zfill(digits)
        parts = [prefix, num_str]
        if suffix: parts.append(suffix)
        return '/'.join(parts)
    finally:
        conn.execute("SELECT RELEASE_LOCK(%s)", (lock_name,))


# ══════════════════════════════════════════════════════════════════════════════
# API — Materials lookup (for autocomplete in request form)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/materials')
@_login_required
def api_materials_list():
    q    = (request.args.get('q', '') or '').strip()
    lim  = int(request.args.get('limit') or 25)
    lim  = max(1, min(lim, 2000))
    try:
        conn = sampling_portal.get_db_connection()
        if q:
            rows = conn.execute(
                "SELECT id, material_name, supplier_name, "
                "       COALESCE(uom,'KG') AS uom, std_pack_size "
                "FROM procurement_materials "
                "WHERE material_name LIKE %s OR supplier_name LIKE %s "
                "ORDER BY material_name LIMIT %s",
                (f'%{q}%', f'%{q}%', lim)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, material_name, supplier_name, "
                "       COALESCE(uom,'KG') AS uom, std_pack_size "
                "FROM procurement_materials "
                "ORDER BY material_name LIMIT %s",
                (lim,)
            ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'rows': [dict(r) for r in rows]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Next voucher number preview
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/next_voucher_no')
@_login_required
def api_next_voucher_no():
    dept = (request.args.get('dept') or 'PD').upper()
    vtype = 'mrf_pd' if dept == 'PD' else 'mrf_rd'
    if dept == 'PD' and not _can_request_pd(): return _denied()
    if dept == 'RD' and not _can_request_rd(): return _denied()
    try:
        conn = sampling_portal.get_db_connection()
        # Peek — don't commit a reservation (matches how procurement previews)
        today_str = date.today().isoformat()
        row = conn.execute(
            "SELECT prefix, suffix, digits FROM procurement_voucher_numbering "
            "WHERE voucher_type=%s AND valid_from <= %s AND valid_to >= %s "
            "ORDER BY id DESC LIMIT 1",
            (vtype, today_str, today_str)
        ).fetchone()
        prefix = (row['prefix'] if row else '') or ('MRF/PD' if dept=='PD' else 'MRF/RD')
        suffix = (row['suffix'] if row else '') or '25-26'
        digits = int((row['digits'] if row else 4) or 4)

        rows = conn.execute(
            "SELECT voucher_no FROM material_requests WHERE voucher_no LIKE %s",
            (prefix + '/%',)
        ).fetchall()
        conn.close()
        max_seq = 0
        for r in rows:
            m = re.findall(r'(\d{' + str(digits) + r',})', r['voucher_no'])
            if m:
                try: max_seq = max(max_seq, int(m[-1]))
                except: pass
        nxt = max_seq + 1
        num_str = str(nxt).zfill(digits)
        preview = '/'.join([prefix, num_str] + ([suffix] if suffix else []))
        return jsonify({'status': 'ok', 'preview': preview,
                        'prefix': prefix, 'suffix': suffix,
                        'digits': digits, 'next_seq': nxt})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — In-process batches (for PD batch-dropdown in request form)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/inprocess_batches')
@_login_required
def api_inprocess_batches():
    if not _can_request_pd(): return _denied()
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute(
            "SELECT id, batch_name, batch_size, product_code, operator_name "
            "FROM production_dept_log "
            "WHERE status = 'In Process' "
            "ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'rows': [dict(r) for r in rows]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Create request (header + items)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/create', methods=['POST'])
@_login_required
def api_create_request():
    d = request.get_json() or {}
    dept = (d.get('dept') or '').upper()

    if dept not in ('PD', 'RD'):
        return jsonify({'status': 'error', 'message': "dept must be 'PD' or 'RD'"}), 400
    if dept == 'PD' and not _can_request_pd(): return _denied()
    if dept == 'RD' and not _can_request_rd(): return _denied()

    batch_log_id = d.get('batch_log_id') or None
    batch_name   = (d.get('batch_name') or '').strip() or None
    product_code = (d.get('product_code') or '').strip() or None
    purpose      = (d.get('purpose') or '').strip() or None
    items        = d.get('items') or []

    if dept == 'PD' and not batch_log_id:
        return jsonify({'status': 'error',
                        'message': 'Batch selection is mandatory for Production Department requests'}), 400
    if not items or not isinstance(items, list):
        return jsonify({'status': 'error', 'message': 'At least one item is required'}), 400

    clean_items = []
    for idx, it in enumerate(items):
        name = (it.get('material_name') or '').strip()
        if not name:
            continue
        try:
            qd = float(it.get('qty_demand') or 0)
        except (ValueError, TypeError):
            qd = 0
        if qd <= 0:
            return jsonify({'status': 'error',
                            'message': f"Row {idx+1}: quantity must be > 0"}), 400
        clean_items.append({
            'material_id':   it.get('material_id') or None,
            'material_name': name,
            'supplier_name': (it.get('supplier_name') or '').strip() or None,
            'uom':           (it.get('uom') or 'KG').strip() or 'KG',
            'qty_demand':    qd,
            'remarks':       (it.get('remarks') or '').strip() or None,
        })

    if not clean_items:
        return jsonify({'status': 'error', 'message': 'No valid items'}), 400

    try:
        conn = sampling_portal.get_db_connection()

        # ── Authoritative supplier / UOM sourcing (non-admin only) ───────
        # For non-admin requesters, whenever a material_id is provided, the
        # server overrides the submitted supplier_name and uom with the
        # canonical values from procurement_materials. This prevents
        # departments from editing the auto-filled values via DOM tampering.
        if not _is_admin():
            for it in clean_items:
                mid = it.get('material_id')
                if mid:
                    try:
                        mrow = conn.execute(
                            "SELECT supplier_name, COALESCE(uom,'KG') AS uom "
                            "FROM procurement_materials WHERE id=%s", (mid,)
                        ).fetchone()
                        if mrow:
                            it['supplier_name'] = mrow['supplier_name'] or it['supplier_name']
                            it['uom']           = mrow['uom'] or it['uom']
                    except Exception:
                        pass  # non-fatal — fall through with client values

        vtype      = 'mrf_pd' if dept == 'PD' else 'mrf_rd'
        voucher_no = _assign_voucher_no(conn, vtype)
        requester  = session.get('User_Name') or session.get('UID') or ''

        # If PD and batch_log_id given, hydrate batch_name/product_code from DB
        if dept == 'PD' and batch_log_id:
            brow = conn.execute(
                "SELECT batch_name, product_code FROM production_dept_log WHERE id=%s",
                (batch_log_id,)
            ).fetchone()
            if brow:
                if not batch_name:   batch_name   = brow['batch_name']
                if not product_code: product_code = brow['product_code']

        conn.execute("""
            INSERT INTO material_requests
                (voucher_no, dept, batch_log_id, batch_name, product_code,
                 purpose, status, requested_by)
            VALUES (%s, %s, %s, %s, %s, %s, 'Pending', %s)
        """, (voucher_no, dept, batch_log_id, batch_name, product_code,
              purpose, requester))
        mrf_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()['id']

        for i, it in enumerate(clean_items, start=1):
            conn.execute("""
                INSERT INTO material_request_items
                    (mrf_id, sr_no, material_id, material_name, supplier_name,
                     uom, qty_demand, remarks, item_status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'Pending')
            """, (mrf_id, i, it['material_id'], it['material_name'],
                  it['supplier_name'], it['uom'], it['qty_demand'], it['remarks']))
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok', 'id': mrf_id, 'voucher_no': voucher_no})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — List requests (with filters)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/list')
@_login_required
def api_list_requests():
    if not _can_view_list(): return _denied()
    dept        = (request.args.get('dept') or '').upper()    # '', 'PD', 'RD'
    status      = (request.args.get('status') or '').strip()
    date_from   = (request.args.get('from') or '').strip()
    date_to     = (request.args.get('to') or '').strip()
    search      = (request.args.get('q') or '').strip()
    scope       = (request.args.get('scope') or 'all').strip()  # all / mine

    where  = ['1=1']
    params = []
    if dept in ('PD', 'RD'):
        where.append('dept = %s'); params.append(dept)
    if status:
        where.append('status = %s'); params.append(status)
    if date_from:
        where.append('DATE(requested_on) >= %s'); params.append(date_from)
    if date_to:
        where.append('DATE(requested_on) <= %s'); params.append(date_to)
    if search:
        where.append('(voucher_no LIKE %s OR batch_name LIKE %s '
                     'OR product_code LIKE %s OR requested_by LIKE %s)')
        s = f'%{search}%'
        params += [s, s, s, s]
    if scope == 'mine':
        me = session.get('User_Name') or session.get('UID') or ''
        where.append('requested_by = %s')
        params.append(me)

    # ── Role-based department lock (non-admins cannot see the other dept) ──
    # Production user → always scoped to PD
    # R&D user        → always scoped to RD
    # RM_Store user   → sees approved/partial/supplied across both
    # Admin           → sees everything (or whatever filter they asked for)
    if not _is_admin():
        if _is_production():
            # Force dept=PD regardless of what the URL asked for
            if dept and dept != 'PD':
                return jsonify({'status': 'ok', 'rows': []})
            where.append("dept = 'PD'")
        elif _is_rd():
            if dept and dept != 'RD':
                return jsonify({'status': 'ok', 'rows': []})
            where.append("dept = 'RD'")
        elif _is_rm_store():
            # RM store: see approved-and-beyond only (items they can supply)
            where.append("status IN ('Approved','Partial','Supplied')")

    try:
        conn = sampling_portal.get_db_connection()
        sql  = f"SELECT * FROM material_requests WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT 500"
        rows = conn.execute(sql, tuple(params)).fetchall()
        out = []
        for r in rows:
            rd = dict(r)
            # attach item counts for summary display
            cnt = conn.execute(
                "SELECT COUNT(*) AS t, "
                "SUM(item_status='Pending') AS p, "
                "SUM(item_status='Approved') AS a, "
                "SUM(item_status='Rejected') AS rj, "
                "SUM(item_status='Supplied') AS s "
                "FROM material_request_items WHERE mrf_id=%s", (r['id'],)
            ).fetchone()
            rd['items_total']    = int(cnt['t'] or 0)
            rd['items_pending']  = int(cnt['p'] or 0)
            rd['items_approved'] = int(cnt['a'] or 0)
            rd['items_rejected'] = int(cnt['rj'] or 0)
            rd['items_supplied'] = int(cnt['s'] or 0)
            out.append(rd)
        conn.close()
        return jsonify({'status': 'ok', 'rows': out})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Detail (header + items)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/detail')
@_login_required
def api_detail():
    if not _can_view_list(): return _denied()
    mrf_id = request.args.get('id')
    if not mrf_id:
        return jsonify({'status': 'error', 'message': 'id required'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        hdr  = conn.execute(
            "SELECT * FROM material_requests WHERE id=%s", (mrf_id,)
        ).fetchone()
        if not hdr:
            conn.close()
            return jsonify({'status': 'error', 'message': 'Not found'}), 404

        # ── Department-level access lock ──────────────────────────────
        # Production user may view PD requests only.
        # R&D user         may view RD requests only.
        # RM Store user    may view any request — but only once it has left
        #                  'Pending' (i.e. Approved / Partial / Supplied).
        # Admin            may view anything.
        if not _is_admin():
            dept = hdr['dept']
            if _is_production() and dept != 'PD':
                conn.close(); return _denied('This request belongs to another department')
            if _is_rd() and dept != 'RD':
                conn.close(); return _denied('This request belongs to another department')
            if _is_rm_store() and not (_is_production() or _is_rd()):
                # Pure RM Store: hide pending requests (they shouldn't see the
                # queue before admin approves anything)
                if hdr['status'] == 'Pending':
                    conn.close(); return _denied('Request not yet approved')

        items = conn.execute(
            "SELECT * FROM material_request_items WHERE mrf_id=%s ORDER BY sr_no",
            (mrf_id,)
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok',
                        'header': dict(hdr),
                        'items':  [dict(i) for i in items]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Approve / reject item (admin only)
# ══════════════════════════════════════════════════════════════════════════════

def _roll_up_status(conn, mrf_id):
    """Recompute header status from item states."""
    cnt = conn.execute(
        "SELECT COUNT(*) AS t, "
        "SUM(item_status='Pending')  AS p, "
        "SUM(item_status='Approved') AS a, "
        "SUM(item_status='Rejected') AS rj,"
        "SUM(item_status='Supplied') AS s "
        "FROM material_request_items WHERE mrf_id=%s", (mrf_id,)
    ).fetchone()
    t  = int(cnt['t'] or 0); p = int(cnt['p'] or 0)
    a  = int(cnt['a'] or 0); rj = int(cnt['rj'] or 0); s = int(cnt['s'] or 0)
    if t == 0:
        new_status = 'Pending'
    elif s > 0 and (s + rj) == t:
        new_status = 'Supplied'
    elif s > 0:
        new_status = 'Partial'
    elif p == 0 and a == 0 and rj == t:
        new_status = 'Rejected'
    elif p > 0:
        new_status = 'Pending'
    elif a > 0:
        new_status = 'Approved'
    else:
        new_status = 'Pending'
    conn.execute(
        "UPDATE material_requests SET status=%s WHERE id=%s",
        (new_status, mrf_id)
    )
    return new_status


@material_request_bp.route('/api/mrf/item_action', methods=['POST'])
@_login_required
def api_item_action():
    if not _can_approve(): return _denied('Only admin can approve/reject')
    d = request.get_json() or {}
    item_id = d.get('item_id')
    action  = (d.get('action') or '').lower()       # 'approve' / 'reject'
    reason  = (d.get('reason') or '').strip() or None
    try:
        qty_approved = d.get('qty_approved')
        qty_approved = float(qty_approved) if qty_approved not in (None, '') else None
    except Exception:
        qty_approved = None

    if not item_id or action not in ('approve', 'reject'):
        return jsonify({'status': 'error', 'message': 'Bad input'}), 400

    try:
        conn = sampling_portal.get_db_connection()
        row = conn.execute(
            "SELECT mrf_id, qty_demand FROM material_request_items WHERE id=%s",
            (item_id,)
        ).fetchone()
        if not row:
            conn.close()
            return jsonify({'status': 'error', 'message': 'Item not found'}), 404
        mrf_id = row['mrf_id']
        reviewer = session.get('User_Name') or session.get('UID') or ''

        if action == 'approve':
            new_qty = qty_approved if qty_approved is not None else float(row['qty_demand'])
            conn.execute(
                "UPDATE material_request_items "
                "SET item_status='Approved', qty_obtained=%s, "
                "    approved_by=%s, approved_on=NOW(), reject_reason=NULL "
                "WHERE id=%s",
                (new_qty, reviewer, item_id)
            )
        else:  # reject
            conn.execute(
                "UPDATE material_request_items "
                "SET item_status='Rejected', reject_reason=%s, "
                "    approved_by=%s, approved_on=NOW(), qty_obtained=NULL "
                "WHERE id=%s",
                (reason, reviewer, item_id)
            )

        # update header review stamps + status roll-up
        conn.execute(
            "UPDATE material_requests SET reviewed_by=%s, reviewed_on=NOW() WHERE id=%s",
            (reviewer, mrf_id)
        )
        new_status = _roll_up_status(conn, mrf_id)

        # On first transition out of Pending, set authorized stamp if all items resolved
        if new_status in ('Approved', 'Rejected', 'Partial'):
            hdr = conn.execute(
                "SELECT authorized_by FROM material_requests WHERE id=%s", (mrf_id,)
            ).fetchone()
            if hdr and not hdr['authorized_by']:
                # Only lock authorized_by when there are no Pending items left
                p_left = conn.execute(
                    "SELECT COUNT(*) AS p FROM material_request_items "
                    "WHERE mrf_id=%s AND item_status='Pending'", (mrf_id,)
                ).fetchone()
                if int(p_left['p'] or 0) == 0:
                    conn.execute(
                        "UPDATE material_requests SET authorized_by=%s, authorized_on=NOW() "
                        "WHERE id=%s", (reviewer, mrf_id)
                    )
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok', 'new_status': new_status})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── Bulk approve / reject — helper used by admin "one click" buttons ─────

@material_request_bp.route('/api/mrf/bulk_action', methods=['POST'])
@_login_required
def api_bulk_action():
    if not _can_approve(): return _denied('Only admin can approve/reject')
    d = request.get_json() or {}
    mrf_id = d.get('mrf_id')
    action = (d.get('action') or '').lower()
    reason = (d.get('reason') or '').strip() or None
    if not mrf_id or action not in ('approve_all', 'reject_all'):
        return jsonify({'status':'error', 'message': 'Bad input'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        reviewer = session.get('User_Name') or session.get('UID') or ''
        if action == 'approve_all':
            conn.execute(
                "UPDATE material_request_items "
                "SET item_status='Approved', qty_obtained=qty_demand, "
                "    approved_by=%s, approved_on=NOW(), reject_reason=NULL "
                "WHERE mrf_id=%s AND item_status='Pending'",
                (reviewer, mrf_id)
            )
        else:
            conn.execute(
                "UPDATE material_request_items "
                "SET item_status='Rejected', reject_reason=%s, "
                "    approved_by=%s, approved_on=NOW() "
                "WHERE mrf_id=%s AND item_status='Pending'",
                (reason, reviewer, mrf_id)
            )
        conn.execute(
            "UPDATE material_requests SET reviewed_by=%s, reviewed_on=NOW(), "
            "    authorized_by=%s, authorized_on=NOW() WHERE id=%s",
            (reviewer, reviewer, mrf_id)
        )
        new_status = _roll_up_status(conn, mrf_id)
        conn.commit()
        conn.close()
        return jsonify({'status':'ok', 'new_status': new_status})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status':'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — RM Store supplies an approved item
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/supply_item', methods=['POST'])
@_login_required
def api_supply_item():
    if not _can_supply(): return _denied('Only RM Store / admin can mark supplied')
    d = request.get_json() or {}
    item_id = d.get('item_id')
    if not item_id:
        return jsonify({'status': 'error', 'message': 'item_id required'}), 400
    try:
        qty_supplied = d.get('qty_supplied')
        qty_supplied = float(qty_supplied) if qty_supplied not in (None, '') else None
    except Exception:
        qty_supplied = None
    try:
        conn = sampling_portal.get_db_connection()
        it = conn.execute(
            "SELECT mrf_id, item_status, qty_demand, qty_obtained "
            "FROM material_request_items WHERE id=%s", (item_id,)
        ).fetchone()
        if not it:
            conn.close()
            return jsonify({'status': 'error', 'message': 'Item not found'}), 404
        if it['item_status'] != 'Approved':
            conn.close()
            return jsonify({'status': 'error',
                            'message': f"Item is '{it['item_status']}' — only Approved items can be supplied"}), 400
        supplier = session.get('User_Name') or session.get('UID') or ''
        final_qty = qty_supplied if qty_supplied is not None else (
            float(it['qty_obtained']) if it['qty_obtained'] is not None else float(it['qty_demand'])
        )
        conn.execute(
            "UPDATE material_request_items "
            "SET item_status='Supplied', qty_obtained=%s, "
            "    supplied_by=%s, supplied_on=NOW() "
            "WHERE id=%s",
            (final_qty, supplier, item_id)
        )
        _roll_up_status(conn, it['mrf_id'])
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status':'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Requester marks item as received
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/receive_item', methods=['POST'])
@_login_required
def api_receive_item():
    d = request.get_json() or {}
    item_id = d.get('item_id')
    if not item_id:
        return jsonify({'status': 'error', 'message': 'item_id required'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        it = conn.execute(
            "SELECT mri.mrf_id, mri.item_status, mrf.dept, mrf.requested_by "
            "FROM material_request_items mri "
            "JOIN material_requests mrf ON mrf.id = mri.mrf_id "
            "WHERE mri.id=%s", (item_id,)
        ).fetchone()
        if not it:
            conn.close()
            return jsonify({'status': 'error', 'message': 'Item not found'}), 404
        if it['item_status'] != 'Supplied':
            conn.close()
            return jsonify({'status': 'error',
                            'message': "Only supplied items can be marked received"}), 400
        # Only the requesting-dept users (or admin) can mark received
        dept = it['dept']
        if not _is_admin():
            if dept == 'PD' and not _is_production():  conn.close(); return _denied()
            if dept == 'RD' and not _is_rd():          conn.close(); return _denied()
        me = session.get('User_Name') or session.get('UID') or ''
        conn.execute(
            "UPDATE material_request_items "
            "SET received_by=%s, received_on=NOW() WHERE id=%s",
            (me, item_id)
        )
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status':'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# API — Delete request (admin only, while Pending)
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/delete', methods=['POST'])
@_login_required
def api_delete():
    d = request.get_json() or {}
    mrf_id = d.get('id')
    if not mrf_id:
        return jsonify({'status':'error', 'message':'id required'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        hdr = conn.execute(
            "SELECT status, requested_by FROM material_requests WHERE id=%s",
            (mrf_id,)
        ).fetchone()
        if not hdr:
            conn.close()
            return jsonify({'status':'error', 'message':'Not found'}), 404
        me = session.get('User_Name') or session.get('UID') or ''
        if not _is_admin() and hdr['requested_by'] != me:
            conn.close(); return _denied('Only admin or the requester can delete')
        if hdr['status'] not in ('Pending', 'Rejected') and not _is_admin():
            conn.close()
            return jsonify({'status':'error',
                            'message':'Can only delete while Pending or fully Rejected'}), 400
        conn.execute("DELETE FROM material_requests WHERE id=%s", (mrf_id,))
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status':'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# Admin approval PAGE
# ══════════════════════════════════════════════════════════════════════════════

@material_request_bp.route('/api/mrf/whoami')
@_login_required
def api_whoami():
    """Lightweight role check for the request-creation snippets to decide
    whether to lock supplier/UOM fields. Returns role flags only — no PII."""
    return jsonify({
        'status':         'ok',
        'is_admin':       _is_admin(),
        'is_production':  _is_production(),
        'is_rd':          _is_rd(),
        'is_rm_store':    _is_rm_store(),
    })


@material_request_bp.route('/material_requests')
@_login_required
def material_requests_page():
    if not _can_view_list():
        return "<h3 style='padding:40px;text-align:center;color:#dc2626'>Access Denied</h3>", 403

    # Role-capability flags pushed to template
    ctx = {
        'is_admin':      _is_admin(),
        'is_production': _is_production(),
        'is_rd':         _is_rd(),
        'is_rm_store':   _is_rm_store(),
        'can_approve':   _can_approve(),
        'can_supply':    _can_supply(),
    }
    try:
        return render_template('material_requests.html', **ctx)
    except Exception:
        traceback.print_exc()
        return ("<h3 style='padding:40px;text-align:center;color:#dc2626'>"
                "Template <code>material_requests.html</code> not found. "
                "Copy it into the <code>templates/</code> folder.</h3>"), 500
