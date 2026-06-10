"""
sampling_portal.py  –  MySQL edition
Replaces the SQLite version.  All public functions keep the same signature
so app.py needs zero changes.

Requirements (install once):
    pip install pymysql cryptography

MySQL connection details: edit the DB_* constants below.
"""

import os
import re
import hashlib
from datetime import datetime, timedelta

import pymysql
import pymysql.cursors

# ─────────────────────────────────────────────────────────────────────────────
# ❶  CONNECTION CONFIGURATION  → now centralised in core/config.py
#     Edit core/config.py (or set HCP_DB_* env vars) — NOT this file.
# ─────────────────────────────────────────────────────────────────────────────
import sys as _sys
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))   # .../core
if _THIS_DIR not in _sys.path:
    _sys.path.insert(0, _THIS_DIR)
try:
    from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
except Exception:
    # Fallback so the connection layer never hard-fails if config is missing
    DB_HOST     = "localhost"
    DB_PORT     = 3306
    DB_USER     = "root"
    DB_PASSWORD = "Tarak@2424123"
    DB_NAME     = "hcp_portal"


# ─────────────────────────────────────────────────────────────────────────────
# ❷  CONNECTION HELPER
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_database():
    """Creates the MySQL database if it does not already exist."""
    conn = pymysql.connect(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASSWORD,
        charset="utf8mb4",
    )
    with conn.cursor() as cur:
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
            f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
    conn.close()


import datetime as _dt
import decimal as _decimal

def _clean_value(val):
    """
    Convert MySQL-specific types to plain Python types so that:
      - datetime.date / datetime.datetime  → ISO string  "YYYY-MM-DD"
      - decimal.Decimal                    → float
      - bytes                              → str (utf-8)
    Everything else is returned unchanged.
    This ensures Jinja templates can call .split('-') on dates,
    and JSON serialisation never chokes on Decimal or bytes.
    """
    if isinstance(val, _dt.datetime):
        return val.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(val, _dt.date):
        return val.strftime("%Y-%m-%d")
    if isinstance(val, _decimal.Decimal):
        return float(val)
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return val


class _DictRow(dict):
    """
    Thin dict wrapper that:
      • supports index-based access  row[0]  (legacy sqlite3.Row compat)
      • auto-converts MySQL types (date, Decimal, bytes) to plain Python
    """
    def __init__(self, data):
        super().__init__({k: _clean_value(v) for k, v in data.items()})
        self._values_cache = None  # lazy cache for positional access

    def __getitem__(self, key):
        if isinstance(key, int):
            if self._values_cache is None:
                self._values_cache = list(self.values())
            return self._values_cache[key]
        return super().__getitem__(key)


class _DictCursor(pymysql.cursors.DictCursor):
    """DictCursor that returns _DictRow instead of plain dict."""

    def fetchone(self):
        row = super().fetchone()
        return _DictRow(row) if row else None

    def fetchall(self):
        return [_DictRow(r) for r in super().fetchall()]

    def fetchmany(self, size=None):
        return [_DictRow(r) for r in super().fetchmany(size)]


class _ConnectionWrapper:
    """
    Wraps a pymysql connection to mimic sqlite3's interface used in app.py:
      • conn.execute(sql, params)  → cursor (iterable)
      • conn.commit()
      • conn.close()
      • context-manager support  (with conn: ...)
      • cursor()  → raw cursor
    """

    def __init__(self, conn: pymysql.connections.Connection):
        self._conn = conn

    # ── sqlite3-style .execute() ──────────────────────────────────────────────
    def execute(self, sql: str, params=None):
        sql = _adapt_sql(sql)
        cur = self._conn.cursor(_DictCursor)
        cur.execute(sql, params or ())
        return cur

    def cursor(self):
        return self._conn.cursor(_DictCursor)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()

    # context manager  (with conn: ...)
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        return False


def _adapt_sql(sql: str) -> str:
    """
    Convert SQLite-style SQL to MySQL-compatible SQL.
    """
    # Strip SQLite-only pragmas
    if sql.strip().upper().startswith("PRAGMA"):
        return "SELECT 1"  # harmless no-op

    # ? → %s  (but not inside strings — simple global replace is fine here)
    sql = sql.replace("?", "%s")

    # DATE('now') / date('now')
    sql = re.sub(r"[Dd][Aa][Tt][Ee]\('now'\)", "CURDATE()", sql)

    # datetime('now','localtime')
    sql = re.sub(r"datetime\('now','localtime'\)", "NOW()", sql, flags=re.IGNORECASE)
    sql = re.sub(r"datetime\('now'\)", "NOW()", sql, flags=re.IGNORECASE)

    # date('now', '-14 days') → DATE_SUB(CURDATE(), INTERVAL 14 DAY)
    def replace_date_offset(m):
        days = int(m.group(1))
        return f"DATE_SUB(CURDATE(), INTERVAL {days} DAY)"
    sql = re.sub(r"date\('now',\s*'-(\d+)\s*days'\)", replace_date_offset, sql, flags=re.IGNORECASE)

    # strftime('%b-%y', col) → DATE_FORMAT(col, '%b-%y')
    sql = re.sub(r"strftime\('([^']+)',\s*([^)]+)\)", r"DATE_FORMAT(\2, '\1')", sql, flags=re.IGNORECASE)

    # substr(col,1,7) → LEFT(col,7)  only for the common date-prefix pattern
    sql = re.sub(r"substr\(([^,]+),\s*1,\s*7\)", r"LEFT(\1, 7)", sql, flags=re.IGNORECASE)
    # generic substr → SUBSTR (MySQL accepts SUBSTR natively, same syntax)

    # AUTOINCREMENT → AUTO_INCREMENT
    sql = sql.replace("AUTOINCREMENT", "AUTO_INCREMENT")

    # INTEGER PRIMARY KEY AUTO_INCREMENT → INT AUTO_INCREMENT PRIMARY KEY
    sql = re.sub(
        r"INTEGER\s+PRIMARY\s+KEY\s+AUTO_INCREMENT",
        "INT AUTO_INCREMENT PRIMARY KEY",
        sql, flags=re.IGNORECASE
    )

    # TEXT NOT NULL / TEXT / REAL / INTEGER DEFAULT → keep as-is (MySQL accepts these)

    # DATETIME DEFAULT CURRENT_TIMESTAMP → DATETIME DEFAULT CURRENT_TIMESTAMP  (ok)

    # INSERT OR IGNORE → INSERT IGNORE
    sql = re.sub(r"INSERT\s+OR\s+IGNORE", "INSERT IGNORE", sql, flags=re.IGNORECASE)

    # ON CONFLICT(cols) DO UPDATE SET col=excluded.col, ...
    # → ON DUPLICATE KEY UPDATE col=VALUES(col), ...
    def on_conflict_to_dup_key(m):
        assignments = m.group(1)
        # replace excluded.col → VALUES(col)
        assignments = re.sub(r"excluded\.(\w+)", r"VALUES(\1)", assignments)
        return "ON DUPLICATE KEY UPDATE " + assignments

    sql = re.sub(
        r"ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+(.*?)(?=WHERE|\Z|;)",
        on_conflict_to_dup_key,
        sql, flags=re.IGNORECASE | re.DOTALL
    )

    # GENERATED ALWAYS AS (expr) VIRTUAL  → remove (MySQL 5.7 workaround)
    sql = re.sub(r"GENERATED\s+ALWAYS\s+AS\s*\([^)]+\)\s*VIRTUAL", "", sql, flags=re.IGNORECASE)

    # CHECK (…) constraints → strip (optional, MySQL ignores them pre-8.0)
    sql = re.sub(r"CHECK\s*\([^)]+\)", "", sql, flags=re.IGNORECASE)

    # "User_Tbl"  →  `User_Tbl`  (MySQL uses backtick quoting)
    sql = re.sub(r'"(\w+)"', r'`\1`', sql)

    return sql


def get_db_connection() -> _ConnectionWrapper:
    """Returns a connection wrapper that mimics sqlite3's API.
    Uses a thread-local cached connection for performance."""
    try:
        conn = pymysql.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            charset="utf8mb4",
            autocommit=False,
            connect_timeout=10,
        )
        return _ConnectionWrapper(conn)
    except pymysql.Error as e:
        print(f"[{datetime.now()}] DATABASE CONNECTION ERROR: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# ❸  UTILITY
# ─────────────────────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def excel_date_to_string(excel_date):
    if not excel_date:
        return None
    try:
        base_date = datetime(1899, 12, 30)
        converted = base_date + timedelta(days=float(excel_date))
        return converted.strftime("%d/%m/%Y")
    except Exception:
        return excel_date


def excel_to_date(value):
    if not value:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        try:
            return (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime("%Y-%m-%d")
        except Exception:
            return None
    return None


# ─────────────────────────────────────────────────────────────────────────────
# ❹  TABLE INITIALIZERS
#    All CREATE TABLE statements rewritten for MySQL
# ─────────────────────────────────────────────────────────────────────────────

def init_user_table():
    conn = get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `User_Tbl` (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                username         VARCHAR(100) UNIQUE NOT NULL,
                password_hash    VARCHAR(256) NOT NULL,
                full_name        VARCHAR(200),
                email            VARCHAR(200),
                mobile           VARCHAR(50),
                employee_id      VARCHAR(100),
                department       VARCHAR(100),
                designation      VARCHAR(100),
                role             VARCHAR(50),
                user_type        VARCHAR(50),
                access_level     INT DEFAULT 1,
                profile_photo    TEXT,
                is_active        TINYINT(1) DEFAULT 1,
                must_reset_password TINYINT(1) DEFAULT 1,
                created_by       VARCHAR(100),
                created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login       DATETIME
            )
        """)
        conn.commit()

        # Seed admin if empty
        count = conn.execute('SELECT COUNT(*) FROM `User_Tbl`').fetchone()[0]
        if count == 0:
            admin_hash = hash_password('hcp@123')
            conn.execute("""
                INSERT INTO `User_Tbl`
                    (username, password_hash, full_name, user_type, role,
                     access_level, is_active, must_reset_password, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,1,1,'system')
            """, ('admin', admin_hash, 'System Administrator', 'admin', 'admin', 10))
            conn.commit()

        print(f"[{datetime.now()}] SUCCESS: User_Tbl initialized.")
    except Exception as e:
        print(f"User Table Init Error: {e}")
    finally:
        conn.close()


def init_rd_sampling_table():
    conn = get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rd_sampling_requests (
                id                    INT AUTO_INCREMENT PRIMARY KEY,
                request_date          DATE DEFAULT (CURDATE()),
                trade_name            TEXT,
                inci_name             TEXT NOT NULL,
                application           TEXT,
                requested_sample_qty  VARCHAR(100),
                suggested_supplier    TEXT,
                required_by_date      DATE,
                rd_remarks            TEXT,
                received_date         DATE,
                recd_qty              VARCHAR(100),
                submission_date       DATE,
                batch_no              VARCHAR(100),
                actual_supplier_name  TEXT,
                manufacturer_name     TEXT,
                actual_sample_qty     VARCHAR(100),
                rate_per_kg           DOUBLE,
                moq                   VARCHAR(100),
                lead_time             VARCHAR(100),
                status                VARCHAR(50) DEFAULT 'Pending',
                created_by            VARCHAR(100)
            )
        """)
        conn.commit()
        print("✅ R&D Sampling Table Ready")
    finally:
        conn.close()


def init_qc_sampling_table():
    conn = get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS qc_sampling_records (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                trs_no           VARCHAR(100) UNIQUE,
                trs_date         DATE DEFAULT (CURDATE()),
                item_name        TEXT,
                item_category    VARCHAR(100),
                receipt_date     VARCHAR(50),
                supplier_name    TEXT,
                manufacturer_name TEXT,
                batch_no         VARCHAR(100),
                received_qty     DOUBLE,
                physical_state   VARCHAR(100),
                submission_date  VARCHAR(50),
                rate_per_kg      DOUBLE,
                approval_status  VARCHAR(50) DEFAULT 'Pending',
                approved_by      VARCHAR(100),
                approval_date    VARCHAR(50),
                remarks          TEXT,
                created_by       VARCHAR(100)
            )
        """)
        conn.commit()
        print("QC Sampling Table Ready")
    finally:
        conn.close()


def init_canteen_tables():
    conn = get_db_connection()
    if not conn:
        return
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_employees (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                emp_id           VARCHAR(20) UNIQUE,
                emp_name         VARCHAR(200),
                department       VARCHAR(100),
                category         VARCHAR(50),
                contact_number   VARCHAR(30),
                opening_balance  DOUBLE DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_lunch_entries (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                date         DATE,
                emp_id       VARCHAR(20),
                emp_name     VARCHAR(200),
                category     VARCHAR(50),
                amount       DOUBLE,
                lunch_taken  TINYINT(1) DEFAULT 1
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_expenses (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                date         DATE DEFAULT (CURDATE()),
                invoice_no   VARCHAR(100),
                particulars  TEXT,
                category     VARCHAR(100),
                amount       DOUBLE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_payments (
                id       INT AUTO_INCREMENT PRIMARY KEY,
                date     DATE DEFAULT (CURDATE()),
                vch_no   VARCHAR(100),
                emp_name VARCHAR(200),
                amount   DOUBLE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_monthly_summary (
                id               INT AUTO_INCREMENT PRIMARY KEY,
                month            VARCHAR(20) UNIQUE,
                opening_balance  DOUBLE DEFAULT 0,
                income           DOUBLE DEFAULT 0,
                expenses         DOUBLE DEFAULT 0,
                closing_balance  DOUBLE DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_opening_balance (
                id             INT AUTO_INCREMENT PRIMARY KEY,
                month          VARCHAR(20) UNIQUE,
                opening_amount DOUBLE DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_holidays (
                id    INT AUTO_INCREMENT PRIMARY KEY,
                date  DATE NOT NULL,
                name  VARCHAR(200) NOT NULL,
                type  VARCHAR(50) DEFAULT 'National'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS canteen_advance_payments (
                id       INT AUTO_INCREMENT PRIMARY KEY,
                month    VARCHAR(20) NOT NULL,
                emp_id   VARCHAR(20) NOT NULL,
                emp_name VARCHAR(200),
                paid     TINYINT(1) DEFAULT 0,
                paid_on  DATE,
                UNIQUE KEY uq_month_emp (month, emp_id)
            )
        """)
    print("Canteen Tables Ready")
    conn.close()


