"""
modules/npd/npd_routes.py
────────────────────────────────────────────────────────────────────────────
NPD / EPD PROJECTS  (CRM lead -> NPD project flow)
OLD-SYSTEM-COMPATIBLE SCHEMA — tables/columns old HCP-ERP (models/npd.py)
jaise hi hain taaki old data seedha migrate ho jaye:
    npd_projects, milestone_masters (per-project), milestone_logs,
    npd_milestone_templates (admin master), npd_statuses, npd_activity_logs

  • CRM ka `lead_create_npd` gate yahan redirect karta hai:
        url_for('npd.create', lead_id=..., client_id=...)
  • project_type: 'npd' / 'existing'  (existing = EPD)
  • code: NPD-0001 (old gen_npd_code jaisa — last id + 1)
  • Visibility: NPD Manager / Management / Administrator dept + admin /
    manager role = sab; baaki = created_by / assigned_sc / assigned_rd /
    npd_poc / assigned_members me ho to.

Routes:
    GET  /npd                      -> projects list (?status, ?type, ?q)
    GET  /npd/new                  -> create form (lead_id/client_id prefill)
    POST /npd/new                  -> create + template milestones copy + logs
    GET  /npd/<id>                 -> project view (milestones + activity)
    POST /npd/<id>/status          -> project status update
    POST /npd/<id>/milestone/<mid> -> milestone status update (+ milestone_logs)
"""

from flask import (Blueprint, render_template, request, redirect, url_for,
                   session, flash)

from crm.crm_leads_routes import (_db, _is_admin, _has_full_visibility,
                                  _role, _uid, _uname, _user_map,
                                  login_required)

try:
    from menus import get_menu
except Exception:
    def get_menu(*a, **k):
        return None

from models.npd import (MS_STATUSES, PRIORITIES, ensure_npd_tables,  # noqa: F401
                        get_npd_statuses)

npd_bp = Blueprint('npd', __name__, url_prefix='/npd')


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────
@npd_bp.before_request
def _npd_login():
    if not session.get('logged_in'):
        return redirect(url_for('login'))
    return None


def _proj_visibility_sql(alias='p'):
    """Project-level visibility (old system ke assignment columns pe)."""
    if _has_full_visibility():
        return "", []
    u = _uid()
    return (f" AND ({alias}.created_by = %s OR {alias}.assigned_sc = %s "
            f"OR {alias}.assigned_rd = %s OR {alias}.npd_poc = %s "
            f"OR FIND_IN_SET(%s, COALESCE({alias}.assigned_members,'')) "
            f"OR FIND_IN_SET(%s, COALESCE({alias}.assigned_rd_members,'')))",
            [u, u, u, u, str(u), str(u)])


def _log(conn, pid, action):
    conn.execute(
        "INSERT INTO `npd_activity_logs` (project_id, user_id, action) "
        "VALUES (%s,%s,%s)", (pid, _uid(), action))


def _render(tpl, **kw):
    kw.setdefault('sidebar_menu',
                  get_menu('npd', role=_role(), is_admin=_is_admin()))
    kw.setdefault('user_name', _uname())
    kw.setdefault('role', session.get('User_Type'))
    kw.setdefault('ms_statuses', MS_STATUSES)
    return render_template(tpl, **kw)


# ─────────────────────────────────────────────────────────────────────────────
# LIST
# ─────────────────────────────────────────────────────────────────────────────
SORT_COLS = {
    'created':  'p.created_at',
    'code':     'p.code',
    'category': 'p.product_category',
    'client':   'COALESCE(p.client_name, p.client_company)',
    'product':  'p.product_name',
    'brand':    'p.reference_brand',
    'priority': "FIELD(p.priority,'Urgent','High','Normal','Low')",
    'last_connected': 'p.last_connected',
    'tat':      'p.created_at',
    'status':   'p.status',
    'start':    'p.project_start_date',
}


def _list_filters():
    """Listing ke saare query-params -> (where, params, state-dict)."""
    show_deleted = request.args.get('show') == 'deleted'
    st = request.args.get('status', '')
    pt = request.args.get('type', '')
    pr = request.args.get('priority', '')
    cat = (request.args.get('category') or '').strip()
    q = (request.args.get('q') or '').strip()
    sort = request.args.get('sort', 'created')
    if sort not in SORT_COLS:
        sort = 'created'
    sdir = 'asc' if request.args.get('dir') == 'asc' else 'desc'

    vis_frag, vis_params = _proj_visibility_sql('p')
    where = ("p.is_deleted=%s" + vis_frag)
    params = [1 if show_deleted else 0] + list(vis_params)
    if st:
        where += " AND p.status=%s"; params.append(st)
    if pt in ('npd', 'existing'):
        where += " AND p.project_type=%s"; params.append(pt)
    if pr in PRIORITIES:
        where += " AND p.priority=%s"; params.append(pr)
    if cat:
        where += " AND p.product_category=%s"; params.append(cat)
    if q:
        where += (" AND (p.code LIKE %s OR p.product_name LIKE %s "
                  "OR p.client_name LIKE %s OR p.client_company LIKE %s "
                  "OR p.reference_brand LIKE %s OR c.company_name LIKE %s)")
        params += [f"%{q}%"] * 6
    state = dict(show_deleted=show_deleted, cur_status=st, cur_type=pt,
                 cur_priority=pr, cur_category=cat, q=q,
                 sort=sort, sdir=sdir)
    return where, params, state


_LIST_SQL = (
    "SELECT p.*, "
    "c.company_name AS cm_company, "
    "DATEDIFF(NOW(), p.created_at) AS tat_days, "
    "(SELECT COUNT(*) FROM `milestone_masters` m "
    " WHERE m.project_id=p.id AND m.is_selected=1) AS ms_total, "
    "(SELECT COUNT(*) FROM `milestone_masters` m "
    " WHERE m.project_id=p.id AND m.is_selected=1 "
    " AND m.status='approved') AS ms_done "
    "FROM `npd_projects` p "
    "LEFT JOIN `client_masters` c ON c.id = p.client_id ")


def _members_count(r):
    ids = set()
    for k in ('assigned_sc', 'assigned_rd', 'npd_poc'):
        if r.get(k):
            ids.add(str(r[k]))
    for k in ('assigned_members', 'assigned_rd_members'):
        for x in (r.get(k) or '').split(','):
            if x.strip():
                ids.add(x.strip())
    return len(ids)


# Listing columns — npd_projects ke SAARE DB fields (Columns dropdown me
# show/hide). default=True wale shuru se dikhte hain (old listing jaisa).
COLUMN_DEFS = [
    # (key, label, default_visible)
    ('created',          'Create Date',        True),
    ('code',             'Project No',         True),
    ('project_type',     'Type',               False),
    ('category',         'Category',           True),
    ('client',           'Client Name',        True),
    ('client_company',   'Client Company',     False),
    ('client_email',     'Client Email',       False),
    ('client_phone',     'Client Phone',       False),
    ('client_coordinator','Client Coordinator',False),
    ('product',          'Product Name',       True),
    ('product_range',    'Product Range',      False),
    ('members',          'Members',            True),
    ('brand',            'Reference Brand',    True),
    ('reference_product_name', 'Reference Product', False),
    ('variant_type',     'Variant / Type',     False),
    ('area_of_application','Area of Application', False),
    ('market_level',     'Market Level',       False),
    ('appearance',       'Appearance',         False),
    ('fragrance',        'Fragrance',          False),
    ('viscosity',        'Viscosity',          False),
    ('ph_value',         'pH Value',           False),
    ('packaging_type',   'Packaging Type',     False),
    ('product_size',     'Product Size',       False),
    ('no_of_samples',    'No. of Samples',     False),
    ('moq',              'MOQ',                False),
    ('order_quantity',   'Order Quantity',     False),
    ('costing_range',    'Costing Range',      False),
    ('requirement_spec', 'Requirement Spec',   False),
    ('description',      'Description',        False),
    ('ingredients',      'Ingredients',        False),
    ('active_ingredients','Active Ingredients',False),
    ('product_claim',    'Product Claim',      False),
    ('label_claim',      'Label Claim',        False),
    ('video_link',       'Video Link',         False),
    ('priority',         'Priority',           True),
    ('npd_fee',          'NPD Fee',            False),
    ('custom_formulation','Custom Formulation',False),
    ('assigned_sc_nm',   'Sales Coordinator',  False),
    ('assigned_rd_nm',   'R&D Person',         False),
    ('npd_poc_nm',       'NPD POC',            False),
    ('last_connected',   'Last Connected',     True),
    ('milestones',       'Milestones',         True),
    ('tat',              'TAT',                True),
    ('status',           'Status',             True),
    ('start',            'Start Date',         True),
    ('project_lead_days','Lead Days',          False),
    ('project_end_date', 'End Date',           False),
    ('target_sample_date','Target Sample Date',False),
    ('delay_reason',     'Delay Reason',       False),
    ('created_by_nm',    'Created By',         False),
    ('updated',          'Updated At',         False),
]


