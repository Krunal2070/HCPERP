"""
user_admin.py  — User administration module
============================================
Drop-in Flask Blueprint for HCP ERP.

What this gives you
-------------------
* A "Create User" page (Option B: split form + live preview), styled with the
  NotebookLM light / 3D-gradient theme.
* Four lookup tables that replace the previously-hardcoded dropdown values:
      lookup_department, lookup_designation, lookup_user_type, lookup_access_level
  Each is editable through a CRUD modal on the create-user page (add / rename /
  toggle-active / delete) via JSON endpoints — no page reload needed.
* When you create a user, the SELECTED lookup values are written straight into
  user_tbl (department / designation / user_type / access_level columns).
* The `role` column is no longer on the form. It still exists in user_tbl and is
  written with a safe default so existing queries that COALESCE(role,'') keep working.

IMPORTANT — wiring into your app
--------------------------------
This blueprint owns ONLY the four lookup tables and their CRUD endpoints.
It does NOT create users itself — your existing /create_user route in app.py
already does that correctly (it calls sampling_portal.create_new_user, which
hashes the password the same way /login verifies it). We keep that intact.

Step 1 — register the blueprint + create the lookup tables. In app.py, next to
your other register_blueprint(...) calls:

    from user_admin import user_admin_bp, ensure_user_admin_tables, _fetch_lookups
    app.register_blueprint(user_admin_bp)
    ensure_user_admin_tables()          # after DB is ready

Step 2 — feed the lookups to your EXISTING create_user route. In each of the
four `render_template('create_user.html', ...)` calls inside your create_user()
function, add `lookups=_fetch_lookups()`. For example:

    return render_template('create_user.html', lookups=_fetch_lookups())
    return render_template('create_user.html', lookups=_fetch_lookups(), error=message)
    return render_template('create_user.html', lookups=_fetch_lookups(), success=message)

That is the whole change to app.py — your POST logic, password handling, and
profile-photo upload stay exactly as they are.

Place this file next to sampling_portal.py (same import path the pm_stock
helpers use: `import sampling_portal`). Place create_user.html in templates/.
"""

from flask import (
    Blueprint, render_template, request, jsonify, session, redirect, url_for
)
from functools import wraps
import sys as _sys

import sampling_portal  # shared DB helper — provides get_db_connection()

