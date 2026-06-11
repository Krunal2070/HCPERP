"""
modules/crm/crm_leads_routes.py
────────────────────────────────────────────────────────────────────────────
CRM · LEAD MODULE  (ported into HCPERP.zip conventions)

  • Raw pymysql via sampling_portal.get_db_connection()  (NO SQLAlchemy)
  • Session-based auth (session['user_id'], session['role'] / User_Type)
  • Common, data-driven sidebar via core/menus.get_menu('crm', ...)
  • Templates: templates/crm/leads/*.html  (extend HCPERP.zip design — header
    + sidebar partials + hcptheme.css + common-sidebar.css)

Blueprint  : crm_bp  (url_prefix='/crm')
Tables     : leads, lead_discussions, lead_attachments, lead_reminders,
             lead_notes, lead_activity_logs, lead_contributions,
             contribution_config, lead_statuses, lead_sources,
             lead_categories, product_ranges
             (FK soft-ref User_Tbl.id — main project ka users table)

Registration (app.py):
    from crm import crm_bp, ensure_lead_tables
    app.register_blueprint(crm_bp)
    ensure_lead_tables()
"""

import os
import io
from datetime import datetime, timedelta
from functools import wraps

from flask import (Blueprint, render_template, redirect, url_for, request,
                   flash, jsonify, session, send_file, current_app, abort)
from werkzeug.utils import secure_filename

import sampling_portal  # main project ka pymysql bridge (core/ on sys.path)

# CRM schema model — single source of truth for the list/columns dropdown.
# (routes raw pymysql use karte hain, par column-metadata model se aata hai.)
try:
    from models.crm_lead import LEAD_LIST_COLUMNS
except Exception:
    try:
        from crm_lead import LEAD_LIST_COLUMNS
    except Exception:
        LEAD_LIST_COLUMNS = [
            ('created', 'Created', True), ('name', 'Name', True),
            ('company', 'Company', True), ('email', 'Email', True),
            ('mobile', 'Mobile', True), ('product', 'Product', True),
            ('team', 'Team', True), ('status', 'Status', True),
            ('lead_type', 'Lead Type', True), ('last_contact', 'Last Contact', True),
            ('age', 'Days (Age)', True), ('code', 'Code', False),
            ('position', 'Position', False), ('website', 'Website', False),
            ('alt_mobile', 'Alt. Mobile', False), ('source', 'Source', False),
            ('category', 'Category', False), ('product_range', 'Product Range', False),
            ('order_quantity', 'Order Qty', False), ('city', 'City', False),
            ('state', 'State', False), ('country', 'Country', False),
            ('zip_code', 'ZIP', False), ('avg_cost', 'Avg Cost', False),
            ('tags', 'Tags', False),
        ]

# Common, data-driven sidebar (menu defined once in core/menus.py)
try:
    from menus import get_menu
except Exception:
    def get_menu(*a, **k):
        return None

crm_bp = Blueprint('crm', __name__, url_prefix='/crm')

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {'pdf', 'png', 'jpg', 'jpeg', 'gif', 'doc', 'docx',
                      'xls', 'xlsx', 'txt', 'csv', 'ppt', 'pptx'}
BLOCKED_EXTENSIONS = {'php', 'phtml', 'php3', 'php4', 'php5', 'phar',
                      'jsp', 'asp', 'aspx', 'cgi', 'exe', 'bat', 'cmd',
                      'com', 'msi', 'dll', 'so', 'dylib'}
MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB

LEAD_COLS_DEFAULT = ['created_at', 'name', 'company', 'email', 'mobile',
                     'product', 'team', 'status', 'lead_type', 'last_contact']
LEAD_COLS_ALL = {
    'created_at': 'Created Date', 'name': 'Name', 'company': 'Company',
    'email': 'Email', 'mobile': 'Mobile', 'product': 'Product',
    'category': 'Category', 'source': 'Source', 'city': 'City',
    'assigned_to': 'Assigned To', 'team': 'Team', 'follow_up': 'Follow Up Date',
    'status': 'Status', 'lead_type': 'Lead Type', 'last_contact': 'Last Contact',
    'priority': 'Priority', 'expected_value': 'Expected Value',
    'lead_age': 'Days (Age)',
}

DEFAULT_CONTRIB_POINTS = {
    'comment': 1, 'status_change': 2, 'close_fast': 8, 'close_slow': 0,
    'cancel': 0, 'follow_up': 1, 'reminder': 1, 'edit': 1,
}


# ─────────────────────────────────────────────────────────────────────────────
# DB / AUTH HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _db():
    return sampling_portal.get_db_connection()


def _uid():
    return session.get('user_id')


def _uname():
    return session.get('User_Name') or session.get('UID') or 'User'


def _role():
    return (session.get('User_Type') or session.get('role') or '').lower()


def _is_admin():
    return _role() == 'admin' or (session.get('UID', '') or '').lower() == 'admin'


def _is_admin_mgr():
    return _is_admin() or _role() == 'manager'


def login_required(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*a, **k)
    return wrapper


def _upload_dir():
    d = os.path.join(current_app.root_path, 'static', 'uploads', 'leads')
    os.makedirs(d, exist_ok=True)
    return d


def _allowed_file(filename):
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    return ext not in BLOCKED_EXTENSIONS


# ── User lookups (User_Tbl) ──────────────────────────────────────────────────
def get_team_users():
    """Active users from User_Tbl for assigned-to / team dropdowns."""
    conn = _db()
    if not conn:
        return []
    try:
        rows = conn.execute(
            "SELECT id, full_name, username, role, department "
            "FROM `User_Tbl` WHERE is_active=1 ORDER BY full_name, username"
        ).fetchall()
        return rows or []
    finally:
        conn.close()


def _user_map(conn):
    """id -> display name map for the User_Tbl."""
    rows = conn.execute(
        "SELECT id, full_name, username FROM `User_Tbl`").fetchall() or []
    return {r['id']: (r['full_name'] or r['username'] or f"#{r['id']}")
            for r in rows}


# ── Code generation ──────────────────────────────────────────────────────────
def gen_lead_code(conn):
    row = conn.execute("SELECT MAX(id) AS mx FROM `leads`").fetchone()
    nxt = ((row['mx'] or 0) + 1) if row else 1
    return f"LD-{nxt:04d}"


# ── Activity log + contributions ─────────────────────────────────────────────
def log_activity(conn, lead_id, action, user_id=None):
    uid = user_id or _uid()
    conn.execute(
        "INSERT INTO `lead_activity_logs` (lead_id, user_id, action, created_at) "
        "VALUES (%s, %s, %s, NOW())", (lead_id, uid, action))


def _contrib_points(conn, action_type):
    try:
        row = conn.execute(
            "SELECT points FROM `contribution_config` WHERE action_type=%s",
            (action_type,)).fetchone()
        if row:
            return row['points']
    except Exception:
        pass
    return DEFAULT_CONTRIB_POINTS.get(action_type, 1)


def add_contribution(conn, lead_id, action_type, user_id=None, note=''):
    uid = user_id or _uid()
    if not uid:
        return
    pts = _contrib_points(conn, action_type)
    conn.execute(
        "INSERT INTO `lead_contributions` "
        "(lead_id, user_id, action_type, points, note, created_at) "
        "VALUES (%s, %s, %s, %s, %s, NOW())",
        (lead_id, uid, action_type, pts, note))


