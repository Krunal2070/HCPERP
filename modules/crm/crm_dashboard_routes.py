"""
modules/crm/crm_dashboard_routes.py
────────────────────────────────────────────────────────────────────────────
CRM · DASHBOARD  (analytics overview — KPI cards + charts)

  • Same conventions as crm_leads_routes.py:
      - raw pymysql via sampling_portal.get_db_connection()
      - session auth, _visibility_sql() respected (non-admin apne hi leads
        dekhte hain)
      - common sidebar via core/menus.get_menu('crm', ...)
  • Route   : GET /crm/dashboard?range=all|7d|30d|90d|month|year
  • Template: templates/crm/dashboard.html  (Chart.js CDN)

Registration: kuch alag se nahi karna — ye file crm_bp par hi routes
attach karti hai; bas modules/crm/__init__.py me `from . import
crm_dashboard_routes` hona chahiye (updated file ke saath diya hai).
"""

from datetime import datetime, timedelta

from flask import render_template, request, session, redirect, flash

from .crm_leads_routes import (crm_bp, _db, _visibility_sql, _is_admin,
                               _is_admin_mgr, _has_full_visibility,
                               _unassigned_sql, _role, _uname, _user_map,
                               login_required)

try:
    from menus import get_menu
except Exception:
    def get_menu(*a, **k):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────
RANGE_LABELS = {
    'all':   'All Time',
    'today': 'Today',
    '7d':    'Last 7 Days',
    '30d':   'Last 30 Days',
    '90d':   'Last 90 Days',
    'month': 'This Month',
    'year':  'This Year',
}


def _range_sql(rng):
    """created_at filter fragment + params for the selected range."""
    now = datetime.now()
    if rng == 'today':
        return " AND created_at >= %s", [now.replace(hour=0, minute=0,
                                                     second=0, microsecond=0)]
    if rng == '7d':
        return " AND created_at >= %s", [now - timedelta(days=7)]
    if rng == '30d':
        return " AND created_at >= %s", [now - timedelta(days=30)]
    if rng == '90d':
        return " AND created_at >= %s", [now - timedelta(days=90)]
    if rng == 'month':
        return " AND created_at >= %s", [now.replace(day=1, hour=0, minute=0,
                                                     second=0, microsecond=0)]
    if rng == 'year':
        return " AND created_at >= %s", [now.replace(month=1, day=1, hour=0,
                                                     minute=0, second=0,
                                                     microsecond=0)]
    return "", []          # all time


def _group_count(conn, col, base_where, params):
    """[(label, count), ...] grouped on `col` (NULL/'' -> 'Other')."""
    rows = conn.execute(
        f"SELECT COALESCE(NULLIF(TRIM({col}),''),'Other') AS k, "
        f"COUNT(*) AS c FROM `leads` WHERE {base_where} "
        f"GROUP BY k ORDER BY c DESC", params).fetchall() or []
    return [(r['k'], r['c']) for r in rows]