user_admin_bp = Blueprint('user_admin', __name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers (mirror the patterns already used in pm_stock/helpers.py)
# ─────────────────────────────────────────────────────────────────────────────
def _current_user():
    return session.get('User_Name') or session.get('UID') or 'Unknown'


def _row_to_dict(row, cursor=None):
    """Normalize any DB row (dict, sqlite3.Row, tuple) to a plain dict.
    Works whether sampling_portal's cursor is a DictCursor, a Row factory,
    or a plain tuple cursor."""
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    # sqlite3.Row / mapping-like with keys()
    try:
        return {k: row[k] for k in row.keys()}
    except Exception:
        pass
    # tuple/list — need column names from the cursor description
    if cursor is not None and getattr(cursor, 'description', None):
        cols = [c[0] for c in cursor.description]
        return {cols[i]: row[i] for i in range(min(len(cols), len(row)))}
    return {}


def _rows_to_dicts(cursor):
    """fetchall() + normalize, capturing cursor.description for tuple cursors."""
    rows = cursor.fetchall()
    return [_row_to_dict(r, cursor) for r in rows]


def _scalar(cursor):
    """fetchone() and return its first value regardless of row type."""
    row = cursor.fetchone()
    if row is None:
        return None
    if isinstance(row, dict):
        return next(iter(row.values()), None)
    try:
        return row[0]
    except Exception:
        d = _row_to_dict(row, cursor)
        return next(iter(d.values()), None)


def _is_admin():
    """Permission gate. Matches every other module: user_type == 'admin'."""
    return (session.get('User_Type', '') or '').strip().lower() == 'admin'


def _admin_required(f):
    """Page guard for admin-only routes. Mirrors the inline checks used across
    __init__.py (e.g. `if session.get('User_Type','').lower() != 'admin'`)."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            # API calls get JSON; page navigations get redirected to login.
            if request.path.startswith('/users/lookup'):
                return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
            return redirect(url_for('login') if _has_endpoint('login') else '/login')
        if not _is_admin():
            if request.path.startswith('/users/lookup'):
                return jsonify({'status': 'error', 'message': 'Admin only'}), 403
            return ("Admin access required.", 403)
        return f(*args, **kwargs)
    return wrapper


def _has_endpoint(name):
    try:
        from flask import current_app
        return name in current_app.view_functions
    except Exception:
        return False


# Map the URL <kind> segment to its table + display column(s).
# access_level is special: it stores an integer + a human label.
_LOOKUP_TABLES = {
    'department':   {'table': 'lookup_department',   'value_col': 'value'},
    'designation':  {'table': 'lookup_designation',  'value_col': 'value'},
    'user_type':    {'table': 'lookup_user_type',    'value_col': 'value'},
    'access_level': {'table': 'lookup_access_level',  'value_col': 'label'},
}


# ─────────────────────────────────────────────────────────────────────────────
# Schema bootstrap (idempotent — same style as ensure_pm_tables)
# ─────────────────────────────────────────────────────────────────────────────
def ensure_user_admin_tables():
    """Create the four lookup tables if missing and seed them from whatever
    values already exist in user_tbl, so the dropdowns are never empty on a
    live system. Safe to call on every startup."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[user_admin] ensure_user_admin_tables: no DB connection", file=_sys.stderr)
        return

    # --- the three simple value lookups -------------------------------------
    for tbl in ('lookup_department', 'lookup_designation', 'lookup_user_type'):
        try:
            conn.execute(f"""
                CREATE TABLE IF NOT EXISTS {tbl} (
                    id          INT AUTO_INCREMENT PRIMARY KEY,
                    value       VARCHAR(150) NOT NULL,
                    sort_order  INT          DEFAULT 0,
                    is_active   TINYINT(1)   DEFAULT 1,
                    created_by  VARCHAR(100) DEFAULT '',
                    created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_{tbl}_value (value)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            conn.commit()
        except Exception as e:
            print(f"[user_admin] create {tbl} failed: {e}", file=_sys.stderr)

    # --- access level (int + label) -----------------------------------------
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS lookup_access_level (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                level_int   INT          NOT NULL,
                label       VARCHAR(150) NOT NULL,
                sort_order  INT          DEFAULT 0,
                is_active   TINYINT(1)   DEFAULT 1,
                created_by  VARCHAR(100) DEFAULT '',
                created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_lookup_access_level (level_int)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception as e:
        print(f"[user_admin] create lookup_access_level failed: {e}", file=_sys.stderr)

    # --- seed from existing user_tbl distinct values ------------------------
    # Wrapped so a read failure on user_tbl never blocks startup.
    def _seed(col, tbl):
        try:
            cur = conn.execute(
                f"SELECT DISTINCT TRIM({col}) AS v FROM `User_Tbl` "
                f"WHERE {col} IS NOT NULL AND TRIM({col}) <> ''"
            )
            rows = _rows_to_dicts(cur)
            for i, r in enumerate(rows):
                v = (r.get('v') or '').strip()
                if not v:
                    continue
                conn.execute(
                    f"INSERT IGNORE INTO {tbl} (value, sort_order, created_by) "
                    f"VALUES (%s,%s,%s)", (v, i, 'seed')
                )
            conn.commit()
        except Exception as e:
            print(f"[user_admin] seed {tbl} from {col} skipped: {e}", file=_sys.stderr)

    _seed('department',  'lookup_department')
    _seed('designation', 'lookup_designation')
    _seed('user_type',   'lookup_user_type')

    # Guarantee 'admin' exists in user_type — it is the master permission key.
    try:
        conn.execute(
            "INSERT IGNORE INTO lookup_user_type (value, sort_order, created_by) "
            "VALUES (%s,%s,%s)", ('admin', 0, 'system')
        )
        conn.commit()
    except Exception as e:
        print(f"[user_admin] seed admin user_type skipped: {e}", file=_sys.stderr)

    # Seed access levels from distinct ints already in user_tbl, else a sane default set.
    try:
        cur = conn.execute(
            "SELECT DISTINCT access_level AS lvl FROM `User_Tbl` "
            "WHERE access_level IS NOT NULL"
        )
        rows = _rows_to_dicts(cur)
        existing = [r.get('lvl') for r in rows]
        existing = [int(x) for x in existing if x is not None]
        if existing:
            for lvl in sorted(set(existing)):
                conn.execute(
                    "INSERT IGNORE INTO lookup_access_level (level_int, label, sort_order, created_by) "
                    "VALUES (%s,%s,%s,%s)", (lvl, f"{lvl}", lvl, 'seed')
                )
        else:
            for lvl, label in [(1, '1 - Basic'), (2, '2 - Standard'),
                               (3, '3 - Advanced'), (4, '4 - Manager'),
                               (5, '5 - Admin')]:
                conn.execute(
                    "INSERT IGNORE INTO lookup_access_level (level_int, label, sort_order, created_by) "
                    "VALUES (%s,%s,%s,%s)", (lvl, label, lvl, 'seed')
                )
        conn.commit()
    except Exception as e:
        print(f"[user_admin] seed access levels skipped: {e}", file=_sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# Lookup helpers used by the page + endpoints
# ─────────────────────────────────────────────────────────────────────────────
def _fetch_lookups():
    """Return all four active lookup lists for rendering the dropdowns."""
    conn = sampling_portal.get_db_connection()
    out = {'department': [], 'designation': [], 'user_type': [], 'access_level': []}
    if not conn:
        return out
    try:
        for kind in ('department', 'designation', 'user_type'):
            tbl = _LOOKUP_TABLES[kind]['table']
            cur = conn.execute(
                f"SELECT id, value, is_active FROM {tbl} "
                f"WHERE is_active=1 ORDER BY sort_order, value"
            )
            out[kind] = _rows_to_dicts(cur)
        cur = conn.execute(
            "SELECT id, level_int, label, is_active FROM lookup_access_level "
            "WHERE is_active=1 ORDER BY sort_order, level_int"
        )
        out['access_level'] = _rows_to_dicts(cur)
    except Exception as e:
        print(f"[user_admin] _fetch_lookups failed: {e}", file=_sys.stderr)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Routes — Lookup CRUD (JSON). One handler covers all four kinds.
#   GET    /users/lookup/<kind>          list all rows (incl. inactive)
#   POST   /users/lookup/<kind>          create   {value, level_int?}
#   PUT    /users/lookup/<kind>/<id>     update   {value?, level_int?, is_active?}
#   DELETE /users/lookup/<kind>/<id>     delete
# ─────────────────────────────────────────────────────────────────────────────
def _valid_kind(kind):
    return kind in _LOOKUP_TABLES


@user_admin_bp.route('/users/lookup/reseed', methods=['POST', 'GET'])
@_admin_required
def lookup_reseed():
    """Run ensure_user_admin_tables() on demand — creates tables if missing and
    inserts any new distinct values from User_Tbl that aren't in the lookups yet.
    Safe to call repeatedly; uses INSERT IGNORE so existing rows aren't touched."""
    try:
        ensure_user_admin_tables()
        data = _fetch_lookups()
        counts = {k: len(v) for k, v in data.items()}
        return jsonify({'status': 'ok', 'counts': counts,
                        'message': 'Lookup tables seeded from User_Tbl.'})
    except Exception as e:
        print(f"[user_admin] reseed failed: {e}", file=_sys.stderr)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@user_admin_bp.route('/users/lookup/<kind>', methods=['GET'])
@_admin_required
def lookup_list(kind):
    if not _valid_kind(kind):
        return jsonify({'status': 'error', 'message': 'Unknown list'}), 404
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    tbl = _LOOKUP_TABLES[kind]['table']
    try:
        if kind == 'access_level':
            cur = conn.execute(
                f"SELECT id, level_int, label, sort_order, is_active FROM {tbl} "
                f"ORDER BY sort_order, level_int"
            )
        else:
            cur = conn.execute(
                f"SELECT id, value, sort_order, is_active FROM {tbl} "
                f"ORDER BY sort_order, value"
            )
        return jsonify({'status': 'ok', 'items': _rows_to_dicts(cur)})
    except Exception as e:
        print(f"[user_admin] lookup_list {kind} failed: {e}", file=_sys.stderr)
        return jsonify({'status': 'error', 'message': 'Could not load list.'}), 500


@user_admin_bp.route('/users/lookup/<kind>', methods=['POST'])
@_admin_required
def lookup_create(kind):
    if not _valid_kind(kind):
        return jsonify({'status': 'error', 'message': 'Unknown list'}), 404
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    d = request.get_json(silent=True) or {}
    tbl = _LOOKUP_TABLES[kind]['table']
    try:
        if kind == 'access_level':
            label = (d.get('label') or '').strip()
            try:
                level_int = int(d.get('level_int'))
            except (TypeError, ValueError):
                return jsonify({'status': 'error', 'message': 'A numeric level is required.'}), 400
            if not label:
                label = str(level_int)
            conn.execute(
                f"INSERT INTO {tbl} (level_int, label, sort_order, created_by) "
                f"VALUES (%s,%s,%s,%s)", (level_int, label, level_int, _current_user())
            )
        else:
            value = (d.get('value') or '').strip()
            if not value:
                return jsonify({'status': 'error', 'message': 'A value is required.'}), 400
            conn.execute(
                f"INSERT INTO {tbl} (value, created_by) VALUES (%s,%s)",
                (value, _current_user())
            )
        conn.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        msg = 'That value already exists.' if 'Duplicate' in str(e) else 'Could not add.'
        print(f"[user_admin] lookup_create {kind} failed: {e}", file=_sys.stderr)
        return jsonify({'status': 'error', 'message': msg}), 400


@user_admin_bp.route('/users/lookup/<kind>/<int:row_id>', methods=['PUT'])
@_admin_required
def lookup_update(kind, row_id):
    if not _valid_kind(kind):
        return jsonify({'status': 'error', 'message': 'Unknown list'}), 404
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    d = request.get_json(silent=True) or {}
    tbl = _LOOKUP_TABLES[kind]['table']

    # Protect the master 'admin' user_type from rename / deactivation.
    if kind == 'user_type':
        try:
            _c = conn.execute(f"SELECT value FROM {tbl} WHERE id=%s", (row_id,))
            cur_val = (_scalar(_c) or '')
            new_val = (d.get('value') or cur_val).strip()
            deactivating = ('is_active' in d and int(d.get('is_active')) == 0)
            if cur_val.strip().lower() == 'admin' and (new_val.lower() != 'admin' or deactivating):
                return jsonify({'status': 'error',
                                'message': 'The "admin" user type is protected and cannot be renamed or disabled.'}), 400
        except Exception as e:
            print(f"[user_admin] admin-guard check failed: {e}", file=_sys.stderr)

    try:
        sets, params = [], []
        if kind == 'access_level':
            if 'level_int' in d:
                sets.append('level_int=%s'); params.append(int(d['level_int']))
            if 'label' in d:
                sets.append('label=%s'); params.append((d['label'] or '').strip())
        else:
            if 'value' in d:
                sets.append('value=%s'); params.append((d['value'] or '').strip())
        if 'is_active' in d:
            sets.append('is_active=%s'); params.append(1 if int(d['is_active']) else 0)
        if not sets:
            return jsonify({'status': 'error', 'message': 'Nothing to update.'}), 400
        params.append(row_id)
        conn.execute(f"UPDATE {tbl} SET {', '.join(sets)} WHERE id=%s", tuple(params))
        conn.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        msg = 'That value already exists.' if 'Duplicate' in str(e) else 'Could not update.'
        print(f"[user_admin] lookup_update {kind} failed: {e}", file=_sys.stderr)
        return jsonify({'status': 'error', 'message': msg}), 400


@user_admin_bp.route('/users/lookup/<kind>/<int:row_id>', methods=['DELETE'])
@_admin_required
def lookup_delete(kind, row_id):
    if not _valid_kind(kind):
        return jsonify({'status': 'error', 'message': 'Unknown list'}), 404
    conn = sampling_portal.get_db_connection()
    if not conn:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503
    tbl = _LOOKUP_TABLES[kind]['table']

    # Never allow deleting the 'admin' user type.
    if kind == 'user_type':
        try:
            _c = conn.execute(f"SELECT value FROM {tbl} WHERE id=%s", (row_id,))
            cur_val = (_scalar(_c) or '')
            if cur_val.strip().lower() == 'admin':
                return jsonify({'status': 'error',
                                'message': 'The "admin" user type is protected and cannot be deleted.'}), 400
        except Exception as e:
            print(f"[user_admin] admin-guard delete check failed: {e}", file=_sys.stderr)

    try:
        conn.execute(f"DELETE FROM {tbl} WHERE id=%s", (row_id,))
        conn.commit()
        return jsonify({'status': 'ok'})
    except Exception as e:
        # Most likely a FK constraint if you later reference these by id.
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"[user_admin] lookup_delete {kind} failed: {e}", file=_sys.stderr)
        return jsonify({'status': 'error',
                        'message': 'Could not delete (it may be in use). Try disabling it instead.'}), 400