def _handle_close_contribution(conn, lead):
    """Smart close points split among active contributors, by speed slab."""
    created = lead.get('created_at')
    if isinstance(created, str):
        try:
            created = datetime.strptime(created[:19], '%Y-%m-%d %H:%M:%S')
        except Exception:
            created = datetime.now()
    days = max(0, (datetime.now().date() - created.date()).days) if created else 0
    if days <= 7:
        slab_pts = _contrib_points(conn, 'close_fast')
    elif days <= 14:
        slab_pts = max(0, _contrib_points(conn, 'close_fast') - 2)
    elif days <= 21:
        slab_pts = max(0, _contrib_points(conn, 'close_fast') - 4)
    elif days <= 28:
        slab_pts = max(0, _contrib_points(conn, 'close_fast') - 6)
    else:
        slab_pts = _contrib_points(conn, 'close_slow')

    actives = conn.execute(
        "SELECT DISTINCT user_id FROM `lead_contributions` WHERE lead_id=%s",
        (lead['id'],)).fetchall() or []
    active_ids = [r['user_id'] for r in actives if r['user_id']]
    if not active_ids and _uid():
        active_ids = [_uid()]
    if not active_ids:
        return
    per = max(0, slab_pts // len(active_ids))
    for uid in active_ids:
        conn.execute(
            "INSERT INTO `lead_contributions` "
            "(lead_id, user_id, action_type, points, note, created_at) "
            "VALUES (%s, %s, 'close', %s, %s, NOW())",
            (lead['id'], uid, per, f'Closed in {days} day(s)'))


# ── Visibility WHERE clause (role-based) ─────────────────────────────────────
def _visibility_sql():
    """Return (sql_fragment, params) limiting non-admin/manager users."""
    if _is_admin_mgr():
        return "", []
    uid = _uid()
    us = str(uid)
    frag = (" AND (assigned_to=%s OR created_by=%s "
            "OR team_members=%s "
            "OR team_members LIKE %s OR team_members LIKE %s OR team_members LIKE %s)")
    params = [uid, uid, us, f"{us},%", f"%,{us},%", f"%,{us}"]
    return frag, params


# ─────────────────────────────────────────────────────────────────────────────
# LIST
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads')
@login_required
def leads():
    status = request.args.get('status', '')
    search = request.args.get('search', '')
    source = request.args.get('source', '')
    category = request.args.get('category', '')
    p_range = request.args.get('product_range', '')
    city = request.args.get('city', '')
    date_from = request.args.get('date_from', '')
    date_to = request.args.get('date_to', '')
    sort_by = request.args.get('sort_by', 'created_at')
    sort_dir = request.args.get('sort_dir', 'desc')
    show_trash = request.args.get('trash', '') == '1'

    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        vis_frag, vis_params = _visibility_sql()

        where = ["is_deleted = %s"]
        params = [1 if show_trash else 0]

        if not show_trash and status:
            where.append("status = %s")
            params.append(status)
        if source:
            where.append("source = %s")
            params.append(source)
        if category:
            where.append("category = %s")
            params.append(category)
        if p_range:
            where.append("product_range = %s")
            params.append(p_range)
        if city:
            where.append("city LIKE %s")
            params.append(f"%{city}%")
        if date_from:
            where.append("created_at >= %s")
            params.append(date_from + " 00:00:00")
        if date_to:
            where.append("created_at <= %s")
            params.append(date_to + " 23:59:59")
        if search:
            s = f"%{search}%"
            cols = ['contact_name', 'company_name', 'phone', 'alternate_mobile',
                    'email', 'product_name', 'category', 'product_range',
                    'source', 'city', 'state', 'country', 'zip_code', 'address',
                    'position', 'title', 'tags', 'remark', 'notes',
                    'lost_reason', 'requirement_spec', 'order_quantity', 'code']
            where.append("(" + " OR ".join(f"{c} LIKE %s" for c in cols) + ")")
            params.extend([s] * len(cols))

        sort_map = {'name': 'contact_name', 'mobile': 'phone',
                    'company': 'company_name'}
        col = sort_map.get(sort_by, sort_by)
        valid_sort = {'created_at', 'contact_name', 'company_name', 'phone',
                      'email', 'status', 'follow_up_date', 'priority',
                      'expected_value', 'city', 'category', 'source'}
        if col not in valid_sort:
            col = 'created_at'
        direction = 'ASC' if sort_dir == 'asc' else 'DESC'

        sql = ("SELECT * FROM `leads` WHERE " + " AND ".join(where)
               + vis_frag + f" ORDER BY {col} {direction}")
        all_leads = conn.execute(sql, params + vis_params).fetchall() or []

        umap = _user_map(conn)
        for ld in all_leads:
            ld['_age'] = _lead_age(ld)
            ld['_assigned_name'] = umap.get(ld.get('assigned_to'), '')
            ld['_team_names'] = [umap.get(int(x)) for x in
                                 (ld.get('team_members') or '').split(',')
                                 if x.strip().isdigit()]
            # avatar list = assigned + team (unique, names only)
            _av = []
            if ld['_assigned_name']:
                _av.append(ld['_assigned_name'])
            for nm in ld['_team_names']:
                if nm and nm not in _av:
                    _av.append(nm)
            ld['_avatars'] = _av

        # ── counts ──
        def _count(extra_where, extra_params):
            q = ("SELECT COUNT(*) AS c FROM `leads` WHERE is_deleted=0 "
                 + extra_where + vis_frag)
            r = conn.execute(q, extra_params + vis_params).fetchone()
            return r['c'] if r else 0

        total_count = _count("", [])
        statuses = conn.execute(
            "SELECT name, label, color FROM `lead_statuses` "
            "WHERE is_active=1 ORDER BY sort_order").fetchall() or []
        counts = {}
        for st in statuses:
            counts[st['name']] = _count(" AND status=%s", [st['name']])
        for s in ('open', 'in_process', 'close', 'cancel'):
            counts.setdefault(s, _count(" AND status=%s", [s]))

        # NPD / Existing-project counts — leads jo project me convert hue.
        # NPDProject integration is module ke scope me nahi, isliye 0 (UI parity).
        npd_count = 0
        epd_count = 0

        # trash count (visibility-aware)
        tq = "SELECT COUNT(*) AS c FROM `leads` WHERE is_deleted=1" + vis_frag
        deleted_count = (conn.execute(tq, vis_params).fetchone() or {}).get('c', 0)

        # filter option lists
        def _distinct(c):
            r = conn.execute(
                f"SELECT DISTINCT {c} AS v FROM `leads` "
                f"WHERE {c} IS NOT NULL AND {c}<>'' ORDER BY {c}").fetchall()
            return [x['v'] for x in (r or [])]

        all_sources = _distinct('source')
        all_categories = _distinct('category')
        all_ranges = _distinct('product_range')
        all_cities = _distinct('city')
        lead_sources = conn.execute(
            "SELECT name FROM `lead_sources` WHERE is_active=1 ORDER BY sort_order"
        ).fetchall() or []
        lead_categories = conn.execute(
            "SELECT name FROM `lead_categories` WHERE is_active=1 ORDER BY sort_order"
        ).fetchall() or []
        product_ranges = conn.execute(
            "SELECT name FROM `product_ranges` WHERE is_active=1 ORDER BY sort_order"
        ).fetchall() or []
        all_users = get_team_users()

        return render_template(
            'crm/leads/leads.html',
            leads=all_leads, counts=counts, total_count=total_count,
            list_columns=LEAD_LIST_COLUMNS,
            deleted_count=deleted_count, show_trash=show_trash,
            npd_count=npd_count, epd_count=epd_count,
            all_users=all_users, status=status, search=search,
            source=source, category=category, p_range=p_range, city=city,
            date_from=date_from, date_to=date_to,
            sort_by=sort_by, sort_dir=sort_dir,
            all_sources=all_sources, all_categories=all_categories,
            all_ranges=all_ranges, all_cities=all_cities,
            lead_statuses=statuses, lead_sources=lead_sources,
            lead_categories=lead_categories, product_ranges=product_ranges,
            is_admin=_is_admin(), is_admin_mgr=_is_admin_mgr(),
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='leads', user_name=_uname(), role=session.get('User_Type'),
        )
    finally:
        conn.close()


def _lead_age(ld):
    created = ld.get('created_at')
    if not created:
        return 0
    if isinstance(created, str):
        try:
            created = datetime.strptime(created[:19], '%Y-%m-%d %H:%M:%S')
        except Exception:
            return 0
    cdate = created.date()
    if ld.get('status') in ('close', 'cancel') and ld.get('closed_at'):
        end = ld['closed_at']
        if isinstance(end, str):
            try:
                end = datetime.strptime(end[:19], '%Y-%m-%d %H:%M:%S')
            except Exception:
                end = datetime.now()
        edate = end.date()
    else:
        edate = datetime.now().date()
    return max(0, (edate - cdate).days)


@crm_bp.app_template_filter('fmtdt')
def _fmtdt(val, fmt='%d %b %Y'):
    """Safe date formatter — works whether the DB returns datetime or str."""
    if val is None or val == '':
        return ''
    if isinstance(val, str):
        s = val.strip()
        parsed = None
        for f in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M',
                  '%Y-%m-%d'):
            try:
                parsed = datetime.strptime(s[:19], f)
                break
            except Exception:
                continue
        if parsed is None:
            return s  # unknown format → show raw
        val = parsed
    try:
        return val.strftime(fmt)
    except Exception:
        return str(val)