@npd_bp.route('/')
@login_required
def projects():
    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        statuses = get_npd_statuses(conn)
        where, params, state = _list_filters()
        order = f"ORDER BY {SORT_COLS[state['sort']]} {state['sdir'].upper()}, p.id DESC"
        rows = conn.execute(
            f"{_LIST_SQL} WHERE {where} {order} LIMIT 500",
            params).fetchall() or []
        for r in rows:
            r['members'] = _members_count(r)

        umap = _user_map(conn)
        vis_frag, vis_params = _proj_visibility_sql('p')
        deleted_count = (conn.execute(
            "SELECT COUNT(*) AS c FROM `npd_projects` p "
            "WHERE p.is_deleted=1" + vis_frag, vis_params)
            .fetchone() or {}).get('c', 0)
        cats = [r['name'] for r in (conn.execute(
            "SELECT name FROM `lead_categories` WHERE is_active=1 "
            "ORDER BY sort_order, name").fetchall() or [])]

        return _render('npd/projects.html', rows=rows, umap=umap,
                       statuses=statuses, cats=cats,
                       deleted_count=deleted_count, coldefs=COLUMN_DEFS,
                       sortable=list(SORT_COLS.keys()),
                       priorities=PRIORITIES, market_levels=MARKET_LEVELS,
                       active_item='npd-list', **state)
    finally:
        conn.close()


# ── EXPORT (current filters ke saath xlsx) ───────────────────────────────────
@npd_bp.route('/export')
@login_required
def export_projects():
    conn = _db()
    try:
        where, params, state = _list_filters()
        order = f"ORDER BY {SORT_COLS[state['sort']]} {state['sdir'].upper()}, p.id DESC"
        rows = conn.execute(f"{_LIST_SQL} WHERE {where} {order}",
                            params).fetchall() or []
        smap = {s['slug']: s['name'] for s in get_npd_statuses(conn)}
    finally:
        conn.close()

    import io
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    wb = Workbook(); ws = wb.active; ws.title = "NPD Projects"
    headers = ['Create Date', 'Project No', 'Type', 'Category', 'Client Name',
               'Client Company', 'Client Email', 'Client Phone',
               'Client Coordinator', 'Product Name', 'Members',
               'Reference Brand', 'Reference Product', 'Variant/Type',
               'Area of Application', 'Market Level', 'Appearance',
               'Product Claim', 'Label Claim', 'Costing Range',
               'Odour/Fragrance', 'pH', 'No of Samples', 'MOQ',
               'Product Size', 'Viscosity', 'Packaging Option',
               'Order Quantity', 'Requirement Spec', 'Active Ingredients',
               'Ingredients', 'Video Link', 'NPD Fee Paid', 'Fee Amount',
               'Priority', 'Last Connected', 'Milestones', 'TAT (days)',
               'Status', 'Start Date', 'Lead Days', 'End Date']
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='7C3AED')
    for r in rows:
        ws.append([
            str(r['created_at'] or '')[:10], r['code'] or '',
            'NPD' if r['project_type'] == 'npd' else 'EPD',
            r['product_category'] or '',
            r['client_name'] or '', r['client_company'] or r['cm_company'] or '',
            r['client_email'] or '', r['client_phone'] or '',
            r['client_coordinator'] or '',
            r['product_name'] or '', _members_count(r),
            r['reference_brand'] or '',
            r['reference_product_name'] or r['reference_product'] or '',
            r['variant_type'] or '', r['area_of_application'] or '',
            r['market_level'] or '', r['appearance'] or '',
            r['product_claim'] or '', r['label_claim'] or '',
            r['costing_range'] or '', r['fragrance'] or '',
            r['ph_value'] or '', r['no_of_samples'] or 0, r['moq'] or '',
            r['product_size'] or '', r['viscosity'] or '',
            r['packaging_type'] or '', r['order_quantity'] or '',
            r['requirement_spec'] or '', r['active_ingredients'] or '',
            r['ingredients'] or '', r['video_link'] or '',
            'Yes' if r['npd_fee_paid'] else 'No',
            float(r['npd_fee_amount']) if r['npd_fee_amount'] else '',
            r['priority'] or 'Normal',
            str(r['last_connected'] or '')[:10],
            f"{r['ms_done']}/{r['ms_total']}", r['tat_days'] or 0,
            smap.get(r['status'], (r['status'] or '').replace('_', ' ').title()),
            str(r['project_start_date'] or '')[:10],
            r['project_lead_days'] or '',
            str(r['project_end_date'] or '')[:10]])
    widths = [12, 11, 7, 14, 16, 18, 20, 13, 18, 28, 9, 18, 22, 18, 16, 12,
              20, 24, 24, 16, 18, 10, 11, 9, 11, 18, 22, 13, 30, 24, 26, 22,
              11, 11, 9, 13, 11, 10, 14, 11, 10, 11]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    from flask import send_file
    from datetime import datetime as _dt
    return send_file(buf, as_attachment=True,
                     download_name=f"npd_projects_{_dt.now():%Y%m%d_%H%M}.xlsx",
                     mimetype='application/vnd.openxmlformats-officedocument'
                              '.spreadsheetml.sheet')


# ── IMPORT (dedicated page — CRM jaisa) ──────────────────────────────────────
IMP_ALIAS = {
    'project_type': ['project_type', 'project type', 'type'],
    'product_name': ['product_name', 'product name', 'product'],
    'product_category': ['product_category', 'product category', 'category'],
    'product_range': ['product_range', 'product range'],
    'client_name': ['client_name', 'client name', 'contact name', 'contact_name'],
    'client_company': ['client_company', 'client company', 'company',
                       'company name', 'company_name'],
    'client_email': ['client_email', 'client email', 'email'],
    'client_phone': ['client_phone', 'client phone', 'phone', 'mobile'],
    'reference_brand': ['reference_brand', 'reference brand', 'brand'],
    'priority': ['priority'],
    'order_quantity': ['order_quantity', 'order quantity', 'order qty', 'qty'],
    'moq': ['moq'],
    'product_size': ['product_size', 'product size', 'size'],
    'requirement_spec': ['requirement_spec', 'requirement spec',
                         'requirement', 'requirement specification', 'specs'],
    'description': ['description', 'desc'],
    'client_coordinator': ['client_coordinator', 'client coordinator',
                           'client co-ordinator', 'coordinator'],
    'area_of_application': ['area_of_application', 'area of application',
                            'area'],
    'market_level': ['market_level', 'market level'],
    'variant_type': ['variant_type', 'variant / type', 'variant/type',
                     'variant', 'variety'],
    'appearance': ['appearance'],
    'product_claim': ['product_claim', 'product claim'],
    'label_claim': ['label_claim', 'label claim'],
    'costing_range': ['costing_range', 'costing range', 'costing'],
    'fragrance': ['fragrance', 'odour / fragrance', 'odour/fragrance',
                  'odour', 'flavours'],
    'ph_value': ['ph_value', 'ph'],
    'viscosity': ['viscosity'],
    'packaging_type': ['packaging_type', 'packaging option', 'packaging'],
    'active_ingredients': ['active_ingredients', 'active ingredients',
                           'active ing. req', 'active ing req'],
    'ingredients': ['ingredients'],
    'video_link': ['video_link', 'video link', 'video'],
    'reference_product_name': ['reference_product_name',
                               'reference product name',
                               'reference product'],
    'reference_product': ['reference / existing hcp product',
                          'existing hcp product'],
    'no_of_samples': ['no_of_samples', 'no of samples', 'samples'],
}
# reverse lookup: header -> canonical field
_IMP_LOOKUP = {a: k for k, aliases in IMP_ALIAS.items() for a in aliases}


