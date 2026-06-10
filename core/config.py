"""
core/config.py  --  Common configuration for HCP Portal.

Single source of truth for the MySQL connection used across the whole
project (core/sampling_portal.py, modules/cms_portal.py,
services/backup_system.py, migration scripts, etc.).

Every value can be overridden with an environment variable for production,
so you never have to edit code or commit a real password.

    HCP_DB_HOST       (default: localhost)
    HCP_DB_PORT       (default: 3306)
    HCP_DB_USER       (default: root)
    HCP_DB_PASSWORD   (default: the local dev password)
    HCP_DB_NAME       (default: hcp_portal)
    HCP_DB_CHARSET    (default: utf8mb4)
    SECRET_KEY        (Flask secret)
"""

import os
import urllib.parse as _urlquote

# ── MySQL connection ─────────────────────────────────────────────────────────
DB_HOST     = os.environ.get("HCP_DB_HOST", "localhost")
DB_PORT     = int(os.environ.get("HCP_DB_PORT", "3306"))
DB_USER     = os.environ.get("HCP_DB_USER", "root")
DB_PASSWORD = os.environ.get("HCP_DB_PASSWORD", "Krunal@2424")
DB_NAME     = os.environ.get("HCP_DB_NAME", "erpnew")
DB_CHARSET  = os.environ.get("HCP_DB_CHARSET", "utf8mb4")

# Ready-made kwargs dict for  pymysql.connect(**DB_CONFIG)
DB_CONFIG = {
    "host":     DB_HOST,
    "port":     DB_PORT,
    "user":     DB_USER,
    "password": DB_PASSWORD,
    "database": DB_NAME,
    "charset":  DB_CHARSET,
}

# SQLAlchemy-style URI, in case any module ever wants it
SQLALCHEMY_DATABASE_URI = (
    "mysql+pymysql://%s:%s@%s:%s/%s?charset=%s"
    % (DB_USER, _urlquote.quote_plus(DB_PASSWORD), DB_HOST, DB_PORT, DB_NAME, DB_CHARSET)
)

# ── Flask / app ──────────────────────────────────────────────────────────────
SECRET_KEY = os.environ.get("SECRET_KEY", "hcp-portal-secret-key-2024")