def init_task_tables():
    conn = get_db_connection()
    if not conn:
        return
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS task_reminders (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                title       TEXT NOT NULL,
                description TEXT,
                due_date    DATE,
                priority    VARCHAR(20) DEFAULT 'Medium',
                status      VARCHAR(30) DEFAULT 'Pending',
                assigned_to VARCHAR(100),
                created_by  VARCHAR(100),
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS task_push_reminders (
                id         INT AUTO_INCREMENT PRIMARY KEY,
                task_id    INT NOT NULL,
                target_uid VARCHAR(100) NOT NULL,
                sent_by    VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                delivered  TINYINT(1) DEFAULT 0
            )
        """)
    conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ❺  USER MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

def get_user_for_auth(username):
    conn = get_db_connection()
    if not conn:
        return None
    try:
        return conn.execute(
            "SELECT * FROM `User_Tbl` WHERE username = %s AND is_active = 1",
            (username,)
        ).fetchone()
    except Exception as e:
        print(f"Auth Fetch Error: {e}")
        return None
    finally:
        conn.close()


def update_last_login(username):
    conn = get_db_connection()
    if not conn:
        return
    try:
        conn.execute(
            "UPDATE `User_Tbl` SET last_login = %s WHERE username = %s",
            (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), username)
        )
        conn.commit()
    except Exception as e:
        print(f"Update Last Login Error: {e}")
    finally:
        conn.close()


def create_new_user(data, created_by='admin'):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        pwd_hash = hash_password(data['password'])
        conn.execute("""
            INSERT INTO `User_Tbl`
                (username, password_hash, full_name, email, mobile,
                 employee_id, department, designation, role, user_type,
                 access_level, profile_photo, is_active, must_reset_password, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,1,%s)
        """, (
            data.get('username'), pwd_hash,
            data.get('full_name', ''), data.get('email', ''), data.get('mobile', ''),
            data.get('employee_id', ''), data.get('department', ''),
            data.get('designation', ''), data.get('role', ''),
            data.get('user_type', 'user'), data.get('access_level', 1),
            data.get('profile_photo', ''), created_by
        ))
        conn.commit()
        return True, "User created successfully"
    except pymysql.err.IntegrityError:
        return False, "Username already exists"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


def get_all_users():
    conn = get_db_connection()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT id, username, full_name, email, mobile, employee_id,
                   department, designation, role, user_type, access_level,
                   profile_photo, is_active, created_by, created_at, last_login,
                   COALESCE(is_locked, 0) AS is_locked, locked_at
            FROM `User_Tbl` ORDER BY created_at DESC
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"Get All Users Error: {e}")
        return []
    finally:
        conn.close()


def get_user_by_id(user_id):
    conn = get_db_connection()
    if not conn:
        return None
    try:
        row = conn.execute(
            "SELECT * FROM `User_Tbl` WHERE id = %s", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    except Exception as e:
        print(f"Get User Error: {e}")
        return None
    finally:
        conn.close()


def update_user(user_id, data):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        # Username editable only when explicitly provided & non-empty.
        # Backward-compatible: callers that don't send 'username' keep old behaviour.
        new_username = (data.get('username') or '').strip()
        if new_username:
            dup = conn.execute(
                "SELECT id FROM `User_Tbl` WHERE username=%s AND id<>%s LIMIT 1",
                (new_username, user_id)
            ).fetchone()
            if dup:
                return False, f'Username "{new_username}" is already taken'
            conn.execute("""
                UPDATE `User_Tbl` SET
                    username=%s, full_name=%s, email=%s, mobile=%s, employee_id=%s,
                    department=%s, designation=%s, role=%s, user_type=%s,
                    access_level=%s, is_active=%s
                WHERE id=%s
            """, (
                new_username,
                data.get('full_name', ''), data.get('email', ''), data.get('mobile', ''),
                data.get('employee_id', ''), data.get('department', ''),
                data.get('designation', ''), data.get('role', ''),
                data.get('user_type', 'user'), data.get('access_level', 1),
                data.get('is_active', 1), user_id
            ))
        else:
            conn.execute("""
                UPDATE `User_Tbl` SET
                    full_name=%s, email=%s, mobile=%s, employee_id=%s,
                    department=%s, designation=%s, role=%s, user_type=%s,
                    access_level=%s, is_active=%s
                WHERE id=%s
            """, (
                data.get('full_name', ''), data.get('email', ''), data.get('mobile', ''),
                data.get('employee_id', ''), data.get('department', ''),
                data.get('designation', ''), data.get('role', ''),
                data.get('user_type', 'user'), data.get('access_level', 1),
                data.get('is_active', 1), user_id
            ))
        conn.commit()
        return True, "User updated successfully"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


def reset_user_password(user_id, new_password):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        pwd_hash = hash_password(new_password)
        conn.execute(
            "UPDATE `User_Tbl` SET password_hash=%s, must_reset_password=1 WHERE id=%s",
            (pwd_hash, user_id)
        )
        conn.commit()
        return True, "Password reset successfully"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


def force_reset_password(user_id, new_password):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        pwd_hash = hash_password(new_password)
        conn.execute(
            "UPDATE `User_Tbl` SET password_hash=%s, must_reset_password=0 WHERE id=%s",
            (pwd_hash, user_id)
        )
        conn.commit()
        return True, "Password set successfully"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


def toggle_user_active(user_id, is_active):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        conn.execute(
            "UPDATE `User_Tbl` SET is_active=%s WHERE id=%s",
            (1 if is_active else 0, user_id)
        )
        conn.commit()
        return True, "User status updated"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


def update_profile_photo(user_id, photo_path):
    conn = get_db_connection()
    if not conn:
        return False, "Database connection failed"
    try:
        conn.execute(
            "UPDATE `User_Tbl` SET profile_photo=%s WHERE id=%s",
            (photo_path, user_id)
        )
        conn.commit()
        return True, "Profile photo updated"
    except Exception as e:
        return False, f"Error: {str(e)}"
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ❻  TRS NUMBER GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def generate_trs_no():
    today = datetime.now()
    if today.month >= 4:
        start_year, end_year = today.year, today.year + 1
    else:
        start_year, end_year = today.year - 1, today.year

    fy     = f"{str(start_year)[-2:]}-{str(end_year)[-2:]}"
    prefix = f"TRS/PUR/RM{fy}/"

    conn = get_db_connection()
    row  = conn.execute(
        "SELECT trs_no FROM qc_sampling_records WHERE trs_no LIKE %s ORDER BY id DESC LIMIT 1",
        (prefix + "%",)
    ).fetchone()
    conn.close()

    next_no = (int(row["trs_no"].split("/")[-1]) + 1) if row else 1
    return prefix + str(next_no).zfill(3)


# ─────────────────────────────────────────────────────────────────────────────
# ❼  QC SAMPLING
# ─────────────────────────────────────────────────────────────────────────────

def _safe_float(val):
    """Convert value to float, returning None for empty/null/invalid strings.
    Prevents MySQL 'Data truncated' errors when empty string is inserted into DOUBLE column."""
    if val is None or val == '' or val == 'null':
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def save_qc_sampling(data, role, user):
    conn = get_db_connection()

    if data.get("id"):
        if role == "admin":
            conn.execute("""
                UPDATE qc_sampling_records
                SET trs_no=%s, trs_date=%s, item_name=%s, item_category=%s,
                    receipt_date=%s, submission_date=%s, supplier_name=%s,
                    manufacturer_name=%s, batch_no=%s, received_qty=%s,
                    physical_state=%s, rate_per_kg=%s
                WHERE id=%s
            """, (
                data.get("trs_no"), data.get("trs_date"), data.get("item_name"),
                data.get("item_category"), data.get("receipt_date"),
                data.get("submission_date"), data.get("supplier_name"),
                data.get("manufacturer_name"), data.get("batch_no"),
                _safe_float(data.get("received_qty")), data.get("physical_state"),
                _safe_float(data.get("rate_per_kg")), data.get("id")
            ))
            conn.commit()

        elif role == "QC":
            approval_date = data.get("approval_date")
            if data.get("approval_status") in ["Approved", "Rejected"] and not approval_date:
                approval_date = datetime.now().strftime("%Y-%m-%d")
            elif data.get("approval_status") not in ["Approved", "Rejected"]:
                approval_date = None

            conn.execute("""
                UPDATE qc_sampling_records
                SET approval_status=%s, approved_by=%s, approval_date=%s, remarks=%s
                WHERE id=%s
            """, (
                data.get("approval_status"), user,
                approval_date, data.get("remarks"), data.get("id")
            ))
            conn.commit()
    else:
        trs_no = generate_trs_no()
        conn.execute("""
            INSERT INTO qc_sampling_records
                (trs_no, trs_date, item_name, item_category, receipt_date,
                 submission_date, supplier_name, manufacturer_name, batch_no,
                 received_qty, physical_state, rate_per_kg,
                 approval_status, approval_date, remarks, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            trs_no, data.get("trs_date"), data.get("item_name"),
            data.get("item_category"), data.get("receipt_date"),
            data.get("submission_date"), data.get("supplier_name"),
            data.get("manufacturer_name"), data.get("batch_no"),
            _safe_float(data.get("received_qty")), data.get("physical_state"),
            _safe_float(data.get("rate_per_kg")), "Pending", None, None, user
        ))
        conn.commit()
    conn.close()


def delete_qc_sampling(record_id):
    conn = get_db_connection()
    conn.execute("DELETE FROM qc_sampling_records WHERE id=%s", (record_id,))
    conn.commit()
    conn.close()


def import_qc_sampling_data(rows, user_id):
    conn = get_db_connection()
    try:
        for row in rows:
            trs_no          = generate_trs_no()
            trs_date        = excel_date_to_string(row.get("TRS Date"))
            receipt_date    = excel_date_to_string(row.get("Receipt Date"))
            submission_date = excel_date_to_string(row.get("Submission Date"))

            raw_status = ""
            for key in row.keys():
                if "status" in key.lower():
                    raw_status = str(row.get(key)).strip().lower()
                    break

            if raw_status in ["approved", "approve"]:
                status = "Approved"
            elif raw_status in ["rejected", "reject"]:
                status = "Rejected"
            else:
                status = "Pending"

            approval_date = None
            for key in row.keys():
                if "approval" in key.lower() and "date" in key.lower():
                    approval_date = excel_date_to_string(row.get(key))
                    break

            if status in ["Approved", "Rejected"] and not approval_date:
                trs_raw = row.get("TRS Date")
                if trs_raw:
                    try:
                        base_date = datetime(1899, 12, 30) + timedelta(days=float(trs_raw))
                        approval_date = (base_date + timedelta(days=15)).strftime("%d/%m/%Y")
                    except Exception:
                        approval_date = None

            conn.execute("""
                INSERT INTO qc_sampling_records
                    (trs_no, trs_date, item_name, receipt_date, submission_date,
                     supplier_name, manufacturer_name, batch_no, received_qty,
                     physical_state, rate_per_kg, approval_status, approval_date, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                trs_no, trs_date,
                row.get("Item Description") or row.get("Item Name"),
                receipt_date, submission_date,
                row.get("Supplier"), row.get("Manufacturer"),
                row.get("Batch No.") or row.get("Batch No"),
                row.get("Qty (Kg)") or row.get("Quantity"),
                row.get("Physical State"),
                _safe_float(row.get("Rate / Kg") or row.get("Rate")),
                status, approval_date, user_id
            ))
        conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ❽  R&D SAMPLING
# ─────────────────────────────────────────────────────────────────────────────

def fetch_rd_requests():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT * FROM rd_sampling_requests ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _clean_date(val):
    """Return None if val is empty/None, otherwise return the string as-is.
    Prevents MySQL error 1292 (Incorrect date value) for DATE columns."""
    if not val or str(val).strip() == "":
        return None
    return str(val).strip()


def save_rd_request(data, role):
    conn = get_db_connection()

    # Sanitise all date fields — empty strings must become None for MySQL DATE columns
    for date_field in ("received_date", "submission_date", "required_by_date"):
        data[date_field] = _clean_date(data.get(date_field))

    received   = data.get("received_date")
    submission = data.get("submission_date")
    status     = "Submitted" if submission else ("Received" if received else "Pending")

    if role == "RD" and received:
        conn.close()
        raise Exception("R&D cannot modify after sample is received")

    if role in ["Purchase", "User"] and data.get("id"):
        existing = conn.execute(
            "SELECT * FROM rd_sampling_requests WHERE id=%s", (data.get("id"),)
        ).fetchone()
        if not existing:
            conn.close()
            raise Exception("Record not found")
        for f in ["trade_name","inci_name","application","requested_sample_qty",
                  "suggested_supplier","required_by_date","rd_remarks"]:
            data[f] = existing[f]

    if data.get("id"):
        conn.execute("""
            UPDATE rd_sampling_requests
            SET trade_name=%s, inci_name=%s, application=%s,
                requested_sample_qty=%s, suggested_supplier=%s,
                required_by_date=%s, rd_remarks=%s,
                received_date=%s, recd_qty=%s, submission_date=%s,
                batch_no=%s, actual_supplier_name=%s, manufacturer_name=%s,
                actual_sample_qty=%s, rate_per_kg=%s, moq=%s, lead_time=%s,
                status=%s
            WHERE id=%s
        """, (
            data.get("trade_name"), data.get("inci_name"), data.get("application"),
            data.get("requested_sample_qty"), data.get("suggested_supplier"),
            data.get("required_by_date"), data.get("rd_remarks"),
            data.get("received_date"), data.get("recd_qty"), data.get("submission_date"),
            data.get("batch_no"), data.get("actual_supplier_name"),
            data.get("manufacturer_name"), data.get("actual_sample_qty"),
            _safe_float(data.get("rate_per_kg")), data.get("moq"), data.get("lead_time"),
            status, data.get("id")
        ))
    else:
        conn.execute("""
            INSERT INTO rd_sampling_requests
                (trade_name, inci_name, application, requested_sample_qty,
                 suggested_supplier, required_by_date, rd_remarks,
                 created_by, status)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            data.get("trade_name"), data.get("inci_name"), data.get("application"),
            data.get("requested_sample_qty"), data.get("suggested_supplier"),
            data.get("required_by_date"), data.get("rd_remarks"),
            data.get("created_by"), status
        ))
    conn.commit()
    conn.close()


