# ============================================================
#  rd_sampling_routes.py
#  Flask Blueprint — all routes for the R&D Sampling portal
#  Main page route (/rd_sampling) stays in app.py.
# ============================================================

import os
from flask import (
    Blueprint, render_template, request, jsonify,
    session, send_file, abort
)
from functools import wraps
import urllib.parse
import sampling_portal

rd_sampling_bp = Blueprint('rd_sampling', __name__)


# ── helpers imported / re-declared here so the blueprint is self-contained ──

def _login_required(f):
    """Minimal login guard — mirrors app.py's login_required."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
        return f(*args, **kwargs)
    return decorated


def _role_in(*roles):
    """Return True if the current session user has one of the given roles."""
    return (session.get('User_Type') or '') in roles


def _has_perm(perm_key):
    """Return True if the current user has the given permission key,
    OR if they are admin (admin always has all permissions)."""
    if (session.get('User_Type') or '').lower() == 'admin':
        return True
    user_id = session.get('user_id')
    if not user_id:
        return False
    try:
        perms = sampling_portal.get_user_permissions(user_id) or {}
        return bool(perms.get(perm_key))
    except Exception:
        return False


# ═════════════════════════════════════════════════════════════════════════════
#  Token-auth guard for the R&D Sampling background agent
# ═════════════════════════════════════════════════════════════════════════════
_AGENT_TOKEN = os.environ.get("PORTAL_API_TOKEN", "")

def _check_agent_token():
    """Bearer-token guard for the agent-facing endpoint (no session required)."""
    if not _AGENT_TOKEN:
        abort(500, description="PORTAL_API_TOKEN not configured on server")
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != _AGENT_TOKEN:
        abort(401, description="Invalid or missing agent token")


# ── WhatsApp group registry (kept here so the blueprint owns it) ─────────────
WHATSAPP_GROUPS = {
    "raw_material_suppliers": {
        "name":     "Raw Material Suppliers",
        "group_id": "120363025892030603@g.us",
    },
    "approved_suppliers": {
        "name":     "Approved Vendors",
        "group_id": "120363047067498574@g.us",
    },
}

# ── Per-user email signature directory ──────────────────────────────────────
_USER_SIGNATURES = {
    'tarak': {
        'name':        'Tarak Bhavsar',
        'designation': 'SENIOR PURCHASE MANAGER',
        'mobile':      '+91 93 2891 1749',
        'email':       'tarak@hcpwellness.in',
    },
    'admin': {
        'name':        'Tarak Bhavsar',
        'designation': 'SENIOR PURCHASE MANAGER',
        'mobile':      '+91 93 2891 1749',
        'email':       'tarak@hcpwellness.in',
    },
    'sonal': {
        'name':        'Sonal Makwana',
        'designation': 'Purchase Executive',
        'mobile':      '+91 6358 976 126',
        'email':       'sonal@hcpwellness.in',
    },
    'suraj': {
        'name':        'Suraj Khatik',
        'designation': 'Purchase Executive',
        'mobile':      '+91 816 097 5673',
        'email':       'purchase2@hcpwellness.in',
    },
}

_EMAIL_CC = (
    "shital@hcpwellness.in,"
    "tarak@hcpwellness.in,"
    "purchase2@hcpwellness.in,"
    "sonal@hcpwellness.in"
)


def _build_email_signature(uid):
    u   = _USER_SIGNATURES.get((uid or '').lower(), {})
    name        = u.get('name', uid)
    designation = u.get('designation', '')
    mobile      = u.get('mobile', '')
    email_addr  = u.get('email', '')
    wa_number   = ''.join(c for c in mobile if c.isdigit() or c == '+')

    sig  = "\n\n--\n"
    sig += "📱 WhatsApp me for quick communication\n"
    if wa_number:
        sig += f"https://wa.me/{wa_number}\n"
    sig += "\n" + "=" * 46 + "\n"
    sig += "Thanks & Regards\n"
    sig += f"{name}\n"
    if designation:
        sig += f"({designation})\n"
    sig += "\nHCP Wellness Pvt. Ltd\n"
    if mobile:
        sig += f"Cell : {mobile}\n"
    if email_addr:
        sig += f"Email: {email_addr}\n"
    sig += "Web: www.hcpwellness.in\n\n"
    sig += "Office:\n"
    sig += "403 Maruti Vertex Elanza, Opp. Global Hospital,\n"
    sig += "Nr. GTPL House, Sindhubhavan Road,\n"
    sig += "Bodakdev, Ahmedabad-380054, Gujarat, India.\n\n"
    sig += "Factory:\n"
    sig += "#8, Ozone Industrial Estate, Bavla-Bagodara Highway,\n"
    sig += "Next to Kerala GIDC, Bhayla-382220, Ahmedabad, Gujarat, India.\n\n"
    sig += "GSTIN/UN : 24AAFCH7246H1ZK\n"
    return sig


# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

# ── Live search / column filter ──────────────────────────────────────────────
@rd_sampling_bp.route('/api/rd_sampling/search')
@_login_required
def rd_sampling_search():
    search    = request.args.get('search', '').strip()
    status    = request.args.get('status', 'All')
    date_from = request.args.get('date_from', '').strip()
    date_to   = request.args.get('date_to', '').strip()
    page      = request.args.get('page', 1, type=int)
    per_page  = 50
    offset    = (page - 1) * per_page

    # Column filter field → actual DB column name
    CF_COLS = {
        'status':             'status',
        'trade_name':         'trade_name',
        'inci_name':          'inci_name',
        'application':        'application',
        'qty':                'requested_sample_qty',
        'suggested_supplier': 'suggested_supplier',
        'recd_qty':           'recd_qty',
        'actual_supplier':    'actual_supplier_name',
        'batch_no':           'batch_no',
        'rate':               'rate_per_kg',
        'moq':                'moq',
        'lead_time':          'lead_time',
    }

    CF_DATE_COLS = {
        'request_date':     'request_date',
        'required_by_date': 'required_by_date',
        'received_date':    'received_date',
        'submission_date':  'submission_date',
    }

    conn   = sampling_portal.get_db_connection()
    cursor = conn.cursor()

    where  = ['1=1']
    params = []

    if status and status != 'All':
        where.append('status = %s')
        params.append(status)

    if date_from:
        where.append('request_date >= %s')
        params.append(date_from)
    if date_to:
        where.append('request_date <= %s')
        params.append(date_to)

    if search:
        where.append("""(
            trade_name LIKE %s OR inci_name LIKE %s OR application LIKE %s
            OR suggested_supplier LIKE %s OR actual_supplier_name LIKE %s
            OR batch_no LIKE %s
        )""")
        like = f'%{search}%'
        params.extend([like] * 6)

    for field, col in CF_COLS.items():
        exact = request.args.get(f'cf_{field}', '').strip()
        like  = request.args.get(f'cf_{field}_like', '').strip()
        if exact:
            where.append(f'{col} = %s')
            params.append(exact)
        elif like:
            where.append(f'{col} LIKE %s')
            params.append(f'%{like}%')

    for field, col in CF_DATE_COLS.items():
        val = request.args.get(f'cf_{field}', '').strip()
        if val:
            where.append(f'{col} = %s')
            params.append(val)

    where_sql   = ' AND '.join(where)
    base_query  = f'SELECT * FROM rd_sampling_requests WHERE {where_sql} ORDER BY id DESC LIMIT %s OFFSET %s'
    count_query = f'SELECT COUNT(*) FROM rd_sampling_requests WHERE {where_sql}'

    cursor.execute(base_query,  params + [per_page, offset])
    rows  = cursor.fetchall()
    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]
    conn.close()

    total_pages = max(1, (total + per_page - 1) // per_page)
    return jsonify({
        'records':     [dict(r) for r in rows],
        'page':        page,
        'total_pages': total_pages,
        'total':       total,
    })


# ── Stats (totals for dashboard cards) ──────────────────────────────────────
@rd_sampling_bp.route('/api/rd_sampling/stats')
@_login_required
def rd_sampling_stats():
    from datetime import date
    today = date.today().isoformat()
    conn  = sampling_portal.get_db_connection()
    rows  = conn.execute(
        "SELECT status, required_by_date FROM rd_sampling_requests"
    ).fetchall()
    conn.close()

    total = len(rows)
    pending = received = submitted = overdue = 0
    for r in rows:
        s = r['status']
        if s == 'Pending':
            pending += 1
            if r['required_by_date'] and str(r['required_by_date']) < today:
                overdue += 1
        elif s == 'Received':
            received += 1
        elif s == 'Submitted':
            submitted += 1

    return jsonify({
        'total': total, 'pending': pending,
        'received': received, 'submitted': submitted, 'overdue': overdue,
    })


# ── Save (create / update) ───────────────────────────────────────────────────
@rd_sampling_bp.route('/save_rd_sampling', methods=['POST'])
@_login_required
def save_rd_sampling():
    role = session.get('User_Type')
    if role not in ('RD', 'Purchase', 'User', 'admin'):
        return jsonify({'status': 'error', 'message': 'Access Denied'})
    try:
        sampling_portal.save_rd_request(request.json, role)
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})


# ── Single delete ────────────────────────────────────────────────────────────
@rd_sampling_bp.route('/delete_rd_sampling', methods=['POST'])
@_login_required
def delete_rd_sampling():
    data      = request.get_json()
    record_id = data.get('id')
    role      = session.get('User_Type')
    try:
        sampling_portal.delete_rd_request(record_id, role)
        return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})


# ── Bulk delete ──────────────────────────────────────────────────────────────
@rd_sampling_bp.route('/bulk_delete_rd_sampling', methods=['POST'])
@_login_required
def bulk_delete_rd_sampling():
    if not _role_in('admin', 'Purchase'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    ids    = (request.get_json() or {}).get('ids', [])
    if not ids:
        return jsonify({'status': 'error', 'message': 'No records selected'})

    errors = []
    for record_id in ids:
        try:
            sampling_portal.delete_rd_request(record_id, session.get('User_Type'))
        except Exception as e:
            errors.append(f'ID {record_id}: {e}')

    if errors:
        return jsonify({'status': 'error', 'message': '; '.join(errors)})
    return jsonify({'status': 'success'})


# ── Bulk labels (print) ──────────────────────────────────────────────────────
@rd_sampling_bp.route('/bulk_labels', methods=['POST'])
@_login_required
def bulk_labels():
    if not _role_in('admin', 'Purchase'):
        return 'Access Denied', 403

    ids = (request.json or {}).get('ids')
    if not ids:
        return 'No records selected', 400

    conn    = sampling_portal.get_db_connection()
    rows    = conn.execute(
        f"SELECT * FROM rd_sampling_requests WHERE id IN ({','.join(['%s']*len(ids))})",
        ids
    ).fetchall()
    conn.close()

    return render_template('bulk_label_template.html', records=[dict(r) for r in rows])


# ── Excel import ─────────────────────────────────────────────────────────────
@rd_sampling_bp.route('/import_rd_sampling', methods=['POST'])
@_login_required
def import_rd_sampling():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only access'})
    try:
        sampling_portal.import_rd_sampling_data(request.json, session.get('UID'))
        return jsonify({'status': 'success', 'message': 'Excel imported successfully'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})


# ── Export (filtered) ────────────────────────────────────────────────────────
@rd_sampling_bp.route('/api/rd_sampling/export')
@_login_required
def export_rd_sampling():
    search = request.args.get('search', '').strip()
    status = request.args.get('status', 'All')

    conn   = sampling_portal.get_db_connection()
    cursor = conn.cursor()

    query  = 'SELECT * FROM rd_sampling_requests WHERE 1=1'
    params = []

    if status and status != 'All':
        query += ' AND status = %s'
        params.append(status)

    if search:
        query += """ AND (
            trade_name LIKE %s OR inci_name LIKE %s OR application LIKE %s
            OR suggested_supplier LIKE %s OR actual_supplier_name LIKE %s
            OR batch_no LIKE %s
        )"""
        like = f'%{search}%'
        params.extend([like] * 6)

    query += ' ORDER BY id DESC'
    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    return jsonify({'records': [dict(r) for r in rows]})


# ── Bulk WhatsApp (individual supplier message) ──────────────────────────────
@rd_sampling_bp.route('/bulk_whatsapp_message', methods=['POST'])
@_login_required
def bulk_whatsapp_message():
    if not _role_in('admin', 'Purchase', 'RD'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    ids = (request.json or {}).get('ids')
    if not ids:
        return jsonify({'status': 'error', 'message': 'No records selected'})

    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        f"""SELECT trade_name, inci_name, requested_sample_qty, application
            FROM rd_sampling_requests
            WHERE id IN ({','.join(['%s']*len(ids))})
            ORDER BY id DESC""",
        ids
    ).fetchall()
    conn.close()

    if not rows:
        return jsonify({'status': 'error', 'message': 'No data found'})

    message = "Sample Request :\n\n"
    for i, r in enumerate(rows, 1):
        message += f"{i}. {r['trade_name']}\n"
        message += f"INCI: {r['inci_name']}\n"
        message += f"Required Qty: {r['requested_sample_qty']}\n"
        message += f"Application: {r['application']}\n\n"
    message += "Send Sample on an urgent basis"

    return jsonify({'status': 'success', 'message': message})


# ── Bulk Group WhatsApp ──────────────────────────────────────────────────────
@rd_sampling_bp.route('/bulk_group_whatsapp_message', methods=['POST'])
@_login_required
def bulk_group_whatsapp_message():
    if not _role_in('admin', 'Purchase'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    body      = request.json or {}
    ids       = body.get('ids')
    group_key = (body.get('group_key') or '').strip()

    if not ids:
        return jsonify({'status': 'error', 'message': 'No records selected'})
    if group_key not in WHATSAPP_GROUPS:
        return jsonify({'status': 'error', 'message': 'Invalid group selected'})

    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        f"""SELECT trade_name, inci_name
            FROM rd_sampling_requests
            WHERE id IN ({','.join(['%s']*len(ids))})
            ORDER BY id DESC""",
        ids
    ).fetchall()
    conn.close()

    message = ""
    for i, r in enumerate(rows, 1):
        message += f"{i}. {r['trade_name']}\n"
        message += f"        INCI: {r['inci_name']}\n"
        message += "-----------------------------------------------------\n\n"
    message += "Suppliers kindly DM\n"

    return jsonify({
        'status':   'success',
        'message':  message,
        'group_id': WHATSAPP_GROUPS[group_key]['group_id'],
    })


# ── Bulk Email ───────────────────────────────────────────────────────────────
@rd_sampling_bp.route('/bulk_email_message', methods=['POST'])
@_login_required
def bulk_email_message():
    ids = (request.json or {}).get('ids')
    if not ids:
        return jsonify({'status': 'error', 'message': 'No records selected'})

    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        f"""SELECT trade_name, inci_name, requested_sample_qty, suggested_supplier
            FROM rd_sampling_requests
            WHERE id IN ({','.join(['%s']*len(ids))})
            ORDER BY id DESC""",
        ids
    ).fetchall()
    conn.close()

    if not rows:
        return jsonify({'status': 'error', 'message': 'No data found'})

    body  = "Hello !\n\n"
    body += "Greetings of the day !\n\n"
    body += "Kindly submit the samples of the below-mentioned items to our office address.\n\n"
    for r in rows:
        body += f"Trade Name      : {r['trade_name']}\n"
        body += f"INCI Name       : {r['inci_name']}\n"
        body += f"Sample Quantity : {r['requested_sample_qty']}\n\n"
    body += _build_email_signature(session.get('UID', ''))

    subject   = "SAMPLE REQUEST"
    gmail_url = (
        "https://mail.google.com/mail/?view=cm&fs=1"
        "&su=" + urllib.parse.quote(subject) +
        "&body=" + urllib.parse.quote(body) +
        "&cc=" + urllib.parse.quote(_EMAIL_CC)
    )

    return jsonify({'status': 'success', 'gmail_url': gmail_url})


# ═══════════════════════════════════════════════════════════════════════════════
#  FORMULATION PRINT — R&D Request + Admin Approval + Print Lock
#  Source: procurement_formulations table (DB only, no Excel reading)
# ═══════════════════════════════════════════════════════════════════════════════

def _ensure_formulation_print_requests():
    """Create rd_formulation_print_requests with utf8mb4_0900_ai_ci to match
    procurement_formulations, preventing collation mismatch errors on JOIN/WHERE.
    Also drops the stale uq_batch_active unique key that causes (1062) duplicates.
    """
    conn = sampling_portal.get_db_connection()
    # Create table — NO unique key on (batch_name, status)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rd_formulation_print_requests (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            batch_name      VARCHAR(700)
                                CHARACTER SET utf8mb4
                                COLLATE utf8mb4_0900_ai_ci  NOT NULL,
            status          VARCHAR(30)   NOT NULL DEFAULT 'Pending',
            requested_by    VARCHAR(100)  NOT NULL,
            requested_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            approved_by     VARCHAR(100)  DEFAULT NULL,
            approved_at     DATETIME      DEFAULT NULL,
            rejection_note  TEXT          DEFAULT NULL,
            printed_by      VARCHAR(100)  DEFAULT NULL,
            printed_at      DATETIME      DEFAULT NULL
        ) ENGINE=InnoDB
          DEFAULT CHARSET=utf8mb4
          COLLATE=utf8mb4_0900_ai_ci
    """)
    conn.commit()

    # Drop the stale uq_batch_active unique key if it still exists.
    # This key on (batch_name, status) causes (1062) Duplicate entry when
    # updating status to 'Printed' for a batch that was previously printed.
    try:
        conn.execute(
            "ALTER TABLE rd_formulation_print_requests DROP INDEX uq_batch_active"
        )
        conn.commit()
    except Exception:
        pass  # index already gone — fine

    # Fix collation if table was created earlier with wrong charset
    try:
        conn.execute("""
            ALTER TABLE rd_formulation_print_requests
            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
        """)
        conn.commit()
    except Exception:
        pass
    conn.close()