def _imp_norm(h):
    return str(h or '').strip().lower().replace('*', '').strip()


def _imp_parse(f):
    """Upload file -> (records, detected_headers). Header row auto-detect
    karta hai (pehli row jisme product/product_name jaisa column ho)."""
    raw_rows = []
    if f.filename.lower().endswith('.csv'):
        import csv, io
        txt = f.read().decode('utf-8-sig', errors='replace')
        for row in csv.reader(io.StringIO(txt)):
            raw_rows.append(list(row))
    else:
        from openpyxl import load_workbook
        wb = load_workbook(f, read_only=True, data_only=True)
        ws = wb.active
        for row in ws.iter_rows(values_only=True):
            raw_rows.append(list(row))

    # header row dhundo: jis row me product-name jaisa koi alias ho
    hdr_idx, hdr = None, []
    for i, row in enumerate(raw_rows[:10]):
        cells = [_imp_norm(c) for c in row]
        if any(c in _IMP_LOOKUP and _IMP_LOOKUP[c] == 'product_name'
               for c in cells):
            hdr_idx, hdr = i, cells
            break
    if hdr_idx is None and raw_rows:           # fallback: pehli row
        hdr_idx, hdr = 0, [_imp_norm(c) for c in raw_rows[0]]

    recs = []
    for row in raw_rows[hdr_idx + 1:]:
        if not any(v not in (None, '') for v in row):
            continue
        rec = {}
        for i, v in enumerate(row):
            if i >= len(hdr):
                break
            field = _IMP_LOOKUP.get(hdr[i])
            if field and v is not None and str(v).strip() != '':
                rec[field] = str(v).strip()
        recs.append(rec)
    return recs, hdr


@npd_bp.route('/import', methods=['GET', 'POST'])
@login_required
def import_projects():
    if request.method == 'GET':
        return _render('npd/import_projects.html', active_item='npd-list')

    f = request.files.get('file')
    if not f or not f.filename:
        flash('No file selected (.xlsx or .csv).', 'error')
        return redirect(url_for('npd.import_projects'))
    if not f.filename.lower().endswith(('.xlsx', '.xls', '.csv')):
        flash('Only .xlsx or .csv files are allowed.', 'error')
        return redirect(url_for('npd.import_projects'))

    try:
        recs, hdr = _imp_parse(f)
    except Exception as e:
        flash(f'Could not read the file: {e}', 'error')
        return redirect(url_for('npd.import_projects'))

    conn = _db()
    ok = skipped = 0
    try:
        for rec in recs:
            pname = rec.get('product_name')
            if not pname:
                skipped += 1
                continue
            ptype = (rec.get('project_type') or 'npd').lower()
            ptype = 'existing' if ptype in ('existing', 'epd') else 'npd'
            pr = (rec.get('priority') or 'Normal').capitalize()
            extra_cols = ['client_coordinator', 'area_of_application',
                          'market_level', 'variant_type', 'appearance',
                          'product_claim', 'label_claim', 'costing_range',
                          'fragrance', 'ph_value', 'viscosity',
                          'packaging_type', 'active_ingredients',
                          'ingredients', 'video_link',
                          'reference_product_name', 'reference_product',
                          'no_of_samples']
            cur = conn.execute(
                "INSERT INTO `npd_projects` (project_type, status, "
                "product_name, product_category, product_range, client_name,"
                " client_company, client_email, client_phone, "
                "reference_brand, priority, order_quantity, moq, "
                "product_size, requirement_spec, description, assigned_sc, "
                "milestone_master_created, created_by, "
                + ",".join(f"`{c}`" for c in extra_cols) + ") "
                "VALUES (%s,'not_started',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
                "%s,%s,%s,%s,%s,1,%s,"
                + ",".join(["%s"] * len(extra_cols)) + ")",
                [ptype, pname, rec.get('product_category'),
                 rec.get('product_range'), rec.get('client_name'),
                 rec.get('client_company'), rec.get('client_email'),
                 rec.get('client_phone'), rec.get('reference_brand'),
                 pr if pr in PRIORITIES else 'Normal',
                 rec.get('order_quantity'), rec.get('moq'),
                 rec.get('product_size'), rec.get('requirement_spec'),
                 rec.get('description'), _uid(), _uid()]
                + [(rec.get(c) or 0 if c == 'no_of_samples'
                    else rec.get(c)) for c in extra_cols])
            pid = cur.lastrowid
            conn.execute("UPDATE `npd_projects` SET code=%s WHERE id=%s",
                         ("NPD-%04d" % pid, pid))
            conn.execute(
                "INSERT INTO `milestone_masters` (project_id, milestone_type,"
                " title, description, is_selected, status, sort_order, "
                "created_by) SELECT %s, milestone_type, title, description, "
                "default_selected, 'pending', sort_order, %s "
                "FROM `npd_milestone_templates` WHERE is_active=1 "
                "AND applies_to IN ('both', %s) ORDER BY sort_order",
                (pid, _uid(), ptype))
            _log(conn, pid, "Project imported (NPD-%04d)" % pid)
            ok += 1
        conn.commit()
    except Exception as e:
        flash(f'Import error: {e}', 'error')
        conn.close()
        return redirect(url_for('npd.import_projects'))
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if ok:
        flash(f'Import complete — {ok} project(s) created'
              + (f', {skipped} row(s) skipped (product name missing).'
                 if skipped else '.'), 'success')
        return redirect(url_for('npd.projects'))
    # 0 import -> user ko batao headers kya mile, taaki turant fix kar sake
    known = [h for h in hdr if h in _IMP_LOOKUP]
    flash('0 projects imported. The file must have a "product_name" (or "Product Name"/'
          '"Product") column. Headers found in the file: '
          + (', '.join(h for h in hdr if h) or '(none)')
          + (f' — recognized among them: {", ".join(known)}.' if known
             else ' — none of them were recognized. Please download '
                  'and use the template.'), 'error')
    return redirect(url_for('npd.import_projects'))