def delete_rd_request(record_id, role):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT status FROM rd_sampling_requests WHERE id=%s", (record_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise Exception("Record not found")
    if role == "RD" and row["status"] != "Pending":
        conn.close()
        raise Exception("This sample is already Submitted or Received. You can only delete Pending samples.")
    conn.execute("DELETE FROM rd_sampling_requests WHERE id=%s", (record_id,))
    conn.commit()
    conn.close()


def import_rd_sampling_data(rows, user_id):
    conn = get_db_connection()
    try:
        for row in rows:
            conn.execute("""
                INSERT INTO rd_sampling_requests
                    (request_date, trade_name, inci_name, application,
                     requested_sample_qty, suggested_supplier, required_by_date,
                     rd_remarks, received_date, recd_qty, submission_date,
                     actual_supplier_name, batch_no, rate_per_kg, moq,
                     lead_time, status, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                excel_to_date(row.get("Req Date")),
                row.get("Trade Name"), row.get("INCI Name"), row.get("Application"),
                row.get("Qty"), row.get("Supplier"),
                excel_to_date(row.get("Required By")),
                row.get("R&D Remarks"),
                excel_to_date(row.get("Received")),
                row.get("Recd Qty"),
                excel_to_date(row.get("Submission")),
                row.get("Actual Supplier"), row.get("Batch"), _safe_float(row.get("Rate")),
                row.get("MOQ"), row.get("Lead Time"),
                row.get("Status") or "Pending", user_id
            ))
        conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ❾  CANTEEN HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def fetch_canteen_employees():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM canteen_employees ORDER BY emp_id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def fetch_canteen_lunch():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM canteen_lunch_entries ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def fetch_canteen_payments():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM canteen_payments ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_canteen_summary():
    conn = get_db_connection()
    income  = conn.execute("SELECT SUM(amount) FROM canteen_payments").fetchone()[0] or 0
    expense = conn.execute("SELECT SUM(amount) FROM canteen_lunch_entries").fetchone()[0] or 0
    conn.close()
    return {"income": income, "expense": expense, "balance": income - expense}


def get_total_outstanding(selected_month):
    conn = get_db_connection()
    lunch_row = conn.execute(
        "SELECT SUM(amount) FROM canteen_lunch_entries WHERE LEFT(date,7) = %s",
        (selected_month,)
    ).fetchone()
    payment_row = conn.execute(
        "SELECT SUM(amount) FROM canteen_payments WHERE LEFT(date,7) = %s",
        (selected_month,)
    ).fetchone()
    conn.close()
    total_lunch   = lunch_row[0]   if lunch_row[0]   else 0
    total_payment = payment_row[0] if payment_row[0] else 0
    return total_lunch + total_payment




# ─────────────────────────────────────────────────────────────────────────────
# ⓫  USER PERMISSIONS  (granular page / feature access control)
# ─────────────────────────────────────────────────────────────────────────────

def init_permissions_table():
    """Creates user_permissions table. Safe to call on every startup."""
    conn = get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_permissions (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                user_id     INT          NOT NULL,
                perm_key    VARCHAR(120) NOT NULL,
                is_allowed  TINYINT(1)   NOT NULL DEFAULT 0,
                updated_by  VARCHAR(100),
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_perm (user_id, perm_key)
            )
        """)
        conn.commit()
        # Ensure is_dept_head column exists (safe if already there)
        try:
            conn.execute(
                "ALTER TABLE `User_Tbl` ADD COLUMN is_dept_head TINYINT(1) DEFAULT 0"
            )
            conn.commit()
        except Exception:
            pass
        print("✅ user_permissions table ready")
    except Exception as e:
        print(f"init_permissions_table error: {e}")
    finally:
        conn.close()


def get_user_permissions(user_id):
    """Returns {perm_key: bool} dict for a user."""
    conn = get_db_connection()
    if not conn:
        return {}
    try:
        rows = conn.execute(
            "SELECT perm_key, is_allowed FROM user_permissions WHERE user_id = %s",
            (user_id,)
        ).fetchall()
        return {r["perm_key"]: bool(r["is_allowed"]) for r in rows}
    except Exception as e:
        print(f"get_user_permissions error: {e}")
        return {}
    finally:
        conn.close()


def save_user_permissions(user_id, permissions, updated_by="admin"):
    """Upserts {perm_key: bool} dict. Returns (True, msg) or (False, err)."""
    conn = get_db_connection()
    if not conn:
        return False, "DB connection failed"
    try:
        for perm_key, is_allowed in permissions.items():
            conn.execute("""
                INSERT INTO user_permissions (user_id, perm_key, is_allowed, updated_by)
                VALUES (%s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    is_allowed = VALUES(is_allowed),
                    updated_by = VALUES(updated_by),
                    updated_at = NOW()
            """, (user_id, perm_key, int(bool(is_allowed)), updated_by))
        conn.commit()
        return True, "Permissions saved"
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()


def get_all_users_with_permissions():
    """Returns all users with their enabled-permission count."""
    conn = get_db_connection()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT u.id, u.username, u.full_name, u.email, u.mobile,
                   u.employee_id, u.department, u.designation, u.role,
                   u.user_type, u.access_level, u.is_active,
                   IFNULL(u.is_dept_head, 0) AS is_dept_head,
                   u.profile_photo, u.created_at, u.last_login,
                   COUNT(p.id) AS perm_count
            FROM `User_Tbl` u
            LEFT JOIN user_permissions p
                   ON p.user_id = u.id AND p.is_allowed = 1
            GROUP BY u.id, u.username, u.full_name, u.email, u.mobile,
                     u.employee_id, u.department, u.designation, u.role,
                     u.user_type, u.access_level, u.is_active,
                     u.is_dept_head, u.profile_photo, u.created_at, u.last_login
            ORDER BY u.created_at DESC
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"get_all_users_with_permissions error: {e}")
        return []
    finally:
        conn.close()


