# ══════════════════════════════════════════════════════════════════════════════
# PRODUCTION DEPARTMENT ROUTES — Blueprint
# All DB functions for production_department.html are self-contained here.
# Only get_db_connection and get_user_permissions are imported from sampling_portal.
# ══════════════════════════════════════════════════════════════════════════════

from flask import Blueprint, render_template, request, jsonify, session
from functools import wraps
from datetime import datetime
from sampling_portal import get_db_connection, get_user_permissions

production_dept_bp = Blueprint('production_dept', __name__)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _login_required(f):
    """Minimal login guard used within this blueprint."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            from flask import redirect, url_for
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


# ── Permission logic ─────────────────────────────────────────────────────────

_ROLE_DEFAULT_PAGES = {
    'admin':      {
                   'dashboard','rd_sampling','qc_sampling','qc_dashboard',
                   'task_reminders','task_scheduler','manage_users',
                   'access_control','transaction','loan','scrap',
                   'production_initiater','cms','procurement','production_dept',
                   'planning','backup','trs_view','packing',
                  },
    'Purchase':   {'dashboard','rd_sampling','qc_sampling','qc_dashboard',
                   'transaction','loan','scrap','cms',
                   'task_reminders','trs_view'},
    'RD':         {'dashboard','rd_sampling','task_reminders','trs_view'},
    'QC':         {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'Planning':   {'dashboard','planning','task_reminders'},
    'Production': {'dashboard','production_dept','task_reminders'},
    'Stores':     {'dashboard','production_initiater','task_reminders'},
    'stores':     {'dashboard','production_initiater','task_reminders'},
    'Packing':    {'dashboard','packing'},
    'qc_common':  {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'QC_Common':  {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'User':       {'dashboard','transaction','loan','scrap'},
    'RM_Store':   {'dashboard','production_initiater','task_reminders'},
    'rm_store':   {'dashboard','production_initiater','task_reminders'},
    'Rm_Store':   {'dashboard','production_initiater','task_reminders'},
}
_USER_PAGE_GRANTS = {
    'dharmendra': {'transaction', 'loan', 'scrap'},
}

def _user_allowed_pages():
    role    = session.get('User_Type', '')
    user_id = session.get('user_id')
    uid     = (session.get('UID') or '').lower()
    if role == 'admin':
        return set(_ROLE_DEFAULT_PAGES['admin'])
    perms = set(_ROLE_DEFAULT_PAGES.get(role, {'dashboard'}))
    if uid in _USER_PAGE_GRANTS:
        perms |= _USER_PAGE_GRANTS[uid]
    if user_id:
        try:
            overrides = get_user_permissions(user_id)
            for key, allowed in overrides.items():
                pg = key[5:] if key.startswith('page:') else key
                if allowed:
                    perms.add(pg)
                else:
                    perms.discard(pg)
        except Exception:
            pass
    return perms

def _can_prod_dept():
    role = session.get('User_Type', '')
    return 'production_dept' in _user_allowed_pages() or role.lower() == 'production'

def _can_qc_dashboard():
    role = (session.get('User_Type') or '').lower()
    return role in ('admin', 'qc', 'qc_common') or 'qc_dashboard' in _user_allowed_pages()

def _denied(label='this page'):
    return (
        f"""<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{{font-family:sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.box{{background:#fff;border-radius:16px;padding:56px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}}
.ico{{font-size:56px;margin-bottom:12px}} h2{{color:#dc2626;margin:0 0 8px}}
p{{color:#64748b;margin:4px 0}} a{{color:#0d9488;font-weight:600;text-decoration:none}}
</style></head><body><div class="box">
<div class="ico">&#128274;</div>
<h2>Access Denied</h2>
<p>You don't have permission to access</p>
<p><strong>{label}</strong></p>
<br><a href="/">&#8592; Back to Portal</a>
</div></body></html>""",
        403
    )

# ══════════════════════════════════════════════════════════════════════════════
# PRODUCTION DEPARTMENT — Three separate tables
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_prod_dept_tables():
    """
    Creates / migrates the two production dept tables.
    Handles the case where production_dept_log exists with the OLD schema
    (processing_batch_id FK column) — drops and recreates it safely.
    """
    conn = get_db_connection()

    # ── Detect old schema: if production_dept_log exists but lacks 'dsp_id' column ──
    old_schema = False
    try:
        cols = conn.execute("SHOW COLUMNS FROM production_dept_log").fetchall()
        col_names = {c['Field'] for c in cols}
        if 'dsp_id' not in col_names:
            old_schema = True
    except Exception:
        pass  # table doesn't exist yet — that's fine

    if old_schema:
        # Old table has no useful data (it was just created as part of a previous
        # iteration). Drop FK constraints first, then the table.
        try:
            # Get FK constraint name
            fks = conn.execute("""
                SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='production_dept_log'
                AND CONSTRAINT_TYPE='FOREIGN KEY'
            """).fetchall()
            for fk in fks:
                try:
                    conn.execute(f"ALTER TABLE production_dept_log DROP FOREIGN KEY `{fk['CONSTRAINT_NAME']}`")
                    conn.commit()
                except Exception:
                    pass
            conn.execute("DROP TABLE IF EXISTS production_dept_log")
            conn.commit()
        except Exception:
            pass

    # ── Table 1: production_dept_log — in-process batches ──
    conn.execute("""
        CREATE TABLE IF NOT EXISTS production_dept_log (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            dsp_id              INT DEFAULT NULL,
            batch_name          VARCHAR(500) NOT NULL,
            batch_size          DECIMAL(10,3) DEFAULT NULL,
            product_code        VARCHAR(200) DEFAULT NULL,
            operator_name       VARCHAR(200) DEFAULT NULL,
            batches_processed   INT DEFAULT NULL,
            status              VARCHAR(50) NOT NULL DEFAULT 'In Process',
            remarks             TEXT DEFAULT NULL,
            processing_datetime DATETIME DEFAULT NULL,
            created_by          VARCHAR(100) DEFAULT NULL,
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    """)
    conn.commit()

    # ── Add product_code column if missing (migration for existing DBs) ──
    try:
        cols = conn.execute("SHOW COLUMNS FROM production_dept_log").fetchall()
        col_names = [c['Field'] for c in cols]
        if 'product_code' not in col_names:
            conn.execute("ALTER TABLE production_dept_log ADD COLUMN product_code VARCHAR(200) DEFAULT NULL AFTER batch_size")
            conn.commit()
    except Exception:
        pass

    # ── Table 2: production_summary — completed batches ──
    conn.execute("""
        CREATE TABLE IF NOT EXISTS production_summary (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            log_id              INT DEFAULT NULL,
            batch_name          VARCHAR(500) NOT NULL,
            batch_size          DECIMAL(10,3) DEFAULT NULL,
            product_code        VARCHAR(200) DEFAULT NULL,
            total_completed     INT DEFAULT NULL,
            processing_datetime DATETIME DEFAULT NULL,
            completed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
            operator_name       VARCHAR(200) DEFAULT NULL,
            created_by          VARCHAR(100) DEFAULT NULL
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    """)
    conn.commit()

    # ── Add product_code to production_summary if missing ──
    try:
        cols = conn.execute("SHOW COLUMNS FROM production_summary").fetchall()
        col_names = [c['Field'] for c in cols]
        if 'product_code' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN product_code VARCHAR(200) DEFAULT NULL AFTER batch_size")
            conn.commit()
        if 'trs_no' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN trs_no VARCHAR(100) DEFAULT NULL AFTER product_code")
            conn.commit()
            # Add unique index if not already present
            try:
                conn.execute("ALTER TABLE production_summary ADD UNIQUE INDEX ux_prod_summary_trs_no (trs_no)")
                conn.commit()
            except Exception:
                pass
        if 'sample_qty' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN sample_qty VARCHAR(100) DEFAULT NULL AFTER trs_no")
            conn.commit()
        if 'appearance' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN appearance VARCHAR(300) DEFAULT NULL AFTER sample_qty")
            conn.commit()
        if 'odour' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN odour VARCHAR(300) DEFAULT NULL AFTER appearance")
            conn.commit()
        if 'total_containers' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN total_containers INT DEFAULT NULL AFTER odour")
            conn.commit()
        if 'bulk_obtained' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN bulk_obtained DECIMAL(10,3) DEFAULT NULL AFTER odour")
            conn.commit()
        # dsp_id links a completed batch back to its daily_dsp_summary dispensing row.
        # This lets the Dispensing Records grid keep a batch hidden after completion
        # (so it does not reappear once production has consumed the dispensed qty).
        _need_backfill = False
        if 'dsp_id' not in col_names:
            conn.execute("ALTER TABLE production_summary ADD COLUMN dsp_id INT DEFAULT NULL AFTER log_id")
            conn.commit()
            _need_backfill = True

        # One-time correction (v3). Earlier versions: (v1) linked to the most
        # recent same-name dispensing row (wrong); (v2) linked only completed
        # rows and rejected links when the dispensing date was after completion
        # (too strict) and never touched in-process rows. Result: old batches
        # that production had taken still showed as pending because their
        # in-process/completed records had dsp_id = NULL and so never subtracted.
        # v3 relinks BOTH production_dept_log (In Process) and production_summary
        # (Completed), matching by batch_name (size preferred but not required),
        # oldest dispensing row first, with no date rejection.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS production_dept_migrations (
                name VARCHAR(100) NOT NULL PRIMARY KEY,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        done_v4 = conn.execute(
            "SELECT 1 FROM production_dept_migrations WHERE name='dsp_id_relink_v4'"
        ).fetchone()
        if not done_v4:
            # Full reset: clear every dsp_id link in both tables and rebuild from
            # scratch with the v4 nearest-date matching below. Safe because the
            # matching is deterministic — a correct real-time link is reproduced.
            conn.execute("UPDATE production_summary SET dsp_id=NULL")
            conn.execute("UPDATE production_dept_log SET dsp_id=NULL WHERE status='In Process'")
            conn.commit()
            _need_backfill = True

        if _need_backfill:
            # Relink old In-Process and Completed records to their dispensing row.
            # IMPORTANT: one dispense id can have MULTIPLE records against it
            # (e.g. several TRS / partial completions). So we distribute by
            # QUANTITY, not one-row-per-record: each dispensing row absorbs
            # records (summing their qty) up to its `dispensed` capacity, then
            # the next record overflows to the next same-name dispensing row.
            try:
                def _num(x):
                    try: return round(float(x), 3)
                    except (TypeError, ValueError): return None

                from datetime import date as _date
                def _daydiff(a, b):
                    """Absolute day distance between two YYYY-MM-DD strings."""
                    try:
                        ya, ma, da = (int(p) for p in a[:10].split('-'))
                        yb, mb, db = (int(p) for p in b[:10].split('-'))
                        return abs((_date(ya, ma, da) - _date(yb, mb, db)).days)
                    except Exception:
                        return 9999

                # Dispensing rows grouped by upper(name), oldest first, each with
                # a remaining capacity = dispensed.
                dsp_rows = conn.execute(
                    "SELECT id, batch_name, batch_size, batch_date, "
                    "       COALESCE(dispensed,0) AS dispensed "
                    "FROM daily_dsp_summary ORDER BY batch_date ASC, id ASC"
                ).fetchall()
                by_name = {}
                for d in dsp_rows:
                    d = dict(d)
                    d['_cap'] = max(0, int(d['dispensed'] or 0))
                    by_name.setdefault((d['batch_name'] or '').strip().upper(), []).append(d)

                def _assign(name, size, ref_day, qty):
                    """Pick a dispensing row id for this record. Among same-name
                    rows that still have capacity, prefer the one whose batch_date
                    is closest to the record's date (ref_day), preferring dates
                    ON/BEFORE the record (you dispense before you complete), and
                    preferring a matching size. Falls back to any same-name row
                    so nothing is left unlinked. Consumes qty from its capacity."""
                    qty = max(1, int(qty or 1))
                    cands = by_name.get((name or '').strip().upper(), [])
                    want = _num(size)

                    def _date_key(d):
                        dd = str(d.get('batch_date') or '')[:10]
                        if ref_day and dd:
                            if dd <= ref_day:
                                return (0, _daydiff(ref_day, dd))   # closest earlier = best
                            return (1, _daydiff(dd, ref_day))       # after completion = worst
                        return (2, 0)

                    p1 = [d for d in cands if d['_cap'] > 0 and (want is None or _num(d['batch_size']) == want)]
                    p2 = [d for d in cands if d['_cap'] > 0]
                    p3 = [d for d in cands if (want is None or _num(d['batch_size']) == want)] or cands
                    pool = p1 or p2 or p3
                    if not pool:
                        return None
                    best = min(pool, key=_date_key)
                    if best['_cap'] > 0:
                        best['_cap'] -= qty
                    return best['id']

                # Completed first (older events), then In Process. Process oldest
                # first within each so capacity fills in chronological order.
                comp_rows = conn.execute(
                    "SELECT id, batch_name, batch_size, "
                    "       COALESCE(total_completed,1) AS qty, "
                    "       DATE(completed_at) AS rday FROM production_summary "
                    "WHERE dsp_id IS NULL ORDER BY completed_at ASC, id ASC"
                ).fetchall()
                for c in comp_rows:
                    c = dict(c)
                    did = _assign(c['batch_name'], c['batch_size'], str(c.get('rday') or '')[:10], c['qty'])
                    if did is not None:
                        conn.execute(
                            "UPDATE production_summary SET dsp_id=%s WHERE id=%s",
                            (did, c['id'])
                        )

                ip_rows = conn.execute(
                    "SELECT id, batch_name, batch_size, "
                    "       COALESCE(batches_processed,1) AS qty, "
                    "       DATE(processing_datetime) AS rday FROM production_dept_log "
                    "WHERE status='In Process' AND dsp_id IS NULL "
                    "ORDER BY processing_datetime ASC, id ASC"
                ).fetchall()
                for ip in ip_rows:
                    ip = dict(ip)
                    did = _assign(ip['batch_name'], ip['batch_size'], str(ip.get('rday') or '')[:10], ip['qty'])
                    if did is not None:
                        conn.execute(
                            "UPDATE production_dept_log SET dsp_id=%s WHERE id=%s",
                            (did, ip['id'])
                        )

                conn.commit()
                conn.execute(
                    "INSERT IGNORE INTO production_dept_migrations (name) VALUES ('dsp_id_relink_v4')"
                )
                conn.commit()
            except Exception:
                conn.rollback()
    except Exception:
        pass
    conn.close()

_ensure_prod_dept_tables()


# ── daily_dsp_summary: get all rows for left table ────────────────────────

def cms_get_receivables(category_filter=""):
    """
    Receivables: parties who owe HCP money (outstanding > 0).
    Groups by employee/party with total given, total recovered, and net outstanding.
    Returns sorted by outstanding DESC.
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    where = "WHERE 1=1"
    params = []
    if category_filter:
        where += " AND e.category = %s"
        params.append(category_filter)

    cur.execute(f"""
        SELECT
            e.id,
            e.name,
            e.category,
            e.department,
            e.wa_number,
            COALESCE(SUM(CASE WHEN l.txn_type = 'given'          THEN l.amount ELSE 0 END), 0) AS total_given,
            COALESCE(SUM(CASE WHEN l.txn_type IN ('repaid','expense_deduct') THEN l.amount ELSE 0 END), 0) AS total_recovered,
            COALESCE(SUM(CASE WHEN l.txn_type = 'given'          THEN l.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN l.txn_type IN ('repaid','expense_deduct') THEN l.amount ELSE 0 END), 0)
            AS outstanding,
            GROUP_CONCAT(DISTINCT l.loan_account ORDER BY l.loan_account SEPARATOR ', ') AS loan_accounts
        FROM cms_employees e
        LEFT JOIN cms_loans l ON l.employee_id = e.id
        {where}
        GROUP BY e.id
        HAVING outstanding > 0.005
        ORDER BY outstanding DESC
    """, params)
    rows = [dict(r) for r in cur.fetchall()]
    total = sum(float(r["outstanding"]) for r in rows)
    conn.close()
    return {"rows": rows, "total": total, "count": len(rows)}


def cms_get_payables(category_filter=""):
    """
    Payables: parties HCP owes money to (outstanding < 0 = credit balance).
    This happens when party has overpaid or HCP owes them.
    Returns sorted by |outstanding| DESC.
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    where = "WHERE 1=1"
    params = []
    if category_filter:
        where += " AND e.category = %s"
        params.append(category_filter)

    cur.execute(f"""
        SELECT
            e.id,
            e.name,
            e.category,
            e.department,
            e.wa_number,
            COALESCE(SUM(CASE WHEN l.txn_type = 'given'          THEN l.amount ELSE 0 END), 0) AS total_given,
            COALESCE(SUM(CASE WHEN l.txn_type IN ('repaid','expense_deduct') THEN l.amount ELSE 0 END), 0) AS total_recovered,
            COALESCE(SUM(CASE WHEN l.txn_type = 'given'          THEN l.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN l.txn_type IN ('repaid','expense_deduct') THEN l.amount ELSE 0 END), 0)
            AS outstanding,
            GROUP_CONCAT(DISTINCT l.loan_account ORDER BY l.loan_account SEPARATOR ', ') AS loan_accounts
        FROM cms_employees e
        LEFT JOIN cms_loans l ON l.employee_id = e.id
        {where}
        GROUP BY e.id
        HAVING outstanding < -0.005
        ORDER BY outstanding ASC
    """, params)
    rows = [dict(r) for r in cur.fetchall()]
    # outstanding is negative, so payable amount is ABS(outstanding)
    for r in rows:
        r["payable"] = abs(float(r["outstanding"]))
    total = sum(r["payable"] for r in rows)
    conn.close()
    return {"rows": rows, "total": total, "count": len(rows)}


def cms_get_loan_accounts():
    """Return all distinct loan account names for the dropdown."""
    conn = get_db_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT DISTINCT loan_account FROM cms_loans
        WHERE loan_account IS NOT NULL AND loan_account != ''
        ORDER BY loan_account
    """)
    accounts = [r["loan_account"] for r in cur.fetchall()]
    conn.close()
    return {"accounts": accounts}



def cms_get_loan_account_summary():
    """
    Summary of all loan accounts (grouped by loan_account tag).
    Returns each account with party count, total given, total recovered, outstanding.
    """
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("""
        SELECT
            COALESCE(l.loan_account, 'General Advances') AS loan_account,
            COUNT(DISTINCT l.employee_id)                 AS party_count,
            COALESCE(SUM(CASE WHEN l.txn_type='given'                     THEN l.amount ELSE 0 END),0) AS total_given,
            COALESCE(SUM(CASE WHEN l.txn_type IN('repaid','expense_deduct') THEN l.amount ELSE 0 END),0) AS total_recovered,
            COALESCE(SUM(CASE WHEN l.txn_type='given'                     THEN l.amount ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN l.txn_type IN('repaid','expense_deduct') THEN l.amount ELSE 0 END),0)
            AS outstanding
        FROM cms_loans l
        GROUP BY COALESCE(l.loan_account, 'General Advances')
        ORDER BY outstanding DESC
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"accounts": rows}


def cms_get_loan_account_detail(account, employee_id=None, from_date="", to_date=""):
    """
    Detailed transactions for a specific loan account tag.
    Returns all given/repaid rows for parties under this account,
    with running balance computed in Python.
    """
    conn = get_db_connection(); cur = conn.cursor()

    where_clauses = ["COALESCE(l.loan_account,'General Advances') = %s"]
    params = [account]

    if employee_id:
        where_clauses.append("l.employee_id = %s")
        params.append(employee_id)
    if from_date:
        where_clauses.append("l.date >= %s")
        params.append(from_date)
    if to_date:
        where_clauses.append("l.date <= %s")
        params.append(to_date)

    where = "WHERE " + " AND ".join(where_clauses)

    cur.execute(f"""
        SELECT l.*, e.name AS employee_name, e.category, e.wa_number
        FROM cms_loans l
        LEFT JOIN cms_employees e ON l.employee_id = e.id
        {where}
        ORDER BY l.date ASC, l.id ASC
    """, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"rows": rows, "account": account}


def prod_dept_get_dsp_batches(is_admin=False):
    """
    Return dispensing rows for the left "Dispensed Batches" grid.

    Source of truth: daily_dsp_summary.dispensed = the quantity (no. of batches)
    RM Store dispensed for that batch.

    Countdown rule (applies to ALL batches):
        pending = dispensed - (qty taken into In Process + qty Completed)
    The qty taken is what the production operator entered when moving the batch
    into the In Process grid (production_dept_log.batches_processed), plus what
    has since been completed (production_summary.total_completed). The row stays
    in the grid showing `pending`, and disappears only when pending reaches 0.
    Matching is per dispensing row via dsp_id (set when the operator moves a
    batch into process / completes it).

    Admin-hidden batches (production_dept_hidden_dsp) are excluded entirely for
    non-admin users (grid + KPI count). Admins still receive them, flagged with
    _hidden=True, but the UI shows them only in the Hidden Records modal.
    """
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT id, batch_name, batch_date, batch_size, dispensed, no_of_batches,
               remaining, batch_id
        FROM daily_dsp_summary
        ORDER BY batch_date DESC, id DESC
    """).fetchall()
    rows = [dict(r) for r in rows]

    # Quantity taken per dispensing row: In Process (entered qty) + Completed.
    taken_recs = conn.execute("""
        SELECT dsp_id, COALESCE(batches_processed,1) AS qty
        FROM production_dept_log
        WHERE status='In Process' AND dsp_id IS NOT NULL
        UNION ALL
        SELECT dsp_id, COALESCE(total_completed,1) AS qty
        FROM production_summary
        WHERE dsp_id IS NOT NULL
    """).fetchall()
    conn.close()

    taken_qty_by_id = {}
    for r in taken_recs:
        r = dict(r)
        taken_qty_by_id[r['dsp_id']] = taken_qty_by_id.get(r['dsp_id'], 0) + int(r['qty'] or 1)

    # Admin-hidden dispensing rows (server-side, shared)
    hidden_ids = _hidden_dsp_get()

    total = len(rows)
    out = []
    for r in rows:
        dispensed = int(r.get('dispensed') or 0)
        pending = max(0, dispensed - taken_qty_by_id.get(r['id'], 0))
        r['pending'] = pending
        r['_total_dsp_count'] = total
        if pending <= 0:
            continue  # fully taken into process -> stop showing
        if r['id'] in hidden_ids:
            if not is_admin:
                continue  # admin-hidden -> excluded for non-admins
            r['_hidden'] = True
        out.append(r)
    return out


# ── production_dept_log: add / list / complete ────────────────────────────
def prod_dept_log_add(dsp_id, batch_name, batch_size, operator_name,
                      batches_processed, remarks, processing_datetime, created_by,
                      product_code=None):
    conn = get_db_connection()
    conn.execute("""
        INSERT INTO production_dept_log
            (dsp_id, batch_name, batch_size, product_code, operator_name, batches_processed,
             status, remarks, processing_datetime, created_by)
        VALUES (%s,%s,%s,%s,%s,%s,'In Process',%s,%s,%s)
    """, (dsp_id, batch_name, batch_size, product_code or None, operator_name or None,
          batches_processed, remarks or None, processing_datetime, created_by))
    conn.commit()
    conn.close()


def prod_dept_log_get():
    """Return all In Process rows from production_dept_log."""
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT id, dsp_id, batch_name, batch_size, product_code, operator_name,
               batches_processed, status, remarks, processing_datetime, created_at
        FROM production_dept_log
        WHERE status = 'In Process'
        ORDER BY processing_datetime DESC, id DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def prod_dept_log_complete(log_id, completed_datetime, created_by, trs_no=None):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT * FROM production_dept_log WHERE id=%s", (log_id,)
    ).fetchone()
    if not row:
        conn.close()
        return None
    row = dict(row)
    conn.execute("""
        INSERT INTO production_summary
            (log_id, dsp_id, batch_name, batch_size, product_code, trs_no, total_completed,
             processing_datetime, completed_at, operator_name, created_by)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (log_id, row.get('dsp_id'), row['batch_name'], row['batch_size'],
          row.get('product_code'), trs_no or None, row.get('batches_processed'),
          completed_datetime, completed_datetime, row.get('operator_name'), created_by))
    conn.commit()
    conn.execute("DELETE FROM production_dept_log WHERE id=%s", (log_id,))
    conn.commit()
    conn.close()
    return True


def prod_dept_log_update(log_id, operator_name, batches_processed, remarks, product_code=None):
    """Update editable fields on a production_dept_log row."""
    conn = get_db_connection()
    conn.execute("""
        UPDATE production_dept_log
           SET operator_name=%s, batches_processed=%s, remarks=%s, product_code=%s
         WHERE id=%s
    """, (operator_name or None, batches_processed, remarks or None, product_code or None, log_id))
    conn.commit()
    conn.close()


def prod_dept_log_delete(log_id):
    """Delete a row from production_dept_log."""
    conn = get_db_connection()
    conn.execute("DELETE FROM production_dept_log WHERE id=%s", (log_id,))
    conn.commit()
    conn.close()


# ── production_summary: query ─────────────────────────────────────────────
def prod_dept_summary_by_date(date_str=''):
    """Return summary rows for a given date (YYYY-MM-DD). Empty = all."""
    conn = get_db_connection()
    if date_str:
        rows = conn.execute("""
            SELECT id, batch_name, batch_size, product_code, trs_no,
                   sample_qty, appearance, odour, bulk_obtained, total_containers,
                   total_completed, processing_datetime, operator_name
            FROM production_summary
            WHERE DATE(processing_datetime) = %s
            ORDER BY processing_datetime DESC
        """, (date_str,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT id, batch_name, batch_size, product_code, trs_no,
                   sample_qty, appearance, odour, bulk_obtained, total_containers,
                   total_completed, processing_datetime, operator_name
            FROM production_summary
            ORDER BY processing_datetime DESC
            LIMIT 200
        """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def prod_dept_summary_all(from_date='', to_date=''):
    """Return all summary rows optionally filtered by date range."""
    conn = get_db_connection()
    where = []
    params = []
    if from_date:
        where.append("DATE(processing_datetime) >= %s")
        params.append(from_date)
    if to_date:
        where.append("DATE(processing_datetime) <= %s")
        params.append(to_date)
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(f"""
        SELECT id, batch_name, batch_size, product_code, trs_no,
               sample_qty, appearance, odour, bulk_obtained, total_containers,
               total_completed, processing_datetime, operator_name
        FROM production_summary
        {clause}
        ORDER BY processing_datetime DESC
    """, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def prod_dept_trs_check(trs_no):
    """Return True if trs_no already exists in production_summary."""
    conn = get_db_connection()
    row = conn.execute(
        "SELECT id FROM production_summary WHERE trs_no=%s LIMIT 1", (trs_no,)
    ).fetchone()
    conn.close()
    return row is not None

def prod_dept_last_product_code(batch_name: str) -> str | None:
    """
    Return the most recently used product_code for the given batch_name,
    searching production_summary first, then production_dept_log.
    Returns None if no previous code found.
    """
    conn = get_db_connection()
    # Check production_summary (completed records — most reliable)
    row = conn.execute(
        """SELECT product_code FROM production_summary
             WHERE batch_name=%s AND product_code IS NOT NULL AND product_code != ''
             ORDER BY id DESC LIMIT 1""",
        (batch_name,)
    ).fetchone()
    if row:
        conn.close()
        return row['product_code']
    # Fall back to in-process log
    row = conn.execute(
        """SELECT product_code FROM production_dept_log
             WHERE batch_name=%s AND product_code IS NOT NULL AND product_code != ''
             ORDER BY id DESC LIMIT 1""",
        (batch_name,)
    ).fetchone()
    if row:
        conn.close()
        return row['product_code']
    # Fall back to procurement_formulations
    row = conn.execute(
        """SELECT product_code FROM procurement_formulations
             WHERE batch_name=%s AND product_code IS NOT NULL AND product_code != ''
             ORDER BY id DESC LIMIT 1""",
        (batch_name,)
    ).fetchone()
    conn.close()
    return row['product_code'] if row else None


def prod_dept_next_trs_no():
    """
    Return the next available TRS/PD/YY-YY/NNNN number.
    Finds the highest number used in production_summary for the current
    financial year (April-March) and returns max+1.
    """
    today = datetime.now()
    if today.month >= 4:
        start_year, end_year = today.year, today.year + 1
    else:
        start_year, end_year = today.year - 1, today.year
    fy     = f"{str(start_year)[-2:]}-{str(end_year)[-2:]}"
    prefix = f"TRS/PD/{fy}/"
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT trs_no FROM production_summary WHERE trs_no LIKE %s",
        (prefix + "%",)
    ).fetchall()
    conn.close()
    max_no = 0
    for r in rows:
        try:
            n = int(r["trs_no"].split("/")[-1])
            if n > max_no:
                max_no = n
        except (ValueError, IndexError):
            pass
    next_no = max_no + 1
    return {"trs_no": prefix + str(next_no).zfill(4), "prefix": prefix, "next_seq": next_no}


def prod_dept_summary_trs_save(summary_id, trs_no, sample_qty=None,
                               appearance=None, odour=None, bulk_obtained=None):
    """Save trs_no, sample_qty, appearance, odour, bulk_obtained for a production_summary row."""
    conn = get_db_connection()
    conn.execute(
        """UPDATE production_summary
               SET trs_no=%s, sample_qty=%s, appearance=%s, odour=%s, bulk_obtained=%s
             WHERE id=%s""",
        (trs_no or None, sample_qty, appearance or None, odour or None, bulk_obtained, summary_id)
    )
    conn.commit()
    conn.close()
    return True


def prod_dept_save_containers(summary_id, total_containers):
    """Save total_containers for a production_summary row."""
    conn = get_db_connection()
    conn.execute(
        "UPDATE production_summary SET total_containers=%s WHERE id=%s",
        (int(total_containers) if total_containers else None, summary_id)
    )
    conn.commit()
    conn.close()
    return True


def prod_dept_summary_stats():
    """Return count completed today and total all-time."""
    conn = get_db_connection()
    today = datetime.now().strftime('%Y-%m-%d')
    t = conn.execute(
        "SELECT COUNT(*) AS c FROM production_summary WHERE DATE(processing_datetime)=%s",
        (today,)
    ).fetchone()
    a = conn.execute(
        "SELECT COUNT(*) AS c FROM production_summary"
    ).fetchone()
    conn.close()
    return {'today': int(t['c']) if t else 0, 'total': int(a['c']) if a else 0}

def prod_dept_summary_delete(summary_id: int, restored_by: str):
    """
    Delete a row from production_summary and re-insert it back into
    production_dept_log as 'In Process' so user can re-process it.
    Returns the new log id, or None if not found.
    """
    conn = get_db_connection()
    row = conn.execute(
        "SELECT * FROM production_summary WHERE id=%s", (summary_id,)
    ).fetchone()
    if not row:
        conn.close()
        return None
    row = dict(row)
    # Re-insert into production_dept_log
    conn.execute("""
        INSERT INTO production_dept_log
            (dsp_id, batch_name, batch_size, product_code, operator_name, batches_processed,
             status, remarks, processing_datetime, created_by)
        VALUES (%s,%s,%s,%s,%s,%s,'In Process',NULL,%s,%s)
    """, (None, row['batch_name'], row['batch_size'],
          row.get('product_code'), row.get('operator_name'), row.get('total_completed'),
          row.get('processing_datetime'), restored_by))
    conn.commit()
    # Delete from summary
    conn.execute("DELETE FROM production_summary WHERE id=%s", (summary_id,))
    conn.commit()
    conn.close()
    return True


# ══════════════════════════════════════════════════════════════════════════════
# QC DASHBOARD — PATCH: prod_dept_summary_all (override to include completed_at)
# ══════════════════════════════════════════════════════════════════════════════

def prod_dept_summary_all(from_date='', to_date=''):
    """Return all summary rows optionally filtered by date range.
    Overrides the earlier definition — also returns completed_at column."""
    conn = get_db_connection()
    where, params = [], []
    if from_date:
        where.append("DATE(completed_at) >= %s")
        params.append(from_date)
    if to_date:
        where.append("DATE(completed_at) <= %s")
        params.append(to_date)
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(f"""
        SELECT id, batch_name, batch_size, product_code, trs_no,
               sample_qty, appearance, odour, bulk_obtained, total_containers,
               total_completed, processing_datetime,
               completed_at, operator_name, created_by
        FROM production_summary
        {clause}
        ORDER BY completed_at DESC, id DESC
    """, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]




# ══════════════════════════════════════════════════════════════════════════════
# PAGE ROUTE
# ══════════════════════════════════════════════════════════════════════════════

@production_dept_bp.route('/production_dept')
@_login_required
def production_dept_page():
    if not _can_prod_dept():
        return _denied('Production Department')
    return render_template('production_department.html')


# ══════════════════════════════════════════════════════════════════════════════
# API ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@production_dept_bp.route('/api/production_dept/dsp_batches')
@_login_required
def api_prod_dept_dsp_batches():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        return jsonify({'status': 'ok', 'rows': prod_dept_get_dsp_batches(is_admin=_is_admin())})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


@production_dept_bp.route('/api/production_dept/dsp_signal')
@_login_required
def api_prod_dept_dsp_signal():
    """Cheap change-detector for the Dispensed Batches grid. Returns the row
    count and max id of daily_dsp_summary so the client can refresh the grid
    only when RM Store actually adds a new dispensing record (instead of
    polling the full grid)."""
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = get_db_connection()
        row = conn.execute(
            "SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM daily_dsp_summary"
        ).fetchone()
        conn.close()
        return jsonify({'status': 'ok', 'count': int(row['c']), 'maxid': int(row['m'])})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/log')
@_login_required
def api_prod_dept_log():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        return jsonify({'status': 'ok', 'rows': prod_dept_log_get()})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e), 'rows': []}), 500


@production_dept_bp.route('/api/production_dept/log_add', methods=['POST'])
@_login_required
def api_prod_dept_log_add():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    try:
        prod_dept_log_add(
            dsp_id              = d.get('dsp_id'),
            batch_name          = d.get('batch_name', ''),
            batch_size          = d.get('batch_size'),
            operator_name       = d.get('operator_name', ''),
            batches_processed   = d.get('batches_processed'),
            remarks             = d.get('remarks', ''),
            processing_datetime = d.get('processing_datetime'),
            created_by          = session.get('UID', ''),
            product_code        = d.get('product_code', ''),
        )
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/log_complete', methods=['POST'])
@_login_required
def api_prod_dept_log_complete():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    log_id = d.get('id')
    if not log_id:
        return jsonify({'status': 'error', 'message': 'Missing id'})
    try:
        result = prod_dept_log_complete(
            log_id             = int(log_id),
            completed_datetime = d.get('completed_datetime'),
            created_by         = session.get('UID', ''),
            trs_no             = d.get('trs_no') or None,
        )
        if result:
            return jsonify({'status': 'ok'})
        return jsonify({'status': 'error', 'message': 'Record not found'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/log_update', methods=['POST'])
@_login_required
def api_prod_dept_log_update():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    log_id = d.get('id')
    if not log_id:
        return jsonify({'status': 'error', 'message': 'Missing id'})
    try:
        prod_dept_log_update(
            log_id            = int(log_id),
            operator_name     = d.get('operator_name', ''),
            batches_processed = d.get('batches_processed'),
            remarks           = d.get('remarks', ''),
            product_code      = d.get('product_code', ''),
        )
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/log_delete', methods=['POST'])
@_login_required
def api_prod_dept_log_delete():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    if datetime.now().hour < 11:
        return jsonify({'status': 'error', 'message': 'Delete is not allowed before 11:00 AM.'})
    d = request.get_json() or {}
    log_id = d.get('id')
    if not log_id:
        return jsonify({'status': 'error', 'message': 'Missing id'})
    try:
        prod_dept_log_delete(int(log_id))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/summary_containers_save', methods=['POST'])
@_login_required
def api_prod_dept_summary_containers_save():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    summary_id = d.get('id')
    if not summary_id:
        return jsonify({'status': 'error', 'message': 'Missing id'})
    try:
        prod_dept_save_containers(int(summary_id), d.get('total_containers'))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/summary')
@_login_required
def api_prod_dept_summary():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    date_str = request.args.get('date', '')
    rows = prod_dept_summary_by_date(date_str)
    return jsonify({'status': 'ok', 'rows': rows})


@production_dept_bp.route('/api/production_dept/summary_stats')
@_login_required
def api_prod_dept_summary_stats():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    return jsonify(prod_dept_summary_stats())


@production_dept_bp.route('/api/production_dept/summary_delete', methods=['POST'])
@_login_required
def api_prod_dept_summary_delete():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    if datetime.now().hour < 11:
        return jsonify({'status': 'error', 'message': 'Delete is not allowed before 11:00 AM.'}), 403
    d = request.get_json() or {}
    ids = d.get('ids', [])
    if not ids:
        return jsonify({'status': 'error', 'message': 'No ids provided'})
    try:
        for sid in ids:
            prod_dept_summary_delete(int(sid), session.get('UID', ''))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/trs_check')
@_login_required
def api_prod_dept_trs_check():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    trs_no = request.args.get('trs_no', '').strip()
    if not trs_no:
        return jsonify({'exists': False})
    exists = prod_dept_trs_check(trs_no)
    return jsonify({'exists': exists})


@production_dept_bp.route('/api/production_dept/next_trs_no')
@_login_required
def api_prod_dept_next_trs_no():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        result = prod_dept_next_trs_no()
        return jsonify({'status': 'ok', **result})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/last_product_code')
@_login_required
def api_prod_dept_last_product_code():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    batch_name = request.args.get('batch_name', '').strip()
    if not batch_name:
        return jsonify({'product_code': None})
    try:
        code = prod_dept_last_product_code(batch_name)
        return jsonify({'product_code': code})
    except Exception as e:
        return jsonify({'product_code': None, 'error': str(e)})


@production_dept_bp.route('/api/production_dept/summary_trs_save', methods=['POST'])
@_login_required
def api_prod_dept_summary_trs_save():
    if not _can_prod_dept():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    summary_id     = d.get('id')
    trs_no         = (d.get('trs_no') or '').strip()
    sample_qty_raw = d.get('sample_qty')
    sample_qty     = None
    if sample_qty_raw not in (None, ''):
        try:
            sample_qty = float(str(sample_qty_raw).strip())
        except (ValueError, TypeError):
            sample_qty = None
    if not summary_id or not trs_no:
        return jsonify({'status': 'error', 'message': 'Missing id or trs_no'})
    try:
        conn_check = get_db_connection()
        row = conn_check.execute(
            "SELECT id FROM production_summary WHERE trs_no=%s AND id != %s LIMIT 1",
            (trs_no, int(summary_id))
        ).fetchone()
        conn_check.close()
        if row:
            return jsonify({'status': 'error',
                            'message': f'TRS No. "{trs_no}" is already used by another record.'})
        appearance    = (d.get('appearance') or '').strip() or None
        odour         = (d.get('odour') or '').strip() or None
        bulk_raw      = d.get('bulk_obtained')
        bulk_obtained = None
        if bulk_raw not in (None, ''):
            try:
                bulk_obtained = round(float(str(bulk_raw).strip()), 3)
            except (ValueError, TypeError):
                bulk_obtained = None
        prod_dept_summary_trs_save(int(summary_id), trs_no, sample_qty, appearance, odour, bulk_obtained)
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/summary_all')
@_login_required
def api_prod_dept_summary_all():
    if not _can_prod_dept() and not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    role      = session.get('User_Type', '')
    from_date = request.args.get('from', '')
    to_date   = request.args.get('to', '')
    if (role or '').lower() == 'qc_common':
        from_date = '2026-03-16'
    rows = prod_dept_summary_all(from_date, to_date)
    return jsonify({'status': 'ok', 'rows': rows})


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN PINNED RECORDS
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_pinned_table():
    conn = get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS admin_pinned_records (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            grid_name  VARCHAR(50)  NOT NULL,
            record_id  INT          NOT NULL,
            pinned_by  VARCHAR(100) DEFAULT '',
            pinned_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_grid_record (grid_name, record_id)
        )
    """)
    conn.commit()
    conn.close()

_ensure_pinned_table()


# ══════════════════════════════════════════════════════════════════════════════
# ADMIN-HIDDEN DISPENSING BATCHES (server-side, shared across all users)
# A batch hidden here is removed from Dispensing Records for non-admin users
# (both the grid and the KPI count). Admins still see it, flagged as HIDDEN.
# ══════════════════════════════════════════════════════════════════════════════

def _ensure_hidden_dsp_table():
    conn = get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS production_dept_hidden_dsp (
            dsp_id     INT          NOT NULL PRIMARY KEY,
            hidden_by  VARCHAR(100) DEFAULT '',
            hidden_at  DATETIME     DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

_ensure_hidden_dsp_table()


def _hidden_dsp_get():
    conn = get_db_connection()
    rows = conn.execute("SELECT dsp_id FROM production_dept_hidden_dsp").fetchall()
    conn.close()
    return {r['dsp_id'] for r in rows}


def _hidden_dsp_toggle(dsp_id, hidden_by=''):
    """Toggle a batch's hidden state. Returns True if now hidden, False if released."""
    conn = get_db_connection()
    exists = conn.execute(
        "SELECT 1 FROM production_dept_hidden_dsp WHERE dsp_id=%s", (int(dsp_id),)
    ).fetchone()
    if exists:
        conn.execute("DELETE FROM production_dept_hidden_dsp WHERE dsp_id=%s", (int(dsp_id),))
        now_hidden = False
    else:
        conn.execute(
            "INSERT IGNORE INTO production_dept_hidden_dsp (dsp_id, hidden_by) VALUES (%s,%s)",
            (int(dsp_id), hidden_by)
        )
        now_hidden = True
    conn.commit()
    conn.close()
    return now_hidden


def _pinned_get(grid_name):
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT record_id FROM admin_pinned_records WHERE grid_name=%s", (grid_name,)
    ).fetchall()
    conn.close()
    return [r['record_id'] for r in rows]


def _pinned_set(grid_name, record_ids, pinned_by=''):
    conn = get_db_connection()
    conn.execute("DELETE FROM admin_pinned_records WHERE grid_name=%s", (grid_name,))
    for rid in record_ids:
        conn.execute(
            "INSERT IGNORE INTO admin_pinned_records (grid_name, record_id, pinned_by) VALUES (%s,%s,%s)",
            (grid_name, int(rid), pinned_by)
        )
    conn.commit()
    conn.close()


def _pinned_search(grid_name, q=''):
    conn = get_db_connection()
    like = f'%{q}%'
    if grid_name == 'dispensed':
        rows = conn.execute(
            "SELECT id, batch_name, batch_date, batch_size FROM daily_dsp_summary "
            "WHERE batch_name LIKE %s ORDER BY batch_date DESC, id DESC LIMIT 50",
            (like,)
        ).fetchall()
    elif grid_name == 'inprocess':
        rows = conn.execute(
            "SELECT id, batch_name, product_code, processing_datetime FROM production_dept_log "
            "WHERE batch_name LIKE %s ORDER BY processing_datetime DESC, id DESC LIMIT 50",
            (like,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, batch_name, product_code, trs_no, processing_datetime FROM production_summary "
            "WHERE batch_name LIKE %s OR trs_no LIKE %s ORDER BY processing_datetime DESC, id DESC LIMIT 50",
            (like, like)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _is_admin():
    return session.get('User_Type', '') == 'admin'


@production_dept_bp.route('/api/production_dept/hidden_dsp/get')
@_login_required
def api_hidden_dsp_get():
    if not _can_prod_dept() and not _is_admin():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    return jsonify({'status': 'ok', 'ids': sorted(_hidden_dsp_get())})


@production_dept_bp.route('/api/production_dept/hidden_dsp/toggle', methods=['POST'])
@_login_required
def api_hidden_dsp_toggle():
    if not _is_admin():
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    data = request.get_json(silent=True) or {}
    dsp_id = data.get('dsp_id')
    if dsp_id is None:
        return jsonify({'status': 'error', 'message': 'Missing dsp_id'}), 400
    try:
        now_hidden = _hidden_dsp_toggle(dsp_id, session.get('Username', '') or session.get('User_Type', ''))
        return jsonify({'status': 'ok', 'hidden': now_hidden})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/pinned/get')
@_login_required
def api_pinned_get():
    if not _can_prod_dept() and not _is_admin():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    grid = request.args.get('grid', '').strip()
    if not grid:
        return jsonify({'status': 'error', 'message': 'Missing grid'}), 400
    return jsonify({'status': 'ok', 'ids': _pinned_get(grid)})


@production_dept_bp.route('/api/production_dept/pinned/set', methods=['POST'])
@_login_required
def api_pinned_set():
    if not _is_admin():
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    d = request.get_json() or {}
    grid = (d.get('grid') or '').strip()
    ids  = d.get('ids', [])
    if not grid:
        return jsonify({'status': 'error', 'message': 'Missing grid'}), 400
    try:
        _pinned_set(grid, ids, pinned_by=session.get('UID', ''))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


@production_dept_bp.route('/api/production_dept/pinned/search')
@_login_required
def api_pinned_search():
    if not _is_admin():
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    grid = request.args.get('grid', '').strip()
    q    = request.args.get('q', '').strip()
    if grid not in ('dispensed', 'inprocess', 'completed', 'summary'):
        return jsonify({'status': 'error', 'message': 'Unknown grid'}), 400
    return jsonify({'status': 'ok', 'rows': _pinned_search(grid, q)})