# ─────────────────────────────────────────────────────────────────────────────
# ADD
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/add', methods=['GET', 'POST'])
@login_required
def lead_add():
    conn = _db()
    try:
        if request.method == 'POST':
            f = request.form
            code = gen_lead_code(conn)
            team = ','.join(request.form.getlist('team_members'))
            cur = conn.execute(
                "INSERT INTO `leads` "
                "(code, title, contact_name, company_name, email, website, phone, "
                " alternate_mobile, source, status, lead_type, priority, "
                " expected_value, average_cost, assigned_to, follow_up_date, "
                " notes, position, address, city, state, country, zip_code, "
                " product_name, category, product_range, order_quantity, "
                " requirement_spec, tags, remark, team_members, created_by, "
                " created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
                "%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())",
                (code, f.get('title'), f.get('contact_name'), f.get('company_name'),
                 f.get('email'), f.get('website'), f.get('phone'),
                 f.get('alternate_mobile'), f.get('source'),
                 f.get('status', 'open'), f.get('lead_type', 'Quality'),
                 f.get('priority', 'medium'),
                 f.get('expected_value') or None,
                 f.get('average_cost') or None,
                 f.get('assigned_to') or None, f.get('follow_up_date') or None,
                 f.get('notes'), f.get('position'), f.get('address'),
                 f.get('city'), f.get('state'), f.get('country', 'India'),
                 f.get('zip_code'), f.get('product_name'), f.get('category'),
                 f.get('product_range'), f.get('order_quantity'),
                 f.get('requirement_spec'), f.get('tags'), f.get('remark'),
                 team, _uid()))
            new_id = cur.lastrowid
            if f.get('client_id'):
                conn.execute("UPDATE `leads` SET client_id=%s WHERE id=%s",
                             (f.get('client_id'), new_id))
            log_activity(conn, new_id, f"Lead created ({code})")
            conn.commit()
            flash(f'Lead {code} created.', 'success')
            return redirect(url_for('crm.lead_view', id=new_id))

        return render_template(
            'crm/leads/lead_form.html', lead=None, mode='add',
            all_users=get_team_users(),
            clients=conn.execute("SELECT id, code, company_name, contact_name FROM `client_masters` WHERE is_deleted=0 ORDER BY company_name").fetchall() or [],
            lead_statuses=_active(conn, 'lead_statuses'),
            lead_sources=_active(conn, 'lead_sources'),
            lead_categories=_active(conn, 'lead_categories'),
            product_ranges=_active(conn, 'product_ranges'),
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='leads', user_name=_uname(),
            role=session.get('User_Type'))
    finally:
        conn.close()


def _active(conn, table):
    return conn.execute(
        f"SELECT * FROM `{table}` WHERE is_active=1 ORDER BY sort_order"
    ).fetchall() or []


# ─────────────────────────────────────────────────────────────────────────────
# EDIT
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/edit', methods=['GET', 'POST'])
@login_required
def lead_edit(id):
    conn = _db()
    try:
        lead = conn.execute("SELECT * FROM `leads` WHERE id=%s", (id,)).fetchone()
        if not lead:
            abort(404)
        if request.method == 'POST':
            f = request.form
            team = ','.join(request.form.getlist('team_members'))
            conn.execute(
                "UPDATE `leads` SET title=%s, contact_name=%s, company_name=%s, "
                "email=%s, website=%s, phone=%s, alternate_mobile=%s, source=%s, "
                "lead_type=%s, priority=%s, expected_value=%s, average_cost=%s, "
                "assigned_to=%s, follow_up_date=%s, notes=%s, position=%s, "
                "address=%s, city=%s, state=%s, country=%s, zip_code=%s, "
                "product_name=%s, category=%s, product_range=%s, order_quantity=%s, "
                "requirement_spec=%s, tags=%s, remark=%s, team_members=%s, "
                "modified_by=%s WHERE id=%s",
                (f.get('title'), f.get('contact_name'), f.get('company_name'),
                 f.get('email'), f.get('website'), f.get('phone'),
                 f.get('alternate_mobile'), f.get('source'),
                 f.get('lead_type', 'Quality'), f.get('priority', 'medium'),
                 f.get('expected_value') or None, f.get('average_cost') or None,
                 f.get('assigned_to') or None,
                 f.get('follow_up_date') or None, f.get('notes'),
                 f.get('position'), f.get('address'), f.get('city'),
                 f.get('state'), f.get('country', 'India'), f.get('zip_code'),
                 f.get('product_name'), f.get('category'), f.get('product_range'),
                 f.get('order_quantity'), f.get('requirement_spec'),
                 f.get('tags'), f.get('remark'), team, _uid(), id))
            conn.execute("UPDATE `leads` SET client_id=%s WHERE id=%s",
                         (f.get('client_id') or None, id))
            log_activity(conn, id, "Lead details edited")
            add_contribution(conn, id, 'edit')
            conn.commit()
            flash('Lead updated.', 'success')
            return redirect(url_for('crm.lead_view', id=id))

        lead['_team_ids'] = [int(x) for x in (lead.get('team_members') or '').split(',')
                             if x.strip().isdigit()]
        return render_template(
            'crm/leads/lead_form.html', lead=lead, mode='edit',
            all_users=get_team_users(),
            clients=conn.execute("SELECT id, code, company_name, contact_name FROM `client_masters` WHERE is_deleted=0 ORDER BY company_name").fetchall() or [],
            lead_statuses=_active(conn, 'lead_statuses'),
            lead_sources=_active(conn, 'lead_sources'),
            lead_categories=_active(conn, 'lead_categories'),
            product_ranges=_active(conn, 'product_ranges'),
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='leads', user_name=_uname(),
            role=session.get('User_Type'))
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# VIEW (detail)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>')
@login_required
def lead_view(id):
    from werkzeug.exceptions import HTTPException
    conn = _db()
    try:
        lead = conn.execute("SELECT * FROM `leads` WHERE id=%s", (id,)).fetchone()
        if not lead:
            abort(404)
        umap = {}
        try:
            umap = _user_map(conn) or {}
        except Exception as e:
            print(f"[lead_view] _user_map failed: {e}")
        try:
            lead['_age'] = _lead_age(lead)
        except Exception:
            lead['_age'] = 0
        lead['_assigned_name'] = umap.get(lead.get('assigned_to'), '')
        try:
            lead['_team'] = [{'id': int(x), 'name': umap.get(int(x), f'#{x}')}
                             for x in (str(lead.get('team_members') or '')).split(',')
                             if str(x).strip().isdigit()]
        except Exception:
            lead['_team'] = []
        lead['_created_name'] = umap.get(lead.get('created_by'), '')

        def q(sql, params=()):
            try:
                return conn.execute(sql, params).fetchall() or []
            except Exception as e:
                print(f"[lead_view] sub-query failed: {e}")
                return []

        discussions = q("SELECT * FROM `lead_discussions` WHERE lead_id=%s "
                        "ORDER BY created_at DESC", (id,))
        for d in discussions:
            d['_user'] = umap.get(d.get('user_id'), 'User')
            d['_files'] = q("SELECT * FROM `lead_attachments` WHERE discussion_id=%s",
                            (d['id'],))

        reminders = q("SELECT * FROM `lead_reminders` WHERE lead_id=%s ORDER BY remind_at",
                      (id,))
        for r in reminders:
            r['_user'] = umap.get(r.get('user_id'), 'User')

        notes = q("SELECT * FROM `lead_notes` WHERE lead_id=%s AND user_id=%s "
                  "ORDER BY created_at DESC", (id, _uid()))

        logs = q("SELECT * FROM `lead_activity_logs` WHERE lead_id=%s "
                 "ORDER BY created_at DESC LIMIT 100", (id,))
        for lg in logs:
            lg['_user'] = umap.get(lg.get('user_id'), 'System')

        attachments = q("SELECT * FROM `lead_attachments` WHERE lead_id=%s "
                        "AND (discussion_id IS NULL) ORDER BY created_at DESC", (id,))

        contrib = q("SELECT user_id, SUM(points) AS pts, COUNT(*) AS cnt "
                    "FROM `lead_contributions` WHERE lead_id=%s GROUP BY user_id "
                    "ORDER BY pts DESC", (id,))
        for c in contrib:
            c['_user'] = umap.get(c.get('user_id'), 'User')

        try:
            statuses = _active(conn, 'lead_statuses')
        except Exception:
            statuses = []

        return render_template(
            'crm/leads/lead_view.html', lead=lead, discussions=discussions,
            reminders=reminders, notes=notes, logs=logs, attachments=attachments,
            contributions=contrib, lead_statuses=statuses,
            is_admin=_is_admin(), is_admin_mgr=_is_admin_mgr(), my_uid=_uid(),
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='leads', user_name=_uname(),
            role=session.get('User_Type'))
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(tb)
        return ("<pre style='padding:24px;font:13px/1.5 monospace;white-space:pre-wrap;"
                "color:#b91c1c'>LEAD VIEW ERROR:\n\n" + str(e) + "\n\n" + tb + "</pre>"), 500
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# DELETE / RESTORE / PERMANENT
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/delete', methods=['POST'])
@login_required
def lead_delete(id):
    conn = _db()
    try:
        conn.execute("UPDATE `leads` SET is_deleted=1, deleted_at=NOW() "
                     "WHERE id=%s", (id,))
        log_activity(conn, id, "Lead moved to trash")
        conn.commit()
        if request.is_json or request.headers.get('X-Requested-With'):
            return jsonify(ok=True)
        flash('Lead moved to trash.', 'success')
        return redirect(url_for('crm.leads'))
    finally:
        conn.close()