def init_cms_tables():

    conn = get_db_connection()

    if not conn:
        return

    try:

        conn.execute("""
            CREATE TABLE IF NOT EXISTS cms_accounts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ledger_name VARCHAR(200),
                ledger_type VARCHAR(50),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS cms_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                txn_date DATE,
                voucher_no VARCHAR(50),
                ledger_name VARCHAR(200),
                debit DOUBLE DEFAULT 0,
                credit DOUBLE DEFAULT 0,
                balance DOUBLE DEFAULT 0,
                remarks TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.commit()

        print("✅ CMS Tables Ready")

    finally:

        conn.close()

# ══════════════════════════════════════════════════════════════════════════════
# CASH MANAGEMENT SYSTEM (CMS) — Database Functions
# ══════════════════════════════════════════════════════════════════════════════

def cms_init_db():
    """
    Create all CMS tables.

    KEY DESIGN DECISIONS:
    ─────────────────────
    Loans live in cms_loans (separate from expenses).
    cms_loans.txn_type has THREE values:
      'given'         — cash paid out to employee (cash goes DOWN)
      'repaid'        — employee returns cash (cash goes UP)
      'expense_deduct'— employee spent advance on a purchase:
                        * A linked cms_expense row captures the actual purchase
                        * loan balance goes DOWN (advance is consumed)
                        * BUT cash is NOT affected again (cash already left when loan was given)

    cms_expense has a nullable loan_id column.
    When loan_id IS SET, that expense is an "against-loan" expense and is
    EXCLUDED from cash calculations (it does not move cash — it only reclassifies
    where the previously-given loan money was spent).

    Cash formula:
        Cash = Opening + Income
                       − Cash Expenses  (cms_expense WHERE loan_id IS NULL)
                       − Loans Given    (cms_loans WHERE txn_type='given')
                       + Cash Repayments(cms_loans WHERE txn_type='repaid')
    Note: 'expense_deduct' rows do NOT affect cash at all.
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_opening_balance (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    """)
    cur.execute("SELECT COUNT(*) FROM cms_opening_balance")
    if cur.fetchone()[0] == 0:
        cur.execute("INSERT INTO cms_opening_balance (amount) VALUES (0)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_ob_history (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            old_amount DECIMAL(15,2),
            new_amount DECIMAL(15,2),
            changed_by VARCHAR(100),
            reason     TEXT,
            changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_income (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            date        DATE NOT NULL,
            source      VARCHAR(120) NOT NULL,
            amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
            voucher_no  VARCHAR(20),
            gatepass_no VARCHAR(60),
            remarks     TEXT,
            created_by  VARCHAR(100),
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    try:
        cur.execute("ALTER TABLE cms_income ADD COLUMN voucher_no VARCHAR(20) AFTER amount")
        conn.commit()
    except Exception:
        pass  # already exists

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_employees (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(120) NOT NULL,
            category   VARCHAR(40) NOT NULL DEFAULT 'Employee',
            department VARCHAR(80),
            wa_number  VARCHAR(20),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migrate: add category column if upgrading from old schema
    try:
        cur.execute(
            "ALTER TABLE cms_employees ADD COLUMN category VARCHAR(40) NOT NULL DEFAULT 'Employee' AFTER name"
        )
        conn.commit()
    except Exception:
        pass  # column already exists

    # ── LOANS table ───────────────────────────────────────────────────────────
    # txn_type='given'          → cash given to employee
    # txn_type='repaid'         → employee returns cash (Cash Receipt Voucher)
    # txn_type='expense_deduct' → employee spent advance; linked expense_id points
    #                             to the cms_expense row for the actual purchase
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_loans (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            date         DATE NOT NULL,
            employee_id  INT NOT NULL,
            txn_type     ENUM('given','repaid','expense_deduct') NOT NULL DEFAULT 'given',
            amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
            expense_id   INT DEFAULT NULL,
            loan_account VARCHAR(100) DEFAULT NULL,
            voucher_no   VARCHAR(60),
            description  TEXT,
            created_by   VARCHAR(100),
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Migrations — safe to run on every startup
    try:
        cur.execute("ALTER TABLE cms_loans ADD COLUMN expense_id INT DEFAULT NULL AFTER amount")
        conn.commit()
    except Exception:
        pass  # already exists
    try:
        cur.execute("ALTER TABLE cms_loans ADD COLUMN loan_account VARCHAR(100) DEFAULT NULL AFTER expense_id")
        conn.commit()
    except Exception:
        pass  # already exists

    # ── EXPENSES table ────────────────────────────────────────────────────────
    # loan_id IS NULL  → normal cash expense (affects cash balance)
    # loan_id NOT NULL → expense paid from employee's advance (does NOT affect cash)
    #                    The loan row (expense_deduct) handles the loan reduction.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_expense (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            date            DATE NOT NULL,
            category        VARCHAR(80) NOT NULL,
            amount          DECIMAL(15,2) NOT NULL DEFAULT 0,
            employee_id     INT,
            loan_id         INT DEFAULT NULL,
            is_cash_expense TINYINT(1) NOT NULL DEFAULT 1,
            voucher_no      VARCHAR(60),
            description     TEXT,
            created_by      VARCHAR(100),
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Add loan_id to existing expense table if missing
    try:
        cur.execute("ALTER TABLE cms_expense ADD COLUMN loan_id INT DEFAULT NULL AFTER employee_id")
        conn.commit()
    except Exception:
        pass
    # Add is_cash_expense flag to existing tables (1=real cash, 0=Exp<-Loan no cash)
    try:
        cur.execute("ALTER TABLE cms_expense ADD COLUMN is_cash_expense TINYINT(1) NOT NULL DEFAULT 1 AFTER loan_id")
        conn.commit()
    except Exception:
        pass
    # Drop old legacy column if present
    try:
        cur.execute("ALTER TABLE cms_expense DROP COLUMN loan_deduct_emp_id")
        conn.commit()
    except Exception:
        pass

    # ── VOUCHER COUNTER — one row per (voucher_type, financial_year) ─────────
    # Voucher types: RV (Receipt/Income), PV (Payment/Expense),
    #                LG (Loan Given), LR (Loan Repaid), ED (Expense Deduct)
    # financial_year format: '2526' for FY 2025-26
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_voucher_counter (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            voucher_type   VARCHAR(10) NOT NULL,
            financial_year VARCHAR(10) NOT NULL,
            last_seq       INT NOT NULL DEFAULT 0,
            UNIQUE KEY uq_type_fy (voucher_type, financial_year)
        )
    """)

    conn.commit()
    conn.close()


# ── Voucher Number Generation ─────────────────────────────────────────────────

def _cms_fy(date_str):
    """
    Return financial year string for a given date string (YYYY-MM-DD).
    Indian FY: Apr 1 – Mar 31.
    E.g. 2025-07-15 → '2526', 2026-01-10 → '2526', 2026-04-01 → '2627'
    """
    from datetime import date as _date
    if date_str:
        try:
            d = _date.fromisoformat(str(date_str)[:10])
        except ValueError:
            d = _date.today()
    else:
        d = _date.today()
    if d.month >= 4:
        y1, y2 = d.year, d.year + 1
    else:
        y1, y2 = d.year - 1, d.year
    return f"{str(y1)[2:]}{str(y2)[2:]}"   # e.g. '2526'


def cms_generate_voucher(cur, voucher_type, date_str):
    """
    Generate the next sequential voucher number for the given type and date.
    Format: <TYPE>-<FY>-<NNNN>   e.g. RV-2526-0001

    Voucher types:
        RV  — Receipt Voucher       (Income)
        PV  — Payment Voucher       (Expense, cash)
        LG  — Loan Given
        LR  — Loan Repaid           (Cash Receipt Voucher)
        ED  — Expense Deduct        (Expense Voucher Against Loan)
        OB  — Opening Balance        (Brought Forward entry)

    Uses SELECT … FOR UPDATE to be safe under concurrent inserts.
    Caller must be inside an open transaction (conn.commit() done by caller).
    """
    fy = _cms_fy(date_str)
    cur.execute("""
        INSERT INTO cms_voucher_counter (voucher_type, financial_year, last_seq)
        VALUES (%s, %s, 1)
        ON DUPLICATE KEY UPDATE last_seq = last_seq + 1
    """, (voucher_type, fy))
    cur.execute("""
        SELECT last_seq FROM cms_voucher_counter
        WHERE voucher_type = %s AND financial_year = %s
    """, (voucher_type, fy))
    seq = cur.fetchone()["last_seq"]
    return f"{voucher_type}-{fy}-{str(seq).zfill(4)}"


# ── Opening Balance ───────────────────────────────────────────────────────────

def cms_get_opening_balance():
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("SELECT id, amount FROM cms_opening_balance ORDER BY id LIMIT 1")
    row = cur.fetchone()
    amount = float(row["amount"]) if row else 0.0
    # Auto-recover: if stored amount is 0 but history has a non-zero value, restore it
    if amount == 0.0:
        cur.execute("SELECT new_amount FROM cms_ob_history ORDER BY changed_at DESC LIMIT 1")
        hist = cur.fetchone()
        if hist and float(hist["new_amount"]) != 0.0:
            recovered = float(hist["new_amount"])
            if row:
                cur.execute("UPDATE cms_opening_balance SET amount=%s WHERE id=%s", (recovered, row["id"]))
            else:
                cur.execute("INSERT INTO cms_opening_balance (amount) VALUES (%s)", (recovered,))
            conn.commit()
            amount = recovered
    conn.close()
    return {"amount": amount}

def cms_save_opening_balance(payload):
    conn = get_db_connection(); cur = conn.cursor()
    try:
        cur.execute("SELECT id, amount FROM cms_opening_balance ORDER BY id LIMIT 1")
        row = cur.fetchone(); old = float(row["amount"]) if row else 0.0
        if row:
            cur.execute("UPDATE cms_opening_balance SET amount=%s WHERE id=%s",
                        (payload["amount"], row["id"]))
        else:
            cur.execute("INSERT INTO cms_opening_balance (amount) VALUES (%s)", (payload["amount"],))
        cur.execute("INSERT INTO cms_ob_history (old_amount,new_amount,changed_by,reason) VALUES (%s,%s,%s,%s)",
                    (old, payload["amount"], payload.get("changed_by",""), payload.get("reason","")))
        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_get_ob_history():
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("SELECT * FROM cms_ob_history ORDER BY changed_at DESC LIMIT 50")
    rows = [dict(r) for r in cur.fetchall()]; conn.close()
    return {"history": rows}


# ── Income ────────────────────────────────────────────────────────────────────

def cms_get_income(from_date="", to_date="", rec_id=None):
    conn = get_db_connection(); cur = conn.cursor()
    if rec_id:
        cur.execute("SELECT * FROM cms_income WHERE id=%s", (rec_id,))
    else:
        q = "SELECT * FROM cms_income WHERE 1=1"; params = []
        if from_date: q += " AND date >= %s"; params.append(from_date)
        if to_date:   q += " AND date <= %s"; params.append(to_date)
        q += " ORDER BY date DESC, id DESC"
        cur.execute(q, params)
    rows  = [dict(r) for r in cur.fetchall()]
    total = sum(float(r["amount"]) for r in rows)
    conn.close(); return {"records": rows, "total": total}

def cms_save_income(payload):
    conn = get_db_connection(); cur = conn.cursor()
    try:
        rid = payload.get("id")
        if rid:
            cur.execute("UPDATE cms_income SET date=%s,source=%s,amount=%s,gatepass_no=%s,remarks=%s WHERE id=%s",
                        (payload["date"],payload["source"],payload["amount"],
                         payload.get("gatepass_no",""),payload.get("remarks",""),rid))
        else:
            vno = cms_generate_voucher(cur, "RV", payload["date"])
            cur.execute("INSERT INTO cms_income (date,source,amount,gatepass_no,remarks,created_by,voucher_no) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (payload["date"],payload["source"],payload["amount"],
                         payload.get("gatepass_no",""),payload.get("remarks",""),
                         payload.get("created_by",""), vno))
        conn.commit(); return {"status": "ok", "voucher_no": vno if not rid else None}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_delete_income(rec_id):
    conn = get_db_connection(); cur = conn.cursor()
    try:
        cur.execute("DELETE FROM cms_income WHERE id=%s", (rec_id,))
        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()


# ── Expenses (pure expenses only — no loans) ──────────────────────────────────

def cms_get_expenses(from_date="", to_date="", category="", rec_id=None):
    """
    Returns expense records.
    Includes employee_name (from cms_employees via employee_id) and
    loan_employee_name (the employee whose loan this was charged against, via loan_id→cms_loans).
    """
    conn = get_db_connection(); cur = conn.cursor()
    if rec_id:
        cur.execute("""
            SELECT e.*,
                   emp.name  AS employee_name,
                   le.name   AS loan_employee_name
            FROM cms_expense e
            LEFT JOIN cms_employees emp ON e.employee_id = emp.id
            LEFT JOIN cms_loans     l   ON e.loan_id     = l.id
            LEFT JOIN cms_employees le  ON l.employee_id = le.id
            WHERE e.id = %s
        """, (rec_id,))
    else:
        q = """
            SELECT e.*,
                   emp.name  AS employee_name,
                   le.name   AS loan_employee_name
            FROM cms_expense e
            LEFT JOIN cms_employees emp ON e.employee_id = emp.id
            LEFT JOIN cms_loans     l   ON e.loan_id     = l.id
            LEFT JOIN cms_employees le  ON l.employee_id = le.id
            WHERE 1=1
        """
        params = []
        if from_date: q += " AND e.date >= %s"; params.append(from_date)
        if to_date:   q += " AND e.date <= %s"; params.append(to_date)
        if category:  q += " AND e.category = %s"; params.append(category)
        q += " ORDER BY e.date DESC, e.id DESC"
        cur.execute(q, params)
    rows = [dict(r) for r in cur.fetchall()]
    # Cash total = only expenses NOT charged against a loan
    cash_total = sum(float(r["amount"]) for r in rows if r.get("is_cash_expense", 1))
    conn.close()
    return {"records": rows, "total": cash_total}

