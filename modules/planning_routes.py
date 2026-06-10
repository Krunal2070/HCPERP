"""
planning_routes.py
──────────────────────────────────────────────────────────────────────────────
Blueprint for Planning Department Dashboard.

Register in app.py:
    from planning_routes import planning_bp
    app.register_blueprint(planning_bp)

Also add 'planning' to ROLE_DEFAULT_PAGES for 'admin' and any planning role.
──────────────────────────────────────────────────────────────────────────────
"""

from flask import Blueprint, render_template, request, jsonify, session, redirect, url_for
from functools import wraps
import sampling_portal
import production_dept_routes

planning_bp = Blueprint('planning', __name__)


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            # For API calls return JSON; for page requests redirect to login
            if request.path.startswith('/api/'):
                return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def _can_planning():
    """True if user may access the Planning Dashboard (read-only view)."""
    role = session.get('User_Type', '')
    allowed = {'admin', 'Purchase', 'Planning', 'planning', 'Production'}
    if role in allowed:
        return True
    # Check permissions table
    uid = session.get('user_id')
    if uid:
        try:
            perms = sampling_portal.get_user_permissions(uid) or {}
            if perms.get('page:planning'):
                return True
        except Exception:
            pass
    return False


def _denied():
    return (
        """<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{font-family:sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:56px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}
.ico{font-size:56px;margin-bottom:12px} h2{color:#dc2626;margin:0 0 8px}
p{color:#64748b;margin:4px 0} a{color:#0d9488;font-weight:600;text-decoration:none}
</style></head><body><div class="box">
<div class="ico">&#128274;</div>
<h2>Access Denied</h2>
<p>You don't have permission to access</p>
<p><strong>Planning Dashboard</strong></p>
<br><a href="/">&#8592; Back to Portal</a>
</div></body></html>""",
        403
    )


# ─── Page route ──────────────────────────────────────────────────────────────

@planning_bp.route('/planning_dashboard')
@_login_required
def planning_dashboard_page():
    if not _can_planning():
        return _denied()
    return render_template(
        'planning_dashboard.html',
        role=session.get('User_Type', 'User'),
        user_name=session.get('User_Name', session.get('UID', '')),
    )


# ─── API: Processing Batches (from production_initiater) ─────────────────────