@npd_bp.route('/import/template')
@login_required
def import_template():
    import io
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    wb = Workbook(); ws = wb.active; ws.title = 'NPD Projects'
    headers = ['product_name', 'project_type', 'category', 'product_range',
               'client_name', 'client_company', 'client_email',
               'client_phone', 'client_coordinator', 'area_of_application',
               'market_level', 'reference_brand', 'reference_product_name',
               'variant_type', 'appearance', 'product_claim', 'label_claim',
               'costing_range', 'fragrance', 'ph_value', 'viscosity',
               'packaging_type', 'priority', 'order_quantity', 'moq',
               'product_size', 'no_of_samples', 'active_ingredients',
               'ingredients', 'video_link', 'requirement_spec',
               'description']
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='7C3AED')
    ws.append(['Vitamin C Face Wash', 'npd', 'Skin Care', 'Premium',
               'John Doe', 'ABC Corp', 'john@abc.com', '9999999999',
               'Neha Soni', 'Face', 'Premium', 'Foxtale',
               'Foxtale Oil Face Wash', 'Gel based', 'Clear gel',
               'Brightens skin', 'Vitamin C 10%', 'MRP ₹499-699',
               'Citrus', '5.5', 'Medium', 'Fliptop bottle', 'Normal',
               '500 units', '1000', '100ml', 5,
               'Vitamin C, Niacinamide', 'Aqua, Vitamin C, Glycerin',
               'https://example.com/ref', 'Clear gel face wash',
               'Urgent requirement'])
    dv_t = DataValidation(type='list', formula1='"npd,epd"', allow_blank=True)
    dv_p = DataValidation(type='list', formula1='"Urgent,High,Normal,Low"',
                          allow_blank=True)
    ws.add_data_validation(dv_t); ws.add_data_validation(dv_p)
    dv_t.add('B2:B1000'); dv_p.add('W2:W1000')
    for i in range(1, len(headers) + 1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = \
            max(13, min(26, len(headers[i - 1]) + 4))
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    from flask import send_file
    return send_file(buf, as_attachment=True,
                     download_name='npd_import_template.xlsx',
                     mimetype='application/vnd.openxmlformats-officedocument'
                              '.spreadsheetml.sheet')


# ── FORM FIELDS (old NPD form ke saare fields) ──────────────────────────────
MARKET_LEVELS = ['Premium', 'Masstige', 'Mass', 'Luxury', 'Economy']

# text/select fields jo seedha column me jaate hain
FORM_FIELDS = ['client_id', 'client_name', 'client_company', 'client_email',
               'client_phone', 'client_coordinator', 'product_name',
               'product_category', 'area_of_application',
               'market_level', 'priority', 'status', 'description',
               'ingredients', 'video_link', 'active_ingredients',
               'reference_brand', 'reference_product_name', 'variant_type',
               'appearance', 'product_claim', 'label_claim', 'costing_range',
               'fragrance', 'ph_value', 'no_of_samples', 'moq',
               'product_size', 'viscosity', 'packaging_type',
               'order_quantity', 'requirement_spec', 'reference_product',
               'project_start_date', 'project_lead_days', 'project_end_date']


def _save_receipt(files):
    """npd_fee_receipt file -> static/uploads/npd me save, filename return."""
    f = files.get('npd_fee_receipt')
    if not f or not f.filename:
        return None
    import os
    from datetime import datetime as _dt
    from werkzeug.utils import secure_filename
    fn = f"receipt_{_dt.now():%Y%m%d%H%M%S}_{secure_filename(f.filename)}"
    f.save(os.path.join(_npd_upload_dir(), fn))
    return fn


def _form_values(f, conn):
    """POST form -> {column: value} dict (old form ke saare fields)."""
    vals = {}
    for k in FORM_FIELDS:
        v = (f.get(k) or '').strip()
        if k == 'priority':
            v = v if v in PRIORITIES else 'Normal'
        elif k == 'status':
            slugs = [s['slug'] for s in get_npd_statuses(conn)]
            v = v if v in slugs else 'not_started'
        elif k in ('no_of_samples', 'project_lead_days'):
            v = v or (0 if k == 'no_of_samples' else None)
        else:
            v = v or None
        vals[k] = v
    # multi-selects -> CSV (old format: comma-sep user ids)
    vals['assigned_members'] = ','.join(f.getlist('assigned_members')) or None
    rd = f.getlist('assigned_rd_members')
    vals['assigned_rd_members'] = ','.join(rd) or None
    vals['assigned_rd'] = int(rd[0]) if rd else None
    # NPD fee
    vals['npd_fee_paid'] = 1 if f.get('npd_fee_paid') else 0
    vals['npd_fee_amount'] = f.get('npd_fee_amount') or 10000
    return vals


def _form_context(conn, **extra):
    """Form (add/edit) render ke liye common data."""
    clients = conn.execute(
        "SELECT id, code, company_name, contact_name, email, mobile "
        "FROM `client_masters` WHERE is_deleted=0 "
        "ORDER BY COALESCE(NULLIF(contact_name,''), company_name)"
    ).fetchall() or []
    users = conn.execute(
        "SELECT id, COALESCE(NULLIF(full_name,''), username) AS nm "
        "FROM `User_Tbl` WHERE COALESCE(is_active,1)=1 "
        "ORDER BY nm").fetchall() or []
    cats = [c['name'] for c in (conn.execute(
        "SELECT name FROM `lead_categories` WHERE is_active=1 "
        "ORDER BY sort_order, name").fetchall() or [])]
    templates = conn.execute(
        "SELECT milestone_type, title, icon, applies_to, default_selected "
        "FROM `npd_milestone_templates` WHERE is_active=1 "
        "ORDER BY sort_order").fetchall() or []
    ctx = dict(clients=clients, users=users, cats=cats,
               ms_templates=templates, statuses=get_npd_statuses(conn),
               priorities=PRIORITIES, market_levels=MARKET_LEVELS)
    ctx.update(extra)
    return ctx


def _sync_milestones(conn, pid, ptype, selected):
    """Selected milestone types ko project ke milestone_masters me sync karo
    (missing template rows insert, is_selected update)."""
    tpls = conn.execute(
        "SELECT milestone_type, title, description, sort_order "
        "FROM `npd_milestone_templates` WHERE is_active=1 "
        "AND applies_to IN ('both', %s) ORDER BY sort_order",
        (ptype,)).fetchall() or []
    existing = {m['milestone_type']: m for m in (conn.execute(
        "SELECT id, milestone_type FROM `milestone_masters` "
        "WHERE project_id=%s", (pid,)).fetchall() or [])}
    for t in tpls:
        sel = 1 if t['milestone_type'] in selected else 0
        if t['milestone_type'] in existing:
            conn.execute(
                "UPDATE `milestone_masters` SET is_selected=%s "
                "WHERE id=%s", (sel, existing[t['milestone_type']]['id']))
        else:
            conn.execute(
                "INSERT INTO `milestone_masters` (project_id, "
                "milestone_type, title, description, is_selected, status, "
                "sort_order, created_by) VALUES (%s,%s,%s,%s,%s,'pending',"
                "%s,%s)", (pid, t['milestone_type'], t['title'],
                           t['description'], sel, t['sort_order'], _uid()))


# ── EDIT ─────────────────────────────────────────────────────────────────────
@npd_bp.route('/<int:pid>/edit', methods=['GET', 'POST'])
@login_required
def edit(pid):
    conn = _db()
    try:
        vis_frag, vis_params = _proj_visibility_sql('p')
        proj = conn.execute(
            "SELECT p.* FROM `npd_projects` p WHERE p.id=%s "
            "AND p.is_deleted=0" + vis_frag,
            [pid] + vis_params).fetchone()
        if not proj:
            flash('Project not found or you do not have access.', 'error')
            return redirect(url_for('npd.projects'))

        if request.method == 'POST':
            f = request.form
            if not (f.get('product_name') or '').strip():
                flash('Product name is required.', 'error')
                return redirect(request.url)
            vals = _form_values(f, conn)
            # fee receipt: nayi file aayi to replace, warna purani rehne do
            rc = _save_receipt(request.files)
            if rc:
                vals['npd_fee_receipt'] = rc
            # fee abhi paid hua to timestamp (old system jaisa)
            if vals['npd_fee_paid'] and not proj.get('npd_fee_paid'):
                vals['npd_fee_paid_at'] = None  # set via NOW() below
            sets = [f"{k}=%s" for k in vals] + ["updated_by=%s"]
            params = list(vals.values()) + [_uid()]
            sql = ("UPDATE `npd_projects` SET " + ", ".join(sets)
                   + (", npd_fee_paid_at=NOW()"
                      if (vals['npd_fee_paid']
                          and not proj.get('npd_fee_paid')) else "")
                   + " WHERE id=%s")
            # vals me None-marker hata do (NOW() handle alag se)
            if 'npd_fee_paid_at' in vals:
                del vals['npd_fee_paid_at']
                sets = [f"{k}=%s" for k in vals] + ["updated_by=%s"]
                params = list(vals.values()) + [_uid()]
                sql = ("UPDATE `npd_projects` SET " + ", ".join(sets)
                       + ", npd_fee_paid_at=NOW() WHERE id=%s")
            conn.execute(sql, params + [pid])
            _sync_milestones(conn, pid, proj['project_type'],
                             set(f.getlist('milestones')))
            _log(conn, pid, f"Project {proj['code']} edited")
            conn.commit()
            flash('Project updated.', 'success')
            return redirect(url_for('npd.view', pid=pid))

        selected_ms = {m['milestone_type'] for m in (conn.execute(
            "SELECT milestone_type FROM `milestone_masters` "
            "WHERE project_id=%s AND is_selected=1", (pid,)).fetchall()
            or [])}
        return _render('npd/project_form.html',
                       **_form_context(conn, v=proj, edit=proj,
                                       lead=None,
                                       sel_client=proj.get('client_id'),
                                       sel_type=proj['project_type'],
                                       selected_ms=selected_ms),
                       active_item='npd-list')
    finally:
        conn.close()


# ── INLINE EDIT (listing se cell-level quick edit — leads jaisa) ─────────────
IE_ALLOWED = {
    'product_name', 'product_category', 'client_name', 'client_company',
    'client_email', 'client_phone', 'client_coordinator', 'reference_brand',
    'reference_product_name', 'variant_type', 'area_of_application',
    'market_level', 'appearance', 'fragrance', 'viscosity', 'ph_value',
    'packaging_type', 'product_size', 'no_of_samples', 'moq',
    'order_quantity', 'costing_range', 'priority', 'status',
    'product_claim', 'label_claim', 'requirement_spec', 'description',
    'video_link', 'delay_reason',
}


@npd_bp.route('/<int:pid>/inline-edit', methods=['POST'])
@login_required
def inline_edit(pid):
    from flask import jsonify
    data = request.get_json(silent=True) or {}
    field = (data.get('field') or '').strip()
    value = data.get('value', '')
    if field not in IE_ALLOWED:
        return jsonify(success=False, error='Field not allowed'), 400
    if isinstance(value, str):
        value = value.strip()
    conn = _db()
    try:
        if field == 'priority' and value not in PRIORITIES:
            return jsonify(success=False, error='Invalid priority'), 400
        if field == 'status':
            if value not in [s['slug'] for s in get_npd_statuses(conn)]:
                return jsonify(success=False, error='Invalid status'), 400
        if field == 'no_of_samples':
            try:
                value = int(value) if value not in ('', None) else 0
            except Exception:
                return jsonify(success=False, error='Invalid number'), 400
        if value == '':
            value = None

        vis_frag, vis_params = _proj_visibility_sql('p')
        proj = conn.execute(
            "SELECT p.id, p.code FROM `npd_projects` p "
            "WHERE p.id=%s AND p.is_deleted=0" + vis_frag,
            [pid] + vis_params).fetchone()
        if not proj:
            return jsonify(success=False, error='Project not found'), 404

        extra = ""
        if field == 'status':
            extra = (", completed_at=CASE WHEN %s='finish' THEN NOW() "
                     "ELSE completed_at END, "
                     "cancelled_at=CASE WHEN %s='cancelled' THEN NOW() "
                     "ELSE cancelled_at END")
        sql = (f"UPDATE `npd_projects` SET `{field}`=%s, updated_by=%s"
               + extra + " WHERE id=%s")
        params = [value, _uid()] + ([value, value] if extra else []) + [pid]
        conn.execute(sql, params)
        _log(conn, pid, f"Inline edit: {field} updated")
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


# ── DELETE / RESTORE (soft) ──────────────────────────────────────────────────
@npd_bp.route('/<int:pid>/delete', methods=['POST'])
@login_required
def delete(pid):
    conn = _db()
    try:
        vis_frag, vis_params = _proj_visibility_sql('npd_projects')
        cur = conn.execute(
            "UPDATE `npd_projects` SET is_deleted=1, deleted_at=NOW(), "
            "deleted_by=%s WHERE id=%s AND is_deleted=0" + vis_frag,
            [_uid(), pid] + vis_params)
        if cur.rowcount:
            _log(conn, pid, "Project deleted")
            conn.commit()
            flash('Project deleted (you can find it in the Deleted tab).', 'success')
        else:
            flash('You do not have access.', 'error')
    finally:
        conn.close()
    return redirect(url_for('npd.projects'))


@npd_bp.route('/<int:pid>/restore', methods=['POST'])
@login_required
def restore(pid):
    conn = _db()
    try:
        vis_frag, vis_params = _proj_visibility_sql('npd_projects')
        cur = conn.execute(
            "UPDATE `npd_projects` SET is_deleted=0, deleted_at=NULL, "
            "deleted_by=NULL WHERE id=%s AND is_deleted=1" + vis_frag,
            [pid] + vis_params)
        if cur.rowcount:
            _log(conn, pid, "Project restored")
            conn.commit()
            flash('Project restored.', 'success')
        else:
            flash('You do not have access.', 'error')
    finally:
        conn.close()
    return redirect(url_for('npd.projects', show='deleted'))


def _purge_one(conn, pid):
    """Project + saare child records permanently delete (commit caller pe)."""
    conn.execute("DELETE FROM `milestone_logs` WHERE milestone_id IN "
                 "(SELECT id FROM `milestone_masters` WHERE project_id=%s)",
                 (pid,))
    for tbl in ('milestone_masters', 'npd_activity_logs',
                'npd_comments', 'npd_notes', 'client_dispatch'):
        conn.execute(f"DELETE FROM `{tbl}` WHERE project_id=%s", (pid,))
    # dispatch items project_id carry karte hain; tokens batch-level
    # hote hain (kai projects share karte hain) — unhe mat chhedo
    conn.execute("DELETE FROM `office_dispatch_items` WHERE project_id=%s",
                 (pid,))
    conn.execute("DELETE FROM `npd_projects` WHERE id=%s", (pid,))


@npd_bp.route('/<int:pid>/purge', methods=['POST'])
@login_required
def purge(pid):
    """Permanent delete — sirf deleted projects, sirf full-visibility users."""
    if not _has_full_visibility():
        flash('You do not have permission to permanently delete.', 'error')
        return redirect(url_for('npd.projects', show='deleted'))
    conn = _db()
    try:
        proj = conn.execute(
            "SELECT id, code FROM `npd_projects` "
            "WHERE id=%s AND is_deleted=1", (pid,)).fetchone()
        if not proj:
            flash('Project not found in the Deleted tab — delete it first.',
                  'error')
            return redirect(url_for('npd.projects', show='deleted'))
        _purge_one(conn, pid)
        conn.commit()
        flash(f"{proj['code']} permanently deleted.", 'success')
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        flash(f'Permanent delete failed: {e}', 'error')
    finally:
        conn.close()
    return redirect(url_for('npd.projects', show='deleted'))


@npd_bp.route('/bulk-action', methods=['POST'])
@login_required
def bulk_action():
    """Selected projects pe bulk delete / restore / purge (AJAX JSON)."""
    from flask import jsonify
    data = request.get_json(silent=True) or {}
    action = data.get('action')
    try:
        ids = [int(i) for i in (data.get('ids') or [])][:200]
    except Exception:
        ids = []
    if action not in ('delete', 'restore', 'purge') or not ids:
        return jsonify(success=False, error='Invalid request'), 400
    conn = _db()
    try:
        ph = ",".join(["%s"] * len(ids))
        vis_frag, vis_params = _proj_visibility_sql('npd_projects')
        if action == 'delete':
            cur = conn.execute(
                f"UPDATE `npd_projects` SET is_deleted=1, deleted_at=NOW(), "
                f"deleted_by=%s WHERE id IN ({ph}) AND is_deleted=0"
                + vis_frag, [_uid()] + ids + vis_params)
            n = cur.rowcount
        elif action == 'restore':
            cur = conn.execute(
                f"UPDATE `npd_projects` SET is_deleted=0, deleted_at=NULL, "
                f"deleted_by=NULL WHERE id IN ({ph}) AND is_deleted=1"
                + vis_frag, ids + vis_params)
            n = cur.rowcount
        else:  # purge — sirf full-visibility
            if not _has_full_visibility():
                return jsonify(success=False,
                               error='You do not have permission'), 403
            rows = conn.execute(
                f"SELECT id FROM `npd_projects` "
                f"WHERE id IN ({ph}) AND is_deleted=1", ids).fetchall() or []
            for r in rows:
                _purge_one(conn, r['id'])
            n = len(rows)
        conn.commit()
        return jsonify(success=True, count=n)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify(success=False, error=str(e)), 500
    finally:
        conn.close()


# ── NPD FORM (printable / download) ──────────────────────────────────────────
@npd_bp.route('/<int:pid>/form')
@login_required
def form_print(pid):
    conn = _db()
    try:
        vis_frag, vis_params = _proj_visibility_sql('p')
        proj = conn.execute(
            "SELECT p.*, c.company_name AS cm_company, c.code AS cm_code "
            "FROM `npd_projects` p "
            "LEFT JOIN `client_masters` c ON c.id = p.client_id "
            "WHERE p.id=%s" + vis_frag, [pid] + vis_params).fetchone()
        if not proj:
            flash('Project not found or you do not have access.', 'error')
            return redirect(url_for('npd.projects'))
        umap = _user_map(conn)
        return render_template('npd/npd_form_print.html', p=proj, umap=umap)
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# CREATE  (endpoint name 'create' — CRM gate url_for('npd.create') use karta hai)
# ─────────────────────────────────────────────────────────────────────────────
@npd_bp.route('/new', methods=['GET', 'POST'])
@login_required
def create():
    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        if request.method == 'POST':
            f = request.form
            ptype = f.get('project_type') \
                if f.get('project_type') in ('npd', 'existing') else 'npd'
            if not (f.get('product_name') or '').strip():
                flash('Product name is required.', 'error')
                return redirect(request.url)

            vals = _form_values(f, conn)
            vals['project_type'] = ptype
            vals['lead_id'] = f.get('lead_id') or None
            vals['assigned_sc'] = f.get('assigned_sc') or _uid()
            vals['milestone_master_created'] = 1
            vals['created_by'] = _uid()
            rc = _save_receipt(request.files)
            if rc:
                vals['npd_fee_receipt'] = rc

            cols = list(vals.keys())
            sql = ("INSERT INTO `npd_projects` ("
                   + ",".join(f"`{c}`" for c in cols)
                   + (", npd_fee_paid_at" if vals['npd_fee_paid'] else "")
                   + ") VALUES (" + ",".join(["%s"] * len(cols))
                   + (", NOW()" if vals['npd_fee_paid'] else "") + ")")
            cur = conn.execute(sql, list(vals.values()))
            pid = cur.lastrowid

            code = "NPD-%04d" % pid
            conn.execute("UPDATE `npd_projects` SET code=%s WHERE id=%s",
                         (code, pid))

            # milestones: form me jo select kiye wahi follow honge
            selected = set(f.getlist('milestones'))
            if not selected:        # kuch select nahi -> defaults
                selected = {t['milestone_type'] for t in (conn.execute(
                    "SELECT milestone_type FROM `npd_milestone_templates` "
                    "WHERE is_active=1 AND default_selected=1").fetchall()
                    or [])}
            _sync_milestones(conn, pid, ptype, selected)

            _log(conn, pid, f"Project {code} created")
            if f.get('lead_id'):
                try:
                    conn.execute(
                        "INSERT INTO `lead_activity_logs` "
                        "(lead_id, user_id, action) VALUES (%s,%s,%s)",
                        (f.get('lead_id'), _uid(),
                         f"{'NPD' if ptype == 'npd' else 'EPD'} Project "
                         f"{code} created"))
                except Exception:
                    pass
            conn.commit()
            flash(f'Project {code} created.', 'success')
            return redirect(url_for('npd.view', pid=pid))

        # ── GET: prefill from lead/client ────────────────────────────────
        lead = None
        lead_id = request.args.get('lead_id')
        client_id = request.args.get('client_id')
        if lead_id:
            lead = conn.execute(
                "SELECT id, contact_name, company_name, email, "
                "phone AS mobile, client_id, category, product_range, "
                "requirement_spec, product_name, "
                "order_quantity AS order_qty "
                "FROM `leads` WHERE id=%s AND is_deleted=0",
                (lead_id,)).fetchone()
            if lead and not client_id:
                client_id = lead.get('client_id')

        # lead -> form prefill dict (v)
        v = {}
        if lead:
            # NOTE: client_name/company prefill NAHI — client dropdown se
            # select hoga, company auto-fill hogi (warna validation bypass
            # ho jaata tha aur company me lead ki default value aati thi)
            v = {'client_email': lead.get('email'),
                 'client_phone': lead.get('mobile'),
                 'product_name': lead.get('product_name'),
                 'product_category': lead.get('category'),
                 'product_range': lead.get('product_range'),
                 'requirement_spec': lead.get('requirement_spec'),
                 'order_quantity': lead.get('order_qty')}

        # Client CO-Ordinator default = jo login hai (sirf naye form pe)
        if not v.get('client_coordinator'):
            try:
                u = conn.execute(
                    "SELECT COALESCE(NULLIF(full_name,''), username) AS nm "
                    "FROM `User_Tbl` WHERE id=%s", (_uid(),)).fetchone()
                v['client_coordinator'] = (u or {}).get('nm') or _uname()
            except Exception:
                v['client_coordinator'] = _uname()

        sel_type = request.args.get('type') \
            if request.args.get('type') in ('npd', 'existing') else 'npd'
        return _render('npd/project_form.html',
                       **_form_context(conn, v=v, edit=None, lead=lead,
                                       sel_client=int(client_id)
                                       if client_id else None,
                                       sel_type=sel_type, selected_ms=None),
                       active_item='npd-new')
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# VIEW
# ─────────────────────────────────────────────────────────────────────────────
@npd_bp.route('/<int:pid>')
@login_required
def view(pid):
    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        vis_frag, vis_params = _proj_visibility_sql('p')
        proj = conn.execute(
            "SELECT p.*, c.company_name AS cm_company, "
            "c.code AS cm_code, l.contact_name AS lead_contact, "
            "l.company_name AS lead_company "
            "FROM `npd_projects` p "
            "LEFT JOIN `client_masters` c ON c.id = p.client_id "
            "LEFT JOIN `leads` l ON l.id = p.lead_id "
            "WHERE p.id=%s AND p.is_deleted=0" + vis_frag,
            [pid] + vis_params).fetchone()
        if not proj:
            flash('Project not found or you do not have access.', 'error')
            return redirect(url_for('npd.projects'))

        miles = conn.execute(
            "SELECT * FROM `milestone_masters` "
            "WHERE project_id=%s AND is_selected=1 "
            "ORDER BY sort_order, id", (pid,)).fetchall() or []
        acts = conn.execute(
            "SELECT * FROM `npd_activity_logs` WHERE project_id=%s "
            "ORDER BY created_at DESC LIMIT 50", (pid,)).fetchall() or []
        comments = conn.execute(
            "SELECT * FROM `npd_comments` WHERE project_id=%s "
            "AND is_internal=0 ORDER BY created_at DESC", (pid,)).fetchall() or []
        internal = conn.execute(
            "SELECT * FROM `npd_comments` WHERE project_id=%s "
            "AND is_internal=1 ORDER BY created_at DESC", (pid,)).fetchall() or []
        note = conn.execute(
            "SELECT * FROM `npd_notes` WHERE project_id=%s",
            (pid,)).fetchone() or {}
        # Attachments: comment files + milestone attachments (comma names)
        attachments = [{'name': c['attachment'], 'src': 'Discussion'
                        if not c['is_internal'] else 'Internal',
                        'when': c['created_at'], 'by': c['user_id']}
                       for c in (comments + internal) if c.get('attachment')]
        for m in miles:
            for fn in (m.get('attachments') or '').split(','):
                if fn.strip():
                    attachments.append({'name': fn.strip(),
                                        'src': f"Milestone: {m['title']}",
                                        'when': m.get('updated_at'),
                                        'by': m.get('created_by')})
        umap = _user_map(conn)
        done = sum(1 for m in miles if m['status'] == 'approved')
        pct = round(done / len(miles) * 100) if miles else 0

        # Duration + START permission
        from datetime import datetime as _dt
        def _pdt(v):
            try:
                return _dt.strptime(str(v)[:19], '%Y-%m-%d %H:%M:%S')
            except Exception:
                return None
        st_at, fin_at = _pdt(proj.get('started_at')), _pdt(proj.get('finished_at'))
        if st_at:
            dur_days = ((fin_at or _dt.now()) - st_at).days
        else:
            dur_days = 0
        can_start = (_has_full_visibility() or _uid() in
                     (proj.get('assigned_rd'), proj.get('assigned_sc'),
                      proj.get('npd_poc'), proj.get('created_by')))

        return _render('npd/project_view.html', p=proj, miles=miles,
                       acts=acts, comments=comments, internal=internal,
                       note=note, attachments=attachments,
                       dur_days=dur_days, can_start=can_start,
                       started=bool(st_at), finished=bool(fin_at),
                       umap=umap, pct=pct,
                       statuses=get_npd_statuses(conn), active_item='npd-list')
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# DISCUSSION / NOTE / TIMER
# ─────────────────────────────────────────────────────────────────────────────
def _npd_upload_dir():
    import os
    from flask import current_app
    d = os.path.join(current_app.root_path, 'static', 'uploads', 'npd')
    os.makedirs(d, exist_ok=True)
    return d


@npd_bp.route('/<int:pid>/comment', methods=['POST'])
@login_required
def add_comment(pid):
    import os
    from datetime import datetime as _dt
    from werkzeug.utils import secure_filename
    is_internal = request.form.get('is_internal', '0') == '1'
    comment = (request.form.get('comment') or '').strip()
    f = request.files.get('file')
    if not comment and not (f and f.filename):
        flash('A comment or file is required.', 'error')
        return redirect(url_for('npd.view', pid=pid)
                        + ('#internal' if is_internal else '#discussion'))
    stored = None
    if f and f.filename:
        fname = secure_filename(f.filename)
        stored = f"{pid}_{_dt.now():%Y%m%d%H%M%S}_{fname}"
        f.save(os.path.join(_npd_upload_dir(), stored))
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO `npd_comments` (project_id, user_id, comment, "
            "is_internal, attachment) VALUES (%s,%s,%s,%s,%s)",
            (pid, _uid(), comment or '(file)', 1 if is_internal else 0,
             stored))
        _log(conn, pid, ('Internal comment' if is_internal else 'Comment')
             + ' added')
        conn.commit()
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid)
                    + ('#internal' if is_internal else '#discussion'))