def cms_save_expense(payload):
    """
    Save a cash expense — always generates a PV voucher and always counts
    toward the cash expense total (loan_id stays NULL on the expense row).

    If employee_id is provided AND deduct_from_loan=True, ALSO inserts a
    separate cms_loans row with txn_type='expense_deduct' so the employee's
    outstanding loan balance is reduced.  The two records are independent:
      • cms_expense  — real cash spent  (affects EXPENSE total & cash-in-hand)
      • cms_loans ED — loan recovery     (affects employee ledger only, no cash move)
    Deleting the expense will also clean up the linked loan ED row if present.
    """
    conn = get_db_connection(); cur = conn.cursor()
    try:
        rid         = payload.get("id")
        emp_id      = payload.get("employee_id") or None
        deduct_loan = bool(payload.get("deduct_from_loan")) and bool(emp_id)

        if rid:
            # ── UPDATE existing cash expense ─────────────────────────────
            cur.execute("SELECT loan_id FROM cms_expense WHERE id=%s", (rid,))
            existing = cur.fetchone()
            cur.execute("""UPDATE cms_expense
                           SET date=%s, category=%s, amount=%s, employee_id=%s,
                               voucher_no=%s, description=%s
                           WHERE id=%s""",
                        (payload["date"], payload["category"], payload["amount"],
                         emp_id, payload.get("voucher_no",""), payload.get("description",""), rid))
            # Sync linked ED loan row amount/date if it exists
            if existing and existing["loan_id"]:
                cur.execute("""UPDATE cms_loans
                               SET date=%s, amount=%s, description=%s
                               WHERE id=%s AND txn_type='expense_deduct'""",
                            (payload["date"], payload["amount"],
                             payload.get("description",""), existing["loan_id"]))
            vno = payload.get("voucher_no", "")
            conn.commit()
            return {"status": "ok", "voucher_no": vno}

        # ── INSERT new cash expense ──────────────────────────────────────
        # Always PV voucher — expense hits cash totals regardless of ledger
        vno = cms_generate_voucher(cur, "PV", payload["date"])
        cur.execute("""INSERT INTO cms_expense
                       (date, category, amount, employee_id, voucher_no, description, created_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (payload["date"], payload["category"], payload["amount"],
                     emp_id, vno, payload.get("description",""), payload.get("created_by","")))
        expense_id = cur.lastrowid

        ed_vno = None
        if deduct_loan:
            # Separate ED voucher for the loan deduction entry
            ed_vno = cms_generate_voucher(cur, "ED", payload["date"])
            cur.execute("""INSERT INTO cms_loans
                           (date, employee_id, txn_type, amount, expense_id,
                            voucher_no, description, created_by)
                           VALUES (%s,%s,'expense_deduct',%s,%s,%s,%s,%s)""",
                        (payload["date"], emp_id, payload["amount"],
                         expense_id, ed_vno,
                         payload.get("description",""), payload.get("created_by","")))
            loan_id = cur.lastrowid
            # Cross-link so cms_delete_expense can clean up the ED row
            cur.execute("UPDATE cms_expense SET loan_id=%s WHERE id=%s", (loan_id, expense_id))

        conn.commit()
        return {"status": "ok", "voucher_no": vno, "ed_voucher_no": ed_vno}

    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_delete_expense(rec_id):
    """
    Delete a cash expense.
    If this expense is linked to a loan (loan_id IS NOT NULL), also delete
    the linked expense_deduct loan row so the loan balance stays consistent.
    """
    conn = get_db_connection(); cur = conn.cursor()
    try:
        # Check if this is a loan-linked expense
        cur.execute("SELECT loan_id FROM cms_expense WHERE id=%s", (rec_id,))
        row = cur.fetchone()
        if row and row["loan_id"]:
            # Delete the linked expense_deduct loan row too
            cur.execute("DELETE FROM cms_loans WHERE id=%s AND txn_type='expense_deduct'", (row["loan_id"],))
        cur.execute("DELETE FROM cms_expense WHERE id=%s", (rec_id,))
        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()


# ── Employees ─────────────────────────────────────────────────────────────────

def cms_get_employees():
    """Returns employees with their outstanding loan balance from cms_loans."""
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("""
        SELECT e.*,
            COALESCE((SELECT SUM(amount) FROM cms_loans WHERE employee_id=e.id AND txn_type='given'), 0) -
            COALESCE((SELECT SUM(amount) FROM cms_loans WHERE employee_id=e.id AND txn_type IN ('repaid','expense_deduct')), 0)
            AS outstanding
        FROM cms_employees e ORDER BY e.name
    """)
    rows = [dict(r) for r in cur.fetchall()]; conn.close()
    return {"employees": rows}

def cms_save_employee(payload):
    """
    Create or update a party (employee / scrap vendor / soap vendor).

    OPENING BALANCE:
    If opening_balance != 0 and this is a NEW party, we insert a
    'given' loan entry with description 'Opening Balance' so the ledger
    starts with a proper B/F entry.
    """
    from datetime import date as _date_cls
    conn = get_db_connection(); cur = conn.cursor()
    try:
        rid = payload.get("id")
        cat = payload.get("category", "Employee") or "Employee"
        ob  = float(payload.get("opening_balance") or 0)
        ob_date = payload.get("ob_date") or str(_date_cls.today())

        if rid:
            cur.execute(
                "UPDATE cms_employees SET name=%s,category=%s,department=%s,wa_number=%s WHERE id=%s",
                (payload["name"], cat, payload.get("department",""), payload.get("wa_number",""), rid)
            )
            # Update existing opening-balance loan if present
            cur.execute(
                "SELECT id FROM cms_loans WHERE employee_id=%s AND description='Opening Balance' AND txn_type='given'",
                (rid,)
            )
            ob_row = cur.fetchone()
            if ob_row:
                if ob != 0:
                    cur.execute("UPDATE cms_loans SET amount=%s, date=%s WHERE id=%s",
                                (abs(ob), ob_date, ob_row["id"]))
                else:
                    cur.execute("DELETE FROM cms_loans WHERE id=%s", (ob_row["id"],))
            elif ob != 0:
                vno = cms_generate_voucher(cur, "OB", ob_date)
                cur.execute(
                    "INSERT INTO cms_loans (employee_id,txn_type,date,amount,voucher_no,description,created_by) "
                    "VALUES (%s,'given',%s,%s,%s,'Opening Balance',%s)",
                    (rid, ob_date, abs(ob), vno, payload.get("created_by",""))
                )
        else:
            cur.execute(
                "INSERT INTO cms_employees (name,category,department,wa_number) VALUES (%s,%s,%s,%s)",
                (payload["name"], cat, payload.get("department",""), payload.get("wa_number",""))
            )
            new_id = cur.lastrowid
            if ob != 0:
                vno = cms_generate_voucher(cur, "OB", ob_date)
                cur.execute(
                    "INSERT INTO cms_loans (employee_id,txn_type,date,amount,voucher_no,description,created_by) "
                    "VALUES (%s,'given',%s,%s,%s,'Opening Balance',%s)",
                    (new_id, ob_date, abs(ob), vno, payload.get("created_by",""))
                )

        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_delete_employee(emp_id):
    conn = get_db_connection(); cur = conn.cursor()
    try:
        cur.execute("DELETE FROM cms_employees WHERE id=%s", (emp_id,))
        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()


# ── Loans — fully separate from expenses ─────────────────────────────────────
# Both txn_type='given' and 'repaid' directly affect cash in hand.
# Cash out when given, cash in when repaid.

def cms_get_loans(from_date="", to_date="", emp_id=None, rec_id=None):
    """
    Get loan transactions with employee name and (if expense_deduct) the
    linked expense details.
    """
    conn = get_db_connection(); cur = conn.cursor()
    if rec_id:
        cur.execute("""
            SELECT l.*, e.name AS employee_name,
                   exp.category AS expense_category,
                   exp.description AS expense_description,
                   exp.voucher_no AS expense_voucher_no
            FROM cms_loans l
            JOIN cms_employees e ON l.employee_id = e.id
            LEFT JOIN cms_expense exp ON l.expense_id = exp.id
            WHERE l.id = %s
        """, (rec_id,))
    else:
        q = """
            SELECT l.*, e.name AS employee_name,
                   exp.category AS expense_category,
                   exp.description AS expense_description,
                   exp.voucher_no AS expense_voucher_no
            FROM cms_loans l
            JOIN cms_employees e ON l.employee_id = e.id
            LEFT JOIN cms_expense exp ON l.expense_id = exp.id
            WHERE 1=1
        """
        params = []
        if from_date: q += " AND l.date >= %s"; params.append(from_date)
        if to_date:   q += " AND l.date <= %s"; params.append(to_date)
        if emp_id:    q += " AND l.employee_id = %s"; params.append(emp_id)
        q += " ORDER BY l.date DESC, l.id DESC"
        cur.execute(q, params)
    rows = [dict(r) for r in cur.fetchall()]
    total_given  = sum(float(r["amount"]) for r in rows if r["txn_type"] == "given")
    total_repaid = sum(float(r["amount"]) for r in rows if r["txn_type"] in ("repaid", "expense_deduct"))
    conn.close()
    return {"records": rows, "total_given": total_given, "total_repaid": total_repaid,
            "outstanding": total_given - total_repaid}


def cms_save_loan(payload):
    """
    txn_type='given'         → LG-YYYY-NNNN  (Loan Given, cash out)
    txn_type='repaid'        → LR-YYYY-NNNN  (Cash Receipt Voucher, cash in)
    txn_type='expense_deduct'→ ED-YYYY-NNNN  (Expense Voucher Against Loan, no cash move)
                               Both the cms_loans row and its linked cms_expense row
                               get the same ED voucher number.
    Voucher number is auto-generated on INSERT; preserved on UPDATE.
    """
    conn = get_db_connection(); cur = conn.cursor()
    try:
        rid      = payload.get("id")
        emp_id   = payload.get("employee_id")
        txn_type = payload.get("txn_type", "given")

        if not emp_id:
            return {"status": "error", "message": "employee_id required"}
        if txn_type not in ("given", "repaid", "expense_deduct"):
            return {"status": "error", "message": "txn_type must be given, repaid, or expense_deduct"}

        _vtype = {"given": "LG", "repaid": "LR", "expense_deduct": "ED"}

        if rid:
            # UPDATE — keep original voucher number
            cur.execute("SELECT txn_type, expense_id, voucher_no FROM cms_loans WHERE id=%s", (rid,))
            existing = cur.fetchone()
            if not existing:
                return {"status": "error", "message": "Loan record not found"}
            vno = existing["voucher_no"]

            if existing["txn_type"] == "expense_deduct" and existing["expense_id"]:
                cur.execute("""UPDATE cms_expense
                               SET date=%s, category=%s, amount=%s, description=%s
                               WHERE id=%s""",
                            (payload["date"],
                             payload.get("expense_category", payload.get("category", "Other")),
                             payload["amount"], payload.get("description", ""),
                             existing["expense_id"]))

            cur.execute("""UPDATE cms_loans
                           SET date=%s, employee_id=%s, amount=%s, description=%s
                           WHERE id=%s""",
                        (payload["date"], emp_id, payload["amount"],
                         payload.get("description", ""), rid))

        elif txn_type == "expense_deduct":
            # INSERT expense_deduct — one ED voucher shared by both rows
            vno = cms_generate_voucher(cur, "ED", payload["date"])

            cur.execute("""INSERT INTO cms_expense
                           (date, category, amount, employee_id, loan_id,
                            is_cash_expense, voucher_no, description, created_by)
                           VALUES (%s,%s,%s,%s,NULL,0,%s,%s,%s)""",
                        (payload["date"],
                         payload.get("expense_category", payload.get("category", "Other")),
                         payload["amount"], emp_id,
                         vno, payload.get("description", ""), payload.get("created_by", "")))
            expense_id = cur.lastrowid

            cur.execute("""INSERT INTO cms_loans
                           (date, employee_id, txn_type, amount, expense_id,
                            voucher_no, description, created_by)
                           VALUES (%s,%s,'expense_deduct',%s,%s,%s,%s,%s)""",
                        (payload["date"], emp_id, payload["amount"],
                         expense_id, vno,
                         payload.get("description", ""), payload.get("created_by", "")))
            loan_id = cur.lastrowid
            cur.execute("UPDATE cms_expense SET loan_id=%s WHERE id=%s", (loan_id, expense_id))

        else:
            # INSERT given or repaid
            vno = cms_generate_voucher(cur, _vtype[txn_type], payload["date"])
            loan_account = payload.get("loan_account", "") or None
            cur.execute("""INSERT INTO cms_loans
                           (date, employee_id, txn_type, amount, loan_account, voucher_no, description, created_by)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (payload["date"], emp_id, txn_type, payload["amount"],
                         loan_account, vno, payload.get("description", ""), payload.get("created_by", "")))

        conn.commit()
        return {"status": "ok", "voucher_no": vno}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_delete_loan(rec_id):
    """
    Delete a loan row. If txn_type='expense_deduct', also deletes the
    linked cms_expense row (since they were created together as one transaction).
    """
    conn = get_db_connection(); cur = conn.cursor()
    try:
        cur.execute("SELECT txn_type, expense_id FROM cms_loans WHERE id=%s", (rec_id,))
        row = cur.fetchone()
        if not row:
            return {"status": "error", "message": "Loan record not found"}
        if row["txn_type"] == "expense_deduct" and row["expense_id"]:
            cur.execute("DELETE FROM cms_expense WHERE id=%s", (row["expense_id"],))
        cur.execute("DELETE FROM cms_loans WHERE id=%s", (rec_id,))
        conn.commit(); return {"status": "ok"}
    except Exception as e:
        conn.rollback(); return {"status": "error", "message": str(e)}
    finally: conn.close()

def cms_get_employee_ledger(emp_id):
    """
    Full loan ledger for one employee.
    Shows all three txn_types with running loan balance.
    Both 'repaid' and 'expense_deduct' reduce the outstanding balance.
    """
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("""
        SELECT l.*, e.name AS employee_name,
               exp.category AS expense_category,
               exp.voucher_no AS expense_voucher_no
        FROM cms_loans l
        JOIN cms_employees e  ON l.employee_id = e.id
        LEFT JOIN cms_expense exp ON l.expense_id = exp.id
        WHERE l.employee_id = %s
        ORDER BY l.date ASC, l.id ASC
    """, (emp_id,))
    rows = [dict(r) for r in cur.fetchall()]
    bal = 0.0
    for r in rows:
        if r["txn_type"] == "given":
            bal += float(r["amount"])
        else:  # repaid or expense_deduct — both reduce outstanding
            bal -= float(r["amount"])
        r["running_balance"] = round(bal, 2)
    total_advanced  = sum(float(r["amount"]) for r in rows if r["txn_type"] == "given")
    total_recovered = sum(float(r["amount"]) for r in rows if r["txn_type"] in ("repaid", "expense_deduct"))
    total_cash_repaid   = sum(float(r["amount"]) for r in rows if r["txn_type"] == "repaid")
    total_expense_deduct= sum(float(r["amount"]) for r in rows if r["txn_type"] == "expense_deduct")
    conn.close()
    return {
        "entries": rows,
        "total_advanced":       total_advanced,
        "total_recovered":      total_recovered,
        "total_cash_repaid":    total_cash_repaid,
        "total_expense_deduct": total_expense_deduct,
        "outstanding":          total_advanced - total_recovered,
    }


# ── Dashboard ─────────────────────────────────────────────────────────────────
#
# CASH FORMULA:
#   Cash = Opening + Income
#                  − Cash Expenses        (cms_expense WHERE loan_id IS NULL)
#                  − Loans Given          (cms_loans WHERE txn_type='given')
#                  + Cash Repayments      (cms_loans WHERE txn_type='repaid')
#
# expense_deduct rows do NOT touch cash (loan balance reduction only).
# Expenses with loan_id set do NOT touch cash (already accounted for by the loan).

