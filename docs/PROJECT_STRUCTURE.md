# Project Structure — HCP Portal (Tarak Web Apps)

Reorganised June 2026 to mirror the HCP-ERP folder layout.

## Run

```bash
python app.py
```

`app.py` adds `core/ models/ services/ modules/ scripts/` to `sys.path` at
startup, so every existing import keeps working without changes.

## Root Layout

```text
.
|-- app.py                # Flask entry point + path bootstrap + blueprint registration
|-- requirements.txt      # Python dependencies
|-- README.md
|-- .gitignore
|-- start_portal.bat      # Windows launcher
|-- hcperp.service        # systemd unit (Linux)
|-- hcperp.co.in.nginx    # nginx site config
|
|-- core/                 # Config + DB connection + shared helpers + access control
|-- models/               # DB schema / table bootstrap
|-- services/             # Integrations (Gmail, backup, CCTV stream manager)
|-- modules/              # Feature blueprints (packages + route modules)
|-- scripts/              # One-off scripts, migrations, SQL, patches, snippets
|-- docs/                 # Documentation and patch notes
|-- archive/              # Legacy / broken / superseded files (not imported)
|
|-- templates/            # Jinja templates
|-- static/               # CSS, JS, images, uploads
|-- uploads/              # Runtime uploads
|-- database/             # Local DB files
```

## Important Paths

```text
core/config.py            <-- COMMON connection config (single source of truth)
core/sampling_portal.py   <-- MySQL connection hub (reads core/config.py)
core/portal_helpers.py
core/device_access.py

models/hcp_stock_db.py     # table bootstrap / schema

services/gmail_helpers.py
services/backup_system.py
services/cctv_go2rtc_manager.py

modules/inventory/         # package
modules/pm_stock/          # package
modules/qc/                # package
modules/procurement/       # package
modules/rm_store/          # package
modules/hr_salary_routes.py
modules/cms_portal.py
modules/fg_routes.py
modules/planning_routes.py
... (all feature route modules)

scripts/migrate_sqlite_to_mysql.py
scripts/*.sql
```

## Connection config

All DB connection settings now live in **`core/config.py`**. Edit that one
file (or set the `HCP_DB_*` environment variables) to change host, user,
password, or database name. `core/sampling_portal.py`,
`modules/cms_portal.py`, and `services/backup_system.py` all read from it.

```text
HCP_DB_HOST       (default: localhost)
HCP_DB_PORT       (default: 3306)
HCP_DB_USER       (default: root)
HCP_DB_PASSWORD   (default: the local dev password)
HCP_DB_NAME       (default: hcp_portal)
```

## Archive

Files in `archive/` are NOT imported by the running app (verified):
- `app_broken.py`            — old broken copy of app.py
- `user_admin--.py`          — backup of user_admin.py
- `procurement.py`           — superseded by the `modules/procurement/` package
- `production_initiater_routes.py` — superseded by `modules/rm_store/production_initiater_routes.py`
