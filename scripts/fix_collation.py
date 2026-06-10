"""
scripts/fix_collation.py  --  One-shot fix for MySQL error 1267
("Illegal mix of collations utf8mb4_0900_ai_ci vs utf8mb4_unicode_ci").

On MySQL 8 the default collation for utf8mb4 is utf8mb4_0900_ai_ci, while this
app creates its database as utf8mb4_unicode_ci. Tables created with only
"CHARSET=utf8mb4" (no COLLATE) therefore end up as 0900_ai_ci, and any query
comparing them against a unicode_ci column fails.

This script converts the whole database + every table to ONE collation
(utf8mb4_unicode_ci) so all comparisons match. Safe to re-run.

Run once, from the project root, with the venv active:

    python scripts/fix_collation.py
"""

import os
import sys

# Make core/config.py importable when run from the project root
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (os.path.join(_ROOT, "core"),):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pymysql

try:
    from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
except Exception:
    DB_HOST, DB_PORT, DB_USER = "localhost", 3306, "root"
    DB_PASSWORD, DB_NAME = "Tarak@2424123", "hcp_portal"

TARGET_CHARSET   = "utf8mb4"
TARGET_COLLATION = "utf8mb4_unicode_ci"


def main():
    print(f"Connecting to {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME} ...")
    conn = pymysql.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER,
        password=DB_PASSWORD, database=DB_NAME, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            # 1) Database default collation
            cur.execute(
                f"ALTER DATABASE `{DB_NAME}` "
                f"CHARACTER SET {TARGET_CHARSET} COLLATE {TARGET_COLLATION}"
            )
            print(f"OK  database default -> {TARGET_COLLATION}")

            # 2) Every base table
            cur.execute(
                "SELECT TABLE_NAME FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE' "
                "ORDER BY TABLE_NAME",
                (DB_NAME,),
            )
            tables = [r[0] for r in cur.fetchall()]
            print(f"Found {len(tables)} tables. Converting...\n")

            ok, failed = 0, []
            for t in tables:
                try:
                    cur.execute(
                        f"ALTER TABLE `{t}` "
                        f"CONVERT TO CHARACTER SET {TARGET_CHARSET} "
                        f"COLLATE {TARGET_COLLATION}"
                    )
                    ok += 1
                    print(f"  OK   {t}")
                except Exception as e:
                    failed.append((t, str(e)))
                    print(f"  FAIL {t}  -> {e}")

        conn.commit()
        print(f"\nDone. Converted {ok}/{len(tables)} tables to {TARGET_COLLATION}.")
        if failed:
            print(f"\n{len(failed)} table(s) failed (review above):")
            for t, e in failed:
                print(f"   - {t}: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
