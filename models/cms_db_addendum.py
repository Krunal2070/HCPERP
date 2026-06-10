# ══════════════════════════════════════════════════════════════════════════════
# ADDENDUM to cms_sampling_portal_functions.py
#
# Replace / ADD these functions in sampling_portal.py:
# 1. cms_init_db  — add loan_deduct_emp_id column
# 2. cms_save_expense — handle loan deduction
# 3. cms_get_expenses — include loan_deduct_emp_id
# 4. cms_delete_employee — new function
#
# Also add this route to app.py:
#
#   @app.route('/api/cms/employees/delete', methods=['POST'])
#   @login_required
#   def cms_employees_delete():
#       data = request.get_json()
#       result = sampling_portal.cms_delete_employee(data['id'])
#       return jsonify(result)
#
#   Also update /api/cms/income to accept ?id= param for single record fetch:
#   Change cms_get_income to accept an optional rec_id param
# ══════════════════════════════════════════════════════════════════════════════


def cms_init_db():
    """Create all CMS tables if they don't already exist. (UPDATED with loan_deduct_emp_id)"""
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_opening_balance (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    cur.execute("SELECT COUNT(*) FROM cms_opening_balance")
    if cur.fetchone()[0] == 0:
        cur.execute("INSERT INTO cms_opening_balance (amount) VALUES (0)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ob_history (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            old_amount   DECIMAL(15,2),
            new_amount   DECIMAL(15,2),
            changed_by   VARCHAR(100),
            reason       TEXT,
            changed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_income (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            date         DATE NOT NULL,
            source       VARCHAR(120) NOT NULL,
            amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
            gatepass_no  VARCHAR(60),
            remarks      TEXT,
            created_by   VARCHAR(100),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # ── Expenses table — includes loan_deduct_emp_id ─────────────────────────
    # loan_deduct_emp_id: if set, this expense was paid from employee advance.
    # The expense is recorded normally (cash outflow), AND
    # the employee's loan balance is reduced by this amount (since they spent the advance).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_expense (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            date                DATE NOT NULL,
            category            VARCHAR(80) NOT NULL,
            amount              DECIMAL(15,2) NOT NULL DEFAULT 0,
            employee_id         INT,
            loan_deduct_emp_id  INT,
            voucher_no          VARCHAR(60),
            description         TEXT,
            created_by          VARCHAR(100),
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Add column if upgrading from old schema
    try:
        cur.execute("ALTER TABLE cms_expense ADD COLUMN loan_deduct_emp_id INT AFTER employee_id")
        conn.commit()
    except Exception:
        pass  # Column already exists

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_employees (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            name         VARCHAR(120) NOT NULL,
            department   VARCHAR(80),
            wa_number    VARCHAR(20),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()


def cms_get_income(from_date='', to_date='', rec_id=None):
    """Get income records. Supports filtering by date range or single record ID."""
    conn = get_db_connection()
    cur  = conn.cursor()

    if rec_id:
        cur.execute("SELECT * FROM cms_income WHERE id = %s", (rec_id,))
    else:
        q = "SELECT * FROM cms_income WHERE 1=1"
        params = []
        if from_date: q += " AND date >= %s"; params.append(from_date)
        if to_date:   q += " AND date <= %s"; params.append(to_date)
        q += " ORDER BY date DESC, id DESC"
        cur.execute(q, params)

    rows  = [dict(r) for r in cur.fetchall()]
    total = sum(float(r['amount']) for r in rows)
    conn.close()
    return {'records': rows, 'total': total}


def cms_get_expenses(from_date='', to_date='', category='', rec_id=None):
    """Get expense records. Includes employee name and loan deduction employee name."""
    conn = get_db_connection()
    cur  = conn.cursor()

    if rec_id:
        cur.execute("""
            SELECT e.*,
                emp.name  AS employee_name,
                demp.name AS loan_deduct_emp_name
            FROM cms_expense e
            LEFT JOIN cms_employees emp  ON e.employee_id        = emp.id
            LEFT JOIN cms_employees demp ON e.loan_deduct_emp_id = demp.id
            WHERE e.id = %s
        """, (rec_id,))
    else:
        q = """
            SELECT e.*,
                emp.name  AS employee_name,
                demp.name AS loan_deduct_emp_name
            FROM cms_expense e
            LEFT JOIN cms_employees emp  ON e.employee_id        = emp.id
            LEFT JOIN cms_employees demp ON e.loan_deduct_emp_id = demp.id
            WHERE 1=1
        """
        params = []
        if from_date: q += " AND e.date >= %s"; params.append(from_date)
        if to_date:   q += " AND e.date <= %s"; params.append(to_date)
        if category:  q += " AND e.category = %s"; params.append(category)
        q += " ORDER BY e.date DESC, e.id DESC"
        cur.execute(q, params)

    rows  = [dict(r) for r in cur.fetchall()]
    total = sum(float(r['amount']) for r in rows if r['category'] not in ('Employee Repayment',))
    conn.close()
    return {'records': rows, 'total': total}


def cms_save_expense(payload):
    """
    Save or update an expense entry.

    LOAN DEDUCTION LOGIC:
    ─────────────────────
    If loan_deduct_emp_id is set, the employee spent their advance on this purchase.
    We record the expense normally (cash out), and ALSO create an auto
    'Employee Repayment' entry for that employee to reduce their outstanding loan.

    This way:
    - The cash book shows the real expense (e.g. ₹500 parts purchased)
    - The employee's loan balance is reduced (they spent their advance, not company cash)
    - No double-counting: the original cash advance (Employee Loan) already debited cash.
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        rec_id         = payload.get('id')
        emp_id         = payload.get('employee_id') or None
        deduct_emp_id  = payload.get('loan_deduct_emp_id') or None

        if rec_id:
            # Update existing record
            cur.execute("""
                UPDATE cms_expense
                SET date=%s, category=%s, amount=%s, employee_id=%s,
                    loan_deduct_emp_id=%s, voucher_no=%s, description=%s
                WHERE id=%s
            """, (
                payload['date'], payload['category'], payload['amount'],
                emp_id, deduct_emp_id,
                payload.get('voucher_no',''), payload.get('description',''),
                rec_id
            ))
        else:
            # Insert new record
            cur.execute("""
                INSERT INTO cms_expense
                    (date, category, amount, employee_id, loan_deduct_emp_id,
                     voucher_no, description, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                payload['date'], payload['category'], payload['amount'],
                emp_id, deduct_emp_id,
                payload.get('voucher_no',''), payload.get('description',''),
                payload.get('created_by','')
            ))

            # ── AUTO REPAYMENT for loan deduction ────────────────────────────
            # If employee X spent their advance on this expense, create a
            # corresponding repayment entry to reduce their outstanding loan.
            if deduct_emp_id:
                auto_desc = f"[Auto] Deducted: {payload.get('description','') or payload['category']} — {payload['date']}"
                cur.execute("""
                    INSERT INTO cms_expense
                        (date, category, amount, employee_id,
                         voucher_no, description, created_by)
                    VALUES (%s, 'Employee Repayment', %s, %s, %s, %s, %s)
                """, (
                    payload['date'], payload['amount'], deduct_emp_id,
                    payload.get('voucher_no',''), auto_desc,
                    payload.get('created_by','') + ' [auto]'
                ))

        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_delete_employee(emp_id):
    """Delete employee (keeps their expense/loan records for audit)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("DELETE FROM cms_employees WHERE id=%s", (emp_id,))
        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_get_dashboard(from_date='', to_date=''):
    """Dashboard summary with running balance transactions. (UPDATED)"""
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("SELECT amount FROM cms_opening_balance LIMIT 1")
    ob_row  = cur.fetchone()
    opening = float(ob_row['amount']) if ob_row else 0.0

    # Income in period
    q_inc = "SELECT COALESCE(SUM(amount),0) as total FROM cms_income WHERE 1=1"
    p_inc = []
    if from_date: q_inc += " AND date >= %s"; p_inc.append(from_date)
    if to_date:   q_inc += " AND date <= %s"; p_inc.append(to_date)
    cur.execute(q_inc, p_inc)
    total_income = float(cur.fetchone()['total'])

    # Expense in period
    # Exclude auto-repayments (created by loan deduction) from cash flow to avoid double-count
    q_exp = """
        SELECT COALESCE(SUM(amount),0) as total FROM cms_expense
        WHERE category NOT IN ('Employee Repayment')
        AND (created_by NOT LIKE '%[auto]%' OR created_by IS NULL)
        AND 1=1
    """
    p_exp = []
    if from_date: q_exp += " AND date >= %s"; p_exp.append(from_date)
    if to_date:   q_exp += " AND date <= %s"; p_exp.append(to_date)
    cur.execute(q_exp, p_exp)
    total_expense = float(cur.fetchone()['total'])

    # Outstanding employee loans (true advances minus repayments, excluding auto)
    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN category='Employee Loan' THEN amount ELSE 0 END),0) -
            COALESCE(SUM(CASE WHEN category='Employee Repayment'
                              AND (created_by NOT LIKE '%[auto]%' OR created_by IS NULL)
                              THEN amount ELSE 0 END),0)
            AS outstanding
        FROM cms_expense
    """)
    total_loans = float(cur.fetchone()['outstanding'])

    cash_in_hand = opening + total_income - total_expense

    # Combined transactions for the table
    q2 = f"""
        SELECT 'Income' as txn_type, id, source as category, remarks as description,
               amount, date FROM cms_income WHERE 1=1
        {'AND date >= %s' if from_date else ''} {'AND date <= %s' if to_date else ''}
    """
    p2 = [x for x in [from_date if from_date else None, to_date if to_date else None] if x]

    q3 = f"""
        SELECT
            CASE WHEN category='Employee Loan' THEN 'Loan'
                 WHEN category='Employee Repayment' THEN 'Repayment'
                 ELSE 'Expense' END as txn_type,
            id, category, description, amount, date
        FROM cms_expense
        WHERE (created_by NOT LIKE '%[auto]%' OR created_by IS NULL)
        {'AND date >= %s' if from_date else ''} {'AND date <= %s' if to_date else ''}
    """
    p3 = [x for x in [from_date if from_date else None, to_date if to_date else None] if x]

    cur.execute(f"({q2}) UNION ALL ({q3}) ORDER BY date DESC, amount DESC LIMIT 200", p2 + p3)
    rows = [dict(r) for r in cur.fetchall()]

    # Running balance (ascending)
    asc_rows = sorted(rows, key=lambda x: str(x['date']))
    bal = opening
    for r in asc_rows:
        if r['txn_type'] in ('Income', 'Repayment'):
            bal += float(r['amount'])
        else:
            bal -= float(r['amount'])
        r['running_balance'] = round(bal, 2)
    asc_rows.reverse()

    conn.close()
    return {
        'opening_balance': opening,
        'total_income':    total_income,
        'total_expense':   total_expense,
        'cash_in_hand':    round(cash_in_hand, 2),
        'total_loans':     total_loans,
        'transactions':    asc_rows
    }
