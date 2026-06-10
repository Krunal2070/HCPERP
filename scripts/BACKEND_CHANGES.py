"""
╔══════════════════════════════════════════════════════════════════════════════╗
║           QC DASHBOARD — BACKEND CHANGES (FINAL)                           ║
║                                                                              ║
║  TWO SECTIONS:                                                               ║
║    A) sampling_portal.py  — append all code to the bottom of the file       ║
║    B) app.py              — two targeted edits described below               ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

# ═══════════════════════════════════════════════════════════════════════════════
#  SECTION A — APPEND EVERYTHING BELOW TO THE END OF sampling_portal.py
# ═══════════════════════════════════════════════════════════════════════════════

"""
──────────────────────────────────────────────────────────────────────────────
PASTE FROM HERE ↓ to the end of sampling_portal.py
──────────────────────────────────────────────────────────────────────────────

# ══════════════════════════════════════════════════════════════════
# PATCH: prod_dept_summary_all
# The existing function only selects processing_datetime.
# This override also returns completed_at so the QC Dashboard
# can use it for 24-h lock logic and display.
# Because Python resolves the last definition of a function,
# simply pasting this at the BOTTOM of sampling_portal.py is enough.
# ══════════════════════════════════════════════════════════════════

def prod_dept_summary_all(from_date='', to_date=''):
    conn = get_db_connection()
    where, params = [], []
    if from_date:
        where.append("DATE(completed_at) >= %s")
        params.append(from_date)
    if to_date:
        where.append("DATE(completed_at) <= %s")
        params.append(to_date)
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(f'''
        SELECT id, batch_name, batch_size, product_code, trs_no,
               total_completed, processing_datetime,
               completed_at, operator_name, created_by
        FROM production_summary
        {clause}
        ORDER BY completed_at DESC, id DESC
    ''', params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ══════════════════════════════════════════════════════════════════
# QC INPROCESS CHECKS — new table + functions
# ══════════════════════════════════════════════════════════════════

def _ensure_qc_inprocess_table():
    conn = get_db_connection()
    if not conn:
        return
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qc_inprocess_checks (
            id                    INT AUTO_INCREMENT PRIMARY KEY,
            production_summary_id INT NOT NULL,
            qc_status             VARCHAR(50)  DEFAULT 'Pending',
            approved_by           VARCHAR(200) DEFAULT NULL,
            approval_dt           DATETIME     DEFAULT NULL,
            sample_qty            VARCHAR(100) DEFAULT NULL,
            remarks               TEXT         DEFAULT NULL,
            updated_at            DATETIME     DEFAULT CURRENT_TIMESTAMP
                                               ON UPDATE CURRENT_TIMESTAMP,
            created_by            VARCHAR(100) DEFAULT NULL,
            UNIQUE KEY ux_qc_inprocess_summary (production_summary_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    ''')
    conn.commit()
    # Migration guard: add sample_qty if missing in existing DBs
    try:
        cols = conn.execute("SHOW COLUMNS FROM qc_inprocess_checks").fetchall()
        existing = [c['Field'] for c in cols]
        if 'sample_qty' not in existing:
            conn.execute(
                "ALTER TABLE qc_inprocess_checks "
                "ADD COLUMN sample_qty VARCHAR(100) DEFAULT NULL AFTER approval_dt"
            )
            conn.commit()
    except Exception:
        pass
    conn.close()


_ensure_qc_inprocess_table()


def qc_inprocess_get_all():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT * FROM qc_inprocess_checks ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qc_inprocess_save(production_summary_id, qc_status, approved_by,
                      approval_dt, sample_qty, remarks, created_by):
    conn = get_db_connection()
    conn.execute('''
        INSERT INTO qc_inprocess_checks
            (production_summary_id, qc_status, approved_by, approval_dt,
             sample_qty, remarks, updated_at, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, NOW(), %s)
        ON DUPLICATE KEY UPDATE
            qc_status   = VALUES(qc_status),
            approved_by = VALUES(approved_by),
            approval_dt = VALUES(approval_dt),
            sample_qty  = VALUES(sample_qty),
            remarks     = VALUES(remarks),
            updated_at  = NOW()
    ''', (production_summary_id, qc_status, approved_by,
          approval_dt or None, sample_qty, remarks or None, created_by))
    conn.commit()
    row = conn.execute(
        "SELECT id FROM qc_inprocess_checks WHERE production_summary_id = %s",
        (production_summary_id,)
    ).fetchone()
    conn.close()
    return row['id'] if row else None

──────────────────────────────────────────────────────────────────────────────
PASTE ENDS HERE ↑
──────────────────────────────────────────────────────────────────────────────
"""


# ═══════════════════════════════════════════════════════════════════════════════
#  SECTION B — app.py  —  TWO targeted edits
# ═══════════════════════════════════════════════════════════════════════════════

# ──────────────────────────────────────────────────────────────────────────────
# EDIT B-1  ·  ROLE_DEFAULT_PAGES   (around line 159)
#
# FIND exactly:
#
#     'admin':      {'dashboard','rd_sampling','qc_sampling','canteen',
#                    'task_reminders','task_scheduler','manage_users',
#                    'access_control','lunch_coupons','transaction','loan','scrap',
#                    'production_initiater','cms','procurement','production_dept'},
#     ...
#     'QC':         {'dashboard','qc_sampling'},
#
# REPLACE WITH:
#
#     'admin':      {'dashboard','rd_sampling','qc_sampling','canteen',
#                    'task_reminders','task_scheduler','manage_users',
#                    'access_control','lunch_coupons','transaction','loan','scrap',
#                    'production_initiater','cms','procurement','production_dept',
#                    'qc_dashboard'},
#     ...
#     'QC':         {'dashboard','qc_sampling','qc_dashboard'},
#
# (Only 2 lines change — add 'qc_dashboard' to admin set and QC set)
# ──────────────────────────────────────────────────────────────────────────────


# ──────────────────────────────────────────────────────────────────────────────
# EDIT B-2  ·  NEW ROUTES  —  paste just before `if __name__ == '__main__':`
# ──────────────────────────────────────────────────────────────────────────────

"""
──────────────────────────────────────────────────────────────────────────────
PASTE FROM HERE ↓  (just before `if __name__ == '__main__':` at bottom of app.py)
──────────────────────────────────────────────────────────────────────────────

# ══════════════════════════════════════════════════════════════════
# QC DASHBOARD ROUTES
# ══════════════════════════════════════════════════════════════════

def _can_qc_dashboard():
    role = session.get('User_Type', '')
    return role in ('admin', 'QC') or can_access('qc_dashboard')


@app.route('/qc_dashboard')
@login_required
def qc_dashboard_page():
    if not _can_qc_dashboard():
        return _denied('QC Dashboard')
    return render_template('qc_dashboard.html', role=session.get('User_Type', 'User'))


# ── In-Process QC checks — fetch all -─────────────────────────────
@app.route('/api/qc/inprocess_checks')
@login_required
def api_qc_inprocess_checks():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        rows = sampling_portal.qc_inprocess_get_all()
        return jsonify({'status': 'ok', 'rows': rows})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── In-Process QC checks — save (upsert, with 24-h lock) ──────────
@app.route('/api/qc/inprocess_check_save', methods=['POST'])
@login_required
def api_qc_inprocess_check_save():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403

    d           = request.get_json() or {}
    summary_id  = d.get('production_summary_id')
    qc_status   = (d.get('qc_status') or 'Pending').strip()
    approved_by = (d.get('approved_by') or session.get('UID', '')).strip()
    approval_dt = d.get('approval_dt')   # ISO "YYYY-MM-DD HH:MM:SS" or None
    sample_qty  = (d.get('sample_qty') or '').strip() or None
    remarks     = (d.get('remarks') or '').strip()

    if not summary_id:
        return jsonify({'status': 'error', 'message': 'Missing production_summary_id'})

    # 24-hour lock — non-admin users cannot edit after 24 h ────────
    if (session.get('User_Type') or '') != 'admin':
        conn = sampling_portal.get_db_connection()
        existing = conn.execute(
            "SELECT updated_at FROM qc_inprocess_checks "
            "WHERE production_summary_id = %s",
            (summary_id,)
        ).fetchone()
        conn.close()
        if existing and existing['updated_at']:
            from datetime import timedelta
            updated = existing['updated_at']
            if isinstance(updated, str):
                try:
                    updated = datetime.strptime(updated, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    updated = None
            if updated and (datetime.now() - updated) > timedelta(hours=24):
                return jsonify({
                    'status': 'error',
                    'message': (
                        'Locked: this record was last edited over 24 hours ago. '
                        'Contact admin to make changes.'
                    )
                }), 403

    try:
        row_id = sampling_portal.qc_inprocess_save(
            production_summary_id = int(summary_id),
            qc_status   = qc_status,
            approved_by = approved_by,
            approval_dt = approval_dt,
            sample_qty  = sample_qty,
            remarks     = remarks,
            created_by  = session.get('UID', ''),
        )
        return jsonify({'status': 'ok', 'id': row_id})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── QC Sampling — JSON list for dashboard tab ─────────────────────
@app.route('/api/qc_sampling/list')
@login_required
def api_qc_sampling_list():
    if not _can_qc_dashboard():
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    try:
        conn = sampling_portal.get_db_connection()
        rows = conn.execute(
            "SELECT * FROM qc_sampling_records ORDER BY id DESC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'rows': [dict(r) for r in rows]})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── QC Sampling — save (proxies existing save_qc_sampling) ────────
@app.route('/api/qc_sampling/save', methods=['POST'])
@login_required
def api_qc_sampling_save():
    role = session.get('User_Type', '')
    if role not in ('Purchase', 'QC', 'admin'):
        return jsonify({'status': 'error', 'message': 'Access denied'}), 403
    d = request.get_json() or {}
    try:
        sampling_portal.save_qc_sampling(d, role, session.get('UID', ''))
        return jsonify({'status': 'ok'})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ── END QC DASHBOARD ROUTES ───────────────────────────────────────

──────────────────────────────────────────────────────────────────────────────
PASTE ENDS HERE ↑
──────────────────────────────────────────────────────────────────────────────
"""


# ═══════════════════════════════════════════════════════════════════════════════
#  SUMMARY OF ALL CHANGES
# ═══════════════════════════════════════════════════════════════════════════════
"""
FILE                     WHAT TO DO
──────────────────────── ──────────────────────────────────────────────────────
sampling_portal.py       Append SECTION A to the bottom (2 functions + table
                         auto-create + 1 patched function override).

app.py  (2 edits)
  Edit B-1               In ROLE_DEFAULT_PAGES (~line 159):
                           • Add 'qc_dashboard' to 'admin' set
                           • Add 'qc_dashboard' to 'QC' set

  Edit B-2               Paste SECTION B just before the
                         `if __name__ == '__main__':` block at the bottom.
                         Adds 5 new routes:
                           /qc_dashboard              (page)
                           /api/qc/inprocess_checks   (GET)
                           /api/qc/inprocess_check_save (POST, with 24-h lock)
                           /api/qc_sampling/list      (GET)
                           /api/qc_sampling/save      (POST)

templates/               Save qc_dashboard.html here.

Nav/Dashboard            Add a link to /qc_dashboard for admin and QC roles.
──────────────────────── ──────────────────────────────────────────────────────

NOTE on save_qc_sampling field mapping
  The existing save_qc_sampling() reads these keys from the dict:
    id, trs_no, trs_date, item_name, item_category, receipt_date,
    submission_date, supplier_name, manufacturer_name, batch_no,
    received_qty (float), physical_state, rate_per_kg (float),
    approval_status, approval_date, remarks
  The dashboard modal form sends exactly these keys (mapped at saveQCS()).
"""
