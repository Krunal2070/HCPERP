"""
CMS Portal - Cash Management System (v3)
MySQL backend for HCP Wellness Pvt Ltd

ADVANCE LOGIC (CORRECT):
---------------------------------------------------------------------
  1. GIVE ADVANCE  ->  Payment Voucher (PV)
       Dr: Employee Ledger   (money owed by employee - it is an ASSET)
       Cr: Cash in Hand      (cash goes out)
       -> Cash reduces. Employee balance increases (he owes us).
       -> NOT an expense. Shows only in "Advances" section.

  2. EMPLOYEE SUBMITS BILLS ->  Expense Voucher (EV)
       Dr: Expense Head      (e.g. Machine Parts, Diesel) <- ACTUAL EXPENSE
       Cr: Employee Ledger   (reduces what employee owes us)
       -> Expense recorded. Employee advance balance reduces.
       -> If bills > advance, remaining Cr goes to Cash (employee paid diff in cash)

  3. EMPLOYEE REPAYS CASH  ->  Receipt Voucher (RV)
       Dr: Cash in Hand      (cash comes back)
       Cr: Employee Ledger   (reduces what employee owes us)
       -> Cash increases. Advance balance reduces.

WHAT SHOWS WHERE:
  Dashboard "Expenses"  -> ONLY expense_head Dr lines (from EV vouchers, Step 2)
  Dashboard "Advances"  -> Dr balance on Employee ledgers (Step 1 - Step 2 - Step 3)
  Cash in Hand          -> Actual cash movements only (Step 1 and Step 3)
---------------------------------------------------------------------
"""

import pymysql
import pymysql.cursors
from datetime import datetime, date
import decimal

# Connection now centralised in core/config.py (edit there / use HCP_DB_* env vars)
try:
    from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
except Exception:
    DB_HOST     = "localhost"
    DB_PORT     = 3306
    DB_USER     = "root"
    DB_PASSWORD = "Tarak@2424123"
    DB_NAME     = "hcp_portal"

def get_db():
    return pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER,
        password=DB_PASSWORD, db=DB_NAME, charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False
    )

def _clean(v):
    if isinstance(v, (datetime, date)): return str(v)
    if isinstance(v, decimal.Decimal):  return float(v)
    if isinstance(v, bytes):            return v.decode('utf-8', 'replace')
    return v

def _row(d):  return {k: _clean(v) for k, v in d.items()} if d else None
def _rows(l): return [_row(r) for r in l]


# ==============================================================================
# INIT DB
# ==============================================================================