_ensure_formulation_print_requests()


# ── API: list distinct batch_names from procurement_formulations ───────────────
@rd_sampling_bp.route('/api/rd/formulation_list')
@_login_required
def api_rd_formulation_list():
    """Return distinct batch names with brand + product_code.
    Searches on both batch_name and product_code."""
    if not _has_perm('rd_fml_request'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    search = request.args.get('q', '').strip()
    conn   = sampling_portal.get_db_connection()
    try:
        base_select = """
            SELECT
                f.batch_name,
                MAX(f.batch_size)        AS batch_size,
                MAX(f.batch_date)        AS batch_date,
                MAX(f.num_batches)       AS num_batches,
                MAX(f.source_batch_name) AS source_batch_name,
                MAX(f.brand_id)          AS brand_id,
                MAX(f.product_code)      AS product_code,
                MAX(b.name)              AS brand_name,
                MAX(b.color)             AS brand_color,
                COUNT(f.id)              AS ingredient_count
            FROM   procurement_formulations f
            LEFT JOIN procurement_brands b ON b.id = f.brand_id
        """
        if search:
            rows = conn.execute(
                base_select + """
                WHERE  f.batch_name LIKE %s OR f.product_code LIKE %s
                GROUP  BY f.batch_name
                ORDER  BY f.batch_name ASC
                LIMIT  100
                """, (f'%{search}%', f'%{search}%')
            ).fetchall()
        else:
            rows = conn.execute(
                base_select + """
                GROUP  BY f.batch_name
                ORDER  BY f.batch_name ASC
                LIMIT  200
                """
            ).fetchall()
        conn.close()
        return jsonify({'formulations': [dict(r) for r in rows]})
    except Exception as e:
        conn.close()
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ── API: R&D submits selected batch_names for admin approval ──────────────────
@rd_sampling_bp.route('/api/rd/formulation_request', methods=['POST'])
@_login_required
def api_rd_formulation_request():
    if not _has_perm('rd_fml_request'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    batch_names = (request.json or {}).get('batch_names', [])
    if not batch_names:
        return jsonify({'status': 'error', 'message': 'No formulations selected'}), 400

    uid  = session.get('UID', session.get('User_Name', 'rd'))
    conn = sampling_portal.get_db_connection()

    inserted = skipped = 0
    for bname in batch_names:
        bname = str(bname).strip()
        if not bname:
            continue
        # Skip if already Pending or Approved for this batch
        existing = conn.execute("""
            SELECT id FROM rd_formulation_print_requests
            WHERE batch_name=%s AND status IN ('Pending','Approved')
        """, (bname,)).fetchone()
        if existing:
            skipped += 1
            continue
        conn.execute("""
            INSERT INTO rd_formulation_print_requests
                (batch_name, status, requested_by)
            VALUES (%s, 'Pending', %s)
        """, (bname, uid))
        inserted += 1

    conn.commit()
    conn.close()

    if inserted == 0:
        msg = 'All selected formulations are already in the request queue.'
        return jsonify({'status': 'info', 'message': msg})
    msg = f'{inserted} formulation(s) submitted for admin approval.'
    if skipped:
        msg += f' ({skipped} skipped — already queued.)'
    return jsonify({'status': 'success', 'message': msg})


# ── API: admin — list formulation print requests ──────────────────────────────
@rd_sampling_bp.route('/api/rd/formulation_requests')
@_login_required
def api_rd_formulation_requests_list():
    if not _has_perm('rd_fml_approve'):
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403

    status_filter = request.args.get('status', 'All')
    conn = sampling_portal.get_db_connection()
    try:
        # COLLATE utf8mb4_0900_ai_ci on r.batch_name forces both sides
        # to the same collation as procurement_formulations.batch_name,
        # eliminating the (1267) "Illegal mix of collations" error.
        _subq_count = """(SELECT COUNT(*) FROM procurement_formulations f
                          WHERE f.batch_name = r.batch_name
                          COLLATE utf8mb4_0900_ai_ci)"""
        _subq_size  = """(SELECT f.batch_size FROM procurement_formulations f
                          WHERE f.batch_name = r.batch_name
                          COLLATE utf8mb4_0900_ai_ci LIMIT 1)"""
        _subq_date  = """(SELECT f.batch_date FROM procurement_formulations f
                          WHERE f.batch_name = r.batch_name
                          COLLATE utf8mb4_0900_ai_ci LIMIT 1)"""

        base_sql = f"""
            SELECT r.*,
                   {_subq_count} AS ingredient_count,
                   {_subq_size}  AS batch_size,
                   {_subq_date}  AS batch_date
            FROM   rd_formulation_print_requests r
        """
        if status_filter and status_filter != 'All':
            rows = conn.execute(
                base_sql + " WHERE r.status = %s ORDER BY r.requested_at DESC",
                (status_filter,)
            ).fetchall()
        else:
            rows = conn.execute(
                base_sql + " ORDER BY r.requested_at DESC"
            ).fetchall()

        conn.close()
        return jsonify({'requests': [dict(r) for r in rows]})
    except Exception as e:
        conn.close()
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── API: admin approve / reject ───────────────────────────────────────────────
@rd_sampling_bp.route('/api/rd/formulation_approve', methods=['POST'])
@_login_required
def api_rd_formulation_approve():
    if not _has_perm('rd_fml_approve'):
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403

    from datetime import datetime
    d      = request.json or {}
    ids    = [int(x) for x in (d.get('ids') or []) if str(x).isdigit()]
    action = d.get('action', '')   # 'approve' or 'reject'
    note   = (d.get('note') or '').strip()

    if not ids or action not in ('approve', 'reject'):
        return jsonify({'status': 'error', 'message': 'Invalid request'}), 400

    uid    = session.get('UID', session.get('User_Name', 'admin'))
    now    = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    status = 'Approved' if action == 'approve' else 'Rejected'
    ph     = ','.join(['%s'] * len(ids))

    conn = sampling_portal.get_db_connection()
    if action == 'approve':
        conn.execute(f"""
            UPDATE rd_formulation_print_requests
            SET status=%s, approved_by=%s, approved_at=%s, rejection_note=NULL
            WHERE id IN ({ph}) AND status='Pending'
        """, [status, uid, now] + ids)
    else:
        conn.execute(f"""
            UPDATE rd_formulation_print_requests
            SET status=%s, approved_by=%s, approved_at=%s, rejection_note=%s
            WHERE id IN ({ph}) AND status='Pending'
        """, [status, uid, now, note] + ids)
    conn.commit()
    conn.close()
    return jsonify({'status': 'success', 'action': action, 'count': len(ids)})


# ── API: R&D — list approved (printable) formulations with ingredients ─────────
@rd_sampling_bp.route('/api/rd/approved_formulations')
@_login_required
def api_rd_approved_formulations():
    if not _has_perm('rd_fml_print'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    conn = sampling_portal.get_db_connection()
    # Fetch all approved requests
    requests = conn.execute("""
        SELECT * FROM rd_formulation_print_requests
        WHERE status = 'Approved'
        ORDER BY approved_at DESC
    """).fetchall()

    results = []
    for req in requests:
        req = dict(req)
        # Fetch all ingredients for this batch from procurement_formulations
        # COLLATE utf8mb4_0900_ai_ci prevents (1267) collation mismatch
        ingredients = conn.execute("""
            SELECT material_name, supplier_name, concentration, qty_kg,
                   batch_size, manuf_process, product_code
            FROM   procurement_formulations
            WHERE  batch_name = %s COLLATE utf8mb4_0900_ai_ci
            ORDER  BY id ASC
        """, (req['batch_name'],)).fetchall()

        # Manufacturing process is same for all rows of a batch — take first non-null
        manuf_process = next(
            (r['manuf_process'] for r in ingredients if r.get('manuf_process')),
            ''
        )

        # Build ingredient list — default batch_size = 1 kg
        batch_size = 1.0
        if ingredients:
            try:
                batch_size = float(ingredients[0]['batch_size'] or 1.0)
            except (TypeError, ValueError):
                batch_size = 1.0

        ing_list = []
        for ing in ingredients:
            try:
                # concentration stored as fraction (e.g. 0.3480 = 34.80%)
                conc_frac = float(ing['concentration'] or 0)
            except (TypeError, ValueError):
                conc_frac = 0.0
            # qty for 1 kg batch = fraction × batch_size (NO /100)
            qty_1kg = round(conc_frac * 1.0, 6)
            ing_list.append({
                'material_name': ing['material_name'],
                'supplier_name': ing['supplier_name'] or '',
                'conc_frac':     conc_frac,               # raw fraction e.g. 0.3480
                'conc_pct':      round(conc_frac * 100, 4), # display % e.g. 34.80
                'qty_1kg':       qty_1kg,
                'product_code':  ing['product_code'] or '',
            })

        # product_code is batch-level — same across all rows, take first non-null
        product_code = next(
            (r['product_code'] for r in ingredients if r.get('product_code')),
            ''
        )

        req['ingredients']        = ing_list
        req['manuf_process']      = manuf_process
        req['product_code']       = product_code
        req['default_batch_size'] = 1.0
        results.append(req)

    conn.close()
    return jsonify({'formulations': results})


# ── API: fetch fresh ingredient data for printing (by IDs, any status) ──────────
@rd_sampling_bp.route('/api/rd/formulation_print_data', methods=['POST'])
@_login_required
def api_rd_formulation_print_data():
    """Fetch full ingredient data for given request IDs at print time.
    Works regardless of status — so data is always fresh, never stale from memory."""
    if not _has_perm('rd_fml_print'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    ids = [int(x) for x in ((request.json or {}).get('ids') or []) if str(x).isdigit()]
    if not ids:
        return jsonify({'status': 'error', 'message': 'No IDs provided'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        ph   = ','.join(['%s'] * len(ids))
        reqs = conn.execute(
            f"SELECT * FROM rd_formulation_print_requests WHERE id IN ({ph})",
            tuple(ids)
        ).fetchall()

        results = []
        for req in reqs:
            req = dict(req)
            ingredients = conn.execute("""
                SELECT material_name, supplier_name, concentration, qty_kg,
                       batch_size, manuf_process, product_code
                FROM   procurement_formulations
                WHERE  batch_name = %s COLLATE utf8mb4_0900_ai_ci
                ORDER  BY id ASC
            """, (req['batch_name'],)).fetchall()

            manuf_process = next(
                (r['manuf_process'] for r in ingredients if r.get('manuf_process')), ''
            )
            product_code = next(
                (r['product_code'] for r in ingredients if r.get('product_code')), ''
            )

            ing_list = []
            for ing in ingredients:
                try:
                    conc_frac = float(ing['concentration'] or 0)
                except (TypeError, ValueError):
                    conc_frac = 0.0
                ing_list.append({
                    'material_name': str(ing['material_name'] or '').strip(),
                    'supplier_name': str(ing['supplier_name'] or '').strip(),
                    'conc_frac':     conc_frac,
                    'conc_pct':      round(conc_frac * 100, 4),
                    'qty_1kg':       round(conc_frac, 6),
                    'product_code':  str(ing['product_code'] or '').strip(),
                })

            req['ingredients']   = ing_list
            req['manuf_process'] = manuf_process
            req['product_code']  = product_code
            results.append(req)

        conn.close()
        return jsonify({'formulations': results})
    except Exception as e:
        conn.close()
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── API: mark formulation(s) as printed (locks further printing) ───────────────
@rd_sampling_bp.route('/api/rd/formulation_mark_printed', methods=['POST'])
@_login_required
def api_rd_formulation_mark_printed():
    if not _has_perm('rd_fml_print'):
        return jsonify({'status': 'error', 'message': 'Access Denied'}), 403

    from datetime import datetime
    d   = request.json or {}
    ids = [int(x) for x in (d.get('ids') or []) if str(x).isdigit()]
    if not ids:
        return jsonify({'status': 'error', 'message': 'No IDs provided'}), 400

    uid = session.get('UID', session.get('User_Name', 'rd'))
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    ph  = ','.join(['%s'] * len(ids))

    conn = sampling_portal.get_db_connection()
    try:
        # UPDATE IGNORE silently skips rows that can't be updated
        # (e.g. already Printed) — prevents (1062) duplicate key errors
        conn.execute(f"""
            UPDATE IGNORE rd_formulation_print_requests
            SET status='Printed', printed_by=%s, printed_at=%s
            WHERE id IN ({ph}) AND status='Approved'
        """, [uid, now] + ids)
        conn.commit()
        conn.close()
        return jsonify({'status': 'success', 'message': f'{len(ids)} marked as printed.'})
    except Exception as e:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        conn.close()
        import traceback; traceback.print_exc()
        # Return success anyway — the print already happened client-side.
        # A DB failure here should not block the user from getting their printout.
        return jsonify({'status': 'success', 'message': 'Printed (DB update skipped — may already be marked).'})



# ── Material Rates page ────────────────────────────────────────────────────────
@rd_sampling_bp.route('/rd_material_rates')
@_login_required
def rd_material_rates_page():
    """Standalone Material Rates page — navigated to from R&D Sampling."""
    return render_template(
        'material_rates.html',
        role=session.get('User_Type', ''),
    )

# ── API: Material Rates from procurement_materials ─────────────────────────────
@rd_sampling_bp.route('/api/rd/material_rates')
@_login_required
def api_rd_material_rates():
    """Return material_name, supplier_name, last_purchase_rate from procurement_materials."""
    search = request.args.get('q', '').strip()
    conn   = sampling_portal.get_db_connection()
    try:
        if search:
            rows = conn.execute("""
                SELECT id, material_name, supplier_name, last_purchase_rate,
                       std_pack_size, lead_time_days, updated_at, hsn_code, gst_rate
                FROM   procurement_materials
                WHERE  material_name  LIKE %s
                   OR  supplier_name  LIKE %s
                   OR  aliases        LIKE %s
                ORDER  BY material_name ASC
                LIMIT  200
            """, (f'%{search}%', f'%{search}%', f'%{search}%')).fetchall()
        else:
            rows = conn.execute("""
                SELECT id, material_name, supplier_name, last_purchase_rate,
                       std_pack_size, lead_time_days, updated_at, hsn_code, gst_rate
                FROM   procurement_materials
                ORDER  BY material_name ASC
                LIMIT  500
            """).fetchall()
        conn.close()
        return jsonify({'materials': [dict(r) for r in rows]})
    except Exception as e:
        conn.close()
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ═════════════════════════════════════════════════════════════════════════════
#  Agent-only endpoint: pending R&D samples as JSON
#  Consumed by the autonomous agent at E:\hcp_rd_agent\rd_agent.py
#  Uses Bearer-token auth so it works without a browser login session.
# ═════════════════════════════════════════════════════════════════════════════
@rd_sampling_bp.route('/api/rd_sampling/pending_for_agent')
def api_rd_pending_for_agent():
    """Return all rows where status='Pending' as JSON."""
    _check_agent_token()

    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT
                id,
                request_date,
                trade_name,
                inci_name                  AS inci,
                application,
                requested_sample_qty       AS qty,
                suggested_supplier,
                required_by_date           AS required_by,
                status
            FROM   rd_sampling_requests
            WHERE  status = 'Pending'
            ORDER  BY request_date DESC, id DESC
        """).fetchall()
    finally:
        conn.close()

    out = []
    for r in rows:
        r = dict(r)
        for k, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
            elif v is None:
                r[k] = ""
        out.append(r)
    return jsonify(out)
