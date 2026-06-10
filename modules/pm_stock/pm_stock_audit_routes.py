"""
pm_stock_audit_routes.py
─────────────────────────────────────────────────────────────────────────────
Physical Stock Check / Audit module — runs alongside pm_stock_routes.py.

Workflow (in plain English):
  1. A user (admin or non-admin) starts an audit session for a godown,
     picking the specific products they want to physically verify.
  2. One or more users scan boxes in that godown. Re-scanning a box does
     nothing (idempotent merge by box_code). Each scan records who scanned
     it and when. Multiple users CAN scan into the same open session.
  3. When scanning is done, a non-admin user can submit the session for
     settlement (status moves from 'open' to 'pending_settlement'). They
     CANNOT settle it themselves.
  4. An admin reviews the variance (per-product totals AND per-box missing
     /extra lists), then either:
       a. Settles: posts ledger adjustment txns + updates box lifecycle
          (missing boxes → 'lost'; extras → 'in_stock' at this godown).
       b. Rejects: marks the session 'rejected' with a note.

Tables (all created on import in audit_ensure_tables()):
  pm_audit_sessions     — one row per audit session
  pm_audit_products     — product_id × session (the scope chosen at start)
  pm_audit_scans        — one row per box-scan (UNIQUE on session+box_code)

URL prefix: /pm_stock  (mounted alongside pm_stock_bp)
"""

from flask import Blueprint, render_template, request, jsonify, session
from datetime import datetime, date
import sampling_portal

# Re-use auth/role helpers from the pm_stock package's helpers module so
# behaviour stays consistent (and home-godown lock for non-admins works
# identically to MTV/GRN/allotment).
from pm_stock.helpers import (
    _login_required, _user, _is_admin, _user_home_godown,
    _post_stock_movement, _get_godowns,
)

pm_audit_bp = Blueprint('pm_audit', __name__)


# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA BOOTSTRAP
# ─────────────────────────────────────────────────────────────────────────────
def audit_ensure_tables():
    """Create the audit tables (idempotent)."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    try:
        # Session header
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_audit_sessions (
                session_id      INT AUTO_INCREMENT PRIMARY KEY,
                session_no      VARCHAR(40) NOT NULL UNIQUE,
                godown_id       INT NOT NULL,
                status          ENUM('open','pending_settlement','settled','rejected')
                                NOT NULL DEFAULT 'open',
                created_by      VARCHAR(80) NOT NULL,
                created_at      DATETIME    DEFAULT CURRENT_TIMESTAMP,
                submitted_by    VARCHAR(80) DEFAULT NULL,
                submitted_at    DATETIME    DEFAULT NULL,
                settled_by      VARCHAR(80) DEFAULT NULL,
                settled_at      DATETIME    DEFAULT NULL,
                rejected_by     VARCHAR(80) DEFAULT NULL,
                rejected_at     DATETIME    DEFAULT NULL,
                note            VARCHAR(1000) DEFAULT NULL,
                settle_note     VARCHAR(1000) DEFAULT NULL,
                INDEX ix_pm_audit_godown_status (godown_id, status),
                INDEX ix_pm_audit_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # Product scope — which products this session is auditing.
        # NOT pre-populated with "everything in the godown"; the user
        # explicitly adds product IDs at start time.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_audit_products (
                id          INT AUTO_INCREMENT PRIMARY KEY,
                session_id  INT NOT NULL,
                product_id  INT NOT NULL,
                UNIQUE KEY uq_pm_audit_prod (session_id, product_id),
                INDEX ix_pm_audit_prod_s (session_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # Scans. UNIQUE on (session_id, box_code) makes re-scans no-ops.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_audit_scans (
                scan_id     INT AUTO_INCREMENT PRIMARY KEY,
                session_id  INT NOT NULL,
                box_code    VARCHAR(40) NOT NULL,
                box_id      INT          DEFAULT NULL,
                product_id  INT          DEFAULT NULL,
                qty         DECIMAL(14,3) DEFAULT 0,
                scanned_by  VARCHAR(80)  NOT NULL,
                scanned_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_pm_audit_scan (session_id, box_code),
                INDEX ix_pm_audit_scan_s (session_id),
                INDEX ix_pm_audit_scan_box (box_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # Box-state snapshot taken at settle-time. Populated for every box
        # we touch during settlement (missing boxes flipped to 'lost',
        # extras moved to this godown). Drives the admin reversal endpoint:
        # to undo the settlement we restore each row's prior_status +
        # prior_godown_id back onto pm_boxes. Without this snapshot the
        # original status/godown is lost (overwritten by the settle UPDATE).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pm_audit_box_snapshot (
                snap_id          INT AUTO_INCREMENT PRIMARY KEY,
                session_id       INT NOT NULL,
                box_id           INT NOT NULL,
                prior_status     VARCHAR(20)  DEFAULT NULL,
                prior_godown_id  INT          DEFAULT NULL,
                change_kind      ENUM('missing_to_lost','extra_to_instock') NOT NULL,
                snapshotted_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_pm_audit_snap (session_id, box_id),
                INDEX ix_pm_audit_snap_s (session_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)

        # Idempotent ALTERs for the reversal audit-trail columns. Older
        # installs without these columns just get them added.
        for _alter in (
            "ALTER TABLE pm_audit_sessions ADD COLUMN reversed_by VARCHAR(80) DEFAULT NULL",
            "ALTER TABLE pm_audit_sessions ADD COLUMN reversed_at DATETIME DEFAULT NULL",
            "ALTER TABLE pm_audit_sessions ADD COLUMN reverse_note VARCHAR(1000) DEFAULT NULL",
        ):
            try: conn.execute(_alter)
            except Exception: pass   # column already exists — harmless
        conn.commit()
    except Exception as _e:
        import sys
        print(f"[pm_stock_audit_routes] schema bootstrap failed: {_e}", file=sys.stderr)
    finally:
        try: conn.close()
        except Exception: pass


try:
    audit_ensure_tables()
except Exception as _e:
    import sys
    print(f"[pm_stock_audit_routes] audit_ensure_tables() failed at import: {_e}",
          file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _audit_next_session_no(conn, ref_date=None):
    """
    Generate a session number like 'AUD/26-27/0001'. Uses the same
    fiscal-year convention as MT vouchers but with its own counter row
    in pm_voucher_sequences. Falls back to scanning the table if the
    sequences row is missing.
    """
    import re as _re
    ref_date = ref_date or date.today()
    year = ref_date.year
    # Apr 1 → Mar 31 fiscal year
    if ref_date.month < 4:
        fy_start, fy_end = year - 1, year
    else:
        fy_start, fy_end = year, year + 1
    fy_label = f"{str(fy_start)[-2:]}-{str(fy_end)[-2:]}"

    # Use pm_voucher_sequences if available
    try:
        # Seed if missing
        conn.execute(
            """INSERT IGNORE INTO pm_voucher_sequences
                 (voucher_type, prefix, last_num, pad_digits, reset_yearly)
               VALUES ('PM-AUD','PMAU',0,4,1)"""
        )
        row = conn.execute(
            "SELECT last_num, pad_digits, last_year FROM pm_voucher_sequences WHERE voucher_type='PM-AUD'"
        ).fetchone()
        if row:
            last_num = int(row['last_num'] or 0)
            last_year = int(row['last_year'] or 0)
            pad = int(row['pad_digits'] or 4)
            if last_year != fy_start:
                last_num = 0
            nxt = last_num + 1
            conn.execute(
                "UPDATE pm_voucher_sequences SET last_num=%s, last_year=%s WHERE voucher_type='PM-AUD'",
                (nxt, fy_start)
            )
            return f"AUD/{fy_label}/{str(nxt).zfill(pad)}"
    except Exception:
        pass
    # Fallback: scan pm_audit_sessions
    try:
        last = conn.execute(
            "SELECT session_no FROM pm_audit_sessions WHERE session_no LIKE %s ORDER BY session_id DESC LIMIT 1",
            (f'AUD/{fy_label}/%',)
        ).fetchone()
        if last:
            nums = _re.findall(r'/(\d{3,})$', last['session_no'] or '')
            nxt  = (int(nums[-1]) + 1) if nums else 1
        else:
            nxt = 1
        return f"AUD/{fy_label}/{str(nxt).zfill(4)}"
    except Exception:
        return f"AUD/{fy_label}/0001"


def _audit_load_session(conn, sid):
    """Fetch a session row + product IDs + scan summary. Returns None if not found."""
    s = conn.execute(
        """SELECT s.*, g.name AS godown_name
           FROM pm_audit_sessions s
           LEFT JOIN procurement_godowns g ON g.id = s.godown_id
           WHERE s.session_id=%s""",
        (sid,)
    ).fetchone()
    if not s:
        return None
    s = dict(s)
    # Stringify datetimes for JSON
    for k in ('created_at','submitted_at','settled_at','rejected_at'):
        if s.get(k):
            s[k] = str(s[k])
    # Product scope
    prods = conn.execute(
        """SELECT ap.product_id, p.product_name, p.product_code, p.pm_type
           FROM pm_audit_products ap
           LEFT JOIN pm_products p ON p.id = ap.product_id
           WHERE ap.session_id=%s
           ORDER BY p.product_name""",
        (sid,)
    ).fetchall()
    s['products'] = [dict(r) for r in prods]
    return s


def _audit_compute_variance(conn, sid):
    """
    Compute per-product variance and per-box missing/extra lists for a session.

    Per-product: for each product in the session scope, compare
      expected (boxes currently in_stock at session godown for this product)
      vs scanned (audit scans of boxes whose product matches).

    Per-box missing: boxes the system says are in_stock at this godown for
      ANY scoped product but weren't scanned.

    Per-box extra: scanned box codes that are NOT in the "expected" set.
      Includes wrong-godown boxes, in_transit boxes, status='lost' boxes,
      or boxes of products NOT in the audit scope (operator scanned outside
      their stated scope — usually a process error worth surfacing).
    """
    s = conn.execute(
        "SELECT session_id, godown_id, status FROM pm_audit_sessions WHERE session_id=%s",
        (sid,)
    ).fetchone()
    if not s:
        return None

    godown_id = s['godown_id']
    prod_rows = conn.execute(
        "SELECT product_id FROM pm_audit_products WHERE session_id=%s", (sid,)
    ).fetchall()
    prod_ids = [r['product_id'] for r in prod_rows]
    if not prod_ids:
        return {'per_product': [], 'missing_boxes': [], 'extra_boxes': []}

    placeholders = ','.join(['%s'] * len(prod_ids))

    # ── Expected: boxes in_stock at this godown for scoped products ──
    expected = conn.execute(
        f"""SELECT b.box_id, b.box_code, b.short_code, b.product_id, b.per_box_qty,
                   p.product_name, p.product_code, p.pm_type
            FROM pm_boxes b
            JOIN pm_products p ON p.id = b.product_id
            WHERE b.current_godown_id = %s
              AND b.current_status   = 'in_stock'
              AND b.product_id IN ({placeholders})
            ORDER BY p.product_name, b.box_code""",
        (godown_id, *prod_ids)
    ).fetchall()
    # Key the expected map by the canonical box_id, NOT by box_code, so
    # that a scan stored under either the long box_code OR the short
    # short_code still matches as long as we can resolve it to the same
    # box_id. Also keep a code-keyed mirror for the few places that
    # still need to compare by code (e.g. legacy unknown-code scans
    # with NULL box_id).
    expected_by_id  = {r['box_id']: dict(r) for r in expected}
    expected_codes  = set()
    for r in expected:
        if r.get('box_code'):  expected_codes.add(r['box_code'])
        if r.get('short_code'): expected_codes.add(r['short_code'])

    # ── Scans for this session ──
    scans = conn.execute(
        """SELECT scan_id, box_code, box_id, product_id, qty, scanned_by, scanned_at
           FROM pm_audit_scans
           WHERE session_id=%s
           ORDER BY scanned_at""",
        (sid,)
    ).fetchall()
    scanned_codes    = {r['box_code'] for r in scans}
    scanned_box_ids  = {r['box_id'] for r in scans if r.get('box_id')}
    scans_by_code    = {r['box_code']: dict(r) for r in scans}

    # ── Missing: expected boxes whose box_id is NOT in scanned_box_ids
    # AND whose long/short codes are NOT in scanned_codes (covers the
    # rare case of a NULL box_id scan that happens to match by code).
    missing = []
    for bid, r in expected_by_id.items():
        if bid in scanned_box_ids:
            continue
        if r.get('box_code') in scanned_codes:
            continue
        if r.get('short_code') and r['short_code'] in scanned_codes:
            continue
        missing.append({
            'box_code':     r['box_code'],
            'box_id':       r['box_id'],
            'product_id':   r['product_id'],
            'product_name': r['product_name'],
            'product_code': r['product_code'],
            'pm_type':      r['pm_type'],
            'per_box_qty':  float(r['per_box_qty'] or 0),
        })

    # ── Extras: scanned boxes whose box_id is NOT in expected.
    # For scans with NULL box_id (unresolved at scan time) fall back to
    # the code-keyed expected set so codes that DO match expected stay
    # out of the extras bucket.
    extras = []
    for r in scans:
        sbid = r.get('box_id')
        code = r['box_code']
        if sbid and sbid in expected_by_id:
            continue
        if not sbid and code in expected_codes:
            continue
        # This box was scanned but isn't in the expected set. Look it up so
        # we can tell the admin what the system thinks of it.
        #
        # Matching against box_code OR short_code is important:
        #   • Operators scan with handheld scanners that read the QR
        #     containing the short_code (e.g. A0002734).
        #   • The scan endpoint tries to store the canonical long box_code,
        #     but for legacy scans (older releases of the scan endpoint
        #     that only looked up box_code), the stored value IS the short
        #     code as typed.
        # A single OR query handles both cases without needing a data
        # backfill.
        b = conn.execute(
            """SELECT b.box_id, b.box_code, b.short_code, b.product_id, b.per_box_qty,
                      b.current_status, b.current_godown_id,
                      p.product_name, p.product_code, p.pm_type,
                      g.name AS current_godown_name
               FROM pm_boxes b
               LEFT JOIN pm_products p          ON p.id = b.product_id
               LEFT JOIN procurement_godowns g  ON g.id = b.current_godown_id
               WHERE b.box_code = %s OR b.short_code = %s
               LIMIT 1""",
            (code, code)
        ).fetchone()
        if b:
            b = dict(b)
            in_scope = b['product_id'] in prod_ids
            extras.append({
                'box_code':            b['box_code'],
                'box_id':              b['box_id'],
                'product_id':          b['product_id'],
                'product_name':        b['product_name'],
                'product_code':        b['product_code'],
                'pm_type':             b['pm_type'],
                'per_box_qty':         float(b['per_box_qty'] or 0),
                'system_status':       b['current_status'],
                'system_godown_id':    b['current_godown_id'],
                'system_godown_name':  b['current_godown_name'],
                'reason': (
                    'wrong_godown' if b['current_godown_id'] != godown_id
                    else ('not_in_scope' if not in_scope
                          else ('not_in_stock' if b['current_status'] != 'in_stock'
                                else 'unknown'))
                ),
            })
        else:
            extras.append({
                'box_code':     code,
                'box_id':       None,
                'product_id':   None,
                'product_name': '(unknown box)',
                'product_code': '',
                'pm_type':      '',
                'per_box_qty':  0,
                'system_status': None,
                'system_godown_id': None,
                'system_godown_name': None,
                'reason': 'unknown_box',
            })

    # ── Per-product summary ──
    # expected counts/qty come from the expected set.
    # scanned counts/qty come from scans for in-scope products only.
    per_prod_expected = {pid: {'box': 0, 'qty': 0.0} for pid in prod_ids}
    for r in expected:
        d = per_prod_expected[r['product_id']]
        d['box'] += 1
        d['qty'] += float(r['per_box_qty'] or 0)

    per_prod_scanned = {pid: {'box': 0, 'qty': 0.0} for pid in prod_ids}
    for r in scans:
        if r['product_id'] in per_prod_scanned:
            d = per_prod_scanned[r['product_id']]
            d['box'] += 1
            d['qty'] += float(r['qty'] or 0)

    # Get product names for the summary
    name_rows = conn.execute(
        f"SELECT id, product_name, product_code, pm_type FROM pm_products WHERE id IN ({placeholders})",
        tuple(prod_ids)
    ).fetchall()
    name_map = {r['id']: dict(r) for r in name_rows}

    per_product = []
    for pid in prod_ids:
        exp = per_prod_expected[pid]
        scn = per_prod_scanned[pid]
        nm  = name_map.get(pid, {})
        per_product.append({
            'product_id':    pid,
            'product_name':  nm.get('product_name', '(unknown)'),
            'product_code':  nm.get('product_code', ''),
            'pm_type':       nm.get('pm_type', ''),
            'expected_box':  exp['box'],
            'expected_qty':  exp['qty'],
            'scanned_box':   scn['box'],
            'scanned_qty':   scn['qty'],
            'delta_box':     scn['box'] - exp['box'],
            'delta_qty':     scn['qty'] - exp['qty'],
        })

    # Sort: products with non-zero variance first, then alphabetical
    per_product.sort(key=lambda x: (abs(x['delta_qty']) == 0, x['product_name']))

    return {
        'per_product':   per_product,
        'missing_boxes': missing,
        'extra_boxes':   extras,
        'totals': {
            'products_in_scope':  len(prod_ids),
            'expected_box_total': sum(d['box'] for d in per_prod_expected.values()),
            'scanned_box_total':  sum(d['box'] for d in per_prod_scanned.values()),
            'missing_count':      len(missing),
            'extra_count':        len(extras),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# PAGE ROUTE
# ─────────────────────────────────────────────────────────────────────────────
@pm_audit_bp.route('/pm_stock/audit')
@_login_required
def page_audit():
    return render_template(
        'pm_stock/pm_stock_audit.html',
        user_name=session.get('User_Name'),
        role=session.get('User_Type'),
    )


# ─────────────────────────────────────────────────────────────────────────────
# API: session lifecycle
# ─────────────────────────────────────────────────────────────────────────────
@pm_audit_bp.route('/api/pm_stock/audit/start', methods=['POST'])
@_login_required
def api_audit_start():
    """
    Start a new audit session. Body: { godown_id, product_ids:[int...], note? }
    Returns: { status, session_id, session_no }

    Non-admin users are locked to their home godown if one is configured.
    A session must have at least one product_id in its scope.
    """
    d = request.get_json() or {}
    gid = d.get('godown_id')
    prod_ids = d.get('product_ids') or []
    note = (d.get('note') or '').strip()

    if not gid:
        return jsonify({'status':'error','message':'godown_id required'}), 400
    if not isinstance(prod_ids, list) or not prod_ids:
        return jsonify({'status':'error','message':'At least one product must be selected'}), 400
    try:
        gid = int(gid)
        prod_ids = [int(x) for x in prod_ids]
    except Exception:
        return jsonify({'status':'error','message':'godown_id and product_ids must be integers'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        # Non-admin: lock to home godown
        if not _is_admin():
            home = _user_home_godown(conn)
            if home is not None and int(home) != gid:
                gname = ''
                try:
                    r = conn.execute("SELECT name FROM procurement_godowns WHERE id=%s", (home,)).fetchone()
                    if r: gname = r['name']
                except Exception: pass
                conn.close()
                return jsonify({
                    'status':'error',
                    'message': f"Locked to your home location ({gname or '#'+str(home)})."
                }), 403

        session_no = _audit_next_session_no(conn)
        cur = conn.execute(
            """INSERT INTO pm_audit_sessions
                 (session_no, godown_id, status, created_by, note)
               VALUES (%s,%s,'open',%s,%s)""",
            (session_no, gid, _user(), note or None)
        )
        sid = cur.lastrowid

        for pid in prod_ids:
            conn.execute(
                "INSERT IGNORE INTO pm_audit_products (session_id, product_id) VALUES (%s,%s)",
                (sid, pid)
            )
        conn.commit()
        conn.close()
        return jsonify({'status':'ok','session_id':sid,'session_no':session_no})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/products/add', methods=['POST'])
@_login_required
def api_audit_add_products(sid):
    """Add more products to an existing OPEN session's scope. Body: { product_ids:[int...] }"""
    d = request.get_json() or {}
    pids = d.get('product_ids') or []
    if not pids:
        return jsonify({'status':'error','message':'product_ids required'}), 400
    try:
        pids = [int(x) for x in pids]
    except Exception:
        return jsonify({'status':'error','message':'product_ids must be integers'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute("SELECT status FROM pm_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'open':
            conn.close(); return jsonify({'status':'error','message':f"Session is {s['status']} — can't add products"}), 409
        for pid in pids:
            conn.execute("INSERT IGNORE INTO pm_audit_products (session_id, product_id) VALUES (%s,%s)", (sid, pid))
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/scan', methods=['POST'])
@_login_required
def api_audit_scan(sid):
    """
    Record a box scan. Body: { box_code }

    Behavior (mirrors the Inventory module's audit scanner):
      - Looks up the code against BOTH box_code AND short_code, so handheld
        scanners reading the QR (short code) work alongside typed long codes.
      - If the code matches a known box, the scan is recorded with the box's
        box_id/product_id/qty and the canonical long box_code.
      - If the code matches NO box, the scan is STILL recorded with box_id
        NULL — it surfaces as an "extra" in the variance report so the admin
        can review at settlement time. This is intentional: operators in the
        field scan what's physically there, not what we expect them to.
      - Duplicate detection is by box_id when known (so long vs short scan
        of the same box doesn't double count) and by box_code as a fallback
        for unknown codes.

    Returns: { status, duplicate, known_box, box: {...} }
    """
    d = request.get_json() or {}
    code = (d.get('box_code') or '').strip().upper()
    if not code:
        return jsonify({'status':'error','message':'box_code required'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute(
            "SELECT session_id, status FROM pm_audit_sessions WHERE session_id=%s",
            (sid,)
        ).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'open':
            conn.close(); return jsonify({'status':'error','message':f"Session is {s['status']} — scanning closed"}), 409

        # Resolve against short_code OR box_code.
        b = conn.execute(
            """SELECT b.box_id, b.box_code, b.short_code, b.product_id, b.per_box_qty,
                      b.current_godown_id, b.current_status,
                      p.product_name, p.product_code, p.pm_type
               FROM pm_boxes b
               LEFT JOIN pm_products p ON p.id = b.product_id
               WHERE b.box_code = %s OR b.short_code = %s
               LIMIT 1""",
            (code, code)
        ).fetchone()

        if b:
            box_id = int(b['box_id'])
            prod_id = b['product_id']
            qty = float(b['per_box_qty'] or 0)
            store_code = b['box_code'] or code   # canonical long code
            box_info = dict(b)
        else:
            # Unknown box — still record the scan. It'll show as an "extra"
            # in the variance / settlement report.
            box_id = None
            prod_id = None
            qty = 0.0
            store_code = code
            box_info = {'box_code': code}

        # Dedup. When we know the box, check by box_id (so long+short scans
        # of the same box don't double count). When unknown, fall back to
        # the literal code.
        if box_id is not None:
            existing = conn.execute(
                "SELECT scan_id FROM pm_audit_scans WHERE session_id=%s AND box_id=%s",
                (sid, box_id)
            ).fetchone()
        else:
            existing = conn.execute(
                "SELECT scan_id FROM pm_audit_scans WHERE session_id=%s AND box_code=%s AND box_id IS NULL",
                (sid, store_code)
            ).fetchone()

        if existing:
            conn.close()
            return jsonify({
                'status':'ok', 'duplicate':True, 'known_box': bool(b),
                'scan_id': existing['scan_id'],
                'box': box_info,
                'message':'Already scanned in this session'
            })

        conn.execute(
            """INSERT INTO pm_audit_scans
                 (session_id, box_code, box_id, product_id, qty, scanned_by)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (sid, store_code, box_id, prod_id, qty, _user())
        )
        conn.commit()
        conn.close()
        return jsonify({
            'status':'ok', 'duplicate':False, 'known_box': bool(b),
            'box': box_info,
        })
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/scan/<int:scan_id>', methods=['DELETE'])
@_login_required
def api_audit_unscan(sid, scan_id):
    """Undo a single scan. Only works while session is OPEN."""
    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute("SELECT status FROM pm_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'open':
            conn.close(); return jsonify({'status':'error','message':f"Session is {s['status']} — can't undo scans"}), 409
        conn.execute("DELETE FROM pm_audit_scans WHERE session_id=%s AND scan_id=%s", (sid, scan_id))
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/submit', methods=['POST'])
@_login_required
def api_audit_submit(sid):
    """
    Submit the session for settlement. Moves status open → pending_settlement.
    Non-admins use this to hand off to admin. Admins can use this too if
    they want to record a clear separation between "scanning" and "settling".
    """
    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute("SELECT status FROM pm_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'open':
            conn.close(); return jsonify({'status':'error','message':f"Session is already {s['status']}"}), 409
        conn.execute(
            """UPDATE pm_audit_sessions
               SET status='pending_settlement', submitted_by=%s, submitted_at=NOW()
               WHERE session_id=%s""",
            (_user(), sid)
        )
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/reopen', methods=['POST'])
@_login_required
def api_audit_reopen(sid):
    """Admin only — move pending_settlement back to open (e.g. after spotting a missed scan)."""
    if not _is_admin():
        return jsonify({'status':'error','message':'Admin only'}), 403
    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute("SELECT status FROM pm_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'pending_settlement':
            conn.close(); return jsonify({'status':'error','message':f"Session is {s['status']}, not pending_settlement"}), 409
        conn.execute(
            """UPDATE pm_audit_sessions
               SET status='open', submitted_by=NULL, submitted_at=NULL
               WHERE session_id=%s""",
            (sid,)
        )
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/settle', methods=['POST'])
@_login_required
def api_audit_settle(sid):
    """
    ADMIN ONLY. Settle the audit: post ledger adjustment txns + update box
    lifecycle. Body: { note? }

    Per-product ledger:
      - delta_qty > 0 (scanned more than expected) → post 'in' txn for +delta
      - delta_qty < 0 (scanned less than expected) → post 'out' txn for |delta|
      - delta_qty == 0 → skip

    Per-box lifecycle:
      - Missing boxes → status='lost' (cleared from current_godown_id)
      - Extra boxes  → status='in_stock', current_godown_id=session godown
        (only if the box exists in pm_boxes — unknown_box rows are
        skipped because we have nothing to update)

    All-or-nothing: any error rolls back and the session stays in
    pending_settlement.
    """
    if not _is_admin():
        return jsonify({'status':'error','message':'Admin only — non-admins must use Submit for Settlement'}), 403

    d = request.get_json() or {}
    note = (d.get('note') or '').strip()

    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute(
            "SELECT session_id, session_no, godown_id, status FROM pm_audit_sessions WHERE session_id=%s",
            (sid,)
        ).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] not in ('pending_settlement','open'):
            # Allow admin to settle from either state; non-admin can't settle at all
            conn.close()
            return jsonify({'status':'error','message':f"Session is {s['status']} — cannot settle"}), 409

        variance = _audit_compute_variance(conn, sid)
        if variance is None:
            conn.close(); return jsonify({'status':'error','message':'Could not compute variance'}), 500

        today = str(date.today())
        user  = _user()
        session_no = s['session_no']
        godown_id  = s['godown_id']

        # 1) Per-product ledger adjustments
        product_adjustments = 0
        for p in variance['per_product']:
            delta = float(p['delta_qty'] or 0)
            if abs(delta) < 0.0001:
                continue
            direction = 'in' if delta > 0 else 'out'
            _post_stock_movement(
                conn,
                product_id=p['product_id'],
                godown_id=godown_id,
                qty=abs(delta),
                direction=direction,
                transfer_no=session_no,
                transfer_id=None,
                txn_date=today,
                user=user,
            )
            product_adjustments += 1

        # 2) Missing boxes → 'lost'
        missing_updated = 0
        for mb in variance['missing_boxes']:
            if not mb.get('box_id'):
                continue
            # Snapshot the box's prior state BEFORE we change it. Drives
            # the admin reversal endpoint — without this we'd have no way
            # to know what status/godown to restore. ON DUPLICATE KEY
            # protects against re-running settle (the unique constraint
            # is (session_id, box_id)) so we don't blow away a snapshot
            # taken on a previous settle attempt.
            prior = conn.execute(
                "SELECT current_status, current_godown_id FROM pm_boxes WHERE box_id=%s",
                (mb['box_id'],)
            ).fetchone()
            if prior:
                conn.execute(
                    """INSERT INTO pm_audit_box_snapshot
                         (session_id, box_id, prior_status, prior_godown_id, change_kind)
                       VALUES (%s,%s,%s,%s,'missing_to_lost')
                       ON DUPLICATE KEY UPDATE
                         prior_status=VALUES(prior_status),
                         prior_godown_id=VALUES(prior_godown_id),
                         change_kind=VALUES(change_kind)""",
                    (sid, mb['box_id'],
                     prior.get('current_status'),
                     prior.get('current_godown_id'))
                )
            conn.execute(
                "UPDATE pm_boxes SET current_status='lost' WHERE box_id=%s",
                (mb['box_id'],)
            )
            conn.execute(
                """INSERT INTO pm_box_movements
                     (box_id, movement_type, from_godown_id, qty, moved_by, remarks)
                   VALUES (%s,'adjust',%s,%s,%s,%s)""",
                (mb['box_id'], godown_id, float(mb.get('per_box_qty') or 0), user,
                 f"Audit {session_no}: missing → lost")
            )
            missing_updated += 1

        # 3) Extras → in_stock at this godown
        extras_updated = 0
        for eb in variance['extra_boxes']:
            if not eb.get('box_id'):
                continue
            # Snapshot prior state (same rationale as missing-boxes above).
            prior = conn.execute(
                "SELECT current_status, current_godown_id FROM pm_boxes WHERE box_id=%s",
                (eb['box_id'],)
            ).fetchone()
            if prior:
                conn.execute(
                    """INSERT INTO pm_audit_box_snapshot
                         (session_id, box_id, prior_status, prior_godown_id, change_kind)
                       VALUES (%s,%s,%s,%s,'extra_to_instock')
                       ON DUPLICATE KEY UPDATE
                         prior_status=VALUES(prior_status),
                         prior_godown_id=VALUES(prior_godown_id),
                         change_kind=VALUES(change_kind)""",
                    (sid, eb['box_id'],
                     prior.get('current_status'),
                     prior.get('current_godown_id'))
                )
            conn.execute(
                "UPDATE pm_boxes SET current_status='in_stock', current_godown_id=%s WHERE box_id=%s",
                (godown_id, eb['box_id'])
            )
            conn.execute(
                """INSERT INTO pm_box_movements
                     (box_id, movement_type, to_godown_id, qty, moved_by, remarks)
                   VALUES (%s,'adjust',%s,%s,%s,%s)""",
                (eb['box_id'], godown_id, float(eb.get('per_box_qty') or 0), user,
                 f"Audit {session_no}: extra (was {eb.get('reason')}) → in_stock here")
            )
            extras_updated += 1

        # 4) Mark settled
        conn.execute(
            """UPDATE pm_audit_sessions
               SET status='settled', settled_by=%s, settled_at=NOW(), settle_note=%s
               WHERE session_id=%s""",
            (user, note or None, sid)
        )
        conn.commit()
        conn.close()
        return jsonify({
            'status':'ok',
            'product_adjustments': product_adjustments,
            'missing_boxes_lost':  missing_updated,
            'extra_boxes_moved':   extras_updated,
        })
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>/reject', methods=['POST'])
@_login_required
def api_audit_reject(sid):
    """Admin only. Reject the session with a note (no ledger/box changes)."""
    if not _is_admin():
        return jsonify({'status':'error','message':'Admin only'}), 403
    d = request.get_json() or {}
    note = (d.get('note') or '').strip()
    if not note:
        return jsonify({'status':'error','message':'Rejection note is required'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute("SELECT status FROM pm_audit_sessions WHERE session_id=%s", (sid,)).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] not in ('pending_settlement','open'):
            conn.close(); return jsonify({'status':'error','message':f"Session is {s['status']} — cannot reject"}), 409
        conn.execute(
            """UPDATE pm_audit_sessions
               SET status='rejected', rejected_by=%s, rejected_at=NOW(), settle_note=%s
               WHERE session_id=%s""",
            (_user(), note, sid)
        )
        conn.commit()
        conn.close()
        return jsonify({'status':'ok'})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/session/<int:sid>/reverse', methods=['POST'])
@_login_required
def api_audit_session_reverse(sid):
    """
    ADMIN ONLY. Reverse a previously-settled session. Body: { note? }

    Rolls back the three side-effects of api_audit_settle:
      1. Per-product ledger txns posted with voucher_no=session_no
         (in pm_godown_txn AND pm_floor_txn) are deleted.
      2. Per-box current_status / current_godown_id is restored from
         pm_audit_box_snapshot rows captured at settle-time.
      3. pm_box_movements rows tagged "Audit {session_no}:" are deleted
         AND a new 'adjust' row is inserted for each restored box noting
         the reversal (so the audit trail still shows what happened).

    The session itself moves back to 'pending_settlement' with the
    settled_by/settled_at fields cleared. reversed_by, reversed_at,
    reverse_note record who/when/why. The scans remain untouched so the
    admin can review and re-settle if desired.

    Idempotent failure: if any step raises, the whole reversal rolls
    back and the session stays 'settled'.
    """
    if not _is_admin():
        return jsonify({'status':'error','message':'Admin only'}), 403

    d = request.get_json() or {}
    note = (d.get('note') or '').strip()

    conn = sampling_portal.get_db_connection()
    try:
        s = conn.execute(
            """SELECT session_id, session_no, godown_id, status, settled_at
               FROM pm_audit_sessions WHERE session_id=%s""",
            (sid,)
        ).fetchone()
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        if s['status'] != 'settled':
            conn.close()
            return jsonify({
                'status':'error',
                'message': f"Session is {s['status']} — only settled sessions can be reversed."
            }), 409

        session_no = s['session_no']
        godown_id  = s['godown_id']
        user       = _user()

        # 1) Delete per-product ledger txns posted by this settlement.
        # The settle endpoint posts with voucher_no = session_no and
        # remarks tagged "[PM-MT:{session_no}]". Both columns identify
        # the same set of rows; matching on voucher_no is enough.
        gd_res = conn.execute(
            "DELETE FROM pm_godown_txn WHERE voucher_no=%s",
            (session_no,)
        )
        fl_res = conn.execute(
            "DELETE FROM pm_floor_txn WHERE voucher_no=%s",
            (session_no,)
        )
        ledger_rows_deleted = (gd_res.rowcount or 0) + (fl_res.rowcount or 0)

        # 2) Restore boxes from snapshots taken at settle time.
        snaps = conn.execute(
            """SELECT box_id, prior_status, prior_godown_id, change_kind
               FROM pm_audit_box_snapshot
               WHERE session_id=%s""",
            (sid,)
        ).fetchall() or []

        # LEGACY FALLBACK: snapshots were introduced after this build —
        # sessions settled before then have no rows in pm_audit_box_snapshot.
        # For those, reconstruct (box_id, prior_status, prior_godown_id)
        # from the pm_box_movements rows the original settle wrote.
        #
        # Reconstruction strategy:
        #   • missing→lost rows have remarks "Audit {N}: missing → lost"
        #     and a from_godown_id (= the audit's godown). Prior status:
        #     'in_stock'. Prior godown: from_godown_id (i.e. where the
        #     box was before settle moved it to 'lost').
        #   • extra→in_stock rows have remarks
        #     "Audit {N}: extra (was X) → in_stock here" with a
        #     to_godown_id. Prior status: parsed from "(was X)". Prior
        #     godown: the most recent godown the box was at BEFORE this
        #     audit movement — best-effort from earlier pm_box_movements.
        if not snaps:
            legacy = conn.execute(
                """SELECT box_id, from_godown_id, to_godown_id, remarks, movement_at
                   FROM pm_box_movements
                   WHERE remarks LIKE %s
                   ORDER BY movement_id""",
                (f"Audit {session_no}:%",)
            ).fetchall() or []

            import re as _re
            for row in legacy:
                bid = int(row['box_id'])
                rem = row.get('remarks') or ''
                if 'missing → lost' in rem:
                    # Box was at this godown in_stock; settle marked it lost.
                    snaps.append({
                        'box_id':          bid,
                        'prior_status':    'in_stock',
                        'prior_godown_id': row.get('from_godown_id'),
                        'change_kind':     'missing_to_lost',
                    })
                elif 'extra' in rem and 'in_stock here' in rem:
                    # Extract the "(was X)" reason. Common values that
                    # could appear here: 'lost', 'in_stock' (wrong-godown),
                    # 'unknown_box' etc. Default to 'lost' if we can't parse.
                    m = _re.search(r'\(was ([^)]+)\)', rem)
                    was_reason = (m.group(1).strip() if m else 'lost')
                    # Try to find the previous godown from an earlier
                    # movement on this box.
                    prev = conn.execute(
                        """SELECT to_godown_id, from_godown_id
                           FROM pm_box_movements
                           WHERE box_id = %s
                             AND movement_at < %s
                           ORDER BY movement_at DESC, movement_id DESC
                           LIMIT 1""",
                        (bid, row['movement_at'])
                    ).fetchone()
                    prev_godown = None
                    if prev:
                        prev_godown = prev.get('to_godown_id') or prev.get('from_godown_id')
                    # If there's no earlier movement (newly-created box
                    # with no transfer history) leave prev_godown NULL;
                    # the restore step writes NULL to current_godown_id
                    # which matches the original "no godown assigned"
                    # state (typical for 'lost'/'consumed' statuses).
                    # Map reason strings → status.
                    # 'lost'/'damaged'/etc. translate directly; anything
                    # unrecognised gets 'lost' as the safest pre-extra
                    # status to restore.
                    status_map = {
                        'in_stock':   'in_stock',
                        'in_transit': 'in_transit',
                        'lost':       'lost',
                        'damaged':    'damaged',
                        'consumed':   'consumed',
                    }
                    snaps.append({
                        'box_id':          bid,
                        'prior_status':    status_map.get(was_reason.lower(), 'lost'),
                        'prior_godown_id': prev_godown,
                        'change_kind':     'extra_to_instock',
                    })

        boxes_restored = 0
        for snap in snaps:
            bid = int(snap['box_id'])
            prior_status = snap.get('prior_status')
            prior_godown = snap.get('prior_godown_id')

            # Restore. Both columns are written together so partial drift
            # doesn't leave a box in an inconsistent state.
            conn.execute(
                """UPDATE pm_boxes
                   SET current_status = %s,
                       current_godown_id = %s
                   WHERE box_id = %s""",
                (prior_status, prior_godown, bid)
            )

            # Insert a reversal movement row so pm_box_movements shows
            # what happened, in addition to the original 'Audit X:' rows
            # which we delete below.
            kind = snap.get('change_kind') or ''
            conn.execute(
                """INSERT INTO pm_box_movements
                     (box_id, movement_type, from_godown_id, to_godown_id,
                      qty, moved_by, remarks)
                   VALUES (%s,'adjust',%s,%s,0,%s,%s)""",
                (bid, godown_id, prior_godown, user,
                 f"REVERSAL of Audit {session_no} ({kind}): restored prior state")
            )
            boxes_restored += 1

        # 3) Delete the original audit-tagged pm_box_movements rows. We
        # match by the literal "Audit {session_no}:" prefix our settle
        # code writes. Reversal movement rows we just inserted above
        # start with "REVERSAL" so they won't match this LIKE pattern.
        mv_res = conn.execute(
            "DELETE FROM pm_box_movements WHERE remarks LIKE %s",
            (f"Audit {session_no}:%",)
        )
        movements_deleted = mv_res.rowcount or 0

        # 4) Clean up the snapshots themselves — they've served their
        # purpose. If admin re-settles later, fresh snapshots will be
        # written then.
        conn.execute(
            "DELETE FROM pm_audit_box_snapshot WHERE session_id=%s",
            (sid,)
        )

        # 5) Flip session status. Back to pending_settlement so the
        # admin can review the variance and re-settle if desired.
        conn.execute(
            """UPDATE pm_audit_sessions
               SET status='pending_settlement',
                   settled_by=NULL,
                   settled_at=NULL,
                   reversed_by=%s,
                   reversed_at=NOW(),
                   reverse_note=%s
               WHERE session_id=%s""",
            (user, note or None, sid)
        )
        conn.commit()
        conn.close()
        return jsonify({
            'status': 'ok',
            'ledger_rows_deleted':  ledger_rows_deleted,
            'boxes_restored':       boxes_restored,
            'movements_deleted':    movements_deleted,
        })
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# API: read endpoints
# ─────────────────────────────────────────────────────────────────────────────
@pm_audit_bp.route('/api/pm_stock/audit/list', methods=['GET'])
@_login_required
def api_audit_list():
    """List audit sessions. Query: status?, godown_id?, limit? (default 50)."""
    status_q = request.args.get('status') or ''
    godown_q = request.args.get('godown_id') or ''
    try:
        limit = min(int(request.args.get('limit') or 50), 200)
    except Exception:
        limit = 50

    where = []
    params = []
    if status_q:
        statuses = [x.strip() for x in status_q.split(',') if x.strip()]
        if statuses:
            placeholders = ','.join(['%s'] * len(statuses))
            where.append(f"s.status IN ({placeholders})")
            params.extend(statuses)
    if godown_q:
        try:
            where.append("s.godown_id=%s"); params.append(int(godown_q))
        except Exception: pass
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute(
            f"""SELECT s.session_id, s.session_no, s.godown_id, s.status,
                       s.created_by, s.created_at, s.submitted_by, s.submitted_at,
                       s.settled_by, s.settled_at, s.note,
                       g.name AS godown_name,
                       (SELECT COUNT(*) FROM pm_audit_products ap WHERE ap.session_id=s.session_id) AS product_count,
                       (SELECT COUNT(*) FROM pm_audit_scans     as_ WHERE as_.session_id=s.session_id) AS scan_count
                FROM pm_audit_sessions s
                LEFT JOIN procurement_godowns g ON g.id = s.godown_id
                {where_sql}
                ORDER BY s.created_at DESC
                LIMIT {int(limit)}""",
            tuple(params)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            for k in ('created_at','submitted_at','settled_at'):
                if d.get(k): d[k] = str(d[k])
            out.append(d)
        conn.close()
        return jsonify({'status':'ok','sessions':out})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/<int:sid>', methods=['GET'])
@_login_required
def api_audit_get(sid):
    """
    Full session detail: header + products + scans + variance.
    Variance is computed live so even on un-settled sessions admins/users
    can see real-time progress.
    """
    conn = sampling_portal.get_db_connection()
    try:
        s = _audit_load_session(conn, sid)
        if not s:
            conn.close(); return jsonify({'status':'error','message':'Session not found'}), 404
        scans = conn.execute(
            """SELECT s.scan_id, s.box_code, s.product_id, s.qty, s.scanned_by, s.scanned_at,
                      p.product_name, p.product_code, p.pm_type
               FROM pm_audit_scans s
               LEFT JOIN pm_products p ON p.id = s.product_id
               WHERE s.session_id=%s
               ORDER BY s.scanned_at DESC""",
            (sid,)
        ).fetchall()
        scans_out = []
        for r in scans:
            d = dict(r)
            if d.get('scanned_at'): d['scanned_at'] = str(d['scanned_at'])
            scans_out.append(d)
        variance = _audit_compute_variance(conn, sid)
        conn.close()
        return jsonify({
            'status':'ok',
            'session': s,
            'scans':   scans_out,
            'variance': variance,
            'is_admin': _is_admin(),
        })
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/products/search', methods=['GET'])
@_login_required
def api_audit_product_search():
    """
    Product search for the start-session product picker. Query: q? (substring),
    godown_id (preferred — only returns products with positive stock in that
    godown if godown_id is supplied), limit? (default 30).
    """
    q = (request.args.get('q') or '').strip()
    godown_q = request.args.get('godown_id') or ''
    try:
        limit = min(int(request.args.get('limit') or 30), 100)
    except Exception:
        limit = 30

    conn = sampling_portal.get_db_connection()
    try:
        params = []
        where = ["p.is_active=1"]
        if q:
            where.append("(p.product_name LIKE %s OR p.product_code LIKE %s)")
            qq = f'%{q}%'; params += [qq, qq]
        sql_filter = " AND ".join(where)

        if godown_q:
            try:
                gid = int(godown_q)
                # Only products that have at least one in_stock box at this godown
                rows = conn.execute(
                    f"""SELECT DISTINCT p.id AS product_id, p.product_name,
                              p.product_code, p.pm_type
                       FROM pm_products p
                       JOIN pm_boxes b
                         ON b.product_id = p.id
                        AND b.current_godown_id = %s
                        AND b.current_status = 'in_stock'
                       WHERE {sql_filter}
                       ORDER BY p.product_name
                       LIMIT {int(limit)}""",
                    (gid, *params)
                ).fetchall()
            except Exception:
                rows = []
        else:
            rows = conn.execute(
                f"""SELECT p.id AS product_id, p.product_name, p.product_code, p.pm_type
                    FROM pm_products p
                    WHERE {sql_filter}
                    ORDER BY p.product_name
                    LIMIT {int(limit)}""",
                tuple(params)
            ).fetchall()
        conn.close()
        return jsonify({'status':'ok','products':[dict(r) for r in rows]})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500


@pm_audit_bp.route('/api/pm_stock/audit/godowns', methods=['GET'])
@_login_required
def api_audit_godowns():
    """
    List godowns + floors for the picker. Delegates to _get_godowns which
    already knows the actual procurement_godowns schema quirks on this
    installation (no is_active column; column is named 'type' aliased to
    'godown_type'; has an ultra-safe fallback if the schema differs).
    """
    conn = sampling_portal.get_db_connection()
    try:
        gdwns = _get_godowns(conn)
        conn.close()
        # Slim the response — only the fields the picker uses
        slim = [{'id': g['id'], 'name': g['name'], 'godown_type': g.get('godown_type','godown')}
                for g in gdwns]
        return jsonify({'status':'ok','godowns': slim})
    except Exception as e:
        try: conn.close()
        except Exception: pass
        return jsonify({'status':'error','message':str(e)}), 500