def cms_v3_init_db():
    conn = get_db()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledger_groups (
            id        INT AUTO_INCREMENT PRIMARY KEY,
            name      VARCHAR(100) NOT NULL UNIQUE,
            nature    ENUM('asset','liability','income','expense') NOT NULL,
            is_system TINYINT(1) DEFAULT 0
        )
    """)
    for name, nature in [
        ('Cash & Bank',        'asset'),
        ('Employee Advances',  'asset'),
        ('Accounts Receivable','asset'),
        ('Sales / Scrap',      'income'),
        ('Other Income',       'income'),
        ('Operating Expense',  'expense'),
        ('Staff Expense',      'expense'),
        ('Admin Expense',      'expense'),
        ('Accounts Payable',   'liability'),
    ]:
        cur.execute(
            "INSERT IGNORE INTO cms_ledger_groups (name,nature,is_system) VALUES (%s,%s,1)",
            (name, nature)
        )

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledgers (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            name            VARCHAR(150) NOT NULL,
            ledger_group_id INT NOT NULL,
            ledger_type     ENUM('cash','bank','employee','scrap_vendor',
                                 'customer','expense_head','income_head','other') DEFAULT 'other',
            phone           VARCHAR(20),
            opening_balance DECIMAL(15,2) DEFAULT 0,
            ob_type         ENUM('dr','cr') DEFAULT 'dr',
            is_active       TINYINT(1) DEFAULT 1,
            notes           TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ledger_group_id) REFERENCES cms_ledger_groups(id)
        )
    """)
    cur.execute("SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_type='cash'")
    if cur.fetchone()['c'] == 0:
        cur.execute("SELECT id FROM cms_ledger_groups WHERE name='Cash & Bank'")
        grp = cur.fetchone()
        if grp:
            cur.execute("""
                INSERT INTO cms_ledgers (name,ledger_group_id,ledger_type,opening_balance,ob_type)
                VALUES ('Cash in Hand',%s,'cash',0,'dr')
            """, (grp['id'],))

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_vouchers (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            voucher_type ENUM('PV','RV','JV','EV') NOT NULL,
            voucher_no   VARCHAR(30) NOT NULL UNIQUE,
            date         DATE NOT NULL,
            narration    TEXT,
            total_amount DECIMAL(15,2) DEFAULT 0,
            status       ENUM('draft','posted','cancelled') DEFAULT 'posted',
            created_by   VARCHAR(100),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    try:
        cur.execute("ALTER TABLE cms_vouchers MODIFY voucher_type ENUM('PV','RV','JV','EV') NOT NULL")
        conn.commit()
    except Exception:
        pass

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_voucher_lines (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            voucher_id         INT NOT NULL,
            ledger_id          INT NOT NULL,
            dr_cr              ENUM('dr','cr') NOT NULL,
            amount             DECIMAL(15,2) NOT NULL,
            against_voucher_id INT,
            advance_settle     DECIMAL(15,2) DEFAULT 0,
            description        TEXT,
            sort_order         INT DEFAULT 0,
            FOREIGN KEY (voucher_id)         REFERENCES cms_vouchers(id) ON DELETE CASCADE,
            FOREIGN KEY (ledger_id)          REFERENCES cms_ledgers(id),
            FOREIGN KEY (against_voucher_id) REFERENCES cms_vouchers(id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledger_balances (
            ledger_id INT PRIMARY KEY,
            dr_total  DECIMAL(15,2) DEFAULT 0,
            cr_total  DECIMAL(15,2) DEFAULT 0,
            FOREIGN KEY (ledger_id) REFERENCES cms_ledgers(id) ON DELETE CASCADE
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_reminders (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            ledger_id  INT,
            message    TEXT NOT NULL,
            due_date   DATE,
            is_done    TINYINT(1) DEFAULT 0,
            wa_number  VARCHAR(20),
            created_by VARCHAR(100),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()


# ==============================================================================
# VOUCHER NUMBER
# ==============================================================================

def _next_voucher_no(cur, vtype, dt):
    fy = dt[:4] if int(dt[5:7]) >= 4 else str(int(dt[:4]) - 1)
    prefix = f"{vtype}/{fy[-2:]}{str(int(fy[-2:]) + 1).zfill(2)}/"
    cur.execute(
        "SELECT voucher_no FROM cms_vouchers WHERE voucher_no LIKE %s ORDER BY id DESC LIMIT 1",
        (prefix + '%',)
    )
    row = cur.fetchone()
    seq = 1
    if row:
        try: seq = int(row['voucher_no'].rsplit('/', 1)[-1]) + 1
        except: pass
    return f"{prefix}{seq:04d}"


# ==============================================================================
# LEDGER GROUP CRUD
# ==============================================================================

def cms_get_ledger_groups():
    conn = get_db(); cur = conn.cursor()
    cur.execute("SELECT * FROM cms_ledger_groups ORDER BY nature,name")
    r = _rows(cur.fetchall()); conn.close(); return r

def cms_save_ledger_group(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO cms_ledger_groups (name,nature,is_system) VALUES (%s,%s,0)",
            (payload['name'], payload['nature'])
        )
        conn.commit(); return {'status': 'ok', 'id': cur.lastrowid}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

def cms_delete_ledger_group(gid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT is_system FROM cms_ledger_groups WHERE id=%s", (gid,))
        row = cur.fetchone()
        if not row: return {'status': 'error', 'message': 'Not found'}
        if row['is_system']: return {'status': 'error', 'message': 'Cannot delete system groups'}
        cur.execute("SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_group_id=%s", (gid,))
        if cur.fetchone()['c'] > 0:
            return {'status': 'error', 'message': 'Ledgers are assigned to this group'}
        cur.execute("DELETE FROM cms_ledger_groups WHERE id=%s AND is_system=0", (gid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


# ==============================================================================
# LEDGER CRUD
# ==============================================================================

def cms_get_ledgers(ledger_type=None, group_id=None, search=''):
    conn = get_db(); cur = conn.cursor()
    q = """
        SELECT l.*, g.name as group_name, g.nature,
               COALESCE(lb.dr_total,0) as dr_total,
               COALESCE(lb.cr_total,0) as cr_total,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE 0 END
                + COALESCE(lb.dr_total,0)
                - CASE WHEN l.ob_type='cr' THEN l.opening_balance ELSE 0 END
                - COALESCE(lb.cr_total,0)) as balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.is_active=1
    """
    params = []
    if ledger_type: q += " AND l.ledger_type=%s"; params.append(ledger_type)
    if group_id:    q += " AND l.ledger_group_id=%s"; params.append(group_id)
    if search:      q += " AND l.name LIKE %s"; params.append(f'%{search}%')
    q += " ORDER BY l.name"
    cur.execute(q, params)
    r = _rows(cur.fetchall()); conn.close(); return r

def cms_save_ledger(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        lid = payload.get('id')
        if lid:
            cur.execute("""
                UPDATE cms_ledgers SET name=%s,ledger_group_id=%s,ledger_type=%s,
                phone=%s,opening_balance=%s,ob_type=%s,notes=%s WHERE id=%s
            """, (payload['name'], payload['ledger_group_id'], payload.get('ledger_type','other'),
                  payload.get('phone',''), payload.get('opening_balance',0),
                  payload.get('ob_type','dr'), payload.get('notes',''), lid))
        else:
            cur.execute("""
                INSERT INTO cms_ledgers
                    (name,ledger_group_id,ledger_type,phone,opening_balance,ob_type,notes)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (payload['name'], payload['ledger_group_id'], payload.get('ledger_type','other'),
                  payload.get('phone',''), payload.get('opening_balance',0),
                  payload.get('ob_type','dr'), payload.get('notes','')))
            lid = cur.lastrowid
            cur.execute("INSERT IGNORE INTO cms_ledger_balances (ledger_id) VALUES (%s)", (lid,))
        conn.commit(); return {'status': 'ok', 'id': lid}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

def cms_delete_ledger(lid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) as c FROM cms_voucher_lines WHERE ledger_id=%s", (lid,))
        if cur.fetchone()['c']:
            cur.execute("UPDATE cms_ledgers SET is_active=0 WHERE id=%s", (lid,))
        else:
            cur.execute("DELETE FROM cms_ledgers WHERE id=%s", (lid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


# ==============================================================================
# BALANCE HELPER
# ==============================================================================

def _adjust_balance(cur, ledger_id, dr_cr, amount):
    cur.execute("INSERT IGNORE INTO cms_ledger_balances (ledger_id) VALUES (%s)", (ledger_id,))
    if dr_cr == 'dr':
        cur.execute("UPDATE cms_ledger_balances SET dr_total=dr_total+%s WHERE ledger_id=%s", (amount, ledger_id))
    else:
        cur.execute("UPDATE cms_ledger_balances SET cr_total=cr_total+%s WHERE ledger_id=%s", (amount, ledger_id))


# ==============================================================================
# VOUCHER SAVE / DELETE / GET
# ==============================================================================

def cms_save_voucher(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        vid   = payload.get('id')
        vtype = payload['voucher_type']
        dt    = payload['date']
        lines = payload.get('lines', [])

        dr_sum = sum(float(l['amount']) for l in lines if l['dr_cr'] == 'dr')
        total  = dr_sum if dr_sum else sum(float(l['amount']) for l in lines if l['dr_cr'] == 'cr')

        if vid:
            cur.execute("SELECT ledger_id,dr_cr,amount FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
            for ol in cur.fetchall():
                _adjust_balance(cur, ol['ledger_id'], ol['dr_cr'], -float(ol['amount']))
            cur.execute("DELETE FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
            cur.execute(
                "UPDATE cms_vouchers SET date=%s,narration=%s,total_amount=%s,updated_at=NOW() WHERE id=%s",
                (dt, payload.get('narration',''), total, vid)
            )
        else:
            vno = _next_voucher_no(cur, vtype, dt)
            cur.execute("""
                INSERT INTO cms_vouchers
                    (voucher_type,voucher_no,date,narration,total_amount,status,created_by)
                VALUES (%s,%s,%s,%s,%s,'posted',%s)
            """, (vtype, vno, dt, payload.get('narration',''), total, payload.get('created_by','')))
            vid = cur.lastrowid

        for i, l in enumerate(lines):
            cur.execute("""
                INSERT INTO cms_voucher_lines
                    (voucher_id,ledger_id,dr_cr,amount,against_voucher_id,advance_settle,description,sort_order)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (vid, int(l['ledger_id']), l['dr_cr'], float(l['amount']),
                  l.get('against_voucher_id') or None,
                  float(l.get('advance_settle', 0)),
                  l.get('description',''), i))
            _adjust_balance(cur, int(l['ledger_id']), l['dr_cr'], float(l['amount']))

        conn.commit()
        cur.execute("SELECT voucher_no FROM cms_vouchers WHERE id=%s", (vid,))
        vno_row = cur.fetchone()
        return {'status': 'ok', 'id': vid, 'voucher_no': vno_row['voucher_no'] if vno_row else ''}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


def cms_delete_voucher(vid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT ledger_id,dr_cr,amount FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
        for l in cur.fetchall():
            _adjust_balance(cur, l['ledger_id'], l['dr_cr'], -float(l['amount']))
        cur.execute("DELETE FROM cms_vouchers WHERE id=%s", (vid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


def cms_get_vouchers(from_date='', to_date='', vtype='', ledger_id=None, page=1, per_page=25):
    conn = get_db(); cur = conn.cursor()
    q = "SELECT v.* FROM cms_vouchers v WHERE v.status!='cancelled'"
    params = []
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    if vtype:     q += " AND v.voucher_type=%s"; params.append(vtype)
    if ledger_id:
        q += " AND v.id IN (SELECT voucher_id FROM cms_voucher_lines WHERE ledger_id=%s)"
        params.append(ledger_id)
    cur.execute(q.replace("SELECT v.*", "SELECT COUNT(*) as c"), params)
    total = cur.fetchone()['c']
    q += " ORDER BY v.date DESC,v.id DESC LIMIT %s OFFSET %s"
    params += [per_page, (page - 1) * per_page]
    cur.execute(q, params)
    rows = _rows(cur.fetchall())
    for r in rows:
        cur.execute("""
            SELECT vl.*,l.name as ledger_name,l.ledger_type
            FROM cms_voucher_lines vl
            JOIN cms_ledgers l ON l.id=vl.ledger_id
            WHERE vl.voucher_id=%s ORDER BY sort_order
        """, (r['id'],))
        r['lines'] = _rows(cur.fetchall())
    conn.close()
    return {'vouchers': rows, 'total': total, 'page': page, 'per_page': per_page}


def cms_get_voucher(vid):
    conn = get_db(); cur = conn.cursor()
    cur.execute("SELECT * FROM cms_vouchers WHERE id=%s", (vid,))
    v = _row(cur.fetchone())
    if not v: conn.close(); return None
    cur.execute("""
        SELECT vl.*,l.name as ledger_name,l.ledger_type,l.phone
        FROM cms_voucher_lines vl
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.voucher_id=%s ORDER BY sort_order
    """, (vid,))
    v['lines'] = _rows(cur.fetchall())
    conn.close()
    return v


# ==============================================================================
# PENDING ADVANCES for bill settlement dropdown
# ==============================================================================

def cms_get_pending_advances(ledger_id):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT v.id as voucher_id, v.voucher_no, v.date, v.narration,
               SUM(CASE WHEN vl.dr_cr='dr' THEN vl.amount ELSE -vl.amount END) as given,
               COALESCE(SUM(vl2.advance_settle),0) as settled
        FROM cms_vouchers v
        JOIN cms_voucher_lines vl
            ON vl.voucher_id=v.id AND vl.ledger_id=%s AND vl.dr_cr='dr'
        LEFT JOIN cms_voucher_lines vl2 ON vl2.against_voucher_id=v.id
        WHERE v.voucher_type='PV' AND v.status='posted'
        GROUP BY v.id
        HAVING given > settled
        ORDER BY v.date ASC
    """, (ledger_id,))
    rows = _rows(cur.fetchall())
    for r in rows:
        r['pending'] = round(float(r['given']) - float(r['settled']), 2)
    conn.close()
    return {'advances': rows}


# ==============================================================================
# LEDGER REPORT
# ==============================================================================

def cms_ledger_report(ledger_id, from_date='', to_date=''):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.*,g.name as group_name,g.nature
        FROM cms_ledgers l JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        WHERE l.id=%s
    """, (ledger_id,))
    ledger = _row(cur.fetchone())
    if not ledger: conn.close(); return {}

    ob = float(ledger['opening_balance']) if ledger['ob_type'] == 'dr' else -float(ledger['opening_balance'])
    if from_date:
        cur.execute("""
            SELECT COALESCE(SUM(CASE WHEN vl.dr_cr='dr' THEN vl.amount ELSE -vl.amount END),0) as net
            FROM cms_voucher_lines vl
            JOIN cms_vouchers v ON v.id=vl.voucher_id
            WHERE vl.ledger_id=%s AND v.date<%s AND v.status='posted'
        """, (ledger_id, from_date))
        ob += float(cur.fetchone()['net'])

    q = """
        SELECT vl.id, vl.dr_cr, vl.amount, vl.description, vl.against_voucher_id,
               v.id as voucher_id, v.date, v.voucher_no, v.voucher_type, v.narration
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        WHERE vl.ledger_id=%s AND v.status='posted'
    """
    params = [ledger_id]
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    q += " ORDER BY v.date ASC,v.id ASC"
    cur.execute(q, params)
    entries = _rows(cur.fetchall())

    running = ob; total_dr = 0; total_cr = 0
    for e in entries:
        amt = float(e['amount'])
        if e['dr_cr'] == 'dr':
            running += amt; total_dr += amt
        else:
            running -= amt; total_cr += amt
        e['running_balance'] = round(running, 2)

    conn.close()
    return {
        'ledger':          ledger,
        'opening_balance': round(ob, 2),
        'entries':         list(reversed(entries)),
        'total_dr':        total_dr,
        'total_cr':        total_cr,
        'closing_balance': round(running, 2)
    }


# ==============================================================================
# DASHBOARD
# ==============================================================================

def cms_dashboard(from_date='', to_date=''):
    conn = get_db(); cur = conn.cursor()
    today = date.today().isoformat()
    if not from_date: from_date = today[:7] + '-01'
    if not to_date:   to_date   = today

    # Cash in hand
    cur.execute("""
        SELECT l.opening_balance, l.ob_type,
               COALESCE(lb.dr_total,0) dr, COALESCE(lb.cr_total,0) cr
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='cash' AND l.is_active=1 LIMIT 1
    """)
    cr = _row(cur.fetchone()) or {}
    ob_cash = float(cr.get('opening_balance',0)) * (1 if cr.get('ob_type','dr')=='dr' else -1)
    cash_in_hand = round(ob_cash + float(cr.get('dr',0)) - float(cr.get('cr',0)), 2)

    # Income (RV vouchers)
    cur.execute("""
        SELECT COALESCE(SUM(total_amount),0) as t FROM cms_vouchers
        WHERE voucher_type='RV' AND status='posted' AND date BETWEEN %s AND %s
    """, (from_date, to_date))
    total_income = float(cur.fetchone()['t'])

    # Expense - ONLY expense_head Dr lines (NOT advances)
    cur.execute("""
        SELECT COALESCE(SUM(vl.amount),0) as t
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='expense_head'
          AND v.status='posted' AND v.date BETWEEN %s AND %s
    """, (from_date, to_date))
    total_expense = float(cur.fetchone()['t'])

    # Advances given in period
    cur.execute("""
        SELECT COALESCE(SUM(vl.amount),0) as t
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='employee'
          AND v.voucher_type='PV' AND v.status='posted'
          AND v.date BETWEEN %s AND %s
    """, (from_date, to_date))
    advances_given_period = float(cur.fetchone()['t'])

    # Outstanding advances (all employee Dr balances)
    cur.execute("""
        SELECT COALESCE(SUM(
            (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
            + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0)
        ),0) as t
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
    """)
    advances_outstanding = float(cur.fetchone()['t'] or 0)

    # Income breakdown by source
    cur.execute("""
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='cr' AND l.ledger_type='income_head'
          AND v.voucher_type='RV' AND v.status='posted'
          AND v.date BETWEEN %s AND %s
        GROUP BY l.id ORDER BY total DESC
    """, (from_date, to_date))
    income_by_source = _rows(cur.fetchall())

    # Expense breakdown by category
    cur.execute("""
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='expense_head'
          AND v.status='posted' AND v.date BETWEEN %s AND %s
        GROUP BY l.id ORDER BY total DESC
    """, (from_date, to_date))
    expense_by_category = _rows(cur.fetchall())

    # Per-employee advance summary
    cur.execute("""
        SELECT l.id as ledger_id, l.name,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS outstanding
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
        HAVING outstanding > 0 ORDER BY outstanding DESC
    """)
    advance_summary = _rows(cur.fetchall())

    # Recent transactions for cashbook
    cur.execute("""
        SELECT v.id, v.date, v.voucher_no, v.voucher_type, v.narration, v.total_amount
        FROM cms_vouchers v
        WHERE v.status='posted' AND v.date BETWEEN %s AND %s
        ORDER BY v.date DESC, v.id DESC LIMIT 100
    """, (from_date, to_date))
    transactions = _rows(cur.fetchall())

    # Add running cash balance
    cur.execute("""
        SELECT COALESCE(SUM(
            CASE WHEN vl.dr_cr='dr' AND l.ledger_type='cash' THEN vl.amount
                 WHEN vl.dr_cr='cr' AND l.ledger_type='cash' THEN -vl.amount
                 ELSE 0 END
        ),0) as net
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE v.date < %s AND v.status='posted'
    """, (from_date,))
    bal = ob_cash + float(cur.fetchone()['net'])
    asc_txns = sorted(transactions, key=lambda x: (x['date'], x['id']))
    for t in asc_txns:
        if t['voucher_type'] == 'RV':
            bal += float(t['total_amount'])
        elif t['voucher_type'] == 'PV':
            bal -= float(t['total_amount'])
        # EV does not move cash (it just settles the advance)
        t['running_balance'] = round(bal, 2)
    transactions = list(reversed(asc_txns))

    conn.close()
    return {
        'cash_in_hand':          cash_in_hand,
        'opening_balance':       round(ob_cash, 2),
        'total_income':          total_income,
        'total_expense':         total_expense,
        'advances_given_period': advances_given_period,
        'advances_outstanding':  advances_outstanding,
        'income_by_source':      income_by_source,
        'expense_by_category':   expense_by_category,
        'advance_summary':       advance_summary,
        'transactions':          transactions,
        'from_date':             from_date,
        'to_date':               to_date,
    }


# ==============================================================================
# ADVANCE REPORT
# ==============================================================================

def cms_advance_report():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id as ledger_id, l.name, l.phone,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='dr'
                        AND v.voucher_type='PV' AND v.status='posted'),0) as total_given,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='cr'
                        AND v.voucher_type='EV' AND v.status='posted'),0) as settled_by_bills,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='cr'
                        AND v.voucher_type='RV' AND v.status='posted'),0) as cash_repaid,
            (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
            + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS outstanding
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
        ORDER BY l.name
    """)
    rows = _rows(cur.fetchall())
    conn.close()
    return {'employees': rows}


# ==============================================================================
# REPORTS
# ==============================================================================

def cms_daily_report(dt):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT v.*,
            GROUP_CONCAT(DISTINCT l.name ORDER BY vl.sort_order SEPARATOR ', ') as party_names
        FROM cms_vouchers v
        JOIN cms_voucher_lines vl ON vl.voucher_id=v.id
        JOIN cms_ledgers l ON l.id=vl.ledger_id AND l.ledger_type NOT IN ('cash','bank')
        WHERE v.date=%s AND v.status='posted'
        GROUP BY v.id ORDER BY v.voucher_type,v.id
    """, (dt,))
    vouchers = _rows(cur.fetchall())
    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN voucher_type='RV' THEN total_amount ELSE 0 END),0) as receipts,
            COALESCE(SUM(CASE WHEN voucher_type='PV' THEN total_amount ELSE 0 END),0) as payments,
            COALESCE(SUM(CASE WHEN voucher_type='EV' THEN total_amount ELSE 0 END),0) as expense_vouchers
        FROM cms_vouchers WHERE date=%s AND status='posted'
    """, (dt,))
    s = _row(cur.fetchone())
    conn.close()
    return {'date': dt, 'vouchers': vouchers, 'summary': {
        'receipts':         float(s['receipts']),
        'payments':         float(s['payments']),
        'expense_vouchers': float(s['expense_vouchers']),
        'net':              float(s['receipts']) - float(s['payments'])
    }}


def cms_category_report(from_date='', to_date='', nature='expense'):
    conn = get_db(); cur = conn.cursor()
    q = """
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total,
               COUNT(DISTINCT v.id) as count
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        WHERE v.status='posted' AND g.nature=%s AND vl.dr_cr='dr'
    """
    params = [nature]
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    q += " GROUP BY l.id ORDER BY total DESC"
    cur.execute(q, params)
    rows = _rows(cur.fetchall()); conn.close(); return rows


def cms_receivables():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id,l.name,l.phone,l.ledger_type,g.name as group_name,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type IN ('scrap_vendor','customer') AND l.is_active=1
        HAVING balance > 0 ORDER BY balance DESC
    """)
    rows = _rows(cur.fetchall()); conn.close(); return rows


def cms_payables():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id,l.name,l.phone,l.ledger_type,g.name as group_name,
               ABS((CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0)) AS balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.is_active=1
        HAVING (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) < 0
        ORDER BY balance DESC
    """)
    rows = _rows(cur.fetchall()); conn.close(); return rows


# ==============================================================================
# REMINDERS
# ==============================================================================

def cms_get_reminders(include_done=False):
    conn = get_db(); cur = conn.cursor()
    q = """SELECT r.*,l.name as ledger_name FROM cms_reminders r
           LEFT JOIN cms_ledgers l ON l.id=r.ledger_id WHERE 1=1"""
    if not include_done: q += " AND r.is_done=0"
    q += " ORDER BY r.due_date ASC,r.id DESC"
    cur.execute(q)
    rows = _rows(cur.fetchall()); conn.close(); return rows

def cms_save_reminder(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        rid = payload.get('id')
        if rid:
            cur.execute(
                "UPDATE cms_reminders SET message=%s,due_date=%s,is_done=%s WHERE id=%s",
                (payload['message'], payload.get('due_date'), payload.get('is_done',0), rid)
            )
        else:
            cur.execute("""INSERT INTO cms_reminders (ledger_id,message,due_date,wa_number,created_by)
                VALUES (%s,%s,%s,%s,%s)""",
                (payload.get('ledger_id'), payload['message'], payload.get('due_date'),
                 payload.get('wa_number',''), payload.get('created_by','')))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

# ==============================================================================
# PETTY CASH REGISTER - bulk export (all vouchers with running balance)
# ==============================================================================

def cms_get_cashbook_export(from_date='', to_date='', vtype=''):
    """
    3-sheet Excel export:
      Sheet 1 - Cash Register : Income (RV) AND Expenses (PV direct, EV bill settlements)
                                with running balance. Advances excluded.
      Sheet 2 - Expenses      : All debit rows (PV expenses + EV bill settlements)
                                with full particulars.
      Sheet 3 - Advances      : Advance given (PV->employee), settled (EV),
                                cash repaid (RV->employee).
    """
    conn = get_db()
    cur  = conn.cursor()

    # Opening balance of Cash ledger
    cur.execute("""
        SELECT l.opening_balance, l.ob_type,
               COALESCE(lb.dr_total,0) dr, COALESCE(lb.cr_total,0) cr
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='cash' AND l.is_active=1 LIMIT 1
    """)
    cash_row = _row(cur.fetchone()) or {}
    ob_sign  = 1 if cash_row.get('ob_type','dr') == 'dr' else -1
    ob_cash  = float(cash_row.get('opening_balance', 0)) * ob_sign

    # All posted vouchers in range
    q = """
        SELECT v.id, v.date, v.voucher_no, v.voucher_type, v.narration, v.total_amount
        FROM cms_vouchers v WHERE v.status = 'posted'
    """
    params = []
    if from_date: q += " AND v.date >= %s"; params.append(from_date)
    if to_date:   q += " AND v.date <= %s"; params.append(to_date)
    q += " ORDER BY v.date ASC, v.id ASC"
    cur.execute(q, params)
    vouchers = _rows(cur.fetchall())

    def get_lines(vid):
        cur.execute("""
            SELECT l.name, l.ledger_type, vl.dr_cr, vl.amount, vl.description
            FROM cms_voucher_lines vl
            JOIN cms_ledgers l ON l.id = vl.ledger_id
            WHERE vl.voucher_id = %s ORDER BY vl.sort_order
        """, (vid,))
        return _rows(cur.fetchall())

    def build_particular(v, lines):
        non_cash = [l for l in lines if l['ledger_type'] not in ('cash','bank')]
        parts = []
        if v['narration']: parts.append(v['narration'])
        seen, names = set(), []
        for l in non_cash:
            if l['name'] not in seen:
                seen.add(l['name']); names.append(l['name'])
        if names: parts.append(' / '.join(names))
        return ' : '.join(parts) if parts else (v['narration'] or '--')

    cash_rows    = []   # Sheet 1: income + expenses with running balance
    expense_rows = []   # Sheet 2: all debit/expense rows
    advance_rows = []   # Sheet 3: advances
    running_bal  = ob_cash
    date_exp     = 0.0
    last_date    = None

    for v in vouchers:
        lines      = get_lines(v['id'])
        particular = build_particular(v, lines)
        amt        = float(v['total_amount'] or 0)
        vtype_     = v['voucher_type']
        vdate      = str(v['date'])

        if vdate != last_date:
            date_exp  = 0.0
            last_date = vdate

        emp_dr = next((l for l in lines
                       if l['ledger_type']=='employee' and l['dr_cr']=='dr'), None)
        emp_cr = next((l for l in lines
                       if l['ledger_type']=='employee' and l['dr_cr']=='cr'), None)

        # ── ADVANCE GIVEN: PV where Dr = employee ───────────────────
        # Advances sheet only. Balance reduces but not shown in register.
        if vtype_ == 'PV' and emp_dr:
            advance_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'employee': emp_dr['name'], 'particular': particular,
                'given': amt, 'settled': 0.0, 'repaid': 0.0,
                'type': 'Advance Given',
            })
            running_bal -= amt
            continue

        # ── BILL SETTLEMENT: EV ─────────────────────────────────────
        # Expense sheet + Cash Register (as expense/debit) + Advances sheet.
        if vtype_ == 'EV':
            if emp_cr:
                advance_rows.append({
                    'date': vdate, 'voucher_no': v['voucher_no'] or '',
                    'employee': emp_cr['name'], 'particular': particular,
                    'given': 0.0, 'settled': amt, 'repaid': 0.0,
                    'type': 'Settled (Bills)',
                })
            date_exp += amt
            expense_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular, 'amount': amt,
                'date_expense': round(date_exp, 2),
            })
            cash_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular,
                'credit': 0.0, 'debit': amt,
                'balance': round(running_bal, 2),
                'date_expense': round(date_exp, 2),
            })
            continue

        # ── ADVANCE REPAYMENT: RV where Cr = employee ───────────────
        # Cash Register (income) + Advances sheet.
        if vtype_ == 'RV' and emp_cr:
            advance_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'employee': emp_cr['name'], 'particular': particular,
                'given': 0.0, 'settled': 0.0, 'repaid': amt,
                'type': 'Cash Repaid',
            })
            running_bal += amt
            cash_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular,
                'credit': amt, 'debit': 0.0,
                'balance': round(running_bal, 2),
                'date_expense': 0.0,
            })
            continue

        # ── NORMAL INCOME: RV ───────────────────────────────────────
        # Cash Register only (credit/income).
        if vtype_ == 'RV':
            running_bal += amt
            cash_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular,
                'credit': amt, 'debit': 0.0,
                'balance': round(running_bal, 2),
                'date_expense': 0.0,
            })
            continue

        # ── NORMAL EXPENSE: PV / JV ─────────────────────────────────
        # Expense sheet + Cash Register (debit).
        if vtype_ in ('PV', 'JV'):
            date_exp += amt
            expense_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular, 'amount': amt,
                'date_expense': round(date_exp, 2),
            })
            running_bal -= amt
            cash_rows.append({
                'date': vdate, 'voucher_no': v['voucher_no'] or '',
                'particular': particular,
                'credit': 0.0, 'debit': amt,
                'balance': round(running_bal, 2),
                'date_expense': round(date_exp, 2),
            })

    conn.close()
    return {
        'cash_rows':    cash_rows,
        'expense_rows': expense_rows,
        'advance_rows': advance_rows,
        'opening':      round(ob_cash, 2),
        'current_cash': round(running_bal, 2),
        'from_date':    from_date,
        'to_date':      to_date,
    }

"""
CMS Portal - Cash Management System (v3)
MySQL backend for HCP Wellness Pvt Ltd

ADVANCE LOGIC (CORRECT):
---------------------------------------------------------------------
  1. GIVE ADVANCE  ->  Payment Voucher (PV)
       Dr: Employee Ledger   (money owed by employee - it is an ASSET)
       Cr: Cash in Hand      (cash goes out)
       -> Cash reduces. Employee balance increases (he owes us).
       -> NOT an expense. Shows only in "Advances" section.

  2. EMPLOYEE SUBMITS BILLS ->  Expense Voucher (EV)
       Dr: Expense Head      (e.g. Machine Parts, Diesel) <- ACTUAL EXPENSE
       Cr: Employee Ledger   (reduces what employee owes us)
       -> Expense recorded. Employee advance balance reduces.
       -> If bills > advance, remaining Cr goes to Cash (employee paid diff in cash)

  3. EMPLOYEE REPAYS CASH  ->  Receipt Voucher (RV)
       Dr: Cash in Hand      (cash comes back)
       Cr: Employee Ledger   (reduces what employee owes us)
       -> Cash increases. Advance balance reduces.

WHAT SHOWS WHERE:
  Dashboard "Expenses"  -> ONLY expense_head Dr lines (from EV vouchers, Step 2)
  Dashboard "Advances"  -> Dr balance on Employee ledgers (Step 1 - Step 2 - Step 3)
  Cash in Hand          -> Actual cash movements only (Step 1 and Step 3)
---------------------------------------------------------------------
"""

import pymysql
import pymysql.cursors
from datetime import datetime, date
import decimal

# Connection now centralised in core/config.py (edit there / use HCP_DB_* env vars)
try:
    from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
except Exception:
    DB_HOST     = "localhost"
    DB_PORT     = 3306
    DB_USER     = "root"
    DB_PASSWORD = "Tarak@2424123"
    DB_NAME     = "hcp_portal"

def get_db():
    return pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER,
        password=DB_PASSWORD, db=DB_NAME, charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False
    )

def _clean(v):
    if isinstance(v, (datetime, date)): return str(v)
    if isinstance(v, decimal.Decimal):  return float(v)
    if isinstance(v, bytes):            return v.decode('utf-8', 'replace')
    return v

def _row(d):  return {k: _clean(v) for k, v in d.items()} if d else None
def _rows(l): return [_row(r) for r in l]


# ==============================================================================
# INIT DB
# ==============================================================================

def cms_v3_init_db():
    conn = get_db()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledger_groups (
            id        INT AUTO_INCREMENT PRIMARY KEY,
            name      VARCHAR(100) NOT NULL UNIQUE,
            nature    ENUM('asset','liability','income','expense') NOT NULL,
            is_system TINYINT(1) DEFAULT 0
        )
    """)
    for name, nature in [
        ('Cash & Bank',        'asset'),
        ('Employee Advances',  'asset'),
        ('Accounts Receivable','asset'),
        ('Sales / Scrap',      'income'),
        ('Other Income',       'income'),
        ('Operating Expense',  'expense'),
        ('Staff Expense',      'expense'),
        ('Admin Expense',      'expense'),
        ('Accounts Payable',   'liability'),
    ]:
        cur.execute(
            "INSERT IGNORE INTO cms_ledger_groups (name,nature,is_system) VALUES (%s,%s,1)",
            (name, nature)
        )

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledgers (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            name            VARCHAR(150) NOT NULL,
            ledger_group_id INT NOT NULL,
            ledger_type     ENUM('cash','bank','employee','scrap_vendor',
                                 'customer','expense_head','income_head','other') DEFAULT 'other',
            phone           VARCHAR(20),
            opening_balance DECIMAL(15,2) DEFAULT 0,
            ob_type         ENUM('dr','cr') DEFAULT 'dr',
            is_active       TINYINT(1) DEFAULT 1,
            notes           TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ledger_group_id) REFERENCES cms_ledger_groups(id)
        )
    """)
    cur.execute("SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_type='cash'")
    if cur.fetchone()['c'] == 0:
        cur.execute("SELECT id FROM cms_ledger_groups WHERE name='Cash & Bank'")
        grp = cur.fetchone()
        if grp:
            cur.execute("""
                INSERT INTO cms_ledgers (name,ledger_group_id,ledger_type,opening_balance,ob_type)
                VALUES ('Cash in Hand',%s,'cash',0,'dr')
            """, (grp['id'],))

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_vouchers (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            voucher_type ENUM('PV','RV','JV','EV') NOT NULL,
            voucher_no   VARCHAR(30) NOT NULL UNIQUE,
            date         DATE NOT NULL,
            narration    TEXT,
            total_amount DECIMAL(15,2) DEFAULT 0,
            status       ENUM('draft','posted','cancelled') DEFAULT 'posted',
            created_by   VARCHAR(100),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    try:
        cur.execute("ALTER TABLE cms_vouchers MODIFY voucher_type ENUM('PV','RV','JV','EV') NOT NULL")
        conn.commit()
    except Exception:
        pass

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_voucher_lines (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            voucher_id         INT NOT NULL,
            ledger_id          INT NOT NULL,
            dr_cr              ENUM('dr','cr') NOT NULL,
            amount             DECIMAL(15,2) NOT NULL,
            against_voucher_id INT,
            advance_settle     DECIMAL(15,2) DEFAULT 0,
            description        TEXT,
            sort_order         INT DEFAULT 0,
            FOREIGN KEY (voucher_id)         REFERENCES cms_vouchers(id) ON DELETE CASCADE,
            FOREIGN KEY (ledger_id)          REFERENCES cms_ledgers(id),
            FOREIGN KEY (against_voucher_id) REFERENCES cms_vouchers(id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ledger_balances (
            ledger_id INT PRIMARY KEY,
            dr_total  DECIMAL(15,2) DEFAULT 0,
            cr_total  DECIMAL(15,2) DEFAULT 0,
            FOREIGN KEY (ledger_id) REFERENCES cms_ledgers(id) ON DELETE CASCADE
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_reminders (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            ledger_id  INT,
            message    TEXT NOT NULL,
            due_date   DATE,
            is_done    TINYINT(1) DEFAULT 0,
            wa_number  VARCHAR(20),
            created_by VARCHAR(100),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()


# ==============================================================================
# VOUCHER NUMBER
# ==============================================================================

def _next_voucher_no(cur, vtype, dt):
    fy = dt[:4] if int(dt[5:7]) >= 4 else str(int(dt[:4]) - 1)
    prefix = f"{vtype}/{fy[-2:]}{str(int(fy[-2:]) + 1).zfill(2)}/"
    cur.execute(
        "SELECT voucher_no FROM cms_vouchers WHERE voucher_no LIKE %s ORDER BY id DESC LIMIT 1",
        (prefix + '%',)
    )
    row = cur.fetchone()
    seq = 1
    if row:
        try: seq = int(row['voucher_no'].rsplit('/', 1)[-1]) + 1
        except: pass
    return f"{prefix}{seq:04d}"


# ==============================================================================
# LEDGER GROUP CRUD
# ==============================================================================

def cms_get_ledger_groups():
    conn = get_db(); cur = conn.cursor()
    cur.execute("SELECT * FROM cms_ledger_groups ORDER BY nature,name")
    r = _rows(cur.fetchall()); conn.close(); return r

def cms_save_ledger_group(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO cms_ledger_groups (name,nature,is_system) VALUES (%s,%s,0)",
            (payload['name'], payload['nature'])
        )
        conn.commit(); return {'status': 'ok', 'id': cur.lastrowid}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

def cms_delete_ledger_group(gid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT is_system FROM cms_ledger_groups WHERE id=%s", (gid,))
        row = cur.fetchone()
        if not row: return {'status': 'error', 'message': 'Not found'}
        if row['is_system']: return {'status': 'error', 'message': 'Cannot delete system groups'}
        cur.execute("SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_group_id=%s", (gid,))
        if cur.fetchone()['c'] > 0:
            return {'status': 'error', 'message': 'Ledgers are assigned to this group'}
        cur.execute("DELETE FROM cms_ledger_groups WHERE id=%s AND is_system=0", (gid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


# ==============================================================================
# LEDGER CRUD
# ==============================================================================

def cms_get_ledgers(ledger_type=None, group_id=None, search=''):
    conn = get_db(); cur = conn.cursor()
    q = """
        SELECT l.*, g.name as group_name, g.nature,
               COALESCE(lb.dr_total,0) as dr_total,
               COALESCE(lb.cr_total,0) as cr_total,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE 0 END
                + COALESCE(lb.dr_total,0)
                - CASE WHEN l.ob_type='cr' THEN l.opening_balance ELSE 0 END
                - COALESCE(lb.cr_total,0)) as balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.is_active=1
    """
    params = []
    if ledger_type: q += " AND l.ledger_type=%s"; params.append(ledger_type)
    if group_id:    q += " AND l.ledger_group_id=%s"; params.append(group_id)
    if search:      q += " AND l.name LIKE %s"; params.append(f'%{search}%')
    q += " ORDER BY l.name"
    cur.execute(q, params)
    r = _rows(cur.fetchall()); conn.close(); return r

def cms_save_ledger(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        lid = payload.get('id')
        if lid:
            cur.execute("""
                UPDATE cms_ledgers SET name=%s,ledger_group_id=%s,ledger_type=%s,
                phone=%s,opening_balance=%s,ob_type=%s,notes=%s WHERE id=%s
            """, (payload['name'], payload['ledger_group_id'], payload.get('ledger_type','other'),
                  payload.get('phone',''), payload.get('opening_balance',0),
                  payload.get('ob_type','dr'), payload.get('notes',''), lid))
        else:
            cur.execute("""
                INSERT INTO cms_ledgers
                    (name,ledger_group_id,ledger_type,phone,opening_balance,ob_type,notes)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (payload['name'], payload['ledger_group_id'], payload.get('ledger_type','other'),
                  payload.get('phone',''), payload.get('opening_balance',0),
                  payload.get('ob_type','dr'), payload.get('notes','')))
            lid = cur.lastrowid
            cur.execute("INSERT IGNORE INTO cms_ledger_balances (ledger_id) VALUES (%s)", (lid,))
        conn.commit(); return {'status': 'ok', 'id': lid}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

