"""
migrate_sqlite_to_mysql.py  —  SMART VERSION
• Reads every column from SQLite automatically
• If a column is missing in MySQL it adds it on the fly
• INSERT IGNORE = safe to run multiple times
• Skips empty tables silently
"""

import sqlite3
import pymysql
import os
from datetime import datetime

# ── Edit these ────────────────────────────────────────────────────────────────
SQLITE_FILE = r"E:\TARAK WEB APPS\database\hcp_lan_portal.db"

MYSQL_HOST     = "localhost"
MYSQL_PORT     = 3306
MYSQL_USER     = "root"
MYSQL_PASSWORD = "Tarak@2424123"
MYSQL_DB       = "hcp_portal"
# ─────────────────────────────────────────────────────────────────────────────

TABLES = [
    "User_Tbl",
    "rd_sampling_requests",
    "qc_sampling_records",
    "canteen_employees",
    "canteen_lunch_entries",
    "canteen_expenses",
    "canteen_payments",
    "canteen_monthly_summary",
    "canteen_opening_balance",
    "canteen_holidays",
    "canteen_advance_payments",
    "task_reminders",
    "task_push_reminders",
]


def sqlite_conn():
    conn = sqlite3.connect(SQLITE_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def mysql_conn():
    return pymysql.connect(
        host=MYSQL_HOST, port=MYSQL_PORT,
        user=MYSQL_USER, password=MYSQL_PASSWORD,
        database=MYSQL_DB, charset="utf8mb4",
        autocommit=False,
        cursorclass=pymysql.cursors.DictCursor
    )


def get_mysql_columns(my_conn, table_name):
    with my_conn.cursor() as cur:
        cur.execute(f"SHOW COLUMNS FROM `{table_name}`")
        rows = cur.fetchall()
    return {r["Field"] for r in rows}


def mysql_table_exists(my_conn, table_name):
    with my_conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as cnt FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
        """, (MYSQL_DB, table_name))
        return cur.fetchone()["cnt"] > 0


def add_missing_columns(my_conn, table_name, sqlite_columns):
    existing = get_mysql_columns(my_conn, table_name)
    added = []
    for col in sqlite_columns:
        if col == "id":
            continue
        if col not in existing:
            try:
                with my_conn.cursor() as cur:
                    cur.execute(f"ALTER TABLE `{table_name}` ADD COLUMN `{col}` TEXT")
                my_conn.commit()
                added.append(col)
            except Exception as e:
                print(f"    Could not add column '{col}': {e}")
    if added:
        print(f"    Added missing columns: {', '.join(added)}")


def migrate_table(sl_conn, my_conn, table_name):
    sl_cur = sl_conn.cursor()

    sl_cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,)
    )
    if not sl_cur.fetchone():
        print(f"  --  '{table_name}' not found in SQLite — skipped.")
        return 0

    sl_cur.execute(f'SELECT * FROM "{table_name}"')
    rows = sl_cur.fetchall()

    if not rows:
        print(f"  --  '{table_name}' is empty — skipped.")
        return 0

    columns = list(rows[0].keys())

    if not mysql_table_exists(my_conn, table_name):
        print(f"  XX  '{table_name}' not in MySQL — skipped. Start app.py first.")
        return 0

    add_missing_columns(my_conn, table_name, columns)

    col_list  = ", ".join(f"`{c}`" for c in columns)
    val_place = ", ".join(["%s"] * len(columns))
    sql       = f"INSERT IGNORE INTO `{table_name}` ({col_list}) VALUES ({val_place})"

    data = []
    for row in rows:
        tuple_row = []
        for col in columns:
            val = row[col]
            if isinstance(val, bytes):
                val = val.decode("utf-8", errors="replace")
            tuple_row.append(val)
        data.append(tuple(tuple_row))

    total_inserted = 0
    batch_size = 500
    with my_conn.cursor() as cur:
        for i in range(0, len(data), batch_size):
            batch = data[i:i + batch_size]
            cur.executemany(sql, batch)
            my_conn.commit()
            total_inserted += len(batch)

    print(f"  OK  '{table_name}' -> {total_inserted} rows migrated.")
    return total_inserted


def main():
    if not os.path.exists(SQLITE_FILE):
        print(f"\nERROR: SQLite file not found: {SQLITE_FILE}")
        print(f"Check the SQLITE_FILE path at the top of this script.")
        return

    print(f"\n{'─'*55}")
    print(f"  HCP Portal  - SQLite to MySQL Migration")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'─'*55}\n")

    sl = sqlite_conn()
    my = mysql_conn()

    total = 0
    for table in TABLES:
        try:
            total += migrate_table(sl, my, table)
        except Exception as e:
            print(f"  ERROR  '{table}' failed: {e}")

    sl.close()
    my.close()

    print(f"\n{'─'*55}")
    print(f"  Done! Total rows inserted: {total}")
    print(f"{'─'*55}\n")


if __name__ == "__main__":
    main()
