"""
Dispatch Entry feature — FG-driven stock decrement vouchers.

A Dispatch voucher records the consumption of packaging-material inventory
against one or more Finished Goods (FG) being dispatched. The voucher is
the link between "what got shipped/produced" (FG side) and "what stock was
consumed to produce it" (PM-component side, driven by each FG's BOM).

Workflow
--------
  1. Operator opens "Dispatch Entry" from the Add New launcher.
  2. They pick a location — either Factory godown (godown_id=1) OR Floor
     (godown_id=4). All deductions for the voucher come from this pool.
  3. They add one or more FG lines. For each FG line:
       - Pick FG product from pm_fg_products (with active BOM)
       - Enter FG qty
       - System expands the BOM → preview of PM components consumed
       - User MAY override component qtys before committing the line
       - Duplicate FG inside the same voucher is blocked (per Tarak's spec)
  4. Voucher stays in 'draft' status — no stock change, can be left open
     across sessions, re-opened from the voucher log, edited freely.
  5. On Submit:
       - Voucher number is allocated (PM-DSP via procurement_voucher_numbering)
       - Stock availability is checked per component vs the chosen location.
         If any shortfall, submit is REJECTED with line-by-line breakdown.
       - All deductions are posted atomically:
           * Factory location → pm_godown_txn txn_type='outward', godown_id=1
           * Floor location   → pm_floor_txn  txn_type='dispatch', godown_id=4
       - Voucher state flips to 'submitted'; submit_at timestamp set.
  6. Within 24 hours of submit_at, the voucher can be edited by any user
     who can see it. Editing reverses old deductions and applies new ones
     atomically.
  7. After 24 hours, edits require admin-password confirmation via the
     same /admin_passcheck endpoint that gates Auto-Verify.
  8. Cancel: admin-only, reverses all deductions, marks 'cancelled'.

Tables
------
  pm_dispatch_vouchers     — Header (voucher_no, date, location, state, who)
  pm_dispatch_lines        — FG lines (one row per FG on the voucher)
  pm_dispatch_consumption  — Component-level deductions (one row per PM
                             component-per-FG-line). Drives stock posting.
"""

from flask import request, jsonify, session
from datetime import datetime, date, timedelta
import json
import sampling_portal


_helpers = None
def _load_helpers():
    global _helpers
    if _helpers is None:
        from . import helpers as _h
        _helpers = _h
    return _helpers


# ════════════════════════════════════════════════════════════════════════
# Constants
# ════════════════════════════════════════════════════════════════════════

# Lifecycle states
ST_DRAFT     = 'draft'
ST_SUBMITTED = 'submitted'
ST_LOCKED    = 'locked'      # only set via the 24h auto-flip; behavior-wise
                              # 'submitted'+past-24h is equivalent. We store
                              # this state explicitly only after admin lock.
ST_CANCELLED = 'cancelled'

# Allowed location godown_ids (single-source-of-truth, matches procurement_godowns)
LOC_FACTORY  = 1   # FACTORY (godown_id)
LOC_FLOOR    = 4   # Floor   (godown_id)
ALLOWED_LOCS = (LOC_FACTORY, LOC_FLOOR)

# 24-hour edit window
EDIT_WINDOW_HOURS = 24


# ════════════════════════════════════════════════════════════════════════
# Schema setup
# ════════════════════════════════════════════════════════════════════════