@npd_bp.route('/<int:pid>/note', methods=['POST'])
@login_required
def save_note(pid):
    content = request.form.get('content') or ''
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO `npd_notes` (project_id, content, updated_by) "
            "VALUES (%s,%s,%s) ON DUPLICATE KEY UPDATE content=VALUES(content),"
            " updated_by=VALUES(updated_by)", (pid, content, _uid()))
        _log(conn, pid, 'Note updated')
        conn.commit()
        flash('Note saved.', 'success')
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid) + '#note')


@npd_bp.route('/<int:pid>/start', methods=['POST'])
@login_required
def start_project(pid):
    conn = _db()
    try:
        proj = conn.execute(
            "SELECT assigned_rd, assigned_sc, npd_poc, created_by, started_at "
            "FROM `npd_projects` WHERE id=%s AND is_deleted=0",
            (pid,)).fetchone()
        if not proj:
            flash('Project not found.', 'error')
            return redirect(url_for('npd.projects'))
        if not (_has_full_visibility() or _uid() in
                (proj['assigned_rd'], proj['assigned_sc'],
                 proj['npd_poc'], proj['created_by'])):
            flash('This project is not assigned to you.', 'error')
            return redirect(url_for('npd.view', pid=pid))
        if not proj['started_at']:
            conn.execute(
                "UPDATE `npd_projects` SET started_at=NOW(), "
                "status=CASE WHEN status='not_started' "
                "THEN 'sample_inprocess' ELSE status END WHERE id=%s", (pid,))
            _log(conn, pid, 'Project STARTED')
            conn.commit()
            flash('Project started.', 'success')
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid))


