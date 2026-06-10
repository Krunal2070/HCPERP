"""
qc/qc_routes.py
──────────────────────────────────────────────────────────────────────────────
Flask Blueprint for QC Dashboard, QC Sampling, and the new In-Process
Approval Form (parameters capture).

Register in app.py:
    from qc import qc_bp
    app.register_blueprint(qc_bp)

This module owns:
  • Page routes:                  /qc_dashboard, /qc_sampling
  • IPM QC status APIs:           /api/qc/inprocess_checks (GET / save / unlock)
  • IPM Parameter Form APIs:      /api/qc/inprocess_params (GET, save, history, pdf, whatsapp)
  • QC Sampling list/save:        /api/qc_sampling/list, /api/qc_sampling/save
  • Production summary proxy:     /api/qc/production_summary_all
  • Label printing (TSPL/PDF):    /api/qc/print_label, /api/qc/label_pdf
  • DB table bootstrap:           qc_inprocess_checks, qc_inprocess_params,
                                  qc_inprocess_params_history

Templates live in templates/qc/ (qc_dashboard.html, qc_sampling.html).
──────────────────────────────────────────────────────────────────────────────
"""

from flask import (
    Blueprint, render_template, request, jsonify, session, redirect, send_file
)
from functools import wraps
from datetime import datetime, timedelta, timezone as _tz
try:
    from menus import get_menu          # common sidebar menus (core/ on sys.path)
except Exception:
    def get_menu(*a, **k): return None
import io
import json

import sampling_portal

qc_bp = Blueprint('qc', __name__)


# ─── IST wall-clock helpers ───────────────────────────────────────────────────
# Server may run in any timezone. These produce IST (Asia/Kolkata, UTC+5:30)
# deterministically regardless of OS timezone.

_IST_TZ = _tz(timedelta(hours=5, minutes=30))


def _ist_now():
    return datetime.now(_tz.utc).astimezone(_IST_TZ)


def _ist_now_str():
    return _ist_now().strftime('%Y-%m-%d %H:%M:%S')


def _ist_now_dmy():
    """Current IST as 'DD-MM-YYYY HH:MM:SS' for human display."""
    return _ist_now().strftime('%d-%m-%Y %H:%M:%S')


# ─── Datetime normalizer ──────────────────────────────────────────────────────
# Flask's default jsonify serializes datetimes as RFC-1123 GMT strings, which
# confuses frontend parsing. Normalize to plain 'YYYY-MM-DD HH:MM:SS' strings.