def cms_get_dashboard(from_date="", to_date=""):
    conn = get_db_connection(); cur = conn.cursor()

    cur.execute("SELECT amount FROM cms_opening_balance LIMIT 1")
    ob = cur.fetchone(); opening = float(ob["amount"]) if ob else 0.0

    # Income
    q_inc = "SELECT COALESCE(SUM(amount),0) AS t FROM cms_income WHERE 1=1"
    p_inc = []
    if from_date: q_inc += " AND date >= %s"; p_inc.append(from_date)
    if to_date:   q_inc += " AND date <= %s"; p_inc.append(to_date)
    cur.execute(q_inc, p_inc)
    total_income = float(cur.fetchone()["t"])

    # Cash expenses only (not charged against a loan)
    q_exp = "SELECT COALESCE(SUM(amount),0) AS t FROM cms_expense WHERE is_cash_expense=1"
    p_exp = []
    if from_date: q_exp += " AND date >= %s"; p_exp.append(from_date)
    if to_date:   q_exp += " AND date <= %s"; p_exp.append(to_date)
    cur.execute(q_exp, p_exp)
    total_expense = float(cur.fetchone()["t"])

    # Loans given (cash out)
    q_lg = "SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type='given'"
    p_lg = []
    if from_date: q_lg += " AND date >= %s"; p_lg.append(from_date)
    if to_date:   q_lg += " AND date <= %s"; p_lg.append(to_date)
    cur.execute(q_lg, p_lg); total_loans_given = float(cur.fetchone()["t"])

    # Cash repayments only (cash in — NOT expense_deduct)
    q_lr = "SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type='repaid'"
    p_lr = []
    if from_date: q_lr += " AND date >= %s"; p_lr.append(from_date)
    if to_date:   q_lr += " AND date <= %s"; p_lr.append(to_date)
    cur.execute(q_lr, p_lr); total_loans_repaid = float(cur.fetchone()["t"])

    # Outstanding = all-time given minus ALL recoveries (repaid + expense_deduct)
    cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type='given'")
    all_given = float(cur.fetchone()["t"])
    cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type IN ('repaid','expense_deduct')")
    all_recovered = float(cur.fetchone()["t"])
    total_loans_outstanding = all_given - all_recovered

    cash_in_hand = opening + total_income - total_expense - total_loans_given + total_loans_repaid

    # ── Combined transaction list ──────────────────────────────────────────────
    p2, p3, p4 = [], [], []

    c2 = "SELECT 'Income' AS txn_type, id, source AS category, remarks AS description, amount, date FROM cms_income WHERE 1=1"
    if from_date: c2 += " AND date >= %s"; p2.append(from_date)
    if to_date:   c2 += " AND date <= %s"; p2.append(to_date)

    # Only cash expenses (not against a loan)
    c3 = "SELECT 'Expense' AS txn_type, id, category, description, amount, date FROM cms_expense WHERE is_cash_expense=1"
    if from_date: c3 += " AND date >= %s"; p3.append(from_date)
    if to_date:   c3 += " AND date <= %s"; p3.append(to_date)

    # All three loan txn types, labelled clearly
    c4 = """SELECT
               CASE txn_type
                   WHEN 'given'          THEN 'Loan Given'
                   WHEN 'repaid'         THEN 'Loan Repaid'
                   WHEN 'expense_deduct' THEN 'Loan-Expense'
               END AS txn_type,
               l.id, e.name AS category, l.description, l.amount, l.date
            FROM cms_loans l
            JOIN cms_employees e ON l.employee_id = e.id
            WHERE 1=1"""
    if from_date: c4 += " AND l.date >= %s"; p4.append(from_date)
    if to_date:   c4 += " AND l.date <= %s"; p4.append(to_date)

    cur.execute(f"({c2}) UNION ALL ({c3}) UNION ALL ({c4}) ORDER BY date DESC, amount DESC LIMIT 200", p2+p3+p4)
    rows = [dict(r) for r in cur.fetchall()]

    # Running balance — only cash-affecting types
    asc_rows = sorted(rows, key=lambda x: str(x["date"]))
    bal = opening
    for r in asc_rows:
        t = r["txn_type"]
        if t == "Income":
            bal += float(r["amount"])
        elif t in ("Expense", "Loan Given"):
            bal -= float(r["amount"])
        elif t == "Loan Repaid":
            bal += float(r["amount"])
        # 'Loan-Expense' does NOT change running cash balance
        r["running_balance"] = round(bal, 2)
    asc_rows.reverse()

    conn.close()
    return {
        "opening_balance":         opening,
        "total_income":            total_income,
        "total_expense":           total_expense,
        "total_loans_given":       total_loans_given,
        "total_loans_repaid":      total_loans_repaid,
        "total_loans_outstanding": total_loans_outstanding,
        "cash_in_hand":            round(cash_in_hand, 2),
        "transactions":            asc_rows,
    }
# ── Reports ───────────────────────────────────────────────────────────────────

def cms_report_daily(from_date, to_date):
    """Daily cash report — only cash-affecting transactions."""
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("SELECT amount FROM cms_opening_balance LIMIT 1")
    ob = cur.fetchone(); opening = float(ob["amount"]) if ob else 0.0

    if from_date:
        cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_income WHERE date < %s", (from_date,))
        pre_income = float(cur.fetchone()["t"])
        cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_expense WHERE is_cash_expense=1 AND date < %s", (from_date,))
        pre_expense = float(cur.fetchone()["t"])
        cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type=\'given\' AND date < %s", (from_date,))
        pre_given = float(cur.fetchone()["t"])
        cur.execute("SELECT COALESCE(SUM(amount),0) AS t FROM cms_loans WHERE txn_type=\'repaid\' AND date < %s", (from_date,))
        pre_repaid = float(cur.fetchone()["t"])
        day_opening = opening + pre_income - pre_expense - pre_given + pre_repaid
    else:
        day_opening = opening

    cur.execute("SELECT date, SUM(amount) AS total FROM cms_income WHERE date >= %s AND date <= %s GROUP BY date ORDER BY date", (from_date, to_date))
    income_by_day = {str(r["date"]): float(r["total"]) for r in cur.fetchall()}
    cur.execute("SELECT date, SUM(amount) AS total FROM cms_expense WHERE is_cash_expense=1 AND date >= %s AND date <= %s GROUP BY date ORDER BY date", (from_date, to_date))
    expense_by_day = {str(r["date"]): float(r["total"]) for r in cur.fetchall()}
    cur.execute("SELECT date, SUM(amount) AS total FROM cms_loans WHERE txn_type=\'given\' AND date >= %s AND date <= %s GROUP BY date ORDER BY date", (from_date, to_date))
    loan_given_by_day = {str(r["date"]): float(r["total"]) for r in cur.fetchall()}
    cur.execute("SELECT date, SUM(amount) AS total FROM cms_loans WHERE txn_type=\'repaid\' AND date >= %s AND date <= %s GROUP BY date ORDER BY date", (from_date, to_date))
    loan_repaid_by_day = {str(r["date"]): float(r["total"]) for r in cur.fetchall()}

    all_dates = sorted(set(list(income_by_day)+list(expense_by_day)+list(loan_given_by_day)+list(loan_repaid_by_day)))
    rows = []
    bal = day_opening
    for d in all_dates:
        inc   = income_by_day.get(d, 0.0)
        exp   = expense_by_day.get(d, 0.0)
        lg    = loan_given_by_day.get(d, 0.0)
        lr    = loan_repaid_by_day.get(d, 0.0)
        close = bal + inc - exp - lg + lr
        rows.append({"date": d, "opening": round(bal,2), "income": inc,
                     "expense": exp, "loan_given": lg, "loan_repaid": lr,
                     "closing": round(close,2)})
        bal = close

    total_income  = sum(r["income"]      for r in rows)
    total_expense = sum(r["expense"]     for r in rows)
    total_lg      = sum(r["loan_given"]  for r in rows)
    total_lr      = sum(r["loan_repaid"] for r in rows)
    conn.close()
    return {"rows": rows,
            "summary": {"total_income": total_income, "total_expense": total_expense,
                        "total_loan_given": total_lg, "total_loan_repaid": total_lr,
                        "net": total_income - total_expense - total_lg + total_lr}}


def cms_report_category(from_date, to_date):
    """Category breakdown — shows cash vs loan-backed split per category."""
    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("""
        SELECT category,
               COUNT(*) AS count,
               SUM(amount) AS total,
               SUM(CASE WHEN is_cash_expense=1 THEN amount ELSE 0 END) AS cash_total,
               SUM(CASE WHEN loan_id IS NOT NULL THEN amount ELSE 0 END) AS loan_total
        FROM cms_expense
        WHERE date >= %s AND date <= %s
        GROUP BY category ORDER BY total DESC
    """, (from_date, to_date))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"rows": rows}


def cms_report_ledger(emp_id="", from_date="", to_date=""):
    """Loan ledger. Both repaid and expense_deduct reduce outstanding balance."""
    conn = get_db_connection(); cur = conn.cursor()
    q = """SELECT l.*, e.name AS employee_name,
                  exp.category AS expense_category,
                  exp.voucher_no AS expense_voucher_no
           FROM cms_loans l
           JOIN cms_employees e ON l.employee_id = e.id
           LEFT JOIN cms_expense exp ON l.expense_id = exp.id
           WHERE 1=1"""
    params = []
    if emp_id:    q += " AND l.employee_id=%s"; params.append(emp_id)
    if from_date: q += " AND l.date >= %s"; params.append(from_date)
    if to_date:   q += " AND l.date <= %s"; params.append(to_date)
    q += " ORDER BY e.name, l.date ASC, l.id ASC"
    cur.execute(q, params)
    raw = [dict(r) for r in cur.fetchall()]
    balances = {}
    for r in raw:
        eid = r["employee_id"]
        if eid not in balances: balances[eid] = 0.0
        if r["txn_type"] == "given":
            balances[eid] += float(r["amount"])
        else:
            balances[eid] -= float(r["amount"])
        r["running_balance"] = round(balances[eid], 2)
    total_advanced       = sum(float(r["amount"]) for r in raw if r["txn_type"] == "given")
    total_cash_repaid    = sum(float(r["amount"]) for r in raw if r["txn_type"] == "repaid")
    total_expense_deduct = sum(float(r["amount"]) for r in raw if r["txn_type"] == "expense_deduct")
    total_recovered      = total_cash_repaid + total_expense_deduct
    conn.close()
    return {"rows": raw,
            "total_advanced":        total_advanced,
            "total_cash_repaid":     total_cash_repaid,
            "total_expense_deduct":  total_expense_deduct,
            "total_recovered":       total_recovered,
            "outstanding":           total_advanced - total_recovered}

# ── END CMS DATABASE FUNCTIONS ────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# ⓫  DAILY DISPENSING SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