@crm_bp.route('/leads/<int:id>/restore', methods=['POST'])
@login_required
def lead_restore(id):
    conn = _db()
    try:
        conn.execute("UPDATE `leads` SET is_deleted=0, deleted_at=NULL "
                     "WHERE id=%s", (id,))
        log_activity(conn, id, "Lead restored from trash")
        conn.commit()
        if request.headers.get('X-Requested-With'):
            return jsonify(ok=True)
        flash('Lead restored.', 'success')
        return redirect(url_for('crm.leads', trash='1'))
    finally:
        conn.close()


@crm_bp.route('/leads/<int:id>/permanent-delete', methods=['POST'])
@login_required
def lead_permanent_delete(id):
    if not _is_admin():
        return jsonify(ok=False, error='Admin only'), 403
    conn = _db()
    try:
        for t in ('lead_discussions', 'lead_attachments', 'lead_reminders',
                  'lead_notes', 'lead_activity_logs', 'lead_contributions'):
            conn.execute(f"DELETE FROM `{t}` WHERE lead_id=%s", (id,))
        conn.execute("DELETE FROM `leads` WHERE id=%s", (id,))
        conn.commit()
        if request.headers.get('X-Requested-With'):
            return jsonify(ok=True)
        flash('Lead permanently deleted.', 'success')
        return redirect(url_for('crm.leads', trash='1'))
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# STATUS CHANGE  (workflow)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/status', methods=['POST'])
@crm_bp.route('/leads/<int:id>/update-status', methods=['POST'])
@login_required
def lead_update_status(id):
    new_status = (request.form.get('status')
                  or (request.json or {}).get('status') if request.is_json
                  else request.form.get('status'))
    lost_reason = request.form.get('lost_reason', '')
    if not new_status:
        return jsonify(ok=False, error='status required'), 400
    conn = _db()
    try:
        lead = conn.execute("SELECT * FROM `leads` WHERE id=%s", (id,)).fetchone()
        if not lead:
            return jsonify(ok=False, error='not found'), 404
        old = lead.get('status')
        closed = "NOW()" if new_status in ('close', 'cancel') else "NULL"
        conn.execute(
            f"UPDATE `leads` SET status=%s, lost_reason=%s, "
            f"closed_at={closed}, modified_by=%s WHERE id=%s",
            (new_status, lost_reason or lead.get('lost_reason'), _uid(), id))
        log_activity(conn, id, f"Status: {old} → {new_status}")
        add_contribution(conn, id, 'status_change',
                         note=f"{old} → {new_status}")
        if new_status == 'close':
            lead['status'] = new_status
            _handle_close_contribution(conn, lead)
        elif new_status == 'cancel':
            add_contribution(conn, id, 'cancel')
        conn.commit()
        if request.headers.get('X-Requested-With') or request.is_json:
            return jsonify(ok=True, status=new_status)
        flash('Status updated.', 'success')
        return redirect(url_for('crm.lead_view', id=id))
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# INLINE EDIT (ajax single field)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/discussion/add', methods=['POST'])
@login_required
def lead_discussion_add(id):
    comment = (request.form.get('comment') or '').strip()
    files = request.files.getlist('files')
    if not comment and not any(f.filename for f in files):
        flash('Comment ya file zaroori hai.', 'error')
        return redirect(url_for('crm.lead_view', id=id) + '#discussion')
    conn = _db()
    try:
        cur = conn.execute(
            "INSERT INTO `lead_discussions` (lead_id, user_id, comment, created_at) "
            "VALUES (%s, %s, %s, NOW())", (id, _uid(), comment or '(file)'))
        did = cur.lastrowid
        for fs in files:
            if not fs or not fs.filename:
                continue
            if not _allowed_file(fs.filename):
                continue
            fname = secure_filename(fs.filename)
            stamp = datetime.now().strftime('%Y%m%d%H%M%S')
            stored = f"{id}_{did}_{stamp}_{fname}"
            path = os.path.join(_upload_dir(), stored)
            fs.save(path)
            size = os.path.getsize(path)
            conn.execute(
                "INSERT INTO `lead_attachments` "
                "(lead_id, discussion_id, file_name, file_path, file_size, "
                " file_type, uploaded_by, created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())",
                (id, did, fname, f"leads/{stored}", size,
                 fname.rsplit('.', 1)[-1].lower(), _uid()))
        log_activity(conn, id, "Added a discussion comment")
        add_contribution(conn, id, 'comment')
        conn.commit()
        flash('Comment added.', 'success')
    finally:
        conn.close()
    return redirect(url_for('crm.lead_view', id=id) + '#discussion')


@crm_bp.route('/leads/discussion/<int:did>/delete', methods=['POST'])
@login_required
def lead_discussion_delete(did):
    conn = _db()
    try:
        d = conn.execute("SELECT * FROM `lead_discussions` WHERE id=%s",
                         (did,)).fetchone()
        if not d:
            return jsonify(ok=False), 404
        if d['user_id'] != _uid() and not _is_admin():
            return jsonify(ok=False, error='Not allowed'), 403
        lead_id = d['lead_id']
        atts = conn.execute(
            "SELECT file_path FROM `lead_attachments` WHERE discussion_id=%s",
            (did,)).fetchall() or []
        for a in atts:
            try:
                os.remove(os.path.join(current_app.root_path, 'static',
                                       'uploads', a['file_path']))
            except Exception:
                pass
        conn.execute("DELETE FROM `lead_attachments` WHERE discussion_id=%s", (did,))
        conn.execute("DELETE FROM `lead_discussions` WHERE id=%s", (did,))
        conn.commit()
        if request.headers.get('X-Requested-With'):
            return jsonify(ok=True)
        flash('Comment deleted.', 'success')
        return redirect(url_for('crm.lead_view', id=lead_id) + '#discussion')
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# REMINDERS
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/reminder/add', methods=['POST'])
@login_required
def lead_reminder_add(id):
    title = (request.form.get('title') or '').strip()
    remind_at = request.form.get('remind_at')
    desc = request.form.get('description', '')
    if not title or not remind_at:
        flash('Title aur date/time zaroori hai.', 'error')
        return redirect(url_for('crm.lead_view', id=id) + '#reminders')
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO `lead_reminders` "
            "(lead_id, user_id, title, description, remind_at, created_at) "
            "VALUES (%s,%s,%s,%s,%s,NOW())",
            (id, _uid(), title, desc, remind_at.replace('T', ' ')))
        log_activity(conn, id, f"Reminder set: {title}")
        add_contribution(conn, id, 'reminder')
        conn.commit()
        flash('Reminder added.', 'success')
    finally:
        conn.close()
    return redirect(url_for('crm.lead_view', id=id) + '#reminders')


@crm_bp.route('/leads/reminder/<int:rid>/done', methods=['POST'])
@login_required
def lead_reminder_done(rid):
    conn = _db()
    try:
        conn.execute("UPDATE `lead_reminders` SET is_done=1 WHERE id=%s", (rid,))
        conn.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


@crm_bp.route('/leads/reminder/<int:rid>/delete', methods=['POST'])
@login_required
def lead_reminder_delete(rid):
    conn = _db()
    try:
        conn.execute("DELETE FROM `lead_reminders` WHERE id=%s", (rid,))
        conn.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# PERSONAL NOTES (private per user)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/note/add', methods=['POST'])
@login_required
def lead_note_add(id):
    note = (request.form.get('note') or '').strip()
    if not note:
        return redirect(url_for('crm.lead_view', id=id) + '#notes')
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO `lead_notes` (lead_id, user_id, note, created_at) "
            "VALUES (%s,%s,%s,NOW())", (id, _uid(), note))
        conn.commit()
        flash('Note saved.', 'success')
    finally:
        conn.close()
    return redirect(url_for('crm.lead_view', id=id) + '#notes')