def ensure_dispatch_tables():
    """Create dispatch tables if missing. Idempotent."""
    conn = sampling_portal.get_db_connection()
    try:
        # Header — one row per dispatch voucher
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_dispatch_vouchers (
                voucher_id      INT AUTO_INCREMENT PRIMARY KEY,
                voucher_no      VARCHAR(50)  DEFAULT NULL,
                voucher_date    DATE         NOT NULL,
                location_id     INT          NOT NULL,
                state           ENUM('draft','submitted','locked','cancelled')
                                NOT NULL DEFAULT 'draft',
                remarks         VARCHAR(500) DEFAULT '',
                created_by      VARCHAR(100) DEFAULT NULL,
                created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
                submitted_by    VARCHAR(100) DEFAULT NULL,
                submitted_at    DATETIME     DEFAULT NULL,
                cancelled_by    VARCHAR(100) DEFAULT NULL,
                cancelled_at    DATETIME     DEFAULT NULL,
                last_edited_by  VARCHAR(100) DEFAULT NULL,
                last_edited_at  DATETIME     DEFAULT NULL
                                ON UPDATE CURRENT_TIMESTAMP,
                INDEX ix_dsp_state    (state),
                INDEX ix_dsp_date     (voucher_date),
                INDEX ix_dsp_location (location_id),
                UNIQUE KEY uq_dsp_no  (voucher_no)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # FG lines — one row per FG on the voucher
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_dispatch_lines (
                line_id         INT AUTO_INCREMENT PRIMARY KEY,
                voucher_id      INT NOT NULL,
                fg_id           INT NOT NULL,
                fg_qty          DECIMAL(14,3) NOT NULL DEFAULT 0,
                bom_id          INT DEFAULT NULL,
                bom_version     INT DEFAULT NULL,
                sort_order      INT DEFAULT 0,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_dspl_voucher (voucher_id),
                INDEX ix_dspl_fg      (fg_id),
                UNIQUE KEY uq_dspl_voucher_fg (voucher_id, fg_id),
                CONSTRAINT fk_dspl_voucher FOREIGN KEY (voucher_id)
                    REFERENCES pm_dispatch_vouchers(voucher_id) ON DELETE CASCADE,
                CONSTRAINT fk_dspl_fg      FOREIGN KEY (fg_id)
                    REFERENCES pm_fg_products(fg_id) ON DELETE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # Component-level deductions — one row per (FG line × PM component).
        # On draft these are the previewed/edited qtys; on submit they
        # become the source of truth for posting to pm_godown_txn /
        # pm_floor_txn.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_dispatch_consumption (
                cons_id         INT AUTO_INCREMENT PRIMARY KEY,
                voucher_id      INT NOT NULL,
                line_id         INT NOT NULL,
                product_id      INT NOT NULL,
                qty             DECIMAL(14,3) NOT NULL DEFAULT 0,
                -- The qty the BOM would have suggested before user override.
                -- Diff vs qty makes "operator override" auditable.
                bom_qty         DECIMAL(14,3) NOT NULL DEFAULT 0,
                note            VARCHAR(200) DEFAULT '',
                INDEX ix_dspc_voucher (voucher_id),
                INDEX ix_dspc_line    (line_id),
                INDEX ix_dspc_product (product_id),
                CONSTRAINT fk_dspc_voucher FOREIGN KEY (voucher_id)
                    REFERENCES pm_dispatch_vouchers(voucher_id) ON DELETE CASCADE,
                CONSTRAINT fk_dspc_line    FOREIGN KEY (line_id)
                    REFERENCES pm_dispatch_lines(line_id) ON DELETE CASCADE,
                CONSTRAINT fk_dspc_product FOREIGN KEY (product_id)
                    REFERENCES pm_products(id) ON DELETE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass
        raise
    finally:
        try: conn.close()
        except Exception: pass


# ════════════════════════════════════════════════════════════════════════
# Internal helpers
# ════════════════════════════════════════════════════════════════════════

def _user():
    return _load_helpers()._user()

def _is_admin():
    return _load_helpers()._is_admin()


def _fetch_voucher(conn, voucher_id):
    """Load a voucher + its lines + consumption rows. Returns a dict or None."""
    hdr = conn.execute("""
        SELECT v.voucher_id, v.voucher_no, v.voucher_date, v.location_id,
               v.state, v.remarks,
               v.created_by, v.created_at,
               v.submitted_by, v.submitted_at,
               v.cancelled_by, v.cancelled_at,
               v.last_edited_by, v.last_edited_at,
               g.name AS location_name
        FROM pm_dispatch_vouchers v
        LEFT JOIN procurement_godowns g ON g.id = v.location_id
        WHERE v.voucher_id = %s
    """, (voucher_id,)).fetchone()
    if not hdr:
        return None
    d = dict(hdr) if hasattr(hdr, 'keys') else hdr

    # Convert datetime/date fields to ISO strings for JSON serialization
    for k in ('voucher_date','created_at','submitted_at','cancelled_at','last_edited_at'):
        v = d.get(k)
        if v is not None and not isinstance(v, str):
            try: d[k] = v.isoformat()
            except Exception: d[k] = str(v)

    # Lines + their consumption
    lines = conn.execute("""
        SELECT l.line_id, l.fg_id, l.fg_qty, l.bom_id, l.bom_version, l.sort_order,
               f.fg_code, f.fg_name, f.brand_name, COALESCE(f.is_active,1) AS fg_is_active
        FROM pm_dispatch_lines l
        JOIN pm_fg_products f ON f.fg_id = l.fg_id
        WHERE l.voucher_id = %s
        ORDER BY l.sort_order, l.line_id
    """, (voucher_id,)).fetchall() or []

    cons_rows = conn.execute("""
        SELECT c.cons_id, c.line_id, c.product_id, c.qty, c.bom_qty, c.note,
               COALESCE(p.product_name,'(deleted)') AS product_name,
               COALESCE(p.product_code,'')          AS product_code,
               COALESCE(p.pm_type,'')               AS pm_type,
               COALESCE(p.primary_uom,'Nos')        AS primary_uom
        FROM pm_dispatch_consumption c
        LEFT JOIN pm_products p ON p.id = c.product_id
        WHERE c.voucher_id = %s
        ORDER BY c.line_id, c.cons_id
    """, (voucher_id,)).fetchall() or []

    cons_by_line = {}
    for c in cons_rows:
        cd = dict(c) if hasattr(c, 'keys') else c
        cd['qty']     = float(cd.get('qty') or 0)
        cd['bom_qty'] = float(cd.get('bom_qty') or 0)
        cons_by_line.setdefault(int(cd['line_id']), []).append(cd)

    d['lines'] = []
    for r in lines:
        ld = dict(r) if hasattr(r, 'keys') else r
        ld['fg_qty'] = float(ld.get('fg_qty') or 0)
        ld['components'] = cons_by_line.get(int(ld['line_id']), [])
        d['lines'].append(ld)

    return d


def _expand_bom_for_fg(conn, fg_id, fg_qty):
    """Given an FG id + qty, return [(product_id, bom_qty, product_name, pm_type, note), ...]
    using the current pm_bom + pm_bom_items rows.

    Returns (bom_id, bom_version, items) tuple. items is a list of dicts.
    If FG has no BOM, returns (None, None, []).
    """
    bom = conn.execute("""
        SELECT bom_id, version
        FROM pm_bom
        WHERE fg_id = %s
        LIMIT 1
    """, (fg_id,)).fetchone()
    if not bom:
        return (None, None, [])

    bom_id = int(bom['bom_id'])
    bom_version = int(bom['version'] or 1)

    rows = conn.execute("""
        SELECT i.product_id, i.qty_per_unit, i.note,
               COALESCE(p.product_name,'(deleted)') AS product_name,
               COALESCE(p.product_code,'')          AS product_code,
               COALESCE(p.pm_type,'')               AS pm_type
        FROM pm_bom_items i
        LEFT JOIN pm_products p ON p.id = i.product_id
        WHERE i.bom_id = %s
        ORDER BY i.sort_order, i.item_id
    """, (bom_id,)).fetchall() or []

    fgq = float(fg_qty or 0)
    items = []
    for r in rows:
        per = float(r['qty_per_unit'] or 0)
        # Round to 3 decimal places — matches pm_dispatch_consumption.qty precision
        bom_qty = round(per * fgq, 3)
        items.append({
            'product_id':   int(r['product_id']),
            'product_name': r['product_name'],
            'product_code': r['product_code'] or '',
            'pm_type':      r['pm_type'] or '',
            'qty_per_unit': per,
            'bom_qty':      bom_qty,
            'note':         r['note'] or '',
        })
    return (bom_id, bom_version, items)


def _can_edit(voucher, user):
    """Return (True, '') if user may edit, else (False, reason).

    Rules:
      - draft         → anyone with access
      - cancelled     → noone (use a new voucher)
      - submitted, ≤24h since submit_at → anyone with access
      - submitted, >24h                  → admin or admin-password unlocked
      - locked                           → admin or admin-password unlocked
    """
    state = (voucher.get('state') or '').lower()
    if state == 'draft':
        return (True, '')
    if state == 'cancelled':
        return (False, 'Voucher is cancelled; create a new one.')
    if state not in ('submitted', 'locked'):
        return (False, f'Unknown voucher state: {state}')

    # Admins always pass
    if _is_admin():
        return (True, '')

    # Check 24-hour edit window
    sub_at = voucher.get('submitted_at')
    if not sub_at:
        # Shouldn't happen for submitted state, but be defensive
        return (False, 'Voucher has no submit timestamp; admin override required.')

    # Parse submitted_at (it may already be a string after _fetch_voucher)
    try:
        if isinstance(sub_at, str):
            # Handles 'YYYY-MM-DDTHH:MM:SS' or 'YYYY-MM-DD HH:MM:SS'
            sub_dt = datetime.fromisoformat(sub_at.replace(' ', 'T'))
        else:
            sub_dt = sub_at
        cutoff = sub_dt + timedelta(hours=EDIT_WINDOW_HOURS)
        if datetime.now() <= cutoff:
            return (True, '')
        return (False, f'Edit window has expired ({EDIT_WINDOW_HOURS}h). Admin password required.')
    except Exception as e:
        return (False, f'Could not determine edit window: {e}')


def _verify_admin_unlock(payload):
    """If payload includes admin_password, verify it inline.

    Returns (True, '') if verified or not needed-but-admin-already.
    Returns (False, message) if password is wrong / required but missing.
    """
    if _is_admin():
        return (True, '')
    pwd = (payload.get('admin_password') or '').strip()
    if not pwd:
        return (False, 'Admin password required (edit window expired or admin-only action).')

    # Reuse the same password-check logic as /admin_passcheck.
    conn = sampling_portal.get_db_connection()
    try:
        row = None
        for tbl in ('User_Tbl','user_tbl'):
            try:
                row = conn.execute(f"""
                    SELECT COALESCE(password_hash,'') AS password_hash,
                           COALESCE(is_active,1)     AS is_active
                    FROM {tbl}
                    WHERE LOWER(username)='admin'
                    LIMIT 1
                """).fetchone()
                if row: break
            except Exception:
                continue
        if not row:
            return (False, "User 'admin' not found")
        if int(row.get('is_active') or 1) == 0:
            return (False, 'Admin account disabled')
        stored = (row.get('password_hash') or '').strip().lower()
        if not stored:
            return (False, 'Admin has no password set')
        import hashlib as _h
        for algo in ('sha256','md5','sha1','sha512'):
            if _h.new(algo, pwd.encode('utf-8')).hexdigest() == stored:
                return (True, '')
        if pwd == stored:   # plaintext fallback
            return (True, '')
        return (False, 'Incorrect admin password')
    finally:
        try: conn.close()
        except Exception: pass


def _post_consumption(conn, voucher, sign):
    """Write stock-ledger rows for the voucher's consumption.

    `sign` = -1 for posting (deduct), +1 for reversing.
    Each consumption row creates one row in pm_godown_txn (Factory) or
    pm_floor_txn (Floor), depending on the voucher's location_id.

    No-ops if there are no consumption rows.
    """
    loc = int(voucher.get('location_id') or 0)
    if loc not in ALLOWED_LOCS:
        raise ValueError(f'Invalid location_id {loc}')

    vno  = voucher.get('voucher_no') or ''
    vdate = voucher.get('voucher_date')
    # voucher_date might already be an ISO string after _fetch_voucher; coerce to date.
    if isinstance(vdate, str):
        try: vdate = date.fromisoformat(vdate)
        except Exception: vdate = date.today()
    elif vdate is None:
        vdate = date.today()
    user = _user()
    remark_tag = f'[PM-DSP:{vno}]' if vno else '[PM-DSP:DRAFT]'
    note = f'{remark_tag} {"REVERSAL" if sign > 0 else "DISPATCH"}'

    cons = conn.execute("""
        SELECT product_id, SUM(qty) AS total_qty
        FROM pm_dispatch_consumption
        WHERE voucher_id = %s
        GROUP BY product_id
        HAVING SUM(qty) > 0
    """, (voucher['voucher_id'],)).fetchall() or []

    if not cons:
        return

    if loc == LOC_FACTORY:
        # Outward on pm_godown_txn for godown_id=1
        # sign=-1 (deduct) → outward; sign=+1 (reverse) → inward
        for r in cons:
            qty = float(r['total_qty'])
            txn_type = 'outward' if sign < 0 else 'inward'
            conn.execute("""
                INSERT INTO pm_godown_txn
                    (product_id, godown_id, txn_type, txn_date, qty,
                     voucher_no, remarks, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            """, (int(r['product_id']), loc, txn_type, vdate,
                  qty, vno or None, note, user))
    else:  # LOC_FLOOR
        # pm_floor_txn — txn_type='dispatch' for deduct, 'pm_return' for reverse
        for r in cons:
            qty = float(r['total_qty'])
            txn_type = 'dispatch' if sign < 0 else 'pm_return'
            conn.execute("""
                INSERT INTO pm_floor_txn
                    (product_id, godown_id, txn_type, txn_date, qty,
                     voucher_no, remarks, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            """, (int(r['product_id']), loc, txn_type, vdate,
                  qty, vno or None, note, user))


def _reverse_consumption(conn, voucher):
    """Undo previous postings by deleting the ledger rows tied to this
    voucher_no. Used when:
      - editing a submitted voucher (clear old, re-post new)
      - cancelling a submitted voucher
    Safer than inserting offsetting +1 rows because it leaves no double
    history confusion in the stock card.
    """
    vno = voucher.get('voucher_no')
    if not vno:
        return  # Drafts don't have postings to reverse
    conn.execute("""
        DELETE FROM pm_godown_txn
        WHERE voucher_no = %s
          AND remarks LIKE %s
    """, (vno, f'[PM-DSP:{vno}]%'))
    conn.execute("""
        DELETE FROM pm_floor_txn
        WHERE voucher_no = %s
          AND remarks LIKE %s
    """, (vno, f'[PM-DSP:{vno}]%'))


def _check_stock_availability(conn, voucher):
    """Validate the voucher's consumption against current stock at the
    voucher's location. Returns (ok, shortfalls).
    shortfalls is a list of {product_id, product_name, need, have, short}.
    """
    loc = int(voucher.get('location_id') or 0)
    cons = conn.execute("""
        SELECT c.product_id,
               SUM(c.qty) AS need,
               COALESCE(p.product_name,'(deleted)') AS product_name,
               COALESCE(p.product_code,'')          AS product_code,
               COALESCE(p.pm_type,'')               AS pm_type
        FROM pm_dispatch_consumption c
        LEFT JOIN pm_products p ON p.id = c.product_id
        WHERE c.voucher_id = %s
        GROUP BY c.product_id, p.product_name, p.product_code, p.pm_type
        HAVING SUM(c.qty) > 0
    """, (voucher['voucher_id'],)).fetchall() or []

    if not cons:
        return (False, [{'product_id': 0, 'product_name': '(no components)',
                         'need': 0, 'have': 0, 'short': 0,
                         'message': 'Voucher has no consumption lines.'}])

    shortfalls = []
    for r in cons:
        pid = int(r['product_id'])
        need = float(r['need'] or 0)

        if loc == LOC_FACTORY:
            # Available = SUM(opening+inward) - SUM(outward) on godown_id=1
            row = conn.execute("""
                SELECT
                  COALESCE(SUM(CASE WHEN txn_type IN ('opening','inward')
                                    THEN qty ELSE 0 END), 0) -
                  COALESCE(SUM(CASE WHEN txn_type = 'outward'
                                    THEN qty ELSE 0 END), 0) AS available
                FROM pm_godown_txn
                WHERE product_id = %s AND godown_id = %s
            """, (pid, loc)).fetchone()
        else:  # LOC_FLOOR
            row = conn.execute("""
                SELECT
                  COALESCE(SUM(CASE WHEN txn_type IN ('floor_opening','issue','pm_return')
                                    THEN qty ELSE 0 END), 0) -
                  COALESCE(SUM(CASE WHEN txn_type IN ('dispatch','rejection')
                                    THEN qty ELSE 0 END), 0) AS available
                FROM pm_floor_txn
                WHERE product_id = %s AND godown_id = %s
            """, (pid, loc)).fetchone()

        have = float((row or {}).get('available') or 0) if row else 0.0
        if have < need:
            shortfalls.append({
                'product_id':   pid,
                'product_name': r['product_name'],
                'product_code': r['product_code'],
                'pm_type':      r['pm_type'],
                'need':         need,
                'have':         have,
                'short':        round(need - have, 3),
            })
    return (len(shortfalls) == 0, shortfalls)


# ════════════════════════════════════════════════════════════════════════
# Route registration
# ════════════════════════════════════════════════════════════════════════

def register_routes(bp):
    """Mount dispatch endpoints onto the shared pm_stock blueprint."""
    h = _load_helpers()
    _login_required = h._login_required

    # ── 1. FG picker (BOM-having FG list) ────────────────────────────
    @bp.route('/api/pm_stock/dispatch/fg_picker', methods=['GET'])
    @_login_required
    def api_dsp_fg_picker():
        """Return active FG products that have a BOM, for the FG picker
        in the dispatch modal. Filtering by query string `q` matches
        fg_code or fg_name prefix-style."""
        q = (request.args.get('q') or '').strip()
        conn = sampling_portal.get_db_connection()
        try:
            params = []
            where = ["f.is_active = 1"]
            if q:
                where.append("(f.fg_code LIKE %s OR f.fg_name LIKE %s)")
                params += [f'%{q}%', f'%{q}%']
            rows = conn.execute(f"""
                SELECT f.fg_id, f.fg_code, f.fg_name, f.brand_name,
                       b.bom_id, b.version
                FROM pm_fg_products f
                INNER JOIN pm_bom b ON b.fg_id = f.fg_id
                WHERE {' AND '.join(where)}
                ORDER BY f.fg_name
                LIMIT 50
            """, params).fetchall() or []
            return jsonify({
                'status': 'ok',
                'rows': [
                    {
                        'fg_id':       int(r['fg_id']),
                        'fg_code':     r['fg_code'],
                        'fg_name':     r['fg_name'],
                        'brand_name':  r.get('brand_name') or '',
                        'bom_id':      int(r['bom_id']),
                        'bom_version': int(r['version'] or 1),
                    } for r in rows
                ]
            })
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 2. BOM expansion preview ─────────────────────────────────────
    @bp.route('/api/pm_stock/dispatch/expand_bom', methods=['POST'])
    @_login_required
    def api_dsp_expand_bom():
        """Given an FG and qty, return the BOM-driven component preview."""
        d = request.get_json(silent=True) or {}
        try:
            fg_id  = int(d.get('fg_id') or 0)
            fg_qty = float(d.get('fg_qty') or 0)
        except (TypeError, ValueError):
            return jsonify({'status':'error','message':'Invalid fg_id or fg_qty'}), 400
        if fg_id <= 0 or fg_qty <= 0:
            return jsonify({'status':'error','message':'fg_id and positive fg_qty required'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            bom_id, bom_version, items = _expand_bom_for_fg(conn, fg_id, fg_qty)
            if bom_id is None:
                return jsonify({'status':'error','message':'No active BOM for this FG'}), 404
            return jsonify({
                'status':      'ok',
                'fg_id':       fg_id,
                'fg_qty':      fg_qty,
                'bom_id':      bom_id,
                'bom_version': bom_version,
                'items':       items,
            })
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 3. Create draft voucher ─────────────────────────────────────
    @bp.route('/api/pm_stock/dispatch/create', methods=['POST'])
    @_login_required
    def api_dsp_create():
        """Create an empty draft. Body: { voucher_date, location_id, remarks? }
        Returns: { voucher_id }"""
        d = request.get_json(silent=True) or {}
        try:
            location_id = int(d.get('location_id') or 0)
        except (TypeError, ValueError):
            return jsonify({'status':'error','message':'Invalid location_id'}), 400
        if location_id not in ALLOWED_LOCS:
            return jsonify({'status':'error',
                            'message':'Location must be FACTORY (1) or Floor (4)'}), 400
        vdate = d.get('voucher_date') or str(date.today())
        try:
            date.fromisoformat(vdate)
        except Exception:
            return jsonify({'status':'error','message':'Invalid voucher_date (YYYY-MM-DD)'}), 400
        remarks = (d.get('remarks') or '').strip()[:500]

        conn = sampling_portal.get_db_connection()
        try:
            cur = conn.execute("""
                INSERT INTO pm_dispatch_vouchers
                    (voucher_date, location_id, state, remarks, created_by)
                VALUES (%s, %s, 'draft', %s, %s)
            """, (vdate, location_id, remarks, _user()))
            voucher_id = cur.lastrowid
            conn.commit()
            return jsonify({'status':'ok','voucher_id':int(voucher_id)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 4. Add FG line (with components) ─────────────────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/lines/add', methods=['POST'])
    @_login_required
    def api_dsp_add_line(voucher_id):
        """Body: { fg_id, fg_qty, components: [{product_id, qty, note?}] }
        Validates that voucher is editable, FG isn't already on the
        voucher, and components is a non-empty list."""
        d = request.get_json(silent=True) or {}
        try:
            fg_id  = int(d.get('fg_id') or 0)
            fg_qty = float(d.get('fg_qty') or 0)
        except (TypeError, ValueError):
            return jsonify({'status':'error','message':'Invalid fg_id/fg_qty'}), 400
        if fg_id <= 0 or fg_qty <= 0:
            return jsonify({'status':'error','message':'fg_id and positive fg_qty required'}), 400

        comps = d.get('components') or []
        if not isinstance(comps, list) or len(comps) == 0:
            return jsonify({'status':'error',
                            'message':'At least one component is required'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            ok, why = _can_edit(v, _user())
            if not ok:
                ok2, msg2 = _verify_admin_unlock(d)
                if not ok2:
                    return jsonify({'status':'error','message': why + ' ' + msg2}), 403

            # Dup-FG check (per Tarak's spec)
            dup = conn.execute("""
                SELECT line_id FROM pm_dispatch_lines
                WHERE voucher_id = %s AND fg_id = %s
                LIMIT 1
            """, (voucher_id, fg_id)).fetchone()
            if dup:
                return jsonify({'status':'error',
                                'message':'This FG is already on the voucher. Edit that line instead.'}), 409

            # Snapshot BOM id+version (informational; we use user-supplied
            # qtys verbatim).
            bom_id, bom_version, _ = _expand_bom_for_fg(conn, fg_id, fg_qty)
            if bom_id is None:
                return jsonify({'status':'error',
                                'message':'FG has no active BOM'}), 400

            # Determine sort_order (push to end)
            last = conn.execute("""
                SELECT COALESCE(MAX(sort_order),0) AS s
                FROM pm_dispatch_lines WHERE voucher_id=%s
            """, (voucher_id,)).fetchone()
            sort_order = int((last or {}).get('s') or 0) + 1

            cur = conn.execute("""
                INSERT INTO pm_dispatch_lines
                    (voucher_id, fg_id, fg_qty, bom_id, bom_version, sort_order)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (voucher_id, fg_id, fg_qty, bom_id, bom_version, sort_order))
            line_id = cur.lastrowid

            # Recompute BOM expansion for bom_qty values (so we can audit
            # override deltas) and insert one consumption row per component.
            _, _, bom_items = _expand_bom_for_fg(conn, fg_id, fg_qty)
            bom_map = { int(it['product_id']): float(it['bom_qty']) for it in bom_items }
            for c in comps:
                try:
                    pid = int(c.get('product_id') or 0)
                    qty = float(c.get('qty') or 0)
                except (TypeError, ValueError):
                    continue
                if pid <= 0 or qty <= 0:
                    continue
                note = (c.get('note') or '')[:200]
                bom_qty = bom_map.get(pid, 0.0)
                conn.execute("""
                    INSERT INTO pm_dispatch_consumption
                        (voucher_id, line_id, product_id, qty, bom_qty, note)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """, (voucher_id, line_id, pid, qty, bom_qty, note))

            # Touch last_edited fields on the header
            conn.execute("""
                UPDATE pm_dispatch_vouchers
                SET last_edited_by = %s
                WHERE voucher_id = %s
            """, (_user(), voucher_id))

            conn.commit()
            return jsonify({'status':'ok','line_id':int(line_id)})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 5. Update an existing FG line ────────────────────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/lines/<int:line_id>/update', methods=['POST'])
    @_login_required
    def api_dsp_update_line(voucher_id, line_id):
        """Body: { fg_qty?, components: [{product_id, qty, note?}] }
        Replaces all consumption rows for this line. fg_id is immutable
        once added (delete the line and add a new one if you want to
        change the FG)."""
        d = request.get_json(silent=True) or {}
        comps = d.get('components')
        if comps is not None and (not isinstance(comps, list) or len(comps) == 0):
            return jsonify({'status':'error',
                            'message':'components must be a non-empty list when provided'}), 400

        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            ok, why = _can_edit(v, _user())
            if not ok:
                ok2, msg2 = _verify_admin_unlock(d)
                if not ok2:
                    return jsonify({'status':'error','message': why + ' ' + msg2}), 403

            line = conn.execute("""
                SELECT line_id, fg_id, fg_qty FROM pm_dispatch_lines
                WHERE line_id=%s AND voucher_id=%s
            """, (line_id, voucher_id)).fetchone()
            if not line:
                return jsonify({'status':'error','message':'Line not found'}), 404

            new_fg_qty = line['fg_qty']
            if 'fg_qty' in d:
                try:
                    new_fg_qty = float(d.get('fg_qty') or 0)
                except (TypeError, ValueError):
                    return jsonify({'status':'error','message':'Invalid fg_qty'}), 400
                if new_fg_qty <= 0:
                    return jsonify({'status':'error','message':'fg_qty must be > 0'}), 400
                conn.execute("""
                    UPDATE pm_dispatch_lines SET fg_qty=%s
                    WHERE line_id=%s
                """, (new_fg_qty, line_id))

            if comps is not None:
                # Re-expand BOM for bom_qty audit
                _, _, bom_items = _expand_bom_for_fg(conn, int(line['fg_id']), float(new_fg_qty))
                bom_map = { int(it['product_id']): float(it['bom_qty']) for it in bom_items }
                conn.execute("DELETE FROM pm_dispatch_consumption WHERE line_id=%s", (line_id,))
                for c in comps:
                    try:
                        pid = int(c.get('product_id') or 0)
                        qty = float(c.get('qty') or 0)
                    except (TypeError, ValueError):
                        continue
                    if pid <= 0 or qty <= 0:
                        continue
                    note = (c.get('note') or '')[:200]
                    bom_qty = bom_map.get(pid, 0.0)
                    conn.execute("""
                        INSERT INTO pm_dispatch_consumption
                            (voucher_id, line_id, product_id, qty, bom_qty, note)
                        VALUES (%s, %s, %s, %s, %s, %s)
                    """, (voucher_id, line_id, pid, qty, bom_qty, note))

            conn.execute("""
                UPDATE pm_dispatch_vouchers SET last_edited_by=%s WHERE voucher_id=%s
            """, (_user(), voucher_id))

            # If the voucher was already submitted, we need to refresh stock
            # postings (reverse old, apply new). Drafts stay in draft.
            v2 = _fetch_voucher(conn, voucher_id)
            state = (v2.get('state') or '').lower()
            if state in ('submitted','locked'):
                _reverse_consumption(conn, v2)
                ok_avail, shortfalls = _check_stock_availability(conn, v2)
                if not ok_avail:
                    # Rollback the edit because we can't honour the new amounts
                    conn.rollback()
                    return jsonify({
                        'status':'error',
                        'message':'Edit rejected: stock shortfall at the voucher location.',
                        'shortfalls': shortfalls,
                    }), 409
                _post_consumption(conn, v2, sign=-1)

            conn.commit()
            return jsonify({'status':'ok'})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 6. Delete a line ─────────────────────────────────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/lines/<int:line_id>/delete', methods=['POST'])
    @_login_required
    def api_dsp_delete_line(voucher_id, line_id):
        d = request.get_json(silent=True) or {}
        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            ok, why = _can_edit(v, _user())
            if not ok:
                ok2, msg2 = _verify_admin_unlock(d)
                if not ok2:
                    return jsonify({'status':'error','message': why + ' ' + msg2}), 403

            res = conn.execute("""
                DELETE FROM pm_dispatch_lines
                WHERE line_id=%s AND voucher_id=%s
            """, (line_id, voucher_id))
            if not res.rowcount:
                return jsonify({'status':'error','message':'Line not found'}), 404

            conn.execute("""
                UPDATE pm_dispatch_vouchers SET last_edited_by=%s WHERE voucher_id=%s
            """, (_user(), voucher_id))

            # Re-post if the voucher was already submitted
            v2 = _fetch_voucher(conn, voucher_id)
            if (v2.get('state') or '').lower() in ('submitted','locked'):
                _reverse_consumption(conn, v2)
                # Empty voucher with no lines: just leave the ledger empty
                if v2['lines']:
                    _post_consumption(conn, v2, sign=-1)

            conn.commit()
            return jsonify({'status':'ok'})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 7. Submit ────────────────────────────────────────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/submit', methods=['POST'])
    @_login_required
    def api_dsp_submit(voucher_id):
        """Allocate voucher number, check stock, post deductions, lock to
        'submitted'. Rejects with 409 + shortfalls JSON if any component
        is short at the chosen location."""
        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            state = (v.get('state') or '').lower()
            if state != 'draft':
                return jsonify({'status':'error',
                                'message':f'Voucher is already {state}; cannot submit again.'}), 409
            if not v['lines']:
                return jsonify({'status':'error',
                                'message':'Voucher has no FG lines.'}), 400

            # Allocate voucher number
            vdate = v.get('voucher_date') or str(date.today())
            if isinstance(vdate, str):
                try: vdate_obj = date.fromisoformat(vdate)
                except Exception: vdate_obj = date.today()
            else:
                vdate_obj = vdate
            try:
                voucher_no = _load_helpers()._next_voucher_no(conn, 'PM-DSP', vdate_obj)
            except Exception as e:
                return jsonify({'status':'error',
                                'message':f'Voucher numbering failed: {e}'}), 500

            conn.execute("""
                UPDATE pm_dispatch_vouchers
                SET voucher_no=%s
                WHERE voucher_id=%s
            """, (voucher_no, voucher_id))

            # Re-fetch with voucher_no populated for downstream helpers
            v2 = _fetch_voucher(conn, voucher_id)

            # Stock check at chosen location
            ok_avail, shortfalls = _check_stock_availability(conn, v2)
            if not ok_avail:
                # Roll back the voucher_no allocation too — the row stays in draft.
                conn.rollback()
                return jsonify({
                    'status':'error',
                    'message':'Stock shortfall — voucher cannot be submitted.',
                    'shortfalls': shortfalls,
                }), 409

            # Post deductions
            _post_consumption(conn, v2, sign=-1)

            # Flip state
            conn.execute("""
                UPDATE pm_dispatch_vouchers
                SET state='submitted',
                    submitted_by=%s,
                    submitted_at=NOW()
                WHERE voucher_id=%s
            """, (_user(), voucher_id))
            conn.commit()
            return jsonify({'status':'ok','voucher_no':voucher_no})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 8. Cancel (admin only — reverses postings) ──────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/cancel', methods=['POST'])
    @_login_required
    def api_dsp_cancel(voucher_id):
        if not _is_admin():
            d = request.get_json(silent=True) or {}
            ok, msg = _verify_admin_unlock(d)
            if not ok:
                return jsonify({'status':'error','message':msg}), 403

        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            state = (v.get('state') or '').lower()
            if state in ('cancelled',):
                return jsonify({'status':'error',
                                'message':'Voucher is already cancelled.'}), 409
            if state in ('submitted','locked'):
                _reverse_consumption(conn, v)
            conn.execute("""
                UPDATE pm_dispatch_vouchers
                SET state='cancelled',
                    cancelled_by=%s,
                    cancelled_at=NOW()
                WHERE voucher_id=%s
            """, (_user(), voucher_id))
            conn.commit()
            return jsonify({'status':'ok'})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 9. Delete a draft voucher entirely ──────────────────────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>/delete_draft', methods=['POST'])
    @_login_required
    def api_dsp_delete_draft(voucher_id):
        """Hard-delete a never-submitted draft. Refuses if state != 'draft'."""
        conn = sampling_portal.get_db_connection()
        try:
            v = conn.execute("""
                SELECT state FROM pm_dispatch_vouchers WHERE voucher_id=%s
            """, (voucher_id,)).fetchone()
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404
            if (v['state'] or '').lower() != 'draft':
                return jsonify({'status':'error',
                                'message':'Only draft vouchers can be deleted. Use Cancel for submitted vouchers.'}), 409
            conn.execute("DELETE FROM pm_dispatch_vouchers WHERE voucher_id=%s", (voucher_id,))
            conn.commit()
            return jsonify({'status':'ok'})
        except Exception as e:
            try: conn.rollback()
            except Exception: pass
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 10. Get one voucher (detail / load for edit / print) ────────
    @bp.route('/api/pm_stock/dispatch/<int:voucher_id>', methods=['GET'])
    @_login_required
    def api_dsp_get(voucher_id):
        conn = sampling_portal.get_db_connection()
        try:
            v = _fetch_voucher(conn, voucher_id)
            if not v:
                return jsonify({'status':'error','message':'Voucher not found'}), 404

            # Also report editable/why-not for the UI
            ok, why = _can_edit(v, _user())
            v['editable'] = bool(ok)
            v['edit_block_reason'] = why if not ok else ''
            # Tell the UI whether admin-password unlock is the path to edit
            v['needs_admin_unlock'] = (not ok) and (
                'window' in (why or '').lower() or 'admin' in (why or '').lower()
            )
            return jsonify({'status':'ok','voucher':v})
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass

    # ── 11. List vouchers (for voucher log integration) ─────────────
    @bp.route('/api/pm_stock/dispatch/list', methods=['GET'])
    @_login_required
    def api_dsp_list():
        from_date = request.args.get('from_date') or '2000-01-01'
        to_date   = request.args.get('to_date')   or str(date.today())
        state     = (request.args.get('state') or '').strip().lower()
        q         = (request.args.get('q') or '').strip()

        conn = sampling_portal.get_db_connection()
        try:
            where = ["v.voucher_date BETWEEN %s AND %s"]
            params = [from_date, to_date]
            if state and state in ('draft','submitted','locked','cancelled'):
                where.append("v.state = %s"); params.append(state)
            if q:
                where.append("(v.voucher_no LIKE %s OR v.remarks LIKE %s OR v.created_by LIKE %s)")
                params += [f'%{q}%', f'%{q}%', f'%{q}%']
            rows = conn.execute(f"""
                SELECT v.voucher_id, v.voucher_no, v.voucher_date, v.state,
                       v.location_id, COALESCE(g.name,'') AS location_name,
                       v.created_by, v.created_at,
                       v.submitted_by, v.submitted_at,
                       v.remarks,
                       (SELECT COUNT(*) FROM pm_dispatch_lines l
                          WHERE l.voucher_id=v.voucher_id) AS line_count,
                       (SELECT COALESCE(SUM(c.qty),0) FROM pm_dispatch_consumption c
                          WHERE c.voucher_id=v.voucher_id) AS total_consumed_qty
                FROM pm_dispatch_vouchers v
                LEFT JOIN procurement_godowns g ON g.id = v.location_id
                WHERE {' AND '.join(where)}
                ORDER BY v.voucher_date DESC, v.voucher_id DESC
                LIMIT 500
            """, params).fetchall() or []
            out = []
            for r in rows:
                d = dict(r) if hasattr(r,'keys') else r
                for k in ('voucher_date','created_at','submitted_at'):
                    v = d.get(k)
                    if v is not None and not isinstance(v, str):
                        try: d[k] = v.isoformat()
                        except Exception: d[k] = str(v)
                d['line_count']         = int(d.get('line_count') or 0)
                d['total_consumed_qty'] = float(d.get('total_consumed_qty') or 0)
                out.append(d)
            return jsonify({'status':'ok','rows':out,'count':len(out)})
        except Exception as e:
            return jsonify({'status':'error','message':str(e)}), 500
        finally:
            try: conn.close()
            except Exception: pass