@npd_bp.route('/<int:pid>/finish', methods=['POST'])
@login_required
def finish_project(pid):
    conn = _db()
    try:
        cur = conn.execute(
            "UPDATE `npd_projects` SET finished_at=NOW(), "
            "total_duration_seconds=TIMESTAMPDIFF(SECOND, started_at, NOW()) "
            "WHERE id=%s AND started_at IS NOT NULL "
            "AND finished_at IS NULL", (pid,))
        if cur.rowcount:
            _log(conn, pid, 'Project FINISHED')
            conn.commit()
            flash('Project marked as finished.', 'success')
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid))


# ─────────────────────────────────────────────────────────────────────────────
# STATUS UPDATES
# ─────────────────────────────────────────────────────────────────────────────
@npd_bp.route('/<int:pid>/status', methods=['POST'])
@login_required
def set_status(pid):
    st = request.form.get('status')
    conn = _db()
    try:
        if st not in [s['slug'] for s in get_npd_statuses(conn)]:
            flash('Invalid status.', 'error')
            return redirect(url_for('npd.view', pid=pid))
        vis_frag, vis_params = _proj_visibility_sql('npd_projects')
        cur = conn.execute(
            "UPDATE `npd_projects` SET status=%s, updated_by=%s, "
            "completed_at=CASE WHEN %s='finish' THEN NOW() "
            "             ELSE completed_at END, "
            "cancelled_at=CASE WHEN %s='cancelled' THEN NOW() "
            "             ELSE cancelled_at END "
            "WHERE id=%s AND is_deleted=0" + vis_frag,
            [st, _uid(), st, st, pid] + vis_params)
        if cur.rowcount:
            _log(conn, pid, f"Status changed to {st}")
            conn.commit()
            flash('Status updated.', 'success')
        else:
            flash('You do not have access.', 'error')
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid))