@crm_bp.route('/leads/note/<int:nid>/delete', methods=['POST'])
@login_required
def lead_note_delete(nid):
    conn = _db()
    try:
        n = conn.execute("SELECT * FROM `lead_notes` WHERE id=%s", (nid,)).fetchone()
        if n and (n['user_id'] == _uid() or _is_admin()):
            conn.execute("DELETE FROM `lead_notes` WHERE id=%s", (nid,))
            conn.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ATTACHMENT serve / download
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/attachment/<int:aid>')
@login_required
def lead_attachment_serve(aid):
    conn = _db()
    try:
        a = conn.execute("SELECT * FROM `lead_attachments` WHERE id=%s",
                         (aid,)).fetchone()
        if not a:
            abort(404)
        full = os.path.join(current_app.root_path, 'static', 'uploads',
                            a['file_path'])
        if not os.path.exists(full):
            abort(404)
        return send_file(full, as_attachment=False,
                         download_name=a['file_name'])
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# MASTER QUICK-ADD ( + buttons: status / source / category / range )
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/master/<kind>/add', methods=['POST'])
@login_required
def master_add(kind):
    name = (request.form.get('name') or '').strip()
    if not name:
        return jsonify(ok=False, error='name required'), 400
    tbl = {'status': 'lead_statuses', 'source': 'lead_sources',
           'category': 'lead_categories', 'range': 'product_ranges'}.get(kind)
    if not tbl:
        return jsonify(ok=False, error='bad kind'), 400
    key = name.lower().replace(' ', '_')
    conn = _db()
    try:
        if tbl == 'lead_statuses':
            label = request.form.get('label') or name
            color = request.form.get('color') or '#64748b'
            conn.execute(
                "INSERT INTO `lead_statuses` (name,label,color,sort_order,is_active)"
                " VALUES (%s,%s,%s,99,1) ON DUPLICATE KEY UPDATE is_active=1",
                (key, label, color))
            conn.commit()
            return jsonify(ok=True, name=key, label=label)
        conn.execute(
            f"INSERT INTO `{tbl}` (name,sort_order,is_active) "
            f"SELECT %s,99,1 FROM DUAL WHERE NOT EXISTS "
            f"(SELECT 1 FROM `{tbl}` WHERE name=%s)", (name, name))
        conn.execute(f"UPDATE `{tbl}` SET is_active=1 WHERE name=%s", (name,))
        conn.commit()
        return jsonify(ok=True, name=name, label=name)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# IMPORT (CSV / Excel)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/import', methods=['GET', 'POST'])
@login_required
def leads_import():
    if request.method == 'GET':
        return render_template(
            'crm/leads/import_leads.html',
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='imp-leads', user_name=_uname(),
            role=session.get('User_Type'))
    f = request.files.get('file')
    if not f or not f.filename:
        flash('Koi file select nahi hui.', 'error')
        return redirect(url_for('crm.leads_import'))
    name = f.filename.lower()
    rows = []
    try:
        if name.endswith('.csv'):
            import csv
            data = f.read().decode('utf-8-sig', errors='ignore').splitlines()
            for r in csv.DictReader(data):
                rows.append({(k or '').strip().lower(): (str(v).strip() if v is not None else '')
                             for k, v in r.items()})
        elif name.endswith(('.xlsx', '.xls')):
            from openpyxl import load_workbook
            wb = load_workbook(f, read_only=True, data_only=True)
            ws = wb.active
            it = ws.iter_rows(values_only=True)
            hdr = [str(h or '').strip().lower() for h in next(it, [])]
            for r in it:
                rows.append({hdr[i]: (str(c).strip() if c is not None else '')
                             for i, c in enumerate(r) if i < len(hdr)})
        else:
            flash('Sirf .csv ya .xlsx file allowed hai.', 'error')
            return redirect(url_for('crm.leads_import'))
    except Exception as e:
        flash(f'File padh nahi paaye: {e}', 'error')
        return redirect(url_for('crm.leads_import'))

    alias = {
        'name': 'contact_name', 'contact name': 'contact_name', 'contact_name': 'contact_name',
        'company': 'company_name', 'company name': 'company_name', 'company_name': 'company_name',
        'email': 'email', 'mobile': 'phone', 'phone': 'phone',
        'alt mobile': 'alternate_mobile', 'alternate_mobile': 'alternate_mobile',
        'product': 'product_name', 'product name': 'product_name', 'product_name': 'product_name',
        'category': 'category', 'product range': 'product_range', 'product_range': 'product_range',
        'source': 'source', 'city': 'city', 'state': 'state',
        'country': 'country', 'zip': 'zip_code', 'zip_code': 'zip_code', 'pincode': 'zip_code',
        'status': 'status', 'lead type': 'lead_type', 'lead_type': 'lead_type',
        'priority': 'priority', 'website': 'website', 'position': 'position', 'address': 'address',
        'tags': 'tags', 'order quantity': 'order_quantity', 'order_quantity': 'order_quantity',
        'requirement_spec': 'requirement_spec', 'requirement spec': 'requirement_spec',
        'remark': 'remark', 'remarks': 'remark',
    }
    LEAD_COLS = ['contact_name', 'company_name', 'email', 'phone', 'alternate_mobile',
                 'website', 'position', 'address', 'city', 'state', 'country', 'zip_code',
                 'product_name', 'category', 'product_range', 'order_quantity',
                 'requirement_spec', 'remark', 'source', 'tags', 'lead_type', 'priority']
    valid_status = {'open', 'in_process', 'close', 'cancel'}
    conn = _db()
    inserted, skipped = 0, 0
    try:
        for r in rows:
            rec = {}
            for k, v in r.items():
                if k in alias and v:
                    rec[alias[k]] = v
            cname = rec.get('contact_name')
            if not cname:
                skipped += 1
                continue
            st = (rec.get('status') or 'open').lower().replace(' ', '_')
            if st not in valid_status:
                st = 'open'
            code = gen_lead_code(conn)
            cols, ph, vals = ['code'], ['%s'], [code]
            for c in LEAD_COLS:
                if rec.get(c):
                    cols.append(c); ph.append('%s'); vals.append(rec[c])
            cols += ['status', 'created_by', 'created_at']
            ph += ['%s', '%s', 'NOW()']
            vals += [st, _uid()]
            sql = ("INSERT INTO `leads` (" + ",".join("`" + c + "`" for c in cols)
                   + ") VALUES (" + ",".join(ph) + ")")
            conn.execute(sql, vals)
            inserted += 1
        conn.commit()
        flash(f'{inserted} leads import hue.'
              + (f' {skipped} skip (name missing).' if skipped else ''), 'success')
    except Exception as e:
        flash(f'Import error: {e}', 'error')
    finally:
        conn.close()
    return redirect(url_for('crm.leads'))