# ─────────────────────────────────────────────────────────────────────────────
# DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────
@crm_bp.route('/dashboard')
@login_required
def dashboard():
    rng = request.args.get('range', 'all')
    if rng not in RANGE_LABELS:
        rng = 'all'

    conn = _db()
    if not conn:
        flash('Database connection failed.', 'error')
        return redirect('/')
    try:
        vis_frag, vis_params = _visibility_sql()
        rng_frag, rng_params = _range_sql(rng)

        # base WHERE (active leads + visibility + selected range)
        base = "is_deleted=0" + vis_frag + rng_frag
        bp = vis_params + rng_params

        def _scalar(sql, params):
            r = conn.execute(sql, params).fetchone()
            return (list(r.values())[0] if r else 0) or 0

        # ── KPI cards ───────────────────────────────────────────────────
        total = _scalar(f"SELECT COUNT(*) FROM `leads` WHERE {base}", bp)

        st_rows = conn.execute(
            f"SELECT status, COUNT(*) AS c FROM `leads` WHERE {base} "
            f"GROUP BY status", bp).fetchall() or []
        st = {r['status']: r['c'] for r in st_rows}
        open_ct = st.get('open', 0)
        inproc_ct = st.get('in_process', 0)
        closed_ct = st.get('close', 0)
        cancel_ct = st.get('cancel', 0)

        revenue = _scalar(
            f"SELECT COALESCE(SUM(expected_value),0) FROM `leads` "
            f"WHERE {base} AND status='close'", bp)
        conv_rate = round((closed_ct / total) * 100, 1) if total else 0.0

        # ── Leads over time (last 7 days, range se independent) ─────────
        today = datetime.now().date()
        days = [today - timedelta(days=i) for i in range(6, -1, -1)]
        d_rows = conn.execute(
            "SELECT DATE(created_at) AS d, COUNT(*) AS c FROM `leads` "
            "WHERE is_deleted=0" + vis_frag +
            " AND created_at >= %s GROUP BY DATE(created_at)",
            vis_params + [datetime.combine(days[0], datetime.min.time())]
        ).fetchall() or []
        # NOTE: sampling_portal ka _DictRow dates ko 'YYYY-MM-DD' string me
        # convert karta hai — isliye keys ko str me normalise karo.
        dmap = {str(r['d'])[:10]: r['c'] for r in d_rows}
        week_labels = [d.strftime('%b %d') for d in days]
        week_dows = [d.strftime('%a') for d in days]
        week_counts = [dmap.get(d.strftime('%Y-%m-%d'), 0) for d in days]

        # ── Donut datasets ──────────────────────────────────────────────
        product_range = _group_count(conn, 'product_range', base, bp)
        lead_type = _group_count(conn, 'lead_type', base, bp)

        # NPD vs EPD — ab real npd_projects table se (leads jinse project bana)
        npd_ct, epd_ct = 0, 0
        try:
            lvis = (vis_frag.replace('assigned_to', 'l.assigned_to')
                            .replace('created_by', 'l.created_by')
                            .replace('team_members', 'l.team_members'))
            t_rows = conn.execute(
                "SELECT p.project_type AS t, COUNT(DISTINCT p.lead_id) AS c "
                "FROM `npd_projects` p JOIN `leads` l ON l.id = p.lead_id "
                "WHERE p.is_deleted=0 AND l.is_deleted=0" + lvis +
                rng_frag.replace('created_at', 'l.created_at') +
                " GROUP BY p.project_type",
                vis_params + rng_params).fetchall() or []
            tmap = {(r['t'] or '').lower(): r['c'] for r in t_rows}
            # old schema: project_type 'npd' / 'existing' (existing = EPD)
            npd_ct, epd_ct = tmap.get('npd', 0), tmap.get('existing', 0)
        except Exception:
            # npd_projects table na ho to fallback: client-linked leads
            npd_ct = _scalar(
                f"SELECT COUNT(*) FROM `leads` WHERE {base} "
                f"AND client_id IS NOT NULL", bp)
            epd_ct = 0

        # ── Bar charts ──────────────────────────────────────────────────
        source_wise = _group_count(conn, 'source', base, bp)[:8]
        category_wise = _group_count(conn, 'category', base, bp)[:8]

        # ── Deal status donut (master colors ke saath) ─────────────────
        statuses = conn.execute(
            "SELECT name, label, color FROM `lead_statuses` "
            "WHERE is_active=1 ORDER BY sort_order").fetchall() or []
        deal_status = [{'name': s['name'], 'label': s['label'],
                        'color': s['color'] or '#64748b',
                        'count': st.get(s['name'], 0)} for s in statuses]

        # ── Top performing agents ───────────────────────────────────────
        umap = _user_map(conn)
        ag_rows = conn.execute(
            f"SELECT assigned_to AS uid, COUNT(*) AS total_leads, "
            f"SUM(CASE WHEN status='close' THEN 1 ELSE 0 END) AS won "
            f"FROM `leads` WHERE {base} AND assigned_to IS NOT NULL "
            f"GROUP BY assigned_to ORDER BY won DESC, total_leads DESC "
            f"LIMIT 5", bp).fetchall() or []
        pts_rows = conn.execute(
            "SELECT user_id, COALESCE(SUM(points),0) AS pts "
            "FROM `lead_contributions` GROUP BY user_id").fetchall() or []
        pts = {r['user_id']: r['pts'] for r in pts_rows}
        top_agents = [{
            'name': umap.get(r['uid'], f"#{r['uid']}"),
            'total': r['total_leads'], 'won': r['won'] or 0,
            'points': pts.get(r['uid'], 0),
            'rate': round(((r['won'] or 0) / r['total_leads']) * 100)
                    if r['total_leads'] else 0,
        } for r in ag_rows]

        # ── Recent activities ───────────────────────────────────────────
        act_rows = conn.execute(
            "SELECT al.action, al.created_at, al.user_id, "
            "l.contact_name, l.company_name, l.id AS lead_id "
            "FROM `lead_activity_logs` al "
            "JOIN `leads` l ON l.id = al.lead_id "
            "WHERE l.is_deleted=0" + vis_frag.replace('assigned_to',
                                                      'l.assigned_to')
                                             .replace('created_by',
                                                      'l.created_by')
                                             .replace('team_members',
                                                      'l.team_members') +
            " ORDER BY al.created_at DESC LIMIT 8",
            vis_params).fetchall() or []
        def _fmt_when(v):
            """'YYYY-MM-DD HH:MM:SS' (string ya datetime) -> '06 Jun 12:03'."""
            if not v:
                return ''
            if isinstance(v, datetime):
                return v.strftime('%d %b %H:%M')
            try:
                return datetime.strptime(str(v)[:19],
                                         '%Y-%m-%d %H:%M:%S').strftime('%d %b %H:%M')
            except Exception:
                return str(v)

        activities = [{
            'action': a['action'],
            'who': a['contact_name'] or '',
            'company': a['company_name'] or '',
            'lead_id': a['lead_id'],
            'when': _fmt_when(a['created_at']),
        } for a in act_rows]

        # ── Bottom mini cards ───────────────────────────────────────────
        pending_fu = _scalar(
            f"SELECT COUNT(*) FROM `leads` WHERE {base} "
            f"AND status IN ('open','in_process') "
            f"AND follow_up_date IS NOT NULL AND follow_up_date <= CURDATE()",
            bp)
        ua_frag, ua_params = _unassigned_sql()
        unassigned = _scalar(
            f"SELECT COUNT(*) FROM `leads` WHERE {base} AND {ua_frag}",
            bp + ua_params)
        client_linked = _scalar(
            f"SELECT COUNT(*) FROM `leads` WHERE {base} "
            f"AND client_id IS NOT NULL", bp)
        client_unlinked = _scalar(
            f"SELECT COUNT(*) FROM `leads` WHERE {base} "
            f"AND client_id IS NULL", bp)

        return render_template(
            'crm/dashboard.html',
            rng=rng, range_labels=RANGE_LABELS,
            total=total, open_ct=open_ct, inproc_ct=inproc_ct,
            closed_ct=closed_ct, cancel_ct=cancel_ct,
            revenue=float(revenue), conv_rate=conv_rate,
            week_labels=week_labels, week_dows=week_dows,
            week_counts=week_counts,
            product_range=product_range, lead_type=lead_type,
            npd_ct=npd_ct, epd_ct=epd_ct,
            source_wise=source_wise, category_wise=category_wise,
            deal_status=deal_status, top_agents=top_agents,
            activities=activities,
            pending_fu=pending_fu, unassigned=unassigned,
            client_linked=client_linked, client_unlinked=client_unlinked,
            full_vis=_has_full_visibility(),
            is_admin=_is_admin(), is_admin_mgr=_is_admin_mgr(),
            sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
            active_item='crm-dash', user_name=_uname(),
            role=session.get('User_Type'),
        )
    finally:
        conn.close()