@npd_bp.route('/<int:pid>/milestone/<int:mid>', methods=['POST'])
@login_required
def set_milestone(pid, mid):
    st = request.form.get('status')
    if st not in [s[0] for s in MS_STATUSES]:
        flash('Invalid milestone status.', 'error')
        return redirect(url_for('npd.view', pid=pid))
    conn = _db()
    try:
        vis_frag, vis_params = _proj_visibility_sql('p')
        ok = conn.execute(
            "SELECT p.id FROM `npd_projects` p "
            "WHERE p.id=%s AND p.is_deleted=0" + vis_frag,
            [pid] + vis_params).fetchone()
        if not ok:
            flash('You do not have access.', 'error')
            return redirect(url_for('npd.projects'))

        row = conn.execute(
            "SELECT title, status FROM `milestone_masters` "
            "WHERE id=%s AND project_id=%s", (mid, pid)).fetchone()
        if row:
            conn.execute(
                "UPDATE `milestone_masters` SET status=%s, "
                "completed_at=CASE WHEN %s='approved' THEN NOW() "
                "             ELSE completed_at END, "
                "approved_by=CASE WHEN %s='approved' THEN %s "
                "             ELSE approved_by END, "
                "approved_at=CASE WHEN %s='approved' THEN NOW() "
                "             ELSE approved_at END "
                "WHERE id=%s AND project_id=%s",
                (st, st, st, _uid(), st, mid, pid))
            # old system jaisa milestone_logs entry
            conn.execute(
                "INSERT INTO `milestone_logs` "
                "(milestone_id, action, old_status, new_status, created_by) "
                "VALUES (%s,%s,%s,%s,%s)",
                (mid, f"Status: {row['status']} -> {st}",
                 row['status'], st, _uid()))
            _log(conn, pid, f"Milestone '{row['title']}' -> {st}")
            conn.commit()
            flash('Milestone updated.', 'success')
    finally:
        conn.close()
    return redirect(url_for('npd.view', pid=pid))


# ─────────────────────────────────────────────────────────────────────────────
# NPD DASHBOARD  (old /npd/npd-dashboard jaisa — samples / dispatch / lifecycle)
# ─────────────────────────────────────────────────────────────────────────────
PERIODS = {'all': 'All Time', 'today': 'Today', 'yesterday': 'Yesterday',
           'last_7_days': 'Last 7 Days', 'last_30_days': 'Last 30 Days'}
_PAL = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
        '#06b6d4', '#ec4899', '#64748b']