@crm_bp.route('/leads/import/template')
@login_required
def leads_import_template():
    from openpyxl import Workbook
    from openpyxl.worksheet.datavalidation import DataValidation
    import io
    wb = Workbook()
    ws = wb.active
    ws.title = 'Leads'
    headers = ['name', 'position', 'email', 'mobile', 'alternate_mobile', 'company',
               'website', 'city', 'state', 'country', 'zip_code', 'product_name',
               'category', 'product_range', 'order_quantity', 'source', 'status',
               'lead_type', 'requirement_spec', 'remark', 'tags']
    ws.append(headers)
    ws.append(['John Doe', 'CEO', 'john@abc.com', '9999999999', '8888888888', 'ABC Corp',
               'www.abc.com', 'Mumbai', 'Maharashtra', 'India', '400001', 'Face Wash',
               'Skin Care', 'Premium', '500 units', 'HCP Website', 'open', 'Quality',
               'Vitamin C face wash', 'Urgent requirement', 'skincare, premium'])
    dv_st = DataValidation(type='list', formula1='"open,in_process,close,cancel"', allow_blank=True)
    dv_lt = DataValidation(type='list', formula1='"Quality,Non-Quality"', allow_blank=True)
    ws.add_data_validation(dv_st); ws.add_data_validation(dv_lt)
    dv_st.add('Q2:Q1000'); dv_lt.add('R2:R1000')
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 16
    bio = io.BytesIO(); wb.save(bio); bio.seek(0)
    from flask import send_file
    return send_file(bio, as_attachment=True, download_name='leads_import_template.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ─────────────────────────────────────────────────────────────────────────────
# EXPORT (Excel)
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/leads/<int:id>/inline-edit', methods=['POST'])
@login_required
def lead_inline_edit(id):
    """List page se cell-level quick edit (AJAX JSON: {field, value})."""
    data = request.get_json(silent=True) or {}
    field = (data.get('field') or '').strip()
    value = data.get('value', '')
    allowed = {
        'contact_name', 'company_name', 'email', 'phone', 'alternate_mobile',
        'website', 'position', 'city', 'state', 'country', 'zip_code', 'source',
        'product_name', 'category', 'product_range', 'order_quantity', 'tags',
        'status', 'lead_type', 'average_cost',
    }
    if field not in allowed:
        return jsonify(success=False, error='Field not allowed'), 400
    if isinstance(value, str):
        value = value.strip()
    if field == 'lead_type' and value not in ('Quality', 'Non-Quality'):
        return jsonify(success=False, error='Invalid lead type'), 400
    if field == 'average_cost':
        try:
            value = float(value) if value not in ('', None) else None
        except Exception:
            return jsonify(success=False, error='Invalid number'), 400
    conn = _db()
    try:
        lead = conn.execute(
            "SELECT id FROM `leads` WHERE id=%s AND is_deleted=0", (id,)).fetchone()
        if not lead:
            return jsonify(success=False, error='Lead not found'), 404
        conn.execute(
            f"UPDATE `leads` SET `{field}`=%s, modified_by=%s, updated_at=NOW() "
            f"WHERE id=%s", (value, _uid(), id))
        try:
            log_activity(conn, id, f'Inline edit: {field} updated')
        except Exception:
            pass
        conn.commit()
        return jsonify(success=True, field=field, value=value)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify(success=False, error=str(e)), 500
    finally:
        conn.close()


@crm_bp.route('/leads/export')
@login_required
def leads_export():
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
    except Exception:
        flash('openpyxl not installed.', 'error')
        return redirect(url_for('crm.leads'))
    conn = _db()
    try:
        vis_frag, vis_params = _visibility_sql()
        rows = conn.execute(
            "SELECT * FROM `leads` WHERE is_deleted=0" + vis_frag
            + " ORDER BY created_at DESC", vis_params).fetchall() or []

        def d(val):
            """date → dd-mm-yyyy (string ya datetime dono)."""
            if not val:
                return ''
            if isinstance(val, str):
                v = val.strip()
                for f in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d'):
                    try:
                        from datetime import datetime as _dt
                        return _dt.strptime(v[:19], f).strftime('%d-%m-%Y')
                    except Exception:
                        continue
                return v
            try:
                return val.strftime('%d-%m-%Y')
            except Exception:
                return str(val)

        ST = {'open': 'Open', 'in_process': 'In Process',
              'close': 'Close', 'cancel': 'Cancel'}

        wb = Workbook()
        ws = wb.active
        ws.title = 'Leads'
        headers = ['Created Date', 'Code', 'Company', 'Contact Name', 'Position',
                   'Email', 'Mobile', 'Alt Mobile', 'Website', 'City', 'State',
                   'Country', 'Source', 'Product Name', 'Category', 'Product Range',
                   'Order Quantity', 'Expected Value', 'Priority', 'Status',
                   'Lead Type', 'Follow Up Date', 'Last Contact', 'Tags',
                   'Lead Age (Days)']
        ws.append(headers)
        for r in rows:
            ws.append([
                d(r.get('created_at')), r.get('code') or '',
                r.get('company_name') or '', r.get('contact_name') or '',
                r.get('position') or '', r.get('email') or '',
                r.get('phone') or '', r.get('alternate_mobile') or '',
                r.get('website') or '', r.get('city') or '', r.get('state') or '',
                r.get('country') or '', r.get('source') or '',
                r.get('product_name') or '', r.get('category') or '',
                r.get('product_range') or '', r.get('order_quantity') or '',
                (float(r['expected_value']) if r.get('expected_value') is not None
                 else ''),
                r.get('priority') or '', ST.get(r.get('status'), r.get('status') or ''),
                r.get('lead_type') or '', d(r.get('follow_up_date')),
                d(r.get('last_contact')), r.get('tags') or '',
                str(_lead_age(r)),
            ])

        # header styling
        hf = Font(bold=True, color='FFFFFF')
        fill = PatternFill('solid', fgColor='2563EB')
        for c in ws[1]:
            c.font = hf
            c.fill = fill
            c.alignment = Alignment(vertical='center')
        ws.freeze_panes = 'A2'
        widths = [13, 11, 24, 20, 14, 24, 13, 13, 18, 14, 14, 12, 16, 22, 14,
                  14, 14, 14, 10, 12, 11, 14, 14, 18, 14]
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w

        # Summary sheet
        s = wb.create_sheet('Summary')
        s['A1'] = 'HCP ERP — Leads Export'
        s['A1'].font = Font(bold=True, size=13)
        s['A3'] = 'Date'
        s['B3'] = datetime.now().strftime('%d-%m-%Y')
        s['A4'] = 'Total Leads'
        s['B4'] = len(rows)
        for cell in ('A3', 'A4'):
            s[cell].font = Font(bold=True)
        s.column_dimensions['A'].width = 18
        s.column_dimensions['B'].width = 18

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        fname = f"HCP_Leads_{datetime.now().strftime('%Y-%m-%d')}.xlsx"
        return send_file(
            buf, as_attachment=True, download_name=fname,
            mimetype='application/vnd.openxmlformats-officedocument.'
                     'spreadsheetml.sheet')
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# TABLE BOOTSTRAP  (idempotent — call once at app startup)
# ─────────────────────────────────────────────────────────────────────────────
def ensure_lead_tables():
    """Create all CRM Lead tables + seed masters/config if missing.
    Mirrors migrations/crm_leads_mysql.sql so first run never needs the CLI."""
    conn = _db()
    if not conn:
        print("[crm_leads] DB connection failed; tables not created.")
        return
    try:
        ddl = [
            """CREATE TABLE IF NOT EXISTS `lead_statuses` (
                id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(30) NOT NULL,
                label VARCHAR(60) NOT NULL, color VARCHAR(20) DEFAULT '#64748b',
                icon VARCHAR(40), sort_order INT DEFAULT 0,
                is_active TINYINT(1) DEFAULT 1,
                UNIQUE KEY uq_lead_status_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_sources` (
                id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
                sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
                UNIQUE KEY uq_lead_source_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_categories` (
                id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
                sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
                UNIQUE KEY uq_lead_category_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `product_ranges` (
                id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
                sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
                UNIQUE KEY uq_product_range_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `leads` (
                id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30),
                title VARCHAR(200), contact_name VARCHAR(150) NOT NULL,
                company_name VARCHAR(200), email VARCHAR(150), website VARCHAR(200),
                phone VARCHAR(20), alternate_mobile VARCHAR(20), source VARCHAR(100),
                status VARCHAR(30) DEFAULT 'open', lead_type VARCHAR(20) DEFAULT 'Quality',
                priority VARCHAR(20) DEFAULT 'medium', expected_value DECIMAL(12,2),
                assigned_to INT, follow_up_date DATE, notes TEXT,
                lost_reason VARCHAR(200), customer_id INT, position VARCHAR(100),
                address TEXT, city VARCHAR(100), state VARCHAR(100),
                country VARCHAR(100) DEFAULT 'India', zip_code VARCHAR(10),
                average_cost DECIMAL(12,2) DEFAULT 0, product_name VARCHAR(200),
                category VARCHAR(100), product_range VARCHAR(100),
                order_quantity VARCHAR(100), requirement_spec TEXT, tags VARCHAR(300),
                remark TEXT, last_contact DATETIME, team_members TEXT,
                client_id INT, client_attachment VARCHAR(300),
                is_deleted TINYINT(1) NOT NULL DEFAULT 0, deleted_at DATETIME,
                closed_at DATETIME, created_by INT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, modified_by INT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_lead_code (code), KEY idx_lead_status (status),
                KEY idx_lead_deleted (is_deleted), KEY idx_lead_assigned (assigned_to),
                KEY idx_lead_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_discussions` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL,
                user_id INT NOT NULL, comment TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_disc_lead (lead_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_attachments` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL,
                discussion_id INT, file_name VARCHAR(300) NOT NULL,
                file_path VARCHAR(500) NOT NULL, file_size INT, file_type VARCHAR(100),
                uploaded_by INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_att_lead (lead_id), KEY idx_att_disc (discussion_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_reminders` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL,
                user_id INT NOT NULL, title VARCHAR(300) NOT NULL, description TEXT,
                remind_at DATETIME NOT NULL, is_done TINYINT(1) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_rem_lead (lead_id), KEY idx_rem_at (remind_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_notes` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL,
                user_id INT NOT NULL, note TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_note_lead (lead_id), KEY idx_note_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_activity_logs` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL, user_id INT,
                action VARCHAR(500) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_log_lead (lead_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `lead_contributions` (
                id INT AUTO_INCREMENT PRIMARY KEY, lead_id INT NOT NULL,
                user_id INT NOT NULL, action_type VARCHAR(30) NOT NULL,
                points INT DEFAULT 0, note VARCHAR(200),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_contrib_lead (lead_id), KEY idx_contrib_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `contribution_config` (
                id INT AUTO_INCREMENT PRIMARY KEY, action_type VARCHAR(30) NOT NULL,
                label VARCHAR(100) NOT NULL, points INT DEFAULT 0,
                description VARCHAR(200), updated_by INT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_contrib_action (action_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `client_masters` (
                id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(20),
                company_name VARCHAR(200), contact_name VARCHAR(150) NOT NULL,
                position VARCHAR(100), email VARCHAR(150), website VARCHAR(200),
                mobile VARCHAR(20), alternate_mobile VARCHAR(20), gstin VARCHAR(20),
                status VARCHAR(20) DEFAULT 'active', address TEXT, city VARCHAR(100),
                state VARCHAR(100), country VARCHAR(100) DEFAULT 'India',
                zip_code VARCHAR(10), notes TEXT,
                is_deleted TINYINT(1) NOT NULL DEFAULT 0, deleted_at DATETIME,
                created_by INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                modified_by INT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_client_code (code), KEY idx_client_deleted (is_deleted)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `client_brands` (
                id INT AUTO_INCREMENT PRIMARY KEY, client_id INT NOT NULL,
                brand_name VARCHAR(200) NOT NULL, category VARCHAR(100),
                description TEXT, is_active TINYINT(1) DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_brand_client (client_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
            """CREATE TABLE IF NOT EXISTS `client_addresses` (
                id INT AUTO_INCREMENT PRIMARY KEY, client_id INT NOT NULL,
                brand_index INT DEFAULT 0, title VARCHAR(100) NOT NULL DEFAULT 'Address',
                addr_type VARCHAR(20) DEFAULT 'billing', address TEXT, city VARCHAR(100),
                state VARCHAR(100), country VARCHAR(100) DEFAULT 'India',
                zip_code VARCHAR(10), is_default TINYINT(1) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY idx_caddr_client (client_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
        ]
        for q in ddl:
            conn.execute(q)
        conn.commit()

        # seed (INSERT IGNORE)
        seed = [
            ("INSERT IGNORE INTO `lead_statuses` (name,label,color,sort_order,is_active) VALUES "
             "('open','Open','#2563eb',1,1),('in_process','In Process','#d97706',2,1),"
             "('close','Close (Won)','#16a34a',3,1),('cancel','Cancel','#dc2626',4,1)"),
            ("INSERT IGNORE INTO `lead_sources` (name,sort_order,is_active) VALUES "
             "('Website',1,1),('Referral',2,1),('IndiaMART',3,1),('Exhibition',4,1),"
             "('Cold Call',5,1),('Social Media',6,1),('Walk-in',7,1),('Other',8,1)"),
            ("INSERT IGNORE INTO `lead_categories` (name,sort_order,is_active) VALUES "
             "('Skin Care',1,1),('Hair Care',2,1),('Personal Care',3,1),"
             "('Cosmetics',4,1),('Ayurvedic',5,1),('Other',6,1)"),
            ("INSERT IGNORE INTO `product_ranges` (name,sort_order,is_active) VALUES "
             "('Premium',1,1),('Standard',2,1),('Economy',3,1)"),
            ("INSERT IGNORE INTO `contribution_config` (action_type,label,points,description) VALUES "
             "('comment','Comment / Discussion',1,'Comment add'),"
             "('status_change','Status Change',2,'Status change'),"
             "('close_fast','Fast Close (1-7d)',8,'Close within 7 days'),"
             "('close_slow','Slow Close (29d+)',0,'Close after 29 days'),"
             "('cancel','Cancel',0,'Lead cancel'),"
             "('follow_up','Follow Up',1,'Follow-up set'),"
             "('reminder','Reminder',1,'Reminder add'),"
             "('edit','Edit',1,'Lead edit')"),
        ]
        for q in seed:
            conn.execute(q)
        conn.commit()
        print("[crm_leads] tables ready.")
    except Exception as e:
        print(f"[crm_leads] ensure_lead_tables error: {e}")
    finally:
        conn.close()


# ═════════════════════════════════════════════════════════════════════════════
# CLIENT MASTER  (clients + brands + addresses)
# ═════════════════════════════════════════════════════════════════════════════
import json as _json


def gen_client_code(conn):
    row = conn.execute(
        "SELECT code FROM `client_masters` WHERE code LIKE 'CLT-%' "
        "ORDER BY id DESC LIMIT 1").fetchone()
    n = 1
    if row and row.get('code'):
        try:
            n = int(row['code'].split('-')[1]) + 1
        except Exception:
            n = 1
    return f"CLT-{n:04d}"


@crm_bp.route('/clients')
@login_required
def clients():
    show_trash = request.args.get('trash', '') == '1'
    search = request.args.get('search', '')
    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        where = ["is_deleted=%s"]
        params = [1 if show_trash else 0]
        if search:
            s = f"%{search}%"
            cols = ['code', 'company_name', 'contact_name', 'mobile', 'email',
                    'city', 'gstin']
            where.append("(" + " OR ".join(f"{c} LIKE %s" for c in cols) + ")")
            params.extend([s] * len(cols))
        rows = conn.execute(
            "SELECT * FROM `client_masters` WHERE " + " AND ".join(where)
            + " ORDER BY created_at DESC", params).fetchall() or []
        # brands per client (for Brands column)
        for c in rows:
            brs = conn.execute(
                "SELECT brand_name FROM `client_brands` WHERE client_id=%s "
                "AND is_active=1", (c['id'],)).fetchall() or []
            c['_brands'] = [b['brand_name'] for b in brs]
        total_count = (conn.execute(
            "SELECT COUNT(*) AS c FROM `client_masters` WHERE is_deleted=0"
        ).fetchone() or {}).get('c', 0)
        deleted_count = (conn.execute(
            "SELECT COUNT(*) AS c FROM `client_masters` WHERE is_deleted=1"
        ).fetchone() or {}).get('c', 0)
        return render_template(
            'crm/clients/clients.html', clients=rows, total_count=total_count,
            deleted_count=deleted_count, show_trash=show_trash, search=search,
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='clients', user_name=_uname(),
            role=session.get('User_Type'))
    finally:
        conn.close()


def _save_client_brands(conn, client_id, brands):
    """brands = list of {brand_name, category, description, billing{...}, shipping{...}}"""
    conn.execute("DELETE FROM `client_brands` WHERE client_id=%s", (client_id,))
    conn.execute("DELETE FROM `client_addresses` WHERE client_id=%s", (client_id,))
    for idx, b in enumerate(brands):
        bn = (b.get('brand_name') or '').strip()
        if not bn:
            continue
        conn.execute(
            "INSERT INTO `client_brands` (client_id,brand_name,category,description,"
            "is_active,created_at) VALUES (%s,%s,%s,%s,1,NOW())",
            (client_id, bn, b.get('category'), b.get('description')))
        for kind in ('billing', 'shipping'):
            a = b.get(kind) or {}
            if any((a.get('address'), a.get('city'), a.get('state'),
                    a.get('zip_code'))):
                conn.execute(
                    "INSERT INTO `client_addresses` (client_id,brand_index,title,"
                    "addr_type,address,city,state,country,zip_code,is_default,"
                    "created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())",
                    (client_id, idx, kind.title(), kind, a.get('address'),
                     a.get('city'), a.get('state'), a.get('country', 'India'),
                     a.get('zip_code'), 1 if kind == 'billing' else 0))


@crm_bp.route('/clients/add', methods=['GET', 'POST'])
@login_required
def client_add():
    conn = _db()
    try:
        if request.method == 'POST':
            f = request.form
            code = gen_client_code(conn)
            cur = conn.execute(
                "INSERT INTO `client_masters` (code,company_name,contact_name,"
                "position,email,website,mobile,alternate_mobile,gstin,status,"
                "address,city,state,country,zip_code,notes,created_by,created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())",
                (code, f.get('company_name'), f.get('contact_name'),
                 f.get('position'), f.get('email'), f.get('website'),
                 f.get('mobile'), f.get('alternate_mobile'), f.get('gstin'),
                 f.get('status', 'active'), f.get('address'), f.get('city'),
                 f.get('state'), f.get('country', 'India'), f.get('zip_code'),
                 f.get('notes'), _uid()))
            cid = cur.lastrowid
            try:
                brands = _json.loads(f.get('brands_json') or '[]')
            except Exception:
                brands = []
            _save_client_brands(conn, cid, brands)
            conn.commit()
            flash(f'Client {code} created.', 'success')
            return redirect(url_for('crm.clients'))
        return render_template(
            'crm/clients/client_form.html', client=None, mode='add', brands=[],
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='clients', user_name=_uname(),
            role=session.get('User_Type'))
    finally:
        conn.close()


@crm_bp.route('/clients/<int:id>/edit', methods=['GET', 'POST'])
@login_required
def client_edit(id):
    conn = _db()
    try:
        client = conn.execute("SELECT * FROM `client_masters` WHERE id=%s",
                              (id,)).fetchone()
        if not client:
            abort(404)
        if request.method == 'POST':
            f = request.form
            conn.execute(
                "UPDATE `client_masters` SET company_name=%s,contact_name=%s,"
                "position=%s,email=%s,website=%s,mobile=%s,alternate_mobile=%s,"
                "gstin=%s,status=%s,address=%s,city=%s,state=%s,country=%s,"
                "zip_code=%s,notes=%s,modified_by=%s WHERE id=%s",
                (f.get('company_name'), f.get('contact_name'), f.get('position'),
                 f.get('email'), f.get('website'), f.get('mobile'),
                 f.get('alternate_mobile'), f.get('gstin'),
                 f.get('status', 'active'), f.get('address'), f.get('city'),
                 f.get('state'), f.get('country', 'India'), f.get('zip_code'),
                 f.get('notes'), _uid(), id))
            try:
                brands = _json.loads(f.get('brands_json') or '[]')
            except Exception:
                brands = []
            _save_client_brands(conn, id, brands)
            conn.commit()
            flash('Client updated.', 'success')
            return redirect(url_for('crm.clients'))
        # build brands payload for edit
        brs = conn.execute(
            "SELECT * FROM `client_brands` WHERE client_id=%s ORDER BY id",
            (id,)).fetchall() or []
        addrs = conn.execute(
            "SELECT * FROM `client_addresses` WHERE client_id=%s", (id,)
        ).fetchall() or []
        brands = []
        for idx, b in enumerate(brs):
            bill = next((a for a in addrs if a['brand_index'] == idx
                         and a['addr_type'] == 'billing'), {})
            ship = next((a for a in addrs if a['brand_index'] == idx
                         and a['addr_type'] == 'shipping'), {})
            brands.append({
                'brand_name': b['brand_name'], 'category': b.get('category') or '',
                'description': b.get('description') or '',
                'billing': {k: (bill.get(k) or '') for k in
                            ('address', 'city', 'state', 'country', 'zip_code')},
                'shipping': {k: (ship.get(k) or '') for k in
                             ('address', 'city', 'state', 'country', 'zip_code')},
            })
        return render_template(
            'crm/clients/client_form.html', client=client, mode='edit',
            brands=brands,
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='clients', user_name=_uname(),
            role=session.get('User_Type'))
    finally:
        conn.close()


@crm_bp.route('/clients/<int:id>/delete', methods=['POST'])
@login_required
def client_delete(id):
    conn = _db()
    try:
        conn.execute("UPDATE `client_masters` SET is_deleted=1, deleted_at=NOW() "
                     "WHERE id=%s", (id,))
        conn.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


@crm_bp.route('/clients/<int:id>/restore', methods=['POST'])
@login_required
def client_restore(id):
    conn = _db()
    try:
        conn.execute("UPDATE `client_masters` SET is_deleted=0, deleted_at=NULL "
                     "WHERE id=%s", (id,))
        conn.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


# ═════════════════════════════════════════════════════════════════════════════
# CLIENT IMPORT  (full page + template)
# ═════════════════════════════════════════════════════════════════════════════
@crm_bp.route('/clients/import', methods=['GET', 'POST'])
@login_required
def clients_import():
    if request.method == 'GET':
        return render_template(
            'crm/clients/import_clients.html',
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='imp-clients', user_name=_uname(),
            role=session.get('User_Type'))
    f = request.files.get('file')
    if not f or not f.filename:
        flash('Koi file select nahi hui.', 'error')
        return redirect(url_for('crm.clients_import'))
    name = f.filename.lower()
    rows = []
    try:
        if name.endswith('.csv'):
            import csv
            data = f.read().decode('utf-8-sig', errors='ignore').splitlines()
            for r in csv.DictReader(data):
                rows.append({(k or '').strip().lower(): (str(v).strip() if v is not None else '')
                             for k, v in r.items()})
        elif name.endswith(('.xlsx', '.xls')):
            from openpyxl import load_workbook
            wb = load_workbook(f, read_only=True, data_only=True)
            ws = wb.active
            it = ws.iter_rows(values_only=True)
            hdr = [str(h or '').strip().lower() for h in next(it, [])]
            for r in it:
                rows.append({hdr[i]: (str(c).strip() if c is not None else '')
                             for i, c in enumerate(r) if i < len(hdr)})
        else:
            flash('Sirf .csv ya .xlsx file allowed hai.', 'error')
            return redirect(url_for('crm.clients_import'))
    except Exception as e:
        flash(f'File padh nahi paaye: {e}', 'error')
        return redirect(url_for('crm.clients_import'))

    alias = {
        'name': 'contact_name', 'contact name': 'contact_name', 'contact_name': 'contact_name',
        'company': 'company_name', 'company name': 'company_name', 'company_name': 'company_name',
        'position': 'position', 'email': 'email', 'website': 'website',
        'mobile': 'mobile', 'phone': 'mobile', 'alt mobile': 'alternate_mobile',
        'alternate_mobile': 'alternate_mobile', 'gstin': 'gstin', 'gst': 'gstin',
        'status': 'status', 'address': 'address', 'city': 'city', 'state': 'state',
        'country': 'country', 'zip': 'zip_code', 'zip_code': 'zip_code', 'pincode': 'zip_code',
        'notes': 'notes',
    }
    CLIENT_COLS = ['company_name', 'contact_name', 'position', 'email', 'website',
                   'mobile', 'alternate_mobile', 'gstin', 'address', 'city', 'state',
                   'country', 'zip_code', 'notes']
    conn = _db()
    inserted, skipped = 0, 0
    try:
        for r in rows:
            rec = {}
            for k, v in r.items():
                if k in alias and v:
                    rec[alias[k]] = v
            cname = rec.get('contact_name')
            if not cname:
                skipped += 1
                continue
            st = (rec.get('status') or 'active').lower()
            if st not in ('active', 'inactive'):
                st = 'active'
            code = gen_client_code(conn)
            cols, ph, vals = ['code'], ['%s'], [code]
            for c in CLIENT_COLS:
                if rec.get(c):
                    cols.append(c); ph.append('%s'); vals.append(rec[c])
            cols += ['status', 'created_by', 'created_at']
            ph += ['%s', '%s', 'NOW()']
            vals += [st, _uid()]
            sql = ("INSERT INTO `client_masters` (" + ",".join("`" + c + "`" for c in cols)
                   + ") VALUES (" + ",".join(ph) + ")")
            conn.execute(sql, vals)
            inserted += 1
        conn.commit()
        flash(f'{inserted} clients import hue.'
              + (f' {skipped} skip (name missing).' if skipped else ''), 'success')
    except Exception as e:
        flash(f'Import error: {e}', 'error')
    finally:
        conn.close()
    return redirect(url_for('crm.clients'))


@crm_bp.route('/clients/import/template')
@login_required
def clients_import_template():
    from openpyxl import Workbook
    from openpyxl.worksheet.datavalidation import DataValidation
    import io
    wb = Workbook(); ws = wb.active; ws.title = 'Clients'
    headers = ['name', 'company', 'position', 'email', 'website', 'mobile',
               'alternate_mobile', 'gstin', 'status', 'address', 'city', 'state',
               'country', 'zip_code', 'notes']
    ws.append(headers)
    ws.append(['Ramesh Shah', 'ABC Cosmetics Pvt Ltd', 'Director', 'ramesh@abc.com',
               'www.abc.com', '9999999999', '8888888888', '24ABCDE1234F1Z5', 'active',
               'Plot 12, GIDC', 'Surat', 'Gujarat', 'India', '395003', 'Net 30 terms'])
    dv = DataValidation(type='list', formula1='"active,inactive"', allow_blank=True)
    ws.add_data_validation(dv); dv.add('I2:I1000')
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 16
    bio = io.BytesIO(); wb.save(bio); bio.seek(0)
    from flask import send_file
    return send_file(bio, as_attachment=True, download_name='clients_import_template.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
