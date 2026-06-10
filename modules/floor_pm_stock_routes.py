"""
Floor PM Stock — dedicated worker-facing page.

A small Flask Blueprint that renders the floor_pm_stock.html template and
exposes one helper endpoint for the page to discover its "home" floor godown
id. All voucher / stock / scan logic reuses the existing pm_stock blueprint
endpoints (transfers/in_transit, voucher/scan_box, save_in, summary, etc.) —
this file deliberately stays thin so we don't fork business logic.
"""

from flask import Blueprint, render_template, jsonify, session, redirect, url_for
from functools import wraps

import sampling_portal


floor_pm_stock_bp = Blueprint('floor_pm_stock', __name__)


# ── Auth helper (mirrors the pattern used in app.py) ────────────────────────

def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return wrapper


# ── Page route ──────────────────────────────────────────────────────────────

@floor_pm_stock_bp.route('/floor_pm_stock')
@_login_required
def floor_pm_stock_page():
    """Render the standalone Floor PM Stock page.

    Access is open to any authenticated user — server-side enforcement on
    the underlying PM Stock endpoints (user-home-godown lock) decides who can
    actually scan IN / save vouchers. This page is read-mostly: any user can
    look at floor stock; only users locked to the FLOOR godown can scan IN.
    """
    return render_template(
        'floor_pm_stock.html',
        role=session.get('User_Type'),
        user_name=session.get('User_Name', session.get('UID', ''))
    )


# ── Resolve the FLOOR godown id ─────────────────────────────────────────────
# The floor page needs to know which procurement_godowns row represents the
# factory floor so it can filter vouchers + summary correctly. We look for a
# row where godown_type='floor' OR is_floor=1, and fall back to a literal name
# match on 'FLOOR' (case-insensitive).

@floor_pm_stock_bp.route('/api/floor_pm_stock/floor_godown')
@_login_required
def api_floor_godown():
    """Return the godown_id that represents the factory floor.

    Response shape: {status, floor_godown_id, floor_godown_name}
    Returns floor_godown_id=null if no such godown is configured.
    """
    conn = sampling_portal.get_db_connection()
    try:
        # Pass 1: explicit floor flag in procurement_godowns
        row = conn.execute(
            """SELECT id, name FROM procurement_godowns
               WHERE LOWER(COALESCE(type,'')) = 'floor'
               ORDER BY id LIMIT 1"""
        ).fetchone()

        # Pass 2: literal name match (handles installs where type column isn't
        # set but the godown is named FLOOR / FACTORY FLOOR / etc.)
        if not row:
            row = conn.execute(
                """SELECT id, name FROM procurement_godowns
                   WHERE UPPER(TRIM(name)) IN ('FLOOR', 'FACTORY FLOOR', 'PRODUCTION FLOOR')
                   ORDER BY id LIMIT 1"""
            ).fetchone()

        # Pass 3: any pm_floor_txn entries point to a godown — use that
        if not row:
            try:
                row = conn.execute(
                    """SELECT g.id, g.name
                       FROM procurement_godowns g
                       JOIN (SELECT DISTINCT godown_id FROM pm_floor_txn LIMIT 1) f ON f.godown_id = g.id
                       LIMIT 1"""
                ).fetchone()
            except Exception:
                row = None

        conn.close()
        if not row:
            return jsonify({
                'status':           'ok',
                'floor_godown_id':   None,
                'floor_godown_name': '',
                'message':           'No floor godown configured. Set type=floor on a procurement_godowns row, or name one FLOOR.'
            })
        return jsonify({
            'status':           'ok',
            'floor_godown_id':   int(row['id']),
            'floor_godown_name': row['name']
        })
    except Exception as e:
        conn.close()
        return jsonify({'status': 'error', 'message': str(e)}), 500