@planning_bp.route('/api/planning/processing_batches')
@_login_required
def api_planning_processing_batches():
    """All rows from Processing_batches — for Planning view."""
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute(
            "SELECT * FROM Processing_batches ORDER BY added_on DESC"
        ).fetchall()
        conn.close()
        result = []
        for r in rows:
            d = dict(r)
            for k, v in d.items():
                if hasattr(v, 'isoformat'):
                    d[k] = v.isoformat()
            result.append(d)
        return jsonify({'status': 'ok', 'rows': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ─── API: Daily Batch Dispensing Records ─────────────────────────────────────

@planning_bp.route('/api/planning/dsp_records')
@_login_required
def api_planning_dsp_records():
    """All daily_dsp_summary rows — planning view."""
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute("""
            SELECT d.*,
                   p.batch_type, p.sku_size, p.quantity,
                   (SELECT COALESCE(SUM(d2.dispensed),0)
                    FROM daily_dsp_summary d2
                    WHERE d2.batch_id = d.batch_id) AS total_dispensed_all
            FROM daily_dsp_summary d
            LEFT JOIN Processing_batches p ON p.id = d.batch_id
            ORDER BY d.batch_date DESC, d.id DESC
        """).fetchall()
        conn.close()
        result = []
        for r in rows:
            d = dict(r)
            for k, v in d.items():
                if hasattr(v, 'isoformat'):
                    d[k] = v.isoformat()
            result.append(d)
        return jsonify({'status': 'ok', 'rows': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ─── API: In-Process Batches (production_dept_log) ──────────────────────────

@planning_bp.route('/api/planning/inprocess_batches')
@_login_required
def api_planning_inprocess_batches():
    """All in-process rows from production_dept_log — read-only."""
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        rows = production_dept_routes.prod_dept_log_get()
        result = []
        for r in rows:
            d = dict(r)
            for k, v in d.items():
                if hasattr(v, 'isoformat'):
                    d[k] = v.isoformat()
            result.append(d)
        return jsonify({'status': 'ok', 'rows': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ─── API: Completed Batches + QC Status (production_summary ⋈ qc_inprocess) ─

@planning_bp.route('/api/planning/completed_batches')
@_login_required
def api_planning_completed_batches():
    """
    All completed production_summary rows merged with QC status.
    Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD filters.
    """
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    from_date = request.args.get('from', '')
    to_date   = request.args.get('to', '')
    try:
        conn = sampling_portal.get_db_connection()
        where_clauses = []
        params = []
        if from_date:
            where_clauses.append("DATE(ps.completed_at) >= %s")
            params.append(from_date)
        if to_date:
            where_clauses.append("DATE(ps.completed_at) <= %s")
            params.append(to_date)

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        rows = conn.execute(f"""
            SELECT
                ps.*,
                CASE
                  WHEN LOWER(qc.qc_status) IN ('pass','approved') THEN 'Approved'
                  WHEN LOWER(qc.qc_status) IN ('fail','failed','rejected') THEN 'Rejected'
                  WHEN qc.qc_status IS NULL THEN 'Pending'
                  ELSE qc.qc_status
                END                                   AS qc_status,
                COALESCE(qc.approved_by, '')          AS qc_approved_by,
                qc.approval_dt                        AS qc_approval_dt,
                qc.sample_qty                         AS qc_sample_qty,
                qc.remarks                            AS qc_remarks
            FROM production_summary ps
            LEFT JOIN qc_inprocess_checks qc
                   ON qc.production_summary_id = ps.id
            {where_sql}
            ORDER BY ps.completed_at DESC
        """, params).fetchall()
        conn.close()

        result = []
        for r in rows:
            d = dict(r)
            for k, v in d.items():
                if hasattr(v, 'isoformat'):
                    d[k] = v.isoformat()
            result.append(d)
        return jsonify({'status': 'ok', 'rows': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


# ─── API: Formulation Cost per kg (proxy — read-only, name + cost only) ───────

@planning_bp.route('/api/planning/formulation_costs')
@_login_required
def api_planning_formulation_costs():
    """
    Read-only view of formulation per-kg costs for Planning.
    Returns batch_name, brand_name, cost_per_kg, has_rate, missing_rate.
    No ingredient details exposed.
    """
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        from collections import defaultdict
        conn = sampling_portal.get_db_connection()

        FALLBACK_RATES = {
            "demineralized water": 0.43, "demineralised water": 0.43,
            "dm water": 0.43, "d m water": 0.43,
            "d.m. water": 0.43, "demi water": 0.43,
        }

        rows = conn.execute("""
            SELECT f.batch_name,
                   COALESCE(b.name, '') AS brand_name,
                   f.material_name,
                   f.concentration,
                   m.last_purchase_rate
            FROM   procurement_formulations f
            LEFT   JOIN procurement_brands b
                   ON b.id = f.brand_id
            LEFT   JOIN procurement_materials m
                   ON LOWER(TRIM(f.material_name)) = LOWER(TRIM(m.material_name))
            ORDER  BY COALESCE(b.name, ''), f.batch_name, f.id
        """).fetchall()
        conn.close()

        batches = defaultdict(lambda: {"cost_per_kg": 0.0, "has_rate": False, "missing_rate": [], "brand_name": ""})
        for r in rows:
            bn = r['batch_name']
            conc = r['concentration']
            rate = r['last_purchase_rate']
            if not batches[bn]["brand_name"] and r['brand_name']:
                batches[bn]["brand_name"] = r['brand_name']
            try: conc_f = float(conc) if conc else None
            except: conc_f = None
            try: rate_f = float(rate) if rate else None
            except: rate_f = None
            if rate_f is None:
                rate_f = FALLBACK_RATES.get((r['material_name'] or '').strip().lower())
            if conc_f is not None and rate_f is not None:
                batches[bn]["cost_per_kg"] += conc_f * rate_f
                batches[bn]["has_rate"] = True
            elif conc_f is not None and rate_f is None:
                batches[bn]["missing_rate"].append(r['material_name'])

        result = []
        for bn, d in batches.items():
            cpk = round(d["cost_per_kg"], 4) if d["cost_per_kg"] > 0 else None
            result.append({
                "batch_name":  bn,
                "brand_name":  d["brand_name"],
                "cost_per_kg": cpk,
                "has_rate":    d["has_rate"],
                "missing_rate": d["missing_rate"],
            })
        result.sort(key=lambda x: (x["brand_name"] or "\xff", x["batch_name"]))
        return jsonify({'status': 'ok', 'batches': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'batches': []}), 500


@planning_bp.route('/api/planning/pipeline')
@_login_required
def api_planning_pipeline():
    """
    For multi-batch projects (no_of_batch > 1), progress is computed as the
    weighted sum of individual batch completions across 4 stages:

        weight per batch per stage: Dispensed=1, InProcess=2, ProdDone=3, QCApproved=4
        max score per batch = 4
        progress_pct = total_score / (no_of_batch * 4) * 100

    Stage milestone dots show the HIGHEST sequential stage reached by ANY batch,
    giving a realistic picture — e.g. for 5-batch project: 1 QC approved + 2 in-process
    shows QC Approved milestone lit, and progress ~34%.
    """
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()

        # ── 1. All processing batches ────────────────────────────────────────
        batches = conn.execute("""
            SELECT id, batch_name, batch_size, no_of_batch, batch_type,
                   dispensed_batches, added_on, sku_size, quantity
            FROM Processing_batches
            ORDER BY added_on DESC
        """).fetchall()

        # ── 2. Dispensed counts per batch_id ─────────────────────────────────
        # dispensed_batches column on Processing_batches = cumulative dispensed
        # We also need "has any been dispensed" per id
        dispensed_ids = set(
            r['batch_id']
            for r in conn.execute("""
                SELECT DISTINCT batch_id FROM daily_dsp_summary
                WHERE dispensed > 0 OR initial_remaining > 0
            """).fetchall()
        )

        # ── 3. In-process count per batch_name ───────────────────────────────
        inprocess_counts = {}
        for r in conn.execute("""
            SELECT batch_name, COUNT(*) AS cnt FROM production_dept_log
            GROUP BY batch_name
        """).fetchall():
            inprocess_counts[r['batch_name']] = int(r['cnt'])

        # ── 4. Completed count per batch_name ─────────────────────────────────
        completed_counts = {}
        for r in conn.execute("""
            SELECT batch_name, COUNT(*) AS cnt FROM production_summary
            GROUP BY batch_name
        """).fetchall():
            completed_counts[r['batch_name']] = int(r['cnt'])

        # ── 5. QC approved count per batch_name ──────────────────────────────
        qc_approved_counts = {}
        for r in conn.execute("""
            SELECT ps.batch_name, COUNT(*) AS cnt
            FROM qc_inprocess_checks qc
            JOIN production_summary ps ON ps.id = qc.production_summary_id
            WHERE LOWER(qc.qc_status) IN ('approved', 'pass')
            GROUP BY ps.batch_name
        """).fetchall():
            qc_approved_counts[r['batch_name']] = int(r['cnt'])

        conn.close()

        # ── Build pipeline rows ──────────────────────────────────────────────
        pipeline = []
        for b in batches:
            bid  = b['id']
            name = b['batch_name']
            nb   = max(1, int(b['no_of_batch']))   # total individual batches
            disp = int(b['dispensed_batches'] or 0)

            # Per-stage individual batch counts (capped at nb)
            n_dispensed = min(disp, nb)             # how many batches dispensed
            n_inprocess = min(inprocess_counts.get(name, 0), nb)
            n_completed = min(completed_counts.get(name, 0), nb)
            n_qcapproved= min(qc_approved_counts.get(name, 0), nb)

            # Boolean milestone flags — has ANY batch reached this stage?
            s1_dispensing_ready = bid in dispensed_ids
            s2_inprocess        = n_inprocess > 0
            s3_production_done  = n_completed > 0
            s4_qc_approved      = n_qcapproved > 0

            # Highest sequential stage reached (for milestone dots)
            if s4_qc_approved and s3_production_done and s2_inprocess and s1_dispensing_ready:
                stage = 4
            elif s3_production_done and s2_inprocess and s1_dispensing_ready:
                stage = 3
            elif s2_inprocess and s1_dispensing_ready:
                stage = 2
            elif s1_dispensing_ready:
                stage = 1
            else:
                stage = 0

            # ── Progress % = QC approved batches / total batches ────────────
            # e.g. 3 of 5 batches QC approved → 60%
            # For single-batch projects: 0% or 100% based on QC approval.
            progress_pct = round((n_qcapproved / nb) * 100) if nb > 0 else 0

            row = {
                'id':            bid,
                'batch_name':    name,
                'batch_size':    float(b['batch_size']),
                'no_of_batch':   nb,
                'dispensed':     disp,
                'batch_type':    b['batch_type'],
                'sku_size':      b['sku_size'] or '',
                'added_on':      b['added_on'].isoformat() if hasattr(b['added_on'], 'isoformat') else str(b['added_on']),
                'stage':         stage,
                'progress_pct':  progress_pct,
                # Individual counts for tooltip display
                'n_dispensed':   n_dispensed,
                'n_inprocess':   n_inprocess,
                'n_completed':   n_completed,
                'n_qcapproved':  n_qcapproved,
                's1_dispensing_ready': s1_dispensing_ready,
                's2_inprocess':        s2_inprocess,
                's3_production_done':  s3_production_done,
                's4_qc_approved':      s4_qc_approved,
            }
            pipeline.append(row)

        return jsonify({'status': 'ok', 'pipeline': pipeline})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'pipeline': []}), 500


# ─── API: Leaderboard — operator performance with User_Type from user_tbl ─────

@planning_bp.route('/api/planning/leaderboard')
@_login_required
def api_planning_leaderboard():
    """
    Per-operator performance: batches in-process, completed, QC approved/pending/rejected.
    Tries to join user_tbl for User_Type; falls back gracefully if table/columns differ.
    """
    if not _can_planning():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        from collections import defaultdict
        conn = sampling_portal.get_db_connection()

        # ── Load user type map from user_tbl ─────────────────────────────────
        # operator_name in production_summary = person's login username (uppercase)
        # user_tbl has username (lowercase) and user_type
        user_type_map = {}   # lower(key) → user_type
        user_type_list = []  # list of (lower_username, user_type) for partial matching
        try:
            utbl = conn.execute("""
                SELECT username, full_name, user_type, department
                FROM user_tbl
                WHERE is_active = 1
            """).fetchall()
            for u in utbl:
                utype = (u['user_type'] or u['department'] or '').strip()
                if u['username']:
                    key = u['username'].strip().lower()
                    user_type_map[key] = utype
                    user_type_list.append((key, utype))
                if u['full_name'] and u['full_name'].strip().lower() != (u['username'] or '').strip().lower():
                    user_type_map[u['full_name'].strip().lower()] = utype
        except Exception:
            pass

        def get_user_type(operator_name):
            """Match operator_name to user_type.
            Operators recorded in production_summary who aren't in user_tbl
            individually are production floor workers → default to 'Production'."""
            n = operator_name.strip().lower()
            # 1. Exact match by username or full_name
            if n in user_type_map:
                return user_type_map[n]
            # 2. Split slash-combined names (e.g. BAKUL/SANJAY → try bakul, sanjay)
            parts = [p.strip() for p in n.split('/') if p.strip()]
            for part in parts:
                if part in user_type_map:
                    return user_type_map[part]
            # 3. Prefix match
            for key, utype in user_type_list:
                if n.startswith(key) or key.startswith(n):
                    return utype
            # 4. Default: operators recorded in production_summary are production workers
            return 'Production'

        # ── Completed batches ─────────────────────────────────────────────────
        completed_rows = conn.execute("""
            SELECT
                ps.operator_name,
                CASE
                  WHEN LOWER(qc.qc_status) IN ('pass','approved') THEN 'Approved'
                  WHEN LOWER(qc.qc_status) IN ('fail','failed','rejected') THEN 'Rejected'
                  WHEN qc.qc_status IS NULL THEN 'Pending'
                  ELSE qc.qc_status
                END AS qc_status
            FROM production_summary ps
            LEFT JOIN qc_inprocess_checks qc ON qc.production_summary_id = ps.id
            ORDER BY ps.operator_name
        """).fetchall()

        # ── In-process batches ────────────────────────────────────────────────
        try:
            inprocess_rows = conn.execute(
                "SELECT operator_name FROM production_dept_log"
            ).fetchall()
        except Exception:
            inprocess_rows = []

        conn.close()

        ops = defaultdict(lambda: {
            'name': '', 'user_type': '',
            'inprocess': 0, 'completed': 0,
            'qc_approved': 0, 'qc_pending': 0, 'qc_rejected': 0
        })

        for r in inprocess_rows:
            n = (r['operator_name'] or '').strip()
            if not n:
                continue
            ops[n]['name'] = n
            if not ops[n]['user_type']:
                ops[n]['user_type'] = get_user_type(n)
            ops[n]['inprocess'] += 1

        for r in completed_rows:
            n = (r['operator_name'] or '').strip()
            if not n:
                continue
            ops[n]['name'] = n
            if not ops[n]['user_type']:
                ops[n]['user_type'] = get_user_type(n)
            ops[n]['completed'] += 1
            st = r['qc_status']
            if st == 'Approved':  ops[n]['qc_approved'] += 1
            elif st == 'Pending': ops[n]['qc_pending'] += 1
            elif st == 'Rejected':ops[n]['qc_rejected'] += 1

        result = []
        for n, d in ops.items():
            total = d['completed']
            d['completion_pct'] = round((d['qc_approved'] / total) * 100) if total > 0 else 0
            d['score'] = d['qc_approved'] * 3 + d['completed'] * 2 + d['inprocess']
            result.append(d)

        result.sort(key=lambda x: -x['score'])
        return jsonify({'status': 'ok', 'operators': result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e), 'operators': []}), 500