@npd_bp.route('/dashboard')
@login_required
def dashboard():
    from datetime import datetime as _dt, timedelta

    period = (request.args.get('period') or 'all').lower()
    if period not in PERIODS:
        period = 'all'
    now = _dt.now()
    pf = pt = None
    if period == 'today':
        pf = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == 'yesterday':
        y = now - timedelta(days=1)
        pf = y.replace(hour=0, minute=0, second=0, microsecond=0)
        pt = y.replace(hour=23, minute=59, second=59)
    elif period == 'last_7_days':
        pf = now - timedelta(days=7)
    elif period == 'last_30_days':
        pf = now - timedelta(days=30)

    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        vis_frag, vis_params = _proj_visibility_sql('p')

        def _between(col):
            frag, prm = "", []
            if pf is not None:
                frag += f" AND {col} >= %s"; prm.append(pf)
            if pt is not None:
                frag += f" AND {col} <= %s"; prm.append(pt)
            return frag, prm

        proj_rng, proj_prm = _between('p.created_at')
        samp_rng, samp_prm = _between('t.dispatched_at')

        P_BASE = ("FROM `npd_projects` p WHERE p.is_deleted=0 "
                  "AND p.project_type='npd'" + vis_frag + proj_rng)
        P_PRM = vis_params + proj_prm

        def _scalar(sql, prm):
            r = conn.execute(sql, prm).fetchone()
            return (list(r.values())[0] if r else 0) or 0

        a = {}
        # ── Project KPIs ─────────────────────────────────────────────────
        total_proj = _scalar(f"SELECT COUNT(*) {P_BASE}", P_PRM)
        a['leads_converted'] = _scalar(
            f"SELECT COUNT(*) {P_BASE} AND p.lead_id IS NOT NULL", P_PRM)
        a['active_projects'] = _scalar(
            f"SELECT COUNT(*) {P_BASE} "
            f"AND p.status NOT IN ('finish','complete','completed','cancelled')", P_PRM)
        a['new_this_month'] = _scalar(
            "SELECT COUNT(*) FROM `npd_projects` p WHERE p.is_deleted=0 "
            "AND p.project_type='npd'" + vis_frag + " AND p.created_at >= %s",
            vis_params + [now.replace(day=1, hour=0, minute=0, second=0,
                                      microsecond=0)])
        a['completed_projects'] = _scalar(
            f"SELECT COUNT(*) {P_BASE} AND p.status='finish'", P_PRM)

        # ── Sample KPIs (office_dispatch_items + tokens) ─────────────────
        S_BASE = ("FROM `office_dispatch_items` i "
                  "JOIN `office_dispatch_tokens` t ON t.id = i.token_id "
                  "JOIN `npd_projects` p ON p.id = i.project_id "
                  "WHERE p.is_deleted=0 AND p.project_type='npd'"
                  + vis_frag + samp_rng)
        S_PRM = vis_params + samp_prm

        def _scount(extra="", prm=None):
            try:
                return _scalar(f"SELECT COUNT(*) {S_BASE}{extra}",
                               S_PRM + (prm or []))
            except Exception:
                return 0

        s_total = _scount()
        s_pending = _scount(" AND i.approval_status='pending'")
        s_approved = _scount(" AND i.approval_status='approved'")
        s_rejected = _scount(" AND i.approval_status='rejected'")
        s_sent = _scount(" AND i.sent_to_client_at IS NOT NULL")
        a.update(total_samples=s_total, in_development=s_pending,
                 internal_approved=s_approved, samples_dispatched=s_sent,
                 internal_rejected=s_rejected,
                 # client-side metrics: old system me bhi data field nahi tha
                 client_approved=0, client_rejected=0, rework_samples=0,
                 pending_feedback=0, in_transit=0, delivered=0,
                 overdue=0, on_time=0)

        # ── Dispatches + avg cycle ───────────────────────────────────────
        cd_rng, cd_prm = _between('d.dispatched_at')
        try:
            a['total_dispatches'] = _scalar(
                "SELECT COUNT(*) FROM `client_dispatch` d "
                "JOIN `npd_projects` p ON p.id = d.project_id "
                "WHERE 1=1" + vis_frag + cd_rng, vis_params + cd_prm)
        except Exception:
            a['total_dispatches'] = 0
        try:
            a['avg_cycle'] = float(_scalar(
                f"SELECT ROUND(AVG(DATEDIFF(i.actioned_at, t.dispatched_at)),1) "
                f"{S_BASE} AND i.actioned_at IS NOT NULL "
                f"AND i.actioned_at >= t.dispatched_at", S_PRM) or 0)
        except Exception:
            a['avg_cycle'] = 0

        # ── Lifecycle funnel ─────────────────────────────────────────────
        a['funnel'] = [
            {'label': 'Leads Converted', 'value': a['leads_converted'], 'color': '#8b5cf6'},
            {'label': 'NPD Projects Created', 'value': total_proj, 'color': '#6366f1'},
            {'label': 'Samples Created', 'value': s_total, 'color': '#3b82f6'},
            {'label': 'Internal Approved', 'value': s_approved, 'color': '#06b6d4'},
            {'label': 'Client Sent', 'value': s_sent, 'color': '#10b981'},
            {'label': 'Client Approved', 'value': a['client_approved'], 'color': '#f59e0b'},
            {'label': 'Projects Completed', 'value': a['completed_projects'], 'color': '#ef4444'},
        ]

        a['sample_status'] = [x for x in [
            {'label': 'In Development', 'value': s_pending, 'color': '#3b82f6'},
            {'label': 'Internal Approval', 'value': s_approved, 'color': '#06b6d4'},
            {'label': 'Client Sent', 'value': s_sent, 'color': '#10b981'},
            {'label': 'Client Rejected', 'value': s_rejected, 'color': '#ef4444'},
        ] if x['value']]

        # ── Project stage overview ───────────────────────────────────────
        a['project_stage'] = []
        try:
            smap = {s['slug']: s['name'] for s in get_npd_statuses(conn)}
            rows = conn.execute(
                f"SELECT p.status AS s, COUNT(*) AS c {P_BASE} "
                f"GROUP BY p.status ORDER BY c DESC", P_PRM).fetchall() or []
            st = [{'label': smap.get(r['s'],
                                     (r['s'] or 'Unknown').replace('_', ' ').title()),
                   'value': r['c']} for r in rows]
            for i, x in enumerate(st):
                x['color'] = _PAL[i % len(_PAL)]
            a['project_stage'] = st[:8]
        except Exception:
            pass

        a['client_trend'] = []      # client approval data nahi hai abhi

        # ── Rejection analysis (internal) ────────────────────────────────
        a['rejection_internal'] = []
        try:
            rr = conn.execute(
                f"SELECT COALESCE(NULLIF(TRIM(i.reject_reason),''),"
                f"'Not specified') AS r, COUNT(*) AS c {S_BASE} "
                f"AND i.approval_status='rejected' GROUP BY r "
                f"ORDER BY c DESC LIMIT 6", S_PRM).fetchall() or []
            a['rejection_internal'] = [
                {'label': r['r'], 'value': r['c'],
                 'color': _PAL[i % len(_PAL)]} for i, r in enumerate(rr)]
        except Exception:
            pass
        a['rejection_client'] = []
        a['top_rework'] = []
        a['pending_feedback_rows'] = []

        # ── Recent dispatches ────────────────────────────────────────────
        a['recent_dispatches'] = []
        try:
            for d in (conn.execute(
                    "SELECT d.token_no, d.dispatched_at, p.code, "
                    "p.client_name, p.client_company "
                    "FROM `client_dispatch` d "
                    "JOIN `npd_projects` p ON p.id = d.project_id "
                    "WHERE 1=1" + vis_frag + cd_rng +
                    " ORDER BY d.dispatched_at DESC LIMIT 6",
                    vis_params + cd_prm).fetchall() or []):
                a['recent_dispatches'].append({
                    'no': d['token_no'] or '—', 'project': d['code'] or '—',
                    'client': d['client_name'] or d['client_company'] or '—',
                    'date': str(d['dispatched_at'] or '')[:10]})
        except Exception:
            pass

        # ── Recently rejected samples ────────────────────────────────────
        a['rejected_recent'] = []
        try:
            for it in (conn.execute(
                    f"SELECT i.sample_code, i.reject_reason, p.code "
                    f"{S_BASE} AND i.approval_status='rejected' "
                    f"ORDER BY t.dispatched_at DESC LIMIT 6",
                    S_PRM).fetchall() or []):
                a['rejected_recent'].append({
                    'sample_code': it['sample_code'] or '—',
                    'project': it['code'] or '—',
                    'reason': it['reject_reason'] or '—'})
        except Exception:
            pass

        # ── Team workload (assigned R&D / creator) ──────────────────────
        a['team_workload'] = []
        try:
            rows = conn.execute(
                "SELECT COALESCE(NULLIF(u.full_name,''), u.username) AS nm, "
                "i.approval_status AS st, COUNT(*) AS c "
                "FROM `office_dispatch_items` i "
                "JOIN `office_dispatch_tokens` t ON t.id = i.token_id "
                "JOIN `npd_projects` p ON p.id = i.project_id "
                "JOIN `User_Tbl` u ON u.id = COALESCE(p.assigned_rd, "
                "p.created_by) WHERE p.is_deleted=0" + vis_frag + samp_rng +
                " GROUP BY nm, st", vis_params + samp_prm).fetchall() or []
            wm = {}
            for r in rows:
                d = wm.setdefault(r['nm'], {'name': r['nm'], 'in_process': 0,
                                            'completed': 0, 'rejected': 0})
                if r['st'] == 'pending':
                    d['in_process'] += r['c']
                elif r['st'] == 'approved':
                    d['completed'] += r['c']
                elif r['st'] == 'rejected':
                    d['rejected'] += r['c']
            a['team_workload'] = sorted(
                wm.values(), key=lambda x: (x['in_process'] + x['completed']
                                            + x['rejected']),
                reverse=True)[:6]
        except Exception:
            pass

        return _render('npd/npd_dashboard.html', a=a, period=period,
                       periods=PERIODS, active_item='npd-dash')
    finally:
        conn.close()
