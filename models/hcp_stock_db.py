"""
HCP Stock — Database layer (MySQL via sampling_portal)
======================================================
Restructured around three masters:

    procurement_brands          (existing — read-only here)
    hcp_stock_pm                Packing Material master
    hcp_stock_fg                Finished Good (Product) master
    hcp_stock_bom               BOM linking FG → PM with qty_per_unit

Transactions:
    hcp_stock_inward            inward of PM
    hcp_stock_wastage           actual wastage of PM
    hcp_stock_dispatch          dispatch of FG (auto-consumes PM via BOM)
    hcp_stock_dispatch_consume  audit trail: per-dispatch PM consumption snapshot

Stock formulae:
    PM closing  = opening + Σ inward − Σ BOM consumption − Σ wastage
    FG          has no stock balance — only a dispatch register
"""

from datetime import datetime
from decimal import Decimal

import sampling_portal as sp


# ─── connection helper (always release back to the pool) ─────────────────────
def _conn():
    return sp.get_db_connection()


# ═══════════════════════════════════════════════════════════════════════════════
# SCHEMA
# ═══════════════════════════════════════════════════════════════════════════════
def ensure_tables():
    """Create all HCP-Stock tables on first run. Idempotent."""
    conn = _conn()
    if not conn:
        print(f"[{datetime.now()}] HCP-Stock: cannot connect to MySQL")
        return
    try:
        # ── PM master ───────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_pm` (
                id                   INT AUTO_INCREMENT PRIMARY KEY,
                brand_id             INT NOT NULL,
                pm_code              VARCHAR(255),
                pm_name              VARCHAR(300) NOT NULL,
                pm_type              VARCHAR(120),
                sku_size             VARCHAR(60),
                rate                 DECIMAL(15,4) DEFAULT 0,
                opening_stock        DECIMAL(18,2) DEFAULT 0,
                provisional_wastage  DECIMAL(18,2) DEFAULT 0,
                low_stock_threshold  DECIMAL(18,2) DEFAULT 0,
                created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_hcp_pm_brand (brand_id),
                INDEX idx_hcp_pm_code  (pm_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── FG master ───────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_fg` (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                brand_id        INT NOT NULL,
                product_code    VARCHAR(120),
                product_name    VARCHAR(300) NOT NULL,
                category        VARCHAR(120),
                sku_size        VARCHAR(60),
                rate            DECIMAL(15,4) DEFAULT 0,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_hcp_fg_brand (brand_id),
                INDEX idx_hcp_fg_code  (product_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── BOM (FG → list of PMs) ──────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_bom` (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                fg_id           INT NOT NULL,
                pm_id           INT NOT NULL,
                qty_per_unit    DECIMAL(18,4) NOT NULL DEFAULT 1,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_hcp_bom_fg (fg_id),
                INDEX idx_hcp_bom_pm (pm_id),
                CONSTRAINT fk_hcp_bom_fg FOREIGN KEY (fg_id)
                    REFERENCES `hcp_stock_fg`(id) ON DELETE CASCADE,
                CONSTRAINT fk_hcp_bom_pm FOREIGN KEY (pm_id)
                    REFERENCES `hcp_stock_pm`(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_fg_pm (fg_id, pm_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── PM Inward ───────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_inward` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                entry_date  DATE NOT NULL,
                pm_id       INT NOT NULL,
                quantity    DECIMAL(18,2) DEFAULT 0,
                ref_no      VARCHAR(120),
                remarks     TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_hcp_inward_pm (pm_id),
                INDEX idx_hcp_inward_date (entry_date),
                CONSTRAINT fk_hcp_inward_pm FOREIGN KEY (pm_id)
                    REFERENCES `hcp_stock_pm`(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── PM Wastage ──────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_wastage` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                entry_date  DATE NOT NULL,
                pm_id       INT NOT NULL,
                quantity    DECIMAL(18,2) DEFAULT 0,
                reason      VARCHAR(255),
                remarks     TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_hcp_waste_pm (pm_id),
                INDEX idx_hcp_waste_date (entry_date),
                CONSTRAINT fk_hcp_waste_pm FOREIGN KEY (pm_id)
                    REFERENCES `hcp_stock_pm`(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── FG Dispatch ─────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_dispatch` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                entry_date  DATE NOT NULL,
                fg_id       INT NOT NULL,
                quantity    DECIMAL(18,2) DEFAULT 0,
                ref_no      VARCHAR(120),
                remarks     TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_hcp_dispatch_fg (fg_id),
                INDEX idx_hcp_dispatch_date (entry_date),
                CONSTRAINT fk_hcp_dispatch_fg FOREIGN KEY (fg_id)
                    REFERENCES `hcp_stock_fg`(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── PM consumption audit (snapshot of BOM at dispatch time) ────────
        # We snapshot qty_consumed so deleting a BOM later doesn't corrupt history.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_dispatch_consume` (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                dispatch_id     INT NOT NULL,
                pm_id           INT NOT NULL,
                qty_per_unit    DECIMAL(18,4) NOT NULL,
                qty_consumed    DECIMAL(18,2) NOT NULL,
                INDEX idx_hcp_dc_dispatch (dispatch_id),
                INDEX idx_hcp_dc_pm       (pm_id),
                CONSTRAINT fk_hcp_dc_dispatch FOREIGN KEY (dispatch_id)
                    REFERENCES `hcp_stock_dispatch`(id) ON DELETE CASCADE,
                CONSTRAINT fk_hcp_dc_pm FOREIGN KEY (pm_id)
                    REFERENCES `hcp_stock_pm`(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Migration: add low_stock_threshold to hcp_stock_pm if missing ──
        try:
            cols = conn.execute("SHOW COLUMNS FROM `hcp_stock_pm`").fetchall()
            col_names = {dict(c).get('Field') or dict(c).get('field') for c in cols}
            if 'low_stock_threshold' not in col_names:
                conn.execute("""
                    ALTER TABLE `hcp_stock_pm`
                    ADD COLUMN low_stock_threshold DECIMAL(18,2) DEFAULT 0
                """)
                print(f"[{datetime.now()}] HCP-Stock: added low_stock_threshold column")
        except Exception as e:
            print(f"[{datetime.now()}] HCP-Stock: migration check skipped — {e}")

        # ── Migration: add requirement_qty to hcp_stock_fg if missing ──
        try:
            cols = conn.execute("SHOW COLUMNS FROM `hcp_stock_fg`").fetchall()
            col_names = {dict(c).get('Field') or dict(c).get('field') for c in cols}
            if 'requirement_qty' not in col_names:
                conn.execute("""
                    ALTER TABLE `hcp_stock_fg`
                    ADD COLUMN requirement_qty DECIMAL(18,2) DEFAULT 0
                """)
                print(f"[{datetime.now()}] HCP-Stock: added requirement_qty column to hcp_stock_fg")
        except Exception as e:
            print(f"[{datetime.now()}] HCP-Stock: requirement_qty migration skipped — {e}")

        # ── Migration: add deleted_at + deleted_by to all 5 soft-delete tables ──
        for tbl in ('hcp_stock_pm','hcp_stock_fg','hcp_stock_inward',
                    'hcp_stock_dispatch','hcp_stock_wastage'):
            try:
                cols = conn.execute(f"SHOW COLUMNS FROM `{tbl}`").fetchall()
                col_names = {dict(c).get('Field') or dict(c).get('field') for c in cols}
                if 'deleted_at' not in col_names:
                    conn.execute(f"""
                        ALTER TABLE `{tbl}`
                        ADD COLUMN deleted_at DATETIME NULL,
                        ADD COLUMN deleted_by VARCHAR(120) NULL,
                        ADD INDEX idx_{tbl}_deleted (deleted_at)
                    """)
                    print(f"[{datetime.now()}] HCP-Stock: added deleted_at to {tbl}")
            except Exception as e:
                print(f"[{datetime.now()}] HCP-Stock: soft-delete migration on {tbl} skipped — {e}")

        # ── Audit log table ──
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_audit` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                ts          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                user_name   VARCHAR(120),
                user_role   VARCHAR(60),
                action      VARCHAR(32) NOT NULL,
                entity      VARCHAR(32) NOT NULL,
                entity_id   INT,
                summary     VARCHAR(500),
                details     TEXT,
                INDEX idx_hcp_audit_ts     (ts),
                INDEX idx_hcp_audit_entity (entity, entity_id),
                INDEX idx_hcp_audit_action (action)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Per-user permissions table ──
        # Stores which features a named user is granted access to.
        # If a user has NO row here, they fall back to role-based defaults
        # (admin → all; everyone else → all view tabs + basic add buttons).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_permissions` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                user_name   VARCHAR(120) NOT NULL UNIQUE,
                features    TEXT,
                note        VARCHAR(500),
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_hcp_perm_user (user_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Per-date FG requirement entries ──
        # A historical log of "we plan to produce N of FG-X on date Y".
        # Replaces the single-value hcp_stock_fg.requirement_qty column for
        # reporting purposes — that column still exists for the inline FG-grid
        # cell but is treated as a *cache* of the most recent entry here.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS `hcp_stock_fg_requirement` (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                fg_id       INT NOT NULL,
                entry_date  DATE NOT NULL,
                quantity    DECIMAL(18,4) NOT NULL DEFAULT 0,
                note        VARCHAR(500),
                created_by  VARCHAR(120),
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at  DATETIME NULL,
                deleted_by  VARCHAR(120) NULL,
                INDEX idx_hcp_freq_fg (fg_id),
                INDEX idx_hcp_freq_date (entry_date),
                FOREIGN KEY (fg_id) REFERENCES `hcp_stock_fg`(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # ── Migration: preclosure support on hcp_stock_fg_requirement ──
        #  preclosed_at  — when the remaining balance was force-closed (NULL = open)
        #  preclosed_by  — who closed it
        #  preclosed_qty — the balance that was closed out at preclosure time
        #                  (= entered − dispatched-allocated at that moment).
        #  preclose_note — optional reason
        #  Revoking a preclosure simply nulls these four columns again.
        try:
            cols = conn.execute("SHOW COLUMNS FROM `hcp_stock_fg_requirement`").fetchall()
            col_names = {dict(c).get('Field') or dict(c).get('field') for c in cols}
            if 'preclosed_at' not in col_names:
                conn.execute("""
                    ALTER TABLE `hcp_stock_fg_requirement`
                    ADD COLUMN preclosed_at  DATETIME NULL,
                    ADD COLUMN preclosed_by  VARCHAR(120) NULL,
                    ADD COLUMN preclosed_qty DECIMAL(18,4) NULL,
                    ADD COLUMN preclose_note VARCHAR(500) NULL,
                    ADD INDEX idx_hcp_freq_preclosed (preclosed_at)
                """)
                print(f"[{datetime.now()}] HCP-Stock: added preclosure columns to hcp_stock_fg_requirement")
        except Exception as e:
            print(f"[{datetime.now()}] HCP-Stock: preclosure migration skipped — {e}")

        conn.commit()
        print(f"[{datetime.now()}] HCP-Stock: tables ready.")
    except Exception as e:
        print(f"[{datetime.now()}] HCP-Stock init error: {e}")
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# BRANDS — read from the existing procurement_brands table (no writes)
# ═══════════════════════════════════════════════════════════════════════════════
def list_brands():
    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT id, name AS brand_name, color, text_color
            FROM `procurement_brands` ORDER BY name
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        # If procurement_brands isn't there for some reason, return empty
        print(f"[HCP-Stock] list_brands warning: {e}")
        return []
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# AUDIT LOG  +  SOFT-DELETE HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
import json as _json

# Tables that support soft-delete (have deleted_at / deleted_by columns)
SOFT_DELETE_TABLES = {
    'pm':              'hcp_stock_pm',
    'fg':              'hcp_stock_fg',
    'inward':          'hcp_stock_inward',
    'dispatch':        'hcp_stock_dispatch',
    'wastage':         'hcp_stock_wastage',
    'fg_requirement':  'hcp_stock_fg_requirement',
}


def write_audit(*, user_name=None, user_role=None, action,
                entity, entity_id=None, summary='', details=None):
    """Append a row to hcp_stock_audit. Never raises — audit failure must not
    take down the underlying CRUD call."""
    try:
        conn = _conn()
        if not conn:
            return
        try:
            details_json = None
            if details is not None:
                try:
                    # Stringify Decimals etc. cleanly
                    def _default(o):
                        if isinstance(o, Decimal): return float(o)
                        return str(o)
                    details_json = _json.dumps(details, default=_default,
                                               ensure_ascii=False)[:60000]
                except Exception:
                    details_json = str(details)[:60000]
            conn.execute("""
                INSERT INTO `hcp_stock_audit`
                    (user_name, user_role, action, entity, entity_id, summary, details)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (
                (user_name or '')[:120],
                (user_role or '')[:60],
                action,
                entity,
                int(entity_id) if entity_id is not None else None,
                (summary or '')[:500],
                details_json,
            ))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        print(f"[HCP-Stock] audit write failed (non-fatal): {e}")


def list_audit(limit=500, entity=None, action=None,
               user_name=None, q=None):
    sql = "SELECT * FROM `hcp_stock_audit` WHERE 1=1"
    args = []
    if entity:
        sql += " AND entity = %s"; args.append(entity)
    if action:
        sql += " AND action = %s"; args.append(action)
    if user_name:
        sql += " AND user_name LIKE %s"; args.append('%'+user_name+'%')
    if q:
        sql += " AND (summary LIKE %s OR details LIKE %s OR user_name LIKE %s)"
        args += ['%'+q+'%']*3
    sql += " ORDER BY ts DESC, id DESC LIMIT %s"
    args.append(int(limit) if limit else 500)
    conn = _conn()
    if not conn: return []
    try:
        rows = conn.execute(sql, tuple(args)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            if hasattr(d.get('ts'), 'strftime'):
                d['ts'] = d['ts'].strftime('%Y-%m-%d %H:%M:%S')
            out.append(d)
        return out
    finally:
        conn.close()


def soft_delete(entity, row_id, *, user_name=None):
    """Mark a row as deleted (sets deleted_at, deleted_by). Returns True if hidden."""
    tbl = SOFT_DELETE_TABLES.get(entity)
    if not tbl:
        raise ValueError(f'unknown entity: {entity}')
    conn = _conn()
    if not conn:
        return False
    try:
        conn.execute(f"""
            UPDATE `{tbl}`
               SET deleted_at = NOW(),
                   deleted_by = %s
             WHERE id = %s
               AND deleted_at IS NULL
        """, ((user_name or '')[:120], row_id))
        conn.commit()
        return True
    finally:
        conn.close()


def restore_row(entity, row_id):
    """Clear deleted_at on a soft-deleted row (admin only)."""
    tbl = SOFT_DELETE_TABLES.get(entity)
    if not tbl:
        raise ValueError(f'unknown entity: {entity}')
    conn = _conn()
    if not conn:
        return False
    try:
        conn.execute(f"""
            UPDATE `{tbl}` SET deleted_at = NULL, deleted_by = NULL
             WHERE id = %s
        """, (row_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def hard_delete(entity, row_id):
    """Permanently delete a row (admin only). Cascades via FK as before."""
    tbl = SOFT_DELETE_TABLES.get(entity)
    if not tbl:
        raise ValueError(f'unknown entity: {entity}')
    conn = _conn()
    if not conn:
        return False
    try:
        conn.execute(f"DELETE FROM `{tbl}` WHERE id = %s", (row_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def list_recycle_bin():
    """Return all soft-deleted rows, grouped by entity, with friendly labels."""
    out = {'pm':[], 'fg':[], 'inward':[], 'dispatch':[], 'wastage':[]}
    conn = _conn()
    if not conn: return out
    try:
        # PM
        rows = conn.execute("""
            SELECT pm.id, pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size,
                   b.name AS brand_name, pm.deleted_at, pm.deleted_by
            FROM `hcp_stock_pm` pm
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE pm.deleted_at IS NOT NULL
            ORDER BY pm.deleted_at DESC
        """).fetchall()
        for r in rows:
            d = dict(r)
            if hasattr(d.get('deleted_at'),'strftime'):
                d['deleted_at']=d['deleted_at'].strftime('%Y-%m-%d %H:%M:%S')
            d['label'] = (d.get('pm_code') and f"{d['pm_code']} · " or '') + (d.get('pm_name') or '')
            out['pm'].append(d)

        # FG
        rows = conn.execute("""
            SELECT fg.id, fg.product_code, fg.product_name, fg.category, fg.sku_size,
                   b.name AS brand_name, fg.deleted_at, fg.deleted_by
            FROM `hcp_stock_fg` fg
            LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
            WHERE fg.deleted_at IS NOT NULL
            ORDER BY fg.deleted_at DESC
        """).fetchall()
        for r in rows:
            d = dict(r)
            if hasattr(d.get('deleted_at'),'strftime'):
                d['deleted_at']=d['deleted_at'].strftime('%Y-%m-%d %H:%M:%S')
            d['label'] = (d.get('product_code') and f"{d['product_code']} · " or '') + (d.get('product_name') or '')
            out['fg'].append(d)

        # Inward (joined to PM, even soft-deleted PMs, to show context)
        rows = conn.execute("""
            SELECT t.id, t.entry_date, t.quantity, t.ref_no,
                   pm.pm_code, pm.pm_name, b.name AS brand_name,
                   t.deleted_at, t.deleted_by
            FROM `hcp_stock_inward` t
            LEFT JOIN `hcp_stock_pm` pm ON pm.id = t.pm_id
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE t.deleted_at IS NOT NULL
            ORDER BY t.deleted_at DESC
        """).fetchall()
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'),'strftime'):
                d['entry_date']=d['entry_date'].strftime('%Y-%m-%d')
            if hasattr(d.get('deleted_at'),'strftime'):
                d['deleted_at']=d['deleted_at'].strftime('%Y-%m-%d %H:%M:%S')
            d['label'] = f"{d.get('entry_date','')} · {d.get('pm_name','')} → {d.get('quantity',0)}"
            out['inward'].append(d)

        # Dispatch
        rows = conn.execute("""
            SELECT t.id, t.entry_date, t.quantity, t.ref_no,
                   fg.product_code, fg.product_name, b.name AS brand_name,
                   t.deleted_at, t.deleted_by
            FROM `hcp_stock_dispatch` t
            LEFT JOIN `hcp_stock_fg` fg ON fg.id = t.fg_id
            LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
            WHERE t.deleted_at IS NOT NULL
            ORDER BY t.deleted_at DESC
        """).fetchall()
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'),'strftime'):
                d['entry_date']=d['entry_date'].strftime('%Y-%m-%d')
            if hasattr(d.get('deleted_at'),'strftime'):
                d['deleted_at']=d['deleted_at'].strftime('%Y-%m-%d %H:%M:%S')
            d['label'] = f"{d.get('entry_date','')} · {d.get('product_name','')} → {d.get('quantity',0)}"
            out['dispatch'].append(d)

        # Wastage
        rows = conn.execute("""
            SELECT t.id, t.entry_date, t.quantity, t.reason,
                   pm.pm_code, pm.pm_name, b.name AS brand_name,
                   t.deleted_at, t.deleted_by
            FROM `hcp_stock_wastage` t
            LEFT JOIN `hcp_stock_pm` pm ON pm.id = t.pm_id
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE t.deleted_at IS NOT NULL
            ORDER BY t.deleted_at DESC
        """).fetchall()
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'),'strftime'):
                d['entry_date']=d['entry_date'].strftime('%Y-%m-%d')
            if hasattr(d.get('deleted_at'),'strftime'):
                d['deleted_at']=d['deleted_at'].strftime('%Y-%m-%d %H:%M:%S')
            d['label'] = f"{d.get('entry_date','')} · {d.get('pm_name','')} → {d.get('quantity',0)}"
            out['wastage'].append(d)

        return out
    finally:
        conn.close()


# Re-export for convenience
__all__ = ['SOFT_DELETE_TABLES','write_audit','list_audit',
           'soft_delete','restore_row','hard_delete','list_recycle_bin',
           'CLEARABLE_TABLES','count_table_rows','table_dependents',
           'clear_table']


# ═══════════════════════════════════════════════════════════════════════════════
# CLEAR / REFRESH TABLES (admin only — hard delete)
# ─────────────────────────────────────────────────────────────────────────────
#  All HCP Stock tables surfaced for clearing. Each entry:
#    label  — friendly name shown in UI
#    table  — actual MySQL table
#    deps   — list of {table, label, fk} child tables that hold FK-references.
#             When a parent is cleared with cascade=True, every dep is cleared
#             AS WELL, in dependency order (deepest first).
#  This is INTENTIONALLY a hard-DELETE (no soft-delete) — clearing bypasses the
#  Recycle Bin entirely. There is no undo. Admin-only and protected by a
#  type-to-confirm string.
# ═══════════════════════════════════════════════════════════════════════════════
CLEARABLE_TABLES = {
    'pm': {
        'label': 'Packing Materials (PM)',
        'table': 'hcp_stock_pm',
        'icon':  '📦',
        # deps:  what gets orphaned/wiped if PM is cleared
        'deps': [
            {'key':'inward',           'label':'Inward (PM transactions)',
             'table':'hcp_stock_inward',           'fk':'pm_id'},
            {'key':'wastage',          'label':'Wastage (PM transactions)',
             'table':'hcp_stock_wastage',          'fk':'pm_id'},
            {'key':'dispatch_consume', 'label':'BOM consumption rows',
             'table':'hcp_stock_dispatch_consume', 'fk':'pm_id'},
            {'key':'bom',              'label':'BOM lines',
             'table':'hcp_stock_bom',              'fk':'pm_id'},
        ],
    },
    'fg': {
        'label': 'Finished Goods (FG)',
        'table': 'hcp_stock_fg',
        'icon':  '🏷️',
        'deps': [
            {'key':'dispatch_consume', 'label':'BOM consumption rows',
             'table':'hcp_stock_dispatch_consume', 'fk':None,
             # via dispatch_consume.dispatch_id → dispatch.fg_id (transitive)
             'via': ('hcp_stock_dispatch','id','dispatch_id','fg_id')},
            {'key':'dispatch',         'label':'Dispatch (FG transactions)',
             'table':'hcp_stock_dispatch',         'fk':'fg_id'},
            {'key':'bom',              'label':'BOM lines',
             'table':'hcp_stock_bom',              'fk':'fg_id'},
            {'key':'fg_requirement',   'label':'FG requirement entries',
             'table':'hcp_stock_fg_requirement',   'fk':'fg_id'},
        ],
    },
    'fg_requirement': {
        'label': 'FG Requirement Entries',
        'table': 'hcp_stock_fg_requirement',
        'icon':  '🎯',
        'deps':  [],
    },
    'bom': {
        'label': 'Bill of Materials (BOM)',
        'table': 'hcp_stock_bom',
        'icon':  '📋',
        'deps': [],   # leaf — no children
    },
    'inward': {
        'label': 'Inward Register',
        'table': 'hcp_stock_inward',
        'icon':  '📥',
        'deps': [],
    },
    'dispatch': {
        'label': 'Dispatch Register',
        'table': 'hcp_stock_dispatch',
        'icon':  '📤',
        'deps': [
            {'key':'dispatch_consume', 'label':'BOM consumption rows',
             'table':'hcp_stock_dispatch_consume', 'fk':'dispatch_id'},
        ],
    },
    'dispatch_consume': {
        'label': 'BOM Consumption (audit)',
        'table': 'hcp_stock_dispatch_consume',
        'icon':  '🧮',
        'deps': [],
    },
    'wastage': {
        'label': 'Wastage Register',
        'table': 'hcp_stock_wastage',
        'icon':  '⚠️',
        'deps': [],
    },
    'audit': {
        'label': 'Audit Log',
        'table': 'hcp_stock_audit',
        'icon':  '📜',
        'deps': [],
    },
}


def count_table_rows(table_name):
    """Return the total row count for a single table (no soft-delete filter)."""
    conn = _conn()
    if not conn:
        return 0
    try:
        row = conn.execute(f"SELECT COUNT(*) AS n FROM `{table_name}`").fetchone()
        d = dict(row) if row else {}
        return int(d.get('n') or d.get('N') or d.get('count(*)') or 0)
    except Exception as e:
        print(f"[HCP-Stock] count_table_rows({table_name}) error: {e}")
        return 0
    finally:
        conn.close()


def table_dependents(key):
    """For a given clearable-table key, return [{key,label,table,row_count}, …]
    of every child table that contains rows referencing this table."""
    spec = CLEARABLE_TABLES.get(key)
    if not spec:
        return []
    out = []
    for dep in spec.get('deps', []):
        # For 'via' deps (transitive — like FG→dispatch→dispatch_consume),
        # we still surface the row count since clearing FG with cascade will
        # also wipe these. The cascade SQL below handles it correctly.
        rc = count_table_rows(dep['table'])
        out.append({
            'key':        dep['key'],
            'label':      dep['label'],
            'table':      dep['table'],
            'row_count':  rc,
        })
    return out


def clear_table(key, *, cascade=False):
    """Hard-DELETE every row in the named table. Returns dict of cleared counts.
    If cascade=True and the spec has dependents, those are cleared first
    (deepest dependency first) — all in one MySQL transaction.

    Notes:
      • Hard-delete only. Skips/bypasses the Recycle Bin entirely.
      • FK-cascading is done explicitly here rather than relying on DB cascades,
        so we always know exactly what was wiped and can return per-table counts.
      • Returns {table_key: rows_cleared, ...} on success.
      • Raises ValueError on unknown key, or RuntimeError if cascade is needed
        but not requested (i.e. dependents have rows AND cascade=False).
    """
    spec = CLEARABLE_TABLES.get(key)
    if not spec:
        raise ValueError(f'unknown table key: {key}')

    deps = table_dependents(key)
    populated_deps = [d for d in deps if d['row_count'] > 0]

    if populated_deps and not cascade:
        names = ', '.join(d['label'] for d in populated_deps)
        raise RuntimeError(
            f"Refusing to clear '{spec['label']}' — {len(populated_deps)} "
            f"dependent table(s) have rows: {names}. Use cascade=True to wipe them too."
        )

    conn = _conn()
    if not conn:
        return {}

    cleared = {}
    try:
        cur = conn.cursor()
        # Disable FK checks temporarily so order doesn't trip up MySQL on
        # cyclic references; re-enable in finally.
        cur.execute("SET FOREIGN_KEY_CHECKS=0")

        # Step 1: wipe each dependent table (deepest-first ordering matters
        # only for FK-cascade-on-delete, but we disabled checks, so just go
        # in declared order).
        if cascade:
            for dep in spec.get('deps', []):
                tbl = dep['table']
                rc = count_table_rows(tbl)
                cur.execute(f"DELETE FROM `{tbl}`")
                cleared[dep['key']] = rc

        # Step 2: wipe the parent
        rc_main = count_table_rows(spec['table'])
        cur.execute(f"DELETE FROM `{spec['table']}`")
        cleared[key] = rc_main

        cur.execute("SET FOREIGN_KEY_CHECKS=1")
        conn.commit()
        return cleared
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        try: conn.execute("SET FOREIGN_KEY_CHECKS=1")
        except Exception: pass
        raise
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# PER-USER FEATURE PERMISSIONS  (admin-managed)
# ─────────────────────────────────────────────────────────────────────────────
# Catalog of every feature an admin can grant to / revoke from a user.
# Keyed by short slug; the frontend uses these slugs to gate UI; the route
# layer can also gate API calls by the same slugs (decorator helpers below).
# ═══════════════════════════════════════════════════════════════════════════════
FEATURE_CATALOG = [
    # group label, [ {slug, label} ]
    {'group': 'View tabs', 'items': [
        {'slug': 'view_fg',           'label': 'FG (Products) tab'},
        {'slug': 'view_pm',           'label': 'PM (Packing Material) tab'},
        {'slug': 'view_inward',       'label': 'Inward (PM) tab'},
        {'slug': 'view_dispatch',     'label': 'Dispatch (FG) tab'},
        {'slug': 'view_wastage',      'label': 'Wastage (PM) tab'},
        {'slug': 'view_requirements', 'label': 'Requirements tab'},
    ]},
    {'group': 'Add new', 'items': [
        {'slug': 'add_pm',        'label': 'Create PM'},
        {'slug': 'add_fg',        'label': 'Create FG'},
        {'slug': 'add_inward',    'label': 'Add Inward (PM)'},
        {'slug': 'add_dispatch',  'label': 'Add Dispatch (multi or single)'},
        {'slug': 'add_wastage',   'label': 'Add Wastage'},
    ]},
    {'group': 'Edit', 'items': [
        {'slug': 'edit_pm',       'label': 'Edit PM'},
        {'slug': 'edit_fg',       'label': 'Edit FG (incl. BOM)'},
        {'slug': 'edit_inward',   'label': 'Edit Inward'},
        {'slug': 'edit_dispatch', 'label': 'Edit Dispatch'},
        {'slug': 'edit_wastage',  'label': 'Edit Wastage'},
    ]},
    {'group': 'Delete', 'items': [
        {'slug': 'delete_pm',          'label': 'Delete PM'},
        {'slug': 'delete_fg',          'label': 'Delete FG'},
        {'slug': 'delete_inward',      'label': 'Delete Inward'},
        {'slug': 'delete_dispatch',    'label': 'Delete Dispatch'},
        {'slug': 'delete_wastage',     'label': 'Delete Wastage'},
        {'slug': 'delete_requirement', 'label': 'Delete Requirement entry'},
    ]},
    {'group': 'Requirements', 'items': [
        {'slug': 'set_requirement',     'label': 'Add / set FG requirement'},
        {'slug': 'preclose_requirement','label': 'Preclose a requirement'},
        {'slug': 'revoke_preclosure',   'label': 'Revoke a preclosure'},
    ]},
    {'group': 'Reports', 'items': [
        {'slug': 'report_req_dispatch', 'label': 'Requirement vs Dispatch report'},
        {'slug': 'report_req_history',  'label': 'Requirement History report'},
        {'slug': 'report_pm_shortage',  'label': 'PM Shortage & Reorder report'},
        {'slug': 'report_buildability', 'label': 'FG Buildability report'},
        {'slug': 'report_pm_ledger',    'label': 'PM Stock Ledger report'},
        {'slug': 'report_dispatch_summary', 'label': 'Dispatch Summary report'},
    ]},
    {'group': 'Data ops', 'items': [
        {'slug': 'data_import',   'label': 'Import Excel'},
        {'slug': 'data_export',   'label': 'Export Excel'},
        {'slug': 'data_template', 'label': 'Download template'},
        {'slug': 'data_check_pm', 'label': 'Check PM (multi-FG availability)'},
    ]},
]
# Flat list of all known slugs for quick validation
ALL_FEATURE_SLUGS = {it['slug'] for grp in FEATURE_CATALOG for it in grp['items']}

# Default permissions when a user has NO row in hcp_stock_permissions:
# • admin → everything (gated separately at the role level)
# • everyone else → read-only (all view tabs only)
DEFAULT_NON_ADMIN_FEATURES = {
    'view_fg','view_pm','view_inward','view_dispatch','view_wastage',
    'view_requirements',
}

# Back-compat: edit/delete used to be bundled into the add_* grant. For users
# whose saved permission predates the edit/delete split, granting add_X implies
# edit_X so their existing access is preserved until an admin re-saves them.
_LEGACY_ADD_IMPLIES = {
    'add_pm':       ['edit_pm'],
    'add_fg':       ['edit_fg'],
    'add_inward':   ['edit_inward'],
    'add_dispatch': ['edit_dispatch'],
    'add_wastage':  ['edit_wastage'],
}


def _expand_legacy(feature_set):
    """Apply the legacy add→edit implication to a resolved feature set."""
    out = set(feature_set)
    for add_slug, implied in _LEGACY_ADD_IMPLIES.items():
        if add_slug in out:
            out.update(implied)
    return out


def _parse_features(raw):
    """features column stores comma-separated slugs."""
    if not raw: return set()
    return {s.strip() for s in str(raw).split(',') if s.strip()}


def get_user_features(user_name, *, role=None):
    """Resolve the effective feature set for a user.

    Resolution order:
      1. If their role is 'admin' → ALL slugs (admin bypass).
      2. If a row exists in hcp_stock_permissions for this user → use it.
      3. Else → DEFAULT_NON_ADMIN_FEATURES (view-only).
    """
    if role and role.strip().lower() == 'admin':
        return set(ALL_FEATURE_SLUGS)
    if not user_name:
        return set(DEFAULT_NON_ADMIN_FEATURES)

    conn = _conn()
    if not conn:
        return set(DEFAULT_NON_ADMIN_FEATURES)
    try:
        row = conn.execute(
            "SELECT features FROM `hcp_stock_permissions` WHERE user_name = %s",
            (user_name,)
        ).fetchone()
        if row:
            return _expand_legacy(_parse_features(dict(row).get('features')))
        return set(DEFAULT_NON_ADMIN_FEATURES)
    except Exception as e:
        print(f"[HCP-Stock] get_user_features failed: {e}")
        return set(DEFAULT_NON_ADMIN_FEATURES)
    finally:
        conn.close()


def list_permissions():
    """Admin: list every named user with their grants."""
    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT id, user_name, features, note, created_at, updated_at
            FROM `hcp_stock_permissions`
            ORDER BY user_name
        """).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d['features'] = sorted(_parse_features(d.get('features')))
            for k in ('created_at','updated_at'):
                if hasattr(d.get(k),'strftime'):
                    d[k] = d[k].strftime('%Y-%m-%d %H:%M:%S')
            out.append(d)
        return out
    finally:
        conn.close()


def upsert_permission(user_name, features, *, note=None):
    """Insert-or-update one user's grants."""
    user_name = (user_name or '').strip()
    if not user_name:
        raise ValueError('user_name is required')
    if not isinstance(features, (list, tuple, set)):
        raise ValueError('features must be a list of slugs')
    feature_set = {f for f in features if f in ALL_FEATURE_SLUGS}
    feature_csv = ','.join(sorted(feature_set))

    conn = _conn()
    if not conn:
        return None
    try:
        existing = conn.execute(
            "SELECT id FROM `hcp_stock_permissions` WHERE user_name = %s",
            (user_name,)
        ).fetchone()
        if existing:
            conn.execute("""
                UPDATE `hcp_stock_permissions`
                   SET features = %s, note = %s
                 WHERE user_name = %s
            """, (feature_csv, (note or '')[:500], user_name))
        else:
            conn.execute("""
                INSERT INTO `hcp_stock_permissions` (user_name, features, note)
                VALUES (%s, %s, %s)
            """, (user_name, feature_csv, (note or '')[:500]))
        conn.commit()
        return sorted(feature_set)
    finally:
        conn.close()


def delete_permission(user_name):
    """Admin: revoke all custom grants for a user (they fall back to defaults)."""
    conn = _conn()
    if not conn:
        return False
    try:
        conn.execute(
            "DELETE FROM `hcp_stock_permissions` WHERE user_name = %s",
            (user_name,)
        )
        conn.commit()
        return True
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# Date-aware PM closing stock + FG availability
# ─────────────────────────────────────────────────────────────────────────────
# Used by the hover side panel when user picks a date range or "as of" date.
# All transaction tables (inward, wastage, dispatch_consume via dispatch) are
# filtered by entry_date BETWEEN [start, end].  Note: opening_stock is treated
# as belonging to a date BEFORE any transaction window, so it always counts.
# ═══════════════════════════════════════════════════════════════════════════════
def _pm_closing_in_range(conn, pm_id, *, start_date=None, end_date=None):
    """Same math as _pm_closing but with optional date-range constraints on
    all child transactions. start/end are 'YYYY-MM-DD' strings or None."""
    where_in = "pm_id = %s AND deleted_at IS NULL"
    where_w  = "pm_id = %s AND deleted_at IS NULL"
    where_dc = "dc.pm_id = %s AND d.deleted_at IS NULL"
    args_in, args_w, args_dc = [pm_id], [pm_id], [pm_id]
    if start_date:
        where_in += " AND entry_date >= %s"; args_in.append(start_date)
        where_w  += " AND entry_date >= %s"; args_w.append(start_date)
        where_dc += " AND d.entry_date >= %s"; args_dc.append(start_date)
    if end_date:
        where_in += " AND entry_date <= %s"; args_in.append(end_date)
        where_w  += " AND entry_date <= %s"; args_w.append(end_date)
        where_dc += " AND d.entry_date <= %s"; args_dc.append(end_date)

    row = conn.execute("SELECT opening_stock FROM `hcp_stock_pm` WHERE id=%s",
                       (pm_id,)).fetchone()
    if not row:
        return {'opening_stock':0,'inward_qty':0,'bom_consumed_qty':0,
                'actual_wastage':0,'closing_stock':0}
    opening = _f(dict(row)['opening_stock'])

    in_q = _f(dict(conn.execute(
        f"SELECT COALESCE(SUM(quantity),0) AS s FROM `hcp_stock_inward` WHERE {where_in}",
        tuple(args_in)).fetchone())['s'])
    w_q = _f(dict(conn.execute(
        f"SELECT COALESCE(SUM(quantity),0) AS s FROM `hcp_stock_wastage` WHERE {where_w}",
        tuple(args_w)).fetchone())['s'])
    dc_q = _f(dict(conn.execute(
        f"""SELECT COALESCE(SUM(dc.qty_consumed),0) AS s
            FROM `hcp_stock_dispatch_consume` dc
            JOIN `hcp_stock_dispatch` d ON d.id = dc.dispatch_id
            WHERE {where_dc}""",
        tuple(args_dc)).fetchone())['s'])

    closing = opening + in_q - dc_q - w_q
    return {
        'opening_stock':    opening,
        'inward_qty':       in_q,
        'bom_consumed_qty': dc_q,
        'actual_wastage':   w_q,
        'closing_stock':    closing,
    }


def pm_stats(pm_id, *, start_date=None, end_date=None):
    """Public wrapper used by the hover panel."""
    conn = _conn()
    if not conn: return None
    try:
        return _pm_closing_in_range(conn, pm_id,
                                    start_date=start_date, end_date=end_date)
    finally:
        conn.close()


def fg_bom_with_availability(fg_id, requirement_qty=None,
                             start_date=None, end_date=None,
                             basis='entered'):
    """PM-vs-requirement availability for one FG's BOM.

    basis:
      • 'entered' (default) → 'required' is computed against the FG's full
        entered requirement (cached requirement_qty, or the explicit
        requirement_qty argument). This is the "Current" PM report.
      • 'pending'           → 'required' is computed against the FG's PENDING
        requirement (entered − dispatched − preclosed, FIFO-allocated). This is
        the "Against Existing Pending" PM report. The explicit requirement_qty
        argument is ignored in this mode.

    PM closing stock remains date-aware via _pm_closing_in_range.
    """
    conn = _conn()
    if not conn:
        return []
    try:
        if basis == 'pending':
            # pending (Option B) = (non-preclosed requirement entries)
            #   − (all dispatches − dispatches that went to preclosed entries).
            # A preclosed entry's settled-dispatch share = (entered − preclosed_qty).
            req_sum = _f(dict(conn.execute("""
                SELECT COALESCE(SUM(quantity),0) AS s
                FROM `hcp_stock_fg_requirement`
                WHERE fg_id=%s AND deleted_at IS NULL AND preclosed_at IS NULL
            """, (fg_id,)).fetchone())['s'])
            preclosed_disp = _f(dict(conn.execute("""
                SELECT COALESCE(SUM(GREATEST(quantity - COALESCE(preclosed_qty,0), 0)),0) AS s
                FROM `hcp_stock_fg_requirement`
                WHERE fg_id=%s AND deleted_at IS NULL AND preclosed_at IS NOT NULL
            """, (fg_id,)).fetchone())['s'])
            d_where = "fg_id=%s AND deleted_at IS NULL"
            d_args  = [fg_id]
            if end_date:
                d_where += " AND entry_date <= %s"; d_args.append(end_date)
            disp_sum = _f(dict(conn.execute(
                f"SELECT COALESCE(SUM(quantity),0) AS s FROM `hcp_stock_dispatch` WHERE {d_where}",
                tuple(d_args)).fetchone())['s'])
            disp_against_open = max(0.0, disp_sum - preclosed_disp)
            requirement_qty = round(max(0.0, req_sum - disp_against_open), 4)
        elif requirement_qty is None:
            r = conn.execute("SELECT requirement_qty FROM `hcp_stock_fg` WHERE id = %s",
                             (fg_id,)).fetchone()
            requirement_qty = _f(dict(r).get('requirement_qty')) if r else 0.0
        else:
            requirement_qty = _f(requirement_qty)

        rows = conn.execute("""
            SELECT bom.pm_id, bom.qty_per_unit,
                   pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size
            FROM `hcp_stock_bom` bom
            JOIN `hcp_stock_pm`  pm ON pm.id = bom.pm_id
            WHERE bom.fg_id = %s AND pm.deleted_at IS NULL
            ORDER BY pm.pm_name
        """, (fg_id,)).fetchall()

        lines = []
        for r in rows:
            d = dict(r)
            qpu = _f(d['qty_per_unit'])
            stats = _pm_closing_in_range(conn, d['pm_id'],
                                         start_date=start_date, end_date=end_date)
            stock = stats['closing_stock']
            required = qpu * requirement_qty if requirement_qty > 0 else 0.0
            short = max(0.0, required - stock)
            possible = (int(stock // qpu) if qpu > 0 else 0)
            lines.append({
                'pm_id':         d['pm_id'],
                'pm_code':       d.get('pm_code') or '',
                'pm_name':       d.get('pm_name') or '',
                'pm_type':       d.get('pm_type') or '',
                'sku_size':      d.get('sku_size') or '',
                'qty_per_unit':  qpu,
                'pm_stock':      stock,
                'required_qty':  required,
                'short_qty':     short,
                'possible_units': possible,
                'basis':         basis,
                'basis_requirement_qty': requirement_qty,
            })
        return lines
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# helpers
# ═══════════════════════════════════════════════════════════════════════════════
def _f(v):
    if v is None or v == '':
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _floatify(d, *keys):
    for k in keys:
        if d.get(k) is not None and isinstance(d[k], Decimal):
            d[k] = float(d[k])
    return d


# ═══════════════════════════════════════════════════════════════════════════════
# PM master
# ═══════════════════════════════════════════════════════════════════════════════
def get_pm_rows(brand_id=None):
    """One row per PM with calculated inward / dispatch-consumption / wastage / closing.
       Excludes soft-deleted PMs *and* soft-deleted transactions from the math."""
    sql = """
        SELECT  pm.id, pm.brand_id, b.name AS brand_name,
                b.color AS brand_color, b.text_color AS brand_text_color,
                pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size,
                pm.rate, pm.opening_stock, pm.provisional_wastage,
                pm.low_stock_threshold,
                COALESCE((SELECT SUM(quantity) FROM `hcp_stock_inward`
                          WHERE pm_id = pm.id AND deleted_at IS NULL), 0) AS inward_qty,
                COALESCE((SELECT SUM(dc.qty_consumed)
                          FROM `hcp_stock_dispatch_consume` dc
                          JOIN `hcp_stock_dispatch` d ON d.id = dc.dispatch_id
                          WHERE dc.pm_id = pm.id AND d.deleted_at IS NULL), 0) AS bom_consumed_qty,
                COALESCE((SELECT SUM(quantity) FROM `hcp_stock_wastage`
                          WHERE pm_id = pm.id AND deleted_at IS NULL), 0) AS actual_wastage
        FROM    `hcp_stock_pm` pm
        LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
        WHERE   pm.deleted_at IS NULL
    """
    args = ()
    if brand_id:
        sql += " AND pm.brand_id = %s "
        args = (brand_id,)
    sql += " ORDER BY pm.pm_name "

    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute(sql, args).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'rate', 'opening_stock', 'provisional_wastage',
                      'low_stock_threshold',
                      'inward_qty', 'bom_consumed_qty', 'actual_wastage')
            d['closing_stock'] = (
                _f(d['opening_stock']) + _f(d['inward_qty'])
                - _f(d['bom_consumed_qty']) - _f(d['actual_wastage'])
            )
            d['is_low_stock'] = (
                _f(d['low_stock_threshold']) > 0
                and d['closing_stock'] < _f(d['low_stock_threshold'])
            )
            out.append(d)
        return out
    finally:
        conn.close()


def get_pm(pm_id):
    conn = _conn()
    if not conn:
        return None
    try:
        row = conn.execute("""
            SELECT pm.*, b.name AS brand_name
            FROM `hcp_stock_pm` pm
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE pm.id = %s
        """, (pm_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def upsert_pm(data, pm_id=None):
    fields = ('brand_id', 'pm_code', 'pm_name', 'pm_type',
              'sku_size', 'rate', 'opening_stock', 'provisional_wastage',
              'low_stock_threshold')
    vals = [data.get(f) for f in fields]

    conn = _conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        if pm_id:
            cur.execute("""
                UPDATE `hcp_stock_pm` SET
                    brand_id=%s, pm_code=%s, pm_name=%s, pm_type=%s,
                    sku_size=%s, rate=%s, opening_stock=%s, provisional_wastage=%s,
                    low_stock_threshold=%s
                WHERE id=%s
            """, (*vals, pm_id))
            new_id = pm_id
        else:
            cur.execute("""
                INSERT INTO `hcp_stock_pm`
                    (brand_id, pm_code, pm_name, pm_type,
                     sku_size, rate, opening_stock, provisional_wastage,
                     low_stock_threshold)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, vals)
            new_id = cur.lastrowid
        conn.commit()
        return new_id
    finally:
        conn.close()


def find_pm_by_code_or_name(brand_id, code, name):
    """Return the existing (non-deleted) PM row matching code first, then name,
    scoped to the given brand. Returns a dict or None.

    Used by the importer to detect duplicates so a re-upload can ADD quantity to
    the existing PM's stock instead of creating a second row."""
    code = (str(code).strip() if code else '')
    name = (str(name).strip() if name else '')
    conn = _conn()
    if not conn:
        return None
    try:
        if code:
            row = conn.execute("""
                SELECT * FROM `hcp_stock_pm`
                WHERE brand_id=%s AND deleted_at IS NULL
                  AND LOWER(TRIM(pm_code)) = LOWER(%s)
                LIMIT 1
            """, (brand_id, code)).fetchone()
            if row:
                return dict(row)
        if name:
            row = conn.execute("""
                SELECT * FROM `hcp_stock_pm`
                WHERE brand_id=%s AND deleted_at IS NULL
                  AND LOWER(TRIM(pm_name)) = LOWER(%s)
                LIMIT 1
            """, (brand_id, name)).fetchone()
            if row:
                return dict(row)
        return None
    finally:
        conn.close()


def add_pm_stock(pm_id, qty):
    """Increment an existing PM's opening_stock by `qty` (the duplicate-merge
    path of import). Returns (before, after) opening_stock values."""
    qty = _f(qty)
    conn = _conn()
    if not conn:
        return (None, None)
    try:
        before_row = conn.execute(
            "SELECT opening_stock FROM `hcp_stock_pm` WHERE id=%s", (pm_id,)
        ).fetchone()
        before = _f(dict(before_row).get('opening_stock')) if before_row else 0.0
        after = before + qty
        conn.execute(
            "UPDATE `hcp_stock_pm` SET opening_stock=%s WHERE id=%s",
            (after, pm_id)
        )
        conn.commit()
        return (before, after)
    finally:
        conn.close()


def delete_pm(pm_id, *, user_name=None):
    """Soft-delete: row is hidden but remains in DB for restore from Recycle Bin."""
    return soft_delete('pm', pm_id, user_name=user_name)


# ═══════════════════════════════════════════════════════════════════════════════
# FG master + BOM
# ═══════════════════════════════════════════════════════════════════════════════
def get_fg_rows(brand_id=None):
    """One row per FG with total dispatched + BOM line count.
       Excludes soft-deleted FGs and soft-deleted dispatches from totals."""
    sql = """
        SELECT  fg.id, fg.brand_id, b.name AS brand_name,
                b.color AS brand_color, b.text_color AS brand_text_color,
                fg.product_code, fg.product_name, fg.category, fg.sku_size, fg.rate,
                COALESCE(fg.requirement_qty, 0) AS requirement_qty,
                COALESCE((SELECT SUM(quantity) FROM `hcp_stock_dispatch`
                          WHERE fg_id = fg.id AND deleted_at IS NULL), 0) AS dispatch_qty,
                COALESCE((SELECT SUM(quantity) FROM `hcp_stock_fg_requirement`
                          WHERE fg_id = fg.id AND deleted_at IS NULL
                            AND preclosed_at IS NULL), 0) AS req_open_qty,
                COALESCE((SELECT SUM(GREATEST(quantity - COALESCE(preclosed_qty,0), 0))
                          FROM `hcp_stock_fg_requirement`
                          WHERE fg_id = fg.id AND deleted_at IS NULL
                            AND preclosed_at IS NOT NULL), 0) AS preclosed_dispatched_qty,
                COALESCE((SELECT COUNT(*) FROM `hcp_stock_bom`
                          WHERE fg_id = fg.id), 0) AS bom_lines
        FROM    `hcp_stock_fg` fg
        LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
        WHERE   fg.deleted_at IS NULL
    """
    args = ()
    if brand_id:
        sql += " AND fg.brand_id = %s "
        args = (brand_id,)
    sql += " ORDER BY fg.product_name "

    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute(sql, args).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'rate', 'dispatch_qty', 'requirement_qty',
                      'req_open_qty', 'preclosed_dispatched_qty')
            # Pending (Option B):
            #   pending = (non-preclosed requirement entries)
            #             − (all dispatches − dispatches that went to preclosed entries)
            # A preclosed entry's dispatched share = (entered − preclosed_qty); those
            # dispatches are considered settled and must NOT reduce open requirements.
            open_req       = _f(d.get('req_open_qty'))
            all_disp       = _f(d.get('dispatch_qty'))
            preclosed_disp = _f(d.get('preclosed_dispatched_qty'))
            disp_against_open = max(0.0, all_disp - preclosed_disp)
            d['pending_qty'] = round(max(0.0, open_req - disp_against_open), 4)
            if d.get('bom_lines') is not None:
                d['bom_lines'] = int(d['bom_lines'])
            out.append(d)
        return out
    finally:
        conn.close()


def get_fg(fg_id):
    conn = _conn()
    if not conn:
        return None
    try:
        row = conn.execute("""
            SELECT fg.*, b.name AS brand_name
            FROM `hcp_stock_fg` fg
            LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
            WHERE fg.id = %s
        """, (fg_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def upsert_fg(data, fg_id=None):
    fields = ('brand_id', 'product_code', 'product_name',
              'category', 'sku_size', 'rate')
    vals = [data.get(f) for f in fields]

    conn = _conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        if fg_id:
            cur.execute("""
                UPDATE `hcp_stock_fg` SET
                    brand_id=%s, product_code=%s, product_name=%s,
                    category=%s, sku_size=%s, rate=%s
                WHERE id=%s
            """, (*vals, fg_id))
            new_id = fg_id
        else:
            cur.execute("""
                INSERT INTO `hcp_stock_fg`
                    (brand_id, product_code, product_name,
                     category, sku_size, rate)
                VALUES (%s,%s,%s,%s,%s,%s)
            """, vals)
            new_id = cur.lastrowid
        conn.commit()
        return new_id
    finally:
        conn.close()


def find_fg_by_code_or_name(brand_id, code, name):
    """Return the existing (non-deleted) FG row matching code first, then name,
    scoped to the given brand. Returns a dict or None. Mirror of
    find_pm_by_code_or_name for the importer's duplicate detection."""
    code = (str(code).strip() if code else '')
    name = (str(name).strip() if name else '')
    conn = _conn()
    if not conn:
        return None
    try:
        if code:
            row = conn.execute("""
                SELECT * FROM `hcp_stock_fg`
                WHERE brand_id=%s AND deleted_at IS NULL
                  AND LOWER(TRIM(product_code)) = LOWER(%s)
                LIMIT 1
            """, (brand_id, code)).fetchone()
            if row:
                return dict(row)
        if name:
            row = conn.execute("""
                SELECT * FROM `hcp_stock_fg`
                WHERE brand_id=%s AND deleted_at IS NULL
                  AND LOWER(TRIM(product_name)) = LOWER(%s)
                LIMIT 1
            """, (brand_id, name)).fetchone()
            if row:
                return dict(row)
        return None
    finally:
        conn.close()


def delete_fg(fg_id, *, user_name=None):
    """Soft-delete: row is hidden but remains in DB for restore from Recycle Bin."""
    return soft_delete('fg', fg_id, user_name=user_name)


def set_fg_requirement(fg_id, qty):
    """Update only the requirement_qty for one FG. Returns the (before, after)
    tuple so the route layer can build a clean audit summary."""
    qty = max(0.0, _f(qty))
    conn = _conn()
    if not conn:
        return (None, None)
    try:
        before_row = conn.execute(
            "SELECT requirement_qty FROM `hcp_stock_fg` WHERE id = %s", (fg_id,)
        ).fetchone()
        before = _f(dict(before_row).get('requirement_qty')) if before_row else None
        conn.execute(
            "UPDATE `hcp_stock_fg` SET requirement_qty = %s WHERE id = %s",
            (qty, fg_id)
        )
        conn.commit()
        return (before, qty)
    finally:
        conn.close()


def fg_bom_with_availability_OLD_REMOVED():
    """Replaced by the date-aware version above (kept as stub to avoid breaking
    any direct imports — should never be called)."""
    return []


# ─── BOM ─────────────────────────────────────────────────────────────────────
def get_bom_for_fg(fg_id):
    """All BOM lines for an FG, joined with PM details."""
    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT bom.id, bom.fg_id, bom.pm_id, bom.qty_per_unit,
                   pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size,
                   pm.brand_id AS pm_brand_id,
                   b.name AS pm_brand_name
            FROM `hcp_stock_bom` bom
            JOIN `hcp_stock_pm` pm ON pm.id = bom.pm_id
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE bom.fg_id = %s
            ORDER BY pm.pm_name
        """, (fg_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'qty_per_unit')
            out.append(d)
        return out
    finally:
        conn.close()


def get_fgs_using_pm(pm_id):
    """Reverse BOM lookup: which FG products consume this PM, with qty/unit
    and how many of those FGs have actually been dispatched so far.
    Excludes soft-deleted FGs and soft-deleted dispatches."""
    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT bom.fg_id, bom.qty_per_unit,
                   fg.product_code, fg.product_name, fg.category, fg.sku_size,
                   fg.brand_id AS fg_brand_id,
                   b.name      AS fg_brand_name,
                   COALESCE((SELECT SUM(quantity) FROM `hcp_stock_dispatch`
                             WHERE fg_id = fg.id AND deleted_at IS NULL), 0) AS dispatch_qty
            FROM `hcp_stock_bom` bom
            JOIN `hcp_stock_fg`  fg ON fg.id = bom.fg_id
            LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
            WHERE bom.pm_id = %s
              AND fg.deleted_at IS NULL
            ORDER BY fg.product_name
        """, (pm_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'qty_per_unit', 'dispatch_qty')
            out.append(d)
        return out
    finally:
        conn.close()


def set_bom_for_fg(fg_id, lines):
    """Replace the BOM for an FG. lines = [{'pm_id':..,'qty_per_unit':..}, …]"""
    conn = _conn()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM `hcp_stock_bom` WHERE fg_id=%s", (fg_id,))
        for ln in lines or []:
            pm_id = int(ln.get('pm_id') or 0)
            qty   = _f(ln.get('qty_per_unit', 1)) or 1.0
            if pm_id <= 0:
                continue
            cur.execute("""
                INSERT INTO `hcp_stock_bom` (fg_id, pm_id, qty_per_unit)
                VALUES (%s,%s,%s)
                ON DUPLICATE KEY UPDATE qty_per_unit=VALUES(qty_per_unit)
            """, (fg_id, pm_id, qty))
        conn.commit()
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# PM closing-stock helper (used to validate dispatch)
# ═══════════════════════════════════════════════════════════════════════════════
def _pm_closing(conn, pm_id):
    """Compute current closing of a PM using the SAME open connection (txn-safe).
       Excludes soft-deleted transactions so that restoring/editing math stays correct."""
    row = conn.execute("""
        SELECT pm.opening_stock,
               COALESCE((SELECT SUM(quantity) FROM `hcp_stock_inward`
                         WHERE pm_id = pm.id AND deleted_at IS NULL), 0) AS inward_qty,
               COALESCE((SELECT SUM(dc.qty_consumed)
                         FROM `hcp_stock_dispatch_consume` dc
                         JOIN `hcp_stock_dispatch` d ON d.id = dc.dispatch_id
                         WHERE dc.pm_id = pm.id AND d.deleted_at IS NULL), 0) AS bom_consumed_qty,
               COALESCE((SELECT SUM(quantity) FROM `hcp_stock_wastage`
                         WHERE pm_id = pm.id AND deleted_at IS NULL), 0) AS actual_wastage
        FROM `hcp_stock_pm` pm WHERE pm.id = %s
    """, (pm_id,)).fetchone()
    if not row:
        return 0.0
    d = dict(row)
    return (_f(d['opening_stock']) + _f(d['inward_qty'])
            - _f(d['bom_consumed_qty']) - _f(d['actual_wastage']))


# ═══════════════════════════════════════════════════════════════════════════════
# INWARD (PM) — list / add / update / delete
# ═══════════════════════════════════════════════════════════════════════════════
def list_inward(brand_id=None, pm_id=None):
    sql = """
        SELECT  t.id, t.entry_date, t.quantity, t.ref_no, t.remarks,
                pm.id AS pm_id, pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size,
                pm.brand_id, b.name AS brand_name
        FROM `hcp_stock_inward` t
        JOIN `hcp_stock_pm` pm ON pm.id = t.pm_id
        LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
        WHERE t.deleted_at IS NULL AND pm.deleted_at IS NULL
    """
    args = []
    if brand_id:
        sql += " AND pm.brand_id = %s"; args.append(brand_id)
    if pm_id:
        sql += " AND pm.id = %s"; args.append(pm_id)
    sql += " ORDER BY t.entry_date DESC, t.id DESC"

    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute(sql, tuple(args)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'), 'strftime'):
                d['entry_date'] = d['entry_date'].strftime('%Y-%m-%d')
            out.append(d)
        return out
    finally:
        conn.close()


def add_inward(data):
    conn = _conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO `hcp_stock_inward`
                (entry_date, pm_id, quantity, ref_no, remarks)
            VALUES (%s,%s,%s,%s,%s)
        """, (data.get('entry_date'), data.get('pm_id'),
              _f(data.get('quantity')), data.get('ref_no', ''),
              data.get('remarks', '')))
        new_id = cur.lastrowid
        conn.commit()
        return new_id
    finally:
        conn.close()


def add_inward_batch(items):
    """Insert many inward rows atomically. Validates each line: pm_id must
    exist + not soft-deleted, quantity > 0, entry_date present.

    Rolls back the entire batch if any line fails.

    Returns: list of new inward ids (in input order) on success.
    Raises:  ValueError(message, line_index=N) on bad input.
    """
    if not items:
        raise ValueError('no items')

    conn = _conn()
    if not conn:
        return []
    try:
        ids = []
        cur = conn.cursor()
        for idx, data in enumerate(items, start=1):
            pm_id    = int(data.get('pm_id') or 0)
            quantity = _f(data.get('quantity'))
            entry_dt = (data.get('entry_date') or '').strip()
            if pm_id <= 0:
                e = ValueError(f'Line {idx}: please pick a Packing Material')
                e.line_index = idx; raise e
            if quantity <= 0:
                e = ValueError(f'Line {idx}: quantity must be greater than zero')
                e.line_index = idx; raise e
            if not entry_dt:
                e = ValueError(f'Line {idx}: entry date is required')
                e.line_index = idx; raise e

            # PM must exist and not be soft-deleted
            row = conn.execute(
                "SELECT id FROM `hcp_stock_pm` WHERE id=%s AND deleted_at IS NULL",
                (pm_id,)
            ).fetchone()
            if not row:
                e = ValueError(f'Line {idx}: PM not found or has been deleted')
                e.line_index = idx; raise e

            cur.execute("""
                INSERT INTO `hcp_stock_inward`
                    (entry_date, pm_id, quantity, ref_no, remarks)
                VALUES (%s,%s,%s,%s,%s)
            """, (entry_dt, pm_id, quantity,
                  data.get('ref_no', ''), data.get('remarks', '')))
            ids.append(cur.lastrowid)

        conn.commit()
        return ids
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def update_inward(txn_id, data):
    conn = _conn()
    if not conn:
        return
    try:
        conn.execute("""
            UPDATE `hcp_stock_inward` SET
                entry_date=%s, pm_id=%s, quantity=%s,
                ref_no=%s, remarks=%s
            WHERE id=%s
        """, (data.get('entry_date'), data.get('pm_id'),
              _f(data.get('quantity')), data.get('ref_no', ''),
              data.get('remarks', ''), txn_id))
        conn.commit()
    finally:
        conn.close()


def delete_inward(txn_id, *, user_name=None):
    """Soft-delete inward transaction."""
    return soft_delete('inward', txn_id, user_name=user_name)


# ═══════════════════════════════════════════════════════════════════════════════
# WASTAGE (PM) — list / add / update / delete
# ═══════════════════════════════════════════════════════════════════════════════
def list_wastage(brand_id=None, pm_id=None):
    sql = """
        SELECT  t.id, t.entry_date, t.quantity, t.reason, t.remarks,
                pm.id AS pm_id, pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size,
                pm.brand_id, b.name AS brand_name
        FROM `hcp_stock_wastage` t
        JOIN `hcp_stock_pm` pm ON pm.id = t.pm_id
        LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
        WHERE t.deleted_at IS NULL AND pm.deleted_at IS NULL
    """
    args = []
    if brand_id:
        sql += " AND pm.brand_id = %s"; args.append(brand_id)
    if pm_id:
        sql += " AND pm.id = %s"; args.append(pm_id)
    sql += " ORDER BY t.entry_date DESC, t.id DESC"

    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute(sql, tuple(args)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'), 'strftime'):
                d['entry_date'] = d['entry_date'].strftime('%Y-%m-%d')
            out.append(d)
        return out
    finally:
        conn.close()


def add_wastage(data):
    conn = _conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO `hcp_stock_wastage`
                (entry_date, pm_id, quantity, reason, remarks)
            VALUES (%s,%s,%s,%s,%s)
        """, (data.get('entry_date'), data.get('pm_id'),
              _f(data.get('quantity')), data.get('reason', ''),
              data.get('remarks', '')))
        new_id = cur.lastrowid
        conn.commit()
        return new_id
    finally:
        conn.close()


def add_wastage_batch(items):
    """Insert many wastage rows atomically. Validates each line:
        • pm_id exists + not soft-deleted
        • quantity > 0
        • reason not empty
        • entry_date present
        • cumulative wastage within this batch + existing closing >= 0
          (you can't waste more than you have, even after accounting for
           prior lines in the same batch consuming the same PM)

    Rolls back the entire batch if any line fails.

    Returns: list of new wastage ids (in input order) on success.
    Raises:  StockShortError(shortages, line_index=N) when wastage exceeds
             available closing stock; ValueError(message, line_index=N)
             on bad input.
    """
    if not items:
        raise ValueError('no items')

    conn = _conn()
    if not conn:
        return []
    try:
        # Cumulative tally of wastage per PM within this batch — used to detect
        # batches that would push closing negative even though no single line
        # individually exceeds available stock.
        used_per_pm = {}   # pm_id -> already-allocated qty in this batch
        ids = []
        cur = conn.cursor()
        for idx, data in enumerate(items, start=1):
            pm_id    = int(data.get('pm_id') or 0)
            quantity = _f(data.get('quantity'))
            entry_dt = (data.get('entry_date') or '').strip()
            reason   = (data.get('reason') or '').strip()

            if pm_id <= 0:
                e = ValueError(f'Line {idx}: please pick a Packing Material')
                e.line_index = idx; raise e
            if quantity <= 0:
                e = ValueError(f'Line {idx}: quantity must be greater than zero')
                e.line_index = idx; raise e
            if not entry_dt:
                e = ValueError(f'Line {idx}: entry date is required')
                e.line_index = idx; raise e
            if not reason:
                e = ValueError(f'Line {idx}: reason is required for wastage')
                e.line_index = idx; raise e

            # PM existence
            pm_row = conn.execute(
                "SELECT pm_name FROM `hcp_stock_pm` WHERE id=%s AND deleted_at IS NULL",
                (pm_id,)
            ).fetchone()
            if not pm_row:
                e = ValueError(f'Line {idx}: PM not found or has been deleted')
                e.line_index = idx; raise e
            pm_name = dict(pm_row).get('pm_name','PM')

            # Stock check: closing must remain >= 0 after THIS line's wastage,
            # accounting for prior lines in this batch that touched the same PM.
            current_closing = _pm_closing(conn, pm_id)
            already_used = used_per_pm.get(pm_id, 0.0)
            available = current_closing - already_used
            if quantity > available:
                e = StockShortError([{
                    'pm_id':       pm_id,
                    'pm_name':     pm_name,
                    'available':   available,
                    'requested':   quantity,
                    'shortage':    quantity - available,
                }])
                e.line_index = idx
                raise e

            cur.execute("""
                INSERT INTO `hcp_stock_wastage`
                    (entry_date, pm_id, quantity, reason, remarks)
                VALUES (%s,%s,%s,%s,%s)
            """, (entry_dt, pm_id, quantity, reason,
                  data.get('remarks', '')))
            ids.append(cur.lastrowid)
            used_per_pm[pm_id] = already_used + quantity

        conn.commit()
        return ids
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def update_wastage(txn_id, data):
    conn = _conn()
    if not conn:
        return
    try:
        conn.execute("""
            UPDATE `hcp_stock_wastage` SET
                entry_date=%s, pm_id=%s, quantity=%s,
                reason=%s, remarks=%s
            WHERE id=%s
        """, (data.get('entry_date'), data.get('pm_id'),
              _f(data.get('quantity')), data.get('reason', ''),
              data.get('remarks', ''), txn_id))
        conn.commit()
    finally:
        conn.close()


def delete_wastage(txn_id, *, user_name=None):
    """Soft-delete wastage transaction."""
    return soft_delete('wastage', txn_id, user_name=user_name)


# ═══════════════════════════════════════════════════════════════════════════════
# DISPATCH (FG) — list / add / update / delete  + BOM auto-consume
# ═══════════════════════════════════════════════════════════════════════════════
class StockShortError(Exception):
    """Raised when a dispatch would push a PM negative."""
    def __init__(self, shortages):
        self.shortages = shortages       # list of dicts: pm_name, available, required
        super().__init__('Insufficient PM stock')


def list_dispatch(brand_id=None, fg_id=None):
    sql = """
        SELECT  t.id, t.entry_date, t.quantity, t.ref_no, t.remarks,
                fg.id AS fg_id, fg.product_code, fg.product_name,
                fg.category, fg.sku_size,
                fg.brand_id, b.name AS brand_name
        FROM `hcp_stock_dispatch` t
        JOIN `hcp_stock_fg` fg ON fg.id = t.fg_id
        LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
        WHERE t.deleted_at IS NULL AND fg.deleted_at IS NULL
    """
    args = []
    if brand_id:
        sql += " AND fg.brand_id = %s"; args.append(brand_id)
    if fg_id:
        sql += " AND fg.id = %s"; args.append(fg_id)
    sql += " ORDER BY t.entry_date DESC, t.id DESC"

    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute(sql, tuple(args)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'quantity')
            if hasattr(d.get('entry_date'), 'strftime'):
                d['entry_date'] = d['entry_date'].strftime('%Y-%m-%d')
            out.append(d)
        return out
    finally:
        conn.close()


def _validate_and_get_bom(conn, fg_id, dispatch_qty,
                          ignore_dispatch_id=None, rejection_pct=0.0):
    """
    Returns (bom_rows_list, []) on success, or raises StockShortError.
    `ignore_dispatch_id` excludes a specific dispatch's existing consumption
    when computing availability — used for UPDATE so re-using same PMs works.

    `rejection_pct` (e.g. 2.0 for 2%) adds an extra auto-wastage demand on top
    of normal BOM consumption when checking availability, so closing never goes
    negative once the rejection wastage is also written. Each plan line carries
    a `rejection_qty` = qty_consumed * rejection_pct / 100.
    """
    rej_factor = max(0.0, _f(rejection_pct)) / 100.0

    # 1. Load the BOM for this FG
    bom = conn.execute("""
        SELECT bom.pm_id, bom.qty_per_unit, pm.pm_name
        FROM `hcp_stock_bom` bom
        JOIN `hcp_stock_pm` pm ON pm.id = bom.pm_id
        WHERE bom.fg_id = %s
    """, (fg_id,)).fetchall()
    bom = [dict(b) for b in bom]
    if not bom:
        # No BOM — allow the dispatch but consume nothing
        return [], []

    # 2. For each PM, check availability (consumption + rejection wastage)
    shortages = []
    plan = []
    for ln in bom:
        pm_id   = ln['pm_id']
        qty_per = _f(ln['qty_per_unit'])
        consume = qty_per * _f(dispatch_qty)
        rej     = round(consume * rej_factor, 4) if rej_factor > 0 else 0.0
        need    = consume + rej

        # Compute current closing — but if we're updating, exclude this
        # dispatch's existing consumption from the "consumed" total.
        current = _pm_closing(conn, pm_id)
        if ignore_dispatch_id:
            already = conn.execute("""
                SELECT COALESCE(SUM(qty_consumed),0) AS q
                FROM `hcp_stock_dispatch_consume`
                WHERE pm_id=%s AND dispatch_id=%s
            """, (pm_id, ignore_dispatch_id)).fetchone()
            current += _f(dict(already)['q'])

        if need > current + 1e-6:
            shortages.append({
                'pm_id':       pm_id,
                'pm_name':     ln['pm_name'],
                'available':   round(current, 2),
                'required':    round(need, 2),
                'short_by':    round(need - current, 2),
            })
        plan.append({'pm_id': pm_id, 'qty_per_unit': qty_per,
                     'qty_consumed': consume, 'rejection_qty': rej,
                     'pm_name': ln['pm_name']})

    if shortages:
        raise StockShortError(shortages)
    return plan, []


def add_dispatch(data):
    """Adds dispatch + auto-deducts PM via BOM. Atomic: rollback on shortage.

    If data['deduct_rejection'] is truthy, an extra wastage row is written for
    each PM in the BOM equal to (qty_consumed * rejection_pct%), reason
    "{pct}% Rejection (auto)". Default pct = 2.
    """
    fg_id        = int(data.get('fg_id') or 0)
    quantity     = _f(data.get('quantity'))
    if fg_id <= 0 or quantity <= 0:
        raise ValueError('fg_id and positive quantity required')

    deduct_rej  = bool(data.get('deduct_rejection'))
    rejection_pct = _f(data.get('rejection_pct')) if deduct_rej else 0.0
    if deduct_rej and rejection_pct <= 0:
        rejection_pct = 2.0

    conn = _conn()
    if not conn:
        return None
    try:
        plan, _ = _validate_and_get_bom(conn, fg_id, quantity,
                                        rejection_pct=rejection_pct)

        cur = conn.cursor()
        cur.execute("""
            INSERT INTO `hcp_stock_dispatch`
                (entry_date, fg_id, quantity, ref_no, remarks)
            VALUES (%s,%s,%s,%s,%s)
        """, (data.get('entry_date'), fg_id, quantity,
              data.get('ref_no', ''), data.get('remarks', '')))
        dispatch_id = cur.lastrowid

        # write consumption rows (if BOM existed)
        for p in plan:
            cur.execute("""
                INSERT INTO `hcp_stock_dispatch_consume`
                    (dispatch_id, pm_id, qty_per_unit, qty_consumed)
                VALUES (%s,%s,%s,%s)
            """, (dispatch_id, p['pm_id'],
                  p['qty_per_unit'], p['qty_consumed']))

        # write auto-rejection wastage rows
        if deduct_rej:
            _write_rejection_wastage(cur, plan, data.get('entry_date'),
                                     rejection_pct, dispatch_id)

        conn.commit()
        return dispatch_id
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def _write_rejection_wastage(cur, plan, entry_date, rejection_pct, dispatch_id):
    """Insert one wastage row per BOM PM for the auto rejection deduction.
    `plan` lines must carry 'rejection_qty'. Skips zero-qty lines."""
    pct_label = (f'{rejection_pct:g}')
    reason = f'{pct_label}% Rejection (auto)'
    for p in plan:
        rej = _f(p.get('rejection_qty'))
        if rej <= 0:
            continue
        cur.execute("""
            INSERT INTO `hcp_stock_wastage`
                (entry_date, pm_id, quantity, reason, remarks)
            VALUES (%s,%s,%s,%s,%s)
        """, (entry_date, p['pm_id'], rej, reason,
              f'Auto {pct_label}% rejection on dispatch #{dispatch_id}'))


def batch_add_dispatch(items):
    """Process multiple dispatch lines as a single atomic transaction.
    items: [{ entry_date, fg_id, quantity, ref_no, remarks }, ...]

    Rolls back the entire batch if ANY line fails (shortage, bad data, etc).
    Validation runs cumulatively — each line's BOM consumption is committed
    BEFORE the next line is validated, so PM stock decreases line-by-line
    inside the same transaction.

    Returns: list of new dispatch ids (in input order) on success.
    Raises:  StockShortError(shortages, line_index=N) on PM shortage,
             ValueError on bad input.
    """
    if not items:
        raise ValueError('no items')

    conn = _conn()
    if not conn:
        return []
    try:
        ids = []
        cur = conn.cursor()
        for idx, data in enumerate(items, start=1):
            fg_id    = int(data.get('fg_id') or 0)
            quantity = _f(data.get('quantity'))
            if fg_id <= 0 or quantity <= 0:
                raise ValueError(f'Line {idx}: fg_id and positive quantity required')

            deduct_rej  = bool(data.get('deduct_rejection'))
            rejection_pct = _f(data.get('rejection_pct')) if deduct_rej else 0.0
            if deduct_rej and rejection_pct <= 0:
                rejection_pct = 2.0

            try:
                plan, _ = _validate_and_get_bom(conn, fg_id, quantity,
                                                rejection_pct=rejection_pct)
            except StockShortError as e:
                # tag the failing line index so the caller can highlight it
                e.line_index = idx
                raise

            cur.execute("""
                INSERT INTO `hcp_stock_dispatch`
                    (entry_date, fg_id, quantity, ref_no, remarks)
                VALUES (%s,%s,%s,%s,%s)
            """, (data.get('entry_date'), fg_id, quantity,
                  data.get('ref_no', ''), data.get('remarks', '')))
            dispatch_id = cur.lastrowid
            for p in plan:
                cur.execute("""
                    INSERT INTO `hcp_stock_dispatch_consume`
                        (dispatch_id, pm_id, qty_per_unit, qty_consumed)
                    VALUES (%s,%s,%s,%s)
                """, (dispatch_id, p['pm_id'],
                      p['qty_per_unit'], p['qty_consumed']))
            if deduct_rej:
                _write_rejection_wastage(cur, plan, data.get('entry_date'),
                                         rejection_pct, dispatch_id)
            ids.append(dispatch_id)

        conn.commit()
        return ids
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def update_dispatch(txn_id, data):
    """
    Update an existing dispatch.  Re-runs BOM consumption from scratch.
    """
    fg_id    = int(data.get('fg_id') or 0)
    quantity = _f(data.get('quantity'))
    if fg_id <= 0 or quantity <= 0:
        raise ValueError('fg_id and positive quantity required')

    conn = _conn()
    if not conn:
        return
    try:
        # Validate as if old consumption isn't there
        plan, _ = _validate_and_get_bom(conn, fg_id, quantity,
                                        ignore_dispatch_id=txn_id)

        # 1. update dispatch row
        conn.execute("""
            UPDATE `hcp_stock_dispatch` SET
                entry_date=%s, fg_id=%s, quantity=%s, ref_no=%s, remarks=%s
            WHERE id=%s
        """, (data.get('entry_date'), fg_id, quantity,
              data.get('ref_no', ''), data.get('remarks', ''), txn_id))

        # 2. delete & rewrite consumption snapshot
        conn.execute("DELETE FROM `hcp_stock_dispatch_consume` WHERE dispatch_id=%s",
                     (txn_id,))
        cur = conn.cursor()
        for p in plan:
            cur.execute("""
                INSERT INTO `hcp_stock_dispatch_consume`
                    (dispatch_id, pm_id, qty_per_unit, qty_consumed)
                VALUES (%s,%s,%s,%s)
            """, (txn_id, p['pm_id'],
                  p['qty_per_unit'], p['qty_consumed']))
        conn.commit()
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def delete_dispatch(txn_id, *, user_name=None):
    """Soft-delete dispatch. Consumption rows are NOT touched — _pm_closing's
    JOIN-on-deleted_at-IS-NULL excludes them from PM math automatically.
    On restore, the consumption rebinds correctly."""
    return soft_delete('dispatch', txn_id, user_name=user_name)


def get_dispatch_consumption(dispatch_id):
    """Per-dispatch breakdown of which PMs were consumed and how much."""
    conn = _conn()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT dc.pm_id, dc.qty_per_unit, dc.qty_consumed,
                   pm.pm_code, pm.pm_name, pm.pm_type, pm.sku_size
            FROM `hcp_stock_dispatch_consume` dc
            JOIN `hcp_stock_pm` pm ON pm.id = dc.pm_id
            WHERE dc.dispatch_id = %s
        """, (dispatch_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            _floatify(d, 'qty_per_unit', 'qty_consumed')
            out.append(d)
        return out
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# KPI snapshot
# ═══════════════════════════════════════════════════════════════════════════════
def kpi_summary(brand_id=None):
    pm   = get_pm_rows(brand_id=brand_id)
    fg   = get_fg_rows(brand_id=brand_id)

    total_open    = sum(r['opening_stock']    or 0 for r in pm)
    total_in      = sum(r['inward_qty']       or 0 for r in pm)
    total_consume = sum(r['bom_consumed_qty'] or 0 for r in pm)
    total_waste   = sum(r['actual_wastage']   or 0 for r in pm)
    total_close   = sum(r['closing_stock']    or 0 for r in pm)
    total_disp    = sum(r['dispatch_qty']     or 0 for r in fg)

    waste_pct = (total_waste / total_in * 100) if total_in else 0.0
    return {
        'pm_count':           len(pm),
        'fg_count':           len(fg),
        'opening_stock':      total_open,
        'inward':             total_in,
        'bom_consumption':    total_consume,
        'actual_wastage':     total_waste,
        'closing_stock':      total_close,
        'fg_dispatch':        total_disp,
        'wastage_percent':    round(waste_pct, 2),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# FG REQUIREMENT (dated)
# ─────────────────────────────────────────────────────────────────────────────
# Each row = "Plan to produce <quantity> units of FG <fg_id> on <entry_date>".
# Soft-deletable. Used both for daily entry (Multi-Requirement modal) and as
# the data source for the Requirement vs Dispatch variance report.
# ═══════════════════════════════════════════════════════════════════════════════
def list_fg_requirements(brand_id=None, fg_id=None,
                         start_date=None, end_date=None):
    """All non-deleted requirement entries, joined with FG identity.
    Optional filters: brand_id, fg_id, date range."""
    conn = _conn()
    if not conn:
        return []
    try:
        where = ['req.deleted_at IS NULL']
        args  = []
        if brand_id:
            where.append('fg.brand_id = %s'); args.append(brand_id)
        if fg_id:
            where.append('req.fg_id = %s'); args.append(fg_id)
        if start_date:
            where.append('req.entry_date >= %s'); args.append(start_date)
        if end_date:
            where.append('req.entry_date <= %s'); args.append(end_date)

        rows = conn.execute(f"""
            SELECT req.id, req.fg_id, req.entry_date, req.quantity, req.note,
                   req.created_by, req.created_at,
                   fg.product_code, fg.product_name, fg.sku_size, fg.brand_id,
                   pb.name AS brand_name, pb.color AS brand_color, pb.text_color AS brand_text_color
            FROM `hcp_stock_fg_requirement` req
            JOIN `hcp_stock_fg` fg ON fg.id = req.fg_id
            LEFT JOIN `procurement_brands` pb ON pb.id = fg.brand_id
            WHERE {' AND '.join(where)}
            ORDER BY req.entry_date DESC, req.id DESC
        """, tuple(args)).fetchall()

        out = []
        for r in rows:
            d = dict(r)
            d['quantity']   = _f(d.get('quantity'))
            if hasattr(d.get('entry_date'), 'strftime'):
                d['entry_date'] = d['entry_date'].strftime('%Y-%m-%d')
            if hasattr(d.get('created_at'), 'strftime'):
                d['created_at'] = d['created_at'].strftime('%Y-%m-%d %H:%M:%S')
            out.append(d)
        return out
    finally:
        conn.close()


def add_fg_requirement_batch(items, *, created_by=None):
    """Insert many requirement rows atomically.

    items: [{'fg_id', 'entry_date', 'quantity', 'note'}, …]

    Validates each line: fg_id must exist + not soft-deleted, qty > 0,
    entry_date present. Rolls back the entire batch if any line fails.

    On success, also refreshes hcp_stock_fg.requirement_qty for each touched
    FG to be the sum of its non-deleted requirement entries (so the inline
    cell on the FG grid stays meaningful as a "current open requirement").

    Returns: list of new requirement ids in input order.
    Raises:  ValueError(message, line_index=N) on bad input.
    """
    if not items:
        raise ValueError('no items')

    conn = _conn()
    if not conn:
        return []
    try:
        ids = []
        touched_fgs = set()
        cur = conn.cursor()
        for idx, data in enumerate(items, start=1):
            fg_id    = int(data.get('fg_id') or 0)
            quantity = _f(data.get('quantity'))
            entry_dt = (data.get('entry_date') or '').strip()
            note     = (data.get('note') or '').strip()

            if fg_id <= 0:
                e = ValueError(f'Line {idx}: please pick a Product (FG)')
                e.line_index = idx; raise e
            if quantity <= 0:
                e = ValueError(f'Line {idx}: quantity must be greater than zero')
                e.line_index = idx; raise e
            if not entry_dt:
                e = ValueError(f'Line {idx}: entry date is required')
                e.line_index = idx; raise e

            row = conn.execute(
                "SELECT id FROM `hcp_stock_fg` WHERE id=%s AND deleted_at IS NULL",
                (fg_id,)
            ).fetchone()
            if not row:
                e = ValueError(f'Line {idx}: FG not found or has been deleted')
                e.line_index = idx; raise e

            cur.execute("""
                INSERT INTO `hcp_stock_fg_requirement`
                    (fg_id, entry_date, quantity, note, created_by)
                VALUES (%s,%s,%s,%s,%s)
            """, (fg_id, entry_dt, quantity, note[:500], (created_by or '')[:120]))
            ids.append(cur.lastrowid)
            touched_fgs.add(fg_id)

        # Refresh the cached requirement_qty on each touched FG row.
        # The cached value = sum of all non-deleted requirement rows for that FG.
        # This keeps the FG grid's "Requirement" pill meaningful while the
        # detailed history lives in hcp_stock_fg_requirement.
        for fg_id in touched_fgs:
            tot = conn.execute("""
                SELECT COALESCE(SUM(quantity),0) AS s
                FROM `hcp_stock_fg_requirement`
                WHERE fg_id=%s AND deleted_at IS NULL
            """, (fg_id,)).fetchone()
            conn.execute(
                "UPDATE `hcp_stock_fg` SET requirement_qty=%s WHERE id=%s",
                (_f(dict(tot)['s']), fg_id)
            )

        conn.commit()
        return ids
    except Exception:
        try: conn._conn.rollback()
        except Exception: pass
        raise
    finally:
        conn.close()


def soft_delete_fg_requirement(req_id, *, user_name=None):
    """Mark a single requirement entry as deleted; updates the FG's cached
    requirement_qty to the new sum."""
    conn = _conn()
    if not conn:
        return False
    try:
        row = conn.execute(
            "SELECT fg_id FROM `hcp_stock_fg_requirement` WHERE id=%s AND deleted_at IS NULL",
            (req_id,)
        ).fetchone()
        if not row:
            return False
        fg_id = dict(row)['fg_id']

        conn.execute("""
            UPDATE `hcp_stock_fg_requirement`
               SET deleted_at = CURRENT_TIMESTAMP, deleted_by = %s
             WHERE id = %s
        """, ((user_name or '')[:120], req_id))

        # Refresh cached requirement_qty
        tot = conn.execute("""
            SELECT COALESCE(SUM(quantity),0) AS s
            FROM `hcp_stock_fg_requirement`
            WHERE fg_id=%s AND deleted_at IS NULL
        """, (fg_id,)).fetchone()
        conn.execute(
            "UPDATE `hcp_stock_fg` SET requirement_qty=%s WHERE id=%s",
            (_f(dict(tot)['s']), fg_id)
        )
        conn.commit()
        return True
    finally:
        conn.close()


def admin_reset_fg_requirement_clear_all(fg_id, *, user_name=None):
    """ADMIN-ONLY: soft-delete every non-deleted requirement entry for an FG.

    The cached requirement_qty is recomputed (will become 0). The dated history
    is preserved — entries are flagged deleted_at = now, deleted_by = admin —
    and remain visible in the Recycle Bin and the Requirement History view
    (when 'show deleted' is on), and can be restored individually if needed.

    Returns: number of entries that were soft-deleted.
    Raises:  RuntimeError with a useful message on DB errors.
    """
    conn = _conn()
    if not conn:
        raise RuntimeError('Could not connect to database')
    try:
        # Sanity: confirm the table exists. If a server was started with an
        # older codebase, the migration may have been skipped — surface a
        # clear error rather than a generic 500.
        try:
            n_row = conn.execute("""
                SELECT COUNT(*) AS n
                FROM `hcp_stock_fg_requirement`
                WHERE fg_id=%s AND deleted_at IS NULL
            """, (fg_id,)).fetchone()
        except Exception as e:
            msg = str(e).lower()
            if "doesn't exist" in msg or 'unknown table' in msg or 'no such table' in msg:
                raise RuntimeError(
                    "The hcp_stock_fg_requirement table is missing. "
                    "Please restart the Flask app — ensure_tables() will create it on startup."
                )
            raise

        n_to_delete = int(dict(n_row)['n'])

        if n_to_delete > 0:
            conn.execute("""
                UPDATE `hcp_stock_fg_requirement`
                   SET deleted_at = CURRENT_TIMESTAMP,
                       deleted_by = %s
                 WHERE fg_id = %s AND deleted_at IS NULL
            """, ((user_name or '')[:120], fg_id))

        # Cached requirement_qty drops to 0 (sum of non-deleted entries = 0)
        conn.execute(
            "UPDATE `hcp_stock_fg` SET requirement_qty=0 WHERE id=%s",
            (fg_id,)
        )
        conn.commit()
        return n_to_delete
    finally:
        conn.close()


def admin_reset_fg_requirement_override(fg_id, new_quantity, *, user_name=None):
    """ADMIN-ONLY: directly set hcp_stock_fg.requirement_qty to a fixed value
    WITHOUT touching the dated history.

    This breaks the normal invariant "cached value = sum of dated entries"
    — the cell will show <new_quantity> while the history table may sum to
    a different number. Use sparingly. The action is loudly audit-logged
    so the divergence is traceable.

    Note: a subsequent batch insert OR soft-delete on hcp_stock_fg_requirement
    will recompute the cached value from the history table, wiping this
    override. Admins doing an override should be aware of that.

    Returns: dict with the previous cached value, the new cached value, and
    the current sum of dated entries (so the caller can show divergence).
    """
    conn = _conn()
    if not conn:
        return None
    try:
        prev_row = conn.execute(
            "SELECT requirement_qty FROM `hcp_stock_fg` WHERE id=%s",
            (fg_id,)
        ).fetchone()
        if not prev_row:
            return None
        prev = _f(dict(prev_row)['requirement_qty'])

        new_q = max(0.0, _f(new_quantity))
        conn.execute(
            "UPDATE `hcp_stock_fg` SET requirement_qty=%s WHERE id=%s",
            (new_q, fg_id)
        )

        sum_row = conn.execute("""
            SELECT COALESCE(SUM(quantity),0) AS s
            FROM `hcp_stock_fg_requirement`
            WHERE fg_id=%s AND deleted_at IS NULL
        """, (fg_id,)).fetchone()
        history_sum = _f(dict(sum_row)['s'])

        conn.commit()
        return {
            'previous_qty':  prev,
            'new_qty':       new_q,
            'history_sum':   history_sum,
            'divergence':    round(new_q - history_sum, 4),
        }
    finally:
        conn.close()


def requirement_vs_dispatch_report(*, start_date=None, end_date=None,
                                   brand_id=None):
    """Per-FG variance report.

    For each FG that has either a requirement entry OR a dispatch transaction
    in the requested date window:
      • required_qty   — sum of requirements in [start, end] (deleted excluded)
      • dispatched_qty — sum of dispatches in [start, end] (deleted excluded)
      • shortfall      — max(0, required - dispatched)   (informational)
      • surplus        — max(0, dispatched - required)   (informational)
      • achievement    — round(dispatched / required * 100, 2) when required>0

    Sorted by FG name. brand_id optional to scope to one brand.
    """
    conn = _conn()
    if not conn:
        return []
    try:
        date_clause_req = []
        date_clause_dis = []
        args = []
        if start_date:
            date_clause_req.append('AND req.entry_date >= %s')
            date_clause_dis.append('AND d.entry_date >= %s')
        if end_date:
            date_clause_req.append('AND req.entry_date <= %s')
            date_clause_dis.append('AND d.entry_date <= %s')
        # Note: we use a UNION-style pattern but keep it as two separate
        # aggregates joined on fg_id, which is simpler for MariaDB.

        # Build SQL pieces (same args appear in both subqueries)
        req_args  = []
        disp_args = []
        if start_date:
            req_args.append(start_date); disp_args.append(start_date)
        if end_date:
            req_args.append(end_date);   disp_args.append(end_date)

        brand_clause = ''
        brand_args   = []
        if brand_id:
            brand_clause = 'AND fg.brand_id = %s'
            brand_args   = [brand_id]

        sql = f"""
            SELECT
                fg.id            AS fg_id,
                fg.product_code  AS product_code,
                fg.product_name  AS product_name,
                fg.sku_size      AS sku_size,
                fg.brand_id      AS brand_id,
                pb.name          AS brand_name,
                pb.color         AS brand_color,
                pb.text_color    AS brand_text_color,
                COALESCE(req_agg.qty, 0) AS required_qty,
                COALESCE(dis_agg.qty, 0) AS dispatched_qty
            FROM `hcp_stock_fg` fg
            LEFT JOIN `procurement_brands` pb ON pb.id = fg.brand_id
            LEFT JOIN (
                SELECT req.fg_id, SUM(req.quantity) AS qty
                FROM `hcp_stock_fg_requirement` req
                WHERE req.deleted_at IS NULL
                  {' '.join(date_clause_req)}
                GROUP BY req.fg_id
            ) req_agg ON req_agg.fg_id = fg.id
            LEFT JOIN (
                SELECT d.fg_id, SUM(d.quantity) AS qty
                FROM `hcp_stock_dispatch` d
                WHERE d.deleted_at IS NULL
                  {' '.join(date_clause_dis)}
                GROUP BY d.fg_id
            ) dis_agg ON dis_agg.fg_id = fg.id
            WHERE fg.deleted_at IS NULL
              {brand_clause}
              AND (req_agg.qty IS NOT NULL OR dis_agg.qty IS NOT NULL)
            ORDER BY fg.product_name, fg.product_code
        """
        all_args = tuple(req_args + disp_args + brand_args)
        rows = conn.execute(sql, all_args).fetchall()

        out = []
        for r in rows:
            d = dict(r)
            req = _f(d.get('required_qty'))
            dis = _f(d.get('dispatched_qty'))
            d['required_qty']   = req
            d['dispatched_qty'] = dis
            d['shortfall']      = max(0.0, req - dis)
            d['surplus']        = max(0.0, dis - req)
            d['achievement_pct'] = round((dis / req * 100), 2) if req > 0 else None
            out.append(d)
        return out
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# REQUIREMENT LEDGER  —  FIFO dispatch allocation + pending balance
# ───────────────────────────────────────────────────────────────────────────────
# Fulfilment rule (confirmed with product owner):
#   A requirement is met by FG dispatches dated ON OR AFTER its entry_date.
#   Because one FG can have several open requirements, each FG's dispatches are
#   allocated FIFO across that FG's requirements ordered by (entry_date, id) so
#   every dispatched unit is counted exactly once.
#
#   pending = entered − dispatched_allocated − preclosed
#
#   Preclosure closes the *whole remaining balance* of one requirement:
#   preclosed_qty is frozen at (entered − dispatched_allocated_at_that_moment),
#   which drives pending to 0 and removes the row from the FIFO pool for any
#   dispatch dated after the preclosure. Revoking nulls the preclosure columns.
# ═══════════════════════════════════════════════════════════════════════════════
def _allocate_fifo_for_fg(conn, fg_id, *, as_of_date=None):
    """Core allocator for ONE fg. Returns a dict keyed by requirement id:
        { req_id: {entered, dispatched, preclosed, pending, is_preclosed,
                   entry_date, preclosed_at, preclosed_by, preclosed_qty,
                   preclose_note, note, created_by, created_at} }

    A preclosed requirement still consumes its already-allocated dispatches
    (so history stays accurate) but takes no NEW dispatch allocation and its
    pending is forced to 0.

    as_of_date (optional 'YYYY-MM-DD'): only count dispatches up to this date
    (used by date-bounded reports). Requirements themselves are not date-filtered
    here — callers filter which requirements to display.
    """
    # 1. Pull this FG's open (non-deleted) requirements, oldest first.
    reqs = conn.execute("""
        SELECT id, entry_date, quantity, note, created_by, created_at,
               preclosed_at, preclosed_by, preclosed_qty, preclose_note
        FROM `hcp_stock_fg_requirement`
        WHERE fg_id = %s AND deleted_at IS NULL
        ORDER BY entry_date ASC, id ASC
    """, (fg_id,)).fetchall()
    reqs = [dict(r) for r in reqs]
    if not reqs:
        return {}

    # 2. Pull this FG's dispatches (non-deleted), oldest first, optionally capped.
    d_where = "fg_id = %s AND deleted_at IS NULL"
    d_args  = [fg_id]
    if as_of_date:
        d_where += " AND entry_date <= %s"; d_args.append(as_of_date)
    disp = conn.execute(f"""
        SELECT id, entry_date, quantity
        FROM `hcp_stock_dispatch`
        WHERE {d_where}
        ORDER BY entry_date ASC, id ASC
    """, tuple(d_args)).fetchall()
    disp = [dict(x) for x in disp]

    # 3. FIFO allocation. Walk requirements oldest-first; for each, consume
    #    dispatches dated >= the requirement's entry_date that still have a
    #    remaining balance. A dispatch can spill across several requirements.
    #    Preclosed requirements are skipped for NEW allocation.
    remaining = {x['id']: _f(x['quantity']) for x in disp}  # dispatch_id → unallocated qty

    result = {}
    for rq in reqs:
        rid       = rq['id']
        entered   = _f(rq['quantity'])
        is_pre    = rq['preclosed_at'] is not None
        rq_date   = rq['entry_date']
        allocated = 0.0

        if not is_pre:
            need = entered
            for dx in disp:
                if need <= 1e-9:
                    break
                if remaining[dx['id']] <= 1e-9:
                    continue
                # dispatch must be dated on/after this requirement's entry_date
                if dx['entry_date'] is not None and rq_date is not None \
                   and dx['entry_date'] < rq_date:
                    continue
                take = min(need, remaining[dx['id']])
                remaining[dx['id']] -= take
                need -= take
                allocated += take
            preclosed = 0.0
            pending   = max(0.0, entered - allocated)
        else:
            # Preclosed: freeze. preclosed_qty was stored at preclosure time.
            # Still allocate the dispatches it had consumed BEFORE preclosure so
            # they aren't double-counted by later requirements — we approximate
            # that by giving it its recorded dispatched (= entered − preclosed_qty).
            preclosed = _f(rq['preclosed_qty'])
            allocated = max(0.0, entered - preclosed)
            # consume that much from the dispatch pool, oldest eligible first
            need = allocated
            for dx in disp:
                if need <= 1e-9:
                    break
                if remaining[dx['id']] <= 1e-9:
                    continue
                if dx['entry_date'] is not None and rq_date is not None \
                   and dx['entry_date'] < rq_date:
                    continue
                take = min(need, remaining[dx['id']])
                remaining[dx['id']] -= take
                need -= take
            pending = 0.0

        d_str = lambda v: v.strftime('%Y-%m-%d') if hasattr(v, 'strftime') else v
        dt_str = lambda v: v.strftime('%Y-%m-%d %H:%M:%S') if hasattr(v, 'strftime') else v
        result[rid] = {
            'req_id':       rid,
            'entered':      entered,
            'dispatched':   round(allocated, 4),
            'preclosed':    round(preclosed, 4),
            'pending':      round(pending, 4),
            'is_preclosed': is_pre,
            'entry_date':   d_str(rq_date),
            'note':         rq.get('note') or '',
            'created_by':   rq.get('created_by') or '',
            'created_at':   dt_str(rq.get('created_at')),
            'preclosed_at': dt_str(rq.get('preclosed_at')),
            'preclosed_by': rq.get('preclosed_by') or '',
            'preclosed_qty': _f(rq.get('preclosed_qty')) if rq.get('preclosed_qty') is not None else None,
            'preclose_note': rq.get('preclose_note') or '',
        }
    return result


def list_requirement_ledger(*, brand_id=None, fg_id=None,
                            start_date=None, end_date=None,
                            include_preclosed=True, as_of_date=None):
    """Per-requirement ledger across FGs, with FIFO-allocated dispatched + pending.

    Filters:
      • brand_id / fg_id           — scope
      • start_date / end_date      — filter which REQUIREMENT entry_dates show
      • include_preclosed=False    — hide fully-preclosed (closed) requirements
      • as_of_date                 — cap dispatch counting at this date

    Returns a list of per-requirement dicts (newest entry_date first) carrying
    FG identity + brand styling, ready for the Requirements grid.
    """
    conn = _conn()
    if not conn:
        return []
    try:
        # Which FGs are in scope? (any FG that has at least one open requirement)
        where = ['req.deleted_at IS NULL']
        args  = []
        if brand_id:
            where.append('fg.brand_id = %s'); args.append(brand_id)
        if fg_id:
            where.append('req.fg_id = %s'); args.append(fg_id)
        fg_rows = conn.execute(f"""
            SELECT DISTINCT fg.id AS fg_id, fg.product_code, fg.product_name,
                   fg.sku_size, fg.brand_id,
                   pb.name AS brand_name, pb.color AS brand_color,
                   pb.text_color AS brand_text_color
            FROM `hcp_stock_fg_requirement` req
            JOIN `hcp_stock_fg` fg ON fg.id = req.fg_id
            LEFT JOIN `procurement_brands` pb ON pb.id = fg.brand_id
            WHERE {' AND '.join(where)} AND fg.deleted_at IS NULL
        """, tuple(args)).fetchall()
        fg_rows = [dict(r) for r in fg_rows]

        out = []
        for fg in fg_rows:
            ledger = _allocate_fifo_for_fg(conn, fg['fg_id'], as_of_date=as_of_date)
            for rid, led in ledger.items():
                # date-range filter on the requirement's own entry_date
                ed = led['entry_date']
                if start_date and ed and ed < start_date:   continue
                if end_date   and ed and ed > end_date:     continue
                if not include_preclosed and led['is_preclosed']:
                    continue
                row = dict(led)
                row.update({
                    'fg_id':            fg['fg_id'],
                    'product_code':     fg.get('product_code') or '',
                    'product_name':     fg.get('product_name') or '',
                    'sku_size':         fg.get('sku_size') or '',
                    'brand_id':         fg.get('brand_id'),
                    'brand_name':       fg.get('brand_name') or '',
                    'brand_color':      fg.get('brand_color') or '',
                    'brand_text_color': fg.get('brand_text_color') or '',
                })
                out.append(row)
        # newest first, then by FG
        out.sort(key=lambda r: (r.get('entry_date') or '', r.get('req_id') or 0),
                 reverse=True)
        return out
    finally:
        conn.close()


def fg_pending_requirement(fg_id, *, as_of_date=None):
    """Pending requirement qty for one FG, used by the PM "can build" calc,
    the Check-PM planner default, and the 'Pending Requirement' chip.

    Definition (Option B, confirmed with product owner):
        pending = (sum of requirement entries that are NOT preclosed)
                  − (all dispatches − dispatches that went to preclosed entries)

    A preclosed entry is treated as fully settled: its dispatched share
    (= entered − preclosed_qty) is removed from the dispatch total so it does
    NOT reduce the remaining open requirements. Floored at 0.

    Notes:
      • Dispatches are not linked to specific requirements in the schema, so the
        preclosed dispatch share is derived from the preclosed_qty frozen at
        preclosure time.
      • as_of_date, when given, caps dispatches at that date.
    """
    conn = _conn()
    if not conn:
        return 0.0
    try:
        req = _f(dict(conn.execute("""
            SELECT COALESCE(SUM(quantity), 0) AS s
            FROM `hcp_stock_fg_requirement`
            WHERE fg_id = %s AND deleted_at IS NULL
              AND preclosed_at IS NULL
        """, (fg_id,)).fetchone())['s'])

        preclosed_disp = _f(dict(conn.execute("""
            SELECT COALESCE(SUM(GREATEST(quantity - COALESCE(preclosed_qty,0), 0)), 0) AS s
            FROM `hcp_stock_fg_requirement`
            WHERE fg_id = %s AND deleted_at IS NULL
              AND preclosed_at IS NOT NULL
        """, (fg_id,)).fetchone())['s'])

        d_where = "fg_id = %s AND deleted_at IS NULL"
        d_args  = [fg_id]
        if as_of_date:
            d_where += " AND entry_date <= %s"; d_args.append(as_of_date)
        disp = _f(dict(conn.execute(
            f"SELECT COALESCE(SUM(quantity), 0) AS s FROM `hcp_stock_dispatch` WHERE {d_where}",
            tuple(d_args)).fetchone())['s'])

        disp_against_open = max(0.0, disp - preclosed_disp)
        return round(max(0.0, req - disp_against_open), 4)
    finally:
        conn.close()


def preclose_requirement(req_id, *, user_name=None, note=None):
    """Force-close the remaining balance of ONE requirement.

    Freezes preclosed_qty = entered − dispatched-allocated-right-now, so the
    requirement's pending becomes 0 and it leaves the FIFO pool for future
    dispatches. Idempotent-safe: returns False if already preclosed or missing.

    Returns a dict {req_id, entered, dispatched, preclosed_qty} on success.
    """
    conn = _conn()
    if not conn:
        raise RuntimeError('Could not connect to database')
    try:
        row = conn.execute("""
            SELECT fg_id, quantity, preclosed_at
            FROM `hcp_stock_fg_requirement`
            WHERE id=%s AND deleted_at IS NULL
        """, (req_id,)).fetchone()
        if not row:
            return False
        row = dict(row)
        if row['preclosed_at'] is not None:
            return False  # already preclosed

        fg_id   = row['fg_id']
        entered = _f(row['quantity'])

        # Compute how much of THIS requirement is currently dispatched (FIFO).
        ledger = _allocate_fifo_for_fg(conn, fg_id)
        led = ledger.get(req_id, {})
        dispatched = _f(led.get('dispatched'))
        preclosed_qty = max(0.0, entered - dispatched)

        conn.execute("""
            UPDATE `hcp_stock_fg_requirement`
               SET preclosed_at  = CURRENT_TIMESTAMP,
                   preclosed_by  = %s,
                   preclosed_qty = %s,
                   preclose_note = %s
             WHERE id = %s
        """, ((user_name or '')[:120], preclosed_qty,
              (note or '')[:500] or None, req_id))
        conn.commit()
        return {'req_id': req_id, 'entered': entered,
                'dispatched': round(dispatched, 4),
                'preclosed_qty': round(preclosed_qty, 4)}
    finally:
        conn.close()


def revoke_preclosure(req_id, *, user_name=None):
    """Undo a preclosure: null the four preclosure columns so the requirement
    re-enters the FIFO pool and its pending is recomputed live. Returns True on
    success, False if the requirement is missing or wasn't preclosed."""
    conn = _conn()
    if not conn:
        raise RuntimeError('Could not connect to database')
    try:
        row = conn.execute("""
            SELECT preclosed_at FROM `hcp_stock_fg_requirement`
            WHERE id=%s AND deleted_at IS NULL
        """, (req_id,)).fetchone()
        if not row or dict(row)['preclosed_at'] is None:
            return False
        conn.execute("""
            UPDATE `hcp_stock_fg_requirement`
               SET preclosed_at  = NULL,
                   preclosed_by  = NULL,
                   preclosed_qty = NULL,
                   preclose_note = NULL
             WHERE id = %s
        """, (req_id,))
        conn.commit()
        return True
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# REPORTS
# ─────────────────────────────────────────────────────────────────────────────
# All reports reuse the established definitions:
#   • PM closing stock = opening + inward − bom_consumed − wastage
#   • FG pending (Option B) = (non-preclosed requirement entries)
#                             − (all dispatches − dispatches tied to preclosed entries)
# A single helper computes every FG's pending in one pass so report loops stay fast.
# ═══════════════════════════════════════════════════════════════════════════════
def _all_fg_pending(conn, brand_id=None):
    """Return {fg_id: pending_qty} for all FGs (Option B), in one pass.
    pending = open_req − max(0, all_dispatch − preclosed_dispatch_share)."""
    where = "fg.deleted_at IS NULL"
    args  = []
    if brand_id:
        where += " AND fg.brand_id = %s"; args.append(brand_id)
    rows = conn.execute(f"""
        SELECT fg.id AS fg_id,
            COALESCE((SELECT SUM(quantity) FROM `hcp_stock_fg_requirement`
                      WHERE fg_id = fg.id AND deleted_at IS NULL
                        AND preclosed_at IS NULL), 0) AS open_req,
            COALESCE((SELECT SUM(GREATEST(quantity - COALESCE(preclosed_qty,0), 0))
                      FROM `hcp_stock_fg_requirement`
                      WHERE fg_id = fg.id AND deleted_at IS NULL
                        AND preclosed_at IS NOT NULL), 0) AS preclosed_disp,
            COALESCE((SELECT SUM(quantity) FROM `hcp_stock_dispatch`
                      WHERE fg_id = fg.id AND deleted_at IS NULL), 0) AS all_disp
        FROM `hcp_stock_fg` fg
        WHERE {where}
    """, tuple(args)).fetchall()
    out = {}
    for r in rows:
        d = dict(r)
        disp_against_open = max(0.0, _f(d['all_disp']) - _f(d['preclosed_disp']))
        out[d['fg_id']] = round(max(0.0, _f(d['open_req']) - disp_against_open), 4)
    return out


def report_pm_shortage(brand_id=None):
    """PM Shortage & Reorder.

    For every PM: current closing stock vs the total quantity required to fulfil
    the PENDING requirement of every FG that consumes it (via BOM):
        required = Σ over FGs using this PM of (fg_pending × qty_per_unit)
        shortfall = max(0, required − closing_stock)
    Also flags below-threshold PMs and estimates a suggested order qty.
    """
    conn = _conn()
    if not conn:
        return {'rows': [], 'totals': {}}
    try:
        pend = _all_fg_pending(conn, brand_id)

        # Required-per-PM: join BOM × FG pending.
        where = "pm.deleted_at IS NULL AND fg.deleted_at IS NULL"
        args  = []
        if brand_id:
            where += " AND pm.brand_id = %s"; args.append(brand_id)
        bom_rows = conn.execute(f"""
            SELECT bom.pm_id, bom.fg_id, bom.qty_per_unit
            FROM `hcp_stock_bom` bom
            JOIN `hcp_stock_pm` pm ON pm.id = bom.pm_id
            JOIN `hcp_stock_fg` fg ON fg.id = bom.fg_id
            WHERE {where}
        """, tuple(args)).fetchall()
        required_by_pm = {}
        fgs_by_pm = {}
        for r in bom_rows:
            d = dict(r)
            need = _f(d['qty_per_unit']) * pend.get(d['fg_id'], 0.0)
            required_by_pm[d['pm_id']] = required_by_pm.get(d['pm_id'], 0.0) + need
            fgs_by_pm.setdefault(d['pm_id'], set()).add(d['fg_id'])

        pms = get_pm_rows(brand_id=brand_id)
        out = []
        for pm in pms:
            closing  = _f(pm.get('closing_stock'))
            required = round(required_by_pm.get(pm['id'], 0.0), 4)
            shortfall = round(max(0.0, required - closing), 4)
            thr = _f(pm.get('low_stock_threshold'))
            # Suggested order: cover the shortfall, and top back up to threshold
            # if a threshold is set and stock would still sit below it.
            suggested = shortfall
            if thr > 0:
                suggested = max(suggested, round(max(0.0, thr - (closing - required)), 4))
            if shortfall > 0:
                status = 'short'
            elif thr > 0 and closing < thr:
                status = 'low'
            else:
                status = 'ok'
            out.append({
                'pm_id':        pm['id'],
                'pm_code':      pm.get('pm_code') or '',
                'pm_name':      pm.get('pm_name') or '',
                'pm_type':      pm.get('pm_type') or '',
                'sku_size':     pm.get('sku_size') or '',
                'brand_name':   pm.get('brand_name') or '',
                'brand_color':  pm.get('brand_color') or '',
                'brand_text_color': pm.get('brand_text_color') or '',
                'closing_stock': round(closing, 4),
                'required_qty':  required,
                'shortfall':     shortfall,
                'low_stock_threshold': thr,
                'fg_count':      len(fgs_by_pm.get(pm['id'], ())),
                'suggested_order': round(suggested, 4),
                'status':        status,
            })
        # Shortages first, then low, then by name
        order = {'short': 0, 'low': 1, 'ok': 2}
        out.sort(key=lambda r: (order.get(r['status'], 3), -r['shortfall'], r['pm_name']))
        totals = {
            'pm_count':       len(out),
            'short_count':    sum(1 for r in out if r['status'] == 'short'),
            'low_count':      sum(1 for r in out if r['status'] == 'low'),
        }
        return {'rows': out, 'totals': totals}
    finally:
        conn.close()


def report_fg_buildability(brand_id=None):
    """FG Buildability.

    For each FG with a BOM: its pending requirement, how many finished units can
    be built right now from current PM stock (the bottleneck PM caps it), and
    which PM is the constraint.
    """
    conn = _conn()
    if not conn:
        return {'rows': [], 'totals': {}}
    try:
        pend = _all_fg_pending(conn, brand_id)
        fgs = get_fg_rows(brand_id=brand_id)
        # PM closing snapshot once
        pm_closing = {p['id']: _f(p.get('closing_stock')) for p in get_pm_rows()}

        out = []
        for fg in fgs:
            bom = get_bom_for_fg(fg['id'])
            if not bom:
                continue  # no BOM → not buildable / not meaningful here
            pending = pend.get(fg['id'], 0.0)
            can_build = None
            bottleneck = None
            for ln in bom:
                qpu = _f(ln['qty_per_unit'])
                if qpu <= 0:
                    continue
                stock = pm_closing.get(ln['pm_id'], 0.0)
                units = int(stock // qpu)
                if can_build is None or units < can_build:
                    can_build = units
                    bottleneck = ln
            can_build = can_build or 0
            shortfall_units = round(max(0.0, pending - can_build), 4)
            out.append({
                'fg_id':         fg['id'],
                'product_code':  fg.get('product_code') or '',
                'product_name':  fg.get('product_name') or '',
                'category':      fg.get('category') or '',
                'sku_size':      fg.get('sku_size') or '',
                'brand_name':    fg.get('brand_name') or '',
                'brand_color':   fg.get('brand_color') or '',
                'brand_text_color': fg.get('brand_text_color') or '',
                'pending_qty':   round(pending, 4),
                'can_build':     can_build,
                'bom_lines':     len(bom),
                'bottleneck_pm': (bottleneck.get('pm_name') if bottleneck else ''),
                'bottleneck_pm_code': (bottleneck.get('pm_code') if bottleneck else ''),
                'shortfall_units': shortfall_units,
                'feasible':      (can_build >= pending) if pending > 0 else True,
            })
        # Most constrained first: those with pending but can't build
        out.sort(key=lambda r: (
            0 if (r['pending_qty'] > 0 and not r['feasible']) else 1,
            -r['shortfall_units'], r['product_name']))
        totals = {
            'fg_count':       len(out),
            'blocked_count':  sum(1 for r in out if r['pending_qty'] > 0 and not r['feasible']),
            'buildable_count':sum(1 for r in out if r['feasible']),
        }
        return {'rows': out, 'totals': totals}
    finally:
        conn.close()


def report_pm_ledger(pm_id, *, start_date=None, end_date=None):
    """PM Stock Ledger — every movement for one PM in date order with a running
    balance. Opening stock is the starting balance; then inwards (+), dispatch
    BOM consumption (−), and wastage (−), each as a dated line.
    """
    conn = _conn()
    if not conn:
        return {'pm': None, 'rows': [], 'opening': 0.0, 'closing': 0.0}
    try:
        pm = conn.execute("""
            SELECT pm.*, b.name AS brand_name
            FROM `hcp_stock_pm` pm
            LEFT JOIN `procurement_brands` b ON b.id = pm.brand_id
            WHERE pm.id = %s
        """, (pm_id,)).fetchone()
        if not pm:
            return {'pm': None, 'rows': [], 'opening': 0.0, 'closing': 0.0}
        pm = dict(pm)
        opening = _f(pm.get('opening_stock'))

        def _ds(v):
            if start_date and v and str(v) < start_date: return False
            if end_date   and v and str(v) > end_date:   return False
            return True

        movements = []  # (date, sort_key, type, ref, qty_signed, note)
        for r in conn.execute("""
            SELECT id, entry_date, quantity, ref_no
            FROM `hcp_stock_inward`
            WHERE pm_id = %s AND deleted_at IS NULL
        """, (pm_id,)).fetchall():
            d = dict(r)
            if _ds(d['entry_date']):
                movements.append((str(d['entry_date'] or ''), d['id'], 'Inward',
                                  d.get('ref_no') or '', _f(d['quantity']), ''))
        for r in conn.execute("""
            SELECT d.id, d.entry_date, d.ref_no, dc.qty_consumed,
                   fg.product_name, fg.product_code
            FROM `hcp_stock_dispatch_consume` dc
            JOIN `hcp_stock_dispatch` d ON d.id = dc.dispatch_id
            LEFT JOIN `hcp_stock_fg` fg ON fg.id = d.fg_id
            WHERE dc.pm_id = %s AND d.deleted_at IS NULL
        """, (pm_id,)).fetchall():
            d = dict(r)
            if _ds(d['entry_date']):
                lbl = (d.get('product_name') or d.get('product_code') or 'FG')
                movements.append((str(d['entry_date'] or ''), d['id'], 'Dispatch use',
                                  d.get('ref_no') or '', -_f(d['qty_consumed']),
                                  f"for {lbl}"))
        for r in conn.execute("""
            SELECT id, entry_date, quantity, reason
            FROM `hcp_stock_wastage`
            WHERE pm_id = %s AND deleted_at IS NULL
        """, (pm_id,)).fetchall():
            d = dict(r)
            if _ds(d['entry_date']):
                movements.append((str(d['entry_date'] or ''), d['id'], 'Wastage',
                                  '', -_f(d['quantity']), d.get('reason') or ''))

        # Sort by date then type stability
        movements.sort(key=lambda m: (m[0], m[2], m[1]))

        rows = []
        bal = opening
        # Opening line first (only meaningful when not date-filtered to a later window)
        rows.append({'date': '', 'type': 'Opening', 'ref': '', 'in_qty': None,
                     'out_qty': None, 'balance': round(bal, 4), 'note': 'Opening stock'})
        for (dt, _sk, typ, ref, qty, note) in movements:
            bal += qty
            rows.append({
                'date':    dt,
                'type':    typ,
                'ref':     ref,
                'in_qty':  round(qty, 4) if qty > 0 else None,
                'out_qty': round(-qty, 4) if qty < 0 else None,
                'balance': round(bal, 4),
                'note':    note,
            })
        return {
            'pm': {
                'pm_id':   pm['id'],
                'pm_code': pm.get('pm_code') or '',
                'pm_name': pm.get('pm_name') or '',
                'pm_type': pm.get('pm_type') or '',
                'sku_size':pm.get('sku_size') or '',
                'brand_name': pm.get('brand_name') or '',
                'rate':    _f(pm.get('rate')),
            },
            'opening': round(opening, 4),
            'closing': round(bal, 4),
            'rows':    rows,
            'movement_count': len(movements),
        }
    finally:
        conn.close()


def report_dispatch_summary(brand_id=None, start_date=None, end_date=None,
                            group_by='brand'):
    """Dispatch Summary — FG units dispatched, grouped by brand / category /
    product / month, within an optional date range.
    group_by ∈ {'brand', 'category', 'product', 'month'}.
    """
    conn = _conn()
    if not conn:
        return {'rows': [], 'totals': {}, 'group_by': group_by}
    try:
        where = "d.deleted_at IS NULL AND fg.deleted_at IS NULL"
        args  = []
        if brand_id:
            where += " AND fg.brand_id = %s"; args.append(brand_id)
        if start_date:
            where += " AND d.entry_date >= %s"; args.append(start_date)
        if end_date:
            where += " AND d.entry_date <= %s"; args.append(end_date)

        if group_by == 'category':
            label_sql = "COALESCE(NULLIF(TRIM(fg.category),''),'(uncategorised)')"
        elif group_by == 'product':
            label_sql = "fg.product_name"
        elif group_by == 'month':
            # Avoid DATE_FORMAT('%Y-%m') — the % specifiers clash with the
            # driver's pyformat parameter substitution and raise a 500 when
            # any filter arg is present. Build YYYY-MM without format codes.
            label_sql = ("CONCAT(YEAR(d.entry_date), '-', "
                         "LPAD(MONTH(d.entry_date), 2, '0'))")
        else:
            group_by = 'brand'
            label_sql = "COALESCE(b.name,'(no brand)')"

        rows = conn.execute(f"""
            SELECT {label_sql} AS grp,
                   SUM(d.quantity) AS units,
                   COUNT(*) AS dispatch_count,
                   COUNT(DISTINCT d.fg_id) AS fg_count
            FROM `hcp_stock_dispatch` d
            JOIN `hcp_stock_fg` fg ON fg.id = d.fg_id
            LEFT JOIN `procurement_brands` b ON b.id = fg.brand_id
            WHERE {where}
            GROUP BY grp
            ORDER BY units DESC
        """, tuple(args)).fetchall()

        out = []
        tot_units = 0.0
        tot_disp = 0
        for r in rows:
            d = dict(r)
            u = _f(d['units'])
            tot_units += u
            tot_disp += int(d['dispatch_count'])
            out.append({
                'group':         d['grp'] or '(none)',
                'units':         round(u, 4),
                'dispatch_count': int(d['dispatch_count']),
                'fg_count':      int(d['fg_count']),
            })
        return {
            'rows': out,
            'group_by': group_by,
            'date_range': {'from': start_date, 'to': end_date},
            'totals': {
                'units':          round(tot_units, 4),
                'dispatch_count': tot_disp,
                'group_count':    len(out),
            },
        }
    finally:
        conn.close()