def init_daily_dsp_summary_table():
    """Create daily_dsp_summary table if it doesn't exist."""
    conn = get_db_connection()
    # Migration: add initial_remaining column for existing installations
    try:
        conn.execute("ALTER TABLE daily_dsp_summary ADD COLUMN initial_remaining INT NOT NULL DEFAULT 0 AFTER no_of_batches")
        conn.commit()
    except Exception:
        pass  # Column already exists
    conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_dsp_summary (
            id                INT AUTO_INCREMENT PRIMARY KEY,
            batch_name        VARCHAR(255) NOT NULL,
            batch_date        DATE NOT NULL,
            batch_size        DECIMAL(10,3) NOT NULL DEFAULT 0,
            no_of_batches     INT NOT NULL DEFAULT 0,
            initial_remaining INT NOT NULL DEFAULT 0,
            dispensed         INT NOT NULL DEFAULT 0,
            remaining         INT NOT NULL DEFAULT 0,
            remarks           TEXT,
            batch_id          INT,
            created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    """)
    conn.commit()

    # Migration: ensure Processing_batches has a remarks column (safe — no data loss)
    try:
        conn.execute("ALTER TABLE Processing_batches ADD COLUMN remarks TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # Column already exists

    conn.close()


def dsp_upsert_entry(batch_id, batch_name, batch_date, batch_size, no_of_batches,
                     dispensed, remarks='', initial_remaining=None):
    """
    Insert or update a daily_dsp_summary entry for a given batch_id + batch_date.
    initial_remaining: snapshot of remaining qty before today's dispensing.
    remaining (final): initial_remaining - dispensed_today.
    Returns the row id.
    """
    if initial_remaining is None:
        initial_remaining = int(no_of_batches)
    initial_remaining = int(initial_remaining)
    # ── Hard cap: dispensed today must not push cumulative over no_of_batches ──
    dispensed = max(0, int(dispensed))
    conn = get_db_connection()
    existing = conn.execute(
        "SELECT id, initial_remaining FROM daily_dsp_summary WHERE batch_id=%s AND batch_date=%s",
        (batch_id, batch_date)
    ).fetchone()
    if existing:
        # Never overwrite the original initial_remaining snapshot
        kept_initial    = int(existing['initial_remaining']) if existing['initial_remaining'] else initial_remaining
        final_remaining = max(0, kept_initial - int(dispensed))
        conn.execute("""
            UPDATE daily_dsp_summary
               SET batch_name=%s, batch_size=%s, no_of_batches=%s,
                   dispensed=%s, remaining=%s, remarks=%s
             WHERE id=%s
        """, (batch_name, batch_size, no_of_batches, dispensed, final_remaining,
              remarks, existing['id']))
        conn.commit()
        row_id = existing['id']
    else:
        final_remaining = max(0, initial_remaining - int(dispensed))
        conn.execute("""
            INSERT INTO daily_dsp_summary
                (batch_name, batch_date, batch_size, no_of_batches,
                 initial_remaining, dispensed, remaining, remarks, batch_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (batch_name, batch_date, batch_size, no_of_batches,
              initial_remaining, dispensed, final_remaining, remarks, batch_id))
        conn.commit()
        row_id = conn.execute("SELECT LAST_INSERT_ID()").fetchone()[0]
    conn.close()
    return row_id


def dsp_get_summary(date_str=''):
    """Return all rows for the given date (YYYY-MM-DD) enriched with:
       - total_dispensed: sum of dispensed across ALL dates for that batch_id
       - dispensed_today: dispensed count for the queried date only
    """
    if not date_str:
        date_str = datetime.now().strftime('%Y-%m-%d')
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT d.*,
               COALESCE(t.total_dispensed_all, d.dispensed) AS total_dispensed_all
        FROM daily_dsp_summary d
        LEFT JOIN (
            SELECT batch_id, SUM(dispensed) AS total_dispensed_all
            FROM daily_dsp_summary
            GROUP BY batch_id
        ) t ON t.batch_id = d.batch_id
        WHERE d.batch_date=%s
        ORDER BY d.created_at ASC
    """, (date_str,)).fetchall()
    conn.close()
    result = []
    for r in rows:
        rd = dict(r)
        rd['dispensed_today']     = rd.get('dispensed', 0)
        rd['total_dispensed_all'] = rd.get('total_dispensed_all', rd.get('dispensed', 0))
        result.append(rd)
    return result


def dsp_update_entry(row_id, dispensed, remarks=''):
    """Update dispensed + final_remaining + remarks for an existing row.
    final_remaining = initial_remaining - dispensed_today.
    """
    conn = get_db_connection()
    row = conn.execute(
        "SELECT no_of_batches, initial_remaining FROM daily_dsp_summary WHERE id=%s", (row_id,)
    ).fetchone()
    if not row:
        conn.close()
        return False
    base      = int(row['initial_remaining']) if row['initial_remaining'] else int(row['no_of_batches'])
    remaining = max(0, base - int(dispensed))
    conn.execute("""
        UPDATE daily_dsp_summary
           SET dispensed=%s, remaining=%s, remarks=%s
         WHERE id=%s
    """, (dispensed, remaining, remarks, row_id))
    conn.commit()
    conn.close()
    return True


def dsp_delete_entries(ids):
    """Delete rows by list of ids."""
    if not ids:
        return
    placeholders = ','.join(['%s'] * len(ids))
    conn = get_db_connection()
    conn.execute(f"DELETE FROM daily_dsp_summary WHERE id IN ({placeholders})", ids)
    conn.commit()
    conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# ❿  BOOTSTRAP  –  runs once on import
# ─────────────────────────────────────────────────────────────────────────────

_ensure_database()
init_user_table()
init_rd_sampling_table()
init_qc_sampling_table()
init_canteen_tables()
init_cms_tables()
init_task_tables()
init_permissions_table()
init_daily_dsp_summary_table()


# ══════════════════════════════════════════════════════════════════════════════
# BACKUP SYSTEM
# ══════════════════════════════════════════════════════════════════════════════
import subprocess, os, gzip, shutil
from datetime import datetime

# NO default fallback — admin MUST configure all three paths via the Backup Manager dashboard.
# This constant is kept only so existing code that references BACKUP_DIR doesn't break at import;
# it is NEVER used as a live path. get_backup_config() will raise if paths are unconfigured.
BACKUP_DIR = ""

# ── Backup Config DB helpers ────────────────────────────────────────────────

def _ensure_backup_config_table():
    """Create backup_config table (single-row config) if it doesn't exist."""
    conn = get_db_connection()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS backup_config (
                id           INT          NOT NULL DEFAULT 1,
                primary_path VARCHAR(512) NOT NULL DEFAULT '',
                drive_d_path VARCHAR(512) NOT NULL DEFAULT '',
                network_path VARCHAR(512) NOT NULL DEFAULT '',
                updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                          ON UPDATE CURRENT_TIMESTAMP,
                updated_by   VARCHAR(64)  NOT NULL DEFAULT '',
                PRIMARY KEY (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        # Seed the one config row so we can always UPDATE, never INSERT
        conn.execute("""
            INSERT IGNORE INTO backup_config
                (id, primary_path, drive_d_path, network_path, updated_by)
            VALUES (1, '', '', '', 'system')
        """)
        conn.commit()
    finally:
        conn.close()


def get_backup_config() -> dict:
    """
    Return the current admin-set backup path config from the DB.
    Raises ValueError if any path is blank — admin MUST configure all three
    paths via Backup Manager before any backup can run. No hardcoded defaults.
    """
    _ensure_backup_config_table()
    conn = get_db_connection()
    try:
        cur = conn.execute(
            "SELECT primary_path, drive_d_path, network_path, updated_at, updated_by "
            "FROM backup_config WHERE id = 1"
        )
        row = cur.fetchone()
    finally:
        conn.close()

    primary = (row["primary_path"] if row else "").strip()
    drive_d = (row["drive_d_path"] if row else "").strip()
    network = (row["network_path"] if row else "").strip()

    missing = []
    if not primary: missing.append("Primary (Server Local)")
    if not drive_d: missing.append("Secondary Backup")
    # network_path is OPTIONAL — a third copy is allowed but not required.

    if missing:
        raise ValueError(
            "Backup paths not configured — please set the Primary and "
            "Secondary paths in Backup Manager → Configure Paths before "
            "running a backup. Missing: " + ", ".join(missing)
        )

    return {
        "primary_path": primary,
        "drive_d_path": drive_d,
        "network_path": network,
        "updated_at":   str(row["updated_at"]) if row and row["updated_at"] else None,
        "updated_by":   row["updated_by"] if row else None,
    }


def set_backup_config(primary_path: str = "",
                      drive_d_path: str = "",
                      network_path: str = "",
                      updated_by:   str = "admin") -> dict:
    """
    Persist admin-chosen backup paths.
    - Primary/Secondary: empty string = keep existing value (avoids wiping a
      required path on a partial save).
    - Network (third copy): always written as given, so it CAN be cleared by
      submitting it blank.
    Returns the updated config dict.
    """
    # Read current values WITHOUT triggering the "all configured" validation,
    # so saving still works even when paths are currently incomplete.
    _ensure_backup_config_table()
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT primary_path, drive_d_path, network_path "
                "FROM backup_config WHERE id = 1"
            )
            row = cur.fetchone()
    finally:
        conn.close()
    cur_primary = (row["primary_path"] if row else "") or ""
    cur_drive_d = (row["drive_d_path"] if row else "") or ""

    conn = get_db_connection()
    try:
        conn.execute(
            """UPDATE backup_config
                  SET primary_path = %s,
                      drive_d_path = %s,
                      network_path = %s,
                      updated_by   = %s
                WHERE id = 1""",
            (
                primary_path.strip() if primary_path.strip() else cur_primary,
                drive_d_path.strip() if drive_d_path.strip() else cur_drive_d,
                network_path.strip(),   # written as-is → blank clears it
                updated_by,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_backup_config()


def get_active_backup_dir() -> str:
    """Returns the admin-configured primary path. Raises ValueError if not yet set."""
    return get_backup_config()["primary_path"]


def _ensure_backup_dir():
    """Create the active primary backup directory (and parents) if missing."""
    os.makedirs(get_active_backup_dir(), exist_ok=True)

def cms_create_backup(triggered_by="auto"):
    """
    Run mysqldump for the CMS database and save a compressed .sql.gz file.
    Returns {status, filename, size_kb, path} or {status, message} on error.
    """
    _ensure_backup_dir()
    backup_dir = get_active_backup_dir()
    ts       = datetime.now().strftime("%Y%m%d_%H%M%S")
    label    = "manual" if triggered_by != "auto" else "auto"
    filename = f"cms_backup_{label}_{ts}.sql.gz"
    filepath = os.path.join(backup_dir, filename)

    dump_cmd = [
        "mysqldump",
        f"--host={DB_HOST}",
        f"--port={DB_PORT}",
        f"--user={DB_USER}",
        f"--password={DB_PASSWORD}",
        "--single-transaction",
        "--routines",
        "--triggers",
        "--add-drop-table",
        DB_NAME,
    ]
    try:
        result = subprocess.run(dump_cmd, capture_output=True, check=True)
        with gzip.open(filepath, "wb") as gz:
            gz.write(result.stdout)
        size_kb = round(os.path.getsize(filepath) / 1024, 1)
        # Log to DB
        _log_backup(filename, size_kb, triggered_by, "ok")
        # Auto-prune: keep last 30 backups
        _prune_old_backups(keep=30)
        return {"status": "ok", "filename": filename, "size_kb": size_kb, "path": filepath}
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors="replace").strip()
        _log_backup(filename, 0, triggered_by, f"error: {err[:200]}")
        return {"status": "error", "message": f"mysqldump failed: {err[:300]}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def _log_backup(filename, size_kb, triggered_by, result_status):
    """Record every backup attempt in cms_backup_log table."""
    try:
        conn = get_db_connection(); cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cms_backup_log (
                id           INT AUTO_INCREMENT PRIMARY KEY,
                filename     VARCHAR(200),
                size_kb      FLOAT DEFAULT 0,
                triggered_by VARCHAR(100),
                result       VARCHAR(300),
                created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute(
            "INSERT INTO cms_backup_log (filename, size_kb, triggered_by, result) VALUES (%s,%s,%s,%s)",
            (filename, size_kb, triggered_by, result_status)
        )
        conn.commit()
    except Exception:
        pass
    finally:
        try: conn.close()
        except: pass

def cms_get_backup_log(limit=50):
    """Return recent backup log entries."""
    try:
        conn = get_db_connection(); cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cms_backup_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                filename VARCHAR(200), size_kb FLOAT DEFAULT 0,
                triggered_by VARCHAR(100), result VARCHAR(300),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute(
            "SELECT * FROM cms_backup_log ORDER BY created_at DESC LIMIT %s", (limit,)
        )
        rows = [dict(r) for r in cur.fetchall()]
        # Convert datetime to string
        for r in rows:
            if hasattr(r.get("created_at"), "strftime"):
                r["created_at"] = r["created_at"].strftime("%Y-%m-%d %H:%M:%S")
        conn.close()
        return {"logs": rows}
    except Exception as e:
        return {"logs": [], "error": str(e)}

def cms_list_backups():
    """List all backup files on disk with metadata."""
    _ensure_backup_dir()
    backup_dir = get_active_backup_dir()
    files = []
    for fname in sorted(os.listdir(backup_dir), reverse=True):
        if fname.endswith(".sql.gz"):
            fpath = os.path.join(backup_dir, fname)
            files.append({
                "filename": fname,
                "size_kb":  round(os.path.getsize(fpath) / 1024, 1),
                "modified": datetime.fromtimestamp(os.path.getmtime(fpath)).strftime("%Y-%m-%d %H:%M:%S"),
            })
    return {"files": files}


# ══════════════════════════════════════════════════════════════════════════════
# SCRAP VENDOR LEDGER
# ══════════════════════════════════════════════════════════════════════════════

from datetime import date as _date_cls

def cms_init_scrap_vendor_tables():
    """
    Create scrap-vendor tables if they don't exist.
    Safe to call on every page load (all CREATE uses IF NOT EXISTS).
    Called from cms_page() in app.py immediately after cms_init_db().
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_scrap_vendors (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            name            VARCHAR(120) NOT NULL,
            contact         VARCHAR(60),
            address         TEXT,
            opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
            created_by      VARCHAR(100),
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migrate: add opening_balance if upgrading from old schema
    try:
        cur.execute(
            "ALTER TABLE cms_scrap_vendors "
            "ADD COLUMN opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER address"
        )
        conn.commit()
    except Exception:
        pass  # column already exists

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_scrap_vendor_txn (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            vendor_id   INT NOT NULL,
            txn_type    VARCHAR(20) NOT NULL,
            date        DATE NOT NULL,
            amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
            voucher_no  VARCHAR(60),
            description TEXT,
            created_by  VARCHAR(100),
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vendor_id) REFERENCES cms_scrap_vendors(id) ON DELETE CASCADE
        )
    """)

    conn.commit()
    conn.close()


def cms_get_scrap_vendors():
    """All vendors with live balance (opening + debit - payment)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT
            v.*,
            COALESCE(SUM(CASE WHEN t.txn_type IN ('opening','debit') THEN t.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.txn_type = 'payment' THEN t.amount ELSE 0 END), 0)
            AS balance
        FROM cms_scrap_vendors v
        LEFT JOIN cms_scrap_vendor_txn t ON t.vendor_id = v.id
        GROUP BY v.id
        ORDER BY v.name
    """)
    vendors = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"vendors": vendors}


def cms_save_scrap_vendor(payload):
    """
    Create or update a scrap vendor.
    If opening_balance != 0, inserts/updates an 'opening' txn row so the
    ledger starts with a proper B/F entry.
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        vid     = payload.get("id") or None
        name    = payload["name"]
        contact = payload.get("contact", "")
        address = payload.get("address", "")
        ob      = float(payload.get("opening_balance") or 0)
        ob_date = payload.get("ob_date") or str(_date_cls.today())
        cby     = payload.get("created_by", "")

        if vid:
            cur.execute("""
                UPDATE cms_scrap_vendors
                SET name=%s, contact=%s, address=%s, opening_balance=%s
                WHERE id=%s
            """, (name, contact, address, ob, vid))

            cur.execute(
                "SELECT id FROM cms_scrap_vendor_txn WHERE vendor_id=%s AND txn_type='opening'",
                (vid,)
            )
            ob_row = cur.fetchone()
            if ob_row:
                if ob != 0:
                    cur.execute(
                        "UPDATE cms_scrap_vendor_txn SET amount=%s, date=%s WHERE id=%s",
                        (abs(ob), ob_date, ob_row["id"])
                    )
                else:
                    cur.execute("DELETE FROM cms_scrap_vendor_txn WHERE id=%s", (ob_row["id"],))
            elif ob != 0:
                cur.execute("""
                    INSERT INTO cms_scrap_vendor_txn
                        (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                    VALUES (%s,'opening',%s,%s,'OB','Opening Balance',%s)
                """, (vid, ob_date, abs(ob), cby))
        else:
            cur.execute("""
                INSERT INTO cms_scrap_vendors (name, contact, address, opening_balance, created_by)
                VALUES (%s,%s,%s,%s,%s)
            """, (name, contact, address, ob, cby))
            vid = cur.lastrowid

            if ob != 0:
                cur.execute("""
                    INSERT INTO cms_scrap_vendor_txn
                        (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                    VALUES (%s,'opening',%s,%s,'OB','Opening Balance',%s)
                """, (vid, ob_date, abs(ob), cby))

        conn.commit()
        return {"status": "ok", "id": vid}
    except Exception as e:
        conn.rollback()
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


def cms_delete_scrap_vendor(vid):
    """Delete vendor and all their transactions (CASCADE handles txn rows)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("DELETE FROM cms_scrap_vendors WHERE id=%s", (vid,))
        conn.commit()
        return {"status": "ok"}
    except Exception as e:
        conn.rollback()
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


def cms_get_scrap_vendor_ledger(vendor_id):
    """
    Full ledger for one vendor with running balance.
    Order: opening first, then by date asc; returned reversed (newest on top).
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        SELECT * FROM cms_scrap_vendor_txn
        WHERE vendor_id = %s
        ORDER BY
            CASE WHEN txn_type='opening' THEN 0 ELSE 1 END,
            date ASC, id ASC
    """, (vendor_id,))
    rows = [dict(r) for r in cur.fetchall()]

    total_sold = 0.0
    total_paid = 0.0
    running    = 0.0
    for r in rows:
        amt = float(r["amount"])
        if r["txn_type"] in ("opening", "debit"):
            running    += amt
            if r["txn_type"] == "debit":
                total_sold += amt
        else:
            running    -= amt
            total_paid += amt
        r["running_balance"] = round(running, 2)

    ob_amount = next((float(r["amount"]) for r in rows if r["txn_type"] == "opening"), 0.0)
    rows_desc = list(reversed(rows))
    conn.close()
    return {
        "opening_balance": ob_amount,
        "total_sold":      total_sold,
        "total_paid":      total_paid,
        "balance":         round(running, 2),
        "entries":         rows_desc,
    }


def cms_save_scrap_vendor_txn(payload):
    """
    Save a debit (Scrap Debit Note) or payment (Payment Receipt) transaction.
    Auto-generates voucher using the shared cms_voucher_counter:
        DN-YYYY-NNNN  for debit notes
        PR-YYYY-NNNN  for payment receipts
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        txn_id    = payload.get("id") or None
        txn_type  = payload["txn_type"]
        vendor_id = int(payload["vendor_id"])
        date_str  = payload["date"]
        amount    = float(payload["amount"])
        desc      = payload.get("description", "")
        voucher   = (payload.get("voucher_no") or "").strip()
        cby       = payload.get("created_by", "")

        # Auto-generate voucher using central counter
        if not voucher:
            vtype = "DN" if txn_type == "debit" else "PR"
            voucher = cms_generate_voucher(cur, vtype, date_str)

        if txn_id:
            cur.execute("""
                UPDATE cms_scrap_vendor_txn
                SET vendor_id=%s, txn_type=%s, date=%s, amount=%s,
                    voucher_no=%s, description=%s
                WHERE id=%s
            """, (vendor_id, txn_type, date_str, amount, voucher, desc, txn_id))
        else:
            cur.execute("""
                INSERT INTO cms_scrap_vendor_txn
                    (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (vendor_id, txn_type, date_str, amount, voucher, desc, cby))
            txn_id = cur.lastrowid

        conn.commit()
        return {"status": "ok", "id": txn_id, "voucher_no": voucher}
    except Exception as e:
        conn.rollback()
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


def cms_get_scrap_vendor_txn(txn_id):
    """Fetch a single transaction with vendor info (for print preview)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT t.*, v.name AS vendor_name, v.contact AS vendor_contact
        FROM cms_scrap_vendor_txn t
        JOIN cms_scrap_vendors v ON v.id = t.vendor_id
        WHERE t.id = %s
    """, (txn_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else {}


def cms_delete_scrap_vendor_txn(txn_id):
    """Delete a transaction. Opening balance rows are protected."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT txn_type FROM cms_scrap_vendor_txn WHERE id=%s", (txn_id,))
        row = cur.fetchone()
        if row and row["txn_type"] == "opening":
            return {
                "status":  "error",
                "message": "Cannot delete the opening balance entry. Edit the vendor to change or clear it."
            }
        cur.execute("DELETE FROM cms_scrap_vendor_txn WHERE id=%s", (txn_id,))
        conn.commit()
        return {"status": "ok"}
    except Exception as e:
        conn.rollback()
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


def _prune_old_backups(keep=30):
    """Delete oldest backup files, keeping only `keep` most recent."""
    _ensure_backup_dir()
    backup_dir = get_active_backup_dir()
    files = sorted(
        [f for f in os.listdir(backup_dir) if f.endswith(".sql.gz")],
        reverse=True
    )
    for old in files[keep:]:
        try:
            os.remove(os.path.join(backup_dir, old))
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# QC INPROCESS CHECKS — moved to qc/qc_routes.py
# ══════════════════════════════════════════════════════════════════════════════
# Table creation (qc_inprocess_checks + qc_inprocess_params +
# qc_inprocess_params_history) and the underlying CRUD functions now live in
# qc/qc_routes.py and run automatically on app startup.
#
# The proxy functions below are kept for backward compatibility — any legacy
# code that imports sampling_portal.qc_inprocess_get_all() or
# sampling_portal.qc_inprocess_save() will continue to work.

def qc_inprocess_get_all():
    """Backward-compat proxy → qc.qc_routes.qc_inprocess_get_all()."""
    from qc.qc_routes import qc_inprocess_get_all as _impl
    return _impl()


def qc_inprocess_save(production_summary_id, qc_status, approved_by,
                      approval_dt, sample_qty, drums, remarks, created_by):
    """Backward-compat proxy → qc.qc_routes.qc_inprocess_save()."""
    from qc.qc_routes import qc_inprocess_save as _impl
    return _impl(production_summary_id, qc_status, approved_by,
                 approval_dt, sample_qty, drums, remarks, created_by)


# ══════════════════════════════════════════════════════════════════════════════
# CMS v3 — Ledger Group helpers (called from cms_portal via app.py routes)
# These two functions live here so no extra file is needed.
# ══════════════════════════════════════════════════════════════════════════════

def cms_v3_save_ledger_group(payload):
    """Create a new custom ledger group."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO cms_ledger_groups (name, nature, is_system) VALUES (%s, %s, 0)",
            (payload['name'], payload['nature'])
        )
        conn.commit()
        return {'status': 'ok', 'id': cur.lastrowid}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_v3_delete_ledger_group(gid):
    """Delete a custom ledger group — blocked if ledgers are assigned."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT is_system FROM cms_ledger_groups WHERE id = %s", (gid,))
        row = cur.fetchone()
        if not row:
            return {'status': 'error', 'message': 'Group not found'}
        if row['is_system']:
            return {'status': 'error', 'message': 'Cannot delete system groups'}
        cur.execute(
            "SELECT COUNT(*) as c FROM cms_ledgers WHERE ledger_group_id = %s", (gid,)
        )
        if cur.fetchone()['c'] > 0:
            return {'status': 'error', 'message': 'Ledgers are assigned to this group — remove them first'}
        cur.execute("DELETE FROM cms_ledger_groups WHERE id = %s AND is_system = 0", (gid,))
        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════════
# PACKING SAMPLE RECEIPT LOG
# ══════════════════════════════════════════════════════════════════

def _ensure_packing_table():
    conn = get_db_connection()
    if not conn:
        return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS packing_entries (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            entry_date          DATE          DEFAULT NULL,
            brand               VARCHAR(200)  DEFAULT NULL,
            product_name        VARCHAR(500)  DEFAULT NULL,
            batch_no            VARCHAR(100)  DEFAULT NULL,
            mfg_date            VARCHAR(50)   DEFAULT NULL,
            exp_date            VARCHAR(50)   DEFAULT NULL,
            sku_size            VARCHAR(100)  DEFAULT NULL,
            packaging_material  VARCHAR(100)  DEFAULT NULL,
            quantity            DECIMAL(10,2) DEFAULT NULL,
            samples_sent_by     VARCHAR(200)  DEFAULT NULL,
            mrp                 DECIMAL(10,2) DEFAULT NULL,
            status              VARCHAR(50)   DEFAULT 'Pending',
            received_date       DATE          DEFAULT NULL,
            testing_status      VARCHAR(50)   DEFAULT 'Pending',
            received_by         VARCHAR(200)  DEFAULT NULL,
            remark              TEXT          DEFAULT NULL,
            created_by          VARCHAR(100)  DEFAULT NULL,
            created_at          DATETIME      DEFAULT CURRENT_TIMESTAMP,
            updated_at          DATETIME      DEFAULT CURRENT_TIMESTAMP
                                              ON UPDATE CURRENT_TIMESTAMP
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    """)
    conn.commit()

    # ── Migration: make brand nullable if existing DB has it as NOT NULL ──
    try:
        conn.execute("""
            ALTER TABLE packing_entries
            MODIFY COLUMN brand VARCHAR(200) DEFAULT NULL
        """)
        conn.commit()
    except Exception:
        pass  # already nullable — safe to ignore

    conn.close()


_ensure_packing_table()


def packing_list(from_date='', to_date=''):
    """Return packing entries optionally filtered by date range."""
    conn = get_db_connection()
    where, params = [], []
    if from_date:
        where.append("DATE(entry_date) >= %s"); params.append(from_date)
    if to_date:
        where.append("DATE(entry_date) <= %s"); params.append(to_date)
    clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(
        f"SELECT * FROM packing_entries {clause} ORDER BY entry_date DESC, id DESC",
        params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def packing_save(data, created_by=''):
    """
    Insert or update a packing entry.
    If data contains _qc_only=True, only QC-owned fields are updated
    (status, received_date, testing_status, received_by, remark).
    """
    conn = get_db_connection()
    row_id  = data.get('id')
    qc_only = data.get('_qc_only', False)

    if row_id and qc_only:
        # QC users — only update 3 fields
        conn.execute("""
            UPDATE packing_entries
               SET status        = %s,
                   received_date = %s,
                   remark        = %s,
                   updated_at    = NOW()
             WHERE id = %s
        """, (
            data.get('status') or 'Pending',
            data.get('received_date') or None,
            (data.get('remark') or '').strip() or None,
            int(row_id),
        ))
        conn.commit()
        conn.close()
        return int(row_id)

    if row_id:
        # Full update
        conn.execute("""
            UPDATE packing_entries
               SET entry_date         = %s,
                   brand              = %s,
                   product_name       = %s,
                   batch_no           = %s,
                   mfg_date           = %s,
                   exp_date           = %s,
                   sku_size           = %s,
                   packaging_material = %s,
                   quantity           = %s,
                   samples_sent_by    = %s,
                   mrp                = %s,
                   status             = %s,
                   received_date      = %s,
                   testing_status     = %s,
                   received_by        = %s,
                   remark             = %s,
                   updated_at         = NOW()
             WHERE id = %s
        """, (
            data.get('entry_date') or None,
            (data.get('brand') or '').strip() or None,
            (data.get('product_name') or '').strip() or None,
            (data.get('batch_no') or '').strip() or None,
            (data.get('mfg_date') or '').strip() or None,
            (data.get('exp_date') or '').strip() or None,
            (data.get('sku_size') or '').strip() or None,
            (data.get('packaging_material') or '').strip() or None,
            data.get('quantity') or None,
            (data.get('samples_sent_by') or '').strip() or None,
            data.get('mrp') or None,
            data.get('status') or 'Pending',
            data.get('received_date') or None,
            data.get('testing_status') or 'Pending',
            (data.get('received_by') or '').strip() or None,
            (data.get('remark') or '').strip() or None,
            int(row_id),
        ))
        conn.commit()
        conn.close()
        return int(row_id)

    # Insert new row
    cur = conn.execute("""
        INSERT INTO packing_entries
            (entry_date, brand, product_name, batch_no, mfg_date, exp_date,
             sku_size, packaging_material, quantity, samples_sent_by, mrp,
             status, received_date, testing_status, received_by, remark, created_by)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (
        data.get('entry_date') or None,
        (data.get('brand') or '').strip() or None,
        (data.get('product_name') or '').strip() or None,
        (data.get('batch_no') or '').strip() or None,
        (data.get('mfg_date') or '').strip() or None,
        (data.get('exp_date') or '').strip() or None,
        (data.get('sku_size') or '').strip() or None,
        (data.get('packaging_material') or '').strip() or None,
        data.get('quantity') or None,
        (data.get('samples_sent_by') or '').strip() or None,
        data.get('mrp') or None,
        data.get('status') or 'Pending',
        data.get('received_date') or None,
        data.get('testing_status') or 'Pending',
        (data.get('received_by') or '').strip() or None,
        (data.get('remark') or '').strip() or None,
        created_by,
    ))
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def packing_delete(row_id):
    """Hard delete a packing entry by id."""
    conn = get_db_connection()
    conn.execute("DELETE FROM packing_entries WHERE id = %s", (int(row_id),))
    conn.commit()
    conn.close()


