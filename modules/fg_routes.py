"""
fg_routes.py — Finished Goods (FG) Registry
============================================
HCP Wellness Pvt Ltd

DB table  : FG_Names
Blueprint : /fg  (registered via register_fg in app.py)

Columns:
  id, fg_name, sku_size, brand_id, formulation_batch,
  pm_links (JSON array of pm_product ids),
  is_active, created_at, updated_at
"""

from flask import Blueprint, request, jsonify, session, render_template
from functools import wraps
from datetime import datetime
import json
import traceback
import sampling_portal   # shared DB helper — provides get_db_connection()

fg_bp = Blueprint('fg', __name__)

# ── Auth helper ──────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
        return f(*args, **kwargs)
    return wrapper

def _user():
    return session.get('User_Name') or session.get('UID') or 'Unknown'


# ── DB bootstrap ─────────────────────────────────────────────────────────────

def ensure_fg_tables():
    """Create FG_Names table and migrate if needed. Call once on app startup."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS FG_Names (
                id                 INT AUTO_INCREMENT PRIMARY KEY,
                fg_code            VARCHAR(30)   DEFAULT NULL,
                fg_name            VARCHAR(500)  NOT NULL,
                sku_size           VARCHAR(100)  DEFAULT NULL,
                uom                VARCHAR(50)   DEFAULT NULL,
                brand_id           INT           DEFAULT NULL,
                formulation_batch  VARCHAR(500)  DEFAULT NULL,
                pm_links           JSON          DEFAULT NULL,
                remarks            TEXT          DEFAULT NULL,
                is_active          TINYINT(1)    DEFAULT 1,
                created_at         DATETIME      DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_fg (fg_name(300), sku_size(80))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # Migrations for existing tables
        for col, ddl in [
            ('fg_code',           "ALTER TABLE FG_Names ADD COLUMN fg_code VARCHAR(30) DEFAULT NULL AFTER id"),
            ('sku_size',          "ALTER TABLE FG_Names ADD COLUMN sku_size VARCHAR(100) DEFAULT NULL AFTER fg_name"),
            ('uom',               "ALTER TABLE FG_Names ADD COLUMN uom VARCHAR(50) DEFAULT NULL AFTER sku_size"),
            ('brand_id',          "ALTER TABLE FG_Names ADD COLUMN brand_id INT DEFAULT NULL AFTER sku_size"),
            ('formulation_batch', "ALTER TABLE FG_Names ADD COLUMN formulation_batch VARCHAR(500) DEFAULT NULL AFTER brand_id"),
            ('pm_links',          "ALTER TABLE FG_Names ADD COLUMN pm_links JSON DEFAULT NULL AFTER formulation_batch"),
            ('remarks',           "ALTER TABLE FG_Names ADD COLUMN remarks TEXT DEFAULT NULL AFTER pm_links"),
            ('is_active',         "ALTER TABLE FG_Names ADD COLUMN is_active TINYINT(1) DEFAULT 1 AFTER pm_links"),
            ('updated_at',        "ALTER TABLE FG_Names ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at"),
        ]:
            try:
                conn.execute(ddl)
                conn.commit()
            except Exception:
                pass

        print("✅ FG_Names table ready")
    except Exception:
        traceback.print_exc()
    finally:
        conn.close()


# ── Helper: resolve pm_product names from ids ────────────────────────────────

def _resolve_pm_names(conn, pm_ids):
    """Return list of {id, product_name, pm_type} for given pm_product ids."""
    if not pm_ids:
        return []
    try:
        placeholders = ','.join(['%s'] * len(pm_ids))
        rows = conn.execute(
            f"SELECT id, product_name, pm_type FROM pm_products WHERE id IN ({placeholders})",
            tuple(pm_ids)
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _row_to_dict(r, conn=None):
    """Convert FG_Names row to API-friendly dict."""
    pm_ids = []
    try:
        raw = r.get('pm_links') or r['pm_links']
        if raw:
            pm_ids = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except Exception:
        pm_ids = []

    pm_details = _resolve_pm_names(conn, pm_ids) if (conn and pm_ids) else []

    return {
        'id':                 int(r['id']),
        'fg_code':            r.get('fg_code') or '',
        'fg_name':            r['fg_name'] or '',
        'sku_size':           r['sku_size'] or '',
        'uom':                r.get('uom') or '',
        'brand_id':           int(r['brand_id']) if r['brand_id'] else None,
        'brand_name':         r.get('brand_name') or '',
        'brand_color':        r.get('brand_color') or '#6366f1',
        'brand_text_color':   r.get('brand_text_color') or '#ffffff',
        'formulation_batch':  r['formulation_batch'] or '',
        'pm_links':           pm_ids,
        'remarks':            r.get('remarks') or '',
        'pm_details':         pm_details,
        'is_active':          int(r['is_active']) if r['is_active'] is not None else 1,
        'created_at':         str(r['created_at'])[:16].replace('T', ' ') if r.get('created_at') else '',
        'updated_at':         str(r.get('updated_at', ''))[:16].replace('T', ' '),
    }


# ── Routes ───────────────────────────────────────────────────────────────────

# PAGE
@fg_bp.route('/fg')
@_login_required
def fg_page():
    return render_template(
        'fg.html',
        user_name=session.get('User_Name'),
        role=session.get('User_Type'),
    )


def register_fg(app):
    """Call once from app.py: fg_routes.register_fg(app)"""
    ensure_fg_tables()
    app.register_blueprint(fg_bp)


# LIST
@fg_bp.route('/api/fg/list')
@_login_required
def api_fg_list():
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500

        rows = conn.execute("""
            SELECT f.*,
                   b.name       AS brand_name,
                   b.color      AS brand_color,
                   COALESCE(b.text_color,'#ffffff') AS brand_text_color
            FROM FG_Names f
            LEFT JOIN procurement_brands b ON b.id = f.brand_id
            ORDER BY f.fg_name ASC
        """).fetchall()

        result = [_row_to_dict(r, conn) for r in rows]
        conn.close()
        return jsonify({'status': 'ok', 'items': result, 'total': len(result)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# CODE GENERATOR
def _generate_fg_code(conn, brand_name, fg_name):
    """Generate unique FG code like TWA-SUN-001"""
    # Brand prefix: first 3 chars of brand name (uppercase), or 'FG' if no brand
    if brand_name:
        b_part = ''.join(c for c in brand_name.upper() if c.isalpha())[:3].ljust(3,'X')
    else:
        b_part = 'FGX'
    # Name prefix: first 3 meaningful chars of FG name (skip brand prefix if repeated)
    words = [w for w in fg_name.upper().split() if len(w) > 1 and w.isalpha()]
    if words:
        # Use first letter of first 3 words, or first 3 chars of first word
        if len(words) >= 2:
            n_part = ''.join(w[0] for w in words[:3]).ljust(3,'X')
        else:
            n_part = words[0][:3].ljust(3,'X')
    else:
        n_part = 'PRD'
    prefix = f"{b_part}-{n_part}-"
    # Find next sequence number for this prefix
    try:
        row = conn.execute(
            "SELECT fg_code FROM FG_Names WHERE fg_code LIKE %s ORDER BY fg_code DESC LIMIT 1",
            (f"{prefix}%%",)
        ).fetchone()
        if row and row['fg_code']:
            last_num = int(row['fg_code'].split('-')[-1])
            next_num = last_num + 1
        else:
            next_num = 1
        return f"{prefix}{str(next_num).zfill(3)}"
    except Exception:
        return f"{prefix}001"

# CREATE
@fg_bp.route('/api/fg/create', methods=['POST'])
@_login_required
def api_fg_create():
    d         = request.get_json() or {}
    fg_name   = (d.get('fg_name') or '').strip()
    sku_size  = (d.get('sku_size') or '').strip() or None
    brand_id  = d.get('brand_id') or None
    formul    = (d.get('formulation_batch') or '').strip() or None
    pm_links  = d.get('pm_links') or []   # list of pm_product ids

    if not fg_name:
        return jsonify({'status': 'error', 'message': 'FG name is required'}), 400

    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500

        # Resolve brand name for code generation
        brand_name = None
        if brand_id:
            br = conn.execute("SELECT name FROM procurement_brands WHERE id=%s", (brand_id,)).fetchone()
            if br: brand_name = br['name']
        fg_code = _generate_fg_code(conn, brand_name, fg_name)
        conn.execute("""
            INSERT INTO FG_Names (fg_code, fg_name, sku_size, uom, brand_id, formulation_batch, pm_links, remarks, is_active)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1)
        """, (fg_code, fg_name, sku_size, (d.get('uom') or '').strip() or None, brand_id or None, formul, json.dumps(pm_links) if pm_links else None, d.get('remarks') or None))
        conn.commit()
        new_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()['id']

        row = conn.execute("""
            SELECT f.*, b.name AS brand_name, b.color AS brand_color, COALESCE(b.text_color,'#ffffff') AS brand_text_color
            FROM FG_Names f LEFT JOIN procurement_brands b ON b.id=f.brand_id WHERE f.id=%s
        """, (new_id,)).fetchone()
        conn.close()
        return jsonify({'status': 'ok', 'item': _row_to_dict(row)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# UPDATE
@fg_bp.route('/api/fg/update/<int:fg_id>', methods=['PUT'])
@_login_required
def api_fg_update(fg_id):
    d        = request.get_json() or {}
    fg_name  = (d.get('fg_name') or '').strip()
    sku_size = (d.get('sku_size') or '').strip() or None
    brand_id = d.get('brand_id') or None
    formul   = (d.get('formulation_batch') or '').strip() or None
    pm_links = d.get('pm_links') or []
    is_active = int(d.get('is_active', 1))

    if not fg_name:
        return jsonify({'status': 'error', 'message': 'FG name is required'}), 400

    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500

        conn.execute("""
            UPDATE FG_Names
            SET fg_name=%s, sku_size=%s, uom=%s, brand_id=%s, formulation_batch=%s,
                pm_links=%s, remarks=%s, is_active=%s
            WHERE id=%s
        """, (fg_name, sku_size, (d.get('uom') or '').strip() or None, brand_id or None, formul,
              json.dumps(pm_links) if pm_links else None,
              d.get('remarks') or None, is_active, fg_id))
        conn.commit()

        row = conn.execute("""
            SELECT f.*, b.name AS brand_name, b.color AS brand_color, COALESCE(b.text_color,'#ffffff') AS brand_text_color
            FROM FG_Names f LEFT JOIN procurement_brands b ON b.id=f.brand_id WHERE f.id=%s
        """, (fg_id,)).fetchone()
        conn.close()
        return jsonify({'status': 'ok', 'item': _row_to_dict(row)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# TOGGLE STATUS (single)
@fg_bp.route('/api/fg/toggle_status', methods=['POST'])
@_login_required
def api_fg_toggle_status():
    d      = request.get_json() or {}
    fg_id  = d.get('id')
    status = int(d.get('is_active', 1))
    if not fg_id:
        return jsonify({'status': 'error', 'message': 'id required'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        conn.execute("UPDATE FG_Names SET is_active=%s WHERE id=%s", (status, fg_id))
        conn.commit(); conn.close()
        return jsonify({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# BULK ASSIGN BRAND
@fg_bp.route('/api/fg/bulk_brand', methods=['POST'])
@_login_required
def api_fg_bulk_brand():
    d        = request.get_json() or {}
    ids      = d.get('ids') or []
    brand_id = d.get('brand_id') or None
    if not ids:
        return jsonify({'status': 'error', 'message': 'No ids provided'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        placeholders = ','.join(['%s'] * len(ids))
        conn.execute(
            f"UPDATE FG_Names SET brand_id=%s WHERE id IN ({placeholders})",
            (brand_id, *ids)
        )
        conn.commit(); conn.close()
        return jsonify({'status': 'ok', 'updated': len(ids)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# BULK TOGGLE STATUS
@fg_bp.route('/api/fg/bulk_status', methods=['POST'])
@_login_required
def api_fg_bulk_status():
    d      = request.get_json() or {}
    ids    = d.get('ids') or []
    status = int(d.get('is_active', 1))
    if not ids:
        return jsonify({'status': 'error', 'message': 'No ids provided'}), 400
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        placeholders = ','.join(['%s'] * len(ids))
        conn.execute(
            f"UPDATE FG_Names SET is_active=%s WHERE id IN ({placeholders})",
            (status, *ids)
        )
        conn.commit(); conn.close()
        return jsonify({'status': 'ok', 'updated': len(ids)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# DELETE
@fg_bp.route('/api/fg/delete/<int:fg_id>', methods=['DELETE'])
@_login_required
def api_fg_delete(fg_id):
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        conn.execute("DELETE FROM FG_Names WHERE id=%s", (fg_id,))
        conn.commit(); conn.close()
        return jsonify({'status': 'ok'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# BRANDS (shared from procurement_brands)
@fg_bp.route('/api/fg/brands')
@_login_required
def api_fg_brands():
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        rows = conn.execute(
            "SELECT id, name, color, COALESCE(text_color, '#ffffff') AS text_color FROM procurement_brands ORDER BY name ASC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'brands': [dict(r) for r in rows]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# PM PRODUCTS (for linking — from pm_products)
@fg_bp.route('/api/fg/pm_products')
@_login_required
def api_fg_pm_products():
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        rows = conn.execute(
            "SELECT id, product_name, pm_type, brand_id FROM pm_products WHERE is_active=1 ORDER BY product_name ASC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'products': [dict(r) for r in rows]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500


# FORMULATION BATCHES (for linking — from procurement_formulations)
@fg_bp.route('/api/fg/formulations')
@_login_required
def api_fg_formulations():
    try:
        conn = sampling_portal.get_db_connection()
        if not conn:
            return jsonify({'status': 'error', 'message': 'DB connection failed'}), 500
        rows = conn.execute(
            "SELECT DISTINCT batch_name, product_code FROM procurement_formulations ORDER BY batch_name ASC"
        ).fetchall()
        conn.close()
        return jsonify({'status': 'ok', 'batches': [dict(r) for r in rows]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 500