def cms_delete_ledger(lid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) as c FROM cms_voucher_lines WHERE ledger_id=%s", (lid,))
        if cur.fetchone()['c']:
            cur.execute("UPDATE cms_ledgers SET is_active=0 WHERE id=%s", (lid,))
        else:
            cur.execute("DELETE FROM cms_ledgers WHERE id=%s", (lid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


# ==============================================================================
# BALANCE HELPER
# ==============================================================================

def _adjust_balance(cur, ledger_id, dr_cr, amount):
    cur.execute("INSERT IGNORE INTO cms_ledger_balances (ledger_id) VALUES (%s)", (ledger_id,))
    if dr_cr == 'dr':
        cur.execute("UPDATE cms_ledger_balances SET dr_total=dr_total+%s WHERE ledger_id=%s", (amount, ledger_id))
    else:
        cur.execute("UPDATE cms_ledger_balances SET cr_total=cr_total+%s WHERE ledger_id=%s", (amount, ledger_id))


# ==============================================================================
# VOUCHER SAVE / DELETE / GET
# ==============================================================================

def cms_save_voucher(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        vid   = payload.get('id')
        vtype = payload['voucher_type']
        dt    = payload['date']
        lines = payload.get('lines', [])

        dr_sum = sum(float(l['amount']) for l in lines if l['dr_cr'] == 'dr')
        total  = dr_sum if dr_sum else sum(float(l['amount']) for l in lines if l['dr_cr'] == 'cr')

        if vid:
            cur.execute("SELECT ledger_id,dr_cr,amount FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
            for ol in cur.fetchall():
                _adjust_balance(cur, ol['ledger_id'], ol['dr_cr'], -float(ol['amount']))
            cur.execute("DELETE FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
            cur.execute(
                "UPDATE cms_vouchers SET date=%s,narration=%s,total_amount=%s,updated_at=NOW() WHERE id=%s",
                (dt, payload.get('narration',''), total, vid)
            )
        else:
            vno = _next_voucher_no(cur, vtype, dt)
            cur.execute("""
                INSERT INTO cms_vouchers
                    (voucher_type,voucher_no,date,narration,total_amount,status,created_by)
                VALUES (%s,%s,%s,%s,%s,'posted',%s)
            """, (vtype, vno, dt, payload.get('narration',''), total, payload.get('created_by','')))
            vid = cur.lastrowid

        for i, l in enumerate(lines):
            cur.execute("""
                INSERT INTO cms_voucher_lines
                    (voucher_id,ledger_id,dr_cr,amount,against_voucher_id,advance_settle,description,sort_order)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (vid, int(l['ledger_id']), l['dr_cr'], float(l['amount']),
                  l.get('against_voucher_id') or None,
                  float(l.get('advance_settle', 0)),
                  l.get('description',''), i))
            _adjust_balance(cur, int(l['ledger_id']), l['dr_cr'], float(l['amount']))

        conn.commit()
        cur.execute("SELECT voucher_no FROM cms_vouchers WHERE id=%s", (vid,))
        vno_row = cur.fetchone()
        return {'status': 'ok', 'id': vid, 'voucher_no': vno_row['voucher_no'] if vno_row else ''}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


def cms_delete_voucher(vid):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT ledger_id,dr_cr,amount FROM cms_voucher_lines WHERE voucher_id=%s", (vid,))
        for l in cur.fetchall():
            _adjust_balance(cur, l['ledger_id'], l['dr_cr'], -float(l['amount']))
        cur.execute("DELETE FROM cms_vouchers WHERE id=%s", (vid,))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()


def cms_get_vouchers(from_date='', to_date='', vtype='', ledger_id=None, page=1, per_page=25):
    conn = get_db(); cur = conn.cursor()
    q = "SELECT v.* FROM cms_vouchers v WHERE v.status!='cancelled'"
    params = []
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    if vtype:     q += " AND v.voucher_type=%s"; params.append(vtype)
    if ledger_id:
        q += " AND v.id IN (SELECT voucher_id FROM cms_voucher_lines WHERE ledger_id=%s)"
        params.append(ledger_id)
    cur.execute(q.replace("SELECT v.*", "SELECT COUNT(*) as c"), params)
    total = cur.fetchone()['c']
    q += " ORDER BY v.date DESC,v.id DESC LIMIT %s OFFSET %s"
    params += [per_page, (page - 1) * per_page]
    cur.execute(q, params)
    rows = _rows(cur.fetchall())
    for r in rows:
        cur.execute("""
            SELECT vl.*,l.name as ledger_name,l.ledger_type
            FROM cms_voucher_lines vl
            JOIN cms_ledgers l ON l.id=vl.ledger_id
            WHERE vl.voucher_id=%s ORDER BY sort_order
        """, (r['id'],))
        r['lines'] = _rows(cur.fetchall())
    conn.close()
    return {'vouchers': rows, 'total': total, 'page': page, 'per_page': per_page}


def cms_get_voucher(vid):
    conn = get_db(); cur = conn.cursor()
    cur.execute("SELECT * FROM cms_vouchers WHERE id=%s", (vid,))
    v = _row(cur.fetchone())
    if not v: conn.close(); return None
    cur.execute("""
        SELECT vl.*,l.name as ledger_name,l.ledger_type,l.phone
        FROM cms_voucher_lines vl
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.voucher_id=%s ORDER BY sort_order
    """, (vid,))
    v['lines'] = _rows(cur.fetchall())
    conn.close()
    return v


# ==============================================================================
# PENDING ADVANCES for bill settlement dropdown
# ==============================================================================

def cms_get_pending_advances(ledger_id):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT v.id as voucher_id, v.voucher_no, v.date, v.narration,
               SUM(CASE WHEN vl.dr_cr='dr' THEN vl.amount ELSE -vl.amount END) as given,
               COALESCE(SUM(vl2.advance_settle),0) as settled
        FROM cms_vouchers v
        JOIN cms_voucher_lines vl
            ON vl.voucher_id=v.id AND vl.ledger_id=%s AND vl.dr_cr='dr'
        LEFT JOIN cms_voucher_lines vl2 ON vl2.against_voucher_id=v.id
        WHERE v.voucher_type='PV' AND v.status='posted'
        GROUP BY v.id
        HAVING given > settled
        ORDER BY v.date ASC
    """, (ledger_id,))
    rows = _rows(cur.fetchall())
    for r in rows:
        r['pending'] = round(float(r['given']) - float(r['settled']), 2)
    conn.close()
    return {'advances': rows}


# ==============================================================================
# LEDGER REPORT
# ==============================================================================

def cms_ledger_report(ledger_id, from_date='', to_date=''):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.*,g.name as group_name,g.nature
        FROM cms_ledgers l JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        WHERE l.id=%s
    """, (ledger_id,))
    ledger = _row(cur.fetchone())
    if not ledger: conn.close(); return {}

    ob = float(ledger['opening_balance']) if ledger['ob_type'] == 'dr' else -float(ledger['opening_balance'])
    if from_date:
        cur.execute("""
            SELECT COALESCE(SUM(CASE WHEN vl.dr_cr='dr' THEN vl.amount ELSE -vl.amount END),0) as net
            FROM cms_voucher_lines vl
            JOIN cms_vouchers v ON v.id=vl.voucher_id
            WHERE vl.ledger_id=%s AND v.date<%s AND v.status='posted'
        """, (ledger_id, from_date))
        ob += float(cur.fetchone()['net'])

    q = """
        SELECT vl.id, vl.dr_cr, vl.amount, vl.description, vl.against_voucher_id,
               v.id as voucher_id, v.date, v.voucher_no, v.voucher_type, v.narration
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        WHERE vl.ledger_id=%s AND v.status='posted'
    """
    params = [ledger_id]
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    q += " ORDER BY v.date ASC,v.id ASC"
    cur.execute(q, params)
    entries = _rows(cur.fetchall())

    running = ob; total_dr = 0; total_cr = 0
    for e in entries:
        amt = float(e['amount'])
        if e['dr_cr'] == 'dr':
            running += amt; total_dr += amt
        else:
            running -= amt; total_cr += amt
        e['running_balance'] = round(running, 2)

    conn.close()
    return {
        'ledger':          ledger,
        'opening_balance': round(ob, 2),
        'entries':         list(reversed(entries)),
        'total_dr':        total_dr,
        'total_cr':        total_cr,
        'closing_balance': round(running, 2)
    }


# ==============================================================================
# DASHBOARD
# ==============================================================================

def cms_dashboard(from_date='', to_date=''):
    conn = get_db(); cur = conn.cursor()
    today = date.today().isoformat()
    if not from_date: from_date = today[:7] + '-01'
    if not to_date:   to_date   = today

    # Cash in hand
    cur.execute("""
        SELECT l.opening_balance, l.ob_type,
               COALESCE(lb.dr_total,0) dr, COALESCE(lb.cr_total,0) cr
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='cash' AND l.is_active=1 LIMIT 1
    """)
    cr = _row(cur.fetchone()) or {}
    ob_cash = float(cr.get('opening_balance',0)) * (1 if cr.get('ob_type','dr')=='dr' else -1)
    cash_in_hand = round(ob_cash + float(cr.get('dr',0)) - float(cr.get('cr',0)), 2)

    # Income (RV vouchers)
    cur.execute("""
        SELECT COALESCE(SUM(total_amount),0) as t FROM cms_vouchers
        WHERE voucher_type='RV' AND status='posted' AND date BETWEEN %s AND %s
    """, (from_date, to_date))
    total_income = float(cur.fetchone()['t'])

    # Expense - ONLY expense_head Dr lines (NOT advances)
    cur.execute("""
        SELECT COALESCE(SUM(vl.amount),0) as t
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='expense_head'
          AND v.status='posted' AND v.date BETWEEN %s AND %s
    """, (from_date, to_date))
    total_expense = float(cur.fetchone()['t'])

    # Advances given in period
    cur.execute("""
        SELECT COALESCE(SUM(vl.amount),0) as t
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='employee'
          AND v.voucher_type='PV' AND v.status='posted'
          AND v.date BETWEEN %s AND %s
    """, (from_date, to_date))
    advances_given_period = float(cur.fetchone()['t'])

    # Outstanding advances (all employee Dr balances)
    cur.execute("""
        SELECT COALESCE(SUM(
            (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
            + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0)
        ),0) as t
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
    """)
    advances_outstanding = float(cur.fetchone()['t'] or 0)

    # Income breakdown by source
    cur.execute("""
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='cr' AND l.ledger_type='income_head'
          AND v.voucher_type='RV' AND v.status='posted'
          AND v.date BETWEEN %s AND %s
        GROUP BY l.id ORDER BY total DESC
    """, (from_date, to_date))
    income_by_source = _rows(cur.fetchall())

    # Expense breakdown by category
    cur.execute("""
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE vl.dr_cr='dr' AND l.ledger_type='expense_head'
          AND v.status='posted' AND v.date BETWEEN %s AND %s
        GROUP BY l.id ORDER BY total DESC
    """, (from_date, to_date))
    expense_by_category = _rows(cur.fetchall())

    # Per-employee advance summary
    cur.execute("""
        SELECT l.id as ledger_id, l.name,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS outstanding
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
        HAVING outstanding > 0 ORDER BY outstanding DESC
    """)
    advance_summary = _rows(cur.fetchall())

    # Recent transactions for cashbook
    cur.execute("""
        SELECT v.id, v.date, v.voucher_no, v.voucher_type, v.narration, v.total_amount
        FROM cms_vouchers v
        WHERE v.status='posted' AND v.date BETWEEN %s AND %s
        ORDER BY v.date DESC, v.id DESC LIMIT 100
    """, (from_date, to_date))
    transactions = _rows(cur.fetchall())

    # Add running cash balance
    cur.execute("""
        SELECT COALESCE(SUM(
            CASE WHEN vl.dr_cr='dr' AND l.ledger_type='cash' THEN vl.amount
                 WHEN vl.dr_cr='cr' AND l.ledger_type='cash' THEN -vl.amount
                 ELSE 0 END
        ),0) as net
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        WHERE v.date < %s AND v.status='posted'
    """, (from_date,))
    bal = ob_cash + float(cur.fetchone()['net'])
    asc_txns = sorted(transactions, key=lambda x: (x['date'], x['id']))
    for t in asc_txns:
        if t['voucher_type'] == 'RV':
            bal += float(t['total_amount'])
        elif t['voucher_type'] == 'PV':
            bal -= float(t['total_amount'])
        # EV does not move cash (it just settles the advance)
        t['running_balance'] = round(bal, 2)
    transactions = list(reversed(asc_txns))

    conn.close()
    return {
        'cash_in_hand':          cash_in_hand,
        'opening_balance':       round(ob_cash, 2),
        'total_income':          total_income,
        'total_expense':         total_expense,
        'advances_given_period': advances_given_period,
        'advances_outstanding':  advances_outstanding,
        'income_by_source':      income_by_source,
        'expense_by_category':   expense_by_category,
        'advance_summary':       advance_summary,
        'transactions':          transactions,
        'from_date':             from_date,
        'to_date':               to_date,
    }


# ==============================================================================
# ADVANCE REPORT
# ==============================================================================

def cms_advance_report():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id as ledger_id, l.name, l.phone,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='dr'
                        AND v.voucher_type='PV' AND v.status='posted'),0) as total_given,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='cr'
                        AND v.voucher_type='EV' AND v.status='posted'),0) as settled_by_bills,
            COALESCE((SELECT SUM(vl.amount) FROM cms_voucher_lines vl
                      JOIN cms_vouchers v ON v.id=vl.voucher_id
                      WHERE vl.ledger_id=l.id AND vl.dr_cr='cr'
                        AND v.voucher_type='RV' AND v.status='posted'),0) as cash_repaid,
            (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
            + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS outstanding
        FROM cms_ledgers l
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type='employee' AND l.is_active=1
        ORDER BY l.name
    """)
    rows = _rows(cur.fetchall())
    conn.close()
    return {'employees': rows}


# ==============================================================================
# REPORTS
# ==============================================================================

def cms_daily_report(dt):
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT v.*,
            GROUP_CONCAT(DISTINCT l.name ORDER BY vl.sort_order SEPARATOR ', ') as party_names
        FROM cms_vouchers v
        JOIN cms_voucher_lines vl ON vl.voucher_id=v.id
        JOIN cms_ledgers l ON l.id=vl.ledger_id AND l.ledger_type NOT IN ('cash','bank')
        WHERE v.date=%s AND v.status='posted'
        GROUP BY v.id ORDER BY v.voucher_type,v.id
    """, (dt,))
    vouchers = _rows(cur.fetchall())
    cur.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN voucher_type='RV' THEN total_amount ELSE 0 END),0) as receipts,
            COALESCE(SUM(CASE WHEN voucher_type='PV' THEN total_amount ELSE 0 END),0) as payments,
            COALESCE(SUM(CASE WHEN voucher_type='EV' THEN total_amount ELSE 0 END),0) as expense_vouchers
        FROM cms_vouchers WHERE date=%s AND status='posted'
    """, (dt,))
    s = _row(cur.fetchone())
    conn.close()
    return {'date': dt, 'vouchers': vouchers, 'summary': {
        'receipts':         float(s['receipts']),
        'payments':         float(s['payments']),
        'expense_vouchers': float(s['expense_vouchers']),
        'net':              float(s['receipts']) - float(s['payments'])
    }}


def cms_category_report(from_date='', to_date='', nature='expense'):
    conn = get_db(); cur = conn.cursor()
    q = """
        SELECT l.name as category, COALESCE(SUM(vl.amount),0) as total,
               COUNT(DISTINCT v.id) as count
        FROM cms_voucher_lines vl
        JOIN cms_vouchers v ON v.id=vl.voucher_id
        JOIN cms_ledgers l ON l.id=vl.ledger_id
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        WHERE v.status='posted' AND g.nature=%s AND vl.dr_cr='dr'
    """
    params = [nature]
    if from_date: q += " AND v.date>=%s"; params.append(from_date)
    if to_date:   q += " AND v.date<=%s"; params.append(to_date)
    q += " GROUP BY l.id ORDER BY total DESC"
    cur.execute(q, params)
    rows = _rows(cur.fetchall()); conn.close(); return rows


def cms_receivables():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id,l.name,l.phone,l.ledger_type,g.name as group_name,
               (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) AS balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.ledger_type IN ('scrap_vendor','customer') AND l.is_active=1
        HAVING balance > 0 ORDER BY balance DESC
    """)
    rows = _rows(cur.fetchall()); conn.close(); return rows


def cms_payables():
    conn = get_db(); cur = conn.cursor()
    cur.execute("""
        SELECT l.id,l.name,l.phone,l.ledger_type,g.name as group_name,
               ABS((CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0)) AS balance
        FROM cms_ledgers l
        JOIN cms_ledger_groups g ON g.id=l.ledger_group_id
        LEFT JOIN cms_ledger_balances lb ON lb.ledger_id=l.id
        WHERE l.is_active=1
        HAVING (CASE WHEN l.ob_type='dr' THEN l.opening_balance ELSE -l.opening_balance END)
               + COALESCE(lb.dr_total,0) - COALESCE(lb.cr_total,0) < 0
        ORDER BY balance DESC
    """)
    rows = _rows(cur.fetchall()); conn.close(); return rows


# ==============================================================================
# REMINDERS
# ==============================================================================

def cms_get_reminders(include_done=False):
    conn = get_db(); cur = conn.cursor()
    q = """SELECT r.*,l.name as ledger_name FROM cms_reminders r
           LEFT JOIN cms_ledgers l ON l.id=r.ledger_id WHERE 1=1"""
    if not include_done: q += " AND r.is_done=0"
    q += " ORDER BY r.due_date ASC,r.id DESC"
    cur.execute(q)
    rows = _rows(cur.fetchall()); conn.close(); return rows

def cms_save_reminder(payload):
    conn = get_db(); cur = conn.cursor()
    try:
        rid = payload.get('id')
        if rid:
            cur.execute(
                "UPDATE cms_reminders SET message=%s,due_date=%s,is_done=%s WHERE id=%s",
                (payload['message'], payload.get('due_date'), payload.get('is_done',0), rid)
            )
        else:
            cur.execute("""INSERT INTO cms_reminders (ledger_id,message,due_date,wa_number,created_by)
                VALUES (%s,%s,%s,%s,%s)""",
                (payload.get('ledger_id'), payload['message'], payload.get('due_date'),
                 payload.get('wa_number',''), payload.get('created_by','')))
        conn.commit(); return {'status': 'ok'}
    except Exception as e:
        conn.rollback(); return {'status': 'error', 'message': str(e)}
    finally: conn.close()

# ==============================================================================
# PETTY CASH REGISTER - bulk export (all vouchers with running balance)
# ==============================================================================
