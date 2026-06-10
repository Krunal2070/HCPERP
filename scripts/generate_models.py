"""
scripts/generate_models.py  --  Auto-generate SQLAlchemy ORM models
from the existing hcp_portal database (Option C).

Reflects the LIVE database and writes one model class per table into
models/db_models.py — just like the HCPERP `models/` layer, but generated
from the schema you already have. Your app keeps running on raw SQL; these
models are there for new code or a gradual ORM migration.

PREREQUISITE (install once, with the venv active):

    pip install sqlacodegen

RUN (from the project root, venv active):

    python scripts/generate_models.py

OUTPUT:

    models/db_models.py        (all tables as declarative ORM classes)

Re-run any time the schema changes to refresh the models.
"""

import os
import sys
import subprocess

# ── Make core/config.py importable when run from the project root ────────────
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CORE = os.path.join(_ROOT, "core")
if _CORE not in sys.path:
    sys.path.insert(0, _CORE)

try:
    from config import SQLALCHEMY_DATABASE_URI as DB_URI
except Exception:
    # Fallback: build the URI from individual settings
    try:
        from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
    except Exception:
        DB_HOST, DB_PORT, DB_USER = "localhost", 3306, "root"
        DB_PASSWORD, DB_NAME = "Tarak@2424123", "hcp_portal"
    import urllib.parse as _up
    DB_URI = (
        "mysql+pymysql://%s:%s@%s:%s/%s?charset=utf8mb4"
        % (DB_USER, _up.quote_plus(DB_PASSWORD), DB_HOST, DB_PORT, DB_NAME)
    )

OUTFILE = os.path.join(_ROOT, "models", "db_models.py")


def _have_sqlacodegen():
    try:
        subprocess.run(
            [sys.executable, "-m", "sqlacodegen", "--version"],
            check=True, capture_output=True,
        )
        return True
    except Exception:
        return False


def main():
    if not _have_sqlacodegen():
        print("ERROR: sqlacodegen is not installed in this environment.\n"
              "Install it first (venv active):\n\n"
              "    pip install sqlacodegen\n")
        sys.exit(1)

    os.makedirs(os.path.dirname(OUTFILE), exist_ok=True)

    safe_uri = DB_URI.split("@")[-1]  # hide password in the printout
    print(f"Reflecting database @ {safe_uri}")
    print(f"Writing models to: {OUTFILE}\n")

    cmd = [
        sys.executable, "-m", "sqlacodegen",
        DB_URI,
        "--generator", "declarative",   # class-per-table ORM models
        "--noviews",                    # skip DB views
        "--outfile", OUTFILE,
    ]

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"\nsqlacodegen failed (exit {e.returncode}). "
              f"Check that MySQL is running and the database exists.")
        sys.exit(e.returncode)

    # Quick summary
    try:
        with open(OUTFILE, encoding="utf-8") as f:
            txt = f.read()
        n_classes = txt.count("class ")
        print(f"\nDone. Generated {n_classes} model class(es) in models/db_models.py")
        print("Import them with:  from models.db_models import <ClassName>")
    except Exception:
        print("\nDone (could not read output file for summary).")


if __name__ == "__main__":
    main()