def _dt2str(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    return v


def _normalize_row(r):
    if not isinstance(r, dict):
        r = dict(r)
    return {k: _dt2str(v) for k, v in r.items()}


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect('/login')
        return f(*args, **kwargs)
    return decorated


def _can_qc_dashboard():
    role = session.get('User_Type', '')
    if role in ('admin', 'QC'):
        return True
    if (role or '').lower() in ('qc_common', 'purchase'):
        return True
    uid = session.get('user_id')
    if uid:
        try:
            perms = sampling_portal.get_user_permissions(uid) or {}
            if perms.get('page:qc_dashboard'):
                return True
        except Exception:
            pass
    return False


def _can_qc_sampling():
    """Purchase users can save to QC Sampling but don't need full QC Dashboard access."""
    role = session.get('User_Type', '')
    if role in ('admin', 'QC', 'Purchase'):
        return True
    if (role or '').lower() == 'qc_common':
        return True
    uid = session.get('user_id')
    if uid:
        try:
            perms = sampling_portal.get_user_permissions(uid) or {}
            if perms.get('page:qc_dashboard') or perms.get('qcs_add'):
                return True
        except Exception:
            pass
    return False


def _can_prod_dept():
    role = session.get('User_Type', '')
    if role.lower() == 'production':
        return True
    uid = session.get('user_id')
    if uid:
        try:
            perms = sampling_portal.get_user_permissions(uid) or {}
            if perms.get('page:production_dept'):
                return True
        except Exception:
            pass
    return False


def _is_admin():
    role = session.get('User_Type', '')
    return role == 'admin' or (role or '').lower() == 'admin'


def _denied(label='this page'):
    return (
        f"""<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{{font-family:sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.box{{background:#fff;border-radius:16px;padding:56px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}}
h2{{color:#dc2626;margin:0 0 8px}} a{{color:#0d9488;font-weight:600;text-decoration:none}}
</style></head><body><div class="box">
<h2>&#128274; Access Denied</h2><p>No permission for <strong>{label}</strong></p>
<br><a href="/">&#8592; Back to Portal</a></div></body></html>""",
        403
    )


# ══════════════════════════════════════════════════════════════════════════════
# DB BOOTSTRAP — qc_inprocess_checks, qc_inprocess_params,
#                qc_inprocess_params_history
# ══════════════════════════════════════════════════════════════════════════════

# Parameter columns — used by both the live table and the history table.
# Keep this list as the single source of truth.
_PARAM_COLUMNS = [
    'batch_date',          # VARCHAR(50)  - 'YYYY-MM-DD' or free text
    'batch_no',            # VARCHAR(100)
    'product_name',        # VARCHAR(255)
    'batch_size',          # VARCHAR(100)
    'received_by',         # VARCHAR(150)
    'appearance',          # TEXT
    'odour',               # TEXT
    'ph_value',            # VARCHAR(50)
    'ph_temp',             # VARCHAR(50)   - the recorded ___°C
    'ph_limit',            # VARCHAR(100)
    'viscosity_cps',       # VARCHAR(50)
    'viscosity_spindle',   # VARCHAR(50)
    'viscosity_rpm',       # VARCHAR(50)
    'viscosity_torque',    # VARCHAR(50)
    'viscosity_limit',     # VARCHAR(100)
    'viscosity_temp',      # VARCHAR(50)
    'specific_gravity_value',  # VARCHAR(50)
    'specific_gravity_min',    # VARCHAR(50)
    'specific_gravity_max',    # VARCHAR(50)
    'foam_height_value',       # VARCHAR(50)
    'foam_height_min',         # VARCHAR(50)
    'foam_height_max',         # VARCHAR(50)
    'refractive_index',        # VARCHAR(50)
    'weight_check',            # VARCHAR(255)
    'batch_incharge',          # VARCHAR(150)
    'analyzed_by',             # VARCHAR(150)
    'authorised_person',       # VARCHAR(150)
    # Last 3 batches (auto-fetched suggestion, user can override)
    'last3_b1_date', 'last3_b1_visc', 'last3_b1_ph', 'last3_b1_foam',
    'last3_b2_date', 'last3_b2_visc', 'last3_b2_ph', 'last3_b2_foam',
    'last3_b3_date', 'last3_b3_visc', 'last3_b3_ph', 'last3_b3_foam',
    # Change-reason — REQUIRED when status flips between Pass <-> Fail
    'change_reason',           # TEXT
]


def _ensure_qc_tables():
    """Create / migrate all QC tables on module import.

    Each DDL block is independently wrapped so that one failure doesn't
    cascade and prevent the others. Errors are printed but never raised.
    Flask startup is guaranteed to proceed regardless.
    """
    try:
        conn = sampling_portal.get_db_connection()
    except Exception:
        import traceback
        print("[qc_routes] WARNING: get_db_connection() failed during startup")
        traceback.print_exc()
        return
    if not conn:
        print("[qc_routes] WARNING: get_db_connection() returned None — skipping QC table bootstrap")
        return

    def _run(label, sql, params=None):
        """Execute one DDL, log + swallow any error."""
        try:
            if params is None:
                conn.execute(sql)
            else:
                conn.execute(sql, params)
            conn.commit()
        except Exception as e:
            print(f"[qc_routes] DDL '{label}' skipped: {e}")

    try:
        # ── qc_inprocess_checks — the existing IPM status table ───────────
        _run('CREATE qc_inprocess_checks', """
            CREATE TABLE IF NOT EXISTS qc_inprocess_checks (
                id                    INT AUTO_INCREMENT PRIMARY KEY,
                production_summary_id INT NOT NULL,
                qc_status             VARCHAR(50)  DEFAULT 'Pending',
                approved_by           VARCHAR(200) DEFAULT NULL,
                approval_dt           DATETIME     DEFAULT NULL,
                sample_qty            VARCHAR(100) DEFAULT NULL,
                drums                 VARCHAR(100) DEFAULT NULL,
                remarks               TEXT         NULL,
                updated_at            DATETIME     DEFAULT CURRENT_TIMESTAMP
                                                   ON UPDATE CURRENT_TIMESTAMP,
                created_by            VARCHAR(100) DEFAULT NULL,
                UNIQUE KEY ux_qc_inprocess_summary (production_summary_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        """)
        try:
            cols = conn.execute("SHOW COLUMNS FROM qc_inprocess_checks").fetchall()
            existing = [c['Field'] for c in cols]
            if 'sample_qty' not in existing:
                _run('ADD sample_qty', "ALTER TABLE qc_inprocess_checks ADD COLUMN sample_qty VARCHAR(100) DEFAULT NULL AFTER approval_dt")
            if 'drums' not in existing:
                _run('ADD drums', "ALTER TABLE qc_inprocess_checks ADD COLUMN drums VARCHAR(100) DEFAULT NULL AFTER sample_qty")
        except Exception as e:
            print(f"[qc_routes] qc_inprocess_checks migration skipped: {e}")

        # ── qc_inprocess_params — current parameter set per IPM row ───────
        param_cols_sql = ',\n            '.join([
            f"{c} TEXT NULL" for c in _PARAM_COLUMNS
        ])
        _run('CREATE qc_inprocess_params', f"""
            CREATE TABLE IF NOT EXISTS qc_inprocess_params (
                id                    INT AUTO_INCREMENT PRIMARY KEY,
                production_summary_id INT NOT NULL,
                qc_status_at_save     VARCHAR(50) DEFAULT NULL,
                {param_cols_sql},
                saved_by              VARCHAR(150) DEFAULT NULL,
                saved_at              DATETIME    DEFAULT CURRENT_TIMESTAMP
                                                  ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY ux_qc_inprocess_params_summary (production_summary_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        """)
        try:
            cols = conn.execute("SHOW COLUMNS FROM qc_inprocess_params").fetchall()
            existing = {c['Field'] for c in cols}
            for c in _PARAM_COLUMNS:
                if c not in existing:
                    _run(f'ADD {c} (params)', f"ALTER TABLE qc_inprocess_params ADD COLUMN {c} TEXT NULL")
        except Exception as e:
            print(f"[qc_routes] qc_inprocess_params migration skipped: {e}")

        # ── qc_inprocess_params_history — preserved snapshots ─────────────
        _run('CREATE qc_inprocess_params_history', f"""
            CREATE TABLE IF NOT EXISTS qc_inprocess_params_history (
                id                    INT AUTO_INCREMENT PRIMARY KEY,
                production_summary_id INT NOT NULL,
                qc_status_at_save     VARCHAR(50) DEFAULT NULL,
                {param_cols_sql},
                saved_by              VARCHAR(150) DEFAULT NULL,
                saved_at              DATETIME    DEFAULT NULL,
                archived_at           DATETIME    DEFAULT CURRENT_TIMESTAMP,
                archive_reason        VARCHAR(255) DEFAULT NULL,
                KEY ix_history_summary (production_summary_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        """)
        try:
            cols = conn.execute("SHOW COLUMNS FROM qc_inprocess_params_history").fetchall()
            existing = {c['Field'] for c in cols}
            for c in _PARAM_COLUMNS:
                if c not in existing:
                    _run(f'ADD {c} (history)', f"ALTER TABLE qc_inprocess_params_history ADD COLUMN {c} TEXT NULL")
        except Exception as e:
            print(f"[qc_routes] qc_inprocess_params_history migration skipped: {e}")

        # ── procurement_grn_trs — edit-access request columns ─────────────
        # The inventory module owns/creates this table; we only ADD two
        # columns used by the "QC requests, admin grants" unlock flow.
        # When a QC user hits a 24h-locked TRS they can request edit
        # access; an admin viewing the row can grant it (which clears
        # approval_locked_at, re-opening the 24h editability window) and
        # the request is cleared. Each ALTER is independently guarded —
        # a missing table just logs and continues.
        try:
            cols = conn.execute("SHOW COLUMNS FROM procurement_grn_trs").fetchall()
            existing = {c['Field'] for c in cols}
            if 'unlock_requested_at' not in existing:
                _run('ADD unlock_requested_at (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN unlock_requested_at DATETIME DEFAULT NULL")
            if 'unlock_requested_by' not in existing:
                _run('ADD unlock_requested_by (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN unlock_requested_by VARCHAR(150) DEFAULT NULL")
            # COA capture extras (item 2-5 of the May-2026 COA redesign):
            #   coa_verified_by    — free-text name the QC user types as the
            #                        "Verified By" signatory (distinct from
            #                        approved_by, which is the logged-in QC user).
            #   coa_supplier_passed— 1 when "Checked & passed as per supplier
            #                        COA" was ticked (all params forced PASS).
            #   coa_deviation      — 'YES' / 'NO' / NULL deviation-observed flag.
            #   coa_deviation_note — free-text deviation description (when YES).
            if 'coa_verified_by' not in existing:
                _run('ADD coa_verified_by (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN coa_verified_by VARCHAR(200) DEFAULT NULL")
            if 'coa_supplier_passed' not in existing:
                _run('ADD coa_supplier_passed (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN coa_supplier_passed TINYINT(1) DEFAULT 0")
            if 'coa_deviation' not in existing:
                _run('ADD coa_deviation (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN coa_deviation VARCHAR(10) DEFAULT NULL")
            if 'coa_deviation_note' not in existing:
                _run('ADD coa_deviation_note (trs)',
                     "ALTER TABLE procurement_grn_trs "
                     "ADD COLUMN coa_deviation_note TEXT NULL")
        except Exception as e:
            print(f"[qc_routes] procurement_grn_trs unlock-column migration skipped: {e}")
    except Exception:
        import traceback
        print("[qc_routes] unexpected error during QC table bootstrap")
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


try:
    _ensure_qc_tables()
except Exception:
    import traceback
    print("[qc_routes] ERROR during _ensure_qc_tables() — continuing startup anyway")
    traceback.print_exc()


# ══════════════════════════════════════════════════════════════════════════════
# DB FUNCTIONS — qc_inprocess_checks (status) + qc_inprocess_params (form)
# ══════════════════════════════════════════════════════════════════════════════

def qc_inprocess_get_all():
    """Return all IPM QC check status rows."""
    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        "SELECT * FROM qc_inprocess_checks ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qc_inprocess_save(production_summary_id, qc_status, approved_by,
                      approval_dt, sample_qty, drums, remarks, created_by):
    """Upsert a QC status row for a production_summary record."""
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        INSERT INTO qc_inprocess_checks
            (production_summary_id, qc_status, approved_by, approval_dt,
             sample_qty, drums, remarks, updated_at, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), %s)
        ON DUPLICATE KEY UPDATE
            qc_status   = VALUES(qc_status),
            approved_by = VALUES(approved_by),
            approval_dt = VALUES(approval_dt),
            sample_qty  = VALUES(sample_qty),
            drums       = VALUES(drums),
            remarks     = VALUES(remarks),
            updated_at  = NOW()
    """, (production_summary_id, qc_status, approved_by,
          approval_dt or None, sample_qty, drums or None,
          remarks or None, created_by))
    conn.commit()
    row = conn.execute(
        "SELECT id FROM qc_inprocess_checks WHERE production_summary_id = %s",
        (production_summary_id,)
    ).fetchone()
    conn.close()
    return row['id'] if row else None


def qc_params_get(production_summary_id):
    """Return the current parameter row for a given IPM batch, or None."""
    conn = sampling_portal.get_db_connection()
    row = conn.execute(
        "SELECT * FROM qc_inprocess_params WHERE production_summary_id = %s",
        (production_summary_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def qc_params_history(production_summary_id):
    """Return archived parameter snapshots for a given IPM batch, newest first."""
    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        "SELECT * FROM qc_inprocess_params_history "
        "WHERE production_summary_id = %s ORDER BY archived_at DESC",
        (production_summary_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qc_params_save(production_summary_id, new_status, payload, saved_by):
    """
    Upsert parameter row. If a row already exists AND its previous
    qc_status_at_save differs from new_status (Pass<->Fail flip), archive
    the existing row into qc_inprocess_params_history before overwriting.

    Returns: (row_id, archived_bool)
    """
    conn = sampling_portal.get_db_connection()
    existing = conn.execute(
        "SELECT * FROM qc_inprocess_params WHERE production_summary_id = %s",
        (production_summary_id,)
    ).fetchone()

    archived = False
    if existing:
        prev_status = (existing.get('qc_status_at_save') or '').strip()
        # Archive when status flips between any two distinct non-Pending values
        # (Pass <-> Fail, Under Review <-> Pass/Fail, etc).
        if prev_status and prev_status != (new_status or '').strip():
            cols_to_copy = ['production_summary_id', 'qc_status_at_save'] + _PARAM_COLUMNS + ['saved_by', 'saved_at']
            placeholders = ','.join(['%s'] * len(cols_to_copy))
            values = tuple(existing.get(c) for c in cols_to_copy)
            archive_reason = f'Status changed: {prev_status} -> {new_status}'
            conn.execute(
                f"INSERT INTO qc_inprocess_params_history "
                f"({','.join(cols_to_copy)}, archive_reason) "
                f"VALUES ({placeholders}, %s)",
                values + (archive_reason,)
            )
            archived = True

    # Build upsert
    all_cols = ['production_summary_id', 'qc_status_at_save'] + _PARAM_COLUMNS + ['saved_by']
    values = [production_summary_id, new_status] + [
        (payload.get(c) or None) for c in _PARAM_COLUMNS
    ] + [saved_by]
    placeholders = ','.join(['%s'] * len(all_cols))
    update_clause = ', '.join([f"{c}=VALUES({c})" for c in all_cols if c != 'production_summary_id'])
    update_clause += ', saved_at=NOW()'
    conn.execute(
        f"INSERT INTO qc_inprocess_params ({','.join(all_cols)}) "
        f"VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}",
        tuple(values)
    )
    conn.commit()
    row = conn.execute(
        "SELECT id FROM qc_inprocess_params WHERE production_summary_id = %s",
        (production_summary_id,)
    ).fetchone()
    conn.close()
    return (row['id'] if row else None), archived


def qc_params_last3_suggestion(product_code, exclude_summary_id=None):
    """
    Auto-fetch suggestions: last 3 Approved batches with the same product code.
    Pulls from production_summary joined with qc_inprocess_checks (status=Pass)
    and qc_inprocess_params (for viscosity/pH/foam values, if previously saved).

    Returns: list of up to 3 dicts: {batch_date, viscosity, ph, foam}
    """
    if not product_code:
        return []
    conn = sampling_portal.get_db_connection()
    try:
        sql = """
            SELECT ps.id, ps.completed_at, ps.processing_datetime,
                   p.batch_date AS p_batch_date,
                   p.viscosity_cps, p.ph_value, p.foam_height_value
            FROM production_summary ps
            INNER JOIN qc_inprocess_checks qc
                    ON qc.production_summary_id = ps.id
            LEFT JOIN qc_inprocess_params p
                    ON p.production_summary_id = ps.id
            WHERE ps.product_code = %s
              AND qc.qc_status = 'Pass'
        """
        args = [product_code]
        if exclude_summary_id:
            sql += " AND ps.id <> %s"
            args.append(exclude_summary_id)
        sql += " ORDER BY ps.id DESC LIMIT 3"
        rows = conn.execute(sql, tuple(args)).fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()

    out = []
    for r in rows:
        # Prefer parameter-form batch_date if set, else production completed/processing date
        bdate = r.get('p_batch_date') or _dt2str(r.get('completed_at')) or _dt2str(r.get('processing_datetime')) or ''
        if bdate and len(bdate) >= 10:
            bdate = bdate[:10]
        out.append({
            'batch_date': bdate,
            'viscosity':  r.get('viscosity_cps') or '',
            'ph':         r.get('ph_value') or '',
            'foam':       r.get('foam_height_value') or '',
        })
    return out


# ══════════════════════════════════════════════════════════════════════════════
# PAGE ROUTES — /qc_dashboard, /qc_sampling
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/qc_dashboard')
@_login_required
def qc_dashboard_page():
    if not _can_qc_dashboard():
        return _denied('QC Dashboard')
    return render_template('qc/qc_dashboard.html',
                           role=session.get('User_Type', 'User'),
                           user_name=session.get('User_Name'),
                           sidebar_menu=get_menu('qc', role=session.get('User_Type')),
                           active_item='ipm')


@qc_bp.route('/qc/trs/<int:trs_id>/coa_print')
@_login_required
def qc_trs_coa_print(trs_id):
    """Render the QC Certificate of Analysis for a single TRS in a clean,
    printable HTML page.

    This is the SINGLE SOURCE OF TRUTH for the COA layout. Both the QC
    Dashboard TRS modal (via window.open) AND the TRS Register's
    Print Approval Report button open this URL, so any visual tweak
    here is reflected in both surfaces — no more duplicated JS builder
    across qc_dashboard.html and trs_register.html.

    Access: any logged-in user can open the COA (it's a non-destructive
    read of an already-decided QC slip). We deliberately don't gate
    on QC role here so warehouse operators printing the certificate
    to attach to a barrel don't get blocked.

    Defensive: the entire body is wrapped in a try/except so any
    failure (DB error, missing column, Jinja template not found,
    template render error) returns a readable diagnostic page rather
    than a generic 500 from Flask. The full traceback is also written
    to the Flask log so it shows up in journalctl/wsgi logs.
    """
    import traceback
    try:
        # ── Open DB ──
        try:
            conn = sampling_portal.get_db_connection()
        except Exception as e:
            traceback.print_exc()
            return (f"<h1 style='font-family:sans-serif;padding:40px;color:#b91c1c'>"
                    f"Database unavailable</h1>"
                    f"<pre style='font-family:monospace;padding:0 40px;color:#374151'>"
                    f"{type(e).__name__}: {e}</pre>"), 503

        # ── Fetch the TRS row ──
        # Use a column-existence-tolerant approach: SELECT * and just pluck
        # the columns we know are present. This way a partial schema
        # migration on the server doesn't break the whole page.
        try:
            row = conn.execute(
                "SELECT * FROM procurement_grn_trs WHERE id=%s",
                (trs_id,)
            ).fetchone()
        except Exception as e:
            traceback.print_exc()
            try: conn.close()
            except Exception: pass
            return (f"<h1 style='font-family:sans-serif;padding:40px;color:#b91c1c'>"
                    f"Database query failed</h1>"
                    f"<pre style='font-family:monospace;padding:0 40px;color:#374151;white-space:pre-wrap'>"
                    f"{type(e).__name__}: {e}</pre>"
                    f"<p style='font-family:sans-serif;padding:0 40px;color:#374151'>"
                    f"This often means the <code>procurement_grn_trs</code> table "
                    f"is missing one of the columns the route queries. Check the "
                    f"Flask log for the full traceback.</p>"), 500
        finally:
            try: conn.close()
            except Exception: pass

        if not row:
            return ("<h1 style='font-family:sans-serif;padding:40px'>"
                    f"TRS #{trs_id} not found</h1>"
                    f"<p style='font-family:sans-serif;padding:0 40px;color:#6b7280'>"
                    f"The TRS row was deleted or the id was mistyped.</p>"), 404

        trs = dict(row) if hasattr(row, 'keys') else row
        # Normalise: ensure ALL keys the template references exist (with
        # None as the default) so a partial schema doesn't break the
        # Jinja render with an UndefinedError.
        for k in ('trs_num', 'grn_num', 'grn_date', 'material', 'batch_num',
                  'packages', 'qty_per_pkg', 'total_qty', 'uom',
                  'manufacturer', 'mfg_date', 'expiry_date', 'supplier_name',
                  'physical_state', 'sample_qty', 'previous_supplier',
                  'new_or_old', 'verified_by', 'generated_by', 'generated_at',
                  'approval_status', 'approved_by', 'approval_dt',
                  'approval_remarks', 'approval_locked_at',
                  'checked_params', 'rejection_reason',
                  'coa_verified_by', 'coa_supplier_passed',
                  'coa_deviation', 'coa_deviation_note'):
            trs.setdefault(k, None)

        # ── Parse checked_params (stored as JSON string in DB) ──
        raw_cp = trs.get('checked_params')
        params = []
        if raw_cp:
            try:
                parsed = json.loads(raw_cp)
                if isinstance(parsed, list):
                    params = [p for p in parsed if isinstance(p, dict) and p.get('name')]
            except Exception:
                # Bad/legacy JSON shouldn't fail the page; just show no params.
                traceback.print_exc()
                params = []

        # ── Pass/fail/NA summary ──
        pass_count = sum(1 for p in params if p.get('passed') is True)
        fail_count = sum(1 for p in params if p.get('passed') is False)
        na_count   = len(params) - pass_count - fail_count

        # ── Verdict flag for the template ──
        status      = (trs.get('approval_status') or 'Pending').strip()
        is_approved = (status == 'Approved')

        # ── Approver display ──
        approved_by_raw = (trs.get('approved_by') or '').strip()
        approver_is_placeholder = 'pending assignment' in approved_by_raw.lower()
        approved_by_display = approved_by_raw if approved_by_raw else '—'

        # ── Date formatters used in the template ──
        def _fmt_d(v):
            if not v:
                return '—'
            s = str(v)[:10]
            if len(s) == 10 and s[4] == '-' and s[7] == '-':
                return s[8:10] + '-' + s[5:7] + '-' + s[0:4]
            return s or '—'
        def _fmt_qty(v):
            if v is None or v == '':
                return '—'
            try:
                f = float(v)
                s = ('%.3f' % f).rstrip('0').rstrip('.')
                return s if s else '0'
            except Exception:
                return str(v)

        if trs.get('approval_dt'):
            approval_date_str = _fmt_d(str(trs['approval_dt'])[:10])
        elif trs.get('generated_at'):
            approval_date_str = _fmt_d(str(trs['generated_at'])[:10])
        else:
            approval_date_str = _fmt_d(_ist_now_str()[:10])
        today_str = _fmt_d(_ist_now_str()[:10])

        # ── COA capture extras for the template ──
        coa_supplier_passed = bool(trs.get('coa_supplier_passed'))
        coa_verified_by = (trs.get('coa_verified_by') or '').strip()
        coa_deviation = (trs.get('coa_deviation') or '').strip().upper()
        coa_deviation_note = (trs.get('coa_deviation_note') or '').strip()

        # ── Render ──
        try:
            return render_template(
                'qc/qc_coa_print.html',
                trs=trs,
                params=params,
                pass_count=pass_count,
                fail_count=fail_count,
                na_count=na_count,
                is_approved=is_approved,
                approved_by_display=approved_by_display,
                approver_is_placeholder=approver_is_placeholder,
                approval_date_d=approval_date_str,
                today_d=today_str,
                coa_supplier_passed=coa_supplier_passed,
                coa_verified_by=coa_verified_by,
                coa_deviation=coa_deviation,
                coa_deviation_note=coa_deviation_note,
                fmt_d=_fmt_d,
                fmt_qty=_fmt_qty,
            )
        except Exception as e:
            traceback.print_exc()
            tb_text = traceback.format_exc()
            return (f"<h1 style='font-family:sans-serif;padding:40px;color:#b91c1c'>"
                    f"Template render failed</h1>"
                    f"<p style='font-family:sans-serif;padding:0 40px;color:#374151'>"
                    f"<b>{type(e).__name__}:</b> {e}</p>"
                    f"<p style='font-family:sans-serif;padding:0 40px;color:#6b7280;font-size:12px'>"
                    f"If this says <code>TemplateNotFound: qc/qc_coa_print.html</code>, the "
                    f"template file isn't deployed. Place it at "
                    f"<code>templates/qc/qc_coa_print.html</code> and reload.</p>"
                    f"<details style='padding:0 40px;color:#374151'>"
                    f"<summary>Full traceback</summary>"
                    f"<pre style='white-space:pre-wrap;font-family:monospace;font-size:11px'>"
                    f"{tb_text}</pre></details>"), 500

    except Exception as e:
        # Catch-all — anything we didn't think of above.
        traceback.print_exc()
        tb_text = traceback.format_exc()
        return (f"<h1 style='font-family:sans-serif;padding:40px;color:#b91c1c'>"
                f"COA print: unexpected error</h1>"
                f"<p style='font-family:sans-serif;padding:0 40px;color:#374151'>"
                f"<b>{type(e).__name__}:</b> {e}</p>"
                f"<details style='padding:0 40px;color:#374151'>"
                f"<summary>Traceback</summary>"
                f"<pre style='white-space:pre-wrap;font-family:monospace;font-size:11px'>"
                f"{tb_text}</pre></details>"), 500


@qc_bp.route('/qc_sampling')
@_login_required
def qc_sampling_page():
    if not _can_qc_sampling():
        return _denied('QC Sampling')

    conn = sampling_portal.get_db_connection()
    rows = conn.execute(
        "SELECT * FROM qc_sampling_records ORDER BY id DESC"
    ).fetchall()
    conn.close()
    records = [dict(r) for r in rows]
    return render_template('qc/qc_sampling.html',
                           records=records,
                           role=session.get('User_Type'))


# ══════════════════════════════════════════════════════════════════════════════
# IPM QC STATUS — checks list / save / unlock / status_map
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/status_map')
@_login_required
def api_qc_status_map():
    if not _can_prod_dept() and not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute(
            'SELECT production_summary_id, qc_status, approved_by, approval_dt '
            'FROM qc_inprocess_checks'
        ).fetchall()
        conn.close()
        status_map = {
            str(r['production_summary_id']): {
                'qc_status':   r['qc_status']   or 'Pending',
                'approved_by': r['approved_by'] or '',
                'approval_dt': _dt2str(r['approval_dt']) or '',
            } for r in rows
        }
        return jsonify({'status': 'ok', 'map': status_map})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/inprocess_checks')
@_login_required
def api_qc_inprocess_checks():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        rows = [_normalize_row(r) for r in qc_inprocess_get_all()]
        return jsonify({'status': 'ok', 'rows': rows})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/inprocess_check_save', methods=['POST'])
@_login_required
def api_qc_inprocess_check_save():
    """
    Save IPM QC status (Pending / Pass / Fail / Under Review).

    NOTE — the In-Process Approval Form parameter requirement has been
    temporarily disabled. Pass/Fail status saves no longer require a
    qc_inprocess_params row to exist. The parameter form remains fully
    functional and can be filled manually whenever needed.
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403

    d           = request.get_json() or {}
    summary_id  = d.get('production_summary_id')
    qc_status   = (d.get('qc_status') or 'Pending').strip()
    approved_by = (d.get('approved_by') or session.get('UID', '')).strip()
    approval_dt = d.get('approval_dt')
    sample_qty  = (d.get('sample_qty') or '').strip() or None
    drums       = (d.get('drums') or '').strip() or None
    remarks     = (d.get('remarks') or '').strip()

    if not summary_id:
        return jsonify({'status': 'error', 'message': 'Missing production_summary_id'})

    # ── Inprocess Approval Form requirement: DISABLED ────────────────────
    # (Previously: if qc_status in ('Pass','Fail') the qc_inprocess_params
    # row was required to exist with a matching qc_status_at_save value,
    # otherwise the API returned PARAMS_REQUIRED. This gate is currently
    # turned off — status saves go through regardless of form state.)

    # ── 24-hour edit lock (non-admin, non-QC, non-Purchase) ──────────────
    _role = (session.get('User_Type') or '')
    _qc_roles = {'admin', 'QC', 'Purchase', 'qc_common', 'QC_Common'}
    if _role not in _qc_roles:
        conn = sampling_portal.get_db_connection()
        existing = conn.execute(
            "SELECT updated_at, qc_status FROM qc_inprocess_checks "
            "WHERE production_summary_id = %s",
            (summary_id,)
        ).fetchone()
        conn.close()
        if existing and existing['updated_at'] and (existing.get('qc_status') or 'Pending') != 'Pending':
            updated = existing['updated_at']
            if isinstance(updated, str):
                try:
                    updated = datetime.strptime(updated, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    updated = None
            if updated and (datetime.now() - updated) > timedelta(hours=24):
                return jsonify({
                    'status': 'error',
                    'message': 'Locked: this record was last edited over 24 hours ago. Contact admin to unlock.'
                }), 403

    try:
        row_id = qc_inprocess_save(
            production_summary_id = int(summary_id),
            qc_status   = qc_status,
            approved_by = approved_by,
            approval_dt = approval_dt,
            sample_qty  = sample_qty,
            drums       = drums,
            remarks     = remarks,
            created_by  = session.get('UID', ''),
        )
        return jsonify({'status': 'ok', 'id': row_id})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/inprocess_unlock', methods=['POST'])
@_login_required
def api_qc_inprocess_unlock():
    if not _is_admin():
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    d = request.get_json() or {}
    summary_id = d.get('production_summary_id')
    if not summary_id:
        return jsonify({'status': 'error', 'message': 'Missing production_summary_id'})
    try:
        conn = sampling_portal.get_db_connection()
        conn.execute(
            "UPDATE qc_inprocess_checks SET updated_at = NULL "
            "WHERE production_summary_id = %s",
            (int(summary_id),)
        )
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# IPM PARAMETER FORM — get / save / history / suggestion / pdf / whatsapp
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/inprocess_params/<int:summary_id>')
@_login_required
def api_qc_inprocess_params_get(summary_id):
    """Return current params + history for a given IPM batch."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        current = qc_params_get(summary_id)
        history = qc_params_history(summary_id)
        return jsonify({
            'status':  'ok',
            'current': _normalize_row(current) if current else None,
            'history': [_normalize_row(h) for h in history],
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/inprocess_params_suggest')
@_login_required
def api_qc_inprocess_params_suggest():
    """Auto-fetch last 3 Approved batches (same product code) as suggestions."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    product_code = (request.args.get('product_code') or '').strip()
    try:
        exclude = request.args.get('exclude_id', type=int)
    except Exception:
        exclude = None
    try:
        last3 = qc_params_last3_suggestion(product_code, exclude_summary_id=exclude)
        # Pad to 3 entries
        while len(last3) < 3:
            last3.append({'batch_date': '', 'viscosity': '', 'ph': '', 'foam': ''})
        return jsonify({'status': 'ok', 'last3': last3})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/inprocess_params_save', methods=['POST'])
@_login_required
def api_qc_inprocess_params_save():
    """
    Save the Inprocess Approval Form parameters.

    Validation:
      - production_summary_id required
      - new_status must be one of 'Pass', 'Fail', 'Under Review'
      - If an existing param row's qc_status_at_save differs from new_status,
        change_reason is COMPULSORY (frontend should also enforce this).
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403

    d = request.get_json() or {}
    summary_id = d.get('production_summary_id')
    new_status = (d.get('qc_status') or '').strip()

    if not summary_id:
        return jsonify({'status': 'error', 'message': 'Missing production_summary_id'})
    if new_status not in ('Pass', 'Fail', 'Under Review'):
        return jsonify({'status': 'error',
                        'message': 'Status must be Pass, Fail, or Under Review'})

    payload = {c: d.get(c) for c in _PARAM_COLUMNS}

    # Server-side enforcement of change_reason on status flips
    existing = qc_params_get(int(summary_id))
    if existing:
        prev_status = (existing.get('qc_status_at_save') or '').strip()
        if prev_status and prev_status != new_status:
            if not (payload.get('change_reason') or '').strip():
                return jsonify({
                    'status': 'error',
                    'code':   'CHANGE_REASON_REQUIRED',
                    'message': f'A reason is required when changing status '
                               f'from "{prev_status}" to "{new_status}".'
                }), 400

    try:
        row_id, archived = qc_params_save(
            production_summary_id = int(summary_id),
            new_status            = new_status,
            payload               = payload,
            saved_by              = session.get('UID', ''),
        )
        return jsonify({'status': 'ok', 'id': row_id, 'archived': archived})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ─── PDF generation ───────────────────────────────────────────────────────────

def _draw_inprocess_pdf(buf, params, summary_row=None):
    """
    Render the Inprocess Approval Form (QR-860-06 R-00) as a single-page A4 PDF
    using reportlab. Mirrors the official format.

    params      — dict of column->value (from qc_inprocess_params)
    summary_row — optional dict from production_summary (fallback values)
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.pdfgen import canvas
    from reportlab.lib.units import mm

    W, H = A4
    c = canvas.Canvas(buf, pagesize=A4)

    def g(k, fallback=''):
        v = (params or {}).get(k)
        if v is None or v == '':
            v = (summary_row or {}).get(k, fallback)
        return '' if v is None else str(v)

    def gd(k, fallback=''):
        """Like g(), but formats ISO date strings as DD-MM-YYYY for display."""
        s = g(k, fallback)
        if not s:
            return ''
        # Match 'YYYY-MM-DD' at the start (with optional time component)
        import re as _re
        m = _re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
        if m:
            return f'{m.group(3)}-{m.group(2)}-{m.group(1)}'
        return s

    # ── Header band ──────────────────────────────────────────────────────
    margin = 12 * mm
    y = H - margin

    # Logo placeholder (left)
    c.setFillColor(colors.HexColor('#1f2937'))
    c.setFont('Helvetica-Bold', 9)
    c.drawString(margin, y - 4, 'HCP')
    c.setFont('Helvetica', 6)
    c.drawString(margin, y - 12, 'HCP WELLNESS PVT. LTD.')

    # Centre title
    c.setFillColor(colors.black)
    c.setFont('Helvetica-Bold', 14)
    c.drawCentredString(W / 2, y - 6, 'INPROCESS APPROVAL FORM')

    # Right: doc code
    c.setFont('Helvetica-Bold', 9)
    c.drawRightString(W - margin, y - 4, 'QR-860-06    R-00')

    y -= 22 * mm

    # ── Table grid ───────────────────────────────────────────────────────
    table_x = margin
    table_w = W - 2 * margin
    col1_w  = 70 * mm                       # left label column
    col2_w  = table_w - col1_w              # right value column
    row_h   = 7 * mm

    def line(y_):
        c.setStrokeColor(colors.black)
        c.setLineWidth(0.6)
        c.line(table_x, y_, table_x + table_w, y_)

    def vline(x_, y1, y2):
        c.setStrokeColor(colors.black)
        c.setLineWidth(0.6)
        c.line(x_, y1, x_, y2)

    def cell_label(text, x_, y_, w, h, bold=True, fill=None):
        if fill:
            c.setFillColor(fill)
            c.rect(x_, y_ - h, w, h, stroke=0, fill=1)
            c.setFillColor(colors.black)
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 8)
        c.drawString(x_ + 2 * mm, y_ - h + 2.2 * mm, text)

    def cell_value(text, x_, y_, w, h, bold=False, align='left'):
        c.setFillColor(colors.black)
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 8.5)
        tx = x_ + 2 * mm
        if align == 'center':
            c.drawCentredString(x_ + w / 2, y_ - h + 2.2 * mm, text)
        elif align == 'right':
            c.drawRightString(x_ + w - 2 * mm, y_ - h + 2.2 * mm, text)
        else:
            # naive truncation to keep within column
            max_chars = max(8, int(w / 1.6 / mm))
            shown = text if len(text) <= max_chars else text[:max_chars - 1] + '…'
            c.drawString(tx, y_ - h + 2.2 * mm, shown)

    # Helper: draw a 2-column row (label + value)
    def row_2col(label, value, y_, h=row_h, fill=None):
        # outer border
        c.rect(table_x, y_ - h, table_w, h, stroke=1, fill=0)
        vline(table_x + col1_w, y_ - h, y_)
        cell_label(label, table_x, y_, col1_w, h, fill=fill)
        cell_value(value, table_x + col1_w, y_, col2_w, h)
        return y_ - h

    # Section header (full-width tinted band)
    def section_band(label, y_, h=6 * mm):
        c.setFillColor(colors.HexColor('#e5e7eb'))
        c.rect(table_x, y_ - h, table_w, h, stroke=1, fill=1)
        c.setFillColor(colors.black)
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(table_x + 2 * mm, y_ - h + 1.8 * mm, label)
        return y_ - h

    # ── Batch Date / Received By split row ───────────────────────────────
    # Like the form: label | value | label | value (4-col)
    def row_4col(l1, v1, l2, v2, y_, h=row_h):
        c.rect(table_x, y_ - h, table_w, h, stroke=1, fill=0)
        third = table_w / 4
        vline(table_x + third * 1, y_ - h, y_)
        vline(table_x + third * 2, y_ - h, y_)
        vline(table_x + third * 3, y_ - h, y_)
        cell_label(l1, table_x + 0 * third, y_, third, h)
        cell_value(v1, table_x + 1 * third, y_, third, h)
        cell_label(l2, table_x + 2 * third, y_, third, h)
        cell_value(v2, table_x + 3 * third, y_, third, h)
        return y_ - h

    # Rows
    y = row_4col('BATCH DATE :', gd('batch_date'), 'RECEIVED BY:', g('received_by'), y)
    y = row_4col('BATCH NO.:',   g('batch_no'),  'BATCH SIZE:',  g('batch_size'),   y)

    # Product name — full-width split (label/value as full row)
    h = row_h
    c.rect(table_x, y - h, table_w, h, stroke=1, fill=0)
    vline(table_x + col1_w, y - h, y)
    cell_label('PRODUCT NAME:', table_x, y, col1_w, h)
    cell_value(g('product_name'), table_x + col1_w, y, col2_w, h, bold=True)
    y -= h

    y = section_band('ANALYTICAL PARAMETERS:', y)

    y = row_2col('APPEARANCE',        g('appearance'),       y)
    y = row_2col('ODOUR',             g('odour'),            y)

    # pH — two sub-rows (value, then limit)
    ph_temp = g('ph_temp')
    ph_label = f'PH (25\u00b12\u00b0C at {ph_temp}\u00b0C)' if ph_temp else 'PH (25\u00b12\u00b0C at ___\u00b0C)'
    y = row_2col(ph_label, g('ph_value'),  y)
    y = row_2col('   LIMIT:', g('ph_limit'), y)

    # Viscosity — sub-rows (CPs, Spindle, RPM, Torque, Limit)
    vt = g('viscosity_temp')
    visc_label = f'VISCOSITY (25\u00b12\u00b0C at {vt}\u00b0C)' if vt else 'VISCOSITY (25\u00b12\u00b0C at ___\u00b0C)'
    y = row_2col(visc_label,        '',                          y, fill=colors.HexColor('#f3f4f6'))
    y = row_2col('   CPs:',         g('viscosity_cps'),          y)
    y = row_2col('   SPINDLE:',     g('viscosity_spindle'),      y)
    y = row_2col('   RPM:',         g('viscosity_rpm'),          y)
    y = row_2col('   TORQUE:',      g('viscosity_torque') + (' %' if g('viscosity_torque') else ''), y)
    y = row_2col('   LIMIT:',       g('viscosity_limit'),        y)

    # Specific Gravity / Foam Height — show "value (min To max)"
    sg_min, sg_max, sg_v = g('specific_gravity_min'), g('specific_gravity_max'), g('specific_gravity_value')
    sg_disp = sg_v + (f'    ( {sg_min} To {sg_max} )' if (sg_min or sg_max) else '')
    y = row_2col('SPECIFIC GRAVITY/(Wt./ML)', sg_disp, y)

    fh_min, fh_max, fh_v = g('foam_height_min'), g('foam_height_max'), g('foam_height_value')
    fh_disp = fh_v + (f'    ( {fh_min} To {fh_max} )' if (fh_min or fh_max) else '')
    y = row_2col('FOAM HEIGHT (ML)', fh_disp, y)

    y = row_2col('REFRACTIVE INDEX',                g('refractive_index'), y)
    y = row_2col('WEIGHT CHECK IN FINAL JAR/TUBE/BOTTLE/POUCH :',
                 g('weight_check'),                                          y, h=row_h)
    y = row_2col('BATCH INCHARGE:',                 g('batch_incharge'),    y)
    y = row_2col('ANALYZED BY:',                    g('analyzed_by'),       y)
    y = row_2col('AUTHORISED PERSON:',              g('authorised_person'), y)

    # ── LAST 3 BATCH RESULTS table ───────────────────────────────────────
    y = section_band('LAST 3 BATCH RESULTS', y)

    # 4-column table: label | b1 | b2 | b3
    last3_h = row_h
    third = table_w / 4
    def last3_row(label, v1, v2, v3, y_, h=last3_h):
        c.rect(table_x, y_ - h, table_w, h, stroke=1, fill=0)
        for i in range(1, 4):
            vline(table_x + third * i, y_ - h, y_)
        cell_label(label, table_x + 0 * third, y_, third, h)
        cell_value(v1, table_x + 1 * third, y_, third, h, align='center')
        cell_value(v2, table_x + 2 * third, y_, third, h, align='center')
        cell_value(v3, table_x + 3 * third, y_, third, h, align='center')
        return y_ - h

    y = last3_row('Batch Date',  gd('last3_b1_date'), gd('last3_b2_date'), gd('last3_b3_date'), y)
    y = last3_row('VISCOSITY (25\u00b12\u00b0C at ___\u00b0C)',
                  g('last3_b1_visc'), g('last3_b2_visc'), g('last3_b3_visc'), y)
    y = last3_row('PH (25\u00b12\u00b0C at ___\u00b0C)',
                  g('last3_b1_ph'), g('last3_b2_ph'), g('last3_b3_ph'), y)
    y = last3_row('FOAM HEIGHT (ML)',
                  g('last3_b1_foam'), g('last3_b2_foam'), g('last3_b3_foam'), y)

    # ── Change reason (only printed if present) ──────────────────────────
    cr = g('change_reason')
    if cr:
        y -= 4 * mm
        c.setFont('Helvetica-Bold', 8)
        c.setFillColor(colors.HexColor('#b91c1c'))
        c.drawString(table_x, y, 'Change Reason:')
        c.setFillColor(colors.black)
        c.setFont('Helvetica', 8)
        # wrap simple line break — split at ~110 chars
        line_y = y - 4 * mm
        max_chars = 110
        for chunk_start in range(0, len(cr), max_chars):
            c.drawString(table_x, line_y, cr[chunk_start:chunk_start + max_chars])
            line_y -= 3.5 * mm
        y = line_y

    # ── Footer ───────────────────────────────────────────────────────────
    c.setFont('Helvetica', 7)
    c.setFillColor(colors.HexColor('#6b7280'))
    c.drawCentredString(W / 2, 10 * mm,
                        f'Page 1 of 1   |   Generated: {_ist_now_dmy()} IST   |   By: {session.get("UID", "")}')

    c.showPage()
    c.save()


@qc_bp.route('/api/qc/inprocess_params_pdf/<int:summary_id>')
@_login_required
def api_qc_inprocess_params_pdf(summary_id):
    """Stream the Inprocess Approval Form as a PDF for view / download."""
    if not _can_qc_dashboard():
        return _denied('QC Dashboard')
    try:
        params = qc_params_get(summary_id) or {}

        # Pull production_summary fallback values (batch_size, product_name, etc.)
        summary_row = None
        try:
            conn = sampling_portal.get_db_connection()
            sr = conn.execute(
                "SELECT * FROM production_summary WHERE id = %s", (summary_id,)
            ).fetchone()
            conn.close()
            if sr:
                summary_row = dict(sr)
                # Map production_summary fields → form fields for fallback
                summary_row.setdefault('product_name', summary_row.get('batch_name'))
                summary_row.setdefault('batch_size',   summary_row.get('batch_size'))
                bd = summary_row.get('completed_at') or summary_row.get('processing_datetime')
                if bd:
                    summary_row['batch_date'] = _dt2str(bd)[:10] if _dt2str(bd) else ''
        except Exception:
            pass

        buf = io.BytesIO()
        _draw_inprocess_pdf(buf, params, summary_row)
        buf.seek(0)
        filename = f'InProcess_Approval_{summary_id}.pdf'
        download = request.args.get('download') == '1'
        return send_file(
            buf,
            mimetype='application/pdf',
            as_attachment=download,
            download_name=filename,
        )
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# QC SAMPLING — list / save (proxy)
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc_sampling/list')
@_login_required
def api_qc_sampling_list():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute(
            "SELECT * FROM qc_sampling_records ORDER BY id DESC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok',
                        'rows': [_normalize_row(dict(r)) for r in rows]})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc_sampling/save', methods=['POST'])
@_login_required
def api_qc_sampling_save():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    role = session.get('User_Type', '')
    d = request.get_json() or {}
    try:
        sampling_portal.save_qc_sampling(d, role, session.get('UID', ''))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# PRODUCTION SUMMARY (proxy for QC dashboard date-range filter)
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/production_summary_all')
@_login_required
def api_qc_production_summary_all():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    role = session.get('User_Type', '')
    from_date = request.args.get('from', '')
    to_date   = request.args.get('to', '')
    if (role or '').lower() == 'qc_common':
        from_date = '2026-03-16'
    try:
        rows = sampling_portal.prod_dept_summary_all(from_date, to_date)
        rows = [_normalize_row(r) for r in rows]
        return jsonify({'status': 'ok', 'rows': rows})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# LABEL PRINTING — TSPL direct-to-printer (TSC 244)
# ══════════════════════════════════════════════════════════════════════════════
#
# CONFIGURATION — edit these to match your setup:
#   PRINTER_MODE   = 'tcp'          # 'tcp' for network, 'usb' for win32print
#   PRINTER_HOST   = '192.168.1.x'  # IP of TSC 244 (network mode only)
#   PRINTER_NAME   = 'TSC TDP-244'  # Windows printer name (USB mode only)

PRINTER_MODE = 'tcp'
PRINTER_HOST = '192.168.1.100'
PRINTER_PORT = 9100
PRINTER_NAME = 'TSC TDP-244'


def _build_tspl(data: dict) -> bytes:
    """Build TSPL command bytes for a 100×50 mm label (one page per drum)."""

    def tf(s, maxlen=30):
        s = str(s or '—').replace('"', "'").replace('\\', '/')
        return s[:maxlen]

    batch_name   = tf(data.get('batch_name', '—'),          32)
    trs_no       = tf(data.get('trs_no', '—'),               20)
    trs_date     = tf(data.get('trs_date', '—'),             16)
    batch_size   = tf(str(data.get('batch_size') or '—') + ' Kg', 12)
    batch_date   = tf(data.get('batch_date', '—'),           16)
    incharge     = tf(data.get('operator_name', '—'),        18)
    sampling_dt  = tf(data.get('sampling_date', '—'),        16)
    approval_dt  = tf(data.get('approval_dt', '—'),          20)
    sample_qty   = tf(data.get('sample_qty', '—'),           14)
    approved_by  = tf(data.get('approved_by', '—'),          18)
    qc_status    = (data.get('qc_status') or 'Pending').strip()
    total_drums  = max(1, int(data.get('total_drums') or 1))

    status_labels = {
        'Pass':         'QC - APPROVED',
        'Fail':         'QC - REJECTED',
        'Under Review': 'QC - UNDER REVIEW',
        'Pending':      'QC - PENDING',
    }
    status_label = status_labels.get(qc_status, 'QC - PENDING')

    W = 800
    H = 400
    lines = []
    for drum_num in range(1, total_drums + 1):
        drum_str = f'Drum {drum_num} of {total_drums}'
        lines += [
            'SIZE 100 mm, 50 mm',
            'GAP 3 mm, 0 mm',
            'DIRECTION 1',
            'REFERENCE 0,0',
            'OFFSET 0 mm',
            'SPEED 4',
            'DENSITY 10',
            'SET TEAR ON',
            'CLS',
            f'BAR 0,0,{W},56',
            f'REVERSE 0,0,{W},56',
            f'TEXT 400,8,"ARIAL.TTF",0,12,12,"{status_label}"',
            f'BOX 0,56,{W},108,2',
            f'TEXT 400,62,"ARIAL.TTF",0,10,10,"{batch_name}"',
            f'TEXT 4,116,"ARIAL.TTF",0,6,6,"TRS No :"',
            f'TEXT 180,116,"ARIAL.TTF",0,8,8,"{trs_no}"',
            f'TEXT 404,116,"ARIAL.TTF",0,6,6,"TRS Date :"',
            f'TEXT 580,116,"ARIAL.TTF",0,8,8,"{trs_date}"',
            f'TEXT 4,160,"ARIAL.TTF",0,6,6,"Batch No :"',
            f'TEXT 180,160,"ARIAL.TTF",0,8,8,"-"',
            f'TEXT 404,160,"ARIAL.TTF",0,6,6,"Batch Size :"',
            f'TEXT 580,160,"ARIAL.TTF",0,8,8,"{batch_size}"',
            f'TEXT 4,204,"ARIAL.TTF",0,6,6,"Batch Date :"',
            f'TEXT 180,204,"ARIAL.TTF",0,8,8,"{batch_date}"',
            f'TEXT 404,204,"ARIAL.TTF",0,6,6,"Incharge :"',
            f'TEXT 580,204,"ARIAL.TTF",0,8,8,"{incharge}"',
            f'TEXT 4,248,"ARIAL.TTF",0,6,6,"Sampling :"',
            f'TEXT 180,248,"ARIAL.TTF",0,8,8,"{sampling_dt}"',
            f'TEXT 404,248,"ARIAL.TTF",0,6,6,"Approval :"',
            f'TEXT 580,248,"ARIAL.TTF",0,8,8,"{approval_dt}"',
            f'TEXT 4,292,"ARIAL.TTF",0,6,6,"Sample Qty :"',
            f'TEXT 180,292,"ARIAL.TTF",0,8,8,"{sample_qty}"',
            f'TEXT 404,292,"ARIAL.TTF",0,6,6,"Approved By :"',
            f'TEXT 580,292,"ARIAL.TTF",0,8,8,"{approved_by}"',
            f'TEXT 4,336,"ARIAL.TTF",0,6,6,"No. of Drums :"',
            f'TEXT 400,330,"ARIAL.TTF",0,14,14,"{drum_str}"',
            f'LINE 0,108,{W},108,2',
            f'LINE 0,152,{W},152,2',
            f'LINE 0,196,{W},196,2',
            f'LINE 0,240,{W},240,2',
            f'LINE 0,284,{W},284,2',
            f'LINE 0,328,{W},328,2',
            f'LINE 400,108,400,{H},2',
            f'BOX 0,0,{W},{H},4',
            'PRINT 1,1',
        ]
    return ('\r\n'.join(lines) + '\r\n').encode('ascii', errors='replace')


def _send_tspl_tcp(tspl_bytes: bytes) -> None:
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(8)
    sock.connect((PRINTER_HOST, PRINTER_PORT))
    try:
        sock.sendall(tspl_bytes)
    finally:
        sock.close()


def _send_tspl_usb(tspl_bytes: bytes) -> None:
    import win32print
    hprinter = win32print.OpenPrinter(PRINTER_NAME)
    try:
        win32print.StartDocPrinter(hprinter, 1, ('QC Label', None, 'RAW'))
        win32print.StartPagePrinter(hprinter)
        win32print.WritePrinter(hprinter, tspl_bytes)
        win32print.EndPagePrinter(hprinter)
        win32print.EndDocPrinter(hprinter)
    finally:
        win32print.ClosePrinter(hprinter)


@qc_bp.route('/api/qc/print_label', methods=['POST'])
@_login_required
def api_qc_print_label():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    data = request.get_json() or {}
    if not data.get('batch_name'):
        return jsonify({'status': 'error', 'message': 'Missing label data'}), 400
    try:
        tspl = _build_tspl(data)
        if PRINTER_MODE == 'tcp':
            _send_tspl_tcp(tspl)
        elif PRINTER_MODE == 'usb':
            _send_tspl_usb(tspl)
        else:
            return jsonify({'status': 'error',
                            'message': f'Unknown PRINTER_MODE: {PRINTER_MODE}'}), 500
        drums = int(data.get('total_drums') or 1)
        return jsonify({'status': 'ok',
                        'message': f'{drums} label(s) sent to printer'})
    except ConnectionRefusedError:
        return jsonify({'status': 'error',
                        'message': f'Cannot reach printer at {PRINTER_HOST}:{PRINTER_PORT} — check IP and network cable'}), 503
    except OSError as e:
        return jsonify({'status': 'error',
                        'message': f'Printer connection error: {e}'}), 503
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# RM TRS — Testing Requisition Slips generated from Inventory/GRN
# ──────────────────────────────────────────────────────────────────────────────
# The Inventory module owns the procurement_grn_trs table (created at app start
# by inventory_mgmt.py's bootstrap). This blueprint exposes two QC-side
# endpoints so the QC Dashboard can:
#   • List all generated TRS slips with their approval status (the new
#     "RM TRS" tab — third tab next to IPM and Purchase Samples).
#   • Approve / Reject a slip (writes back to procurement_grn_trs).
#
# IST timestamps: the dashboard expects datetimes formatted as
# "YYYY-MM-DD HH:MM:SS" in IST. We rebuild the value here using _ist_now_str()
# so the timestamp reflects when the QC user actually clicked Approve, in IST,
# regardless of the server's OS timezone.
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/trs/list')
@_login_required
def api_qc_trs_list():
    """Return every TRS row from procurement_grn_trs in the shape the QC
    dashboard tab needs. Cap at 1000 rows to keep the grid snappy — the
    frontend has filters for narrowing further. Order: newest first by
    generated_at, then by id desc (stable secondary sort)."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        try:
            # Tolerate the case where the inventory module hasn't booted
            # yet (table missing) — return an empty list with a hint
            # rather than 500ing the whole dashboard load.
            try:
                rows = conn.execute("""
                    SELECT id, trs_num, grn_id, grn_item_id,
                           grn_num, grn_date,
                           material, batch_num,
                           packages, qty_per_pkg, total_qty, uom,
                           manufacturer, mfg_date, expiry_date,
                           supplier_name, physical_state, sample_qty,
                           previous_supplier, new_or_old,
                           generated_by, generated_at, verified_by,
                           approval_status, approved_by, approval_dt,
                           approval_remarks, approval_locked_at,
                           checked_params, rejection_reason,
                           unlock_requested_at, unlock_requested_by,
                           coa_verified_by, coa_supplier_passed,
                           coa_deviation, coa_deviation_note
                    FROM procurement_grn_trs
                    ORDER BY generated_at DESC, id DESC
                    LIMIT 1000
                """).fetchall() or []
            except Exception as table_e:
                msg = str(table_e).lower()
                if 'procurement_grn_trs' in msg and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg):
                    return jsonify({'status': 'ok', 'trs': [],
                                    'note': 'TRS table not yet bootstrapped'})
                raise
            out = []
            # Compute "now" once (IST) so the locked-flag math is
            # consistent across the whole response.
            try:
                from datetime import datetime as _dt, timedelta as _td
                now_ist_dt = _dt.strptime(_ist_now_str(), '%Y-%m-%d %H:%M:%S')
            except Exception:
                now_ist_dt = None
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                # Datetime + date normalization
                for k in ('generated_at', 'approval_dt', 'approval_locked_at',
                          'unlock_requested_at'):
                    d[k] = _dt2str(d.get(k))
                for k in ('grn_date', 'mfg_date', 'expiry_date'):
                    if d.get(k):
                        try:
                            d[k] = d[k].isoformat()
                        except Exception:
                            d[k] = str(d[k])
                # Numeric coercion so JSON.stringify produces plain numbers
                # (the grid does its own toFixed for display).
                for k in ('qty_per_pkg', 'total_qty', 'sample_qty'):
                    if d.get(k) is not None:
                        try: d[k] = float(d[k])
                        except Exception: pass
                # Parse checked_params JSON → list (frontend wants an array).
                cp = d.get('checked_params')
                if cp:
                    try:
                        import json as _json
                        parsed = _json.loads(cp)
                        if isinstance(parsed, list):
                            d['checked_params'] = parsed
                        else:
                            d['checked_params'] = [str(parsed)]
                    except Exception:
                        # Fall back to splitting on common separators
                        d['checked_params'] = [s.strip() for s in
                                               str(cp).replace(';', ',').split(',')
                                               if s.strip()]
                else:
                    d['checked_params'] = []
                # Locked flag = has a lock timestamp AND it's older than
                # 24h. The frontend uses this to grey out the action
                # buttons. The server still enforces independently.
                locked_at_str = d.get('approval_locked_at')
                d['is_locked'] = False
                d['hours_remaining'] = None
                if locked_at_str and now_ist_dt:
                    try:
                        from datetime import datetime as _dt3
                        lk = _dt3.strptime(locked_at_str[:19], '%Y-%m-%d %H:%M:%S')
                        diff = now_ist_dt - lk
                        hrs_used = diff.total_seconds() / 3600.0
                        d['is_locked'] = hrs_used >= 24.0
                        d['hours_remaining'] = max(0.0, 24.0 - hrs_used)
                    except Exception:
                        pass
                # Edit-access request flag. A QC user who hits a locked
                # TRS can request edit access; the admin grants it. We
                # only treat the request as "pending" while the row is
                # still locked — granting access clears the lock and the
                # request together, and a fresh lock doesn't carry an old
                # request forward (grant always clears it).
                d['unlock_requested'] = bool(
                    d.get('unlock_requested_at') and d.get('is_locked')
                )
                # COA capture extras → coerce supplier-passed flag to bool.
                d['coa_supplier_passed'] = bool(d.get('coa_supplier_passed'))
                # "New Supplier (if any)" is the current GRN supplier when
                # the operator flagged the material as NEW. Precompute it
                # here so the frontend doesn't have to know the rule.
                d['new_supplier'] = d.get('supplier_name') if d.get('new_or_old') == 'NEW' else None
                # Default missing approval_status (legacy rows pre-migration)
                if not d.get('approval_status'):
                    d['approval_status'] = 'Pending'
                out.append(d)
            return jsonify({'status': 'ok', 'trs': out})
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/trs/approve', methods=['POST'])
@_login_required
def api_qc_trs_approve():
    """Set approval_status on a TRS row.

    Body:
        {
          "id":               int,
          "status":           "Approved"|"Rejected"|"Pending"|"Under Review",
          "remarks":          str (optional),
          "checked_params":   list[str] (optional — used for rejection notes),
          "rejection_reason": str (optional — long-form rejection reason)
        }

    The approval_dt is stamped from the SERVER in IST every time the
    status changes. The FIRST transition out of Pending also stamps
    approval_locked_at — once that is set, the row can still be edited
    for 24 hours but is locked thereafter (server returns 423 Locked).

    If status flips BACK to Pending, the lock is NOT cleared — the lock
    clock starts at the first non-Pending decision and runs forward
    regardless of subsequent toggles. This prevents games like
    "Approve → Pending → Approve again" to reset the 24h editability.

    Permission: requires _can_qc_dashboard (QC role, or page:qc_dashboard
    permission). The inventory module's _grn_save_required does NOT apply
    here — QC approval is intentionally separated from GRN authorship.
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json(silent=True) or {}
    try:
        trs_id = int(d.get('id') or 0)
    except Exception:
        trs_id = 0
    status_in = (d.get('status') or '').strip()
    ALLOWED = ('Pending', 'Approved', 'Rejected', 'Under Review')
    if not trs_id or status_in not in ALLOWED:
        return jsonify({'status': 'error',
                        'message': f"id and status (one of {ALLOWED}) required"}), 400

    remarks = (d.get('remarks') or '').strip() or None

    # checked_params handling. Two shapes are accepted:
    #   1. List of strings → simple parameter names (legacy, still ok)
    #   2. List of dicts  → full structured rows from the new
    #      Checked Parameters modal: {name, unit, spec_type, spec_from,
    #      spec_to, spec_target, observed, passed, note}.
    # Either way we JSON-encode and store in the TEXT column. The
    # /list endpoint parses it back to a list on the way out.
    cp_raw = d.get('checked_params')
    import json as _json
    cp_clean = []   # Always defined; the post-commit per-item save uses it.
    if isinstance(cp_raw, list):
        seen_names = set()
        for item in cp_raw:
            if isinstance(item, dict):
                # Structured row — keep as object, dedupe by name+spec_type
                nm = str(item.get('name') or '').strip()
                if not nm: continue
                key = nm.lower() + '|' + str(item.get('spec_type') or '')
                if key in seen_names: continue
                seen_names.add(key)
                # Normalise the row so we know exactly what's stored.
                cp_clean.append({
                    'name':        nm,
                    'unit':        (item.get('unit') or '') or None,
                    'method':      (item.get('method') or '') or None,
                    'spec_type':   item.get('spec_type') or 'range',
                    'spec_from':   item.get('spec_from')   if item.get('spec_from') not in ('', None) else None,
                    'spec_to':     item.get('spec_to')     if item.get('spec_to')   not in ('', None) else None,
                    'spec_target': item.get('spec_target') if item.get('spec_target') not in ('', None) else None,
                    'observed':    item.get('observed')    if item.get('observed')  not in ('', None) else None,
                    'passed':      bool(item.get('passed')) if item.get('passed') is not None else None,
                    'note':        item.get('note') or None,
                })
            else:
                # Simple string entry — strip + dedupe.
                s = str(item).strip()
                if s and s.lower() not in seen_names:
                    seen_names.add(s.lower())
                    cp_clean.append(s)
        checked_params_str = _json.dumps(cp_clean, ensure_ascii=False) if cp_clean else None
    elif isinstance(cp_raw, str) and cp_raw.strip():
        # Already a JSON string — pass through. We accept it so admins
        # can repair a row from a saved JSON dump.
        checked_params_str = cp_raw.strip()
    else:
        checked_params_str = None
    rejection_reason = (d.get('rejection_reason') or '').strip() or None

    # ── COA capture extras (item 2-5) ────────────────────────────────
    # All optional; absent keys leave the existing DB value untouched
    # (we COALESCE on write). The frontend sends these from the
    # Checked Parameters modal.
    coa_verified_by = d.get('verified_by')
    coa_verified_by = (str(coa_verified_by).strip() or None) if coa_verified_by is not None else None
    # Supplier-COA "all passed" tick. Stored as 0/1.
    _sp = d.get('coa_supplier_passed')
    coa_supplier_passed = None if _sp is None else (1 if bool(_sp) else 0)
    # Deviation observed — normalise to 'YES'/'NO'/None.
    _dev = d.get('deviation_observed')
    if _dev is None:
        coa_deviation = None
    else:
        coa_deviation = 'YES' if str(_dev).strip().upper() in ('YES', 'Y', 'TRUE', '1') else 'NO'
    coa_deviation_note = d.get('deviation_note')
    coa_deviation_note = (str(coa_deviation_note).strip() or None) if coa_deviation_note is not None else None
    # If deviation is explicitly NO, blank any stale note so the print
    # doesn't show an orphaned deviation description.
    if coa_deviation == 'NO':
        coa_deviation_note = None

    # Approver attribution — we must NEVER credit an admin / system /
    # developer-test session as the actual QC approver. The certificate
    # of analysis is a regulated record naming the QC engineer who
    # decided the material's fate. If an admin clicks Approve (e.g. to
    # test the system or to push a stuck row through), we keep whatever
    # `approved_by` was previously stamped. If nothing was previously
    # stamped, we fall back to a neutral placeholder ("QC Engineer")
    # rather than writing the admin's name into the audit trail.
    session_user = session.get('User_Name') or session.get('UID') or 'Unknown'
    SYSTEM_USERS = {'admin', 'system administrator', 'system', 'root',
                    'developer', 'developer test', 'sysadmin'}
    is_system_caller = (
        _is_admin() or
        str(session_user or '').strip().lower() in SYSTEM_USERS
    )
    approval_dt = _ist_now_str()

    try:
        conn = sampling_portal.get_db_connection()
        try:
            existing = conn.execute(
                "SELECT id, approval_status, approval_locked_at, material, "
                "       approved_by AS prior_approved_by "
                "FROM procurement_grn_trs WHERE id=%s",
                (trs_id,)
            ).fetchone()
            if not existing:
                return jsonify({'status': 'error', 'message': 'TRS not found'}), 404
            ex_d = dict(existing) if hasattr(existing, 'keys') else existing
            locked_at = ex_d.get('approval_locked_at')
            trs_material = (ex_d.get('material') or '').strip()
            prior_approved_by = (ex_d.get('prior_approved_by') or '').strip()

            # Resolve the final approver name. Rules:
            #   1. Admin / system / developer-test caller → keep prior
            #      value if it was set by a real QC user; else use the
            #      neutral placeholder "QC Engineer (pending assignment)".
            #   2. Real QC user → their session name wins.
            #   3. If the prior value WAS a system user (e.g. data was
            #      previously stamped by an admin during testing), let
            #      a real QC user overwrite it.
            prior_is_system = str(prior_approved_by or '').strip().lower() in SYSTEM_USERS
            if is_system_caller:
                if prior_approved_by and not prior_is_system:
                    approved_by = prior_approved_by   # keep the real QC name
                else:
                    approved_by = 'QC Engineer (pending assignment)'
            else:
                approved_by = session_user            # real QC user — credit them

            # Lock check: if the row already had a non-Pending decision
            # and that decision is older than 24 hours, reject. Admins
            # can override by passing { "force": true } but we don't
            # surface that in the UI.
            force = bool(d.get('force'))
            if locked_at and not force:
                try:
                    # locked_at may be a datetime or string; normalise
                    if isinstance(locked_at, str):
                        from datetime import datetime as _dt
                        # MySQL returns 'YYYY-MM-DD HH:MM:SS'
                        locked_dt = _dt.strptime(locked_at[:19], '%Y-%m-%d %H:%M:%S')
                    else:
                        locked_dt = locked_at
                    from datetime import datetime as _dt2, timedelta as _td
                    # Compare in IST: the locked_at was stamped via
                    # _ist_now_str() so it's already in IST.
                    now_ist_str = _ist_now_str()
                    now_ist = _dt2.strptime(now_ist_str, '%Y-%m-%d %H:%M:%S')
                    if (now_ist - locked_dt) > _td(hours=24):
                        # Locked — but allow admins to still set Pending→ N/A
                        if not _is_admin():
                            return jsonify({
                                'status':       'locked',
                                'message':      ('This TRS was decided more than 24 hours ago '
                                                 'and is now locked. Contact an admin to override.'),
                                'locked_at':    str(locked_at)[:19],
                            }), 423
                except Exception:
                    # If timestamp math fails for any reason, fail open
                    # (don't accidentally lock the user out due to a
                    # parse bug). Log so we notice.
                    import traceback; traceback.print_exc()

            # Decide whether to stamp the lock on this call. We stamp it
            # the FIRST time the row leaves Pending and never overwrite
            # afterwards.
            stamp_lock = (not locked_at) and (status_in != 'Pending')
            new_lock_clause = ", approval_locked_at=%s" if stamp_lock else ""
            params = [status_in, approved_by, approval_dt, remarks,
                      checked_params_str, rejection_reason,
                      coa_verified_by, coa_supplier_passed,
                      coa_deviation, coa_deviation_note]
            if stamp_lock:
                params.append(approval_dt)
            params.append(trs_id)

            conn.execute(f"""
                UPDATE procurement_grn_trs
                SET approval_status=%s,
                    approved_by=%s,
                    approval_dt=%s,
                    approval_remarks=COALESCE(%s, approval_remarks),
                    checked_params=COALESCE(%s, checked_params),
                    rejection_reason=COALESCE(%s, rejection_reason),
                    coa_verified_by=COALESCE(%s, coa_verified_by),
                    coa_supplier_passed=COALESCE(%s, coa_supplier_passed),
                    coa_deviation=COALESCE(%s, coa_deviation),
                    coa_deviation_note=%s
                    {new_lock_clause}
                WHERE id=%s
            """, params)
            conn.commit()

            # ── Diagnostic: verify the save actually persisted. We've
            # had reports of checked_params appearing empty on re-open.
            # Read the row back IN THIS CONNECTION and log a summary so
            # the Flask log shows what's actually in the column.
            try:
                verify = conn.execute(
                    "SELECT checked_params, approval_status, approved_by, "
                    "       approval_dt, approval_locked_at "
                    "FROM procurement_grn_trs WHERE id=%s",
                    (trs_id,)
                ).fetchone()
                vd = dict(verify) if hasattr(verify, "keys") else verify
                cp_db = vd.get("checked_params") if vd else None
                cp_len = len(cp_db) if cp_db else 0
                print(f"[QC] /trs/approve persisted: trs_id={trs_id} "
                      f"status={vd.get('approval_status')!r} "
                      f"approver={vd.get('approved_by')!r} "
                      f"checked_params_len={cp_len} "
                      f"submitted_len={len(checked_params_str or '')} "
                      f"submitted_rows={len(cp_clean)}")
                # If the DB has a clearly-different length than what we
                # tried to write, log louder so we notice.
                if checked_params_str and not cp_db:
                    print(f"⚠️  [QC] /trs/approve: checked_params write "
                          f"LOST — submitted {len(checked_params_str)} "
                          f"chars but DB column is empty after commit. "
                          f"Possible cause: row id changed under us, or "
                          f"COALESCE got NULL from a different path.")
            except Exception:
                import traceback; traceback.print_exc()

            # ── Per-item parameter memory ──
            # If structured parameter rows were submitted (the new
            # Checked Parameters modal sends dicts, not strings), save
            # the spec-only template to qc_trs_item_params so the next
            # TRS for the same material can pre-load it. Best-effort:
            # any error here is swallowed since the approval itself
            # already committed.
            try:
                # Only save when we have STRUCTURED rows (dicts). Plain
                # string lists from legacy callers carry no spec data
                # worth memorising.
                struct_rows = [p for p in cp_clean if isinstance(p, dict)]
                if struct_rows and trs_material:
                    _item_params_save(conn, trs_material, struct_rows, approved_by)
                    conn.commit()
            except Exception:
                import traceback; traceback.print_exc()

            new_locked_at = approval_dt if stamp_lock else (
                str(locked_at)[:19] if locked_at else None
            )
            return jsonify({
                'status':            'ok',
                'id':                trs_id,
                'approval_status':   status_in,
                'approved_by':       approved_by,
                'approval_dt':       approval_dt,
                'approval_remarks':  remarks,
                'checked_params':    checked_params_str,
                'rejection_reason':  rejection_reason,
                'approval_locked_at': new_locked_at,
                # COA capture extras — echo the normalised values so the
                # frontend can update its local row without a list reload.
                'coa_verified_by':     coa_verified_by,
                'coa_supplier_passed': bool(coa_supplier_passed),
                'coa_deviation':       coa_deviation,
                'coa_deviation_note':  coa_deviation_note,
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# RM TRS — Edit-access request / grant ("QC requests, admin approves")
# ──────────────────────────────────────────────────────────────────────────────
# A TRS becomes locked 24h after its first decision. Beyond that window a
# QC user can no longer edit it directly. Instead of forcing them to chase
# an admin offline, they raise an in-app request; an admin viewing the same
# TRS can grant edit access, which clears approval_locked_at (re-opening a
# fresh 24h editability window) and clears the request marker.
#
# Both endpoints are deliberately narrow and side-effect-light: the request
# endpoint only stamps unlock_requested_at/by; the grant endpoint only
# clears the lock + request. Neither touches approval_status, approved_by,
# checked_params, or any analytical data — granting access does NOT change
# the decision, it just lets QC re-open and edit it.
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/trs/request_unlock', methods=['POST'])
@_login_required
def api_qc_trs_request_unlock():
    """QC user requests edit access on a locked RM TRS.

    Body: { "id": int }

    Stamps unlock_requested_at (IST) + unlock_requested_by (session user).
    Idempotent: re-requesting just refreshes the timestamp. Admins don't
    need to request (they can edit / grant directly), but we don't block
    them from doing so.
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json(silent=True) or {}
    try:
        trs_id = int(d.get('id') or 0)
    except Exception:
        trs_id = 0
    if not trs_id:
        return jsonify({'status': 'error', 'message': 'id required'}), 400

    requested_by = session.get('User_Name') or session.get('UID') or 'Unknown'
    requested_at = _ist_now_str()
    try:
        conn = sampling_portal.get_db_connection()
        try:
            ex = conn.execute(
                "SELECT id, approval_locked_at FROM procurement_grn_trs WHERE id=%s",
                (trs_id,)
            ).fetchone()
            if not ex:
                return jsonify({'status': 'error', 'message': 'TRS not found'}), 404
            conn.execute(
                "UPDATE procurement_grn_trs "
                "SET unlock_requested_at=%s, unlock_requested_by=%s WHERE id=%s",
                (requested_at, requested_by, trs_id)
            )
            conn.commit()
            return jsonify({
                'status':               'ok',
                'id':                   trs_id,
                'unlock_requested_at':  requested_at,
                'unlock_requested_by':  requested_by,
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/trs/grant_unlock', methods=['POST'])
@_login_required
def api_qc_trs_grant_unlock():
    """Admin grants edit access on a locked RM TRS.

    Body: { "id": int }

    Clears approval_locked_at (so the row leaves the locked state and a
    fresh 24h editability window begins on the NEXT decision) AND clears
    the unlock request markers. Admin-only.

    Note: clearing approval_locked_at means the row is immediately
    editable again. The next time someone saves a decision via
    /api/qc/trs/approve, stamp_lock fires again (since locked_at is now
    NULL and the status is non-Pending), re-stamping a fresh lock and
    restarting the 24h clock. This is exactly the "one more editable
    window, then re-lock" behaviour we want.
    """
    if not _is_admin():
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    d = request.get_json(silent=True) or {}
    try:
        trs_id = int(d.get('id') or 0)
    except Exception:
        trs_id = 0
    if not trs_id:
        return jsonify({'status': 'error', 'message': 'id required'}), 400

    granted_by = session.get('User_Name') or session.get('UID') or 'Admin'
    try:
        conn = sampling_portal.get_db_connection()
        try:
            ex = conn.execute(
                "SELECT id FROM procurement_grn_trs WHERE id=%s", (trs_id,)
            ).fetchone()
            if not ex:
                return jsonify({'status': 'error', 'message': 'TRS not found'}), 404
            conn.execute(
                "UPDATE procurement_grn_trs "
                "SET approval_locked_at=NULL, "
                "    unlock_requested_at=NULL, "
                "    unlock_requested_by=NULL "
                "WHERE id=%s",
                (trs_id,)
            )
            conn.commit()
            print(f"[QC] /trs/grant_unlock: trs_id={trs_id} edit access "
                  f"granted by {granted_by!r} — lock cleared")
            return jsonify({
                'status':             'ok',
                'id':                 trs_id,
                'granted_by':         granted_by,
                'approval_locked_at': None,
                'is_locked':          False,
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# QC TRS Parameter Library — shared library of test parameters
# ──────────────────────────────────────────────────────────────────────────────
# When the QC user fills the Checked Parameters modal they pick from this
# library. They can also add custom parameters which persist here for
# everyone to use on future slips. Library entries carry default specs
# (range or text); per-TRS the operator can override both spec and the
# observed value.
# ══════════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/trs/params/library', methods=['GET'])
@_login_required
def api_qc_trs_params_library():
    """List active parameters in the library, sorted by sort_order."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        try:
            try:
                rows = conn.execute("""
                    SELECT id, name, unit, spec_type, spec_from, spec_to,
                           spec_target, is_active, sort_order
                    FROM qc_trs_parameter_library
                    WHERE is_active = 1
                    ORDER BY sort_order, name
                """).fetchall() or []
            except Exception as table_e:
                msg = str(table_e).lower()
                if 'qc_trs_parameter_library' in msg and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg):
                    return jsonify({'status': 'ok', 'params': [],
                                    'note': 'Library table not yet bootstrapped'})
                raise
            out = []
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                out.append(d)
            return jsonify({'status': 'ok', 'params': out})
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/trs/params/library/add', methods=['POST'])
@_login_required
def api_qc_trs_params_library_add():
    """Add a parameter to the shared library.

    Body:
        { "name": str, "unit": str|null, "spec_type": "range"|"value"|"text",
          "spec_from": str|null, "spec_to": str|null, "spec_target": str|null }

    'name' must be unique. Duplicate names return 409 — frontend can
    treat that as "already exists, use it directly".
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json(silent=True) or {}
    name = (d.get('name') or '').strip()
    if not name:
        return jsonify({'status': 'error', 'message': 'name is required'}), 400
    if len(name) > 150:
        return jsonify({'status': 'error', 'message': 'name too long (max 150)'}), 400
    unit = (d.get('unit') or '').strip() or None
    if unit and len(unit) > 40: unit = unit[:40]
    spec_type = (d.get('spec_type') or 'range').strip().lower()
    if spec_type not in ('range', 'value', 'text'):
        spec_type = 'range'
    spec_from   = (str(d.get('spec_from')   or '').strip()) or None
    spec_to     = (str(d.get('spec_to')     or '').strip()) or None
    spec_target = (str(d.get('spec_target') or '').strip()) or None
    created_by  = session.get('User_Name') or session.get('UID') or 'Unknown'

    try:
        conn = sampling_portal.get_db_connection()
        try:
            # Check for existing (case-insensitive)
            ex = conn.execute(
                "SELECT id FROM qc_trs_parameter_library WHERE LOWER(name)=LOWER(%s)",
                (name,)
            ).fetchone()
            if ex:
                ex_d = dict(ex) if hasattr(ex, 'keys') else ex
                return jsonify({
                    'status':  'exists',
                    'message': 'A parameter with this name already exists',
                    'id':      ex_d.get('id'),
                }), 409
            # Compute next sort_order (append to end)
            row = conn.execute(
                "SELECT COALESCE(MAX(sort_order),0)+10 AS next_sort "
                "FROM qc_trs_parameter_library"
            ).fetchone()
            next_sort = int((row.get('next_sort') if hasattr(row, 'get') else row[0]) or 100)
            conn.execute("""
                INSERT INTO qc_trs_parameter_library
                  (name, unit, spec_type, spec_from, spec_to, spec_target, sort_order, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (name, unit, spec_type, spec_from, spec_to, spec_target, next_sort, created_by))
            new_id_row = conn.execute(
                "SELECT id FROM qc_trs_parameter_library WHERE name=%s", (name,)
            ).fetchone()
            new_id = int((new_id_row.get('id') if hasattr(new_id_row, 'get') else new_id_row[0]) or 0)
            conn.commit()
            return jsonify({
                'status':      'ok',
                'id':          new_id,
                'name':        name,
                'unit':        unit,
                'spec_type':   spec_type,
                'spec_from':   spec_from,
                'spec_to':     spec_to,
                'spec_target': spec_target,
                'sort_order':  next_sort,
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# Per-item parameter memory — qc_trs_item_params
# ──────────────────────────────────────────────────────────────────────────────
# When a TRS is approved or rejected, the parameter SPECS used go into the
# qc_trs_item_params table keyed by material name. Next TRS for the same
# material auto-loads them via /api/qc/trs/item_params, so the QC user
# doesn't have to re-pick from scratch.
# ══════════════════════════════════════════════════════════════════════════════

def _item_params_save(conn, material, params_full, user):
    """Save / update the parameter set used on this material's last TRS.
    Called from inside api_qc_trs_approve when checked_params is present.
    Best-effort: failures are logged but never break the approval flow.

    `params_full` is the structured list of dicts coming from the modal
    (frontend already normalised it). We strip the per-TRS bits
    (observed, passed, note) and keep only the reusable spec parts so
    the next TRS starts with blank observations."""
    if not material or not params_full:
        return
    try:
        # Keep only the spec-shape fields. Drop observed/passed/note —
        # those are per-TRS observations, not part of the reusable
        # parameter template.
        spec_only = []
        for p in params_full:
            if not isinstance(p, dict): continue
            nm = (p.get('name') or '').strip()
            if not nm: continue
            spec_only.append({
                'name':        nm,
                'unit':        p.get('unit')        or None,
                'spec_type':   p.get('spec_type')   or 'range',
                'spec_from':   p.get('spec_from')   if p.get('spec_from')   not in ('', None) else None,
                'spec_to':     p.get('spec_to')     if p.get('spec_to')     not in ('', None) else None,
                'spec_target': p.get('spec_target') if p.get('spec_target') not in ('', None) else None,
            })
        if not spec_only:
            return
        import json as _json
        params_json = _json.dumps(spec_only, ensure_ascii=False)
        material_key = material.strip().lower()
        # Upsert. MySQL's ON DUPLICATE KEY UPDATE keeps the row id stable.
        conn.execute("""
            INSERT INTO qc_trs_item_params
              (material_key, material_display, params_json, last_used_by)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              material_display = VALUES(material_display),
              params_json      = VALUES(params_json),
              last_used_by     = VALUES(last_used_by)
        """, (material_key, material.strip(), params_json, user))
    except Exception as e:
        import traceback; traceback.print_exc()
        # Best-effort: never break the approval just because the
        # parameter-memory save hiccupped.


@qc_bp.route('/api/qc/trs/item_params', methods=['GET'])
@_login_required
def api_qc_trs_item_params_get():
    """Return the parameter list saved for a given material, if any.
    Used by the Checked Parameters modal to pre-load specs when the
    operator opens a new TRS for a material that's been inspected
    before.

    Query: ?material=<name>  (case-insensitive)

    Returns:
        { status: "ok", params: [...], material_display: "...", last_used_by, last_used_at }
        or  { status: "ok", params: [] }  if no saved set exists.
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    material = (request.args.get('material') or '').strip()
    if not material:
        return jsonify({'status': 'ok', 'params': []})
    try:
        conn = sampling_portal.get_db_connection()
        try:
            try:
                row = conn.execute("""
                    SELECT material_display, params_json, last_used_by, last_used_at
                    FROM qc_trs_item_params
                    WHERE material_key = %s
                    LIMIT 1
                """, (material.lower(),)).fetchone()
            except Exception as table_e:
                msg = str(table_e).lower()
                if 'qc_trs_item_params' in msg and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg):
                    return jsonify({'status': 'ok', 'params': [],
                                    'note': 'item params table not yet bootstrapped'})
                raise
            if not row:
                return jsonify({'status': 'ok', 'params': []})
            d = dict(row) if hasattr(row, 'keys') else row
            params = []
            try:
                import json as _json
                parsed = _json.loads(d.get('params_json') or '[]')
                if isinstance(parsed, list):
                    params = parsed
            except Exception:
                params = []
            return jsonify({
                'status':           'ok',
                'params':           params,
                'material_display': d.get('material_display'),
                'last_used_by':     d.get('last_used_by'),
                'last_used_at':     _dt2str(d.get('last_used_at')),
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ════════════════════════════════════════════════════════════════════════
# PM TRS — QC dashboard endpoints
# ────────────────────────────────────────────────────────────────────────
# Sibling to the RM TRS endpoints above. Same shape, but reads from
# pm_grn_trs (the packaging-materials TRS table owned by the pm_stock
# blueprint) and not from procurement_grn_trs (RM/inventory).
#
# Endpoints:
#   /api/qc/pm_trs/list      — list rows for the dashboard grid
#   /api/qc/pm_trs/approve   — set approval_status (with 24h lock logic)
#   /qc/pm_trs/<id>/coa_print— Certificate of Analysis HTML (reuses the
#                              shared qc/qc_coa_print.html template)
# ════════════════════════════════════════════════════════════════════════

@qc_bp.route('/api/qc/pm_trs/list')
@_login_required
def api_qc_pm_trs_list():
    """Return every PM TRS row from pm_grn_trs in the shape the QC
    dashboard wants. Tolerates the case where the table doesn't exist
    yet (pm_stock module hasn't booted) by returning an empty list
    instead of 500ing the whole dashboard."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        try:
            try:
                rows = conn.execute("""
                    SELECT id, trs_num, grn_id, grn_item_id, source_item_ids,
                           grn_num, grn_date,
                           product_id, material, product_code, pm_type,
                           no_of_box, qty_per_pkg, total_qty, uom,
                           supplier_name, previous_supplier, new_or_old,
                           physical_state, sample_qty, client_name,
                           generated_by, generated_at, verified_by,
                           approval_status, approved_by, approval_dt,
                           approval_remarks, approval_locked_at,
                           checked_params, rejection_reason
                    FROM pm_grn_trs
                    ORDER BY generated_at DESC, id DESC
                    LIMIT 2000
                """).fetchall() or []
            except Exception as table_e:
                msg = str(table_e).lower()
                if 'pm_grn_trs' in msg and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg):
                    return jsonify({'status': 'ok', 'trs': [],
                                    'note': 'PM TRS table not yet bootstrapped'})
                raise
            out = []
            # Single IST "now" for consistent lock-flag math.
            try:
                from datetime import datetime as _dt
                now_ist_dt = _dt.strptime(_ist_now_str(), '%Y-%m-%d %H:%M:%S')
            except Exception:
                now_ist_dt = None
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                # Datetime + date normalisation
                for k in ('generated_at', 'approval_dt', 'approval_locked_at'):
                    d[k] = _dt2str(d.get(k))
                for k in ('grn_date',):
                    if d.get(k):
                        try:
                            d[k] = d[k].isoformat()
                        except Exception:
                            d[k] = str(d[k])
                # Numeric coercion so JSON.stringify produces plain numbers
                for k in ('no_of_box', 'qty_per_pkg', 'total_qty', 'sample_qty'):
                    if d.get(k) is not None:
                        try: d[k] = float(d[k])
                        except Exception: pass
                # checked_params is stored as a JSON string in the column.
                # Parse to a Python list so the frontend can iterate. Tolerant
                # of historical legacy formats (comma/semicolon-separated
                # plain strings) — same recovery logic as the RM endpoint.
                cp = d.get('checked_params')
                if cp:
                    try:
                        parsed = json.loads(cp)
                        if isinstance(parsed, list):
                            d['checked_params'] = parsed
                        else:
                            d['checked_params'] = [str(parsed)]
                    except Exception:
                        d['checked_params'] = [s.strip() for s in
                                               str(cp).replace(';', ',').split(',')
                                               if s.strip()]
                else:
                    d['checked_params'] = []
                # source_item_ids parse → list of ints (for "covers N lines" badge)
                sids = d.get('source_item_ids')
                if sids:
                    try:
                        parsed = json.loads(sids)
                        d['source_item_ids'] = [int(x) for x in parsed] if isinstance(parsed, list) else []
                    except Exception:
                        d['source_item_ids'] = []
                else:
                    d['source_item_ids'] = []
                # is_locked + hours_remaining
                locked_at_str = d.get('approval_locked_at')
                d['is_locked'] = False
                d['hours_remaining'] = None
                if locked_at_str and now_ist_dt:
                    try:
                        from datetime import datetime as _dt3
                        lk = _dt3.strptime(locked_at_str[:19], '%Y-%m-%d %H:%M:%S')
                        diff = now_ist_dt - lk
                        hrs_used = diff.total_seconds() / 3600.0
                        d['is_locked'] = hrs_used >= 24.0
                        d['hours_remaining'] = max(0.0, 24.0 - hrs_used)
                    except Exception:
                        pass
                # "new_supplier" convenience field (matches the RM shape so
                # the dashboard's existing render code can be reused).
                d['new_supplier'] = d.get('supplier_name') if d.get('new_or_old') == 'NEW' else None
                # Default missing approval_status (shouldn't happen given the
                # ENUM default of 'Pending', but be defensive).
                if not d.get('approval_status'):
                    d['approval_status'] = 'Pending'
                # Also surface no_of_box under 'packages' so the shared CoA
                # template + frontend can keep using the RM-style key name.
                d['packages'] = d.get('no_of_box')
                out.append(d)
            return jsonify({'status': 'ok', 'trs': out})
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/pm_trs/approve', methods=['POST'])
@_login_required
def api_qc_pm_trs_approve():
    """Set approval_status on a PM TRS row.

    Body:
        {
          "id":               int,
          "status":           "Approved"|"Rejected"|"Pending"|"Under Review",
          "remarks":          str (optional),
          "checked_params":   list[str|dict] (optional),
          "rejection_reason": str (optional)
        }

    Mirrors api_qc_trs_approve() exactly, but reads/writes pm_grn_trs
    instead of procurement_grn_trs.  The 24h lock logic is identical:
    first non-Pending decision stamps approval_locked_at; subsequent
    edits beyond 24h require admin override (force flag).
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json(silent=True) or {}
    try:
        trs_id = int(d.get('id') or 0)
    except Exception:
        trs_id = 0
    status_in = (d.get('status') or '').strip()
    ALLOWED = ('Pending', 'Approved', 'Rejected', 'Under Review')
    if not trs_id or status_in not in ALLOWED:
        return jsonify({'status': 'error',
                        'message': f"id and status (one of {ALLOWED}) required"}), 400

    remarks = (d.get('remarks') or '').strip() or None

    # checked_params normalisation — same logic as RM endpoint.
    cp_raw = d.get('checked_params')
    import json as _json
    cp_clean = []
    if isinstance(cp_raw, list):
        seen_names = set()
        for item in cp_raw:
            if isinstance(item, dict):
                nm = str(item.get('name') or '').strip()
                if not nm: continue
                key = nm.lower() + '|' + str(item.get('spec_type') or '')
                if key in seen_names: continue
                seen_names.add(key)
                cp_clean.append({
                    'name':        nm,
                    'unit':        (item.get('unit') or '') or None,
                    'spec_type':   item.get('spec_type') or 'range',
                    'spec_from':   item.get('spec_from')   if item.get('spec_from') not in ('', None) else None,
                    'spec_to':     item.get('spec_to')     if item.get('spec_to')   not in ('', None) else None,
                    'spec_target': item.get('spec_target') if item.get('spec_target') not in ('', None) else None,
                    'observed':    item.get('observed')    if item.get('observed')  not in ('', None) else None,
                    'passed':      bool(item.get('passed')) if item.get('passed') is not None else None,
                    'note':        item.get('note') or None,
                })
            else:
                s = str(item).strip()
                if s and s.lower() not in seen_names:
                    seen_names.add(s.lower())
                    cp_clean.append(s)
        checked_params_str = _json.dumps(cp_clean, ensure_ascii=False) if cp_clean else None
    elif isinstance(cp_raw, str) and cp_raw.strip():
        checked_params_str = cp_raw.strip()
    else:
        checked_params_str = None
    rejection_reason = (d.get('rejection_reason') or '').strip() or None

    # Approver attribution — never credit admin/system. Same SYSTEM_USERS
    # set as the RM endpoint.
    session_user = session.get('User_Name') or session.get('UID') or 'Unknown'
    SYSTEM_USERS = {'admin', 'system administrator', 'system', 'root',
                    'developer', 'developer test', 'sysadmin'}
    is_system_caller = (
        _is_admin() or
        str(session_user or '').strip().lower() in SYSTEM_USERS
    )
    approval_dt = _ist_now_str()

    try:
        conn = sampling_portal.get_db_connection()
        try:
            existing = conn.execute(
                "SELECT id, approval_status, approval_locked_at, material, "
                "       approved_by AS prior_approved_by "
                "FROM pm_grn_trs WHERE id=%s",
                (trs_id,)
            ).fetchone()
            if not existing:
                return jsonify({'status': 'error', 'message': 'TRS not found'}), 404
            ex_d = dict(existing) if hasattr(existing, 'keys') else existing
            locked_at = ex_d.get('approval_locked_at')
            prior_approved_by = (ex_d.get('prior_approved_by') or '').strip()

            prior_is_system = str(prior_approved_by or '').strip().lower() in SYSTEM_USERS
            if is_system_caller:
                if prior_approved_by and not prior_is_system:
                    approved_by = prior_approved_by
                else:
                    approved_by = 'QC Engineer (pending assignment)'
            else:
                approved_by = session_user

            # 24h lock check (same logic as RM endpoint)
            force = bool(d.get('force'))
            if locked_at and not force:
                try:
                    if isinstance(locked_at, str):
                        from datetime import datetime as _dt
                        locked_dt = _dt.strptime(locked_at[:19], '%Y-%m-%d %H:%M:%S')
                    else:
                        locked_dt = locked_at
                    from datetime import datetime as _dt2, timedelta as _td
                    now_ist_str = _ist_now_str()
                    now_ist = _dt2.strptime(now_ist_str, '%Y-%m-%d %H:%M:%S')
                    if (now_ist - locked_dt) > _td(hours=24):
                        if not _is_admin():
                            return jsonify({
                                'status':       'locked',
                                'message':      ('This TRS was decided more than 24 hours ago '
                                                 'and is now locked. Contact an admin to override.'),
                                'locked_at':    str(locked_at)[:19],
                            }), 423
                except Exception:
                    import traceback; traceback.print_exc()

            stamp_lock = (not locked_at) and (status_in != 'Pending')
            new_lock_clause = ", approval_locked_at=%s" if stamp_lock else ""
            params = [status_in, approved_by, approval_dt, remarks,
                      checked_params_str, rejection_reason]
            if stamp_lock:
                params.append(approval_dt)
            params.append(trs_id)

            conn.execute(f"""
                UPDATE pm_grn_trs
                SET approval_status=%s,
                    approved_by=%s,
                    approval_dt=%s,
                    approval_remarks=COALESCE(%s, approval_remarks),
                    checked_params=COALESCE(%s, checked_params),
                    rejection_reason=COALESCE(%s, rejection_reason)
                    {new_lock_clause}
                WHERE id=%s
            """, params)
            conn.commit()

            # Read back for response confirmation
            try:
                verify = conn.execute(
                    "SELECT approval_status, approved_by, approval_dt, "
                    "       approval_locked_at "
                    "FROM pm_grn_trs WHERE id=%s",
                    (trs_id,)
                ).fetchone()
                vd = dict(verify) if verify else {}
                print(f"[QC] /pm_trs/approve persisted: trs_id={trs_id} "
                      f"status={vd.get('approval_status')!r} "
                      f"approved_by={vd.get('approved_by')!r}")
            except Exception:
                pass

            return jsonify({
                'status':            'ok',
                'id':                trs_id,
                'new_status':        status_in,
                'approved_by':       approved_by,
                'approval_dt':       approval_dt,
                'lock_stamped':      stamp_lock,
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/qc/pm_trs/<int:trs_id>/coa_print')
@_login_required
def qc_pm_trs_coa_print(trs_id):
    """Render Certificate of Analysis HTML for a PM TRS, reusing the
    shared qc/qc_coa_print.html template. Sibling of qc_trs_coa_print()
    above. Any logged-in user can open this; it's a read-only printable
    page so we don't gate on QC role."""
    try:
        conn = sampling_portal.get_db_connection()
    except Exception:
        return _denied('database unavailable'), 503
    try:
        row = conn.execute(
            """SELECT id, trs_num, grn_num, grn_date,
                      material, product_code, pm_type,
                      no_of_box, qty_per_pkg, total_qty, uom,
                      supplier_name, physical_state, sample_qty,
                      previous_supplier, new_or_old, verified_by,
                      generated_by, generated_at, client_name,
                      approval_status, approved_by, approval_dt,
                      approval_remarks, approval_locked_at,
                      checked_params, rejection_reason
               FROM pm_grn_trs WHERE id=%s""",
            (trs_id,)
        ).fetchone()
    finally:
        try: conn.close()
        except Exception: pass

    if not row:
        return ("<h1 style='font-family:sans-serif;padding:40px'>"
                "PM TRS not found</h1>"), 404

    trs = dict(row) if hasattr(row, 'keys') else row
    # The shared CoA template references `packages` (RM naming) for the
    # No. of Packages cell. Map our PM no_of_box → packages so the same
    # template renders correctly without modification.
    trs['packages']     = trs.get('no_of_box')
    # PM TRS doesn't carry batch/manufacturer/mfg_date/expiry_date — the
    # template renders these as '—' when they're empty/None, so we just
    # leave them absent from the dict.
    raw_cp = trs.get('checked_params')
    params = []
    if raw_cp:
        try:
            parsed = json.loads(raw_cp)
            if isinstance(parsed, list):
                params = [p for p in parsed if isinstance(p, dict) and p.get('name')]
        except Exception:
            params = []
    pass_count = sum(1 for p in params if p.get('passed') is True)
    fail_count = sum(1 for p in params if p.get('passed') is False)
    na_count   = len(params) - pass_count - fail_count
    status      = (trs.get('approval_status') or 'Pending').strip()
    is_approved = (status == 'Approved')
    approved_by_raw = (trs.get('approved_by') or '').strip()
    approver_is_placeholder = 'pending assignment' in approved_by_raw.lower()
    approved_by_display = approved_by_raw if approved_by_raw else '—'

    def _fmt_d(v):
        if not v: return '—'
        s = str(v)[:10]
        if len(s) == 10 and s[4] == '-' and s[7] == '-':
            return s[8:10] + '-' + s[5:7] + '-' + s[0:4]
        return s or '—'
    def _fmt_qty(v):
        if v is None or v == '': return '—'
        try:
            f = float(v)
            s = ('%.3f' % f).rstrip('0').rstrip('.')
            return s if s else '0'
        except Exception:
            return str(v)
    approval_date_str = ''
    if trs.get('approval_dt'):
        approval_date_str = _fmt_d(str(trs['approval_dt'])[:10])
    elif trs.get('generated_at'):
        approval_date_str = _fmt_d(str(trs['generated_at'])[:10])
    else:
        approval_date_str = _fmt_d(_ist_now_str()[:10])
    today_str = _fmt_d(_ist_now_str()[:10])
    return render_template(
        'qc/qc_coa_print.html',
        trs=trs,
        params=params,
        pass_count=pass_count,
        fail_count=fail_count,
        na_count=na_count,
        is_approved=is_approved,
        approved_by_display=approved_by_display,
        approver_is_placeholder=approver_is_placeholder,
        approval_date_d=approval_date_str,
        today_d=today_str,
        fmt_d=_fmt_d,
        fmt_qty=_fmt_qty,
    )


# ════════════════════════════════════════════════════════════════════════
# PM TRS — Parameter library + per-material auto-load
# ────────────────────────────────────────────────────────────────────────
# Sister endpoints to /api/qc/trs/params/library etc. — separate library
# (table pm_trs_observation_params_library) so PM-specific parameters
# (print clarity, foil adhesion, roll diameter…) don't clutter the RM
# library, and vice versa.
#
# The DB ENUM for spec_type is ('range','target','text','boolean') but
# the API exposes ('range','value','text') to mirror the RM frontend
# vocabulary. We normalise both directions transparently.
# ════════════════════════════════════════════════════════════════════════


def _pmtrs_spec_db_to_api(t):
    """DB ENUM uses 'target'; the API/frontend uses 'value'."""
    return 'value' if (t or '').lower() == 'target' else (t or 'range').lower()


def _pmtrs_spec_api_to_db(t):
    """Inverse of _pmtrs_spec_db_to_api."""
    t = (t or 'range').lower()
    return 'target' if t == 'value' else t


@qc_bp.route('/api/qc/pm_trs/params/library', methods=['GET'])
@_login_required
def api_qc_pm_trs_params_library():
    """List parameters in the PM-specific library, sorted by usage
    (most-used first) then by name. Tolerates missing table by
    returning an empty list."""
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        try:
            try:
                rows = conn.execute("""
                    SELECT id, name, unit, spec_type, spec_from, spec_to,
                           spec_target, usage_count
                    FROM pm_trs_observation_params_library
                    ORDER BY usage_count DESC, name
                """).fetchall() or []
            except Exception as table_e:
                msg = str(table_e).lower()
                if ('pm_trs_observation_params_library' in msg
                        and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg)):
                    return jsonify({'status': 'ok', 'params': [],
                                    'note': 'PM TRS library table not yet bootstrapped'})
                raise
            out = []
            for r in rows:
                d = dict(r) if hasattr(r, 'keys') else r
                # Map DB 'target' → API 'value' so the frontend can reuse
                # the RM TRS spec-type vocabulary unchanged.
                d['spec_type'] = _pmtrs_spec_db_to_api(d.get('spec_type'))
                out.append(d)
            return jsonify({'status': 'ok', 'params': out})
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/pm_trs/params/library/add', methods=['POST'])
@_login_required
def api_qc_pm_trs_params_library_add():
    """Add a parameter to the PM TRS observation library.

    Body:
        { "name": str, "unit": str|null, "spec_type": "range"|"value"|"text",
          "spec_from": str|null, "spec_to": str|null, "spec_target": str|null }

    'name' must be unique (case-insensitive). Duplicate names return 409 —
    the frontend treats that as "already exists, use it directly".
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json(silent=True) or {}
    name = (d.get('name') or '').strip()
    if not name:
        return jsonify({'status': 'error', 'message': 'name is required'}), 400
    if len(name) > 200:
        return jsonify({'status': 'error', 'message': 'name too long (max 200)'}), 400
    unit = (d.get('unit') or '').strip() or ''
    if unit and len(unit) > 50: unit = unit[:50]
    spec_type_api = (d.get('spec_type') or 'range').strip().lower()
    if spec_type_api not in ('range', 'value', 'text'):
        spec_type_api = 'range'
    spec_type_db = _pmtrs_spec_api_to_db(spec_type_api)
    spec_from   = (str(d.get('spec_from')   or '').strip()) or None
    spec_to     = (str(d.get('spec_to')     or '').strip()) or None
    spec_target = (str(d.get('spec_target') or '').strip()) or None
    created_by  = session.get('User_Name') or session.get('UID') or 'Unknown'

    try:
        conn = sampling_portal.get_db_connection()
        try:
            ex = conn.execute(
                "SELECT id FROM pm_trs_observation_params_library "
                "WHERE LOWER(name) = LOWER(%s)",
                (name,)
            ).fetchone()
            if ex:
                ex_d = dict(ex) if hasattr(ex, 'keys') else ex
                return jsonify({
                    'status':  'exists',
                    'message': 'A parameter with this name already exists',
                    'id':      ex_d.get('id'),
                }), 409
            conn.execute("""
                INSERT INTO pm_trs_observation_params_library
                  (name, unit, spec_type, spec_from, spec_to, spec_target, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (name, unit, spec_type_db, spec_from, spec_to, spec_target, created_by))
            new_id_row = conn.execute(
                "SELECT id FROM pm_trs_observation_params_library WHERE name=%s",
                (name,)
            ).fetchone()
            new_id = int((new_id_row.get('id') if hasattr(new_id_row, 'get') else new_id_row[0]) or 0)
            conn.commit()
            return jsonify({
                'status':      'ok',
                'id':          new_id,
                'name':        name,
                'unit':        unit,
                # Send back the API-style spec_type so the frontend's
                # _trsParamRows mirror matches what came out of the GET.
                'spec_type':   spec_type_api,
                'spec_from':   spec_from,
                'spec_to':     spec_to,
                'spec_target': spec_target,
                'sort_order':  0,    # placeholder for FE compat (we don't sort by it)
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@qc_bp.route('/api/qc/pm_trs/item_params', methods=['GET'])
@_login_required
def api_qc_pm_trs_item_params_get():
    """Return the parameter list last used for a given material, derived
    from the most recent decided pm_grn_trs row of that material.

    Unlike the RM-side endpoint (which reads from a dedicated
    qc_trs_item_params table), PM doesn't keep a parallel mapping table —
    it just looks up the last TRS for the same material name and replays
    those parameter specs (observations are stripped, since they're
    per-TRS not per-material).

    Query: ?material=<name>  (case-insensitive)
    """
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    material = (request.args.get('material') or '').strip()
    if not material:
        return jsonify({'status': 'ok', 'params': []})
    try:
        conn = sampling_portal.get_db_connection()
        try:
            try:
                row = conn.execute("""
                    SELECT checked_params, approved_by, approval_dt, material
                    FROM pm_grn_trs
                    WHERE LOWER(material) = LOWER(%s)
                      AND checked_params IS NOT NULL
                      AND approval_status IN ('Approved', 'Rejected')
                    ORDER BY approval_dt DESC, id DESC
                    LIMIT 1
                """, (material,)).fetchone()
            except Exception as table_e:
                msg = str(table_e).lower()
                if 'pm_grn_trs' in msg and ('doesn' in msg or 'not exist' in msg or 'unknown' in msg):
                    return jsonify({'status': 'ok', 'params': [],
                                    'note': 'pm_grn_trs not yet bootstrapped'})
                raise
            if not row:
                return jsonify({'status': 'ok', 'params': []})
            d = dict(row) if hasattr(row, 'keys') else row
            raw = d.get('checked_params')
            if not raw:
                return jsonify({'status': 'ok', 'params': []})
            try:
                parsed = json.loads(raw)
            except Exception:
                return jsonify({'status': 'ok', 'params': []})
            if not isinstance(parsed, list):
                return jsonify({'status': 'ok', 'params': []})
            # Keep dict rows only, strip observation values (per-TRS not
            # per-material), and drop pass/fail/note (they belong to the
            # source TRS, not this template).
            params = []
            for p in parsed:
                if not isinstance(p, dict) or not p.get('name'):
                    continue
                params.append({
                    'name':        p.get('name'),
                    'unit':        p.get('unit') or '',
                    'spec_type':   p.get('spec_type') or 'range',
                    'spec_from':   p.get('spec_from'),
                    'spec_to':     p.get('spec_to'),
                    'spec_target': p.get('spec_target'),
                    # observed/passed/note intentionally omitted
                })
            return jsonify({
                'status':           'ok',
                'params':           params,
                'material_display': d.get('material'),
                'last_used_by':     d.get('approved_by'),
                'last_used_at':     _dt2str(d.get('approval_dt')),
            })
        finally:
            try: conn.close()
            except Exception: pass
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500
